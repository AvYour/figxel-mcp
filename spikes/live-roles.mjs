// Does the role process (ADR #42) hold on a real canvas? Unit tests cover the
// logic against fakes; what only Figma can answer is whether the records live
// where the design puts them and survive what a real session does to them:
//
//   - shared plugin data on a page and on figma.root (the brief index) is kept
//     across a plugin restart [C-382]; whether clone() copies it [C-381];
//   - the content fingerprint is stable across a restart and changes with an
//     edit, so a final export trusts a sign-off only while nothing changed;
//   - the gate refuses new work before a brief, and lets it through after;
//   - the brief block is drawn, and a11y measures a real button.
//
// It works on its own page, "Figxel spike — roles", created at the start and
// deleted at the end unless --keep, so no brief or sign-off record is left in
// the file (the index leaves out rows whose node is gone). A person drives one
// step: closing the Figxel plugin window and running it again.
//
//   1. Gate: figma_create_frame on the spike page with no brief → PROCESS_REQUIRED, nothing sent.
//   2. Skills: figma_get_guide ux, then design § brief.
//   3. Brief A (section gear, stored on the page): figma_set_brief → "page".
//      Brief B (page gear, a block): figma_set_brief with every page line → "block", the block exists.
//   4. With brief A in force: a screen frame with a 48 × 48 button; figma_check_layout with a11y.
//   5. figma_sign_off on the screen with the section lenses; unanswered infos answered, then again.
//   6. Fingerprint: figma_get_brief { nodeId, fingerprint } fresh; an edit makes it stale; a final
//      export is refused, a new sign-off clears it, the export runs.
//   7. Restart: the person re-runs the plugin; brief A, the index and the sign-off are read back,
//      and the fingerprint is still fresh.
//   8. Clone: figma_clone_node on the screen; what figma_get_brief says about the copy.
//
// Runs with BRIDGE_PROCESS=strict. Needs: npm run build; Figma desktop with a
// Design file on a paid plan (it adds a page) and the Figxel plugin running
// the build on disk.
//
//   node spikes/live-roles.mjs [--keep] [--wait 180]
//
// The record, spikes/results/live-roles.json, keeps versions and each step's
// outcome. No file name, user or local path.
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
const log = (...a) => console.log(...a);

const mcp = await connect({ env: { BRIDGE_PROCESS: "strict" } });
const record = { spike: "live-roles", date: new Date().toISOString().slice(0, 10), steps: {}, checks: [] };
let failed = false;
let spikePage = null;
const check = (name, ok, detail) => {
  record.checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed = true;
};
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
  if (!r.ok) throw new Error(`${name} failed: ${r.text.slice(0, 500)}`);
  return r.data;
}
const activeSession = (st) => st.sessions?.find((s) => s.active) ?? st.sessions?.[0];

try {
  // ── a plugin running this build ───────────────────────────────────────────
  let status = await must("figma_status", {});
  let session = activeSession(status);
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
    session = activeSession(status);
  }
  if (session?.build?.matches !== true) {
    log(session ? "The plugin still runs an older build; stopping." : "No Figma file connected; stopping.");
    process.exit(2);
  }
  record.environment = { server: status.bridge?.version, plugin: session.pluginVersion, editor: session.editor, os: process.platform, process: status.process?.mode };

  spikePage = (await must("figma_create_page", { name: "Figxel spike — roles" })).id;

  // ── 1. the gate refuses new work before a brief ───────────────────────────
  const refused = await call("figma_create_frame", { parentId: spikePage, name: "Too early", width: 390, height: 844 });
  check("new work before a brief answers PROCESS_REQUIRED", refused.code === "PROCESS_REQUIRED", refused.code ?? "ok");
  if (refused.ok && refused.data?.id) await call("figma_delete_nodes", { nodeIds: [refused.data.id] });

  // ── 2. the skills ─────────────────────────────────────────────────────────
  await must("figma_get_guide", { topic: "ux" });
  await must("figma_get_guide", { topic: "design", section: "brief" });

  // ── 3. brief A on the page, brief B on a block ────────────────────────────
  const briefA = await must("figma_set_brief", {
    role: "ux", gear: "section", title: "Spike booking button", goal: "measure the role records live", message: "Book a bench in one tap.",
    success: ["the button passes a11y at 390 x 844"], pageId: spikePage,
    details: { platform: "ios", viewport: "390x844", task: "book a bench slot" },
  });
  record.steps.briefA = { stored: briefA.stored, briefId: briefA.briefId ? "set" : null, indexOn: briefA.indexOn };
  check("a section brief with no node is stored on the page", briefA.stored === "page" && briefA.briefId === spikePage, record.steps.briefA);
  const briefB = await must("figma_set_brief", {
    role: "ux", gear: "page", title: "Spike landing", goal: "measure the brief block live", message: "You fix your own bike here, with a mechanic beside you.",
    audience: "neighbours on a phone", proof: ["8 benches"], constraints: ["one scroll"], givens: "none", success: ["books within one scroll at 390 x 844", "every state drawn"],
    tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" }, format: "390x844 px phone", pageId: spikePage,
    details: { platform: "ios", viewport: "390x844", task: "book a slot", screens: [{ name: "Slots", states: ["empty"] }] },
  });
  const block = briefB.blockId ? await must("figma_get_nodes_info", { nodeIds: [briefB.blockId] }) : null;
  record.steps.briefB = { stored: briefB.stored, block: block?.items?.[0]?.node?.name ?? null };
  check("a page brief draws its block", briefB.stored === "block" && /^Brief · /.test(record.steps.briefB.block ?? ""), record.steps.briefB);
  // Brief A back in force: the screen below belongs to it.
  await must("figma_get_brief", { briefId: briefA.briefId });

  // ── 4. a screen and a11y on a real button (48 px high, over iOS's 44 pt) ──
  const screen = await must("figma_create_frame", { parentId: spikePage, name: "Spike booking / 01 Slot", width: 390, height: 844, layout: "vertical", padding: "24", gap: 16, x: 0, y: 1200 });
  await must("figma_create_from_spec", {
    parentId: screen.id,
    spec: JSON.stringify({ type: "button", name: "Book slot", layout: "horizontal", height: 48, sizing: { width: "hug", height: "fixed" }, padding: [12, 20, 12, 20], cornerRadius: 12, background: "#1F6FEB", alignX: "center", alignY: "center",
      children: [{ type: "text", name: "Label", content: "Book slot", fontSize: 16, color: "#FFFFFF" }] }),
  });
  const a11y = await must("figma_check_layout", { nodeId: screen.id, audit: ["a11y"] });
  record.steps.a11y = { ok: a11y.ok, brief: a11y.audit?.brief ?? null, kinds: [...new Set((a11y.issues ?? []).map((i) => i.kind))] };
  check("the check measured against the brief in force", Boolean(a11y.audit?.brief), record.steps.a11y);

  // ── 5. sign-off, answering what it lists ──────────────────────────────────
  const lenses = ["message", "accessibility", "type and composition", "finish QA"].map((lens) => ({ lens, score: 8, verdict: "pass" }));
  // briefId named: a passing sign-off ends the brief in force, and the second one below comes after it.
  const signOff = (answers) => must("figma_sign_off", { briefId: briefA.briefId, nodeIds: [screen.id], lenses, rounds: 1, placeholders: ["none"], ...(answers.length ? { answers } : {}) });
  let answers = [];
  let so = await signOff(answers);
  if (!so.ok && (so.unanswered ?? []).length) {
    answers = so.unanswered.map((u) => ({ kind: u.kind, nodeId: u.nodeId, reason: "kept for the spike" }));
    so = await signOff(answers);
  }
  record.steps.signOff = { ok: so.ok, blockers: (so.blockers ?? []).map((b) => b.what).slice(0, 5), checks: so.checks?.map((c) => `${c.name}:${c.ok}`) };
  check("the section screen signs off", so.ok === true, record.steps.signOff);

  // ── 6. fingerprint, a stale sign-off and the final export ─────────────────
  const fresh1 = await must("figma_get_brief", { nodeId: screen.id, fingerprint: true });
  check("the fingerprint is fresh right after the sign-off", fresh1.fresh === true, { fresh: fresh1.fresh });
  await must("figma_set_fills", { nodeIds: [screen.id], fills: [{ color: "#FAFAFA" }] });
  const fresh2 = await must("figma_get_brief", { nodeId: screen.id, fingerprint: true });
  check("an edit makes it stale", fresh2.fresh === false, { fresh: fresh2.fresh });
  const out = "live-roles-final.png";
  const finalRefused = await call("figma_export_node", { nodeId: screen.id, saveTo: out, final: true });
  check("a final export of a changed screen is refused", finalRefused.code === "PROCESS_REQUIRED", finalRefused.code ?? "ok");
  so = await signOff(answers);
  const finalOk = so.ok ? await call("figma_export_node", { nodeId: screen.id, saveTo: out, final: true }) : { ok: false, code: "not signed" };
  check("after a new sign-off the final export runs", finalOk.ok, finalOk.code ?? "ok");

  // ── 7. a plugin restart ───────────────────────────────────────────────────
  const stamp = (s) => (s ? `${s.sessionId}@${s.connectedAt}` : undefined);
  const before = stamp(activeSession(await must("figma_status", {})));
  log(`\n>>> In Figma: close the Figxel plugin window and run it again (Plugins > Development > Figxel). Waiting up to ${waitS} s…`);
  let after = before;
  for (const until = Date.now() + waitS * 1000; Date.now() < until && (after === before || after === undefined); ) {
    await sleep(3000);
    after = stamp(activeSession(await call("figma_status", {}).then((r) => r.data ?? {})));
  }
  if (after === before || after === undefined) check("the plugin was run again", false, "timed out");
  else {
    const readA = await must("figma_get_brief", { briefId: briefA.briefId });
    const index = await must("figma_get_brief", {});
    const fresh3 = await must("figma_get_brief", { nodeId: screen.id, fingerprint: true });
    record.steps.restart = { briefA: readA.brief?.status ?? null, openListed: (index.open ?? []).some((e) => e.id === briefB.briefId), signOff: fresh3.signOff?.ok ?? null, fresh: fresh3.fresh };
    check("the page's brief survives a plugin restart", Boolean(readA.brief), record.steps.restart);
    check("the root index survives it (brief B still listed open)", record.steps.restart.openListed, record.steps.restart);
    check("the sign-off and its fingerprint survive it", fresh3.signOff?.ok === true && fresh3.fresh === true, record.steps.restart);
  }

  // ── 8. a clone ────────────────────────────────────────────────────────────
  const clone = await must("figma_clone_node", { nodeId: screen.id });
  const cloneId = clone.id ?? clone.nodeId;
  const onClone = await must("figma_get_brief", { nodeId: cloneId });
  record.steps.clone = { invalid: onClone.invalid ?? null, signOffOnCopy: Boolean(onClone.signOff), briefOnCopy: Boolean(onClone.brief) };
  log(`clone: ${JSON.stringify(record.steps.clone)} (C-381: whether clone() copies shared plugin data)`);
} catch (err) {
  failed = true;
  record.error = String(err?.message ?? err).replaceAll(process.env.USERPROFILE ?? "~~", "~").replaceAll(process.env.HOME ?? "~~", "~");
  console.error(record.error);
} finally {
  if (spikePage && !keep) {
    const del = await call("figma_delete_nodes", { nodeIds: [spikePage], force: true });
    record.cleanedUp = del.ok;
  }
  if (record.checks.length || record.error) {
    mkdirSync(path.join(REPO, "spikes", "results"), { recursive: true });
    writeFileSync(path.join(REPO, "spikes", "results", "live-roles.json"), JSON.stringify({ ...record, passed: !failed }, null, 2) + "\n");
  }
  await mcp.close();
}
process.exit(failed ? 1 : 0);
