// Does a Motion timeline playing in Figma read as a person's edit? On
// 2026-10-21 the trust layer listed "by person" changes on an animated frame's
// layers in timeline order, looping with the timeline, and figma_sign_off was
// refused STALE; reads meanwhile returned temporary ids (C-199). Before the
// trust layer can tell playback from an edit, this measures, while a person
// plays the timeline:
//
//   1. whether nodechange fires on the current page during playback, how
//      often, with which properties and which origin;
//   2. whether figma.motion.playheadPosition reads and advances inside the
//      plugin while the timeline plays, and reads still when it stops;
//   3. whether the events stop when playback stops;
//   4. whether the ids the events name still resolve once playback stopped
//      (temporary second ids would not);
//   5. what figma_get_changes attributed to a person meanwhile.
//
// The listener is installed through figma_eval, on for this process only
// (BRIDGE_ALLOW_EVAL, [C-129]); nothing in the document is changed.
//
//   node spikes/live-playback.mjs [--wait 300] [--max 60]
//
// Needs: npm run build; Figma desktop with the Figxel plugin running, on the
// page of an animated frame with its Motion timeline open. The script waits up
// to --wait seconds for the playhead to move, records until it has been still
// for 5 s (or --max seconds of playback), then writes
// spikes/results/live-playback.json.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const WAIT_S = arg("wait", 300);
const MAX_S = arg("max", 60);
const DURING_S = arg("during", 3);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mcp = await connect({ allowEval: true, env: { BRIDGE_PROCESS: "off" } });
const evalCode = async (code) => {
  const res = await mcp.client.callTool({ name: "figma_eval", arguments: { code, timeoutMs: 60_000 } }, undefined, { timeout: 120_000 });
  if (res.isError) throw new Error((res.content ?? []).map((b) => b.text).join("\n"));
  return res.structuredContent?.value ?? res.structuredContent ?? JSON.parse((res.content ?? [])[0]?.text ?? "null");
};

const INSTALL = `
const g = globalThis;
if (g.__playbackProbe) { figma.currentPage.off("nodechange", g.__playbackProbe.fn); clearInterval(g.__playbackProbe.timer); }
const playhead = () => (figma.motion ? figma.motion.playheadPosition : "no motion API");
const p = { started: Date.now(), events: [], ticks: [], dropped: 0 };
p.fn = (e) => {
  const at = Date.now() - p.started;
  const ph = playhead();
  for (const c of e.nodeChanges) {
    if (p.events.length >= 6000) { p.dropped++; continue; }
    p.events.push({ at, ph, type: c.type, origin: c.origin, id: c.id ?? (c.node && c.node.id),
      props: c.type === "PROPERTY_CHANGE" ? c.properties : undefined });
  }
};
figma.currentPage.on("nodechange", p.fn);
p.timer = setInterval(() => p.ticks.push({ at: Date.now() - p.started, ph: playhead() }), 250);
g.__playbackProbe = p;
return { page: figma.currentPage.name, playhead: playhead(), startedAt: p.started };`;

const POLL = `
const p = globalThis.__playbackProbe;
return { events: p.events.length, ticks: p.ticks.slice(-12) };`;

const READ = `
const p = globalThis.__playbackProbe;
figma.currentPage.off("nodechange", p.fn);
clearInterval(p.timer);
delete globalThis.__playbackProbe;
const ids = [...new Set(p.events.map((e) => e.id))];
const resolves = {};
for (const id of ids.slice(0, 400)) resolves[id] = !!(await figma.getNodeByIdAsync(id));
return { events: p.events, ticks: p.ticks, dropped: p.dropped, ids: ids.length, resolves, started: p.started, page: figma.currentPage.name };`;

// Playing: the playhead moved, or (the playhead may read undefined) a burst of change events came in.
let lastEvents = 0;
const moving = (ticks, events) => {
  const v = ticks.map((t) => t.ph).filter((x) => typeof x === "number");
  const burst = events - lastEvents > 5;
  lastEvents = events;
  return (v.length >= 2 && v[v.length - 1] !== v[v.length - 2]) || burst;
};

// --read: an earlier run's listener is still installed; read what it holds.
const readOnly = process.argv.includes("--read");
const status = await mcp.client.callTool({ name: "figma_status", arguments: {} });
log((status.content ?? [])[0]?.text?.split("\n").slice(0, 3).join("\n"));
const installed = readOnly ? null : await evalCode(INSTALL);
if (installed) {
  log(`Listening on page "${installed.page}". Playhead now: ${JSON.stringify(installed.playhead)}.`);
  log(`Press play on the Motion timeline in Figma (within ${WAIT_S} s), let it run 15-30 s, then stop it.`);
}

// --guard <nodeId>: read that layer, then rename it to its own name (a write that changes nothing)
// --during s into playback (default 3) and once it stopped: the stale-write guard's answer each time [C-404].
const gi = process.argv.indexOf("--guard");
const GUARD = gi > 0 ? process.argv[gi + 1] : null;
let guardName = null;
const guardWrite = async () => {
  const res = await mcp.client.callTool({ name: "figma_rename_node", arguments: { nodeId: GUARD, name: guardName } }, undefined, { timeout: 120_000 });
  const text = (res.content ?? []).map((b) => b.text).join("\n");
  return { ok: !res.isError, code: res.isError ? (/^([A-Z_]+):/.exec(text) ?? [])[1] ?? "error" : null, hint: res.structuredContent?.hint ?? (res.isError ? text.slice(0, 400) : null) };
};
const guarded = {};
if (installed && GUARD) {
  const n = await mcp.client.callTool({ name: "figma_get_node", arguments: { nodeId: GUARD, depth: 0 } });
  guardName = n.structuredContent?.node?.name ?? null;
  log(`Guard target ${GUARD} "${guardName}" read.`);
}

let phase = "waiting";
let playStart = 0;
let stillSince = 0;
const deadline = Date.now() + WAIT_S * 1000;
while (installed) {
  await sleep(1000);
  const { ticks, events } = await evalCode(POLL);
  const now = Date.now();
  if (phase === "waiting") {
    if (moving(ticks, events)) {
      phase = "playing";
      playStart = now;
      log(`Playback seen (${events} events so far). Recording...`);
    } else if (now > deadline) {
      log("The playhead never moved: is the timeline open and playing?");
      break;
    }
  } else if (moving(ticks, events)) {
    stillSince = 0;
    if (GUARD && !guarded.during && now - playStart > DURING_S * 1000) {
      guarded.during = await guardWrite();
      log(`Write during playback: ${JSON.stringify(guarded.during)}`);
    }
    if (now - playStart > MAX_S * 1000) { log("Max playback reached."); break; }
  } else {
    stillSince ||= now;
    if (now - stillSince > 5000) { log("Playback stopped. Reading..."); break; }
  }
}

if (installed && GUARD) {
  guarded.after = await guardWrite();
  log(`Write after playback: ${JSON.stringify(guarded.after)}`);
}
const raw = await evalCode(READ);
const changes = await mcp.client.callTool({ name: "figma_get_changes", arguments: { limit: 1 } });
const person = ((changes.structuredContent ?? {}).changes ?? []).filter((c) => c.by === "person" && c.at >= raw.started);

// While playing: the ticks whose playhead differs from the one before.
const playingAt = new Set();
raw.ticks.forEach((t, i) => {
  if (i > 0 && typeof t.ph === "number" && t.ph !== raw.ticks[i - 1].ph) playingAt.add(Math.floor(t.at / 250));
});
const during = raw.events.filter((e) => playingAt.has(Math.floor(e.at / 250)) || playingAt.has(Math.floor(e.at / 250) - 1));
const count = (list, key) => list.reduce((m, e) => {
  for (const k of [].concat(e[key] ?? "none")) m[k] = (m[k] ?? 0) + 1;
  return m;
}, {});
const unresolved = Object.entries(raw.resolves).filter(([, ok]) => !ok).map(([id]) => id);
const summary = {
  events: raw.events.length,
  dropped: raw.dropped,
  eventsWhilePlaying: during.length,
  eventsWhileStill: raw.events.length - during.length,
  types: count(raw.events, "type"),
  origins: count(raw.events, "origin"),
  properties: count(raw.events.filter((e) => e.props), "props"),
  playheadReads: count(raw.ticks.map((t) => ({ k: typeof t.ph })), "k"),
  playheadRange: (() => {
    const v = raw.ticks.map((t) => t.ph).filter((x) => typeof x === "number");
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  })(),
  distinctIds: raw.ids,
  idsNotResolvingAfter: unresolved.length,
  idPrefixes: count(raw.events.map((e) => ({ p: String(e.id).split(":")[0] })), "p"),
  personChangesMeanwhile: person.length,
};
log(JSON.stringify(summary, null, 2));

const record = {
  spike: "live-playback",
  date: new Date().toISOString().slice(0, 10),
  page: raw.page,
  ...(GUARD ? { guard: { nodeId: GUARD, ...guarded } } : {}),
  summary,
  unresolvedSample: unresolved.slice(0, 20),
  eventsSample: raw.events.slice(0, 60),
  ticksSample: raw.ticks.slice(0, 80),
};
mkdirSync(path.join(REPO, "spikes", "results"), { recursive: true });
writeFileSync(path.join(REPO, "spikes", "results", GUARD ? "live-playback-guard.json" : "live-playback.json"), JSON.stringify(record, null, 2) + "\n");
log(`Wrote spikes/results/${GUARD ? "live-playback-guard.json" : "live-playback.json"}`);
await mcp.close?.();
process.exit(0);
