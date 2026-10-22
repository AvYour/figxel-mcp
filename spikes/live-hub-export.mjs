// A large file through a team's hub (docs/superpowers/plans/2026-10-22-cloud-bridge.md,
// Phase A live runs): a video rendered in the person's real Figma reaches their
// own computer through the hub, in chunks, and is written there.
//
//   node spikes/live-hub-export.mjs --hub wss://mcp.figxel.example --token-file <path> --node <id>
//
// The person's Figma must be connected to the hub (plugin window: Change server).
// The render is a preview (no final), so no sign-off is needed.
// Writes spikes/results/live-hub-export.json.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const hub = arg("hub");
const tokenFile = arg("token-file");
const nodeId = arg("node");
if (!hub || !tokenFile || !nodeId) {
  console.error("usage: node spikes/live-hub-export.mjs --hub <wss://...> --token-file <path> --node <id>");
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${tokenFile} does not hold a 64-hex token`);

const agent = await connect({ env: { BRIDGE_HUB_URL: hub, BRIDGE_TOKEN: token }, sessionWaitMs: 10_000 });
const status = await agent.call("figma_status", {});
const real = (status.data?.sessions ?? []).filter((s) => s.pluginVersion !== "0.0.0-mock");
if (real.length === 0) throw new Error("no real Figma session on the hub for this token: connect the plugin to the hub first");
const session = real[0].sessionId;
console.error(`through ${status.data.bridge.hub}: "${real[0].file?.name}" (${session})`);

const jobId = `hub-export-${Date.now().toString(36)}`;
const saveTo = `hub-test/${jobId}.mp4`;
const started = Date.now();
let r = await agent.call("figma_export_video", { session, nodeId, saveTo, jobId, wait: 40 }, { timeoutMs: 120_000 });
let polls = 1;
while (r.ok && r.data?.status === "rendering" && polls < 30) {
  console.error(`rendering ... ${Math.round((Date.now() - started) / 1000)} s`);
  r = await agent.call("figma_export_video", { session, jobId, wait: 40 }, { timeoutMs: 120_000 });
  polls++;
}
const elapsedS = Math.round((Date.now() - started) / 100) / 10;
await agent.close();
if (!r.ok) throw new Error(`export failed: ${r.text.slice(0, 400)}`);

const file = r.data?.path;
const onDisk = file ? statSync(file).size : 0;
const result = {
  ranAt: new Date(started).toISOString(),
  hub: new URL(hub).host,
  nodeId,
  elapsedS,
  polls,
  path: file,
  bytesReported: r.data?.bytes ?? null,
  bytesOnDisk: onDisk,
  ok: onDisk > 0 && (r.data?.bytes == null || r.data.bytes === onDisk),
};
mkdirSync(path.join(REPO, "spikes/results"), { recursive: true });
writeFileSync(path.join(REPO, "spikes/results/live-hub-export.json"), `${JSON.stringify(result, null, 2)}\n`);
console.error(`${result.ok ? "ok" : "FAIL"}: ${(onDisk / 1024 / 1024).toFixed(1)} MiB written to ${file} in ${elapsedS} s`);
process.exit(result.ok ? 0 : 1);
