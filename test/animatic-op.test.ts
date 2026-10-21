// figma_create_animatic: the planner (shared/animatic.ts) evaluated frame by
// frame through motion-curves.ts at 24, 30 and 60 fps — each plate on screen
// on exactly its frames [in, out), cut pairs on the boundaries [C-240], the
// render exactly the board's length [C-194] — then the plugin op against the
// write fakes with a Motion layer (one track per write, every track read back
// [C-250], a gated account, a track Figma never keeps), and the server tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileAnimaticSpec,
  DRIFT_SCALE,
  END_MARGIN,
  isDissolve,
  panelLabel,
  planAnimatic,
  plateSize,
  readAnimaticOptions,
  renderCall,
  slateLines,
  type AnimaticPlan,
  type TimedPanel,
} from "../src/shared/animatic.js";
import { editorsSuffix } from "../src/shared/editors.js";
import { BridgeError } from "../src/shared/errors.js";
import { compileKeys, expectedFrames, findCutPairs, frameTime, valueAt, type KeyText } from "../src/shared/motion-curves.js";
import { parseStoryboardRecord, planStoryboard, storyboardRecord } from "../src/shared/storyboard.js";
import { ANIMATIC_OPS } from "../src/plugin/ops/animatic.js";
import { STORYBOARD_OPS } from "../src/plugin/ops/storyboard.js";
import type { Bridge } from "../src/server/bridge.js";
import type { Extra } from "../src/server/tools/forward.js";
import { ANIMATIC_SHAPE, registerStoryboard } from "../src/server/tools/storyboard.js";
import { FakeContainer, FakeNode, installFigma, opContext, solid } from "./editor-fakes.js";
import { WFrame, WriteFigma } from "./write-fakes.js";

type Any = Record<string, unknown>;

// ── the planner ──────────────────────────────────────────────────────────────

/** Panels timed as figma_create_storyboard times them: whole frames at `fps`. */
function timed(fps: number, durations: number[], transitions: Record<number, string> = {}): TimedPanel[] {
  const plan = planStoryboard({ title: "x", aspect: "9:16", fps, panels: durations.map((d) => ({ durationS: d })) });
  return plan.panels.map((p) => ({ index: p.index, startFrame: p.startFrame, endFrame: p.endFrame, ...(transitions[p.index] ? { transition: transitions[p.index] } : {}) }));
}

const at = (keys: KeyText[], frame: number, fps: number) => valueAt(compileKeys(keys), frameTime(frame, fps))!;
const opacityAt = (plan: AnimaticPlan, plate: number, frame: number) => at(plan.plates[plate]!.opacity, frame, plan.fps)[0]!;

describe("each plate is on screen on exactly its frames", () => {
  const DURATIONS = [1.2, 0.5, 2, 0.25, 1.3, 0.75];
  for (const fps of [24, 30, 60]) {
    it(`at ${fps} fps: opacity 1 on [in, out), 0 everywhere else, and a render of exactly the board's frames`, () => {
      const panels = timed(fps, DURATIONS);
      const plan = planAnimatic(panels, fps, { dissolveFrames: 0, drift: false });
      const E = panels[panels.length - 1]!.endFrame;
      expect(plan).toMatchObject({ fps, durationFrames: E, expectedFrames: E, dissolves: [] });
      // The end frame renders too [C-194]: a timeline just short of frame E − 1 holds exactly E frames.
      expect(expectedFrames(plan.timelineS, fps)).toBe(E);
      for (let f = 0; f < E; f++) {
        const on = plan.plates.map((_, i) => opacityAt(plan, i, f));
        const want = panels.map((p) => (p.startFrame <= f && f < p.endFrame ? 1 : 0));
        expect(on, `frame ${f}`).toEqual(want);
      }
      expect(plan.plates.map((p) => [p.inFrame, p.outFrame, p.lastFrame])).toEqual(panels.map((p) => [p.startFrame, p.endFrame, p.endFrame - 1]));
      expect(plan.plates.map((p) => p.restOpacity)).toEqual([1, 0, 0, 0, 0, 0]);
    });
  }

  it("the render is the board's length however Figma rounds the duration and counts its frames [C-194]", () => {
    // Figma keeps a duration to the microsecond: 86/24 s read back 3.583333 on
    // 2026-10-13. That run's dissolve probe, three 1 s panels at 30 fps
    // (E = 90), was timed 89/30 s, kept as 2.966667, and rendered 91 frames:
    // ceil(d · fps) + 1, where round(d · fps) + 1 says 90
    // (spikes/results/live-animatic.json, dissolve.render).
    const kept = (d: number) => Math.round(d * 1e6) / 1e6;
    const counts = (d: number, fps: number) => [Math.round(d * fps) + 1, Math.ceil(d * fps) + 1];
    expect(counts(kept(89 / 30), 30)).toEqual([90, 91]);
    expect(planAnimatic(timed(30, [1, 1, 1]), 30, { dissolveFrames: 0, drift: false }).expectedFrames).toBe(90);
    for (const fps of [12, 24, 30, 60]) {
      for (let E = 2; E <= 900; E++) {
        const plan = planAnimatic([{ index: 1, startFrame: 0, endFrame: E }], fps, { dissolveFrames: 0, drift: false });
        // As Figma keeps it, and as the result reports it (round4) for an agent to set again.
        for (const d of [kept(plan.timelineS), Math.round(plan.timelineS * 1e4) / 1e4]) {
          expect(counts(d, fps), `${E} frames at ${fps} fps, timeline ${d} s`).toEqual([E, E]);
        }
      }
    }
  });

  it("a dissolve or a drift that ends on the last frame ends at the timeline's end, and is fully on there", () => {
    // Panel 2 is two frames long, so the dissolve into it is one frame and ends on frame E − 1 = 31.
    const plan = planAnimatic(timed(30, [1, 2 / 30], { 1: "Dissolve" }), 30, { dissolveFrames: 4, drift: true });
    expect(plan).toMatchObject({ durationFrames: 32, dissolves: [{ from: 1, to: 2, frames: 1, asked: 4 }] });
    expect(plan.timelineS).toBeCloseTo((31 - END_MARGIN) / 30, 12);
    const last = plan.plates[1]!;
    for (const keys of [last.opacity, last.drift!]) expect(Math.max(...keys.map((k) => k.t))).toBeLessThanOrEqual(plan.timelineS);
    expect(opacityAt(plan, 1, 30)).toBeCloseTo(1 / 2, 2);
    expect(opacityAt(plan, 1, 31)).toBe(1);
    expect(at(last.drift!, 31, 30)[0]).toBeCloseTo(DRIFT_SCALE, 12);
  });

  it("every track starts at t = 0, is LINEAR, never HOLD, and ends inside the timeline", () => {
    const plan = planAnimatic(timed(30, [1, 1, 1]), 30, { dissolveFrames: 4, drift: true });
    for (const p of plan.plates) {
      for (const keys of [p.opacity, p.drift ?? []]) {
        expect(keys[0]!.t).toBe(0);
        expect(keys.every((k) => k.easing === "LINEAR")).toBe(true);
        expect(Math.max(...keys.map((k) => k.t))).toBeLessThanOrEqual(plan.timelineS + 1e-9);
        expect(new Set(keys.map((k) => k.t)).size).toBe(keys.length);
      }
    }
  });

  it("the switches are clean cut pairs on the boundary frames [C-240]", () => {
    const plan = planAnimatic(timed(24, [1, 0.5, 1]), 24, { dissolveFrames: 0, drift: false });
    const cuts = plan.plates.map((p) => findCutPairs(compileKeys(p.opacity), 24).map((c) => [c.frame, c.clean]));
    expect(cuts).toEqual([[[24, true]], [[24, true], [36, true]], [[36, true]]]);
  });

  it("one panel: one plate held at 1, a single key", () => {
    const plan = planAnimatic(timed(30, [2]), 30, { dissolveFrames: 0, drift: false });
    expect(plan.plates).toHaveLength(1);
    expect(plan.plates[0]!.opacity).toEqual([{ t: 0, value: "1", easing: "LINEAR" }]);
    expect(plan.timelineS).toBeCloseTo((59 - END_MARGIN) / 30, 12);
  });

  it("refuses a panel that would never show, a gap, and a board one frame long", () => {
    expect(() => planAnimatic([{ index: 1, startFrame: 0, endFrame: 30 }, { index: 2, startFrame: 30, endFrame: 30 }], 30, { dissolveFrames: 0, drift: false })).toThrow(
      /Panel 02 lasts less than one frame at 30 fps/,
    );
    expect(() => planAnimatic([{ index: 1, startFrame: 0, endFrame: 30 }, { index: 2, startFrame: 31, endFrame: 40 }], 30, { dissolveFrames: 0, drift: false })).toThrow(
      /starts on frame 31, not 30/,
    );
    expect(() => planAnimatic([{ index: 1, startFrame: 0, endFrame: 1 }], 30, { dissolveFrames: 0, drift: false })).toThrow(/at least 2 frames/);
  });
});

describe("dissolves", () => {
  it("fade the next plate in over the one before, which cuts out under it once it is fully on", () => {
    const plan = planAnimatic(timed(30, [1, 1, 1], { 1: "Dissolve into the vase" }), 30, { dissolveFrames: 4, drift: false });
    expect(plan.dissolves).toEqual([{ from: 1, to: 2, frames: 4, asked: 4 }]);
    expect(plan.plates[1]).toMatchObject({ inFrame: 30, dissolveIn: 4 });
    expect(plan.plates[0]).toMatchObject({ outFrame: 30, lastFrame: 33 });
    // Frame 30 + m shows the incoming plate at (m + 1) / 5, over the outgoing one at 1.
    for (let m = 0; m <= 4; m++) {
      expect(opacityAt(plan, 1, 30 + m)).toBeCloseTo((m + 1) / 5, 9);
      expect(opacityAt(plan, 0, 30 + m)).toBe(m < 4 ? 1 : 0);
    }
    expect(opacityAt(plan, 1, 29)).toBe(0);
    // The second boundary has no dissolve: a cut, exactly on frame 60.
    expect([opacityAt(plan, 1, 59), opacityAt(plan, 1, 60), opacityAt(plan, 2, 59), opacityAt(plan, 2, 60)]).toEqual([1, 0, 0, 1]);
  });

  it("is held to the next panel's length less a frame, and a one-frame panel keeps a cut", () => {
    const short = planAnimatic(timed(30, [1, 0.1, 1], { 1: "dissolve" }), 30, { dissolveFrames: 12, drift: false });
    expect(short.dissolves).toEqual([{ from: 1, to: 2, frames: 2, asked: 12 }]);
    expect(opacityAt(short, 1, 32)).toBe(1);
    expect(opacityAt(short, 0, 32)).toBe(0);
    const single = planAnimatic(timed(30, [1, 1 / 30, 1], { 1: "Dissolve" }), 30, { dissolveFrames: 6, drift: false });
    expect(single.dissolves).toEqual([{ from: 1, to: 2, frames: 0, asked: 6 }]);
    expect(single.plates[1]!.dissolveIn).toBeUndefined();
    expect([opacityAt(single, 0, 29), opacityAt(single, 0, 30), opacityAt(single, 1, 30), opacityAt(single, 1, 31)]).toEqual([1, 0, 1, 0]);
  });

  it("only where the transition caption starts with dissolve, and only with dissolveFrames", () => {
    expect(["Dissolve to black", "  dissolve", "Cross-dissolve, slow", "cross dissolve"].map(isDissolve)).toEqual([true, true, true, true]);
    expect(["Slow dissolve", "Cut on the beat", "—", undefined].map(isDissolve)).toEqual([false, false, false, false]);
    expect(planAnimatic(timed(30, [1, 1], { 1: "Dissolve" }), 30, { dissolveFrames: 0, drift: false }).dissolves).toEqual([]);
    // The last panel's transition leads nowhere.
    expect(planAnimatic(timed(30, [1, 1], { 2: "Dissolve" }), 30, { dissolveFrames: 4, drift: false }).dissolves).toEqual([]);
  });
});

describe("drift", () => {
  it("pushes each plate's art 3 % in a straight line over the frames it is on screen", () => {
    const plan = planAnimatic(timed(30, [1, 1, 1 / 30]), 30, { dissolveFrames: 0, drift: true });
    const [a, b, c] = plan.plates;
    expect(a!.drift).toEqual([{ t: 0, value: "1,1", easing: "LINEAR" }, { t: 29 / 30, value: `${DRIFT_SCALE},${DRIFT_SCALE}`, easing: "LINEAR" }]);
    expect(at(b!.drift!, 29, 30)).toEqual([1, 1]);
    expect(at(b!.drift!, 30, 30)).toEqual([1, 1]);
    expect(at(b!.drift!, 59, 30)[0]).toBeCloseTo(1.03, 12);
    expect(at(b!.drift!, 44, 30)[0]).toBeCloseTo(1 + 0.03 * (14 / 29), 12);
    // A panel one frame long has nothing to push across.
    expect(c!.drift).toBeUndefined();
  });

  it("runs on through a dissolve out of the plate", () => {
    const plan = planAnimatic(timed(30, [1, 1], { 1: "Dissolve" }), 30, { dissolveFrames: 4, drift: true });
    expect(plan.plates[0]!.lastFrame).toBe(33);
    expect(at(plan.plates[0]!.drift!, 33, 30)[0]).toBeCloseTo(1.03, 12);
  });
});

describe("options, size, slates and the render", () => {
  it("defaults and refusals name the field", () => {
    expect(readAnimaticOptions({})).toEqual({ burnIn: "panel", dissolveFrames: 0, drift: false });
    expect(readAnimaticOptions({ width: 540, burnIn: "full", dissolveFrames: 6, drift: true })).toEqual({ width: 540, burnIn: "full", dissolveFrames: 6, drift: true });
    expect(() => readAnimaticOptions({ width: 32 })).toThrow(/`width` must be a number of pixels from 64 to 4096/);
    expect(() => readAnimaticOptions({ burnIn: "all" })).toThrow(/`burnIn` must be one of none, panel, full/);
    expect(() => readAnimaticOptions({ dissolveFrames: 13 })).toThrow(/`dissolveFrames` must be a whole number from 0 to 12/);
    expect(() => readAnimaticOptions({ dissolveFrames: 1.5 })).toThrow(/dissolveFrames/);
    expect(() => readAnimaticOptions({ drift: "yes" })).toThrow(/`drift` must be true or false/);
  });

  it("the plate follows the board's aspect", () => {
    expect(plateSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(plateSize("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(plateSize("4:5", 540)).toEqual({ width: 540, height: 675 });
    expect(plateSize("1:1", 64)).toEqual({ width: 64, height: 64 });
  });

  it("a panel's label comes from its card header; a slate is none, the label, or the label with timing and captions", () => {
    expect(panelLabel(2, "02 · Vase · 0:01.2")).toBe("02 · Vase");
    expect(panelLabel(2, "02 · Kiln · door · 0:01.2")).toBe("02 · Kiln · door");
    expect(panelLabel(3, "03 · 0:03.0")).toBe("Panel 03");
    expect(panelLabel(4, "Wide on the kiln")).toBe("04 · Wide on the kiln");
    expect(panelLabel(5, undefined)).toBe("Panel 05");
    const s = { label: "02 · Vase", startS: 1.2, endS: 3, startFrame: 36, endFrame: 90, durationS: 1.8, captions: { action: "Push in", transition: "Dissolve" } };
    expect(slateLines("none", s)).toEqual([]);
    expect(slateLines("panel", s)).toEqual(["02 · Vase"]);
    expect(slateLines("full", s)).toEqual(["02 · Vase", "0:01.2 → 0:03.0 · f36 → f90 · 1.8 s", "Action: Push in", "Transition: Dissolve"]);
  });

  it("the render call plays it back at the board's fps, half size, under a jobId named after the piece", () => {
    expect(renderCall("5:1", "Kiln end card", 30, 1080)).toEqual({ render: 'figma_export_video { nodeId: "5:1", fps: 30, width: 540, jobId: "animatic-kiln-end-card" }' });
    const odd = renderCall("5:1", "Reel", 25, 1920);
    expect(odd.render).toBe('figma_export_video { nodeId: "5:1", fps: 24, width: 960, jobId: "animatic-reel" }');
    expect(odd.renderNote).toMatch(/timed at 25 fps, which MP4 does not render/);
  });

  it("the spec stacks one black plate per panel, the first on, with a slate only when there are lines", () => {
    const { root, refs } = compileAnimaticSpec("Reel", { x: 10, y: 20 }, { width: 1080, height: 1920 }, [
      { index: 1, startS: 0, restOpacity: 1, slate: ["01 · Hook"] },
      { index: 2, startS: 1.2, restOpacity: 0, slate: [] },
    ]);
    expect(root).toMatchObject({ type: "frame", name: "Animatic · Reel", x: 10, y: 20, width: 1080, height: 1920, background: "#000000", clipsContent: true });
    const plates = root.children as Any[];
    expect(plates.map((p) => [p.name, p.opacity, (p.children as Any[]).length])).toEqual([["Plate 01 · 0:00.0", 1, 2], ["Plate 02 · 0:01.2", 0, 1]]);
    expect(refs).toEqual({ root: "animatic", plates: [{ plate: "p1_plate", art: "p1_art", slate: "p1_slate" }, { plate: "p2_plate", art: "p2_art" }] });
  });
});

describe("the board's record keeps each panel's picture ids", () => {
  it("source and image round-trip through the stored JSON, so the animatic can render a source again at plate size", () => {
    const plan = planStoryboard({ title: "x", aspect: "1:1", panels: [{ durationS: 1, source: "12:34" }, { durationS: 1, image: "abc" }, { durationS: 1 }] });
    const ids = { panels: plan.panels.map((p) => ({ id: `c${p.index}`, thumbId: `t${p.index}`, captionIds: {} })) };
    const record = parseStoryboardRecord(JSON.stringify(storyboardRecord(plan, ids)), "1:1");
    expect(record.panels.map((p) => [p.sourceId, p.imageHash])).toEqual([["12:34", undefined], [undefined, "abc"], [undefined, undefined]]);
    // An older record without them still reads.
    const old = JSON.stringify({ v: 1, fps: 30, panels: [{ id: "c1", thumbId: "t1", captionIds: {}, plannedS: 1 }] });
    expect(parseStoryboardRecord(old, "1:1").panels[0]).toEqual({ index: 1, id: "c1", thumbId: "t1", captionIds: {}, plannedS: 1 });
  });
});

// ── the plugin op ────────────────────────────────────────────────────────────

/** The Design file: images by bytes and by hash, as the storyboard tests have it. */
class BoardFigma extends WriteFigma {
  readonly images = new Set<string>(["hash-known"]);
  private made = 0;
  createImage(bytes: Uint8Array): { hash: string; getSizeAsync(): Promise<{ width: number; height: number }> } {
    const hash = `img-${++this.made}-${bytes.length}`;
    this.images.add(hash);
    return { hash, getSizeAsync: async () => ({ width: 1, height: 1 }) };
  }
  getImageByHash(hash: string): unknown {
    return this.images.has(hash) ? { hash } : null;
  }
  async getLocalTextStylesAsync(): Promise<Any[]> {
    return [];
  }
}

/**
 * Motion on every fake node, after plugin-api.d.ts 1.141.0 [C-183]: a record of
 * manual tracks per node, the top-level frame's timeline, and a gated account
 * whose every Motion member throws Figma's words [C-115]. `drops` names layers
 * whose writes Figma never keeps [C-201].
 */
class MotionWorld {
  gated = false;
  readonly tracks = new WeakMap<object, Any>();
  readonly durations = new Map<string, number>();
  readonly applies: Array<{ id: string; name: string; field: string }> = [];
  drops: (name: string) => boolean = () => false;
}
let motion = new MotionWorld();
const renders: Array<{ id: string; name: string; settings: Any }> = [];
const shared = new WeakMap<object, Map<string, string>>();

const gate = (member: string) => {
  if (motion.gated) throw new Error(`"${member}" is not a supported API`);
};
const topOf = (n: FakeNode): FakeNode => {
  let x = n;
  while (x.parent && x.parent.type !== "PAGE") x = x.parent;
  return x;
};

const nodeProto = FakeNode.prototype as unknown as Any;
const frameProto = WFrame.prototype as unknown as Any;
beforeAll(() => {
  Object.defineProperty(nodeProto, "manualKeyframeTracks", {
    configurable: true,
    get(this: FakeNode) {
      gate("manualKeyframeTracks");
      return motion.tracks.get(this) ?? {};
    },
  });
  Object.defineProperty(nodeProto, "timelines", {
    configurable: true,
    get(this: FakeNode) {
      gate("timelines");
      const top = topOf(this);
      return [{ id: top.id, duration: motion.durations.get(top.id) ?? 0 }];
    },
  });
  nodeProto.applyManualKeyframeTrack = function (this: FakeNode, field: { name: string }, track: { keyframes: Any[] }) {
    gate("applyManualKeyframeTrack");
    motion.applies.push({ id: this.id, name: this.name, field: field.name });
    if (motion.drops(this.name)) return;
    const record = { ...(motion.tracks.get(this) ?? {}) };
    record[field.name] = { id: `track:${this.id}:${field.name}`, keyframes: track.keyframes.map((k) => ({ easing: { type: "LINEAR" }, ...k })) };
    motion.tracks.set(this, record);
  };
  nodeProto.setTimelineDuration = function (id: string, duration: number) {
    gate("setTimelineDuration");
    motion.durations.set(id, duration);
  };
  frameProto.exportAsync = async function (this: WFrame, settings: Any) {
    renders.push({ id: this.id, name: this.name, settings });
    return new Uint8Array(64);
  };
  frameProto.setSharedPluginData = function (this: object, ns: string, key: string, value: string) {
    if (!shared.has(this)) shared.set(this, new Map());
    shared.get(this)!.set(`${ns}/${key}`, value);
  };
  frameProto.getSharedPluginData = function (this: object, ns: string, key: string) {
    return shared.get(this)?.get(`${ns}/${key}`) ?? "";
  };
});
afterAll(() => {
  for (const k of ["manualKeyframeTracks", "timelines", "applyManualKeyframeTrack", "setTimelineDuration"]) delete nodeProto[k];
  for (const k of ["exportAsync", "setSharedPluginData", "getSharedPluginData"]) delete frameProto[k];
});

let fake: BoardFigma;
let restore: (() => void) | undefined;
let yields = 0;
function file(): BoardFigma {
  fake = new BoardFigma();
  restore = installFigma(fake);
  motion = new MotionWorld();
  renders.length = 0;
  yields = 0;
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
});

const node = (id: string) => fake.nodes.get(id) as (FakeNode & Any) | undefined;
const chars = (id: string) => (node(id) as unknown as { characters: string }).characters;
const setChars = (id: string, text: string) => void ((node(id) as unknown as { characters: string }).characters = text);
const ctx = (params: Any) => opContext(params, { yieldToHost: async () => void yields++ });
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}

type BoardPanel = { id: string; thumbId: string; hintId?: string; captionIds: Record<string, string>; styleframeId?: string; startFrame: number; endFrame: number };
async function board(params: Any): Promise<{ id: string; panels: BoardPanel[] }> {
  const r = (await STORYBOARD_OPS.create_storyboard!.run(ctx(params))) as { storyboardId: string; panels: BoardPanel[] };
  renders.length = 0;
  return { id: r.storyboardId, panels: r.panels };
}
type PanelOut = { index: number; layerId: string; artId: string; slateId?: string; inFrame: number; outFrame: number; lastFrame?: number; dissolveIn?: number; image: string; blank?: boolean };
const animatic = async (params: Any) => (await ANIMATIC_OPS.create_animatic!.run(ctx(params))) as Any & { animaticId: string; panels: PanelOut[] };
const opacityKeys = (id: string) => ((motion.tracks.get(node(id)!) ?? {}).OPACITY as { keyframes: Array<{ timelinePosition: number; value: { value: number } }> } | undefined)?.keyframes;

/** A frame on the page with something in it, rendering through the recorded exportAsync. */
function drawn(width: number, height: number): WFrame {
  const f = fake.frame();
  f.resize(width, height);
  f.x = -4000;
  const mark = fake.createRectangle();
  f.appendChild(mark);
  return f;
}

/** Five panels, one per picture source: a drawn styleframe, a source, an image, nothing yet, a sketch in the thumbnail. */
async function kiln(extra: Any = {}) {
  file();
  const src = drawn(1080, 1920);
  const b = await board({
    title: "Kiln end card",
    aspect: "9:16",
    panels: [
      { durationS: 1.2, title: "Hook", styleframe: true, action: "Lid lifts" },
      { durationS: 1.8, title: "Vase", source: src.id, transition: "Dissolve into the glaze" },
      { durationS: 0.6, title: "Glaze", image: "hash-known" },
      { durationS: 1, title: "Kiln door", styleframe: true },
      { durationS: 2.4, title: "End card", camera: "Hold" },
    ],
    ...extra,
  });
  // Panel 1's styleframe gets art; panel 4's stays as the board left it.
  const sf = node(b.panels[0]!.styleframeId!) as unknown as WFrame;
  sf.appendChild(fake.createRectangle());
  // Panel 5: a sketch in the thumbnail, the hint deleted.
  const thumb5 = node(b.panels[4]!.thumbId) as unknown as WFrame;
  thumb5.appendChild(fake.createRectangle());
  node(b.panels[4]!.hintId!)!.remove();
  return { b, src };
}

describe("figma_create_animatic builds one top-level frame from the board", () => {
  it("at an empty spot on the board's page, black and clipped, with a plate per panel showing its best picture", async () => {
    const { b, src } = await kiln();
    const rightmost = Math.max(...fake.currentPage.children.map((c) => c.x + c.width));
    const before = fake.log.length;
    const r = await animatic({ storyboardId: b.id });
    const root = node(r.animaticId)! as unknown as WFrame & Any;
    expect(root.name).toBe("Animatic · Kiln end card");
    expect(root.parent).toBe(fake.currentPage);
    expect([root.x, root.width, root.height, root.clipsContent]).toEqual([rightmost + 400, 1080, 1920, true]);
    expect(root.fills).toEqual([solid("#000000")]);
    const plates = root.children as unknown as Array<WFrame & Any>;
    expect(plates.map((p) => [p.name, p.opacity, p.id])).toEqual([
      ["Plate 01 · 0:00.0", 1, r.panels[0]!.layerId],
      ["Plate 02 · 0:01.2", 0, r.panels[1]!.layerId],
      ["Plate 03 · 0:03.0", 0, r.panels[2]!.layerId],
      ["Plate 04 · 0:03.6", 0, r.panels[3]!.layerId],
      ["Plate 05 · 0:04.6", 0, r.panels[4]!.layerId],
    ]);
    // The best picture of each: a styleframe once drawn, else the source again
    // at plate size, else the image, else the thumbnail (its own fill when blank).
    expect(r.panels.map((p) => [p.image, p.blank ?? false])).toEqual([["styleframe", false], ["source", false], ["source", false], ["thumb", true], ["thumb", false]]);
    expect(r.blank).toEqual([4]);
    expect(renders.map((x) => [x.id, x.settings])).toEqual([
      [b.panels[0]!.styleframeId, { format: "PNG", constraint: { type: "WIDTH", value: 1080 } }],
      [src.id, { format: "PNG", constraint: { type: "WIDTH", value: 1080 } }],
      // A 216 × 384 thumbnail covers the 1080 × 1920 plate at five times its size.
      [b.panels[4]!.thumbId, { format: "PNG", constraint: { type: "WIDTH", value: 1080 } }],
    ]);
    // img-1 is the board's own snapshot of the source; the animatic's renders follow it.
    const art = (i: number) => (node(r.panels[i]!.artId) as unknown as Any).fills as Any[];
    expect(art(0)).toEqual([{ type: "IMAGE", imageHash: "img-2-64", scaleMode: "FILL" }]);
    expect(art(1)).toEqual([{ type: "IMAGE", imageHash: "img-3-64", scaleMode: "FILL" }]);
    expect(art(2)).toEqual([{ type: "IMAGE", imageHash: "hash-known", scaleMode: "FILL" }]);
    expect(art(3)).toEqual([solid("#E6E6EA")]);
    expect(art(4)).toEqual([{ type: "IMAGE", imageHash: "img-4-64", scaleMode: "FILL" }]);
    // The default burn-in: each plate's number and title, from its card header.
    expect(r.panels.map((p) => chars((node(p.slateId!) as unknown as WFrame).children[0]!.id))).toEqual(["01 · Hook", "02 · Vase", "03 · Glaze", "04 · Kiln door", "05 · End card"]);
    expect(r).toMatchObject({ storyboardId: b.id, title: "Kiln end card", aspect: "9:16", width: 1080, height: 1920, fps: 30, durationS: 7, expectedFrames: 210, created: [r.animaticId] });
    // Nothing was made but the animatic; the runner commits the one undo step.
    expect(fake.log.slice(before).filter((l) => l.startsWith("create FRAME")).length).toBe(1 + 5 + 5);
    expect(fake.undoCommits).toBe(0);
    expect(r.note).toMatch(/Panels 2–5 rest at opacity 0; figma_export_node shows panel 1 only/);
  });

  it("keys each plate on exactly its frames, one track per write, and reads every track back", async () => {
    const { b } = await kiln();
    const r = await animatic({ storyboardId: b.id, burnIn: "none" });
    expect(r.panels.map((p) => [p.inFrame, p.outFrame])).toEqual(b.panels.map((p) => [p.startFrame, p.endFrame]));
    expect(r.panels.every((p) => p.slateId === undefined)).toBe(true);
    // One write per plate, each read back after a host turn of its own.
    expect(motion.applies.map((a) => [a.name.slice(0, 8), a.field])).toEqual(r.panels.map((_, i) => [`Plate 0${i + 1}`, "OPACITY"]));
    expect(yields).toBeGreaterThanOrEqual(5 + 5);
    for (const fps of [30]) {
      const keys = r.panels.map((p) => compileKeys(opacityKeys(p.layerId)!.map((k) => ({ t: k.timelinePosition, value: String(k.value.value), easing: "LINEAR" }))));
      for (let f = 0; f < (r.expectedFrames as number); f++) {
        expect(keys.map((k) => valueAt(k, frameTime(f, fps))![0]), `frame ${f}`).toEqual(r.panels.map((p) => (p.inFrame <= f && f < p.outFrame ? 1 : 0)));
      }
    }
    // The timeline ends just short of frame E − 1, set on the frame's own timeline, so the render is 210 frames.
    expect(motion.durations.get(r.animaticId)).toBeCloseTo((209 - END_MARGIN) / 30, 12);
    expect(r).toMatchObject({ verified: true, timelineS: 6.9663, timeline: { id: r.animaticId, duration: 6.9663 } });
    expect(r.note).toMatch(/runs 6\.9663 s, just short of frame 209, because the end frame renders too, so the render holds exactly 210 frames/);
    expect(r.notApplied).toBeUndefined();
    expect(r.timelineNote).toBeUndefined();
    expect(r.render).toBe(`figma_export_video { nodeId: "${r.animaticId}", fps: 30, width: 540, jobId: "animatic-kiln-end-card" }`);
  });

  it("dissolves where the transition caption asks, pushes with drift, and burns the full slate in", async () => {
    const { b } = await kiln();
    const r = await animatic({ storyboardId: b.id, dissolveFrames: 4, drift: true, burnIn: "full", width: 540 });
    expect(r.dissolves).toEqual([{ from: 2, to: 3, frames: 4, asked: 4 }]);
    expect(r.panels[2]).toMatchObject({ inFrame: 90, outFrame: 108, dissolveIn: 4 });
    expect(r.panels[1]).toMatchObject({ outFrame: 90, lastFrame: 93 });
    // Every plate's art is pushed: its own track, written alone.
    expect(motion.applies.map((a) => a.field)).toEqual(Array.from({ length: 5 }, () => ["OPACITY", "SCALE_XY"]).flat());
    const scale = (motion.tracks.get(node(r.panels[0]!.artId)!) as { SCALE_XY: { keyframes: Array<{ timelinePosition: number; value: { value: { x: number } } }> } }).SCALE_XY.keyframes;
    expect(scale.map((k) => [k.timelinePosition, k.value.value.x])).toEqual([[0, 1], [35 / 30, DRIFT_SCALE]]);
    const slate = (node(r.panels[0]!.slateId!) as unknown as WFrame).children.map((t) => chars(t.id));
    expect(slate).toEqual(["01 · Hook", "0:00.0 → 0:01.2 · f0 → f36 · 1.2 s", "Action: Lid lifts"]);
    expect((node(r.panels[1]!.slateId!) as unknown as WFrame).children.map((t) => chars(t.id))).toContain("Transition: Dissolve into the glaze");
    expect([r.width, r.height]).toEqual([540, 960]);
    expect(r.verified).toBe(true);
  });

  it("reads the board as it is now: an edited duration retimes the plates, an edited title renames the slate", async () => {
    const { b } = await kiln();
    setChars(b.panels[0]!.captionIds.duration!, "2 s");
    const header = (node(b.panels[1]!.id) as unknown as WFrame).children[0]!;
    setChars(header.id, "02 · Tall vase · 0:01.2");
    const r = await animatic({ storyboardId: b.id });
    expect(r.panels.slice(0, 2).map((p) => [p.inFrame, p.outFrame])).toEqual([[0, 60], [60, 114]]);
    expect(r).toMatchObject({ durationS: 7.8, expectedFrames: 234 });
    expect(chars((node(r.panels[1]!.slateId!) as unknown as WFrame).children[0]!.id)).toBe("02 · Tall vase");
  });

  it("builds on another page with pageId, at x and y", async () => {
    const { b } = await kiln();
    const other = new FakeContainer("PAGE", "Animatics", fake);
    fake.root.appendChild(other);
    const r = await animatic({ storyboardId: b.id, pageId: other.id, x: -3000, y: 500 });
    const root = node(r.animaticId)!;
    expect(root.parent).toBe(other);
    expect([root.x, root.y]).toEqual([-3000, 500]);
  });

  it("a source that is gone falls back to the thumbnail, and says so", async () => {
    const { b, src } = await kiln();
    src.remove();
    const r = await animatic({ storyboardId: b.id });
    expect(r.panels[1]!.image).toBe("thumb");
    expect(r.note).toMatch(new RegExp(`Panel 02's source ${src.id} is gone`));
  });
});

describe("what Figma does not keep, and what cannot start", () => {
  it("a track Figma never keeps: verified false, notApplied names the layer with its keys, after three writes", async () => {
    const { b } = await kiln();
    motion.drops = (name) => name.startsWith("Plate 03");
    const r = await animatic({ storyboardId: b.id, burnIn: "none" });
    expect(r.verified).toBe(false);
    const missing = r.notApplied as Array<{ index: number; layerId: string; field: string; keyframes: KeyText[] }>;
    expect(missing.map((m) => [m.index, m.layerId, m.field])).toEqual([[3, r.panels[2]!.layerId, "OPACITY"]]);
    expect(missing[0]!.keyframes[0]).toEqual({ t: 0, value: "0", easing: "LINEAR" });
    expect(motion.applies.filter((a) => a.name.startsWith("Plate 03"))).toHaveLength(3);
    expect(r.hint).toMatch(/figma_set_keyframes/);
  });

  it("a gated account: UNSUPPORTED before anything is rendered or created [C-115]", async () => {
    const { b } = await kiln();
    motion.gated = true;
    const before = fake.log.length;
    const kids = fake.currentPage.children.length;
    const e = await refusal(animatic({ storyboardId: b.id }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.hint).toMatch(/Do not retry/);
    expect(e.partial).toEqual({ created: [] });
    expect(renders).toEqual([]);
    expect(fake.log.slice(before).filter((l) => l.startsWith("create"))).toEqual([]);
    expect(fake.currentPage.children.length).toBe(kids);
  });

  const cases: Array<[string, (b: { id: string; panels: BoardPanel[] }) => Any, string, RegExp]> = [
    ["a frame that is not a storyboard", () => ({ storyboardId: fake.frame().id }), "INVALID_PARAM", /is not a storyboard figma_create_storyboard made/],
    ["an unknown id", () => ({ storyboardId: "404:1" }), "NODE_NOT_FOUND", /No node with id `404:1`/],
    ["a panel retimed to fall between two frames", (b) => {
      // Panel 3 now ends 0.3 frame after its start frame, so panel 4 runs from 0.3 to 0.6 of the next.
      setChars(b.panels[2]!.captionIds.duration!, "0.01 s");
      setChars(b.panels[3]!.captionIds.duration!, "0.01 s");
      return { storyboardId: b.id };
    }, "INVALID_PARAM", /Panel 04 lasts less than one frame at 30 fps/],
    ["dissolveFrames over 12", (b) => ({ storyboardId: b.id, dissolveFrames: 13 }), "INVALID_PARAM", /dissolveFrames/],
    ["a pageId that is a frame", (b) => ({ storyboardId: b.id, pageId: fake.frame().id }), "INVALID_PARAM", /is a FRAME, not a page/],
    ["no storyboardId", () => ({}), "INVALID_PARAM", /`storyboardId` is required/],
  ];
  it.each(cases)("refused before the first node: %s", async (_label, params, code, pattern) => {
    const { b } = await kiln();
    const p = params(b);
    const before = fake.log.length;
    const kids = fake.currentPage.children.length;
    const e = await refusal(animatic(p));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(pattern);
    expect(e.partial).toEqual({ created: [] });
    expect(fake.log.slice(before).filter((l) => l.startsWith("create"))).toEqual([]);
    expect(fake.currentPage.children.length).toBe(kids);
    expect(motion.applies).toEqual([]);
  });

  it("a failure after the build names what exists", async () => {
    const { b } = await kiln();
    const original = nodeProto.setTimelineDuration;
    nodeProto.setTimelineDuration = () => {
      throw new Error("duration out of range");
    };
    try {
      const e = await refusal(animatic({ storyboardId: b.id }));
      expect(e.message).toMatch(/The animatic was built, but setting the timeline duration failed: duration out of range/);
      const partial = e.partial as { created: Array<{ id: string }>; failedAt: string };
      expect(partial.failedAt).toBe("setting the timeline duration");
      expect(node(partial.created[0]!.id)!.name).toBe("Animatic · Kiln end card");
    } finally {
      nodeProto.setTimelineDuration = original;
    }
  });
});

// ── the server tool ──────────────────────────────────────────────────────────

describe("figma_create_animatic on the server", () => {
  type Tool = { config: { description: string; inputSchema: Record<string, z.ZodTypeAny> }; handler: (a: Any, e: Extra) => Promise<CallToolResult> };
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
  const requests: Array<{ op: string; p: Any }> = [];
  const bridge = {
    request: async (op: string, p: Any) => {
      requests.push({ op, p });
      return { animaticId: "9:9" };
    },
    statusAsync: async () => ({ sessions: [] }),
  } as unknown as Bridge;
  registerStoryboard(server, bridge, () => true);
  const tool = tools.figma_create_animatic!;
  const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

  it("registers beside the storyboard, with its schema and a description that fits the cap with its Editors sentence", () => {
    expect(Object.keys(tools)).toEqual(["figma_create_storyboard", "figma_create_animatic"]);
    expect(Object.keys(tool.config.inputSchema)).toEqual(["storyboardId", "width", "burnIn", "dissolveFrames", "drift", "pageId", "x", "y", "session", "idempotencyKey", "force"]);
    expect(tool.config.description).toMatch(/One undo step\.$/);
    // The row the integrator adds is Design unmeasured, FigJam and Slides "no": the longest sentence is the unmeasured-everywhere one.
    expect(tool.config.description.length + Math.max(editorsSuffix("create_animatic").length, " Editors: Design only, unverified.".length)).toBeLessThanOrEqual(1024);
  });

  it("stays inside the portable schema subset", () => {
    const json = JSON.stringify(z.toJSONSchema(z.object(ANIMATIC_SHAPE).strict(), { io: "input" }));
    for (const banned of ['"anyOf"', '"oneOf"', '"allOf"', '"const"', '"format"', '"$ref"', '"propertyNames"']) expect(json).not.toContain(banned);
    expect(ANIMATIC_SHAPE.burnIn.safeParse("all").success).toBe(false);
    expect(ANIMATIC_SHAPE.dissolveFrames.safeParse(13).success).toBe(false);
    expect(ANIMATIC_SHAPE.width.safeParse(32).success).toBe(false);
  });

  it("refuses bad options before the bridge is asked", async () => {
    const res = await tool.handler({ storyboardId: "1:2", dissolveFrames: 2.5 }, extra);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(requests).toEqual([]);
  });

  it("forwards the call with the board and the page as ids the plugin resolves", async () => {
    await tool.handler({ storyboardId: "12-34", pageId: "0-1", drift: true }, extra);
    expect(requests).toEqual([{ op: "create_animatic", p: expect.objectContaining({ storyboardId: "12:34", pageId: "0:1", drift: true }) }]);
  });

  it("each tool registers only when the toolset wants it", () => {
    const names: string[] = [];
    const s = { registerTool: (n: string) => void names.push(n) } as unknown as McpServer;
    registerStoryboard(s, {} as Bridge, () => false);
    expect(names).toEqual([]);
    registerStoryboard(s, {} as Bridge, (op) => op === "create_animatic");
    expect(names).toEqual(["figma_create_animatic"]);
  });
});
