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
//
// What a collecting call does stays inside its own wait: the job counts the
// frames (ffprobe decodes the whole file) right after it saves the video, and
// the stills are cut only while the call's wait lasts — the rest come back as
// `framesPending` for the next call. A late finish once spent its whole answer
// on ffprobe and twelve ffmpeg runs, past the client's 60 s (2026-10-14 audit).
//
// The motion process (motion-process.ts) stands in front of the keyframe
// writes and of a final render: under BRIDGE_PROCESS=strict a keyframe write
// needs the motion skill read and a plan on the frame, and `final: true` a
// passing figma_check_motion with no change to the file since. A final call
// that names a render already running or done (its `jobId`, or the same
// settings) attaches to it before the gate reads anything: the gate's read
// would answer BUSY while that render holds the plugin.

import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { toolName } from "../../shared/ops.js";
import { PRODUCT_NAME } from "../../shared/version.js";
import {
  DEFAULT_VIDEO_FPS,
  expectedFrames,
  figmaWords,
  frameAt,
  frameSeek,
  isRenderTimeout,
  renderTimeoutHint,
  VIDEO_EXTENSION,
  VIDEO_FORMATS,
  VIDEO_MIME,
  videoSettings,
  type VideoFormat,
} from "../../shared/video.js";
import { renderLostAdvice, type Bridge, type SessionView } from "../bridge.js";
import { bytesOf } from "../binary.js";
import { defaultExportName, resolveSavePath, writeExport, type ExportRoots } from "../exports.js";
import { DEFAULT_MEDIA_TOOLS, isMissing, nodeExecFile, noFfmpegHint, type ExecFileLike, type MediaTools } from "../ffmpeg.js";
import { fileNow, finalCall, finalGate, keyframeGate, sessionIdOf, withProcessWarnings, type AcceptedNote, type MotionProcess } from "../motion-process.js";
import { finalExportGate, type RoleProcess } from "../role-process.js";
import { errorResult, okResult } from "../results.js";
import { heartbeat, VideoJobs, waitFor, type VideoJob } from "../video-jobs.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { DEFAULT_MAX_SIZE, INLINE_LIMIT } from "./export.js";
import { addressCall, forwardTool, writeEpoch, writesSince, type Extra } from "./forward.js";
import { fitDescription, hexColor } from "./params.js";

export type { ExecFileLike } from "../ffmpeg.js";

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
/** The longest a call waits, whatever `wait` asks, unless BRIDGE_VIDEO_MAX_WAIT_S allows more (config.ts) [C-030]. */
export const DEFAULT_MAX_WAIT_S = 45;
/** Stills a finished render gets even when the call's wait is spent: a few seconds, still under a 60 s client. */
const MIN_FRAME_BUDGET_MS = 5_000;
/** One ffmpeg run for one still; one that hangs must not take the call with it. */
const STILL_TIMEOUT_MS = 15_000;
/** ffprobe -count_frames decodes the whole file; this bounds it inside the job. */
const PROBE_TIMEOUT_MS = 60_000;
/** A render with no result after this long gets the minimized-window hint [C-198]. */
export const STALL_MS = 120_000;
/** Past Figma's own 4-minute limit [C-198]: the render may never answer. */
const LOST_MS = 300_000;
const JOB_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** What describes a render, beside `nodeId` and `session`. */
const RENDER_KEYS = ["format", "fps", "quality", "loopCount", "width", "height", "scale", "saveTo"] as const;
const NO_JOB_HINT = `Renders are kept 30 min after they end, in the ${PRODUCT_NAME} process that started them. Pass \`nodeId\` to start one.`;

// ── ffmpeg, without a shell ──────────────────────────────────────────────────

/**
 * Scale a still so its long side is at most `max` px, never up: a full-size
 * 1080 × 1920 frame is past what a vision request takes once several images
 * are in play, the reason figma_export_node caps inline images at 1024 [C-092].
 * Quoted for the filter graph, whose parser would split on the commas.
 */
export function stillScale(max: number): string {
  return `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`;
}

/**
 * One still of a video as PNG bytes. execFile with an argument array: the path
 * and the time are never parsed by a shell, whatever characters they contain.
 * `maxSide` scales it down (stillScale); `ffmpeg` is the program to run.
 */
export function grabFrame(run: ExecFileLike, video: string, t: number, opts: { ffmpeg?: string; maxSide?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    run(
      opts.ffmpeg ?? DEFAULT_MEDIA_TOOLS.ffmpeg,
      ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", ...(opts.maxSide ? ["-vf", stillScale(opts.maxSide)] : []), "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) },
      (err, stdout) => {
        if (err) reject(err.killed ? new Error(`ffmpeg took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} s for the frame at ${t} s`) : err);
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
export function probeVideo(run: ExecFileLike, path: string, opts: { ffprobe?: string; timeoutMs?: number } = {}): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    run(
      opts.ffprobe ?? DEFAULT_MEDIA_TOOLS.ffprobe,
      [
        "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames:format=duration",
        "-of", "json", path,
      ],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            reject(new Error(`ffprobe took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} s`));
            return;
          }
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── figma_export_video ───────────────────────────────────────────────────────

interface VideoData {
  nodeId: string;
  exportedNodeId: string;
  name: string;
  format: string;
  mime: string;
  bytes: number;
  durationS?: number;
}

/** The plugin's video and its bytes: inline `base64`, or `binary` once the bridge reassembled chunks (binary.ts). */
function asVideo(data: unknown): { d: VideoData; bytes: Buffer } {
  const d = data as Partial<VideoData> | null;
  const bytes = bytesOf(data);
  if (!d || typeof d !== "object" || !bytes || !(VIDEO_FORMATS as readonly string[]).includes(String(d.format))) {
    throw new BridgeError(ErrorCode.INTERNAL, "The plugin's video export carried no bytes.");
  }
  return { d: d as VideoData, bytes };
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

/**
 * Write the plugin's bytes. The job does this as soon as Figma answers, so the
 * file exists whether or not a call is left to collect it. When `saveTo` cannot
 * be written (the file is open elsewhere, the disk is full), the video goes to
 * a default name in the export directory instead, with a warning: a render is
 * minutes of Figma's time, and an error here used to lose it.
 */
export async function saveVideo(data: unknown, saveTo: string | undefined, roots: ExportRoots): Promise<SavedVideo & { warning?: string }> {
  const { d, bytes } = asVideo(data);
  const format = d.format as VideoFormat;
  const fallback = videoName(d.name, d.exportedNodeId, format);
  let path: string;
  let warning: string | undefined;
  try {
    path = await writeExport(saveTo ?? fallback, bytes, roots);
  } catch (err) {
    const first = messageOf(err);
    if (saveTo === undefined) {
      throw new BridgeError(ErrorCode.INTERNAL, `Figma rendered the video, but it could not be written to the export directory: ${first}`, {
        hint: `Free disk space in ${roots.exportDir}, or point BRIDGE_EXPORT_DIR somewhere writable, then render again.`,
      });
    }
    try {
      path = await writeExport(fallback, bytes, roots);
    } catch (again) {
      throw new BridgeError(ErrorCode.INTERNAL, `Figma rendered the video, but it could not be written to ${saveTo} (${first}) nor to the export directory (${messageOf(again)}).`, {
        hint: "Close the program holding the file, or free disk space, then render again.",
      });
    }
    warning = `Could not write ${saveTo} (${first}); the video was saved to ${path} instead.`;
  }
  return {
    path,
    bytes: d.bytes,
    format,
    mime: d.mime ?? VIDEO_MIME[format],
    nodeId: d.nodeId,
    exportedNodeId: d.exportedNodeId,
    name: d.name,
    ...(typeof d.durationS === "number" ? { durationS: d.durationS } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** A finished render, as a job keeps it. */
interface Rendered {
  saved: SavedVideo;
  /** The rate Figma sampled the timeline at: the asked fps, else the format's default. */
  fps: number;
  warnings: string[];
  /** ffprobe's answer, asked once, in the job, right after the file is written: null when it could not be had. */
  probe: VideoProbe | null;
  probeNote?: string;
}

/** Which frames a call wants back: seconds, or exact indices. */
interface FrameAsk {
  seconds: number[] | undefined;
  indices: number[] | undefined;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Count the frames of a written render: the job runs this, so no collecting call waits on a whole decode. */
async function probeRender(run: ExecFileLike, tools: MediaTools, path: string): Promise<Pick<Rendered, "probe" | "probeNote">> {
  try {
    return { probe: await probeVideo(run, path, { ffprobe: tools.ffprobe, timeoutMs: PROBE_TIMEOUT_MS }) };
  } catch (err) {
    return {
      probe: null,
      probeNote: isMissing(err) ? `ffprobe could not be started, so frameCount is not measured. ${noFfmpegHint(tools)}` : `ffprobe could not count the frames: ${messageOf(err)}`,
    };
  }
}

/** What answerDone needs beyond the job. */
interface DoneContext {
  run: ExecFileLike;
  tools: MediaTools;
  roots: ExportRoots;
  /** Stills are cut until then; the rest are `framesPending`. */
  deadline: number;
  now: () => number;
}

/** The answer for a finished render: the file, its frame count against the timeline, and the asked frames — as many as the call's wait allows. */
async function answerDone(
  job: VideoJob<Rendered>,
  ask: FrameAsk,
  reused: boolean,
  renderMs: number,
  ctx: DoneContext,
  /** What the motion process says about this render: `final`, and a note or warnings. */
  processFields: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const r = job.result!;
  const { saved } = r;
  const meta: Record<string, unknown> = {
    ...saved,
    ...(saved.exportedNodeId !== saved.nodeId ? { exported: "the top-level frame around the node — the only node Figma encodes as video" } : {}),
    status: "done",
    jobId: job.id,
    renderS: round1(renderMs / 1000),
    fps: r.fps,
    ...processFields,
  };
  const notes: string[] = r.probeNote ? [r.probeNote] : [];
  const counted = r.probe?.frames;
  // Every format ends on the first frame at or after the timeline's end: ceil(d · fps) + 1 [C-194].
  const expected = saved.durationS !== undefined ? expectedFrames(saved.durationS, r.fps) : undefined;
  if (counted !== undefined) meta.frameCount = counted;
  if (expected !== undefined) meta.expectedFrames = expected;
  // A GIF keeps each frame's delay in hundredths of a second, so its own clock can differ from `fps` [C-194].
  if (saved.format === "GIF" && r.probe) {
    meta.fileFps = round3(r.probe.fps);
    if (r.probe.durationS !== undefined) meta.fileDurationS = round3(r.probe.durationS);
  }
  if (counted !== undefined && expected !== undefined && counted !== expected) {
    notes.push(`The file has ${counted} frames; a ${saved.durationS} s timeline at ${r.fps} fps implies ${expected} (the end frame renders too: ceil(duration × fps) + 1).`);
  }
  if (reused) meta.reused = true;
  if (writesSince(job.epoch) > 0) {
    notes.push(`Edits ran through ${PRODUCT_NAME} after this render started, so it shows the frame before them; render again under a new jobId to see them.`);
  }
  if (r.warnings.length) meta.warning = r.warnings.join(" ");

  const ks = ask.indices ?? (ask.seconds ?? []).map((t) => frameAt(t, r.fps));
  // Seek by the file's own rate: a GIF stores delays in hundredths of a second, which can drift from the asked fps.
  const seekFps = r.probe?.fps ?? r.fps;
  const last = counted !== undefined ? counted - 1 : undefined;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const shots: Array<Record<string, unknown>> = [];
  const pending: number[] = [];
  let missing = false;
  for (const k of ks) {
    const shot: Record<string, unknown> = { frame: k, t: round4(k / r.fps) };
    if (last !== undefined && k > last) {
      shots.push({ ...shot, error: `past the last frame (${last})` });
      continue;
    }
    const left = ctx.deadline - ctx.now();
    if (missing || left <= 0) {
      if (!missing) pending.push(k);
      continue;
    }
    try {
      // The long side at most 1024 px, as figma_export_node's inline images [C-092].
      const png = await grabFrame(ctx.run, saved.path, frameSeek(k, seekFps), { ffmpeg: ctx.tools.ffmpeg, maxSide: DEFAULT_MAX_SIZE, timeoutMs: Math.max(1_000, Math.min(left, STILL_TIMEOUT_MS)) });
      if (png.length > INLINE_LIMIT) {
        // Too large to read inline; it lands next to the video instead.
        const stem = saved.path.slice(0, saved.path.length - extname(saved.path).length);
        shots.push({ ...shot, path: await writeExport(`${stem}-f${k}.png`, png, ctx.roots) });
      } else {
        images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        shots.push({ ...shot, image: images.length });
      }
    } catch (err) {
      if (isMissing(err)) {
        notes.push(`ffmpeg could not be started, so frames are skipped. The video is written — open it, or make ffmpeg available for frames. ${noFfmpegHint(ctx.tools)}`);
        missing = true;
        continue;
      }
      shots.push({ ...shot, error: messageOf(err) });
    }
  }
  if (shots.length) meta.frames = shots;
  if (pending.length) {
    // The call's wait is spent: the rest come from the next call, which renders nothing.
    meta.framesPending = pending;
    notes.push(`${pending.length} frame(s) were not cut within this call's wait: collect them with figma_export_video { jobId: "${job.id}", frameIndices: [${pending.join(", ")}] }.`);
  }
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

/**
 * The session a render runs in, picked the way the bridge picks one
 * (sessions.ts select: by id, then file name, else the active one), so the
 * render can be pinned to it and keyed by it: a render of "1:2" in one file is
 * never handed out for "1:2" in another. Undefined when none is connected.
 */
export function renderSession(sessions: readonly SessionView[], arg: string | undefined): SessionView | undefined {
  if (!arg) return sessions.find((s) => s.active);
  const byId = sessions.find((s) => s.sessionId === arg);
  if (byId) return byId;
  const named = sessions.filter((s) => s.file.name?.toLowerCase() === arg.toLowerCase());
  // A Design file and its board often share a name: video export runs in Design.
  const design = named.filter((s) => s.editorType === "figma");
  return (design.length ? design : named).reduce<SessionView | undefined>((best, s) => (!best || s.lastActiveAt >= best.lastActiveAt ? s : best), undefined);
}

/** What the render tool is configured with (tools/index.ts from config.ts). */
interface VideoToolOptions {
  run: ExecFileLike;
  tools: MediaTools;
  maxWaitS: number;
}

/** What a call said about a render: `final` marks the delivery, with the warnings a guided gate left and the findings the plan accepted. */
interface RenderMark {
  final: boolean;
  warnings: string[];
  accepted: AcceptedNote[];
}

function registerExportVideo(
  server: McpServer,
  bridge: Bridge,
  roots: ExportRoots,
  wanted: (op: string) => boolean,
  vo: VideoToolOptions,
  jobs: VideoJobs<Rendered>,
  proc: MotionProcess | undefined,
  roles?: RoleProcess,
): void {
  if (!wanted("export_video")) return;
  const { run, tools } = vo;
  /**
   * Which top-level frame a node exported, learned from each render, per plugin
   * window: a render is keyed by the frame, so asking for the frame, or for any
   * layer already rendered through it, finds the same render.
   */
  const frames = new Map<string, string>();
  const learn = (fileId: string, nodeId: string, frame: string) => {
    for (const id of [nodeId, frame]) {
      frames.delete(`${fileId}|${id}`);
      frames.set(`${fileId}|${id}`, frame);
    }
    while (frames.size > 1000) frames.delete(frames.keys().next().value!);
  };
  // Per job, not per call: a final call may attach to a render a preview started, and a later call collects it.
  const marks = new WeakMap<VideoJob<Rendered>, RenderMark>();
  // The session each render's frame lives in (sessionIdOf): frame ids are per file.
  const sessions = new WeakMap<VideoJob<Rendered>, string>();
  /** The process fields of a finished render's answer; a delivery names the findings its plan accepted, for the report. */
  const processFields = async (job: VideoJob<Rendered>): Promise<Record<string, unknown>> => {
    const mark = marks.get(job);
    if (mark?.final) {
      return { final: true, ...(mark.accepted.length ? { accepted: mark.accepted } : {}), ...(mark.warnings.length ? { processWarnings: mark.warnings } : {}) };
    }
    if (!proc?.active || !job.result) return {};
    const { saved, fps } = job.result;
    const session = sessions.get(job) ?? "";
    const ready = proc.finalBlockers(saved.exportedNodeId, fps, session, await fileNow(bridge, session)).length === 0;
    return {
      final: false,
      processNote: ready
        ? `Preview. figma_check_motion passed on this frame at ${fps} fps with no change to the file since: the delivery render is ${finalCall(saved.exportedNodeId, fps)}.`
        : `Preview, for judging the motion. The delivery render is ${finalCall(saved.exportedNodeId, fps)}, once figma_check_motion passes on this frame at that fps with no change to the file after it.`,
    };
  };
  server.registerTool(
    "figma_export_video",
    {
      title: "Export an animation as video",
      description: fitDescription(
        "Render the animation of a top-level frame to MP4, GIF or WEBM — the way to SEE motion; figma_export_node renders " +
          "only the rest state. A layer exports its top-level frame (`exportedNodeId`). Always writes a file (`saveTo`, " +
          "else the export directory). Waits up to `wait` s (default 40, at most 45); a longer render answers status " +
          "\"rendering\" with a `jobId`, and figma_export_video { jobId } collects it. " +
          "Name your own `jobId` for long renders and start no second export meanwhile; `cancel` + `jobId` drops one. " +
          "`frameIndices` (or `frames`, seconds) return those frames as PNG (long side ≤ 1024), frame-exact, with ffmpeg; " +
          "ones not cut in time come back as `framesPending`. A render is a preview; `final: true` is the delivery, " +
          "refused under BRIDGE_PROCESS=strict until figma_check_motion passed on the frame at this fps, the file " +
          "unchanged since. Meanwhile other Figma calls answer BUSY. fps: MP4/WEBM 12|24|30|60, GIF 8|12|15|24|30. " +
          "Skills: motion, critique.",
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
        wait: z.number().int().min(0).max(600).optional().describe("Seconds this call waits for the render (default 40; at most 45 unless the server allows more). Lower it if your client cuts calls sooner; 0 starts and returns."),
        jobId: z.string().min(1).max(64).optional().describe("Letters, digits, . _ -. With `nodeId`: your name for this render. Alone: collect or poll that render."),
        cancel: z.boolean().optional().describe("With `jobId` only: drop that render. Figma finishes a render it has begun; its result is discarded."),
        final: z
          .boolean()
          .optional()
          .describe("true for the delivery render: needs a passing figma_check_motion on the frame at this fps, with no change to the file since. Default false: a preview."),
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
      // A call waits at most maxWaitS whatever `wait` says: one that runs past the
      // client's limit is cut, and a client may then restart the server [C-271].
      const askedWaitS = typeof args.wait === "number" ? args.wait : DEFAULT_WAIT_S;
      const waitS = Math.min(askedWaitS, vo.maxWaitS);
      const waitMs = waitS * 1000;
      const capped = askedWaitS > waitS ? { waitCappedS: waitS } : {};
      const callStart = jobs.now();
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
              ...capped,
              hint:
                `Still rendering. Collect it with figma_export_video { jobId: "${job.id}" }; do not start another export. ` +
                "Until the render ends, other Figma calls answer BUSY and change nothing." +
                (ms >= STALL_MS
                  ? " No result after 2 min: a minimized Figma window stops video export — ask the user to restore the Figma window. " +
                    "Figma itself ends a render it has not finished in about 4 min (TIMEOUT)."
                  : "") +
                (ms >= LOST_MS ? ` ${renderLostAdvice(ms / 1000)}` : "") +
                ("waitCappedS" in capped ? ` This server waits at most ${waitS} s per call (BRIDGE_VIDEO_MAX_WAIT_S), a margin under clients that cut calls at 60 s.` : ""),
            });
          case "cancelled":
            return okResult({ status: "cancelled", jobId: job.id });
          case "failed": {
            // An older hub's idle limit ran out: the commonest cause is a minimized Figma [C-198].
            const e = job.error;
            if (e instanceof BridgeError && e.code === ErrorCode.STALLED) {
              return errorResult(new BridgeError(e.code, e.message, { hint: "A minimized Figma window stops video export: ask the user to restore the Figma window, then render again." }), { readOnly: true });
            }
            // Figma ended the render itself [C-198]. The bridge picked the hint from its count of
            // timeouts in a row [C-318]; a plugin built before TIMEOUT existed reports it as
            // UNSUPPORTED, which tells an agent to stop, and an older hub passes that on.
            if (e instanceof BridgeError && (e.code === ErrorCode.TIMEOUT || (e.code === ErrorCode.UNSUPPORTED && isRenderTimeout(figmaWords(e.message))))) {
              const said = e.code === ErrorCode.TIMEOUT ? e.message : e.message.replace(/^Figma could not export /, "Figma gave up rendering ");
              return errorResult(
                new BridgeError(ErrorCode.TIMEOUT, `${said} (${round1(ms / 1000)} s after the render started).`, {
                  hint: e.code === ErrorCode.TIMEOUT && e.hint ? e.hint : renderTimeoutHint(),
                  ...(e.partial !== undefined ? { partial: e.partial } : {}),
                }),
                { readOnly: true },
              );
            }
            return errorResult(e, { readOnly: true });
          }
          case "done":
            return answerDone(
              job,
              ask,
              reused,
              ms,
              {
                run,
                tools,
                roots,
                deadline: Math.max(callStart + waitMs, jobs.now() + MIN_FRAME_BUDGET_MS),
                now: jobs.now,
              },
              await processFields(job),
            );
        }
      };

      if (args.cancel === true) {
        if (jobId === undefined) return invalid("`cancel` needs the `jobId` of the render to drop.");
        const others = [
          ...(args.nodeId !== undefined ? ["nodeId"] : []),
          ...settingKeys,
          ...["wait", "frames", "frameIndices", "final"].filter((k) => args[k] !== undefined),
        ];
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
        // `final` is decided when a render is asked for, not when it is collected.
        const describing = [...settingKeys, ...(args.final !== undefined ? ["final"] : [])];
        if (describing.length) {
          return invalid(`${named(describing)} describe a new render and need \`nodeId\`.`, `To collect "${jobId}", pass only \`jobId\` (and \`wait\`, \`frames\` or \`frameIndices\`).`);
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
      // Keyed by the file the render runs in (its plugin window) and pinned to that session, so
      // a render of "1:2" in one file is never handed out for "1:2" in another; and by the
      // frame it exports, once a render has shown which frame that is.
      let where: SessionView | undefined;
      try {
        where = renderSession((await bridge.statusAsync()).sessions, addressed.session);
      } catch {
        where = undefined;
      }
      const fileId = where?.instanceId ?? null;
      const session = where?.sessionId ?? addressed.session;
      const nodeId = String(addressed.params.nodeId);
      // `final` is not part of the key: a preview and a delivery of the same settings are the same bytes.
      const keyFor = (frame: string) => JSON.stringify([fileId, frame, settings, target ?? null]);
      const key = keyFor((fileId !== null ? frames.get(`${fileId}|${nodeId}`) : undefined) ?? nodeId);
      // Handed out again only while it still shows the document [C-249]: no write through this
      // process since it started (one refused before it reached Figma does not count) — a write
      // queued behind a render runs after it. A finished one also needs no change the plugin
      // reported after it ended; not since it started, because the event of the edit just
      // before the render arrives debounced, late.
      const fresh = async (job: VideoJob<Rendered>) =>
        writesSince(job.epoch) === 0 && (job.status === "rendering" || !(await changedSince(bridge, job.endedAt ?? job.startedAt)));

      // The render this call names or repeats is looked up before the motion gate: the gate reads
      // the frame's plan from the plugin, and that read answers BUSY while a render holds it, so a
      // final call retried after a client cut it off would be refused instead of collecting its own render.
      let job: VideoJob<Rendered> | undefined;
      let reused = false;
      const same = jobId !== undefined ? jobs.get(jobId) : undefined;
      if (same?.status === "rendering") {
        if (same.key !== key && same.key !== keyFor(nodeId)) {
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

      // The delivery waits for a passing check; a preview never does. Asked before any job is started.
      const final = args.final === true;
      let mark: RenderMark | undefined;
      let sessionId = "";
      if (proc?.active) {
        if (final && job && marks.get(job)?.final) {
          // This render passed the gate when it was asked for as the delivery: attach to it, or collect it.
          sessionId = sessions.get(job) ?? (await sessionIdOf(bridge, addressed.session));
        } else if (final && job?.status === "rendering") {
          // A preview of the same render still holds the plugin, so the gate cannot read the frame's plan until it ends.
          if (proc.mode === "strict") {
            return refuse(
              new BridgeError(
                ErrorCode.BUSY,
                `A preview with these settings is still rendering ("${job.id}"), and the final render's check reads the frame's motion plan from Figma, which has to wait until that render ends. Nothing was rendered as the delivery.`,
                {
                  hint: `Collect the preview with figma_export_video { jobId: "${job.id}" }, then ask again with final: true: the finished render becomes the delivery if the check still holds and nothing changed.`,
                },
              ),
            );
          }
          mark = { final: true, warnings: [`the frame's motion plan could not be read while the preview "${job.id}" holds the plugin, so this delivery was not checked against it`], accepted: [] };
          sessionId = await sessionIdOf(bridge, addressed.session);
        } else if (final) {
          const gate = await finalGate(proc, bridge, nodeId, addressed.session, fps, extra.signal);
          if (gate.refusal) return refuse(gate.refusal);
          // A frame that belongs to a brief also waits for its sign-off, which runs the motion
          // audit itself (figma_sign_off), so a signed frame has already passed the check above.
          const signed = roles
            ? await finalExportGate(roles, bridge, [nodeId], addressed.session, `figma_export_video { nodeId: "${nodeId}", fps: ${fps}, final: true }`, { signal: extra.signal })
            : { warnings: [] as string[] };
          if (signed.refusal) return refuse(signed.refusal);
          mark = { final: true, warnings: [...gate.warnings, ...signed.warnings], accepted: gate.accepted ?? [] };
          sessionId = gate.session;
        } else {
          sessionId = await sessionIdOf(bridge, addressed.session);
        }
      } else if (final) {
        mark = { final: true, warnings: [], accepted: [] };
      }

      if (!job) {
        try {
          job = jobs.start(
            { id: jobId ?? `video-${randomUUID().slice(0, 8)}`, key, nodeId, format: settings.format, epoch: writeEpoch() },
            async (signal, j) => {
              // The job's own signal: only `cancel` aborts it, never the call that started it [C-249].
              const data = await bridge.request("export_video", addressed.params, {
                ...(session !== undefined ? { session } : {}),
                idleTimeoutMs: VIDEO_IDLE_TIMEOUT_MS,
                jobId: j.id,
                signal,
                onProgress: (p) => {
                  if (p.phase) j.phase = p.phase;
                },
              });
              const { warning, ...saved } = await saveVideo(data, saveTo, roots);
              if (fileId !== null) {
                learn(fileId, nodeId, saved.exportedNodeId);
                j.key = keyFor(saved.exportedNodeId);
              }
              // Counted here, in the job, so the call that collects it never waits on a whole decode.
              j.phase = "counting frames";
              const probed = await probeRender(run, tools, saved.path);
              return { saved, fps, warnings: [addressed.warning, warning].filter((w): w is string => w !== undefined), ...probed };
            },
          );
        } catch (err) {
          return refuse(err);
        }
      }
      // A delivery stays one, whichever later call collects it.
      if (mark) marks.set(job, mark);
      if (proc?.active) sessions.set(job, sessionId);
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
  /** BRIDGE_FFMPEG / BRIDGE_FFPROBE (config.ts); names on PATH by default. */
  media?: MediaTools;
  /** BRIDGE_VIDEO_MAX_WAIT_S (config.ts): the longest one figma_export_video call waits. */
  maxWaitS?: number;
  /** The motion process gate (motion-process.ts). Without it nothing is gated: a test of the tools alone. */
  process?: MotionProcess;
  /** The role process (role-process.ts): a final render of a frame that belongs to a brief also needs its sign-off (spec §3.7). */
  roles?: RoleProcess;
}

/**
 * A keyframe write behind the motion gate: addressed, then the skill and the
 * frame's plan asked for (strict refuses, guided warns), then forwarded. Like
 * every write it moves writeEpoch(), which is what makes an earlier check stale.
 */
async function gatedKeyframeWrite(bridge: Bridge, proc: MotionProcess, op: string, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const key = args.idempotencyKey as string | undefined;
  let addressed: Awaited<ReturnType<typeof addressCall>>;
  try {
    addressed = await addressCall(bridge, op, args, args.session as string | undefined);
  } catch (err) {
    return errorResult(err instanceof BridgeError ? err.withKey(key) : err, { unchanged: true });
  }
  const gate = await keyframeGate(proc, bridge, toolName(op), String(addressed.params.nodeId), addressed.session, extra.signal);
  if (gate.refusal) return errorResult(gate.refusal.withKey(key), { unchanged: true });
  const result = await forwardTool(bridge, op, addressed.params, extra, { session: addressed.session, idempotencyKey: key });
  return withProcessWarnings(result, gate.warnings);
}

/**
 * Register the motion and prototype tools. Wired by the integrator in
 * tools/index.ts after the other groups: registerMotion(server, bridge,
 * { exportDir, exportRoots }, wanted, { media, maxWaitS, process }).
 */
export function registerMotion(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, opts: MotionOptions = {}): void {
  const proc = opts.process;
  const write = (op: string, title: string, description: string, shape: z.ZodRawShape, gated = false) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) =>
        gated && proc?.active
          ? gatedKeyframeWrite(bridge, proc, op, args, extra)
          : forwardTool(bridge, op, args, extra, {
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
            "styles, its top-level frame and timeline, plus `timelineCohorts` (layers that play together) and " +
            "`motionPlans` (each frame's figma_set_motion_plan). " +
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
    "Animate a layer on its frame's timeline: each track replaces that field's keyframes; other tracks stay. Every " +
      "track is read back and re-applied if it did not land: `tracks[].status` is written " +
      "or rewritten, `timeline` is { id, duration, topLevelFrameId }, and a track that never lands fails INTERNAL with " +
      "`partial.notApplied`. The timeline grows to fit the last key and never shrinks unless `timelineDuration` says " +
      "so (`tracks: []` + `timelineDuration` only sets it). Refused before any change: a top-level frame (animate a " +
      "child), WIDTH/HEIGHT on a group or vector, a missing or non-SOLID paint, EASE_IN_OUT (Figma spells it " +
      "EASE_IN_AND_OUT); under BRIDGE_PROCESS=strict (the default) PROCESS_REQUIRED until this session read the motion " +
      "skill (figma_get_guide) and the frame has a plan (figma_set_motion_plan). Not prototype transitions " +
      "(figma_set_reactions). Check keys with figma_check_motion. UNSUPPORTED means stop, not retry. Skill: motion.",
    {
      nodeId: z.string().describe("The layer to animate — inside a top-level frame, not the frame itself."),
      tracks: z
        .array(z.object({ field: z.string().describe(FIELD), keyframes: z.array(keyframe).min(1).max(100) }).strict())
        .max(50)
        .optional()
        .describe("One entry per field."),
      timelineDuration: z.number().positive().optional().describe("Seconds. Applied as given, even if shorter than the keyframes."),
    },
    true,
  );

  write(
    "remove_keyframes",
    "Remove keyframes (Motion)",
    "Remove a layer's manual keyframe tracks: the given `fields`, or every track when omitted. A field that is not " +
      "animated is reported in `notAnimated`, not an error. Each removal is read back once Figma settles and repeated " +
      "if the track is still there; one that will not go fails INTERNAL with `partial.notRemoved`. Returns `removed` " +
      "and `remaining`, read back. Animation styles are not touched; figma_set_keyframes writes tracks. Under " +
      "BRIDGE_PROCESS=strict (the default) PROCESS_REQUIRED until this session read the motion skill (figma_get_guide) " +
      "and the frame has a plan (figma_set_motion_plan).",
    {
      nodeId: z.string(),
      fields: z.array(z.string()).min(1).max(100).optional().describe('Fields as figma_get_motion_context names them, e.g. ["OPACITY", "fill:0"].'),
    },
    true,
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
  registerExportVideo(
    server,
    bridge,
    roots,
    wanted,
    { run: opts.execFile ?? nodeExecFile, tools: opts.media ?? DEFAULT_MEDIA_TOOLS, maxWaitS: opts.maxWaitS ?? DEFAULT_MAX_WAIT_S },
    new VideoJobs<Rendered>(),
    proc,
    opts.roles,
  );
}
