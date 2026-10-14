// Measure the Figma Slides tools on a real deck: the grid read and written by
// the tree, new slides and rows, regrouping and moving, skipped slides,
// speaker notes, transitions, the deck as a PDF, the focused slide and the
// view, and one undo step per call
// [C-092] [C-134] [C-136] [C-138] [C-139] [C-140] [C-145] [C-146] [C-151] [C-164] [C-165].
//
// Unit tests run against fakes, and fakes encode the author's assumptions; only
// this run may turn a Slides cell in src/shared/editors.ts to "yes", re-status
// the claims above, or keep figma_set_slide_transition — and only from what it
// writes to spikes/results/live-slides.json: one record per probe with the
// exact value or Figma's exact error message.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub), with
// its own BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this
// process's calls only, so the user's client stays strict and needs no restart.
// It does check that the hub runs the current build.
//
// Needs the Slides file "fmcp-deck-scratch" open with the figma-mcp bridge
// plugin running (best a new, empty deck: then the empty-grid probes run too).
// The deck is put back as it was: every slide and row this run made is
// deleted and the original order and row names restored, unless KEEP=1.
//
//   node spikes/live-slides.mjs                 fully automatic
//   INTERACTIVE=1 node spikes/live-slides.mjs   also asks what the screen shows
//   KEEP=1 node spikes/live-slides.mjs          leave the probe slides in place
//
// Exit 0: every expectation held. 1: one failed (see the records). 2: the run
// could not start (the file, the build, eval, the tools).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-slides.json");
const PNG = path.join(HERE, "results", "live-slides.png");
const KEEP = process.env.KEEP === "1";
const INTERACTIVE = process.env.INTERACTIVE === "1";
const FILE = "fmcp-deck-scratch";
const NEEDED = [
  "figma_eval", "figma_status", "figma_get_slide_grid", "figma_create_slides", "figma_set_slide_grid", "figma_move_slides",
  "figma_set_slide_properties", "figma_set_slide_transition", "figma_export_frames_to_pdf", "figma_export_node", "figma_zoom_to",
];
const NOTES = "- one\n- **two**\n# heading";

const records = [];
const made = { slides: [] }; // slide ids this run created, deleted at the end
const startedAt = new Date().toISOString();
let deckBefore = null;
let sessionId = null;

/** One probe's outcome. `expected` / `pass` only where our own code makes a promise. */
function record(probe, outcome, extra = {}) {
  const rec = { probe, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${probe.padEnd(46)} ${shown.length > 160 ? shown.slice(0, 160) + "…" : shown}`);
  return rec;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-slides", startedAt, finishedAt: new Date().toISOString(), file: FILE, sessionId, deckBefore, records }, null, 2) + "\n");
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const section = (name) => console.log(`\n-- ${name}`);

// ── connect ─────────────────────────────────────────────────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
async function stop(message) {
  console.error(message);
  await mcp.close();
  process.exit(2);
}

const registered = new Set((await mcp.list()).map((t) => t.name));
const missing = NEEDED.filter((t) => !registered.has(t));
if (missing.length) {
  await stop(`The server in dist/ does not register ${missing.join(", ")}. Build the integrated tree (npm run build); figma_eval is enabled by this script.`);
}

const st = await mcp.call("figma_status", {});
if (!st.ok || !st.data) await stop(`figma_status failed: ${st.text}`);
console.log(`role ${st.data.bridge.role} (hub pid ${st.data.bridge.hubPid}), allowUnverified ${st.data.bridge.allowUnverified}`);
const session = st.data.sessions.find((s) => s.file?.name === FILE);
if (!session) await stop(`Open the Figma Slides file "${FILE}" in Figma and run Plugins → Development → figma-mcp bridge there.`);
if (session.build?.restart === "client") await stop("restart the MCP client so the hub runs the current build");
if (session.build?.restart === "plugin") await stop(`Close the figma-mcp bridge plugin window in "${FILE}" and run it again: it is running an older build than dist/.`);
if (session.editorType !== "slides") await stop(`"${FILE}" reports editorType "${session.editorType}": it must be a Figma Slides file.`);
sessionId = session.sessionId;

/**
 * A tool call in the deck. The full result, structuredContent included, so an
 * error's `safeToRetry` and `partial` can be checked.
 */
async function tool(name, args = {}) {
  let res;
  try {
    res = await mcp.client.callTool({ name, arguments: { ...args, session: FILE } }, undefined, { timeout: 180_000 });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  const texts = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text);
  const images = (res.content ?? []).filter((b) => b.type === "image");
  if (res.isError) return { ok: false, error: texts.join("\n"), structured: res.structuredContent ?? null };
  let value = res.structuredContent ?? null;
  if (value === null && texts[0] !== undefined) {
    try {
      value = JSON.parse(texts[0]);
    } catch {
      value = texts[0];
    }
  }
  return { ok: true, value, images };
}

/** figma_eval in the deck: an async function body with `figma` in scope; a null value is still a result. */
async function js(code) {
  const r = await tool("figma_eval", { code });
  if (!r.ok) return r;
  return { ok: true, value: r.value && typeof r.value === "object" && "value" in r.value ? r.value.value : r.value };
}

/** The page count of a PDF the bridge wrote, read back from disk. */
async function pdfPages(file) {
  try {
    return (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
  } catch (err) {
    return `unreadable: ${String(err?.message ?? err)}`;
  }
}

const errCode = (r) => r.structured?.code ?? /^([A-Z_]+):/.exec(r.error ?? "")?.[1];
/** A refusal that changed nothing: the code we promise, and safeToRetry [C-096]. */
const cleanRefusal = (r, code) => !r.ok && errCode(r) === code && r.structured?.safeToRetry === true;

// The deck as the tree holds it, and as Figma's grid call reports it.
const MSG = `const msg = (e) => String(e && e.message !== undefined ? e.message : e);`;
const READ_DECK = `
const grid = figma.currentPage.children.find((c) => c.type === "SLIDE_GRID");
const rows = grid ? grid.children.map((r) => ({ id: r.id, name: r.name, slides: r.children.map((s) => s.id) })) : null;`;
const deckNow = async () => (await js(`${READ_DECK}\nreturn rows;`)).value ?? [];
const flat = (rows) => rows.flatMap((r) => r.slides);
const rowOf = (rows, id) => rows.findIndex((r) => r.slides.includes(id));

/** Name, place, fill, skip and size of each slide, read from the document. */
const slideInfo = (ids) => `
const out = {};
for (const id of ${JSON.stringify(ids)}) {
  const s = await figma.getNodeByIdAsync(id);
  if (!s) { out[id] = null; continue; }
  const row = s.parent;
  const grid = row && row.parent;
  const f = Array.isArray(s.fills) ? s.fills[0] : null;
  const hex = f && f.type === "SOLID" ? "#" + [f.color.r, f.color.g, f.color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : null;
  out[id] = {
    name: s.name, type: s.type, rowType: row && row.type,
    row: grid && grid.children ? grid.children.findIndex((r) => r.id === row.id) : null,
    col: row && row.children ? row.children.findIndex((c) => c.id === s.id) : null,
    skipped: s.isSkippedSlide, fill: hex, width: s.width, height: s.height,
  };
}
return out;`;

let A, B, C, D;

async function probes() {
  // ── A. the deck as Figma holds it ─────────────────────────────────────────
  section("A. the deck");
  record("status.session", { ok: true, value: { editorType: session.editorType, editor: session.editor, build: session.build, unavailableTools: session.unavailableTools } }, {
    expected: "editorType slides; no Slides tool unavailable with the flag",
    pass: session.editorType === "slides" && !(session.unavailableTools ?? []).some((t) => /slide/.test(t)),
  });
  const shape = await js(`${READ_DECK}
let api = null;
${MSG}
try { api = (typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid()).map((r) => r.map((s) => s.id)); } catch (e) { api = { error: msg(e) }; }
return { pages: figma.root.children.length, pageChildren: figma.currentPage.children.map((c) => c.type), rows, api };`);
  record("deck.shape", shape, { claim: "C-134", expected: "one page whose first child is SLIDE_GRID", pass: shape.ok && shape.value?.pages === 1 && shape.value?.pageChildren?.[0] === "SLIDE_GRID" });
  deckBefore = shape.value?.rows ?? [];
  const empty = flat(deckBefore).length === 0;

  // ── B. reading the grid ───────────────────────────────────────────────────
  section("B. figma_get_slide_grid on the deck as found");
  const first = await tool("figma_get_slide_grid", { includeTransitions: true });
  record("get_slide_grid.initial", first, {
    expected: "rowCount and slideCount as the tree holds them; an empty deck has no rows and a note",
    pass: first.ok && first.value.rowCount === deckBefore.length && first.value.slideCount === flat(deckBefore).length && (!empty || /makes row 0/.test(first.value.note ?? "")),
  });
  if (empty) record("emptyDeck.api", await js(`return { slideGrid: figma.getSlideGrid().length, canvasGrid: typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid().length : "absent" };`), { claim: "C-164" });

  // ── C. new slides ─────────────────────────────────────────────────────────
  section("C. figma_create_slides");
  const created = await tool("figma_create_slides", {
    slides: [{ name: "fmcp A", background: "#0b1020" }, { name: "fmcp B" }, { name: "fmcp C", skipped: true }],
  });
  const ids = created.ok ? created.value.slides.map((s) => s.id) : [];
  made.slides.push(...ids);
  [A, B, C] = ids;
  record("create_slides.three", created, {
    claim: "C-164",
    expected: empty ? "row 0 made by the first slide, cols 0–2" : "three slides at the end of the last row",
    pass: created.ok && ids.length === 3 && !created.value.warnings && (!empty || (created.value.rowsCreated?.length === 1 && created.value.slides.every((s, i) => s.row === 0 && s.col === i))),
  });
  if (ids.length !== 3) throw new Error("figma_create_slides did not make the three probe slides; nothing else can run");
  const info = await js(slideInfo(ids));
  const v = info.value ?? {};
  record("create_slides.readBack", info, {
    claim: "C-136",
    expected: "names, the background on A's fills, C skipped, 1920×1080, each under a SLIDE_ROW",
    pass: info.ok && v[A]?.name === "fmcp A" && v[A]?.fill === "#0b1020" && v[C]?.skipped === true && v[B]?.skipped === false &&
      ids.every((id) => v[id]?.width === 1920 && v[id]?.height === 1080 && v[id]?.rowType === "SLIDE_ROW"),
  });

  // An explicit spot, row + col, between A and B; removed again so the later probes see three slides.
  const atA = await deckNow();
  const aRow = rowOf(atA, A);
  const aCol = atA[aRow]?.slides.indexOf(A) ?? -1;
  const placed = await tool("figma_create_slides", { slides: [{ name: "fmcp E", row: aRow, col: aCol + 1 }] });
  const E = placed.ok ? placed.value.slides[0].id : undefined;
  if (E) made.slides.push(E);
  const atE = await deckNow();
  record("create_slides.rowCol", placed, {
    expected: `E at row ${aRow} col ${aCol + 1}, between A and B, no placement warning`,
    pass: placed.ok && !placed.value.warnings && placed.value.slides[0].row === aRow && placed.value.slides[0].col === aCol + 1 &&
      JSON.stringify(atE[aRow]?.slides.slice(aCol, aCol + 3)) === JSON.stringify([A, E, B]),
  });
  if (E) {
    record("create_slides.rowCol.remove", await js(`const e = await figma.getNodeByIdAsync(${JSON.stringify(E)});
if (e) e.remove();
return { gone: !(await figma.getNodeByIdAsync(${JSON.stringify(E)})) };`));
  }

  // createSlide at the grid's edges: prepend, and past the end (throw or clamp?) [C-164].
  record("createSlide(0,0)", await js(`${MSG}
const s = figma.createSlide(0, 0);
const row = s.parent; const grid = row.parent;
const out = { row: grid.children.findIndex((r) => r.id === row.id), col: row.children.findIndex((c) => c.id === s.id) };
s.remove();
return out;`), { claim: "C-164" });
  for (const [label, args] of [["createSlide(rows+5,0)", "grid.children.length + 5, 0"], ["createSlide(0,99)", "0, 99"]]) {
    const r = await js(`${MSG}
const grid = figma.currentPage.children.find((c) => c.type === "SLIDE_GRID");
const rowsBefore = grid.children.map((r) => r.id);
try {
  const s = figma.createSlide(${args});
  const row = s.parent;
  const out = { threw: false, row: grid.children.findIndex((r) => r.id === row.id), col: row.children.findIndex((c) => c.id === s.id), rowsBefore: rowsBefore.length, rowsAfter: grid.children.length };
  s.remove();
  for (const r of grid.children) if (!rowsBefore.includes(r.id) && r.children.length === 0) { try { r.remove(); } catch (e) { out.rowRemoveError = msg(e); } }
  return out;
} catch (e) { return { threw: true, message: msg(e) }; }`);
    record(label, r, { claim: "C-164" });
  }

  // ── D. rows ───────────────────────────────────────────────────────────────
  section("D. rows");
  const rowCount = (await deckNow()).length;
  const fourth = await tool("figma_create_slides", { slides: [{ name: "fmcp D", row: rowCount }] });
  D = fourth.ok ? fourth.value.slides[0].id : undefined;
  if (D) made.slides.push(D);
  const afterD = await deckNow();
  record("create_slides.newRow", fourth, {
    expected: `D alone in a new last row (index ${rowCount})`,
    pass: fourth.ok && fourth.value.rowsCreated?.length === 1 && rowOf(afterD, D) === rowCount && afterD[rowCount]?.slides.length === 1,
  });
  record("row.defaultName", { ok: true, value: afterD[rowCount]?.name ?? null }, { claim: "C-164" });
  if (!D) throw new Error("figma_create_slides did not open a new row; the grid probes need four slides");

  // An empty row: does Figma's grid call list it, and can it be removed? [C-164]
  const emptyRow = await js(`${READ_DECK}
const r = figma.createSlideRow();
const api = (typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid()).map((x) => x.length);
return { rowId: r.id, name: r.name, treeRows: grid.children.length, apiRows: api.length, apiShape: api };`);
  record("emptyRow.apiGrid", emptyRow, { claim: "C-164" });
  if (emptyRow.ok) {
    const g = await tool("figma_get_slide_grid", { includeSummary: false, includeNotes: false });
    record("get_slide_grid.emptyRows", g, { expected: "the new empty row in emptyRows", pass: g.ok && g.value.emptyRows.some((r) => r.rowId === emptyRow.value.rowId) });
    record("emptyRow.remove", await js(`${MSG}
const r = await figma.getNodeByIdAsync(${JSON.stringify(emptyRow.value.rowId)});
try { r.remove(); return { removed: !(await figma.getNodeByIdAsync(${JSON.stringify(emptyRow.value.rowId)})) }; } catch (e) { return { error: msg(e) }; }`), { claim: "C-164" });
  }
  record("rows.treeVsApi", await js(`${READ_DECK}
const api = (typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid()).map((x) => x.map((s) => s.id));
return { tree: rows.map((r) => r.slides), api, same: JSON.stringify(rows.map((r) => r.slides).filter((r) => r.length)) === JSON.stringify(api.filter((r) => r.length)) };`), { claim: "C-164" });

  // ── E. regrouping ─────────────────────────────────────────────────────────
  section("E. figma_set_slide_grid");
  // Figma's own answer to a grid that leaves a slide out — the slide left out
  // is our C, so at worst this run loses its own probe [C-134].
  const omit = await js(`${MSG}${READ_DECK}
const nodes = [];
for (const r of rows) { const row = []; for (const id of r.slides) if (id !== ${JSON.stringify(C)}) row.push(await figma.getNodeByIdAsync(id)); nodes.push(row); }
try {
  const call = typeof figma.setCanvasGrid === "function" ? "setCanvasGrid" : "setSlideGrid";
  figma[call](nodes);
  const c = await figma.getNodeByIdAsync(${JSON.stringify(C)});
  return { threw: false, via: call, cExists: !!c, cParent: c && c.parent ? c.parent.type : null };
} catch (e) { return { threw: true, message: msg(e) }; }`);
  record("setSlideGrid.omitted", omit, { claim: "C-134" });
  if (omit.ok && omit.value?.threw === false && rowOf(await deckNow(), C) < 0) {
    // C left the grid: replace it so the rest of the run has four slides.
    await js(`const c = await figma.getNodeByIdAsync(${JSON.stringify(C)}); if (c) c.remove(); return true;`);
    const again = await tool("figma_create_slides", { slides: [{ name: "fmcp C", skipped: true }] });
    C = again.ok ? again.value.slides[0].id : C;
    made.slides.push(C);
    record("setSlideGrid.omitted.replacedC", again);
  }

  const mine = new Set([A, B, C, D]);
  const others = () => deckBefore.map((r) => r.slides.filter((id) => !mine.has(id))).filter((r) => r.length);
  const rowsBefore = await deckNow();
  const regroup = await tool("figma_set_slide_grid", {
    rows: [...others().map((slideIds) => ({ slideIds })), { slideIds: [A, B], name: "fmcp Intro" }, { slideIds: [C, D], name: "fmcp Demo" }],
  });
  const rowsAfter = await deckNow();
  const intro = rowsAfter.find((r) => JSON.stringify(r.slides) === JSON.stringify([A, B]));
  const demo = rowsAfter.find((r) => JSON.stringify(r.slides) === JSON.stringify([C, D]));
  record("set_slide_grid.regroup", regroup, {
    expected: "[A, B] named fmcp Intro, [C, D] named fmcp Demo, read back from the tree",
    pass: regroup.ok && intro?.name === "fmcp Intro" && demo?.name === "fmcp Demo",
  });
  record("set_slide_grid.rowIdentity", {
    ok: true,
    value: { before: rowsBefore.map((r) => ({ id: r.id, name: r.name, n: r.slides.length })), after: rowsAfter.map((r) => ({ id: r.id, name: r.name, n: r.slides.length })) },
  }, { claim: "C-164" });

  const merge = await tool("figma_set_slide_grid", { rows: [...others().map((slideIds) => ({ slideIds })), { slideIds: [A, B, C, D], name: "fmcp All" }] });
  const merged = await deckNow();
  record("set_slide_grid.prune", merge, {
    claim: "C-164",
    expected: "the four in one row named fmcp All; the emptied row reported as emptyRows or emptyRowsRemoved",
    pass: merge.ok && merged.some((r) => r.name === "fmcp All" && JSON.stringify(r.slides) === JSON.stringify([A, B, C, D])) &&
      (!demo || (merge.value.emptyRows ?? []).some((r) => r.rowId === demo.id) || (merge.value.emptyRowsRemoved ?? []).includes(demo.id) || !merged.some((r) => r.id === demo.id && r.slides.length)),
  });
  // "" gives a row back its default label: what the name reads as afterwards [C-164].
  const unnamed = await tool("figma_set_slide_grid", { rows: [...others().map((slideIds) => ({ slideIds })), { slideIds: [A, B, C, D], name: "" }] });
  const unnamedRow = (await deckNow()).find((r) => r.slides.includes(A));
  record("set_slide_grid.defaultName", unnamed.ok ? { ok: true, value: { name: unnamedRow?.name ?? null, renamed: unnamed.value.renamed } } : unnamed, {
    claim: "C-164",
    expected: "the call runs and the row's name reads back as Figma keeps \"\"",
    pass: unnamed.ok && unnamedRow !== undefined,
  });
  if (INTERACTIVE) record("set_slide_grid.defaultName.screen", { ok: true, value: await ask("What label does Figma show next to the row holding \"fmcp A\"? ") }, { claim: "C-164" });

  const settled = await deckNow();
  const refusedGrid = await tool("figma_set_slide_grid", { rows: [{ slideIds: [A, B] }] });
  record("set_slide_grid.incomplete", refusedGrid, {
    expected: "INVALID_PARAM naming the missing slides, safeToRetry, nothing written",
    pass: cleanRefusal(refusedGrid, "INVALID_PARAM") && [C, D].every((id) => (refusedGrid.structured?.hint ?? "").includes(id)) &&
      JSON.stringify(await deckNow()) === JSON.stringify(settled),
  });

  // ── F. moving ─────────────────────────────────────────────────────────────
  section("F. figma_move_slides");
  const ourRow = () => deckNow().then((rows) => rows.find((r) => r.slides.includes(A)));
  const m1 = await tool("figma_move_slides", { slideIds: [D], afterSlideId: A });
  record("move_slides.after", m1, { expected: "A, D, B, C", pass: m1.ok && JSON.stringify((await ourRow())?.slides) === JSON.stringify([A, D, B, C]) });
  const m2 = await tool("figma_move_slides", { slideIds: [A], beforeSlideId: C });
  record("move_slides.before", m2, { expected: "D, B, A, C", pass: m2.ok && JSON.stringify((await ourRow())?.slides) === JSON.stringify([D, B, A, C]) });
  const n = (await deckNow()).length;
  const m3 = await tool("figma_move_slides", { slideIds: [B], row: n });
  const afterM3 = await deckNow();
  record("move_slides.newRow", m3, { expected: `B alone in a new row ${n}`, pass: m3.ok && rowOf(afterM3, B) === n && afterM3[n]?.slides.length === 1 });
  const homeRow = rowOf(afterM3, A);
  const bRow = afterM3[n]?.id;
  const m4 = await tool("figma_move_slides", { slideIds: [B], row: homeRow, col: 0 });
  record("move_slides.rowCol", m4, {
    claim: "C-164",
    expected: "B back at col 0 of its row; the row it left listed in emptiedRows (kept or removed)",
    pass: m4.ok && JSON.stringify((await ourRow())?.slides) === JSON.stringify([B, D, A, C]) && (m4.value.emptiedRows ?? []).some((r) => r.rowId === bRow),
  });
  const before = await deckNow();
  const m5 = await tool("figma_move_slides", { slideIds: [A, D], afterSlideId: D });
  record("move_slides.anchorInBlock", m5, {
    expected: "INVALID_PARAM, safeToRetry, nothing moved",
    pass: cleanRefusal(m5, "INVALID_PARAM") && JSON.stringify(await deckNow()) === JSON.stringify(before),
  });

  // ── G. skipped and speaker notes ──────────────────────────────────────────
  section("G. figma_set_slide_properties");
  const props = await tool("figma_set_slide_properties", { slides: [{ slideId: A, skipped: true }, { slideId: B, speakerNotes: NOTES }] });
  const propsBack = await js(`const a = await figma.getNodeByIdAsync(${JSON.stringify(A)}); const b = await figma.getNodeByIdAsync(${JSON.stringify(B)});
${MSG}
let notes; try { notes = b.speakerNotes; } catch (e) { notes = { throws: msg(e) }; }
return { aSkipped: a.isSkippedSlide, notesIn: "speakerNotes" in b, notes };`);
  if (props.ok) {
    record("set_slide_properties.skipAndNotes", props, {
      claim: "C-138",
      expected: "A skipped; B's notes read back as written; a warning for the heading",
      pass: propsBack.value?.aSkipped === true && propsBack.value?.notes === NOTES && /headings/.test(JSON.stringify(props.value.items[1]?.warnings ?? [])),
    });
  } else {
    record("set_slide_properties.notesRefused", props, {
      claim: "C-138",
      expected: "speaker notes not exposed: UNSUPPORTED, safeToRetry, A not skipped",
      pass: cleanRefusal(props, "UNSUPPORTED") && propsBack.value?.aSkipped === false,
    });
    const skipOnly = await tool("figma_set_slide_properties", { slides: [{ slideId: A, skipped: true }] });
    const back = await js(`return (await figma.getNodeByIdAsync(${JSON.stringify(A)})).isSkippedSlide;`);
    record("set_slide_properties.skipOnly", skipOnly, { expected: "A skipped", pass: skipOnly.ok && back.value === true });
  }
  record("speakerNotes.probe", propsBack, { claim: "C-138" });
  record("slideThemeId.probe", await js(`${MSG}
const s = await figma.getNodeByIdAsync(${JSON.stringify(A)});
let value; try { value = s.slideThemeId; } catch (e) { value = { throws: msg(e) }; }
return { in: "slideThemeId" in s, value: value === undefined ? "undefined" : value };`), { claim: "C-136" });

  // ── H. transitions ────────────────────────────────────────────────────────
  section("H. figma_set_slide_transition");
  const readTransition = (id) => js(`${MSG}
const s = await figma.getNodeByIdAsync(${JSON.stringify(id)});
try { return s.getSlideTransition(); } catch (e) { return { throws: msg(e) }; }`);
  const t1 = await tool("figma_set_slide_transition", { slideIds: [A, B], style: "DISSOLVE", duration: 0.4, curve: "EASE_OUT", timing: "on-click" });
  const t1back = await readTransition(A);
  if (t1.ok) {
    record("set_slide_transition.dissolve", t1, {
      claim: "C-139",
      expected: "A's transition reads back DISSOLVE 0.4 s EASE_OUT on click",
      pass: t1back.value?.style === "DISSOLVE" && Math.abs((t1back.value?.duration ?? 0) - 0.4) < 1e-6 && t1back.value?.curve === "EASE_OUT" && t1back.value?.timing?.type === "ON_CLICK",
    });
    const t2 = await tool("figma_set_slide_transition", { slideIds: [B], style: "SLIDE_FROM_RIGHT", timing: "after-delay", delay: 2 });
    const t2back = await readTransition(B);
    record("set_slide_transition.afterDelay", t2, {
      expected: "B: SLIDE_FROM_RIGHT after 2 s, duration and curve kept",
      pass: t2.ok && t2back.value?.style === "SLIDE_FROM_RIGHT" && t2back.value?.timing?.type === "AFTER_DELAY" && t2back.value?.timing?.delay === 2 && t2back.value?.curve === "EASE_OUT",
    });
    const g = await tool("figma_get_slide_grid", { includeTransitions: true, includeNotes: false, includeSummary: false });
    const a = g.ok ? g.value.rows.flatMap((r) => r.slides).find((s) => s.id === A) : null;
    record("get_slide_grid.transition", g, { expected: "A's transition as set", pass: a?.transition?.style === "DISSOLVE" && a?.transition?.timing === "on-click" });
  } else {
    record("set_slide_transition.refused", t1, {
      claim: "C-139",
      expected: "transitions not implemented for plugins: UNSUPPORTED, safeToRetry, nothing set",
      pass: cleanRefusal(t1, "UNSUPPORTED"),
    });
  }
  record("transition.probe", t1back, { claim: "C-139" });
  const t3 = await tool("figma_set_slide_transition", { slideIds: [A], style: "DISSOLVE", duration: 0.4, timing: "on-click", delay: 1 });
  record("set_slide_transition.delayOnClick", t3, { expected: "INVALID_PARAM, safeToRetry", pass: cleanRefusal(t3, "INVALID_PARAM") });

  // ── I. reading what was built ─────────────────────────────────────────────
  section("I. figma_get_slide_grid parameters");
  // A title on A: appended BEFORE x/y is set, the order that avoids the -240 shift [C-146].
  const title = await js(`
const s = await figma.getNodeByIdAsync(${JSON.stringify(A)});
await figma.loadFontAsync({ family: "Inter", style: "Bold" });
const t = figma.createText();
s.appendChild(t);
t.fontName = { family: "Inter", style: "Bold" };
t.characters = "fmcp probe title";
t.fontSize = 96;
t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
t.x = 120; t.y = 120;
return { id: t.id, parent: t.parent.id, x: t.x, y: t.y };`);
  record("title.appendThenPlace", title, { claim: "C-146", expected: "x 120, y 120 under A", pass: title.value?.parent === A && title.value?.x === 120 && title.value?.y === 120 });
  const summary = await tool("figma_get_slide_grid", {});
  const sa = summary.ok ? summary.value.rows.flatMap((r) => r.slides).find((s) => s.id === A) : null;
  record("get_slide_grid.summary", summary, {
    expected: "A: title, background #0b1020, one child, skipped",
    pass: sa?.title === "fmcp probe title" && sa?.background === "#0b1020" && sa?.childCount === 1 && sa?.skipped === true,
  });
  record("get_slide_grid.unsupported", { ok: true, value: summary.value?.unsupported ?? [] }, { claim: "C-138" });
  const rowIdx = rowOf(await deckNow(), A);
  const page1 = await tool("figma_get_slide_grid", { rowIndex: rowIdx, limit: 2, includeSummary: false });
  const page2 = page1.ok && page1.value.nextCursor ? await tool("figma_get_slide_grid", { rowIndex: rowIdx, limit: 2, includeSummary: false, cursor: page1.value.nextCursor }) : { ok: false, error: "no nextCursor" };
  const paged = [page1, page2].flatMap((p) => (p.ok ? p.value.rows.flatMap((r) => r.slides.map((s) => s.id)) : []));
  record("get_slide_grid.rowIndexPaged", page2, { expected: "two pages of two give the row's four slides in order", pass: JSON.stringify(paged) === JSON.stringify([B, D, A, C]) });
  const bare = await tool("figma_get_slide_grid", { includeNotes: false, includeSummary: false, rowIndex: rowIdx });
  const bs = bare.ok ? bare.value.rows[0].slides[0] : null;
  record("get_slide_grid.bare", bare, { expected: "no notes, no summary fields", pass: bare.ok && bs && !("speakerNotes" in bs) && !("title" in bs) && !("background" in bs) });

  // ── J. export ─────────────────────────────────────────────────────────────
  section("J. export");
  const counts = await js(`${READ_DECK}
const all = []; const playing = [];
for (const r of rows) for (const id of r.slides) { const s = await figma.getNodeByIdAsync(id); all.push(id); if (!s.isSkippedSlide) playing.push(id); }
return { all, playing };`);
  const deckPdf = await tool("figma_export_frames_to_pdf", { deck: true, outputPath: "live-slides-deck.pdf" });
  const deckPages = deckPdf.ok ? await pdfPages(deckPdf.value.path) : null;
  record("export_frames_to_pdf.deck", deckPdf.ok ? { ok: true, value: { ...deckPdf.value, pagesOnDisk: deckPages } } : deckPdf, {
    expected: "one page per slide that plays, in grid order, also in the file on disk; skipped A and C listed apart",
    pass: deckPdf.ok && deckPdf.value.pageCount === counts.value?.playing.length && deckPages === counts.value?.playing.length &&
      JSON.stringify(deckPdf.value.slideIds) === JSON.stringify(counts.value?.playing) && [A, C].every((id) => deckPdf.value.skippedSlides?.includes(id)),
  });
  const allPdf = await tool("figma_export_frames_to_pdf", { deck: true, includeSkipped: true, outputPath: "live-slides-deck-all.pdf" });
  const allPages = allPdf.ok ? await pdfPages(allPdf.value.path) : null;
  record("export_frames_to_pdf.includeSkipped", allPdf.ok ? { ok: true, value: { ...allPdf.value, pagesOnDisk: allPages } } : allPdf, {
    expected: "every slide, in grid order",
    pass: allPdf.ok && allPages === counts.value?.all.length && JSON.stringify(allPdf.value.slideIds) === JSON.stringify(counts.value?.all),
  });
  const three = await tool("figma_export_frames_to_pdf", { nodeIds: [A, B, D], outputPath: "live-slides-three.pdf" });
  const threePages = three.ok ? await pdfPages(three.value.path) : null;
  record("export_frames_to_pdf.nodeIds", three.ok ? { ok: true, value: { ...three.value, pagesOnDisk: threePages } } : three, {
    expected: "3 pages, no slideIds (not deck mode)",
    pass: three.ok && three.value.pageCount === 3 && threePages === 3 && three.value.slideIds === undefined,
  });
  const both = await tool("figma_export_frames_to_pdf", { nodeIds: [A], deck: true, outputPath: "x.pdf" });
  record("export_frames_to_pdf.both", both, { expected: "INVALID_PARAM, safeToRetry", pass: cleanRefusal(both, "INVALID_PARAM") });
  const shot = await tool("figma_export_node", { nodeId: A });
  if (shot.ok && shot.images[0]) {
    fs.mkdirSync(path.dirname(PNG), { recursive: true });
    fs.writeFileSync(PNG, Buffer.from(shot.images[0].data, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), PNG)}`);
  }
  const meta = shot.ok ? (typeof shot.value === "object" ? shot.value : null) : null;
  record("export_node.slide", shot.ok ? { ok: true, value: meta } : shot, {
    claim: "C-092",
    expected: "an image capped at 1024 × 576",
    pass: shot.ok && !!shot.images[0] && meta?.pixelWidth === 1024 && meta?.pixelHeight === 576,
  });

  // ── K. the focused slide and the view ─────────────────────────────────────
  section("K. figma_zoom_to");
  const VIEW = `${MSG}
const vp = figma.viewport; const out = {};
for (const p of ["canvasView", "slidesView", "slidesMode"]) {
  const r = {};
  try { r.in = p in vp; } catch (e) { r.inThrows = msg(e); }
  try { const v = vp[p]; r.value = v === undefined ? "undefined" : v; } catch (e) { r.getThrows = msg(e); }
  out[p] = r;
}
let focused = null; try { focused = figma.currentPage.focusedSlide ? figma.currentPage.focusedSlide.id : null; } catch (e) { focused = { throws: msg(e) }; }
return { view: out, focused };`;
  record("view.probe", await js(VIEW), { claim: "C-140" });
  const z1 = await tool("figma_zoom_to", { nodeId: A });
  const z1back = await js(VIEW);
  record("zoom_to.slide", z1, { claim: "C-134", expected: "A focused", pass: z1.ok && z1.value.focusedSlideId === A && z1back.value?.focused === A });
  record("focusedSlide.switchesView", await js(`${MSG}
const read = () => { const o = {}; for (const p of ["canvasView", "slidesView", "slidesMode"]) { try { o[p] = figma.viewport[p]; } catch (e) { o[p] = { throws: msg(e) }; } } return o; };
const before = read();
figma.currentPage.focusedSlide = await figma.getNodeByIdAsync(${JSON.stringify(B)});
return { before, after: read(), focused: figma.currentPage.focusedSlide && figma.currentPage.focusedSlide.id };`), { claim: "C-140" });
  // B is focused now; a layer on A focuses A, the slide that holds it.
  if (typeof title.value?.id === "string") {
    const zl = await tool("figma_zoom_to", { nodeId: title.value.id });
    const zlBack = await js(VIEW);
    record("zoom_to.layerOnSlide", zl, { expected: "A focused through its title layer", pass: zl.ok && zl.value.focusedSlideId === A && zlBack.value?.focused === A });
  }
  const z2 = await tool("figma_zoom_to", { nodeId: A, view: "single-slide" });
  const z2back = await js(VIEW);
  record("zoom_to.singleSlide", z2, {
    claim: "C-140",
    expected: "a view property took single-slide (viewProperty), or viewNote says why none did",
    pass: z2.ok && (z2.value.viewProperty !== undefined || typeof z2.value.viewNote === "string"),
  });
  record("zoom_to.singleSlide.readBack", z2back, { claim: "C-140" });
  if (INTERACTIVE) record("zoom_to.singleSlide.screen", { ok: true, value: await ask("Does Figma now show slide \"fmcp A\" alone? (y/n) ") }, { claim: "C-140" });
  const z3 = await tool("figma_zoom_to", { view: "grid" });
  record("zoom_to.gridNoNodes", z3, { expected: "runs with no nodes", pass: z3.ok && Array.isArray(z3.value.items) && z3.value.items.length === 0 });
  if (INTERACTIVE) record("zoom_to.grid.screen", { ok: true, value: await ask("Does Figma show the grid of slides? (y/n) ") }, { claim: "C-140" });

  // ── L. one call, one undo step ────────────────────────────────────────────
  section("L. undo");
  const u = await tool("figma_create_slides", { slides: [{ name: "fmcp undo 1" }, { name: "fmcp undo 2" }] });
  const uIds = u.ok ? u.value.slides.map((s) => s.id) : [];
  made.slides.push(...uIds);
  if (uIds.length === 2) {
    const undone = await js(`figma.triggerUndo();
return { u1: !!(await figma.getNodeByIdAsync(${JSON.stringify(uIds[0])})), u2: !!(await figma.getNodeByIdAsync(${JSON.stringify(uIds[1])})), a: !!(await figma.getNodeByIdAsync(${JSON.stringify(A)})) };`);
    record("undo.createSlides", undone, { claim: "C-151", expected: "both new slides gone, A still there", pass: undone.value?.u1 === false && undone.value?.u2 === false && undone.value?.a === true });
  } else {
    record("undo.createSlides", u, { claim: "C-151", expected: "two slides to undo", pass: false });
  }
  // The grid is read and the undo triggered in ONE eval: an eval in between
  // would be the last call, and its own undo commit could be what gets undone.
  const gridBefore = (await deckNow()).map((r) => r.slides);
  const mv = await tool("figma_move_slides", { slideIds: [D], afterSlideId: C });
  const undoMove = await js(`${READ_DECK}
const moved = rows.map((r) => r.slides);
figma.triggerUndo();
return { moved, after: grid.children.map((r) => r.children.map((s) => s.id)) };`);
  const same = (a, b) => JSON.stringify((a ?? []).filter((r) => r.length)) === JSON.stringify((b ?? []).filter((r) => r.length));
  record("undo.moveSlides", { ok: mv.ok && undoMove.ok, value: { before: gridBefore, ...(undoMove.value ?? {}), ...(undoMove.ok ? {} : { error: undoMove.error }) } }, {
    claim: "C-151",
    expected: "D moved after C, and one triggerUndo puts the grid back",
    pass: mv.ok && undoMove.ok && !same(undoMove.value?.moved, gridBefore) && same(undoMove.value?.after, gridBefore),
  });

  // ── M. a /slides/ link names a slide ──────────────────────────────────────
  section("M. links");
  const link = `https://www.figma.com/slides/Probe0Key/${FILE}?node-id=${A.replace(":", "-")}`;
  const viaLink = await tool("figma_set_slide_properties", { slides: [{ slideId: link, skipped: false }] });
  const unskipped = await js(`return (await figma.getNodeByIdAsync(${JSON.stringify(A)})).isSkippedSlide;`);
  record("link.slideId", viaLink, { expected: "the link resolves to A, which is unskipped", pass: viaLink.ok && viaLink.value.items[0]?.id === A && unskipped.value === false });
}

// ── cleanup: the deck as it was ─────────────────────────────────────────────

async function cleanup() {
  section("cleanup");
  const originalRows = (deckBefore ?? []).map((r) => r.id);
  record("cleanup.slides", await js(`${MSG}
const gone = []; const errors = [];
for (const id of ${JSON.stringify([...made.slides].reverse())}) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) { try { n.remove(); gone.push(id); } catch (e) { errors.push(id + ": " + msg(e)); } } }
return { gone, errors };`));
  // Rows this run made are empty now; an empty deck stays empty.
  record("cleanup.rows", await js(`${MSG}${READ_DECK}
const removed = []; const errors = [];
for (const r of [...grid.children]) { if (!${JSON.stringify(originalRows)}.includes(r.id) && r.children.length === 0) { try { r.remove(); removed.push(r.id); } catch (e) { errors.push(r.id + ": " + msg(e)); } } }
return { removed, errors };`));
  if (deckBefore && flat(deckBefore).length) {
    // Back to the original order and row names, by index.
    record("cleanup.restoreGrid", await js(`${MSG}
const want = ${JSON.stringify(deckBefore)};
const nodes = [];
for (const r of want) { const row = []; for (const id of r.slides) { const s = await figma.getNodeByIdAsync(id); if (s) row.push(s); } nodes.push(row); }
try {
  const call = typeof figma.setCanvasGrid === "function" ? "setCanvasGrid" : "setSlideGrid";
  figma[call](nodes);
  const grid = figma.currentPage.children.find((c) => c.type === "SLIDE_GRID");
  grid.children.forEach((r, i) => { if (want[i] && r.name !== want[i].name) r.name = want[i].name; });
  return { via: call };
} catch (e) { return { error: msg(e) }; }`));
  }
  await tool("figma_zoom_to", { view: "grid" });
  const after = await deckNow();
  record("deck.after", { ok: true, value: after }, {
    expected: "the slides and order the deck had before",
    pass: JSON.stringify(after.map((r) => r.slides).filter((r) => r.length)) === JSON.stringify((deckBefore ?? []).map((r) => r.slides).filter((r) => r.length)),
  });
}

// A crash still saves what was measured and puts the deck back.
try {
  await probes();
} catch (err) {
  record("crash", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
}
if (!KEEP) {
  try {
    await cleanup();
  } catch (err) {
    record("cleanup.crash", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
  }
} else {
  console.log(`\n  KEEP=1 — left ${made.slides.length} probe slide(s) in "${FILE}"`);
}

save();
await mcp.close();
const failed = records.filter((r) => r.pass === false);
console.log("\n" + "=".repeat(96));
console.log(`  probes: ${records.length}   expectations: ${records.filter((r) => r.pass !== undefined).length}   failed: ${failed.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.probe)) : ""}`);
console.log(`  results → ${path.relative(process.cwd(), OUT)}`);
console.log("=".repeat(96));
process.exit(failed.length ? 1 : 0);
