// Run the FigJam and Slides reads on real files: what a sticky, a shape, a
// connector, a table, a code block or a slide reads back as, whether the
// opaque slide grid and rows stay unread, and what figma_check_layout finds on
// a board and on a slide [C-135] [C-136] [C-145] [C-148] [C-140] [C-155] [C-156].
//
// Unit tests run against fakes, and fakes encode the author's assumptions; only
// the real Plugin API settles what a board's nodes hold. Every probe is one
// record in spikes/results/live-reads.json with the exact value or Figma's exact
// error message, so the editor table and the claims can be updated from that
// file alone.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub), with
// its own BRIDGE_ALLOW_UNVERIFIED=1, and builds its fixtures through figma_eval.
// Reads need no flag; the hub must run the current build, or the reads it
// answers are not the ones under test.
//
// Needs two files open, each with the figma-mcp bridge plugin running:
//   FigJam "fmcp-board-scratch", Slides "fmcp-deck-scratch".
//
//   node spikes/live-reads.mjs                  fully automatic
//   INTERACTIVE=1 node spikes/live-reads.mjs    also switches the deck's view by hand [C-140]
//   KEEP=1 node spikes/live-reads.mjs           leave the probe nodes in place
//
// Exit 0: every expectation about our own reads held. 1: one failed (see the
// records with pass: false). 2: the run could not start (a file, the build, eval).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
const OUT = path.join(RESULTS, "live-reads.json");
const KEEP = process.env.KEEP === "1";
const INTERACTIVE = process.env.INTERACTIVE === "1";
const FILES = { figjam: "fmcp-board-scratch", slides: "fmcp-deck-scratch" };
const LABEL = { figjam: "FigJam", slides: "Slides" };
const PROBE_NAME = "figma-mcp WP-B probe (delete me)";
// The 30 ShapeWithTextNode.shapeType values (plugin-api.d.ts:11507-11537) [C-135].
const SHAPES = [
  "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT",
  "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS",
  "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON",
  "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE",
];
const kebab = (v) => v.toLowerCase().replace(/_/g, "-");

const records = [];
const made = { figjam: [], slides: [] }; // node ids to delete at the end
const sessions = {};
const startedAt = new Date().toISOString();

/** One probe's outcome. `pass` only where our own reads make a promise; the rest are measurements. */
function record(probe, editor, outcome, extra = {}) {
  const rec = { probe, editor, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${editor.padEnd(6)} ${probe.padEnd(44)} ${shown.length > 160 ? shown.slice(0, 160) + "…" : shown}`);
  return rec;
}

/** Run `judge` on a value; a throw or `false` fails it, a string is kept as the reason. */
function verdict(judge, value) {
  try {
    const v = judge(value);
    return v === false ? { pass: false } : typeof v === "string" ? { pass: true, why: v } : { pass: true };
  } catch (err) {
    return { pass: false, why: `expectation threw: ${String(err?.message ?? err)}` };
  }
}

function save() {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-reads", startedAt, finishedAt: new Date().toISOString(), files: FILES, sessions, records }, null, 2) + "\n");
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ── connect, and check the hub runs this build ──────────────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Set((await mcp.list()).map((t) => t.name));
if (!tools.has("figma_eval")) {
  console.error("figma_eval is not registered on the spawned server (BRIDGE_TOOLSET?). It is how this run builds its fixtures.");
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
  if (s.editorType !== editor) {
    console.error(`"${file}" reports editorType "${s.editorType}", not "${editor}": open a ${LABEL[editor]} file under that name.`);
    await mcp.close();
    process.exit(2);
  }
  sessions[editor] = s.sessionId;
}

/** figma_eval in one file. The code is an async function body; `figma` and `ctx` are in scope. A null value is still a result. */
async function evalIn(editor, code, timeoutMs = 60_000) {
  const r = await mcp.call("figma_eval", { code, session: FILES[editor], timeoutMs }, { timeoutMs: timeoutMs + 30_000 });
  return r.ok ? { ok: true, value: r.data && "value" in r.data ? r.data.value : null } : { ok: false, error: r.text };
}

/** A tool call in one file: the data on success, Figma's words on failure. */
async function toolIn(editor, name, args = {}) {
  const r = await mcp.call(name, { ...args, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data ?? r.text, images: r.images } : { ok: false, error: r.text, structured: r.data };
}

/** A tool call recorded with an expectation on its value. */
async function probe(label, editor, name, args, judge) {
  const r = await toolIn(editor, name, args);
  const { images, ...outcome } = r;
  const v = r.ok && judge ? verdict(judge, r.value) : judge ? { pass: false } : {};
  record(label, editor, outcome, { tool: name, args, ...v });
  return r;
}

function savePng(r, file) {
  const img = r.images?.[0];
  if (!img) return null;
  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, file);
  fs.writeFileSync(out, Buffer.from(img.data, "base64"));
  return path.relative(process.cwd(), out);
}

/** Numeric order of node ids ("2:10" after "2:9"), the order the edge list promises. */
function idOrder(a, b) {
  const pa = a.split(/[:;I]/).filter(Boolean).map(Number);
  const pb = b.split(/[:;I]/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** A node anywhere in a design-context tree, by id. */
function findIn(tree, id) {
  if (!tree) return undefined;
  if (tree.id === id) return tree;
  for (const c of tree.children ?? []) {
    const hit = findIn(c, id);
    if (hit) return hit;
  }
  return undefined;
}

// ── FigJam ──────────────────────────────────────────────────────────────────

// Builds the board fixture in one section at a clear spot. Every step is
// guarded, so one API that differs from the typings costs one record, not the
// run. Endpoints are set after the connector is in its final parent and never
// reparented (figma-use-figjam/SKILL.md:195) [C-149].
const BUILD_BOARD = `
const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const ids = {}, errors = {}, notes = {};
const step = async (label, fn) => { try { const v = await fn(); if (v !== undefined) ids[label] = v; } catch (e) { errors[label] = msg(e); } };
const loaded = new Set();
const load = async (f) => { const k = f.family + "|" + f.style; if (!loaded.has(k)) { await figma.loadFontAsync(f); loaded.add(k); } };
const INTER = { family: "Inter", style: "Medium" };
// A sublayer's own font when it loads, else Inter Medium set first — a new connector's font is not loadable [C-148].
const writeText = async (holder, chars) => {
  let font = null;
  try { font = holder.fontName; } catch (e) {}
  let ok = false;
  if (font && typeof font === "object" && font.family) { try { await load(font); ok = true; } catch (e) {} }
  if (!ok) { await load(INTER); holder.fontName = INTER; }
  holder.characters = chars;
};
const CHARCOAL = [{ type: "SOLID", color: { r: 30 / 255, g: 30 / 255, b: 30 / 255 } }];

const wrap = figma.createSection();
wrap.name = ${JSON.stringify(PROBE_NAME)};
figma.currentPage.appendChild(wrap);
wrap.x = 60000; wrap.y = 60000;
wrap.resizeWithoutConstraints(4200, 3200);
ids.wrap = wrap.id;
const put = (node, x, y, parent = wrap) => { parent.appendChild(node); node.x = x; node.y = y; return node; };

let square, wide, authored;
await step("stickySquare", async () => { square = put(figma.createSticky(), 40, 40); await writeText(square.text, "Square sticky: ship the beta"); square.authorVisible = false; return square.id; });
await step("stickyWide", async () => { wide = put(figma.createSticky(), 340, 40); wide.isWideWidth = true; await writeText(wide.text, "Wide sticky: the longer note that needs room"); wide.authorVisible = false; return wide.id; });
await step("stickyAuthored", async () => { authored = put(figma.createSticky(), 820, 40); await writeText(authored.text, "Sticky with its author"); authored.authorVisible = true; return authored.id; });

ids.shapes = {};
const shapes = ${JSON.stringify(SHAPES)};
for (let i = 0; i < shapes.length; i++) {
  try {
    const s = put(figma.createShapeWithText(), 40 + (i % 10) * 260, 400 + Math.floor(i / 10) * 260);
    s.shapeType = shapes[i];
    await writeText(s.text, shapes[i].toLowerCase());
    ids.shapes[shapes[i]] = s.id;
  } catch (e) { errors["shape." + shapes[i]] = msg(e); }
}
const firstShape = ids.shapes.SQUARE ? await figma.getNodeByIdAsync(ids.shapes.SQUARE) : null;

const connector = async (label, setup) => step(label, async () => { const c = figma.createConnector(); wrap.appendChild(c); await setup(c); return c.id; });
await connector("connAuto", async (c) => {
  c.connectorStart = { endpointNodeId: square.id, magnet: "AUTO" };
  c.connectorEnd = { endpointNodeId: wide.id, magnet: "AUTO" };
  await writeText(c.text, "approves");
  c.text.fills = CHARCOAL;
});
await connector("connPosition", async (c) => {
  c.connectorStart = { endpointNodeId: authored.id, position: { x: 0.5, y: 1 } };
  c.connectorEnd = { endpointNodeId: firstShape.id, magnet: "TOP" };
});
await connector("connFree", async (c) => {
  c.connectorStart = { position: { x: 3000, y: 100 } };
  c.connectorEnd = { position: { x: 3400, y: 300 } };
});
await connector("connNameOnly", async (c) => {
  c.connectorStart = { endpointNodeId: wide.id, magnet: "BOTTOM" };
  c.connectorEnd = { endpointNodeId: authored.id, magnet: "BOTTOM" };
  c.name = "on approval";
});
await connector("connNoPaint", async (c) => {
  c.connectorStart = { position: { x: 3000, y: 500 } };
  c.connectorEnd = { position: { x: 3400, y: 500 } };
  await writeText(c.text, "unseen label");
  c.text.fills = [];
});
await connector("connDashed", async (c) => {
  c.connectorStart = { position: { x: 3000, y: 700 } };
  c.connectorEnd = { position: { x: 3400, y: 700 } };
  c.dashPattern = [10, 6];
});
await connector("connThick", async (c) => {
  c.connectorStart = { position: { x: 3000, y: 900 } };
  c.connectorEnd = { position: { x: 3400, y: 900 } };
  c.strokeWeight = 8;
});
await connector("connErd", async (c) => {
  c.connectorStart = { position: { x: 3000, y: 1100 } };
  c.connectorEnd = { position: { x: 3400, y: 1100 } };
  c.connectorStartStrokeCap = "ERD_ONE";
  c.connectorEndStrokeCap = "ERD_MANY";
});

await step("code", async () => { const cb = put(figma.createCodeBlock(), 40, 1300); cb.code = "const a = 1;\\nconsole.log(a);"; cb.codeLanguage = "TYPESCRIPT"; return cb.id; });

await step("table3x4", async () => {
  const t = put(figma.createTable(3, 4), 700, 1300);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) await writeText(t.cellAt(r, c).text, "r" + r + "c" + c);
  for (let c = 0; c < 4; c++) t.cellAt(0, c).fills = [{ type: "SOLID", color: { r: 227 / 255, g: 227 / 255, b: 227 / 255 } }];
  return t.id;
});
await step("table20x10", async () => {
  const t = put(figma.createTable(20, 10), 40, 1700);
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 10; c++) await writeText(t.cellAt(r, c).text, r + ":" + c);
    await ctx.yieldToHost();
  }
  return t.id;
});

await step("sectionOuter", async () => {
  const outer = put(figma.createSection(), 2700, 1400);
  outer.name = "Outer zone";
  outer.resizeWithoutConstraints(700, 500);
  const inner = figma.createSection();
  outer.appendChild(inner);
  inner.x = 40; inner.y = 80;
  inner.resizeWithoutConstraints(320, 320);
  inner.name = "Inner zone";
  ids.sectionInner = inner.id;
  const s = put(figma.createSticky(), 40, 40, inner);
  await writeText(s.text, "Nested sticky");
  ids.stickyNested = s.id;
  return outer.id;
});
await step("sectionHidden", async () => {
  const hidden = put(figma.createSection(), 2700, 2000);
  hidden.name = "Hidden zone";
  hidden.resizeWithoutConstraints(400, 300);
  const s = put(figma.createSticky(), 40, 40, hidden);
  await writeText(s.text, "Behind the curtain");
  hidden.sectionContentsHidden = true;
  return hidden.id;
});

await step("link", async () => { const l = await figma.createLinkPreviewAsync("https://www.figma.com"); put(l, 3500, 2000); notes.linkType = l.type; return l.id; });
await step("text", async () => { const t = put(figma.createText(), 2700, 2500); await writeText(t, "Plain board text"); return t.id; });

return { ids, errors, notes };`;

async function board() {
  console.log("\n-- FigJam fixture");
  const built = await evalIn("figjam", BUILD_BOARD, 300_000);
  record("fixture.build", "figjam", built.ok ? { ok: true, value: { errors: built.value?.errors, notes: built.value?.notes } } : built);
  if (!built.ok || !built.value?.ids?.wrap) return;
  const ids = built.value.ids;
  made.figjam.push(ids.wrap);

  console.log("\n-- FigJam design context");
  const ctx = await probe("design_context.wrap", "figjam", "figma_get_design_context", { nodeId: ids.wrap, depth: 4, maxNodes: 2000, maxChildrenPerNode: 100, absolute: true, maxTableCells: 100 }, (v) => v.root?.id === ids.wrap);
  const tree = ctx.ok ? ctx.value.root : undefined;
  const node = (id) => findIn(tree, id);
  const expectNode = (label, id, judge) => {
    const n = node(id);
    record(`design_context.${label}`, "figjam", n ? { ok: true, value: n } : { ok: false, error: `node ${id} not in the read` }, n ? verdict(judge, n) : { pass: false });
  };
  if (tree) {
    expectNode("stickySquare", ids.stickySquare, (n) => n.text?.characters === "Square sticky: ship the beta" && n.sticky?.wide === false && n.sticky?.authorVisible === false && n.sticky?.author === undefined);
    expectNode("stickyWide", ids.stickyWide, (n) => n.sticky?.wide === true && n.width === 416);
    expectNode("stickyAuthored", ids.stickyAuthored, (n) => n.sticky?.authorVisible === true && typeof n.sticky?.author === "string");
    const shapeTypes = Object.entries(ids.shapes ?? {}).map(([type, id]) => [type, node(id)?.shape?.type]);
    record("design_context.shapes", "figjam", { ok: true, value: Object.fromEntries(shapeTypes) }, {
      expected: "30 shapes, each type in kebab case",
      pass: shapeTypes.length === 30 && shapeTypes.every(([type, read]) => read === kebab(type)),
    });
    expectNode("connAuto", ids.connAuto, (n) => n.connector?.from === ids.stickySquare && n.connector?.to === ids.stickyWide && n.connector?.label === "approves" && n.connector?.labelVisible === true);
    // The node-relative point: whatever Figma holds is read back in the grammar the writes take [C-148].
    expectNode("connPosition", ids.connPosition, (n) => n.connector?.from?.startsWith(`${ids.stickyAuthored}@`) && n.connector?.to === `${ids.shapes?.SQUARE}@TOP`);
    expectNode("connFree", ids.connFree, (n) => /^-?[\d.]+,-?[\d.]+$/.test(n.connector?.from ?? "") && /^-?[\d.]+,-?[\d.]+$/.test(n.connector?.to ?? ""));
    expectNode("connNameOnly", ids.connNameOnly, (n) => /on approval/.test(n.connector?.labelNote ?? "") && n.name === "on approval");
    expectNode("connNoPaint", ids.connNoPaint, (n) => n.connector?.label === "unseen label" && n.connector?.labelVisible === false);
    expectNode("connDashed", ids.connDashed, (n) => n.connector?.dash === "10,6");
    expectNode("connThick", ids.connThick, (n) => n.connector?.weight === 8);
    expectNode("connErd", ids.connErd, (n) => n.connector?.startCap === "erd-one" && n.connector?.endCap === "erd-many");
    expectNode("code", ids.code, (n) => n.code?.language === "typescript" && n.code?.lines === 2);
    expectNode("table3x4", ids.table3x4, (n) => n.table?.rows === 3 && n.table?.columns === 4 && n.table?.cells?.[1]?.[2] === "r1c2" && n.table?.headerFill === "#e3e3e3" && n.children === undefined);
    expectNode("table20x10", ids.table20x10, (n) => n.table?.cellsShown === 100 && n.table?.cells?.length === 10);
    record("design_context.tableNote", "figjam", { ok: true, value: ctx.value.tableNote ?? null }, { pass: /maxTableCells=100/.test(ctx.value.tableNote ?? "") });
    expectNode("sectionHidden", ids.sectionHidden, (n) => n.contentsHidden === true);
    expectNode("sectionInner", ids.sectionInner, (n) => n.type === "SECTION" && (n.children ?? []).some((c) => c.id === ids.stickyNested));
    if (ids.link) expectNode("link", ids.link, (n) => typeof (n.link?.url ?? n.embed?.srcUrl ?? n.embed?.canonicalUrl) === "string");
    expectNode("text", ids.text, (n) => n.text?.characters === "Plain board text");
    const edges = ctx.value.connectors ?? [];
    const order = edges.map((e) => e.id);
    record("design_context.connectors", "figjam", { ok: true, value: edges }, {
      expected: "8 edges, ordered by id, endpoints named",
      pass: edges.length === 8 && order.join() === [...order].sort(idOrder).join() && edges.find((e) => e.id === ids.connAuto)?.fromName !== undefined,
    });
    // abs against the page box Figma reports for the same nodes.
    const boxes = await evalIn("figjam", `const out = {};
for (const id of ${JSON.stringify([ids.stickySquare, ids.connFree, ids.table3x4, ids.sectionInner].filter(Boolean))}) { const n = await figma.getNodeByIdAsync(id); const b = n && n.absoluteBoundingBox; out[id] = b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; }
return out;`);
    const close = (a, b) => a && b && ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) < 0.02);
    record("design_context.absolute", "figjam", boxes.ok ? { ok: true, value: { figma: boxes.value, read: Object.fromEntries(Object.keys(boxes.value ?? {}).map((id) => [id, node(id)?.abs ?? null])) } } : boxes, {
      expected: "abs equals absoluteBoundingBox",
      pass: boxes.ok && Object.entries(boxes.value ?? {}).every(([id, b]) => close(node(id)?.abs, b)),
    });
  }

  console.log("\n-- FigJam facts the typings leave open");
  // Sublayer runs: does getStyledTextSegments work on a sticky's text? [C-135]
  record("sublayer.getStyledTextSegments", "figjam", await evalIn("figjam", `const s = await figma.getNodeByIdAsync(${JSON.stringify(ids.stickySquare)});
try { const runs = s.text.getStyledTextSegments(["fontName", "fills", "fontSize"]); return { runs: runs.length, first: { fontName: runs[0] && runs[0].fontName, fontSize: runs[0] && runs[0].fontSize } }; }
catch (e) { return { throws: String(e && e.message) }; }`));
  // Does a sticky's layer name follow its text?
  record("sticky.nameMirrorsText", "figjam", await evalIn("figjam", `const out = [];
for (const id of ${JSON.stringify([ids.stickySquare, ids.stickyWide, ids.stickyAuthored].filter(Boolean))}) { const s = await figma.getNodeByIdAsync(id); out.push({ name: s.name, characters: s.text.characters, authorName: s.authorName }); }
return out;`));
  // Free endpoints: board or parent coordinates? [C-148]
  record("connector.freePointSpace", "figjam", await evalIn("figjam", `const c = await figma.getNodeByIdAsync(${JSON.stringify(ids.connFree ?? "")});
const w = await figma.getNodeByIdAsync(${JSON.stringify(ids.wrap)});
return c ? { start: c.connectorStart, end: c.connectorEnd, box: c.absoluteBoundingBox, x: c.x, y: c.y, wrapBox: w.absoluteBoundingBox } : null;`), { claim: "C-148" });
  // A new connector's defaults, read back raw [C-148].
  record("connector.defaults", "figjam", await evalIn("figjam", `const c = await figma.getNodeByIdAsync(${JSON.stringify(ids.connFree ?? "")});
let font; try { font = c.text.fontName; } catch (e) { font = { throws: String(e && e.message) }; }
return c ? { name: c.name, lineType: c.connectorLineType, startCap: c.connectorStartStrokeCap, endCap: c.connectorEndStrokeCap, strokeWeight: c.strokeWeight, labelFills: c.text.fills.length, font: typeof font === "symbol" ? "mixed" : font } : null;`), { claim: "C-148" });
  // Opaque members on board types: throw or undefined? [C-145]
  record("board.missingMembers", "figjam", await evalIn("figjam", `const out = {};
for (const [label, id] of Object.entries(${JSON.stringify({ STICKY: ids.stickySquare, CONNECTOR: ids.connAuto, TABLE: ids.table3x4, CODE_BLOCK: ids.code })})) {
  const n = await figma.getNodeByIdAsync(id); if (!n) continue;
  const r = {};
  for (const p of ["layoutMode", "effects", "children", "cornerRadius", "clipsContent"]) { try { const v = n[p]; r[p] = v === undefined ? "undefined" : Array.isArray(v) ? "array(" + v.length + ")" : typeof v; } catch (e) { r[p] = { throws: String(e && e.message) }; } }
  out[label] = r;
}
return out;`), { claim: "C-145" });

  console.log("\n-- FigJam node DTOs");
  await probe("get_node.sticky", "figjam", "figma_get_node", { nodeId: ids.stickySquare }, (v) => v.node?.text === "Square sticky: ship the beta");
  await probe("get_node.connector", "figjam", "figma_get_node", { nodeId: ids.connAuto }, (v) => v.node?.connector?.from === ids.stickySquare);
  await probe("get_node.table", "figjam", "figma_get_node", { nodeId: ids.table3x4 }, (v) => v.node?.table?.rows === 3 && v.node?.table?.columns === 4);
  await probe("get_nodes_info", "figjam", "figma_get_nodes_info", { nodeIds: [ids.stickyWide, ids.shapes?.DIAMOND, ids.code].filter(Boolean) }, (v) =>
    v.items?.every((i) => i.ok) && v.items?.[1]?.node?.shapeType === "diamond" && v.items?.[2]?.node?.language === "typescript");
  await toolIn("figjam", "figma_select", { nodeId: ids.stickyAuthored });
  await probe("get_selection", "figjam", "figma_get_selection", {}, (v) => v.nodes?.[0]?.id === ids.stickyAuthored && v.nodes?.[0]?.text === "Sticky with its author");
  await probe("scan_nodes_by_types", "figjam", "figma_scan_nodes_by_types", { types: ["STICKY", "CONNECTOR"], nodeId: ids.wrap }, (v) =>
    v.nodes?.some((n) => n.type === "STICKY" && typeof n.text === "string") && v.nodes?.some((n) => n.type === "CONNECTOR" && n.connector));
  for (const [label, id] of [["rest.sticky", ids.stickySquare], ["rest.connector", ids.connAuto]]) {
    const r = await toolIn("figjam", "figma_get_node", { nodeId: id, format: "rest" });
    record(`get_node.${label}`, "figjam", r.ok ? { ok: true, value: { chars: r.value?.chars, truncated: r.value?.truncated, keys: r.value?.rest?.document ? Object.keys(r.value.rest.document) : Object.keys(r.value?.rest ?? {}) } } : r);
  }

  console.log("\n-- FigJam scans and search");
  {
    const seen = [];
    let cursor;
    let calls = 0;
    let error;
    do {
      const r = await toolIn("figjam", "figma_scan_text_nodes", { nodeId: ids.table20x10, limit: 50, ...(cursor ? { cursor } : {}) });
      calls++;
      if (!r.ok) {
        error = r.error;
        break;
      }
      seen.push(...(r.value.nodes ?? []).map((n) => `${n.cell?.row}:${n.cell?.column}=${n.characters}`));
      cursor = r.value.nextCursor;
    } while (cursor && calls < 10);
    record("scan_text_nodes.table200", "figjam", error ? { ok: false, error } : { ok: true, value: { calls, items: seen.length, distinct: new Set(seen).size } }, {
      expected: "4 calls, 200 items, each once",
      pass: !error && calls === 4 && seen.length === 200 && new Set(seen).size === 200,
    });
  }
  await probe("scan_text_nodes.types", "figjam", "figma_scan_text_nodes", { nodeId: ids.wrap, types: ["STICKY", "CONNECTOR"], limit: 200 }, (v) =>
    v.nodes?.length > 0 && v.nodes.every((n) => n.type === "STICKY" || n.type === "CONNECTOR") && !v.nodes.some((n) => n.id === ids.connFree));
  await probe("search_nodes.text.sticky", "figjam", "figma_search_nodes", { text: "ship the beta", scope: "subtree", nodeId: ids.wrap }, (v) => v.nodes?.some((n) => n.id === ids.stickySquare));
  await probe("search_nodes.text.cell", "figjam", "figma_search_nodes", { text: "r1c2", scope: "subtree", nodeId: ids.wrap }, (v) =>
    v.nodes?.some((n) => n.id === ids.table3x4 && n.cell?.row === 1 && n.cell?.column === 2));
  await probe("get_metadata.board", "figjam", "figma_get_metadata", {}, (v) =>
    v.board?.sections?.some((s) => s.id === ids.wrap) && (v.board?.counts?.STICKY ?? 0) >= 5 && (v.board?.counts?.TABLE ?? 0) >= 2);
  await probe("get_fonts.page", "figjam", "figma_get_fonts", {}, (v) => v.fonts?.some((f) => f.family === "Inter"));

  console.log("\n-- FigJam renders and check");
  for (const [label, id] of [["sticky", ids.stickySquare], ["connector", ids.connAuto], ["section", ids.sectionOuter], ["table", ids.table3x4]]) {
    const r = await toolIn("figjam", "figma_export_node", { nodeId: id, format: "PNG", scale: 1 });
    record(`export_node.${label}`, "figjam", r.ok ? { ok: true, value: { images: r.images?.length ?? 0, png: savePng(r, `live-reads-${label}.png`) } } : r, { pass: r.ok && (r.images?.length ?? 0) > 0 });
  }
  const whole = await toolIn("figjam", "figma_export_node", { nodeId: ids.wrap, format: "PNG", scale: 0.5 });
  record("export_node.board", "figjam", whole.ok ? { ok: true, value: { png: savePng(whole, "live-reads-board.png") } } : whole, { pass: whole.ok && (whole.images?.length ?? 0) > 0 });
  await probe("check_layout.board", "figjam", "figma_check_layout", { nodeId: ids.wrap, audit: ["board"], limit: 1000 }, (v) => {
    const kinds = {};
    for (const i of v.issues ?? []) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    // The false-positive count the plan targets is zero for these two [C-156].
    return !kinds.covered && !kinds.text_collapsed ? `kinds ${JSON.stringify(kinds)}` : false;
  });

  console.log("\n-- FigJam at scale (1000 stickies) [C-124]");
  const scale = await evalIn("figjam", `const zone = figma.createSection();
zone.name = ${JSON.stringify(`${PROBE_NAME} scale`)};
figma.currentPage.appendChild(zone);
zone.x = 60000; zone.y = 64000;
zone.resizeWithoutConstraints(25 * 260 + 40, 40 * 260 + 40);
for (let i = 0; i < 1000; i++) {
  const s = figma.createSticky(); zone.appendChild(s);
  s.x = 20 + (i % 25) * 260; s.y = 20 + Math.floor(i / 25) * 260;
  if (i % 100 === 99) await ctx.yieldToHost();
}
return zone.id;`, 300_000);
  record("scale.build", "figjam", scale.ok ? { ok: true, value: scale.value } : scale);
  if (scale.ok && typeof scale.value === "string") {
    made.figjam.push(scale.value);
    for (const [label, name, args] of [
      ["scale.design_context", "figma_get_design_context", { nodeId: scale.value, maxNodes: 2000, depth: 2 }],
      ["scale.scan_text_nodes", "figma_scan_text_nodes", { nodeId: scale.value, limit: 2000 }],
      ["scale.check_layout", "figma_check_layout", { nodeId: scale.value, audit: ["board"], maxNodes: 5000 }],
      ["scale.get_metadata", "figma_get_metadata", {}],
    ]) {
      const t0 = Date.now();
      const r = await toolIn("figjam", name, args);
      record(label, "figjam", r.ok ? { ok: true, value: { ms: Date.now() - t0, nodeCount: r.value?.nodeCount, count: r.value?.count, checked: r.value?.checked, truncated: r.value?.truncated } } : r, {
        expected: "finishes, no STALLED",
        pass: r.ok,
      });
    }
  }
}

// ── Slides ──────────────────────────────────────────────────────────────────

let deckBefore = { ok: false };
let probeSlide = null;
let probeRow = null;

async function deck() {
  console.log("\n-- Slides fixture");
  deckBefore = await evalIn("slides", `const grid = figma.currentPage.children[0];
let focused = null; try { focused = figma.currentPage.focusedSlide ? figma.currentPage.focusedSlide.id : null; } catch (e) { focused = { throws: String(e && e.message) }; }
return { pageId: figma.currentPage.id, gridType: grid && grid.type, gridId: grid && grid.id, rows: grid && grid.type === "SLIDE_GRID" ? grid.children.length : null,
  slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length, focused, selection: figma.currentPage.selection.map((n) => n.id) };`);
  record("deck.before", "slides", deckBefore);
  // Append before positioning: x/y set before the final append can shift by -240 in Slides [C-146].
  const built = await evalIn("slides", `const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const s = figma.createSlide();
s.name = ${JSON.stringify(PROBE_NAME)};
const out = { slide: s.id, row: s.parent && s.parent.id, errors: {} };
try { const off = figma.createRectangle(); s.appendChild(off); off.resize(200, 200); off.x = 2200; off.y = 100; off.name = "Off slide"; out.off = off.id; } catch (e) { out.errors.off = msg(e); }
try { const b = figma.createRectangle(); s.appendChild(b); b.resize(400, 400); b.x = -100; b.y = 800; b.name = "Bleed"; b.fills = [{ type: "SOLID", color: { r: 0.15, g: 0.39, b: 0.92 } }]; out.bleed = b.id; } catch (e) { out.errors.bleed = msg(e); }
try {
  const t = figma.createText(); s.appendChild(t);
  await figma.loadFontAsync(t.fontName);
  t.fontSize = 72; t.characters = "This headline runs past the right edge of the slide"; t.textAutoResize = "WIDTH_AND_HEIGHT";
  t.x = 1500; t.y = 200; t.name = "Cut headline"; out.cut = t.id;
} catch (e) { out.errors.cut = msg(e); }
try {
  const t = figma.createText(); s.appendChild(t);
  await figma.loadFontAsync(t.fontName);
  t.fontSize = 48; t.characters = "Inside the slide"; t.x = 120; t.y = 120; t.name = "Inside"; out.inside = t.id;
} catch (e) { out.errors.inside = msg(e); }
try { figma.currentPage.focusedSlide = s; out.focused = true; } catch (e) { out.errors.focus = msg(e); }
figma.currentPage.selection = [];
return out;`);
  record("fixture.build", "slides", built);
  if (!built.ok || !built.value?.slide) return;
  const f = built.value;
  probeSlide = f.slide;
  probeRow = f.row ?? null;
  made.slides.push(f.slide);
  const gridId = deckBefore.value?.gridId;

  console.log("\n-- Slides reads");
  await probe("design_context.noSelection", "slides", "figma_get_design_context", {}, (v) =>
    (v.scope === "focusedSlide" && v.root?.id === probeSlide && v.root?.slide?.skipped === false) || (v.scope === "deck" && v.deck?.slideCount >= 1));
  if (gridId) {
    await probe("design_context.grid", "slides", "figma_get_design_context", { nodeId: gridId, depth: 3, maxNodes: 300 }, (v) => v.root?.type === "SLIDE_GRID" && v.root?.opaque === true);
    const grid = await probe("get_node.grid", "slides", "figma_get_node", { nodeId: gridId, depth: 1 }, (v) => v.node?.opaque === true && v.node?.fill === undefined);
    const rowId = probeRow ?? grid.value?.node?.children?.[0]?.id;
    if (rowId) await probe("get_node.row", "slides", "figma_get_node", { nodeId: rowId }, (v) => v.node?.type === "SLIDE_ROW" && v.node?.opaque === true);
  }
  await probe("get_node.slide", "slides", "figma_get_node", { nodeId: probeSlide }, (v) => typeof v.node?.slide?.index === "number" && v.node?.slide?.skipped === false);
  await probe("check_layout.slide", "slides", "figma_check_layout", { nodeId: probeSlide }, (v) => {
    const of = (kind) => (v.issues ?? []).filter((i) => i.kind === kind);
    return of("out_of_slide").length === 1 && of("out_of_slide")[0].nodeId === f.off
      && of("bleed").length === 1 && of("bleed")[0].nodeId === f.bleed
      && of("text_cut_by_slide").length === 1 && of("text_cut_by_slide")[0].nodeId === f.cut;
  });
  await probe("check_layout.nodeIds", "slides", "figma_check_layout", { nodeIds: [probeSlide] }, (v) => v.root?.id === probeSlide);
  await probe("check_layout.noSelection", "slides", "figma_check_layout", {}, (v) => v.root?.id === probeSlide || v.root?.type === "PAGE");
  await probe("scan_text_nodes.focused", "slides", "figma_scan_text_nodes", {}, (v) => v.nodes?.some((n) => n.characters === "Inside the slide"));
  // Walks that reach the opaque grid and rows must not read a member they lack [C-145].
  if (deckBefore.value?.pageId) {
    await probe("get_annotations.deck", "slides", "figma_get_annotations", { nodeId: deckBefore.value.pageId }, (v) => Array.isArray(v.nodes));
    await probe("scan_text_nodes.deck", "slides", "figma_scan_text_nodes", { nodeId: deckBefore.value.pageId, limit: 2000 }, (v) => v.nodes?.some((n) => n.characters === "Inside the slide"));
  }
  await probe("get_reactions.deck", "slides", "figma_get_reactions", { scope: "page" }, (v) => typeof v.count === "number");
  const meta = await probe("get_metadata.slides", "slides", "figma_get_metadata", {}, (v) =>
    v.slides?.slideCount >= 1 && v.slides?.rows?.length === v.slides?.rowCount && (v.slides?.focusedSlideId === probeSlide || v.slides?.focusedSlideId === null));
  record("get_metadata.view", "slides", { ok: true, value: { view: meta.value?.slides?.view ?? null, viewProperty: meta.value?.slides?.viewProperty ?? null } }, { claim: "C-140" });
  // Each spelling of the view, read raw [C-140].
  record("viewport.view", "slides", await evalIn("slides", `const out = {};
for (const p of ["canvasView", "slidesView", "slidesMode"]) { try { const v = figma.viewport[p]; out[p] = v === undefined ? "undefined" : v; } catch (e) { out[p] = { throws: String(e && e.message) }; } }
return out;`), { claim: "C-140" });
  if (INTERACTIVE) {
    await ask('In "fmcp-deck-scratch", switch the view (grid ↔ single slide), then press Enter ');
    const after = await toolIn("slides", "figma_get_metadata", {});
    record("get_metadata.viewAfterSwitch", "slides", after.ok ? { ok: true, value: { view: after.value?.slides?.view ?? null, viewProperty: after.value?.slides?.viewProperty ?? null } } : after, { claim: "C-140" });
  }
  const png = await toolIn("slides", "figma_export_node", { nodeId: probeSlide, format: "PNG", scale: 0.5 });
  record("export_node.slide", "slides", png.ok ? { ok: true, value: { png: savePng(png, "live-reads-slide.png") } } : png, { pass: png.ok && (png.images?.length ?? 0) > 0 });
}

// ── cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n-- cleanup");
  for (const [editor, ids] of Object.entries(made)) {
    if (!ids.length) continue;
    record("cleanup", editor, await evalIn(editor, `
const gone = [];
for (const id of ${JSON.stringify([...ids].reverse())}) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) { n.remove(); gone.push(id); } }
return gone;`, 120_000));
  }
  // An empty deck stays empty: the probe slide's row goes too when the deck had no slides.
  if (deckBefore.ok && deckBefore.value?.slides === 0 && probeRow) {
    record("cleanup.row", "slides", await evalIn("slides", `const r = await figma.getNodeByIdAsync(${JSON.stringify(probeRow)});
try { if (r && r.children.length === 0) r.remove(); return { removed: !!r }; } catch (e) { return { error: String(e && e.message) }; }`));
  }
  if (deckBefore.ok && typeof deckBefore.value?.focused === "string") {
    record("cleanup.focus", "slides", await evalIn("slides", `const s = await figma.getNodeByIdAsync(${JSON.stringify(deckBefore.value.focused)});
try { if (s) figma.currentPage.focusedSlide = s; return { restored: !!s }; } catch (e) { return { error: String(e && e.message) }; }`));
  }
  record("deck.after", "slides", await evalIn("slides", `const grid = figma.currentPage.children[0];
return { rows: grid && grid.type === "SLIDE_GRID" ? grid.children.length : null, slides: (figma.getCanvasGrid ? figma.getCanvasGrid() : figma.getSlideGrid()).flat().length };`));
}

// A crash still saves what was measured and removes what was made.
for (const [name, run] of [["board", board], ["deck", deck]]) {
  try {
    await run();
  } catch (err) {
    record(`crash.${name}`, "all", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
  }
}
if (!KEEP) {
  try {
    await cleanup();
  } catch (err) {
    record("cleanup.crash", "all", { ok: false, error: String(err?.stack ?? err) }, { expected: "no crash", pass: false });
  }
} else {
  console.log(`\nKEEP=1: left in place — ${JSON.stringify(made)}`);
}

save();
await mcp.close();
const judged = records.filter((r) => r.pass !== undefined);
const failed = judged.filter((r) => r.pass === false);
console.log(`\n${judged.length - failed.length}/${judged.length} expectations held, ${records.length} records → ${path.relative(process.cwd(), OUT)}`);
for (const f of failed) console.log(`  FAIL ${f.editor} ${f.probe}${f.why ? `: ${f.why}` : ""}`);
process.exit(failed.length ? 1 : 0);
