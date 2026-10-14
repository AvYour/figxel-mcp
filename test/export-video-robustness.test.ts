// figma_export_video's failure modes found by the 2026-10-14 audit, at the
// tool: a collecting call that ran past the client's limit, full-size stills,
// a render handed out for another file, a render thrown away for a write that
// never ran, a lost render when its file could not be written, ffmpeg found
// only by name, and paths a root contains under another spelling. The bridge
// is a fake that holds each render until the test settles it; the MCP client
// is real. Job mode itself is test/export-video-jobs.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { resolveSavePath } from "../src/server/exports.js";
import { checkMediaTools, resetMediaToolsCache, type ExecFileLike } from "../src/server/ffmpeg.js";
import { registerMotion, renderSession, saveVideo, type MotionOptions } from "../src/server/tools/motion.js";

type Answer = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown> };
type Session = { sessionId: string; instanceId: string; active: boolean; file: { name: string | null; key: null }; editorType: string; lastActiveAt: number; lastNodesChanged: null };

const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] };

const session = (sessionId: string, name: string, active: boolean, lastActiveAt = 1): Session => ({
  sessionId, instanceId: `win-${sessionId}`, active, file: { name, key: null }, editorType: "figma", lastActiveAt, lastNodesChanged: null,
});

interface Rig {
  client: Client;
  renders: Array<{ params: Record<string, unknown>; opts: Record<string, unknown>; resolve: (d: unknown) => void; reject: (e: unknown) => void }>;
  writes: string[];
  exec: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>;
  exportDir: string;
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanup.splice(0).reverse()) await f();
});

/**
 * The tool against a fake bridge. Renders answer at once (`auto`) or when the
 * test resolves them; `stillMs` makes each ffmpeg still take that long (fake
 * timers); `busyWrites` makes every write answer BUSY, as while a render holds Figma.
 */
async function rig(o: { auto?: boolean; stillMs?: number; sessions?: Session[]; busyWrites?: boolean; motion?: MotionOptions; exportedNodeId?: string } = {}): Promise<Rig> {
  const r: Rig = { client: new Client({ name: "robust", version: "0" }), renders: [], writes: [], exec: [], exportDir: mkdtempSync(join(tmpdir(), "fmcp-robust-")) };
  const sessions = o.sessions ?? [session("s1", "File A", true)];
  const bridge = {
    request: (op: string, params: Record<string, unknown>, opts: Record<string, unknown>) =>
      new Promise((resolve, reject) => {
        if (op !== "export_video") {
          r.writes.push(op);
          if (o.busyWrites) reject(new BridgeError(ErrorCode.BUSY, "Figma is busy with a video render, 3 s so far; this call was not sent to Figma."));
          else resolve({ ok: true });
          return;
        }
        r.renders.push({ params, opts, resolve, reject });
        const data = { nodeId: params.nodeId, exportedNodeId: o.exportedNodeId ?? "1:1", name: "Hero", format: params.format, mime: "video/mp4", bytes: 4, durationS: 1.2, base64: Buffer.from("vid!").toString("base64") };
        if (o.auto !== false) resolve(data);
      }),
    statusAsync: async () => ({ sessions }),
  } as unknown as Bridge;
  const exec: ExecFileLike = (file, args, options, callback) => {
    r.exec.push({ file, args, options });
    const probe = { streams: [{ width: 1080, height: 1920, r_frame_rate: "25/2", avg_frame_rate: "25/2", nb_read_frames: "16" }], format: { duration: "1.280000" } };
    const answer = () =>
      /ffprobe/.test(file) ? callback(null, Buffer.from(JSON.stringify(probe)), Buffer.alloc(0)) : callback(null, Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(0));
    if (o.stillMs && !/ffprobe/.test(file)) setTimeout(answer, o.stillMs);
    else answer();
    return undefined;
  };
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
  registerMotion(server, bridge, { exportDir: r.exportDir, exportRoots: [] }, () => true, { execFile: exec, ...o.motion });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), r.client.connect(b)]);
  cleanup.push(() => r.client.close());
  return r;
}

const call = (r: Rig, args: Record<string, unknown>) => r.client.callTool({ name: "figma_export_video", arguments: args }) as Promise<Answer>;
const json = (a: Answer) => JSON.parse(a.content[0]!.text!) as Record<string, unknown>;
const ffprobes = (r: Rig) => r.exec.filter((e) => /ffprobe/.test(e.file));
const stills = (r: Rig) => r.exec.filter((e) => !/ffprobe/.test(e.file));

// ── 6. a collecting call stays inside its wait ───────────────────────────────

describe("a call answers inside its wait", () => {
  it("frames are counted in the job, once, before any call collects the render", async () => {
    const r = await rig({ auto: false });
    expect(json(await call(r, { nodeId: "1:2", jobId: "j", wait: 0 })).status).toBe("rendering");
    r.renders[0]!.resolve({ nodeId: "1:2", exportedNodeId: "1:1", name: "Hero", format: "MP4", mime: "video/mp4", bytes: 4, durationS: 1.2, base64: "dmlkIQ==" });
    await vi.waitFor(() => expect(ffprobes(r)).toHaveLength(1)); // nobody is collecting yet
    const done = json(await call(r, { jobId: "j" }));
    expect(done).toMatchObject({ status: "done", frameCount: 16 });
    json(await call(r, { jobId: "j" }));
    expect(ffprobes(r)).toHaveLength(1);
  });

  it("stills past the call's wait come back as framesPending, and the next call cuts them", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    // Each still takes 2 s; the call may wait 6 s: three stills fit, two do not.
    const r = await rig({ stillMs: 2_000, motion: { maxWaitS: 6 } });
    const pending = call(r, { nodeId: "1:2", frameIndices: [0, 3, 6, 9, 12] });
    await vi.waitFor(() => expect(stills(r)).toHaveLength(1));
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
    const first = json(await pending);
    expect((first.frames as unknown[]).length).toBe(3);
    expect(first.framesPending).toEqual([9, 12]);
    expect(first.note).toMatch(new RegExp(`figma_export_video \\{ jobId: "${first.jobId}", frameIndices: \\[9, 12\\] \\}`));
    const rest = call(r, { jobId: first.jobId, frameIndices: [9, 12] });
    await vi.waitFor(() => expect(stills(r)).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(4_100);
    const second = json(await rest);
    expect(second.frames).toEqual([{ frame: 9, t: 0.3, image: 1 }, { frame: 12, t: 0.4, image: 2 }]);
    expect(second.framesPending).toBeUndefined();
    expect(r.renders).toHaveLength(1);
  });

  it("a `wait` past the server's limit is capped, and the answer says so", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const r = await rig({ auto: false, motion: { maxWaitS: 3 } });
    const pending = call(r, { nodeId: "1:2", wait: 300 });
    await vi.advanceTimersByTimeAsync(3_000);
    const a = json(await pending);
    expect(a).toMatchObject({ status: "rendering", waitCappedS: 3, elapsedS: 3 });
    expect(a.hint).toMatch(/This server waits at most 3 s per call \(BRIDGE_VIDEO_MAX_WAIT_S\)/);
  });

  it("the default cap is 45 s, a margin under a 60 s client [C-030]", async () => {
    expect(loadConfig({}).videoMaxWaitS).toBe(45);
    expect(loadConfig({ BRIDGE_VIDEO_MAX_WAIT_S: "300" }).videoMaxWaitS).toBe(300);
    expect(() => loadConfig({ BRIDGE_VIDEO_MAX_WAIT_S: "601" })).toThrow(/between 0 and 600/);
  });

  it("past 5 min with no result, the answer says how to end the wait", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const r = await rig({ auto: false });
    json(await call(r, { nodeId: "1:2", jobId: "slow", wait: 0 }));
    await vi.advanceTimersByTimeAsync(301_000);
    expect(json(await call(r, { jobId: "slow", wait: 0 })).hint).toMatch(/close the Figxel plugin window and run it again[\s\S]*ends the wait/);
  });
});

// ── 7 and 11. stills and the file's own clock ────────────────────────────────

describe("what a finished render says", () => {
  it("stills are scaled to 1024 px on the long side, and a GIF reports its own clock (C-194)", async () => {
    const r = await rig();
    const meta = json(await call(r, { nodeId: "1:2", format: "GIF", fps: 12, frameIndices: [0] }));
    expect(stills(r)[0]!.args).toContain("scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease");
    expect(meta).toMatchObject({ fps: 12, fileFps: 12.5, fileDurationS: 1.28, frameCount: 16, expectedFrames: 16 });
    const mp4 = json(await call(r, { nodeId: "1:2", format: "MP4", fps: 24 }));
    expect(mp4.fileFps).toBeUndefined();
  });
});

// ── 8. ffmpeg named by the configuration ─────────────────────────────────────

describe("BRIDGE_FFMPEG / BRIDGE_FFPROBE", () => {
  it("name the programs; a path to ffmpeg alone finds ffprobe beside it", () => {
    expect(loadConfig({})).toMatchObject({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    const c = loadConfig({ BRIDGE_FFMPEG: join("/opt", "ff", "bin", "ffmpeg.exe") });
    expect(c.ffmpeg).toBe(join("/opt", "ff", "bin", "ffmpeg.exe"));
    expect(c.ffprobe).toBe(join("/opt", "ff", "bin", "ffprobe.exe"));
    expect(loadConfig({ BRIDGE_FFMPEG: "/x/ffmpeg", BRIDGE_FFPROBE: "/y/probe" }).ffprobe).toBe("/y/probe");
  });

  it("the render runs the configured programs", async () => {
    const r = await rig({ motion: { media: { ffmpeg: "/opt/ff/ffmpeg", ffprobe: "/opt/ff/ffprobe" } } });
    await call(r, { nodeId: "1:2", frameIndices: [0] });
    expect(r.exec.map((e) => e.file).sort()).toEqual(["/opt/ff/ffmpeg", "/opt/ff/ffprobe"]);
  });

  it("figma_status's check says whether each runs, and what to do when one does not", async () => {
    resetMediaToolsCache();
    const run: ExecFileLike = (file, _args, _o, cb) => {
      if (file === "ffmpeg") cb(null, Buffer.from("ffmpeg version 9.0-test Copyright\nmore"), Buffer.alloc(0));
      else cb(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }), Buffer.alloc(0), Buffer.alloc(0));
      return undefined;
    };
    const checked = await checkMediaTools(run, { ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    expect(checked.ffmpeg).toEqual({ command: "ffmpeg", available: true, version: "ffmpeg version 9.0-test Copyright" });
    expect(checked.ffprobe).toMatchObject({ command: "ffprobe", available: false, error: "not found" });
    expect(checked.note).toMatch(/If ffmpeg was installed after the MCP client started, restart the MCP client/);
    // The held-back audio tools are named only where BRIDGE_ENABLE_AUDIO registered them.
    expect(checked.note).toMatch(/figma_review_video need both programs/);
    expect(checked.note).not.toMatch(/audio/);
    const withAudio = await checkMediaTools(run, { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }, Date.now(), { audio: true });
    expect(withAudio.note).toMatch(/figma_review_video, figma_analyze_audio and figma_add_audio need both programs/);
    resetMediaToolsCache();
  });
});

// ── 10. what a render is handed out for ──────────────────────────────────────

describe("a render is reused only for the same file and the same frame", () => {
  it("the same node id in another file renders again, pinned to that file's session", async () => {
    const r = await rig({ sessions: [session("s1", "File A", true, 2), session("s2", "File B", false, 1)] });
    await call(r, { nodeId: "1:2" });
    await call(r, { nodeId: "1:2", session: "File B" });
    expect(r.renders).toHaveLength(2);
    expect(r.renders.map((x) => x.opts.session)).toEqual(["s1", "s2"]);
    expect(json(await call(r, { nodeId: "1:2", session: "s2" })).reused).toBe(true);
    expect(r.renders).toHaveLength(2);
  });

  it("a render is keyed by the frame it exported: asking for that frame reuses the render of its layer", async () => {
    const r = await rig({ exportedNodeId: "1:1" });
    const layer = json(await call(r, { nodeId: "1:2" }));
    expect(layer.exportedNodeId).toBe("1:1");
    const frame = json(await call(r, { nodeId: "1:1" }));
    expect(frame).toMatchObject({ reused: true, jobId: layer.jobId });
    expect(json(await call(r, { nodeId: "1:2" })).reused).toBe(true);
    expect(r.renders).toHaveLength(1);
  });

  it("a write refused with BUSY changed nothing, so the render stays current", async () => {
    const r = await rig({ busyWrites: true });
    const first = json(await call(r, { nodeId: "1:2" }));
    const write = (await r.client.callTool({ name: "figma_set_keyframes", arguments: { nodeId: "1:3", tracks: [], timelineDuration: 1 } })) as Answer;
    expect(write.structuredContent).toMatchObject({ code: "BUSY" });
    expect(json(await call(r, { nodeId: "1:2" }))).toMatchObject({ reused: true, jobId: first.jobId });
    expect(r.renders).toHaveLength(1);
  });

  it("renderSession picks as the bridge does: by id, by file name (Design first), else the active one", () => {
    const board = { ...session("s3", "File A", false, 9), editorType: "figjam" };
    const list = [session("s1", "File A", true, 2), session("s2", "File B", false, 1), board] as never[];
    expect((renderSession(list, undefined) as Session).sessionId).toBe("s1");
    expect((renderSession(list, "s2") as Session).sessionId).toBe("s2");
    expect((renderSession(list, "file a") as Session).sessionId).toBe("s1");
    expect(renderSession(list, "nope")).toBeUndefined();
  });
});

// ── 9. paths and the file write ──────────────────────────────────────────────

describe("saveTo", () => {
  it("a root and a path that spell one folder two ways agree: compared after realpath", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "fmcp-alias-")));
    const real = join(base, "real");
    mkdirSync(real);
    const alias = join(base, "alias");
    // A junction on Windows needs no privilege; elsewhere a directory symlink. /tmp vs /private/tmp is the same case.
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    // The root as one spelling, the path as the other — both ways round.
    expect(await resolveSavePath(join(alias, "a.mp4"), { exportDir: real, exportRoots: [] })).toBe(join(alias, "a.mp4"));
    expect(await resolveSavePath(join(real, "sub", "b.mp4"), { exportDir: alias, exportRoots: [] })).toBe(join(real, "sub", "b.mp4"));
    // Still refused: a path that really lands outside every root.
    await expect(resolveSavePath(join(base, "c.mp4"), { exportDir: real, exportRoots: [] })).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("an 8.3 short path inside the root is inside (Windows)", async () => {
    const short = process.env.TEMP ?? process.env.TMP;
    if (process.platform !== "win32" || !short || realpathSync.native(short) === short) return; // nothing to compare here
    const dir = mkdtempSync(join(realpathSync.native(short), "fmcp-83-"));
    const viaShort = join(short, dir.slice(realpathSync.native(short).length), "x.mp4");
    expect(await resolveSavePath(viaShort, { exportDir: dir, exportRoots: [] })).toBe(viaShort);
  });

  it('a leading "~" is refused with what to pass instead, before anything is created', async () => {
    const r = await rig();
    for (const saveTo of ["~/Desktop/hero.mp4", "~\\hero.mp4", "~"]) {
      const a = await call(r, { nodeId: "1:2", saveTo });
      expect(a.isError, saveTo).toBe(true);
      expect(a.content[0]!.text).toMatch(/`saveTo` starts with "~", which is not expanded here \(no shell reads it\)/);
      expect(a.structuredContent!.hint).toMatch(/Pass a full path, or a path relative to the export directory/);
    }
    expect(r.renders).toEqual([]);
    expect(existsSync(join(r.exportDir, "~"))).toBe(false);
  });

  it("a video that cannot be written where asked is saved under a default name, with a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-fallback-"));
    // The target exists as a directory, so writing a file there fails, as an open or locked file does.
    mkdirSync(join(dir, "hero.mp4"));
    const data = { nodeId: "1:2", exportedNodeId: "1:1", name: "Hero", format: "MP4", mime: "video/mp4", bytes: 4, base64: "dmlkIQ==" };
    const saved = await saveVideo(data, "hero.mp4", { exportDir: dir, exportRoots: [] });
    expect(saved.path).not.toBe(join(dir, "hero.mp4"));
    expect(saved.path.startsWith(dir)).toBe(true);
    expect(readFileSync(saved.path, "utf8")).toBe("vid!");
    expect(saved.warning).toMatch(/^Could not write hero\.mp4 \(.+\); the video was saved to .+ instead\.$/);
    // And through the tool, the warning reaches the agent.
    const r = await rig();
    mkdirSync(join(r.exportDir, "taken.mp4"));
    const meta = json(await call(r, { nodeId: "1:2", saveTo: "taken.mp4" }));
    expect(meta.warning).toMatch(/Could not write taken\.mp4/);
    expect(existsSync(meta.path as string)).toBe(true);
  });
});
