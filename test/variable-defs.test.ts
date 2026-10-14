// The token reads: figma_get_variable_defs with VALUES (per mode name, in the
// dialect the writes take back), the official selection-scoped shape with
// nodeId, and figma_get_styles with a one-line value per style — against the
// fake in token-fakes.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import { hexa, styleValue, textLine, valueText } from "../src/plugin/tokens.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../src/server/bridge.js";
import { variableValueParam } from "../src/server/tools/params.js";
import { registerRead } from "../src/server/tools/read.js";
import { addStyle, alias, collection, ctx, install, node, text, uninstall, variable, w } from "./token-fakes.js";

type Result = Record<string, unknown>;
const run = (op: string, params: Record<string, unknown>) => READ_OPS[op]!.run(ctx(params)) as Promise<Result>;

beforeEach(() => {
  install();
});
afterEach(() => uninstall());

describe("the value dialect", () => {
  it("colours read back in the form the writes take: #rrggbb, #rrggbbaa below full alpha", () => {
    expect(hexa({ r: 1, g: 0, b: 0, a: 1 })).toBe("#ff0000");
    expect(hexa({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("#00000080");
    expect(valueText({ r: 0.2, g: 0.4, b: 0.6 })).toBe("#336699");
    expect(valueText(1.2000000476837158)).toBe("1.2"); // single-precision noise off, a string as the writes take it
    expect(valueText({ type: "VARIABLE_ALIAS", id: "VariableID:1" }, () => "color/blue/500")).toBe("alias:color/blue/500");
    expect(valueText({ type: "VARIABLE_ALIAS", id: "VariableID:gone" })).toBe("alias:VariableID:gone");
    expect(valueText(true)).toBe("true");
  });

  it("text and grid lines", () => {
    expect(textLine({ fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 24, lineHeight: { unit: "PIXELS", value: 32 }, letterSpacing: { unit: "PERCENT", value: -1 }, textCase: "UPPER", textDecoration: "NONE" }))
      .toBe("Inter Semi Bold 24/32 -1% upper");
    expect(textLine({ fontName: { family: "Inter", style: "Regular" }, fontSize: 16, lineHeight: { unit: "AUTO" }, textCase: "SMALL_CAPS" })).toBe("Inter Regular 16/auto small-caps");
    const grid = (g: Record<string, unknown>) => styleValue({ type: "GRID", layoutGrids: [g] });
    expect(grid({ pattern: "COLUMNS", count: 12, gutterSize: 24, alignment: "STRETCH", offset: 64 })).toBe("columns 12, gutter 24, margin 64");
    expect(grid({ pattern: "ROWS", count: 4, gutterSize: 8, alignment: "CENTER", sectionSize: 40 })).toBe("rows 4, gutter 8, section 40, align center");
    expect(grid({ pattern: "GRID", sectionSize: 8, visible: false })).toBe("grid 8 (hidden)");
    // Figma's "Auto" count is Infinity; it read "columns ?" here and "columns auto" in design context.
    expect(grid({ pattern: "COLUMNS", count: Infinity, alignment: "MIN", sectionSize: 80, gutterSize: 20, offset: 0 }))
      .toBe("columns auto, gutter 20, margin 0, section 80, align min");
    expect(styleValue({ type: "EFFECT", effects: [] })).toBe("none");
  });
});

describe("figma_get_variable_defs — the file's tokens with their values", () => {
  it("values per mode NAME, aliases by target name, scopes, code syntax, key and default mode", async () => {
    w.paid = true;
    const prim = collection("Primitives");
    const theme = collection("Theme", ["Light", "Dark"]);
    const blue = variable("color/blue/500", prim, "COLOR", [{ r: 0.231, g: 0.51, b: 0.965, a: 1 }]);
    blue.scopes = [];
    const bg = variable("color/bg/brand", theme, "COLOR", [alias(blue), { r: 0, g: 0, b: 0, a: 0.5 }]);
    bg.scopes = ["ALL_FILLS"];
    bg.codeSyntax = { WEB: "var(--color-bg-brand)" };
    bg.description = "Brand surface";
    variable("space/4", prim, "FLOAT", [16]);
    variable("flag", prim, "BOOLEAN", [true]);

    const r = await run("get_variable_defs", {});
    const vars = r.variables as Array<Record<string, unknown>>;
    expect(vars.find((v) => v.name === "color/bg/brand")).toEqual({
      id: bg.id, name: "color/bg/brand", resolvedType: "COLOR", collectionId: theme.id, key: bg.key,
      values: { Light: "alias:color/blue/500", Dark: "#00000080" },
      scopes: ["ALL_FILLS"], codeSyntax: { WEB: "var(--color-bg-brand)" }, description: "Brand surface",
    });
    expect(vars.find((v) => v.name === "color/blue/500")).toMatchObject({ values: { "Mode 1": "#3b82f6" }, scopes: [] });
    expect(vars.find((v) => v.name === "space/4")!.values).toEqual({ "Mode 1": "16" });
    expect(vars.find((v) => v.name === "flag")!.values).toEqual({ "Mode 1": "true" });
    expect((r.collections as Array<Record<string, unknown>>).find((c) => c.id === theme.id)).toEqual({
      id: theme.id, name: "Theme", key: theme.key, defaultMode: "Light",
      modes: [{ modeId: theme.modes[0]!.modeId, name: "Light" }, { modeId: theme.modes[1]!.modeId, name: "Dark" }], variableCount: 1,
    });
    expect(r).toMatchObject({ count: 4, total: 4, truncated: false });
  });

  it("every value read goes back into a write's `value` unchanged: the write schemas take strings only", async () => {
    const c = collection("Tokens");
    variable("space/4", c, "FLOAT", [16]);
    variable("flag", c, "BOOLEAN", [false]);
    variable("color/bg", c, "COLOR", [{ r: 1, g: 1, b: 1, a: 1 }]);
    const r = await run("get_variable_defs", {});
    for (const v of r.variables as Array<{ name: string; values: Record<string, unknown> }>) {
      for (const value of Object.values(v.values)) expect(variableValueParam.safeParse(value).success, `${v.name}: ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("D-5: the tool description shows those values as strings too, each one a write takes", () => {
    const descriptions = new Map<string, string>();
    registerRead({ registerTool: (name: string, c: { description: string }) => descriptions.set(name, c.description) } as unknown as McpServer, {} as Bridge, () => true);
    const shown = /\(("#1a2b3c80"[^—]*) — strings, as figma_set_variable_value takes them\)/.exec(descriptions.get("figma_get_variable_defs")!);
    const examples = JSON.parse(`[${shown![1]}]`) as unknown[];
    expect(examples).toEqual(["#1a2b3c80", "16", "true", "alias:color/blue/500"]);
    for (const value of examples) expect(variableValueParam.safeParse(value).success, JSON.stringify(value)).toBe(true);
  });

  it("paginates with limit and a cursor that belongs to this query only", async () => {
    const c = collection("Tokens");
    for (let i = 0; i < 5; i++) variable(`space/${i}`, c, "FLOAT", [i * 4]);
    const first = await run("get_variable_defs", { limit: 2 });
    expect(first).toMatchObject({ count: 2, total: 5, truncated: true });
    const second = await run("get_variable_defs", { limit: 2, cursor: first.nextCursor });
    expect((second.variables as Array<{ name: string }>).map((v) => v.name)).toEqual(["space/2", "space/3"]);
    const last = await run("get_variable_defs", { limit: 2, cursor: second.nextCursor });
    expect(last).toMatchObject({ count: 1, truncated: false });
    expect(last.nextCursor).toBeUndefined();
    await expect(run("get_variable_defs", { collectionId: c.id, cursor: first.nextCursor })).rejects.toBeInstanceOf(BridgeError);
  });

  it("with nodeId: the variables and styles the subtree USES, resolved for the node — a Dark frame reads Dark [C-105]", async () => {
    w.paid = true;
    const theme = collection("Theme", ["Light", "Dark"]);
    const bg = variable("color/bg", theme, "COLOR", [{ r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }]);
    bg.codeSyntax = { WEB: "var(--bg)" };
    const gap = variable("space/gap", theme, "FLOAT", [8, 8]);
    const unused = variable("color/unused", theme, "COLOR", [{ r: 1, g: 0, b: 0, a: 1 }]);
    const lib = variable("radius/lg", collection("Library"), "FLOAT", [12]);
    lib.remote = true;
    const shadow = variable("shadow/color", theme, "COLOR", [{ r: 0, g: 0, b: 0, a: 0.25 }, { r: 0, g: 0, b: 0, a: 0.5 }]);
    const h1 = addStyle("TEXT", { name: "Heading/H1", fontName: { family: "Inter", style: "Bold" }, fontSize: 32, lineHeight: { unit: "PIXELS", value: 40 } });

    const screen = node("FRAME", w.page, {
      name: "Screen",
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: alias(bg) } }],
      boundVariables: { itemSpacing: alias(gap), fills: [alias(bg)], topLeftRadius: alias(lib) },
      effects: [{ type: "DROP_SHADOW", boundVariables: { color: alias(shadow) } }],
    });
    screen.explicitVariableModes[theme.id] = theme.modes[1]!.modeId; // pinned to Dark
    const title = text("Welcome", screen);
    title.textStyleId = h1.id;
    title.fillStyleId = Symbol("mixed"); // a mixed style id is skipped, not reported
    expect(unused.id).toBeTruthy();

    const r = await run("get_variable_defs", { nodeId: screen.id });
    expect(r.scope).toEqual({ id: screen.id, name: "Screen", type: "FRAME" });
    expect(r.variables).toEqual({ "color/bg": "#000000", "space/gap": "8", "radius/lg": "12", "shadow/color": "#00000080" });
    expect(r.styles).toEqual({ "Heading/H1": "Inter Bold 32/40" });
    const details = r.details as { variables: Array<Record<string, unknown>>; styles: Array<Record<string, unknown>> };
    expect(details.variables.find((v) => v.name === "color/bg")).toEqual({
      id: bg.id, name: "color/bg", key: bg.key, remote: false, collection: "Theme", resolvedType: "COLOR", value: "#000000", codeSyntax: { WEB: "var(--bg)" },
    });
    expect(details.variables.find((v) => v.name === "radius/lg")).toMatchObject({ remote: true, collection: "Library" });
    expect(details.styles).toEqual([{ id: h1.id, name: "Heading/H1", key: h1.key, remote: false, type: "TEXT", value: "Inter Bold 32/40" }]);
    expect(r).toMatchObject({ nodeCount: 2, truncated: false });

    const onlyTheme = await run("get_variable_defs", { nodeId: screen.id, collectionId: theme.id });
    expect(Object.keys(onlyTheme.variables as object)).not.toContain("radius/lg");
  });

  it("with nodeId: bounded by maxNodes, continued by cursor", async () => {
    const c = collection("T");
    const a = variable("a", c, "FLOAT", [1]);
    const b = variable("b", c, "FLOAT", [2]);
    const root = node("FRAME");
    node("RECTANGLE", root, { boundVariables: { width: alias(a) } });
    node("RECTANGLE", root, { boundVariables: { width: alias(b) } });
    const first = await run("get_variable_defs", { nodeId: root.id, maxNodes: 2 });
    expect(first).toMatchObject({ variables: { a: "1" }, nodeCount: 2, truncated: true });
    const rest = await run("get_variable_defs", { nodeId: root.id, maxNodes: 2, cursor: first.nextCursor });
    expect(rest).toMatchObject({ variables: { b: "2" }, nodeCount: 1, truncated: false });
  });
});

describe("figma_get_styles — each style with its value", () => {
  it("one value line per kind, with key, description and the variables bound inside", async () => {
    const c = collection("T");
    const brand = variable("color/brand", c, "COLOR");
    const size = variable("font/size/xl", c, "FLOAT");
    addStyle("PAINT", { name: "Brand", description: "Primary", paints: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, boundVariables: { color: alias(brand) } }] });
    const h1 = addStyle("TEXT", {
      name: "Heading/H1", fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 24, lineHeight: { unit: "PIXELS", value: 32 },
      letterSpacing: { unit: "PERCENT", value: -1 }, textCase: "UPPER",
    });
    (h1.boundVariables as Record<string, unknown>).fontSize = alias(size);
    addStyle("EFFECT", { name: "Shadow/1", effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.1 } }] });
    addStyle("GRID", { name: "Grid/12", layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 24, alignment: "STRETCH", offset: 64 }] });

    const r = await run("get_styles", {});
    const styles = r.styles as Record<string, Array<Record<string, unknown>>>;
    expect(styles.PAINT![0]).toMatchObject({ name: "Brand", key: expect.any(String), value: "#1a334d (var: color/brand)", description: "Primary", variables: { color: "color/brand" } });
    expect(styles.TEXT![0]).toMatchObject({ name: "Heading/H1", value: "Inter Semi Bold 24/32 -1% upper", variables: { fontSize: "font/size/xl" } });
    expect(styles.EFFECT![0]!.value).toBe("drop-shadow 0 4 12 0 #000000 10%");
    expect(styles.GRID![0]!.value).toBe("columns 12, gutter 24, margin 64");
    expect(styles.PAINT![0]).not.toHaveProperty("remote");
    expect(r).toMatchObject({ count: 4, total: 4, truncated: false, filter: null });
  });

  it("filters by type and paginates", async () => {
    for (let i = 0; i < 3; i++) addStyle("PAINT", { name: `P${i}`, paints: [] });
    addStyle("TEXT", { name: "T" });
    const first = await run("get_styles", { type: "PAINT", limit: 2 });
    expect(Object.keys(first.styles as object)).toEqual(["PAINT"]);
    expect(first).toMatchObject({ count: 2, total: 3, truncated: true });
    const rest = await run("get_styles", { type: "PAINT", limit: 2, cursor: first.nextCursor });
    expect((rest.styles as Record<string, Array<{ name: string; value: string }>>).PAINT).toEqual([expect.objectContaining({ name: "P2", value: "none" })]);
  });
});
