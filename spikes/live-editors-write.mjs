// Measure the EXISTING write tools in FigJam and Figma Slides: where a layer
// lands on a slide and whether its x/y hold [C-146], the focused slide as the
// default parent [C-136], slides cloned into their row and rows emptied by a
// delete [C-134], sections as board structure and their resize [C-141], text
// in a sticky's, shape's, connector's or table cell's sublayer and a code
// block's code [C-135] [C-147] [C-148], keepPosition and connector routing on a
// reparent [C-149], FigJam's text defaults [C-156], a section's arrange / hug
// [C-166], list levels [C-167], and the structure and style tools whose FigJam
// and Slides cells are still unmeasured, images included [C-150].
//
// Unit tests run against fakes; only this run may turn an editor cell for these
// tools to "yes" or "no", and only from spikes/results/live-editors-write.json —
// one record per probe with the exact value or Figma's exact error message.
//
// It runs as a PROXY of the hub the user's MCP client started (mcp-client.mjs
// spawns node dist/server.js, which joins the running hub), with its own
// BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this process's calls
// only, so the user's client stays strict and needs no restart. It does check
// that the hub runs the current build — an older hub has no gate and none of
// these parameters.
//
// Needs three files open, each with the figma-mcp bridge plugin running:
//   Design "fmcp-design-scratch", FigJam "fmcp-board-scratch", Slides "fmcp-deck-scratch".
// The probes work far off-canvas on the board and in their own rows of the deck.
//
//   node spikes/live-editors-write.mjs                fully automatic
//   INTERACTIVE=1 node spikes/live-editors-write.mjs  also asks you to switch the Slides view when the API cannot
//   KEEP=1 node spikes/live-editors-write.mjs         leave the probe nodes in place
//   IMAGE_URL=https://… node spikes/live-editors-write.mjs   the PNG import_image fetches
//
// Exit 0: measured, and every promise our own code makes held. 1: one did not
// (see "FAIL" lines). 2: the run could not start (a file, the build, eval).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "live-editors-write";
const OUT = path.join(HERE, "results", `${NAME}.json`);
const KEEP = process.env.KEEP === "1";
const INTERACTIVE = process.env.INTERACTIVE === "1";
const IMAGE_URL = process.env.IMAGE_URL ?? "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png";
const FILES = { figma: "fmcp-design-scratch", figjam: "fmcp-board-scratch", slides: "fmcp-deck-scratch" };
const LABEL = { figma: "Design", figjam: "FigJam", slides: "Slides" };
const PROBE = "figma-mcp WP-E probe (delete me)";
const BOARD_AT = { x: 40000, y: 40000 }; // far from anything a person put on the board

const records = [];
const made = { figma: [], figjam: [], slides: [] }; // node ids to delete at the end, in creation order
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
const sessions = {};

/** One probe's outcome. `expected`/`pass` only where our own code makes a promise; the rest is measurement. */
function record(probe, editor, outcome, extra = {}) {
  const rec = { probe, editor, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${editor.padEnd(6)} ${probe.padEnd(46)} ${shown.length > 160 ? shown.slice(0, 160) + "…" : shown}`);
  return rec;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: NAME, startedAt, finishedAt: new Date().toISOString(), files: FILES, sessions, imageUrl: IMAGE_URL, records }, null, 2) + "\n");
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ── connect, as a measuring proxy ───────────────────────────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Set((await mcp.list()).map((t) => t.name));
if (!tools.has("figma_eval")) {
  console.error("figma_eval is not registered on the spawned server (BRIDGE_TOOLSET?). It is how this run reads results back.");
  await mcp.close();
  process.exit(2);
}
const st = await mcp.call("figma_status", {});
if (!st.ok || !st.data) {
  console.error(`figma_status failed: ${st.text}`);
  await mcp.close();
  process.exit(2);
}
console.log(`role ${st.data.bridge?.role} (hub pid ${st.data.bridge?.hubPid}), allowUnverified ${st.data.bridge?.allowUnverified}`);
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

/** figma_eval in one file. The code is an async function body; `figma` is in scope. A null value is still a result. */
async function evalIn(editor, code) {
  const r = await mcp.call("figma_eval", { code, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data?.value ?? null } : { ok: false, error: r.text };
}

/** A tool call in one file, as Figma answered it: the data, or the error text and its structured form. */
async function toolIn(editor, name, args = {}) {
  const r = await mcp.call(name, { ...args, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data ?? r.text } : { ok: false, error: r.text, structured: r.data };
}

/** Remember what a create made, so the cleanup removes it. */
function keep(editor, ...ids) {
  for (const id of ids) if (typeof id === "string") made[editor].push(id);
}

/** Everything a create_from_spec call reports as made — on success, or in partial.created after a mid-way failure. */
function keepBuilt(editor, r) {
  const created = r.ok ? r.value?.created : r.structured?.partial?.created;
  keep(editor, ...(Array.isArray(created) ? created.map((c) => c.id) : []));
}

/** Each node's place, size and parent, read straight from Figma. */
async function boxes(editor, ids) {
  return evalIn(editor, `
const out = {};
for (const id of ${JSON.stringify(ids.filter(Boolean))}) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) { out[id] = null; continue; }
  const r = { type: n.type, name: n.name, parentId: n.parent && n.parent.id, parentType: n.parent && n.parent.type };
  for (const k of ["x", "y", "width", "height"]) { try { r[k] = Math.round(n[k] * 100) / 100; } catch (e) { r[k] = { throws: String(e && e.message) }; } }
  try { const t = n.absoluteTransform; r.abs = [Math.round(t[0][2] * 100) / 100, Math.round(t[1][2] * 100) / 100]; } catch (e) { r.abs = { throws: String(e && e.message) }; }
  out[id] = r;
}
return out;`);
}

const HEX = `const hex = (p) => { const c = p && p[0] && p[0].color; if (!c) return null; const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase(); return "#" + h(c.r) + h(c.g) + h(c.b); };
const msg = (e) => String(e && e.message !== undefined ? e.message : e);`;

// Set by the probes, read by the cleanup.
let deckBefore = null;
let viewBefore = null;
let focusBefore = undefined;
const probeRows = [];
let slideA = null;
let boardSection = null;

// ── Slides ──────────────────────────────────────────────────────────────────

/** A new row holding one new slide, both remembered for the cleanup. */
async function newSlide(name) {
  const r = await evalIn("slides", `
const row = figma.createSlideRow();
const grid = row.parent;
const s = figma.createSlide(grid.children.indexOf(row));
s.name = ${JSON.stringify(name)};
return { slide: s.id, row: row.id, rowIndex: grid.children.indexOf(row), parentIsRow: s.parent && s.parent.id === row.id };`);
  if (r.ok && r.value?.slide) {
    keep("slides", r.value.slide);
    probeRows.push(r.value.row);
  }
  return r;
}

/** The view, read through whichever property this Figma has [C-140]. */
const READ_VIEW = `const view = {};
for (const k of ["slidesView", "canvasView", "slidesMode"]) { try { view[k] = figma.viewport[k]; } catch (e) { view[k] = { throws: String(e && e.message) }; } }
try { const f = figma.currentPage.focusedSlide; view.focusedSlide = f ? f.id : f === null ? null : "undefined"; } catch (e) { view.focusedSlide = { throws: String(e && e.message) }; }`;

async function slidesProbes() {
  console.log("\n-- Slides");
  deckBefore = await evalIn("slides", `${READ_VIEW}
const grid = figma.currentPage.children[0];
return { view, gridType: grid && grid.type, rows: grid && grid.children.length, slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length };`);
  record("deck.before", "slides", deckBefore);
  viewBefore = deckBefore.value?.view ?? null;
  focusBefore = viewBefore?.focusedSlide;

  const a = await newSlide(PROBE);
  record("probeSlide", "slides", a);
  slideA = a.value?.slide ?? null;
  if (!slideA) return;

  // (1) the raw API, 20 times per order, in each view the API (or a person) can switch to [C-146] [C-140].
  const DRIFT = `${HEX}
const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideA)});
${READ_VIEW}
const variants = {
  xyBeforeAppend: () => { const f = figma.createFrame(); f.resize(100, 60); f.x = 100; f.y = 100; slide.appendChild(f); return [f, f]; },
  xyAfterAppend: () => { const f = figma.createFrame(); slide.appendChild(f); f.resize(100, 60); f.x = 100; f.y = 100; return [f, f]; },
  childPlacedInOrphanThenAttached: () => { const o = figma.createFrame(); o.resize(300, 200); const r = figma.createRectangle(); o.appendChild(r); r.x = 100; r.y = 100; slide.appendChild(o); return [r, o]; },
  sizeAndPaintBeforeAppend: () => { const f = figma.createFrame(); f.resize(100, 60); f.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]; slide.appendChild(f); f.x = 100; f.y = 100; return [f, f]; },
};
const out = { view, variants: {} };
for (const [name, make] of Object.entries(variants)) {
  const seen = {};
  let drifted = 0;
  let error = null;
  for (let i = 0; i < 20; i++) {
    let made;
    try { made = make(); } catch (e) { error = msg(e); break; }
    const [measured, top] = made;
    const at = [Math.round(measured.x * 100) / 100, Math.round(measured.y * 100) / 100];
    if (at[0] !== 100 || at[1] !== 100) drifted++;
    seen[at.join(",")] = (seen[at.join(",")] || 0) + 1;
    try { top.remove(); } catch (e) {}
  }
  out.variants[name] = { runs: 20, drifted, positions: seen, ...(error ? { error } : {}) };
}
return out;`;
  record("raw.order.currentView", "slides", await evalIn("slides", DRIFT), { claim: "C-146" });
  const other = viewBefore?.slidesView === "single-slide" ? "grid" : "single-slide";
  const switched = await evalIn("slides", `${READ_VIEW}
const before = view.slidesView;
try { const s = await figma.getNodeByIdAsync(${JSON.stringify(slideA)}); if (${JSON.stringify(other)} === "single-slide") figma.currentPage.focusedSlide = s; figma.viewport.slidesView = ${JSON.stringify(other)}; } catch (e) { return { before, error: String(e && e.message) }; }
const after = {}; for (const k of ["slidesView", "slidesMode"]) { try { after[k] = figma.viewport[k]; } catch (e) { after[k] = { throws: String(e && e.message) }; } }
return { before, after };`);
  record("view.switch", "slides", switched, { claim: "C-140" });
  if (!(switched.ok && switched.value?.after?.slidesView === other) && INTERACTIVE) {
    await ask(`switch "${FILES.slides}" to ${other} view by hand, then press Enter `);
  }
  record("raw.order.otherView", "slides", await evalIn("slides", DRIFT), { claim: "C-146" });

  // (2) our tools onto the slide: every x/y must read back exactly, drift [].
  console.log("\n-- (2) creates onto a slide");
  const want = {};
  const createOn = async (tool, args, at) => {
    const r = await toolIn("slides", tool, { parentId: slideA, ...args, ...at });
    const id = r.value?.id;
    keep("slides", id);
    if (id) want[id] = { tool, ...at };
    return r;
  };
  record("create_frame", "slides", await createOn("figma_create_frame", { width: 400, height: 240, background: "#F5F5F5", name: "fmcp frame" }, { x: 120, y: 80 }));
  const text = await createOn("figma_create_text", { content: "Alpha\nBeta\nGamma", fontSize: 32, name: "fmcp text" }, { x: 640, y: 80 });
  record("create_text", "slides", text);
  record("create_rectangle", "slides", await createOn("figma_create_rectangle", { width: 80, height: 40, fill: "#FF6600", name: "fmcp rect" }, { x: 120, y: 400 }));
  record("create_vector", "slides", await createOn("figma_create_vector", { path: "M0 0 L40 20 L0 40 Z", fill: "#0066FF", name: "fmcp vector" }, { x: 260, y: 400 }));
  record("import_svg", "slides", await createOn("figma_import_svg", { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#00AA55"/></svg>', name: "fmcp svg" }, { x: 360, y: 400 }));
  const placed = await boxes("slides", Object.keys(want));
  const off = Object.entries(placed.value ?? {}).filter(([id, b]) => !b || b.parentId !== slideA || b.x !== want[id].x || b.y !== want[id].y);
  record("singles.readBack", "slides", placed, { claim: "C-146", expected: "each on the slide at its x/y", pass: placed.ok && off.length === 0 });

  const spec = {
    type: "frame", name: "fmcp spec card", x: 120, y: 560, width: 720, height: 320, layout: "vertical", padding: "32", gap: 16, background: "#FFFFFF", ref: "card",
    children: [
      { type: "text", content: "Card title", fontSize: 28 },
      { type: "rectangle", name: "badge", positioning: "absolute", x: 600, y: 24, width: 80, height: 32, fill: "#FFCC00" },
      { type: "frame", name: "inner", width: 300, height: 120, background: "#EEEEEE", children: [{ type: "ellipse", name: "dot", x: 40, y: 30, width: 24, height: 24, fill: "#CC0000" }] },
    ],
  };
  const built = await toolIn("slides", "figma_create_from_spec", { parentId: slideA, spec: JSON.stringify(spec) });
  keepBuilt("slides", built);
  record("create_from_spec.nested", "slides", built, {
    claim: "C-146", expected: "drift [] and refs.card = rootId", pass: built.ok && Array.isArray(built.value?.drift) && built.value.drift.length === 0 && built.value?.refs?.card === built.value?.rootId,
  });
  if (built.ok) {
    const ids = Object.fromEntries((built.value.created ?? []).map((c) => [c.name, c.id]));
    const b = await boxes("slides", [ids["fmcp spec card"], ids.badge, ids.dot]);
    const v = b.value ?? {};
    record("create_from_spec.nested.readBack", "slides", b, {
      expected: "card 120,560; badge 600,24 (depth 1, absolute); dot 40,30 (depth 2)",
      pass: b.ok && v[ids["fmcp spec card"]]?.x === 120 && v[ids["fmcp spec card"]]?.y === 560 && v[ids.badge]?.x === 600 && v[ids.badge]?.y === 24 && v[ids.dot]?.x === 40 && v[ids.dot]?.y === 30,
    });
  }
  const roots = await toolIn("slides", "figma_create_from_spec", {
    parentId: slideA,
    spec: JSON.stringify([
      { type: "text", name: "fmcp bullets", content: "First point\nSecond point\nThird point", fontSize: 28, list: "unordered", x: 960, y: 560 },
      { type: "rectangle", name: "fmcp root rect", width: 40, height: 40, x: 960, y: 800, fill: "#333333" },
    ]),
  });
  keepBuilt("slides", roots);
  record("create_from_spec.arrayRoots", "slides", roots, { expected: "2 rootIds, drift []", pass: roots.ok && roots.value?.rootIds?.length === 2 && roots.value?.drift?.length === 0 });
  if (roots.ok) {
    record("create_from_spec.list.readBack", "slides", await evalIn("slides", `const t = await figma.getNodeByIdAsync(${JSON.stringify(roots.value.rootIds[0])});
const lines = t.characters.split("\\n"); let at = 0; const out = [];
for (const l of lines) { out.push({ line: l, list: t.getRangeListOptions(at, at + l.length) }); at += l.length + 1; }
return { x: t.x, y: t.y, parent: t.parent && t.parent.type, lines: out };`));
  }
  const fill = await toolIn("slides", "figma_create_from_spec", { parentId: slideA, spec: JSON.stringify({ type: "frame", layout: "vertical", sizing: { width: "fill" } }) });
  keepBuilt("slides", fill);
  record("create_from_spec.rootFillOnSlide", "slides", fill, { expected: "refused, nothing created", pass: !fill.ok && fill.structured?.safeToRetry === true });
  // Whether Slides creates a section, and takes one on a slide, is contradicted [C-137]: measured, no promise.
  const section = await toolIn("slides", "figma_create_from_spec", { parentId: slideA, spec: JSON.stringify({ type: "section", name: "fmcp section", width: 200, height: 120 }) });
  keepBuilt("slides", section);
  record("create_from_spec.sectionInSlides", "slides", section, { claim: "C-137" });

  // (3) no parentId: the focused slide, else a refusal that names slides.
  console.log("\n-- (3) default parent");
  const focus = await evalIn("slides", `const s = await figma.getNodeByIdAsync(${JSON.stringify(slideA)});
try { figma.currentPage.focusedSlide = s; } catch (e) { return { error: String(e && e.message) }; }
${READ_VIEW} return view;`);
  record("focus.set", "slides", focus);
  const focused = await toolIn("slides", "figma_create_rectangle", { width: 30, height: 30, name: "fmcp focused probe" });
  keep("slides", focused.value?.id);
  const where = focused.ok ? await boxes("slides", [focused.value.id]) : null;
  record("noParent.focused", "slides", focused.ok ? where : focused, {
    expected: "on the focused slide", pass: focused.ok && where?.value?.[focused.value.id]?.parentId === slideA,
  });
  const unfocus = await evalIn("slides", `try { figma.currentPage.focusedSlide = null; } catch (e) { return { error: String(e && e.message) }; }
${READ_VIEW} return view;`);
  record("focus.clear", "slides", unfocus);
  if (unfocus.ok && unfocus.value?.focusedSlide === null) {
    const count = `return figma.currentPage.findAll((n) => n.name === "fmcp unfocused probe").length;`;
    const before = await evalIn("slides", count);
    const refused = await toolIn("slides", "figma_create_rectangle", { width: 30, height: 30, name: "fmcp unfocused probe" });
    keep("slides", refused.value?.id);
    const after = await evalIn("slides", count);
    record("noParent.unfocused", "slides", refused, {
      expected: "INVALID_PARAM naming slide ids, nothing created",
      pass: !refused.ok && refused.structured?.code === "INVALID_PARAM" && /slide id/.test(refused.error ?? "") && before.value === after.value,
    });
  } else {
    record("noParent.unfocused", "slides", { ok: false, error: "skipped: focusedSlide could not be cleared" });
  }

  // (4) background, list on slide text, a row's name.
  console.log("\n-- (4) slide fills, list, row name");
  const bg = await toolIn("slides", "figma_set_fills", { nodeIds: [slideA], fills: [{ color: "#FFF7F0" }] });
  record("set_fills.slide", "slides", bg);
  record("set_fills.slide.readBack", "slides", await evalIn("slides", `${HEX} const s = await figma.getNodeByIdAsync(${JSON.stringify(slideA)}); return hex(s.fills);`), {
    expected: "#FFF7F0",
  });
  if (text.value?.id) {
    const list = await toolIn("slides", "figma_set_text_properties", { nodeIds: [text.value.id], list: "ordered" });
    record("set_text_properties.list", "slides", list);
    record("set_text_properties.list.readBack", "slides", await evalIn("slides", `const t = await figma.getNodeByIdAsync(${JSON.stringify(text.value.id)}); return t.getRangeListOptions(0, t.characters.length);`));
  }
  const rowId = a.value?.row;
  const renamed = await toolIn("slides", "figma_rename_node", { nodeId: rowId, name: "fmcp probe row" });
  record("rename_node.slideRow", "slides", renamed);
  record("rename_node.slideRow.readBack", "slides", await evalIn("slides", `const r = await figma.getNodeByIdAsync(${JSON.stringify(rowId)}); return r && r.name;`));

  // (5) clone a slide, delete a row's last slide, and what the grid places.
  console.log("\n-- (5) clone, delete, grid-placed");
  const prep = await evalIn("slides", `const s = await figma.getNodeByIdAsync(${JSON.stringify(slideA)});
const out = {}; try { s.isSkippedSlide = true; out.skipped = s.isSkippedSlide; } catch (e) { out.skippedError = String(e && e.message); }
try { if ("speakerNotes" in s) { s.speakerNotes = "fmcp notes"; out.notes = s.speakerNotes; } else out.notes = "absent"; } catch (e) { out.notesError = String(e && e.message); }
out.orphans = figma.currentPage.children.filter((c) => c.type === "SLIDE").length;
return out;`);
  record("clone.prepare", "slides", prep, { claim: "C-138" });
  const clone = await toolIn("slides", "figma_clone_node", { nodeId: slideA, name: "fmcp clone" });
  keep("slides", clone.value?.id);
  const copy = await evalIn("slides", `const out = { orphans: figma.currentPage.children.filter((c) => c.type === "SLIDE").length };
const c = ${JSON.stringify(clone.value?.id ?? null)} && await figma.getNodeByIdAsync(${JSON.stringify(clone.value?.id ?? "")});
const s = await figma.getNodeByIdAsync(${JSON.stringify(slideA)});
if (c) { out.parentType = c.parent && c.parent.type; out.sameRow = c.parent === s.parent; out.index = c.parent.children.indexOf(c); out.sourceIndex = s.parent.children.indexOf(s);
  try { out.skipped = c.isSkippedSlide; } catch (e) { out.skipped = { throws: String(e && e.message) }; }
  try { out.notes = "speakerNotes" in c ? c.speakerNotes : "absent"; } catch (e) { out.notes = { throws: String(e && e.message) }; }
  out.children = c.children.length; }
return out;`);
  record("clone_node.slide", "slides", { ok: clone.ok, value: { result: clone.value ?? null, readBack: copy.value }, ...(clone.ok ? {} : { error: clone.error }) }, {
    claim: "C-136",
    expected: "in the source's row right after it, or refused with no slide left on the page",
    pass: clone.ok ? copy.value?.parentType === "SLIDE_ROW" && copy.value?.sameRow === true && copy.value?.index === copy.value?.sourceIndex + 1 : copy.value?.orphans === prep.value?.orphans,
  });
  const gridId = (await evalIn("slides", "return figma.currentPage.children[0].id;")).value;
  const cloneGrid = await toolIn("slides", "figma_clone_node", { nodeId: gridId });
  record("clone_node.grid", "slides", cloneGrid, { expected: "refused, nothing created", pass: !cloneGrid.ok && cloneGrid.structured?.safeToRetry === true });

  const b = await newSlide("fmcp lonely slide");
  record("probeSlide.lonely", "slides", b);
  if (b.value?.slide) {
    const del = await toolIn("slides", "figma_delete_nodes", { nodeIds: [b.value.slide] });
    const rowLeft = await evalIn("slides", `const r = await figma.getNodeByIdAsync(${JSON.stringify(b.value.row)}); return r ? { type: r.type, children: r.children.length } : null;`);
    record("delete_nodes.lastSlideInRow", "slides", { ok: del.ok, value: { result: del.value ?? null, row: rowLeft.value }, ...(del.ok ? {} : { error: del.error }) }, {
      expected: "emptiedRows names the row, which stays", pass: del.ok && del.value?.emptiedRows?.includes(b.value.row) && rowLeft.value?.children === 0,
    });
    const delRow = await toolIn("slides", "figma_delete_nodes", { nodeIds: [b.value.row] });
    const rowGone = await evalIn("slides", `return !(await figma.getNodeByIdAsync(${JSON.stringify(b.value.row)}));`);
    record("delete_nodes.emptyRow", "slides", { ok: delRow.ok, value: { result: delRow.value ?? null, gone: rowGone.value }, ...(delRow.ok ? {} : { error: delRow.error }) }, {
      expected: "deleted", pass: delRow.ok && rowGone.value === true,
    });
  }
  const refusedDel = await toolIn("slides", "figma_delete_nodes", { nodeIds: [gridId, a.value.row] });
  const items = refusedDel.value?.items ?? [];
  record("delete_nodes.gridAndFullRow", "slides", refusedDel, {
    expected: "both refused per item", pass: refusedDel.ok && items.length === 2 && items.every((i) => i.ok === false),
  });
  for (const [tool, args] of [
    ["figma_move_nodes", { nodeIds: [slideA], x: 10 }],
    ["figma_reorder_nodes", { nodeIds: [slideA], position: "front" }],
    ["figma_resize_nodes", { nodeIds: [slideA], width: 800 }],
    ["figma_reparent_nodes", { nodeIds: [slideA], parentId: gridId }],
  ]) {
    const r = await toolIn("slides", tool, args);
    record(`${tool.replace("figma_", "")}.slide`, "slides", r, {
      expected: "refused (per item, or whole for a grid target)", pass: r.ok ? (r.value?.items ?? []).every((i) => i.ok === false) : r.structured?.safeToRetry === true,
    });
  }
}

// ── FigJam ──────────────────────────────────────────────────────────────────

async function boardProbes() {
  console.log("\n-- FigJam");
  const wrapper = await toolIn("figjam", "figma_create_section", { name: PROBE, ...BOARD_AT, width: 4200, height: 3200, fill: "#FFFFFF" });
  record("create_section.wrapper", "figjam", wrapper);
  boardSection = wrapper.value?.id ?? null;
  keep("figjam", boardSection);
  if (!boardSection) return;
  const inBoard = { parentId: boardSection };

  // (6) text defaults; sections three deep with fill and contentsHidden.
  console.log("\n-- (6) text defaults, nested sections");
  const t = await toolIn("figjam", "figma_create_text", { content: "Default text", fontSize: 24, x: 64, y: 40, ...inBoard });
  keep("figjam", t.value?.id);
  const tRead = t.ok ? await evalIn("figjam", `${HEX} const n = await figma.getNodeByIdAsync(${JSON.stringify(t.value.id)}); return { font: n.fontName, fill: hex(n.fills), parent: n.parent && n.parent.id };`) : t;
  record("create_text.defaults", "figjam", tRead, {
    claim: "C-156", expected: "Inter Medium, #1E1E1E", pass: tRead.ok && tRead.value?.font?.family === "Inter" && tRead.value?.font?.style === "Medium" && tRead.value?.fill === "#1E1E1E",
  });
  const zone = await toolIn("figjam", "figma_create_section", { name: "", fill: "#F5FBFF", x: 64, y: 120, width: 2000, height: 1400, ...inBoard });
  keep("figjam", zone.value?.id);
  const card = await toolIn("figjam", "figma_create_section", { name: "Card", fill: "#EBFFEE", x: 64, y: 64, width: 900, height: 600, parentId: zone.value?.id });
  keep("figjam", card.value?.id);
  const deep = await toolIn("figjam", "figma_create_section", { name: "Deep", contentsHidden: true, x: 400, y: 300, width: 300, height: 200, parentId: card.value?.id });
  keep("figjam", deep.value?.id);
  const chain = await evalIn("figjam", `${HEX}
const out = {};
for (const [label, id] of ${JSON.stringify([["zone", zone.value?.id], ["card", card.value?.id], ["deep", deep.value?.id]])}) {
  const n = id && await figma.getNodeByIdAsync(id);
  out[label] = n ? { name: n.name, parentId: n.parent && n.parent.id, fill: hex(n.fills), hidden: n.sectionContentsHidden, size: [n.width, n.height], at: [n.x, n.y] } : null;
}
return out;`);
  const c = chain.value ?? {};
  record("create_section.nested", "figjam", chain, {
    claim: "C-141",
    expected: "zone in the wrapper (name \"\", #F5FBFF), card in zone (#EBFFEE), deep in card (hidden), sizes as asked",
    pass: chain.ok && c.zone?.parentId === boardSection && c.zone?.name === "" && c.zone?.fill === "#F5FBFF" && c.card?.parentId === zone.value?.id && c.card?.fill === "#EBFFEE"
      && c.deep?.parentId === card.value?.id && c.deep?.hidden === true && c.deep?.size?.[0] === 300 && c.deep?.size?.[1] === 200,
  });

  // A section that arranges and hugs its children, from one spec [C-166].
  const zoneSpec = {
    type: "section", name: "", ref: "zone", x: 2200, y: 120, arrange: "grid:3", hug: true, padding: "32",
    children: [
      { type: "text", ref: "title", content: "Zone title", fontSize: 40 },
      ...[120, 240, 80, 200, 160].map((h, i) => ({ type: "rectangle", ref: `r${i}`, width: 240, height: h, fill: "#FFE299" })),
    ],
  };
  const z = await toolIn("figjam", "figma_create_from_spec", { spec: JSON.stringify(zoneSpec), ...inBoard });
  keepBuilt("figjam", z);
  record("create_from_spec.arrangeHug", "figjam", z, { expected: "refs for zone, title, r0–r4", pass: z.ok && Object.keys(z.value?.refs ?? {}).length === 7 });
  if (z.ok) {
    const kids = Object.entries(z.value.refs).filter(([r]) => r !== "zone").map(([, id]) => id);
    const b = await boxes("figjam", [z.value.rootId, ...kids]);
    const all = Object.values(b.value ?? {});
    const [sec, ...items] = [b.value?.[z.value.rootId], ...kids.map((id) => b.value?.[id])];
    const overlap = items.some((p, i) => items.some((q, j) => j > i && p && q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height));
    const whole = sec && items.every(Boolean);
    const right = whole ? Math.max(...items.map((p) => p.x + p.width)) + 32 : NaN;
    const bottom = whole ? Math.max(...items.map((p) => p.y + p.height)) + 32 : NaN;
    record("create_from_spec.arrangeHug.readBack", "figjam", b, {
      expected: "no overlap; the section hugs its children plus 32", pass: b.ok && whole && all.length === 7 && !overlap && Math.abs(sec.width - right) < 1 && Math.abs(sec.height - bottom) < 1,
    });
  }

  // (7) text in board nodes. The board's own create tools are another package's;
  // the nodes are made here through the Plugin API.
  console.log("\n-- (7) sublayer text");
  const nodes = await evalIn("figjam", `
const parent = await figma.getNodeByIdAsync(${JSON.stringify(boardSection)});
const out = {};
const at = (n, x, y) => { parent.appendChild(n); n.x = x; n.y = y; return n.id; };
const sticky = figma.createSticky(); await figma.loadFontAsync(sticky.text.fontName); sticky.text.characters = "fmcp sticky";
out.sticky = at(sticky, 64, 1700);
const shape = figma.createShapeWithText(); await figma.loadFontAsync(shape.text.fontName); shape.text.characters = "fmcp shape";
out.shape = at(shape, 400, 1700);
const connector = figma.createConnector(); parent.appendChild(connector);
connector.connectorStart = { endpointNodeId: sticky.id, magnet: "AUTO" }; connector.connectorEnd = { endpointNodeId: shape.id, magnet: "AUTO" };
out.connector = connector.id;
const table = figma.createTable(2, 2); out.table = at(table, 800, 1700);
for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) { const cell = table.cellAt(r, c); await figma.loadFontAsync(cell.text.fontName); cell.text.characters = "fmcp cell " + r + c; }
const code = figma.createCodeBlock(); code.code = "const fmcp = 1;"; out.code = at(code, 1300, 1700);
const sticky2 = figma.createSticky(); out.sticky2 = sticky2.id; sticky2.x = ${BOARD_AT.x + 64}; sticky2.y = ${BOARD_AT.y + 2400};
const sticky3 = figma.createSticky(); out.sticky3 = sticky3.id; sticky3.x = ${BOARD_AT.x + 400}; sticky3.y = ${BOARD_AT.y + 2400};
return out;`);
  record("board.nodes", "figjam", nodes);
  const n = nodes.value ?? {};
  keep("figjam", n.sticky, n.shape, n.connector, n.table, n.code, n.sticky2, n.sticky3);
  if (!nodes.ok) return;

  const READ_TEXTS = `${HEX}
const read = async (id) => { const x = await figma.getNodeByIdAsync(id); if (!x) return null;
  if (x.type === "CODE_BLOCK") return { code: x.code };
  if (x.type === "TABLE") { const cells = []; for (let r = 0; r < x.numRows; r++) for (let c = 0; c < x.numColumns; c++) { const t = x.cellAt(r, c).text; cells.push({ text: t.characters, size: t.fontSize }); } return { cells }; }
  const t = x.text; let font; try { font = t.fontName; } catch (e) { font = { throws: String(e && e.message) }; }
  return { text: t.characters, size: t.fontSize, font, fill: hex(t.fills) }; };`;
  for (const [label, id, content] of [["sticky", n.sticky, "Sticky set"], ["shape", n.shape, "Shape set"], ["connector", n.connector, "fmcp label"], ["code", n.code, "const fmcp = 2;"]]) {
    const r = await toolIn("figjam", "figma_set_text", { nodeId: id, content });
    const back = await evalIn("figjam", `${READ_TEXTS} return await read(${JSON.stringify(id)});`);
    const got = back.value?.text ?? back.value?.code;
    record(`set_text.${label}`, "figjam", { ok: r.ok, value: { result: r.value ?? null, readBack: back.value }, ...(r.ok ? {} : { error: r.error }) }, {
      claim: label === "connector" ? "C-148" : "C-135", expected: `reads back "${content}"`, pass: r.ok && got === content,
    });
  }
  const tableText = await toolIn("figjam", "figma_set_text", { nodeId: n.table, content: "x" });
  record("set_text.table", "figjam", tableText, { expected: "refused with figma_edit_table, nothing changed", pass: !tableText.ok && /figma_edit_table/.test(tableText.error ?? "") && tableText.structured?.safeToRetry === true });

  const props = await toolIn("figjam", "figma_set_text_properties", { nodeIds: [n.sticky, n.shape, n.connector, n.table], fontSize: 18 });
  const sized = await evalIn("figjam", `${READ_TEXTS} return { sticky: await read(${JSON.stringify(n.sticky)}), shape: await read(${JSON.stringify(n.shape)}), connector: await read(${JSON.stringify(n.connector)}), table: await read(${JSON.stringify(n.table)}) };`);
  const s = sized.value ?? {};
  record("set_text_properties.sublayers", "figjam", { ok: props.ok, value: { result: props.value ?? null, readBack: s }, ...(props.ok ? {} : { error: props.error }) }, {
    claim: "C-135", expected: "fontSize 18 on each text and every cell",
    pass: props.ok && s.sticky?.size === 18 && s.shape?.size === 18 && s.connector?.size === 18 && (s.table?.cells ?? []).every((cell) => cell.size === 18),
  });
  const align = await toolIn("figjam", "figma_set_text_properties", { nodeIds: [n.sticky], align: "center" });
  record("set_text_properties.alignOnSticky", "figjam", align, {
    expected: "a per-item error, nothing written", pass: align.ok && align.value?.items?.[0]?.ok === false,
  });

  const lines = await toolIn("figjam", "figma_set_text", { nodeId: n.sticky, content: "One\nTwo\nThree" });
  const range = await toolIn("figjam", "figma_set_text_range", { nodeId: n.sticky, match: "Two", list: "unordered", indent: 2 });
  const levels = await evalIn("figjam", `const s = await figma.getNodeByIdAsync(${JSON.stringify(n.sticky)}); const t = s.text;
return { one: [t.getRangeListOptions(0, 3), t.getRangeIndentation(0, 3)], two: [t.getRangeListOptions(4, 7), t.getRangeIndentation(4, 7)] };`);
  record("set_text_range.indent", "figjam", { ok: lines.ok && range.ok, value: { result: range.value ?? null, readBack: levels.value }, ...(range.ok ? {} : { error: range.error }) }, {
    claim: "C-167", expected: "line Two: UNORDERED at level 2", pass: range.ok && levels.value?.two?.[0]?.type === "UNORDERED" && levels.value?.two?.[1] === 2,
  });

  const fr = await toolIn("figjam", "figma_find_replace_text", { scope: "subtree", nodeId: boardSection, find: "fmcp", replace: "FMCP" });
  const after = await evalIn("figjam", `${READ_TEXTS} return { connector: await read(${JSON.stringify(n.connector)}), table: await read(${JSON.stringify(n.table)}), code: await read(${JSON.stringify(n.code)}) };`);
  record("find_replace_text.board", "figjam", { ok: fr.ok, value: { result: fr.value ?? null, readBack: after.value }, ...(fr.ok ? {} : { error: fr.error }) }, {
    expected: "label and every cell replaced, code untouched",
    pass: fr.ok && after.value?.connector?.text === "FMCP label" && (after.value?.table?.cells ?? []).every((cell) => cell.text.startsWith("FMCP")) && after.value?.code?.code === "const fmcp = 2;",
  });
  const frCode = await toolIn("figjam", "figma_find_replace_text", { scope: "subtree", nodeId: boardSection, find: "fmcp", replace: "FMCP", includeCode: true });
  const code = await evalIn("figjam", `${READ_TEXTS} return await read(${JSON.stringify(n.code)});`);
  record("find_replace_text.includeCode", "figjam", { ok: frCode.ok, value: { result: frCode.value ?? null, readBack: code.value }, ...(frCode.ok ? {} : { error: frCode.error }) }, {
    expected: "code replaced", pass: frCode.ok && code.value?.code === "const FMCP = 2;",
  });

  // (8) reparent with keepPosition and with x/y; a connector's route [C-149]; resizes.
  console.log("\n-- (8) reparent, resize");
  const before = await boxes("figjam", [n.sticky2]);
  const kp = await toolIn("figjam", "figma_reparent_nodes", { nodeIds: [n.sticky2], parentId: card.value?.id, keepPosition: true });
  const afterKp = await boxes("figjam", [n.sticky2]);
  const b0 = before.value?.[n.sticky2];
  const b1 = afterKp.value?.[n.sticky2];
  record("reparent.keepPosition", "figjam", { ok: kp.ok, value: { result: kp.value ?? null, before: b0, after: b1 }, ...(kp.ok ? {} : { error: kp.error }) }, {
    expected: "in the card, same place on the page", pass: kp.ok && b1?.parentId === card.value?.id && b0?.abs?.[0] === b1?.abs?.[0] && b0?.abs?.[1] === b1?.abs?.[1],
  });
  const xy = await toolIn("figjam", "figma_reparent_nodes", { nodeIds: [n.sticky3], parentId: card.value?.id, x: 32, y: 320 });
  const atXy = await boxes("figjam", [n.sticky3]);
  record("reparent.xy", "figjam", { ok: xy.ok, value: { result: xy.value ?? null, after: atXy.value?.[n.sticky3] }, ...(xy.ok ? {} : { error: xy.error }) }, {
    expected: "at 32,320 in the card", pass: xy.ok && atXy.value?.[n.sticky3]?.x === 32 && atXy.value?.[n.sticky3]?.y === 320,
  });
  const route = await evalIn("figjam", `const c = await figma.getNodeByIdAsync(${JSON.stringify(n.connector)}); return { start: c.connectorStart, end: c.connectorEnd, box: [c.x, c.y, c.width, c.height] };`);
  const moved = await toolIn("figjam", "figma_reparent_nodes", { nodeIds: [n.connector], parentId: zone.value?.id });
  const routeAfter = await evalIn("figjam", `const c = await figma.getNodeByIdAsync(${JSON.stringify(n.connector)}); return { start: c.connectorStart, end: c.connectorEnd, box: [c.x, c.y, c.width, c.height] };`);
  record("reparent.connector", "figjam", { ok: moved.ok, value: { result: moved.value ?? null, routeBefore: route.value, routeAfter: routeAfter.value }, ...(moved.ok ? {} : { error: moved.error }) }, {
    claim: "C-149", expected: "its item carries a warning", pass: moved.ok && typeof moved.value?.items?.[0]?.warning === "string",
  });
  const rs = await toolIn("figjam", "figma_resize_nodes", { nodeIds: [n.sticky, n.table, card.value?.id], width: 1000, height: 700 });
  const cardBox = await boxes("figjam", [card.value?.id]);
  record("resize_nodes.board", "figjam", { ok: rs.ok, value: { result: rs.value ?? null, card: cardBox.value?.[card.value?.id] }, ...(rs.ok ? {} : { error: rs.error }) }, {
    claim: "C-141", expected: "sticky and table refused per item; the card section 1000×700",
    pass: rs.ok && rs.value?.items?.[0]?.ok === false && rs.value?.items?.[1]?.ok === false && cardBox.value?.[card.value?.id]?.width === 1000 && cardBox.value?.[card.value?.id]?.height === 700,
  });
}

// ── (9) structure and style tools whose FigJam and Slides cells are unmeasured ──

async function structureProbes(editor, parentId, y) {
  console.log(`\n-- (9) structure and style in ${LABEL[editor]}`);
  const rect = async (name, x, fill) => {
    const r = await toolIn(editor, "figma_create_rectangle", { width: 80, height: 80, x, y, fill, name, parentId });
    keep(editor, r.value?.id);
    return r.value?.id;
  };
  const exists = async (id) => (await evalIn(editor, `const n = await figma.getNodeByIdAsync(${JSON.stringify(id ?? "")}); return n ? n.type : null;`)).value;
  const [g1, g2] = [await rect("fmcp g1", 64, "#FF0000"), await rect("fmcp g2", 160, "#00FF00")];
  const group = await toolIn(editor, "figma_group_nodes", { nodeIds: [g1, g2], name: "fmcp group" });
  keep(editor, group.value?.id);
  record("group_nodes", editor, { ...group, readBack: await exists(group.value?.id) });
  if (group.ok) record("ungroup_nodes", editor, await toolIn(editor, "figma_ungroup_nodes", { nodeIds: [group.value.id] }));
  const [b1, b2] = [await rect("fmcp b1", 300, "#0000FF"), await rect("fmcp b2", 340, "#0000FF")];
  const bool = await toolIn(editor, "figma_boolean_nodes", { nodeIds: [b1, b2], operation: "union", name: "fmcp union" });
  keep(editor, bool.value?.id);
  record("boolean_nodes", editor, { ...bool, readBack: await exists(bool.value?.id) });
  const [f1, f2] = [await rect("fmcp f1", 500, "#FF00FF"), await rect("fmcp f2", 540, "#FF00FF")];
  const flat = await toolIn(editor, "figma_flatten_nodes", { nodeIds: [f1, f2], name: "fmcp flat" });
  keep(editor, flat.value?.id);
  record("flatten_nodes", editor, { ...flat, readBack: await exists(flat.value?.id) });
  const m = await rect("fmcp mask", 700, "#000000");
  record("set_mask", editor, await toolIn(editor, "figma_set_mask", { nodeId: m }));
  record("set_mask.readBack", editor, await evalIn(editor, `const n = await figma.getNodeByIdAsync(${JSON.stringify(m ?? "")}); return n ? n.isMask : null;`));

  const frame = await toolIn(editor, "figma_create_frame", { width: 240, height: 160, x: 900, y, background: "#FFFFFF", name: "fmcp style frame", parentId });
  keep(editor, frame.value?.id);
  const fid = frame.value?.id;
  record("set_effects", editor, await toolIn(editor, "figma_set_effects", { nodeIds: [fid], effects: [{ type: "DROP_SHADOW", color: "#00000040", y: 4, radius: 12 }] }));
  record("set_constraints", editor, await toolIn(editor, "figma_set_constraints", { nodeIds: [fid], horizontal: "center", vertical: "top" }));
  record("set_layout_grids", editor, await toolIn(editor, "figma_set_layout_grids", { nodeIds: [fid], grids: [{ pattern: "columns", count: 4, gutter: 16 }] }));
  record("set_clips_content", editor, await toolIn(editor, "figma_set_clips_content", { nodeIds: [fid], clipsContent: true }));
  record("style.readBack", editor, await evalIn(editor, `const n = await figma.getNodeByIdAsync(${JSON.stringify(fid ?? "")});
if (!n) return null; const r = {};
for (const k of ["effects", "constraints", "layoutGrids", "clipsContent"]) { try { const v = n[k]; r[k] = Array.isArray(v) ? v.length : v; } catch (e) { r[k] = { throws: String(e && e.message) }; } }
return r;`));
  const img = await toolIn(editor, "figma_import_image", { url: IMAGE_URL, x: 1200, y, width: 184, height: 60, name: "fmcp image", parentId });
  keep(editor, img.value?.id);
  record("import_image", editor, { ...img, readBack: await exists(img.value?.id) }, { claim: "C-150" });
}

// ── renders ─────────────────────────────────────────────────────────────────

async function render(editor, nodeId, file) {
  if (!nodeId) return;
  const png = await mcp.call("figma_export_node", { nodeId, scale: editor === "figjam" ? 0.25 : 0.5, session: FILES[editor] });
  if (png.images[0]) {
    const out = path.join(HERE, "results", file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
    record("render", editor, { ok: true, value: path.relative(process.cwd(), out) });
  } else {
    record("render", editor, { ok: false, error: png.text });
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n-- cleanup");
  for (const [editor, ids] of Object.entries(made)) {
    if (!ids.length) continue;
    record("cleanup", editor, await evalIn(editor, `
const gone = [];
for (const id of ${JSON.stringify([...ids].reverse())}) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) { try { n.remove(); gone.push(id); } catch (e) {} } }
return gone;`));
  }
  if (probeRows.length) {
    record("cleanup.rows", "slides", await evalIn("slides", `const out = [];
for (const id of ${JSON.stringify(probeRows)}) { const r = await figma.getNodeByIdAsync(id); try { if (r && r.children.length === 0) { r.remove(); out.push(id); } } catch (e) { out.push({ id, error: String(e && e.message) }); } }
return out;`));
  }
  if (viewBefore) {
    record("cleanup.view", "slides", await evalIn("slides", `
try { if (${JSON.stringify(typeof focusBefore === "string" ? focusBefore : null)}) figma.currentPage.focusedSlide = await figma.getNodeByIdAsync(${JSON.stringify(typeof focusBefore === "string" ? focusBefore : "")}); } catch (e) {}
try { if (${JSON.stringify(typeof viewBefore.slidesView === "string" ? viewBefore.slidesView : null)}) figma.viewport.slidesView = ${JSON.stringify(viewBefore.slidesView ?? null)}; } catch (e) { return { error: String(e && e.message) }; }
${READ_VIEW} return view;`));
  }
  record("deck.after", "slides", await evalIn("slides", `const grid = figma.currentPage.children[0];
return { rows: grid && grid.children.length, slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length };`), {
    expected: "the rows and slides there were before the run",
    ...(deckBefore?.ok ? { before: { rows: deckBefore.value?.rows, slides: deckBefore.value?.slides } } : {}),
  });
  const last = records[records.length - 1];
  if (deckBefore?.ok && last.ok) last.pass = last.value?.rows === deckBefore.value?.rows && last.value?.slides === deckBefore.value?.slides;
}

// A crash still saves what was measured and removes what was made.
try {
  await slidesProbes();
  if (slideA) await structureProbes("slides", slideA, 900);
  await boardProbes();
  if (boardSection) await structureProbes("figjam", boardSection, 2900);
  await render("figjam", boardSection, `${NAME}-board.png`);
  await render("slides", slideA, `${NAME}-slide.png`);
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
await mcp.close();
const failed = records.filter((r) => r.pass === false);
const passed = records.filter((r) => r.pass === true);
console.log(`\n${records.length} probes → ${path.relative(process.cwd(), OUT)}; ${passed.length} promises held, ${failed.length} failed${failed.length ? `: ${failed.map((r) => `${r.editor}/${r.probe}`).join(", ")}` : ""}`);
await sleep(0);
process.exit(failed.length ? 1 : 0);
