// FigJam node builders, shared by the board tools (ops/figjam.ts) and the
// create_from_spec types (figjam/spec-types.ts), so a sticky built by either
// path is the same sticky.
//
// Each node type is two halves:
//   parse*  pure checks of one item, run for every item BEFORE the first node
//           exists; a refusal names its field (`partial.failedAt`) and says
//           nothing changed (`partial.created: []`) [C-096];
//   build*  create, record, append into the FINAL parent, then write — a
//           connector must sit in its final parent before its ends are set,
//           because a reparented connector keeps stale elbows [C-149], and a
//           node positioned before its append lands in the wrong frame
//           (position-figjam-nodes.md:56-62).
//
// Every create API used here is FigJam-only in the typings [C-132]; each op
// checks the member exists before anything else (requireApi), a backstop to
// the editor gate. Node shapes follow @figma/plugin-typings 1.141.0 [C-135].
// Structural types only (no plugin typings), so the tests import it as it is.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import {
  FIGJAM_TEXT_DEFAULT,
  parseCodeLanguage,
  parseEndpoint,
  parseLineType,
  parseShapeType,
  parseStrokeCap,
  type CodeLanguage,
  type ConnectorEndpoint,
  type LineType,
  type ParsedEndpoint,
  type ShapeType,
  type StrokeCap,
} from "../../shared/figjam.js";
import { placeGrid } from "../../shared/grid-layout.js";
import { CancelledError, createPacer } from "../chunk.js";
import { unchanged } from "../guard.js";
import type { OpContext } from "../ops/index.js";
import { apiHas, figmaGlobal, tryGet } from "../safe.js";
import { CONNECTOR_LABEL_FONT, fontsOf, loadTextFonts, textTarget, type FontNameLike, type TextHolder } from "../sublayer.js";
import { nearest, parseColor, type NodeLikeW, type SolidPaint } from "../write.js";
import { resolveColor, resolveShapeColor, resolveTableColor } from "./palette.js";

type Any = Record<string, unknown>;

export const MAX_ITEMS = 200;
export const MAX_TEXT = 10_000;
export const MAX_CODE = 50_000;

/** FigJam's default text font, on sticky, shape and table text alike [C-147]. */
export const FIGJAM_FONT: FontNameLike = { family: "Inter", style: "Medium" };

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const isObject = (v: unknown): v is Any => typeof v === "object" && v !== null && !Array.isArray(v);

// ── refusals ─────────────────────────────────────────────────────────────────

/** A refusal before the first node exists, naming the field it is about. */
export function refuse(path: string, message: string, hint?: string, code: ErrorCode = ErrorCode.INVALID_PARAM): never {
  throw new BridgeError(code, message, { ...(hint ? { hint } : {}), partial: { created: [], failedAt: path } });
}

/** The field a refusal names, if it names one. */
export function failedAtOf(err: unknown): string | undefined {
  const at = err instanceof BridgeError ? (err.partial as { failedAt?: unknown } | undefined)?.failedAt : undefined;
  return typeof at === "string" ? at : undefined;
}

function named(err: unknown, path: string): never {
  if (err instanceof BridgeError && failedAtOf(err) === undefined) {
    throw new BridgeError(err.code, err.message, { ...(err.hint ? { hint: err.hint } : {}), partial: { created: [], failedAt: path } });
  }
  throw err;
}

/** Run a shared parser (shared/figjam.ts, palette.ts) for `path`, so its refusal names that field. */
export function at<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    return named(err, path);
  }
}

export async function atAsync<T>(path: string, parse: () => Promise<T>): Promise<T> {
  try {
    return await parse();
  } catch (err) {
    return named(err, path);
  }
}

/**
 * guard.ts beforeMutating, keeping the field a refusal names: "stickies[3].color"
 * tells the agent which of 200 items to fix.
 */
export async function beforeBoard<T>(prepare: () => T | Promise<T>): Promise<T> {
  try {
    return await prepare();
  } catch (err) {
    const path = failedAtOf(err);
    if (path !== undefined && err instanceof BridgeError) {
      throw new BridgeError(err.code, err.message, { ...(err.hint ? { hint: err.hint } : {}), partial: { created: [], failedAt: path } });
    }
    return unchanged(err);
  }
}

/**
 * A failure once nodes exist. No rollback, by design (write.ts): one call is
 * one undo step, so the ids made so far and where it stopped are reported.
 */
export function midway(err: unknown, created: readonly string[], failedAt: string): BridgeError {
  const code = err instanceof CancelledError ? ErrorCode.CANCELLED : err instanceof BridgeError ? err.code : ErrorCode.INTERNAL;
  const cause = err instanceof BridgeError && err.hint ? `${err.hint} ` : "";
  return new BridgeError(code, msg(err), {
    hint: created.length
      ? `${cause}${created.length} node(s) were created before it stopped (ids in partial.created). Press Ctrl+Z to undo the whole call, delete them with figma_delete_nodes, or continue from partial.failedAt.`
      : `${cause}Nothing was created.`,
    partial: { created: [...created], failedAt },
  });
}

// ── field readers ────────────────────────────────────────────────────────────

export function objectAt(raw: unknown, path: string): Any {
  if (!isObject(raw)) refuse(path, `\`${path}\` must be an object.`);
  return raw;
}

/** Refuse a key `allowed` does not list, with the nearest names (or a hint written for that key). */
export function onlyKeys(o: Any, allowed: readonly string[], path: string, hints: Readonly<Record<string, string>> = {}): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    refuse(join(path, k), `\`${join(path, k)}\` is not a field here.`, hints[k] ?? `Fields: ${nearest(k, allowed, allowed.length).join(", ")}.`);
  }
}

export function list(raw: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) refuse(path, `\`${path}\` must be an array of ${min}–${max} items.`);
  return raw;
}

export function optString(o: Any, key: string, path: string, max = MAX_TEXT): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") refuse(join(path, key), `\`${join(path, key)}\` must be text.`);
  if (v.length > max) refuse(join(path, key), `\`${join(path, key)}\` is ${v.length} characters; at most ${max}.`);
  return v;
}

export function optBool(o: Any, key: string, path: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") refuse(join(path, key), `\`${join(path, key)}\` must be true or false.`);
  return v;
}

export interface NumberRule {
  min?: number;
  max?: number;
  int?: boolean;
  /** min is exclusive: > min rather than >= min. */
  above?: boolean;
}

export function optNumber(o: Any, key: string, path: string, rule: NumberRule = {}): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  const at = join(path, key);
  if (typeof v !== "number" || !Number.isFinite(v)) refuse(at, `\`${at}\` must be a number.`);
  if (rule.int && !Number.isInteger(v)) refuse(at, `\`${at}\` must be a whole number.`);
  if (rule.min !== undefined && (rule.above ? v <= rule.min : v < rule.min)) refuse(at, `\`${at}\` must be ${rule.above ? ">" : ">="} ${rule.min}.`);
  if (rule.max !== undefined && v > rule.max) refuse(at, `\`${at}\` must be <= ${rule.max}.`);
  return v;
}

// ── the API and fonts ────────────────────────────────────────────────────────

/** The members of the figma global the board tools use. */
export interface BoardApi {
  currentPage: NodeLikeW;
  loadFontAsync(font: FontNameLike): Promise<void>;
  getNodeByIdAsync(id: string): Promise<NodeLikeW | null>;
  createSticky(): NodeLikeW;
  createShapeWithText(): NodeLikeW;
  createConnector(): NodeLikeW;
  createTable(numRows?: number, numColumns?: number): NodeLikeW;
  createCodeBlock(): NodeLikeW;
  createText(): NodeLikeW;
  createLinkPreviewAsync(url: string): Promise<NodeLikeW>;
}

export const board = (): BoardApi => figmaGlobal() as BoardApi;

/**
 * UNSUPPORTED naming the member, when this file's editor lacks it: the
 * backstop to the editor gate for a hub that has none [C-132]. apiHas reads
 * through safe.ts, because touching a missing member may throw [C-145].
 */
export function requireApi(member: string, what: string): void {
  if (apiHas(member)) return;
  throw new BridgeError(ErrorCode.UNSUPPORTED, `This file's editor has no figma.${member}, so it cannot ${what}.`, {
    hint: "Open a FigJam board and run the plugin there.",
  });
}

/** Load each font once per call; a font that will not load is FONT_LOAD_FAILED naming it. */
export class FontCache {
  private readonly loaded = new Set<string>();
  constructor(private readonly loader: { loadFontAsync(font: FontNameLike): Promise<void> }) {}
  async load(font: FontNameLike): Promise<void> {
    const key = `${font.family}\u0000${font.style}`;
    if (this.loaded.has(key)) return;
    try {
      await this.loader.loadFontAsync({ family: font.family, style: font.style });
    } catch (err) {
      throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `"${font.family} ${font.style}" did not load: ${msg(err)}`, {
        hint: "figma_get_fonts lists the fonts this Figma can load.",
      });
    }
    this.loaded.add(key);
  }
}

/**
 * What a builder needs from its caller — the shape of spec-types.ts SpecBuild,
 * so the spec handlers pass theirs straight through.
 */
export interface Make {
  /** Report the node the moment it exists, before its first write. */
  record<T extends NodeLikeW>(node: T): T;
  append(parent: NodeLikeW, child: NodeLikeW): void;
  loadFont(font: FontNameLike): Promise<void>;
  yieldToHost(): Promise<void>;
}

/** The Make an op uses: ids go into `created` as nodes appear. */
export function opMake(created: string[], fonts: FontCache, ctx: Pick<OpContext, "yieldToHost">, appendFn: (p: NodeLikeW, c: NodeLikeW) => void): Make {
  return {
    record: (node) => {
      created.push(node.id);
      return node;
    },
    append: appendFn,
    loadFont: (font) => fonts.load(font),
    yieldToHost: () => ctx.yieldToHost(),
  };
}

/** createPacer plus a cancel check per item: a cancel arrives between items, not only after a slice yields. */
export function pacer(ctx: Pick<OpContext, "yieldToHost" | "progress" | "isCancelled">, total: number, phase: string): { tick(): Promise<void> } {
  const p = createPacer(total, {
    yieldToHost: ctx.yieldToHost,
    onProgress: (done, all) => ctx.progress(done, all, phase),
    isCancelled: ctx.isCancelled,
  });
  return {
    async tick() {
      await p.tick();
      if (ctx.isCancelled()) throw new CancelledError(p.done);
    },
  };
}

/** The text sublayer of a STICKY, SHAPE_WITH_TEXT or CONNECTOR, or of a table cell. */
export function sublayer(owner: unknown, what: string): TextHolder & Any {
  const t = tryGet<TextHolder & Any>(owner, "text");
  if (!t.ok || !t.value) throw new BridgeError(ErrorCode.INTERNAL, `The ${what} has no readable text sublayer: ${t.ok ? "it is empty" : t.message}`);
  return t.value;
}

/**
 * Load what a sublayer's text needs, then write it. A sublayer whose font
 * cannot be read gets FigJam's default first, so the write never runs on an
 * unloaded font.
 */
export async function writeSublayer(target: TextHolder & Any, text: string, m: Pick<Make, "loadFont">): Promise<void> {
  const fonts = fontsOf(target);
  if (fonts.length === 0) {
    await m.loadFont(FIGJAM_FONT);
    target.fontName = { ...FIGJAM_FONT };
  } else {
    for (const f of fonts) await m.loadFont(f);
  }
  target.characters = text;
}

/**
 * Load the fonts a sublayer already uses, before a write that keeps its
 * characters — its `fills`: the official recipe loads the cell font before
 * setting text.fills as well as text.characters (create-table.md:244) [C-163].
 */
export async function loadSublayer(target: TextHolder, m: Pick<Make, "loadFont">): Promise<void> {
  for (const f of fontsOf(target)) await m.loadFont(f);
}

const setName = (node: NodeLikeW, name: string | undefined) => {
  if (name !== undefined) node.name = name;
};

// ── stickies ─────────────────────────────────────────────────────────────────

export interface StickySpec {
  text: string;
  fill?: SolidPaint;
  wide?: boolean;
  authorVisible?: boolean;
  name?: string;
}

export interface ParseOptions {
  /** The field holding the text: `text` in the tools, `content` in a spec. */
  textKey: string;
  /** Keys an item may carry; null when the caller (the spec builder) already checked them. */
  allowed: readonly string[] | null;
}

const STICKY_SIZE_HINT = "A sticky is 240 wide (416 with `wide: true`, for about 100 words or more) and grows taller with its text; it cannot be resized.";

export function parseSticky(raw: unknown, path: string, opts: ParseOptions): StickySpec {
  const o = objectAt(raw, path);
  // The typings give a sticky a constant size and no resize (d.ts:1226) [C-147].
  for (const k of ["width", "height"]) if (k in o) refuse(join(path, k), `\`${join(path, k)}\`: a sticky's size is not set.`, STICKY_SIZE_HINT);
  if (opts.allowed) onlyKeys(o, opts.allowed, path);
  const text = o[opts.textKey];
  if (typeof text !== "string") refuse(join(path, opts.textKey), `\`${join(path, opts.textKey)}\` must be text (the sticky's content).`);
  optString(o, opts.textKey, path);
  const spec: StickySpec = { text };
  if (o.color !== undefined) spec.fill = at(join(path, "color"), () => resolveColor("sticky", o.color, join(path, "color")).paint);
  const wide = optBool(o, "wide", path);
  if (wide !== undefined) spec.wide = wide;
  const author = optBool(o, "authorVisible", path);
  if (author !== undefined) spec.authorVisible = author;
  const name = optString(o, "name", path);
  if (name !== undefined) spec.name = name;
  return spec;
}

export async function buildSticky(s: StickySpec, parent: NodeLikeW, m: Make): Promise<NodeLikeW> {
  const node = m.record(board().createSticky());
  m.append(parent, node);
  const n = node as unknown as Any;
  setName(node, s.name);
  if (s.wide !== undefined) n.isWideWidth = s.wide;
  if (s.authorVisible !== undefined) n.authorVisible = s.authorVisible;
  if (s.fill) n.fills = [s.fill];
  await writeSublayer(sublayer(node, "sticky"), s.text, m);
  return node;
}

// ── shapes with text ─────────────────────────────────────────────────────────

export interface ShapeSpec {
  type: ShapeType;
  /** A 1–2 character ELLIPSE marker at a fixed size (create-label.md:11-43) [C-163]. */
  label: boolean;
  text: string;
  fill?: SolidPaint;
  stroke?: SolidPaint;
  textFill?: SolidPaint;
  size?: { w: number; h: number };
  fontSize?: number;
  name?: string;
}

/** Label sizes by character count, and the label font size [C-163]. */
export const LABEL_SIZE: Readonly<Record<number, number>> = { 1: 48, 2: 64 };
export const LABEL_FONT_SIZE = 20;

export function parseShape(raw: unknown, path: string, opts: ParseOptions): ShapeSpec {
  const o = objectAt(raw, path);
  if (opts.allowed) onlyKeys(o, opts.allowed, path);
  const kind = o.shape;
  if (typeof kind !== "string" || !kind.trim()) refuse(join(path, "shape"), `\`${join(path, "shape")}\` is required: a FigJam shape type, or "label".`);
  const label = kind.trim().toLowerCase() === "label";
  const type: ShapeType = label ? "ELLIPSE" : at(join(path, "shape"), () => parseShapeType(kind, join(path, "shape")));
  const text = o[opts.textKey];
  if (typeof text !== "string") refuse(join(path, opts.textKey), `\`${join(path, opts.textKey)}\` must be text (all of it goes in the shape).`);
  optString(o, opts.textKey, path);
  const spec: ShapeSpec = { type, label, text };

  if (label) {
    const chars = Array.from(text).length;
    if (chars < 1 || chars > 2) {
      refuse(join(path, opts.textKey), `A label holds 1 or 2 characters (a number or a letter); \`${join(path, opts.textKey)}\` has ${chars}.`, "For a word or a phrase use a shape such as \"rounded-rectangle\".");
    }
    for (const k of ["width", "height"]) if (k in o) refuse(join(path, k), `\`${join(path, k)}\`: a label's size follows its characters (48 or 64 px).`);
  }

  const has = (k: string) => o[k] !== undefined;
  if (has("color") && (has("fill") || has("stroke") || has("textColor"))) {
    refuse(join(path, "color"), `\`${join(path, "color")}\` is a preset that sets fill, stroke and text together; give it or \`fill\` / \`stroke\` / \`textColor\`, not both.`);
  }
  if (has("color")) {
    const c = at(join(path, "color"), () => resolveShapeColor(o.color, join(path, "color")));
    spec.fill = c.fill;
    if (c.stroke) spec.stroke = c.stroke;
    if (c.text) spec.textFill = c.text;
  }
  if (has("fill")) spec.fill = at(join(path, "fill"), () => parseColor(o.fill, join(path, "fill")));
  if (has("stroke")) spec.stroke = at(join(path, "stroke"), () => parseColor(o.stroke, join(path, "stroke")));
  if (has("textColor")) spec.textFill = at(join(path, "textColor"), () => parseColor(o.textColor, join(path, "textColor")));

  const w = optNumber(o, "width", path, { min: 0.01 });
  const h = optNumber(o, "height", path, { min: 0.01 });
  if ((w === undefined) !== (h === undefined)) {
    refuse(join(path, w === undefined ? "width" : "height"), `\`${path}\`: give both \`width\` and \`height\`, or neither to fit the shape to its text.`);
  }
  if (w !== undefined && h !== undefined) spec.size = { w, h };
  const fontSize = optNumber(o, "fontSize", path, { min: 1 });
  if (fontSize !== undefined) spec.fontSize = fontSize;
  else if (label) spec.fontSize = LABEL_FONT_SIZE;
  const name = optString(o, "name", path);
  if (name !== undefined) spec.name = name;
  return spec;
}

/** The fitting recipe of create-shape-with-text.md:199-261 [C-163]. */
export const SHAPE_FIT = { baseW: 200, baseH: 120, nonRectScale: 1.6, padding: 32, maxScale: 3 } as const;
/** Shapes whose text box is about half their bounding box. */
export const NON_RECT_SHAPES: ReadonlySet<ShapeType> = new Set<ShapeType>([
  "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "ELLIPSE", "HEXAGON", "OCTAGON", "STAR", "PENTAGON",
]);

/**
 * The size a shape needs for its text: start at the base box (×1.6 for a
 * non-rectangular type) and grow in 10 % steps, up to 3×, until `measure`
 * (the wrapped height at a text width) fits the text box. Pure.
 */
export function fitToText(type: ShapeType, measure: (textWidth: number) => number): { w: number; h: number } {
  const nonRect = NON_RECT_SHAPES.has(type);
  const w0 = Math.round(SHAPE_FIT.baseW * (nonRect ? SHAPE_FIT.nonRectScale : 1));
  const h0 = Math.round(SHAPE_FIT.baseH * (nonRect ? SHAPE_FIT.nonRectScale : 1));
  const pad = SHAPE_FIT.padding;
  const steps = Math.round((SHAPE_FIT.maxScale - 1) * 10);
  for (let k = 0; k < steps; k++) {
    const scale = 1 + k / 10;
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const area = nonRect ? { w: w / 2 - pad, h: h / 2 - pad } : { w: w - pad * 2, h: h - pad * 2 };
    if (measure(Math.max(area.w, 1)) <= area.h) return { w, h };
  }
  return { w: Math.round(w0 * SHAPE_FIT.maxScale), h: Math.round(h0 * SHAPE_FIT.maxScale) };
}

/**
 * One temporary TextNode in FigJam's default font that measures how tall text
 * wraps at a width — the official recipe [C-163]. Never recorded: the caller
 * removes it in a `finally`, so it is gone by the time the call ends, whatever
 * happened.
 */
export class Measurer {
  private node: (NodeLikeW & Any) | null = null;
  private defaultSize: unknown;
  constructor(private readonly m: Pick<Make, "loadFont">) {}

  async prepare(text: string, fontSize: number | undefined): Promise<(width: number) => number> {
    if (!this.node) {
      await this.m.loadFont(FIGJAM_FONT);
      const n = board().createText() as NodeLikeW & Any;
      this.node = n;
      n.fontName = { ...FIGJAM_FONT };
      n.textAutoResize = "HEIGHT";
      this.defaultSize = n.fontSize;
    }
    const n = this.node;
    // One measurer serves every shape of the call, so a size set for one is undone for the next.
    const size = fontSize ?? (typeof this.defaultSize === "number" ? this.defaultSize : undefined);
    if (size !== undefined) n.fontSize = size;
    return (width) => {
      (n.resize as (w: number, h: number) => void)(width, Math.max(1, n.height as number));
      n.characters = text;
      return n.height as number;
    };
  }

  remove(): void {
    const n = this.node;
    this.node = null;
    try {
      n?.remove?.();
    } catch {
      /* already gone */
    }
  }
}

export interface BuiltShape {
  node: NodeLikeW;
  fitted: boolean;
}

export async function buildShape(s: ShapeSpec, parent: NodeLikeW, m: Make, measurer: Measurer): Promise<BuiltShape> {
  const node = m.record(board().createShapeWithText());
  m.append(parent, node);
  const n = node as unknown as Any & { resize(w: number, h: number): void };
  setName(node, s.name);
  n.shapeType = s.type;
  const text = sublayer(node, "shape");
  await writeSublayer(text, s.text, m);
  if (s.fontSize !== undefined) text.fontSize = s.fontSize;
  let fitted = false;
  if (s.label) {
    const side = LABEL_SIZE[Array.from(s.text).length] ?? LABEL_SIZE[2]!;
    n.resize(side, side);
  } else if (s.size) {
    n.resize(s.size.w, s.size.h);
  } else {
    const size = tryGet(text, "fontSize");
    const measure = await measurer.prepare(s.text, size.ok && typeof size.value === "number" ? size.value : s.fontSize);
    const fit = fitToText(s.type, measure);
    n.resize(fit.w, fit.h);
    fitted = true;
  }
  // A preset writes all three, or the shape shows a stroke or text from another colour (create-shape-with-text.md:361).
  if (s.fill) n.fills = [s.fill];
  if (s.stroke) n.strokes = [s.stroke];
  if (s.textFill) text.fills = [s.textFill];
  return { node, fitted };
}

// ── connectors ───────────────────────────────────────────────────────────────

export interface ConnectorSpec {
  from?: ParsedEndpoint;
  to?: ParsedEndpoint;
  label?: string;
  lineType?: LineType;
  startCap?: StrokeCap;
  endCap?: StrokeCap;
  stroke?: SolidPaint;
  weight?: number;
  dash?: number[];
  labelBackground?: SolidPaint;
  name?: string;
}

/**
 * A new connector's line type and caps, written explicitly rather than left to
 * Figma's defaults, which only the official notes state (create-connector.md:55,
 * :329) [C-148].
 */
export const CONNECTOR_DEFAULTS = { lineType: "ELBOWED", startCap: "NONE", endCap: "ARROW_LINES" } as const;
/**
 * A label's size when its own cannot be read. The official notes say a fresh
 * label needs fontName, fontSize and fills set or it renders invisibly
 * (generate-project-plan SKILL.md:196) [C-148]; 14 is our pick, not theirs —
 * used only when no size of the connector's own is readable.
 */
export const CONNECTOR_LABEL_SIZE = 14;

const DASHES: Readonly<Record<string, number[]>> = { solid: [], dashed: [10, 5], dotted: [2, 4] };

/** `dash`: "solid", "dashed", "dotted" (create-connector.md:186-205) or "a,b[,…]" — a dashPattern of numbers >= 0. */
export function parseDash(input: unknown, path: string): number[] {
  if (typeof input === "string") {
    const key = input.trim().toLowerCase();
    if (key in DASHES) return [...DASHES[key]!];
    const parts = key.split(",").map((p) => p.trim());
    const nums = parts.map(Number);
    if (parts.length >= 2 && parts.every((p) => p !== "") && nums.every((x) => Number.isFinite(x) && x >= 0) && nums.some((x) => x > 0)) return nums;
  }
  refuse(path, `\`${path}\` must be "solid", "dashed", "dotted" or a dash pattern such as "10,5".`);
}

export interface ConnectorParseOptions {
  /** A spec connector may name a node by the `ref` it is built under. */
  refs: boolean;
  /** `weight` in the tools, `strokeWeight` in a spec (the spec's word for a stroke width). */
  weightKey: string;
  allowed: readonly string[] | null;
  /** A new connector needs both ends and gets the defaults; an edit changes only what it names. */
  create: boolean;
}

export function parseConnector(raw: unknown, path: string, opts: ConnectorParseOptions): ConnectorSpec {
  const o = objectAt(raw, path);
  if (opts.allowed) onlyKeys(o, opts.allowed, path);
  const spec: ConnectorSpec = {};
  for (const end of ["from", "to"] as const) {
    const v = o[end];
    if (v === undefined) {
      if (opts.create) refuse(join(path, end), `\`${join(path, end)}\` is required: where the connector ${end === "from" ? "starts" : "ends"}.`);
      continue;
    }
    spec[end] = at(join(path, end), () => parseEndpoint(v, join(path, end), { refs: opts.refs }));
  }
  const label = optString(o, "label", path);
  if (label !== undefined) spec.label = label;
  if (o.lineType !== undefined) spec.lineType = at(join(path, "lineType"), () => parseLineType(o.lineType, join(path, "lineType")));
  if (o.startCap !== undefined) spec.startCap = at(join(path, "startCap"), () => parseStrokeCap(o.startCap, join(path, "startCap")));
  if (o.endCap !== undefined) spec.endCap = at(join(path, "endCap"), () => parseStrokeCap(o.endCap, join(path, "endCap")));
  if (o.color !== undefined) spec.stroke = at(join(path, "color"), () => resolveColor("connector", o.color, join(path, "color")).paint);
  const weight = optNumber(o, opts.weightKey, path, { min: 0, above: true });
  if (weight !== undefined) spec.weight = weight;
  if (o.dash !== undefined) spec.dash = parseDash(o.dash, join(path, "dash"));
  if (o.labelBackground !== undefined) spec.labelBackground = at(join(path, "labelBackground"), () => parseColor(o.labelBackground, join(path, "labelBackground")));
  const name = optString(o, "name", path);
  if (name !== undefined) spec.name = name;
  if (opts.create) {
    spec.lineType = spec.lineType ?? CONNECTOR_DEFAULTS.lineType;
    spec.startCap = spec.startCap ?? CONNECTOR_DEFAULTS.startCap;
    spec.endCap = spec.endCap ?? CONNECTOR_DEFAULTS.endCap;
  }
  return spec;
}

/** True when an edit names nothing to change. */
export function emptyConnectorEdit(s: ConnectorSpec): boolean {
  return Object.keys(s).length === 0;
}

/** The page a node sits on, by walking up. */
function pageOf(node: NodeLikeW): NodeLikeW | null {
  let at: NodeLikeW | null | undefined = node;
  while (at && at.type !== "PAGE") at = at.parent;
  return at ?? null;
}

/**
 * The node an endpoint attaches to: it must exist, sit on the current page
 * (a connector cannot cross pages), and not be a page — nor a connector, which
 * stays refused until a live run shows what attaching to one does [C-148].
 */
export async function endpointNode(id: string, path: string): Promise<NodeLikeW> {
  const fig = board();
  const node = await fig.getNodeByIdAsync(id);
  if (!node) refuse(path, `\`${path}\`: no node with id \`${id}\`.`, undefined, ErrorCode.NODE_NOT_FOUND);
  if (node.type === "PAGE" || node.type === "DOCUMENT") refuse(path, `\`${path}\`: a connector attaches to a layer, not a ${node.type}.`);
  if (node.type === "CONNECTOR") {
    refuse(path, `\`${path}\`: \`${id}\` is a connector; attaching a connector to another one is not supported yet.`, "Attach both ends to shapes, stickies or sections.");
  }
  const page = pageOf(node);
  if (!page || page.id !== fig.currentPage.id) refuse(path, `\`${path}\`: \`${id}\` is not on the current page; a connector joins layers on one page.`);
  return node;
}

/** The lowest SECTION that holds both nodes, or null. */
export function commonSection(a: NodeLikeW, b: NodeLikeW): NodeLikeW | null {
  const above = new Set<string>();
  for (let p = a.parent; p; p = p.parent) if (p.type === "SECTION") above.add(p.id);
  for (let p = b.parent; p; p = p.parent) if (p.type === "SECTION" && above.has(p.id)) return p;
  return null;
}

/** An endpoint as Figma takes it: the parse-only `ref` flag dropped. */
export function endpointValue(e: ParsedEndpoint): ConnectorEndpoint {
  if (!("endpointNodeId" in e)) return { position: { ...e.position } };
  if ("position" in e) return { endpointNodeId: e.endpointNodeId, position: { ...e.position } };
  return { endpointNodeId: e.endpointNodeId, magnet: e.magnet };
}

/**
 * What can fail on one connector, done before its first property write, so a
 * font that will not load leaves the connector as it was. A fresh connector's
 * label font is invalid, so it is given FigJam's default; an edited one keeps
 * a font that loads (loadTextFonts resets one that does not)
 * (create-connector.md:109) [C-148]. Setting that font is the only write here.
 */
async function prepareConnector(node: NodeLikeW, s: ConnectorSpec, m: Make, fresh: boolean): Promise<{ text?: TextHolder & Any; background?: Any }> {
  const out: { text?: TextHolder & Any; background?: Any } = {};
  if (s.labelBackground) {
    const bg = tryGet<Any>(node, "textBackground");
    if (!bg.ok || !bg.value) throw new BridgeError(ErrorCode.INTERNAL, `The connector has no readable label background: ${bg.ok ? "it is empty" : bg.message}`);
    out.background = bg.value;
  }
  if (s.label !== undefined) {
    const text = sublayer(node, "connector");
    if (fresh) {
      await m.loadFont(CONNECTOR_LABEL_FONT);
      text.fontName = { ...CONNECTOR_LABEL_FONT };
    } else {
      await loadTextFonts({ kind: "sublayer", owner: node, target: text }, { loadFontAsync: (f) => m.loadFont(f) });
    }
    out.text = text;
  }
  return out;
}

/**
 * Write a label whose font is loaded. One whose size or fill cannot be read
 * would render invisibly, so both get a value then (generate-project-plan
 * SKILL.md:196) [C-148].
 */
function writeLabel(text: TextHolder & Any, label: string): void {
  const size = tryGet(text, "fontSize");
  if (!size.ok || typeof size.value !== "number" || !(size.value > 0)) text.fontSize = CONNECTOR_LABEL_SIZE;
  text.characters = label;
  const fills = tryGet(text, "fills");
  if (label && (!fills.ok || !Array.isArray(fills.value) || fills.value.length === 0)) text.fills = [parseColor(FIGJAM_TEXT_DEFAULT)];
}

/** Write what `s` names onto a connector: every field on a new one, only the named ones on an edit. */
export async function applyConnector(node: NodeLikeW, s: ConnectorSpec, m: Make, fresh: boolean): Promise<void> {
  const ready = await prepareConnector(node, s, m, fresh);
  const c = node as unknown as Any;
  setName(node, s.name);
  if (s.lineType) c.connectorLineType = s.lineType;
  if (s.from) c.connectorStart = endpointValue(s.from);
  if (s.to) c.connectorEnd = endpointValue(s.to);
  if (s.startCap) c.connectorStartStrokeCap = s.startCap;
  if (s.endCap) c.connectorEndStrokeCap = s.endCap;
  if (s.stroke) c.strokes = [s.stroke];
  if (s.weight !== undefined) c.strokeWeight = s.weight;
  if (s.dash) c.dashPattern = s.dash;
  if (ready.background && s.labelBackground) ready.background.fills = [s.labelBackground];
  if (ready.text && s.label !== undefined) writeLabel(ready.text, s.label);
}

/** Create a connector IN its final parent, then set its ends — never the other way round [C-149]. */
export async function buildConnector(s: ConnectorSpec, parent: NodeLikeW, m: Make): Promise<NodeLikeW> {
  const node = m.record(board().createConnector());
  m.append(parent, node);
  await applyConnector(node, s, m, true);
  return node;
}

// ── tables ───────────────────────────────────────────────────────────────────

export const TABLE_MAX_ROWS = 100;
export const TABLE_MAX_COLUMNS = 20;

export interface TableSpec {
  rows?: string[][];
  numRows: number;
  numColumns: number;
  header: boolean;
  headerFill?: SolidPaint;
  headerText?: SolidPaint;
  fill?: SolidPaint;
  columnWidths?: number[];
  rowHeights?: number[];
  fontFamily?: string;
  weight?: number | string;
  fontSize?: number;
  name?: string;
}

/** A fill is reset, never removed (create-table.md:246) [C-163]. */
export function refuseEmptyFill(value: unknown, path: string): void {
  if (typeof value === "string" && value.trim() === "") {
    refuse(path, `\`${path}\` is empty: a table or cell fill is never removed.`, 'To reset it, give "#FFFFFF" (white, the default).');
  }
}

function sizes(o: Any, key: string, path: string, count: number, what: string): number[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  const at = join(path, key);
  if (!Array.isArray(v) || v.length !== count || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0.01)) {
    refuse(at, `\`${at}\` must list ${count} ${what} (one per ${what === "widths" ? "column" : "row"}), each >= 0.01.`);
  }
  return v as number[];
}

export function parseTable(raw: unknown, path: string, allowed: readonly string[] | null): TableSpec {
  const o = objectAt(raw, path);
  if (allowed) onlyKeys(o, allowed, path);
  const hasRows = o.rows !== undefined;
  const hasDims = o.numRows !== undefined || o.numColumns !== undefined;
  if (hasRows === hasDims) {
    refuse(join(path, hasRows ? "numRows" : "rows"), `\`${path || "the table"}\`: give \`rows\` (the data) or \`numRows\` + \`numColumns\` (an empty table) — exactly one.`);
  }
  let rows: string[][] | undefined;
  let numRows: number;
  let numColumns: number;
  if (hasRows) {
    const r = o.rows;
    const at = join(path, "rows");
    if (!Array.isArray(r) || r.length < 1 || r.length > TABLE_MAX_ROWS) refuse(at, `\`${at}\` must be 1–${TABLE_MAX_ROWS} rows.`);
    const width = Array.isArray(r[0]) ? r[0].length : -1;
    r.forEach((row, i) => {
      if (!Array.isArray(row) || row.length < 1 || row.length > TABLE_MAX_COLUMNS) refuse(`${at}[${i}]`, `\`${at}[${i}]\` must be 1–${TABLE_MAX_COLUMNS} cells of text.`);
      if (row.length !== width) refuse(`${at}[${i}]`, `\`${at}[${i}]\` has ${row.length} cells but row 0 has ${width}: every row needs the same number.`, 'Fill a missing cell with "".');
      row.forEach((cell, j) => {
        if (typeof cell !== "string") refuse(`${at}[${i}][${j}]`, `\`${at}[${i}][${j}]\` must be text.`);
        if (cell.length > MAX_TEXT) refuse(`${at}[${i}][${j}]`, `\`${at}[${i}][${j}]\` is longer than ${MAX_TEXT} characters.`);
      });
    });
    rows = r as string[][];
    numRows = rows.length;
    numColumns = width;
  } else {
    const nr = optNumber(o, "numRows", path, { int: true, min: 1, max: TABLE_MAX_ROWS });
    const nc = optNumber(o, "numColumns", path, { int: true, min: 1, max: TABLE_MAX_COLUMNS });
    if (nr === undefined || nc === undefined) refuse(join(path, nr === undefined ? "numRows" : "numColumns"), `\`${path || "the table"}\`: an empty table needs both \`numRows\` and \`numColumns\`.`);
    numRows = nr;
    numColumns = nc;
  }
  const headerGiven = optBool(o, "header", path);
  if (headerGiven === false && o.headerColor !== undefined) refuse(join(path, "headerColor"), `\`${join(path, "headerColor")}\` styles the header row, but \`header\` is false.`);
  // A dark header by default when there is data to head (create-table.md:15) [C-163].
  const header = headerGiven ?? (hasRows || o.headerColor !== undefined);
  const spec: TableSpec = { numRows, numColumns, header, ...(rows ? { rows } : {}) };
  if (header) {
    refuseEmptyFill(o.headerColor, join(path, "headerColor"));
    const c = at(join(path, "headerColor"), () => resolveTableColor(o.headerColor ?? "black", join(path, "headerColor")));
    spec.headerFill = c.fill;
    spec.headerText = c.text;
  }
  if (o.fill !== undefined) {
    refuseEmptyFill(o.fill, join(path, "fill"));
    spec.fill = at(join(path, "fill"), () => resolveTableColor(o.fill, join(path, "fill")).fill);
  }
  const widths = sizes(o, "columnWidths", path, numColumns, "widths");
  if (widths) spec.columnWidths = widths;
  const heights = sizes(o, "rowHeights", path, numRows, "heights");
  if (heights) spec.rowHeights = heights;
  const family = optString(o, "fontFamily", path, 200);
  if (family !== undefined) spec.fontFamily = family;
  const weight = o.weight;
  if (weight !== undefined) {
    if (!(typeof weight === "number" && weight > 0) && !(typeof weight === "string" && weight.trim())) refuse(join(path, "weight"), `\`${join(path, "weight")}\` must be a weight such as "600" or "Semi Bold".`);
    spec.weight = weight;
  }
  const fontSize = optNumber(o, "fontSize", path, { min: 1 });
  if (fontSize !== undefined) spec.fontSize = fontSize;
  const name = optString(o, "name", path);
  if (name !== undefined) spec.name = name;
  return spec;
}

interface TableLike extends NodeLikeW {
  readonly numRows: number;
  readonly numColumns: number;
  cellAt(row: number, column: number): Any;
  resizeRow(index: number, height: number): void;
  resizeColumn(index: number, width: number): void;
}

/** A cell's width or height as Figma reports it — a column cannot shrink below its minimum, so asked is not got (d.ts:11425-11437) [C-161]. */
function cellSize(table: TableLike, row: number, column: number, key: "width" | "height"): number | null {
  try {
    const v = tryGet(table.cellAt(row, column), key);
    return v.ok && typeof v.value === "number" ? v.value : null;
  } catch {
    return null;
  }
}

/** Each column's width, read back from row 0. */
export function columnWidthsOf(table: NodeLikeW): Array<number | null> {
  const t = table as TableLike;
  return Array.from({ length: t.numColumns }, (_, c) => cellSize(t, 0, c, "width"));
}

/**
 * Build a table. `font`, when given, is already resolved and is set on every
 * cell; otherwise the cells keep FigJam's own and only that one is loaded.
 * No text is written when there are no rows: an empty table stays empty
 * (create-table.md:17) [C-163].
 */
export async function buildTable(s: TableSpec, parent: NodeLikeW, m: Make, font?: FontNameLike): Promise<NodeLikeW> {
  const node = m.record(board().createTable(s.numRows, s.numColumns));
  m.append(parent, node);
  const t = node as unknown as TableLike & Any;
  setName(node, s.name);
  if (s.fill) t.fills = [s.fill];
  const touchesText = s.rows !== undefined || s.fontSize !== undefined || font !== undefined;
  if (font) await m.loadFont(font);
  // A header's text colour is a text write too: its font is loaded first (create-table.md:244).
  else if (touchesText || s.header) {
    const first = sublayer(t.cellAt(0, 0), "table cell");
    const fonts = fontsOf(first);
    for (const f of fonts.length ? fonts : [FIGJAM_FONT]) await m.loadFont(f);
  }
  let done = 0;
  for (let r = 0; r < s.numRows; r++) {
    for (let c = 0; c < s.numColumns; c++) {
      const cell = t.cellAt(r, c);
      const isHeader = s.header && r === 0;
      if (touchesText || isHeader) {
        const text = sublayer(cell, "table cell");
        if (font) text.fontName = { ...font };
        if (s.fontSize !== undefined) text.fontSize = s.fontSize;
        const value = s.rows?.[r]?.[c];
        if (value) text.characters = value;
        if (isHeader && s.headerText) text.fills = [s.headerText];
      }
      if (isHeader && s.headerFill) cell.fills = [s.headerFill];
      if (++done % 50 === 0) await m.yieldToHost();
    }
  }
  s.columnWidths?.forEach((w, i) => t.resizeColumn(i, w));
  s.rowHeights?.forEach((h, i) => t.resizeRow(i, h));
  return node;
}

// ── code blocks ──────────────────────────────────────────────────────────────

export interface CodeSpec {
  code: string;
  language: CodeLanguage;
  name?: string;
}

export function parseCode(raw: unknown, path: string, opts: ParseOptions): CodeSpec {
  const o = objectAt(raw, path);
  if (opts.allowed) onlyKeys(o, opts.allowed, path);
  const code = o[opts.textKey];
  if (typeof code !== "string") refuse(join(path, opts.textKey), `\`${join(path, opts.textKey)}\` must be the code, as text.`);
  optString(o, opts.textKey, path, MAX_CODE);
  // An unknown language is refused, never quietly PLAINTEXT (create-code-block.md:48 does that silently).
  const language = o.language === undefined ? "PLAINTEXT" : at(join(path, "language"), () => parseCodeLanguage(o.language, join(path, "language")));
  const spec: CodeSpec = { code, language };
  const name = optString(o, "name", path);
  if (name !== undefined) spec.name = name;
  return spec;
}

/** A code block styles itself: no font to load, no theme to set (create-code-block.md:90-92). */
export async function buildCodeBlock(s: CodeSpec, parent: NodeLikeW, m: Make): Promise<NodeLikeW> {
  const node = m.record(board().createCodeBlock());
  m.append(parent, node);
  const n = node as unknown as Any;
  setName(node, s.name);
  n.code = s.code;
  n.codeLanguage = s.language;
  return node;
}

// ── placement ────────────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node's box in its parent, or null when any of the four cannot be read [C-145]. */
export function boxOf(node: unknown): Box | null {
  const out: Partial<Box> = {};
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = tryGet(node, k);
    if (!v.ok || typeof v.value !== "number" || !Number.isFinite(v.value)) return null;
    out[k] = v.value;
  }
  return out as Box;
}

/** The box around `boxes`, or null when there are none. */
export function unionBox(boxes: ReadonlyArray<Box | null>): Box | null {
  const real = boxes.filter((b): b is Box => b !== null);
  if (!real.length) return null;
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  const right = Math.max(...real.map((b) => b.x + b.width));
  const bottom = Math.max(...real.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Auto-layout (and a grid) places children itself: x/y would be ignored. */
export function hasAutoLayout(node: NodeLikeW): boolean {
  const mode = tryGet(node, "layoutMode");
  return mode.ok && (mode.value === "HORIZONTAL" || mode.value === "VERTICAL" || mode.value === "GRID");
}

/**
 * Clear space beside the page's content — 200–400 px separates different
 * topics on a board (plan-board-content.md:17), and new content goes right of
 * what is there (create-code-block.md:12-20) — and the inset inside a parent,
 * at least 32 px (create-section.md:65) [C-163].
 */
export const PAGE_CLEARANCE = 200;
export const PARENT_INSET = 32;

/**
 * Where a block goes when no x/y is given. Must run BEFORE any node is made:
 * every new FigJam node lands on the current page first, and would count as
 * content. On the page: right of everything there. In a parent: below what it
 * already holds, else inset from its corner.
 */
export function defaultOrigin(parent: NodeLikeW, gap: number): { x: number; y: number } {
  const content = unionBox((parent.children ?? []).map(boxOf));
  if (parent.type === "PAGE") return content ? { x: Math.round(content.x + content.width + PAGE_CLEARANCE), y: Math.round(content.y) } : { x: 0, y: 0 };
  return content ? { x: Math.round(content.x), y: Math.round(content.y + content.height + gap) } : { x: PARENT_INSET, y: PARENT_INSET };
}

export interface GridPlan {
  columns: number;
  gap: number;
  /** Undefined when the parent's auto-layout places the nodes. */
  origin?: { x: number; y: number };
}

/**
 * `x`, `y`, `columns` and `gap` for a block of `count` nodes. Under an
 * auto-layout parent they would be ignored, so they are refused rather than
 * dropped (the same rule create_from_spec applies to x/y).
 */
export function gridPlan(params: Any, parent: NodeLikeW, defaultGap: number, count: number): GridPlan {
  const columns = optNumber(params, "columns", "", { int: true, min: 1, max: 50 });
  const gap = optNumber(params, "gap", "", { min: 0 });
  const x = optNumber(params, "x", "");
  const y = optNumber(params, "y", "");
  if (hasAutoLayout(parent)) {
    const given = (["x", "y", "columns", "gap"] as const).find((k) => params[k] !== undefined);
    if (given) refuse(given, `\`${given}\` is ignored in an auto-layout: "${parent.name}" places its children itself.`, "Leave x, y, columns and gap out, or give a parent without auto-layout.");
    return { columns: Math.max(1, count), gap: defaultGap };
  }
  const origin = x !== undefined && y !== undefined ? { x, y } : { ...defaultOrigin(parent, gap ?? defaultGap), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
  return { columns: Math.min(columns ?? count, Math.max(1, count)), gap: gap ?? defaultGap, origin };
}

/** x/y for one node; undefined under auto-layout. */
export function pointPlan(params: Any, parent: NodeLikeW): { x: number; y: number } | undefined {
  return gridPlan(params, parent, PARENT_INSET, 1).origin;
}

export interface Placed extends Box {
  id: string;
}

/**
 * Pass two of the official two-pass layout: place each node from the size
 * Figma reports NOW, after its text is in (create-sticky.md:136-148) [C-147].
 */
export function placeNodes(nodes: readonly NodeLikeW[], g: GridPlan): { placed: Placed[]; bounds: Box } {
  if (g.origin) {
    const sizes = nodes.map((n) => {
      const b = boxOf(n);
      return { w: b?.width ?? 0, h: b?.height ?? 0 };
    });
    const grid = placeGrid(sizes, { columns: g.columns, gap: g.gap, origin: g.origin });
    nodes.forEach((n, i) => {
      const at = n as unknown as { x: number; y: number };
      at.x = grid.positions[i]!.x;
      at.y = grid.positions[i]!.y;
    });
  }
  const placed = nodes.map((n) => ({ id: n.id, ...(boxOf(n) ?? { x: 0, y: 0, width: 0, height: 0 }) }));
  return { placed, bounds: unionBox(placed) ?? { x: 0, y: 0, width: 0, height: 0 } };
}

/** Place one node at `point` (after its append). */
export function placeAt(node: NodeLikeW, point: { x: number; y: number } | undefined): void {
  if (!point) return;
  const at = node as unknown as { x: number; y: number };
  at.x = point.x;
  at.y = point.y;
}

/**
 * How far `bounds` runs past a section's or frame's edge. The parent is never
 * resized for it: a participatory zone keeps the size it was given
 * (create-section.md:65), and figma_fit_sections is the deliberate step.
 */
export function overflowOf(parent: NodeLikeW, bounds: Box): { right: number; bottom: number } | undefined {
  if (parent.type === "PAGE") return undefined;
  const p = boxOf(parent);
  if (!p) return undefined;
  const right = Math.max(0, Math.round(bounds.x + bounds.width - p.width));
  const bottom = Math.max(0, Math.round(bounds.y + bounds.height - p.height));
  return right > 0 || bottom > 0 ? { right, bottom } : undefined;
}
