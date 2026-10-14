// Run the parity tools against the real canvas — the ones that bring
// figma-mcp level with what the official Figma MCP reaches through Plugin API
// JavaScript. Unit tests run against fakes, and fakes encode the author's
// assumptions; only the real Plugin API settles whether a call works.
//
// Everything is built inside one frame named "figma-mcp parity probe (delete
// me)" far off-canvas, rendered to spikes/results/live-parity.png for a human
// look, and deleted at the end unless KEEP=1.
//
// Run:  node spikes/live-parity.mjs            (needs the plugin running in Figma)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 24000;
const Y = 24000;

const results = [];
const mcp = await connect({ allowEval: true });
const registered = new Set((await mcp.list()).map((t) => t.name));
const exercised = new Set();

function short(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 150 ? s.slice(0, 150) + "…" : (s ?? "");
}

/** Call a tool, record pass/fail. `expect` may throw or return false to fail. */
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
  results.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(44)} ${why}`);
  return r;
}

/** Read nodes back through figma_eval — the document, not the tool's own report. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}

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

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp parity probe (delete me)", x: X, y: Y, layout: "vertical", gap: 32, padding: "40",
  background: "#ffffff",
});
const root = box.data?.id;
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}
const row = async (name) =>
  (await mcp.call("figma_create_frame", { name, parentId: root, layout: "horizontal", gap: 24, alignY: "center" })).data?.id;

// ── shapes ─────────────────────────────────────────────────────────────────
section("shapes");
const shapes = await row("Shapes");
const line = await step("create_line with arrow cap", "figma_create_line", {
  parentId: shapes, length: 160, color: "#1f2937", weight: 3, cap: "arrow", name: "Arrow",
}, (d) => d?.id ? true : false);
await step("line is 160 wide and 0 tall", "figma_eval", {
  code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(line.data?.id)}); return { w: n.width, h: n.height, cap: n.strokeCap, weight: n.strokeWeight };`,
}, (d) => {
  const v = d?.value ?? d;
  return v && Math.round(v.w) === 160 && v.h === 0 ? `w=${v.w} h=${v.h} cap=${v.cap}` : false;
});
await step("create_polygon (hexagon)", "figma_create_polygon", {
  parentId: shapes, width: 80, height: 80, pointCount: 6, fill: "#6366f1", name: "Hexagon",
});
await step("create_star", "figma_create_star", {
  parentId: shapes, width: 80, height: 80, pointCount: 5, innerRadius: 0.45, fill: "#f59e0b", name: "Star",
});
await step("create_vector from SVG path (relative cmds)", "figma_create_vector", {
  parentId: shapes, path: "M10 80 q 40 -80 80 0 t 80 0", width: 160, height: 60, stroke: "#10b981", strokeWeight: 4, name: "Wave",
});

// ── boolean, flatten, mask ─────────────────────────────────────────────────
section("boolean, flatten, mask");
const ops = await row("Boolean ops");
const plain = (await mcp.call("figma_create_frame", { name: "Plain", parentId: ops, width: 140, height: 100, layout: "none" })).data?.id;
const a = (await mcp.call("figma_create_ellipse", { parentId: plain, width: 70, height: 70, x: 10, y: 15, fill: "#ef4444", name: "A" })).data?.id;
const b = (await mcp.call("figma_create_ellipse", { parentId: plain, width: 70, height: 70, x: 50, y: 15, fill: "#3b82f6", name: "B" })).data?.id;
await step("boolean_nodes subtract", "figma_boolean_nodes", { nodeIds: [a, b], operation: "subtract", name: "Crescent" },
  (d) => (d?.id || d?.nodeId) ? true : false);
const plain2 = (await mcp.call("figma_create_frame", { name: "Plain 2", parentId: ops, width: 140, height: 100, layout: "none" })).data?.id;
const c = (await mcp.call("figma_create_rectangle", { parentId: plain2, width: 60, height: 60, x: 10, y: 20, fill: "#8b5cf6", name: "C" })).data?.id;
const d2 = (await mcp.call("figma_create_star", { parentId: plain2, width: 60, height: 60, x: 60, y: 20, fill: "#8b5cf6", name: "D" })).data?.id;
await step("flatten_nodes", "figma_flatten_nodes", { nodeIds: [c, d2], name: "Flat" }, (d) => (d?.id || d?.nodeId) ? true : false);
const plain3 = (await mcp.call("figma_create_frame", { name: "Masked", parentId: ops, width: 140, height: 100, layout: "none" })).data?.id;
const m = (await mcp.call("figma_create_ellipse", { parentId: plain3, width: 90, height: 90, x: 25, y: 5, fill: "#000000", name: "Mask shape" })).data?.id;
await mcp.call("figma_create_rectangle", { parentId: plain3, width: 140, height: 100, x: 0, y: 0, fill: "#14b8a6", name: "Masked content" });
await step("set_mask on the lowest shape", "figma_set_mask", { nodeId: m, isMask: true, maskType: "alpha" });

// ── layout grids ───────────────────────────────────────────────────────────
section("layout grids");
await step("set_layout_grids 12 columns", "figma_set_layout_grids", {
  nodeIds: [root], grids: [{ pattern: "columns", count: 12, gutter: 16, margin: 40, alignment: "stretch" }],
});

// ── variants and component properties ──────────────────────────────────────
section("variants and component properties");
const comps = await row("Components");
const mk = async (name, fill) => {
  const f = (await mcp.call("figma_create_frame", {
    name, parentId: comps, layout: "horizontal", padding: "12,20,12,20", background: fill, cornerRadius: 8,
  })).data?.id;
  await mcp.call("figma_create_text", { parentId: f, content: "Button", color: "#ffffff", fontSize: 16, name: "Label" });
  return (await mcp.call("figma_convert_to_component", { nodeId: f, name })).data?.id;
};
const primary = await mk("Variant=Primary", "#4f46e5");
const secondary = await mk("Variant=Secondary", "#64748b");
const set = await step("combine_as_variants", "figma_combine_as_variants", {
  componentIds: [primary, secondary], name: "Button",
}, (d) => (d?.id || d?.setId) ? true : false);
const labelInPrimary = await evalJs(
  `const c = await figma.getNodeByIdAsync(${JSON.stringify(primary)}); return c && c.findOne(n => n.type === "TEXT")?.id;`,
);
const setId = set.data?.id ?? set.data?.setId;
await step("add_component_property TEXT bound to label", "figma_add_component_property", {
  componentId: setId, name: "Label", type: "TEXT", defaultValue: "Button", bindNodeIds: labelInPrimary ? [labelInPrimary] : [],
}, (d) => (d?.key || d?.propertyKey || d?.name) ? true : false);
const inst = await step("create_instance of the set", "figma_create_instance", { componentId: setId, parentId: comps });
await step("set_instance_properties variant + label", "figma_set_instance_properties", {
  nodeId: inst.data?.id, properties: JSON.stringify({ Variant: "Secondary", Label: "Continue" }),
});
await step("instance shows Secondary + Continue", "figma_eval", {
  code: `const i = await figma.getNodeByIdAsync(${JSON.stringify(inst.data?.id)}); const t = i.findOne(n => n.type === "TEXT"); return { props: i.componentProperties, text: t && t.characters };`,
}, (d) => {
  const v = d?.value ?? d;
  const props = v?.props ?? {};
  const variant = Object.entries(props).find(([k]) => k.startsWith("Variant"))?.[1]?.value;
  return variant === "Secondary" ? `variant=${variant} text=${v?.text}` : false;
});

// ── look ───────────────────────────────────────────────────────────────────
section("look");
const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
if (png.images[0]) {
  const out = path.join(HERE, "results", "live-parity.png");
  fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
  console.log(`  saved ${path.relative(process.cwd(), out)}`);
}
await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
  (d) => `ok=${d?.ok} errors=${(d?.findings ?? []).filter((f) => f.severity === "error").length}`);

// ── cleanup ────────────────────────────────────────────────────────────────
section("cleanup");
if (KEEP) {
  console.log(`  KEEP=1 — left the sandbox ${root} in the file`);
} else {
  await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(96));
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.label)) : ""}`);
const notRun = [...registered].filter((t) => /combine_as_variants|boolean|flatten|set_mask|layout_grids|component_property|instance_properties|create_(line|polygon|star|vector)/.test(t) && !exercised.has(t));
console.log(`  parity tools registered but not exercised: ${JSON.stringify(notRun)}`);
console.log("=".repeat(96));
await mcp.close();
process.exit(failed.length ? 1 : 0);
