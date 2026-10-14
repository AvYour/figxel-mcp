// Motion: keyframe tracks and the timeline [C-115]. The fakes behave like the
// typings and the official motion skill describe: a track lives in
// `manualKeyframeTracks` under its field, the timeline belongs to the top-level
// frame and is shared by its layers, and a user without the Motion flag gets
// `"<name>" is not a supported API` from every motion member.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_LIMITS, MOTION_OPS } from "../src/plugin/ops/motion.js";
import {
  easingToString,
  fieldFromString,
  fieldValueType,
  parseEasing,
  parseField,
  parseValue,
  styleTracksToText,
  valueToString,
} from "../src/plugin/motion-fields.js";

let seq = 0;
const byId = new Map<string, M>();
type Field = { type: string; name?: string; collection?: string; index?: number; field?: string; propertyId?: string };

class M {
  id = `5:${++seq}`;
  name: string;
  children: M[] = [];
  parent: M | null = null;
  fills: unknown[] = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  strokes: unknown[] = [];
  effects: unknown[] = [];
  animationStyles: unknown[] = [];
  manualKeyframeTracks: Record<string, unknown> = {};
  applied: Array<{ field: Field; track: { keyframes: unknown[] } }> = [];
  durations: Array<{ id: string; duration: number }> = [];
  timeline = { id: "TL:page", duration: 1 };
  constructor(readonly type: string) {
    this.name = type;
    byId.set(this.id, this);
  }
  add(c: M): M {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  /** As getTopLevelFrame(): the frame a page or a section holds, never the section itself (it returns a FrameNode). */
  top(): M | undefined {
    const canvas = (t: string | undefined) => t === "PAGE" || t === "SECTION";
    let n: M | null = this;
    while (n && n.parent && !canvas(n.parent.type)) n = n.parent;
    return n && n.parent && !canvas(n.type) ? n : undefined;
  }
  getTopLevelFrame() {
    return this.top();
  }
  get timelines() {
    const t = this.top();
    return t ? [t.timeline] : [];
  }
  /** Figma's `animations`: per the official skill, the manual tracks only, as bindings. */
  get animations() {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.manualKeyframeTracks)) {
      if (k === "fills" || k === "strokes" || k === "effects") continue;
      const b = v as { id: string; baseValue: unknown; keyframes: unknown[] };
      out[k] = { baseValue: b.baseValue, timelineDuration: 1, tracks: [{ id: b.id, keyframeOperation: "SET", keyframes: b.keyframes }] };
    }
    return out;
  }
  applyManualKeyframeTrack(field: Field, track: { keyframes: Array<Record<string, unknown>> }) {
    this.applied.push({ field, track });
    const binding = {
      id: `track:${seq++}`,
      baseValue: { type: "FLOAT", value: 0 },
      // Figma always reads an easing back; it fills in one the input left out.
      keyframes: track.keyframes.map((k, i) => ({ id: `kf:${i}`, easing: { type: "LINEAR" }, ...k })),
    };
    if (field.type === "PROPERTY") this.manualKeyframeTracks[field.name!] = binding;
    else {
      const coll = (this.manualKeyframeTracks[field.collection!] ??= {}) as Record<number, unknown>;
      coll[field.index!] = field.field ? { ...((coll[field.index!] as object) ?? {}), [field.field]: binding } : binding;
    }
  }
  removeManualKeyframeTrack(field: Field) {
    if (field.type === "PROPERTY") delete this.manualKeyframeTracks[field.name!];
    else delete (this.manualKeyframeTracks[field.collection!] as Record<number, unknown>)[field.index!];
  }
  setTimelineDuration(id: string, duration: number) {
    this.durations.push({ id, duration });
    this.top()!.timeline.duration = duration;
  }
}

let page: M;
const run = (op: string, params: Record<string, unknown>) =>
  MOTION_OPS[op]!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<Record<string, unknown>>;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string; partial?: unknown };
  }
  throw new Error("expected a failure");
};

/**
 * A top-level frame on the page with one rectangle inside. Its timeline carries
 * the frame's own id, as Figma's does outside a second-id period [C-199].
 */
function screen(name = "Screen"): { frame: M; card: M } {
  const frame = page.add(new M("FRAME"));
  frame.name = name;
  frame.timeline = { id: frame.id, duration: 1 };
  const card = frame.add(new M("RECTANGLE"));
  card.name = "Card";
  return { frame, card };
}

beforeEach(() => {
  seq = 0;
  byId.clear();
  page = new M("PAGE");
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: { name: "doc", children: [page] },
    selection: [],
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

// ── the string forms ─────────────────────────────────────────────────────────

describe("motion fields, values and easings as strings [C-115]", () => {
  it("parses every field form, and refuses a typo before Figma sees it", () => {
    expect(parseField("opacity")).toEqual({ type: "PROPERTY", name: "OPACITY" });
    expect(parseField("fill:0")).toEqual({ type: "INDEXED_ITEM", collection: "fills", index: 0 });
    expect(parseField("stroke:2")).toEqual({ type: "INDEXED_ITEM", collection: "strokes", index: 2 });
    expect(parseField("effect:1:radius")).toEqual({ type: "INDEXED_ITEM", collection: "effects", index: 1, field: "RADIUS" });
    expect(fieldFromString("fill:0:prop:Ab1")).toEqual({ type: "INDEXED_ITEM", collection: "fills", index: 0, propertyId: "Ab1" });
    expect(() => parseField("OPACTIY")).toThrow(/not an animatable property/);
    expect(() => parseField("effect:0")).toThrow(/which of its fields/);
    expect(() => parseField("effect:0:BLUR")).toThrow(/not an effect field/);
    expect(() => parseField("fill:0:COLOR")).toThrow(/whole colour/);
    // Reads keep a field newer than the typings' list instead of failing.
    expect(fieldFromString("FUTURE_FIELD")).toEqual({ type: "PROPERTY", name: "FUTURE_FIELD" });
  });

  it("knows each field's value type", () => {
    expect(fieldValueType(parseField("OPACITY"))).toBe("FLOAT");
    expect(fieldValueType(parseField("TRANSLATION_XY"))).toBe("VECTOR");
    expect(fieldValueType(parseField("SCALE_XY"))).toBe("VECTOR");
    expect(fieldValueType(parseField("fill:0"))).toBe("COLOR");
    expect(fieldValueType(parseField("effect:0:COLOR"))).toBe("COLOR");
    expect(fieldValueType(parseField("effect:0:OFFSET_Y"))).toBe("FLOAT");
    expect(fieldValueType(fieldFromString("fill:0:prop:p"))).toBeUndefined();
  });

  it("parses values by type and writes them back the same way", () => {
    expect(parseValue("120", "FLOAT")).toEqual({ type: "FLOAT", value: 120 });
    expect(parseValue("10, 20", "VECTOR")).toEqual({ type: "VECTOR", value: { x: 10, y: 20 } });
    expect(parseValue("#f00", "COLOR")).toEqual({ type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } });
    expect(() => parseValue("#fff", "FLOAT")).toThrow(/not a number/);
    expect(() => parseValue("10", "VECTOR")).toThrow(/"x,y"/);
    expect(() => parseValue("red", "COLOR")).toThrow(/not a colour/);
    expect(valueToString({ type: "FLOAT", value: 0.4000000059604645 })).toBe("0.4");
    expect(valueToString(parseValue("#ff000080", "COLOR"))).toBe("#ff000080");
    expect(valueToString(parseValue("#ff0000", "COLOR"))).toBe("#ff0000");
    expect(valueToString(parseValue("10,20", "VECTOR"))).toBe("10,20");
  });

  it("speaks Figma's easing names, and refuses the CSS spelling with the right one", () => {
    expect(parseEasing("ease_out")).toEqual({ type: "EASE_OUT" });
    expect(parseEasing("HOLD")).toEqual({ type: "HOLD" });
    expect(parseEasing("cubic:0.4,0,0.2,1")).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } });
    expect(parseEasing("spring:0.3")).toEqual({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.3 } });
    const e = (() => {
      try {
        parseEasing("EASE_IN_OUT");
      } catch (err) {
        return err as { hint?: string };
      }
    })();
    expect(e?.hint).toMatch(/EASE_IN_AND_OUT/);
    expect(() => parseEasing("cubic:1.5,0,0.2,1")).toThrow(/between 0 and 1/);
    expect(() => parseEasing("spring:2")).toThrow(/bounce between 0 and 1/);
    expect(() => parseEasing("bouncy-ish")).toThrow(/not an easing/);
    for (const s of ["EASE_IN_AND_OUT", "cubic:0.4,0,0.2,1", "spring:0.3"]) expect(easingToString(parseEasing(s))).toBe(s);
    expect(easingToString({ type: "VARIABLE_ALIAS", id: "VariableID:1:2" })).toBe("var:VariableID:1:2");
  });

  it("style tracks are the ones the manual tracks do not already account for", () => {
    const manual = { OPACITY: { id: "t1", keyframes: [{ id: "k1", timelinePosition: 0, value: { type: "FLOAT", value: 0 } }] } };
    const own = { tracks: [{ id: "t1", keyframeOperation: "SET", keyframes: manual.OPACITY.keyframes }] };
    expect(styleTracksToText({ OPACITY: own }, manual)).toEqual([]);
    const style = { id: "s1", keyframeOperation: "OFFSET", keyframes: [{ id: "k9", timelinePosition: 0.2, value: { type: "FLOAT", value: 12 } }] };
    expect(styleTracksToText({ OPACITY: { tracks: [...own.tracks, style] }, TRANSLATION_Y: { tracks: [style] } }, manual)).toEqual([
      { field: "OPACITY", operation: "OFFSET", keyframes: [{ t: 0.2, value: "12" }] },
      { field: "TRANSLATION_Y", operation: "OFFSET", keyframes: [{ t: 0.2, value: "12" }] },
    ]);
  });
});

// ── figma_set_keyframes ──────────────────────────────────────────────────────

describe("figma_set_keyframes", () => {
  it("writes each track and reads it back in the same string forms", async () => {
    const { card } = screen();
    const r = await run("set_keyframes", {
      nodeId: card.id,
      tracks: [
        { field: "OPACITY", keyframes: [{ t: 0.4, value: "1", easing: "EASE_OUT" }, { t: 0, value: "0" }] },
        { field: "fill:0", keyframes: [{ t: 0, value: "#ff0000" }, { t: 0.4, value: "#0000ff80", easing: "cubic:0.4,0,0.2,1" }] },
      ],
    });
    expect(card.applied.map((a) => a.field)).toEqual([{ type: "PROPERTY", name: "OPACITY" }, { type: "INDEXED_ITEM", collection: "fills", index: 0 }]);
    // Sorted by time, no baseValue: Figma derives it from the node.
    expect(card.applied[0]!.track).toEqual({
      keyframes: [
        { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
        { timelinePosition: 0.4, value: { type: "FLOAT", value: 1 }, easing: { type: "EASE_OUT" } },
      ],
    });
    expect(r.tracks).toEqual([
      { field: "OPACITY", status: "written", keyframes: [{ t: 0, value: "0", easing: "LINEAR" }, { t: 0.4, value: "1", easing: "EASE_OUT" }] },
      { field: "fill:0", status: "written", keyframes: [{ t: 0, value: "#ff0000", easing: "LINEAR" }, { t: 0.4, value: "#0000ff80", easing: "cubic:0.4,0,0.2,1" }] },
    ]);
    expect(r.extended).toBe(false);
    expect(r.timeline).toEqual({ id: card.parent!.id, duration: 1, topLevelFrameId: card.parent!.id });
    expect(r.timelineNote).toBeUndefined();
  });

  it("refuses, before any write, what Figma would reject or the agent did not mean", async () => {
    const { frame, card } = screen();
    card.fills = [{ type: "GRADIENT_LINEAR" }];
    const group = frame.add(new M("GROUP"));
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1", easing: "EASE_IN_OUT" }] }] }, /not Figma's name/],
      [{ nodeId: frame.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] }, /top-level frame/],
      [{ nodeId: card.id, tracks: [{ field: "fill:0", keyframes: [{ t: 0, value: "#ff0000" }] }] }, /only a SOLID paint/],
      [{ nodeId: card.id, tracks: [{ field: "stroke:0", keyframes: [{ t: 0, value: "#ff0000" }] }] }, /no index 0/],
      [{ nodeId: group.id, tracks: [{ field: "WIDTH", keyframes: [{ t: 0, value: "10" }] }] }, /cannot be animated on a GROUP/],
      [{ nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }, { field: "opacity", keyframes: [{ t: 1, value: "0" }] }] }, /appears twice/],
      [{ nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [] }] }, /at least one keyframe/],
      [{ nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: -1, value: "1" }] }] }, /0 or more/],
      [{ nodeId: card.id }, /`tracks`, `timelineDuration`, or both/],
    ];
    for (const [params, why] of cases) {
      const e = await fails(run("set_keyframes", params));
      expect(`${e.message} ${e.hint ?? ""}`).toMatch(why);
      expect(e.partial).toEqual({ created: [] });
    }
    expect([...card.applied, ...frame.applied, ...group.applied]).toEqual([]);
    expect(frame.timeline.duration).toBe(1);
  });

  it("grows the timeline to the last keyframe and never shrinks it on its own", async () => {
    const { frame, card } = screen();
    const r1 = await run("set_keyframes", { nodeId: card.id, tracks: [{ field: "TRANSLATION_Y", keyframes: [{ t: 0, value: "24" }, { t: 1.5, value: "0" }] }] });
    expect(r1).toMatchObject({ extended: true, timeline: { id: frame.id, duration: 1.5 } });
    const r2 = await run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0.4, value: "1" }] }] });
    expect(r2).toMatchObject({ extended: false, timeline: { duration: 1.5 } });
    expect(card.durations).toEqual([{ id: frame.id, duration: 1.5 }]);
  });

  it("applies an explicit duration as given, and says when it cuts keyframes off", async () => {
    const { card } = screen();
    const r = await run("set_keyframes", { nodeId: card.id, timelineDuration: 0.3, tracks: [{ field: "OPACITY", keyframes: [{ t: 0.4, value: "1" }] }] });
    expect(r.timeline).toMatchObject({ duration: 0.3 });
    expect(r.note).toMatch(/ends before the last keyframe/);
    // tracks: [] + a duration only sets the duration.
    const d = await run("set_keyframes", { nodeId: card.id, tracks: [], timelineDuration: 2 });
    expect(d).toMatchObject({ tracks: [], timeline: { duration: 2 }, extended: true });
  });

  it("a user without the Motion flag gets UNSUPPORTED, not a retry loop, and nothing changes", async () => {
    const { card } = screen();
    Object.defineProperty(card, "timelines", {
      get() {
        throw new Error('"timelines" is not a supported API');
      },
    });
    const e = await fails(run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.hint).toMatch(/Do not retry/);
    expect(e.partial).toEqual({ created: [] });
    expect(card.applied).toEqual([]);
    const read = await fails(run("get_motion_context", { nodeId: card.id }));
    expect(read.code).toBe("UNSUPPORTED");
  });

  it("a track Figma refuses mid-way says which ones were written — and does not claim nothing changed", async () => {
    const { card } = screen();
    const real = card.applyManualKeyframeTrack.bind(card);
    card.applyManualKeyframeTrack = (field, track) => {
      if (field.name === "ROTATION") throw new Error("Invalid keyframe value");
      real(field, track);
    };
    const e = await fails(
      run("set_keyframes", {
        nodeId: card.id,
        tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }, { field: "ROTATION", keyframes: [{ t: 0, value: "90" }] }],
      }),
    );
    expect(e.message).toMatch(/Figma refused the track "ROTATION": Invalid keyframe value/);
    expect(e.partial).toEqual({ applied: ["OPACITY"], failedAt: "ROTATION" });
    expect(e.hint).toMatch(/Written before it and kept: OPACITY/);
  });

  it("a first track Figma refuses changed nothing and says so, so the key is free for the corrected retry", async () => {
    const { card } = screen();
    card.applyManualKeyframeTrack = () => {
      throw new Error("Invalid keyframe value");
    };
    const e = await fails(
      run("set_keyframes", {
        nodeId: card.id,
        tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }, { field: "ROTATION", keyframes: [{ t: 0, value: "90" }] }],
      }),
    );
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/Figma refused the track "OPACITY": Invalid keyframe value/);
    expect(e.hint).toMatch(/figma_get_motion_context/);
    expect(e.partial).toEqual({ created: [] });
  });

  it("a refused timeline duration changed nothing when it was the only write, and keeps the tracks otherwise", async () => {
    const { card } = screen();
    card.setTimelineDuration = () => {
      throw new Error("Duration out of range");
    };
    const only = await fails(run("set_keyframes", { nodeId: card.id, tracks: [], timelineDuration: 2 }));
    expect(only.message).toMatch(/timeline duration 2 s: Duration out of range/);
    expect(only.partial).toEqual({ created: [] });
    // The keyframe at 2 s outgrows the 1 s timeline, so the refused growth comes after a written track.
    const after = await fails(run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 2, value: "1" }] }] }));
    expect(after.partial).toEqual({ applied: ["OPACITY"], failedAt: "timelineDuration" });
    expect(after.hint).toMatch(/written and kept: OPACITY/);
  });

  it("a Figma build without the Motion API is the same answer", async () => {
    const t = page.add(new M("FRAME")).add(new M("TEXT"));
    Object.defineProperty(t, "applyManualKeyframeTrack", { value: undefined });
    const e = await fails(run("set_keyframes", { nodeId: t.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/no Motion API/);
  });
});

// ── figma_remove_keyframes ───────────────────────────────────────────────────

describe("figma_remove_keyframes", () => {
  it("removes the named tracks, reports the ones that were not there, and keeps the rest", async () => {
    const { card } = screen();
    await run("set_keyframes", {
      nodeId: card.id,
      tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }] }, { field: "ROTATION", keyframes: [{ t: 0, value: "90" }] }],
    });
    const r = await run("remove_keyframes", { nodeId: card.id, fields: ["opacity", "SCALE_X"] });
    expect(r).toEqual({ nodeId: card.id, removed: ["OPACITY"], notAnimated: ["SCALE_X"], remaining: ["ROTATION"] });
    const all = await run("remove_keyframes", { nodeId: card.id });
    expect(all).toMatchObject({ removed: ["ROTATION"], remaining: [] });
  });

  it("a first removal Figma refuses changed nothing; a later one names what went", async () => {
    const { card } = screen();
    await run("set_keyframes", {
      nodeId: card.id,
      tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }] }, { field: "ROTATION", keyframes: [{ t: 0, value: "90" }] }],
    });
    const real = card.removeManualKeyframeTrack.bind(card);
    card.removeManualKeyframeTrack = (field) => {
      if (field.name === "ROTATION") throw new Error("Track is locked");
      real(field);
    };
    const first = await fails(run("remove_keyframes", { nodeId: card.id, fields: ["ROTATION", "OPACITY"] }));
    expect(first.message).toMatch(/remove the track "ROTATION": Track is locked/);
    expect(first.partial).toEqual({ created: [] });
    expect(Object.keys(card.manualKeyframeTracks).sort()).toEqual(["OPACITY", "ROTATION"]);
    const later = await fails(run("remove_keyframes", { nodeId: card.id, fields: ["OPACITY", "ROTATION"] }));
    expect(later.partial).toEqual({ removed: ["OPACITY"], failedAt: "ROTATION" });
  });
});

// ── figma_get_motion_context ─────────────────────────────────────────────────

describe("figma_get_motion_context", () => {
  it("lists animated layers with tracks that round-trip, grouped into timeline cohorts", async () => {
    const a = screen("A");
    const second = a.frame.add(new M("TEXT"));
    second.name = "Title";
    const b = screen("B");
    for (const n of [a.card, second, b.card]) {
      await run("set_keyframes", { nodeId: n.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.4, value: "1", easing: "EASE_OUT" }] }] });
    }
    const r = await run("get_motion_context", {});
    expect(r.scope).toMatchObject({ from: "page", recursive: true });
    const nodes = r.nodes as Array<{ nodeId: string; topLevelFrameId: string; tracks: unknown[]; summary: string; styleTracks?: unknown }>;
    expect(nodes.map((n) => n.nodeId)).toEqual([a.card.id, second.id, b.card.id]);
    expect(nodes[0]!.topLevelFrameId).toBe(a.frame.id);
    expect(nodes[0]!.tracks).toEqual([{ field: "OPACITY", keyframes: [{ t: 0, value: "0", easing: "LINEAR" }, { t: 0.4, value: "1", easing: "EASE_OUT" }] }]);
    // `animations` repeats the manual tracks here (the official skill's reading), so no style tracks are invented.
    expect(nodes[0]!.styleTracks).toBeUndefined();
    expect(nodes[0]!.summary).toBe("OPACITY 0 → 1 over 0–0.4 s (EASE_OUT)");
    expect(r.timelineCohorts).toEqual([
      { rootNodeId: a.frame.id, timelineId: a.frame.id, timelineIds: [a.frame.id], durationMs: 1000, memberNodeIds: [a.card.id, second.id] },
      { rootNodeId: b.frame.id, timelineId: b.frame.id, timelineIds: [b.frame.id], durationMs: 1000, memberNodeIds: [b.card.id] },
    ]);
    expect(r.limits).toEqual(MOTION_LIMITS);
  });

  it("defaults to the layers selected on the page, not the whole page [C-097]", async () => {
    // PluginAPI has no `selection`; the fake keeps `figma.selection` empty, as the editor does.
    const a = screen("A");
    const b = screen("B");
    for (const n of [a.card, b.card]) {
      await run("set_keyframes", { nodeId: n.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.4, value: "1" }] }] });
    }
    (page as unknown as { selection: M[] }).selection = [a.card];
    const r = await run("get_motion_context", {});
    expect(r.scope).toMatchObject({ from: "selection", ids: [a.card.id] });
    expect((r.nodes as Array<{ nodeId: string }>).map((n) => n.nodeId)).toEqual([a.card.id]);
  });

  it("reads a screen's layers by default — a top-level frame never animates itself [C-115]", async () => {
    const { frame, card } = screen();
    await run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] });
    const byNode = await run("get_motion_context", { nodeId: frame.id });
    expect(byNode).toMatchObject({ count: 1, scope: { from: "node", recursive: true } });
    // The screen selected, as design-to-code most often starts.
    (page as unknown as { selection: M[] }).selection = [frame];
    expect(await run("get_motion_context", {})).toMatchObject({ count: 1, scope: { from: "selection", recursive: true } });
  });

  it("recursive: false reads only the given layers and says what it left unread; a large tree pages", async () => {
    const { frame, card } = screen();
    await run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] });
    const narrow = await run("get_motion_context", { nodeId: frame.id, recursive: false });
    expect(narrow).toMatchObject({ count: 0, scope: { recursive: false } });
    expect(narrow.note).toMatch(/children were not read/);
    expect((await run("get_motion_context", { nodeId: card.id, recursive: false })).count).toBe(1);
    const first = await run("get_motion_context", { nodeId: frame.id, maxNodes: 1 });
    expect(first).toMatchObject({ count: 0, truncated: true });
    const rest = await run("get_motion_context", { nodeId: frame.id, maxNodes: 1, cursor: first.nextCursor });
    expect(rest).toMatchObject({ count: 1, truncated: false });
  });

  it("a layer Figma lists under a second root: its frame is the page's child, and one cohort lists every timeline id [C-199]", async () => {
    const { frame, card } = screen("Ad");
    const title = frame.add(new M("TEXT"));
    title.name = "Title";
    for (const n of [card, title]) {
      await run("set_keyframes", { nodeId: n.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.4, value: "1" }] }] });
    }
    // During a second-id period getTopLevelFrame() and timelines[0] name a second root (on 2026-10-09: 47:2168).
    const second = { id: "47:2168", name: "Ad", type: "FRAME" } as unknown as M;
    Object.defineProperty(title, "timelines", { get: () => [{ id: second.id, duration: 1 }] });
    title.getTopLevelFrame = () => second;
    const r = await run("get_motion_context", { nodeId: frame.id });
    const nodes = r.nodes as Array<{ nodeId: string; topLevelFrameId: string; timeline: { id: string } }>;
    expect(nodes.map((n) => n.topLevelFrameId)).toEqual([frame.id, frame.id]);
    expect(nodes[1]!.timeline.id).toBe(second.id); // still reported — as a timeline id, never as a node's
    const cohorts = r.timelineCohorts as Array<Record<string, unknown>>;
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({ rootNodeId: frame.id, timelineIds: [frame.id, second.id], memberNodeIds: [card.id, title.id] });
    expect(cohorts[0]!.note).toMatch(/47:2168.*temporary ids.*create calls returned/);
  });

  it("a frame inside a section is the top-level frame, never the section — as figma_check_motion reads it", async () => {
    const section = page.add(new M("SECTION"));
    const frame = section.add(new M("FRAME"));
    frame.timeline = { id: frame.id, duration: 1 };
    const card = frame.add(new M("RECTANGLE"));
    const set = await run("set_keyframes", { nodeId: card.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.4, value: "1" }] }] });
    expect(set.timeline).toEqual({ id: frame.id, duration: 1, topLevelFrameId: frame.id });
    expect(set.timelineNote).toBeUndefined();
    const r = await run("get_motion_context", { nodeId: frame.id });
    expect((r.nodes as Array<{ topLevelFrameId: string }>)[0]!.topLevelFrameId).toBe(frame.id);
    const cohorts = r.timelineCohorts as Array<Record<string, unknown>>;
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({ rootNodeId: frame.id, timelineIds: [frame.id] });
    expect(cohorts[0]!.note).toBeUndefined();
  });

  it("an id that no longer resolves says an id read from a listing can be temporary [C-199] [C-187]", async () => {
    const tracks = [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }];
    for (const [op, params] of [
      ["get_motion_context", { nodeId: "45:442" }],
      ["set_keyframes", { nodeId: "45:442", tracks }],
      ["remove_keyframes", { nodeId: "45:442" }],
    ] as const) {
      const e = await fails(run(op, params));
      expect(e.code, op).toBe("NODE_NOT_FOUND");
      expect(e.hint, op).toMatch(/can be temporary.*Use the id your create call returned/);
    }
  });

  it("maps applied animation styles, easing props included", async () => {
    const { card } = screen();
    card.animationStyles = [{ type: "FIGMA", id: "as:1", styleId: "fade", name: "Fade in", duration: 0.3, timelineOffset: 0, props: { easing: { type: "EASE_OUT" }, distance: 24 } }];
    const r = await run("get_motion_context", { nodeId: card.id });
    const n = (r.nodes as Array<{ animationStyles: unknown[]; summary: string }>)[0]!;
    expect(n.animationStyles).toEqual([{ id: "as:1", type: "FIGMA", name: "Fade in", styleId: "fade", duration: 0.3, timelineOffset: 0, props: { easing: "EASE_OUT", distance: 24 } }]);
    expect(n.summary).toBe('style "Fade in" 0.3 s');
  });
});
