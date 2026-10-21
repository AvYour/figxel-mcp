// The Slides parts of two existing tools. figma_export_frames_to_pdf gains a
// deck mode — every slide in presentation order, skipped slides left out
// unless asked [C-136] — and figma_zoom_to focuses a slide and switches the
// grid / single-slide view, trying the three spellings the sources disagree
// on, in order, and reading each back [C-140].

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXPORT_OPS } from "../src/plugin/ops/export.js";
import { META_OPS } from "../src/plugin/ops/meta.js";
import { BridgeError } from "../src/shared/errors.js";
import type { Bridge } from "../src/server/bridge.js";
import type { ExportRoots } from "../src/server/exports.js";
import { pdfParams, registerExport } from "../src/server/tools/export.js";
import type { Extra } from "../src/server/tools/forward.js";
import { registerNavigate } from "../src/server/tools/navigate.js";
import { FakeContainer, FakeFigma, FakeNode, installFigma, noSuchProperty, opContext } from "./editor-fakes.js";
import { FakeDeck, type DeckOptions } from "./slides-fakes.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const pdf = (params: Record<string, unknown>): Promise<Json> => EXPORT_OPS.export_frames_to_pdf!.run(opContext(params));
const zoom = (params: Record<string, unknown>): Promise<Json> => META_OPS.zoom_to!.run(opContext(params));

async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}

// ── export: the deck as a PDF ───────────────────────────────────────────────

describe("figma_export_frames_to_pdf in a deck (plugin)", () => {
  it("deck: every slide in presentation order, skipped slides left out unless asked", async () => {
    const d = deck({ rows: [2, 1] });
    const [[a, b], [c]] = d.ids() as [[string, string], [string]];
    d.slide(0, 1).isSkippedSlide = true;
    const r = await pdf({ deck: true });
    expect(r.pages.map((p: Json) => p.nodeId)).toEqual([a, c]);
    expect(r).toMatchObject({ count: 2, slideIds: [a, c], skippedSlides: [b], failed: [] });
    expect(d.exports).toEqual([a, c]);
    const all = await pdf({ deck: true, includeSkipped: true });
    expect(all.slideIds).toEqual([a, b, c]);
    expect(all.skippedSlides).toEqual([]);
  });

  it("refuses a deck with nothing to export, nodeIds beside deck, includeSkipped alone, and a deck outside Slides", async () => {
    const d = deck({ rows: [1] });
    d.slide(0, 0).isSkippedSlide = true;
    const empty = await refusal(pdf({ deck: true }));
    expect(empty.hint).toBe("All 1 slide(s) are skipped: pass includeSkipped: true.");
    expect((await refusal(pdf({ deck: true, nodeIds: [d.slide(0, 0).id] }))).message).toBe("Pass `nodeIds` or `deck`, not both.");
    // The plugin answers as the server does (pdfParams), for a caller that reaches it another way.
    expect((await refusal(pdf({ includeSkipped: true, nodeIds: [d.slide(0, 0).id] }))).message).toBe("`includeSkipped` goes with `deck: true`.");
    expect((await refusal(pdf({ includeSkipped: true }))).message).toBe("`includeSkipped` goes with `deck: true`.");
    expect((await refusal(pdf({ deck: false }))).message).toMatch(/`deck` must be true/);
    expect(d.exports).toEqual([]);
    uninstall?.();
    uninstall = installFigma(new FakeFigma({ editorType: "figma" }));
    const design = await refusal(pdf({ deck: true }));
    expect(design.code).toBe("UNSUPPORTED");
    expect(design.message).toMatch(/^`deck` works in Figma Slides files/);
  });

  it("nodeIds still export in the order given", async () => {
    const d = deck({ rows: [2] });
    const [[a, b]] = d.ids() as [[string, string]];
    const r = await pdf({ nodeIds: [b, a] });
    expect(r.pages.map((p: Json) => p.nodeId)).toEqual([b, a]);
    expect(r.slideIds).toBeUndefined();
  });
});

describe("figma_export_frames_to_pdf in a deck (server)", () => {
  it("takes exactly one of nodeIds and deck, and includeSkipped only with deck", () => {
    expect(pdfParams({ nodeIds: ["1:2"], outputPath: "x.pdf" })).toEqual({ nodeIds: ["1:2"] });
    expect(pdfParams({ deck: true })).toEqual({ deck: true });
    expect(pdfParams({ deck: true, includeSkipped: false })).toEqual({ deck: true, includeSkipped: false });
    expect(() => pdfParams({ nodeIds: ["1:2"], deck: true })).toThrow("Pass `nodeIds` or `deck`, not both.");
    expect(() => pdfParams({ nodeIds: ["1:2"], includeSkipped: true })).toThrow("`includeSkipped` goes with `deck: true`.");
    expect(() => pdfParams({ deck: false })).toThrow(/Pass `nodeIds`.*or `deck: true`/);
    expect(() => pdfParams({})).toThrow(/Pass `nodeIds`/);
  });

  const roots: ExportRoots = { exportDir: join(mkdtempSync(join(tmpdir(), "fmcp-deck-")), "exports"), exportRoots: [] };
  const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;
  const onePage = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([1920, 1080]);
    return Buffer.from(await doc.save()).toString("base64");
  };

  function tool(request: (op: string, p: Record<string, unknown>) => unknown) {
    const tools: Record<string, { config: { inputSchema: z.ZodRawShape; description: string }; handler: (a: Record<string, unknown>, e: Extra) => Promise<CallToolResult> }> = {};
    const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
    const bridge = { request: async (op: string, p: Record<string, unknown>) => request(op, p), statusAsync: async () => ({ sessions: [] }) } as unknown as Bridge;
    registerExport(server, bridge, roots, (op) => op === "export_frames_to_pdf");
    return tools.figma_export_frames_to_pdf!;
  }

  it("refuses nodeIds beside deck before Figma is asked, and forwards deck mode with its slide order", async () => {
    const requests: Array<{ op: string; p: Record<string, unknown> }> = [];
    const page = await onePage();
    const t = tool((op, p) => {
      requests.push({ op, p });
      return { pages: [{ nodeId: "1:3", name: "A", bytes: 1, base64: page }, { nodeId: "1:5", name: "C", bytes: 1, base64: page }], failed: [], slideIds: ["1:3", "1:5"], skippedSlides: ["1:4"] };
    });
    expect(Object.keys(t.config.inputSchema)).toEqual(["nodeIds", "deck", "includeSkipped", "outputPath", "final", "session"]);
    expect(z.object(t.config.inputSchema).strict().safeParse({ deck: true, outputPath: "d.pdf" }).success).toBe(true);
    const both = await t.handler({ nodeIds: ["1:2"], deck: true, outputPath: "deck.pdf" }, extra);
    expect(both.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(requests).toEqual([]);
    const ok = await t.handler({ deck: true, outputPath: "deck.pdf" }, extra);
    expect(requests).toEqual([{ op: "export_frames_to_pdf", p: { deck: true } }]);
    const out = ok.structuredContent as { path: string; pageCount: number; slideIds: string[]; skippedSlides: string[] };
    expect(out).toMatchObject({ pageCount: 2, slideIds: ["1:3", "1:5"], skippedSlides: ["1:4"] });
    expect(existsSync(out.path)).toBe(true);
    expect(t.config.description.length).toBeLessThanOrEqual(1024);
  });
});

// ── zoom_to: the focused slide and the view ─────────────────────────────────

describe("figma_zoom_to in a deck", () => {
  it("a slide becomes the focused slide; the result says which, and the view", async () => {
    const d = deck({ rows: [2] });
    const target = d.slide(0, 1);
    const r = await zoom({ nodeId: target.id });
    expect(d.viewport.scrolled).toEqual([[target.id]]);
    expect(d.currentPage.focusedSlide).toBe(target);
    expect(r).toMatchObject({ focusedSlideId: target.id, view: "grid", items: [{ id: target.id, ok: true }] });
    expect(r.viewNote).toBeUndefined();
  });

  it("a layer on a slide focuses the slide that holds it; a node outside any slide focuses none", async () => {
    const d = deck({ rows: [2] });
    const holder = d.slide(0, 1);
    const inner = new FakeContainer("FRAME", "Card", d);
    holder.appendChild(inner);
    const title = new FakeNode("TEXT", "Title", d);
    inner.appendChild(title);
    const r = await zoom({ nodeId: title.id, view: "single-slide" });
    expect(d.currentPage.focusedSlide).toBe(holder);
    expect(r).toMatchObject({ focusedSlideId: holder.id, view: "single-slide", items: [{ id: title.id, ok: true }] });
    // A clone lands on the page beside the grid, outside every slide.
    d.currentPage.focusedSlide = null;
    const loose = new FakeNode("RECTANGLE", "Loose", d);
    d.currentPage.appendChild(loose);
    const outside = await zoom({ nodeId: loose.id });
    expect(d.currentPage.focusedSlide).toBeNull();
    expect(outside.focusedSlideId).toBeUndefined();
  });

  it("switches the view through canvasView first, its newest spelling, and reports the property that took it", async () => {
    const d = deck({ rows: [1] });
    const r = await zoom({ nodeId: d.slide(0, 0).id, view: "single-slide" });
    expect(d.viewport.viewWrites).toEqual([["canvasView", "single-asset"]]);
    expect(r).toMatchObject({ view: "single-slide", viewProperty: "canvasView", focusedSlideId: d.slide(0, 0).id });
    const back = await zoom({ view: "grid" });
    expect(back).toMatchObject({ view: "grid", items: [] });
    expect(d.viewport.scrolled).toHaveLength(1);
  });

  it("falls back through slidesView and slidesMode when an earlier spelling is absent, throws or ignores the write [C-140]", async () => {
    const cases: Array<[DeckOptions["view"], Array<[string, unknown]>, string]> = [
      [{ slidesView: "ok" }, [["slidesView", "single-slide"]], "slidesView"],
      [{ canvasView: "throws", slidesView: "ok" }, [["canvasView", "single-asset"], ["slidesView", "single-slide"]], "slidesView"],
      [{ canvasView: "ignores", slidesMode: "ok" }, [["canvasView", "single-asset"], ["slidesMode", "single-slide"]], "slidesMode"],
    ];
    for (const [view, writes, via] of cases) {
      uninstall?.();
      const d = deck({ rows: [1], view });
      const r = await zoom({ view: "single-slide" });
      expect(d.viewport.viewWrites, via).toEqual(writes);
      expect(r, via).toMatchObject({ view: "single-slide", viewProperty: via });
    }
  });

  it("says so when no view property takes the value, and still focuses the slide", async () => {
    const d = deck({ rows: [1], view: { canvasView: "ignores" } });
    const r = await zoom({ nodeId: d.slide(0, 0).id, view: "single-slide" });
    expect(r.viewNote).toMatch(/No view property took "single-slide" \(canvasView: set to "single-asset" but reads "grid"\)/);
    expect(r).toMatchObject({ view: "grid", focusedSlideId: d.slide(0, 0).id });
    expect(r.viewProperty).toBeUndefined();
    uninstall?.();
    deck({ rows: [1], view: {} });
    expect((await zoom({ view: "grid" })).viewNote).toMatch(/none of canvasView, slidesView, slidesMode exists here/);
  });

  it("a focusedSlide setter that throws is reported, not fatal", async () => {
    const d = deck({ rows: [1] });
    Object.defineProperty(d.currentPage, "focusedSlide", { configurable: true, get: () => null, set: () => { throw noSuchProperty("focusedSlide", "PAGE node"); } });
    const r = await zoom({ nodeId: d.slide(0, 0).id });
    expect(r.viewNote).toMatch(/^focusedSlide could not be set: no such property 'focusedSlide'/);
    expect(r.focusedSlideId).toBeNull();
  });

  it("refuses `view` outside Slides before moving anything, and leaves a design zoom as it was", async () => {
    const fake = new FakeFigma({ editorType: "figma" });
    const frame = new FakeNode("FRAME", "Frame", fake);
    fake.currentPage.appendChild(frame);
    const scrolled: string[][] = [];
    Object.assign(fake, { viewport: { zoom: 1, scrollAndZoomIntoView: (n: Array<{ id: string }>) => scrolled.push(n.map((x) => x.id)) } });
    uninstall = installFigma(fake);
    const e = await refusal(zoom({ nodeId: frame.id, view: "grid" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/`view` switches a Figma Slides file .* editorType is "figma"/);
    expect(scrolled).toEqual([]);
    const r = await zoom({ nodeId: frame.id, zoom: "2" });
    // No Slides keys on a design file.
    expect(r).toEqual({ zoom: 2, page: { id: fake.currentPage.id, name: "Page 1" }, items: [{ id: frame.id, ok: true }] });
    await expect(zoom({})).rejects.toThrow("Give `nodeId` or `nodeIds`.");
  });

  it("the server schema takes `view` as one of two words, strictly", () => {
    const tools: Record<string, { inputSchema: z.ZodRawShape; description: string }> = {};
    registerNavigate({ registerTool: (name: string, config: never) => void (tools[name] = config) } as unknown as McpServer, {} as Bridge, () => true);
    const schema = z.object(tools.figma_zoom_to!.inputSchema).strict();
    expect(schema.safeParse({ view: "single-slide" }).success).toBe(true);
    expect(schema.safeParse({ view: "list" }).success).toBe(false);
    expect(tools.figma_zoom_to!.description).toMatch(/`view` alone needs no nodes/);
  });
});
