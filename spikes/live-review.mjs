// Live check of figma_export_video's job mode and frame-exact stills, and of
// figma_review_video, on a real render. The unit tests run against an ffmpeg
// stub and a fake bridge; only Figma's own export settles what they assume:
//
//   [C-193] [C-195] A frame whose grey steps up 8 levels on every frame, keyed
//           with cut pairs [C-240]: the stills of frames 0, 14, 15 and 29 must
//           carry exactly those frames' levels (frame k = k / fps, sought a
//           quarter frame early).
//   [C-194] A 1 s timeline at 30 fps exports 31 frames; 15 s exports 451.
//   [C-197] [C-249] A 15 s 1080 × 1920 render through a client that gives up at
//           60 s: the first call answers `rendering` before the cut, and the
//           render is collected by its jobId. Then a call cut at 10 s by the
//           client itself: the render survives the cancel and is collected.
//   [C-198] Keep the Figma window restored (it may sit behind other windows)
//           while this runs: a minimized window stops video export. Figma
//           ends a render it has not finished in about 4 min ("Video export
//           timed out", TIMEOUT): the record keeps that error, and the frame
//           counts of a render that never arrived are skipped, not failed.
//
// It runs as a PROXY of the hub the user's MCP client started (mcp-client.mjs
// spawns node dist/server.js, which joins that hub): job mode lives in the
// server process that takes the call, so this run measures the current build
// whatever build the hub is. figma_review_video is measured once the
// integrated build registers it; until then those steps are recorded as
// skipped. Everything is built in two frames at an empty spot right of the
// page's content and deleted at the end unless KEEP=1. The record goes to
// spikes/results/live-review.json.
//
// Run:  npm run build, re-run the plugin in a Figma Design file, then
//       node spikes/live-review.mjs        (KEEP=1 to leave the frames)
//
// Exit 0: every expectation held. 1: one failed. 2: the run could not start.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-review.json");
const KEEP = process.env.KEEP === "1";
const FPS = 30;
const STEPS = 30;
const LEVEL = 8;
const POLL_LIMIT_MS = 15 * 60_000;

const startedAt = new Date().toISOString();
const records = [];
const made = [];
let session = null;

function record(probe, ok, value, extra = {}) {
  const rec = { probe, ok, ...(value !== undefined ? { value } : {}), ...extra };
  records.push(rec);
  const shown = JSON.stringify(value ?? null);
  console.log(`  ${ok === null ? "skip" : ok ? "ok  " : "FAIL"} ${probe.padEnd(58)} ${shown.length > 150 ? shown.slice(0, 150) + "…" : shown}`);
  return rec;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-review", startedAt, finishedAt: new Date().toISOString(), session, records }, null, 2) + "\n");
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const hex = (v) => "#" + Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").repeat(3);

/** Mean grey (0–255) of a PNG, through ffmpeg: the same reading figma_review_video's decode makes. */
function greyOf(pngBase64) {
  const out = execFileSync(
    "ffmpeg",
    ["-v", "error", "-f", "png_pipe", "-i", "-", "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { input: Buffer.from(pngBase64, "base64"), windowsHide: true },
  );
  return out[0];
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

// ── connect ─────────────────────────────────────────────────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Map((await mcp.list()).map((t) => [t.name, t]));
const quit = async (why, code = 2) => {
  console.error(why);
  record("start", false, why);
  save();
  await mcp.close();
  process.exit(code);
};
const exportVideo = tools.get("figma_export_video");
if (!exportVideo?.inputSchema?.properties?.jobId) await quit("figma_export_video has no `jobId`: dist/ predates job mode — run npm run build.");
if (!tools.has("figma_eval")) await quit("figma_eval is not registered on the spawned server (BRIDGE_TOOLSET?); the sandbox placement needs it.");
const hasReview = tools.has("figma_review_video");
if (!hasFfmpeg) console.log("  note: ffmpeg is not on PATH here — stills cannot be read back, and figma_review_video will answer UNSUPPORTED.");

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
if (!sess) await quit("No Figma session — run the plugin in a Figma Design file first.");
session = { file: sess.file?.name ?? null, editorType: sess.editorType ?? null, role: st.data?.bridge?.role ?? null };
if (sess.editorType && sess.editorType !== "figma") await quit(`The active file is ${sess.editorType}; video export is Design only. Open a Design file.`);
console.log(`role ${session.role}, file "${session.file}"`);

async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${r.text}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

/**
 * Render, then poll by jobId until the render is collected. `clientTimeoutMs`
 * is the cut a client makes on the first call; every poll is a 60 s client.
 */
async function render(args, { clientTimeoutMs = 60_000, collect = {} } = {}) {
  const t0 = Date.now();
  let r = await mcp.call("figma_export_video", args, { timeoutMs: clientTimeoutMs });
  const first = { ms: Date.now() - t0, ok: r.ok, status: r.data?.status ?? (r.ok ? "done" : "error"), ...(r.ok ? {} : { text: r.text.slice(0, 300) }) };
  const jobId = r.data?.jobId ?? args.jobId;
  let polls = 0;
  while ((!r.ok || r.data?.status === "rendering") && Date.now() - t0 < POLL_LIMIT_MS) {
    // A first call cut off by the client is not a failure of the render: collect it.
    if (!r.ok && polls > 0 && !/rendering/.test(r.text)) break;
    polls++;
    r = await mcp.call("figma_export_video", { jobId, wait: 40, ...collect }, { timeoutMs: 60_000 });
  }
  return { first, final: r, polls, totalMs: Date.now() - t0, jobId };
}

/** The final answer's error, kept in the record: without it a render Figma gave up on reads as `{}`. */
const failure = (run) => (run.final.ok ? {} : { error: run.final.text.slice(0, 300) });

/**
 * [C-194] is a count of a file: a render that never arrived measured nothing,
 * so the probe is skipped, not failed — Figma ending a render at its own time
 * limit [C-198] says nothing about how many frames a render holds.
 */
function countFrames(probe, data, want) {
  if (!data.path) return record(probe, null, "no file to count: the render did not arrive (see the probe before)");
  return record(probe, data.frameCount === want && data.expectedFrames === want, { frameCount: data.frameCount, expectedFrames: data.expectedFrames, note: data.note });
}

// ── sandbox, right of everything on the page ───────────────────────────────

const right = await evalJs("let r = 0; for (const n of figma.currentPage.children) r = Math.max(r, n.x + n.width); return r;");
const X = Math.ceil((Number(right) + 4000) / 1000) * 1000;
const Y = 0;
console.log(`sandbox at x ${X}, y ${Y}`);

try {
  // ── A: grey steps, frame-exact stills ──────────────────────────────────────
  console.log("\n-- A: frame-exact stills [C-193] [C-195]");
  const steps = await mcp.call("figma_create_frame", { name: "figma-mcp live-review steps (delete me)", x: X, y: Y, width: 64, height: 64, layout: "none", background: "#000000" });
  const stepsId = steps.data?.id;
  if (!stepsId) throw new Error(`could not create the steps frame: ${steps.text}`);
  made.push(stepsId);
  const grey = (await mcp.call("figma_create_rectangle", { parentId: stepsId, name: "Grey", x: 0, y: 0, width: 64, height: 64, fill: "#000000" })).data?.id;
  // Frame k shows LEVEL·k: a cut pair per step, LINEAR keys at (k − 0.75)/fps and (k − 0.15)/fps [C-240].
  const keys = [{ t: 0, value: hex(0), easing: "LINEAR" }];
  for (let k = 1; k < STEPS; k++) {
    keys.push({ t: round6((k - 0.75) / FPS), value: hex(LEVEL * (k - 1)), easing: "LINEAR" });
    keys.push({ t: round6((k - 0.15) / FPS), value: hex(LEVEL * k), easing: "LINEAR" });
  }
  const keyed = await mcp.call("figma_set_keyframes", { nodeId: grey, tracks: [{ field: "fill:0", keyframes: keys }], timelineDuration: 1 });
  if (!keyed.ok && /UNSUPPORTED/.test(keyed.text)) {
    record("motion on this account [C-115]", null, "UNSUPPORTED: no Motion flag; the run stops here");
    throw new Error("no Motion");
  }
  record("keyframes: 30 grey steps on fill:0", keyed.ok, keyed.ok ? { keys: keys.length, timeline: keyed.data?.timeline } : keyed.text.slice(0, 200));

  const ks = [0, 14, 15, 29];
  const a = await render(
    { nodeId: stepsId, format: "MP4", fps: FPS, saveTo: "live-review-steps.mp4", jobId: "live-review-steps", frameIndices: ks },
    { collect: { frameIndices: ks } },
  );
  const d = a.final.data ?? {};
  record("steps render collected", a.final.ok && !!d.path, { first: a.first, polls: a.polls, totalMs: a.totalMs, path: d.path, renderS: d.renderS, ...failure(a) });
  countFrames("[C-194] 1 s at 30 fps exports 31 frames", d, 31);
  if (hasFfmpeg && Array.isArray(d.frames)) {
    const levels = d.frames.map((f) => ({ frame: f.frame, grey: f.image ? greyOf(a.final.images[f.image - 1].data) : null, expected: LEVEL * f.frame, ...(f.error ? { error: f.error } : {}) }));
    // Neighbouring frames are 8 levels apart: within 3 of the asked level is that frame and no other.
    const exact = levels.every((l) => l.grey !== null && Math.abs(l.grey - l.expected) <= 3);
    record("[C-195] export stills carry their own frame's level", exact, levels);
  } else {
    record("[C-195] export stills carry their own frame's level", null, hasFfmpeg ? "no frames returned" : "ffmpeg missing here");
  }

  if (hasReview && d.path) {
    const rv = await mcp.call("figma_review_video", { path: d.path, stills: ks, expectFrames: 31, maxImages: 8 }, { timeoutMs: 120_000 });
    const o = rv.data ?? {};
    record("review_video reads the steps render", rv.ok, rv.ok ? { video: o.video, frameCountNote: o.frameCountNote, findings: (o.findings ?? []).map((f) => f.kind) } : rv.text.slice(0, 300));
    if (rv.ok && hasFfmpeg) {
      const levels = (o.stills ?? []).map((s) => ({ frame: s.frame, grey: s.image ? greyOf(rv.images[s.image - 1].data) : null, expected: LEVEL * s.frame }));
      record("[C-195] review stills carry their own frame's level", levels.length === ks.length && levels.every((l) => l.grey !== null && Math.abs(l.grey - l.expected) <= 3), levels);
      record("sheet written, frame numbers burned in [C-205]", !!o.sheet?.path && fs.existsSync(o.sheet.path), { path: o.sheet?.path, labelled: o.sheet?.labelled, every: o.sheet?.every });
    }
  } else {
    record("review_video on the steps render", null, hasReview ? "no file to review" : "figma_review_video not registered yet (integrated build needed)");
  }

  // ── B: a long render through a 60 s client ─────────────────────────────────
  console.log("\n-- B: job mode through a 60 s client [C-197] [C-249]");
  const long = await mcp.call("figma_create_frame", { name: "figma-mcp live-review long (delete me)", x: X + 200, y: Y, width: 1080, height: 1920, layout: "none", background: "#f4f1ea" });
  const longId = long.data?.id;
  if (!longId) throw new Error(`could not create the long frame: ${long.text}`);
  made.push(longId);
  const block = (await mcp.call("figma_create_rectangle", { parentId: longId, name: "Block", x: 80, y: 860, width: 200, height: 200, fill: "#1f2937" })).data?.id;
  const moved = await mcp.call("figma_set_keyframes", {
    nodeId: block,
    tracks: [
      { field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0" }, { t: 15, value: "720", easing: "cubic:0.45,0,0.55,1" }] },
      { field: "OPACITY", keyframes: [{ t: 0, value: "0.2" }, { t: 2, value: "1", easing: "EASE_OUT" }] },
    ],
    timelineDuration: 15,
  });
  record("keyframes: a 15 s move", moved.ok, moved.ok ? moved.data?.timeline : moved.text.slice(0, 200));

  const b = await render({ nodeId: longId, format: "MP4", fps: FPS, saveTo: "live-review-long.mp4", jobId: "live-review-long" });
  const bd = b.final.data ?? {};
  record("first call answers before the 60 s client gives up", b.first.ok && b.first.ms < 60_000, b.first);
  record("15 s 1080 × 1920 render collected by jobId", b.final.ok && !!bd.path, { polls: b.polls, totalMs: b.totalMs, renderS: bd.renderS, path: bd.path, ...failure(b) });
  countFrames("[C-194] 15 s at 30 fps exports 451 frames", bd, 451);

  // The C-197 failure itself: the client cuts the call at 10 s and sends a cancel.
  const c = await render({ nodeId: longId, format: "MP4", fps: 24, saveTo: "live-review-cut.mp4", jobId: "live-review-cut", wait: 40 }, { clientTimeoutMs: 10_000 });
  const cd = c.final.data ?? {};
  record("a call the client cut at 10 s does not lose the render", !c.first.ok && c.final.ok && !!cd.path, { first: c.first, polls: c.polls, totalMs: c.totalMs, path: cd.path, ...failure(c) });
  countFrames("[C-194] 15 s at 24 fps exports 361 frames", cd, 361);

  if (hasReview && bd.path) {
    const rv = await mcp.call(
      "figma_review_video",
      { path: bd.path, closeups: [{ startFrame: 0, frames: 16 }], stills: [0, 450], expectFrames: 451 },
      { timeoutMs: 300_000 },
    );
    const o = rv.data ?? {};
    record("review_video on the long render", rv.ok, rv.ok ? { video: o.video, summary: o.metrics?.summary, findings: (o.findings ?? []).map((f) => `${f.kind} ${f.frames.join("-")}`), note: o.note } : rv.text.slice(0, 300));
  } else {
    record("review_video on the long render", null, hasReview ? "no file to review" : "figma_review_video not registered yet");
  }
} catch (err) {
  if (String(err?.message ?? err) !== "no Motion") record("run", false, String(err?.message ?? err));
} finally {
  if (KEEP) {
    console.log(`\n  KEEP=1 — left ${made.join(", ")} in the file`);
  } else if (made.length) {
    const del = await mcp.call("figma_delete_nodes", { nodeIds: made });
    record("delete the sandbox frames", del.ok, made);
  }
  save();
}

const failed = records.filter((r) => r.ok === false);
console.log(`\n${records.length} records → ${path.relative(process.cwd(), OUT)}${failed.length ? `; ${failed.length} failed: ${JSON.stringify(failed.map((f) => f.probe))}` : ""}`);
await mcp.close();
process.exit(failed.length ? 1 : 0);
