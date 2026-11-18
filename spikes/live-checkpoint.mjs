// Live run of the checkpoint (C-422): a page-gear brief stops after its styleframes.
// The clone of a styleframe into the build is refused until the person's choice
// is recorded, and allowed after it; the sign-off names the missing choice until
// then. Everything the run writes is rolled back at the end (figma_rollback).
//
// Runs the built server (dist/server.js) over stdio, so it reaches Figma the way
// an AI app does: this computer's bridge, or a team's hub it joined. Use a test
// file: FIGXEL_SESSION names it (default "Figxel Showcase").
//   npm run build && node spikes/live-checkpoint.mjs
// Writes spikes/results/live-checkpoint.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const SESSION = process.env.FIGXEL_SESSION || "Figxel Showcase";
const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", () => {});
let buf = "";
const waiting = new Map();
let next = 1;
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (waiting.has(m.id)) waiting.get(m.id)(m), waiting.delete(m.id);
    } catch {}
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const steps = [];
async function call(label, name, args) {
  const t0 = Date.now();
  // figma_get_guide is answered by the server alone and takes no session.
  const r = await send("tools/call", { name, arguments: name === "figma_get_guide" ? args : { session: SESSION, ...args } });
  const text = r.error ? r.error.message : (r.result?.content ?? []).map((c) => c.text ?? "").join(" ");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const step = { label, tool: name, ms: Date.now() - t0, isError: !!(r.error || r.result?.isError), text, json };
  steps.push(step);
  console.log(`${step.isError ? "✗" : "✓"} ${label} (${step.ms} ms) ${text.slice(0, 220).replace(/\s+/g, " ")}`);
  return step;
}

await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-checkpoint", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise((r) => setTimeout(r, 4000));

const sp = await call("savepoint", "figma_savepoint", { label: "Live run: checkpoint (C-422)" });
const savepointId = sp.json?.savepointId;
await call("read the graphic skill", "figma_get_guide", { topic: "graphic" });
await call("read the design skill", "figma_get_guide", { topic: "design" });
const brief = await call("brief at page gear", "figma_set_brief", {
  role: "graphic",
  gear: "page",
  title: "Live run · checkpoint",
  goal: "Show that the build waits for the person's choice.",
  message: "The agent stops after the styleframes.",
  success: ["the clone into the build is refused before the choice", "and allowed after it"],
  audience: "the owner, checking the release",
  proof: ["a refused clone", "an allowed clone"],
  constraints: ["400x300 px", "rolled back after the run"],
  givens: "none",
  tone: { words: ["plain", "short", "factual"], not: "decorative" },
  format: "400x300 px test card",
  defaultToAvoid: "nothing: a test",
  details: { medium: "web", viewing: "the owner's screen" },
  pageId: "1:2",
  x: 6000,
  y: 5600,
});
const briefId = brief.json?.briefId;
const frame = await call("styleframe", "figma_create_frame", { parentId: "1:2", name: "Direction T · live run", x: 6000, y: 6400, width: 400, height: 300, background: "#E9ECF1" });
const frameId = frame.json?.id;
const decision = await call("decision line", "figma_set_brief", {
  briefId,
  direction0: "a test card",
  chosen: "T · live run",
  styleframes: [frameId],
  directions: [
    { name: "T · live run", idea: "the one styleframe", total: 20 },
    { name: "U · other", idea: "not built", total: 15 },
  ],
});
const lens = [{ lens: "message", score: 8, verdict: "pass" }];
const signBefore = await call("sign-off before the choice", "figma_sign_off", { briefId, nodeIds: [frameId], rounds: 1, lenses: lens });
const cloneArgs = { nodeId: frameId, parentId: "1:2", x: 6500, y: 6400, name: "Live run / build" };
const before = await call("clone before the choice (expect refused)", "figma_clone_node", { ...cloneArgs, idempotencyKey: "live-checkpoint-clone-1" });
await call("record the person's choice", "figma_set_brief", { briefId, chosen: "T · live run", approvedBy: "owner" });
const after = await call("clone after the choice (expect allowed)", "figma_clone_node", { ...cloneArgs, idempotencyKey: "live-checkpoint-clone-2" });
const signAfter = await call("sign-off after the choice", "figma_sign_off", { briefId, nodeIds: [frameId], rounds: 1, lenses: lens });
const got = await call("read the brief", "figma_get_brief", { briefId });
const back = savepointId ? await call("roll back", "figma_rollback", { savepointId, confirm: true }) : null;

// The checkpoint's blocker among the sign-off's blockers (tools/brief.ts checkpointBlocker), not any mention of
// the choice: the brief's own lines, echoed in the report, may name it too.
const choiceBlocker = (s) => (s.json?.blockers ?? []).find((b) => /checkpoint "directions"/.test(b.what))?.what ?? null;
const namesChoice = (s) => choiceBlocker(s) !== null;
const result = {
  date: new Date().toISOString(),
  file: SESSION,
  checkpointRecorded: brief.json?.record?.checkpoint ?? null,
  missingForSignOffNamesChoice: (brief.json?.missingForSignOff ?? []).some((m) => /approvedBy/.test(m)),
  stopReturned: !!decision.json?.stop,
  signOffBeforeNamesChoice: namesChoice(signBefore),
  cloneBeforeRefused: before.isError && /PROCESS_REQUIRED/.test(before.text),
  cloneAfterAllowed: !after.isError,
  signOffBeforeBlocker: choiceBlocker(signBefore),
  signOffAfterStillNamesChoice: namesChoice(signAfter),
  approvalOnBrief: got.json?.brief?.approval ?? null,
  rollback: back?.json ? { undone: back.json.undone, verified: back.json.verified, stillThere: back.json.stillThere } : null,
  steps: steps.map(({ label, ms, isError, text }) => ({ label, ms, isError, text: text.slice(0, 200) })),
};
writeFileSync(new URL("./results/live-checkpoint.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log("\nRESULT " + JSON.stringify({ ...result, steps: undefined }));
child.kill();
process.exit(0);
