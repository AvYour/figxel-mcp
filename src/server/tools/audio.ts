// Sound for a motion piece, on the server: figma_analyze_audio (the rhythm and
// loudness of a music file), figma_add_audio (music and effects muxed onto a
// render) and figma_generate_audio (a bed and effects synthesized offline).
//
// Figma's video export carries no audio [C-184], so sound is joined after the
// render. ffmpeg does the decoding, measuring and muxing, always from an
// argument array and never through a shell, on files inside the export roots
// (exports.ts), as figma_review_video does. figma_add_audio copies the
// video stream as it is (-c:v copy): the picture is never encoded again. The
// analysis and the synthesis are pure TypeScript (audio-analysis.ts,
// audio-synth.ts); figma_generate_audio needs no ffmpeg at all, and reaches
// Figma only to read an animated frame's keys when it derives effects from them.

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { MotionSnapshot } from "../../shared/motion-curves.js";
import { analyseRhythm, ANALYSIS_RATE } from "../audio-analysis.js";
import { cuesFromMotion, type DerivedCues } from "../audio-cues.js";
import { rng, SAMPLE_RATE, subSeed } from "../audio-dsp.js";
import { BED_STYLES, CUE_TYPES, CUES_UNDER_BED_DB, generate, parseKey, TRUE_PEAK_CEILING_DB, type BedSpec, type CueSpec } from "../audio-synth.js";
import type { Bridge } from "../bridge.js";
import { resolveSavePath, writeExport, type ExportRoots } from "../exports.js";
import { DEFAULT_MEDIA_TOOLS, isMissing, nodeExecFile, noFfmpegHint, type ExecFileLike, type MediaTools } from "../ffmpeg.js";
import { soundEvents } from "../motion-audit.js";
import { errorResult, okResult } from "../results.js";
import { encodeWav } from "../wav.js";
import { readAnnotations } from "./annotations.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";
import type { ChildLike, SpawnLike } from "./review.js";

/** The longest stretch of a music file figma_analyze_audio reads, s. */
export const MAX_ANALYSIS_S = 600;
/** The longest file figma_generate_audio makes, s: the mix holds a few float buffers of this length at once. */
export const MAX_GENERATE_S = 180;
export const DEFAULT_SEED = 1;
/** figma_add_audio's encoders: AAC in MP4 and MOV, Opus in WebM, both at this rate. */
export const AUDIO_BITRATE = "192k";
const MIX_RATE = 48_000;

const nodeSpawn: SpawnLike = (file, args, options) => spawn(file, [...args], options);

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

/** "ffprobe is not on PATH", or, for a program BRIDGE_FFMPEG / BRIDGE_FFPROBE names, that it could not be started there. */
const unsupported = (name: "ffmpeg" | "ffprobe", tools: MediaTools) =>
  new BridgeError(
    ErrorCode.UNSUPPORTED,
    `${tools[name] === DEFAULT_MEDIA_TOOLS[name] ? `${name} is not on PATH` : `${name} could not be started (${tools[name]})`}, so the audio cannot be read or written.`,
    { hint: `${noFfmpegHint(tools)} figma_generate_audio needs neither.` },
  );

// ── paths ────────────────────────────────────────────────────────────────────

/** resolveSavePath with its messages naming `param` instead of `saveTo`. */
async function rootedPath(path: string, param: string, roots: ExportRoots): Promise<string> {
  try {
    return await resolveSavePath(path, roots);
  } catch (err) {
    if (err instanceof BridgeError) throw new BridgeError(err.code, err.message.replace("`saveTo`", `\`${param}\``), err.hint !== undefined ? { hint: err.hint } : {});
    throw err;
  }
}

/** An existing file inside the export roots. */
async function inputFile(path: string, param: string, roots: ExportRoots): Promise<string> {
  const p = await rootedPath(path, param, roots);
  let ok = false;
  try {
    ok = (await stat(p)).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw invalid(`No file at ${p} (\`${param}\`).`, "Paths resolve from the export directory; a file elsewhere must sit in BRIDGE_EXPORT_ROOTS.");
  return p;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// ── ffprobe and ffmpeg ───────────────────────────────────────────────────────

export interface MediaStream {
  type: string;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  durationS?: number;
  fps?: number;
}

export interface MediaProbe {
  durationS: number | undefined;
  format: string | undefined;
  streams: MediaStream[];
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const rate = (v: unknown) => {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(v ?? ""));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : undefined;
};

/** What a media file holds, per stream. Rejects with the spawn error (ENOENT) or ffprobe's own words. */
export function probeMedia(run: ExecFileLike, path: string, ffprobe = DEFAULT_MEDIA_TOOLS.ffprobe): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    run(
      ffprobe,
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration,r_frame_rate:format=duration,format_name", "-of", "json", path],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const said = stderr?.toString("utf8").trim();
          reject(said && err.code !== "ENOENT" ? Object.assign(new Error(said), { code: err.code }) : err);
          return;
        }
        try {
          const json = JSON.parse(stdout.toString("utf8")) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
          resolve({
            durationS: num(json.format?.duration),
            format: typeof json.format?.format_name === "string" ? json.format.format_name : undefined,
            streams: (json.streams ?? []).map((s) => {
              const out: MediaStream = { type: String(s.codec_type ?? "") };
              if (typeof s.codec_name === "string") out.codec = s.codec_name;
              const sr = num(s.sample_rate);
              const ch = num(s.channels);
              const d = num(s.duration);
              const fps = rate(s.r_frame_rate);
              if (sr) out.sampleRate = sr;
              if (ch) out.channels = ch;
              if (d !== undefined) out.durationS = d;
              if (out.type === "video" && fps) out.fps = fps;
              return out;
            }),
          });
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/** The first audio stream as mono 16-bit PCM at `sampleRate`, through a pipe, at most `maxS` s. */
export function decodeMono(run: SpawnLike, path: string, sampleRate: number, maxS: number, ffmpeg = DEFAULT_MEDIA_TOOLS.ffmpeg): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let child: ChildLike;
    try {
      child = run(
        ffmpeg,
        ["-v", "error", "-i", path, "-map", "0:a:0", "-t", String(maxS), "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    const said: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      if (said.length < 32) said.push(c);
    });
    child.once("error", (err) => reject(err));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(said).toString("utf8").trim() || `ffmpeg exited with code ${code}`));
        return;
      }
      const all = Buffer.concat(chunks);
      const out = new Float32Array(all.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32768;
      resolve(out);
    });
  });
}

/** ffmpeg's arguments to measure a file's first audio stream with ebur128. */
export const ebur128Args = (path: string): string[] => ["-hide_banner", "-nostats", "-v", "info", "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"];

export interface Loudness {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  lra: number | null;
}

/** The numbers of the last ebur128 summary in ffmpeg's log; null where it printed none or -inf. */
export function parseEbur128(log: string): Loudness {
  const at = log.lastIndexOf("Summary:");
  const s = at >= 0 ? log.slice(at) : "";
  const pick = (re: RegExp) => {
    const m = re.exec(s);
    const v = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(v) ? v : null;
  };
  return {
    integratedLufs: pick(/I:\s+(-?[\d.]+|-?inf)\s+LUFS/),
    lra: pick(/LRA:\s+(-?[\d.]+)\s+LU\b/),
    truePeakDbtp: pick(/True peak:\s+Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/),
  };
}

/** Run ffmpeg and hand back its log (stderr); rejects with the spawn error or ffmpeg's own words. */
function ffmpegLog(run: ExecFileLike, args: readonly string[], ffmpeg = DEFAULT_MEDIA_TOOLS.ffmpeg): Promise<string> {
  return new Promise((resolve, reject) => {
    run(ffmpeg, args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      const log = stderr?.toString("utf8") ?? "";
      if (err) reject(err.code === "ENOENT" ? err : Object.assign(new Error(log.trim().split(/\r?\n/).slice(-6).join("\n") || err.message), { code: err.code }));
      else resolve(log);
    });
  });
}

export const measureLoudness = async (run: ExecFileLike, path: string, ffmpeg = DEFAULT_MEDIA_TOOLS.ffmpeg): Promise<Loudness> =>
  parseEbur128(await ffmpegLog(run, ebur128Args(path), ffmpeg));

// ── figma_add_audio: placing tracks and building the mix ─────────────────────

export interface TrackIn {
  path: string;
  start?: number;
  offset?: number;
  durationS?: number;
  volumeDb?: number;
  fadeInS?: number;
  fadeOutS?: number;
}

export interface PlacedTrack {
  /** The track's index in the call. */
  index: number;
  path: string;
  /** ffmpeg input number: the video is 0. */
  input: number;
  start: number;
  offset: number;
  durationS: number;
  volumeDb: number;
  fadeInS: number;
  fadeOutS: number;
  endS: number;
}

/** Where each track plays on the video's timeline, trimmed to it; what was cut or left out is a warning. */
export function placeTracks(videoS: number, tracks: ReadonlyArray<TrackIn & { fileS: number }>): { placed: PlacedTrack[]; warnings: string[] } {
  const placed: PlacedTrack[] = [];
  const warnings: string[] = [];
  tracks.forEach((t, index) => {
    const at = `tracks[${index}]`;
    const start = t.start ?? 0;
    const offset = t.offset ?? 0;
    const available = t.fileS - offset;
    if (available <= 0.001) {
      warnings.push(`${at} has no audio after offset ${offset} s (the file is ${r3(t.fileS)} s): left out.`);
      return;
    }
    let dur = t.durationS ?? available;
    if (t.durationS !== undefined && t.durationS > available + 0.001) {
      warnings.push(`${at} asks for ${t.durationS} s but the file has ${r3(available)} s after offset ${offset} s: it ends early, at ${r3(start + available)} s.`);
      dur = available;
    }
    if (start >= videoS - 0.001) {
      warnings.push(`${at} starts at ${start} s, at or after the video's end (${r3(videoS)} s): left out.`);
      return;
    }
    if (start + dur > videoS + 0.001) {
      warnings.push(`${at} runs ${r3(start + dur - videoS)} s past the video's end (${r3(videoS)} s): trimmed there${t.fadeOutS ? ", and its fade-out moved to the new end" : ""}.`);
      dur = videoS - start;
    }
    let fadeIn = t.fadeInS ?? 0;
    let fadeOut = t.fadeOutS ?? 0;
    if (fadeIn + fadeOut > dur + 1e-9) {
      const k = dur / (fadeIn + fadeOut);
      fadeIn *= k;
      fadeOut *= k;
      warnings.push(`${at}'s fades (${t.fadeInS ?? 0} s in, ${t.fadeOutS ?? 0} s out) are longer than the ${r3(dur)} s it plays: shortened to ${r3(fadeIn)} s and ${r3(fadeOut)} s.`);
    }
    placed.push({ index, path: t.path, input: placed.length + 1, start, offset, durationS: r3(dur), volumeDb: t.volumeDb ?? 0, fadeInS: r3(fadeIn), fadeOutS: r3(fadeOut), endS: r3(start + dur) });
  });
  if (placed.length) {
    const end = Math.max(...placed.map((p) => p.endS));
    if (end < videoS - 0.05) warnings.push(`The audio ends at ${r3(end)} s, ${r3(videoS - end)} s before the picture; the rest is silent.`);
  }
  return { placed, warnings };
}

/** A number as ffmpeg's option parser reads it: plain decimals, no exponent. */
const n = (v: number) => String(Math.round(v * 1e6) / 1e6);

/**
 * The filter graph: each track trimmed from its offset, brought to 48 kHz
 * stereo, levelled, faded and delayed to its start; all summed without
 * amix's level scaling; padded with silence and cut to exactly the video's
 * length in samples; then, when asked, loudness-normalised.
 */
export function mixGraph(placed: readonly PlacedTrack[], videoS: number, loudnorm?: string): string {
  const total = Math.round(videoS * MIX_RATE);
  const chains = placed.map((p, k) => {
    const f: string[] = [
      `atrim=start=${n(p.offset)}:duration=${n(p.durationS)}`,
      "asetpts=PTS-STARTPTS",
      `aresample=${MIX_RATE}`,
      `aformat=sample_fmts=fltp:sample_rates=${MIX_RATE}:channel_layouts=stereo`,
    ];
    if (p.volumeDb !== 0) f.push(`volume=${n(p.volumeDb)}dB`);
    if (p.fadeInS > 0) f.push(`afade=t=in:st=0:d=${n(p.fadeInS)}`);
    if (p.fadeOutS > 0) f.push(`afade=t=out:st=${n(Math.max(0, p.durationS - p.fadeOutS))}:d=${n(p.fadeOutS)}`);
    const delay = Math.round(p.start * MIX_RATE);
    if (delay > 0) f.push(`adelay=delays=${delay}S:all=1`);
    return `[${p.input}:a:0]${f.join(",")}[a${k}]`;
  });
  const inputs = placed.map((_, k) => `[a${k}]`).join("");
  const tail = [
    `amix=inputs=${placed.length}:duration=longest:dropout_transition=0:normalize=0`,
    `apad=whole_len=${total}`,
    `atrim=end_sample=${total}`,
    ...(loudnorm ? [loudnorm, `aresample=${MIX_RATE}`] : []),
  ];
  return `${chains.join(";")};${inputs}${tail.join(",")}[aout]`;
}

export type Container = "mp4" | "webm";

/** The mux: the video stream copied, the mix encoded, nothing else from the inputs. */
export function muxArgs(o: { video: string; tracks: readonly string[]; graph: string; out: string; container: Container }): string[] {
  return [
    "-v", "error", "-y",
    "-i", o.video,
    ...o.tracks.flatMap((t) => ["-i", t]),
    "-filter_complex", o.graph,
    "-map", "0:v:0", "-map", "[aout]",
    "-c:v", "copy",
    ...(o.container === "webm" ? ["-c:a", "libopus", "-b:a", AUDIO_BITRATE] : ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-movflags", "+faststart"]),
    o.out,
  ];
}

/** The first loudnorm pass: the same mix, measured, written nowhere. */
export function loudnessPassArgs(o: { video: string; tracks: readonly string[]; graph: string }): string[] {
  return ["-hide_banner", "-nostats", "-v", "info", "-i", o.video, ...o.tracks.flatMap((t) => ["-i", t]), "-filter_complex", o.graph, "-map", "[aout]", "-f", "null", "-"];
}

export interface LoudnormMeasure {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/** loudnorm's JSON from the first pass's log. */
export function parseLoudnorm(log: string): LoudnormMeasure | null {
  const m = /\{\s*"input_i"[\s\S]*?\}/.exec(log);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, string>;
    const v = { input_i: Number(j.input_i), input_tp: Number(j.input_tp), input_lra: Number(j.input_lra), input_thresh: Number(j.input_thresh), target_offset: Number(j.target_offset) };
    return Object.values(v).every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Room left under the ceiling for the lossy encoder that follows loudnorm: AAC and
 * Opus raise the true peak again after it [C-328] (a -14 LUFS mix held at -1 dBTP
 * came out at -0.8 dBTP as AAC on 2026-10-14), so the filter aims 1 dB lower.
 */
const ENCODE_HEADROOM_DB = 1;
const LOUDNORM_TP = TRUE_PEAK_CEILING_DB - ENCODE_HEADROOM_DB;

/** The loudnorm filter: measuring (first pass) or applying the measured gain linearly (second pass). */
export function loudnormFilter(target: number, measured?: LoudnormMeasure): string {
  if (!measured) return `loudnorm=I=${n(target)}:TP=${LOUDNORM_TP}:LRA=11:print_format=json`;
  // Linear mode needs a target range at least as wide as the mix's own.
  const lra = Math.min(50, Math.max(11, Math.ceil(measured.input_lra + 1)));
  return (
    `loudnorm=I=${n(target)}:TP=${LOUDNORM_TP}:LRA=${lra}` +
    `:measured_I=${n(measured.input_i)}:measured_TP=${n(measured.input_tp)}:measured_LRA=${n(measured.input_lra)}` +
    `:measured_thresh=${n(measured.input_thresh)}:offset=${n(measured.target_offset)}:linear=true:print_format=summary`
  );
}

const CONTAINER: Record<string, Container | undefined> = { ".mp4": "mp4", ".m4v": "mp4", ".mov": "mp4", ".webm": "webm" };

// ── the tools ────────────────────────────────────────────────────────────────

export interface AudioOptions {
  /** ffmpeg / ffprobe runner for one-shot calls; tests inject a fake. */
  execFile?: ExecFileLike;
  /** The PCM decode, which streams; tests inject a fake. */
  spawn?: SpawnLike;
  /** BRIDGE_FFMPEG / BRIDGE_FFPROBE (config.ts); names on PATH by default. */
  media?: MediaTools;
}

const SESSION = {
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const track = z
  .object({
    path: z.string().min(1).describe("An audio file inside the export roots: the user's licensed music, an effect, or figma_generate_audio's WAV."),
    start: z.number().min(0).optional().describe("Where it starts on the video's timeline, s. Default 0."),
    offset: z.number().min(0).optional().describe("Where in the file it starts playing, s. Default 0."),
    durationS: z.number().positive().optional().describe("How long it plays, s. Default: to the end of the file or the video."),
    volumeDb: z.number().min(-60).max(24).optional().describe("Gain, dB. Default 0."),
    fadeInS: z.number().min(0).optional().describe("Fade-in length, s."),
    fadeOutS: z.number().min(0).optional().describe("Fade-out length, s, ending where the track ends."),
  })
  .strict();

const section = z
  .object({
    from: z.number().min(0).describe("Seconds."),
    to: z.number().min(0).describe("Seconds, after `from`."),
    energy: z.number().min(0).max(1).describe("0 pads only; 0.3 drums come in; 0.55 the backbeat; 0.6 a plucked line; 0.85 sixteenth hats."),
  })
  .strict();

const bed = z
  .object({
    style: z.enum(BED_STYLES),
    bpm: z.number().min(40).max(220).describe("The plan's tempo; beats land on whole frames when fps × 60 / bpm is a whole number."),
    beatOffset: z.number().min(0).optional().describe("Time of the first downbeat, s. Default 0."),
    key: z.string().max(24).optional().describe('E.g. "C minor", "F# major". Default per style.'),
    intensity: z.number().min(0).max(1).optional().describe("The energy of every bar no section covers. Default 0.7."),
    sections: z.array(section).max(64).optional().describe("Energy over time: drums drop out of a low section, and a fill leads into a clearly higher one."),
  })
  .strict();

const cue = z
  .object({
    t: z.number().min(0).describe("Start, s. A riser or swell ends at t + durationS; a hit lands on t."),
    type: z.enum(CUE_TYPES),
    durationS: z.number().min(0.01).max(10).optional().describe("Length, s. Defaults: whoosh 0.6, hit 1.2 (its tail), tick 0.05, pop 0.12, riser 1.5, click 0.02, swell 1.2, drop 1."),
    intensity: z.number().min(0).max(1).optional().describe("Default 0.7."),
    pan: z.number().min(-1).max(1).optional().describe("−1 left … 1 right. Default 0."),
    note: z.string().max(200).optional().describe("Why it is there; derived cues carry one."),
  })
  .strict();

/**
 * Register figma_analyze_audio, figma_add_audio and figma_generate_audio.
 * Wired in tools/index.ts beside figma_review_video. Only generate_audio's
 * `nodeId` reaches Figma, through the plugin op figma_check_motion reads with.
 */
export function registerAudio(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, opts: AudioOptions = {}): void {
  const run = opts.execFile ?? nodeExecFile;
  const decode = opts.spawn ?? nodeSpawn;
  const tools = opts.media ?? DEFAULT_MEDIA_TOOLS;
  const probe = (path: string) => probeMedia(run, path, tools.ffprobe);
  const loudnessOf = (path: string) => measureLoudness(run, path, tools.ffmpeg);
  const refuse = (err: unknown) => errorResult(err, { readOnly: true, unchanged: true });

  if (wanted("analyze_audio")) {
    server.registerTool(
      "figma_analyze_audio",
      {
        title: "Analyze a music track",
        description: fitDescription(
          "Read the rhythm and level of a music file the user supplied, before planning motion on it: duration, sample " +
            "rate, channels, integrated loudness (LUFS) and true peak (ffmpeg ebur128), a tempo with a confidence 0–1 and " +
            "its half or double as `alternatives`, every beat's time (`beatTimes`), a first-downbeat guess (`beatOffset`) " +
            "and the strongest onsets. Put the beat sheet's hits on these real beats, and pass `beatTimes` to " +
            "figma_check_motion so accents are checked against the music. `path` is an audio file inside the export roots " +
            "(any format this ffmpeg decodes, or a video's sound). Reads up to 10 minutes. Under about 0.4 confidence the tempo " +
            "is a guess: say so, and time the hits to the strong onsets. No Figma call. Needs ffmpeg and " +
            "ffprobe on PATH, else UNSUPPORTED. Skills: storyboard, motion (figma_get_guide).",
        ),
        inputSchema: {
          path: z.string().min(1).describe("The music file, inside the export roots."),
          minBpm: z.number().min(30).max(300).optional().describe("Slowest tempo considered. Default 60."),
          maxBpm: z.number().min(30).max(300).optional().describe("Fastest tempo considered. Default 200."),
          beatsPerBar: z.number().int().min(1).max(12).optional().describe("For the downbeat guess. Default 4."),
        },
        annotations: readAnnotations("analyze_audio"),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const minBpm = (args.minBpm as number | undefined) ?? 60;
        const maxBpm = (args.maxBpm as number | undefined) ?? 200;
        if (maxBpm < minBpm * 1.25) return refuse(invalid(`\`maxBpm\` (${maxBpm}) must be at least 1.25 × \`minBpm\` (${minBpm}).`, "Leave both out for 60–200."));
        let path: string;
        try {
          path = await inputFile(String(args.path), "path", roots);
        } catch (err) {
          return refuse(err);
        }
        let probed: MediaProbe;
        try {
          probed = await probe(path);
        } catch (err) {
          if (isMissing(err)) return errorResult(unsupported("ffprobe", tools), { readOnly: true });
          return refuse(invalid(`ffprobe cannot read ${path}: ${messageOf(err)}`, "Is it an audio file?"));
        }
        const audio = probed.streams.find((s) => s.type === "audio");
        if (!audio) return refuse(invalid(`${path} has no audio stream.`, "Pass an audio file, or a video that has sound."));
        let pcm: Float32Array;
        let loud: Loudness;
        try {
          [pcm, loud] = await Promise.all([decodeMono(decode, path, ANALYSIS_RATE, MAX_ANALYSIS_S, tools.ffmpeg), loudnessOf(path)]);
        } catch (err) {
          if (isMissing(err)) return errorResult(unsupported("ffmpeg", tools), { readOnly: true });
          return errorResult(new BridgeError(ErrorCode.INTERNAL, `ffmpeg could not decode ${path}: ${messageOf(err)}`), { readOnly: true });
        }
        const rhythm = analyseRhythm(pcm, ANALYSIS_RATE, { minBpm, maxBpm, ...(typeof args.beatsPerBar === "number" ? { beatsPerBar: args.beatsPerBar } : {}) });
        const durationS = probed.durationS ?? audio.durationS ?? pcm.length / ANALYSIS_RATE;
        const analysedS = r3(pcm.length / ANALYSIS_RATE);
        const notes: string[] = [];
        if (durationS > MAX_ANALYSIS_S + 0.5) notes.push(`Only the first ${MAX_ANALYSIS_S} s were analysed.`);
        if (rhythm.bpm === null) notes.push("No steady beat was found: time the piece to its strong onsets or to the voice-over.");
        else if (rhythm.confidence < 0.4) notes.push("The tempo is a guess (confidence under 0.4): check the beats against the strong onsets before planning on them.");
        const framesPerBeat = rhythm.bpm ? { "24": r2((24 * 60) / rhythm.bpm), "30": r2((30 * 60) / rhythm.bpm), "60": r2((60 * 60) / rhythm.bpm) } : undefined;
        return okResult({
          path,
          durationS: r3(durationS),
          analysedS,
          ...(audio.sampleRate ? { sampleRate: audio.sampleRate } : {}),
          ...(audio.channels ? { channels: audio.channels } : {}),
          ...(audio.codec ? { codec: audio.codec } : {}),
          loudness: loud,
          tempo: { bpm: rhythm.bpm, confidence: rhythm.confidence, alternatives: rhythm.alternatives },
          ...(framesPerBeat ? { framesPerBeat } : {}),
          beatOffset: rhythm.beatOffset,
          beatsPerBar: rhythm.beatsPerBar,
          beatTimes: rhythm.beatTimes,
          strongOnsets: rhythm.strongOnsets,
          ...(notes.length ? { note: notes.join(" ") } : {}),
          next: "Plan the hits on beatTimes (bar 1 starts at beatOffset), check the keys with figma_check_motion { beatTimes }, then after the render join the track with figma_add_audio.",
        });
      },
    );
  }

  if (wanted("add_audio")) {
    server.registerTool(
      "figma_add_audio",
      {
        title: "Add audio to a rendered video",
        description: fitDescription(
          "Join sound to a video figma_export_video rendered: Figma's export has no audio. Up to 8 `tracks` (a music bed " +
            "plus effects on cuts and accents), each placed at `start` on the video's timeline from `offset` into its " +
            "file, with `durationS`, `volumeDb` and fades; summed without level scaling, padded or cut to exactly the " +
            "video's length. `loudness` (e.g. -14 LUFS) normalises the mix in two passes, true peak held at -1 dBTP. The " +
            "video stream is copied, never encoded again; audio is AAC 192k in MP4/MOV, Opus 192k in WebM. A GIF has no " +
            "audio and is refused. Every path follows the export-root rules; `saveTo` defaults to <video>-audio beside " +
            "it. Returns the path, length, measured loudness and true peak, and warnings: a track trimmed at the end, one " +
            "left out, audio that stops before the picture, a peak over -1 dBTP. Use only audio the user has the rights " +
            "to. Needs ffmpeg and ffprobe on PATH, else UNSUPPORTED. Skills: motion, storyboard (figma_get_guide).",
        ),
        inputSchema: {
          video: z.string().min(1).describe("The rendered video (.mp4, .mov or .webm): figma_export_video's `path`."),
          tracks: z.array(track).min(1).max(8).describe("The audio, in mix order: usually a bed first, then effects."),
          loudness: z.number().min(-40).max(-5).optional().describe("Target integrated loudness of the mix, LUFS. Default: levels as given."),
          saveTo: z.string().optional().describe("The file to write, same container as the video. Default <video name>-audio.<ext> beside it."),
        },
        annotations: readAnnotations("add_audio"),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const asked = args.tracks as TrackIn[];
        let video: string;
        let out: string;
        let container: Container;
        const files: string[] = [];
        try {
          video = await rootedPath(String(args.video), "video", roots);
          const ext = extname(video).toLowerCase();
          if (ext === ".gif") throw invalid("A GIF has no audio track, so sound cannot be added to it.", "Render the piece as MP4 or WEBM with figma_export_video, then add the audio.");
          const c = CONTAINER[ext];
          if (!c) throw invalid(`\`video\` ends in ${ext || "no extension"}; audio is added to .mp4, .mov or .webm.`);
          container = c;
          video = await inputFile(String(args.video), "video", roots);
          for (const [i, t] of asked.entries()) files.push(await inputFile(t.path, `tracks[${i}].path`, roots));
          let saveTo = typeof args.saveTo === "string" ? args.saveTo : join(dirname(video), `${basename(video, extname(video))}-audio${extname(video)}`);
          const outExt = extname(saveTo).toLowerCase();
          if (!outExt) saveTo = `${saveTo}${extname(video)}`;
          else if (CONTAINER[outExt] !== container) throw invalid(`\`saveTo\` ends in ${outExt}, but the video is ${ext}: the stream is copied, so the container stays the same.`, `Use a ${ext} name.`);
          out = await rootedPath(saveTo, "saveTo", roots);
          if (samePath(out, video) || files.some((f) => samePath(f, out))) throw invalid("`saveTo` names one of the inputs; ffmpeg cannot write a file it is reading.", "Leave `saveTo` out for <video>-audio beside the video.");
        } catch (err) {
          return refuse(err);
        }

        // What the files hold.
        let vprobe: MediaProbe;
        const durations: number[] = [];
        try {
          vprobe = await probe(video);
          for (const [i, f] of files.entries()) {
            const p = await probe(f);
            const a = p.streams.find((s) => s.type === "audio");
            if (!a) throw invalid(`tracks[${i}] (${f}) has no audio stream.`);
            durations.push(a.durationS ?? p.durationS ?? 0);
          }
        } catch (err) {
          if (isMissing(err)) return errorResult(unsupported("ffprobe", tools), { readOnly: true });
          if (err instanceof BridgeError) return refuse(err);
          return refuse(invalid(`ffprobe cannot read an input: ${messageOf(err)}`));
        }
        const vstream = vprobe.streams.find((s) => s.type === "video");
        const videoS = vstream?.durationS ?? vprobe.durationS;
        if (!vstream || !videoS) return refuse(invalid(`${video} has no video stream with a duration.`, "Pass the `path` figma_export_video returned."));
        const { placed, warnings } = placeTracks(videoS, asked.map((t, i) => ({ ...t, path: files[i]!, fileS: durations[i]! })));
        if (placed.length === 0) return refuse(invalid(`No track is heard inside the video's ${r3(videoS)} s.`, warnings.join(" ")));
        if (vprobe.streams.some((s) => s.type === "audio")) warnings.push("The video had its own audio; it is replaced by this mix.");
        const inputs = placed.map((p) => p.path);

        try {
          await mkdir(dirname(out), { recursive: true });
          let loudnorm: string | undefined;
          const target = typeof args.loudness === "number" ? args.loudness : undefined;
          if (target !== undefined) {
            const measured = parseLoudnorm(await ffmpegLog(run, loudnessPassArgs({ video, tracks: inputs, graph: mixGraph(placed, videoS, loudnormFilter(target)) }), tools.ffmpeg));
            if (!measured || measured.input_i < -69) warnings.push("The mix is silent or could not be measured, so `loudness` was not applied.");
            else loudnorm = loudnormFilter(target, measured);
          }
          await ffmpegLog(run, muxArgs({ video, tracks: inputs, graph: mixGraph(placed, videoS, loudnorm), out, container }), tools.ffmpeg);
        } catch (err) {
          if (isMissing(err)) return errorResult(unsupported("ffmpeg", tools), { readOnly: true });
          return errorResult(new BridgeError(ErrorCode.INTERNAL, `ffmpeg could not write ${out}: ${messageOf(err)}`), { readOnly: true });
        }

        // The result, measured.
        let loud: Loudness = { integratedLufs: null, truePeakDbtp: null, lra: null };
        let outS: number | undefined;
        try {
          loud = await loudnessOf(out);
          const p = await probe(out);
          outS = p.durationS;
        } catch (err) {
          warnings.push(`The result could not be measured: ${messageOf(err)}`);
        }
        if (loud.truePeakDbtp !== null && loud.truePeakDbtp > TRUE_PEAK_CEILING_DB) {
          warnings.push(`The mix peaks at ${loud.truePeakDbtp} dBTP, above ${TRUE_PEAK_CEILING_DB} dBTP: it can clip once a platform encodes it again. Lower a track's volumeDb, or pass \`loudness\`.`);
        }
        const frame = vstream.fps ? 1 / vstream.fps : 0.04;
        if (outS !== undefined && Math.abs(outS - videoS) > frame + 0.001) warnings.push(`The file is ${r3(outS)} s long; the video is ${r3(videoS)} s.`);
        return okResult({
          path: out,
          durationS: outS !== undefined ? r3(outS) : r3(videoS),
          video: { path: video, durationS: r3(videoS), ...(vstream.fps ? { fps: r3(vstream.fps) } : {}), copied: true },
          audio: { codec: container === "webm" ? "opus" : "aac", bitrate: AUDIO_BITRATE, sampleRate: MIX_RATE, channels: 2 },
          tracks: placed.map(({ input: _i, ...p }) => p),
          loudness: { ...loud, ...(typeof args.loudness === "number" ? { target: args.loudness } : {}) },
          ...(warnings.length ? { warnings } : {}),
          next: "Review the result with figma_review_video { path } (the picture is unchanged), and listen to it before delivery.",
        });
      },
    );
  }

  if (wanted("generate_audio")) {
    server.registerTool(
      "figma_generate_audio",
      {
        title: "Generate music and sound effects",
        description: fitDescription(
          "Synthesize audio offline, here, from oscillators and seeded noise: no service, no samples, no model. A " +
            "48 kHz 16-bit stereo WAV, the same bytes for the same `seed`. `bed`: a simple music bed in a `style` at the " +
            "plan's `bpm` from `beatOffset`, its `sections` setting the energy (drums drop out of a quiet one; a fill " +
            "leads into a louder one). `cues`: whoosh, hit, tick, pop, riser (ends at t + durationS), click, swell, drop. " +
            "`nodeId`: derive cues from an animated frame's keys (a whoosh per fast move, a hit per cut, a tick per text " +
            "entrance), returned as `derivedCues` to edit and pass back as `cues`. Effects sit 6 dB under a bed; a " +
            "limiter keeps the true peak under -1 dBTP. Returns the path, loudness and the plan. A generated bed is a simple " +
            "or temporary track: a produced track the user licenses is better for a final ad. Then figma_add_audio. " +
            "Skills: motion, storyboard (figma_get_guide).",
        ),
        inputSchema: {
          durationS: z.number().min(0.5).max(MAX_GENERATE_S).describe("Length of the file, s: the video's length."),
          seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Default 1. Another seed, another take of the same plan."),
          bed: bed.optional(),
          cues: z.array(cue).max(200).optional(),
          nodeId: z.string().optional().describe("An animated top-level frame (or a layer in it): its moves, cuts and text entrances become cues."),
          fps: z.number().int().min(1).max(60).optional().describe("With nodeId: the frame rate cues are timed at; match the render. Default 30."),
          cuts: z.array(z.number().min(0)).max(64).optional().describe("Seconds where a cut lands: each gets a hit."),
          maxNodes: z.number().int().min(1).max(5000).optional().describe("With nodeId: layers read. Default 2000."),
          saveTo: z.string().optional().describe("A .wav file inside the export roots. Default generated-audio-<seed>-<time>.wav in the export directory."),
          ...SESSION,
        },
        annotations: readAnnotations("generate_audio"),
      },
      async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
        const durationS = args.durationS as number;
        const seed = (args.seed as number | undefined) ?? DEFAULT_SEED;
        const bedSpec = args.bed as BedSpec | undefined;
        const explicit = (args.cues as CueSpec[] | undefined) ?? [];
        const cuts = (args.cuts as number[] | undefined) ?? [];
        const fps = (args.fps as number | undefined) ?? 30;
        let target: string;
        try {
          if (!bedSpec && explicit.length === 0 && cuts.length === 0 && typeof args.nodeId !== "string") {
            throw invalid("Nothing to make: pass `bed`, `cues`, `cuts` or `nodeId`.");
          }
          if (bedSpec?.key !== undefined && !parseKey(bedSpec.key)) throw invalid(`\`bed.key\` "${bedSpec.key}" is not a key.`, 'Write a note and a mode, e.g. "C minor", "F# major", "Bb min".');
          bedSpec?.sections?.forEach((s, i) => {
            if (!(s.to > s.from)) throw invalid(`\`bed.sections[${i}].to\` must be after its \`from\`.`);
          });
          if (bedSpec?.beatOffset !== undefined && bedSpec.beatOffset >= durationS) throw invalid(`\`bed.beatOffset\` (${bedSpec.beatOffset} s) is past the end of the file (${durationS} s).`);
          let saveTo = typeof args.saveTo === "string" ? args.saveTo : `generated-audio-${seed}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
          const ext = extname(saveTo).toLowerCase();
          if (!ext) saveTo = `${saveTo}.wav`;
          else if (ext !== ".wav") throw invalid(`\`saveTo\` ends in ${ext}; figma_generate_audio writes .wav.`, "figma_add_audio encodes it into the video.");
          target = await rootedPath(saveTo, "saveTo", roots);
        } catch (err) {
          return refuse(err);
        }

        const make = async (derived?: { cues: DerivedCues; from: { id: string; name: string; durationS: number } }): Promise<CallToolResult> => {
          const hits: CueSpec[] = cuts.map((t) => ({ t, type: "hit", note: `declared cut at ${t} s` }));
          const all = [...explicit, ...hits, ...(derived?.cues.cues ?? [])];
          const g = generate({ durationS, seed, ...(bedSpec ? { bed: bedSpec } : {}), cues: all });
          const warnings = [...g.warnings];
          if (derived && Math.abs(derived.from.durationS - durationS) > 1 / fps) {
            warnings.push(`The frame's timeline is ${r3(derived.from.durationS)} s; this file is ${durationS} s. Match durationS to the render.`);
          }
          const wav = encodeWav([g.audio.l, g.audio.r], SAMPLE_RATE, rng(subSeed(seed, "dither")));
          const path = await writeExport(target, wav, roots);
          const { events: _e, ...plan } = g.bed ?? ({} as NonNullable<typeof g.bed>);
          return okResult({
            path,
            durationS,
            sampleRate: SAMPLE_RATE,
            channels: 2,
            bitsPerSample: 16,
            bytes: wav.length,
            seed,
            loudness: g.loudness,
            ...(g.bed ? { bed: plan } : {}),
            cues: g.cues,
            ...(g.bed && g.cues.length ? { mix: `effects ${CUES_UNDER_BED_DB} dB under the bed` } : {}),
            ...(derived
              ? {
                  derivedFrom: { nodeId: derived.from.id, name: derived.from.name, fps, counts: derived.cues.counts, ...(derived.cues.dropped ? { dropped: derived.cues.dropped } : {}) },
                  derivedCues: derived.cues.cues,
                }
              : {}),
            ...(warnings.length ? { warnings } : {}),
            next: "Listen to it, then mix it into the render: figma_add_audio { video: <figma_export_video's path>, tracks: [{ path: <this path> }] }.",
          });
        };

        if (typeof args.nodeId !== "string") {
          try {
            return await make();
          } catch (err) {
            return errorResult(err, { readOnly: true });
          }
        }
        const params: Record<string, unknown> = { nodeId: args.nodeId };
        if (typeof args.maxNodes === "number") params.maxNodes = args.maxNodes;
        return forwardTool(bridge, "check_motion", params, extra, {
          session: args.session as string | undefined,
          shape: async (data) => {
            const snap = data as Partial<MotionSnapshot> | null;
            if (!snap || typeof snap !== "object" || !snap.root || !Array.isArray(snap.nodes)) {
              throw new BridgeError(ErrorCode.INTERNAL, "The plugin's check_motion answered without a snapshot.", {
                hint: "The plugin build may predate figma_check_motion: figma_status shows whether it must be re-run.",
              });
            }
            const ev = soundEvents(snap as MotionSnapshot, fps);
            return make({ cues: cuesFromMotion(ev), from: { id: snap.root.id, name: snap.root.name, durationS: ev.durationS } });
          },
        });
      },
    );
  }
}
