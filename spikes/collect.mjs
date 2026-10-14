#!/usr/bin/env node
// Collects spike results so nobody has to copy JSON out of a plugin window.
//
//   node spikes/collect.mjs
//
// Listens on ws://127.0.0.1:38453 (loopback only, spikes only — not the bridge,
// no token). spikes/yield and spikes/probe connect here from their UI iframe
// and send every report update; each spike's latest report is written to
// spikes/results/<spike>.json.
//
// It also records evidence for spec §14.2: a connection at all means Figma
// accepted the IP-literal `ws://127.0.0.1:38453` entry in `allowedDomains`,
// and the Origin header each connection carries is logged.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });

const connections = [];
const stamp = () => new Date().toISOString();

// IPv4 and IPv6 loopback both, so a plugin that connects to `localhost` is
// measured on whether Figma's allowedDomains accepted it — not on which
// address Chromium tried first. Each connection records the one it used.
for (const host of ["127.0.0.1", "::1"]) {
  const wss = new WebSocketServer({ host, port: 38453, maxPayload: 8 * 1024 * 1024 });
  wss.on("listening", () => console.log(`${stamp()} collector listening on ${host}:38453 → ${outDir}`));
  wss.on("error", (e) => {
    console.error(`${stamp()} collector error on ${host}: ${e.message}`);
    if (host === "127.0.0.1") process.exit(1);
  });
  wss.on("connection", (ws, req) => onConnection(ws, req, host));
}

function onConnection(ws, req, host) {
  const origin = req.headers.origin ?? null;
  connections.push({ at: stamp(), origin, via: host, userAgent: req.headers["user-agent"] ?? null });
  writeFileSync(join(outDir, "connections.json"), `${JSON.stringify(connections, null, 2)}\n`);
  console.log(`${stamp()} connection via ${host} — Origin: ${JSON.stringify(origin)}`);
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const spike = String(msg.spike ?? "unknown").replace(/[^a-z0-9-]/gi, "");
    writeFileSync(join(outDir, `${spike}.json`), `${JSON.stringify({ receivedAt: stamp(), origin, ...msg }, null, 2)}\n`);
    const r = msg.report ?? {};
    const runs = Array.isArray(r.runs) ? ` runs=${r.runs.length}` : "";
    const changes = Array.isArray(r.nodeChanges) ? ` nodeChanges=${r.nodeChanges.length}` : "";
    console.log(`${stamp()} ${spike} report${runs}${changes}`);
  });
}
