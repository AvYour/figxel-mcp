// figma_check_layout's `system` audit: whether the work keeps the numbers its
// brief wrote down before the first element (role spec §4.4) — the format's
// size, the type scale, the spacing base, the grid's columns, the palette —
// and the two optical corrections a finished page makes by eye: ink aligned
// rather than boxes, and punctuation hung outside the column. The design
// skill says "every number from a stated rule"; this measures it.
//
// What it cannot measure it does not guess: without a brief (or its system
// numbers) the scale, spacing, palette and format are left alone, and without
// a layout grid or `system.grid` so is the grid — said once, as one info, never
// a warning. Warnings only where a number was stated: the format's size, and a
// block 1–4 px off a column edge (a slip, as craft's no_shared_edge near miss).

import { type RoleContext } from "./a11y.js";
import { type Census, type Finding, type Index, type Layer, type Rect, type Rgb, hex, r1, right } from "./craft.js";
import type { NodeLike } from "./read.js";
import { TELLS } from "./tells.js";

type Any = Record<string, unknown>;

/** Every threshold of the system audit, to calibrate here. */
export const SYSTEM = {
  /** format_mismatch: the frame's size may differ from the format's by this much. */
  formatTolerance: 0.5,
  /** off_scale: a size within max(scaleTolPx, scaleTolShare × the step) of a scale step is on it; a listed size within sizeListTolPx. */
  scaleTolPx: 1,
  scaleTolShare: 0.02,
  sizeListTolPx: 0.5,
  /** off_spacing: a value this close to a multiple of the base is one. */
  spacingTol: 0.01,
  /** off_grid: an edge this close to a column edge is on it; up to gridSlip px off is a slip (a warning), more is off the grid. */
  gridOn: 1,
  gridSlip: 4,
  /** off_palette: colours closer than this ΔE (CIE76) are one colour. */
  paletteDeltaE: 2,
  /** optical_margin: texts whose box edges are this close share an edge; inks further apart than max(opticalMin, opticalShare × size) do not. */
  opticalEdge: 1,
  opticalMin: 1,
  opticalShare: 0.03,
  /** hanging_punctuation: marks that hang, and how far, in em. */
  openers: "\"'“‘„‚«‹•·–—-",
  hangEm: 0.4,
  pairCap: 400,
} as const;

type Push = (n: NodeLike, kind: string, severity: Finding["severity"], detail: string) => void;

export function judgeSystem(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const brief = rc.brief;
  const sys = brief?.system;
  const skipped: string[] = [];
  if (brief?.lines.format) formats(c, brief.lines.format, rc, push, skipped);
  else skipped.push(brief ? "format_mismatch (the brief gives no format)" : "format_mismatch");
  if (sys && typeof sys.bodySize === "number" && ((typeof sys.ratio === "number" && sys.ratio > 1) || (Array.isArray(sys.sizes) && sys.sizes.length))) {
    scale(ix, sys.bodySize, sys.ratio, sys.sizes, push);
  } else skipped.push("off_scale");
  if (sys && typeof sys.spacingBase === "number" && sys.spacingBase > 0) spacing(c, sys.spacingBase, push);
  else skipped.push("off_spacing");
  if (!grid(c, ix, sys?.grid, push)) skipped.push("off_grid (no layout grid on a frame here, and no system.grid)");
  if (sys && Array.isArray(sys.palette) && sys.palette.length) palette(c, sys.palette, push);
  else skipped.push("off_palette");
  opticalMargins(ix, rc, push);
  hanging(ix, rc, push);
  if (skipped.length) {
    const why = !brief
      ? "no brief was given (figma_check_layout { briefId })"
      : !sys
        ? `the brief records no system numbers (figma_set_brief { briefId: "${brief.id}", system: { bodySize, ratio, spacingBase, grid, palette } })`
        : "the brief's system leaves them out";
    push(c.rootNode, "system_unmeasured", "info", `not measured: ${skipped.join(", ")} — ${why}. The rest of the system audit ran.`);
  }
  return out;
}

// ── format ───────────────────────────────────────────────────────────────────

const FORMAT = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(px|pt|dp|mm|cm|in)\b/gi;

/** The sizes a format line names, with their units: "390x844 px phone, 1440x900 px desktop" is two. */
export function parseFormat(format: string): Array<{ w: number; h: number; unit: string }> {
  const out: Array<{ w: number; h: number; unit: string }> = [];
  FORMAT.lastIndex = 0;
  for (let m = FORMAT.exec(format); m; m = FORMAT.exec(format)) out.push({ w: Number(m[1]), h: Number(m[2]), unit: m[3]!.toLowerCase() });
  return out.filter((s) => s.w > 0 && s.h > 0);
}

/** The deliverables of this check: the root when it is a top-level frame, else the page's top-level frames the brief lists. */
function deliverables(c: Census, rc: RoleContext): Layer[] {
  const top = (n: NodeLike) => n.parent?.type === "PAGE" || n.parent?.type === "SECTION";
  const frame = (n: NodeLike) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE";
  if (c.root && frame(c.rootNode) && top(c.rootNode)) return [c.root];
  const listed = new Set(rc.brief?.deliverables ?? []);
  return c.layers.filter((l) => frame(l.node) && top(l.node) && listed.has(l.node.id));
}

/**
 * format_mismatch: the deliverable against the brief's format, the nearest of
 * its sizes. px, pt and dp compare one to one with frame px (a Figma frame for
 * a 390 pt phone is 390 wide); mm and in compare proportions, since a print
 * frame may be drawn at any scale, with trim + 2 × `details.bleedMm`. A
 * screen (role ux) scrolls: its height is at least the format's.
 */
function formats(c: Census, format: string, rc: RoleContext, push: Push, skipped: string[]): void {
  const sizes = parseFormat(format);
  if (!sizes.length) {
    skipped.push("format_mismatch (the format names no size with a unit)");
    return;
  }
  const bleedMm = Number((rc.brief?.details as Any | undefined)?.bleedMm);
  const scrolls = rc.brief?.role === "ux";
  for (const d of deliverables(c, rc)) {
    const fw = d.box.width;
    const fh = d.box.height;
    const near = sizes
      .map((s) => {
        if (s.unit === "px" || s.unit === "pt" || s.unit === "dp") return { s, w: s.w, h: s.h, off: Math.abs(fw - s.w) + Math.abs(fh - s.h) };
        const perMm = s.unit === "mm" ? 1 : s.unit === "cm" ? 10 : 25.4;
        const b = Number.isFinite(bleedMm) && bleedMm > 0 ? bleedMm / perMm : 0;
        const k = fw / (s.w + 2 * b); // frame px per unit, from the width
        return { s, w: fw, h: (s.h + 2 * b) * k, off: Math.abs(Math.log(fw / fh) - Math.log((s.w + 2 * b) / (s.h + 2 * b))), bleed: b };
      })
      .sort((a, b) => a.off - b.off)[0]!;
    const dw = fw - near.w;
    const dh = fh - near.h;
    const tol = SYSTEM.formatTolerance;
    const heightOk = scrolls ? dh >= -tol : Math.abs(dh) <= tol;
    if (Math.abs(dw) <= tol && heightOk) continue;
    const named = `${near.s.w} × ${near.s.h} ${near.s.unit}`;
    const print = near.s.unit === "mm" || near.s.unit === "cm" || near.s.unit === "in";
    const bleed = "bleed" in near && near.bleed ? ` with ${bleedMm} mm bleed on each side` : "";
    const trimOnly = print && "bleed" in near && near.bleed && Math.abs(fh - (near.s.h * fw) / near.s.w) <= tol;
    push(d.node, "format_mismatch", "warning",
      print
        ? `is ${r1(fw)} × ${r1(fh)} px, which is not the proportion of the brief's format ${named}${bleed} ("${format}"): at its width it should be ` +
            `${r1(near.h)} px tall.${trimOnly ? " It is the trim size: add the bleed." : ""} Resize it (figma_resize_nodes) before anything is placed on it.`
        : `is ${r1(fw)} × ${r1(fh)} px; the brief's format is ${named} ("${format}")${scrolls ? ", and a screen is at least that tall" : ""} — ` +
            `${[Math.abs(dw) > tol ? `${r1(Math.abs(dw))} px ${dw > 0 ? "wider" : "narrower"}` : "", !heightOk ? `${r1(Math.abs(dh))} px ${dh > 0 ? "taller" : "shorter"}` : ""].filter(Boolean).join(", ")}. ` +
            "A placement crops or letterboxes a frame that is off by a pixel: resize it (figma_resize_nodes).");
  }
}

// ── scale and spacing ────────────────────────────────────────────────────────

/** off_scale: a text size off the brief's modular scale (C-211), or not one of its listed sizes. */
function scale(ix: Index, body: number, ratio: number | undefined, sizes: number[] | undefined, push: Push): void {
  const list = Array.isArray(sizes) && sizes.length ? sizes.filter((s) => typeof s === "number" && s > 0) : null;
  const off = new Map<number, Layer[]>();
  for (const t of ix.texts) {
    for (const run of t.text!.runs) {
      const s = run.size;
      if (s <= 0) continue;
      let on: boolean;
      if (list) on = list.some((x) => Math.abs(x - s) <= SYSTEM.sizeListTolPx);
      else {
        const k = Math.round(Math.log(s / body) / Math.log(ratio!));
        const step = body * Math.pow(ratio!, k);
        on = Math.abs(s - step) <= Math.max(SYSTEM.scaleTolPx, SYSTEM.scaleTolShare * step);
      }
      if (on) continue;
      const key = r1(s);
      const users = off.get(key) ?? [];
      if (users.indexOf(t) < 0) users.push(t);
      off.set(key, users);
    }
  }
  for (const [size, users] of off) {
    const first = users[0]!;
    let rule: string;
    let nearest: number;
    if (list) {
      nearest = list.reduce((m, x) => (Math.abs(x - size) < Math.abs(m - size) ? x : m), list[0]!);
      rule = `the brief's sizes (${list.join(", ")} px)`;
    } else {
      const k = Math.log(size / body) / Math.log(ratio!);
      const steps = [Math.floor(k), Math.ceil(k)].map((j) => r1(body * Math.pow(ratio!, j)));
      nearest = Math.abs(steps[0]! - size) <= Math.abs(steps[1]! - size) ? steps[0]! : steps[1]!;
      rule = `the brief's scale ${body} × ${ratio}^k (… ${steps.join(", ")} …)`;
    }
    push(first.node, "off_scale", "info",
      `is ${size} px${users.length > 1 ? ` (and ${users.length - 1} other text${users.length > 2 ? "s" : ""})` : ""}, off ${rule}; the nearest step ` +
        `is ${nearest} px. Set it on the scale (figma_set_text_properties fontSize), or record the size in the brief's system.`);
  }
}

/** off_spacing: an auto-layout gap or padding that is not a multiple of the brief's spacing base. */
function spacing(c: Census, base: number, push: Push): void {
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (l.inInstance || l.node.type === "INSTANCE") continue; // an instance's spacing is its component's, judged there (as the tokens audit does)
    const a = l.a;
    const mode = String(a.layoutMode);
    if (mode !== "HORIZONTAL" && mode !== "VERTICAL" && mode !== "GRID") continue;
    const keys = mode === "GRID" ? ["gridRowGap", "gridColumnGap"] : a.primaryAxisAlignItems === "SPACE_BETWEEN" ? [] : ["itemSpacing"];
    if (mode !== "GRID" && a.layoutWrap === "WRAP") keys.push("counterAxisSpacing");
    keys.push("paddingTop", "paddingRight", "paddingBottom", "paddingLeft");
    const bad = keys.filter((k) => {
      const v = a[k];
      if (typeof v !== "number" || v <= 0) return false;
      const q = v / base;
      return Math.abs(q - Math.round(q)) > SYSTEM.spacingTol;
    });
    if (!bad.length) continue;
    push(l.node, "off_spacing", "info",
      `${bad.map((k) => `${k} ${r1(a[k] as number)}`).join(", ")}: not multiples of the brief's ${base} px spacing base (nearest ` +
        `${bad.map((k) => Math.max(base, Math.round((a[k] as number) / base) * base)).join(", ")}). Set them on the base (figma_set_auto_layout).`);
  }
}

// ── grid ─────────────────────────────────────────────────────────────────────

/** The columns of a grid across a frame `width` wide: each column's left and right edge, relative to the frame. */
export function columnEdges(g: Any, width: number): { lefts: number[]; rights: number[]; colWidth: number; text: string } | null {
  const gutter = typeof g.gutterSize === "number" ? g.gutterSize : 0;
  const offset = typeof g.offset === "number" ? g.offset : 0;
  const align = String(g.alignment ?? "STRETCH");
  let count = typeof g.count === "number" ? g.count : NaN;
  let col = typeof g.sectionSize === "number" ? g.sectionSize : NaN;
  if (align === "STRETCH") {
    if (!Number.isFinite(count) || count < 1) return null;
    col = (width - 2 * offset - (count - 1) * gutter) / count;
  } else {
    if (!Number.isFinite(col) || col <= 0) return null;
    // An "auto" count fills the frame with as many columns as fit.
    if (!Number.isFinite(count) || count < 1) count = Math.max(1, Math.floor(((align === "CENTER" ? width : width - offset) + gutter) / (col + gutter)));
  }
  if (!(col > 0)) return null;
  const total = count * col + (count - 1) * gutter;
  const start = align === "MAX" ? width - offset - total : align === "CENTER" ? (width - total) / 2 : offset;
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let i = 0; i < count && i < 100; i++) {
    lefts.push(start + i * (col + gutter));
    rights.push(start + i * (col + gutter) + col);
  }
  const text = `${count} columns, ${r1(gutter)} px gutter, ${align === "STRETCH" ? `${r1(offset)} px margin` : `${r1(col)} px wide, ${align.toLowerCase()}`}`;
  return { lefts, rights, colWidth: col, text };
}

const GRID_FRAMES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

/**
 * off_grid: each block's left and right edges against the column edges — of
 * the frame's own COLUMNS layout grid (layoutGrids: count, gutterSize, offset,
 * sectionSize, alignment), else of the brief's `system.grid` on the
 * deliverable. Blocks are the frame's children placed by hand or absolutely;
 * a child in an auto-layout flow is placed by its parent, not on the grid.
 * Returns false when there was no grid to measure against.
 */
function grid(c: Census, ix: Index, system: { columns: number; gutter: number; margin: number } | undefined, push: Push): boolean {
  const frames: Array<{ l: Layer; cols: NonNullable<ReturnType<typeof columnEdges>>; from: string }> = [];
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (!GRID_FRAMES.has(l.node.type) || l.inInstance) continue;
    const grids = Array.isArray(l.a.layoutGrids) ? (l.a.layoutGrids as Any[]) : [];
    const g = grids.find((x) => x && x.pattern === "COLUMNS" && x.visible !== false);
    const cols = g ? columnEdges(g, l.box.width) : null;
    if (cols) frames.push({ l, cols, from: "its layout grid" });
  }
  if (!frames.length && system && system.columns > 0 && c.root && GRID_FRAMES.has(c.rootNode.type)) {
    const cols = columnEdges({ alignment: "STRETCH", count: system.columns, gutterSize: system.gutter, offset: system.margin }, c.root.box.width);
    if (cols) frames.push({ l: c.root, cols, from: "the brief's system.grid" });
  }
  if (!frames.length) return false;
  for (const { l: f, cols, from } of frames) {
    const W = f.box.width;
    for (const k of ix.kids(f.node)) {
      if (k.flow) continue;
      const left = k.box.x - f.box.x;
      const rgt = right(k.box) - f.box.x;
      if (k.box.width < 1 || rgt <= 0 || left >= W) continue;
      if (left <= SYSTEM.gridOn && rgt >= W - SYSTEM.gridOn) continue; // full bleed: edge to edge, not on columns
      // Text that hugs its words has a ragged far edge: judge the edge it is aligned to.
      const hug = !!k.text && k.a.textAutoResize === "WIDTH_AND_HEIGHT";
      const align = hug ? String(k.a.textAlignHorizontal ?? "LEFT") : "JUSTIFIED";
      if (align === "CENTER") continue;
      const near = (v: number, list: number[]) => list.reduce((m, e) => (Math.abs(v - e) < Math.abs(m - v) ? e : m), list[0]!);
      const edges: Array<{ side: string; at: number; to: number }> = [];
      if (align !== "RIGHT") edges.push({ side: "left", at: left, to: near(left, cols.lefts) });
      if (align !== "LEFT" && (k.box.width >= cols.colWidth - SYSTEM.gridOn || align === "RIGHT")) edges.push({ side: "right", at: rgt, to: near(rgt, cols.rights) });
      const off = edges.map((e) => ({ ...e, d: Math.abs(e.at - e.to) })).filter((e) => e.d >= SYSTEM.gridOn);
      if (!off.length) continue;
      const worst = Math.max(...off.map((e) => e.d));
      const which = off.map((e) => `its ${e.side} edge ${r1(e.d)} px off the column edge at ${r1(e.to)}`).join(", ");
      const slip = worst <= SYSTEM.gridSlip;
      push(k.node, "off_grid", slip ? "warning" : "info",
        `${which} (${from} on "${f.node.name}": ${cols.text}) — ${slip ? "close enough to look like a slip. Move it onto the column (figma_move_nodes)." : "off the grid. Snap it to the columns, or keep it as the one deliberate break and say why."}`);
    }
  }
  return true;
}

// ── palette ──────────────────────────────────────────────────────────────────

/** CIE L*a*b* of an sRGB colour (D65). */
function lab(c: Rgb): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** ΔE (CIE76) between two colours. */
export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function parseHex(h: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const s = m[1]!.length === 3 ? m[1]!.split("").map((ch) => ch + ch).join("") : m[1]!;
  return { r: parseInt(s.slice(0, 2), 16) / 255, g: parseInt(s.slice(2, 4), 16) / 255, b: parseInt(s.slice(4, 6), 16) / 255 };
}

/** FigJam's own objects carry the board's palette; their colours are judged by the board audit. */
const BOARD_TYPES = new Set(["STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "CODE_BLOCK", "TABLE", "TABLE_CELL", "STAMP", "WIDGET", "SECTION"]);

/** off_palette: a solid fill or stroke whose colour is not in the brief's palette (ΔE76 under 2 is the same colour). */
function palette(c: Census, list: Array<{ hex: string; role: string }>, push: Push): void {
  const swatches = list.map((p) => ({ ...p, rgb: parseHex(String(p.hex)) })).filter((p) => p.rgb) as Array<{ hex: string; role: string; rgb: Rgb }>;
  if (!swatches.length) return;
  const off = new Map<string, { first: Layer; uses: number; nearest: { hex: string; role: string; d: number } }>();
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (l.inInstance || BOARD_TYPES.has(l.node.type)) continue;
    for (const paints of [l.a.fills, l.a.strokes]) {
      if (!Array.isArray(paints)) continue;
      for (const p of paints as Any[]) {
        if (p.visible === false || p.type !== "SOLID") continue; // images and gradients are not swatches
        const col = p.color as Rgb;
        const key = hex(col);
        const known = off.get(key);
        if (known) {
          known.uses++;
          continue;
        }
        let best = { hex: "", role: "", d: Infinity };
        for (const s of swatches) {
          const d = deltaE(col, s.rgb);
          if (d < best.d) best = { hex: s.hex, role: s.role, d };
        }
        if (best.d < SYSTEM.paletteDeltaE) continue;
        off.set(key, { first: l, uses: 1, nearest: best });
      }
    }
  }
  for (const [key, o] of off) {
    push(o.first.node, "off_palette", "info",
      `paints ${key}${o.uses > 1 ? ` (${o.uses} paints here)` : ""}, which is not in the brief's palette; the nearest swatch is ${o.nearest.hex} ` +
        `(${o.nearest.role}), ΔE ${o.nearest.d.toFixed(1)}. Use the swatch (figma_set_fills), or add the colour to the palette with its role.`);
  }
}

// ── optical finish ───────────────────────────────────────────────────────────

/**
 * optical_margin: left-aligned texts sharing a box edge whose ink starts at
 * different places — a large heading's side bearing pushes its first letter
 * in, so the column reads ragged although the boxes align (design `finish`:
 * align ink, not boxes). The smallest text in the column is the reference.
 */
function opticalMargins(ix: Index, rc: RoleContext, push: Push): void {
  const texts = ix.texts
    .filter((t) => t.text!.inked && t.text!.align === "LEFT" && t.text!.size > 0)
    .slice(0, SYSTEM.pairCap)
    .sort((a, b) => a.box.x - b.box.x);
  const used = new Set<Layer>();
  for (const t of texts) {
    if (used.has(t)) continue;
    const screen = rc.screenOf(t.node)?.node;
    const column = texts.filter((o) => !used.has(o) && Math.abs(o.box.x - t.box.x) <= SYSTEM.opticalEdge && rc.screenOf(o.node)?.node === screen);
    for (const o of column) used.add(o);
    if (column.length < 2) continue;
    const ref = column.reduce((m, o) => (o.text!.size < m.text!.size ? o : m), column[0]!);
    for (const o of column) {
      if (o === ref) continue;
      const dx = o.text!.glyphs.x - ref.text!.glyphs.x;
      const tol = Math.max(SYSTEM.opticalMin, SYSTEM.opticalShare * Math.max(o.text!.size, ref.text!.size));
      if (Math.abs(dx) <= tol) continue;
      push(o.node, "optical_margin", "info",
        `shares its box edge with "${ref.node.name}" (${ref.node.id}), but its ink starts ${r1(Math.abs(dx))} px ${dx > 0 ? "right" : "left"} of that ` +
          `text's: the column looks ragged though the boxes align. Nudge it x by ${dx > 0 ? "−" : "+"}${r1(Math.abs(dx))} px (figma_move_nodes) so the ink lines up.`);
    }
  }
}

/**
 * hanging_punctuation: a display text that opens with a quote mark, a bullet
 * or a dash set inside the column, so its first letter sits a mark's width in
 * from the edge every other line keeps. Hung, the text starts left of the
 * column by about the mark's width; that is looked for among the texts beside it.
 */
function hanging(ix: Index, rc: RoleContext, push: Push): void {
  if (ix.body <= 0) return;
  for (const t of ix.texts) {
    const f = t.text!;
    if (f.size < TELLS.headingStep * ix.body || f.align !== "LEFT") continue;
    const first = f.chars.replace(/^\s+/, "").charAt(0);
    if (!first || SYSTEM.openers.indexOf(first) < 0) continue;
    const screen = rc.screenOf(t.node)?.node;
    const hung = ix.texts.some((o) => {
      if (o === t || rc.screenOf(o.node)?.node !== screen) return false;
      const d = o.box.x - t.box.x;
      return d >= 0.15 * f.size && d <= 1 * f.size;
    });
    if (hung) continue;
    const by = r1(SYSTEM.hangEm * f.size);
    push(t.node, "hanging_punctuation", "info",
      `opens with "${first}" set inside the column, so its first letter starts a mark's width in from the edge the text below keeps. Hang ` +
        `the mark: move the text left by about ${by} px (${SYSTEM.hangEm} em, figma_move_nodes) so the letters, not the mark, sit on the edge.`);
  }
}
