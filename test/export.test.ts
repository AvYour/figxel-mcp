// figma_export_node: the plugin op against a fake `figma`, the path guard on
// real directories, the result shaping, and the whole path through a real MCP
// client and the mock plugin.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { EXPORT_OPS, encodeBase64, imageSize } from "../src/plugin/ops/export.js";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { defaultExportName, formatFromPath, resolveSavePath, type ExportRoots } from "../src/server/exports.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { INLINE_LIMIT, shapeExport } from "../src/server/tools/export.js";
import { quietLogger, startMock, type MockPlugin } from "./helpers.js";

describe("encodeBase64 — plain JS, sliced", () => {
  it("matches Buffer for every padding case and across slice boundaries", async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 3 * 128 * 1024 - 1, 3 * 128 * 1024, 3 * 128 * 1024 + 2, 1_000_001]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
      expect(await encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("yields between slices, not after the last", async () => {
    let yields = 0;
    await encodeBase64(new Uint8Array(3 * 128 * 1024 * 2 + 10), async () => void yields++);
    expect(yields).toBe(2);
  });
});

describe("export_node — plugin op", () => {
  const calls: Record<string, unknown>[] = [];
  const png = new Uint8Array([137, 80, 78, 71]);
  const nodes: Record<string, unknown> = {
    "1:1": { id: "1:1", name: "Card", type: "FRAME", exportAsync: async (s: Record<string, unknown>) => (calls.push(s), png) },
    "0:1": { id: "0:1", name: "Doc", type: "DOCUMENT" },
  };
  beforeAll(() => {
    (globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => nodes[id] ?? null };
  });
  afterAll(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });
  afterEach(() => void (calls.length = 0));

  const run = (params: Record<string, unknown>) =>
    EXPORT_OPS.export_node!.run({
      requestId: "r-1", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
    } as OpContext) as Promise<Record<string, unknown>>;
  async function fails(params: Record<string, unknown>): Promise<BridgeError> {
    try {
      await run(params);
    } catch (e) {
      return e as BridgeError;
    }
    throw new Error("expected a rejection");
  }

  it("PNG carries a scale constraint and returns base64 with its byte count", async () => {
    const r = await run({ nodeId: "1:1", scale: 2 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    expect(r).toEqual({ nodeId: "1:1", name: "Card", format: "PNG", scale: 2, mime: "image/png", bytes: 4, base64: "iVBORw==" });
  });

  it("vector formats get no pixel constraint and report no scale", async () => {
    const r = await run({ nodeId: "1:1", format: "svg", scale: 3 });
    expect(calls[0]).toEqual({ format: "SVG" });
    expect(r).not.toHaveProperty("scale");
    expect(r.mime).toBe("image/svg+xml");
  });

  it("refuses bad input and unexportable nodes with a clear code", async () => {
    expect((await fails({ nodeId: "1:1", format: "GIF" })).code).toBe("INVALID_PARAM");
    expect((await fails({ nodeId: "1:1", scale: 0 })).code).toBe("INVALID_PARAM");
    expect((await fails({ nodeId: "9:9" })).code).toBe("NODE_NOT_FOUND");
    expect((await fails({ nodeId: "0:1" })).code).toBe("UNSUPPORTED");
    expect(calls).toEqual([]);
  });
});

describe("exports.ts — where a file may land", () => {
  const base = mkdtempSync(join(tmpdir(), "fmcp-exp-"));
  const roots: ExportRoots = { exportDir: join(base, "exports"), exportRoots: [join(base, "public")] };
  mkdirSync(join(base, "public"));
  mkdirSync(join(base, "outside"));

  it("a relative path resolves inside the export dir", async () => {
    expect(await resolveSavePath("shots/hero.png", roots)).toBe(join(base, "exports", "shots", "hero.png"));
  });

  it("an absolute path inside an extra root is allowed", async () => {
    const p = join(base, "public", "img", "a.png");
    expect(await resolveSavePath(p, roots)).toBe(p);
  });

  it("escapes are refused before anything is created", async () => {
    for (const bad of ["../outside/x.png", join(base, "outside", "x.png"), join(base, "exports"), "  "]) {
      await expect(resolveSavePath(bad, roots)).rejects.toMatchObject({ code: "INVALID_PARAM" });
    }
    expect(existsSync(join(base, "outside", "x.png"))).toBe(false);
  });

  it("a link inside a root that points outside is refused", async () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(join(base, "outside"), join(base, "public", "escape"), "junction");
    await expect(resolveSavePath(join(base, "public", "escape", "x.png"), roots)).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("names and extensions", () => {
    expect(formatFromPath("a/b.JPEG")).toBe("JPG");
    expect(formatFromPath("x.svg")).toBe("SVG");
    expect(formatFromPath("noext")).toBeUndefined();
    expect(defaultExportName("Hero / Card", "12:34", "PDF", new Date("2026-10-07T00:00:00Z"))).toBe(
      "Hero-Card-12-34-2026-10-07T00-00-00-000Z.pdf",
    );
  });
});

describe("shapeExport — what the model receives", () => {
  const base = mkdtempSync(join(tmpdir(), "fmcp-shape-"));
  const roots: ExportRoots = { exportDir: join(base, "exports"), exportRoots: [] };
  const data = (over: Record<string, unknown> = {}) => ({
    nodeId: "1:1", name: "Card", format: "PNG", scale: 1, mime: "image/png", bytes: 4, base64: "iVBORw==", ...over,
  });

  it("a small PNG is an image block, with no structuredContent to shadow it", async () => {
    const r = await shapeExport(data(), undefined, roots);
    expect(r.content[0]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
    expect(r.structuredContent).toBeUndefined();
  });

  it("SVG comes back as markup", async () => {
    const svg = "<svg/>";
    const r = await shapeExport(data({ format: "SVG", mime: "image/svg+xml", base64: Buffer.from(svg).toString("base64") }), undefined, roots);
    expect(r.content[1]).toEqual({ type: "text", text: svg });
  });

  it("PDF and over-limit renders go to a file and say why", async () => {
    const pdf = await shapeExport(data({ format: "PDF", mime: "application/pdf" }), undefined, roots);
    const big = await shapeExport(data({ bytes: INLINE_LIMIT + 1 }), undefined, roots);
    for (const [r, note] of [[pdf, /PDF/], [big, /5 MB/]] as const) {
      const s = r.structuredContent as { path: string; note: string };
      expect(s.note).toMatch(note);
      expect(readFileSync(s.path)).toEqual(Buffer.from("iVBORw==", "base64"));
    }
  });

  it("saveTo writes exactly there", async () => {
    const r = await shapeExport(data(), "named/card.png", roots);
    expect((r.structuredContent as { path: string }).path).toBe(join(base, "exports", "named", "card.png"));
  });
});

describe("figma_export_node — through MCP and the mock plugin", () => {
  let app: App;
  let client: Client;
  let mock: MockPlugin;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fmcp-export-"));
    const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "2000" });
    const token = readOrCreateToken(config.tokenPath);
    app = await createApp(config, token, quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "export-tools", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    mock = startMock({ token, port: app.bridge.port });
    await mock.welcomed();
  });
  afterAll(async () => {
    mock.close();
    await client.close();
    await app.close();
  });
  const sent = () => mock.received.filter((m) => m.t === "request" && m.op === "export_node");

  it("returns an image the model can see", async () => {
    const r = (await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", scale: 2 } })) as {
      content: { type: string; mimeType?: string }[];
    };
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "PNG", scale: 2 });
  });

  it("saveTo stays in the bridge, sets the format from its extension, and writes the file", async () => {
    const r = await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", saveTo: "logo.svg" } });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "SVG" });
    const path = (r.structuredContent as { path: string }).path;
    expect(path).toBe(join(home, "exports", "logo.svg"));
    expect(readFileSync(path, "utf8")).toMatch(/^<svg/);
  });

  it("a path outside the roots, or a format that contradicts it, never reaches Figma", async () => {
    const before = sent().length;
    const escape = await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", saveTo: "../../x.png" } });
    const clash = await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", saveTo: "a.png", format: "PDF" } });
    expect(escape.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(clash.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(sent().length).toBe(before);
    expect(existsSync(join(home, "x.png"))).toBe(false);
  });

  // G-03: an inline look is capped at 1024 px unless the agent asks for a size [C-092].
  it("an inline PNG with no scale is sent with maxSize 1024; a scale or a saveTo is not", async () => {
    await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1" } });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "PNG", maxSize: 1024 });
    await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", scale: 2 } });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "PNG", scale: 2 });
    await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", saveTo: "full.png" } });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "PNG" });
    await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", maxSize: 512, saveTo: "small.png" } });
    expect(sent().at(-1)!.params).toEqual({ nodeId: "1:1", format: "PNG", maxSize: 512 });
  });

  it("nodeId is optional (the plugin uses the selection), and scale with maxSize is refused before Figma", async () => {
    await client.callTool({ name: "figma_export_node", arguments: {} });
    expect(sent().at(-1)!.params).toEqual({ format: "PNG", maxSize: 1024 });
    const before = sent().length;
    const both = await client.callTool({ name: "figma_export_node", arguments: { nodeId: "1:1", scale: 2, maxSize: 512 } });
    expect(both.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(sent().length).toBe(before);
  });

  it("the description survives the 1024-character cap whole, and points at figma_download_assets", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "figma_export_node")!.description).toMatch(/use figma_download_assets\.$/);
  });

  it("a pasted link reaches the plugin as an id", async () => {
    await client.callTool({ name: "figma_export_node", arguments: { nodeId: "https://www.figma.com/design/K1/Mock-File?node-id=1-1", scale: 1 } });
    expect(sent().at(-1)!.params).toMatchObject({ nodeId: "1:1" });
  });
});

/** A PNG's first 24 bytes: signature, IHDR length and type, then width and height. */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe("export_node — size cap, selection and meta [G-03]", () => {
  const calls: Record<string, unknown>[] = [];
  let selection: unknown[] = [];
  const frame = (id: string, w: number, h: number, out = pngHeader(w, h)) => ({
    id, name: `F${id}`, type: "FRAME", x: 10, y: 20, width: w, height: h,
    exportAsync: async (s: Record<string, unknown>) => (calls.push(s), out),
  });
  const nodes: Record<string, unknown> = { "2:1": frame("2:1", 1440, 5000), "2:2": frame("2:2", 300, 200), "2:3": frame("2:3", 5000, 1440) };
  beforeEach(() => {
    calls.length = 0;
    selection = [];
    (globalThis as { figma?: unknown }).figma = {
      getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
      get currentPage() {
        return { id: "0:1", type: "PAGE", selection };
      },
    };
  });
  afterAll(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });
  const run = (params: Record<string, unknown>) =>
    EXPORT_OPS.export_node!.run({
      requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
    } as OpContext) as Promise<Record<string, unknown>>;

  it("holds the longest side to maxSize and never upscales; an explicit scale is not capped", async () => {
    const tall = await run({ nodeId: "2:1", maxSize: 1024 });
    expect(calls[0]).toEqual({ format: "PNG", constraint: { type: "HEIGHT", value: 1024 } });
    expect(tall.capped).toBe(true);
    await run({ nodeId: "2:3", maxSize: 1024 });
    expect(calls[1]).toEqual({ format: "PNG", constraint: { type: "WIDTH", value: 1024 } });
    const small = await run({ nodeId: "2:2", maxSize: 1024 });
    expect(calls[2]).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    expect(small.capped).toBeUndefined();
    await run({ nodeId: "2:1", scale: 2 });
    expect(calls[3]).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  });

  it("reports the node's bounds and the picture's pixel size, read from its header", async () => {
    const r = await run({ nodeId: "2:2" });
    expect(r.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect([r.pixelWidth, r.pixelHeight]).toEqual([300, 200]);
    expect(r.pixelEstimate).toBeUndefined();
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 120, 0, 160, 3, 0, 0, 0, 0]);
    nodes["2:4"] = frame("2:4", 160, 120, jpg);
    const j = await run({ nodeId: "2:4", format: "JPG" });
    expect([j.pixelWidth, j.pixelHeight]).toEqual([160, 120]);
    nodes["2:5"] = frame("2:5", 100, 50, new Uint8Array([1, 2, 3]));
    const e = await run({ nodeId: "2:5", scale: 2 });
    expect(e).toMatchObject({ pixelWidth: 200, pixelHeight: 100, pixelEstimate: true });
  });

  it("with no nodeId, uses the one selected layer; none or several is refused with the count", async () => {
    selection = [nodes["2:2"]];
    expect((await run({})).nodeId).toBe("2:2");
    for (const sel of [[], [nodes["2:1"], nodes["2:2"]]]) {
      selection = sel;
      await expect(run({})).rejects.toMatchObject({ code: "INVALID_PARAM", message: expect.stringContaining(`(${sel.length} selected)`) });
    }
    expect(calls).toHaveLength(1);
  });

  it("imageSize reads PNG and JPEG headers, and nothing else", () => {
    expect(imageSize(pngHeader(7, 9))).toEqual({ width: 7, height: 9 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("shapeExport carries the bounds and pixel size into the meta", () => {
  const base = mkdtempSync(join(tmpdir(), "fmcp-meta-"));
  it("the text block next to the image says where and how big", async () => {
    const r = await shapeExport(
      { nodeId: "1:1", name: "Card", format: "PNG", scale: 0.2, mime: "image/png", bytes: 4, base64: "iVBORw==", bounds: { x: 0, y: 0, width: 1440, height: 5000 }, pixelWidth: 295, pixelHeight: 1024, capped: true },
      undefined,
      { exportDir: join(base, "e"), exportRoots: [] },
    );
    expect(JSON.parse((r.content[1] as { text: string }).text)).toMatchObject({ bounds: { width: 1440, height: 5000 }, pixelWidth: 295, pixelHeight: 1024, capped: true });
  });
});
