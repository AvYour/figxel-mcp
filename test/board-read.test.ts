// Reading a FigJam board: a sticky's text, a shape's type, a connector's ends
// and label, a table's cells, a code block, the board's graph — in the words
// the write tools take [C-135]. Before this a board read as nameless boxes:
// design context read text only off TEXT nodes, the text scan matched TEXT
// only, and a TABLE (no children) was a leaf with nothing in it.
//
// The fakes (test/editor-fakes.ts) follow the typings; makeOpaque() makes a
// member throw on read, the way a missing one may outside Figma Design [C-145].

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseEndpoint } from "../src/shared/figjam.js";
import { buildContext, type ContextNode } from "../src/plugin/context.js";
import { READ_KEYS, guardAll, idOrder, readView } from "../src/plugin/board-read.js";
import { checkLayout } from "../src/plugin/ops/check.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import { toDto } from "../src/plugin/read.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { registerTools } from "../src/server/tools/index.js";
import {
  FakeConnector,
  FakeContainer,
  FakeFigma,
  FakeNode,
  FakeSticky,
  installFigma,
  makeOpaque,
  opContext,
  solid,
} from "./editor-fakes.js";

type Any = Record<string, unknown>;
const run = async (op: string, params: Any = {}) => (await READ_OPS[op]!.run(opContext(params))) as Any;
const root = (r: Any) => r.root as ContextNode & Any;

let fake: FakeFigma;
let restore: () => void;
beforeEach(() => {
  fake = new FakeFigma({ editorType: "figjam", fileName: "Retro board" });
  restore = installFigma(fake);
});
afterEach(() => restore());

function sticky(text: string, opts: { wide?: boolean; authorVisible?: boolean } = {}): FakeSticky {
  const s = fake.createSticky();
  s.text.characters = text;
  s.isWideWidth = opts.wide ?? false;
  s.authorVisible = opts.authorVisible ?? false;
  return s;
}

describe("stickies", () => {
  it("read back their text, width and author — the author only where the board shows it", async () => {
    const shown = sticky("Ship the beta", { wide: true, authorVisible: true });
    const hidden = sticky("Fix onboarding");
    const a = root(await run("get_design_context", { nodeId: shown.id }));
    expect((a.text as Any).characters).toBe("Ship the beta");
    expect((a.text as Any).font).toBe("Inter Medium");
    expect(a.sticky).toEqual({ wide: true, authorVisible: true, author: "Ada Lovelace" });
    expect(a.width).toBe(416);
    const b = root(await run("get_design_context", { nodeId: hidden.id }));
    expect(b.sticky).toEqual({ wide: false, authorVisible: false });
  });

  it("a cut sublayer text counts in textNote, with its full length", async () => {
    const s = sticky("A long retro note that runs on");
    const r = await run("get_design_context", { nodeId: s.id, maxTextChars: 6 });
    expect(root(r).text).toMatchObject({ characters: "A long…", length: 30 });
    expect(r.textNote).toMatch(/^1 text node\(s\) were cut at maxTextChars=6/);
  });

  it("are read even where every member a sticky lacks throws [C-145]", async () => {
    const s = makeOpaque(sticky("Still readable"), ["layoutMode", "effects", "strokes", "clipsContent", "cornerRadius", "constraints"]);
    expect(root(await run("get_design_context", { nodeId: s.id })).text).toMatchObject({ characters: "Still readable" });
    expect(((await run("get_node", { nodeId: s.id })).node as Any).text).toBe("Still readable");
    const check = await checkLayout(s as never, 100, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(check.checked).toBe(1);
  });
});

describe("shapes with text", () => {
  it("come back with their shape type in kebab case, the spelling the writes take", async () => {
    const sh = fake.createShapeWithText();
    sh.shapeType = "ROUNDED_RECTANGLE";
    sh.text.characters = "Decide";
    const r = root(await run("get_design_context", { nodeId: sh.id }));
    expect(r.shape).toEqual({ type: "rounded-rectangle" });
    expect((r.text as Any).characters).toBe("Decide");
    expect((await run("get_node", { nodeId: sh.id })).node).toMatchObject({ text: "Decide", shapeType: "rounded-rectangle" });
  });
});

describe("connectors", () => {
  it("read their endpoints back in the exact grammar a connector write takes", async () => {
    const a = sticky("A");
    const b = sticky("B");
    const ends = [
      { endpointNodeId: a.id, magnet: "RIGHT" },
      { endpointNodeId: b.id, position: { x: 0.5, y: 1 } },
      { position: { x: 120, y: 340 } },
      { endpointNodeId: a.id, magnet: "AUTO" },
    ];
    for (const [start, end] of [[ends[0], ends[1]], [ends[2], ends[3]]] as const) {
      const c = fake.createConnector();
      c.connectorStart = start as never;
      c.connectorEnd = end as never;
      const conn = root(await run("get_design_context", { nodeId: c.id })).connector as Any;
      // Round trip: the string read is the string a write takes, and it parses to what Figma holds.
      expect(parseEndpoint(conn.from, "from")).toEqual(start);
      expect(parseEndpoint(conn.to, "to")).toEqual(end);
    }
  });

  it("a label with no paint reads labelVisible: false; the name is kept, and a label in the name is said to be there", async () => {
    const c = fake.createConnector();
    c.text.characters = "approves"; // a new connector's label fills are [] [C-148]
    const r = root(await run("get_design_context", { nodeId: c.id }));
    expect(r.name).toBe("Connector line");
    expect(r.connector).toMatchObject({ label: "approves", labelVisible: false, lineType: "elbowed", startCap: "none", endCap: "arrow-lines", weight: 2 });
    expect((r.connector as Any).dash).toBeUndefined(); // solid
    c.text.fills = [solid("#1E1E1E")];
    c.dashPattern = [10, 6];
    const shown = root(await run("get_design_context", { nodeId: c.id })).connector as Any;
    expect(shown).toMatchObject({ labelVisible: true, dash: "10,6" });

    const named = fake.createConnector();
    named.name = "on approval";
    const n = root(await run("get_design_context", { nodeId: named.id }));
    expect((n.connector as Any).labelNote).toMatch(/layer name \("on approval"\)/);
    expect(n.text).toBeUndefined(); // no label, so no font block from a font that does not load
  });

  it("the edge list is ordered by id, names endpoints from the walk, and looks each outside one up once", async () => {
    const zone = fake.createSection();
    const named = (name: string) => Object.assign(sticky(name), { name });
    const [a, b, outside] = [named("A"), named("B"), named("Elsewhere")];
    zone.appendChild(a);
    zone.appendChild(b);
    const made: FakeConnector[] = [];
    for (const [from, to] of [[a, b], [a, outside], [b, outside]] as const) {
      const c = fake.createConnector();
      c.connectorStart = { endpointNodeId: from.id, magnet: "AUTO" };
      c.connectorEnd = { endpointNodeId: to.id, magnet: "AUTO" };
      made.push(c);
    }
    const gone = fake.createConnector();
    gone.connectorStart = { endpointNodeId: a.id, magnet: "AUTO" };
    gone.connectorEnd = { endpointNodeId: "90:99999", magnet: "AUTO" };
    // Appended in reverse: the walk meets them out of id order.
    for (const c of [gone, ...made].reverse()) zone.appendChild(c);

    const lookups: string[] = [];
    const get = fake.getNodeByIdAsync.bind(fake);
    fake.getNodeByIdAsync = async (id: string) => {
      lookups.push(id);
      return get(id);
    };
    const r = await run("get_design_context", { nodeId: zone.id });
    const edges = r.connectors as Any[];
    expect(edges.map((e) => e.id)).toEqual([...made, gone].map((c) => c.id).sort(idOrder));
    expect(edges[0]).toMatchObject({ from: a.id, to: b.id, fromName: "A", toName: "B" });
    expect(edges[0]!.outside).toBeUndefined();
    expect(edges[1]).toMatchObject({ toName: "Elsewhere", outside: ["to"] });
    expect(edges.find((e) => e.id === gone.id)).toMatchObject({ missing: ["to"] });
    // One lookup for the section itself (nodeId), one per endpoint outside the read.
    expect(lookups.filter((id) => id === outside.id)).toHaveLength(1);
    expect(lookups.filter((id) => id === a.id || id === b.id)).toHaveLength(0);
  });
});

describe("tables", () => {
  it("come back row-major through cellAt, and are never walked as children", async () => {
    const t = fake.createTable(3, 4);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) t.cellAt(r, c).text.characters = `r${r}c${c}`;
    t.cellAt(0, 0).fills = [solid("#E3E3E3")];
    const r = root(await run("get_design_context", { nodeId: t.id }));
    expect(r.table).toEqual({
      rows: 3,
      columns: 4,
      cells: [0, 1, 2].map((row) => [0, 1, 2, 3].map((col) => `r${row}c${col}`)),
      headerFill: "#e3e3e3",
    });
    expect(r.children).toBeUndefined();
    expect(r.childCount).toBeUndefined();
    expect((await run("get_node", { nodeId: t.id })).node).toMatchObject({ table: { rows: 3, columns: 4 } });
  });

  it("a 50 × 50 table at maxTableCells 500 is cut, and says so", async () => {
    const t = fake.createTable(50, 50);
    const r = await run("get_design_context", { nodeId: t.id, maxTableCells: 500 });
    const table = root(r).table as { cells: string[][]; cellsShown: number };
    expect(table.cellsShown).toBe(500);
    expect(table.cells).toHaveLength(10);
    expect(r.tableNote).toMatch(/^1 table\(s\) were cut at maxTableCells=500/);
  });
});

describe("code blocks", () => {
  it("are cut at maxTextChars like any text", async () => {
    const cb = fake.createCodeBlock();
    cb.code = "const a = 1;\nconst b = 2;\n" + "x".repeat(40);
    cb.codeLanguage = "TYPESCRIPT";
    const r = await run("get_design_context", { nodeId: cb.id, maxTextChars: 10 });
    expect(root(r).code).toEqual({ language: "typescript", text: "const a = …", lines: 3, length: 66 });
    expect(r.textNote).toBeDefined();
  });
});

describe("the node DTO", () => {
  it("previews FigJam types, with or without geometry", async () => {
    const s = sticky("x".repeat(250));
    const dto = (await run("get_node", { nodeId: s.id, includeGeometry: false })).node as Any;
    expect(dto).toMatchObject({ id: s.id, type: "STICKY", textLength: 250 });
    expect((dto.text as string).length).toBe(201);
    const scan = await run("scan_nodes_by_types", { types: ["STICKY"] });
    expect((scan.nodes as Any[])[0]).toMatchObject({ text: expect.stringMatching(/^x+…$/) });
  });

  it("a Design TEXT DTO is byte-identical to before: no figma global, and a Design file", () => {
    const text = {
      id: "1:2", name: "Title", type: "TEXT", characters: "Hello", fontSize: 16, x: 10, y: 20, width: 120, height: 24,
      fills: [solid("#000000")], opacity: 1, visible: true, locked: false, textAutoResize: "WIDTH_AND_HEIGHT",
    };
    const before = '{"id":"1:2","name":"Title","type":"TEXT","width":120,"height":24,"x":10,"y":20,"fill":"#000000"}';
    restore();
    expect(JSON.stringify(toDto(text as never, 0, 50, true))).toBe(before);
    expect(JSON.stringify(toDto(text as never, 0))).toBe('{"id":"1:2","name":"Title","type":"TEXT"}');
    restore = installFigma(new FakeFigma({ editorType: "figma" }));
    expect(guardAll()).toBe(false);
    expect(JSON.stringify(toDto(text as never, 0, 50, true))).toBe(before);
  });
});

describe("figma_scan_text_nodes over a board", () => {
  it("lists every holder, one item per non-empty table cell, and no unlabelled connector", async () => {
    const zone = fake.createSection();
    const s = sticky("Idea");
    const t = fake.createTable(2, 2);
    t.cellAt(0, 1).text.characters = "B1";
    t.cellAt(1, 0).text.characters = "A2";
    const quiet = fake.createConnector();
    const labelled = fake.createConnector();
    labelled.text.characters = "yes";
    const cb = fake.createCodeBlock();
    cb.code = "print(1)";
    cb.codeLanguage = "PYTHON";
    for (const n of [s, t, quiet, labelled, cb]) zone.appendChild(n);
    const r = await run("scan_text_nodes", { nodeId: zone.id });
    expect(r.nodes).toEqual([
      { id: s.id, name: "Sticky", type: "STICKY", characters: "Idea", characterCount: 4 },
      { id: t.id, name: "Table", type: "TABLE", characters: "B1", characterCount: 2, cell: { row: 0, column: 1 } },
      { id: t.id, name: "Table", type: "TABLE", characters: "A2", characterCount: 2, cell: { row: 1, column: 0 } },
      { id: labelled.id, name: "Connector line", type: "CONNECTOR", characters: "yes", characterCount: 3, labelVisible: false },
      { id: cb.id, name: "Code block", type: "CODE_BLOCK", characters: "print(1)", characterCount: 8, language: "python" },
    ]);
    expect(quiet.text.characters).toBe("");
    const only = await run("scan_text_nodes", { nodeId: zone.id, types: ["sticky"] });
    expect((only.nodes as Any[]).map((n) => n.type)).toEqual(["STICKY"]);
    await expect(run("scan_text_nodes", { nodeId: zone.id, types: ["STICKY", "FRAME"] })).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("a 200-cell table at limit 50 comes back in 4 pages, each cell exactly once", async () => {
    const t = fake.createTable(20, 10);
    for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) t.cellAt(r, c).text.characters = `${r}:${c}`;
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const r = await run("scan_text_nodes", { nodeId: t.id, limit: 50, ...(cursor ? { cursor } : {}) });
      calls++;
      seen.push(...(r.nodes as Array<{ characters: string }>).map((n) => n.characters));
      cursor = r.nextCursor as string | undefined;
    } while (cursor && calls < 10);
    expect(calls).toBe(4);
    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
  });

  it("refuses a cursor from the node-counting scan (v1) instead of resuming at a shifted offset", async () => {
    const t = fake.createTable(2, 2);
    const v1 = btoa(`${encodeURIComponent(`scan_text:${t.id}`)}|1`).replace(/=+$/, "");
    await expect(run("scan_text_nodes", { nodeId: t.id, cursor: v1 })).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });
});

describe("figma_search_nodes { text }", () => {
  it("finds a sticky by what it says, and a table by a cell, naming the cell", async () => {
    const s = sticky("Migrate billing");
    s.name = "Sticky";
    const t = fake.createTable(2, 3);
    t.cellAt(1, 2).text.characters = "billing owner";
    sticky("Unrelated");
    const r = await run("search_nodes", { text: "BILLING" });
    expect((r.nodes as Any[]).map((n) => [n.id, n.cell])).toEqual([
      [s.id, undefined],
      [t.id, { row: 1, column: 2 }],
    ]);
    expect(r.text).toBe("BILLING");
    const both = await run("search_nodes", { text: "billing", type: "TABLE" });
    expect((both.nodes as Any[]).map((n) => n.id)).toEqual([t.id]);
  });
});

describe("figma_get_metadata on a board", () => {
  it("outlines the top-level sections and counts each node type", async () => {
    const zone = fake.createSection();
    zone.name = "Ideas";
    zone.appendChild(sticky("1"));
    zone.appendChild(sticky("2"));
    fake.createConnector();
    const r = await run("get_metadata");
    expect(r.editorType).toBe("figjam");
    expect(r.board).toEqual({
      sections: [{ id: zone.id, name: "Ideas", childCount: 2 }],
      counts: { SECTION: 1, STICKY: 2, CONNECTOR: 1 },
    });
  });
});

describe("figma_get_fonts on a board", () => {
  it("counts the fonts of sublayer text and table cells; an empty sublayer is not counted", async () => {
    sticky("Hello");
    sticky("");
    const t = fake.createTable(1, 2);
    t.cellAt(0, 0).text.characters = "cell";
    fake.createConnector(); // no label: its font is not even loadable [C-148]
    const r = await run("get_fonts");
    expect(r.fonts).toEqual([{ family: "Inter", style: "Medium", nodeCount: 2 }]);
  });
});

describe("the guarded view", () => {
  // Every member a Design read touches must be one the view exposes; else a
  // FigJam or Slides read would silently lose that field.
  it("exposes every member design context, the DTO and check_layout read", async () => {
    const touched = new Set<string>();
    const record = <T extends object>(o: T): T =>
      new Proxy(o, {
        get(t, k, r) {
          if (typeof k === "string") touched.add(k);
          return Reflect.get(t, k, r);
        },
        has(t, k) {
          if (typeof k === "string") touched.add(k);
          return Reflect.has(t, k);
        },
      });
    const ink = [solid("#111111")];
    const text = record({
      id: "5:3", name: "Label", type: "TEXT", characters: "Buy", fontName: { family: "Inter", style: "Bold" }, fontSize: 16,
      fontWeight: 700, fills: ink, textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "CENTER", hyperlink: null,
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, x: 16, y: 8, width: 40, height: 20,
      absoluteBoundingBox: { x: 16, y: 8, width: 40, height: 20 }, absoluteRenderBounds: { x: 16, y: 10, width: 38, height: 16 },
      getStyledTextSegments: () => [{ start: 0, end: 3, characters: "Buy", fontName: { family: "Inter", style: "Bold" }, fills: ink }],
    }) as Any;
    const inst = record({
      id: "5:4", name: "Icon", type: "INSTANCE", x: 0, y: 0, width: 24, height: 24, fills: [],
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 }, componentProperties: {},
      getMainComponentAsync: async () => ({ id: "9:1", name: "Icon/Cart", key: "k", parent: null }),
    }) as Any;
    const frame = record({
      id: "5:2", name: "Button", type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: 8, paddingRight: 16,
      paddingBottom: 8, paddingLeft: 16, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", cornerRadius: 8, fills: [solid("#2563EB")],
      strokes: [solid("#1D4ED8")], strokeWeight: 1, strokeAlign: "INSIDE", effects: [], clipsContent: true, opacity: 1,
      x: 0, y: 0, width: 96, height: 36, absoluteBoundingBox: { x: 0, y: 0, width: 96, height: 36 }, constraints: { horizontal: "MIN", vertical: "MIN" },
      boundVariables: {}, fillStyleId: "", children: [inst, text],
    }) as Any;
    inst.parent = frame;
    text.parent = frame;
    restore();
    (globalThis as { figma?: unknown }).figma = { getStyleByIdAsync: async () => null, variables: {} };
    try {
      await buildContext([frame as never], { depth: 4, maxNodes: 50, maxChildren: 50, includeGeometry: true, includeStyles: true, includeVariables: true, includeAnnotations: true, absolute: true }, { yieldToHost: async () => {}, isCancelled: () => false });
      toDto(frame as never, 2, 50, true);
      await checkLayout(frame as never, 100, { yieldToHost: async () => {}, isCancelled: () => false }, { audit: new Set(["tokens", "fonts", "board"]) });
    } finally {
      delete (globalThis as { figma?: unknown }).figma;
      restore = installFigma(fake);
    }
    const keys = new Set<string>(READ_KEYS);
    for (const k of ["layoutMode", "characters", "absoluteRenderBounds", "getMainComponentAsync", "inferredVariables"]) expect(touched).toContain(k);
    expect([...touched].filter((k) => !keys.has(k))).toEqual([]);
  });

  it("turns a throwing member into undefined and keeps methods bound to the node", () => {
    const node = new FakeNode("STICKY");
    const view = readView(makeOpaque(node, ["fills"]), true);
    expect(view.fills).toBeUndefined();
    expect(view.id).toBe(node.id);
    const holder = new FakeContainer("FRAME");
    const bound = readView(Object.assign(holder, { findAllWithCriteria(this: FakeContainer) { return this.children; } }), true);
    expect((bound.findAllWithCriteria as () => unknown[])()).toBe(holder.children);
  });
});

// ── the schemas, through a real MCP client ──────────────────────────────────

describe("the read schemas", () => {
  const forwarded: Array<{ op: string; params: Any }> = [];
  const bridge = {
    request: async (op: string, params: Any) => {
      forwarded.push({ op, params });
      return {};
    },
    statusAsync: async () => ({ sessions: [] }),
    status: () => ({ sessions: [] }),
  } as unknown as Bridge;
  let client: Client;
  beforeAll(async () => {
    const server = new McpServer({ name: "board-read", version: "0" });
    registerTools(server, bridge, loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-board-")), BRIDGE_PORT: "0" }), Date.now());
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "board-read", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  const call = async (name: string, args: Any) => (await client.callTool({ name, arguments: args })) as { isError?: boolean };

  it("take the new parameters and refuse what is not one", async () => {
    forwarded.length = 0;
    expect((await call("figma_get_design_context", { maxTableCells: 800, absolute: true })).isError).toBeFalsy();
    expect((await call("figma_scan_text_nodes", { types: ["STICKY", "TABLE"] })).isError).toBeFalsy();
    expect((await call("figma_search_nodes", { text: "billing" })).isError).toBeFalsy();
    expect((await call("figma_check_layout", { nodeIds: ["1:2", "1-3"], audit: ["board"] })).isError).toBeFalsy();
    expect(forwarded.map((f) => f.op)).toEqual(["get_design_context", "scan_text_nodes", "search_nodes", "check_layout"]);
    expect(forwarded[3]!.params).toMatchObject({ nodeIds: ["1:2", "1:3"], audit: ["board"] });
    forwarded.length = 0;
    expect((await call("figma_scan_text_nodes", { types: ["STICKY", "FRAME"] })).isError).toBe(true);
    expect((await call("figma_get_design_context", { maxTableCells: 0 })).isError).toBe(true);
    expect((await call("figma_check_layout", { audit: ["board", "spelling"] })).isError).toBe(true);
    expect(forwarded).toEqual([]);
  });
});
