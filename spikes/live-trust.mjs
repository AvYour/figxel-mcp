// Does trust (ADR #43) hold on a real canvas? Four things are not measured yet:
// whether every change an agent's write causes reaches the plugin inside its
// settle window and is attributed to the agent, not to a person [C-394]; whether
// several undos take back exactly as many tool calls [C-395]; whether a person's
// edit makes the next write answer STALE and a rollback answer ROLLBACK_BLOCKED;
// and whether figma_stress_test finds what breaks on a real card grid.
//
// A person drives two steps: the script prints what to change in Figma by hand
// and waits (up to --wait seconds) until the plugin reports that edit.
//
//   1. Setup: a test frame at an empty spot right of everything on the current
//      page — a title, a row of three instances of a small card component with
//      a price and a label, fixed widths so long content has somewhere to break.
//   2. Agent only: a text change inside the auto-layout row, then (3 s later) a
//      fill on the row and on the frame without reading them again. A STALE
//      there, or any "person" change in figma_get_changes, means the plugin
//      took the agent's own reflow for a person's [C-394].
//   3. Undo count: figma_savepoint, three new rectangles, figma_rollback; all
//      three must be gone and nothing else undone [C-395].
//   4. STALE: the person edits the title by hand; the agent's next figma_set_text
//      on it must answer STALE; after a read it must go through.
//   5. ROLLBACK_BLOCKED: figma_savepoint, one rectangle, the person edits the
//      title again; figma_rollback must refuse and offer that rectangle as safe;
//      the script deletes it.
//   6. figma_stress_test on the card row, every case, copies not kept.
//   7. Cleanup: everything the script created is deleted unless --keep.
//
// Runs with BRIDGE_PROCESS=off (the role gate is the roles spike's subject) and
// BRIDGE_CONFLICTS=refuse. Needs: npm run build; Figma desktop with a Design
// file open and the Figxel plugin running the build on disk (the script waits
// for a re-run when the plugin is older).
//
// The record, spikes/results/live-trust.json, keeps versions, each step's
// numbers and outcome. No file name, user or local path.
//
//   node spikes/live-trust.mjs [--keep] [--wait 180]
//
// Exit 0: every check passed. 1: a check failed or a call errored. 2: could not start.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const waitS = args.includes("--wait") ? Number(args[args.indexOf("--wait") + 1]) : 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A change's time, whether the plugin reports epoch ms or an ISO string. */
const timeOf = (at) => (typeof at === "number" ? at : Date.parse(at));
const log = (...a) => console.log(...a);

const mcp = await connect({ env: { BRIDGE_PROCESS: "off", BRIDGE_CONFLICTS: "refuse" } });
const record = { spike: "live-trust", date: new Date().toISOString().slice(0, 10), steps: {}, checks: [] };
const created = [];
let failed = false;
const check = (name, ok, detail) => {
  record.checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed = true;
};

/** A tool call with its error code and structured content (mcp-client's `data` is null on an error). */
async function call(name, a = {}) {
  const res = await mcp.client.callTool({ name, arguments: a }, undefined, { timeout: 120_000 });
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  let data = res.structuredContent ?? null;
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: !res.isError, code: res.isError ? (data?.code ?? text.split(":")[0]) : undefined, data, text };
}
async function must(name, a) {
  const r = await call(name, a);
  if (!r.ok) throw new Error(`${name} failed: ${r.text.slice(0, 400)}`);
  return r.data;
}

/** Wait until the plugin reports a person's change to `nodeId` after `since` (figma_get_changes). */
async function waitForPersonEdit(nodeId, since, what) {
  log(`\n>>> In Figma, by hand: ${what}. Waiting up to ${waitS} s…`);
  const until = Date.now() + waitS * 1000;
  while (Date.now() < until) {
    const r = await call("figma_get_changes", { limit: 50 });
    const seen = (r.data?.plugin?.changes ?? r.data?.changes ?? []).find((c) => c.nodeId === nodeId && c.by === "person" && timeOf(c.at) >= since);
    if (seen) {
      log(`    seen: ${seen.name ?? nodeId} at ${seen.at}`);
      return seen;
    }
    await sleep(2000);
  }
  return null;
}

try {
  // ── a plugin running this build ───────────────────────────────────────────
  let status = await must("figma_status", {});
  let session = status.sessions?.find((s) => s.active) ?? status.sessions?.[0];
  for (let i = 0, said = ""; i < 100 && session?.build?.matches !== true; i++) {
    const now = !session ? "none" : "old";
    if (now !== said) {
      log(now === "none"
        ? "Waiting for the Figxel plugin to connect (up to 5 minutes): run it in Figma desktop (Plugins > Development > Figxel)."
        : "The plugin in Figma is an older build. Close the Figxel plugin window and run it again (Plugins > Development > Figxel). Waiting…");
      said = now;
    }
    await sleep(3000);
    status = await must("figma_status", {});
    session = status.sessions?.find((s) => s.active) ?? status.sessions?.[0];
  }
  if (session?.build?.matches !== true) {
    log(session ? "The plugin still runs an older build; stopping." : "No Figma file connected; stopping.");
    process.exit(2);
  }
  record.environment = { server: status.bridge?.version, plugin: session.pluginVersion, editor: session.editor, os: process.platform, conflicts: status.bridge?.conflicts };
  log(`Connected: plugin ${session.pluginVersion}, server ${status.bridge?.version}, ${session.editor}.`);

  // ── 1. setup ──────────────────────────────────────────────────────────────
  const page = (await must("figma_get_pages", {})).pages.find((p) => p.current).id;
  const top = await must("figma_get_node", { nodeId: page, depth: 1 });
  const right = (top.children ?? top.node?.children ?? []).reduce((m, c) => Math.max(m, (c.x ?? 0) + (c.width ?? 0)), 0);
  const spec = {
    type: "frame", name: "Trust spike", layout: "vertical", gap: 24, padding: 32, background: "#FFFFFF", x: right + 200, y: 0,
    children: [
      { type: "text", name: "Title", content: "Plans for small teams", fontSize: 32, weight: "Bold", color: "#111111" },
      { type: "component", name: "Trust spike / Card", layout: "vertical", gap: 8, padding: 16, width: 200, cornerRadius: 12, background: "#F2F2F2",
        children: [
          { type: "text", name: "Label", content: "Starter", fontSize: 16, weight: "Semi Bold", color: "#111111", sizing: { width: "fill" } },
          { type: "text", name: "Price", content: "$9 / month", fontSize: 24, weight: "Bold", color: "#111111" },
        ] },
    ],
  };
  const built = await must("figma_create_from_spec", { pageId: page, spec: JSON.stringify(spec) });
  const frame = built.rootId;
  created.push(frame);
  const idOf = (name) => built.created.find((c) => c.name === name)?.id;
  const title = idOf("Title");
  const card = idOf("Trust spike / Card");
  const row = (await must("figma_create_frame", { parentId: frame, name: "Card row", layout: "horizontal", gap: 16 })).id;
  for (let i = 0; i < 3; i++) await must("figma_create_instance", { componentId: card, parentId: row });
  log(`Setup: frame ${frame}, row ${row}.`);

  // ── 2. the agent's own reflow is the agent's [C-394] ──────────────────────
  const t2 = Date.now();
  const rowNode = await must("figma_get_node", { nodeId: row, depth: 2 });
  const firstInstance = (rowNode.children ?? rowNode.node?.children ?? [])[0];
  const instLabel = (firstInstance?.children ?? [])[0]?.id;
  if (instLabel) await must("figma_set_text", { nodeId: instLabel, content: "Starter plan for growing teams" });
  await sleep(3000);
  const fillRow = await call("figma_set_fills", { nodeIds: [row], fills: [{ color: "#FAFAFA" }] });
  const fillFrame = await call("figma_set_fills", { nodeIds: [frame], fills: [{ color: "#FFFFFF" }] });
  const own = await call("figma_get_changes", { limit: 100 });
  const personChanges = (own.data?.plugin?.changes ?? own.data?.changes ?? []).filter((c) => c.by === "person" && timeOf(c.at) >= t2);
  record.steps.reflow = { setTextOn: instLabel ?? null, fillRow: fillRow.ok ? "ok" : fillRow.code, fillFrame: fillFrame.ok ? "ok" : fillFrame.code, personChanges: personChanges.length };
  check("no false STALE after the agent's own reflow", fillRow.ok && fillFrame.ok, record.steps.reflow);
  check("no change of the agent's own read as a person's", personChanges.length === 0, personChanges.slice(0, 5));

  // ── 3. one rollback takes back exactly the calls since the savepoint [C-395] ──
  const sp1 = await must("figma_savepoint", { label: "three rectangles" });
  const rects = [];
  for (let i = 0; i < 3; i++) rects.push((await must("figma_create_rectangle", { parentId: frame, name: `Rect ${i + 1}`, width: 40, height: 40 })).id);
  const rb1 = await call("figma_rollback", { savepointId: sp1.savepointId ?? sp1.id, confirm: true });
  const after1 = await must("figma_get_nodes_info", { nodeIds: [...rects, title, row] });
  const gone = rects.filter((id) => !after1.items.find((x) => x.id === id && x.ok));
  const kept = [title, row].filter((id) => after1.items.find((x) => x.id === id && x.ok));
  record.steps.rollback = { ok: rb1.ok, code: rb1.code, undone: rb1.data?.undone, verified: rb1.data?.verified, gone: gone.length, keptSetup: kept.length };
  check("rollback took back the three calls, and only them", rb1.ok && gone.length === 3 && kept.length === 2, record.steps.rollback);

  // ── 4. a person's edit makes the next write STALE ─────────────────────────
  await must("figma_get_node", { nodeId: title });
  const t4 = Date.now();
  const edit4 = await waitForPersonEdit(title, t4, 'change the text of "Plans for small teams" in the frame "Trust spike" (any word)');
  if (!edit4) check("the person's edit was seen", false, "timed out");
  else {
    const stale = await call("figma_set_text", { nodeId: title, content: "Plans for every team" });
    record.steps.stale = { code: stale.code ?? "ok", conflicts: stale.data?.partial?.conflicts?.length ?? 0 };
    check("a write over a person's edit answers STALE", stale.code === "STALE", record.steps.stale);
    await must("figma_get_node", { nodeId: title });
    const again = await call("figma_set_text", { nodeId: title, content: "Plans for every team" });
    check("after a read the same write goes through", again.ok, again.ok ? undefined : again.code);
  }

  // ── 5. a rollback over a person's edit is refused ─────────────────────────
  const sp2 = await must("figma_savepoint", { label: "one rectangle" });
  const lone = (await must("figma_create_rectangle", { parentId: frame, name: "Rect after savepoint", width: 40, height: 40 })).id;
  const edit5 = await waitForPersonEdit(title, Date.now(), 'change the title text of "Trust spike" once more');
  if (!edit5) check("the second edit was seen", false, "timed out");
  else {
    const rb2 = await call("figma_rollback", { savepointId: sp2.savepointId ?? sp2.id, confirm: true });
    const safe = rb2.data?.partial?.safe ?? [];
    record.steps.blocked = { code: rb2.code ?? "ok", changed: rb2.data?.partial?.changed?.length ?? 0, safe };
    check("rollback over a person's edit answers ROLLBACK_BLOCKED", rb2.code === "ROLLBACK_BLOCKED", record.steps.blocked);
    check("it offers the agent's own rectangle as safe to delete", safe.includes(lone), safe);
  }
  await call("figma_delete_nodes", { nodeIds: [lone] });

  // ── 6. the stress test on the card row ────────────────────────────────────
  const stress = await call("figma_stress_test", { nodeId: frame });
  record.steps.stress = stress.ok
    ? { baseline: stress.data?.baseline, cases: (stress.data?.cases ?? []).map((c) => ({ case: c.case, ok: c.ok, broke: (c.broke ?? []).length, kinds: [...new Set((c.broke ?? []).map((b) => b.kind))] })), skipped: stress.data?.skipped?.length ?? 0 }
    : { code: stress.code, text: stress.text.slice(0, 300) };
  check("the stress test ran every case", stress.ok && (stress.data?.cases ?? []).length === 5, record.steps.stress);
  check("expand or long found something on fixed-width cards", stress.ok && (stress.data?.cases ?? []).some((c) => ["expand", "long"].includes(c.case) && (c.broke ?? []).length > 0));
  const leftovers = await must("figma_get_node", { nodeId: page, depth: 1 });
  check("no stress copies were left behind", !(leftovers.children ?? leftovers.node?.children ?? []).some((c) => /· stress:/.test(c.name ?? "")));
} catch (err) {
  failed = true;
  record.error = String(err?.message ?? err).replaceAll(process.env.USERPROFILE ?? "~~", "~").replaceAll(process.env.HOME ?? "~~", "~");
  console.error(record.error);
} finally {
  if (!keep && created.length) await call("figma_delete_nodes", { nodeIds: created, force: true });
  record.cleanedUp = !keep;
  if (record.checks.length || record.error) {
    mkdirSync(path.join(REPO, "spikes", "results"), { recursive: true });
    writeFileSync(path.join(REPO, "spikes", "results", "live-trust.json"), JSON.stringify({ ...record, passed: !failed }, null, 2) + "\n");
  }
  await mcp.close();
}
process.exit(failed ? 1 : 0);
