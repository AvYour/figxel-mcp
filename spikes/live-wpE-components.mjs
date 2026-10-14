// Run the WP-E component tools against the real canvas: a variant grid, property
// reuse / rename / delete, descriptions, slots, the component read, the local
// component list, and library import by key. Unit tests run against fakes, and
// fakes encode the author's assumptions; this settles the facts the code leaves
// to measurement:
//   [C-110] import*ByKeyAsync under this manifest, and Figma's text for a key
//           that is not published;
//   [C-112] createSlot, filling a slot through parentId, resetSlot;
//   [C-113] whether editComponentProperty's rename carries the layers'
//           references and the instances' overrides along (`rewired` > 0 means
//           it did not, and the tool moved them itself);
//   [C-090] get_local_components sees every page.
//
// Everything is built inside one frame named "figma-mcp WP-E probe (delete me)"
// far off-canvas, rendered to spikes/results/live-wpE-components.png, and
// deleted at the end unless KEEP=1. A paint style and a variable collection are
// made outside it (styles and variables have no parent) and deleted with it.
//
// Optional: LIBRARY_KEY / LIBRARY_SET_KEY name a published library component /
// component set to import. Without them the probe looks for a library instance
// already in the file and uses its main component's key.
//
// Run:  node spikes/live-wpE-components.mjs      (needs the plugin running in Figma)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 40000;
const Y = 24000;
const J = JSON.stringify;
const NEW_TOOLS = [
  "figma_get_component", "figma_import_library_assets", "figma_edit_component_property", "figma_delete_component_property",
  "figma_set_description", "figma_create_slot", "figma_reset_slot",
];
const EXTENDED = ["figma_create_instance", "figma_swap_component", "figma_add_component_property", "figma_set_instance_properties", "figma_convert_to_component", "figma_combine_as_variants", "figma_get_local_components"];

const results = [];
const mcp = await connect({ allowEval: true });
const tools = await mcp.list();
const registered = new Set(tools.map((t) => t.name));
const exercised = new Set();

function short(v) {
  const s = typeof v === "string" ? v : J(v);
  return s && s.length > 160 ? s.slice(0, 160) + "…" : (s ?? "");
}

function record(label, ok, why) {
  results.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(56)} ${why}`);
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

/** A call that must be refused: passes when the tool errors and its text matches. */
async function refused(label, tool, args, pattern) {
  exercised.add(tool);
  const r = await mcp.call(tool, args);
  const ok = !r.ok && pattern.test(r.text);
  record(label, ok, ok ? `refused: ${short(r.text.split("\n")[0])}` : `expected a refusal matching ${pattern}, got ${short(r.text)}`);
  return r;
}

/** Read the document through figma_eval — the document, not the tool's own report. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  return r.data?.value;
}

/** A read-back step: `check(value)` returns true/a string to pass, false to fail. */
async function readBack(label, code, check) {
  return step(label, "figma_eval", { code }, (d) => check(d?.value));
}

function section(name) {
  console.log(`\n-- ${name}`);
}

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${J(sess?.build)}`);
if (!sess) {
  console.error("No Figma session — run the plugin in Figma first.");
  process.exit(2);
}
const missing = [...NEW_TOOLS, "figma_eval"].filter((t) => !registered.has(t));
if (missing.length) console.log(`  WARNING: not registered here: ${J(missing)} — build, re-run the plugin, restart the client.`);

const outside = { styles: [], collections: [] };

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp WP-E probe (delete me)", x: X, y: Y, layout: "vertical", gap: 40, padding: "40", background: "#ffffff",
});
const root = box.data?.id;
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}

// ── 1. a variant grid ──────────────────────────────────────────────────────
section("variants: create_from_spec + combine_as_variants columns");
const button = (size, state) => ({
  type: "component", name: `Size=${size}, State=${state}`, layout: "horizontal",
  padding: size === "Large" ? "16,28,16,28" : "8,16,8,16", background: state === "Hover" ? "#3730a3" : "#4f46e5", cornerRadius: 8,
  children: [{ type: "text", name: "Label", content: "Button", color: "#ffffff", fontSize: size === "Large" ? 18 : 14 }],
});
const built = await step("create_from_spec: 4 button components", "figma_create_from_spec", {
  parentId: root,
  spec: J({ type: "frame", name: "Variants", layout: "horizontal", gap: 24, children: [button("Small", "Default"), button("Large", "Hover"), button("Small", "Hover"), button("Large", "Default")] }),
}, (d) => (d?.created ?? []).filter((c) => /^Size=/.test(c.name)).length === 4);
const compIds = (built.data?.created ?? []).filter((c) => /^Size=/.test(c.name)).map((c) => c.id);

const combined = await step("combine_as_variants columns=State gap=20 + description", "figma_combine_as_variants", {
  componentIds: compIds, name: "WP-E Button", columns: "State", gap: 20, description: "Primary button",
}, (d) => (d?.grid?.columns?.length === 2 && d.grid.rows?.length === 2
  ? `columns ${J(d.grid.columns)} rows ${J(d.grid.rows.map((r) => r.label))}` : false));
const setId = combined.data?.id;
await readBack("grid: one x per State, page coordinates match, description", `
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return { layoutMode: s.layoutMode, description: s.description,
    cells: s.children.map(v => ({ name: v.name, x: v.x, y: v.y, ax: v.absoluteTransform[0][2], ay: v.absoluteTransform[1][2] })) };
`, (v) => {
  if (!v) return false;
  const col = (state) => [...new Set(v.cells.filter((c) => c.name.includes(`State=${state}`)).map((c) => c.x))];
  const grid = combined.data?.grid;
  const hoverAx = v.cells.find((c) => c.name.includes("State=Hover"))?.ax;
  const gridHover = grid?.columns?.find((c) => c.value === "Hover")?.x;
  const ok = v.layoutMode === "NONE" && v.description === "Primary button" && col("Default").length === 1 && col("Hover").length === 1 &&
    col("Default")[0] < col("Hover")[0] && Math.abs(hoverAx - gridHover) < 0.5;
  return ok ? `Default x=${col("Default")} Hover x=${col("Hover")} (page ${hoverAx} = grid ${gridHover})` : false;
});
const variants = (await evalJs(`
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return s.children.map(v => ({ id: v.id, name: v.name, label: v.findOne(n => n.type === "TEXT")?.id }));
`)) ?? [];
const variantId = (name) => variants.find((v) => v.name === name)?.id;

// ── 2. properties: add, reuse, rename, default, unbind / bind ─────────────────
section("component properties");
const prop = await step("add_component_property TEXT Label (one variant bound)", "figma_add_component_property", {
  componentId: setId, name: "Label", type: "TEXT", defaultValue: "Button", bindNodeIds: [variants[0]?.label],
}, (d) => (d?.key && d.bound?.length === 4 ? `key ${d.key}, bound in ${d.bound.length} variants` : false));
await step("add_component_property again → reused, no duplicate", "figma_add_component_property", {
  componentId: setId, name: "Label", type: "TEXT", defaultValue: "Button", bindNodeIds: [variants[1]?.label],
}, (d) => d?.reused === true && d.key === prop.data?.key);
await readBack("one Label property on the set", `
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return Object.keys(s.componentPropertyDefinitions);
`, (keys) => (keys?.filter((k) => k.startsWith("Label#")).length === 1 ? J(keys) : false));

const inst = await step("create_instance of the set + variant", "figma_create_instance", {
  componentId: setId, variant: "Size=Large, State=Hover", parentId: root,
}, (d) => d?.componentId === variantId("Size=Large, State=Hover") && d.componentSetId === setId);
const instId = inst.data?.id;
await step("set_instance_properties Label=Override", "figma_set_instance_properties", { nodeId: instId, properties: J({ Label: "Override" }) });
const renamed = await step("edit_component_property rename Label→Text", "figma_edit_component_property", {
  componentId: setId, property: "Label", name: "Text",
}, (d) => (d?.key?.startsWith("Text#") && d.previousKey === prop.data?.key ? `key ${d.key}, rewired ${d.rewired ?? 0} [C-113]` : false));
const textKey = renamed.data?.key;
await readBack("C-113: override and wiring survive the rename", `
  const i = await figma.getNodeByIdAsync(${J(instId)});
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return { props: i.componentProperties, text: i.findOne(n => n.type === "TEXT")?.characters,
    refs: s.children.map(v => v.findOne(n => n.type === "TEXT")?.componentPropertyReferences?.characters) };
`, (v) => {
  const entry = Object.entries(v?.props ?? {}).find(([k]) => k === textKey);
  const ok = entry?.[1]?.value === "Override" && v.text === "Override" && v.refs.every((r) => r === textKey);
  return ok ? `instance text "${v.text}", ${v.refs.length} labels on ${textKey}; rename ${renamed.data?.rewired ? "did NOT" : "did"} carry references` : false;
});
await step("edit_component_property defaultValue", "figma_edit_component_property", { componentId: setId, property: "Text", defaultValue: "Click me" });
await readBack("default reads back", `
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return s.componentPropertyDefinitions[${J(textKey)}]?.defaultValue;
`, (v) => v === "Click me");
await step("edit_component_property unbindNodeIds (twins too)", "figma_edit_component_property", {
  componentId: setId, property: "Text", unbindNodeIds: [variants[0]?.label],
}, (d) => d?.unbound?.length === 4);
await readBack("no label is wired any more", `
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return s.children.map(v => v.findOne(n => n.type === "TEXT")?.componentPropertyReferences?.characters ?? null);
`, (refs) => refs?.every((r) => r === null));
await step("edit_component_property bindNodeIds (twins too)", "figma_edit_component_property", {
  componentId: setId, property: "Text", bindNodeIds: [variants[2]?.label],
}, (d) => d?.bound?.length === 4);
await refused("edit: defaultValue on a VARIANT is refused", "figma_edit_component_property", { componentId: setId, property: "State", defaultValue: "Hover" }, /VARIANT property has no default/);
await refused("delete: a VARIANT property is refused", "figma_delete_component_property", { componentId: setId, property: "State" }, /VARIANT property/);

// ── 3. instance swap, preferred values, delete ───────────────────────────────
section("instance swap, preferred values, delete");
const iconsBuilt = await step("create_from_spec: two icon components", "figma_create_from_spec", {
  parentId: root,
  spec: J({ type: "frame", name: "Icons", layout: "horizontal", gap: 12, children: [
    { type: "component", name: "Icon/Star", width: 24, height: 24, children: [{ type: "star", width: 24, height: 24, fill: "#f59e0b" }] },
    { type: "component", name: "Icon/Dot", width: 24, height: 24, children: [{ type: "ellipse", width: 24, height: 24, fill: "#10b981" }] },
  ] }),
});
const starId = iconsBuilt.data?.created?.find((c) => c.name === "Icon/Star")?.id;
const dotId = iconsBuilt.data?.created?.find((c) => c.name === "Icon/Dot")?.id;
const chipBuilt = await step("create_from_spec: a Chip component with an icon instance", "figma_create_from_spec", {
  parentId: root,
  spec: J({ type: "component", name: "WP-E Chip", layout: "horizontal", gap: 8, padding: "8,12,8,12", background: "#eef2ff", cornerRadius: 16, children: [
    { type: "instance", name: "Icon", componentId: starId },
    { type: "text", name: "Chip label", content: "Chip", fontSize: 14, color: "#1e1b4b" },
  ] }),
});
const chipId = chipBuilt.data?.rootId;
const chipIcon = await evalJs(`const c = await figma.getNodeByIdAsync(${J(chipId)}); return c && c.findOne(n => n.type === "INSTANCE")?.id;`);
await step("add_component_property INSTANCE_SWAP + preferredValues", "figma_add_component_property", {
  componentId: chipId, name: "Icon", type: "INSTANCE_SWAP", defaultValue: starId, bindNodeIds: [chipIcon], preferredValues: [starId, dotId],
}, (d) => d?.preferredValues?.length === 2);
await readBack("preferred values are the two icon KEYS", `
  const c = await figma.getNodeByIdAsync(${J(chipId)});
  const [star, dot] = await Promise.all([figma.getNodeByIdAsync(${J(starId)}), figma.getNodeByIdAsync(${J(dotId)})]);
  const def = Object.entries(c.componentPropertyDefinitions).find(([k]) => k.startsWith("Icon#"))?.[1];
  return { pv: def?.preferredValues, keys: [star.key, dot.key] };
`, (v) => (J(v?.pv?.map((p) => p.key)) === J(v?.keys) ? J(v.pv) : false));
await step("edit_component_property preferredValues → [Dot]", "figma_edit_component_property", { componentId: chipId, property: "Icon", preferredValues: [dotId] });
await readBack("one preferred value left", `
  const c = await figma.getNodeByIdAsync(${J(chipId)});
  return Object.entries(c.componentPropertyDefinitions).find(([k]) => k.startsWith("Icon#"))?.[1]?.preferredValues;
`, (pv) => pv?.length === 1);
await step("add_component_property BOOLEAN Show icon", "figma_add_component_property", {
  componentId: chipId, name: "Show icon", type: "BOOLEAN", defaultValue: "true", bindNodeIds: [chipIcon],
});
await step("delete_component_property Show icon", "figma_delete_component_property", { componentId: chipId, property: "Show icon" },
  (d) => d?.deleted?.startsWith("Show icon#"));
await readBack("Show icon is gone, and so is its wiring", `
  const c = await figma.getNodeByIdAsync(${J(chipId)});
  const icon = await figma.getNodeByIdAsync(${J(chipIcon)});
  return { keys: Object.keys(c.componentPropertyDefinitions), refs: icon.componentPropertyReferences };
`, (v) => (!v?.keys?.some((k) => k.startsWith("Show icon#")) ? `keys ${J(v.keys)} refs ${J(v.refs)}` : false));

// ── 4. reads ───────────────────────────────────────────────────────────────
section("get_component, get_local_components");
await step("get_component on a variant → the set's definitions", "figma_get_component", { nodeId: variants[0]?.id }, (d) =>
  d?.owner?.id === setId && d.properties?.some((p) => p.name === "State" && p.variantOptions?.length === 2) &&
  d.properties.some((p) => p.key === textKey) && d.references?.length >= 4 && d.variants?.length === 4
    ? `${d.properties.length} properties, ${d.references.length} references, default ${d.defaultVariantId}` : false);
await step("get_component on the instance → its main component", "figma_get_component", { nodeId: instId }, (d) =>
  d?.instanceId === instId && d.id === variantId("Size=Large, State=Hover") && d.owner?.id === setId);
await step("get_component paginates references", "figma_get_component", { nodeId: setId, limit: 2 }, async (d) => {
  if (!d?.truncated || !d.nextCursor) return false;
  const next = await mcp.call("figma_get_component", { nodeId: setId, limit: 2, cursor: d.nextCursor });
  return next.ok && next.data?.references?.length >= 2 ? `page 2: ${next.data.references.length}` : false;
});
await step("get_component names a local preferred value", "figma_get_component", { nodeId: chipId }, (d) =>
  d?.properties?.find((p) => p.type === "INSTANCE_SWAP")?.preferredValues?.[0]?.name === "Icon/Dot");
const local = await step("get_local_components: key, setId, variantCount, options", "figma_get_local_components", {}, (d) => {
  const set = d?.componentSets?.find((s) => s.id === setId);
  const v = d?.components?.find((c) => c.id === variants[0]?.id);
  return set?.variantCount === 4 && set.key && set.description === "Primary button" && set.properties?.State?.length === 2 && v?.setId === setId
    ? `${d.componentCount} components, ${d.componentSetCount} sets` : false;
});
await readBack("C-090: the list matches a whole-document find", `
  await figma.loadAllPagesAsync();
  return { components: figma.root.findAllWithCriteria({ types: ["COMPONENT"] }).length,
    sets: figma.root.findAllWithCriteria({ types: ["COMPONENT_SET"] }).length, pages: figma.root.children.length };
`, (v) => (v?.components === local.data?.componentCount && v.sets === local.data?.componentSetCount
  ? `${v.components} components / ${v.sets} sets across ${v.pages} page(s)` : false));
const pageId = await evalJs("return figma.currentPage.id;");
await step("get_local_components { pageId }", "figma_get_local_components", { pageId }, (d) => d?.componentSets?.some((s) => s.id === setId));

// ── 5. slots ───────────────────────────────────────────────────────────────
section("slots [C-112]");
const cardBuilt = await step("create_from_spec: a Card component", "figma_create_from_spec", {
  parentId: root,
  spec: J({ type: "component", name: "WP-E Card", layout: "vertical", gap: 12, padding: "16", width: 320, background: "#f8fafc", children: [
    { type: "text", name: "Title", content: "Card title", fontSize: 16, color: "#0f172a" },
  ] }),
});
const cardId = cardBuilt.data?.rootId;
const slot = await step("create_slot name/layout/size/sizing", "figma_create_slot", {
  componentId: cardId, name: "Content", layout: "vertical", width: 288, height: 120, sizing: { horizontal: "fill" },
}, (d) => (d?.slotId && d.propertyKey ? `slot ${d.slotId}, property ${d.propertyKey}` : false));
await readBack("the slot and its SLOT property read back", `
  const s = await figma.getNodeByIdAsync(${J(slot.data?.slotId)});
  const c = await figma.getNodeByIdAsync(${J(cardId)});
  return { type: s.type, name: s.name, layoutMode: s.layoutMode, h: s.height, sizing: s.layoutSizingHorizontal, parent: s.parent.id,
    def: c.componentPropertyDefinitions[${J(slot.data?.propertyKey)}], slotRef: s.componentPropertyReferences };
`, (v) => (v?.type === "SLOT" && v.name === "Content" && v.layoutMode === "VERTICAL" && v.parent === cardId && v.def?.type === "SLOT"
  ? `h=${v.h} sizing=${v.sizing} refs=${J(v.slotRef)}` : false));
await refused("create_slot on a set is refused", "figma_create_slot", { componentId: setId }, /component set/);
const card = await step("create_instance of the Card", "figma_create_instance", { componentId: cardId, parentId: root });
const slotInInstance = await evalJs(`
  const i = await figma.getNodeByIdAsync(${J(card.data?.id)});
  return i.findAllWithCriteria({ types: ["SLOT"] })[0]?.id;
`);
await step("fill the slot: create_text parentId = slot in the instance", "figma_create_text", {
  parentId: slotInInstance, content: "Slot content", fontSize: 14, color: "#334155", name: "Filled",
});
await readBack("the instance's slot holds the new text", `
  const s = await figma.getNodeByIdAsync(${J(slotInInstance)});
  return s.children.map(n => n.name);
`, (names) => (names?.includes("Filled") ? J(names) : false));
// The full key: whether the property takes the slot layer's later name is not known.
await refused("set_instance_properties refuses the SLOT", "figma_set_instance_properties", {
  nodeId: card.data?.id, properties: J({ [slot.data?.propertyKey ?? "Content"]: "x" }),
}, /is a SLOT/);
await step("reset_slot", "figma_reset_slot", { nodeIds: [slotInInstance] }, (d) => d?.reset === 1);
await readBack("the slot is back to the component's content", `
  const s = await figma.getNodeByIdAsync(${J(slotInInstance)});
  return s ? s.children.map(n => n.name) : "gone";
`, (names) => (Array.isArray(names) && !names.includes("Filled") ? J(names) : false));

// ── 6. descriptions ────────────────────────────────────────────────────────
section("descriptions");
await step("set_description on the set: text + link", "figma_set_description", {
  targetId: setId, description: "The primary action.", documentationLink: "https://example.com/button",
}, (d) => d?.documentationLink === "https://example.com/button");
await readBack("set description and link read back", `
  const s = await figma.getNodeByIdAsync(${J(setId)});
  return { d: s.description, links: s.documentationLinks };
`, (v) => v?.d === "The primary action." && v.links?.[0]?.uri === "https://example.com/button");
await step("set_description on a variant → note", "figma_set_description", { targetId: variants[0]?.id, description: "x" }, (d) => /belongs on its set/.test(d?.note ?? ""));
const style = await mcp.call("figma_create_paint_style", { name: "WP-E probe / Accent", color: "#4f46e5" });
if (style.data?.id) outside.styles.push(style.data.id);
await step("set_description on a local style (markdown)", "figma_set_description", {
  targetId: style.data?.id, description: "**Accent** for primary actions", markdown: true,
});
await readBack("style markdown description reads back", `
  const s = await figma.getStyleByIdAsync(${J(style.data?.id)});
  return { md: s.descriptionMarkdown, plain: s.description };
`, // a paint style has no descriptionMarkdown in this runtime, so markdown lands as plain text [C-111]
  (v) => (/Accent/.test(v?.md ?? v?.plain ?? "") ? J(v) : false));
const coll = await mcp.call("figma_create_variable_collection", { name: "WP-E probe" });
if (coll.data?.id) outside.collections.push(coll.data.id);
const variable = await mcp.call("figma_create_variable", { collectionId: coll.data?.id, name: "probe/accent", type: "COLOR", value: "#4f46e5" });
await step("set_description on a local variable", "figma_set_description", { targetId: variable.data?.id, description: "Accent colour" });
await readBack("variable description reads back", `
  const v = await figma.variables.getVariableByIdAsync(${J(variable.data?.id)});
  return v.description;
`, (d) => d === "Accent colour");
await refused("a link on a variable is refused", "figma_set_description", { targetId: variable.data?.id, documentationLink: "https://example.com" }, /no documentation link/);
const frame = await mcp.call("figma_create_frame", { name: "To convert", parentId: root, width: 80, height: 40, background: "#e2e8f0" });
const converted = await step("convert_to_component + description", "figma_convert_to_component", { nodeId: frame.data?.id, name: "WP-E Converted", description: "Made by the probe" });
await readBack("converted component description reads back", `
  const c = await figma.getNodeByIdAsync(${J(converted.data?.id)});
  return c.description;
`, (d) => d === "Made by the probe");

// ── 7. swap ────────────────────────────────────────────────────────────────
section("swap_component with variant");
await step("swap_component set + variant", "figma_swap_component", { nodeId: instId, componentId: setId, variant: "Size=Small, State=Default" });
await readBack("the instance shows Small / Default", `
  const i = await figma.getNodeByIdAsync(${J(instId)});
  return (await i.getMainComponentAsync())?.name;
`, (name) => name === "Size=Small, State=Default");

// ── 8. library import by key [C-110] ─────────────────────────────────────────
section("library import by key [C-110]");
let libKey = process.env.LIBRARY_KEY;
let libSetKey = process.env.LIBRARY_SET_KEY;
if (!libKey && !libSetKey) {
  const found = await evalJs(`
    await figma.loadAllPagesAsync();
    const all = figma.root.findAllWithCriteria({ types: ["INSTANCE"] }).slice(0, 300);
    for (const i of all) {
      const m = await i.getMainComponentAsync();
      if (m && m.remote) return { key: m.key, setKey: m.parent && m.parent.type === "COMPONENT_SET" ? m.parent.key : null, name: m.name };
    }
    return null;
  `);
  if (found) {
    libKey = found.key;
    libSetKey = found.setKey ?? undefined;
    console.log(`  using the library component "${found.name}" found in this file`);
  } else {
    console.log("  no library instance in this file and no LIBRARY_KEY: only the refusal paths run");
  }
}
const localSetKey = local.data?.componentSets?.find((s) => s.id === setId)?.key;
const assets = [
  { kind: "component", key: "0000000000000000000000000000000000000000" },
  ...(localSetKey ? [{ kind: "component_set", key: localSetKey }] : []),
  ...(libKey ? [{ kind: "component", key: libKey }] : []),
  ...(libSetKey ? [{ kind: "component_set", key: libSetKey }] : []),
];
await step("import_library_assets: per-item results", "figma_import_library_assets", { assets }, (d) => {
  const bogus = d?.items?.[0];
  const real = d?.items?.find((i) => i.key === libKey);
  const local = d?.items?.find((i) => i.key === localSetKey);
  if (!bogus || bogus.ok) return false;
  if (libKey && !real?.ok) return false;
  return `bogus key: "${bogus.error}"; unpublished local set: ${local ? (local.ok ? "imported" : `"${local.error}"`) : "n/a"}; library: ${real ? real.ok : "n/a"}`;
});
const childCount = async () => evalJs(`return (await figma.getNodeByIdAsync(${J(root)})).children.length;`);
const before = await childCount();
await refused("create_instance with a bad key creates nothing", "figma_create_instance", {
  componentKey: "0000000000000000000000000000000000000000", parentId: root,
}, /could not import/);
await readBack("sandbox unchanged after the refused import", `return (await figma.getNodeByIdAsync(${J(root)})).children.length;`, (n) => n === before);
if (libKey) {
  const libInst = await step("create_instance { componentKey } (library)", "figma_create_instance", { componentKey: libKey, parentId: root },
    (d) => d?.imported?.key === libKey);
  await readBack("its main component is remote", `
    const i = await figma.getNodeByIdAsync(${J(libInst.data?.id)});
    const m = await i.getMainComponentAsync();
    return { remote: m.remote, key: m.key };
  `, (v) => v?.remote === true && v.key === libKey);
}
if (libSetKey) {
  await step("create_instance { componentSetKey } (library)", "figma_create_instance", { componentSetKey: libSetKey, parentId: root },
    (d) => d?.imported?.kind === "component_set" && !!d.componentSetId);
}

// ── 9. instances of a component (WP-A's search_nodes componentId) ────────────
const search = tools.find((t) => t.name === "figma_search_nodes");
if (search?.inputSchema?.properties?.componentId) {
  await step("search_nodes { componentId } lists the Card's instance", "figma_search_nodes", { componentId: cardId }, (d) =>
    (d?.nodes ?? []).some((n) => n.id === card.data?.id));
} else {
  console.log("  skip: figma_search_nodes has no componentId in this build (WP-A)");
}

// ── look ───────────────────────────────────────────────────────────────────
section("look");
const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
if (png.images[0]) {
  const out = path.join(HERE, "results", "live-wpE-components.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
  console.log(`  saved ${path.relative(process.cwd(), out)}`);
} else {
  record("render the sandbox", false, short(png.text));
}
await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
  (d) => (d?.counts?.error === 0 ? `ok=${d.ok} errors=0 warnings=${d.counts.warning}` : false));

// ── cleanup ────────────────────────────────────────────────────────────────
section("cleanup");
if (KEEP) {
  console.log(`  KEEP=1 — left the sandbox ${root}, styles ${J(outside.styles)} and collections ${J(outside.collections)} in the file`);
} else {
  await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
  if (outside.styles.length) await step("delete probe style", "figma_delete_style", { styleIds: outside.styles });
  for (const id of outside.collections) await step("delete probe variable collection", "figma_delete_variable_collection", { collectionId: id });
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(100));
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + J(failed.map((f) => f.label)) : ""}`);
const notRun = [...NEW_TOOLS, ...EXTENDED].filter((t) => registered.has(t) && !exercised.has(t));
console.log(`  WP-E tools registered but not exercised: ${J(notRun)}`);
console.log("=".repeat(100));
await mcp.close();
process.exit(failed.length ? 1 : 0);
