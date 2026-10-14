// Live check of figma_check_motion (plan §5.3, row 5) on a real canvas:
//
//   * one probe layer per rule, keyed to break exactly that rule: every rule
//     must fire on its probe, through the integrated hub and plugin;
//   * a clean control frame must come back ok: true;
//   * the probe frame is rendered and its flagged frames are pulled as stills
//     with figma_review_video, which is where the strobe px thresholds and the
//     open blur_off_speed case (an accelerating collapse whose blur peaks one
//     frame early, the r1 wheel) are judged by eye and by metric [C-246] [C-243].
//
// Three frames named "figma-mcp check_motion … (delete me)" at x 56000–57400,
// y 24000, deleted at the end unless KEEP=1. Results: spikes/results/live-check-motion.json.
// The probes are data in spikes/check-motion-probes.mjs, which
// test/check-motion-probes.test.ts audits offline first.
//
// Run:  npm run build, re-run the plugin in Figma, then
//       node spikes/live-check-motion.mjs        (KEEP=1 to leave the frames)
// Keep the Figma window restored while it renders [C-198].

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT, BRAND, CTA, FPS, FRAME, FRAME_RULES, hitFor, opacity, PARENT_FRAME, PARENT_TRACKS, PARENTS, PROBES, ruleProbes, SOFT, t, tr } from "./check-motion-probes.mjs";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-check-motion.json");
const KEEP = process.env.KEEP === "1";
const X = 56000;
const Y = 24000;
const VIDEO_TIMEOUT = 600_000;

const results = { ranAt: new Date().toISOString(), frames: {}, rules: {}, control: null, stillness: null, render: null, review: null, steps: [] };
const record = (label, ok, why) => {
  results.steps.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} ${why}`);
};
const short = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}…` : (s ?? "");
};

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = await mcp.list();
const registered = new Set(tools.map((x) => x.name));
const exportSchema = tools.find((x) => x.name === "figma_export_video")?.inputSchema?.properties ?? {};
const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${JSON.stringify(sess?.build)}`);
for (const need of ["figma_check_motion", "figma_eval", "figma_set_keyframes"]) {
  if (!registered.has(need)) {
    console.error(`${need} is not registered: run the integrated build (and BRIDGE_ALLOW_EVAL for figma_eval).`);
    await mcp.close();
    process.exit(2);
  }
}

async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

async function keys(nodeId, tracks, timelineDuration) {
  const r = await mcp.call("figma_set_keyframes", { nodeId, tracks, ...(timelineDuration ? { timelineDuration } : {}) });
  if (!r.ok && /UNSUPPORTED/.test(r.text)) throw new Error("Motion is not available on this account [C-115].");
  return r;
}

const frames = [];
try {
  // ── build the three frames ───────────────────────────────────────────────
  const ids = await evalJs(`
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    const black = [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 } }];
    const frame = (name, x) => {
      const f = figma.createFrame(); f.name = name; f.x = x; f.y = ${Y}; f.resize(${FRAME.width}, ${FRAME.height});
      f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; f.clipsContent = true; return f;
    };
    const place = (node, parent, x, y) => { parent.appendChild(node); node.x = x; node.y = y; return node; };
    const ids = {};
    const a = frame("figma-mcp check_motion probes (delete me)", ${X});
    ids.probes = a.id;
    const parents = {};
    // createFrame() clips by default [C-067]; a clipping frame around one layer reads as its mask (PARENT_FRAME).
    ${JSON.stringify(PARENTS)}.forEach((name, i) => {
      const p = figma.createFrame(); p.name = name; p.fills = []; p.resize(${PARENT_FRAME.w}, ${PARENT_FRAME.h});
      p.clipsContent = ${PARENT_FRAME.clipsContent};
      parents[name] = place(p, a, 400, 20 + i * 130); ids[name] = p.id;
    });
    const probes = ${JSON.stringify(PROBES.map(({ tracks: _t, ...p }) => p))};
    probes.forEach((p, i) => {
      const host = p.parent ? parents[p.parent] : a;
      const x = p.parent ? 10 : 20 + (i % 3) * 125;
      const y = p.parent ? 10 + (host.children.length * 35) : 20 + Math.floor(i / 3) * 95;
      let n;
      if (p.kind === "text") { n = figma.createText(); n.characters = p.characters; n.fontSize = 28; n.fills = black; }
      else if (p.kind === "line") {
        n = figma.createVector(); n.vectorPaths = [{ windingRule: "NONE", data: "M 0 0 L " + p.w + " 0" }];
        n.strokes = black; n.strokeWeight = 8; n.strokeCap = p.cap;
      } else { n = p.kind === "ellipse" ? figma.createEllipse() : figma.createRectangle(); n.resize(p.w, p.h); n.fills = black; }
      n.name = p.name;
      place(n, host, x, y);
      if (p.radius) n.cornerRadius = p.radius;
      if (p.blur) n.effects = [{ type: "LAYER_BLUR", radius: 0, visible: true, blurType: "NORMAL" }];
      ids[p.name] = n.id;
    });
    const b = frame("figma-mcp check_motion stillness (delete me)", ${X + 700});
    ids.stillness = b.id;
    const mover = figma.createRectangle(); mover.name = "mover"; mover.resize(80, 80); mover.fills = black;
    ids.mover = place(mover, b, 40, 400).id;
    const c = frame("figma-mcp check_motion control (delete me)", ${X + 1400});
    ids.control = c.id;
    const card = figma.createRectangle(); card.name = "card"; card.resize(200, 120); card.fills = black;
    ids.card = place(card, c, 60, 300).id;
    const hello = figma.createText(); hello.characters = "Hello world"; hello.fontSize = 40; hello.fills = black; hello.name = "hello";
    ids.hello = place(hello, c, 60, 200).id;
    return ids;
  `);
  frames.push(ids.probes, ids.stillness, ids.control);
  results.frames = { probes: ids.probes, stillness: ids.stillness, control: ids.control };
  record("frames built", true, `${PROBES.length} probes, 3 frames`);

  // ── keys ─────────────────────────────────────────────────────────────────
  let first = true;
  for (const p of PROBES) {
    // The timeline is 4 s; the probe keyed past it passes the duration again, so it is kept.
    const r = await keys(ids[p.name], p.tracks, first || p.pastEnd ? FRAME.durationS : undefined);
    first = false;
    if (!r.ok) record(`keys: ${p.name}`, false, short(r.text));
  }
  // rest_state_hidden: a layer resting at opacity 0, as keying can leave it [C-204].
  await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(ids.rest_state_hidden)}); n.opacity = 0; return n.opacity;`);
  // The arrival scene leaves one frame after its child lands.
  for (const [name, tracks] of Object.entries(PARENT_TRACKS)) await keys(ids[name], tracks);
  // Stillness: a blank first frame, a move, a second of nothing, a move back.
  await keys(ids.mover, [opacity([10, 0, 1]), tr("TRANSLATION_X", [0, 0], [t(10), 0, "LINEAR"], [t(20), 200, SOFT], [t(50), 200, "LINEAR"], [2, 0, SOFT])], 2);
  // Control: a soft entry, a readable line, a drift that keeps the frame alive.
  await keys(ids.card, [tr("OPACITY", [0, 0], [t(10), 1, SOFT]), tr("TRANSLATION_Y", [0, 40], [0.5, 0, SOFT]), tr("TRANSLATION_X", [0, 0], [2, 150, "LINEAR"])], 2);
  record("keys written", true, `${PROBES.length + 3} layers`);

  // ── the audit, through the hub ───────────────────────────────────────────
  const probe = await mcp.call("figma_check_motion", { nodeId: ids.probes, ...AUDIT, brandId: ids[BRAND], ctaId: ids[CTA] });
  if (!probe.ok) throw new Error(`figma_check_motion failed: ${short(probe.text)}`);
  const issues = probe.data.issues ?? [];
  results.audit = { counts: probe.data.counts, checked: probe.data.checked, expectedFrames: probe.data.expectedFrames, limits: probe.data.limits, census: probe.data.census };
  for (const { probe: p, rule } of ruleProbes()) {
    const hit = hitFor(issues, rule, p.name, ids.probes);
    results.rules[rule] = { fired: !!hit, issue: hit ?? null };
    record(`fires: ${rule}`, !!hit, hit ? `${hit.severity} f${hit.frame}: ${short(hit.detail)}` : "no finding on its probe");
  }
  results.calibration = Object.fromEntries(PROBES.filter((x) => x.calibration).map((p) => [p.name, issues.filter((i) => i.name === p.name)]));

  const still = await mcp.call("figma_check_motion", { nodeId: ids.stillness });
  results.stillness = still.data;
  for (const rule of FRAME_RULES) {
    const hit = (still.data?.issues ?? []).find((i) => i.rule === rule);
    results.rules[rule] = { fired: !!hit, issue: hit ?? null };
    record(`fires: ${rule}`, !!hit, hit ? `${hit.severity} f${hit.frame}: ${short(hit.detail)}` : "no finding on the stillness frame");
  }
  const control = await mcp.call("figma_check_motion", { nodeId: ids.control });
  results.control = control.data;
  record("control frame is ok", control.ok && control.data?.ok === true, short(control.data?.counts ?? control.text));
  const wrongFrame = await mcp.call("figma_check_motion", { nodeId: ids.probes, brandId: ids.mover });
  record("a brandId outside the frame is refused", !wrongFrame.ok && /INVALID_PARAM/.test(wrongFrame.text), short(wrongFrame.text));

  // ── render and review ────────────────────────────────────────────────────
  const jobs = "jobId" in exportSchema && "wait" in exportSchema;
  const jobId = `wp4-check-${Date.now()}`;
  const args = { nodeId: ids.probes, format: "MP4", fps: FPS, width: 540, saveTo: "wp4-check-motion.mp4" };
  let video = await mcp.call("figma_export_video", jobs ? { ...args, jobId, wait: 40 } : args, { timeoutMs: VIDEO_TIMEOUT });
  for (let i = 0; jobs && video.ok && video.data?.status === "rendering" && i < 30; i++) video = await mcp.call("figma_export_video", { jobId, wait: 40 }, { timeoutMs: VIDEO_TIMEOUT });
  results.render = video.ok ? video.data : { error: video.text };
  record("render the probes", video.ok && !!video.data?.path, short(video.ok ? video.data?.path : video.text));
  if (video.ok && video.data?.path) {
    if (registered.has("figma_review_video")) {
      const flagged = [...new Set(issues.filter((i) => i.severity !== "info").map((i) => i.frame))].sort((x, y) => x - y).slice(0, 24);
      const review = await mcp.call("figma_review_video", {
        path: video.data.path,
        stills: flagged,
        closeups: [{ startFrame: 88, frames: 12 }, { startFrame: 100, frames: 8 }],
        expectFrames: probe.data.expectedFrames,
        maxImages: 0,
      });
      results.review = review.ok ? review.data : { error: review.text };
      record("figma_review_video on the render", review.ok, short(review.ok ? review.data?.metrics?.summary : review.text));
      if (review.ok) {
        const frameCount = review.data?.video?.frames;
        record("[C-194] the render holds expectedFrames", frameCount === probe.data.expectedFrames, `${frameCount} frames, audit expects ${probe.data.expectedFrames}`);
      }
    } else {
      results.review = { skipped: "figma_review_video is not registered; open the render and look at the flagged frames", flagged: issues.map((i) => i.frame) };
      record("figma_review_video", true, "not registered: stills skipped, the render path is in the results");
    }
  }
} catch (err) {
  record("probe", false, String(err?.message ?? err));
} finally {
  if (frames.length && !KEEP) {
    const d = await mcp.call("figma_delete_nodes", { nodeIds: frames });
    record("delete the probe frames", d.ok, d.ok ? frames.join(", ") : short(d.text));
  } else if (frames.length) {
    console.log(`  KEEP=1: left ${frames.join(", ")} in the file`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n  results: ${path.relative(process.cwd(), OUT)}`);
  await mcp.close();
}
process.exit(results.steps.some((s) => !s.ok) ? 1 : 0);
