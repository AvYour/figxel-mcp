// figma_check_motion's judge: a motion designer's frame-by-frame look at an
// animated top-level frame, as data. Pure: it takes the snapshot the plugin op
// `check_motion` reads (src/plugin/ops/motion-snapshot.ts) and returns the
// findings, so every rule is tested in Node against recorded snapshots.
//
// Why per frame: the 2026-10-09 run climbed from 6.5 to 8 only once critics
// measured frames by hand — per-frame steps, edge positions, values sampled
// from the keys — and almost every finding was one of a few kinds [C-206].
// Each rule below names the finding behind it, and each default threshold was
// set on the run's three snapshots so that the confirmed findings fire before
// the critics' fixes and go quiet after them [C-246]. A threshold changes only
// with a fixture test that keeps those findings (test/motion-audit-fixtures).
//
// Exact where Figma is exact: LINEAR and `cubic:` tracks are evaluated at
// frame k = k / fps, as the export samples them [C-193]. Named easings are
// stand-ins [C-190]. HOLD keeps the old value until its key and steps on the
// frame at it [C-189], measured on one probe only, so it is still reported:
// a jump is a cut pair [C-240]. Before its first key a track shows the first
// key's value, never the base [C-191]. A box read inside an animated frame
// gives the base values, not the state at the playhead [C-192]; `limits` says
// which of these a result leaned on. Layout over time (a graphic crossing
// text, a clip slicing letters, a layer covered by another) is not judged here.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import {
  compileKeys,
  cutPairTimes,
  expectedFrames,
  findCutPairs,
  frameAtOrAfter,
  frameAtOrBefore,
  gridOffset,
  isCutPair,
  lastFrame,
  parseKeyValue,
  valueWithEasing,
  valueAt,
  type Key,
  type MotionSnapshot,
  type SnapshotNode,
} from "../shared/motion-curves.js";
import type { MotionPlanAccept } from "../shared/motion-plan.js";

// ── the rule catalogue ───────────────────────────────────────────────────────

export const RULE_IDS = [
  "vanish_mid_move", "pop_in", "concentrated_step", "strobe", "blur_off_speed", "one_frame_extreme",
  "arrival_not_held", "dead_span", "cold_open", "template_move", "no_stagger", "unrendered_extreme",
  "easing_census", "hold_easing", "beat_offset", "read_time", "rest_state_hidden", "timeline_end",
  "roundcap_zero_trim", "brand_late", "cta_short", "first_key_late", "clamped_morph",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Findings reported under a narrower name than the rule that finds them; asking for the rule includes them. */
export const VARIANTS: Readonly<Record<string, RuleId>> = {
  cut_at_rest: "vanish_mid_move",
  stagger_off_grid: "no_stagger",
  off_grid: "unrendered_extreme",
  dimmed_text: "read_time",
};

/** Every name an issue's `rule` can carry: what a motion plan's `accept` names. */
export const ISSUE_RULES = [...RULE_IDS, ...Object.keys(VARIANTS)] as [string, ...string[]];

/** brand_late's and cta_short's defaults [C-235] [C-241]: a plan's check may be stricter, never looser. */
export const DEFAULT_BRAND_BY_S = 3;
export const DEFAULT_CTA_MIN_S = 2.5;

export type Severity = "error" | "warning" | "info";
const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export interface Thresholds {
  /** concentrated_step: one frame carrying this share of a move's travel. */
  stepShare: number;
  /** concentrated_step, pop_in: smaller jumps than this many px are not seen. */
  stepPx: number;
  strobeInfoPx: number;
  strobeWarnPx: number;
  strobeAnyBlurPx: number;
  /** dead_span: anything slower than this many px per frame reads as still. */
  aliveSpeedPx: number;
  deadSpanS: number;
  minHoldFrames: number;
  readSecondsPerWord: number;
  beatToleranceFrames: number;
  oneCurveShare: number;
  templateParents: number;
  templateShare: number;
}

// Each default is a 2026-10-09 finding [C-246]: 40 % of a move in one frame
// was the slit's 53 % and the plate wipe's 48 %; 150 px per frame was the
// build judge's strobe limit and 400 px the jump no capped blur covered
// [C-243]; 1 px per frame is the end-card drift the critics read as a freeze;
// 0.3 s per word is the bible's reading floor [C-241].
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = {
  stepShare: 0.4,
  stepPx: 24,
  strobeInfoPx: 60,
  strobeWarnPx: 150,
  strobeAnyBlurPx: 400,
  aliveSpeedPx: 1,
  deadSpanS: 0.5,
  minHoldFrames: 3,
  readSecondsPerWord: 0.3,
  beatToleranceFrames: 1,
  oneCurveShare: 0.7,
  templateParents: 3,
  templateShare: 0.4,
};

/** The replacement easings a fix tries: SOFT for settles and DRAW for trim draws, the critics' own fixes. */
export const FIX_EASINGS = { soft: "cubic:0.45,0,0.55,1", draw: "cubic:0.65,0,0.35,1" } as const;

export interface AuditOptions {
  fps?: number;
  from?: number;
  to?: number;
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  /** The music's own beats, s (figma_analyze_audio's beatTimes): when given, they replace the grid of `bpm` and `beatOffset`. */
  beatTimes?: readonly number[];
  rules?: readonly string[];
  minSeverity?: Severity;
  limit?: number;
  thresholds?: Partial<Thresholds>;
  holds?: ReadonlyArray<{ from: number; to: number }>;
  brandId?: string;
  ctaId?: string;
  brandBy?: number;
  ctaMinS?: number;
  includeActivity?: boolean;
  /** The frame's plan's declared exceptions: a matching warning or info is listed in `accepted`, not against ok. */
  accept?: readonly MotionPlanAccept[];
}

export interface MotionIssue {
  rule: string;
  severity: Severity;
  nodeId: string;
  name: string;
  field?: string;
  frame: number;
  t: number;
  frames?: [number, number];
  detail: string;
  fix?: string;
}

export interface BeatHit {
  frame: number;
  nearestBeat: number;
  offsetFrames: number;
  nodeId: string;
  kind: string;
}

export interface AuditResult {
  root: { id: string; name: string; durationS: number };
  fps: number;
  /** A render's length in every format, end frame included: ceil(d · fps) + 1 [C-194]. */
  expectedFrames: number;
  window?: { from: number; to: number };
  checked: { layers: number; tracks: number; keys: number };
  ok: boolean;
  counts: Record<Severity, number>;
  issues: MotionIssue[];
  more?: number;
  census: { easings: Record<string, number>; offGrid: number; cutPairs: number; approximated: string[] };
  beats?: {
    /** Where the grid came from: a tempo, or the beats of the music itself. */
    source: "bpm" | "beatTimes";
    bpm: number;
    beatOffset: number;
    beatsPerBar: number;
    framesPerBeat: number;
    /** With `beatTimes`: how many beats were given. */
    beatCount?: number;
    hits: BeatHit[];
    scenes: Array<{ nodeId: string; name: string; from: number; to: number; beats: number }>;
    note?: string;
  };
  activity?: number[];
  truncated?: boolean;
  note?: string;
  limits: string[];
  /** Findings the plan's `accept` covers, each with its reason: out of `issues`, `counts` and `ok`. */
  accepted?: Array<MotionIssue & { reason: string }>;
  acceptedMore?: number;
}

// ── the model: every node's numbers on every frame ──────────────────────────

const TRANSLATION = /^TRANSLATION_(X|Y|XY)$/;
const SCALE = /^SCALE_(X|Y|XY)$/;
const TRIM = /^PATH_TRIM_(START|END)$/;
const GEOMETRY = /^(TRANSLATION_(X|Y|XY)|SCALE_(X|Y|XY)|WIDTH|HEIGHT|ROTATION|PATH_TRIM_(START|END))$/;
const BODY = /^(TRANSLATION_(X|Y|XY)|SCALE_(X|Y|XY)|WIDTH|HEIGHT)$/;
const SIZE = /^(SCALE_(X|Y|XY)|WIDTH|HEIGHT|PATH_TRIM_(START|END))$/;
const BLUR = /^effect:(\d+):RADIUS$/;
const PAINT = /^(fill|stroke):\d+$/;
/** The size a layer whose box was not read is judged at. */
const UNSIZED = 100;

interface TrackM {
  field: string;
  keys: Key[];
  base: number[] | null;
  values: Array<number[] | null>;
}

interface NodeM {
  s: SnapshotNode;
  id: string;
  name: string;
  parent: NodeM | null;
  kids: NodeM[];
  tracks: Map<string, TrackM>;
  w: number;
  h: number;
  /** Farthest edge from the centre pivot, for converting scale to px [C-115]. */
  r: number;
  diag: number;
  /** Path length estimate for trims: exact for an L, a lower bound for a curve. */
  len: number;
  /** Own and inherited opacity, own size fraction, inherited blur, own blur. */
  op: Float64Array;
  size: Float64Array;
  blur: Float64Array;
  ownBlur: Float64Array;
  /**
   * How far the layer's box edges travel from the previous frame, px: its own
   * move, scale and size, carried by its ancestors' translations as vectors —
   * so a counter-translated photo inside a moving mask reads as still.
   */
  body: Float64Array;
  /** The same from the layer's own tracks alone: what its own blur keys answer to. */
  own: Float64Array;
  /** The drawn length of a trimmed stroke, and stack spacing, px per frame. */
  draw: Float64Array;
  /** Where this layer's children are carried: its own and its ancestors' translations, px per frame. */
  ox: Float64Array;
  oy: Float64Array;
  /** Own edge travel from scale, size and rotation, which moves every child too; and the sum down from the root. */
  grow: Float64Array;
  growSum: Float64Array;
  /** Body plus every ancestor's growth: an upper bound of what moves on screen. */
  screen: Float64Array;
  /** The change into this frame comes from a cut pair or a HOLD, not a move. */
  cut: Uint8Array;
  paint: Uint8Array;
}

interface Model {
  fps: number;
  durationS: number;
  last: number;
  root: NodeM;
  nodes: NodeM[];
  byId: Map<string, NodeM>;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const pct = (v: number) => `${Math.round(v * 100)} %`;
const diff = (a: number[] | null | undefined, b: number[] | null | undefined): number[] | null =>
  a && b && a.length === b.length ? b.map((x, i) => x - a[i]!) : null;

function trackOf(n: NodeM, field: string): TrackM | undefined {
  return n.tracks.get(field);
}

function valueOf(n: NodeM, field: string, f: number): number[] | null {
  return n.tracks.get(field)?.values[f] ?? null;
}

/** Visible size as a fraction 0–1: |scale|, size over the largest size the layer takes, and the trim length. */
function sizeAt(n: NodeM, f: number, override?: { field: string; v: number[] | null }): number {
  const get = (field: string) => (override && override.field === field ? override.v : valueOf(n, field, f));
  let s = 1;
  const xy = get("SCALE_XY");
  if (xy) s = Math.min(s, Math.abs(xy[0]!), Math.abs(xy[1] ?? xy[0]!));
  for (const fld of ["SCALE_X", "SCALE_Y"]) {
    const v = get(fld);
    if (v) s = Math.min(s, Math.abs(v[0]!));
  }
  const w = get("WIDTH");
  if (w && n.w > 0) s = Math.min(s, Math.abs(w[0]!) / n.w);
  const h = get("HEIGHT");
  if (h && n.h > 0) s = Math.min(s, Math.abs(h[0]!) / n.h);
  const te = get("PATH_TRIM_END");
  const ts = get("PATH_TRIM_START");
  if (te || ts) s = Math.min(s, (te ? te[0]! : 1) - (ts ? ts[0]! : 0));
  return clamp01(s);
}

/** A change of one field as px of travel on screen. */
function fieldPx(n: NodeM, field: string, d: number[] | null): number {
  if (!d || d.length === 0) return 0;
  if (field === "TRANSLATION_XY") return Math.hypot(d[0]!, d[1] ?? 0);
  if (TRANSLATION.test(field) || field === "WIDTH" || field === "HEIGHT") return Math.abs(d[0]!);
  if (SCALE.test(field)) return Math.max(...d.map(Math.abs)) * n.r;
  if (TRIM.test(field)) return Math.abs(d[0]!) * n.len;
  if (field === "ROTATION") return ((Math.abs(d[0]!) * Math.PI) / 180) * (n.diag / 2);
  return Math.abs(d[0]!);
}

function buildModel(snap: MotionSnapshot, fps: number): Model {
  const shells: NodeM[] = [];
  const byId = new Map<string, NodeM>();
  let maxT = 0;
  const rootSnap: SnapshotNode = snap.nodes[0] && snap.nodes[0].parentId === null ? snap.nodes[0] : { id: snap.root.id, name: snap.root.name, type: "FRAME", parentId: null };
  const list = rootSnap === snap.nodes[0] ? snap.nodes : [rootSnap, ...snap.nodes];
  for (const s of list) {
    const tracks = new Map<string, TrackM>();
    for (const t of s.tracks ?? []) {
      const keys = compileKeys(t.keyframes);
      if (keys.length === 0) continue;
      maxT = Math.max(maxT, keys[keys.length - 1]!.t);
      tracks.set(t.field, { field: t.field, keys, base: t.base !== undefined ? parseKeyValue(t.base) : null, values: [] });
    }
    const maxAbs = (tr: TrackM | undefined) => (tr ? Math.max(0, ...tr.keys.map((k) => Math.abs(k.v?.[0] ?? 0)), Math.abs(tr.base?.[0] ?? 0)) : 0);
    // The largest size the layer takes: a read gives the base size, never the
    // size at the playhead [C-192], so the WIDTH and HEIGHT keys add the rest.
    let w = Math.max(s.width ?? 0, maxAbs(tracks.get("WIDTH")));
    let h = Math.max(s.height ?? 0, maxAbs(tracks.get("HEIGHT")));
    if (w <= 0 && h <= 0) w = h = s.fontSize ?? UNSIZED;
    const parent = s.parentId === null ? null : (byId.get(s.parentId) ?? shells[0] ?? null);
    const n: NodeM = {
      s,
      id: s.id,
      name: s.name,
      parent,
      kids: [],
      tracks,
      w,
      h,
      r: Math.max(w, h) / 2,
      diag: Math.hypot(w, h),
      len: w + h,
      op: new Float64Array(0),
      size: new Float64Array(0),
      blur: new Float64Array(0),
      ownBlur: new Float64Array(0),
      body: new Float64Array(0),
      own: new Float64Array(0),
      draw: new Float64Array(0),
      ox: new Float64Array(0),
      oy: new Float64Array(0),
      grow: new Float64Array(0),
      growSum: new Float64Array(0),
      screen: new Float64Array(0),
      cut: new Uint8Array(0),
      paint: new Uint8Array(0),
    };
    parent?.kids.push(n);
    shells.push(n);
    byId.set(n.id, n);
  }
  const durationS = snap.root.durationS ?? maxT;
  const last = lastFrame(durationS, fps);
  const F = last + 1;
  // A layer without keys only inherits, so it shares its parent's arrays:
  // 5,000 still layers over a minute at 60 fps must not cost gigabytes.
  const ZERO = new Float64Array(F);
  const ONE = new Float64Array(F).fill(1);
  const NONE = new Uint8Array(F);
  const carried = new Map<NodeM, { body: Float64Array; screen: Float64Array }>();
  const carry = (p: NodeM) => {
    let c = carried.get(p);
    if (!c) {
      const body = new Float64Array(F);
      const screen = new Float64Array(F);
      for (let f = 0; f < F; f++) {
        body[f] = Math.hypot(p.ox[f]!, p.oy[f]!);
        screen[f] = body[f]! + p.growSum[f]!;
      }
      c = { body, screen };
      carried.set(p, c);
    }
    return c;
  };
  const staticBlur = (n: NodeM) => Math.max(0, ...(n.s.effects ?? []).filter((e) => e.type === "LAYER_BLUR" && e.visible !== false).map((e) => e.radius ?? 0));
  for (const n of shells) {
    const p = n.parent;
    if (p && n.tracks.size === 0) {
      const base = n.s.visible === false ? 0 : (n.s.opacity ?? 1);
      const b = staticBlur(n);
      const c = carry(p);
      Object.assign(n, {
        op: base === 1 ? p.op : p.op.map((v) => v * base),
        size: ONE,
        ownBlur: b > 0 ? new Float64Array(F).fill(b) : ZERO,
        blur: b > 0 ? p.blur.map((v) => Math.max(v, b)) : p.blur,
        body: c.body,
        screen: c.screen,
        own: ZERO,
        draw: ZERO,
        ox: p.ox,
        oy: p.oy,
        grow: ZERO,
        growSum: p.growSum,
        cut: NONE,
        paint: NONE,
      });
      continue;
    }
    for (const tr of n.tracks.values()) {
      tr.values = new Array(F);
      for (let f = 0; f < F; f++) tr.values[f] = valueAt(tr.keys, f / fps);
    }
    n.op = new Float64Array(F);
    n.size = new Float64Array(F);
    n.blur = new Float64Array(F);
    n.ownBlur = new Float64Array(F);
    n.body = new Float64Array(F);
    n.own = new Float64Array(F);
    n.draw = new Float64Array(F);
    n.ox = new Float64Array(F);
    n.oy = new Float64Array(F);
    n.grow = new Float64Array(F);
    n.growSum = new Float64Array(F);
    n.screen = new Float64Array(F);
    n.cut = new Uint8Array(F);
    n.paint = new Uint8Array(F);
    // Blur is a LAYER_BLUR's radius; a snapshot without effects (a fixture) counts every radius track.
    const blurAt: Array<{ i: number; base: number }> = [];
    if (n.s.effects) {
      n.s.effects.forEach((e, i) => {
        if (e.type === "LAYER_BLUR" && e.visible !== false) blurAt.push({ i, base: e.radius ?? 0 });
      });
    } else {
      for (const field of n.tracks.keys()) {
        const m = BLUR.exec(field);
        if (m) blurAt.push({ i: Number(m[1]), base: 0 });
      }
    }
    const baseOpacity = n.s.visible === false ? 0 : (n.s.opacity ?? 1);
    const kids = Math.max(1, ((n.s.childCount ?? n.kids.length) - 1) / 2);
    for (let f = 0; f < F; f++) {
      const o = valueOf(n, "OPACITY", f);
      const own = n.s.visible === false ? 0 : clamp01(o ? o[0]! : baseOpacity);
      n.op[f] = own * (n.parent ? n.parent.op[f]! : 1);
      n.size[f] = sizeAt(n, f);
      let b = 0;
      for (const { i, base } of blurAt) b = Math.max(b, valueOf(n, `effect:${i}:RADIUS`, f)?.[0] ?? base);
      n.ownBlur[f] = b;
      n.blur[f] = Math.max(b, n.parent ? n.parent.blur[f]! : 0);
      if (f > 0) {
        const d = (field: string) => diff(valueOf(n, field, f - 1), valueOf(n, field, f));
        const xy = d("TRANSLATION_XY");
        const tx = (xy?.[0] ?? 0) + (d("TRANSLATION_X")?.[0] ?? 0);
        const ty = (xy?.[1] ?? 0) + (d("TRANSLATION_Y")?.[0] ?? 0);
        // The box: scale works about the centre [C-115]; WIDTH and HEIGHT are
        // taken to grow from the top-left corner, as the run's builds assumed
        // (a slit opening from its centre needed a counter-translation). An
        // edge travels by the centre's shift plus the change of the half-size.
        const half = (k: number, axis: 0 | 1) => {
          const s = Math.abs(valueOf(n, "SCALE_XY", k)?.[axis] ?? 1) * Math.abs(valueOf(n, axis ? "SCALE_Y" : "SCALE_X", k)?.[0] ?? 1);
          return (s * Math.abs(valueOf(n, axis ? "HEIGHT" : "WIDTH", k)?.[0] ?? (axis ? n.h : n.w))) / 2;
        };
        const dw = d("WIDTH")?.[0] ?? 0;
        const dh = d("HEIGHT")?.[0] ?? 0;
        const hx = Math.abs(half(f, 0) - half(f - 1, 0));
        const hy = Math.abs(half(f, 1) - half(f - 1, 1));
        const px = n.parent ? n.parent.ox[f]! : 0;
        const py = n.parent ? n.parent.oy[f]! : 0;
        const rot = fieldPx(n, "ROTATION", d("ROTATION"));
        n.body[f] = Math.hypot(Math.abs(px + tx + dw / 2) + hx, Math.abs(py + ty + dh / 2) + hy) + rot;
        n.own[f] = Math.hypot(Math.abs(tx + dw / 2) + hx, Math.abs(ty + dh / 2) + hy) + rot;
        n.ox[f] = px + tx;
        n.oy[f] = py + ty;
        n.grow[f] = Math.max(hx, hy) + rot;
        const trim = Math.max(Math.abs(d("PATH_TRIM_END")?.[0] ?? 0), Math.abs(d("PATH_TRIM_START")?.[0] ?? 0));
        n.draw[f] = trim * n.len + Math.abs(d("STACK_SPACING")?.[0] ?? 0) * kids;
        for (const [field, tr] of n.tracks) {
          if (!PAINT.test(field)) continue;
          const c = diff(tr.values[f - 1], tr.values[f]);
          if (c && c.some((x) => Math.abs(x) >= 1 / 255)) n.paint[f] = 1;
        }
      }
      const inherited = p ? p.growSum[f]! : 0;
      n.growSum[f] = n.grow[f]! + inherited;
      n.screen[f] = n.body[f]! + inherited;
    }
    for (const [field, tr] of n.tracks) {
      if (!GEOMETRY.test(field)) continue;
      for (const c of findCutPairs(tr.keys, fps)) if (c.frame <= last) n.cut[c.frame] = 1;
      tr.keys.forEach((k, i) => {
        if (i > 0 && k.info.kind === "hold") {
          const f = frameAtOrAfter(k.t, fps);
          if (f <= last) n.cut[f] = 1;
        }
      });
    }
  }
  return { fps, durationS, last, root: shells[0]!, nodes: shells, byId };
}

// ── helpers the rules share ─────────────────────────────────────────────────

/** The index of the key that ends the segment holding t, or -1 outside the track. */
function segmentAt(keys: readonly Key[], t: number): number {
  for (let i = 1; i < keys.length; i++) if (keys[i - 1]!.t < t && t <= keys[i]!.t + 1e-9) return i;
  return -1;
}

/** Whether a move ends at rest: the last key, or followed by a hold of the same value. */
function arrives(keys: readonly Key[], i: number): boolean {
  return i === keys.length - 1 || keys[i + 1]!.value === keys[i]!.value;
}

/**
 * The nearest ancestor that groups layers: a clipping frame that only wraps
 * one layer is a mask, not a group, so letters each in their own mask are
 * siblings of one line.
 */
function groupOf(n: NodeM, root: NodeM): NodeM {
  let p = n.parent ?? root;
  while (p !== root && p.parent && p.s.clipsContent === true && p.kids.length <= 1) p = p.parent;
  return p;
}

interface Segment {
  i: number;
  a: Key;
  b: Key;
  f0: number;
  f1: number;
}

/** Every moving segment of a track: values differ, not a cut pair, not HOLD. */
function moves(tr: TrackM, fps: number, last: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < tr.keys.length; i++) {
    const a = tr.keys[i - 1]!;
    const b = tr.keys[i]!;
    if (a.value === b.value || !a.v || !b.v || b.info.kind === "hold" || isCutPair(a, b, fps)) continue;
    out.push({ i, a, b, f0: Math.max(0, frameAtOrBefore(a.t, fps)), f1: Math.min(last, frameAtOrAfter(b.t, fps)) });
  }
  return out;
}

/** The readable frames of a layer: opaque, full size, sharp and still on screen [C-241]. */
function readable(n: NodeM, f: number): boolean {
  return n.op[f]! >= 0.95 && n.size[f]! >= 0.98 && n.blur[f]! < 1 && n.screen[f]! < 2;
}

/** The longest run of frames in [from, to] where `pred` holds. */
function longestRun(from: number, to: number, pred: (f: number) => boolean): { length: number; start: number } {
  let best = { length: 0, start: from };
  let run = 0;
  for (let f = from; f <= to; f++) {
    if (pred(f)) {
      run++;
      if (run > best.length) best = { length: run, start: f - run + 1 };
    } else run = 0;
  }
  return best;
}

/** Words in a line of copy: a token with a letter or a digit, so numbers and prices count [C-241]. */
export const words = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Seconds a line needs fully readable: max(5/6 s, `perWord` per word) [C-241].
 * read_time judges every text layer by it, and figma_set_motion_plan every beat's copy.
 */
export function readNeedS(text: string, perWord: number = DEFAULT_THRESHOLDS.readSecondsPerWord): number {
  return Math.max(5 / 6, words(text) * perWord);
}

/**
 * The frame of the beat or eighth nearest frame `f`, on a grid of `bpm` from
 * `beatOffset` seconds: what beat_offset measures an accent against, and what
 * figma_set_motion_plan holds a planned accent to.
 */
export function nearestGridFrame(f: number, fps: number, bpm: number, beatOffset = 0): number {
  const half = 60 / bpm / 2;
  const j = Math.round((f / fps - beatOffset) / half);
  return Math.round((beatOffset + j * half) * fps);
}

// ── the audit ────────────────────────────────────────────────────────────────

class Audit {
  readonly issues: MotionIssue[] = [];
  readonly fps: number;
  readonly kFrom: number;
  readonly kTo: number;
  readonly limits = new Set<string>();

  constructor(
    readonly m: Model,
    readonly T: Thresholds,
    readonly opts: AuditOptions,
    readonly selected: ReadonlySet<string>,
  ) {
    this.fps = m.fps;
    this.kFrom = opts.from !== undefined ? Math.max(0, frameAtOrAfter(opts.from, m.fps)) : 0;
    this.kTo = opts.to !== undefined ? Math.min(m.last, frameAtOrBefore(opts.to, m.fps)) : m.last;
  }

  t = (f: number) => r4(f / this.fps);
  on = (rule: string) => this.selected.has(VARIANTS[rule] ?? rule);
  inWindow = (f: number) => f >= this.kFrom && f <= this.kTo;
  visible = (n: NodeM, f: number) => n.op[f]! >= 0.5;

  add(issue: Omit<MotionIssue, "t">, global = false): void {
    if (!this.on(issue.rule)) return;
    if (!global && !this.inWindow(issue.frame)) return;
    this.issues.push({ ...issue, t: this.t(issue.frame) });
  }

  /** Try the two replacement easings on one segment and name the one that fixes it. */
  tryEasings(field: string, measure: (easing: string) => number, good: (v: number) => boolean): { easing: string; value: number; good: boolean } {
    const order = TRIM.test(field) ? [FIX_EASINGS.draw, FIX_EASINGS.soft] : [FIX_EASINGS.soft, FIX_EASINGS.draw];
    let best: { easing: string; value: number; good: boolean } | undefined;
    for (const easing of order) {
      const value = measure(easing);
      if (good(value)) return { easing, value, good: true };
      if (!best || value < best.value) best = { easing, value, good: false };
    }
    return best!;
  }

  run(): void {
    const has = (...rules: string[]) => rules.some((r) => this.selected.has(r));
    if (has("vanish_mid_move", "pop_in")) this.vanishAndPop();
    if (has("concentrated_step")) this.concentratedStep();
    if (has("strobe")) this.strobe();
    if (has("blur_off_speed")) this.blurOffSpeed();
    if (has("one_frame_extreme")) this.oneFrameExtreme();
    if (has("arrival_not_held")) this.arrivalNotHeld();
    if (has("dead_span", "cold_open")) this.stillness();
    if (has("template_move", "no_stagger")) this.templates();
    if (has("unrendered_extreme")) this.unrendered();
    if (has("hold_easing")) this.holdEasing();
    if (has("read_time")) this.readTime();
    if (has("rest_state_hidden")) this.restStateHidden();
    if (has("timeline_end")) this.timelineEnd();
    if (has("roundcap_zero_trim")) this.roundcap();
    if (has("brand_late", "cta_short")) this.brandAndCta();
    if (has("first_key_late")) this.firstKeyLate();
    if (has("clamped_morph")) this.clampedMorph();
  }

  get animated(): NodeM[] {
    return this.m.nodes.filter((n) => n !== this.m.root && n.tracks.size > 0);
  }

  // ── vanish_mid_move, cut_at_rest, pop_in ──────────────────────────────────
  // Closes that pop: the ring trim, the loop and two bands each still 63–75 %
  // of their size on their last visible frame; the arrow shaft and head turned
  // on at 0.75 and 0.83 of their length (journal line 40) [C-206].

  vanishAndPop(): void {
    const { m } = this;
    const ext = (n: NodeM, f: number) => n.op[f]! * n.size[f]!;
    const appears = new Map<number, NodeM[]>();
    for (const n of m.nodes) {
      if (n === m.root) continue;
      for (let f = 1; f <= m.last; f++) if (ext(n, f - 1) <= 0.02 && ext(n, f) >= 0.4) appears.set(f, [...(appears.get(f) ?? []), n]);
    }
    for (const n of this.animated) {
      const own = (f: number) => !n.parent || Math.abs(n.parent.op[f]! - n.parent.op[f - 1]!) <= 0.02;
      for (let f = Math.max(1, this.kFrom); f <= this.kTo; f++) {
        const a = ext(n, f - 1);
        const b = ext(n, f);
        if (a >= 0.4 && b <= 0.02 && own(f) && n.blur[f - 1]! < 6) this.vanish(n, f, a, appears.get(f)?.find((o) => o !== n));
        if (a <= 0.02 && b >= 0.6 && n.size[f - 1]! <= 0.02 && n.size[f]! >= 0.6 && own(f) && n.blur[f]! < 6) this.popIn(n, f);
      }
    }
  }

  vanish(n: NodeM, f: number, a: number, heir: NodeM | undefined): void {
    const moving = f >= 2 && (n.body[f - 1]! + n.draw[f - 1]! >= this.T.aliveSpeedPx || Math.abs(n.size[f - 1]! - n.size[f - 2]!) >= 0.01);
    const base = { nodeId: n.id, name: n.name, frame: f, frames: [f - 1, f] as [number, number] };
    if (!moving && n.size[f - 1]! >= 0.98) {
      this.add({ ...base, rule: "cut_at_rest", severity: "info", detail: `cut whole and at rest on f${f}: fine when something covers or replaces it on that frame.` });
      return;
    }
    if (heir) {
      this.add({
        ...base,
        rule: "cut_at_rest",
        severity: "info",
        detail: `leaves on f${f} while "${heir.name}" appears on the same frame: a hand-off. Compare the two frames with figma_review_video.`,
      });
      return;
    }
    // The size track still moving into the last visible frame is the one a fix eases.
    const t = this.t(f - 1);
    let fix = `Let it finish before it goes: end its move before f${f}, or blur it out (radius 6 or more) on its last frames.`;
    let field: string | undefined;
    let best: { easing: string; value: number; good: boolean; at: number; from: string } | undefined;
    for (const [fld, tr] of n.tracks) {
      if (!SIZE.test(fld) || f < 2) continue;
      const v1 = tr.values[f - 1];
      const v0 = tr.values[f - 2];
      if (!v1 || !v0 || v1.every((x, i) => Math.abs(x - v0[i]!) < 1e-6)) continue;
      const i = segmentAt(tr.keys, t);
      if (i < 0) continue;
      const tried = this.tryEasings(fld, (e) => n.op[f - 1]! * sizeAt(n, f - 1, { field: fld, v: valueWithEasing(tr.keys, i, e, t) }), (v) => v <= 0.1);
      if (!best || tried.value < best.value) {
        best = { ...tried, at: tr.keys[i]!.t, from: tr.keys[i]!.easing };
        field = fld;
      }
    }
    if (best && field) {
      fix = best.good
        ? `Change the easing of the ${field} key at ${r4(best.at)} s from ${best.from} to ${best.easing}: the last visible frame then shows ${r2(best.value)}.`
        : `Neither replacement easing gets it under 0.1 (best ${best.easing}: ${r2(best.value)}); spread the ${field} move over more frames, or cut later.`;
    }
    this.add({
      ...base,
      rule: "vanish_mid_move",
      severity: "warning",
      ...(field ? { field } : {}),
      detail: `visible extent ${r2(a)} on f${f - 1}, gone on f${f}: it pops off while still moving instead of finishing.`,
      fix,
    });
  }

  popIn(n: NodeM, f: number): void {
    let px = 0;
    let field: string | undefined;
    for (const [fld, tr] of n.tracks) {
      if (!SIZE.test(fld)) continue;
      const p = fieldPx(n, fld, diff(tr.values[f - 1], tr.values[f]));
      if (p > px) {
        px = p;
        field = fld;
      }
    }
    if (px < this.T.stepPx || !field) return;
    const tr = trackOf(n, field)!;
    const t = this.t(f);
    const i = segmentAt(tr.keys, t);
    let fix = `Turn it on where its ${field} move starts, so it grows on screen instead of arriving at ${pct(n.size[f]!)}.`;
    if (i > 0) {
      const tried = this.tryEasings(field, (e) => sizeAt(n, f, { field, v: valueWithEasing(tr.keys, i, e, t) }), (v) => v <= 0.25);
      if (tried.good) fix = `Change the easing of the ${field} key at ${r4(tr.keys[i]!.t)} s from ${tr.keys[i]!.easing} to ${tried.easing}: its first visible frame then shows ${pct(tried.value)}.`;
    }
    this.add({
      rule: "pop_in",
      severity: "warning",
      nodeId: n.id,
      name: n.name,
      field,
      frame: f,
      frames: [f - 1, f],
      detail: `appears on f${f} already at ${pct(n.size[f]!)} of its size (${Math.round(px)} px in one frame) instead of growing in.`,
      fix,
    });
  }

  // ── concentrated_step ─────────────────────────────────────────────────────
  // One frame carrying most of a move: the slit's 53 %, words leaving 108 of
  // 158 px in one frame, the hands' 75 % (journal lines 40, 48) [C-206].

  concentratedStep(): void {
    const { m, T, fps } = this;
    for (const n of this.animated) {
      for (const [field, tr] of n.tracks) {
        if (!(BODY.test(field) || TRIM.test(field))) continue;
        for (const seg of moves(tr, fps, m.last)) {
          if (seg.f1 - seg.f0 < 4) continue;
          const travel = fieldPx(n, field, diff(seg.a.v, seg.b.v));
          if (travel <= 0) continue;
          let best = 0;
          let bf = -1;
          for (let f = seg.f0 + 1; f <= seg.f1; f++) {
            const p = fieldPx(n, field, diff(tr.values[f - 1], tr.values[f]));
            if (p > best) {
              best = p;
              bf = f;
            }
          }
          const share = best / travel;
          if (bf < 0 || share < T.stepShare || best < T.stepPx || !this.inWindow(bf)) continue;
          if (!this.visible(n, bf - 1) || !this.visible(n, bf) || n.blur[bf]! >= 6) continue;
          // A rise into a clipping mask hides its big first step (the mask entry).
          if (TRANSLATION.test(field) && bf === seg.f0 + 1 && arrives(tr.keys, seg.i) && n.parent?.s.clipsContent === true) continue;
          const tried = this.tryEasings(
            field,
            (e) => {
              let worst = 0;
              let prev = valueWithEasing(tr.keys, seg.i, e, seg.f0 / fps);
              for (let f = seg.f0 + 1; f <= seg.f1; f++) {
                const cur = valueWithEasing(tr.keys, seg.i, e, f / fps);
                worst = Math.max(worst, fieldPx(n, field, diff(prev, cur)));
                prev = cur;
              }
              return worst / travel;
            },
            (v) => v < T.stepShare,
          );
          this.add({
            rule: "concentrated_step",
            severity: "warning",
            nodeId: n.id,
            name: n.name,
            field,
            frame: bf,
            frames: [bf - 1, bf],
            detail: `${pct(share)} of a ${seg.f1 - seg.f0}-frame move (${seg.b.easing}) lands in one frame: ${Math.round(best)} of ${Math.round(travel)} px, with blur ${r1(n.blur[bf]!)}.`,
            fix: tried.good
              ? `Change the easing of the key at ${r4(seg.b.t)} s from ${seg.b.easing} to ${tried.easing}: its largest frame then carries ${pct(tried.value)}.`
              : `Spread the move over more frames, or blur its fastest frames (about 5–8 % of the step) [C-243].`,
          });
        }
      }
    }
  }

  // ── strobe ────────────────────────────────────────────────────────────────
  // Large steps without blur strobe: a 280 px edge, the logo flight at 70–110
  // px per frame; even 12–14 px of blur did not cover 402–474 px jumps
  // (journal lines 46, 56) [C-243].

  blurHint(n: NodeM): string {
    const i = n.s.effects?.findIndex((e) => e.type === "LAYER_BLUR") ?? -1;
    const tracked = [...n.tracks.keys()].find((k) => BLUR.test(k));
    if (i >= 0) return `effect:${i}:RADIUS`;
    if (tracked) return tracked;
    return "effect:0:RADIUS (first give it a LAYER_BLUR of radius 0 with figma_set_effects)";
  }

  strobe(): void {
    const { T } = this;
    for (const n of this.animated) {
      if (![...n.tracks.keys()].some((k) => BODY.test(k) || k === "ROTATION")) continue;
      let run: { start: number; end: number; peak: number; sev: Severity } | null = null;
      const flush = () => {
        if (!run) return;
        const step = n.body[run.peak]!;
        const b = n.blur[run.peak]!;
        this.add({
          rule: "strobe",
          severity: run.sev,
          nodeId: n.id,
          name: n.name,
          frame: run.peak,
          frames: [run.start, run.end],
          detail: `moves ${Math.round(step)} px in one frame on f${run.peak} with blur ${r1(b)}${run.end > run.start ? ` (fast from f${run.start} to f${run.end})` : ""}.`,
          fix:
            step >= T.strobeAnyBlurPx
              ? `No blur covers a ${Math.round(step)} px jump: spread the move so no frame moves ${T.strobeAnyBlurPx} px or more.`
              : `Blur the fast frames: ${this.blurHint(n)} peaking at about ${Math.max(1, Math.round(step * 0.065))} on f${run.peak}, back to 0 before it must read sharp [C-243].`,
        });
        run = null;
      };
      for (let f = Math.max(1, this.kFrom); f <= this.kTo; f++) {
        // Judged on screen, and only on frames its own keys move it: a layer
        // carried by a fast parent is the parent's finding.
        const step = n.cut[f] || n.own[f]! < 0.5 ? 0 : n.body[f]!;
        const b = n.blur[f]!;
        const seen = this.visible(n, f - 1) && this.visible(n, f);
        const sev: Severity | null = !seen
          ? null
          : step >= T.strobeAnyBlurPx || (step >= T.strobeWarnPx && b < 2)
            ? "warning"
            : step >= T.strobeInfoPx && b < 2
              ? "info"
              : null;
        if (!sev) {
          flush();
          continue;
        }
        if (!run) run = { start: f, end: f, peak: f, sev };
        run.end = f;
        if (step > n.body[run.peak]!) run.peak = f;
        if (ORDER[sev] < ORDER[run.sev]) run.sev = sev;
      }
      flush();
    }
  }

  // ── blur_off_speed ────────────────────────────────────────────────────────
  // Blur out of phase with speed: a blur peak on f170 against the fastest
  // frame f171; blur that led the motion (journal lines 39, 56) [C-243].

  blurOffSpeed(): void {
    const { m } = this;
    for (const n of this.animated) {
      if (![...n.tracks.keys()].some((k) => BODY.test(k))) continue;
      // Its own speed against its own blur: that is what its blur keys can answer.
      const speed = n.own;
      let f = 1;
      while (f <= m.last) {
        if (n.cut[f] || speed[f]! < this.T.aliveSpeedPx) {
          f++;
          continue;
        }
        const start = f;
        while (f <= m.last && !n.cut[f] && speed[f]! >= this.T.aliveSpeedPx) f++;
        const end = f - 1;
        let fv = -1;
        for (let k = start; k <= end; k++) if (this.visible(n, k - 1) && this.visible(n, k) && (fv < 0 || speed[k]! > speed[fv]!)) fv = k;
        if (fv < 0 || speed[fv]! < 30 || !this.inWindow(fv)) continue;
        // Six visible frames either side of the fastest one.
        const near = [fv];
        for (const dir of [-1, 1]) {
          let count = 0;
          for (let k = fv + dir; k >= 0 && k <= m.last && count < 6; k += dir) {
            if (!this.visible(n, k)) continue;
            near.push(k);
            count++;
          }
        }
        // The layer's own blur: an ancestor's blur belongs to the ancestor's move,
        // and a peak under 2 px is no blur at all (strobe's threshold).
        const blur = n.ownBlur;
        let fb = fv;
        for (const k of near) if (blur[k]! > blur[fb]! || (blur[k]! === blur[fb]! && Math.abs(k - fv) < Math.abs(fb - fv))) fb = k;
        const peak = blur[fb]!;
        if (peak < 2) continue;
        const atFast = blur[fv]!;
        if (atFast >= 0.5 * peak && Math.abs(fb - fv) < 2) continue;
        const step = speed[fv]!;
        const want = Math.max(Math.round(peak), Math.max(1, Math.round(step * 0.065)));
        const where = this.blurHint(n);
        this.add({
          rule: "blur_off_speed",
          severity: "warning",
          nodeId: n.id,
          name: n.name,
          frame: fv,
          frames: [Math.min(fb, fv), Math.max(fb, fv)],
          detail: `its fastest frame f${fv} (${Math.round(step)} px) has blur ${r1(atFast)}, but the blur peaks at ${r1(peak)} on f${fb}: the blur is out of phase with the speed.`,
          fix: `Key ${where} to peak on f${fv}: @${this.t(Math.max(0, fv - 2))} 0 · @${this.t(fv)} ${want} · @${this.t(Math.min(m.last, fv + 2))} 0 (${FIX_EASINGS.soft}).`,
        });
      }
    }
  }

  // ── one_frame_extreme ─────────────────────────────────────────────────────
  // A punch whose peak lasts one frame: "down." at widths 732, 754, 776, 755
  // (journal lines 55, 56) [C-206].

  oneFrameExtreme(): void {
    const { m } = this;
    for (const n of this.animated) {
      for (const [field, tr] of n.tracks) {
        if (!BODY.test(field)) continue;
        const scale = SCALE.test(field) ? n.r : 1;
        for (let f = Math.max(1, this.kFrom); f <= Math.min(m.last - 1, this.kTo); f++) {
          const a = tr.values[f - 1];
          const b = tr.values[f];
          const c = tr.values[f + 1];
          if (!a || !b || !c || n.cut[f] || n.cut[f + 1] || !this.visible(n, f)) continue;
          const hit = b.findIndex((v, k) => {
            const d1 = v - a[k]!;
            const d2 = c[k]! - v;
            const small = Math.min(Math.abs(d1), Math.abs(d2));
            const big = Math.max(Math.abs(d1), Math.abs(d2));
            return d1 * d2 < 0 && small >= 0.5 * big && small * scale >= 2;
          });
          if (hit < 0) continue;
          const fmt = (v: number[]) => v.map((x) => r4(x)).join(",");
          this.add({
            rule: "one_frame_extreme",
            severity: "warning",
            nodeId: n.id,
            name: n.name,
            field,
            frame: f,
            frames: [f - 1, f + 1],
            detail: `${field} goes ${fmt(a)} → ${fmt(b)} → ${fmt(c)} on f${f - 1}–f${f + 1}: the extreme is on screen for one frame, a cusp instead of an accent.`,
            fix: `Hold the extreme for 2–3 frames (repeat its value in a key at ${this.t(f + 2)} s), or ease into and out of it.`,
          });
          f += 1;
        }
      }
    }
  }

  // ── arrival_not_held ──────────────────────────────────────────────────────
  // The match-cut dot on screen for one frame (the round-1 blocker); a 2.6×
  // key never shown (journal lines 39, 40, 55) [C-206].

  arrivalNotHeld(): void {
    const { m, T, fps } = this;
    for (const n of this.animated) {
      for (const [field, tr] of n.tracks) {
        if (!BODY.test(field)) continue;
        for (const seg of moves(tr, fps, m.last)) {
          const fb = seg.f1;
          if (fb - seg.f0 < 3 || fb < 1 || !this.inWindow(fb)) continue;
          const total = fieldPx(n, field, diff(seg.a.v, seg.b.v));
          if (total <= 0) continue;
          const lastStep = fieldPx(n, field, diff(tr.values[fb - 1], tr.values[fb])) / total;
          if (lastStep < 0.25 || !this.visible(n, fb)) continue;
          let held = 0;
          for (let f = fb; f <= m.last; f++) {
            if (!this.visible(n, f) || fieldPx(n, field, diff(tr.values[fb], tr.values[f])) > 0.02 * total) break;
            held++;
          }
          if (held >= T.minHoldFrames) continue;
          const tried = this.tryEasings(
            field,
            (e) => fieldPx(n, field, diff(valueWithEasing(tr.keys, seg.i, e, (fb - 1) / fps), valueWithEasing(tr.keys, seg.i, e, fb / fps))) / total,
            (v) => v < 0.25,
          );
          this.add({
            rule: "arrival_not_held",
            severity: "warning",
            nodeId: n.id,
            name: n.name,
            field,
            frame: fb,
            frames: [fb - 1, fb + Math.max(0, held - 1)],
            detail: `arrives on f${fb} with ${pct(lastStep)} of its travel in the last frame, and the arrived state is on screen ${held} frame${held === 1 ? "" : "s"}.`,
            fix: `Land ${T.minHoldFrames} frames early and hold (the ${seg.b.value} key at ${this.t(Math.max(0, fb - T.minHoldFrames))} s), or decelerate into it${tried.good ? ` (${tried.easing}: ${pct(tried.value)} in the last frame)` : ""}.`,
          });
        }
      }
    }
  }

  // ── dead_span, cold_open ──────────────────────────────────────────────────
  // Stretches where nothing moves: 0.13–0.5 px per frame read as dead; an
  // end-card drift of about 0.2 px per frame read as a freeze; a blank first
  // frame (journal lines 39, 46; inventory §4) [C-206] [C-209].

  /** On each frame, whether any visible layer moves or changes, and the fastest one. */
  alive(): { alive: Uint8Array; fastest: Float64Array; who: Array<NodeM | undefined> } {
    const { m, T } = this;
    const alive = new Uint8Array(m.last + 1);
    const fastest = new Float64Array(m.last + 1);
    const who: Array<NodeM | undefined> = new Array(m.last + 1);
    for (const n of m.nodes) {
      if (n === m.root) continue;
      for (let f = 1; f <= m.last; f++) {
        const seen = Math.max(n.op[f]!, n.op[f - 1]!) >= 0.05;
        if (!seen) continue;
        const move = n.body[f]! + n.draw[f]!;
        if (move > fastest[f]!) {
          fastest[f] = move;
          who[f] = n;
        }
        if (move > T.aliveSpeedPx || Math.abs(n.op[f]! - n.op[f - 1]!) >= 0.02 || n.paint[f]) alive[f] = 1;
      }
    }
    return { alive, fastest, who };
  }

  stillness(): void {
    const { m, T, fps } = this;
    const { alive, fastest, who } = this.alive();
    const root = m.root;
    if (this.on("dead_span")) {
      const held = (f: number) => (this.opts.holds ?? []).some((h) => f >= frameAtOrAfter(h.from, fps) && f <= frameAtOrBefore(h.to, fps));
      const need = Math.max(1, Math.round(T.deadSpanS * fps));
      let start = -1;
      for (let f = Math.max(1, this.kFrom); f <= this.kTo + 1; f++) {
        const dead = f <= this.kTo && !alive[f] && !held(f);
        if (dead && start < 0) start = f;
        if (dead || start < 0) continue;
        const end = f - 1;
        if (end - start + 1 >= need) {
          let top = start;
          for (let k = start; k <= end; k++) if (fastest[k]! > fastest[top]!) top = k;
          const mover = who[top];
          this.add({
            rule: "dead_span",
            severity: "warning",
            nodeId: root.id,
            name: root.name,
            frame: start,
            frames: [start, end],
            detail: `nothing on screen moves faster than ${T.aliveSpeedPx} px per frame on f${start}–f${end} (${r2((end - start + 1) / fps)} s)${mover ? `; the fastest is "${mover.name}" at ${r2(fastest[top]!)} px per frame` : ""}.`,
            fix: "Keep something alive through it (a drift of 2 px per frame or more, or a staggered settle), or pass the span in `holds` if the stillness is the point.",
          });
        }
        start = -1;
      }
    }
    if (this.on("cold_open") && this.kFrom === 0) {
      const shown = m.nodes.filter((n) => n !== root && n.op[0]! * n.size[0]! > 0.02);
      const blank = shown.length === 0 && m.nodes.length > 1;
      const still = m.last >= 3 && !alive[1] && !alive[2] && !alive[3];
      if (blank || still) {
        this.add({
          rule: "cold_open",
          severity: "warning",
          nodeId: root.id,
          name: root.name,
          frame: 0,
          frames: [0, Math.min(3, m.last)],
          detail: blank ? "frame 0 shows only the background: every layer is hidden or at zero size." : "nothing moves in the first 3 frames: the piece opens on a still.",
          fix: "Open on something already on screen and already moving: start the first move at t = 0, or put the first layer in place at frame 0.",
        });
      }
    }
  }

  // ── template_move, no_stagger, stagger_off_grid ───────────────────────────
  // One entry on 15 of 23 layers; whole lines with no stagger; 4.5-frame
  // offsets off the grid (inventory §4) [C-209] [C-242].

  templates(): void {
    const { m, T, fps } = this;
    const animated = this.animated;
    type Entry = { n: NodeM; parent: NodeM; parts: Array<{ key: string; dur: number }> };
    const entries: Entry[] = [];
    type Start = { n: NodeM; t: number };
    const starts = new Map<string, Start[]>();
    for (const n of animated) {
      const parent = groupOf(n, m.root);
      const parts: Array<{ key: string; dur: number }> = [];
      for (const [field, tr] of n.tracks) {
        if (PAINT.test(field)) continue;
        const segs = moves(tr, fps, m.last).filter((s) => Math.round((s.b.t - s.a.t) * fps) >= 3);
        segs.forEach((s, j) => {
          const dir = diff(s.a.v, s.b.v)!.map((x) => (x > 1e-6 ? "+" : x < -1e-6 ? "-" : "0")).join("");
          const dur = Math.round((s.b.t - s.a.t) * fps);
          if (j === 0) parts.push({ key: `${field}${dir}:${s.b.easing}`, dur });
          const sk = `${parent.id}|${field}|${dir}|${dur}|${s.b.easing}`;
          starts.set(sk, [...(starts.get(sk) ?? []), { n, t: s.a.t }]);
        });
      }
      if (parts.length) entries.push({ n, parent, parts: parts.sort((x, y) => (x.key < y.key ? -1 : 1)) });
    }
    if (this.on("template_move")) {
      const groups = new Map<string, Entry[]>();
      for (const e of entries) {
        const k = e.parts.map((p) => p.key).join(" + ");
        groups.set(k, [...(groups.get(k) ?? []), e]);
      }
      for (const [sig, list] of groups) {
        // Durations within one frame of the cluster's first member count as the same move.
        const sorted = [...list].sort((a, b) => a.parts[0]!.dur - b.parts[0]!.dur);
        const clusters: Entry[][] = [];
        for (const e of sorted) {
          const c = clusters[clusters.length - 1];
          if (c && e.parts.every((p, i) => Math.abs(p.dur - c[0]!.parts[i]!.dur) <= 1)) c.push(e);
          else clusters.push([e]);
        }
        for (const c of clusters) {
          const parents = new Set(c.map((e) => e.parent.id));
          const share = c.length / Math.max(1, animated.length);
          // Siblings sharing one move are a stagger: no_stagger's business, not a template.
          if (c.length < 3 || parents.size < 2 || (parents.size < T.templateParents && share < T.templateShare)) continue;
          const first = c[0]!.n;
          this.add(
            {
              rule: "template_move",
              severity: "info",
              nodeId: first.id,
              name: first.name,
              frame: 0,
              detail: `${c.length} layers under ${parents.size} different parents enter with the same move (${sig}, ${c[0]!.parts[0]!.dur} frames): ${c.slice(0, 6).map((e) => `"${e.n.name}"`).join(", ")}${c.length > 6 ? " …" : ""}.`,
              fix: "Give each scene's entry its own motion idea (direction, curve, or what leads); keep a shared move for elements that are one system.",
            },
            true,
          );
        }
      }
    }
    if (!this.on("no_stagger")) return;
    for (const [key, list] of starts) {
      const byFrame = new Map<number, Set<NodeM>>();
      for (const s of list) {
        const k = Math.round(s.t * fps);
        byFrame.set(k, (byFrame.get(k) ?? new Set()).add(s.n));
      }
      const field = key.split("|")[1]!;
      for (const [k, set] of byFrame) {
        if (set.size < 3) continue;
        const names = [...set].map((n) => `"${n.name}"`);
        const first = [...set][0]!;
        this.add({
          rule: "no_stagger",
          severity: "info",
          nodeId: first.id,
          name: first.name,
          field,
          frame: k,
          detail: `${set.size} siblings start the same ${field} move on f${k}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? " …" : ""}. They read as one block.`,
          fix: "Stagger them by 2 frames or more each, in reading order [C-242].",
        });
      }
      // Offsets inside a stagger: whole frames, and 2 frames or more at 30 fps [C-242].
      const times = [...new Set(list.map((s) => r4(s.t)))].sort((a, b) => a - b);
      const min = (2 * fps) / 30;
      const odd: number[] = [];
      let at = -1;
      for (let i = 1; i < times.length; i++) {
        const gap = (times[i]! - times[i - 1]!) * fps;
        if (gap > 12) continue;
        if (Math.abs(gap - Math.round(gap)) > 0.05 || gap < min - 0.05) {
          odd.push(r2(gap));
          if (at < 0) at = Math.round(times[i]! * fps);
        }
      }
      if (odd.length && at >= 0) {
        const first = list.find((s) => Math.round(s.t * fps) === at)?.n ?? list[0]!.n;
        this.add({
          rule: "stagger_off_grid",
          severity: "info",
          nodeId: first.id,
          name: first.name,
          field,
          frame: at,
          detail: `a ${field} stagger steps by ${odd.join(", ")} frame${odd.length === 1 && odd[0] === 1 ? "" : "s"}: offsets that are not whole frames, or under 2 frames at 30 fps, render unevenly.`,
          fix: "Use whole-frame offsets of 2 frames or more (at 30 fps) [C-242].",
        });
      }
    }
  }

  // ── unrendered_extreme, off_grid ──────────────────────────────────────────
  // Keys on half frames; a 2.6× key on a frame never shown (inventory §4;
  // journal line 55). Cut pairs sit between frames on purpose [C-240].

  unrendered(): void {
    const { m, fps } = this;
    for (const n of this.animated) {
      const off: number[] = [];
      for (const [field, tr] of n.tracks) {
        const pairs = new Set(findCutPairs(tr.keys, fps).flatMap((c) => [c.index - 1, c.index]));
        tr.keys.forEach((k, i) => {
          if (pairs.has(i) || k.t > m.durationS + 1e-4) return;
          const offset = gridOffset(k.t, fps);
          const prev = tr.keys[i - 1]?.v;
          const next = tr.keys[i + 1]?.v;
          const extreme = !!(k.v && prev && next) && k.v!.some((v, c) => (v - prev![c]!) * (next![c]! - v) < 0);
          const f = Math.round(k.t * fps);
          if (extreme && offset >= 0.25) {
            this.add({
              rule: "unrendered_extreme",
              severity: "warning",
              nodeId: n.id,
              name: n.name,
              field,
              frame: f,
              detail: `the ${field} extreme ${k.value} at ${r4(k.t)} s sits ${r2(offset)} of a frame off the grid, so no frame shows it.`,
              fix: `Move the key to ${this.t(f)} s, a whole frame.`,
            });
          } else if (extreme && f <= m.last && n.op[f]! < 0.02) {
            this.add({
              rule: "unrendered_extreme",
              severity: "warning",
              nodeId: n.id,
              name: n.name,
              field,
              frame: f,
              detail: `the ${field} extreme ${k.value} lands on f${f}, where the layer is hidden: it is never seen.`,
              fix: "Land the extreme on a frame where the layer is visible, or drop the key.",
            });
          } else if (offset > 0.02) off.push(k.t);
        });
      }
      if (off.length && this.on("off_grid")) {
        const f = Math.round(off[0]! * fps);
        this.add({
          rule: "off_grid",
          severity: "info",
          nodeId: n.id,
          name: n.name,
          frame: Math.min(f, m.last),
          detail: `${off.length} key${off.length === 1 ? "" : "s"} between frames (${off.slice(0, 5).map(r4).join(", ")} s): a frame shows an in-between value, not the key.`,
          fix: `Put keys on whole frames (multiples of ${r4(1 / fps)} s); a jump is a cut pair [C-240].`,
        });
      }
    }
  }

  // ── hold_easing ───────────────────────────────────────────────────────────

  holdEasing(): void {
    const { fps, m } = this;
    for (const n of this.animated) {
      for (const [field, tr] of n.tracks) {
        tr.keys.forEach((k, i) => {
          if (i === 0 || k.info.kind !== "hold") return;
          const f = Math.min(m.last, frameAtOrAfter(k.t, fps));
          const before = tr.keys[i - 1]!.value;
          this.add({
            rule: "hold_easing",
            severity: "info",
            nodeId: n.id,
            name: n.name,
            field,
            frame: f,
            detail: `HOLD into ${k.value} at ${r4(k.t)} s keeps ${before} until the key and steps on f${f} [C-189], a step measured on one probe only; cut pairs are measured at every rate the animatic renders [C-240].`,
            fix: `Use a cut pair: @${cutPairTimes(f, fps)[0]} ${before} LINEAR · @${cutPairTimes(f, fps)[1]} ${k.value} LINEAR switches on f${f} exactly [C-240].`,
          });
        });
      }
    }
  }

  // ── read_time, dimmed_text ────────────────────────────────────────────────
  // Five words in 0.5 s, a list dimmed to 0.35, a CTA readable for 1.63 s
  // (journal line 47; inventory §4). A text reads in max(5/6 s, 0.3 s per
  // word), numbers counting as words [C-241].

  readTime(): void {
    const { m, T, fps } = this;
    const texts = m.nodes.filter((n) => n.s.type === "TEXT" && typeof n.s.characters === "string" && n.s.characters.trim() !== "");
    // Letters set one per layer (kinetic type) read as one word.
    const lines = new Map<NodeM, NodeM[]>();
    for (const n of texts) {
      const g = groupOf(n, m.root);
      lines.set(g, [...(lines.get(g) ?? []), n]);
    }
    const units: Array<{ id: NodeM; members: NodeM[]; text: string }> = [];
    for (const [group, members] of lines) {
      if (members.length > 1 && members.every((n) => n.s.characters!.trim().length <= 1)) {
        units.push({ id: group, members, text: members.map((n) => n.s.characters!.trim()).join("") });
      } else for (const n of members) units.push({ id: n, members: [n], text: n.s.characters! });
    }
    for (const u of units) {
      const shown = (f: number) => u.members.every((n) => n.op[f]! * n.size[f]! > 0.02);
      let ever = false;
      for (let f = this.kFrom; f <= this.kTo && !ever; f++) ever = shown(f);
      if (!ever) continue;
      const need = readNeedS(u.text, T.readSecondsPerWord);
      // Reading adds up across a brief punch, so the frames are counted, not the longest stretch.
      let total = 0;
      let firstRead = -1;
      for (let f = this.kFrom; f <= this.kTo; f++) {
        if (!u.members.every((n) => readable(n, f))) continue;
        total++;
        if (firstRead < 0) firstRead = f;
      }
      const quote = u.text.length > 40 ? `${u.text.slice(0, 40)}…` : u.text;
      if (total / fps + 1e-9 < need) {
        let shownAt = this.kFrom;
        while (shownAt < this.kTo && !shown(shownAt)) shownAt++;
        this.add({
          rule: "read_time",
          severity: "warning",
          nodeId: u.id.id,
          name: u.id.name,
          frame: firstRead >= 0 ? firstRead : shownAt,
          detail: `"${quote}" (${words(u.text)} word${words(u.text) === 1 ? "" : "s"}) is fully readable for ${r2(total / fps)} s in all; it needs ${r2(need)} s.`,
          fix: `Hold it opaque, still and sharp for ${Math.ceil(need * fps)} frames or more, or cut words.`,
        });
      }
      const dim = longestRun(this.kFrom, this.kTo, (f) => u.members.every((n) => n.op[f]! > 0.02 && n.op[f]! <= 0.5 && n.size[f]! >= 0.98));
      if (dim.length / fps >= T.deadSpanS) {
        this.add({
          rule: "dimmed_text",
          severity: "info",
          nodeId: u.id.id,
          name: u.id.name,
          frame: dim.start,
          frames: [dim.start, dim.start + dim.length - 1],
          detail: `"${quote}" sits at opacity 0.5 or less for ${r2(dim.length / fps)} s: it is counted as unreadable there.`,
          fix: "Dim it less (0.6 or more) if it must be read, or let it go.",
        });
      }
    }
  }

  // ── rest_state_hidden ─────────────────────────────────────────────────────
  // Keying can rewrite a layer's base values, so a layer that starts hidden
  // rested at opacity 0 and exported as 1 × 1 [C-204].

  restStateHidden(): void {
    for (const n of this.animated) {
      const opacity = n.tracks.get("OPACITY")?.base?.[0] ?? n.s.opacity ?? 1;
      const scale = ["SCALE_XY", "SCALE_X", "SCALE_Y"].map((k) => n.tracks.get(k)?.base).find((b) => b && b.some((v) => Math.abs(v) < 1e-6));
      if (opacity > 1e-6 && !scale) continue;
      this.add(
        {
          rule: "rest_state_hidden",
          severity: "info",
          nodeId: n.id,
          name: n.name,
          frame: 0,
          detail: `its resting ${opacity <= 1e-6 ? "opacity" : "scale"} is 0, so figma_export_node renders nothing for it.`,
          fix: "Check it with figma_export_video frames, or rest it visible and hide it with keys.",
        },
        true,
      );
    }
  }

  // ── timeline_end ──────────────────────────────────────────────────────────

  timelineEnd(): void {
    const { m } = this;
    for (const n of this.animated) {
      const late = [...n.tracks.values()].flatMap((tr) => tr.keys.filter((k) => k.t > m.durationS + 1e-4).map((k) => `${tr.field} @${k.t}`));
      if (!late.length) continue;
      this.add(
        {
          rule: "timeline_end",
          severity: "info",
          nodeId: n.id,
          name: n.name,
          frame: m.last,
          detail: `${late.length} key${late.length === 1 ? "" : "s"} after the timeline's end (${r4(m.durationS)} s) never play: ${late.slice(0, 4).join(", ")}.`,
          fix: "Lengthen the timeline (figma_set_keyframes timelineDuration) or move the keys inside it.",
        },
        true,
      );
    }
  }

  // ── roundcap_zero_trim ────────────────────────────────────────────────────
  // A round cap at zero length still paints a dot; the run guarded every round
  // stroke with OPACITY (journal line 18; bible §3.10).

  roundcap(): void {
    for (const n of this.animated) {
      if (!/ROUND/i.test(n.s.strokeCap ?? "") || !(n.tracks.has("PATH_TRIM_END") || n.tracks.has("PATH_TRIM_START"))) continue;
      const zero = (f: number) => {
        const te = valueOf(n, "PATH_TRIM_END", f)?.[0] ?? 1;
        const ts = valueOf(n, "PATH_TRIM_START", f)?.[0] ?? 0;
        return te - ts <= 1e-3 && n.op[f]! >= 0.02;
      };
      const run = longestRun(this.kFrom, this.kTo, zero);
      if (!run.length) continue;
      this.add({
        rule: "roundcap_zero_trim",
        severity: "warning",
        nodeId: n.id,
        name: n.name,
        frame: run.start,
        frames: [run.start, run.start + run.length - 1],
        detail: `a round-capped stroke at zero length is visible on f${run.start}${run.length > 1 ? `–f${run.start + run.length - 1}` : ""}: the caps paint a ${n.s.strokeWeight ?? "stroke-wide"} px dot.`,
        fix: "Guard it with OPACITY: 0 while its length is 0, switched on by a cut pair on the frame the draw starts [C-240].",
      });
    }
  }

  // ── brand_late, cta_short ─────────────────────────────────────────────────
  // The brand first seen at 9.1 s of 12, the CTA readable for 1.63 s
  // (inventory §4); the brand belongs in the first 3 s [C-235] [C-241].

  target(id: string | undefined, param: string): NodeM | undefined {
    if (!id) return undefined;
    const n = this.m.byId.get(id);
    if (!n) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${param}\` ${id} is not inside "${this.m.root.name}".`, { hint: "Pass a layer of the audited frame; figma_get_motion_context lists them." });
    return n;
  }

  brandAndCta(): void {
    const { m, fps, opts } = this;
    const brand = this.target(opts.brandId, "brandId");
    if (brand && this.on("brand_late")) {
      const by = opts.brandBy ?? DEFAULT_BRAND_BY_S;
      let first = -1;
      for (let f = 0; f <= m.last && first < 0; f++) if (brand.op[f]! >= 0.95 && brand.size[f]! >= 0.98) first = f;
      if (first < 0 || first / fps > by + 1e-9) {
        this.add(
          {
            rule: "brand_late",
            severity: "warning",
            nodeId: brand.id,
            name: brand.name,
            frame: Math.max(0, first),
            detail: first < 0 ? `"${brand.name}" is never fully visible.` : `"${brand.name}" is first fully visible at ${this.t(first)} s (f${first}); the brief wants it by ${by} s.`,
            fix: `Show the brand fully by ${by} s, even small, and let it grow later [C-235].`,
          },
          true,
        );
      }
    }
    const cta = this.target(opts.ctaId, "ctaId");
    if (cta && this.on("cta_short")) {
      const need = opts.ctaMinS ?? DEFAULT_CTA_MIN_S;
      const run = longestRun(0, m.last, (f) => readable(cta, f));
      if (run.length / fps + 1e-9 < need) {
        this.add(
          {
            rule: "cta_short",
            severity: "warning",
            nodeId: cta.id,
            name: cta.name,
            frame: run.length ? run.start : 0,
            ...(run.length ? { frames: [run.start, run.start + run.length - 1] as [number, number] } : {}),
            detail: `"${cta.name}" is readable for ${r2(run.length / fps)} s at a stretch; a call to action needs ${need} s.`,
            fix: `Land the call to action earlier and hold it still for ${Math.ceil(need * fps)} frames or more [C-241].`,
          },
          true,
        );
      }
    }
  }

  // ── first_key_late ────────────────────────────────────────────────────────
  // Before its first key a track shows the first key's value, never the base
  // [C-191], so a late first key with another value replaces the resting state
  // from frame 0; the run keyed every track at t = 0 (bible §3.11).

  firstKeyLate(): void {
    const { fps } = this;
    for (const n of this.animated) {
      for (const [field, tr] of n.tracks) {
        const first = tr.keys[0]!;
        if (first.t < 0.5 / fps || !first.v) continue;
        const base = tr.base ?? this.restValue(n, field);
        if (!base || base.length !== first.v.length) continue;
        if (first.v.every((v, i) => Math.abs(v - base[i]!) <= 1e-3 * Math.max(1, Math.abs(base[i]!)))) continue;
        this.add(
          {
            rule: "first_key_late",
            severity: "warning",
            nodeId: n.id,
            name: n.name,
            field,
            frame: 0,
            frames: [0, frameAtOrBefore(first.t, fps)],
            detail: `${field} has no key before ${r4(first.t)} s, where it starts at ${first.value} while the layer rests at ${base.map((v) => r4(v)).join(",")}: Figma holds the first key's value before it, so ${first.value} shows from frame 0, not the resting value [C-191].`,
            fix: `Add a key at t = 0 with the value it should show there (${first.value} to start as keyed).`,
          },
          true,
        );
      }
    }
  }

  restValue(n: NodeM, field: string): number[] | null {
    const s = n.s;
    if (field === "OPACITY") return [s.opacity ?? 1];
    if (TRANSLATION.test(field)) return field === "TRANSLATION_XY" ? [0, 0] : [0];
    if (SCALE.test(field)) return field === "SCALE_XY" ? [1, 1] : [1];
    if (field === "WIDTH" && s.width !== undefined) return [s.width];
    if (field === "HEIGHT" && s.height !== undefined) return [s.height];
    if (field === "ROTATION") return [s.rotation ?? 0];
    if (field === "CORNER_RADIUS" && s.cornerRadius !== undefined) return [s.cornerRadius];
    const blur = BLUR.exec(field);
    if (blur) {
      const r = s.effects?.[Number(blur[1])]?.radius;
      return r !== undefined ? [r] : null;
    }
    return null;
  }

  // ── clamped_morph ─────────────────────────────────────────────────────────
  // Corner radius clamps at half the short side, so WIDTH and HEIGHT on
  // different curves render a stadium, not a circle [C-196].

  clampedMorph(): void {
    const { m } = this;
    for (const n of this.animated) {
      const wt = trackOf(n, "WIDTH");
      const ht = trackOf(n, "HEIGHT");
      if (!wt || !ht) continue;
      const same = wt.keys.length === ht.keys.length && wt.keys.every((k, i) => Math.abs(k.t - ht.keys[i]!.t) < 1e-4 && k.easing === ht.keys[i]!.easing);
      if (same) continue;
      const radius = (f: number) => valueOf(n, "CORNER_RADIUS", f)?.[0] ?? n.s.cornerRadius;
      const stadium = (f: number) => {
        const w = Math.abs(valueOf(n, "WIDTH", f)?.[0] ?? 0);
        const h = Math.abs(valueOf(n, "HEIGHT", f)?.[0] ?? 0);
        const r = radius(f);
        return r !== undefined && this.visible(n, f) && r >= Math.min(w, h) / 2 - 0.5 && Math.abs(w - h) > Math.max(2, 0.04 * Math.max(w, h));
      };
      const run = longestRun(this.kFrom, Math.min(this.kTo, m.last), stadium);
      if (!run.length) continue;
      const f = run.start;
      this.add({
        rule: "clamped_morph",
        severity: "info",
        nodeId: n.id,
        name: n.name,
        frame: f,
        frames: [f, f + run.length - 1],
        detail: `WIDTH and HEIGHT move on different curves while the corner radius is at least half the short side: on f${f} it is ${r1(Math.abs(valueOf(n, "WIDTH", f)?.[0] ?? 0))} × ${r1(Math.abs(valueOf(n, "HEIGHT", f)?.[0] ?? 0))}, a stadium rather than a circle [C-196].`,
        fix: "Key WIDTH and HEIGHT with the same times and easing (or animate SCALE) while it must read as round.",
      });
    }
  }
}

// ── census and beats ─────────────────────────────────────────────────────────

function census(a: Audit): AuditResult["census"] {
  const { m, fps } = a;
  const easings: Record<string, number> = {};
  let cutPairs = 0;
  let offGrid = 0;
  const approximated = new Set<string>();
  const overshoot = new Set<NodeM>();
  const eased = new Map<string, number>();
  let easedMoves = 0;
  const linear: Array<{ n: NodeM; field: string; seg: Segment; px: number }> = [];
  for (const n of a.animated) {
    for (const [field, tr] of n.tracks) {
      const pairs = findCutPairs(tr.keys, fps);
      cutPairs += pairs.length;
      const inPair = new Set(pairs.flatMap((c) => [c.index - 1, c.index]));
      tr.keys.forEach((k, i) => {
        if (!inPair.has(i) && gridOffset(k.t, fps) > 0.02) offGrid++;
      });
      for (const seg of moves(tr, fps, m.last)) {
        easings[seg.b.easing] = (easings[seg.b.easing] ?? 0) + 1;
        if (!seg.b.info.exact) approximated.add(seg.b.easing);
        if (seg.b.info.overshoot) overshoot.add(n);
        if (seg.f1 - seg.f0 < 2 || PAINT.test(field)) continue;
        if (seg.b.info.kind !== "linear") {
          eased.set(seg.b.easing, (eased.get(seg.b.easing) ?? 0) + 1);
          easedMoves++;
        } else if (BODY.test(field) && seg.f1 - seg.f0 >= 4) {
          const px = fieldPx(n, field, diff(seg.a.v, seg.b.v));
          // Under 2 px per frame it is a drift, which LINEAR suits.
          if (px < a.T.stepPx || px / (seg.f1 - seg.f0) < 2) continue;
          // An abrupt start or stop is mechanical only where it is seen.
          const fromRest = seg.i === 1 || tr.keys[seg.i - 2]!.value === seg.a.value;
          const toRest = arrives(tr.keys, seg.i);
          if ((fromRest && a.visible(n, seg.f0)) || (toRest && a.visible(n, seg.f1))) linear.push({ n, field, seg, px });
        }
      }
    }
  }
  const root = m.root;
  if (approximated.size) {
    a.limits.add(`easings evaluated approximately: ${[...approximated].join(", ")} [C-190]`);
    a.add(
      {
        rule: "easing_census",
        severity: "info",
        nodeId: root.id,
        name: root.name,
        frame: 0,
        detail: `${[...approximated].join(", ")}: Figma does not publish these curves, so every number that depends on them is approximate [C-190].`,
        fix: "For exact timing use cubic:x1,y1,x2,y2 easings, which evaluate exactly [C-193].",
      },
      true,
    );
  }
  const top = [...eased.entries()].sort((x, y) => y[1] - x[1])[0];
  if (top && easedMoves >= 5 && top[1] / easedMoves >= a.T.oneCurveShare) {
    a.add(
      {
        rule: "easing_census",
        severity: "info",
        nodeId: root.id,
        name: root.name,
        frame: 0,
        detail: `${top[0]} shapes ${top[1]} of ${easedMoves} eased moves (${pct(top[1] / easedMoves)}): every move has the same speed character, so nothing leads.`,
        fix: "Give the hero move its own curve, and let secondary moves follow on gentler ones.",
      },
      true,
    );
  }
  const seenLinear = new Set<NodeM>();
  for (const l of linear) {
    if (seenLinear.has(l.n)) continue;
    seenLinear.add(l.n);
    a.add({
      rule: "easing_census",
      severity: "info",
      nodeId: l.n.id,
      name: l.n.name,
      field: l.field,
      frame: l.seg.f0,
      frames: [l.seg.f0, l.seg.f1],
      detail: `a LINEAR ${l.field} move of ${Math.round(l.px)} px over ${l.seg.f1 - l.seg.f0} frames starts or stops at full speed on screen: it reads as mechanical.`,
      fix: `Ease it (for example ${FIX_EASINGS.soft}), or keep LINEAR for drifts and cut pairs.`,
    });
  }
  if (overshoot.size >= 2) {
    const names = [...overshoot].map((n) => `"${n.name}"`);
    a.add(
      {
        rule: "easing_census",
        severity: "info",
        nodeId: [...overshoot][0]!.id,
        name: [...overshoot][0]!.name,
        frame: 0,
        detail: `${overshoot.size} layers overshoot on a stock back or spring easing: ${names.slice(0, 6).join(", ")}. Stock overshoot reads as a preset.`,
        fix: "Key the overshoot by hand on the one accent that earns it (a key past the target, then a settle).",
      },
      true,
    );
  }
  return { easings, offGrid, cutPairs, approximated: [...approximated] };
}

/** The sorted list's entry nearest t. */
function nearestIn(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const after = sorted[lo]!;
  const before = sorted[lo - 1];
  return before !== undefined && t - before <= after - t ? before : after;
}

/**
 * The music's own beats as a grid over the whole timeline: the given beats,
 * extended at both ends by their median gap, and the eighths between them.
 */
function beatGrid(times: readonly number[], durationS: number): { beats: number[]; eighths: number[]; beatS: number } {
  const sorted = [...times].sort((x, y) => x - y);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!).sort((x, y) => x - y);
  const beatS = gaps.length % 2 ? gaps[gaps.length >> 1]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2;
  const beats = [...sorted];
  for (let t = sorted[0]! - beatS; t > -beatS; t -= beatS) beats.unshift(t);
  for (let t = sorted[sorted.length - 1]! + beatS; t < durationS + beatS; t += beatS) beats.push(t);
  const eighths: number[] = [];
  beats.forEach((t, i) => {
    eighths.push(t);
    if (i + 1 < beats.length) eighths.push((t + beats[i + 1]!) / 2);
  });
  return { beats, eighths, beatS };
}

function beats(a: Audit): AuditResult["beats"] {
  const { m, fps, opts } = a;
  const given = opts.beatTimes && opts.beatTimes.length >= 2 ? beatGrid(opts.beatTimes, m.durationS) : undefined;
  if (opts.bpm === undefined && !given) return undefined;
  const beatS = given ? given.beatS : 60 / opts.bpm!;
  const bpm = given ? r2(60 / beatS) : opts.bpm!;
  const offset = given ? r4(Math.min(...opts.beatTimes!)) : (opts.beatOffset ?? 0);
  const perBar = opts.beatsPerBar ?? 4;
  const framesPerBeat = r4(fps * beatS);
  const T = a.T;
  // The grid of beats and eighths, as frames: from the music's beats when given, else from the tempo.
  const nearest = (f: number) => (given ? Math.round(nearestIn(given.eighths, f / fps) * fps) : nearestGridFrame(f, fps, bpm, offset));
  const beatFrame = (t: number) => {
    const tb = given ? nearestIn(given.beats, t) : offset + Math.round((t - offset) / beatS) * beatS;
    return Math.abs(t - tb) <= 0.5 / fps ? Math.round(tb * fps) : -1;
  };
  const hits: BeatHit[] = [];
  const seen = new Set<string>();
  const hit = (frame: number, n: NodeM, kind: string) => {
    const key = `${n.id}|${frame}|${kind}`;
    if (!a.inWindow(frame) || seen.has(key)) return;
    seen.add(key);
    const nb = nearest(frame);
    const h = { frame, nearestBeat: nb, offsetFrames: frame - nb, nodeId: n.id, kind };
    hits.push(h);
    if (Math.abs(h.offsetFrames) > T.beatToleranceFrames) {
      a.add({
        rule: "beat_offset",
        severity: "info",
        nodeId: n.id,
        name: n.name,
        frame,
        detail: `a ${kind} lands on f${frame}, ${Math.abs(h.offsetFrames)} frames ${h.offsetFrames > 0 ? "after" : "before"} the nearest beat or eighth (f${nb}).`,
        fix: `Move it ${h.offsetFrames > 0 ? "earlier" : "later"} by ${Math.abs(h.offsetFrames)} frame${Math.abs(h.offsetFrames) === 1 ? "" : "s"} (${r4(Math.abs(h.offsetFrames) / fps)} s).`,
      });
    }
  };
  // Accents: punches (a quick swell to a peak), the arrivals of the big
  // shapes, and the cuts that bring a scene on.
  const big = 0.5 * Math.max(m.root.w, m.root.h);
  for (const n of a.animated) {
    for (const [field, tr] of n.tracks) {
      if (SCALE.test(field)) {
        tr.keys.forEach((k, i) => {
          const prev = tr.keys[i - 1];
          const next = tr.keys[i + 1];
          if (!prev || !next || !k.v || !prev.v || !next.v || k.t - prev.t > 0.2 + 1e-6) return;
          if (!k.v.some((v, c) => Math.abs(v) > Math.abs(prev.v![c]!) && Math.abs(v) > Math.abs(next.v![c]!))) return;
          const peak = frameAtOrAfter(k.t, fps);
          hit(peak, n, "punch peak");
          // The beat frame should show the punch; started on the beat it shows rest.
          const bf = beatFrame(prev.t);
          if (bf >= 0 && peak - bf >= 2 && a.inWindow(bf)) {
            a.add({
              rule: "beat_offset",
              severity: "warning",
              nodeId: n.id,
              name: n.name,
              field,
              frame: bf,
              frames: [bf, peak],
              detail: `the punch starts on the beat (f${bf}), so the beat frame shows nothing and its peak lands ${peak - bf} frames late (f${peak}).`,
              fix: `Start it ${peak - bf} frames earlier so the peak lands on f${bf}: move its keys by −${r4((peak - bf) / fps)} s.`,
            });
          }
        });
      }
      if (BODY.test(field) && Math.max(n.w, n.h) >= big) {
        for (const seg of moves(tr, fps, m.last)) {
          const travel = fieldPx(n, field, diff(seg.a.v, seg.b.v));
          if (!arrives(tr.keys, seg.i) || travel < T.stepPx) continue;
          // The eye lands a move when most of it is done, not at its last key.
          let landed = seg.f1;
          for (let f = seg.f0 + 1; f <= seg.f1; f++) {
            if (fieldPx(n, field, diff(seg.a.v, tr.values[f])) >= 0.9 * travel) {
              landed = f;
              break;
            }
          }
          hit(landed, n, "large arrival");
        }
      }
    }
  }
  // Scenes: the root's children switched by opacity.
  const scenes: NonNullable<AuditResult["beats"]>["scenes"] = [];
  for (const c of m.root.kids) {
    if (!c.tracks.has("OPACITY")) continue;
    const keys = c.tracks.get("OPACITY")!.keys;
    for (const cp of findCutPairs(keys, fps)) if ((keys[cp.index]!.v?.[0] ?? 0) > (keys[cp.index - 1]!.v?.[0] ?? 0)) hit(cp.frame, c, "scene cut");
    let start = -1;
    for (let f = 0; f <= m.last + 1; f++) {
      const on = f <= m.last && c.op[f]! >= 0.5;
      if (on && start < 0) start = f;
      if (!on && start >= 0) {
        scenes.push({ nodeId: c.id, name: c.name, from: start, to: f - 1, beats: r2((f - start) / fps / beatS) });
        start = -1;
      }
    }
  }
  hits.sort((x, y) => x.frame - y.frame);
  if (given) {
    const ignored = [...(opts.bpm !== undefined ? ["`bpm`"] : []), ...(opts.beatOffset !== undefined ? ["`beatOffset`"] : [])];
    return {
      source: "beatTimes",
      bpm,
      beatOffset: offset,
      beatsPerBar: perBar,
      framesPerBeat,
      beatCount: opts.beatTimes!.length,
      hits,
      scenes,
      note:
        `Accents are checked against the ${opts.beatTimes!.length} given beats and the eighths between them, extended past the first and last by their median gap (${r4(beatS)} s, about ${bpm} BPM).` +
        (ignored.length ? ` ${ignored.join(" and ")} ${ignored.length > 1 ? "were" : "was"} not used: \`beatTimes\` replaces that grid.` : ""),
    };
  }
  const whole = Math.abs(framesPerBeat - Math.round(framesPerBeat)) < 1e-6;
  return {
    source: "bpm",
    bpm,
    beatOffset: offset,
    beatsPerBar: perBar,
    framesPerBeat,
    hits,
    scenes,
    ...(!whole
      ? { note: `At ${fps} fps, ${bpm} BPM puts beats between frames (${framesPerBeat} frames per beat); a tempo where fps × 60 / BPM is a whole number keeps every beat on a frame [C-244].` }
      : {}),
  };
}

// ── the moments a sound designer marks ───────────────────────────────────────
// figma_generate_audio derives its cues from these (src/server/audio-cues.ts):
// the same per-frame model the rules judge, read for moves, cuts and text.

export interface SoundMove {
  nodeId: string;
  name: string;
  field: string;
  /** The move's first and last frames. */
  f0: number;
  f1: number;
  travelPx: number;
  /** The largest step between two frames, px. */
  peakPx: number;
  /** The layer's centre across the frame, 0 (left) to 1 (right), from its rest box. */
  x: number;
}

export interface SoundCut {
  nodeId: string;
  name: string;
  frame: number;
  /** A child of the frame switched on: a new scene. */
  scene: boolean;
}

export interface SoundAppear {
  nodeId: string;
  name: string;
  frame: number;
  words: number;
  text: string;
  x: number;
}

export interface SoundEvents {
  fps: number;
  durationS: number;
  width: number;
  height: number;
  moves: SoundMove[];
  cuts: SoundCut[];
  appears: SoundAppear[];
}

const CONTAINER = /^(FRAME|GROUP|COMPONENT|INSTANCE|SECTION)$/;

/** Every move, cut and text entrance of an animated frame, frame-exact at `fps`. */
export function soundEvents(snapshot: MotionSnapshot, fps = 30): SoundEvents {
  const m = buildModel(snapshot, fps);
  const W = m.root.w;
  const H = m.root.h;
  const across = (n: NodeM) => {
    let x = n.w / 2;
    for (let p: NodeM | null = n; p && p !== m.root; p = p.parent) x += p.s.x ?? 0;
    return W > 0 ? Math.min(1, Math.max(0, x / W)) : 0.5;
  };
  const found: SoundMove[] = [];
  const cuts = new Map<number, SoundCut>();
  const cut = (c: SoundCut) => {
    const had = cuts.get(c.frame);
    if (!had || (c.scene && !had.scene)) cuts.set(c.frame, c);
  };
  const big = 0.5 * Math.max(W, H);
  for (const n of m.nodes) {
    if (n === m.root || n.tracks.size === 0) continue;
    for (const [field, tr] of n.tracks) {
      if (BODY.test(field) || field === "ROTATION") {
        for (const seg of moves(tr, fps, m.last)) {
          let seen = false;
          for (let f = seg.f0; f <= seg.f1 && !seen; f++) seen = n.op[f]! >= 0.2;
          const travel = fieldPx(n, field, diff(seg.a.v, seg.b.v));
          if (!seen || travel < 1) continue;
          let peak = 0;
          for (let f = seg.f0 + 1; f <= seg.f1; f++) peak = Math.max(peak, fieldPx(n, field, diff(tr.values[f - 1], tr.values[f])));
          found.push({ nodeId: n.id, name: n.name, field, f0: seg.f0, f1: seg.f1, travelPx: r1(travel), peakPx: r1(peak), x: r2(across(n)) });
        }
      }
      // A cut: a scene (a container directly in the frame) switched on, or a large layer switched on or moved in one frame.
      const scene = n.parent === m.root && CONTAINER.test(n.s.type);
      const large = Math.max(n.w, n.h) >= big;
      if (field === "OPACITY" && (scene || large)) {
        for (const cp of findCutPairs(tr.keys, fps)) {
          if (cp.frame <= m.last && (tr.keys[cp.index]!.v?.[0] ?? 0) > (tr.keys[cp.index - 1]!.v?.[0] ?? 0)) cut({ nodeId: n.id, name: n.name, frame: cp.frame, scene });
        }
      } else if (large && GEOMETRY.test(field)) {
        for (const cp of findCutPairs(tr.keys, fps)) if (cp.frame <= m.last && n.op[cp.frame]! >= 0.5) cut({ nodeId: n.id, name: n.name, frame: cp.frame, scene: false });
      }
    }
  }
  const appears: SoundAppear[] = [];
  for (const n of m.nodes) {
    if (n.s.type !== "TEXT") continue;
    const seen = (f: number) => n.op[f]! * (n.size[f]! >= 0.5 ? 1 : 0);
    for (let f = 1; f <= m.last; f++) {
      if (seen(f - 1) < 0.5 && seen(f) >= 0.5) {
        const text = (n.s.characters ?? n.name).replace(/\s+/g, " ").trim();
        appears.push({ nodeId: n.id, name: n.name, frame: f, words: words(text), text: text.slice(0, 40), x: r2(across(n)) });
      }
    }
  }
  found.sort((a, b) => a.f0 - b.f0 || a.name.localeCompare(b.name));
  appears.sort((a, b) => a.frame - b.frame || a.name.localeCompare(b.name));
  return { fps, durationS: m.durationS, width: W, height: H, moves: found, cuts: [...cuts.values()].sort((a, b) => a.frame - b.frame), appears };
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Whether a plan's `accept` entry covers an issue: the same rule, or the rule
 * it is a narrower name of, and every frame of the issue inside the entry's
 * window. An error is never accepted.
 */
function covers(a: MotionPlanAccept, i: MotionIssue, fps: number): boolean {
  if (i.severity === "error" || (a.rule !== i.rule && a.rule !== VARIANTS[i.rule])) return false;
  const [f0, f1] = i.frames ?? [i.frame, i.frame];
  return (a.from === undefined || f0 >= frameAtOrAfter(a.from, fps)) && (a.to === undefined || f1 <= frameAtOrBefore(a.to, fps));
}

/** Judge a snapshot. Throws INVALID_PARAM only for a brandId or ctaId outside the frame. */
export function auditMotion(snapshot: MotionSnapshot, opts: AuditOptions = {}): AuditResult {
  const fps = opts.fps ?? 30;
  const T: Thresholds = { ...DEFAULT_THRESHOLDS, ...Object.fromEntries(Object.entries(opts.thresholds ?? {}).filter(([, v]) => typeof v === "number")) };
  const m = buildModel(snapshot, fps);
  const asked = opts.rules && opts.rules.length ? opts.rules : RULE_IDS;
  const selected = new Set<string>(asked.map((r) => VARIANTS[r] ?? r));
  const audit = new Audit(m, T, opts, selected);
  const tracks = m.nodes.reduce((s, n) => s + n.tracks.size, 0);
  // A frame with no keys has no motion to judge: a still opening is not a finding there.
  if (tracks > 0) audit.run();
  const cen = census(audit);
  const bt = selected.has("beat_offset") && tracks > 0 ? beats(audit) : undefined;

  const limits = [...audit.limits];
  if (m.nodes.some((n) => [...n.tracks.values()].some((tr) => tr.keys.some((k) => k.info.kind === "hold")))) limits.push("HOLD is evaluated as keeping the old value until its key and stepping on the frame at it, measured on one probe at 24 and 30 fps [C-189]");
  limits.push(
    "a track is held at its first key's value before that key, measured on one probe at 24 and 30 fps [C-191]",
    "layout over time is not checked: a box read inside an animated frame gives the base values, not the state at the playhead [C-192]",
    "a layer covered by another layer is not detected",
  );
  if (m.nodes.some((n) => (n.s.animationStyles ?? 0) > 0)) limits.push("animation styles are listed, not evaluated");

  const min = opts.minSeverity ?? "info";
  const sorted = audit.issues.sort((x, y) => ORDER[x.severity] - ORDER[y.severity] || x.frame - y.frame || x.name.localeCompare(y.name));
  // What the plan declares intended is listed apart, with its reason, and counts against nothing.
  const accepted: Array<MotionIssue & { reason: string }> = [];
  const issues: MotionIssue[] = [];
  for (const i of sorted) {
    const by = (opts.accept ?? []).find((a) => covers(a, i, fps));
    if (by) accepted.push({ ...i, reason: by.reason });
    else issues.push(i);
  }
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const shown = issues.filter((i) => ORDER[i.severity] <= ORDER[min]);
  const limit = opts.limit ?? 100;
  const keys = m.nodes.reduce((s, n) => s + [...n.tracks.values()].reduce((k, tr) => k + tr.keys.length, 0), 0);
  let activity: number[] | undefined;
  if (opts.includeActivity) {
    const { fastest } = audit.alive();
    activity = [...fastest].map((v) => r1(v));
  }
  return {
    root: { id: m.root.id, name: m.root.name, durationS: r4(m.durationS) },
    fps,
    expectedFrames: expectedFrames(m.durationS, fps),
    ...(opts.from !== undefined || opts.to !== undefined ? { window: { from: audit.kFrom, to: audit.kTo } } : {}),
    checked: { layers: Math.max(0, m.nodes.length - 1), tracks, keys },
    ok: counts.error === 0 && counts.warning === 0,
    counts,
    issues: shown.slice(0, limit),
    ...(shown.length > limit ? { more: shown.length - limit } : {}),
    census: cen,
    ...(bt ? { beats: bt } : {}),
    ...(activity ? { activity } : {}),
    ...(snapshot.truncated ? { truncated: true } : {}),
    ...(tracks === 0
      ? { note: "Nothing in this frame has keyframes; figma_set_keyframes animates its layers." }
      : snapshot.truncated
        ? { note: `Only the first ${snapshot.maxNodes} layers were read (maxNodes); later layers were not judged.` }
        : {}),
    limits,
    ...(accepted.length ? { accepted: accepted.slice(0, limit) } : {}),
    ...(accepted.length > limit ? { acceptedMore: accepted.length - limit } : {}),
  };
}
