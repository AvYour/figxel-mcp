// Shapes and vector operations — the rest of what Figma's design mode can draw
// (tools.md § create, § modify, § style). The official Figma MCP reaches these
// only by writing Plugin API JavaScript; here each is a typed tool [C-083].
//
// API per @figma/plugin-typings 1.141.0:
//   - figma.createLine() / createPolygon() / createStar(): a line is resized with a
//     height of exactly 0, its strokeCap decorates both ends; a polygon has
//     `pointCount` (>= 3); a star has `pointCount` and `innerRadius` (0..1).
//   - figma.createNodeFromSvg(svg) wraps the vectors in a node. It accepts the
//     whole SVG path grammar, whereas `vectorPaths` takes only an absolute subset
//     (M, L, Q, C, Z) — so a vector is drawn through it and lifted out. The typings
//     say FrameNode, but measured: an <svg> without width, height or viewBox comes
//     back as a GROUP, which Figma deletes as soon as its last child leaves [C-086].
//   - figma.union / subtract / intersect / exclude(nodes, parent, index?) and
//     figma.flatten(nodes, parent?, index?) are PluginAPI methods.
//   - `isMask` / `maskType` ('ALPHA' | 'VECTOR' | 'LUMINANCE') on a blend node.
//   - `layoutGrids` on a frame: ROWS / COLUMNS (alignment, gutterSize, count,
//     sectionSize?, offset?) or GRID (sectionSize).

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { requireIds, resolveAll, type ItemResult } from "./modify.js";
import { str } from "../read.js";
import { append, applySizing, num, parentFor, parseColor, parseSizing, type FigmaWrite, type NodeLikeW, type SolidPaint } from "../write.js";
// has(), not `in`: a member check on a board or deck node may throw [C-145].
import { has } from "../safe.js";
// A failure before the node exists provably changed nothing — and says so,
// through the one wrapper every write op shares [C-096].
import { unchanged } from "../guard.js";

type Any = Record<string, unknown>;
const api = () => (globalThis as unknown as { figma: FigmaWrite & Any }).figma;

function place(node: NodeLikeW, ctx: OpContext): void {
  const at = node as unknown as { x: number; y: number };
  const x = num(ctx.params, "x");
  const y = num(ctx.params, "y");
  if (x !== undefined) at.x = x;
  if (y !== undefined) at.y = y;
}

/** Fill, stroke and stroke weight shared by every closed shape. */
interface Paints {
  fill?: SolidPaint;
  stroke?: SolidPaint;
  strokeWeight?: number;
}

function readPaints(params: Any): Paints {
  const fill = str(params, "fill");
  const stroke = str(params, "stroke");
  const weight = num(params, "strokeWeight");
  if (weight !== undefined && weight < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`strokeWeight` must be >= 0.");
  return {
    ...(fill ? { fill: parseColor(fill, "fill") } : {}),
    ...(stroke ? { stroke: parseColor(stroke, "stroke") } : {}),
    ...(weight !== undefined ? { strokeWeight: weight } : {}),
  };
}

function applyPaints(node: Any, p: Paints): void {
  if (p.fill) node.fills = [p.fill];
  if (p.stroke) {
    node.strokes = [p.stroke];
    node.strokeWeight = p.strokeWeight ?? 1;
  } else if (p.strokeWeight !== undefined) {
    node.strokeWeight = p.strokeWeight;
  }
}

/** Finish a new node: name, parent, position, sizing — undoing it if sizing is refused. */
function finish(node: NodeLikeW, parent: NodeLikeW, ctx: OpContext, sizing: ReturnType<typeof parseSizing>): void {
  const name = str(ctx.params, "name");
  if (name) node.name = name;
  append(parent, node);
  place(node, ctx);
  try {
    applySizing(node, sizing);
  } catch (err) {
    node.remove?.();
    unchanged(err);
  }
}

const size = (n: NodeLikeW) => {
  const b = n as unknown as { width: number; height: number };
  return { width: Math.round(b.width * 100) / 100, height: Math.round(b.height * 100) / 100 };
};

// ── line ─────────────────────────────────────────────────────────────────────

const CAPS: Record<string, string> = {
  none: "NONE", round: "ROUND", square: "SQUARE",
  arrow: "ARROW_LINES", "arrow-filled": "ARROW_EQUILATERAL", triangle: "TRIANGLE_FILLED",
  circle: "CIRCLE_FILLED", diamond: "DIAMOND_FILLED",
};

const createLine: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const p = await (async () => {
      try {
        const length = num(ctx.params, "length");
        if (length === undefined || length <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`length` must be a positive number (px).");
        const capName = (str(ctx.params, "cap") ?? "none").toLowerCase();
        const cap = CAPS[capName];
        if (!cap) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`cap\` must be one of: ${Object.keys(CAPS).join(", ")}.`);
        const weight = num(ctx.params, "weight", 1)!;
        if (weight <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`weight` must be > 0.");
        const dash = ctx.params.dashPattern;
        if (dash !== undefined && (!Array.isArray(dash) || dash.some((d) => typeof d !== "number" || d < 0))) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`dashPattern` must be an array of non-negative numbers, e.g. [4, 4].");
        }
        return {
          length,
          cap,
          weight,
          dash: dash as number[] | undefined,
          color: parseColor(str(ctx.params, "color") ?? "#000000", "color"),
          angle: num(ctx.params, "angle", 0)!,
          parent: await parentFor(figma, str(ctx.params, "parentId")),
        };
      } catch (err) {
        unchanged(err);
      }
    })();
    const create = figma.createLine as (() => NodeLikeW) | undefined;
    if (typeof create !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create lines.");
    const line = create.call(figma);
    const l = line as unknown as Any & { resize(w: number, h: number): void };
    // A line is resized with a height of exactly 0 (typings: LayoutMixin.resize).
    l.resize(p.length, 0);
    l.strokes = [p.color];
    l.strokeWeight = p.weight;
    l.strokeCap = p.cap;
    if (p.dash) l.dashPattern = p.dash;
    if (p.angle) l.rotation = p.angle;
    finish(line, p.parent, ctx, undefined);
    return { id: line.id, name: line.name, type: line.type, length: p.length, angle: p.angle };
  },
};

// ── polygon & star ──────────────────────────────────────────────────────────

function pointShape(kind: "polygon" | "star"): PluginOp {
  return {
    write: true,
    async run(ctx: OpContext) {
      const figma = api();
      const p = await (async () => {
        try {
          const width = num(ctx.params, "width");
          const height = num(ctx.params, "height");
          if (width === undefined || width <= 0 || height === undefined || height <= 0) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, "`width` and `height` must be positive numbers.");
          }
          const points = num(ctx.params, "pointCount", kind === "star" ? 5 : 3)!;
          if (!Number.isInteger(points) || points < 3) throw new BridgeError(ErrorCode.INVALID_PARAM, "`pointCount` must be an integer >= 3.");
          const inner = num(ctx.params, "innerRadius");
          if (inner !== undefined && (inner < 0 || inner > 1)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`innerRadius` must be between 0 and 1.");
          return {
            width, height, points, inner,
            paints: readPaints(ctx.params),
            radius: num(ctx.params, "cornerRadius"),
            sizing: parseSizing(ctx.params.sizing),
            parent: await parentFor(figma, str(ctx.params, "parentId")),
          };
        } catch (err) {
          unchanged(err);
        }
      })();
      const factory = (kind === "star" ? figma.createStar : figma.createPolygon) as (() => NodeLikeW) | undefined;
      if (typeof factory !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type cannot create a ${kind}.`);
      const node = factory.call(figma);
      const n = node as unknown as Any & { resize(w: number, h: number): void };
      n.resize(p.width, p.height);
      n.pointCount = p.points;
      if (kind === "star" && p.inner !== undefined) n.innerRadius = p.inner;
      if (p.radius !== undefined) n.cornerRadius = p.radius;
      applyPaints(n, p.paints);
      finish(node, p.parent, ctx, p.sizing);
      return { id: node.id, name: node.name, type: node.type, pointCount: p.points, ...size(node) };
    },
  };
}

// ── vector from an SVG path ─────────────────────────────────────────────────

/** Remove the SVG wrapper unless Figma already did (an emptied GROUP goes by itself) [C-086]. */
function drop(wrapper: NodeLikeW): void {
  if (!(wrapper as unknown as { removed?: boolean }).removed) wrapper.remove?.();
}

/** Escape a value for an XML attribute. */
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const createVector: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const p = await (async () => {
      try {
        const path = str(ctx.params, "path")?.trim();
        if (!path) throw new BridgeError(ErrorCode.INVALID_PARAM, "`path` is required: SVG path data, e.g. \"M0 0 L24 12 L0 24 Z\".");
        if (!/^[MmZzLlHhVvCcSsQqTtAa0-9eE\s,.+-]+$/.test(path)) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`path` must be SVG path data (commands M L H V C S Q T A Z and numbers).");
        }
        const paints = readPaints(ctx.params);
        const w = num(ctx.params, "width");
        const h = num(ctx.params, "height");
        if ((w !== undefined && w <= 0) || (h !== undefined && h <= 0)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`width` / `height` must be > 0.");
        return { path, paints, w, h, sizing: parseSizing(ctx.params.sizing), parent: await parentFor(figma, str(ctx.params, "parentId")) };
      } catch (err) {
        unchanged(err);
      }
    })();
    const fromSvg = figma.createNodeFromSvg as ((s: string) => NodeLikeW) | undefined;
    if (typeof fromSvg !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create vectors.");
    // A path with no fill of its own still closes visibly: give it the fill now
    // (or none when only a stroke was asked for) so the SVG default black never shows.
    const fillAttr = p.paints.fill ? "#000000" : p.paints.stroke ? "none" : "#000000";
    const strokeAttr = p.paints.stroke ? ` stroke="#000000" stroke-width="${p.paints.strokeWeight ?? 1}"` : "";
    let frame: NodeLikeW;
    try {
      frame = fromSvg.call(figma, `<svg xmlns="http://www.w3.org/2000/svg"><path d="${attr(p.path)}" fill="${fillAttr}"${strokeAttr}/></svg>`);
    } catch (err) {
      unchanged(new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not read the path: ${err instanceof Error ? err.message : String(err)}`));
    }
    const vector = (frame.children ?? []).find((c) => c.type === "VECTOR");
    if (!vector) {
      drop(frame);
      unchanged(new BridgeError(ErrorCode.INVALID_PARAM, "The path produced no vector (is it empty?)."));
    }
    // Lift the vector out of the wrapper frame and drop the wrapper.
    append(p.parent, vector);
    drop(frame);
    const v = vector as unknown as Any & { width: number; height: number; rescale?(s: number): void; resize(w: number, h: number): void };
    if (p.w !== undefined && p.h !== undefined) v.resize(p.w, p.h);
    else if (p.w !== undefined && v.width > 0) v.rescale?.(p.w / v.width);
    else if (p.h !== undefined && v.height > 0) v.rescale?.(p.h / v.height);
    applyPaints(v, p.paints);
    if (!p.paints.fill && p.paints.stroke) v.fills = [];
    vector.name = str(ctx.params, "name") ?? "Vector";
    finish(vector, p.parent, ctx, p.sizing);
    return { id: vector.id, name: vector.name, type: vector.type, ...size(vector) };
  },
};

/**
 * A VECTOR drawn from SVG path data, lifted out of the wrapper frame that
 * createNodeFromSvg makes and left on the current page for the caller to
 * place — or, given `parent`, appended straight into it. Used by
 * create_from_spec's `vector` type; a build into a slide passes the parent,
 * because a node parked on the page sits outside every slide, and one
 * positioned before its final append can land 240 px off [C-146].
 */
export function vectorFromPath(figma: FigmaWrite & Any, path: string, w?: number, h?: number, parent?: NodeLikeW): NodeLikeW {
  const fromSvg = figma.createNodeFromSvg as ((s: string) => NodeLikeW) | undefined;
  if (typeof fromSvg !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create vectors.");
  const frame = fromSvg.call(figma, `<svg xmlns="http://www.w3.org/2000/svg"><path d="${attr(path)}" fill="#000000"/></svg>`);
  const vector = (frame.children ?? []).find((c) => c.type === "VECTOR");
  if (!vector) {
    drop(frame);
    throw new BridgeError(ErrorCode.INVALID_PARAM, "The path produced no vector (is it empty?).");
  }
  try {
    if (parent) append(parent, vector);
    else figma.currentPage.appendChild!(vector);
  } finally {
    drop(frame); // a refused append takes the vector with its wrapper: nothing is left behind
  }
  const v = vector as unknown as { width: number; height: number; rescale?(s: number): void; resize(w: number, h: number): void };
  if (w !== undefined && h !== undefined) v.resize(w, h);
  else if (w !== undefined && v.width > 0) v.rescale?.(w / v.width);
  else if (h !== undefined && v.height > 0) v.rescale?.(h / v.height);
  return vector;
}

/** SVG path data: commands and numbers only, so it is safe inside an attribute. */
export const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE\s,.+-]+$/;

// ── boolean operations & flatten ────────────────────────────────────────────

const BOOLEAN: Record<string, string> = { union: "union", subtract: "subtract", intersect: "intersect", exclude: "exclude" };

/** Nodes that share one parent, and where the lowest of them sits in it. */
async function siblings(ctx: OpContext, min: number): Promise<{ nodes: NodeLikeW[]; parent: NodeLikeW; index: number | undefined; missing: ItemResult[] }> {
  const ids = requireIds(ctx);
  const nodes: NodeLikeW[] = [];
  const missing: ItemResult[] = [];
  for (const { id, node } of await resolveAll(ids)) {
    if (node) nodes.push(node);
    else missing.push({ id, ok: false, error: "not found" });
  }
  if (nodes.length < min) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `Needs at least ${min} existing node${min > 1 ? "s" : ""} (found ${nodes.length}).`, { partial: { created: [] } });
  }
  const parent = nodes[0]!.parent;
  if (!parent || nodes.some((n) => n.parent?.id !== parent.id)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "These nodes do not share one parent.", {
      hint: "Combine shapes that sit in the same frame; figma_reparent_nodes can bring them together first.",
      partial: { created: [] },
    });
  }
  const kids = parent.children ?? [];
  const index = Math.min(...nodes.map((n) => kids.findIndex((s) => s.id === n.id)).filter((i) => i >= 0));
  return { nodes, parent, index: Number.isFinite(index) ? index : undefined, missing };
}

const booleanNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const opName = BOOLEAN[(str(ctx.params, "operation") ?? "").toLowerCase()];
    if (!opName) throw new BridgeError(ErrorCode.INVALID_PARAM, "`operation` must be union, subtract, intersect or exclude.", { partial: { created: [] } });
    const s = await siblings(ctx, 2);
    const fn = figma[opName] as ((n: readonly NodeLikeW[], p: NodeLikeW, i?: number) => NodeLikeW) | undefined;
    // Figma paints every boolean result its default grey, whatever the shapes
    // were [C-086]; the lowest shape is the one a subtract cuts into, so its
    // paint is the one the result should keep. Read before the op moves it.
    const kids = s.parent.children ?? [];
    const lowest = [...s.nodes].sort((a, b) => kids.findIndex((k) => k.id === a.id) - kids.findIndex((k) => k.id === b.id))[0]!;
    const paint = snapshotPaint(lowest);
    if (typeof fn !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type has no ${opName}.`);
    let made: NodeLikeW;
    try {
      // Order matters for subtract: the BOTTOM-most node is what the others cut
      // into, as in Figma's own menu — nodeIds are passed in their layer order.
      made = fn.call(figma, s.nodes, s.parent, s.index);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the ${opName}: ${err instanceof Error ? err.message : String(err)}`, { partial: { created: [] } });
    }
    const name = str(ctx.params, "name");
    if (name) made.name = name;
    const painted = await restorePaint(made, paint);
    return {
      id: made.id, name: made.name, type: made.type, operation: opName.toUpperCase(), childCount: s.nodes.length,
      ...(painted ? { paintFrom: lowest.id } : {}), items: s.missing,
    };
  },
};

type Paint = { fills?: unknown; strokes?: unknown; strokeWeight?: unknown; fillStyleId?: unknown; strokeStyleId?: unknown };

/** A shape's paint as plain data, or undefined when it is mixed or has none. */
function snapshotPaint(node: NodeLikeW): Paint | undefined {
  const n = node as unknown as Paint;
  const fills = Array.isArray(n.fills) ? n.fills : undefined;
  const strokes = Array.isArray(n.strokes) ? n.strokes : undefined;
  if (!fills?.length && !strokes?.length) return undefined;
  const copy = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
  return {
    ...(fills ? { fills: copy(fills) } : {}),
    ...(strokes ? { strokes: copy(strokes) } : {}),
    ...(typeof n.strokeWeight === "number" ? { strokeWeight: n.strokeWeight } : {}),
    ...(typeof n.fillStyleId === "string" && n.fillStyleId ? { fillStyleId: n.fillStyleId } : {}),
    ...(typeof n.strokeStyleId === "string" && n.strokeStyleId ? { strokeStyleId: n.strokeStyleId } : {}),
  };
}

/** Put a snapshot back on a node; true when anything was applied. */
async function restorePaint(node: NodeLikeW, paint: Paint | undefined): Promise<boolean> {
  if (!paint) return false;
  const n = node as unknown as Paint & {
    setFillStyleIdAsync?: (id: string) => Promise<void>;
    setStrokeStyleIdAsync?: (id: string) => Promise<void>;
  };
  try {
    if (paint.fills) n.fills = paint.fills;
    if (paint.strokes) n.strokes = paint.strokes;
    if (paint.strokeWeight !== undefined) n.strokeWeight = paint.strokeWeight;
    // Style links go on after the raw paint, which would otherwise replace them.
    if (typeof paint.fillStyleId === "string") await n.setFillStyleIdAsync?.(paint.fillStyleId);
    if (typeof paint.strokeStyleId === "string") await n.setStrokeStyleIdAsync?.(paint.strokeStyleId);
    return true;
  } catch {
    return false;
  }
}

const flattenNodes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const s = await siblings(ctx, 1);
    const fn = figma.flatten as ((n: readonly NodeLikeW[], p?: NodeLikeW, i?: number) => NodeLikeW) | undefined;
    if (typeof fn !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot flatten.");
    let made: NodeLikeW;
    try {
      made = fn.call(figma, s.nodes, s.parent, s.index);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused to flatten: ${err instanceof Error ? err.message : String(err)}`, { partial: { created: [] } });
    }
    const name = str(ctx.params, "name");
    if (name) made.name = name;
    return { id: made.id, name: made.name, type: made.type, items: s.missing };
  },
};

// ── mask ─────────────────────────────────────────────────────────────────────

const MASK_TYPES: Record<string, string> = { alpha: "ALPHA", vector: "VECTOR", luminance: "LUMINANCE" };

const setMask: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const id = str(ctx.params, "nodeId");
    if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
    const typeName = str(ctx.params, "maskType")?.toLowerCase();
    const maskType = typeName === undefined ? undefined : MASK_TYPES[typeName];
    if (typeName !== undefined && !maskType) throw new BridgeError(ErrorCode.INVALID_PARAM, "`maskType` must be alpha, vector or luminance.");
    const node = await api().getNodeByIdAsync(id);
    if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`);
    const n = node as unknown as Any;
    if (!has(n, "isMask")) throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${node.type} cannot be a mask.`);
    const on = ctx.params.isMask !== false;
    n.isMask = on;
    if (maskType) n.maskType = maskType;
    return {
      id: node.id, name: node.name, isMask: on, maskType: n.maskType,
      note: on ? "A mask clips the layers ABOVE it in the same parent; put it below what it should crop (figma_reorder_nodes)." : undefined,
    };
  },
};

// ── layout grids ─────────────────────────────────────────────────────────────

const ALIGN: Record<string, string> = { stretch: "STRETCH", center: "CENTER", start: "MIN", min: "MIN", end: "MAX", max: "MAX" };

/** One grid entry from the schema's friendly shape into Figma's LayoutGrid. */
export function toLayoutGrid(raw: unknown, i: number): Any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}]\` must be an object.`);
  const g = raw as Any;
  const pattern = String(g.pattern ?? "").toUpperCase();
  const color = g.color === undefined ? undefined : parseColor(g.color, `grids[${i}].color`);
  // A grid colour is RGBA (typings: LayoutGrid.color), not a paint.
  const rgba = color ? { ...color.color, a: color.opacity ?? 0.1 } : undefined;
  const visible = g.visible === undefined ? undefined : g.visible !== false;
  const base = { ...(rgba ? { color: rgba } : {}), ...(visible !== undefined ? { visible } : {}) };
  const n = (k: string) => (typeof g[k] === "number" && Number.isFinite(g[k]) ? (g[k] as number) : undefined);
  if (pattern === "GRID") {
    const sectionSize = n("sectionSize");
    if (sectionSize === undefined || sectionSize <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}].sectionSize\` is required for a GRID (px).`);
    return { pattern: "GRID", sectionSize, ...base };
  }
  if (pattern !== "COLUMNS" && pattern !== "ROWS") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}].pattern\` must be columns, rows or grid.`);
  const count = n("count");
  if (count === undefined || !Number.isInteger(count) || count < 1) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}].count\` must be an integer >= 1.`);
  const alignment = ALIGN[String(g.alignment ?? "stretch").toLowerCase()];
  if (!alignment) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}].alignment\` must be stretch, center, start or end.`);
  const sectionSize = n("sectionSize");
  if (alignment !== "STRETCH" && sectionSize === undefined) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`grids[${i}].sectionSize\` (column or row size, px) is required unless alignment is stretch.`);
  }
  return {
    pattern, alignment, count, gutterSize: n("gutter") ?? 20,
    ...(alignment !== "CENTER" ? { offset: n("margin") ?? 0 } : {}),
    ...(sectionSize !== undefined ? { sectionSize } : {}),
    ...base,
  };
}

const setLayoutGrids: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const raw = ctx.params.grids;
    if (!Array.isArray(raw)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`grids` must be an array ([] removes every grid).");
    const grids = raw.map((g, i) => toLayoutGrid(g, i)); // all checked before any node changes
    const items: ItemResult[] = [];
    for (const { id, node } of await resolveAll(requireIds(ctx))) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (!has(node, "layoutGrids")) {
        items.push({ id, ok: false, error: `a ${node.type} has no layout grids (frames and components do)` });
        continue;
      }
      try {
        (node as unknown as Any).layoutGrids = grids;
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

export const SHAPE_OPS: Record<string, PluginOp> = {
  create_line: createLine,
  create_polygon: pointShape("polygon"),
  create_star: pointShape("star"),
  create_vector: createVector,
  boolean_nodes: booleanNodes,
  flatten_nodes: flattenNodes,
  set_mask: setMask,
  set_layout_grids: setLayoutGrids,
};
