// Review findings on the export group and on node addressing (2026-10-09).
//
//  A-1  The 1024 px cap was worked out from width/height. A page has neither, so
//       a page link rendered uncapped; a rotated node was capped on the wrong axis.
//  A-3  The export tools' own refusals said safeToRetry: false on a pure read.
//  A-2  With one file open, a link from another file ran writes against whatever
//       node had that id here; an error dropped the mismatch warning.
//  A-7  A reaction's destinationId, inside the `reactions` JSON string, was never
//       normalized: "12-40" or a pasted link reached Figma verbatim.
//  B-2  A NO_SESSION for a call already in the plugin's hands said safeToRetry: true.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { EXPORT_OPS } from "../src/plugin/ops/export.js";
import type { Bridge } from "../src/server/bridge.js";
import type { ExportRoots } from "../src/server/exports.js";
import { errorResult } from "../src/server/results.js";
import { registerExport } from "../src/server/tools/export.js";
import { forwardTool, type Extra } from "../src/server/tools/forward.js";

const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;
const structured = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("A-1: the export cap is sized on what renders", () => {
  const calls: Record<string, unknown>[] = [];
  const png = new Uint8Array([1, 2, 3]); // no header: the meta falls back to an estimate
  const exportAsync = async (s: Record<string, unknown>) => (calls.push(s), png);
  const nodes: Record<string, unknown> = {};
  beforeEach(() => {
    calls.length = 0;
    (globalThis as { figma?: unknown }).figma = {
      getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
      currentPage: { id: "0:9", type: "PAGE", selection: [] },
    };
  });
  afterAll(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });
  const run = (params: Record<string, unknown>) =>
    EXPORT_OPS.export_node!.run({
      requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
    } as OpContext) as Promise<Record<string, unknown>>;

  it("a page — no width or height of its own — is capped on its visible children's union", async () => {
    nodes["0:1"] = {
      id: "0:1", name: "Screens", type: "PAGE", exportAsync,
      children: [
        { id: "1:1", type: "FRAME", absoluteRenderBounds: rect(0, 0, 1440, 900) },
        { id: "1:2", type: "FRAME", absoluteBoundingBox: rect(28560, 4100, 1440, 900) },
        // Not rendered, so it must not stretch the box onto the other axis.
        { id: "1:3", type: "FRAME", visible: false, absoluteBoundingBox: rect(0, 90000, 10, 10) },
      ],
    };
    const r = await run({ nodeId: "0:1", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "WIDTH", value: 1024 } });
    expect(r).toMatchObject({ capped: true, scale: 0.03, pixelWidth: 1024, pixelHeight: 171, pixelEstimate: true });
    expect(r.bounds).toBeUndefined();
  });

  it("an empty page has nothing to cap", async () => {
    nodes["0:2"] = { id: "0:2", name: "Empty", type: "PAGE", exportAsync, children: [] };
    const r = await run({ nodeId: "0:2", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    expect(r.capped).toBeUndefined();
  });

  it("a rotated node is capped on its turned box; bounds stay the node's own", async () => {
    nodes["2:1"] = {
      id: "2:1", name: "Banner", type: "FRAME", x: 0, y: 0, width: 1600, height: 200, rotation: 90, exportAsync,
      absoluteBoundingBox: rect(0, -1600, 200, 1600), absoluteRenderBounds: rect(0, -1600, 200, 1600),
    };
    const r = await run({ nodeId: "2:1", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "HEIGHT", value: 1024 } });
    expect(r).toMatchObject({ capped: true, scale: 0.64, pixelWidth: 128, pixelHeight: 1024 });
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 1600, height: 200 });
  });

  it("a shadow that pushes the render past the cap is capped", async () => {
    nodes["2:2"] = {
      id: "2:2", name: "Card", type: "FRAME", x: 0, y: 0, width: 1000, height: 1000, exportAsync,
      absoluteBoundingBox: rect(0, 0, 1000, 1000), absoluteRenderBounds: rect(-100, -100, 1200, 1200),
    };
    const r = await run({ nodeId: "2:2", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "WIDTH", value: 1024 } });
    expect(r.capped).toBe(true);
  });

  it("text whose glyphs are narrower than its box is still measured on the box", async () => {
    nodes["2:3"] = {
      id: "2:3", name: "Headline", type: "TEXT", x: 0, y: 0, width: 1400, height: 40, exportAsync,
      absoluteBoundingBox: rect(0, 0, 1400, 40), absoluteRenderBounds: rect(0, 6, 600, 30),
    };
    await run({ nodeId: "2:3", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "WIDTH", value: 1024 } });
  });
});

describe("A-3: the export tools' own refusals are safe to retry", () => {
  const base = mkdtempSync(join(tmpdir(), "fmcp-g1-"));
  const roots: ExportRoots = { exportDir: join(base, "exports"), exportRoots: [] };
  type Handler = (a: Record<string, unknown>, e: Extra) => Promise<CallToolResult>;

  function setup(reply: unknown = {}) {
    const tools: Record<string, Handler> = {};
    const server = { registerTool: (name: string, _c: unknown, handler: Handler) => void (tools[name] = handler) } as unknown as McpServer;
    const requests: string[] = [];
    const bridge = {
      request: async (op: string) => (requests.push(op), reply),
      statusAsync: async () => ({ sessions: [] }),
    } as unknown as Bridge;
    registerExport(server, bridge, roots, () => true);
    return { tools, requests };
  }

  it("a bad path, a missing path or a format clash: refused before Figma, safeToRetry true", async () => {
    const { tools, requests } = setup();
    const refusals = [
      await tools.figma_export_node!({ nodeId: "1:1", saveTo: "out.svg", format: "PNG" }, extra),
      await tools.figma_export_node!({ nodeId: "1:1", saveTo: "../../x.png" }, extra),
      await tools.figma_save_screenshots!({ nodeIds: ["1:1"], dir: "../../elsewhere" }, extra),
      await tools.figma_export_frames_to_pdf!({ nodeIds: ["1:1"] }, extra),
      await tools.figma_export_frames_to_pdf!({ nodeIds: ["1:1"], outputPath: "../../x.pdf" }, extra),
    ];
    for (const r of refusals) expect(structured(r)).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(requests).toEqual([]);
  });

  it("a PDF that rendered nothing, or would not merge, changed nothing either", async () => {
    const none = setup({ pages: [], failed: [{ nodeId: "1:1", error: "a PAGE cannot be exported as PDF" }] });
    const empty = await none.tools.figma_export_frames_to_pdf!({ nodeIds: ["1:1"], outputPath: "deck.pdf" }, extra);
    expect(structured(empty)).toMatchObject({ code: "INTERNAL", safeToRetry: true });
    const junk = setup({ pages: [{ nodeId: "1:1", name: "A", bytes: 3, base64: "AAAA" }], failed: [] });
    const unmerged = await junk.tools.figma_export_frames_to_pdf!({ nodeIds: ["1:1"], outputPath: "deck.pdf" }, extra);
    expect(unmerged.isError).toBe(true);
    expect(structured(unmerged).safeToRetry).toBe(true);
  });
});

interface Call {
  op: string;
  p: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function fakeBridge(
  sessions: Array<{ sessionId: string; file: { name: string | null }; active?: boolean }> = [],
  reply: (opts: Record<string, unknown>) => unknown = () => ({ ok: true }),
) {
  const calls: Call[] = [];
  const bridge = {
    request: async (op: string, p: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ op, p, opts });
      return reply(opts);
    },
    statusAsync: async () => ({ sessions }),
  } as unknown as Bridge;
  return { bridge, calls };
}

const LINK = "https://www.figma.com/design/K/Dashboard?node-id=1-5";

describe("A-2: a link from another file never drives a write in the open one", () => {
  it("a write or a delete is refused before Figma, naming both files and the way out", async () => {
    for (const [op, p] of [["set_fills", { nodeIds: [LINK], fills: [] }], ["delete_nodes", { nodeIds: [LINK] }]] as const) {
      const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" } }]);
      const r = await forwardTool(bridge, op, p, extra);
      expect(structured(r)).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
      expect(String(structured(r).message)).toMatch(/"Dashboard".*"Landing"/);
      expect(String(structured(r).hint)).toContain('session: "Landing"');
      expect(calls).toEqual([]);
    }
  });

  it("an explicit session runs it; so does a read, with the warning", async () => {
    const f = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" } }]);
    await forwardTool(f.bridge, "set_fills", { nodeIds: [LINK], fills: [] }, extra, { session: "Landing" });
    const read = await forwardTool(f.bridge, "get_node", { nodeId: LINK }, extra);
    expect(f.calls.map((c) => c.op)).toEqual(["set_fills", "get_node"]);
    expect(String(structured(read).warning)).toMatch(/Dashboard.*Landing/);
  });

  it("a file whose name is unknown cannot be compared, so the write runs and says so", async () => {
    const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: null } }], () => ({ updated: 1 }));
    const r = await forwardTool(bridge, "set_fills", { nodeIds: [LINK], fills: [] }, extra);
    expect(calls).toHaveLength(1);
    expect(String(structured(r).warning)).toContain('"?"');
  });

  it("an error after a mismatch still carries the warning — the likely cause", async () => {
    const { bridge } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" } }], () => {
      throw new BridgeError(ErrorCode.NODE_NOT_FOUND, "No node with id `1:5`.");
    });
    const r = await forwardTool(bridge, "get_node", { nodeId: LINK }, extra);
    expect(structured(r)).toMatchObject({ code: "NODE_NOT_FOUND", warning: expect.stringMatching(/Dashboard.*Landing/) });
    expect(r.content.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^warning: /) });
  });
});

describe("A-7: a reaction's destinationId is normalized like any other id", () => {
  const reactions = (destinationId: string) => JSON.stringify([{ trigger: "ON_CLICK", action: { type: "NODE", destinationId } }]);
  const sentDestination = (c: Call) => (JSON.parse(c.p.reactions as string) as Array<{ action: { destinationId: string } }>)[0]!.action.destinationId;

  it("'12-40' and a figma.com link arrive as 12:40, still as a JSON string", async () => {
    for (const d of ["12-40", "https://www.figma.com/design/K/Landing?node-id=12-40"]) {
      const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" } }]);
      const r = await forwardTool(bridge, "set_reactions", { nodeId: "12-34", reactions: reactions(d) }, extra);
      expect(r.isError).toBeUndefined();
      expect(typeof calls[0]!.p.reactions).toBe("string");
      expect(sentDestination(calls[0]!)).toBe("12:40");
    }
  });

  it("Figma's full shape (actions[]) and a batch step are reached too; the link picks the session", async () => {
    const { bridge, calls } = fakeBridge([
      { sessionId: "s-1", file: { name: "Docs" }, active: true },
      { sessionId: "s-2", file: { name: "Landing" } },
    ]);
    const full = JSON.stringify([{ trigger: { type: "ON_HOVER" }, actions: [{ type: "NODE", destinationId: "https://www.figma.com/design/K/Landing?node-id=7-8" }] }]);
    await forwardTool(bridge, "batch", { steps: [{ op: "set_reactions", params: { nodeId: "1-2", reactions: full } }] }, extra);
    const step = (calls[0]!.p.steps as Array<{ params: Record<string, unknown> }>)[0]!.params;
    expect(step.nodeId).toBe("1:2");
    expect(JSON.parse(step.reactions as string)[0].actions[0].destinationId).toBe("7:8");
    expect(calls[0]!.opts.session).toBe("s-2");
  });

  it("canonical ids and text that is not JSON pass through untouched", async () => {
    const { bridge, calls } = fakeBridge();
    const canonical = ' [ {"trigger":"ON_CLICK","action":{"type":"NODE","destinationId":"12:40"}} ] ';
    await forwardTool(bridge, "set_reactions", { nodeId: "1:2", reactions: canonical }, extra);
    await forwardTool(bridge, "set_reactions", { nodeId: "1:2", reactions: "not json" }, extra);
    expect(calls.map((c) => c.p.reactions)).toEqual([canonical, "not json"]);
  });

  it("a link with no node-id is refused with the path inside the JSON", async () => {
    const { bridge, calls } = fakeBridge();
    const r = await forwardTool(bridge, "set_reactions", { nodeId: "1:2", reactions: reactions("https://www.figma.com/design/K/Landing") }, extra);
    expect(structured(r)).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(String(structured(r).message)).toContain("reactions[0].action.destinationId");
    expect(calls).toEqual([]);
  });
});

describe("B-2: a NO_SESSION after the call reached the plugin is not safe to retry", () => {
  const safe = (err: unknown, opts?: { readOnly?: boolean }) => (errorResult(err, opts).structuredContent as { safeToRetry: boolean }).safeToRetry;

  it.each([
    ["queued, never sent", new BridgeError(ErrorCode.NO_SESSION, "gone"), {}, true],
    ["a write in flight when the plugin closed", new BridgeError(ErrorCode.NO_SESSION, "gone", { partial: { dispatched: true } }), {}, false],
    ["a read in flight when the plugin closed", new BridgeError(ErrorCode.NO_SESSION, "gone", { partial: { dispatched: true } }), { readOnly: true }, true],
  ])("%s → %s", (_label, err, opts, expected) => {
    expect(safe(err, opts)).toBe(expected);
  });

  const dropsAfter = (progress: boolean) => (opts: Record<string, unknown>) => {
    if (progress) (opts.onProgress as (p: { done: number; total?: number }) => void)({ done: 3, total: 10 });
    throw new BridgeError(ErrorCode.NO_SESSION, "The plugin disconnected.", { idempotencyKey: "k-1" });
  };

  it("progress from the plugin is the evidence: a write that reported progress is marked as sent", async () => {
    const sent = await forwardTool(fakeBridge([], dropsAfter(true)).bridge, "create_from_spec", { spec: {} }, extra);
    expect(structured(sent)).toMatchObject({ code: "NO_SESSION", idempotencyKey: "k-1", partial: { dispatched: true }, safeToRetry: false });
    const queued = await forwardTool(fakeBridge([], dropsAfter(false)).bridge, "create_from_spec", { spec: {} }, extra);
    expect(structured(queued)).toMatchObject({ code: "NO_SESSION", safeToRetry: true });
    expect(structured(queued).partial).toBeUndefined();
    const read = await forwardTool(fakeBridge([], dropsAfter(true)).bridge, "get_node", { nodeId: "1:2" }, extra);
    expect(structured(read).safeToRetry).toBe(true);
  });
});
