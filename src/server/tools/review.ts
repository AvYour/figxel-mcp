// figma_review_video — look at a render without rendering again [C-182].
//
// Once a video exists, everything needed to judge its motion can be cut from
// the file: a contact sheet of the whole piece, every-frame close-ups of a
// window (the spacing between frames is the speed), frame-exact stills, and
// per-frame numbers that find freezes, flickers, flashes and jumps
// (video-metrics.ts). No Figma call is involved, so it answers while the
// plugin is busy rendering, in any editor.
//
// ffmpeg does the cutting, always from an argument array and never through a
// shell. Its images come back on stdout and are written here, inside the
// export roots, like every other export: ffmpeg itself writes nothing.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { PRODUCT_NAME } from "../../shared/version.js";
import { frameAtOrAfter, frameAtOrBefore } from "../../shared/motion-curves.js";
import { frameSeek } from "../../shared/video.js";
import { resolveSavePath, writeExport, type ExportRoots } from "../exports.js";
import { errorResult } from "../results.js";
import { analyse, analysisHeight, ANALYSIS_WIDTH, FrameMeter, type Finding, type MetricsReport } from "../video-metrics.js";
import { readAnnotations } from "./annotations.js";
import { INLINE_LIMIT } from "./export.js";
import { grabFrame, probeVideo, type ExecFileLike, type VideoProbe } from "./motion.js";
import { fitDescription } from "./params.js";

/** A sheet past this many tiles stops being readable as one image; `every` is raised to fit. */
export const MAX_SHEET_TILES = 240;
const MAX_IMAGES_DEFAULT = 4;
const PNG_MAX_BUFFER = 64 * 1024 * 1024;

// ── processes ────────────────────────────────────────────────────────────────

/** The part of a child process the decode pass reads. */
export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  once(event: "error", listener: (err: Error & { code?: unknown }) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

export type SpawnLike = (file: string, args: readonly string[], options: { windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

const nodeExecFile: ExecFileLike = (file, args, options, callback) => execFile(file, [...args], options, callback);
const nodeSpawn: SpawnLike = (file, args, options) => spawn(file, [...args], options);

/**
 * Stream every frame as 8-bit grey at `width` × `height`. The height is
 * computed here rather than left to scale's -2, so the byte size of a frame is
 * known before the first byte arrives. Three frames live at a time.
 */
function decodeGray(run: SpawnLike, video: string, width: number, height: number, onFrame: (frame: Uint8Array) => void): Promise<number> {
  const size = width * height;
  return new Promise((resolve, reject) => {
    let child: ChildLike;
    try {
      child = run(
        "ffmpeg",
        ["-v", "error", "-i", video, "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    let frame = new Uint8Array(size);
    let filled = 0;
    let count = 0;
    const said: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      for (let off = 0; off < chunk.length; ) {
        const n = Math.min(size - filled, chunk.length - off);
        frame.set(chunk.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled === size) {
          onFrame(frame);
          count++;
          frame = new Uint8Array(size);
          filled = 0;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (said.length < 32) said.push(chunk);
    });
    // A spawn that fails (ENOENT) emits "error" and may still emit "close"; the first settles.
    child.once("error", (err) => reject(err));
    child.once("close", (code) => {
      if (code === 0) resolve(count);
      else reject(new Error(Buffer.concat(said).toString("utf8").trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** One PNG on stdout from a filter graph: a sheet or a close-up. */
function filterImage(run: ExecFileLike, video: string, graph: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    run(
      "ffmpeg",
      ["-v", "error", "-i", video, "-vf", graph, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: PNG_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(err.code === "ENOENT" ? err : Object.assign(new Error(stderr?.toString("utf8").trim() || err.message), { code: err.code }));
        else if (!stdout || stdout.length === 0) reject(new Error("ffmpeg produced no image (no frame matched?)"));
        else resolve(stdout);
      },
    );
  });
}

/** Whether this ffmpeg was built with the filter — drawtext needs libfreetype [C-205]. */
function hasFilter(run: ExecFileLike, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    run("ffmpeg", ["-hide_banner", "-h", `filter=${name}`], { encoding: "buffer", maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(!err && stdout.toString("utf8").includes(`Filter ${name}`)),
    );
  });
}

/** Font files to label tiles with, most common first; drawtext needs a file, not a name [C-205]. */
export function fontCandidates(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === "win32") {
    const fonts = `${(env.WINDIR ?? env.SystemRoot ?? "C:\\Windows").replace(/[\\/]+$/, "")}\\Fonts`;
    return ["arial.ttf", "segoeui.ttf", "tahoma.ttf", "consola.ttf"].map((f) => `${fonts}\\${f}`);
  }
  if (platform === "darwin") {
    return ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Monaco.ttf"];
  }
  return [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  ];
}

/**
 * A font path as one drawtext option inside a filter graph. The option parser
 * splits on ':', so a drive letter's colon is escaped; the graph parser would
 * eat that backslash, so the value is quoted for it. Forward slashes avoid a
 * second layer of backslashes. A path with a quote is not offered.
 */
export function fontOption(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  return p.includes("'") ? undefined : `'${p.replace(/:/g, "\\:")}'`;
}

/** The frame number in the tile's corner. Placed before `select`, so `n` is the frame's index in the video, not in the selection. */
function labelFilter(font: string, tileWidth: number): string {
  const size = Math.max(10, Math.round(tileWidth / 9));
  return `drawtext=fontfile=${font}:text='%{n}':x=4:y=4:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`;
}

/** Scale (and label), keep the frames `select` names, lay `count` of them out `columns` wide. */
export function tileGraph(o: { tileWidth: number; tileHeight: number; label?: string; select: string; columns: number; count: number }): string {
  const rows = Math.max(1, Math.ceil(o.count / o.columns));
  const columns = Math.min(o.columns, Math.max(1, o.count));
  return [
    `scale=${o.tileWidth}:${o.tileHeight}:flags=area`,
    ...(o.label ? [o.label] : []),
    `select='${o.select}'`,
    // nb_frames: the image is out as soon as the last tile arrives, without decoding the rest of the file.
    `tile=${columns}x${rows}:nb_frames=${o.count}:padding=2:margin=2`,
  ].join(",");
}

// ── the tool ─────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** ffmpeg / ffprobe runner for one-shot calls; tests inject a fake. */
  execFile?: ExecFileLike;
  /** The decode pass, which streams; tests inject a fake. */
  spawn?: SpawnLike;
  /** Font files to try for frame labels. */
  fonts?: readonly string[];
  exists?: (path: string) => boolean;
}

const closeup = z
  .object({
    startFrame: z.number().int().min(0).describe("First frame of the window."),
    frames: z.number().int().min(2).max(48).optional().describe("Frames in the window. Default 24."),
    columns: z.number().int().min(1).max(12).optional().describe("Tiles per row. Default 8."),
  })
  .strict();

// Frames, or seconds as figma_check_motion takes them: the 2026-10-14 run passed
// one tool's shape to the other, so each takes both.
const hold = z
  .object({
    fromFrame: z.number().int().min(0).optional(),
    toFrame: z.number().int().min(0).optional(),
    from: z.number().min(0).optional().describe("Or seconds, as figma_check_motion takes them: the frames from the first at or after it."),
    to: z.number().min(0).optional().describe("Seconds: up to the last frame at or before it."),
  })
  .strict();

type Hold = { fromFrame?: number; toFrame?: number; from?: number; to?: number };

/** Why a hold cannot be read, or null: one pair, in order. */
function holdProblem(h: Hold, i: number): string | null {
  const frames = h.fromFrame !== undefined || h.toFrame !== undefined;
  const seconds = h.from !== undefined || h.to !== undefined;
  if (frames && seconds) return `holds[${i}] mixes frames (fromFrame, toFrame) with seconds (from, to); give one pair.`;
  if (seconds) {
    if (h.from === undefined || h.to === undefined) return `holds[${i}] needs both from and to (seconds).`;
    return h.to < h.from ? `A hold runs backwards: from ${h.from} s > to ${h.to} s.` : null;
  }
  if (h.fromFrame === undefined || h.toFrame === undefined) return `holds[${i}] needs fromFrame and toFrame, or from and to (seconds).`;
  return h.toFrame < h.fromFrame ? `A hold runs backwards: fromFrame ${h.fromFrame} > toFrame ${h.toFrame}.` : null;
}

/** A hold as inclusive frames of a video at `fps` (frame k is the timeline at k / fps). */
const holdFrames = (h: Hold, fps: number): { fromFrame: number; toFrame: number } =>
  h.from !== undefined && h.to !== undefined ? { fromFrame: frameAtOrAfter(h.from, fps), toFrame: frameAtOrBefore(h.to, fps) } : { fromFrame: h.fromFrame!, toFrame: h.toFrame! };

const thresholds = z
  .object({
    freeze: z.number().min(0).optional().describe("Mean grey change (0–255) below which a frame shows no motion. Default 0.15."),
    minFreezeS: z.number().min(0).optional().describe("A still stretch at least this long (s) is a freeze. Default 0.5."),
    flicker: z.number().min(0).optional().describe("A frame unlike both neighbours by this much flickers. Default 1.0."),
    flashLuma: z.number().min(0).optional().describe("A whole-frame brightness jump this large (of 255) is a flash. Default 40."),
    spike: z.number().min(0).optional().describe("A one-frame change this large on part of the picture is a spike. Default 20."),
  })
  .strict();

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === "ENOENT";
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const NO_FFMPEG_HINT =
  `Install ffmpeg (it brings ffprobe) on the machine that runs ${PRODUCT_NAME} and put it on PATH. Without it, figma_check_motion still judges the keyframes, and figma_export_node shows the resting state.`;

/**
 * Register figma_review_video. Wired by the integrator in tools/index.ts:
 * registerReview(server, { exportDir, exportRoots }, wanted). It needs no
 * bridge: it reads a file on this machine.
 */
export function registerReview(server: McpServer, roots: ExportRoots, wanted: (op: string) => boolean, opts: ReviewOptions = {}): void {
  if (!wanted("review_video")) return;
  const run = opts.execFile ?? nodeExecFile;
  const decode = opts.spawn ?? nodeSpawn;
  const exists = opts.exists ?? existsSync;
  const fonts = opts.fonts ?? fontCandidates();
  // Asked once per server: the ffmpeg on PATH does not change under a running process.
  let labelling: Promise<string | undefined> | undefined;
  const labelFont = () =>
    (labelling ??= hasFilter(run, "drawtext").then((ok) => {
      if (!ok) return undefined;
      for (const f of fonts) {
        const option = exists(f) ? fontOption(f) : undefined;
        if (option) return option;
      }
      return undefined;
    }));

  server.registerTool(
    "figma_review_video",
    {
      title: "Review a rendered video",
      description: fitDescription(
        "See a rendered video without rendering again: a contact sheet of the whole piece, every-frame close-ups of a " +
          "window (the spacing between frames is the speed), frame-exact stills, and per-frame metrics that find " +
          "freezes, one-frame flickers, flashes, jumps and cuts. Pass the `path` figma_export_video wrote. No Figma call: " +
          "it answers while the plugin is busy, in any editor. Frame k is the timeline at k / fps. List the intended " +
          "`cuts` (e.g. panel boundaries) and `holds`: a jump or a still stretch there is not a finding, but a declared " +
          "cut that lands a frame early or late is. `expectFrames` checks the length. Returns JSON (numbers, then " +
          "findings with frames), then up to `maxImages` images; every image is also written beside the video, or in " +
          "`saveDir`. Needs ffmpeg and ffprobe on PATH, else UNSUPPORTED — figma_check_motion judges keyframes without " +
          "them. Skill: critique (figma_get_guide).",
      ),
      inputSchema: {
        path: z.string().min(1).describe("The video: the `path` figma_export_video returned, or a file inside the export roots."),
        every: z.number().int().min(1).optional().describe("Contact sheet: one tile every N frames, by frame index. Default: about 90 tiles."),
        columns: z.number().int().min(1).max(16).optional().describe("Contact sheet tiles per row. Default 9 portrait, 6 landscape."),
        tileWidth: z.number().int().min(64).max(480).optional().describe("Tile width in px, for the sheet and close-ups. Default 180 portrait, 240 landscape."),
        closeups: z.array(closeup).max(6).optional().describe("Windows to show frame by frame, e.g. around each transition."),
        stills: z.array(z.number().int().min(0)).max(24).optional().describe("Frames to return full size, exactly (frame k = k / fps)."),
        metrics: z.boolean().optional().describe("Per-frame analysis. Default true."),
        cuts: z.array(z.number().int().min(0)).max(64).optional().describe("Frames where a cut is meant: the frame that first shows the new picture."),
        holds: z.array(hold).max(20).optional().describe("Intended still stretches: inclusive frames, e.g. [{ fromFrame: 120, toFrame: 179 }], or seconds, e.g. [{ from: 4, to: 5.97 }]."),
        expectFrames: z.number().int().min(1).optional().describe("Frames the file should have, e.g. figma_export_video's expectedFrames."),
        thresholds: thresholds.optional().describe("Override the metric thresholds."),
        maxImages: z.number().int().min(0).max(8).optional().describe("Images returned inline (sheet, close-ups, stills, in that order). Default 4."),
        saveDir: z.string().optional().describe("Where the images go. Default: the video's folder. Same rules as figma_download_assets `dir`."),
      },
      annotations: readAnnotations("review_video"),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const refuse = (err: unknown) => errorResult(err, { readOnly: true, unchanged: true });
      const invalid = (message: string, hint?: string) => refuse(new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {}));

      // ── where: the video and the folder for images, both inside the roots ──
      let video: string;
      try {
        video = await resolveSavePath(String(args.path), roots);
      } catch (err) {
        if (err instanceof BridgeError) return refuse(new BridgeError(err.code, err.message.replace("`saveTo`", "`path`"), err.hint !== undefined ? { hint: err.hint } : {}));
        return refuse(err);
      }
      try {
        if (!(await stat(video)).isFile()) return invalid(`\`path\` is not a file: ${video}`);
      } catch {
        return invalid(`No video at ${video}.`, "Pass the `path` figma_export_video returned.");
      }
      let dir = dirname(video);
      if (typeof args.saveDir === "string") {
        try {
          dir = dirname(await resolveSavePath(join(args.saveDir, "probe.png"), roots));
        } catch (err) {
          if (err instanceof BridgeError) return refuse(new BridgeError(err.code, err.message.replace("`saveTo`", "`saveDir`"), err.hint !== undefined ? { hint: err.hint } : {}));
          return refuse(err);
        }
      }
      const asked = (args.holds as Hold[] | undefined) ?? [];
      const problem = asked.map(holdProblem).find((p) => p !== null);
      if (problem) return invalid(problem);

      // ── what the file is ──
      let probe: VideoProbe;
      try {
        probe = await probeVideo(run, video);
      } catch (err) {
        if (isMissing(err)) return errorResult(new BridgeError(ErrorCode.UNSUPPORTED, "ffprobe is not on PATH, so the video cannot be read.", { hint: NO_FFMPEG_HINT }), { readOnly: true });
        return invalid(`ffprobe cannot read ${video}: ${messageOf(err)}`, "Is it a video? figma_export_video writes .mp4, .gif or .webm.");
      }
      const notes: string[] = [];
      const findings: Finding[] = [];
      const holds = asked.map((h) => holdFrames(h, probe.fps));

      // ── numbers first: one decode pass ──
      let metrics: MetricsReport | undefined;
      let decoded: number | undefined;
      if (args.metrics !== false) {
        const height = analysisHeight(probe.width, probe.height);
        const meter = new FrameMeter(ANALYSIS_WIDTH * height);
        try {
          decoded = await decodeGray(decode, video, ANALYSIS_WIDTH, height, (f) => meter.push(f));
          const judged = analyse(meter.series, {
            fps: probe.fps,
            cuts: (args.cuts as number[] | undefined) ?? [],
            holds,
            thresholds: (args.thresholds as Record<string, number> | undefined) ?? {},
          });
          metrics = judged.metrics;
          findings.push(...judged.findings);
        } catch (err) {
          if (isMissing(err)) return errorResult(new BridgeError(ErrorCode.UNSUPPORTED, "ffmpeg is not on PATH, so the video cannot be decoded.", { hint: NO_FFMPEG_HINT }), { readOnly: true });
          notes.push(`The metrics pass failed: ${messageOf(err)}`);
        }
      }
      const frames = probe.frames ?? decoded ?? Math.max(1, Math.round((probe.durationS ?? 0) * probe.fps));
      const out: Record<string, unknown> = {
        path: video,
        video: { width: probe.width, height: probe.height, fps: round3(probe.fps), frames, ...(probe.durationS !== undefined ? { durationS: round3(probe.durationS) } : {}) },
      };
      if (typeof args.expectFrames === "number") {
        if (frames === args.expectFrames) out.frameCountNote = `${frames} frames, as expected.`;
        else {
          out.frameCountNote = `${frames} frames; expected ${args.expectFrames}.`;
          // Every format ends on the first frame at or after the timeline's end [C-194].
          findings.push({
            kind: "frame_count",
            severity: "warning",
            frames: [frames - 1],
            detail: `the file has ${frames} frames, not the ${args.expectFrames} expected: Figma renders the end frame too (ceil(duration × fps) + 1; figma_export_video's expectedFrames counts it); trim or re-time before delivery.`,
          });
        }
      }

      // ── then pictures ──
      const portrait = probe.height >= probe.width;
      const tileWidth = (args.tileWidth as number | undefined) ?? (portrait ? 180 : 240);
      const tileHeight = Math.max(2, 2 * Math.round((tileWidth * probe.height) / probe.width / 2));
      const maxImages = (args.maxImages as number | undefined) ?? MAX_IMAGES_DEFAULT;
      const stem = join(dir, basename(video, extname(video)));
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      let ffmpegMissing = false;
      /** Write one picture; inline it while the budget lasts. Returns its `path` and `image` index. */
      const keep = async (png: Buffer, file: string): Promise<Record<string, unknown>> => {
        const path = await writeExport(file, png, roots);
        if (images.length < maxImages && png.length <= INLINE_LIMIT) {
          images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
          return { path, image: images.length };
        }
        return { path };
      };
      const picture = async (what: () => Promise<Buffer>, file: string): Promise<Record<string, unknown>> => {
        if (ffmpegMissing) return { error: "ffmpeg not on PATH" };
        try {
          return await keep(await what(), file);
        } catch (err) {
          if (isMissing(err)) {
            ffmpegMissing = true;
            return { error: "ffmpeg not on PATH" };
          }
          return { error: messageOf(err) };
        }
      };

      const font = await labelFont();
      const label = font ? labelFilter(font, tileWidth) : undefined;
      if (!label) notes.push("Frame numbers are not burned in (this ffmpeg has no drawtext, or no font file was found); `sheet.tiles` maps every tile to its frame.");

      let every = (args.every as number | undefined) ?? Math.max(1, Math.ceil(frames / 90));
      if (Math.ceil(frames / every) > MAX_SHEET_TILES) {
        const asked = every;
        every = Math.ceil(frames / MAX_SHEET_TILES);
        notes.push(`\`every\` raised from ${asked} to ${every}: a sheet holds at most ${MAX_SHEET_TILES} tiles. Use closeups for every frame of a window.`);
      }
      const columns = (args.columns as number | undefined) ?? (portrait ? 9 : 6);
      const count = Math.ceil(frames / every);
      const tiles = Array.from({ length: count }, (_, index) => ({ index, frame: index * every, t: round4((index * every) / probe.fps) }));
      out.sheet = {
        ...(await picture(
          () => filterImage(run, video, tileGraph({ tileWidth, tileHeight, ...(label ? { label } : {}), select: `not(mod(n\\,${every}))`, columns, count })),
          `${stem}-sheet.png`,
        )),
        every,
        columns: Math.min(columns, count),
        tiles,
        labelled: label !== undefined,
      };

      const closeups: Array<Record<string, unknown>> = [];
      for (const c of (args.closeups as Array<{ startFrame: number; frames?: number; columns?: number }> | undefined) ?? []) {
        const k0 = c.startFrame;
        if (k0 >= frames) {
          closeups.push({ frames: [k0, k0], error: `starts past the last frame (${frames - 1})` });
          continue;
        }
        const k1 = Math.min(frames - 1, k0 + (c.frames ?? 24) - 1);
        const graph = tileGraph({ tileWidth, tileHeight, ...(label ? { label } : {}), select: `between(n\\,${k0}\\,${k1})`, columns: c.columns ?? 8, count: k1 - k0 + 1 });
        closeups.push({ frames: [k0, k1], ...(await picture(() => filterImage(run, video, graph), `${stem}-closeup-${k0}-${k1}.png`)) });
      }
      if (closeups.length) out.closeups = closeups;

      const stills: Array<Record<string, unknown>> = [];
      for (const k of (args.stills as number[] | undefined) ?? []) {
        if (k >= frames) {
          stills.push({ frame: k, error: `past the last frame (${frames - 1})` });
          continue;
        }
        // A quarter frame early lands on frame k itself [C-195].
        stills.push({ frame: k, t: round4(k / probe.fps), ...(await picture(() => grabFrame(run, video, frameSeek(k, probe.fps)), `${stem}-f${k}.png`)) });
      }
      if (stills.length) out.stills = stills;

      if (ffmpegMissing) notes.push("ffmpeg is not on PATH, so no images were cut.");
      if (metrics) out.metrics = metrics;
      out.findings = findings;
      if (notes.length) out.note = notes.join(" ");
      // No structuredContent: a client that prefers it over `content` would drop the images.
      return { content: [{ type: "text", text: JSON.stringify(out) }, ...images] };
    },
  );
}
