// A fake `figma` for the design-token ops, shaped after @figma/plugin-typings
// 1.141.0 where it matters to them:
//   - variables.createVariable(name, collectionOBJECT, type) — the id form throws
//     under documentAccess "dynamic-page";
//   - codeSyntax is read-only, changed through setVariableCodeSyntax /
//     removeVariableCodeSyntax [C-106];
//   - setExplicitVariableModeForCollection / clear… take the collection OBJECT;
//     the string-id overload throws under dynamic-page [C-105];
//   - setBoundVariableForPaint / Effect / LayoutGrid return a bound COPY [C-108];
//   - a style is one object its consumers point at by id, so "in place" can be
//     checked by identity.

import type { OpContext } from "../src/plugin/ops/index.js";

type Any = Record<string, unknown>;
let seq = 1;

export interface Mode {
  modeId: string;
  name: string;
}

export class FakeCollection {
  id = `VariableCollectionId:${seq++}`;
  key = `ckey-${seq}`;
  remote = false;
  hiddenFromPublishing = false;
  isExtension = false;
  modes: Mode[];
  defaultModeId: string;
  constructor(public name: string, private world: World) {
    const m0 = { modeId: `${this.id}/m0`, name: "Mode 1" };
    this.modes = [m0];
    this.defaultModeId = m0.modeId;
  }
  get variableIds(): string[] {
    return [...this.world.variables.values()].filter((v) => v.variableCollectionId === this.id).map((v) => v.id);
  }
  addMode(name: string): string {
    if (!this.world.paid) throw new Error("in addMode: Limited to 1 modes only");
    const modeId = `${this.id}/m${this.modes.length}`;
    this.modes.push({ modeId, name });
    return modeId;
  }
  renameMode(modeId: string, name: string) {
    const m = this.modes.find((x) => x.modeId === modeId);
    if (!m) throw new Error("no such mode");
    m.name = name;
  }
  removeMode(modeId: string) {
    this.modes = this.modes.filter((m) => m.modeId !== modeId);
    for (const v of this.world.variables.values()) delete v.valuesByMode[modeId];
  }
}

export class FakeVariable {
  id = `VariableID:${seq++}`;
  key = `vkey-${seq}`;
  remote = false;
  description = "";
  hiddenFromPublishing = false;
  scopes: string[] = ["ALL_SCOPES"];
  codeSyntax: Record<string, string> = {};
  valuesByMode: Record<string, unknown> = {};
  calls: string[] = [];
  constructor(public name: string, public variableCollectionId: string, public resolvedType: string, private world: World) {}
  setValueForMode(modeId: string, value: unknown) {
    this.valuesByMode[modeId] = value;
  }
  setVariableCodeSyntax(platform: string, value: string) {
    this.calls.push(`set ${platform}`);
    this.codeSyntax[platform] = value;
  }
  removeVariableCodeSyntax(platform: string) {
    this.calls.push(`remove ${platform}`);
    delete this.codeSyntax[platform];
  }
  /** The consumer's explicit mode for this collection, else the default; aliases followed. */
  resolveForConsumer(consumer: FakeNode): { value: unknown; resolvedType: string } {
    const col = this.world.collections.get(this.variableCollectionId);
    let mode = col?.defaultModeId ?? "";
    for (let n: FakeNode | null = consumer; n; n = n.parent) {
      const pinned = n.explicitVariableModes[this.variableCollectionId];
      if (pinned) {
        mode = pinned;
        break;
      }
    }
    const value = this.valuesByMode[mode];
    if (value && typeof value === "object" && (value as Any).type === "VARIABLE_ALIAS") {
      return this.world.variables.get((value as Any).id as string)!.resolveForConsumer(consumer);
    }
    return { value, resolvedType: this.resolvedType };
  }
}

export class FakeNode {
  id = `9:${seq++}`;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  explicitVariableModes: Record<string, string> = {};
  modeCalls: Array<{ fn: string; arg: string }> = [];
  bound: Record<string, string> = {};
  [k: string]: unknown;
  constructor(public type: string, public name = type) {}
  appendChild(c: FakeNode) {
    this.children.push(c);
    c.parent = this;
    return c;
  }
  setExplicitVariableModeForCollection(collection: unknown, modeId: string) {
    if (typeof collection === "string") throw new Error("setExplicitVariableModeForCollection(collectionId) throws under dynamic-page");
    this.modeCalls.push({ fn: "set", arg: typeof collection });
    this.explicitVariableModes[(collection as FakeCollection).id] = modeId;
  }
  clearExplicitVariableModeForCollection(collection: unknown) {
    if (typeof collection === "string") throw new Error("clearExplicitVariableModeForCollection(collectionId) throws under dynamic-page");
    this.modeCalls.push({ fn: "clear", arg: typeof collection });
    delete this.explicitVariableModes[(collection as FakeCollection).id];
  }
  findAllWithCriteria(c: { types: string[] }): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => n.children.forEach((k) => (c.types.includes(k.type) && out.push(k), walk(k)));
    walk(this);
    return out;
  }
  setBoundVariable(field: string, v: { id: string } | string) {
    if (typeof v === "string") throw new Error("setBoundVariable with an id string throws under dynamic-page");
    this.bound[field] = v.id;
  }
}

export interface World {
  paid: boolean;
  page: FakeNode;
  nodes: Map<string, FakeNode>;
  collections: Map<string, FakeCollection>;
  variables: Map<string, FakeVariable>;
  styles: Map<string, Any>;
  fontsLoaded: string[];
  /** Families loadFontAsync refuses. */
  missingFonts: Set<string>;
  teamLibrary: Any | undefined;
  figma: Any;
}

export let w: World;

const alias = (v: { id: string }) => ({ type: "VARIABLE_ALIAS", id: v.id });

export function install(): World {
  const page = new FakeNode("PAGE", "Page 1");
  const world: World = {
    paid: false,
    page,
    nodes: new Map([[page.id, page]]),
    collections: new Map(),
    variables: new Map(),
    styles: new Map(),
    fontsLoaded: [],
    missingFonts: new Set(),
    teamLibrary: undefined,
    figma: {},
  };
  const style = (type: string) => () => {
    const s: Any = { id: `S:${seq++},`, key: `skey-${seq}`, name: "", type, description: "", remote: false };
    if (type === "TEXT") {
      s.fontName = { family: "Inter", style: "Regular" };
      s.fontSize = 12;
      s.lineHeight = { unit: "AUTO" };
      s.letterSpacing = { unit: "PIXELS", value: 0 };
      s.textCase = "ORIGINAL";
      s.textDecoration = "NONE";
      s.paragraphSpacing = 0;
      s.paragraphIndent = 0;
      s.boundVariables = {};
      s.setBoundVariable = (field: string, v: { id: string } | string) => {
        if (typeof v === "string") throw new Error("ids are not supported");
        (s.boundVariables as Any)[field] = alias(v);
      };
    }
    if (type === "PAINT") s.paints = [];
    if (type === "EFFECT") s.effects = [];
    if (type === "GRID") s.layoutGrids = [];
    world.styles.set(s.id as string, s);
    return s;
  };
  const figma: Any = {
    currentPage: page,
    root: { name: "Doc", children: [page] },
    async getNodeByIdAsync(id: string) {
      return world.nodes.get(id) ?? null;
    },
    async loadFontAsync(f: { family: string; style: string }) {
      if (world.missingFonts.has(f.family)) throw new Error(`font ${f.family} not found`);
      world.fontsLoaded.push(`${f.family} ${f.style}`);
    },
    async listAvailableFontsAsync() {
      return [];
    },
    async getStyleByIdAsync(id: string) {
      return world.styles.get(id) ?? null;
    },
    getLocalPaintStylesAsync: async () => [...world.styles.values()].filter((s) => s.type === "PAINT" && !s.remote),
    getLocalTextStylesAsync: async () => [...world.styles.values()].filter((s) => s.type === "TEXT" && !s.remote),
    getLocalEffectStylesAsync: async () => [...world.styles.values()].filter((s) => s.type === "EFFECT" && !s.remote),
    getLocalGridStylesAsync: async () => [...world.styles.values()].filter((s) => s.type === "GRID" && !s.remote),
    createPaintStyle: style("PAINT"),
    createTextStyle: style("TEXT"),
    createEffectStyle: style("EFFECT"),
    createGridStyle: style("GRID"),
    get teamLibrary() {
      return world.teamLibrary;
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return [...world.collections.values()].filter((c) => !c.remote);
      },
      async getLocalVariablesAsync() {
        return [...world.variables.values()].filter((v) => !v.remote);
      },
      async getVariableByIdAsync(id: string) {
        return world.variables.get(id) ?? null;
      },
      async getVariableCollectionByIdAsync(id: string) {
        return world.collections.get(id) ?? null;
      },
      createVariableCollection(name: string) {
        const c = new FakeCollection(name, world);
        world.collections.set(c.id, c);
        return c;
      },
      createVariable(name: string, collection: unknown, type: string) {
        if (typeof collection === "string") throw new Error("createVariable(name, collectionId) throws under dynamic-page");
        const v = new FakeVariable(name, (collection as FakeCollection).id, type, world);
        world.variables.set(v.id, v);
        return v;
      },
      setBoundVariableForPaint(paint: Any, field: string, v: { id: string }) {
        if (paint.type !== "SOLID") throw new Error("only solid paints");
        return { ...paint, boundVariables: { ...((paint.boundVariables as Any) ?? {}), [field]: alias(v) } };
      },
      setBoundVariableForEffect(effect: Any, field: string, v: { id: string }) {
        return { ...effect, boundVariables: { ...((effect.boundVariables as Any) ?? {}), [field]: alias(v) } };
      },
      setBoundVariableForLayoutGrid(grid: Any, field: string, v: { id: string }) {
        return { ...grid, boundVariables: { ...((grid.boundVariables as Any) ?? {}), [field]: alias(v) } };
      },
    },
  };
  world.figma = figma;
  (globalThis as { figma?: unknown }).figma = figma;
  w = world;
  return world;
}

export function uninstall(): void {
  delete (globalThis as { figma?: unknown }).figma;
}

export function collection(name: string, modes: string[] = []): FakeCollection {
  const c = new FakeCollection(name, w);
  w.collections.set(c.id, c);
  if (modes[0]) c.modes[0]!.name = modes[0];
  for (const m of modes.slice(1)) {
    const was = w.paid;
    w.paid = true;
    c.addMode(m);
    w.paid = was;
  }
  return c;
}

export function variable(name: string, c: FakeCollection, type: string, values: unknown[] = []): FakeVariable {
  const v = new FakeVariable(name, c.id, type, w);
  values.forEach((value, i) => (v.valuesByMode[c.modes[i]!.modeId] = value));
  w.variables.set(v.id, v);
  return v;
}

export function node(type: string, parent: FakeNode = w.page, props: Any = {}): FakeNode {
  const n = Object.assign(new FakeNode(type, (props.name as string) ?? type), props);
  w.nodes.set(n.id, n);
  parent.appendChild(n);
  return n;
}

export function text(chars: string, parent: FakeNode = w.page, font = { family: "Inter", style: "Regular" }): FakeNode {
  return node("TEXT", parent, {
    characters: chars,
    fontName: font,
    fontSize: 16,
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    getRangeAllFontNames: () => [font],
  });
}

export function addStyle(type: string, props: Any): Any {
  const s = (w.figma[`create${type.charAt(0)}${type.slice(1).toLowerCase()}Style`] as () => Any)();
  return Object.assign(s, props);
}

export const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r",
  params,
  yieldToHost: async () => {},
  progress() {},
  isCancelled: () => false,
});

export { alias };
