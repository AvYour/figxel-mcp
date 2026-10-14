// figma_set_keyframes and figma_remove_keyframes read every track back.
//
// On 2026-10-09, calls that replaced several tracks of one layer kept only the
// last; the others held their old keys in a read 6 s later, while every
// one-track call landed [C-201]. Why is not settled [C-202], so each fake below
// is one candidate, and the fix must converge under all of them [C-250]:
//
//   coalesce     (H1a) writes in one synchronous run are computed from the
//                record as it was when the run began, and the host's next turn
//                commits only the last;
//   staleHandle  (H1b) a handle applies every write from the record as it was
//                when the handle was fetched;
//   staleRead    (H3)  nothing is lost, but reads lag until the host's turn;
//   fork         (H2)  the first write moves the timeline to a new id.
//
// spikes/live-keyframe-tracks.mjs runs the same cells against Figma.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { makeBatchOp } from "../src/plugin/ops/batch.js";
import { MOTION_OPS } from "../src/plugin/ops/motion.js";

type Field = { type: string; name?: string };
type Key = { timelinePosition: number; value: { type: string; value: number }; easing?: unknown };
type Binding = { id: string; baseValue: unknown; keyframes: Key[] };
type TrackRecord = Record<string, Binding>;
type Mode = "normal" | "coalesce" | "staleHandle" | "staleRead" | "fork";

const page = { id: "0:1", name: "Page", type: "PAGE" };
const frame = { id: "42:15039", name: "Ad", type: "FRAME", parent: page };
const LAYER = "42:15082";

const OLD: Record<string, number> = { OPACITY: 0.5, TRANSLATION_X: 10, ROTATION: 5 };
const NEW: Record<string, number> = { OPACITY: 0.25, TRANSLATION_X: 77, ROTATION: 33, SCALE_X: 1.5 };
const BASE: Record<string, number> = { OPACITY: 1, TRANSLATION_X: 0, ROTATION: 0, SCALE_X: 1 };

const keys = (f: string, to: number): Key[] => [
  { timelinePosition: 0, value: { type: "FLOAT", value: BASE[f]! }, easing: { type: "LINEAR" } },
  { timelinePosition: 0.8, value: { type: "FLOAT", value: to }, easing: { type: "EASE_OUT" } },
];
let ids = 0;
const binding = (ks: Key[]): Binding => ({ id: `track:${++ids}`, baseValue: { type: "FLOAT", value: 0 }, keyframes: ks.map((k) => ({ easing: { type: "LINEAR" }, ...k })) });
const without = (r: TrackRecord, f: string): TrackRecord => Object.fromEntries(Object.entries(r).filter(([k]) => k !== f));

/** One animated layer whose keyframe record behaves as `mode` says. */
class Layer {
  committed: TrackRecord = {};
  /** coalesce: what the host's next turn commits. */
  pending: TrackRecord | null = null;
  /** staleRead: what reads show until the host's next turn. */
  visible: TrackRecord = {};
  applies: Array<{ field: string; handle: number }> = [];
  removals: Array<{ field: string; handle: number }> = [];
  handles = 0;
  yields = 0;
  durations: Array<{ id: string; duration: number }> = [];
  timeline = { id: frame.id, duration: 1 };
  /** Fields whose writes Figma never keeps. */
  dropped = new Set<string>();
  /** Fields Figma will not remove. */
  stuck = new Set<string>();
  /** Turn a written value into what Figma stores. */
  stores = (_f: string, v: number) => v;
  /** Lookups after this many answer null: the id stopped resolving. */
  resolvesFor = Infinity;

  constructor(public mode: Mode) {
    for (const [f, v] of Object.entries(OLD)) this.committed[f] = binding(keys(f, v));
    this.visible = { ...this.committed };
  }

  /** The host's turn between two plugin turns. */
  turn(): void {
    if (this.pending) this.committed = this.pending;
    this.pending = null;
    this.visible = { ...this.committed };
  }

  last(f: string): number | undefined {
    return this.committed[f]?.keyframes.at(-1)?.value.value;
  }

  private write(next: (base: TrackRecord) => TrackRecord, snapshot: TrackRecord): void {
    if (this.mode === "coalesce") this.pending = next(this.committed);
    else if (this.mode === "staleHandle") this.committed = next(snapshot);
    else this.committed = next(this.committed);
  }

  handle() {
    const serial = ++this.handles;
    const snapshot = { ...this.committed };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const layer = this;
    return {
      id: LAYER, name: "S1/Window", type: "RECTANGLE", parent: frame,
      fills: [], strokes: [], effects: [], animations: {}, animationStyles: [],
      get manualKeyframeTracks() {
        return layer.mode === "staleRead" ? layer.visible : layer.committed;
      },
      get timelines() {
        return [{ ...layer.timeline }];
      },
      getTopLevelFrame() {
        return layer.timeline.id === frame.id ? frame : { id: layer.timeline.id, name: frame.name, type: "FRAME", parent: page };
      },
      applyManualKeyframeTrack(field: Field, track: { keyframes: Key[] }) {
        const f = field.name!;
        layer.applies.push({ field: f, handle: serial });
        if (layer.mode === "fork") layer.timeline = { ...layer.timeline, id: "47:559" };
        if (layer.dropped.has(f)) return;
        const stored = track.keyframes.map((k) => ({ ...k, value: { ...k.value, value: layer.stores(f, k.value.value) } }));
        layer.write((base) => ({ ...base, [f]: binding(stored) }), snapshot);
      },
      removeManualKeyframeTrack(field: Field) {
        const f = field.name!;
        layer.removals.push({ field: f, handle: serial });
        if (!layer.stuck.has(f)) layer.write((base) => without(base, f), snapshot);
      },
      setTimelineDuration(id: string, duration: number) {
        layer.durations.push({ id, duration });
        layer.timeline = { ...layer.timeline, duration };
      },
    };
  }
}

let layer: Layer;
const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r",
  params,
  yieldToHost: async () => {
    layer.yields++;
    layer.turn();
  },
  progress() {},
  isCancelled: () => false,
});
const replaceAll = (fields = Object.keys(OLD)) => ({
  nodeId: LAYER,
  tracks: fields.map((f) => ({ field: f, keyframes: [{ t: 0, value: String(BASE[f]) }, { t: 0.8, value: String(NEW[f]), easing: "EASE_OUT" }] })),
});
const run = async (op: string, params: Record<string, unknown>) => {
  const r = (await MOTION_OPS[op]!.run(ctx(params))) as Record<string, unknown>;
  layer.turn(); // the host's turn after the call: what is committed now is what Figma kept
  return r;
};
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string; partial?: unknown };
  }
  throw new Error("expected a failure");
};
type Echo = Array<{ field: string; status: string; keyframes: Array<{ value: string }> }>;
const lastEcho = (r: Record<string, unknown>) => Object.fromEntries((r.tracks as Echo).map((t) => [t.field, t.keyframes.at(-1)?.value]));
const statuses = (r: Record<string, unknown>) => Object.fromEntries((r.tracks as Echo).map((t) => [t.field, t.status]));

function world(mode: Mode): Layer {
  layer = new Layer(mode);
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: { name: "doc", children: [page] },
    getNodeByIdAsync: async (id: string) => {
      if (id === frame.id) return frame;
      if (id !== LAYER || layer.handles >= layer.resolvesFor) return null;
      return layer.handle();
    },
  };
  return layer;
}
beforeEach(() => world("normal"));
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

// ── the candidates for the loss ──────────────────────────────────────────────

describe("figma_set_keyframes reads every track back [C-250]", () => {
  it("coalescing writes (H1a): all three replaced tracks end new; the two Figma dropped say rewritten", async () => {
    world("coalesce");
    const r = await run("set_keyframes", replaceAll());
    expect({ OPACITY: layer.last("OPACITY"), TRANSLATION_X: layer.last("TRANSLATION_X"), ROTATION: layer.last("ROTATION") }).toEqual({ OPACITY: 0.25, TRANSLATION_X: 77, ROTATION: 33 });
    expect(statuses(r)).toEqual({ OPACITY: "rewritten", TRANSLATION_X: "rewritten", ROTATION: "written" });
    expect(lastEcho(r)).toEqual({ OPACITY: "0.25", TRANSLATION_X: "77", ROTATION: "33" });
    expect(r.note).toMatch(/dropped 2 track\(s\).*written again/);
  });

  it("a stale handle (H1b): the call converges, and each repair goes through a handle of its own", async () => {
    world("staleHandle");
    const r = await run("set_keyframes", replaceAll());
    expect(["OPACITY", "TRANSLATION_X", "ROTATION"].map((f) => layer.last(f))).toEqual([0.25, 77, 33]);
    const first = layer.applies.slice(0, 3).map((a) => a.handle);
    const repairs = layer.applies.slice(3).map((a) => a.handle);
    expect(new Set(first).size).toBe(1);
    expect(repairs).toHaveLength(2);
    expect(new Set([...repairs, first[0]]).size).toBe(3);
    expect(statuses(r)).toEqual({ OPACITY: "rewritten", TRANSLATION_X: "rewritten", ROTATION: "written" });
  });

  it("a stale read (H3): nothing is written twice, and the echo is read after the host's turn", async () => {
    world("staleRead");
    const r = await run("set_keyframes", replaceAll());
    expect(layer.applies).toHaveLength(3);
    expect(lastEcho(r)).toEqual({ OPACITY: "0.25", TRANSLATION_X: "77", ROTATION: "33" });
    expect(statuses(r)).toEqual({ OPACITY: "written", TRANSLATION_X: "written", ROTATION: "written" });
    expect(r.note).toBeUndefined();
  });

  it("a forked timeline (H2): the frame's own id, a note, and the duration goes to the timeline read after the check", async () => {
    world("fork");
    const r = await run("set_keyframes", { ...replaceAll(), timelineDuration: 2 });
    expect(r.timeline).toEqual({ id: "47:559", duration: 2, topLevelFrameId: frame.id });
    expect(r.timelineNote).toMatch(/47:559.*42:15039/);
    expect(r.timelineNote).toMatch(/ids your create calls returned/);
    expect(layer.durations).toEqual([{ id: "47:559", duration: 2 }]);
  });

  it("a track Figma never keeps: INTERNAL with what landed and what did not, after three writes of it at most", async () => {
    layer.dropped.add("ROTATION");
    const e = await fails(run("set_keyframes", replaceAll()));
    expect(e.code).toBe("INTERNAL");
    expect(e.message).toMatch(/did not keep "ROTATION" after 3 writes/);
    expect(e.hint).toMatch(/one figma_set_keyframes call per track/);
    expect(e.partial).toEqual({ applied: ["OPACITY", "TRANSLATION_X"], notApplied: ["ROTATION"] });
    expect(layer.applies.filter((a) => a.field === "ROTATION")).toHaveLength(3);
    // The other two were written once: a repair touches only what is missing.
    expect(layer.applies.filter((a) => a.field !== "ROTATION")).toHaveLength(2);
  });

  it("a refused duration after a lost track names both, and claims only the tracks that were kept", async () => {
    layer.dropped.add("ROTATION");
    const handle = layer.handle.bind(layer);
    layer.handle = () =>
      Object.assign(handle(), {
        setTimelineDuration: () => {
          throw new Error("Duration out of range");
        },
      });
    const e = await fails(run("set_keyframes", { ...replaceAll(), timelineDuration: 3 }));
    expect(e.message).toMatch(/timeline duration 3 s: Duration out of range/);
    expect(e.partial).toEqual({ applied: ["OPACITY", "TRANSLATION_X"], failedAt: "timelineDuration", notApplied: ["ROTATION"] });
    expect(e.hint).toMatch(/did not keep ROTATION/);
  });

  it("the normal path costs one write per track and one host turn", async () => {
    const r = await run("set_keyframes", replaceAll());
    expect(layer.applies.map((a) => a.field)).toEqual(["OPACITY", "TRANSLATION_X", "ROTATION"]);
    expect(layer.yields).toBe(1);
    expect(statuses(r)).toEqual({ OPACITY: "written", TRANSLATION_X: "written", ROTATION: "written" });
    expect(r.note).toBeUndefined();
  });

  it("a value Figma stores differently is kept, not written three times", async () => {
    layer.stores = (f, v) => (f === "OPACITY" ? Math.min(v, 0.2) : v);
    const r = await run("set_keyframes", replaceAll());
    expect(layer.applies).toHaveLength(3);
    expect(statuses(r).OPACITY).toBe("written");
    expect(lastEcho(r).OPACITY).toBe("0.2");
  });

  it("an id that stops resolving right after the write is an INTERNAL error that names what was written", async () => {
    layer.resolvesFor = 1;
    const e = await fails(run("set_keyframes", replaceAll(["OPACITY"])));
    expect(e.code).toBe("INTERNAL");
    expect(e.partial).toEqual({ applied: ["OPACITY"], failedAt: "readback" });
    expect(e.hint).toMatch(/temporary/);
  });

  it("figma_batch: two set_keyframes steps under coalescing writes are both checked and repaired", async () => {
    world("coalesce");
    const r = (await makeBatchOp(() => MOTION_OPS).run(ctx({
      steps: [
        { op: "set_keyframes", params: replaceAll(["OPACITY", "TRANSLATION_X"]) },
        { op: "set_keyframes", params: replaceAll(["ROTATION", "SCALE_X"]) },
      ],
    }))) as { completed: number; itemsFailed?: unknown };
    layer.turn();
    expect(r.completed).toBe(2);
    expect(r.itemsFailed).toBeUndefined();
    expect(["OPACITY", "TRANSLATION_X", "ROTATION", "SCALE_X"].map((f) => layer.last(f))).toEqual([0.25, 77, 33, 1.5]);
  });
});

describe("figma_remove_keyframes reads every removal back [C-250]", () => {
  it("a removal Figma dropped is removed again and read back", async () => {
    world("coalesce");
    const r = await run("remove_keyframes", { nodeId: LAYER, fields: ["OPACITY", "ROTATION"] });
    expect(Object.keys(layer.committed)).toEqual(["TRANSLATION_X"]);
    expect(r).toMatchObject({ removed: ["OPACITY", "ROTATION"], remaining: ["TRANSLATION_X"] });
    expect(r.note).toMatch(/removed again/);
  });

  it("a track Figma will not remove: INTERNAL with what went and what stayed", async () => {
    layer.stuck.add("ROTATION");
    const e = await fails(run("remove_keyframes", { nodeId: LAYER, fields: ["OPACITY", "ROTATION"] }));
    expect(e.code).toBe("INTERNAL");
    expect(e.partial).toEqual({ removed: ["OPACITY"], notRemoved: ["ROTATION"] });
    expect(layer.removals.filter((x) => x.field === "ROTATION")).toHaveLength(3);
  });

  it("the normal path removes once, with one host turn", async () => {
    const r = await run("remove_keyframes", { nodeId: LAYER });
    expect(r).toEqual({ nodeId: LAYER, removed: ["OPACITY", "TRANSLATION_X", "ROTATION"], remaining: [] });
    expect([layer.removals.length, layer.yields]).toEqual([3, 1]);
  });
});
