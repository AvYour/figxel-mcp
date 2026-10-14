// figma_check_layout's craft and tells audits on a real canvas. The unit tests
// (test/check-craft.test.ts, test/check-tells.test.ts) run on fixture trees
// whose numbers the author chose; only Figma says what its own nodes report —
// whether absoluteRenderBounds of a text is its ink (the old-style figures
// rule depends on it), how flat a LINE's box is, where a text's box sits
// against its glyphs. So: one probe frame per rule, each built to trip exactly
// that rule, checked on its own, plus a clean control frame where nothing
// should fire [C-207] [C-248].
//
// It runs as a PROXY of whatever hub the user's MCP client started
// (mcp-client.mjs spawns node dist/server.js, which joins the running hub),
// with BRIDGE_ALLOW_UNVERIFIED=1 for its own calls only. Everything is built
// in one frame named "figma-mcp live-craft probe (delete me)", placed right of
// everything on the current page so it touches nobody's work, rendered to
// spikes/results/live-craft.png and deleted at the end unless KEEP=1. Every
// probe, with the findings it got and Figma's own numbers, goes to
// spikes/results/live-craft.json.
//
//   node spikes/live-craft.mjs                  the active Design file
//   SESSION="<file name>" node spikes/live-craft.mjs
//   KEEP=1 node spikes/live-craft.mjs           leave the probe frames in place
//
// Exit 0: every rule fired on its probe and the control stayed clean. 1: one
// did not (see the FAIL lines and the JSON). 2: the run could not start.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-craft.json");
const PNG = path.join(HERE, "results", "live-craft.png");
const KEEP = process.env.KEEP === "1";
const SESSION = process.env.SESSION || undefined;
const at = SESSION ? { session: SESSION } : {};

const records = [];
const startedAt = new Date().toISOString();
let measured = {};
let session = null;

function record(rec) {
  records.push(rec);
  const mark = rec.pass === false ? "FAIL" : rec.pass === true ? "ok  " : "info";
  const shown = JSON.stringify(rec.found ?? rec.value ?? rec.error ?? null);
  console.log(`  ${mark} ${rec.probe.padEnd(28)} ${shown && shown.length > 140 ? shown.slice(0, 140) + "…" : shown}`);
  return rec;
}

function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ spike: "live-craft", startedAt, finishedAt: new Date().toISOString(), session, measured, records }, null, 2) + "\n");
}

// ── connect, and check the hub, the build and the file ──────────────────────

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = new Set((await mcp.list()).map((t) => t.name));
for (const t of ["figma_check_layout", "figma_eval"]) {
  if (!tools.has(t)) {
    console.error(`The spawned server does not register ${t}. Run npm run build (and check BRIDGE_TOOLSET).`);
    await mcp.close();
    process.exit(2);
  }
}
const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => (SESSION ? s.file?.name === SESSION : s.active)) ?? (SESSION ? undefined : st.data?.sessions?.[0]);
if (!st.ok || !sess) {
  console.error(SESSION ? `No connected file named "${SESSION}".` : "No Figma session — run the figma-mcp bridge plugin in a Design file first.");
  await mcp.close();
  process.exit(2);
}
if (sess.build?.restart === "client" || sess.build?.restart === "plugin") {
  console.error(sess.build.restart === "client"
    ? "Restart the MCP client so the hub runs the current build."
    : `Close the figma-mcp bridge plugin in "${sess.file?.name}" and run it again: it runs an older build than dist/.`);
  await mcp.close();
  process.exit(2);
}
if (sess.editorType && sess.editorType !== "figma") {
  console.error(`"${sess.file?.name}" is a ${sess.editorType} file; these probes need a Design file.`);
  await mcp.close();
  process.exit(2);
}
session = { file: sess.file?.name, editorType: sess.editorType, build: sess.build };
console.log(`role ${st.data.bridge?.role}, file "${sess.file?.name}"`);

/** figma_eval: the code is an async function body with `figma` in scope. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code, ...at }, { timeoutMs: 180_000 });
  if (!r.ok) throw new Error(`figma_eval failed: ${r.text}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

// ── the probes, built in the plugin ─────────────────────────────────────────
//
// buildProbes runs inside Figma (sent as source), so it may use only `figma`
// and its own argument. Each probe frame sits 400 px from the next, so no
// probe touches another; inside a frame, names are unique so a finding is
// matched by name.

async function buildProbes({ gap }) {
  const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
  const solid = (hex, opacity) => [{ type: "SOLID", color: rgb(hex), ...(opacity === undefined ? {} : { opacity }) }];
  const INTER = { family: "Inter", style: "Regular" };
  const BOLD = { family: "Inter", style: "Bold" };
  await figma.loadFontAsync(INTER);
  await figma.loadFontAsync(BOLD);
  // A face whose default figures are old-style: Cormorant was the run's [C-207].
  let serif = null;
  for (const f of [{ family: "Cormorant Garamond", style: "SemiBold" }, { family: "EB Garamond", style: "Regular" }, { family: "Georgia", style: "Regular" }]) {
    try {
      await figma.loadFontAsync(f);
      serif = f;
      break;
    } catch (e) {
      /* not installed: try the next */
    }
  }

  const page = figma.currentPage;
  let edge = 0;
  for (const n of page.children) edge = Math.max(edge, n.x + n.width);
  const root = figma.createFrame();
  root.name = "figma-mcp live-craft probe (delete me)";
  root.fills = [];
  root.clipsContent = false;
  page.appendChild(root);
  root.x = Math.round(edge + gap);
  root.y = 0;

  // Every node goes into its parent the moment it exists: a setter that throws
  // later can then never leave an orphan on the page, outside the root.
  const frames = {};
  let col = 0;
  let tallest = 0;
  const frame = (key, w, h, fills = solid("#ffffff")) => {
    const f = figma.createFrame();
    root.appendChild(f);
    f.name = key;
    f.resize(w, h);
    f.fills = fills;
    f.clipsContent = false;
    f.x = col;
    f.y = 0;
    col += w + 400;
    tallest = Math.max(tallest, h);
    frames[key] = { id: f.id, nodes: {} };
    return f;
  };
  const keep = (f, n) => {
    frames[f.name].nodes[n.name] = n.id;
    return n;
  };
  const make = (create, parent) => {
    const n = create();
    parent.appendChild(n);
    return n;
  };
  const place = (n, x, y) => {
    n.x = x;
    n.y = y;
  };
  const text = (f, name, chars, size, x, y, o = {}) => {
    const t = make(() => figma.createText(), o.parent || f);
    t.fontName = o.font || INTER;
    t.characters = chars;
    t.fontSize = size;
    t.name = name;
    if (o.width) {
      t.textAutoResize = "HEIGHT";
      t.resize(o.width, t.height);
    }
    if (o.align) t.textAlignHorizontal = o.align;
    if (o.lineHeight) t.lineHeight = o.lineHeight;
    if (o.tracking !== undefined) t.letterSpacing = { unit: "PERCENT", value: o.tracking };
    if (o.upper) t.textCase = "UPPER";
    t.fills = solid(o.color || "#111111");
    place(t, x, y);
    return keep(f, t);
  };
  const rect = (f, name, x, y, w, h, o = {}) => {
    const r = make(() => figma.createRectangle(), o.parent || f);
    r.name = name;
    r.resize(w, h);
    r.fills = o.fills || solid(o.color || "#111111");
    if (o.radius !== undefined) r.cornerRadius = o.radius;
    if (o.effects) r.effects = o.effects;
    place(r, x, y);
    return keep(f, r);
  };
  const ellipse = (f, name, x, y, w, h, o = {}) => {
    const e = make(() => figma.createEllipse(), o.parent || f);
    e.name = name;
    e.resize(w, h);
    e.fills = o.fills || solid(o.color || "#111111");
    if (o.stroke) {
      e.strokes = solid(o.stroke);
      e.strokeWeight = o.weight || 2;
    }
    place(e, x, y);
    return keep(f, e);
  };
  const line = (f, name, x, y, w, color, weight) => {
    const l = make(() => figma.createLine(), f);
    l.name = name;
    l.resize(w, 0);
    l.strokes = solid(color);
    l.strokeWeight = weight;
    place(l, x, y);
    return keep(f, l);
  };
  const box = (f, name, x, y, w, h, o = {}) => {
    const b = make(() => figma.createFrame(), o.parent || f);
    b.name = name;
    b.resize(w, h);
    b.fills = o.fills || solid(o.color || "#ffffff");
    if (o.radius !== undefined) b.cornerRadius = o.radius;
    b.clipsContent = false;
    place(b, x, y);
    return keep(f, b);
  };
  const LONG = "Wood-fired stoneware thrown by hand in small batches, glazed with ash from the kiln itself, and fired for three days. ";
  const shadow = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true, blendMode: "NORMAL" }];
  const violet = (from, to) => [{
    type: "GRADIENT_LINEAR",
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { ...rgb(from), a: 1 } }, { position: 1, color: { ...rgb(to), a: 1 } }],
  }];

  // ── craft ──
  {
    const f = frame("craft near_size", 1080, 600);
    text(f, "Wood-fired", "Wood-fired", 56, 100, 100);
    text(f, "Ash glaze", "Ash glaze", 60, 100, 250);
  }
  {
    const f = frame("craft no_shared_edge", 1080, 600);
    const head = text(f, "Head", "Shop the kiln", 24, 100, 100, { width: 400 });
    text(f, "Body", "Wood-fired stoneware", 16, 103, head.y + head.height + 16, { width: 400 });
  }
  {
    const f = frame("craft tangent", 1080, 600);
    ellipse(f, "Arch", 100, 100, 200, 200);
    rect(f, "Mug", 305, 150, 100, 100);
  }
  {
    const f = frame("craft glyph_gaps", 1080, 400);
    const S = text(f, "S", "S", 100, 100, 100);
    const l = text(f, "l", "l", 100, S.x + S.width, 100);
    const o = text(f, "o", "o", 100, l.x + l.width + 18, 100); // 0.18 em: past the 0.15 em threshold, short of a word space
    text(f, "w", "w", 100, o.x + o.width, 100);
  }
  const figures = {};
  if (serif) {
    const f = frame("craft oldstyle_figures", 1080, 500);
    const old = text(f, "Old-style 10", "10", 200, 100, 100, { font: serif });
    const lining = text(f, "Lining 10", "10", 200, 600, 100);
    for (const [k, t] of [["serif", old], ["inter", lining]]) {
      const ink = t.absoluteRenderBounds;
      figures[k] = { font: t.fontName, fontSize: t.fontSize, boxHeight: t.height, inkHeight: ink ? ink.height : null, ratio: ink ? ink.height / t.fontSize : null };
    }
  }
  {
    const f = frame("craft unbalanced_space", 1080, 1920);
    text(f, "Offer", "Ten percent off your first order", 80, 100, 200, { font: BOLD, width: 880 });
  }
  {
    const f = frame("craft safe_area", 1080, 1920);
    text(f, "Kicker", "Autumn kiln", 32, 100, 100);
    text(f, "Inside", "Inside the safe area", 32, 100, 900);
  }
  {
    const f = frame("craft low_contrast_over_shape", 1080, 800);
    rect(f, "Band", 0, 300, 1080, 300, { color: "#222222" });
    text(f, "Ash Vase", "Ash Vase", 32, 100, 420, { color: "#444444" });
  }
  {
    const f = frame("craft min_text", 1080, 600);
    text(f, "Small label", "22 px on a 1080 story", 22, 100, 100);
  }
  const lines = {};
  {
    const f = frame("craft stroke_crosses_text", 1080, 800);
    const url = text(f, "URL", "moku.store", 32, 100, 300);
    const strike = line(f, "Strike", 80, Math.round(url.y + url.height / 2), 400, "#111111", 2);
    lines.strike = { width: strike.width, height: strike.height, box: strike.absoluteBoundingBox, render: strike.absoluteRenderBounds };
    ellipse(f, "Ring", 500, 100, 400, 400, { fills: [], stroke: "#111111", weight: 2 });
    text(f, "Ring label", "on the rim", 24, 850, 290);
  }
  {
    const f = frame("craft edge_slices_text", 1080, 800);
    const band = rect(f, "Band", 0, 0, 1080, 400, { color: "#e8e2da" });
    const t = text(f, "Sliced", "Ash Vase", 48, 100, 300);
    band.y = Math.round(t.y + t.height / 2);
  }
  {
    const f = frame("craft weak_graphic_contrast", 1080, 800);
    line(f, "Ripple", 100, 400, 880, "#dddddd", 1);
  }

  // ── tells ──
  {
    const f = frame("tells default_typeface", 1440, 900);
    text(f, "Head", "Plans for every team", 48, 100, 100, { font: BOLD });
    text(f, "P1", LONG, 16, 100, 200, { width: 1000 });
    text(f, "P2", LONG, 16, 100, 260, { width: 1000 });
  }
  {
    const f = frame("tells flat_hierarchy", 1440, 900);
    text(f, "Display", "Plans", 24, 100, 100, { font: BOLD });
    text(f, "P1", LONG, 16, 100, 200, { width: 1000 });
    text(f, "P2", LONG, 16, 100, 260, { width: 1000 });
  }
  {
    const f = frame("tells too_many_sizes", 1440, 1200);
    let y = 100;
    for (const s of [12, 14, 16, 18, 20, 24, 32]) {
      text(f, `Size ${s}`, `Set at ${s} px`, s, 100, y);
      y += 80;
    }
  }
  {
    const f = frame("tells centred_block", 1440, 900);
    text(f, "Lede", LONG + LONG, 16, 100, 100, { width: 400, align: "CENTER" });
  }
  {
    const f = frame("tells eyebrow_everywhere", 1440, 900);
    text(f, "Eyebrow", "FEATURES", 12, 100, 100, { tracking: 10 });
    text(f, "Heading", "Built for the kiln", 40, 100, 130, { font: BOLD });
    text(f, "P1", LONG, 16, 100, 220, { width: 1000 });
    text(f, "P2", LONG, 16, 100, 280, { width: 1000 });
  }
  {
    const f = frame("tells measure", 1440, 900);
    text(f, "Para", LONG + LONG + LONG + LONG + LONG, 16, 60, 100, { width: 1300, lineHeight: { unit: "PERCENT", value: 135 } });
  }
  {
    const f = frame("tells leading", 1440, 900);
    text(f, "Tight", LONG + LONG, 16, 100, 100, { width: 500, lineHeight: { unit: "PIXELS", value: 16 } });
  }
  {
    const f = frame("tells card_trio", 1440, 600);
    const row = box(f, "Features", 100, 100, 10, 10, { fills: [] });
    row.layoutMode = "HORIZONTAL";
    row.itemSpacing = 24;
    row.primaryAxisSizingMode = "AUTO";
    row.counterAxisSizingMode = "AUTO";
    for (const n of ["Card A", "Card B", "Card C"]) {
      const card = box(f, n, 0, 0, 300, 200, { radius: 12, parent: row });
      card.layoutMode = "VERTICAL";
      card.primaryAxisSizingMode = "FIXED";
      card.counterAxisSizingMode = "FIXED";
      card.resize(300, 200);
      card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 24;
      card.itemSpacing = 12;
      ellipse(f, `${n} icon`, 0, 0, 24, 24, { parent: card });
      text(f, `${n} title`, "Fast setup", 20, 0, 0, { font: BOLD, parent: card });
      text(f, `${n} body`, "Connect your kiln log in minutes.", 16, 0, 0, { width: 252, parent: card });
    }
  }
  {
    const f = frame("tells nested_cards", 1440, 900);
    const outer = box(f, "Outer", 100, 100, 600, 400, { radius: 16 });
    const inner = box(f, "Inner", 40, 40, 400, 200, { color: "#f4f4f4", radius: 12, parent: outer });
    text(f, "Inner text", "Glaze notes", 16, 20, 20, { parent: inner });
  }
  {
    const f = frame("tells one_radius", 1440, 600);
    for (let i = 0; i < 4; i++) rect(f, `R${i}`, 100 + i * 140, 100, 100, 100, { radius: 12 });
  }
  {
    const f = frame("tells nested_radius", 1440, 600);
    const card = box(f, "Card", 100, 100, 400, 300, { color: "#f4f4f4", radius: 16 });
    rect(f, "Photo", 12, 12, 376, 200, { radius: 16, parent: card });
  }
  {
    const f = frame("tells same_shadow", 1440, 600);
    for (let i = 0; i < 5; i++) rect(f, `C${i}`, 100 + i * 140, 100, 100, 100, { color: "#ffffff", ...(i < 4 ? { effects: shadow } : {}) });
  }
  {
    const f = frame("tells default_gradient", 1000, 1000);
    rect(f, "Wash", 0, 0, 600, 600, { fills: violet("#6366f1", "#a855f7") });
  }
  {
    const f = frame("tells glow", 1440, 900);
    const blob = ellipse(f, "Blob", 400, 100, 600, 600, { color: "#7c3aed" });
    try {
      blob.effects = [{ type: "LAYER_BLUR", radius: 120, visible: true, blurType: "NORMAL" }];
    } catch (e) {
      blob.effects = [{ type: "LAYER_BLUR", radius: 120, visible: true }]; // an API from before progressive blurs knows no blurType
    }
    text(f, "Heading", "Fire and ash", 48, 500, 300, { font: BOLD });
  }
  {
    const f = frame("tells emoji_icon", 1080, 400);
    text(f, "Rocket", `${String.fromCodePoint(0x1f680)} Fast setup`, 24, 100, 100);
  }
  {
    const f = frame("tells chrome_string", 1080, 400);
    text(f, "Meta", "Hand-thrown · Wood-fired · 32 cm", 24, 100, 100);
    text(f, "CTA label", "Shop the collection →", 24, 100, 200);
  }
  {
    const f = frame("tells divider_everywhere", 1440, 1200);
    for (let i = 0; i < 2; i++) {
      const h = text(f, `H${i}`, "Section heading", 32, 100, 100 + i * 400, { font: BOLD });
      line(f, `Rule ${i}`, 100, h.y + h.height + 8, 400, "#111111", 1);
      text(f, `P${i}`, LONG, 16, 100, h.y + h.height + 30, { width: 1000 });
    }
  }
  {
    const f = frame("always placeholder_text", 1080, 400);
    text(f, "Byline", "Written by John Doe", 24, 100, 100);
  }
  {
    // Nothing here should fire: one face at two sizes far apart, left-aligned, one shared edge, centred on its field.
    const f = frame("control", 1200, 800);
    const head = text(f, "Heading", "Kiln notes", 64, 96, 300, { font: BOLD });
    text(f, "Body", "Three days of wood, ash and patience, and a glaze nobody can repeat.", 18, 96, head.y + head.height + 24,
      { width: 560, lineHeight: { unit: "PERCENT", value: 140 } });
  }

  root.resize(Math.max(10, col - 400), Math.max(10, tallest));
  return { rootId: root.id, at: { x: root.x, y: root.y }, serif, frames, figures, lines };
}

// What each probe must produce: `kind` on the node named `on` (the probe frame
// itself for a finding about the whole root), with the audits and parameters given.
const EXPECT = [
  { probe: "craft near_size", audit: ["craft"], kind: "near_size", on: "Ash glaze" },
  { probe: "craft no_shared_edge", audit: ["craft"], kind: "no_shared_edge", on: "Body", severity: "warning" },
  { probe: "craft tangent", audit: ["craft"], kind: "tangent", on: "Arch" },
  { probe: "craft glyph_gaps", audit: ["craft"], kind: "glyph_gaps", on: "o", severity: "warning" },
  { probe: "craft oldstyle_figures", audit: ["craft"], kind: "oldstyle_figures", on: "Old-style 10", severity: "warning", notOn: ["Lining 10"] },
  { probe: "craft unbalanced_space", audit: ["craft"], kind: "unbalanced_space", on: "craft unbalanced_space" },
  { probe: "craft safe_area", audit: [], params: { safeArea: "64,250,952,1330" }, kind: "safe_area", on: "Kicker", severity: "warning", notOn: ["Inside"] },
  { probe: "craft low_contrast_over_shape", audit: ["craft"], kind: "low_contrast_over_shape", on: "Ash Vase", severity: "warning" },
  { probe: "craft min_text", audit: [], params: { minTextSize: 28 }, kind: "min_text", on: "Small label", severity: "warning" },
  { probe: "craft stroke_crosses_text", audit: ["craft"], kind: "stroke_crosses_text", on: "URL", alsoOn: ["Ring label"], severity: "warning" },
  { probe: "craft edge_slices_text", audit: ["craft"], kind: "edge_slices_text", on: "Sliced" },
  { probe: "craft weak_graphic_contrast", audit: ["craft"], kind: "weak_graphic_contrast", on: "Ripple" },
  { probe: "tells default_typeface", audit: ["tells"], kind: "default_typeface", on: "tells default_typeface" },
  { probe: "tells flat_hierarchy", audit: ["tells"], kind: "flat_hierarchy", on: "Display" },
  { probe: "tells too_many_sizes", audit: ["tells"], kind: "too_many_sizes", on: "tells too_many_sizes" },
  { probe: "tells centred_block", audit: ["tells"], kind: "centred_block", on: "Lede" },
  { probe: "tells centred_block", audit: ["tells"], kind: "mostly_centred", on: "tells centred_block" },
  { probe: "tells eyebrow_everywhere", audit: ["tells"], kind: "eyebrow_everywhere", on: "tells eyebrow_everywhere" },
  { probe: "tells measure", audit: ["tells"], kind: "measure", on: "Para" },
  { probe: "tells leading", audit: ["tells"], kind: "leading", on: "Tight" },
  { probe: "tells card_trio", audit: ["tells"], kind: "card_trio", on: "Card A" },
  { probe: "tells nested_cards", audit: ["tells"], kind: "nested_cards", on: "Inner" },
  { probe: "tells one_radius", audit: ["tells"], kind: "one_radius", on: "tells one_radius" },
  { probe: "tells nested_radius", audit: ["tells"], kind: "nested_radius", on: "Photo" },
  { probe: "tells same_shadow", audit: ["tells"], kind: "same_shadow", on: "tells same_shadow" },
  { probe: "tells default_gradient", audit: ["tells"], kind: "default_gradient", on: "Wash" },
  { probe: "tells glow", audit: ["tells"], kind: "glow", on: "Blob" },
  { probe: "tells emoji_icon", audit: ["tells"], kind: "emoji_icon", on: "Rocket" },
  { probe: "tells chrome_string", audit: ["tells"], kind: "chrome_string", on: "Meta", alsoOn: ["CTA label"] },
  { probe: "tells divider_everywhere", audit: ["tells"], kind: "divider_everywhere", on: "tells divider_everywhere" },
  { probe: "always placeholder_text", audit: [], kind: "placeholder_text", on: "Byline" },
];

const CRAFT_KINDS = ["near_size", "no_shared_edge", "tangent", "glyph_gaps", "oldstyle_figures", "unbalanced_space", "safe_area",
  "low_contrast_over_shape", "min_text", "stroke_crosses_text", "edge_slices_text", "weak_graphic_contrast"];

let built = null;
async function probes() {
  console.log("\n-- build");
  built = await evalJs(`return await (${buildProbes.toString()})(${JSON.stringify({ gap: 6000 })});`);
  console.log(`  probe frames at x ${built.at.x}, y ${built.at.y}; old-style face: ${built.serif ? `${built.serif.family} ${built.serif.style}` : "none installed"}`);
  measured = { at: built.at, serif: built.serif, figures: built.figures, lines: built.lines };

  console.log("\n-- check");
  for (const e of EXPECT) {
    const frame = built.frames[e.probe];
    if (!frame) {
      record({ probe: `${e.probe} → ${e.kind}`, pass: null, value: "skipped: probe not built (no face with old-style figures installed)" });
      continue;
    }
    const r = await mcp.call("figma_check_layout", { nodeId: frame.id, audit: e.audit, minSeverity: "info", limit: 1000, ...(e.params ?? {}), ...at });
    if (!r.ok || !r.data) {
      record({ probe: `${e.probe} → ${e.kind}`, pass: false, error: r.text });
      continue;
    }
    const issues = r.data.issues ?? [];
    const found = issues.filter((i) => i.kind === e.kind);
    const hit = (name) => found.some((i) => i.name === name && (!e.severity || i.severity === e.severity));
    const wanted = [e.on, ...(e.alsoOn ?? [])];
    const missing = wanted.filter((n) => !hit(n));
    const stray = (e.notOn ?? []).filter((n) => found.some((i) => i.name === n));
    record({
      probe: `${e.probe} → ${e.kind}`,
      expected: `${e.kind}${e.severity ? ` (${e.severity})` : ""} on ${wanted.join(", ")}${stray.length || e.notOn ? `, not on ${(e.notOn ?? []).join(", ")}` : ""}`,
      pass: missing.length === 0 && stray.length === 0,
      ...(missing.length ? { missing } : {}),
      ...(stray.length ? { stray } : {}),
      found: found.map((i) => ({ name: i.name, severity: i.severity, detail: i.detail })),
      // Everything else that fired: the false-positive candidates calibration looks at.
      others: issues.filter((i) => i.kind !== e.kind).map((i) => `${i.kind}:${i.name}`),
      ran: r.data.audit?.ran ?? [],
      ok: r.data.ok,
    });
  }

  // The control: no finding at all — from either audit or from the layout check itself.
  const control = built.frames.control;
  const c = await mcp.call("figma_check_layout", { nodeId: control.id, audit: ["craft", "tells"], minSeverity: "info", limit: 1000, ...at });
  const fired = c.data?.issues ?? [];
  record({
    probe: "control → nothing",
    expected: "no finding",
    pass: c.ok && fired.length === 0,
    found: fired.map((i) => `${i.kind}${CRAFT_KINDS.includes(i.kind) ? " (craft)" : ""}:${i.name}: ${i.detail}`),
  });

  // The rendered ink of a text is what the old-style rule measures: record it for the claim.
  if (built.figures.serif) {
    record({ probe: "measured: text ink height", pass: null, value: built.figures });
  }
  record({ probe: "measured: a LINE's boxes", pass: null, value: built.lines });

  console.log("\n-- render");
  const png = await mcp.call("figma_export_node", { nodeId: built.rootId, maxSize: 4096, ...at });
  if (png.images?.[0]) {
    fs.mkdirSync(path.dirname(PNG), { recursive: true });
    fs.writeFileSync(PNG, Buffer.from(png.images[0].data, "base64"));
    record({ probe: "render", pass: null, value: path.relative(process.cwd(), PNG) });
  } else {
    record({ probe: "render", pass: null, value: png.ok ? png.data ?? png.text : `failed: ${png.text}` });
  }
}

async function cleanup() {
  if (!built?.rootId) return;
  console.log("\n-- cleanup");
  // Only the root this run made: everything else in it is ours too.
  const gone = await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(built.rootId)});
if (n && !n.removed && n.name === "figma-mcp live-craft probe (delete me)") { n.remove(); return true; }
return false;`);
  record({ probe: "cleanup", pass: gone === true, value: gone });
}

// A crash still saves what was measured and removes what was made.
try {
  await probes();
} catch (err) {
  record({ probe: "crash", pass: false, error: String(err?.stack ?? err) });
}
if (!KEEP) {
  try {
    await cleanup();
  } catch (err) {
    record({ probe: "cleanup.crash", pass: false, error: String(err?.stack ?? err) });
  }
}

save();
await mcp.close();
const failed = records.filter((r) => r.pass === false);
const passed = records.filter((r) => r.pass === true);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${records.length} records → ${path.relative(process.cwd(), OUT)}`);
for (const f of failed) console.log(`  FAIL ${f.probe}: ${f.expected ?? ""} ${f.missing ? `missing on ${f.missing.join(", ")}` : ""}${f.stray ? ` stray on ${f.stray.join(", ")}` : ""}${f.error ? f.error : ""}`);
process.exit(failed.length ? 1 : 0);
