// figma_check_layout's `craft` audit: the finish defects the critics of the
// 2026-10-09 run found by measuring [C-207] — sizes 7 % apart, a column whose
// edges miss each other by a few pixels, layers that almost touch, an edge or
// a ring running through type, old-style figures that turned "10%" into
// "IO%", text on a shape it cannot be read against, hairlines too faint to
// see, a block sunk below its field's centre, type outside the safe area or
// too small for the device. A single build-and-glance pass caught none of
// them; each is a number here.
//
// The rules come from that run, so their severities are the plan's [C-248];
// every threshold is in CRAFT, one place for calibration to move.
//
// Judged after check.ts's walk, from the census it collects: plain functions
// over boxes and paint order, no Figma calls. tells.ts reads the same census.
//
// Under a motion brief the census says which layer's keys carry each layer
// (Census.carrier), and a finding that rests on where keys park a layer — two
// layers keys move apart, or a moved layer against the safe area — is counted,
// not made: layout is judged where the viewer sees it (roles spec §3.6).

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { childrenOf } from "./board-read.js";
import { contrastRatio } from "./context.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;
export type Rect = { x: number; y: number; width: number; height: number };
export type Rgb = { r: number; g: number; b: number };
/** What a non-text layer paints, and where. `hole` is the see-through middle of a stroked box. */
export type Cover = { outer: Rect; hole: Rect | null; opacity: number };
export type Severity = "error" | "warning" | "info";

export interface Finding {
  kind: string;
  severity: Severity;
  nodeId: string;
  name: string;
  detail: string;
}

/** What a text says and how it is set, read once during the walk. */
export interface TextFacts {
  chars: string;
  /** The rendered ink when Figma reports it, else the box. */
  glyphs: Rect;
  /** True when `glyphs` is the ink (absoluteRenderBounds), not the box. */
  inked: boolean;
  /** Styled runs by font and size; empty when nothing says what the size is. */
  runs: Array<{ family: string; style: string; size: number; length: number }>;
  /** The size carrying most of its characters; 0 when unknown. */
  size: number;
  /** The smallest size in it; 0 when unknown. */
  minSize: number;
  /** One line's height in px. */
  lineHeight: number;
  /** Line height ÷ size when set in pixels or percent; undefined for AUTO, whose value depends on the face. */
  leading: number | undefined;
  /** Lines it sets, from its height: the Plugin API has no line boxes. */
  lines: number;
  align: string;
  /** Set in capitals, by text case or as typed. */
  caps: boolean;
  /** Letter spacing in em. */
  tracking: number;
  /** Its colour when it is one opaque solid paint. */
  fg: Rgb | null;
  /** The WCAG minimum for its size: 3 for large text, else 4.5 [C-075]. */
  need: number;
}

export interface Layer {
  node: NodeLike;
  /** Its members as the walk read them: the node itself in Design, its guarded view elsewhere. */
  a: Any;
  /** absoluteBoundingBox. */
  box: Rect;
  /** Walk order, which is paint order: a later layer paints above an earlier one that is not its ancestor. */
  order: number;
  /** Inside an INSTANCE: its paint and text come from a component and are judged there. */
  inInstance: boolean;
  /**
   * Inside a component or instance whose state is disabled or inactive: WCAG
   * 2.2 exempts inactive components from text contrast (SC 1.4.3) and from
   * non-text contrast (SC 1.4.11), so the contrast rules skip it.
   */
  inactive: boolean;
  /** Placed by an auto-layout parent rather than by hand. */
  flow: boolean;
  /** What it paints once its clipping ancestors cut it; null for text and for a layer that paints nothing. */
  cover: Cover | null;
  /** Its top visible fill, when that is one solid colour. */
  solid: { color: Rgb; opacity: number } | null;
  /** Its top visible stroke, when that is one solid colour. */
  strokeSolid: { color: Rgb; opacity: number } | null;
  filled: boolean;
  stroked: boolean;
  text?: TextFacts;
}

export interface Census {
  rootNode: NodeLike;
  /** The root as a layer; null when it has no box (a page). */
  root: Layer | null;
  /** Every visible layer under the root, in paint order. */
  layers: Layer[];
  /** `safeArea`, made absolute from the root's top-left. */
  safeArea?: Rect;
  /** `safeArea` as the caller wrote it, for the findings. */
  safeAreaText?: string;
  minTextSize?: number;
  /**
   * The floor a text takes when no `minTextSize` is given: the brief's
   * platform minimum in frame px at the text's frame (a11y.ts textFloorOf),
   * with the words that name its source.
   */
  textFloor?(n: NodeLike): { px: number; source: string } | undefined;
  /** The colour its ancestors paint behind a node (check.ts's backdrop), or null. */
  backdrop(n: NodeLike): Rgb | null;
  /**
   * Under a motion brief (check.ts): the layer whose keys carry `n` where it
   * is seen — `n`, or the nearest ancestor keys move — or null when no key
   * moves it against the root. Absent: every layer is judged where it rests.
   */
  carrier?(n: NodeLike): NodeLike | null;
  /** Counts a finding not made because it rested on where keys park a layer. */
  unjudged?(kind: string): void;
}

/** Lookups both audits share, built once per root. */
export interface Index {
  byNode: Map<NodeLike, Layer>;
  /** Text layers with something in them, in paint order. */
  texts: Layer[];
  /** The size carrying the most characters in the root: the body size. 0 when unknown. */
  body: number;
  isAncestor(anc: NodeLike, n: NodeLike): boolean;
  /** A node's visible children, as layers, in order. */
  kids(n: NodeLike): Layer[];
  /** Under a motion brief: keys move one of the two and not the other with it, so how they sit at rest is no frame anyone sees. */
  apart(a: NodeLike, b: NodeLike): boolean;
  /** Under a motion brief: keys move `n` against the root, so where it rests is not where it is seen. */
  moved(n: NodeLike): boolean;
}

/** Every threshold of the craft audit: a decision grounded in the run's findings, to calibrate here [C-248]. */
export const CRAFT = {
  /** near_size: two sizes of one family closer than this ratio. */
  nearSize: 1.12,
  /** no_shared_edge: edges closer than this are one edge (sub-pixel positions from centring round either way). */
  edgeShared: 1,
  /** no_shared_edge: an edge this close is a slip, not a choice. */
  edgeNearMiss: 6,
  /** no_shared_edge: blocks share a column when they overlap this much of the narrower one. */
  column: 0.5,
  /** tangent: gaps or overlaps under max(tangentMin px, tangentShare × the larger side). */
  tangentMin: 8,
  tangentShare: 0.02,
  /** glyph_gaps: a gap wider than this, in em, opens a word set one letter per layer. */
  glyphGap: 0.15,
  /** oldstyle_figures: digits whose ink is shorter than this × the size are old-style. */
  oldstyle: 0.55,
  /** unbalanced_space: centre of mass off by more than this share of the height, with an empty band over bandShare. */
  balance: 0.06,
  bandShare: 0.2,
  /** edge_slices_text: an edge between these shares of the text's height (or width). */
  sliceFrom: 0.1,
  sliceTo: 0.9,
  /** weak_graphic_contrast: strokes this thin, against 3:1 [C-221]. */
  hairline: 2,
  graphicContrast: 3,
  /** Pairwise rules look at this many layers, so a large page stays fast. */
  pairCap: 400,
} as const;

/**
 * Severities, per the plan: a defect the run measured and a fix exists for is
 * a warning; a judgement that may be deliberate is info. `no_shared_edge` is
 * info unless the edges almost meet (NEAR_MISS).
 */
export const CRAFT_SEVERITY = {
  near_size: "info",
  no_shared_edge: "info",
  tangent: "info",
  glyph_gaps: "warning",
  oldstyle_figures: "warning",
  unbalanced_space: "info",
  safe_area: "warning",
  low_contrast_over_shape: "warning",
  min_text: "warning",
  stroke_crosses_text: "warning",
  edge_slices_text: "info",
  weak_graphic_contrast: "info",
} as const satisfies Record<string, Severity>;
const NEAR_MISS: Severity = "warning";

// ── geometry ─────────────────────────────────────────────────────────────────

export const r1 = (v: number) => Math.round(v * 10) / 10;
export const right = (r: Rect) => r.x + r.width;
export const bottom = (r: Rect) => r.y + r.height;
/** How far two boxes overlap on x (negative: the gap between them). */
export const overlapX = (a: Rect, b: Rect) => Math.min(right(a), right(b)) - Math.max(a.x, b.x);
export const overlapY = (a: Rect, b: Rect) => Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
export function intersect(a: Rect, b: Rect): Rect | null {
  const w = overlapX(a, b);
  const h = overlapY(a, b);
  return w > 0 && h > 0 ? { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), width: w, height: h } : null;
}
export const contains = (outer: Rect, inner: Rect, tol = 0) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/** The sides `box` runs past `outer` by more than 1 px, as "12 px right" phrases. */
function overSides(box: Rect, outer: Rect): string[] {
  const over = { left: outer.x - box.x, right: right(box) - right(outer), top: outer.y - box.y, bottom: bottom(box) - bottom(outer) };
  return Object.entries(over).filter(([, v]) => v > 1).map(([side, v]) => `${r1(v)} px ${side}`);
}

/** Whether the segment (x1,y1)–(x2,y2) passes through `r` (Liang–Barsky clipping). */
function segmentHits(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, x1 - r.x], [dx, right(r) - x1], [-dy, y1 - r.y], [dy, bottom(r) - y1]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

export function hex(c: Rgb): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// ── reading a text, once ─────────────────────────────────────────────────────

/** A text's facts from its view. `fg` and `need` come from check.ts, which already judges contrast. */
export function textFacts(a: Any, box: Rect, fg: Rgb | null, need: number): TextFacts {
  const chars = typeof a.characters === "string" ? a.characters : "";
  const runs = runsOf(a, chars.length);
  const bySize = new Map<number, number>();
  for (const r of runs) bySize.set(r.size, (bySize.get(r.size) ?? 0) + r.length);
  const size = [...bySize].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 0;
  const minSize = runs.length ? Math.min(...runs.map((r) => r.size)) : 0;
  const lh = a.lineHeight as { unit?: string; value?: number } | undefined;
  let leading: number | undefined;
  if (lh && typeof lh === "object" && typeof lh.value === "number" && size > 0) {
    if (lh.unit === "PIXELS") leading = lh.value / size;
    if (lh.unit === "PERCENT") leading = lh.value / 100;
  }
  const lineHeight = (leading ?? 1.2) * (size || 12);
  const ink = a.absoluteRenderBounds as Rect | null | undefined;
  const inked = !!ink && Number.isFinite(ink.width);
  const ls = a.letterSpacing as { unit?: string; value?: number } | undefined;
  const tracking = ls && typeof ls.value === "number" ? (ls.unit === "PIXELS" ? (size ? ls.value / size : 0) : ls.value / 100) : 0;
  const lettered = /[A-Za-z]/.test(chars);
  return {
    chars,
    glyphs: inked ? ink! : box,
    inked,
    runs,
    size,
    minSize,
    lineHeight,
    leading,
    lines: Math.max(1, Math.round(box.height / lineHeight)),
    align: typeof a.textAlignHorizontal === "string" ? a.textAlignHorizontal : "LEFT",
    caps: a.textCase === "UPPER" || (lettered && chars === chars.toUpperCase()),
    tracking,
    fg,
    need,
  };
}

/** Runs by font and size; a text with nothing loaded falls back to its own font and size. */
function runsOf(a: Any, length: number): TextFacts["runs"] {
  const seg = a.getStyledTextSegments as ((f: string[]) => Array<Any & { start?: number; end?: number }>) | undefined;
  if (typeof seg === "function") {
    try {
      const out: TextFacts["runs"] = [];
      for (const s of seg.call(a, ["fontName", "fontSize"])) {
        const font = s.fontName as { family?: unknown; style?: unknown } | undefined;
        if (typeof s.fontSize !== "number" || typeof font?.family !== "string") continue;
        out.push({ family: font.family, style: typeof font.style === "string" ? font.style : "", size: s.fontSize, length: Math.max(0, (s.end ?? 0) - (s.start ?? 0)) });
      }
      if (out.length) return out;
    } catch {
      /* nothing loaded: fall back to the node's own font */
    }
  }
  const font = a.fontName as { family?: unknown; style?: unknown } | undefined;
  if (typeof a.fontSize !== "number") return [];
  return [{
    family: typeof font?.family === "string" ? font.family : "",
    style: typeof font?.style === "string" ? font.style : "",
    size: a.fontSize,
    length,
  }];
}

// ── the shared index ─────────────────────────────────────────────────────────

export function indexCensus(c: Census): Index {
  const byNode = new Map<NodeLike, Layer>();
  if (c.root) byNode.set(c.rootNode, c.root);
  for (const l of c.layers) byNode.set(l.node, l);
  const texts = c.layers.filter((l) => l.text && l.text.chars.trim() !== "");
  const bySize = new Map<number, number>();
  for (const t of texts) for (const r of t.text!.runs) bySize.set(r.size, (bySize.get(r.size) ?? 0) + r.length);
  const body = [...bySize].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 0;
  const ancestors = new Map<NodeLike, Set<NodeLike>>();
  const ancestorsOf = (n: NodeLike) => {
    let set = ancestors.get(n);
    if (!set) {
      set = new Set();
      for (let p = n.parent; p; p = p.parent) set.add(p);
      ancestors.set(n, set);
    }
    return set;
  };
  const carrier = c.carrier;
  return {
    byNode,
    texts,
    body,
    isAncestor: (anc, n) => ancestorsOf(n).has(anc),
    kids: (n) => (childrenOf(n) ?? []).map((k) => byNode.get(k)).filter((l): l is Layer => l !== undefined),
    apart: carrier ? (a, b) => carrier(a) !== carrier(b) : () => false,
    moved: carrier ? (n) => carrier(n) !== null : () => false,
  };
}

/** True when an ancestor of `n` is in `set`. */
export function underAny(n: NodeLike, set: ReadonlySet<NodeLike>): boolean {
  for (let p = n.parent; p; p = p.parent) if (set.has(p)) return true;
  return false;
}

/**
 * The opaque layer `target` sits on, from another branch of the tree: the
 * topmost one painted below `order` that holds the whole target and is not
 * itself under one of the node's own filled ancestors — the ancestors'
 * backdrop is what check.ts's low_contrast already judges [C-075]. Its
 * `solid` is null when that ground is a gradient or an image.
 */
export function groundUnder(ix: Index, target: Rect, order: number, node: NodeLike, layers: readonly Layer[]): Layer | null {
  // Anything painted before the nearest filled ancestor lies under that fill.
  let floor = 0;
  for (let p = node.parent; p; p = p.parent) {
    const l = ix.byNode.get(p);
    if (l?.filled) {
      floor = l.order;
      break;
    }
  }
  let best: Layer | null = null;
  for (const l of layers) {
    if (l.order >= order) break; // paint order: nothing after this is below the target
    if (l.order <= floor || l.text || !l.filled || !l.cover || l.cover.hole || l.cover.opacity < 0.99) continue;
    if (l.node === node || ix.isAncestor(l.node, node)) continue;
    if (ix.apart(l.node, node)) continue; // under a motion brief, a ground only where it is seen with the target
    if (!contains(l.cover.outer, target, 1)) continue;
    best = l;
  }
  // A gradient or an image on top is the ground too: the caller finds no one colour in it to judge against.
  return best;
}

/** `fg` laid over `bg` at `alpha`: the colour the eye gets. */
export const mix = (fg: Rgb, bg: Rgb, alpha: number): Rgb => ({
  r: fg.r * alpha + bg.r * (1 - alpha),
  g: fg.g * alpha + bg.g * (1 - alpha),
  b: fg.b * alpha + bg.b * (1 - alpha),
});

// ── parameters ───────────────────────────────────────────────────────────────

/** `safeArea` as sent: "x,y,width,height" in the root's coordinates. Refused by name when it is anything else. */
export function parseSafeArea(raw: unknown): Rect | undefined {
  if (raw === undefined) return undefined;
  const parts = typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : [];
  const v = parts.map(Number);
  if (parts.length !== 4 || parts.some((p) => p === "") || v.some((n) => !Number.isFinite(n)) || v[2]! <= 0 || v[3]! <= 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM,
      `\`safeArea\` is "x,y,width,height" in the root's coordinates (its top-left is 0,0), with a width and height above 0 — e.g. "64,250,952,1330"; got ${JSON.stringify(raw)}.`);
  }
  return { x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! };
}

/** `minTextSize` as sent: a size in px of the frame, above 0. */
export function parseMinTextSize(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`minTextSize\` is the smallest text size in px of the frame, above 0; got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

// ── the rules ────────────────────────────────────────────────────────────────

/**
 * `against`: what the finding is judged against — another layer, or the frame
 * (the safe area). Under a motion brief a finding against a layer keys move
 * apart from, or against the frame for a layer keys move, is counted and not
 * made: it rests on where keys park a layer, not on a frame anyone sees.
 */
type Push = (l: Layer, kind: keyof typeof CRAFT_SEVERITY, detail: string, severity?: Severity, against?: Layer | "frame") => void;

export function judgeCraft(c: Census, ix: Index): Finding[] {
  const out: Finding[] = [];
  const push: Push = (l, kind, detail, severity, against) => {
    if (against && (against === "frame" ? ix.moved(l.node) : ix.apart(l.node, against.node))) {
      c.unjudged?.(kind);
      return;
    }
    out.push({ kind, severity: severity ?? CRAFT_SEVERITY[kind], nodeId: l.node.id, name: l.node.name, detail });
  };
  nearSizes(ix, push);
  sharedEdges(ix, push);
  tangents(c, ix, push);
  glyphGaps(c, push);
  oldstyleFigures(ix, push);
  balance(c, ix, push);
  safeArea(c, push);
  contrastOverShapes(c, ix, push);
  minText(c, ix, push);
  strokesThroughText(c, ix, push);
  edgesThroughText(c, ix, push);
  faintHairlines(c, ix, push);
  return out;
}

/** near_size: two sizes of one family so close they read as a slip — 56 and 60 px in the run [C-207]. */
function nearSizes(ix: Index, push: Push): void {
  const byFamily = new Map<string, Map<number, Layer>>();
  for (const t of ix.texts) {
    for (const run of t.text!.runs) {
      if (!run.family || run.size <= 0) continue;
      const sizes = byFamily.get(run.family) ?? new Map<number, Layer>();
      byFamily.set(run.family, sizes);
      if (!sizes.has(r1(run.size))) sizes.set(r1(run.size), t);
    }
  }
  for (const [family, sizes] of byFamily) {
    const sorted = [...sizes.keys()].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      const lo = sorted[i - 1]!;
      const hi = sorted[i]!;
      const ratio = hi / lo;
      if (ratio >= CRAFT.nearSize) continue;
      const big = sizes.get(hi)!;
      const small = sizes.get(lo)!;
      const pair = big === small ? `mixes ${family} ${lo} and ${hi} px` : `is ${family} ${hi} px, and "${small.node.name}" (${small.node.id}) is ${family} ${lo} px`;
      push(big, "near_size",
        `${pair} — ${ratio.toFixed(2)}×, too close to read as two levels. Make them one size, or step them at least 1.2× apart (figma_set_text_properties fontSize).`);
    }
  }
}

/** no_shared_edge: stacked text blocks in one column that share no edge — 955 and 985 against a column at 1016 in the run [C-207]. */
function sharedEdges(ix: Index, push: Push): void {
  const texts = ix.texts.slice(0, CRAFT.pairCap);
  for (const a of texts) {
    let below: Layer | null = null;
    let gap = Infinity;
    for (const b of texts) {
      if (b === a || (a.inInstance && b.inInstance)) continue;
      const g = b.box.y - bottom(a.box);
      if (g < -0.5 || g >= gap) continue; // not below a, or not the nearest
      if (overlapX(a.box, b.box) < CRAFT.column * Math.min(a.box.width, b.box.width)) continue;
      below = b;
      gap = g;
    }
    // Further apart than a few lines, the two belong to different groups.
    if (!below || gap > 3 * Math.max(a.text!.lineHeight, below.text!.lineHeight)) continue;
    const A = a.box;
    const B = below.box;
    const [edge, off] = ([
      ["left", Math.abs(A.x - B.x)],
      ["right", Math.abs(right(A) - right(B))],
      ["centre", Math.abs(A.x + A.width / 2 - (B.x + B.width / 2))],
    ] as const).reduce((m, e) => (e[1] < m[1] ? e : m));
    if (off < CRAFT.edgeShared) continue;
    if (off <= CRAFT.edgeNearMiss) {
      push(below, "no_shared_edge",
        `sits under "${a.node.name}" (${a.node.id}) with its ${edge} edge ${r1(off)} px off — close enough to look like a slip. ` +
          "Align them exactly (figma_move_nodes), or offset by a full spacing step on purpose.", NEAR_MISS, a);
    } else {
      push(below, "no_shared_edge",
        `sits under "${a.node.name}" (${a.node.id}) and shares no left, right or centre edge with it (the nearest, ${edge}, is ` +
          `${r1(off)} px off) — a column holds one edge. Align them, unless the indent is the idea.`, undefined, a);
    }
  }
}

/** tangent: two hand-placed layers that almost touch — a rim 7 px under an arch, a descender 9 px over a ring [C-207]. */
function tangents(c: Census, ix: Index, push: Push): void {
  const field = c.root?.box;
  const fieldArea = field ? field.width * field.height : 0;
  const cands: Array<{ l: Layer; box: Rect }> = [];
  for (const l of c.layers) {
    if (cands.length >= CRAFT.pairCap) break;
    // Frames side by side on the canvas are a page's layout, not a composition.
    if (l.inInstance || l.node.parent?.type === "PAGE") continue;
    const box = l.text ? (l.text.chars.trim() ? l.text.glyphs : null) : l.cover?.outer ?? null;
    if (!box || box.width <= 0 || box.height <= 0) continue;
    if (fieldArea && box.width * box.height >= 0.9 * fieldArea) continue; // a full-bleed ground touches everything
    cands.push({ l, box });
  }
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const A = cands[i]!;
      const B = cands[j]!;
      // Spacing an auto-layout sets is its rhythm, not a near-touch.
      if (A.l.flow && B.l.flow) continue;
      if (ix.isAncestor(A.l.node, B.l.node) || ix.isAncestor(B.l.node, A.l.node)) continue;
      const limit = Math.max(CRAFT.tangentMin, CRAFT.tangentShare * Math.max(A.box.width, A.box.height, B.box.width, B.box.height));
      const ox = overlapX(A.box, B.box);
      const oy = overlapY(A.box, B.box);
      let how: string | null = null;
      if (ox > 0 && oy > 0) {
        if (contains(A.box, B.box) || contains(B.box, A.box)) continue; // an inset, not a touch
        const d = Math.min(ox, oy);
        if (d < limit) how = `overlaps it by only ${r1(d)} px`;
      } else if (ox > 0 && oy < -0.5 && -oy < limit) {
        how = `sits ${r1(-oy)} px from it`;
      } else if (oy > 0 && ox < -0.5 && -ox < limit) {
        how = `sits ${r1(-ox)} px from it`;
      }
      if (!how) continue;
      const [mover, other] = A.l.flow ? [B, A] : [A, B];
      push(mover.l, "tangent",
        `almost touches "${other.l.node.name}" (${other.l.node.id}): it ${how}, under ${r1(limit)} px. Shapes that nearly meet read as ` +
          "a mistake — overlap decisively or clear by a full spacing step (figma_move_nodes).", undefined, other.l);
    }
  }
}

/** glyph_gaps: a word set one letter per layer, with a gap opening inside it. */
function glyphGaps(c: Census, push: Push): void {
  const byParent = new Map<NodeLike | null, Layer[]>();
  for (const l of c.layers) {
    if (!l.text || [...l.text.chars].length !== 1 || l.text.size <= 0) continue;
    const p = l.node.parent ?? null;
    byParent.set(p, [...(byParent.get(p) ?? []), l]);
  }
  for (const letters of byParent.values()) {
    if (letters.length < 2) continue;
    // One baseline: one size, bottoms within a tenth of an em.
    const lines: Layer[][] = [];
    for (const t of [...letters].sort((x, y) => bottom(x.box) - bottom(y.box))) {
      const line = lines.find((l) => Math.abs(l[0]!.text!.size - t.text!.size) <= 0.5 && Math.abs(bottom(l[0]!.box) - bottom(t.box)) <= 0.1 * t.text!.size);
      if (line) line.push(t);
      else lines.push([t]);
    }
    for (const line of lines) {
      line.sort((x, y) => x.box.x - y.box.x);
      const em = line[0]!.text!.size;
      // Runs: letters more than an em apart, or overlapping, belong to different words.
      let run: Layer[] = [line[0]!];
      const runs: Layer[][] = [run];
      for (let i = 1; i < line.length; i++) {
        const g = line[i]!.box.x - right(line[i - 1]!.box);
        if (g > em || g < -0.5 * em) runs.push((run = []));
        run.push(line[i]!);
      }
      for (const r of runs) {
        if (r.length < 2) continue;
        const gaps = r.slice(1).map((t, i) => t.box.x - right(r[i]!.box));
        const median = [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)]!;
        gaps.forEach((g, i) => {
          if (g <= CRAFT.glyphGap * em) return;
          // A word space between tight letters is where a space belongs.
          if (g >= 0.2 * em && g <= 0.4 * em && median <= 0.05 * em) return;
          push(r[i + 1]!, "glyph_gaps",
            `sits ${r1(g)} px (${(g / em).toFixed(2)} em) after "${r[i]!.node.name}" (${r[i]!.node.id}) on one baseline — a word set ` +
              "one letter per layer reads broken once a gap opens past its spacing. Close it (figma_move_nodes), or set the word as one text.",
            undefined, r[i]!);
        });
      }
    }
  }
}

/** oldstyle_figures: digits drawn at x-height — "10%" read as "IO%" in the run [C-207]. */
function oldstyleFigures(ix: Index, push: Push): void {
  for (const t of ix.texts) {
    const f = t.text!;
    const chars = f.chars.trim();
    if (!/^[0-9][0-9 .,:]*$/.test(chars) || !f.inked || f.size <= 0) continue;
    const ratio = f.glyphs.height / f.size;
    if (ratio >= CRAFT.oldstyle) continue;
    push(t, "oldstyle_figures",
      `"${chars.slice(0, 20)}" renders ${r1(f.glyphs.height)} px tall at ${r1(f.size)} px (${ratio.toFixed(2)}× the size): old-style figures, ` +
        "a 1 and a 0 as short as an o, so a number can misread. Set numbers people read in lining figures, or in another face.");
  }
}

/** unbalanced_space: the block's centre of mass off its field's centre, with a wide empty band — 780 against 915 in the run [C-207]. */
function balance(c: Census, ix: Index, push: Push): void {
  const field = c.safeArea ?? c.root?.box;
  if (!c.root || !field || field.height <= 0 || field.width <= 0) return;
  const fieldArea = field.width * field.height;
  const counted = new Set<NodeLike>();
  let mass = 0;
  let moment = 0;
  let top = Infinity;
  let low = -Infinity;
  for (const l of c.layers) {
    if (l.inInstance || underAny(l.node, counted)) continue;
    const box = l.text ? (l.text.chars.trim() ? l.text.glyphs : null) : (l.cover || l.node.type === "INSTANCE" ? l.box : null);
    if (!box) continue;
    if (box.width * box.height >= 0.9 * fieldArea) continue; // the ground, not content on it
    const hit = intersect(box, field);
    if (!hit) continue;
    counted.add(l.node); // a card weighs as itself, not again through its children
    const area = hit.width * hit.height;
    mass += area;
    moment += area * (hit.y + hit.height / 2);
    top = Math.min(top, hit.y);
    low = Math.max(low, bottom(hit));
  }
  if (!mass) return;
  const off = moment / mass - (field.y + field.height / 2);
  const bands = { above: top - field.y, below: bottom(field) - low };
  const [where, band] = bands.above >= bands.below ? (["above", bands.above] as const) : (["below", bands.below] as const);
  if (Math.abs(off) <= CRAFT.balance * field.height || band <= CRAFT.bandShare * field.height) return;
  // Under a motion brief, a composition keys move is weighed on its frames, not at rest.
  if (c.layers.some((l) => ix.moved(l.node))) {
    c.unjudged?.("unbalanced_space");
    return;
  }
  const fieldName = c.safeArea ? "safe area's" : "frame's";
  push(c.root, "unbalanced_space",
    `its content's centre of mass sits ${r1(Math.abs(off))} px ${off > 0 ? "below" : "above"} the ${fieldName} centre ` +
      `(${Math.round((100 * Math.abs(off)) / field.height)}% of the height), leaving ${r1(band)} px empty ${where} it. Centre the block on its ` +
      "field, then lift it slightly on purpose (figma_move_nodes).");
}

/** Layers named for a logo: their text is a logotype, which WCAG 2.2 SC 1.4.3 exempts from text contrast. */
export const LOGOTYPE = /\b(logo|logotype|wordmark|lockup)\b/i;
/** Layers named for what a safe area protects besides text: a logo, or a call to action. */
const PROTECTED = new RegExp(`${LOGOTYPE.source}|\\b(cta|call[ -]to[ -]action|button|btn)\\b`, "i");

/** True when `n` or an ancestor is named for a logo (LOGOTYPE). */
export function inLogotype(n: NodeLike): boolean {
  for (let p: NodeLike | null | undefined = n; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    if (LOGOTYPE.test(p.name)) return true;
  }
  return false;
}

/** safe_area: text, a logo or a call to action outside the safe area the brief gives — there are no presets [C-234]. */
function safeArea(c: Census, push: Push): void {
  const area = c.safeArea;
  if (!area) return;
  const reported = new Set<NodeLike>();
  for (const l of c.layers) {
    const isText = !!l.text && l.text.chars.trim() !== "";
    if (!isText && !PROTECTED.test(l.node.name)) continue;
    if (underAny(l.node, reported)) continue; // its logo or button is already reported
    const sides = overSides(isText ? l.text!.glyphs : l.box, area);
    if (!sides.length) continue;
    reported.add(l.node);
    push(l, "safe_area",
      `runs ${sides.join(", ")} outside the safe area ${c.safeAreaText ?? ""} — the brief keeps that band free. Move it in (figma_move_nodes) or make it smaller.`,
      undefined, "frame");
  }
}

/**
 * low_contrast_over_shape: text on a solid shape from another branch it cannot be read against — 2.8:1 in the run [C-207] [C-075].
 * The exceptions of WCAG 2.2 SC 1.4.3 hold here as for check.ts's low_contrast: inactive text is skipped, a logotype is info.
 */
function contrastOverShapes(c: Census, ix: Index, push: Push): void {
  for (const t of ix.texts) {
    const f = t.text!;
    if (!f.fg || t.inactive) continue;
    const ground = groundUnder(ix, f.glyphs, t.order, t.node, c.layers);
    if (!ground?.solid) continue;
    const ratio = contrastRatio(f.fg, ground.solid.color);
    if (ratio >= f.need) continue;
    const logo = inLogotype(t.node);
    push(t, "low_contrast_over_shape",
      `contrast ${ratio.toFixed(2)}:1 (${hex(f.fg)} on ${hex(ground.solid!.color)}, the fill of "${ground.node.name}" (${ground.node.id}) under it); ` +
        (logo
          ? "it is part of a logo, which WCAG 2.2 SC 1.4.3 exempts — fine if this is the logotype."
          : `text this size needs ${f.need}:1. Change either colour, or move the text off the shape.`),
      logo ? "info" : undefined);
  }
}

/** min_text: text under the floor the caller set for this frame's device, or under the brief's platform minimum. */
function minText(c: Census, ix: Index, push: Push): void {
  const fixed = c.minTextSize;
  if (fixed === undefined && !c.textFloor) return;
  for (const t of ix.texts) {
    const s = t.text!.minSize;
    const floor = fixed !== undefined ? { px: fixed, source: "minTextSize" } : c.textFloor!(t.node);
    if (!floor || s <= 0 || s >= floor.px - 0.05) continue;
    push(t, "min_text",
      `is ${r1(s)} px, under this frame's floor of ${r1(floor.px)} px (${floor.source}) — too small to read at the size it is shown. Enlarge it (figma_set_text_properties fontSize).`);
  }
}

/** Shapes whose stroke geometry the box gives: a line, an ellipse's ring, a box's outline. A vector's path is not in its box. */
const STROKE_SHAPES = new Set(["LINE", "ELLIPSE", "RECTANGLE", "FRAME", "COMPONENT", "INSTANCE"]);

function strokeBand(a: Any): { out: number; inset: number; weight: number } {
  const weight = num(a.strokeWeight, 1);
  const align = String(a.strokeAlign ?? "CENTER");
  return {
    weight,
    out: align === "INSIDE" ? 0 : align === "OUTSIDE" ? weight : weight / 2,
    inset: align === "OUTSIDE" ? 0 : align === "INSIDE" ? weight : weight / 2,
  };
}

/** Whether a stroke-only layer's ink runs through `g`. */
function strokeCrosses(s: Layer, g: Rect): boolean {
  const b = s.box;
  const { out, inset, weight } = strokeBand(s.a);
  // A straight line's box is flat, so it has no cover: its geometry is its box.
  if (s.node.type === "LINE") {
    if (b.width < 1 || b.height < 1) {
      // Straight along an axis: the ink is a band `weight` thick along it.
      const band = b.height < 1
        ? { x: b.x, y: b.y + b.height / 2 - weight / 2, width: b.width, height: weight }
        : { x: b.x + b.width / 2 - weight / 2, y: b.y, width: weight, height: b.height };
      return intersect(band, g) !== null;
    }
    // A diagonal runs corner to corner; Figma's rotation is counter-clockwise, so (0, 90) and (-180, -90) rise.
    const rot = num(s.a.rotation, 0);
    const rises = (rot > 0 && rot < 90) || (rot < -90 && rot > -180);
    return rises ? segmentHits(b.x, bottom(b), right(b), b.y, grow(g, weight / 2)) : segmentHits(b.x, b.y, right(b), bottom(b), grow(g, weight / 2));
  }
  if (!s.cover || !intersect(s.cover.outer, g)) return false;
  if (s.node.type === "ELLIPSE") {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const [rxo, ryo, rxi, ryi] = [b.width / 2 + out, b.height / 2 + out, b.width / 2 - inset, b.height / 2 - inset];
    const nx = Math.min(Math.max(cx, g.x), right(g)) - cx;
    const ny = Math.min(Math.max(cy, g.y), bottom(g)) - cy;
    if ((nx / rxo) ** 2 + (ny / ryo) ** 2 > 1) return false; // wholly outside the ring
    const corners = [[g.x, g.y], [right(g), g.y], [g.x, bottom(g)], [right(g), bottom(g)]] as const;
    const inside = rxi > 0 && ryi > 0 && corners.every(([x, y]) => ((x - cx) / rxi) ** 2 + ((y - cy) / ryi) ** 2 <= 1);
    return !inside;
  }
  return !(s.cover.hole && contains(s.cover.hole, g)); // an outline, unless the text sits wholly inside it
}

/** stroke_crosses_text: a line or ring through live type — a ripple ring through a URL in the run [C-207]. */
function strokesThroughText(c: Census, ix: Index, push: Push): void {
  const strokes = c.layers
    .filter((l) => !l.text && l.stroked && !l.filled && (l.cover || l.node.type === "LINE") && STROKE_SHAPES.has(l.node.type))
    .slice(0, 1000);
  if (!strokes.length) return;
  for (const t of ix.texts.slice(0, CRAFT.pairCap)) {
    const g = grow(t.text!.glyphs, -1); // a hairline touch at the ink's edge is not a crossing
    if (g.width <= 0 || g.height <= 0) continue;
    for (const s of strokes) {
      if ((t.inInstance && s.inInstance) || ix.isAncestor(s.node, t.node)) continue;
      if (!strokeCrosses(s, g)) continue;
      push(t, "stroke_crosses_text",
        `is crossed by the stroke of "${s.node.name}" (${s.node.id}) — a line through live type reads as a strike-through or a slip. ` +
          "Move one of them, or end the stroke before the text.", undefined, s);
    }
  }
}

/** edge_slices_text: a filled shape's edge running through the text it sits on — a band cutting "Ash Vase" 3–31 px in the run [C-207]. */
function edgesThroughText(c: Census, ix: Index, push: Push): void {
  const shapes = c.layers.filter((l) => !l.text && l.filled && l.cover && l.cover.opacity > 0.1).slice(0, 1000);
  for (const t of ix.texts.slice(0, CRAFT.pairCap)) {
    const g = t.text!.glyphs;
    if (g.width <= 0 || g.height <= 0) continue;
    for (const s of shapes) {
      if (s.order >= t.order) break; // a layer above the text hides it: `covered` judges that
      if ((t.inInstance && s.inInstance) || ix.isAncestor(s.node, t.node)) continue;
      const box = s.cover!.outer;
      const inBand = (at: number) => at >= CRAFT.sliceFrom && at <= CRAFT.sliceTo;
      let hit: { edge: string; at: number; of: string } | null = null;
      if (overlapX(box, g) > 2) {
        for (const [edge, y] of [["top", box.y], ["bottom", bottom(box)]] as const) {
          if (!hit && inBand((y - g.y) / g.height)) hit = { edge, at: (y - g.y) / g.height, of: "height" };
        }
      }
      if (!hit && overlapY(box, g) > 2) {
        for (const [edge, x] of [["left", box.x], ["right", right(box)]] as const) {
          if (!hit && inBand((x - g.x) / g.width)) hit = { edge, at: (x - g.x) / g.width, of: "width" };
        }
      }
      if (!hit) continue;
      push(t, "edge_slices_text",
        `the ${hit.edge} edge of "${s.node.name}" (${s.node.id}) runs through it at ${Math.round(hit.at * 100)}% of its ${hit.of} — type ` +
          "sitting on a boundary looks like a mistake. Move the text clear of the edge, or carry the shape past the text.", undefined, s);
    }
  }
}

/** Shapes a hairline is drawn with. */
const GRAPHIC = new Set(["LINE", "VECTOR", "ELLIPSE", "RECTANGLE", "POLYGON", "STAR", "BOOLEAN_OPERATION", "FRAME"]);

/**
 * weak_graphic_contrast: a thin stroke people need, too faint against its ground — a ripple at about 2.7:1 in the run [C-207] [C-221].
 * An inactive component is skipped: WCAG 2.2 SC 1.4.11 exempts it.
 */
function faintHairlines(c: Census, ix: Index, push: Push): void {
  for (const l of c.layers) {
    if (l.text || l.filled || !l.stroked || l.inInstance || l.inactive || !l.strokeSolid || !GRAPHIC.has(l.node.type)) continue;
    if (l.node.type === "FRAME" && (childrenOf(l.node) ?? []).length) continue; // a container's outline groups, it does not inform
    const weight = l.a.strokeWeight;
    if (typeof weight !== "number" || weight > CRAFT.hairline) continue;
    // A layer from another branch under it is its ground; failing that, its ancestors' fill.
    const under = groundUnder(ix, l.box, l.order, l.node, c.layers);
    const ground = under ? under.solid?.color : c.backdrop(l.node);
    if (!ground) continue;
    const alpha = l.strokeSolid.opacity * num(l.a.opacity, 1);
    if (alpha <= 0.01) continue; // it paints nothing here: a hidden ring a key shows later has no contrast at rest
    const seen = mix(l.strokeSolid.color, ground, alpha);
    const ratio = contrastRatio(seen, ground);
    if (ratio >= CRAFT.graphicContrast) continue;
    // Against the frame: under a motion brief a layer keys move or fade is judged on the rendered frames.
    push(l, "weak_graphic_contrast",
      `its ${r1(weight)} px stroke is ${ratio.toFixed(2)}:1 against the ground (${hex(seen)} on ${hex(ground)}); a line people need ` +
        `to read the content needs ${CRAFT.graphicContrast}:1. Darken or thicken it — or leave it, if nobody needs it.`, undefined, "frame");
  }
}
