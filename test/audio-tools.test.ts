// figma_analyze_audio, figma_add_audio and figma_generate_audio through a real
// MCP client. The ffmpeg and ffprobe fakes record every argument array, so the
// tests pin what would run: the filter graph, the stream mapping, the copied
// video, loudnorm only when asked, and every refusal before anything runs.
// When ffmpeg is installed, one block runs the real thing end to end.

import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANALYSIS_RATE } from "../src/server/audio-analysis.js";
import type { Bridge } from "../src/server/bridge.js";
import type { MediaTools } from "../src/server/ffmpeg.js";
import { mixGraph, muxArgs, parseEbur128, parseLoudnorm, placeTracks, registerAudio, type AudioOptions } from "../src/server/tools/audio.js";
import type { ExecFileLike } from "../src/server/tools/motion.js";
import type { ChildLike, SpawnLike } from "../src/server/tools/review.js";
import { decodeWav } from "../src/server/wav.js";
import { loadSnapshot } from "./fixtures/motion-2026-10-09/snapshot.js";

type Answer = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any> };
type Call = { file: string; args: readonly string[] };

const ENOENT = (file: string) => Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
const SUMMARY = (i: string, tp: string) =>
  `[Parsed_ebur128_0 @ 0000] Summary:\n\n  Integrated loudness:\n    I:         ${i} LUFS\n    Threshold: -30.1 LUFS\n\n  Loudness range:\n    LRA:         3.2 LU\n    Threshold:   -40.0 LUFS\n    LRA low:   -20.1 LUFS\n    LRA high:  -17.0 LUFS\n\n  True peak:\n    Peak:       ${tp} dBFS\n`;
const LOUDNORM_JSON = `[Parsed_loudnorm_1 @ 0000] \n{\n\t"input_i" : "-21.30",\n\t"input_tp" : "-4.10",\n\t"input_lra" : "3.40",\n\t"input_thresh" : "-31.60",\n\t"output_i" : "-14.02",\n\t"output_tp" : "-1.00",\n\t"output_lra" : "3.10",\n\t"output_thresh" : "-24.30",\n\t"normalization_type" : "linear",\n\t"target_offset" : "0.02"\n}\n`;

interface Setup {
  client: Client;
  dir: string;
  calls: Call[];
  spawned: Call[];
  forwarded: Array<{ op: string; params: Record<string, unknown> }>;
  set: (o: Partial<{ missing: "ffprobe" | "ffmpeg"; videoHasAudio: boolean; outTp: string }>) => void;
}

/** `media`: programs BRIDGE_FFMPEG / BRIDGE_FFPROBE name; the fakes answer them as ffmpeg and ffprobe. */
async function setup(media?: MediaTools): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "fmcp-audio-"));
  for (const f of ["render.mp4", "render.webm", "render.gif", "music track.mp3", "hit.wav", "short.wav", "notes.txt"]) writeFileSync(join(dir, f), "x");
  const calls: Call[] = [];
  const spawned: Call[] = [];
  const forwarded: Setup["forwarded"] = [];
  const state = { missing: undefined as undefined | "ffprobe" | "ffmpeg", videoHasAudio: false, outTp: "-1.4" };
  const durations: Record<string, number> = { "music track.mp3": 30, "hit.wav": 1.2, "short.wav": 4 };
  const exec: ExecFileLike = (file, args, _options, callback) => {
    calls.push({ file, args });
    const none = Buffer.alloc(0);
    const tool = file === media?.ffprobe ? "ffprobe" : file === media?.ffmpeg ? "ffmpeg" : file;
    if (state.missing === tool) return callback(ENOENT(file), none, none);
    if (tool === "ffprobe") {
      const path = String(args.at(-1));
      const name = path.split(/[\\/]/).pop()!;
      if (name === "notes.txt") return callback(Object.assign(new Error("fail"), { code: 1 }), none, Buffer.from(`${path}: Invalid data found when processing input`));
      if (name.startsWith("render")) {
        const streams: Array<Record<string, unknown>> = [{ codec_type: "video", codec_name: "h264", duration: "6.000000", r_frame_rate: "30/1" }];
        if (state.videoHasAudio) streams.push({ codec_type: "audio", codec_name: "aac", duration: "6.0" });
        return callback(null, Buffer.from(JSON.stringify({ streams, format: { duration: "6.000000", format_name: "mov,mp4" } })), none);
      }
      if (name.includes("-audio") || name === "out.mp4") return callback(null, Buffer.from(JSON.stringify({ streams: [], format: { duration: "6.000000" } })), none);
      const d = durations[name] ?? 2;
      return callback(null, Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2, duration: String(d) }], format: { duration: String(d) } })), none);
    }
    const graph = String(args[args.indexOf("-filter_complex") + 1] ?? "");
    if (args.includes("ebur128=peak=true")) return callback(null, none, Buffer.from(SUMMARY("-14.1", args.at(-5) === "-i" ? state.outTp : state.outTp)));
    if (graph.includes("print_format=json")) return callback(null, none, Buffer.from(LOUDNORM_JSON));
    return callback(null, none, none);
  };
  // The decode: a click every 0.5 s (120 BPM) from 0.25 s, as s16le at 11,025 Hz.
  const spawn: SpawnLike = (file, args) => {
    spawned.push({ file, args });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      if (state.missing === "ffmpeg") {
        child.emit("error", ENOENT(file));
        child.emit("close", -2);
        return;
      }
      const pcm = Buffer.alloc(12 * ANALYSIS_RATE * 2);
      for (let k = 0; 0.25 + k * 0.5 < 11.7; k++) {
        const at = Math.round((0.25 + k * 0.5) * ANALYSIS_RATE);
        for (let i = 0; i < 300; i++) pcm.writeInt16LE(Math.round(20000 * Math.sin((2 * Math.PI * 1500 * i) / ANALYSIS_RATE) * Math.exp(-i / 110)), (at + i) * 2);
      }
      for (let off = 0; off < pcm.length; off += 40_001) child.stdout.emit("data", pcm.subarray(off, off + 40_001));
      child.emit("close", 0);
    });
    return child as ChildLike;
  };
  const bridge = {
    request: async (op: string, params: Record<string, unknown>) => {
      forwarded.push({ op, params });
      return loadSnapshot("r2");
    },
    statusAsync: async () => ({ sessions: [] }),
    status: () => ({ sessions: [] }),
  } as unknown as Bridge;
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
  const opts: AudioOptions = { execFile: exec, spawn, ...(media ? { media } : {}) };
  registerAudio(server, bridge, { exportDir: dir, exportRoots: [] }, () => true, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "audio-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dir, calls, spawned, forwarded, set: (o) => Object.assign(state, o) };
}

const json = (r: Answer) => JSON.parse(r.content[0]!.text!) as Record<string, any>;

describe("figma_add_audio with ffmpeg stubbed", () => {
  let s: Setup;
  const call = (args: Record<string, unknown>) => s.client.callTool({ name: "figma_add_audio", arguments: args }) as Promise<Answer>;
  const mux = () => s.calls.filter((c) => c.file === "ffmpeg" && c.args.includes("-c:v"));
  beforeEach(async () => (s = await setup()));
  afterEach(async () => s.client.close());

  it("copies the video stream and maps only it and the mix: one input per track, the graph exact", async () => {
    const r = await call({ video: "render.mp4", tracks: [{ path: "music track.mp3", fadeOutS: 1 }, { path: "hit.wav", start: 2.5, volumeDb: -6 }] });
    expect(r.isError).toBeFalsy();
    const [m] = mux();
    const out = join(s.dir, "render-audio.mp4");
    expect(m!.args).toEqual([
      "-v", "error", "-y",
      "-i", join(s.dir, "render.mp4"),
      "-i", join(s.dir, "music track.mp3"),
      "-i", join(s.dir, "hit.wav"),
      "-filter_complex",
      "[1:a:0]atrim=start=0:duration=6,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=out:st=5:d=1[a0];" +
        "[2:a:0]atrim=start=0:duration=1.2,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=-6dB,adelay=delays=120000S:all=1[a1];" +
        "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=288000,atrim=end_sample=288000[aout]",
      "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      out,
    ]);
    const res = json(r);
    expect(res).toMatchObject({ path: out, durationS: 6, video: { durationS: 6, fps: 30, copied: true }, audio: { codec: "aac", bitrate: "192k", sampleRate: 48000, channels: 2 } });
    expect(res.loudness).toMatchObject({ integratedLufs: -14.1, truePeakDbtp: -1.4, lra: 3.2 });
    // The 30 s track ran past the 6 s video: trimmed, with the fade moved to the new end.
    expect(res.warnings).toEqual(["tracks[0] runs 24 s past the video's end (6 s): trimmed there, and its fade-out moved to the new end."]);
    expect(res.tracks[0]).toMatchObject({ index: 0, start: 0, durationS: 6, fadeOutS: 1, endS: 6 });
    // No loudnorm unless asked; never a shell.
    expect(s.calls.some((c) => c.args.some((a) => a.includes("loudnorm")))).toBe(false);
  });

  it("loudness runs loudnorm twice: measured first, then applied linearly with the measured values", async () => {
    const r = await call({ video: "render.mp4", tracks: [{ path: "music track.mp3" }], loudness: -14 });
    expect(r.isError).toBeFalsy();
    const graphs = s.calls.filter((c) => c.args.includes("-filter_complex")).map((c) => c.args[c.args.indexOf("-filter_complex") + 1]!);
    expect(graphs).toHaveLength(2);
    expect(graphs[0]).toMatch(/,loudnorm=I=-14:TP=-2:LRA=11:print_format=json,aresample=48000\[aout\]$/);
    expect(graphs[1]).toMatch(/,loudnorm=I=-14:TP=-2:LRA=11:measured_I=-21.3:measured_TP=-4.1:measured_LRA=3.4:measured_thresh=-31.6:offset=0.02:linear=true:print_format=summary,aresample=48000\[aout\]$/);
    const first = s.calls.find((c) => c.args.includes("-filter_complex"))!;
    expect(first.args.slice(-4)).toEqual(["[aout]", "-f", "null", "-"]);
    expect(json(r).loudness.target).toBe(-14);
  });

  it("WebM gets Opus; a track after the end is left out; audio that stops early, a replaced track and a hot peak are warnings", async () => {
    s.set({ videoHasAudio: true, outTp: "-0.3" });
    const r = await call({ video: "render.webm", tracks: [{ path: "short.wav", start: 1 }, { path: "hit.wav", start: 7 }] });
    const res = json(r);
    expect(mux()[0]!.args).toEqual(expect.arrayContaining(["-c:a", "libopus", "-b:a", "192k"]));
    expect(mux()[0]!.args).not.toContain("-movflags");
    expect(mux()[0]!.args.filter((a) => a === "-i")).toHaveLength(2);
    expect(res.warnings).toEqual([
      "tracks[1] starts at 7 s, at or after the video's end (6 s): left out.",
      "The audio ends at 5 s, 1 s before the picture; the rest is silent.",
      "The video had its own audio; it is replaced by this mix.",
      "The mix peaks at -0.3 dBTP, above -1 dBTP: it can clip once a platform encodes it again. Lower a track's volumeDb, or pass `loudness`.",
    ]);
  });

  it("refuses a GIF, a path outside the roots, a missing track, a mismatched container and writing over an input — before ffmpeg runs", async () => {
    for (const [args, pattern] of [
      [{ video: "render.gif", tracks: [{ path: "hit.wav" }] }, /A GIF has no audio track/],
      [{ video: "../../elsewhere.mp4", tracks: [{ path: "hit.wav" }] }, /`video` must be inside the export directory/],
      [{ video: "render.mp4", tracks: [{ path: "../../music.mp3" }] }, /`tracks\[0\]\.path` must be inside the export directory/],
      [{ video: "render.mp4", tracks: [{ path: "nope.wav" }] }, /No file at .*nope\.wav \(`tracks\[0\]\.path`\)/],
      [{ video: "render.mp4", tracks: [{ path: "hit.wav" }], saveTo: "out.webm" }, /`saveTo` ends in \.webm, but the video is \.mp4/],
      [{ video: "render.mp4", tracks: [{ path: "hit.wav" }], saveTo: "render.mp4" }, /`saveTo` names one of the inputs/],
      [{ video: "notes.txt", tracks: [{ path: "hit.wav" }] }, /`video` ends in \.txt/],
    ] as const) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0]!.text, JSON.stringify(args)).toMatch(pattern);
      expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    }
    expect(s.calls).toEqual([]);
    expect((await call({ video: "render.mp4", tracks: [{ path: "notes.txt" }] })).content[0]!.text).toMatch(/ffprobe cannot read an input/);
  });

  it("without ffprobe or ffmpeg: UNSUPPORTED", async () => {
    s.set({ missing: "ffprobe" });
    expect((await call({ video: "render.mp4", tracks: [{ path: "hit.wav" }] })).content[0]!.text).toMatch(/^UNSUPPORTED: ffprobe is not on PATH/);
    s.set({ missing: "ffmpeg" });
    expect((await call({ video: "render.mp4", tracks: [{ path: "hit.wav" }] })).content[0]!.text).toMatch(/^UNSUPPORTED: ffmpeg is not on PATH/);
  });
});

describe("placing and mixing, pure", () => {
  it("an offset into the file, a durationS longer than the file, fades longer than the track", () => {
    const { placed, warnings } = placeTracks(10, [
      { path: "a", fileS: 20, offset: 4, durationS: 3, start: 1, fadeInS: 2, fadeOutS: 2 },
      { path: "b", fileS: 2, durationS: 5, start: 6 },
      { path: "c", fileS: 2, offset: 3 },
    ]);
    expect(placed.map((p) => [p.input, p.start, p.offset, p.durationS, p.fadeInS, p.fadeOutS, p.endS])).toEqual([
      [1, 1, 4, 3, 1.5, 1.5, 4],
      [2, 6, 0, 2, 0, 0, 8],
    ]);
    expect(warnings).toEqual([
      "tracks[0]'s fades (2 s in, 2 s out) are longer than the 3 s it plays: shortened to 1.5 s and 1.5 s.",
      "tracks[1] asks for 5 s but the file has 2 s after offset 0 s: it ends early, at 8 s.",
      "tracks[2] has no audio after offset 3 s (the file is 2 s): left out.",
      "The audio ends at 8 s, 2 s before the picture; the rest is silent.",
    ]);
    expect(mixGraph(placed.slice(0, 1), 10)).toBe(
      "[1:a:0]atrim=start=4:duration=3,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=1.5,afade=t=out:st=1.5:d=1.5,adelay=delays=48000S:all=1[a0];[a0]amix=inputs=1:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=480000,atrim=end_sample=480000[aout]",
    );
    expect(muxArgs({ video: "v.mp4", tracks: ["a"], graph: "g", out: "o.mp4", container: "mp4" })).toContain("+faststart");
  });

  it("reads ebur128's summary and loudnorm's JSON", () => {
    expect(parseEbur128(`noise\n${SUMMARY("-16.5", "-1.2")}`)).toEqual({ integratedLufs: -16.5, lra: 3.2, truePeakDbtp: -1.2 });
    expect(parseEbur128(SUMMARY("-inf", "-inf"))).toEqual({ integratedLufs: null, lra: 3.2, truePeakDbtp: null });
    expect(parseEbur128("no summary")).toEqual({ integratedLufs: null, lra: null, truePeakDbtp: null });
    expect(parseLoudnorm(LOUDNORM_JSON)).toEqual({ input_i: -21.3, input_tp: -4.1, input_lra: 3.4, input_thresh: -31.6, target_offset: 0.02 });
    expect(parseLoudnorm("nothing")).toBeNull();
  });
});

describe("figma_analyze_audio with ffmpeg stubbed", () => {
  let s: Setup;
  const call = (args: Record<string, unknown>) => s.client.callTool({ name: "figma_analyze_audio", arguments: args }) as Promise<Answer>;
  beforeEach(async () => (s = await setup()));
  afterEach(async () => s.client.close());

  it("decodes mono 11,025 Hz PCM through a pipe, measures with ebur128, and returns tempo, beats and level", async () => {
    const r = await call({ path: "music track.mp3" });
    expect(r.isError).toBeFalsy();
    expect(s.spawned[0]!.args).toEqual(["-v", "error", "-i", join(s.dir, "music track.mp3"), "-map", "0:a:0", "-t", "600", "-ac", "1", "-ar", "11025", "-f", "s16le", "-acodec", "pcm_s16le", "-"]);
    expect(s.calls.find((c) => c.args.includes("ebur128=peak=true"))!.args).toEqual(["-hide_banner", "-nostats", "-v", "info", "-i", join(s.dir, "music track.mp3"), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const res = json(r);
    expect(res).toMatchObject({ durationS: 30, sampleRate: 44100, channels: 2, codec: "mp3", beatsPerBar: 4, loudness: { integratedLufs: -14.1 } });
    expect(Math.abs(res.tempo.bpm - 120)).toBeLessThan(0.3);
    expect(res.tempo.confidence).toBeGreaterThan(0.8);
    expect(res.framesPerBeat["30"]).toBeCloseTo(15, 0);
    expect(Math.abs(res.beatTimes[0] - 0.25)).toBeLessThan(0.01);
    expect(res.next).toMatch(/figma_check_motion \{ beatTimes \}/);
  });

  it("refuses a file that is not there, a range too narrow, and answers UNSUPPORTED without ffmpeg", async () => {
    expect((await call({ path: "nope.mp3" })).content[0]!.text).toMatch(/No file at/);
    expect((await call({ path: "hit.wav", minBpm: 100, maxBpm: 110 })).content[0]!.text).toMatch(/`maxBpm` \(110\) must be at least 1\.25 × `minBpm` \(100\)/);
    s.set({ missing: "ffmpeg" });
    expect((await call({ path: "hit.wav" })).content[0]!.text).toMatch(/^UNSUPPORTED: ffmpeg is not on PATH/);
  });
});

describe("the programs BRIDGE_FFMPEG and BRIDGE_FFPROBE name", () => {
  const media: MediaTools = { ffmpeg: "/opt/ff/bin/ffmpeg", ffprobe: "/opt/ff/bin/ffprobe" };
  let s: Setup;
  const call = (name: string, args: Record<string, unknown>) => s.client.callTool({ name, arguments: args }) as Promise<Answer>;
  beforeEach(async () => (s = await setup(media)));
  afterEach(async () => s.client.close());

  it("are the ones figma_analyze_audio and figma_add_audio run, never the names on PATH", async () => {
    expect((await call("figma_analyze_audio", { path: "music track.mp3" })).isError).toBeFalsy();
    expect((await call("figma_add_audio", { video: "render.mp4", tracks: [{ path: "hit.wav" }], loudness: -14 })).isError).toBeFalsy();
    expect(s.spawned.map((c) => c.file)).toEqual([media.ffmpeg]);
    expect(new Set(s.calls.map((c) => c.file))).toEqual(new Set([media.ffmpeg, media.ffprobe]));
  });

  it("a program that cannot be started is named, and the hint points at the variables", async () => {
    s.set({ missing: "ffprobe" });
    const r = await call("figma_analyze_audio", { path: "hit.wav" });
    expect(r.content[0]!.text).toMatch(/^UNSUPPORTED: ffprobe could not be started \(\/opt\/ff\/bin\/ffprobe\), so the audio cannot be read or written\./);
    expect(r.structuredContent?.hint).toMatch(/^BRIDGE_FFMPEG \/ BRIDGE_FFPROBE name .* figma_generate_audio needs neither\.$/);
    s.set({ missing: "ffmpeg" });
    expect((await call("figma_add_audio", { video: "render.mp4", tracks: [{ path: "hit.wav" }] })).content[0]!.text).toMatch(/^UNSUPPORTED: ffmpeg could not be started \(\/opt\/ff\/bin\/ffmpeg\)/);
  });
});

describe("figma_generate_audio", () => {
  let s: Setup;
  const call = (args: Record<string, unknown>) => s.client.callTool({ name: "figma_generate_audio", arguments: args }) as Promise<Answer>;
  beforeEach(async () => (s = await setup()));
  afterEach(async () => s.client.close());

  it("writes a 48 kHz stereo WAV inside the roots, with no ffmpeg and no Figma call", async () => {
    const r = await call({ durationS: 3, seed: 5, bed: { style: "ambient", bpm: 90, key: "E minor" }, cues: [{ t: 1, type: "swell", durationS: 1 }], saveTo: "sfx/bed" });
    expect(r.isError).toBeFalsy();
    const res = json(r);
    expect(res.path).toBe(join(s.dir, "sfx", "bed.wav"));
    const wav = decodeWav(readFileSync(res.path));
    expect([wav.sampleRate, wav.channels.length, wav.bitsPerSample, wav.channels[0]!.length]).toEqual([48000, 2, 16, 144000]);
    expect(res).toMatchObject({ durationS: 3, sampleRate: 48000, channels: 2, bitsPerSample: 16, seed: 5, bed: { style: "ambient", key: "E minor", bpm: 90 }, mix: "effects -6 dB under the bed" });
    expect(res.bed.events).toBeUndefined();
    expect(res.loudness.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(s.calls).toEqual([]);
    expect(s.forwarded).toEqual([]);
  });

  it("derives cues from the frame's keys through check_motion's op, and returns them to edit", async () => {
    const r = await call({ durationS: 14.4, nodeId: "fixture-frame", fps: 30, cuts: [12.5], cues: [{ t: 13, type: "riser", durationS: 1.4 }] });
    expect(r.isError).toBeFalsy();
    expect(s.forwarded).toEqual([{ op: "check_motion", params: { nodeId: "fixture-frame" } }]);
    const res = json(r);
    expect(res.derivedFrom).toMatchObject({ fps: 30, counts: { hit: expect.any(Number), whoosh: expect.any(Number), tick: expect.any(Number) } });
    expect(res.derivedCues.length).toBeGreaterThan(10);
    expect(res.derivedCues.find((c: { note: string }) => /scene cut: "S2 · Ash Vase" on f109/.test(c.note))).toMatchObject({ t: 3.633, type: "hit" });
    // The used list: the derived cues, the declared cut's hit and the explicit riser.
    expect(res.cues.length).toBe(res.derivedCues.length + 2);
    expect(res.cues.some((c: { note?: string }) => c.note === "declared cut at 12.5 s")).toBe(true);
    // The derived list goes back in as `cues`, unchanged, and makes the same file.
    const again = await call({ durationS: 14.4, cuts: [12.5], cues: [{ t: 13, type: "riser", durationS: 1.4 }, ...res.derivedCues] });
    expect(again.isError).toBeFalsy();
    expect(readFileSync(json(again).path).equals(readFileSync(res.path))).toBe(true);
  });

  it("refuses an empty request, a bad key, a backwards section, a non-WAV saveTo and a path outside the roots", async () => {
    for (const [args, pattern] of [
      [{ durationS: 2 }, /Nothing to make/],
      [{ durationS: 2, bed: { style: "upbeat", bpm: 120, key: "H minor" } }, /`bed\.key` "H minor" is not a key/],
      [{ durationS: 4, bed: { style: "upbeat", bpm: 120, sections: [{ from: 2, to: 1, energy: 0.5 }] } }, /`bed\.sections\[0\]\.to` must be after/],
      [{ durationS: 2, cues: [{ t: 0, type: "pop" }], saveTo: "pop.mp3" }, /`saveTo` ends in \.mp3; figma_generate_audio writes \.wav/],
      [{ durationS: 2, cues: [{ t: 0, type: "pop" }], saveTo: "../../pop.wav" }, /`saveTo` must be inside the export directory/],
      [{ durationS: 2, cues: [{ t: 0, type: "boom" }] }, /type/],
      [{ durationS: 2, cues: [{ t: 0, type: "pop", gain: 2 }] }, /gain/],
    ] as const) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0]!.text, JSON.stringify(args)).toMatch(pattern);
    }
    expect(s.forwarded).toEqual([]);
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

describe.skipIf(!hasFfmpeg)("the audio tools on real files", () => {
  it("generates a bed, reads its tempo back, muxes it onto a render with -c:v copy at the asked loudness, exactly the video's length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-audio-real-"));
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: {} });
    registerAudio(server, {} as Bridge, { exportDir: dir, exportRoots: [] }, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "audio-real", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const video = join(dir, "render clip.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=128x72:r=30:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { windowsHide: true });
      const gen = (await client.callTool({ name: "figma_generate_audio", arguments: { durationS: 8, seed: 3, bed: { style: "minimal-tech", bpm: 120, beatOffset: 0.25, intensity: 0.6 }, saveTo: "bed.wav" } })) as Answer;
      expect(gen.isError).toBeFalsy();
      const sfx = (await client.callTool({ name: "figma_generate_audio", arguments: { durationS: 1, cues: [{ t: 0, type: "hit" }], saveTo: "hit.wav" } })) as Answer;
      expect(sfx.isError).toBeFalsy();

      const analysed = json((await client.callTool({ name: "figma_analyze_audio", arguments: { path: "bed.wav" } })) as Answer);
      expect(Math.abs(analysed.tempo.bpm - 120)).toBeLessThan(0.5);
      expect(analysed).toMatchObject({ sampleRate: 48000, channels: 2 });
      expect(Math.abs(analysed.loudness.integratedLufs - json(gen).loudness.integratedLufs)).toBeLessThan(0.5);

      const r = (await client.callTool({ name: "figma_add_audio", arguments: { video, tracks: [{ path: "bed.wav", fadeOutS: 1 }, { path: "hit.wav", start: 2, volumeDb: -6 }], loudness: -16 } })) as Answer;
      expect(r.isError, r.content[0]!.text).toBeFalsy();
      const res = json(r);
      expect(existsSync(res.path)).toBe(true);
      expect(res.warnings).toEqual(["tracks[0] runs 2 s past the video's end (6 s): trimmed there, and its fade-out moved to the new end."]);
      expect(Math.abs(res.loudness.integratedLufs - -16)).toBeLessThanOrEqual(0.6);
      expect(res.loudness.truePeakDbtp).toBeLessThanOrEqual(-0.9);
      // The picture is the same stream, frame for frame; the file is the video's length.
      const frames = (p: string) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=codec_name,nb_read_packets", "-of", "csv=p=0", p], { encoding: "utf8" }).stdout.trim();
      expect(frames(res.path)).toBe(frames(video));
      expect(Math.abs(res.durationS - 6)).toBeLessThanOrEqual(1 / 30);
      const astream = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "csv=p=0", res.path], { encoding: "utf8" }).stdout.trim();
      expect(astream).toBe("aac,48000,2");
    } finally {
      await client.close();
    }
  });
});
