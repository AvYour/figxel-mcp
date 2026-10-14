// figma_generate_audio's synthesizer — pure, no I/O. A music bed arranged on
// a tempo grid and sound effects at given times, mixed and limited into 48 kHz
// stereo float buffers. Nothing is sampled or downloaded: every sound is made
// here from oscillators and seeded noise (audio-dsp.ts), so the same spec and
// seed give the same samples on every machine.
//
// The bed is four bars of a chord progression per style, looped from the first
// downbeat (`beatOffset`); a section's energy decides which layers play in each
// bar: pads and bass always, drums from a threshold, the backbeat, open hats and
// a plucked arpeggio higher up, sixteenth hats at the top, and a fill (a snare
// roll, a noise rise, a crash) into a bar that is clearly louder than the one
// before. Effects sit 6 dB under a bed when both are present.

import {
  Biquad,
  adsr,
  dbToGain,
  limit,
  midiHz,
  mixInto,
  panGains,
  pinkNoise,
  reverb,
  rng,
  SAMPLE_RATE,
  sawOsc,
  scale,
  sineOsc,
  stereo,
  subSeed,
  type Stereo,
} from "./audio-dsp.js";
import { integratedLoudness, samplePeak, truePeak } from "./audio-loudness.js";

export const BED_STYLES = ["minimal-tech", "warm-corporate", "upbeat", "ambient"] as const;
export type BedStyle = (typeof BED_STYLES)[number];
export const CUE_TYPES = ["whoosh", "hit", "tick", "pop", "riser", "click", "swell", "drop"] as const;
export type CueType = (typeof CUE_TYPES)[number];

/** A cue's length when none is given, s. A hit's is its tail. */
export const CUE_DEFAULT_S: Readonly<Record<CueType, number>> = { whoosh: 0.6, hit: 1.2, tick: 0.05, pop: 0.12, riser: 1.5, click: 0.02, swell: 1.2, drop: 1.0 };
export const DEFAULT_INTENSITY = 0.7;
/** The level a bed is brought to before effects and the limiter. */
export const BED_LUFS = -18;
/** The limiter's ceiling (sample peak), then the true-peak ceiling the file is held under. */
const SAMPLE_CEILING_DB = -2;
export const TRUE_PEAK_CEILING_DB = -1;
/**
 * The true peak this file aims at, under the ceiling: measured on generated
 * beds, ffmpeg's ebur128 read true peaks up to 0.2 dB higher than this
 * module's 4× estimate (test/audio-synth.test.ts), so the margin keeps both
 * readings under −1 dBTP.
 */
const TRUE_PEAK_TARGET_DB = TRUE_PEAK_CEILING_DB - 0.3;
/** Effects sit this far under a bed. */
export const CUES_UNDER_BED_DB = -6;

export interface Section {
  from: number;
  to: number;
  energy: number;
}

export interface BedSpec {
  style: BedStyle;
  bpm: number;
  beatOffset?: number;
  key?: string;
  /** The energy of every bar no section covers. */
  intensity?: number;
  sections?: readonly Section[];
}

export interface CueSpec {
  t: number;
  type: CueType;
  durationS?: number;
  intensity?: number;
  pan?: number;
  note?: string;
}

export interface GenerateSpec {
  durationS: number;
  seed: number;
  bed?: BedSpec;
  cues?: readonly CueSpec[];
}

export type Voice = "kick" | "snare" | "clap" | "hat" | "openhat" | "bass" | "pad" | "pluck" | "crash" | "rise";

export interface BedEvent {
  t: number;
  voice: Voice;
  vel: number;
  notes?: number[];
  durS?: number;
  bar: number;
}

export interface BedPlan {
  style: BedStyle;
  bpm: number;
  beatOffset: number;
  key: string;
  intensity: number;
  bars: number;
  chords: string[];
  sections: Array<{ from: number; to: number; energy: number; layers: string[] }>;
  events: BedEvent[];
}

export interface Generated {
  audio: Stereo;
  bed?: BedPlan;
  cues: Array<Required<Omit<CueSpec, "note">> & { note?: string }>;
  loudness: { integratedLufs: number | null; truePeakDbtp: number | null; samplePeakDbfs: number | null; limiterDb: number };
  warnings: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const at = (t: number) => Math.round(t * SAMPLE_RATE);

// ── keys and chords ──────────────────────────────────────────────────────────

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** "C minor", "F# major", "Bb min", "Am", "E": a root pitch class and a mode, or null. */
export function parseKey(text: string): { root: number; minor: boolean; name: string } | null {
  const s = text.trim();
  const letter = LETTER[s[0]?.toUpperCase() ?? ""];
  if (letter === undefined) return null;
  let rest = s.slice(1);
  let root = letter;
  if (/^[#♯]/.test(rest)) {
    root += 1;
    rest = rest.slice(1);
  } else if (/^[b♭]/.test(rest)) {
    root -= 1;
    rest = rest.slice(1);
  }
  const mode = rest.trim().toLowerCase();
  let minor: boolean;
  if (mode === "" || mode === "maj" || mode === "major") minor = false;
  else if (mode === "m" || mode === "min" || mode === "minor") minor = true;
  else return null;
  root = (root + 12) % 12;
  return { root, minor, name: `${NAMES[root]} ${minor ? "minor" : "major"}` };
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** A triad (or seventh) on a scale degree, as midi notes around `base`. */
function chordNotes(key: { root: number; minor: boolean }, degree: number, base: number, seventh: boolean): number[] {
  const scale = key.minor ? MINOR : MAJOR;
  const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  return steps.map((s) => {
    const d = degree + s;
    return base + key.root + scale[d % 7]! + 12 * Math.floor(d / 7);
  });
}

function chordName(key: { root: number; minor: boolean }, degree: number): string {
  const n = chordNotes(key, degree, 0, false);
  const minorThird = (n[1]! - n[0]! + 12) % 12 === 3;
  const roman = ROMAN[degree % 7]!;
  return minorThird ? roman.toLowerCase() : roman;
}

// ── styles ───────────────────────────────────────────────────────────────────

interface StyleDef {
  key: string;
  prog: number[];
  barsPerChord: number;
  /** Positions in sixteenths of a bar. */
  kick: number[];
  snare: number[];
  clap: number[];
  hat: number[];
  openHat: number[];
  bass: { steps: number[]; len: number; octaveJump: boolean };
  pad: { attack: number; release: number; cutoff: number; seventh: boolean; level: number };
  pluck: { steps: number[]; level: number };
  /** Energy from which the drums play. */
  drumsFrom: number;
  backbeat: boolean;
}

const STYLES: Record<BedStyle, StyleDef> = {
  "minimal-tech": {
    key: "A minor",
    prog: [0, 0, 5, 6],
    barsPerChord: 1,
    kick: [0, 4, 8, 12],
    snare: [],
    clap: [4, 12],
    hat: [2, 6, 10, 14],
    openHat: [],
    bass: { steps: [2, 6, 10, 14], len: 1.6, octaveJump: false },
    pad: { attack: 0.6, release: 1.0, cutoff: 1300, seventh: false, level: 0.05 },
    pluck: { steps: [3, 11], level: 0.12 },
    drumsFrom: 0.3,
    backbeat: true,
  },
  "warm-corporate": {
    key: "C major",
    prog: [0, 4, 5, 3],
    barsPerChord: 1,
    kick: [0, 8],
    snare: [4, 12],
    clap: [],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [],
    bass: { steps: [0, 4, 8, 12], len: 3.5, octaveJump: false },
    pad: { attack: 0.4, release: 0.9, cutoff: 2200, seventh: true, level: 0.045 },
    pluck: { steps: [0, 2, 4, 6, 8, 10, 12, 14], level: 0.1 },
    drumsFrom: 0.3,
    backbeat: true,
  },
  upbeat: {
    key: "G major",
    prog: [0, 5, 3, 4],
    barsPerChord: 1,
    kick: [0, 4, 8, 12],
    snare: [],
    clap: [4, 12],
    hat: [2, 6, 10, 14],
    openHat: [2, 6, 10, 14],
    bass: { steps: [0, 2, 4, 6, 8, 10, 12, 14], len: 1.5, octaveJump: true },
    pad: { attack: 0.15, release: 0.6, cutoff: 2600, seventh: false, level: 0.04 },
    pluck: { steps: [0, 2, 4, 6, 8, 10, 12, 14], level: 0.1 },
    drumsFrom: 0.3,
    backbeat: true,
  },
  ambient: {
    key: "D minor",
    prog: [0, 5, 2, 6],
    barsPerChord: 2,
    kick: [0],
    snare: [],
    clap: [],
    hat: [8],
    openHat: [],
    bass: { steps: [0], len: 16, octaveJump: false },
    pad: { attack: 1.5, release: 2.0, cutoff: 1200, seventh: true, level: 0.05 },
    pluck: { steps: [0, 6, 10], level: 0.08 },
    drumsFrom: 0.6,
    backbeat: false,
  },
};

/** The layers a bar of this energy plays. */
export function layersFor(style: BedStyle, energy: number): string[] {
  const s = STYLES[style];
  const out = ["pad"];
  if (energy >= 0.15) out.push("bass");
  if (energy >= s.drumsFrom) out.push("kick", "hats");
  if (s.backbeat && energy >= 0.55) out.push(s.clap.length ? "clap" : "snare");
  if (energy >= 0.6) out.push("pluck");
  if (energy >= 0.6 && s.openHat.length) out.push("open hats");
  if (energy >= 0.85 && style !== "ambient") out.push("16th hats");
  return out;
}

// ── the bed's schedule ───────────────────────────────────────────────────────

export function planBed(spec: BedSpec, durationS: number): BedPlan {
  const s = STYLES[spec.style];
  const key = parseKey(spec.key ?? s.key) ?? parseKey(s.key)!;
  const beatS = 60 / spec.bpm;
  const sixteenth = beatS / 4;
  const barS = 4 * beatS;
  const offset = spec.beatOffset ?? 0;
  const intensity = spec.intensity ?? DEFAULT_INTENSITY;
  const energyAt = (t: number) => spec.sections?.find((x) => t >= x.from - 1e-9 && t < x.to - 1e-9)?.energy ?? intensity;
  const bars = Math.max(0, Math.ceil((durationS - offset) / barS));
  const events: BedEvent[] = [];
  const add = (e: BedEvent) => {
    if (e.t < durationS - 1e-9 && e.t >= -1e-9) events.push(e);
  };
  const chordOf = (bar: number) => s.prog[Math.floor(Math.max(0, bar) / s.barsPerChord) % s.prog.length]!;
  // The pickup before the first downbeat: the first chord, already sounding.
  if (offset > 0.05) add({ t: 0, voice: "pad", vel: 0.8, notes: chordNotes(key, chordOf(0), 48, s.pad.seventh), durS: offset, bar: -1 });
  for (let b = 0; b < bars; b++) {
    const t0 = offset + b * barS;
    const e = energyAt(t0);
    const next = energyAt(t0 + barS);
    const layers = new Set(layersFor(spec.style, e));
    const degree = chordOf(b);
    if (b % s.barsPerChord === 0) {
      add({ t: t0, voice: "pad", vel: 0.8, notes: chordNotes(key, degree, 48, s.pad.seventh), durS: barS * s.barsPerChord, bar: b });
    }
    const pos = (step: number) => t0 + step * sixteenth;
    if (layers.has("bass")) {
      s.bass.steps.forEach((step, i) => {
        const note = 24 + key.root + (key.minor ? MINOR : MAJOR)[degree % 7]! + (s.bass.octaveJump && i % 2 === 1 ? 12 : 0);
        add({ t: pos(step), voice: "bass", vel: 0.8, notes: [note], durS: s.bass.len * sixteenth, bar: b });
      });
    }
    const fill = b < bars - 1 && next >= e + 0.25 && next >= 0.55;
    if (layers.has("kick")) for (const step of s.kick) add({ t: pos(step), voice: "kick", vel: 1, bar: b });
    if (layers.has("hats")) {
      const steps = layers.has("16th hats") ? Array.from({ length: 16 }, (_, i) => i) : s.hat;
      for (const step of steps) add({ t: pos(step), voice: "hat", vel: step % 4 === 2 ? 0.9 : 0.6, bar: b });
    }
    if (layers.has("open hats")) for (const step of s.openHat) add({ t: pos(step), voice: "openhat", vel: 0.7, bar: b });
    if (layers.has("clap")) for (const step of s.clap) if (!(fill && step >= 12)) add({ t: pos(step), voice: "clap", vel: 0.9, bar: b });
    if (layers.has("snare")) for (const step of s.snare) if (!(fill && step >= 12)) add({ t: pos(step), voice: "snare", vel: 0.8, bar: b });
    if (layers.has("pluck")) {
      const chord = chordNotes(key, degree, 60, true);
      s.pluck.steps.forEach((step, i) => add({ t: pos(step), voice: "pluck", vel: 0.8, notes: [chord[i % chord.length]!], bar: b }));
    }
    if (fill) {
      // A snare roll over the last beat, a noise rise over the last half bar, a crash on the next downbeat.
      for (const step of [12, 13, 14, 15]) add({ t: pos(step), voice: "snare", vel: 0.45 + 0.15 * (step - 12), bar: b });
      add({ t: pos(8), voice: "rise", vel: 0.8, durS: 8 * sixteenth, bar: b });
      add({ t: t0 + barS, voice: "crash", vel: 0.9, bar: b + 1 });
    }
  }
  events.sort((a, b) => a.t - b.t || a.voice.localeCompare(b.voice));

  const sections: BedPlan["sections"] = [];
  for (let b = 0; b < bars; b++) {
    const t0 = offset + b * barS;
    const e = energyAt(t0);
    const last = sections[sections.length - 1];
    if (last && last.energy === e) last.to = r3(Math.min(durationS, t0 + barS));
    else sections.push({ from: r3(t0), to: r3(Math.min(durationS, t0 + barS)), energy: e, layers: layersFor(spec.style, e) });
  }
  return {
    style: spec.style,
    bpm: spec.bpm,
    beatOffset: offset,
    key: key.name,
    intensity,
    bars,
    chords: s.prog.map((d) => chordName(key, d)),
    sections,
    events,
  };
}

// ── voices ───────────────────────────────────────────────────────────────────

interface Buses {
  dry: Stereo;
  send: Stereo;
}

/** Write `len` samples from frame `start`: fn(i, tSeconds) returns [left, right]; `sendGain` copies them to the reverb bus. */
function render(b: Buses, start: number, len: number, sendGain: number, fn: (i: number, t: number) => [number, number]): void {
  const n = b.dry.l.length;
  for (let i = 0; i < len; i++) {
    const k = start + i;
    if (k >= n) break;
    const [l, r] = fn(i, i / SAMPLE_RATE);
    if (k < 0) continue;
    b.dry.l[k] = b.dry.l[k]! + l;
    b.dry.r[k] = b.dry.r[k]! + r;
    if (sendGain) {
      b.send.l[k] = b.send.l[k]! + l * sendGain;
      b.send.r[k] = b.send.r[k]! + r * sendGain;
    }
  }
}

function voiceKick(b: Buses, start: number, vel: number, random: () => number): void {
  const osc = sineOsc(0.25);
  render(b, start, at(0.45), 0, (i, t) => {
    const v = (osc(48 + 110 * Math.exp(-t / 0.035)) * Math.exp(-t / 0.16) + (random() * 2 - 1) * 0.25 * Math.exp(-t / 0.002)) * vel * 0.9;
    return [v, v];
  });
}

function voiceSnare(b: Buses, start: number, vel: number, random: () => number): void {
  const bp = new Biquad("bandpass", 1800, 0.7);
  const tone = sineOsc(0.25);
  render(b, start, at(0.25), 0.25, (i, t) => {
    const v = (bp.process(random() * 2 - 1) * 1.6 * Math.exp(-t / 0.06) + 0.45 * tone(185) * Math.exp(-t / 0.05)) * vel * 0.5;
    return [v, v];
  });
}

function voiceClap(b: Buses, start: number, vel: number, random: () => number): void {
  const bp = new Biquad("bandpass", 1300, 1.2);
  render(b, start, at(0.3), 0.3, (i, t) => {
    const burst = Math.max(Math.exp(-t / 0.006), t > 0.011 ? Math.exp(-(t - 0.011) / 0.006) : 0, t > 0.022 ? Math.exp(-(t - 0.022) / 0.08) : 0);
    const v = bp.process(random() * 2 - 1) * burst * vel * 0.9;
    return [v, v];
  });
}

function voiceHat(b: Buses, start: number, vel: number, open: boolean, random: () => number): void {
  const hp = new Biquad("highpass", 7500, 0.8);
  const [gl, gr] = panGains(open ? -0.2 : 0.25);
  render(b, start, at(open ? 0.4 : 0.08), 0.05, (i, t) => {
    const v = hp.process(random() * 2 - 1) * Math.exp(-t / (open ? 0.18 : 0.03)) * vel * 0.22;
    return [v * gl, v * gr];
  });
}

function voiceBass(b: Buses, start: number, note: number, durS: number, vel: number): void {
  const saw = sawOsc();
  const sub = sineOsc();
  const lp = new Biquad("lowpass", 600, 0.9);
  const f = midiHz(note);
  render(b, start, at(durS + 0.08), 0, (i, t) => {
    if (i % 16 === 0) lp.set("lowpass", 180 + 900 * Math.exp(-t / 0.12) * (0.5 + vel), 0.9);
    const v = (lp.process(saw(f)) * 0.7 + sub(f) * 0.5) * adsr(t, 0.005, 0.15, 0.7, 0.06, durS) * vel * 0.32;
    return [v, v];
  });
}

function voicePad(b: Buses, start: number, notes: number[], durS: number, def: StyleDef["pad"], random: () => number): void {
  const len = at(durS + def.release);
  for (const note of notes) {
    const f = midiHz(note);
    const cents = (c: number) => 2 ** (c / 1200);
    const oscL = sawOsc(random());
    const oscC = sawOsc(random());
    const oscR = sawOsc(random());
    const lpL = new Biquad("lowpass", def.cutoff, 0.6);
    const lpR = new Biquad("lowpass", def.cutoff, 0.6);
    const fl = f * cents(-8);
    const fr = f * cents(8);
    render(b, start, len, 0.5, (i, t) => {
      const env = adsr(t, def.attack, 0.6, 0.85, def.release, durS) * def.level;
      const c = oscC(f) * 0.7;
      return [lpL.process(oscL(fl) + c) * env, lpR.process(oscR(fr) + c) * env];
    });
  }
}

function voicePluck(b: Buses, start: number, note: number, vel: number, pan: number, level: number): void {
  const saw = sawOsc();
  const lp = new Biquad("lowpass", 3000, 0.8);
  const f = midiHz(note);
  const [gl, gr] = panGains(pan);
  render(b, start, at(0.6), 0.35, (i, t) => {
    if (i % 16 === 0) lp.set("lowpass", 300 + 3500 * Math.exp(-t / 0.08), 0.8);
    const v = lp.process(saw(f)) * Math.exp(-t / 0.25) * Math.min(1, (i + 1) / 48) * vel * level * 2;
    return [v * gl, v * gr];
  });
}

function voiceCrash(b: Buses, start: number, vel: number, random: () => number): void {
  const hpL = new Biquad("highpass", 4000, 0.7);
  const hpR = new Biquad("highpass", 4000, 0.7);
  render(b, start, at(2), 0.2, (i, t) => {
    const env = Math.exp(-t / 0.6) * vel * 0.28;
    return [hpL.process(random() * 2 - 1) * env, hpR.process(random() * 2 - 1) * env];
  });
}

function voiceRise(b: Buses, start: number, durS: number, vel: number, random: () => number): void {
  const bp = new Biquad("bandpass", 500, 1);
  const len = at(durS);
  render(b, start, len, 0.3, (i, t) => {
    const x = t / durS;
    if (i % 16 === 0) bp.set("bandpass", 500 * 10 ** x, 1);
    const v = bp.process(random() * 2 - 1) * x * x * vel * 0.5;
    return [v, v];
  });
}

// ── cues ─────────────────────────────────────────────────────────────────────

/** Amplitude for an intensity 0–1: never silent, full at 1. */
const amp = (intensity: number) => 0.25 + 0.75 * clamp(intensity, 0, 1);

function cue(b: Buses, c: Required<Omit<CueSpec, "note">>, random: () => number): void {
  const start = at(c.t);
  const d = c.durationS;
  const len = at(d);
  const a = amp(c.intensity);
  const [gl, gr] = panGains(c.pan);
  switch (c.type) {
    case "whoosh": {
      const noise = pinkNoise(random);
      const bp = new Biquad("bandpass", 400, 1.2);
      // Rises to its peak 60 % of the way through, then falls away.
      const bell = (x: number) => (x < 0.6 ? (x / 0.6) ** 1.5 : ((1 - x) / 0.4) ** 1.2);
      render(b, start, len, 0.15, (i, t) => {
        const x = t / d;
        if (i % 16 === 0) bp.set("bandpass", 400 * 2 ** (3 * bell(x)), 1.2);
        const v = bp.process(noise()) * 3 * bell(x) * a;
        const [pl, pr] = panGains(clamp(c.pan - 0.35 + 0.7 * x, -1, 1));
        return [v * pl, v * pr];
      });
      return;
    }
    case "hit": {
      const thump = sineOsc(0.25);
      const hp = new Biquad("highpass", 800, 0.7);
      render(b, start, len, 0.6, (i, t) => {
        const fade = t > d - 0.02 ? Math.max(0, (d - t) / 0.02) : 1;
        const v = (thump(45 + 70 * Math.exp(-t / 0.05)) * Math.exp(-t / 0.35) + hp.process(random() * 2 - 1) * 0.6 * Math.exp(-t / 0.03)) * a * 0.9 * fade;
        return [v * gl * Math.SQRT2, v * gr * Math.SQRT2];
      });
      return;
    }
    case "tick": {
      const s1 = sineOsc(0.25);
      const s2 = sineOsc(0.25);
      render(b, start, len, 0.1, (i, t) => {
        const v = (s1(2400) + 0.5 * s2(4800)) * Math.exp(-t / 0.012) * a * 0.5;
        return [v * gl, v * gr];
      });
      return;
    }
    case "pop": {
      const osc = sineOsc(0.25);
      render(b, start, len, 0.1, (i, t) => {
        const v = osc(250 + 650 * Math.exp(-t / 0.02)) * Math.min(1, (i + 1) / 48) * Math.exp(-t / 0.04) * a * 0.7;
        return [v * gl, v * gr];
      });
      return;
    }
    case "click": {
      const bp = new Biquad("bandpass", 3000, 1.5);
      render(b, start, len, 0.05, (i, t) => {
        const v = bp.process(random() * 2 - 1) * Math.exp(-t / 0.004) * a * 2.2;
        return [v * gl, v * gr];
      });
      return;
    }
    case "riser": {
      const hp = new Biquad("highpass", 300, 0.8);
      const lp = new Biquad("lowpass", 2000, 0.7);
      const tone = sawOsc();
      render(b, start, len, 0, (i, t) => {
        const x = t / d;
        if (i % 16 === 0) {
          hp.set("highpass", 300 * (7000 / 300) ** x, 0.8);
          lp.set("lowpass", 600 + 5000 * x, 0.7);
        }
        // Ends on its loudest sample: a 3 ms ramp only keeps the cut from clicking.
        const tail = Math.min(1, (d - t) / 0.003);
        const v = (hp.process(random() * 2 - 1) * 0.7 + lp.process(tone(180 * (1400 / 180) ** x)) * 0.35) * x * x * tail * a;
        return [v * gl, v * gr];
      });
      return;
    }
    case "swell": {
      const lp = new Biquad("lowpass", 800, 0.7);
      const s1 = sineOsc();
      const s2 = sineOsc();
      render(b, start, len, 0.4, (i, t) => {
        const x = t / d;
        if (i % 16 === 0) lp.set("lowpass", 800 * 10 ** x, 0.7);
        const tail = Math.min(1, (d - t) / 0.02);
        const v = (lp.process(random() * 2 - 1) * 0.6 + (s1(220) + s2(330)) * 0.2) * x ** 2.5 * tail * a;
        return [v * gl, v * gr];
      });
      return;
    }
    case "drop": {
      const osc = sineOsc(0.25);
      const lp = new Biquad("lowpass", 3000, 0.7);
      render(b, start, len, 0.3, (i, t) => {
        const x = t / d;
        if (i % 16 === 0) lp.set("lowpass", 3000 * (150 / 3000) ** x, 0.7);
        const v = (osc(220 * (38 / 220) ** x) * 0.8 + lp.process(random() * 2 - 1) * 0.4) * (1 - x) ** 1.3 * a;
        return [v * gl, v * gr];
      });
      return;
    }
  }
}

// ── the whole piece ──────────────────────────────────────────────────────────

const finite = (v: number) => (Number.isFinite(v) ? r1(v) : null);

export function generate(spec: GenerateSpec): Generated {
  const frames = at(spec.durationS);
  const warnings: string[] = [];
  const mix = stereo(frames);
  let plan: BedPlan | undefined;

  if (spec.bed) {
    plan = planBed(spec.bed, spec.durationS);
    if (plan.bars === 0) warnings.push(`bed.beatOffset ${spec.bed.beatOffset} s is at or past the end (${spec.durationS} s): only the pickup chord plays.`);
    const style = STYLES[spec.bed.style];
    const buses: Buses = { dry: stereo(frames), send: stereo(frames) };
    const random = (label: string) => rng(subSeed(spec.seed, `bed:${label}`));
    let pluckSide = 1;
    plan.events.forEach((e, i) => {
      const start = at(e.t);
      const own = random(`${e.voice}:${i}`);
      switch (e.voice) {
        case "kick":
          return voiceKick(buses, start, e.vel, own);
        case "snare":
          return voiceSnare(buses, start, e.vel, own);
        case "clap":
          return voiceClap(buses, start, e.vel, own);
        case "hat":
          return voiceHat(buses, start, e.vel, false, own);
        case "openhat":
          return voiceHat(buses, start, e.vel, true, own);
        case "bass":
          return voiceBass(buses, start, e.notes![0]!, e.durS!, e.vel);
        case "pad":
          return voicePad(buses, start, e.notes!, e.durS!, style.pad, own);
        case "pluck":
          pluckSide = -pluckSide;
          return voicePluck(buses, start, e.notes![0]!, e.vel, 0.3 * pluckSide, style.pluck.level);
        case "crash":
          return voiceCrash(buses, start, e.vel, own);
        case "rise":
          return voiceRise(buses, start, e.durS!, e.vel, own);
      }
    });
    const wet = reverb(buses.send, { size: spec.bed.style === "ambient" ? 0.85 : 0.6, damp: 0.4 });
    mixInto(buses.dry, wet, 0, spec.bed.style === "ambient" ? 0.6 : 0.35);
    // The bed's end: a short fade, so it stops on the last frame instead of clicking.
    const fade = Math.min(at(0.5), at(60 / spec.bed.bpm), frames);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      buses.dry.l[frames - 1 - i] = buses.dry.l[frames - 1 - i]! * g;
      buses.dry.r[frames - 1 - i] = buses.dry.r[frames - 1 - i]! * g;
    }
    const loud = integratedLoudness(buses.dry);
    if (Number.isFinite(loud)) scale(buses.dry, Math.min(dbToGain(24), dbToGain(BED_LUFS - loud)));
    mixInto(mix, buses.dry);
  }

  const cues: Generated["cues"] = [];
  // Ordered and seeded by what each cue is, not where it sits in the list: the
  // same cues in another order (derived cues passed back) make the same bytes.
  const asked = [...(spec.cues ?? [])]
    .map((c, i) => ({ c, i }))
    .sort(
      (x, y) =>
        x.c.t - y.c.t ||
        x.c.type.localeCompare(y.c.type) ||
        (x.c.durationS ?? -1) - (y.c.durationS ?? -1) ||
        (x.c.intensity ?? -1) - (y.c.intensity ?? -1) ||
        (x.c.pan ?? 0) - (y.c.pan ?? 0) ||
        x.i - y.i,
    );
  const seen = new Map<string, number>();
  if (asked.length) {
    const buses: Buses = { dry: stereo(frames), send: stereo(frames) };
    for (const { c, i } of asked) {
      if (c.t >= spec.durationS) {
        warnings.push(`cues[${i}] (${c.type} at ${c.t} s) starts at or after the end (${spec.durationS} s); it was left out.`);
        continue;
      }
      let durationS = c.durationS ?? CUE_DEFAULT_S[c.type];
      if (c.t + durationS > spec.durationS + 1e-9) {
        warnings.push(`cues[${i}] (${c.type} at ${c.t} s) runs ${r3(c.t + durationS - spec.durationS)} s past the end; it is cut there.`);
        if (c.type === "riser" || c.type === "swell") warnings.push(`cues[${i}] is a ${c.type}: cut early, it never reaches its peak.`);
        durationS = spec.durationS - c.t;
      }
      const resolved = { t: c.t, type: c.type, durationS: r3(durationS), intensity: c.intensity ?? DEFAULT_INTENSITY, pan: c.pan ?? 0, ...(c.note ? { note: c.note } : {}) };
      cues.push(resolved);
      const label = `${c.type}@${c.t}`;
      const k = seen.get(label) ?? 0;
      seen.set(label, k + 1);
      cue(buses, { ...resolved, durationS }, rng(subSeed(spec.seed, `cue:${label}#${k}`)));
    }
    const wet = reverb(buses.send, { size: 0.5, damp: 0.35 });
    mixInto(buses.dry, wet, 0, 0.3);
    mixInto(mix, buses.dry, 0, plan ? dbToGain(CUES_UNDER_BED_DB) : 1);
  }

  const limiterDb = limit(mix, dbToGain(SAMPLE_CEILING_DB));
  let tp = truePeak(mix);
  // Between samples a peak can still pass the ceiling: one gain step takes it under, exactly.
  if (tp > TRUE_PEAK_TARGET_DB) {
    const trim = TRUE_PEAK_TARGET_DB - tp;
    scale(mix, dbToGain(trim));
    tp += trim;
  }
  return {
    audio: mix,
    ...(plan ? { bed: plan } : {}),
    cues,
    loudness: { integratedLufs: finite(integratedLoudness(mix)), truePeakDbtp: finite(tp), samplePeakDbfs: finite(samplePeak(mix)), limiterDb: r1(limiterDb) },
    warnings,
  };
}
