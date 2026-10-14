// Run work package A — the read side, node addressing, assets and export —
// against the real canvas. Unit tests run against fakes, and fakes encode the
// author's assumptions; this settles the ones only Figma can: whether "12-34"
// and a pasted link resolve, whether a gradient's transform reads as the angle
// the official skill says, whether getImageByHash hands back the uploaded bytes
// [C-093], whether getCSSAsync works in a design-mode plugin and what it costs
// [C-091], whether an unopened page reads after loadAsync [C-090], and whether
// getDevResourcesAsync answers here [C-094].
//
// Everything is built inside one frame named "figma-mcp WP-A probe (delete
// me)" far off-canvas at x=24000, read back through figma_eval (the document,
// not the tool's own report), rendered to spikes/results/live-wpA-read.png,
// and deleted at the end unless KEEP=1.
//
// Run:  node spikes/live-wpA-read.mjs   (needs the plugin running in Figma, and
//       figma_status build.matches true after `npm run build`)

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 24000;
const Y = 24000;
const ASSET_DIR = "wpA-probe-assets";

const results = [];
const measured = {};
const mcp = await connect({ allowEval: true });
const registered = new Set((await mcp.list()).map((t) => t.name));
const exercised = new Set();

function short(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 150 ? s.slice(0, 150) + "…" : (s ?? "");
}

function record(label, ok, why) {
  results.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} ${why}`);
}

/** Call a tool, record pass/fail. `expect` may throw or return false to fail; a string becomes the note. */
async function step(label, tool, args, expect) {
  exercised.add(tool);
  if (!registered.has(tool)) {
    record(label, false, `${tool} is not registered by this server`);
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

/** A call that must be refused with `code` — and must not have reached the document. */
async function refused(label, tool, args, code) {
  exercised.add(tool);
  const r = await mcp.call(tool, args);
  const ok = !r.ok && r.text.includes(code);
  record(label, ok, ok ? `refused: ${short(r.text.split("\n")[0])}` : `expected ${code}, got ${short(r.text)}`);
  return r;
}

/** Read the document through figma_eval — its result is in data.value. */
async function evalJs(code) {
  exercised.add("figma_eval");
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}

const idOf = (r) => r?.data?.id;
const section = (name) => console.log(`\n-- ${name}`);
const J = JSON.stringify;

/** A small, valid RGB PNG built here, so the probe needs no file and no network. */
function makePng(w, h, [r, g, b]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([(r + x * 9) & 255, (g + y * 7) & 255, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${J(sess?.build)}`);
if (!sess) {
  console.error("No Figma session — run the plugin in Figma first.");
  process.exit(2);
}
if (sess.build && sess.build.matches === false) console.log("  warning: the plugin is not running the build on disk; re-run it in Figma first.");
const fileSlug = String(sess.file?.name ?? "File").trim().replace(/\s+/g, "-");

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp WP-A probe (delete me)", x: X, y: Y, layout: "vertical", gap: 32, padding: "40", background: "#ffffff",
});
const root = idOf(box);
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}
const dashed = (id) => id.replace(/:/g, "-");
const frame = async (name, extra = {}) => idOf(await mcp.call("figma_create_frame", { name, parentId: root, ...extra }));
let assetDir = null;

try {
  // ── addressing (G-01) ─────────────────────────────────────────────────────
  section("addressing");
  await step("get_node with '12-34' form", "figma_get_node", { nodeId: dashed(root), depth: 0 }, (d) => d?.node?.id === root);
  await step("get_node with a pasted design link", "figma_get_node", {
    nodeId: `https://www.figma.com/design/WpAprobe0/${encodeURIComponent(fileSlug)}?node-id=${dashed(root)}&t=probe`, depth: 0,
  }, (d) => (d?.node?.id === root ? `resolved ${root}${d.warning ? ` (warning: ${d.warning})` : ""}` : false));
  await refused("a link with no node-id is refused", "figma_get_node", { nodeId: "https://www.figma.com/design/WpAprobe0/Anything" }, "INVALID_PARAM");
  await step("get_nodes_info with links, includeGeometry", "figma_get_nodes_info", { nodeIds: [dashed(root)], includeGeometry: true },
    (d) => (d?.items?.[0]?.ok && typeof d.items[0].node.width === "number" ? `width=${d.items[0].node.width}` : false));
  await step("get_node format rest", "figma_get_node", { nodeId: root, format: "rest" },
    (d) => (d?.format === "rest" && (d.truncated ? typeof d.restText === "string" : d.rest?.document?.id === root) ? `chars=${d.chars} truncated=${d.truncated}` : false));

  // ── gradients (G-05 / G-29 read side) ─────────────────────────────────────
  section("gradients [C-100]");
  const grad = await frame("Gradient", { width: 400, height: 240, layout: "none" });
  await evalJs(`const n = await figma.getNodeByIdAsync(${J(grad)});
    const stops = [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
    n.fills = [
      { type: "GRADIENT_LINEAR", gradientTransform: [[0, 1, 0], [-1, 0, 1]], gradientStops: stops },
      { type: "GRADIENT_RADIAL", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops },
    ];
    return n.fills.length;`);
  await step("official top-to-bottom matrix reads as 180deg", "figma_get_design_context", { nodeId: grad, depth: 1 },
    (d) => (String(d?.root?.fills?.[0]).startsWith("linear-gradient(180deg,") ? d.root.fills[0] : false));
  await step("identity radial reads as centred", "figma_get_design_context", { nodeId: grad, depth: 1 },
    (d) => (String(d?.root?.fills?.[1]).startsWith("radial-gradient(at 50% 50%,") ? d.root.fills[1] : false));

  // ── mixed text (G-07) ─────────────────────────────────────────────────────
  section("mixed text [C-103]");
  const txt = idOf(await mcp.call("figma_create_text", { parentId: root, content: "Get Pro docs", fontSize: 18, name: "Mixed" }));
  await step("set_text_range bold 'Pro'", "figma_set_text_range", { nodeId: txt, match: "Pro", weight: "Bold" });
  await step("set_text_range link 'docs'", "figma_set_text_range", { nodeId: txt, match: "docs", link: "https://example.com/docs" });
  await step("runs carry the bold weight and the link", "figma_get_design_context", { nodeId: txt },
    (d) => {
      const runs = d?.root?.text?.runs ?? [];
      const pro = runs.find((r) => r.characters === "Pro");
      const docs = runs.find((r) => r.link === "https://example.com/docs");
      return pro && (pro.weight ?? 0) >= 600 && docs ? `weight=${d.root.text.weight} runs=${runs.length}` : false;
    });
  await step("maxTextChars cuts and names scan_text_nodes", "figma_get_design_context", { nodeId: txt, maxTextChars: 5 },
    (d) => (d?.root?.text?.characters === "Get P…" && /figma_scan_text_nodes/.test(d.textNote ?? "") ? d.textNote : false));
  await step("the link is real in the document", "figma_eval", {
    code: `const n = await figma.getNodeByIdAsync(${J(txt)}); return n.getStyledTextSegments(["hyperlink", "fontWeight"]).map(s => [s.characters, s.fontWeight, s.hyperlink && s.hyperlink.value]);`,
  }, (d) => (J(d?.value).includes("https://example.com/docs") ? J(d.value) : false));

  // ── structure (G-08) ──────────────────────────────────────────────────────
  section("structure");
  const wrap = await frame("Wrap", { layout: "horizontal", wrap: true, gap: 8, width: 200 });
  for (let i = 0; i < 4; i++) await mcp.call("figma_create_rectangle", { parentId: wrap, width: 80, height: 24, fill: "#e5e7eb", name: `Chip ${i}` });
  await evalJs(`const n = await figma.getNodeByIdAsync(${J(wrap)}); n.counterAxisSpacing = 12; n.counterAxisAlignContent = "SPACE_BETWEEN"; n.maxWidth = 640; return [n.counterAxisSpacing, n.maxWidth];`);
  await step("wrap row gap, alignContent, maxWidth", "figma_get_design_context", { nodeId: wrap, depth: 0 },
    (d) => (d?.root?.rowGap === 12 && d.root.alignContent === "space-between" && d.root.maxWidth === 640 ? "rowGap=12 maxWidth=640" : false));
  const grid = await evalJs(`const root = await figma.getNodeByIdAsync(${J(root)});
    const g = figma.createFrame(); g.name = "Grid"; root.appendChild(g);
    try { g.layoutMode = "GRID"; g.gridRowCount = 2; g.gridColumnCount = 3; g.gridRowGap = 8; g.gridColumnGap = 16; }
    catch (e) { return { id: g.id, error: String(e && e.message || e) }; }
    return { id: g.id };`);
  if (grid?.error) record("GRID tracks are read", true, `skipped: this Figma refused layoutMode GRID (${grid.error})`);
  else {
    await step("GRID tracks are read", "figma_get_design_context", { nodeId: grid.id, depth: 0 },
      (d) => (d?.root?.grid?.rows === 2 && d.root.grid.columns === 3 ? J(d.root.grid) : false));
  }
  const plain = await frame("Constrained", { width: 240, height: 140, layout: "none" });
  const maskShape = idOf(await mcp.call("figma_create_ellipse", { parentId: plain, width: 100, height: 100, x: 10, y: 10, fill: "#000000", name: "Mask" }));
  await mcp.call("figma_create_rectangle", { parentId: plain, width: 120, height: 120, x: 0, y: 0, fill: "#14b8a6", name: "Masked" });
  await step("set_mask on the lowest shape", "figma_set_mask", { nodeId: maskShape, isMask: true, maskType: "vector" });
  const pinned = idOf(await mcp.call("figma_create_rectangle", { parentId: plain, width: 40, height: 40, x: 190, y: 10, fill: "#f59e0b", name: "Pinned" }));
  await step("set_constraints right / top-bottom", "figma_set_constraints", { nodeIds: [pinned], horizontal: "right", vertical: "top-bottom" });
  await evalJs(`const n = await figma.getNodeByIdAsync(${J(plain)}); n.overflowDirection = "VERTICAL"; return n.overflowDirection;`);
  await step("mask, constraints and scrolling appear", "figma_get_design_context", { nodeId: plain, depth: 1 },
    (d) => {
      const kids = d?.root?.children ?? [];
      const mask = kids.find((k) => k.id === maskShape)?.mask;
      const cons = kids.find((k) => k.id === pinned)?.constraints;
      return mask?.type === "vector" && cons?.horizontal === "right" && cons?.vertical === "top-bottom" && d.root.overflow === "vertical"
        ? `mask=${J(mask)} constraints=${J(cons)} overflow=${d.root.overflow}` : false;
    });
  await step("get_node DTO reports overflow", "figma_get_node", { nodeId: plain, depth: 0, includeGeometry: true },
    (d) => (d?.node?.overflow === "vertical" ? "overflow=vertical" : false));

  // ── export cap (G-03) [C-092] ─────────────────────────────────────────────
  section("export cap [C-092]");
  const tall = await frame("Tall", { width: 1440, height: 4000, layout: "none", background: "#eef2ff" });
  await step("no params: longest side held to 1024", "figma_export_node", { nodeId: tall },
    (d) => (d?.pixelHeight === 1024 && d.capped === true ? `${d.pixelWidth}x${d.pixelHeight} bounds=${J(d.bounds)}` : false));
  await step("explicit scale 2 bypasses the cap", "figma_export_node", { nodeId: tall, scale: 2 },
    (d) => (d?.pixelHeight === 8000 && !d.capped ? `${d.pixelWidth}x${d.pixelHeight}${d.path ? " (written to file)" : ""}` : false));
  await step("explicit maxSize 256", "figma_export_node", { nodeId: tall, maxSize: 256 },
    (d) => (d?.pixelHeight === 256 ? `${d.pixelWidth}x${d.pixelHeight}` : false));
  await refused("scale with maxSize is refused", "figma_export_node", { nodeId: tall, scale: 1, maxSize: 512 }, "INVALID_PARAM");
  await mcp.call("figma_delete_nodes", { nodeIds: [tall] }); // keeps the final render small
  await step("select the gradient frame", "figma_select", { nodeIds: [grad] });
  await step("export_node with no nodeId uses the selection", "figma_export_node", {},
    (d) => (d?.nodeId === grad ? `exported ${grad}` : false));
  await step("get_selection reads the page's selection", "figma_get_selection", { includeGeometry: true },
    (d) => (d?.count === 1 && d.nodes[0].id === grad && d.nodes[0].width === 400 ? "count=1" : false));
  await step("select two layers", "figma_select", { nodeIds: [grad, wrap] });
  await step("design context with two selected: roots, scope selection", "figma_get_design_context", { depth: 0 },
    (d) => (d?.scope === "selection" && d.roots?.length === 2 ? "roots=2" : false));
  await step("scan with two selected falls back to the page and says so", "figma_scan_nodes_by_types", { types: ["FRAME"], limit: 1 },
    (d) => (d?.scope?.from === "page" && /2 layers are selected/.test(d.note ?? "") ? d.note : false));
  await mcp.call("figma_select", { nodeIds: [root] });

  // ── assets (G-06) [C-093] ─────────────────────────────────────────────────
  section("assets [C-093]");
  const hero = await frame("Hero", { width: 320, height: 200, layout: "vertical", padding: "24" });
  await mcp.call("figma_create_text", { parentId: hero, content: "Headline over the photo", fontSize: 24, color: "#ffffff", name: "Headline" });
  const png = makePng(16, 12, [200, 80, 40]);
  const hash = await evalJs(`const b = atob(${J(png.toString("base64"))}); const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    const img = figma.createImage(u);
    const n = await figma.getNodeByIdAsync(${J(hero)});
    n.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
    return img.hash;`);
  await step("design context names the image by hash", "figma_get_design_context", { nodeId: hero, depth: 0 },
    (d) => (d?.root?.fills?.[0] === `image FILL ${hash}` ? `${d.root.fills[0]}${d.root.asset ? ` asset=${d.root.asset}` : " (no asset flag)"}` : false));
  await step("download_assets: render + original image", "figma_download_assets", { nodeIds: [hero], dir: ASSET_DIR },
    (d) => {
      if (d?.dir) assetDir = d.dir;
      const raw = d?.rawImages?.find((x) => x.imageHash === hash);
      if (!raw?.path) return false;
      const same = Buffer.compare(fs.readFileSync(raw.path), png) === 0;
      measured.rawBytesIdentical = same;
      return same && d.items?.[0]?.files?.[0]?.path ? `raw ${path.basename(raw.path)} identical to the upload` : false;
    });
  await evalJs(`const n = await figma.getNodeByIdAsync(${J(hero)}); n.exportSettings = [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }, { format: "SVG", suffix: "" }]; return n.exportSettings.length;`);
  const presets = await step("export presets are honoured with their suffix", "figma_download_assets", { nodeIds: [hero], dir: ASSET_DIR, rawImages: false },
    (d) => {
      const files = d?.items?.[0]?.files ?? [];
      return files.some((f) => f.suffix === "@2x" && f.path.endsWith("@2x.png")) && files.some((f) => f.format === "SVG") ? files.map((f) => path.basename(f.path)).join(", ") : false;
    });
  await step("a re-run overwrites the same paths", "figma_download_assets", { nodeIds: [hero], dir: ASSET_DIR, rawImages: false },
    (d) => J((d?.items?.[0]?.files ?? []).map((f) => f.path)) === J((presets.data?.items?.[0]?.files ?? []).map((f) => f.path)));
  await step("useExportSettings false + format SVG", "figma_download_assets", { nodeIds: [hero], dir: ASSET_DIR, useExportSettings: false, format: "SVG", rawImages: false },
    (d) => (d?.items?.[0]?.files?.length === 1 && d.items[0].files[0].format === "SVG" ? "one SVG" : false));

  // ── getCSSAsync probe [C-091] ─────────────────────────────────────────────
  section("getCSSAsync probe [C-091]");
  const cssProbe = await evalJs(`const root = await figma.getNodeByIdAsync(${J(root)});
    const f = figma.createFrame(); f.name = "CSS probe"; root.appendChild(f); f.resize(400, 400); f.layoutMode = "NONE";
    for (let i = 0; i < 499; i++) { const r = figma.createRectangle(); f.appendChild(r); r.resize(8, 8); r.x = (i % 40) * 10; r.y = Math.floor(i / 40) * 10; }
    return f.id;`);
  await step("includeCss on 500 nodes", "figma_get_design_context", { nodeId: cssProbe, includeCss: true, maxNodes: 500, maxChildrenPerNode: 500, depth: 1, includeStyles: false, includeVariables: false },
    (d) => {
      const withCss = [d?.root, ...(d?.root?.children ?? [])].filter((n) => n && n.css).length;
      measured.css = { nodes: d?.nodeCount, withCss, cssMs: d?.cssMs, cssNote: d?.cssNote ?? null };
      return typeof d?.cssMs === "number" ? `nodes=${d.nodeCount} withCss=${withCss} cssMs=${d.cssMs}${d.cssNote ? ` note=${d.cssNote}` : ""}` : false;
    });
  await mcp.call("figma_delete_nodes", { nodeIds: [cssProbe] });

  // ── pages [C-090] ─────────────────────────────────────────────────────────
  section("pages [C-090]");
  const pages = (await mcp.call("figma_get_pages", {})).data?.pages ?? [];
  const other = pages.find((p) => !p.current);
  if (other) {
    await step(`design context of another page (${other.name})`, "figma_get_design_context", { nodeId: other.id, depth: 1, maxNodes: 50 },
      (d) => {
        measured.otherPage = { id: other.id, ok: true, childCount: d?.root?.childCount ?? 0 };
        return d?.scope === "node" ? `childCount=${d.root?.childCount ?? 0}` : false;
      });
  } else {
    record("design context of another page", true, "skipped: single-page file");
  }

  // ── annotations and dev resources [C-094] ─────────────────────────────────
  section("annotations [C-094]");
  const cat = await evalJs(`const cats = figma.annotations ? await figma.annotations.getAnnotationCategoriesAsync() : [];
    const n = await figma.getNodeByIdAsync(${J(grad)});
    n.annotations = [{ label: "WP-A probe note", ...(cats[0] ? { categoryId: cats[0].id } : {}) }];
    return cats[0] ? cats[0].label : null;`);
  await step("annotation category resolves", "figma_get_annotations", { nodeId: grad },
    (d) => {
      const a = d?.nodes?.[0]?.annotations?.[0];
      measured.devResources = d?.devResources ? `ok (${d.devResources.length})` : (d?.devResourcesNote ?? "absent");
      return a?.label === "WP-A probe note" && (cat === null || a.category?.label === cat) && d.scope?.from === "node"
        ? `category=${a.category?.label ?? "none"} devResources=${measured.devResources}` : false;
    });
  await step("design context carries the annotation", "figma_get_design_context", { nodeId: grad, depth: 0 },
    (d) => (d?.root?.annotations?.[0]?.label === "WP-A probe note" ? J(d.root.annotations[0]) : false));

  // ── instances (G-62) ──────────────────────────────────────────────────────
  section("instances");
  const btn = await frame("Probe button", { layout: "horizontal", padding: "8", background: "#4f46e5" });
  await mcp.call("figma_create_text", { parentId: btn, content: "Go", color: "#ffffff", name: "Label" });
  const comp = idOf(await mcp.call("figma_convert_to_component", { nodeId: btn, name: "Probe button" }));
  const inst1 = idOf(await mcp.call("figma_create_instance", { componentId: comp, parentId: root }));
  const inst2 = idOf(await mcp.call("figma_create_instance", { componentId: dashed(comp), parentId: root }));
  await step("search_nodes componentId lists its instances", "figma_search_nodes", { componentId: comp, scope: "subtree", nodeId: root },
    (d) => {
      const ids = (d?.nodes ?? []).map((n) => n.id).sort();
      return J(ids) === J([inst1, inst2].sort()) && d.nodes.every((n) => n.componentId === comp) ? `2 instances of ${comp}` : false;
    });
  await step("componentsUsed lists the component with its key", "figma_get_design_context", { nodeId: inst1, depth: 0 },
    (d) => (d?.componentsUsed?.[0]?.id === comp ? J(d.componentsUsed[0]) : false));

  // ── reactions (G-69) and scans ────────────────────────────────────────────
  section("reactions and scans");
  await step("set a URL reaction", "figma_set_reactions", { nodeId: inst1, reactions: J([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "URL", url: "https://example.com" }] }]) });
  await step("get_reactions subtree: nodes and scrolling frames", "figma_get_reactions", { scope: "subtree", nodeId: root },
    (d) => (d?.nodes?.some((n) => n.nodeId === inst1) && d.frames?.some((f) => f.nodeId === plain && f.overflow === "vertical") ? `nodes=${d.count} frames=${d.frames.length}` : false));
  await step("get_reactions page: flows and prototype start", "figma_get_reactions", { scope: "page", limit: 50 },
    (d) => (Array.isArray(d?.flows) && "prototypeStartNodeId" in d ? `flows=${d.flows.length} start=${d.prototypeStartNodeId} bg=${d.prototypeBackground}` : false));
  await step("scan_text_nodes reports its scope", "figma_scan_text_nodes", { nodeId: root },
    (d) => (d?.scope?.id === root && d.scope.from === "node" ? `texts=${d.count}` : false));
  await step("get_fonts reports missingFonts", "figma_get_fonts", {},
    (d) => (typeof d?.missingFonts === "boolean" ? `fonts=${d.count} missingFonts=${d.missingFonts}` : false));

  // ── look ──────────────────────────────────────────────────────────────────
  section("look");
  const shot = await mcp.call("figma_export_node", { nodeId: root });
  if (shot.images[0]) {
    const out = path.join(HERE, "results", "live-wpA-read.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.images[0].data, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), out)} (${shot.data?.pixelWidth}x${shot.data?.pixelHeight})`);
  }
  await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
    (d) => `ok=${d?.ok} errors=${(d?.findings ?? []).filter((f) => f.severity === "error").length}`);
} catch (err) {
  record("probe aborted", false, String(err?.message ?? err));
} finally {
  // ── cleanup ─────────────────────────────────────────────────────────────
  section("cleanup");
  if (KEEP) {
    console.log(`  KEEP=1 — left the sandbox ${root} in the file`);
  } else {
    await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
    // Only the folder this probe named and the server reported writing to.
    if (assetDir && path.basename(assetDir) === ASSET_DIR && fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + "=".repeat(96));
console.log(`  steps: ${results.length}   failed: ${failed.length}${failed.length ? "  " + J(failed.map((f) => f.label)) : ""}`);
console.log(`  measured (for claims): ${J(measured)}`);
const wpA = ["figma_download_assets", "figma_get_design_context", "figma_export_node", "figma_search_nodes", "figma_get_reactions", "figma_get_annotations", "figma_get_fonts", "figma_get_node", "figma_get_nodes_info", "figma_get_selection", "figma_scan_text_nodes", "figma_scan_nodes_by_types"];
console.log(`  WP-A tools registered but not exercised: ${J(wpA.filter((t) => registered.has(t) && !exercised.has(t)))}`);
console.log("=".repeat(96));
await mcp.close();
process.exit(failed.length ? 1 : 0);
