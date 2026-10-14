// The tools that bring Figxel level with what the official Figma MCP reaches
// through Plugin API JavaScript [C-083] — lines, polygons, stars, vector paths,
// boolean shapes, masks, layout grids, variants and component properties — plus
// the spec types that let one call build a whole section, and three fixes:
// figma_status naming the stale side [C-084], `covered` reporting the hidden
// area of the TEXT, and a clipped layer counting only where it is visible.
//
// Every fake behaves like the Plugin API where it matters: a new node lands on
// the current page at once, createNodeFromSvg returns a frame of vectors, and
// the PluginAPI boolean calls take (nodes, parent, index).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { SHAPE_OPS, toLayoutGrid } from "../src/plugin/ops/shapes.js";
import { COMPONENT_OPS, resolvePropertyKey } from "../src/plugin/ops/component.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";
import { checkLayout } from "../src/plugin/ops/check.js";
import { checkBuild } from "../src/server/plugin-build.js";

let seq = 0;

class N {
  id = `8:${++seq}`;
  name: string;
  children: N[] = [];
  parent: N | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  removed = false;
  [k: string]: unknown;
  constructor(readonly type: string) {
    this.name = type.charAt(0) + type.slice(1).toLowerCase();
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  rescale(f: number) {
    this.width *= f;
    this.height *= f;
  }
  appendChild(c: N) {
    this.insertChild(this.children.length, c);
  }
  insertChild(i: number, c: N) {
    const old = c.parent;
    if (old) old.children = old.children.filter((k) => k !== c);
    this.children.splice(i, 0, c);
    c.parent = this;
    // Figma deletes a group the moment its last child leaves it [C-086].
    if (old?.type === "GROUP" && old.children.length === 0) old.remove();
  }
  remove() {
    if (this.removed) throw new Error(`in remove: The node with id "${this.id}" does not exist`);
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = null;
    byId.delete(this.id);
  }
}

const byId = new Map<string, N>();
let page: N;
let calls: Array<{ fn: string; ids: string[]; parent: string; index?: number }>;
const run = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});

function make(type: string, parent: N = page): N {
  const n = new N(type);
  byId.set(n.id, n);
  parent.appendChild(n);
  return n;
}

beforeEach(() => {
  seq = 0;
  byId.clear();
  calls = [];
  page = new N("PAGE");
  byId.set(page.id, page);
  const boolean = (fn: string) => (nodes: N[], parent: N, index?: number) => {
    calls.push({ fn, ids: nodes.map((n) => n.id), parent: parent.id, index });
    const b = make(fn === "flatten" ? "VECTOR" : "BOOLEAN_OPERATION", parent);
    // A boolean is painted Figma's default grey, whatever its children are [C-086].
    b.fills = [{ type: "SOLID", color: { r: 0.851, g: 0.851, b: 0.851 } }];
    for (const n of nodes) b.appendChild(n);
    return b;
  };
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: new N("DOCUMENT"),
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadFontAsync: async () => {},
    listAvailableFontsAsync: async () => [],
    createFrame: () => {
      const f = make("FRAME");
      f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      f.layoutMode = "NONE";
      return f;
    },
    createText: () => make("TEXT"),
    createRectangle: () => make("RECTANGLE"),
    createEllipse: () => make("ELLIPSE"),
    createLine: () => Object.assign(make("LINE"), { strokes: [], strokeCap: "NONE" }),
    createPolygon: () => Object.assign(make("POLYGON"), { pointCount: 3 }),
    createStar: () => Object.assign(make("STAR"), { pointCount: 5, innerRadius: 0.38 }),
    createNodeFromSvg: (svg: string) => {
      if (!svg.includes("<svg")) throw new Error("bad svg");
      // Measured: a GROUP when the <svg> has no width, height or viewBox, else a FRAME [C-086].
      const sized = /<svg[^>]*\s(width|height|viewBox)=/.test(svg);
      const frame = make(sized ? "FRAME" : "GROUP");
      if (sized) frame.layoutMode = "NONE";
      const v = make("VECTOR", frame);
      v.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      v.width = 24;
      v.height = 12;
      v.svg = svg;
      return frame;
    },
    createImageAsync: async (url: string) => {
      if (url.includes("broken")) throw new Error("Image could not be loaded");
      return { hash: `hash-of-${url}`, getSizeAsync: async () => ({ width: 800, height: 600 }) };
    },
    createComponentFromNode: (n: N) => {
      const c = make("COMPONENT", n.parent ?? page);
      for (const k of [...n.children]) c.appendChild(k);
      n.remove();
      return c;
    },
    union: boolean("union"),
    subtract: boolean("subtract"),
    intersect: boolean("intersect"),
    exclude: boolean("exclude"),
    flatten: boolean("flatten"),
    combineAsVariants: (comps: N[], parent: N, index?: number) => {
      calls.push({ fn: "combineAsVariants", ids: comps.map((c) => c.id), parent: parent.id, index });
      const set = make("COMPONENT_SET", parent);
      set.layoutMode = "NONE";
      for (const c of comps) set.appendChild(c);
      set.componentPropertyDefinitions = { Size: { type: "VARIANT", variantOptions: ["Small", "Large"] } };
      return set;
    },
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; partial?: { created: unknown[] } };
  }
  throw new Error("expected a failure");
};

// ── shapes ───────────────────────────────────────────────────────────────────

describe("create_line", () => {
  it("is resized with a height of exactly 0 and carries its cap, colour and angle", async () => {
    const r = (await SHAPE_OPS.create_line!.run(run({ length: 240, angle: 90, cap: "arrow", color: "#ff0000", weight: 2 }))) as { id: string };
    const line = byId.get(r.id)!;
    expect([line.width, line.height]).toEqual([240, 0]);
    expect(line.strokeCap).toBe("ARROW_LINES");
    expect(line.strokeWeight).toBe(2);
    expect(line.rotation).toBe(90);
    expect((line.strokes as Array<{ color: { r: number } }>)[0]!.color.r).toBe(1);
  });

  it("an unknown cap is refused before the line exists", async () => {
    const e = await fails(SHAPE_OPS.create_line!.run(run({ length: 10, cap: "zigzag" })));
    expect(e.partial).toEqual({ created: [] });
    expect(page.children).toHaveLength(0);
  });
});

describe("create_polygon / create_star", () => {
  it("set the point count, inner radius, size and paints", async () => {
    const p = (await SHAPE_OPS.create_polygon!.run(run({ width: 60, height: 60, pointCount: 6, fill: "#00ff00" }))) as { id: string };
    expect(byId.get(p.id)!.pointCount).toBe(6);
    const s = (await SHAPE_OPS.create_star!.run(run({ width: 40, height: 40, innerRadius: 0.5, stroke: "#000000" }))) as { id: string };
    const star = byId.get(s.id)!;
    expect([star.pointCount, star.innerRadius, star.strokeWeight]).toEqual([5, 0.5, 1]);
  });

  it("refuse a degenerate shape before creating anything", async () => {
    expect((await fails(SHAPE_OPS.create_polygon!.run(run({ width: 10, height: 10, pointCount: 2 })))).partial).toEqual({ created: [] });
    expect((await fails(SHAPE_OPS.create_star!.run(run({ width: 10, height: 10, innerRadius: 1.5 })))).partial).toEqual({ created: [] });
    expect(page.children).toHaveLength(0);
  });
});

describe("create_vector", () => {
  it("lifts the vector out of the SVG wrapper, drops the wrapper, and scales it", async () => {
    const parent = make("FRAME");
    parent.layoutMode = "NONE";
    const r = (await SHAPE_OPS.create_vector!.run(run({ path: "M0 0 L24 12 L0 24 Z", width: 48, fill: "#123456", parentId: parent.id }))) as { id: string; width: number };
    expect(parent.children.map((c) => c.id)).toEqual([r.id]);
    expect(page.children.map((c) => c.type)).toEqual(["FRAME"]); // only `parent`: the wrapper is gone
    expect(r.width).toBe(48);
  });

  it("survives Figma deleting the GROUP wrapper itself, and still paints the vector [C-086]", async () => {
    const parent = make("FRAME");
    parent.layoutMode = "NONE";
    const r = (await SHAPE_OPS.create_vector!.run(run({ path: "M10 80 q 40 -80 80 0", stroke: "#10b981", strokeWeight: 4, parentId: parent.id }))) as { id: string };
    const v = byId.get(r.id)!;
    expect(v.parent).toBe(parent);
    expect((v.strokes as Array<{ color: { g: number } }>)[0]!.color.g).toBeCloseTo(0.725, 2);
    expect(page.children.map((c) => c.type)).toEqual(["FRAME"]);
  });

  it("refuses something that is not path data, before Figma sees it", async () => {
    const e = await fails(SHAPE_OPS.create_vector!.run(run({ path: "<script>alert(1)</script>" })));
    expect(e.partial).toEqual({ created: [] });
    expect(page.children).toHaveLength(0);
  });

  it("a stroke without a fill draws an open line, not a black blob", async () => {
    const r = (await SHAPE_OPS.create_vector!.run(run({ path: "M0 0 C10 10 20 10 30 0", stroke: "#ff0000", strokeWeight: 3 }))) as { id: string };
    const v = byId.get(r.id)!;
    expect(v.fills).toEqual([]);
    expect(v.strokeWeight).toBe(3);
  });
});

describe("boolean_nodes / flatten_nodes / set_mask", () => {
  it("passes the nodes, their shared parent and the lowest index to Figma", async () => {
    const card = make("FRAME");
    make("RECTANGLE", card);
    const a = make("ELLIPSE", card);
    const b = make("RECTANGLE", card);
    const r = (await SHAPE_OPS.boolean_nodes!.run(run({ nodeIds: [b.id, a.id], operation: "subtract", name: "Badge" }))) as { name: string; operation: string };
    expect(calls[0]).toEqual({ fn: "subtract", ids: [b.id, a.id], parent: card.id, index: 1 });
    expect(r).toMatchObject({ name: "Badge", operation: "SUBTRACT" });
  });

  it("the result keeps the lowest shape's paint instead of Figma's default grey [C-086]", async () => {
    const card = make("FRAME");
    const a = make("ELLIPSE", card);
    a.fills = [{ type: "SOLID", color: { r: 0.94, g: 0.27, b: 0.27 } }];
    a.strokes = [];
    const b = make("ELLIPSE", card);
    b.fills = [{ type: "SOLID", color: { r: 0.23, g: 0.51, b: 0.96 } }];
    b.strokes = [];
    // nodeIds in the "wrong" order: the paint still comes from the lowest layer.
    const r = (await SHAPE_OPS.boolean_nodes!.run(run({ nodeIds: [b.id, a.id], operation: "subtract" }))) as { id: string; paintFrom: string };
    expect((byId.get(r.id)!.fills as Array<{ color: { r: number } }>)[0]!.color.r).toBe(0.94);
    expect(r.paintFrom).toBe(a.id);
  });

  it("refuses shapes from different parents before anything changes", async () => {
    const a = make("ELLIPSE");
    const b = make("RECTANGLE", make("FRAME"));
    const e = await fails(SHAPE_OPS.boolean_nodes!.run(run({ nodeIds: [a.id, b.id], operation: "union" })));
    expect(e.partial).toEqual({ created: [] });
    expect(calls).toHaveLength(0);
  });

  it("flattens and masks", async () => {
    const a = make("STAR");
    await SHAPE_OPS.flatten_nodes!.run(run({ nodeIds: [a.id] }));
    expect(calls[0]!.fn).toBe("flatten");
    const m = make("ELLIPSE");
    m.isMask = false;
    m.maskType = "ALPHA";
    await SHAPE_OPS.set_mask!.run(run({ nodeId: m.id, maskType: "vector" }));
    expect([m.isMask, m.maskType]).toEqual([true, "VECTOR"]);
  });
});

describe("set_layout_grids", () => {
  it("turns the friendly shape into Figma's LayoutGrid", () => {
    expect(toLayoutGrid({ pattern: "columns", count: 12, gutter: 24, margin: 80 }, 0)).toEqual({
      pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 24, offset: 80,
    });
    expect(toLayoutGrid({ pattern: "grid", sectionSize: 8, color: "#ff000033" }, 0)).toMatchObject({
      pattern: "GRID", sectionSize: 8, color: { r: 1, g: 0, b: 0 },
    });
    expect(() => toLayoutGrid({ pattern: "columns", count: 4, alignment: "center" }, 0)).toThrow(/sectionSize/);
  });

  it("applies per node and reports a node that has no grids", async () => {
    const f = make("FRAME");
    f.layoutGrids = [];
    const t = make("TEXT");
    const r = (await SHAPE_OPS.set_layout_grids!.run(run({ nodeIds: [f.id, t.id], grids: [{ pattern: "rows", count: 3 }] }))) as { updated: number; items: Array<{ ok: boolean }> };
    expect(r.updated).toBe(1);
    expect((f.layoutGrids as Array<{ pattern: string }>)[0]!.pattern).toBe("ROWS");
    expect(r.items[1]!.ok).toBe(false);
  });
});

// ── components ───────────────────────────────────────────────────────────────

describe("variants and component properties", () => {
  it("combines components of one parent into a laid-out set", async () => {
    const a = make("COMPONENT");
    a.name = "Size=Small";
    const b = make("COMPONENT");
    b.name = "Size=Large";
    const r = (await COMPONENT_OPS.combine_as_variants!.run(run({ componentIds: [a.id, b.id], name: "Button" }))) as { id: string; properties: Record<string, unknown> };
    const set = byId.get(r.id)!;
    expect(set.name).toBe("Button");
    expect([set.layoutMode, set.layoutWrap]).toEqual(["HORIZONTAL", "WRAP"]);
    expect(r.properties).toEqual({ Size: ["Small", "Large"] });
  });

  it("adds a TEXT property and wires the label to it", async () => {
    const comp = make("COMPONENT");
    const label = make("TEXT", comp);
    comp.addComponentProperty = (name: string, type: string, def: unknown) => {
      comp.lastProperty = { name, type, def };
      return `${name}#12:0`;
    };
    const r = (await COMPONENT_OPS.add_component_property!.run(run({ componentId: comp.id, name: "Label", type: "TEXT", defaultValue: "Buy", bindNodeIds: [label.id] }))) as { key: string };
    expect(r.key).toBe("Label#12:0");
    expect(label.componentPropertyReferences).toEqual({ characters: "Label#12:0" });
  });

  it("on a set, binds the same-named layer in every variant and reports a variant that has none", async () => {
    const set = make("COMPONENT_SET");
    const primary = make("COMPONENT", set);
    primary.name = "Variant=Primary";
    const p = make("TEXT", primary);
    p.name = "Label";
    const secondary = make("COMPONENT", set);
    secondary.name = "Variant=Secondary";
    const s = make("TEXT", secondary);
    s.name = "Label";
    const ghost = make("COMPONENT", set);
    ghost.name = "Variant=Ghost";
    make("TEXT", ghost).name = "Caption";
    set.addComponentProperty = (name: string) => `${name}#22:0`;
    const r = (await COMPONENT_OPS.add_component_property!.run(run({ componentId: set.id, name: "Label", type: "TEXT", defaultValue: "Button", bindNodeIds: [p.id] }))) as {
      bound: string[];
      unmatched?: Array<{ variant: string; path: string }>;
    };
    expect(r.bound).toEqual([p.id, s.id]);
    expect(s.componentPropertyReferences).toEqual({ characters: "Label#22:0" });
    expect(r.unmatched).toEqual([{ variant: "Variant=Ghost", path: "Label" }]);
  });

  it("refuses to bind a layer that is not inside the component", async () => {
    const comp = make("COMPONENT");
    comp.addComponentProperty = () => "X#1:0";
    const outside = make("TEXT");
    await expect(COMPONENT_OPS.add_component_property!.run(run({ componentId: comp.id, name: "Label", type: "TEXT", defaultValue: "a", bindNodeIds: [outside.id] }))).rejects.toThrow(/not inside/);
  });

  it("sets instance properties by plain name, with booleans as booleans", async () => {
    const inst = make("INSTANCE");
    inst.componentProperties = { "Label#12:0": { type: "TEXT", value: "Buy" }, "Show icon#3:1": { type: "BOOLEAN", value: true }, Size: { type: "VARIANT", value: "Small" } };
    inst.setProperties = (p: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(p)) (inst.componentProperties as Record<string, { value: unknown }>)[k]!.value = v;
    };
    const r = (await COMPONENT_OPS.set_instance_properties!.run(run({ nodeId: inst.id, properties: '{"Label":"Buy now","Show icon":"false","Size":"Large"}' }))) as { properties: Record<string, unknown> };
    expect(r.properties).toEqual({ "Label#12:0": "Buy now", "Show icon#3:1": false, Size: "Large" });
    await expect(COMPONENT_OPS.set_instance_properties!.run(run({ nodeId: inst.id, properties: '{"Colour":"red"}' }))).rejects.toThrow(/no property "Colour"/);
  });

  it("resolvePropertyKey never guesses between two same-named properties", () => {
    expect(resolvePropertyKey({ "Label#1:0": { type: "TEXT" }, "Label#2:0": { type: "TEXT" } }, "Label")).toBeUndefined();
  });
});

// ── create_from_spec builds whole sections ───────────────────────────────────

describe("create_from_spec — shapes, icons and images in one call", () => {
  const build = (spec: unknown) => CREATE_OPS.create_from_spec!.run(run({ spec })) as Promise<{ rootId: string; created: Array<{ id: string; path: string }> }>;

  it("builds a section with a star, polygon, line, vector, svg icon and image", async () => {
    const r = await build({
      type: "frame", name: "Hero", layout: "vertical", gap: 16, children: [
        { type: "star", name: "Badge", width: 40, height: 40, pointCount: 8, innerRadius: 0.7, fill: "#ffcc00" },
        { type: "polygon", width: 30, height: 30, pointCount: 6 },
        { type: "line", width: 200, cap: "arrow", color: "#333333" },
        { type: "vector", name: "Wave", path: "M0 0 C40 20 80 -20 120 0", width: 120 },
        { type: "svg", svg: '<svg width="24" height="24"></svg>', width: 48, color: "#ff0000" },
        { type: "image", url: "https://example.com/photo.png", width: 320, height: 200, scaleMode: "fit" },
      ],
    });
    const hero = byId.get(r.rootId)!;
    expect(hero.children.map((c) => c.type)).toEqual(["STAR", "POLYGON", "LINE", "VECTOR", "FRAME", "RECTANGLE"]);
    const [star, , line, , icon, image] = hero.children;
    expect([star!.pointCount, star!.innerRadius]).toEqual([8, 0.7]);
    expect([line!.width, line!.height, line!.strokeCap]).toEqual([200, 0, "ARROW_LINES"]);
    expect(icon!.name).toBe("Icon");
    expect(icon!.width).toBe(48);
    expect(image!.fills).toEqual([{ type: "IMAGE", imageHash: "hash-of-https://example.com/photo.png", scaleMode: "FIT" }]);
    expect(r.created).toHaveLength(7);
  });

  it("an unreachable image fails the call before anything is built", async () => {
    const e = await fails(build({ type: "frame", children: [{ type: "text", content: "Hi" }, { type: "image", url: "https://example.com/broken.png" }] }));
    expect(e.partial).toMatchObject({ created: [] });
    expect(page.children).toHaveLength(0);
  });

  it("a shape cannot take children, and says so before building", async () => {
    const e = await fails(build({ type: "frame", children: [{ type: "star", children: [{ type: "text", content: "x" }] }] }));
    expect(e.message).toMatch(/"star" .* cannot take `children`/);
    expect(page.children).toHaveLength(0);
  });
});

// ── fixes ────────────────────────────────────────────────────────────────────

describe("figma_status names the stale side [C-084]", () => {
  it("a fresh plugin and a server started before the rebuild → restart the client, not the plugin", () => {
    expect(checkBuild("b0695035d64f", "703f7322f7ce", "b0695035d64f")).toMatchObject({ matches: true, restart: "client" });
  });
  it("an old plugin → re-run the plugin", () => {
    expect(checkBuild("703f7322f7ce", "b0695035d64f", "b0695035d64f")).toMatchObject({ matches: false, restart: "plugin" });
  });
  it("all current → no restart at all", () => {
    expect(checkBuild("b0695035d64f", "b0695035d64f", "b0695035d64f").restart).toBeUndefined();
  });
  it("a plugin without a build id → unknown, never a guess", () => {
    expect(checkBuild(undefined, "b0695035d64f", "b0695035d64f")).toMatchObject({ matches: null });
  });
});

describe("check_layout `covered`", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const ctx = { yieldToHost: async () => {}, isCancelled: () => false };

  it("reports the area of the TEXT that is hidden, not the size of the covering layer", async () => {
    const root = Object.assign(new N("FRAME"), { absoluteBoundingBox: box(0, 0, 1000, 400) });
    const text = Object.assign(new N("TEXT"), { characters: "Studio Kumo", absoluteBoundingBox: box(100, 100, 200, 20), absoluteRenderBounds: box(100, 100, 200, 20) });
    const bubble = Object.assign(new N("FRAME"), { name: "Bubble", absoluteBoundingBox: box(250, 50, 400, 300), fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] });
    root.appendChild(text);
    root.appendChild(bubble);
    const r = await checkLayout(root as never, 100, ctx);
    const issue = r.issues.find((i) => i.kind === "covered")!;
    expect(issue.detail).toMatch(/hides 1000 px² of it \(25% of the text\)/); // 50 x 20, not 400 x 300
  });

  it("a layer cut off by a clipping parent counts only where it is visible", async () => {
    const root = Object.assign(new N("FRAME"), { absoluteBoundingBox: box(0, 0, 1000, 400) });
    const text = Object.assign(new N("TEXT"), { characters: "Caption", absoluteBoundingBox: box(420, 100, 200, 20), absoluteRenderBounds: box(420, 100, 200, 20) });
    const card = Object.assign(new N("FRAME"), { name: "Card", clipsContent: true, absoluteBoundingBox: box(0, 0, 400, 400) });
    // A photo cropped by its card: its box runs 300 px past the card's right edge.
    const photo = Object.assign(new N("RECTANGLE"), { name: "Photo", absoluteBoundingBox: box(0, 0, 700, 300), fills: [{ type: "IMAGE" }] });
    root.appendChild(text);
    root.appendChild(card);
    card.appendChild(photo);
    const r = await checkLayout(root as never, 100, ctx);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });
});

describe("set_text reports a lost underline too", () => {
  it("decoration is part of a run", async () => {
    const t = make("TEXT");
    Object.assign(t, {
      characters: "Read the docs",
      fontName: { family: "Inter", style: "Regular" },
      getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
      getStyledTextSegments: () => [
        { start: 0, end: 9, fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: [], textDecoration: "NONE" },
        { start: 9, end: 13, fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: [], textDecoration: "UNDERLINE" },
      ],
    });
    const r = (await MODIFY_OPS.set_text!.run(run({ nodeId: t.id, content: "Read more" }))) as { flattened?: { runs: Array<{ decoration?: string }> } };
    expect(r.flattened?.runs.map((x) => x.decoration)).toEqual([undefined, "UNDERLINE"]);
  });
});
