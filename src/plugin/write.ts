// Write-side helpers: colour parsing, font loading, and the node builders the
// create/modify groups share.
//
// Two rules from tools.md shape everything here:
//
//  1. **Validation before touching Figma.** A bad colour or a missing font must
//     fail with INVALID_PARAM naming the offending value, not leave a half-built
//     node on the canvas for the user to tidy up.
//  2. **Never a silent partial.** A spec that fails half-way reports what it
//     created (`created[]`) and where it stopped (`failedAt`). No automatic
//     rollback: one op is one undo step, so the user's Ctrl+Z already covers it,
//     and pretending to roll back is how an agent ends up lying about state.
//
// No Node APIs. The sandbox has no `Buffer` (measured: spikes/results/probe.json).

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { FIGJAM_TEXT_DEFAULT } from "../shared/figjam.js";
import { fontIndex, resetFontIndex } from "./font-index.js";
import { ensureLoaded } from "./pages.js";
import { TEMPORARY_ID_HINT } from "./read.js";
import { editorType, figmaGlobal, tryGet } from "./safe.js";

/** Figma's Paint shape, narrowed to what this project sets. */
export interface SolidPaint {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  opacity?: number;
}

export interface FigmaWrite {
  createFrame(): FrameLike;
  createText(): TextLike;
  createRectangle(): RectLike;
  createEllipse(): RectLike;
  createSection?(): RectLike;
  createPage?(): NodeLikeW;
  createInstance?(component: NodeLikeW): NodeLikeW;
  createComponent?(): NodeLikeW;
  loadFontAsync(font: { family: string; style: string }): Promise<void>;
  listAvailableFontsAsync?(): Promise<ReadonlyArray<{ fontName: { family: string; style: string } }>>;
  currentPage: NodeLikeW;
  root: NodeLikeW;
  getNodeByIdAsync(id: string): Promise<NodeLikeW | null>;
  getLocalTextStylesAsync?(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  getLocalPaintStylesAsync?(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  getLocalEffectStylesAsync?(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  getLocalGridStylesAsync?(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  getLocalVariableCollectionsAsync?(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  variables?: {
    getLocalVariablesAsync?(): Promise<ReadonlyArray<{ id: string; name: string; resolvedType: string }>>;
    getVariableByIdAsync?(id: string): Promise<unknown>;
    setValueForMode?(id: string, modeId: string, value: unknown): void;
  };
  on?(event: string, cb: () => void): void;
}

export interface NodeLikeW {
  id: string;
  name: string;
  type: string;
  children?: readonly NodeLikeW[] | undefined;
  parent?: NodeLikeW | null | undefined;
  appendChild?(child: NodeLikeW): void;
  remove?(): void;
  setPluginData?(ns: string, key: string, value: string): void;
  getPluginData?(ns: string, key: string): string;
  insertChild?(index: number, child: NodeLikeW): void;
  findChild?(predicate: (n: NodeLikeW) => boolean): NodeLikeW | null;
  findOne?(predicate: (n: NodeLikeW) => boolean): NodeLikeW | null;
}

export interface FrameLike extends NodeLikeW {
  resize(w: number, h: number): void;
  x: number;
  y: number;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  counterAxisAlignItems?: string;
  primaryAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  layoutWrap?: string;
  clipsContent?: boolean;
  fills?: readonly unknown[] | symbol;
  cornerRadius?: number | symbol;
  strokes?: readonly unknown[] | symbol;
  strokeWeight?: number | symbol;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  rotation?: number;
  blendMode?: string;
}

export interface RectLike extends FrameLike {
  name: string;
}

export interface TextLike extends NodeLikeW {
  resize(w: number, h: number): void;
  x: number;
  y: number;
  characters: string;
  fontName?: { family: string; style: string } | symbol;
  fontSize?: number | symbol;
  fills?: readonly unknown[] | symbol;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  textAutoResize?: string;
  opacity?: number;
}

// ── colour ───────────────────────────────────────────────────────────────────

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse `#rgb`, `#rrggbb`, `#rrggbbaa` into a Figma SOLID paint.
 *
 * Alpha is carried as `opacity` rather than folded into the channels: Figma
 * keeps them separate, and folding them changes how the fill blends with what
 * is underneath.
 */
export function parseColor(input: unknown, field = "color"): SolidPaint {
  if (typeof input !== "string") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a hex colour string like "#1a2b3c".`);
  }
  const m = HEX.exec(input.trim());
  if (!m) {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `\`${field}\` is not a hex colour: "${input}". Use #rgb, #rrggbb or #rrggbbaa.`,
    );
  }
  let h = m[1]!.toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const paint: SolidPaint = { type: "SOLID", color: { r, g, b } };
  if (h.length === 8) paint.opacity = parseInt(h.slice(6, 8), 16) / 255;
  return paint;
}

/**
 * Padding accepts a number (all sides) or [top, right, bottom, left] — and the
 * string forms the MCP schema declares ("24" or "48,48,32,32"), because a
 * number-or-array union is not portable (server/tools/params.ts).
 */
export function normalizePadding(input: unknown, field = "padding"): [number, number, number, number] | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") {
    const parts = input.split(",").map((p) => p.trim());
    const nums = parts.map(Number);
    if ((parts.length === 1 || parts.length === 4) && parts.every((p) => p !== "") && nums.every((n) => Number.isFinite(n) && n >= 0)) {
      return parts.length === 1 ? [nums[0]!, nums[0]!, nums[0]!, nums[0]!] : [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
    }
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `\`${field}\` must be one number ("24") or four comma-separated ("48,48,32,32") — got "${input}".`,
    );
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a non-negative number.`);
    }
    return [input, input, input, input];
  }
  if (Array.isArray(input) && input.length === 4 && input.every((n) => typeof n === "number" && n >= 0)) {
    return [input[0]!, input[1]!, input[2]!, input[3]!] as [number, number, number, number];
  }
  throw new BridgeError(
    ErrorCode.INVALID_PARAM,
    `\`${field}\` must be a number or an array of 4 numbers [top, right, bottom, left].`,
  );
}

// ── fonts ────────────────────────────────────────────────────────────────────

/** Ordered fallback from tools.md § create_from_spec. Inter's styles use spaces. */
export const FONT_FALLBACK: ReadonlyArray<{ family: string; style: string }> = [
  { family: "Inter", style: "Regular" },
  { family: "Roboto", style: "Regular" },
  { family: "Arial", style: "Regular" },
  { family: "Helvetica Neue", style: "Regular" },
];

/**
 * What a new text gets when the call names no weight or colour. FigJam's own
 * default is Inter Medium in Charcoal #1E1E1E (figma-use-figjam create-text.md:
 * 83-88, 143) [C-156]; elsewhere Inter Regular on black, as before. Decided in
 * the plugin, which knows figma.editorType, so the schema is the same for
 * every client.
 */
export function textDefaults(editor: string | undefined): { style: string; color: string } {
  return editor === "figjam" ? { style: "Medium", color: FIGJAM_TEXT_DEFAULT } : { style: "Regular", color: "#000000" };
}

/** Figma's weight names are words, not numbers, and 600 is "Semi Bold". */
export function weightToStyle(weight: number | string | undefined): string {
  if (weight === undefined) return "Regular";
  if (typeof weight === "string") {
    const w = weight.trim();
    if (!/^\d+$/.test(w)) return w; // already a style name
    return weightToStyle(Number(w));
  }
  const table: Array<[number, string]> = [
    [100, "Thin"], [200, "Extra Light"], [300, "Light"], [400, "Regular"],
    [500, "Medium"], [600, "Semi Bold"], [700, "Bold"], [800, "Extra Bold"], [900, "Black"],
  ];
  let best = table[3]!;
  for (const entry of table) if (weight >= entry[0]) best = entry;
  return best[1];
}

/** A `weight` param as sent: a number, "600", or a style name like "Semi Bold". */
export function weightParam(params: Record<string, unknown>, key = "weight"): number | string | undefined {
  const v = params[key];
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? v : undefined;
}

// ── auto-layout alignment ──────────────────────────────────────────────────

const ALIGN: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN" };

/**
 * `alignX` / `alignY` are screen directions; Figma's properties are axes. In a
 * HORIZONTAL frame x is the primary axis, in a VERTICAL one it is the counter
 * axis — mapping x to the counter axis unconditionally (as create_from_spec
 * once did) is right for vertical stacks and backwards for rows.
 * `space-between` exists only along the layout direction (primaryAxisAlignItems).
 * `baseline` exists only across a row: counterAxisAlignItems BASELINE "can
 * only be set on horizontal auto-layout frames" [C-095], so it is alignY of a
 * horizontal layout and nothing else — a "$29 /mo" price row.
 */
export function alignmentFor(
  layoutMode: string,
  alignX: unknown,
  alignY: unknown,
  field = "",
): { primaryAxisAlignItems?: string; counterAxisAlignItems?: string } {
  const out: { primaryAxisAlignItems?: string; counterAxisAlignItems?: string } = {};
  if (alignX === undefined && alignY === undefined) return out;
  if (layoutMode !== "HORIZONTAL" && layoutMode !== "VERTICAL") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}alignX\` / \`${field}alignY\` need auto-layout (layout horizontal or vertical).`);
  }
  const read = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    const key = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (key === "baseline") {
      if (name === "alignY" && layoutMode === "HORIZONTAL") return "BASELINE";
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `\`${field}${name}: baseline\` lines up text baselines across a row: it works as alignY of a horizontal layout only.`,
      );
    }
    if (!(key in ALIGN)) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `\`${field}${name}\` must be start, center, end or space-between${name === "alignY" ? " (or baseline, in a row)" : ""}.`,
      );
    }
    return ALIGN[key];
  };
  const x = read(alignX, "alignX");
  const y = read(alignY, "alignY");
  const [primary, counter, counterName] = layoutMode === "HORIZONTAL" ? [x, y, "alignY"] : [y, x, "alignX"];
  if (counter === "SPACE_BETWEEN") {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `\`${field}${counterName}: space-between\` runs across a ${layoutMode.toLowerCase()} layout; it only works along it.`,
    );
  }
  if (primary !== undefined) out.primaryAxisAlignItems = primary;
  if (counter !== undefined) out.counterAxisAlignItems = counter;
  return out;
}

// ── wrapping rows ───────────────────────────────────────────────────────────

/** The wrap-only fields, as figma_set_auto_layout, figma_create_frame and the spec take them. */
export interface WrapFields {
  rowGap?: number;
  alignContent?: "AUTO" | "SPACE_BETWEEN";
}

/**
 * `rowGap` and `alignContent` from params. Figma applies counterAxisSpacing and
 * counterAxisAlignContent only to a frame that wraps, and throws on the latter
 * otherwise [C-095] — so both are refused unless `wrapsAfter`, before anything
 * changes.
 */
export function wrapFields(params: Record<string, unknown>, wrapsAfter: boolean, field = ""): WrapFields {
  const out: WrapFields = {};
  const rowGap = params.rowGap;
  if (rowGap !== undefined) {
    if (typeof rowGap !== "number" || !Number.isFinite(rowGap) || rowGap < 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}rowGap\` must be a number >= 0 (px between wrapped rows).`);
    }
    out.rowGap = rowGap;
  }
  const content = params.alignContent;
  if (content !== undefined) {
    const v = typeof content === "string" ? content.trim().toLowerCase() : "";
    if (v !== "auto" && v !== "space-between") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}alignContent\` must be auto or space-between.`);
    out.alignContent = v === "auto" ? "AUTO" : "SPACE_BETWEEN";
  }
  if ((out.rowGap !== undefined || out.alignContent) && !wrapsAfter) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}rowGap\` / \`${field}alignContent\` space wrapped rows: they need \`wrap: true\` on a horizontal layout.`);
  }
  return out;
}

/**
 * Apply wrap fields to a frame that wraps by now. When wrap has just been
 * turned on and no rowGap was given, the rows get the item gap rather than
 * touching — what a designer expects, and what the official wrapping recipe
 * sets [C-095] — and the result says so instead of doing it quietly. Returns
 * that `rowGap` note, if any.
 */
export function applyWrapFields(frame: FrameLike, w: WrapFields, turnedOn: boolean): string | undefined {
  const f = frame as FrameLike & { counterAxisSpacing?: number | null; counterAxisAlignContent?: string };
  let note: string | undefined;
  if (w.rowGap !== undefined) f.counterAxisSpacing = w.rowGap;
  else if (turnedOn && typeof f.itemSpacing === "number" && f.itemSpacing > 0) {
    f.counterAxisSpacing = f.itemSpacing;
    note = `${f.itemSpacing} (same as gap)`;
  }
  if (w.alignContent) f.counterAxisAlignContent = w.alignContent;
  return note;
}

// ── sizing: Figma's "Horizontal / Vertical sizing" dropdowns ───────────────

export type AxisSizing = "FIXED" | "HUG" | "FILL";
export interface Sizing {
  horizontal?: AxisSizing;
  vertical?: AxisSizing;
}

/**
 * `sizing` as a caller writes it: "fill" / "hug" / "fixed" for both axes, or
 * `{ horizontal, vertical }` per axis. Exactly the panel's vocabulary, so an
 * agent can say what a designer would click.
 */
export function parseSizing(raw: unknown, field = "sizing"): Sizing | undefined {
  if (raw === undefined || raw === null) return undefined;
  const one = (v: unknown, at: string): AxisSizing | undefined => {
    if (v === undefined) return undefined;
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    if (s === "FIXED" || s === "HUG" || s === "FILL") return s;
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` must be "fixed", "hug" or "fill".`);
  };
  if (typeof raw === "string") {
    const both = one(raw, field);
    return { horizontal: both, vertical: both };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return { horizontal: one(o.horizontal, `${field}.horizontal`), vertical: one(o.vertical, `${field}.vertical`) };
  }
  throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be "fixed", "hug", "fill", or { horizontal, vertical }.`);
}

/**
 * Set `layoutSizingHorizontal` / `layoutSizingVertical` (typings 1.141.0): the
 * same dropdowns as Figma's panel. HUG is valid only on auto-layout frames and
 * text, FILL only on children of an auto-layout — Figma throws otherwise, and
 * the message here says which rule was broken instead of passing its text on.
 * Must run AFTER the node is in its parent: FILL is a relation to the parent.
 */
export function applySizing(node: NodeLikeW, sizing: Sizing | undefined, field = "sizing"): void {
  if (!sizing) return;
  const n = node as unknown as Record<string, unknown>;
  const parent = node.parent as unknown as { layoutMode?: string } | null | undefined;
  const parentIsAuto = parent?.layoutMode === "HORIZONTAL" || parent?.layoutMode === "VERTICAL";
  const selfIsAuto = n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL";
  for (const [axis, prop] of [["horizontal", "layoutSizingHorizontal"], ["vertical", "layoutSizingVertical"]] as const) {
    const want = sizing[axis];
    if (!want) continue;
    if (want === "FILL" && !parentIsAuto) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.${axis}: fill\` needs a parent with auto-layout — this node's parent has none.`, {
        hint: "Give the parent auto-layout (figma_set_auto_layout), or use a fixed size.",
      });
    }
    if (want === "HUG" && !selfIsAuto && node.type !== "TEXT") {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.${axis}: hug\` works on auto-layout frames and text — this ${node.type} has no auto-layout.`);
    }
    n[prop] = want;
  }
  // A text that is given a width (fixed or fill) must wrap inside it; hugging
  // width-and-height would keep it on one line and run past the column [C-072].
  if (node.type === "TEXT" && (sizing.horizontal === "FILL" || sizing.horizontal === "FIXED") && n.textAutoResize === "WIDTH_AND_HEIGHT") {
    n.textAutoResize = "HEIGHT";
  }
}

// ── variable values ────────────────────────────────────────────────────────

/**
 * A variable value from the MCP string form (params.ts `variableValueParam`):
 * "#1a2b3c" for COLOR, "16" for FLOAT, any text for STRING, "true"/"false"
 * for BOOLEAN. Native JSON numbers and booleans are accepted too, so a caller
 * that is not the MCP server (a test, the mock) is not forced into strings.
 */
export function parseVariableValue(type: string, raw: unknown, field = "value"): unknown {
  if (type === "COLOR") {
    const paint = parseColor(raw, field);
    return { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: paint.opacity ?? 1 };
  }
  if (type === "FLOAT") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) throw new BridgeError(ErrorCode.INVALID_PARAM, `A FLOAT needs a number in \`${field}\` (e.g. "16").`);
    return n;
  }
  if (type === "BOOLEAN") {
    if (raw === true || raw === "true") return true;
    if (raw === false || raw === "false") return false;
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A BOOLEAN needs "true" or "false" in \`${field}\`.`);
  }
  if (type === "STRING") {
    if (typeof raw !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, `A STRING needs text in \`${field}\`.`);
    return raw;
  }
  throw new BridgeError(ErrorCode.UNSUPPORTED, `Variables of type ${type} cannot be set by this tool.`);
}

export interface LoadedFont {
  family: string;
  style: string;
  /** True when the requested font was unavailable and a fallback was used. */
  fellBack: boolean;
}

/**
 * Load a font, falling back through FONT_FALLBACK.
 *
 * Never silently substitutes: the result says `fellBack` and names the family
 * actually used, so a tool result can tell the agent that the design will not
 * look the way the spec asked. A silent substitution is how a design ships in
 * the wrong typeface.
 */
// ── font styles across families ────────────────────────────────────────────

const WEIGHT_WORDS: Array<[RegExp, number]> = [
  [/hairline|thin/, 100],
  [/extra\s*light|ultra\s*light/, 200],
  [/light/, 300],
  [/semi\s*bold|demi\s*bold/, 600],
  [/extra\s*bold|ultra\s*bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
  [/regular|normal|book|roman/, 400],
];

/** A style name's weight and slant, whatever the family calls it ("SemiBold", "Semi Bold Italic", "600"). */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const italic = /italic|oblique/.test(s);
  const numeric = /\b([1-9]00)\b/.exec(s);
  if (numeric) return { weight: Number(numeric[1]), italic };
  for (const [re, w] of WEIGHT_WORDS) if (re.test(s)) return { weight: w, italic };
  return { weight: 400, italic };
}

/** The available style closest to the one asked for: same slant first, then the nearest weight. */
export function nearestStyle(styles: readonly string[], wanted: string): string | undefined {
  const target = styleWeight(wanted);
  let best: { style: string; cost: number } | undefined;
  for (const s of styles) {
    const w = styleWeight(s);
    const cost = Math.abs(w.weight - target.weight) + (w.italic === target.italic ? 0 : 1000);
    if (!best || cost < best.cost) best = { style: s, cost };
  }
  return best?.style;
}

/**
 * The styles Figma has for a family (case-insensitive). The session's font
 * index (font-index.ts), refreshed when it is over a minute old: this runs after
 * a load failed, when a font installed since is the one being asked for.
 */
export async function stylesOf(figma: FigmaWrite, family: string): Promise<{ family: string; styles: string[] } | null> {
  try {
    const index = await fontIndex(figma, { maxAgeMs: 60_000 });
    return index?.byFamily.get(family.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** Test seam: forget the cached font list. */
export function resetFontCache(): void {
  resetFontIndex();
}

export async function loadFont(
  figma: FigmaWrite,
  family?: string,
  style?: string,
): Promise<LoadedFont> {
  const wanted = { family: family ?? FONT_FALLBACK[0]!.family, style: style ?? FONT_FALLBACK[0]!.style };
  const tried: string[] = [];

  const attempts = [{ family: wanted.family, style: wanted.style }];
  for (const f of FONT_FALLBACK) {
    if (f.family !== wanted.family || f.style !== wanted.style) attempts.push({ family: f.family, style: f.style });
    if (f.family === wanted.family && f.style !== wanted.style) attempts.push({ family: f.family, style: f.style });
  }

  // The exact name first.
  try {
    await figma.loadFontAsync(wanted);
    return { family: wanted.family, style: wanted.style, fellBack: false };
  } catch {
    tried.push(`${wanted.family} ${wanted.style}`);
  }

  // Then the same family, nearest style. Style NAMES differ between families —
  // Inter says "Semi Bold", Poppins "SemiBold" — so asking Poppins for weight 600
  // used to fall straight through to Inter: the right weight in the wrong
  // typeface, which is the one thing a font choice must not do.
  const styles = await stylesOf(figma, wanted.family);
  if (styles) {
    const near = nearestStyle(styles.styles, wanted.style);
    if (near) {
      try {
        await figma.loadFontAsync({ family: styles.family, style: near });
        const same = styleWeight(near).weight === styleWeight(wanted.style).weight && styleWeight(near).italic === styleWeight(wanted.style).italic;
        return { family: styles.family, style: near, fellBack: !same };
      } catch {
        tried.push(`${styles.family} ${near}`);
      }
    }
  }

  for (const font of attempts.slice(1)) {
    try {
      await figma.loadFontAsync(font);
      return {
        family: font.family,
        style: font.style,
        fellBack: font.family !== wanted.family || font.style !== wanted.style,
      };
    } catch {
      tried.push(`${font.family} ${font.style}`);
    }
  }

  let available: string[] = [];
  try {
    // The index stylesOf just read: a second full listing here would cost the same again.
    available = ((await fontIndex(figma, { maxAgeMs: 60_000 }))?.families ?? []).slice(0, 40).map((f) => f.family);
  } catch {
    /* listing is best-effort in the error message only */
  }

  throw new BridgeError(
    ErrorCode.FONT_LOAD_FAILED,
    `Could not load "${wanted.family} ${wanted.style}" and every fallback failed. Tried: ${tried.join(", ")}.`,
    {
      hint: available.length
        ? `Fonts available here include: ${available.join(", ")}. figma_get_fonts { families: ["<family>"] } checks one by name.`
        : "Pass a fontFamily that exists in this Figma.",
    },
  );
}

// ── styles & variables by name ──────────────────────────────────────────────

function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const prev = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (s[i - 1] === t[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[t.length]!;
}

export function nearest(name: string, candidates: readonly string[], n = 5): string[] {
  return [...candidates].sort((a, b) => distance(name, a) - distance(name, b)).slice(0, n);
}

export interface NamedRef {
  id: string;
  name: string;
}

/** Every local style of every kind, flattened, so a lookup can say what exists. */
export async function localStyles(figma: FigmaWrite): Promise<Array<NamedRef & { kind: string }>> {
  const out: Array<NamedRef & { kind: string }> = [];
  const readers: Array<[string, (() => Promise<ReadonlyArray<NamedRef>>) | undefined]> = [
    ["PAINT", figma.getLocalPaintStylesAsync?.bind(figma)],
    ["TEXT", figma.getLocalTextStylesAsync?.bind(figma)],
    ["EFFECT", figma.getLocalEffectStylesAsync?.bind(figma)],
    ["GRID", figma.getLocalGridStylesAsync?.bind(figma)],
  ];
  for (const [kind, read] of readers) {
    if (!read) continue;
    try {
      for (const s of await read()) out.push({ kind, id: s.id, name: s.name });
    } catch {
      /* an editor type without that style kind */
    }
  }
  return out;
}

export async function resolveStyleByName(
  figma: FigmaWrite,
  kind: "PAINT" | "TEXT" | "EFFECT" | "GRID",
  name: string,
): Promise<NamedRef> {
  const all = await localStyles(figma);
  const sameKind = all.filter((s) => s.kind === kind);
  const found = sameKind.find((s) => s.name === name);
  if (found) return { id: found.id, name: found.name };
  const names = sameKind.map((s) => s.name);
  throw new BridgeError(
    ErrorCode.INVALID_PARAM,
    `No ${kind.toLowerCase()} style named "${name}".`,
    {
      hint: names.length
        ? `Nearest: ${nearest(name, names).join(", ")}`
        : `This file defines no ${kind.toLowerCase()} styles yet.`,
    },
  );
}

export async function resolveVariableByName(figma: FigmaWrite, name: string): Promise<NamedRef> {
  const vars = (await figma.variables?.getLocalVariablesAsync?.()) ?? [];
  const found = vars.find((v) => v.name === name);
  if (found) return { id: found.id, name: found.name };
  const names = vars.map((v) => v.name);
  throw new BridgeError(
    ErrorCode.INVALID_PARAM,
    `No variable named "${name}".`,
    { hint: names.length ? `Nearest: ${nearest(name, names).join(", ")}` : "This file defines no variables yet." },
  );
}

// ── geometry ────────────────────────────────────────────────────────────────

export function num(params: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const v = params[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function requireInt(params: Record<string, unknown>, key: string): number {
  const n = num(params, key);
  if (n === undefined || !Number.isInteger(n) || n < 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` must be a non-negative integer.`);
  }
  return n;
}

/**
 * Where a new node should be attached: an explicit parent, or the current page.
 *
 * A SLOT is a parent too: filling a slot of an instance is appending to it
 * [C-112]. A page other than the current one is loaded first — under
 * documentAccess "dynamic-page" its appendChild throws until loadAsync has run
 * [C-090] — and since this runs in every create's pre-check, the load happens
 * before anything exists.
 *
 * An instance, or a layer inside one, takes no new children [C-123]: Figma
 * refuses the append only after the node exists, leaving it on the page, so
 * the refusal comes here. The nearest SLOT or INSTANCE decides — a slot's
 * content belongs to the instance's user, not to its main component.
 *
 * In Figma Slides a layer belongs on a SLIDE, which is frame-like
 * (BaseFrameMixin, plugin-api.d.ts:12300) [C-136]. The SLIDE_GRID holds rows
 * and a SLIDE_ROW holds slides, nothing else (Working in Slides) [C-134], so
 * both are refused here, before anything exists. With no parentId a Slides
 * call goes where Figma itself puts a new node in single-slide view — the
 * focused slide (d.ts:3351-3356, 10737) — and is refused when no slide is
 * focused: the page itself is the grid's canvas, outside every slide.
 */
export async function parentFor(figma: FigmaWrite, parentId?: string): Promise<NodeLikeW> {
  if (!parentId) return defaultParent(figma);
  const node = await figma.getNodeByIdAsync(parentId);
  if (!node) {
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${parentId}\` to use as a parent.`, { hint: TEMPORARY_ID_HINT });
  }
  if (node.type === "SLIDE_ROW" || node.type === "SLIDE_GRID") {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `A ${node.type} holds ${node.type === "SLIDE_GRID" ? "the deck's rows" : "slides"}, not layers: use a SLIDE id from figma_get_slide_grid.`,
    );
  }
  const canHold = ["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "SLOT", "SLIDE", "PAGE", "PAGE_NODE"];
  if (!canHold.includes(node.type)) {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `A ${node.type} cannot contain children. Use a frame, group, component, section, slot, slide or page.`,
    );
  }
  let owner: NodeLikeW | null | undefined = node;
  while (owner && owner.type !== "SLOT" && owner.type !== "INSTANCE") owner = owner.parent;
  if (owner?.type === "INSTANCE") {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `"${node.name}" is ${owner === node ? "an instance" : `inside the instance "${owner.name}"`}, which takes no new children.`,
      { hint: "Add children to the main component, or to a slot of the instance." },
    );
  }
  await ensureLoaded(node);
  return node;
}

/** The parent a create takes when the call names none: the focused slide in Slides, else the current page. */
async function defaultParent(figma: FigmaWrite): Promise<NodeLikeW> {
  if (editorType() !== "slides") return figma.currentPage;
  const focused = tryGet<NodeLikeW | null>(figma.currentPage, "focusedSlide");
  if (focused.ok && focused.value && focused.value.type === "SLIDE") return focused.value;
  const ids = slideIds(figma, 6);
  const listed = ids.length ? ` — e.g. ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}` : "";
  throw new BridgeError(
    ErrorCode.INVALID_PARAM,
    `In Figma Slides a new layer goes on a slide, and no slide is focused: pass parentId = a slide id${listed}.`,
    { hint: ids.length ? "figma_get_slide_grid lists every slide by row." : "The deck has no slides yet: figma_create_slides makes some." },
  );
}

/** The first `limit` slide ids of the deck, row by row; [] when the grid cannot be read. */
export function slideIds(figma: FigmaWrite, limit: number): string[] {
  const out: string[] = [];
  const g = figmaGlobal() as Record<string, unknown> | undefined;
  for (const name of ["getCanvasGrid", "getSlideGrid"]) {
    const read = tryGet<(() => ReadonlyArray<ReadonlyArray<NodeLikeW>>) | undefined>(g, name);
    if (!read.ok || typeof read.value !== "function") continue;
    try {
      for (const row of read.value.call(g)) for (const n of row) if (n.type === "SLIDE" && out.length < limit) out.push(n.id);
      return out;
    } catch {
      /* the next reader, or the tree below */
    }
  }
  // SLIDE_GRID → SLIDE_ROW → SLIDE; both are opaque but keep ChildrenMixin (d.ts:12325, 12338) [C-136].
  for (const grid of figma.currentPage.children ?? []) {
    for (const row of grid.type === "SLIDE_GRID" ? grid.children ?? [] : []) {
      for (const s of row.children ?? []) if (s.type === "SLIDE" && out.length < limit) out.push(s.id);
    }
  }
  return out;
}

/** The SLIDE `node` is, or sits in; null outside every slide. */
export function slideOf(node: NodeLikeW | null | undefined): NodeLikeW | null {
  for (let n = node; n; n = n.parent) if (n.type === "SLIDE") return n;
  return null;
}

// ── position ─────────────────────────────────────────────────────────────────

/** What a placement reads and writes. x and y are relativeTransform's translation column [C-186]. */
export interface Placeable {
  x?: number;
  y?: number;
  relativeTransform?: unknown;
}

export type Matrix = [[number, number, number], [number, number, number]];

/** A 2×3 transform, as relativeTransform reads. */
export function isMatrix(m: unknown): m is Matrix {
  return Array.isArray(m) && m.length === 2 && m.every((row) => Array.isArray(row) && row.length === 3 && row.every((v) => typeof v === "number" && Number.isFinite(v)));
}

/**
 * Put a node at (tx, ty), in ONE write when both are given. x and y are one
 * stored matrix [C-186], so two setters rewrite it twice. On 2026-10-09 a move
 * through the id a create call had returned, while Figma listed the layer
 * under a second id, kept y and lost x, three times, each answering ok [C-203]:
 * the second write started from the matrix as it was before the first. The
 * 2×2 part is kept as read, so a turned or mirrored node stays so. One
 * coordinate alone is one setter, which never lost anything.
 */
export function place(node: Placeable, tx: number | undefined, ty: number | undefined): void {
  const m = tx !== undefined && ty !== undefined ? node.relativeTransform : undefined;
  if (isMatrix(m)) {
    node.relativeTransform = [[m[0][0], m[0][1], tx!], [m[1][0], m[1][1], ty!]];
    return;
  }
  if (tx !== undefined) node.x = tx;
  if (ty !== undefined) node.y = ty;
}

const px = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v));

/** How far a read-back coordinate may sit from the asked one: 0.01 px, more far from the origin where float noise grows. */
export const placementTolerance = (want: number) => Math.max(0.01, Math.abs(want) * 1e-6);

/**
 * Null when the node is at (tx, ty) within placementTolerance, read through a
 * fresh lookup rather than the object that was written; otherwise where Figma
 * kept it, for the item's error. `ok` means the layer is where it was asked to
 * be [C-250] — the three lost moves of 2026-10-09 all said ok.
 */
export async function missedPlacement(
  figma: Pick<FigmaWrite, "getNodeByIdAsync">,
  id: string,
  tx: number | undefined,
  ty: number | undefined,
): Promise<string | null> {
  const now = (await figma.getNodeByIdAsync(id)) as unknown as Placeable | null;
  if (!now) return "it could not be read back after the write";
  const missed = (want: number | undefined, got: unknown) => want !== undefined && !(typeof got === "number" && Math.abs(got - want) <= placementTolerance(want));
  if (!missed(tx, now.x) && !missed(ty, now.y)) return null;
  const asked = [tx !== undefined ? `x ${px(tx)}` : "", ty !== undefined ? `y ${px(ty)}` : ""].filter(Boolean).join(", ");
  return `Figma kept it at x ${px(now.x)}, y ${px(now.y)} (asked ${asked})`;
}

/**
 * Resize a frame-like node. A SECTION goes through resizeWithoutConstraints,
 * which the typings and the official notes both give it (d.ts:12285;
 * create-section.md:52) — its plain resize() is contradicted [C-141], so it is
 * reached only on a node without the other.
 */
export function resizeNode(node: NodeLikeW, w: number, h: number): void {
  const n = node as unknown as { resize?(w: number, h: number): void; resizeWithoutConstraints?(w: number, h: number): void };
  if (node.type === "SECTION" && typeof n.resizeWithoutConstraints === "function") n.resizeWithoutConstraints(w, h);
  else n.resize!(w, h);
}

/** Append, with a hint when Figma refuses because of auto-layout or slot rules. */
export function append(parent: NodeLikeW, child: NodeLikeW): void {
  const holder = parent as unknown as FrameLike;
  // A node already parented must be moved, not appended twice. A slot takes the
  // checked path: every new node starts on the page, so skipping the catch
  // there would lose the slot rule exactly when it applies.
  if (child.parent && child.parent.id !== parent.id && typeof child.remove === "function" && parent.type !== "SLOT") {
    parent.appendChild!(child);
    return;
  }
  try {
    parent.appendChild!(child);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parent.type === "SLOT") {
      // The official component patterns keep components and sections out of a
      // slot [C-112]; Figma's own text is passed on with the rule beside it.
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the child in a slot: ${message}`, {
        hint: "A slot cannot hold a component, a component set or a section; place an instance or a frame instead.",
      });
    }
    if (/parent|child|append/i.test(message)) {
      if (holder.layoutMode && holder.layoutMode !== "NONE") {
        throw new BridgeError(
          ErrorCode.INVALID_PARAM,
          `Figma refused the child: a node with auto-layout only accepts certain children (${message}).`,
          { hint: "A frame with layoutMode cannot take a GROUP or SECTION as a child." },
        );
      }
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the child node: ${message}`);
    }
    throw err;
  }
}
