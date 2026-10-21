// Reading FigJam and Slides nodes: what a sticky, a shape, a connector, a
// table, a code block or a slide says, in the dialect the write tools take.
//
// Two facts shape this file:
//
//  1. These nodes keep their content outside the members a Design read looks
//     at. A sticky's, a shape's and a connector's text lives in a `text`
//     sublayer; a TABLE has no children and is read through cellAt(); a code
//     block keeps `code`; a SLIDE_ROW / SLIDE_GRID is opaque, with no fills or
//     layout at all [C-135] [C-136]. Without this a board reads as nameless
//     boxes and a deck as one grid.
//  2. Outside Figma Design, touching a member a node does not have may THROW
//     ("no such property 'fills' on SLIDE_GRID node") instead of reading as
//     undefined. Whether every missing read throws is unmeasured [C-145], so
//     every read here survives both: in FigJam and Slides files, and on the
//     node types that exist only there, members are read through a view whose
//     getters turn a throw into undefined. Design reads keep the direct path,
//     so Design output and cost do not change.
//
// No `figma` global here except through safe.ts, and no import of read.ts or
// context.ts (they import this): the text dialect is passed in by the caller.

import { formatEndpoint, kebab, type ConnectorEndpoint } from "../shared/figjam.js";
import { editorType, tryGet } from "./safe.js";

type Any = Record<string, unknown>;

/** A node as the readers see it — read.ts NodeLike, restated so this file does not import read.ts. */
export interface NodeLike {
  id: string;
  name: string;
  type: string;
  children?: readonly NodeLike[] | undefined;
  parent?: NodeLike | null | undefined;
}

/**
 * OpaqueNodeMixin only (Base + Scene + Export + DimensionAndPosition): no
 * fills, effects or layout, and a read of one throws [C-136]. Read nothing but
 * the box and the children.
 */
export const OPAQUE_TYPES: ReadonlySet<string> = new Set(["SLIDE_GRID", "SLIDE_ROW", "INTERACTIVE_SLIDE_ELEMENT"]);

/** Node types that exist only in FigJam or Slides files: read through the guard in every editor. */
export const BOARD_TYPES: ReadonlySet<string> = new Set([
  "STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "TABLE", "CODE_BLOCK", "LINK_UNFURL", "EMBED", "MEDIA", "WIDGET",
  "STAMP", "HIGHLIGHT", "WASHI_TAPE", "SLIDE", ...OPAQUE_TYPES,
]);

/** The node types that hold text a scan can list; a TABLE lists one item per non-empty cell. */
export const TEXT_SCAN_TYPES = ["TEXT", "STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "CODE_BLOCK", "TABLE"] as const;
export type TextScanType = (typeof TEXT_SCAN_TYPES)[number];

/** Characters a DTO preview shows of a node's text. */
export const PREVIEW_CHARS = 200;
/** Table cells read per table by default (figma_get_design_context maxTableCells). */
export const MAX_TABLE_CELLS = 500;
/** Cells read per table by a scan or a search: tables are bounded, this is a backstop. */
const SCAN_CELL_CAP = 10_000;

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One member, or undefined when it is absent or reading it throws. */
export function field<T = unknown>(node: unknown, key: string): T | undefined {
  try {
    return (node as Any)[key] as T;
  } catch {
    return undefined;
  }
}

/** `node.children`, or undefined when there are none — a TABLE has none, and reading it may throw [C-135] [C-145]. */
export function childrenOf(node: NodeLike): readonly NodeLike[] | undefined {
  try {
    const kids = node.children;
    return kids && typeof kids.length === "number" ? kids : undefined;
  } catch {
    return undefined;
  }
}

/** True outside Figma Design: there a missing member may throw, so every node is read through the guard [C-145]. */
export function guardAll(): boolean {
  const e = editorType();
  return e !== undefined && e !== "figma";
}

// ── the guarded view ────────────────────────────────────────────────────────

/**
 * Every member a reader (context.ts describe/textOf, read.ts toDto, check.ts,
 * this file) reads off a node. The view exposes exactly these; a reader that
 * starts reading a new member adds it here — test/board-read.test.ts records
 * the members a Design read touches and fails on one that is missing.
 */
export const READ_KEYS = [
  // identity and tree
  "id", "name", "type", "parent", "children", "removed", "visible", "locked",
  // geometry
  "x", "y", "width", "height", "rotation", "absoluteBoundingBox", "absoluteRenderBounds",
  // layout
  "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems",
  "counterAxisAlignItems", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "primaryAxisSizingMode",
  "counterAxisSizingMode", "layoutPositioning", "counterAxisSpacing", "counterAxisAlignContent", "strokesIncludedInLayout",
  "itemReverseZIndex", "gridRowCount", "gridColumnCount", "gridRowGap", "gridColumnGap", "gridRowSizes", "gridColumnSizes",
  "gridRowAnchorIndex", "gridColumnAnchorIndex", "gridRowSpan", "gridColumnSpan", "constraints", "minWidth", "maxWidth",
  "minHeight", "maxHeight", "layoutGrids", "overflowDirection", "numberOfFixedChildren", "clipsContent",
  // shape and paint
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerSmoothing", "opacity",
  "blendMode", "isMask", "maskType", "booleanOperation", "fills", "strokes", "strokeWeight", "strokeTopWeight",
  "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign", "dashPattern", "effects", "isAsset",
  // styles, variables, components, annotations, motion, css
  "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId", "boundVariables", "inferredVariables",
  "explicitVariableModes", "getMainComponentAsync", "componentProperties", "annotations", "manualKeyframeTracks",
  "animationStyles", "getCSSAsync", "findAllWithCriteria",
  // the role audits (a11y.ts, states.ts): controls, states, and the brief block every check skips
  "reactions", "variantProperties", "variantGroupProperties", "remote", "getSharedPluginData",
  // text
  "characters", "fontName", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal",
  "textAlignVertical", "textCase", "textDecoration", "textAutoResize", "textTruncation", "maxLines", "paragraphSpacing",
  "paragraphIndent", "leadingTrim", "hyperlink", "openTypeFeatures", "getStyledTextSegments", "getRangeAllFontNames",
  "hasMissingFont",
  // FigJam (plugin-api.d.ts 11305-11663, 12067-12273, 6622, 6967) and Slides (12320, 12359)
  "text", "isWideWidth", "authorVisible", "authorName", "shapeType", "connectorStart", "connectorEnd", "connectorLineType",
  "connectorStartStrokeCap", "connectorEndStrokeCap", "numRows", "numColumns", "cellAt", "code", "codeLanguage",
  "sectionContentsHidden", "linkUnfurlData", "embedData", "mediaData", "widgetId", "attachedConnectors", "stuckTo",
  "isSkippedSlide", "interactiveSlideElementType",
] as const;

const RAW = Symbol("raw");

/** A node whose getters never throw: a member that throws, or is absent, reads as undefined. Methods stay bound to the node. */
class ReadView {
  readonly [RAW]: object;
  constructor(node: object) {
    this[RAW] = node;
  }
}
for (const key of READ_KEYS) {
  Object.defineProperty(ReadView.prototype, key, {
    enumerable: true,
    get(this: ReadView) {
      const node = this[RAW];
      const v = field(node, key);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(node) : v;
    },
  });
}

/** `node` itself on the Design path, else its guarded view. `all`: guard every type (guardAll()). */
export function readView(node: object, all: boolean): Any {
  const type = field<string>(node, "type");
  return all || (typeof type === "string" && BOARD_TYPES.has(type)) ? (new ReadView(node) as unknown as Any) : (node as Any);
}

// ── text a node holds ───────────────────────────────────────────────────────

/** The `text` sublayer of a sticky, shape, connector or table cell, or undefined. */
export function sublayerOf(node: unknown): Any | undefined {
  const t = field<Any | null>(node, "text");
  return t && typeof t === "object" ? t : undefined;
}

function charsOf(holder: unknown): string {
  const c = field(holder, "characters");
  return typeof c === "string" ? c : "";
}

/** The text a node holds — TEXT characters, a sublayer's characters, a code block's code — or undefined when it holds none. */
export function heldText(node: NodeLike): string | undefined {
  switch (node.type) {
    case "TEXT":
      return charsOf(node);
    case "STICKY":
    case "SHAPE_WITH_TEXT":
    case "CONNECTOR": {
      const sub = sublayerOf(node);
      return sub ? charsOf(sub) : undefined;
    }
    case "CODE_BLOCK": {
      const code = field(node, "code");
      return typeof code === "string" ? code : "";
    }
    default:
      return undefined;
  }
}

/**
 * Whether a label's paint shows. A new connector's label fills are [] — its
 * characters read back while nothing is drawn (generate-project-plan
 * SKILL.md:196) [C-148] — so a label is visible only with a visible paint.
 * Mixed paints count as visible: some of the label shows.
 */
export function paintsShow(fills: unknown): boolean {
  if (typeof fills === "symbol") return true;
  if (!Array.isArray(fills)) return false;
  return fills.some((p) => {
    const paint = (p ?? {}) as Any;
    return paint.visible !== false && (num(paint.opacity) ?? 1) > 0;
  });
}

// ── connectors ──────────────────────────────────────────────────────────────

const isXY = (v: unknown): v is { x: number; y: number } =>
  typeof v === "object" && v !== null && num((v as Any).x) !== undefined && num((v as Any).y) !== undefined;

/** Figma's endpoint as the endpoint string figma_create_connectors takes, or undefined when it is not one of the three forms. */
export function endpointText(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as Any;
  const pos = isXY(o.position) ? { x: r2(o.position.x), y: r2(o.position.y) } : undefined;
  if (typeof o.endpointNodeId === "string" && o.endpointNodeId) {
    if (pos) return formatEndpoint({ endpointNodeId: o.endpointNodeId, position: pos });
    if (typeof o.magnet === "string") return formatEndpoint({ endpointNodeId: o.endpointNodeId, magnet: o.magnet } as ConnectorEndpoint);
    return o.endpointNodeId;
  }
  return pos ? formatEndpoint({ position: pos }) : undefined;
}

/** The node an endpoint is attached to, or undefined for a free point. */
export function endpointNode(e: unknown): string | undefined {
  const id = field(e, "endpointNodeId");
  return typeof id === "string" && id ? id : undefined;
}

// A connector named by Figma, not by anyone: its name says nothing. What a new
// connector is called is recorded by spikes/live-reads.mjs.
const DEFAULT_CONNECTOR_NAME = /^connector( line)?( \d+)?$/i;

/** A connector's label as read: its text, whether it shows, and the layer name when the label lives there. */
export function connectorLabel(node: NodeLike): { label: string; visible: boolean; nameLabel?: string } {
  const sub = sublayerOf(node);
  const label = sub ? charsOf(sub) : "";
  const visible = label !== "" && paintsShow(field(sub, "fills"));
  // generate_diagram can leave a Mermaid label in `name` with the text empty
  // (references/blocks/diagram-section.md:161) [C-159].
  const nameLabel = !label && node.name && !DEFAULT_CONNECTOR_NAME.test(node.name.trim()) ? node.name : undefined;
  return { label, visible, ...(nameLabel ? { nameLabel } : {}) };
}

/** One edge of the board's graph, as figma_get_design_context lists it. */
export interface ConnectorEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Present, false, only when the label has characters but no visible paint. */
  labelVisible?: false;
  /** The layer name, when the label is empty and the name carries it. */
  name?: string;
  fromName?: string;
  toName?: string;
  /** Endpoint nodes this read did not reach; named by a lookup. */
  outside?: Array<"from" | "to">;
  /** Endpoint nodes that no longer exist. */
  missing?: Array<"from" | "to">;
}

/** The edge for one connector, before its endpoint names are resolved. */
export function edgeOf(node: NodeLike): ConnectorEdge {
  const start = field(node, "connectorStart");
  const end = field(node, "connectorEnd");
  const { label, visible, nameLabel } = connectorLabel(node);
  return {
    id: node.id,
    from: endpointText(start) ?? "?",
    to: endpointText(end) ?? "?",
    ...(label ? { label } : {}),
    ...(label && !visible ? { labelVisible: false as const } : {}),
    ...(nameLabel ? { name: nameLabel } : {}),
  };
}

/** Numeric order of node ids ("2:10" after "2:9"), the order ops/read.ts byIdOrder pages in. */
export function idOrder(a: string, b: string): number {
  const pa = a.split(/[:;I]/).filter(Boolean).map(Number);
  const pb = b.split(/[:;I]/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * Name each edge's endpoints: from the walk when the node was read, else by
 * one lookup per distinct id, at most `maxLookups` of them. Edges come back
 * ordered by connector id, so the list is stable across calls.
 */
export async function resolveEdges(
  edges: Iterable<{ edge: ConnectorEdge; start: unknown; end: unknown }>,
  seen: ReadonlyMap<string, string>,
  lookup: ((id: string) => Promise<{ name?: unknown } | null>) | undefined,
  maxLookups: number,
): Promise<ConnectorEdge[]> {
  const found = new Map<string, string | null>();
  let lookups = 0;
  const nameOf = async (id: string): Promise<{ name?: string; outside?: true; missing?: true }> => {
    const known = seen.get(id);
    if (known !== undefined) return { name: known };
    if (!found.has(id)) {
      if (!lookup || lookups >= maxLookups) return {};
      lookups++;
      const n = await lookup(id).catch(() => null);
      found.set(id, n ? String(n.name ?? "") : null);
    }
    const name = found.get(id);
    return name === null ? { missing: true } : { name: name!, outside: true };
  };
  const out: ConnectorEdge[] = [];
  for (const { edge, start, end } of edges) {
    const e: ConnectorEdge = { ...edge };
    for (const [side, endpoint] of [["from", start], ["to", end]] as const) {
      const id = endpointNode(endpoint);
      if (!id) continue;
      const r = await nameOf(id);
      if (r.name !== undefined) e[side === "from" ? "fromName" : "toName"] = r.name;
      if (r.outside) (e.outside ??= []).push(side);
      if (r.missing) (e.missing ??= []).push(side);
    }
    out.push(e);
  }
  return out.sort((a, b) => idOrder(a.id, b.id));
}

// ── tables ──────────────────────────────────────────────────────────────────

export interface TableRead {
  rows: number;
  columns: number;
  /** Row-major, cut at `max` cells; the last row may be partial. */
  cells: string[][];
  /** Cells read, when fewer than rows × columns. */
  cellsShown?: number;
  /** Each cell's text cut at this many characters, when any was. */
  cellsCut: number;
}

/** A table's cells through cellAt — a TableNode has no children [C-135]. Cell text is cut at maxChars. */
export function readTable(node: unknown, max: number, maxChars = Infinity): TableRead {
  const rows = num(field(node, "numRows")) ?? 0;
  const columns = num(field(node, "numColumns")) ?? 0;
  const cellAt = field<(r: number, c: number) => unknown>(node, "cellAt");
  const cells: string[][] = [];
  let read = 0;
  let cut = 0;
  for (let r = 0; r < rows && read < max; r++) {
    const row: string[] = [];
    for (let c = 0; c < columns && read < max; c++) {
      let text = "";
      if (typeof cellAt === "function") {
        try {
          text = charsOf(sublayerOf(cellAt.call(node, r, c)));
        } catch {
          text = "";
        }
      }
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}…`;
        cut++;
      }
      row.push(text);
      read++;
    }
    cells.push(row);
  }
  return { rows, columns, cells, ...(read < rows * columns ? { cellsShown: read } : {}), cellsCut: cut };
}

/** Every cell's text sublayer, row-major, up to `max` cells — for the font list. */
export function tableHolders(node: unknown, max = SCAN_CELL_CAP): unknown[] {
  const rows = num(field(node, "numRows")) ?? 0;
  const columns = num(field(node, "numColumns")) ?? 0;
  const cellAt = field<(r: number, c: number) => unknown>(node, "cellAt");
  const out: unknown[] = [];
  if (typeof cellAt !== "function") return out;
  for (let r = 0; r < rows && out.length < max; r++) {
    for (let c = 0; c < columns && out.length < max; c++) {
      try {
        const sub = sublayerOf(cellAt.call(node, r, c));
        if (sub) out.push(sub);
      } catch {
        /* a cell that cannot be read has no font to report */
      }
    }
  }
  return out;
}

/** A cell's solid fill as hex, or undefined. */
function cellFill(node: unknown, r: number, c: number): string | undefined {
  const cellAt = field<(r: number, c: number) => unknown>(node, "cellAt");
  if (typeof cellAt !== "function") return undefined;
  try {
    return solidHex(field(cellAt.call(node, r, c), "fills"));
  } catch {
    return undefined;
  }
}

function solidHex(fills: unknown): string | undefined {
  if (!Array.isArray(fills)) return undefined;
  const p = fills.filter((f) => (f as Any)?.visible !== false).pop() as Any | undefined;
  if (!p || p.type !== "SOLID" || typeof p.color !== "object" || p.color === null) return undefined;
  const c = p.color as { r: number; g: number; b: number };
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// ── slides ──────────────────────────────────────────────────────────────────

export interface SlidePlace {
  row: number;
  col: number;
  /** Position in the grid read row by row — the order the deck plays in (plugin-api.d.ts:2035) [C-134]. */
  index: number;
}

/**
 * Where a slide sits in the grid, from the tree: SLIDE_GRID → SLIDE_ROW →
 * SLIDE (slide-grid.md:43). Reading `children` on the opaque rows is allowed:
 * they are ChildrenMixin [C-136]. Undefined when the slide is not in a row.
 */
export function slidePlace(node: NodeLike): SlidePlace | undefined {
  const row = field<NodeLike | null>(node, "parent");
  if (!row || row.type !== "SLIDE_ROW") return undefined;
  const grid = field<NodeLike | null>(row, "parent");
  const slides = childrenOf(row) ?? [];
  const col = slides.indexOf(node as never);
  if (col < 0) return undefined;
  if (!grid) return { row: 0, col, index: col };
  const rows = childrenOf(grid) ?? [];
  const r = rows.indexOf(row as never);
  let before = 0;
  for (let i = 0; i < r; i++) before += (childrenOf(rows[i]!) ?? []).length;
  return { row: Math.max(0, r), col, index: before + col };
}

/** A page's SLIDE_GRID — its first child in a deck (slide-grid.md:7) — or undefined. */
export function slideGridOf(page: NodeLike): NodeLike | undefined {
  return (childrenOf(page) ?? []).find((c) => c.type === "SLIDE_GRID");
}

export interface DeckOutline {
  gridId?: string;
  rowCount: number;
  slideCount: number;
  rows: Array<{ id: string; name: string; slideCount: number; slides?: Array<{ id: string; name: string; skipped?: true }> }>;
}

/** The deck's rows and slides from the tree, without reading anything opaque. `withSlides` lists each slide (capped). */
export function deckOutline(page: NodeLike, withSlides = false, maxSlides = 200): DeckOutline {
  const grid = slideGridOf(page);
  const rows = grid ? (childrenOf(grid) ?? []) : [];
  let listed = 0;
  const out = rows.map((row) => {
    const slides = childrenOf(row) ?? [];
    const entry: DeckOutline["rows"][number] = { id: row.id, name: row.name, slideCount: slides.length };
    if (withSlides) {
      entry.slides = slides.slice(0, Math.max(0, maxSlides - listed)).map((s) => ({
        id: s.id,
        name: s.name,
        ...(field(s, "isSkippedSlide") === true ? { skipped: true as const } : {}),
      }));
      listed += entry.slides.length;
    }
    return entry;
  });
  return { ...(grid ? { gridId: grid.id } : {}), rowCount: rows.length, slideCount: out.reduce((n, r) => n + r.slideCount, 0), rows: out };
}

/**
 * Which view the deck is in. The typings name viewport.slidesView and
 * canvasView, Working in Slides names viewport.slidesMode [C-140] — a
 * contradiction, so each is tried and the one that reads is reported.
 * canvasView's "single-asset" reads as "single-slide", the word figma_zoom_to
 * and figma_get_slide_grid use (slides/grid.ts readView), so one deck never
 * reports its view two ways.
 */
export function deckView(viewport: unknown): { view: string; property: string } | undefined {
  for (const property of ["canvasView", "slidesView", "slidesMode"]) {
    const got = tryGet(viewport, property);
    if (got.ok && typeof got.value === "string") return { view: got.value === "single-asset" ? "single-slide" : got.value, property };
  }
  return undefined;
}

// ── the DTO preview (read.ts toDto) ─────────────────────────────────────────

/** The box of an opaque node — the only members it is read for. */
export function opaqueBox(node: unknown): { x?: number; y?: number; width?: number; height?: number } {
  const out: { x?: number; y?: number; width?: number; height?: number } = {};
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = num(field(node, k));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const cutPreview = (s: string) => (s.length > PREVIEW_CHARS ? { text: `${s.slice(0, PREVIEW_CHARS)}…`, textLength: s.length } : { text: s });

/**
 * The cheap, synchronous identity of a FigJam or Slides node for the node DTO:
 * for a sticky its text is what it is. No fonts, no lookups. Undefined for
 * every other type, so a Design DTO does not grow.
 */
export function previewOf(node: NodeLike): Any | undefined {
  switch (node.type) {
    case "STICKY":
    case "SHAPE_WITH_TEXT": {
      const out: Any = cutPreview(heldText(node) ?? "");
      if (node.type === "SHAPE_WITH_TEXT") {
        const shape = field(node, "shapeType");
        if (typeof shape === "string") out.shapeType = kebab(shape);
      }
      return out;
    }
    case "CODE_BLOCK": {
      const language = field(node, "codeLanguage");
      return { ...cutPreview(heldText(node) ?? ""), ...(typeof language === "string" ? { language: kebab(language) } : {}) };
    }
    case "CONNECTOR": {
      const { label } = connectorLabel(node);
      return {
        connector: {
          from: endpointText(field(node, "connectorStart")) ?? "?",
          to: endpointText(field(node, "connectorEnd")) ?? "?",
          ...(label ? { label: label.length > PREVIEW_CHARS ? `${label.slice(0, PREVIEW_CHARS)}…` : label } : {}),
        },
      };
    }
    case "TABLE":
      return { table: { rows: num(field(node, "numRows")) ?? 0, columns: num(field(node, "numColumns")) ?? 0 } };
    case "LINK_UNFURL": {
      const url = field(field(node, "linkUnfurlData"), "url");
      return typeof url === "string" ? { link: url } : undefined;
    }
    case "SECTION":
      return field(node, "sectionContentsHidden") === true ? { sectionContentsHidden: true } : undefined;
    case "SLIDE": {
      const place = slidePlace(node);
      return { slide: { ...(place ?? {}), skipped: field(node, "isSkippedSlide") === true } };
    }
    case "INTERACTIVE_SLIDE_ELEMENT": {
      const kind = field(node, "interactiveSlideElementType");
      return typeof kind === "string" ? { interactiveType: kind } : undefined;
    }
    default:
      return undefined;
  }
}

// ── design context: one describer per type ──────────────────────────────────

export interface BoardDeps {
  /** context.ts textOf over a holder (a guarded view of a text sublayer). */
  text(holder: Any): Promise<Any>;
  maxTextChars: number;
  maxTableCells: number;
  /** A text was cut at maxTextChars (counts toward textNote). */
  textCut(): void;
  /** A table's cells were cut at maxTableCells (counts toward tableNote). */
  tableCut(): void;
  /** A connector was met: its edge goes into the result's `connectors`. */
  connector(edge: ConnectorEdge, start: unknown, end: unknown): void;
  /** Read FigJam-only members (attachedConnectors, stuckTo): off in Design files, where they are always empty. */
  boardMembers: boolean;
}

/**
 * The per-type fields of a FigJam or Slides node, added to `out`. `n` is the
 * node's guarded view. Each block is named after the type, in the vocabulary
 * the write tools take: shape types and caps in kebab case, endpoints in the
 * endpoint grammar (src/shared/figjam.ts).
 */
export async function describeBoard(node: NodeLike, n: Any, out: Any, deps: BoardDeps): Promise<void> {
  switch (node.type) {
    case "STICKY": {
      const sub = sublayerOf(n);
      if (sub) out.text = await deps.text(readView(sub, true));
      const visible = n.authorVisible === true;
      // The author is shown only where the board shows it.
      out.sticky = {
        wide: n.isWideWidth === true,
        authorVisible: visible,
        ...(visible && typeof n.authorName === "string" && n.authorName ? { author: n.authorName } : {}),
      };
      break;
    }
    case "SHAPE_WITH_TEXT": {
      const sub = sublayerOf(n);
      if (sub) out.text = await deps.text(readView(sub, true));
      const radius = num(n.cornerRadius);
      out.shape = {
        ...(typeof n.shapeType === "string" ? { type: kebab(n.shapeType) } : {}),
        ...(radius ? { cornerRadius: r2(radius) } : {}),
      };
      break;
    }
    case "CONNECTOR": {
      const { label, visible, nameLabel } = connectorLabel(node);
      const sub = sublayerOf(n);
      // The label's font and colour only when there is a label: an unlabelled
      // connector's font is not even a loadable font [C-148].
      if (label && sub) out.text = await deps.text(readView(sub, true));
      const start = n.connectorStart;
      const end = n.connectorEnd;
      const weight = num(n.strokeWeight);
      // A dash as the writes take it: "a,b" lengths; a solid line has none.
      const dash = Array.isArray(n.dashPattern) && n.dashPattern.length ? (n.dashPattern as unknown[]).map(Number).join(",") : undefined;
      out.connector = {
        from: endpointText(start) ?? "?",
        to: endpointText(end) ?? "?",
        ...(typeof n.connectorLineType === "string" ? { lineType: kebab(n.connectorLineType) } : {}),
        ...(typeof n.connectorStartStrokeCap === "string" ? { startCap: kebab(n.connectorStartStrokeCap) } : {}),
        ...(typeof n.connectorEndStrokeCap === "string" ? { endCap: kebab(n.connectorEndStrokeCap) } : {}),
        ...(weight !== undefined ? { weight: r2(weight) } : {}),
        ...(dash ? { dash } : {}),
        ...(label ? { label, labelVisible: visible } : {}),
        ...(nameLabel ? { labelNote: `the label is in the layer name ("${nameLabel}"), not on the canvas` } : {}),
      };
      deps.connector(edgeOf(node), start, end);
      break;
    }
    case "TABLE": {
      const t = readTable(node, deps.maxTableCells, deps.maxTextChars);
      for (let i = 0; i < t.cellsCut; i++) deps.textCut();
      if (t.cellsShown !== undefined) deps.tableCut();
      const header = t.rows > 1 ? cellFill(node, 0, 0) : undefined;
      out.table = {
        rows: t.rows,
        columns: t.columns,
        cells: t.cells,
        ...(t.cellsShown !== undefined ? { cellsShown: t.cellsShown } : {}),
        ...(header ? { headerFill: header } : {}),
      };
      break;
    }
    case "CODE_BLOCK": {
      const code = typeof n.code === "string" ? n.code : "";
      const cut = code.length > deps.maxTextChars;
      if (cut) deps.textCut();
      out.code = {
        ...(typeof n.codeLanguage === "string" ? { language: kebab(n.codeLanguage) } : {}),
        text: cut ? `${code.slice(0, deps.maxTextChars)}…` : code,
        lines: code ? code.split("\n").length : 0,
        ...(cut ? { length: code.length } : {}),
      };
      break;
    }
    case "SECTION":
      if (n.sectionContentsHidden === true) out.contentsHidden = true;
      break;
    case "LINK_UNFURL":
      out.link = pick(n.linkUnfurlData, ["url", "title", "description", "provider"]);
      break;
    case "EMBED":
      out.embed = pick(n.embedData, ["srcUrl", "canonicalUrl", "title", "description", "provider"]);
      break;
    case "MEDIA": {
      const hash = field(n.mediaData, "hash");
      if (typeof hash === "string") out.media = { hash };
      break;
    }
    case "WIDGET":
      // Only the id: a widget's synced state is readable by that widget alone (plugin-api.d.ts:12069-12075).
      if (typeof n.widgetId === "string") out.widget = { widgetId: n.widgetId };
      break;
    case "SLIDE": {
      const place = slidePlace(node);
      out.slide = { ...(place ?? {}), skipped: n.isSkippedSlide === true };
      break;
    }
    // STAMP: no author — getAuthorAsync needs the fileusers permission (plugin-api.d.ts:11342-11348).
  }

  if (deps.boardMembers) {
    const attached = n.attachedConnectors;
    if (Array.isArray(attached) && attached.length) out.attachedConnectors = attached.map((c) => String((c as Any).id));
    const stuck = n.stuckTo as Any | null | undefined;
    if (stuck && typeof stuck.id === "string") out.stuckTo = stuck.id;
  }
}

function pick(obj: unknown, keys: readonly string[]): Any | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const out: Any = {};
  for (const k of keys) {
    const v = field(obj, k);
    if (typeof v === "string" && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── scan and search ─────────────────────────────────────────────────────────

export interface TextItem {
  id: string;
  name: string;
  type: string;
  characters: string;
  characterCount: number;
  /** A TABLE item: the cell it came from (table cells have no id [C-135]). */
  cell?: { row: number; column: number };
  language?: string;
  labelVisible?: boolean;
}

/**
 * The text items one node yields for figma_scan_text_nodes: one per holder, one
 * per non-empty table cell (row-major), none for a connector with no label.
 */
export function textItems(node: NodeLike): TextItem[] {
  const base = { id: node.id, name: node.name, type: node.type };
  const item = (characters: string, more: Partial<TextItem> = {}): TextItem => ({ ...base, characters, characterCount: characters.length, ...more });
  switch (node.type) {
    case "TEXT":
    case "STICKY":
    case "SHAPE_WITH_TEXT":
      return [item(heldText(node) ?? "")];
    case "CODE_BLOCK": {
      const language = field(node, "codeLanguage");
      return [item(heldText(node) ?? "", typeof language === "string" ? { language: kebab(language) } : {})];
    }
    case "CONNECTOR": {
      const { label, visible } = connectorLabel(node);
      return label ? [item(label, { labelVisible: visible })] : [];
    }
    case "TABLE": {
      const t = readTable(node, SCAN_CELL_CAP);
      const out: TextItem[] = [];
      t.cells.forEach((row, r) => row.forEach((text, c) => {
        if (text) out.push(item(text, { cell: { row: r, column: c } }));
      }));
      return out;
    }
    default:
      return [];
  }
}

/** Whether a node's own content contains `needle` (lower case); a table hit names the first cell that matched. */
export function contentHit(node: NodeLike, needle: string): { cell?: { row: number; column: number } } | null {
  if (node.type === "TABLE") {
    const t = readTable(node, SCAN_CELL_CAP);
    for (let r = 0; r < t.cells.length; r++) {
      const c = t.cells[r]!.findIndex((text) => text.toLowerCase().includes(needle));
      if (c >= 0) return { cell: { row: r, column: c } };
    }
    return null;
  }
  const text = node.type === "CONNECTOR" ? connectorLabel(node).label : heldText(node);
  return text !== undefined && text.toLowerCase().includes(needle) ? {} : null;
}
