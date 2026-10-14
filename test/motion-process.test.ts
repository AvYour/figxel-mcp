// The motion process, enforced by the tools (BRIDGE_PROCESS; spec ADR #41):
// the plan checker rule by rule, the plugin's store op and the plans
// figma_get_motion_context and the check's snapshot read back, and every gate
// through a real MCP client in strict, guided and off — the keyframe writes
// (also as figma_batch steps), the skill reads that open them (figma_get_guide,
// the prompts, the skill:// resources), and the final render that waits for a
// passing check — the plan's own, on a file unchanged since — while previews
// always render.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOTION_PLAN_KEY, MOTION_PLAN_NAMESPACE, type MotionPlanRecord } from "../src/shared/motion-plan.js";
import type { MotionSnapshot } from "../src/shared/motion-curves.js";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_OPS } from "../src/plugin/ops/motion.js";
import { MOTION_PLAN_OPS } from "../src/plugin/ops/motion-plan.js";
import { MOTION_SNAPSHOT_OPS } from "../src/plugin/ops/motion-snapshot.js";
import type { Bridge } from "../src/server/bridge.js";
import { ConfigError, loadConfig, readOrCreateToken, type ProcessMode } from "../src/server/config.js";
import { connect, createApp } from "../src/server/mcp.js";
import { nearestGridFrame, readNeedS } from "../src/server/motion-audit.js";
import { copyOf, planMotion } from "../src/server/motion-plan.js";
import { fileNow, MotionProcess, type CheckRecord, type FileNow } from "../src/server/motion-process.js";
import { registerSkillResources } from "../src/server/resources.js";
import { withPlan } from "../src/server/tools/check-motion.js";
import { writeEpoch } from "../src/server/tools/forward.js";
import { registerTools } from "../src/server/tools/index.js";
import { loadSnapshot } from "./fixtures/motion-2026-10-09/snapshot.js";
import { quietLogger } from "./helpers.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

/** A plan that passes: 6 s at 30 fps, 120 BPM (15 frames a beat), three beats back to back. */
function plan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: "1:1",
    brief: { audience: "runners", message: "Your pace, kept.", format: "1080x1920 IG Reels", durationS: 6, fps: 30, bpm: 120 },
    beats: [
      { name: "hook", from: 0, to: 1.5, onScreen: "[shoe close-up] Your pace", action: "the shoe lands", transition: "the stride carries into the track", accent: 0.5 },
      { name: "proof", from: 1.5, to: 4, onScreen: "Kept for every mile you run", action: "the ring fills", transition: "the ring becomes the logo" },
      { name: "end card", from: 4, to: 6, onScreen: "[logo lockup] Download now", action: "the logo settles", transition: "holds to the end" },
    ],
    ...extra,
  };
}

/** A check that passed whole against no plan, begun now, as figma_check_motion records one. */
const passed = (over: Partial<CheckRecord> = {}): CheckRecord => ({ ok: true, fps: 30, full: true, gaps: [], plan: null, epoch: writeEpoch(), at: Date.now(), accepted: [], ...over });
/** The file as it stands now, with no change reported by Figma. */
const now = (over: Partial<FileNow> = {}): FileNow => ({ epoch: writeEpoch(), changedAt: Number.NEGATIVE_INFINITY, ...over });
const WROTE = "the file changed after the last figma_check_motion (a write sent through Figxel)";

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    return ((e as { partial?: { problems?: string[] } }).partial?.problems ?? []) as string[];
  }
  throw new Error("expected a refusal");
};

// ── configuration ───────────────────────────────────────────────────────────

describe("BRIDGE_PROCESS", () => {
  const home = mkdtempSync(join(tmpdir(), "fmcp-process-cfg-"));

  it("is strict by default; guided and off are the other modes; anything else stops the server", () => {
    expect(loadConfig({ BRIDGE_HOME: home }).processMode).toBe("strict");
    expect(loadConfig({ BRIDGE_HOME: home, BRIDGE_PROCESS: "guided" }).processMode).toBe("guided");
    expect(loadConfig({ BRIDGE_HOME: home, BRIDGE_PROCESS: " off " }).processMode).toBe("off");
    expect(() => loadConfig({ BRIDGE_HOME: home, BRIDGE_PROCESS: "lenient" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_HOME: home, BRIDGE_PROCESS: "Strict" })).toThrow(/BRIDGE_PROCESS="Strict" must be one of strict, guided, off/);
  });
});

// ── the plan checker ────────────────────────────────────────────────────────

describe("planMotion: a motion plan checked before anything is stored", () => {
  it("returns the record to store and each beat in frames, with its read time", () => {
    const { record, beats, durationFrames } = planMotion(plan({ holds: [{ from: 5, to: 6 }], cuts: [4], brandId: "1-5", ctaId: "1:6" }));
    expect(record).toEqual({
      v: 1,
      brief: { audience: "runners", message: "Your pace, kept.", format: "1080x1920 IG Reels", durationS: 6, fps: 30, bpm: 120 },
      beats: (plan().beats as MotionPlanRecord["beats"]).map((b) => ({ ...b })),
      holds: [{ from: 5, to: 6 }],
      cuts: [4],
      // A pasted "1-5" is the id the plugin resolves.
      brandId: "1:5",
      ctaId: "1:6",
    });
    expect(durationFrames).toBe(180);
    expect(beats.map((b) => [b.name, b.startFrame, b.endFrame, b.words])).toEqual([
      ["hook", 0, 45, 2],
      ["proof", 45, 120, 6],
      ["end card", 120, 180, 2],
    ]);
    expect(beats[0]!.accentFrame).toBe(15);
    expect(beats[1]!.needS).toBe(1.8);
  });

  it("uses the read-time rule figma_check_motion judges text by, and leaves [picture notes] untimed [C-241]", () => {
    expect(copyOf("[logo on black] Bake it yourself")).toBe("Bake it yourself");
    expect(copyOf("[wide shot, bakery at dawn]")).toBe("");
    expect(readNeedS("Bake it yourself")).toBeCloseTo(0.9);
    expect(readNeedS("Go")).toBeCloseTo(5 / 6);
    const short = plan();
    (short.beats as Array<Record<string, unknown>>)[0] = { name: "hook", from: 0, to: 0.5, onScreen: "Your pace, kept for every mile", action: "a", transition: "b" };
    (short.beats as Array<Record<string, unknown>>)[1]!.from = 0.5;
    const problems = problemsOf(() => planMotion(short));
    expect(problems).toEqual([expect.stringMatching(/^beats\[0\] "hook" is 0\.5 s, but its copy "Your pace, kept for every mile" \(6 words\) needs 1\.8 s to read/)]);
    // The same beat with the copy as a picture note is fine.
    (short.beats as Array<Record<string, unknown>>)[0]!.onScreen = "[the runner's face, no copy]";
    expect(() => planMotion(short)).not.toThrow();
  });

  it("refuses gaps, overlaps, a late start and a short end, each named", () => {
    const p = plan({ brief: { audience: "a", message: "b", format: "c", durationS: 7, fps: 30 } });
    const beats = p.beats as Array<Record<string, unknown>>;
    beats[0]!.from = 0.1;
    beats[0]!.accent = 0.2;
    beats[1]!.from = 1.6;
    beats[2]!.from = 3.9;
    const problems = problemsOf(() => planMotion(p));
    expect(problems).toEqual([
      expect.stringMatching(/^`beats\[0\]\.from` is 0\.1 s; the first beat starts at 0\.$/),
      expect.stringMatching(/^`beats\[1\]\.from` 1\.6 s does not start where `beats\[0\]` ends \(1\.5 s\)/),
      expect.stringMatching(/^`beats\[2\]\.from` 3\.9 s does not start where `beats\[1\]` ends \(4 s\)/),
      expect.stringMatching(/^The last beat ends at 6 s, but `brief\.durationS` is 7 s/),
    ]);
  });

  it("holds every time to the frame grid and names the frames either side [C-193]", () => {
    const p = plan({ brief: { audience: "a", message: "b", format: "c", durationS: 6, fps: 24 } });
    (p.beats as Array<Record<string, unknown>>)[0]!.to = 1.3;
    (p.beats as Array<Record<string, unknown>>)[1]!.from = 1.3;
    const problems = problemsOf(() => planMotion(p));
    expect(problems).toContain("`beats[0].to` 1.3 s falls between frames at 24 fps; use 1.2917 (frame 31) or 1.3333 (frame 32).");
    // 38/30 written to four places is that frame, not between two.
    const q = plan();
    (q.beats as Array<Record<string, unknown>>)[0]!.to = 1.2667;
    (q.beats as Array<Record<string, unknown>>)[1]!.from = 1.2667;
    expect(() => planMotion(q)).not.toThrow();
  });

  it("holds an accent to the beat grid when there is a tempo, as beat_offset measures it [C-244]", () => {
    // At 120 BPM and 30 fps the beats and eighths fall on frames 0, 7.5, 15, 22.5, …
    expect(nearestGridFrame(15, 30, 120)).toBe(15);
    expect(nearestGridFrame(17, 30, 120)).toBe(15);
    expect(nearestGridFrame(20, 30, 120)).toBe(23);
    const off = plan();
    (off.beats as Array<Record<string, unknown>>)[0]!.accent = 0.6; // frame 18, the eighth is 15 (0.5 s) or 22.5
    expect(problemsOf(() => planMotion(off))).toEqual([expect.stringMatching(/^`beats\[0\]\.accent` lands on frame 18, 3 frames after the nearest beat or eighth \(frame 15, 0\.5 s at 120 BPM\)/)]);
    // Within a frame is on the beat; without a tempo any accent inside its beat is fine.
    (off.beats as Array<Record<string, unknown>>)[0]!.accent = 0.5333;
    expect(() => planMotion(off)).not.toThrow();
    const free = plan({ brief: { audience: "a", message: "b", format: "c", durationS: 6, fps: 30 } });
    (free.beats as Array<Record<string, unknown>>)[0]!.accent = 0.6;
    expect(() => planMotion(free)).not.toThrow();
    (free.beats as Array<Record<string, unknown>>)[0]!.accent = 2;
    expect(problemsOf(() => planMotion(free))).toEqual(["`beats[0].accent` 2 s is outside its beat (0–1.5 s)."]);
  });

  it("lists every problem at once: an fps Figma cannot render, an unnamed transition, an offset with no tempo", () => {
    const p = plan({ brief: { audience: " ", message: "b", format: "c", durationS: 6, fps: 25, beatOffset: 0.2 } });
    (p.beats as Array<Record<string, unknown>>)[2]!.transition = "   ";
    let err: { code?: string; message?: string; partial?: { created?: unknown; problems?: string[] } } = {};
    try {
      planMotion(p);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe(ErrorCode.INVALID_PARAM);
    expect(err.partial?.created).toEqual([]);
    expect(err.partial?.problems).toEqual([
      "`brief.fps` 25 is not a rate figma_export_video renders: 8, 12, 15, 24, 30, 60.",
      "`brief.beatOffset` needs `brief.bpm`: without a tempo there is no beat to offset.",
      "`brief.audience` is empty: say it in words.",
      "`beats[2].transition` is empty: say it in words.",
    ]);
    expect(err.message).toMatch(/^The motion plan is not ready; nothing was stored\. 4 problems:\n- `brief\.fps` 25/);
  });

  it("holds and cuts stay inside the piece and on frames", () => {
    expect(problemsOf(() => planMotion(plan({ holds: [{ from: 5, to: 7 }], cuts: [0, 6.01] })))).toEqual([
      "`holds[0]` must run forwards inside the piece (0–6 s).",
      "`cuts[0]` 0 s must be after 0 and inside the piece.",
      "`cuts[1]` 6.01 s must be after 0 and inside the piece.",
      "`cuts[1]` 6.01 s falls between frames at 30 fps; use 6 (frame 180) or 6.0333 (frame 181).",
    ]);
  });

  it("accept names a figma_check_motion rule, says why, and bounds it inside the piece, on frames", () => {
    const { record } = planMotion(
      plan({ accept: [{ rule: "cold_open", reason: " opens on a held product shot ", from: 0, to: 0.1 }, { rule: "cut_at_rest", reason: "hard cuts are the grammar" }] }),
    );
    expect(record.accept).toEqual([
      { rule: "cold_open", reason: "opens on a held product shot", from: 0, to: 0.1 },
      { rule: "cut_at_rest", reason: "hard cuts are the grammar" },
    ]);
    const bad = [
      { rule: "pops", reason: "x" },
      { rule: "strobe", reason: " " },
      { rule: "dead_span", reason: "y", from: 2, to: 1 },
      { rule: "dead_span", reason: "z", to: 0.11 },
    ];
    expect(problemsOf(() => planMotion(plan({ accept: bad })))).toEqual([
      '`accept[0].rule` "pops" is not a figma_check_motion rule.',
      "`accept[1].reason` is empty: say it in words.",
      "`accept[2]` must run forwards inside the piece (0–6 s).",
      "`accept[3].to` 0.11 s falls between frames at 30 fps; use 0.1 (frame 3) or 0.1333 (frame 4).",
    ]);
  });
});

// ── the check judged against the plan ───────────────────────────────────────

describe("withPlan: the check that may clear the delivery is the plan's own", () => {
  const record = planMotion(
    plan({
      brief: { audience: "runners", message: "Your pace, kept.", format: "1080x1920 IG Reels", durationS: 6, fps: 30, bpm: 120, beatOffset: 0.5 },
      holds: [{ from: 5, to: 6 }],
      brandId: "1:5",
      ctaId: "1:6",
      accept: [{ rule: "cold_open", reason: "opens on a held product shot" }],
    }),
  ).record;

  it("fills what the call leaves out from the plan, and lets the call be stricter", () => {
    const r = withPlan({ fps: 30 }, record);
    expect(r.opts).toMatchObject({ bpm: 120, beatOffset: 0.5, holds: [{ from: 5, to: 6 }], brandId: "1:5", ctaId: "1:6", accept: record.accept });
    expect(r.fromPlan).toEqual(["bpm", "beatOffset", "holds", "brandId", "ctaId", "accept"]);
    expect(r.gaps).toEqual([]);
    // A hold inside the plan's (in frames, as figma_review_video gives it), an earlier brand, a longer CTA hold, a default given as is.
    expect(withPlan({ fps: 30, holds: [{ from: 151 / 30, to: 179 / 30 }], brandBy: 2, ctaMinS: 3, thresholds: { stepShare: 0.4 } }, record).gaps).toEqual([]);
    // A tempo the plan has none of only adds a check.
    expect(withPlan({ bpm: 90 }, planMotion(plan({ brief: { audience: "a", message: "b", format: "c", durationS: 6, fps: 30 } })).record).gaps).toEqual([]);
  });

  it("names every loosening: another tempo, brand or CTA, a hold outside the plan's, a threshold off its default, a later brand, a shorter CTA", () => {
    const loose = {
      fps: 30,
      bpm: 100,
      beatOffset: 0.2,
      brandId: "1:9",
      ctaId: "1:8",
      holds: [{ from: 0, to: 6 }],
      thresholds: { stepShare: 1, deadSpanS: 9 },
      brandBy: 6,
      ctaMinS: 1,
    };
    expect(withPlan(loose, record).gaps).toEqual([
      "bpm 100, not the plan's 120",
      "beatOffset 0.2 s, not the plan's 0.5 s",
      "holds[0] 0–6 s is not inside a hold of the plan",
      "brandId 1:9, not the plan's 1:5",
      "ctaId 1:8, not the plan's 1:6",
      "thresholds.stepShare 1, not the default 0.4",
      "thresholds.deadSpanS 9, not the default 0.5",
      "brandBy 6 s, later than 3 s",
      "ctaMinS 1 s, shorter than 2.5 s",
    ]);
    // The call still runs as asked.
    expect(withPlan(loose, record).opts).toMatchObject({ bpm: 100, brandId: "1:9", holds: [{ from: 0, to: 6 }] });
    // Without a plan a hold declares nothing.
    expect(withPlan({ holds: [{ from: 1, to: 2 }] }, null).gaps).toEqual(["holds[0] 1–2 s is not inside a hold of the plan"]);
  });
});

// ── the plugin: storing and reading a plan ──────────────────────────────────

describe("the plugin stores a plan on the top-level frame, and figma_get_motion_context reads it back", () => {
  let seq = 0;
  const nodes = new Map<string, P>();
  class P {
    id = `2:${++seq}`;
    name: string;
    parent: P | null = null;
    children: P[] = [];
    manualKeyframeTracks: Record<string, unknown> = {};
    animations: Record<string, unknown> = {};
    animationStyles: unknown[] = [];
    data = new Map<string, string>();
    writes = 0;
    constructor(readonly type: string, name?: string) {
      this.name = name ?? type;
      nodes.set(this.id, this);
    }
    add(c: P): P {
      c.parent = this;
      this.children.push(c);
      return c;
    }
    get timelines() {
      return [{ id: "TL:1", duration: 6 }];
    }
    getSharedPluginData(ns: string, key: string) {
      return this.data.get(`${ns}/${key}`) ?? "";
    }
    setSharedPluginData(ns: string, key: string, value: string) {
      this.writes++;
      this.data.set(`${ns}/${key}`, value);
    }
  }
  let page: P;
  let frame: P;
  let card: P;
  let other: P;
  const ctx = (params: Record<string, unknown>) => ({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false }) as OpContext;
  const store = (params: Record<string, unknown>) => MOTION_PLAN_OPS.set_motion_plan!.run(ctx(params)) as Promise<Record<string, unknown>>;
  const fails = async (p: Promise<unknown>) => p.then(() => ({ code: "none" }) as Record<string, unknown>, (e: unknown) => e as Record<string, unknown>);

  beforeEach(() => {
    seq = 0;
    nodes.clear();
    page = new P("PAGE", "Page");
    frame = page.add(new P("FRAME", "Hero"));
    card = frame.add(new P("RECTANGLE", "Card"));
    other = page.add(new P("FRAME", "Other"));
    (globalThis as { figma?: unknown }).figma = {
      currentPage: page,
      root: { name: "doc", children: [page] },
      getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    };
  });
  afterEach(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });

  it("writes the checked record once, on the frame around the layer it was given, in the storyboard namespace", async () => {
    const { record } = planMotion(plan());
    const r = await store({ nodeId: card.id, plan: record });
    expect(r).toEqual({ frameId: frame.id, frameName: "Hero", replaced: false });
    expect(frame.writes).toBe(1);
    expect(card.writes).toBe(0);
    expect(JSON.parse(frame.getSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY))).toEqual(record);
    expect(MOTION_PLAN_NAMESPACE).toBe("figmamcp");
    expect((await store({ nodeId: frame.id, plan: record })).replaced).toBe(true);
  });

  it("refuses before the write: a page, a layer outside the frame as brandId, a plan the server never checked", async () => {
    const { record } = planMotion(plan());
    expect(await fails(store({ nodeId: page.id, plan: record }))).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    expect(await fails(store({ nodeId: card.id, plan: { ...record, brandId: other.id } }))).toMatchObject({
      code: "INVALID_PARAM",
      message: expect.stringMatching(/`brandId` "Other" \(2:4\) is not inside "Hero"/),
      partial: { created: [] },
    });
    expect(await fails(store({ nodeId: card.id, plan: { ...record, ctaId: "9:9" } }))).toMatchObject({ code: "NODE_NOT_FOUND", partial: { created: [] } });
    expect(await fails(store({ nodeId: card.id, plan: { beats: [] } }))).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    expect(frame.writes).toBe(0);
  });

  it("figma_get_motion_context names each root's frame and that frame's plan, null when it has none", async () => {
    const { record } = planMotion(plan());
    await store({ nodeId: card.id, plan: record });
    const run = (params: Record<string, unknown>) => MOTION_OPS.get_motion_context!.run(ctx(params)) as Promise<Record<string, unknown>>;
    const planned = await run({ nodeId: card.id, recursive: false, maxNodes: 1 });
    expect(planned.scope).toMatchObject({ ids: [card.id], topLevelFrameIds: [frame.id] });
    expect(planned.motionPlans).toEqual([{ frameId: frame.id, name: "Hero", plan: record }]);
    const bare = await run({ nodeId: other.id, recursive: false });
    expect(bare.motionPlans).toEqual([{ frameId: other.id, name: "Other", plan: null }]);
    other.setSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, "{not json");
    expect((await run({ nodeId: other.id, recursive: false })).motionPlans).toEqual([{ frameId: other.id, name: "Other", plan: null, invalid: "the stored plan is not JSON" }]);
    // A page has no frame around it.
    expect(((await run({ nodeId: page.id })).scope as { topLevelFrameIds: unknown }).topLevelFrameIds).toEqual([null]);
  });

  it("figma_check_motion's snapshot carries the plan of the very frame it read, null when it has none", async () => {
    const { record } = planMotion(plan());
    await store({ nodeId: card.id, plan: record });
    const read = (nodeId: string) => MOTION_SNAPSHOT_OPS.check_motion!.run(ctx({ nodeId })) as Promise<MotionSnapshot>;
    expect(await read(card.id)).toMatchObject({ root: { id: frame.id }, plan: record });
    const bare = await read(other.id);
    expect(bare.plan).toBeNull();
    expect(bare.planInvalid).toBeUndefined();
    other.setSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, "{not json");
    expect(await read(other.id)).toMatchObject({ plan: null, planInvalid: "the stored plan is not JSON" });
  });
});

// ── the gates, through an MCP client ────────────────────────────────────────

/** A Figma file as the fake bridge answers it: one frame "1:1" with a layer "1:2", plans in shared plugin data. */
class World {
  sent: Array<{ op: string; params: Record<string, unknown> }> = [];
  plans = new Map<string, unknown>();
  frames = new Map<string, string>([["1:1", "1:1"], ["1:2", "1:1"], ["3:1", "3:1"], ["3:2", "3:1"]]);
  snapshot: MotionSnapshot = { root: { id: "1:1", name: "Hero", width: 1080, height: 1920, durationS: 6 }, nodes: [{ id: "1:1", name: "Hero", type: "FRAME", parentId: null, width: 1080, height: 1920 }], truncated: false, maxNodes: 2000 };
  /** What a plugin before plans answers: no topLevelFrameIds. */
  oldPlugin = false;
  /** The plugin refuses a keyframe write before any change, as it does a top-level frame. */
  refuseKeys = false;
  /** The connected files, as figma_status lists them, with the last change each plugin reported. */
  sessions: Array<{ sessionId: string; active: boolean; file: { name: string }; lastNodesChanged?: { count: number; at: number } | null }> = [];
  /** While set, a render does not finish until it resolves; meanwhile the bridge answers every other call BUSY, as it does. */
  hold: Promise<void> | null = null;
  rendering = false;

  ops(): string[] {
    return this.sent.map((s) => s.op);
  }

  bridge(): Bridge {
    return {
      request: async (op: string, params: Record<string, unknown>) => {
        // Refused by the bridge before it reaches the plugin: never in `sent`.
        if (this.rendering) throw new BridgeError(ErrorCode.BUSY, "A video render holds the plugin; nothing was sent.");
        this.sent.push({ op, params });
        const frameId = this.frames.get(String(params.nodeId)) ?? null;
        switch (op) {
          case "get_motion_context":
            return {
              scope: { from: "node", ids: [params.nodeId], recursive: false, ...(this.oldPlugin ? {} : { topLevelFrameIds: [frameId] }) },
              count: 0,
              nodes: [],
              ...(this.oldPlugin || !frameId ? {} : { motionPlans: [{ frameId, name: "Hero", plan: this.plans.get(frameId) ?? null }] }),
            };
          case "set_motion_plan":
            this.plans.set(frameId!, params.plan);
            return { frameId, frameName: "Hero", replaced: false };
          case "set_keyframes":
            if (this.refuseKeys) throw new BridgeError(ErrorCode.INVALID_PARAM, '"Hero" is a top-level frame.', { partial: { created: [] } });
            return { nodeId: params.nodeId, tracks: [], timeline: { id: frameId, duration: 6, topLevelFrameId: frameId } };
          case "remove_keyframes":
            return { nodeId: params.nodeId, removed: [], remaining: [] };
          case "batch":
            return { steps: [], completed: (params.steps as unknown[]).length };
          case "undo_step":
          case "set_text":
          case "clone_node":
            return {};
          case "check_motion":
            // As the plugin reads it: the frame and, in the same pass, its plan.
            return { ...this.snapshot, plan: this.plans.get(this.snapshot.root.id) ?? null };
          case "export_video":
            if (this.hold) {
              this.rendering = true;
              try {
                await this.hold;
              } finally {
                this.rendering = false;
              }
            }
            return { nodeId: params.nodeId, exportedNodeId: frameId, name: "Hero", format: params.format, mime: "image/gif", bytes: 4, durationS: 6, base64: "R0lGOA==" };
          default:
            throw new Error(`the fake bridge has no ${op}`);
        }
      },
      statusAsync: async () => ({ sessions: this.sessions }),
      status: () => ({ sessions: this.sessions }),
    } as unknown as Bridge;
  }
}

async function serve(mode: ProcessMode, world: World) {
  const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-process-")), BRIDGE_PORT: "0", BRIDGE_PROCESS: mode });
  const proc = new MotionProcess(config.processMode);
  const server = new McpServer({ name: "process", version: "0" }, { capabilities: { prompts: {}, resources: {} } });
  registerTools(server, world.bridge(), config, Date.now(), quietLogger, proc);
  registerSkillResources(server, (skill, uri) => proc.noteSkill(skill.short, uri));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "process-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  /** The JSON a result carries, from its first text block. */
  const data = (r: ToolResult) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
  return { client, proc, call, data, close: () => client.close() };
}

const KEYS = { nodeId: "1:2", tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.5, value: "1" }] }] };

describe("strict: a keyframe write waits for the motion skill and the frame's plan", () => {
  let world: World;
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    world = new World();
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  it("refuses before any change, naming both missing steps as the exact calls, safe to retry", async () => {
    const r = await s.call("figma_set_keyframes", { ...KEYS, idempotencyKey: "keys-1" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      safeToRetry: true,
      idempotencyKey: "keys-1",
      partial: { created: [], missing: ["the motion skill has not been read in this session", 'the top-level frame "Hero" (1:1) has no motion plan'] },
    });
    expect(r.structuredContent!.message).toMatch(/^figma_set_keyframes was refused before any change/);
    expect(r.structuredContent!.hint).toMatch(/^First figma_get_guide \{ topic: "motion" \}, then figma_set_motion_plan \{ nodeId: "1:1", brief: \{ audience, message, format, durationS, fps \}, beats: \[/);
    // One read to learn the frame and its plan; the write never left the server.
    expect(world.ops()).toEqual(["get_motion_context"]);
    expect(world.sent[0]!.params).toEqual({ nodeId: "1:2", recursive: false, maxNodes: 1 });
  });

  it("after the skill, only the plan is missing; after the plan, the write runs and counts against the frame", async () => {
    await s.call("figma_get_guide", { topic: "motion" });
    expect(s.proc.skillRead).toBe('figma_get_guide { topic: "motion" }');
    const r = await s.call("figma_remove_keyframes", { nodeId: "1:2" });
    expect(r.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: ['the top-level frame "Hero" (1:1) has no motion plan'] } });
    expect(r.structuredContent!.hint).not.toMatch(/figma_get_guide/);

    const stored = await s.call("figma_set_motion_plan", plan({ nodeId: "1:2" }));
    expect(stored.isError).toBeFalsy();
    expect(s.data(stored)).toMatchObject({ frameId: "1:1", durationFrames: 180, check: { nodeId: "1:1", fps: 30, bpm: 120 } });
    expect(s.data(stored).processWarnings).toBeUndefined();
    expect(world.plans.get("1:1")).toMatchObject({ v: 1, brief: { fps: 30 } });

    const ok = await s.call("figma_set_keyframes", KEYS);
    expect(ok.isError).toBeFalsy();
    expect(s.data(ok).processWarnings).toBeUndefined();
    expect(world.ops().filter((o) => o !== "get_motion_context")).toEqual(["set_motion_plan", "set_keyframes"]);
    expect(s.proc.finalBlockers("1:1", 30, "", now())).toEqual(["figma_check_motion has not run on this frame in this session"]);
  });

  it("a plan that fails its checks is refused on the server, listing every problem, and nothing is sent", async () => {
    await s.call("figma_get_guide", { topic: "storyboard", section: "boards" });
    const bad = plan();
    (bad.beats as Array<Record<string, unknown>>)[1]!.from = 1.6;
    const r = await s.call("figma_set_motion_plan", { ...bad, idempotencyKey: "plan-1" });
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true, idempotencyKey: "plan-1", partial: { created: [], problems: [expect.stringMatching(/does not start where/)] } });
    expect(world.ops()).toEqual([]);
    // A plan stored without the skill read says the keyframes will still wait for it.
    const s2 = await serve("strict", new World());
    try {
      const stored = await s2.call("figma_set_motion_plan", plan());
      expect(s2.data(stored).processWarnings).toEqual([expect.stringMatching(/^Keyframe writes also need the motion skill read in this session: figma_get_guide \{ topic: "motion" \}\.$/)]);
    } finally {
      await s2.close();
    }
  });

  it("a batch with a keyframe step is refused whole until the gate passes; a plan is never a batch step", async () => {
    const steps = JSON.stringify([{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 1 } }, { op: "set_keyframes", params: KEYS }]);
    const refused = await s.call("figma_batch", { steps });
    expect(refused.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", safeToRetry: true });
    expect(refused.structuredContent!.message).toMatch(/^steps\[1\]: figma_batch's figma_set_keyframes step was refused before any change/);
    expect(world.ops()).not.toContain("batch");

    await s.call("figma_get_guide", { topic: "mechanics" });
    await s.call("figma_set_motion_plan", plan());
    const ran = await s.call("figma_batch", { steps });
    expect(ran.isError).toBeFalsy();
    expect(world.ops()).toContain("batch");

    const withPlan = await s.call("figma_batch", { steps: JSON.stringify([{ op: "set_motion_plan", params: plan() }]) });
    expect(withPlan.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(withPlan.structuredContent!.message).toMatch(/"set_motion_plan" is checked by the server and stored on its own call/);
  });

  it("a plugin that predates plans is said to be old, not a missing plan", async () => {
    world.oldPlugin = true;
    await s.call("figma_get_guide", { topic: "motion" });
    const r = await s.call("figma_set_keyframes", KEYS);
    expect(r.structuredContent).toMatchObject({ code: "UNSUPPORTED", safeToRetry: true });
    expect(r.structuredContent!.message).toMatch(/^Before figma_set_keyframes, Figxel reads the frame's motion plan \(BRIDGE_PROCESS=strict\), and that read failed: The connected plugin predates motion plans/);
    expect(r.structuredContent!.hint).toMatch(/run it again/);
  });
});

describe("what counts as reading the motion skill", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => (s = await serve("strict", new World())));
  afterEach(async () => s.close());

  it("the catalog and other skills do not; the motion and storyboard skills do, by topic or section", async () => {
    for (const args of [{}, { topic: "skills" }, { topic: "critique" }, { topic: "motion-checks" }, { topic: "design", section: "brief" }]) await s.call("figma_get_guide", args);
    expect(s.proc.skillRead).toBeNull();
    await s.call("figma_get_guide", { topic: "beat-sheet" });
    expect(s.proc.skillRead).toBe('figma_get_guide { topic: "beat-sheet" }');
    // The first read is the one kept.
    await s.call("figma_get_guide", { topic: "motion" });
    expect(s.proc.skillRead).toBe('figma_get_guide { topic: "beat-sheet" }');
  });

  it("the prompts that carry them do: animate_in_figma and storyboard_motion, not build_in_figma", async () => {
    await s.client.getPrompt({ name: "build_in_figma", arguments: { brief: "a page" } });
    await s.client.getPrompt({ name: "critique_design", arguments: { lens: "motion craft" } });
    expect(s.proc.skillRead).toBeNull();
    await s.client.getPrompt({ name: "animate_in_figma", arguments: {} });
    expect(s.proc.skillRead).toBe("the prompt animate_in_figma");
    const other = await serve("strict", new World());
    try {
      await other.client.getPrompt({ name: "storyboard_motion", arguments: { brief: "a 6 s end card" } });
      expect(other.proc.skillRead).toBe("the prompt storyboard_motion");
    } finally {
      await other.close();
    }
  });

  it("their skill:// resources do, index or section; another skill's do not", async () => {
    await s.client.readResource({ uri: "skill://figxel-design/SKILL.md" });
    await s.client.readResource({ uri: "skill://figxel-critique/references/motion-checks.md" });
    expect(s.proc.skillRead).toBeNull();
    await s.client.readResource({ uri: "skill://figxel-storyboard/references/boards.md" });
    expect(s.proc.skillRead).toBe("skill://figxel-storyboard/references/boards.md");
    const other = await serve("strict", new World());
    try {
      await other.client.readResource({ uri: "skill://figxel-motion/SKILL.md" });
      expect(other.proc.skillRead).toBe("skill://figxel-motion/SKILL.md");
    } finally {
      await other.close();
    }
  });

  it("figma_status reports the mode and the read, from the process the client talks to", async () => {
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-process-app-")), BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "0" });
    const app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "process-app", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    try {
      const status = async () => ((await client.callTool({ name: "figma_status", arguments: {} })) as ToolResult).structuredContent!.process;
      expect(await status()).toEqual({ mode: "strict", motionSkillRead: false });
      await client.readResource({ uri: "skill://figxel-motion/references/passes.md" });
      expect(await status()).toEqual({ mode: "strict", motionSkillRead: true });
    } finally {
      await client.close();
      await app.close();
    }
  });
});

describe("guided and off never refuse", () => {
  it("guided runs the write and lists the skipped steps as processWarnings", async () => {
    const world = new World();
    const s = await serve("guided", world);
    try {
      const r = await s.call("figma_set_keyframes", KEYS);
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toEqual([
        'the motion skill has not been read in this session: figma_get_guide { topic: "motion" }.',
        expect.stringMatching(/^the top-level frame "Hero" \(1:1\) has no motion plan: figma_set_motion_plan \{ nodeId: "1:1"/),
      ]);
      expect(world.ops()).toEqual(["get_motion_context", "set_keyframes"]);
      // Tracked all the same: the write makes an earlier check stale.
      s.proc.noteCheck("1:1", passed());
      await s.call("figma_set_keyframes", KEYS);
      expect(s.proc.finalBlockers("1:1", 30, "", now())).toEqual([WROTE]);
    } finally {
      await s.close();
    }
  });

  it("off sends the write alone: no plan read, no warnings, no notes", async () => {
    const world = new World();
    const s = await serve("off", world);
    try {
      const r = await s.call("figma_set_keyframes", KEYS);
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toBeUndefined();
      expect(world.ops()).toEqual(["set_keyframes"]);
      const video = await s.call("figma_export_video", { nodeId: "1:2", format: "GIF", final: true, wait: 5 });
      expect(s.data(video)).toMatchObject({ status: "done", final: true });
      expect(s.data(video).processNote).toBeUndefined();
      expect(world.ops()).toEqual(["set_keyframes", "export_video"]);
    } finally {
      await s.close();
    }
  });
});

describe("the final render waits for a passing check; a preview never does", () => {
  /** r0 of the 2026-10-09 ad, as frame 1:1: a snapshot with warnings, so ok is false. */
  const failing = (): MotionSnapshot => JSON.parse(JSON.stringify(loadSnapshot("r0")).replaceAll("fixture:frame", "1:1")) as MotionSnapshot;
  let world: World;
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    world = new World();
    s = await serve("strict", world);
    await s.call("figma_get_guide", { topic: "motion" });
    await s.call("figma_set_motion_plan", plan());
    world.sent = [];
  });
  afterEach(async () => s.close());

  it("a preview renders at once, says it is one, and names the delivery call", async () => {
    const r = await s.call("figma_export_video", { nodeId: "1:2", format: "GIF", wait: 5 });
    expect(s.data(r)).toMatchObject({ status: "done", final: false });
    expect(s.data(r).processNote).toMatch(/^Preview, for judging the motion\. The delivery render is figma_export_video \{ nodeId: "1:1", fps: 15, final: true \}/);
    expect(world.ops()).toEqual(["export_video"]);
  });

  it("refuses a final render with no check, after a failing one, at another fps, or after a partial one", async () => {
    const final = (extra: Record<string, unknown> = {}) => s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5, ...extra });
    const none = await final();
    expect(none.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", safeToRetry: true, partial: { created: [], missing: ["figma_check_motion has not run on this frame in this session"] } });
    expect(none.structuredContent!.hint).toMatch(/^Run figma_check_motion \{ nodeId: "1:1", fps: 30 \}, fix what it finds until ok: true, then figma_export_video \{ nodeId: "1:1", fps: 30, final: true \}\. A preview \(no `final`\) renders now\.$/);

    world.snapshot = failing();
    const checked = await s.call("figma_check_motion", { nodeId: "1:2" });
    expect(s.data(checked).ok).toBe(false);
    expect(s.data(checked).processNote).toBeUndefined();
    expect((await final()).structuredContent!.message).toMatch(/did not pass \(ok: false\)/);

    world.snapshot = new World().snapshot;
    const passing = await s.call("figma_check_motion", { nodeId: "1:2", fps: 24 });
    expect(s.data(passing)).toMatchObject({ ok: true, processNote: expect.stringMatching(/figma_export_video \{ nodeId: "1:1", fps: 24, final: true \}/) });
    expect((await final()).structuredContent!.message).toMatch(/judged 24 fps and this render is 30 fps/);

    await s.call("figma_check_motion", { nodeId: "1:2", rules: ["read_time"] });
    expect((await final()).structuredContent!.message).toMatch(/judged only some rules, a window or some layers/);
    expect(world.ops()).not.toContain("export_video");
  });

  it("renders the delivery after a passing whole check at its fps, and refuses it again after a keyframe write", async () => {
    const passing = await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    expect(s.data(passing)).toMatchObject({
      ok: true,
      // The plan's tempo, which the call left out.
      fromPlan: ["bpm"],
      processNote: `Passing at 30 fps against the frame's plan: until the file changes, the delivery may render: figma_export_video { nodeId: "1:1", fps: 30, final: true }.`,
    });
    // A preview now says the delivery may render.
    const preview = await s.call("figma_export_video", { nodeId: "1:1", format: "GIF", fps: 30, wait: 5 });
    expect(s.data(preview).processNote).toMatch(/^Preview\. figma_check_motion passed on this frame at 30 fps with no change to the file since/);

    const done = await s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5, jobId: "hero-final" });
    expect(s.data(done)).toMatchObject({ status: "done", final: true, jobId: "hero-final" });
    expect(s.data(done).processWarnings).toBeUndefined();
    expect(s.data(done).accepted).toBeUndefined();
    // Collected again by its id, it is still the delivery.
    expect(s.data(await s.call("figma_export_video", { jobId: "hero-final" }))).toMatchObject({ final: true });

    expect((await s.call("figma_set_keyframes", KEYS)).isError).toBeFalsy();
    const after = await s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5 });
    expect(after.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: [WROTE] } });
    // Another frame's check never stands in for this one's.
    s.proc.noteCheck("3:1", passed());
    expect(s.proc.finalBlockers("1:1", 30, "", now())).toEqual([WROTE]);
  });

  it("a final render asked for again while it runs attaches to it, by jobId or by its settings: the gate's plan read would meet BUSY", async () => {
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    world.sent = [];
    let release!: () => void;
    world.hold = new Promise<void>((r) => (release = r));
    const ask = { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 0 };
    const started = await s.call("figma_export_video", { ...ask, jobId: "hero-final" });
    expect(s.data(started)).toMatchObject({ status: "rendering", jobId: "hero-final" });
    // The client cut the call off; the agent asks again, with the jobId and without it.
    const again = await s.call("figma_export_video", { ...ask, jobId: "hero-final" });
    expect(again.isError).toBeFalsy();
    expect(s.data(again)).toMatchObject({ status: "rendering", jobId: "hero-final" });
    const same = await s.call("figma_export_video", ask);
    expect(same.isError).toBeFalsy();
    expect(s.data(same)).toMatchObject({ status: "rendering", jobId: "hero-final" });
    // One plan read, before the render began; the retries asked Figma nothing.
    expect(world.ops()).toEqual(["get_motion_context", "export_video"]);
    release();
    const done = await s.call("figma_export_video", { jobId: "hero-final", wait: 5 });
    expect(s.data(done)).toMatchObject({ status: "done", final: true, jobId: "hero-final" });
  });

  it("a final call matching a preview still rendering answers BUSY under strict, sends nothing, and becomes the delivery once it ends", async () => {
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    world.sent = [];
    let release!: () => void;
    world.hold = new Promise<void>((r) => (release = r));
    const ask = { nodeId: "1:2", format: "MP4", fps: 30, wait: 0 };
    const preview = await s.call("figma_export_video", { ...ask, jobId: "hero-preview" });
    expect(s.data(preview)).toMatchObject({ status: "rendering", jobId: "hero-preview" });
    const final = await s.call("figma_export_video", { ...ask, final: true });
    expect(final.structuredContent).toMatchObject({ code: "BUSY", safeToRetry: true });
    expect(final.structuredContent!.message).toMatch(/^A preview with these settings is still rendering \("hero-preview"\)/);
    expect(final.structuredContent!.hint).toMatch(/^Collect the preview with figma_export_video \{ jobId: "hero-preview" \}, then ask again with final: true/);
    expect(world.ops()).toEqual(["export_video"]);
    release();
    expect(s.data(await s.call("figma_export_video", { jobId: "hero-preview", wait: 5 }))).toMatchObject({ status: "done", final: false });
    // Now the plugin is free: the gate reads the plan, and the finished preview becomes the delivery.
    const delivery = await s.call("figma_export_video", { ...ask, final: true, wait: 5 });
    expect(s.data(delivery)).toMatchObject({ status: "done", final: true, jobId: "hero-preview", reused: true });
    expect(world.ops()).toEqual(["export_video", "get_motion_context"]);
  });

  it("every write after the check makes it stale, whatever frame it names, even one Figma refused: doubt costs one more check", async () => {
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    expect(s.proc.finalBlockers("1:1", 30, "", now())).toEqual([]);
    world.refuseKeys = true;
    const refused = await s.call("figma_set_keyframes", KEYS);
    expect(refused.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(s.proc.finalBlockers("1:1", 30, "", now())).toEqual([WROTE]);
    // An undo of a keyframe write, a clone of an animated layer, a text edit the read time judges: none is a keyframe write.
    for (const [tool, args] of [
      ["figma_undo_step", { confirm: true }],
      ["figma_clone_node", { nodeId: "1:2" }],
      ["figma_set_text", { nodeId: "1:2", content: "Kept for every mile you run, and then some" }],
    ] as const) {
      await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
      expect((await s.call(tool, args)).isError, tool).toBeFalsy();
      const r = await s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5 });
      expect(r.structuredContent, tool).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: [WROTE] } });
    }
    expect(world.ops()).not.toContain("export_video");
  });

  it("a change Figma reports after the check began (by hand, another client, figma_eval) makes the final wait; one before it does not", async () => {
    world.sessions = [{ sessionId: "s-1", active: true, file: { name: "Ads" }, lastNodesChanged: { count: 4, at: Date.now() - 60_000 } }];
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    // The edit of a minute ago is in what the check read.
    expect(s.data(await s.call("figma_export_video", { nodeId: "1:1", format: "MP4", fps: 30, final: true, wait: 5 }))).toMatchObject({ status: "done", final: true });
    world.sessions[0]!.lastNodesChanged = { count: 1, at: Date.now() + 1 };
    const r = await s.call("figma_export_video", { nodeId: "1:1", format: "MP4", fps: 30, final: true, wait: 5 });
    expect(r.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      partial: { missing: ["the file changed after the last figma_check_motion (Figma reported a change: an edit by hand, by another client or through figma_eval, or an undo)"] },
    });
  });

  it("fileNow reads the frame's file only, and any doubt as a change just now", async () => {
    const bridge = (sessions: unknown) => ({ statusAsync: async () => ({ sessions }) }) as unknown as Bridge;
    const rows = [
      { sessionId: "s-1", lastNodesChanged: { count: 1, at: 100 } },
      { sessionId: "s-2", lastNodesChanged: null },
    ];
    expect((await fileNow(bridge(rows), "s-2")).changedAt).toBe(Number.NEGATIVE_INFINITY);
    expect((await fileNow(bridge(rows), "s-1")).changedAt).toBe(100);
    expect((await fileNow(bridge(rows), "")).changedAt).toBe(100);
    // The file is gone, or the bridge cannot say.
    expect((await fileNow(bridge(rows), "s-9")).changedAt).toBe(Number.POSITIVE_INFINITY);
    const failing = { statusAsync: async () => Promise.reject(new Error("hub gone")) } as unknown as Bridge;
    expect((await fileNow(failing, "s-1")).changedAt).toBe(Number.POSITIVE_INFINITY);
    expect(await fileNow(bridge(rows), "s-1", null)).toMatchObject({ epoch: writeEpoch(), plan: null });
  });

  it("a check looser than the plan passes as asked but does not clear the delivery, and the refusal names how", async () => {
    const final = () => s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5 });
    const loose = await s.call("figma_check_motion", { nodeId: "1:1", fps: 30, thresholds: { deadSpanS: 9 }, holds: [{ from: 0, to: 6 }] });
    expect(s.data(loose)).toMatchObject({ ok: true });
    expect(s.data(loose).processNote).toMatch(/^Passing, but looser than the frame's plan, so it does not clear the delivery: holds\[0\] 0–6 s is not inside a hold of the plan; thresholds\.deadSpanS 9, not the default 0\.5\./);
    const r = await final();
    expect(r.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED" });
    expect((r.structuredContent!.partial as { missing: string[] }).missing).toEqual([
      "the last figma_check_motion was looser than the frame's plan (holds[0] 0–6 s is not inside a hold of the plan; thresholds.deadSpanS 9, not the default 0.5): leave those out and the check applies the plan's own",
    ]);
    // Leaving out the plan's tempo is no loophole: the check applies it.
    expect(s.data(await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 })).fromPlan).toEqual(["bpm"]);
    expect(s.data(await final())).toMatchObject({ status: "done", final: true });
  });

  it("a plan changed after the check, even by another client, is not the plan it judged", async () => {
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    // Written straight into the file, past this process's write count.
    world.plans.set("1:1", { ...(world.plans.get("1:1") as MotionPlanRecord), holds: [{ from: 0, to: 6 }] });
    const r = await s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5 });
    expect(r.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: ["the frame's motion plan is not the one the last figma_check_motion judged against"] } });
  });

  it("a brand layer the plan names but the frame no longer holds is said to come from the plan", async () => {
    await s.call("figma_set_motion_plan", plan({ brandId: "1:2" }));
    const r = await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true, hint: expect.stringMatching(/figma_set_motion_plan/) });
    expect(r.structuredContent!.message).toBe('The frame\'s motion plan names `brandId` 1:2, which is not among the layers read in "Hero".');
  });

  it("a finding the plan accepts passes the check with its reason, and the delivery's result names it for the report", async () => {
    await s.call("figma_set_motion_plan", plan({ holds: [{ from: 2, to: 6 }], accept: [{ rule: "cold_open", reason: "opens on a held product shot", from: 0, to: 0.1 }] }));
    // Still for 10 frames, a small move, then the planned hold: cold_open is its only open warning.
    world.snapshot = {
      ...world.snapshot,
      nodes: [
        ...world.snapshot.nodes,
        { id: "1:2", name: "Shoe", type: "RECTANGLE", parentId: "1:1", width: 200, height: 200, tracks: [{ field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0" }, { t: 1 / 3, value: "0", easing: "LINEAR" }, { t: 2, value: "300", easing: "LINEAR" }] }] },
      ],
    };
    const checked = await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 });
    expect(s.data(checked)).toMatchObject({ ok: true, counts: { warning: 0 }, fromPlan: ["bpm", "holds", "accept"], accepted: [{ rule: "cold_open", frames: [0, 3], reason: "opens on a held product shot" }] });
    const done = await s.call("figma_export_video", { nodeId: "1:2", format: "MP4", fps: 30, final: true, wait: 5 });
    expect(s.data(done)).toMatchObject({ status: "done", final: true, accepted: [{ rule: "cold_open", name: "Hero", frame: 0, frames: [0, 3], reason: "opens on a held product shot" }] });
  });

  it("node ids are per file: a check that passed in one connected file never clears the same frame id in another", async () => {
    world.sessions = [
      { sessionId: "s-1", active: true, file: { name: "Ads" } },
      { sessionId: "s-2", active: false, file: { name: "Reels" } },
    ];
    await s.call("figma_check_motion", { nodeId: "1:1", fps: 30, session: "Reels" });
    // The active file's 1:1 is another frame, never checked.
    const active = await s.call("figma_export_video", { nodeId: "1:1", format: "MP4", fps: 30, final: true, wait: 5 });
    expect(active.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: ["figma_check_motion has not run on this frame in this session"] } });
    const reels = await s.call("figma_export_video", { nodeId: "1:1", format: "MP4", fps: 30, final: true, wait: 5, session: "s-2" });
    expect(s.data(reels)).toMatchObject({ status: "done", final: true });
    expect(s.proc.finalBlockers("1:1", 30, "s-2", now())).toEqual([]);
    expect(s.proc.finalBlockers("1:1", 30, "s-1", now())).toEqual(["figma_check_motion has not run on this frame in this session"]);
  });

  it("`final` describes a render: refused with only a jobId, or with cancel", async () => {
    const collect = await s.call("figma_export_video", { jobId: "x", final: true });
    expect(collect.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: "`final` describe a new render and need `nodeId`." });
    const cancel = await s.call("figma_export_video", { jobId: "x", cancel: true, final: true });
    expect(cancel.structuredContent!.message).toMatch(/`cancel` takes only `jobId` \(got `final` too\)/);
  });

  it("guided renders the delivery anyway, with the missing check as processWarnings", async () => {
    const g = await serve("guided", new World());
    try {
      const r = await g.call("figma_export_video", { nodeId: "1:2", format: "GIF", final: true, wait: 5 });
      expect(g.data(r)).toMatchObject({
        status: "done",
        final: true,
        processWarnings: ['figma_check_motion has not run on this frame in this session: figma_check_motion { nodeId: "1:1", fps: 15 }.'],
      });
    } finally {
      await g.close();
    }
  });
});
