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
import { PLUGIN_MENU_PATH, PLUGIN_NAME } from "./version.js";

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
//
// Figma's exporter can also get stuck: every render then ends in that limit,
// small or large, until Figma is quit and reopened [C-318]. Fewer frames do
// not help then, so the advice turns to a restart on the second timeout in a
// row (the bridge counts them per plugin window), or on the first timeout of
// a render too small to need 4 minutes.

const TIMED_OUT = /\bvideo export timed out\b/i;

/** Whether Figma's own rejection of a video exportAsync is its time limit (pass Figma's message, not a wrapped one). */
export function isRenderTimeout(figmaMessage: string): boolean {
  return TIMED_OUT.test(figmaMessage);
}

/** Figma's own words at the end of the plugin's `Figma could not export "<name>" as <format>: <words>`. */
export function figmaWords(message: string): string {
  const at = message.lastIndexOf(": ");
  return at < 0 ? message : message.slice(at + 2);
}

/** How much a render asks of Figma: frames, and the output size of each. */
export interface RenderSize {
  frames: number;
  width: number;
  height: number;
}

/**
 * Under this many pixels rendered (frames × width × height) a render is
 * small: a 14.4 s, 1080 × 1920, 30 fps render — 433 frames, about 900 million
 * pixels — took 28–47 s [C-197], so one under a quarter of that has no reason
 * to reach Figma's 4-minute limit, and its timeout says the exporter is stuck
 * [C-318], not that the render is too big.
 */
export const SMALL_RENDER_PIXELS = 200_000_000;

export function isSmallRender(r: RenderSize | undefined): boolean {
  return r !== undefined && r.frames > 0 && r.frames * r.width * r.height <= SMALL_RENDER_PIXELS;
}

/** The size a render comes out at: the frame's own size under the settings' constraint. */
export function renderSize(frame: { width: number; height: number }, settings: Record<string, unknown>, durationS: number, fps: number): RenderSize {
  const c = settings.constraint as { type?: string; value?: number } | undefined;
  const v = typeof c?.value === "number" && c.value > 0 ? c.value : undefined;
  let { width, height } = frame;
  if (v !== undefined && width > 0 && height > 0) {
    if (c!.type === "SCALE") [width, height] = [width * v, height * v];
    else if (c!.type === "WIDTH") [width, height] = [v, (height * v) / width];
    else if (c!.type === "HEIGHT") [width, height] = [(width * v) / height, v];
  }
  return { frames: expectedFrames(durationS, fps), width: Math.round(width), height: Math.round(height) };
}

/** Restart advice, for when Figma's exporter looks stuck [C-318]. */
export const RENDER_STUCK_HINT =
  "In that state every render times out until Figma restarts, and fewer frames do not help. Ask the user to save their " +
  `work, quit Figma completely and reopen it, then run the ${PLUGIN_NAME} plugin again (${PLUGIN_MENU_PATH}); then render again.`;

/**
 * What to do when Figma gave up on a render. `inARow`: the timeouts in a row
 * in this plugin window, this one included (the bridge counts them); `small`:
 * the render was too small to need 4 minutes.
 */
export function renderTimeoutHint(o: { inARow?: number; small?: boolean } = {}): string {
  const inARow = o.inARow ?? 1;
  if (inARow >= 2) return `${inARow} renders in a row ended in Figma's 4-minute limit, so Figma's video exporter is likely stuck. ${RENDER_STUCK_HINT}`;
  if (o.small) return `A render this small should take seconds, so Figma's video exporter is likely stuck. ${RENDER_STUCK_HINT}`;
  return (
    "Figma ends a video render it has not finished in about 4 minutes; the frame is not at fault. Ask the user to keep " +
    "the Figma window restored (a minimized window stalls video export), then render again. A large render (a high `fps`, " +
    "a big `width`, a long timeline) may need fewer frames to fit. If the next render times out too, Figma's video " +
    `exporter is likely stuck: ask the user to save, quit and reopen Figma, then run the ${PLUGIN_NAME} plugin again.`
  );
}

/** The hint of a first timeout of a render of unknown size. */
export const RENDER_TIMEOUT_HINT = renderTimeoutHint();

/** A rejection of a video exportAsync that is neither the time limit nor a missing animation. */
export const RENDER_FAILED_HINT =
  "Figma refused the render without saying why; the frame has a timeline, so a missing animation is not the cause. " +
  `Render again once. If it fails again, ask the user to save, quit and reopen Figma, then run the ${PLUGIN_NAME} plugin again ` +
  `(${PLUGIN_MENU_PATH}) and render again. Video export needs Figma desktop.`;

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
