// The shared FigJam vocabulary, grid placement, safe member reads and text
// targets — the seams the board, slide, read and write tools all build on, so
// each is pinned here once rather than four times.

import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import {
  CODE_LANGUAGES,
  formatEndpoint,
  kebab,
  LINE_TYPES,
  MAGNETS,
  parseCodeLanguage,
  parseEndpoint,
  parseLineType,
  parseShapeType,
  parseStrokeCap,
  SHAPE_TYPES,
  STROKE_CAPS,
  UNCONFIRMED_LANGUAGES,
  type ConnectorEndpoint,
} from "../src/shared/figjam.js";
import { arrangeColumns, placeGrid } from "../src/shared/grid-layout.js";
import { apiHas, editorType, has, tryGet } from "../src/plugin/safe.js";
import { CONNECTOR_LABEL_FONT, fontsOf, loadTextFonts, textTarget } from "../src/plugin/sublayer.js";
import { FakeCodeBlock, FakeConnector, FakeFigma, FakeShapeWithText, FakeSticky, FakeTable, installFigma, makeOpaque, FakeSlideGrid, FakeNode } from "./editor-fakes.js";

function refusal(fn: () => unknown): BridgeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}

describe("connector endpoints: one string each way", () => {
  it("parses the four forms and normalises the id separator", () => {
    expect(parseEndpoint("12:34", "from")).toEqual({ endpointNodeId: "12:34", magnet: "AUTO" });
    expect(parseEndpoint("12-34@RIGHT", "from")).toEqual({ endpointNodeId: "12:34", magnet: "RIGHT" });
    expect(parseEndpoint("12:34@0.5,1", "from")).toEqual({ endpointNodeId: "12:34", position: { x: 0.5, y: 1 } });
    expect(parseEndpoint("120,340", "from")).toEqual({ position: { x: 120, y: 340 } });
    expect(parseEndpoint(" 12-34 @ top ", "from")).toEqual({ endpointNodeId: "12:34", magnet: "TOP" });
    expect(parseEndpoint("-20.5, 1e2", "to")).toEqual({ position: { x: -20.5, y: 100 } });
  });

  it("round-trips: formatEndpoint(parseEndpoint(s)) is s normalised, and parse(format(e)) is e", () => {
    const cases: Array<[string, string]> = [
      ["12:34", "12:34"],
      ["12-34@RIGHT", "12:34@RIGHT"],
      ["12:34@0.5,1", "12:34@0.5,1"],
      ["120,340", "120,340"],
      ["12:34@auto", "12:34"],
      ["I1-2;3-4@none", "I1:2;3:4@NONE"],
    ];
    for (const [input, normal] of cases) {
      const parsed = parseEndpoint(input, "from");
      expect(formatEndpoint(parsed), input).toBe(normal);
      expect(parseEndpoint(formatEndpoint(parsed), "from"), input).toEqual(parsed);
    }
    const all: ConnectorEndpoint[] = [
      { position: { x: -3, y: 4.25 } },
      ...MAGNETS.map((magnet) => ({ endpointNodeId: "5:6", magnet })),
      { endpointNodeId: "5:6", position: { x: 0, y: 1 } },
    ];
    for (const e of all) expect(parseEndpoint(formatEndpoint(e), "from")).toEqual(e);
  });

  it("takes a spec ref only where refs are allowed, and marks it", () => {
    expect(parseEndpoint("ref_a@top", "spec.children[3].from", { refs: true })).toEqual({ endpointNodeId: "ref_a", magnet: "TOP", ref: true });
    expect(formatEndpoint(parseEndpoint("ref_a@top", "from", { refs: true }))).toBe("ref_a@TOP");
    expect(parseEndpoint("card-1", "from", { refs: true })).toEqual({ endpointNodeId: "card-1", magnet: "AUTO", ref: true });
    const e = refusal(() => parseEndpoint("ref_a@top", "connectors[0].from"));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/connectors\[0\]\.from.*"ref_a" is not a node id\./);
  });

  it("refuses an unknown magnet listing all seven, an empty magnet, and three numbers — naming the field", () => {
    const north = refusal(() => parseEndpoint("12:34@north", "connectors[2].to"));
    expect(north.message).toContain("`connectors[2].to`");
    for (const m of MAGNETS) expect(north.message).toContain(m);
    expect(MAGNETS).toHaveLength(7);
    expect(refusal(() => parseEndpoint("abc@", "from", { refs: true })).message).toMatch(/nothing follows "@"/);
    expect(refusal(() => parseEndpoint("abc@", "from")).message).toMatch(/"abc" is not a node id\./);
    expect(refusal(() => parseEndpoint("12:34@", "from")).message).toMatch(/nothing follows "@"/);
    expect(refusal(() => parseEndpoint("1,2,3", "from")).message).toMatch(/two numbers/);
    expect(refusal(() => parseEndpoint("12:34@1,x", "from")).message).toMatch(/two numbers/);
    expect(refusal(() => parseEndpoint("", "from")).message).toMatch(/non-empty string/);
    expect(refusal(() => parseEndpoint(42, "from")).hint).toMatch(/<node>@<magnet>/);
  });
});

describe("enum vocabularies", () => {
  it("carry every value of the typings: 30 shapes, 7 magnets, 12 caps, 3 line types, 17 languages", () => {
    expect(SHAPE_TYPES).toHaveLength(30);
    expect(new Set(SHAPE_TYPES).size).toBe(30);
    expect(STROKE_CAPS).toHaveLength(12);
    expect(LINE_TYPES).toEqual(["ELBOWED", "STRAIGHT", "CURVED"]);
    expect(CODE_LANGUAGES).toHaveLength(17);
    // DART is in the typings, missing from the official skill [C-143]: accepted, flagged.
    expect(CODE_LANGUAGES).toContain("DART");
    expect([...UNCONFIRMED_LANGUAGES]).toEqual(["DART"]);
  });

  it("map kebab case and Figma's spelling both ways, case-insensitively", () => {
    expect(parseShapeType("rounded-rectangle", "s")).toBe("ROUNDED_RECTANGLE");
    expect(parseShapeType("Rounded Rectangle", "s")).toBe("ROUNDED_RECTANGLE");
    expect(parseShapeType("ENG_DATABASE", "s")).toBe("ENG_DATABASE");
    expect(parseStrokeCap("arrow-lines", "c")).toBe("ARROW_LINES");
    expect(parseStrokeCap("erd-one-or-more", "c")).toBe("ERD_ONE_OR_MORE");
    expect(parseLineType("curved", "l")).toBe("CURVED");
    expect(parseCodeLanguage("typescript", "language")).toBe("TYPESCRIPT");
    for (const v of SHAPE_TYPES) expect(parseShapeType(kebab(v), "s")).toBe(v);
    for (const v of STROKE_CAPS) expect(parseStrokeCap(kebab(v), "c")).toBe(v);
    for (const v of CODE_LANGUAGES) expect(parseCodeLanguage(v.toLowerCase(), "l")).toBe(v);
    expect(kebab("ERD_ZERO_OR_ONE")).toBe("erd-zero-or-one");
  });

  it("refuse anything else, naming the field and listing the values", () => {
    const e = refusal(() => parseCodeLanguage("cobol", "language"));
    expect(e.message).toMatch(/`language`: "cobol" is not a code-block language/);
    expect(e.hint).toContain("plaintext");
    expect(refusal(() => parseShapeType("blob", "shapes[1].shape")).hint).toContain("speech-bubble");
    expect(refusal(() => parseStrokeCap(3, "endCap")).message).toContain("`endCap`");
  });
});

describe("placeGrid: rows from real sizes", () => {
  it("never overlaps mixed heights; a row starts below the previous row's tallest item plus the gap", () => {
    const sizes = [
      { w: 240, h: 240 },
      { w: 240, h: 410 },
      { w: 416, h: 240 },
      { w: 240, h: 300 },
      { w: 240, h: 240 },
    ];
    const { positions, bounds } = placeGrid(sizes, { columns: 3, gap: 64, origin: { x: 100, y: 50 } });
    expect(positions.map((p) => [p.x, p.y])).toEqual([
      [100, 50],
      [404, 50],
      [708, 50],
      [100, 50 + 410 + 64],
      [404, 50 + 410 + 64],
    ]);
    expect(positions[3]).toMatchObject({ row: 1, col: 0 });
    const boxes = positions.map((p, i) => ({ ...p, w: sizes[i]!.w, h: sizes[i]!.h }));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    expect(bounds).toEqual({ x: 100, y: 50, width: 240 + 64 + 240 + 64 + 416, height: 410 + 64 + 300 });
  });

  it("handles one column, no items, and refuses nonsense", () => {
    expect(placeGrid([{ w: 10, h: 20 }, { w: 30, h: 5 }], { columns: 1, gap: 8 }).positions.map((p) => p.y)).toEqual([0, 28]);
    expect(placeGrid([], { columns: 3, gap: 8 }).bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(() => placeGrid([{ w: 1, h: 1 }], { columns: 0, gap: 8 })).toThrow(RangeError);
    expect(() => placeGrid([{ w: 1, h: 1 }], { columns: 2, gap: -1 })).toThrow(RangeError);
    expect(() => placeGrid([{ w: Number.NaN, h: 1 }], { columns: 2, gap: 1 })).toThrow(RangeError);
  });

  it("arrange strings: row, column, grid:N", () => {
    expect(arrangeColumns("row", 7)).toBe(7);
    expect(arrangeColumns("column", 7)).toBe(1);
    expect(arrangeColumns("Grid:3", 7)).toBe(3);
    expect(() => arrangeColumns("grid:0", 7)).toThrow(/grid:N/);
    expect(() => arrangeColumns("diagonal", 7)).toThrow(RangeError);
  });
});

describe("safe member reads (missing members may throw) [C-145]", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("has is false when the check throws; tryGet reports Figma's message", () => {
    const grid = new FakeSlideGrid();
    expect(has(grid, "children")).toBe(true);
    expect(tryGet(grid, "fills")).toEqual({ ok: false, message: "no such property 'fills' on SLIDE_GRID node" });
    expect(tryGet(grid, "nope")).toEqual({ ok: false, message: "no property 'nope'" });
    expect(tryGet(grid, "name")).toEqual({ ok: true, value: "Grid" });
    const hostile = new Proxy({}, { has: () => { throw new TypeError("no such property 'x'"); } });
    expect(has(hostile, "x")).toBe(false);
    expect(has(null, "x")).toBe(false);
    expect(tryGet(undefined, "x").ok).toBe(false);
  });

  it("an optional member that is present but undefined still reads as present", () => {
    expect(tryGet({ focusedSlide: undefined }, "focusedSlide")).toEqual({ ok: true, value: undefined });
  });

  it("apiHas and editorType read the global through every behaviour", () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    uninstall = installFigma(fake);
    expect(editorType()).toBe("figjam");
    expect(apiHas("createSticky")).toBe(true);
    expect(apiHas("currentPage.appendChild")).toBe(true);
    expect(apiHas("createWidget")).toBe(false);
    fake.throwing.add("createPage");
    expect(apiHas("createPage")).toBe(false);
    fake.removed.add("createSticky");
    expect(apiHas("createSticky")).toBe(false);
    fake.throwing.add("editorType");
    expect(editorType()).toBeUndefined();
  });

  it("the opaque fake logs the read it refused", () => {
    const grid = makeOpaque(new FakeNode("SLIDE_GRID"));
    expect(() => (grid as unknown as { fills: unknown }).fills).toThrow(/no such property 'fills' on SLIDE_GRID node/);
    expect(grid.opaqueReads).toEqual(["fills"]);
  });
});

describe("text targets and their fonts", () => {
  it("TEXT is itself, sticky / shape / connector use the sublayer, a code block its code, a table none", () => {
    const text = { id: "1:1", type: "TEXT", characters: "Hi", fontName: { family: "Inter", style: "Regular" } };
    expect(textTarget(text)).toMatchObject({ kind: "text", target: text });
    for (const node of [new FakeSticky(), new FakeShapeWithText(), new FakeConnector()]) {
      expect(textTarget(node)).toMatchObject({ kind: "sublayer", target: node.text, owner: node });
    }
    const code = new FakeCodeBlock();
    expect(textTarget(code)).toMatchObject({ kind: "code", target: code });
    expect(textTarget(new FakeTable())).toBeNull();
    expect(textTarget({ type: "FRAME" })).toBeNull();
    const broken = makeOpaque(new FakeNode("STICKY"), ["text"]);
    expect(textTarget(broken)).toBeNull();
  });

  it("a connector whose fontName read throws gets Inter Medium — loaded, then set — before anything else [C-148]", async () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    const c = fake.createConnector();
    c.text.fontState = "throw";
    const out = await loadTextFonts(textTarget(c)!, fake);
    expect(out.reset).toEqual(CONNECTOR_LABEL_FONT);
    expect(fake.fontLoads).toEqual([CONNECTOR_LABEL_FONT]);
    expect(c.text.writes).toEqual(["fontName"]);
    expect(c.text.fontName).toEqual(CONNECTOR_LABEL_FONT);
  });

  it("a fresh connector's invalid font does not load, so it is replaced too; a usable one is kept", async () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    const fresh = fake.createConnector();
    expect((await loadTextFonts(textTarget(fresh)!, fake)).reset).toEqual(CONNECTOR_LABEL_FONT);
    const labelled = fake.createConnector();
    labelled.text.fontName = { family: "Roboto Mono", style: "Medium" };
    labelled.text.writes.length = 0;
    const kept = await loadTextFonts(textTarget(labelled)!, fake);
    expect(kept.reset).toBeUndefined();
    expect(labelled.text.writes).toEqual([]);
  });

  it("a sticky's fonts are loaded as they are; one that will not load is FONT_LOAD_FAILED naming it", async () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    const s = fake.createSticky();
    s.text.characters = "Retro";
    expect(fontsOf(s.text)).toEqual([{ family: "Inter", style: "Medium" }]);
    expect((await loadTextFonts(textTarget(s)!, fake)).fonts).toEqual([{ family: "Inter", style: "Medium" }]);
    fake.unloadable.add("Inter|Medium");
    const err = await loadTextFonts(textTarget(s)!, fake).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("FONT_LOAD_FAILED");
    expect((err as BridgeError).message).toContain(`STICKY \`${s.id}\``);
  });

  it("a code block needs no font", async () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    expect(await loadTextFonts(textTarget(fake.createCodeBlock())!, fake)).toEqual({ fonts: [] });
    expect(fake.fontLoads).toEqual([]);
  });
});
