// WP-B on the real canvas: layout, the spec grammar, structure, verification
// and write mechanics. Unit tests run against fakes, and fakes encode the
// author's reading of the typings; only the real Plugin API settles what Figma
// does with ABSOLUTE children, wrapped rows, baseline rows, min/max limits,
// explicit variable modes, import by key and a cross-page parent. Every step
// reads the document back through figma_eval (`data.value`) rather than
// trusting the tool's own report.
//
// Everything is built inside one frame named "figma-mcp WP-B probe (delete me)"
// far off-canvas (x 28000, y 24000), rendered to spikes/results/live-wpB-layout.png,
// and deleted at the end with the tokens it made, unless KEEP=1.
//
// Run:  node spikes/live-wpB-layout.mjs            (needs the plugin running in Figma,
//       built from a tree where the integrator has wired figma_batch and
//       figma_set_clips_content; figma_status build.matches must be true)
//       UNDO=1 also checks that one figma_undo_step reverts a whole batch —
//       it triggers Figma's undo, so do not edit the file by hand while it runs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const UNDO = process.env.UNDO === "1";
const X = 28000;
const Y = 24000;

const results = [];
const measured = []; // facts for claims.md: what Figma did where only the live canvas can say
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
  if (!registered.has(tool)) {
    record(label, false, `${tool} is not registered — is the integration wired and the server rebuilt?`);
    return { ok: false, data: null, images: [], text: "" };
  }
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
 * A call that must FAIL: checks the refusal through the raw result, where
 * structuredContent carries `partial` and `safeToRetry` [C-096].
 */
async function refused(label, tool, args, expect) {
  exercised.add(tool);
  let res;
  try {
    res = await mcp.client.callTool({ name: tool, arguments: args });
  } catch (err) {
    record(label, false, "transport: " + String(err?.message ?? err));
    return null;
  }
  const sc = res.structuredContent ?? {};
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!res.isError) {
    record(label, false, "expected a refusal, got success: " + short(text));
    return sc;
  }
  let ok = true;
  let why = short(text);
  if (expect) {
    try {
      const verdict = await expect(sc, text);
      if (verdict === false) ok = false;
      else if (typeof verdict === "string") why = verdict;
    } catch (err) {
      ok = false;
      why = "expectation threw: " + String(err?.message ?? err);
    }
  }
  record(label, ok, ok ? why : "unexpected refusal shape: " + short({ text, sc }));
  return sc;
}

/** Read the document through figma_eval — the document, not the tool's own report. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error("figma_eval failed: " + short(r.text));
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}
const node = (id) => `await figma.getNodeByIdAsync(${JSON.stringify(id)})`;
/** One check of the document, recorded like a step. */
async function readBack(label, code, expect) {
  exercised.add("figma_eval");
  try {
    const v = await evalJs(code);
    const verdict = await expect(v);
    record(label, verdict !== false, typeof verdict === "string" ? verdict : short(v));
  } catch (err) {
    record(label, false, String(err?.message ?? err));
  }
}
const id = (r) => r?.data?.id ?? r?.data?.rootId;

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
for (const t of ["figma_batch", "figma_set_clips_content", "figma_eval"]) {
  if (!registered.has(t)) console.warn(`  note: ${t} is not registered; its steps will fail.`);
}

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp WP-B probe (delete me)", x: X, y: Y, width: 1200, layout: "vertical", gap: 40, padding: "40",
  background: "#ffffff",
});
const root = id(box);
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}
const cleanup = { collections: [], styles: [], nodes: [] };
const plainFrame = id(await mcp.call("figma_create_frame", { name: "Plain area", parentId: root, width: 600, height: 220, layout: "none", background: "#f9fafb" }));

// ── 1. absolute positioning inside an auto-layout [C-095] ─────────────────────
section("absolute positioning");
const card = id(await mcp.call("figma_create_frame", {
  name: "Card", parentId: root, layout: "vertical", width: 320, padding: "24", gap: 12, background: "#f3f4f6", cornerRadius: 12,
}));
await mcp.call("figma_create_text", { parentId: card, content: "Pro plan", fontSize: 20, name: "Plan" });
const badge = id(await mcp.call("figma_create_frame", {
  name: "Badge", parentId: card, layout: "horizontal", padding: "4,10,4,10", background: "#4f46e5", cornerRadius: 999,
  sizing: { horizontal: "fill" },
}));
await mcp.call("figma_create_text", { parentId: badge, content: "NEW", color: "#ffffff", fontSize: 12, name: "Badge label" });
const cardBefore = await evalJs(`const c = ${node(card)}; return c.height;`).catch(() => null);
await step("move_nodes positioning absolute (badge)", "figma_move_nodes", { nodeIds: [badge], positioning: "absolute", x: 260, y: -8 },
  (d) => (d?.items?.[0]?.ok && d.items[0].positioning === "absolute" ? `item ${short(d.items[0])}` : false));
await readBack("badge is ABSOLUTE at (260, -8), out of the flow",
  `const b = ${node(badge)}; const c = ${node(card)}; return { pos: b.layoutPositioning, x: b.x, y: b.y, sizing: b.layoutSizingHorizontal, cardH: c.height };`,
  (v) => v.pos === "ABSOLUTE" && Math.round(v.x) === 260 && Math.round(v.y) === -8 && v.sizing === "FIXED" && (cardBefore === null || v.cardH < cardBefore)
    ? `pos=${v.pos} x=${v.x} y=${v.y} card ${cardBefore}→${v.cardH}` : false);
const floater = id(await mcp.call("figma_create_frame", { name: "Floater", parentId: card, width: 40, height: 10, background: "#d1d5db" }));
await mcp.call("figma_move_nodes", { nodeIds: [floater], positioning: "absolute", x: 0, y: 0 });
await step("move_nodes positioning auto (back into the flow)", "figma_move_nodes", { nodeIds: [floater], positioning: "auto" },
  (d) => d?.items?.[0]?.ok === true);
await readBack("floater is AUTO again", `return (${node(floater)}).layoutPositioning;`, (v) => v === "AUTO");
const loose = id(await mcp.call("figma_create_rectangle", { parentId: plainFrame, width: 20, height: 20, x: 560, y: 10, fill: "#9ca3af", name: "Loose" }));
await step("move_nodes absolute under a frame with no layout → ok:false", "figma_move_nodes",
  { nodeIds: [loose], positioning: "absolute" }, (d) => d?.items?.[0]?.ok === false ? d.items[0].error : false);

// ── 2. wrapping rows [C-095] ──────────────────────────────────────────────────
section("wrap, rowGap, alignContent");
const chips = id(await step("create_frame wrap + rowGap 12", "figma_create_frame", {
  name: "Chips", parentId: root, layout: "horizontal", wrap: true, gap: 8, rowGap: 12, alignContent: "auto", width: 300,
}));
for (let i = 1; i <= 12; i++) {
  await mcp.call("figma_create_from_spec", {
    parentId: chips,
    spec: JSON.stringify({ type: "frame", name: `Chip ${i}`, layout: "horizontal", padding: "6,12,6,12", cornerRadius: 999, background: "#e0e7ff",
      children: [{ type: "text", content: `Tag ${i}`, fontSize: 13 }] }),
  });
}
await readBack("chips wrap with 12 px between rows",
  `const f = ${node(chips)}; const ys = [...new Set(f.children.map(c => Math.round(c.y)))].sort((a, b) => a - b);
   const first = f.children.find(c => Math.round(c.y) === ys[0]);
   return { wrap: f.layoutWrap, spacing: f.counterAxisSpacing, rows: ys.length, gap: ys.length > 1 ? ys[1] - (ys[0] + first.height) : null };`,
  (v) => v.wrap === "WRAP" && v.spacing === 12 && v.rows > 1 && Math.round(v.gap) === 12 ? `rows=${v.rows} gap=${v.gap}` : false);
const chipsSpec = await step("spec wrap + rowGap + alignContent", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "Chips (spec)", layout: "horizontal", wrap: true, gap: 8, rowGap: 16, alignContent: "space-between",
    width: 300, height: 160, sizing: { width: "fixed", height: "fixed" },
    children: Array.from({ length: 10 }, (_, i) => ({ type: "frame", name: `S${i + 1}`, layout: "horizontal", padding: "6,12,6,12", background: "#dcfce7",
      cornerRadius: 999, children: [{ type: "text", content: `Spec ${i + 1}`, fontSize: 13 }] })) }),
});
await readBack("spec chips: WRAP, rowGap 16, SPACE_BETWEEN",
  `const f = ${node(id(chipsSpec))}; return { wrap: f.layoutWrap, spacing: f.counterAxisSpacing, content: f.counterAxisAlignContent };`,
  (v) => v.wrap === "WRAP" && v.spacing === 16 && v.content === "SPACE_BETWEEN");
await step("set_auto_layout rowGap 20 + alignContent on a wrapping frame", "figma_set_auto_layout",
  { nodeId: chips, rowGap: 20, alignContent: "space-between" }, (d) => d?.counterAxisSpacing === 20);
await readBack("chips row gap is 20", `const f = ${node(chips)}; return [f.counterAxisSpacing, f.counterAxisAlignContent];`,
  (v) => v[0] === 20 && v[1] === "SPACE_BETWEEN");

// ── 3. baseline, negative gap, stacking [C-095] ───────────────────────────────
section("baseline, negative gap, stacking");
const price = id(await step("create_frame alignY baseline", "figma_create_frame", { name: "Price", parentId: root, layout: "horizontal", gap: 4, alignY: "baseline" }));
await mcp.call("figma_create_text", { parentId: price, content: "$29", fontSize: 40, weight: "Bold", name: "Amount" });
await mcp.call("figma_create_text", { parentId: price, content: "/mo", fontSize: 16, name: "Per" });
await readBack("price row is BASELINE aligned", `return (${node(price)}).counterAxisAlignItems;`, (v) => v === "BASELINE");
const price2 = id(await mcp.call("figma_create_frame", { name: "Price 2", parentId: root, layout: "horizontal", gap: 4 }));
await mcp.call("figma_create_text", { parentId: price2, content: "€19", fontSize: 32, name: "Amount" });
await mcp.call("figma_create_text", { parentId: price2, content: "per month", fontSize: 14, name: "Per" });
await step("set_auto_layout alignY baseline", "figma_set_auto_layout", { nodeId: price2, alignY: "baseline" }, (d) => d?.counterAxisAlignItems === "BASELINE");
await refused("alignY baseline on a column is refused, safe to retry", "figma_set_auto_layout",
  { nodeId: card, alignY: "baseline" }, (sc) => sc.safeToRetry === true && sc.partial?.created?.length === 0);
const avatars = id(await mcp.call("figma_create_frame", { name: "Avatars", parentId: root, layout: "horizontal", gap: 8 }));
for (const c of ["#f97316", "#22c55e", "#3b82f6", "#a855f7"]) {
  await mcp.call("figma_create_rectangle", { parentId: avatars, width: 40, height: 40, cornerRadius: 20, fill: c, stroke: "#ffffff", strokeWeight: 3 });
}
await step("set_auto_layout gap -12, reverseZIndex, strokesInLayout", "figma_set_auto_layout",
  { nodeId: avatars, gap: -12, reverseZIndex: true, strokesInLayout: true }, (d) => d?.itemSpacing === -12 && d?.itemReverseZIndex === true);
await readBack("avatar stack: itemSpacing -12, first on top, strokes in layout",
  `const f = ${node(avatars)}; return [f.itemSpacing, f.itemReverseZIndex, f.strokesIncludedInLayout];`,
  (v) => v[0] === -12 && v[1] === true && v[2] === true);

// ── 4. min/max limits [C-095] ─────────────────────────────────────────────────
section("min / max");
const column = id(await mcp.call("figma_create_frame", { name: "Column", parentId: root, layout: "vertical", width: 900, gap: 8 }));
const para = id(await mcp.call("figma_create_text", {
  parentId: column, name: "Paragraph", fontSize: 16,
  content: "A paragraph that fills a wide column reads badly; a max width keeps the line length comfortable while it still fills narrower columns.",
}));
await step("resize_nodes maxWidth 480 + minHeight 20 on a fill paragraph", "figma_resize_nodes", { nodeIds: [para], maxWidth: 480, minHeight: 20 },
  (d) => d?.resized === 1);
await readBack("paragraph is at most 480 wide", `const t = ${node(para)}; return { w: t.width, max: t.maxWidth, minH: t.minHeight };`,
  (v) => v.max === 480 && v.w <= 480.5 && v.minH === 20 ? `w=${v.w}` : false);
await step("resize_nodes clearLimits", "figma_resize_nodes", { nodeIds: [para], clearLimits: ["maxWidth", "minHeight"] }, (d) => d?.resized === 1);
await readBack("limits removed, the fill width is back", `const t = ${node(para)}; return { w: t.width, max: t.maxWidth, minH: t.minHeight };`,
  (v) => v.max === null && v.minH === null && v.w > 480 ? `w=${v.w}` : false);
await refused("min above max is refused before any node changes", "figma_resize_nodes", { nodeIds: [para], minWidth: 500, maxWidth: 300 },
  (sc) => sc.safeToRetry === true && sc.partial?.created?.length === 0);

// ── 5. clipping ───────────────────────────────────────────────────────────────
section("clip content");
const clip = id(await mcp.call("figma_create_frame", { name: "Clip", parentId: root, width: 160, height: 60, layout: "none", background: "#fde68a" }));
await mcp.call("figma_create_rectangle", { parentId: clip, width: 120, height: 120, x: 80, y: 20, fill: "#f59e0b", name: "Overhang" });
const rectInClip = (await evalJs(`return (${node(clip)}).children[0].id;`).catch(() => null));
await step("set_clips_content true (+ a rectangle → ok:false)", "figma_set_clips_content", { nodeIds: [clip, rectInClip].filter(Boolean), clipsContent: true },
  (d) => d?.updated === 1 && d?.items?.[1]?.ok === false ? `rect: ${d.items[1].error}` : false);
await readBack("clip frame clips", `return (${node(clip)}).clipsContent;`, (v) => v === true);
await step("set_clips_content false", "figma_set_clips_content", { nodeIds: [clip], clipsContent: false }, (d) => d?.updated === 1);
await readBack("clip frame no longer clips", `return (${node(clip)}).clipsContent;`, (v) => v === false);

// ── 6. rotation about the centre ─────────────────────────────────────────────
section("rotate pivot");
const spinner = id(await mcp.call("figma_create_rectangle", { parentId: plainFrame, width: 120, height: 60, x: 40, y: 40, fill: "#10b981", name: "Spinner" }));
const centreJs = (nid) => `const n = ${node(nid)}; const [[a, b, tx], [c, d, ty]] = n.relativeTransform;
  return { x: a * n.width / 2 + b * n.height / 2 + tx, y: c * n.width / 2 + d * n.height / 2 + ty, r: n.rotation };`;
const before = await evalJs(centreJs(spinner)).catch(() => null);
await step("rotate_nodes 45 (default centre pivot)", "figma_rotate_nodes", { nodeIds: [spinner], angle: 45 }, (d) => d?.items?.[0]?.pivot === "center");
await readBack("the centre did not move", centreJs(spinner),
  (v) => before && Math.abs(v.x - before.x) < 0.5 && Math.abs(v.y - before.y) < 0.5 && Math.round(Math.abs(v.r)) === 45
    ? `centre (${before.x.toFixed(1)}, ${before.y.toFixed(1)}) → (${v.x.toFixed(1)}, ${v.y.toFixed(1)}) rotation ${v.r}` : false);
await step("rotate_nodes 0 pivot origin", "figma_rotate_nodes", { nodeIds: [spinner], angle: 0, pivot: "origin" }, (d) => d?.items?.[0]?.pivot === "origin");

// ── 7–8. the spec grammar: strict fields, root fill, root x/y, absolute child ─
section("spec grammar");
const countKids = async () => evalJs(`return (${node(root)}).children.length;`);
const kidsBefore = await countKids();
await refused("spec with an unknown key → refused, nothing created", "figma_create_from_spec",
  { parentId: root, spec: JSON.stringify({ type: "frame", name: "Typo", layout: "horizontal", wrapp: true }) },
  async (sc, text) => sc.partial?.created?.length === 0 && sc.safeToRetry === true && /Did you mean: wrap/.test(text) && (await countKids()) === kidsBefore
    ? "refused with the nearest key; nothing on the canvas" : false);
const full = await step("spec root sizing { width: fill } into the wrapper", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "Full-width section", layout: "vertical", padding: 24, background: "#eef2ff", sizing: { width: "fill" },
    children: [{ type: "text", content: "This section spans the wrapper.", fontSize: 18 }] }),
});
await readBack("the section fills the wrapper's inner width",
  `const s = ${node(id(full))}; const w = ${node(root)}; return { sizing: s.layoutSizingHorizontal, w: s.width, inner: w.width - w.paddingLeft - w.paddingRight };`,
  (v) => v.sizing === "FILL" && Math.abs(v.w - v.inner) < 0.5 ? `w=${v.w} inner=${v.inner}` : false);
const placed = await step("spec root x/y in a frame without layout", "figma_create_from_spec", {
  parentId: plainFrame, spec: JSON.stringify({ type: "frame", name: "Placed", width: 40, height: 40, x: 300, y: 12, background: "#fca5a5" }),
});
await readBack("placed at (300, 12)", `const n = ${node(id(placed))}; return [n.x, n.y];`, (v) => v[0] === 300 && v[1] === 12);
const dotCard = await step("spec absolute child", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "Dot card", layout: "vertical", width: 240, padding: 20, background: "#f3f4f6", cornerRadius: 12,
    children: [{ type: "text", content: "Inbox", fontSize: 16 }, { type: "frame", name: "Dot", width: 12, height: 12, cornerRadius: 6,
      background: "#ef4444", positioning: "absolute", x: 232, y: -6 }] }),
});
await readBack("the dot is ABSOLUTE at (232, -6)",
  `const n = ${node(dotCard.data?.created?.[2]?.id)}; return [n.layoutPositioning, n.x, n.y];`, (v) => v[0] === "ABSOLUTE" && v[1] === 232 && v[2] === -6);

// ── 9. instances with properties, nested, by key [C-110] ──────────────────────
section("instances in the spec");
const icon = await mcp.call("figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "component", name: "WPB Icon", layout: "horizontal", padding: 2, children: [{ type: "text", name: "Glyph", content: "★", fontSize: 16, color: "#ffffff" }] }),
});
const iconId = icon.data?.rootId;
await mcp.call("figma_add_component_property", { componentId: iconId, name: "Glyph", type: "TEXT", defaultValue: "★", bindNodeIds: [icon.data?.created?.[1]?.id] });
const button = await mcp.call("figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "component", name: "WPB Button", layout: "horizontal", gap: 8, padding: "10,16,10,16", background: "#111827", cornerRadius: 8,
    children: [{ type: "instance", name: "Icon", componentId: iconId }, { type: "text", name: "Label", content: "Button", color: "#ffffff" }] }),
});
const buttonId = button.data?.rootId;
await mcp.call("figma_add_component_property", { componentId: buttonId, name: "Label", type: "TEXT", defaultValue: "Button", bindNodeIds: [button.data?.created?.[2]?.id] });
const buttons = await step("spec instances with properties + a nested instance, one call", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "Buttons", layout: "horizontal", gap: 12, children: [
    { type: "instance", componentId: buttonId, properties: { Label: "Buy now" }, nested: { Icon: { Glyph: "♥" } } },
    { type: "instance", componentId: buttonId, properties: { Label: "Learn more" } },
  ] }),
}, (d) => (d?.created ?? []).every((c) => !c.ignored));
await readBack("labels and the nested glyph were set without a follow-up call",
  `const a = ${node(buttons.data?.created?.[1]?.id)}; const b = ${node(buttons.data?.created?.[2]?.id)};
   const texts = (n) => n.findAll(x => x.type === "TEXT").map(t => t.characters);
   return { a: texts(a), b: texts(b) };`,
  (v) => v.a.includes("Buy now") && v.a.includes("♥") && v.b.includes("Learn more") ? JSON.stringify(v) : false);
await refused("a misspelt property is refused before any node exists", "figma_create_from_spec",
  { parentId: root, spec: JSON.stringify({ type: "instance", componentId: buttonId, properties: { Lable: "x" } }) },
  (sc, text) => sc.partial?.created?.length === 0 && /Label#/.test(text));
const key = await evalJs(`return (${node(buttonId)}).key;`).catch(() => null);
{
  // To measure [C-110]: does importComponentByKeyAsync take a LOCAL, unpublished
  // component's key under this manifest? Either outcome passes if it is clean.
  exercised.add("figma_create_from_spec");
  const res = await mcp.client.callTool({ name: "figma_create_from_spec", arguments: {
    parentId: root, spec: JSON.stringify({ type: "instance", name: "By key", componentKey: key ?? "missing" }) } });
  const text = (res.content ?? []).map((b) => b.text ?? "").join(" ");
  const clean = !res.isError || res.structuredContent?.partial?.created?.length === 0;
  measured.push(`C-110 componentKey of a local unpublished component: ${res.isError ? "refused — " + short(text) : "imported and placed"}`);
  record("spec componentKey (local key; outcome is a measurement)", clean, res.isError ? "refused cleanly: " + short(text) : "imported");
}

// ── 10–11. variable modes, icon colour variable, ids in the maps [C-105] ─────
section("variables in the spec");
// Names unique to this run: the spec resolves by name, and a leftover from an
// interrupted run (or KEEP=1) must not answer for this one.
const stamp = String(Date.now() % 1_000_000);
const theme = `WPB Theme ${stamp}`;
const coll = await mcp.call("figma_create_variable_collection", { name: theme, modes: ["Light", "Dark"] });
const collId = coll.data?.id;
if (collId) cleanup.collections.push(collId);
const dark = coll.data?.modes?.find((m) => m.name === "Dark");
const bg = await mcp.call("figma_create_variable", { collectionId: collId, name: `wpb${stamp}/bg`, type: "COLOR", value: "#ffffff" });
const fg = await mcp.call("figma_create_variable", { collectionId: collId, name: `wpb${stamp}/icon`, type: "COLOR", value: "#4f46e5" });
if (dark) {
  await mcp.call("figma_set_variable_value", { variableId: bg.data?.id, modeId: dark.modeId, value: "#111827" });
  const panel = await step("spec variableModes { <theme>: Dark }", "figma_create_from_spec", {
    parentId: root,
    spec: JSON.stringify({ type: "frame", name: "Dark panel", width: 200, height: 60, variableModes: { [theme]: "Dark" }, variables: { fill: `wpb${stamp}/bg` } }),
  });
  await readBack("the panel pins Dark explicitly",
    `const n = ${node(id(panel))}; return n.explicitVariableModes;`,
    (v) => v && v[collId] === dark.modeId ? JSON.stringify(v) : false);
} else {
  // A Starter file refuses a second mode [C-047]: the default one still pins.
  measured.push(`C-047 second mode refused on this plan: ${short(coll.data?.warnings ?? coll.text)}`);
  const panel = await step("spec variableModes { <theme>: <default> } (Starter: one mode)", "figma_create_from_spec", {
    parentId: root,
    spec: JSON.stringify({ type: "frame", name: "Themed panel", width: 200, height: 60, variableModes: { [theme]: coll.data?.modes?.[0]?.name ?? "Light" } }),
  });
  await readBack("the panel pins the default mode explicitly",
    `const n = ${node(id(panel))}; return n.explicitVariableModes;`, (v) => v && typeof v[collId] === "string");
}
const iconSpec = await step("spec svg colorVariable", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "svg", name: "Bound icon", width: 32,
    svg: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 12h16M12 4v16" stroke="#000000" stroke-width="2"/></svg>',
    colorVariable: `wpb${stamp}/icon` }),
});
await readBack("every painted vector is bound to wpb/icon, strokes stay strokes",
  `const n = ${node(id(iconSpec))}; const vs = n.findAll(x => x.type === "VECTOR");
   return vs.map(v => ({ s: (v.strokes[0]?.boundVariables?.color?.id) ?? null, f: v.fills.length }));`,
  (v) => v.length > 0 && v.every((x) => x.s === fg.data?.id) ? JSON.stringify(v) : false);
await refused("variables.fill on an svg is refused (use colorVariable)", "figma_create_from_spec",
  { parentId: root, spec: JSON.stringify({ type: "svg", svg: '<svg viewBox="0 0 24 24"></svg>', variables: { fill: `wpb${stamp}/icon` } }) },
  (sc, text) => sc.partial?.created?.length === 0 && /colorVariable/.test(text));
const style = await mcp.call("figma_create_paint_style", { name: `WPB/Accent ${stamp}`, color: "#4f46e5" });
if (style.data?.id) cleanup.styles.push(style.data.id);
const byIds = await step("spec variables / style maps by id", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "By ids", layout: "horizontal", gap: 8, children: [
    { type: "frame", name: "Var by id", width: 40, height: 40, variables: { fill: fg.data?.id } },
    { type: "frame", name: "Style by id", width: 40, height: 40, style: { fill: style.data?.id } },
  ] }),
});
await readBack("bound by the ids given",
  `const a = ${node(byIds.data?.created?.[1]?.id)}; const b = ${node(byIds.data?.created?.[2]?.id)};
   return { v: a.fills[0]?.boundVariables?.color?.id, s: b.fillStyleId };`,
  (v) => v.v === fg.data?.id && v.s === style.data?.id);

// ── 12. figma_batch [C-096] ───────────────────────────────────────────────────
section("batch");
const tile = id(await mcp.call("figma_create_rectangle", { parentId: root, width: 160, height: 80, fill: "#e5e7eb", name: "Tile" }));
const tileState = `const n = ${node(tile)}; return { fill: n.fills[0]?.color, r: n.cornerRadius, fx: n.effects.length, o: n.opacity };`;
const tileBefore = await evalJs(tileState).catch(() => null);
await step("batch: set_fills + set_corner_radius + set_effects", "figma_batch", {
  steps: JSON.stringify([
    { op: "set_fills", params: { nodeIds: [tile], fills: [{ color: "#f43f5e" }] } },
    { op: "set_corner_radius", params: { nodeIds: [tile], radius: 16 } },
    { op: "set_effects", params: { nodeIds: [tile], effects: [{ type: "DROP_SHADOW", y: 6, radius: 16, opacity: 0.2 }] } },
  ]),
}, (d) => d?.completed === 3);
await readBack("all three edits landed", tileState,
  (v) => Math.round(v.fill?.r * 255) === 0xf4 && v.r === 16 && v.fx === 1);
await refused("a schema-invalid step: nothing runs, safe to retry", "figma_batch", {
  steps: JSON.stringify([
    { op: "set_opacity", params: { nodeIds: [tile], opacity: 0.5 } },
    { op: "set_opacity", params: { nodeIds: [tile], opacity: 2 } },
  ]),
}, async (sc, text) => sc.safeToRetry === true && /steps\[1\]\.params\.opacity/.test(text) && (await evalJs(tileState)).o === 1);
if (UNDO) {
  await step("one undo step reverts the whole batch (UNDO=1)", "figma_undo_step", { confirm: true, count: 1 });
  await readBack("tile is back to its state before the batch", tileState,
    (v) => tileBefore && v.r === tileBefore.r && v.fx === tileBefore.fx ? JSON.stringify(v) : false);
} else {
  console.log("  note  one-undo-step check skipped: run with UNDO=1, or press Ctrl+Z once by hand and watch Tile revert fully.");
}

// ── 13. check_layout: new kinds, audits, every selected root ─────────────────
section("check_layout");
const qa = await step("build a section with known defects", "figma_create_from_spec", {
  parentId: root,
  spec: JSON.stringify({ type: "frame", name: "QA", layout: "vertical", gap: 12, padding: 16, background: "#ffffff", children: [
    { type: "text", name: "Heading", content: "Title", fontSize: 24 },
    { type: "text", name: "Odd font", content: "Set in another family", fontFamily: "Arial" },
    { type: "frame", name: "Hug parent", layout: "vertical", children: [{ type: "frame", name: "Fill child", height: 20, background: "#c7d2fe", sizing: { width: "fill" } }] },
    { type: "text", name: "Thread", content: "Collapsed text here", width: 4 },
    { type: "frame", name: "Board", width: 300, height: 120, children: [
      { type: "frame", name: "Stack A", width: 100, height: 80, x: 0, y: 0, background: "#fecaca" },
      { type: "frame", name: "Stack B", width: 100, height: 80, x: 10, y: 10, background: "#bbf7d0" },
    ] },
  ] }),
});
const qaId = id(qa);
await step("check_layout audit tokens/names/fonts, expectFonts Inter", "figma_check_layout",
  { nodeId: qaId, audit: ["tokens", "names", "fonts"], expectFonts: ["Inter"] },
  (d) => {
    const ks = new Set((d?.issues ?? []).map((i) => i.kind));
    const want = ["placeholder_text", "fill_in_hug", "text_collapsed", "sibling_overlap"];
    const missing = want.filter((k) => !ks.has(k));
    measured.push(`check_layout audit on the live QA section: kinds ${JSON.stringify([...ks])}; designSystem ${d?.audit?.designSystem}; fonts ${JSON.stringify(d?.fonts)}`);
    return missing.length === 0 && d?.audit?.ran?.length === 3 && d?.fonts ? `kinds ${[...ks].join(", ")}` : `missing ${missing.join(", ")}`;
  });
const sel = await mcp.call("figma_get_selection", {});
const prior = (sel.data?.nodes ?? []).map((n) => n.id);
await mcp.call("figma_select", { nodeIds: [qaId, card] });
await step("check_layout with two selected roots checks both", "figma_check_layout", { minSeverity: "error" },
  (d) => (d?.roots?.length === 2 ? `roots ${d.roots.map((r) => r.name).join(", ")}` : false));
if (prior.length) await mcp.call("figma_select", { nodeIds: prior });

// ── 14. an error says whether a retry is safe [C-096] ────────────────────────
section("safeToRetry");
await refused("rowGap on a frame that does not wrap: safeToRetry true", "figma_set_auto_layout", { nodeId: price, rowGap: 4 },
  (sc) => sc.safeToRetry === true);
await refused("a read that fails: safeToRetry present", "figma_get_node", { nodeId: "0:999999" },
  (sc) => typeof sc.safeToRetry === "boolean" ? `safeToRetry=${sc.safeToRetry}` : false);

// ── 15. a parent on a page the user is not looking at [C-090] ────────────────
section("cross-page parent");
const pages = (await mcp.call("figma_get_pages", {})).data?.pages ?? [];
const away = pages.find((p) => !p.current);
if (away) {
  const far = await step(`create_frame on page "${away.name}" (not current)`, "figma_create_frame",
    { parentId: away.id, name: "figma-mcp WP-B far probe (delete me)", x: X, y: Y, width: 40, height: 40 });
  if (id(far)) cleanup.nodes.push(id(far));
  await readBack("it landed on that page", `const n = ${node(id(far))}; let p = n; while (p && p.type !== "PAGE") p = p.parent; return p && p.id;`,
    (v) => v === away.id);
  measured.push(`C-090 create_frame with parentId = a non-current page: ${far.ok ? "worked (parentFor loads it)" : "failed — " + short(far.text)}`);
} else {
  console.log("  note  only one page in this file: the cross-page parent check needs a second page.");
}

// ── look ───────────────────────────────────────────────────────────────────
section("look");
const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
if (png.images[0]) {
  const out = path.join(HERE, "results", "live-wpB-layout.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
  console.log(`  saved ${path.relative(process.cwd(), out)}`);
} else {
  record("render the sandbox", false, short(png.text));
}
await step("check_layout on the sandbox (errors only)", "figma_check_layout", { nodeId: root, minSeverity: "error" },
  (d) => `ok=${d?.ok} errors=${d?.counts?.error} (the QA section's thread is deliberate)`);

// ── cleanup ────────────────────────────────────────────────────────────────
section("cleanup");
if (KEEP) {
  console.log(`  KEEP=1 — left the sandbox ${root}, collection ${cleanup.collections.join(", ")}, styles ${cleanup.styles.join(", ")}`);
} else {
  await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root, ...cleanup.nodes] });
  for (const c of cleanup.collections) await step("delete the probe collection", "figma_delete_variable_collection", { collectionId: c });
  if (cleanup.styles.length) await step("delete the probe style", "figma_delete_style", { styleIds: cleanup.styles });
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(100));
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.label)) : ""}`);
const wpbTools = ["figma_batch", "figma_set_clips_content", "figma_move_nodes", "figma_resize_nodes", "figma_rotate_nodes", "figma_set_auto_layout",
  "figma_create_frame", "figma_create_from_spec", "figma_check_layout"];
console.log(`  WP-B tools not exercised: ${JSON.stringify(wpbTools.filter((t) => !exercised.has(t)))}`);
console.log("  measured (for docs/reference/claims.md):");
for (const m of measured) console.log(`    - ${m}`);
console.log("=".repeat(100));
await mcp.close();
process.exit(failed.length ? 1 : 0);
