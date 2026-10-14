// The two findings still open in
// `docs/superpowers/plans/2026-10-08-live-design-findings.md`, pinned.
//
// Both were found by designing on the real canvas, and neither was reachable by
// the tests that existed: the text pass compared text against text, and set_text
// was only ever asked to preserve fonts, never styling. A fake that shares the
// code's blind spot proves nothing, so these build the situation the live
// session hit — a filled layer above a text, and a node with two styled runs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { checkLayout } from "../src/plugin/ops/check.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";

const run = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const check = (root: unknown, max = 500) =>
  checkLayout(root as never, max, { yieldToHost: async () => {}, isCancelled: () => false });

type N = Record<string, unknown> & { id: string; type: string; name: string; parent?: N | null; children?: N[] };
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

let seq = 0;
let page: N;
const byId = new Map<string, N>();
const reg = (n: N) => (byId.set(n.id, n), n);

function frame(name: string, parent: N, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}): N {
  const n = reg({ id: `9:${++seq}`, type: "FRAME", name, parent, absoluteBoundingBox: b, children: [], ...extra });
  parent.children!.push(n);
  return n;
}

beforeEach(() => {
  byId.clear();
  page = reg({ id: "0:1", type: "PAGE", name: "Page", children: [] });
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadFontAsync: async () => {},
    listAvailableFontsAsync: async () => [],
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("F-1 — a painted layer covering text", () => {
  // The live case: on `v2 / 03 About` a chat-bubble frame with a solid fill sat
  // over the row text "Studio Kumo · Tokyo". Both texts were clear of each
  // other, so the text-against-text pass had nothing to compare and the tool
  // returned ok: true. Only the render showed it.
  const withBubble = (bubbleFirst: boolean) => {
    const row = frame("Experience row", page, box(0, 0, 800, 100));
    const label = reg({
      id: `9:${++seq}`, type: "TEXT", name: "Place", characters: "Studio Kumo", parent: row,
      absoluteBoundingBox: box(20, 30, 400, 30), absoluteRenderBounds: box(20, 34, 200, 22),
    });
    const bubble = frame("Cursor chat", row, box(30, 26, 260, 44), {
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, visible: true }],
    });
    const message = reg({
      id: `9:${++seq}`, type: "TEXT", name: "Message", characters: "Hi!", parent: bubble,
      absoluteBoundingBox: box(50, 36, 60, 24), absoluteRenderBounds: box(50, 40, 40, 16),
    });
    bubble.children!.push(message);
    // Paint order is document order: whatever is pushed last paints on top.
    row.children!.length = 0;
    row.children!.push(...(bubbleFirst ? [bubble, label] : [label, bubble]));
    return { row, label, bubble };
  };

  it("reports `covered` when a filled frame is painted above the text", async () => {
    const { row, bubble } = withBubble(false);
    const r = await check(row);
    const hit = r.issues.filter((i) => i.kind === "covered");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.severity).toBe("error");
    expect(hit[0]!.detail).toContain(bubble.id);
    expect(hit[0]!.name).toBe("Place");
  });

  it("says nothing when the same layer is painted below the text", async () => {
    const { row } = withBubble(true);
    const r = await check(row);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });

  it("does not report a text inside its own filled card as covered", async () => {
    const card = frame("Card", page, box(0, 0, 400, 200), {
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
    });
    const title = reg({
      id: `9:${++seq}`, type: "TEXT", name: "Title", characters: "Card title", parent: card,
      absoluteBoundingBox: box(20, 20, 200, 30), absoluteRenderBounds: box(20, 24, 120, 22),
    });
    card.children!.push(title);
    const r = await check(card);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });

  it("does not report a hollow outline around the text it surrounds", async () => {
    // A selected node is surrounded by a stroked frame. Treating that box as
    // coverage would flag every design that shows a selection.
    const sel = frame("Selection", page, box(0, 0, 400, 200), {
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, visible: true }],
      strokeWeight: 2,
      strokeAlign: "CENTER",
    });
    const t = reg({
      id: `9:${++seq}`, type: "TEXT", name: "Name", characters: "Alex", parent: sel,
      absoluteBoundingBox: box(100, 90, 200, 40), absoluteRenderBounds: box(100, 94, 120, 32),
    });
    sel.children!.push(t);
    const r = await check(sel);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });

  it("a frame with no visible paint does not count as a cover", async () => {
    const { row, bubble } = withBubble(false);
    bubble.fills = [];
    const r = await check(row);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });

  it("a barely translucent wash tints the text instead of hiding it", async () => {
    const { row, bubble } = withBubble(false);
    bubble.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, visible: true, opacity: 0.15 }];
    const r = await check(row);
    expect(r.issues.filter((i) => i.kind === "covered")).toEqual([]);
  });
});

describe("F-2 — set_text reports the styling it flattens", () => {
  it("returns the old runs when the node had more than one style", async () => {
    // The live case: an "IND" Michroma + "EX" Krona One title came back as
    // "ABOUT" in one font, and the styling had to be restored by hand.
    const t = reg({
      id: "9:900", type: "TEXT", name: "Title", parent: page, characters: "INDEX",
      fontName: Symbol("mixed"), fontSize: Symbol("mixed"), fills: Symbol("mixed"),
      getRangeAllFontNames: () => [
        { family: "Michroma", style: "Regular" },
        { family: "Krona One", style: "Regular" },
      ],
      getStyledTextSegments: () => [
        { start: 0, end: 3, fontName: { family: "Michroma", style: "Regular" }, fontSize: 48, fills: [{ type: "SOLID", color: { r: 0, g: 0.13, b: 0.8 } }] },
        { start: 3, end: 5, fontName: { family: "Krona One", style: "Regular" }, fontSize: 48, fills: [{ type: "SOLID", color: { r: 0, g: 0.13, b: 0.8 } }] },
      ],
    });
    const r = (await MODIFY_OPS.set_text!.run(run({ nodeId: t.id, content: "ABOUT" }))) as {
      flattened?: { runs: Array<{ text: string; font: { family: string } | null; fontSize: number | null; fill: string | null }> };
    };
    expect(t.characters).toBe("ABOUT");
    expect(r.flattened).toBeDefined();
    expect(r.flattened!.runs.map((x) => x.text)).toEqual(["IND", "EX"]);
    expect(r.flattened!.runs.map((x) => x.font?.family)).toEqual(["Michroma", "Krona One"]);
    expect(r.flattened!.runs[0]!.fontSize).toBe(48);
    expect(r.flattened!.runs[0]!.fill).toBe("#0021cc");
  });

  it("says nothing extra when the node had a single style", async () => {
    const t = reg({
      id: "9:901", type: "TEXT", name: "Body", parent: page, characters: "Hello",
      fontName: { family: "Inter", style: "Regular" }, fontSize: 16,
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
      getStyledTextSegments: () => [
        { start: 0, end: 5, fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] },
      ],
    });
    const r = (await MODIFY_OPS.set_text!.run(run({ nodeId: t.id, content: "Goodbye" }))) as { flattened?: unknown };
    expect(r.flattened).toBeUndefined();
  });

  it("still replaces the text and loads every font of a mixed node", async () => {
    const loaded: string[] = [];
    (globalThis as unknown as { figma: { loadFontAsync: (f: { family: string; style: string }) => Promise<void> } }).figma.loadFontAsync =
      async (f) => void loaded.push(`${f.family} ${f.style}`);
    const t = reg({
      id: "9:902", type: "TEXT", name: "Price", parent: page, characters: "$0 /month",
      fontName: { family: "Inter", style: "Regular" },
      getRangeAllFontNames: () => [
        { family: "Inter", style: "Bold" },
        { family: "Inter", style: "Medium" },
      ],
      getStyledTextSegments: () => [
        { start: 0, end: 2, fontName: { family: "Inter", style: "Bold" }, fontSize: 20 },
        { start: 2, end: 10, fontName: { family: "Inter", style: "Medium" }, fontSize: 20 },
      ],
    });
    await MODIFY_OPS.set_text!.run(run({ nodeId: t.id, content: "$19 /month" }));
    expect(t.characters).toBe("$19 /month");
    expect(loaded).toEqual(["Inter Bold", "Inter Medium"]);
  });
});
