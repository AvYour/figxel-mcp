// Live probe for the figma_move_nodes defects of 2026-10-09 and the
// temporary ids seen while agents built the motion ad.
//
// The record shows these periods. While one lasts, Figma lists the layers of an
// animated top-level frame under SECOND ids, minted in the client's current
// session. The parent's children, getTopLevelFrame / timelines and the REST
// export all name the second id. The id a create call returned still resolves,
// and reads through it agree. When the period ends, the second ids stop
// resolving, for reads too [C-199]. During those periods three moves that set
// x and y through the created ("held") id lost x and kept y. An x-only move
// worked, and so did x and y through the listed id [C-203]. What starts and
// ends a period is unknown [C-200].
//
// This probe isolates the questions the record cannot answer:
//   1. What does Figma do with two writes through a held id? Raw Plugin API
//      through figma_eval, read back three ways: the same object, a fresh
//      lookup in the same call, and a later call. figma-mcp's own code is not
//      involved. If the fresh lookup in the same call reads stale values, the
//      readback in figma_move_nodes must read the listed node instead.
//   2. Does the shipped tool land, or answer ok: false? Never a silent ok:
//      figma_move_nodes (held and listed), as a figma_batch step, and
//      figma_reparent_nodes with x and y [C-250].
//   3. When does a period start and end, and do its ids survive it?
//
// It builds one sandbox frame, "figma-mcp move-twin probe (delete me)", at
// x 46000, y 26000. Then it waits for a period (up to WAIT_S seconds,
// default 600), trying the nudges in order: re-key the timeline, create a
// layer, export a GIF, and finally ask you to press Play on the probe frame's
// timeline in Figma. It runs the experiment matrix once before the period as
// a baseline and once during it. Finally it deletes the frame unless KEEP=1.
// The results go to spikes/results/live-move-twins.json.
//
// Run:  npm run build, re-run the plugin in Figma (do not minimise the Figma
//       window), then
//       node spikes/live-move-twins.mjs            (WAIT_S=900 KEEP=1 optional)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const WAIT_S = Number(process.env.WAIT_S ?? 600);
const X = 46000;
const Y = 26000;
const NAME = "figma-mcp move-twin probe (delete me)";
const AT = { x: -1158, y: -241 };
const HOME = { x: -1176, y: -262 };

const out = { startedAt: new Date().toISOString(), detector: [], baseline: null, during: null, lifetime: null, silentOk: [], notes: [] };
const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v);

async function call(tool, args, opts) {
  const r = await mcp.call(tool, args, opts);
  if (!r.ok) throw new Error(`${tool} failed: ${r.text.slice(0, 300)}`);
  return r.data;
}
/** Raw Plugin API in the sandbox: what Figma does, without figma-mcp's ops in between. */
async function evalJs(code) {
  const d = await call("figma_eval", { code });
  return d && "value" in d ? d.value : d;
}
/** A video export, collected again with the same arguments while it answers `rendering`. */
async function render(args, timeoutMs = 300_000) {
  const t0 = Date.now();
  let r = await mcp.call("figma_export_video", args, { timeoutMs });
  while (r.ok && r.data?.status === "rendering" && Date.now() - t0 < timeoutMs) {
    await sleep(5000);
    r = await mcp.call("figma_export_video", args, { timeoutMs });
  }
  if (!r.ok) throw new Error(`figma_export_video failed: ${r.text.slice(0, 300)}`);
  return r.data;
}

// ── sandbox ─────────────────────────────────────────────────────────────────

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
if (!sess) {
  console.error("No Figma session: run the plugin in Figma first.");
  process.exit(2);
}
if (sess.build?.restart) {
  console.error(`The connected build is stale (restart: ${sess.build.restart}): ${st.data?.hint ?? ""}`);
  process.exit(2);
}
if (!(await mcp.list()).some((t) => t.name === "figma_eval")) {
  console.error("figma_eval is not registered: this probe needs BRIDGE_ALLOW_EVAL=1 and the eval toolset.");
  process.exit(2);
}
console.log(`file "${sess.file?.name}", build ${j(sess.build)}`);
out.build = sess.build;

const frame = await call("figma_create_frame", { name: NAME, x: X, y: Y, width: 400, height: 400, layout: "none", background: "#ffffff", clipsContent: true });
const FID = frame.id;
let HELD = { frame: FID };

try {
  const box = await call("figma_create_frame", { name: "Probe/Container", parentId: FID, x: 0, y: 0, width: 400, height: 400, layout: "none" });
  const circle = await call("figma_create_ellipse", { name: "Probe/Circle", parentId: box.id, x: HOME.x, y: HOME.y, width: 3000, height: 3000, fill: "#a4532f" });
  const mask = await call("figma_create_frame", { name: "Probe/Mask", parentId: box.id, x: 260, y: 452, width: 250, height: 144, layout: "none", clipsContent: true });
  const anim = await call("figma_create_rectangle", { name: "Probe/Anim", parentId: box.id, x: 20, y: 20, width: 40, height: 40, fill: "#1f1c18" });
  // The frame is animated once a layer inside it has keys: the top-level frame itself cannot [C-115].
  await call("figma_set_keyframes", {
    nodeId: anim.id,
    timelineDuration: 2,
    tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }, { t: 1, value: "0.2", easing: "EASE_OUT" }] }],
  });
  HELD = { frame: FID, box: box.id, circle: circle.id, mask: mask.id, anim: anim.id };
  out.held = HELD;
  console.log(`sandbox ${j(HELD)}`);

  // ── detector ──────────────────────────────────────────────────────────────

  /** One reading of how Figma names the sandbox right now. A period is on when any listed id differs from a held one. */
  async function detect(label) {
    const v = await evalJs(`
      const held = ${j(HELD)};
      const c = await figma.getNodeByIdAsync(held.circle);
      if (!c) return { gone: true };
      let restId = null, timeline = null, top = null;
      try { restId = (await c.exportAsync({ format: "JSON_REST_V1" })).document.id; } catch (e) { restId = "error: " + e.message; }
      try { timeline = (c.timelines && c.timelines[0] && c.timelines[0].id) || null; } catch (e) { timeline = "error: " + e.message; }
      try { const t = c.getTopLevelFrame(); top = t ? t.id : null; } catch (e) { top = "error: " + e.message; }
      const chain = []; for (let p = c.parent; p && p.type !== "PAGE"; p = p.parent) chain.push(p.id);
      const listed = c.parent ? c.parent.children.map((k) => ({ id: k.id, name: k.name })) : [];
      const frames = figma.currentPage.children.filter((n) => n.name === ${j(NAME)}).map((n) => n.id);
      return {
        session: figma.currentUser ? figma.currentUser.sessionId : null,
        restId, timeline, top, parentChain: chain, listed, pageFrames: frames,
        heldIsListed: listed.some((k) => k.id === held.circle),
      };`);
    const on = !!v && !v.gone && (v.restId !== HELD.circle || !v.heldIsListed || v.top !== FID || v.pageFrames.length > 1);
    const row = { at: new Date().toISOString(), label, on, ...v };
    out.detector.push(row);
    console.log(`  detect ${label.padEnd(26)} period=${on} session=${v?.session} rest=${v?.restId} top=${v?.top} listed=${j(v?.listed?.map((k) => k.id))}`);
    return row;
  }

  /** The id the parent lists for a layer, by name (the record's twins kept their names). */
  const listedIdOf = (row, name) => row.listed?.find((k) => k.name === name)?.id ?? null;

  // ── the experiment matrix ─────────────────────────────────────────────────

  /** Put the circle back with two single-coordinate calls (the record: those worked), then confirm through the held id. */
  async function reset(id) {
    await call("figma_move_nodes", { nodeIds: [id], x: HOME.x });
    await call("figma_move_nodes", { nodeIds: [id], y: HOME.y });
    const r = await call("figma_get_nodes_info", { nodeIds: [HELD.circle] });
    const n = r.items[0]?.node;
    return n && n.x === HOME.x && n.y === HOME.y;
  }

  /** Where the circle is, through the held id and the listed id, in a separate call. */
  async function where(listed) {
    const ids = [HELD.circle, ...(listed && listed !== HELD.circle ? [listed] : [])];
    const r = await call("figma_get_nodes_info", { nodeIds: ids });
    return r.items.map((i) => ({ id: i.id, ok: i.ok, x: i.node?.x, y: i.node?.y, opacity: i.node?.opacity }));
  }

  /** Raw writes in the sandbox; returns the reads made inside the same call. */
  const RAW = {
    "held: x then y (setters)": (L) => `
      const n = await figma.getNodeByIdAsync(${j(HELD.circle)});
      n.x = ${AT.x}; const afterX = { x: n.x, y: n.y };
      n.y = ${AT.y}; const afterY = { x: n.x, y: n.y };
      const fresh = await figma.getNodeByIdAsync(${j(HELD.circle)});
      const listed = ${j(L)} ? await figma.getNodeByIdAsync(${j(L)}) : null;
      return { afterX, afterY, freshHeld: { x: fresh.x, y: fresh.y }, listed: listed && { x: listed.x, y: listed.y } };`,
    "held: one relativeTransform": (L) => `
      const n = await figma.getNodeByIdAsync(${j(HELD.circle)});
      const m = n.relativeTransform;
      n.relativeTransform = [[m[0][0], m[0][1], ${AT.x}], [m[1][0], m[1][1], ${AT.y}]];
      const fresh = await figma.getNodeByIdAsync(${j(HELD.circle)});
      const listed = ${j(L)} ? await figma.getNodeByIdAsync(${j(L)}) : null;
      return { matrixRead: m, same: { x: n.x, y: n.y }, freshHeld: { x: fresh.x, y: fresh.y }, listed: listed && { x: listed.x, y: listed.y } };`,
    "held: x, fresh lookup, then y": () => `
      const a = await figma.getNodeByIdAsync(${j(HELD.circle)}); a.x = ${AT.x};
      const b = await figma.getNodeByIdAsync(${j(HELD.circle)}); b.y = ${AT.y};
      const c = await figma.getNodeByIdAsync(${j(HELD.circle)});
      return { fresh: { x: c.x, y: c.y } };`,
    "listed: x then y (setters)": (L) => `
      const n = await figma.getNodeByIdAsync(${j(L ?? HELD.circle)});
      n.x = ${AT.x}; n.y = ${AT.y};
      const held = await figma.getNodeByIdAsync(${j(HELD.circle)});
      return { listed: { x: n.x, y: n.y }, held: { x: held.x, y: held.y } };`,
    // Two different fields through one held object: is it the matrix only, or every earlier write?
    "held: rename then x": () => `
      const n = await figma.getNodeByIdAsync(${j(HELD.circle)});
      const before = n.name; n.name = before + " *"; n.x = ${AT.x};
      const c = await figma.getNodeByIdAsync(${j(HELD.circle)});
      const r = { name: c.name, x: c.x, y: c.y }; c.name = before; return r;`,
    // The keyframe defect's shape (several tracks, one call): do both survive through a held id?
    "held: two keyframe tracks": () => `
      const n = await figma.getNodeByIdAsync(${j(HELD.anim)});
      n.applyManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_X" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 0 } }, { timelinePosition: 1, value: { type: "FLOAT", value: 30 } }] });
      n.applyManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_Y" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 0 } }, { timelinePosition: 1, value: { type: "FLOAT", value: 30 } }] });
      const c = await figma.getNodeByIdAsync(${j(HELD.anim)});
      const t = c.manualKeyframeTracks;
      const r = { fields: Object.keys(t) };
      c.removeManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_X" });
      c.removeManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_Y" });
      return r;`,
  };

  /** The tool path, as an agent calls it: standalone, as a batch step, and as a reparent with x/y. */
  const TOOL = {
    "tool: move_nodes x+y (held)": () => mcp.call("figma_move_nodes", { nodeIds: [HELD.circle], ...AT }),
    "tool: move_nodes x+y (listed)": (L) => mcp.call("figma_move_nodes", { nodeIds: [L ?? HELD.circle], ...AT }),
    "tool: batch move_nodes x+y (held)": () =>
      mcp.call("figma_batch", { steps: j([{ op: "move_nodes", params: { nodeIds: [HELD.circle], ...AT } }]) }),
    "tool: reparent_nodes x+y (held)": () => mcp.call("figma_reparent_nodes", { nodeIds: [HELD.circle], parentId: HELD.box, ...AT }),
  };

  /**
   * What a tool answer claims for the circle: "ok" (its item says ok), "refused" (ok: false or
   * listed in itemsFailed), or "error" (the call failed). A claim of ok whose position did not
   * land is the silent ok this whole fix exists to end [C-250].
   */
  function claimOf(r) {
    if (!r.ok) return "error";
    const items = r.data?.items ?? r.data?.steps?.flatMap((s) => s.result?.items ?? []) ?? [];
    const failed = (r.data?.itemsFailed ?? []).length > 0 || items.some((i) => i.ok === false);
    return failed ? "refused" : "ok";
  }

  async function matrix(label) {
    const row = await detect(`${label}: before`);
    const L = listedIdOf(row, "Probe/Circle");
    const results = {};
    for (const [name, code] of Object.entries(RAW)) {
      const resetOk = name.includes("keyframe") || name.includes("rename") ? true : await reset(L ?? HELD.circle);
      let inside;
      try {
        inside = await evalJs(code(L));
      } catch (e) {
        inside = { error: String(e.message ?? e) };
      }
      results[name] = { resetOk, inside, later: await where(L) };
      console.log(`  ${label} ${name.padEnd(34)} ${j(results[name]).slice(0, 220)}`);
    }
    for (const [name, fn] of Object.entries(TOOL)) {
      const resetOk = await reset(L ?? HELD.circle);
      const r = await fn(L);
      const later = await where(L);
      const atHeld = later.find((p) => p.id === HELD.circle);
      const landed = atHeld?.x === AT.x && atHeld?.y === AT.y;
      const claim = claimOf(r);
      const verdict = landed ? "landed" : claim === "refused" ? "ok:false" : claim === "error" ? "error" : "SILENT OK";
      if (verdict === "SILENT OK") out.silentOk.push({ phase: label, row: name });
      results[name] = { resetOk, verdict, answer: r.ok ? r.data : r.text.slice(0, 300), later };
      console.log(`  ${label} ${name.padEnd(34)} ${verdict.padEnd(9)} ${j(later)}`);
    }
    await reset(L ?? HELD.circle);
    return { listedCircle: L, detector: row, results };
  }

  // ── run ───────────────────────────────────────────────────────────────────

  console.log("\n-- baseline (no period expected yet)");
  const first = await detect("start");
  out.baseline = await matrix("baseline");

  console.log(`\n-- waiting up to ${WAIT_S}s for a period`);
  const nudges = [
    ["re-key the timeline", () => call("figma_set_keyframes", { nodeId: HELD.anim, timelineDuration: 2.5, tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }, { t: 1.5, value: "0.3" }] }] })],
    ["create a layer", async () => {
      // During a period every creation gets its twin at once (the next id is used), so two creations show a gap.
      const a = await call("figma_create_rectangle", { name: "Probe/Gap A", parentId: HELD.box, x: 300, y: 300, width: 10, height: 10 });
      const b = await call("figma_create_rectangle", { name: "Probe/Gap B", parentId: HELD.box, x: 320, y: 300, width: 10, height: 10 });
      const [sa, na] = a.id.split(":").map(Number);
      const [sb, nb] = b.id.split(":").map(Number);
      out.notes.push({ gapProbe: { a: a.id, b: b.id, gap: sa === sb ? nb - na : null } });
    }],
    ["export a GIF", () => render({ nodeId: FID, format: "GIF", fps: 8, saveTo: "move-twin-probe.gif" })],
  ];
  const t0 = Date.now();
  let on = first.on;
  for (const [label, fn] of nudges) {
    if (on) break;
    try {
      await fn();
    } catch (e) {
      out.notes.push({ nudge: label, error: String(e.message ?? e) });
    }
    on = (await detect(`after: ${label}`)).on;
  }
  if (!on) console.log("  In Figma: press Play on the probe frame's timeline (Motion panel), then stop it. The probe keeps checking every 5 s.");
  while (!on && Date.now() - t0 < WAIT_S * 1000) {
    await sleep(5000);
    on = (await detect(`poll +${Math.round((Date.now() - t0) / 1000)}s`)).on;
  }

  if (on) {
    console.log("\n-- during a period");
    out.during = await matrix("during");
    // Lifetime: keep the listed ids, wait for the period to end, then read and write both kinds.
    const listed = out.during.detector.listed.map((k) => k.id);
    console.log(`\n-- waiting up to ${WAIT_S}s for the period to end (listed ${j(listed)})`);
    const t1 = Date.now();
    let still = true;
    while (still && Date.now() - t1 < WAIT_S * 1000) {
      await sleep(5000);
      still = (await detect(`end? +${Math.round((Date.now() - t1) / 1000)}s`)).on;
    }
    const read = await call("figma_get_nodes_info", { nodeIds: [...new Set([...listed, HELD.circle, HELD.mask])] });
    const write = await mcp.call("figma_set_opacity", { nodeIds: [...new Set([...listed, HELD.circle])], opacity: 1 });
    out.lifetime = { ended: !still, read: read.items.map((i) => ({ id: i.id, ok: i.ok, error: i.error })), write: write.data ?? write.text };
    console.log(`  ended=${!still} read=${j(out.lifetime.read)} write=${j(out.lifetime.write).slice(0, 300)}`);
  } else {
    out.notes.push(`No period within ${WAIT_S}s: only the baseline ran. Re-run with a longer WAIT_S, or while Figma shows the timeline.`);
    console.log("\n  No period observed; only the baseline ran.");
  }
} finally {
  // ── clean up: only the frame this probe created ──────────────────────────
  if (!KEEP) {
    const del = await mcp.call("figma_delete_nodes", { nodeIds: [FID] });
    out.cleanup = del.ok ? "deleted" : del.text.slice(0, 300);
  }
  out.pass = out.silentOk.length === 0;
  out.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
  fs.writeFileSync(path.join(HERE, "results", "live-move-twins.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${out.pass ? "PASS: no tool row answered a silent ok" : `FAIL: silent ok in ${j(out.silentOk)}`}`);
  console.log(`wrote spikes/results/live-move-twins.json${KEEP ? " (sandbox kept)" : ""}`);
  await mcp.close();
}
