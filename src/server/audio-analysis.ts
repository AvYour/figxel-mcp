// The rhythm of a music file for figma_analyze_audio — pure, no I/O. ffmpeg
// decodes the file to mono PCM at 11,025 Hz; everything after that is here, so
// it is tested on synthetic click tracks without ffmpeg.
//
//   1. An onset-strength envelope: spectral flux on log-compressed band
//      magnitudes, 512-sample frames every 64 samples (about 172 per second).
//   2. Tempo: autocorrelation of the envelope, scored at each lag together
//      with its multiples (a period whose multiples also repeat is a pulse,
//      not a subdivision), weighted gently towards 120 BPM so that a tie
//      between a tempo and its half or double goes to the one nearer the
//      middle of the range. The other octave is reported as an alternative.
//   3. Beats: dynamic programming in the style of Ellis 2007: each frame's
//      best score is its onset strength plus the best earlier beat, penalised
//      by how far the gap is from the period on a log scale. Leading and
//      trailing beats with no onset are trimmed, and each beat is moved onto
//      the attack it sits on (a 0.7 ms energy step).
//   4. A downbeat guess: of the four phases of a 4-beat bar, the one whose
//      beats carry the most low-frequency attack.
// Deterministic: the same samples give the same answer.

export const ANALYSIS_RATE = 11_025;
const N = 512;
const HOP = 64;
const BANDS = 24;
const LOW_HZ = 40;
const HIGH_HZ = 5000;
/** Bands under this frequency make the low envelope the downbeat guess reads. */
const KICK_HZ = 200;
/** The DP's penalty weight for a gap off the period (librosa's default "tightness"). */
const TIGHTNESS = 100;
/** Where a frame's onset sits, as a fraction of its window: the flux peaks as an attack enters the window. */
const FRAME_AT = 0.75;

// ── FFT ──────────────────────────────────────────────────────────────────────

const LOG2N = Math.log2(N);
const REV = (() => {
  const r = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < LOG2N; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    r[i] = y;
  }
  return r;
})();
const COS = Float64Array.from({ length: N / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / N));
const SIN = Float64Array.from({ length: N / 2 }, (_, k) => -Math.sin((2 * Math.PI * k) / N));
const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/** In-place radix-2 FFT of N complex values. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < N; i++) {
    const j = REV[i]!;
    if (j > i) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]!;
        const wi = SIN[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

// ── 1. the onset envelope ────────────────────────────────────────────────────

export interface OnsetEnvelope {
  /** Spectral flux per frame, all bands. */
  env: Float32Array;
  /** The same from the bands under 200 Hz: the kick. */
  low: Float32Array;
  /** Frames per second. */
  rate: number;
  /** Time of frame i: t0 + i / rate. */
  t0: number;
}

export function onsetEnvelope(pcm: Float32Array, sampleRate = ANALYSIS_RATE): OnsetEnvelope {
  const frames = pcm.length >= N ? Math.floor((pcm.length - N) / HOP) + 1 : 0;
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  const norm = peak > 0 ? 1 / peak : 1;
  // Band edges in bins, log-spaced, at least one bin wide.
  const binHz = sampleRate / N;
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / BANDS)) / binHz));
  for (let b = 1; b <= BANDS; b++) if (edges[b]! <= edges[b - 1]!) edges[b] = edges[b - 1]! + 1;
  const lowBands = edges.findIndex((e) => e * binHz >= KICK_HZ);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(BANDS);
  let cur = new Float64Array(BANDS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = pcm[off + i]! * norm * HANN[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let m = 0;
      for (let k = edges[b]!; k < edges[b + 1]!; k++) m += Math.hypot(re[k]!, im[k]!);
      cur[b] = Math.log1p((1000 * m) / ((edges[b + 1]! - edges[b]!) * (N / 4)));
    }
    if (f > 0) {
      let all = 0;
      let lo = 0;
      for (let b = 0; b < BANDS; b++) {
        const d = cur[b]! - prev[b]!;
        if (d > 0) {
          all += d;
          if (b < lowBands) lo += d;
        }
      }
      env[f] = all;
      low[f] = lo;
    }
    [prev, cur] = [cur, prev];
  }
  return { env, low, rate: sampleRate / HOP, t0: (N * FRAME_AT) / sampleRate };
}

/** The envelope minus its local mean (±`radius` frames), rectified: onsets stand out of a busy mix. */
function localPeaks(env: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(env.length);
  const prefix = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) prefix[i + 1] = prefix[i]! + env[i]!;
  for (let i = 0; i < env.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(env.length, i + radius + 1);
    const mean = (prefix[b]! - prefix[a]!) / (b - a);
    out[i] = Math.max(0, env[i]! - mean);
  }
  return out;
}

// ── 2. tempo ─────────────────────────────────────────────────────────────────

export interface TempoEstimate {
  /** The beat period in envelope frames (fractional). */
  lag: number;
  bpm: number;
  /** AC at the chosen lag over AC at lag 0: how strongly the envelope repeats there, 0–1. */
  periodicity: number;
  /** The other octaves in range, as a factor of bpm (0.5 or 2) and a score relative to the chosen one. */
  alternatives: Array<{ factor: number; score: number }>;
}

/** A log-normal weight around 120 BPM, one octave wide: it only breaks near-ties between octaves. */
const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);

export function estimateTempo(onset: Float32Array, rate: number, minBpm: number, maxBpm: number): TempoEstimate | null {
  const F = onset.length;
  const lagMin = Math.max(2, Math.floor((60 / maxBpm) * rate));
  const lagMax = Math.ceil((60 / minBpm) * rate);
  if (F < 2 * lagMax) return null;
  let mean = 0;
  for (let i = 0; i < F; i++) mean += onset[i]!;
  mean /= F;
  const x = Float64Array.from(onset, (v) => v - mean);
  const maxLag = Math.min(F - 1, 4 * lagMax + 2);
  const ac = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; L++) {
    let s = 0;
    for (let i = L; i < F; i++) s += x[i]! * x[i - L]!;
    ac[L] = s / (F - L);
  }
  if (!(ac[0]! > 0)) return null;
  const acAt = (L: number) => {
    if (L > maxLag) return 0;
    const i = Math.floor(L);
    const f = L - i;
    return i + 1 <= maxLag ? ac[i]! * (1 - f) + ac[i + 1]! * f : ac[i]!;
  };
  // A pulse repeats at its multiples too; a subdivision does not.
  const comb = (L: number) => {
    let s = 0;
    for (let k = 1; k <= 4; k++) s += Math.max(0, acAt(k * L)) / k;
    return s;
  };
  const score = (L: number) => comb(L) * prior((60 * rate) / L);
  let best = lagMin;
  for (let L = lagMin; L <= lagMax; L++) if (score(L) > score(best)) best = L;
  // A fractional lag from the peak's neighbours.
  let lag = best;
  if (best > lagMin && best < lagMax) {
    const a = score(best - 1);
    const b = score(best);
    const c = score(best + 1);
    const den = a - 2 * b + c;
    if (den < 0) lag = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  const bpm = (60 * rate) / lag;
  const top = score(best);
  const alternatives = [0.5, 2]
    .filter((k) => bpm * k >= minBpm && bpm * k <= maxBpm)
    .map((k) => ({ factor: k, score: Math.round((score(lag / k) / top) * 100) / 100 }));
  return { lag, bpm, periodicity: Math.max(0, Math.min(1, acAt(lag) / ac[0]!)), alternatives };
}

// ── 3. beats ─────────────────────────────────────────────────────────────────

/** Ellis-style dynamic programming: beat frames, in order. */
export function trackBeats(onset: Float32Array, period: number): number[] {
  const F = onset.length;
  if (F === 0) return [];
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < F; i++) {
    sum += onset[i]!;
    sq += onset[i]! * onset[i]!;
  }
  const sd = Math.sqrt(Math.max(1e-12, sq / F - (sum / F) ** 2));
  // A Gaussian a 32nd of the period wide pulls a beat onto the nearest strong frame.
  const w = Math.max(1, Math.round(period / 8));
  const local = new Float64Array(F);
  for (let i = 0; i < F; i++) {
    let s = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < F) s += (onset[j]! / sd) * Math.exp(-0.5 * ((k * 32) / period) ** 2);
    }
    local[i] = s;
  }
  const cum = new Float64Array(F);
  const back = new Int32Array(F).fill(-1);
  const near = Math.max(1, Math.round(period / 2));
  const far = Math.round(2 * period);
  for (let i = 0; i < F; i++) {
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestPrev = -1;
    for (let p = i - far; p <= i - near; p++) {
      if (p < 0) continue;
      const s = cum[p]! - TIGHTNESS * Math.log((i - p) / period) ** 2;
      if (s > bestScore) {
        bestScore = s;
        bestPrev = p;
      }
    }
    cum[i] = local[i]! + (bestPrev >= 0 ? bestScore : 0);
    back[i] = bestPrev;
  }
  let end = Math.max(0, F - Math.round(period));
  for (let i = end; i < F; i++) if (cum[i]! > cum[end]!) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]!) beats.push(i);
  return beats.reverse();
}

// ── refinement ───────────────────────────────────────────────────────────────

const FINE_W = 32;
const FINE_H = 8;

/**
 * The attack nearest `t` within ±`radius` s: the steepest rise of a 2.9 ms
 * log energy taken every 0.7 ms. Undefined when nothing rises there.
 */
export function refineOnset(pcm: Float32Array, sampleRate: number, t: number, radius: number): number | undefined {
  const from = Math.max(0, Math.round((t - radius) * sampleRate) - FINE_W);
  const to = Math.min(pcm.length - FINE_W, Math.round((t + radius) * sampleRate));
  if (to <= from + FINE_H) return undefined;
  let prev = Number.NaN;
  let best = 0;
  let bestAt = -1;
  for (let s = from; s <= to; s += FINE_H) {
    let e = 0;
    for (let i = s; i < s + FINE_W; i++) e += pcm[i]! * pcm[i]!;
    const le = Math.log10(e / FINE_W + 1e-9);
    if (!Number.isNaN(prev) && le - prev > best) {
      best = le - prev;
      bestAt = s;
    }
    prev = le;
  }
  // A step of 0.3 (2x in energy) or more is an attack; the window's end has just reached it.
  return best >= 0.3 && bestAt >= 0 ? (bestAt + FINE_W - FINE_H / 2) / sampleRate : undefined;
}

// ── the whole analysis ───────────────────────────────────────────────────────

export interface RhythmOptions {
  minBpm?: number;
  maxBpm?: number;
  beatsPerBar?: number;
  maxOnsets?: number;
}

export interface Rhythm {
  bpm: number | null;
  /** 0–1: how strongly the envelope repeats at the period, and how much of each period's attack the beats sit on. */
  confidence: number;
  alternatives: Array<{ bpm: number; score: number }>;
  beatTimes: number[];
  /** The first downbeat guessed: the first beat of the strongest phase of a bar. */
  beatOffset: number | null;
  beatsPerBar: number;
  strongOnsets: Array<{ t: number; strength: number }>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function analyseRhythm(pcm: Float32Array, sampleRate = ANALYSIS_RATE, opts: RhythmOptions = {}): Rhythm {
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const perBar = opts.beatsPerBar ?? 4;
  const { env, low, rate, t0 } = onsetEnvelope(pcm, sampleRate);
  const onset = localPeaks(env, Math.round(0.1 * rate));
  const timeOf = (f: number) => t0 + f / rate;
  const strength = (arr: Float32Array, f: number) => {
    let m = 0;
    for (let k = -3; k <= 3; k++) m = Math.max(m, arr[f + k] ?? 0);
    return m;
  };
  const empty: Rhythm = { bpm: null, confidence: 0, alternatives: [], beatTimes: [], beatOffset: null, beatsPerBar: perBar, strongOnsets: [] };

  // Strong onsets: local maxima of the envelope well above its spread.
  let mean = 0;
  for (let i = 0; i < onset.length; i++) mean += onset[i]!;
  mean /= Math.max(1, onset.length);
  let varSum = 0;
  for (let i = 0; i < onset.length; i++) varSum += (onset[i]! - mean) ** 2;
  const sd = Math.sqrt(varSum / Math.max(1, onset.length));
  if (!(sd > 1e-6)) return empty;
  const radius = Math.round(0.05 * rate);
  const peaks: Array<{ f: number; v: number }> = [];
  for (let f = 0; f < onset.length; f++) {
    const v = onset[f]!;
    if (v < mean + 1.5 * sd) continue;
    let isMax = true;
    for (let k = -radius; k <= radius && isMax; k++) {
      const u = onset[f + k];
      if (u !== undefined && (u > v || (u === v && k < 0))) isMax = false;
    }
    if (isMax) peaks.push({ f, v });
  }
  const loudest = Math.max(...peaks.map((p) => p.v), 1e-12);
  const strongOnsets = peaks
    .sort((a, b) => b.v - a.v || a.f - b.f)
    .slice(0, opts.maxOnsets ?? 24)
    .sort((a, b) => a.f - b.f)
    .map((p) => ({ t: r3(refineOnset(pcm, sampleRate, timeOf(p.f), 0.035) ?? timeOf(p.f)), strength: r2(p.v / loudest) }));

  const tempo = estimateTempo(onset, rate, minBpm, maxBpm);
  if (!tempo) return { ...empty, strongOnsets };
  let beats = trackBeats(onset, tempo.lag);
  // Trim beats at either end that sit on no attack (silence before the music, a fade after it).
  const strengths = beats.map((f) => strength(onset, f));
  const floor = 0.2 * median(strengths);
  let a = 0;
  let b = beats.length - 1;
  while (a <= b && strengths[a]! < floor) a++;
  while (b >= a && strengths[b]! < floor) b--;
  beats = beats.slice(a, b + 1);
  if (beats.length < 2) return { ...empty, strongOnsets };

  const beatTimes = beats.map((f) => refineOnset(pcm, sampleRate, timeOf(f), 0.03) ?? timeOf(f));
  // The tempo from the beats themselves: the least-squares slope of time over beat number.
  let bpm = tempo.bpm;
  if (beatTimes.length >= 4) {
    const n = beatTimes.length;
    const mx = (n - 1) / 2;
    const my = beatTimes.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    beatTimes.forEach((t, i) => {
      num += (i - mx) * (t - my);
      den += (i - mx) ** 2;
    });
    const slope = num / den;
    if (slope > 0 && Math.abs(60 / slope - tempo.bpm) / tempo.bpm < 0.06) bpm = 60 / slope;
  }

  // How much of each period's strongest attack the beat sits on.
  const half = Math.max(1, Math.round(tempo.lag / 2));
  const align = beats.map((f) => {
    let around = 0;
    for (let k = -half; k < half; k++) around = Math.max(around, onset[f + k] ?? 0);
    return around > 0 ? strength(onset, f) / around : 0;
  });
  const alignment = align.reduce((s, v) => s + v, 0) / align.length;
  const confidence = r2(Math.max(0, Math.min(1, 0.6 * Math.min(1, tempo.periodicity / 0.5) + 0.4 * alignment)));

  // The downbeat: the phase of the bar whose beats carry the most low-band attack, then the most attack.
  let bestPhase = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let ph = 0; ph < Math.min(perBar, beats.length); ph++) {
    let s = 0;
    let n = 0;
    for (let k = ph; k < beats.length; k += perBar) {
      s += strength(low, beats[k]!) + 0.25 * strength(env, beats[k]!);
      n++;
    }
    const avg = s / Math.max(1, n);
    if (avg > bestScore + 1e-9) {
      bestScore = avg;
      bestPhase = ph;
    }
  }

  return {
    bpm: r2(bpm),
    confidence,
    alternatives: tempo.alternatives.map((a) => ({ bpm: r2(bpm * a.factor), score: a.score })),
    beatTimes: beatTimes.map(r3),
    beatOffset: r3(beatTimes[bestPhase]!),
    beatsPerBar: perBar,
    strongOnsets,
  };
}
