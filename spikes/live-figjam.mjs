// Run the FigJam board tools on a real board — figma_create_stickies,
// figma_create_shapes_with_text, figma_create_connectors, figma_create_table,
// figma_create_code_block, figma_create_link_preview, figma_edit_table,
// figma_edit_connectors, figma_set_board_properties, figma_fit_sections and
// create_from_spec's board types — and read every result back through
// figma_eval: the document, not the tool's own report
// [C-132] [C-141] [C-143] [C-144] [C-147] [C-148] [C-149] [C-151] [C-156] [C-161] [C-162] [C-163].
//
// Unit tests run against fakes, and fakes encode the author's assumptions; only
// this run may turn the FigJam cells of these tools in src/shared/editors.ts to
// "yes", re-status their claims, or change a description (endpoint units, DART,
// the section palette, moveRow's `to`) — and only from what it writes to
// spikes/results/live-figjam.json: one record per probe with the exact value or
// Figma's exact error message.
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub), with
// its own BRIDGE_ALLOW_UNVERIFIED=1: the hub applies that flag to this
// process's calls only, so the user's client stays strict and needs no restart.
// It checks that the hub runs the current build — an older hub has no gate and
// no board tools.
//
// Needs two files open, each with the figma-mcp bridge plugin running:
//   FigJam "fmcp-board-scratch"; Design "fmcp-design-scratch" (figma_fit_sections there too).
// Everything is built far off-canvas, inside sections named "… (delete me)".
//
//   node spikes/live-figjam.mjs                fully automatic
//   INTERACTIVE=1 node spikes/live-figjam.mjs  also the swatch checks that need a hand in FigJam's colour picker
//   KEEP=1 node spikes/live-figjam.mjs         leave the probe nodes in place
//
// Exit 0: every expectation about our own tools held. 1: one failed (see the
// FAIL lines and the JSON). 2: the run could not start (a file, the build, eval).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-figjam.json");
const PNG = path.join(HERE, "results", "live-figjam.png");
const KEEP = process.env.KEEP === "1";
const INTERACTIVE = process.env.INTERACTIVE === "1";
const FILES = { figjam: "fmcp-board-scratch", figma: "fmcp-design-scratch" };
const LABEL = { figjam: "FigJam", figma: "Design" };
// Far from anything a person put on the scratch board.
const AREA = { x: 40000, y: 40000 };

const BOARD_TOOLS = [
  "figma_create_stickies", "figma_create_shapes_with_text", "figma_create_connectors", "figma_create_table",
  "figma_create_code_block", "figma_create_link_preview", "figma_edit_table", "figma_edit_connectors",
  "figma_set_board_properties", "figma_fit_sections",
];

// Palettes as the tools resolve them (src/plugin/figjam/palette.ts) [C-156].
const STICKY_HEX = { blue: "#A8DAFF", violet: "#D3BDFF", yellow: "#FFE299" };
const CONNECTOR_HEX = { red: "#FF7556", teal: "#5AD8CC" };
const SHAPE_PRESET = { "light-teal": { fill: "#C6FAF6", stroke: "#5AD8CC", text: "#1E1E1E" }, "light-blue": { fill: "#C2E5FF", stroke: "#3DADFF", text: "#1E1E1E" } };
const TABLE_HEX = { violet: "#874FFF", "light-yellow": "#FFECBD", "light-gray": "#D9D9D9" };
const TEXT_HEX = { blue: "#3DADFF", violet: "#9747FF" };
// Every swatch name FigJam's own picker shows, per kind, for the INTERACTIVE read-back [C-144].
const SWATCHES = {
  sticky: ["White", "Gray", "Green", "Teal", "Blue", "Violet", "Pink", "Red", "Orange", "Yellow"],
  section: ["White", "Light gray", "Light green", "Light teal", "Light blue", "Light violet", "Light pink", "Light red", "Light orange", "Light yellow"],
  connector: ["Black", "Dark gray", "Gray", "Light gray", "Green", "Teal", "Blue", "Violet", "Pink", "Red", "Orange", "Yellow", "White"],
};
const CODE_LANGUAGES = [
  "typescript", "cpp", "ruby", "css", "javascript", "html", "json", "graphql", "python", "go", "sql", "swift",
  "kotlin", "rust", "bash", "plaintext", "dart",
];

const records = [];
const made = { figjam: [], figma: [] }; // node ids to delete at the end
const exercised = new Set();
const startedAt = new Date().toISOString();
const sessions = {};

/** One probe's outcome. `expected`/`pass` only where our own code makes a promise. */
function record(probe, editor, outcome, extra = {}) {
  const rec = { probe, editor, ...outcome, ...extra };
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.ok === false ? "err " : "ok  ";
  const shown = JSON.stringify(rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${editor.padEnd(6)} ${probe.padEnd(46)} ${shown && shown.length > 150 ? shown.slice(0, 150) + "…" : shown}`);
  return rec;
}

/** Record `outcome` with a pass computed from its value; a throwing predicate is a fail with its message. */
function expectThat(probe, editor, outcome, expected, predicate, extra = {}) {
  let pass = false;
  let why;
  if (outcome.ok) {
    try {
      pass = predicate(outcome.value) === true;
    } catch (err) {
      why = String(err?.message ?? err);
    }
  }
  return record(probe, editor, outcome, { expected, pass, ...(why ? { predicateError: why } : {}), ...extra });
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-figjam", startedAt, finishedAt: new Date().toISOString(), files: FILES, sessions, exercised: [...exercised].sort(), records }, null, 2) + "\n");
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// ── connect, and check the hub, the build and the files ─────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Set((await mcp.list()).map((t) => t.name));
const missing = ["figma_eval", ...BOARD_TOOLS].filter((t) => !tools.has(t));
if (missing.length) {
  console.error(`The spawned server does not register ${missing.join(", ")}. Run npm run build after the board tools are wired (and BRIDGE_TOOLSET must include them).`);
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
    console.error(`"${file}" reports editorType "${s.editorType}", not "${editor}": open a ${LABEL[editor]} file with that name.`);
    await mcp.close();
    process.exit(2);
  }
  sessions[editor] = s.sessionId;
}

/** figma_eval in one file. The code is an async function body; `figma` is in scope. A null value is still a result. */
async function evalIn(editor, code) {
  const r = await mcp.call("figma_eval", { code, session: FILES[editor] });
  return r.ok ? { ok: true, value: r.data && "value" in r.data ? r.data.value : r.data } : { ok: false, error: r.text };
}

/** A tool call in one file, as Figma answered it. */
async function tool(editor, name, args = {}, opts = {}) {
  exercised.add(name);
  const r = await mcp.call(name, { ...args, session: FILES[editor] }, opts);
  return r.ok ? { ok: true, value: r.data ?? r.text } : { ok: false, error: r.text, structured: r.data };
}

/** Remember what a create made, so the cleanup removes it even after a crash. */
function keep(editor, ids) {
  for (const id of ids) if (typeof id === "string" && !made[editor].includes(id)) made[editor].push(id);
}
/** The ids a create reports: created[] or id on success, partial.created on a failure part-way. */
const idsOf = (out) => {
  const asId = (c) => (typeof c === "string" ? c : c?.id);
  if (!out.ok) return (out.structured?.partial?.created ?? []).map(asId).filter((id) => typeof id === "string");
  if (Array.isArray(out.value?.created)) return out.value.created.map(asId).filter((id) => typeof id === "string");
  return typeof out.value?.id === "string" ? [out.value.id] : [];
};

// A node read back, defensively: every member in a try, because a member a
// node does not have may throw [C-145].
const READ = `
const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const safe = (f) => { try { const v = f(); return typeof v === "symbol" ? "mixed" : v; } catch (e) { return { throws: msg(e) }; } };
const hx = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const paint = (p) => Array.isArray(p) ? p.map((x) => x.type === "SOLID" ? hx(x.color) + (x.opacity !== undefined && x.opacity !== 1 ? "@" + x.opacity : "") : x.type) : p;
const text = (t) => t ? { characters: safe(() => t.characters), fontName: safe(() => t.fontName), fontSize: safe(() => t.fontSize), fills: safe(() => paint(t.fills)) } : null;
const cellsOf = (n) => {
  const rows = safe(() => n.numRows), cols = safe(() => n.numColumns);
  if (typeof rows !== "number" || typeof cols !== "number") return null;
  const grid = [], fills = [], textFills = [], widths = [], heights = [];
  for (let r = 0; r < rows; r++) {
    grid.push([]); fills.push([]); textFills.push([]);
    for (let c = 0; c < cols; c++) {
      const cell = n.cellAt(r, c);
      grid[r].push(safe(() => cell.text.characters));
      fills[r].push(safe(() => paint(cell.fills)));
      textFills[r].push(safe(() => paint(cell.text.fills)));
    }
    heights.push(safe(() => n.cellAt(r, 0).height));
  }
  for (let c = 0; c < cols; c++) widths.push(safe(() => n.cellAt(0, c).width));
  const first = n.cellAt(0, 0);
  return { rows, cols, grid, fills, textFills, widths, heights, cellFont: safe(() => first.text.fontName), cellFontSize: safe(() => first.text.fontSize),
    cellHasId: safe(() => "id" in first), cellId: safe(() => first.id) };
};
async function info(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return { id, missing: true };
  const o = { id, type: n.type, name: n.name, parent: n.parent ? n.parent.id : null, parentType: n.parent ? n.parent.type : null,
    x: safe(() => n.x), y: safe(() => n.y), width: safe(() => n.width), height: safe(() => n.height), abs: safe(() => n.absoluteBoundingBox) };
  if (n.type === "STICKY") Object.assign(o, { wide: safe(() => n.isWideWidth), authorVisible: safe(() => n.authorVisible), authorName: safe(() => n.authorName), fills: safe(() => paint(n.fills)), text: text(n.text) });
  if (n.type === "SHAPE_WITH_TEXT") Object.assign(o, { shapeType: safe(() => n.shapeType), fills: safe(() => paint(n.fills)), strokes: safe(() => paint(n.strokes)), text: text(n.text) });
  if (n.type === "CONNECTOR") Object.assign(o, { start: safe(() => n.connectorStart), end: safe(() => n.connectorEnd), lineType: safe(() => n.connectorLineType),
    startCap: safe(() => n.connectorStartStrokeCap), endCap: safe(() => n.connectorEndStrokeCap), strokes: safe(() => paint(n.strokes)),
    weight: safe(() => n.strokeWeight), dash: safe(() => n.dashPattern), text: text(n.text), labelBackground: safe(() => paint(n.textBackground.fills)) });
  if (n.type === "TABLE") Object.assign(o, { fills: safe(() => paint(n.fills)), table: cellsOf(n) });
  if (n.type === "CODE_BLOCK") Object.assign(o, { code: safe(() => n.code), language: safe(() => n.codeLanguage) });
  if (n.type === "SECTION") Object.assign(o, { fills: safe(() => paint(n.fills)), contentsHidden: safe(() => n.sectionContentsHidden), children: safe(() => n.children.map((c) => c.id)) });
  if (n.type === "TEXT") Object.assign(o, { fills: safe(() => paint(n.fills)), characters: safe(() => n.characters) });
  if (n.type === "EMBED") Object.assign(o, { data: safe(() => n.embedData) });
  if (n.type === "LINK_UNFURL") Object.assign(o, { data: safe(() => n.linkUnfurlData) });
  return o;
}`;

/** Read nodes back in one call; the value is the list of info() records. */
const readBack = (editor, ids) => evalIn(editor, `${READ}\nconst out = []; for (const id of ${JSON.stringify(ids)}) out.push(await info(id)); return out;`);

const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const noOverlap = (nodes) => nodes.every((a, i) => nodes.slice(i + 1).every((b) => apart(a, b)));
const pageCount = async (editor) => (await evalIn(editor, "return figma.currentPage.children.length;")).value;

// Set by the probes, read by the summary.
let probeSection = null;

async function probes() {
  // ── setup: one scratch section on the board ─────────────────────────────────

  console.log("\n-- setup");
  const setup = await evalIn("figjam", `
const s = figma.createSection();
s.name = "figma-mcp WP-C probe (delete me)";
s.x = ${AREA.x}; s.y = ${AREA.y};
s.resizeWithoutConstraints(4200, 3600);
return { id: s.id, editorType: figma.editorType };`);
  record("setup.section", "figjam", setup);
  if (!setup.ok || typeof setup.value?.id !== "string") throw new Error(`could not make the probe section: ${setup.error}`);
  probeSection = setup.value.id;
  keep("figjam", [probeSection]);

  // ── (0) what the official notes claim about writes on a fresh node ──────────

  console.log("\n-- (0) fresh nodes");
  record("fresh.defaults", "figjam", await evalIn("figjam", `${READ}
const sticky = figma.createSticky(), shape = figma.createShapeWithText(), conn = figma.createConnector(), code = figma.createCodeBlock();
const out = { sticky: await info(sticky.id), shape: await info(shape.id), connector: await info(conn.id), code: await info(code.id) };
// Whether text.fills needs the font loaded, as the official table recipe implies (create-table.md:244) [C-163].
try { sticky.text.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }]; out.stickyTextFillsUnloaded = "ok"; } catch (e) { out.stickyTextFillsUnloaded = { throws: msg(e) }; }
// A fresh connector's label font: does loading it fail (create-connector.md:109) [C-148]?
try { await figma.loadFontAsync(conn.text.fontName); out.connectorFontLoads = true; } catch (e) { out.connectorFontLoads = { throws: msg(e) }; }
for (const n of [sticky, shape, conn, code]) n.remove();
return out;`), { claim: ["C-147", "C-148", "C-163"] });

  // ── (1) stickies ────────────────────────────────────────────────────────────

  console.log("\n-- (1) stickies");
  const long = Array.from({ length: 120 }, (_, i) => ["plan", "ship", "learn", "retro", "vote"][i % 5]).join(" ");
  const stickies = await tool("figjam", "figma_create_stickies", {
    stickies: [
      { text: "Plain sticky", name: "fmcp sticky plain" },
      { text: "Blue by name", color: "blue", authorVisible: false },
      { text: "Wide, hex green", color: "#B3EFBD", wide: true },
      { text: long, color: "yellow" },
    ],
    parentId: probeSection, x: 40, y: 40, columns: 2, gap: 64, idempotencyKey: `fmcp-figjam-stickies-${startedAt}`,
  });
  keep("figjam", idsOf(stickies));
  record("create_stickies", "figjam", stickies, { tool: "figma_create_stickies" });
  const stickyIds = idsOf(stickies);
  const stickyBack = await readBack("figjam", stickyIds);
  expectThat("create_stickies.readBack", "figjam", stickyBack, "240×240 plain; wide 416; long text taller than 240; exact palette hex; in the section; no overlap; text set",
    (v) => v.length === 4 && v.every((n) => n.parent === probeSection)
      && v[0].width === 240 && v[2].wide === true && v[2].width === 416 && v[3].height > 240
      && v[1].fills[0] === STICKY_HEX.blue && v[2].fills[0] === "#B3EFBD" && v[3].fills[0] === STICKY_HEX.yellow
      && v[1].authorVisible === false && v[3].text.characters.length === long.length
      && noOverlap(v), { tool: "figma_create_stickies", claim: ["C-147", "C-156"] });
  // The tool reports what the document says.
  expectThat("create_stickies.report=document", "figjam", stickies, "created[] boxes equal the read-back boxes", (v) =>
    stickyBack.ok && v.created.every((c, i) => Math.abs(c.x - stickyBack.value[i].x) < 0.5 && Math.abs(c.height - stickyBack.value[i].height) < 0.5));
  // The same key again replays the result and makes nothing new.
  const replay = await tool("figjam", "figma_create_stickies", {
    stickies: [{ text: "Plain sticky" }], parentId: probeSection, idempotencyKey: `fmcp-figjam-stickies-${startedAt}`,
  });
  const sectionKids = await evalIn("figjam", `return (await figma.getNodeByIdAsync(${JSON.stringify(probeSection)})).children.length;`);
  expectThat("create_stickies.idempotencyKey", "figjam", replay, "the same ids back, no new node", (v) =>
    JSON.stringify(idsOf({ ok: true, value: v })) === JSON.stringify(stickyIds) && sectionKids.value === 4);
  // No parent and no x/y: right of everything on the page.
  const right = await evalIn("figjam", "let r = -Infinity; for (const n of figma.currentPage.children) r = Math.max(r, n.x + n.width); return r;");
  const loose = await tool("figjam", "figma_create_stickies", { stickies: [{ text: "Placed beside the board" }] });
  keep("figjam", idsOf(loose));
  expectThat("create_stickies.defaultPlace", "figjam", loose, "x ≥ the page content's right edge + 200, on the page", (v) =>
    v.created[0].x >= right.value + 199 && v.note === undefined, { pageRightBefore: right.value });
  // One undo step per call [C-151]: three stickies, one triggerUndo, all three gone, the probe section stays.
  const three = await tool("figjam", "figma_create_stickies", { stickies: [{ text: "u1" }, { text: "u2" }, { text: "u3" }], parentId: probeSection, x: 40, y: 2400 });
  keep("figjam", idsOf(three));
  const undo = await evalIn("figjam", `figma.triggerUndo();
const ids = ${JSON.stringify(idsOf(three))};
const gone = []; for (const id of ids) gone.push(!(await figma.getNodeByIdAsync(id)));
return { gone, sectionStays: !!(await figma.getNodeByIdAsync(${JSON.stringify(probeSection)})), stickiesStay: !!(await figma.getNodeByIdAsync(${JSON.stringify(stickyIds[0] ?? "")})) };`);
  expectThat("create_stickies.oneUndoStep", "figjam", undo, "triggerUndo removes all three and nothing older", (v) => v.gone.every(Boolean) && v.sectionStays && v.stickiesStay, { claim: "C-151" });
  // Placement in a frame, and in an auto-layout frame, when FigJam lets a plugin make one.
  // Every id is returned the moment its frame exists, so a throw later in the probe still gets it cleaned up.
  const frames = await evalIn("figjam", `const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const out = { ids: [] };
try {
  const f = figma.createFrame(); out.ids.push(f.id); f.name = "fmcp plain frame (delete me)"; f.x = ${AREA.x}; f.y = ${AREA.y + 3800}; f.resize(400, 300); out.plain = f.id;
} catch (e) { out.plainError = msg(e); }
try {
  const a = figma.createFrame(); out.ids.push(a.id); a.name = "fmcp auto-layout frame (delete me)"; a.x = ${AREA.x + 800}; a.y = ${AREA.y + 3800};
  a.layoutMode = "HORIZONTAL"; a.itemSpacing = 24; a.primaryAxisSizingMode = "AUTO"; a.counterAxisSizingMode = "AUTO"; out.auto = a.id;
} catch (e) { out.autoError = msg(e); }
return out;`);
  record("frames.create", "figjam", frames);
  keep("figjam", frames.value?.ids ?? []);
  if (typeof frames.value?.plain === "string") {
    const inFrame = await tool("figjam", "figma_create_stickies", { stickies: [{ text: "In a frame" }, { text: "Two" }], parentId: frames.value.plain });
    keep("figjam", idsOf(inFrame));
    // 32 + 240 + 64 + 240 = 576 against a 400-wide frame.
    expectThat("create_stickies.inFrame", "figjam", inFrame, "inset 32 in an empty frame; the overflow reported, the frame not resized", (v) =>
      v.created[0].x === 32 && v.created[0].y === 32 && v.parentOverflow?.right === 176);
    expectThat("create_stickies.inFrame.notResized", "figjam", await readBack("figjam", [frames.value.plain]), "still 400×300", (v) => v[0].width === 400 && v[0].height === 300);
  }
  if (typeof frames.value?.auto === "string") {
    const refused = await tool("figjam", "figma_create_stickies", { stickies: [{ text: "x" }], parentId: frames.value.auto, x: 10 });
    expectThat("create_stickies.autoLayoutXY", "figjam", { ok: true, value: refused }, "x under auto-layout refused, nothing made", (v) => !v.ok && v.structured?.partial?.failedAt === "x");
    const inAuto = await tool("figjam", "figma_create_stickies", { stickies: [{ text: "Auto one" }, { text: "Auto two" }], parentId: frames.value.auto });
    keep("figjam", idsOf(inAuto));
    expectThat("create_stickies.inAutoLayout", "figjam", inAuto, "placed by the auto-layout, said in the note", (v) => /auto-layout/.test(v.note ?? ""));
  }

  // ── (2) shapes with text ────────────────────────────────────────────────────

  console.log("\n-- (2) shapes");
  const textsBefore = await evalIn("figjam", "return figma.currentPage.findAll((n) => n.type === 'TEXT').length;");
  const shapes = await tool("figjam", "figma_create_shapes_with_text", {
    shapes: [
      { shape: "diamond", text: "Ship it?" },
      { shape: "rounded-rectangle", text: "Collect every piece of feedback from the last three sprints and group it by theme", name: "fmcp long step" },
      { shape: "label", text: "1", color: "blue" },
      { shape: "label", text: "AB" },
      { shape: "eng-database", text: "Orders DB", color: "light-teal" },
      { shape: "square", text: "Fixed", width: 140, height: 90, fill: "#FFECBD", stroke: "#FFC943", textColor: "#1E1E1E", fontSize: 18 },
    ],
    parentId: probeSection, x: 40, y: 1100, columns: 3, gap: 40,
  });
  keep("figjam", idsOf(shapes));
  record("create_shapes_with_text", "figjam", shapes, { tool: "figma_create_shapes_with_text" });
  const shapeBack = await readBack("figjam", idsOf(shapes));
  expectThat("create_shapes_with_text.readBack", "figjam", shapeBack, "types set; labels 48/64 at 20 px; fitted shapes at least 200×120 (320×192 for a diamond); preset paints exact; fixed size kept",
    (v) => v.length === 6 && v[0].shapeType === "DIAMOND" && v[0].width >= 320 && v[1].width >= 200 && v[1].height >= 120
      && v[2].shapeType === "ELLIPSE" && v[2].width === 48 && v[2].text.fontSize === 20 && v[3].width === 64
      && v[4].shapeType === "ENG_DATABASE" && v[4].fills[0] === SHAPE_PRESET["light-teal"].fill && v[4].strokes[0] === SHAPE_PRESET["light-teal"].stroke && v[4].text.fills[0] === SHAPE_PRESET["light-teal"].text
      && v[5].width === 140 && v[5].height === 90 && v[5].fills[0] === "#FFECBD" && v[5].text.fontSize === 18 && noOverlap(v), { tool: "figma_create_shapes_with_text", claim: "C-163" });
  const textsAfter = await evalIn("figjam", "return figma.currentPage.findAll((n) => n.type === 'TEXT').length;");
  expectThat("create_shapes_with_text.measurerRemoved", "figjam", textsAfter, "no TEXT node left behind by the measurer", (v) => v === textsBefore.value);
  const tooLong = await tool("figjam", "figma_create_shapes_with_text", { shapes: [{ shape: "label", text: "123" }], parentId: probeSection });
  expectThat("create_shapes_with_text.label3", "figjam", { ok: true, value: tooLong }, "a 3-character label refused before any node", (v) => !v.ok && v.structured?.partial?.created?.length === 0);

  // ── (3) connectors ──────────────────────────────────────────────────────────

  console.log("\n-- (3) connectors");
  const [s0, s1, s2, s3] = stickyIds;
  const textNode = await evalIn("figjam", `const t = figma.createText(); await figma.loadFontAsync({ family: "Inter", style: "Medium" });
t.fontName = { family: "Inter", style: "Medium" }; t.characters = "A text node"; const s = await figma.getNodeByIdAsync(${JSON.stringify(probeSection)});
s.appendChild(t); t.x = 1100; t.y = 2400; return t.id;`);
  record("setup.text", "figjam", textNode);
  if (typeof textNode.value === "string") keep("figjam", [textNode.value]);
  // Node to node: the default parent, every style field and a label.
  const conns = await tool("figjam", "figma_create_connectors", {
    connectors: [
      { from: s0, to: s1, name: "fmcp default connector" },
      { from: `${s0}@bottom`, to: `${s2}@left`, label: "next", labelBackground: "#FFFFFF", color: "red", dash: "dashed", weight: 3, lineType: "straight", startCap: "circle-filled", endCap: "triangle-filled" },
    ],
  });
  keep("figjam", idsOf(conns));
  record("create_connectors", "figjam", conns, { tool: "figma_create_connectors" });
  const [connDefault, connStyled] = idsOf(conns);
  // Each unsettled endpoint form in its own call, so a refusal there costs nothing else.
  // The node-relative point: 0–1 of the node, or pixels? [C-148]
  const rel = await tool("figjam", "figma_create_connectors", { connectors: [{ from: `${s3}@0.5,1`, to: `${s1}@1,0.5`, lineType: "curved" }] });
  keep("figjam", idsOf(rel));
  record("create_connectors.relativePoint", "figjam", rel, { tool: "figma_create_connectors" });
  const [connRel] = idsOf(rel);
  // A free point, in a section given as parentId: page or parent coordinates? [C-148]
  const free = await tool("figjam", "figma_create_connectors", { connectors: [{ from: `${s2}@right`, to: "300,2300", dash: "dotted" }], parentId: probeSection });
  keep("figjam", idsOf(free));
  record("create_connectors.freePoint", "figjam", free, { tool: "figma_create_connectors" });
  const [connFree] = idsOf(free);
  const connBack = await readBack("figjam", [connDefault, connStyled].filter(Boolean));
  expectThat("create_connectors.readBack", "figjam", connBack, "default parent = the section holding both ends; caps and line type written; label font, characters and a visible fill; paints exact",
    (v) => v[0].parent === probeSection && v[0].lineType === "ELBOWED" && v[0].startCap === "NONE" && v[0].endCap === "ARROW_LINES"
      && v[1].lineType === "STRAIGHT" && v[1].startCap === "CIRCLE_FILLED" && v[1].endCap === "TRIANGLE_FILLED" && v[1].strokes[0] === CONNECTOR_HEX.red
      && v[1].weight === 3 && JSON.stringify(v[1].dash) === "[10,5]" && v[1].text.characters === "next" && v[1].text.fontName.family === "Inter"
      && Array.isArray(v[1].text.fills) && v[1].text.fills.length > 0 && v[1].labelBackground[0] === "#FFFFFF"
      && v[0].start.endpointNodeId === s0 && v[1].start.magnet === "BOTTOM" && v[1].end.magnet === "LEFT", { tool: "figma_create_connectors", claim: ["C-148", "C-149"] });
  expectThat("create_connectors.freePoint.readBack", "figjam", await readBack("figjam", [connFree].filter(Boolean)), "in the section given; dotted", (v) =>
    v[0].parent === probeSection && JSON.stringify(v[0].dash) === "[2,4]" && v[0].end.position?.x === 300);
  // The raw geometry that settles the endpoint units: the connector's box against its nodes' boxes.
  record("connector.endpointUnits", "figjam", await evalIn("figjam", `${READ}
return { relative: await info(${JSON.stringify(connRel ?? "")}), from: await info(${JSON.stringify(s3 ?? "")}), to: await info(${JSON.stringify(s1 ?? "")}),
  free: await info(${JSON.stringify(connFree ?? "")}), section: await info(${JSON.stringify(probeSection)}) };`), {
    claim: "C-148",
    note: "relative.abs against from.abs: a start at from's bottom-centre means 0–1, one near from's top-left means pixels. free.abs against section.abs: an end near section + (300, 2300) means parent coordinates, near (300, 2300) on the page means page coordinates.",
  });
  // Attaching to a section and to a TEXT node — in their own call, so a refusal there costs nothing above.
  const attach = await tool("figjam", "figma_create_connectors", {
    connectors: [{ from: s3, to: probeSection }, ...(typeof textNode.value === "string" ? [{ from: s1, to: textNode.value, endCap: "arrow-equilateral" }] : [])],
  });
  keep("figjam", idsOf(attach));
  record("create_connectors.toSectionAndText", "figjam", attach, { tool: "figma_create_connectors", note: "whether Figma lets a connector end on a SECTION (its own parent here) and on a TEXT node" });
  if (attach.ok) {
    record("create_connectors.toSectionAndText.readBack", "figjam", await readBack("figjam", idsOf(attach)));
  }
  // The six ERD caps render (see the PNG).
  const erd = ["erd-zero-or-one", "erd-exactly-one", "erd-zero-or-more", "erd-one-or-more", "erd-one", "erd-many"];
  const erdConns = await tool("figjam", "figma_create_connectors", {
    connectors: erd.map((cap, i) => ({ from: `${600 + i * 40},${2900}`, to: `${600 + i * 40},${3200}`, startCap: cap, endCap: cap, lineType: "straight" })),
    parentId: probeSection,
  });
  keep("figjam", idsOf(erdConns));
  const erdBack = await readBack("figjam", idsOf(erdConns));
  expectThat("create_connectors.erdCaps", "figjam", erdBack, "each ERD cap reads back as written", (v) => v.every((c, i) => c.endCap === erd[i].toUpperCase().replace(/-/g, "_")), { tool: "figma_create_connectors" });
  // Attaching to a connector stays refused until measured [C-148].
  const onConn = await tool("figjam", "figma_create_connectors", { connectors: [{ from: s0, to: connDefault }] });
  expectThat("create_connectors.toConnectorRefused", "figjam", { ok: true, value: onConn }, "refused, nothing made", (v) => !v.ok && v.structured?.partial?.created?.length === 0);
  // A reparented connector keeps stale elbows? [C-149] — through figma_eval, never through our tools.
  record("connector.reparentRoute", "figjam", await evalIn("figjam", `${READ}
const a = await figma.getNodeByIdAsync(${JSON.stringify(s0 ?? "")}), b = await figma.getNodeByIdAsync(${JSON.stringify(s2 ?? "")});
const c = figma.createConnector(); c.connectorLineType = "ELBOWED";
c.connectorStart = { endpointNodeId: a.id, magnet: "TOP" }; c.connectorEnd = { endpointNodeId: b.id, magnet: "BOTTOM" };
const onPage = await info(c.id);
const s = await figma.getNodeByIdAsync(${JSON.stringify(probeSection)}); s.appendChild(c);
const inSection = await info(c.id);
c.remove();
return { onPage: onPage.abs, inSection: inSection.abs, parentAfter: inSection.parent };`), { claim: "C-149" });
  // Re-pointing an end through figma_edit_connectors: does the route refresh? [C-149]
  const beforeEdit = await readBack("figjam", [connDefault]);
  const edit = await tool("figjam", "figma_edit_connectors", {
    connectors: [
      { nodeId: connDefault, to: `${s3}@top`, from: `${s0}@right`, label: "re-pointed", lineType: "curved", startCap: "arrow-lines", endCap: "diamond-filled", color: "teal", weight: 4, dash: "4,4", labelBackground: "#FFE299" },
      { nodeId: s0, color: "red" },
    ],
  });
  record("edit_connectors", "figjam", edit, { tool: "figma_edit_connectors" });
  const afterEdit = await readBack("figjam", [connDefault]);
  expectThat("edit_connectors.readBack", "figjam", afterEdit, "every named field written; a non-connector is a per-item error", (v) =>
    edit.value.items[0].ok && !edit.value.items[1].ok && v[0].end.endpointNodeId === s3 && v[0].end.magnet === "TOP" && v[0].start.magnet === "RIGHT"
      && v[0].lineType === "CURVED" && v[0].startCap === "ARROW_LINES" && v[0].endCap === "DIAMOND_FILLED" && v[0].strokes[0] === CONNECTOR_HEX.teal
      && v[0].weight === 4 && JSON.stringify(v[0].dash) === "[4,4]" && v[0].text.characters === "re-pointed" && v[0].labelBackground[0] === "#FFE299",
    { tool: "figma_edit_connectors", routeBefore: beforeEdit.value?.[0]?.abs ?? null, routeAfter: afterEdit.value?.[0]?.abs ?? null, claim: "C-149" });

  // ── (4) tables ──────────────────────────────────────────────────────────────

  console.log("\n-- (4) tables");
  const tableA = await tool("figjam", "figma_create_table", {
    rows: [["Name", "Role", "Team"], ["Ada", "Engineer", "Core"], ["Grace", "Engineer", "Compilers"]],
    headerColor: "violet", fill: "light-gray", columnWidths: [40, 220, 160], rowHeights: [48, 40, 40],
    name: "fmcp table A", parentId: probeSection, x: 1100, y: 40,
  });
  keep("figjam", idsOf(tableA));
  record("create_table.rows", "figjam", tableA, { tool: "figma_create_table" });
  const aBack = await readBack("figjam", idsOf(tableA));
  expectThat("create_table.rows.readBack", "figjam", aBack, "data in every cell; header violet with white text; table fill light-gray; widths reported as read back (column 0 clamped up)",
    (v) => v[0].parent === probeSection && v[0].table.grid[2][2] === "Compilers" && v[0].table.fills[0][0][0] === TABLE_HEX.violet
      && v[0].table.textFills[0][1][0] === "#FFFFFF" && v[0].fills[0] === TABLE_HEX["light-gray"]
      && JSON.stringify(tableA.value.columnWidths) === JSON.stringify(v[0].table.widths) && v[0].table.widths[0] >= 40,
    { tool: "figma_create_table", claim: ["C-161", "C-163"], note: "table.cellHasId / cellId say whether a cell has an id at runtime; widths[0] is the minimum column width" });
  const tableB = await tool("figjam", "figma_create_table", { numRows: 3, numColumns: 4, header: false, fontFamily: "Inter", weight: "600", fontSize: 18, parentId: probeSection, x: 1100, y: 600 });
  keep("figjam", idsOf(tableB));
  const bBack = await readBack("figjam", idsOf(tableB));
  expectThat("create_table.empty.readBack", "figjam", bBack, "3×4, no text anywhere, every cell in Inter Semi Bold 18", (v) =>
    v[0].table.rows === 3 && v[0].table.cols === 4 && v[0].table.grid.flat().every((t) => t === "") && v[0].table.cellFont.style === "Semi Bold" && v[0].table.cellFontSize === 18,
    { tool: "figma_create_table" });
  // Structure first: removals, inserts, a column move, sizes.
  const tA = idsOf(tableA)[0];
  const edit1 = await tool("figjam", "figma_edit_table", {
    nodeId: tA, removeRows: [2], insertRowsAt: [1], insertColumnsAt: [3], moveColumn: { from: 3, to: 0 },
    columnWidths: [{ index: 0, width: 120 }], rowHeights: [{ index: 0, height: 56 }],
  });
  record("edit_table.structure", "figjam", edit1, { tool: "figma_edit_table" });
  const e1 = await readBack("figjam", [tA]);
  expectThat("edit_table.structure.readBack", "figjam", e1, "rows: header, a new blank row, Ada; a blank column moved to the front", (v) =>
    JSON.stringify(v[0].table.grid) === JSON.stringify([["", "Name", "Role", "Team"], ["", "", "", ""], ["", "Ada", "Engineer", "Core"]]));
  // Then a column removal, a row move whose `to` Figma interprets, and cells in the final table.
  const edit2 = await tool("figjam", "figma_edit_table", {
    nodeId: tA, removeColumns: [0], moveRow: { from: 0, to: 2 },
    cells: [{ row: 0, column: 0, text: "Who", fill: "light-yellow", textColor: "violet" }, { row: 1, column: 1, textColor: "blue" }],
  });
  record("edit_table.cells", "figjam", edit2, { tool: "figma_edit_table" });
  const e2 = await readBack("figjam", [tA]);
  const grid2 = e2.value?.[0]?.table?.grid;
  const interpretation = !grid2 ? "unread"
    : JSON.stringify(grid2.slice(1).map((r) => r[0])) === JSON.stringify(["Ada", "Name"]) ? "splice: the row ends at index `to`"
    : JSON.stringify(grid2.slice(1).map((r) => r[0])) === JSON.stringify(["Name", "Ada"]) ? "before: the row goes before the old row `to`"
    : "other";
  expectThat("edit_table.cells.readBack", "figjam", e2, "3×3; the cell at 0,0 of the final table holds Who on light yellow in violet", (v) =>
    v[0].table.rows === 3 && v[0].table.cols === 3 && v[0].table.grid[0][0] === "Who" && v[0].table.fills[0][0][0] === TABLE_HEX["light-yellow"] && v[0].table.textFills[0][0][0] === TEXT_HEX.violet
      && edit2.value.cells.every((c) => c.ok),
    { tool: "figma_edit_table", moveRowInterpretation: interpretation });
  const refusedEdit = await tool("figjam", "figma_edit_table", { nodeId: tA, removeRows: [0, 1, 2] });
  expectThat("edit_table.removeAllRefused", "figjam", { ok: true, value: refusedEdit }, "refused before any change", (v) => !v.ok && v.structured?.partial?.created?.length === 0);

  // ── (5) code blocks: all 17 languages, DART included [C-143] ───────────────

  console.log("\n-- (5) code blocks");
  const codeIds = [];
  for (let i = 0; i < CODE_LANGUAGES.length; i++) {
    const language = CODE_LANGUAGES[i];
    const r = await tool("figjam", "figma_create_code_block", {
      code: `// ${language}\nhello()`, language, name: `fmcp code ${language}`, parentId: probeSection, x: 2300 + (i % 3) * 620, y: 40 + Math.floor(i / 3) * 300,
    });
    keep("figjam", idsOf(r));
    codeIds.push(idsOf(r)[0] ?? null);
    if (!r.ok) record(`create_code_block.${language}`, "figjam", r, { tool: "figma_create_code_block" });
  }
  const codeBack = await readBack("figjam", codeIds.filter(Boolean));
  expectThat("create_code_block.languages", "figjam", codeBack, "each language reads back as written", (v) =>
    v.length === CODE_LANGUAGES.length && v.every((n, i) => n.language === CODE_LANGUAGES[i].toUpperCase()),
    { tool: "figma_create_code_block", claim: "C-143", languages: codeBack.value?.map((n) => n.language) });
  const cobol = await tool("figjam", "figma_create_code_block", { code: "PROCEDURE DIVISION.", language: "cobol", parentId: probeSection });
  expectThat("create_code_block.unknownRefused", "figjam", { ok: true, value: cobol }, "an unknown language refused, nothing made", (v) => !v.ok && v.structured?.partial?.created?.length === 0);

  // ── (6) link previews [C-162] ───────────────────────────────────────────────

  console.log("\n-- (6) link previews");
  const preview = await tool("figjam", "figma_create_link_preview", { url: "https://www.figma.com", parentId: probeSection, x: 1100, y: 1300 }, { timeoutMs: 90_000 });
  keep("figjam", idsOf(preview));
  record("create_link_preview", "figjam", preview, { tool: "figma_create_link_preview" });
  expectThat("create_link_preview.readBack", "figjam", await readBack("figjam", idsOf(preview)), "an EMBED or LINK_UNFURL in the section", (v) => ["EMBED", "LINK_UNFURL"].includes(v[0].type) && v[0].parent === probeSection);
  const pageBefore = await pageCount("figjam");
  const sectionBefore = (await evalIn("figjam", `return (await figma.getNodeByIdAsync(${JSON.stringify(probeSection)})).children.length;`)).value;
  const bad = await tool("figjam", "figma_create_link_preview", { url: "https://fmcp-unreachable.invalid/", parentId: probeSection }, { timeoutMs: 90_000 });
  const pageAfter = await pageCount("figjam");
  const sectionAfter = (await evalIn("figjam", `return (await figma.getNodeByIdAsync(${JSON.stringify(probeSection)})).children.length;`)).value;
  keep("figjam", idsOf(bad));
  expectThat("create_link_preview.unreachable", "figjam", { ok: true, value: bad }, "Figma's words; partial.created lists exactly what the page gained", (v) =>
    !v.ok && (v.structured?.partial?.created?.length ?? -1) === pageAfter - pageBefore,
    { claim: "C-162", pageBefore, pageAfter, sectionBefore, sectionAfter });

  // ── (7) set_board_properties on every type ──────────────────────────────────

  console.log("\n-- (7) board properties");
  const smallSection = await evalIn("figjam", `const s = figma.createSection(); s.name = "fmcp hidden section (delete me)"; s.x = ${AREA.x}; s.y = ${AREA.y - 800}; s.resizeWithoutConstraints(400, 300); return s.id;`);
  if (typeof smallSection.value === "string") keep("figjam", [smallSection.value]);
  const shapeIds = idsOf(shapes);
  const setStickies = await tool("figjam", "figma_set_board_properties", { nodeIds: [s1], color: "violet", wide: true, authorVisible: true });
  const setShape = await tool("figjam", "figma_set_board_properties", { nodeIds: [shapeIds[0]], color: "light-blue", shape: "hexagon" });
  const setMany = await tool("figjam", "figma_set_board_properties", { nodeIds: [connFree, tA, textNode.value, smallSection.value, connDefault].filter(Boolean), color: "teal" });
  const setSection = await tool("figjam", "figma_set_board_properties", { nodeIds: [smallSection.value], color: "#F5FBFF", contentsHidden: true });
  const setCode = await tool("figjam", "figma_set_board_properties", { nodeIds: [codeIds[0]], language: "python" });
  const setStray = await tool("figjam", "figma_set_board_properties", { nodeIds: [connFree], wide: true });
  record("set_board_properties", "figjam", { ok: true, value: { setStickies, setShape, setMany, setSection, setCode, setStray } }, { tool: "figma_set_board_properties" });
  const props = await readBack("figjam", [s1, shapeIds[0], connFree, tA, textNode.value, smallSection.value, codeIds[0]].filter(Boolean));
  expectThat("set_board_properties.readBack", "figjam", props, "sticky violet+wide; shape preset+hexagon; connector teal; table fill teal; text teal; section hex+hidden (a name refused); code python; `wide` on a connector refused for that node",
    (v) => {
      const by = Object.fromEntries(v.map((n) => [n.id, n]));
      return by[s1].fills[0] === STICKY_HEX.violet && by[s1].wide === true
        && by[shapeIds[0]].shapeType === "HEXAGON" && by[shapeIds[0]].fills[0] === SHAPE_PRESET["light-blue"].fill && by[shapeIds[0]].strokes[0] === SHAPE_PRESET["light-blue"].stroke
        && by[connFree].strokes[0] === CONNECTOR_HEX.teal && by[tA].fills[0] === "#5AD8CC" && by[textNode.value].fills[0] === "#5AD8CC"
        && by[smallSection.value].fills[0] === "#F5FBFF" && by[smallSection.value].contentsHidden === true
        && by[codeIds[0]].language === "PYTHON"
        && setMany.value.items.find((i) => i.id === smallSection.value)?.ok === false
        && setStray.value.items[0].ok === false;
    }, { tool: "figma_set_board_properties", claim: "C-144" });

  // ── (8) fit_sections: 3 deep in FigJam, and one section in Design [C-141] ──

  console.log("\n-- (8) fit sections");
  const nest = await evalIn("figjam", `
const mk = (name, parent, x, y) => { const s = figma.createSection(); s.name = name; if (parent) parent.appendChild(s); s.x = x; s.y = y; s.resizeWithoutConstraints(100, 100); return s; };
const outer = mk("fmcp fit outer (delete me)", null, ${AREA.x + 5000}, ${AREA.y});
const mid = mk("fmcp fit mid", outer, 300, 260);
const inner = mk("fmcp fit inner", mid, 20, 500);
const a = figma.createSticky(); inner.appendChild(a); a.x = 10; a.y = 8;
const b = figma.createSticky(); inner.appendChild(b); b.x = 400; b.y = 300;
const c = figma.createConnector(); inner.appendChild(c); c.connectorStart = { endpointNodeId: a.id, magnet: "AUTO" }; c.connectorEnd = { endpointNodeId: b.id, magnet: "AUTO" };
return { outer: outer.id, mid: mid.id, inner: inner.id, a: a.id, b: b.id, c: c.id, connectorBefore: { x: c.x, y: c.y } };`);
  record("setup.nested", "figjam", nest);
  if (nest.ok) {
    keep("figjam", [nest.value.outer]);
    const fit = await tool("figjam", "figma_fit_sections", { nodeIds: [nest.value.outer, nest.value.mid, nest.value.inner, s0], padding: "40,32,32,32", minWidth: 200, minHeight: 200 });
    record("fit_sections", "figjam", fit, { tool: "figma_fit_sections" });
    const fitBack = await readBack("figjam", [nest.value.outer, nest.value.mid, nest.value.inner, nest.value.a, nest.value.b, nest.value.c]);
    expectThat("fit_sections.readBack", "figjam", fitBack, "inner-first: each section holds its content with the padding; the sticky in the top padding shifted; a non-section is a per-item error",
      (v) => {
        const [outer, mid, inner, a, b] = v;
        const holds = (s, k, pad) => k.x >= pad[3] - 0.5 && k.y >= pad[0] - 0.5 && k.x + k.width <= s.width - pad[1] + 0.5 && k.y + k.height <= s.height - pad[2] + 0.5;
        const pad = [40, 32, 32, 32];
        return fit.value.items.slice(0, 3).every((i) => i.ok) && fit.value.items[3].ok === false
          && holds(inner, a, pad) && holds(inner, b, pad) && holds(mid, inner, pad) && holds(outer, mid, pad) && a.y >= 40 - 0.5;
      }, { tool: "figma_fit_sections", claim: "C-141" });
    const connAfter = await evalIn("figjam", `const c = await figma.getNodeByIdAsync(${JSON.stringify(nest.value.c)}); return { x: c.x, y: c.y, start: c.connectorStart, end: c.connectorEnd };`);
    record("fit_sections.connector", "figjam", connAfter, { before: nest.value.connectorBefore, note: "a connector is never moved by x/y; its ends still attach", claim: "C-149" });
    const empty = await tool("figjam", "figma_fit_sections", { nodeIds: [smallSection.value] });
    expectThat("fit_sections.empty", "figjam", empty, "an empty section is left as it is, with a note", (v) => /empty/.test(v.items[0].note ?? ""));
  }
  const design = await evalIn("figma", `
const s = figma.createSection(); s.name = "fmcp fit probe (delete me)"; s.x = ${AREA.x}; s.y = ${AREA.y}; s.resizeWithoutConstraints(50, 50);
const r = figma.createRectangle(); s.appendChild(r); r.x = 10; r.y = 10; r.resize(100, 100);
return { section: s.id, rect: r.id };`);
  record("setup.design", "figma", design);
  if (design.ok) {
    keep("figma", [design.value.section]);
    const fitD = await tool("figma", "figma_fit_sections", { nodeIds: [design.value.section] });
    record("fit_sections", "figma", fitD, { tool: "figma_fit_sections" });
    expectThat("fit_sections.design.readBack", "figma", await readBack("figma", [design.value.section, design.value.rect]), "164×164 with the rectangle shifted to 32,32", (v) =>
      Math.abs(v[0].width - 164) < 0.5 && Math.abs(v[0].height - 164) < 0.5 && v[1].x === 32 && v[1].y === 32, { tool: "figma_fit_sections" });
  }

  // ── (9) a retro zone in ONE create_from_spec call (needs WP-E's builder) ────

  console.log("\n-- (9) retro zone through create_from_spec");
  const zone = {
    type: "section", name: "fmcp retro zone (delete me)", x: AREA.x + 9000, y: AREA.y, arrange: "grid:3", gap: 64, padding: "32", hug: true,
    children: [
      ...Array.from({ length: 9 }, (_, i) => ({ type: "sticky", ref: `s${i}`, content: i === 4 ? "a longer note that wraps over several lines ".repeat(4) : `Idea ${i}`, color: ["green", "yellow", "pink"][i % 3] })),
      { type: "shape", ref: "vote", shape: "diamond", content: "Vote?", color: "light-violet" },
      { type: "table", ref: "votes", rows: [["Idea", "Votes"], ["Idea 0", "3"]] },
      { type: "code", content: "SELECT idea, count(*) FROM votes GROUP BY idea", language: "sql" },
      { type: "connector", from: "s0", to: "s1@left" },
      { type: "connector", from: "s4", to: "votes", label: "tally", strokeWeight: 2 },
    ],
  };
  const t0 = Date.now();
  const spec = await tool("figjam", "figma_create_from_spec", { spec: JSON.stringify(zone) });
  const elapsedMs = Date.now() - t0;
  // The two refusals a builder without the spec-types seam gives: no `arrange` on a section, no "sticky" type.
  if (!spec.ok && /is not a field of a section|Unknown spec type/.test(spec.error ?? "")) {
    record("create_from_spec.retroZone", "figjam", { ok: false, error: `skipped — WP-E's builder is not in this build: ${spec.error}` });
  } else {
    if (spec.ok) keep("figjam", [spec.value.rootId]);
    record("create_from_spec.retroZone", "figjam", spec, { elapsedMs, tool: "figma_create_from_spec" });
    const zoneBack = spec.ok ? await evalIn("figjam", `${READ}
const s = await figma.getNodeByIdAsync(${JSON.stringify(spec.value?.rootId ?? "")});
const kids = []; for (const k of s.children) kids.push(await info(k.id));
return { section: await info(s.id), kids };`) : spec;
    expectThat("create_from_spec.retroZone.readBack", "figjam", zoneBack, "13 children, connectors last; stickies never overlap; the section hugs its children", (v) => {
      const st = v.kids.filter((k) => k.type === "STICKY");
      const last = v.kids.slice(-2).map((k) => k.type);
      const hugs = v.kids.filter((k) => k.type !== "CONNECTOR").every((k) => k.x >= 31.5 && k.y >= 31.5 && k.x + k.width <= v.section.width - 31.5 && k.y + k.height <= v.section.height - 31.5);
      return v.kids.length === 13 && st.length === 9 && noOverlap(st) && last.join() === "CONNECTOR,CONNECTOR" && hugs;
    }, { claim: ["C-147", "C-149", "C-155"] });
    if (spec.ok) {
      const undoZone = await evalIn("figjam", `figma.triggerUndo(); return { zoneGone: !(await figma.getNodeByIdAsync(${JSON.stringify(spec.value.rootId)})), probeStays: !!(await figma.getNodeByIdAsync(${JSON.stringify(probeSection)})) };`);
      expectThat("create_from_spec.retroZone.oneUndoStep", "figjam", undoZone, "one triggerUndo removes the whole zone and nothing older", (v) => v.zoneGone && v.probeStays, { claim: "C-151" });
    }
  }

  // ── (10) scale: 200 stickies in one call ────────────────────────────────────

  console.log("\n-- (10) 200 stickies");
  const big = await evalIn("figjam", `const s = figma.createSection(); s.name = "fmcp 200 stickies (delete me)"; s.x = ${AREA.x}; s.y = ${AREA.y + 5000}; s.resizeWithoutConstraints(6200, 3600); return s.id;`);
  if (typeof big.value === "string") {
    keep("figjam", [big.value]);
    // Straight through the SDK client, to count the progress notifications the plugin's pacer sends.
    const progress = [];
    const t1 = Date.now();
    let many;
    try {
      const res = await mcp.client.callTool(
        { name: "figma_create_stickies", arguments: { stickies: Array.from({ length: 200 }, (_, i) => ({ text: `Note ${i + 1}` })), parentId: big.value, columns: 20, session: FILES.figjam } },
        undefined,
        { timeout: 300_000, resetTimeoutOnProgress: true, onprogress: (p) => progress.push({ progress: p.progress, total: p.total, at: Date.now() - t1 }) },
      );
      const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text)[0];
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      many = res.isError ? { ok: false, error: text, structured: data } : { ok: true, value: data };
    } catch (err) {
      many = { ok: false, error: String(err?.message ?? err) };
    }
    const ms = Date.now() - t1;
    keep("figjam", idsOf(many));
    expectThat("create_stickies.200", "figjam", many, "200 made in one call, with progress, no STALLED or timeout", (v) => v.created.length === 200 && progress.length > 0,
      { elapsedMs: ms, progressEvents: progress.length, lastProgress: progress.at(-1) ?? null });
  }

  // ── (11) swatches by hand (INTERACTIVE) [C-144] [C-156] ─────────────────────

  if (!INTERACTIVE) {
    record("swatches", "figjam", { ok: false, error: "skipped: run with INTERACTIVE=1 to read FigJam's own swatches back" });
  } else {
    console.log("\n-- (11) swatches, by hand");
    const host = await evalIn("figjam", `const s = figma.createSection(); s.name = "fmcp swatch probe (delete me)"; s.x = ${AREA.x - 1200}; s.y = ${AREA.y}; s.resizeWithoutConstraints(800, 600);
const st = figma.createSticky(); s.appendChild(st); st.x = 40; st.y = 40;
const a = figma.createSticky(); s.appendChild(a); a.x = 480; a.y = 40;
const c = figma.createConnector(); s.appendChild(c); c.connectorStart = { endpointNodeId: st.id, magnet: "AUTO" }; c.connectorEnd = { endpointNodeId: a.id, magnet: "AUTO" };
return { section: s.id, sticky: st.id, connector: c.id };`);
    if (host.ok) {
      keep("figjam", [host.value.section]);
      await tool("figjam", "figma_zoom_to", { nodeIds: [host.value.section] });
      for (const [kind, id] of [["sticky", host.value.sticky], ["section", host.value.section], ["connector", host.value.connector]]) {
        for (const name of SWATCHES[kind]) {
          await tool("figjam", "figma_select", { nodeId: id });
          const answer = await ask(`Pick "${name}" in FigJam's colour picker for the selected ${kind}, then press Enter (s = skip this kind) `);
          if (answer.toLowerCase() === "s") break;
          const back = await evalIn("figjam", `${READ} const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); return paint(n.type === "CONNECTOR" ? n.strokes : n.fills);`);
          record(`swatch.${kind}.${name}`, "figjam", back, { claim: kind === "section" ? "C-144" : "C-156" });
        }
      }
      // Do our names land on the picker's named swatches?
      for (const [what, id] of [["sticky blue (create_stickies)", s1], ["shape light-teal preset", shapeIds[4]], ["connector red (create_connectors)", connStyled], ["table header violet", tA]]) {
        if (!id) continue;
        await tool("figjam", "figma_select", { nodeId: id });
        const answer = await ask(`Selected: ${what}. Does FigJam's colour picker show it as a named swatch, not "custom"? [y/n] `);
        record(`swatch.named.${what}`, "figjam", { ok: true, value: answer.toLowerCase().startsWith("y") }, { claim: "C-156" });
      }
    }
  }

  // ── fit the probe section and render it ─────────────────────────────────────

  console.log("\n-- render");
  const tidy = await tool("figjam", "figma_fit_sections", { nodeIds: [probeSection], padding: "48" });
  expectThat("fit_sections.probeSection", "figjam", tidy, "the probe section fits everything it holds", (v) => v.items[0].ok === true);
  exercised.add("figma_export_node");
  const png = await mcp.call("figma_export_node", { nodeId: probeSection, scale: 0.5, session: FILES.figjam });
  if (png.images?.[0]) {
    fs.mkdirSync(path.dirname(PNG), { recursive: true });
    fs.writeFileSync(PNG, Buffer.from(png.images[0].data, "base64"));
    record("render", "figjam", { ok: true, value: path.relative(process.cwd(), PNG) });
  } else {
    // Over the inline cap the server writes the file itself and says where.
    record("render", "figjam", png.ok ? { ok: true, value: png.data ?? png.text } : { ok: false, error: png.text });
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
return gone.length;`));
  }
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

const notExercised = BOARD_TOOLS.filter((t) => !exercised.has(t));
if (notExercised.length) record("coverage", "all", { ok: false, error: `not exercised: ${notExercised.join(", ")}` }, { expected: "every board tool exercised", pass: false });

save();
await mcp.close();
const failed = records.filter((r) => r.pass === false);
const passed = records.filter((r) => r.pass === true);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${records.length} probes → ${path.relative(process.cwd(), OUT)}`);
for (const f of failed) console.log(`  FAIL ${f.probe}: ${f.expected}${f.predicateError ? ` (${f.predicateError})` : ""}`);
process.exit(failed.length ? 1 : 0);
