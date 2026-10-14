// Prototype behaviour that is not a reaction: scrolling with fixed layers, and
// a page's flows [C-117]. Fixed layers are a section at the top of the layer
// list — the end of `children` — not a per-layer flag, so the op moves them
// there and counts them; which end Figma counts from is measured live [C-118].

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_OPS } from "../src/plugin/ops/motion.js";

let seq = 0;
const byId = new Map<string, P>();

class P {
  id = `6:${++seq}`;
  name: string;
  children: P[] = [];
  parent: P | null = null;
  [k: string]: unknown;
  constructor(readonly type: string, name?: string) {
    this.name = name ?? type;
    byId.set(this.id, this);
    if (type === "FRAME") Object.assign(this, { overflowDirection: "NONE", numberOfFixedChildren: 0, layoutMode: "NONE" });
    if (type === "PAGE") Object.assign(this, { flowStartingPoints: [], prototypeBackgrounds: [] });
  }
  /** Figma's appendChild refuses to move a layer within an instance [C-123]; `adopt` builds one. */
  appendChild(c: P): P {
    for (let n: P | null = this; n; n = n.parent) {
      if (n.type === "INSTANCE") throw new Error("Cannot move node. New parent is an instance or is inside of an instance");
    }
    return this.adopt(c);
  }
  adopt(c: P): P {
    if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c);
    c.parent = this;
    this.children.push(c);
    return c;
  }
}

let page: P;
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
const ids = (n: P) => n.children.map((c) => c.name);

beforeEach(() => {
  seq = 0;
  byId.clear();
  page = new P("PAGE", "Page 1");
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: { name: "doc", children: [page] },
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

/** A tall frame: header, nav, content. */
function scroller(layoutMode = "NONE"): { frame: P; header: P; nav: P; content: P } {
  const frame = page.appendChild(new P("FRAME", "Feed"));
  frame.layoutMode = layoutMode;
  const header = frame.appendChild(new P("FRAME", "Header"));
  const nav = frame.appendChild(new P("FRAME", "Nav"));
  const content = frame.appendChild(new P("FRAME", "Content"));
  return { frame, header, nav, content };
}

describe("figma_set_scroll_behavior", () => {
  it("moves the fixed layers to the top of the list, in order, and counts them", async () => {
    const { frame, header, nav } = scroller();
    const r = await run("set_scroll_behavior", { nodeId: frame.id, overflow: "vertical", fixedNodeIds: [nav.id, header.id] });
    expect(ids(frame)).toEqual(["Content", "Nav", "Header"]);
    expect([frame.overflowDirection, frame.numberOfFixedChildren]).toEqual(["VERTICAL", 2]);
    expect(r).toEqual({ nodeId: frame.id, overflow: "vertical", fixedChildren: 2, order: frame.children.map((c) => c.id) });
  });

  it("[] makes every child scroll again without reordering anything", async () => {
    const { frame, nav } = scroller();
    await run("set_scroll_behavior", { nodeId: frame.id, fixedNodeIds: [nav.id] });
    const before = ids(frame);
    await run("set_scroll_behavior", { nodeId: frame.id, fixedNodeIds: [] });
    expect(ids(frame)).toEqual(before);
    expect(frame.numberOfFixedChildren).toBe(0);
  });

  it("in auto-layout, a child still in the flow is refused with the fix, and nothing moves", async () => {
    const { frame, nav } = scroller("VERTICAL");
    const e = await fails(run("set_scroll_behavior", { nodeId: frame.id, overflow: "vertical", fixedNodeIds: [nav.id] }));
    expect(e.message).toMatch(/auto-layout flow/);
    expect(e.hint).toMatch(/figma_move_nodes .*positioning: "absolute"/);
    expect(e.partial).toEqual({ created: [] });
    expect(ids(frame)).toEqual(["Header", "Nav", "Content"]);
    expect([frame.overflowDirection, frame.numberOfFixedChildren]).toEqual(["NONE", 0]);
    // Once absolute, it qualifies.
    nav.layoutPositioning = "ABSOLUTE";
    await run("set_scroll_behavior", { nodeId: frame.id, fixedNodeIds: [nav.id] });
    expect(frame.numberOfFixedChildren).toBe(1);
  });

  it("refuses a layer that is not a direct child, and a node that cannot scroll", async () => {
    const { frame, content } = scroller();
    const deep = content.appendChild(new P("TEXT", "Deep"));
    expect((await fails(run("set_scroll_behavior", { nodeId: frame.id, fixedNodeIds: [deep.id] }))).message).toMatch(/not a direct child/);
    expect((await fails(run("set_scroll_behavior", { nodeId: deep.id, overflow: "vertical" }))).message).toMatch(/no scroll behaviour/);
    expect((await fails(run("set_scroll_behavior", { nodeId: frame.id, overflow: "diagonal" }))).message).toMatch(/must be "none"/);
  });

  it("an instance takes overflow, but fixing its layers is refused before anything changes [C-123]", async () => {
    const inst = page.appendChild(new P("INSTANCE", "Feed instance"));
    Object.assign(inst, { overflowDirection: "NONE", numberOfFixedChildren: 0, layoutMode: "NONE" });
    const nav = inst.adopt(new P("FRAME", "Nav"));
    inst.adopt(new P("FRAME", "Content"));
    const e = await fails(run("set_scroll_behavior", { nodeId: inst.id, overflow: "vertical", fixedNodeIds: [nav.id] }));
    expect(e.message).toMatch(/is an instance/);
    expect(e.hint).toMatch(/main component/);
    expect(e.partial).toEqual({ created: [] });
    expect([inst.overflowDirection, inst.numberOfFixedChildren]).toEqual(["NONE", 0]);
    // A frame inside an instance is the same.
    const tab = nav.adopt(new P("FRAME", "Tab"));
    nav.adopt(new P("FRAME", "Panel"));
    const inner = await fails(run("set_scroll_behavior", { nodeId: nav.id, overflow: "vertical", fixedNodeIds: [tab.id] }));
    expect(inner.message).toMatch(/inside an instance/);
    expect(inner.partial).toEqual({ created: [] });
    expect(nav.overflowDirection).toBe("NONE");
    // `overflow` alone moves nothing, so it still applies.
    await run("set_scroll_behavior", { nodeId: inst.id, overflow: "vertical" });
    expect(inst.overflowDirection).toBe("VERTICAL");
  });

  it("a move Figma refuses: the first changed nothing, a later one says what moved — overflow is written last", async () => {
    const { frame, header, nav } = scroller();
    const real = frame.appendChild.bind(frame);
    frame.appendChild = (c: P) => {
      if (c === header) throw new Error("Cannot move node. Node is an internal, readonly-only node");
      return real(c);
    };
    const first = await fails(run("set_scroll_behavior", { nodeId: frame.id, overflow: "vertical", fixedNodeIds: [header.id, nav.id] }));
    expect(first.message).toMatch(/Figma refused `fixedNodeIds` on "Feed": Cannot move node/);
    expect(first.partial).toEqual({ created: [] });
    expect([frame.overflowDirection, frame.numberOfFixedChildren]).toEqual(["NONE", 0]);
    expect(ids(frame)).toEqual(["Header", "Nav", "Content"]);
    const later = await fails(run("set_scroll_behavior", { nodeId: frame.id, overflow: "vertical", fixedNodeIds: [nav.id, header.id] }));
    expect(later.partial).toEqual({ moved: [nav.id], failedAt: "fixedNodeIds" });
    expect(later.hint).toMatch(/partial\.moved/);
    expect(frame.overflowDirection).toBe("NONE");
  });

  it("layers already on top in the given order are not moved again", async () => {
    const { frame, content } = scroller();
    frame.appendChild = () => {
      throw new Error("appendChild should not run");
    };
    const r = await run("set_scroll_behavior", { nodeId: frame.id, overflow: "vertical", fixedNodeIds: [content.id] });
    expect(r).toMatchObject({ overflow: "vertical", fixedChildren: 1 });
    expect(ids(frame)).toEqual(["Header", "Nav", "Content"]);
  });
});

describe("figma_set_prototype_flows", () => {
  it("replaces the starting points in order and sets the prototype background", async () => {
    const a = page.appendChild(new P("FRAME", "Home"));
    const b = page.appendChild(new P("FRAME", "Checkout"));
    const r = await run("set_prototype_flows", { flows: [{ nodeId: b.id, name: "Buy" }, { nodeId: a.id, name: "Browse" }], background: "#111111" });
    expect(page.flowStartingPoints).toEqual([{ nodeId: b.id, name: "Buy" }, { nodeId: a.id, name: "Browse" }]);
    expect(page.prototypeBackgrounds).toEqual([{ type: "SOLID", color: { r: 17 / 255, g: 17 / 255, b: 17 / 255 } }]);
    expect(r).toEqual({ pageId: page.id, flows: [{ nodeId: b.id, name: "Buy" }, { nodeId: a.id, name: "Browse" }], background: "#111111" });
    await run("set_prototype_flows", { flows: [] });
    expect(page.flowStartingPoints).toEqual([]);
  });

  it("a flow starts at a top-level frame of that page — anything else is refused before the list changes", async () => {
    const a = page.appendChild(new P("FRAME", "Home"));
    const nested = a.appendChild(new P("FRAME", "Card"));
    page.flowStartingPoints = [{ nodeId: a.id, name: "Kept" }];
    for (const flows of [[{ nodeId: a.id, name: "A" }, { nodeId: nested.id, name: "B" }], [{ nodeId: a.id, name: "" }], [{ nodeId: a.id, name: "A" }, { nodeId: a.id, name: "Again" }]]) {
      const e = await fails(run("set_prototype_flows", { flows }));
      expect(e.partial).toEqual({ created: [] });
    }
    expect(page.flowStartingPoints).toEqual([{ nodeId: a.id, name: "Kept" }]);
  });

  it("loads another page before reading its frames (dynamic-page) [C-090]", async () => {
    const other = new P("PAGE", "Page 2");
    let loaded = false;
    other.loadAsync = async () => {
      loaded = true;
    };
    const f = other.appendChild(new P("FRAME", "Start"));
    await run("set_prototype_flows", { pageId: other.id, flows: [{ nodeId: f.id, name: "Start" }] });
    expect(loaded).toBe(true);
    expect(other.flowStartingPoints).toEqual([{ nodeId: f.id, name: "Start" }]);
  });
});
