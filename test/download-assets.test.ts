// figma_download_assets — the asset half of design-to-code (gap G-06).
//
// Before it, the only way to get a hero image out of a design was to render
// the frame, which bakes the headline on top of it into the picture; the
// original image bytes were unreachable, and a designer's export presets were
// ignored. The plugin op is tested against a fake `figma`; the bridge half
// (naming, writing, refusing a bad directory before Figma renders anything)
// against real directories and a fake bridge.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { ASSET_LIMITS, EXPORT_OPS, type AssetFile } from "../src/plugin/ops/export.js";
import type { Bridge } from "../src/server/bridge.js";
import { assetFileName, sniffExt, type ExportRoots } from "../src/server/exports.js";
import { registerDownloadAssets, shapeAssets } from "../src/server/tools/export.js";
import type { Extra } from "../src/server/tools/forward.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const bytesOf = (...v: number[]) => new Uint8Array(v);

type Node = Record<string, unknown> & { id: string; name: string; type: string; children?: Node[] };
let nodes: Record<string, Node>;
let renders: Array<{ id: string; settings: Record<string, unknown> }>;
let images: Record<string, Uint8Array>;

function frame(id: string, name: string, props: Record<string, unknown> = {}, children: Node[] = []): Node {
  const n: Node = {
    id, name, type: "FRAME", children,
    exportAsync: async (settings: Record<string, unknown>) => {
      renders.push({ id, settings });
      return bytesOf(...PNG, id.length, String(settings.format).length);
    },
    ...props,
  };
  nodes[id] = n;
  for (const c of children) nodes[c.id] = c;
  return n;
}
const imageFill = (hash: string, extra: Record<string, unknown> = {}) => ({ type: "IMAGE", scaleMode: "FILL", imageHash: hash, ...extra });

beforeEach(() => {
  nodes = {};
  renders = [];
  images = {};
  (globalThis as { figma?: unknown }).figma = {
    currentPage: { id: "0:1", type: "PAGE", selection: [] },
    getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
    getImageByHash: (hash: string) =>
      images[hash] ? { getBytesAsync: async () => images[hash]!, getSizeAsync: async () => ({ width: 800, height: 600 }) } : null,
  };
});
afterAll(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const run = (params: Record<string, unknown>) =>
  EXPORT_OPS.download_assets!.run({
    requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
  } as OpContext) as Promise<{ items: Array<Record<string, unknown>>; files: AssetFile[]; base64: string; totalBytes: number; rawImagesTruncated?: true; imageErrors?: unknown[] }>;

describe("download_assets — plugin op", () => {
  it("a node's own export presets are honoured, each with its format and suffix", async () => {
    frame("1:1", "Logo", { exportSettings: [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }, { format: "SVG", suffix: "" }] });
    const r = await run({ nodeIds: ["1:1"], rawImages: false });
    expect(renders.map((x) => x.settings)).toEqual([{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }, { format: "SVG", suffix: "" }]);
    expect(r.files.map((f) => [f.kind, f.format, f.suffix])).toEqual([["render", "PNG", "@2x"], ["render", "SVG", undefined]]);
  });

  it("without presets — or when told to ignore them — one render in format at scale (default PNG at 2)", async () => {
    frame("1:1", "Card");
    frame("1:2", "Badge", { exportSettings: [{ format: "PDF", suffix: "" }] });
    await run({ nodeIds: ["1:1"], rawImages: false });
    await run({ nodeIds: ["1:2"], useExportSettings: false, format: "JPG", scale: 0.5, rawImages: false });
    expect(renders.map((x) => x.settings)).toEqual([
      { format: "PNG", constraint: { type: "SCALE", value: 2 } },
      { format: "JPG", constraint: { type: "SCALE", value: 0.5 } },
    ]);
  });

  it("original image bytes: one file per hash, with every layer that shows it", async () => {
    images = { h1: bytesOf(...JPG, 1), h2: bytesOf(...PNG, 2) };
    const photo = frame("2:2", "Photo", { fills: [imageFill("h1")] });
    const again = frame("2:3", "Thumb", { fills: [imageFill("h1"), imageFill("h2"), imageFill("hidden", { visible: false })] });
    frame("2:1", "Hero", { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }, [photo, again]);
    const r = await run({ nodeIds: ["2:1"] });
    const raw = r.files.filter((f) => f.kind === "image");
    expect(raw.map((f) => [f.imageHash, f.usedBy, f.width])).toEqual([["h1", ["2:2", "2:3"], 800], ["h2", ["2:3"], 800]]);
    // The payload is the bytes as stored, sliced by the manifest.
    const all = Buffer.from(r.base64, "base64");
    const h1 = raw[0]!;
    expect([...all.subarray(h1.offset, h1.offset + h1.length)]).toEqual([...images.h1!]);
    expect(r.totalBytes).toBe(all.length);
  });

  it(`at most ${ASSET_LIMITS.rawImages} raw images per call, and a flag when there were more`, async () => {
    const kids = Array.from({ length: 25 }, (_, i) => {
      images[`h${i}`] = bytesOf(...PNG, i);
      return frame(`3:${i + 10}`, `I${i}`, { fills: [imageFill(`h${i}`)] });
    });
    frame("3:1", "Gallery", {}, kids);
    const r = await run({ nodeIds: ["3:1"], useExportSettings: false });
    expect(r.files.filter((f) => f.kind === "image")).toHaveLength(20);
    expect(r.rawImagesTruncated).toBe(true);
  });

  it("one failing node or image does not lose the rest", async () => {
    frame("4:1", "Good", { fills: [imageFill("missing")] });
    nodes["4:2"] = { id: "4:2", name: "Doc", type: "DOCUMENT" };
    const r = await run({ nodeIds: ["4:1", "9:9", "4:2"] });
    expect(r.items.map((i) => [i.nodeId, i.ok])).toEqual([["4:1", true], ["9:9", false], ["4:2", false]]);
    expect(r.imageErrors).toEqual([{ imageHash: "missing", error: expect.stringContaining("no image"), usedBy: ["4:1"] }]);
  });

  it("refuses a bad call before rendering anything", async () => {
    frame("1:1", "Card");
    for (const bad of [{ nodeIds: [] }, { nodeIds: ["1:1"], format: "GIF" }, { nodeIds: ["1:1"], scale: 5 }, { nodeIds: Array.from({ length: 51 }, () => "1:1") }]) {
      await expect(run(bad)).rejects.toMatchObject({ code: "INVALID_PARAM" });
    }
    expect(renders).toEqual([]);
  });
});

describe("download_assets — the bridge writes the files", () => {
  const base = mkdtempSync(join(tmpdir(), "fmcp-assets-"));
  const roots: ExportRoots = { exportDir: join(base, "exports"), exportRoots: [] };

  function payload(files: Array<{ bytes: number[]; file: Omit<AssetFile, "offset" | "length"> }>, items = [{ nodeId: "1:2", name: "Hero / Card", ok: true }]) {
    let offset = 0;
    const manifest: AssetFile[] = [];
    const chunks: Buffer[] = [];
    for (const f of files) {
      manifest.push({ ...f.file, offset, length: f.bytes.length });
      chunks.push(Buffer.from(f.bytes));
      offset += f.bytes.length;
    }
    return { items, files: manifest, totalBytes: offset, base64: Buffer.concat(chunks).toString("base64") };
  }

  it("deterministic names, extensions from the bytes, and a re-run overwrites", async () => {
    const data = payload([
      { bytes: [...PNG, 1], file: { kind: "render", nodeId: "1:2", name: "Hero / Card", format: "PNG", suffix: "@2x", width: 10, height: 10 } },
      { bytes: [...PNG, 2], file: { kind: "render", nodeId: "1:2", name: "Hero / Card", format: "PNG", suffix: "@2x" } },
      { bytes: [...JPG, 3], file: { kind: "image", imageHash: "abc", width: 800, height: 600, usedBy: ["1:3"] } },
    ]);
    const first = (await shapeAssets(data, "assets", roots)).structuredContent as {
      dir: string;
      items: Array<{ files: Array<{ path: string }> }>;
      rawImages: Array<{ path: string; usedBy: string[] }>;
    };
    expect(first.dir).toBe(join(base, "exports", "assets"));
    const paths = first.items[0]!.files.map((f) => f.path);
    expect(paths).toEqual([join(base, "exports", "assets", "Hero-Card-1-2@2x.png"), join(base, "exports", "assets", "Hero-Card-1-2@2x-2.png")]);
    expect(first.rawImages[0]!.path).toBe(join(base, "exports", "assets", "abc.jpg"));
    expect(first.rawImages[0]!.usedBy).toEqual(["1:3"]);

    const changed = payload([{ bytes: [...PNG, 9], file: { kind: "render", nodeId: "1:2", name: "Hero / Card", format: "PNG", suffix: "@2x" } }]);
    const second = (await shapeAssets(changed, "assets", roots)).structuredContent as { items: Array<{ files: Array<{ path: string }> }> };
    expect(second.items[0]!.files[0]!.path).toBe(paths[0]);
    expect([...readFileSync(paths[0]!)]).toEqual([...PNG, 9]);
  });

  it("names: the suffix is kept as Figma writes it, an instance id is flattened, magic bytes pick the extension", () => {
    expect(assetFileName("Icon", "I1:2;3:4", "@3x", ".png")).toBe("Icon-I1-2-3-4@3x.png");
    expect(assetFileName("", "5:6", undefined, ".svg")).toBe("node-5-6.svg");
    expect(sniffExt(bytesOf(...PNG))).toBe(".png");
    expect(sniffExt(bytesOf(...JPG))).toBe(".jpg");
    expect(sniffExt(bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(".gif");
    expect(sniffExt(bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(".webp");
    expect(sniffExt(bytesOf(1, 2, 3))).toBe(".bin");
  });

  it("the registered tool refuses a directory outside the roots before Figma is asked", async () => {
    const tools: Record<string, { config: { description: string; inputSchema: Record<string, unknown> }; handler: (a: Record<string, unknown>, e: Extra) => Promise<CallToolResult> }> = {};
    const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
    const requests: Array<{ op: string; p: Record<string, unknown> }> = [];
    const bridge = {
      request: async (op: string, p: Record<string, unknown>) => {
        requests.push({ op, p });
        return payload([{ bytes: [...PNG, 1], file: { kind: "render", nodeId: "1:2", name: "Card", format: "PNG" } }], [{ nodeId: "1:2", name: "Card", ok: true }]);
      },
      statusAsync: async () => ({ sessions: [] }),
    } as unknown as Bridge;
    registerDownloadAssets(server, bridge, roots, () => true);
    const tool = tools.figma_download_assets!;
    expect(Object.keys(tool.config.inputSchema)).toEqual(["nodeIds", "format", "scale", "useExportSettings", "rawImages", "dir", "session"]);
    // Whole, within the 1024-character cap the portability guard enforces once it is registered.
    expect(tool.config.description).toMatch(/files the code ships\.$/);
    expect(tool.config.description.length).toBeLessThanOrEqual(1024);
    const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

    const refused = await tool.handler({ nodeIds: ["1:2"], dir: join(base, "..", "elsewhere") }, extra);
    expect(refused.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(requests).toEqual([]);

    const ok = await tool.handler({ nodeIds: ["1-2"], scale: 1 }, extra);
    expect(requests[0]).toEqual({ op: "download_assets", p: { nodeIds: ["1:2"], scale: 1 } });
    const path = (ok.structuredContent as { items: Array<{ files: Array<{ path: string }> }> }).items[0]!.files[0]!.path;
    expect(existsSync(path)).toBe(true);
  });

  it("is not registered unless the toolset wants it", () => {
    const names: string[] = [];
    registerDownloadAssets({ registerTool: (n: string) => void names.push(n) } as unknown as McpServer, {} as Bridge, roots, () => false);
    expect(names).toEqual([]);
  });
});
