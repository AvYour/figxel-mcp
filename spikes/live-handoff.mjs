// Does figma_check_layout { audit: ["handoff"] } find, on a real canvas, what
// the unit tests feed it by hand? Two facts are not measured yet: that Figma
// fills `detachedInfo` on a frame the moment an instance is detached [C-343],
// and that a paint style applied by figma_apply_style_to_node reads back as a
// style id the audit counts as bound.
//
// It builds one test frame at an empty spot right of everything on the page:
// a component, an instance of it that is then detached, a swatch with a local
// paint style applied, a second paint style of the same colour (unused), a raw
// swatch and a raw text. Then it runs the audit on that frame, and once more
// on the first top-level frame of the page as a sample of a real design.
//
// Expected on the test frame: one detached_instance naming the component, one
// duplicate_style on the applied style naming its twin, and exactly one bound
// solid paint (the styled swatch). Everything the run creates — the frame and
// the two styles — is deleted at the end unless --keep.
//
// Needs: npm run build; Figma desktop with a Design file open and the Figxel
// plugin running the build on disk. The spawned server refreshes the plugin
// folder when it starts; if the running plugin is an older build, the script
// asks for the plugin to be run again and waits for it.
//
// The record, spikes/results/live-handoff.json, keeps the environment
// (versions), the checks and the numbers. No file name, user or local path.
//
//   node spikes/live-handoff.mjs [--keep] [--page <pageId>]
//
// Exit 0: every check passed. 1: a check failed or a call errored. 2: could not start.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const pageArg = args.includes("--page") ? args[args.indexOf("--page") + 1] : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const mcp = await connect();
const created = { nodes: [], styles: [] };
const record = { spike: "live-handoff", date: new Date().toISOString().slice(0, 10), checks: [], samples: {} };
let failed = false;
const check = (name, ok, detail) => {
  record.checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed = true;
};
const must = async (name, a) => {
  const r = await mcp.call(name, a);
  if (!r.ok) throw new Error(`${name} failed: ${r.text.slice(0, 400)}`);
  return r.data;
};

try {
  // ── a plugin running this build ───────────────────────────────────────────
  let status = await must("figma_status", {});
  let session = status.sessions?.find((s) => s.active) ?? status.sessions?.[0];
  if (!session) {
    log("No Figma file is connected. Run the Figxel plugin in Figma desktop, then run this again.");
    process.exit(2);
  }
  if (session.build && session.build.matches === false) {
    log("The plugin in Figma is an older build. Close the Figxel plugin window and run it again (Plugins > Development > Figxel). Waiting up to 3 minutes…");
    for (let i = 0; i < 60 && session?.build?.matches === false; i++) {
      await sleep(3000);
      status = await must("figma_status", {});
      session = status.sessions?.find((s) => s.active) ?? status.sessions?.[0];
    }
    if (session?.build?.matches === false) {
      log("The plugin still runs an older build; stopping.");
      process.exit(2);
    }
  }
  record.environment = { server: status.bridge?.version, plugin: session.pluginVersion, editor: session.editor, os: process.platform };
  log(`Connected: plugin ${session.pluginVersion}, server ${status.bridge?.version}, ${session.editor}.`);

  // ── where to build ────────────────────────────────────────────────────────
  const pages = await must("figma_get_pages", {});
  const page = pageArg ?? pages.pages.find((p) => p.current)?.id;
  const meta = await must("figma_get_node", { nodeId: page, depth: 1 });
  const tops = (meta.children ?? meta.node?.children ?? []).filter((c) => typeof c.x === "number");
  const right = tops.reduce((m, c) => Math.max(m, c.x + (c.width ?? 0)), 0);
  const sample = tops.find((c) => c.type === "FRAME");

  // ── the test frame ────────────────────────────────────────────────────────
  const spec = {
    type: "frame", name: "Handoff test", layout: "vertical", gap: 16, padding: 24, background: "#FFFFFF", x: right + 200, y: 0,
    children: [
      { type: "component", name: "Handoff test / Chip", layout: "horizontal", padding: [8, 12, 8, 12], cornerRadius: 999, background: "#1F6FEB",
        children: [{ type: "text", name: "Label", content: "Chip", color: "#FFFFFF" }] },
      { type: "rectangle", name: "Styled swatch", width: 80, height: 40, fill: "#D1242F" },
      { type: "rectangle", name: "Raw swatch", width: 80, height: 40, fill: "#8250DF", cornerRadius: 6 },
      { type: "text", name: "Raw text", content: "No text style" },
    ],
  };
  const built = await must("figma_create_from_spec", { pageId: page, spec: JSON.stringify(spec), idempotencyKey: `live-handoff-${Date.now()}` });
  const root = built.rootId;
  created.nodes.push(root);
  const idOf = (name) => built.created.find((c) => c.name === name)?.id;
  const chip = idOf("Handoff test / Chip");
  const swatch = idOf("Styled swatch");

  const inst = await must("figma_create_instance", { componentId: chip, parentId: root });
  const instId = inst.id ?? inst.nodeId;
  const det = await must("figma_detach_instance", { nodeIds: [instId] });
  const detachedId = det.items?.[0]?.frameId;
  check("the instance detached into a frame", typeof detachedId === "string", detachedId);

  const red = await must("figma_create_paint_style", { name: "Handoff test/Red", color: "#D1242F" });
  const twin = await must("figma_create_paint_style", { name: "Handoff test/Red copy", color: "#D1242F" });
  for (const s of [red, twin]) created.styles.push(s.id ?? s.styleId);
  await must("figma_apply_style_to_node", { nodeIds: [swatch], styleId: red.id ?? red.styleId, type: "fill" });

  // ── the audit ─────────────────────────────────────────────────────────────
  const r = await must("figma_check_layout", { nodeId: root, audit: ["handoff"] });
  record.samples.testFrame = { handoff: r.handoff, kinds: r.issues.map((i) => i.kind), designSystem: r.audit?.designSystem };
  log("handoff:", JSON.stringify(r.handoff, null, 2));

  const detached = r.issues.filter((i) => i.kind === "detached_instance");
  check("one detached_instance, on the detached frame", detached.length === 1 && detached[0].nodeId === detachedId, detached.map((i) => i.nodeId));
  check("it names the component", /the local component "Handoff test \/ Chip"/.test(detached[0]?.detail ?? ""), detached[0]?.detail);
  const dupes = r.issues.filter((i) => i.kind === "duplicate_style");
  const redDupe = dupes.find((i) => i.name === "Handoff test/Red");
  check("duplicate_style on the applied style, naming its twin", !!redDupe && /"Handoff test\/Red copy"/.test(redDupe.detail), redDupe?.detail);
  check("the unused twin is not reported", !dupes.some((i) => i.name === "Handoff test/Red copy"));
  check("exactly one bound solid paint (the styled swatch)", r.handoff?.paints?.bound === 1, r.handoff?.paints);
  check("no text is bound", r.handoff?.texts?.bound === 0, r.handoff?.texts);
  check("the detached frame is counted once", r.handoff?.detached === 1);

  // ── a real design, as a sample ────────────────────────────────────────────
  if (sample) {
    const s = await must("figma_check_layout", { nodeId: sample.id, audit: ["handoff"] });
    record.samples.firstFrame = { handoff: s.handoff, kinds: [...new Set(s.issues.map((i) => i.kind))], designSystem: s.audit?.designSystem };
    log(`sample (first top-level frame): ${s.handoff?.verdict}`);
  }
} catch (err) {
  failed = true;
  record.error = String(err?.message ?? err).replaceAll(process.env.USERPROFILE ?? "~~", "~").replaceAll(process.env.HOME ?? "~~", "~");
  console.error(record.error);
} finally {
  if (!keep) {
    if (created.styles.length) await mcp.call("figma_delete_style", { styleIds: created.styles });
    if (created.nodes.length) await mcp.call("figma_delete_nodes", { nodeIds: created.nodes });
    record.cleanedUp = true;
  } else {
    record.kept = { nodes: created.nodes.length, styles: created.styles.length };
  }
  if (record.checks.length || record.error) {
    mkdirSync(path.join(REPO, "spikes", "results"), { recursive: true });
    writeFileSync(path.join(REPO, "spikes", "results", "live-handoff.json"), JSON.stringify({ ...record, passed: !failed }, null, 2) + "\n");
  }
  await mcp.close();
}
process.exit(failed ? 1 : 0);
