// Second ids [C-199]: for stretches of a second to twenty minutes Figma lists
// the layers of an animated frame under second ids, reads through either id
// agree, and the page may list the frame twice. Seen again live on 2026-10-21
// (prefix 37, frame 14:4818): the plan's brandId 14:4853, a created id, was
// "not among the layers read" because the listing said 37:441, and
// re-storing the plan with 37:441 was refused as "not inside" the frame,
// whose parents led to its second handle 37:173. figma_search_nodes found
// the frame and its brand layer twice.
//
// The fakes model a stretch the way the live file showed it: every listing
// (children, the page) gives the second handles, the created handles keep
// resolving by id, and both handles read one set of plugin data.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_PLAN_OPS } from "../src/plugin/ops/motion-plan.js";
import { MOTION_SNAPSHOT_OPS } from "../src/plugin/ops/motion-snapshot.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import { sameLayer, type NodeLike } from "../src/plugin/read.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { planMotion } from "../src/server/motion-plan.js";
import { MotionProcess } from "../src/server/motion-process.js";
import { idsToResolve, listedId, planAsListed } from "../src/server/tools/check-motion.js";
import { registerTools } from "../src/server/tools/index.js";
import type { MotionSnapshot } from "../src/shared/motion-curves.js";
import { MOTION_PLAN_KEY, MOTION_PLAN_NAMESPACE, type MotionPlanRecord } from "../src/shared/motion-plan.js";
import { quietLogger } from "./helpers.js";

let seq = 0;
const nodes = new Map<string, N>();

class N {
  id: string;
  name: string;
  parent: N | null = null;
  children: N[] = [];
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  opacity = 1;
  visible = true;
  rotation = 0;
  effects: unknown[] = [];
  strokes: unknown[] = [];
  animationStyles: unknown[] = [];
  manualKeyframeTracks: Record<string, unknown> = {};
  timeline = { id: "", duration: 6 };
  data = new Map<string, string>();
  [key: string]: unknown;
  constructor(
    readonly type: string,
    name: string = type,
    id?: string,
  ) {
    this.id = id ?? `14:${++seq}`;
    this.name = name;
    nodes.set(this.id, this);
  }
  add(child: N): N {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  get timelines() {
    let n: N = this;
    while (n.parent && n.parent.type !== "PAGE") n = n.parent;
    return n.parent ? [n.timeline] : [];
  }
  getSharedPluginData(ns: string, key: string) {
    return this.data.get(`${ns}/${key}`) ?? "";
  }
  setSharedPluginData(ns: string, key: string, value: string) {
    this.data.set(`${ns}/${key}`, value);
  }
}

let page: N;
const ctx = (params: Record<string, unknown>) => ({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false }) as OpContext;
const failure = async (p: Promise<unknown>) => p.then(() => ({ code: "none" }) as Record<string, unknown>, (e: unknown) => e as Record<string, unknown>);

/** The live piece's shape: a frame with a header holding the brand lockup, a CTA text, and an animated card. */
function piece(name = "Linkspan v2 · LinkedIn video") {
  const frame = page.add(new N("FRAME", name));
  Object.assign(frame, { x: 7400, width: 1080, height: 1350, timeline: { id: "TL", duration: 6 } });
  const header = frame.add(new N("FRAME", "Header"));
  Object.assign(header, { width: 1080, height: 120 });
  const lockup = header.add(new N("FRAME", "Figxel lockup"));
  Object.assign(lockup, { x: 64, y: 34, width: 108, height: 52 });
  lockup.add(new N("VECTOR", "Vector"));
  const cta = frame.add(new N("TEXT", "RM try"));
  Object.assign(cta, { x: 96, y: 632, width: 719, height: 44, characters: "Try it: npx -y figxel-mcp@latest setup", fontSize: 32 });
  const card = frame.add(new N("RECTANGLE", "Card"));
  card.manualKeyframeTracks = { OPACITY: { id: "o", baseValue: { type: "FLOAT", value: 1 }, keyframes: [{ id: "k", timelinePosition: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "LINEAR" } }] } };
  return { frame, header, lockup, cta, card };
}

/**
 * A second-id stretch over `frame`, as the live file showed it: a second
 * handle for every layer, every listing giving the second handles, the page
 * listing the frame a second time, both handles of a layer reading one set of
 * plugin data. `parents`: whether a created handle's parent is the created
 * one or the second one — the live run did not tell, so both are tested.
 */
function stretch(frame: N, parents: "created" | "second"): Map<N, N> {
  const twin = new Map<N, N>();
  let k = 400;
  const make = (c: N): N => {
    const s = new N(c.type, c.name, `37:${++k}`);
    for (const key of ["x", "y", "width", "height", "characters", "fontSize", "manualKeyframeTracks", "timeline"]) if (key in c) s[key] = c[key];
    s.data = c.data;
    twin.set(c, s);
    for (const child of c.children) s.add(make(child));
    return s;
  };
  const root = make(frame);
  root.parent = frame.parent;
  const relist = (c: N) => {
    const kids = c.children;
    for (const child of kids) {
      relist(child);
      if (parents === "second") child.parent = twin.get(c)!;
    }
    c.children = kids.map((child) => twin.get(child)!);
  };
  relist(frame);
  page.children.push(root);
  return twin;
}

beforeEach(() => {
  seq = 0;
  nodes.clear();
  page = new N("PAGE", "Page 1", "0:1");
  (page as unknown as { selection: N[] }).selection = [];
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: { name: "doc", children: [page] },
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const record = (extra: Record<string, unknown> = {}): MotionPlanRecord =>
  planMotion({
    brief: { audience: "designers", message: "Designed in Figma by an AI agent.", format: "1080x1350 LinkedIn feed", durationS: 6, fps: 30 },
    beats: [
      { name: "hook", from: 0, to: 3, onScreen: "[the late bar] 07:20 is running late", action: "the bar grows", transition: "the camera pulls back" },
      { name: "end card", from: 3, to: 6, onScreen: "[logo lockup] Try it", action: "the card settles", transition: "holds to the end" },
    ],
    ...extra,
  }).record;

describe("sameLayer: one layer through two handles", () => {
  for (const parents of ["created", "second"] as const) {
    it(`a frame and its leaves are each one layer through both handles (created handles' parents: ${parents})`, () => {
      const { frame, lockup, cta } = piece();
      const twin = stretch(frame, parents);
      expect(sameLayer(frame as NodeLike, twin.get(frame)! as NodeLike)).toBe(true);
      expect(sameLayer(lockup as NodeLike, twin.get(lockup)! as NodeLike)).toBe(true);
      expect(sameLayer(cta as NodeLike, twin.get(cta)! as NodeLike)).toBe(true);
    });
  }

  it("a stacked copy of a frame is another layer, though its name and box are the same", () => {
    const a = piece().frame;
    const b = piece().frame;
    expect(sameLayer(a as NodeLike, b as NodeLike)).toBe(false);
  });

  it("a leaf of another frame is another layer, and so is one that moved", () => {
    const a = piece();
    const b = piece("Other");
    expect(sameLayer(a.cta as NodeLike, b.cta as NodeLike)).toBe(false);
    const twin = stretch(a.frame, "second");
    twin.get(a.cta)!.x = 97;
    expect(sameLayer(a.cta as NodeLike, twin.get(a.cta)! as NodeLike)).toBe(false);
  });

  it("two stacked leaves on the page, and two siblings a frame lists, are two layers though name and box agree", () => {
    const r1 = page.add(new N("RECTANGLE", "Rect"));
    const r2 = page.add(new N("RECTANGLE", "Rect"));
    expect(sameLayer(r1 as NodeLike, r2 as NodeLike)).toBe(false);
    const { frame } = piece();
    const d1 = frame.add(new N("ELLIPSE", "Dot"));
    const d2 = frame.add(new N("ELLIPSE", "Dot"));
    expect(sameLayer(d1 as NodeLike, d2 as NodeLike)).toBe(false);
    // During a stretch both listed dots still match the created handle the listing does not give.
    const twin = stretch(frame, "second");
    expect(sameLayer(twin.get(d1)! as NodeLike, twin.get(d2)! as NodeLike)).toBe(false);
    expect(sameLayer(d1 as NodeLike, twin.get(d1)! as NodeLike)).toBe(true);
    expect(sameLayer(d1 as NodeLike, twin.get(d2)! as NodeLike)).toBe(true);
  });
});

describe("figma_set_motion_plan during a stretch", () => {
  const store = (params: Record<string, unknown>) => MOTION_PLAN_OPS.set_motion_plan!.run(ctx(params)) as Promise<Record<string, unknown>>;

  for (const parents of ["created", "second"] as const) {
    it(`stores a plan naming the created ids, or the listed ones, of the frame's own layers (parents: ${parents})`, async () => {
      const { frame, lockup, cta } = piece();
      const twin = stretch(frame, parents);
      const created = record({ brandId: lockup.id, ctaId: cta.id });
      const first = await store({ nodeId: frame.id, plan: created });
      expect(first).toMatchObject({ frameId: frame.id });
      // The created ids hold; the one warning is that the page lists the frame twice.
      const twice = `The page lists "Linkspan v2 · LinkedIn video" as ${frame.id} and ${twin.get(frame)!.id} while Figma lists its layers under temporary ids`;
      expect(first.warnings).toEqual([expect.stringContaining(twice)]);
      const listed = record({ brandId: twin.get(lockup)!.id, ctaId: twin.get(cta)!.id });
      const second = await store({ nodeId: frame.id, plan: listed });
      expect(second).toMatchObject({ frameId: frame.id, replaced: true });
      // Stored, with a warning: the id a listing gives during a stretch stops resolving when it ends.
      expect(second.warnings).toEqual([
        expect.stringMatching(/^`brandId` 37:\d+ is the id Figma lists "Figxel lockup" under while its frame's layers have temporary ids/),
        expect.stringMatching(/^`ctaId` 37:\d+ is the id Figma lists "RM try" under/),
        expect.stringContaining(twice),
      ]);
      expect(JSON.parse(frame.getSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY))).toMatchObject({ brandId: twin.get(lockup)!.id });
    });
  }

  it("outside a stretch, a plan naming the listed ids is stored without a warning", async () => {
    const { frame, lockup, cta } = piece();
    const r = await store({ nodeId: frame.id, plan: record({ brandId: lockup.id, ctaId: cta.id }) });
    expect(r).toMatchObject({ frameId: frame.id, replaced: false });
    expect(r).not.toHaveProperty("warnings");
  });

  it("stored through the frame's second handle: the warning names both ids the page lists it under", async () => {
    const { frame, lockup } = piece();
    const twin = stretch(frame, "second");
    const second = twin.get(frame)!.id;
    const r = await store({ nodeId: second, plan: record({ brandId: lockup.id }) });
    expect(r).toMatchObject({ frameId: second });
    expect(r.warnings).toEqual([
      `The page lists "Linkspan v2 · LinkedIn video" as ${second} and ${frame.id} while Figma lists its layers under temporary ids: ` +
        "use the id its create call returned for it; the other stops resolving when that ends.",
    ]);
    // Both handles read one set of plugin data: the plan is on the frame either way.
    expect(JSON.parse(frame.getSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY))).toMatchObject({ brandId: lockup.id });
  });

  it("still refuses a layer of another frame", async () => {
    const { frame } = piece();
    const other = piece("Other");
    stretch(frame, "second");
    expect(await failure(store({ nodeId: frame.id, plan: record({ brandId: other.lockup.id }) }))).toMatchObject({
      code: "INVALID_PARAM",
      message: expect.stringMatching(/`brandId` "Figxel lockup" \(14:\d+\) is not inside "Linkspan v2 · LinkedIn video"/),
    });
  });
});

describe("figma_check_motion's snapshot during a stretch", () => {
  const read = (params: Record<string, unknown>) => MOTION_SNAPSHOT_OPS.check_motion!.run(ctx(params)) as Promise<MotionSnapshot>;

  it("maps the plan's created ids, and those the call asks for, to the layers it lists", async () => {
    const { frame, lockup, cta, card } = piece();
    frame.setSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, JSON.stringify(record({ brandId: lockup.id, ctaId: cta.id })));
    const twin = stretch(frame, "second");
    const s = await read({ nodeId: frame.id, resolveIds: [card.id] });
    expect(s.root.id).toBe(frame.id);
    expect(s.nodes.slice(1).every((n) => n.id.startsWith("37:"))).toBe(true);
    expect(s.aliases).toEqual({ [lockup.id]: twin.get(lockup)!.id, [cta.id]: twin.get(cta)!.id, [card.id]: twin.get(card)!.id });
  });

  it("names no alias when every id is listed as it is, and names as unmapped one that two listed layers match", async () => {
    const { frame, lockup, cta } = piece();
    frame.setSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, JSON.stringify(record({ brandId: lockup.id, ctaId: cta.id })));
    const plain = await read({ nodeId: frame.id });
    expect(plain.aliases).toEqual({});
    expect(plain).not.toHaveProperty("unmapped");
    // Two identical leaves in one parent: the created id could be either, so it is not guessed.
    const dot = frame.add(new N("ELLIPSE", "Dot"));
    frame.add(Object.assign(new N("ELLIPSE", "Dot"), { x: dot.x, y: dot.y }));
    stretch(frame, "second");
    const s = await read({ nodeId: frame.id, resolveIds: [dot.id] });
    expect(s.aliases?.[dot.id]).toBeUndefined();
    expect(Object.keys(s.aliases ?? {}).sort()).toEqual([cta.id, lockup.id].sort());
    expect(s.unmapped).toEqual([dot.id]);
  });

  it("a walk cut short between two identical leaves maps neither to the one it read", async () => {
    const { frame } = piece();
    const d1 = frame.add(new N("ELLIPSE", "Dot"));
    const d2 = frame.add(new N("ELLIPSE", "Dot"));
    stretch(frame, "second");
    // The walk reads frame, Header, Figxel lockup, Vector, RM try, Card, the first Dot: 7.
    const s = await read({ nodeId: frame.id, resolveIds: [d1.id, d2.id], maxNodes: 7 });
    expect(s.truncated).toBe(true);
    expect(s.aliases).toEqual({});
    expect(s.unmapped?.sort()).toEqual([d1.id, d2.id].sort());
  });

  it("says which named ids are in no frame it read (outside) and which resolve to nothing (gone)", async () => {
    const { frame } = piece();
    const other = piece("Other");
    frame.setSharedPluginData(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, JSON.stringify(record({ brandId: other.lockup.id, ctaId: "99:1" })));
    const s = await read({ nodeId: frame.id });
    expect(s.truncated).toBe(false);
    expect(s.aliases).toEqual({});
    expect(s.outside).toEqual([other.lockup.id]);
    expect(s.gone).toEqual(["99:1"]);
    expect(s).not.toHaveProperty("unmapped");
    // A cut walk cannot tell "outside" from "past the cut": it says neither.
    const cut = await read({ nodeId: frame.id, maxNodes: 2 });
    expect(cut.truncated).toBe(true);
    expect(cut).not.toHaveProperty("outside");
    expect(cut.gone).toEqual(["99:1"]);
  });

  it("names every id the page lists the frame under (root.handles) during a stretch, and none outside one", async () => {
    const { frame } = piece();
    expect((await read({ nodeId: frame.id })).root).not.toHaveProperty("handles");
    const second = stretch(frame, "second").get(frame)!.id;
    expect((await read({ nodeId: frame.id })).root.handles).toEqual([frame.id, second]);
    expect((await read({ nodeId: second })).root.handles).toEqual([second, frame.id]);
  });

  it("outside a stretch, a layer past the read is not mapped to a lookalike the walk reached", async () => {
    const { frame } = piece();
    const hidden = frame.add(Object.assign(new N("VECTOR", "Logo"), { visible: false }));
    for (let i = 0; i < 3; i++) frame.add(new N("RECTANGLE", `Bar ${i}`));
    const shown = frame.add(new N("VECTOR", "Logo"));
    expect(hidden.x === shown.x && hidden.width === shown.width).toBe(true);
    const s = await read({ nodeId: frame.id, resolveIds: [shown.id], maxNodes: 8 });
    expect(s.truncated).toBe(true);
    expect(s.aliases).toEqual({});
    expect(s).not.toHaveProperty("unmapped");
  });

  it("finds one animated frame on the page though the page lists it twice", async () => {
    const { frame } = piece();
    stretch(frame, "second");
    expect(page.children).toHaveLength(2);
    expect(await read({})).toMatchObject({ root: { id: frame.id }, from: "page" });
  });

  it("finds one frame in a selection whose layers lead to both handles of it", async () => {
    const { frame, card } = piece();
    const twin = stretch(frame, "created");
    // The created card's parent is the created frame; the listed card's, the second one.
    (page as unknown as { selection: N[] }).selection = [card, twin.get(card)!];
    expect(await read({})).toMatchObject({ root: { id: frame.id }, from: "selection" });
  });

  it("still refuses a selection over two frames that only look alike", async () => {
    const a = piece();
    const b = piece();
    (page as unknown as { selection: N[] }).selection = [a.card, b.card];
    expect(await failure(read({}))).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/The selection spans 2 top-level frames/) });
  });
});

describe("figma_search_nodes lists each layer once during a stretch", () => {
  const search = (params: Record<string, unknown>) => READ_OPS.search_nodes!.run(ctx(params)) as Promise<{ count: number; nodes: Array<{ id: string }> }>;

  it("the frame the page lists twice, and the layers both handles list, come back once", async () => {
    const { frame } = piece();
    stretch(frame, "second");
    const frames = await search({ query: "LinkedIn video" });
    expect(frames.nodes.map((n) => n.id)).toEqual([frame.id]);
    const lockups = await search({ query: "Figxel lockup" });
    expect(lockups.count).toBe(1);
    expect(lockups.nodes[0]!.id).toMatch(/^37:/);
  });

  it("two stacked copies of a frame are both found", async () => {
    piece();
    piece();
    expect((await search({ query: "LinkedIn video" })).count).toBe(2);
  });

  it("a page of stacked lookalike frames costs one pass, not a comparison of every pair", async () => {
    let reads = 0;
    const fill = (count: number) => {
      page.children = [];
      reads = 0;
      for (let i = 0; i < count; i++) {
        const f = page.add(new N("FRAME", "Stack"));
        f.add(new N("RECTANGLE", "Fill"));
        const kids = f.children;
        Object.defineProperty(f, "children", { get: () => (reads++, kids), configurable: true });
      }
    };
    // search_nodes returns at most 500.
    fill(60);
    expect((await search({ query: "Stack", limit: 500 })).count).toBe(60);
    const small = reads;
    fill(480);
    expect((await search({ query: "Stack", limit: 500 })).count).toBe(480);
    // Eight times the frames, about eight times the reads: a pairwise match would be sixty-four.
    expect(reads / small).toBeLessThan(10);
  });

  it("two stacked leaves on the page, and two stacked empty frames, are both found", async () => {
    page.add(new N("RECTANGLE", "Rect"));
    page.add(new N("RECTANGLE", "Rect"));
    page.add(new N("FRAME", "Empty"));
    page.add(new N("FRAME", "Empty"));
    expect((await search({ query: "Rect" })).count).toBe(2);
    expect((await search({ query: "Empty" })).count).toBe(2);
  });
});

describe("the server judges the plan as the snapshot lists it", () => {
  it("listedId and planAsListed map through aliases, and leave everything else", () => {
    const snap = { aliases: { "14:4853": "37:441" } };
    expect(listedId(snap, "14:4853")).toBe("37:441");
    expect(listedId(snap, "27:7889")).toBe("27:7889");
    expect(listedId({}, undefined)).toBeUndefined();
    const plan = record({ brandId: "14:4853", ctaId: "27:7889" });
    expect(planAsListed(plan, snap)).toMatchObject({ brandId: "37:441", ctaId: "27:7889" });
    expect(planAsListed(plan, {})).toBe(plan);
    expect(planAsListed(null, snap)).toBeNull();
    expect(idsToResolve({ brandId: "14:4853" })).toEqual(["14:4853"]);
  });

  /** figma_check_motion through an MCP client, with a fake bridge answering the plugin's snapshot. */
  async function serve(snapshot: () => MotionSnapshot) {
    const sent: Array<{ op: string; params: Record<string, unknown> }> = [];
    const bridge = {
      request: async (op: string, params: Record<string, unknown>) => {
        sent.push({ op, params });
        if (op === "check_motion") return snapshot();
        throw new Error(`the fake bridge has no ${op}`);
      },
      statusAsync: async () => ({ sessions: [] }),
      status: () => ({ sessions: [] }),
    } as unknown as Bridge;
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-second-ids-")), BRIDGE_PORT: "0", BRIDGE_PROCESS: "strict" });
    const proc = new MotionProcess(config.processMode);
    const server = new McpServer({ name: "second-ids", version: "0" }, { capabilities: { prompts: {}, resources: {} } });
    registerTools(server, bridge, config, Date.now(), quietLogger, proc);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "second-ids-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "figma_check_motion", arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
    return { sent, call, proc, close: () => client.close() };
  }

  /** The live frame as the plugin lists it in a stretch: second ids, a plan holding created ids. */
  const listed = (aliases?: Record<string, string>, extra: Partial<MotionSnapshot> = {}): MotionSnapshot => ({
    root: { id: "14:4818", name: "Linkspan v2 · LinkedIn video", width: 1080, height: 1350, durationS: 6 },
    nodes: [
      { id: "14:4818", name: "Linkspan v2 · LinkedIn video", type: "FRAME", parentId: null, width: 1080, height: 1350 },
      { id: "37:441", name: "Figxel lockup", type: "FRAME", parentId: "14:4818", x: 64, y: 34, width: 108, height: 52 },
      { id: "37:472", name: "RM try", type: "TEXT", parentId: "14:4818", x: 96, y: 632, width: 719, height: 44, characters: "Try it", fontSize: 32 },
    ],
    truncated: false,
    maxNodes: 2000,
    plan: record({ brandId: "14:4853", ctaId: "27:7889" }),
    ...(aliases ? { aliases } : {}),
    ...extra,
  });

  it("passes whole against the plan when the plugin maps its ids, and asks the plugin to map the ids the call names", async () => {
    const s = await serve(() => listed({ "14:4853": "37:441", "27:7889": "37:472" }));
    try {
      const r = await s.call({ nodeId: "14:4818", fps: 30 });
      expect(r.isError).toBeFalsy();
      const data = JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
      expect(data).toMatchObject({ ok: true, fromPlan: expect.arrayContaining(["brandId", "ctaId"]) });
      expect(data.processNote).toMatch(/the delivery may render/);
      // Naming the plan's created id is no gap: it is the same layer.
      const asked = await s.call({ nodeId: "14:4818", fps: 30, brandId: "14:4853" });
      expect(JSON.parse(asked.content[0]!.text!).processNote).toMatch(/the delivery may render/);
      expect(s.sent.at(-1)!.params).toMatchObject({ nodeId: "14:4818", resolveIds: ["14:4853"] });
    } finally {
      await s.close();
    }
  });

  /** The refusal figma_check_motion gives for the plan's brandId 14:4853 over `snapshot`. */
  async function refusal(snapshot: MotionSnapshot) {
    const s = await serve(() => snapshot);
    try {
      const r = await s.call({ nodeId: "14:4818", fps: 30 });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/names `brandId` 14:4853, which is not among the layers read/) });
      return String(r.structuredContent!.hint);
    } finally {
      await s.close();
    }
  }

  it("a plugin without the mapping: re-run it if figma_status asks, else the plan's id may be a temporary one", async () => {
    const hint = await refusal(listed());
    expect(hint).toMatch(/^If figma_status asks for a plugin re-run \(build\.restart\)/);
    expect(hint).toMatch(/Otherwise: Store the plan again \(figma_set_motion_plan\) with the id the layer's create call returned/);
  });

  it("an id the plugin neither maps nor explains: store the plan again with the created id", async () => {
    const hint = await refusal(listed({ "27:7889": "37:472" }));
    expect(hint).toMatch(/^Store the plan again \(figma_set_motion_plan\) with the id the layer's create call returned: an id read from a listing inside an animated frame can be temporary/);
  });

  it("an id that resolves to nothing, or to a layer outside the frame: store the plan again", async () => {
    expect(await refusal(listed({ "27:7889": "37:472" }, { gone: ["14:4853"] }))).toMatch(/^The id resolves to nothing: the layer was deleted/);
    expect(await refusal(listed({ "27:7889": "37:472" }, { outside: ["14:4853"] }))).toMatch(/^The layer is no longer in this frame\. Store the plan again/);
  });

  it("an id that two listed layers match: the check says it cannot tell which, and how to settle it", async () => {
    const hint = await refusal(listed({ "27:7889": "37:472" }, { unmapped: ["14:4853"] }));
    expect(hint).toMatch(/two or more layers there match it .* Give those layers distinct names, or check again/);
  });

  it("a check of a frame the page lists twice is recorded under both ids", async () => {
    const s = await serve(() => ({ ...listed({ "14:4853": "37:441", "27:7889": "37:472" }), root: { ...listed().root, handles: ["14:4818", "37:173"] } }));
    try {
      const r = await s.call({ nodeId: "14:4818", fps: 30 });
      expect(r.isError).toBeFalsy();
      expect(s.proc.lastCheck("14:4818")).toMatchObject({ ok: true });
      expect(s.proc.lastCheck("37:173")).toMatchObject({ ok: true });
    } finally {
      await s.close();
    }
  });

  it("a walk cut short: raise maxNodes first, from a plugin without the mapping too", async () => {
    const hint = await refusal(listed({ "27:7889": "37:472" }, { truncated: true }));
    expect(hint).toMatch(/^Raise `maxNodes` so the check reads it\. If it is still missing: Store the plan again/);
    expect(await refusal(listed(undefined, { truncated: true }))).toMatch(/^Raise `maxNodes`/);
  });
});
