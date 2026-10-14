// figma_get_design_context — the agent's eyes on an existing design.
//
// Found 2026-10-08 by reading the op, not by a test: the old walk returned
// `false` from its visitor to "prune children", but walk() treats `false` as
// STOP. With the default depth 2 the read ended at the first node two levels
// down — every later branch missing, `truncated: false`. And every node was
// emitted twice: nested inside its parent and again as its own entry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContext, contrastRatio, decodeFrontier, encodeFrontier, screenSizing, type ContextNode, type ContextOptions } from "../src/plugin/context.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import type { OpContext } from "../src/plugin/ops/index.js";

const MIXED = Symbol("mixed");
let seq = 0;
const node = (type: string, name: string, props: Record<string, unknown> = {}, children?: unknown[]) =>
  ({ id: `7:${++seq}`, type, name, ...props, ...(children ? { children } : {}) }) as Record<string, unknown> & { id: string; children?: unknown[] };

const ctx = { yieldToHost: async () => {}, isCancelled: () => false };
const OPTS: ContextOptions = { depth: 8, maxNodes: 500, maxChildren: 50, includeGeometry: true, includeStyles: true, includeVariables: true };

function ids(n: ContextNode, out: string[] = []): string[] {
  out.push(n.id);
  for (const c of n.children ?? []) ids(c, out);
  return out;
}

beforeEach(() => {
  seq = 0;
  (globalThis as { figma?: unknown }).figma = {
    async getStyleByIdAsync(id: string) {
      return ({ "S:1,": { name: "Brand/Primary", type: "PAINT" }, "S:2,": { name: "Body/M", type: "TEXT" } } as Record<string, unknown>)[id] ?? null;
    },
    variables: {
      async getVariableByIdAsync(id: string) {
        if (id !== "V:1") return null;
        return { name: "space/4", resolvedType: "FLOAT", resolveForConsumer: () => ({ value: 16 }) };
      },
    },
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("the walk", () => {
  it("reads every branch to the requested depth — it no longer stops at the first deep node", async () => {
    const tree = node("FRAME", "Screen", {}, [
      node("FRAME", "Header", {}, [node("FRAME", "Nav", {}, [node("TEXT", "Home", { characters: "Home" })])]),
      node("FRAME", "Body", {}, [node("FRAME", "Card", {}, [node("TEXT", "Title", { characters: "Hi" })])]),
    ]);
    const r = await buildContext([tree as never], { ...OPTS, depth: 3 }, ctx);
    expect(ids(r.roots[0]!).length).toBe(7);
    expect(r.truncated).toBe(false);
  });

  it("emits each node exactly once", async () => {
    const tree = node("FRAME", "A", {}, [node("FRAME", "B", {}, [node("RECTANGLE", "C")])]);
    const r = await buildContext([tree as never], OPTS, ctx);
    const all = ids(r.roots[0]!);
    expect(new Set(all).size).toBe(all.length);
  });

  it("depth stops expansion but keeps childCount", async () => {
    const tree = node("FRAME", "A", {}, [node("FRAME", "B", {}, [node("RECTANGLE", "C")])]);
    const r = await buildContext([tree as never], { ...OPTS, depth: 1 }, ctx);
    const b = r.roots[0]!.children![0]!;
    expect(b.childCount).toBe(1);
    expect(b.children).toBeUndefined();
  });

  it("maxNodes truncates honestly, and the cursor returns exactly the rest", async () => {
    const kids = Array.from({ length: 10 }, (_, i) => node("RECTANGLE", `r${i}`));
    const tree = node("FRAME", "List", {}, kids);
    const byId = new Map([tree, ...kids].map((n) => [n.id, n]));
    const first = await buildContext([tree as never], { ...OPTS, maxNodes: 4 }, ctx);
    expect(first.truncated).toBe(true);
    expect(first.roots[0]!.continued).toBe(true);
    const cursor = encodeFrontier(first.frontier, OPTS);
    const f = decodeFrontier(cursor);
    const second = await buildContext(f.ids.map((id) => byId.get(id) as never), OPTS, ctx);
    const seen = [...ids(first.roots[0]!), ...second.roots.flatMap((n) => ids(n))];
    expect(seen.sort()).toEqual([...byId.keys()].sort());
  });
});

describe("what a node says about itself", () => {
  it("text: content, font, size, line height, letter spacing, colour, resize, style by name", async () => {
    const t = node("TEXT", "Title", {
      characters: "Hello", fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 24,
      lineHeight: { unit: "PIXELS", value: 32 }, letterSpacing: { unit: "PERCENT", value: -1 },
      textAlignHorizontal: "CENTER", textAutoResize: "HEIGHT", textStyleId: "S:2,",
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    });
    const r = await buildContext([t as never], OPTS, ctx);
    expect(r.roots[0]!.text).toEqual({
      characters: "Hello", font: "Inter Semi Bold", fontSize: 24, lineHeight: "32px", letterSpacing: "-1%",
      align: "center", resize: "wrap", color: "#000000",
    });
    expect(r.roots[0]!.styles).toEqual({ text: "Body/M" });
    expect(r.stylesUsed).toEqual([{ id: "S:2,", name: "Body/M", type: "TEXT" }]);
  });

  it("mixed values say 'mixed', never one of their parts", async () => {
    const t = node("TEXT", "Rich", { characters: "a b", fontName: MIXED, fontSize: MIXED, fills: [] });
    const f = node("FRAME", "F", { cornerRadius: MIXED, topLeftRadius: 4, topRightRadius: 8, bottomRightRadius: 4, bottomLeftRadius: 8 });
    const r = await buildContext([t as never, f as never], OPTS, ctx);
    expect(r.roots[0]!.text).toMatchObject({ font: "mixed", fontSize: "mixed" });
    expect(r.roots[1]!.cornerRadius).toEqual([4, 8, 4, 8]);
  });

  it("auto-layout in screen terms, paints with their style and variable names", async () => {
    const f = node("FRAME", "Stack", {
      layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24,
      primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }], fillStyleId: "S:1,",
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0 }],
      boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "V:1" } },
    });
    const n = (await buildContext([f as never], OPTS, ctx)).roots[0]!;
    expect(n).toMatchObject({
      layoutMode: "VERTICAL", itemSpacing: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 },
      alignMain: "space-between", alignCross: "center", sizing: { horizontal: "FIXED", vertical: "HUG" },
      fills: ["#ffffff 50%"], styles: { fill: "Brand/Primary" }, variables: { itemSpacing: "space/4" },
      effects: ["drop-shadow 0 4 8 0 #000000 25%"],
    });
  });

  it("an instance names its component, its set and its properties", async () => {
    const set = { type: "COMPONENT_SET", name: "Button" };
    const main = { id: "1:2", name: "Size=Large", parent: set };
    const inst = node("INSTANCE", "Button", {
      getMainComponentAsync: async () => main,
      componentProperties: { "Label#12:0": { type: "TEXT", value: "Buy" }, Size: { type: "VARIANT", value: "Large" } },
    });
    const n = (await buildContext([inst as never], OPTS, ctx)).roots[0]!;
    expect(n.component).toEqual({ id: "1:2", name: "Size=Large", set: "Button", properties: { Label: "Buy", Size: "Large" } });
  });

  it("gradients are described, not flattened into a hex", async () => {
    const f = node("FRAME", "G", {
      fills: [{ type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }],
    });
    const n = (await buildContext([f as never], OPTS, ctx)).roots[0]!;
    expect(n.fills).toEqual(["linear-gradient(#000000 0%, #ffffff 100%)"]);
    expect(n.fill).toBeUndefined();
  });
});

describe("helpers", () => {
  it("screenSizing maps layout axes onto screen axes", () => {
    expect(screenSizing({ layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })).toEqual({ horizontal: "HUG", vertical: "FIXED" });
    expect(screenSizing({ layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })).toEqual({ horizontal: "FIXED", vertical: "HUG" });
    expect(screenSizing({ layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" })).toEqual({ horizontal: "FILL", vertical: "HUG" });
  });

  it("contrast ratio: black on white is 21", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 })).toBeCloseTo(21, 5);
  });
});

describe("the op", () => {
  it("returns one tree, plus the styles and variables it met", async () => {
    const tree = node("FRAME", "Card", { fillStyleId: "S:1," }, [node("TEXT", "T", { characters: "x", fills: [] })]);
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.getNodeByIdAsync = async (id: string) => (id === tree.id ? tree : null);
    const r = (await READ_OPS.get_design_context!.run({
      requestId: "r", params: { nodeId: tree.id }, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
    } as OpContext)) as { root: ContextNode; nodeCount: number; truncated: boolean; stylesUsed: unknown };
    expect(r.root.name).toBe("Card");
    expect(r.root.children).toHaveLength(1);
    expect(r.nodeCount).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.stylesUsed).toEqual([{ id: "S:1,", name: "Brand/Primary", type: "PAINT" }]);
  });
});

// ── parity: what the official design context carries and this one did not ──
// (gaps G-05, G-07, G-08, G-09, G-10, G-13, G-41, G-54, G-65, G-83, G-85)

const g = globalThis as unknown as { figma: Record<string, unknown> };
const runOp = (params: Record<string, unknown>) =>
  READ_OPS.get_design_context!.run({
    requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
  } as OpContext) as Promise<Record<string, unknown>>;
const stops = [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
const one = async (n: Record<string, unknown>, opts: Partial<ContextOptions> = {}) => (await buildContext([n as never], { ...OPTS, ...opts }, ctx)).roots[0]!;

describe("paints keep their direction, position and source [C-100] [C-093]", () => {
  it("a linear gradient carries its CSS angle: identity is 90deg, the official top-to-bottom matrix 180deg", async () => {
    const ltr = await one(node("FRAME", "L", { width: 400, height: 240, fills: [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops }] }));
    expect(ltr.fills).toEqual(["linear-gradient(90deg, #000000 0%, #ffffff 100%)"]);
    const ttb = await one(node("FRAME", "T", { width: 200, height: 200, fills: [{ type: "GRADIENT_LINEAR", gradientTransform: [[0, 1, 0], [-1, 0, 1]], gradientStops: stops }] }));
    expect(ttb.fills).toEqual(["linear-gradient(180deg, #000000 0%, #ffffff 100%)"]);
  });

  it("radial, diamond and angular gradients say where they are centred", async () => {
    const id = [[1, 0, 0], [0, 1, 0]];
    const f = await one(node("FRAME", "G", {
      width: 100, height: 100,
      fills: [
        { type: "GRADIENT_RADIAL", gradientTransform: id, gradientStops: stops },
        { type: "GRADIENT_DIAMOND", gradientTransform: [[2, 0, 0], [0, 2, 0]], gradientStops: stops },
        { type: "GRADIENT_ANGULAR", gradientTransform: id, gradientStops: stops },
      ],
    }));
    expect(f.fills).toEqual([
      "radial-gradient(at 50% 50%, #000000 0%, #ffffff 100%)",
      "diamond-gradient(at 25% 25%, #000000 0%, #ffffff 100%)",
      "angular-gradient(from 90deg at 50% 50%, #000000 0%, #ffffff 100%)",
    ]);
  });

  it("an image fill names its scale mode and hash, with rotation and filters when set", async () => {
    const f = await one(node("RECTANGLE", "Photo", {
      fills: [{ type: "IMAGE", scaleMode: "FILL", imageHash: "abc123", rotation: 90, filters: { exposure: 0.2, contrast: 0 } }],
    }));
    expect(f.fills).toEqual(["image FILL abc123 rotation 90 filters exposure 0.2"]);
  });

  it("isAsset marks an image or an icon — Figma's own heuristic", async () => {
    expect((await one(node("RECTANGLE", "Hero", { isAsset: true, fills: [{ type: "IMAGE", scaleMode: "FILL", imageHash: "h" }] }))).asset).toBe("image");
    expect((await one(node("VECTOR", "Arrow", { isAsset: true, fills: [] }))).asset).toBe("icon");
    expect((await one(node("FRAME", "Card", { isAsset: false }))).asset).toBeUndefined();
  });

  it("the newer effects are written out, not reduced to their type [C-102]", async () => {
    const f = await one(node("FRAME", "FX", {
      effects: [
        { type: "NOISE", noiseType: "DUOTONE", color: { r: 0, g: 0, b: 0, a: 0.25 }, secondaryColor: { r: 1, g: 1, b: 1, a: 1 }, noiseSize: 0.5, density: 0.4 },
        { type: "TEXTURE", noiseSize: 2, radius: 4, clipToShape: true },
        { type: "GLASS", lightIntensity: 0.5, lightAngle: 45, refraction: 0.3, depth: 10, dispersion: 0.1, radius: 8 },
        { type: "LAYER_BLUR", blurType: "PROGRESSIVE", startRadius: 0, radius: 12, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } },
      ],
    }));
    expect(f.effects).toEqual([
      "noise duotone #000000 25% #ffffff size 0.5 density 0.4",
      "texture size 2 radius 4 clip",
      "glass light 0.5 at 45deg refraction 0.3 depth 10 dispersion 0.1 radius 8",
      "blur progressive 0 to 12 from 0.5,0 to 0.5,1",
    ]);
  });
});

describe("mixed-style text reads back run by run [C-103]", () => {
  const seg = (start: number, characters: string, over: Record<string, unknown> = {}) => ({
    start, end: start + characters.length, characters,
    fontName: { family: "Inter", style: "Regular" }, fontWeight: 400, fontSize: 16, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    textDecoration: "NONE", textCase: "ORIGINAL", letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" },
    hyperlink: null, textStyleId: "", listOptions: { type: "NONE" }, ...over,
  });
  const rich = (segments: unknown[], props: Record<string, unknown> = {}) => {
    const characters = (segments as Array<{ characters: string }>).map((s) => s.characters).join("");
    let asked: unknown;
    const n = node("TEXT", "Rich", {
      characters, fontName: MIXED, fontWeight: MIXED, fontSize: 16, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      getStyledTextSegments: (fields: unknown) => ((asked = fields), segments), ...props,
    });
    return { n, asked: () => asked };
  };

  it("a bold word and a link become runs carrying only what differs", async () => {
    const { n } = rich([seg(0, "Buy "), seg(4, "Pro", { fontName: { family: "Inter", style: "Bold" }, fontWeight: 700 }), seg(7, " docs", { hyperlink: { type: "URL", value: "https://x.dev" }, textDecoration: "UNDERLINE" })]);
    const t = (await one(n)).text as Record<string, unknown>;
    expect(t.weight).toBe("mixed");
    expect(t.runs).toEqual([
      { start: 0, end: 4, characters: "Buy ", font: "Inter Regular", weight: 400, decoration: "none" },
      { start: 4, end: 7, characters: "Pro", font: "Inter Bold", weight: 700, decoration: "none" },
      { start: 7, end: 12, characters: " docs", font: "Inter Regular", weight: 400, decoration: "underline", link: "https://x.dev" },
    ]);
  });

  it("a link to a layer in the file reads as node:<id>", async () => {
    const t = (await one(node("TEXT", "Go", { characters: "Go", fontName: { family: "Inter", style: "Regular" }, hyperlink: { type: "NODE", value: "3:4" } }))).text as Record<string, unknown>;
    expect(t.link).toBe("node:3:4");
  });

  it("runs stop at 50 and say how many more there were", async () => {
    const segments = Array.from({ length: 60 }, (_, i) => seg(i * 2, "ab", { fontSize: 10 + i }));
    const t = (await one(rich(segments).n, { maxTextChars: 1000 })).text as Record<string, unknown>;
    expect((t.runs as unknown[]).length).toBe(50);
    expect(t.runsOmitted).toBe(10);
  });

  it("maxTextChars cuts the text, and the runs follow what is shown", async () => {
    const { n } = rich([seg(0, "a".repeat(10)), seg(10, "b".repeat(10), { fontSize: 20 })]);
    const t = (await one(n, { maxTextChars: 15 })).text as Record<string, unknown>;
    expect(t.characters).toBe(`${"a".repeat(10)}${"b".repeat(5)}…`);
    expect(t.length).toBe(20);
    expect((t.runs as Array<{ characters: string }>)[1]!.characters).toBe("bbbbb…");
  });

  it("asks for every field in one segment call, and gives no runs for one-run text", async () => {
    const { n, asked } = rich([seg(0, "Same")]);
    const t = (await one(n)).text as Record<string, unknown>;
    expect(asked()).toEqual(expect.arrayContaining(["fontName", "fontWeight", "fills", "hyperlink", "textStyleId", "listOptions"]));
    expect(t.runs).toBeUndefined();
  });

  it("paragraph features: spacing, indent, vertical align, truncation, list, leading trim", async () => {
    const { n } = rich([seg(0, "One\n", { listOptions: { type: "ORDERED" } }), seg(4, "Two", { listOptions: { type: "ORDERED" } })], {
      paragraphSpacing: 12, paragraphIndent: 0, textAlignVertical: "CENTER", textTruncation: "ENDING", maxLines: 2, leadingTrim: "CAP_HEIGHT",
    });
    const t = (await one(n)).text as Record<string, unknown>;
    expect(t).toMatchObject({ paragraphSpacing: 12, alignVertical: "center", truncate: true, maxLines: 2, list: "ordered", leadingTrim: "cap-height" });
    expect(t.paragraphIndent).toBeUndefined();
  });

  it("OpenType features and SF Symbols are flagged, not guessed", async () => {
    const t = (await one(node("TEXT", "Icon", {
      characters: "\u{10029D} Settings", fontName: { family: "SF Pro Text", style: "Regular" }, openTypeFeatures: { TNUM: true, LIGA: false },
    }))).text as Record<string, unknown>;
    expect(t.openType).toEqual({ TNUM: true, LIGA: false });
    expect(t.sfSymbols).toEqual(["U+10029D"]);
    const plain = (await one(node("TEXT", "Body", { characters: "", fontName: { family: "Inter", style: "Regular" }, openTypeFeatures: {} }))).text as Record<string, unknown>;
    expect(plain.sfSymbols).toBeUndefined();
    expect(plain.openType).toBeUndefined();
  });
});

describe("structure a geometry read cannot see", () => {
  it("wrap rows, limits, smoothing, layout grids, scrolling — each only when set", async () => {
    const f = await one(node("FRAME", "Tags", {
      layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 12, counterAxisAlignContent: "SPACE_BETWEEN",
      strokesIncludedInLayout: true, itemReverseZIndex: true, minWidth: 200, maxWidth: 640, minHeight: null, maxHeight: null,
      cornerSmoothing: 0.6, overflowDirection: "VERTICAL", numberOfFixedChildren: 1,
      layoutGrids: [{ pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 24, offset: 64 }, { pattern: "GRID", sectionSize: 8, visible: false }],
    }));
    expect(f).toMatchObject({
      wrap: true, rowGap: 12, alignContent: "space-between", strokesInLayout: true, reverseZIndex: true, minWidth: 200, maxWidth: 640,
      cornerSmoothing: 0.6, overflow: "vertical", fixedChildren: 1, layoutGrids: ["columns 12, gutter 24, margin 64", "grid 8 (hidden)"],
    });
    expect(f).not.toHaveProperty("minHeight");
    const plain = await one(node("FRAME", "Plain", { layoutMode: "HORIZONTAL", itemSpacing: 8, cornerSmoothing: 0, overflowDirection: "NONE", numberOfFixedChildren: 0 }));
    for (const k of ["rowGap", "alignContent", "cornerSmoothing", "overflow", "fixedChildren", "strokesInLayout"]) expect(plain).not.toHaveProperty(k);
  });

  it("a grid's tracks, and each child's cell", async () => {
    const cell = node("FRAME", "Cell", { gridRowAnchorIndex: 1, gridColumnAnchorIndex: 0, gridRowSpan: 1, gridColumnSpan: 2 });
    const grid = node("FRAME", "Grid", {
      layoutMode: "GRID", gridRowCount: 2, gridColumnCount: 3, gridRowGap: 16, gridColumnGap: 24,
      gridRowSizes: [{ type: "FIXED", value: 100 }, { type: "HUG" }], gridColumnSizes: [{ type: "FLEX", value: 1 }, { type: "FLEX", value: 2 }, { type: "FLEX" }],
    }, [cell]);
    const r = await one(grid);
    expect(r.grid).toEqual({ rows: 2, columns: 3, rowGap: 16, columnGap: 24, rowSizes: ["100", "hug"], columnSizes: ["1fr", "2fr", "1fr"] });
    expect(r.children![0]!.gridChild).toEqual({ row: 1, column: 0, columnSpan: 2 });
  });

  it("constraints only where no auto-layout places the node, and only when not left/top", async () => {
    const free = node("RECTANGLE", "Badge", { constraints: { horizontal: "MAX", vertical: "STRETCH" } });
    const flowing = node("RECTANGLE", "Item", { constraints: { horizontal: "MAX", vertical: "MIN" } });
    const absolute = node("RECTANGLE", "Dot", { layoutPositioning: "ABSOLUTE", constraints: { horizontal: "MAX", vertical: "MIN" } });
    const deflt = node("RECTANGLE", "Default", { constraints: { horizontal: "MIN", vertical: "MIN" } });
    const plain = await one(node("FRAME", "Plain", { layoutMode: "NONE" }, [free, deflt]));
    const stack = await one(node("FRAME", "Stack", { layoutMode: "VERTICAL" }, [flowing, absolute]));
    expect(plain.children![0]!.constraints).toEqual({ horizontal: "right", vertical: "top-bottom" });
    expect(plain.children![1]!.constraints).toBeUndefined();
    expect(stack.children![0]!.constraints).toBeUndefined();
    expect(stack.children![1]!.constraints).toEqual({ horizontal: "right", vertical: "top" });
  });

  it("masks, boolean operations and per-side strokes", async () => {
    expect((await one(node("ELLIPSE", "Mask", { isMask: true, maskType: "VECTOR" }))).mask).toEqual({ type: "vector" });
    expect((await one(node("BOOLEAN_OPERATION", "Crescent", { booleanOperation: "SUBTRACT" }))).booleanOperation).toBe("subtract");
    const sides = await one(node("FRAME", "Row", {
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokeWeight: MIXED, strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 1, strokeLeftWeight: 0,
    }));
    expect(sides.strokeWeights).toEqual({ top: 0, right: 0, bottom: 1, left: 0 });
    expect(sides.strokeWeight).toBeUndefined();
  });
});

describe("tokens and components with the keys an import needs", () => {
  it("variablesUsed carry id, key, remote, collection and code syntax; modes pinned on a node are named [C-105]", async () => {
    g.figma.variables = {
      async getVariableByIdAsync(id: string) {
        return id === "V:2"
          ? { name: "color/bg", resolvedType: "COLOR", key: "k-bg", remote: true, variableCollectionId: "C:1", codeSyntax: { WEB: "var(--bg)" }, resolveForConsumer: () => ({ value: { r: 1, g: 1, b: 1, a: 1 } }) }
          : null;
      },
      async getVariableCollectionByIdAsync(id: string) {
        return id === "C:1" ? { name: "Theme", modes: [{ modeId: "1:0", name: "Light" }, { modeId: "1:1", name: "Dark" }] } : null;
      },
    };
    const r = await buildContext([node("FRAME", "Screen", {
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { id: "V:2" } } }],
      explicitVariableModes: { "C:1": "1:1", "C:9": "9:0" },
    }) as never], OPTS, ctx);
    expect(r.variablesUsed).toEqual([{ id: "V:2", name: "color/bg", type: "COLOR", key: "k-bg", remote: true, collection: "Theme", codeSyntax: { WEB: "var(--bg)" }, value: "#ffffff" }]);
    expect(r.roots[0]!.variableModes).toEqual({ Theme: "Dark", "C:9": "9:0" });
  });

  it("an instance's component carries its key and its set's id and key; componentsUsed lists it once", async () => {
    const set = { id: "1:1", type: "COMPONENT_SET", name: "Button", key: "set-key" };
    const main = { id: "1:2", name: "Size=Large", key: "comp-key", remote: true, parent: set };
    const inst = () => node("INSTANCE", "Button", { getMainComponentAsync: async () => main, componentProperties: {} });
    const r = await buildContext([inst() as never, inst() as never], OPTS, ctx);
    expect(r.roots[0]!.component).toEqual({ id: "1:2", name: "Size=Large", key: "comp-key", remote: true, set: "Button", setId: "1:1", setKey: "set-key" });
    expect(r.componentsUsed).toEqual([{ id: "1:2", name: "Size=Large", key: "comp-key", remote: true, setId: "1:1", setKey: "set-key", setName: "Button" }]);
  });

  it("stylesUsed carry the style key", async () => {
    g.figma.getStyleByIdAsync = async () => ({ name: "Brand/Primary", type: "PAINT", key: "style-key", remote: true });
    const r = await buildContext([node("FRAME", "F", { fillStyleId: "S:7," }) as never], OPTS, ctx);
    expect(r.stylesUsed).toEqual([{ id: "S:7,", name: "Brand/Primary", type: "PAINT", key: "style-key", remote: true }]);
  });
});

describe("annotations, motion and CSS never cost the read", () => {
  it("annotations come with their category name", async () => {
    g.figma.annotations = { getAnnotationCategoryByIdAsync: async (id: string) => (id === "cat-1" ? { id, label: "Interaction", color: "blue" } : null) };
    const f = await one(node("FRAME", "Btn", { annotations: [{ label: "Opens the menu", categoryId: "cat-1", properties: [{ type: "width" }] }, { labelMarkdown: "**Note**" }] }));
    expect(f.annotations).toEqual([{ label: "Opens the menu", category: "Interaction", properties: ["width"] }, { label: "**Note**" }]);
    expect((await one(node("FRAME", "Btn", { annotations: [{ label: "x" }] }), { includeAnnotations: false })).annotations).toBeUndefined();
  });

  it("animated nodes are marked; without the motion flag the read still succeeds and stops asking [C-115]", async () => {
    const track = { keyframes: [] };
    const animated = await one(node("FRAME", "Spin", { manualKeyframeTracks: { ROTATION: track, fills: { 0: track } }, animationStyles: [{ name: "Fade in", styleId: "s" }] }));
    expect(animated.motion).toEqual(["ROTATION", "fill:0", "style:Fade in"]);

    let reads = 0;
    const gated = () => {
      const n = node("FRAME", "Gated", {});
      Object.defineProperty(n, "manualKeyframeTracks", {
        get: () => {
          reads++;
          throw new Error('"manualKeyframeTracks" is not a supported API');
        },
      });
      return n;
    };
    const r = await buildContext([gated() as never, gated() as never], OPTS, ctx);
    expect(r.roots.map((n) => n.name)).toEqual(["Gated", "Gated"]);
    expect(r.roots[0]!.motion).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("includeCss reads the inspect panel's CSS, and after one failure stops and says why [C-091]", async () => {
    let calls = 0;
    const ok = node("FRAME", "A", { getCSSAsync: async () => (calls++, { display: "flex", gap: "8px" }) });
    const bad = node("FRAME", "B", {
      getCSSAsync: async () => {
        calls++;
        throw new Error("not in this mode");
      },
    });
    const after = node("FRAME", "C", { getCSSAsync: async () => (calls++, { width: "1px" }) });
    const r = await buildContext([ok as never, bad as never, after as never], { ...OPTS, includeCss: true }, ctx);
    expect(r.roots[0]!.css).toEqual({ display: "flex", gap: "8px" });
    expect(r.roots[2]!.css).toBeUndefined();
    expect(calls).toBe(2);
    expect(r.cssNote).toMatch(/not in this mode/);
    expect(typeof r.cssMs).toBe("number");
    const off = await buildContext([node("FRAME", "D", { getCSSAsync: async () => ({ a: "b" }) }) as never], OPTS, ctx);
    expect(off.roots[0]!.css).toBeUndefined();
    expect(off.cssMs).toBeUndefined();
  });
});

describe("the op: scope, selection and pages", () => {
  const page = (sel: unknown[]) => ({ id: "0:1", type: "PAGE", name: "Page 1", selection: sel, children: [] as unknown[] });

  it("several selected layers are read as several roots, not as the page", async () => {
    g.figma.currentPage = page([node("FRAME", "Card A"), node("FRAME", "Card B")]);
    const r = await runOp({});
    expect(r.scope).toBe("selection");
    expect((r.roots as ContextNode[]).map((n) => n.name)).toEqual(["Card A", "Card B"]);
    expect(r.root).toBeUndefined();
  });

  it("one selected layer is `root` with scope selection; nothing selected is the page", async () => {
    g.figma.currentPage = page([node("FRAME", "Only")]);
    expect(await runOp({})).toMatchObject({ scope: "selection", root: { name: "Only" } });
    g.figma.currentPage = page([]);
    expect(await runOp({})).toMatchObject({ scope: "page", root: { name: "Page 1" } });
  });

  it("an unopened page is loaded before its children are read [C-090]", async () => {
    g.figma.currentPage = page([]);
    let loaded = false;
    const kid = node("FRAME", "On page 2");
    const other = {
      id: "0:2", type: "PAGE", name: "Page 2",
      get children() {
        if (!loaded) throw new Error("Cannot access children on a page that has not been explicitly loaded");
        return [kid];
      },
      loadAsync: async () => void (loaded = true),
    };
    g.figma.getNodeByIdAsync = async (id: string) => (id === "0:2" ? other : null);
    const r = await runOp({ nodeId: "0:2" });
    expect(r.scope).toBe("node");
    expect((r.root as ContextNode).children![0]!.name).toBe("On page 2");
  });

  it("text cut at maxTextChars names figma_scan_text_nodes", async () => {
    const t = node("TEXT", "Long", { characters: "x".repeat(50) });
    g.figma.getNodeByIdAsync = async () => t;
    const r = await runOp({ nodeId: t.id, maxTextChars: 10 });
    expect(r.textNote).toMatch(/figma_scan_text_nodes/);
  });
});
