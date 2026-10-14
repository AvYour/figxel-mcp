// Run figma_create_animatic on a real Design canvas and measure its render
// frame by frame: the document and the video, not the tool's own report.
//
// Only this run may turn create_animatic's Design cell in src/shared/editors.ts
// from "unmeasured" to "yes" — and only from what it writes to
// spikes/results/live-animatic.json. What it settles:
//   - six flat-grey panels, one per picture source (two drawn styleframes, two
//     `source` frames, two blank thumbnails), become six plates, and each grey
//     is on screen on exactly its panel's frames [in, out) at 24 fps and at
//     30 fps. That re-measures, at 24 fps, what was measured at 30 only: frame
//     k is the timeline at k / fps [C-193], an OPACITY cut pair switches on its
//     frame [C-240], and the export renders the end frame too [C-194], so a
//     timeline that ends just short of frame E − 1 holds exactly E frames;
//   - every plate's track reads back through figma_get_motion_context as keyed
//     (evaluated here, frame by frame), and plates 2–6 rest at opacity 0;
//   - a dissolve: the frames before and after it are exact, and so is its
//     length, 90 frames at 30 fps (the 2026-10-13 run, timed 89/30 s, kept as
//     2.966667 by Figma, rendered 91); the mixed frames are recorded against
//     both the sRGB mix the tool plans and the linear-light mix, for
//     information only [C-251].
//
// A frame's grey is read by video-greys.mjs: each frame whole, averaged in
// JS. Letting ffmpeg average it (scale=1:1:flags=area,format=gray) opens the
// MP4's TV range twice and moved panels 1 and 6 of the 2026-10-13 run 16 and
// 17 levels off, past TOLERANCE, which failed 24.exactFrames, 30.exactFrames
// and dissolve.exactAround on frames that were right.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub),
// with its own BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this
// process's calls only, so the unmeasured Design cell does not refuse the
// measuring run, and the user's client stays strict. Keep the Figma window
// restored while it renders: a minimized window stops video export [C-198].
//
// Needs one Design file open with the figma-mcp bridge plugin running (FILE=<name>
// picks one when several are open), Motion on the account [C-115], and ffmpeg
// with ffprobe on PATH to read the renders. Everything is built right of everything on the
// current page, 3000 px clear of it, and deleted at the end unless KEEP=1.
//
//   node spikes/live-animatic.mjs          build, render, measure, clean up
//   KEEP=1 node spikes/live-animatic.mjs   leave the boards and animatics to look at
//
// Exit 0: every expectation held. 1: one failed (see the FAIL lines and the
// JSON). 2: the run could not start (no file, an old build, no Motion, no ffmpeg).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";
import { greysOf, panelOfGrey as nearestPanel } from "./video-greys.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-animatic.json");
const KEEP = process.env.KEEP === "1";
const FILE = process.env.FILE;
const TOOLS = [
  "figma_create_storyboard", "figma_create_animatic", "figma_create_frame", "figma_set_fills", "figma_set_keyframes",
  "figma_get_motion_context", "figma_export_video", "figma_delete_nodes", "figma_eval",
];
const POLL_LIMIT_MS = 15 * 60_000;
const PLATE = 216; // plate width: 216 × 384 renders fast and is even on both sides
const GREYS = [32, 72, 112, 152, 192, 232]; // 40 levels apart: a frame's grey names its panel
const TOLERANCE = 15;

const records = [];
const made = []; // top-level ids our own calls returned, deleted at the end
const exercised = new Set();
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[^0-9]/g, "").slice(0, 14);
let session;

function record(probe, outcome, extra = {}) {
  const rec = { probe, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.pass === null ? "info" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${probe.padEnd(46)} ${shown && shown.length > 150 ? shown.slice(0, 150) + "…" : shown}`);
  return rec;
}

/** Record `outcome` with a pass computed from its value; a throwing predicate is a fail with its message. */
function expectThat(probe, outcome, expected, predicate, extra = {}) {
  let pass = false;
  let why;
  if (outcome.ok) {
    try {
      pass = predicate(outcome.value) === true;
    } catch (err) {
      why = String(err?.message ?? err);
    }
  }
  return record(probe, outcome, { expected, pass, ...(why ? { predicateError: why } : {}), ...extra });
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({ spike: "live-animatic", startedAt, finishedAt: new Date().toISOString(), file: session?.file?.name ?? null, session: session?.sessionId ?? null, build: session?.build ?? null, exercised: [...exercised].sort(), records }, null, 2) + "\n",
  );
}

const hex = (v) => "#" + Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").repeat(3);

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

/** The panel (1-based) whose grey a level is nearest, or 0 when none is within the tolerance. */
const panelOfGrey = (level, greys) => nearestPanel(level, greys, TOLERANCE);

/** sRGB value (0–255) to linear light (0–1), and back: the two blend spaces a dissolve could mix in [C-251]. */
const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));

/** A timeline that holds E frames whether Figma counts round(d · fps) + 1 or ceil(d · fps) + 1: past frame E − 1.1, short of E − 1 [C-194]. */
const endsJustShort = (duration, E, fps) => typeof duration === "number" && duration * fps < E - 1 && duration * fps > E - 1.1;

/** A LINEAR track's value at t, from keys as figma_get_motion_context reads them back. */
function valueAt(keys, t) {
  const ks = [...keys].sort((a, b) => a.t - b.t);
  if (t <= ks[0].t) return Number(ks[0].value);
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1];
    const b = ks[i];
    if (t <= b.t) return Number(a.value) + (Number(b.value) - Number(a.value)) * ((t - a.t) / (b.t - a.t));
  }
  return Number(ks[ks.length - 1].value);
}

// ── connect, and check the hub, the build and the file ──────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
async function quit(why) {
  console.error(why);
  record("start", { ok: false, error: why }, { expected: "the run starts", pass: false });
  save();
  await mcp.close();
  process.exit(2);
}
const tools = new Map((await mcp.list()).map((t) => [t.name, t]));
const missing = TOOLS.filter((t) => !tools.has(t));
if (missing.length) await quit(`The spawned server does not register ${missing.join(", ")}. Run npm run build after figma_create_animatic is wired (and BRIDGE_ALLOW_EVAL for figma_eval).`);
if (!tools.get("figma_export_video")?.inputSchema?.properties?.jobId) await quit("figma_export_video has no `jobId`: dist/ predates job mode — run npm run build.");
if (!hasFfmpeg) await quit("ffmpeg or ffprobe is not on PATH here: the renders cannot be read frame by frame.");
const st = await mcp.call("figma_status", {});
if (!st.ok || !st.data) await quit(`figma_status failed: ${st.text}`);
const sessions = st.data.sessions ?? [];
session = FILE ? sessions.find((s) => s.file?.name === FILE) : sessions.find((s) => s.active) ?? sessions[0];
if (!session) await quit(FILE ? `No connected file named "${FILE}".` : "No Figma session: open a Design file and run Plugins → Development → figma-mcp bridge.");
if (session.build?.restart === "client") await quit("Restart the MCP client so the hub runs the current build.");
if (session.build?.restart === "plugin") await quit(`Close the figma-mcp bridge plugin window in "${session.file?.name}" and run it again: it is running an older build than dist/.`);
if (session.editorType !== "figma") await quit(`"${session.file?.name}" is ${session.editorType}, not a Design file. This run measures the Design cell only.`);
console.log(`role ${st.data.bridge?.role}, file "${session.file?.name}", build ${JSON.stringify(session.build)}`);

/** A tool call in the chosen file, as Figma answered it. */
async function tool(name, args = {}, opts = {}) {
  exercised.add(name);
  const r = await mcp.call(name, { ...args, session: session.sessionId }, opts);
  return r.ok ? { ok: true, value: r.data ?? r.text, images: r.images } : { ok: false, error: r.text };
}

/** figma_eval in the chosen file: the code is an async function body. */
async function evalJs(code) {
  exercised.add("figma_eval");
  const r = await mcp.call("figma_eval", { code, session: session.sessionId });
  return r.ok ? { ok: true, value: r.data && "value" in r.data ? r.data.value : r.data } : { ok: false, error: r.text };
}

const keep = (ids) => {
  for (const id of ids) if (typeof id === "string" && !made.includes(id)) made.push(id);
};

/** Render, then poll by jobId until the render is collected (job mode [C-249]). */
async function render(args) {
  exercised.add("figma_export_video");
  const t0 = Date.now();
  let r = await mcp.call("figma_export_video", { ...args, session: session.sessionId }, { timeoutMs: 60_000 });
  let polls = 0;
  while ((!r.ok || r.data?.status === "rendering") && Date.now() - t0 < POLL_LIMIT_MS) {
    if (!r.ok && polls > 0 && !/rendering/.test(r.text)) break;
    polls++;
    r = await mcp.call("figma_export_video", { jobId: args.jobId, wait: 40, session: session.sessionId }, { timeoutMs: 60_000 });
  }
  return r.ok && r.data?.path ? { ok: true, value: { ...r.data, polls, totalMs: Date.now() - t0 } } : { ok: false, error: r.text };
}

// ── the probes ──────────────────────────────────────────────────────────────

/**
 * One board and its animatic at `fps`, every grey measured on every frame.
 * `durations` are the six panels' seconds; the board snaps them to frames.
 */
async function sixGreys(fps, durations, AREA) {
  console.log(`\n-- six grey panels at ${fps} fps`);
  // Two flat-grey frames to snapshot as `source` (panels 3 and 4).
  const sources = [];
  for (const i of [2, 3]) {
    const f = await tool("figma_create_frame", { name: `animatic probe source ${i + 1} (delete me)`, x: AREA.x, y: AREA.y + i * 500, width: PLATE, height: Math.round((PLATE * 16) / 9), layout: "none", background: hex(GREYS[i]) });
    if (!f.ok || typeof f.value?.id !== "string") throw new Error(`could not make source ${i + 1}: ${f.error ?? JSON.stringify(f.value)}`);
    keep([f.value.id]);
    sources.push(f.value.id);
  }
  const board = await tool("figma_create_storyboard", {
    title: `figma-mcp animatic probe ${fps} fps (delete me)`, aspect: "9:16", fps, x: AREA.x + 600, y: AREA.y, styleframeWidth: PLATE,
    panels: [
      { durationS: durations[0], title: "Styleframe A", styleframe: true },
      { durationS: durations[1], title: "Styleframe B", styleframe: true },
      { durationS: durations[2], title: "Source A", source: sources[0] },
      { durationS: durations[3], title: "Source B", source: sources[1] },
      { durationS: durations[4], title: "Blank A" },
      { durationS: durations[5], title: "Blank B" },
    ],
    idempotencyKey: `fmcp-anim-board-${fps}-${stamp}`,
  }, { timeoutMs: 300_000 });
  if (board.ok) keep(board.value?.created ?? []);
  if (!board.ok) throw new Error(`figma_create_storyboard failed: ${board.error}`);
  const b = board.value;
  record(`${fps}.board`, { ok: true, value: b.panels.map((p) => [p.startFrame, p.endFrame]) });
  // Grey the two styleframes and the two blank thumbnails.
  for (const [i, id] of [[0, b.panels[0].styleframeId], [1, b.panels[1].styleframeId], [4, b.panels[4].thumbId], [5, b.panels[5].thumbId]]) {
    const r = await tool("figma_set_fills", { nodeIds: [id], fills: [{ color: hex(GREYS[i]) }] });
    if (!r.ok) throw new Error(`could not grey panel ${i + 1}: ${r.error}`);
  }

  console.log(`\n-- figma_create_animatic at ${fps} fps`);
  const a = await tool("figma_create_animatic", { storyboardId: b.storyboardId, width: PLATE, burnIn: "none", x: AREA.x + 600, y: AREA.y + 2600, idempotencyKey: `fmcp-anim-${fps}-${stamp}` }, { timeoutMs: 300_000 });
  if (a.ok) keep(a.value?.created ?? []);
  const E = b.panels[5].endFrame;
  expectThat(`${fps}.animatic.result`, a, `verified; 6 plates on the board's frames; pictures styleframe ×2, source ×2, thumb ×2 (blank 5, 6); ${E} frames`,
    (v) => v.verified === true && v.expectedFrames === E && v.fps === fps
      && v.panels.length === 6 && v.panels.every((p, i) => p.inFrame === b.panels[i].startFrame && p.outFrame === b.panels[i].endFrame)
      && v.panels.map((p) => p.image).join() === "styleframe,styleframe,source,source,thumb,thumb"
      && JSON.stringify(v.blank) === "[5,6]" && v.created.length === 1,
    { tool: "figma_create_animatic", claim: ["C-240", "C-250"] });
  if (!a.ok) throw new Error(`figma_create_animatic failed: ${a.error}`);
  const anim = a.value;

  // The document: every plate's track as Figma reads it back, evaluated here frame by frame.
  const ctx = await tool("figma_get_motion_context", { nodeId: anim.animaticId });
  expectThat(`${fps}.readBack.tracks`, ctx, "each plate's OPACITY reads back as keyed: 1 on [in, out), 0 on every other frame", (v) => {
    const byId = new Map(v.nodes.map((n) => [n.nodeId, n]));
    return anim.panels.every((p) => {
      const keys = byId.get(p.layerId)?.tracks.find((t) => t.field === "OPACITY")?.keyframes;
      if (!keys?.length) return false;
      for (let f = 0; f < E; f++) {
        const want = p.inFrame <= f && f < p.outFrame ? 1 : 0;
        if (Math.abs(valueAt(keys, f / fps) - want) > 1e-6) return false;
      }
      return true;
    });
  }, { tool: "figma_get_motion_context", claim: "C-240" });
  const rest = await evalJs(`const root = await figma.getNodeByIdAsync(${JSON.stringify(anim.animaticId)});
return { parent: root.parent.type, name: root.name, plates: root.children.map((c) => c.opacity), timeline: root.timelines && root.timelines[0] ? { id: root.timelines[0].id, duration: root.timelines[0].duration } : null };`);
  expectThat(`${fps}.readBack.rest`, rest, `a top-level frame; plates rest at 1,0,0,0,0,0; the timeline (kept to the microsecond) ends within a tenth of a frame short of frame E − 1, ${((E - 1) / fps).toFixed(4)} s`,
    (v) => v.parent === "PAGE" && v.plates.join() === "1,0,0,0,0,0" && endsJustShort(v.timeline.duration, E, fps), { claim: ["C-194", "C-204"] });

  console.log(`\n-- render at ${fps} fps`);
  const video = await render({ nodeId: anim.animaticId, format: "MP4", fps, saveTo: `live-animatic-${fps}.mp4`, jobId: `live-animatic-${fps}-${stamp}` });
  record(`${fps}.render`, video.ok ? { ok: true, value: { path: video.value.path, frameCount: video.value.frameCount, expectedFrames: video.value.expectedFrames, renderS: video.value.renderS, polls: video.value.polls } } : video);
  if (!video.ok) return;
  const levels = greysOf(video.value.path);
  record(`${fps}.frameCount`, { ok: true, value: levels.length }, { expected: `exactly ${E} frames: a timeline just short of frame E − 1 renders its end frame too`, pass: levels.length === E, claim: "C-194" });
  const shown = levels.map((l) => panelOfGrey(l, GREYS));
  const want = Array.from({ length: E }, (_, f) => b.panels.findIndex((p) => p.startFrame <= f && f < p.endFrame) + 1);
  const wrong = want.map((w, f) => ({ frame: f, want: w, got: shown[f] ?? null, grey: levels[f] ?? null })).filter((x) => x.want !== x.got);
  record(`${fps}.exactFrames`, { ok: true, value: { frames: levels.length, wrong: wrong.slice(0, 20), greys: GREYS } }, {
    expected: "every frame shows the grey of the panel whose [startFrame, endFrame) holds it, and no other",
    pass: wrong.length === 0 && levels.length === E,
    claim: ["C-193", "C-240"],
  });
  // The boundaries, written out: the last frame of each panel and the first of the next.
  record(`${fps}.boundaries`, { ok: true, value: b.panels.slice(0, 5).map((p) => ({ frame: p.endFrame, before: levels[p.endFrame - 1], after: levels[p.endFrame] })) });
}

/** A dissolve: exact frames on both sides of it and an exact length, the mixed frames recorded against the planned mix. */
async function dissolve(AREA) {
  console.log("\n-- a dissolve at 30 fps");
  const greys = [40, 200, 120];
  const board = await tool("figma_create_storyboard", {
    title: "figma-mcp animatic dissolve probe (delete me)", aspect: "9:16", fps: 30, x: AREA.x + 600, y: AREA.y + 5200, styleframeWidth: PLATE,
    panels: [
      { durationS: 1, title: "Dark", transition: "Dissolve into the light" },
      { durationS: 1, title: "Light", transition: "Cut" },
      { durationS: 1, title: "Mid" },
    ],
    idempotencyKey: `fmcp-anim-dissolve-board-${stamp}`,
  }, { timeoutMs: 300_000 });
  if (board.ok) keep(board.value?.created ?? []);
  if (!board.ok) throw new Error(`figma_create_storyboard failed: ${board.error}`);
  for (const [i, p] of board.value.panels.entries()) {
    const r = await tool("figma_set_fills", { nodeIds: [p.thumbId], fills: [{ color: hex(greys[i]) }] });
    if (!r.ok) throw new Error(`could not grey panel ${i + 1}: ${r.error}`);
  }
  const a = await tool("figma_create_animatic", { storyboardId: board.value.storyboardId, width: PLATE, burnIn: "none", dissolveFrames: 4, x: AREA.x + 600, y: AREA.y + 7800, idempotencyKey: `fmcp-anim-dissolve-${stamp}` }, { timeoutMs: 300_000 });
  if (a.ok) keep(a.value?.created ?? []);
  expectThat("dissolve.result", a, "verified; one dissolve of 4 frames from panel 1 into panel 2; panel 1 on screen through frame 33",
    (v) => v.verified === true && JSON.stringify(v.dissolves) === JSON.stringify([{ from: 1, to: 2, frames: 4, asked: 4 }]) && v.panels[0].lastFrame === 33 && v.panels[1].dissolveIn === 4,
    { tool: "figma_create_animatic" });
  if (!a.ok) return;
  // Three 1 s panels: E = 90. The duration as Figma keeps it, unrounded: 89/30 s was kept as 2.966667 on 2026-10-13.
  const E = 90;
  const kept = await evalJs(`const root = await figma.getNodeByIdAsync(${JSON.stringify(a.value.animaticId)});
return root.timelines && root.timelines[0] ? root.timelines[0].duration : null;`);
  expectThat("dissolve.readBack.duration", kept, `the timeline (kept to the microsecond) ends within a tenth of a frame short of frame ${E - 1}, ${((E - 1) / 30).toFixed(4)} s`,
    (v) => endsJustShort(v, E, 30), { claim: "C-194" });
  const video = await render({ nodeId: a.value.animaticId, format: "MP4", fps: 30, saveTo: "live-animatic-dissolve.mp4", jobId: `live-animatic-dissolve-${stamp}` });
  record("dissolve.render", video.ok ? { ok: true, value: { path: video.value.path, frameCount: video.value.frameCount, expectedFrames: video.value.expectedFrames } } : video);
  if (!video.ok) return;
  const levels = greysOf(video.value.path);
  record("dissolve.frameCount", { ok: true, value: levels.length }, {
    expected: `exactly ${E} frames, the tool's expectedFrames ${a.value.expectedFrames} (2026-10-13: 91, from a timeline of exactly 89/30 s)`,
    pass: levels.length === E && a.value.expectedFrames === E,
    claim: "C-194",
  });
  const exact = [[29, 40], [34, 200], [59, 200], [60, 120]].map(([f, g]) => ({ frame: f, want: g, got: levels[f] }));
  record("dissolve.exactAround", { ok: true, value: exact }, { expected: "frame 29 dark, 34 light, 59 light, 60 mid (each within the tolerance)", pass: exact.every((x) => typeof x.got === "number" && Math.abs(x.got - x.want) <= TOLERANCE) });
  const mixed = [0, 1, 2, 3].map((m) => {
    const w = (m + 1) / 5;
    return { frame: 30 + m, planned: Math.round(40 + (200 - 40) * w), linear: toSrgb(toLinear(40) + (toLinear(200) - toLinear(40)) * w), got: levels[30 + m] };
  });
  const off = (key) => mixed.reduce((s, x) => s + Math.abs(x.got - x[key]), 0);
  record("dissolve.mix", { ok: true, value: { frames: mixed, nearer: off("planned") <= off("linear") ? "sRGB" : "linear light" } }, {
    expected: "for information [C-251]: the planned sRGB mix (m + 1) / 5 and the linear-light mix against what Figma rendered",
    pass: null,
    claim: "C-251",
  });
}

async function probes() {
  console.log("\n-- setup");
  const spot = await evalJs(`let right = 0, top = Infinity;
for (const n of figma.currentPage.children) { const b = n.absoluteBoundingBox; if (!b) continue; right = Math.max(right, b.x + b.width); top = Math.min(top, b.y); }
return { x: Math.round(right + 3000), y: Number.isFinite(top) ? Math.round(top) : 0 };`);
  record("setup.spot", spot);
  if (!spot.ok) throw new Error(`could not read the page: ${spot.error}`);
  const AREA = spot.value;

  // Motion must be on for this account [C-115]: one throwaway key on a scratch layer says so.
  const probeFrame = await tool("figma_create_frame", { name: "animatic probe motion check (delete me)", x: AREA.x, y: AREA.y - 400, width: 64, height: 64, layout: "none", background: "#000000" });
  if (!probeFrame.ok) throw new Error(`could not make the Motion check frame: ${probeFrame.error}`);
  keep([probeFrame.value.id]);
  const dot = await tool("figma_create_frame", { parentId: probeFrame.value.id, name: "dot", x: 0, y: 0, width: 8, height: 8, layout: "none", background: "#ffffff" });
  const keyed = dot.ok ? await tool("figma_set_keyframes", { nodeId: dot.value.id, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }, { t: 0.5, value: "0" }] }] }) : dot;
  if (!keyed.ok && /UNSUPPORTED/.test(keyed.error ?? "")) {
    record("motion on this account [C-115]", keyed, { expected: "Motion on", pass: false });
    throw new Error("no Motion on this account: nothing to measure");
  }

  // 24 fps: 12, 18, 24, 6, 15 (0.62 s snapped from 14.88) and 12 frames = 87.
  await sixGreys(24, [0.5, 0.75, 1, 0.25, 0.62, 0.5], AREA);
  // 30 fps: 15, 21, 30, 9, 19 (0.62 s snapped from 18.6) and 15 frames = 109.
  await sixGreys(30, [0.5, 0.7, 1, 0.3, 0.62, 0.5], { x: AREA.x + 2400, y: AREA.y });
  await dissolve({ x: AREA.x + 4800, y: AREA.y });

  // Refusals change nothing.
  console.log("\n-- refusals");
  const before = (await evalJs("return figma.currentPage.children.length;")).value;
  const notBoard = await tool("figma_create_animatic", { storyboardId: probeFrame.value.id });
  record("refusal.notAStoryboard", notBoard, { expected: "refused: not a storyboard", pass: !notBoard.ok && /is not a storyboard figma_create_storyboard made/.test(notBoard.error ?? "") });
  const after = (await evalJs("return figma.currentPage.children.length;")).value;
  record("refusal.unchanged", { ok: true, value: after - before }, { expected: "no new top-level node", pass: after === before });
}

async function cleanup() {
  console.log("\n-- cleanup");
  if (!made.length) return;
  // Only ids our own calls returned; deleting a board or an animatic removes everything in it.
  record("cleanup", await tool("figma_delete_nodes", { nodeIds: [...made].reverse() }));
}

// A crash still saves what was measured and removes what was made.
try {
  await probes();
} catch (err) {
  record("crash", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
}
if (KEEP) console.log(`\n  KEEP=1 — left ${made.join(", ")} in the file`);
else {
  try {
    await cleanup();
  } catch (err) {
    record("cleanup.crash", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
  }
}

save();
await mcp.close();
const failed = records.filter((r) => r.pass === false);
const passed = records.filter((r) => r.pass === true);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${records.length} probes → ${path.relative(process.cwd(), OUT)}`);
for (const f of failed) console.log(`  FAIL ${f.probe}: ${f.expected}${f.predicateError ? ` (${f.predicateError})` : ""}`);
process.exit(failed.length ? 1 : 0);
