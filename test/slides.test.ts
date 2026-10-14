// The Figma Slides tools against a fake deck (test/slides-fakes.ts): reading
// the grid without touching the opaque rows, adding slides in list order,
// regrouping and moving them with one grid write, skipped slides, speaker
// notes and transitions — each refusing before its first change, and each
// surviving both sides of the facts the sources disagree on [C-138] [C-139]
// [C-164]. Then the server schemas: strict, portable, within the description cap.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { editorsSuffix } from "../src/shared/editors.js";
import { createShapeRecorder } from "../src/server/tools/batch.js";
import {
  DELAY_RANGE,
  DURATION_RANGE,
  mergeTransition,
  notesWarnings,
  SLIDES_OPS,
  TRANSITION_CURVES as PLUGIN_CURVES,
  TRANSITION_STYLES as PLUGIN_STYLES,
  transitionOut,
} from "../src/plugin/ops/slides.js";
import { gridProblems, planCreates, planMove } from "../src/plugin/slides/grid.js";
import { BridgeError } from "../src/shared/errors.js";
import type { Bridge } from "../src/server/bridge.js";
import type { Extra } from "../src/server/tools/forward.js";
import { normalizeIdParams } from "../src/server/figma-url.js";
import { registerSlides, TRANSITION_CURVES, TRANSITION_STYLES } from "../src/server/tools/slides.js";
import { FakeFigma, FakeNode, installFigma, opContext, solid } from "./editor-fakes.js";
import { addPoll, addText, FakeDeck, type DeckOptions } from "./slides-fakes.js";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function deck(opts: DeckOptions = {}): FakeDeck {
  const d = new FakeDeck(opts);
  uninstall = installFigma(d);
  return d;
}

// The ops return loosely typed JSON; tests read it as such.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const run = (op: string, params: Record<string, unknown>): Promise<Json> => SLIDES_OPS[op]!.run(opContext(params));

async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}

/** A refusal that provably changed nothing: the marker code.ts reads to free the key [C-096]. */
const unchanged = (e: BridgeError) => expect(e.partial).toMatchObject({ created: [] });

// ── planning (pure) ─────────────────────────────────────────────────────────

describe("planning a change without touching the deck", () => {
  it("places new slides in list order against the grid the earlier ones left", () => {
    expect(planCreates([2], [{ row: 0, col: 0 }, { row: 1 }, {}, { row: 0, col: 1 }])).toEqual([
      { row: 0, col: 0, call: "at" },
      { row: 1, col: 0, call: "newRow" },
      { row: 1, col: 1, call: "default" },
      { row: 0, col: 1, call: "at" },
    ]);
  });

  it("an empty deck takes its first slide at row 0 only, with createSlide()'s own default [C-164]", () => {
    expect(planCreates([], [{}, {}])).toEqual([
      { row: 0, col: 0, call: "default" },
      { row: 0, col: 1, call: "default" },
    ]);
    expect(planCreates([], [{ row: 0, col: 0 }])).toEqual([{ row: 0, col: 0, call: "default" }]);
    expect(() => planCreates([], [{ row: 1 }])).toThrow(/no rows yet, so its first slide makes row 0/);
  });

  it("refuses a row past the next one, a col past the row's end, a col without a row, a col in a new row", () => {
    expect(() => planCreates([1], [{}, { row: 2 }])).toThrow(/slides\[1\]\.row` is 2, but the deck has 1 row/);
    expect(() => planCreates([1], [{ row: 0, col: 2 }])).toThrow(/row 0 holds 1 slide/);
    expect(() => planCreates([1], [{ col: 0 }])).toThrow(/`slides\[0\]\.col` needs `slides\[0\]\.row`/);
    expect(() => planCreates([1], [{ row: 1, col: 1 }])).toThrow(/new, empty row/);
  });

  it("moves a block after, before or into a row, keeping emptied rows in place", () => {
    const g = [["a", "b", "c"], ["d", "e"]];
    expect(planMove(g, ["e"], { after: "a" })).toEqual([["a", "e", "b", "c"], ["d"]]);
    expect(planMove(g, ["c", "a"], { before: "d" })).toEqual([["b"], ["c", "a", "d", "e"]]);
    expect(planMove(g, ["d", "e"], { row: 0, col: 1 })).toEqual([["a", "d", "e", "b", "c"], []]);
    expect(planMove(g, ["a"], { row: 2 })).toEqual([["b", "c"], ["d", "e"], ["a"]]);
    // col counts once the moved slides are out: row 0 is [b, c] then.
    expect(planMove(g, ["a"], { row: 0, col: 2 })).toEqual([["b", "c", "a"], ["d", "e"]]);
  });

  it("refuses an anchor inside the block, an unknown anchor, and rows or cols out of range", () => {
    const g = [["a", "b"], ["c"]];
    expect(() => planMove(g, ["a", "b"], { after: "b" })).toThrow(/`afterSlideId` b is one of the slides being moved/);
    expect(() => planMove(g, ["a"], { before: "zz" })).toThrow(/`beforeSlideId` zz is not a slide in this deck/);
    expect(() => planMove(g, ["a"], { row: 3 })).toThrow(/`row` is 3, but the deck has 2 row/);
    expect(() => planMove(g, ["a"], { row: 0, col: 2 })).toThrow(/row 0 holds 1 slide\(s\) once the moved ones are out/);
    expect(() => planMove(g, ["a"], { row: 2, col: 1 })).toThrow(/new, empty row/);
  });

  it("names what keeps a grid from being complete", () => {
    expect(gridProblems(["a", "b", "c"], [["a", "x"], ["a", "b"]])).toEqual({ missing: ["c"], duplicate: ["a"], unknown: ["x"] });
    expect(gridProblems(["a", "b"], [["b"], ["a"]])).toEqual({ missing: [], duplicate: [], unknown: [] });
  });
});

// ── figma_get_slide_grid ────────────────────────────────────────────────────

describe("figma_get_slide_grid", () => {
  it("reads rows and slides from the tree, in presentation order, and lists empty rows apart", async () => {
    const d = deck({ rows: [2, 1, 0, 2] });
    const r = await run("get_slide_grid", { includeSummary: false });
    expect(r).toMatchObject({ gridId: d.grid!.id, rowCount: 4, slideCount: 5, slideSize: { width: 1920, height: 1080 }, view: "grid", focusedSlideId: null });
    expect(r.rows.map((x: Json) => [x.index, x.rowId, x.slideCount])).toEqual([
      [0, d.rowsNow[0]!.id, 2],
      [1, d.rowsNow[1]!.id, 1],
      [3, d.rowsNow[3]!.id, 2],
    ]);
    expect(r.rows.flatMap((x: Json) => x.slides.map((s: Json) => [s.id, s.row, s.col, s.index, s.skipped]))).toEqual([
      [d.slide(0, 0).id, 0, 0, 0, false],
      [d.slide(0, 1).id, 0, 1, 1, false],
      [d.slide(1, 0).id, 1, 0, 2, false],
      [d.slide(3, 0).id, 3, 0, 3, false],
      [d.slide(3, 1).id, 3, 1, 4, false],
    ]);
    expect(r.emptyRows).toEqual([{ rowId: d.rowsNow[2]!.id, index: 2, name: "Row" }]);
    expect(r.apiMismatch).toBeUndefined();
    // Without the summary: the child count stays, the summary fields go.
    expect(r.rows[0].slides[0].childCount).toBe(0);
    expect(Object.keys(r.rows[0].slides[0]).filter((k) => ["background", "title", "interactive"].includes(k))).toEqual([]);
  });

  it("never reads a member the opaque rows and grid lack (they throw) [C-136] [C-145]", async () => {
    const d = deck({ rows: [2, 1] });
    addText(d.slide(0, 0), "Hello", 64);
    await run("get_slide_grid", { includeTransitions: true });
    expect((d.grid as unknown as { opaqueReads: string[] }).opaqueReads).toEqual([]);
    for (const row of d.rowsNow) expect((row as unknown as { opaqueReads: string[] }).opaqueReads).toEqual([]);
  });

  it("an empty deck has no rows and says the first create makes row 0", async () => {
    deck();
    const r = await run("get_slide_grid", {});
    expect(r).toMatchObject({ rowCount: 0, slideCount: 0, rows: [], emptyRows: [] });
    expect(r.note).toMatch(/first figma_create_slides makes row 0/);
    expect(r.slideSize).toBeUndefined();
  });

  it("speaker notes: read where Figma exposes them, else named in `unsupported` [C-138]", async () => {
    deck({ rows: [1] });
    const without = await run("get_slide_grid", {});
    expect(without.unsupported).toEqual(["speakerNotes"]);
    expect(without.rows[0].slides[0].speakerNotes).toBeUndefined();
    uninstall?.();
    const d = deck({ rows: [1], notes: true });
    (d.slide(0, 0) as unknown as { speakerNotes: string }).speakerNotes = "- open with the number";
    const withNotes = await run("get_slide_grid", {});
    expect(withNotes.unsupported).toBeUndefined();
    expect(withNotes.rows[0].slides[0].speakerNotes).toBe("- open with the number");
    expect((await run("get_slide_grid", { includeNotes: false })).rows[0].slides[0].speakerNotes).toBeUndefined();
  });

  it("transitions on request: each slide's, or transitionError where the getter throws [C-139]", async () => {
    deck({ rows: [1] });
    const ok = await run("get_slide_grid", { includeTransitions: true });
    expect(ok.rows[0].slides[0].transition).toEqual({ style: "NONE", duration: 0, curve: "EASE_OUT", timing: "on-click" });
    uninstall?.();
    deck({ rows: [2], transitions: "not-implemented" });
    const r = await run("get_slide_grid", { includeTransitions: true });
    expect(r.rows[0].slides.map((s: Json) => s.transitionError)).toEqual(["not implemented", "not implemented"]);
    expect(r.unsupported).toEqual(["speakerNotes", "transition"]);
    expect((await run("get_slide_grid", {})).rows[0].slides[0].transitionError).toBeUndefined();
  });

  it("summarises each slide: child count, background, title (largest text, cut at 120) and interactive elements", async () => {
    const d = deck({ rows: [2] });
    const first = d.slide(0, 0);
    first.fills = [solid("#0B1020")];
    addText(first, "small print", 14);
    addText(first, `Quarterly   results\n${"x".repeat(200)}`, 96);
    addPoll(first);
    const r = await run("get_slide_grid", {});
    const s = r.rows[0].slides[0];
    expect(s).toMatchObject({ childCount: 3, background: "#0b1020" });
    expect(s.title).toHaveLength(120);
    expect(s.title.startsWith("Quarterly results xxx")).toBe(true);
    expect(s.title.endsWith("…")).toBe(true);
    expect(s.interactive).toEqual([{ id: d.slide(0, 0).children[2]!.id, type: "POLL" }]);
    expect(r.rows[0].slides[1]).toMatchObject({ childCount: 0, background: "#ffffff" });
    expect(r.rows[0].slides[1].title).toBeUndefined();
  });

  it("uses the indexed findAllWithCriteria when the slide has it", async () => {
    const d = deck({ rows: [1] });
    const slide = d.slide(0, 0);
    const calls: unknown[] = [];
    Object.assign(slide, { findAllWithCriteria: (c: { types: string[] }) => (calls.push(c.types), c.types.includes("TEXT") ? [{ type: "TEXT", characters: "Indexed", fontSize: 40 }] : []) });
    const r = await run("get_slide_grid", {});
    expect(r.rows[0].slides[0].title).toBe("Indexed");
    expect(calls).toEqual([["TEXT"], ["INTERACTIVE_SLIDE_ELEMENT"]]);
  });

  it("reads one row, empty or not, and refuses a row the deck does not have", async () => {
    const d = deck({ rows: [1, 0, 2] });
    const one = await run("get_slide_grid", { rowIndex: 2 });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0].slides.map((s: Json) => s.index)).toEqual([1, 2]);
    expect((await run("get_slide_grid", { rowIndex: 1 })).rows).toEqual([{ rowId: d.rowsNow[1]!.id, index: 1, name: "Row", slideCount: 0, slides: [] }]);
    expect((await refusal(run("get_slide_grid", { rowIndex: 3 }))).message).toMatch(/`rowIndex` is 3, but the deck has 3 row/);
  });

  it("pages by slide with a cursor that belongs to its query", async () => {
    deck({ rows: [3, 2] });
    const a = await run("get_slide_grid", { limit: 2 });
    expect(a.truncated).toBe(true);
    expect(a.rows.flatMap((r: Json) => r.slides.map((s: Json) => s.index))).toEqual([0, 1]);
    const b = await run("get_slide_grid", { limit: 2, cursor: a.nextCursor });
    expect(b.rows.flatMap((r: Json) => r.slides.map((s: Json) => s.index))).toEqual([2, 3]);
    const c = await run("get_slide_grid", { limit: 2, cursor: b.nextCursor });
    expect(c.rows.flatMap((r: Json) => r.slides.map((s: Json) => s.index))).toEqual([4]);
    expect(c.truncated).toBeUndefined();
    await expect(run("get_slide_grid", { rowIndex: 0, cursor: a.nextCursor })).rejects.toThrow(/does not belong to this query/);
  });

  it("cross-checks Figma's own grid call and follows the tree when they disagree [C-164]", async () => {
    const d = deck({ rows: [2] });
    const [a, b] = d.rowsNow[0]!.slides;
    Object.assign(d, { getCanvasGrid: () => [[b, a]] });
    const r = await run("get_slide_grid", {});
    expect(r.apiMismatch).toMatchObject({ via: "getCanvasGrid", rows: [[b!.id, a!.id]] });
    expect(r.rows[0].slides.map((s: Json) => s.id)).toEqual([a!.id, b!.id]);
  });

  it("is refused outside a Slides file", async () => {
    uninstall = installFigma(new FakeFigma({ editorType: "figma" }));
    const e = await refusal(run("get_slide_grid", {}));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/Figma Slides files, and this page has no slide grid \(editorType "figma"\)/);
  });
});

// ── figma_create_slides ─────────────────────────────────────────────────────

describe("figma_create_slides", () => {
  it("the first slide of an empty deck makes row 0, through createSlide() with no arguments [C-164]", async () => {
    const d = deck();
    const calls: unknown[][] = [];
    const real = d.createSlide.bind(d);
    Object.assign(d, { createSlide: (...a: [row?: number, col?: number]) => (calls.push(a), real(...a)) });
    const r = await run("create_slides", { slides: [{ name: "Title" }, { name: "Agenda" }] });
    expect(calls).toEqual([[], []]);
    expect(r).toMatchObject({ rowCount: 1, slideCount: 2, rowsCreated: [d.rowsNow[0]!.id] });
    expect(r.slides.map((s: Json) => [s.name, s.row, s.col, s.index])).toEqual([["Title", 0, 0, 0], ["Agenda", 0, 1, 1]]);
    expect(r.warnings).toBeUndefined();
    // The runner commits the one undo step, never the op [C-151].
    expect(d.undoCommits).toBe(0);
  });

  it("places items in list order: an explicit spot, a new row, the end of the deck, an insert", async () => {
    const d = deck({ rows: [2] });
    const [s0, s1] = d.rowsNow[0]!.slides.map((s) => s.id);
    const r = await run("create_slides", { slides: [{ row: 0, col: 0, name: "A" }, { row: 1, name: "B" }, { name: "C" }, { row: 0, col: 1, name: "D" }] });
    const named = Object.fromEntries(r.slides.map((s: Json) => [s.name, [s.row, s.col, s.index]]));
    expect(named).toEqual({ A: [0, 0, 0], D: [0, 1, 1], B: [1, 0, 4], C: [1, 1, 5] });
    expect(d.ids()).toEqual([[r.slides[0].id, r.slides[3].id, s0, s1], [r.slides[1].id, r.slides[2].id]]);
    expect(r.rowsCreated).toEqual([d.rowsNow[1]!.id]);
    expect(r.warnings).toBeUndefined();
  });

  it("puts the background on the slide's fills, and sets skipped and the name", async () => {
    const d = deck({ rows: [1] });
    const r = await run("create_slides", { slides: [{ name: "Dark", background: "#0b1020", skipped: true }] });
    const slide = d.slide(0, 1);
    expect(slide.id).toBe(r.slides[0].id);
    expect(slide.fills).toEqual([{ type: "SOLID", color: { r: 11 / 255, g: 16 / 255, b: 32 / 255 } }]);
    expect(slide.isSkippedSlide).toBe(true);
    expect(slide.name).toBe("Dark");
  });

  it("checks every item before the first slide exists: a bad row, colour or field changes nothing", async () => {
    const d = deck({ rows: [1] });
    for (const slides of [
      [{ name: "fine" }, { row: 3 }],
      [{ name: "fine" }, { background: "teal" }],
      [{ name: "fine" }, { title: "Agenda" }],
      [{ col: 0 }],
      [],
    ]) {
      const e = await refusal(run("create_slides", { slides }));
      expect(e.code).toBe("INVALID_PARAM");
      unchanged(e);
    }
    expect(d.ids().flat()).toHaveLength(1);
  });

  it("a slide that fails half-way reports what exists and where it stopped", async () => {
    const d = deck({ rows: [1] });
    const real = d.createSlide.bind(d);
    let n = 0;
    Object.assign(d, { createSlide: (r?: number, c?: number) => { if (++n === 2) throw new Error("in createSlide: boom"); return real(r, c); } });
    const e = await refusal(run("create_slides", { slides: [{ name: "one" }, { name: "two" }, { name: "three" }] }));
    expect(e.message).toBe("in createSlide: boom");
    expect(e.partial).toEqual({ created: [{ id: d.slide(0, 1).id, name: "one", path: "slides[0]" }], failedAt: "slides[1]" });
    expect(e.hint).toMatch(/Ctrl\+Z/);
  });

  it("is refused when this editor has no createSlide", async () => {
    const d = deck({ rows: [1] });
    d.removed.add("createSlide");
    const e = await refusal(run("create_slides", { slides: [{}] }));
    expect(e.code).toBe("UNSUPPORTED");
    unchanged(e);
  });
});

// ── figma_set_slide_grid ────────────────────────────────────────────────────

describe("figma_set_slide_grid", () => {
  it("refuses a grid that omits, repeats or invents a slide — listed by id — before writing anything", async () => {
    const d = deck({ rows: [2, 1] });
    const [[a, b], [c]] = d.ids() as [[string, string], [string]];
    const frame = new FakeNode("FRAME", "Frame", d);
    for (const [rows, says] of [
      [[{ slideIds: [a, b] }], `Missing: ${c}.`],
      [[{ slideIds: [a, b, c, a] }], `Repeated: ${a}.`],
      [[{ slideIds: [a, b, c, frame.id] }], `Not slides of this deck: ${frame.id}.`],
    ] as const) {
      const e = await refusal(run("set_slide_grid", { rows }));
      expect(e.code).toBe("INVALID_PARAM");
      expect(e.hint).toContain(says);
      unchanged(e);
    }
    expect(d.gridWrites).toEqual([]);
  });

  it("writes the whole grid once, names rows by the slides they hold, and reports what moved", async () => {
    const d = deck({ rows: [2, 2] });
    const [[a, b], [c, e]] = d.ids() as [[string, string], [string, string]];
    const r = await run("set_slide_grid", { rows: [{ slideIds: [a, c], name: "Intro" }, { slideIds: [b], name: "Demo" }, { slideIds: [e], name: "" }] });
    expect(d.gridWrites).toEqual([{ via: "setCanvasGrid", rows: [[a, c], [b], [e]] }]);
    expect(d.ids()).toEqual([[a, c], [b], [e]]);
    expect(d.rowsNow.map((x) => x.name)).toEqual(["Intro", "Demo", ""]);
    expect(r).toMatchObject({ moved: 3, renamed: 3, via: "setCanvasGrid" });
    expect(r.rows.map((x: Json) => [x.name, x.slideIds])).toEqual([["Intro", [a, c]], ["Demo", [b]], ["", [e]]]);
  });

  it("reports a row the regroup left empty, or that Figma removed [C-164]", async () => {
    const kept = deck({ rows: [1, 1] });
    const [[a], [b]] = kept.ids() as [[string], [string]];
    const r = await run("set_slide_grid", { rows: [{ slideIds: [b, a] }] });
    expect(r.emptyRows).toEqual([{ rowId: kept.rowsNow[1]!.id, index: 1, name: "Row" }]);
    expect(r.emptyRowsRemoved).toBeUndefined();
    uninstall?.();
    const pruned = deck({ rows: [1, 1], pruneEmptyRows: true });
    const gone = pruned.rowsNow[1]!.id;
    const [[x], [y]] = pruned.ids() as [[string], [string]];
    const p = await run("set_slide_grid", { rows: [{ slideIds: [x, y] }] });
    expect(p.emptyRowsRemoved).toEqual([gone]);
    expect(p.emptyRows).toBeUndefined();
  });

  it("falls back to the deprecated setSlideGrid, and is refused when neither call exists", async () => {
    const d = deck({ rows: [2], gridApi: "slide" });
    const [[a, b]] = d.ids() as [[string, string]];
    expect((await run("set_slide_grid", { rows: [{ slideIds: [b, a] }] })).via).toBe("setSlideGrid");
    uninstall?.();
    const none = deck({ rows: [1], gridApi: "none" });
    const e = await refusal(run("set_slide_grid", { rows: [{ slideIds: none.ids()[0]! }] }));
    expect(e.code).toBe("UNSUPPORTED");
    unchanged(e);
  });
});

// ── figma_move_slides ───────────────────────────────────────────────────────

describe("figma_move_slides", () => {
  it("moves a block after, before, or into a row, in one grid write, with per-slide results", async () => {
    const d = deck({ rows: [3, 2] });
    const [[a, b, c], [x, y]] = d.ids() as [[string, string, string], [string, string]];
    const r = await run("move_slides", { slideIds: [y], afterSlideId: a });
    expect(d.ids()).toEqual([[a, y, b, c], [x]]);
    expect(r.items).toEqual([{ id: y, ok: true, row: 0, col: 1, index: 1 }]);
    expect(r.moved).toBe(1);
    await run("move_slides", { slideIds: [c, a], beforeSlideId: x });
    expect(d.ids()).toEqual([[y, b], [c, a, x]]);
    const last = await run("move_slides", { slideIds: [b], row: 2 });
    expect(d.ids()).toEqual([[y], [c, a, x], [b]]);
    expect(last.rows.map((row: Json) => row.slideCount)).toEqual([1, 3, 1]);
    await run("move_slides", { slideIds: [b], row: 1, col: 1 });
    expect(d.ids()).toEqual([[y], [c, b, a, x], []]);
    expect(d.gridWrites).toHaveLength(4);
  });

  it("reports a row the move emptied, kept or removed", async () => {
    const d = deck({ rows: [1, 2] });
    const [[a], [b, c]] = d.ids() as [[string], [string, string]];
    const r = await run("move_slides", { slideIds: [b, c], afterSlideId: a });
    expect(r.emptiedRows).toEqual([{ rowId: d.rowsNow[1]!.id, name: "Row", removed: false }]);
    uninstall?.();
    const p = deck({ rows: [1, 1], pruneEmptyRows: true });
    const row = p.rowsNow[1]!.id;
    const [[x], [y]] = p.ids() as [[string], [string]];
    expect((await run("move_slides", { slideIds: [y], beforeSlideId: x })).emptiedRows).toEqual([{ rowId: row, name: "Row", removed: true }]);
  });

  it("refuses before any write: an anchor in the block, no anchor or two, col without row, a col too far", async () => {
    const d = deck({ rows: [2, 1] });
    const [[a, b], [c]] = d.ids() as [[string, string], [string]];
    for (const [params, says] of [
      [{ slideIds: [a, b], afterSlideId: b }, /one of the slides being moved/],
      [{ slideIds: [a] }, /exactly one of `afterSlideId`, `beforeSlideId` or `row`/],
      [{ slideIds: [a], afterSlideId: c, row: 0 }, /got afterSlideId, row/],
      [{ slideIds: [a], afterSlideId: c, col: 0 }, /`col` goes with `row`/],
      [{ slideIds: [a], row: 1, col: 2 }, /row 1 holds 1 slide/],
      [{ slideIds: [a, a], row: 0 }, /names .* twice/],
      [{ slideIds: [a], beforeSlideId: "77:77" }, /not a slide in this deck/],
    ] as const) {
      const e = await refusal(run("move_slides", params));
      expect(e.message).toMatch(says);
      unchanged(e);
    }
    expect(d.gridWrites).toEqual([]);
  });

  it("an id that is not a slide of the deck fails its own item; the rest still move", async () => {
    const d = deck({ rows: [2, 1] });
    const [[a, b], [c]] = d.ids() as [[string, string], [string]];
    const frame = new FakeNode("FRAME", "Frame", d);
    const r = await run("move_slides", { slideIds: ["99:99", b, frame.id], afterSlideId: c });
    expect(d.ids()).toEqual([[a], [c, b]]);
    expect(r.items).toEqual([
      { id: "99:99", ok: false, error: "not found" },
      { id: b, ok: true, row: 1, col: 1, index: 2 },
      { id: frame.id, ok: false, error: "a FRAME, not a slide" },
    ]);
    const none = await refusal(run("move_slides", { slideIds: ["99:99"], row: 0 }));
    expect(none.hint).toBe("99:99: not found");
    unchanged(none);
  });
});

// ── figma_set_slide_properties ──────────────────────────────────────────────

describe("figma_set_slide_properties", () => {
  it("notes asked for where Figma does not expose them: UNSUPPORTED, nothing written — not even the skip [C-138]", async () => {
    const d = deck({ rows: [2] });
    const [[a, b]] = d.ids() as [[string, string]];
    const e = await refusal(run("set_slide_properties", { slides: [{ slideId: a, skipped: true }, { slideId: b, speakerNotes: "- hi" }] }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain(`Speaker notes are not exposed to this plugin build (no speakerNotes on ${b})`);
    expect(e.hint).toMatch(/^Speaker notes are not exposed to this plugin build, so nothing was changed\./);
    unchanged(e);
    expect(d.slide(0, 0).isSkippedSlide).toBe(false);
  });

  it("writes skip and notes, reads them back, and warns on markdown kept literally [C-165]", async () => {
    const d = deck({ rows: [2], notes: true });
    const [[a, b]] = d.ids() as [[string, string]];
    const r = await run("set_slide_properties", {
      slides: [
        { slideId: a, skipped: true, speakerNotes: "- **Revenue** grew\n- ask about margins" },
        { slideId: b, speakerNotes: "# Section\nsee [deck](https://x.y) and `code`" },
      ],
    });
    expect(r.updated).toBe(2);
    expect(r.items[0]).toEqual({ id: a, ok: true, skipped: true, speakerNotes: "- **Revenue** grew\n- ask about margins" });
    expect(r.items[1].warnings).toEqual([
      "'# ' headings are kept as literal text in speaker notes",
      "code (`…`) is kept as literal text in speaker notes",
      "links [text](url) are kept as literal text in speaker notes",
    ]);
    expect(d.slide(0, 0).isSkippedSlide).toBe(true);
    expect((d.slide(0, 1) as unknown as { speakerNotes: string }).speakerNotes).toBe("# Section\nsee [deck](https://x.y) and `code`");
    expect(notesWarnings("- one\n- *two* ~~three~~")).toEqual([]);
  });

  it("a slide that is not there fails its own item; an empty or repeated item is refused", async () => {
    const d = deck({ rows: [1] });
    const [[a]] = d.ids() as [[string]];
    const frame = new FakeNode("FRAME", "Frame", d);
    const r = await run("set_slide_properties", { slides: [{ slideId: "5:5", skipped: true }, { slideId: frame.id, skipped: true }, { slideId: a, skipped: true }] });
    expect(r.items.map((i: Json) => [i.ok, i.error])).toEqual([[false, "not found"], [false, "a FRAME, not a slide"], [true, undefined]]);
    for (const slides of [[{ slideId: a }], [{ slideId: a, skipped: true }, { slideId: a, skipped: false }], [{ slideId: a, hidden: true }]]) {
      unchanged(await refusal(run("set_slide_properties", { slides })));
    }
  });
});

// ── figma_set_slide_transition ──────────────────────────────────────────────

describe("figma_set_slide_transition", () => {
  it("sets each slide's transition and returns it as read back; fields left out keep the slide's own", async () => {
    const d = deck({ rows: [2] });
    const [[a, b]] = d.ids() as [[string, string]];
    d.slide(0, 1).transition = { style: "PUSH_FROM_LEFT", duration: 0.8, curve: "GENTLE", timing: { type: "AFTER_DELAY", delay: 3 } };
    const r = await run("set_slide_transition", { slideIds: [a, b], style: "DISSOLVE", duration: 0.4 });
    expect(r.items).toEqual([
      { id: a, ok: true, transition: { style: "DISSOLVE", duration: 0.4, curve: "EASE_OUT", timing: "on-click" } },
      { id: b, ok: true, transition: { style: "DISSOLVE", duration: 0.4, curve: "GENTLE", timing: "after-delay", delay: 3 } },
    ]);
    expect(d.slide(0, 0).transition).toEqual({ style: "DISSOLVE", duration: 0.4, curve: "EASE_OUT", timing: { type: "ON_CLICK" } });
  });

  it("'not implemented' from Figma: UNSUPPORTED before anything is written [C-139]", async () => {
    const d = deck({ rows: [1], transitions: "not-implemented" });
    const e = await refusal(run("set_slide_transition", { slideIds: d.ids()[0]!, style: "DISSOLVE", duration: 0.4 }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/not implemented/);
    unchanged(e);
  });

  it("refuses a delay with on-click (Figma zeroes it), after-delay with no delay to keep, and out-of-range values", async () => {
    const d = deck({ rows: [1] });
    const ids = d.ids()[0]!;
    for (const [params, says] of [
      [{ style: "DISSOLVE", duration: 0.4, timing: "on-click", delay: 2 }, /`delay` goes with timing "after-delay"/],
      [{ style: "DISSOLVE", duration: 0.4, delay: 2 }, /`delay` goes with timing "after-delay"/],
      [{ style: "DISSOLVE", duration: 0.4, timing: "after-delay" }, /no delay to keep/],
      [{ style: "DISSOLVE" }, /no transition duration to keep \(0\)/],
      [{ style: "DISSOLVE", duration: 0 }, /0\.01–10/],
      [{ style: "DISSOLVE", duration: 11 }, /0\.01–10/],
      [{ style: "DISSOLVE", duration: 1, timing: "after-delay", delay: 31 }, /0–30/],
      [{ style: "FADE" }, /transition styles/],
      [{ style: "DISSOLVE", duration: 1, curve: "EASE_IN_OUT" }, /transition curves/],
    ] as const) {
      const e = await refusal(run("set_slide_transition", { slideIds: ids, ...params }));
      expect(e.message).toMatch(says);
      unchanged(e);
    }
    expect(d.slide(0, 0).transition).toMatchObject({ style: "NONE" });
  });

  it("merges without inventing a value; NONE keeps whatever duration the slide has", () => {
    const cur = { style: "NONE", duration: 0, curve: "EASE_OUT", timing: { type: "ON_CLICK" } };
    expect(mergeTransition(cur, { style: "NONE" }, "1:1")).toEqual({ style: "NONE", duration: 0, curve: "EASE_OUT", timing: { type: "ON_CLICK" } });
    expect(mergeTransition(cur, { style: "SMART_ANIMATE", duration: 1, timing: "after-delay", delay: 0 }, "1:1").timing).toEqual({ type: "AFTER_DELAY", delay: 0 });
    expect(() => mergeTransition({}, { style: "DISSOLVE", duration: 1 }, "1:1")).toThrow(/no transition curve to keep/);
    expect(transitionOut({ style: "DISSOLVE", duration: 1, curve: "LINEAR", timing: { type: "AFTER_DELAY", delay: 2 } })).toEqual({
      style: "DISSOLVE", duration: 1, curve: "LINEAR", timing: "after-delay", delay: 2,
    });
    expect([DURATION_RANGE, DELAY_RANGE]).toEqual([{ min: 0.01, max: 10 }, { min: 0, max: 30 }]);
  });
});

// ── the server side ─────────────────────────────────────────────────────────

type Tool = { config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: Record<string, unknown> }; handler: (a: Record<string, unknown>, e: Extra) => Promise<CallToolResult> };

function registered(request: (op: string, p: Record<string, unknown>) => unknown = () => ({})): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
  const bridge = { request: async (op: string, p: Record<string, unknown>) => request(op, p), statusAsync: async () => ({ sessions: [] }) } as unknown as Bridge;
  registerSlides(server, bridge, () => true);
  return tools;
}

const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

// The provider-portable subset test/schema-portability.test.ts enforces once a
// tool is registered; the top-level $schema is removed by createApp
// (src/server/schema-dialect.ts), so it is left out here as in test/batch.test.ts.
const FORBIDDEN = new Set([
  "$ref", "$defs", "definitions", "$id", "anyOf", "oneOf", "allOf", "not", "if", "then", "else", "const", "format",
  "patternProperties", "propertyNames", "dependentSchemas", "dependentRequired", "unevaluatedProperties", "contains", "prefixItems",
]);
const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);
function problems(s: Record<string, unknown>, path: string): string[] {
  const out = Object.keys(s).filter((k) => FORBIDDEN.has(k)).map((k) => `${path}: uses ${k}`);
  if (typeof s.type !== "string" || !TYPES.has(s.type)) out.push(`${path}: no single portable type`);
  if (s.type === "object") for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>)) out.push(...problems(v, `${path}.${k}`));
  if (s.type === "array") out.push(...problems(s.items as Record<string, unknown>, `${path}[]`));
  return out;
}

/** The tools as an MCP client lists them: registered through the shape recorder (strict, Editors sentence appended). */
async function listedTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>; client: Client }> {
  const server = new McpServer({ name: "slides-check", version: "0" });
  createShapeRecorder(server);
  registerSlides(server, { request: async () => ({}), statusAsync: async () => ({ sessions: [] }) } as unknown as Bridge, () => true);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  return { tools: tools as Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>, client };
}

describe("the server tools", () => {
  const NAMES = ["figma_get_slide_grid", "figma_create_slides", "figma_set_slide_grid", "figma_move_slides", "figma_set_slide_properties", "figma_set_slide_transition"];

  it("registers the six tools only when wanted, with read and write annotations", () => {
    const tools = registered();
    expect(Object.keys(tools).sort()).toEqual([...NAMES].sort());
    expect(tools.figma_get_slide_grid!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const n of NAMES.slice(1)) expect(tools[n]!.config.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    const none: string[] = [];
    registerSlides({ registerTool: (n: string) => void none.push(n) } as unknown as McpServer, {} as Bridge, () => false);
    expect(none).toEqual([]);
  });

  it("every schema is strict, nested objects included", () => {
    for (const [name, t] of Object.entries(registered())) {
      expect(z.object(t.config.inputSchema).strict().safeParse({ bogus: 1 }).success, name).toBe(false);
    }
    const shape = (n: string) => z.object(registered()[n]!.config.inputSchema).strict();
    expect(shape("figma_create_slides").safeParse({ slides: [{ name: "x", title: "y" }] }).success).toBe(false);
    expect(shape("figma_set_slide_grid").safeParse({ rows: [{ slideIds: ["1:2"], label: "y" }] }).success).toBe(false);
    expect(shape("figma_set_slide_properties").safeParse({ slides: [{ slideId: "1:2", hidden: true }] }).success).toBe(false);
    expect(shape("figma_set_slide_transition").safeParse({ slideIds: ["1:2"], style: "DISSOLVE", duration: 20 }).success).toBe(false);
    expect(shape("figma_set_slide_transition").safeParse({ slideIds: ["1:2"], style: "DISSOLVE", timing: "on-click" }).success).toBe(true);
  });

  it("as a client lists them: inside the portable subset, within 1024 with the Editors sentence, no body cut", async () => {
    const raw = registered();
    const { tools, client } = await listedTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    for (const t of tools) {
      expect(problems(t.inputSchema, t.name)).toEqual([]);
      const suffix = editorsSuffix(t.name.replace(/^figma_/, ""));
      // Every Slides tool carries one: with no row yet, "unverified in Design, FigJam, Slides" (the longest
      // there is); with its row, "Slides only".
      expect(suffix, t.name).not.toBe("");
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
      expect(t.description, t.name).toBe(raw[t.name]!.config.description + suffix);
      expect(raw[t.name]!.config.description.endsWith("…"), t.name).toBe(false);
    }
    await client.close();
  });

  it("the transition lists match the plugin's and the typings' counts (23 styles, 8 curves)", () => {
    expect([...TRANSITION_STYLES]).toEqual([...PLUGIN_STYLES]);
    expect([...TRANSITION_CURVES]).toEqual([...PLUGIN_CURVES]);
    expect([TRANSITION_STYLES.length, TRANSITION_CURVES.length]).toEqual([23, 8]);
  });

  it("forwards each op with its slide ids normalised, and refuses a bad link before Figma is asked", async () => {
    const seen: Array<{ op: string; p: Record<string, unknown> }> = [];
    const tools = registered((op, p) => (seen.push({ op, p }), { ok: true }));
    await tools.figma_move_slides!.handler({ slideIds: ["1-2", "https://www.figma.com/slides/AbC123/Deck?node-id=3-4"], afterSlideId: "5-6" }, extra);
    await tools.figma_set_slide_grid!.handler({ rows: [{ slideIds: ["7-8"], name: "Intro" }] }, extra);
    await tools.figma_set_slide_properties!.handler({ slides: [{ slideId: "9-10", skipped: true }] }, extra);
    await tools.figma_get_slide_grid!.handler({ limit: 10 }, extra);
    expect(seen).toEqual([
      { op: "move_slides", p: { slideIds: ["1:2", "3:4"], afterSlideId: "5:6" } },
      { op: "set_slide_grid", p: { rows: [{ slideIds: ["7:8"], name: "Intro" }] } },
      { op: "set_slide_properties", p: { slides: [{ slideId: "9:10", skipped: true }] } },
      { op: "get_slide_grid", p: { limit: 10 } },
    ]);
    const bad = await tools.figma_set_slide_transition!.handler({ slideIds: ["https://www.figma.com/slides/AbC123/Deck"], style: "NONE", idempotencyKey: "k1" }, extra);
    expect(bad.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true, idempotencyKey: "k1" });
    expect(seen).toHaveLength(4);
    // A batch step names its slides by the same keys, so it is normalised the same way.
    expect(normalizeIdParams({ steps: [{ op: "move_slides", slideIds: ["1-2"], beforeSlideId: "3-4" }] }).params).toEqual({
      steps: [{ op: "move_slides", slideIds: ["1:2"], beforeSlideId: "3:4" }],
    });
    expect(normalizeIdParams({ slides: [{ name: "no id" }] }).params).toEqual({ slides: [{ name: "no id" }] });
  });
});
