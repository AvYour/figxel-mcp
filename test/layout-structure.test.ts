// Layout and structure edits that only Plugin API JavaScript reached before:
// absolute children inside an auto-layout, min/max limits, wrapping rows with a
// row gap, baseline alignment, stacking order, clipping on an existing frame,
// and rotation about the centre [C-095]. Plus the write mechanics they share:
// a SLOT or an unloaded page as a parent [C-090], and every refusal saying
// `created: []` so a retry is known to be safe [C-096].
//
// The fakes record the ORDER of writes where Figma cares about it: FILL must be
// gone before ABSOLUTE, ABSOLUTE before x/y, WRAP before the row gap.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { LAYOUT_OPS, MODIFY_OPS, selectionOf } from "../src/plugin/ops/modify.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { alignmentFor, parentFor, wrapFields, type FigmaWrite } from "../src/plugin/write.js";

let seq = 0;
let writes: string[];

class N {
  id = `4:${++seq}`;
  name: string;
  children: N[] = [];
  parent: N | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  rotation = 0;
  [k: string]: unknown;
  constructor(readonly type: string, props: Record<string, unknown> = {}) {
    this.name = type;
    Object.assign(this, props);
  }
  /** Figma's: rotation = atan2(-m10, m00) about the top-left, translation = x/y. */
  get relativeTransform(): number[][] {
    const r = (this.rotation * Math.PI) / 180;
    return [[Math.cos(r), Math.sin(r), this.x], [-Math.sin(r), Math.cos(r), this.y]];
  }
  /** The translation column is x and y [C-186]: one write sets both, through x and y here so the order is logged. */
  set relativeTransform(m: number[][]) {
    this.rotation = (Math.atan2(-m[1]![0]!, m[0]![0]!) * 180) / Math.PI;
    this.x = m[0]![2]!;
    this.y = m[1]![2]!;
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  appendChild(c: N) {
    this.insertChild(this.children.length, c);
  }
  insertChild(i: number, c: N) {
    if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c);
    this.children.splice(i, 0, c);
    c.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = null;
  }
}

/** Log every assignment to `props` on `node`, in order, as "prop=value". */
function track(node: N, props: string[]): N {
  for (const p of props) {
    let value = node[p];
    Object.defineProperty(node, p, {
      get: () => value,
      set: (v) => {
        writes.push(`${p}=${String(v)}`);
        value = v;
      },
      configurable: true,
      enumerable: true,
    });
  }
  return node;
}

const byId = new Map<string, N>();
let page: N;
const run = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string; partial?: unknown };
  }
  throw new Error("expected a failure");
};

function make(type: string, parent: N = page, props: Record<string, unknown> = {}): N {
  const n = new N(type, props);
  byId.set(n.id, n);
  parent.appendChild(n);
  return n;
}
const frame = (parent: N = page, props: Record<string, unknown> = {}) =>
  make("FRAME", parent, {
    layoutMode: "NONE", itemSpacing: 0, layoutWrap: "NO_WRAP", counterAxisSpacing: 0, counterAxisAlignContent: "AUTO",
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
    strokesIncludedInLayout: false, itemReverseZIndex: false, clipsContent: false, fills: [],
    minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, layoutPositioning: "AUTO",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    ...props,
  });

beforeEach(() => {
  seq = 0;
  writes = [];
  byId.clear();
  page = new N("PAGE");
  byId.set(page.id, page);
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: new N("DOCUMENT"),
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadFontAsync: async () => {},
    listAvailableFontsAsync: async () => [],
    createFrame: () => frame(page, { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] }),
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

// ── absolute positioning ─────────────────────────────────────────────────────

describe("move_nodes positioning [C-095]", () => {
  it("fixes a fill axis, then goes absolute, then places — in that order — and says what it changed", async () => {
    const card = frame(page, { layoutMode: "VERTICAL" });
    const badge = track(frame(card, { layoutSizingHorizontal: "FILL" }), ["layoutSizingHorizontal", "layoutPositioning", "x", "y"]);
    const r = (await MODIFY_OPS.move_nodes!.run(run({ nodeIds: [badge.id], positioning: "absolute", x: 280, y: -8 }))) as {
      moved: number; items: Array<{ ok: boolean; positioning?: string; sizing?: string }>;
    };
    expect(r.moved).toBe(1);
    expect(r.items[0]).toMatchObject({ ok: true, positioning: "absolute", sizing: "width fixed (was fill)" });
    expect(writes).toEqual(["layoutSizingHorizontal=FIXED", "layoutPositioning=ABSOLUTE", "x=280", "y=-8"]);
  });

  it("positioning alone is a complete call: back into the flow", async () => {
    const row = frame(page, { layoutMode: "HORIZONTAL" });
    const child = frame(row, { layoutPositioning: "ABSOLUTE" });
    const r = (await MODIFY_OPS.move_nodes!.run(run({ nodeIds: [child.id], positioning: "auto" }))) as { items: Array<{ ok: boolean }> };
    expect(r.items[0]!.ok).toBe(true);
    expect(child.layoutPositioning).toBe("AUTO");
  });

  it("a child of a frame without auto-layout gets ok:false with the rule, the rest still move", async () => {
    const plain = frame(page);
    const loose = frame(plain);
    const row = frame(page, { layoutMode: "HORIZONTAL" });
    const inRow = frame(row);
    const r = (await MODIFY_OPS.move_nodes!.run(run({ nodeIds: [loose.id, inRow.id], positioning: "absolute", x: 5 }))) as {
      items: Array<{ ok: boolean; error?: string }>;
    };
    expect(r.items[0]).toMatchObject({ ok: false });
    expect(r.items[0]!.error).toMatch(/needs an auto-layout parent/);
    expect(loose.layoutPositioning).toBe("AUTO");
    expect(r.items[1]!.ok).toBe(true);
  });

  it("a bad positioning, or no x/y/positioning at all, is refused before any node moves", async () => {
    const n = frame();
    for (const params of [{ nodeIds: [n.id], positioning: "fixed" }, { nodeIds: [n.id] }]) {
      expect((await fails(MODIFY_OPS.move_nodes!.run(run(params)))).partial).toEqual({ created: [] });
    }
  });
});

// ── min / max ────────────────────────────────────────────────────────────────

describe("resize_nodes limits [C-095]", () => {
  it("min above max is refused before any node changes", async () => {
    const col = frame(page, { layoutMode: "VERTICAL" });
    const e = await fails(MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id], minWidth: 500, maxWidth: 300 })));
    expect(e.partial).toEqual({ created: [] });
    expect(e.message).toMatch(/minWidth.*above.*maxWidth/);
    expect(col.minWidth).toBeNull();
  });

  it("applies to auto-layout frames and their direct children only, quoting Figma's rule", async () => {
    const col = frame(page, { layoutMode: "VERTICAL" });
    const para = frame(col);
    const loose = frame(frame(page));
    const r = (await MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id, para.id, loose.id], maxWidth: 480 }))) as {
      resized: number; items: Array<{ ok: boolean; error?: string }>;
    };
    expect(r.resized).toBe(2);
    expect([col.maxWidth, para.maxWidth]).toEqual([480, 480]);
    expect(r.items[2]!.error).toMatch(/applicable only to auto-layout frames and their direct children/);
    expect(loose.maxWidth).toBeNull();
  });

  it("clearLimits sets null; a clash with a limit the node already has is that node's ok:false", async () => {
    const col = frame(page, { layoutMode: "VERTICAL", minWidth: 200, maxWidth: 600 });
    await MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id], clearLimits: ["maxWidth"] }));
    expect([col.minWidth, col.maxWidth]).toEqual([200, null]);
    const r = (await MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id], maxWidth: 100 }))) as { items: Array<{ ok: boolean; error?: string }> };
    expect(r.items[0]!.error).toMatch(/minWidth 200 would be above maxWidth 100/);
    expect(col.maxWidth).toBeNull();
  });

  it("a min raised past the current max is written after the new max, so no step clashes", async () => {
    const col = track(frame(page, { layoutMode: "VERTICAL", minWidth: 100, maxWidth: 200 }), ["minWidth", "maxWidth"]);
    await MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id], minWidth: 300, maxWidth: 400 }));
    expect(writes).toEqual(["maxWidth=400", "minWidth=300"]);
  });

  it("a limit both set and cleared, or a non-positive one, is refused", async () => {
    const col = frame(page, { layoutMode: "VERTICAL" });
    for (const params of [{ maxWidth: 10, clearLimits: ["maxWidth"] }, { minHeight: 0 }, { clearLimits: ["width"] }]) {
      expect((await fails(MODIFY_OPS.resize_nodes!.run(run({ nodeIds: [col.id], ...params })))).partial).toEqual({ created: [] });
    }
  });
});

// ── auto-layout: wrap, baseline, stacking ───────────────────────────────────

describe("set_auto_layout wrap, row gap, baseline, stacking [C-095]", () => {
  it("rowGap without wrap is refused before the layout changes", async () => {
    const f = frame();
    const e = await fails(MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, mode: "horizontal", rowGap: 12 })));
    expect(e.partial).toEqual({ created: [] });
    expect(f.layoutMode).toBe("NONE");
  });

  it("turning wrap on gives the rows the gap and says so; an explicit rowGap and alignContent follow WRAP", async () => {
    const f = frame();
    const r = (await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, mode: "horizontal", gap: 24, wrap: true }))) as Record<string, unknown>;
    expect(f.counterAxisSpacing).toBe(24);
    expect(r.rowGap).toBe("24 (same as gap)");
    expect(r.counterAxisSpacing).toBe(24);

    const g = track(frame(), ["layoutWrap", "counterAxisSpacing", "counterAxisAlignContent"]);
    await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: g.id, mode: "horizontal", wrap: true, rowGap: 12, alignContent: "space-between" }));
    expect(writes).toEqual(["layoutWrap=WRAP", "counterAxisSpacing=12", "counterAxisAlignContent=SPACE_BETWEEN"]);
  });

  it("an already wrapping frame keeps its row gap when wrap is only repeated", async () => {
    const f = frame(page, { layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 40 });
    await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, wrap: true, gap: 16 }));
    expect(f.counterAxisSpacing).toBe(40);
    // ...and a rowGap alone is fine on a frame that already wraps.
    await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, rowGap: 20 }));
    expect(f.counterAxisSpacing).toBe(20);
  });

  it("baseline is alignY of a row only", async () => {
    expect(alignmentFor("HORIZONTAL", undefined, "baseline")).toEqual({ counterAxisAlignItems: "BASELINE" });
    expect(() => alignmentFor("VERTICAL", undefined, "baseline")).toThrow(/horizontal layout only/);
    expect(() => alignmentFor("HORIZONTAL", "baseline", undefined)).toThrow(/alignY of a horizontal layout only/);
    const f = frame();
    await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, mode: "horizontal", alignY: "baseline" }));
    expect(f.counterAxisAlignItems).toBe("BASELINE");
  });

  it("a negative gap overlaps items, and the stacking flags are set", async () => {
    const f = frame();
    const r = (await MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, mode: "horizontal", gap: -12, reverseZIndex: true, strokesInLayout: true }))) as Record<string, unknown>;
    expect([f.itemSpacing, f.itemReverseZIndex, f.strokesIncludedInLayout]).toEqual([-12, true, true]);
    expect(r).toMatchObject({ itemReverseZIndex: true, strokesIncludedInLayout: true });
  });

  it("the stacking flags need auto-layout", async () => {
    const f = frame();
    expect((await fails(MODIFY_OPS.set_auto_layout!.run(run({ nodeId: f.id, mode: "none", reverseZIndex: true })))).partial).toEqual({ created: [] });
  });

  it("create_frame takes the same row gap, and refuses wrap on a column instead of dropping it", async () => {
    const r = (await CREATE_OPS.create_frame!.run(run({ layout: "horizontal", wrap: true, gap: 8, alignY: "baseline" }))) as { id: string; rowGap?: string };
    expect(byId.get(r.id)).toMatchObject({ layoutWrap: "WRAP", counterAxisSpacing: 8, counterAxisAlignItems: "BASELINE" });
    expect(r.rowGap).toBe("8 (same as gap)");
    const before = page.children.length;
    for (const params of [{ layout: "vertical", wrap: true }, { layout: "horizontal", rowGap: 4 }]) {
      expect((await fails(CREATE_OPS.create_frame!.run(run(params)))).partial).toEqual({ created: [] });
    }
    expect(page.children).toHaveLength(before);
  });

  it("wrapFields: rowGap and alignContent need a frame that wraps", () => {
    expect(() => wrapFields({ alignContent: "auto" }, false)).toThrow(/wrap: true/);
    expect(() => wrapFields({ rowGap: -1 }, true)).toThrow(/>= 0/);
    expect(wrapFields({ rowGap: 8, alignContent: "space-between" }, true)).toEqual({ rowGap: 8, alignContent: "SPACE_BETWEEN" });
  });
});

// ── clipping ────────────────────────────────────────────────────────────────

describe("set_clips_content", () => {
  it("turns clipping on a frame on, and says a shape has none", async () => {
    const f = frame();
    const shape = make("RECTANGLE");
    const r = (await LAYOUT_OPS.set_clips_content!.run(run({ nodeIds: [f.id, shape.id], clipsContent: true }))) as {
      updated: number; items: Array<{ ok: boolean; error?: string }>;
    };
    expect(r.updated).toBe(1);
    expect(f.clipsContent).toBe(true);
    expect(r.items[1]!.error).toMatch(/a RECTANGLE has no clipsContent/);
    expect("clipsContent" in shape).toBe(false);
  });

  it("a missing value is refused before anything changes", async () => {
    expect((await fails(LAYOUT_OPS.set_clips_content!.run(run({ nodeIds: [frame().id] })))).partial).toEqual({ created: [] });
  });
});

// ── rotation pivot ──────────────────────────────────────────────────────────

describe("rotate_nodes pivot [C-098]", () => {
  const centre = (n: N) => {
    const [[a, b, tx], [c, d, ty]] = n.relativeTransform as [[number, number, number], [number, number, number]];
    return { x: a * n.width / 2 + b * n.height / 2 + tx, y: c * n.width / 2 + d * n.height / 2 + ty };
  };

  it("turns about the centre by default — the centre does not move", async () => {
    const card = frame(page, { x: 10, y: 20, width: 100, height: 50 });
    const before = centre(card);
    const r = (await MODIFY_OPS.rotate_nodes!.run(run({ nodeIds: [card.id], angle: 90 }))) as { items: Array<{ pivot?: string }> };
    const after = centre(card);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(r.items[0]!.pivot).toBe("center");
    expect([card.x, card.y].map((v) => Math.round(v))).toEqual([35, 95]);
  });

  it("origin keeps Figma's raw behaviour; inside an auto-layout the layout owns the position", async () => {
    const free = frame(page, { x: 10, y: 20 });
    await MODIFY_OPS.rotate_nodes!.run(run({ nodeIds: [free.id], angle: 45, pivot: "origin" }));
    expect([free.x, free.y]).toEqual([10, 20]);
    const row = frame(page, { layoutMode: "HORIZONTAL" });
    const kid = frame(row, { x: 4, y: 4 });
    const r = (await MODIFY_OPS.rotate_nodes!.run(run({ nodeIds: [kid.id], angle: 45 }))) as { items: Array<{ pivot?: string }> };
    expect(r.items[0]!.pivot).toBe("layout");
    expect([kid.x, kid.y, kid.rotation]).toEqual([4, 4, 45]);
  });

  it("an unknown pivot is refused before any node turns", async () => {
    const n = frame();
    expect((await fails(MODIFY_OPS.rotate_nodes!.run(run({ nodeIds: [n.id], angle: 10, pivot: "corner" })))).partial).toEqual({ created: [] });
    expect(n.rotation).toBe(0);
  });
});

// ── parents: a slot, an unloaded page ──────────────────────────────────────

describe("parents [C-090] [C-112]", () => {
  /** A page that, like dynamic-page, refuses children until loadAsync has run. */
  function unloadedPage(): N & { loads: number } {
    const p = new N("PAGE", { loads: 0 }) as N & { loads: number };
    let loaded = false;
    p.loadAsync = async () => {
      loaded = true;
      p.loads++;
    };
    const append = p.insertChild.bind(p);
    p.insertChild = (i: number, c: N) => {
      if (!loaded) throw new Error("in appendChild: Cannot access children on a page that has not been explicitly loaded");
      append(i, c);
    };
    p.appendChild = (c: N) => (p.insertChild as (i: number, c: N) => void)(p.children.length, c);
    byId.set(p.id, p);
    return p;
  }

  it("a page that is not the current one is loaded before a create appends to it", async () => {
    const other = unloadedPage();
    const r = (await CREATE_OPS.create_frame!.run(run({ parentId: other.id, name: "Far" }))) as { id: string };
    expect(other.loads).toBe(1);
    expect(byId.get(r.id)!.parent).toBe(other);
  });

  it("reparent_nodes loads its target page too", async () => {
    const other = unloadedPage();
    const n = frame();
    const r = (await MODIFY_OPS.reparent_nodes!.run(run({ nodeIds: [n.id], parentId: other.id }))) as { reparented: number };
    expect(r.reparented).toBe(1);
    expect(n.parent).toBe(other);
  });

  it("a SLOT is a parent", async () => {
    const slot = make("SLOT");
    const got = await parentFor((globalThis as unknown as { figma: FigmaWrite }).figma, slot.id);
    expect(got).toBe(slot);
    await expect(parentFor((globalThis as unknown as { figma: FigmaWrite }).figma, make("RECTANGLE").id)).rejects.toThrow(/cannot contain children/);
  });

  it("B-3: an instance, or a layer inside one, is refused as a parent; its slot and the slot's content are not [C-123]", async () => {
    const f = (globalThis as unknown as { figma: FigmaWrite }).figma;
    const card = make("INSTANCE", page, { name: "Card" });
    const body = make("FRAME", card, { name: "Body" });
    const slot = make("SLOT", body, { name: "Content" });
    const filled = make("FRAME", slot, { name: "Filled" });
    const hint = "Add children to the main component, or to a slot of the instance.";
    for (const [parent, says] of [[card, /"Card" is an instance/], [body, /"Body" is inside the instance "Card"/]] as const) {
      const e = await fails(parentFor(f, parent.id));
      expect(e).toMatchObject({ code: "INVALID_PARAM", hint });
      expect(e.message).toMatch(says);
    }
    expect(await parentFor(f, slot.id)).toBe(slot);
    expect(await parentFor(f, filled.id)).toBe(filled);
  });

  it("B-3: create_frame into an instance creates nothing and says so", async () => {
    const card = make("INSTANCE", page, { name: "Card" });
    let created = 0;
    const g = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    const createFrame = g.createFrame as () => N;
    g.createFrame = () => {
      created++;
      return createFrame();
    };
    const before = page.children.length;
    const e = await fails(CREATE_OPS.create_frame!.run(run({ parentId: card.id, name: "Badge" })));
    expect(e).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    expect(created).toBe(0);
    expect(page.children).toHaveLength(before);
    expect(card.children).toHaveLength(0);
  });
});

// ── safe to retry: refusals say nothing changed [C-096] ─────────────────────

describe("modify refusals carry created: []", () => {
  it.each([
    ["set_text", { nodeId: "404:1", content: "x" }],
    ["rename_node", { nodeId: "404:1" }],
    ["reorder_nodes", { nodeIds: ["404:1"], position: "sideways" }],
    ["set_constraints", { nodeIds: ["404:1"], horizontal: "middle" }],
    ["set_opacity", { nodeIds: ["404:1"], opacity: 2 }],
    ["find_replace_text", { find: "a" }],
    ["batch_rename_nodes", { pattern: "(", replace: "", regex: true }],
    ["set_auto_layout", { nodeId: "404:1" }],
    ["reparent_nodes", { nodeIds: ["4:1"], parentId: "404:1" }],
    ["group_nodes", { nodeIds: ["404:1"] }],
  ])("%s %j", async (op, params) => {
    expect((await fails(MODIFY_OPS[op]!.run(run(params)))).partial).toEqual({ created: [] });
  });

  it("a font that will not load leaves the text untouched and says so", async () => {
    const t = make("TEXT", page, { characters: "old", fontName: { family: "Gone", style: "Regular" } });
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.loadFontAsync = async () => {
      throw new Error("font not available");
    };
    const e = await fails(MODIFY_OPS.set_text!.run(run({ nodeId: t.id, content: "new" })));
    expect(e.partial).toEqual({ created: [] });
    expect(t.characters).toBe("old");
  });
});

describe("create refusals carry created: [] too", () => {
  it("a page Figma will not create (the Starter cap), and a spec that is not JSON", async () => {
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.createPage = () => {
      throw new Error("The Starter plan only comes with 3 pages");
    };
    const e = await fails(CREATE_OPS.create_page!.run(run({ name: "Four" })));
    expect(e.partial).toEqual({ created: [] });
    expect(e.hint).toMatch(/Starter plan allows 3 pages/);
    expect((await fails(CREATE_OPS.create_from_spec!.run(run({ spec: "{nope" })))).partial).toEqual({ created: [] });
    expect((await fails(CREATE_OPS.create_section!.run(run({})))).partial).toEqual({ created: [] }); // no createSection here
  });
});

describe("the selection lives on the page [C-097]", () => {
  it("selectionOf reads currentPage.selection — PluginAPI has no figma.selection", () => {
    const a = frame();
    page.selection = [a];
    expect(selectionOf((globalThis as unknown as { figma: unknown }).figma)).toEqual([a]);
  });

  it("batch_rename_nodes { scope: selection } renames inside the selected node", async () => {
    const card = frame(page);
    const inner = frame(card);
    const outside = frame(page);
    inner.name = "Frame 1";
    outside.name = "Frame 2";
    page.selection = [card];
    const r = (await MODIFY_OPS.batch_rename_nodes!.run(run({ pattern: "Frame", replace: "Card", scope: "selection" }))) as { renamed: number };
    expect(r.renamed).toBe(1);
    expect([inner.name, outside.name]).toEqual(["Card 1", "Frame 2"]);
  });
});
