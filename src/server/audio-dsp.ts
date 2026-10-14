// The building blocks figma_generate_audio synthesizes with: a seeded random
// source, oscillators, noise, envelopes, biquad filters, a small reverb, a pan
// law and a look-ahead limiter. Pure TypeScript on Float32Array buffers, no
// dependency and no I/O, so every sound is the same bytes for the same seed.

export const SAMPLE_RATE = 48_000;

/** Two channels of float samples, nominally in −1…1. */
export interface Stereo {
  l: Float32Array;
  r: Float32Array;
}

export const stereo = (frames: number): Stereo => ({ l: new Float32Array(frames), r: new Float32Array(frames) });

// ── randomness ───────────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator, 0 ≤ x < 1. The same seed gives the same stream on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seed for one voice, from the piece's seed and a label: every voice draws
 * its own stream, so adding a cue never changes the noise of the bed.
 */
export function subSeed(seed: number, label: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Pink-ish noise: white noise through three one-pole sections (a light, cheap approximation). */
export function pinkNoise(random: () => number): () => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const w = random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.2;
  };
}

// ── oscillators and envelopes ────────────────────────────────────────────────

/** The correction that takes the aliasing step out of a sawtooth (polyBLEP): t is the phase 0–1, dt the step per sample. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A band-limited sawtooth: call with the frequency of each sample. */
export function sawOsc(phase0 = 0): (freq: number) => number {
  let phase = phase0 - Math.floor(phase0);
  return (freq: number) => {
    const dt = freq / SAMPLE_RATE;
    const v = 2 * phase - 1 - polyBlep(phase, dt);
    phase += dt;
    if (phase >= 1) phase -= 1;
    return v;
  };
}

/** A sine whose frequency may change every sample; phase0 in cycles (0.25 starts at the peak). */
export function sineOsc(phase0 = 0): (freq: number) => number {
  let phase = phase0;
  return (freq: number) => {
    const v = Math.sin(2 * Math.PI * phase);
    phase += freq / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    return v;
  };
}

/**
 * An ADSR envelope's value `t` s after note-on, for a note held `hold` s.
 * The attack starts above zero, so the first sample of a note already sounds.
 */
export function adsr(t: number, attack: number, decay: number, sustain: number, release: number, hold: number): number {
  const level = (x: number): number => {
    if (x < 0) return 0;
    if (x < attack) return Math.max(x / attack, 1 / Math.max(1, attack * SAMPLE_RATE));
    const d = x - attack;
    return decay > 0 ? sustain + (1 - sustain) * Math.exp((-5 * d) / decay) : sustain;
  };
  if (t < hold) return level(t);
  const r = t - hold;
  return release > 0 && r < release ? level(hold) * (1 - r / release) : 0;
}

/** Midi note number to Hz (A4 = 69 = 440 Hz). */
export const midiHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** Equal-power gains for a pan of −1 (left) … 1 (right). */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : Number.NEGATIVE_INFINITY);

// ── filters ──────────────────────────────────────────────────────────────────

export type FilterKind = "lowpass" | "highpass" | "bandpass";

/**
 * A second-order section in direct form I, with the coefficients of the
 * common audio-EQ formulas. `set` may be called while it runs: a sweep
 * re-tunes it every few samples without resetting its state.
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(kind?: FilterKind, freq?: number, q?: number) {
    if (kind && freq !== undefined) this.set(kind, freq, q ?? Math.SQRT1_2);
  }

  set(kind: FilterKind, freq: number, q = Math.SQRT1_2): this {
    const f = Math.min(Math.max(freq, 10), SAMPLE_RATE * 0.45);
    const w0 = (2 * Math.PI * f) / SAMPLE_RATE;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(q, 0.05));
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (kind === "lowpass") {
      b1 = 1 - cos;
      b0 = b1 / 2;
      b2 = b0;
    } else if (kind === "highpass") {
      b1 = -(1 + cos);
      b0 = (1 + cos) / 2;
      b2 = b0;
    } else {
      // Band-pass with 0 dB at the centre.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// ── reverb ───────────────────────────────────────────────────────────────────

/** A feedback comb with a damped loop (the Schroeder and Moorer building block). */
class Comb {
  private readonly buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(size: number, private readonly feedback: number, private readonly damp: number) {
    this.buf = new Float32Array(size);
  }
  process(x: number): number {
    const y = this.buf[this.i]!;
    this.store = y * (1 - this.damp) + this.store * this.damp;
    this.buf[this.i] = x + this.store * this.feedback;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  process(x: number): number {
    const b = this.buf[this.i]!;
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

// Mutually prime delay lengths in samples at 48 kHz, a little longer on the right for width.
const COMBS = [1213, 1291, 1389, 1475, 1547, 1621];
const ALLPASSES = [605, 480, 371];
const SPREAD = 25;

/**
 * A small Schroeder reverb: parallel damped combs into series allpasses, one
 * network per channel. Returns only the wet signal, as long as the input plus
 * the tail (`tailS`); the caller mixes it in at the level it wants.
 */
export function reverb(input: Stereo, opts: { size?: number; damp?: number; tailS?: number } = {}): Stereo {
  const feedback = 0.7 + 0.26 * Math.min(1, Math.max(0, opts.size ?? 0.6));
  const damp = Math.min(0.9, Math.max(0, opts.damp ?? 0.35));
  const frames = input.l.length + Math.round((opts.tailS ?? 0) * SAMPLE_RATE);
  const out = stereo(frames);
  for (const [src, dst, extra] of [
    [input.l, out.l, 0],
    [input.r, out.r, SPREAD],
  ] as const) {
    const combs = COMBS.map((n) => new Comb(n + extra, feedback, damp));
    const aps = ALLPASSES.map((n) => new Allpass(n + extra));
    for (let i = 0; i < frames; i++) {
      const x = i < src.length ? src[i]! * 0.12 : 0;
      let s = 0;
      for (const c of combs) s += c.process(x);
      for (const a of aps) s = a.process(s);
      dst[i] = s;
    }
  }
  return out;
}

// ── dynamics ─────────────────────────────────────────────────────────────────

/**
 * A look-ahead peak limiter, applied offline with no delay: the gain each
 * sample needs is spread back over `lookahead` samples so it is already down
 * when the peak arrives, and recovers over `release` samples. No sample ends
 * above `ceiling` (linear). Returns the deepest gain reduction, in dB.
 */
export function limit(buf: Stereo, ceiling: number, lookahead = Math.round(0.005 * SAMPLE_RATE), release = Math.round(0.08 * SAMPLE_RATE)): number {
  const n = buf.l.length;
  if (n === 0) return 0;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(buf.l[i]!), Math.abs(buf.r[i]!));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // The smallest need ahead: a sliding-window minimum over [i, i + lookahead].
  const ahead = new Float32Array(n);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[q[tail - 1]!]! >= need[i]!) tail--;
    q[tail++] = i;
    while (q[head]! > i + lookahead) head++;
    ahead[i] = need[q[head]!]!;
  }
  // A ramp down before each dip instead of a step, then a smooth recovery.
  const step = 1 / Math.max(1, lookahead);
  for (let i = n - 2; i >= 0; i--) ahead[i] = Math.min(ahead[i]!, ahead[i + 1]! + step);
  const rel = 1 - Math.exp(-1 / Math.max(1, release));
  let g = ahead[0]!;
  let deepest = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(ahead[i]!, g + (1 - g) * rel);
    if (g < deepest) deepest = g;
    buf.l[i] = buf.l[i]! * g;
    buf.r[i] = buf.r[i]! * g;
  }
  return gainToDb(deepest);
}

/** Multiply both channels by `gain`. */
export function scale(buf: Stereo, gain: number): void {
  for (let i = 0; i < buf.l.length; i++) {
    buf.l[i] = buf.l[i]! * gain;
    buf.r[i] = buf.r[i]! * gain;
  }
}

/** Add `src` into `dst` from frame `at`, times `gain`; whatever runs past the end is dropped. */
export function mixInto(dst: Stereo, src: Stereo, at = 0, gain = 1): void {
  const n = Math.min(src.l.length, dst.l.length - at);
  for (let i = Math.max(0, -at); i < n; i++) {
    dst.l[at + i] = dst.l[at + i]! + src.l[i]! * gain;
    dst.r[at + i] = dst.r[at + i]! + src.r[i]! * gain;
  }
}
