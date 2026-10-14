// Live check of work package F — motion, video, scrolling, flows, and the new
// guides and prompts — against the real canvas. The unit tests run against
// fakes built from the typings and the official motion skill; only Figma
// settles the facts they assume:
//
//   [C-115] Motion is gated per user: on UNSUPPORTED this run records that the
//           account has no Motion flag and skips the keyframe and video steps.
//   [C-116] MP4 / GIF / WEBM export of an animated top-level frame works on the
//           installed desktop, and the frames at 0 s and 0.4 s differ.
//   [C-118] numberOfFixedChildren counts the LAST children (the top of the
//           layers panel) — read back here; with KEEP=1, look at the panel.
//
// Everything is built inside one frame named "figma-mcp WP-F probe (delete
// me)" at x 44000, y 24000, rendered to spikes/results/live-wpF-motion.png,
// and deleted at the end unless KEEP=1. The page's prototype flows and
// background are read first and restored whatever happens.
//
// Run:  npm run build, re-run the plugin in Figma, then
//       node spikes/live-wpF-motion.mjs        (KEEP=1 to leave the sandbox)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const X = 44000;
const Y = 24000;
const VIDEO_TIMEOUT = 600_000;

const results = [];
const mcp = await connect({ allowEval: true });
const registered = new Set((await mcp.list()).map((t) => t.name));
const exercised = new Set();
const NEW_TOOLS = [
  "figma_get_motion_context", "figma_set_keyframes", "figma_remove_keyframes", "figma_export_video",
  "figma_set_scroll_behavior", "figma_set_prototype_flows",
];

function short(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 150 ? s.slice(0, 150) + "…" : (s ?? "");
}

function record(label, ok, why, skipped = false) {
  results.push({ label, ok, why, skipped });
  console.log(`  ${skipped ? "skip" : ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} ${why}`);
}

/** Call a tool and record pass/fail. `expect` may throw or return false to fail, or a string to explain a pass. */
async function step(label, tool, args, expect, { timeoutMs } = {}) {
  exercised.add(tool);
  if (!registered.has(tool)) {
    record(label, false, `${tool} is not registered — is the integrated build running?`);
    return { ok: false, data: null, images: [], text: "" };
  }
  const r = await mcp.call(tool, args, timeoutMs ? { timeoutMs } : undefined);
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

/** A call that must be refused; passes when it is, with the refusal's text matching `pattern`. */
async function refused(label, tool, args, pattern) {
  exercised.add(tool);
  const r = await mcp.call(tool, args);
  const ok = !r.ok && pattern.test(r.text);
  record(label, ok, ok ? short(r.text.split("\n")[0]) : `expected a refusal matching ${pattern}, got: ${short(r.text)}`);
  return r;
}

/** Read the document through figma_eval — the document, not the tool's own report. */
async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data; // a null result is a result
}

async function check(label, code, verdict) {
  try {
    const v = await evalJs(code);
    const out = verdict(v);
    record(label, out !== false, typeof out === "string" ? out : short(v));
    return v;
  } catch (err) {
    record(label, false, String(err?.message ?? err));
    return undefined;
  }
}

const id = (v) => JSON.stringify(v);
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
const missing = NEW_TOOLS.filter((t) => !registered.has(t));
if (missing.length) console.log(`  note: not registered yet: ${missing.join(", ")}`);
if (!registered.has("figma_eval")) {
  console.error("figma_eval is not registered (BRIDGE_ALLOW_EVAL); the read-backs need it.");
  process.exit(2);
}

// ── sandbox ────────────────────────────────────────────────────────────────
section("sandbox");
const box = await step("create sandbox frame", "figma_create_frame", {
  name: "figma-mcp WP-F probe (delete me)", x: X, y: Y, width: 480, height: 720, layout: "none", background: "#ffffff",
});
const root = box.data?.id;
if (!root) {
  console.error("Could not create the sandbox frame; stopping.");
  await mcp.close();
  process.exit(1);
}
const card = (await mcp.call("figma_create_rectangle", { parentId: root, name: "Card", x: 40, y: 40, width: 200, height: 120, fill: "#4f46e5" })).data?.id;
const pageId = await evalJs("return figma.currentPage.id;");

// The flows are the user's: read them now, restore them at the end, whatever happens.
const originalFlows = await evalJs(
  "return { flows: figma.currentPage.flowStartingPoints.map((f) => ({ nodeId: f.nodeId, name: f.name })), backgrounds: JSON.parse(JSON.stringify(figma.currentPage.prototypeBackgrounds)) };",
);

try {
  // ── motion: keyframes ────────────────────────────────────────────────────
  section("motion: set_keyframes");
  let motion = true;
  exercised.add("figma_set_keyframes");
  const probe = await mcp.call("figma_set_keyframes", {
    nodeId: card,
    tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.4, value: "1", easing: "EASE_OUT" }] }],
  });
  if (!probe.ok && /UNSUPPORTED/.test(probe.text)) {
    motion = false;
    record("motion probe [C-115]", true, "UNSUPPORTED — this account has no Motion flag; keyframe and video steps skipped", true);
  } else {
    record("set_keyframes OPACITY 0 → 1 (EASE_OUT)", probe.ok, short(probe.ok ? probe.data : probe.text));
  }

  let timelineId;
  if (motion) {
    timelineId = (
      await check(
        "OPACITY track is in the document",
        `const n = await figma.getNodeByIdAsync(${id(card)}); const t = n.manualKeyframeTracks.OPACITY; return { kf: t && t.keyframes.map((k) => ({ t: k.timelinePosition, v: k.value.value, e: k.easing && k.easing.type })), tl: n.timelines[0] };`,
        (v) => (v?.kf?.length === 2 && Math.abs(v.kf[1].t - 0.4) < 1e-6 && v.kf[1].v === 1 && v.kf[1].e === "EASE_OUT" ? `keyframes ${JSON.stringify(v.kf)}, timeline ${JSON.stringify(v.tl)}` : false),
      )
    )?.tl?.id;

    await step("set_keyframes colour, vector, cubic and spring", "figma_set_keyframes", {
      nodeId: card,
      tracks: [
        { field: "fill:0", keyframes: [{ t: 0, value: "#4f46e5" }, { t: 0.6, value: "#f59e0b", easing: "cubic:0.4,0,0.2,1" }] },
        { field: "TRANSLATION_XY", keyframes: [{ t: 0, value: "0,24" }, { t: 0.6, value: "0,0", easing: "spring:0.2" }] },
      ],
    }, (d) => (d?.tracks?.length === 2 ? `tracks ${d.tracks.map((t) => t.field).join(", ")}, timeline ${JSON.stringify(d.timeline)}, extended ${d.extended}` : false));
    await check(
      "fill and XY tracks are in the document",
      `const n = await figma.getNodeByIdAsync(${id(card)}); const m = n.manualKeyframeTracks; return { fill: m.fills && m.fills[0] && m.fills[0].keyframes.length, xy: m.TRANSLATION_XY && m.TRANSLATION_XY.keyframes[0].value, easing: m.fills && m.fills[0].keyframes[1].easing };`,
      (v) => (v?.fill === 2 && v?.xy?.type === "VECTOR" && v?.easing?.type === "CUSTOM_CUBIC_BEZIER" ? JSON.stringify(v) : false),
    );
    await step("set_keyframes tracks: [] + timelineDuration 1.2", "figma_set_keyframes", { nodeId: card, tracks: [], timelineDuration: 1.2 },
      (d) => (Math.abs((d?.timeline?.duration ?? 0) - 1.2) < 1e-6 ? `timeline ${JSON.stringify(d.timeline)}` : false));
    await check("timeline is 1.2 s in the document", `const n = await figma.getNodeByIdAsync(${id(card)}); return n.timelines[0];`,
      (v) => (Math.abs((v?.duration ?? 0) - 1.2) < 1e-6 ? JSON.stringify(v) : false));
    await refused("EASE_IN_OUT is refused with the right name", "figma_set_keyframes",
      { nodeId: card, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1", easing: "EASE_IN_OUT" }] }] }, /EASE_IN_AND_OUT/);
    await refused("the top-level frame itself is refused", "figma_set_keyframes",
      { nodeId: root, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }] }] }, /top-level frame/);

    // ── motion: read ──────────────────────────────────────────────────────
    section("motion: get_motion_context");
    await step("get_motion_context round-trips the tracks", "figma_get_motion_context", { nodeId: root, recursive: true }, (d) => {
      const n = d?.nodes?.find((x) => x.nodeId === card);
      const op = n?.tracks?.find((t) => t.field === "OPACITY");
      const same = op && op.keyframes.length === 2 && op.keyframes[0].t === 0 && op.keyframes[0].value === "0" && op.keyframes[1].t === 0.4 && op.keyframes[1].value === "1" && op.keyframes[1].easing === "EASE_OUT";
      const cohort = d?.timelineCohorts?.find((c) => c.memberNodeIds.includes(card));
      if (!same || !cohort || (timelineId && cohort.timelineId !== timelineId)) return false;
      return `tracks ${n.tracks.map((t) => t.field).join(", ")}; styleTracks ${n.styleTracks ? n.styleTracks.length : 0}; cohort ${cohort.timelineId} ${cohort.durationMs} ms`;
    });
    const page1 = await step("get_motion_context maxNodes 1 pages", "figma_get_motion_context", { nodeId: root, recursive: true, maxNodes: 1 },
      (d) => (d?.truncated === true && typeof d.nextCursor === "string" ? `count ${d.count}, truncated` : false));
    await step("get_motion_context continues from the cursor", "figma_get_motion_context", { nodeId: root, recursive: true, maxNodes: 1, cursor: page1.data?.nextCursor },
      (d) => (d?.nodes?.some((n) => n.nodeId === card) ? "the card comes back on page 2" : false));

    // ── video ─────────────────────────────────────────────────────────────
    section("export_video [C-116]");
    await refused("an fps the format does not offer is refused before rendering", "figma_export_video", { nodeId: root, format: "MP4", fps: 15 }, /not offered for MP4/);
    const gif = await step("GIF: fps 12, loopCount 0, width 240, saveTo, frames [0, 0.4]", "figma_export_video", {
      nodeId: card, format: "GIF", fps: 12, loopCount: 0, width: 240, saveTo: "wpF-probe.gif", frames: [0, 0.4],
    }, (d, r) => {
      if (!d?.path || !fs.existsSync(d.path)) return false;
      const head = fs.readFileSync(d.path).subarray(0, 4).toString("latin1");
      if (head !== "GIF8" || d.exportedNodeId !== root) return false;
      if (d.note) return `file ${d.bytes} B, ${d.note}`;
      if (r.images.length !== 2) return false;
      if (r.images[0].data === r.images[1].data) throw new Error("the frames at 0 s and 0.4 s are identical — is the animation in the export?");
      return `file ${d.bytes} B (GIF8), 2 frames that differ, exported ${d.exportedNodeId}`;
    }, { timeoutMs: VIDEO_TIMEOUT });
    if (gif.images?.[1]) fs.writeFileSync(path.join(HERE, "results", "live-wpF-frame-0.4s.png"), Buffer.from(gif.images[1].data, "base64"));
    await step("MP4: fps 24, quality LOW, scale 0.5", "figma_export_video", { nodeId: root, format: "MP4", fps: 24, quality: "LOW", scale: 0.5 },
      (d) => (d?.path && fs.readFileSync(d.path).subarray(4, 8).toString("latin1") === "ftyp" ? `file ${d.bytes} B (ftyp), ${d.durationS} s` : false),
      { timeoutMs: VIDEO_TIMEOUT });
    await step("WEBM: height 160, quality MEDIUM", "figma_export_video", { nodeId: root, format: "WEBM", height: 160, quality: "MEDIUM" },
      (d) => (d?.path && fs.readFileSync(d.path).subarray(0, 4).toString("hex") === "1a45dfa3" ? `file ${d.bytes} B (EBML)` : false),
      { timeoutMs: VIDEO_TIMEOUT });

    // ── motion: remove ────────────────────────────────────────────────────
    section("motion: remove_keyframes");
    await step("remove OPACITY; SCALE_X reported as not animated", "figma_remove_keyframes", { nodeId: card, fields: ["OPACITY", "SCALE_X"] },
      (d) => (d?.removed?.join() === "OPACITY" && d?.notAnimated?.join() === "SCALE_X" ? `remaining ${d.remaining.join(", ")}` : false));
    await check("OPACITY is gone from the document", `const n = await figma.getNodeByIdAsync(${id(card)}); return Object.keys(n.manualKeyframeTracks);`,
      (v) => (Array.isArray(v) && !v.includes("OPACITY") ? `left: ${v.join(", ")}` : false));
    await step("remove every remaining track", "figma_remove_keyframes", { nodeId: card }, (d) => (d?.remaining?.length === 0 ? `removed ${d.removed.join(", ")}` : false));
  } else {
    for (const t of ["figma_get_motion_context", "figma_export_video", "figma_remove_keyframes"]) {
      exercised.add(t);
      record(`${t} (needs Motion)`, true, "skipped: no Motion flag on this account [C-115]", true);
    }
    await refused("get_motion_context answers UNSUPPORTED too", "figma_get_motion_context", { nodeId: root }, /UNSUPPORTED/);
  }

  // ── scrolling and fixed layers ─────────────────────────────────────────
  section("set_scroll_behavior [C-117] [C-118]");
  const scroller = (await mcp.call("figma_create_frame", {
    name: "Scroller", parentId: root, x: 260, y: 40, width: 180, height: 300, layout: "vertical", gap: 8, padding: "8", background: "#f3f4f6",
  })).data?.id;
  const nav = (await mcp.call("figma_create_frame", { name: "Nav", parentId: scroller, width: 164, height: 40, background: "#111827" })).data?.id;
  for (let i = 0; i < 6; i++) await mcp.call("figma_create_rectangle", { parentId: scroller, name: `Row ${i + 1}`, width: 164, height: 80, fill: "#d1d5db" });
  await refused("a nav still in the auto-layout flow is refused, with the fix", "figma_set_scroll_behavior",
    { nodeId: scroller, overflow: "vertical", fixedNodeIds: [nav] }, /figma_move_nodes/);
  await step("move the nav out of the flow (positioning absolute)", "figma_move_nodes", { nodeIds: [nav], positioning: "absolute", x: 0, y: 0 });
  await step("overflow vertical + fixed nav", "figma_set_scroll_behavior", { nodeId: scroller, overflow: "vertical", fixedNodeIds: [nav] },
    (d) => (d?.fixedChildren === 1 && d?.order?.at(-1) === nav ? `order ends with the nav, fixedChildren ${d.fixedChildren}` : false));
  await check("[C-118] the document: VERTICAL, 1 fixed, nav is the last child",
    `const f = await figma.getNodeByIdAsync(${id(scroller)}); return { overflow: f.overflowDirection, fixed: f.numberOfFixedChildren, last: f.children[f.children.length - 1].id, first: f.children[0].id };`,
    (v) => (v?.overflow === "VERTICAL" && v?.fixed === 1 && v?.last === nav ? `${JSON.stringify(v)} — with KEEP=1 the layers panel must show Nav under "Fixed"` : false));
  if (registered.has("figma_get_reactions")) {
    const map = await mcp.call("figma_get_reactions", { scope: "page" });
    const frame = map.data?.frames?.find?.((f) => f.nodeId === scroller);
    // A cross-check through WP-A's page map; its absence is not this package's failure.
    record("get_reactions { scope: page } sees the scroller", true, frame ? short(frame) : `no frames entry (WP-A extension absent?): ${short(map.text)}`, !frame);
  }
  await step("fixedNodeIds [] fixes nothing again", "figma_set_scroll_behavior", { nodeId: scroller, fixedNodeIds: [] }, (d) => d?.fixedChildren === 0);

  // ── flows ──────────────────────────────────────────────────────────────
  section("set_prototype_flows [C-117]");
  await refused("a nested frame cannot start a flow", "figma_set_prototype_flows", { flows: [{ nodeId: scroller, name: "Nested" }] }, /not a top-level frame/);
  await step("one flow on the sandbox + background", "figma_set_prototype_flows", {
    pageId, flows: [{ nodeId: root, name: "WP-F probe flow" }], background: "#111111",
  }, (d) => (d?.flows?.[0]?.nodeId === root && d?.background === "#111111" ? short(d) : false));
  await check("the page's flows and prototype background",
    "const p = figma.currentPage; return { flows: p.flowStartingPoints, bg: p.prototypeBackgrounds[0] };",
    (v) => (v?.flows?.length === 1 && v.flows[0].name === "WP-F probe flow" && v?.bg?.type === "SOLID" ? short(v) : false));

  // ── guides and prompts ─────────────────────────────────────────────────
  section("guides and prompts");
  for (const topic of ["library", "prototype", "motion", "rules", "code-to-design", "design-to-code"]) {
    await step(`figma_get_guide ${topic}`, "figma_get_guide", { topic }, (_d, r) => (r.text.length > 300 ? `${r.text.length} chars` : false));
  }
  for (const [name, args] of [["code_to_design", { source: "src/components/Hero.tsx" }], ["create_design_system_rules", { clientLanguages: "typescript", clientFrameworks: "react" }], ["design_to_code", { nodeId: root }]]) {
    try {
      const p = await mcp.client.getPrompt({ name, arguments: args });
      const text = p.messages?.[0]?.content?.text ?? "";
      record(`prompt ${name}`, text.length > 300, `${text.length} chars`);
    } catch (err) {
      record(`prompt ${name}`, false, String(err?.message ?? err));
    }
  }

  // ── look ───────────────────────────────────────────────────────────────
  section("look");
  const png = await mcp.call("figma_export_node", { nodeId: root, scale: 1 });
  if (png.images[0]) {
    const out = path.join(HERE, "results", "live-wpF-motion.png");
    fs.writeFileSync(out, Buffer.from(png.images[0].data, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), out)}`);
  }
  await step("check_layout on the sandbox", "figma_check_layout", { nodeId: root, minSeverity: "error" },
    (d) => `ok=${d?.ok} errors=${(d?.issues ?? d?.findings ?? []).filter((f) => f.severity === "error").length}`);
} finally {
  // ── restore the user's flows, then clean up ────────────────────────────
  section("restore and cleanup");
  try {
    await evalJs(
      `const p = figma.currentPage; p.flowStartingPoints = ${JSON.stringify(originalFlows?.flows ?? [])}; p.prototypeBackgrounds = ${JSON.stringify(originalFlows?.backgrounds ?? [])}; return p.flowStartingPoints.length;`,
    );
    record("original flows and background restored", true, `${(originalFlows?.flows ?? []).length} flow(s)`);
  } catch (err) {
    record("original flows and background restored", false, String(err?.message ?? err));
  }
  if (KEEP) {
    console.log(`  KEEP=1 — left the sandbox ${root} in the file`);
  } else {
    await step("delete sandbox", "figma_delete_nodes", { nodeIds: [root] });
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
console.log("\n" + "=".repeat(100));
console.log(`  steps: ${results.length}   failed: ${failed.length}   skipped: ${skipped.length}${failed.length ? "  " + JSON.stringify(failed.map((f) => f.label)) : ""}`);
console.log(`  WP-F tools registered but not exercised: ${JSON.stringify(NEW_TOOLS.filter((t) => registered.has(t) && !exercised.has(t)))}`);
console.log("=".repeat(100));
await mcp.close();
process.exit(failed.length ? 1 : 0);
