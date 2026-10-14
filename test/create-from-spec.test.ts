// figma_create_from_spec against a fake `figma` — the contract tools.md
// promises and the 2026-10-07 audit found broken:
//   - a mid-way failure reports partial.created (ids) and partial.failedAt;
//   - nothing the call made is left on the canvas unreported — Figma places a
//     node on the page the moment it is created, so the report must too;
//   - a structurally invalid spec fails before anything is created, says so
//     (created: []), and does not pin its idempotencyKey.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { changedNothing, IdempotencyStore } from "../src/plugin/idempotency.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { letterSpacing, lineHeight } from "../src/plugin/dialect.js";

let nextId = 1;

class FakeNode {
  id = `9:${nextId++}`;
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

interface Fake {
  page: FakeNode;
  failFonts: boolean;
  all(): FakeNode[];
}

function installFakeFigma(): Fake {
  const page = new FakeNode("PAGE");
  const state: Fake = {
    page,
    failFonts: false,
    all() {
      const out: FakeNode[] = [];
      const walk = (n: FakeNode) => n.children.forEach((c) => (out.push(c), walk(c)));
      walk(page);
      return out;
    },
  };
  // Like Figma: a new node lands on the current page immediately.
  const make = (type: string) => () => {
    const n = new FakeNode(type);
    // Like Figma: createFrame() starts with a white fill.
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
    createEllipse: make("ELLIPSE"),
    createSection: make("SECTION"),
    async loadFontAsync(font: { family: string; style: string }) {
      if (state.failFonts) throw new Error(`font ${font.family} ${font.style} is not available`);
    },
    async listAvailableFontsAsync() {
      return [];
    },
    async getNodeByIdAsync(id: string) {
      return state.all().find((n) => n.id === id) ?? null;
    },
    commitUndo() {},
  };
  return state;
}

function ctx(params: Record<string, unknown>): OpContext {
  return { requestId: "r-1", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false };
}

async function failure(params: Record<string, unknown>): Promise<BridgeError> {
  try {
    await CREATE_OPS.create_from_spec!.run(ctx(params));
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected create_from_spec to fail");
}

let fake: Fake;
beforeEach(() => {
  fake = installFakeFigma();
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const tree = {
  type: "frame",
  name: "Hero",
  layout: "vertical",
  children: [
    { type: "text", name: "Title", content: "Hello" },
    { type: "rectangle", name: "Box", width: 40, height: 20 },
  ],
};

describe("create_from_spec builds and reports", () => {
  it("returns the root first and every node with its spec path", async () => {
    const out = (await CREATE_OPS.create_from_spec!.run(ctx({ spec: tree }))) as {
      rootId: string;
      nodeCount: number;
      created: { id: string; name: string; path: string }[];
    };
    expect(out.nodeCount).toBe(3);
    expect(out.created[0]).toMatchObject({ id: out.rootId, name: "Hero", path: "spec" });
    expect(out.created.map((c) => c.path)).toEqual(["spec", "spec.children[0]", "spec.children[1]"]);
    expect(out.created.map((c) => c.name)).toEqual(["Hero", "Title", "Box"]);
    // The tree is assembled: one root on the page, two children under it.
    expect(fake.page.children.map((n) => n.id)).toEqual([out.rootId]);
    expect(fake.page.children[0]!.children).toHaveLength(2);
  });

  it("accepts the spec as a JSON string too", async () => {
    const out = (await CREATE_OPS.create_from_spec!.run(ctx({ spec: JSON.stringify(tree) }))) as { nodeCount: number };
    expect(out.nodeCount).toBe(3);
  });
});

describe("create_from_spec failures leave nothing unreported", () => {
  it("a structurally invalid spec fails before anything is created", async () => {
    const err = await failure({
      spec: { type: "frame", children: [{ type: "frame", children: [{ type: "triangle" }] }] },
    });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/Unknown spec type "triangle" at spec\.children\[0\]\.children\[0\]/);
    expect(err.partial).toEqual({ created: [], failedAt: "spec" });
    expect(err.hint).toMatch(/Nothing was created/);
    expect(fake.all()).toHaveLength(0);
  });

  it("a component inside a component is refused up front, not after building a frame", async () => {
    const err = await failure({ spec: { type: "component", children: [{ type: "component" }] } });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/inside another component/);
    expect(fake.all()).toHaveLength(0);
  });

  it("everything a build would trip over is checked before the first node", async () => {
    for (const spec of [
      { type: "frame", layout: "diagonal" },
      { type: "frame", layout: "vertical", alignX: "space-between" }, // across a vertical stack
      { type: "frame", alignX: "center" }, // no auto-layout
      { type: "frame", padding: "1,2,3" },
      { type: "frame", children: [{ type: "rectangle", fill: "#nothex" }] },
      { type: "frame", style: { shadow: "Elevation" } },
      { type: "instance", componentId: "1:2", children: [{ type: "text" }] },
    ]) {
      const err = await failure({ spec });
      expect(err.partial).toMatchObject({ created: [] });
    }
    expect(fake.all()).toHaveLength(0);
  });

  it("a mid-way failure reports every node already on the canvas, and where it stopped", async () => {
    fake.failFonts = true; // the text child at children[1] cannot get a font
    const err = await failure({
      spec: {
        type: "frame",
        name: "Card",
        children: [
          { type: "rectangle", name: "Image", width: 10, height: 10 },
          { type: "text", content: "Caption" },
          { type: "rectangle", name: "Never built" },
        ],
      },
    });
    const partial = err.partial as { created: { id: string; path: string }[]; failedAt: string };
    expect(partial.failedAt).toBe("spec.children[1]");
    expect(partial.created.map((c) => c.path)).toEqual(["spec", "spec.children[0]"]);
    // The audit's real bug: the root frame used to be left on the page, unreported.
    const onCanvas = fake.all().map((n) => n.id).sort();
    expect(partial.created.map((c) => c.id).sort()).toEqual(onCanvas);
    expect(err.hint).toMatch(/2 node\(s\) were created/);
  });
});

describe("idempotency: only work that happened pins the key", () => {
  it("changedNothing is true only for an explicit created: []", () => {
    const err = { code: "INVALID_PARAM", message: "x" };
    expect(changedNothing({ ok: false, error: err, partial: { created: [], failedAt: "spec" } })).toBe(true);
    expect(changedNothing({ ok: false, error: err, partial: { created: [{ id: "1:2" }], failedAt: "spec" } })).toBe(false);
    expect(changedNothing({ ok: false, error: err })).toBe(false); // unknown → treated as applied
    expect(changedNothing({ ok: true, data: {} })).toBe(false);
  });

  it("abandon frees the key and still answers everyone who attached", () => {
    const s = new IdempotencyStore();
    s.begin("k", "create_from_spec", "r-1");
    s.begin("k", "create_from_spec", "r-2");
    expect(s.abandon("k")).toEqual(["r-1", "r-2"]);
    expect(s.begin("k", "create_from_spec", "r-3")).toEqual({ kind: "execute" });
  });
});

// Found live on 2026-10-07 by looking at an export: a nested layout frame with
// no `background` kept createFrame()'s white fill and painted a white box
// behind its children.
describe("frames without a background", () => {
  const fillsOf = (id: string) => fake.all().find((n) => n.id === id)!.fills;
  const spec = { type: "frame", name: "Card", background: "#101014", children: [{ type: "frame", name: "Row", children: [] }] };

  it("a nested frame is transparent; an explicit background still wins", async () => {
    const out = (await CREATE_OPS.create_from_spec!.run(ctx({ spec }))) as { created: { id: string }[] };
    expect(fillsOf(out.created[1]!.id)).toEqual([]);
    expect(fillsOf(out.created[0]!.id)).toHaveLength(1);
  });

  it("a root on the page keeps Figma's white, like a frame drawn in the editor", async () => {
    const out = (await CREATE_OPS.create_from_spec!.run(ctx({ spec: { type: "frame", name: "Screen" } }))) as { rootId: string };
    expect(fillsOf(out.rootId)).toEqual([{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]);
  });

  it("a root placed inside a frame (parentId) is nested too", async () => {
    const host = (await CREATE_OPS.create_from_spec!.run(ctx({ spec: { type: "frame", name: "Host" } }))) as { rootId: string };
    const out = (await CREATE_OPS.create_from_spec!.run(ctx({ spec: { type: "frame" }, parentId: host.rootId }))) as { rootId: string };
    expect(fillsOf(out.rootId)).toEqual([]);
  });

  it("create_frame follows the same rule", async () => {
    const host = (await CREATE_OPS.create_frame!.run(ctx({ name: "Host" }))) as { id: string };
    const inner = (await CREATE_OPS.create_frame!.run(ctx({ parentId: host.id }))) as { id: string };
    expect(fillsOf(host.id)).toHaveLength(1);
    expect(fillsOf(inner.id)).toEqual([]);
  });
});

// The single-node creates made the node first and checked parentId, colour and
// font afterwards: a failed check left an unreported node on the canvas.
describe("single-node creates fail before anything exists", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["create_frame", { parentId: "404:404" }],
    ["create_frame", { background: "not-a-colour" }],
    ["create_text", { content: "Hi", parentId: "404:404" }],
    ["create_text", { content: "Hi", color: "nope" }],
    ["create_rectangle", { width: 10, height: 10, parentId: "404:404" }],
    ["create_ellipse", { width: 10, height: 10, fill: "nope" }],
  ];
  it.each(cases)("%s %j leaves the canvas empty and says created: []", async (op, params) => {
    let err: BridgeError | undefined;
    try {
      await CREATE_OPS[op]!.run(ctx(params));
    } catch (e) {
      err = e as BridgeError;
    }
    expect(err).toBeInstanceOf(BridgeError);
    expect(fake.all()).toEqual([]);
    expect(err!.partial).toEqual({ created: [] });
  });

  it("a font that cannot load leaves no text node behind", async () => {
    fake.failFonts = true;
    await expect(CREATE_OPS.create_text!.run(ctx({ content: "Hi" }))).rejects.toBeTruthy();
    expect(fake.all()).toEqual([]);
  });
});

// ── the spec grammar: strict fields, layout, modes, instances, icons ────────
//
// A key a type does not read used to be dropped silently (G-22); the root's
// `sizing: fill` and its x/y under a plain frame were dropped too. The new
// grammar — absolute children, wrapping rows, variable modes, instance
// properties and library keys, icon colour variables — is all resolved before
// the first node exists, so every refusal below leaves the canvas as it was.

/** Frames with the auto-layout surface the real API has (typings 1.141.0). */
function layoutFrames(): void {
  const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
  f.createFrame = () => {
    const n = new FakeNode("FRAME");
    Object.assign(n, {
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], layoutMode: "NONE", itemSpacing: 0, layoutWrap: "NO_WRAP",
      counterAxisSpacing: 0, counterAxisAlignContent: "AUTO", clipsContent: true, layoutPositioning: "AUTO",
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    });
    n.setExplicitVariableModeForCollection = function (this: FakeNode, c: unknown, m: string) {
      this.modes = [...((this.modes as unknown[] | undefined) ?? []), [c, m]];
    };
    fake.page.appendChild(n);
    return n;
  };
  f.createText = () => {
    const n = new FakeNode("TEXT");
    Object.assign(n, { layoutPositioning: "AUTO", textAutoResize: "WIDTH_AND_HEIGHT" });
    fake.page.appendChild(n);
    return n;
  };
}

/** findAll over a node's descendants, as the Plugin API has it. */
function searchable(n: FakeNode): FakeNode {
  n.findAll = (pred: (x: FakeNode) => boolean) => {
    const out: FakeNode[] = [];
    const walk = (x: FakeNode) => x.children.forEach((c) => (pred(c) && out.push(c), walk(c)));
    walk(n);
    return out;
  };
  return n;
}

const run = (params: Record<string, unknown>) => CREATE_OPS.create_from_spec!.run(ctx(params)) as Promise<{
  rootId: string; created: Array<{ id: string; path: string; ignored?: string[] }>;
}>;
const node = (id: string) => fake.all().find((n) => n.id === id)!;

describe("spec fields are strict per type", () => {
  it("an unknown key is refused with the nearest valid one, naming its node, and nothing is built", async () => {
    const err = await failure({ spec: { type: "frame", layout: "horizontal", children: [{ type: "frame", wrapp: true }] } });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/`spec\.children\[0\]\.wrapp` is not a field of a frame/);
    expect(err.hint).toMatch(/Did you mean: wrap/);
    expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(fake.all()).toHaveLength(0);
  });

  it("a field another type reads is still refused here: `fill` would recolour a text, `layout` does nothing on a section", async () => {
    for (const spec of [
      { type: "text", content: "Hi", fill: "#ff0000" }, { type: "section", layout: "vertical" }, { type: "line", width: 10, height: 4 },
      { type: "text", content: "Hi", height: 40 },
    ]) {
      expect((await failure({ spec })).message).toMatch(/is not a field of a/);
    }
    expect(fake.all()).toHaveLength(0);
  });
});

describe("the root's relation to its parent", () => {
  it("x/y are honoured under a frame without auto-layout (the old test read the string \"NONE\" as auto-layout)", async () => {
    layoutFrames();
    const host = (await CREATE_OPS.create_frame!.run(ctx({ name: "Plain" }))) as { id: string };
    const r = await run({ spec: { type: "frame", name: "Badge", x: 40, y: 30 }, parentId: host.id });
    expect([node(r.rootId).x, node(r.rootId).y]).toEqual([40, 30]);
  });

  it("sizing fill on the root fills the auto-layout it lands in", async () => {
    layoutFrames();
    const host = (await CREATE_OPS.create_frame!.run(ctx({ layout: "vertical", width: 800 }))) as { id: string };
    const r = await run({ spec: { type: "frame", name: "Section", layout: "vertical", sizing: { width: "fill" } }, parentId: host.id });
    expect(node(r.rootId).layoutSizingHorizontal).toBe("FILL");
  });

  it("fill or absolute on a root whose parent has no auto-layout is refused before anything exists", async () => {
    layoutFrames();
    for (const spec of [{ type: "frame", sizing: "fill" }, { type: "frame", positioning: "absolute" }]) {
      const err = await failure({ spec });
      expect(err.partial).toEqual({ created: [], failedAt: "spec" });
    }
    expect(fake.all()).toHaveLength(0);
  });
});

describe("absolute children and wrapping rows [C-095]", () => {
  it("an absolute child leaves the flow and is placed by x/y", async () => {
    layoutFrames();
    const r = await run({ spec: { type: "frame", layout: "vertical", children: [{ type: "text", content: "NEW", positioning: "absolute", x: 200, y: -8 }] } });
    const badge = node(r.created[1]!.id);
    expect(badge).toMatchObject({ layoutPositioning: "ABSOLUTE", x: 200, y: -8 });
    expect(badge.layoutAlign).toBeUndefined(); // not stretched into a flow it is not in
  });

  it("absolute is refused without an auto-layout parent, and together with fill", async () => {
    layoutFrames();
    for (const child of [{ type: "frame", positioning: "absolute" }, { type: "frame", positioning: "absolute", sizing: { width: "fill" } }]) {
      const spec = { type: "frame", layout: "sizing" in child ? "vertical" : "none", children: [child] };
      expect((await failure({ spec })).partial).toMatchObject({ created: [] });
    }
    expect(fake.all()).toHaveLength(0);
  });

  it("wrap spaces rows by rowGap, or by the gap when no rowGap is given", async () => {
    layoutFrames();
    const a = await run({ spec: { type: "frame", layout: "horizontal", wrap: true, gap: 8, rowGap: 12, alignContent: "space-between" } });
    expect(node(a.rootId)).toMatchObject({ layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 12, counterAxisAlignContent: "SPACE_BETWEEN" });
    const b = await run({ spec: { type: "frame", layout: "horizontal", wrap: true, gap: 8 } });
    expect(node(b.rootId).counterAxisSpacing).toBe(8);
  });

  it("wrap needs a row, and rowGap needs wrap", async () => {
    for (const spec of [{ type: "frame", layout: "vertical", wrap: true }, { type: "frame", layout: "horizontal", rowGap: 4 }]) {
      expect((await failure({ spec })).partial).toMatchObject({ created: [] });
    }
  });

  it("alignY baseline works in a row", async () => {
    layoutFrames();
    const r = await run({ spec: { type: "frame", layout: "horizontal", alignY: "baseline" } });
    expect(node(r.rootId).counterAxisAlignItems).toBe("BASELINE");
  });
});

describe("variableModes [C-105]", () => {
  const theme = { id: "VariableCollectionId:1:1", name: "Theme", modes: [{ modeId: "1:0", name: "Light" }, { modeId: "1:1", name: "Dark" }] };
  const install = () => {
    layoutFrames();
    Object.assign((globalThis as unknown as { figma: Record<string, unknown> }).figma, {
      variables: {
        getLocalVariableCollectionsAsync: async () => [theme],
        getVariableCollectionByIdAsync: async (id: string) => (id === theme.id ? theme : null),
      },
      createComponentFromNode: (n: FakeNode) => {
        const c = new FakeNode("COMPONENT");
        c.setExplicitVariableModeForCollection = n.setExplicitVariableModeForCollection;
        for (const k of [...n.children]) c.appendChild(k);
        (n.parent ?? fake.page).appendChild(c);
        n.remove();
        return c;
      },
    });
  };

  it("pins the mode through the collection OBJECT — the id overload throws under dynamic-page", async () => {
    install();
    const r = await run({ spec: { type: "frame", name: "Dark screen", variableModes: { Theme: "Dark" } } });
    expect(node(r.rootId).modes).toEqual([[theme, "1:1"]]);
    expect((node(r.rootId).modes as unknown[][])[0]![0]).toBe(theme);
  });

  it("a component gets the mode again after the conversion makes it a new node", async () => {
    install();
    const r = await run({ spec: { type: "component", name: "Card", variableModes: { [theme.id]: "1:1" } } });
    expect(node(r.rootId).type).toBe("COMPONENT");
    expect(node(r.rootId).modes).toEqual([[theme, "1:1"]]);
  });

  it("an unknown collection or mode is refused before anything exists, naming the modes there are", async () => {
    install();
    const err = await failure({ spec: { type: "frame", children: [{ type: "frame", variableModes: { Theme: "Dusk" } }] } });
    expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(err.hint).toMatch(/Light \(1:0\), Dark \(1:1\)/);
    expect((await failure({ spec: { type: "frame", variableModes: { Brand: "Dark" } } })).message).toMatch(/No variable collection named "Brand"/);
    expect(fake.all()).toHaveLength(0);
  });
});

describe("instances: properties, nested instances, variants, library keys [C-110]", () => {
  /** A Button set (Size × Label × Show icon) whose variants hold a nested "Icon" instance. */
  function buttonSet() {
    layoutFrames();
    const calls: Array<{ id: string; props: Record<string, unknown> }> = [];
    const instanceOf = (main: FakeNode, ignore: string[] = []) => {
      const inst = searchable(new FakeNode("INSTANCE"));
      inst.mainComponent = main;
      inst.componentProperties = {} as Record<string, { value: unknown }>;
      inst.setProperties = (p: Record<string, unknown>) => {
        calls.push({ id: inst.id, props: p });
        for (const [k, v] of Object.entries(p)) if (!ignore.includes(k)) (inst.componentProperties as Record<string, { value: unknown }>)[k] = { value: v };
      };
      for (const k of Object.keys((main.parent?.type === "COMPONENT_SET" ? main.parent : main).componentPropertyDefinitions as object)) {
        (inst.componentProperties as Record<string, { value: unknown }>)[k] = { value: "" };
      }
      return inst;
    };
    const glyph = new FakeNode("COMPONENT");
    glyph.componentPropertyDefinitions = { "Color#9:9": { type: "TEXT" } };
    fake.page.appendChild(glyph);
    const set = new FakeNode("COMPONENT_SET");
    set.name = "Button";
    set.componentPropertyDefinitions = {
      Size: { type: "VARIANT", variantOptions: ["Small", "Large"] },
      "Label#1:2": { type: "TEXT" },
      "Show icon#1:3": { type: "BOOLEAN" },
      "Slot#1:4": { type: "SLOT" },
    };
    fake.page.appendChild(set);
    const variants = ["Size=Small", "Size=Large"].map((name) => {
      const v = searchable(new FakeNode("COMPONENT"));
      v.name = name;
      // Reading definitions on a variant throws in Figma: the set holds them.
      Object.defineProperty(v, "componentPropertyDefinitions", { get: () => { throw new Error("Can only get definitions of a component set"); } });
      const icon = new FakeNode("INSTANCE");
      icon.name = "Icon";
      icon.getMainComponentAsync = async () => glyph;
      v.appendChild(icon);
      v.createInstance = () => {
        const inst = instanceOf(v, ["Label#1:2"].filter(() => ignoreLabel));
        const nestedIcon = instanceOf(glyph);
        nestedIcon.name = "Icon";
        inst.appendChild(nestedIcon);
        fake.page.appendChild(inst);
        return inst;
      };
      set.appendChild(v);
      return v;
    });
    set.defaultVariant = variants[0];
    let ignoreLabel = false;
    return { set, variants, glyph, calls, ignoreLabel: () => (ignoreLabel = true) };
  }

  it("one call: the variant picked by name, its properties and a nested instance's set right after it exists", async () => {
    const w = buttonSet();
    const r = await run({
      spec: { type: "frame", layout: "horizontal", children: [{
        type: "instance", componentId: w.set.id, variant: "Size=Large",
        properties: { Label: "Buy now", "Show icon": "false" }, nested: { Icon: { Color: "red" } },
      }] },
    });
    const inst = node(r.created[1]!.id);
    expect(inst.mainComponent).toBe(w.variants[1]);
    expect(w.calls).toEqual([
      { id: inst.id, props: { "Label#1:2": "Buy now", "Show icon#1:3": false } },
      { id: inst.children[0]!.id, props: { "Color#9:9": "red" } },
    ]);
    expect(r.created[1]!.ignored).toBeUndefined();
  });

  it("a width on an instance resizes it — it was read by nothing before", async () => {
    const w = buttonSet();
    const r = await run({ spec: { type: "instance", componentId: w.set.id, width: 240 } });
    expect([node(r.rootId).width, node(r.rootId).height]).toEqual([240, 100]); // the height it had is kept
  });

  it("a property Figma takes without changing is reported as ignored", async () => {
    const w = buttonSet();
    w.ignoreLabel();
    const r = await run({ spec: { type: "instance", componentId: w.set.id, properties: { Label: "Buy now" } } });
    expect(r.created[0]!.ignored).toEqual(["Label#1:2"]);
  });

  it("a bad property, value, variant or nested name is refused before any node exists", async () => {
    const w = buttonSet();
    const before = fake.all().length;
    const bad = [
      [{ properties: { Lable: "x" } }, /no property "Lable"[\s\S]*/],
      [{ properties: { Size: "Huge" } }, /must be one of: Small, Large/],
      [{ properties: { "Show icon": "maybe" } }, /BOOLEAN/],
      [{ properties: { Slot: "x" } }, /is a SLOT/],
      [{ variant: "Size=Huge" }, /matches no variant/],
      [{ nested: { Badge: { Color: "red" } } }, /no nested instance named "Badge"/],
    ] as const;
    for (const [extra, message] of bad) {
      const err = await failure({ spec: { type: "frame", children: [{ type: "instance", componentId: w.set.id, ...extra }] } });
      expect(err.message).toMatch(message);
      expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    }
    expect(err0(await failure({ spec: { type: "instance", componentId: w.set.id, properties: { Lable: "x" } } }))).toMatch(/Label#1:2 \(TEXT\)/);
    expect(fake.all()).toHaveLength(before);
  });

  it("componentKey imports a published component first; without the API the refusal names it", async () => {
    const w = buttonSet();
    const keys: string[] = [];
    Object.assign((globalThis as unknown as { figma: Record<string, unknown> }).figma, {
      importComponentByKeyAsync: async (key: string) => (keys.push(key), w.glyph),
    });
    w.glyph.createInstance = () => {
      const i = new FakeNode("INSTANCE");
      fake.page.appendChild(i);
      return i;
    };
    const r = await run({ spec: { type: "instance", componentKey: "abc123" } });
    expect(keys).toEqual(["abc123"]);
    expect(node(r.rootId).type).toBe("INSTANCE");
    delete (globalThis as unknown as { figma: Record<string, unknown> }).figma.importComponentSetByKeyAsync;
    const err = await failure({ spec: { type: "instance", componentSetKey: "def" } });
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/importComponentSetByKeyAsync/);
    expect(err.partial).toMatchObject({ created: [] });
  });

  it("exactly one component source", async () => {
    for (const spec of [{ type: "instance" }, { type: "instance", componentId: "1:2", componentKey: "k" }]) {
      expect((await failure({ spec })).message).toMatch(/exactly one of `componentId`, `componentKey` or `componentSetKey`/);
    }
  });
});

const err0 = (e: BridgeError) => `${e.message} ${e.hint ?? ""}`;

describe("svg colorVariable and the variables/style maps", () => {
  const vars = [
    { id: "VariableID:1:1", name: "icon/fg", resolvedType: "COLOR" },
    { id: "VariableID:1:2", name: "space/2", resolvedType: "FLOAT" },
  ];
  const install = () => {
    layoutFrames();
    Object.assign((globalThis as unknown as { figma: Record<string, unknown> }).figma, {
      variables: {
        getLocalVariablesAsync: async () => vars,
        getVariableByIdAsync: async (id: string) => vars.find((v) => v.id === id) ?? null,
        setBoundVariableForPaint: (paint: Record<string, unknown>, field: string, v: { id: string }) => ({
          ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: v.id } },
        }),
      },
      createNodeFromSvg: () => {
        const f = new FakeNode("FRAME");
        Object.assign(f, { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], clipsContent: true });
        const v = new FakeNode("VECTOR");
        Object.assign(v, { fills: [], strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] });
        f.appendChild(v);
        fake.page.appendChild(f);
        return f;
      },
    });
  };

  it("binds every painted vector to the colour variable — a stroke icon stays a stroke icon", async () => {
    install();
    const r = await run({ spec: { type: "svg", svg: "<svg viewBox=\"0 0 24 24\"></svg>", colorVariable: "icon/fg" } });
    const vector = node(r.rootId).children[0]!;
    expect((vector.strokes as Array<{ boundVariables?: unknown }>)[0]!.boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } });
    expect(vector.fills).toEqual([]);
    expect(node(r.rootId).fills).toEqual([]);
  });

  it("refuses a non-colour variable, colour and colorVariable together, and variables.fill on an svg", async () => {
    install();
    const svg = "<svg viewBox=\"0 0 24 24\"></svg>";
    expect((await failure({ spec: { type: "svg", svg, colorVariable: "space/2" } })).message).toMatch(/FLOAT variable/);
    expect((await failure({ spec: { type: "svg", svg, color: "#000000", colorVariable: "icon/fg" } })).message).toMatch(/not both/);
    expect((await failure({ spec: { type: "svg", svg, variables: { fill: "icon/fg" } } })).hint).toMatch(/colorVariable/);
    expect(fake.all()).toHaveLength(0);
  });

  it("the maps take ids as well as names, and an unknown name now fails before the first node", async () => {
    install();
    const r = await run({ spec: { type: "frame", variables: { fill: "VariableID:1:1" } } });
    expect((node(r.rootId).fills as Array<{ boundVariables?: unknown }>)[0]!.boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } });
    const count = fake.all().length;
    const err = await failure({ spec: { type: "frame", children: [{ type: "frame", variables: { fill: "icon/fgg" } }] } });
    expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(err.hint).toMatch(/Nearest: icon\/fg/);
    expect(fake.all()).toHaveLength(count);
  });
});

// ── a node is reported from the moment it exists ────────────────────────────
//
// The created[] entry used to be pushed only after a node's type-specific
// setup (size, font, alignment, an svg wrapper's fills). A write Figma refused
// there reported `created: []` — "provably nothing changed", a free retry —
// while the node stood on the canvas. Figma refuses a size below 0.01, a text
// alignment outside LEFT | CENTER | RIGHT | JUSTIFIED, and a property a GROUP
// does not have (typings 1.141.0; C-086 for the group).

/** Figma's refusals as the typings state them, on every node the fake makes. */
function strictWrites(): void {
  const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
  for (const key of ["createFrame", "createRectangle", "createEllipse", "createText", "createSection"]) {
    const make = f[key] as () => FakeNode;
    f[key] = () => {
      const n = make();
      n.resize = (w: number, h: number) => {
        if (w < 0.01 || h < 0.01) throw new Error("in resize: Expected width and height to be >= 0.01");
        n.width = w;
        n.height = h;
      };
      if (n.type === "TEXT") {
        let align = "LEFT";
        Object.defineProperty(n, "textAlignHorizontal", {
          get: () => align,
          set: (v: string) => {
            if (!["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(v)) throw new Error(`Invalid enum value "${v}"`);
            align = v;
          },
        });
      }
      return n;
    };
  }
}

describe("a node is reported from the moment it exists", () => {
  it("a write Figma refuses during a node's own setup still reports the node — the root's included", async () => {
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    f.createRectangle = () => {
      const n = new FakeNode("RECTANGLE");
      n.resize = () => {
        throw new Error("Figma refused the size");
      };
      fake.page.appendChild(n);
      return n;
    };
    const err = await failure({ spec: { type: "rectangle", name: "Divider", width: 10, height: 1 } });
    const partial = err.partial as { created: Array<{ id: string; path: string }>; failedAt: string };
    expect(partial.created.map((c) => c.path)).toEqual(["spec"]);
    // Not "nothing was created": the rectangle is on the canvas, so the key stays pinned.
    expect(partial.created.map((c) => c.id)).toEqual(fake.all().map((n) => n.id));
    expect(changedNothing({ ok: false, error: { code: err.code, message: err.message }, partial })).toBe(false);
  });

  it("a text is reported before its font, content or alignment is written", async () => {
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    f.createText = () => {
      const n = new FakeNode("TEXT");
      Object.defineProperty(n, "fontName", { set: () => { throw new Error("font not loaded"); } });
      fake.page.appendChild(n);
      return n;
    };
    const err = await failure({ spec: { type: "frame", children: [{ type: "text", content: "Hi" }] } });
    const partial = err.partial as { created: Array<{ id: string; path: string }>; failedAt: string };
    expect(partial.failedAt).toBe("spec.children[0]");
    expect(partial.created.map((c) => c.path)).toEqual(["spec", "spec.children[0]"]);
    expect(partial.created.map((c) => c.id).sort()).toEqual(fake.all().map((n) => n.id).sort());
  });

  it("an svg that comes back as a GROUP [C-086] is built: a group has no fills or clipping to clear", async () => {
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    f.createNodeFromSvg = () => {
      const g = new FakeNode("GROUP");
      const v = new FakeNode("VECTOR");
      Object.assign(v, { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokes: [] });
      g.appendChild(v);
      fake.page.appendChild(g);
      // Like Figma: assigning a property a GroupNode does not have throws.
      return Object.preventExtensions(g);
    };
    const r = await run({ spec: { type: "svg", svg: "<svg><path d=\"M0 0 L1 1\"/></svg>", color: "#ff0000" } });
    const group = node(r.rootId);
    expect(group.type).toBe("GROUP");
    expect("fills" in group).toBe(false);
    expect(r.created.map((c) => c.id)).toEqual([group.id]);
  });

  it("a size Figma refuses, a font size below 1 and an alignment it does not know are refused before anything exists", async () => {
    strictWrites();
    for (const [spec, message] of [
      [{ type: "rectangle", name: "Divider", width: 0, height: 1 }, /`spec\.width` must be a number >= 0\.01/],
      [{ type: "frame", layout: "vertical", children: [{ type: "frame", height: 0 }] }, /`spec\.children\[0\]\.height` must be a number >= 0\.01/],
      [{ type: "text", content: "Hi", align: "start" }, /`spec\.align` must be left, center, right or justified/],
      [{ type: "text", content: "Hi", fontSize: 0 }, /`spec\.fontSize` must be a number >= 1/],
      [{ type: "text", content: "Hi", fontSize: "16" }, /`spec\.fontSize` must be a number/],
      [{ type: "rectangle", width: 10, height: 10, cornerRadius: -4 }, /`spec\.cornerRadius` must be a number >= 0/],
    ] as const) {
      const err = await failure({ spec });
      expect(err.message).toMatch(message);
      expect(err.partial).toMatchObject({ created: [] });
    }
    expect(fake.all()).toEqual([]);
  });

  it("every text alignment Figma takes still builds, case-insensitively", async () => {
    strictWrites();
    for (const align of ["left", "Center", "right", "justified"]) {
      const r = await run({ spec: { type: "text", content: "Hi", align } });
      expect(node(r.rootId).textAlignHorizontal).toBe(align.toUpperCase());
    }
  });
});

// ── single-node creates never leave an orphan ───────────────────────────────
//
// Each made its node, then resized and appended it outside any guard: a size
// Figma refused or a parent that takes no children left the node at the page
// origin, unreported and never in the parent the agent looks at.

describe("single-node creates never leave an orphan", () => {
  const failing = async (op: string, params: Record<string, unknown>): Promise<BridgeError> => {
    try {
      await CREATE_OPS[op]!.run(ctx(params));
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      return e as BridgeError;
    }
    throw new Error(`expected ${op} to fail`);
  };

  it.each([
    ["create_frame", { width: 0 }],
    ["create_frame", { layout: "vertical", height: 0.001 }],
    ["create_text", { content: "Hi", width: 0 }],
    ["create_text", { content: "Hi", align: "start" }],
    ["create_rectangle", { width: 0, height: 1 }],
    ["create_ellipse", { width: 10, height: 0 }],
    ["create_section", { width: 0 }],
  ] as const)("%s %j is refused before the node exists", async (op, params) => {
    strictWrites();
    const err = await failing(op, params);
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.partial).toEqual({ created: [] });
    expect(fake.all()).toEqual([]);
  });

  it("a hairline rectangle is not refused for being thinner than 1 px", async () => {
    strictWrites();
    const r = (await CREATE_OPS.create_rectangle!.run(ctx({ width: 240, height: 0.5 }))) as { id: string };
    expect([node(r.id).width, node(r.id).height]).toEqual([240, 0.5]);
  });

  it.each([
    ["create_frame", { name: "Row" }],
    ["create_text", { content: "Hi" }],
    ["create_rectangle", { width: 10, height: 10 }],
  ] as const)("%s into a parent that refuses the child removes the node and says nothing changed", async (op, params) => {
    const inst = new FakeNode("INSTANCE");
    inst.appendChild = () => {
      throw new Error("Cannot add children to an instance");
    };
    fake.page.appendChild(inst);
    const err = await failing(op, { ...params, parentId: inst.id });
    expect(err.message).toMatch(/instance/);
    expect(err.partial).toEqual({ created: [] });
    expect(fake.all().map((n) => n.id)).toEqual([inst.id]); // no orphan at the page origin
  });
});

// ── what a spec says is done, or refused ────────────────────────────────────
//
// Fields a node type takes were still dropped when the context gave them no
// effect: x/y on a child an auto-layout places, spacing without a layout, a
// misspelt or impossible sizing, and an explicit hug the auto-stretch of text
// overrode. Each is refused before the first node now.

describe("what a spec says is done, or refused", () => {
  it.each([
    [{ type: "frame", layout: "vertical", children: [{ type: "frame", name: "Dot", width: 12, height: 12, x: 228, y: -6 }] }, "spec.children[0]", /x` is ignored in an auto-layout/, /positioning: "absolute"/],
    [{ type: "frame", gap: 16, children: [] }, "spec", /`spec\.gap` spaces an auto-layout's items/, undefined],
    [{ type: "component", padding: 24 }, "spec", /`spec\.padding` spaces an auto-layout's items/, undefined],
    [{ type: "frame", sizing: "stretch" }, "spec", /`spec\.sizing` must be "fixed", "hug" or "fill"/, undefined],
    [{ type: "frame", layout: "vertical", sizing: { horizontal: "fill" } }, "spec", /`spec\.sizing` must be/, /width and height/],
    [{ type: "frame", children: [{ type: "frame", sizing: { width: "fill" } }] }, "spec.children[0]", /sizing: fill` takes the space of an auto-layout parent/, undefined],
    [{ type: "frame", layout: "vertical", children: [{ type: "rectangle", sizing: "hug" }] }, "spec.children[0]", /hug` works on auto-layout frames and text — this rectangle/, undefined],
    [{ type: "frame", sizing: "hug" }, "spec", /hug` works on auto-layout frames and text — this frame has no layout/, undefined],
  ] as const)("%j is refused at %s", async (spec, failedAt, message, hint) => {
    layoutFrames();
    const err = await failure({ spec });
    expect(err.message).toMatch(message);
    if (hint) expect(err.hint).toMatch(hint);
    expect(err.partial).toEqual({ created: [], failedAt });
    expect(fake.all()).toEqual([]);
  });

  it("the root's x/y under an auto-layout parent is refused too; absolute still places it", async () => {
    layoutFrames();
    const host = (await CREATE_OPS.create_frame!.run(ctx({ layout: "vertical" }))) as { id: string };
    const before = fake.all().length;
    const err = await failure({ spec: { type: "frame", x: 40 }, parentId: host.id });
    expect(err.partial).toEqual({ created: [], failedAt: "spec" });
    expect(fake.all()).toHaveLength(before);
    const r = await run({ spec: { type: "frame", positioning: "absolute", x: 40, y: 8 }, parentId: host.id });
    expect(node(r.rootId)).toMatchObject({ x: 40, y: 8, layoutPositioning: "ABSOLUTE" });
  });

  it("a text that says hug across its column is not stretched; one that says nothing still is", async () => {
    layoutFrames();
    const r = await run({ spec: { type: "frame", layout: "vertical", children: [
      { type: "text", name: "Chip", content: "New", sizing: "hug" },
      { type: "text", name: "Body", content: "Long copy" },
    ] } });
    expect(node(r.created[1]!.id).layoutAlign).toBeUndefined();
    expect(node(r.created[2]!.id).layoutAlign).toBe("STRETCH");
  });

  it("the sizing words are read case-insensitively wherever they act", async () => {
    layoutFrames();
    const r = await run({ spec: { type: "frame", layout: "horizontal", children: [{ type: "frame", name: "Grow", sizing: { width: "Fill" } }] } });
    expect(node(r.created[1]!.id).layoutGrow).toBe(1);
  });
});

// ── the variables and style maps are checked against what they fill ─────────

describe("the variables and style maps are checked against what they fill", () => {
  const vars = [
    { id: "VariableID:1:1", name: "color/bg", resolvedType: "COLOR" },
    { id: "VariableID:1:2", name: "space/4", resolvedType: "FLOAT" },
    { id: "VariableID:1:3", name: "copy/title", resolvedType: "STRING" },
  ];
  const install = () => {
    layoutFrames();
    Object.assign((globalThis as unknown as { figma: Record<string, unknown> }).figma, {
      variables: {
        getLocalVariablesAsync: async () => vars,
        getVariableByIdAsync: async (id: string) => vars.find((v) => v.id === id) ?? null,
        setBoundVariableForPaint: (paint: Record<string, unknown>, field: string, v: { id: string }) => ({ ...paint, boundVariables: { [field]: { id: v.id } } }),
      },
      getStyleByIdAsync: async (id: string) => (id === "S:paint," ? { id, name: "Brand/Blue", type: "PAINT" } : null),
    });
  };

  it.each([
    [{ type: "frame", children: [{ type: "text", content: "Hi", style: { text: "S:paint," } }] }, /`spec\.children\[0\]\.style\.text`: "Brand\/Blue" is a PAINT style; it cannot be applied as text/],
    [{ type: "frame", children: [{ type: "frame", variables: { fill: "space/4" } }] }, /`spec\.children\[0\]\.variables\.fill` takes a COLOR variable; "space\/4" is FLOAT/],
    [{ type: "frame", children: [{ type: "frame", layout: "vertical", variables: { gap: "color/bg" } }] }, /`spec\.children\[0\]\.variables\.gap` takes a FLOAT variable; "color\/bg" is COLOR/],
    [{ type: "frame", children: [{ type: "text", content: "Hi", variables: { characters: "color/bg" } }] }, /takes no COLOR variable/],
  ] as const)("%j fails before the first node", async (spec, message) => {
    install();
    const err = await failure({ spec });
    expect(err.message).toMatch(message);
    expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(fake.all()).toEqual([]);
  });

  it("a misspelt variables key is refused with the nearest field, before the variable is even looked up", async () => {
    install();
    const err = await failure({ spec: { type: "frame", variables: { fil: "color/bg" } } });
    expect(err.message).toMatch(/`spec\.variables\.fil` is not a field a variable binds/);
    expect(err.hint).toMatch(/Did you mean: fill/);
    expect(err.partial).toEqual({ created: [], failedAt: "spec" });
    expect(fake.all()).toEqual([]);
  });

  it("a variable of the type its field takes still binds", async () => {
    install();
    const r = await run({ spec: { type: "frame", variables: { fill: "color/bg" } } });
    expect((node(r.rootId).fills as Array<{ boundVariables?: unknown }>)[0]!.boundVariables).toEqual({ color: { id: "VariableID:1:1" } });
  });
});

// ── pageId ──────────────────────────────────────────────────────────────────
//
// Accepted by the schema and read by nothing: a spec aimed at another page
// was built on the current one, and the call reported success.

describe("pageId", () => {
  const otherPage = () => {
    const other = new FakeNode("PAGE");
    let loaded = false;
    other.loadAsync = async () => void (loaded = true);
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    const byId = f.getNodeByIdAsync as (id: string) => Promise<FakeNode | null>;
    f.getNodeByIdAsync = async (id: string) => (id === other.id ? other : byId(id));
    return { other, loaded: () => loaded };
  };

  it("builds on the page it names, at its top level, after loading it [C-090]", async () => {
    const { other, loaded } = otherPage();
    const r = await run({ spec: { type: "frame", name: "Card" }, pageId: other.id });
    expect(other.children.map((n) => n.id)).toEqual([r.rootId]);
    expect(fake.page.children).toEqual([]);
    expect(loaded()).toBe(true);
  });

  it("refuses pageId with parentId, or naming something that is not a page, before anything exists", async () => {
    const { other } = otherPage();
    const host = (await CREATE_OPS.create_frame!.run(ctx({ name: "Host" }))) as { id: string };
    const before = fake.all().length;
    expect((await failure({ spec: { type: "frame" }, pageId: other.id, parentId: host.id })).partial).toEqual({ created: [], failedAt: "spec" });
    const err = await failure({ spec: { type: "frame" }, pageId: host.id });
    expect(err.message).toMatch(/is a FRAME, not a page/);
    expect(err.partial).toEqual({ created: [], failedAt: "spec" });
    expect(fake.all()).toHaveLength(before);
    expect(other.children).toEqual([]);
  });
});

// ── text lengths ────────────────────────────────────────────────────────────
//
// A spec took lineHeight and letterSpacing only as numbers of px and refused
// "150%", while figma_set_text_properties takes only strings and
// figma_get_design_context reads them back as "32px" or "-1%": an agent could
// not write a value it had read, or the form set_text_properties taught it
// (acceptance run 1, found later). Both create tools now take that grammar, and
// a bare number is px as before.

describe("text lengths take figma_set_text_properties' strings", () => {
  const textAt = (r: { created: Array<{ id: string; path: string }> }, path: string) => node(r.created.find((c) => c.path === path)!.id);

  it.each([
    [{ lineHeight: "150%" }, { lineHeight: { unit: "PERCENT", value: 150 } }],
    [{ lineHeight: "24px" }, { lineHeight: { unit: "PIXELS", value: 24 } }],
    [{ lineHeight: "24" }, { lineHeight: { unit: "PIXELS", value: 24 } }],
    [{ lineHeight: 18 }, { lineHeight: { unit: "PIXELS", value: 18 } }],
    [{ lineHeight: 0 }, { lineHeight: { unit: "PIXELS", value: 0 } }],
    [{ lineHeight: "Auto" }, { lineHeight: { unit: "AUTO" } }],
    [{ letterSpacing: "-2%" }, { letterSpacing: { unit: "PERCENT", value: -2 } }],
    [{ letterSpacing: "0.5px" }, { letterSpacing: { unit: "PIXELS", value: 0.5 } }],
    [{ letterSpacing: 0.6 }, { letterSpacing: { unit: "PIXELS", value: 0.6 } }],
    [{ letterSpacing: -1 }, { letterSpacing: { unit: "PIXELS", value: -1 } }],
  ] as const)("a text child with %j is built with %j", async (fields, expected) => {
    const r = await run({ spec: { type: "frame", layout: "vertical", children: [{ type: "text", content: "Hi", ...fields }] } });
    expect(textAt(r, "spec.children[0]")).toMatchObject(expected);
  });

  it("what figma_get_design_context reads back builds the same lengths", async () => {
    const read = { lineHeight: { unit: "PIXELS", value: 32 }, letterSpacing: { unit: "PERCENT", value: -1 } };
    const fields = { lineHeight: lineHeight(read.lineHeight), letterSpacing: letterSpacing(read.letterSpacing) };
    expect(fields).toEqual({ lineHeight: "32px", letterSpacing: "-1%" });
    const r = await run({ spec: { type: "frame", layout: "vertical", children: [{ type: "text", content: "Title", ...fields }] } });
    expect(textAt(r, "spec.children[0]")).toMatchObject(read);
  });

  it.each([
    [{ lineHeight: "tall" }, /`spec\.children\[0\]\.lineHeight` must be "auto", a number of px \("24"\) or a percent \("150%"\)/],
    [{ lineHeight: -4 }, /`spec\.children\[0\]\.lineHeight` must be "auto" or at least 0/],
    [{ lineHeight: "-10%" }, /`spec\.children\[0\]\.lineHeight` must be "auto" or at least 0/],
    [{ lineHeight: "mixed" }, /`spec\.children\[0\]\.lineHeight` must be "auto"/],
    [{ letterSpacing: "auto" }, /`spec\.children\[0\]\.letterSpacing` must be a number of px/],
    [{ letterSpacing: true }, /`spec\.children\[0\]\.letterSpacing` must be a number of px/],
  ] as const)("a text child with %j is refused before anything exists", async (fields, message) => {
    const err = await failure({ spec: { type: "frame", layout: "vertical", children: [{ type: "text", content: "Hi", ...fields }] } });
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(message);
    expect(err.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(fake.all()).toEqual([]);
  });

  it("a root of an array spec is checked the same way, by its own path", async () => {
    const err = await failure({ spec: [{ type: "text", content: "A", lineHeight: "150%" }, { type: "text", content: "B", lineHeight: "1.5x" }], parentId: "1:1" });
    expect(err.message).toMatch(/`spec\[1\]\.lineHeight` must be/);
    expect(err.partial).toEqual({ created: [], failedAt: "spec[1]" });
    expect(fake.all()).toEqual([]);
  });

  it("a length on a type that is not text is refused by name, as before", async () => {
    expect((await failure({ spec: { type: "frame", lineHeight: "150%" } })).message).toMatch(/`spec\.lineHeight` is not a field of a frame/);
  });

  const createText = (params: Record<string, unknown>) => CREATE_OPS.create_text!.run(ctx(params)) as Promise<{ id: string }>;

  it.each([
    [{ lineHeight: "150%", letterSpacing: "-1%" }, { lineHeight: { unit: "PERCENT", value: 150 }, letterSpacing: { unit: "PERCENT", value: -1 } }],
    // The server hands a bare number over as its string; an older caller still sends the number.
    [{ lineHeight: "24", letterSpacing: "0.5" }, { lineHeight: { unit: "PIXELS", value: 24 }, letterSpacing: { unit: "PIXELS", value: 0.5 } }],
    [{ lineHeight: 24, letterSpacing: 0.5 }, { lineHeight: { unit: "PIXELS", value: 24 }, letterSpacing: { unit: "PIXELS", value: 0.5 } }],
    [{ lineHeight: "auto" }, { lineHeight: { unit: "AUTO" } }],
  ] as const)("figma_create_text with %j sets %j", async (fields, expected) => {
    const r = await createText({ content: "Hi", ...fields });
    expect(node(r.id)).toMatchObject(expected);
  });

  it.each([
    [{ lineHeight: "tall" }, /`lineHeight` must be "auto", a number of px/],
    // figma_create_text's line height was always above 0 (the schema's positive()).
    [{ lineHeight: 0 }, /`lineHeight` must be "auto" or greater than 0/],
    [{ lineHeight: "-1" }, /`lineHeight` must be "auto" or greater than 0/],
    [{ letterSpacing: "auto" }, /`letterSpacing` must be a number of px/],
  ] as const)("figma_create_text with %j is refused before the node exists", async (fields, message) => {
    await expect(createText({ content: "Hi", ...fields })).rejects.toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(message), partial: { created: [] } });
    expect(fake.all()).toEqual([]);
  });
});
