// Tells while building (role quality plan W3): figma_create_from_spec's
// result carries the tells of what it just built when a page or top brief is
// in force — the kinds found with their counts, and each finding the brief
// avoids — capped in layers, and never at the cost of the build. The plugin
// side (src/plugin/build-tells.ts, the create op) against a fake canvas with
// real boxes; the server side (src/server/tools/create.ts) through the tools.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avoidNote } from "../src/shared/avoid.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";
import type { Bridge } from "../src/server/bridge.js";
import { summarize } from "../src/server/journal.js";
import { TELLS_NOT_MEASURED } from "../src/server/tools/create.js";
import { BUILD_TELLS, buildTells, tellsAsked } from "../src/plugin/build-tells.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { brief, RoleWorld, serve, type Served } from "./role-fakes.js";

// ── a canvas whose nodes have boxes, so the census can measure them ─────────

let nextId = 1;

class FakeNode {
  id = `8:${nextId++}`;
  name: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  [k: string]: unknown;
  constructor(readonly type: string) {
    this.name = type.charAt(0) + type.slice(1).toLowerCase();
    if (type === "TEXT") this.height = 24;
  }
  get absoluteBoundingBox() {
    let x = 0;
    let y = 0;
    for (let n: FakeNode | null = this; n && n.type !== "PAGE"; n = n.parent) {
      x += n.x;
      y += n.y;
    }
    return { x, y, width: this.width, height: this.height };
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  appendChild(child: FakeNode) {
    if (child.parent) child.parent.children = child.parent.children.filter((n) => n !== child);
    this.children.push(child);
    child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
}

let page: FakeNode;
const all = (): FakeNode[] => {
  const out: FakeNode[] = [];
  const walk = (n: FakeNode) => n.children.forEach((c) => (out.push(c), walk(c)));
  walk(page);
  return out;
};

/** A brief block on the page holding `record`. */
function briefBlock(record: Partial<BriefRecord>): FakeNode {
  const block = new FakeNode("FRAME");
  block.name = "Brief · Features";
  block.x = 5000;
  page.appendChild(block);
  const json = JSON.stringify(brief({ ...record, id: block.id }));
  block.getSharedPluginData = (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? json : "");
  return block;
}

beforeEach(() => {
  page = new FakeNode("PAGE");
  const make = (type: string) => () => {
    const n = new FakeNode(type);
    if (type === "FRAME") n.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    page.appendChild(n);
    return n;
  };
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: new FakeNode("DOCUMENT"),
    createFrame: make("FRAME"),
    createText: make("TEXT"),
    createRectangle: make("RECTANGLE"),
    async loadFontAsync() {},
    async listAvailableFontsAsync() {
      return [];
    },
    async getNodeByIdAsync(id: string) {
      return all().find((n) => n.id === id) ?? null;
    },
    commitUndo() {},
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r-1", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false });

/** A feature row: three identical icon + title + text cards (card_trio). */
const ROW = {
  type: "frame",
  name: "Features",
  width: 1000,
  height: 300,
  children: ["A", "B", "C"].map((n, i) => ({
    type: "frame",
    name: `Card ${n}`,
    x: i * 320,
    y: 40,
    width: 300,
    height: 200,
    background: "#F5F5F5",
    cornerRadius: 12,
    children: [
      { type: "rectangle", name: `${n} icon`, x: 24, y: 24, width: 24, height: 24, fill: "#111111" },
      { type: "text", name: `${n} title`, x: 24, y: 64, width: 252, content: "Fast setup", fontSize: 20 },
      { type: "text", name: `${n} body`, x: 24, y: 100, width: 252, content: "Connect everything in minutes.", fontSize: 16 },
    ],
  })),
};

type Built = { rootId: string; created: unknown[]; tells?: Record<string, unknown>; tellsSkipped?: string };
const build = async (params: Record<string, unknown>) => (await CREATE_OPS.create_from_spec!.run(ctx({ spec: ROW, ...params }))) as Built;

describe("create_from_spec measures the tells of what it built, when asked", () => {
  it("lists the kinds with their counts, and each finding the brief avoids as the check reports it", async () => {
    const block = briefBlock({ gear: "page", avoid: ["card_trio"] });
    const out = await build({ tells: { briefId: block.id } });
    expect(out.created).toHaveLength(13);
    const t = out.tells as { checked: number; kinds: Array<{ kind: string; count: number }>; avoided: Array<{ kind: string; nodeId: string; name: string; detail: string }> };
    expect(t.checked).toBe(13);
    expect(t.kinds).toContainEqual({ kind: "card_trio", count: 1 });
    // Most frequent first.
    expect(t.kinds.map((k) => k.count)).toEqual([...t.kinds.map((k) => k.count)].sort((a, b) => b - a));
    expect(t.avoided).toHaveLength(1);
    expect(t.avoided[0]).toMatchObject({ kind: "card_trio", name: "Card A" });
    expect(t.avoided[0]!.detail.endsWith(avoidNote("card_trio"))).toBe(true);
    // The brief's id is not echoed: the trust layer reads returned ids as made by the write.
    expect(JSON.stringify(t)).not.toContain(block.id);
    expect(out.tellsSkipped).toBeUndefined();
  });

  it("a kind the brief does not avoid is listed but not avoided", async () => {
    const block = briefBlock({ gear: "page", avoid: ["glow"] });
    const t = (await build({ tells: { briefId: block.id } })).tells as { kinds: Array<{ kind: string }>; avoided: unknown[] };
    expect(t.kinds.map((k) => k.kind)).toContain("card_trio");
    expect(t.avoided).toEqual([]);
  });

  it("not asked, it measures nothing", async () => {
    const out = await build({});
    expect(out.tells).toBeUndefined();
    expect(out.tellsSkipped).toBeUndefined();
  });

  it("never fails the build: a brief it cannot read leaves the build whole and says why in one line", async () => {
    const out = await build({ tells: { briefId: "404:404" } });
    expect(out.rootId).toBeTruthy();
    expect(out.created).toHaveLength(13);
    expect(out.tells).toBeUndefined();
    expect(out.tellsSkipped).toBe('The tells of what was built were not measured: no node has the brief\'s id 404:404. figma_check_layout { nodeId, audit: ["tells"] } measures them.');
    const empty = new FakeNode("FRAME");
    page.appendChild(empty);
    expect((await build({ tells: { briefId: empty.id } })).tellsSkipped).toMatch(/not measured: \d+:\d+ carries no brief\./);
  });

  it("a census that throws is a skipped summary, not a failed call", async () => {
    const block = briefBlock({ gear: "page", avoid: ["card_trio"] });
    const figma = {
      getNodeByIdAsync: async (id: string) => {
        if (id === block.id) return block;
        throw new Error("the node went away.");
      },
    };
    const r = await buildTells(figma, ["8:999"], block.id, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(r).toEqual({ tellsSkipped: 'The tells of what was built were not measured: the node went away. figma_check_layout { nodeId, audit: ["tells"] } measures them.' });
  });

  it(`stops at ${BUILD_TELLS.nodes} layers and says so`, async () => {
    const block = briefBlock({ gear: "page" });
    const big = new FakeNode("FRAME");
    big.resize(4000, 4000);
    page.appendChild(big);
    for (let i = 0; i < BUILD_TELLS.nodes + 50; i++) {
      const r = new FakeNode("RECTANGLE");
      r.x = (i % 60) * 60;
      r.y = Math.floor(i / 60) * 60;
      r.resize(40, 40);
      r.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      big.appendChild(r);
    }
    const figma = (globalThis as unknown as { figma: { getNodeByIdAsync(id: string): Promise<unknown> } }).figma;
    const r = (await buildTells(figma, [big.id], block.id, { yieldToHost: async () => {}, isCancelled: () => false })) as { tells: { checked: number; truncated?: boolean } };
    expect(r.tells.checked).toBe(BUILD_TELLS.nodes);
    expect(r.tells.truncated).toBe(true);
  });

  it("reads the request only in its own shape", () => {
    expect(tellsAsked({ tells: { briefId: "12:40" } })).toBe("12:40");
    for (const p of [{}, { tells: "12:40" }, { tells: { briefId: "" } }, { tells: null }]) expect(tellsAsked(p)).toBeUndefined();
  });
});

// ── the server: when to ask, and an older plugin ───────────────────────────

/** A world whose create_from_spec answers as the plugin does: with tells when asked, or as an older plugin, without. */
class BuildWorld extends RoleWorld {
  answer: ((params: Record<string, unknown>) => unknown) | null = null;
  override bridge(): Bridge {
    const inner = super.bridge() as unknown as { request: (op: string, params: Record<string, unknown>, opts?: { session?: string }) => Promise<unknown> };
    return {
      ...(inner as object),
      request: async (op: string, params: Record<string, unknown>, opts: { session?: string } = {}) => {
        if (op !== "create_from_spec" || !this.answer) return inner.request(op, params, opts);
        this.sent.push({ op, params });
        return this.answer(params);
      },
    } as unknown as Bridge;
  }
}

const FILE = "Co-op (figma)";
const SPEC = JSON.stringify({ type: "frame", name: "Features", children: [{ type: "text", content: "Fast setup" }] });

async function served(mode: "strict" | "guided" | "off", inForce?: Partial<BriefRecord>): Promise<Served & { world: BuildWorld }> {
  const world = new BuildWorld();
  const s = await serve(mode, world);
  if (inForce) s.roles.hold(FILE, brief({ id: "12:40", ...inForce }), "set");
  return Object.assign(s, { world });
}
const sentCreate = (s: { world: BuildWorld }) => s.world.sent.filter((x) => x.op === "create_from_spec").at(-1)!.params;

describe("figma_create_from_spec asks for tells under a page or top brief", () => {
  it("asks with the brief in force at page and top; the plugin's summary comes back as it is", async () => {
    for (const gear of ["page", "top"] as const) {
      const s = await served("strict", { gear });
      try {
        const summary = { checked: 4, kinds: [{ kind: "card_trio", count: 1 }], avoided: [] };
        s.world.answer = () => ({ rootId: "5:1", created: [{ id: "5:1", name: "Features", path: "spec" }], nodeCount: 1, tells: summary });
        const r = await s.call("figma_create_from_spec", { spec: SPEC, parentId: "5:0" });
        expect(r.isError, gear).toBeFalsy();
        expect(sentCreate(s).tells, gear).toEqual({ briefId: "12:40" });
        expect(s.data(r).tells, gear).toEqual(summary);
        expect(s.data(r).tellsSkipped, gear).toBeUndefined();
      } finally {
        await s.close();
      }
    }
  });

  it("an older plugin that ignores the request: the result says the tells were not measured", async () => {
    const s = await served("guided", { gear: "page", avoid: ["card_trio"] });
    try {
      s.world.answer = () => ({ rootId: "5:1", created: [], nodeCount: 1 });
      const r = await s.call("figma_create_from_spec", { spec: SPEC, parentId: "5:0" });
      expect(s.data(r)).toMatchObject({ rootId: "5:1", tellsSkipped: TELLS_NOT_MEASURED });
      // The plugin's own one-line reason is kept as it is.
      s.world.answer = () => ({ rootId: "5:2", created: [], nodeCount: 1, tellsSkipped: "The tells of what was built were not measured: x." });
      expect(s.data(await s.call("figma_create_from_spec", { spec: SPEC, parentId: "5:0" })).tellsSkipped).toBe("The tells of what was built were not measured: x.");
    } finally {
      await s.close();
    }
  });

  it("does not ask at the section gear, with no brief in force, with BRIDGE_PROCESS=off, or for another create", async () => {
    const cases: Array<["strict" | "guided" | "off", Partial<BriefRecord> | undefined]> = [
      ["strict", { gear: "section" }],
      ["guided", undefined],
      ["off", { gear: "page" }],
    ];
    for (const [mode, inForce] of cases) {
      const s = await served(mode, inForce);
      try {
        s.world.answer = () => ({ rootId: "5:1", created: [], nodeCount: 1 });
        const r = await s.call("figma_create_from_spec", { spec: SPEC, parentId: "5:0" });
        expect(r.isError, mode).toBeFalsy();
        expect(sentCreate(s).tells, mode).toBeUndefined();
        expect(s.data(r).tellsSkipped, mode).toBeUndefined();
      } finally {
        await s.close();
      }
    }
    const s = await served("strict", { gear: "page" });
    try {
      await s.call("figma_create_frame", { name: "Wrapper", parentId: "5:0" });
      expect(s.world.sent.find((x) => x.op === "create_frame")!.params.tells).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("the change journal's line leaves the request out: it says how the call was sent, not what it did", () => {
    expect(summarize("create_from_spec", { spec: { type: "frame", name: "Features" }, parentId: "5:0", tells: { briefId: "12:40" } })).toBe(
      'figma_create_from_spec spec={frame "Features"} parentId="5:0"',
    );
  });

  it("a role whose sign-off judges no tells is asked only when its brief avoids one", async () => {
    for (const [avoid, asked] of [[undefined, false], [["one_radius"], true]] as const) {
      const s = await served("strict", { role: "design-system", gear: "page", details: { scope: "components" }, ...(avoid ? { avoid: [...avoid] } : {}) });
      try {
        s.world.answer = () => ({ rootId: "5:1", created: [], nodeCount: 1 });
        await s.call("figma_create_from_spec", { spec: SPEC, parentId: "5:0" });
        expect(sentCreate(s).tells !== undefined, String(avoid)).toBe(asked);
      } finally {
        await s.close();
      }
    }
  });
});
