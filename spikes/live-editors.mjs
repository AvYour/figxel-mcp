// Measure the editor table on real files: which Plugin API members exist in
// Figma Design, FigJam and Figma Slides, which reads throw, whether the
// contradicted facts hold, and whether the gate refuses what it should
// [C-129] [C-131] [C-137] [C-138] [C-139] [C-142] [C-143] [C-145] [C-150] [C-151] [C-152].
//
// Unit tests run against fakes, and fakes encode the author's assumptions; only
// this run may turn an editor cell in src/shared/editors.ts to "yes" or "no",
// and only from what it writes to spikes/results/live-editors.json — one record
// per probe with the exact value or Figma's exact error message.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub), with
// its own BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this
// process's calls only, so the user's client stays strict and needs no restart.
// It does check that the hub runs the current build — an older hub has no gate.
//
// Needs three files open, each with the figma-mcp bridge plugin running:
//   Design "fmcp-design-scratch", FigJam "fmcp-board-scratch", Slides "fmcp-deck-scratch" (a new, empty deck).
//
//   node spikes/live-editors.mjs              fully automatic
//   INTERACTIVE=1 node spikes/live-editors.mjs  also the steps that need a hand on the canvas
//   KEEP=1 node spikes/live-editors.mjs       leave the probe nodes in place
//
// Exit 0: measured (expectations about our own gate passed). 1: a gate
// expectation failed. 2: the run could not start (a file, the build, eval).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-editors.json");
const KEEP = process.env.KEEP === "1";
const INTERACTIVE = process.env.INTERACTIVE === "1";
const FILES = { figma: "fmcp-design-scratch", figjam: "fmcp-board-scratch", slides: "fmcp-deck-scratch" };
const LABEL = { figma: "Design", figjam: "FigJam", slides: "Slides" };
// A 1×1 PNG, for createImage in FigJam [C-150].
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const records = [];
const made = { figma: [], figjam: [], slides: [] }; // node ids to delete at the end
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One probe's outcome. `expected`/`pass` only where our own code makes a promise. */
function record(probe, editor, outcome, extra = {}) {
  const rec = { probe, editor, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${editor.padEnd(6)} ${probe.padEnd(44)} ${shown.length > 160 ? shown.slice(0, 160) + "…" : shown}`);
  return rec;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-editors", startedAt, finishedAt: new Date().toISOString(), files: FILES, sessions, records }, null, 2) + "\n");
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const startedAt = new Date().toISOString();
const sessions = {};

// ── connect: measuring (flag on) and strict (flag off) ──────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Set((await mcp.list()).map((t) => t.name));
if (!tools.has("figma_eval")) {
  console.error("figma_eval is not registered on the spawned server (BRIDGE_TOOLSET?). It is how this run probes the API.");
  await mcp.close();
  process.exit(2);
}

const st = await mcp.call("figma_status", {});
if (!st.ok || !st.data) {
  console.error(`figma_status failed: ${st.text}`);
  await mcp.close();
  process.exit(2);
}
console.log(`role ${st.data.bridge.role} (hub pid ${st.data.bridge.hubPid}), allowUnverified ${st.data.bridge.allowUnverified}`);
for (const [editor, file] of Object.entries(FILES)) {
  const s = st.data.sessions.find((x) => x.file?.name === file);
  if (!s) {
    console.error(`Open the ${LABEL[editor]} file "${file}" in Figma and run Plugins → Development → figma-mcp bridge there.`);
    await mcp.close();
    process.exit(2);
  }
  if (s.build?.restart === "client") {
    console.error("restart the MCP client so the hub runs the current build");
    await mcp.close();
    process.exit(2);
  }
  if (s.build?.restart === "plugin") {
    console.error(`Close the figma-mcp bridge plugin window in "${file}" and run it again: it is running an older build than dist/.`);
    await mcp.close();
    process.exit(2);
  }
  sessions[editor] = s.sessionId;
}

/** figma_eval in one file. The code is an async function body; `figma` is in scope. */
async function evalIn(editor, code) {
  const r = await mcp.call("figma_eval", { code, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data?.value } : { ok: false, error: r.text };
}

/** A tool call in one file, recorded as Figma answered it. */
async function toolIn(client, editor, name, args = {}) {
  const r = await client.call(name, { ...args, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data ?? r.text } : { ok: false, error: r.text, structured: r.data };
}

// Set by the probes, read by the cleanup.
let deckBefore = { ok: false };
let slideId = null;
let probeRowId = null;
let strict = null;

async function probes() {
  // ── (1) status per file ─────────────────────────────────────────────────────

  console.log("\n-- (1) status");
  for (const editor of Object.keys(FILES)) {
    const s = st.data.sessions.find((x) => x.sessionId === sessions[editor]);
    record("status.session", editor, {
      ok: true,
      value: { editorType: s.editorType, editor: s.editor, build: s.build, unavailableTools: s.unavailableTools, unverifiedTools: s.unverifiedTools, apiVersion: s.apiVersion },
    }, editor === "figma" ? { expected: "editorType figma, nothing unavailable", pass: s.editorType === "figma" && s.unavailableTools?.length === 0 } : { expected: `editorType ${editor}`, pass: s.editorType === editor });
  }

  // ── (2) capability probe: present? typeof? does touching it throw? ───────────

  console.log("\n-- (2) capabilities");
  const MEMBERS = [
    "createPage", "createComponent", "createComponentFromNode", "combineAsVariants", "createPaintStyle",
    "variables.getLocalVariableCollectionsAsync", "getLocalPaintStylesAsync", "teamLibrary", "importComponentByKeyAsync",
    "createImage", "createImageAsync", "createNodeFromSvg", "createFrame", "createEllipse", "createSection", "createSticky",
    "createShapeWithText", "createConnector", "createTable", "createCodeBlock", "createLinkPreviewAsync", "createGif",
    "createSlide", "createSlideRow", "getSlideGrid", "getCanvasGrid", "setCanvasGrid", "moveNodesToCoord", "createAutoLayout",
    "group", "union", "flatten", "triggerUndo", "root.children.length", "viewport.slidesView", "viewport.canvasView", "viewport.slidesMode",
  ];
  const PROBE_MEMBERS = `
  const msg = (e) => String(e && e.message !== undefined ? e.message : e);
  const out = {};
  for (const name of ${JSON.stringify(MEMBERS)}) {
    const parts = name.split(".");
    const rec = {};
    let target = figma;
    try { for (const p of parts.slice(0, -1)) target = target[p]; } catch (e) { rec.parentThrows = msg(e); out[name] = rec; continue; }
    const last = parts[parts.length - 1];
    try { rec.in = target != null && last in Object(target); } catch (e) { rec.inThrows = msg(e); }
    try {
      const v = target[last];
      rec.typeof = v === null ? "null" : typeof v;
      if (v !== null && typeof v !== "object" && typeof v !== "function") rec.value = v;
    } catch (e) { rec.getThrows = msg(e); }
    out[name] = rec;
  }
  return { editorType: figma.editorType, apiVersion: figma.apiVersion, members: out };`;
  for (const editor of Object.keys(FILES)) record("capabilities", editor, await evalIn(editor, PROBE_MEMBERS));

  // ── a probe slide, so Slides creates have a parent; the deck is restored at the end ──

  deckBefore = await evalIn("slides", `
  const grid = figma.currentPage.children[0];
  return { gridType: grid && grid.type, rows: grid && grid.type === "SLIDE_GRID" ? grid.children.length : null,
    slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length };`);
  record("deck.before", "slides", deckBefore);
  const probeSlide = await evalIn("slides", `const s = figma.createSlide(); s.name = "figma-mcp WP-A probe (delete me)"; return { id: s.id, row: s.parent && s.parent.id };`);
  record("createSlide()", "slides", probeSlide);
  slideId = typeof probeSlide.value?.id === "string" ? probeSlide.value.id : null;
  probeRowId = typeof probeSlide.value?.row === "string" ? probeSlide.value.row : null;
  if (slideId) made.slides.push(slideId);

  // ── (3) opaque reads: throw, or undefined? [C-145] ──────────────────────────

  console.log("\n-- (3) opaque reads");
  const READ_PROPS = `
  const msg = (e) => String(e && e.message !== undefined ? e.message : e);
  const readAll = (node) => {
    const r = { type: node.type };
    for (const p of ["fills", "layoutMode", "width", "opacity"]) {
      try { const v = node[p]; r[p] = v === undefined ? "undefined" : Array.isArray(v) ? \`array(\${v.length})\` : typeof v === "symbol" ? "mixed" : v; }
      catch (e) { r[p] = { throws: msg(e) }; }
    }
    try { r["'fills' in node"] = "fills" in node; } catch (e) { r["'fills' in node"] = { throws: msg(e) }; }
    return r;
  };`;
  const boardNodes = await evalIn("figjam", `${READ_PROPS}
  const made = [];
  const out = {};
  const tryMake = (label, make) => { try { const n = make(); made.push(n.id); out[label] = readAll(n); } catch (e) { out[label] = { createThrows: msg(e) }; } };
  tryMake("STICKY", () => figma.createSticky());
  tryMake("SECTION", () => figma.createSection());
  tryMake("CONNECTOR", () => figma.createConnector());
  tryMake("TABLE", () => figma.createTable(2, 2));
  for (const n of figma.currentPage.children.filter((c) => made.includes(c.id))) { n.x += 30000; n.y += 30000; }
  return { reads: out, ids: made };`);
  record("opaque.reads", "figjam", boardNodes.ok ? { ok: true, value: boardNodes.value?.reads } : boardNodes);
  if (boardNodes.ok) made.figjam.push(...(boardNodes.value?.ids ?? []));
  record("opaque.reads", "slides", await evalIn("slides", `${READ_PROPS}
  const grid = figma.currentPage.children[0];
  const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId ?? "")});
  const row = slide && slide.parent;
  return { SLIDE_GRID: grid ? readAll(grid) : null, SLIDE_ROW: row ? readAll(row) : null, SLIDE: slide ? readAll(slide) : null };`));

  // ── (4) contradiction settlers ──────────────────────────────────────────────

  console.log("\n-- (4) contradictions");
  const TRY = `const msg = (e) => String(e && e.message !== undefined ? e.message : e);
  const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: msg(e) }; } };`;
  // Slides: components, sections, shapes with text, tables [C-137]; speaker notes [C-138]; transitions [C-139].
  record("slides.creates", "slides", await evalIn("slides", `${TRY}
  const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId ?? "")});
  const out = {};
  for (const [label, make] of [
    ["createComponent()", () => figma.createComponent()],
    ["createSection()", () => figma.createSection()],
    ["createShapeWithText()", () => figma.createShapeWithText()],
    ["createTable()", () => figma.createTable()],
  ]) {
    const r = attempt(() => { const n = make(); const info = { type: n.type, parent: n.parent && n.parent.type }; try { if (slide) slide.appendChild(n); info.appendedToSlide = true; } catch (e) { info.appendError = msg(e); } n.remove(); return info; });
    out[label] = r;
  }
  return out;`), { claim: "C-137" });
  record("slide.speakerNotes", "slides", await evalIn("slides", `${TRY}
  const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId ?? "")});
  const out = { in: attempt(() => "speakerNotes" in slide), read: attempt(() => slide.speakerNotes) };
  out.write = attempt(() => { slide.speakerNotes = "- one\\n- **two**\\n# heading"; return slide.speakerNotes; });
  return out;`), { claim: "C-138" });
  record("slide.transition", "slides", await evalIn("slides", `${TRY}
  const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId ?? "")});
  const out = { get: attempt(() => slide.getSlideTransition()) };
  out.set = attempt(() => { slide.setSlideTransition({ style: "DISSOLVE", duration: 0.4, curve: "EASE_OUT", timing: { type: "ON_CLICK" } }); return slide.getSlideTransition(); });
  return out;`), { claim: "C-139" });
  // FigJam: pages [C-142], images [C-150], DART [C-143].
  record("figjam.createPage", "figjam", await evalIn("figjam", `${TRY}
  const before = figma.root.children.length;
  const r = attempt(() => { const p = figma.createPage(); const info = { id: p.id, type: p.type }; p.remove(); return info; });
  return { before, after: figma.root.children.length, result: r };`), { claim: "C-142" });
  record("figjam.createImage", "figjam", await evalIn("figjam", `${TRY}
  const r = attempt(() => figma.createImage(figma.base64Decode(${JSON.stringify(PNG_1X1)})).hash);
  const out = { createImage: r };
  if (r.ok) out.asFill = attempt(() => { const rect = figma.createRectangle(); rect.fills = [{ type: "IMAGE", imageHash: r.value, scaleMode: "FILL" }]; const n = rect.fills.length; rect.remove(); return n; });
  out.createImageAsync = typeof figma.createImageAsync;
  return out;`), { claim: "C-150" });
  record("figjam.codeLanguage.DART", "figjam", await evalIn("figjam", `${TRY}
  return attempt(() => { const c = figma.createCodeBlock(); c.code = "void main() {}"; c.codeLanguage = "DART"; const v = c.codeLanguage; c.remove(); return v; });`), { claim: "C-143" });

  // ── (5) the gate without the flag ───────────────────────────────────────────

  console.log("\n-- (5) gate, strict connection");
  strict = await connect({ allowEval: true });
  const strictStatus = await strict.call("figma_status", {});
  record("strict.allowUnverified", "all", { ok: true, value: strictStatus.data?.bridge?.allowUnverified });
  const count = async (editor) => (await evalIn(editor, "return figma.currentPage.children.length;")).value;
  for (const editor of ["figjam", "slides"]) {
    const before = await count(editor);
    const r = await toolIn(strict, editor, "figma_create_paint_style", { name: "fmcp gate probe", color: "#ff0000" });
    const after = await count(editor);
    const s = r.structured ?? {};
    record("gate.create_paint_style", editor, r, {
      expected: "UNSUPPORTED, safeToRetry, created [], nothing added",
      pass: !r.ok && s.code === "UNSUPPORTED" && s.safeToRetry === true && Array.isArray(s.partial?.created) && s.partial.created.length === 0 && before === after,
    });
    const unverified = await toolIn(strict, editor, "figma_set_layout_grids", { nodeIds: ["0:0"], grids: [] });
    record("gate.unverified_write", editor, unverified, {
      expected: "UNSUPPORTED (not verified yet), unless the user's hub runs with the flag",
      pass: strictStatus.data?.bridge?.allowUnverified ? true : !unverified.ok && unverified.structured?.code === "UNSUPPORTED",
    });
    // A "no" stays refused through the flagged connection too.
    const flagged = await toolIn(mcp, editor, "figma_create_paint_style", { name: "fmcp gate probe", color: "#ff0000" });
    record("gate.no_with_flag", editor, flagged, { expected: "UNSUPPORTED", pass: !flagged.ok && flagged.structured?.code === "UNSUPPORTED" });
  }
  const batch = await toolIn(strict, "figjam", "figma_batch", {
    steps: JSON.stringify([{ op: "set_opacity", params: { nodeIds: [made.figjam[0] ?? "0:0"], opacity: 0.5 } }, { op: "set_layout_grids", params: { nodeIds: [made.figjam[0] ?? "0:0"], grids: [] } }]),
  });
  record("gate.batch", "figjam", batch, {
    expected: "refused whole, message steps[i]: …",
    pass: strictStatus.data?.bridge?.allowUnverified ? true : !batch.ok && /^UNSUPPORTED: steps\[\d\]: /.test(batch.error ?? ""),
  });

  // ── (6) routing: the active file, `session`, and links ──────────────────────

  console.log("\n-- (6) routing");
  const sticky = await evalIn("figjam", `const s = figma.createSticky(); s.x = 30000; s.y = 30600; return s.id;`);
  const stickyId = typeof sticky.value === "string" ? sticky.value : null;
  if (stickyId) made.figjam.push(stickyId);
  // Selecting in the board should make it the active file (selection events, events.ts).
  await toolIn(mcp, "figjam", "figma_select", { nodeId: stickyId });
  await sleep(600);
  let active = (await mcp.call("figma_status", {})).data?.activeSession;
  if (active !== sessions.figjam && INTERACTIVE) {
    await ask(`click the board now ("${FILES.figjam}"), then press Enter `);
    active = (await mcp.call("figma_status", {})).data?.activeSession;
  }
  record("routing.boardActiveAfterSelect", "figjam", { ok: true, value: { active, board: sessions.figjam } });
  if (active === sessions.figjam) {
    const r = await strict.call("figma_create_paint_style", { name: "fmcp routing probe", color: "#00ff00" });
    record("routing.noSession", "figjam", r.ok ? { ok: true, value: r.data } : { ok: false, error: r.text }, {
      expected: `UNSUPPORTED whose hint names "${FILES.figma}"`,
      pass: !r.ok && r.text.includes(`"${FILES.figma}"`),
    });
  } else {
    record("routing.noSession", "figjam", { ok: false, error: "skipped: the board did not become the active file (run with INTERACTIVE=1 to click it)" });
  }
  const style = await toolIn(strict, "figma", "figma_create_paint_style", { name: "fmcp routing probe", color: "#00ff00" });
  record("routing.withSession", "figma", style, { expected: "created in the Design file", pass: style.ok });
  if (style.ok && style.value?.id) {
    record("routing.cleanupStyle", "figma", await toolIn(mcp, "figma", "figma_delete_style", { styleIds: [style.value.id] }));
  }
  const nodeLink = (kind, slug, id) => `https://www.figma.com/${kind}/Probe0Key/${slug}?node-id=${id.replace(":", "-")}`;
  if (stickyId) {
    const r = await mcp.call("figma_get_node", { nodeId: nodeLink("board", FILES.figjam, stickyId) });
    record("routing.boardLink", "figjam", r.ok ? { ok: true, value: { id: r.data?.id ?? r.data?.node?.id, warning: r.data?.warning } } : { ok: false, error: r.text });
  }
  if (slideId) {
    const r = await mcp.call("figma_get_node", { nodeId: nodeLink("slides", FILES.slides, slideId) });
    record("routing.slidesLink", "slides", r.ok ? { ok: true, value: { id: r.data?.id ?? r.data?.node?.id, warning: r.data?.warning } } : { ok: false, error: r.text });
  }

  // ── (7) one undo step per call [C-151] ──────────────────────────────────────

  console.log("\n-- (7) undo");
  for (const editor of Object.keys(FILES)) {
    const parent = editor === "slides" ? { parentId: slideId } : { x: 30000, y: 31200 };
    const sentinel = await toolIn(mcp, editor, "figma_create_rectangle", { width: 20, height: 20, name: "fmcp undo sentinel", ...parent });
    const rect = await toolIn(mcp, editor, "figma_create_rectangle", { width: 40, height: 40, name: "fmcp undo probe", ...parent });
    const sid = sentinel.value?.id;
    const rid = rect.value?.id;
    if (sid) made[editor].push(sid);
    if (rid) made[editor].push(rid);
    if (!sid || !rid) {
      record("undo.oneStep", editor, { ok: false, error: `could not create the probes: ${sentinel.error ?? ""} ${rect.error ?? ""}`.trim() });
      continue;
    }
    record("undo.oneStep", editor, await evalIn(editor, `
  figma.triggerUndo();
  return { probeExists: !!(await figma.getNodeByIdAsync(${JSON.stringify(rid)})), sentinelExists: !!(await figma.getNodeByIdAsync(${JSON.stringify(sid)})) };`));
  }

  // ── (8) selection events reach figma_status ─────────────────────────────────

  console.log("\n-- (8) events");
  for (const [editor, id] of [["figjam", stickyId], ["slides", slideId]]) {
    if (!id) continue;
    await toolIn(mcp, editor, "figma_select", { nodeId: id });
    await sleep(600);
    const s = (await mcp.call("figma_status", {})).data?.sessions?.find((x) => x.sessionId === sessions[editor]);
    record("events.selection", editor, { ok: true, value: s?.selection ?? null }, { expected: `selection holds ${id}`, pass: s?.selection?.nodeIds?.includes(id) ?? false });
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n-- cleanup");
  for (const [editor, ids] of Object.entries(made)) {
    if (!ids.length) continue;
    record("cleanup", editor, await evalIn(editor, `
const gone = [];
for (const id of ${JSON.stringify([...ids].reverse())}) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) { n.remove(); gone.push(id); } }
return gone;`));
  }
  // An empty deck stays empty: the probe slide's row goes too when the deck had none.
  if (deckBefore.ok && deckBefore.value?.slides === 0 && probeRowId) {
    record("cleanup.row", "slides", await evalIn("slides", `const r = await figma.getNodeByIdAsync(${JSON.stringify(probeRowId)});
try { if (r && r.children.length === 0) r.remove(); return { removed: !!r }; } catch (e) { return { error: String(e && e.message) }; }`));
  }
  record("deck.after", "slides", await evalIn("slides", `
const grid = figma.currentPage.children[0];
return { rows: grid && grid.type === "SLIDE_GRID" ? grid.children.length : null, slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length };`));
}

// A crash still saves what was measured and removes what was made.
try {
  await probes();
} catch (err) {
  record("crash", "all", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
}
if (!KEEP) {
  try {
    await cleanup();
  } catch (err) {
    record("cleanup.crash", "all", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
  }
}

save();
await strict?.close();
await mcp.close();
const failed = records.filter((r) => r.pass === false);
console.log(`\n${records.length} probes → ${path.relative(process.cwd(), OUT)}${failed.length ? `; ${failed.length} gate expectation(s) failed` : ""}`);
process.exit(failed.length ? 1 : 0);
