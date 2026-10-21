// The content side of trust's attribution (src/plugin/echo.ts): per-property
// hashes of what the agent last saw, binding-aware, and the resource watch
// over variables and styles. trust-plugin.test.ts runs them through the
// tracker; this file pins the hashing itself.

import { describe, expect, it } from "vitest";
import {
  GEOMETRY_PROPS, MODES, NODE_PROPS, changedBetween, dependentsOf, explainedBy, hashProp, modesHash, noteChange, readResources,
  removedRecord, snapshot, unchangedSince,
} from "../src/plugin/echo.js";

type Node = Record<string, unknown> & { id: string; type: string };

const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
const solid = (r: number, g: number, b: number, extra: Record<string, unknown> = {}) => ({
  type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b }, ...extra,
});
const boundSolid = (variableId: string, r: number, g: number, b: number) => solid(r, g, b, { boundVariables: { color: alias(variableId) } });

function frame(id: string, extra: Record<string, unknown> = {}): Node {
  return { id, type: "FRAME", name: `Frame ${id}`, x: 0, y: 0, width: 100, height: 50, visible: true, opacity: 1, fills: [solid(1, 1, 1)], ...extra };
}

const NONE = new Set<string>();

describe("hashProp: binding-aware", () => {
  it("a paint bound to a variable hashes as the variable: a new value changes nothing, a rebinding does", () => {
    const n = frame("1:1", { fills: [boundSolid("V:1", 1, 0, 0)] });
    const before = hashProp(n, "fills")!;
    expect(before).toMatchObject({ bound: true, refs: ["V:1"], linked: true });
    n.fills = [boundSolid("V:1", 0, 0, 1)];
    expect(hashProp(n, "fills")!.hash).toBe(before.hash);
    n.fills = [boundSolid("V:2", 0, 0, 1)];
    expect(hashProp(n, "fills")!.hash).not.toBe(before.hash);
    n.fills = [solid(0, 0, 1)];
    expect(hashProp(n, "fills")).toMatchObject({ bound: false, refs: [], linked: false });
  });

  it("a raw paint hashes its colour and opacity; a bound one keeps its own opacity", () => {
    const n = frame("1:1");
    const a = hashProp(n, "fills")!.hash;
    n.fills = [solid(1, 1, 0.99)];
    expect(hashProp(n, "fills")!.hash).not.toBe(a);
    n.fills = [boundSolid("V:1", 1, 0, 0)];
    const bound = hashProp(n, "fills")!.hash;
    n.fills = [{ ...boundSolid("V:1", 1, 0, 0), opacity: 0.5 }];
    expect(hashProp(n, "fills")!.hash).not.toBe(bound);
  });

  it("a property linked to a style hashes as the style; a node-level binding as its variable", () => {
    const n = frame("1:1", { fillStyleId: "S:paint", boundVariables: { width: alias("V:w") }, width: 100 });
    const fills = hashProp(n, "fills")!;
    expect(fills).toMatchObject({ bound: true, refs: ["S:paint"], linked: true });
    n.fills = [solid(0, 0, 0)];
    expect(hashProp(n, "fills")!.hash).toBe(fills.hash);
    const width = hashProp(n, "width")!;
    n.width = 240;
    expect(hashProp(n, "width")).toMatchObject({ hash: width.hash, bound: true, refs: ["V:w"] });
    n.boundVariables = {};
    expect(hashProp(n, "width")!.hash).not.toBe(width.hash);
  });

  it("a text linked to a text style hashes its font fields as the style; its characters as themselves", () => {
    const t: Node = { id: "2:1", type: "TEXT", characters: "Hi", fontSize: 16, fontName: { family: "Inter", style: "Regular" }, textStyleId: "S:body" };
    const size = hashProp(t, "fontSize")!.hash;
    t.fontSize = 18; // the style was updated
    expect(hashProp(t, "fontSize")!.hash).toBe(size);
    const chars = hashProp(t, "characters")!.hash;
    t.characters = "Hello";
    expect(hashProp(t, "characters")!.hash).not.toBe(chars);
  });

  it("a property the node does not have is undefined; figma.mixed reads as mixed; Figma's `stokeTopWeight` reads strokeTopWeight", () => {
    const n = frame("1:1", { cornerRadius: Symbol("mixed"), strokeTopWeight: 2 });
    expect(hashProp(n, "characters")).toBeUndefined();
    expect(hashProp(n, "cornerRadius")).toBeDefined();
    expect(hashProp(n, "stokeTopWeight")).toBeDefined();
  });

  it("parent: the parent and the place among its children, so a reorder is a change", () => {
    const p: Node = { id: "1:0", type: "FRAME", children: [] as Node[] };
    const a = frame("1:1", { parent: p });
    const b = frame("1:2", { parent: p });
    p.children = [a, b];
    const first = hashProp(a, "parent")!.hash;
    p.children = [b, a];
    expect(hashProp(a, "parent")!.hash).not.toBe(first);
  });

  it("text segments: the newest field set, or the basic one where Figma refuses a field", () => {
    const segs = [{ characters: "Hi", start: 0, end: 2, fontSize: 16 }];
    const t: Node = {
      id: "2:1", type: "TEXT",
      getStyledTextSegments(fields: string[]) {
        if (fields.includes("textStyleOverrides")) throw new Error("unknown field");
        return segs;
      },
    };
    const h = hashProp(t, "styledTextSegments")!.hash;
    segs[0]!.fontSize = 20;
    expect(hashProp(t, "styledTextSegments")!.hash).not.toBe(h);
  });

  it("plugin data: this plugin's keys and a hash of each whole value", () => {
    const data: Record<string, string> = { brief: "x".repeat(50_000) };
    const n: Node = {
      id: "1:1", type: "FRAME",
      getPluginDataKeys: () => Object.keys(data),
      getPluginData: (k: string) => data[k] ?? "",
      getSharedPluginDataKeys: () => [],
      getSharedPluginData: () => "",
    };
    const h = hashProp(n, "pluginData")!.hash;
    data.brief = `${"x".repeat(49_999)}y`; // past the text cap: the value's own hash still changes
    expect(hashProp(n, "pluginData")!.hash).not.toBe(h);
  });
});

describe("records", () => {
  it("geometry takes position, size and place only; full takes every property; a partial record keeps the rest", () => {
    const n = frame("1:1", { name: "Card" });
    const geo = snapshot(n, "geometry");
    expect(geo.full).toBe(false);
    n.name = "Renamed";
    expect(unchangedSince(geo, n, ["x", "width"], NONE)).toBe(true);
    expect(unchangedSince(geo, n, ["name"], NONE)).toBe(false); // never recorded: not vouched for
    expect(unchangedSince(geo, n, undefined, NONE)).toBe(false); // an unknown change needs a full record
    const full = snapshot(n, "full");
    expect(unchangedSince(full, n, undefined, NONE)).toBe(true);
    n.x = 10;
    snapshot(n, "geometry", undefined, full); // a later write moved it
    expect(full.full).toBe(true);
    expect(unchangedSince(full, n, ["name", "x"], NONE)).toBe(true);
    expect(GEOMETRY_PROPS).toEqual(["x", "y", "width", "height", "rotation", "relativeTransform", "parent"]);
  });

  it("binding takes the bound values and the modes under a node the agent wrote, never a raw value", () => {
    const n = frame("1:1", { fills: [boundSolid("V:1", 1, 0, 0)], strokes: [solid(0, 0, 0)], resolvedVariableModes: { C: "light" } });
    const rec = snapshot(n, "binding");
    expect(unchangedSince(rec, n, ["fills"], NONE)).toBe(true);
    expect(unchangedSince(rec, n, ["strokes"], NONE)).toBe(false);
    n.resolvedVariableModes = { C: "dark" }; // a mode switched above it, not by the agent
    expect(unchangedSince(rec, n, ["fills"], NONE)).toBe(false);
  });

  it("a full record vouches for a property absent then and now, never for one this build does not know", () => {
    const n = frame("1:1");
    const rec = snapshot(n, "full");
    expect(unchangedSince(rec, n, ["characters"], NONE)).toBe(true);
    n.characters = "Now it has text";
    expect(unchangedSince(rec, n, ["characters"], NONE)).toBe(false);
    expect(unchangedSince(rec, n, ["someFutureProperty"], NONE)).toBe(false);
  });

  it("a bound value is compared with the modes it was seen in", () => {
    const n = frame("1:1", { fills: [boundSolid("V:1", 1, 0, 0)], resolvedVariableModes: { C: "light" } });
    const rec = noteChange(n, ["fills"]);
    expect(unchangedSince(rec, n, ["fills"], NONE)).toBe(true);
    n.resolvedVariableModes = { C: "dark" };
    expect(unchangedSince(rec, n, ["fills"], NONE)).toBe(false);
    expect(modesHash(n)).not.toBe(modesHash({ resolvedVariableModes: { C: "light" } }));
    expect(NODE_PROPS).not.toContain(MODES);
  });

  it("a removed record is a deletion the agent made", () => {
    expect(removedRecord()).toMatchObject({ removed: true, full: true });
  });
});

describe("explainedBy: a re-colouring of a node with no record", () => {
  it("only when every value it names follows variables or styles the agent changed", () => {
    const n = frame("1:1", { fills: [boundSolid("V:1", 0, 0, 1)], strokes: [boundSolid("V:1", 0, 0, 1), solid(0, 0, 0)] });
    expect(explainedBy(n, ["fills"], new Set(["V:1"]))).toBe(true);
    expect(explainedBy(n, ["fills"], new Set(["V:2"]))).toBe(false);
    expect(explainedBy(n, ["strokes"], new Set(["V:1"]))).toBe(false); // one paint is raw
    expect(explainedBy(n, ["fills", "name"], new Set(["V:1"]))).toBe(false);
    expect(explainedBy(n, ["fills"], NONE)).toBe(false);
  });
});

describe("the resource watch", () => {
  function api() {
    const primitive = { id: "V:p", name: "orange/500", resolvedType: "COLOR", valuesByMode: { m: { r: 1, g: 0.4, b: 0, a: 1 } } };
    const semantic = { id: "V:s", name: "color/accent", resolvedType: "COLOR", valuesByMode: { m: alias("V:p") } };
    const other = { id: "V:o", name: "space/4", resolvedType: "FLOAT", valuesByMode: { m: 16 } };
    const style = { id: "S:1", name: "Accent fill", type: "PAINT", paints: [boundSolid("V:s", 1, 0.4, 0)] };
    const collection = { id: "C:1", name: "Tokens", modes: [{ modeId: "m", name: "Light" }], variableIds: ["V:p", "V:s", "V:o"] };
    const figma = {
      variables: {
        getLocalVariablesAsync: async () => [primitive, semantic, other],
        getLocalVariableCollectionsAsync: async () => [collection],
      },
      getLocalPaintStylesAsync: async () => [style],
    };
    return { figma, primitive, semantic, other, style, collection };
  }

  it("reads variables, collections and styles; a change, an addition or a removal shows", async () => {
    const a = api();
    const before = (await readResources(a.figma))!;
    expect([...before.items.keys()].sort()).toEqual(["C:1", "S:1", "V:o", "V:p", "V:s"]);
    a.primitive.valuesByMode = { m: { r: 0, g: 0, b: 1, a: 1 } };
    a.collection.name = "Tokens 2";
    const after = (await readResources(a.figma))!;
    expect(changedBetween(before, after).map((c) => c.id).sort()).toEqual(["C:1", "V:p"]);
    expect(changedBetween(after, after)).toEqual([]);
  });

  it("what resolves through a changed variable: the alias, and the style that binds it", async () => {
    const a = api();
    const state = (await readResources(a.figma))!;
    expect([...dependentsOf(["V:p"], state)].sort()).toEqual(["S:1", "V:p", "V:s"]);
    expect([...dependentsOf(["V:o"], state)]).toEqual(["V:o"]);
  });

  it("nothing to read in an editor without the APIs", async () => {
    expect(await readResources({})).toBeNull();
    expect(await readResources({ variables: { getLocalVariablesAsync: async () => Promise.reject(new Error("no")) } })).toBeNull();
  });
});
