// Choosing fonts that fit, editing text like the text panel, and placing real
// icons and images — against a fake whose text node keeps styled runs, the way
// Figma's does (getStyledTextSegments / setRangeFontName).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { PLUGIN_OPS } from "../src/plugin/ops/index.js";
import { loadFont, nearestStyle, resetFontCache, styleWeight } from "../src/plugin/write.js";

type Font = { family: string; style: string };
let seq = 0;

class Text {
  id = `3:${++seq}`;
  type = "TEXT";
  name = "Text";
  parent: unknown = null;
  children = undefined;
  runs: Array<{ start: number; end: number; fontName: Font }>;
  calls: string[] = [];
  fontSize: number;
  textAlignHorizontal = "LEFT";
  textAutoResize = "WIDTH_AND_HEIGHT";
  constructor(public characters: string, runs: Array<[number, number, string, string]>, size = 16) {
    this.runs = runs.map(([start, end, family, style]) => ({ start, end, fontName: { family, style } }));
    this.fontSize = size;
  }
  get fontName(): Font | symbol {
    const set = new Set(this.runs.map((r) => `${r.fontName.family}|${r.fontName.style}`));
    return set.size === 1 ? this.runs[0]!.fontName : Symbol("mixed");
  }
  getRangeAllFontNames(s: number, e: number) {
    return this.runs.filter((r) => r.end > s && r.start < e).map((r) => r.fontName);
  }
  getStyledTextSegments(_f: string[], s = 0, e = this.characters.length) {
    return this.runs.filter((r) => r.end > s && r.start < e).map((r) => ({ start: Math.max(r.start, s), end: Math.min(r.end, e), fontName: r.fontName }));
  }
  setRangeFontName(s: number, e: number, f: Font) {
    const out: typeof this.runs = [];
    for (const r of this.runs) {
      if (r.end <= s || r.start >= e) out.push(r);
      else {
        if (r.start < s) out.push({ ...r, end: s });
        if (r.end > e) out.push({ ...r, start: e });
      }
    }
    out.push({ start: s, end: e, fontName: f });
    this.runs = out.sort((a, b) => a.start - b.start);
  }
  setRangeFontSize(s: number, e: number, v: number) {
    this.calls.push(`size ${s}-${e} ${v}`);
    if (s === 0 && e === this.characters.length) this.fontSize = v;
  }
  setRangeFills(s: number, e: number) { this.calls.push(`fills ${s}-${e}`); }
  setRangeTextDecoration(s: number, e: number, v: string) { this.calls.push(`deco ${s}-${e} ${v}`); }
  setRangeTextCase(s: number, e: number, v: string) { this.calls.push(`case ${s}-${e} ${v}`); }
  setRangeLineHeight(s: number, e: number, v: unknown) { this.calls.push(`lh ${s}-${e} ${JSON.stringify(v)}`); }
  setRangeLetterSpacing(s: number, e: number, v: unknown) { this.calls.push(`ls ${s}-${e} ${JSON.stringify(v)}`); }
  setRangeHyperlink(s: number, e: number, v: unknown) { this.calls.push(`link ${s}-${e} ${JSON.stringify(v)}`); }
}

const AVAILABLE: Record<string, string[]> = {
  Inter: ["Regular", "Medium", "Semi Bold", "Bold"],
  Poppins: ["Regular", "Medium", "SemiBold", "Bold", "Italic"],
  "Playfair Display": ["Regular", "Bold"],
  "Source Sans 3": ["Regular", "Semibold", "Bold"],
  "Bebas Neue": ["Regular"],
  "Mystery Grotesk": ["Regular", "Bold"],
};

let nodes: Map<string, unknown>;
let page: { id: string; type: string; name: string; children: unknown[] };
const loaded: string[] = [];

beforeEach(() => {
  resetFontCache();
  loaded.length = 0;
  nodes = new Map();
  page = { id: "0:1", type: "PAGE", name: "Page", children: [] };
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    selection: [],
    async listAvailableFontsAsync() {
      return Object.entries(AVAILABLE).flatMap(([family, styles]) => styles.map((style) => ({ fontName: { family, style } })));
    },
    async loadFontAsync(f: Font) {
      if (!AVAILABLE[f.family]?.includes(f.style)) throw new Error(`font ${f.family} ${f.style} not found`);
      loaded.push(`${f.family} ${f.style}`);
    },
    async getNodeByIdAsync(id: string) {
      return nodes.get(id) ?? (id === page.id ? page : null);
    },
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false });
const run = (op: string, params: Record<string, unknown>) => PLUGIN_OPS[op]!.run(ctx(params)) as Promise<Record<string, any>>;
const add = <T extends { id: string }>(n: T) => (nodes.set(n.id, n), n);

describe("font styles across families", () => {
  it("reads weights from any family's spelling", () => {
    expect(styleWeight("SemiBold")).toEqual({ weight: 600, italic: false });
    expect(styleWeight("Semi Bold Italic")).toEqual({ weight: 600, italic: true });
    expect(styleWeight("Black")).toEqual({ weight: 900, italic: false });
    expect(nearestStyle(["Regular", "SemiBold", "Bold", "Italic"], "Semi Bold")).toBe("SemiBold");
    expect(nearestStyle(["Regular", "Bold"], "Medium")).toBe("Regular");
  });

  it("asking Poppins for 'Semi Bold' gets Poppins SemiBold — not Inter", async () => {
    const f = await loadFont((globalThis as unknown as { figma: never }).figma, "Poppins", "Semi Bold");
    expect(f).toEqual({ family: "Poppins", style: "SemiBold", fellBack: false });
  });

  it("a missing weight inside the family is the nearest weight, reported as a fallback", async () => {
    const f = await loadFont((globalThis as unknown as { figma: never }).figma, "Playfair Display", "Semi Bold");
    expect(f).toEqual({ family: "Playfair Display", style: "Bold", fellBack: true });
  });
});

describe("figma_suggest_fonts", () => {
  it("keeps what the design uses, and splits its text into heading and body", async () => {
    const h = add(new Text("Title", [[0, 5, "Inter", "Bold"]], 32));
    const b = add(new Text("Body copy", [[0, 9, "Inter", "Regular"]], 16));
    const b2 = add(new Text("More", [[0, 4, "Inter", "Regular"]], 16));
    page.children = [h, b, b2];
    const r = await run("suggest_fonts", {});
    expect(r.inUse[0]).toMatchObject({ family: "Inter", textNodes: 3, available: true });
    expect(r.consistency).toMatch(/already uses Inter/);
    expect(r.applyPlan.headingNodeIds).toEqual([h.id]);
    expect(r.applyPlan.bodyNodeIds.sort()).toEqual([b.id, b2.id].sort());
  });

  it("fits the one layer selected on the page, not the whole page [C-097]", async () => {
    // PluginAPI has no `selection`; the fake keeps `figma.selection` empty, as the editor does.
    const h = add(new Text("Title", [[0, 5, "Inter", "Bold"]], 32));
    const c = add(new Text("Caption", [[0, 7, "Inter", "Regular"]], 16));
    const c2 = add(new Text("Price", [[0, 5, "Inter", "Regular"]], 16));
    const card = add({ id: "5:1", type: "FRAME", name: "Card", children: [h, c, c2] });
    const b = add(new Text("Body copy", [[0, 9, "Inter", "Regular"]], 16));
    page.children = [card, b];
    (page as unknown as { selection: unknown[] }).selection = [card];
    const r = await run("suggest_fonts", {});
    expect(r.inUse[0]).toMatchObject({ family: "Inter", textNodes: 3 });
    expect(r.applyPlan.headingNodeIds).toEqual([h.id]);
    expect(r.applyPlan.bodyNodeIds.sort()).toEqual([c.id, c2.id].sort());
  });

  it("an editorial mood puts a serif display face over a readable body", async () => {
    const r = await run("suggest_fonts", { mood: "editorial elegant", use: "marketing" });
    expect(r.suggestions[0].heading.family).toBe("Playfair Display");
    expect(r.suggestions[0].heading.style).toBe("Bold");
    expect(r.suggestions[0].body.family).not.toBe("Playfair Display");
  });

  it("only suggests fonts that exist here, with their own style names", async () => {
    const r = await run("suggest_fonts", { mood: "modern geometric startup", limit: 10 });
    const families = r.suggestions.flatMap((s: any) => [s.heading.family, s.body.family]);
    for (const f of families) expect(Object.keys(AVAILABLE)).toContain(f);
    const poppins = r.suggestions.find((s: any) => s.heading.family === "Poppins");
    if (poppins) expect(poppins.heading.styles).toContain("SemiBold");
    expect(families).not.toContain("Mystery Grotesk"); // unknown face, no evidence it fits the mood
  });

  it("ui with no mood favours one neutral family", async () => {
    const r = await run("suggest_fonts", { use: "ui" });
    expect(r.suggestions[0].heading.family).toBe(r.suggestions[0].body.family);
    expect(r.typeScale[1]).toMatchObject({ role: "body", size: 14 });
  });
});

describe("figma_set_text_properties", () => {
  it("a new family keeps each run's weight — the bold word stays bold", async () => {
    const t = add(new Text("Hello world", [[0, 6, "Inter", "Regular"], [6, 11, "Inter", "Bold"]]));
    const r = await run("set_text_properties", { nodeIds: [t.id], fontFamily: "poppins", fontSize: 18, lineHeight: "150%" });
    expect(r.updated).toBe(1);
    expect(t.runs.map((x) => `${x.fontName.family} ${x.fontName.style}`)).toEqual(["Poppins Regular", "Poppins Bold"]);
    expect(t.calls).toContain('lh 0-11 {"unit":"PERCENT","value":150}');
    expect(t.fontSize).toBe(18);
  });

  it("a new weight applies to all of it, matched to the family's spelling", async () => {
    const t = add(new Text("Pro", [[0, 3, "Poppins", "Regular"]]));
    await run("set_text_properties", { nodeIds: [t.id], weight: "600", align: "center", autoResize: "wrap" });
    expect(t.runs[0]!.fontName).toEqual({ family: "Poppins", style: "SemiBold" });
    expect([t.textAlignHorizontal, t.textAutoResize]).toEqual(["CENTER", "HEIGHT"]);
  });

  it("an unavailable family is refused before any node changes", async () => {
    const t = add(new Text("x", [[0, 1, "Inter", "Regular"]]));
    let err: unknown;
    try {
      await run("set_text_properties", { nodeIds: [t.id], fontFamily: "Comic Papyrus" });
    } catch (e) {
      err = e;
    }
    expect((err as BridgeError).code).toBe("FONT_LOAD_FAILED");
    expect((err as BridgeError).hint).toMatch(/figma_suggest_fonts/);
    expect(t.runs[0]!.fontName.family).toBe("Inter");
  });
});

describe("figma_set_text_range", () => {
  it("styles every occurrence of a match, or just the nth", async () => {
    const t = add(new Text("Pro plan. Go Pro!", [[0, 17, "Inter", "Regular"]]));
    const all = await run("set_text_range", { nodeId: t.id, match: "Pro", weight: "Bold", color: "#2563eb" });
    expect(all.ranges.map((r: any) => r.start)).toEqual([0, 13]);
    expect(t.runs.filter((r) => r.fontName.style === "Bold").map((r) => [r.start, r.end])).toEqual([[0, 3], [13, 16]]);
    await run("set_text_range", { nodeId: t.id, match: "Pro", occurrence: 2, link: "https://example.com" });
    expect(t.calls).toContain('link 13-16 {"type":"URL","value":"https://example.com"}');
  });

  it("says what the text is when the match is not there", async () => {
    const t = add(new Text("Starter", [[0, 7, "Inter", "Regular"]]));
    await expect(run("set_text_range", { nodeId: t.id, match: "Pro", weight: "Bold" })).rejects.toMatchObject({ hint: /Starter/ });
  });
});

describe("figma_import_svg / figma_import_image", () => {
  const frameWith = () => ({ id: `4:${++seq}`, type: "FRAME", name: "Host", children: [] as unknown[], fills: [], appendChild(c: { parent?: unknown }) { this.children.push(c); c.parent = this; } });

  it("an SVG becomes vectors, scaled with its drawing and recoloured", async () => {
    const host = add(frameWith());
    const vector = { type: "VECTOR", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokes: [] };
    let scaled = 0;
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.createNodeFromSvg = () =>
      ({ id: "4:900", type: "FRAME", name: "svg", width: 24, height: 24, fills: [], children: [vector], rescale(s: number) { scaled = s; this.width *= s; this.height *= s; } });
    const r = await run("import_svg", { svg: "<svg viewBox='0 0 24 24'><path d='M0 0h24v24z'/></svg>", parentId: host.id, width: 48, color: "#2563eb", name: "Icon / Box" });
    expect(scaled).toBe(2);
    expect(r).toMatchObject({ name: "Icon / Box", width: 48, height: 48, recoloured: 1 });
    expect(vector.fills).toEqual([{ type: "SOLID", color: { r: 0x25 / 255, g: 0x63 / 255, b: 0xeb / 255 } }]);
  });

  it("text that is not SVG is refused before anything exists", async () => {
    await expect(run("import_svg", { svg: "<div/>" })).rejects.toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
  });

  describe("colorVariable — an icon that follows a token", () => {
    const icon = "<svg viewBox='0 0 24 24'><path d='M0 0h24v24z'/><path d='M2 2h20' stroke='#000'/></svg>";
    let created: number;
    let filled: Record<string, unknown>;
    let stroked: Record<string, unknown>;
    const variablesApi = {
      async getVariableByIdAsync(id: string) {
        return id === "VariableID:9:1" ? { id, name: "color/icon/default", resolvedType: "COLOR" } : null;
      },
      async getLocalVariablesAsync() {
        return [
          { id: "VariableID:9:1", name: "color/icon/default", resolvedType: "COLOR" },
          { id: "VariableID:9:2", name: "space/4", resolvedType: "FLOAT" },
        ];
      },
      setBoundVariableForPaint(paint: Record<string, unknown>, field: string, v: { id: string }) {
        return { ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: v.id } } };
      },
    };
    beforeEach(() => {
      created = 0;
      const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
      f.variables = variablesApi;
      f.createNodeFromSvg = (svg: string) => {
        created++;
        filled = { id: "6:2", type: "VECTOR", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokes: [] };
        stroked = { id: "6:3", type: "VECTOR", fills: [], strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] };
        // A GROUP when the <svg> has no width, height or viewBox, else a FRAME [C-086].
        const type = /viewBox|width|height/.test(svg) ? "FRAME" : "GROUP";
        return { id: "6:1", type, name: "svg", width: 24, height: 24, children: [filled, stroked], ...(type === "FRAME" ? { fills: [] } : {}) };
      };
    });

    it("binds fill vectors and stroke-only vectors alike; the stroke-only one keeps fills []; vectorIds come back", async () => {
      const r = await run("import_svg", { svg: icon, colorVariable: "color/icon/default", parentId: add(frameWith()).id });
      const bound = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:9:1" } } };
      expect(filled.fills).toEqual([bound]);
      expect(filled.strokes).toEqual([]);
      expect(stroked.strokes).toEqual([bound]);
      expect(stroked.fills).toEqual([]);
      expect(r).toMatchObject({ recoloured: 2, vectorIds: ["6:2", "6:3"] });
    });

    it("works through a GROUP wrapper too, and by variable id", async () => {
      const r = await run("import_svg", { svg: "<svg><path d='M0 0h24v24z'/></svg>", colorVariable: "VariableID:9:1", parentId: add(frameWith()).id });
      expect(r).toMatchObject({ type: "GROUP", vectorIds: ["6:2", "6:3"] });
    });

    it("vectorIds come back without any recolour, so a later binding knows where to go", async () => {
      const r = await run("import_svg", { svg: icon, parentId: add(frameWith()).id });
      expect(r.vectorIds).toEqual(["6:2", "6:3"]);
      expect(r).not.toHaveProperty("recoloured");
    });

    it("color + colorVariable, an unknown variable, or a non-COLOR one is refused before createNodeFromSvg runs", async () => {
      await expect(run("import_svg", { svg: icon, color: "#000", colorVariable: "color/icon/default" })).rejects.toMatchObject({
        code: "INVALID_PARAM", partial: { created: [] }, message: expect.stringMatching(/not both/),
      });
      await expect(run("import_svg", { svg: icon, colorVariable: "color/nope" })).rejects.toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
      await expect(run("import_svg", { svg: icon, colorVariable: "space/4" })).rejects.toMatchObject({
        partial: { created: [] }, message: expect.stringMatching(/needs a COLOR variable/),
      });
      expect(created).toBe(0);
    });
  });

  it("an image fills an existing node, or a new rectangle at its own proportions", async () => {
    const host = add(frameWith());
    const target = add({ id: "4:77", type: "RECTANGLE", name: "Photo", fills: [] as unknown[] });
    const made: Array<Record<string, unknown>> = [];
    const f = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    f.createImageAsync = async (url: string) => ({ hash: `h:${url.length}`, getSizeAsync: async () => ({ width: 800, height: 400 }) });
    f.createImage = (bytes: Uint8Array) => ({ hash: `b:${bytes.length}`, getSizeAsync: async () => ({ width: 10, height: 10 }) });
    f.createRectangle = () => {
      const r: Record<string, unknown> = { id: `4:${++seq}`, type: "RECTANGLE", name: "Rectangle", resize(w: number, h: number) { r.width = w; r.height = h; } };
      made.push(r);
      return r;
    };
    await run("import_image", { url: "https://example.com/a.png", nodeId: target.id, scaleMode: "crop" });
    expect(target.fills).toEqual([{ type: "IMAGE", imageHash: "h:25", scaleMode: "CROP" }]);
    const r = await run("import_image", { url: "https://example.com/hero.jpg", parentId: host.id, width: 400 });
    expect([r.width, r.height]).toEqual([400, 200]);
    const b = await run("import_image", { base64: Buffer.from([1, 2, 3, 4, 5]).toString("base64"), parentId: host.id });
    expect(b.imageHash).toBe("b:5");
    await expect(run("import_image", { url: "file:///etc/passwd" })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    expect(made).toHaveLength(2);
  });
});
