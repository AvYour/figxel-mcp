// Calibrates figma_check_layout's `tells` audit [C-248]. Every tell ships as
// info because nothing yet shows it tells generated work from finished work.
// This run is that evidence: it checks the user's own finished frames, the
// fictional Moku demo ad's v1 and v2 frames if still in the file, and a deliberately
// generic landing page it builds itself (every cliché of the SaaS card kit and
// template chrome [C-219]), all with audit ["tells", "craft"], and tabulates
// each kind:
//
//   separates  fires on the generic page and on none of the finished frames — keep it
//   noisy      fires on finished work too — fix its threshold or drop it
//   silent     did not fire even on the page built to trip it — the rule misses its own example
//   not tested the generic page was not built for it, and it stayed quiet there
//
// Promoting a tell from info to warning is a later decision, made from this
// table, not by this script.
//
// Inputs (the plan's "what the user must do", item 4):
//   FINISHED="<id or link>,<id or link>,…"   3–5 finished frames of your own (required)
//   MOKU="<v1 id or link>,<v2 id or link>"   optional
//   SESSION="<file name>"                    the file they live in, when several are open
// or a JSON file:  node spikes/calibrate-tells.mjs calibrate.json
//   { "session": "…", "finished": ["…"], "moku": ["…"] }
//
// It runs as a PROXY of the user's hub (BRIDGE_ALLOW_UNVERIFIED=1 for its own
// calls only). It only reads the frames you name; the generic page is built
// right of everything on the current page of that file, named
// "figma-mcp calibrate-tells generic page (delete me)", and deleted at the
// end unless KEEP=1. Results: spikes/results/calibrate-tells.json.
//
// Exit 0: the table was written. 2: the run could not start.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "calibrate-tells.json");
const KEEP = process.env.KEEP === "1";

const list = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const config = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : {};
const SESSION = config.session ?? process.env.SESSION ?? undefined;
const FINISHED = config.finished ?? list(process.env.FINISHED);
const MOKU = config.moku ?? list(process.env.MOKU);
const at = SESSION ? { session: SESSION } : {};

if (!FINISHED.length) {
  console.error("Name 3–5 finished frames of your own: FINISHED=\"<id or link>,…\" node spikes/calibrate-tells.mjs (MOKU and SESSION optional).");
  process.exit(2);
}

// What the audits can report; the tells are what this run calibrates.
const TELLS = ["default_typeface", "flat_hierarchy", "too_many_sizes", "mostly_centred", "centred_block", "eyebrow_everywhere", "measure",
  "leading", "card_trio", "nested_cards", "one_radius", "nested_radius", "same_shadow", "default_gradient", "glow", "emoji_icon",
  "chrome_string", "divider_everywhere",
  // Role quality plan W2 (2026-10-20); the generic page is not built for them, so a quiet one is "not tested".
  "skeleton_repeat", "flat_rhythm", "boxiness", "centred_stage", "icon_tile", "kpi_tile", "greeting_title", "accent_share",
  "hue_pair", "reflex_display_face", "cluster_1", "cluster_2", "cluster_3", "cluster_4", "cluster_5", "cluster_6"];
const CRAFT = ["near_size", "no_shared_edge", "tangent", "glyph_gaps", "oldstyle_figures", "unbalanced_space", "safe_area",
  "low_contrast_over_shape", "min_text", "stroke_crosses_text", "edge_slices_text", "weak_graphic_contrast"];
// The tells the generic page is built to trip. One it was not built for and that stays quiet there is "not tested", not "silent".
const DESIGNED = new Set(["default_typeface", "too_many_sizes", "mostly_centred", "centred_block", "eyebrow_everywhere", "card_trio", "nested_cards",
  "one_radius", "nested_radius", "same_shadow", "default_gradient", "glow", "emoji_icon", "chrome_string", "divider_everywhere"]);

const startedAt = new Date().toISOString();
const frames = [];
const problems = [];
let session = null;

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
  console.error(SESSION ? `No connected file named "${SESSION}".` : "No Figma session — run the figma-mcp bridge plugin in the file that holds your frames.");
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
session = { file: sess.file?.name, editorType: sess.editorType, build: sess.build };
console.log(`role ${st.data.bridge?.role}, file "${sess.file?.name}"`);

async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code, ...at }, { timeoutMs: 180_000 });
  if (!r.ok) throw new Error(`figma_eval failed: ${r.text}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

// ── the generic page, built in the plugin ───────────────────────────────────
//
// Runs inside Figma (sent as source): only `figma` and its argument. The page
// is the default a broad prompt lands on — one default sans at two weights, a
// centred hero under a glow, a tracked caps label over every heading, a rule
// under each, three identical icon cards with one radius and one shadow, a
// violet button, emoji icons, numbered steps, middle-dot meta, stand-in names.

async function buildGeneric({ gap }) {
  const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
  const solid = (hex) => [{ type: "SOLID", color: rgb(hex) }];
  const violet = [{
    type: "GRADIENT_LINEAR",
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { ...rgb("#6366f1"), a: 1 } }, { position: 1, color: { ...rgb("#a855f7"), a: 1 } }],
  }];
  const shadow = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 4 }, radius: 16, spread: 0, visible: true, blendMode: "NORMAL" }];
  const INTER = { family: "Inter", style: "Regular" };
  const BOLD = { family: "Inter", style: "Bold" };
  await figma.loadFontAsync(INTER);
  await figma.loadFontAsync(BOLD);

  const page = figma.currentPage;
  let edge = 0;
  for (const n of page.children) edge = Math.max(edge, n.x + n.width);
  const root = figma.createFrame();
  root.name = "figma-mcp calibrate-tells generic page (delete me)";
  root.resize(1440, 2600);
  root.fills = solid("#ffffff");
  root.x = Math.round(edge + gap);
  root.y = 0;

  // Each node goes into its parent the moment it exists, so a throwing setter never orphans one on the page.
  const make = (create, parent) => {
    const n = create();
    parent.appendChild(n);
    return n;
  };
  const text = (parent, name, chars, size, x, y, o = {}) => {
    const t = make(() => figma.createText(), parent);
    t.fontName = o.bold ? BOLD : INTER;
    t.characters = chars;
    t.fontSize = size;
    t.name = name;
    if (o.width) {
      t.textAutoResize = "HEIGHT";
      t.resize(o.width, t.height);
    }
    if (o.center) t.textAlignHorizontal = "CENTER";
    if (o.tracking) t.letterSpacing = { unit: "PERCENT", value: o.tracking };
    t.fills = solid(o.color ?? "#111827");
    t.x = o.center && o.width ? x - o.width / 2 : x;
    t.y = y;
    return t;
  };
  const frame = (parent, name, x, y, w, h, o = {}) => {
    const f = make(() => figma.createFrame(), parent);
    f.name = name;
    f.resize(w, h);
    f.fills = o.fills ?? solid(o.color ?? "#ffffff");
    if (o.radius) f.cornerRadius = o.radius;
    if (o.effects) f.effects = o.effects;
    f.clipsContent = false;
    f.x = x;
    f.y = y;
    return f;
  };
  const rule = (parent, name, x, y, w) => {
    const l = make(() => figma.createLine(), parent);
    l.name = name;
    l.resize(w, 0);
    l.strokes = solid("#e5e7eb");
    l.strokeWeight = 1;
    l.x = x;
    l.y = y;
  };
  const button = (parent, name, label, x, y) => {
    const b = frame(parent, name, x, y, 180, 48, { fills: violet, radius: 12, effects: shadow });
    text(b, `${name} label`, label, 16, 24, 14, { bold: true, color: "#ffffff" });
    return b;
  };
  const C = 720; // the page's centre line: everything hangs off it

  // Navigation
  text(root, "Logo", "Acme", 22, 80, 32, { bold: true });
  ["Features", "Pricing", "About"].forEach((l, i) => text(root, `Nav ${l}`, l, 16, 900 + i * 110, 36));
  button(root, "Nav button", "Get started →", 1180, 24);

  // Hero, centred under a glow
  const blob = make(() => figma.createEllipse(), root);
  blob.name = "Glow";
  blob.resize(700, 420);
  blob.fills = solid("#c4b5fd");
  try {
    blob.effects = [{ type: "LAYER_BLUR", radius: 160, visible: true, blurType: "NORMAL" }];
  } catch (e) {
    blob.effects = [{ type: "LAYER_BLUR", radius: 160, visible: true }];
  }
  blob.x = C - 350;
  blob.y = 140;
  text(root, "Hero eyebrow", "INTRODUCING ACME AI", 13, C, 200, { width: 400, center: true, tracking: 12, color: "#6366f1" });
  text(root, "Hero title", "Unlock seamless workflows", 56, C, 230, { width: 900, center: true, bold: true });
  rule(root, "Hero rule", C - 40, 305, 80);
  text(root, "Hero subtitle",
    "Elevate your team's productivity with our all-in-one platform. Streamline, automate and scale effortlessly, with the tools you already love.",
    18, C, 320, { width: 520, center: true, color: "#6b7280" });
  button(root, "Hero button", "Get started →", C - 90, 420);

  // Features: label, heading, rule, three identical icon cards
  text(root, "Features eyebrow", "FEATURES", 13, C, 620, { width: 400, center: true, tracking: 12, color: "#6366f1" });
  text(root, "Features title", "Everything you need", 36, C, 645, { width: 800, center: true, bold: true });
  rule(root, "Features rule", C - 40, 705, 80);
  const icons = [String.fromCodePoint(0x26a1), String.fromCodePoint(0x1f512), String.fromCodePoint(0x1f680)];
  const titles = ["Lightning fast", "Secure by default", "Scale effortlessly"];
  for (let i = 0; i < 3; i++) {
    const card = frame(root, `Feature card ${i + 1}`, 120 + i * 420, 760, 360, 240, { radius: 12, effects: shadow });
    text(card, `Feature icon ${i + 1}`, icons[i], 28, 24, 24);
    text(card, `Feature title ${i + 1}`, titles[i], 20, 24, 80, { bold: true });
    text(card, `Feature body ${i + 1}`, "Seamlessly integrate with the tools you already love.", 16, 180, 116, { width: 312, center: true, color: "#6b7280" });
  }

  // Steps: label, heading, rule, numbered markers
  text(root, "Steps eyebrow", "HOW IT WORKS", 13, C, 1100, { width: 400, center: true, tracking: 12, color: "#6366f1" });
  text(root, "Steps title", "Get started in minutes", 36, C, 1125, { width: 800, center: true, bold: true });
  rule(root, "Steps rule", C - 40, 1185, 80);
  ["01 — Sign up", "02 — Connect", "03 — Launch"].forEach((s, i) => text(root, `Step ${i + 1}`, s, 20, 200 + i * 380, 1240, { bold: true }));

  // Testimonial: a card in a card, and stand-in people
  const quote = frame(root, "Testimonial", 320, 1400, 800, 320, { radius: 12, effects: shadow });
  const inner = frame(quote, "Quote card", 40, 40, 720, 240, { color: "#f5f3ff", radius: 12 });
  text(inner, "Quote", "Acme changed the way our team works. We ship twice as fast.", 22, 360, 60, { width: 600, center: true });
  text(inner, "Author", "John Doe · CEO at Acme", 16, 360, 170, { width: 400, center: true, color: "#6b7280" });

  // Footer
  text(root, "Footer", "© 2026 Acme Inc. · Privacy · Terms · hello@example.com", 14, C, 2500, { width: 700, center: true, color: "#9ca3af" });

  return { rootId: root.id, at: { x: root.x, y: root.y } };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function checkFrame(group, id) {
  const r = await mcp.call("figma_check_layout", { nodeId: id, audit: ["tells", "craft"], minSeverity: "info", limit: 1000, ...at });
  if (!r.ok || !r.data) {
    problems.push({ group, id, error: r.text });
    console.log(`  err  ${group.padEnd(9)} ${id}: ${r.text.slice(0, 120)}`);
    return;
  }
  const counts = {};
  for (const i of r.data.issues ?? []) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const rec = {
    group,
    id: r.data.root?.id ?? id,
    name: r.data.root?.name,
    checked: r.data.checked,
    ...(r.data.truncated ? { truncated: true } : {}),
    ...(r.data.more ? { more: r.data.more } : {}),
    ...(r.data.audit?.note ? { note: r.data.audit.note } : {}),
    counts,
    tells: (r.data.issues ?? []).filter((i) => TELLS.includes(i.kind)).map((i) => ({ kind: i.kind, name: i.name, detail: i.detail })),
  };
  frames.push(rec);
  const fired = TELLS.filter((k) => counts[k]);
  console.log(`  ok   ${group.padEnd(9)} "${rec.name}": ${fired.length ? fired.join(", ") : "no tells"}`);
}

let built = null;
try {
  console.log("\n-- frames");
  for (const id of FINISHED) await checkFrame("finished", id);
  for (const id of MOKU) await checkFrame("moku", id);
  console.log("\n-- generic page");
  built = await evalJs(`return await (${buildGeneric.toString()})(${JSON.stringify({ gap: 6000 })});`);
  console.log(`  built at x ${built.at.x}, y ${built.at.y}`);
  await checkFrame("generic", built.rootId);
} catch (err) {
  problems.push({ crash: String(err?.stack ?? err) });
  console.error(String(err?.stack ?? err));
}

if (built?.rootId && !KEEP) {
  try {
    await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(built.rootId)});
if (n && !n.removed && n.name === "figma-mcp calibrate-tells generic page (delete me)") n.remove();
return true;`);
  } catch (err) {
    problems.push({ cleanup: String(err?.message ?? err) });
  }
}

// ── the table ───────────────────────────────────────────────────────────────

const finished = frames.filter((f) => f.group === "finished");
const generic = frames.find((f) => f.group === "generic");
const verdicts = {};
for (const kind of [...TELLS, ...CRAFT]) {
  const onGeneric = generic?.counts[kind] ?? 0;
  const hits = finished.filter((f) => f.counts[kind]);
  verdicts[kind] = {
    audit: TELLS.includes(kind) ? "tells" : "craft",
    generic: onGeneric,
    finished: { frames: finished.length, hit: hits.length, findings: hits.reduce((s, f) => s + f.counts[kind], 0), on: hits.map((f) => f.name) },
    moku: frames.filter((f) => f.group === "moku").map((f) => ({ name: f.name, findings: f.counts[kind] ?? 0 })),
    verdict: !generic ? "unknown" : onGeneric ? (hits.length ? "noisy" : "separates") : DESIGNED.has(kind) ? "silent" : "not tested",
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  spike: "calibrate-tells",
  startedAt,
  finishedAt: new Date().toISOString(),
  session,
  inputs: { finished: FINISHED, moku: MOKU },
  rule: "A tell is kept only if it fires on the generic page and on none of the finished frames; promotion to warning is a later decision [C-248].",
  verdicts,
  frames,
  problems,
}, null, 2) + "\n");
await mcp.close();

console.log("\n-- verdicts (tells)");
for (const kind of TELLS) {
  const v = verdicts[kind];
  console.log(`  ${v.verdict.padEnd(9)} ${kind.padEnd(20)} generic ${String(v.generic).padStart(2)}   finished ${v.finished.hit}/${v.finished.frames}`);
}
console.log(`\n→ ${path.relative(process.cwd(), OUT)}${problems.length ? ` (${problems.length} problem(s) recorded)` : ""}`);
process.exit(generic ? 0 : 2);
