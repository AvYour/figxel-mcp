// Read-side helpers: traversal, pagination, and the normalized node DTO.
//
// Two constraints shape everything here (spec §5.4, claims C-020/C-021):
//
//  1. The manifest uses `documentAccess: "dynamic-page"`, so nodes outside the
//     active page are NOT synchronously reachable. `figma.getNodeById` returns
//     null for them and the async equivalents must be used. Every lookup here
//     goes through the async path.
//  2. A read of a large document must never be rejected and never freeze the
//     editor. So every scan is bounded by `limit`, carries a `nextCursor`, and
//     yields to the host through the same `yieldToHost` the write path uses.
//
// Pagination is exposed rather than hidden: a truncated result says so and hands
// back a cursor, because silently returning the first N nodes is how an agent
// ends up believing it has seen a whole document.
//
// No Node APIs here, and no browser encoders either. Measured on the sandbox
// (spikes/results/probe.json, the global list): `atob` and `btoa` exist;
// `Buffer`, `TextEncoder` and `TextDecoder` do NOT. So base64 goes through
// `btoa`/`atob` and nothing here imports a global the sandbox lacks — a
// `Buffer.from` would compile and then fail at runtime inside Figma.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { OPAQUE_TYPES, childrenOf, guardAll, opaqueBox, previewOf, readView } from "./board-read.js";
import { screenSizing } from "./context.js";
import type { YieldToHost } from "./chunk.js";
import { overflowText } from "./dialect.js";
import { ensureLoaded, notReachable } from "./pages.js";

/** The subset of the Figma node API this module touches — kept small so tests can fake it. */
export interface NodeLike {
  id: string;
  name: string;
  type: string;
  children?: readonly NodeLike[] | undefined;
  parent?: NodeLike | null | undefined;
}

export interface FigmaLike {
  currentPage: NodeLike;
  root: { name: string; children?: readonly NodeLike[] | undefined };
  getNodeByIdAsync(id: string): Promise<NodeLike | null>;
  getStyleByIdAsync?(id: string): Promise<unknown>;
  [key: string]: unknown;
}

export interface ReadContext {
  /** The plugin's op context, narrowed to what reads need. */
  params: Record<string, unknown>;
  yieldToHost: YieldToHost;
  progress(done: number, total?: number, phase?: string): void;
  isCancelled(): boolean;
}

// ── parameter parsing ────────────────────────────────────────────────────────

export function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function reqStr(params: Record<string, unknown>, key: string): string {
  const v = str(params, key);
  if (v === undefined) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` is required.`);
  }
  return v;
}

export function strList(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return out.length ? out : undefined;
}

/** Integer with a floor, so a caller cannot ask for a million nodes by accident. */
export function int(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = params[key];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function bool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === "boolean" ? v : fallback;
}

// ── cursors ──────────────────────────────────────────────────────────────────
// A cursor is opaque, self-describing base64 of "scope|offset". `scope` is what
// makes it safe: a cursor from one query is REJECTED by another instead of
// silently continuing at a wrong offset.
//
// The scope is percent-escaped BEFORE base64. Without that, a scope containing
// "|" would let a forged cursor move the boundary and change the offset it
// claims to carry. Escaping first means the last "|" in the decoded string is
// always the real separator.

const toB64Url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64Url = (s: string): string =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

export function encodeCursor(scope: string, offset: number): string {
  return toB64Url(`${encodeURIComponent(scope)}|${offset}`);
}

export function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  let raw: string;
  try {
    raw = decodeURIComponent(fromB64Url(cursor));
  } catch {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`cursor` is not a valid cursor for this query.");
  }
  const at = raw.lastIndexOf("|");
  const scopePart = at >= 0 ? raw.slice(0, at) : "";
  const n = Number(raw.slice(at + 1));
  if (scopePart !== scope || !Number.isInteger(n) || n < 0) {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      "`cursor` does not belong to this query. Restart the scan without `cursor`.",
    );
  }
  return n;
}

// ── traversal ────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Depth to descend. 0 = the node itself only; undefined = unbounded. */
  maxDepth?: number | undefined;
  /** How many nodes between two looks at the clock. Default 200. */
  yieldEvery?: number | undefined;
  /** Time a slice may spend before the host gets a turn; default 12 ms (spec §5.5). */
  budgetMs?: number | undefined;
  now?: (() => number) | undefined;
}

/**
 * Depth-first walk of a subtree that gives the host a turn once a slice has
 * spent its time budget. The visitor returns `false` to stop.
 *
 * By time, not by node count: a walk is cheap (5,468 nodes in 85 ms, measured)
 * and a yield is not — about one frame in front, and about a second when the
 * Figma window is in the background, where chained timers are throttled
 * [C-124]. Yielding every 200 nodes cost 27 of those seconds on a 5,000-node
 * page and never reported progress, so the bridge declared the scan STALLED and
 * every call queued behind it stalled too. Each yield now reports progress,
 * which is what keeps a slow-but-live read from being called stalled.
 *
 * Iterative, not recursive: a deep Figma page can nest far enough that a
 * recursive walk overflows the sandbox stack, and a stack overflow inside the
 * editor is not catchable in any useful way.
 */
export async function walk(
  root: NodeLike,
  visit: (node: NodeLike, depth: number) => boolean | void,
  ctx: { yieldToHost: YieldToHost; isCancelled(): boolean; progress?(done: number, total?: number, phase?: string): void },
  opts: ScanOptions = {},
): Promise<void> {
  const maxDepth = opts.maxDepth;
  const checkEvery = opts.yieldEvery ?? 200;
  const budget = opts.budgetMs ?? 12;
  const now = opts.now ?? Date.now;
  const stack: Array<{ node: NodeLike; depth: number }> = [{ node: root, depth: 0 }];
  let seen = 0;
  let sliceStart = now();

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (visit(node, depth) === false) return;

    if (++seen % checkEvery === 0 && now() - sliceStart >= budget) {
      if (ctx.isCancelled()) {
        throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while scanning the document.");
      }
      ctx.progress?.(seen, undefined, "scanning");
      await ctx.yieldToHost();
      sliceStart = now();
    }

    if (maxDepth !== undefined && depth >= maxDepth) continue;
    // A TABLE has no children, and outside Design asking may throw [C-135] [C-145].
    const kids = childrenOf(node);
    if (!kids) continue;
    // Reverse so the walk pops them in document order.
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, depth: depth + 1 });
  }
}

/**
 * Collect up to `limit` nodes matching a predicate, starting at `offset`, from a
 * subtree. Returns the page of matches plus whether more remain.
 */
export async function collect(
  root: NodeLike,
  pred: (node: NodeLike, depth: number) => boolean,
  limit: number,
  offset: number,
  ctx: { yieldToHost: YieldToHost; isCancelled(): boolean; progress(done: number, total?: number, phase?: string): void },
  opts: ScanOptions = {},
): Promise<{ items: NodeLike[]; more: boolean }> {
  const items: NodeLike[] = [];
  let index = 0;
  let more = false;

  await walk(
    root,
    (node, depth) => {
      if (!pred(node, depth)) return;
      if (index++ < offset) return;
      if (items.length >= limit) {
        more = true;
        return false; // stop at the first node past the page
      }
      items.push(node);
    },
    ctx,
    { ...opts, yieldEvery: opts.yieldEvery ?? 200 },
  );

  return { items, more };
}

// ── node DTO ─────────────────────────────────────────────────────────────────

export interface NodeDto {
  id: string;
  name: string;
  type: string;
  /** Present only when the read asked for it. Kept out by default: it is bulky. */
  children?: NodeDto[];
  childCount?: number;
  /**
   * Layout and style, present only when `includeGeometry` asked for it.
   *
   * Measured against the live plugin: this used to be a parameter that was
   * echoed back (`includeGeometry: true`) while no field was ever populated, so
   * an agent could WRITE auto-layout, padding and corner radius and then had no
   * way to READ them back to check its own work. A parameter that promises data
   * and returns nothing is worse than no parameter: it reads as verified.
   *
   * Only the fields that make the write tools' effects checkable are included —
   * layout, size, position, padding, radius, and the fill colour in hex.
   */
  layoutMode?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  itemSpacing?: number;
  cornerRadius?: number;
  fill?: string;
  sizing?: { horizontal: string; vertical: string };
  visible?: boolean;
  locked?: boolean;
  rotation?: number;
  opacity?: number;
  /** Prototype scrolling, when the frame scrolls at all [C-117]. */
  overflow?: string;
  /** How many of the top-most children stay fixed while the rest scroll [C-117]. */
  fixedChildren?: number;
  // FigJam and Slides types only (board-read.ts previewOf), with or without
  // includeGeometry — for a sticky its text is what it is. A Design DTO never
  // carries them.
  /** A sticky's, a shape's or a code block's text, cut at 200 characters (`textLength` when cut). */
  text?: string;
  textLength?: number;
  shapeType?: string;
  language?: string;
  connector?: { from: string; to: string; label?: string };
  table?: { rows: number; columns: number };
  link?: string;
  sectionContentsHidden?: true;
  slide?: { row?: number; col?: number; index?: number; skipped: boolean };
  /** SLIDE_GRID / SLIDE_ROW / INTERACTIVE_SLIDE_ELEMENT: nothing beyond the box can be read [C-136]. */
  opaque?: true;
  interactiveType?: string;
}

/** The subset of a node this file reads, without pulling in the full typings. */
interface StyledNode extends NodeLike {
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  cornerRadius?: number | symbol;
  topLeftRadius?: number | symbol;
  topRightRadius?: number | symbol;
  bottomLeftRadius?: number | symbol;
  bottomRightRadius?: number | symbol;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  opacity?: number;
  rotation?: number;
  visible?: boolean;
  locked?: boolean;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  fills?: unknown;
  overflowDirection?: string;
  numberOfFixedChildren?: number;
}

/**
 * A fill colour as a hex string, or undefined when it is not a solid fill.
 *
 * Gradients and image fills are deliberately not converted here: a lossy hex
 * would claim the fill was read when only part of it was.
 */
export function solidFillHex(node: StyledNode): string | undefined {
  const fills = node.fills;
  if (!Array.isArray(fills) || fills.length === 0) return undefined;
  const first = fills[0] as { type?: string; visible?: boolean; color?: { r: number; g: number; b: number } };
  if (!first || first.type !== "SOLID" || first.visible === false || !first.color) return undefined;
  const { r, g, b } = first.color;
  const hex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** `figma.mixed` is a symbol; a mixed value must not be reported as a number. */
function numericOrMixed(value: number | symbol | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A single corner radius, or undefined when the corners genuinely differ.
 *
 * `cornerRadius` is `number | figma.mixed`. When it is mixed, reporting any one
 * corner would claim a uniform radius that is not there — so the four corners
 * are compared, and a value is reported only when they agree. Per-corner radii
 * that differ are a legitimate state the write tools can produce, and the honest
 * answer to "what is the radius" is then "not one value".
 */
function uniformRadius(n: StyledNode): number | undefined {
  const single = numericOrMixed(n.cornerRadius);
  if (single !== undefined) return single;
  if (n.cornerRadius === undefined && n.topLeftRadius === undefined) return undefined;
  const corners = [n.topLeftRadius, n.topRightRadius, n.bottomLeftRadius, n.bottomRightRadius].map(numericOrMixed);
  if (corners.some((c) => c === undefined)) return undefined;
  const [first, ...rest] = corners as number[];
  return rest.every((c) => c === first) ? first : undefined;
}

/**
 * `guard`: read every member through board-read.ts's view, because outside
 * Figma Design a missing one may throw [C-145]. Computed once per call and
 * passed down; FigJam and Slides types are read through it in any editor.
 */
export function toDto(node: NodeLike, depth: number, maxChildren = 50, includeGeometry = false, guard = guardAll()): NodeDto {
  const dto: NodeDto = { id: node.id, name: node.name, type: node.type };
  const kids = childrenOf(node);
  if (kids && kids.length > 0) {
    dto.childCount = kids.length;
    if (depth > 0) {
      dto.children = kids.slice(0, maxChildren).map((c) => toDto(c, depth - 1, maxChildren, includeGeometry, guard));
    }
  }

  // SLIDE_GRID / SLIDE_ROW / INTERACTIVE_SLIDE_ELEMENT: reading fills or
  // layout on them throws [C-136], so nothing but the box is read.
  if (OPAQUE_TYPES.has(node.type)) {
    dto.opaque = true;
    Object.assign(dto, previewOf(node));
    if (includeGeometry) Object.assign(dto, opaqueBox(node));
    return dto;
  }
  const view = readView(node, guard);
  if (view !== (node as unknown)) Object.assign(dto, previewOf(node));

  if (includeGeometry) {
    const n = view as unknown as StyledNode;
    if (typeof n.layoutMode === "string" && n.layoutMode !== "NONE") dto.layoutMode = n.layoutMode;
    if (typeof n.width === "number") dto.width = n.width;
    if (typeof n.height === "number") dto.height = n.height;
    if (typeof n.x === "number") dto.x = n.x;
    if (typeof n.y === "number") dto.y = n.y;
    if (n.layoutMode && n.layoutMode !== "NONE") {
      if (typeof n.itemSpacing === "number") dto.itemSpacing = n.itemSpacing;
      dto.padding = {
        top: numericOrMixed(n.paddingTop) ?? 0,
        right: numericOrMixed(n.paddingRight) ?? 0,
        bottom: numericOrMixed(n.paddingBottom) ?? 0,
        left: numericOrMixed(n.paddingLeft) ?? 0,
      };
      // Screen axes, as Figma's panel shows them. primary/counter are axes of the
      // LAYOUT, so primary → horizontal was only right for rows — a vertical stack
      // reported its width and height swapped.
      const sizing = screenSizing(n as unknown as Record<string, unknown>);
      if (sizing) dto.sizing = sizing;
    }
    const radius = uniformRadius(n);
    if (radius !== undefined) dto.cornerRadius = radius;
    const fill = solidFillHex(n);
    if (fill !== undefined) dto.fill = fill;
    if (typeof n.opacity === "number" && n.opacity !== 1) dto.opacity = n.opacity;
    if (typeof n.rotation === "number" && n.rotation !== 0) dto.rotation = n.rotation;
    if (typeof n.visible === "boolean" && !n.visible) dto.visible = false;
    if (typeof n.locked === "boolean" && n.locked) dto.locked = true;
    const overflow = overflowText(n.overflowDirection);
    if (overflow) dto.overflow = overflow;
    if (typeof n.numberOfFixedChildren === "number" && n.numberOfFixedChildren > 0) dto.fixedChildren = n.numberOfFixedChildren;
  }

  return dto;
}

/**
 * The third cause of a vanished id, after another page and a deletion. For
 * stretches of a second to twenty minutes Figma listed the layers of an
 * animated frame under second ids, which stopped resolving — for reads and
 * writes alike — when the stretch ended; the ids create calls returned kept
 * working throughout [C-199]. getNodeByIdAsync answers null for such an id
 * [C-187], which reads exactly like a deletion.
 */
export const TEMPORARY_ID_HINT =
  "An id read from a listing inside an animated frame (children, figma_get_motion_context, a REST export) can be " +
  "temporary: Figma lists such layers under second ids for a while. Use the id your create call returned, or read the parent again.";

/**
 * getNodeByIdAsync, with a throw from Figma itself said for what it is: Figma
 * could not fetch the node (notReachable), not a fault of the read. Null stays
 * null — "no such node" is the caller's to word.
 */
export async function lookUp(figma: Pick<FigmaLike, "getNodeByIdAsync">, id: string): Promise<NodeLike | null> {
  try {
    return await figma.getNodeByIdAsync(id);
  } catch (err) {
    throw notReachable(err, `the node \`${id}\``, undefined);
  }
}

/**
 * Resolve a node id through the async API, with a hint that names the real cause.
 *
 * A page other than the current one comes back loaded: under dynamic-page its
 * `children`, appendChild and insertChild need PageNode.loadAsync() first
 * [C-090], and every caller that asked for a page by id is about to use one of
 * them — a read walks it, a write puts something on it.
 */
export async function byId(figma: FigmaLike, id: string): Promise<NodeLike> {
  const node = await lookUp(figma, id);
  if (!node) {
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, {
      hint: `The node may be on another page (figma_get_pages lists the pages), or may have been deleted. ${TEMPORARY_ID_HINT}`,
    });
  }
  await ensureLoaded(node);
  return node;
}

/** What a top-level frame may sit in: a page, or a section on it. */
const CANVAS_TYPES: ReadonlySet<string> = new Set(["PAGE", "SECTION"]);

/**
 * The top-level frame around `node` — the child of its page, or of a section
 * there — found by walking `parent`. getTopLevelFrame() is not used for an id:
 * while a frame's layers are listed under second ids it names a second root,
 * which stops resolving when that stretch ends [C-199]. A section is never the
 * answer: getTopLevelFrame() returns a frame, and figma_check_motion's snapshot
 * (motion-snapshot.ts) reads the same frame. Null when `node` is not inside one.
 */
export function topLevelFrameOf(node: NodeLike): NodeLike | null {
  let n: NodeLike = node;
  while (n.parent && !CANVAS_TYPES.has(n.parent.type)) n = n.parent;
  return n.parent && !CANVAS_TYPES.has(n.type) ? n : null;
}

/** What the user has selected. It lives on the page (PageNode.selection); the PluginAPI object has no `selection`. */
export function selectionOf(figma: FigmaLike): readonly NodeLike[] {
  return (figma.currentPage as unknown as { selection?: readonly NodeLike[] }).selection ?? [];
}

/** Every page in the document, in order. */
export function pagesOf(figma: FigmaLike): NodeLike[] {
  return [...(figma.root.children ?? [])];
}
