// Reading a Figma Slides deck. The page's only child is the opaque SLIDE_GRID,
// its children the opaque SLIDE_ROWs, theirs the slides (slide-grid.md:7, 43).
// Reading fills, layout or effects on a grid or a row throws "no such
// property 'fills' on SLIDE_GRID node" (slide-gotchas.md:192) [C-136] — and
// every read used to touch those members on every node, so any read that
// reached the grid failed. A slide is frame-like and carries its place in the
// grid [C-134].

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_OPS } from "../src/plugin/ops/check.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import { FakeFigma, FakeNode, FakeSlide, FakeSlideGrid, FakeSlideRow, installFigma, makeOpaque, opContext } from "./editor-fakes.js";

type Any = Record<string, unknown>;
const run = async (op: string, params: Any = {}) => (await (READ_OPS[op] ?? CHECK_OPS[op])!.run(opContext(params))) as Any;
const reads = (n: unknown) => (n as { opaqueReads: string[] }).opaqueReads;

let fake: FakeFigma;
let restore: () => void;
let grid: FakeSlideGrid;
let s1: FakeSlide, s2: FakeSlide, s3: FakeSlide;
let row0: FakeSlideRow, row1: FakeSlideRow;

beforeEach(() => {
  fake = new FakeFigma({ editorType: "slides", fileName: "Pitch" });
  restore = installFigma(fake);
  grid = fake.grid!;
  s1 = fake.createSlide();
  s2 = fake.createSlide();
  row1 = fake.createSlideRow();
  s3 = fake.createSlide(1);
  row0 = grid.rows[0]!;
  s1.name = "Cover";
  s2.name = "Problem";
  s3.name = "Ask";
  const title = new FakeNode("TEXT", "Title", fake);
  Object.assign(title, { characters: "Raise $2M" });
  s3.appendChild(title);
});
afterEach(() => restore());

describe("opaque grid and rows", () => {
  it("get_design_context reads the grid, its rows and slides without touching a member they lack", async () => {
    const r = await run("get_design_context", { nodeId: grid.id });
    const root = r.root as Any;
    expect(root).toMatchObject({ id: grid.id, type: "SLIDE_GRID", opaque: true, childCount: 2 });
    expect(root.fills).toBeUndefined();
    const rows = root.children as Any[];
    expect(rows.map((x) => [x.type, x.opaque, x.childCount])).toEqual([["SLIDE_ROW", true, 2], ["SLIDE_ROW", true, 1]]);
    const ask = (rows[1]!.children as Any[])[0]!;
    expect(ask).toMatchObject({ id: s3.id, type: "SLIDE", fill: "#ffffff", slide: { row: 1, col: 0, index: 2, skipped: false } });
    expect((ask.children as Any[])[0]).toMatchObject({ type: "TEXT", text: { characters: "Raise $2M" } });
    expect(reads(grid)).toEqual([]);
    expect(reads(row0)).toEqual([]);
    expect(reads(row1)).toEqual([]);
  });

  it("get_node, get_nodes_info and get_selection return the opaque shape", async () => {
    const node = (await run("get_node", { nodeId: grid.id, depth: 1 })).node as Any;
    expect(node).toEqual({
      id: grid.id, name: "Grid", type: "SLIDE_GRID", childCount: 2, opaque: true, x: 0, y: 0, width: 100, height: 100,
      children: [
        { id: row0.id, name: "Row", type: "SLIDE_ROW", childCount: 2, opaque: true, x: 0, y: 0, width: 100, height: 100 },
        { id: row1.id, name: "Row", type: "SLIDE_ROW", childCount: 1, opaque: true, x: 0, y: 0, width: 100, height: 100 },
      ],
    });
    const info = await run("get_nodes_info", { nodeIds: [row0.id, s2.id] });
    expect((info.items as Any[]).map((i) => i.ok)).toEqual([true, true]);
    fake.currentPage.selection = [row1];
    expect(((await run("get_selection")).nodes as Any[])[0]).toMatchObject({ type: "SLIDE_ROW", opaque: true });
    expect([...reads(grid), ...reads(row0), ...reads(row1)]).toEqual([]);
  });

  it("get_annotations and get_reactions over the deck page survive a grid and rows that throw on those members", async () => {
    for (const n of [grid, row0, row1]) makeOpaque(n, ["annotations", "reactions", "getDevResourcesAsync"]);
    makeOpaque(fake.currentPage, ["flowStartingPoints", "prototypeStartNode", "prototypeBackgrounds"]);
    Object.assign(s3, { annotations: [{ label: "Check the number" }] });
    const ann = await run("get_annotations", { nodeId: fake.currentPage.id });
    expect((ann.nodes as Any[]).map((n) => n.nodeId)).toEqual([s3.id]);
    const page = await run("get_reactions", { scope: "page" });
    expect(page).toMatchObject({ count: 0, flows: [], prototypeStartNodeId: null, prototypeBackground: null });
    expect(await run("get_reactions", { nodeId: grid.id })).toMatchObject({ count: 0, reactions: [] });
  });

  it("check_layout walks through the grid to the slides and never reads it", async () => {
    const r = await run("check_layout", { nodeId: fake.currentPage.id });
    expect(r.checked).toBeGreaterThan(3);
    expect([...reads(grid), ...reads(row0), ...reads(row1)]).toEqual([]);
  });
});

describe("a slide", () => {
  it("carries its row, column, place in the deck, and whether it is skipped", async () => {
    s2.isSkippedSlide = true;
    expect((await run("get_node", { nodeId: s2.id })).node).toMatchObject({ slide: { row: 0, col: 1, index: 1, skipped: true } });
    const r = (await run("get_design_context", { nodeId: s3.id })).root as Any;
    expect(r.slide).toEqual({ row: 1, col: 0, index: 2, skipped: false });
  });
});

describe("a read with no node in a deck", () => {
  it("starts at the focused slide", async () => {
    fake.currentPage.focusedSlide = s3;
    const r = await run("get_design_context");
    expect(r).toMatchObject({ scope: "focusedSlide", root: { id: s3.id } });
    expect(r.note).toMatch(/focused slide "Ask"/);
    const scan = await run("scan_text_nodes");
    expect(scan.scope).toMatchObject({ id: s3.id, from: "focusedSlide" });
    expect((scan.nodes as Any[]).map((n) => n.characters)).toEqual(["Raise $2M"]);
    const check = await run("check_layout");
    expect(check.root).toMatchObject({ id: s3.id });
  });

  it("with no focused slide, returns the deck's outline instead of every slide at depth 8", async () => {
    fake.currentPage.focusedSlide = null;
    const r = await run("get_design_context");
    expect(r.scope).toBe("deck");
    expect(r.root).toBeUndefined();
    expect(r.deck).toEqual({
      gridId: grid.id,
      rowCount: 2,
      slideCount: 3,
      rows: [
        { id: row0.id, name: "Row", slideCount: 2, slides: [{ id: s1.id, name: "Cover" }, { id: s2.id, name: "Problem" }] },
        { id: row1.id, name: "Row", slideCount: 1, slides: [{ id: s3.id, name: "Ask" }] },
      ],
    });
    expect(r.note).toMatch(/Pass nodeId/);
    const check = await run("check_layout");
    expect(check.root).toMatchObject({ type: "PAGE" });
    expect(check.note).toMatch(/whole deck/);
  });

  it("a selection still wins over the focused slide", async () => {
    fake.currentPage.focusedSlide = s3;
    fake.currentPage.selection = [s1];
    expect(await run("get_design_context")).toMatchObject({ scope: "selection", root: { id: s1.id } });
  });
});

describe("figma_get_metadata on a deck", () => {
  it("outlines rows and slides, the focused slide and the view, whichever view member reads [C-140]", async () => {
    fake.currentPage.focusedSlide = s2;
    const views: Array<[Any | undefined, Any | undefined]> = [
      [{ canvasView: "grid" }, { view: "grid", viewProperty: "canvasView" }],
      // canvasView spells one slide "single-asset"; every tool reports it in figma_zoom_to's words (slides/grid.ts readView).
      [{ canvasView: "single-asset" }, { view: "single-slide", viewProperty: "canvasView" }],
      [{ slidesView: "single-slide" }, { view: "single-slide", viewProperty: "slidesView" }],
      [{ slidesMode: "grid" }, { view: "grid", viewProperty: "slidesMode" }],
      [
        Object.defineProperty({ slidesView: "grid" }, "canvasView", { get() { throw new TypeError("no such property 'canvasView' on viewport"); } }),
        { view: "grid", viewProperty: "slidesView" },
      ],
      [undefined, undefined],
    ];
    for (const [viewport, expected] of views) {
      (fake as unknown as Any).viewport = viewport;
      const r = await run("get_metadata");
      const slides = r.slides as Any;
      expect(slides).toMatchObject({
        rowCount: 2,
        slideCount: 3,
        rows: [{ id: row0.id, slideCount: 2 }, { id: row1.id, slideCount: 1 }],
        focusedSlideId: s2.id,
      });
      expect({ view: slides.view, viewProperty: slides.viewProperty }).toEqual(expected ?? { view: undefined, viewProperty: undefined });
    }
  });
});
