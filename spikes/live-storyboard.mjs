// Run figma_create_storyboard and figma_import_image { renderNodeId } on a real
// Design canvas, and read every result back through figma_eval: the document,
// not the tools' own report.
//
// Only this run may turn create_storyboard's Design cell in
// src/shared/editors.ts from "unmeasured" to "yes" — and only from what it
// writes to spikes/results/live-storyboard.json. What it settles:
//   - a 12-panel 9:16 board builds in one call, its wrap grid wraps at 6
//     columns, and figma_check_layout returns ok: true on it (the tool's own
//     output must pass the house check);
//   - one `source` snapshot renders in the sandbox into its thumbnail
//     (exportAsync, then createImage, at most 4096 px a side [C-076]);
//   - the `readTime` [C-241] and `offBeat` lists name the panels planned to
//     trip them; the record is in shared plugin data [C-188];
//   - figma_import_image { renderNodeId } refreshes a thumbnail, and a render
//     over the cap is refused before anything changes.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub),
// with its own BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this
// process's calls only, so an unmeasured Design cell does not refuse the
// measuring run, and the user's client stays strict.
//
// Needs one Design file open with the figma-mcp bridge plugin running (FILE=<name>
// picks one when several are open). Everything is built right of everything on
// the current page, 3000 px clear of it, and deleted at the end unless KEEP=1.
//
//   node spikes/live-storyboard.mjs          build, check, clean up
//   KEEP=1 node spikes/live-storyboard.mjs   leave the board to look at
//
// Exit 0: every expectation held. 1: one failed (see the FAIL lines and the
// JSON). 2: the run could not start (no file, an old build, no figma_eval).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-storyboard.json");
const PNG = path.join(HERE, "results", "live-storyboard.png");
const KEEP = process.env.KEEP === "1";
const FILE = process.env.FILE;
const TOOLS = ["figma_create_storyboard", "figma_import_image", "figma_create_from_spec", "figma_check_layout", "figma_export_node", "figma_delete_nodes", "figma_eval"];

const records = [];
const made = []; // top-level ids our own calls returned, deleted at the end
const exercised = new Set();
const startedAt = new Date().toISOString();
let session;

function record(probe, outcome, extra = {}) {
  const rec = { probe, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${probe.padEnd(44)} ${shown && shown.length > 150 ? shown.slice(0, 150) + "…" : shown}`);
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

/** A refusal is the expected outcome: it passes when the call failed with text matching `pattern`. */
function expectRefusal(probe, outcome, pattern, extra = {}) {
  const pass = !outcome.ok && pattern.test(outcome.error ?? "");
  return record(probe, outcome, { expected: `refused: ${pattern}`, pass, ...extra });
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-storyboard", startedAt, finishedAt: new Date().toISOString(), file: session?.file?.name ?? null, session: session?.sessionId ?? null, build: session?.build ?? null, exercised: [...exercised].sort(), records }, null, 2) + "\n");
}

// ── connect, and check the hub, the build and the file ──────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const registered = new Set((await mcp.list()).map((t) => t.name));
const missing = TOOLS.filter((t) => !registered.has(t));
if (missing.length) {
  console.error(`The spawned server does not register ${missing.join(", ")}. Run npm run build after figma_create_storyboard is wired (and BRIDGE_ALLOW_EVAL for figma_eval).`);
  await mcp.close();
  process.exit(2);
}
const st = await mcp.call("figma_status", {});
if (!st.ok || !st.data) {
  console.error(`figma_status failed: ${st.text}`);
  await mcp.close();
  process.exit(2);
}
const sessions = st.data.sessions ?? [];
session = FILE ? sessions.find((s) => s.file?.name === FILE) : sessions.find((s) => s.active) ?? sessions[0];
if (!session) {
  console.error(FILE ? `No connected file named "${FILE}".` : "No Figma session: open a Design file and run Plugins → Development → figma-mcp bridge.");
  await mcp.close();
  process.exit(2);
}
if (session.build?.restart === "client") {
  console.error("Restart the MCP client so the hub runs the current build.");
  await mcp.close();
  process.exit(2);
}
if (session.build?.restart === "plugin") {
  console.error(`Close the figma-mcp bridge plugin window in "${session.file?.name}" and run it again: it is running an older build than dist/.`);
  await mcp.close();
  process.exit(2);
}
if (session.editorType !== "figma") {
  console.error(`"${session.file?.name}" is ${session.editorType}, not a Design file. This run measures the Design cell only.`);
  await mcp.close();
  process.exit(2);
}
console.log(`role ${st.data.bridge?.role}, file "${session.file?.name}", build ${JSON.stringify(session.build)}`);

/** A tool call in the chosen file, as Figma answered it. */
async function tool(name, args = {}, opts = {}) {
  exercised.add(name);
  const r = await mcp.call(name, { ...args, session: session.sessionId }, opts);
  return r.ok ? { ok: true, value: r.data ?? r.text, images: r.images } : { ok: false, error: r.text };
}

/** figma_eval in the chosen file: the code is an async function body. A null value is still a result. */
async function evalJs(code) {
  exercised.add("figma_eval");
  const r = await mcp.call("figma_eval", { code, session: session.sessionId });
  return r.ok ? { ok: true, value: r.data && "value" in r.data ? r.data.value : r.data } : { ok: false, error: r.text };
}

const keep = (ids) => {
  for (const id of ids) if (typeof id === "string" && !made.includes(id)) made.push(id);
};
const pageCount = async () => (await evalJs("return figma.currentPage.children.length;")).value;

// ── the probes ──────────────────────────────────────────────────────────────

async function probes() {
  console.log("\n-- setup");
  // An empty spot: 3000 px right of everything on the page, level with its top.
  const spot = await evalJs(`let right = 0, top = Infinity;
for (const n of figma.currentPage.children) { const b = n.absoluteBoundingBox; if (!b) continue; right = Math.max(right, b.x + b.width); top = Math.min(top, b.y); }
return { x: Math.round(right + 3000), y: Number.isFinite(top) ? Math.round(top) : 0 };`);
  record("setup.spot", spot);
  if (!spot.ok) throw new Error(`could not read the page: ${spot.error}`);
  const AREA = spot.value;

  // A styleframe to snapshot: a plain frame at delivery size with one big word.
  const source = await tool("figma_create_from_spec", {
    spec: JSON.stringify({
      type: "frame", name: "SF probe source (delete me)", x: AREA.x, y: AREA.y, width: 1080, height: 1920, background: "#1F3A5F", clipsContent: true,
      children: [{ type: "text", name: "Word", content: "Kiln", fontSize: 220, weight: "Bold", color: "#F5EFE6", x: 80, y: 760 }],
    }),
    idempotencyKey: `fmcp-sb-source-${startedAt}`,
  });
  record("setup.source", source);
  const sourceId = source.ok ? source.value?.rootId : undefined;
  if (typeof sourceId !== "string") throw new Error(`could not build the source styleframe: ${source.error ?? JSON.stringify(source.value)}`);
  keep([sourceId]);

  // ── the board ───────────────────────────────────────────────────────────

  console.log("\n-- figma_create_storyboard");
  const panels = [
    { durationS: 1.2, title: "Hook", beat: "hook", onScreen: "Fired today", action: "Lid lifts", styleframe: true },
    { durationS: 1.2, title: "Snapshot", source: sourceId, onScreen: "Kiln" },
    // 11 words need 3.3 s [C-241]: panel 3 is planned to trip readTime.
    { durationS: 1.2, title: "Too much copy", onScreen: "Hand thrown stoneware fired for three days in a wood kiln" },
    // 1.25 s is 37.5 frames: snapped to 38, so panel 5 starts 2 frames after its beat.
    { durationS: 1.25, title: "Off the beat", camera: "Push in" },
    ...Array.from({ length: 7 }, (_, i) => ({ durationS: 1.2, title: `Shot ${i + 5}`, ...(i === 1 ? { transition: "Whip pan right, motivated by the hand" } : {}), ...(i === 4 ? { audio: "Kiln door, low thud" } : {}) })),
    { durationS: 2.4, title: "End card", onScreen: "kiln.shop", notes: "Hold, then settle", styleframe: true },
  ];
  const before = await pageCount();
  const board = await tool("figma_create_storyboard", {
    title: "figma-mcp storyboard probe (delete me)", aspect: "9:16", fps: 30, bpm: 100, x: AREA.x + 1400, y: AREA.y, panels,
    idempotencyKey: `fmcp-sb-board-${startedAt}`,
  }, { timeoutMs: 300_000 });
  if (board.ok) keep(board.value?.created ?? []);
  const b = board.ok ? board.value : undefined;
  expectThat("storyboard.result", board, "12 panels; readTime names panel 3; offBeat names panel 5 (+2 frames); panel 2 filled from its source; 2 styleframes; 3 top-level nodes",
    (v) => v.panels.length === 12
      && v.readTime.some((r) => r.index === 3 && r.words === 11)
      && v.offBeat.some((o) => o.index === 5 && o.offsetFrames === 2)
      && v.panels[1].image === "source" && v.panels[1].hintId === undefined && typeof v.panels[0].hintId === "string"
      && typeof v.panels[0].styleframeId === "string" && typeof v.panels[11].styleframeId === "string"
      && v.created.length === 3 && v.created[0] === v.storyboardId,
    { tool: "figma_create_storyboard" });
  if (!b) throw new Error(`figma_create_storyboard failed: ${board.error}`);
  const grew = (await pageCount()) - before;
  record("storyboard.pageGrew", { ok: true, value: grew }, { expected: "3 new top-level nodes: the board and two styleframes", pass: grew === 3 });

  const back = await evalJs(`const safe = (f) => { try { return f(); } catch (e) { return { throws: String(e && e.message || e) }; } };
const get = (id) => figma.getNodeByIdAsync(id);
const board = await get(${JSON.stringify(b.storyboardId)});
const grid = board.children[1];
const cards = grid.children.map((c) => ({ id: c.id, name: c.name, x: c.x, y: c.y, width: c.width, height: c.height }));
const thumbs = [];
for (const p of ${JSON.stringify(b.panels.map((p) => ({ thumbId: p.thumbId, duration: p.captionIds.duration })))}) {
  const t = await get(p.thumbId), d = await get(p.duration);
  thumbs.push({ w: t.width, h: t.height, clips: t.clipsContent, layout: t.layoutMode, kids: t.children.length,
    fill: safe(() => t.fills.map((f) => f.type === "IMAGE" ? "IMAGE:" + f.imageHash : f.type)), duration: d.characters });
}
const sfs = [];
for (const id of ${JSON.stringify(b.panels.filter((p) => p.styleframeId).map((p) => p.styleframeId))}) { const s = await get(id); sfs.push({ name: s.name, x: s.x, y: s.y, w: s.width, h: s.height, clips: s.clipsContent, parent: s.parent.type }); }
const raw = board.getSharedPluginData("figmamcp", "storyboard");
return { name: board.name, parent: board.parent.type, x: board.x, y: board.y, width: board.width, height: board.height, layout: board.layoutMode,
  gridWrap: grid.layoutWrap, rows: [...new Set(cards.map((c) => Math.round(c.y)))].length, cards: cards.length, cardNames: cards.slice(0, 3).map((c) => c.name),
  thumbs, styleframes: sfs, record: safe(() => JSON.parse(raw)) };`);
  expectThat("storyboard.readBack", back, "a vertical board on the page at x/y, 1664 wide; 12 cards wrapping into 2 rows; thumbs 216×384 clipped, no layout; panel 2's thumb an IMAGE with no hint; durations captioned; record v1 with 12 panels",
    (v) => v.parent === "PAGE" && v.x === AREA.x + 1400 && v.y === AREA.y && v.layout === "VERTICAL" && Math.round(v.width) === 1664
      && v.gridWrap === "WRAP" && v.cards === 12 && v.rows === 2
      && v.thumbs.every((t) => t.w === 216 && t.h === 384 && t.clips === true && t.layout === "NONE")
      && v.thumbs[1].fill[0].startsWith("IMAGE:") && v.thumbs[1].kids === 0 && v.thumbs[0].kids === 1
      && v.thumbs[0].duration === "1.2 s · 36 f" && v.thumbs[3].duration === "1.267 s · 38 f"
      && v.record.v === 1 && v.record.panels.length === 12 && v.record.panels[0].thumbId === b.panels[0].thumbId,
    { claim: ["C-188", "C-095"] });
  expectThat("storyboard.styleframes", back, "two empty 1080×1920 clipped frames on the page, right of the board",
    (v) => v.styleframes.length === 2 && v.styleframes.every((s) => s.w === 1080 && s.h === 1920 && s.clips === true && s.parent === "PAGE" && s.x >= v.x + v.width && s.y === v.y));

  // The tool's own output must pass the house check.
  const check = await tool("figma_check_layout", { nodeId: b.storyboardId, limit: 50 });
  expectThat("storyboard.check_layout", check, "ok: true — no errors, no warnings", (v) => v.ok === true, { tool: "figma_check_layout" });

  // ── figma_import_image { renderNodeId } ─────────────────────────────────

  console.log("\n-- figma_import_image renderNodeId");
  const target = b.panels[5].thumbId;
  const refresh = await tool("figma_import_image", { renderNodeId: sourceId, nodeId: target });
  expectThat("import_image.render", refresh, "rendered 432 × 768 (2x a 216 px thumb) into the thumbnail's fill", (v) => v.applied === "fill" && v.rendered?.width === 432 && v.rendered?.height === 768,
    { tool: "figma_import_image", claim: "C-076" });
  const filled = await evalJs(`const t = await figma.getNodeByIdAsync(${JSON.stringify(target)}); return t.fills.map((f) => ({ type: f.type, hash: f.imageHash, scaleMode: f.scaleMode }));`);
  expectThat("import_image.render.readBack", filled, "one IMAGE fill with the hash the tool reported", (v) => v.length === 1 && v[0].type === "IMAGE" && v[0].hash === refresh.value?.imageHash);
  const before2 = await pageCount();
  expectRefusal("import_image.render.overCap", await tool("figma_import_image", { renderNodeId: sourceId, nodeId: target, renderWidth: 4096 }), /4096 × 7282 px picture/, { claim: "C-076" });
  const after2 = await pageCount();
  record("import_image.render.overCap.unchanged", { ok: true, value: after2 - before2 }, { expected: "nothing new on the page", pass: after2 === before2 });
  expectRefusal("import_image.twoSources", await tool("figma_import_image", { renderNodeId: sourceId, url: "https://example.com/a.png" }), /one image source/);

  // ── refusals before anything exists ─────────────────────────────────────

  console.log("\n-- refusals");
  const before3 = await pageCount();
  expectRefusal("storyboard.unknownSource", await tool("figma_create_storyboard", { title: "probe refusal (delete me)", aspect: "9:16", panels: [{ durationS: 1, source: "999999:1" }] }), /^NODE_NOT_FOUND/);
  expectRefusal("storyboard.sourceAndImage", await tool("figma_create_storyboard", { title: "probe refusal (delete me)", aspect: "1:1", panels: [{ durationS: 1, source: sourceId, image: "abc" }] }), /^INVALID_PARAM.*both `source` and `image`/);
  expectRefusal("storyboard.tooLong", await tool("figma_create_storyboard", { title: "probe refusal (delete me)", aspect: "1:1", panels: Array.from({ length: 11 }, () => ({ durationS: 60 })) }), /at most 600 s/);
  const after3 = await pageCount();
  record("storyboard.refusals.unchanged", { ok: true, value: after3 - before3 }, { expected: "no new top-level node", pass: after3 === before3 });

  // ── a picture to look at ────────────────────────────────────────────────

  console.log("\n-- render");
  exercised.add("figma_export_node");
  const png = await mcp.call("figma_export_node", { nodeId: b.storyboardId, maxSize: 2400, session: session.sessionId });
  if (png.images?.[0]) {
    fs.mkdirSync(path.dirname(PNG), { recursive: true });
    fs.writeFileSync(PNG, Buffer.from(png.images[0].data, "base64"));
    record("render", { ok: true, value: path.relative(process.cwd(), PNG) });
  } else {
    record("render", png.ok ? { ok: true, value: png.data ?? png.text } : { ok: false, error: png.text });
  }
}

async function cleanup() {
  console.log("\n-- cleanup");
  if (!made.length) return;
  // Only ids our own calls returned; deleting a board removes everything in it.
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
