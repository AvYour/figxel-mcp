// Per-frame picture metrics for figma_review_video — pure, no I/O.
//
// One decode pass hands every frame here as 8-bit grey, 270 px wide: the scale
// the 2026-10-09 critics took their numbers at, so the defaults carry over
// [C-247]. Per frame k:
//   diff[k]     mean |Y(k) − Y(k−1)|, 0–255
//   changed[k]  share of pixels with |ΔY| > 8
//   luma[k]     mean Y
//   skip[k]     mean |Y(k+1) − Y(k−1)| — how far apart a frame's two neighbours are
// Three frames are held at a time, so a long video costs no memory.

export const ANALYSIS_WIDTH = 270;

export interface Thresholds {
  /** A frame whose diff is below this shows no motion. */
  freeze: number;
  /** A still stretch this long (s) or longer is a freeze. */
  minFreezeS: number;
  /** A frame that differs from both neighbours by this much, while they match each other, flickers. */
  flicker: number;
  /** A whole-frame luma jump this large (of 255), with nearly every pixel changing, is a flash. */
  flashLuma: number;
  /** A single-frame mean change this large, on part of the picture, is a spike. */
  spike: number;
}

/** The run's calibration [C-247]. */
export const DEFAULT_THRESHOLDS: Thresholds = { freeze: 0.15, minFreezeS: 0.5, flicker: 1.0, flashLuma: 40, spike: 20 };

/** A pixel "changed" past this grey step; below it is codec noise. */
const CHANGED_DELTA = 8;
/** At or above this share of changed pixels the whole picture changed: a flash or a cut, not a spike. */
const WHOLE_FRAME = 0.9;
/** A flicker's neighbours sit this close, relative to the frame's own step. */
const FLICKER_SKIP = 0.35;

export interface Series {
  diff: number[];
  changed: number[];
  luma: number[];
  skip: number[];
}

/** Feed frames in order; read `series` at the end. */
export class FrameMeter {
  readonly series: Series = { diff: [], changed: [], luma: [], skip: [] };
  private prev: Uint8Array | null = null;
  private prev2: Uint8Array | null = null;

  constructor(readonly frameBytes: number) {}

  /** `frame` is kept until two more arrive: pass a buffer the caller does not reuse. */
  push(frame: Uint8Array): void {
    if (frame.length !== this.frameBytes) throw new Error(`a frame of ${frame.length} bytes; expected ${this.frameBytes}`);
    const n = frame.length;
    const s = this.series;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frame[i]!;
    s.luma.push(sum / n);
    const prev = this.prev;
    if (prev) {
      let d = 0;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const delta = Math.abs(frame[i]! - prev[i]!);
        d += delta;
        if (delta > CHANGED_DELTA) c++;
      }
      s.diff.push(d / n);
      s.changed.push(c / n);
    } else {
      s.diff.push(0);
      s.changed.push(0);
    }
    const prev2 = this.prev2;
    if (prev2) {
      let d = 0;
      for (let i = 0; i < n; i++) d += Math.abs(frame[i]! - prev2[i]!);
      s.skip[s.luma.length - 2] = d / n;
    }
    this.prev2 = prev;
    this.prev = frame;
  }
}

export interface Freeze {
  from: number;
  to: number;
  s: number;
  meanDiff: number;
}

export interface MetricsReport {
  analysisWidth: number;
  diff: number[];
  summary: { mean: number; p95: number; max: number; maxFrame: number };
  freezes: Freeze[];
  flickers: Array<{ frame: number; diff: number; skip: number }>;
  flashes: Array<{ frame: number; lumaJump: number; changed: number }>;
  spikes: Array<{ frame: number; diff: number; changed: number }>;
  cuts: Array<{ frame: number; diff: number; declared: boolean }>;
}

export interface Finding {
  kind: string;
  severity: "warning" | "info";
  frames: number[];
  detail: string;
}

export interface AnalyseOptions {
  fps: number;
  /** Frames where a cut is meant: a jump there is the cut, not a defect. */
  cuts?: readonly number[];
  /** Intended holds, as inclusive frame ranges: never a freeze. */
  holds?: ReadonlyArray<{ fromFrame: number; toFrame: number }>;
  thresholds?: Partial<Thresholds>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (share: number) => Math.round(share * 100);

/** Judge a series: freezes, flickers, flashes, spikes and cuts, each with a finding an agent can act on. */
export function analyse(series: Series, opts: AnalyseOptions): { metrics: MetricsReport; findings: Finding[] } {
  const t = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const { diff, changed, luma, skip } = series;
  const n = luma.length;
  const findings: Finding[] = [];
  const declared = new Set<number>();
  for (const k of opts.cuts ?? []) {
    if (k >= 1 && k < n) declared.add(k);
    else findings.push({ kind: "cut_outside", severity: "info", frames: [k], detail: `cut frame ${k} is outside the video's frames 1–${n - 1}; ignored.` });
  }
  const holds = opts.holds ?? [];
  // The step into frame k is part of a hold when both of its frames are.
  const held = (k: number) => holds.some((h) => k - 1 >= h.fromFrame && k <= h.toFrame);

  // ── summary ──
  const steps = diff.slice(1);
  let max = 0;
  let maxFrame = 0;
  for (let k = 1; k < n; k++) {
    if (diff[k]! > max) {
      max = diff[k]!;
      maxFrame = k;
    }
  }
  const sorted = [...steps].sort((a, b) => a - b);
  const summary = {
    mean: steps.length ? r2(steps.reduce((a, b) => a + b, 0) / steps.length) : 0,
    p95: sorted.length ? r2(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!) : 0,
    max: r2(max),
    maxFrame,
  };

  // ── freezes: runs of still steps, outside holds ──
  const freezes: Freeze[] = [];
  let runStart = -1;
  for (let k = 1; k <= n; k++) {
    const still = k < n && diff[k]! < t.freeze && !held(k);
    if (still && runStart < 0) runStart = k;
    if (!still && runStart >= 0) {
      const from = runStart - 1;
      const to = k - 1;
      const s = (to - from + 1) / opts.fps;
      if (s >= t.minFreezeS - 1e-9) {
        const run = diff.slice(runStart, k);
        freezes.push({ from, to, s: r2(s), meanDiff: r2(run.reduce((a, b) => a + b, 0) / run.length) });
      }
      runStart = -1;
    }
  }
  for (const f of freezes) {
    findings.push({
      kind: "freeze",
      severity: "warning",
      frames: [f.from, f.to],
      detail: `frames ${f.from}–${f.to} (${f.s} s) barely change (mean diff ${f.meanDiff}): a still picture past ${t.minFreezeS} s reads as a stall. Give it a drift, or list it in \`holds\` if it is meant.`,
    });
  }

  // ── declared cuts first: where each one really lands ──
  // A cut that lands a frame off is reported once, as that; its real frame is
  // then not a second finding as a flash or a spike.
  const cuts: MetricsReport["cuts"] = [];
  const exempt = new Set(declared);
  for (const k of [...declared].sort((a, b) => a - b)) {
    cuts.push({ frame: k, diff: r2(diff[k]!), declared: true });
    // A neighbour that is itself a declared cut is not where this one slipped to.
    const before = k - 1 >= 1 && !declared.has(k - 1) ? diff[k - 1]! : -1;
    const after = k + 1 < n && !declared.has(k + 1) ? diff[k + 1]! : -1;
    const j = after > before ? k + 1 : k - 1;
    const dj = Math.max(before, after);
    if (dj > diff[k]!) {
      exempt.add(j);
      findings.push({
        kind: "cut_off_frame",
        severity: "warning",
        frames: [k, j],
        detail: `the cut declared on frame ${k} changes less (${r2(diff[k]!)}) than frame ${j} (${r2(dj)}): it lands one frame ${j < k ? "early" : "late"}.`,
      });
    }
  }

  // ── flashes: the whole picture jumps in brightness on a frame that is not a cut ──
  const flashes: MetricsReport["flashes"] = [];
  const flashFrames = new Set<number>();
  let last: { frame: number; up: boolean } | undefined;
  for (let k = 1; k < n; k++) {
    if (exempt.has(k)) continue;
    const jump = luma[k]! - luma[k - 1]!;
    if (Math.abs(jump) < t.flashLuma || changed[k]! < WHOLE_FRAME) continue;
    // A one-frame flash comes back on the next frame: one event, not two.
    if (last && last.frame === k - 1 && last.up !== (jump > 0)) {
      last = undefined;
      flashFrames.add(k);
      continue;
    }
    last = { frame: k, up: jump > 0 };
    flashFrames.add(k);
    flashes.push({ frame: k, lumaJump: Math.round(jump * 10) / 10, changed: r3(changed[k]!) });
    findings.push({
      kind: "flash",
      severity: "warning",
      frames: [k - 1, k],
      detail: `the whole picture ${jump > 0 ? "brightens" : "darkens"} by ${Math.round(Math.abs(jump))}/255 with ${pct(changed[k]!)} % of pixels changing on a frame not listed in \`cuts\`: it reads as a blink. Carry the picture's mass across the change, or declare the cut.`,
    });
  }

  // ── spikes: one frame moves much more than motion should, on part of the picture ──
  const spikes: MetricsReport["spikes"] = [];
  for (let k = 1; k < n; k++) {
    if (exempt.has(k) || diff[k]! < t.spike || changed[k]! >= WHOLE_FRAME) continue;
    spikes.push({ frame: k, diff: r2(diff[k]!), changed: r3(changed[k]!) });
    findings.push({
      kind: "spike",
      severity: "warning",
      frames: [k - 1, k],
      detail: `frame ${k} changes ${r2(diff[k]!)}/255 on average (${pct(changed[k]!)} % of pixels) in one step: that reads as a jump, not motion. Spread it over more frames or blur it, or declare the cut.`,
    });
  }

  // ── flickers: a frame unlike both neighbours, which match each other ──
  const flickers: MetricsReport["flickers"] = [];
  for (let k = 1; k < n - 1; k++) {
    const a = diff[k]!;
    const b = diff[k + 1]!;
    const sk = skip[k];
    if (sk === undefined || a < t.flicker || b < t.flicker || sk > FLICKER_SKIP * Math.min(a, b)) continue;
    if (flashFrames.has(k) || (declared.has(k) && declared.has(k + 1))) continue;
    flickers.push({ frame: k, diff: r2(Math.min(a, b)), skip: r2(sk) });
    findings.push({
      kind: "flicker",
      severity: "warning",
      frames: [k - 1, k + 1],
      detail: `frame ${k} differs from both neighbours (${r2(a)}, ${r2(b)}) while they match each other (${r2(sk)}): a state on screen for one frame reads as a glitch. Hold it for 3 frames or more, or take it out.`,
    });
  }

  // ── hard changes of the whole picture nobody declared ──
  for (let k = 1; k < n; k++) {
    if (exempt.has(k) || flashFrames.has(k) || diff[k]! < t.spike || changed[k]! < WHOLE_FRAME) continue;
    cuts.push({ frame: k, diff: r2(diff[k]!), declared: false });
    findings.push({
      kind: "undeclared_cut",
      severity: "info",
      frames: [k - 1, k],
      detail: `a hard change on frame ${k} (diff ${r2(diff[k]!)}, ${pct(changed[k]!)} % of pixels) is not listed in \`cuts\`; list it if it is meant.`,
    });
  }
  cuts.sort((a, b) => a.frame - b.frame);

  return {
    metrics: { analysisWidth: ANALYSIS_WIDTH, diff: diff.map(r2), summary, freezes, flickers, flashes, spikes, cuts },
    findings,
  };
}

/** The grey frame height for the analysis width: even, from the video's aspect ratio. */
export function analysisHeight(width: number, height: number): number {
  return Math.max(2, 2 * Math.round((ANALYSIS_WIDTH * height) / width / 2));
}
