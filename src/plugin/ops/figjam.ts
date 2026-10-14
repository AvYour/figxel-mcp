// The FigJam board tools (tools.md § create, § modify): stickies, shapes with
// text, connectors, tables, code blocks and link previews, and the edits that
// go with them. The official Figma MCP reaches these only through Plugin API
// JavaScript (figma-use-figjam); here each is a typed tool with its checks run
// before the board changes [C-096] and one undo step per call, committed by
// the runner in code.ts, never here [C-151].
//
// The builders live in figjam/nodes.ts, shared with create_from_spec's board
// types (figjam/spec-types.ts). Wired by the integrator: FIGJAM_OPS spread into
// PLUGIN_OPS (ops/index.ts).

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { kebab, parseCodeLanguage, parseShapeType, UNCONFIRMED_LANGUAGES, type ShapeType } from "../../shared/figjam.js";
import {
  applyConnector,
  at,
  atAsync,
  beforeBoard,
  board,
  boxOf,
  buildCodeBlock,
  buildConnector,
  buildShape,
  buildSticky,
  buildTable,
  columnWidthsOf,
  commonSection,
  emptyConnectorEdit,
  endpointNode,
  FIGJAM_FONT,
  FontCache,
  gridPlan,
  hasAutoLayout,
  list,
  loadSublayer,
  MAX_ITEMS,
  MAX_TEXT,
  Measurer,
  midway,
  objectAt,
  onlyKeys,
  opMake,
  optBool,
  optNumber,
  optString,
  overflowOf,
  pacer,
  parseCode,
  parseConnector,
  parseShape,
  parseSticky,
  parseTable,
  placeAt,
  placeNodes,
  pointPlan,
  refuse,
  refuseEmptyFill,
  requireApi,
  sublayer,
  unionBox,
  writeSublayer,
  type ConnectorSpec,
  type Make,
} from "../figjam/nodes.js";
import { isKnownColorName, paletteKey, paletteNames, resolveColor, resolveShapeColor, resolveTableColor } from "../figjam/palette.js";
import { str } from "../read.js";
import { CONNECTOR_LABEL_FONT } from "../sublayer.js";
import { append, loadFont, nearest, normalizePadding, parentFor, weightToStyle, type FigmaWrite, type NodeLikeW, type SolidPaint } from "../write.js";
import type { OpContext, PluginOp } from "./index.js";

type Any = Record<string, unknown>;

const asWrite = () => board() as unknown as FigmaWrite;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The grid gaps of the official recipes: stickies 64 (create-sticky.md:148), shapes 40 (create-shape-with-text.md:310) [C-163]. */
export const STICKY_GAP = 64;
export const SHAPE_GAP = 40;

const STICKY_KEYS = ["text", "color", "wide", "authorVisible", "name"];
const SHAPE_KEYS = ["shape", "text", "color", "fill", "stroke", "textColor", "width", "height", "fontSize", "name"];
const CONNECTOR_KEYS = ["from", "to", "label", "lineType", "startCap", "endCap", "color", "weight", "dash", "labelBackground", "name"];
const EDIT_CONNECTOR_KEYS = ["nodeId", "from", "to", "label", "lineType", "startCap", "endCap", "color", "weight", "dash", "labelBackground"];

interface Prepared {
  fonts: FontCache;
  created: string[];
  m: Make;
}

function prepared(ctx: OpContext): Prepared {
  const fonts = new FontCache(board());
  const created: string[] = [];
  return { fonts, created, m: opMake(created, fonts, ctx, append) };
}

/**
 * An edit of many nodes gives Figma a turn and reports progress every 50
 * items. It does not stop on a cancel: half an edit is reported per item
 * anyway, and every item already written is in the one undo step.
 */
async function breathe(ctx: OpContext, i: number, total: number, phase: string): Promise<void> {
  if ((i + 1) % 50 !== 0) return;
  ctx.progress(i + 1, total, phase);
  await ctx.yieldToHost();
}

const round = (v: number) => Math.round(v * 100) / 100;
const sized = (b: { x: number; y: number; width: number; height: number }) => ({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) });

/**
 * Where a block create stands once item `i` is built: the next item, or
 * `after` past the last. A cancel arrives between items, so it is reported at
 * the first item NOT made — "continue from partial.failedAt" never repeats one.
 */
const nextAt = (list: string, i: number, total: number, after: string) => (i + 1 < total ? `${list}[${i + 1}]` : after);

/** What every block create returns besides its items: where it landed, and how far past its parent. */
function blockResult(parent: NodeLikeW, bounds: { x: number; y: number; width: number; height: number }, auto: boolean): Any {
  const overflow = overflowOf(parent, bounds);
  const notes = [
    ...(overflow ? [`The block runs past "${parent.name}", which was not resized; figma_fit_sections fits a section to what it holds.`] : []),
    ...(auto ? [`"${parent.name}" has auto-layout, which placed them.`] : []),
  ];
  return { bounds: sized(bounds), ...(overflow ? { parentOverflow: overflow } : {}), ...(notes.length ? { note: notes.join(" ") } : {}) };
}

// ── figma_create_stickies ───────────────────────────────────────────────────

const createStickies: PluginOp = {
  write: true,
  async run(ctx) {
    const { fonts, created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createSticky", "create stickies");
      const items = list(ctx.params.stickies, "stickies", 1, MAX_ITEMS);
      const specs = items.map((raw, i) => parseSticky(raw, `stickies[${i}]`, { textKey: "text", allowed: STICKY_KEYS }));
      const parent = await atAsync("parentId", () => parentFor(asWrite(), str(ctx.params, "parentId")));
      const grid = gridPlan(ctx.params, parent, STICKY_GAP, specs.length);
      // FigJam's text font, loaded while nothing exists: one that will not load is a refusal, not half a board [C-147].
      await fonts.load(FIGJAM_FONT);
      return { specs, parent, grid };
    });
    const nodes: NodeLikeW[] = [];
    const pace = pacer(ctx, p.specs.length, "stickies");
    let failedAt = "stickies[0]";
    try {
      // Pass one: every sticky exists, in its parent, with its text — only then are the heights real [C-147].
      for (let i = 0; i < p.specs.length; i++) {
        failedAt = `stickies[${i}]`;
        nodes.push(await buildSticky(p.specs[i]!, p.parent, m));
        failedAt = nextAt("stickies", i, p.specs.length, "placement");
        await pace.tick();
      }
      failedAt = "placement";
      const { placed, bounds } = placeNodes(nodes, p.grid);
      return { created: placed.map((b, index) => ({ index, id: b.id, ...sized(b) })), ...blockResult(p.parent, bounds, !p.grid.origin) };
    } catch (err) {
      throw midway(err, created, failedAt);
    }
  },
};

// ── figma_create_shapes_with_text ───────────────────────────────────────────

const createShapes: PluginOp = {
  write: true,
  async run(ctx) {
    const { fonts, created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createShapeWithText", "create shapes with text");
      const items = list(ctx.params.shapes, "shapes", 1, MAX_ITEMS);
      const specs = items.map((raw, i) => parseShape(raw, `shapes[${i}]`, { textKey: "text", allowed: SHAPE_KEYS }));
      const parent = await atAsync("parentId", () => parentFor(asWrite(), str(ctx.params, "parentId")));
      const grid = gridPlan(ctx.params, parent, SHAPE_GAP, specs.length);
      await fonts.load(FIGJAM_FONT);
      return { specs, parent, grid };
    });
    const built: Array<{ node: NodeLikeW; fitted: boolean }> = [];
    const pace = pacer(ctx, p.specs.length, "shapes");
    const measurer = new Measurer(m);
    let failedAt = "shapes[0]";
    try {
      for (let i = 0; i < p.specs.length; i++) {
        failedAt = `shapes[${i}]`;
        built.push(await buildShape(p.specs[i]!, p.parent, m, measurer));
        failedAt = nextAt("shapes", i, p.specs.length, "placement");
        await pace.tick();
      }
      failedAt = "placement";
      const { placed, bounds } = placeNodes(built.map((b) => b.node), p.grid);
      return {
        created: placed.map((b, index) => ({
          index,
          id: b.id,
          shape: p.specs[index]!.label ? "label" : kebab(p.specs[index]!.type),
          ...sized(b),
          fitted: built[index]!.fitted,
        })),
        ...blockResult(p.parent, bounds, !p.grid.origin),
      };
    } catch (err) {
      throw midway(err, created, failedAt);
    } finally {
      // The measuring text never outlives the call, whatever happened (create-shape-with-text.md:199-261) [C-163].
      measurer.remove();
    }
  },
};

// ── figma_create_connectors ─────────────────────────────────────────────────

const createConnectors: PluginOp = {
  write: true,
  async run(ctx) {
    const { fonts, created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createConnector", "create connectors");
      const items = list(ctx.params.connectors, "connectors", 1, MAX_ITEMS);
      const specs = items.map((raw, i) => parseConnector(raw, `connectors[${i}]`, { refs: false, weightKey: "weight", allowed: CONNECTOR_KEYS, create: true }));
      const parentId = str(ctx.params, "parentId");
      const explicit = parentId ? await atAsync("parentId", () => parentFor(asWrite(), parentId)) : undefined;
      // An auto-layout would take the connector as one of its items and move it: a route goes stale when it moves [C-149].
      if (explicit && hasAutoLayout(explicit)) {
        refuse("parentId", `"${explicit.name}" has auto-layout, which would place a connector as one of its items.`, "Give a section, a frame without layout, or leave parentId out.");
      }
      const page = board().currentPage;
      const parents: NodeLikeW[] = [];
      for (let i = 0; i < specs.length; i++) {
        const ends: Array<NodeLikeW | null> = [];
        for (const end of ["from", "to"] as const) {
          const e = specs[i]![end]!;
          ends.push("endpointNodeId" in e ? await endpointNode(e.endpointNodeId, `connectors[${i}].${end}`) : null);
        }
        // Created in its final parent and never moved: the lowest section holding both ends [C-149].
        parents.push(explicit ?? (ends[0] && ends[1] ? (commonSection(ends[0], ends[1]) ?? page) : page));
      }
      if (specs.some((s) => s.label !== undefined)) await fonts.load(CONNECTOR_LABEL_FONT);
      return { specs, parents };
    });
    const out: Array<{ index: number; id: string; parentId: string }> = [];
    const pace = pacer(ctx, p.specs.length, "connectors");
    let failedAt = "connectors[0]";
    try {
      for (let i = 0; i < p.specs.length; i++) {
        failedAt = `connectors[${i}]`;
        const node = await buildConnector(p.specs[i]!, p.parents[i]!, m);
        out.push({ index: i, id: node.id, parentId: p.parents[i]!.id });
        failedAt = nextAt("connectors", i, p.specs.length, "done");
        await pace.tick();
      }
      return { created: out };
    } catch (err) {
      throw midway(err, created, failedAt);
    }
  },
};

// ── figma_create_table ──────────────────────────────────────────────────────

const createTable: PluginOp = {
  write: true,
  async run(ctx) {
    const { fonts, created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createTable", "create tables");
      const spec = parseTable(ctx.params, "", null);
      const parent = await atAsync("parentId", () => parentFor(asWrite(), str(ctx.params, "parentId")));
      const point = pointPlan(ctx.params, parent);
      // A requested font is resolved (with fallback, reported) while nothing exists.
      const font =
        spec.fontFamily !== undefined || spec.weight !== undefined
          ? await loadFont(asWrite(), spec.fontFamily ?? FIGJAM_FONT.family, spec.weight !== undefined ? weightToStyle(spec.weight) : spec.fontFamily ? undefined : FIGJAM_FONT.style)
          : undefined;
      if (font) await fonts.load(font);
      return { spec, parent, point, font };
    });
    try {
      const node = await buildTable(p.spec, p.parent, m, p.font ? { family: p.font.family, style: p.font.style } : undefined);
      placeAt(node, p.point);
      const t = node as unknown as { numRows: number; numColumns: number };
      const box = boxOf(node);
      return {
        id: node.id,
        name: node.name,
        numRows: t.numRows,
        numColumns: t.numColumns,
        ...(box ? { width: round(box.width), height: round(box.height) } : {}),
        // Read back: a column cannot shrink below its minimum, so asked is not got [C-161].
        columnWidths: columnWidthsOf(node),
        ...(p.font ? { font: { family: p.font.family, style: p.font.style, fellBack: p.font.fellBack } } : {}),
      };
    } catch (err) {
      throw midway(err, created, "table");
    }
  },
};

// ── figma_create_code_block ─────────────────────────────────────────────────

const createCodeBlock: PluginOp = {
  write: true,
  async run(ctx) {
    const { created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createCodeBlock", "create code blocks");
      const spec = parseCode(ctx.params, "", { textKey: "code", allowed: null });
      const parent = await atAsync("parentId", () => parentFor(asWrite(), str(ctx.params, "parentId")));
      return { spec, parent, point: pointPlan(ctx.params, parent) };
    });
    try {
      const node = await buildCodeBlock(p.spec, p.parent, m);
      placeAt(node, p.point);
      const box = boxOf(node);
      return {
        id: node.id,
        name: node.name,
        language: kebab(p.spec.language),
        ...(box ? { width: round(box.width), height: round(box.height) } : {}),
        // In the typings, not in Figma's own guide [C-143]: say so until a live run settles it.
        ...(UNCONFIRMED_LANGUAGES.has(p.spec.language) ? { note: `${kebab(p.spec.language)} is in the Plugin API but not yet confirmed on the canvas: check the render.` } : {}),
      };
    } catch (err) {
      throw midway(err, created, "code");
    }
  },
};

// ── figma_create_link_preview ───────────────────────────────────────────────

const HTTPS = /^https:\/\/[^\s/?#]+[^\s]*$/i;

const createLinkPreview: PluginOp = {
  write: true,
  async run(ctx) {
    const { created, m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      requireApi("createLinkPreviewAsync", "create link previews");
      const url = typeof ctx.params.url === "string" ? ctx.params.url.trim() : "";
      if (!HTTPS.test(url) || url.length > 2048) refuse("url", "`url` must be an https:// link of at most 2048 characters.");
      // The parent is checked before Figma fetches anything.
      const parent = await atAsync("parentId", () => parentFor(asWrite(), str(ctx.params, "parentId")));
      return { url, parent, point: pointPlan(ctx.params, parent) };
    });
    const page = board().currentPage;
    const before = new Set((page.children ?? []).map((c) => c.id));
    let node: NodeLikeW;
    try {
      node = await board().createLinkPreviewAsync(p.url);
    } catch (err) {
      // Whether a refused preview leaves a node is unmeasured [C-162]: what the
      // page gained is reported, so "nothing changed" is claimed only when true.
      const left = (page.children ?? []).filter((c) => !before.has(c.id)).map((c) => c.id);
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not preview ${p.url}: ${msg(err)}`, {
        hint: left.length
          ? `Figma left ${left.length} node(s) on the page (partial.created); delete them with figma_delete_nodes.`
          : "Nothing was created. The page must be public and reachable from Figma.",
        partial: { created: left, failedAt: "url" },
      });
    }
    try {
      m.record(node);
      m.append(p.parent, node);
      placeAt(node, p.point);
      const data = node.type === "EMBED" ? (node as unknown as Any).embedData : (node as unknown as Any).linkUnfurlData;
      const d = (data ?? {}) as { title?: unknown; provider?: unknown };
      return {
        id: node.id,
        type: node.type,
        ...(typeof d.title === "string" ? { title: d.title } : {}),
        ...(typeof d.provider === "string" ? { provider: d.provider } : {}),
      };
    } catch (err) {
      throw midway(err, created, "placement");
    }
  },
};

// ── figma_edit_table ────────────────────────────────────────────────────────

export interface CellEdit {
  row: number;
  column: number;
  text?: string;
  fill?: SolidPaint;
  textFill?: SolidPaint;
}

/** Every change an edit makes, in the order it makes them, decided against the table's size before any. */
export interface TableEditPlan {
  /** Descending, so an earlier removal never shifts a later one. */
  removeRows: number[];
  removeColumns: number[];
  /** The index each insertRow / insertColumn call gets, in call order. */
  insertRows: number[];
  insertColumns: number[];
  moveRow?: { from: number; to: number };
  moveColumn?: { from: number; to: number };
  columnWidths: Array<{ index: number; width: number }>;
  rowHeights: Array<{ index: number; height: number }>;
  cells: CellEdit[];
  /** The table's size after the structural edits, which `cells` are addressed in. */
  rows: number;
  columns: number;
}

export const MAX_CELLS = 2000;

function indexList(params: Any, key: string, max: number, limit: number): number[] {
  const v = params[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > limit) refuse(key, `\`${key}\` must be an array of at most ${limit} indices.`);
  return v.map((x, i) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > max) refuse(`${key}[${i}]`, `\`${key}[${i}]\` must be a whole number from 0 to ${max}; got ${JSON.stringify(x)}.`);
    return x;
  });
}

function move(params: Any, key: string, count: number): { from: number; to: number } | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  const o = objectAt(v, key);
  onlyKeys(o, ["from", "to"], key);
  const from = optNumber(o, "from", key, { int: true, min: 0, max: count - 1 });
  const to = optNumber(o, "to", key, { int: true, min: 0, max: count - 1 });
  if (from === undefined || to === undefined) refuse(key, `\`${key}\` needs \`from\` and \`to\`, each 0–${count - 1}.`);
  return { from, to };
}

function resizes(params: Any, key: string, field: "width" | "height", count: number): Array<{ index: number; value: number }> {
  const v = params[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > count) refuse(key, `\`${key}\` must be an array of at most ${count} { index, ${field} }.`);
  return v.map((raw, i) => {
    const o = objectAt(raw, `${key}[${i}]`);
    onlyKeys(o, ["index", field], `${key}[${i}]`);
    const index = optNumber(o, "index", `${key}[${i}]`, { int: true, min: 0, max: count - 1 });
    const value = optNumber(o, field, `${key}[${i}]`, { min: 0.01 });
    if (index === undefined || value === undefined) refuse(`${key}[${i}]`, `\`${key}[${i}]\` needs \`index\` (0–${count - 1}) and \`${field}\` (>= 0.01).`);
    return { index, value };
  });
}

/**
 * The edit, simulated on the table's dimensions: removals, then inserts
 * (indices in the table after removals), then moves, then sizes, then cells
 * (addressed in the final table). Every index is checked here, so a bad one
 * is refused before the first change. Pure.
 */
export function planTableEdit(params: Any, dims: { rows: number; columns: number }): TableEditPlan {
  const plan: TableEditPlan = { removeRows: [], removeColumns: [], insertRows: [], insertColumns: [], columnWidths: [], rowHeights: [], cells: [], rows: dims.rows, columns: dims.columns };
  const structural = ["removeRows", "removeColumns", "insertRowsAt", "insertColumnsAt", "moveRow", "moveColumn", "columnWidths", "rowHeights", "cells"];
  if (!structural.some((k) => params[k] !== undefined)) refuse("nodeId", "Nothing to edit: give at least one of " + structural.join(", ") + ".");

  for (const [key, count, what] of [["removeRows", dims.rows, "row"], ["removeColumns", dims.columns, "column"]] as const) {
    const picked = indexList(params, key, count - 1, 100);
    if (new Set(picked).size !== picked.length) refuse(key, `\`${key}\` names a ${what} twice.`);
    if (picked.length && picked.length >= count) refuse(key, `\`${key}\` would remove every ${what}; a table keeps at least one.`, "Delete the table with figma_delete_nodes instead.");
    const sorted = [...picked].sort((a, b) => b - a);
    if (key === "removeRows") plan.removeRows = sorted;
    else plan.removeColumns = sorted;
  }
  const rows1 = dims.rows - plan.removeRows.length;
  const cols1 = dims.columns - plan.removeColumns.length;
  // Each index is a position in the table after removals; one row goes in
  // before it (numRows appends). Applied in ascending order, each call shifts
  // by the rows already inserted, so every new row lands where it was asked.
  const inserts = (key: string, count: number) => indexList(params, key, count, 100).sort((a, b) => a - b).map((idx, k) => idx + k);
  plan.insertRows = inserts("insertRowsAt", rows1);
  plan.insertColumns = inserts("insertColumnsAt", cols1);
  plan.rows = rows1 + plan.insertRows.length;
  plan.columns = cols1 + plan.insertColumns.length;
  const mr = move(params, "moveRow", plan.rows);
  if (mr) plan.moveRow = mr;
  const mc = move(params, "moveColumn", plan.columns);
  if (mc) plan.moveColumn = mc;
  plan.columnWidths = resizes(params, "columnWidths", "width", plan.columns).map((r) => ({ index: r.index, width: r.value }));
  plan.rowHeights = resizes(params, "rowHeights", "height", plan.rows).map((r) => ({ index: r.index, height: r.value }));

  if (params.cells !== undefined) {
    const cells = list(params.cells, "cells", 1, MAX_CELLS);
    plan.cells = cells.map((raw, i) => {
      const path = `cells[${i}]`;
      const o = objectAt(raw, path);
      onlyKeys(o, ["row", "column", "text", "fill", "textColor"], path);
      const row = optNumber(o, "row", path, { int: true, min: 0, max: plan.rows - 1 });
      const column = optNumber(o, "column", path, { int: true, min: 0, max: plan.columns - 1 });
      if (row === undefined || column === undefined) refuse(path, `\`${path}\` needs \`row\` (0–${plan.rows - 1}) and \`column\` (0–${plan.columns - 1}) in the table after the structural edits.`);
      const edit: CellEdit = { row, column };
      const text = optString(o, "text", path, MAX_TEXT);
      if (text !== undefined) edit.text = text;
      if (o.fill !== undefined) {
        refuseEmptyFill(o.fill, `${path}.fill`);
        edit.fill = at(`${path}.fill`, () => resolveTableColor(o.fill, `${path}.fill`).fill);
      }
      if (o.textColor !== undefined) edit.textFill = at(`${path}.textColor`, () => resolveColor("text", o.textColor, `${path}.textColor`).paint);
      if (edit.text === undefined && !edit.fill && !edit.textFill) refuse(path, `\`${path}\` changes nothing: give \`text\`, \`fill\` or \`textColor\`.`);
      return edit;
    });
  }
  return plan;
}

interface TableNodeLike extends NodeLikeW {
  numRows: number;
  numColumns: number;
  cellAt(row: number, column: number): Any;
  insertRow(i: number): void;
  insertColumn(i: number): void;
  removeRow(i: number): void;
  removeColumn(i: number): void;
  moveRow(from: number, to: number): void;
  moveColumn(from: number, to: number): void;
  resizeRow(i: number, h: number): void;
  resizeColumn(i: number, w: number): void;
}

const editTable: PluginOp = {
  write: true,
  async run(ctx) {
    const { m } = prepared(ctx);
    const { table, plan } = await beforeBoard(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) refuse("nodeId", "`nodeId` is required: the TABLE to edit.");
      const node = await board().getNodeByIdAsync(id);
      if (!node) refuse("nodeId", `No node with id \`${id}\`.`, undefined, ErrorCode.NODE_NOT_FOUND);
      if (node.type !== "TABLE") refuse("nodeId", `\`${id}\` is a ${node.type}, not a TABLE.`, "figma_create_table makes one; figma_search_nodes finds them.");
      const t = node as TableNodeLike;
      return { table: t, plan: planTableEdit(ctx.params, { rows: t.numRows, columns: t.numColumns }) };
    });

    let failedAt = "removeRows";
    try {
      for (const i of plan.removeRows) table.removeRow(i);
      failedAt = "removeColumns";
      for (const i of plan.removeColumns) table.removeColumn(i);
      failedAt = "insertRowsAt";
      for (const i of plan.insertRows) table.insertRow(i);
      failedAt = "insertColumnsAt";
      for (const i of plan.insertColumns) table.insertColumn(i);
      failedAt = "moveRow";
      if (plan.moveRow) table.moveRow(plan.moveRow.from, plan.moveRow.to);
      failedAt = "moveColumn";
      if (plan.moveColumn) table.moveColumn(plan.moveColumn.from, plan.moveColumn.to);
      failedAt = "columnWidths";
      for (const c of plan.columnWidths) table.resizeColumn(c.index, c.width);
      failedAt = "rowHeights";
      for (const r of plan.rowHeights) table.resizeRow(r.index, r.height);
    } catch (err) {
      // The table has changed by now: no `created: []`, so nobody reads this as "nothing happened".
      throw new BridgeError(err instanceof BridgeError ? err.code : ErrorCode.INVALID_PARAM, `Figma refused the table edit at \`${failedAt}\`: ${msg(err)}`, {
        hint: "The edits before it were applied; read the table (figma_get_node) before trying again. Ctrl+Z undoes the whole call.",
        partial: { updated: [table.id], failedAt },
      });
    }

    const cells: Array<{ row: number; column: number; ok: boolean; error?: string }> = [];
    for (let i = 0; i < plan.cells.length; i++) {
      const c = plan.cells[i]!;
      try {
        // A cell has no id (d.ts:11442) [C-135]: it is reached through its table.
        const cell = table.cellAt(c.row, c.column);
        if (c.fill) cell.fills = [c.fill];
        if (c.text !== undefined || c.textFill) {
          const text = sublayer(cell, "table cell");
          if (c.text !== undefined) await writeSublayer(text, c.text, m);
          else await loadSublayer(text, m);
          if (c.textFill) text.fills = [c.textFill];
        }
        cells.push({ row: c.row, column: c.column, ok: true });
      } catch (err) {
        cells.push({ row: c.row, column: c.column, ok: false, error: msg(err) });
      }
      await breathe(ctx, i, plan.cells.length, "cells");
    }
    const box = boxOf(table);
    return {
      id: table.id,
      numRows: table.numRows,
      numColumns: table.numColumns,
      ...(box ? { width: round(box.width), height: round(box.height) } : {}),
      ...(plan.columnWidths.length ? { columnWidths: columnWidthsOf(table) } : {}),
      cells,
    };
  },
};

// ── figma_edit_connectors ───────────────────────────────────────────────────

const editConnectors: PluginOp = {
  write: true,
  async run(ctx) {
    const { m } = prepared(ctx);
    const p = await beforeBoard(async () => {
      const items = list(ctx.params.connectors, "connectors", 1, MAX_ITEMS);
      const edits: Array<{ id: string; spec: ConnectorSpec }> = items.map((raw, i) => {
        const path = `connectors[${i}]`;
        const o = objectAt(raw, path);
        const id = o.nodeId;
        if (typeof id !== "string" || !id.trim()) refuse(`${path}.nodeId`, `\`${path}.nodeId\` is required: the CONNECTOR to change.`);
        const spec = parseConnector(o, path, { refs: false, weightKey: "weight", allowed: EDIT_CONNECTOR_KEYS, create: false });
        if (emptyConnectorEdit(spec)) refuse(path, `\`${path}\` changes nothing: give at least one field besides \`nodeId\`.`);
        return { id, spec };
      });
      // An end that names a missing node, another page or a connector refuses the whole call, before any write.
      for (let i = 0; i < edits.length; i++) {
        for (const end of ["from", "to"] as const) {
          const e = edits[i]!.spec[end];
          if (e && "endpointNodeId" in e) await endpointNode(e.endpointNodeId, `connectors[${i}].${end}`);
        }
      }
      const nodes = await Promise.all(edits.map((e) => board().getNodeByIdAsync(e.id)));
      return { edits, nodes };
    });
    const one = async (id: string, spec: ConnectorSpec, node: NodeLikeW | null | undefined): Promise<{ id: string; ok: boolean; error?: string }> => {
      if (!node) return { id, ok: false, error: "not found" };
      if (node.type !== "CONNECTOR") return { id, ok: false, error: `a ${node.type}, not a CONNECTOR` };
      try {
        await applyConnector(node, spec, m, false);
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: msg(err) };
      }
    };
    const items: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (let i = 0; i < p.edits.length; i++) {
      items.push(await one(p.edits[i]!.id, p.edits[i]!.spec, p.nodes[i]));
      await breathe(ctx, i, p.edits.length, "connectors");
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

// ── figma_set_board_properties ──────────────────────────────────────────────

type BoardField = "color" | "wide" | "authorVisible" | "shape" | "contentsHidden" | "language";
const BOARD_FIELDS: readonly BoardField[] = ["color", "wide", "authorVisible", "shape", "contentsHidden", "language"];

/** Which field applies to which node type (d.ts:11317, 11325, 11507, 12273, 11585) [C-135]. */
const APPLIES: Readonly<Record<string, readonly BoardField[]>> = {
  STICKY: ["color", "wide", "authorVisible"],
  SHAPE_WITH_TEXT: ["color", "shape"],
  CONNECTOR: ["color"],
  TABLE: ["color"],
  TEXT: ["color"],
  SECTION: ["color", "contentsHidden"],
  CODE_BLOCK: ["language"],
};

interface ColorWrites {
  writes: Array<(n: Any) => void>;
  /** A write sets the text sublayer's fills: its font is loaded first (create-table.md:244). */
  text?: true;
}

/** The writes `color` means on a node of `type`; throws the reason when the colour does not fit the type. */
function colorWrites(type: string, color: string, path: string): ColorWrites {
  const one = (w: (n: Any) => void): ColorWrites => ({ writes: [w] });
  const paints = (p: SolidPaint) => [p];
  switch (type) {
    case "STICKY": {
      const c = resolveColor("sticky", color, path);
      return one((n) => void (n.fills = paints(c.paint)));
    }
    case "SHAPE_WITH_TEXT": {
      const c = resolveShapeColor(color, path);
      return {
        writes: [
          (n) => void (n.fills = paints(c.fill)),
          ...(c.stroke ? [(n: Any) => void (n.strokes = paints(c.stroke!))] : []),
          ...(c.text ? [(n: Any) => void (sublayer(n, "shape").fills = paints(c.text!))] : []),
        ],
        ...(c.text ? { text: true as const } : {}),
      };
    }
    case "CONNECTOR": {
      const c = resolveColor("connector", color, path);
      return one((n) => void (n.strokes = paints(c.paint)));
    }
    case "TABLE": {
      refuseEmptyFill(color, path);
      const c = resolveTableColor(color, path);
      return one((n) => void (n.fills = paints(c.fill)));
    }
    case "TEXT": {
      const c = resolveColor("text", color, path);
      return one((n) => void (n.fills = paints(c.paint)));
    }
    case "SECTION": {
      // Hex only until the section swatches are measured [C-144].
      const c = resolveColor("section", color, path);
      return one((n) => void (n.fills = paints(c.paint)));
    }
  }
  return { writes: [] };
}

interface BoardValues {
  color?: string;
  wide?: boolean;
  authorVisible?: boolean;
  contentsHidden?: boolean;
  shape?: ShapeType;
  language?: string;
}

/**
 * One node of figma_set_board_properties: every field must apply to its type
 * and its colour must resolve, or nothing is written to it — half a property
 * set is the worse surprise. A per-item result, never a throw.
 */
async function applyBoard(
  id: string,
  node: NodeLikeW | null | undefined,
  fields: readonly BoardField[],
  v: BoardValues,
  m: Pick<Make, "loadFont">,
): Promise<{ id: string; type?: string; ok: boolean; error?: string }> {
  if (!node) return { id, ok: false, error: "not found" };
  const type = node.type;
  const applies = APPLIES[type] ?? [];
  const stray = fields.filter((f) => !applies.includes(f));
  if (stray.length) {
    const named = stray.map((f) => "`" + f + "`").join(", ");
    return { id, type, ok: false, error: `${named} does not apply to a ${type}${applies.length ? ` (it takes ${applies.join(", ")})` : ""}` };
  }
  let color: ColorWrites = { writes: [] };
  const n = node as unknown as Any;
  try {
    if (v.color !== undefined) color = colorWrites(type, v.color, "color");
    if (color.text) await loadSublayer(sublayer(n, "shape"), m);
  } catch (err) {
    return { id, type, ok: false, error: msg(err) + (err instanceof BridgeError && err.hint ? ` ${err.hint}` : "") };
  }
  try {
    if (v.wide !== undefined) n.isWideWidth = v.wide;
    if (v.authorVisible !== undefined) n.authorVisible = v.authorVisible;
    if (v.shape !== undefined) n.shapeType = v.shape;
    if (v.contentsHidden !== undefined) n.sectionContentsHidden = v.contentsHidden;
    if (v.language !== undefined) n.codeLanguage = v.language;
    for (const w of color.writes) w(n);
    return { id, type, ok: true };
  } catch (err) {
    return { id, type, ok: false, error: msg(err) };
  }
}

const setBoardProperties: PluginOp = {
  write: true,
  async run(ctx) {
    const p = await beforeBoard(async () => {
      const ids = list(ctx.params.nodeIds, "nodeIds", 1, 500).map((v, i) => {
        if (typeof v !== "string" || !v.trim()) refuse(`nodeIds[${i}]`, `\`nodeIds[${i}]\` must be a node id.`);
        return v;
      });
      const fields = BOARD_FIELDS.filter((f) => ctx.params[f] !== undefined);
      if (!fields.length) refuse("nodeIds", `Nothing to set: give at least one of ${BOARD_FIELDS.join(", ")}.`);
      const v: BoardValues = {};
      for (const k of ["wide", "authorVisible", "contentsHidden"] as const) {
        const b = optBool(ctx.params, k, "");
        if (b !== undefined) v[k] = b;
      }
      if (ctx.params.shape !== undefined) v.shape = at("shape", () => parseShapeType(ctx.params.shape, "shape"));
      if (ctx.params.language !== undefined) v.language = at("language", () => parseCodeLanguage(ctx.params.language, "language"));
      if (ctx.params.color !== undefined) {
        const c = ctx.params.color;
        // A typo is refused once, here; a real name that one node type lacks is that node's error below.
        if (typeof c !== "string" || !c.trim()) refuse("color", "`color` must be a palette name or a hex.");
        if (!/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) && !isKnownColorName(c)) {
          const all = [...new Set([...paletteNames("shape"), ...paletteNames("sticky"), ...paletteNames("connector")])];
          refuse("color", `\`color\`: ${JSON.stringify(c)} is neither a FigJam colour name nor a hex.`, `Nearest names: ${nearest(paletteKey(c), all).join(", ")}.`);
        }
        v.color = c;
      }
      const nodes = await Promise.all(ids.map((id) => board().getNodeByIdAsync(id)));
      return { ids, fields, v, nodes };
    });

    const { m } = prepared(ctx);
    const items: Array<{ id: string; type?: string; ok: boolean; error?: string }> = [];
    for (let i = 0; i < p.ids.length; i++) {
      items.push(await applyBoard(p.ids[i]!, p.nodes[i], p.fields, p.v, m));
      await breathe(ctx, i, p.ids.length, "nodes");
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

// ── figma_fit_sections ──────────────────────────────────────────────────────

function depth(node: NodeLikeW): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d++;
  return d;
}

type FitResult = Any & { id: string; ok: boolean };

/** Fit one section to what it holds; a per-item result, never a throw. */
function fitOne(id: string, node: NodeLikeW | null, pad: [number, number, number, number], minWidth?: number, minHeight?: number): FitResult {
  if (!node) return { id, ok: false, error: "not found" };
  if (node.type !== "SECTION") return { id, ok: false, error: `a ${node.type}, not a SECTION` };
  const s = node as unknown as Any & { resizeWithoutConstraints?: (w: number, h: number) => void };
  // resizeWithoutConstraints only: both sources agree it exists, while resize() on a section is contradicted [C-141].
  if (typeof s.resizeWithoutConstraints !== "function") return { id, ok: false, error: "this Figma has no SectionNode.resizeWithoutConstraints" };
  const [top, right, bottom, left] = pad;
  const kids = node.children ?? [];
  // A connector's box follows its ends: moving it by x/y breaks its route (diagram-section.md:137-143) [C-149].
  const movable = kids.filter((k) => k.type !== "CONNECTOR");
  const content = unionBox(movable.map(boxOf));
  if (!content) {
    const own = boxOf(node);
    return { id, ok: true, ...(own ? { width: round(own.width), height: round(own.height) } : {}), note: kids.length ? "holds only connectors; left as it is" : "empty; left as it is" };
  }
  try {
    // Children move only when they reach into the top or left padding.
    const dx = Math.max(0, left - content.x);
    const dy = Math.max(0, top - content.y);
    if (dx || dy) {
      for (const k of movable) {
        const at = k as unknown as { x: number; y: number };
        at.x += dx;
        at.y += dy;
      }
    }
    const w = Math.max(content.x + dx + content.width + right, minWidth ?? 0.01);
    const h = Math.max(content.y + dy + content.height + bottom, minHeight ?? 0.01);
    s.resizeWithoutConstraints(w, h);
    const after = boxOf(node);
    return {
      id,
      ok: true,
      width: round(after?.width ?? w),
      height: round(after?.height ?? h),
      ...(dx || dy ? { shifted: { x: round(dx), y: round(dy) } } : {}),
    };
  } catch (err) {
    return { id, ok: false, error: msg(err) };
  }
}

const fitSections: PluginOp = {
  write: true,
  async run(ctx) {
    const p = await beforeBoard(async () => {
      const ids = list(ctx.params.nodeIds, "nodeIds", 1, MAX_ITEMS).map((v, i) => {
        if (typeof v !== "string" || !v.trim()) refuse(`nodeIds[${i}]`, `\`nodeIds[${i}]\` must be a node id.`);
        return v;
      });
      const pad = at("padding", () => normalizePadding(ctx.params.padding ?? "32", "padding")!);
      const minWidth = optNumber(ctx.params, "minWidth", "", { min: 0.01 });
      const minHeight = optNumber(ctx.params, "minHeight", "", { min: 0.01 });
      const nodes = await Promise.all(ids.map((id) => board().getNodeByIdAsync(id)));
      return { ids, pad, minWidth, minHeight, nodes };
    });
    // Deepest first: an outer section is fitted around its inner ones' final size.
    const order = p.ids.map((id, i) => ({ id, i, node: p.nodes[i] ?? null })).sort((a, b) => (b.node ? depth(b.node) : -1) - (a.node ? depth(a.node) : -1) || a.i - b.i);
    const results: FitResult[] = new Array(p.ids.length);
    for (let k = 0; k < order.length; k++) {
      const { id, i, node } = order[k]!;
      results[i] = fitOne(id, node, p.pad, p.minWidth, p.minHeight);
      await breathe(ctx, k, order.length, "sections");
    }
    return { updated: results.filter((r) => r.ok && !r.note).length, items: results };
  },
};

// create_from_spec's board types, re-exported so ops/index.ts wires both from one module.
export { registerFigjamSpecTypes } from "../figjam/spec-types.js";

/** The board tools, by op name. Wired by the integrator into PLUGIN_OPS (ops/index.ts). */
export const FIGJAM_OPS: Record<string, PluginOp> = {
  create_stickies: createStickies,
  create_shapes_with_text: createShapes,
  create_connectors: createConnectors,
  create_table: createTable,
  create_code_block: createCodeBlock,
  create_link_preview: createLinkPreview,
  edit_table: editTable,
  edit_connectors: editConnectors,
  set_board_properties: setBoardProperties,
  fit_sections: fitSections,
};
