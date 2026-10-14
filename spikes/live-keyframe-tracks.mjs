// Live probe: why figma_set_keyframes kept only the last of several tracks
// (2026-10-09) [C-201], and what puts a frame into that state [C-200]. One run
// tells apart the candidates [C-202]:
//
//   H1a  replacements inside one synchronous run coalesce, last wins
//        -> cell sameYield (a host turn between applies) is all-new, sameSync is not
//   H1b  the node handle carries a stale base -> freshHandle / realHandle all-new
//   H2   the first write forks the timeline -> the timeline id changes inside sameSync
//   H3   only the echo is stale -> sameSync echo is old but the later readback is new
//   plus whether keeping the track `id`, writing the whole record (the
//   readonly-or-not question, [C-185]), or adding new fields (instead of
//   replacing) accumulates; whether removals coalesce the same way; whether a
//   key rewrites the layer's base value [C-204]; and how many document ids one
//   replacement run consumes (a copy of the subtree would consume hundreds).
//
// The `tool` and `toolRemove` cells are the regression gate for the fix
// [C-250]: they must be all-new / all-removed in every phase.
//
// The triggers tried, in order, until one reproduces the loss: a PNG export of
// the animated frame, a new layer inside it, a video export of it, and last you
// pressing Play on the probe frame's timeline in Figma (up to WAIT_S seconds).
//
// Everything lives in one top-level frame "figma-mcp keyframe probe (delete me)"
// at x 52000, y 24000, created here and deleted at the end (KEEP=1 keeps it).
// Keep the Figma window restored, not minimized: a minimized window stalled a
// video export for ~40 minutes once [C-198].
//
// Run:  npm run build, re-run the plugin in Figma, then
//       node spikes/live-keyframe-tracks.mjs              (KEEP=1 to leave the sandbox, WAIT_S=300)
//       MINIMIZE=1 node spikes/live-keyframe-tracks.mjs   (adds the manual minimized-window check)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const MINIMIZE = process.env.MINIMIZE === "1";
const WAIT_S = Number(process.env.WAIT_S ?? 300);
const OUT = path.join(HERE, "results", "live-keyframe-tracks.json");
const NAME = "figma-mcp keyframe probe (delete me)";
const FX = 52000;
const FY = 24000;

const REPL = ["OPACITY", "TRANSLATION_X", "ROTATION"]; // every pool layer starts with these tracks
const ADDS = ["CORNER_RADIUS", "TRANSLATION_Y", "SCALE_X"]; // fields no pool layer has yet
const GONE = ["OPACITY", "TRANSLATION_X"]; // what the removal cells take away; ROTATION stays
const BASE = { OPACITY: 1, TRANSLATION_X: 0, ROTATION: 0, CORNER_RADIUS: 0, TRANSLATION_Y: 0, SCALE_X: 1 };
const OLD = { OPACITY: 0.5, TRANSLATION_X: 10, ROTATION: 5 };
const NEW = { OPACITY: 0.25, TRANSLATION_X: 77, ROTATION: 33, CORNER_RADIUS: 12, TRANSLATION_Y: 21, SCALE_X: 1.5 };
const CELLS = ["sameSync", "sameYield", "freshHandle", "realHandle", "keepIds", "setter", "adds", "tool", "removeSync", "toolRemove"];
const REMOVALS = new Set(["removeSync", "toolRemove"]);
const TRIGGERS = ["png", "layer", "video", "play"];
const POOL = CELLS.length * 2 + TRIGGERS.length;

const report = { startedAt: new Date().toISOString(), phases: [], triggers: [] };
const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tools = new Set((await mcp.list()).map((t) => t.name));
if (!tools.has("figma_eval")) {
  console.error("figma_eval is not registered (BRIDGE_ALLOW_EVAL); this probe needs it.");
  process.exit(2);
}
const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
if (!sess) {
  console.error("No Figma session: run the plugin in Figma first.");
  process.exit(2);
}
if (sess.build?.restart) {
  console.error(`The connected build is stale (restart: ${sess.build.restart}): ${st.data?.hint ?? ""}`);
  process.exit(2);
}
console.log(`file "${sess.file?.name}", build ${JSON.stringify(sess.build)}, role ${st.data?.bridge?.role}`);
report.build = sess.build;

// ── eval plumbing ───────────────────────────────────────────────────────────
const PRE = `
const F = (name) => ({ type: "PROPERTY", name });
const track = (from, to) => ({ keyframes: [
  { timelinePosition: 0, value: { type: "FLOAT", value: from } },
  { timelinePosition: 0.8, value: { type: "FLOAT", value: to }, easing: { type: "EASE_OUT" } },
] });
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastOf = (n, f) => { const t = n.manualKeyframeTracks[f]; const k = t && t.keyframes; return k && k.length ? k[k.length - 1].value.value : null; };
const tl = (n) => { try { return (n.timelines || []).map((t) => t.id + "/" + Math.round(t.duration * 1000) / 1000).join(","); } catch (e) { return "ERR " + e.message; } };
const counter = () => { const r = figma.createRectangle(); const id = r.id; r.remove(); return id; };
const REPL = ${JSON.stringify(REPL)}, ADDS = ${JSON.stringify(ADDS)}, GONE = ${JSON.stringify(GONE)};
const BASE = ${JSON.stringify(BASE)}, OLD = ${JSON.stringify(OLD)}, NEW = ${JSON.stringify(NEW)};
`;

async function evalJs(code, timeoutMs = 60_000) {
  const r = await mcp.call("figma_eval", { code: PRE + code, timeoutMs }, { timeoutMs: timeoutMs + 30_000 });
  if (!r.ok) throw new Error(`figma_eval: ${r.text.slice(0, 300)}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

/** A video export, collected again with the same arguments while it answers `rendering`. */
async function render(args, timeoutMs) {
  const t0 = Date.now();
  let r = await mcp.call("figma_export_video", args, { timeoutMs });
  while (r.ok && r.data?.status === "rendering" && Date.now() - t0 < timeoutMs) {
    await sleep(5000);
    r = await mcp.call("figma_export_video", args, { timeoutMs });
  }
  return r;
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-4;
function classify(v, f) {
  if (v === null || v === undefined) return "missing";
  if (near(v, NEW[f])) return "new";
  if (f in OLD && near(v, OLD[f])) return "old";
  return `other:${v}`;
}
/** "all-new", "last-only" (the loss seen on 2026-10-09), or the per-field pattern. */
function verdict(values, fields) {
  const c = fields.map((f) => classify(values[f], f));
  if (c.every((x) => x === "new")) return "all-new";
  if (c.slice(0, -1).every((x) => x === "old") && c[c.length - 1] === "new") return "last-only";
  return fields.map((f, i) => `${f}=${c[i]}`).join(" ");
}
/** "all-removed" when GONE are gone and ROTATION kept its old keys, else the per-field pattern. */
function removalVerdict(values) {
  const c = REPL.map((f) => classify(values[f], f));
  if (GONE.every((f) => c[REPL.indexOf(f)] === "missing") && c[REPL.indexOf("ROTATION")] === "old") return "all-removed";
  return REPL.map((f, i) => `${f}=${c[i]}`).join(" ");
}

// ── the cells: three replacements on one layer, each in its own manner ─────
const CELL_CODE = {
  sameSync: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const ids = [counter()]; const seq = [{ step: "before", tl: tl(n) }];
    for (const f of REPL) { n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); seq.push({ step: f, tl: tl(n), echo: REPL.map((g) => lastOf(n, g)) }); }
    ids.push(counter());
    return { handleId: n.id, seq, ids };`,
  sameYield: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const seq = [{ step: "before", tl: tl(n) }];
    for (const f of REPL) { n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); await tick(); seq.push({ step: f, tl: tl(n), echo: REPL.map((g) => lastOf(n, g)) }); }
    return { handleId: n.id, seq };`,
  freshHandle: (id) => `
    const seq = [];
    for (const f of REPL) { const h = await figma.getNodeByIdAsync(${JSON.stringify(id)}); h.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); seq.push({ step: f, tl: tl(h) }); }
    return { seq };`,
  realHandle: (id) => `
    const h = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const real = h.parent.children.find((c) => c.name === h.name);
    for (const f of REPL) real.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f]));
    return { handleId: h.id, realId: real.id, sameObject: real === h };`,
  keepIds: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); const errors = [];
    for (const f of REPL) {
      const ex = n.manualKeyframeTracks[f];
      try { n.applyManualKeyframeTrack(F(f), { id: ex.id, baseValue: ex.baseValue, keyframes: track(BASE[f], NEW[f]).keyframes }); }
      catch (e) { errors.push(f + ": " + e.message); }
    }
    return { errors };`,
  setter: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); let error = null;
    try { n.manualKeyframeTracks = Object.assign({}, n.manualKeyframeTracks, Object.fromEntries(REPL.map((f) => [f, track(BASE[f], NEW[f])]))); }
    catch (e) { error = e.message; }
    return { error };`,
  adds: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const before = { cornerRadius: n.cornerRadius, opacity: n.opacity };
    for (const f of ADDS) n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f]));
    return { before, after: { cornerRadius: n.cornerRadius, opacity: n.opacity }, echo: ADDS.map((g) => lastOf(n, g)) };`,
  removeSync: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    for (const f of GONE) n.removeManualKeyframeTrack(F(f));
    return { echo: Object.keys(n.manualKeyframeTracks) };`,
};

async function runCell(cell, id) {
  if (cell === "tool") {
    const r = await mcp.call("figma_set_keyframes", {
      nodeId: id,
      tracks: REPL.map((f) => ({ field: f, keyframes: [{ t: 0, value: String(BASE[f]) }, { t: 0.8, value: String(NEW[f]), easing: "EASE_OUT" }] })),
    });
    return r.ok
      ? { ok: true, timeline: r.data?.timeline, timelineNote: r.data?.timelineNote, note: r.data?.note, tracks: r.data?.tracks?.map((t) => ({ field: t.field, status: t.status, last: t.keyframes.at(-1)?.value })) }
      : { ok: false, error: r.text.slice(0, 600) };
  }
  if (cell === "toolRemove") {
    const r = await mcp.call("figma_remove_keyframes", { nodeId: id, fields: GONE });
    return r.ok ? { ok: true, removed: r.data?.removed, remaining: r.data?.remaining, note: r.data?.note } : { ok: false, error: r.text.slice(0, 600) };
  }
  try {
    return await evalJs(CELL_CODE[cell](id));
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
}

/** Read every cell's layer back in a later plugin request than the one that wrote it. */
async function readBack(map) {
  const raw = await evalJs(`
    const map = ${JSON.stringify(map)}; const out = {};
    for (const [cell, id] of Object.entries(map)) {
      const n = await figma.getNodeByIdAsync(id);
      out[cell] = { tl: tl(n), values: Object.fromEntries(REPL.concat(ADDS).map((f) => [f, lastOf(n, f)])) };
    }
    return out;`);
  const rows = {};
  for (const [cell, r] of Object.entries(raw)) {
    const v = REMOVALS.has(cell) ? removalVerdict(r.values) : verdict(r.values, cell === "adds" ? ADDS : REPL);
    rows[cell] = { tl: r.tl, verdict: v, values: r.values };
    // The adds cell must also leave the three existing tracks at their OLD keys.
    if (cell === "adds") rows[cell].kept = REPL.map((f) => `${f}=${classify(r.values[f], f)}`).join(" ");
  }
  return rows;
}

/** Are layers inside the frame listed under other ids than the ones they were created with? */
async function rekeyed(frameId, created) {
  return evalJs(`
    const fr = await figma.getNodeByIdAsync(${JSON.stringify(frameId)});
    const created = ${JSON.stringify(created)};
    const tree = Object.fromEntries(fr.children.map((c) => [c.name, c.id]));
    const rows = [];
    for (const [name, id] of Object.entries(created)) {
      const h = await figma.getNodeByIdAsync(id);
      rows.push({ name, created: id, handleId: h ? h.id : null, treeId: tree[name] ?? null });
    }
    let restId = null;
    try { restId = (await fr.exportAsync({ format: "JSON_REST_V1" })).document.id; } catch (e) { restId = "ERR " + e.message; }
    const first = await figma.getNodeByIdAsync(Object.values(created)[0]);
    let playhead = null;
    try { playhead = figma.motion ? (figma.motion.playheadPosition ?? "none") : "no figma.motion"; } catch (e) { playhead = "ERR " + e.message; }
    let top = null;
    try { const t = first.getTopLevelFrame(); top = t ? t.id : null; } catch (e) { top = "ERR " + e.message; }
    return { session: figma.currentUser ? figma.currentUser.sessionId : null, frameHandleId: fr.id, frameRestId: restId,
      childTimeline: tl(first), childTopLevelFrame: top, playhead, firstOpacity: first.opacity,
      rekeyed: rows.filter((r) => r.treeId !== r.created).length, of: rows.length,
      sample: rows.filter((r) => r.treeId !== r.created).slice(0, 3) };`);
}

function print(label, rows) {
  console.log(`\n-- ${label}`);
  for (const [cell, r] of Object.entries(rows)) console.log(`  ${cell.padEnd(12)} ${String(r.verdict).padEnd(40)} tl ${r.tl}${r.kept ? `  (existing tracks: ${r.kept})` : ""}`);
}

// ── sandbox ─────────────────────────────────────────────────────────────────
const built = await evalJs(`
  const fr = figma.createFrame(); fr.name = ${JSON.stringify(NAME)}; fr.x = ${FX}; fr.y = ${FY}; fr.resize(1240, 260);
  const ids = {};
  for (let i = 0; i < ${POOL}; i++) {
    const r = figma.createRectangle(); r.name = "P" + i; r.resize(40, 40);
    r.x = 20 + (i % 20) * 60; r.y = 20 + Math.floor(i / 20) * 60; fr.appendChild(r); ids[r.name] = r.id;
  }
  return { frame: fr.id, ids };`);
const FRAME = built.frame;
const ids = Object.values(built.ids);
report.sandbox = built;

try {
  // Seed the OLD tracks one apply per host turn, then verify in a later request and repair.
  await evalJs(`
    for (const id of ${JSON.stringify(ids)}) for (const f of REPL) {
      const n = await figma.getNodeByIdAsync(id); n.applyManualKeyframeTrack(F(f), track(BASE[f], OLD[f])); await tick();
    }
    const n0 = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const [t] = n0.timelines; if (t) n0.setTimelineDuration(t.id, 1);
    return true;`, 300_000).catch((err) => {
    if (/not a supported API/i.test(String(err.message))) console.log("Motion is not enabled for this account [C-115]; nothing to probe.");
    throw err;
  });
  const seeded = await evalJs(`
    const bad = [];
    for (const id of ${JSON.stringify(ids)}) for (const f of REPL) {
      let n = await figma.getNodeByIdAsync(id);
      for (let i = 0; i < 3 && lastOf(n, f) !== OLD[f]; i++) { n.applyManualKeyframeTrack(F(f), track(BASE[f], OLD[f])); await tick(); n = await figma.getNodeByIdAsync(id); }
      if (lastOf(n, f) !== OLD[f]) bad.push(id + " " + f);
    }
    return bad;`, 300_000);
  if (seeded.length) console.log(`  note: seeding did not stick on ${seeded.join(", ")}`);
  report.seedingMissed = seeded;

  let next = 0;
  const take = () => ids[next++];

  // ── phase A: a fresh frame ──
  const phase = async (label) => {
    const map = {};
    const notes = {};
    for (const cell of CELLS) {
      map[cell] = take();
      notes[cell] = await runCell(cell, map[cell]);
    }
    const rows = await readBack(map);
    print(label, rows);
    report.phases.push({ label, map, notes, rows, rekey: await rekeyed(FRAME, built.ids) });
    return rows;
  };
  await phase("A: fresh frame");

  // ── triggers, until one puts the frame into the losing state ──
  let reproduced = false;
  for (const trig of TRIGGERS) {
    const t0 = Date.now();
    let outcome = { ok: true, text: "" };
    if (trig === "png") outcome = await mcp.call("figma_export_node", { nodeId: FRAME, scale: 0.25 });
    if (trig === "layer") outcome = await mcp.call("figma_create_rectangle", { parentId: FRAME, name: "layer-trigger", x: 1200, y: 220, width: 10, height: 10, fill: "#000000" });
    if (trig === "video") {
      console.log("\n  rendering a 1 s video; keep the Figma window restored (not minimized) …");
      outcome = await render({ nodeId: FRAME, format: "MP4", fps: 12, quality: "LOW", width: 320 }, 600_000);
    }
    if (trig === "play") {
      // The last candidate is the timeline playing in Figma's own Motion UI [C-200].
      console.log(`\n  In Figma: press Play on the probe frame's timeline (Motion panel), then stop it. Checking every 5 s for ${WAIT_S}s …`);
      let rk = await rekeyed(FRAME, built.ids);
      while (rk.rekeyed === 0 && Date.now() - t0 < WAIT_S * 1000) {
        await sleep(5000);
        rk = await rekeyed(FRAME, built.ids);
      }
      outcome = { ok: rk.rekeyed > 0, text: rk.rekeyed > 0 ? "" : `no re-keyed layer within ${WAIT_S}s` };
    }
    const id = take();
    const note = await runCell("sameSync", id);
    const rows = await readBack({ sameSync: id });
    const rk = await rekeyed(FRAME, built.ids);
    const row = { trigger: trig, ok: outcome.ok, ms: Date.now() - t0, rekey: rk, sameSync: rows.sameSync, note };
    report.triggers.push(row);
    console.log(`\n-- trigger ${trig}: ${outcome.ok ? "ok" : String(outcome.text).slice(0, 120)} in ${row.ms} ms; re-keyed ${rk.rekeyed}/${rk.of}; frame REST id ${rk.frameRestId}; child timeline ${rk.childTimeline}; sameSync ${rows.sameSync.verdict}`);
    if (rows.sameSync.verdict !== "all-new") {
      reproduced = true;
      break;
    }
  }
  if (!reproduced) console.log("\n  none of the triggers reproduced the loss; phase B runs anyway, after them.");
  next = CELLS.length + TRIGGERS.length;
  const b = await phase(`B: after ${report.triggers.map((t) => t.trigger).join(" + ")}${reproduced ? " (loss reproduced)" : ""}`);

  // The regression gate for the fix: the tools land in both phases, whatever the raw cells do.
  const a = report.phases[0].rows;
  report.gate = {
    tool: [a.tool.verdict, b.tool.verdict],
    toolRemove: [a.toolRemove.verdict, b.toolRemove.verdict],
    pass: a.tool.verdict === "all-new" && b.tool.verdict === "all-new" && a.toolRemove.verdict === "all-removed" && b.toolRemove.verdict === "all-removed",
    reproduced,
  };
  console.log(`\n${report.gate.pass ? "PASS" : "FAIL"}: tool ${report.gate.tool.join(" / ")}, toolRemove ${report.gate.toolRemove.join(" / ")}${reproduced ? "" : " (the losing state was not reached)"}`);

  // ── optional: the minimized window ──
  if (MINIMIZE) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nMinimize the Figma window now, then press Enter here. ");
    const timers = await evalJs(`const d = []; let t = Date.now(); for (let i = 0; i < 10; i++) { await tick(); const n = Date.now(); d.push(n - t); t = n; } return d;`).catch((e) => String(e.message));
    const t0 = Date.now();
    const v = await render({ nodeId: FRAME, format: "MP4", fps: 12, quality: "LOW", width: 320 }, 120_000);
    const minimized = { timerGapsMs: timers, videoOk: v.ok && v.data?.status !== "rendering", videoMs: Date.now() - t0, videoText: v.ok ? v.data?.status : v.text.slice(0, 200) };
    await rl.question("Restore the Figma window now (it may stay behind other windows), then press Enter. ");
    const t1 = Date.now();
    await evalJs("return 1;", 600_000);
    minimized.queueFreeAfterRestoreMs = Date.now() - t1;
    rl.close();
    report.minimized = minimized;
    console.log(`\n-- minimized: timer gaps ${JSON.stringify(timers)}; video ${minimized.videoOk ? "finished" : "did not finish"} in ${minimized.videoMs} ms; plugin answered ${minimized.queueFreeAfterRestoreMs} ms after restore`);
  }
} finally {
  if (!KEEP) {
    // Only the frame this probe created: by its id, or — if that id stopped resolving — by its exact name and place.
    await evalJs(`
      const f = await figma.getNodeByIdAsync(${JSON.stringify(FRAME)});
      const mine = f ?? figma.currentPage.children.find((c) => c.name === ${JSON.stringify(NAME)} && c.x === ${FX} && c.y === ${FY});
      if (mine) mine.remove();
      return !!mine;`).catch((e) => console.log(`  cleanup: ${e.message}`));
  }
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nsaved ${path.relative(process.cwd(), OUT)}`);
  await mcp.close();
}
