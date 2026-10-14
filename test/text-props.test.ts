// Paragraph-level text and text bound to the design system [C-103]: spacing,
// indent and lists per paragraph; truncation, vertical alignment, leading trim
// and wrap style per node; and a range tied to a text style, a paint style, a
// colour variable or variables per field — against a fake TEXT node that
// records every setter Figma would receive, so "nothing changed" is checkable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { TYPOGRAPHY_OPS } from "../src/plugin/ops/typography.js";
import { resetFontCache } from "../src/plugin/write.js";
import { registerTypography } from "../src/server/tools/typography.js";
import { registerCreate } from "../src/server/tools/create.js";
import { textLengthsForPlugin } from "../src/server/tools/params.js";
import type { Bridge } from "../src/server/bridge.js";

type Font = { family: string; style: string };
let seq = 0;

/** The style Figma lands on for a numeric weight — the fake's half of what fontsAhead predicts. */
const WEIGHT_STYLE: Record<number, string> = { 400: "Regular", 700: "Bold", 900: "Black" };

class Text {
  id = `5:${++seq}`;
  type = "TEXT";
  name = "Text";
  calls: string[] = [];
  fontName: Font = { family: "Inter", style: "Regular" };
  fontSize = 16;
  textAlignHorizontal = "LEFT";
  textAlignVertical = "TOP";
  textTruncation = "DISABLED";
  maxLines: number | null = null;
  leadingTrim = "NONE";
  textWrapStyle = "AUTO";
  /** What was written to textAutoResize, which is not always what reads back. */
  resizeWrites: string[] = [];
  private resize = "HEIGHT";
  constructor(public characters: string) {}
  // Measured live 2026-10-08 (spikes/results/live-wpC-paint.txt): a fixed text
  // whose truncation is ENDING reads back as the deprecated "TRUNCATE".
  get textAutoResize(): string {
    return this.resize === "NONE" && this.textTruncation === "ENDING" ? "TRUNCATE" : this.resize;
  }
  set textAutoResize(v: string) {
    this.resizeWrites.push(v);
    this.resize = v;
  }
  getRangeAllFontNames() {
    return [this.fontName];
  }
  getStyledTextSegments(_f: string[], s = 0, e = this.characters.length) {
    return [{ start: s, end: e, fontName: this.fontName }];
  }
  /** Figma refuses a write that lands a range on a font nobody loaded. */
  private needLoaded(f: Font): void {
    if (!loaded.includes(`${f.family} ${f.style}`)) throw new Error(`Cannot write to node with unloaded font "${f.family} ${f.style}"`);
  }
  setRangeFontName(s: number, e: number, f: Font) {
    this.needLoaded(f);
    this.calls.push(`font ${s}-${e} ${f.family} ${f.style}`);
    this.fontName = f;
  }
  setRangeFontSize(s: number, e: number, v: number) { this.calls.push(`size ${s}-${e} ${v}`); }
  setRangeFills(s: number, e: number, v: unknown[]) { this.calls.push(`fills ${s}-${e} ${JSON.stringify(v)}`); }
  setRangeParagraphSpacing(s: number, e: number, v: number) { this.calls.push(`paragraphSpacing ${s}-${e} ${v}`); }
  setRangeParagraphIndent(s: number, e: number, v: number) { this.calls.push(`paragraphIndent ${s}-${e} ${v}`); }
  setRangeListOptions(s: number, e: number, v: unknown) { this.calls.push(`list ${s}-${e} ${JSON.stringify(v)}`); }
  setRangeHyperlink(s: number, e: number, v: unknown) { this.calls.push(`link ${s}-${e} ${JSON.stringify(v)}`); }
  async setRangeTextStyleIdAsync(s: number, e: number, id: string) {
    const font = styles.find((x) => x.id === id)?.fontName;
    if (font) this.needLoaded(font);
    this.calls.push(`textStyle ${s}-${e} ${id}`);
    if (font) this.fontName = font;
  }
  async setRangeFillStyleIdAsync(s: number, e: number, id: string) { this.calls.push(`fillStyle ${s}-${e} ${id}`); }
  // "Requires any new fonts to be loaded" (plugin-api.d.ts setRangeBoundVariable): a bound
  // family, style or weight switches the range's font, so that font must be loaded already.
  setRangeBoundVariable(s: number, e: number, field: string, v: Variable | null) {
    const value = v?.resolveForConsumer?.(this)?.value;
    let lands: Font | undefined;
    if (field === "fontFamily") lands = { family: String(value), style: this.fontName.style };
    if (field === "fontStyle") lands = { family: this.fontName.family, style: String(value) };
    if (field === "fontWeight") lands = { family: this.fontName.family, style: WEIGHT_STYLE[Number(value)] ?? String(value) };
    if (lands) this.needLoaded(lands);
    this.calls.push(`bind ${s}-${e} ${field} ${v?.id}`);
    if (lands) this.fontName = lands;
  }
}

/** A text node from a build that predates the paragraph API — none of the newer members exist. */
class OldText {
  id = `5:${++seq}`;
  type = "TEXT";
  name = "Old";
  fontName: Font = { family: "Inter", style: "Regular" };
  textAutoResize = "HEIGHT";
  textAlignHorizontal = "LEFT";
  calls: string[] = [];
  constructor(public characters: string) {}
  setRangeFontSize(s: number, e: number, v: number) { this.calls.push(`size ${s}-${e} ${v}`); }
}

const FONTS: Record<string, string[]> = { Inter: ["Regular", "Bold", "Black"], Lora: ["Regular", "Bold"] };
/** Listed by Figma but refused by loadFontAsync — a face whose file is missing on this machine. */
const UNLOADABLE = new Set(["Inter Black"]);
type Variable = { id: string; name: string; resolvedType: string; resolveForConsumer?(n: unknown): { value: unknown } };
let nodes: Map<string, unknown>;
let variables: Variable[];
let styles: Array<{ id: string; name: string; type: string; fontName?: Font }>;
const loaded: string[] = [];

beforeEach(() => {
  resetFontCache();
  loaded.length = 0;
  nodes = new Map();
  variables = [
    { id: "VariableID:1:1", name: "type/body/size", resolvedType: "FLOAT" },
    { id: "VariableID:1:2", name: "color/text/link", resolvedType: "COLOR" },
    { id: "VariableID:1:3", name: "type/serif", resolvedType: "STRING", resolveForConsumer: () => ({ value: "Lora" }) },
    { id: "VariableID:1:4", name: "type/missing", resolvedType: "STRING", resolveForConsumer: () => ({ value: "Comic Papyrus" }) },
    { id: "VariableID:1:5", name: "type/weight/bold", resolvedType: "FLOAT", resolveForConsumer: () => ({ value: 700 }) },
    { id: "VariableID:1:6", name: "type/weight/black", resolvedType: "FLOAT", resolveForConsumer: () => ({ value: 900 }) },
    { id: "VariableID:1:7", name: "type/style/regular", resolvedType: "STRING", resolveForConsumer: () => ({ value: "Regular" }) },
  ];
  styles = [
    { id: "S:text1,", name: "Body/Strong", type: "TEXT", fontName: { family: "Lora", style: "Bold" } },
    { id: "S:paint1,", name: "Brand/Primary", type: "PAINT" },
  ];
  (globalThis as { figma?: unknown }).figma = {
    async listAvailableFontsAsync() {
      return Object.entries(FONTS).flatMap(([family, ss]) => ss.map((style) => ({ fontName: { family, style } })));
    },
    async loadFontAsync(f: Font) {
      if (!FONTS[f.family]?.includes(f.style) || UNLOADABLE.has(`${f.family} ${f.style}`)) throw new Error(`font ${f.family} ${f.style} not found`);
      loaded.push(`${f.family} ${f.style}`);
    },
    async getNodeByIdAsync(id: string) {
      return nodes.get(id) ?? null;
    },
    async getStyleByIdAsync(id: string) {
      return styles.find((s) => s.id === id) ?? null;
    },
    async getLocalTextStylesAsync() {
      return styles.filter((s) => s.type === "TEXT");
    },
    async getLocalPaintStylesAsync() {
      return styles.filter((s) => s.type === "PAINT");
    },
    variables: {
      async getVariableByIdAsync(id: string) {
        return variables.find((v) => v.id === id) ?? null;
      },
      async getLocalVariablesAsync() {
        return variables;
      },
      setBoundVariableForPaint(paint: Record<string, unknown>, field: string, v: Variable) {
        return { ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: v.id } } };
      },
    },
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false });
const run = (op: string, params: Record<string, unknown>) => TYPOGRAPHY_OPS[op]!.run(ctx(params)) as Promise<Record<string, any>>;
const add = <T extends { id: string }>(n: T) => (nodes.set(n.id, n), n);
async function fails(op: string, params: Record<string, unknown>): Promise<{ code: string; message: string; hint?: string; partial?: unknown }> {
  try {
    await run(op, params);
  } catch (e) {
    return e as { code: string; message: string; partial?: unknown };
  }
  throw new Error("expected a refusal");
}

// ── whole node ────────────────────────────────────────────────────────────────

describe("figma_set_text_properties — truncation, alignment, trim, wrap", () => {
  it("maxLines truncates with an ellipsis after that many lines: textTruncation ENDING, then maxLines", async () => {
    const t = add(new Text("A long card title that will not fit on two lines at this width"));
    const r = await run("set_text_properties", { nodeIds: [t.id], maxLines: 2 });
    expect(r.updated).toBe(1);
    expect([t.textTruncation, t.maxLines]).toEqual(["ENDING", 2]);
  });

  it('autoResize "truncate" writes a fixed box that truncates — and Figma reads it back as TRUNCATE', async () => {
    const t = add(new Text("Overflowing label"));
    await run("set_text_properties", { nodeIds: [t.id], autoResize: "truncate" });
    // The write is the current API, never the deprecated TRUNCATE [C-103]...
    expect(t.resizeWrites).toEqual(["NONE"]);
    // ...yet a fixed text truncating at the end reads back as TRUNCATE (measured 2026-10-08).
    expect([t.textAutoResize, t.textTruncation]).toEqual(["TRUNCATE", "ENDING"]);
  });

  it('a build without textTruncation still truncates for autoResize "truncate", the old way', async () => {
    const t = add(new OldText("Overflowing label"));
    const r = await run("set_text_properties", { nodeIds: [t.id], autoResize: "truncate" });
    expect(r.items[0]).toMatchObject({ ok: true });
    expect(t.textAutoResize).toBe("TRUNCATE");
  });

  it("truncate: false turns it off; with maxLines it is a contradiction refused up front", async () => {
    const t = add(new Text("x"));
    t.textTruncation = "ENDING";
    await run("set_text_properties", { nodeIds: [t.id], truncate: false });
    expect(t.textTruncation).toBe("DISABLED");
    const err = await fails("set_text_properties", { nodeIds: [t.id], truncate: false, maxLines: 2 });
    expect(err).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    expect(err.message).toMatch(/contradicts `maxLines`/);
  });

  it("vertical alignment, leading trim and wrap style are whole-node writes", async () => {
    const t = add(new Text("Centered"));
    await run("set_text_properties", { nodeIds: [t.id], alignVertical: "center", leadingTrim: "cap-height", wrapStyle: "balance" });
    expect([t.textAlignVertical, t.leadingTrim, t.textWrapStyle]).toEqual(["CENTER", "CAP_HEIGHT", "BALANCE"]);
  });

  it("paragraph spacing, indent and a list cover the whole text", async () => {
    const t = add(new Text("One\nTwo"));
    await run("set_text_properties", { nodeIds: [t.id], paragraphSpacing: 12, paragraphIndent: 8, list: "unordered" });
    expect(t.calls).toEqual(["paragraphSpacing 0-7 12", "paragraphIndent 0-7 8", 'list 0-7 {"type":"UNORDERED"}']);
  });

  it("a node that lacks a member the edit needs is reported, and left untouched", async () => {
    const old = add(new OldText("Old text"));
    const t = add(new Text("New text"));
    const r = await run("set_text_properties", { nodeIds: [old.id, t.id], fontSize: 20, maxLines: 3 });
    expect(r.items[0]).toEqual({ id: old.id, ok: false, error: "this Figma's text has no textTruncation, maxLines" });
    expect(old.calls).toEqual([]); // not even the font size
    expect(r.items[1]).toMatchObject({ id: t.id, ok: true });
  });

  it("an empty text still takes the whole-node properties", async () => {
    const t = add(new Text(""));
    await run("set_text_properties", { nodeIds: [t.id], maxLines: 1, alignVertical: "bottom" });
    expect([t.textTruncation, t.maxLines, t.textAlignVertical]).toEqual(["ENDING", 1, "BOTTOM"]);
  });

  it("refuses bad values before any node changes", async () => {
    const t = add(new Text("x"));
    for (const bad of [{ maxLines: 0 }, { maxLines: 1.5 }, { paragraphSpacing: -1 }, { list: "roman" }, { leadingTrim: "baseline" }]) {
      expect(await fails("set_text_properties", { nodeIds: [t.id], ...bad })).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    }
    expect(t.calls).toEqual([]);
  });
});

// ── a range ───────────────────────────────────────────────────────────────────

describe("figma_set_text_range — paragraphs, links, styles and variables", () => {
  it("paragraph spacing, indent and an ordered list on part of the text", async () => {
    const t = add(new Text("Intro\nStep one\nStep two"));
    await run("set_text_range", { nodeId: t.id, match: "Step", list: "ordered", paragraphSpacing: 4, paragraphIndent: 16 });
    expect(t.calls).toContain('list 6-10 {"type":"ORDERED"}');
    expect(t.calls).toContain("paragraphSpacing 15-19 4");
    expect(t.calls).toContain("paragraphIndent 15-19 16");
  });

  it("whole-node properties are refused on a range, by their tool names", async () => {
    const t = add(new Text("Hello"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "Hello", maxLines: 2, alignVertical: "center" });
    expect(err.message).toMatch(/`alignVertical`, `truncate`, `maxLines` apply to the whole node/);
    expect(err.partial).toEqual({ created: [] });
  });

  it('link "node:<id>" links to a layer in this file, by its canonical id', async () => {
    const t = add(new Text("See pricing"));
    const target = add({ id: "12:34", type: "FRAME", name: "Pricing" });
    const r = await run("set_text_range", { nodeId: t.id, match: "pricing", link: "node:12-34" });
    expect(t.calls).toContain(`link 4-11 {"type":"NODE","value":"${target.id}"}`);
    expect(r.link).toEqual({ type: "NODE", value: "12:34" });
  });

  it("a link to a node that does not exist is refused with the text untouched", async () => {
    const t = add(new Text("See pricing"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "pricing", weight: "Bold", link: "node:99:99" });
    expect(err).toMatchObject({ code: "NODE_NOT_FOUND", partial: { created: [] } });
    expect(t.calls).toEqual([]);
  });

  it("a text style by name: its font is loaded first, then setRangeTextStyleIdAsync", async () => {
    const t = add(new Text("Hello world"));
    const r = await run("set_text_range", { nodeId: t.id, match: "world", textStyle: "Body/Strong" });
    expect(loaded).toContain("Lora Bold");
    expect(t.calls).toEqual(["textStyle 6-11 S:text1,"]);
    expect(r.textStyle).toEqual({ id: "S:text1,", name: "Body/Strong" });
  });

  it("a paint style's id given as textStyle is refused, naming its kind", async () => {
    const t = add(new Text("Hello"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "Hello", textStyle: "S:paint1," });
    expect(err.message).toMatch(/`textStyle` needs a TEXT style; "Brand\/Primary" is PAINT/);
  });

  it("a fill style, or a colour variable as a bound solid paint", async () => {
    const t = add(new Text("Go Pro"));
    await run("set_text_range", { nodeId: t.id, match: "Go", fillStyle: "Brand/Primary" });
    expect(t.calls).toContain("fillStyle 0-2 S:paint1,");
    await run("set_text_range", { nodeId: t.id, match: "Pro", colorVariable: "color/text/link" });
    expect(t.calls).toContain('fills 3-6 [{"type":"SOLID","color":{"r":0,"g":0,"b":0},"boundVariables":{"color":{"type":"VARIABLE_ALIAS","id":"VariableID:1:2"}}}]');
  });

  it("one colour source per call", async () => {
    const t = add(new Text("Pro"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "Pro", color: "#ff0000", colorVariable: "color/text/link" });
    expect(err.message).toMatch(/Give one of `color`, `colorVariable`/);
  });

  it("variables bind per field with the Variable object", async () => {
    const t = add(new Text("Body copy"));
    const r = await run("set_text_range", { nodeId: t.id, start: 0, end: 4, variables: { fontSize: "type/body/size", paragraphSpacing: "VariableID:1:1" } });
    expect(t.calls).toEqual(["bind 0-4 fontSize VariableID:1:1", "bind 0-4 paragraphSpacing VariableID:1:1"]);
    expect(r.bound).toEqual({ fontSize: "type/body/size", paragraphSpacing: "type/body/size" });
  });

  it("a bound family's font is loaded before the binding — and one that cannot load is refused up front", async () => {
    const t = add(new Text("Serif"));
    await run("set_text_range", { nodeId: t.id, match: "Serif", variables: { fontFamily: "type/serif" } });
    expect(loaded).toContain("Lora Regular");
    const err = await fails("set_text_range", { nodeId: t.id, match: "Serif", variables: { fontFamily: "type/missing" } });
    expect(err).toMatchObject({ code: "FONT_LOAD_FAILED", partial: { created: [] } });
  });

  it("a bound fontWeight's font is loaded before any write, so the size and the binding both land", async () => {
    const t = add(new Text("Go Pro"));
    const r = await run("set_text_range", { nodeId: t.id, match: "Pro", fontSize: 20, variables: { fontWeight: "type/weight/bold" } });
    expect(loaded).toContain("Inter Bold");
    expect(t.calls).toEqual(["size 3-6 20", "bind 3-6 fontWeight VariableID:1:5"]);
    expect(r.bound).toEqual({ fontWeight: "type/weight/bold" });
  });

  it("a bound family or style is loaded as the range will be after `weight` or `textStyle`, not as it was", async () => {
    const bold = add(new Text("Serif"));
    await run("set_text_range", { nodeId: bold.id, match: "Serif", weight: "Bold", variables: { fontFamily: "type/serif" } });
    expect(loaded).toContain("Lora Bold"); // Inter Bold after `weight`, then the family switches
    expect(bold.calls).toEqual(["font 0-5 Inter Bold", "bind 0-5 fontFamily VariableID:1:3"]);
    const styled = add(new Text("Quote"));
    await run("set_text_range", { nodeId: styled.id, match: "Quote", textStyle: "Body/Strong", variables: { fontStyle: "type/style/regular" } });
    expect(loaded).toContain("Lora Regular"); // the style's Lora Bold, then the style switches
    expect(styled.calls).toEqual(["textStyle 0-5 S:text1,", "bind 0-5 fontStyle VariableID:1:7"]);
  });

  it("a fontWeight that lands on a font this Figma cannot load is refused before the size changes", async () => {
    const t = add(new Text("Go Pro"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "Pro", fontSize: 20, variables: { fontWeight: "type/weight/black" } });
    expect(err).toMatchObject({ code: "FONT_LOAD_FAILED", partial: { created: [] } });
    expect(err.message).toMatch(/Inter Black/);
    expect(t.calls).toEqual([]);
  });

  it("an unknown variable, or one of the wrong type, is refused with the node untouched", async () => {
    const t = add(new Text("Body copy"));
    const unknown = await fails("set_text_range", { nodeId: t.id, match: "Body", weight: "Bold", variables: { fontSize: "type/nope" } });
    expect(unknown).toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    expect(unknown.message).toMatch(/^`variables\.fontSize`: No variable named "type\/nope"/);
    const wrong = await fails("set_text_range", { nodeId: t.id, match: "Body", variables: { fontSize: "color/text/link" } });
    expect(wrong.message).toMatch(/binds a FLOAT variable; "color\/text\/link" is COLOR/);
    const field = await fails("set_text_range", { nodeId: t.id, match: "Body", variables: { textCase: "type/body/size" } });
    expect(field.message).toMatch(/`variables` takes only fontSize/);
    expect(t.calls).toEqual([]);
  });

  it("a build without the range setters says which member is missing", async () => {
    const t = add(new OldText("Old text"));
    const err = await fails("set_text_range", { nodeId: t.id, match: "Old", list: "ordered", textStyle: "Body/Strong" });
    expect(err).toMatchObject({ code: "UNSUPPORTED", partial: { created: [] } });
    expect(err.message).toMatch(/setRangeListOptions, setRangeTextStyleIdAsync/);
  });
});

// ── schemas ───────────────────────────────────────────────────────────────────

describe("typography tool schemas carry every new field", () => {
  const tools = new Map<string, { inputSchema: z.ZodRawShape; description: string }>();
  registerTypography(
    { registerTool: (name: string, config: { inputSchema: z.ZodRawShape; description: string }) => tools.set(name, config) } as unknown as McpServer,
    {} as Bridge,
    { exportDir: ".", exportRoots: [] } as never,
    () => true,
  );
  const parse = (name: string, args: Record<string, unknown>) => z.object(tools.get(name)!.inputSchema).parse(args);

  it("set_text_properties and set_text_range", () => {
    const whole = { nodeIds: ["1:1"], maxLines: 2, truncate: true, alignVertical: "center", leadingTrim: "cap-height", wrapStyle: "pretty", paragraphSpacing: 8, paragraphIndent: 4, list: "ordered" };
    expect(parse("figma_set_text_properties", whole)).toMatchObject(whole);
    const range = {
      nodeId: "1:1", match: "x", textStyle: "Body", fillStyle: "Brand", colorVariable: "c", link: "node:1:2", list: "unordered",
      variables: { fontSize: "a", fontFamily: "b", fontStyle: "c", fontWeight: "d", lineHeight: "e", letterSpacing: "f", paragraphSpacing: "g", paragraphIndent: "h" },
    };
    expect(parse("figma_set_text_range", range)).toMatchObject(range);
    expect(parse("figma_import_svg", { svg: "<svg/>", colorVariable: "color/icon" })).toMatchObject({ colorVariable: "color/icon" });
  });

  it("a misspelt `variables` field is refused by the schema, not stripped before the plugin's check", () => {
    expect(() => parse("figma_set_text_range", { nodeId: "1:1", match: "x", variables: { fontWeigth: "type/weight/bold" } })).toThrow(/fontWeigth/);
  });

  it("descriptions fit the 1024 cap whole", () => {
    expect(tools.get("figma_set_text_properties")!.description).toMatch(/one node failing does not fail the call\.$/);
    expect(tools.get("figma_set_text_range")!.description).toMatch(/use figma_set_text_properties\.$/);
    expect(tools.get("figma_import_svg")!.description).toMatch(/by `parentId`\.$/);
  });
});

describe("figma_create_text takes the text lengths figma_set_text_properties takes", () => {
  const tools = new Map<string, { inputSchema: z.ZodRawShape }>();
  registerCreate(
    { registerTool: (name: string, config: { inputSchema: z.ZodRawShape }) => tools.set(name, config) } as unknown as McpServer,
    {} as Bridge,
    () => true,
  );
  const parse = (args: Record<string, unknown>) => z.object(tools.get("figma_create_text")!.inputSchema).strict().parse(args);

  it("strings pass as they are, and a bare number passes the schema as its string, still px", () => {
    expect(parse({ content: "Hi", lineHeight: "150%", letterSpacing: "-1%" })).toMatchObject({ lineHeight: "150%", letterSpacing: "-1%" });
    expect(parse({ content: "Hi", lineHeight: "auto", letterSpacing: "0.5px" })).toMatchObject({ lineHeight: "auto", letterSpacing: "0.5px" });
    expect(parse({ content: "Hi", lineHeight: 24, letterSpacing: -0.5 })).toMatchObject({ lineHeight: "24", letterSpacing: "-0.5" });
    expect(parse({ content: "Hi" })).not.toHaveProperty("lineHeight");
  });

  it("anything else is refused by the schema, not turned into text", () => {
    for (const bad of [true, null, {}, Number.NaN]) expect(() => parse({ content: "Hi", lineHeight: bad })).toThrow();
    expect(() => parse({ content: "Hi", letterSpacing: [1] })).toThrow();
  });

  it("a px value goes to the plugin as the number it was, for a plugin older than the string grammar", () => {
    const keys = ["lineHeight", "letterSpacing"];
    // Exactly the strings the preprocess makes from a finite number come back as that number.
    for (const n of [24, -0.5, 0.6, 1e-7, 1e21]) {
      expect(textLengthsForPlugin(parse({ content: "Hi", lineHeight: n, letterSpacing: n }), keys)).toMatchObject({ lineHeight: n, letterSpacing: n });
    }
    // Units, "auto" and other spellings stay strings for the plugin's own parser.
    for (const s of ["150%", "24px", "auto", "24.0", " 24", "+24", "-0", "Infinity", "0x10", ""]) {
      expect(textLengthsForPlugin({ lineHeight: s }, keys)).toEqual({ lineHeight: s });
    }
    // An absent field stays absent, and other fields are not touched.
    expect(textLengthsForPlugin({ content: "12", fontSize: 12 }, keys)).toEqual({ content: "12", fontSize: 12 });
  });
});
