// figma_export_video [C-116]: the plugin op against a fake top-level frame, the
// settings the typings allow per format, and the bridge side through a real MCP
// client — validation before Figma is asked, the file always written, frames
// pulled out with ffmpeg (stubbed) frame-exactly or a note when ffmpeg is
// missing. Also the schema of every motion tool, checked against the portable
// subset before they are wired into the catalog. Job mode is
// test/export-video-jobs.test.ts.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorsSuffix } from "../src/shared/editors.js";
import { expectedFrames, frameAt, frameSeek, videoSettings } from "../src/shared/video.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MOTION_OPS } from "../src/plugin/ops/motion.js";
import type { Bridge } from "../src/server/bridge.js";
import { registerMotion, VIDEO_IDLE_TIMEOUT_MS, type ExecFileLike } from "../src/server/tools/motion.js";

// ── the plugin op ────────────────────────────────────────────────────────────

describe("export_video in the plugin", () => {
  type V = { id: string; name: string; type: string; parent: unknown; [k: string]: unknown };
  let calls: Array<Record<string, unknown>>;
  let frame: V;
  let card: V;
  const page = { id: "0:1", name: "Page", type: "PAGE" };
  const run = (params: Record<string, unknown>) =>
    MOTION_OPS.export_video!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<Record<string, unknown>>;

  beforeEach(() => {
    calls = [];
    frame = {
      id: "1:1", name: "Hero", type: "FRAME", parent: page,
      timelines: [{ id: "TL:1", duration: 0.8 }],
      exportAsync: async (s: Record<string, unknown>) => {
        calls.push(s);
        return new Uint8Array([71, 73, 70, 56]); // "GIF8"
      },
    };
    card = { id: "1:2", name: "Card", type: "RECTANGLE", parent: frame, getTopLevelFrame: () => frame };
    const nodes = new Map<string, V>([[frame.id, frame], [card.id, card]]);
    (globalThis as { figma?: unknown }).figma = { currentPage: page, root: { name: "d" }, getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null };
  });
  afterEach(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });

  it("exports the top-level frame around a layer, with the settings the format takes", async () => {
    const r = await run({ nodeId: card.id, format: "GIF", fps: 12, loopCount: 0, width: 320 });
    expect(calls).toEqual([{ format: "GIF", fps: 12, loopCount: 0, constraint: { type: "WIDTH", value: 320 } }]);
    expect(r).toMatchObject({ nodeId: card.id, exportedNodeId: frame.id, format: "GIF", mime: "image/gif", bytes: 4, durationS: 0.8, base64: "R0lGOA==" });
  });

  it("a frame with nothing animated comes back UNSUPPORTED with what to do", async () => {
    frame.exportAsync = async () => {
      throw new Error("Node has no animation to export");
    };
    await expect(run({ nodeId: frame.id })).rejects.toMatchObject({ code: "UNSUPPORTED", hint: expect.stringMatching(/figma_set_keyframes/) });
  });

  it("a render Figma ran out of time for is TIMEOUT, to render again — not UNSUPPORTED, which says stop [C-198]", async () => {
    // Figma's words on 2026-10-13, for frames that rendered at another fps seconds later.
    frame.exportAsync = async () => {
      throw new Error("Video export timed out");
    };
    const err = await run({ nodeId: card.id, fps: 30 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TIMEOUT", message: 'Figma gave up rendering "Hero" as MP4: Video export timed out' });
    const hint = (err as { hint: string }).hint;
    expect(hint).toMatch(/about 4 minutes; the frame is not at fault/);
    expect(hint).toMatch(/restored[\s\S]*render again[\s\S]*a lower `fps`, a smaller `width`, or a shorter timeline/);
    expect(hint).not.toMatch(/keyframes/);
  });

  it("a layer outside any top-level frame is refused before Figma renders", async () => {
    card.getTopLevelFrame = () => undefined;
    await expect(run({ nodeId: card.id })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    expect(calls).toEqual([]);
  });
});

describe("video settings follow the typings per format [C-116]", () => {
  it("accepts each format's own options", () => {
    expect(videoSettings({})).toEqual({ format: "MP4" });
    expect(videoSettings({ format: "webm", fps: 60, quality: "low", scale: 0.5 })).toEqual({ format: "WEBM", fps: 60, quality: "LOW", constraint: { type: "SCALE", value: 0.5 } });
    expect(videoSettings({ format: "GIF", fps: 8, loopCount: 3, height: 240 })).toEqual({ format: "GIF", fps: 8, loopCount: 3, constraint: { type: "HEIGHT", value: 240 } });
  });

  it("refuses what one format does not take", () => {
    expect(() => videoSettings({ format: "MP4", fps: 15 })).toThrow(/not offered for MP4/);
    expect(() => videoSettings({ format: "GIF", fps: 60 })).toThrow(/not offered for GIF/);
    expect(() => videoSettings({ format: "GIF", quality: "HIGH" })).toThrow(/applies to MP4 and WEBM/);
    expect(() => videoSettings({ format: "MP4", loopCount: 1 })).toThrow(/GIF only/);
    expect(() => videoSettings({ width: 320, scale: 2 })).toThrow(/at most one/);
    expect(() => videoSettings({ scale: 5 })).toThrow(/not an export scale/);
    expect(() => videoSettings({ format: "MOV" })).toThrow(/MP4, GIF or WEBM/);
  });
});

describe("frame arithmetic [C-193] [C-194] [C-195]", () => {
  it("frame k is sought a quarter frame early, never before 0", () => {
    expect(frameSeek(0, 30)).toBe(0);
    expect(frameSeek(15, 30)).toBe(0.491667);
    expect(frameSeek(432, 30)).toBe(14.391667);
    expect(frameSeek(6, 15)).toBe(0.383333);
    // At 60 fps the quarter frame is 4 ms: still inside frame k's interval.
    expect(frameSeek(1, 60)).toBe(0.0125);
  });

  it("seconds map to the nearest frame; the end frame renders too", () => {
    expect(frameAt(0.4, 30)).toBe(12);
    expect(frameAt(0.41, 30)).toBe(12);
    expect(frameAt(0.4, 15)).toBe(6);
    expect(expectedFrames(14.4, 30)).toBe(433);
    expect(expectedFrames(0.8, 15)).toBe(13);
    // Every format counts to the first frame at or after the end, of the duration Figma keeps to the
    // microsecond (measured: 1.2 s at 12 fps, 16 GIF frames; 89/30 s, 91 MP4 frames) [C-194].
    expect(expectedFrames(1.2, 12)).toBe(16);
    expect(expectedFrames(0.8, 24)).toBe(21);
    expect(expectedFrames(89 / 30, 30)).toBe(91);
  });
});

// ── the bridge side ──────────────────────────────────────────────────────────

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
/** What ffprobe says of a 0.8 s GIF at Figma's default 15 fps: 13 frames, the end frame included. */
const PROBE_GIF = { streams: [{ width: 320, height: 240, r_frame_rate: "15/1", avg_frame_rate: "15/1", nb_read_frames: "13" }], format: { duration: "0.866667" } };

describe("figma_export_video through MCP", () => {
  let client: Client;
  let requests: Array<{ op: string; params: Record<string, unknown>; opts: Record<string, unknown> }>;
  let ffmpeg: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>;
  let ffmpegMissing: boolean;
  let exportDir: string;

  beforeEach(async () => {
    requests = [];
    ffmpeg = [];
    ffmpegMissing = false;
    exportDir = mkdtempSync(join(tmpdir(), "fmcp-video-"));
    const bridge = {
      request: async (op: string, params: Record<string, unknown>, opts: Record<string, unknown>) => {
        requests.push({ op, params, opts });
        const format = String(params.format);
        return { nodeId: params.nodeId, exportedNodeId: "1:1", name: "Hero", format, mime: "video/mp4", bytes: 4, durationS: 0.8, base64: Buffer.from("vid!").toString("base64") };
      },
    } as unknown as Bridge;
    const exec: ExecFileLike = (file, args, options, callback) => {
      ffmpeg.push({ file, args, options });
      if (ffmpegMissing) callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }), Buffer.alloc(0), Buffer.alloc(0));
      else if (file === "ffprobe") callback(null, Buffer.from(JSON.stringify(PROBE_GIF)), Buffer.alloc(0));
      else callback(null, PNG, Buffer.alloc(0));
      return undefined;
    };
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    registerMotion(server, bridge, { exportDir, exportRoots: [] }, () => true, { execFile: exec });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "video-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
  });

  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "figma_export_video", arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> }>;

  it("refuses bad settings and bad paths before Figma is asked to render", async () => {
    for (const args of [
      { nodeId: "1:2", format: "MP4", fps: 15 },
      { nodeId: "1:2", format: "GIF", quality: "HIGH" },
      { nodeId: "1:2", saveTo: "anim.png" },
      { nodeId: "1:2", saveTo: "anim.gif", format: "MP4" },
      { nodeId: "1:2", saveTo: "../../outside.mp4" },
      { nodeId: "1:2", width: 320, scale: 2 },
    ]) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it("always writes a file — the extension from the format, or the format from saveTo — and waits long enough", async () => {
    const r = await call({ nodeId: "1:2", saveTo: "hero" });
    const meta = JSON.parse(r.content[0]!.text!);
    expect(meta.path).toBe(join(exportDir, "hero.mp4"));
    expect(readFileSync(meta.path, "utf8")).toBe("vid!");
    expect(meta).toMatchObject({ format: "MP4", exportedNodeId: "1:1", durationS: 0.8 });
    expect(requests[0]!.op).toBe("export_video");
    expect(requests[0]!.params).toEqual({ nodeId: "1:2", format: "MP4" }); // saveTo and frames stay with the bridge
    expect(requests[0]!.opts.idleTimeoutMs).toBe(VIDEO_IDLE_TIMEOUT_MS);

    const gif = JSON.parse((await call({ nodeId: "1:2", saveTo: "loop.gif", fps: 12 })).content[0]!.text!);
    expect(gif.format).toBe("GIF");
    expect(requests[1]!.params).toEqual({ nodeId: "1:2", format: "GIF", fps: 12 });

    const unnamed = JSON.parse((await call({ nodeId: "1:2", format: "WEBM" })).content[0]!.text!);
    expect(unnamed.path.startsWith(exportDir)).toBe(true);
    expect(unnamed.path.endsWith(".webm")).toBe(true);
    expect(existsSync(unnamed.path)).toBe(true);
  });

  it("returns the requested moments as PNG images, frame-exact and extracted without a shell [C-195]", async () => {
    // A seek at t itself can land a frame late; each frame is sought a quarter frame early.
    const r = await call({ nodeId: "1:2", format: "GIF", frames: [0, 0.4] });
    expect(r.content.filter((c) => c.type === "image").map((c) => c.data)).toEqual([PNG.toString("base64"), PNG.toString("base64")]);
    const meta = JSON.parse(r.content[0]!.text!);
    expect(meta.frames).toEqual([{ frame: 0, t: 0, image: 1 }, { frame: 6, t: 0.4, image: 2 }]);
    expect(meta).toMatchObject({ fps: 15, frameCount: 13, expectedFrames: 13 });
    const stills = ffmpeg.filter((c) => c.file === "ffmpeg");
    expect(stills).toHaveLength(2);
    expect(stills[1]!.args).toEqual(["-v", "error", "-ss", "0.383333", "-i", meta.path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    expect(stills[1]!.options).not.toHaveProperty("shell");
    const probe = ffmpeg.find((c) => c.file === "ffprobe")!;
    expect(probe.args.at(-1)).toBe(meta.path);
    expect(probe.args).toContain("-count_frames");
  });

  it("without ffmpeg, the video is still written and a note says why there are no frames", async () => {
    ffmpegMissing = true;
    const r = await call({ nodeId: "1:2", frames: [0, 0.2, 0.4] });
    expect(r.isError).toBeFalsy();
    const meta = JSON.parse(r.content[0]!.text!);
    expect(meta.note).toMatch(/ffmpeg not on PATH; frames skipped/);
    expect(existsSync(meta.path)).toBe(true);
    expect(ffmpeg.filter((c) => c.file === "ffmpeg")).toHaveLength(1); // stops at the first ENOENT
    expect(r.content.some((c) => c.type === "image")).toBe(false);
  });
});

// ── the motion tools' schemas ────────────────────────────────────────────────

// The same subset test/schema-portability.test.ts enforces on registered
// tools; these are not in the catalog until the integrator wires them, so they
// are checked here directly.
const FORBIDDEN = new Set(["$ref", "$defs", "anyOf", "oneOf", "allOf", "not", "const", "format", "patternProperties", "propertyNames", "prefixItems"]);
function problems(schema: unknown, path: string): string[] {
  const s = schema as Record<string, unknown>;
  const out = Object.keys(s).filter((k) => FORBIDDEN.has(k)).map((k) => `${path}: uses "${k}"`);
  if (typeof s.type !== "string") out.push(`${path}: no single "type"`);
  if (s.type === "object") for (const [k, v] of Object.entries((s.properties as object) ?? {})) out.push(...problems(v, `${path}.${k}`));
  if (s.type === "array") out.push(...(s.items ? problems(s.items, `${path}[]`) : [`${path}: array without items`]));
  return out;
}

describe("the motion tools", () => {
  it("register with portable schemas and descriptions that fit uncut", async () => {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    const dir = mkdtempSync(join(tmpdir(), "fmcp-video-"));
    registerMotion(server, {} as Bridge, { exportDir: dir, exportRoots: [] }, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "schema", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "figma_export_video", "figma_get_motion_context", "figma_remove_keyframes", "figma_set_keyframes", "figma_set_prototype_flows", "figma_set_scroll_behavior",
    ]);
    for (const t of tools) {
      expect(problems(t.inputSchema, t.name)).toEqual([]);
      // With the Editors sentence the catalog appends: a body cut there loses its last sentence silently.
      expect(t.description!.length + editorsSuffix(t.name.slice("figma_".length)).length, t.name).toBeLessThanOrEqual(1024);
      expect(t.description!.endsWith("…"), t.name).toBe(false);
    }
    const exportVideo = tools.find((t) => t.name === "figma_export_video")!;
    expect(Object.keys((exportVideo.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["nodeId", "wait", "jobId", "cancel", "frameIndices", "frames"]),
    );
    expect((exportVideo.inputSchema as { required?: string[] }).required ?? []).not.toContain("nodeId");
    const writes = tools.filter((t) => !["figma_export_video", "figma_get_motion_context"].includes(t.name));
    for (const t of writes) expect(Object.keys((t.inputSchema as { properties: object }).properties)).toContain("idempotencyKey");
    expect(tools.find((t) => t.name === "figma_export_video")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("registers only what the toolset wants", async () => {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    registerMotion(server, {} as Bridge, { exportDir: tmpdir(), exportRoots: [] }, (op) => op === "get_motion_context");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "schema", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["figma_get_motion_context"]);
    await client.close();
  });
});
