// figma_export_video's job mode [C-249]: the render belongs to a job, not to
// the call that asked for it. On 2026-10-09 a client cut the call at about
// 60 s, the cancel reached the bridge, and a render Figma could not stop was
// thrown away — twice [C-197]. Here a fake bridge holds each render open until
// the test settles it, and the MCP client is real, so a cancelled call, a
// poll, a retry and a progress heartbeat are exactly what an agent's client
// would send.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import type { Bridge } from "../src/server/bridge.js";
import { registerMotion, type ExecFileLike } from "../src/server/tools/motion.js";
import { heartbeat, VideoJobs, waitFor } from "../src/server/video-jobs.js";

type Answer = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown> };

interface Pending {
  op: string;
  params: Record<string, unknown>;
  opts: { signal?: AbortSignal; idleTimeoutMs?: number; jobId?: string; onProgress?: (p: { done: number; phase?: string }) => void };
  aborted: boolean;
  resolve: (data: unknown) => void;
  reject: (err: unknown) => void;
}

// Timers and the clock only: the MCP transport and the file writes keep running for real.
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] };

/** The timeline the fake plugin reports; a test may change it, beforeEach puts it back. */
let timelineS = 0.8;
const video = (params: Record<string, unknown>) => ({
  nodeId: params.nodeId,
  exportedNodeId: "1:1",
  name: "Hero",
  format: params.format,
  mime: "video/mp4",
  bytes: 4,
  durationS: timelineS,
  base64: Buffer.from("vid!").toString("base64"),
});

describe("figma_export_video in job mode", () => {
  let client: Client;
  let requests: Pending[];
  let autoResolve: boolean;
  let changedAt: number | undefined;
  let probeJson: Record<string, unknown> | "missing";
  let ffmpeg: Array<{ file: string; args: readonly string[] }>;
  let exportDir: string;

  beforeEach(async () => {
    requests = [];
    autoResolve = false;
    changedAt = undefined;
    timelineS = 0.8;
    probeJson = { streams: [{ width: 1080, height: 1920, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "25" }], format: { duration: "0.833333" } };
    ffmpeg = [];
    exportDir = mkdtempSync(join(tmpdir(), "fmcp-jobs-"));
    const bridge = {
      request: (op: string, params: Record<string, unknown>, opts: Pending["opts"]) =>
        new Promise((resolve, reject) => {
          const entry: Pending = { op, params, opts, aborted: false, resolve, reject };
          requests.push(entry);
          if (op !== "export_video") return resolve({ ok: true });
          // What Bridge.cancel does: the job settles as cancelled, and bytes that arrive later are ignored.
          opts.signal?.addEventListener("abort", () => {
            entry.aborted = true;
            reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled (CLIENT_CANCELLED)."));
          });
          if (autoResolve) resolve(video(params));
        }),
      statusAsync: async () => ({ sessions: [{ sessionId: "s1", active: true, lastNodesChanged: changedAt === undefined ? null : { count: 1, at: changedAt } }] }),
    } as unknown as Bridge;
    const exec: ExecFileLike = (file, args, _options, callback) => {
      ffmpeg.push({ file, args });
      if (file === "ffprobe") {
        if (probeJson === "missing") callback(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }), Buffer.alloc(0), Buffer.alloc(0));
        else callback(null, Buffer.from(JSON.stringify(probeJson)), Buffer.alloc(0));
      } else callback(null, Buffer.from([0x89, 0x50, 0x4e, 0x47, args.length]), Buffer.alloc(0));
      return undefined;
    };
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    registerMotion(server, bridge, { exportDir, exportRoots: [] }, () => true, { execFile: exec });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "jobs-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await client.close();
  });

  const call = (args: Record<string, unknown>) => client.callTool({ name: "figma_export_video", arguments: args }) as Promise<Answer>;
  const json = (r: Answer) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
  const renders = () => requests.filter((r) => r.op === "export_video");
  const rendered = async (n: number) => vi.waitFor(() => expect(renders()).toHaveLength(n));

  it("a render faster than `wait` returns the file, its job and the frame count against the timeline", async () => {
    autoResolve = true;
    const r = await call({ nodeId: "1:2" });
    const meta = json(r);
    expect(r.isError).toBeFalsy();
    expect(existsSync(meta.path as string)).toBe(true);
    expect(meta).toMatchObject({ format: "MP4", exportedNodeId: "1:1", jobId: expect.stringMatching(/^video-/), fps: 30, frameCount: 25, expectedFrames: 25 });
    expect(meta.note).toBeUndefined();
    expect(typeof meta.renderS).toBe("number");
  });

  it("a cut-off call never cancels the render: a retry collects it, with no second render (C-197)", async () => {
    const ac = new AbortController();
    const first = client.callTool({ name: "figma_export_video", arguments: { nodeId: "1:2", jobId: "hero-r1" } }, undefined, { signal: ac.signal });
    await rendered(1);
    ac.abort("client timeout");
    await expect(first).rejects.toThrow();
    // The bridge job is untouched: Figma goes on rendering, and the result is kept.
    expect(renders()[0]!.aborted).toBe(false);
    renders()[0]!.resolve(video(renders()[0]!.params));
    autoResolve = true; // were a second render requested, it would answer at once — and be counted
    const retry = await call({ nodeId: "1:2", jobId: "hero-r1" });
    expect(retry.isError).toBeFalsy();
    expect(existsSync(json(retry).path as string)).toBe(true);
    expect(json(retry).jobId).toBe("hero-r1");
    expect(renders()).toHaveLength(1);
  });

  it("the same settings again, with no jobId, attach to the render the cut-off call started", async () => {
    const ac = new AbortController();
    const first = client.callTool({ name: "figma_export_video", arguments: { nodeId: "1:2", format: "GIF", fps: 12 } }, undefined, { signal: ac.signal });
    await rendered(1);
    ac.abort();
    await expect(first).rejects.toThrow();
    const again = call({ nodeId: "1:2", format: "GIF", fps: 12 });
    await new Promise((r) => setTimeout(r, 20));
    renders()[0]!.resolve(video(renders()[0]!.params));
    const r = await again;
    expect(json(r)).toMatchObject({ format: "GIF", fps: 12 });
    expect(renders()).toHaveLength(1);
    expect(renders()[0]!.aborted).toBe(false);
  });

  it("a slow render answers `rendering` at `wait`, and figma_export_video { jobId } collects it", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const pending = call({ nodeId: "1:2", wait: 1 });
    await rendered(1);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    expect(r.isError).toBeFalsy();
    const running = json(r);
    expect(running).toMatchObject({ status: "rendering", jobId: expect.stringMatching(/^video-/), elapsedS: 1, nodeId: "1:2" });
    expect(running.hint).toMatch(/figma_export_video \{ jobId: "video-[^"]+" \}/);
    expect(running.hint).not.toMatch(/minimized/);
    renders()[0]!.resolve(video(renders()[0]!.params));
    const done = await call({ jobId: running.jobId });
    expect(existsSync(json(done).path as string)).toBe(true);
    expect(renders()).toHaveLength(1);
  });

  it("after 2 min with no result, the answer says a minimized Figma stops the render (C-198)", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const first = json(await call({ nodeId: "1:2", jobId: "long", wait: 0 }));
    expect(first.status).toBe("rendering");
    await vi.advanceTimersByTimeAsync(121_000);
    const later = json(await call({ jobId: "long", wait: 0 }));
    expect(later).toMatchObject({ status: "rendering", elapsedS: 121 });
    expect(later.hint).toMatch(/minimized Figma window stops video export/);
    expect(later.hint).toMatch(/Figma itself ends a render it has not finished in about 4 min \(TIMEOUT\)/);
  });

  it("the plugin's phase shows while it renders", async () => {
    const pending = call({ nodeId: "1:2", jobId: "phase", wait: 0 });
    await rendered(1);
    renders()[0]!.opts.onProgress!({ done: 0, phase: "rendering MP4" });
    expect(json(await pending).status).toBe("rendering");
    expect(json(await call({ jobId: "phase", wait: 0 })).phase).toBe("rendering MP4");
  });

  it("a heartbeat keeps a progress-token caller informed: increasing seconds, nothing after the answer", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const progress: Array<{ progress: number; message?: string }> = [];
    const pending = client.callTool({ name: "figma_export_video", arguments: { nodeId: "1:2", wait: 30 } }, undefined, {
      onprogress: (p) => progress.push({ progress: p.progress, ...(p.message ? { message: p.message } : {}) }),
    });
    await rendered(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(progress).toEqual([
      { progress: 5, message: "rendering MP4: 5 s" },
      { progress: 10, message: "rendering MP4: 10 s" },
    ]);
    renders()[0]!.resolve(video(renders()[0]!.params));
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(progress).toHaveLength(2);
  });

  it("a caller without a progress token gets no heartbeat", async () => {
    const sent: unknown[] = [];
    const beat = heartbeat({ progressToken: undefined, send: async (n) => void sent.push(n) }, "rendering MP4", 0, () => 0, 1);
    await new Promise((r) => setTimeout(r, 20));
    beat.stop();
    expect(sent).toEqual([]);
  });

  it("`cancel` drops a running render: the bridge is told, and a poll says cancelled", async () => {
    expect(json(await call({ nodeId: "1:2", jobId: "drop-me", wait: 0 })).status).toBe("rendering");
    const r = await call({ jobId: "drop-me", cancel: true });
    expect(json(r)).toMatchObject({ status: "cancelled", jobId: "drop-me" });
    expect(renders()[0]!.aborted).toBe(true);
    expect(json(await call({ jobId: "drop-me" }))).toMatchObject({ status: "cancelled", jobId: "drop-me" });
  });

  it("the render tells the bridge its jobId, so the BUSY other calls get meanwhile names it", async () => {
    expect(json(await call({ nodeId: "1:2", jobId: "named", wait: 0 })).hint).toMatch(/other Figma calls answer BUSY and change nothing/);
    const generated = json(await call({ nodeId: "1:3", wait: 0 })).jobId;
    expect(renders().map((r) => r.opts.jobId)).toEqual(["named", generated]);
  });

  it("a render the bridge refuses because another one holds Figma answers that BUSY, safe to retry", async () => {
    const busy = new BridgeError(ErrorCode.BUSY, 'Figma is busy with a video render (figma_export_video job "other"), 12 s so far; this call was not sent to Figma.', { hint: "Nothing changed, so a retry is safe: call again once the render ends." });
    const pending = call({ nodeId: "1:2", jobId: "mine" });
    await rendered(1);
    renders()[0]!.reject(busy);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "BUSY", safeToRetry: true });
    // The refused job does not block its name: the retry renders.
    autoResolve = true;
    expect(json(await call({ nodeId: "1:2", jobId: "mine" })).status).toBe("done");
    expect(renders()).toHaveLength(2);
  });

  it("`cancel` of a finished render forgets it and says where the file stays", async () => {
    autoResolve = true;
    const done = json(await call({ nodeId: "1:2", jobId: "finished" }));
    const r = json(await call({ jobId: "finished", cancel: true }));
    expect(r).toMatchObject({ status: "cancelled", jobId: "finished" });
    expect(r.note).toContain(done.path as string);
    expect((await call({ jobId: "finished" })).isError).toBe(true);
  });

  it("a jobId that is rendering other settings is refused, before a second render", async () => {
    expect(json(await call({ nodeId: "1:2", jobId: "a", wait: 0 })).status).toBe("rendering");
    const r = await call({ nodeId: "1:2", jobId: "a", format: "GIF", wait: 0 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/INVALID_PARAM: Render "a" is still running with other settings/);
    expect(renders()).toHaveLength(1);
  });

  it("two callers asking for the same render share it", async () => {
    const a = call({ nodeId: "1:2", wait: 5 });
    const b = call({ nodeId: "1:2", wait: 5 });
    await rendered(1);
    await new Promise((r) => setTimeout(r, 20));
    renders()[0]!.resolve(video(renders()[0]!.params));
    const [ra, rb] = await Promise.all([a, b]);
    expect(json(ra).jobId).toBe(json(rb).jobId);
    expect(renders()).toHaveLength(1);
  });

  it("a finished render is reused until a write runs or Figma reports a change; then it renders again", async () => {
    autoResolve = true;
    const first = json(await call({ nodeId: "1:2" }));
    const again = json(await call({ nodeId: "1:2" }));
    expect(again).toMatchObject({ jobId: first.jobId, reused: true });
    expect(renders()).toHaveLength(1);

    // A write through this process: the earlier file shows a state that is gone.
    await client.callTool({ name: "figma_set_keyframes", arguments: { nodeId: "1:3", tracks: [], timelineDuration: 1 } });
    const afterWrite = json(await call({ nodeId: "1:2" }));
    expect(renders()).toHaveLength(2);
    expect(afterWrite.jobId).not.toBe(first.jobId);
    expect(afterWrite.reused).toBeUndefined();

    // An edit by hand in Figma: the plugin's nodes_changed event.
    changedAt = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    await call({ nodeId: "1:2" });
    expect(renders()).toHaveLength(3);
  });

  it("the change event of the edit just before a render arrives late, and costs no second render", async () => {
    const pending = call({ nodeId: "1:2", wait: 0 });
    await rendered(1);
    await pending;
    // nodes_changed is debounced in the plugin, so it lands after the render started.
    changedAt = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    const attach = call({ nodeId: "1:2", wait: 5 });
    await new Promise((r) => setTimeout(r, 20));
    renders()[0]!.resolve(video(renders()[0]!.params));
    expect(json(await attach).status).toBe("done");
    expect(json(await call({ nodeId: "1:2" })).reused).toBe(true);
    expect(renders()).toHaveLength(1);
  });

  it("a render the bridge gave up on says a minimized Figma is the likely cause (C-198)", async () => {
    const started = json(await call({ nodeId: "1:2", wait: 0 }));
    renders()[0]!.reject(new BridgeError(ErrorCode.STALLED, "The operation stopped reporting for 600 s.", { hint: "Check whether Figma is frozen; retry with the same idempotencyKey." }));
    await new Promise((r) => setTimeout(r, 5));
    const r = await call({ jobId: started.jobId });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^STALLED: [\s\S]*minimized Figma window stops video export/);
    expect(r.content[0]!.text).not.toMatch(/idempotencyKey/);
  });

  // spikes/live-review.mjs, 2026-10-13: two renders polled every 40 s ended 240.4 s and 241.0 s after the
  // first call, and no file was written; Figma's words, as live-motion-semantics.mjs recorded them that
  // hour, were "Video export timed out" — on a frame that rendered at 24 and 60 fps seconds later.
  it("a render Figma gave up on answers TIMEOUT with the time it ran and what to do; the same settings render again", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const started = json(await call({ nodeId: "1:2", jobId: "steps", wait: 0 }));
    await vi.advanceTimersByTimeAsync(240_000);
    // Exactly what the plugin of 05c9b78 sends: Figma's time limit labelled UNSUPPORTED, with a keyframes hint.
    renders()[0]!.reject(
      new BridgeError(ErrorCode.UNSUPPORTED, 'Figma could not export "Hero" as MP4: Video export timed out', {
        hint: "Video export needs a top-level frame whose layers have keyframes (figma_get_motion_context shows them; figma_set_keyframes adds them).",
      }),
    );
    await vi.advanceTimersByTimeAsync(5);
    const r = await call({ jobId: started.jobId });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^TIMEOUT: Figma gave up rendering "Hero" as MP4: Video export timed out \(240 s after the render started\)\.\n/);
    expect(r.structuredContent).toMatchObject({ code: "TIMEOUT", safeToRetry: true });
    const hint = r.structuredContent!.hint as string;
    expect(hint).toMatch(/restored[\s\S]*render again[\s\S]*a lower `fps`/);
    expect(hint).not.toMatch(/keyframes/);

    autoResolve = true;
    const again = await call({ nodeId: "1:2", jobId: "steps" });
    expect(again.isError).toBeFalsy();
    expect(json(again)).toMatchObject({ status: "done", jobId: "steps" });
    expect(renders()).toHaveLength(2);
  });

  it("a plugin's own TIMEOUT keeps its words and gains the time the render ran", async () => {
    const started = json(await call({ nodeId: "1:2", wait: 0 }));
    renders()[0]!.reject(new BridgeError(ErrorCode.TIMEOUT, 'Figma gave up rendering "Hero" as GIF: Video export timed out', { hint: "x" }));
    await new Promise((r) => setTimeout(r, 5));
    const r = await call({ jobId: started.jobId });
    expect(r.content[0]!.text).toMatch(/^TIMEOUT: Figma gave up rendering "Hero" as GIF: Video export timed out \([\d.]+ s after the render started\)\.\nFigma ends a video render/);
  });

  it("a refusal that is not Figma's time limit stays UNSUPPORTED, whatever the frame is called", async () => {
    const started = json(await call({ nodeId: "1:2", wait: 0 }));
    renders()[0]!.reject(new BridgeError(ErrorCode.UNSUPPORTED, 'Figma could not export "Video export timed out: draft" as MP4: Video export failed'));
    await new Promise((r) => setTimeout(r, 5));
    expect((await call({ jobId: started.jobId })).content[0]!.text).toMatch(/^UNSUPPORTED: Figma could not export/);
  });

  it("collecting a render after a write says the render predates it", async () => {
    autoResolve = true;
    await call({ nodeId: "1:2", jobId: "before" });
    await client.callTool({ name: "figma_set_keyframes", arguments: { nodeId: "1:3", tracks: [], timelineDuration: 1 } });
    const r = json(await call({ jobId: "before" }));
    expect(r.note).toMatch(/Edits ran through Figxel after this render started/);
  });

  it("a failed render answers its error; the same settings then render again", async () => {
    const started = json(await call({ nodeId: "1:2", wait: 0 }));
    renders()[0]!.reject(new BridgeError(ErrorCode.UNSUPPORTED, "Figma could not export \"Hero\" as MP4: no animation"));
    await new Promise((r) => setTimeout(r, 5));
    const failed = await call({ jobId: started.jobId });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toMatch(/^UNSUPPORTED: Figma could not export/);
    autoResolve = true;
    expect((await call({ nodeId: "1:2" })).isError).toBeFalsy();
    expect(renders()).toHaveLength(2);
  });

  it("a finished render expires 30 min after it ends", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    autoResolve = true;
    await call({ nodeId: "1:2", jobId: "old" });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect((await call({ jobId: "old" })).isError).toBeFalsy();
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    const gone = await call({ jobId: "old" });
    expect(gone.isError).toBe(true);
    expect(gone.content[0]!.text).toMatch(/No render named "old"/);
  });

  it("holds at most 8 renders: a 9th waits for one to finish, then the oldest finished one makes room", async () => {
    for (let i = 0; i < 8; i++) expect(json(await call({ nodeId: `1:${10 + i}`, jobId: `j${i}`, wait: 0 })).status).toBe("rendering");
    const ninth = await call({ nodeId: "1:99", jobId: "j8", wait: 0 });
    expect(ninth.isError).toBe(true);
    expect(ninth.content[0]!.text).toMatch(/^BUSY: 8 renders are already running/);
    expect(renders()).toHaveLength(8);
    renders()[3]!.resolve(video(renders()[3]!.params));
    // The job ends once its file is written: wait for that, not a fixed 20 ms a loaded disk can miss.
    await vi.waitFor(async () => expect(json(await call({ jobId: "j3", wait: 0 })).status).toBe("done"));
    expect(json(await call({ nodeId: "1:99", jobId: "j8", wait: 0 })).status).toBe("rendering");
    expect((await call({ jobId: "j3" })).isError).toBe(true); // evicted
  });

  it("frameIndices are frame-exact: each seeks a quarter frame early (C-195)", async () => {
    autoResolve = true;
    const r = await call({ nodeId: "1:2", frameIndices: [0, 15, 24, 30] });
    const meta = json(r);
    expect(meta.frames).toEqual([
      { frame: 0, t: 0, image: 1 },
      { frame: 15, t: 0.5, image: 2 },
      { frame: 24, t: 0.8, image: 3 },
      { frame: 30, t: 1, error: "past the last frame (24)" },
    ]);
    const seeks = ffmpeg.filter((c) => c.file === "ffmpeg").map((c) => c.args[c.args.indexOf("-ss") + 1]);
    expect(seeks).toEqual(["0", "0.491667", "0.791667"]);
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(3);
  });

  it("`frames` in seconds map to the nearest frame of the asked fps", async () => {
    autoResolve = true;
    probeJson = { streams: [{ width: 320, height: 240, r_frame_rate: "15/1", avg_frame_rate: "15/1", nb_read_frames: "13" }], format: { duration: "0.866667" } };
    const meta = json(await call({ nodeId: "1:2", format: "GIF", frames: [0.4, 0.41] }));
    expect(meta.frames).toEqual([
      { frame: 6, t: 0.4, image: 1 },
      { frame: 6, t: 0.4, image: 2 },
    ]);
    expect(ffmpeg.filter((c) => c.file === "ffmpeg").map((c) => c.args[c.args.indexOf("-ss") + 1])).toEqual(["0.383333", "0.383333"]);
  });

  it("a frame count that differs from ceil(duration × fps) + 1 is noted (C-194)", async () => {
    autoResolve = true;
    probeJson = { streams: [{ width: 1080, height: 1920, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "24" }], format: { duration: "0.8" } };
    const meta = json(await call({ nodeId: "1:2" }));
    expect(meta).toMatchObject({ frameCount: 24, expectedFrames: 25 });
    expect(meta.note).toMatch(/The file has 24 frames; a 0\.8 s timeline at 30 fps implies 25/);
  });

  it("a GIF counts to the first frame at or after the end, and its stills seek by the file's own clock (C-194)", async () => {
    // Measured 2026-10-13 (spikes/results/live-motion-semantics.json, GIF@12): a 1.2 s timeline
    // decoded 16 frames, sampled at k / 12 for k = 0…15, each stored with an 8 cs delay, so
    // ffprobe reads the file at 25/2 fps and 1.28 s. round(d · fps) + 1 would expect 15.
    autoResolve = true;
    timelineS = 1.2;
    probeJson = { streams: [{ width: 400, height: 436, r_frame_rate: "25/2", avg_frame_rate: "25/2", nb_read_frames: "16" }], format: { duration: "1.280000" } };
    const meta = json(await call({ nodeId: "1:2", format: "GIF", fps: 12, frameIndices: [0, 15] }));
    expect(meta).toMatchObject({ format: "GIF", fps: 12, frameCount: 16, expectedFrames: 16 });
    expect(meta.note).toBeUndefined();
    // Frame 15 is the timeline at 15 / 12 s; in the file it starts at 15 × 0.08 s, so the seek is (15 − 0.25) / 12.5.
    expect(meta.frames).toEqual([
      { frame: 0, t: 0, image: 1 },
      { frame: 15, t: 1.25, image: 2 },
    ]);
    expect(ffmpeg.filter((c) => c.file === "ffmpeg").map((c) => c.args[c.args.indexOf("-ss") + 1])).toEqual(["0", "1.18"]);
  });

  it("an MP4 counts the same way: 1.2 s at 24 fps holds 30 frames, as measured", async () => {
    autoResolve = true;
    timelineS = 1.2;
    probeJson = { streams: [{ width: 400, height: 436, r_frame_rate: "24/1", avg_frame_rate: "24/1", nb_read_frames: "30" }], format: { duration: "1.250000" } };
    const meta = json(await call({ nodeId: "1:2", format: "MP4", fps: 24 }));
    expect(meta).toMatchObject({ frameCount: 30, expectedFrames: 30 });
    expect(meta.note).toBeUndefined();
  });

  it("a timeline kept a hair past its last frame renders one frame more, and is not flagged (C-194)", async () => {
    // Measured 2026-10-13 (spikes/results/live-animatic.json, dissolve): a timeline set to 89/30 s is
    // kept as 2.966667 s, read back as 2.9667, and rendered 91 MP4 frames at 30 fps; round(d · fps) + 1 says 90.
    autoResolve = true;
    timelineS = 2.9667;
    probeJson = { streams: [{ width: 216, height: 384, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "91" }], format: { duration: "3.033333" } };
    const meta = json(await call({ nodeId: "1:2", format: "MP4", fps: 30 }));
    expect(meta).toMatchObject({ frameCount: 91, expectedFrames: 91 });
    expect(meta.note).toBeUndefined();
  });

  it("without ffprobe the render still answers, with a note instead of a count", async () => {
    autoResolve = true;
    probeJson = "missing";
    const meta = json(await call({ nodeId: "1:2" }));
    expect(meta.frameCount).toBeUndefined();
    expect(meta.expectedFrames).toBe(25);
    expect(meta.note).toMatch(/ffprobe is not on PATH/);
  });

  it("refuses what cannot be answered, before anything is sent", async () => {
    for (const [args, pattern] of [
      [{}, /Pass `nodeId` to start a render, or `jobId` to collect one/],
      [{ jobId: "bad id!" }, /`jobId` takes 1 to 64 letters/],
      [{ nodeId: "1:2", frames: [0], frameIndices: [0] }, /`frames` \(seconds\) or `frameIndices`, not both/],
      [{ cancel: true }, /`cancel` needs the `jobId`/],
      [{ jobId: "x", cancel: true, nodeId: "1:2" }, /`cancel` takes only `jobId`/],
      [{ jobId: "x", format: "GIF" }, /`format` describe a new render and need `nodeId`/],
      [{ jobId: "nope" }, /No render named "nope"/],
    ] as const) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0]!.text, JSON.stringify(args)).toMatch(pattern);
      expect(r.structuredContent?.safeToRetry).toBe(true);
    }
    expect(requests).toEqual([]);
  });
});

// ── the store and its helpers, without MCP ───────────────────────────────────

describe("VideoJobs", () => {
  it("keeps a cancelled job cancelled whatever the bridge answers later", async () => {
    let finish!: (v: string) => void;
    const jobs = new VideoJobs<string>();
    const job = jobs.start({ id: "a", key: "k", nodeId: "1:2", format: "MP4", epoch: 0 }, () => new Promise((r) => (finish = r)));
    expect(jobs.find("k")).toBe(job);
    jobs.cancel("a");
    expect(await waitFor(job, 10)).toBe("settled");
    finish("late");
    await job.settled;
    expect(job.status).toBe("cancelled");
    expect(job.result).toBeUndefined();
    expect(jobs.find("k")).toBeUndefined();
  });

  it("refuses to start a name that is still rendering", () => {
    const jobs = new VideoJobs<string>();
    jobs.start({ id: "a", key: "k", nodeId: "1:2", format: "MP4", epoch: 0 }, () => new Promise(() => {}));
    expect(() => jobs.start({ id: "a", key: "k", nodeId: "1:2", format: "MP4", epoch: 0 }, async () => "x")).toThrow(/still running/);
  });

  it("waitFor ends on the job, on the time limit, or when the waiting call is cancelled", async () => {
    const jobs = new VideoJobs<string>();
    let finish!: (v: string) => void;
    const job = jobs.start({ id: "a", key: "k", nodeId: "1:2", format: "MP4", epoch: 0 }, () => new Promise((r) => (finish = r)));
    expect(await waitFor(job, 0)).toBe("timeout");
    expect(await waitFor(job, 5)).toBe("timeout");
    const ac = new AbortController();
    const aborted = waitFor(job, 10_000, ac.signal);
    ac.abort();
    expect(await aborted).toBe("aborted");
    const settled = waitFor(job, 10_000);
    finish("ok");
    expect(await settled).toBe("settled");
    expect(job.status).toBe("done");
  });
});
