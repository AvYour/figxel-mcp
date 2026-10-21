// Phase 3 ops against a fake `figma` whose API surface follows
// @figma/plugin-typings 1.141.0 — deliberately, after the audit found that the
// earlier fakes had mirrored the code's own wrong assumptions:
//   - createInstance() lives on ComponentNode, not on `figma`;
//   - figma.createComponentFromNode(node) converts, nodes have no createComponent();
//   - variables.createVariable(name, collectionOBJECT, type) — the id form throws
//     under documentAccess "dynamic-page";
//   - setBoundVariable(field, variableOBJECT); paints bind via setBoundVariableForPaint.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { PLUGIN_OPS } from "../src/plugin/ops/index.js";
import { toReaction } from "../src/plugin/ops/style.js";
import { alignmentFor, normalizePadding, parseVariableValue } from "../src/plugin/write.js";

let seq = 1;

class N {
  id: string;
  name: string;
  children: N[] = [];
  parent: N | null = null;
  [k: string]: unknown;
  constructor(readonly type: string, name?: string) {
    this.id = `5:${seq++}`;
    this.name = name ?? type;
  }
  appendChild(c: N) {
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    this.children.push(c);
    c.parent = this;
  }
  insertChild(i: number, c: N) {
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    this.children.splice(i, 0, c);
    c.parent = this;
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function frame(name = "Frame"): N {
  const n = new N("FRAME", name);
  Object.assign(n, {
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], strokes: [], effects: [], blendMode: "PASS_THROUGH",
    cornerRadius: 0, layoutMode: "NONE", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
    layoutWrap: "NO_WRAP", width: 100, height: 100, x: 0, y: 0, opacity: 1, visible: true,
    constraints: { horizontal: "MIN", vertical: "MIN" }, bound: {} as Record<string, string>, styles: {} as Record<string, string>,
    reactions: [] as unknown[],
  });
  n.resize = (w: number, h: number) => Object.assign(n, { width: w, height: h });
  n.setBoundVariable = (field: string, v: { id: string } | string) => {
    if (typeof v === "string") throw new Error("setBoundVariable with an id string throws under dynamic-page");
    (n.bound as Record<string, string>)[field] = v.id;
  };
  for (const [setter, slot] of [["setFillStyleIdAsync", "fill"], ["setStrokeStyleIdAsync", "stroke"], ["setEffectStyleIdAsync", "effect"], ["setGridStyleIdAsync", "grid"]] as const) {
    n[setter] = async (id: string) => void ((n.styles as Record<string, string>)[slot] = id);
  }
  n.setReactionsAsync = async (r: unknown[]) => void (n.reactions = r);
  return n;
}

interface World {
  page: N;
  page2: N;
  doc: N;
  collections: Map<string, { id: string; name: string; modes: Array<{ modeId: string; name: string }>; addMode(name: string): string }>;
  variables: Map<string, { id: string; name: string; resolvedType: string; variableCollectionId: string; values: Record<string, unknown>; setValueForMode(m: string, v: unknown): void }>;
  styles: Array<{ id: string; name: string; type: string }>;
  paid: boolean;
  undos: number;
  zoom: number;
  shown: string[];
}

let w: World;

function all(root: N): N[] {
  const out: N[] = [];
  const walk = (n: N) => n.children.forEach((c) => (out.push(c), walk(c)));
  walk(root);
  return out;
}

function install(): World {
  const doc = new N("DOCUMENT", "Doc");
  const page = new N("PAGE", "Page 1");
  const page2 = new N("PAGE", "Page 2");
  doc.appendChild(page);
  doc.appendChild(page2);
  page.selection = [];
  page2.selection = [];
  const world: World = { page, page2, doc, collections: new Map(), variables: new Map(), styles: [], paid: false, undos: 0, zoom: 1, shown: [] };
  const figma = {
    root: doc,
    currentPage: page,
    async setCurrentPageAsync(p: N) {
      figma.currentPage = p;
    },
    async getNodeByIdAsync(id: string) {
      return [doc, ...all(doc)].find((n) => n.id === id) ?? null;
    },
    createFrame() {
      const f = frame();
      figma.currentPage.appendChild(f);
      return f;
    },
    createComponentFromNode(node: N) {
      if (node.type === "COMPONENT") throw new Error("Cannot create component from node");
      const comp = frame(node.name);
      Object.assign(comp, { type: "COMPONENT" });
      (comp as unknown as { type: string }).type; // keep linters quiet
      Object.defineProperty(comp, "type", { value: "COMPONENT" });
      comp.createInstance = () => {
        const inst = frame(`${comp.name} instance`);
        Object.defineProperty(inst, "type", { value: "INSTANCE" });
        inst.mainComponent = comp;
        inst.swapComponent = (c: N) => void (inst.mainComponent = c);
        inst.detachInstance = () => {
          const f = frame(inst.name);
          inst.parent!.insertChild(inst.parent!.children.indexOf(inst), f);
          inst.remove();
          return f;
        };
        figma.currentPage.appendChild(inst);
        return inst;
      };
      node.parent!.insertChild(node.parent!.children.indexOf(node), comp);
      for (const c of [...node.children]) comp.appendChild(c);
      node.remove();
      return comp;
    },
    // figma.group(nodes, parent, index?) — a PluginAPI method; nodes have no group() of their own.
    group(nodes: N[], parent: N, index?: number) {
      const g = new N("GROUP", "Group");
      parent.insertChild(index ?? parent.children.length, g);
      for (const n of nodes) g.appendChild(n);
      return g;
    },
    ungroup(node: N) {
      const kids = [...node.children];
      for (const k of kids) node.parent!.appendChild(k);
      node.remove();
      return kids;
    },
    triggerUndo() {
      world.undos++;
    },
    viewport: {
      get zoom() {
        return world.zoom;
      },
      set zoom(z: number) {
        world.zoom = z;
      },
      scrollAndZoomIntoView(nodes: N[]) {
        world.shown = nodes.map((n) => n.id);
      },
    },
    async getStyleByIdAsync(id: string) {
      return world.styles.find((s) => s.id === id) ?? null;
    },
    async getLocalPaintStylesAsync() {
      return world.styles.filter((s) => s.type === "PAINT");
    },
    async getLocalTextStylesAsync() {
      return world.styles.filter((s) => s.type === "TEXT");
    },
    async getLocalEffectStylesAsync() {
      return world.styles.filter((s) => s.type === "EFFECT");
    },
    async getLocalGridStylesAsync() {
      return world.styles.filter((s) => s.type === "GRID");
    },
    variables: {
      async getVariableCollectionByIdAsync(id: string) {
        return world.collections.get(id) ?? null;
      },
      async getVariableByIdAsync(id: string) {
        return world.variables.get(id) ?? null;
      },
      async getLocalVariablesAsync() {
        return [...world.variables.values()];
      },
      createVariable(name: string, collection: unknown, type: string) {
        if (typeof collection === "string") throw new Error("createVariable(name, collectionId) throws under dynamic-page");
        return addVariable(name, (collection as { id: string }).id, type);
      },
      setBoundVariableForPaint(paint: object, field: string, v: { id: string }) {
        return { ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: v.id } } };
      },
    },
  };
  (globalThis as { figma?: unknown }).figma = figma;
  return world;
}

function addCollection(name: string) {
  const id = `VariableCollectionId:${seq++}`;
  const c = {
    id,
    name,
    modes: [{ modeId: `${id}/m0`, name: "Mode 1" }],
    addMode(modeName: string) {
      if (!w.paid) throw new Error("in Starter plan, only 1 mode is allowed");
      const modeId = `${id}/m${c.modes.length}`;
      c.modes.push({ modeId, name: modeName });
      return modeId;
    },
  };
  w.collections.set(id, c);
  return c;
}

function addVariable(name: string, collectionId: string, resolvedType: string) {
  const v = {
    id: `VariableID:${seq++}`,
    name,
    resolvedType,
    variableCollectionId: collectionId,
    values: {} as Record<string, unknown>,
    setValueForMode(m: string, value: unknown) {
      v.values[m] = value;
    },
  };
  w.variables.set(v.id, v);
  return v;
}

beforeEach(() => {
  w = install();
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const run = (op: string, params: Record<string, unknown>) => PLUGIN_OPS[op]!.run(ctx(params)) as Promise<Record<string, unknown> & { items?: Array<Record<string, unknown>> }>;
async function fails(op: string, params: Record<string, unknown>): Promise<BridgeError> {
  try {
    await run(op, params);
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error(`expected ${op} to fail`);
}
const onPage = (f: N) => (w.page.appendChild(f), f);

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("the string forms the MCP schema sends", () => {
  it("padding: \"24\" and \"48,48,32,32\" (and junk is named)", () => {
    expect(normalizePadding("24")).toEqual([24, 24, 24, 24]);
    expect(normalizePadding(" 48, 48 ,32,32")).toEqual([48, 48, 32, 32]);
    expect(() => normalizePadding("1,2,3")).toThrow(/four comma-separated/);
  });

  it("variable values by declared type", () => {
    expect(parseVariableValue("FLOAT", "16")).toBe(16);
    expect(parseVariableValue("BOOLEAN", "false")).toBe(false);
    expect(parseVariableValue("COLOR", "#ff000080")).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(parseVariableValue("STRING", "Inter")).toBe("Inter");
    expect(() => parseVariableValue("FLOAT", "big")).toThrow(/FLOAT needs a number/);
  });

  it("alignX/alignY are screen directions mapped onto Figma's axes", () => {
    expect(alignmentFor("HORIZONTAL", "end", "center")).toEqual({ primaryAxisAlignItems: "MAX", counterAxisAlignItems: "CENTER" });
    expect(alignmentFor("VERTICAL", "end", "center")).toEqual({ primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "MAX" });
    expect(alignmentFor("HORIZONTAL", "space-between", undefined)).toEqual({ primaryAxisAlignItems: "SPACE_BETWEEN" });
    expect(() => alignmentFor("VERTICAL", "space-between", undefined)).toThrow(/runs across a vertical layout/);
    expect(() => alignmentFor("NONE", "start", undefined)).toThrow(/need auto-layout/);
  });

  it("reaction shorthand becomes Figma's shape", () => {
    expect(toReaction({ trigger: "on_click", action: { type: "node", destinationId: "1:2", transition: "smart_animate", duration: 0.4 } }, 0)).toEqual({
      trigger: { type: "ON_CLICK" },
      actions: [{ type: "NODE", destinationId: "1:2", navigation: "NAVIGATE", transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.4 } }],
    });
    expect(toReaction({ trigger: { type: "AFTER_TIMEOUT", timeout: 1 }, actions: [{ type: "BACK" }] }, 0).trigger).toEqual({ type: "AFTER_TIMEOUT", timeout: 1 });
    expect(() => toReaction({ trigger: "AFTER_TIMEOUT", action: { type: "BACK" } }, 2)).toThrow(/reactions\[2\]\.trigger.*object form/);
    // F-6: the example is in the trigger's unit, milliseconds [C-122] — 1 would fire after 1 ms.
    expect(() => toReaction({ trigger: "AFTER_TIMEOUT", action: { type: "BACK" } }, 0)).toThrow(/\{ "type": "AFTER_TIMEOUT", "timeout": 1000 \}/);
    expect(() => toReaction({ trigger: "ON_CLICK" }, 0)).toThrow(/needs `actions`/);
  });
});

// ── components ───────────────────────────────────────────────────────────────

describe("components", () => {
  it("convert_to_component uses createComponentFromNode and keeps the children", async () => {
    const f = onPage(frame("Card"));
    f.appendChild(frame("Inner"));
    const r = await run("convert_to_component", { nodeId: f.id, name: "Card/Default" });
    expect(r).toMatchObject({ type: "COMPONENT", name: "Card/Default", sourceId: f.id });
    const comp = all(w.doc).find((n) => n.id === r.id)!;
    expect(comp.children.map((c) => c.name)).toEqual(["Inner"]);
    expect(all(w.doc).some((n) => n.id === f.id)).toBe(false);
  });

  it("create_instance places an instance from the component's own method; a bad id creates nothing", async () => {
    const comp = await run("convert_to_component", { nodeId: onPage(frame("Btn")).id });
    const host = onPage(frame("Host"));
    const inst = await run("create_instance", { componentId: comp.id, parentId: host.id, x: 10 });
    expect(inst).toMatchObject({ type: "INSTANCE", componentId: comp.id });
    expect(host.children.map((c) => c.id)).toEqual([inst.id]);
    const before = all(w.doc).length;
    const err = await fails("create_instance", { componentId: host.id });
    expect(err.message).toMatch(/is a FRAME, not a component/);
    expect(err.partial).toEqual({ created: [] });
    expect(all(w.doc).length).toBe(before);
  });

  it("a component set instantiates its default variant", async () => {
    const variant = await run("convert_to_component", { nodeId: onPage(frame("Size=M")).id });
    const set = onPage(new N("COMPONENT_SET", "Button"));
    set.defaultVariant = all(w.doc).find((n) => n.id === variant.id);
    const inst = await run("create_instance", { componentId: set.id });
    expect(inst.componentId).toBe(variant.id);
  });

  it("swap_component and detach_instance (the frame's new id is reported)", async () => {
    const a = await run("convert_to_component", { nodeId: onPage(frame("A")).id });
    const b = await run("convert_to_component", { nodeId: onPage(frame("B")).id });
    const inst = await run("create_instance", { componentId: a.id });
    await run("swap_component", { nodeId: inst.id, componentId: b.id });
    const node = all(w.doc).find((n) => n.id === inst.id)!;
    expect((node.mainComponent as N).id).toBe(b.id);
    const d = await run("detach_instance", { nodeIds: [inst.id, b.id] });
    expect(d.detached).toBe(1);
    expect(d.items![0]).toMatchObject({ id: inst.id, ok: true });
    expect(typeof d.items![0]!.frameId).toBe("string");
    expect(d.items![1]).toMatchObject({ ok: false, error: "a COMPONENT is not an instance" });
  });
});

// ── variables ────────────────────────────────────────────────────────────────

describe("variables", () => {
  it("create_variable passes the collection object and parses the string value", async () => {
    const c = addCollection("Tokens");
    const r = await run("create_variable", { collectionId: c.id, name: "space/4", type: "FLOAT", value: "16" });
    expect(w.variables.get(r.id as string)!.values[c.modes[0]!.modeId]).toBe(16);
  });

  it("create_variable with a bad value creates nothing", async () => {
    const c = addCollection("Tokens");
    const err = await fails("create_variable", { collectionId: c.id, name: "x", type: "BOOLEAN", value: "maybe" });
    expect(err.partial).toEqual({ created: [] });
    expect(w.variables.size).toBe(0);
  });

  it("add_variable_mode: Figma's plan refusal comes back as INVALID_PARAM; paid works", async () => {
    const c = addCollection("Theme");
    const err = await fails("add_variable_mode", { collectionId: c.id, name: "Dark" });
    expect(err.message).toMatch(/only 1 mode/);
    expect(err.hint).toMatch(/paid plan/);
    w.paid = true;
    const r = await run("add_variable_mode", { collectionId: c.id, name: "Dark" });
    expect(r.modes).toHaveLength(2);
    expect((await fails("add_variable_mode", { collectionId: c.id, name: "Dark" })).message).toMatch(/already has a mode/);
  });

  it("set_variable_value by mode name, and an alias to a same-type variable", async () => {
    w.paid = true;
    const c = addCollection("Theme");
    const dark = c.addMode("Dark");
    const bg = addVariable("color/bg", c.id, "COLOR");
    const brand = addVariable("color/brand", c.id, "COLOR");
    await run("set_variable_value", { variableName: "color/bg", modeId: "Dark", value: "#101014" });
    expect(bg.values[dark]).toMatchObject({ r: 16 / 255 });
    await run("set_variable_value", { variableId: bg.id, value: "alias:color/brand" });
    expect(bg.values[c.modes[0]!.modeId]).toEqual({ type: "VARIABLE_ALIAS", id: brand.id });
    addVariable("space/1", c.id, "FLOAT");
    expect((await fails("set_variable_value", { variableId: bg.id, value: "alias:space/1" })).message).toMatch(/same type/);
  });

  it("bind_variable_to_node: fill through setBoundVariableForPaint, radius and padding through setBoundVariable(object)", async () => {
    const c = addCollection("T");
    const bg = addVariable("color/bg", c.id, "COLOR");
    const r = addVariable("radius/md", c.id, "FLOAT");
    const f = onPage(frame());
    expect((await run("bind_variable_to_node", { nodeIds: [f.id], field: "fill", variableName: "color/bg" })).updated).toBe(1);
    expect((f.fills as Array<{ boundVariables: unknown }>)[0]!.boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: bg.id } });
    await run("bind_variable_to_node", { nodeIds: [f.id], field: "radius", variableId: r.id });
    await run("bind_variable_to_node", { nodeIds: [f.id], field: "padding", variableId: r.id });
    expect(f.bound).toEqual({ cornerRadius: r.id, paddingTop: r.id, paddingRight: r.id, paddingBottom: r.id, paddingLeft: r.id });
    const wrong = await run("bind_variable_to_node", { nodeIds: [f.id], field: "fill", variableId: r.id });
    expect(wrong.items![0]!.error).toMatch(/binds a COLOR variable/);
  });

});

// ── styles, effects, blend ──────────────────────────────────────────────────

describe("styles and effects", () => {
  it("apply_style_to_node by name; a paint style can go on the stroke; an ambiguous name asks for `type`", async () => {
    w.styles.push({ id: "S:1", name: "Brand", type: "PAINT" }, { id: "S:2", name: "Brand", type: "EFFECT" }, { id: "S:3", name: "Body", type: "TEXT" });
    const f = onPage(frame());
    expect((await fails("apply_style_to_node", { nodeIds: [f.id], styleName: "Brand" })).hint).toMatch(/Pass `type`/);
    await run("apply_style_to_node", { nodeIds: [f.id], styleName: "Brand", type: "stroke" });
    await run("apply_style_to_node", { nodeIds: [f.id], styleId: "S:2" });
    expect(f.styles).toEqual({ stroke: "S:1", effect: "S:2" });
    const text = await run("apply_style_to_node", { nodeIds: [f.id], styleName: "Body" });
    expect(text.items![0]).toMatchObject({ ok: false, error: "a FRAME cannot take a text style" });
  });

  it("set_effects: shadows carry exactly their fields, blurs refuse shadow fields before anything changes", async () => {
    const f = onPage(frame());
    await run("set_effects", { nodeIds: [f.id], effects: [{ type: "INNER_SHADOW", color: "#00000040", y: 2 }, { type: "LAYER_BLUR", radius: 4 }] });
    expect(f.effects).toEqual([
      { type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 64 / 255 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" },
      { type: "LAYER_BLUR", radius: 4, visible: true, blurType: "NORMAL" },
    ]);
    const err = await fails("set_effects", { nodeIds: [f.id], effects: [{ type: "BACKGROUND_BLUR", color: "#000" }] });
    expect(err.message).toMatch(/takes only `radius` and `visible`/);
    expect(f.effects).toHaveLength(2);
  });

  it("create_effect_style shares the effect builder and validates before creating", async () => {
    const created: Array<Record<string, unknown>> = [];
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.createEffectStyle = () => {
      const s = { id: `S:${seq++}`, name: "" } as Record<string, unknown>;
      created.push(s);
      return s;
    };
    await fails("create_effect_style", { name: "Bad", effects: [{ type: "LAYER_BLUR", x: 3 }] });
    expect(created).toHaveLength(0);
    const r = await run("create_effect_style", { name: "Elevation/1", effects: [{ y: 1, radius: 2 }] });
    expect(r).toMatchObject({ name: "Elevation/1", effectCount: 1 });
    expect((created[0]!.effects as unknown[])[0]).toMatchObject({ type: "DROP_SHADOW", showShadowBehindNode: false });
  });

  it("set_blend_mode validates the mode once", async () => {
    const f = onPage(frame());
    expect((await run("set_blend_mode", { nodeIds: [f.id], blendMode: "multiply" })).updated).toBe(1);
    expect(f.blendMode).toBe("MULTIPLY");
    await fails("set_blend_mode", { nodeIds: [f.id], blendMode: "GLOW" });
  });

  it("set_reactions takes a JSON string; remove_reactions clears", async () => {
    const f = onPage(frame());
    const r = await run("set_reactions", { nodeId: f.id, reactions: JSON.stringify([{ trigger: "ON_HOVER", action: { type: "BACK" } }]) });
    expect(r.count).toBe(1);
    expect(f.reactions).toEqual([{ trigger: { type: "ON_HOVER" }, actions: [{ type: "BACK" }] }]);
    await run("remove_reactions", { nodeId: f.id });
    expect(f.reactions).toEqual([]);
  });
});

// ── structure, auto-layout, undo ────────────────────────────────────────────

describe("structure", () => {
  it("group_nodes uses figma.group and keeps the group where the nodes were", async () => {
    const a = onPage(frame("a"));
    const b = onPage(frame("b"));
    const c = onPage(frame("c"));
    const r = await run("group_nodes", { nodeIds: [b.id, c.id, "9:9"], name: "Pair" });
    expect(r).toMatchObject({ type: "GROUP", name: "Pair", childCount: 2 });
    expect(w.page.children.map((n) => n.name)).toEqual(["a", "Pair"]);
    expect(r.items).toEqual([{ id: "9:9", ok: false, error: "not found" }]);
    void a;
  });

  it("ungroup_nodes moves children up and only accepts groups", async () => {
    const g = onPage(new N("GROUP", "G"));
    const a = frame("a");
    g.appendChild(a);
    const f = onPage(frame());
    const r = await run("ungroup_nodes", { nodeIds: [g.id, f.id] });
    expect(r.items![0]).toMatchObject({ ok: true, childIds: [a.id] });
    expect(r.items![1]!.error).toMatch(/is not a group/);
    expect(a.parent).toBe(w.page);
  });

  it("set_constraints understands designer words and keeps the untouched axis", async () => {
    const f = onPage(frame());
    await run("set_constraints", { nodeIds: [f.id], horizontal: "left-right" });
    expect(f.constraints).toEqual({ horizontal: "STRETCH", vertical: "MIN" });
    await fails("set_constraints", { nodeIds: [f.id], vertical: "middle" });
  });

  it("set_auto_layout applies alignment, wrap and string padding — and changes nothing when one value is bad", async () => {
    const f = onPage(frame());
    await run("set_auto_layout", { nodeId: f.id, mode: "horizontal", padding: "8,16,8,16", alignX: "space-between", alignY: "center", wrap: true });
    expect(f).toMatchObject({ layoutMode: "HORIZONTAL", paddingTop: 8, paddingRight: 16, primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER", layoutWrap: "WRAP" });
    await fails("set_auto_layout", { nodeId: f.id, mode: "vertical", wrap: true });
    expect(f.layoutMode).toBe("HORIZONTAL"); // the bad call did not flip the mode first
  });

  it("reorder_nodes accepts the index as the string the schema sends", async () => {
    const a = onPage(frame("a"));
    const b = onPage(frame("b"));
    await run("reorder_nodes", { nodeIds: [b.id], position: "0" });
    expect(w.page.children.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("undo_step demands confirm, warns, and is not a write op (no commitUndo after triggerUndo)", async () => {
    expect((await fails("undo_step", { count: 1 })).hint).toMatch(/C-024/);
    const r = await run("undo_step", { confirm: true, count: 2 });
    expect(w.undos).toBe(2);
    expect(r.warning).toMatch(/by hand/);
    expect(PLUGIN_OPS.undo_step!.write).toBe(false);
  });
});

// ── meta: what the user sees ─────────────────────────────────────────────────

describe("select, navigate, zoom", () => {
  it("select replace / add / toggle", async () => {
    const a = onPage(frame("a"));
    const b = onPage(frame("b"));
    await run("select", { nodeId: a.id });
    await run("select", { nodeIds: [b.id], mode: "add" });
    expect((w.page.selection as N[]).map((n) => n.id)).toEqual([a.id, b.id]);
    await run("select", { nodeIds: [a.id], mode: "toggle" });
    expect((w.page.selection as N[]).map((n) => n.id)).toEqual([b.id]);
  });

  it("a node on another page switches the page first", async () => {
    const far = frame("far");
    w.page2.appendChild(far);
    const r = await run("select", { nodeId: far.id });
    expect(r).toMatchObject({ switchedPage: true, page: { id: w.page2.id } });
    expect(((globalThis as unknown as { figma: { currentPage: N } }).figma.currentPage).id).toBe(w.page2.id);
  });

  it("navigate_page by name, with the page list when it is wrong", async () => {
    await run("navigate_page", { pageName: "Page 2" });
    expect((await fails("navigate_page", { pageName: "Nope" })).hint).toMatch(/Page 1/);
  });

  it("zoom_to fits, or sets a level given as a string", async () => {
    const a = onPage(frame("a"));
    await run("zoom_to", { nodeIds: [a.id], zoom: "2" });
    expect(w.shown).toEqual([a.id]);
    expect(w.zoom).toBe(2);
    await fails("zoom_to", { nodeId: a.id, zoom: "-1" });
  });
});

// ── create_from_spec: the features tools.md promised ────────────────────────

describe("create_from_spec — component, instance, variables, style, pacing", () => {
  beforeEach(() => {
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    f.createRectangle = () => {
      const r = frame("Rectangle");
      Object.defineProperty(r, "type", { value: "RECTANGLE" });
      (f.currentPage as N).appendChild(r);
      return r;
    };
    f.loadFontAsync = async () => {};
    f.listAvailableFontsAsync = async () => [];
  });
  const build = (spec: unknown, extra: Partial<OpContext> = {}) =>
    PLUGIN_OPS.create_from_spec!.run({ ...ctx({ spec }), ...extra }) as Promise<{ rootId: string; created: Array<{ id: string; path: string }> }>;

  it("a `component` is converted after its children, and created[0] names the component", async () => {
    const r = await build({ type: "component", name: "Chip", children: [{ type: "rectangle", name: "Dot", width: 4, height: 4 }] });
    const comp = all(w.doc).find((n) => n.id === r.rootId)!;
    expect(comp.type).toBe("COMPONENT");
    expect(r.created[0]!.id).toBe(comp.id);
    expect(comp.children.map((c) => c.name)).toEqual(["Dot"]);
  });

  it("an `instance` comes from the component's own createInstance()", async () => {
    const comp = await run("convert_to_component", { nodeId: onPage(frame("Btn")).id });
    const r = await build({ type: "frame", children: [{ type: "instance", componentId: comp.id }] });
    expect(all(w.doc).find((n) => n.id === r.created[1]!.id)!.type).toBe("INSTANCE");
  });

  it("`variables` and `style` are applied by name — no longer silently ignored", async () => {
    const c = addCollection("T");
    const bg = addVariable("color/bg", c.id, "COLOR");
    const gap = addVariable("space/2", c.id, "FLOAT");
    w.styles.push({ id: "S:9", name: "Elevation/1", type: "EFFECT" });
    const r = await build({ type: "frame", layout: "vertical", variables: { fill: "color/bg", gap: "space/2" }, style: { effect: "Elevation/1" } });
    const root = all(w.doc).find((n) => n.id === r.rootId)!;
    expect((root.fills as Array<{ boundVariables: unknown }>)[0]!.boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: bg.id } });
    expect(root.bound).toEqual({ itemSpacing: gap.id });
    expect(root.styles).toEqual({ effect: "S:9" });
    const err = await (async () => {
      try {
        await build({ type: "frame", variables: { fill: "color/nope" } });
      } catch (e) {
        return e as BridgeError;
      }
    })();
    expect(err!.hint).toMatch(/Nearest: color\/bg/);
  });

  it("a horizontal row maps alignX onto its primary axis; a button keeps a padding it was given", async () => {
    const r = await build({
      type: "frame", layout: "horizontal", alignX: "space-between", alignY: "center",
      children: [{ type: "button", padding: [4, 8, 4, 8] }],
    });
    const root = all(w.doc).find((n) => n.id === r.rootId)!;
    expect(root).toMatchObject({ primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
    expect(all(w.doc).find((n) => n.id === r.created[1]!.id)).toMatchObject({ layoutMode: "HORIZONTAL", paddingTop: 4, paddingLeft: 8 });
  });

  it("large specs are paced: progress carries the total, and a cancel stops the build with everything reported", async () => {
    const spec = { type: "frame", children: Array.from({ length: 30 }, (_, i) => ({ type: "rectangle", name: `r${i}`, width: 1, height: 1 })) };
    const seen: Array<[number, number | undefined]> = [];
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => (clock += 20); // every unit "takes" 20 ms, so every tick yields
    try {
      let yields = 0;
      const err = await (async () => {
        try {
          await build(spec, {
            progress: (d, t) => void seen.push([d, t]),
            yieldToHost: async () => void yields++,
            isCancelled: () => yields >= 5,
          });
        } catch (e) {
          return e as BridgeError;
        }
      })();
      expect(seen[0]).toEqual([0, 31]);
      expect(err!.code).toBe("CANCELLED");
      const partial = err!.partial as { created: Array<{ id: string }> };
      expect(partial.created.length).toBeGreaterThan(0);
      expect(partial.created.map((c) => c.id).sort()).toEqual(all(w.page).map((n) => n.id).sort());
    } finally {
      Date.now = realNow;
    }
  });
});

// ── deleting tokens and styles (so a probe can clean up after itself) ───────

describe("delete_variable, delete_variable_collection, delete_style", () => {
  it("remove what they are given, per item", async () => {
    const c = addCollection("Doomed");
    const a = addVariable("x/a", c.id, "FLOAT");
    const removed: string[] = [];
    (a as unknown as { remove: () => void }).remove = () => void (w.variables.delete(a.id), removed.push(a.id));
    const r = await run("delete_variable", { variableIds: [a.id, "VariableID:404"] });
    expect(r.deleted).toBe(1);
    expect(r.items![1]).toMatchObject({ ok: false, error: "not found" });
    (c as unknown as { remove: () => void; variableIds: string[] }).remove = () => void w.collections.delete(c.id);
    (c as unknown as { variableIds: string[] }).variableIds = [];
    expect(await run("delete_variable_collection", { collectionId: c.id })).toMatchObject({ deleted: c.id, name: "Doomed", variableCount: 0 });
    expect(w.collections.has(c.id)).toBe(false);
    const style = { id: "S:del", name: "Old", type: "PAINT", remove: () => void w.styles.splice(w.styles.indexOf(style), 1) };
    w.styles.push(style);
    expect((await run("delete_style", { styleIds: ["S:del"] })).deleted).toBe(1);
    expect(w.styles).toHaveLength(0);
    expect(removed).toEqual([a.id]);
  });
});
