// Components and library assets — the part of the official Figma MCP's reach
// that goes through Plugin API JavaScript: reading a component's property
// definitions, importing published assets by key [C-110], editing and deleting
// properties and writing descriptions [C-111], slots [C-112], a variant grid,
// and listing components on pages the user has not opened [C-090].
//
// The fakes behave like the Plugin API where it matters: reading
// componentPropertyDefinitions on a variant throws [C-114], an import rejects
// a key with no published asset, and a page other than the current one must be
// loaded before it is searched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { COMPONENT_OPS, parseVariant, pickVariant } from "../src/plugin/ops/component.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { registerComponents } from "../src/server/tools/components.js";
import type { Bridge } from "../src/server/bridge.js";

let seq = 0;
const byId = new Map<string, N>();

class N {
  id = `5:${++seq}`;
  name: string;
  children: N[] = [];
  parent: N | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 40;
  [k: string]: unknown;
  constructor(readonly type: string, name?: string) {
    this.name = name ?? type.toLowerCase();
  }
  appendChild(c: N) {
    if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c);
    this.children.push(c);
    c.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = null;
    byId.delete(this.id);
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  findAllWithCriteria(c: { types: string[] }) {
    finds.push(this.id);
    const out: N[] = [];
    const visit = (n: N) => {
      for (const k of n.children) {
        if (c.types.includes(k.type)) out.push(k);
        visit(k);
      }
    };
    visit(this);
    return out;
  }
}

let page: N;
let doc: N;
let finds: string[];
let loads: number;
let figma: Record<string, unknown>;

function make(type: string, parent: N | null = page, name?: string): N {
  const n = new N(type, name);
  byId.set(n.id, n);
  parent?.appendChild(n);
  return n;
}

/** A variant: Figma throws when its definitions are read [C-114]. */
function variant(set: N, values: Record<string, string>): N {
  const v = make("COMPONENT", set, Object.entries(values).map(([k, val]) => `${k}=${val}`).join(", "));
  v.variantProperties = values;
  v.key = `key-${v.name}`;
  Object.defineProperty(v, "componentPropertyDefinitions", {
    get() {
      throw new Error("Can only get definitions of a component set or non-variant component");
    },
  });
  v.createInstance = () => {
    const i = make("INSTANCE");
    i.mainComponent = v;
    return i;
  };
  return v;
}

/** Button: Size × State, a Label wired to "Label#1:0" in every variant. */
function buttonSet() {
  const set = make("COMPONENT_SET", page, "Button");
  set.key = "set-key";
  const vs = [
    variant(set, { Size: "Small", State: "Default" }),
    variant(set, { Size: "Small", State: "Hover" }),
    variant(set, { Size: "Large", State: "Default" }),
    variant(set, { Size: "Large", State: "Hover" }),
  ];
  const labels = vs.map((v) => {
    const t = make("TEXT", v, "Label");
    t.componentPropertyReferences = { characters: "Label#1:0" };
    return t;
  });
  set.defaultVariant = vs[0];
  set.componentPropertyDefinitions = {
    "Label#1:0": { type: "TEXT", defaultValue: "Button" },
    Size: { type: "VARIANT", defaultValue: "Small", variantOptions: ["Small", "Large"] },
    State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
  };
  return { set, vs, labels };
}

const run = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const op = (name: string, params: Record<string, unknown>) => COMPONENT_OPS[name]!.run(run(params)) as Promise<Record<string, any>>;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string; partial?: { created: unknown[] } };
  }
  throw new Error("expected a failure");
};

beforeEach(() => {
  seq = 0;
  byId.clear();
  finds = [];
  loads = 0;
  doc = new N("DOCUMENT", "File");
  page = make("PAGE", doc, "Page 1");
  figma = {
    currentPage: page,
    root: doc,
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadAllPagesAsync: async () => {
      loads++;
    },
  };
  (globalThis as { figma?: unknown }).figma = figma;
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

// ── reading a component ──────────────────────────────────────────────────────

describe("get_component", () => {
  it("answers a variant from its set without touching the variant's definitions [C-114]", async () => {
    const { set, vs } = buttonSet();
    // A nested icon instance: its own refs point at ITS main component, and its
    // sublayers are not walked.
    const icon = make("INSTANCE", vs[0], "Icon");
    icon.componentPropertyReferences = { visible: "Other#9:9" };
    make("TEXT", icon, "Glyph").componentPropertyReferences = { characters: "Label#1:0" };
    const r = await op("get_component", { nodeId: vs[1]!.id });
    expect(r).toMatchObject({ id: vs[1]!.id, type: "COMPONENT", key: "key-Size=Small, State=Hover", owner: { id: set.id, type: "COMPONENT_SET", key: "set-key" } });
    expect(r.properties).toEqual([
      { key: "Label#1:0", name: "Label", type: "TEXT", defaultValue: "Button" },
      { key: "Size", name: "Size", type: "VARIANT", defaultValue: "Small", variantOptions: ["Small", "Large"] },
      { key: "State", name: "State", type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
    ]);
    expect(r.variants).toHaveLength(4);
    expect(r.variants[3]).toEqual({ id: vs[3]!.id, name: "Size=Large, State=Hover", values: { Size: "Large", State: "Hover" } });
    expect(r.defaultVariantId).toBe(vs[0]!.id);
    expect(r.references).toHaveLength(4);
    expect(r.references[0]).toMatchObject({ name: "Label", type: "TEXT", refs: { characters: "Label#1:0" }, variant: "Size=Small, State=Default" });
    expect(r.truncated).toBe(false);
  });

  it("resolves an instance to its main component and reports exposed instances", async () => {
    const { set, vs } = buttonSet();
    const inst = make("INSTANCE", page, "Buy");
    inst.getMainComponentAsync = async () => vs[2];
    inst.exposedInstances = [make("INSTANCE", inst, "Icon")];
    const r = await op("get_component", { nodeId: inst.id });
    expect(r).toMatchObject({ id: vs[2]!.id, instanceId: inst.id, owner: { id: set.id } });
    expect(r.exposedInstances).toEqual([{ id: (inst.exposedInstances as N[])[0]!.id, name: "Icon" }]);
  });

  it("pages the layer references with a cursor that belongs to this component", async () => {
    const { vs } = buttonSet();
    const first = await op("get_component", { nodeId: vs[0]!.id, limit: 3 });
    expect(first.references).toHaveLength(3);
    expect(first.truncated).toBe(true);
    const rest = await op("get_component", { nodeId: vs[0]!.id, limit: 3, cursor: first.nextCursor });
    expect(rest.references).toHaveLength(1);
    expect(rest.truncated).toBe(false);
    const other = make("COMPONENT", page, "Card");
    other.componentPropertyDefinitions = {};
    await expect(op("get_component", { nodeId: other.id, cursor: first.nextCursor })).rejects.toThrow(/does not belong/);
  });

  it("names a preferred swap target that lives in this file", async () => {
    const icon = make("COMPONENT", page, "Icon / Star");
    icon.key = "icon-star";
    const card = make("COMPONENT", page, "Card");
    card.componentPropertyDefinitions = { "Icon#3:0": { type: "INSTANCE_SWAP", defaultValue: icon.id, preferredValues: [{ type: "COMPONENT", key: "icon-star" }] } };
    const r = await op("get_component", { nodeId: card.id });
    expect(r.properties[0].preferredValues).toEqual([{ type: "COMPONENT", key: "icon-star", id: icon.id, name: "Icon / Star" }]);
    expect(loads).toBe(1);
  });

  it("refuses a node that is not a component", async () => {
    const f = make("FRAME");
    await expect(op("get_component", { nodeId: f.id })).rejects.toThrow(/is a FRAME, not a component/);
  });
});

describe("get_local_components [C-090]", () => {
  it("loads every page once, searches each with the indexed find, and reports keys, sets and variant options", async () => {
    const { set } = buttonSet();
    const other = make("PAGE", doc, "Icons");
    other.loadAsync = async () => {
      throw new Error("must not load page by page when every page is loaded");
    };
    const star = make("COMPONENT", other, "Star");
    star.key = "star-key";
    star.description = "A star";
    const broken = make("COMPONENT_SET", other, "Broken");
    Object.defineProperty(broken, "componentPropertyDefinitions", { get: () => { throw new Error("Component set has existing errors"); } });
    const r = await op("get_local_components", {});
    expect(loads).toBe(1);
    expect(finds).toEqual([page.id, other.id]);
    expect(r.componentCount).toBe(5);
    expect(r.components[0]).toMatchObject({ pageId: page.id, setId: set.id, setName: "Button", key: "key-Size=Small, State=Default" });
    expect(r.components[4]).toEqual({ id: star.id, name: "Star", type: "COMPONENT", pageId: other.id, description: "A star", key: "star-key" });
    expect(r.componentSets[0]).toMatchObject({ id: set.id, key: "set-key", variantCount: 4, properties: { Size: ["Small", "Large"], State: ["Default", "Hover"] } });
    expect(r.componentSets[1]).toMatchObject({ id: broken.id, variantCount: 0, properties: {}, error: "Component set has existing errors" });
  });

  it("with pageId, loads only that page — a page the user is not on [C-090]", async () => {
    const other = make("PAGE", doc, "Icons");
    let loaded = false;
    other.loadAsync = async () => {
      loaded = true;
    };
    make("COMPONENT", other, "Star");
    const r = await op("get_local_components", { pageId: other.id });
    expect([loaded, loads]).toEqual([true, 0]);
    expect(r.componentCount).toBe(1);
  });
});

// ── library assets by key [C-110] ───────────────────────────────────────────

describe("import_library_assets and componentKey", () => {
  function library() {
    const lib = new N("COMPONENT_SET", "Lib Button");
    lib.remote = true;
    byId.set(lib.id, lib);
    const small = variant(lib, { Size: "Small" });
    const large = variant(lib, { Size: "Large" });
    lib.defaultVariant = small;
    const imported: string[] = [];
    figma.importComponentSetByKeyAsync = async (key: string) => {
      imported.push(key);
      if (key === "lib-set") return lib;
      throw new Error(`Component set with key "${key}" is not published`);
    };
    figma.importComponentByKeyAsync = async (key: string) => {
      if (key === "lib-comp") return large;
      throw new Error("not published");
    };
    figma.importStyleByKeyAsync = async () => ({ id: "S:lib,", name: "Brand/Primary", type: "PAINT" });
    return { lib, small, large, imported };
  }

  it("reports per item: what imported, and Figma's reason for what did not", async () => {
    library();
    const r = await op("import_library_assets", {
      assets: [
        { kind: "component_set", key: "lib-set" },
        { kind: "style", key: "style-key" },
        { kind: "component", key: "nope" },
        { kind: "variable", key: "var-key" },
      ],
    });
    expect(r.imported).toBe(2);
    expect(r.items[0]).toMatchObject({ key: "lib-set", ok: true, type: "COMPONENT_SET", name: "Lib Button" });
    expect(r.items[0].defaultVariantId).toBeDefined();
    expect(r.items[1]).toMatchObject({ ok: true, id: "S:lib,", type: "PAINT" });
    expect(r.items[2]).toMatchObject({ ok: false });
    expect(r.items[2].error).toMatch(/not published/);
    // No variables API in this fake: the item names the missing call.
    expect(r.items[3].error).toMatch(/figma\.variables\.importVariableByKeyAsync is not available/);
  });

  it("refuses a malformed list before importing anything", async () => {
    const { imported } = library();
    const e = await fails(op("import_library_assets", { assets: [{ kind: "component_set", key: "lib-set" }, { kind: "frame", key: "x" }] }));
    expect(e.message).toMatch(/assets\[1\]\.kind/);
    expect(e.partial).toEqual({ created: [] });
    expect(imported).toEqual([]);
  });

  it("create_instance by componentSetKey + variant places that variant", async () => {
    const { large } = library();
    const r = await op("create_instance", { componentSetKey: "lib-set", variant: "Size=Large" });
    expect(r).toMatchObject({ componentId: large.id, imported: { kind: "component_set", key: "lib-set" } });
    expect((byId.get(r.id)!.mainComponent as N).id).toBe(large.id);
  });

  it("a key that does not import creates nothing", async () => {
    library();
    const before = page.children.length;
    const e = await fails(op("create_instance", { componentSetKey: "missing" }));
    expect(e.code).toBe("NODE_NOT_FOUND");
    expect(e.message).toMatch(/is not published/);
    expect(e.partial).toEqual({ created: [] });
    expect(page.children.length).toBe(before);
  });

  it("refuses two ways of naming the component at once", async () => {
    const { vs } = buttonSet();
    const e = await fails(op("create_instance", { componentId: vs[0]!.id, componentKey: "lib-comp" }));
    expect(e.message).toMatch(/not componentId and componentKey/);
    expect(e.partial).toEqual({ created: [] });
  });

  it("a local set + variant; a partial variant keeps the default's other values", async () => {
    const { set, vs } = buttonSet();
    const r = await op("create_instance", { componentId: set.id, variant: "Size=Large, State=Hover" });
    expect(r).toMatchObject({ componentId: vs[3]!.id, componentSetId: set.id });
    expect(pickVariant(set as never, "Size=Large").id).toBe(vs[2]!.id);
    await expect(op("create_instance", { componentId: set.id, variant: "Size=Huge" })).rejects.toThrow(/No variant of "Button" is Size=Huge/);
    expect(() => parseVariant("Large")).toThrow(/has no "="/);
  });

  it("swap_component to a named variant of a set", async () => {
    const { set, vs } = buttonSet();
    const inst = make("INSTANCE");
    inst.swapComponent = (c: N) => {
      inst.mainComponent = c;
    };
    const r = await op("swap_component", { nodeId: inst.id, componentId: set.id, variant: "State=Hover" });
    expect(r.componentId).toBe(vs[1]!.id);
    expect((inst.mainComponent as N).id).toBe(vs[1]!.id);
    const e = await fails(op("swap_component", { nodeId: inst.id, componentId: set.id, variant: "State=Gone" }));
    expect(e.partial).toEqual({ created: [] });
  });
});

// ── properties [C-111] ──────────────────────────────────────────────────────

describe("add_component_property: reuse and preferred values", () => {
  it("a property of the same name and type is reused, not duplicated, and the new layers are wired", async () => {
    const { set, vs } = buttonSet();
    const added: unknown[] = [];
    set.addComponentProperty = (...args: unknown[]) => {
      added.push(args);
      return "Label#9:9";
    };
    const captions = vs.map((v) => make("TEXT", v, "Caption"));
    const r = await op("add_component_property", { componentId: set.id, name: "Label", type: "TEXT", defaultValue: "Buy", bindNodeIds: [captions[0]!.id] });
    expect(added).toEqual([]);
    expect(r).toMatchObject({ key: "Label#1:0", reused: true, defaultValue: "Button" });
    expect(r.bound).toEqual(captions.map((c) => c.id));
    expect(r.note).toMatch(/Kept its default "Button"/);
  });

  it("preferred values are passed as component KEYS, not ids", async () => {
    const card = make("COMPONENT", page, "Card");
    card.componentPropertyDefinitions = {};
    const slotIcon = make("INSTANCE", card, "Icon");
    const star = make("COMPONENT", page, "Star");
    star.key = "star-key";
    const icons = make("COMPONENT_SET", page, "Icons");
    icons.key = "icons-key";
    let options: unknown;
    card.addComponentProperty = (_n: string, _t: string, _d: unknown, o?: unknown) => {
      options = o;
      return "Icon#4:0";
    };
    const r = await op("add_component_property", { componentId: card.id, name: "Icon", type: "INSTANCE_SWAP", defaultValue: star.id, bindNodeIds: [slotIcon.id], preferredValues: [star.id, icons.id] });
    expect(options).toEqual({ preferredValues: [{ type: "COMPONENT", key: "star-key" }, { type: "COMPONENT_SET", key: "icons-key" }] });
    expect(slotIcon.componentPropertyReferences).toEqual({ mainComponent: "Icon#4:0" });
    expect(r.preferredValues).toHaveLength(2);
  });

  it("preferred values on a TEXT property are refused before anything is added", async () => {
    const card = make("COMPONENT", page, "Card");
    card.addComponentProperty = () => {
      throw new Error("must not be called");
    };
    const e = await fails(op("add_component_property", { componentId: card.id, name: "Label", type: "TEXT", defaultValue: "a", preferredValues: [card.id] }));
    expect(e.message).toMatch(/belong to an INSTANCE_SWAP property/);
    expect(e.partial).toEqual({ created: [] });
  });
});

describe("edit_component_property / delete_component_property", () => {
  function editable() {
    const b = buttonSet();
    const edits: Array<[string, Record<string, unknown>]> = [];
    const defs = b.set.componentPropertyDefinitions as Record<string, unknown>;
    b.set.editComponentProperty = (key: string, v: Record<string, unknown>) => {
      edits.push([key, v]);
      if (typeof v.name !== "string") return key;
      const next = `${v.name}#1:0`;
      defs[next] = defs[key];
      delete defs[key];
      return next;
    };
    const deleted: string[] = [];
    b.set.deleteComponentProperty = (key: string) => deleted.push(key);
    return { ...b, edits, deleted };
  }

  it("a rename returns the new key, and new layers are wired to it in every variant", async () => {
    const { set, vs, labels, edits } = editable();
    const captions = vs.map((v) => make("TEXT", v, "Caption"));
    const r = await op("edit_component_property", { componentId: set.id, property: "Label", name: "Text", bindNodeIds: [captions[2]!.id] });
    expect(edits).toEqual([["Label#1:0", { name: "Text" }]]);
    expect(r).toMatchObject({ key: "Text#1:0", previousKey: "Label#1:0", type: "TEXT" });
    expect(r.bound).toHaveLength(4);
    expect(captions[0]!.componentPropertyReferences).toEqual({ characters: "Text#1:0" });
    // This fake leaves the old wiring on the old key, as Figma might [C-113]:
    // the labels are moved to the new key rather than left driving nothing.
    expect(r.rewired).toBe(4);
    expect(labels.map((l) => (l.componentPropertyReferences as { characters: string }).characters)).toEqual(Array(4).fill("Text#1:0"));
  });

  it("a rename that already carried the wiring along rewires nothing [C-113]", async () => {
    const { set, labels } = editable();
    const edit = set.editComponentProperty as (k: string, v: Record<string, unknown>) => string;
    set.editComponentProperty = (k: string, v: Record<string, unknown>) => {
      const next = edit(k, v);
      for (const l of labels) l.componentPropertyReferences = { characters: next };
      return next;
    };
    const r = await op("edit_component_property", { componentId: set.id, property: "Label", name: "Text" });
    expect(r.rewired).toBeUndefined();
  });

  it("unbinding a layer unbinds its twins in the other variants", async () => {
    const { set, labels } = editable();
    const r = await op("edit_component_property", { componentId: set.id, property: "Label#1:0", unbindNodeIds: [labels[1]!.id] });
    expect(r.unbound).toHaveLength(4);
    expect(labels.every((l) => !("characters" in (l.componentPropertyReferences as object)))).toBe(true);
  });

  it("a variant id is redirected to its set, and says so", async () => {
    const { set, vs } = editable();
    const r = await op("edit_component_property", { componentId: vs[0]!.id, property: "Label", defaultValue: "Go" });
    expect(r.componentId).toBe(set.id);
    expect(r.note).toMatch(/is a variant/);
  });

  it("Figma's rules are checked before any call: no default on a VARIANT, preferred values only on a swap", async () => {
    const { set, edits } = editable();
    const e = await fails(op("edit_component_property", { componentId: set.id, property: "Size", defaultValue: "Large" }));
    expect(e.message).toMatch(/A VARIANT property has no default/);
    expect(e.partial).toEqual({ created: [] });
    const p = await fails(op("edit_component_property", { componentId: set.id, property: "Label", preferredValues: [] }));
    expect(p.message).toMatch(/apply to INSTANCE_SWAP and SLOT/);
    const n = await fails(op("edit_component_property", { componentId: set.id, property: "Label" }));
    expect(n.message).toMatch(/Nothing to change/);
    expect(edits).toEqual([]);
  });

  it("an unknown property lists the ones that exist", async () => {
    const { set } = editable();
    const e = await fails(op("edit_component_property", { componentId: set.id, property: "Colour", name: "X" }));
    expect(e.hint).toMatch(/Label#1:0 \(TEXT\), Size \(VARIANT\)/);
  });

  it("delete refuses a VARIANT property and deletes a TEXT one", async () => {
    const { set, deleted } = editable();
    const e = await fails(op("delete_component_property", { componentId: set.id, property: "State" }));
    expect(e.message).toMatch(/VARIANT property/);
    expect(e.partial).toEqual({ created: [] });
    expect(deleted).toEqual([]);
    const r = await op("delete_component_property", { componentId: set.id, property: "Label" });
    expect(r).toEqual({ componentId: set.id, deleted: "Label#1:0", type: "TEXT" });
  });

  it("a library component is read-only", async () => {
    const { set } = editable();
    set.remote = true;
    const e = await fails(op("delete_component_property", { componentId: set.id, property: "Label" }));
    expect(e.message).toMatch(/library component: read-only/);
  });
});

// The sublayers of a nested instance reference THAT instance's main component
// (typings 6624): wiring one to the owner's key would fail after the property
// was already added or renamed.
describe("binding layers inside a nested instance", () => {
  it("a layer inside a nested instance is refused before the property exists; the instance itself is bindable", async () => {
    const card = make("COMPONENT", page, "Card");
    card.componentPropertyDefinitions = {};
    const button = make("INSTANCE", card, "Button");
    const label = make("TEXT", button, "Label");
    const added: string[] = [];
    card.addComponentProperty = (name: string) => {
      added.push(name);
      return `${name}#4:0`;
    };
    const e = await fails(op("add_component_property", { componentId: card.id, name: "CTA", type: "TEXT", defaultValue: "Buy", bindNodeIds: [label.id] }));
    expect(e.message).toContain(`is inside the nested instance \`${button.id}\` (Button)`);
    expect(e.hint).toMatch(/Bind the nested instance itself/);
    expect(e.partial).toEqual({ created: [] });
    expect(added).toEqual([]);
    expect(label.componentPropertyReferences).toBeUndefined();
    const r = await op("add_component_property", { componentId: card.id, name: "Show button", type: "BOOLEAN", defaultValue: "true", bindNodeIds: [button.id] });
    expect(r.bound).toEqual([button.id]);
    expect(button.componentPropertyReferences).toEqual({ visible: "Show button#4:0" });
  });

  it("edit_component_property refuses one too, before the rename lands", async () => {
    const { set, vs } = buttonSet();
    const edits: string[] = [];
    set.editComponentProperty = (key: string) => {
      edits.push(key);
      return key;
    };
    const icon = make("INSTANCE", vs[0], "Icon");
    const glyph = make("TEXT", icon, "Glyph");
    const e = await fails(op("edit_component_property", { componentId: set.id, property: "Label", name: "Text", bindNodeIds: [glyph.id] }));
    expect(e.message).toMatch(/is inside the nested instance/);
    expect(e.partial).toEqual({ created: [] });
    expect(edits).toEqual([]);
  });

  it("a twin that sits under a nested instance in another variant is not wired, and is reported", async () => {
    const set = make("COMPONENT_SET", page, "Chip");
    set.componentPropertyDefinitions = {};
    set.addComponentProperty = (name: string) => `${name}#5:0`;
    const plain = make("COMPONENT", set, "Kind=Plain");
    const label = make("TEXT", make("FRAME", plain, "Body"), "Label");
    const withIcon = make("COMPONENT", set, "Kind=Icon");
    const nested = make("TEXT", make("INSTANCE", withIcon, "Body"), "Label");
    const r = await op("add_component_property", { componentId: set.id, name: "Label", type: "TEXT", defaultValue: "Chip", bindNodeIds: [label.id] });
    expect(r.bound).toEqual([label.id]);
    expect(nested.componentPropertyReferences).toBeUndefined();
    expect(r.unmatched).toEqual([{ variant: "Kind=Icon", path: "Body / Label" }]);
  });
});

// ── descriptions [C-111] ────────────────────────────────────────────────────

describe("set_description", () => {
  beforeEach(() => {
    const style = { id: "S:abc,", name: "Brand", type: "PAINT", description: "", documentationLinks: [] as unknown[] };
    const variable = { id: "VariableID:1:2", name: "color/bg", description: "" };
    const remoteVar = { id: "VariableID:9:9", name: "lib/bg", description: "", remote: true };
    figma.getStyleByIdAsync = async (id: string) => (id === style.id ? style : null);
    figma.variables = { getVariableByIdAsync: async (id: string) => [variable, remoteVar].find((v) => v.id === id) ?? null };
    Object.assign(figma, { style, variable });
  });

  it("writes a style's description and one link — and finds a style id typed without its comma", async () => {
    // Measured live: a paint style has no descriptionMarkdown (assigning it threw
    // "object is not extensible"), so markdown on a style goes in as plain text.
    const style = figma.style as Record<string, unknown>;
    delete style.descriptionMarkdown;
    Object.preventExtensions(style);
    const r = await op("set_description", { targetId: "S:abc", description: "**Primary** brand colour", markdown: true, documentationLink: "https://example.com/brand" });
    expect(style.description).toBe("**Primary** brand colour");
    expect(r.markdown).toMatch(/written as plain text/);
    expect(style.documentationLinks).toEqual([{ uri: "https://example.com/brand" }]);
    expect(r).toMatchObject({ id: "S:abc,", type: "PAINT_STYLE", documentationLink: "https://example.com/brand" });
    await op("set_description", { targetId: "S:abc,", documentationLink: "" });
    expect(style.documentationLinks).toEqual([]);
  });

  it("writes a variable's plain description, and refuses a link on one", async () => {
    const r = await op("set_description", { targetId: "VariableID:1:2", description: "Page background" });
    expect(r).toMatchObject({ type: "VARIABLE", description: "Page background" });
    const e = await fails(op("set_description", { targetId: "VariableID:1:2", documentationLink: "https://example.com" }));
    expect(e.message).toMatch(/A variable has no documentation link/);
    expect(e.partial).toEqual({ created: [] });
    await expect(op("set_description", { targetId: "VariableID:9:9", description: "x" })).rejects.toThrow(/library variable/);
  });

  it("describes a set, notes a variant, refuses a frame and a plain-http link", async () => {
    const { set, vs } = buttonSet();
    const r = await op("set_description", { targetId: set.id, description: "Primary action" });
    expect([r.type, set.description]).toEqual(["COMPONENT_SET", "Primary action"]);
    expect((await op("set_description", { targetId: vs[0]!.id, description: "x" })).note).toMatch(/belongs on its set/);
    const frame = make("FRAME");
    await expect(op("set_description", { targetId: frame.id, description: "x" })).rejects.toThrow(/A FRAME carries no description/);
    const e = await fails(op("set_description", { targetId: set.id, documentationLink: "http://example.com" }));
    expect(e.message).toMatch(/one https:\/\/ address/);
  });

  it("convert_to_component takes a description too", async () => {
    figma.createComponentFromNode = (n: N) => {
      const c = make("COMPONENT", n.parent ?? page, n.name);
      n.remove();
      return c;
    };
    const f = make("FRAME", page, "Card");
    const r = (await CREATE_OPS.convert_to_component!.run(run({ nodeId: f.id, description: "A content card" }))) as { id: string; description: string };
    expect(byId.get(r.id)!.description).toBe("A content card");
    expect(r.description).toBe("A content card");
  });
});

// ── the variant grid ─────────────────────────────────────────────────────────

describe("combine_as_variants with columns", () => {
  beforeEach(() => {
    figma.combineAsVariants = (comps: N[], parent: N) => {
      const set = make("COMPONENT_SET", parent, "Component 1");
      set.layoutMode = "NONE";
      set.absoluteTransform = [[1, 0, 1000], [0, 1, 2000]];
      set.resizeWithoutConstraints = (w: number, h: number) => {
        set.width = w;
        set.height = h;
      };
      for (const c of comps) set.appendChild(c);
      set.componentPropertyDefinitions = {
        Size: { type: "VARIANT", variantOptions: ["Small", "Large"] },
        State: { type: "VARIANT", variantOptions: ["Default", "Hover"] },
      };
      return set;
    };
  });

  const comp = (name: string, w: number, h: number) => Object.assign(make("COMPONENT", page, name), { width: w, height: h });

  it("puts one State per column and one Size per row, in uniform cells, and returns page coordinates", async () => {
    const lh = comp("Size=Large, State=Hover", 120, 50);
    const sd = comp("Size=Small, State=Default", 100, 40);
    const ld = comp("Size=Large, State=Default", 110, 40);
    const sh = comp("Size=Small, State=Hover", 100, 40);
    const r = await op("combine_as_variants", { componentIds: [lh.id, sd.id, ld.id, sh.id], name: "Button", columns: "State", gap: 10, description: "Primary button" });
    const set = byId.get(r.id)!;
    expect([sd.x, sd.y, sh.x, sh.y, ld.x, ld.y, lh.x, lh.y]).toEqual([40, 40, 170, 40, 40, 100, 170, 100]);
    expect([set.width, set.height, set.layoutMode, set.description]).toEqual([330, 190, "NONE", "Primary button"]);
    expect(r.grid).toEqual({
      columns: [{ value: "Default", x: 1040 }, { value: "Hover", x: 1170 }],
      rows: [{ label: "Size=Small", y: 2040 }, { label: "Size=Large", y: 2100 }],
      cell: { width: 120, height: 50 },
    });
  });

  it("a column that is not a property of every variant is refused before combining", async () => {
    const a = comp("Size=Small, State=Default", 100, 40);
    const b = comp("Size=Large", 100, 40);
    const e = await fails(op("combine_as_variants", { componentIds: [a.id, b.id], columns: "State" }));
    expect(e.message).toMatch(/not a property of every variant \("Size=Large"\)/);
    expect(e.partial).toEqual({ created: [] });
    expect(page.children.some((c) => c.type === "COMPONENT_SET")).toBe(false);
  });
});

describe("combine_as_variants: a set Figma reports as broken", () => {
  let combined: number;
  beforeEach(() => {
    combined = 0;
    // A set with conflicting variants cannot report its properties.
    figma.combineAsVariants = (comps: N[], parent: N) => {
      combined++;
      const set = make("COMPONENT_SET", parent, "Component 1");
      set.layoutMode = "NONE";
      for (const c of comps) set.appendChild(c);
      Object.defineProperty(set, "componentPropertyDefinitions", { get: () => { throw new Error("Component set has existing errors"); } });
      return set;
    };
  });

  it("two components with the same values are refused before combining, whatever the order of their pairs", async () => {
    const a = make("COMPONENT", page, "Size=Small, State=Default");
    const b = make("COMPONENT", page, "Size=Large, State=Default");
    const c = make("COMPONENT", page, "State=Default,Size=Small");
    const e = await fails(op("combine_as_variants", { componentIds: [a.id, b.id, c.id], description: "Button" }));
    expect(e.message).toContain(`\`${a.id}\` and \`${c.id}\` are both "Size=Small, State=Default"`);
    expect(e.hint).toMatch(/figma_rename_node one of them/);
    expect(e.partial).toEqual({ created: [] });
    expect(combined).toBe(0);
  });

  it("a set whose properties cannot be read still comes back with its id, variants and layout", async () => {
    // Names that are not "Property=Value" have no values to compare up front.
    const a = make("COMPONENT", page, "Button");
    const b = make("COMPONENT", page, "Button");
    const r = await op("combine_as_variants", { componentIds: [a.id, b.id], name: "Button", description: "Primary" });
    const set = byId.get(r.id)!;
    expect([set.type, set.name, set.layoutMode, set.description]).toEqual(["COMPONENT_SET", "Button", "HORIZONTAL", "Primary"]);
    expect(r.variants).toEqual([{ id: a.id, name: "Button" }, { id: b.id, name: "Button" }]);
    expect(r).toMatchObject({ properties: {}, propertiesError: "Component set has existing errors", description: "Primary" });
    expect(r.hint).toMatch(/two variants with the same values: figma_rename_node one of them/);
  });
});

// ── slots [C-112] ───────────────────────────────────────────────────────────

describe("slots", () => {
  function card() {
    const c = make("COMPONENT", page, "Card");
    c.layoutMode = "VERTICAL";
    const defs: Record<string, unknown> = { "Title#1:0": { type: "TEXT", defaultValue: "Title" } };
    Object.defineProperty(c, "componentPropertyDefinitions", { get: () => ({ ...defs }) });
    let made = 0;
    c.createSlot = () => {
      made++;
      const s = make("SLOT", c, "Slot");
      s.layoutMode = "NONE";
      defs[`Slot#7:${made}`] = { type: "SLOT", defaultValue: "" };
      return s;
    };
    return { c, made: () => made };
  }

  it("create_slot names, lays out and sizes the slot, and finds its property key by diffing the definitions", async () => {
    const { c } = card();
    const r = await op("create_slot", { componentId: c.id, name: "Content", layout: "vertical", width: 320, height: 200, sizing: { horizontal: "fill" } });
    const slot = byId.get(r.slotId)!;
    expect([slot.name, slot.layoutMode, slot.width, slot.height, slot.layoutSizingHorizontal]).toEqual(["Content", "VERTICAL", 320, 200, "FILL"]);
    expect(r).toMatchObject({ propertyKey: "Slot#7:1", componentId: c.id });
  });

  it("refuses a set, a grid layout and a fill without auto-layout before the slot exists", async () => {
    const { c, made } = card();
    const { set } = buttonSet();
    expect((await fails(op("create_slot", { componentId: set.id }))).message).toMatch(/component set — pass one of its variants/);
    expect((await fails(op("create_slot", { componentId: c.id, layout: "grid" }))).message).toMatch(/refuses a grid layout on a slot/);
    c.layoutMode = "NONE";
    const e = await fails(op("create_slot", { componentId: c.id, sizing: { vertical: "fill" } }));
    expect(e.message).toMatch(/needs a component with auto-layout/);
    expect(e.partial).toEqual({ created: [] });
    expect(made()).toBe(0);
  });

  it("an editor without createSlot says which call is missing", async () => {
    const plain = make("COMPONENT", page, "Plain");
    const e = await fails(op("create_slot", { componentId: plain.id }));
    expect([e.code, e.message]).toEqual(["UNSUPPORTED", "ComponentNode.createSlot is not available in this Figma version."]);
  });

  it("a createSlot that Figma refuses changed nothing, and says so", async () => {
    // The method exists, so the feature check passes; the refusal comes from the call.
    const { c } = card();
    c.createSlot = () => {
      throw new Error("Slots are not enabled in this file");
    };
    const e = await fails(op("create_slot", { componentId: c.id, name: "Content" }));
    expect([e.code, e.message]).toEqual(["INVALID_PARAM", "Figma refused the slot: Slots are not enabled in this file"]);
    expect(e.partial).toEqual({ created: [] });
    expect(c.children).toEqual([]);
  });

  it("reset_slot resets slots per item", async () => {
    const slot = make("SLOT");
    let resets = 0;
    slot.resetSlot = () => resets++;
    const frame = make("FRAME");
    const r = await op("reset_slot", { nodeIds: [slot.id, frame.id, "9:999"] });
    expect(resets).toBe(1);
    expect(r.reset).toBe(1);
    expect(r.items).toEqual([{ id: slot.id, ok: true }, { id: frame.id, ok: false, error: "a FRAME is not a slot" }, { id: "9:999", ok: false, error: "not found" }]);
  });

  it("set_instance_properties refuses a SLOT and points at the slot layer [C-112]", async () => {
    const inst = make("INSTANCE", page, "Card");
    const slot = make("SLOT", inst, "Content");
    inst.componentProperties = { "Content#7:1": { type: "SLOT", value: "" }, "Title#1:0": { type: "TEXT", value: "Hi" } };
    inst.setProperties = () => {
      throw new Error("cannotSetSlotProperty");
    };
    const e = await fails(op("set_instance_properties", { nodeId: inst.id, properties: '{"Title":"Hello","Content":"x"}' }));
    expect(e.message).toMatch(/"Content#7:1" is a SLOT/);
    expect(e.hint).toContain(`Content (${slot.id})`);
    expect(e.partial).toEqual({ created: [] });
  });
});

// ── the MCP side ─────────────────────────────────────────────────────────────

const FORBIDDEN = ["anyOf", "oneOf", "allOf", "$ref", "propertyNames", "const", "format"];
function portable(schema: Record<string, unknown>, path: string): string[] {
  const out = FORBIDDEN.filter((k) => k in schema).map((k) => `${path}: uses ${k}`);
  if (schema.type === "object") {
    for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) out.push(...portable(v, `${path}.${k}`));
  }
  if (schema.type === "array") out.push(...portable(schema.items as Record<string, unknown>, `${path}[]`));
  return out;
}

describe("registerComponents", () => {
  async function connected() {
    const calls: Array<{ op: string; params: Record<string, unknown>; opts: Record<string, unknown> }> = [];
    const bridge = {
      request: async (o: string, params: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ op: o, params, opts });
        return { done: o };
      },
    } as unknown as Bridge;
    const server = new McpServer({ name: "t", version: "0" });
    registerComponents(server, bridge, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, calls };
  }

  it("registers the seven tools with portable schemas and whole descriptions", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "figma_create_slot", "figma_delete_component_property", "figma_edit_component_property", "figma_get_component",
      "figma_import_library_assets", "figma_reset_slot", "figma_set_description",
    ]);
    for (const t of tools) {
      expect(portable(t.inputSchema as Record<string, unknown>, t.name)).toEqual([]);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
      expect(t.description).toMatch(/\.$/); // never cut by fitDescription
    }
    const get = tools.find((t) => t.name === "figma_get_component")!;
    expect(get.annotations?.readOnlyHint).toBe(true);
    expect(get.inputSchema.properties).not.toHaveProperty("idempotencyKey");
    const del = tools.find((t) => t.name === "figma_delete_component_property")!;
    expect(del.annotations?.readOnlyHint).toBe(false);
    expect(del.inputSchema.properties).toHaveProperty("idempotencyKey");
  });

  it("set_description sends each kind it takes to the tool that can rename it", async () => {
    // figma_rename_node resolves scene nodes only: a style or variable id is NODE_NOT_FOUND there.
    const { client } = await connected();
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "figma_set_description")!.description!;
    expect(d).not.toMatch(/Names change with figma_rename_node/);
    expect(d).toContain("a component or set with figma_rename_node");
    expect(d).toContain("a style with figma_update_style `name`");
    expect(d).toContain("a variable with figma_set_variable_properties `name`");
  });

  it("forwards each call as its op, with the caller's retry key", async () => {
    const { client, calls } = await connected();
    const r = (await client.callTool({ name: "figma_import_library_assets", arguments: { assets: [{ kind: "style", key: "k" }], idempotencyKey: "lib-1" } })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ op: "import_library_assets", params: { assets: [{ kind: "style", key: "k" }] }, opts: { idempotencyKey: "lib-1" } });
    const bad = (await client.callTool({ name: "figma_create_slot", arguments: { componentId: "1:2", layout: "grid" } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
