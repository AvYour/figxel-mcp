// What a read covered, and the reads the official server has that ours lacked:
// instances of a component (G-62), every font of mixed text and missing fonts
// (G-27, G-38), annotation categories and dev resources (G-10), the prototype
// map of a page (G-69), Figma's REST JSON (G-08), and the selection itself.
//
// Found while writing these (2026-10-08): the read ops took the selection from
// `figma.selection`, which the Plugin API does not have — the selection lives
// on the page (PageNode.selection). figma_get_selection therefore always said
// "nothing is selected", and every "defaults to the selection" read silently
// read the whole page instead.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { READ_OPS } from "../src/plugin/ops/read.js";

type Node = Record<string, unknown> & { id: string; name: string; type: string; parent: Node | null; children?: Node[] };
let byId: Map<string, Node>;
let page: Node & { selection: Node[] };
let figma: Record<string, unknown>;

function add(type: string, name: string, parent: Node | null, props: Record<string, unknown> = {}, id = `5:${byId.size + 1}`): Node {
  const n: Node = { id, name, type, parent, ...props };
  if (parent) (parent.children ??= []).push(n);
  byId.set(id, n);
  return n;
}

beforeEach(() => {
  byId = new Map();
  page = add("PAGE", "Page 1", null, { selection: [], children: [] }, "0:1") as Node & { selection: Node[] };
  figma = { currentPage: page, getNodeByIdAsync: async (id: string) => byId.get(id) ?? null };
  (globalThis as { figma?: unknown }).figma = figma;
});
afterAll(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const op = (name: string, params: Record<string, unknown> = {}) =>
  READ_OPS[name]!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<
    Record<string, unknown>
  >;

describe("the selection is the page's", () => {
  it("figma_get_selection returns what is selected on the current page", async () => {
    const card = add("FRAME", "Card", page);
    page.selection = [card];
    const r = await op("get_selection");
    expect(r.count).toBe(1);
    expect((r.nodes as Array<{ id: string }>)[0]!.id).toBe(card.id);
  });

  it("scans report the root they used; several selected layers fall back to the page, and say so", async () => {
    const a = add("FRAME", "A", page);
    add("TEXT", "T", a, { characters: "hi" });
    page.selection = [a];
    expect((await op("scan_text_nodes")).scope).toEqual({ id: a.id, name: "A", type: "FRAME", from: "selection" });
    const b = add("FRAME", "B", page);
    page.selection = [a, b];
    const wide = await op("scan_nodes_by_types", { types: ["TEXT"] });
    expect(wide.scope).toEqual({ id: "0:1", name: "Page 1", type: "PAGE", from: "page" });
    expect(wide.note).toMatch(/2 layers are selected/);
    expect((await op("scan_text_nodes", { nodeId: b.id })).scope).toMatchObject({ id: b.id, from: "node" });
  });
});

describe("figma_search_nodes componentId [G-62]", () => {
  function library() {
    const set = add("COMPONENT_SET", "Button", page);
    const primary = add("COMPONENT", "Variant=Primary", set);
    const ghost = add("COMPONENT", "Variant=Ghost", set);
    const screen = add("FRAME", "Screen", page);
    const elsewhere = add("FRAME", "Other", page);
    const i1 = add("INSTANCE", "Buy", screen, {}, "6:3");
    const i2 = add("INSTANCE", "Cancel", screen, {}, "6:10");
    const i3 = add("INSTANCE", "Far", elsewhere, {}, "6:2");
    primary.getInstancesAsync = async () => [i2, i1];
    ghost.getInstancesAsync = async () => [i3];
    return { set, primary, screen, i1, i2, i3 };
  }

  it("a component lists its instances; a set lists every variant's, each naming the variant it shows", async () => {
    const { set, primary } = library();
    const one = await op("search_nodes", { componentId: primary.id });
    expect((one.nodes as Array<{ id: string; componentId: string }>).map((n) => [n.id, n.componentId])).toEqual([["6:3", primary.id], ["6:10", primary.id]]);
    const all = await op("search_nodes", { componentId: set.id });
    expect((all.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["6:2", "6:3", "6:10"]);
    expect((all.nodes as Array<{ componentId: string }>)[0]!.componentId).not.toBe(primary.id);
  });

  it("stays inside the scope, combines with a name query, and pages with a cursor", async () => {
    const { set, screen } = library();
    const inScreen = await op("search_nodes", { componentId: set.id, scope: "subtree", nodeId: screen.id });
    expect((inScreen.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["6:3", "6:10"]);
    const named = await op("search_nodes", { componentId: set.id, query: "can" });
    expect((named.nodes as Array<{ name: string }>).map((n) => n.name)).toEqual(["Cancel"]);
    const first = await op("search_nodes", { componentId: set.id, limit: 2 });
    expect(first.truncated).toBe(true);
    const rest = await op("search_nodes", { componentId: set.id, limit: 2, cursor: first.nextCursor });
    expect((rest.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["6:10"]);
  });

  it("refuses an id that is not a component, and asks for something to search for", async () => {
    const f = add("FRAME", "F", page);
    await expect(op("search_nodes", { componentId: f.id })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    await expect(op("search_nodes", {})).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });
});

describe("figma_get_fonts counts every run and flags what is missing [G-27] [G-38]", () => {
  const inter = { family: "Inter", style: "Regular" };
  const bold = { family: "Inter", style: "Bold" };
  const brand = { family: "Brand Sans", style: "Medium" };

  it("mixed text contributes each of its fonts", async () => {
    add("TEXT", "Plain", page, { fontName: inter, characters: "a" });
    add("TEXT", "Rich", page, {
      fontName: Symbol("mixed"), characters: "ab",
      getStyledTextSegments: () => [{ fontName: inter }, { fontName: bold }, { fontName: inter }],
    });
    const r = await op("get_fonts");
    expect(r.fonts).toEqual([{ family: "Inter", style: "Regular", nodeCount: 2 }, { family: "Inter", style: "Bold", nodeCount: 1 }]);
    expect(r).not.toHaveProperty("missingFonts");
  });

  it("missingFonts, and missing: true on the fonts this machine does not have", async () => {
    add("TEXT", "Logo", page, { fontName: brand, characters: "x", hasMissingFont: true });
    add("TEXT", "Body", page, { fontName: inter, characters: "y" });
    figma.hasMissingFont = true;
    figma.listAvailableFontsAsync = async () => [{ fontName: inter }];
    const r = await op("get_fonts");
    expect(r.missingFonts).toBe(true);
    expect(r.fonts).toEqual([{ family: "Brand Sans", style: "Medium", nodeCount: 1, missing: true }, { family: "Inter", style: "Regular", nodeCount: 1 }]);
    figma.hasMissingFont = false;
    expect((await op("get_fonts")).missingFonts).toBe(false);
  });
});

describe("figma_get_annotations: categories and dev resources [G-10]", () => {
  it("each annotation names its category; dev resources come along when Figma gives them [C-094]", async () => {
    const btn = add("FRAME", "Button", page, { annotations: [{ label: "Opens menu", categoryId: "c1" }, { label: "No category" }] });
    let lookups = 0;
    figma.annotations = { getAnnotationCategoryByIdAsync: async (id: string) => (lookups++, { id, label: "Interaction", color: "BLUE", isPreset: true }) };
    btn.getDevResourcesAsync = async (o: { includeChildren: boolean }) => (o.includeChildren ? [{ nodeId: btn.id, name: "Button.tsx", url: "https://code/btn" }] : []);
    add("FRAME", "Other", page, { annotations: [{ label: "Also", categoryId: "c1" }] });
    const r = await op("get_annotations", { nodeId: btn.id });
    expect(r.scope).toMatchObject({ id: btn.id, from: "node" });
    expect((r.nodes as Array<{ annotations: unknown[] }>)[0]!.annotations).toEqual([
      { label: "Opens menu", categoryId: "c1", category: { id: "c1", label: "Interaction", color: "BLUE" } },
      { label: "No category" },
    ]);
    expect(r.devResources).toEqual([{ nodeId: btn.id, name: "Button.tsx", url: "https://code/btn" }]);
    const page1 = await op("get_annotations");
    expect(page1.count).toBe(2);
    expect(lookups).toBe(2); // once per call, not once per annotation
  });

  it("a refusal of getDevResourcesAsync is a note, never a failed read", async () => {
    const f = add("FRAME", "F", page, { getDevResourcesAsync: async () => { throw new Error("Dev Mode only"); } });
    const r = await op("get_annotations", { nodeId: f.id });
    expect(r.devResources).toBeUndefined();
    expect(r.devResourcesNote).toMatch(/Dev Mode only/);
    expect(r.count).toBe(0);
  });
});

describe("figma_get_reactions over a subtree or a page [G-69] [C-117]", () => {
  it("lists nodes with reactions, the page's flows, start and background, and frames that scroll or open as overlays", async () => {
    const home = add("FRAME", "Home", page, { overflowDirection: "VERTICAL", numberOfFixedChildren: 1 });
    const menu = add("FRAME", "Menu", page, { overlayPositionType: "TOP_RIGHT", overlayBackground: { type: "SOLID_COLOR", color: { r: 0, g: 0, b: 0, a: 0.4 } }, overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" });
    const open = add("FRAME", "Open", home, { reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: menu.id, navigation: "OVERLAY" }] }] });
    add("FRAME", "Static", home);
    Object.assign(page, {
      flowStartingPoints: [{ nodeId: home.id, name: "Main flow" }],
      prototypeStartNode: home,
      prototypeBackgrounds: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    });
    const r = await op("get_reactions", { scope: "page" });
    expect((r.nodes as Array<{ nodeId: string }>).map((n) => n.nodeId)).toEqual([open.id]);
    expect(r.flows).toEqual([{ nodeId: home.id, name: "Main flow" }]);
    expect(r.prototypeStartNodeId).toBe(home.id);
    expect(r.prototypeBackground).toBe("#ffffff");
    expect(r.frames).toEqual([
      { nodeId: home.id, name: "Home", overflow: "vertical", fixedChildren: 1 },
      { nodeId: menu.id, name: "Menu", overlay: { position: "TOP_RIGHT", background: "#000000 40%", interaction: "CLOSE_ON_CLICK_OUTSIDE" } },
    ]);

    const sub = await op("get_reactions", { scope: "subtree", nodeId: home.id });
    expect(sub.root).toMatchObject({ id: home.id });
    expect(sub.count).toBe(1);
  });

  it("node scope keeps its shape; subtree needs a nodeId; paging works", async () => {
    const b = add("FRAME", "B", page, { reactions: [{ actions: [] }] });
    expect(await op("get_reactions", { nodeId: b.id })).toEqual({ nodeId: b.id, name: "B", count: 1, reactions: [{ actions: [] }] });
    await expect(op("get_reactions", { scope: "subtree" })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    add("FRAME", "C", page, { reactions: [{ actions: [] }] });
    const first = await op("get_reactions", { scope: "page", limit: 1 });
    expect(first.truncated).toBe(true);
    const next = await op("get_reactions", { scope: "page", limit: 1, cursor: first.nextCursor });
    expect((next.nodes as Array<{ name: string }>)[0]!.name).toBe("C");
  });

  it("an unopened page is loaded before it is read [C-090]", async () => {
    let loaded = false;
    const other = add("PAGE", "Page 2", null, { loadAsync: async () => void (loaded = true) }, "0:2");
    add("FRAME", "X", other, { reactions: [{ actions: [] }] });
    const r = await op("get_reactions", { scope: "page", nodeId: other.id });
    expect(loaded).toBe(true);
    expect(r.count).toBe(1);
  });
});

describe("figma_get_node format rest [G-08]", () => {
  it("returns Figma's REST JSON, and cuts a huge one with a note", async () => {
    const f = add("FRAME", "F", page, { exportAsync: async (s: { format: string }) => (s.format === "JSON_REST_V1" ? { document: { id: "5:2", name: "F" } } : null) });
    expect(await op("get_node", { nodeId: f.id, format: "rest" })).toMatchObject({ format: "rest", truncated: false, rest: { document: { name: "F" } } });
    const big = add("FRAME", "Big", page, { exportAsync: async () => ({ document: { name: "x".repeat(300 * 1024) } }) });
    const r = await op("get_node", { nodeId: big.id, format: "rest" });
    expect(r.truncated).toBe(true);
    expect((r.restText as string).length).toBe(200 * 1024);
    expect(r.note).toMatch(/restText/);
    await expect(op("get_node", { nodeId: f.id, format: "xml" })).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("a page asked for by id is loaded first, so its children can be counted [C-090]", async () => {
    let loaded = false;
    const kids: Node[] = [];
    const other: Node = {
      id: "0:3", name: "Page 3", type: "PAGE", parent: null,
      get children() {
        if (!loaded) throw new Error("page not loaded");
        return kids;
      },
      loadAsync: async () => void (loaded = true),
    };
    byId.set(other.id, other);
    kids.push({ id: "7:1", name: "K", type: "FRAME", parent: other });
    expect(((await op("get_node", { nodeId: "0:3" })).node as { childCount: number }).childCount).toBe(1);
    loaded = false;
    expect(((await op("get_nodes_info", { nodeIds: ["0:3"] })).items as Array<{ ok: boolean }>)[0]!.ok).toBe(true);
  });
});
