// WP-D on the real canvas: design tokens — variables with scopes, code syntax
// and aliases created in one call, collections and modes edited, a mode shown
// on a frame, variables bound inside effects, grids, text and styles, styles
// updated in place, grid styles, and the library variables a plugin can list.
//
// Unit tests run against fakes, and fakes encode the author's assumptions;
// this settles the ones only the live Plugin API can: the object overload of
// setExplicitVariableModeForCollection under dynamic-page [C-105], scopes and
// code syntax as Figma stores them [C-106], the teamlibrary permission [C-107],
// in-place style updates keeping consumers linked and variables bound inside
// styles [C-108], and a STRING variable bound to a TEXT node's fontFamily
// [C-109]. Every write is read back from the document through figma_eval, not
// from the tool's own report.
//
// Everything lives in one frame named "figma-mcp WP-D probe (delete me)" far
// off-canvas plus one variable collection and a few styles, all tagged with
// this run's id; the frame is rendered to spikes/results/live-wpD-tokens.png
// and everything is deleted at the end unless KEEP=1.
//
// Run:  node spikes/live-wpD-tokens.mjs     (after npm run build, with the
// plugin re-run in Figma so figma_status reports build.matches: true)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 36000;
const Y = 24000;
const TAG = Date.now().toString(36);
const NEW_TOOLS = [
  "figma_create_variables", "figma_set_variable_properties", "figma_update_variable_collection", "figma_set_variable_mode",
  "figma_create_grid_style", "figma_update_style", "figma_get_library_variables",
];

const results = [];
const measured = [];
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

/** A tool call that must be REFUSED; `match` tests the error text. */
async function refused(label, tool, args, match) {
  exercised.add(tool);
  const r = await mcp.call(tool, args);
  const ok = !r.ok && match.test(r.text);
  record(label, ok, ok ? short(r.text.split("\n")[0]) : `expected a refusal matching ${match}, got ${short(r.text)}`);
  return r;
}

/** Read the document through figma_eval — the document, not the tool's own report. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}

/** A read-back: `code` returns a value from the document, `expect` judges it. */
async function readBack(label, code, expect) {
  exercised.add("figma_eval");
  try {
    const v = await evalJs(code);
    const verdict = expect(v);
    record(label, verdict !== false, typeof verdict === "string" ? verdict : short(v));
    return v;
  } catch (err) {
    record(label, false, String(err?.message ?? err));
    return undefined;
  }
}

const J = (v) => JSON.stringify(v);
const section = (name) => console.log(`\n-- ${name}`);

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${JSON.stringify(sess?.build)}`);
if (!sess) {
  console.error("No Figma session — run the plugin in Figma first.");
  process.exit(2);
}
if (sess.build && sess.build.matches === false) console.warn("WARNING: the plugin build does not match dist/ — re-run the plugin in Figma first.");
const missing = NEW_TOOLS.filter((t) => !registered.has(t));
if (missing.length) console.warn(`WARNING: not registered (integration pending?): ${missing.join(", ")}`);

const styleIds = [];
let collectionId;
let root;

try {
  // ── collection and modes ─────────────────────────────────────────────────
  section("collection and modes");
  const col = await step("create_variable_collection (no modes)", "figma_create_variable_collection", { name: `mcp-parity tokens ${TAG}` },
    (d) => d?.modes?.[0]?.name === "Default" ? `first mode "${d.modes[0].name}"` : false);
  collectionId = col.data?.id;
  if (!collectionId) throw new Error("no collection; stopping");
  await readBack("collection's first mode reads Default", `const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)}); return c.modes.map(m => m.name);`,
    (v) => Array.isArray(v) && v[0] === "Default");
  const dark = await mcp.call("figma_add_variable_mode", { collectionId, name: "Dark" });
  const paid = dark.ok;
  measured.push(`second mode on this file: ${paid ? "accepted (paid plan)" : `refused — ${short(dark.text.split("\n")[0])} [C-047]`}`);
  console.log(`  info  ${measured[measured.length - 1]}`);
  const modes = paid ? ["Default", "Dark"] : ["Default"];
  const vals = (light, darkValue) => (paid ? [{ mode: "Default", value: light }, { mode: "Dark", value: darkValue }] : [{ mode: "Default", value: light }]);

  // ── variables in one call [C-106] ────────────────────────────────────────
  section("create_variables");
  const made = await step("create_variables: primitives + semantic alias", "figma_create_variables", {
    collectionId,
    variables: [
      { name: "color/blue/500", type: "COLOR", values: vals("#3b82f6", "#3b82f6"), scopes: [] },
      { name: "color/gray/900", type: "COLOR", values: vals("#111827", "#111827"), scopes: [] },
      { name: "color/bg/brand", type: "COLOR", values: vals("alias:color/blue/500", "alias:color/gray/900"), scopes: ["ALL_FILLS"], codeSyntax: { WEB: "var(--color-bg-brand)" } },
      { name: "color/shadow", type: "COLOR", values: vals("#0000001a", "#00000066"), scopes: ["EFFECT_COLOR"] },
      { name: "grid/columns", type: "FLOAT", values: vals("12", "12"), scopes: [] },
      { name: "font/size/body", type: "FLOAT", values: vals("18", "18"), scopes: ["FONT_SIZE"] },
      { name: "font/family/body", type: "STRING", values: vals("Inter", "Inter"), scopes: ["FONT_FAMILY"] },
    ],
  }, (d) => d?.created === 7 ? `created ${d.created}` : false);
  const id = Object.fromEntries((made.data?.items ?? []).map((i) => [i.name, i.id]));
  await readBack("scopes, code syntax and the alias as Figma stores them", `
    const get = (i) => figma.variables.getVariableByIdAsync(i);
    const blue = await get(${J(id["color/blue/500"])}); const bg = await get(${J(id["color/bg/brand"])});
    const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)});
    return { blueScopes: blue.scopes, bgScopes: bg.scopes, web: bg.codeSyntax.WEB, first: bg.valuesByMode[c.modes[0].modeId] };`,
    (v) => v && v.blueScopes.length === 0 && J(v.bgScopes) === J(["ALL_FILLS"]) && v.web === "var(--color-bg-brand)" && v.first?.type === "VARIABLE_ALIAS" && v.first.id === id["color/blue/500"]);
  await step("create_variables ifExists skip keeps all", "figma_create_variables", {
    collectionId, ifExists: "skip", variables: [{ name: "color/blue/500", type: "COLOR", values: vals("#000000", "#000000") }],
  }, (d) => d?.skipped === 1 && d?.created === 0);
  await readBack("skip left the value alone", `const v = await figma.variables.getVariableByIdAsync(${J(id["color/blue/500"])}); const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)}); const x = v.valuesByMode[c.modes[0].modeId]; return Math.round(x.b * 255);`,
    (v) => v === 0xf6);
  await refused("create_variables refuses a COLOR scoped GAP", "figma_create_variables", {
    collectionId, variables: [{ name: `bad/${TAG}`, type: "COLOR", values: [{ mode: "Default", value: "#000" }], scopes: ["GAP"] }],
  }, /cannot be scoped GAP/);

  // ── one variable with every new parameter ───────────────────────────────
  section("create_variable");
  const gap = await step("create_variable scopes/codeSyntax/description/hidden", "figma_create_variable", {
    collectionId, name: "space/gap", type: "FLOAT", value: "16", scopes: ["GAP"], codeSyntax: { WEB: "var(--space-gap)" },
    description: "Gap between items", hiddenFromPublishing: true,
  });
  await readBack("space/gap as stored", `const v = await figma.variables.getVariableByIdAsync(${J(gap.data?.id)}); return { s: v.scopes, w: v.codeSyntax.WEB, d: v.description, h: v.hiddenFromPublishing };`,
    (v) => J(v?.s) === J(["GAP"]) && v.w === "var(--space-gap)" && v.d === "Gap between items" && v.h === true);
  const text = await step("create_variable value alias:", "figma_create_variable", {
    collectionId, name: "color/text/default", type: "COLOR", value: "alias:color/gray/900", scopes: ["TEXT_FILL"],
  });
  await readBack("color/text/default aliases gray/900", `const v = await figma.variables.getVariableByIdAsync(${J(text.data?.id)}); const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)}); return v.valuesByMode[c.modes[0].modeId];`,
    (v) => v?.type === "VARIABLE_ALIAS" && v.id === id["color/gray/900"]);
  await refused("create_variable refuses a duplicate name", "figma_create_variable", { collectionId, name: "space/gap", type: "FLOAT", value: "8" }, /already has a variable named/);

  // ── reads with values ────────────────────────────────────────────────────
  section("figma_get_variable_defs");
  await step("file-wide: values per mode, alias names, scopes, codeSyntax", "figma_get_variable_defs", { collectionId }, (d) => {
    const bg = d?.variables?.find((v) => v.name === "color/bg/brand");
    return bg?.values?.Default === "alias:color/blue/500" && J(bg.scopes) === J(["ALL_FILLS"]) && bg.codeSyntax?.WEB === "var(--color-bg-brand)"
      && d.collections?.[0]?.defaultMode === "Default" ? `bg = ${J(bg.values)}` : false;
  });
  const page1 = await step("file-wide limit 1 paginates", "figma_get_variable_defs", { collectionId, limit: 1 }, (d) => d?.truncated === true && d?.count === 1 && !!d?.nextCursor);
  await step("cursor continues", "figma_get_variable_defs", { collectionId, limit: 1, cursor: page1.data?.nextCursor }, (d) => d?.count === 1 && d.variables[0].name !== page1.data?.variables?.[0]?.name);

  // ── the sandbox and bindings [C-108] [C-109] ─────────────────────────────
  section("sandbox and bindings");
  const box = await step("create sandbox frame", "figma_create_frame", {
    name: "figma-mcp WP-D probe (delete me)", x: X, y: Y, layout: "vertical", gap: 24, padding: "40", background: "#ffffff",
  });
  root = box.data?.id;
  if (!root) throw new Error("no sandbox frame; stopping");
  const card = (await mcp.call("figma_create_frame", { name: "Card", parentId: root, width: 360, height: 160, layout: "vertical", padding: "24", gap: 12, background: "#eeeeee", cornerRadius: 16 })).data?.id;
  await step("bind color/bg/brand to the card fill", "figma_bind_variable_to_node", { nodeIds: [card], field: "fill", variableName: "color/bg/brand" }, (d) => d?.updated === 1);
  await readBack("card fill bound to color/bg/brand", `const n = await figma.getNodeByIdAsync(${J(card)}); return n.fills[0].boundVariables?.color?.id;`, (v) => v === id["color/bg/brand"]);
  await step("get_variable_defs { nodeId } on the card", "figma_get_variable_defs", { nodeId: card }, (d) =>
    d?.variables?.["color/bg/brand"] === "#3b82f6" && d?.details?.variables?.[0]?.codeSyntax?.WEB === "var(--color-bg-brand)" ? `variables ${J(d.variables)}` : false);
  await step("get_variable_defs { nodeId, maxNodes }", "figma_get_variable_defs", { nodeId: root, maxNodes: 1 }, (d) => d?.nodeCount === 1 && d?.truncated === true);

  await mcp.call("figma_set_effects", { nodeIds: [card], effects: [{ type: "DROP_SHADOW", color: "#0000001a", y: 4, radius: 12 }] });
  await step("bind effect.color", "figma_bind_variable_to_node", { nodeIds: [card], field: "effect.color", variableName: "color/shadow" }, (d) => d?.updated === 1);
  await readBack("effect 0 colour bound", `const n = await figma.getNodeByIdAsync(${J(card)}); return n.effects[0].boundVariables?.color?.id;`, (v) => v === id["color/shadow"]);

  const two = (await mcp.call("figma_create_rectangle", { parentId: root, width: 120, height: 40, fill: "#ffffff", name: "Two fills" })).data?.id;
  await mcp.call("figma_set_fills", { nodeIds: [two], fills: [{ gradient: { type: "linear", stops: [{ position: 0, color: "#000000" }, { position: 1, color: "#ffffff" }] } }, { color: "#ff0000", opacity: 0.5 }] });
  await step("bind fill index 0 (a gradient) is refused per item", "figma_bind_variable_to_node", { nodeIds: [two], field: "fill", variableName: "color/blue/500" },
    (d) => d?.updated === 0 && /only SOLID/.test(d?.items?.[0]?.error ?? ""));
  await readBack("the gradient is still there", `const n = await figma.getNodeByIdAsync(${J(two)}); return n.fills[0].type;`, (v) => v === "GRADIENT_LINEAR");
  await step("bind fill index 1", "figma_bind_variable_to_node", { nodeIds: [two], field: "fill", variableName: "color/blue/500", index: 1 }, (d) => d?.updated === 1);
  await readBack("paint 1 bound, paint 0 untouched", `const n = await figma.getNodeByIdAsync(${J(two)}); return [n.fills[0].type, n.fills[1].boundVariables?.color?.id];`,
    (v) => v?.[0] === "GRADIENT_LINEAR" && v[1] === id["color/blue/500"]);

  await mcp.call("figma_set_layout_grids", { nodeIds: [root], grids: [{ pattern: "columns", count: 4, gutter: 16, margin: 40 }] });
  await step("bind grid.count", "figma_bind_variable_to_node", { nodeIds: [root], field: "grid.count", variableName: "grid/columns" }, (d) => d?.updated === 1);
  await readBack("grid count bound and resolved to 12", `const n = await figma.getNodeByIdAsync(${J(root)}); return [n.layoutGrids[0].boundVariables?.count?.id, n.layoutGrids[0].count];`,
    (v) => v?.[0] === id["grid/columns"] ? `count=${v[1]}` : false);

  // Text fields on a TEXT node: the typings allow them, the official notes deny
  // fontSize / fontWeight / lineHeight — so these are measurements, recorded
  // either way, and a refusal must come back per item rather than as a crash [C-109].
  const body = (await mcp.call("figma_create_text", { parentId: card, content: "Bound text", fontSize: 14, name: "Body" })).data?.id;
  for (const [field, variableName] of [["fontSize", "font/size/body"], ["fontFamily", "font/family/body"]]) {
    exercised.add("figma_bind_variable_to_node");
    const r = await mcp.call("figma_bind_variable_to_node", { nodeIds: [body], field, variableName });
    const accepted = r.ok && r.data?.updated === 1;
    const bound = accepted
      ? await evalJs(`const n = await figma.getNodeByIdAsync(${J(body)}); const b = n.boundVariables?.[${J(field)}]; return [Array.isArray(b) ? b[0]?.id : b?.id, n.fontSize, n.fontName];`).catch(() => null)
      : null;
    measured.push(`TEXT node ${field} bound to a ${field === "fontSize" ? "FLOAT" : "STRING"} variable [C-109]: ${accepted
      ? `accepted, read back ${bound?.[0] === id[variableName] ? "bound" : "NOT bound"} (fontSize ${bound?.[1]}, font ${J(bound?.[2])})`
      : `refused — ${short(r.data?.items?.[0]?.error ?? r.text)}`}`);
    console.log(`  info  ${measured[measured.length - 1]}`);
    record(`bind ${field} on a TEXT answers per item`, r.ok && Array.isArray(r.data?.items), short(r.data?.items?.[0] ?? r.text));
  }

  // ── a mode on a frame [C-105] ────────────────────────────────────────────
  section("figma_set_variable_mode");
  const pin = paid ? "Dark" : "Default";
  await step(`set_variable_mode ${pin} on the card`, "figma_set_variable_mode", { nodeIds: [card], collectionId, mode: pin },
    (d) => d?.updated === 1 && (paid || /only one mode/.test(d?.note ?? "")));
  await readBack("explicitVariableModes pins the mode (object overload under dynamic-page)", `
    const n = await figma.getNodeByIdAsync(${J(card)}); const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)});
    const v = await figma.variables.getVariableByIdAsync(${J(id["color/bg/brand"])});
    const m = c.modes.find(x => x.name === ${J(pin)}); const r = v.resolveForConsumer(n).value;
    return { pinned: n.explicitVariableModes[c.id] === m.modeId, b: Math.round(r.b * 255) };`,
    (v) => v?.pinned === true && v.b === (paid ? 0x27 : 0xf6) ? `resolved blue channel ${v.b}` : false);
  if (paid) {
    await step("get_variable_defs { nodeId } reads the Dark value", "figma_get_variable_defs", { nodeId: card }, (d) => d?.variables?.["color/bg/brand"] === "#111827");
  }
  await step("set_variable_mode clear", "figma_set_variable_mode", { nodeIds: [card], collectionName: `mcp-parity tokens ${TAG}`, clear: true }, (d) => d?.updated === 1);
  await readBack("the pin is gone", `const n = await figma.getNodeByIdAsync(${J(card)}); return n.explicitVariableModes[${J(collectionId)}] ?? null;`, (v) => v === null);

  // ── styles [C-108] ───────────────────────────────────────────────────────
  section("styles");
  const ts = await step('create_text_style "150%", "-2%", upper, paragraph, description', "figma_create_text_style", {
    name: `wpD ${TAG}/Label`, fontSize: 14, weight: "600", lineHeight: "150%", letterSpacing: "-2%", case: "upper", decoration: "none",
    paragraphSpacing: 8, paragraphIndent: 0, description: "Overline labels",
  });
  if (ts.data?.id) styleIds.push(ts.data.id);
  await readBack("text style as stored", `const s = await figma.getStyleByIdAsync(${J(ts.data?.id)}); return { lh: s.lineHeight, ls: s.letterSpacing, c: s.textCase, p: s.paragraphSpacing, d: s.description };`,
    (v) => v?.lh?.unit === "PERCENT" && v.lh.value === 150 && v.ls?.unit === "PERCENT" && v.c === "UPPER" && v.p === 8 && v.d === "Overline labels");
  await step("get_styles TEXT shows the value line", "figma_get_styles", { type: "TEXT" }, (d) => {
    const s = d?.styles?.TEXT?.find((x) => x.id === ts.data?.id);
    return s && /150%/.test(s.value) && /upper/.test(s.value) && s.description === "Overline labels" ? s.value : false;
  });
  const g1 = await step("get_styles limit 1 paginates", "figma_get_styles", { limit: 1 }, (d) => d?.count === 1);
  if (g1.data?.nextCursor) await step("get_styles cursor continues", "figma_get_styles", { limit: 1, cursor: g1.data.nextCursor }, (d) => d?.count === 1);

  const label = (await mcp.call("figma_create_text", { parentId: card, content: "Overline", name: "Label" })).data?.id;
  await mcp.call("figma_apply_style_to_node", { nodeIds: [label], styleId: ts.data?.id, type: "text" });
  await step("update_style fontSize in place", "figma_update_style", { styleId: ts.data?.id, fontSize: 20 }, (d) => d?.changed?.includes("fontSize"));
  await readBack("the consumer followed (still linked, 20 px)", `const n = await figma.getNodeByIdAsync(${J(label)}); return [n.textStyleId === ${J(ts.data?.id)}, n.fontSize];`,
    (v) => v?.[0] === true && v[1] === 20);
  await step("update_style binds font size inside the style", "figma_update_style", { styleId: ts.data?.id, variables: [{ field: "fontSize", variableName: "font/size/body" }] },
    (d) => d?.variables?.fontSize === "font/size/body");
  await readBack("text style fontSize bound", `const s = await figma.getStyleByIdAsync(${J(ts.data?.id)}); return s.boundVariables?.fontSize?.id;`, (v) => v === id["font/size/body"]);
  await refused("update_style refuses a field of another kind", "figma_update_style", { styleId: ts.data?.id, color: "#ff0000" }, /belongs to a paint style/);

  const ps = await step("create_paint_style fills + variableName + description", "figma_create_paint_style", {
    name: `wpD ${TAG}/Brand`, fills: [{ color: "#3b82f6" }], variableName: "color/bg/brand", description: "Brand surface",
  }, (d) => d?.variable?.name === "color/bg/brand");
  if (ps.data?.id) styleIds.push(ps.data.id);
  await readBack("paint style colour bound", `const s = await figma.getStyleByIdAsync(${J(ps.data?.id)}); return [s.paints[0].boundVariables?.color?.id, s.description];`,
    (v) => v?.[0] === id["color/bg/brand"] && v[1] === "Brand surface");
  await step("update_style paint: rename + colour", "figma_update_style", { styleId: ps.data?.id, name: `wpD ${TAG}/Brand 2`, color: "#2563eb" }, (d) => d?.name === `wpD ${TAG}/Brand 2`);

  const es = await step("create_effect_style + description", "figma_create_effect_style", {
    name: `wpD ${TAG}/Elevation`, effects: [{ type: "DROP_SHADOW", color: "#0000001a", y: 4, radius: 12 }], description: "Card shadow",
  });
  if (es.data?.id) styleIds.push(es.data.id);
  await step("update_style binds effect.color inside the style", "figma_update_style", { styleId: es.data?.id, variables: [{ field: "effect.color", variableName: "color/shadow" }] },
    (d) => d?.variables?.["effect.color"] === "color/shadow");
  await readBack("effect style colour bound", `const s = await figma.getStyleByIdAsync(${J(es.data?.id)}); return [s.effects[0].boundVariables?.color?.id, s.description];`,
    (v) => v?.[0] === id["color/shadow"] && v[1] === "Card shadow");

  const gs = await step("create_grid_style", "figma_create_grid_style", {
    name: `wpD ${TAG}/Grid 12`, grids: [{ pattern: "columns", count: 12, gutter: 24, margin: 64 }], description: "Desktop grid",
  }, (d) => d?.kind === "GRID" && d?.gridCount === 1);
  if (gs.data?.id) styleIds.push(gs.data.id);
  await readBack("grid style as stored", `const s = await figma.getStyleByIdAsync(${J(gs.data?.id)}); const g = s.layoutGrids[0]; return [g.pattern, g.count, g.gutterSize, g.offset, s.description];`,
    (v) => J(v) === J(["COLUMNS", 12, 24, 64, "Desktop grid"]));
  await step("update_style grid count", "figma_update_style", { styleId: gs.data?.id, grids: [{ pattern: "columns", count: 8, gutter: 16, margin: 32 }] },
    (d) => d?.value === "columns 8, gutter 16, margin 32");

  // ── properties and collection edits ──────────────────────────────────────
  section("set_variable_properties / update_variable_collection");
  await step("set_variable_properties rename + hidden + codeSyntax", "figma_set_variable_properties", {
    variableIds: [gap.data?.id], name: "space/gap/md", hiddenFromPublishing: false, codeSyntax: { WEB: "", ANDROID: "spaceGapMd" },
  }, (d) => d?.updated === 1);
  await readBack("renamed, published, WEB removed, ANDROID set", `const v = await figma.variables.getVariableByIdAsync(${J(gap.data?.id)}); return { n: v.name, h: v.hiddenFromPublishing, c: v.codeSyntax };`,
    (v) => v?.n === "space/gap/md" && v.h === false && v.c?.WEB === undefined && v.c?.ANDROID === "spaceGapMd");
  await step("set_variable_properties scopes per type (one refused per item)", "figma_set_variable_properties", {
    variableNames: ["space/gap/md", "color/text/default"], scopes: ["GAP", "WIDTH_HEIGHT"],
  }, (d) => d?.updated === 1 && d?.items?.[1]?.ok === false);
  await step("update_variable_collection renameModes", "figma_update_variable_collection", { collectionId, renameModes: [{ mode: "Default", name: "Light" }] },
    (d) => d?.modes?.[0]?.name === "Light");
  await readBack("mode renamed in the document", `const c = await figma.variables.getVariableCollectionByIdAsync(${J(collectionId)}); return c.modes.map(m => m.name);`,
    (v) => v?.[0] === "Light");
  await refused("update_variable_collection never removes the last mode", "figma_update_variable_collection", { collectionId, removeModes: modes.length === 1 ? ["Light"] : ["Light", "Dark"] }, /at least one mode/);

  // ── library variables [C-107] ────────────────────────────────────────────
  section("figma_get_library_variables");
  exercised.add("figma_get_library_variables");
  const lib = await mcp.call("figma_get_library_variables", {});
  const libOk = lib.ok || /^UNSUPPORTED/.test(lib.text);
  measured.push(`teamLibrary under this manifest [C-107]: ${lib.ok ? `listed ${lib.data?.count} collection(s)` : short(lib.text.split("\n")[0])}`);
  record("get_library_variables answers (list or a clear UNSUPPORTED)", libOk, measured[measured.length - 1]);
  const firstKey = lib.data?.collections?.[0]?.key;
  if (firstKey) await step("get_library_variables { collectionKey, limit }", "figma_get_library_variables", { collectionKey: firstKey, limit: 5 }, (d) => Array.isArray(d?.variables));

  // ── look ─────────────────────────────────────────────────────────────────
  section("look");
  const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
  if (png.images[0]) {
    const out = path.join(HERE, "results", "live-wpD-tokens.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), out)}`);
  }
  await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
    (d) => `ok=${d?.ok} errors=${(d?.findings ?? []).filter((f) => f.severity === "error").length}`);
} catch (err) {
  record("run", false, String(err?.message ?? err));
} finally {
  // ── cleanup ──────────────────────────────────────────────────────────────
  section("cleanup");
  if (KEEP) {
    console.log(`  KEEP=1 — left the sandbox ${root}, collection ${collectionId} and styles ${JSON.stringify(styleIds)} in the file`);
  } else {
    if (styleIds.length) await step("delete the styles", "figma_delete_style", { styleIds }, (d) => d?.deleted === styleIds.length);
    if (collectionId) await step("delete the collection", "figma_delete_variable_collection", { collectionId });
    if (root) await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(100));
console.log("  measured:");
for (const m of measured) console.log(`    - ${m}`);
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.label)) : ""}`);
const notRun = NEW_TOOLS.filter((t) => registered.has(t) && !exercised.has(t));
console.log(`  WP-D tools registered but not exercised: ${JSON.stringify(notRun)}`);
console.log("=".repeat(100));
await mcp.close();
process.exit(failed.length ? 1 : 0);
