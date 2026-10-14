// The per-frame metrics behind figma_review_video, on synthetic grey frames:
// each defect class the 2026-10-09 critics measured by hand [C-247] — a
// freeze, a one-frame flicker, a flash, a spike — and the exemptions an agent
// declares: cuts and holds.

import { describe, expect, it } from "vitest";
import { analyse, analysisHeight, DEFAULT_THRESHOLDS, FrameMeter, type Series } from "../src/server/video-metrics.js";

const SIZE = 100;

/** A flat grey frame. */
const flat = (v: number) => new Uint8Array(SIZE).fill(v);
/** The first `share` of the pixels at `hi`, the rest at `lo`. */
const part = (share: number, hi: number, lo: number) => {
  const f = new Uint8Array(SIZE).fill(lo);
  f.fill(hi, 0, Math.round(share * SIZE));
  return f;
};

function measure(frames: Uint8Array[]): Series {
  const m = new FrameMeter(SIZE);
  for (const f of frames) m.push(f);
  return m.series;
}

/** A slow ramp: one grey level every frame, so nothing is still and nothing jumps. */
const ramp = (from: number, n: number) => Array.from({ length: n }, (_, i) => flat(from + i));

describe("FrameMeter", () => {
  it("measures diff, changed share, luma and the skip between a frame's neighbours", () => {
    const s = measure([flat(10), part(0.5, 30, 10), flat(10)]);
    expect(s.luma).toEqual([10, 20, 10]);
    expect(s.diff).toEqual([0, 10, 10]);
    expect(s.changed).toEqual([0, 0.5, 0.5]);
    expect(s.skip[1]).toBe(0); // frames 0 and 2 are identical
    expect(s.skip[0]).toBeUndefined();
    expect(s.skip[2]).toBeUndefined();
  });

  it("refuses a frame of the wrong size", () => {
    expect(() => new FrameMeter(SIZE).push(new Uint8Array(SIZE - 1))).toThrow(/expected 100/);
  });

  it("an 8-level step is codec noise, a 9-level step is a changed pixel", () => {
    expect(measure([flat(0), flat(8)]).changed[1]).toBe(0);
    expect(measure([flat(0), flat(9)]).changed[1]).toBe(1);
  });

  it("derives an even analysis height from the aspect ratio", () => {
    expect(analysisHeight(1080, 1920)).toBe(480);
    expect(analysisHeight(1920, 1080)).toBe(152);
    expect(analysisHeight(1080, 1080)).toBe(270);
  });
});

describe("analyse", () => {
  it("a still stretch of 0.5 s or more is a freeze, with its frames and length", () => {
    // Frames 10–29 identical: 20 frames shown = 0.67 s at 30 fps.
    const frames = [...ramp(0, 10), ...Array.from({ length: 20 }, () => flat(10)), ...ramp(11, 10)];
    const { metrics, findings } = analyse(measure(frames), { fps: 30 });
    expect(metrics.freezes).toEqual([{ from: 10, to: 29, s: 0.67, meanDiff: 0 }]);
    expect(findings.filter((f) => f.kind === "freeze")).toMatchObject([{ severity: "warning", frames: [10, 29] }]);
  });

  it("a still stretch shorter than minFreezeS is not a freeze; the boundary counts", () => {
    const short = [...ramp(0, 5), ...Array.from({ length: 14 }, () => flat(5)), ...ramp(6, 5)]; // 14 frames = 0.47 s
    expect(analyse(measure(short), { fps: 30 }).metrics.freezes).toEqual([]);
    const exact = [...ramp(0, 5), ...Array.from({ length: 15 }, () => flat(5)), ...ramp(6, 5)]; // 15 frames = 0.5 s
    expect(analyse(measure(exact), { fps: 30 }).metrics.freezes).toEqual([{ from: 5, to: 19, s: 0.5, meanDiff: 0 }]);
  });

  it("a declared hold is not a freeze; the part outside it still is", () => {
    const frames = [...ramp(0, 5), ...Array.from({ length: 40 }, () => flat(5)), ...ramp(6, 5)]; // still on 5–44
    expect(analyse(measure(frames), { fps: 30, holds: [{ fromFrame: 5, toFrame: 44 }] }).metrics.freezes).toEqual([]);
    expect(analyse(measure(frames), { fps: 30, holds: [{ fromFrame: 5, toFrame: 24 }] }).metrics.freezes).toEqual([{ from: 24, to: 44, s: 0.7, meanDiff: 0 }]);
  });

  it("a frame unlike both neighbours, which match each other, flickers", () => {
    // The run's punch frame: about 1.5 from both neighbours, which are 0.2 apart.
    const frames = [...ramp(0, 5), part(0.5, 7, 4), flat(4), ...ramp(5, 5)];
    // frame 5 differs from 4 (luma 4) and 6 (luma 4) by 1.5; 4 and 6 are equal.
    const { metrics, findings } = analyse(measure(frames), { fps: 30 });
    expect(metrics.flickers).toEqual([{ frame: 5, diff: 1.5, skip: 0 }]);
    expect(findings.find((f) => f.kind === "flicker")).toMatchObject({ severity: "warning", frames: [4, 6] });
  });

  it("a frame that moves on is not a flicker: its neighbours differ", () => {
    const frames = [flat(0), flat(2), flat(4), flat(6)];
    expect(analyse(measure(frames), { fps: 30 }).metrics.flickers).toEqual([]);
  });

  it("a single white frame is one flash, not a flash, a return flash and a flicker", () => {
    const frames = [...ramp(50, 5), flat(250), ...ramp(55, 5)];
    const { metrics, findings } = analyse(measure(frames), { fps: 30 });
    expect(metrics.flashes).toEqual([{ frame: 5, lumaJump: 196, changed: 1 }]);
    expect(metrics.flickers).toEqual([]);
    expect(metrics.cuts).toEqual([]);
    expect(findings.map((f) => f.kind)).toEqual(["flash"]);
  });

  it("a flash needs the whole picture: a bright patch is a spike instead", () => {
    const frames = [flat(20), flat(20), part(0.5, 120, 20), part(0.5, 120, 20)];
    const { metrics } = analyse(measure(frames), { fps: 30 });
    expect(metrics.flashes).toEqual([]);
    expect(metrics.spikes).toEqual([{ frame: 2, diff: 50, changed: 0.5 }]);
  });

  it("a jump on a declared cut is the cut: no flash, no spike, reported with its diff", () => {
    const frames = [flat(20), flat(20), flat(200), flat(200)];
    const declared = analyse(measure(frames), { fps: 30, cuts: [2] });
    expect(declared.metrics.flashes).toEqual([]);
    expect(declared.metrics.cuts).toEqual([{ frame: 2, diff: 180, declared: true }]);
    expect(declared.findings).toEqual([]);
    const undeclared = analyse(measure(frames), { fps: 30 });
    expect(undeclared.metrics.flashes).toMatchObject([{ frame: 2, lumaJump: 180 }]);
  });

  it("a hard change of the whole picture at the same brightness is an undeclared cut", () => {
    const a = new Uint8Array(SIZE).map((_, i) => (i % 2 ? 200 : 20));
    const b = new Uint8Array(SIZE).map((_, i) => (i % 2 ? 20 : 200));
    const { metrics, findings } = analyse(measure([a, a, b, b]), { fps: 30 });
    expect(metrics.flashes).toEqual([]);
    expect(metrics.spikes).toEqual([]);
    expect(metrics.cuts).toEqual([{ frame: 2, diff: 180, declared: false }]);
    expect(findings).toMatchObject([{ kind: "undeclared_cut", severity: "info", frames: [1, 2] }]);
  });

  it("a declared cut that lands a frame late is a finding", () => {
    const frames = [flat(20), flat(20), flat(20), flat(200), flat(200)];
    const { findings } = analyse(measure(frames), { fps: 30, cuts: [2] });
    expect(findings).toMatchObject([{ kind: "cut_off_frame", severity: "warning", frames: [2, 3] }]);
    expect(findings[0]!.detail).toMatch(/one frame late/);
  });

  it("a cut outside the video is ignored, with a note", () => {
    const { metrics, findings } = analyse(measure([flat(0), flat(0)]), { fps: 30, cuts: [7] });
    expect(metrics.cuts).toEqual([]);
    expect(findings).toMatchObject([{ kind: "cut_outside", severity: "info", frames: [7] }]);
  });

  it("thresholds can be overridden one at a time", () => {
    const frames = [flat(20), flat(20), part(0.5, 40, 20), part(0.5, 40, 20)];
    expect(analyse(measure(frames), { fps: 30 }).metrics.spikes).toEqual([]); // diff 10 < 20
    expect(analyse(measure(frames), { fps: 30, thresholds: { spike: 10 } }).metrics.spikes).toEqual([{ frame: 2, diff: 10, changed: 0.5 }]);
    expect(DEFAULT_THRESHOLDS).toEqual({ freeze: 0.15, minFreezeS: 0.5, flicker: 1, flashLuma: 40, spike: 20 });
  });

  it("summarises the steps: mean, p95, max and where the max is", () => {
    const frames = [flat(0), flat(1), flat(2), flat(12), flat(13)];
    const { metrics } = analyse(measure(frames), { fps: 30 });
    expect(metrics.diff).toEqual([0, 1, 1, 10, 1]);
    expect(metrics.summary).toEqual({ mean: 3.25, p95: 10, max: 10, maxFrame: 3 });
    expect(metrics.analysisWidth).toBe(270);
  });
});
