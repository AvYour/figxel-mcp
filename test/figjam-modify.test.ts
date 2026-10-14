// The FigJam edit tools, run as plugin ops against a fake board: tables edited
// by { row, column } (a cell has no id [C-135]), connectors changed in place,
// board properties applied per node type, and sections fitted to what they
// hold — with resizeWithoutConstraints only [C-141] and connectors never moved
// by x/y [C-149].

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { OPS } from "../src/shared/ops.js";
import { notBatchable } from "../src/plugin/ops/batch.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { FIGJAM_OPS, planTableEdit } from "../src/plugin/ops/figjam.js";
import { board, BoardFigma, BoardTable, FakeBox, FakeCodeBlock, FakeConnector, FakeSection, FakeShapeWithText, opContext, solid } from "./figjam-fakes.js";

let fake: BoardFigma;
let restore: () => void;

beforeEach(() => {
  ({ fake, restore } = board());
});
afterEach(() => restore());

const run = (op: string, params: Record<string, unknown>, extra: Partial<OpContext> = {}) =>
  FIGJAM_OPS[op]!.run(opContext(params, extra)) as Promise<Record<string, any>>;

async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error("expected the call to be refused");
}

const color = (paints: unknown) => (paints as Array<{ color: { r: number; g: number; b: number } }>)[0]!.color;

// ── figma_edit_table ────────────────────────────────────────────────────────

/** A table whose cells say where they started: "r<row>c<column>". */
async function labelled(rows: number, columns: number): Promise<BoardTable> {
  const t = fake.createTable(rows, columns);
  await fake.loadFontAsync({ family: "Inter", style: "Medium" });
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) t.cellAt(r, c).text.characters = `r${r}c${c}`;
  return t;
}
const grid = (t: BoardTable) => t.rows.map((row) => row.map((cell) => cell.text.characters));

describe("figma_edit_table", () => {
  it("the plan: removals descending, inserts against the table after removals, cells in the final table", () => {
    const plan = planTableEdit({ removeRows: [0, 2], insertRowsAt: [2, 0], insertColumnsAt: [3], cells: [{ row: 3, column: 3, text: "x" }] }, { rows: 4, columns: 3 });
    expect(plan.removeRows).toEqual([2, 0]);
    // After removals 2 rows remain: a row before row 0, and one appended (index 2), which lands at 3 once the first is in.
    expect(plan.insertRows).toEqual([0, 3]);
    expect(plan.insertColumns).toEqual([3]);
    expect([plan.rows, plan.columns]).toEqual([4, 4]);
    expect(plan.cells).toEqual([{ row: 3, column: 3, text: "x" }]);
  });

  it("applies removals, then inserts, then cells, in that order", async () => {
    const t = await labelled(4, 3);
    const r = await run("edit_table", { nodeId: t.id, removeRows: [1], insertRowsAt: [0, 3], cells: [{ row: 0, column: 0, text: "new", fill: "light-yellow" }] });
    expect([r.numRows, r.numColumns]).toEqual([5, 3]);
    expect(grid(t)).toEqual([
      ["new", "", ""],
      ["r0c0", "r0c1", "r0c2"],
      ["r2c0", "r2c1", "r2c2"],
      ["r3c0", "r3c1", "r3c2"],
      ["", "", ""],
    ]);
    expect(color(t.cellAt(0, 0).fills)).toEqual(solid("#FFECBD").color);
    expect(r.cells).toEqual([{ row: 0, column: 0, ok: true }]);
  });

  it("an index out of range — even in a cell after valid removals — is refused before any change", async () => {
    const t = await labelled(3, 2);
    const before = grid(t);
    const out = await refusal(run("edit_table", { nodeId: t.id, removeRows: [7] }));
    expect(out.partial).toEqual({ created: [], failedAt: "removeRows[0]" });
    // Row 2 exists now but not after the removal: the cell is checked against the final table.
    const late = await refusal(run("edit_table", { nodeId: t.id, removeRows: [0], cells: [{ row: 2, column: 0, text: "x" }] }));
    expect(late.partial).toEqual({ created: [], failedAt: "cells[0].row" });
    expect(grid(t)).toEqual(before);
  });

  it("refuses removing every row, an empty fill, a cell that changes nothing, and a non-table", async () => {
    const t = await labelled(2, 2);
    expect((await refusal(run("edit_table", { nodeId: t.id, removeRows: [0, 1] }))).message).toMatch(/every row/);
    const empty = await refusal(run("edit_table", { nodeId: t.id, cells: [{ row: 0, column: 0, fill: "" }] }));
    expect(empty.partial).toEqual({ created: [], failedAt: "cells[0].fill" });
    expect(empty.hint).toMatch(/#FFFFFF/);
    expect((await refusal(run("edit_table", { nodeId: t.id, cells: [{ row: 0, column: 0 }] }))).partial).toEqual({ created: [], failedAt: "cells[0]" });
    expect((await refusal(run("edit_table", { nodeId: t.id }))).message).toMatch(/Nothing to edit/);
    const sticky = fake.createSticky();
    expect((await refusal(run("edit_table", { nodeId: sticky.id, removeRows: [0] }))).message).toMatch(/not a TABLE/);
  });

  it("moves, resizes with the clamp read back, and colours text", async () => {
    const t = await labelled(3, 3);
    const r = await run("edit_table", {
      nodeId: t.id,
      moveRow: { from: 2, to: 0 },
      moveColumn: { from: 0, to: 2 },
      columnWidths: [{ index: 0, width: 10 }, { index: 1, width: 240 }],
      rowHeights: [{ index: 0, height: 64 }],
      cells: [{ row: 1, column: 1, textColor: "violet" }],
    });
    expect(grid(t)[0]).toEqual(["r2c1", "r2c2", "r2c0"]);
    expect(r.columnWidths).toEqual([BoardTable.MIN_COLUMN, 240, 160]);
    expect(t.rowHeights[0]).toBe(64);
    expect(color(t.cellAt(1, 1).text.fills)).toEqual(solid("#9747FF").color);
  });

  it("a text colour alone loads the cell's font before it writes text.fills (create-table.md:244)", async () => {
    const t = fake.createTable(2, 2); // nothing loaded yet
    const r = await run("edit_table", { nodeId: t.id, cells: [{ row: 1, column: 0, textColor: "blue" }] });
    expect(r.cells).toEqual([{ row: 1, column: 0, ok: true }]);
    expect(color(t.cellAt(1, 0).text.fills)).toEqual(solid("#3DADFF").color);
    expect(t.cellAt(1, 0).text.writes).toEqual(["fills"]);
  });

  it("is destructive, so it never runs inside a batch (wired by the integrator: ops.ts DESTRUCTIVE)", () => {
    expect(OPS.get("edit_table")?.destructive).toBe(true);
    expect(notBatchable("edit_table")).toMatch(/destructive/);
  });
});

// ── figma_edit_connectors ───────────────────────────────────────────────────

describe("figma_edit_connectors", () => {
  function line(): FakeConnector {
    const c = fake.createConnector();
    return c;
  }

  it("changes connectors in place and reports per item", async () => {
    const a = fake.createSticky();
    const b = fake.createSticky();
    const c = line();
    const sticky = fake.createSticky();
    const r = await run("edit_connectors", {
      connectors: [
        { nodeId: c.id, from: `${a.id}@right`, to: b.id, color: "violet", dash: "dotted", endCap: "triangle-filled" },
        { nodeId: "404:1", color: "red" },
        { nodeId: sticky.id, color: "red" },
      ],
    });
    expect(r.items).toEqual([
      { id: c.id, ok: true },
      { id: "404:1", ok: false, error: "not found" },
      { id: sticky.id, ok: false, error: "a STICKY, not a CONNECTOR" },
    ]);
    expect(r.updated).toBe(1);
    expect(c.connectorStart).toEqual({ endpointNodeId: a.id, magnet: "RIGHT" });
    expect(c.connectorEnd).toEqual({ endpointNodeId: b.id, magnet: "AUTO" });
    expect(color(c.strokes)).toEqual(solid("#874FFF").color);
    expect([c.dashPattern, c.connectorEndStrokeCap, c.connectorLineType]).toEqual([[2, 4], "TRIANGLE_FILLED", "ELBOWED"]);
  });

  it("an end that names a missing node refuses the whole call before any connector changes", async () => {
    const c1 = line();
    const c2 = line();
    const e = await refusal(run("edit_connectors", { connectors: [{ nodeId: c1.id, color: "red" }, { nodeId: c2.id, to: "999:9" }] }));
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.partial).toEqual({ created: [], failedAt: "connectors[1].to" });
    expect(color(c1.strokes)).toEqual(solid("#757575").color);
    const nothing = await refusal(run("edit_connectors", { connectors: [{ nodeId: c1.id }] }));
    expect(nothing.partial).toEqual({ created: [], failedAt: "connectors[0]" });
  });

  it("a label font that cannot load leaves that connector exactly as it was — no half-applied edit", async () => {
    const c = line();
    fake.unloadable.add("Inter|Medium"); // the label's own font is invalid, and the default will not load either
    const r = await run("edit_connectors", { connectors: [{ nodeId: c.id, color: "red", lineType: "curved", label: "next" }] });
    expect(r.items[0]).toMatchObject({ id: c.id, ok: false });
    expect(r.items[0].error).toMatch(/Inter Medium/);
    expect(color(c.strokes)).toEqual(solid("#757575").color);
    expect(c.connectorLineType).toBe("ELBOWED");
    expect(c.text.characters).toBe("");
  });

  it("a label on a connector whose font will not load gets FigJam's default first [C-148]", async () => {
    const c = line();
    const r = await run("edit_connectors", { connectors: [{ nodeId: c.id, label: "next" }] });
    expect(r.items[0]).toEqual({ id: c.id, ok: true });
    expect(c.text.fontName).toEqual({ family: "Inter", style: "Medium" });
    expect(c.text.characters).toBe("next");
    expect(color(c.text.fills)).toEqual(solid("#1E1E1E").color);
  });
});

// ── figma_set_board_properties ──────────────────────────────────────────────

describe("figma_set_board_properties", () => {
  it("a field that does not apply is an error for that node, which is left unchanged", async () => {
    const sticky = fake.createSticky();
    const conn = fake.createConnector();
    const r = await run("set_board_properties", { nodeIds: [sticky.id, conn.id], color: "blue", wide: true });
    expect(r.items[0]).toEqual({ id: sticky.id, type: "STICKY", ok: true });
    expect(r.items[1]).toMatchObject({ id: conn.id, type: "CONNECTOR", ok: false });
    expect(r.items[1].error).toMatch(/`wide` does not apply to a CONNECTOR/);
    expect(color(sticky.fills)).toEqual(solid("#A8DAFF").color);
    expect(sticky.isWideWidth).toBe(true);
    expect(color(conn.strokes)).toEqual(solid("#757575").color); // not blue
  });

  it("resolves one colour name per node type", async () => {
    const shape = fake.createShapeWithText();
    const table = fake.createTable();
    const conn = fake.createConnector();
    await run("set_board_properties", { nodeIds: [shape.id, table.id, conn.id], color: "red" });
    expect(color((shape as FakeShapeWithText).fills)).toEqual(solid("#FF7556").color);
    expect(color((shape as FakeShapeWithText).strokes)).toEqual(solid("#DC3009").color);
    expect(color((shape as FakeShapeWithText).text.fills)).toEqual(solid("#FFFFFF").color);
    expect(color(table.fills)).toEqual(solid("#F24822").color);
    expect(color(conn.strokes)).toEqual(solid("#FF7556").color);
  });

  it("a section refuses a colour name for now and takes a hex [C-144]", async () => {
    const s = fake.section();
    const named = await run("set_board_properties", { nodeIds: [s.id], color: "light-blue", contentsHidden: true });
    expect(named.items[0].ok).toBe(false);
    expect(named.items[0].error).toMatch(/not a section colour/);
    expect(s.sectionContentsHidden).toBe(false); // nothing written to it
    const hex = await run("set_board_properties", { nodeIds: [s.id], color: "#F5FBFF", contentsHidden: true });
    expect(hex.items[0].ok).toBe(true);
    expect(color(s.fills)).toEqual(solid("#F5FBFF").color);
    expect(s.sectionContentsHidden).toBe(true);
  });

  it("refuses an unknown colour, shape or language once, before any node changes", async () => {
    const sticky = fake.createSticky();
    expect((await refusal(run("set_board_properties", { nodeIds: [sticky.id], color: "blurple" }))).partial).toEqual({ created: [], failedAt: "color" });
    expect((await refusal(run("set_board_properties", { nodeIds: [sticky.id], shape: "blob" }))).partial).toEqual({ created: [], failedAt: "shape" });
    expect((await refusal(run("set_board_properties", { nodeIds: [sticky.id], language: "cobol" }))).partial).toEqual({ created: [], failedAt: "language" });
    expect((await refusal(run("set_board_properties", { nodeIds: [sticky.id] }))).message).toMatch(/Nothing to set/);
    expect(color(sticky.fills)).toEqual(solid("#FFE299").color);
  });

  it("a shape preset's text colour is written with the shape's font loaded first", async () => {
    const shape = fake.createShapeWithText(); // its Inter Medium is not loaded yet
    const r = await run("set_board_properties", { nodeIds: [shape.id], color: "light-teal" });
    expect(r.items[0]).toEqual({ id: shape.id, type: "SHAPE_WITH_TEXT", ok: true });
    expect(color((shape as FakeShapeWithText).text.fills)).toEqual(solid("#1E1E1E").color);
    expect(fake.loaded.has("Inter|Medium")).toBe(true);
  });

  it("reports progress every 50 nodes on a long list", async () => {
    const stickies = Array.from({ length: 120 }, () => fake.createSticky());
    const seen: Array<[number, number | undefined]> = [];
    const r = await run("set_board_properties", { nodeIds: stickies.map((s) => s.id), wide: true }, { progress: (done, total) => void seen.push([done, total]) });
    expect(r.updated).toBe(120);
    expect(seen).toEqual([[50, 120], [100, 120]]);
  });

  it("sets shape types and code languages", async () => {
    const shape = fake.createShapeWithText();
    const code = fake.createCodeBlock();
    const r = await run("set_board_properties", { nodeIds: [shape.id], shape: "eng-database" });
    expect(r.updated).toBe(1);
    expect((shape as FakeShapeWithText).shapeType).toBe("ENG_DATABASE");
    await run("set_board_properties", { nodeIds: [code.id], language: "sql" });
    expect((code as FakeCodeBlock).codeLanguage).toBe("SQL");
  });
});

// ── figma_fit_sections ──────────────────────────────────────────────────────

describe("figma_fit_sections", () => {
  function child(parent: FakeSection, x: number, y: number, w: number, h: number): FakeBox {
    const b = new FakeBox(fake, w, h);
    parent.appendChild(b);
    b.x = x;
    b.y = y;
    return b;
  }

  it("fits inner sections first, so the outer one fits their final size, with resizeWithoutConstraints only [C-141]", async () => {
    const outer = fake.section(100, 100);
    const inner = fake.section(100, 100, outer);
    inner.x = 40;
    inner.y = 40;
    child(inner, 40, 40, 500, 300);
    outer.resizeThrows = true;
    inner.resizeThrows = true;
    const r = await run("fit_sections", { nodeIds: [outer.id, inner.id] });
    expect(r.items.map((i: { ok: boolean }) => i.ok)).toEqual([true, true]);
    expect([inner.width, inner.height]).toEqual([40 + 500 + 32, 40 + 300 + 32]);
    // The outer fit saw the inner one's new size.
    expect([outer.width, outer.height]).toEqual([40 + inner.width + 32, 40 + inner.height + 32]);
    expect([...outer.resizes, ...inner.resizes].every((x) => x.via === "resizeWithoutConstraints")).toBe(true);
  });

  it("moves children only when they reach into the top or left padding, and never a connector [C-149]", async () => {
    const s = fake.section(100, 100);
    const box = child(s, 10, 50, 200, 100);
    const conn = fake.createConnector();
    s.appendChild(conn);
    conn.x = 5;
    conn.y = 5;
    const r = await run("fit_sections", { nodeIds: [s.id], padding: "68,60,100,80" });
    expect(r.items[0]).toMatchObject({ ok: true, shifted: { x: 70, y: 18 } });
    expect([box.x, box.y]).toEqual([80, 68]);
    expect([conn.x, conn.y]).toEqual([5, 5]);
    expect([s.width, s.height]).toEqual([80 + 200 + 60, 68 + 100 + 100]);
  });

  it("leaves an empty section as it is, with a note; honours a minimum; reports a non-section", async () => {
    const empty = fake.section(300, 200);
    const small = fake.section(10, 10);
    child(small, 32, 32, 20, 20);
    const sticky = fake.createSticky();
    const r = await run("fit_sections", { nodeIds: [empty.id, small.id, sticky.id], minWidth: 400 });
    expect(r.items[0]).toMatchObject({ id: empty.id, ok: true, note: "empty; left as it is", width: 300, height: 200 });
    expect(empty.resizes).toEqual([]);
    expect(r.items[1]).toMatchObject({ ok: true, width: 400, height: 32 + 20 + 32 });
    expect(r.items[1].shifted).toBeUndefined();
    expect(r.items[2]).toEqual({ id: sticky.id, ok: false, error: "a STICKY, not a SECTION" });
    expect(r.updated).toBe(1);
  });

  it("refuses a malformed padding before any section changes", async () => {
    const s = fake.section();
    child(s, 0, 0, 10, 10);
    const e = await refusal(run("fit_sections", { nodeIds: [s.id], padding: "1,2" }));
    expect(e.partial).toEqual({ created: [], failedAt: "padding" });
    expect(s.resizes).toEqual([]);
  });

  it("works on a Design file's sections too", async () => {
    restore();
    ({ fake, restore } = board({ editorType: "figma" }));
    const s = fake.section(50, 50);
    child(s, 32, 32, 100, 100);
    const r = await run("fit_sections", { nodeIds: [s.id] });
    expect(r.items[0]).toMatchObject({ ok: true, width: 164, height: 164 });
  });
});

