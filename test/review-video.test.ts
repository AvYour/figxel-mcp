// figma_review_video: one render mined for a contact sheet, close-ups,
// frame-exact stills and per-frame metrics, with no Figma call [C-182]. The
// fakes record every ffmpeg and ffprobe argument array, so the tests pin what
// would run — paths with spaces, `select` by frame index, the quarter-frame
// seek [C-195], labels drawn before the selection [C-205] — and a decode pass
// fed synthetic grey frames. One test runs the real ffmpeg on a generated
// clip when it is installed.

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecFileLike } from "../src/server/tools/motion.js";
import { fontCandidates, fontOption, registerReview, tileGraph, type ChildLike, type ReviewOptions, type SpawnLike } from "../src/server/tools/review.js";

type Answer = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown> };
type Call = { file: string; args: readonly string[]; options: Record<string, unknown> };

const ENOENT = (file: string) => Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
/** The synthetic clip's grey per frame: a ramp, still on 20–39, white on 45. */
const step = (n: number) => (n < 20 ? n : n <= 39 ? 20 : n - 19);
const greyOf = (n: number) => (n === 45 ? 250 : 3 * step(n));
const FRAME_BYTES = 270 * 480; // 108 × 192 scales to 270 × 480

async function connect(roots: { exportDir: string; exportRoots: string[] }, opts: ReviewOptions): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
  registerReview(server, roots, () => true, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "review-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("figma_review_video with ffmpeg stubbed", () => {
  let client: Client;
  let exportDir: string;
  let video: string;
  let calls: Call[];
  let spawned: Call[];
  let probeMode: "ok" | "missing" | "garbage";
  let probeFrames: number;
  let drawtext: boolean;
  let fontExists: boolean;
  let ffmpegMissing: boolean;
  let decodeMissing: boolean;
  let bigSheet: boolean;

  const call = (args: Record<string, unknown>) => client.callTool({ name: "figma_review_video", arguments: args }) as Promise<Answer>;
  const json = (r: Answer) => JSON.parse(r.content[0]!.text!) as Record<string, any>;
  const graphs = () => calls.filter((c) => c.file === "ffmpeg" && c.args.includes("-vf")).map((c) => c.args[c.args.indexOf("-vf") + 1]);
  const seeks = () => calls.filter((c) => c.file === "ffmpeg" && c.args.includes("-ss")).map((c) => c.args[c.args.indexOf("-ss") + 1]);

  beforeEach(async () => {
    exportDir = mkdtempSync(join(tmpdir(), "fmcp-review-"));
    video = join(exportDir, "my clip.mp4");
    writeFileSync(video, "not really a video");
    calls = [];
    spawned = [];
    probeMode = "ok";
    probeFrames = 60;
    drawtext = true;
    fontExists = true;
    ffmpegMissing = false;
    decodeMissing = false;
    bigSheet = false;
    const exec: ExecFileLike = (file, args, options, callback) => {
      calls.push({ file, args, options });
      const none = Buffer.alloc(0);
      if (file === "ffprobe") {
        if (probeMode === "missing") return callback(ENOENT(file), none, none);
        if (probeMode === "garbage") return callback(Object.assign(new Error("Command failed"), { code: 1 }), none, Buffer.from(`${video}: Invalid data found when processing input`));
        const probe = { streams: [{ width: 108, height: 192, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: String(probeFrames) }], format: { duration: "2.000000" } };
        return callback(null, Buffer.from(JSON.stringify(probe)), none);
      }
      if (args.includes("-h")) return callback(null, Buffer.from(drawtext ? "Filter drawtext\n  Draw text on top of video frames." : "Unknown filter 'drawtext'."), none);
      if (ffmpegMissing) return callback(ENOENT(file), none, none);
      const isSheet = String(args[args.indexOf("-vf") + 1] ?? "").includes("not(mod(");
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(bigSheet && isSheet ? 6 * 1024 * 1024 : 8)]);
      return callback(null, png, none);
    };
    const spawn: SpawnLike = (file, args, options) => {
      spawned.push({ file, args, options: options as unknown as Record<string, unknown> });
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        if (decodeMissing) {
          child.emit("error", ENOENT(file));
          child.emit("close", -2);
          return;
        }
        const all = Buffer.concat(Array.from({ length: probeFrames }, (_, n) => Buffer.alloc(FRAME_BYTES, greyOf(n))));
        // Chunks that straddle frame boundaries, as a pipe delivers them.
        for (let off = 0; off < all.length; off += 50_000) child.stdout.emit("data", all.subarray(off, off + 50_000));
        child.emit("close", 0);
      });
      return child as ChildLike;
    };
    client = await connect({ exportDir, exportRoots: [] }, { execFile: exec, spawn, fonts: ["C:\\Windows\\Fonts\\arial.ttf"], exists: () => fontExists });
  });
  afterEach(async () => {
    await client.close();
  });

  it("probes, then decodes once as 270-px grey, each through an argument array with the path whole", async () => {
    const r = await call({ path: "my clip.mp4", every: 5 });
    expect(r.isError).toBeFalsy();
    const out = json(r);
    expect(out.path).toBe(video);
    expect(out.video).toEqual({ width: 108, height: 192, fps: 30, frames: 60, durationS: 2 });
    const probe = calls.find((c) => c.file === "ffprobe")!;
    expect(probe.args.at(-1)).toBe(video);
    expect(probe.args).toContain("-count_frames");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.file).toBe("ffmpeg");
    expect(spawned[0]!.args).toEqual(["-v", "error", "-i", video, "-vf", "scale=270:480:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    for (const c of [...calls, ...spawned]) expect(c.options).not.toHaveProperty("shell");
  });

  it("the metrics find the clip's freeze and flash, with findings an agent can act on", async () => {
    const out = json(await call({ path: video }));
    expect(out.metrics.analysisWidth).toBe(270);
    expect(out.metrics.diff).toHaveLength(60);
    expect(out.metrics.freezes).toEqual([{ from: 20, to: 39, s: 0.67, meanDiff: 0 }]);
    expect(out.metrics.flashes).toMatchObject([{ frame: 45, changed: 1 }]);
    expect(out.findings.map((f: { kind: string }) => f.kind).sort()).toEqual(["flash", "freeze"]);
  });

  it("declared cuts and holds are not findings; expectFrames checks the length", async () => {
    const out = json(await call({ path: video, cuts: [45, 46], holds: [{ fromFrame: 20, toFrame: 39 }], expectFrames: 61 }));
    expect(out.metrics.freezes).toEqual([]);
    expect(out.metrics.flashes).toEqual([]);
    expect(out.metrics.cuts).toMatchObject([{ frame: 45, declared: true }, { frame: 46, declared: true }]);
    expect(out.frameCountNote).toBe("60 frames; expected 61.");
    expect(out.findings).toMatchObject([{ kind: "frame_count", severity: "warning" }]);
    expect(json(await call({ path: video, expectFrames: 60, metrics: false })).frameCountNote).toBe("60 frames, as expected.");
  });

  it("a hold in seconds, as figma_check_motion takes it, is the same frames at the video's fps", async () => {
    // Frames 20-39 at 30 fps: 20/30 = 0.6667 s to 39/30 = 1.3 s.
    const out = json(await call({ path: video, holds: [{ from: 0.6667, to: 1.3 }] }));
    expect(out.metrics.freezes).toEqual([]);
    // 1.2 s is frame 36: frames 20-36 stay a freeze (0.53 s, past the 0.5 s floor).
    const late = json(await call({ path: video, holds: [{ from: 1.2, to: 1.3 }] }));
    expect(late.metrics.freezes).toMatchObject([{ from: 20, to: 36 }]);
  });

  it("a length finding names the count rule, the same in every format: the first frame at or after the end (C-194)", async () => {
    const mp4 = json(await call({ path: video, expectFrames: 61, metrics: false }));
    expect(mp4.findings[0].detail).toMatch(/ceil\(duration × fps\) \+ 1; figma_export_video's expectedFrames counts it/);
    expect(mp4.findings[0].detail).not.toMatch(/round\(/);
    const gif = join(exportDir, "my clip.gif");
    writeFileSync(gif, "not really a gif");
    const out = json(await call({ path: gif, expectFrames: 61, metrics: false }));
    expect(out.frameCountNote).toBe("60 frames; expected 61.");
    expect(out.findings).toMatchObject([{ kind: "frame_count", severity: "warning", frames: [59] }]);
    expect(out.findings[0].detail).toBe(mp4.findings[0].detail);
  });

  it("the sheet and close-ups pick frames by index, labelled before the selection so a label is the video's frame", async () => {
    const out = json(await call({ path: video, every: 5, closeups: [{ startFrame: 40, frames: 8, columns: 4 }] }));
    const label = "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{n}':x=4:y=4:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3";
    expect(graphs()).toEqual([
      `scale=180:320:flags=area,${label},select='not(mod(n\\,5))',tile=9x2:nb_frames=12:padding=2:margin=2`,
      `scale=180:320:flags=area,${label},select='between(n\\,40\\,47)',tile=4x2:nb_frames=8:padding=2:margin=2`,
    ]);
    expect(out.sheet).toMatchObject({ path: join(exportDir, "my clip-sheet.png"), image: 1, every: 5, columns: 9, labelled: true });
    expect(out.sheet.tiles).toHaveLength(12);
    expect(out.sheet.tiles[1]).toEqual({ index: 1, frame: 5, t: 0.1667 });
    expect(out.closeups).toEqual([{ frames: [40, 47], path: join(exportDir, "my clip-closeup-40-47.png"), image: 2 }]);
    expect(existsSync(out.sheet.path)).toBe(true);
    expect(existsSync(out.closeups[0].path)).toBe(true);
  });

  it("a sheet holds at most 240 tiles; `every` is raised, with a note", async () => {
    probeFrames = 600;
    const out = json(await call({ path: video, every: 1, metrics: false }));
    expect(out.sheet.every).toBe(3);
    expect(out.sheet.tiles).toHaveLength(200);
    expect(out.note).toMatch(/`every` raised from 1 to 3/);
    expect(graphs()[0]).toContain("tile=9x23:nb_frames=200");
  });

  it("stills are frame-exact: each seeks a quarter frame early, and one past the end says so", async () => {
    const out = json(await call({ path: video, stills: [0, 15, 59, 70], metrics: false }));
    expect(seeks()).toEqual(["0", "0.491667", "1.958333"]);
    expect(out.stills).toEqual([
      { frame: 0, t: 0, path: join(exportDir, "my clip-f0.png"), image: 2 },
      { frame: 15, t: 0.5, path: join(exportDir, "my clip-f15.png"), image: 3 },
      { frame: 59, t: 1.9667, path: join(exportDir, "my clip-f59.png"), image: 4 },
      { frame: 70, error: "past the last frame (59)" },
    ]);
  });

  it("without drawtext or a font, tiles are unlabelled and `tiles` maps each to its frame", async () => {
    drawtext = false;
    const out = json(await call({ path: video, metrics: false }));
    expect(graphs()[0]).not.toContain("drawtext");
    expect(out.sheet.labelled).toBe(false);
    expect(out.note).toMatch(/Frame numbers are not burned in/);
    expect(out.sheet.tiles).toHaveLength(60);
  });

  it("with drawtext but no font file found, tiles are unlabelled too", async () => {
    fontExists = false;
    const out = json(await call({ path: video, metrics: false }));
    expect(out.sheet.labelled).toBe(false);
    expect(graphs()[0]).not.toContain("drawtext");
  });

  it("returns at most `maxImages` inline, never one over 5 MB; every image is written", async () => {
    const two = await call({ path: video, metrics: false, closeups: [{ startFrame: 0 }], stills: [1, 2], maxImages: 2 });
    expect(two.content.filter((c) => c.type === "image")).toHaveLength(2);
    const out = json(two);
    expect(out.stills.map((s: { image?: number }) => s.image)).toEqual([undefined, undefined]);
    for (const s of out.stills) expect(existsSync(s.path)).toBe(true);

    expect((await call({ path: video, metrics: false, maxImages: 0 })).content.filter((c) => c.type === "image")).toHaveLength(0);

    bigSheet = true;
    const big = await call({ path: video, metrics: false, stills: [3] });
    const shaped = json(big);
    expect(shaped.sheet.image).toBeUndefined();
    expect(existsSync(shaped.sheet.path)).toBe(true);
    expect(shaped.stills[0].image).toBe(1);
  });

  it("writes the images to `saveDir`, and skips the decode when `metrics` is false", async () => {
    const out = json(await call({ path: video, saveDir: "review", metrics: false }));
    expect(out.sheet.path).toBe(join(exportDir, "review", "my clip-sheet.png"));
    expect(spawned).toEqual([]);
    expect(out.metrics).toBeUndefined();
  });

  it("without ffprobe or ffmpeg it answers UNSUPPORTED and points at figma_check_motion", async () => {
    probeMode = "missing";
    const r = await call({ path: video });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^UNSUPPORTED: ffprobe is not on PATH[\s\S]*figma_check_motion/);
    probeMode = "ok";
    decodeMissing = true;
    const d = await call({ path: video });
    expect(d.isError).toBe(true);
    expect(d.content[0]!.text).toMatch(/^UNSUPPORTED: ffmpeg is not on PATH/);
  });

  it("without ffmpeg for the pictures, the numbers still come back, with a note", async () => {
    ffmpegMissing = true;
    const out = json(await call({ path: video, stills: [1], metrics: false }));
    expect(out.sheet.error).toBe("ffmpeg is not on PATH");
    expect(out.stills[0].error).toBe("ffmpeg is not on PATH");
    expect(out.note).toMatch(/ffmpeg is not on PATH, so no images were cut/);
  });

  it("refuses a path outside the roots, a missing file, a file that is not a video and a backwards hold", async () => {
    for (const [args, pattern] of [
      [{ path: "../../outside.mp4" }, /`path` must be inside the export directory/],
      [{ path: "nope.mp4" }, /No video at/],
      [{ path: video, holds: [{ fromFrame: 9, toFrame: 3 }] }, /A hold runs backwards/],
      [{ path: video, holds: [{ from: 2, to: 1 }] }, /A hold runs backwards: from 2 s > to 1 s/],
      [{ path: video, holds: [{ fromFrame: 1, to: 2 }] }, /holds\[0\] mixes frames/],
      [{ path: video, holds: [{ fromFrame: 1 }] }, /holds\[0\] needs fromFrame and toFrame/],
      [{ path: video, saveDir: "../../elsewhere" }, /`saveDir` must be inside/],
    ] as const) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0]!.text, JSON.stringify(args)).toMatch(pattern);
    }
    expect(calls).toEqual([]);
    probeMode = "garbage";
    const r = await call({ path: video });
    expect(r.content[0]!.text).toMatch(/^INVALID_PARAM: ffprobe cannot read .*Invalid data found/);
  });
});

describe("filter graph helpers", () => {
  it("quotes a Windows font path for the graph and escapes its colon for the option parser", () => {
    expect(fontOption("C:\\Windows\\Fonts\\arial.ttf")).toBe("'C\\:/Windows/Fonts/arial.ttf'");
    expect(fontOption("/usr/share/fonts/DejaVuSans.ttf")).toBe("'/usr/share/fonts/DejaVuSans.ttf'");
    expect(fontOption("/fonts/it's.ttf")).toBeUndefined();
  });

  it("offers each platform's common fonts", () => {
    expect(fontCandidates("win32", { WINDIR: "D:\\Win" })[0]).toBe("D:\\Win\\Fonts\\arial.ttf");
    expect(fontCandidates("darwin", {})[0]).toMatch(/Arial\.ttf$/);
    expect(fontCandidates("linux", {})[0]).toMatch(/DejaVuSans\.ttf$/);
  });

  it("a short selection gets as many columns as tiles", () => {
    expect(tileGraph({ tileWidth: 100, tileHeight: 50, select: "between(n\\,0\\,2)", columns: 8, count: 3 })).toBe(
      "scale=100:50:flags=area,select='between(n\\,0\\,2)',tile=3x1:nb_frames=3:padding=2:margin=2",
    );
  });
});

// ── the real ffmpeg, when this machine has it ────────────────────────────────

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("figma_review_video on a real clip", () => {
  it("finds the frozen stretch and the white frame, and every still is the frame it names", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "fmcp-review-real-"));
    mkdirSync(exportDir, { recursive: true });
    const clip = join(exportDir, "real clip.mp4");
    // 2 s at 30 fps, lossless: frame n's luma is 16 + 3·step(n) in the limited range, still on 20–39, white on 45.
    const lum = "if(eq(N\\,45)\\,235\\,16+3*if(lt(N\\,20)\\,N\\,if(lte(N\\,39)\\,20\\,N-19)))";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=64x64:r=30:d=2,format=yuv420p,geq=lum='${lum}':cb=128:cr=128`, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", clip], { windowsHide: true });
    const client = await connect({ exportDir, exportRoots: [] }, {});
    try {
      const r = (await client.callTool({ name: "figma_review_video", arguments: { path: clip, stills: [0, 14, 15, 59], maxImages: 8 } })) as Answer;
      expect(r.isError).toBeFalsy();
      const out = JSON.parse(r.content[0]!.text!);
      expect(out.video).toMatchObject({ frames: 60, fps: 30 });
      expect(out.metrics.freezes).toMatchObject([{ from: 20, to: 39 }]);
      expect(out.metrics.flashes).toMatchObject([{ frame: 45 }]);
      expect(existsSync(out.sheet.path)).toBe(true);
      // Grey of a still, as the decode pass sees it: the limited range opened to 0–255.
      const images = r.content.filter((c) => c.type === "image");
      for (const s of out.stills as Array<{ frame: number; image: number }>) {
        const png = Buffer.from(images[s.image - 1]!.data!, "base64");
        const grey = execFileSync("ffmpeg", ["-v", "error", "-f", "png_pipe", "-i", "-", "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { input: png, windowsHide: true })[0]!;
        const expected = (3 * step(s.frame) * 255) / 219;
        expect(Math.abs(grey - expected), `frame ${s.frame}`).toBeLessThanOrEqual(2);
      }
    } finally {
      await client.close();
    }
  });
});
