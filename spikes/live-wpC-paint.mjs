// Run WP-C — paints, strokes, effects, text paragraph features and SVG colour
// variables — against the real canvas. Unit tests run against fakes, and fakes
// encode the author's assumptions; only the real Plugin API settles whether a
// call works, and three things here are measurements, not checks:
//
//   - the gradient rotation sense [C-100]: an angle is written, Figma's own SVG
//     export is read back, and the handles must sit where CSS puts them. A
//     mirrored result means a sign flip in src/plugin/gradient.ts, nothing else;
//   - NOISE / TEXTURE / GLASS / progressive blur on the installed build [C-102];
//   - a variable-bound icon recolouring when the variable changes.
//
// Everything is built inside one frame named "figma-mcp WP-C probe (delete me)"
// far off-canvas, read back through figma_eval (the document, not the tool's
// own report), rendered to spikes/results/live-wpC-paint.png, and deleted at
// the end — with the styles and variables it made — unless KEEP=1.
//
// Run:  node spikes/live-wpC-paint.mjs     (needs the plugin running in Figma,
//       built from the code under test: figma_status build.matches true)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 32000;
const Y = 24000;
const STAMP = Date.now().toString(36); // variable and style names must be unique in the file
const TOLERANCE = 1.5; // px, for handle positions read off the SVG export

const results = [];
const mcp = await connect({ allowEval: true });
const registered = new Set((await mcp.list()).map((t) => t.name));
const exercised = new Set();

function short(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 160) + "…" : (s ?? "");
}

function record(label, ok, why) {
  results.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} ${why}`);
}

/** Call a tool, record pass/fail. `expect` may throw or return false to fail, or a string to report. */
async function step(label, tool, args, expect) {
  exercised.add(tool);
  const r = await mcp.call(tool, args);
  let ok = r.ok;
  let why = ok ? short(r.data ?? r.text) : short(r.text);
  if (ok && expect) {
    try {
      const verdict = await expect(r.data, r);
      if (verdict === false) {
        ok = false;
        why = "expectation failed: " + short(r.data ?? r.text);
      } else if (typeof verdict === "string") {
        why = verdict;
      }
    } catch (err) {
      ok = false;
      why = "expectation threw: " + String(err?.message ?? err);
    }
  }
  record(label, ok, why);
  return r;
}

/**
 * A call that must be refused, with a message matching `pattern`, saying it
 * changed nothing (`partial: { created: [] }`). That marker travels only in
 * structuredContent, which mcp.call() does not return, so this asks the client.
 */
async function refused(label, tool, args, pattern) {
  exercised.add(tool);
  let res;
  try {
    res = await mcp.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
  } catch (err) {
    record(label, false, `transport: ${String(err?.message ?? err)}`);
    return undefined;
  }
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const created = res.structuredContent?.partial?.created;
  const ok = res.isError === true && pattern.test(text) && Array.isArray(created) && created.length === 0;
  record(label, ok, ok ? `refused, nothing changed: ${short(text.split("\n")[0])}` : `expected a refusal matching ${pattern} with partial.created [], got ${short(text)} ${short(res.structuredContent)}`);
  return res;
}

/** Read the document back through figma_eval. */
async function evalJs(code) {
  exercised.add("figma_eval");
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}

/** A read-back step: `expr` is evaluated with `n` bound to the node. */
async function check(label, id, expr, verdict) {
  try {
    const v = await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); if (!n) return null; return ${expr};`);
    const out = verdict(v);
    record(label, out !== false, out === false ? `read back: ${short(v)}` : typeof out === "string" ? out : short(v));
    return v;
  } catch (err) {
    record(label, false, String(err?.message ?? err));
    return undefined;
  }
}

const near = (a, b, tol = TOLERANCE) => typeof a === "number" && Math.abs(a - b) <= tol;
const id = (r) => r?.data?.id;

function section(name) {
  console.log(`\n-- ${name}`);
}

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${JSON.stringify(sess?.build)}`);
if (!sess) {
  console.error("No Figma session — run the plugin in Figma first.");
  process.exit(2);
}
if (sess.build && sess.build.matches === false) console.log("  WARNING: the running plugin is not this build — results describe the old bundle.");

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp WP-C probe (delete me)", x: X, y: Y, layout: "vertical", gap: 32, padding: "40", background: "#ffffff",
});
const root = id(box);
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}
const row = async (name) =>
  id(await mcp.call("figma_create_frame", { name, parentId: root, layout: "horizontal", gap: 24, alignY: "center" }));
const plainFrame = async (parentId, name, width, height, background = "#f3f4f6") =>
  id(await mcp.call("figma_create_frame", { name, parentId, width, height, layout: "none", background }));
const rect = async (parentId, name, width = 160, height = 120, fill = "#e5e7eb") =>
  id(await mcp.call("figma_create_rectangle", { name, parentId, width, height, fill }));

const made = { styles: [], collection: null, exportFile: null };

// ── 1. gradient rotation sense: the claim gate [C-100] ─────────────────────
section("gradients — measured on Figma's own SVG export [C-100]");
const black2white = [{ position: 0, color: "#000000" }, { position: 1, color: "#ffffff" }];
const gradRow = await row("Gradients");

/** The <linearGradient> handles of a node's SVG export, in the node's pixels. */
async function linearHandles(nodeId) {
  exercised.add("figma_export_node");
  const r = await mcp.call("figma_export_node", { nodeId, format: "SVG" });
  const tag = /<linearGradient\b[^>]*>/.exec(r.text)?.[0];
  if (!tag) return { tag: null, raw: short(r.text) };
  const attr = (k) => Number(new RegExp(`\\b${k}="([-0-9.e]+)"`).exec(tag)?.[1]);
  return { tag, x1: attr("x1"), y1: attr("y1"), x2: attr("x2"), y2: attr("y2"), transformed: /gradientTransform=/.test(tag) };
}

/** Where CSS puts the ends of `linear-gradient(θ)` on a w×h box — independent of gradient.ts. */
function cssEnds(deg, w, h) {
  const t = (deg * Math.PI) / 180;
  const half = (Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t))) / 2;
  const dx = Math.sin(t) * half;
  const dy = -Math.cos(t) * half;
  return { x1: w / 2 - dx, y1: h / 2 - dy, x2: w / 2 + dx, y2: h / 2 + dy };
}

for (const angle of [180, 135]) {
  const f = await plainFrame(gradRow, `Linear ${angle}deg`, 400, 240);
  await step(`set_fills linear angle ${angle} on 400×240`, "figma_set_fills", {
    nodeIds: [f], fills: [{ gradient: { type: "linear", angle, stops: black2white } }],
  }, (d) => d?.updated === 1);
  const want = cssEnds(angle, 400, 240);
  const got = await linearHandles(f);
  if (!got.tag) {
    record(`MEASURE ${angle}deg handles`, false, `no <linearGradient> in the export: ${got.raw}`);
    continue;
  }
  const fits = near(got.x1, want.x1) && near(got.y1, want.y1) && near(got.x2, want.x2) && near(got.y2, want.y2);
  const mirrored = near(got.x1, want.x2) && near(got.y1, want.y2) && near(got.x2, want.x1) && near(got.y2, want.y1);
  record(
    `MEASURE ${angle}deg handles where CSS puts them`,
    fits,
    `export (${got.x1}, ${got.y1}) → (${got.x2}, ${got.y2}); CSS (${want.x1.toFixed(1)}, ${want.y1.toFixed(1)}) → (${want.x2.toFixed(1)}, ${want.y2.toFixed(1)})` +
      (mirrored ? " — MIRRORED: flip the sign in src/plugin/gradient.ts" : "") +
      (got.transformed ? " — export carries a gradientTransform; read the tag by hand" : ""),
  );
}

const radial = await plainFrame(gradRow, "Radial at 25% 25%", 400, 240);
await step("set_fills radial center { 0.25, 0.25 }", "figma_set_fills", {
  nodeIds: [radial], fills: [{ gradient: { type: "radial", center: { x: 0.25, y: 0.25 }, stops: black2white } }],
});
{
  const r = await mcp.call("figma_export_node", { nodeId: radial, format: "SVG" });
  const tag = /<radialGradient\b[^>]*>/.exec(r.text)?.[0] ?? "";
  const tr = /translate\(\s*([-0-9.e]+)[ ,]+([-0-9.e]+)\s*\)/.exec(tag);
  const cx = tr ? Number(tr[1]) : Number(/\bcx="([-0-9.e]+)"/.exec(tag)?.[1]);
  const cy = tr ? Number(tr[2]) : Number(/\bcy="([-0-9.e]+)"/.exec(tag)?.[1]);
  record("MEASURE radial centre at (100, 60)", near(cx, 100) && near(cy, 60), tag ? `centre (${cx}, ${cy}) from ${short(tag)}` : `no <radialGradient>: ${short(r.text)}`);
}

const angular = await plainFrame(gradRow, "Angular + diamond", 240, 240);
await step("set_fills angular centre + diamond radius", "figma_set_fills", {
  nodeIds: [angular],
  fills: [
    { gradient: { type: "angular", center: { x: 0.3, y: 0.3 }, stops: [{ position: 0, color: "#f43f5e" }, { position: 1, color: "#6366f1" }] } },
    { gradient: { type: "diamond", radius: 0.3, stops: [{ position: 0, color: "#ffffffcc" }, { position: 1, color: "#ffffff00" }] } },
  ],
});
await check("angular / diamond read back", angular, "n.fills.map(p => [p.type, p.gradientTransform])", (v) =>
  // Compared to 1e-4, not exactly: Figma may store the matrix at lower precision.
  v?.[0]?.[0] === "GRADIENT_ANGULAR" && v?.[1]?.[0] === "GRADIENT_DIAMOND" && near(v[0][1][0][2], 0.2, 1e-4) && near(v[1][1][0][0], 1 / 0.6, 1e-4)
    ? `types ${v.map((p) => p[0]).join(", ")}` : false);

const raw = await plainFrame(gradRow, "Raw transform", 240, 240);
await step("set_fills radial with a raw transform", "figma_set_fills", {
  nodeIds: [raw], fills: [{ gradient: { type: "radial", transform: [0.71, 0, 0.19, 0, 0.57, 0.21], stops: black2white } }],
});
await check("raw transform read back", raw, "n.fills[0].gradientTransform", (v) =>
  near(v?.[0]?.[0], 0.71, 1e-4) && near(v?.[0]?.[2], 0.19, 1e-4) && near(v?.[1]?.[1], 0.57, 1e-4) && near(v?.[1]?.[2], 0.21, 1e-4));
await refused("angle + transform refused, nothing changed", "figma_set_fills", {
  nodeIds: [raw], fills: [{ gradient: { type: "linear", angle: 90, transform: [1, 0, 0, 0, 1, 0], stops: black2white } }],
}, /whole matrix/);

// ── 2. images by hash, photo under a scrim [C-104] ─────────────────────────
section("images by hash [C-104]");
const imgRow = await row("Images");
// A picture without the network: render the 180deg frame to a PNG and import it.
const firstGradient = (await evalJs(`const r = await figma.getNodeByIdAsync(${JSON.stringify(gradRow)}); return r && r.children[0] && r.children[0].id;`));
const saved = await mcp.call("figma_export_node", { nodeId: firstGradient, format: "PNG", scale: 1, saveTo: `wpc-probe-${STAMP}.png` });
made.exportFile = saved.data?.path ?? null;
const imported = await step("import_image from the rendered PNG", "figma_import_image", {
  path: made.exportFile ?? `wpc-probe-${STAMP}.png`, parentId: imgRow, width: 200, name: "Imported",
}, (d) => (typeof d?.imageHash === "string" ? `hash ${d.imageHash}` : false));
const hash = imported.data?.imageHash;

const hero = await rect(imgRow, "Photo + scrim", 320, 200);
await step("set_fills [image, gradient scrim] on one node", "figma_set_fills", {
  nodeIds: [hero],
  fills: [{ image: { hash } }, { gradient: { type: "linear", angle: 180, stops: [{ position: 0, color: "#00000000" }, { position: 1, color: "#000000aa" }] } }],
});
await check("photo + scrim read back", hero, "n.fills.map(p => ({ type: p.type, hash: p.imageHash, mode: p.scaleMode }))", (v) =>
  v?.[0]?.type === "IMAGE" && v[0].hash === hash && v[0].mode === "FILL" && v?.[1]?.type === "GRADIENT_LINEAR");

const filtered = await rect(imgRow, "Filtered", 200, 200);
await step("set_fills image fit, rotation 90, filters", "figma_set_fills", {
  nodeIds: [filtered], fills: [{ image: { hash, scaleMode: "fit", rotation: 90, filters: { exposure: 0.3, saturation: -0.5 } } }],
});
await check("image filters read back", filtered, "({ mode: n.fills[0].scaleMode, rotation: n.fills[0].rotation, filters: n.fills[0].filters })", (v) =>
  v?.mode === "FIT" && v.rotation === 90 && near(v.filters?.exposure, 0.3, 1e-3) && near(v.filters?.saturation, -0.5, 1e-3));
await refused("unknown hash refused, nothing changed", "figma_set_fills", { nodeIds: [filtered], fills: [{ image: { hash: "0".repeat(40) } }] }, /names no image/);

// ── 3. strokes: sides, caps, joins, gradient [C-101] ───────────────────────
section("strokes [C-101]");
const strokeRow = await row("Strokes");
const header = await plainFrame(strokeRow, "Header (bottom border)", 400, 56, "#ffffff");
await step("set_strokes sides { bottom: 1 }", "figma_set_strokes", { nodeIds: [header], color: "#e5e7eb", sides: { bottom: 1 } });
await check("bottom border only", header, "[n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight]", (v) =>
  Array.isArray(v) && v.join(",") === "0,0,1,0");

const wave = id(await mcp.call("figma_create_vector", {
  parentId: strokeRow, path: "M0 40 L60 0 L120 40 L180 0", width: 180, height: 40, stroke: "#1f2937", strokeWeight: 3, name: "Zigzag",
}));
await step("set_strokes cap arrow, join round", "figma_set_strokes", { nodeIds: [wave], color: "#1f2937", weight: 4, cap: "arrow", join: "round" });
await check("cap / join read back", wave, "[n.strokeCap, n.strokeJoin, n.strokeWeight]", (v) => v?.[0] === "ARROW_LINES" && v[1] === "ROUND" && v[2] === 4);

const ring = await rect(strokeRow, "Gradient stroke", 120, 120, "#ffffff");
await step("set_strokes gradient", "figma_set_strokes", {
  nodeIds: [ring], gradient: { type: "linear", angle: 45, stops: [{ position: 0, color: "#22d3ee" }, { position: 1, color: "#a855f7" }] }, weight: 6,
});
await check("gradient stroke read back", ring, "[n.strokes[0].type, n.strokeWeight]", (v) => v?.[0] === "GRADIENT_LINEAR" && v[1] === 6);

const ellipse = id(await mcp.call("figma_create_ellipse", { parentId: strokeRow, width: 60, height: 60, fill: "#fde68a", name: "Ellipse" }));
await step("sides on an ellipse is a per-item error", "figma_set_strokes", { nodeIds: [ellipse], color: "#000000", sides: { top: 1 } },
  (d) => (d?.items?.[0]?.ok === false ? `item: ${d.items[0].error}` : false));

// ── 4. corner smoothing [C-101] ────────────────────────────────────────────
section("corner smoothing [C-101]");
const squircle = await rect(strokeRow, "Squircle", 120, 120, "#3b82f6");
await step("set_corner_radius radius 24 + smoothing 0.6", "figma_set_corner_radius", { nodeIds: [squircle], radius: 24, smoothing: 0.6 });
await check("radius / smoothing read back", squircle, "[n.cornerRadius, n.cornerSmoothing]", (v) => v?.[0] === 24 && near(v[1], 0.6, 1e-3));

// ── 5. recent effects [C-102] ──────────────────────────────────────────────
section("noise, texture, glass, progressive blur — the claim gate [C-102]");
const fxRow = await row("Effects");
const backdrop = await plainFrame(fxRow, "Glass backdrop", 200, 160, "#f97316");
await mcp.call("figma_set_fills", { nodeIds: [backdrop], fills: [{ gradient: { type: "linear", angle: 135, stops: [{ position: 0, color: "#f97316" }, { position: 1, color: "#7c3aed" }] } }] });
const glassPane = id(await mcp.call("figma_create_rectangle", { parentId: backdrop, width: 140, height: 100, fill: "#ffffff33", name: "Glass" }));
const fx = [
  ["NOISE monotone", { type: "NOISE", noiseSize: 1.5, density: 0.5, opacity: 0.3 }, "[e.type, e.noiseType, e.density]", (v) => v[0] === "NOISE" && v[1] === "MONOTONE"],
  ["NOISE duotone", { type: "NOISE", noiseType: "duotone", color: "#1d4ed8", secondaryColor: "#f97316", noiseSize: 2, density: 0.6 }, "[e.type, e.noiseType, !!e.secondaryColor]", (v) => v[1] === "DUOTONE" && v[2] === true],
  ["TEXTURE", { type: "TEXTURE", noiseSize: 2, radius: 4 }, "[e.type, e.noiseSize, e.clipToShape]", (v) => v[0] === "TEXTURE"],
  ["GLASS", { type: "GLASS", refraction: 0.6, depth: 16, dispersion: 0.2, radius: 2 }, "[e.type, e.depth, e.refraction]", (v) => v[0] === "GLASS" && v[1] === 16],
  ["progressive LAYER_BLUR", { type: "LAYER_BLUR", radius: 12, progressive: {} }, "[e.type, e.blurType, e.startOffset && e.startOffset.y]", (v) => v[1] === "PROGRESSIVE"],
];
for (const [label, effect, expr, verdict] of fx) {
  const target = label === "GLASS" ? glassPane : await rect(fxRow, label, 120, 120, "#93c5fd");
  const r = await step(`set_effects ${label}`, "figma_set_effects", { nodeIds: [target], effects: [effect] }, (d) =>
    d?.items?.[0]?.ok === true ? true : (() => { throw new Error(`C-102 gate: ${d?.items?.[0]?.error}`); })());
  if (r.data?.items?.[0]?.ok) {
    await check(`${label} read back`, target, `(() => { const e = n.effects[0]; return e ? ${expr} : null; })()`, (v) => Array.isArray(v) && verdict(v));
  }
}
const fxStyle = await step("create_effect_style with a progressive blur", "figma_create_effect_style", {
  name: `WP-C probe ${STAMP}/Ramp`, effects: [{ type: "BACKGROUND_BLUR", radius: 16, progressive: { startRadius: 0 } }],
});
if (id(fxStyle)) {
  made.styles.push(id(fxStyle));
  const v = await evalJs(`const s = await figma.getStyleByIdAsync(${JSON.stringify(id(fxStyle))}); return s && s.effects.map(e => e.blurType);`).catch((e) => String(e));
  record("effect style read back", Array.isArray(v) && v[0] === "PROGRESSIVE", short(v));
}

// ── 6. text: truncation, alignment, lists, paragraphs, in-file links [C-103] ─
section("text paragraph features [C-103]");
const textRow = await row("Text");
const long = id(await mcp.call("figma_create_text", {
  parentId: textRow, width: 220, fontSize: 16, name: "Truncated",
  content: "A card title long enough to need three or four lines at this width, so the ellipsis has to show.",
}));
await step("set_text_properties maxLines 2", "figma_set_text_properties", { nodeIds: [long], maxLines: 2 });
await check("truncation read back", long, "[n.textTruncation, n.maxLines]", (v) => v?.[0] === "ENDING" && v[1] === 2);

const boxed = id(await mcp.call("figma_create_text", { parentId: textRow, width: 160, fontSize: 14, content: "Fixed box that overflows its height for sure, really", name: "Boxed" }));
await step('set_text_properties autoResize "truncate" + alignVertical, leadingTrim, wrapStyle', "figma_set_text_properties", {
  nodeIds: [boxed], autoResize: "truncate", alignVertical: "center", leadingTrim: "cap-height", wrapStyle: "balance",
});
await check("fixed + truncating + aligned read back", boxed, "[n.textAutoResize, n.textTruncation, n.textAlignVertical, n.leadingTrim, n.textWrapStyle]", (v) =>
  // Figma reads textAutoResize back as the deprecated TRUNCATE once textTruncation is ENDING (measured).
  ["NONE,ENDING,CENTER,CAP_HEIGHT,BALANCE", "TRUNCATE,ENDING,CENTER,CAP_HEIGHT,BALANCE"].includes(v?.join(",")));
await step("set_text_properties truncate: false", "figma_set_text_properties", { nodeIds: [boxed], truncate: false });
await check("truncation off read back", boxed, "n.textTruncation", (v) => v === "DISABLED");

const steps = id(await mcp.call("figma_create_text", { parentId: textRow, width: 240, fontSize: 14, content: "Intro line\nFirst step\nSecond step", name: "Steps" }));
await step("set_text_range list ordered + paragraph spacing / indent", "figma_set_text_range", {
  nodeId: steps, match: "step", list: "ordered", paragraphSpacing: 8, paragraphIndent: 12,
});
await check("list / spacing read back", steps, "(() => { const s = n.characters.indexOf('First'); return [n.getRangeListOptions(s, s + 5), n.getRangeParagraphSpacing(s, s + 5), n.getRangeParagraphIndent(s, s + 5), n.getRangeListOptions(0, 5)]; })()", (v) =>
  v?.[0]?.type === "ORDERED" && v[1] === 8 && v[2] === 12 && v[3]?.type === "NONE");
await step("set_text_properties paragraphSpacing on the whole text", "figma_set_text_properties", { nodeIds: [steps], paragraphSpacing: 4 });
await check("whole-text paragraph spacing read back", steps, "n.paragraphSpacing", (v) => v === 4);

const linked = id(await mcp.call("figma_create_text", { parentId: textRow, fontSize: 14, content: "Jump to the header", name: "Link" }));
await step('set_text_range link "node:<id>"', "figma_set_text_range", { nodeId: linked, match: "header", link: `node:${header}` });
await check("in-file link read back", linked, "(() => { const s = n.characters.indexOf('header'); return n.getRangeHyperlink(s, s + 6); })()", (v) =>
  v?.type === "NODE" && v.value === header);
await refused("a link to a missing node is refused", "figma_set_text_range", { nodeId: linked, match: "Jump", link: "node:999999:999999" }, /does not exist/);

// ── 7. a range bound to styles and variables [C-103] ───────────────────────
section("text range bound to styles and variables [C-103]");
const coll = await step("create_variable_collection", "figma_create_variable_collection", { name: `WP-C probe ${STAMP}` });
made.collection = id(coll);
const sizeVar = await step("create_variable FLOAT 28", "figma_create_variable", { collectionId: made.collection, name: `wpc${STAMP}/size`, type: "FLOAT", value: "28" });
const iconVar = await step("create_variable COLOR", "figma_create_variable", { collectionId: made.collection, name: `wpc${STAMP}/icon`, type: "COLOR", value: "#2563eb" });
const textStyle = await step("create_text_style", "figma_create_text_style", { name: `WP-C probe ${STAMP}/Strong`, fontSize: 18, weight: "Bold" });
const paintStyle = await step("create_paint_style", "figma_create_paint_style", { name: `WP-C probe ${STAMP}/Accent`, color: "#16a34a" });
for (const s of [textStyle, paintStyle]) if (id(s)) made.styles.push(id(s));

const tokens = id(await mcp.call("figma_create_text", { parentId: textRow, fontSize: 14, content: "Token sized, styled, painted and linked words", name: "Tokens" }));
const range = (word) => `(() => { const s = n.characters.indexOf(${JSON.stringify(word)}); return [s, s + ${JSON.stringify(word)}.length]; })()`;

await step("set_text_range variables { fontSize }", "figma_set_text_range", { nodeId: tokens, match: "sized", variables: { fontSize: `wpc${STAMP}/size` } });
await check("bound font size read back", tokens, `(() => { const [s, e] = ${range("sized")}; return [n.getRangeBoundVariable(s, e, "fontSize"), n.getRangeFontSize(s, e)]; })()`, (v) =>
  v?.[0]?.id === id(sizeVar) && v[1] === 28);

await step("set_text_range textStyle by name", "figma_set_text_range", { nodeId: tokens, match: "styled", textStyle: `WP-C probe ${STAMP}/Strong` });
await check("range text style read back", tokens, `(() => { const [s, e] = ${range("styled")}; return n.getRangeTextStyleId(s, e); })()`, (v) =>
  typeof v === "string" && v.replace(/,$/, "") === String(id(textStyle)).replace(/,$/, ""));

await step("set_text_range fillStyle by id", "figma_set_text_range", { nodeId: tokens, match: "painted", fillStyle: id(paintStyle) });
await check("range fill style read back", tokens, `(() => { const [s, e] = ${range("painted")}; return n.getRangeFillStyleId(s, e); })()`, (v) =>
  typeof v === "string" && v.replace(/,$/, "") === String(id(paintStyle)).replace(/,$/, ""));

await step("set_text_range colorVariable", "figma_set_text_range", { nodeId: tokens, match: "linked", colorVariable: `wpc${STAMP}/icon` });
await check("range bound colour read back", tokens, `(() => { const [s, e] = ${range("linked")}; const f = n.getRangeFills(s, e); return f[0] && f[0].boundVariables && f[0].boundVariables.color && f[0].boundVariables.color.id; })()`, (v) =>
  v === id(iconVar));
await refused("an unknown variable is refused, text untouched", "figma_set_text_range", { nodeId: tokens, match: "words", variables: { fontSize: `wpc${STAMP}/nope` } }, /No variable named/);

// ── 8. an SVG icon bound to a colour variable ─────────────────────────────
section("import_svg colorVariable");
const svg =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='24' height='24'>" +
  "<circle cx='12' cy='12' r='6' fill='#000'/><path d='M3 21 L21 3' fill='none' stroke='#000' stroke-width='2'/></svg>";
const icon = await step("import_svg with colorVariable", "figma_import_svg", {
  svg, parentId: textRow, width: 48, name: "Icon / Bound", colorVariable: `wpc${STAMP}/icon`,
}, (d) => (Array.isArray(d?.vectorIds) && d.vectorIds.length >= 2 ? `vectorIds ${d.vectorIds.join(", ")}` : false));
const vectorIds = icon.data?.vectorIds ?? [];
const boundOf = `Promise.all(${JSON.stringify(vectorIds)}.map(async (id) => { const v = await figma.getNodeByIdAsync(id); const p = [...(v.fills || []), ...(v.strokes || [])]; return { fills: v.fills.length, strokes: v.strokes.length, bound: p.map(x => x.boundVariables && x.boundVariables.color && x.boundVariables.color.id), r: p[0] && p[0].color && p[0].color.r }; }))`;
const before = await evalJs(`return await ${boundOf};`).catch((e) => String(e));
record("every painted vector is bound; stroke-only stays stroke-only", Array.isArray(before) && before.every((v) => v.bound.length > 0 && v.bound.every((b) => b === id(iconVar))) && before.some((v) => v.fills === 0 && v.strokes === 1), short(before));
await step("set_variable_value recolours the icon", "figma_set_variable_value", { variableId: id(iconVar), value: "#dc2626" });
const after = await evalJs(`return await ${boundOf};`).catch((e) => String(e));
record("icon follows the variable (red channel ≈ 0.86)", Array.isArray(after) && after.every((v) => near(v.r, 0xdc / 255, 0.02)), short(after));
await refused("color + colorVariable refused before anything exists", "figma_import_svg", { svg, parentId: textRow, color: "#000000", colorVariable: `wpc${STAMP}/icon` }, /not both/);

// ── look ───────────────────────────────────────────────────────────────────
section("look");
const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
if (png.images[0]) {
  const out = path.join(HERE, "results", "live-wpC-paint.png");
  fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
  console.log(`  saved ${path.relative(process.cwd(), out)}`);
} else {
  console.log(`  no PNG inline: ${short(png.text)}`);
}
await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
  (d) => `ok=${d?.ok} errors=${(d?.findings ?? []).filter((f) => f.severity === "error").length}`);

// ── cleanup ────────────────────────────────────────────────────────────────
section("cleanup");
if (made.exportFile) {
  try {
    fs.unlinkSync(made.exportFile);
  } catch {
    /* already gone, or written where this process cannot reach */
  }
}
if (KEEP) {
  console.log(`  KEEP=1 — left the sandbox ${root}, styles ${JSON.stringify(made.styles)} and collection ${made.collection} in the file`);
} else {
  await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
  if (made.styles.length) await step("delete probe styles", "figma_delete_style", { styleIds: made.styles });
  if (made.collection) await step("delete probe variable collection", "figma_delete_variable_collection", { collectionId: made.collection });
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(100));
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.label)) : ""}`);
const wpc = ["figma_set_fills", "figma_set_strokes", "figma_set_corner_radius", "figma_set_effects", "figma_create_effect_style", "figma_set_text_properties", "figma_set_text_range", "figma_import_svg"];
console.log(`  WP-C tools registered but not exercised: ${JSON.stringify(wpc.filter((t) => registered.has(t) && !exercised.has(t)))}`);
console.log("=".repeat(100));
await mcp.close();
process.exit(failed.length ? 1 : 0);
