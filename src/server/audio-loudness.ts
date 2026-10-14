// Integrated loudness and true peak of a 48 kHz stereo buffer, so that
// figma_generate_audio reports both without ffmpeg. The method is the one the
// ebur128 filter implements: K-weighting (a high shelf, then a high-pass), mean
// square over 400 ms blocks overlapping by 75 %, an absolute gate at −70 LUFS
// and a relative gate 10 LU under the ungated mean. True peak is read on a 4×
// oversampled signal. test/audio-synth.test.ts compares both with ffmpeg's
// ebur128 when it is installed.

import { SAMPLE_RATE, type Stereo } from "./audio-dsp.js";

// The two K-weighting stages at 48 kHz: b0 b1 b2, then a1 a2 (a0 = 1).
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const HIGHPASS = { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] };

function kWeighted(x: Float32Array): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let m1 = 0;
  let m2 = 0;
  let o1 = 0;
  let o2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const m = SHELF.b[0]! * v + SHELF.b[1]! * x1 + SHELF.b[2]! * x2 - SHELF.a[0]! * m1 - SHELF.a[1]! * m2;
    x2 = x1;
    x1 = v;
    const o = HIGHPASS.b[0]! * m + HIGHPASS.b[1]! * m1 + HIGHPASS.b[2]! * m2 - HIGHPASS.a[0]! * o1 - HIGHPASS.a[1]! * o2;
    m2 = m1;
    m1 = m;
    o2 = o1;
    o1 = o;
    y[i] = o;
  }
  return y;
}

const toLufs = (meanSquare: number): number => -0.691 + 10 * Math.log10(meanSquare);

/** Integrated loudness in LUFS; −Infinity when every block is under the absolute gate (silence). */
export function integratedLoudness(buf: Stereo, sampleRate = SAMPLE_RATE): number {
  if (sampleRate !== SAMPLE_RATE) throw new Error("integratedLoudness takes 48 kHz audio.");
  const step = Math.round(0.1 * sampleRate);
  const segments = Math.floor(buf.l.length / step);
  if (segments < 4) return Number.NEGATIVE_INFINITY;
  const seg = new Float64Array(segments);
  for (const ch of [buf.l, buf.r]) {
    const y = kWeighted(ch);
    for (let s = 0; s < segments; s++) {
      let sum = 0;
      for (let i = s * step; i < (s + 1) * step; i++) sum += y[i]! * y[i]!;
      seg[s] = seg[s]! + sum;
    }
  }
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= segments; s++) blocks.push((seg[s]! + seg[s + 1]! + seg[s + 2]! + seg[s + 3]!) / (4 * step));
  const loud = blocks.filter((z) => z > 0 && toLufs(z) > -70);
  if (loud.length === 0) return Number.NEGATIVE_INFINITY;
  const relative = toLufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const gated = loud.filter((z) => toLufs(z) > relative);
  return toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

// A 48-tap windowed-sinc interpolator, 12 taps per phase, for 4× oversampling.
const PHASES = 4;
const TAPS = 12;
const FIR: Float64Array[] = (() => {
  const n = PHASES * TAPS;
  const h = new Float64Array(n);
  const mid = (n - 1) / 2;
  for (let k = 0; k < n; k++) {
    const x = (k - mid) / PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
    h[k] = sinc * w;
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < PHASES; p++) {
    const ph = new Float64Array(TAPS);
    let sum = 0;
    for (let m = 0; m < TAPS; m++) sum += ph[m] = h[m * PHASES + p]!;
    for (let m = 0; m < TAPS; m++) ph[m] = ph[m]! / sum;
    phases.push(ph);
  }
  return phases;
})();

/** The highest absolute value of a channel between its samples, 4× oversampled. */
function channelTruePeak(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > peak) peak = a;
  }
  const at = (j: number) => (j >= 0 && j < x.length ? x[j]! : 0);
  for (let n = 0; n < x.length + TAPS; n++) {
    const inside = n >= TAPS - 1 && n < x.length;
    for (const ph of FIR) {
      let s = 0;
      if (inside) for (let m = 0; m < TAPS; m++) s += ph[m]! * x[n - m]!;
      else for (let m = 0; m < TAPS; m++) s += ph[m]! * at(n - m);
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** True peak in dBTP (dB relative to full scale, between samples too). */
export function truePeak(buf: Stereo): number {
  const p = Math.max(channelTruePeak(buf.l), channelTruePeak(buf.r));
  return p > 0 ? 20 * Math.log10(p) : Number.NEGATIVE_INFINITY;
}

/** The largest absolute sample, in dBFS. */
export function samplePeak(buf: Stereo): number {
  let p = 0;
  for (const ch of [buf.l, buf.r]) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]!));
  return p > 0 ? 20 * Math.log10(p) : Number.NEGATIVE_INFINITY;
}
