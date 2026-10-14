// The modify group (tools.md § modify), Phase 2 core subset: the operations
// that reshape what create built — text, names, position, size, order, parent,
// visibility, and deletion.
//
// Two conventions that matter more here than anywhere else:
//
//  - **Multi-node ops return per-item results**, never all-or-nothing. A batch
//    of 40 nodes where 3 are on another page should rename 37 and report 3, not
//    fail the whole call and leave the agent guessing.
//  - **One call = one Ctrl+Z.** The caller commits; here we only mutate. That is
//    what makes "the agent did something I did not want" a single keystroke.
//  - **Every check runs through beforeMutating** (guard.ts), so a refusal says
//    `created: []` and the agent may retry without reading the canvas [C-096].

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { int, selectionOf as pageSelection, str, strList, TEMPORARY_ID_HINT, type FigmaLike } from "../read.js";
import {
  alignmentFor,
  applySizing,
  applyWrapFields,
  isMatrix,
  missedPlacement,
  normalizePadding,
  num,
  parseSizing,
  place,
  placementTolerance,
  resizeNode,
  wrapFields,
  type FigmaWrite,
  type FrameLike,
  type Matrix,
  type NodeLikeW,
  type Placeable,
  type TextLike,
} from "../write.js";
import { loadFont, weightToStyle } from "../write.js";
import { beforeMutating } from "../guard.js";
import { ensureLoaded } from "../pages.js";
import { figmaGlobal, has, tryGet } from "../safe.js";
import { fontsOf, loadTextFonts, textTarget, type CodeHolder, type TextHolder, type TextTarget } from "../sublayer.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;

/**
 * The user's selection. It lives on the page (PageNode.selection) — PluginAPI
 * has no `selection` [C-097] — so reading `figma.selection` saw nothing in the
 * real editor. One reader for every op (read.ts), typed for the write ops here.
 */
export const selectionOf = (figma: unknown): readonly NodeLikeW[] => pageSelection(figma as FigmaLike) as unknown as readonly NodeLikeW[];

/** Auto-layout owns its children's position (and GRID its cells) — x/y and rotation pivots defer to it. */
const LAYOUT_MODES = new Set(["HORIZONTAL", "VERTICAL", "GRID"]);
const inAutoLayout = (node: NodeLikeW): boolean =>
  LAYOUT_MODES.has(String((node.parent as unknown as { layoutMode?: unknown } | null | undefined)?.layoutMode));

/**
 * A deck's slides, the rows holding them and the grid holding the rows are
 * placed by the grid (getSlideGrid / setSlideGrid, plugin-api.d.ts:2029-2053)
 * [C-134]: x/y, z-order and a parent of one's own mean nothing there.
 */
const DECK_TYPES: ReadonlySet<string> = new Set(["SLIDE", "SLIDE_ROW", "SLIDE_GRID"]);
const DECK_PLACED = (type: string) =>
  `a ${type} is placed by the deck's grid, not by x/y, layer order or parent — figma_move_slides moves slides`;

/** One entry per requested node. `ok: false` carries the reason for that node only. */
export interface ItemResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * A per-item miss reads like a deletion, and an expired second id inside an
 * animated frame is the other cause [C-199]: a result holding one carries the
 * hint once, not on every item.
 */
function withMissHint<T extends { items: ItemResult[] }>(result: T): T & { hint?: string } {
  return result.items.some((i) => i.error === "not found") ? { ...result, hint: TEMPORARY_ID_HINT } : result;
}

/** Resolve many ids, keeping the caller's order and reporting the misses. */
export async function resolveAll(ids: string[]): Promise<Array<{ id: string; node: NodeLikeW | null }>> {
  const figma = api();
  const out: Array<{ id: string; node: NodeLikeW | null }> = [];
  for (const id of ids) out.push({ id, node: await figma.getNodeByIdAsync(id) });
  return out;
}

export function requireIds(ctx: OpContext): string[] {
  const ids = strList(ctx.params, "nodeIds");
  if (!ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of node ids.");
  return ids;
}

/** A styled run of a text node, as it was before it got overwritten. */
type Rgb = { r: number; g: number; b: number };
const r255 = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
const hex = (c: Rgb) => `#${r255(c.r)}${r255(c.g)}${r255(c.b)}`;

interface TextRun {
  start: number;
  end: number;
  text: string;
  font: { family: string; style: string } | null;
  fontSize: number | null;
  fill: string | null;
  /** Only when underlined or struck through — a lost link underline must be visible too. */
  decoration?: string;
}

type Ranged = {
  characters: string;
  fontName?: { family: string; style: string } | symbol;
  fontSize?: number | symbol;
  fills?: readonly unknown[] | symbol;
  getStyledTextSegments?: (
    fields: string[],
    start?: number,
    end?: number,
  ) => Array<{
    start: number;
    end: number;
    fontName?: { family: string; style: string };
    fontSize?: number | symbol;
    fills?: unknown[] | symbol;
    textDecoration?: string | symbol;
  }>;
  getRangeFontName?: (s: number, e: number) => { family: string; style: string } | symbol;
  getRangeFontSize?: (s: number, e: number) => number | symbol;
  getRangeFills?: (s: number, e: number) => unknown[] | symbol;
};

const solidHex = (paints: unknown): string | null => {
  if (!Array.isArray(paints)) return null;
  const top = paints[paints.length - 1] as { type?: string; color?: Rgb; visible?: boolean } | undefined;
  if (!top || top.visible === false || top.type !== "SOLID" || !top.color) return null;
  return hex(top.color);
};

/**
 * The styled segments of a text node, or [] when it has only one style.
 *
 * getStyledTextSegments exists in the sandbox, but a partial implementation in a
 * fake — or an older host — must not turn "I could not tell" into "nothing to
 * report", so each field falls back to the per-range getter before giving up.
 */
function readRuns(t: Ranged): TextRun[] {
  const chars = t.characters ?? "";
  if (!chars.length) return [];
  const end = chars.length;
  let segs: Array<{ start: number; end: number; fontName?: { family: string; style: string }; fontSize?: number | symbol; fills?: unknown[] | symbol; textDecoration?: string | symbol }>;
  try {
    if (typeof t.getStyledTextSegments === "function") {
      segs = t.getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"], 0, end);
    } else if (typeof t.getRangeFontName === "function") {
      // No segment API: a single run is all that can be read without walking characters.
      segs = [{ start: 0, end, fontName: t.getRangeFontName(0, end) as { family: string; style: string }, fontSize: t.getRangeFontSize?.(0, end), fills: t.getRangeFills?.(0, end) }];
    } else {
      return [];
    }
  } catch {
    // A connector label's font is unreadable until set [C-148]: no runs to report, not a failure.
    return [];
  }
  const runs: TextRun[] = segs.map((s) => {
    const font = s.fontName && typeof s.fontName === "object" ? s.fontName : typeof t.fontName === "object" ? t.fontName : null;
    const size = typeof s.fontSize === "number" ? s.fontSize : typeof t.fontSize === "number" ? t.fontSize : null;
    const fill = solidHex(s.fills) ?? solidHex(t.fills);
    return {
      start: s.start,
      end: s.end,
      text: chars.slice(s.start, s.end),
      font,
      fontSize: size,
      fill,
      ...(typeof s.textDecoration === "string" && s.textDecoration !== "NONE" ? { decoration: s.textDecoration } : {}),
    };
  });
  // One run means nothing was mixed; more than one means the caller is about to lose something.
  const key = (r: TextRun) => `${r.font?.family}/${r.font?.style}|${r.fontSize}|${r.fill}|${r.decoration ?? ""}`;
  return new Set(runs.map(key)).size > 1 ? runs : [];
}

/**
 * Load what a sticky's, shape's or connector's text needs, as a refusal that
 * changed nothing: loadTextFonts throws only before its one write (a
 * connector's unusable label font is replaced by Inter Medium [C-148]).
 */
async function sublayerFonts(t: TextTarget, figma: FigmaWrite): Promise<{ reset?: { family: string; style: string } }> {
  return beforeMutating(async () => {
    try {
      return await loadTextFonts(t, figma);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `The ${t.owner.type}'s text font did not load: ${err instanceof Error ? err.message : String(err)}`, {
        hint: "figma_get_fonts lists the fonts this Figma can load.",
      });
    }
  });
}

/**
 * figma_set_text. A TEXT node, or the text a board node holds [C-135]: a
 * sticky's, a shape's or a connector's `text` sublayer, and a code block's
 * `code`, which has no font. Table cells have no id (d.ts:11442), so a table
 * goes through figma_edit_table.
 */
const setText: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { node, content, target } = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      const content = ctx.params.content;
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      if (typeof content !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`content` must be a string.");
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: TEMPORARY_ID_HINT });
      if (node.type === "TABLE") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `Node \`${id}\` is a TABLE: its text lives in cells, which have no id of their own.`, {
          hint: "figma_edit_table writes a cell by row and column.",
        });
      }
      const target = textTarget(node);
      if (!target) {
        throw new BridgeError(
          ErrorCode.INVALID_PARAM,
          `Node \`${id}\` is a ${node.type}, which holds no text.`,
          { hint: "figma_scan_text_nodes finds the text in a subtree: TEXT nodes, and on a board stickies, shapes, connectors and code blocks." },
        );
      }
      return { node, content, target };
    });
    if (target.kind === "code") {
      (target.target as CodeHolder).code = content;
      return { id: node.id, name: node.name, type: node.type, characters: content.length };
    }
    if (target.kind === "sublayer") {
      const runs = readRuns(target.target as unknown as Ranged);
      const { reset } = await sublayerFonts(target, figma);
      (target.target as TextHolder).characters = content;
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        characters: content.length,
        ...(reset ? { font: { ...reset, note: "its label font could not be used, so it was set to this first" } } : {}),
        ...(runs.length > 1 ? { flattened: { note: FLATTENED, runs } } : {}),
      };
    }
    const text = node as unknown as TextLike;
    // Setting characters on a text node whose font is not loaded throws, and
    // figma.mixed means the node has several fonts — load the ones it uses.
    // Load every font the text already uses and keep them. The old code, on a
    // text with mixed fonts, replaced the WHOLE font with Inter Regular before
    // writing — measured live: two prices silently turned Inter. Writing the
    // characters keeps the first character's style, as typing over a
    // selection does in Figma.
    const t = text as unknown as {
      characters: string;
      getRangeAllFontNames?: (s: number, e: number) => Array<{ family: string; style: string }>;
      getStyledTextSegments?: (
        fields: string[],
        start?: number,
        end?: number,
      ) => Array<{ start: number; end: number; fontName?: { family: string; style: string }; fontSize?: number | symbol; fills?: unknown[] | symbol }>;
    };
    const current = text.fontName;

    // What the node looks like BEFORE it is overwritten. Assigning `characters`
    // is Figma's own behaviour: the new text takes the first character's style
    // and every other run is gone. An earlier fix made set_text load all the
    // fonts so it no longer failed or forced Inter, but it still destroyed the
    // styling without saying so — measured live on `v2 / 03 About`, where a
    // "IND" Michroma + "EX" Krona One title came back as "ABOUT" in Michroma
    // and had to be restored by hand with figma_set_text_range.
    const runs = readRuns(t);
    const distinct = runs.length > 1;

    const fonts =
      t.characters.length && typeof t.getRangeAllFontNames === "function"
        ? t.getRangeAllFontNames(0, t.characters.length)
        : current && typeof current === "object"
          ? [current as { family: string; style: string }]
          : [];
    // Loading a font changes nothing in the document, so a font that will not
    // load is still a refusal before the first write.
    const fallback = await beforeMutating(async () => {
      if (!fonts.length) return loadFont(figma);
      for (const f of fonts) await figma.loadFontAsync(f);
      return undefined;
    });
    if (fallback) text.fontName = { family: fallback.family, style: fallback.style };
    text.characters = content;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      characters: content.length,
      ...(fallback ? { font: { family: fallback.family, style: fallback.style, fellBack: true } } : {}),
      ...(distinct ? { flattened: { note: FLATTENED, runs } } : {}),
    };
  },
};

const FLATTENED =
  "This node had several styles and only the first one survived — Figma gives the new text " +
  "the first character's style. Reapply the rest with figma_set_text_range.";

const renameNode: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { node, name } = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      const name = str(ctx.params, "name");
      if (!id || !name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` and `name` are required.");
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: TEMPORARY_ID_HINT });
      return { node, name };
    });
    const before = node.name;
    node.name = name;
    return { id: node.id, name, previousName: before };
  },
};

const batchRename: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { pattern, replace, types, re, scopeRoot } = await beforeMutating(async () => {
      const pattern = str(ctx.params, "pattern");
      const replace = str(ctx.params, "replace");
      if (pattern === undefined || replace === undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`pattern` and `replace` are required.");
      }
      const types = strList(ctx.params, "types")?.map((t) => t.toUpperCase());
      const useRegex = ctx.params.regex === true;

      let re: RegExp | null = null;
      if (useRegex) {
        try {
          re = new RegExp(pattern, "g");
        } catch (err) {
          throw new BridgeError(
            ErrorCode.INVALID_PARAM,
            `\`pattern\` is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Reuse the read-side traversal so scope handling is identical to search.
      return { pattern, replace, types, re, scopeRoot: await scopeFor(figma, ctx) };
    });
    const items: ItemResult[] = [];
    await walkNames(figma, scopeRoot, ctx, (node) => {
      if (types && !types.includes(node.type.toUpperCase())) return;
      const next = re ? node.name.replace(re, replace) : node.name.split(pattern).join(replace);
      if (next === node.name) return;
      try {
        node.name = next;
        items.push({ id: node.id, ok: true });
      } catch (err) {
        items.push({ id: node.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return { renamed: items.filter((i) => i.ok).length, items };
  },
};

async function scopeFor(figma: FigmaWrite, ctx: OpContext): Promise<NodeLikeW> {
  const id = str(ctx.params, "nodeId");
  if (id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: TEMPORARY_ID_HINT });
    await ensureLoaded(node); // another page's children are unreadable until loaded [C-090]
    return node;
  }
  const scope = (str(ctx.params, "scope") ?? "page").toLowerCase();
  if (scope === "selection") {
    const sel = selectionOf(figma);
    if (sel.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`scope: \"selection\"` but nothing is selected.");
    return sel[0]!;
  }
  return figma.currentPage;
}

async function walkNames(
  _figma: FigmaWrite,
  root: NodeLikeW,
  ctx: OpContext,
  visit: (node: NodeLikeW) => void,
): Promise<void> {
  const stack: NodeLikeW[] = [root];
  let seen = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    if (++seen % 200 === 0) {
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while renaming.");
      await ctx.yieldToHost();
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

/**
 * figma_move_nodes. `positioning: "absolute"` takes a child out of its
 * auto-layout's flow while keeping it inside the frame — a badge on a card's
 * corner, a close button on a modal — which before needed a layout-free
 * wrapper that broke hug and fill [C-095]. Order is the API's: FILL is
 * incompatible with ABSOLUTE, so a filling axis is fixed at its current size
 * first; layoutPositioning moves the node itself, so x/y come after it. x and
 * y go in one write and are read back: `ok` means the layer is there [C-250].
 */
const moveNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { ids, x, y, positioning } = await beforeMutating(() => {
      const ids = requireIds(ctx);
      const x = num(ctx.params, "x");
      const y = num(ctx.params, "y");
      const raw = str(ctx.params, "positioning")?.toLowerCase();
      if (raw !== undefined && raw !== "auto" && raw !== "absolute") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`positioning` must be auto or absolute.");
      }
      if (x === undefined && y === undefined && raw === undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Provide `x` and/or `y`, or `positioning`.");
      }
      return { ids, x, y, positioning: raw as "auto" | "absolute" | undefined };
    });
    const relative = ctx.params.relative === true;
    const items: Array<ItemResult & { positioning?: string; sizing?: string }> = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (DECK_TYPES.has(node.type)) {
        items.push({ id, ok: false, error: DECK_PLACED(node.type) });
        continue;
      }
      const movable = node as unknown as Placeable & { layoutPositioning?: string; layoutSizingHorizontal?: string; layoutSizingVertical?: string };
      if (typeof movable.x !== "number" || typeof movable.y !== "number") {
        items.push({ id, ok: false, error: `a ${node.type} has no position` });
        continue;
      }
      if (positioning && !inAutoLayout(node)) {
        items.push({ id, ok: false, error: `${positioning} positioning needs an auto-layout parent — this node's parent has none, so x/y already place it` });
        continue;
      }
      // has(), not `in`: a member check on a board or deck node may throw [C-145], and this loop is not inside a try.
      if (positioning && !has(movable, "layoutPositioning")) {
        items.push({ id, ok: false, error: `a ${node.type} cannot be positioned inside an auto-layout` });
        continue;
      }
      try {
        const item: ItemResult & { positioning?: string; sizing?: string } = { id, ok: true };
        if (positioning === "absolute") {
          const fixed: string[] = [];
          if (movable.layoutSizingHorizontal === "FILL") {
            movable.layoutSizingHorizontal = "FIXED";
            fixed.push("width");
          }
          if (movable.layoutSizingVertical === "FILL") {
            movable.layoutSizingVertical = "FIXED";
            fixed.push("height");
          }
          if (fixed.length) item.sizing = `${fixed.join(" and ")} fixed (was fill)`;
        }
        if (positioning) {
          movable.layoutPositioning = positioning === "absolute" ? "ABSOLUTE" : "AUTO";
          item.positioning = positioning;
        }
        const tx = x === undefined ? undefined : relative ? movable.x! + x : x;
        const ty = y === undefined ? undefined : relative ? movable.y! + y : y;
        if (tx !== undefined || ty !== undefined) {
          place(movable, tx, ty);
          const miss = await missedPlacement(api(), id, tx, ty);
          if (miss) {
            // Figma ignores x/y on a child its auto-layout places [C-186]; that used to answer ok too.
            const flow = inAutoLayout(node) && movable.layoutPositioning !== "ABSOLUTE";
            items.push({
              ...item,
              ok: false,
              error: flow
                ? `${miss}: its auto-layout places it — positioning "absolute" lets x and y place it`
                : `${miss}. Read it back with figma_get_nodes_info; if it is still off, move x and y in two calls`,
            });
            continue;
          }
        }
        items.push(item);
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ moved: items.filter((i) => i.ok).length, items });
  },
};

/**
 * Nodes whose size is not theirs to set, and what sets it instead. A sticky
 * is 240 wide, 416 when wide, and its height follows its text (d.ts:1226,
 * StickyNode has no resize, 11305) [C-147]; a table is sized by its rows and
 * columns; a slide is fixed at 1920×1080 (Working in Slides) [C-134].
 */
const FIXED_SIZE: Record<string, string> = {
  STICKY: "a STICKY is 240 wide, or 416 with figma_set_board_properties { wide: true }; its height follows its text",
  TABLE: "a TABLE is sized by its rows and columns: figma_edit_table resizes them",
  CONNECTOR: "a CONNECTOR's length follows its ends: figma_edit_connectors moves them",
  CODE_BLOCK: "a CODE_BLOCK sizes to its code",
  SLIDE: "a SLIDE is fixed at 1920×1080",
  SLIDE_ROW: "a SLIDE_ROW is sized by the slides it holds",
  SLIDE_GRID: "the SLIDE_GRID is sized by the deck",
};

type Limit = "minWidth" | "maxWidth" | "minHeight" | "maxHeight";
const LIMITS: readonly Limit[] = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
const AXES: ReadonlyArray<[Limit, Limit]> = [["minWidth", "maxWidth"], ["minHeight", "maxHeight"]];

/**
 * figma_resize_nodes. Min/max limits are what keep a "fill" paragraph readable
 * on a wide screen (maxWidth 480). Figma documents them as "applicable only to
 * auto-layout frames and their direct children", positive, null to remove
 * [C-095] — so the rule is checked per node rather than left to a raw throw,
 * and a min above its max is refused before any node changes.
 */
const resizeNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { ids, width, height, sizing, limits, clear } = await beforeMutating(() => {
      const ids = requireIds(ctx);
      const width = num(ctx.params, "width");
      const height = num(ctx.params, "height");
      const sizing = parseSizing(ctx.params.sizing);
      const limits: Partial<Record<Limit, number>> = {};
      for (const key of LIMITS) {
        const v = num(ctx.params, key);
        if (v === undefined) continue;
        if (v <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` must be a positive number (clearLimits removes it).`);
        limits[key] = v;
      }
      const rawClear = ctx.params.clearLimits;
      if (rawClear !== undefined && (!Array.isArray(rawClear) || rawClear.some((k) => !LIMITS.includes(k as Limit)))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`clearLimits\` lists any of: ${LIMITS.join(", ")}.`);
      }
      const clear = new Set((rawClear ?? []) as Limit[]);
      for (const key of clear) {
        if (limits[key] !== undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` is both set and cleared.`);
      }
      for (const [min, max] of AXES) {
        if (limits[min] !== undefined && limits[max] !== undefined && limits[min]! > limits[max]!) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${min}\` (${limits[min]}) is above \`${max}\` (${limits[max]}).`);
        }
      }
      const anyLimit = Object.keys(limits).length > 0 || clear.size > 0;
      if (width === undefined && height === undefined && !sizing && !anyLimit) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Provide `width`, `height`, `sizing`, a min/max limit, and/or `clearLimits`.");
      }
      if ((width !== undefined && width < 0) || (height !== undefined && height < 0)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`width` and `height` must be non-negative.");
      }
      return { ids, width, height, sizing, limits, clear };
    });
    const touchesLimits = Object.keys(limits).length > 0 || clear.size > 0;
    const items: ItemResult[] = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const r = node as unknown as {
        resize?: (w: number, h: number) => void;
        resizeWithoutConstraints?: (w: number, h: number) => void;
        width?: number;
        height?: number;
        textAutoResize?: string;
      } & Partial<Record<Limit, number | null>>;
      const fixed = FIXED_SIZE[node.type];
      if (fixed && (width !== undefined || height !== undefined || DECK_TYPES.has(node.type))) {
        items.push({ id, ok: false, error: fixed });
        continue;
      }
      // A section may offer only resizeWithoutConstraints: its resize() is contradicted [C-141].
      const resizable = typeof r.resize === "function" || (node.type === "SECTION" && typeof r.resizeWithoutConstraints === "function");
      if ((width !== undefined || height !== undefined) && !resizable) {
        items.push({ id, ok: false, error: `a ${node.type} cannot be resized` });
        continue;
      }
      if (touchesLimits) {
        const self = (node as unknown as { layoutMode?: string }).layoutMode;
        if (self !== "HORIZONTAL" && self !== "VERTICAL" && !inAutoLayout(node)) {
          items.push({ id, ok: false, error: "min/max limits are \"applicable only to auto-layout frames and their direct children\" (Figma) — this node is neither" });
          continue;
        }
        // Against what the node already holds too: a new maxWidth under its
        // existing minWidth would otherwise fail half-way through this node.
        const after = (key: Limit) => (limits[key] !== undefined ? limits[key]! : clear.has(key) ? null : (r[key] ?? null));
        const clash = AXES.find(([min, max]) => after(min) !== null && after(max) !== null && after(min)! > after(max)!);
        if (clash) {
          items.push({ id, ok: false, error: `${clash[0]} ${after(clash[0])} would be above ${clash[1]} ${after(clash[1])}` });
          continue;
        }
      }
      try {
        if (width !== undefined || height !== undefined) {
          // A section through resizeWithoutConstraints: its resize() is contradicted [C-141].
          resizeNode(node, width ?? r.width ?? 100, height ?? r.height ?? 100);
          // A text given only a width should wrap inside it and grow downwards,
          // not be frozen at its old height with the rest cut off.
          if (node.type === "TEXT" && width !== undefined && height === undefined) r.textAutoResize = "HEIGHT";
        }
        applySizing(node, sizing);
        for (const key of clear) r[key] = null;
        // The end state is consistent (checked above), but the steps to it must
        // be too: a min raised past the current max goes after the new max.
        for (const [min, max] of AXES) {
          const current = r[max] ?? null;
          const order: Limit[] = limits[min] !== undefined && current !== null && limits[min]! > current ? [max, min] : [min, max];
          for (const key of order) if (limits[key] !== undefined) r[key] = limits[key]!;
        }
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ resized: items.filter((i) => i.ok).length, items });
  },
};

/**
 * figma_delete_nodes. In a deck one id must never take a whole section of
 * slides with it: a SLIDE_ROW that still holds slides is refused (delete them,
 * or regroup with figma_set_slide_grid), and the SLIDE_GRID is the deck itself.
 * Removing a row's last slide leaves the row, empty (slide-lifecycle.md:51-58)
 * — reported as `emptiedRows`, and deletable by id.
 */
const deleteNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const ids = await beforeMutating(() => requireIds(ctx));
    const items: ItemResult[] = [];
    const emptied: NodeLikeW[] = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (node.type === "SLIDE_GRID") {
        items.push({ id, ok: false, error: "the SLIDE_GRID is the deck itself: delete its slides instead" });
        continue;
      }
      const kids = node.type === "SLIDE_ROW" ? tryGet<readonly NodeLikeW[] | undefined>(node, "children") : null;
      const held = kids?.ok ? (kids.value ?? []).length : 0;
      if (held > 0) {
        items.push({ id, ok: false, error: `this SLIDE_ROW still holds ${held} slide(s): delete them first, or regroup them with figma_set_slide_grid` });
        continue;
      }
      try {
        const row = node.type === "SLIDE" && node.parent?.type === "SLIDE_ROW" ? node.parent : null;
        node.remove!();
        items.push({ id, ok: true });
        if (row && !(row.children ?? []).length && !emptied.includes(row)) emptied.push(row);
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // A row emptied here and then deleted by its own id in the same call is gone, not empty.
    const gone = new Set(items.filter((i) => i.ok).map((i) => i.id));
    const emptiedRows = emptied.filter((r) => !gone.has(r.id)).map((r) => r.id);
    return withMissHint({
      deleted: items.filter((i) => i.ok).length,
      items,
      ...(emptiedRows.length ? { emptiedRows } : {}),
      note: "This is the way to undo agent work: delete by the ids the create call returned. One Ctrl+Z reverts the whole call.",
    });
  },
};

/** Where a copied slide goes: right after its source in the same row, else at the end of `row`. */
function slideSlot(source: NodeLikeW, row: NodeLikeW): number {
  const kids = row.children ?? [];
  const at = source.parent?.id === row.id ? kids.findIndex((c) => c.id === source.id) : -1;
  return at >= 0 ? at + 1 : kids.length;
}

type Grid = NodeLikeW[][];

/** The deck's grid through whichever reader this Figma has (getCanvasGrid replaces getSlideGrid, d.ts:2027-2070) [C-134]. */
function readGrid(): { grid: Grid; write: (g: Grid) => void } | null {
  const g = figmaGlobal() as Record<string, unknown> | undefined;
  for (const [get, set] of [["getCanvasGrid", "setCanvasGrid"], ["getSlideGrid", "setSlideGrid"]] as const) {
    const read = tryGet<() => Grid>(g, get);
    const write = tryGet<(grid: Grid) => void>(g, set);
    if (read.ok && typeof read.value === "function" && write.ok && typeof write.value === "function") {
      const writer = write.value;
      return { grid: read.value.call(g).map((r) => [...r]), write: (next) => writer.call(g, next) };
    }
  }
  return null;
}

/**
 * Put a slide's copy into the deck. SlideNode.clone() parents the copy under
 * the page (d.ts:12306-12308), and "Slides must be direct children of Slide
 * Rows", so it moves into `row` — by insertChild, else by writing the grid
 * back with the copy beside its source (slide-lifecycle.md:40-49). Which of the
 * two Figma accepts is measured by spikes/live-editors-write.mjs; null means it
 * landed, else the reasons both failed.
 */
function placeSlideCopy(copy: NodeLikeW, source: NodeLikeW, row: NodeLikeW): string | null {
  const reasons: string[] = [];
  try {
    row.insertChild!(slideSlot(source, row), copy);
    if (copy.parent?.id === row.id) return null;
    reasons.push("insertChild left it outside the row");
  } catch (err) {
    reasons.push(`insertChild: ${err instanceof Error ? err.message : String(err)}`);
  }
  const deck = readGrid();
  if (!deck) return [...reasons, "this Figma has no grid writer"].join("; ");
  try {
    const r = deck.grid.findIndex((slides) => slides.some((s) => s.parent?.id === row.id));
    const rowSlides = r >= 0 ? deck.grid[r]! : null;
    if (!rowSlides) return [...reasons, "the row is not in the grid"].join("; ");
    const at = rowSlides.findIndex((s) => s.id === source.id);
    rowSlides.splice(at >= 0 ? at + 1 : rowSlides.length, 0, copy);
    deck.write(deck.grid);
    if (copy.parent?.id === row.id) return null;
    reasons.push("the grid write left it outside the row");
  } catch (err) {
    reasons.push(`grid: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reasons.join("; ");
}

/**
 * figma_clone_node. A slide is duplicated into a SLIDE_ROW — its own, right
 * after it, unless `parentId` names another row; x/y mean nothing in the grid.
 * The grid itself cannot be copied (SlideGridNode.clone throws, d.ts:12344),
 * and a row's copy would land on the page outside the grid, so neither is.
 */
const cloneNode: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { node, clonable, target } = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: TEMPORARY_ID_HINT });
      if (node.type === "SLIDE_GRID" || node.type === "SLIDE_ROW") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${node.type} cannot be cloned: ${node.type === "SLIDE_GRID" ? "it is the deck itself" : "its copy would sit outside the deck's grid"}.`, {
          hint: "Clone its slides one by one, then arrange them with figma_set_slide_grid.",
        });
      }
      const clonable = node as unknown as { clone?: () => NodeLikeW };
      if (typeof clonable.clone !== "function") {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${node.type} cannot be cloned.`);
      }
      // The target before the copy exists: a bad parentId must not leave a clone behind.
      const parentId = str(ctx.params, "parentId");
      const target = parentId ? await figma.getNodeByIdAsync(parentId) : (node.parent ?? null);
      if (parentId && !target) {
        throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${parentId}\` to clone into.`, { hint: TEMPORARY_ID_HINT });
      }
      if (node.type === "SLIDE") {
        if (ctx.params.x !== undefined || ctx.params.y !== undefined) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "A slide has no x/y of its own: the deck's grid places it.", { hint: "Give parentId = a SLIDE_ROW; figma_move_slides moves it afterwards." });
        }
        if (target?.type !== "SLIDE_ROW") {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `A slide's copy goes into a SLIDE_ROW${target ? `, not a ${target.type}` : ""}.`, { hint: "figma_get_slide_grid lists the rows." });
        }
      } else if (target && (target.type === "SLIDE_ROW" || target.type === "SLIDE_GRID")) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${target.type} holds ${target.type === "SLIDE_ROW" ? "slides" : "rows"}, not layers: clone into a SLIDE.`);
      }
      if (target) await ensureLoaded(target);
      return { node, clonable: clonable as { clone: () => NodeLikeW }, target };
    });
    const copy = clonable.clone();
    if (node.type === "SLIDE") {
      const refused = placeSlideCopy(copy, node, target!);
      if (refused) {
        // A copy left on the page would sit outside every row: it goes, and nothing is reported as made.
        copy.remove?.();
        throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma would not place the slide's copy in the row: ${refused}.`, {
          hint: "The copy was removed again. figma_create_slides makes a new slide where you want it.",
          partial: { created: [] },
        });
      }
      const name = str(ctx.params, "name");
      if (name) copy.name = name;
      const row = copy.parent!;
      const rows = row.parent?.children ?? [];
      return {
        id: copy.id, name: copy.name, type: copy.type, sourceId: node.id,
        rowId: row.id, row: rows.findIndex((r) => r.id === row.id), col: (row.children ?? []).findIndex((s) => s.id === copy.id),
      };
    }
    const name = str(ctx.params, "name");
    if (name) copy.name = name;
    // clone() always parents the copy under figma.currentPage (typings 1.141.0),
    // so it must be placed explicitly. The old code skipped that when the target
    // was the source's own parent, and every such clone landed loose on the page
    // (measured live). Same parent: right after the source, as Ctrl+D does.
    if (target && target.id === node.parent?.id && typeof target.insertChild === "function" && target.children) {
      target.insertChild(target.children.findIndex((c) => c.id === node.id) + 1, copy);
    } else if (target) {
      target.appendChild!(copy);
    }
    // Both coordinates in one write, read back, as figma_move_nodes [C-250]. The
    // copy exists either way, so a position Figma did not keep is a warning.
    const move = copy as unknown as Placeable;
    const x = num(ctx.params, "x");
    const y = num(ctx.params, "y");
    let warning: string | undefined;
    if ((x !== undefined || y !== undefined) && typeof move.x === "number" && typeof move.y === "number") {
      place(move, x, y);
      const miss = await missedPlacement(figma, copy.id, x, y);
      if (miss) warning = inAutoLayout(copy) ? `${miss}: its auto-layout places the copy` : miss;
    }
    return { id: copy.id, name: copy.name, type: copy.type, sourceId: node.id, ...(warning ? { warning } : {}) };
  },
};

const groupNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { nodes, missing, group, parent } = await beforeMutating(async () => {
      const ids = requireIds(ctx);
      if (ids.length < 1) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must not be empty.");
      const nodes: NodeLikeW[] = [];
      const missing: ItemResult[] = [];
      for (const { id, node } of await resolveAll(ids)) {
        if (node) nodes.push(node);
        else missing.push({ id, ok: false, error: "not found" });
      }
      if (nodes.length === 0) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, "None of the given nodes exist.", { hint: TEMPORARY_ID_HINT });
      // figma.group(nodes, parent, index) — a PluginAPI method (typings 1.141.0).
      // This op used to call parent.group(), which no node has, so it never worked.
      const group = (figma as unknown as { group?: (n: readonly NodeLikeW[], p: NodeLikeW, i?: number) => NodeLikeW }).group;
      if (typeof group !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot group.");
      const parent = nodes[0]!.parent;
      if (!parent || nodes.some((n) => n.parent?.id !== parent.id)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "These nodes do not share one parent.", {
          hint: "Group nodes that sit in the same frame or page; figma_reparent_nodes can bring them together first.",
        });
      }
      return { nodes, missing, group, parent };
    });
    // Insert where the lowest of them was, so grouping does not reorder the
    // stack — or, in an auto-layout frame, the flow.
    const siblings = parent.children ?? [];
    const index = Math.min(...nodes.map((n) => siblings.findIndex((s) => s.id === n.id)).filter((i) => i >= 0));
    try {
      const made = group.call(figma, nodes, parent, Number.isFinite(index) ? index : undefined);
      const name = str(ctx.params, "name");
      if (name) made.name = name;
      return withMissHint({ id: made.id, name: made.name, type: made.type, childCount: nodes.length, items: missing });
    } catch (err) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `Figma refused to group these nodes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};


/** A node's position on its page, from absoluteTransform [[a, b, tx], [c, d, ty]] (d.ts:7328); null when unreadable. */
function absoluteAt(node: NodeLikeW): { x: number; y: number } | null {
  const t = tryGet<ReadonlyArray<ReadonlyArray<number>>>(node, "absoluteTransform");
  if (!t.ok || !Array.isArray(t.value) || !t.value[0] || !t.value[1]) return null;
  const x = t.value[0][2];
  const y = t.value[1][2];
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

/**
 * figma_reparent_nodes. An append keeps the node's numbers, which are now
 * relative to the new parent — so a sticky moved into a section jumps on the
 * canvas. `keepPosition` keeps where it stood on the page instead; `x`/`y`
 * place it in the new parent, after the append, the order the official notes
 * give (position-figjam-nodes.md:56-62). A connector moved this way may keep
 * its old route (generate-project-plan SKILL.md:195) [C-149], so its item says
 * so. A slide, row or grid is placed by the deck, not reparented.
 */
const reparentNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { ids, parentId, target, x, y, keep } = await beforeMutating(async () => {
      const ids = requireIds(ctx);
      const parentId = str(ctx.params, "parentId");
      if (!parentId) throw new BridgeError(ErrorCode.INVALID_PARAM, "`parentId` is required.");
      const keep = ctx.params.keepPosition;
      if (keep !== undefined && typeof keep !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`keepPosition` must be true or false.");
      const x = num(ctx.params, "x");
      const y = num(ctx.params, "y");
      if (keep === true && (x !== undefined || y !== undefined)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `keepPosition` or `x`/`y`, not both: one keeps the place on the page, the other sets one in the new parent.");
      }
      const target = await figma.getNodeByIdAsync(parentId);
      if (!target) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${parentId}\` to reparent into.`, { hint: TEMPORARY_ID_HINT });
      if (target.type === "SLIDE_ROW" || target.type === "SLIDE_GRID") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${target.type} holds ${target.type === "SLIDE_ROW" ? "slides" : "rows"}, not layers.`, {
          hint: "Move layers into a SLIDE; figma_move_slides moves slides between rows.",
        });
      }
      if ((keep === true || x !== undefined || y !== undefined) && inLayoutOf(target)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `"${target.name}" has auto-layout, which places its children: \`x\`/\`y\` and \`keepPosition\` would be ignored.`, {
          hint: "Reparent without them, or into a frame without layout or a section.",
        });
      }
      // Another page takes children only once it is loaded [C-090].
      await ensureLoaded(target);
      return { ids, parentId, target, x, y, keep: keep === true };
    });
    const index = int(ctx.params, "index", -1, 1_000_000);
    const items: Array<ItemResult & { warning?: string }> = [];
    let at = index >= 0 ? index : -1;
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (node.id === target.id) {
        items.push({ id, ok: false, error: "cannot reparent a node into itself" });
        continue;
      }
      if (DECK_TYPES.has(node.type)) {
        items.push({ id, ok: false, error: DECK_PLACED(node.type) });
        continue;
      }
      const before = keep ? absoluteAt(node) : null;
      if (keep && !before) {
        items.push({ id, ok: false, error: `a ${node.type}'s place on the page cannot be read, so keepPosition cannot hold it` });
        continue;
      }
      try {
        if (at >= 0 && target.insertChild) {
          target.insertChild(at, node);
          at++;
        } else {
          target.appendChild!(node);
        }
        // One write for both coordinates, then a readback, as figma_move_nodes [C-250].
        const p = node as unknown as Placeable & { x: number; y: number };
        const after = before ? absoluteAt(node) : null;
        let tx = x;
        let ty = y;
        if (before && after) {
          tx = p.x + before.x - after.x;
          ty = p.y + before.y - after.y;
        }
        if (tx !== undefined || ty !== undefined) {
          place(p, tx, ty);
          const miss = await missedPlacement(figma, id, tx, ty);
          if (miss) {
            items.push({ id, ok: false, error: `moved into "${target.name}", but ${miss}` });
            continue;
          }
        }
        items.push({ id, ok: true, ...(node.type === "CONNECTOR" ? { warning: "a moved connector may keep its old route: if it looks wrong, recreate it in the new parent" } : {}) });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ reparented: items.filter((i) => i.ok).length, parentId, items });
  },
};

/** Whether `node` lays its own children out (auto-layout or grid): x/y of a child are its to set. */
function inLayoutOf(node: NodeLikeW): boolean {
  const mode = tryGet(node, "layoutMode");
  return mode.ok && LAYOUT_MODES.has(String(mode.value));
}

/** set_visible / set_locked / set_opacity / set_clips_content share this shape: one boolean or number, many nodes. */
function flagOp(
  param: string,
  apply: (node: NodeLikeW, value: boolean | number) => void,
  label: string,
): PluginOp {
  return {
    write: true,
    async run(ctx: OpContext) {
      const { ids, raw } = await beforeMutating(() => {
        const ids = requireIds(ctx);
        const raw = ctx.params[param];
        if (typeof raw !== "boolean" && typeof raw !== "number") {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${param}\` is required (${param === "opacity" ? "0–1" : "true/false"}).`);
        }
        if (param === "opacity" && (raw as number) < 0 || param === "opacity" && (raw as number) > 1) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`opacity` must be between 0 and 1.");
        }
        return { ids, raw };
      });
      const items: ItemResult[] = [];
      for (const { id, node } of await resolveAll(ids)) {
        if (!node) {
          items.push({ id, ok: false, error: "not found" });
          continue;
        }
        try {
          apply(node, raw);
          items.push({ id, ok: true });
        } catch (err) {
          items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return withMissHint({ [`${label}`]: items.filter((i) => i.ok).length, items });
    },
  };
}

const setVisible = flagOp("visible", (node, v) => { (node as unknown as { visible: boolean }).visible = v as boolean; }, "updated");
const setLocked = flagOp("locked", (node, v) => { (node as unknown as { locked: boolean }).locked = v as boolean; }, "updated");
const setOpacity = flagOp("opacity", (node, v) => { (node as unknown as { opacity: number }).opacity = v as number; }, "updated");

/**
 * figma_set_clips_content: crop a photo to a rounded card, or stop a frame
 * cutting off a shadow — the fix a `clipped` finding points at, which before
 * meant rebuilding the frame. clipsContent is a BaseFrameMixin member (FRAME,
 * COMPONENT, COMPONENT_SET, INSTANCE; typings 1.141.0); a SECTION or a shape has
 * none, and saying so beats a silent no-op assignment.
 */
const setClipsContent = flagOp("clipsContent", (node, v) => {
  if (!has(node, "clipsContent")) throw new Error(`a ${node.type} has no clipsContent`);
  (node as unknown as { clipsContent: boolean }).clipsContent = v as boolean;
}, "updated");

/** A node's box centre in its parent's space, from relativeTransform [[a, b, tx], [c, d, ty]]. */
function centre(node: NodeLikeW): { x: number; y: number } | null {
  const n = node as unknown as { relativeTransform?: ReadonlyArray<ReadonlyArray<number>>; width?: number; height?: number };
  const t = n.relativeTransform;
  if (!t || !t[0] || !t[1] || typeof n.width !== "number" || typeof n.height !== "number") return null;
  const [a, b, tx] = t[0] as [number, number, number];
  const [c, d, ty] = t[1] as [number, number, number];
  return { x: a * n.width / 2 + b * n.height / 2 + tx, y: c * n.width / 2 + d * n.height / 2 + ty };
}

/**
 * The transform of `node` turned to `angle` degrees about its centre, as ONE
 * matrix: rotation, then x, then y were three rewrites of it [C-186], the
 * pattern that lost x on 2026-10-09 [C-203]. Only a plain turn is rebuilt —
 * Figma's own setter rewrites the 2×2 part [C-098], and what it keeps of a
 * mirror is not documented — so a mirrored node, or one without a readable
 * matrix and size, gets null and the setter.
 */
function turnedAboutCentre(node: NodeLikeW, angle: number): Matrix | null {
  const n = node as unknown as { relativeTransform?: unknown; width?: number; height?: number };
  const m = n.relativeTransform;
  if (!isMatrix(m) || typeof n.width !== "number" || typeof n.height !== "number") return null;
  const [[a, b, tx], [c, d, ty]] = m;
  if (Math.abs(a * d - b * c - 1) > 1e-4 || Math.abs(a - d) > 1e-4 || Math.abs(b + c) > 1e-4) return null;
  const rad = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const [hw, hh] = [n.width / 2, n.height / 2];
  // The centre stays where it is: new translation = old centre − the turned half-size.
  const cx = a * hw + b * hh + tx;
  const cy = c * hw + d * hh + ty;
  return [[cos, sin, cx - (cos * hw + sin * hh)], [-sin, cos, cy - (-sin * hw + cos * hh)]];
}

/** Degrees apart on the circle: Figma reads rotation back in -180..180. */
const turnGap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const r2 = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : "unreadable");

/** Null when `id` reads back turned to `angle` — and, after a centre turn, at `at`; else what Figma kept. */
async function missedTurn(id: string, angle: number, at: { x: number; y: number } | undefined): Promise<string | null> {
  const now = (await api().getNodeByIdAsync(id)) as unknown as { rotation?: unknown; x?: unknown; y?: unknown } | null;
  if (!now) return "it could not be read back after the write";
  const turned = typeof now.rotation === "number" && turnGap(now.rotation, angle) <= 0.01;
  const near = (got: unknown, want: number) => typeof got === "number" && Math.abs(got - want) <= placementTolerance(want);
  if (turned && (!at || (near(now.x, at.x) && near(now.y, at.y)))) return null;
  return `Figma kept it at rotation ${r2(now.rotation)}, x ${r2(now.x)}, y ${r2(now.y)} (asked rotation ${angle}${at ? `, x ${r2(at.x)}, y ${r2(at.y)}` : ""})`;
}

/**
 * figma_rotate_nodes. Figma's `rotation` turns a node about its top-left
 * corner [C-098], so a card rotated 45 degrees swings away from where it
 * stood. The editor turns about the centre, and so does `pivot: "center"` (the
 * default): the turn and the drift back go in one matrix write. Inside an
 * auto-layout the layout computes the translation itself [C-098] — that item
 * reports `pivot: "layout"`. Each item is read back: ok means it landed [C-250].
 */
const rotateNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { ids, angle, pivot } = await beforeMutating(() => {
      const ids = requireIds(ctx);
      const angle = num(ctx.params, "angle");
      if (angle === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`angle` is required (degrees).");
      const pivot = (str(ctx.params, "pivot") ?? "center").toLowerCase();
      if (pivot !== "center" && pivot !== "origin") throw new BridgeError(ErrorCode.INVALID_PARAM, "`pivot` must be center or origin.");
      return { ids, angle, pivot };
    });
    const items: Array<ItemResult & { pivot?: string }> = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const r = node as unknown as Placeable & { rotation?: number; x: number; y: number; layoutPositioning?: string };
      if (typeof r.rotation !== "number") {
        items.push({ id, ok: false, error: `a ${node.type} has no rotation` });
        continue;
      }
      try {
        const layoutOwned = inAutoLayout(node) && r.layoutPositioning !== "ABSOLUTE";
        const turned = pivot === "center" && !layoutOwned ? turnedAboutCentre(node, angle) : null;
        let at: { x: number; y: number } | undefined;
        if (turned) {
          r.relativeTransform = turned;
          at = { x: turned[0][2], y: turned[1][2] };
        } else {
          // Pivot origin, a child its auto-layout places, or a mirrored node: Figma's own
          // setter turns it, and a centre turn moves the drift back in one more write.
          const from = pivot === "center" && !layoutOwned ? centre(node) : null;
          r.rotation = angle;
          const to = from ? centre(node) : null;
          if (from && to) {
            at = { x: r.x + from.x - to.x, y: r.y + from.y - to.y };
            place(r, at.x, at.y);
          }
        }
        const miss = await missedTurn(id, angle, at);
        if (miss) {
          items.push({ id, ok: false, error: `${miss}. Read it back with figma_get_nodes_info` });
          continue;
        }
        items.push({ id, ok: true, pivot: layoutOwned && pivot === "center" ? "layout" : at ? "center" : "origin" });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ rotated: items.filter((i) => i.ok).length, items });
  },
};

const POSITIONS = new Set(["front", "back", "forward", "backward"]);

const reorderNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { ids, position } = await beforeMutating(() => {
      const ids = requireIds(ctx);
      const position = ctx.params.position;
      if (position === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`position` is required.");
      // Checked once for the call, not per node: a typo is the caller's, not a node's.
      const isIndex = typeof position === "number" ? Number.isInteger(position) : typeof position === "string" && /^\d+$/.test(position.trim());
      if (!isIndex && !POSITIONS.has(String(position))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `unknown position "${String(position)}": use front, back, forward, backward or an index.`);
      }
      return { ids, position };
    });
    const items: ItemResult[] = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (DECK_TYPES.has(node.type)) {
        items.push({ id, ok: false, error: DECK_PLACED(node.type) });
        continue;
      }
      const parent = node.parent as unknown as {
        insertChild?: (i: number, n: NodeLikeW) => void;
        children?: readonly NodeLikeW[];
      } | null;
      if (!parent?.insertChild || !parent.children) {
        items.push({ id, ok: false, error: "has no parent that can reorder it" });
        continue;
      }
      const idx = parent.children.findIndex((c) => c.id === node.id);
      let target: number;
      // The MCP schema sends the index as a string ("3"; params.ts positionParam).
      const asIndex = typeof position === "number" ? position : typeof position === "string" && /^\d+$/.test(position.trim()) ? Number(position) : NaN;
      if (Number.isInteger(asIndex)) target = Math.max(0, Math.min(parent.children.length - 1, asIndex));
      else if (position === "front") target = parent.children.length - 1;
      else if (position === "back") target = 0;
      else if (position === "forward") target = Math.min(parent.children.length - 1, idx + 1);
      else if (position === "backward") target = Math.max(0, idx - 1);
      else {
        items.push({ id, ok: false, error: `unknown position "${position}"` });
        continue;
      }
      try {
        // insertChild takes the index in the CURRENT list; removing first keeps
        // the arithmetic honest when moving forward.
        parent.insertChild(target, node);
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ reordered: items.filter((i) => i.ok).length, items });
  },
};

const setAutoLayout: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    // Every parameter is checked before the frame changes: the server accepted
    // alignX / alignY / wrap and string padding long before this op read them,
    // so they used to be dropped without a word.
    const p = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: TEMPORARY_ID_HINT });
      const frame = node as unknown as FrameLike;
      if (!has(frame, "layoutMode")) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${node.type} does not support auto-layout.`);
      }
      const modeArg = str(ctx.params, "mode")?.toLowerCase();
      const MODES: Record<string, string> = { none: "NONE", horizontal: "HORIZONTAL", vertical: "VERTICAL" };
      if (modeArg !== undefined && !(modeArg in MODES)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`mode` must be horizontal, vertical or none.");
      }
      const layoutMode = modeArg !== undefined ? MODES[modeArg]! : frame.layoutMode ?? "NONE";
      const pad = normalizePadding(ctx.params.padding);
      const align = alignmentFor(layoutMode, ctx.params.alignX, ctx.params.alignY);
      const sizing = (key: string): string | undefined => {
        const v = str(ctx.params, key)?.toLowerCase();
        if (v === undefined) return undefined;
        if (v !== "hug" && v !== "fixed") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` must be hug or fixed.`);
        return v === "hug" ? "AUTO" : "FIXED";
      };
      const primary = sizing("primarySizing");
      const counter = sizing("counterSizing");
      const wrap = ctx.params.wrap;
      if (wrap !== undefined && typeof wrap !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`wrap` must be true or false.");
      if (wrap === true && layoutMode !== "HORIZONTAL") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`wrap` works on a horizontal auto-layout only.");
      }
      const gap = ctx.params.gap;
      if (gap !== undefined && (typeof gap !== "number" || !Number.isFinite(gap))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`gap` must be a number (negative overlaps the items, e.g. an avatar stack).");
      }
      const flags: Partial<Record<"strokesIncludedInLayout" | "itemReverseZIndex", boolean>> = {};
      for (const [param, prop] of [["strokesInLayout", "strokesIncludedInLayout"], ["reverseZIndex", "itemReverseZIndex"]] as const) {
        const v = ctx.params[param];
        if (v === undefined) continue;
        if (typeof v !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${param}\` must be true or false.`);
        flags[prop] = v;
      }
      const auto = layoutMode !== "NONE";
      const wrapsAfter = wrap === true || (wrap === undefined && layoutMode === "HORIZONTAL" && frame.layoutWrap === "WRAP");
      const wrapping = wrapFields(ctx.params, auto && wrapsAfter);
      if (!auto && (pad || gap !== undefined || primary || counter || wrap !== undefined || Object.keys(flags).length)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Gap, padding, sizing, wrap and the stacking options need auto-layout: set `mode` to horizontal or vertical.");
      }
      return { node, frame, layoutMode, pad, align, primary, counter, wrap, gap: gap as number | undefined, flags, wrapping };
    });
    const { node, frame, wrap } = p;

    const turnedOn = wrap === true && frame.layoutWrap !== "WRAP";
    frame.layoutMode = p.layoutMode;
    if (p.gap !== undefined) frame.itemSpacing = p.gap;
    if (p.pad) {
      frame.paddingTop = p.pad[0];
      frame.paddingRight = p.pad[1];
      frame.paddingBottom = p.pad[2];
      frame.paddingLeft = p.pad[3];
    }
    Object.assign(frame, p.align);
    if (wrap !== undefined) frame.layoutWrap = wrap ? "WRAP" : "NO_WRAP";
    // After layoutWrap: the wrap-only fields throw on a frame that does not wrap yet.
    const rowGapNote = frame.layoutWrap === "WRAP" ? applyWrapFields(frame, p.wrapping, turnedOn) : undefined;
    if (p.primary) frame.primaryAxisSizingMode = p.primary;
    if (p.counter) frame.counterAxisSizingMode = p.counter;
    Object.assign(frame, p.flags);
    const f = frame as FrameLike & { counterAxisSpacing?: number | null; counterAxisAlignContent?: string; strokesIncludedInLayout?: boolean; itemReverseZIndex?: boolean };
    return {
      id: node.id,
      layoutMode: frame.layoutMode,
      itemSpacing: frame.itemSpacing,
      padding: [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft],
      primaryAxisAlignItems: frame.primaryAxisAlignItems,
      counterAxisAlignItems: frame.counterAxisAlignItems,
      layoutWrap: frame.layoutWrap,
      ...(frame.layoutWrap === "WRAP" ? { counterAxisSpacing: f.counterAxisSpacing, counterAxisAlignContent: f.counterAxisAlignContent } : {}),
      ...(rowGapNote ? { rowGap: rowGapNote } : {}),
      ...(f.strokesIncludedInLayout !== undefined ? { strokesIncludedInLayout: f.strokesIncludedInLayout } : {}),
      ...(f.itemReverseZIndex !== undefined ? { itemReverseZIndex: f.itemReverseZIndex } : {}),
    };
  },
};

/** One text find_replace_text may change: a TEXT, a board node's sublayer, a table cell, or a code block's code. */
interface FoundText {
  owner: NodeLikeW;
  target: TextTarget;
  /** A table cell, "row,column": cells have no id of their own (d.ts:11442). */
  cell?: string;
}

/** Every text `node` holds — a TABLE holds one per cell [C-135]. Code only when asked. */
function textsOf(node: NodeLikeW, includeCode: boolean): FoundText[] {
  if (node.type === "TABLE") {
    const t = node as unknown as { numRows?: number; numColumns?: number; cellAt?(r: number, c: number): { text?: TextHolder } };
    const out: FoundText[] = [];
    if (typeof t.cellAt !== "function") return out;
    for (let r = 0; r < (t.numRows ?? 0); r++) {
      for (let c = 0; c < (t.numColumns ?? 0); c++) {
        const text = tryGet<TextHolder | undefined>(t.cellAt(r, c), "text");
        if (text.ok && text.value) out.push({ owner: node, target: { kind: "sublayer", owner: node, target: text.value }, cell: `${r},${c}` });
      }
    }
    return out;
  }
  if (node.type === "CODE_BLOCK" && !includeCode) return [];
  const target = textTarget(node);
  return target ? [{ owner: node, target }] : [];
}

/**
 * Each occurrence of the search in `chars`, with the text that replaces it.
 * A regex keeps its own replacement grammar ($1, $&): each match is replaced
 * where it stands in the whole string, so anchors and lookbehinds see what
 * they saw. A plain `find` is replaced literally.
 */
function occurrences(chars: string, find: string, replace: string, re: RegExp | null, caseSensitive: boolean): Array<{ start: number; end: number; text: string }> {
  const pattern = re ?? new RegExp(escapeRe(find), caseSensitive ? "g" : "gi");
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const one = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}y`);
  const out: Array<{ start: number; end: number; text: string }> = [];
  // exec, not matchAll: the bundle targets ES2017 and no other sandbox code leans on ES2020's library.
  for (let m = global.exec(chars); m; m = global.exec(chars)) {
    if (m[0] === "") global.lastIndex++; // an empty match would match again in place
    const start = m.index;
    const end = start + m[0].length;
    let text = replace;
    if (re) {
      one.lastIndex = start;
      const whole = chars.replace(one, replace);
      text = whole.slice(start, whole.length - (chars.length - end));
    }
    out.push({ start, end, text });
  }
  return out;
}

/**
 * Replace the occurrences right to left with insertCharacters /
 * deleteCharacters, which keep every other run's style (d.ts:9796-9818;
 * edit-text.md:285-354) — writing `characters` gives the whole text the first
 * character's style. The new text takes the style of the text it replaces.
 */
function replaceIn(t: TextHolder, hits: ReadonlyArray<{ start: number; end: number; text: string }>, next: string): void {
  const r = t as TextHolder & { insertCharacters?(s: number, c: string, use?: "BEFORE" | "AFTER"): void; deleteCharacters?(s: number, e: number): void };
  if (typeof r.insertCharacters !== "function" || typeof r.deleteCharacters !== "function") {
    t.characters = next;
    return;
  }
  for (const h of [...hits].reverse()) {
    if (h.text) r.insertCharacters(h.start, h.text, "AFTER");
    if (h.end > h.start) r.deleteCharacters(h.start + h.text.length, h.end + h.text.length);
  }
}

/**
 * figma_find_replace_text. On a board most copy is not in TEXT nodes: it is
 * in stickies, shapes, connector labels and table cells [C-135], and a code
 * block's code when `includeCode` asks for it. An item names the node that
 * holds the text, plus `cell` for a table.
 */
const findReplaceText: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { find, replace, caseSensitive, re, root, includeCode } = await beforeMutating(async () => {
      const find = str(ctx.params, "find");
      const replace = typeof ctx.params.replace === "string" ? ctx.params.replace : undefined;
      if (find === undefined || replace === undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`find` and `replace` are required.");
      }
      const includeCode = ctx.params.includeCode;
      if (includeCode !== undefined && typeof includeCode !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`includeCode` must be true or false.");
      const caseSensitive = ctx.params.caseSensitive !== false;
      const useRegex = ctx.params.regex === true;
      let re: RegExp | null = null;
      if (useRegex) {
        try {
          re = new RegExp(find, caseSensitive ? "g" : "gi");
        } catch (err) {
          throw new BridgeError(
            ErrorCode.INVALID_PARAM,
            `\`find\` is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { find, replace, caseSensitive, re, root: await scopeFor(figma, ctx), includeCode: includeCode === true };
    });
    const items: Array<ItemResult & { changed?: number; type?: string; cell?: string }> = [];
    const found: FoundText[] = [];
    await walkNames(figma, root, ctx, (node) => {
      found.push(...textsOf(node, includeCode));
    });

    for (const f of found) {
      const label = { id: f.owner.id, ...(f.owner.type !== "TEXT" ? { type: f.owner.type } : {}), ...(f.cell ? { cell: f.cell } : {}) };
      const holder = f.target.target as TextHolder & CodeHolder;
      const chars = f.target.kind === "code" ? holder.code : holder.characters;
      if (typeof chars !== "string") continue;
      const hits = occurrences(chars, find, replace, re, caseSensitive);
      if (!hits.length) continue;
      let next = chars;
      for (const h of [...hits].reverse()) next = next.slice(0, h.start) + h.text + next.slice(h.end);
      if (next === chars) continue; // matched, but replacing changes nothing: no write, no item
      try {
        if (f.target.kind === "code") {
          holder.code = next;
        } else {
          if (f.target.kind === "sublayer") await loadTextFonts(f.target, figma);
          else {
            const fonts = fontsOf(holder);
            if (fonts.length) for (const font of fonts) await figma.loadFontAsync(font);
            else {
              // No font readable at all: the old fallback, which replaces the font — reported.
              const loaded = await loadFont(figma);
              (holder as unknown as { fontName: unknown }).fontName = { family: loaded.family, style: loaded.style };
            }
          }
          replaceIn(holder, hits, next);
        }
        items.push({ ...label, ok: true, changed: hits.length });
      } catch (err) {
        items.push({ ...label, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { replacedIn: items.filter((i) => i.ok).length, items };
  },
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── structure: ungroup, constraints, undo ───────────────────────────────────

const ungroupNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api() as unknown as { ungroup?: (n: NodeLikeW) => NodeLikeW[] };
    const ids = await beforeMutating(() => {
      if (typeof figma.ungroup !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot ungroup.");
      return requireIds(ctx);
    });
    const ungroup = figma.ungroup!;
    const items: Array<ItemResult & { childIds?: string[] }> = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (node.type !== "GROUP") {
        items.push({ id, ok: false, error: `a ${node.type} is not a group (figma_reparent_nodes moves children out of a frame)` });
        continue;
      }
      try {
        const kids = ungroup.call(figma, node);
        items.push({ id, ok: true, childIds: kids.map((k) => k.id) });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ ungrouped: items.filter((i) => i.ok).length, items });
  },
};

/** Figma's ConstraintType (typings 1.141.0) plus the words a designer would use. */
const CONSTRAINT: Record<"horizontal" | "vertical", Record<string, string>> = {
  horizontal: { left: "MIN", right: "MAX", center: "CENTER", "left-right": "STRETCH", scale: "SCALE" },
  vertical: { top: "MIN", bottom: "MAX", center: "CENTER", "top-bottom": "STRETCH", scale: "SCALE" },
};

function constraintValue(axis: "horizontal" | "vertical", raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const v = typeof raw === "string" ? raw.trim() : "";
  const upper = v.toUpperCase();
  if (["MIN", "MAX", "CENTER", "STRETCH", "SCALE"].includes(upper)) return upper;
  const mapped = CONSTRAINT[axis][v.toLowerCase()];
  if (mapped) return mapped;
  throw new BridgeError(
    ErrorCode.INVALID_PARAM,
    `\`${axis}\` must be ${Object.keys(CONSTRAINT[axis]).join(", ")} (or MIN, MAX, CENTER, STRETCH, SCALE).`,
  );
}

const setConstraints: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { ids, horizontal, vertical } = await beforeMutating(() => {
      const horizontal = constraintValue("horizontal", ctx.params.horizontal);
      const vertical = constraintValue("vertical", ctx.params.vertical);
      if (!horizontal && !vertical) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `horizontal`, `vertical`, or both.");
      return { ids: requireIds(ctx), horizontal, vertical };
    });
    const items: ItemResult[] = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const c = node as unknown as { constraints?: { horizontal: string; vertical: string } };
      if (!c.constraints) {
        items.push({ id, ok: false, error: `a ${node.type} has no constraints` });
        continue;
      }
      try {
        // Constraints is a read-only object: assign a whole new one.
        c.constraints = { horizontal: horizontal ?? c.constraints.horizontal, vertical: vertical ?? c.constraints.vertical };
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return withMissHint({ updated: items.filter((i) => i.ok).length, items });
  },
};

export const UNDO_WARNING =
  "figma.triggerUndo() returns to the last commitUndo checkpoint: anything the user changed by hand since the last " +
  "tool call was reverted too [C-024]. figma_delete_nodes with the ids a create returned is the safe way to undo agent work.";

/**
 * figma_undo_step (spec §5.6.1). Not a write op for code.ts: committing an undo
 * checkpoint right after triggerUndo() would be a write of its own. A retry with
 * the same idempotencyKey still replays instead of undoing twice.
 */
const undoStep: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    if (ctx.params.confirm !== true) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`confirm` must be true.", { hint: UNDO_WARNING });
    }
    const raw = ctx.params.count ?? 1;
    const count = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new BridgeError(ErrorCode.INVALID_PARAM, "`count` must be a whole number from 1 to 20.");
    const figma = api() as unknown as { triggerUndo?: () => void };
    if (typeof figma.triggerUndo !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot undo.");
    for (let i = 0; i < count; i++) figma.triggerUndo();
    return { undone: count, warning: UNDO_WARNING };
  },
};

export const MODIFY_OPS: Record<string, PluginOp> = {
  ungroup_nodes: ungroupNodes,
  set_constraints: setConstraints,
  undo_step: undoStep,
  set_text: setText,
  find_replace_text: findReplaceText,
  rename_node: renameNode,
  batch_rename_nodes: batchRename,
  move_nodes: moveNodes,
  resize_nodes: resizeNodes,
  rotate_nodes: rotateNodes,
  reorder_nodes: reorderNodes,
  reparent_nodes: reparentNodes,
  clone_node: cloneNode,
  delete_nodes: deleteNodes,
  group_nodes: groupNodes,
  set_visible: setVisible,
  set_locked: setLocked,
  set_opacity: setOpacity,
  set_auto_layout: setAutoLayout,
};

/**
 * Modify ops new with the parity work, kept out of MODIFY_OPS until the
 * catalog (shared/ops.ts) lists them: the plugin advertises every op it holds,
 * and an advertised op the catalog does not know is a test failure by design.
 * The integrator spreads this next to MODIFY_OPS in ops/index.ts.
 */
export const LAYOUT_OPS: Record<string, PluginOp> = {
  set_clips_content: setClipsContent,
};

export { weightToStyle };
