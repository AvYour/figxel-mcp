// Gradient angle and centre ⇄ gradientTransform [C-100].
//
// Two points are pinned by evidence, not by the model: the identity runs left →
// right through the vertical centre (Figma's own SVG export, [C-057]), which is
// CSS 90deg; and [[0,1,0],[-1,0,1]] runs top → bottom (Figma's figma-use skill).
// Everything else here checks the model is self-consistent: a written angle
// reads back as itself, the end stops sit where CSS puts them, and the colour
// bands stay square to the direction on screen. Whether Figma agrees for the
// angles in between is a live measurement, not something a unit test can know.

import { describe, expect, it } from "vitest";
import { linearTransform, radialTransform, transformAngle, transformCenter, transformFromList, type Transform } from "../src/plugin/gradient.js";

const IDENTITY: Transform = [
  [1, 0, 0],
  [0, 1, 0],
];

function expectMatrix(actual: Transform, expected: Transform) {
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) expect(actual[r]![c]).toBeCloseTo(expected[r]![c]!, 9);
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** T⁻¹ applied to a gradient-space point, in pixels of a w×h node. */
function onNode(t: Transform, u: number, v: number, w: number, h: number) {
  const [[a, b, c], [d, e, f]] = t;
  const det = a * e - b * d;
  const x = (e * (u - c) - b * (v - f)) / det;
  const y = (a * (v - f) - d * (u - c)) / det;
  return { x: x * w, y: y * h };
}

describe("linearTransform", () => {
  it("90deg is exactly the identity on any box — the measured left → right [C-057]", () => {
    for (const [w, h] of [[400, 240], [100, 100], [1, 1], [240, 400]] as const) expectMatrix(linearTransform(90, w, h), IDENTITY);
  });

  it("90deg writes the identity exactly, not to within float noise — what a gradient with no angle always wrote", () => {
    for (const [w, h] of [[400, 240], [240, 400], [1280, 720], [3, 7]] as const) expect(linearTransform(90, w, h)).toEqual(IDENTITY);
  });

  it("180deg on a square is [[0,1,0],[-1,0,1]], Figma's own top → bottom", () => {
    expectMatrix(linearTransform(180, 400, 400), [
      [0, 1, 0],
      [-1, 0, 1],
    ]);
  });

  it("180deg on 400×240 runs from the top centre to the bottom centre — what the live SVG check expects", () => {
    const t = linearTransform(180, 400, 240);
    const start = onNode(t, 0, 0.5, 400, 240);
    const end = onNode(t, 1, 0.5, 400, 240);
    expect(start.x).toBeCloseTo(200, 6);
    expect(start.y).toBeCloseTo(0, 6);
    expect(end.x).toBeCloseTo(200, 6);
    expect(end.y).toBeCloseTo(240, 6);
  });

  it("puts the end stops where CSS does: through the centre, |w sinθ| + |h cosθ| apart", () => {
    const t = linearTransform(45, 400, 240);
    const start = onNode(t, 0, 0.5, 400, 240);
    const end = onNode(t, 1, 0.5, 400, 240);
    const half = (400 * Math.SQRT1_2 + 240 * Math.SQRT1_2) / 2;
    expect(start.x).toBeCloseTo(200 - half * Math.SQRT1_2, 6);
    expect(start.y).toBeCloseTo(120 + half * Math.SQRT1_2, 6);
    expect(end.x).toBeCloseTo(200 + half * Math.SQRT1_2, 6);
    expect(end.y).toBeCloseTo(120 - half * Math.SQRT1_2, 6);
  });

  it("keeps the colour bands square to the direction on screen, not in the normalised box", () => {
    const [w, h] = [400, 240];
    const t = linearTransform(30, w, h);
    const o = onNode(t, 0, 0, w, h);
    const along = onNode(t, 1, 0, w, h);
    const across = onNode(t, 0, 1, w, h);
    const dot = (along.x - o.x) * (across.x - o.x) + (along.y - o.y) * (across.y - o.y);
    expect(dot).toBeCloseTo(0, 6);
  });

  it("gives two boxes different transforms for one angle", () => {
    expect(linearTransform(45, 400, 240)).not.toEqual(linearTransform(45, 240, 400));
  });

  it("measures a zero-height node (a line) as 1 instead of dividing by zero", () => {
    expect(linearTransform(45, 300, 0).flat().every(Number.isFinite)).toBe(true);
  });

  it("refuses an angle that is not a number", () => {
    expect(caught(() => linearTransform(Number.NaN, 100, 100))).toMatchObject({ code: "INVALID_PARAM" });
  });
});

describe("transformAngle", () => {
  it("reads the identity as 90deg and Figma's top → bottom as 180deg", () => {
    expect(transformAngle(IDENTITY, 400, 240)).toBe(90);
    expect(
      transformAngle(
        [
          [0, 1, 0],
          [-1, 0, 1],
        ],
        400,
        400,
      ),
    ).toBe(180);
  });

  it("reads back every angle it writes, on a box that is not square", () => {
    for (const a of [0, 45, 90, 135, 180, 270]) expect(transformAngle(linearTransform(a, 400, 240), 400, 240)).toBeCloseTo(a, 6);
  });

  it("reports the normal of the colour bands after the node was resized, not the handle direction", () => {
    // Drawn at 45deg on a square, then the frame is made twice as wide: the
    // transform is unchanged (it lives in the normalised box), the bands are not.
    const t = linearTransform(45, 100, 100);
    const deg = transformAngle(t, 200, 100)!;
    const o = onNode(t, 0, 0, 200, 100);
    const across = onNode(t, 0, 1, 200, 100);
    const rad = (deg * Math.PI) / 180;
    const len = Math.hypot(across.x - o.x, across.y - o.y);
    const cosine = (Math.sin(rad) * (across.x - o.x) - Math.cos(rad) * (across.y - o.y)) / len;
    expect(cosine).toBeCloseTo(0, 6);
    expect(deg).not.toBeCloseTo(45, 1);
  });

  it("is undefined for a transform with no direction or a malformed one", () => {
    expect(
      transformAngle(
        [
          [0, 0, 0.5],
          [0, 1, 0],
        ],
        100,
        100,
      ),
    ).toBeUndefined();
    expect(transformAngle([[1, 0, Number.NaN] as unknown as [number, number, number], [0, 1, 0]], 100, 100)).toBeUndefined();
    expect(transformAngle("not a matrix" as unknown as Transform, 100, 100)).toBeUndefined();
  });
});

describe("radialTransform and transformCenter", () => {
  it("a centred radius of 0.5 is the identity — Figma's default ellipse", () => {
    expectMatrix(radialTransform({ x: 0.5, y: 0.5 }, 0.5, 400, 240), IDENTITY);
    expect(transformCenter(IDENTITY)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("reads back the centre it writes", () => {
    const c = transformCenter(radialTransform({ x: 0.25, y: 0.75 }, 0.3, 400, 240))!;
    expect(c.x).toBeCloseTo(0.25, 9);
    expect(c.y).toBeCloseTo(0.75, 9);
  });

  it("places the official skill's 'large, offset' radial just left of centre", () => {
    const c = transformCenter([
      [0.71, 0, 0.19],
      [0, 0.57, 0.21],
    ])!;
    expect(c.x).toBeCloseTo(0.31 / 0.71, 6);
    expect(c.y).toBeCloseTo(0.29 / 0.57, 6);
  });

  it("snaps float noise off a centre it reads back", () => {
    expect(transformCenter(radialTransform({ x: 0.3, y: 0.7 }, 0.5, 100, 100))).toEqual({ x: 0.3, y: 0.7 });
  });

  it("refuses a radius that is not positive, and reads a singular transform as no centre", () => {
    expect(caught(() => radialTransform({ x: 0.5, y: 0.5 }, 0, 100, 100))).toMatchObject({ code: "INVALID_PARAM" });
    expect(
      transformCenter([
        [1, 2, 0],
        [2, 4, 0],
      ]),
    ).toBeUndefined();
  });
});

describe("transformFromList — the raw escape hatch", () => {
  it("reads six numbers as the two rows", () => {
    expect(transformFromList([0, 1, 0, -1, 0, 1])).toEqual([
      [0, 1, 0],
      [-1, 0, 1],
    ]);
  });

  it("refuses the wrong count, a non-number, and a singular matrix, naming the field", () => {
    expect(caught(() => transformFromList([1, 0, 0, 0, 1], "fills[0].gradient.transform"))).toMatchObject({
      code: "INVALID_PARAM",
      message: expect.stringMatching(/^`fills\[0\]\.gradient\.transform` must be six numbers/),
    });
    expect(caught(() => transformFromList([1, 0, 0, 0, "1", 0]))).toMatchObject({ code: "INVALID_PARAM" });
    expect(caught(() => transformFromList([1, 0, 0, 0, Number.NaN, 0]))).toMatchObject({ code: "INVALID_PARAM" });
    expect(caught(() => transformFromList([1, 2, 0, 2, 4, 0]))).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/singular/) });
  });
});
