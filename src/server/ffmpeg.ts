// ffmpeg and ffprobe: which programs the video and audio tools run, and whether they run.
//
// figma_export_video cuts stills and counts frames with them, and
// figma_review_video, figma_analyze_audio and figma_add_audio need both
// (figma_generate_audio needs neither; the three audio tools are held back,
// registered only with BRIDGE_ENABLE_AUDIO=1). They are found on PATH by name unless
// BRIDGE_FFMPEG / BRIDGE_FFPROBE name the programs (config.ts). figma_status
// reports whether each one runs, so "ffmpeg not on PATH" is visible before a
// render rather than after it. Always executed from an argument array, never
// through a shell.

import { execFile } from "node:child_process";
import { PRODUCT_NAME } from "../shared/version.js";

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "buffer"; maxBuffer: number; windowsHide: boolean; timeout?: number },
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: Buffer, stderr: Buffer) => void,
) => unknown;

export const nodeExecFile: ExecFileLike = (file, args, options, callback) => execFile(file, [...args], options, callback);

/** The programs to run: names looked up on PATH, or full paths. */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export const DEFAULT_MEDIA_TOOLS: MediaTools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

/** A spawn that found no such program. */
export const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === "ENOENT";

/** What to do when ffmpeg or ffprobe cannot be started. */
export function noFfmpegHint(tools: MediaTools = DEFAULT_MEDIA_TOOLS): string {
  const named = tools.ffmpeg !== DEFAULT_MEDIA_TOOLS.ffmpeg || tools.ffprobe !== DEFAULT_MEDIA_TOOLS.ffprobe;
  return (
    (named
      ? `BRIDGE_FFMPEG / BRIDGE_FFPROBE name ${tools.ffmpeg} and ${tools.ffprobe}; check that both programs exist there. `
      : `Install ffmpeg (it brings ffprobe) on the machine that runs ${PRODUCT_NAME} and put it on PATH, or set BRIDGE_FFMPEG and BRIDGE_FFPROBE to the programs' full paths in the MCP client's server config. `) +
    "If ffmpeg was installed after the MCP client started, restart the MCP client so this server can find it."
  );
}

export interface ToolCheck {
  command: string;
  available: boolean;
  /** The first line of `-version`, when it ran. */
  version?: string;
  error?: string;
}

const cache = new Map<string, { at: number; check: ToolCheck }>();
/** A program that ran is assumed to keep running for this long; a missing one is looked for again on every check. */
const CHECK_TTL_MS = 60_000;

function checkOne(run: ExecFileLike, command: string, now: number): Promise<ToolCheck> {
  const hit = cache.get(command);
  if (hit && hit.check.available && now - hit.at < CHECK_TTL_MS) return Promise.resolve(hit.check);
  return new Promise((resolve) => {
    run(command, ["-version"], { encoding: "buffer", maxBuffer: 1024 * 1024, windowsHide: true, timeout: 3_000 }, (err, stdout) => {
      const check: ToolCheck = err
        ? { command, available: false, error: isMissing(err) ? "not found" : err.message.split("\n")[0]! }
        : { command, available: true, version: stdout.toString("utf8").split(/\r?\n/)[0]!.trim() };
      cache.set(command, { at: now, check });
      resolve(check);
    });
  });
}

/**
 * Whether ffmpeg and ffprobe run, for figma_status. Never rejects. `audio`:
 * the held-back audio tools are registered, so the note names the two that
 * need both programs; otherwise it names only the video tools.
 */
export async function checkMediaTools(
  run: ExecFileLike = nodeExecFile,
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
  now = Date.now(),
  opts: { audio?: boolean } = {},
): Promise<{ ffmpeg: ToolCheck; ffprobe: ToolCheck; note?: string }> {
  const [ffmpeg, ffprobe] = await Promise.all([checkOne(run, tools.ffmpeg, now), checkOne(run, tools.ffprobe, now)]);
  const needBoth = opts.audio
    ? "its frames and frame count, figma_review_video, figma_analyze_audio and figma_add_audio need both programs"
    : "its frames and frame count and figma_review_video need both programs";
  return {
    ffmpeg,
    ffprobe,
    ...(ffmpeg.available && ffprobe.available ? {} : { note: `figma_export_video still writes the video; ${needBoth}. ${noFfmpegHint(tools)}` }),
  };
}

/** Forget what checkMediaTools learned (tests). */
export function resetMediaToolsCache(): void {
  cache.clear();
}
