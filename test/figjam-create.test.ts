// The FigJam create tools, run as plugin ops against a fake board
// (figjam-fakes.ts): stickies, shapes with text, connectors, tables, code
// blocks and link previews — and their server schemas.
//
// What is pinned is what an agent relies on: every check runs before the board
// changes and names the item and field (`partial.failedAt`) [C-096]; a palette
// name lands on the exact swatch hex [C-156]; the two-pass layout never overlaps
// [C-147]; a connector is made in its final parent with its caps written [C-148]
// [C-149]; and no op commits an undo step of its own — the runner does [C-151].

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorsSuffix } from "../src/shared/editors.js";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { fitToText, NON_RECT_SHAPES } from "../src/plugin/figjam/nodes.js";
import { paletteHexes, paletteNameOf, resolveColor, resolveTableColor } from "../src/plugin/figjam/palette.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { FIGJAM_OPS } from "../src/plugin/ops/figjam.js";
import type { Bridge } from "../src/server/bridge.js";
import { createShapeRecorder } from "../src/server/tools/batch.js";
import { FIGJAM_TOOL_OPS, registerFigjam } from "../src/server/tools/figjam.js";
import { fitDescription } from "../src/server/tools/params.js";
import {
  board,
  BoardFigma,
  BoardTable,
  FakeBox,
  FakeConnector,
  FakeShapeWithText,
  FakeSticky,
  opContext,
  solid,
  type FakeNode,
} from "./figjam-fakes.js";

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

const ofType = (type: string) => [...fake.nodes.values()].filter((n) => n.type === type && !n.removed);
const color = (paints: unknown) => (paints as Array<{ color: { r: number; g: number; b: number } }>)[0]!.color;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ── palette ─────────────────────────────────────────────────────────────────

describe("palette", () => {
  it("a name resolves per node type to the exact swatch, as hex/255 [C-156]", () => {
    expect(resolveColor("sticky", "blue", "c").paint.color).toEqual(solid("#A8DAFF").color);
    expect(resolveColor("connector", "blue", "c").paint.color).toEqual(solid("#3DADFF").color);
    expect(resolveColor("text", "Light Violet", "c").paint.color).toEqual(solid("#E4CCFF").color);
    expect(resolveColor("shape", "lightGrey", "c").name).toBe("light-gray");
    // The table red is not the shape red (create-table.md:195 against create-shape-with-text.md:115).
    expect(resolveTableColor("red", "c").fill.color).toEqual(solid("#F24822").color);
    expect(paletteNameOf("sticky", "#ffe299")).toBe("yellow");
    expect(paletteHexes("shape")).toHaveLength(21);
  });

  it("a name this type lacks is refused with this type's nearest names; a section takes a hex only [C-144]", () => {
    expect(() => resolveColor("sticky", "light-blue", "stickies[0].color")).toThrow(/not a sticky colour/);
    let hint: string | undefined;
    try {
      resolveColor("sticky", "bleu", "x");
    } catch (err) {
      hint = (err as BridgeError).hint;
    }
    expect(hint).toMatch(/^Nearest sticky colours: blue/);
    expect(() => resolveColor("section", "light-blue", "color")).toThrow(/not a section colour/);
    expect(resolveColor("section", "#F5FBFF", "color").hex).toBe("#F5FBFF");
  });

  it("a hex table colour gets the text that reads on it", () => {
    expect(resolveTableColor("#111111", "c").text.color).toEqual(solid("#FFFFFF").color);
    expect(resolveTableColor("#F0F0F0", "c").text.color).toEqual(solid("#1E1E1E").color);
  });
});

// ── figma_create_stickies ───────────────────────────────────────────────────

describe("figma_create_stickies", () => {
  it("colour names and hexes land as the exact palette hex; wide is 416", async () => {
    const r = await run("create_stickies", { stickies: [{ text: "Idea", color: "blue" }, { text: "Win", color: "#B3EFBD", wide: true }, { text: "Plain" }] });
    const [a, b, c] = r.created.map((x: { id: string }) => fake.nodes.get(x.id) as FakeSticky);
    expect(color(a!.fills)).toEqual(solid("#A8DAFF").color);
    expect(color(b!.fills)).toEqual(solid("#B3EFBD").color);
    expect(b!.isWideWidth).toBe(true);
    expect(r.created[1].width).toBe(416);
    expect(color(c!.fills)).toEqual(solid("#FFE299").color); // left at FigJam's default
    expect(a!.text.characters).toBe("Idea");
    expect(fake.undoCommits).toBe(0); // the runner commits the one undo step [C-151]
  });

  it("two passes: rows are placed from the real heights, so stickies of mixed length never overlap [C-147]", async () => {
    const long = "word ".repeat(80);
    const r = await run("create_stickies", {
      stickies: [{ text: "a" }, { text: long }, { text: "b" }, { text: "c" }, { text: "d" }, { text: long }],
      columns: 3,
      x: 0,
      y: 0,
    });
    const boxes = r.created as Array<{ x: number; y: number; width: number; height: number }>;
    expect(boxes[1]!.height).toBeGreaterThan(240);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `${i}/${j}`).toBe(false);
    // Row 2 starts below row 1's tallest sticky plus the 64 px gap.
    expect(boxes[3]!.y).toBe(boxes[1]!.height + 64);
    expect(boxes[1]!.x).toBe(240 + 64);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 3 * 240 + 2 * 64, height: boxes[1]!.height + 64 + boxes[5]!.height });
  });

  it("a bad colour at stickies[3] is refused before any sticky exists, naming the field and the nearest names", async () => {
    const e = await refusal(run("create_stickies", { stickies: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d", color: "bleu" }] }));
    expect(e.code).toBe(ErrorCode.INVALID_PARAM);
    expect(e.partial).toEqual({ created: [], failedAt: "stickies[3].color" });
    expect(e.hint).toMatch(/blue/);
    expect(ofType("STICKY")).toEqual([]);
  });

  it("refuses width/height with a pointer to `wide`, and a parent that holds no children", async () => {
    const sized = await refusal(run("create_stickies", { stickies: [{ text: "a", width: 300 }] }));
    expect(sized.partial).toEqual({ created: [], failedAt: "stickies[0].width" });
    expect(sized.hint).toMatch(/wide/);
    const rect = new FakeBox(fake, 100, 100);
    fake.currentPage.appendChild(rect);
    const parent = await refusal(run("create_stickies", { stickies: [{ text: "a" }], parentId: rect.id }));
    expect(parent.code).toBe(ErrorCode.INVALID_PARAM);
    expect(parent.partial).toEqual({ created: [], failedAt: "parentId" });
    expect(ofType("STICKY")).toEqual([]);
  });

  it("a cancel half-way stops with CANCELLED, the ids already made, and failedAt at the first one NOT made", async () => {
    let checks = 0;
    const e = await refusal(run("create_stickies", { stickies: Array.from({ length: 6 }, (_, i) => ({ text: `n${i}` })) }, { isCancelled: () => ++checks >= 2 }));
    expect(e.code).toBe(ErrorCode.CANCELLED);
    const made = (e.partial as { created: string[]; failedAt: string }).created;
    expect(made).toHaveLength(2);
    expect(made.every((id) => fake.nodes.get(id)?.type === "STICKY")).toBe(true);
    // stickies[0] and [1] exist: "continue from failedAt" must not make [1] twice.
    expect((e.partial as { failedAt: string }).failedAt).toBe("stickies[2]");
  });

  it("reports how far the block runs past its section, and never resizes it", async () => {
    const s = fake.section(300, 300);
    const r = await run("create_stickies", { stickies: [{ text: "a" }, { text: "b" }], parentId: s.id });
    expect(r.created.every((c: { id: string }) => fake.nodes.get(c.id)!.parent === s)).toBe(true);
    expect(r.created[0]).toMatchObject({ x: 32, y: 32 }); // inset in an empty parent
    // 32 + 240 + 64 + 240 = 576 against 300 wide; 32 + 240 fits the 300 height.
    expect(r.parentOverflow).toEqual({ right: 276, bottom: 0 });
    expect(r.note).toMatch(/figma_fit_sections/);
    expect(s.resizes).toEqual([]);
    expect(s.width).toBe(300);
  });

  it("with no parent and no x/y the block goes right of the page content; in a parent, below what it holds", async () => {
    const existing = new FakeBox(fake, 500, 200);
    fake.currentPage.appendChild(existing);
    existing.x = 100;
    existing.y = 40;
    const r = await run("create_stickies", { stickies: [{ text: "a" }] });
    expect(r.created[0]).toMatchObject({ x: 100 + 500 + 200, y: 40 });

    const s = fake.section(1200, 1200);
    const title = new FakeBox(fake, 400, 60, "TEXT");
    s.appendChild(title);
    title.x = 80;
    title.y = 68;
    const inSection = await run("create_stickies", { stickies: [{ text: "b" }], parentId: s.id });
    expect(inSection.created[0]).toMatchObject({ x: 80, y: 68 + 60 + 64 });
  });

  it("under an auto-layout parent x/y are refused, and without them the auto-layout places the stickies", async () => {
    const f = fake.frame("HORIZONTAL");
    const e = await refusal(run("create_stickies", { stickies: [{ text: "a" }], parentId: f.id, x: 10 }));
    expect(e.partial).toEqual({ created: [], failedAt: "x" });
    const r = await run("create_stickies", { stickies: [{ text: "a" }], parentId: f.id });
    expect(r.note).toMatch(/auto-layout/);
  });

  it("in a file without createSticky it is UNSUPPORTED before anything exists — the backstop to the gate [C-132]", async () => {
    fake.removed.add("createSticky");
    const e = await refusal(run("create_stickies", { stickies: [{ text: "a" }] }));
    expect(e.code).toBe(ErrorCode.UNSUPPORTED);
    expect(e.message).toMatch(/figma\.createSticky/);
    expect(e.partial).toEqual({ created: [] });
    // A member whose touch throws, as Slides does, is absent too [C-145].
    fake.removed.clear();
    fake.throwing.add("createSticky");
    expect((await refusal(run("create_stickies", { stickies: [{ text: "a" }] }))).code).toBe(ErrorCode.UNSUPPORTED);
  });

  it("a font that will not load is refused while nothing exists [C-147]", async () => {
    fake.unloadable.add("Inter|Medium");
    const e = await refusal(run("create_stickies", { stickies: [{ text: "a" }] }));
    expect(e.code).toBe(ErrorCode.FONT_LOAD_FAILED);
    expect(e.partial).toEqual({ created: [] });
    expect(ofType("STICKY")).toEqual([]);
  });
});

// ── figma_create_shapes_with_text ───────────────────────────────────────────

describe("figma_create_shapes_with_text", () => {
  it("a label is an ELLIPSE of 48 or 64 px with font size 20 [C-163]", async () => {
    const r = await run("create_shapes_with_text", { shapes: [{ shape: "label", text: "1" }, { shape: "label", text: "AB", color: "blue" }] });
    const [one, two] = r.created.map((c: { id: string }) => fake.nodes.get(c.id) as FakeShapeWithText);
    expect([one!.shapeType, one!.width, one!.height, one!.text.fontSize]).toEqual(["ELLIPSE", 48, 48, 20]);
    expect([two!.width, two!.height]).toEqual([64, 64]);
    expect(r.created.map((c: { shape: string; fitted: boolean }) => [c.shape, c.fitted])).toEqual([["label", false], ["label", false]]);
    expect(fake.texts).toEqual([]); // a label is never measured
  });

  it("a third label character is refused before any node — no shape, no measurer", async () => {
    const e = await refusal(run("create_shapes_with_text", { shapes: [{ shape: "rounded-rectangle", text: "ok" }, { shape: "label", text: "123" }] }));
    expect(e.partial).toEqual({ created: [], failedAt: "shapes[1].text" });
    expect(ofType("SHAPE_WITH_TEXT")).toEqual([]);
    expect(fake.texts).toEqual([]);
  });

  it("a preset writes fill, stroke and text colour together; hex fields write only what they name", async () => {
    const r = await run("create_shapes_with_text", { shapes: [{ shape: "diamond", text: "Decide", color: "light-blue" }, { shape: "square", text: "x", fill: "#FFECBD" }] });
    const [a, b] = r.created.map((c: { id: string }) => fake.nodes.get(c.id) as FakeShapeWithText);
    expect(a!.shapeType).toBe("DIAMOND");
    expect(color(a!.fills)).toEqual(solid("#C2E5FF").color);
    expect(color(a!.strokes)).toEqual(solid("#3DADFF").color);
    expect(color(a!.text.fills)).toEqual(solid("#1E1E1E").color);
    expect(color(b!.fills)).toEqual(solid("#FFECBD").color);
    expect(color(b!.strokes)).toEqual(solid("#1E1E1E").color); // untouched default
  });

  it("refuses a preset next to hex fields, and one of width/height without the other", async () => {
    expect((await refusal(run("create_shapes_with_text", { shapes: [{ shape: "square", text: "x", color: "blue", fill: "#000000" }] }))).partial).toEqual({ created: [], failedAt: "shapes[0].color" });
    expect((await refusal(run("create_shapes_with_text", { shapes: [{ shape: "square", text: "x", width: 100 }] }))).partial).toEqual({ created: [], failedAt: "shapes[0].height" });
    expect((await refusal(run("create_shapes_with_text", { shapes: [{ shape: "blob", text: "x" }] }))).partial).toEqual({ created: [], failedAt: "shapes[0].shape" });
  });

  it("fits each shape to its text with one measurer, removed at the end", async () => {
    const r = await run("create_shapes_with_text", {
      shapes: [{ shape: "rounded-rectangle", text: "Start" }, { shape: "rounded-rectangle", text: "A much longer step description ".repeat(6) }, { shape: "square", text: "fixed", width: 90, height: 50 }],
    });
    expect(r.created[0]).toMatchObject({ width: 200, height: 120, fitted: true });
    expect(r.created[1].fitted).toBe(true);
    expect(r.created[1].width).toBeGreaterThan(200);
    expect(r.created[1].width / r.created[1].height).toBeCloseTo(200 / 120, 1);
    expect(r.created[2]).toMatchObject({ width: 90, height: 50, fitted: false });
    expect(fake.texts).toHaveLength(1);
    expect(fake.texts[0]!.removed).toBe(true);
  });

  it("the measurer is removed even when a later shape fails, and the shapes made so far are reported", async () => {
    const original = fake.createShapeWithText.bind(fake);
    let calls = 0;
    (fake as unknown as { createShapeWithText: () => unknown }).createShapeWithText = () => {
      if (++calls === 2) throw new Error("in createShapeWithText: out of memory");
      return original();
    };
    const e = await refusal(run("create_shapes_with_text", { shapes: [{ shape: "square", text: "one" }, { shape: "square", text: "two" }] }));
    expect(e.code).toBe(ErrorCode.INTERNAL);
    const p = e.partial as { created: string[]; failedAt: string };
    expect(p.created).toHaveLength(1);
    expect(p.failedAt).toBe("shapes[1]");
    expect(fake.texts.every((t) => t.removed)).toBe(true);
  });

  it("fitToText follows the official recipe: base 200×120, ×1.6 for non-rectangular types, up to 3× [C-163]", () => {
    expect(fitToText("SQUARE", () => 0)).toEqual({ w: 200, h: 120 });
    expect(fitToText("DIAMOND", () => 0)).toEqual({ w: 320, h: 192 });
    expect(fitToText("SQUARE", () => 1e9)).toEqual({ w: 600, h: 360 });
    expect(NON_RECT_SHAPES.has("ELLIPSE")).toBe(true);
    // The text box a step is checked against: the inner area minus 32 px padding.
    const widths: number[] = [];
    fitToText("SQUARE", (w) => (widths.push(w), 1e9));
    expect(widths[0]).toBe(200 - 64);
    expect(widths[1]).toBe(220 - 64);
  });
});

// ── figma_create_connectors ─────────────────────────────────────────────────

describe("figma_create_connectors", () => {
  function stickyIn(parent: { appendChild(n: FakeNode): void }): FakeSticky {
    const s = fake.createSticky();
    parent.appendChild(s);
    return s;
  }

  it("goes into the lowest section holding both ends, else the page, created there before its ends are set [C-149]", async () => {
    const outer = fake.section(2000, 2000);
    const inner = fake.section(800, 800, outer);
    const a = stickyIn(inner);
    const b = stickyIn(inner);
    const c = stickyIn(outer);
    const loose = stickyIn(fake.currentPage);
    const parentAtEnds: unknown[] = [];
    const original = fake.createConnector.bind(fake);
    (fake as unknown as { createConnector: () => FakeConnector }).createConnector = () => {
      const conn = original();
      let start = conn.connectorStart;
      Object.defineProperty(conn, "connectorStart", {
        get: () => start,
        set: (v) => {
          parentAtEnds.push(conn.parent);
          start = v;
        },
      });
      return conn;
    };
    const r = await run("create_connectors", {
      connectors: [
        { from: a.id, to: b.id },
        { from: a.id, to: `${c.id}@left` },
        { from: a.id, to: loose.id },
        { from: "10,10", to: b.id },
      ],
    });
    expect(r.created.map((x: { parentId: string }) => x.parentId)).toEqual([inner.id, outer.id, fake.currentPage.id, fake.currentPage.id]);
    expect(parentAtEnds).toEqual([inner, outer, fake.currentPage, fake.currentPage]);
    const second = fake.nodes.get(r.created[1].id) as FakeConnector;
    expect(second.connectorEnd).toEqual({ endpointNodeId: c.id, magnet: "LEFT" });
    expect(second.connectorStart).toEqual({ endpointNodeId: a.id, magnet: "AUTO" });
  });

  it("writes the line type and both caps explicitly, defaults included [C-148]", async () => {
    const a = stickyIn(fake.currentPage);
    const b = stickyIn(fake.currentPage);
    const original = fake.createConnector.bind(fake);
    (fake as unknown as { createConnector: () => FakeConnector }).createConnector = () => {
      const conn = original();
      // Whatever Figma's own defaults turn out to be, the tool's are what lands.
      conn.connectorLineType = "CURVED";
      conn.connectorStartStrokeCap = "CIRCLE_FILLED";
      conn.connectorEndStrokeCap = "NONE";
      return conn;
    };
    const r = await run("create_connectors", {
      connectors: [{ from: a.id, to: b.id }, { from: a.id, to: b.id, lineType: "straight", endCap: "erd-many", color: "red", weight: 3, dash: "dashed" }],
    });
    const [d, e] = r.created.map((x: { id: string }) => fake.nodes.get(x.id) as FakeConnector);
    expect([d!.connectorLineType, d!.connectorStartStrokeCap, d!.connectorEndStrokeCap]).toEqual(["ELBOWED", "NONE", "ARROW_LINES"]);
    expect([e!.connectorLineType, e!.connectorEndStrokeCap, e!.strokeWeight, e!.dashPattern]).toEqual(["STRAIGHT", "ERD_MANY", 3, [10, 5]]);
    expect(color(e!.strokes)).toEqual(solid("#FF7556").color);
  });

  it("a label gets FigJam's font first, then its characters, then a visible fill [C-148]", async () => {
    const a = stickyIn(fake.currentPage);
    const b = stickyIn(fake.currentPage);
    const r = await run("create_connectors", { connectors: [{ from: a.id, to: b.id, label: "depends on", labelBackground: "#FFFFFF" }] });
    const conn = fake.nodes.get(r.created[0].id) as FakeConnector;
    expect(conn.text.writes).toEqual(["fontName", "characters", "fills"]);
    expect(conn.text.fontName).toEqual({ family: "Inter", style: "Medium" });
    expect(conn.text.characters).toBe("depends on");
    expect(color(conn.text.fills)).toEqual(solid("#1E1E1E").color);
    expect(color(conn.textBackground.fills)).toEqual(solid("#FFFFFF").color);
  });

  it("an end on a missing node, on a connector, or in a bad form is refused with nothing created", async () => {
    const a = stickyIn(fake.currentPage);
    const missing = await refusal(run("create_connectors", { connectors: [{ from: a.id, to: "999:1" }] }));
    expect(missing.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(missing.partial).toEqual({ created: [], failedAt: "connectors[0].to" });
    const line = fake.createConnector();
    const onConnector = await refusal(run("create_connectors", { connectors: [{ from: a.id, to: line.id }] }));
    expect(onConnector.partial).toEqual({ created: [], failedAt: "connectors[0].to" });
    expect(onConnector.message).toMatch(/is a connector/);
    const bad = await refusal(run("create_connectors", { connectors: [{ from: `${a.id}@north`, to: a.id }] }));
    expect(bad.partial).toEqual({ created: [], failedAt: "connectors[0].from" });
    expect(ofType("CONNECTOR")).toEqual([line]);
  });

  it("refuses an auto-layout parentId, which would move the connector as one of its items [C-149]", async () => {
    const a = stickyIn(fake.currentPage);
    const b = stickyIn(fake.currentPage);
    const f = fake.frame("VERTICAL");
    const e = await refusal(run("create_connectors", { connectors: [{ from: a.id, to: b.id }], parentId: f.id }));
    expect(e.partial).toEqual({ created: [], failedAt: "parentId" });
    expect(e.message).toMatch(/auto-layout/);
    expect(ofType("CONNECTOR")).toEqual([]);
    // A plain frame is a parent like any other.
    const plain = fake.frame("NONE");
    const r = await run("create_connectors", { connectors: [{ from: a.id, to: b.id }], parentId: plain.id });
    expect(r.created[0].parentId).toBe(plain.id);
  });

  it("ids in the URL form are normalised inside the endpoint string", async () => {
    const a = stickyIn(fake.currentPage);
    const b = stickyIn(fake.currentPage);
    const r = await run("create_connectors", { connectors: [{ from: a.id.replace(":", "-"), to: `${b.id.replace(":", "-")}@0.5,1` }] });
    const conn = fake.nodes.get(r.created[0].id) as FakeConnector;
    expect(conn.connectorStart).toEqual({ endpointNodeId: a.id, magnet: "AUTO" });
    expect(conn.connectorEnd).toEqual({ endpointNodeId: b.id, position: { x: 0.5, y: 1 } });
  });
});

// ── figma_create_table ──────────────────────────────────────────────────────

describe("figma_create_table", () => {
  it("refuses both forms together, neither, and rows of different lengths", async () => {
    expect((await refusal(run("create_table", { rows: [["a"]], numRows: 2, numColumns: 2 }))).partial).toEqual({ created: [], failedAt: "numRows" });
    expect((await refusal(run("create_table", {}))).partial).toEqual({ created: [], failedAt: "rows" });
    const ragged = await refusal(run("create_table", { rows: [["a", "b"], ["c"]] }));
    expect(ragged.partial).toEqual({ created: [], failedAt: "rows[1]" });
    expect(ofType("TABLE")).toEqual([]);
  });

  it("styles a dark header over the data and leaves the body cells alone", async () => {
    const r = await run("create_table", { rows: [["Name", "Role"], ["Ada", "Engineer"]] });
    const t = fake.nodes.get(r.id) as BoardTable;
    expect([r.numRows, r.numColumns]).toEqual([2, 2]);
    expect(color(t.cellAt(0, 0).fills)).toEqual(solid("#1E1E1E").color);
    expect(color(t.cellAt(0, 1).text.fills)).toEqual(solid("#FFFFFF").color);
    expect(t.cellAt(1, 0).fills).toEqual([]);
    expect(t.cellAt(1, 1).text.characters).toBe("Engineer");
  });

  it("reads the column widths back, because a column clamps to its minimum [C-161]", async () => {
    const r = await run("create_table", { numRows: 2, numColumns: 2, columnWidths: [40, 200], headerColor: "light-violet" });
    expect(r.columnWidths).toEqual([BoardTable.MIN_COLUMN, 200]);
    const t = fake.nodes.get(r.id) as BoardTable;
    expect(color(t.cellAt(0, 0).fills)).toEqual(solid("#DCCCFF").color);
  });

  it("an empty table's header text colour is written with its font loaded first (create-table.md:244)", async () => {
    // The fake throws on text.fills with an unloaded font, as the official recipe implies.
    const r = await run("create_table", { numRows: 2, numColumns: 2, header: true });
    const t = fake.nodes.get(r.id) as BoardTable;
    expect(color(t.cellAt(0, 1).text.fills)).toEqual(solid("#FFFFFF").color);
    expect(t.cellAt(0, 1).text.characters).toBe("");
    expect(fake.loaded.has("Inter|Medium")).toBe(true);
  });

  it("an empty table gets no text: no placeholder content [C-163]", async () => {
    const r = await run("create_table", { numRows: 3, numColumns: 2 });
    const t = fake.nodes.get(r.id) as BoardTable;
    for (const row of t.rows) for (const cell of row) expect(cell.text.writes).toEqual([]);
    expect(t.cellAt(0, 0).fills).toEqual([]); // no header unless asked for
  });

  it("refuses an empty fill and points at white", async () => {
    const e = await refusal(run("create_table", { numRows: 1, numColumns: 1, fill: "" }));
    expect(e.partial).toEqual({ created: [], failedAt: "fill" });
    expect(e.hint).toMatch(/#FFFFFF/);
  });
});

// ── figma_create_code_block ─────────────────────────────────────────────────

describe("figma_create_code_block", () => {
  it("takes a language in any case and refuses an unknown one rather than showing plain text", async () => {
    const r = await run("create_code_block", { code: "const a = 1", language: "TypeScript" });
    expect(r.language).toBe("typescript");
    expect((fake.nodes.get(r.id) as unknown as { codeLanguage: string }).codeLanguage).toBe("TYPESCRIPT");
    const e = await refusal(run("create_code_block", { code: "PROCEDURE DIVISION.", language: "cobol" }));
    expect(e.partial).toEqual({ created: [], failedAt: "language" });
    expect(ofType("CODE_BLOCK")).toHaveLength(1);
  });

  it("defaults to plaintext, and flags dart as unconfirmed [C-143]", async () => {
    expect((await run("create_code_block", { code: "x" })).language).toBe("plaintext");
    const dart = await run("create_code_block", { code: "void main() {}", language: "dart" });
    expect(dart.note).toMatch(/not yet confirmed/);
  });
});

// ── figma_create_link_preview ───────────────────────────────────────────────

describe("figma_create_link_preview", () => {
  it("refuses a non-https link, and a bad parent, before Figma fetches anything", async () => {
    expect((await refusal(run("create_link_preview", { url: "http://example.com" }))).partial).toEqual({ created: [], failedAt: "url" });
    expect((await refusal(run("create_link_preview", { url: "https://example.com", parentId: "404:1" }))).partial).toEqual({ created: [], failedAt: "parentId" });
    expect(fake.previewCalls).toEqual([]);
  });

  it("places an embed in its parent and reports what Figma read", async () => {
    fake.preview = { kind: "EMBED" };
    const s = fake.section();
    const r = await run("create_link_preview", { url: "https://www.youtube.com/watch?v=1", parentId: s.id, x: 40, y: 40 });
    expect(r).toMatchObject({ type: "EMBED", title: "A video", provider: "YouTube" });
    const node = fake.nodes.get(r.id)!;
    expect(node.parent).toBe(s);
    expect([node.x, node.y]).toEqual([40, 40]);
  });

  it("a preview Figma refuses is reported in Figma's words; nothing is claimed unchanged unless the page is [C-162]", async () => {
    fake.preview = { error: "Could not resolve host" };
    const clean = await refusal(run("create_link_preview", { url: "https://nowhere.invalid" }));
    expect(clean.message).toMatch(/Could not resolve host/);
    expect(clean.partial).toEqual({ created: [], failedAt: "url" });

    fake.preview = { error: "Timed out", leaveNode: true };
    const messy = await refusal(run("create_link_preview", { url: "https://slow.example" }));
    expect((messy.partial as { created: string[] }).created).toHaveLength(1);
  });
});

// ── the server schemas ──────────────────────────────────────────────────────

// The subset test/schema-portability.test.ts enforces on registered tools,
// copied here because these are not in the catalog until the integrator wires
// them. `$schema` is left out: mcp.ts strips the dialect on the wire, and this
// server is bare.
const FORBIDDEN = new Set([
  "$ref", "$defs", "definitions", "$id", "anyOf", "oneOf", "allOf", "not", "if", "then", "else",
  "const", "format", "patternProperties", "propertyNames", "dependentSchemas", "dependentRequired",
  "unevaluatedProperties", "contains", "prefixItems",
]);
const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);
function problems(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: not an object schema`];
  const s = schema as Record<string, unknown>;
  const out = Object.keys(s).filter((k) => FORBIDDEN.has(k)).map((k) => `${path}: uses "${k}"`);
  if (typeof s.type !== "string" || !TYPES.has(s.type)) out.push(`${path}: "type" must be one of ${[...TYPES].join("/")}`);
  if (s.type === "object") {
    if (!s.properties || typeof s.properties !== "object") out.push(`${path}: object without "properties"`);
    else for (const [k, v] of Object.entries(s.properties)) out.push(...problems(v, `${path}.${k}`));
  }
  if (s.type === "array") out.push(...(s.items ? problems(s.items, `${path}[]`) : [`${path}: array without items`]));
  return out;
}

describe("the board tools' schemas", () => {
  const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
  const bridge = {
    request: async (op: string, params: Record<string, unknown>) => {
      forwarded.push({ op, params });
      return { ok: true };
    },
    statusAsync: async () => ({ sessions: [] }),
  } as unknown as Bridge;

  async function connected(strict: boolean): Promise<Client> {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    // As tools/index.ts does: the recorder makes every top-level shape strict and appends the Editors sentence.
    if (strict) createShapeRecorder(server);
    registerFigjam(server, bridge, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "figjam-schema", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("register all ten, portable, with descriptions that stay whole once the Editors sentence is added", async () => {
    const client = await connected(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(FIGJAM_TOOL_OPS.map((op) => `figma_${op}`).sort());
    for (const t of tools) {
      expect(problems(t.inputSchema, t.name)).toEqual([]);
      const op = t.name.slice("figma_".length);
      // Until editors.ts has its row the suffix is the longest one ("unverified in Design, FigJam, Slides").
      const suffix = editorsSuffix(op);
      expect(fitDescription(t.description!, 1024 - suffix.length), t.name).toBe(t.description);
      expect(Object.keys((t.inputSchema as { properties: object }).properties), t.name).toEqual(expect.arrayContaining(["idempotencyKey", "session"]));
    }
    await client.close();
  });

  it("unions travel as single strings: an endpoint, a dash, a padding, a weight", async () => {
    const client = await connected(false);
    const { tools } = await client.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any> }).properties;
    const item = props("figma_create_connectors").connectors.items.properties;
    expect([item.from.type, item.to.type, item.dash.type, item.startCap.type]).toEqual(["string", "string", "string", "string"]);
    expect(props("figma_fit_sections").padding.type).toBe("string");
    expect(props("figma_create_table").weight.type).toBe("string");
    await client.close();
  });

  it("refuses a sticky's width and an array past its cap before anything is forwarded", async () => {
    forwarded.length = 0;
    const client = await connected(true);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    const sized = await call("figma_create_stickies", { stickies: [{ text: "a", width: 300 }] });
    expect(sized.isError).toBe(true);
    const many = await call("figma_create_stickies", { stickies: Array.from({ length: 201 }, () => ({ text: "a" })) });
    expect(many.isError).toBe(true);
    const stray = await call("figma_fit_sections", { nodeIds: ["1:2"], paddding: "32" });
    expect(stray.isError).toBe(true);
    expect(forwarded).toEqual([]);

    const ok = await call("figma_create_stickies", { stickies: [{ text: "a", color: "blue" }], idempotencyKey: "retro-1" });
    expect(ok.isError).toBeFalsy();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.op).toBe("create_stickies");
    await client.close();
  });
});
