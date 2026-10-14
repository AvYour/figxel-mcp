// The plugin half of figma_check_motion (src/plugin/ops/motion-snapshot.ts):
// it reads an animated top-level frame as a snapshot and judges nothing. The
// fakes follow the typings and the official motion skill [C-115] [C-183]:
// `manualKeyframeTracks` holds bindings with a base value and keyframes, the
// timeline belongs to the top-level frame, and an account without the Motion
// flag gets `"<name>" is not a supported API` from every motion member.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_SNAPSHOT_OPS } from "../src/plugin/ops/motion-snapshot.js";
import { auditMotion } from "../src/server/motion-audit.js";
import type { MotionSnapshot } from "../src/shared/motion-curves.js";

let seq = 0;
const byId = new Map<string, Fake>();

const float = (value: number) => ({ type: "FLOAT", value });
const key = (t: number, value: number, easing: Record<string, unknown> = { type: "LINEAR" }) => ({ id: `k${seq++}`, timelinePosition: t, value: float(value), easing });

class Fake {
  id: string;
  name: string;
  parent: Fake | null = null;
  children: Fake[] = [];
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  rotation = 0;
  opacity = 1;
  visible = true;
  clipsContent = false;
  effects: unknown[] = [];
  strokes: unknown[] = [];
  animationStyles: unknown[] = [];
  manualKeyframeTracks: Record<string, unknown> = {};
  timeline = { id: "", duration: 0 };
  /** Figma's own answer, which during a second-id period names another root [C-199]. */
  topLevelOverride: Fake | undefined;
  [key: string]: unknown;
  constructor(
    readonly type: string,
    name = type,
  ) {
    this.id = `5:${++seq}`;
    this.name = name;
    byId.set(this.id, this);
  }
  add(child: Fake): Fake {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  get timelines() {
    let n: Fake | null = this;
    while (n && n.parent && n.parent.type !== "PAGE") n = n.parent;
    return n && n.parent ? [n.timeline] : [];
  }
  getTopLevelFrame() {
    return this.topLevelOverride;
  }
}

let page: Fake;
const run = (params: Record<string, unknown>) =>
  MOTION_SNAPSHOT_OPS.check_motion!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<MotionSnapshot>;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string };
  }
  throw new Error("expected a failure");
};

/** A 1080 × 1920 frame on the page with an animated card, a text and a clipping mask. */
function ad(name = "Ad") {
  const frame = page.add(new Fake("FRAME", name));
  Object.assign(frame, { width: 1080, height: 1920, clipsContent: true, timeline: { id: `TL:${frame.id}`, duration: 2.4 } });
  const card = frame.add(new Fake("RECTANGLE", "Card"));
  Object.assign(card, { x: 40, y: 60, width: 200, height: 120, opacity: 0.5, effects: [{ type: "LAYER_BLUR", radius: 0, visible: true }] });
  card.manualKeyframeTracks = {
    TRANSLATION_X: { id: "t1", baseValue: float(0), keyframes: [key(0, 0), key(1, 300, { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.16, y1: 1, x2: 0.3, y2: 1 } })] },
    effects: { 0: { RADIUS: { id: "t2", baseValue: float(0), keyframes: [key(0, 0), key(0.5, 8)] } } },
  };
  const mask = frame.add(new Fake("FRAME", "Mask"));
  mask.clipsContent = true;
  const text = mask.add(new Fake("TEXT", "Title"));
  Object.assign(text, { characters: "Slow down.", fontSize: 96, strokes: [{ type: "SOLID", visible: false }] });
  const ring = frame.add(new Fake("VECTOR", "Ring"));
  Object.assign(ring, { strokes: [{ type: "SOLID" }], strokeCap: "ROUND", strokeWeight: 3 });
  return { frame, card, mask, text, ring };
}

beforeEach(() => {
  seq = 0;
  byId.clear();
  page = new Fake("PAGE", "Page 1");
  (page as unknown as { selection: Fake[] }).selection = [];
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: { name: "doc", children: [page] },
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("check_motion (plugin): a snapshot, judged on the server", () => {
  it("is a read", () => {
    expect(MOTION_SNAPSHOT_OPS.check_motion!.write).toBe(false);
  });

  it("reads the frame around the given layer: the root first, every parent before its children, defaults left out", async () => {
    const { frame, card, mask, text, ring } = ad();
    const s = await run({ nodeId: text.id });
    expect(s.root).toEqual({ id: frame.id, name: "Ad", width: 1080, height: 1920, durationS: 2.4, timelineId: `TL:${frame.id}` });
    expect(s.from).toBe("node");
    expect(s.truncated).toBe(false);
    expect(s.nodes.map((n) => [n.name, n.parentId])).toEqual([
      ["Ad", null],
      ["Card", frame.id],
      ["Mask", frame.id],
      ["Title", mask.id],
      ["Ring", frame.id],
    ]);
    const c = s.nodes.find((n) => n.id === card.id)!;
    expect(c).toMatchObject({ type: "RECTANGLE", x: 40, y: 60, width: 200, height: 120, opacity: 0.5, effects: [{ type: "LAYER_BLUR", radius: 0 }] });
    expect(c.tracks).toEqual([
      { field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0", easing: "LINEAR" }, { t: 1, value: "300", easing: "cubic:0.16,1,0.3,1" }], base: "0" },
      { field: "effect:0:RADIUS", keyframes: [{ t: 0, value: "0", easing: "LINEAR" }, { t: 0.5, value: "8", easing: "LINEAR" }], base: "0" },
    ]);
    expect(s.nodes.find((n) => n.id === mask.id)).toMatchObject({ clipsContent: true, childCount: 1 });
    const t = s.nodes.find((n) => n.id === text.id)!;
    expect(t).toMatchObject({ characters: "Slow down.", fontSize: 96 });
    expect(t.strokeCap).toBeUndefined(); // its only stroke is hidden
    expect(s.nodes.find((n) => n.id === ring.id)).toMatchObject({ strokeCap: "ROUND", strokeWeight: 3 });
    // Defaults stay off the wire: a large frame must stay small.
    expect("opacity" in t || "visible" in t || "rotation" in t || "tracks" in t).toBe(false);
  });

  it("finds the frame by walking parents, not through getTopLevelFrame(), which can name a second root [C-199]", async () => {
    const { frame, card } = ad();
    const twin = new Fake("FRAME", "Ad");
    card.topLevelOverride = twin;
    expect((await run({ nodeId: card.id })).root.id).toBe(frame.id);
  });

  it("a frame inside a section is still a top-level frame", async () => {
    const section = page.add(new Fake("SECTION", "Section"));
    const frame = section.add(new Fake("FRAME", "In section"));
    const card = frame.add(new Fake("RECTANGLE", "Card"));
    card.manualKeyframeTracks = { OPACITY: { id: "o", baseValue: float(1), keyframes: [key(0, 0), key(1, 1)] } };
    expect((await run({ nodeId: card.id })).root.id).toBe(frame.id);
    expect((await run({})).root.id).toBe(frame.id);
  });

  it("refuses a page or a section as the node, and a layer outside any frame", async () => {
    expect(await fails(run({ nodeId: page.id }))).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/PAGE/) });
    const section = page.add(new Fake("SECTION", "Section"));
    expect(await fails(run({ nodeId: section.id }))).toMatchObject({ code: "INVALID_PARAM" });
    expect(await fails(run({ nodeId: "9:9" }))).toMatchObject({ code: "NODE_NOT_FOUND" });
  });

  it("defaults to the selection's frame; a selection across frames is refused, naming them", async () => {
    const a = ad("A");
    const b = ad("B");
    (page as unknown as { selection: Fake[] }).selection = [a.text];
    const s = await run({});
    expect([s.root.id, s.from]).toEqual([a.frame.id, "selection"]);
    (page as unknown as { selection: Fake[] }).selection = [a.text, b.card];
    const e = await fails(run({}));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toContain(`"A" (${a.frame.id})`);
    expect(e.message).toContain(`"B" (${b.frame.id})`);
  });

  it("with nothing selected, the page's one animated frame; several are refused by name, none is refused with how to animate", async () => {
    const still = page.add(new Fake("FRAME", "Still"));
    still.add(new Fake("RECTANGLE", "Box"));
    expect(await fails(run({}))).toMatchObject({ code: "INVALID_PARAM", hint: expect.stringMatching(/figma_set_keyframes/) });
    const a = ad("A");
    expect(await run({})).toMatchObject({ root: { id: a.frame.id }, from: "page" });
    ad("B");
    expect((await fails(run({}))).message).toMatch(/2 animated frames: "A" .*"B"/);
  });

  it("stops at maxNodes and says so", async () => {
    const { text } = ad();
    const s = await run({ nodeId: text.id, maxNodes: 2 });
    expect(s.nodes).toHaveLength(2);
    expect(s).toMatchObject({ truncated: true, maxNodes: 2 });
  });

  it("an account without the Motion flag, or a build without the API, answers UNSUPPORTED before reading anything [C-115]", async () => {
    const { frame } = ad();
    Object.defineProperty(frame, "manualKeyframeTracks", {
      get() {
        throw new Error('"manualKeyframeTracks" is not a supported API');
      },
    });
    const gated = await fails(run({ nodeId: frame.id }));
    expect(gated).toMatchObject({ code: "UNSUPPORTED", hint: expect.stringMatching(/Do not retry/) });
    const old = page.add(new Fake("FRAME", "Old build"));
    delete (old as Record<string, unknown>).manualKeyframeTracks;
    expect(await fails(run({ nodeId: old.id }))).toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/no Motion API/) });
  });

  it("with nothing selected on a build without Motion, says so rather than 'no frame has keyframes'", async () => {
    const old = page.add(new Fake("FRAME", "Old build"));
    delete (old as Record<string, unknown>).manualKeyframeTracks;
    expect(await fails(run({}))).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("is what the server's judge reads: the snapshot audits end to end", async () => {
    const { text } = ad();
    const r = auditMotion(await run({ nodeId: text.id }));
    expect(r.root).toMatchObject({ name: "Ad", durationS: 2.4 });
    expect(r.checked).toEqual({ layers: 4, tracks: 2, keys: 4 });
    expect(r.expectedFrames).toBe(73);
  });
});
