// Video export settings — figma_export_video. Shared by the bridge, which
// refuses a bad combination before Figma spends a render on it, and the plugin,
// whose op must not trust that every caller went through the bridge's schema.
// No runtime dependencies (the plugin bundle imports this).
//
// The accepted values are the typings' own (@figma/plugin-typings 1.141.0,
// ExportSettingsMP4 / GIF / WEBM and VideoExportConstraint, plugin-api.d.ts
// 5205-5317) [C-116]: they differ per format, and Figma's refusal of a wrong
// one arrives only after the export has been queued. The frame count comes
// from motion-curves.ts, so the plugin and the server count one way.

import { BridgeError, ErrorCode } from "./errors.js";
import { expectedFrames as framesOfRender } from "./motion-curves.js";

export const VIDEO_FORMATS = ["MP4", "GIF", "WEBM"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const VIDEO_MIME: Record<VideoFormat, string> = { MP4: "video/mp4", GIF: "image/gif", WEBM: "video/webm" };
export const VIDEO_EXTENSION: Record<VideoFormat, string> = { MP4: ".mp4", GIF: ".gif", WEBM: ".webm" };

export const VIDEO_FPS: Record<VideoFormat, readonly number[]> = { MP4: [12, 24, 30, 60], GIF: [8, 12, 15, 24, 30], WEBM: [12, 24, 30, 60] };
/** What Figma renders when `fps` is not given (the typings' "Defaults to") [C-116]. */
export const DEFAULT_VIDEO_FPS: Record<VideoFormat, number> = { MP4: 30, GIF: 15, WEBM: 30 };
export const VIDEO_SCALES: readonly number[] = [0.5, 0.75, 1, 1.5, 2, 3, 4];

// ── frame arithmetic ─────────────────────────────────────────────────────────
// Figma samples frame k at exactly k / fps [C-193], so a frame is addressed by
// its index; seconds are only how ffmpeg is told where to look.

/**
 * Where an input seek lands on frame k. At (k + 0.5) / fps ffmpeg returns
 * frame k + 1, at (k − 0.25) / fps frame k [C-195]: a quarter frame early is
 * inside k's interval whatever the container's rounding. Six decimals: the
 * argument stays readable and the error is far below a quarter frame.
 */
export function frameSeek(k: number, fps: number): number {
  return Math.max(0, Math.round(((k - 0.25) / fps) * 1e6) / 1e6);
}

/** The frame shown at `t` seconds. */
export function frameAt(t: number, fps: number): number {
  return Math.round(t * fps);
}

/**
 * Figma renders the end frame too: d seconds at fps, d kept to the
 * microsecond, is ceil(d · fps) + 1 frames in every format [C-194]. One
 * formula for every caller, in motion-curves.ts.
 */
export function expectedFrames(durationS: number, fps: number): number {
  return framesOfRender(durationS, fps);
}

// ── a render Figma gave up on ────────────────────────────────────────────────
// Figma ends a video render it has not finished about 240 s after it began,
// rejecting exportAsync with "Video export timed out" [C-198]. It is not a
// verdict on the frame: on 2026-10-13 the same frame rendered at another fps
// seconds later, and the same settings rendered in another run. So it is a
// TIMEOUT to render again, never UNSUPPORTED — which tells an agent to stop.

const TIMED_OUT = /\bvideo export timed out\b/i;

/** Whether Figma's own rejection of a video exportAsync is its time limit (pass Figma's message, not a wrapped one). */
export function isRenderTimeout(figmaMessage: string): boolean {
  return TIMED_OUT.test(figmaMessage);
}

/** What to do when Figma gave up on a render. */
export const RENDER_TIMEOUT_HINT =
  "Figma ends a video render it has not finished in about 4 minutes; the frame is not at fault. Ask the user to keep " +
  "the Figma window restored (a minimized window stalls video export), then render again. If it times out again, " +
  "render fewer frames: a lower `fps`, a smaller `width`, or a shorter timeline.";

const QUALITIES = ["LOW", "MEDIUM", "HIGH"];

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

/**
 * The ExportSettings object for `exportAsync`, from the tool's flat params:
 * `format`, `fps`, `quality` (MP4 / WEBM), `loopCount` (GIF), and at most one
 * of `width`, `height`, `scale` as the size constraint.
 */
export function videoSettings(params: Record<string, unknown>): Record<string, unknown> & { format: VideoFormat } {
  const raw = params.format === undefined ? "MP4" : params.format;
  const format = typeof raw === "string" ? raw.toUpperCase() : "";
  if (!(VIDEO_FORMATS as readonly string[]).includes(format)) throw invalid(`\`format\` must be MP4, GIF or WEBM (got ${JSON.stringify(raw)}).`);
  const f = format as VideoFormat;
  const settings: Record<string, unknown> & { format: VideoFormat } = { format: f };

  if (params.fps !== undefined) {
    if (typeof params.fps !== "number" || !VIDEO_FPS[f].includes(params.fps)) {
      throw invalid(`\`fps\` ${JSON.stringify(params.fps)} is not offered for ${f}.`, `${f} takes ${VIDEO_FPS[f].join(", ")}.`);
    }
    settings.fps = params.fps;
  }
  if (params.quality !== undefined) {
    if (f === "GIF") throw invalid("`quality` applies to MP4 and WEBM; a GIF takes `fps` and `loopCount`.");
    const q = typeof params.quality === "string" ? params.quality.toUpperCase() : "";
    if (!QUALITIES.includes(q)) throw invalid("`quality` must be LOW, MEDIUM or HIGH.");
    settings.quality = q;
  }
  if (params.loopCount !== undefined) {
    if (f !== "GIF") throw invalid("`loopCount` applies to GIF only; a video plays once.");
    const n = params.loopCount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1000) throw invalid("`loopCount` must be an integer from 0 (forever) to 1000.");
    settings.loopCount = n;
  }

  const sizes = (["width", "height", "scale"] as const).filter((k) => params[k] !== undefined);
  if (sizes.length > 1) throw invalid(`Give at most one of \`width\`, \`height\` and \`scale\` (got ${sizes.join(" and ")}).`, "The other side follows the frame's aspect ratio.");
  const size = sizes[0];
  if (size === "scale") {
    if (typeof params.scale !== "number" || !VIDEO_SCALES.includes(params.scale)) {
      throw invalid(`\`scale\` ${JSON.stringify(params.scale)} is not an export scale.`, `Use one of ${VIDEO_SCALES.join(", ")}, or a pixel \`width\` / \`height\`.`);
    }
    settings.constraint = { type: "SCALE", value: params.scale };
  } else if (size !== undefined) {
    const v = params[size];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw invalid(`\`${size}\` must be a number of pixels greater than 0.`);
    settings.constraint = { type: size === "width" ? "WIDTH" : "HEIGHT", value: v };
  }
  return settings;
}
