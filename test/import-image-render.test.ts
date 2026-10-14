// figma_import_image { renderNodeId }: a layer of this file rendered to a
// picture inside the sandbox (exportAsync, then createImage) and placed as an
// image fill — how a styleframe is snapshotted into a storyboard thumbnail.
// createImage takes at most 4096 px a side [C-076], so a render over the cap
// is refused before anything renders, and a default size never exceeds it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { editorsSuffix } from "../src/shared/editors.js";
import { BridgeError } from "../src/shared/errors.js";
import { ASSET_OPS } from "../src/plugin/ops/assets.js";
import type { Bridge } from "../src/server/bridge.js";
import type { Extra } from "../src/server/tools/forward.js";
import { registerTypography } from "../src/server/tools/typography.js";
import { installFigma, opContext, type FakeNode } from "./editor-fakes.js";
import { WFrame, WriteFigma } from "./write-fakes.js";

type Any = Record<string, unknown>;

class ImageFigma extends WriteFigma {
  readonly made: Uint8Array[] = [];
  createImage(bytes: Uint8Array): { hash: string; getSizeAsync(): Promise<{ width: number; height: number }> } {
    this.made.push(bytes);
    return { hash: `render-${this.made.length}`, getSizeAsync: async () => ({ width: 1, height: 1 }) };
  }
}

let fake: ImageFigma;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
function file(): ImageFigma {
  fake = new ImageFigma();
  restore = installFigma(fake);
  return fake;
}

const run = (params: Any) => ASSET_OPS.import_image!.run(opContext(params)) as Promise<Any>;
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}

/** A frame that renders through a recorded exportAsync. */
function layer(width: number, height: number, renders: Any[]): WFrame {
  const f = fake.frame();
  f.resize(width, height);
  (f as unknown as Any).exportAsync = async (settings: Any) => {
    renders.push(settings);
    return new Uint8Array(32);
  };
  return f;
}
const fills = (n: FakeNode) => (n as unknown as Any).fills;

describe("renderNodeId → exportAsync → createImage → fill", () => {
  it("fills the target at twice its width, rendered in the sandbox", async () => {
    file();
    const renders: Any[] = [];
    const styleframe = layer(1080, 1920, renders);
    const thumb = fake.frame();
    thumb.resize(216, 384);
    const r = await run({ renderNodeId: styleframe.id, nodeId: thumb.id });
    expect(renders).toEqual([{ format: "PNG", constraint: { type: "WIDTH", value: 432 } }]);
    expect(fills(thumb)).toEqual([{ type: "IMAGE", imageHash: "render-1", scaleMode: "FILL" }]);
    expect(r).toMatchObject({ id: thumb.id, applied: "fill", imageHash: "render-1", rendered: { nodeId: styleframe.id, width: 432, height: 768 } });
  });

  it("renderWidth sets the pixels; the height follows the layer", async () => {
    file();
    const renders: Any[] = [];
    const styleframe = layer(1080, 1920, renders);
    const thumb = fake.frame();
    const r = await run({ renderNodeId: styleframe.id, nodeId: thumb.id, renderWidth: 1000, scaleMode: "fit" });
    expect(renders).toEqual([{ format: "PNG", constraint: { type: "WIDTH", value: 1000 } }]);
    expect(fills(thumb)).toEqual([{ type: "IMAGE", imageHash: "render-1", scaleMode: "FIT" }]);
    expect(r.rendered).toEqual({ nodeId: styleframe.id, width: 1000, height: 1778 });
  });

  it("without a target, a new rectangle takes the layer's own size, rendered at 2x", async () => {
    file();
    const renders: Any[] = [];
    const styleframe = layer(1080, 1920, renders);
    const host = fake.frame();
    const r = await run({ renderNodeId: styleframe.id, parentId: host.id, name: "SF snapshot" });
    expect(renders).toEqual([{ format: "PNG", constraint: { type: "WIDTH", value: 2160 } }]);
    expect(r).toMatchObject({ type: "RECTANGLE", name: "SF snapshot", width: 1080, height: 1920, natural: { width: 2160, height: 3840 } });
    const rect = fake.nodes.get(r.id as string)!;
    expect(rect.parent).toBe(host);
    expect(fills(rect)).toEqual([{ type: "IMAGE", imageHash: "render-1", scaleMode: "FILL" }]);
    const half = await run({ renderNodeId: styleframe.id, parentId: host.id, width: 540 });
    expect(renders[1]).toEqual({ format: "PNG", constraint: { type: "WIDTH", value: 1080 } });
    expect([half.width, half.height]).toEqual([540, 960]);
  });

  it("a default size never passes the cap: a tall layer for a wide target renders 4096 tall", async () => {
    file();
    const renders: Any[] = [];
    const tall = layer(1000, 2000, renders);
    const big = fake.frame();
    big.resize(3000, 3000);
    const r = await run({ renderNodeId: tall.id, nodeId: big.id });
    expect(renders).toEqual([{ format: "PNG", constraint: { type: "WIDTH", value: 2048 } }]);
    expect(r.rendered).toEqual({ nodeId: tall.id, width: 2048, height: 4096 });
  });
});

describe("refused before anything renders or exists", () => {
  it.each<[string, (renders: Any[]) => Any, string, RegExp]>([
    ["renderNodeId with url", (rs) => ({ renderNodeId: layer(10, 10, rs).id, url: "https://example.com/a.png" }), "INVALID_PARAM", /exactly one image source: `url`, `path` or `renderNodeId`/],
    ["renderWidth without renderNodeId", () => ({ url: "https://example.com/a.png", renderWidth: 200 }), "INVALID_PARAM", /`renderWidth` sizes a `renderNodeId` render/],
    ["a render taller than 4096 px", (rs) => ({ renderNodeId: layer(1080, 1920, rs).id, renderWidth: 4096 }), "INVALID_PARAM", /4096 × 7282 px picture; Figma takes images up to 4096 px a side/],
    ["a renderWidth below 16", (rs) => ({ renderNodeId: layer(10, 10, rs).id, renderWidth: 8 }), "INVALID_PARAM", /renderWidth` must be a whole number of pixels from 16 to 4096/],
    ["an unknown node", () => ({ renderNodeId: "404:1" }), "NODE_NOT_FOUND", /renderNodeId`: no node with id `404:1`/],
    ["a node that cannot be exported", () => ({ renderNodeId: fake.frame().id }), "INVALID_PARAM", /cannot be rendered to a picture/],
  ])("%s", async (_label, params, code, message) => {
    file();
    const renders: Any[] = [];
    const args = params(renders);
    const before = fake.log.filter((l) => l.startsWith("create")).length;
    const e = await refusal(run(args));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
    expect(e.partial).toEqual({ created: [] });
    expect(renders).toEqual([]);
    expect(fake.made).toEqual([]);
    expect(fake.log.filter((l) => l.startsWith("create")).length).toBe(before);
  });

  it("the refusal over the cap names the widest render that fits", async () => {
    file();
    const e = await refusal(run({ renderNodeId: layer(1080, 1920, []).id, renderWidth: 4096 }));
    expect(e.hint).toBe("Render it at most 2304 px wide.");
  });

  it("a render Figma fails is reported, with nothing created", async () => {
    file();
    const broken = fake.frame();
    (broken as unknown as Any).exportAsync = async () => {
      throw new Error("out of memory");
    };
    const e = await refusal(run({ renderNodeId: broken.id }));
    expect(e.message).toMatch(/Figma could not render .*out of memory/);
    expect(e.partial).toEqual({ created: [] });
  });
});

describe("figma_import_image on the server", () => {
  type Tool = { config: { description: string; inputSchema: Record<string, z.ZodTypeAny> }; handler: (a: Any, e: Extra) => Promise<CallToolResult> };
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
  const requests: Array<{ op: string; p: Any }> = [];
  const bridge = {
    request: async (op: string, p: Any) => {
      requests.push({ op, p });
      return { id: "1:1" };
    },
    statusAsync: async () => ({ sessions: [] }),
  } as unknown as Bridge;
  const dir = mkdtempSync(join(tmpdir(), "fmcp-render-"));
  registerTypography(server, bridge, { exportDir: dir, exportRoots: [] }, (op) => op === "import_image");
  const tool = tools.figma_import_image!;
  const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

  it("takes renderNodeId and renderWidth, and says so within the cap", () => {
    expect(Object.keys(tool.config.inputSchema)).toEqual(expect.arrayContaining(["renderNodeId", "renderWidth"]));
    expect(tool.config.inputSchema.renderWidth!.safeParse(4097).success).toBe(false);
    expect(tool.config.inputSchema.renderWidth!.safeParse(12.5).success).toBe(false);
    expect(tool.config.description).toMatch(/renderNodeId/);
    expect(tool.config.description).toMatch(/figma_export_node returns its picture to you instead of placing it\.$/);
    expect(tool.config.description.length + editorsSuffix("import_image").length).toBeLessThanOrEqual(1024);
  });

  it("two sources, or renderWidth alone, are refused before the bridge is asked", async () => {
    for (const args of [{ renderNodeId: "1:2", url: "https://example.com/a.png" }, { renderNodeId: "1:2", path: "a.png" }, { url: "https://example.com/a.png", renderWidth: 300 }]) {
      const res = await tool.handler(args, extra);
      expect(res.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    }
    expect(requests).toEqual([]);
  });

  it("a layer link or a URL-form id becomes an id the plugin resolves", async () => {
    await tool.handler({ renderNodeId: "12-34", nodeId: "5-6" }, extra);
    expect(requests).toEqual([{ op: "import_image", p: { renderNodeId: "12:34", nodeId: "5:6" } }]);
  });
});
