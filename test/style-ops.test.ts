// The style ops — fills, strokes, corner radius, effects — against a fake
// `figma` whose nodes carry exactly the properties Figma gives their type, so
// "this node cannot take that" is decided the way the Plugin API decides it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { STYLE_OPS, toEffect, toPaint, toPaintFor } from "../src/plugin/ops/style.js";
import { linearTransform } from "../src/plugin/gradient.js";
import { registerStyle } from "../src/server/tools/style.js";
import type { Bridge } from "../src/server/bridge.js";

type Node = Record<string, unknown> & { id: string; type: string };
let nodes: Map<string, Node>;
let images: Set<string>;

const frame = (id: string, width = 100, height = 100): Node => ({
  id, type: "FRAME", width, height, fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", dashPattern: [],
  strokeCap: "NONE", strokeJoin: "MITER", strokeTopWeight: 1, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1,
  cornerRadius: 0, cornerSmoothing: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0, effects: [],
});
const group = (id: string): Node => ({ id, type: "GROUP", effects: [] }); // no fills, no strokes, no corners
// An ellipse has one stroke weight and one radius: no per-side weights, no dashes in this fake.
const ellipse = (id: string): Node => ({
  id, type: "ELLIPSE", width: 50, height: 50, fills: [], strokes: [], strokeWeight: 1, strokeCap: "NONE", strokeJoin: "MITER",
  cornerRadius: 0, cornerSmoothing: 0,
});

beforeEach(() => {
  nodes = new Map([frame("1:1"), frame("1:2", 400, 240), group("1:3"), ellipse("1:4")].map((n) => [n.id, n]));
  images = new Set(["img-1"]);
  (globalThis as { figma?: unknown }).figma = {
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    getImageByHash: (hash: string) => (images.has(hash) ? { hash } : null),
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r-1", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const run = (op: string, params: Record<string, unknown>) =>
  STYLE_OPS[op]!.run(ctx(params)) as Promise<{ updated: number; items: { id: string; ok: boolean; error?: string }[] }>;
async function rejects(op: string, params: Record<string, unknown>): Promise<BridgeError> {
  try {
    await run(op, params);
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a rejection");
}

describe("toPaint — one fills[] entry", () => {
  it("hex, with #rrggbbaa alpha folded into opacity", () => {
    expect(toPaint({ color: "#ff0000" }, 0)).toEqual({ type: "SOLID", color: { r: 1, g: 0, b: 0 } });
    const p = toPaint({ color: "#00000080" }, 0) as { opacity: number };
    expect(p.opacity).toBeCloseTo(128 / 255, 5);
  });

  it("r/g/b channels, with a and a default opacity multiplied", () => {
    expect(toPaint({ r: 0, g: 0.5, b: 1, a: 0.5 }, 0, 0.5)).toEqual({ type: "SOLID", color: { r: 0, g: 0.5, b: 1 }, opacity: 0.25 });
  });

  it("linear and radial gradients with stops", () => {
    const g = toPaint({ gradient: { type: "linear", stops: [{ position: 0, color: "#000" }, { position: 1, color: "#fff" }] } }, 0);
    expect(g).toMatchObject({
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    expect(toPaint({ gradient: { type: "radial", stops: [{ position: 0, color: "#000" }, { position: 1, color: "#fff" }] } }, 0).type).toBe("GRADIENT_RADIAL");
  });

  it("refuses ambiguous or malformed entries with the field path", () => {
    expect(() => toPaint({ color: "#fff", r: 1, g: 1, b: 1 }, 2)).toThrow(/fills\[2\]` needs exactly one/);
    expect(() => toPaint({}, 0)).toThrow(/exactly one/);
    expect(() => toPaint({ gradient: { type: "conic", stops: [] } }, 0)).toThrow(/linear, radial, angular or diamond/);
    expect(() => toPaint({ gradient: { type: "linear", stops: [{ position: 0, color: "#000" }] } }, 0)).toThrow(/at least two/);
    expect(() => toPaint({ r: 2, g: 0, b: 0 }, 0)).toThrow(/fills\[0\]\.r/);
  });
});

describe("set_fills", () => {
  it("sets every node that takes fills and reports the rest per item", async () => {
    const r = await run("set_fills", { nodeIds: ["1:1", "1:3", "9:9", "1:4"], fills: [{ color: "#336699" }] });
    expect(r.updated).toBe(2);
    expect(r.items).toEqual([
      { id: "1:1", ok: true },
      { id: "1:3", ok: false, error: "a GROUP has no fills" },
      { id: "9:9", ok: false, error: "not found" },
      { id: "1:4", ok: true },
    ]);
    expect(nodes.get("1:1")!.fills).toEqual([{ type: "SOLID", color: { r: 0x33 / 255, g: 0x66 / 255, b: 0x99 / 255 } }]);
  });

  it("an empty array removes all fills", async () => {
    nodes.get("1:1")!.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    await run("set_fills", { nodeIds: ["1:1"], fills: [] });
    expect(nodes.get("1:1")!.fills).toEqual([]);
  });

  it("validates every entry before touching any node", async () => {
    const err = await rejects("set_fills", { nodeIds: ["1:1", "1:2"], fills: [{ color: "#fff" }, { color: "nope" }] });
    expect(err.code).toBe("INVALID_PARAM");
    expect(nodes.get("1:1")!.fills).toEqual([]);
    expect(nodes.get("1:2")!.fills).toEqual([]);
  });
});

describe("set_strokes", () => {
  it("sets colour, weight, align and dashes", async () => {
    const r = await run("set_strokes", { nodeIds: ["1:1"], color: "#ff0000", weight: 2, align: "OUTSIDE", dashPattern: [4, 2] });
    expect(r.updated).toBe(1);
    expect(nodes.get("1:1")).toMatchObject({
      strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], strokeWeight: 2, strokeAlign: "OUTSIDE", dashPattern: [4, 2],
    });
  });

  it("reports a node that cannot take dashes instead of failing the batch", async () => {
    const r = await run("set_strokes", { nodeIds: ["1:1", "1:4"], color: "#000", dashPattern: [1, 1] });
    expect(r.items[0]).toEqual({ id: "1:1", ok: true });
    expect(r.items[1]).toMatchObject({ id: "1:4", ok: false });
  });

  it("refuses an unknown alignment up front", async () => {
    expect((await rejects("set_strokes", { nodeIds: ["1:1"], color: "#000", align: "MIDDLE" })).message).toMatch(/INSIDE, CENTER or OUTSIDE/);
  });
});

describe("set_corner_radius", () => {
  it("one radius for every corner", async () => {
    const r = await run("set_corner_radius", { nodeIds: ["1:1", "1:4"], radius: 8 });
    expect(r.updated).toBe(2);
    expect(nodes.get("1:1")!.cornerRadius).toBe(8);
  });

  it("per-corner radii on a frame; a node with one radius only is told to pass `radius`", async () => {
    const r = await run("set_corner_radius", { nodeIds: ["1:1", "1:4"], radii: [1, 2, 3, 4] });
    expect(nodes.get("1:1")).toMatchObject({ topLeftRadius: 1, topRightRadius: 2, bottomRightRadius: 3, bottomLeftRadius: 4 });
    expect(r.items[1]).toMatchObject({ id: "1:4", ok: false });
    expect(r.items[1]!.error).toMatch(/pass `radius`/);
  });

  it("radius and radii are exclusive, and a call needs at least one of radius, radii or smoothing", async () => {
    expect((await rejects("set_corner_radius", { nodeIds: ["1:1"], radius: 1, radii: [1, 1, 1, 1] })).message).toMatch(/not both/);
    expect((await rejects("set_corner_radius", { nodeIds: ["1:1"] })).message).toMatch(/at least one of `radius`.*`smoothing`/);
  });

  it("smoothing on its own changes only the smoothing [C-101]", async () => {
    nodes.get("1:1")!.cornerRadius = 12;
    const r = await run("set_corner_radius", { nodeIds: ["1:1"], smoothing: 0.6 });
    expect(r.updated).toBe(1);
    expect(nodes.get("1:1")).toMatchObject({ cornerRadius: 12, cornerSmoothing: 0.6 });
  });

  it("radius with smoothing writes both; a node with no smoothing is reported, not half-written", async () => {
    const odd: Node = { id: "1:9", type: "STAR", cornerRadius: 0 }; // has a radius, no cornerSmoothing in this fake
    nodes.set(odd.id, odd);
    const r = await run("set_corner_radius", { nodeIds: ["1:1", "1:9"], radius: 24, smoothing: 0.6 });
    expect(nodes.get("1:1")).toMatchObject({ cornerRadius: 24, cornerSmoothing: 0.6 });
    expect(r.items[1]).toEqual({ id: "1:9", ok: false, error: "a STAR has no cornerSmoothing" });
    expect(odd.cornerRadius).toBe(0);
  });

  it("smoothing on a GROUP is a per-item error", async () => {
    const r = await run("set_corner_radius", { nodeIds: ["1:3"], smoothing: 0.6 });
    expect(r.items).toEqual([{ id: "1:3", ok: false, error: "a GROUP has no cornerSmoothing" }]);
  });

  it("refuses a smoothing outside 0–1 before any node changes", async () => {
    const err = await rejects("set_corner_radius", { nodeIds: ["1:1"], radius: 4, smoothing: 1.5 });
    expect(err.partial).toEqual({ created: [] });
    expect(nodes.get("1:1")!.cornerRadius).toBe(0);
  });
});

// ── gradients [C-100] ─────────────────────────────────────────────────────────

const stops = [{ position: 0, color: "#000000" }, { position: 1, color: "#ffffff" }];
const transformOf = (id: string, list = "fills") => ((nodes.get(id)![list] as Array<{ gradientTransform: unknown }>)[0]!).gradientTransform;

describe("gradients — direction, centre, type", () => {
  it("no angle is the measured identity, left → right [C-057]", () => {
    expect(toPaintFor({ gradient: { type: "linear", stops } }, 0)(400, 240)).toMatchObject({ gradientTransform: [[1, 0, 0], [0, 1, 0]] });
  });

  it("one angle gives each node the transform for its own size", async () => {
    await run("set_fills", { nodeIds: ["1:1", "1:2"], fills: [{ gradient: { type: "linear", angle: 45, stops } }] });
    expect(transformOf("1:1")).toEqual(linearTransform(45, 100, 100));
    expect(transformOf("1:2")).toEqual(linearTransform(45, 400, 240));
    expect(transformOf("1:1")).not.toEqual(transformOf("1:2"));
  });

  it("180deg on a square is the official top → bottom matrix", async () => {
    await run("set_fills", { nodeIds: ["1:1"], fills: [{ gradient: { type: "linear", angle: 180, stops } }] });
    const t = transformOf("1:1") as number[][];
    const expected = [[0, 1, 0], [-1, 0, 1]];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) expect(t[r]![c]).toBeCloseTo(expected[r]![c]!, 9);
  });

  it("angular and diamond map to Figma's types; a centre moves the gradient, a radius scales it", () => {
    const angular = toPaint({ gradient: { type: "angular", center: { x: 0.25, y: 0.75 }, stops } }, 0);
    expect(angular).toMatchObject({ type: "GRADIENT_ANGULAR", gradientTransform: [[1, 0, 0.25], [0, 1, -0.25]] });
    const diamond = toPaint({ gradient: { type: "diamond", radius: 0.25, stops } }, 0);
    expect(diamond).toMatchObject({ type: "GRADIENT_DIAMOND", gradientTransform: [[2, 0, -0.5], [0, 2, -0.5]] });
    expect(toPaint({ gradient: { type: "radial", stops } }, 0)).toMatchObject({ type: "GRADIENT_RADIAL", gradientTransform: [[1, 0, 0], [0, 1, 0]] });
  });

  it("a raw transform is used as given", () => {
    expect(toPaint({ gradient: { type: "radial", transform: [0.71, 0, 0.19, 0, 0.57, 0.21], stops } }, 0)).toMatchObject({
      gradientTransform: [[0.71, 0, 0.19], [0, 0.57, 0.21]],
    });
  });

  it("refuses a field that does not belong to the gradient's type, naming it", () => {
    expect(() => toPaint({ gradient: { type: "linear", center: { x: 0, y: 0 }, stops } }, 1)).toThrow(/fills\[1\]\.gradient\.center` is for radial/);
    expect(() => toPaint({ gradient: { type: "radial", angle: 45, stops } }, 0)).toThrow(/\.angle` is for linear gradients/);
    expect(() => toPaint({ gradient: { type: "angular", radius: 0.3, stops } }, 0)).toThrow(/\.radius` is for radial and diamond/);
    expect(() => toPaint({ gradient: { type: "radial", radius: 0, stops } }, 0)).toThrow(/greater than 0/);
    expect(() => toPaint({ gradient: { type: "linear", spin: 3, stops } }, 0)).toThrow(/takes only/);
  });

  it("angle + transform is refused before any node changes, naming the clash", async () => {
    const err = await rejects("set_fills", {
      nodeIds: ["1:1", "1:2"],
      fills: [{ gradient: { type: "linear", angle: 90, transform: [1, 0, 0, 0, 1, 0], stops } }],
    });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/transform` is the whole matrix .* `angle`/);
    expect(err.partial).toEqual({ created: [] });
    expect(nodes.get("1:1")!.fills).toEqual([]);
    expect(nodes.get("1:2")!.fills).toEqual([]);
  });

  it("a transform that is not six numbers, or is singular, is refused", () => {
    expect(() => toPaint({ gradient: { type: "linear", transform: [1, 0, 0, 0, 1], stops } }, 0)).toThrow(/six numbers/);
    expect(() => toPaint({ gradient: { type: "linear", transform: [1, 2, 0, 2, 4, 0], stops } }, 0)).toThrow(/singular/);
  });
});

// ── images by hash [C-104] ────────────────────────────────────────────────────

describe("image fills by hash", () => {
  it("reuses an image already in the file, with scale mode, rotation and filters", () => {
    expect(toPaint({ image: { hash: "img-1", scaleMode: "fit", rotation: 90, filters: { exposure: 0.2, contrast: -0.1 } }, opacity: 0.5 }, 0)).toEqual({
      type: "IMAGE", imageHash: "img-1", scaleMode: "FIT", rotation: 90, filters: { exposure: 0.2, contrast: -0.1 }, opacity: 0.5,
    });
  });

  it("an unknown hash is refused before any node changes", async () => {
    const err = await rejects("set_fills", { nodeIds: ["1:1"], fills: [{ image: { hash: "nope" } }] });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/names no image in this file/);
    expect(err.hint).toMatch(/figma_import_image/);
    expect(err.partial).toEqual({ created: [] });
    expect(nodes.get("1:1")!.fills).toEqual([]);
  });

  it("a photo under a gradient scrim on one node", async () => {
    await run("set_fills", {
      nodeIds: ["1:2"],
      fills: [{ image: { hash: "img-1" } }, { gradient: { type: "linear", angle: 180, stops: [{ position: 0, color: "#00000000" }, { position: 1, color: "#000000aa" }] } }],
    });
    const fills = nodes.get("1:2")!.fills as Array<Record<string, unknown>>;
    expect(fills.map((f) => f.type)).toEqual(["IMAGE", "GRADIENT_LINEAR"]);
    expect(fills[0]).toEqual({ type: "IMAGE", imageHash: "img-1", scaleMode: "FILL" });
  });

  it("refuses a rotation off the quarter turns, a rotation on a crop, and a filter outside -1..1", () => {
    expect(() => toPaint({ image: { hash: "img-1", rotation: 45 } }, 0)).toThrow(/0, 90, 180 or 270/);
    expect(() => toPaint({ image: { hash: "img-1", scaleMode: "crop", rotation: 90 } }, 0)).toThrow(/does not apply to a crop/);
    expect(() => toPaint({ image: { hash: "img-1", filters: { exposure: 2 } } }, 0)).toThrow(/filters\.exposure/);
    expect(() => toPaint({ image: { hash: "img-1", filters: { blur: 1 } } }, 0)).toThrow(/takes only/);
    expect(() => toPaint({ image: { hash: "img-1" }, color: "#fff" }, 0)).toThrow(/exactly one/);
  });

  it("an editor without getImageByHash says which API is missing", () => {
    (globalThis as { figma?: Record<string, unknown> }).figma!.getImageByHash = undefined;
    let err: unknown;
    try {
      toPaint({ image: { hash: "img-1" } }, 0);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/getImageByHash/) });
  });
});

// ── strokes: sides, caps, joins, gradients [C-101] ────────────────────────────

describe("set_strokes — per-side weights, caps, joins, gradient strokes", () => {
  it("sides { bottom: 1 } is a bottom border: the sides left out become 0", async () => {
    await run("set_strokes", { nodeIds: ["1:1"], color: "#e5e7eb", sides: { bottom: 1 } });
    expect(nodes.get("1:1")).toMatchObject({ strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 1, strokeLeftWeight: 0, strokeWeight: 1 });
  });

  it("with `weight`, the sides left out take the weight", async () => {
    await run("set_strokes", { nodeIds: ["1:1"], color: "#000", weight: 2, sides: { top: 0 } });
    expect(nodes.get("1:1")).toMatchObject({ strokeTopWeight: 0, strokeRightWeight: 2, strokeBottomWeight: 2, strokeLeftWeight: 2 });
  });

  it("sides on an ELLIPSE is a per-item error and the ellipse is left untouched", async () => {
    const r = await run("set_strokes", { nodeIds: ["1:1", "1:4"], color: "#ff0000", sides: { bottom: 1 } });
    expect(r.items[0]).toEqual({ id: "1:1", ok: true });
    expect(r.items[1]).toEqual({ id: "1:4", ok: false, error: expect.stringMatching(/^a ELLIPSE takes one stroke weight/) });
    expect(nodes.get("1:4")!.strokes).toEqual([]);
  });

  it("a node that cannot take dashes keeps its old stroke instead of getting half the call", async () => {
    // Before: the stroke was written first, then the dash check threw.
    await run("set_strokes", { nodeIds: ["1:4"], color: "#000", dashPattern: [1, 1] });
    expect(nodes.get("1:4")!.strokes).toEqual([]);
  });

  it("cap and join use create_line's words and Figma's values", async () => {
    const vector: Node = { id: "1:7", type: "VECTOR", width: 10, height: 10, strokes: [], strokeWeight: 1, strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [] };
    nodes.set(vector.id, vector);
    await run("set_strokes", { nodeIds: ["1:7"], color: "#000", cap: "arrow", join: "round" });
    expect(vector).toMatchObject({ strokeCap: "ARROW_LINES", strokeJoin: "ROUND" });
    expect((await rejects("set_strokes", { nodeIds: ["1:7"], color: "#000", cap: "hook" })).message).toMatch(/`cap` must be one of: none, round/);
  });

  it("a gradient stroke is fitted to each node like a gradient fill", async () => {
    await run("set_strokes", { nodeIds: ["1:2"], gradient: { type: "linear", angle: 180, stops }, weight: 2 });
    expect(nodes.get("1:2")).toMatchObject({ strokeWeight: 2, strokes: [{ type: "GRADIENT_LINEAR", gradientTransform: linearTransform(180, 400, 240) }] });
  });

  it("exactly one of color, gradient or remove", async () => {
    expect((await rejects("set_strokes", { nodeIds: ["1:1"], color: "#000", gradient: { type: "linear", stops } })).message).toMatch(/exactly one of `color`, `gradient`/);
    expect((await rejects("set_strokes", { nodeIds: ["1:1"] })).message).toMatch(/exactly one of `color`, `gradient`/);
    const err = await rejects("set_strokes", { nodeIds: ["1:1"], remove: true, sides: { bottom: 1 } });
    expect(err.message).toMatch(/give it alone, without `sides`/);
    expect(err.partial).toEqual({ created: [] });
  });

  it("refuses an unknown side or a negative weight before any node changes", async () => {
    expect((await rejects("set_strokes", { nodeIds: ["1:1"], color: "#000", sides: { middle: 1 } })).message).toMatch(/takes only/);
    expect((await rejects("set_strokes", { nodeIds: ["1:1"], color: "#000", sides: { top: -1 } })).message).toMatch(/sides\.top/);
    expect((await rejects("set_strokes", { nodeIds: ["1:1"], color: "#000", sides: {} })).message).toMatch(/at least one/);
    expect(nodes.get("1:1")!.strokes).toEqual([]);
  });
});

// ── effects: noise, texture, glass, progressive blur [C-102] ──────────────────

describe("effects — the recent types", () => {
  it("NOISE: monotone by default, alpha in the colour; duotone adds secondaryColor; multitone its own opacity", () => {
    expect(toEffect({ type: "NOISE", noiseSize: 2, density: 0.4 }, 0)).toEqual({
      // No blendMode: Figma's validator refuses the key on a noise, measured live [C-102].
      type: "NOISE", noiseType: "MONOTONE", color: { r: 0, g: 0, b: 0, a: 0.25 }, noiseSize: 2, density: 0.4, visible: true,
    });
    expect(toEffect({ type: "NOISE", noiseType: "duotone", color: "#ff0000", secondaryColor: "#0000ff80", noiseSize: 1, density: 1 }, 0)).toMatchObject({
      noiseType: "DUOTONE", color: { r: 1, g: 0, b: 0, a: 0.25 }, secondaryColor: { r: 0, g: 0, b: 1, a: 128 / 255 },
    });
    const multi = toEffect({ type: "NOISE", noiseType: "multitone", opacity: 0.6, noiseSize: 1, density: 0.5 }, 0);
    expect(multi).toMatchObject({ noiseType: "MULTITONE", opacity: 0.6, color: { a: 1 } });
    expect(multi).not.toHaveProperty("secondaryColor");
  });

  it("NOISE needs its size and density, and a duotone its second colour", () => {
    expect(() => toEffect({ type: "NOISE", density: 0.5 }, 0)).toThrow(/noiseSize` is required/);
    expect(() => toEffect({ type: "NOISE", noiseSize: 1, density: 2 }, 0)).toThrow(/density` must be a density from 0 to 1/);
    expect(() => toEffect({ type: "NOISE", noiseType: "duotone", noiseSize: 1, density: 0.5 }, 0)).toThrow(/needs `secondaryColor`/);
    expect(() => toEffect({ type: "NOISE", secondaryColor: "#fff", noiseSize: 1, density: 0.5 }, 0)).toThrow(/duotone noise only/);
  });

  it("TEXTURE and GLASS carry exactly the typings' fields", () => {
    expect(toEffect({ type: "TEXTURE", noiseSize: 3 }, 0)).toEqual({ type: "TEXTURE", noiseSize: 3, radius: 8, clipToShape: true, visible: true });
    expect(toEffect({ type: "GLASS", refraction: 0.8, depth: 12 }, 0)).toEqual({
      type: "GLASS", lightIntensity: 0.5, lightAngle: -45, refraction: 0.8, depth: 12, dispersion: 0, radius: 0, visible: true,
    });
    expect(() => toEffect({ type: "GLASS", depth: 0.5 }, 0)).toThrow(/depth` must be a number ≥ 1/);
    expect(() => toEffect({ type: "GLASS", lightIntensity: 3 }, 0)).toThrow(/0 to 1/);
  });

  it("a progressive blur ramps from the top edge to the bottom by default", () => {
    expect(toEffect({ type: "LAYER_BLUR", radius: 12, progressive: {} }, 0)).toEqual({
      type: "LAYER_BLUR", radius: 12, visible: true, blurType: "PROGRESSIVE", startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 },
    });
    expect(toEffect({ type: "BACKGROUND_BLUR", progressive: { startRadius: 2, startOffset: { x: 0, y: 0.5 }, endOffset: { x: 1, y: 0.5 } } }, 0)).toMatchObject({
      blurType: "PROGRESSIVE", startRadius: 2, startOffset: { x: 0, y: 0.5 }, endOffset: { x: 1, y: 0.5 },
    });
    expect(() => toEffect({ type: "LAYER_BLUR", progressive: { startOffset: { x: 0 } } }, 0)).toThrow(/startOffset\.y` is required/);
  });

  it("refuses a field of another effect type, never dropping it", () => {
    expect(() => toEffect({ type: "DROP_SHADOW", density: 0.5 }, 0)).toThrow(/is a DROP_SHADOW: it takes only .* \(got density\)/);
    expect(() => toEffect({ type: "INNER_SHADOW", showBehindNode: true }, 0)).toThrow(/got showBehindNode/);
    expect(() => toEffect({ type: "TEXTURE", noiseSize: 1, color: "#000" }, 0)).toThrow(/is a TEXTURE: it takes only `noiseSize`, `radius`, `clipToShape` and `visible`/);
    expect(() => toEffect({ type: "LAYER_BLUR", progressive: {}, x: 1 }, 0)).toThrow(/takes only `radius` and `visible`/);
    expect(() => toEffect({ type: "SHADER" }, 0)).toThrow(/NOISE, TEXTURE or GLASS/);
  });

  it("when Figma refuses a recent effect, the item says why it may have", async () => {
    const strict: Node = { id: "1:8", type: "FRAME" };
    Object.defineProperty(strict, "effects", {
      get: () => [],
      set: (v: Array<{ type: string }>) => {
        if (v.some((e) => e.type === "GLASS")) throw new Error("Invalid effect type");
      },
      enumerable: true,
    });
    nodes.set(strict.id, strict);
    const r = await run("set_effects", { nodeIds: ["1:8"], effects: [{ type: "GLASS" }] });
    expect(r.items[0]).toEqual({ id: "1:8", ok: false, error: expect.stringMatching(/^Invalid effect type — NOISE, TEXTURE, GLASS and progressive blurs are recent/) });
  });

  it("a bad entry fails the call with nothing changed", async () => {
    const err = await rejects("set_effects", { nodeIds: ["1:1"], effects: [{ type: "NOISE" }] });
    expect(err.partial).toEqual({ created: [] });
    expect(nodes.get("1:1")!.effects).toEqual([]);
  });
});

// ── nothing changed, said so [C-096] ──────────────────────────────────────────

describe("refusals before the first write report that nothing changed", () => {
  it("blend mode, style, reactions", async () => {
    expect((await rejects("set_blend_mode", { nodeIds: ["1:1"], blendMode: "GLOW" })).partial).toEqual({ created: [] });
    (globalThis as { figma?: Record<string, unknown> }).figma!.getStyleByIdAsync = async () => null;
    expect((await rejects("apply_style_to_node", { nodeIds: ["1:1"], styleId: "S:missing" })).partial).toEqual({ created: [] });
    expect((await rejects("set_reactions", { nodeId: "1:1", reactions: "not json" })).partial).toEqual({ created: [] });
    expect((await rejects("remove_reactions", { nodeId: "1:1" })).partial).toEqual({ created: [] });
    expect((await rejects("set_fills", { fills: [] })).partial).toEqual({ created: [] });
  });
});

// ── the schemas carry every new field to the plugin ───────────────────────────

describe("style tool schemas", () => {
  const tools = new Map<string, { inputSchema: z.ZodRawShape; description: string }>();
  registerStyle({ registerTool: (name: string, config: { inputSchema: z.ZodRawShape; description: string }) => tools.set(name, config) } as unknown as McpServer, {} as Bridge, () => true);
  const parse = (name: string, args: Record<string, unknown>) => z.object(tools.get(name)!.inputSchema).parse(args);

  it("keep gradients, images, sides, caps, smoothing and the recent effects (zod would strip a missing key)", () => {
    const fills = [
      { image: { hash: "h", scaleMode: "tile", rotation: 90, filters: { tint: 0.1 } } },
      { gradient: { type: "diamond", stops, center: { x: 0.2, y: 0.3 }, radius: 0.4 } },
      { gradient: { type: "linear", stops, transform: [1, 0, 0, 0, 1, 0] } },
    ];
    expect(parse("figma_set_fills", { nodeIds: ["1:1"], fills }).fills).toEqual(fills);
    const strokes = { nodeIds: ["1:1"], gradient: { type: "linear", stops, angle: 180 }, sides: { bottom: 1 }, cap: "arrow", join: "round" };
    expect(parse("figma_set_strokes", strokes)).toMatchObject(strokes);
    expect(parse("figma_set_corner_radius", { nodeIds: ["1:1"], smoothing: 0.6 })).toMatchObject({ smoothing: 0.6 });
    const effects = [
      { type: "NOISE", noiseType: "duotone", secondaryColor: "#ffffff", noiseSize: 1, density: 0.5 },
      { type: "LAYER_BLUR", progressive: { startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } } },
      { type: "GLASS", lightIntensity: 0.5, lightAngle: 30, refraction: 0.5, depth: 4, dispersion: 0.1 },
      { type: "TEXTURE", noiseSize: 2, clipToShape: false },
    ];
    expect(parse("figma_set_effects", { nodeIds: ["1:1"], effects }).effects).toEqual(effects);
  });

  it("descriptions fit the 1024 cap whole, so none loses its last sentence", () => {
    for (const name of ["figma_set_fills", "figma_set_strokes", "figma_set_corner_radius", "figma_set_effects"]) {
      expect(tools.get(name)!.description).toMatch(/one node failing does not fail the call\.$/);
    }
  });
});
