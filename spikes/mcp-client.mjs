// A stdio MCP client for live probes, in Node — the Python harness (mcpc.py)
// needs an interpreter this machine does not always have.
//
// It spawns `node dist/server.js`, so it always runs the code on disk. When
// another figma-mcp process already holds the Figma connection, the spawned
// server joins it as a proxy and forwards its calls (src/server/bridge.ts):
// any op the running plugin advertises works, whatever build the hub is.
//
//   import { connect } from "./mcp-client.mjs";
//   const mcp = await connect({ allowEval: true });
//   const r = await mcp.call("figma_status", {});
//   await mcp.close();

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function connect({ allowEval = false, sessionWaitMs = 5000, env = {} } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: REPO,
    stderr: "ignore",
    env: {
      ...process.env,
      BRIDGE_SESSION_WAIT_MS: String(sessionWaitMs),
      ...(allowEval ? { BRIDGE_ALLOW_EVAL: "1" } : {}),
      ...env,
    },
  });
  const client = new Client({ name: "live-probe", version: "0" });
  await client.connect(transport);

  /**
   * Call a tool. Returns { ok, data, images, text } — `data` is the parsed JSON
   * of the first text block when it parses, `ok` is false when the server set
   * isError. Never throws for a tool error; throws only for transport failure.
   */
  async function call(name, args = {}, { timeoutMs = 120_000 } = {}) {
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (err) {
      return { ok: false, data: null, images: [], text: String(err?.message ?? err) };
    }
    const blocks = res.content ?? [];
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
    const images = blocks.filter((b) => b.type === "image");
    let data = null;
    if (texts[0] !== undefined) {
      try {
        data = JSON.parse(texts[0]);
      } catch {
        data = null;
      }
    }
    return { ok: !res.isError, data, images, text: texts.join("\n") };
  }

  async function list() {
    const out = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      out.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  return { call, list, close: () => client.close(), client };
}
