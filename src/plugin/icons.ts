// figma_check_layout's `icons` audit: whether an icon set was drawn as one
// construction system (role spec §4.7) — one canvas, one stroke weight, ink
// inside the live area, edges on whole pixels where an icon renders at 1x,
// one corner radius — so the set reads as one hand.
//
// The construction grid comes from the brief (details.grid: { size, padding,
// stroke?, corner? }, with details.sizes the px it renders at); nothing in
// it is a preset, since no icon grid is a standard the design rests on. The
// set is the icon components in the checked subtree (named icon/…, or every
// component when none is); a variant drawn at a size of its own (Size=16 at
// 16 × 16) is judged among the icons of that size.
//
// Warnings only where the set breaks a number it states: a canvas off the
// declared size, and more than one stroke weight (or one the grid does not
// declare). The rest is info until calibrated (§4.9). Plain functions over
// the census, after the walk.

import { type RoleContext, variantPropsOf, words } from "./a11y.js";
import { type Census, type Finding, type Index, type Layer, type Rect, bottom, r1, right } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Every threshold of the icons audit, to calibrate here. */
export const ICONS = {
  /** icon_size_mixed: a canvas within this many px of the grid's size is on it. */
  sizeTol: 0.5,
  /** stroke_mixed, corner_mixed: weights and radii this close are one. */
  same: 0.01,
  /** live_area: ink past the live area by more than this many px. */
  liveTol: 0.5,
  /** off_pixel: icons this size or smaller render at 1x, where an edge between pixels blurs; within pixelTol of a pixel edge is on it. */
  smallIcon: 32,
  pixelTol: 0.01,
  /** Offenders named per finding. */
  listed: 3,
} as const;

/** A component (or its set) named for an icon. */
const ICON_NAME = /(^| )(icon|icons|ic|glyph|glyphs|pictogram|pictograms)( |$)/;
/** Layers whose geometry is drawn. A boolean's operands are inside it and judged as its result. */
const SHAPES = new Set(["VECTOR", "LINE", "ELLIPSE", "RECTANGLE", "POLYGON", "STAR", "BOOLEAN_OPERATION", "REGULAR_POLYGON"]);

type Push = (n: NodeLike, kind: string, severity: Finding["severity"], detail: string) => void;

/** `details.grid` read: numbers, or a string holding one ("24", "24x24", "2 px"); stroke and corner may list several. */
export interface IconGrid {
  size?: number;
  padding?: number;
  strokes?: number[];
  corners?: number[];
}

const numberIn = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const numbersIn = (v: unknown): number[] | undefined => {
  const list = (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(numberIn).filter((n): n is number => n !== undefined && n > 0);
  return list.length ? list : undefined;
};

export function gridOf(details: Any): IconGrid {
  const g = details.grid;
  if (!g || typeof g !== "object" || Array.isArray(g)) return {};
  const o = g as Any;
  const size = numberIn(o.size);
  const padding = numberIn(o.padding);
  const strokes = numbersIn(o.stroke);
  const corners = numbersIn(o.corner);
  return {
    ...(size && size > 0 ? { size } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(strokes ? { strokes } : {}),
    ...(corners ? { corners } : {}),
  };
}

/** A canvas size as a key: its longer side, to the half pixel. */
const sizeKey = (b: Rect) => Math.round(Math.max(b.width, b.height) * 2) / 2;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function judgeIcons(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const icons = iconsOf(c, ix);
  if (!icons.length) {
    push(c.rootNode, "icons_unmeasured", "info",
      "found no icon here, so nothing was measured: the icons audit reads the icon components of a set (named icon/…, or every component " +
        "when none is). Check the page or the frame that holds them.");
    return out;
  }
  const details = (rc.brief?.details ?? {}) as Any;
  const grid = gridOf(details);
  const sizes = numbersIn(details.sizes) ?? [];
  const unmeasured: string[] = [];
  const why = rc.brief ? "the brief's details.grid" : "no brief was given: figma_check_layout { briefId }";

  // Each layer's icon: its nearest ancestor among the icons.
  const iconSet = new Set(icons.map((l) => l.node));
  const byIcon = new Map<Layer, Layer[]>(icons.map((l) => [l, []]));
  for (const l of c.layers) {
    for (let p = l.node.parent; p; p = p.parent) {
      if (!iconSet.has(p)) continue;
      byIcon.get(ix.byNode.get(p)!)?.push(l);
      break;
    }
  }

  if (grid.size !== undefined) canvases(icons, grid.size, sizes, push);
  else unmeasured.push(`icon_size_mixed (${rc.brief ? "the brief gives no details.grid.size" : why})`);
  mixed(icons, byIcon, grid, "stroke", push);
  if (grid.padding !== undefined) liveAreas(icons, byIcon, grid, push);
  else unmeasured.push(`live_area (${rc.brief ? "the brief gives no details.grid.padding" : why})`);
  offPixel(icons, byIcon, push);
  mixed(icons, byIcon, grid, "corner", push);
  if (unmeasured.length) push(c.rootNode, "icons_unmeasured", "info", `not measured: ${unmeasured.join("; ")}. The rest of the icons audit ran.`);
  return out;
}

/**
 * The set: the icon components in the census — a component (a variant
 * included) named for an icon or in a set named for one; every component when
 * none is named; else frames and instances named for an icon. An icon used
 * inside another icon is part of it.
 */
function iconsOf(c: Census, ix: Index): Layer[] {
  const all = c.root ? [c.root, ...c.layers] : c.layers;
  const named = (l: Layer) => {
    if (ICON_NAME.test(words(l.node.name))) return true;
    const p = l.node.parent;
    return p?.type === "COMPONENT_SET" && ICON_NAME.test(words(p.name));
  };
  const comps = all.filter((l) => l.node.type === "COMPONENT");
  let list = comps.filter(named);
  if (!list.length) list = comps;
  if (!list.length) list = all.filter((l) => (l.node.type === "FRAME" || l.node.type === "INSTANCE") && named(l));
  return list.filter((l) => !list.some((o) => o !== l && ix.isAncestor(o.node, l.node)));
}

/** A variant that names its own canvas: a property value that is a number of px equal to its width and height. */
function namedSize(icon: Layer): number | undefined {
  if (icon.node.type !== "COMPONENT") return undefined;
  const props = variantPropsOf(icon.node);
  for (const k of Object.keys(props)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(px|dp|pt)?\s*$/i.exec(props[k]!);
    if (!m) continue;
    const s = Number(m[1]);
    if (near(icon.box.width, s, ICONS.sizeTol) && near(icon.box.height, s, ICONS.sizeTol)) return s;
  }
  return undefined;
}

/**
 * icon_size_mixed: an icon whose canvas is not the grid's size — unless it is
 * a variant that names its own size (Size=16 at 16 × 16) and that size is one
 * the brief renders at (details.sizes; any, when none are listed).
 */
function canvases(icons: Layer[], size: number, sizes: number[], push: Push): void {
  for (const icon of icons) {
    const b = icon.box;
    if (near(b.width, size, ICONS.sizeTol) && near(b.height, size, ICONS.sizeTol)) continue;
    const own = namedSize(icon);
    if (own !== undefined && (!sizes.length || sizes.some((s) => near(s, own, ICONS.sizeTol)))) continue;
    push(icon.node, "icon_size_mixed", "warning",
      `is ${r1(b.width)} × ${r1(b.height)} px; the set's grid is ${size} × ${size} px (details.grid.size). Icons on mixed canvases do not swap for ` +
        `one another, nor line up on their keylines: draw it on the ${size} px canvas (figma_resize_nodes on the component, the drawing kept on the ` +
        "keylines), or make it a size variant the brief lists in details.sizes.");
  }
}

/** The px a shape's stroke or corner is drawn at, or undefined when it has none to judge (or a mixed value). */
function valueOf(l: Layer, what: "stroke" | "corner"): number | undefined {
  if (what === "stroke") {
    const w = l.a.strokeWeight;
    return SHAPES.has(l.node.type) && l.stroked && typeof w === "number" && w > 0 ? w : undefined;
  }
  const r = l.a.cornerRadius;
  return (SHAPES.has(l.node.type) || l.node.type === "FRAME") && typeof r === "number" && r > 0 ? r : undefined;
}

/**
 * stroke_mixed (warning) and corner_mixed (info): more than one stroke weight
 * or corner radius among the icons of one canvas size — or, at the grid's
 * size, one the grid does not declare (details.grid.stroke / corner, which may
 * list several). A set of 16 px variants drawn finer than the 24 px icons is
 * judged among its own size.
 */
function mixed(icons: Layer[], byIcon: Map<Layer, Layer[]>, grid: IconGrid, what: "stroke" | "corner", push: Push): void {
  const kind = what === "stroke" ? "stroke_mixed" : "corner_mixed";
  const severity: Finding["severity"] = what === "stroke" ? "warning" : "info";
  const declared = what === "stroke" ? grid.strokes : grid.corners;
  const word = what === "stroke" ? "stroke" : "corner radius";
  const groups = new Map<number, Array<{ value: number; l: Layer; icon: Layer }>>();
  for (const icon of icons) {
    for (const l of byIcon.get(icon) ?? []) {
      const v = valueOf(l, what);
      if (v === undefined) continue;
      const k = sizeKey(icon.box);
      groups.set(k, [...(groups.get(k) ?? []), { value: v, l, icon }]);
    }
  }
  for (const [size, uses] of groups) {
    // One value per cluster of near-equal values, most used first: the set's own.
    const clusters: Array<{ value: number; uses: typeof uses }> = [];
    for (const u of uses) {
      const cl = clusters.find((x) => near(x.value, u.value, ICONS.same));
      if (cl) cl.uses.push(u);
      else clusters.push({ value: u.value, uses: [u] });
    }
    clusters.sort((a, b) => b.uses.length - a.uses.length || a.value - b.value);
    const atGrid = grid.size !== undefined && near(size, grid.size, ICONS.sizeTol);
    const allowed = declared && atGrid ? declared : null;
    const off = allowed ? clusters.filter((x) => !allowed.some((d) => near(d, x.value, ICONS.same))) : clusters.slice(1);
    for (const x of off) {
      const first = x.uses[0]!;
      const iconsUsing = new Set(x.uses.map((u) => u.icon)).size;
      const count = `${x.uses.length} shape${x.uses.length > 1 ? "s" : ""} in ${iconsUsing} icon${iconsUsing > 1 ? "s" : ""}, first "${first.icon.node.name}"`;
      const fix = what === "stroke" ? "figma_set_strokes" : "figma_set_corner_radius";
      push(first.l.node, kind, severity,
        allowed
          ? `draws a ${r1(x.value)} px ${word} (${count}); the set's grid declares ${allowed.map((d) => `${r1(d)} px`).join(" or ")} ` +
              `(details.grid.${what}). One ${word} is what makes a set read as one hand: redraw it at the declared value (${fix}), or declare this one too.`
          : `draws a ${r1(x.value)} px ${word} (${count}) where the other ${r1(size)} px icons draw ${r1(clusters[0]!.value)} px ` +
              `(${clusters[0]!.uses.length} shapes): more than one ${word} in one set. Redraw it at ${r1(clusters[0]!.value)} px (${fix}), or declare ` +
              `both in details.grid.${what}.`);
    }
  }
}

/** A layer's ink: absoluteRenderBounds when Figma reports it, else what it covers, else its box. */
function inkOf(l: Layer): Rect {
  const r = l.a.absoluteRenderBounds as Rect | null | undefined;
  return r && Number.isFinite(r.width) ? r : (l.cover?.outer ?? l.box);
}

/** live_area: ink past the canvas inset by details.grid.padding (scaled to the icon's canvas when it is not the grid's size). */
function liveAreas(icons: Layer[], byIcon: Map<Layer, Layer[]>, grid: IconGrid, push: Push): void {
  for (const icon of icons) {
    const b = icon.box;
    const scale = grid.size ? b.width / grid.size : 1;
    const pad = grid.padding! * scale;
    const live = { x: b.x + pad, y: b.y + pad, width: b.width - 2 * pad, height: b.height - 2 * pad };
    if (live.width <= 0 || live.height <= 0) continue;
    let worst: { by: number; side: string; l: Layer } | null = null;
    for (const l of byIcon.get(icon) ?? []) {
      if (!(l.filled || l.stroked || l.text)) continue;
      const ink = inkOf(l);
      const over: Array<[string, number]> = [
        ["left", live.x - ink.x], ["right", right(ink) - right(live)], ["top", live.y - ink.y], ["bottom", bottom(ink) - bottom(live)],
      ];
      for (const [side, by] of over) if (by > ICONS.liveTol && (!worst || by > worst.by)) worst = { by, side, l };
    }
    if (!worst) continue;
    push(icon.node, "live_area", "info",
      `its ink runs ${r1(worst.by)} px past the live area on the ${worst.side} ("${worst.l.node.name}"): the ${r1(b.width)} px canvas less ` +
        `${r1(pad)} px padding (details.grid.padding). Keep the drawing inside the live area so the set's weight and size read even, or keep the ` +
        "overshoot only where a round shape needs it to look the same size.");
  }
}

/** Distance to the nearest whole pixel. */
const frac = (v: number) => Math.abs(v - Math.round(v));

/**
 * off_pixel: in an icon of 32 px or less, which renders at 1x, a shape whose
 * box sits between pixels blurs. Positions are whole pixels — or half pixels
 * for a centred stroke of odd whole weight, whose ink then lands on pixels —
 * and sizes whole. Rotated shapes and a boolean's operands are not judged.
 */
function offPixel(icons: Layer[], byIcon: Map<Layer, Layer[]>, push: Push): void {
  for (const icon of icons) {
    const b = icon.box;
    if (Math.max(b.width, b.height) > ICONS.smallIcon) continue;
    const offenders: string[] = [];
    for (const l of byIcon.get(icon) ?? []) {
      if (!SHAPES.has(l.node.type) || !(l.filled || l.stroked)) continue;
      let operand = false;
      for (let p = l.node.parent; p && p !== icon.node; p = p.parent) if (p.type === "BOOLEAN_OPERATION") operand = true;
      if (operand) continue;
      const rot = typeof l.a.rotation === "number" ? (l.a.rotation as number) : 0;
      if (frac(rot / 90) > 1e-6) continue;
      const w = l.a.strokeWeight;
      const centredOdd = l.stroked && String(l.a.strokeAlign ?? "CENTER") === "CENTER" && typeof w === "number" && frac(w) < 1e-6 && Math.round(w) % 2 === 1;
      const pos = (v: number) => frac(v) <= ICONS.pixelTol || (centredOdd && Math.abs(frac(v) - 0.5) <= ICONS.pixelTol);
      const x = l.box.x - b.x;
      const y = l.box.y - b.y;
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const bad = [
        ...(!pos(x) ? [`x ${r2(x)}`] : []),
        ...(!pos(y) ? [`y ${r2(y)}`] : []),
        ...(frac(l.box.width) > ICONS.pixelTol ? [`${r2(l.box.width)} wide`] : []),
        ...(frac(l.box.height) > ICONS.pixelTol ? [`${r2(l.box.height)} tall`] : []),
      ];
      if (bad.length) offenders.push(`"${l.node.name}" at ${bad.join(", ")}`);
    }
    if (!offenders.length) continue;
    push(icon.node, "off_pixel", "info",
      `renders at 1x at ${r1(Math.max(b.width, b.height))} px, and ${offenders.length} of its shapes sit between pixels ` +
        `(${offenders.slice(0, ICONS.listed).join("; ")}${offenders.length > ICONS.listed ? "; …" : ""}): their edges blur. Snap them to whole ` +
        "pixels — a centred odd stroke to half pixels (figma_move_nodes, figma_resize_nodes).");
  }
}
