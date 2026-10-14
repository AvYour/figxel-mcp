// Four defects found on 2026-10-08 by an agent building a pricing section on the
// real canvas, through the tools, step by step. None was caught by a unit test,
// because each fake had the same blind spot as the code. These pin them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrame } from "../src/server/frames.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";
import { checkLayout } from "../src/plugin/ops/check.js";

const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false });

describe("hello keeps the plugin's build id", () => {
  it("the schema no longer strips buildId — figma_status reported null for every plugin", () => {
    const r = parseFrame(JSON.stringify({
      t: "hello", protocolVersion: 1, token: "x", instanceId: "i", pluginVersion: "0.1.0", apiVersion: "1.0.0",
      editorType: "figma", ops: [], file: { name: "f", key: null }, page: null, user: null, buildId: "c9d0df00a19e",
    }));
    expect(r.ok).toBe(true);
    expect((r as { msg: { buildId?: string } }).msg.buildId).toBe("c9d0df00a19e");
  });
});

type Node = Record<string, unknown> & { id: string; type: string; name: string; parent?: Node | null; children?: Node[] };
let seq = 0;
let page: Node;
const byId = new Map<string, Node>();
const reg = (n: Node) => (byId.set(n.id, n), n);

beforeEach(() => {
  byId.clear();
  page = reg({ id: "0:1", type: "PAGE", name: "Page", children: [] });
  const loaded: string[] = [];
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadFontAsync: async (f: { family: string; style: string }) => void loaded.push(`${f.family} ${f.style}`),
    listAvailableFontsAsync: async () => [],
    loaded,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

function container(name: string, parent: Node): Node {
  const n: Node = reg({ id: `5:${++seq}`, type: "FRAME", name, parent, children: [] });
  n.appendChild = (c: Node) => {
    if (c.parent?.children) c.parent.children.splice(c.parent.children.indexOf(c), 1);
    n.children!.push(c);
    c.parent = n;
  };
  n.insertChild = (i: number, c: Node) => {
    if (c.parent?.children) c.parent.children.splice(c.parent.children.indexOf(c), 1);
    n.children!.splice(i, 0, c);
    c.parent = n;
  };
  parent.children!.push(n);
  return n;
}

describe("clone_node", () => {
  it("places the copy right after the source — Figma's clone() always parents it under the page", async () => {
    const list = container("Features", page);
    const row = container("Feature", list);
    container("Feature 2", list);
    row.clone = () => {
      const copy = reg({ id: `5:${++seq}`, type: "FRAME", name: "Feature", parent: page, children: [] });
      page.children!.push(copy); // what the real API does
      return copy;
    };
    const r = (await MODIFY_OPS.clone_node!.run(ctx({ nodeId: row.id, parentId: list.id }))) as { id: string };
    expect(list.children!.map((c) => c.id)).toEqual([row.id, r.id, list.children![2]!.id]);
    expect(page.children!.some((c) => c.id === r.id)).toBe(false);
  });

  it("a bad parentId is refused before anything is cloned", async () => {
    const row = container("Feature", page);
    let cloned = 0;
    row.clone = () => (cloned++, row);
    await expect(MODIFY_OPS.clone_node!.run(ctx({ nodeId: row.id, parentId: "404:1" }))).rejects.toMatchObject({ partial: { created: [] } });
    expect(cloned).toBe(0);
  });
});

describe("set_text", () => {
  it("keeps a mixed-font text's fonts — it used to replace them all with Inter Regular", async () => {
    const runs = [{ family: "Plus Jakarta Sans", style: "Bold" }, { family: "Plus Jakarta Sans", style: "Medium" }];
    const t = reg({
      id: "5:900", type: "TEXT", name: "Price", parent: page, characters: "$0 /month", fontName: Symbol("mixed"),
      getRangeAllFontNames: () => runs,
    });
    await MODIFY_OPS.set_text!.run(ctx({ nodeId: t.id, content: "$19 /month" }));
    expect(t.characters).toBe("$19 /month");
    expect(typeof t.fontName).toBe("symbol"); // untouched: no font was forced onto the node
    expect((globalThis as unknown as { figma: { loaded: string[] } }).figma.loaded).toEqual(["Plus Jakarta Sans Bold", "Plus Jakarta Sans Medium"]);
  });
});

describe("check_layout", () => {
  it("does not flag the paths inside an icon for their default names", async () => {
    const box = (x: number) => ({ x, y: 0, width: 20, height: 20 });
    const icon: Node = { id: "6:1", type: "FRAME", name: "Icon / Check", absoluteBoundingBox: box(0), children: [] };
    for (const n of ["Vector", "Vector"]) icon.children!.push({ id: `6:${++seq}`, type: "VECTOR", name: n, absoluteBoundingBox: box(0), parent: icon });
    const r = await checkLayout(icon as never, 100, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(r.issues.filter((i) => i.kind === "default_name")).toEqual([]);
  });
});

// ── second live session (v2 / 02 Index) ─────────────────────────────────────

import { STYLE_OPS } from "../src/plugin/ops/style.js";
import { buildContext } from "../src/plugin/context.js";

describe("findings from the portfolio index page", () => {
  it("set_strokes { remove: true } takes the outline off", async () => {
    const row = reg({ id: "7:1", type: "FRAME", name: "Row", parent: page, strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] });
    const r = (await STYLE_OPS.set_strokes!.run(ctx({ nodeIds: [row.id], remove: true }))) as { updated: number };
    expect(r.updated).toBe(1);
    expect(row.strokes).toEqual([]);
    await expect(STYLE_OPS.set_strokes!.run(ctx({ nodeIds: [row.id] }))).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("stylesUsed carries the id, so a library style can be applied by id", async () => {
    (globalThis as unknown as { figma: Record<string, unknown> }).figma.getStyleByIdAsync = async () => ({ name: "Theme/Blue", type: "PAINT", remote: true });
    const n = { id: "7:2", type: "RECTANGLE", name: "Dot", fillStyleId: "S:lib,", fills: [] };
    const r = await buildContext([n as never], { depth: 1, maxNodes: 10, maxChildren: 10, includeGeometry: false, includeStyles: true, includeVariables: false }, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(r.stylesUsed).toEqual([{ id: "S:lib,", name: "Theme/Blue", type: "PAINT", remote: true }]);
  });

  it("overlap is judged on rendered glyphs, not on a text box that fills its row", async () => {
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
    const frame: Node = { id: "7:3", type: "FRAME", name: "Page", absoluteBoundingBox: box(0, 0, 1000, 400), children: [] };
    const title: Node = { id: "7:4", type: "TEXT", name: "About", characters: "About", absoluteBoundingBox: box(0, 0, 900, 40), absoluteRenderBounds: box(0, 6, 140, 30), parent: frame };
    const bubble: Node = { id: "7:5", type: "TEXT", name: "Message", characters: "You are here.", absoluteBoundingBox: box(600, 10, 150, 30), absoluteRenderBounds: box(600, 14, 140, 22), parent: frame };
    frame.children!.push(title, bubble);
    const r = await checkLayout(frame as never, 100, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(r.issues.filter((i) => i.kind === "overlap")).toEqual([]);
  });
});
