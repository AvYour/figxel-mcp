// figma_get_design_context — what a designer reads off the layers panel and the
// right-hand panel for a subtree, compact enough to sit in a model's context.
//
// Field names extend read.ts's geometry DTO (layoutMode, width, padding, fill,
// sizing, …), so every read tool speaks one dialect; this adds what geometry
// alone cannot say: text (content, font, size, line height, runs), strokes,
// effects, every fill, the styles and variables a node is bound to — by NAME,
// with the keys a library import needs — and which component an instance
// comes from.
//
// Honesty rules carried over from read.ts: a value Figma reports as `mixed` is
// reported as "mixed", never as one of its parts; a fill that is not solid is
// described, not approximated into a hex; and anything cut short says so.
// Every field below is emitted only when it differs from Figma's default, so
// its presence means something.
//
// API per @figma/plugin-typings 1.141.0 under documentAccess "dynamic-page":
// style ids are readable (only their setters are async-only), an instance's
// component comes from getMainComponentAsync() (the `mainComponent` getter is
// write-only there), and a variable's value for a node from resolveForConsumer.
//
// FigJam and Slides nodes add their own blocks (board-read.ts), and outside
// Figma Design every member is read through a guard, since a missing one may
// throw there [C-145].

import { BridgeError, ErrorCode } from "../shared/errors.js";
import {
  MAX_TABLE_CELLS,
  OPAQUE_TYPES,
  childrenOf,
  describeBoard,
  field,
  guardAll,
  opaqueBox,
  readView,
  resolveEdges,
  type ConnectorEdge,
} from "./board-read.js";
import type { YieldToHost } from "./chunk.js";
import {
  describeValue,
  effectText,
  hex,
  isMixed,
  layoutGridText,
  letterSpacing,
  lineHeight,
  num,
  overflowText,
  paintText,
  r2,
} from "./dialect.js";
import { tracksToFieldNames } from "./motion-fields.js";
import type { NodeLike } from "./read.js";
import { linkText, listKind, readSegments, sfSymbols, styledRuns } from "./text-runs.js";

export interface ContextOptions {
  depth: number;
  maxNodes: number;
  maxChildren: number;
  includeGeometry: boolean;
  includeStyles: boolean;
  includeVariables: boolean;
  /** Characters of text shown per node before it is cut. Default 400. */
  maxTextChars?: number;
  /** Per-node annotations (label and category). Default true. */
  includeAnnotations?: boolean;
  /** Per-node CSS from getCSSAsync — the inspect panel's own [C-091]. Default false. */
  includeCss?: boolean;
  /** Cells read per FigJam table before it is cut. Default 500. */
  maxTableCells?: number;
  /** Per-node `abs`: the box on the page (absoluteBoundingBox), where x/y are parent-relative. Default false. */
  absolute?: boolean;
}

/** Text shown per node unless the caller asks for more. */
export const MAX_TEXT_CHARS = 400;
const MAX_RUNS = 50;

interface Ctx {
  yieldToHost: YieldToHost;
  isCancelled(): boolean;
}

export interface ContextNode {
  id: string;
  name: string;
  type: string;
  [field: string]: unknown;
  children?: ContextNode[];
}

type Any = Record<string, unknown>;

/** Contrast-relevant luminance (WCAG 2.x), from 0–1 sRGB channels. */
export function luminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); // WCAG 2.2 glossary [C-075]
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface StyleUsed {
  id: string;
  name: string;
  type: string;
  key?: string;
  remote?: true;
}

export interface VariableUsed {
  id: string;
  name: string;
  type: string;
  key?: string;
  remote?: true;
  collection?: string;
  codeSyntax?: Record<string, string>;
  value?: unknown;
}

export interface ComponentUsed {
  id: string;
  name: string;
  key?: string;
  remote?: true;
  setId?: string;
  setKey?: string;
  setName?: string;
}

const keyOf = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Lookups that need the async API, each asked once per call, plus the per-call probes. */
class Names {
  private styles = new Map<string, Omit<StyleUsed, "id"> | null>();
  private vars = new Map<string, { name: string; type: string } | null>();
  private collections = new Map<string, { name: string; modes: ReadonlyArray<{ modeId: string; name: string }> } | null>();
  private categories = new Map<string, string | null>();
  readonly stylesUsed = new Map<string, StyleUsed>();
  readonly variablesUsed = new Map<string, VariableUsed>();
  readonly componentsUsed = new Map<string, ComponentUsed>();
  /** getCSSAsync: off after its first failure, with the reason; time spent, so its cost can be measured [C-091]. */
  readonly css = { on: true, ms: 0, note: undefined as string | undefined };
  /** Motion is a per-user beta: once Figma says it is not supported, stop asking for this call [C-115]. */
  motionOff = false;
  /** Text nodes whose characters were cut at maxTextChars. */
  textCut = 0;
  /** Tables whose cells were cut at maxTableCells. */
  tableCut = 0;
  /** Connectors met, with their raw endpoints, for the result's edge list. */
  readonly edges: Array<{ edge: ConnectorEdge; start: unknown; end: unknown }> = [];
  /** Every node read, id → name, so an edge names the endpoints this read reached without a lookup. */
  readonly seen = new Map<string, string>();
  /** Read every node through the guard: true outside Figma Design [C-145]. */
  readonly guard = guardAll();
  private figma = (globalThis as unknown as { figma: Any }).figma;

  /** getNodeByIdAsync, when there is an API to ask. */
  lookup(): ((id: string) => Promise<{ name?: unknown } | null>) | undefined {
    const get = this.figma?.getNodeByIdAsync as ((id: string) => Promise<{ name?: unknown } | null>) | undefined;
    return typeof get === "function" ? (id) => get.call(this.figma, id) : undefined;
  }

  async style(id: unknown): Promise<string | undefined> {
    if (typeof id !== "string" || id === "") return undefined;
    if (!this.styles.has(id)) {
      const get = this.figma.getStyleByIdAsync as ((id: string) => Promise<{ name: string; type: string; remote?: boolean; key?: string } | null>) | undefined;
      const s = get ? await get.call(this.figma, id).catch(() => null) : null;
      this.styles.set(id, s ? { name: s.name, type: s.type, ...(keyOf(s.key) ? { key: s.key } : {}), ...(s.remote ? { remote: true as const } : {}) } : null);
    }
    const s = this.styles.get(id);
    if (!s) return undefined;
    // With its id: a style from a library is not in figma_get_styles (local only),
    // and the id is how figma_apply_style_to_node can reuse it on new nodes.
    this.stylesUsed.set(id, { id, ...s });
    return s.name;
  }

  async collection(id: unknown): Promise<{ name: string; modes: ReadonlyArray<{ modeId: string; name: string }> } | undefined> {
    if (typeof id !== "string" || id === "") return undefined;
    if (!this.collections.has(id)) {
      const api = this.figma.variables as Any | undefined;
      const get = api?.getVariableCollectionByIdAsync as ((id: string) => Promise<Any | null>) | undefined;
      const c = get ? await get.call(api, id).catch(() => null) : null;
      this.collections.set(id, c ? { name: String(c.name), modes: Array.isArray(c.modes) ? (c.modes as Array<{ modeId: string; name: string }>) : [] } : null);
    }
    return this.collections.get(id) ?? undefined;
  }

  async variable(id: unknown, consumer: unknown): Promise<string | undefined> {
    if (typeof id !== "string" || id === "") return undefined;
    const api = this.figma.variables as Any | undefined;
    if (!this.vars.has(id)) {
      const get = api?.getVariableByIdAsync as ((id: string) => Promise<Any | null>) | undefined;
      const v = get ? await get.call(api, id).catch(() => null) : null;
      this.vars.set(id, v ? { name: String(v.name), type: String(v.resolvedType) } : null);
      if (v && typeof v.resolveForConsumer === "function" && !this.variablesUsed.has(id)) {
        let value: unknown;
        try {
          value = describeValue((v.resolveForConsumer as (c: unknown) => { value: unknown }).call(v, consumer).value);
        } catch {
          value = undefined;
        }
        // id, key and remote are what binding needs: figma_bind_variable_to_node
        // takes the id, a library variable already in the file included.
        const coll = await this.collection(v.variableCollectionId);
        const syntax = v.codeSyntax && typeof v.codeSyntax === "object" && Object.keys(v.codeSyntax).length ? (v.codeSyntax as Record<string, string>) : undefined;
        this.variablesUsed.set(id, {
          id,
          name: String(v.name),
          type: String(v.resolvedType),
          ...(keyOf(v.key) ? { key: v.key as string } : {}),
          ...(v.remote === true ? { remote: true as const } : {}),
          ...(coll ? { collection: coll.name } : {}),
          ...(syntax ? { codeSyntax: syntax } : {}),
          ...(value !== undefined ? { value } : {}),
        });
      }
    }
    const v = this.vars.get(id);
    return v?.name;
  }

  async category(id: unknown): Promise<string | undefined> {
    if (typeof id !== "string" || id === "") return undefined;
    if (!this.categories.has(id)) {
      const api = this.figma.annotations as Any | undefined;
      const get = api?.getAnnotationCategoryByIdAsync as ((id: string) => Promise<{ label?: string } | null>) | undefined;
      const c = get ? await get.call(api, id).catch(() => null) : null;
      this.categories.set(id, c && typeof c.label === "string" ? c.label : null);
    }
    return this.categories.get(id) ?? undefined;
  }
}

/** One paint as a designer would say it, with the name of a variable bound to its colour. */
async function paint(p: Any, names: Names, consumer: unknown, opts: ContextOptions, w: number, h: number): Promise<string> {
  let variable: string | undefined;
  if (opts.includeVariables) {
    const bound = (p.boundVariables as Any | undefined)?.color as { id?: string } | undefined;
    variable = await names.variable(bound?.id, consumer);
  }
  return paintText(p, w, h, variable);
}

async function paints(list: unknown, names: Names, consumer: unknown, opts: ContextOptions, w = 1, h = 1): Promise<string[] | "mixed" | undefined> {
  if (isMixed(list)) return "mixed";
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: string[] = [];
  for (const p of list) out.push(await paint(p as Any, names, consumer, opts, w, h));
  return out;
}

const SIZING: Record<string, string> = { FIXED: "FIXED", HUG: "HUG", FILL: "FILL", AUTO: "HUG" };
const AXIS_ALIGN: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };
// The words figma_set_constraints takes, so a constraint read here can be written back as is.
const H_CONSTRAINT: Record<string, string> = { MIN: "left", MAX: "right", CENTER: "center", STRETCH: "left-right", SCALE: "scale" };
const V_CONSTRAINT: Record<string, string> = { MIN: "top", MAX: "bottom", CENTER: "center", STRETCH: "top-bottom", SCALE: "scale" };

/**
 * Per screen axis, the way Figma's own panel shows it. `layoutSizingHorizontal`
 * / `Vertical` are already screen axes (typings 1.141.0); the older primary /
 * counter modes are axes OF THE LAYOUT, so in a vertical stack "primary" is the
 * height — mapping primary → horizontal unconditionally swaps them.
 */
export function screenSizing(n: Any): { horizontal: string; vertical: string } | undefined {
  const h = n.layoutSizingHorizontal;
  const v = n.layoutSizingVertical;
  if (typeof h === "string" && typeof v === "string") return { horizontal: SIZING[h] ?? h, vertical: SIZING[v] ?? v };
  const mode = n.layoutMode;
  const p = n.primaryAxisSizingMode;
  const c = n.counterAxisSizingMode;
  if ((mode === "HORIZONTAL" || mode === "VERTICAL") && typeof p === "string" && typeof c === "string") {
    const [hor, ver] = mode === "HORIZONTAL" ? [p, c] : [c, p];
    return { horizontal: SIZING[hor] ?? hor, vertical: SIZING[ver] ?? ver };
  }
  return undefined;
}

function radius(n: Any): number | number[] | "mixed" | undefined {
  const single = num(n.cornerRadius);
  if (single !== undefined) return single === 0 ? undefined : r2(single);
  const corners = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(num);
  if (corners.every((c) => c !== undefined)) {
    const cs = corners as number[];
    return cs.every((c) => c === cs[0]) ? (cs[0] === 0 ? undefined : r2(cs[0]!)) : cs.map(r2);
  }
  return isMixed(n.cornerRadius) ? "mixed" : undefined;
}

const hasAutoLayout = (n: Any | undefined) => n?.layoutMode === "HORIZONTAL" || n?.layoutMode === "VERTICAL" || n?.layoutMode === "GRID";

/** A GRID track as CSS would size it: "120" px, "1fr", "hug". */
function track(t: unknown): string {
  const s = (t ?? {}) as { type?: string; value?: number };
  if (s.type === "FIXED") return String(r2(num(s.value) ?? 0));
  if (s.type === "FLEX") return `${r2(num(s.value) ?? 1)}fr`;
  return String(s.type ?? "auto").toLowerCase();
}

/** Read a getter that may throw on a node type that does not have it. */
function safe(n: Any, key: string): unknown {
  try {
    return n[key];
  } catch {
    return undefined;
  }
}

/** The structure a geometry read cannot see: wrap rows, grids, limits, masks, constraints [G-08]. */
function structure(n: Any, node: NodeLike, parent: Any | undefined, out: ContextNode): void {
  const layout = n.layoutMode;
  if (n.layoutWrap === "WRAP") {
    const rowGap = num(n.counterAxisSpacing);
    if (rowGap !== undefined) out.rowGap = r2(rowGap);
    if (n.counterAxisAlignContent === "SPACE_BETWEEN") out.alignContent = "space-between";
  }
  if (hasAutoLayout(n)) {
    if (n.strokesIncludedInLayout === true) out.strokesInLayout = true;
    if (n.itemReverseZIndex === true) out.reverseZIndex = true;
  }
  if (layout === "GRID") {
    const g: Any = {};
    for (const [k, field] of [["rows", "gridRowCount"], ["columns", "gridColumnCount"], ["rowGap", "gridRowGap"], ["columnGap", "gridColumnGap"]] as const) {
      const v = num(n[field]);
      if (v !== undefined) g[k] = r2(v);
    }
    if (Array.isArray(n.gridRowSizes)) g.rowSizes = (n.gridRowSizes as unknown[]).map(track);
    if (Array.isArray(n.gridColumnSizes)) g.columnSizes = (n.gridColumnSizes as unknown[]).map(track);
    out.grid = g;
  }
  if (parent?.layoutMode === "GRID") {
    const c: Any = {};
    const row = num(n.gridRowAnchorIndex);
    const col = num(n.gridColumnAnchorIndex);
    if (row !== undefined) c.row = row;
    if (col !== undefined) c.column = col;
    if ((num(n.gridRowSpan) ?? 1) > 1) c.rowSpan = n.gridRowSpan;
    if ((num(n.gridColumnSpan) ?? 1) > 1) c.columnSpan = n.gridColumnSpan;
    if (Object.keys(c).length) out.gridChild = c;
  }
  // Constraints decide resizing only where no auto-layout positions the node.
  const free = parent !== undefined && parent.type !== "PAGE" && parent.type !== "DOCUMENT" && (!hasAutoLayout(parent) || n.layoutPositioning === "ABSOLUTE");
  const cons = n.constraints as { horizontal?: string; vertical?: string } | undefined;
  if (free && cons && (cons.horizontal !== "MIN" || cons.vertical !== "MIN")) {
    out.constraints = { horizontal: H_CONSTRAINT[cons.horizontal ?? ""] ?? cons.horizontal, vertical: V_CONSTRAINT[cons.vertical ?? ""] ?? cons.vertical };
  }
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const v = num(n[k]);
    if (v !== undefined) out[k] = r2(v);
  }
  if (n.isMask === true) out.mask = { type: String(n.maskType ?? "ALPHA").toLowerCase() };
  if (node.type === "BOOLEAN_OPERATION" && typeof n.booleanOperation === "string") out.booleanOperation = n.booleanOperation.toLowerCase();
  const smoothing = num(n.cornerSmoothing);
  if (smoothing) out.cornerSmoothing = r2(smoothing);
  if (Array.isArray(n.layoutGrids) && n.layoutGrids.length) out.layoutGrids = (n.layoutGrids as Any[]).map(layoutGridText);
  const overflow = overflowText(n.overflowDirection);
  if (overflow) out.overflow = overflow;
  const fixed = num(n.numberOfFixedChildren);
  if (fixed) out.fixedChildren = fixed;
}

async function textOf(node: NodeLike, n: Any, names: Names, opts: ContextOptions): Promise<Any> {
  const max = opts.maxTextChars ?? MAX_TEXT_CHARS;
  const chars = typeof n.characters === "string" ? n.characters : "";
  const text: Any = { characters: chars.length > max ? `${chars.slice(0, max)}…` : chars };
  if (chars.length > max) {
    text.length = chars.length;
    names.textCut++;
  }
  const font = n.fontName as { family?: string; style?: string } | symbol | undefined;
  text.font = isMixed(font) ? "mixed" : font ? `${font.family} ${font.style}` : undefined;
  text.weight = isMixed(n.fontWeight) ? "mixed" : num(n.fontWeight);
  text.fontSize = isMixed(n.fontSize) ? "mixed" : num(n.fontSize);
  const lh = lineHeight(n.lineHeight);
  if (lh) text.lineHeight = lh;
  const ls = letterSpacing(n.letterSpacing);
  if (ls) text.letterSpacing = ls;
  if (typeof n.textAlignHorizontal === "string" && n.textAlignHorizontal !== "LEFT") text.align = n.textAlignHorizontal.toLowerCase();
  if (typeof n.textAlignVertical === "string" && n.textAlignVertical !== "TOP") text.alignVertical = n.textAlignVertical.toLowerCase();
  if (typeof n.textCase === "string" && n.textCase !== "ORIGINAL") text.case = n.textCase.toLowerCase();
  if (typeof n.textDecoration === "string" && n.textDecoration !== "NONE") text.decoration = n.textDecoration.toLowerCase();
  const resize: Record<string, string> = { WIDTH_AND_HEIGHT: "hug", HEIGHT: "wrap", NONE: "fixed", TRUNCATE: "truncate" };
  if (typeof n.textAutoResize === "string") text.resize = resize[n.textAutoResize] ?? n.textAutoResize;
  // textTruncation is the current API for an ellipsis; TRUNCATE above is its deprecated twin [C-103].
  if (n.textTruncation === "ENDING") {
    text.truncate = true;
    const lines = num(n.maxLines);
    if (lines !== undefined) text.maxLines = lines;
  }
  for (const k of ["paragraphSpacing", "paragraphIndent"] as const) {
    const v = n[k];
    if (isMixed(v)) text[k] = "mixed";
    else if ((num(v) ?? 0) > 0) text[k] = r2(v as number);
  }
  if (isMixed(n.leadingTrim)) text.leadingTrim = "mixed";
  else if (n.leadingTrim === "CAP_HEIGHT") text.leadingTrim = "cap-height";
  const link = linkText(n.hyperlink);
  if (link) text.link = link;
  const ot = n.openTypeFeatures;
  if (isMixed(ot)) text.openType = "mixed";
  else if (ot && typeof ot === "object" && Object.keys(ot).length) text.openType = { ...(ot as Any) };
  const [w, h] = [num(n.width) ?? 1, num(n.height) ?? 1];
  const color = await paints(n.fills, names, node, opts, w, h);
  if (color) text.color = color.length === 1 && Array.isArray(color) ? color[0] : color;

  const segments = readSegments(n);
  if (segments) {
    const list = listKind(segments);
    if (list) text.list = list;
    if (opts.includeStyles) {
      const runs = await styledRuns(segments, max, MAX_RUNS, {
        color: async (fills) => {
          const p = await paints(fills, names, node, opts, w, h);
          return Array.isArray(p) && p.length === 1 ? p[0] : p === "mixed" ? undefined : p;
        },
        style: (id) => names.style(id),
      });
      if (runs) Object.assign(text, runs);
    }
  }
  const families = [
    ...(font && !isMixed(font) && (font as { family?: string }).family ? [(font as { family: string }).family] : []),
    ...(segments ?? []).map((s) => s.fontName?.family ?? ""),
  ];
  const symbols = sfSymbols(chars, families);
  if (symbols) text.sfSymbols = symbols;
  for (const k of Object.keys(text)) if (text[k] === undefined) delete text[k];
  return text;
}

/** The page box (absoluteBoundingBox), rounded; x/y elsewhere are relative to the parent. */
function absBox(n: unknown): Any | undefined {
  const b = field<{ x: number; y: number; width: number; height: number } | null>(n, "absoluteBoundingBox");
  return b && num(b.width) !== undefined ? { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) } : undefined;
}

/**
 * SLIDE_GRID, SLIDE_ROW, INTERACTIVE_SLIDE_ELEMENT: the box and nothing else.
 * They have no fills, effects or layout, and reading one throws [C-136]
 * (slide-gotchas.md:181-203), so no other member is touched.
 */
function describeOpaque(node: NodeLike, opts: ContextOptions): ContextNode {
  const out: ContextNode = { id: node.id, name: node.name, type: node.type, opaque: true };
  if (field(node, "visible") === false) out.visible = false;
  if (opts.includeGeometry) for (const [k, v] of Object.entries(opaqueBox(node))) out[k] = r2(v as number);
  if (opts.absolute) {
    const abs = absBox(node);
    if (abs) out.abs = abs;
  }
  const kind = field(node, "interactiveSlideElementType");
  if (typeof kind === "string") out.interactiveType = kind;
  return out;
}

async function describe(node: NodeLike, parentNode: Any | undefined, names: Names, opts: ContextOptions): Promise<ContextNode> {
  if (OPAQUE_TYPES.has(node.type)) return describeOpaque(node, opts);
  // Outside Figma Design a member a node lacks may throw on read [C-145]:
  // there, and on the FigJam / Slides types everywhere, read through the guard.
  const n = readView(node, names.guard);
  // An opaque parent (a slide's SLIDE_ROW) has no layout to read: only its type is passed on.
  const parentType = parentNode ? String(field(parentNode, "type")) : "";
  const parent = !parentNode ? undefined : OPAQUE_TYPES.has(parentType) ? { type: parentType } : names.guard ? readView(parentNode, true) : parentNode;
  const out: ContextNode = { id: node.id, name: node.name, type: node.type };
  if (n.visible === false) out.visible = false;
  const w = num(n.width) ?? 1;
  const h = num(n.height) ?? 1;
  if (opts.absolute) {
    const abs = absBox(n);
    if (abs) out.abs = abs;
  }

  if (opts.includeGeometry) {
    for (const k of ["x", "y", "width", "height"] as const) {
      const v = num(n[k]);
      if (v !== undefined) out[k] = r2(v);
    }
    const layout = n.layoutMode;
    if (layout === "HORIZONTAL" || layout === "VERTICAL" || layout === "GRID") {
      out.layoutMode = layout;
      const gap = num(n.itemSpacing);
      if (gap !== undefined) out.itemSpacing = r2(gap);
      const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((p) => num(p) ?? 0);
      if (pad.some((p) => p !== 0)) out.padding = { top: pad[0], right: pad[1], bottom: pad[2], left: pad[3] };
      const main = AXIS_ALIGN[String(n.primaryAxisAlignItems)];
      const cross = AXIS_ALIGN[String(n.counterAxisAlignItems)];
      if (main && main !== "start") out.alignMain = main;
      if (cross && cross !== "start") out.alignCross = cross;
      if (n.layoutWrap === "WRAP") out.wrap = true;
    }
    const sizing = screenSizing(n);
    if (sizing) out.sizing = sizing;
    if (n.layoutPositioning === "ABSOLUTE") out.positioning = "absolute";
    const rad = radius(n);
    if (rad !== undefined) out.cornerRadius = rad;
    const op = num(n.opacity);
    if (op !== undefined && op < 0.995) out.opacity = r2(op);
    const rot = num(n.rotation);
    if (rot) out.rotation = r2(rot);
    if (typeof n.blendMode === "string" && !["NORMAL", "PASS_THROUGH"].includes(n.blendMode)) out.blendMode = n.blendMode;
    if (n.clipsContent === true) out.clipsContent = true;
    if (n.locked === true) out.locked = true;
    structure(n, node, parent, out);
  }

  if (node.type !== "TEXT") {
    const fills = await paints(n.fills, names, node, opts, w, h);
    if (fills) {
      out.fills = fills;
      // The read.ts single-colour shorthand, kept so every read tool agrees.
      const first = Array.isArray(n.fills) ? (n.fills[0] as Any | undefined) : undefined;
      if (Array.isArray(n.fills) && n.fills.length === 1 && first?.type === "SOLID" && first.visible !== false) {
        out.fill = hex(first.color as { r: number; g: number; b: number });
      }
    }
  }
  const strokes = await paints(n.strokes, names, node, opts, w, h);
  if (strokes) {
    out.strokes = strokes;
    const sw = num(n.strokeWeight);
    const sides = [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight].map(num);
    if (sw !== undefined) out.strokeWeight = r2(sw);
    // Per-side weights read as "mixed" as a whole; the sides themselves are the answer.
    else if (sides.every((s) => s !== undefined)) out.strokeWeights = { top: r2(sides[0]!), right: r2(sides[1]!), bottom: r2(sides[2]!), left: r2(sides[3]!) };
    else out.strokeWeight = "mixed";
    if (typeof n.strokeAlign === "string" && n.strokeAlign !== "INSIDE") out.strokeAlign = n.strokeAlign;
    if (Array.isArray(n.dashPattern) && n.dashPattern.length) out.dashPattern = n.dashPattern;
  }
  if (Array.isArray(n.effects) && n.effects.length) out.effects = (n.effects as Any[]).map(effectText);

  // Figma's own icon / image heuristic, the one codegen plugins use [C-093].
  if (safe(n, "isAsset") === true) {
    const image = Array.isArray(n.fills) && (n.fills as Any[]).some((p) => p?.type === "IMAGE" && p.visible !== false);
    out.asset = image ? "image" : "icon";
  }

  if (node.type === "TEXT") out.text = await textOf(node, n, names, opts);
  else if (names.guard || n !== (node as unknown)) {
    // A sticky's, a shape's, a connector's text, a table's cells, a slide's
    // place in the grid: the content a Design read never looks for.
    await describeBoard(node, n, out, {
      text: (holder) => textOf(node, holder, names, opts),
      maxTextChars: opts.maxTextChars ?? MAX_TEXT_CHARS,
      maxTableCells: opts.maxTableCells ?? MAX_TABLE_CELLS,
      textCut: () => void names.textCut++,
      tableCut: () => void names.tableCut++,
      connector: (edge, start, end) => void names.edges.push({ edge, start, end }),
      boardMembers: names.guard,
    });
  }

  if (opts.includeStyles) {
    const refs: Any = {};
    for (const [field, key] of [["fill", "fillStyleId"], ["stroke", "strokeStyleId"], ["effect", "effectStyleId"], ["text", "textStyleId"], ["grid", "gridStyleId"]] as const) {
      const value = n[key];
      if (isMixed(value)) refs[field] = "mixed";
      else {
        const name = await names.style(value);
        if (name) refs[field] = name;
      }
    }
    if (Object.keys(refs).length) out.styles = refs;

    if (node.type === "INSTANCE" && typeof n.getMainComponentAsync === "function") {
      const main = (await (n.getMainComponentAsync as () => Promise<Any | null>).call(n).catch(() => null)) as Any | null;
      if (main) {
        const parentSet = main.parent as Any | null;
        const set = parentSet?.type === "COMPONENT_SET" ? parentSet : null;
        // The keys are what an import needs: a library component placed elsewhere
        // is reached by key, not by an id that only exists in this file [C-110].
        const used: ComponentUsed = {
          id: String(main.id),
          name: String(main.name),
          ...(keyOf(main.key) ? { key: main.key as string } : {}),
          ...(main.remote === true ? { remote: true as const } : {}),
          ...(set && keyOf(set.id) ? { setId: set.id as string } : {}),
          ...(set && keyOf(set.key) ? { setKey: set.key as string } : {}),
          ...(set ? { setName: String(set.name) } : {}),
        };
        names.componentsUsed.set(used.id, used);
        const comp: Any = { id: main.id, name: main.name };
        if (used.key) comp.key = used.key;
        if (used.remote) comp.remote = true;
        if (set) comp.set = set.name;
        if (used.setId) comp.setId = used.setId;
        if (used.setKey) comp.setKey = used.setKey;
        const props = n.componentProperties as Record<string, { value: unknown }> | undefined;
        if (props && Object.keys(props).length) {
          comp.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.replace(/#[^#]*$/, ""), v.value]));
        }
        out.component = comp;
      }
    }
  }

  if (opts.includeVariables) {
    const bound = n.boundVariables as Record<string, unknown> | undefined;
    if (bound) {
      const vars: Any = {};
      for (const [field, alias] of Object.entries(bound)) {
        if (field === "fills" || field === "strokes") continue; // shown on the paint itself
        const first = Array.isArray(alias) ? alias[0] : alias;
        const name = await names.variable((first as { id?: string } | undefined)?.id, node);
        if (name) vars[field] = name;
      }
      if (Object.keys(vars).length) out.variables = vars;
    }
    // A mode pinned on this node (Dark on a screen) — without it every node shows the default mode [C-105].
    const explicit = safe(n, "explicitVariableModes") as Record<string, string> | undefined;
    if (explicit && typeof explicit === "object" && Object.keys(explicit).length) {
      const modes: Any = {};
      for (const [cid, mid] of Object.entries(explicit)) {
        const c = await names.collection(cid);
        modes[c?.name ?? cid] = c?.modes.find((m) => m.modeId === mid)?.name ?? mid;
      }
      out.variableModes = modes;
    }
  }

  if (opts.includeAnnotations !== false && Array.isArray(n.annotations) && n.annotations.length) {
    const list: Any[] = [];
    for (const a of n.annotations as Array<{ label?: string; labelMarkdown?: string; categoryId?: string; properties?: Array<{ type: string }> }>) {
      const entry: Any = {};
      const label = a.label ?? a.labelMarkdown;
      if (label) entry.label = label;
      const category = await names.category(a.categoryId);
      if (category) entry.category = category;
      if (Array.isArray(a.properties) && a.properties.length) entry.properties = a.properties.map((p) => p.type);
      if (Object.keys(entry).length) list.push(entry);
    }
    if (list.length) out.annotations = list;
  }

  if (!names.motionOff) {
    try {
      const fields = tracksToFieldNames(n.manualKeyframeTracks);
      const styles = n.animationStyles;
      if (Array.isArray(styles)) for (const s of styles as Array<{ name?: string }>) fields.push(`style:${s.name ?? "?"}`);
      if (fields.length) out.motion = fields;
    } catch (err) {
      // Without the per-user flag every motion getter throws this; design
      // context must never fail for it, so stop asking for the rest of the call.
      if (/not a supported API/i.test(err instanceof Error ? err.message : String(err))) names.motionOff = true;
    }
  }

  if (opts.includeCss && names.css.on) {
    const get = n.getCSSAsync;
    if (typeof get !== "function") {
      names.css.on = false;
      names.css.note = "getCSSAsync is not available in this editor, so no node carries css.";
    } else {
      const t0 = Date.now();
      try {
        const css = (await (get as () => Promise<Record<string, string>>).call(n)) ?? {};
        if (Object.keys(css).length) out.css = css;
      } catch (err) {
        names.css.on = false;
        names.css.note = `getCSSAsync failed on ${node.id} (${err instanceof Error ? err.message : String(err)}); css stops there for this call.`;
      }
      names.css.ms += Date.now() - t0;
    }
  }
  return out;
}

/** The frontier of a truncated walk, so the next call continues exactly where this one stopped. */
export function encodeFrontier(ids: string[], opts: ContextOptions): string {
  return `dc1.${encodeURIComponent(JSON.stringify({ v: 1, ids, d: opts.depth, c: opts.maxChildren }))}`;
}

export function decodeFrontier(cursor: string): { ids: string[]; depth: number; maxChildren: number } {
  if (!cursor.startsWith("dc1.")) throw new BridgeError(ErrorCode.INVALID_PARAM, "`cursor` is not a design-context cursor.");
  try {
    const p = JSON.parse(decodeURIComponent(cursor.slice(4))) as { ids: unknown; d: unknown; c: unknown };
    if (!Array.isArray(p.ids) || !p.ids.every((i) => typeof i === "string")) throw new Error("ids");
    return { ids: p.ids as string[], depth: Number(p.d), maxChildren: Number(p.c) };
  } catch {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`cursor` is malformed — pass the nextCursor of the previous call unchanged.");
  }
}

export interface ContextResult {
  roots: ContextNode[];
  nodeCount: number;
  truncated: boolean;
  frontier: string[];
  stylesUsed: StyleUsed[];
  variablesUsed: VariableUsed[];
  componentsUsed: ComponentUsed[];
  /** Text nodes whose characters were cut at maxTextChars. */
  textCut: number;
  /** Tables whose cells were cut at maxTableCells. */
  tableCut: number;
  /** Every connector met, ordered by id, its endpoints named. */
  connectors: ConnectorEdge[];
  /** With includeCss: time spent in getCSSAsync, and why it stopped if it did. */
  cssMs?: number;
  cssNote?: string;
}

/**
 * Build the context for one or more roots. A tree, not a flat list: every node
 * appears once, nested where it lives. Depth stops expansion (the node keeps
 * `childCount`); maxNodes stops the walk, and every child not yet visited goes
 * into `frontier` so a cursor can continue — nothing is dropped silently.
 */
export async function buildContext(roots: NodeLike[], opts: ContextOptions, ctx: Ctx): Promise<ContextResult> {
  const names = new Names();
  const frontier: string[] = [];
  let count = 0;

  const visit = async (node: NodeLike, depthLeft: number, parent: NodeLike | null | undefined): Promise<ContextNode> => {
    count++;
    if (count % 100 === 0) {
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while reading the design.");
      await ctx.yieldToHost();
    }
    const dto = await describe(node, (parent ?? undefined) as Any | undefined, names, opts);
    names.seen.set(node.id, node.name);
    // A TABLE has no children, and asking may throw outside Design [C-135] [C-145].
    const kids = childrenOf(node) ?? [];
    if (kids.length === 0) return dto;
    dto.childCount = kids.length;
    if (depthLeft <= 0) return dto;
    const shown = kids.slice(0, opts.maxChildren);
    const children: ContextNode[] = [];
    for (let i = 0; i < shown.length; i++) {
      if (count >= opts.maxNodes) {
        // Out of budget: the rest of this list waits for the next call.
        for (const rest of shown.slice(i)) frontier.push(rest.id);
        dto.continued = true;
        break;
      }
      children.push(await visit(shown[i]!, depthLeft - 1, node));
    }
    if (children.length) dto.children = children;
    if (kids.length > shown.length) dto.childrenOmitted = kids.length - shown.length;
    return dto;
  };

  const out: ContextNode[] = [];
  for (let i = 0; i < roots.length; i++) {
    if (count >= opts.maxNodes) {
      for (const rest of roots.slice(i)) frontier.push(rest.id);
      break;
    }
    out.push(await visit(roots[i]!, opts.depth, field<NodeLike | null>(roots[i]!, "parent")));
  }
  // The board's graph: endpoints this read reached are named from the walk,
  // the rest by one lookup per distinct id, no more lookups than maxNodes.
  const connectors = names.edges.length ? await resolveEdges(names.edges, names.seen, names.lookup(), opts.maxNodes) : [];
  return {
    roots: out,
    nodeCount: count,
    truncated: frontier.length > 0,
    frontier,
    stylesUsed: [...names.stylesUsed.values()],
    variablesUsed: [...names.variablesUsed.values()],
    componentsUsed: [...names.componentsUsed.values()],
    textCut: names.textCut,
    tableCut: names.tableCut,
    connectors,
    ...(opts.includeCss ? { cssMs: names.css.ms } : {}),
    ...(names.css.note ? { cssNote: names.css.note } : {}),
  };
}
