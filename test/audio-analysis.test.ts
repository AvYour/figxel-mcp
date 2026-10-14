// figma_analyze_audio's rhythm analysis on synthetic PCM, made here at the
// rate ffmpeg decodes to (11,025 Hz mono): click tracks at known tempos and
// offsets, a half-time groove, a tempo past the range, and noise. No ffmpeg.

import { describe, expect, it } from "vitest";
import { ANALYSIS_RATE, analyseRhythm, estimateTempo, onsetEnvelope, refineOnset, trackBeats } from "../src/server/audio-analysis.js";

const SR = ANALYSIS_RATE;

/** A small seeded generator, so the noise in every test is the same. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Voice = "click" | "kick" | "snare" | "hat";

/** Add one drum hit at `t` s. */
function hit(pcm: Float32Array, t: number, voice: Voice, gain: number, random: () => number): void {
  const at = Math.round(t * SR);
  const len = Math.round((voice === "kick" ? 0.25 : voice === "snare" ? 0.15 : 0.04) * SR);
  for (let i = 0; i < len && at + i < pcm.length; i++) {
    const s = i / SR;
    let v: number;
    if (voice === "kick") v = Math.sin(2 * Math.PI * (55 * s + 2.4 * (1 - Math.exp(-s / 0.03)))) * Math.exp(-s / 0.09);
    else if (voice === "snare") v = (random() * 2 - 1) * Math.exp(-s / 0.05) + 0.4 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s / 0.04);
    else if (voice === "hat") v = (random() * 2 - 1) * Math.exp(-s / 0.008);
    else v = Math.sin(2 * Math.PI * 1500 * s) * Math.exp(-s / 0.01);
    pcm[at + i] = pcm[at + i]! + gain * v;
  }
}

/** A click on every beat from `offset`, with a kick under every `accentEvery`-th. */
function clickTrack(o: { bpm: number; offset: number; seconds: number; accentEvery?: number }): { pcm: Float32Array; beats: number[] } {
  const pcm = new Float32Array(Math.round(o.seconds * SR));
  const random = seeded(7);
  const beats: number[] = [];
  for (let k = 0; ; k++) {
    const t = o.offset + (k * 60) / o.bpm;
    if (t > o.seconds - 0.3) break;
    beats.push(t);
    hit(pcm, t, "click", 0.6, random);
    if (o.accentEvery && k % o.accentEvery === 0) hit(pcm, t, "kick", 0.8, random);
  }
  return { pcm, beats };
}

/** Each true beat has a tracked beat within `tol` s, and no tracked beat is far from a true one. */
function matched(found: number[], truth: number[], tol: number): { missing: number; extra: number } {
  const near = (t: number, list: number[]) => list.some((u) => Math.abs(u - t) <= tol);
  return { missing: truth.filter((t) => !near(t, found)).length, extra: found.filter((t) => !near(t, truth)).length };
}

describe("tempo and beats on click tracks", () => {
  it("90 BPM from 0.5 s: the tempo, every beat to the millisecond scale, the accented first downbeat", () => {
    const { pcm, beats } = clickTrack({ bpm: 90, offset: 0.5, seconds: 20, accentEvery: 4 });
    const r = analyseRhythm(pcm, SR);
    expect(r.bpm).toBeCloseTo(90, 0);
    expect(Math.abs(r.bpm! - 90)).toBeLessThan(0.3);
    expect(matched(r.beatTimes, beats, 0.01)).toEqual({ missing: 0, extra: 0 });
    expect(r.beatOffset).toBeCloseTo(0.5, 1);
    expect(Math.abs(r.beatOffset! - 0.5)).toBeLessThan(0.01);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    // 45 BPM is out of the default range; 180 is a subdivision nothing plays.
    expect(r.alternatives).toHaveLength(1);
    expect(Math.abs(r.alternatives[0]!.bpm - 2 * r.bpm!)).toBeLessThan(0.02);
    expect(r.alternatives[0]!.score).toBeLessThan(1);
  });

  it("128 BPM from 0.25 s, accent on beat 3 of the click train: the downbeat guess is the accented beat", () => {
    const { pcm, beats } = clickTrack({ bpm: 128, offset: 0.25, seconds: 20 });
    // Accent every fourth beat starting with the third click.
    const random = seeded(3);
    for (let k = 2; k < beats.length; k += 4) hit(pcm, beats[k]!, "kick", 0.8, random);
    const r = analyseRhythm(pcm, SR);
    expect(Math.abs(r.bpm! - 128)).toBeLessThan(0.3);
    expect(matched(r.beatTimes, beats, 0.01)).toEqual({ missing: 0, extra: 0 });
    expect(Math.abs(r.beatOffset! - beats[2]!)).toBeLessThan(0.01);
  });

  it("a half-time groove at 128 (kick on 1, snare on 3, hats on every beat) reports 128, with 64 as the alternative", () => {
    const seconds = 20;
    const pcm = new Float32Array(seconds * SR);
    const random = seeded(11);
    const beat = 60 / 128;
    const truth: number[] = [];
    for (let k = 0; 0.4 + k * beat < seconds - 0.3; k++) {
      const t = 0.4 + k * beat;
      truth.push(t);
      hit(pcm, t, "hat", 0.35, random);
      if (k % 4 === 0) hit(pcm, t, "kick", 0.9, random);
      if (k % 4 === 2) hit(pcm, t, "snare", 0.7, random);
    }
    const r = analyseRhythm(pcm, SR);
    expect(Math.abs(r.bpm! - 128)).toBeLessThan(0.5);
    expect(r.alternatives.some((a) => Math.abs(a.bpm - 64) < 0.5)).toBe(true);
    expect(matched(r.beatTimes, truth, 0.012).missing).toBe(0);
    // The kick is the downbeat.
    expect(Math.abs(r.beatOffset! - 0.4)).toBeLessThan(0.012);
  });

  it("the same pulse with only the kick and snare (nothing between) is a 64 BPM pulse, 128 the alternative", () => {
    const seconds = 24;
    const pcm = new Float32Array(seconds * SR);
    const random = seeded(5);
    const beat = 60 / 128;
    for (let k = 0; 0.4 + k * beat < seconds - 0.3; k++) {
      const t = 0.4 + k * beat;
      if (k % 4 === 0) hit(pcm, t, "kick", 0.9, random);
      if (k % 4 === 2) hit(pcm, t, "snare", 0.7, random);
    }
    const r = analyseRhythm(pcm, SR);
    expect(Math.abs(r.bpm! - 64)).toBeLessThan(0.5);
    expect(r.alternatives.some((a) => Math.abs(a.bpm - 128) < 0.5)).toBe(true);
  });

  it("minBpm and maxBpm bound the answer: 90 BPM asked within 100–200 is read at 180", () => {
    const { pcm } = clickTrack({ bpm: 90, offset: 0.3, seconds: 16 });
    const r = analyseRhythm(pcm, SR, { minBpm: 100, maxBpm: 200 });
    expect(Math.abs(r.bpm! - 180)).toBeLessThan(0.6);
  });

  it("noise has no confident tempo; silence has none at all", () => {
    const random = seeded(99);
    const noise = Float32Array.from({ length: 15 * SR }, () => (random() * 2 - 1) * 0.3);
    expect(analyseRhythm(noise, SR).confidence).toBeLessThan(0.45);
    const silence = analyseRhythm(new Float32Array(10 * SR), SR);
    expect(silence).toMatchObject({ bpm: null, confidence: 0, beatTimes: [], beatOffset: null });
  });

  it("strong onsets are the loud attacks, in time order, each to the millisecond scale", () => {
    const pcm = new Float32Array(6 * SR);
    const random = seeded(1);
    for (const t of [0.7, 1.9, 3.15, 4.6]) hit(pcm, t, "kick", 0.9, random);
    hit(pcm, 2.5, "hat", 0.05, random);
    const r = analyseRhythm(pcm, SR);
    const loud = r.strongOnsets.filter((o) => o.strength >= 0.5).map((o) => o.t);
    expect(loud).toHaveLength(4);
    [0.7, 1.9, 3.15, 4.6].forEach((t, i) => expect(Math.abs(loud[i]! - t)).toBeLessThan(0.006));
  });

  it("is deterministic and fast: 60 s analysed in well under two seconds", () => {
    const { pcm } = clickTrack({ bpm: 120, offset: 0.1, seconds: 60, accentEvery: 4 });
    const started = performance.now();
    const a = analyseRhythm(pcm, SR);
    const ms = performance.now() - started;
    expect(analyseRhythm(pcm, SR)).toEqual(a);
    expect(ms).toBeLessThan(2000);
    expect(Math.abs(a.bpm! - 120)).toBeLessThan(0.2);
  });
});

describe("the pieces", () => {
  it("the envelope peaks where an attack enters, and refineOnset finds the attack within a millisecond", () => {
    const pcm = new Float32Array(2 * SR);
    hit(pcm, 1.0, "click", 0.8, seeded(2));
    const { env, rate, t0 } = onsetEnvelope(pcm, SR);
    let at = 0;
    for (let i = 0; i < env.length; i++) if (env[i]! > env[at]!) at = i;
    expect(Math.abs(t0 + at / rate - 1.0)).toBeLessThan(0.03);
    expect(Math.abs(refineOnset(pcm, SR, t0 + at / rate, 0.03)! - 1.0)).toBeLessThan(0.001);
    expect(refineOnset(new Float32Array(SR), SR, 0.5, 0.03)).toBeUndefined();
  });

  it("estimateTempo needs two periods of signal; trackBeats spaces beats by the period", () => {
    expect(estimateTempo(new Float32Array(50), 172, 60, 200)).toBeNull();
    const env = new Float32Array(2000);
    for (let i = 10; i < env.length; i += 86) env[i] = 1;
    const beats = trackBeats(env, 86);
    const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
    expect(new Set(gaps)).toEqual(new Set([86]));
  });
});
