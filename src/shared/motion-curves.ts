// Keyframe tracks as numbers per frame: the curve evaluation, frame sampling
// and cut pairs that figma_check_motion judges with and figma_create_animatic
// writes with. Pure, no dependencies: it runs in the server and the plugin.
//
// What makes per-frame evaluation trustworthy is measured: Figma's video export
// shows frame k at exactly t = k / fps, and a `cubic:` easing is CSS
// cubic-bezier — an edge in a real export sat on the curve to the pixel [C-193].
// The export renders the end frame too, so a timeline of d seconds, kept to
// the microsecond, is ceil(d · fps) + 1 frames in every format: a render ends
// on the first frame at or after the timeline's end [C-194].
//
// Keys travel in the string forms figma_get_motion_context reads and
// figma_set_keyframes takes (src/plugin/motion-fields.ts): a value is "120",
// "10,20" or "#rrggbb[aa]", and a key's easing shapes the move INTO that key,
// the convention the measurement above was taken with.
//
// Only LINEAR and `cubic:` evaluate exactly. The control points of Figma's
// named easings and spring presets are unpublished [C-190], so they get
// stand-in curves and every caller is told (`EasingInfo.exact`). HOLD keeps
// the old value until its key and steps on the frame at the key; on a
// segment's first key it has no effect [C-189]. It is evaluated that way, but
// its step was measured on one probe only, so it is flagged, never relied on:
// a jump is a cut pair [C-240]. Before a track's first key the first key's
// value is held and the base value never shows [C-191].

import type { MotionPlanRecord } from "./motion-plan.js";

/** A keyframe as the motion tools carry it. */
export interface KeyText {
  t: number;
  value: string;
  easing?: string;
}

export type Curve = (x: number) => number;

export type EasingKind = "linear" | "cubic" | "hold" | "named" | "spring" | "unknown";

export interface EasingInfo {
  curve: Curve;
  kind: EasingKind;
  /** True for LINEAR and `cubic:` only: named easings and springs are stand-ins [C-190], and HOLD, measured on one probe only, is not relied on [C-189]. */
  exact: boolean;
  /** A stock overshoot: a *_BACK preset, BOUNCY, or a spring with bounce. */
  overshoot: boolean;
}

// ── curves ───────────────────────────────────────────────────────────────────

/**
 * CSS cubic-bezier(x1, y1, x2, y2): solve x(s) = x for the curve parameter by
 * Newton's method, falling back to bisection where the slope is flat, then
 * return y(s). Outside 0–1 the curve is clamped: the segment has not started
 * or has ended.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Curve {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sy = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(s) - x;
      if (Math.abs(err) < 1e-10) return sy(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-7) break;
      const next = s - err / d;
      if (next < 0 || next > 1) break;
      s = next;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 64; i++) {
      const v = sx(s);
      if (Math.abs(v - x) < 1e-10) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

const linear: Curve = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const hold: Curve = (x) => (x >= 1 ? 1 : 0);

/**
 * A damped spring normalised to the segment, settling by its end: a stand-in
 * for Figma's springs, whose parameters are unpublished [C-190]. `bounce` 0 is
 * critically damped; more bounce means less damping and a visible overshoot.
 */
function springCurve(bounce: number): Curve {
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  // The envelope falls to 0.1 % at the segment's end.
  const w0 = 6.9 / zeta;
  if (zeta >= 0.999) return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.exp(-w0 * x) * (1 + w0 * x));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 - Math.exp(-zeta * w0 * x) * (Math.cos(wd * x) + ((zeta * w0) / wd) * Math.sin(wd * x));
  };
}

/** Stand-ins for the named presets: the CSS keywords and common back curves, and springs for the physical presets [C-190]. */
const NAMED: Record<string, { curve: Curve; overshoot: boolean; kind: EasingKind }> = {
  EASE_IN: { curve: cubicBezier(0.42, 0, 1, 1), overshoot: false, kind: "named" },
  EASE_OUT: { curve: cubicBezier(0, 0, 0.58, 1), overshoot: false, kind: "named" },
  EASE_IN_AND_OUT: { curve: cubicBezier(0.42, 0, 0.58, 1), overshoot: false, kind: "named" },
  EASE_IN_BACK: { curve: cubicBezier(0.36, 0, 0.66, -0.56), overshoot: true, kind: "named" },
  EASE_OUT_BACK: { curve: cubicBezier(0.34, 1.56, 0.64, 1), overshoot: true, kind: "named" },
  EASE_IN_AND_OUT_BACK: { curve: cubicBezier(0.68, -0.6, 0.32, 1.6), overshoot: true, kind: "named" },
  GENTLE: { curve: springCurve(0.1), overshoot: false, kind: "spring" },
  QUICK: { curve: springCurve(0), overshoot: false, kind: "spring" },
  BOUNCY: { curve: springCurve(0.45), overshoot: true, kind: "spring" },
  SLOW: { curve: springCurve(0), overshoot: false, kind: "spring" },
};

const cache = new Map<string, EasingInfo>();

/** The curve an easing string names; an absent easing is LINEAR, as Figma reads one back. */
export function easingCurve(easing: string | undefined): EasingInfo {
  const raw = (easing ?? "LINEAR").trim();
  const hit = cache.get(raw);
  if (hit) return hit;
  const info = parse(raw);
  cache.set(raw, info);
  return info;
}

function parse(raw: string): EasingInfo {
  const upper = raw.toUpperCase();
  if (upper === "" || upper === "LINEAR") return { curve: linear, kind: "linear", exact: true, overshoot: false };
  if (upper === "HOLD") return { curve: hold, kind: "hold", exact: false, overshoot: false };
  const cubic = /^cubic:(.*)$/i.exec(raw);
  if (cubic) {
    const n = cubic[1]!.split(",").map((v) => Number(v.trim()));
    if (n.length === 4 && n.every(Number.isFinite)) {
      const [x1, y1, x2, y2] = n as [number, number, number, number];
      return { curve: cubicBezier(x1, y1, x2, y2), kind: "cubic", exact: true, overshoot: y1 > 1 || y2 > 1 || y1 < 0 || y2 < 0 };
    }
  }
  const spring = /^spring:(.*)$/i.exec(raw);
  if (spring) {
    const b = Number(spring[1]);
    if (Number.isFinite(b)) return { curve: springCurve(b), kind: "spring", exact: false, overshoot: b > 0 };
  }
  const named = NAMED[upper];
  if (named) return { ...named, exact: false };
  // A variable alias ("var:<id>") or a form newer than this file: evaluated as LINEAR, flagged.
  return { curve: linear, kind: "unknown", exact: false, overshoot: false };
}

// ── values ───────────────────────────────────────────────────────────────────

/**
 * A keyframe value as numbers: "120" → [120], "10,20" → [10, 20], and a colour
 * "#rrggbb[aa]" → [r, g, b, a] in 0–1. Anything else (a boolean, text data) is
 * null: it has no in-between.
 */
export function parseKeyValue(value: string): number[] | null {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!.toLowerCase();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [ch(0), ch(2), ch(4), h.length === 8 ? ch(6) : 1];
  }
  if (s === "") return null;
  const parts = s.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  return parts.every(Number.isFinite) ? parts : null;
}

// ── tracks ───────────────────────────────────────────────────────────────────

export interface Key {
  t: number;
  value: string;
  v: number[] | null;
  /** The easing into this key, as given (absent reads as LINEAR). */
  easing: string;
  info: EasingInfo;
}

/** Keys sorted by time, with their values parsed and easings compiled once. */
export function compileKeys(keys: readonly KeyText[]): Key[] {
  return [...keys]
    .filter((k) => Number.isFinite(k.t))
    .sort((a, b) => a.t - b.t)
    .map((k) => ({ t: k.t, value: k.value, v: parseKeyValue(k.value), easing: k.easing ?? "LINEAR", info: easingCurve(k.easing) }));
}

/** Index of the key that ends the segment containing t (keys[i - 1].t < t ≤ keys[i].t), for t inside the track. */
function segmentEnd(keys: readonly Key[], t: number): number {
  let lo = 1;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Interpolate two values at curve output y; values of different shapes switch at the key. */
export function mix(a: number[] | null, b: number[] | null, y: number): number[] | null {
  if (!a || !b || a.length !== b.length) return y >= 1 ? b : a;
  return a.map((x, i) => x + (b[i]! - x) * y);
}

/**
 * The track's value at time t. Before the first key the first value holds and
 * after the last the last holds [C-191]; a segment's curve is its end key's
 * easing.
 */
export function valueAt(keys: readonly Key[], t: number): number[] | null {
  if (keys.length === 0) return null;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  const i = segmentEnd(keys, t);
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const span = b.t - a.t;
  return mix(a.v, b.v, span > 0 ? b.info.curve((t - a.t) / span) : 1);
}

/** The same with one segment's easing replaced: how a fix would change the frame. */
export function valueWithEasing(keys: readonly Key[], endIndex: number, easing: string, t: number): number[] | null {
  const swapped = keys.map((k, i) => (i === endIndex ? { ...k, easing, info: easingCurve(easing) } : k));
  return valueAt(swapped, t);
}

// ── frames ───────────────────────────────────────────────────────────────────

/** Frame k is sampled at exactly k / fps [C-193]. */
export const frameTime = (frame: number, fps: number): number => frame / fps;

/** How far t sits from the nearest frame, in frames (0 on the grid, at most 0.5). */
export function gridOffset(t: number, fps: number): number {
  const f = t * fps;
  return Math.abs(f - Math.round(f));
}

// Key times travel rounded to 0.1 ms, so a key meant for frame 38 at 30 fps
// reads 1.2667 s = frame 38.001. Within this many frames of a frame, a key is
// on it; a cut pair's keys sit 0.15 and 0.75 frame off, far outside it.
const ON_FRAME = 0.02;

/** The first frame whose time is at or after t: the frame that shows a key's value. */
export const frameAtOrAfter = (t: number, fps: number): number => Math.ceil(t * fps - ON_FRAME);

/**
 * The duration Figma keeps for a timeline: to the microsecond. A timeline set
 * to 86/24 s read back 3.583333 [C-194].
 */
export const keptDuration = (durationS: number): number => Math.round(durationS * 1e6) / 1e6;

// A kept duration is a whole number of microseconds, so at a whole fps d · fps
// is a whole frame or at least a millionth of a frame away from one. This only
// absorbs floating-point error, never a real fraction of a frame.
const FLOAT_NOISE = 1e-9;

/**
 * The last frame a render shows, in every format. The end frame renders too:
 * frames run k = 0 … ceil(d · fps) for the duration d Figma keeps [C-194].
 * 14.4 s at 30 fps rendered 433 frames; 1.2 s at 12 fps rendered 16 GIF
 * frames, k / 12 for k = 0…15, where round would give 15; and a timeline set
 * to 89/30 s, kept as 2.966667 s (89.00001 frames), rendered 91 MP4 frames,
 * where round would give 90. So a timeline meant to end exactly on a frame can
 * be kept a hair past it and render one frame more; figma_create_animatic ends
 * its timeline a hundredth of a frame short (animatic.ts END_MARGIN).
 */
export const lastFrame = (durationS: number, fps: number): number => Math.max(0, Math.ceil(keptDuration(durationS) * fps - FLOAT_NOISE));

/** How many frames a render of the whole timeline holds, end frame included: ceil(d · fps) + 1 [C-194]. */
export const expectedFrames = (durationS: number, fps: number): number => lastFrame(durationS, fps) + 1;

/** The last frame whose time is at or before t. */
export const frameAtOrBefore = (t: number, fps: number): number => Math.floor(t * fps + ON_FRAME);

/** The track's value on every frame from 0 to `last`. */
export function sampleFrames(keys: readonly Key[], fps: number, last: number): Array<number[] | null> {
  const out: Array<number[] | null> = new Array(last + 1);
  for (let f = 0; f <= last; f++) out[f] = valueAt(keys, frameTime(f, fps));
  return out;
}

// ── cut pairs ────────────────────────────────────────────────────────────────
// A jump on an exact frame is two LINEAR keys inside the frame interval before
// it: the old value at (k − 0.75)/fps and the new one at (k − 0.15)/fps, so
// frame k − 1 shows the old value and frame k the new one at any frame rate;
// measured on every switch of a render at 24 and 30 fps [C-240]. Never HOLD,
// whose step was measured on one probe only [C-189].

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** The two key times of a cut on frame k [C-240]. */
export function cutPairTimes(frame: number, fps: number): [number, number] {
  return [r4((frame - 0.75) / fps), r4((frame - 0.15) / fps)];
}

/** The two keys that switch `from` to `to` exactly on frame k [C-240]. */
export function cutPairKeys(frame: number, fps: number, from: string, to: string): KeyText[] {
  if (!Number.isInteger(frame) || frame < 1) throw new RangeError(`A cut needs a frame after the first, got ${frame}.`);
  const [a, b] = cutPairTimes(frame, fps);
  return [
    { t: a, value: from, easing: "LINEAR" },
    { t: b, value: to, easing: "LINEAR" },
  ];
}

export interface CutPair {
  /** Index of the pair's second key. */
  index: number;
  /** The first frame that shows the new value. */
  frame: number;
  /** No frame samples strictly between the two keys, so no in-between value is ever shown. */
  clean: boolean;
}

/** Whether keys a → b form a cut: a LINEAR change shorter than one frame. */
export function isCutPair(a: Pick<Key, "t" | "value">, b: Pick<Key, "t" | "value" | "easing">, fps: number): boolean {
  return a.value !== b.value && b.t - a.t < 1 / fps - 1e-9 && b.t > a.t && (b.easing ?? "LINEAR").toUpperCase() === "LINEAR";
}

/** Every cut pair in a track, with the frame it switches on [C-240]. */
export function findCutPairs(keys: readonly Pick<Key, "t" | "value" | "easing">[], fps: number): CutPair[] {
  const out: CutPair[] = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (!isCutPair(a, b, fps)) continue;
    const frame = frameAtOrAfter(b.t, fps);
    out.push({ index: i, frame, clean: (frame - 1) / fps <= a.t + 1e-6 });
  }
  return out;
}

// ── the snapshot figma_check_motion judges ───────────────────────────────────
// The plugin op `check_motion` (src/plugin/ops/motion-snapshot.ts) reads it and
// the server (src/server/motion-audit.ts) judges it; both import these types
// from here, so the two sides cannot drift apart.

export interface SnapshotTrack {
  field: string;
  keyframes: KeyText[];
  /** The binding's base value, in the same string form, where the API exposes one [C-183]. */
  base?: string;
}

export interface SnapshotEffect {
  type: string;
  radius?: number;
  visible?: boolean;
}

export interface SnapshotNode {
  id: string;
  name: string;
  type: string;
  /** Null only for the audited top-level frame itself. */
  parentId: string | null;
  /** The box as read: inside an animated frame, the base values, not the state at the playhead [C-192]. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  /** Omitted when 1. */
  opacity?: number;
  /** Present (false) only when hidden. */
  visible?: boolean;
  clipsContent?: boolean;
  isMask?: boolean;
  /** Own auto-layout direction, when it has one. */
  layoutMode?: string;
  layoutPositioning?: string;
  cornerRadius?: number;
  strokeCap?: string;
  strokeWeight?: number;
  /** TEXT only, cut at 500 characters. */
  characters?: string;
  fontSize?: number;
  effects?: SnapshotEffect[];
  childCount?: number;
  tracks?: SnapshotTrack[];
  /** How many animation styles the node carries: listed, not evaluated. */
  animationStyles?: number;
}

export interface MotionSnapshot {
  /**
   * The frame read. `handles`: every id the page lists it under, when it lists
   * it more than once during a second-id stretch [C-199], this id first.
   */
  root: { id: string; name: string; width?: number; height?: number; durationS: number | null; timelineId?: string; handles?: string[] };
  /** The root first, then its descendants in document order: every parent before its children. */
  nodes: SnapshotNode[];
  truncated: boolean;
  maxNodes: number;
  /** How the frame was found: "node", "selection" or "page". */
  from?: string;
  /**
   * The frame's motion plan (figma_set_motion_plan), read in the same pass, so
   * the check is judged against the plan of the very frame it read: null when
   * the frame has none. Absent from a plugin built before plans.
   */
  plan?: MotionPlanRecord | null;
  /** Why a stored plan could not be read. */
  planInvalid?: string;
  /**
   * Ids the check names (the plan's brandId and ctaId, and those the call
   * asked for) that resolve to a layer listed here under another id, mapped
   * to that id: during a second-id stretch the listing gives second ids while
   * a plan holds the ids create calls returned [C-199]. Empty when every
   * named id is listed as it is; absent only from a plugin built before it.
   */
  aliases?: Record<string, string>;
  /**
   * Named ids that resolve to a layer its parent lists under another id, but
   * that two or more listed layers match: the check cannot tell which listed
   * layer it is [C-199].
   */
  unmapped?: string[];
  /** Named ids that resolve to a layer outside this frame, the whole frame read. */
  outside?: string[];
  /** Named ids that resolve to nothing: deleted, or a temporary id that stopped resolving [C-199]. */
  gone?: string[];
}
