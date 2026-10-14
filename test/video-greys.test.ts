// spikes/video-greys.mjs: how the live spikes read a render's frames as grey
// levels. On 2026-10-13 live-animatic.mjs let ffmpeg average each frame
// (scale=1:1:flags=area,format=gray), which opens the MP4's TV range twice:
// panels filled 32 and 232 read 16 and 249, past the spike's tolerance of 15,
// so 24.exactFrames, 30.exactFrames and dissolve.exactAround failed on frames
// that showed the right panel. The reader now decodes each frame whole at its
// own size and averages it here. The fakes pin the arguments; one test runs
// the real ffmpeg on a TV-range clip made like Figma's, when it is installed.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frameSize, greyDecodeArgs, greysOf, meanGreys, panelOfGrey, type RunSync } from "../spikes/video-greys.mjs";

const GREYS = [32, 72, 112, 152, 192, 232];

describe("the frame reader, with ffmpeg stubbed", () => {
  it("decodes every frame whole at the video's own size: no scale filter for ffmpeg to average with", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const frames = [Buffer.alloc(6, 31), Buffer.from([0, 0, 0, 255, 255, 255]), Buffer.alloc(6, 231)];
    const run: RunSync = (file, args) => {
      calls.push({ file, args });
      return file === "ffprobe" ? "3x2\n" : Buffer.concat(frames);
    };
    expect(greysOf("C:\\renders\\a b.mp4", run)).toEqual([31, 128, 231]);
    expect(calls.map((c) => c.file)).toEqual(["ffprobe", "ffmpeg"]);
    expect(calls[0]!.args).toContain("stream=width,height");
    expect(calls[1]!.args).toEqual(greyDecodeArgs("C:\\renders\\a b.mp4"));
    const vf = calls[1]!.args[calls[1]!.args.indexOf("-vf") + 1];
    expect(vf).toBe("format=gray");
  });

  it("averages each frame, drops a partial one, and refuses a frame size that is not a whole number", () => {
    expect(meanGreys(new Uint8Array([10, 20, 30, 40, 50]), 2)).toEqual([15, 35]);
    expect(meanGreys(new Uint8Array([]), 4)).toEqual([]);
    expect(() => meanGreys(new Uint8Array([1]), 0)).toThrow(/positive whole number/);
    expect(() => frameSize("x.mp4", () => "")).toThrow(/no frame size/);
  });

  it("names the nearest panel within the tolerance, or none", () => {
    expect([31, 72, 111, 152, 192, 231].map((g) => panelOfGrey(g, GREYS, 15))).toEqual([1, 2, 3, 4, 5, 6]);
    // The 2026-10-13 run's 1 × 1 reads of panels 1 and 6.
    expect([16, 249].map((g) => panelOfGrey(g, GREYS, 15))).toEqual([0, 0]);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("the frame reader on a real TV-range clip", () => {
  it("reads six flat greys back within 2 levels, so every frame names its panel", () => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-greys-"));
    const clip = join(dir, "six greys.mp4");
    // Like Figma's export: flat RGB frames encoded to yuv420p in the TV range, bt709, 3 frames per grey at 24 fps.
    const hex = (g: number) => "0x" + g.toString(16).padStart(2, "0").repeat(3);
    const graph =
      GREYS.map((g, i) => `color=c=${hex(g)}:s=216x384:r=24:d=0.125[s${i}]`).join(";") +
      ";" +
      GREYS.map((_, i) => `[s${i}]`).join("") +
      `concat=n=${GREYS.length}:v=1:a=0,format=yuv420p[v]`;
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-y", "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", clip],
      { windowsHide: true },
    );
    const levels = greysOf(clip);
    expect(levels).toHaveLength(18);
    levels.forEach((level, f) => {
      const fill = GREYS[Math.floor(f / 3)]!;
      expect(Math.abs(level - fill), `frame ${f}: read ${level}, filled ${fill}`).toBeLessThanOrEqual(2);
      expect(panelOfGrey(level, GREYS, 15)).toBe(Math.floor(f / 3) + 1);
    });
  });
});
