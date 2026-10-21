// The existing write tools across editors: where a new layer goes (a SLIDE as a
// parent, the focused slide by default), FigJam's own text defaults, sections
// as board structure, and text that lives in a board node's sublayer — a
// sticky's, a shape's, a connector's, a table cell's — or a code block's code
// [C-135]. Each behaviour is pinned on the fakes in editor-fakes.ts and
// write-fakes.ts, shaped after @figma/plugin-typings 1.141.0.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { parseSpecParam } from "../src/server/tools/create.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";
import { STYLE_OPS } from "../src/plugin/ops/style.js";
import { TYPOGRAPHY_OPS, wholeLines } from "../src/plugin/ops/typography.js";
import { parentFor, type FigmaWrite } from "../src/plugin/write.js";
import { FakeNode, FakeSection, installFigma, noSuchProperty, opContext, solid } from "./editor-fakes.js";
import { quietLogger, startMock, type MockPlugin } from "./helpers.js";
import { WRect, WText, WriteFigma, withRanges } from "./write-fakes.js";

let fake: WriteFigma;
let restore: (() => void) | undefined;

function world(editorType = "figma"): WriteFigma {
  fake = new WriteFigma({ editorType });
  restore = installFigma(fake);
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
});

const figma = () => (globalThis as unknown as { figma: FigmaWrite }).figma;
type Any = Record<string, unknown>;
const run = (group: Record<string, { run(ctx: ReturnType<typeof opContext>): Promise<unknown> }>, op: string, params: Any) =>
  group[op]!.run(opContext(params)) as Promise<Any>;
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}
const items = (r: Any) => r.items as Array<Any & { id: string; ok: boolean; error?: string }>;

// ── where a new layer goes ──────────────────────────────────────────────────

describe("parentFor across editors", () => {
  it("takes a SLIDE as a parent [C-136], and refuses its row and the grid before anything exists [C-134]", async () => {
    world("slides");
    const slide = fake.slide();
    expect((await parentFor(figma(), slide.id)).id).toBe(slide.id);
    for (const holder of [slide.parent!, fake.grid!]) {
      const e = await refusal(parentFor(figma(), holder.id));
      expect(e.code).toBe("INVALID_PARAM");
      expect(e.message).toMatch(new RegExp(`A ${holder.type} holds .*use a SLIDE id from figma_get_slide_grid`));
    }
  });

  it("with no parentId, a Slides call goes to the focused slide (d.ts:3351-3356, 10737)", async () => {
    world("slides");
    fake.slide();
    const focused = fake.slide(true);
    expect((await parentFor(figma())).id).toBe(focused.id);
  });

  it("with no parentId and no focused slide it is refused, listing up to five slide ids", async () => {
    world("slides");
    const slides = Array.from({ length: 7 }, () => fake.slide());
    const e = await refusal(parentFor(figma()));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/no slide is focused: pass parentId = a slide id/);
    expect(e.message).toContain(slides.slice(0, 5).map((s) => s.id).join(", "));
    expect(e.message).not.toContain(slides[5]!.id);
    expect(e.hint).toMatch(/figma_get_slide_grid/);
    // An empty deck says how to make a slide instead.
    restore?.();
    world("slides");
    expect((await refusal(parentFor(figma()))).hint).toMatch(/figma_create_slides/);
  });

  it("a create with no parentId and no focused slide changes nothing", async () => {
    world("slides");
    fake.slide();
    const before = fake.nodes.size;
    const e = await refusal(run(CREATE_OPS, "create_rectangle", { width: 10, height: 10 }));
    expect(e.partial).toEqual({ created: [] });
    expect(fake.nodes.size).toBe(before);
  });

  it("Design and FigJam keep the current page as the default parent", async () => {
    for (const editor of ["figma", "figjam"]) {
      world(editor);
      expect((await parentFor(figma())).id).toBe(fake.currentPage.id);
      restore?.();
    }
  });
});

// ── FigJam's text defaults ──────────────────────────────────────────────────

describe("figma_create_text defaults per editor [C-156]", () => {
  it("FigJam: Inter Medium first, in Charcoal #1E1E1E; what the call names still wins", async () => {
    world("figjam");
    const r = await run(CREATE_OPS, "create_text", { content: "Note" });
    const t = fake.nodes.get(r.id as string) as unknown as WText;
    expect(fake.fontLoads[0]).toEqual({ family: "Inter", style: "Medium" });
    expect(t.fontName).toEqual({ family: "Inter", style: "Medium" });
    expect(t.fills).toEqual([solid("#1E1E1E")]);
    const named = await run(CREATE_OPS, "create_text", { content: "Loud", color: "#FF0000", weight: 700 });
    const n = fake.nodes.get(named.id as string) as unknown as WText;
    expect(n.fontName).toEqual({ family: "Inter", style: "Bold" });
    expect(n.fills).toEqual([solid("#FF0000")]);
  });

  it("Design is unchanged: Inter Regular on black", async () => {
    world("figma");
    const r = await run(CREATE_OPS, "create_text", { content: "Note" });
    const t = fake.nodes.get(r.id as string) as unknown as WText;
    expect(fake.fontLoads[0]).toEqual({ family: "Inter", style: "Regular" });
    expect(t.fills).toEqual([solid("#000000")]);
  });
});

// ── pages and sections ──────────────────────────────────────────────────────

describe("figma_create_page in an editor without pages", () => {
  it("a createPage that throws when touched [C-145] [C-142] is UNSUPPORTED with nothing created, not INTERNAL", async () => {
    world("figjam");
    fake.throwing.add("createPage");
    const e = await refusal(run(CREATE_OPS, "create_page", { name: "Two" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.partial).toEqual({ created: [] });
  });
});

describe("figma_create_section as board structure", () => {
  function sectionsThatRefuseResize(): FakeSection[] {
    const made: FakeSection[] = [];
    const make = fake.createSection.bind(fake);
    fake.createSection = () => {
      const s = make();
      s.resizeThrows = true; // resize() is contradicted for sections [C-141]
      made.push(s);
      return s;
    };
    return made;
  }

  it("nests in a section, takes a hex fill, hides its contents, keeps an empty name — and never calls resize()", async () => {
    world("figjam");
    sectionsThatRefuseResize();
    const wrapper = await run(CREATE_OPS, "create_section", { name: "Board", width: 2000, height: 1200 });
    const zone = await run(CREATE_OPS, "create_section", { parentId: wrapper.id, name: "", fill: "#F5FBFF", contentsHidden: true, x: 64, y: 96, width: 600, height: 400 });
    const s = fake.nodes.get(zone.id as string) as FakeSection;
    expect(s.parent?.id).toBe(wrapper.id);
    expect(zone.parentId).toBe(wrapper.id);
    expect(s.name).toBe("");
    expect(s.fills).toEqual([solid("#F5FBFF")]);
    expect(s.sectionContentsHidden).toBe(true);
    expect([s.x, s.y, s.width, s.height]).toEqual([64, 96, 600, 400]);
    expect(s.resizes.map((r) => r.via)).toEqual(["resizeWithoutConstraints"]);
  });

  it("a parent that cannot hold a section is refused before the section exists", async () => {
    world("figjam");
    const frame = fake.frame();
    const before = fake.nodes.size;
    const e = await refusal(run(CREATE_OPS, "create_section", { parentId: frame.id }));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/A section sits on a page or inside another section, not in a FRAME/);
    expect(e.partial).toEqual({ created: [] });
    expect(fake.nodes.size).toBe(before);
  });

  it("an editor whose createSection throws when touched answers UNSUPPORTED with nothing created [C-145]", async () => {
    world("slides");
    fake.throwing.add("createSection");
    const e = await refusal(run(CREATE_OPS, "create_section", {}));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.partial).toEqual({ created: [] });
  });
});

// ── text in a board node ────────────────────────────────────────────────────

describe("figma_set_text on board nodes [C-135]", () => {
  it("writes a sticky's and a shape's sublayer after loading its font", async () => {
    world("figjam");
    fake.strictFonts = true; // writing characters with an unloaded font throws, as in Figma
    for (const node of [fake.createSticky(), fake.createShapeWithText()]) {
      const r = await run(MODIFY_OPS, "set_text", { nodeId: node.id, content: "Ship it" });
      expect(r).toMatchObject({ id: node.id, type: node.type, characters: 7 });
      expect(node.text.characters).toBe("Ship it");
      expect(r.font).toBeUndefined();
    }
  });

  it("a connector's unusable label font is set to Inter Medium first, and the result says so [C-148]", async () => {
    world("figjam");
    fake.strictFonts = true;
    const c = fake.createConnector();
    const r = await run(MODIFY_OPS, "set_text", { nodeId: c.id, content: "yes" });
    expect(c.text.writes).toEqual(["fontName", "characters"]);
    expect(c.text.fontName).toEqual({ family: "Inter", style: "Medium" });
    expect(r.font).toMatchObject({ family: "Inter", style: "Medium" });
  });

  it("a code block's code is written with no font", async () => {
    world("figjam");
    const code = fake.createCodeBlock();
    const r = await run(MODIFY_OPS, "set_text", { nodeId: code.id, content: "const a = 1;" });
    expect(code.code).toBe("const a = 1;");
    expect(r).toMatchObject({ type: "CODE_BLOCK", characters: 12 });
    expect(fake.fontLoads).toEqual([]);
  });

  it("a TABLE is refused with the tool that writes its cells; a frame holds no text; a font that will not load changes nothing", async () => {
    world("figjam");
    const table = fake.createTable();
    const t = await refusal(run(MODIFY_OPS, "set_text", { nodeId: table.id, content: "x" }));
    expect(t.code).toBe("INVALID_PARAM");
    expect(t.hint).toMatch(/figma_edit_table/);
    expect(t.partial).toEqual({ created: [] });
    const frame = await refusal(run(MODIFY_OPS, "set_text", { nodeId: fake.frame().id, content: "x" }));
    expect(frame.message).toMatch(/is a FRAME, which holds no text/);
    const sticky = fake.createSticky();
    fake.unloadable.add("Inter|Medium");
    const font = await refusal(run(MODIFY_OPS, "set_text", { nodeId: sticky.id, content: "x" }));
    expect(font.code).toBe("FONT_LOAD_FAILED");
    expect(font.partial).toEqual({ created: [] });
    expect(sticky.text.writes).toEqual([]);
  });
});

describe("figma_set_text_properties on board nodes", () => {
  it("restyles a sticky's text; align, autoResize or truncation are a per-item error before any write [C-135]", async () => {
    world("figjam");
    const sticky = fake.createSticky();
    sticky.text.characters = "Hello";
    const text = withRanges(sticky.text);
    const ok = await run(TYPOGRAPHY_OPS, "set_text_properties", { nodeIds: [sticky.id], fontSize: 24 });
    expect(items(ok)[0]).toMatchObject({ id: sticky.id, ok: true });
    expect(text.calls).toEqual([["setRangeFontSize", 0, 5, 24]]);
    text.calls.length = 0;
    for (const params of [{ align: "center" }, { autoResize: "wrap" }, { maxLines: 2 }]) {
      const r = await run(TYPOGRAPHY_OPS, "set_text_properties", { nodeIds: [sticky.id], fontSize: 30, ...params });
      expect(items(r)[0]).toMatchObject({ id: sticky.id, ok: false });
      expect(items(r)[0]!.error).toMatch(/set a TEXT node's own box; a STICKY's text has none/);
    }
    expect(text.calls).toEqual([]);
  });

  it("a TABLE restyles every cell and reports how many", async () => {
    world("figjam");
    const table = fake.createTable(2, 3);
    const cells = table.rows.flat();
    cells.forEach((c, i) => {
      c.text.characters = `c${i}`;
      withRanges(c.text);
    });
    const r = await run(TYPOGRAPHY_OPS, "set_text_properties", { nodeIds: [table.id], color: "#1E1E1E" });
    expect(items(r)[0]).toMatchObject({ id: table.id, ok: true, cells: 6 });
    for (const c of cells) expect((c.text as unknown as { calls: unknown[][] }).calls).toEqual([["setRangeFills", 0, 2, [solid("#1E1E1E")]]]);
  });
});

describe("figma_set_text_range indent [C-167]", () => {
  it("widens to the whole lines it touches, newline included, and runs on its own", async () => {
    world();
    const t = fake.createText();
    t.characters = "One\nTwo\nThree";
    const r = await run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: t.id, match: "Two", indent: 2 });
    expect(t.indents).toEqual([[4, 8, 2]]);
    expect(r.lines).toEqual([{ start: 4, end: 8 }]);
    expect(r.ranges).toEqual([{ start: 4, end: 7, text: "Two" }]);
  });

  it("with list, each list line gets its level; out of 0–5 is refused before anything is written", async () => {
    world();
    const t = fake.createText();
    t.characters = "A\nB";
    await run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: t.id, start: 2, end: 3, list: "unordered", indent: 2 });
    expect(t.lists).toEqual([[2, 3, "UNORDERED"]]);
    expect(t.indents).toEqual([[2, 3, 2]]);
    for (const indent of [6, -1, 1.5, "2"]) {
      const e = await refusal(run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: t.id, start: 0, end: 1, indent }));
      expect(e.message).toMatch(/`indent` must be a whole number from 0 to 5/);
      expect(e.partial).toEqual({ created: [] });
    }
    expect(t.indents).toHaveLength(1);
  });

  it("wholeLines: a range inside, across and at the end of lines", () => {
    const s = "a\nbb\nccc";
    expect(wholeLines(s, 3, 4)).toEqual([2, 5]);
    expect(wholeLines(s, 0, 1)).toEqual([0, 2]);
    expect(wholeLines(s, 1, 3)).toEqual([0, 5]);
    expect(wholeLines(s, 6, 8)).toEqual([5, 8]);
  });

  it("styles a sticky's text by range; a connector's unusable label font is reset first [C-148]", async () => {
    world("figjam");
    const sticky = fake.createSticky();
    sticky.text.characters = "Go now";
    const st = withRanges(sticky.text);
    const r = await run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: sticky.id, match: "now", fontSize: 30 });
    expect(r.type).toBe("STICKY");
    expect(st.calls).toEqual([["setRangeFontSize", 3, 6, 30]]);

    const c = fake.createConnector();
    c.text.characters = "label";
    c.text.fontState = "invalid";
    c.text.writes.length = 0;
    const ct = withRanges(c.text);
    await run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: c.id, start: 0, end: 5, fontSize: 12 });
    expect(c.text.writes[0]).toBe("fontName");
    expect(ct.calls).toEqual([["setRangeFontSize", 0, 5, 12]]);
  });

  it("a TABLE is refused: its cells have no id (d.ts:11442)", async () => {
    world("figjam");
    const e = await refusal(run(TYPOGRAPHY_OPS, "set_text_range", { nodeId: fake.createTable().id, start: 0, end: 1, fontSize: 9 }));
    expect(e.message).toMatch(/is a TABLE: its cells have no id/);
    expect(e.partial).toEqual({ created: [] });
  });
});

describe("figma_find_replace_text across board text", () => {
  it("replaces in TEXT, stickies, shapes, connector labels and table cells; each item names its owner and cell", async () => {
    world("figjam");
    const t = fake.createText();
    t.characters = "Q3 plan";
    const sticky = fake.createSticky();
    sticky.text.characters = "Q3 goals";
    const shape = fake.createShapeWithText();
    shape.text.characters = "Q3";
    const connector = fake.createConnector();
    connector.text.characters = "after Q3";
    const table = fake.createTable(1, 2);
    table.cellAt(0, 1).text.characters = "Q3 Q3";
    const r = await run(MODIFY_OPS, "find_replace_text", { find: "Q3", replace: "Q4" });
    expect([t.characters, sticky.text.characters, shape.text.characters, connector.text.characters, table.cellAt(0, 1).text.characters])
      .toEqual(["Q4 plan", "Q4 goals", "Q4", "after Q4", "Q4 Q4"]);
    expect(items(r)).toEqual(expect.arrayContaining([
      { id: t.id, ok: true, changed: 1 },
      { id: sticky.id, type: "STICKY", ok: true, changed: 1 },
      { id: table.id, type: "TABLE", cell: "0,1", ok: true, changed: 2 },
    ]));
    expect(r.replacedIn).toBe(5);
  });

  it("keeps the other styled runs: the match is replaced in place, taking the style of what it replaces", async () => {
    world();
    const t = fake.createText();
    t.characters = "Price: $10 a month";
    t.styleRange(7, 10, { family: "Inter", style: "Bold" });
    t.writes.length = 0;
    await run(MODIFY_OPS, "find_replace_text", { find: "10", replace: "250" });
    expect(t.characters).toBe("Price: $250 a month");
    expect(t.getStyledTextSegments([], 0, t.characters.length).map((s) => [s.characters, s.fontName.style])).toEqual([
      ["Price: ", "Regular"], ["$250", "Bold"], [" a month", "Regular"],
    ]);
    expect(t.writes).not.toContain("characters");
  });

  it("a regex keeps its replacement grammar and its anchors; an empty match does not loop", async () => {
    world("figjam");
    const sticky = fake.createSticky();
    sticky.text.characters = "a1 b22";
    await run(MODIFY_OPS, "find_replace_text", { find: "(\\d+)", replace: "#$1", regex: true });
    expect(sticky.text.characters).toBe("a#1 b#22");
    await run(MODIFY_OPS, "find_replace_text", { find: "^a", replace: "A", regex: true });
    expect(sticky.text.characters).toBe("A#1 b#22");
    sticky.text.writes.length = 0;
    const r = await run(MODIFY_OPS, "find_replace_text", { find: "x*", replace: "", regex: true });
    expect(sticky.text.characters).toBe("A#1 b#22");
    expect([items(r), sticky.text.writes]).toEqual([[], []]);
  });

  it("code blocks only with includeCode; an empty replace deletes each match", async () => {
    world("figjam");
    const code = fake.createCodeBlock();
    code.code = "let TODO = 1;";
    const sticky = fake.createSticky();
    sticky.text.characters = "TODO: ship";
    const first = await run(MODIFY_OPS, "find_replace_text", { find: "TODO", replace: "" });
    expect(code.code).toBe("let TODO = 1;");
    expect(sticky.text.characters).toBe(": ship");
    expect(items(first)).toHaveLength(1);
    await run(MODIFY_OPS, "find_replace_text", { find: "TODO", replace: "done", includeCode: true });
    expect(code.code).toBe("let done = 1;");
    const bad = await refusal(run(MODIFY_OPS, "find_replace_text", { find: "x", replace: "y", includeCode: "yes" }));
    expect(bad.partial).toEqual({ created: [] });
  });
});

// ── reparent and resize ─────────────────────────────────────────────────────

describe("figma_reparent_nodes: keepPosition, x/y after the append, connectors", () => {
  it("keepPosition keeps a sticky's place on the canvas when it moves into a section", async () => {
    world("figjam");
    const section = fake.createSection();
    Object.assign(section, { x: 500, y: 300 });
    const sticky = fake.createSticky();
    Object.assign(sticky, { x: 520, y: 340 });
    const at = () => (sticky as unknown as { absoluteTransform: number[][] }).absoluteTransform.map((r) => r[2]);
    expect(at()).toEqual([520, 340]);
    const r = await run(MODIFY_OPS, "reparent_nodes", { nodeIds: [sticky.id], parentId: section.id, keepPosition: true });
    expect(items(r)[0]).toMatchObject({ id: sticky.id, ok: true });
    expect(sticky.parent?.id).toBe(section.id);
    expect([sticky.x, sticky.y]).toEqual([20, 40]);
    expect(at()).toEqual([520, 340]);
  });

  it("x/y are written after the append, in the new parent's space (position-figjam-nodes.md:56-62)", async () => {
    world();
    const frame = fake.frame();
    const rect = fake.createRectangle();
    fake.log.length = 0;
    await run(MODIFY_OPS, "reparent_nodes", { nodeIds: [rect.id], parentId: frame.id, x: 10, y: 12 });
    expect(fake.log).toEqual([`append ${rect.id} > ${frame.id}`, `x ${rect.id}=10`, `y ${rect.id}=12`]);
    expect([rect.x, rect.y]).toEqual([10, 12]);
  });

  it("a moved connector carries a warning [C-149]; keepPosition with x/y, or into an auto-layout, is refused first", async () => {
    world("figjam");
    const section = fake.createSection();
    const connector = fake.createConnector();
    const r = await run(MODIFY_OPS, "reparent_nodes", { nodeIds: [connector.id], parentId: section.id });
    expect(items(r)[0]!.warning).toMatch(/may keep its old route/);
    const both = await refusal(run(MODIFY_OPS, "reparent_nodes", { nodeIds: [connector.id], parentId: section.id, keepPosition: true, x: 1 }));
    expect(both.partial).toEqual({ created: [] });
    const column = fake.frame();
    column.layoutMode = "VERTICAL";
    const auto = await refusal(run(MODIFY_OPS, "reparent_nodes", { nodeIds: [connector.id], parentId: column.id, keepPosition: true }));
    expect(auto.message).toMatch(/has auto-layout, which places its children/);
    expect(connector.parent?.id).toBe(section.id);
  });
});

describe("figma_resize_nodes on board nodes", () => {
  it("a sticky and a table are refused with the tool that sizes them; a section resizes without resize() [C-141]", async () => {
    world("figjam");
    const sticky = fake.createSticky();
    const table = fake.createTable();
    const section = fake.createSection();
    section.resizeThrows = true;
    const r = await run(MODIFY_OPS, "resize_nodes", { nodeIds: [sticky.id, table.id, section.id], width: 900, height: 500 });
    const [s, t, sec] = items(r);
    expect(s!.error).toMatch(/figma_set_board_properties \{ wide: true \}/);
    expect(t!.error).toMatch(/figma_edit_table/);
    expect(sec).toMatchObject({ ok: true });
    expect(section.resizes).toEqual([{ via: "resizeWithoutConstraints", w: 900, h: 500 }]);
  });

  it("a section that offers only resizeWithoutConstraints is still resizable", async () => {
    world("figjam");
    const section = fake.createSection();
    Object.defineProperty(section, "resize", { value: undefined });
    const r = await run(MODIFY_OPS, "resize_nodes", { nodeIds: [section.id], width: 300 });
    expect(items(r)[0]).toMatchObject({ ok: true });
    expect([section.width, section.height]).toEqual([300, 100]);
  });
});

// ── a member check that may throw ───────────────────────────────────────────

describe("style writes on a node whose member check throws [C-145]", () => {
  it("figma_set_fills reports that node per item instead of failing the call", async () => {
    world("slides");
    const plain = fake.createRectangle();
    const raw = new FakeNode("SLIDE_GRID", "Grid", fake);
    const touchy = new Proxy(raw, {
      has(target, prop) {
        if (prop === "fills") throw noSuchProperty("fills", "SLIDE_GRID node");
        return Reflect.has(target, prop);
      },
    });
    fake.nodes.set(raw.id, touchy);
    const r = await run(STYLE_OPS, "set_fills", { nodeIds: [raw.id, plain.id], fills: [{ color: "#FF0000" }] });
    expect(items(r)).toEqual([
      { id: raw.id, ok: false, error: "a SLIDE_GRID has no fills" },
      { id: plain.id, ok: true },
    ]);
    expect((plain as unknown as WRect).fills).toEqual([solid("#FF0000")]);
  });

  it("figma_move_nodes with positioning: a throwing check is that node's error, and the next node still moves", async () => {
    world("figjam");
    const column = fake.frame();
    column.layoutMode = "VERTICAL";
    const raw = new FakeNode("STICKY", "Sticky", fake);
    column.appendChild(raw);
    fake.nodes.set(raw.id, new Proxy(raw, {
      has(target, prop) {
        if (prop === "layoutPositioning") throw noSuchProperty("layoutPositioning", "STICKY node");
        return Reflect.has(target, prop);
      },
    }));
    const rect = Object.assign(fake.createRectangle(), { layoutPositioning: "AUTO" });
    column.appendChild(rect);
    const r = await run(MODIFY_OPS, "move_nodes", { nodeIds: [raw.id, rect.id], positioning: "absolute", x: 5 });
    expect(items(r)).toEqual([
      { id: raw.id, ok: false, error: "a STICKY cannot be positioned inside an auto-layout" },
      { id: rect.id, ok: true, positioning: "absolute" },
    ]);
    expect([rect.layoutPositioning, rect.x]).toEqual(["ABSOLUTE", 5]);
  });
});

// ── the server side: the new parameters pass the strict schemas ─────────────

describe("the server forwards the new parameters to the plugin", () => {
  let app: App;
  let client: Client;
  let mock: MockPlugin;
  const OPS = ["create_section", "create_from_spec", "set_text_range", "reparent_nodes", "find_replace_text"];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-editors-write-"));
    // Top-level sections and specs at page level are new work: the role gate is the role-process tests' to judge.
    const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "2000", BRIDGE_PROCESS: "off" });
    const token = readOrCreateToken(config.tokenPath);
    app = await createApp(config, token, quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "editors-write", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    mock = startMock({ token, port: app.bridge.port, ops: OPS });
    await mock.welcomed();
  });
  afterAll(async () => {
    mock.close();
    await client.close();
    await app.close();
  });

  const requests = () => mock.received.filter((m) => m.t === "request");
  const sent = (op: string) => requests().filter((m) => m.op === op).at(-1)?.params as Any | undefined;

  it("create_section parentId / fill / contentsHidden, set_text_range indent, reparent x / y / keepPosition, find_replace includeCode", async () => {
    const calls: Array<[string, Any, Any]> = [
      ["create_section", { parentId: "1-2", name: "", fill: "#F5FBFF", contentsHidden: true }, { parentId: "1:2", name: "", fill: "#F5FBFF", contentsHidden: true }],
      ["set_text_range", { nodeId: "1:3", match: "Two", indent: 2 }, { nodeId: "1:3", match: "Two", indent: 2 }],
      ["reparent_nodes", { nodeIds: ["1:4"], parentId: "1:2", x: 10, y: 20 }, { nodeIds: ["1:4"], parentId: "1:2", x: 10, y: 20 }],
      ["reparent_nodes", { nodeIds: ["1:4"], parentId: "1:2", keepPosition: true }, { keepPosition: true }],
      ["find_replace_text", { find: "a", replace: "", includeCode: true }, { find: "a", replace: "", includeCode: true }],
    ];
    for (const [op, args, arrives] of calls) {
      const before = requests().length;
      await client.callTool({ name: `figma_${op}`, arguments: args });
      // The mock implements none of these: what matters is that the call reached it, as sent.
      expect(requests().length, op).toBe(before + 1);
      expect(sent(op)).toMatchObject(arrives);
    }
  });

  it("indent outside 0–5 is refused by the schema before the plugin sees it", async () => {
    const before = requests().length;
    const r = await client.callTool({ name: "figma_set_text_range", arguments: { nodeId: "1:3", start: 0, end: 1, indent: 6 } });
    expect(r.isError).toBe(true);
    expect(requests().length).toBe(before);
  });

  it("an array spec reaches the plugin as an array; without parentId or pageId it is refused at the server", async () => {
    const ok = await client.callTool({
      name: "figma_create_from_spec",
      arguments: { spec: JSON.stringify([{ type: "text", content: "A" }, { type: "text", content: "B" }]), parentId: "5:1" },
    });
    expect(ok.structuredContent).toMatchObject({ specType: "array" });
    expect(sent("create_from_spec")).toMatchObject({ parentId: "5:1", spec: [{ type: "text", content: "A" }, { type: "text", content: "B" }] });
    const before = requests().length;
    const bare = await client.callTool({ name: "figma_create_from_spec", arguments: { spec: "[{\"type\":\"text\"}]" } });
    expect(bare.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(String((bare.structuredContent as { message: string }).message)).toMatch(/array of roots needs `parentId` or `pageId`/);
    const empty = await client.callTool({ name: "figma_create_from_spec", arguments: { spec: "[]", parentId: "5:1" } });
    expect(String((empty.structuredContent as { message: string }).message)).toMatch(/takes 1–50 roots \(got 0\)/);
    expect(requests().length).toBe(before);
  });

  it("parseSpecParam: an array of objects, 1–50 of them", () => {
    expect(parseSpecParam('[{"type":"frame"}]')).toEqual([{ type: "frame" }]);
    expect(() => parseSpecParam(JSON.stringify(Array.from({ length: 51 }, () => ({ type: "frame" }))))).toThrow(/takes 1–50 roots \(got 51\)/);
    expect(() => parseSpecParam('[{"type":"frame"}, 3]')).toThrow(/`spec\[1\]` must be a JSON object/);
  });
});
