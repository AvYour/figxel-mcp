// figma_generate_audio's synthesizer, the WAV it writes, and the loudness it
// reports — pure, on float buffers. One block compares the loudness and true
// peak with ffmpeg's ebur128 when ffmpeg is installed.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyseRhythm, ANALYSIS_RATE } from "../src/server/audio-analysis.js";
import { limit, rng, SAMPLE_RATE, stereo, subSeed } from "../src/server/audio-dsp.js";
import { integratedLoudness, samplePeak, truePeak } from "../src/server/audio-loudness.js";
import { ebur128Args, parseEbur128 } from "../src/server/tools/audio.js";
import { CUE_DEFAULT_S, generate, layersFor, parseKey, planBed, type GenerateSpec } from "../src/server/audio-synth.js";
import { decodeWav, encodeWav } from "../src/server/wav.js";

const SR = SAMPLE_RATE;
const hash = (spec: GenerateSpec) => {
  const g = generate(spec);
  return createHash("sha256").update(encodeWav([g.audio.l, g.audio.r], SR, rng(subSeed(spec.seed, "dither")))).digest("hex");
};
/** The first sample index whose magnitude passes `floor`, either channel. */
const firstAbove = (l: Float32Array, r: Float32Array, floor: number) => {
  for (let i = 0; i < l.length; i++) if (Math.abs(l[i]!) > floor || Math.abs(r[i]!) > floor) return i;
  return -1;
};
const lastAbove = (l: Float32Array, r: Float32Array, floor: number) => {
  for (let i = l.length - 1; i >= 0; i--) if (Math.abs(l[i]!) > floor || Math.abs(r[i]!) > floor) return i;
  return -1;
};

describe("determinism", () => {
  const spec: GenerateSpec = {
    durationS: 6,
    seed: 42,
    bed: { style: "upbeat", bpm: 120, beatOffset: 0.2, sections: [{ from: 0, to: 2.2, energy: 0.3 }, { from: 2.2, to: 6, energy: 0.9 }] },
    cues: [{ t: 0.5, type: "whoosh", durationS: 0.4 }, { t: 2.2, type: "hit" }, { t: 4, type: "riser", durationS: 1 }],
  };

  it("the same spec and seed give the same bytes; another seed gives others", () => {
    expect(hash(spec)).toBe(hash(spec));
    expect(hash({ ...spec, seed: 43 })).not.toBe(hash(spec));
  });
});

describe("cues", () => {
  it("a tick and a hit start on the sample their time names, with nothing before", () => {
    const g = generate({ durationS: 4, seed: 1, cues: [{ t: 1, type: "tick" }, { t: 2.5, type: "hit" }] });
    expect(firstAbove(g.audio.l, g.audio.r, 1e-4)).toBe(SR * 1);
    const after = (from: number) => firstAbove(g.audio.l.subarray(from), g.audio.r.subarray(from), 0.02);
    // The tick has died away by 2.4 s; the hit begins exactly at 2.5 s.
    expect(after(Math.round(2.4 * SR)) + Math.round(2.4 * SR)).toBe(Math.round(2.5 * SR));
  });

  it("a riser ends at t + durationS, on its loudest stretch", () => {
    const g = generate({ durationS: 4, seed: 2, cues: [{ t: 1, type: "riser", durationS: 1.5, intensity: 1 }] });
    const end = Math.round(2.5 * SR);
    const last = lastAbove(g.audio.l, g.audio.r, 1e-4);
    expect(last).toBeLessThan(end);
    expect(last).toBeGreaterThanOrEqual(end - 3);
    const rms = (from: number) => {
      let s = 0;
      for (let i = from; i < from + 2400; i++) s += g.audio.l[i]! ** 2;
      return Math.sqrt(s / 2400);
    };
    const final = rms(end - 2400 - 150);
    for (let from = Math.round(1 * SR); from < end - 4800; from += 2400) expect(rms(from)).toBeLessThan(final);
  });

  it("every cue type renders inside its span; one past the end is cut with a warning, one after it left out", () => {
    const types = ["whoosh", "hit", "tick", "pop", "riser", "click", "swell", "drop"] as const;
    const g = generate({ durationS: 12, seed: 3, cues: [...types.map((type, i) => ({ t: i * 1.4, type })), { t: 11.5, type: "riser" as const }, { t: 13, type: "pop" as const }] });
    expect(g.cues.map((c) => c.type)).toEqual([...types, "riser"]);
    expect(g.cues.at(-1)).toMatchObject({ t: 11.5, durationS: 0.5 });
    expect(g.warnings.join(" ")).toMatch(/cues\[8\] \(riser at 11.5 s\) runs 1 s past the end; it is cut there/);
    expect(g.warnings.join(" ")).toMatch(/cues\[9\] \(pop at 13 s\) starts at or after the end/);
    for (const [i, type] of types.entries()) {
      const from = Math.round(i * 1.4 * SR);
      const span = Math.round(Math.min(1.4, CUE_DEFAULT_S[type]) * SR);
      expect(firstAbove(g.audio.l.subarray(from, from + span), g.audio.r.subarray(from, from + span), 1e-3), type).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the bed", () => {
  it("kicks fall exactly on the grid from the first downbeat; quiet sections drop the drums; a fill leads into a loud one", () => {
    const plan = planBed({ style: "minimal-tech", bpm: 120, beatOffset: 0.25, sections: [{ from: 0, to: 4.25, energy: 0.2 }, { from: 4.25, to: 12.25, energy: 0.9 }] }, 12);
    const kicks = plan.events.filter((e) => e.voice === "kick").map((e) => e.t);
    expect(kicks.length).toBeGreaterThan(0);
    for (const t of kicks) {
      const k = (t - 0.25) / 0.5;
      expect(Math.abs(k - Math.round(k)), String(t)).toBeLessThan(1e-9);
    }
    // Bars 0 and 1 (0.25–4.25 s) are at 0.2: pads and bass, no drums.
    expect(kicks.every((t) => t >= 4.25 - 1e-9)).toBe(true);
    expect(plan.sections.map((s) => s.energy)).toEqual([0.2, 0.9]);
    expect(plan.sections[0]!.layers).toEqual(["pad", "bass"]);
    expect(plan.sections[1]!.layers).toEqual(expect.arrayContaining(["kick", "hats", "clap", "pluck", "16th hats"]));
    // The fill: a snare roll in bar 1's last beat, a crash on bar 2's downbeat.
    expect(plan.events.filter((e) => e.voice === "snare" && e.bar === 1).map((e) => e.t)).toEqual([3.75, 3.875, 4, 4.125]);
    expect(plan.events.find((e) => e.voice === "crash")!.t).toBe(4.25);
    expect(plan).toMatchObject({ key: "A minor", chords: ["i", "i", "VI", "VII"], bars: 6 });
  });

  it("the rendered bed's beats, found by figma_analyze_audio's own analysis, sit on the grid", () => {
    const g = generate({ durationS: 16, seed: 9, bed: { style: "minimal-tech", bpm: 120, beatOffset: 0.25, intensity: 0.5 } });
    // 48 kHz to 11,025 Hz by linear interpolation is enough for onsets.
    const n = Math.floor((g.audio.l.length * ANALYSIS_RATE) / SR);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * SR) / ANALYSIS_RATE;
      const j = Math.floor(x);
      const f = x - j;
      const v = (k: number) => ((g.audio.l[k] ?? 0) + (g.audio.r[k] ?? 0)) / 2;
      mono[i] = v(j) * (1 - f) + v(j + 1) * f;
    }
    const r = analyseRhythm(mono, ANALYSIS_RATE);
    expect(Math.abs(r.bpm! - 120)).toBeLessThan(0.5);
    for (const t of r.beatTimes.slice(1, -1)) {
      const k = (t - 0.25) / 0.5;
      expect(Math.abs(k - Math.round(k)) * 0.5, String(t)).toBeLessThan(0.015);
    }
  });

  it("keys parse in the usual spellings, and a style's default key is used without one", () => {
    expect(parseKey("C minor")).toMatchObject({ root: 0, minor: true, name: "C minor" });
    expect(parseKey("F# major")).toMatchObject({ root: 6, minor: false });
    expect(parseKey("Bb min")).toMatchObject({ root: 10, minor: true, name: "Bb minor" });
    expect(parseKey("am")).toMatchObject({ root: 9, minor: true });
    expect(parseKey("E")).toMatchObject({ root: 4, minor: false });
    expect(parseKey("H minor")).toBeNull();
    expect(parseKey("C dorian")).toBeNull();
    expect(planBed({ style: "warm-corporate", bpm: 100 }, 8)).toMatchObject({ key: "C major", chords: ["I", "V", "vi", "IV"] });
    expect(planBed({ style: "ambient", bpm: 80, key: "E minor" }, 8).key).toBe("E minor");
  });

  it("energy decides the layers; ambient keeps its drums out until 0.6", () => {
    expect(layersFor("upbeat", 0.1)).toEqual(["pad"]);
    expect(layersFor("upbeat", 0.4)).toEqual(["pad", "bass", "kick", "hats"]);
    expect(layersFor("upbeat", 0.9)).toEqual(["pad", "bass", "kick", "hats", "clap", "pluck", "open hats", "16th hats"]);
    expect(layersFor("ambient", 0.5)).toEqual(["pad", "bass"]);
    expect(layersFor("warm-corporate", 0.6)).toEqual(["pad", "bass", "kick", "hats", "snare", "pluck"]);
  });
});

describe("level", () => {
  it("the limiter holds the true peak at −1 dBTP, and the report matches the buffer", () => {
    const g = generate({
      durationS: 8,
      seed: 5,
      bed: { style: "upbeat", bpm: 128, intensity: 1 },
      cues: [{ t: 1, type: "hit", intensity: 1 }, { t: 3, type: "drop", intensity: 1 }, { t: 5, type: "hit", intensity: 1 }],
    });
    expect(g.loudness.truePeakDbtp!).toBeLessThanOrEqual(-1);
    expect(truePeak(g.audio)).toBeLessThanOrEqual(-0.99);
    expect(Math.abs(truePeak(g.audio) - g.loudness.truePeakDbtp!)).toBeLessThan(0.06);
    expect(samplePeak(g.audio)).toBeLessThanOrEqual(-1);
    expect(g.loudness.integratedLufs!).toBeGreaterThan(-24);
    expect(g.loudness.integratedLufs!).toBeLessThan(-8);
  });

  it("the limiter never lets a sample past its ceiling", () => {
    const buf = stereo(4800);
    for (let i = 0; i < 4800; i++) buf.l[i] = buf.r[i] = Math.sin(i / 7) * (i > 2000 && i < 2100 ? 3 : 0.5);
    limit(buf, 0.5);
    expect(Math.max(...buf.l.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("silence has no integrated loudness", () => {
    expect(integratedLoudness(stereo(SR * 2))).toBe(Number.NEGATIVE_INFINITY);
    const g = generate({ durationS: 2, seed: 1 });
    expect(g.loudness).toMatchObject({ integratedLufs: null, truePeakDbtp: null });
  });

  it("30 s of bed and effects in a few seconds", () => {
    const started = performance.now();
    generate({
      durationS: 30,
      seed: 7,
      bed: { style: "warm-corporate", bpm: 100, sections: [{ from: 0, to: 10, energy: 0.4 }, { from: 10, to: 30, energy: 0.9 }] },
      cues: Array.from({ length: 12 }, (_, i) => ({ t: i * 2.4, type: (["whoosh", "hit", "tick", "riser"] as const)[i % 4]! })),
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("the WAV file", () => {
  it("is RIFF/WAVE PCM, 48 kHz, 16-bit, stereo, with sizes that add up, and reads back", () => {
    const g = generate({ durationS: 1.5, seed: 4, cues: [{ t: 0.1, type: "pop" }] });
    const wav = encodeWav([g.audio.l, g.audio.r], SR, rng(1));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect([wav.readUInt32LE(16), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34)]).toEqual([16, 1, 2, 48000, 192000, 4, 16]);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(1.5 * SR * 4);
    const back = decodeWav(wav);
    expect(back).toMatchObject({ sampleRate: 48000, bitsPerSample: 16 });
    expect(back.channels).toHaveLength(2);
    expect(back.channels[0]!.length).toBe(1.5 * SR);
    let worst = 0;
    for (let i = 0; i < back.channels[0]!.length; i++) worst = Math.max(worst, Math.abs(back.channels[0]![i]! - g.audio.l[i]!));
    expect(worst).toBeLessThan(3 / 32768);
  });
});

// ── against ffmpeg's ebur128, when this machine has it ───────────────────────

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("loudness against ffmpeg", () => {
  it("integrated loudness within 0.3 LU and true peak within 0.3 dB of ebur128", () => {
    const g = generate({ durationS: 12, seed: 8, bed: { style: "upbeat", bpm: 120, intensity: 0.9 }, cues: [{ t: 2, type: "hit" }, { t: 6, type: "whoosh" }] });
    const dir = mkdtempSync(join(tmpdir(), "fmcp-loud-"));
    const file = join(dir, "bed.wav");
    writeFileSync(file, encodeWav([g.audio.l, g.audio.r], SR, rng(2)));
    const log = spawnSync("ffmpeg", ebur128Args(file), { windowsHide: true, encoding: "utf8" }).stderr;
    const theirs = parseEbur128(log);
    expect(theirs.integratedLufs).not.toBeNull();
    expect(Math.abs(theirs.integratedLufs! - g.loudness.integratedLufs!)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(theirs.truePeakDbtp! - g.loudness.truePeakDbtp!)).toBeLessThanOrEqual(0.3);
    expect(theirs.truePeakDbtp!).toBeLessThanOrEqual(-0.9);
  });
});
