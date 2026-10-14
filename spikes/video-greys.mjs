// A render's frames as grey levels, read the way a player shows them: for the
// spikes that measure which picture is on screen on which frame
// (live-animatic.mjs). Run directly, it re-reads a render without Figma:
//
//   node spikes/video-greys.mjs <video>     one mean grey (0–255) per frame, as JSON
//
// Each frame is decoded whole at its own size and averaged here, never by
// ffmpeg. Figma's MP4 is yuv420p in the TV range (16–235, bt709), and an area
// downscale to 1 × 1 opens that range twice. Measured 2026-10-13 with ffmpeg
// 9.0 on the live-animatic 24 fps render, whose six panels are filled 32, 72,
// 112, 152, 192 and 232:
//
//   raw luma                            43, 78, 112, 147, 181, 215  (16 + 219 · g / 255)
//   format=gray at the frame's size     31, 72, 111, 152, 192, 231  (each fill within 1)
//   scale=1:1:flags=area,format=gray    16, 62, 110, 157, 202, 249  (the range opened twice)
//
// The 1 × 1 read put the darkest and the lightest panel 16 and 17 levels off,
// past the spike's tolerance, so frames that showed the right panel were
// scored as showing none. Downscales to 2–16 px read up to 6 levels low as
// well; at the frame's own size every fill reads back within 1. A libx264 clip
// made from the same six RGB greys reads the same three rows, so this is
// ffmpeg's read, not Figma's encode.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Room for every frame of a spike render (216 × 384 × a few hundred frames). */
const MAX_BUFFER = 1 << 30;

/** The video's frame size in pixels, from ffprobe. */
export function frameSize(file, run = execFileSync) {
  const out = String(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], { windowsHide: true })).trim();
  const m = /^(\d+)x(\d+)/.exec(out);
  if (!m) throw new Error(`ffprobe gave no frame size for ${file}: ${out || "(nothing)"}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** ffmpeg arguments that stream every frame as 8-bit grey at its own size: no scale, so the TV range is opened once. */
export function greyDecodeArgs(file) {
  return ["-v", "error", "-i", file, "-vf", "format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"];
}

/** The mean grey (0–255, rounded) of each whole frame in a raw 8-bit grey stream; a trailing partial frame is dropped. */
export function meanGreys(bytes, frameBytes) {
  if (!Number.isInteger(frameBytes) || frameBytes < 1) throw new Error(`frameBytes must be a positive whole number, not ${frameBytes}`);
  const levels = [];
  for (let off = 0; off + frameBytes <= bytes.length; off += frameBytes) {
    let sum = 0;
    for (let i = off; i < off + frameBytes; i++) sum += bytes[i];
    levels.push(Math.round(sum / frameBytes));
  }
  return levels;
}

/** Every frame of a video as its mean grey (0–255), read whole at the video's own size. */
export function greysOf(file, run = execFileSync) {
  const { width, height } = frameSize(file, run);
  const out = run("ffmpeg", greyDecodeArgs(file), { windowsHide: true, maxBuffer: MAX_BUFFER });
  return meanGreys(out, width * height);
}

/** The panel (1-based) whose grey a level is nearest, or 0 when none is within `tolerance`. */
export function panelOfGrey(level, greys, tolerance) {
  let best = 0;
  let dist = Infinity;
  greys.forEach((g, i) => {
    const d = Math.abs(level - g);
    if (d < dist) {
      dist = d;
      best = i + 1;
    }
  });
  return dist <= tolerance ? best : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node spikes/video-greys.mjs <video>");
    process.exit(2);
  }
  console.log(JSON.stringify(greysOf(file)));
}
