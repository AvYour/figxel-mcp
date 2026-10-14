// Design tokens as a design system needs them [C-105] [C-106] [C-108]: scopes
// and code syntax set at creation, a token set in one call with aliases,
// collections and modes edited in place, a mode shown on a frame, styles
// updated without detaching their consumers, and variables bound inside
// effects, grids and text — against the fake in token-fakes.ts, which follows
// @figma/plugin-typings 1.141.0 where it matters.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { bindField } from "../src/plugin/bind.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { STYLE_OPS } from "../src/plugin/ops/style.js";
import { TOKEN_OPS } from "../src/plugin/ops/tokens.js";
import { VARIABLE_OPS } from "../src/plugin/ops/variable.js";
import { checkScopes } from "../src/plugin/tokens.js";
import type { Bridge } from "../src/server/bridge.js";
import { registerTokens } from "../src/server/tools/tokens.js";
import { addStyle, alias, collection, ctx, install, node, text, uninstall, variable, w } from "./token-fakes.js";

const OPS = { ...CREATE_OPS, ...STYLE_OPS, ...VARIABLE_OPS, ...TOKEN_OPS };
type Result = Record<string, unknown> & { items?: Array<Record<string, unknown>> };
const run = (op: string, params: Record<string, unknown>) => OPS[op]!.run(ctx(params)) as Promise<Result>;
async function fails(op: string, params: Record<string, unknown>): Promise<BridgeError> {
  try {
    await run(op, params);
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error(`expected ${op} to fail`);
}
const nothingChanged = (e: BridgeError) => expect(e.partial).toEqual({ created: [] });

beforeEach(() => {
  install();
});
afterEach(() => uninstall());

// ── scopes, code syntax, aliases at creation [C-106] ────────────────────────

describe("figma_create_variable: scopes, code syntax and aliases checked before the variable exists", () => {
  it("refuses a scope the type cannot take, and the exclusive pairs, creating nothing", async () => {
    const c = collection("Tokens");
    for (const scopes of [["GAP"], ["ALL_FILLS", "FRAME_FILL"], ["ALL_SCOPES", "STROKE_COLOR"]]) {
      const err = await fails("create_variable", { collectionId: c.id, name: "color/x", type: "COLOR", value: "#ff0000", scopes });
      nothingChanged(err);
    }
    expect((await fails("create_variable", { collectionId: c.id, name: "c", type: "COLOR", value: "#000", scopes: ["GAP"] })).hint).toMatch(/FRAME_FILL/);
    expect(w.variables.size).toBe(0);
  });

  it("follows Figma's own table: TEXT_CONTENT and COLOR_OPACITY are FLOAT scopes, ALL_FILLS mixes with STROKE_COLOR", () => {
    expect(checkScopes("FLOAT", ["TEXT_CONTENT", "COLOR_OPACITY"])).toEqual(["TEXT_CONTENT", "COLOR_OPACITY"]);
    expect(checkScopes("COLOR", ["ALL_FILLS", "STROKE_COLOR"])).toEqual(["ALL_FILLS", "STROKE_COLOR"]);
    expect(() => checkScopes("BOOLEAN", ["ALL_SCOPES"])).toThrow(/cannot be scoped/);
    expect(checkScopes("BOOLEAN", [])).toEqual([]);
  });

  it("sets scopes ([] hides a primitive), code syntax, description and publishing on the new variable", async () => {
    const c = collection("Tokens");
    const r = await run("create_variable", {
      collectionId: c.id, name: "color/blue/500", type: "COLOR", value: "#3b82f6", scopes: [],
      codeSyntax: { WEB: "var(--color-blue-500)", iOS: "" }, description: "Brand blue", hiddenFromPublishing: true,
    });
    const v = w.variables.get(r.id as string)!;
    expect(v.scopes).toEqual([]);
    expect(v.codeSyntax).toEqual({ WEB: "var(--color-blue-500)" });
    expect(v.calls).toEqual(["set WEB"]); // "" on a platform that is not set is not a change
    expect(v.description).toBe("Brand blue");
    expect(v.hiddenFromPublishing).toBe(true);
    expect(r.properties).toEqual(["scopes", "codeSyntax.WEB", "description", "hiddenFromPublishing"]);
  });

  it('"alias:<name>" aliases a variable of the same type — for STRING too, which used to store the text literally', async () => {
    const c = collection("Tokens");
    const blue = variable("color/blue/500", c, "COLOR", [{ r: 0, g: 0, b: 1, a: 1 }]);
    const r = await run("create_variable", { collectionId: c.id, name: "color/bg/brand", type: "COLOR", value: "alias:color/blue/500" });
    expect(w.variables.get(r.id as string)!.valuesByMode[c.modes[0]!.modeId]).toEqual(alias(blue));

    const family = variable("font/family/base", c, "STRING", ["Inter"]);
    const s = await run("create_variable", { collectionId: c.id, name: "font/family/heading", type: "STRING", value: "alias:font/family/base" });
    expect(w.variables.get(s.id as string)!.valuesByMode[c.modes[0]!.modeId]).toEqual(alias(family));
    const missing = await fails("create_variable", { collectionId: c.id, name: "font/x", type: "STRING", value: "alias:font/nope" });
    expect(missing.message).toMatch(/no variable named "font\/nope"/);
    nothingChanged(missing);
    expect((await fails("create_variable", { collectionId: c.id, name: "n", type: "FLOAT", value: "alias:color/blue/500" })).message).toMatch(/same type/);
  });

  it("refuses a name the collection already has instead of making a silent duplicate", async () => {
    const c = collection("Tokens");
    variable("space/4", c, "FLOAT", [16]);
    const err = await fails("create_variable", { collectionId: c.id, name: "space/4", type: "FLOAT", value: "8" });
    expect(err.message).toMatch(/already has a variable named "space\/4"/);
    nothingChanged(err);
  });

  it("a mode by name as well as by id", async () => {
    w.paid = true;
    const c = collection("Theme", ["Light", "Dark"]);
    const r = await run("create_variable", { collectionId: c.id, name: "bg", type: "COLOR", value: "#000000", modeId: "Dark" });
    expect(r.modeId).toBe(c.modes[1]!.modeId);
  });
});

// ── figma_create_variables ──────────────────────────────────────────────────

describe("figma_create_variables: a token set in one call", () => {
  it("primitives then semantic aliases in one call, aliases resolved to the variables just created", async () => {
    const c = collection("Tokens", ["Default"]);
    const r = await run("create_variables", {
      collectionId: c.id,
      variables: [
        { name: "color/blue/500", type: "COLOR", values: [{ mode: "Default", value: "#3b82f6" }], scopes: [] },
        { name: "color/gray/900", type: "COLOR", values: [{ mode: "Default", value: "#111827" }], scopes: [] },
        {
          name: "color/bg/brand", type: "COLOR", values: [{ mode: "Default", value: "alias:color/blue/500" }],
          scopes: ["ALL_FILLS"], codeSyntax: { WEB: "var(--color-bg-brand)" },
        },
      ],
    });
    expect(r).toMatchObject({ created: 3, skipped: 0, updated: 0 });
    const byName = new Map([...w.variables.values()].map((v) => [v.name, v]));
    const brand = byName.get("color/bg/brand")!;
    expect(brand.valuesByMode[c.modes[0]!.modeId]).toEqual(alias(byName.get("color/blue/500")!));
    expect(brand.scopes).toEqual(["ALL_FILLS"]);
    expect(brand.codeSyntax).toEqual({ WEB: "var(--color-bg-brand)" });
    expect(byName.get("color/gray/900")!.scopes).toEqual([]);
  });

  it("a failure anywhere creates nothing — even in the last entry", async () => {
    const c = collection("Tokens");
    const err = await fails("create_variables", {
      collectionId: c.id,
      variables: [
        { name: "a", type: "FLOAT", values: [{ mode: "Mode 1", value: "4" }] },
        { name: "b", type: "BOOLEAN", values: [{ mode: "Mode 1", value: "maybe" }] },
      ],
    });
    nothingChanged(err);
    expect(w.variables.size).toBe(0);
    const later = await fails("create_variables", {
      collectionId: c.id,
      variables: [
        { name: "semantic", type: "FLOAT", values: [{ mode: "Mode 1", value: "alias:primitive" }] },
        { name: "primitive", type: "FLOAT", values: [{ mode: "Mode 1", value: "4" }] },
      ],
    });
    expect(later.message).toMatch(/comes later in this call/);
    expect((await fails("create_variables", { collectionId: c.id, variables: [{ name: "x", type: "FLOAT", values: [{ mode: "Night", value: "1" }] }] })).hint).toMatch(/Mode 1/);
    expect(w.variables.size).toBe(0);
  });

  it('ifExists: "error" refuses, "skip" keeps (and aliases resolve to it), "update" sets values and properties', async () => {
    const c = collection("Tokens");
    const m = c.modes[0]!.modeId;
    const old = variable("space/4", c, "FLOAT", [16]);
    const entries = [
      { name: "space/4", type: "FLOAT", values: [{ mode: "Mode 1", value: "20" }], scopes: ["GAP"] },
      { name: "gap/md", type: "FLOAT", values: [{ mode: m, value: "alias:space/4" }] },
    ];
    nothingChanged(await fails("create_variables", { collectionId: c.id, variables: entries }));

    const skip = await run("create_variables", { collectionId: c.id, ifExists: "skip", variables: entries });
    expect(skip).toMatchObject({ created: 1, skipped: 1, updated: 0 });
    expect(skip.items![0]).toMatchObject({ name: "space/4", id: old.id, skipped: true });
    expect(old.valuesByMode[m]).toBe(16);
    const gap = [...w.variables.values()].find((v) => v.name === "gap/md")!;
    expect(gap.valuesByMode[m]).toEqual(alias(old));

    const upd = await run("create_variables", { collectionId: c.id, ifExists: "update", variables: [entries[0]] });
    expect(upd).toMatchObject({ created: 0, updated: 1 });
    expect(old.valuesByMode[m]).toBe(20);
    expect(old.scopes).toEqual(["GAP"]);

    const clash = await fails("create_variables", { collectionId: c.id, ifExists: "skip", variables: [{ name: "space/4", type: "COLOR", values: [{ mode: m, value: "#000" }] }] });
    expect(clash.message).toMatch(/exists as FLOAT/);
  });
});

describe("a refusal says whether anything changed", () => {
  it("variable ops refuse before writing with partial created [] (add mode, set value, delete)", async () => {
    w.paid = true;
    const c = collection("Theme", ["Light", "Dark"]);
    const v = variable("bg", c, "COLOR", [{ r: 1, g: 1, b: 1, a: 1 }]);
    nothingChanged(await fails("add_variable_mode", { collectionId: c.id, name: "Dark" }));
    nothingChanged(await fails("set_variable_value", { variableId: v.id, modeId: "Night", value: "#000" }));
    nothingChanged(await fails("set_variable_value", { variableId: v.id, value: "not a colour" }));
    nothingChanged(await fails("set_variable_value", { variableId: v.id, value: "alias:missing" }));
    nothingChanged(await fails("delete_variable", {}));
    nothingChanged(await fails("delete_variable_collection", { collectionId: "VariableCollectionId:nope" }));
    await run("set_variable_value", { variableName: "bg", modeId: "Dark", value: "#00000080" });
    expect(v.valuesByMode[c.modes[1]!.modeId]).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
  });

  it("a variable Figma made before refusing a property is reported as created, not as nothing", async () => {
    const c = collection("Tokens");
    const create = (w.figma.variables as Record<string, (...a: unknown[]) => Record<string, unknown>>).createVariable!;
    (w.figma.variables as Record<string, unknown>).createVariable = (...args: unknown[]) => {
      const v = create(...args);
      Object.defineProperty(v, "description", { set() { throw new Error("description is locked"); } });
      return v;
    };
    const err = await fails("create_variable", { collectionId: c.id, name: "x", type: "FLOAT", value: "1", description: "d" });
    expect(err.message).toMatch(/was created, but Figma refused a property: description is locked/);
    expect(err.partial).toEqual({ created: [{ id: expect.any(String), name: "x" }] });
  });

  it("create_variables stopped after an update does not claim nothing changed", async () => {
    const c = collection("Tokens");
    const m = c.modes[0]!.modeId;
    const old = variable("a", c, "FLOAT", [1]);
    (w.figma.variables as Record<string, unknown>).createVariable = () => {
      throw new Error("in createVariable: quota");
    };
    const err = await fails("create_variables", {
      collectionId: c.id, ifExists: "update",
      variables: [{ name: "a", type: "FLOAT", values: [{ mode: m, value: "2" }] }, { name: "b", type: "FLOAT", values: [{ mode: m, value: "3" }] }],
    });
    expect(old.valuesByMode[m]).toBe(2);
    expect(err.partial).toEqual({ updated: [{ id: old.id, name: "a" }], failedAt: "b" });
    expect(err.message).toMatch(/Figma refused "b": in createVariable: quota/);
  });
});

// ── figma_set_variable_properties ───────────────────────────────────────────

describe("figma_set_variable_properties", () => {
  it('codeSyntax "" removes the platform through removeVariableCodeSyntax; scopes are checked per variable type', async () => {
    const c = collection("Tokens");
    const color = variable("color/bg", c, "COLOR");
    color.codeSyntax = { WEB: "var(--bg)", ANDROID: "bg" };
    const space = variable("space/4", c, "FLOAT");
    const r = await run("set_variable_properties", { variableIds: [color.id, space.id], scopes: ["GAP"], codeSyntax: { ANDROID: "" }, description: "x" });
    expect(r.items![0]).toMatchObject({ id: color.id, ok: false });
    expect(String(r.items![0]!.error)).toMatch(/cannot be scoped GAP/);
    expect(color.codeSyntax).toEqual({ WEB: "var(--bg)", ANDROID: "bg" }); // the refused item is untouched
    expect(r.items![1]).toMatchObject({ id: space.id, ok: true });
    expect(space.scopes).toEqual(["GAP"]);

    await run("set_variable_properties", { variableNames: ["color/bg"], codeSyntax: { ANDROID: "" } });
    expect(color.calls).toEqual(["remove ANDROID"]);
    expect(color.codeSyntax).toEqual({ WEB: "var(--bg)" });
  });

  it("renames one variable only, and not onto a name its collection uses", async () => {
    const c = collection("Tokens");
    const a = variable("a", c, "FLOAT");
    const b = variable("b", c, "FLOAT");
    nothingChanged(await fails("set_variable_properties", { variableIds: [a.id, b.id], name: "z" }));
    nothingChanged(await fails("set_variable_properties", { variableIds: [a.id], name: "b" }));
    await run("set_variable_properties", { variableIds: [a.id], name: "space/a", hiddenFromPublishing: true });
    expect(a.name).toBe("space/a");
    expect(a.hiddenFromPublishing).toBe(true);
    nothingChanged(await fails("set_variable_properties", { variableIds: [a.id] }));
  });
});

// ── collections and modes ───────────────────────────────────────────────────

describe("collections and modes", () => {
  it('a new collection without `modes` gets "Default", never Figma\'s "Mode 1"', async () => {
    const r = await run("create_variable_collection", { name: "Tokens" });
    expect(r.modes).toEqual([{ modeId: expect.any(String), name: "Default" }]);
    const named = await run("create_variable_collection", { name: "Theme", modes: ["Light", "Dark"] });
    expect((named.modes as Array<{ name: string }>)[0]!.name).toBe("Light");
    expect(named.warnings).toEqual([expect.stringMatching(/"Dark" was refused/)]); // Starter: one mode [C-047]
    nothingChanged(await fails("create_variable_collection", { name: "X", modes: ["A", "A"] }));
  });

  it("update_variable_collection renames modes and removes one, counting the values it held; never the last mode", async () => {
    w.paid = true;
    const c = collection("Theme", ["Mode 1", "Dark", "Dim"]);
    variable("bg", c, "COLOR", [{ r: 1, g: 1, b: 1 }, { r: 0, g: 0, b: 0 }, { r: 0.1, g: 0.1, b: 0.1 }]);
    variable("fg", c, "COLOR", [{ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }]);
    const r = await run("update_variable_collection", { collectionId: c.id, name: "Color", renameModes: [{ mode: "Mode 1", name: "Light" }], removeModes: ["Dim"] });
    expect(r.modes).toEqual([{ modeId: c.modes[0]!.modeId, name: "Light" }, { modeId: c.modes[1]!.modeId, name: "Dark" }]);
    expect(r.removed).toEqual([{ mode: "Dim", modeId: expect.any(String), values: 1 }]);
    expect(c.name).toBe("Color");

    const last = await fails("update_variable_collection", { collectionId: c.id, removeModes: ["Light", "Dark"] });
    expect(last.message).toMatch(/at least one mode/);
    nothingChanged(last);
    nothingChanged(await fails("update_variable_collection", { collectionId: c.id, renameModes: [{ mode: "Light", name: "Dark" }] }));
    expect(c.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
  });

  it("set_variable_mode passes the collection OBJECT, never the id, and clears the same way [C-105]", async () => {
    w.paid = true;
    const c = collection("Theme", ["Light", "Dark"]);
    const screen = node("FRAME");
    const label = text("Hello", screen, { family: "Roboto", style: "Bold" });
    const rect = node("RECTANGLE", screen);
    delete (rect as Record<string, unknown>).setExplicitVariableModeForCollection;
    Object.defineProperty(rect, "setExplicitVariableModeForCollection", { value: undefined });

    const r = await run("set_variable_mode", { nodeIds: [screen.id, rect.id, "9:404"], collectionName: "Theme", mode: "Dark" });
    expect(screen.modeCalls).toEqual([{ fn: "set", arg: "object" }]);
    expect(screen.explicitVariableModes[c.id]).toBe(c.modes[1]!.modeId);
    expect(r.items).toEqual([
      { id: screen.id, ok: true },
      { id: rect.id, ok: false, error: expect.stringMatching(/cannot take a variable mode/) },
      { id: "9:404", ok: false, error: "not found" },
    ]);
    expect(r.mode).toEqual({ modeId: c.modes[1]!.modeId, name: "Dark" });
    expect(w.fontsLoaded).toContain("Roboto Bold"); // a precaution before text may change
    expect(label.parent).toBe(screen);

    await run("set_variable_mode", { nodeIds: [screen.id], collectionId: c.id, clear: true });
    expect(screen.modeCalls[1]).toEqual({ fn: "clear", arg: "object" });
    expect(screen.explicitVariableModes[c.id]).toBeUndefined();
    nothingChanged(await fails("set_variable_mode", { nodeIds: [screen.id], collectionId: c.id }));
    const unknown = await fails("set_variable_mode", { nodeIds: [screen.id], collectionId: c.id, mode: "Night" });
    expect(unknown.hint).toMatch(/Light .*Dark/);
    nothingChanged(unknown);
  });

  it("a single-mode collection says so instead of succeeding silently", async () => {
    const c = collection("Tokens");
    const f = node("FRAME");
    const r = await run("set_variable_mode", { nodeIds: [f.id], collectionId: c.id, mode: "Mode 1" });
    expect(r.note).toMatch(/only one mode/);
  });
});

// ── binding: paints by index, effects, grids, text [C-108] [C-109] ──────────

describe("binding variables to node fields", () => {
  it("a gradient or image paint is refused, not replaced by a black solid (the old silent loss)", async () => {
    const c = collection("T");
    const bg = variable("color/bg", c, "COLOR");
    const gradient = { type: "GRADIENT_LINEAR", gradientStops: [], gradientTransform: [[1, 0, 0], [0, 1, 0]] };
    const f = node("FRAME", w.page, { fills: [gradient, { type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
    const r = await run("bind_variable_to_node", { nodeIds: [f.id], field: "fill", variableId: bg.id });
    expect(r.items![0]).toMatchObject({ ok: false, error: "paint 0 is a GRADIENT_LINEAR; only SOLID paints bind a colour" });
    expect((f.fills as unknown[])[0]).toBe(gradient);
    const second = await run("bind_variable_to_node", { nodeIds: [f.id], field: "fill", variableId: bg.id, index: 1 });
    expect(second).toMatchObject({ updated: 1, index: 1 });
    expect((f.fills as Array<Record<string, unknown>>)[1]!.boundVariables).toEqual({ color: alias(bg) });
    expect((f.fills as unknown[])[0]).toBe(gradient);
    const missing = await run("bind_variable_to_node", { nodeIds: [f.id], field: "fill", variableId: bg.id, index: 5 });
    expect(missing.items![0]!.error).toMatch(/no fill 5 \(it has 2\)/);
  });

  it("effect.color on effect 1 is bound on a copy and assigned back; a blur binds only its radius", async () => {
    const c = collection("T");
    const shadow = variable("shadow/color", c, "COLOR");
    const blur = variable("blur/md", c, "FLOAT");
    const effects = [{ type: "LAYER_BLUR", radius: 4, visible: true }, { type: "DROP_SHADOW", radius: 8, color: { r: 0, g: 0, b: 0, a: 0.2 } }];
    const f = node("FRAME", w.page, { effects });
    expect((await run("bind_variable_to_node", { nodeIds: [f.id], field: "effect.color", variableId: shadow.id, index: 1 })).updated).toBe(1);
    expect(f.effects).not.toBe(effects);
    expect((f.effects as Array<Record<string, unknown>>)[1]!.boundVariables).toEqual({ color: alias(shadow) });
    const wrong = await run("bind_variable_to_node", { nodeIds: [f.id], field: "effect.color", variableId: shadow.id });
    expect(wrong.items![0]!.error).toMatch(/LAYER_BLUR; a blur binds only effect.radius/);
    await run("bind_variable_to_node", { nodeIds: [f.id], field: "effect.radius", variableId: blur.id });
    expect((f.effects as Array<Record<string, unknown>>)[0]!.boundVariables).toEqual({ radius: alias(blur) });
  });

  it("grid fields bind through setBoundVariableForLayoutGrid", async () => {
    const c = collection("T");
    const cols = variable("grid/columns", c, "FLOAT");
    const f = node("FRAME", w.page, { layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 24, alignment: "STRETCH", offset: 0 }] });
    await run("bind_variable_to_node", { nodeIds: [f.id], field: "grid.count", variableId: cols.id });
    expect((f.layoutGrids as Array<Record<string, unknown>>)[0]!.boundVariables).toEqual({ count: alias(cols) });
  });

  it("a STRING bound to a TEXT node's fontFamily reaches Figma, with the current and the resulting fonts loaded [C-109]", async () => {
    const c = collection("T");
    const family = variable("font/family/heading", c, "STRING", ["Playfair Display"]);
    const t = text("Title", w.page, { family: "Inter", style: "Bold" });
    const r = await run("bind_variable_to_node", { nodeIds: [t.id], field: "fontFamily", variableId: family.id });
    expect(r.updated).toBe(1);
    expect(t.bound).toEqual({ fontFamily: family.id });
    expect(w.fontsLoaded).toEqual(["Inter Bold", "Playfair Display Bold"]);

    w.missingFonts.add("Comic Nope");
    const bad = variable("font/family/bad", c, "STRING", ["Comic Nope"]);
    const refused = await run("bind_variable_to_node", { nodeIds: [t.id], field: "fontFamily", variableId: bad.id });
    expect(refused.items![0]!.error).toMatch(/cannot load/);
    expect(t.bound.fontFamily).toBe(family.id);
  });

  it("a field Figma cannot bind, or an index on a plain field, is refused before any node changes", async () => {
    const c = collection("T");
    const v = variable("radius/md", c, "FLOAT");
    const f = node("FRAME", w.page, { cornerRadius: 0 });
    nothingChanged(await fails("bind_variable_to_node", { nodeIds: [f.id], field: "effect.blur", variableId: v.id }));
    nothingChanged(await fails("bind_variable_to_node", { nodeIds: [f.id], field: "effects", variableId: v.id }));
    nothingChanged(await fails("bind_variable_to_node", { nodeIds: [f.id], field: "radius", variableId: v.id, index: 1 }));
    nothingChanged(await fails("bind_variable_to_node", { nodeIds: [f.id], field: "radius", variableName: "nope" }));
    expect(f.bound).toEqual({});
  });

  it("bindField keeps its three-argument form for create_from_spec", () => {
    const c = collection("T");
    const v = variable("gap/md", c, "FLOAT");
    const f = node("FRAME", w.page, { itemSpacing: 0 });
    bindField(f as never, "gap", v);
    expect(f.bound).toEqual({ itemSpacing: v.id });
  });
});

// ── styles [C-108] ──────────────────────────────────────────────────────────

describe("styles: created with their full value, updated in place", () => {
  it('create_text_style takes the string grammar: "150%", "-2%", case upper, description', async () => {
    const r = await run("create_text_style", {
      name: "Label/Caps", fontSize: 12, weight: "600", lineHeight: "150%", letterSpacing: "-2%", case: "upper",
      decoration: "underline", paragraphSpacing: 8, description: "Overlines",
    });
    const s = w.styles.get(r.id as string)!;
    expect(s.lineHeight).toEqual({ unit: "PERCENT", value: 150 });
    expect(s.letterSpacing).toEqual({ unit: "PERCENT", value: -2 });
    expect(s).toMatchObject({ textCase: "UPPER", textDecoration: "UNDERLINE", paragraphSpacing: 8, description: "Overlines", fontName: { family: "Inter", style: "Semi Bold" } });
    const auto = await run("create_text_style", { name: "Body", fontSize: 16, lineHeight: "auto", letterSpacing: 0.5 });
    expect(w.styles.get(auto.id as string)).toMatchObject({ lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0.5 } });
    const before = w.styles.size;
    nothingChanged(await fails("create_text_style", { name: "Bad", fontSize: 16, lineHeight: "tall" }));
    // A style's line height stays above 0, through the helper the create tools share.
    const zero = await fails("create_text_style", { name: "Flat", fontSize: 16, lineHeight: "0%" });
    expect(zero.message).toMatch(/`lineHeight` must be "auto" or greater than 0/);
    nothingChanged(zero);
    expect(w.styles.size).toBe(before);
  });

  it("create_paint_style takes fills, and binds the first paint to a COLOR variable", async () => {
    const c = collection("T");
    const brand = variable("color/brand", c, "COLOR");
    const r = await run("create_paint_style", { name: "Brand", fills: [{ color: "#3b82f6" }], variableName: "color/brand", description: "Primary" });
    expect(r.variable).toEqual({ id: brand.id, name: "color/brand" });
    const s = w.styles.get(r.id as string)!;
    expect((s.paints as Array<Record<string, unknown>>)[0]!.boundVariables).toEqual({ color: alias(brand) });
    expect(s.description).toBe("Primary");
    nothingChanged(await fails("create_paint_style", { name: "Both", color: "#000", fills: [{ color: "#fff" }] }));
    const grad = await fails("create_paint_style", { name: "G", fills: [{ gradient: { type: "linear", stops: [{ position: 0, color: "#000" }, { position: 1, color: "#fff" }] } }], variableId: brand.id });
    expect(grad.message).toMatch(/only SOLID paints/);
  });

  it("create_grid_style converts the figma_set_layout_grids entries", async () => {
    const r = await run("create_grid_style", { name: "Grid/12", grids: [{ pattern: "columns", count: 12, gutter: 24, margin: 64 }], description: "Desktop" });
    expect(r).toMatchObject({ kind: "GRID", gridCount: 1 });
    expect(w.styles.get(r.id as string)).toMatchObject({
      name: "Grid/12", description: "Desktop", layoutGrids: [{ pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 24, offset: 64 }],
    });
    nothingChanged(await fails("create_grid_style", { name: "Empty", grids: [] }));
  });

  it("update_style changes the SAME style object, so a node using it stays linked", async () => {
    const s = addStyle("TEXT", { name: "Heading/H1", fontSize: 32 });
    const consumer = text("Hi");
    consumer.textStyleId = s.id;
    const r = await run("update_style", { styleName: "Heading/H1", fontSize: 40, lineHeight: "120%", description: "Page title" });
    expect(w.styles.get(s.id as string)).toBe(s);
    expect(s).toMatchObject({ fontSize: 40, lineHeight: { unit: "PERCENT", value: 120 }, description: "Page title" });
    expect(consumer.textStyleId).toBe(s.id);
    expect(r.changed).toEqual(["description", "fontSize", "lineHeight"]);
    expect(r.value).toBe("Inter Regular 40/120%");
    expect(w.fontsLoaded).toContain("Inter Regular"); // the style's own font, before its values change
  });

  it("update_style binds variables inside the style: a text field, a paint colour, an effect", async () => {
    const c = collection("T");
    const size = variable("font/size/lg", c, "FLOAT");
    const brand = variable("color/brand", c, "COLOR");
    const shadow = variable("shadow/color", c, "COLOR");
    const t = addStyle("TEXT", { name: "Body" });
    await run("update_style", { styleId: t.id, variables: [{ field: "fontSize", variableId: size.id }] });
    expect(t.boundVariables).toEqual({ fontSize: alias(size) });
    const p = addStyle("PAINT", { name: "Brand", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] });
    const pr = await run("update_style", { styleId: p.id, variables: [{ field: "color", variableName: "color/brand" }] });
    expect((p.paints as Array<Record<string, unknown>>)[0]!.boundVariables).toEqual({ color: alias(brand) });
    expect(pr.variables).toEqual({ color: "color/brand" });
    expect(pr.value).toBe("#0000ff (var: color/brand)");
    const e = addStyle("EFFECT", { name: "Elevation", effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }] });
    await run("update_style", { styleId: e.id, variables: [{ field: "effect.color", variableId: shadow.id }] });
    expect((e.effects as Array<Record<string, unknown>>)[0]!.boundVariables).toEqual({ color: alias(shadow) });
    const wrongType = await fails("update_style", { styleId: t.id, variables: [{ field: "fontFamily", variableId: size.id }] });
    expect(wrongType.message).toMatch(/fontFamily binds a STRING variable/);
    nothingChanged(wrongType);
  });

  it("update_style refuses a library style and a field the kind cannot hold, before anything changes", async () => {
    const lib = addStyle("PAINT", { name: "Lib/Brand", remote: true, paints: [] });
    const remote = await fails("update_style", { styleId: lib.id, color: "#000000" });
    expect(remote.message).toMatch(/library style/);
    nothingChanged(remote);
    const p = addStyle("PAINT", { name: "Brand", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] });
    const wrong = await fails("update_style", { styleId: p.id, fontSize: 12, name: "Renamed" });
    expect(wrong.message).toMatch(/`fontSize` belongs to a text style/);
    nothingChanged(wrong);
    expect(p.name).toBe("Brand");
    nothingChanged(await fails("update_style", { styleId: p.id }));
  });
});

// ── library variables [C-107] ───────────────────────────────────────────────

describe("figma_get_library_variables", () => {
  it("without the teamlibrary permission: UNSUPPORTED naming the permission and the library switch", async () => {
    const err = await fails("get_library_variables", {});
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.hint).toMatch(/teamlibrary permission/);
    expect(err.hint).toMatch(/Assets → Libraries/);
  });

  it("lists enabled collections, then a collection's variables filtered and paginated", async () => {
    w.teamLibrary = {
      getAvailableLibraryVariableCollectionsAsync: async () => [{ key: "k1", name: "Primitives", libraryName: "DS" }, { key: "k2", name: "Semantic", libraryName: "DS" }],
      getVariablesInLibraryCollectionAsync: async (key: string) => {
        if (key !== "k1") throw new Error("not found");
        return [
          { key: "v1", name: "color/blue/500", resolvedType: "COLOR" },
          { key: "v2", name: "color/blue/600", resolvedType: "COLOR" },
          { key: "v3", name: "space/4", resolvedType: "FLOAT" },
        ];
      },
    };
    expect((await run("get_library_variables", { query: "sem" })).collections).toEqual([{ key: "k2", name: "Semantic", libraryName: "DS" }]);
    const first = await run("get_library_variables", { collectionKey: "k1", query: "blue", limit: 1 });
    expect(first).toMatchObject({ count: 1, total: 2, truncated: true, variables: [{ key: "v1", name: "color/blue/500", resolvedType: "COLOR" }] });
    const next = await run("get_library_variables", { collectionKey: "k1", query: "blue", limit: 1, cursor: first.nextCursor });
    expect(next.variables).toEqual([{ key: "v2", name: "color/blue/600", resolvedType: "COLOR" }]);
    expect((await run("get_library_variables", { collectionKey: "k1", type: "FLOAT" })).variables).toEqual([{ key: "v3", name: "space/4", resolvedType: "FLOAT" }]);
    expect((await fails("get_library_variables", { collectionKey: "k9" })).message).toMatch(/not found/);
  });
});

// ── the server side ─────────────────────────────────────────────────────────

describe("registerTokens: portable schemas, forwarded as the plugin op", () => {
  const FORBIDDEN = ["anyOf", "oneOf", "allOf", "$ref", "propertyNames", "patternProperties", "const", "not"];
  const keys = (schema: unknown, out = new Set<string>()): Set<string> => {
    if (schema && typeof schema === "object") {
      for (const [k, v] of Object.entries(schema)) {
        out.add(k);
        keys(v, out);
      }
    }
    return out;
  };

  it("registers the seven tools inside the portable subset and forwards each call to the plugin op", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const bridge = { request: async (op: string, params: Record<string, unknown>) => (calls.push({ op, params }), { ok: true }) } as unknown as Bridge;
    const server = new McpServer({ name: "t", version: "0" });
    registerTokens(server, bridge, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "figma_create_grid_style", "figma_create_variables", "figma_get_library_variables", "figma_set_variable_mode",
      "figma_set_variable_properties", "figma_update_style", "figma_update_variable_collection",
    ]);
    for (const t of tools) {
      expect(t.description!.length).toBeLessThanOrEqual(1024);
      expect(t.description!.endsWith("…")).toBe(false);
      expect([...keys(t.inputSchema)].filter((k) => FORBIDDEN.includes(k))).toEqual([]);
    }
    expect(tools.find((t) => t.name === "figma_get_library_variables")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "figma_set_variable_mode")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // removeModes deletes every variable's value for the mode: a client in approval mode must ask first.
    expect(tools.find((t) => t.name === "figma_update_variable_collection")!.annotations).toMatchObject({ destructiveHint: true });

    const r = await client.callTool({
      name: "figma_create_variables",
      arguments: { collectionId: "C:1", variables: [{ name: "a", type: "FLOAT", values: [{ mode: "Default", value: "4" }], scopes: ["GAP"], codeSyntax: { WEB: "var(--a)" } }] },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ op: "create_variables", params: { collectionId: "C:1", variables: [{ name: "a", scopes: ["GAP"], codeSyntax: { WEB: "var(--a)" } }] } });
    const bad = await client.callTool({ name: "figma_create_variables", arguments: { collectionId: "C:1", variables: [{ name: "a", type: "FLOAT", values: [], scopes: ["NOPE"] }] } });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
    await client.close();
  });

  it("a codeSyntax platform it does not know is refused, not stripped to {} and answered ok", async () => {
    const calls: string[] = [];
    const bridge = { request: async (op: string) => (calls.push(op), { ok: true }) } as unknown as Bridge;
    const server = new McpServer({ name: "t", version: "0" });
    registerTokens(server, bridge, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const codeSyntax of [{ web: "var(--a)" }, { CSS: "var(--a)" }]) {
      const r = await client.callTool({ name: "figma_set_variable_properties", arguments: { variableNames: ["color/bg/brand"], codeSyntax } });
      expect(r.isError, JSON.stringify(codeSyntax)).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(new RegExp(Object.keys(codeSyntax)[0]!));
    }
    expect(calls).toEqual([]);
    const ok = await client.callTool({ name: "figma_set_variable_properties", arguments: { variableNames: ["color/bg/brand"], codeSyntax: { WEB: "var(--a)" } } });
    expect(ok.isError).toBeFalsy();
    expect(calls).toEqual(["set_variable_properties"]);
    await client.close();
  });
});

// ── refused before anything changes, not by Figma halfway ───────────────────

describe("names Figma refuses are refused before the first write", () => {
  it('create_variables: "spacing/0.5" stops the whole batch up front, so "spacing/0" is not left behind', async () => {
    const c = collection("Spacing");
    const m = c.modes[0]!.modeId;
    const err = await fails("create_variables", {
      collectionId: c.id,
      variables: [
        { name: "spacing/0", type: "FLOAT", values: [{ mode: m, value: "0" }] },
        { name: "spacing/0.5", type: "FLOAT", values: [{ mode: m, value: "2" }] },
      ],
    });
    expect(err.message).toMatch(/`variables\[1\]\.name` "spacing\/0\.5" contains "\."/);
    expect(err.hint).toMatch(/spacing\/0_5/);
    nothingChanged(err);
    expect(w.variables.size).toBe(0);
  });

  it("create_variable and a rename refuse { and }; a name the collection already has is still updated", async () => {
    const c = collection("T");
    nothingChanged(await fails("create_variable", { collectionId: c.id, name: "color/{brand}", type: "COLOR", value: "#000000" }));
    const v = variable("color/brand", c, "COLOR", [{ r: 0, g: 0, b: 0, a: 1 }]);
    const rename = await fails("set_variable_properties", { variableIds: [v.id], name: "color.brand" });
    expect(rename.message).toMatch(/`name` "color\.brand" contains "\."/);
    expect(v.name).toBe("color/brand");
    // Figma made this one, so its name is not second-guessed on update.
    const old = variable("legacy/0.5", c, "FLOAT", [1]);
    const r = await run("create_variables", { collectionId: c.id, ifExists: "update", variables: [{ name: "legacy/0.5", type: "FLOAT", values: [{ mode: c.modes[0]!.modeId, value: "2" }] }] });
    expect(r).toMatchObject({ updated: 1 });
    expect(old.valuesByMode[c.modes[0]!.modeId]).toBe(2);
  });

  it("update_variable_collection refuses a mode name over 40 characters before the collection is renamed", async () => {
    const c = collection("Theme", ["Light"]);
    const err = await fails("update_variable_collection", { collectionId: c.id, name: "Color", renameModes: [{ mode: "Light", name: "L".repeat(41) }] });
    expect(err.message).toMatch(/`renameModes\[0\]\.name` .* is 41 characters; a mode name is at most 40/);
    nothingChanged(err);
    expect(c.name).toBe("Theme");
    expect(c.modes[0]!.name).toBe("Light");
  });

  it("D-1: add_variable_mode and create_variable_collection refuse a mode name over 40 characters, changing nothing [C-127]", async () => {
    w.paid = true;
    const c = collection("Theme", ["Light"]);
    const add = await fails("add_variable_mode", { collectionId: c.id, name: "D".repeat(41) });
    expect(add.message).toMatch(/`name` .* is 41 characters; a mode name is at most 40/);
    nothingChanged(add);
    expect(c.modes.map((x) => x.name)).toEqual(["Light"]);
    expect((await run("add_variable_mode", { collectionId: c.id, name: "D".repeat(40) })).name).toBe("D".repeat(40));

    const before = w.collections.size;
    const create = await fails("create_variable_collection", { name: "Theme 2", modes: ["Light", "D".repeat(41)] });
    expect(create.message).toMatch(/`modes\[1\]` .* is 41 characters; a mode name is at most 40/);
    nothingChanged(create);
    expect(w.collections.size).toBe(before);
  });
});

describe("a library variable is read-only to figma_set_variable_value (D-10)", () => {
  it("is refused in the pre-check with created [], and its value is untouched", async () => {
    const lib = collection("Library tokens");
    const v = variable("color/brand", lib, "COLOR", [{ r: 0, g: 0, b: 1, a: 1 }]);
    v.remote = true;
    let writes = 0;
    v.setValueForMode = () => {
      writes++;
    };
    const err = await fails("set_variable_value", { variableId: v.id, value: "#ff0000" });
    expect(err.message).toBe('"color/brand" is a library variable; library variables are read-only here.');
    expect(err.hint).toBe("Change it in its library file and publish.");
    nothingChanged(err);
    expect(writes).toBe(0);
  });
});

describe("a library collection is read-only to figma_create_variable", () => {
  it("is refused in the pre-check with created [], so the idempotencyKey is freed", async () => {
    const lib = collection("Library tokens");
    lib.remote = true;
    const err = await fails("create_variable", { collectionId: lib.id, name: "space/4", type: "FLOAT", value: "4" });
    expect(err.message).toMatch(/"Library tokens" is a library collection/);
    nothingChanged(err);
    expect(w.variables.size).toBe(0);
  });
});

describe("a variable name two collections share is refused, not guessed", () => {
  it("create_paint_style, update_style and bind_variable_to_node name the ids to choose from", async () => {
    const a = collection("Brand A");
    const b = collection("Brand B");
    const va = variable("color/bg/brand", a, "COLOR", [{ r: 1, g: 0, b: 0, a: 1 }]);
    const vb = variable("color/bg/brand", b, "COLOR", [{ r: 0, g: 0, b: 1, a: 1 }]);
    const style = await fails("create_paint_style", { name: "Brand", color: "#000000", variableName: "color/bg/brand" });
    expect(style.message).toMatch(/2 variables are named "color\/bg\/brand"/);
    expect(style.hint).toContain(va.id);
    expect(style.hint).toContain(vb.id);
    nothingChanged(style);
    expect(w.styles.size).toBe(0);

    const p = addStyle("PAINT", { name: "Surface", paints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
    nothingChanged(await fails("update_style", { styleId: p.id, variables: [{ field: "color", variableName: "color/bg/brand" }] }));
    expect((p.paints as Array<Record<string, unknown>>)[0]!.boundVariables).toBeUndefined();

    const rect = node("RECTANGLE", w.page, { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
    nothingChanged(await fails("bind_variable_to_node", { nodeIds: [rect.id], field: "fill", variableName: "color/bg/brand" }));
    const byId = await run("update_style", { styleId: p.id, variables: [{ field: "color", variableId: vb.id }] });
    expect(byId.variables).toEqual({ color: "color/bg/brand" });
  });
});

describe("codeSyntax that names no platform is nothing to change", () => {
  it("set_variable_properties { codeSyntax: {} } is refused instead of answering ok with changed []", async () => {
    const v = variable("color/bg", collection("T"), "COLOR");
    const err = await fails("set_variable_properties", { variableIds: [v.id], codeSyntax: {} });
    expect(err.message).toMatch(/Nothing to change/);
    nothingChanged(err);
  });
});

describe("update_style with `opacity` alone", () => {
  it("fades every paint and keeps the variable bound to its colour", async () => {
    const brand = variable("color/brand", collection("T"), "COLOR", [{ r: 0, g: 0, b: 1, a: 1 }]);
    const s = addStyle("PAINT", { name: "Brand/Overlay", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1, boundVariables: { color: alias(brand) } }] });
    const r = await run("update_style", { styleName: "Brand/Overlay", opacity: 0.5 });
    expect(s.paints).toEqual([{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 0.5, boundVariables: { color: alias(brand) } }]);
    expect(r).toMatchObject({ changed: ["paints"], variables: { color: "color/brand" } });

    const empty = addStyle("PAINT", { name: "Empty" });
    const none = await fails("update_style", { styleId: empty.id, opacity: 0.5 });
    expect(none.message).toMatch(/no paints for `opacity` to fade/);
    nothingChanged(none);
    // A new style still needs a colour for the opacity to apply to.
    nothingChanged(await fails("create_paint_style", { name: "Faded", opacity: 0.5 }));
  });
});

describe("a value written under text that uses the variable loads that text's fonts [C-105]", () => {
  /** Figma's refusal when a write reaches text whose font is not loaded. */
  const needsFont = (v: { setValueForMode(m: string, x: unknown): void }, font: string) => {
    const set = v.setValueForMode.bind(v);
    v.setValueForMode = (modeId, value) => {
      if (!w.fontsLoaded.includes(font)) throw new Error(`Cannot write to node with unloaded font "${font}"`);
      set(modeId, value);
    };
  };

  it('create_variables ifExists "update" on a STRING a Roboto Medium label shows', async () => {
    const c = collection("Copy");
    const m = c.modes[0]!.modeId;
    const cta = variable("copy/cta", c, "STRING", ["Buy"]);
    text("Buy", w.page, { family: "Roboto", style: "Medium" });
    needsFont(cta, "Roboto Medium");
    const r = await run("create_variables", { collectionId: c.id, ifExists: "update", variables: [{ name: "copy/cta", type: "STRING", values: [{ mode: m, value: "Buy now" }] }] });
    expect(r).toMatchObject({ updated: 1 });
    expect(cta.valuesByMode[m]).toBe("Buy now");
    expect(w.fontsLoaded).toContain("Roboto Medium");
  });

  it("D-2: set_variable_value on a FLOAT a Roboto Medium label's size is bound to", async () => {
    const c = collection("Type");
    const m = c.modes[0]!.modeId;
    const size = variable("font/size/body", c, "FLOAT", [16]);
    text("Body", w.page, { family: "Roboto", style: "Medium" });
    needsFont(size, "Roboto Medium");
    const r = await run("set_variable_value", { variableId: size.id, value: "18" });
    expect(r).toMatchObject({ variableId: size.id, modeId: m });
    expect(size.valuesByMode[m]).toBe(18);
    expect(w.fontsLoaded).toContain("Roboto Medium");
  });

  it("a STRING bound to fontFamily also loads the font the text switches to", async () => {
    const c = collection("Type");
    const m = c.modes[0]!.modeId;
    const family = variable("font/family/body", c, "STRING", ["Inter"]);
    const label = text("Body", w.page, { family: "Inter", style: "Regular" });
    label.boundVariables = { fontFamily: [alias(family)] };
    needsFont(family, "Roboto Regular");
    await run("create_variables", { collectionId: c.id, ifExists: "update", variables: [{ name: "font/family/body", type: "STRING", values: [{ mode: m, value: "Roboto" }] }] });
    expect(family.valuesByMode[m]).toBe("Roboto");
    expect(w.fontsLoaded).toEqual(expect.arrayContaining(["Inter Regular", "Roboto Regular"]));
  });

  it("loads nothing when Figma refuses for another reason, and reports that refusal", async () => {
    const c = collection("T");
    const m = c.modes[0]!.modeId;
    const v = variable("space/4", c, "FLOAT", [4]);
    text("x", w.page, { family: "Roboto", style: "Medium" });
    v.setValueForMode = () => {
      throw new Error("in setValueForMode: quota");
    };
    const err = await fails("create_variables", { collectionId: c.id, ifExists: "update", variables: [{ name: "space/4", type: "FLOAT", values: [{ mode: m, value: "8" }] }] });
    expect(err.message).toMatch(/Figma refused "space\/4": in setValueForMode: quota/);
    expect(w.fontsLoaded).toEqual([]);
  });
});
