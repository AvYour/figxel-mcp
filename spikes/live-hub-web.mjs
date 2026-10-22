// The hub's web endpoint through the real domain (cloud bridge plan, Phase B):
// an MCP client over Streamable HTTP, signed in with the person's token as a
// bearer header, reaches the person's real Figma, exports a frame, and gets it
// back from a download link, as claude.ai or Cursor by URL would.
//
//   node spikes/live-hub-web.mjs --url https://mcp.figxel.example/mcp --token-file <path> --node <id>
//
// --token-file  a file holding the token, or an invite (wss://…#token); never printed
// --node        a frame in the person's open file to export (a small render)
//
// Writes spikes/results/live-hub-web.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const url = arg("url");
const tokenFile = arg("token-file");
const nodeId = arg("node");
if (!url || !tokenFile || !nodeId) {
  console.error("usage: node spikes/live-hub-web.mjs --url <https://…/mcp> --token-file <path> --node <id>");
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim().split("#").pop();
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${tokenFile} holds no token`);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.error(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const started = Date.now();

// A wrong token is refused before anything else happens.
const refused = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${"0".repeat(64)}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
});
check("a wrong token gets 401", refused.status === 401, `HTTP ${refused.status}`);

const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "live-hub-web", version: "0" });
const t0 = Date.now();
await client.connect(transport);
check("initialize over HTTPS with the bearer token", Boolean(transport.sessionId), `${Date.now() - t0} ms`);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = r.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { ok: !r.isError, data, text };
};

const tools = await client.listTools();
check("the tools are listed", tools.tools.length > 100, `${tools.tools.length} tools`);
const status = await call("figma_status");
const files = (status.data?.sessions ?? []).map((s) => s.file?.name);
check("figma_status shows the person's own Figma", files.length > 0, JSON.stringify(files));
check("and says it is the web endpoint", /team's web endpoint/.test(status.data?.hint ?? ""), (status.data?.hint ?? "").slice(0, 120));

const t1 = Date.now();
const exported = await call("figma_export_node", { nodeId, format: "PNG", scale: 0.25, saveTo: "live-web-test.png" });
const link = exported.data?.downloads?.[0];
check("an export comes back with a download link", exported.ok && Boolean(link?.url), exported.ok ? `${Date.now() - t1} ms` : exported.text.slice(0, 200));
if (link?.url) {
  const got = await fetch(link.url);
  const bytes = Buffer.from(await got.arrayBuffer());
  check("the link serves the PNG", got.status === 200 && bytes.subarray(1, 4).toString() === "PNG", `HTTP ${got.status}, ${bytes.length} bytes, ${got.headers.get("content-type")}`);
}
await client.close();

const result = { ranAt: new Date(started).toISOString(), endpoint: new URL(url).host, nodeId, checks, ok: checks.every((c) => c.ok) };
mkdirSync(path.join(REPO, "spikes/results"), { recursive: true });
writeFileSync(path.join(REPO, "spikes/results/live-hub-web.json"), `${JSON.stringify(result, null, 2)}\n`);
console.error(result.ok ? "all checks passed" : "some checks FAILED");
process.exit(result.ok ? 0 : 1);
