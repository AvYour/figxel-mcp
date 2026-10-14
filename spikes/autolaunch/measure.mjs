#!/usr/bin/env node
// Phase 0 spike 2 — measure auto-launch against the four targets in spec §5.7.5.
//
//   npm run build
//   node spikes/autolaunch/measure.mjs [--attempts 20] [--plugin "figma-mcp bridge"]
//
// Preconditions (the script checks what it can):
//   - Figma desktop is running with a file open, and "figma-mcp bridge" is imported
//     and has its token saved (README quickstart).
//   - Port 38452 is free, or held by a figma-mcp of this build (this script then shares it).
// Per attempt you close the plugin window in Figma, click back into this terminal
// (the real case: Figma is NOT in the foreground), and press Enter. The script then
// runs autolaunch.ps1 — which brings Figma forward and TYPES — and times how long
// until the real bridge (dist/server.js) reports a plugin session.
//
// Results go to spikes/autolaunch/results-<timestamp>.json plus a summary table.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const server = join(root, "dist/server.js");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const attempts = Number(opt("--attempts", "20"));
const pluginName = opt("--plugin", "figma-mcp bridge");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.error("This spike is Windows-only (spec §5.7).");
  process.exit(1);
}
if (!existsSync(server)) {
  console.error("dist/server.js is missing — run `npm run build` first.");
  process.exit(1);
}

const client = new Client({ name: "autolaunch-spike", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, BRIDGE_SESSION_WAIT_MS: "0" }, stderr: "ignore" }),
);
const status = async () => (await client.callTool({ name: "figma_status", arguments: {} })).structuredContent;

const first = await status();
if (first.bridge.role === "none") {
  console.error(
    `The bridge can neither hold nor share port ${first.bridge.port} (${first.bridge.reason}). ` +
      "If an older figma-mcp build holds it, restart the MCP servers of the app that started it (or close that app) and retry.",
  );
  process.exit(1);
}
console.error(`Bridge role: ${first.bridge.role}${first.bridge.role === "proxy" ? ` (sharing process ${first.bridge.hubPid})` : ""}`);

function runPs1() {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "autolaunch.ps1"), "-PluginName", pluginName],
    { encoding: "utf8" },
  );
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

const rl = createInterface({ input: process.stdin, output: process.stderr });
const results = [];
console.error(`\nAuto-launch spike: ${attempts} attempts, plugin "${pluginName}". This brings Figma forward and types.\n`);

for (let n = 1; n <= attempts; n++) {
  await rl.question(`[${n}/${attempts}] Close the plugin window in Figma, click into THIS terminal, then press Enter… `);
  for (let i = 0; i < 50 && (await status()).sessions.length > 0; i++) await sleep(100);
  if ((await status()).sessions.length > 0) {
    console.error("  the plugin is still connected — close its window and retry this attempt");
    n--;
    continue;
  }
  const t0 = Date.now();
  let ps;
  try {
    ps = runPs1();
  } catch (e) {
    ps = { ok: false, stage: "powershell", error: String(e.message ?? e) };
  }
  let sessionMs = null;
  let file = null;
  if (ps.ok) {
    while (Date.now() - t0 < 10_000) {
      const st = await status();
      if (st.sessions.length > 0) {
        sessionMs = Date.now() - t0;
        file = st.sessions[0].file.name;
        break;
      }
      await sleep(100);
    }
  }
  const stray = Boolean(ps.strayRisk);
  const r = { attempt: n, success: sessionMs !== null, sessionMs, file, stray, ps };
  results.push(r);
  console.error(
    r.success
      ? `  ✓ session in ${sessionMs} ms (${file})`
      : `  ✗ ${ps.ok ? "no session within 10 s (wrong plugin picked? not imported?)" : `aborted at ${ps.stage}`}`,
  );
}
rl.close();

const ok = results.filter((r) => r.success);
const times = ok.map((r) => r.sessionMs).sort((a, b) => a - b);
const summary = {
  attempts: results.length,
  successRate: results.length ? ok.length / results.length : 0,
  medianSessionMs: times.length ? times[Math.floor(times.length / 2)] : null,
  maxSessionMs: times.length ? times[times.length - 1] : null,
  strayKeystrokes: results.filter((r) => r.stray).length,
  abortedAtForeground: results.filter((r) => r.ps.stage === "foreground").length,
  targets: {
    "success ≥ 95% over 20 attempts": results.length >= 20 && ok.length / results.length >= 0.95,
    "trigger → session ≤ 5 s": times.length > 0 && times[times.length - 1] <= 5000,
    "0 stray keystrokes over 50 attempts": results.length >= 50 ? results.every((r) => !r.stray) : "needs 50 attempts",
    "top quick-action hit is our plugin (20/20)": results.length >= 20 && ok.length === results.length,
  },
};
const file = join(here, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify({ pluginName, summary, results }, null, 2)}\n`);
console.error(`\n${JSON.stringify(summary, null, 2)}\n\nSaved ${file}`);
await client.close();
process.exit(0);
