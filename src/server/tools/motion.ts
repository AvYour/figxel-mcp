// Motion, video and prototype behaviour on the server side: figma_get_motion_context
// (read), figma_set_keyframes / figma_remove_keyframes / figma_set_scroll_behavior /
// figma_set_prototype_flows (style), figma_export_video (export).
//
// Every tool but figma_export_video forwards as is. The video is shaped here,
// like figma_export_node's renders: the bridge checks the settings and the
// path before Figma renders (a video is the slowest render there is), always
// writes a file (a video never goes inline), and pulls still frames out of it
// with ffmpeg when ffmpeg is on PATH — a render shows only the resting state,
// so frames are how an agent sees its motion [C-116].
//
// A render runs as a job (video-jobs.ts) [C-249]: a call waits at most `wait`
// seconds, a client's cancel or timeout ends only that wait, and a later call
// collects the render by `jobId` — or by asking for the same render again.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { PRODUCT_NAME } from "../../shared/version.js";
import {
  DEFAULT_VIDEO_FPS,
  expectedFrames,
  frameAt,
  frameSeek,
  isRenderTimeout,
  RENDER_TIMEOUT_HINT,
  VIDEO_EXTENSION,
  VIDEO_FORMATS,
  VIDEO_MIME,
  videoSettings,
  type VideoFormat,
} from "../../shared/video.js";
import type { Bridge } from "../bridge.js";
import { defaultExportName, resolveSavePath, writeExport, type ExportRoots } from "../exports.js";
import { errorResult, okResult } from "../results.js";
import { heartbeat, VideoJobs, waitFor, type VideoJob } from "../video-jobs.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { INLINE_LIMIT } from "./export.js";
import { addressCall, forwardTool, writeEpoch, type Extra } from "./forward.js";
import { fitDescription, hexColor } from "./params.js";

const SESSION = {
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

/**
 * exportAsync reports no progress while it encodes, and a long animation at a
 * high frame rate takes minutes — past the 120 s export idle timeout.
 */
export const VIDEO_IDLE_TIMEOUT_MS = 600_000;
/** Frames are image blocks in one result; a dozen is a storyboard, more is a flipbook nobody reads. */
const MAX_FRAMES = 12;
/** A call's default wait: a margin under clients that cut a call at 60 s [C-030] [C-197]. */
export const DEFAULT_WAIT_S = 40;
/** A render with no result after this long gets the minimized-window hint [C-198]. */
export const STALL_MS = 120_000;
const JOB_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** What describes a render, beside `nodeId` and `session`. */
const RENDER_KEYS = ["format", "fps", "quality", "loopCount", "width", "height", "scale", "saveTo"] as const;
const NO_JOB_HINT = `Renders are kept 30 min after they end, in the ${PRODUCT_NAME} process that started them. Pass \`nodeId\` to start one.`;

// ── ffmpeg, without a shell ──────────────────────────────────────────────────

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "buffer"; maxBuffer: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown }) | null, stdout: Buffer, stderr: Buffer) => void,
) => unknown;

const nodeExecFile: ExecFileLike = (file, args, options, callback) => execFile(file, [...args], options, callback);

/**
 * One still of a video as PNG bytes. execFile with an argument array: the path
 * and the time are never parsed by a shell, whatever characters they contain.
 */
export function grabFrame(run: ExecFileLike, video: string, t: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    run(
      "ffmpeg",
      ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else if (!stdout || stdout.length === 0) reject(new Error(`no frame at ${t} s (past the end of the video?)`));
        else resolve(stdout);
      },
    );
  });
}

/** What ffprobe says a video file holds. */
export interface VideoProbe {
  width: number;
  height: number;
  /** Frames per second of the file's own timing. */
  fps: number;
  /** Frames decoded, when ffprobe could count them. */
  frames: number | undefined;
  durationS: number | undefined;
}

/** "30/1" → 30; anything else → NaN. */
function rational(v: unknown): number {
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(String(v ?? ""));
  if (!m) return Number.NaN;
  const den = m[2] === undefined ? 1 : Number(m[2]);
  return den > 0 ? Number(m[1]) / den : Number.NaN;
}

/**
 * ffprobe's view of a video. `-count_frames` decodes the stream, so `frames`
 * is what the file really holds, not what a header claims [C-194]. Rejects
 * with the spawn error (code ENOENT when ffprobe is missing), or with
 * ffprobe's own message for a file it cannot read.
 */
export function probeVideo(run: ExecFileLike, path: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    run(
      "ffprobe",
      [
        "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames:format=duration",
        "-of", "json", path,
      ],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const said = stderr?.toString("utf8").trim();
          reject(said && err.code !== "ENOENT" ? Object.assign(new Error(said), { code: err.code }) : err);
          return;
        }
        try {
          const json = JSON.parse(stdout.toString("utf8")) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
          const s = json.streams?.[0];
          if (!s) throw new Error("ffprobe found no video stream in the file.");
          const width = Number(s.width);
          const height = Number(s.height);
          const r = rational(s.r_frame_rate);
          const avg = rational(s.avg_frame_rate);
          // A constant-rate file has both equal; a GIF stores a delay per frame, so its average is the truer rate.
          const fps = r > 0 && !(avg > 0 && Math.abs(r - avg) / avg >= 0.01) ? r : avg;
          if (!(width > 0) || !(height > 0) || !(fps > 0)) throw new Error("ffprobe gave no frame size or frame rate for the file.");
          const frames = Number(s.nb_read_frames);
          const durationS = Number(json.format?.duration);
          resolve({
            width,
            height,
            fps,
            frames: Number.isInteger(frames) && frames > 0 ? frames : undefined,
            durationS: Number.isFinite(durationS) && durationS > 0 ? durationS : undefined,
          });
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === "ENOENT";
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Figma's own words at the end of the plugin's `Figma could not export "<name>" as <format>: <words>`. */
const figmaWords = (message: string) => {
  const at = message.lastIndexOf(": ");
  return at < 0 ? message : message.slice(at + 2);
};

// ── figma_export_video ───────────────────────────────────────────────────────

interface VideoData {
  nodeId: string;
  exportedNodeId: string;
  name: string;
  format: string;
  mime: string;
  bytes: number;
  durationS?: number;
  base64: string;
}

function asVideo(data: unknown): VideoData {
  const d = data as Partial<VideoData> | null;
  if (!d || typeof d !== "object" || typeof d.base64 !== "string" || !(VIDEO_FORMATS as readonly string[]).includes(String(d.format))) {
    throw new BridgeError(ErrorCode.INTERNAL, "The plugin's video export carried no bytes.");
  }
  return d as VideoData;
}

/** `<name>-<id>-<time>.mp4`, with the extension exports.ts does not know for video. */
function videoName(name: string, id: string, format: VideoFormat): string {
  const ext = VIDEO_EXTENSION[format];
  const base = defaultExportName(name, id, format);
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

/** A render on disk, and what the plugin said about it. */
export interface SavedVideo {
  path: string;
  bytes: number;
  format: VideoFormat;
  mime: string;
  nodeId: string;
  exportedNodeId: string;
  name: string;
  durationS?: number;
}

/** Write the plugin's bytes. The job does this as soon as Figma answers, so the file exists whether or not a call is left to collect it. */
export async function saveVideo(data: unknown, saveTo: string | undefined, roots: ExportRoots): Promise<SavedVideo> {
  const d = asVideo(data);
  const format = d.format as VideoFormat;
  const path = await writeExport(saveTo ?? videoName(d.name, d.exportedNodeId, format), Buffer.from(d.base64, "base64"), roots);
  return {
    path,
    bytes: d.bytes,
    format,
    mime: d.mime ?? VIDEO_MIME[format],
    nodeId: d.nodeId,
    exportedNodeId: d.exportedNodeId,
    name: d.name,
    ...(typeof d.durationS === "number" ? { durationS: d.durationS } : {}),
  };
}

/** A finished render, as a job keeps it. */
interface Rendered {
  saved: SavedVideo;
  /** The rate Figma sampled the timeline at: the asked fps, else the format's default. */
  fps: number;
  warning: string | undefined;
  /** ffprobe's answer, asked once per render: null when it could not be had. */
  probe?: VideoProbe | null;
  probeNote?: string;
}

/** Which frames a call wants back: seconds, or exact indices. */
interface FrameAsk {
  seconds: number[] | undefined;
  indices: number[] | undefined;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** The answer for a finished render: the file, its frame count against the timeline, and the asked frames. */
async function answerDone(job: VideoJob<Rendered>, ask: FrameAsk, reused: boolean, run: ExecFileLike, roots: ExportRoots, renderMs: number): Promise<CallToolResult> {
  const r = job.result!;
  const { saved } = r;
  const meta: Record<string, unknown> = {
    ...saved,
    ...(saved.exportedNodeId !== saved.nodeId ? { exported: "the top-level frame around the node — the only node Figma encodes as video" } : {}),
    status: "done",
    jobId: job.id,
    renderS: round1(renderMs / 1000),
    fps: r.fps,
  };
  if (r.probe === undefined) {
    try {
      r.probe = await probeVideo(run, saved.path);
    } catch (err) {
      r.probe = null;
      r.probeNote = isMissing(err) ? "ffprobe is not on PATH, so frameCount is not measured." : `ffprobe could not count the frames: ${messageOf(err)}`;
    }
  }
  const notes: string[] = r.probeNote ? [r.probeNote] : [];
  const counted = r.probe?.frames;
  // Every format ends on the first frame at or after the timeline's end: ceil(d · fps) + 1 [C-194].
  const expected = saved.durationS !== undefined ? expectedFrames(saved.durationS, r.fps) : undefined;
  if (counted !== undefined) meta.frameCount = counted;
  if (expected !== undefined) meta.expectedFrames = expected;
  if (counted !== undefined && expected !== undefined && counted !== expected) {
    notes.push(`The file has ${counted} frames; a ${saved.durationS} s timeline at ${r.fps} fps implies ${expected} (the end frame renders too: ceil(duration × fps) + 1).`);
  }
  if (reused) meta.reused = true;
  if (job.epoch !== writeEpoch()) {
    notes.push(`Edits ran through ${PRODUCT_NAME} after this render started, so it shows the frame before them; render again under a new jobId to see them.`);
  }
  if (r.warning) meta.warning = r.warning;

  const ks = ask.indices ?? (ask.seconds ?? []).map((t) => frameAt(t, r.fps));
  // Seek by the file's own rate: a GIF stores delays in hundredths of a second, which can drift from the asked fps.
  const seekFps = r.probe?.fps ?? r.fps;
  const last = counted !== undefined ? counted - 1 : undefined;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const shots: Array<Record<string, unknown>> = [];
  for (const k of ks) {
    const shot: Record<string, unknown> = { frame: k, t: round4(k / r.fps) };
    if (last !== undefined && k > last) {
      shots.push({ ...shot, error: `past the last frame (${last})` });
      continue;
    }
    try {
      const png = await grabFrame(run, saved.path, frameSeek(k, seekFps));
      if (png.length > INLINE_LIMIT) {
        // Too large to read inline; it lands next to the video instead.
        const stem = saved.path.slice(0, saved.path.length - extname(saved.path).length);
        shots.push({ ...shot, path: await writeExport(`${stem}-f${k}.png`, png, roots) });
      } else {
        images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        shots.push({ ...shot, image: images.length });
      }
    } catch (err) {
      if (isMissing(err)) {
        notes.push("ffmpeg not on PATH; frames skipped. The video is written — open it, or install ffmpeg for frames.");
        break;
      }
      shots.push({ ...shot, error: messageOf(err) });
    }
  }
  if (shots.length) meta.frames = shots;
  if (notes.length) meta.note = notes.join(" ");
  // No structuredContent: a client that prefers it over `content` would drop the frames.
  return { content: [{ type: "text", text: JSON.stringify(meta) }, ...images] };
}

/**
 * Whether the plugin reported a document change after `t`: an edit by hand in
 * Figma leaves no trace in writeEpoch(). Any doubt counts as a change — the
 * cost is one more render, never an old one handed out as current.
 */
async function changedSince(bridge: Bridge, t: number): Promise<boolean> {
  try {
    const { sessions } = await bridge.statusAsync();
    return sessions.some((s) => (s.lastNodesChanged?.at ?? Number.NEGATIVE_INFINITY) >= t);
  } catch {
    return true;
  }
}

function registerExportVideo(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, run: ExecFileLike, jobs: VideoJobs<Rendered>): void {
  if (!wanted("export_video")) return;
  server.registerTool(
    "figma_export_video",
    {
      title: "Export an animation as video",
      description: fitDescription(
        "Render the animation of a top-level frame to MP4, GIF or WEBM — the way to SEE motion; figma_export_node renders " +
          "only the resting state. A layer exports its top-level frame (`exportedNodeId`). Always writes a file (`saveTo`, " +
          "else the export directory). Waits up to `wait` s (default 40); a longer render answers status \"rendering\" with " +
          "a `jobId`, and figma_export_video { jobId } collects it, so no client timeout loses a render. Name your own " +
          "`jobId` for long renders and never start a second export meanwhile; `cancel` + `jobId` drops one. `frameIndices` " +
          "(or `frames`, seconds) return those frames as PNG, frame-exact, when ffmpeg is on PATH; `frameCount` vs " +
          "`expectedFrames` checks the length. Meanwhile other Figma calls answer BUSY (nothing ran); " +
          "figma_review_video and figma_get_guide still work. For a contact sheet, close-ups and metrics, run " +
          "figma_review_video on the file. fps: MP4/WEBM 12|24|30|60, GIF 8|12|15|24|30. Needs keyframes. Skills: " +
          "motion, critique (figma_get_guide).",
      ),
      inputSchema: {
        nodeId: z.string().optional().describe("The animated top-level frame, or any layer inside it (id or Figma link). Starts a render; omit it to collect one by `jobId`."),
        format: z.enum(VIDEO_FORMATS).optional().describe("Default MP4, or what the saveTo extension implies."),
        fps: z.number().int().optional().describe("MP4/WEBM 12, 24, 30 (default), 60; GIF 8, 12, 15 (default), 24, 30."),
        quality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("MP4/WEBM only. Default HIGH."),
        loopCount: z.number().int().min(0).max(1000).optional().describe("GIF only: 0 loops forever (default)."),
        width: z.number().positive().optional().describe("Output width in px; height follows the aspect ratio."),
        height: z.number().positive().optional().describe("Output height in px; width follows the aspect ratio."),
        scale: z.number().optional().describe("0.5, 0.75, 1 (default), 1.5, 2, 3 or 4."),
        saveTo: z.string().optional().describe("File to write, .mp4 / .gif / .webm. Same path rules as figma_export_node's saveTo."),
        frames: z.array(z.number().min(0)).max(MAX_FRAMES).optional().describe("Seconds to return as PNG stills, each mapped to its nearest frame, e.g. [0, 0.4]."),
        frameIndices: z.array(z.number().int().min(0)).max(MAX_FRAMES).optional().describe("Frames to return as PNG stills, exactly: frame k is the timeline at k / fps. Not with `frames`."),
        wait: z.number().int().min(0).max(600).optional().describe("Seconds this call waits for the render (default 40). Lower it if your client cuts calls sooner; 0 starts and returns."),
        jobId: z.string().min(1).max(64).optional().describe("Letters, digits, . _ -. With `nodeId`: your name for this render. Alone: collect or poll that render."),
        cancel: z.boolean().optional().describe("With `jobId` only: drop that render. Figma finishes a render it has begun; its result is discarded."),
        ...SESSION,
      },
      annotations: readAnnotations("export_video"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      // Refused before Figma was asked: the call only reads, and nothing ran.
      const refuse = (err: unknown) => errorResult(err, { readOnly: true, unchanged: true });
      const invalid = (message: string, hint?: string) => refuse(new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {}));
      const named = (keys: readonly string[]) => keys.map((k) => `\`${k}\``).join(", ");
      const jobId = typeof args.jobId === "string" ? args.jobId : undefined;
      if (jobId !== undefined && !JOB_ID.test(jobId)) return invalid("`jobId` takes 1 to 64 letters, digits, dots, dashes and underscores.", 'For example "hero-r2".');
      if (args.frames !== undefined && args.frameIndices !== undefined) {
        return invalid("Pass `frames` (seconds) or `frameIndices`, not both.", "frameIndices names frames exactly; frames maps each time to its nearest frame.");
      }
      const ask: FrameAsk = { seconds: args.frames as number[] | undefined, indices: args.frameIndices as number[] | undefined };
      const waitMs = (typeof args.wait === "number" ? args.wait : DEFAULT_WAIT_S) * 1000;
      const settingKeys = RENDER_KEYS.filter((k) => args[k] !== undefined);

      /** Wait for the job (at most `wait`), then answer with what it is now. */
      const answer = async (job: VideoJob<Rendered>, reused: boolean): Promise<CallToolResult> => {
        if (job.status === "rendering") {
          const beat = heartbeat(
            { progressToken: extra._meta?.progressToken, send: (n) => extra.sendNotification(n as ServerNotification) },
            `rendering ${job.format}`,
            job.startedAt,
            jobs.now,
          );
          let outcome: Awaited<ReturnType<typeof waitFor>>;
          try {
            outcome = await waitFor(job, waitMs, extra.signal);
          } finally {
            beat.stop();
          }
          // The caller is gone and the SDK sends nothing for a cancelled request [C-171]; the render goes on.
          if (outcome === "aborted") return { content: [] };
        }
        const ms = jobs.elapsedMs(job);
        switch (job.status) {
          case "rendering":
            return okResult({
              status: "rendering",
              jobId: job.id,
              elapsedS: round1(ms / 1000),
              nodeId: job.nodeId,
              ...(job.phase ? { phase: job.phase } : {}),
              hint:
                `Still rendering. Collect it with figma_export_video { jobId: "${job.id}" }; do not start another export. ` +
                "Until the render ends, other Figma calls answer BUSY and change nothing." +
                (ms >= STALL_MS
                  ? " No result after 2 min: a minimized Figma window stops video export — ask the user to restore the Figma window. " +
                    "Figma itself ends a render it has not finished in about 4 min (TIMEOUT)."
                  : ""),
            });
          case "cancelled":
            return okResult({ status: "cancelled", jobId: job.id });
          case "failed": {
            // The bridge's idle limit ran out: the commonest cause is a minimized Figma [C-198].
            const e = job.error;
            if (e instanceof BridgeError && e.code === ErrorCode.STALLED) {
              return errorResult(new BridgeError(e.code, e.message, { hint: "A minimized Figma window stops video export: ask the user to restore the Figma window, then render again." }), { readOnly: true });
            }
            // Figma ended the render itself, long before the bridge's idle limit [C-198]. A plugin
            // built before TIMEOUT existed reports it as UNSUPPORTED, which tells an agent to stop.
            if (e instanceof BridgeError && (e.code === ErrorCode.TIMEOUT || (e.code === ErrorCode.UNSUPPORTED && isRenderTimeout(figmaWords(e.message))))) {
              const said = e.code === ErrorCode.TIMEOUT ? e.message : e.message.replace(/^Figma could not export /, "Figma gave up rendering ");
              return errorResult(new BridgeError(ErrorCode.TIMEOUT, `${said} (${round1(ms / 1000)} s after the render started).`, { hint: RENDER_TIMEOUT_HINT }), { readOnly: true });
            }
            return errorResult(e, { readOnly: true });
          }
          case "done":
            return answerDone(job, ask, reused, run, roots, ms);
        }
      };

      if (args.cancel === true) {
        if (jobId === undefined) return invalid("`cancel` needs the `jobId` of the render to drop.");
        const others = [...(args.nodeId !== undefined ? ["nodeId"] : []), ...settingKeys, ...["wait", "frames", "frameIndices"].filter((k) => args[k] !== undefined)];
        if (others.length) return invalid(`\`cancel\` takes only \`jobId\` (got ${named(others)} too).`);
        const job = jobs.get(jobId);
        if (!job) return invalid(`No render named "${jobId}".`, NO_JOB_HINT);
        if (job.status === "rendering") {
          jobs.cancel(jobId);
          return okResult({
            status: "cancelled",
            jobId,
            note: "If Figma has begun this render it cannot stop it: the plugin stays busy until it ends, and the result is discarded.",
          });
        }
        jobs.delete(jobId);
        return okResult({ status: "cancelled", jobId, ...(job.status === "done" && job.result ? { note: `It had already finished; the file stays at ${job.result.saved.path}.` } : {}) });
      }

      if (args.nodeId === undefined) {
        if (jobId === undefined) return invalid("Pass `nodeId` to start a render, or `jobId` to collect one.");
        if (settingKeys.length) {
          return invalid(`${named(settingKeys)} describe a new render and need \`nodeId\`.`, `To collect "${jobId}", pass only \`jobId\` (and \`wait\`, \`frames\` or \`frameIndices\`).`);
        }
        const job = jobs.get(jobId);
        if (!job) return invalid(`No render named "${jobId}".`, NO_JOB_HINT);
        return answer(job, false);
      }

      const asked = typeof args.format === "string" ? (args.format as VideoFormat) : undefined;
      let saveTo = typeof args.saveTo === "string" ? args.saveTo : undefined;
      let settings: ReturnType<typeof videoSettings>;
      let target: string | undefined;
      try {
        let format = asked;
        if (saveTo !== undefined) {
          const ext = extname(saveTo).toLowerCase();
          const implied = VIDEO_FORMATS.find((f) => VIDEO_EXTENSION[f] === ext);
          if (ext && !implied) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`saveTo\` ends in ${ext}; a video is .mp4, .gif or .webm.`, { hint: "Or leave the extension off and it is added." });
          }
          if (asked && implied && asked !== implied) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`saveTo\` ends in ${ext} but \`format\` is ${asked}.`, { hint: "Make them agree, or omit `format` and let the extension decide." });
          }
          format = format ?? implied;
          if (!ext) saveTo = `${saveTo}${VIDEO_EXTENSION[format ?? "MP4"]}`;
        }
        settings = videoSettings({ ...args, format: format ?? "MP4" });
        // Fail on a bad path before Figma spends minutes rendering.
        if (saveTo !== undefined) target = await resolveSavePath(saveTo, roots);
      } catch (err) {
        return refuse(err);
      }
      const params: Record<string, unknown> = { nodeId: args.nodeId, format: settings.format };
      for (const k of ["fps", "quality", "loopCount", "width", "height", "scale"] as const) if (args[k] !== undefined) params[k] = args[k];
      let addressed: Awaited<ReturnType<typeof addressCall>>;
      try {
        addressed = await addressCall(bridge, "export_video", params, args.session as string | undefined);
      } catch (err) {
        return refuse(err);
      }
      const fps = typeof settings.fps === "number" ? settings.fps : DEFAULT_VIDEO_FPS[settings.format];
      const key = JSON.stringify([addressed.session ?? null, addressed.params.nodeId, settings, target ?? null]);
      // Handed out again only while it still shows the document [C-249]: no write through this
      // process since it started — a write queued behind a render runs after it.
      // A finished one also needs no change the plugin reported after it ended; not since it
      // started, because the event of the edit just before the render arrives debounced, late.
      const fresh = async (job: VideoJob<Rendered>) =>
        job.epoch === writeEpoch() && (job.status === "rendering" || !(await changedSince(bridge, job.endedAt ?? job.startedAt)));

      let job: VideoJob<Rendered> | undefined;
      let reused = false;
      const same = jobId !== undefined ? jobs.get(jobId) : undefined;
      if (same?.status === "rendering") {
        if (same.key !== key) {
          return invalid(
            `Render "${jobId}" is still running with other settings.`,
            `Collect it with figma_export_video { jobId: "${jobId}" }, drop it with { jobId: "${jobId}", cancel: true }, or give this render another jobId.`,
          );
        }
        job = same; // the agent named it: attach, as a retry after a cut-off call does
      } else {
        const candidate = same ? (same.status === "done" && same.key === key ? same : undefined) : jobId === undefined ? jobs.find(key) : undefined;
        if (candidate && (await fresh(candidate))) {
          job = candidate;
          reused = candidate.status === "done";
        }
      }
      if (!job) {
        try {
          job = jobs.start(
            { id: jobId ?? `video-${randomUUID().slice(0, 8)}`, key, nodeId: String(addressed.params.nodeId), format: settings.format, epoch: writeEpoch() },
            async (signal, j) => {
              // The job's own signal: only `cancel` aborts it, never the call that started it [C-249].
              const data = await bridge.request("export_video", addressed.params, {
                ...(addressed.session !== undefined ? { session: addressed.session } : {}),
                idleTimeoutMs: VIDEO_IDLE_TIMEOUT_MS,
                jobId: j.id,
                signal,
                onProgress: (p) => {
                  if (p.phase) j.phase = p.phase;
                },
              });
              return { saved: await saveVideo(data, saveTo, roots), fps, warning: addressed.warning };
            },
          );
        } catch (err) {
          return refuse(err);
        }
      }
      return answer(job, reused);
    },
  );
}

// ── the forwarded tools ──────────────────────────────────────────────────────

const FIELD =
  'What animates: a property ("OPACITY", "TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY", "ROTATION", "SCALE_X", ' +
  '"SCALE_XY", "WIDTH", "CORNER_RADIUS", …), "fill:<i>" / "stroke:<i>" (a SOLID paint\'s colour), or "effect:<i>:<FIELD>" ' +
  '(e.g. "effect:0:RADIUS", "effect:0:COLOR").';

// Nested objects are strict: zod's default strips an unknown key before the plugin sees it (params.ts).
const keyframe = z
  .object({
    t: z.number().min(0).describe("Position on the timeline, in seconds."),
    value: z.string().describe('By the field\'s type: a number "120" / "0.5", a colour "#ff000080", or a vector "10,20" (XY fields).'),
    easing: z
      .string()
      .optional()
      .describe('Into this keyframe: EASE_IN, EASE_OUT, EASE_IN_AND_OUT (not EASE_IN_OUT), LINEAR, EASE_*_BACK, GENTLE, QUICK, BOUNCY, SLOW, HOLD, "cubic:x1,y1,x2,y2" or "spring:<bounce 0-1>".'),
  })
  .strict();

export interface MotionOptions {
  /** ffmpeg runner, injected by tests; production runs node's execFile. */
  execFile?: ExecFileLike;
}

/**
 * Register the motion and prototype tools. Wired by the integrator in
 * tools/index.ts after the other groups: registerMotion(server, bridge,
 * { exportDir, exportRoots }, wanted).
 */
export function registerMotion(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, opts: MotionOptions = {}): void {
  const write = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) =>
        forwardTool(bridge, op, args, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        }),
    );
  };

  if (wanted("get_motion_context")) {
    server.registerTool(
      "figma_get_motion_context",
      {
        title: "Get motion (keyframe animation)",
        description: fitDescription(
          "The timeline animation of layers, for implementing it in code: per animated layer its keyframe tracks " +
            '({ field, keyframes: [{ t (s), value, easing }] }, the same strings figma_set_keyframes takes), animation ' +
            "styles, its top-level frame and timeline, plus `timelineCohorts` (layers that play together). " +
            "`topLevelFrameId` is the frame on the page, found through the parents; a cohort is keyed by that frame and " +
            "lists every `timelineIds` seen — a timeline id is never a node id. Inside an animated frame, address layers " +
            "by the ids your create calls returned: an id read from a listing there can be temporary. This is Motion, " +
            "not prototype interactions — those are figma_get_reactions. Defaults to the selection, then the page, and " +
            "reads descendants: a screen never animates itself, its layers do. `limits` says what the Plugin API cannot " +
            "tell (loop mode, pivot). Motion is a Figma beta: UNSUPPORTED means this account does not have it.",
        ),
        inputSchema: {
          nodeId: z.string().optional().describe("Layer or frame (id or Figma link). Defaults to the selection, then the current page."),
          recursive: z.boolean().optional().describe("Include descendants. Default true; false reads only the given layers (a page is always walked)."),
          maxNodes: z.number().int().min(1).max(2000).optional().describe("Layers inspected per call. Default 500."),
          cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
          ...SESSION,
        },
        annotations: readAnnotations("get_motion_context"),
      },
      async (args: Record<string, unknown>, extra: Extra) => forwardTool(bridge, "get_motion_context", args, extra, { session: args.session as string | undefined }),
    );
  }

  write(
    "set_keyframes",
    "Set keyframes (Motion)",
    "Animate a layer on its frame's timeline: each track replaces that field's keyframes; other tracks stay. Values and " +
      "easings are strings. Every track is read back once Figma settles and re-applied if it did not land: " +
      "`tracks[].status` is written or rewritten, `timeline` is { id, duration, topLevelFrameId } (`timelineNote` when " +
      "the ids differ), and a track that never lands fails INTERNAL with `partial.applied` / `notApplied`. The timeline grows to fit the last keyframe and never shrinks unless `timelineDuration` says so " +
      "(`tracks: []` + `timelineDuration` only sets it). Refused before any change: a top-level frame (animate a " +
      "child), WIDTH/HEIGHT on a group or vector, a missing or non-SOLID paint index, EASE_IN_OUT (Figma spells it " +
      "EASE_IN_AND_OUT). Not prototype transitions (figma_set_reactions). Check keys with figma_check_motion, see them " +
      "with figma_export_video. UNSUPPORTED means stop, not retry. Skills: motion, critique (figma_get_guide).",
    {
      nodeId: z.string().describe("The layer to animate — inside a top-level frame, not the frame itself."),
      tracks: z
        .array(z.object({ field: z.string().describe(FIELD), keyframes: z.array(keyframe).min(1).max(100) }).strict())
        .max(50)
        .optional()
        .describe("One entry per field."),
      timelineDuration: z.number().positive().optional().describe("Seconds. Applied as given, even if shorter than the keyframes."),
    },
  );

  write(
    "remove_keyframes",
    "Remove keyframes (Motion)",
    "Remove a layer's manual keyframe tracks: the given `fields`, or every track when omitted. A field that is not " +
      "animated is reported in `notAnimated`, not an error. Each removal is read back once Figma settles and repeated " +
      "if the track is still there; one that will not go fails INTERNAL with `partial.notRemoved`. Returns `removed` " +
      "and `remaining`, read back. Animation styles are not touched; figma_set_keyframes writes tracks.",
    {
      nodeId: z.string(),
      fields: z.array(z.string()).min(1).max(100).optional().describe('Fields as figma_get_motion_context names them, e.g. ["OPACITY", "fill:0"].'),
    },
  );

  write(
    "set_scroll_behavior",
    "Set scroll and fixed layers",
    "Prototype scrolling for a frame: `overflow` (none, horizontal, vertical, both) and which direct children stay fixed " +
      "while the rest scrolls (`fixedNodeIds`, bottom to top; [] fixes none). Fixed layers are moved to the top of the " +
      "layer list, so in an auto-layout frame each must be absolute first (figma_move_nodes positioning \"absolute\"), " +
      "and an instance takes `overflow` only — Figma moves none of its layers, so fix them in its main component. " +
      "This is presentation behaviour; to cut content off on the canvas use figma_set_clips_content.",
    {
      nodeId: z.string().describe("A frame, component or instance (an instance: `overflow` only)."),
      overflow: z.enum(["none", "horizontal", "vertical", "both"]).optional(),
      fixedNodeIds: z.array(z.string()).max(200).optional().describe("Direct children to fix (e.g. a nav bar), bottom to top."),
    },
  );

  write(
    "set_prototype_flows",
    "Set prototype flows",
    "Replace a page's prototype flow starting points, in order — the first is where the play button starts — and/or its " +
      "prototype background colour. Each flow starts at a top-level frame on that page; `flows: []` removes them all. " +
      "Per-layer interactions (click, hover, navigate) are figma_set_reactions.",
    {
      pageId: z.string().optional().describe("Default: the current page."),
      flows: z
        .array(z.object({ nodeId: z.string().describe("A top-level frame on the page."), name: z.string().min(1) }).strict())
        .max(100)
        .optional(),
      background: hexColor.optional().describe("Prototype background, e.g. \"#111111\"."),
    },
  );

  // One store per server: a process serves one MCP connection, and the store is where its renders live.
  registerExportVideo(server, bridge, roots, wanted, opts.execFile ?? nodeExecFile, new VideoJobs<Rendered>());
}
