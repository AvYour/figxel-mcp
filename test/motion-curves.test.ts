// The curve evaluation, frame sampling and cut pairs that figma_check_motion
// judges with and figma_create_animatic writes with (src/shared/motion-curves.ts).

import { describe, expect, it } from "vitest";
import {
  compileKeys,
  cubicBezier,
  cutPairKeys,
  cutPairTimes,
  easingCurve,
  expectedFrames,
  findCutPairs,
  frameAtOrAfter,
  frameAtOrBefore,
  frameTime,
  gridOffset,
  isCutPair,
  keptDuration,
  lastFrame,
  parseKeyValue,
  sampleFrames,
  valueAt,
  valueWithEasing,
} from "../src/shared/motion-curves.js";

/** CSS cubic-bezier solved by brute force: bisection on the curve parameter, independent of the code under test. */
function reference(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const b = (p1: number, p2: number, s: number) => 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (b(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return b(y1, y2, (lo + hi) / 2);
}

describe("cubic easing is CSS cubic-bezier [C-193]", () => {
  const curves: Array<[number, number, number, number]> = [
    [0.25, 0.1, 0.25, 1], // CSS ease
    [0.16, 1, 0.3, 1], // the run's arrivals
    [0.7, 0, 0.84, 0], // the run's exits
    [0.65, 0, 0.35, 1], // DRAW
    [0.34, 1.56, 0.64, 1], // an overshoot
    [0, 0, 1, 1], // linear
  ];

  it("matches an independent solve to 1e-6 across the segment", () => {
    for (const [x1, y1, x2, y2] of curves) {
      const f = cubicBezier(x1, y1, x2, y2);
      for (let i = 0; i <= 40; i++) {
        const x = i / 40;
        expect(Math.abs(f(x) - reference(x1, y1, x2, y2, x))).toBeLessThan(1e-6);
      }
    }
  });

  it("symmetric curves pass through the middle; the ends are exact and clamped", () => {
    expect(cubicBezier(0.42, 0, 0.58, 1)(0.5)).toBeCloseTo(0.5, 9);
    expect(cubicBezier(0.65, 0, 0.35, 1)(0.5)).toBeCloseTo(0.5, 9);
    const out = cubicBezier(0.16, 1, 0.3, 1);
    expect([out(0), out(1), out(-0.5), out(1.5)]).toEqual([0, 1, 0, 1]);
  });

  it("reproduces the run's render: the width of 'down.' on frames 34–39 at k/30, to the pixel", () => {
    // S1/Down in the r2 build punched SCALE_XY 1 → 1.06 (cubic:0.33,0,0.67,1) → 1 (cubic:0.16,1,0.3,1);
    // the round-3 critic measured its width in the exported frames as 732, 754, 776, 755, 743, 737
    // (2026-10-09 journal, line 55). Evaluating the keys at k / 30 gives the same widths.
    const keys = compileKeys([
      { t: 0, value: "1,1" },
      { t: 1.1333, value: "1,1", easing: "LINEAR" },
      { t: 1.2, value: "1.06,1.06", easing: "cubic:0.33,0,0.67,1" },
      { t: 1.5333, value: "1,1", easing: "cubic:0.16,1,0.3,1" },
    ]);
    const widths = [34, 35, 36, 37, 38, 39].map((k) => 732 * valueAt(keys, frameTime(k, 30))![0]!);
    [732, 754, 776, 755, 743, 737].forEach((w, i) => expect(Math.abs(widths[i]! - w)).toBeLessThanOrEqual(1));
  });
});

describe("easings by name", () => {
  it("only LINEAR and cubic are exact; named presets and springs are stand-ins [C-190]", () => {
    expect(easingCurve("LINEAR")).toMatchObject({ kind: "linear", exact: true });
    expect(easingCurve(undefined)).toMatchObject({ kind: "linear", exact: true });
    expect(easingCurve("cubic:0.4,0,0.2,1")).toMatchObject({ kind: "cubic", exact: true, overshoot: false });
    expect(easingCurve("cubic:0.34,1.56,0.64,1")).toMatchObject({ kind: "cubic", exact: true, overshoot: true });
    expect(easingCurve("EASE_OUT")).toMatchObject({ kind: "named", exact: false, overshoot: false });
    expect(easingCurve("EASE_IN_BACK")).toMatchObject({ kind: "named", exact: false, overshoot: true });
    expect(easingCurve("BOUNCY")).toMatchObject({ kind: "spring", exact: false, overshoot: true });
    expect(easingCurve("spring:0")).toMatchObject({ kind: "spring", overshoot: false });
    expect(easingCurve("spring:0.4")).toMatchObject({ kind: "spring", overshoot: true });
    expect(easingCurve("var:VariableID:1:2")).toMatchObject({ kind: "unknown", exact: false });
  });

  it("every stand-in starts at 0, ends at 1, and a bouncy spring overshoots", () => {
    for (const e of ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "GENTLE", "QUICK", "BOUNCY", "SLOW", "spring:0.3"]) {
      const c = easingCurve(e).curve;
      expect([c(0), c(1)]).toEqual([0, 1]);
    }
    const bouncy = easingCurve("BOUNCY").curve;
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => bouncy(i / 50)))).toBeGreaterThan(1);
  });

  it("HOLD keeps the old value until its key and steps at it, as measured on one probe [C-189]; it stays flagged, never exact", () => {
    const keys = compileKeys([
      { t: 0, value: "0" },
      { t: 1, value: "10", easing: "HOLD" },
    ]);
    expect(easingCurve("HOLD")).toMatchObject({ kind: "hold", exact: false });
    expect(valueAt(keys, 0.99)).toEqual([0]);
    expect(valueAt(keys, 1)).toEqual([10]);
  });
});

describe("values and tracks", () => {
  it("parses the string forms figma_get_motion_context reads", () => {
    expect(parseKeyValue("120")).toEqual([120]);
    expect(parseKeyValue("-156,110")).toEqual([-156, 110]);
    expect(parseKeyValue("#ff000080")).toEqual([1, 0, 0, 128 / 255]);
    expect(parseKeyValue("#fff")).toEqual([1, 1, 1, 1]);
    expect(parseKeyValue("true")).toBeNull();
    expect(parseKeyValue("")).toBeNull();
    expect(parseKeyValue("1,")).toBeNull();
  });

  it("holds the first value before the first key and the last after the last [C-191]", () => {
    const keys = compileKeys([
      { t: 1, value: "5" },
      { t: 2, value: "15", easing: "LINEAR" },
    ]);
    expect(valueAt(keys, 0)).toEqual([5]);
    expect(valueAt(keys, 1.5)).toEqual([10]);
    expect(valueAt(keys, 9)).toEqual([15]);
    expect(valueAt([], 1)).toBeNull();
  });

  it("sorts keys, interpolates vectors and colours per component, and a segment's curve is its end key's easing", () => {
    const keys = compileKeys([
      { t: 1, value: "10,20", easing: "cubic:0.7,0,0.84,0" },
      { t: 0, value: "0,0" },
    ]);
    expect(keys.map((k) => k.t)).toEqual([0, 1]);
    const v = valueAt(keys, 0.5)!;
    const y = cubicBezier(0.7, 0, 0.84, 0)(0.5);
    expect(v[0]).toBeCloseTo(10 * y, 9);
    expect(v[1]).toBeCloseTo(20 * y, 9);
    const colour = compileKeys([
      { t: 0, value: "#000000" },
      { t: 1, value: "#ffffff" },
    ]);
    expect(valueAt(colour, 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("valueWithEasing changes one segment only: how a fix is tried", () => {
    const keys = compileKeys([
      { t: 0, value: "0" },
      { t: 1, value: "100", easing: "cubic:0.7,0,0.84,0" },
      { t: 2, value: "0", easing: "cubic:0.7,0,0.84,0" },
    ]);
    const soft = "cubic:0.45,0,0.55,1";
    expect(valueWithEasing(keys, 1, soft, 0.5)![0]).toBeCloseTo(100 * cubicBezier(0.45, 0, 0.55, 1)(0.5), 9);
    expect(valueWithEasing(keys, 1, soft, 1.5)).toEqual(valueAt(keys, 1.5));
  });
});

describe("frames: frame k is sampled at k / fps [C-193], and the end frame renders [C-194]", () => {
  it("a 14.4 s timeline at 30 fps is frames 0–432, 433 frames", () => {
    expect(frameTime(108, 30)).toBeCloseTo(3.6, 12);
    expect(lastFrame(14.4, 30)).toBe(432);
    expect(expectedFrames(14.4, 30)).toBe(433);
    expect(expectedFrames(2, 24)).toBe(49);
  });

  it("every format ends on the first frame at or after the end: 1.2 s at 12 fps rendered 16 frames, not 15", () => {
    // spikes/results/live-motion-semantics.json (2026-10-13): GIF@12 decoded 16 frames, k / 12 for
    // k = 0…15; MP4@24/30/60 decoded 30/37/73, and a GIF@24 of the same 1.2 s held 30.
    expect(lastFrame(1.2, 12)).toBe(15);
    expect(expectedFrames(1.2, 12)).toBe(16);
    expect(expectedFrames(1.2, 24)).toBe(30);
    expect(expectedFrames(1.2, 30)).toBe(37);
    expect(expectedFrames(1.2, 60)).toBe(73);
    // A whole number of frames stays whole through float noise.
    expect(expectedFrames(108 / 30, 30)).toBe(109);
    expect(expectedFrames(14.4, 30)).toBe(433);
  });

  it("counts the duration Figma keeps, to the microsecond: a timeline meant to end on a frame can end a hair past it", () => {
    // spikes/results/live-animatic.json (2026-10-13): 86/24 s read back 3.583333, and the dissolve
    // board's 89/30 s, kept as 2.966667 s (89.00001 frames), rendered 91 MP4 frames where round gives 90.
    expect(keptDuration(86 / 24)).toBe(3.583333);
    expect(keptDuration(89 / 30)).toBe(2.966667);
    expect(expectedFrames(86 / 24, 24)).toBe(87);
    expect(expectedFrames(89 / 30, 30)).toBe(91);
    // The plugin reports a duration to 0.1 ms; the count is the same.
    expect(expectedFrames(3.5833, 24)).toBe(87);
    expect(expectedFrames(2.9667, 30)).toBe(91);
    // A hundredth of a frame short of frame E − 1 is E frames (figma_create_animatic's END_MARGIN).
    expect(expectedFrames((210 - 1 - 0.01) / 30, 30)).toBe(210);
    expect(expectedFrames(6.9663, 30)).toBe(210);
  });

  it("a key stored to 0.1 ms still names its frame; a key between frames does not", () => {
    // 1.2667 s is frame 38 at 30 fps, stored rounded: 38.001.
    expect(frameAtOrAfter(1.2667, 30)).toBe(38);
    expect(frameAtOrBefore(1.2667, 30)).toBe(38);
    expect(frameAtOrAfter(1.25, 30)).toBe(38);
    expect(frameAtOrBefore(1.25, 30)).toBe(37);
    expect(gridOffset(1.2667, 30)).toBeLessThan(0.02);
    expect(gridOffset(1.25, 30)).toBeCloseTo(0.5, 9);
  });

  it("samples every frame from 0 to the last", () => {
    const keys = compileKeys([
      { t: 0, value: "0" },
      { t: 0.1, value: "3" },
    ]);
    expect(sampleFrames(keys, 30, 4).map((v) => Math.round(v![0]! * 1000) / 1000)).toEqual([0, 1, 2, 3, 3]);
  });
});

describe("cut pairs switch on an exact frame at any frame rate [C-240]", () => {
  for (const fps of [24, 30, 60]) {
    it(`at ${fps} fps, frame k − 1 shows the old value and frame k the new one`, () => {
      for (const k of [1, 10, 108]) {
        const pair = cutPairKeys(k, fps, "0", "1");
        expect(pair.every((p) => p.easing === "LINEAR")).toBe(true);
        expect(pair.map((p) => p.t)).toEqual(cutPairTimes(k, fps));
        const keys = compileKeys([{ t: 0, value: "0" }, ...pair]);
        expect(valueAt(keys, frameTime(k - 1, fps))).toEqual([0]);
        expect(valueAt(keys, frameTime(k, fps))).toEqual([1]);
        expect(findCutPairs(keys, fps)).toEqual([{ index: 2, frame: k, clean: true }]);
      }
    });
  }

  it("is the run's own form at 30 fps: k/30 − 0.025 and k/30 − 0.005", () => {
    expect(cutPairTimes(108, 30)).toEqual([3.575, 3.595]);
  });

  it("a pair straddling a frame is a cut that shows an in-between value; a frame or more apart is a move", () => {
    const straddle = compileKeys([
      { t: 0, value: "0" },
      { t: 3.33, value: "0" },
      { t: 3.35, value: "1", easing: "LINEAR" },
    ]);
    expect(findCutPairs(straddle, 30)).toEqual([{ index: 2, frame: 101, clean: false }]);
    expect(isCutPair({ t: 0, value: "0" }, { t: 1 / 30, value: "1", easing: "LINEAR" }, 30)).toBe(false);
    expect(isCutPair({ t: 0, value: "0" }, { t: 0.02, value: "1", easing: "cubic:0.4,0,0.2,1" }, 30)).toBe(false);
    expect(isCutPair({ t: 0, value: "1" }, { t: 0.02, value: "1", easing: "LINEAR" }, 30)).toBe(false);
  });

  it("refuses a cut on the first frame, which has no frame before it", () => {
    expect(() => cutPairKeys(0, 30, "0", "1")).toThrow(/after the first/);
  });
});
