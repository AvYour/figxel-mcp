// End-to-end against the built bundle (dist/server.js) — exactly what any MCP client launches.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { selectOps } from "../src/shared/ops.js";
import { forwardTool } from "../src/server/tools/forward.js";
import { connectedMock, newToken, sleep, startBridge, startMock } from "./helpers.js";

const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function env(home: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    BRIDGE_HOME: home,
    BRIDGE_PORT: String(port),
    BRIDGE_SESSION_WAIT_MS: "300",
    ...extra,
  };
}

async function mcpClient(home: string, port: number, extra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: env(home, port, extra), stderr: "pipe" });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

type Status = {
  bridge: { role: string; hubPid: number | null; listening: boolean; reason: string | null; toolsRegistered: string[]; toolsSelected: number; port: number };
  sessions: { file: { name: string }; active: boolean }[];
  token: { tokenPresent: boolean; tokenPath: string };
  hint: string;
};

async function status(client: Client): Promise<Status> {
  const r = await client.callTool({ name: "figma_status", arguments: {} });
  expect(r.isError).toBeFalsy();
  return r.structuredContent as Status;
}

describe("dist/server.js over stdio", () => {
  it("answers figma_status with no plugin connected — without waiting for one", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const port = await freePort();
    const client = await mcpClient(home, port, { BRIDGE_SESSION_WAIT_MS: "60000" });
    const started = Date.now();
    const st = await status(client);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(st.bridge.listening).toBe(true);
    expect(st.bridge.port).toBe(port);
    expect(st.sessions).toEqual([]);
    expect(st.hint).toMatch(/Plugins → Development → Figxel\./);
    expect(st.hint).toContain("npx -y figxel-mcp@latest setup");
    expect(st.token).toEqual({ tokenPresent: true, tokenPath: join(home, "token") });
    expect(JSON.stringify(st)).not.toContain(readFileSync(join(home, "token"), "utf8").trim());
    // The name every client shows for this server, and the key its config uses.
    expect(client.getServerVersion()?.name).toBe("figxel");
  });

  it("registers status + the read group + the Phase 2 write groups", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const client = await mcpClient(home, await freePort());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // figma_status is bridge-only; everything else is forwarded to the plugin.
    expect(names[0]).toBe("figma_status");
    expect(names).toContain("figma_get_design_context");
    expect(names).toContain("figma_create_from_spec");
    expect(names).toContain("figma_delete_nodes");
    expect(names.every((n) => n.startsWith("figma_"))).toBe(true);

    // The annotations must match the group, because a client with an approval
    // mode uses them to decide whether to ask the user first. A write tool
    // marked read-only is how an agent deletes without a prompt.
    const byName = new Map(tools.map((t) => [t.name, t]));
    const readOnly = ["figma_status", "figma_get_design_context", "figma_get_node"];
    const writable = ["figma_create_from_spec", "figma_set_text", "figma_move_nodes", "figma_delete_nodes"];
    for (const n of readOnly) expect(`${n}:${byName.get(n)?.annotations?.readOnlyHint}`).toBe(`${n}:true`);
    for (const n of writable) {
      expect(`${n}:${byName.get(n)?.annotations?.readOnlyHint}`).toBe(`${n}:false`);
      // Every write op here is idempotent under its key: the bridge guarantees a
      // retry with the same key never runs twice.
      expect(`${n}:${byName.get(n)?.annotations?.idempotentHint}`).toBe(`${n}:true`);
    }
    // Deleting is flagged destructive so a client can prompt; creating is not.
    expect(byName.get("figma_delete_nodes")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("figma_create_from_spec")?.annotations?.destructiveHint).toBe(false);

    const st = await status(client);
    // The catalog default (tools.md Count line) — selected, whether implemented yet or not.
    expect(st.bridge.toolsSelected).toBe(selectOps({ kind: "full" }, false).length);
    // Compared as a set: `toolsSelected` follows the catalog order and
    // `toolsRegistered` the registration order, and neither order is meaningful.
    expect([...st.bridge.toolsRegistered].sort()).toEqual([...names].sort());
  });

  it("never advertises a draft-07 `$schema` (the Anthropic API rejects it)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const client = await mcpClient(home, await freePort());
    const { tools } = await client.listTools();
    const withSchema = tools.filter((t) => {
      const schema = t.inputSchema as Record<string, unknown> | undefined;
      return schema && "$schema" in schema;
    });
    expect(withSchema.map((t) => t.name)).toEqual([]);
    // And the schemas are still usable: a tool with parameters keeps them, so
    // stripping the dialect did not flatten the document.
    const withParams = tools.find((t) => t.name === "figma_get_node")!;
    const props = (withParams.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain("nodeId");
  });

  it("reports a connected plugin session", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const port = await freePort();
    const client = await mcpClient(home, port);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const mock = startMock({ token, port, fileName: "Landing Page" });
    cleanup.push(() => mock.close());
    await mock.welcomed();
    await sleep(50);
    const st = await status(client);
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0]).toMatchObject({ file: { name: "Landing Page" }, active: true });
    expect(st.hint).toBe('Connected to "Landing Page" (page "Page 1").');
  });
});

describe("process lifecycle (spec §4.6)", () => {
  function startRaw(home: string, port: number, extra: Record<string, string> = {}) {
    const child = spawn(process.execPath, [SERVER], { env: env(home, port, extra), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    cleanup.push(() => child.kill());
    const rpc = (id: number, method: string, params: unknown) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { child, rpc, out: () => stdout, err: () => stderr };
  }
  const exited = (child: ChildProcess) => new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } };

  it("keeps stdout pure JSON-RPC, even while the plugin logs", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const port = await freePort();
    const p = startRaw(home, port, { BRIDGE_LOG_LEVEL: "debug" });
    p.rpc(1, "initialize", initialize);
    await sleep(500);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const mock = startMock({ token, port });
    cleanup.push(() => mock.close());
    await mock.welcomed();
    mock.send({ t: "log", level: "warn", message: "Font fallback: Inter → Roboto" });
    p.rpc(2, "tools/call", { name: "figma_status", arguments: {} });
    await sleep(500);
    const lines = p.out().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
    expect(p.err()).toContain("Font fallback");
  });

  it("exits within 1 s of stdin closing and releases the port", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const port = await freePort();
    const p = startRaw(home, port);
    p.rpc(1, "initialize", initialize);
    await sleep(500);
    const done = exited(p.child);
    const closedAt = Date.now();
    p.child.stdin.end();
    expect(await done).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(1000);
    const next = await startBridge({ port });
    cleanup.push(() => next.close());
    expect(next.isListening).toBe(true);
  });

  it("a second AI app's process shares the first one's Figma connection, then takes over when it exits", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const port = await freePort();
    const first = startRaw(home, port);
    first.rpc(1, "initialize", initialize);
    await sleep(500);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const mock = startMock({ token, port, fileName: "Shared File" });
    cleanup.push(() => mock.close());
    await mock.welcomed();
    await sleep(50);

    const client = await mcpClient(home, port);
    const before = await status(client);
    expect(before.bridge.role).toBe("proxy");
    expect(before.bridge.hubPid).toBe(first.child.pid);
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]!.file.name).toBe("Shared File");
    expect(before.hint).toMatch(/shares the Figma connection/);

    first.child.stdin.end();
    await exited(first.child);
    let after = await status(client);
    for (let i = 0; i < 40 && after.bridge.role !== "hub"; i++) {
      await sleep(250);
      after = await status(client);
    }
    expect(after.bridge.role).toBe("hub");
    expect(after.bridge.listening).toBe(true);
  }, 30_000);

  it("--print-token prints the token on stdout and exits", () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const r = spawnSync(process.execPath, [SERVER, "--print-token"], { env: env(home, 0), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stdout.trim()).toBe(readFileSync(join(home, "token"), "utf8").trim());
  });

  it("refuses to start on an invalid configuration, explaining why on stderr", () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-e2e-"));
    const r = spawnSync(process.execPath, [SERVER], { env: env(home, 0, { BRIDGE_TOOLSET: "everything" }), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^\[figxel\] error: BRIDGE_TOOLSET="everything" is not recognised/m);
    expect(r.stdout).toBe("");
  });

  it("without BRIDGE_HOME, a token in the old ~/.figma-mcp is copied into ~/.figxel once, and logged", () => {
    // The OS home is the temp folder: USERPROFILE on Windows, HOME elsewhere.
    const userHome = mkdtempSync(join(tmpdir(), "fmcp-e2e-home-"));
    mkdirSync(join(userHome, ".figma-mcp"));
    const legacy = newToken();
    writeFileSync(join(userHome, ".figma-mcp", "token"), `${legacy}\n`);
    const { BRIDGE_HOME: _unset, ...rest } = env(userHome, 0);
    const run = () => spawnSync(process.execPath, [SERVER, "--print-token"], { env: { ...rest, HOME: userHome, USERPROFILE: userHome }, encoding: "utf8" });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(legacy);
    expect(readFileSync(join(userHome, ".figxel", "token"), "utf8").trim()).toBe(legacy);
    expect(first.stderr).toMatch(/\[figxel\] info: copied the token from .*\.figma-mcp.*token/);
    expect(first.stderr).toContain(join(userHome, ".figxel", "token"));
    // Once: the next start finds the new token and says nothing about the old one.
    const second = run();
    expect(second.stdout.trim()).toBe(legacy);
    expect(second.stderr).not.toMatch(/copied the token/);
  });
});

describe("MCP plumbing for plugin-backed tools (protocol.md §9)", () => {
  // A test-only server: production registers no plugin-backed tool in Phase 0,
  // but the forwarding path every later tool uses is exercised here.
  async function harness(scenario: "slow" | "normal" = "slow") {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const mock = await connectedMock(bridge, token, { scenario, durationMs: 1000, progressMs: 50 });
    cleanup.push(() => mock.close());
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { logging: {} } });
    server.registerTool(
      "test_create_frame",
      { inputSchema: { name: z.string(), idempotencyKey: z.string().optional() } },
      (args, extra) => forwardTool(bridge, "create_frame", { name: args.name }, extra, { idempotencyKey: args.idempotencyKey }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanup.push(() => client.close());
    return { client, mock };
  }

  it("streams notifications/progress, strictly increasing, then the result with its key", async () => {
    const { client } = await harness();
    const seen: number[] = [];
    const r = await client.callTool({ name: "test_create_frame", arguments: { name: "Hero", idempotencyKey: "e2e-1" } }, undefined, {
      onprogress: (p) => seen.push(p.progress),
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ name: "Hero", idempotencyKey: "e2e-1" });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.length).toBeLessThanOrEqual(12); // coalesced to ≤ 10/s over ~1 s
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(seen.at(-1)).toBe(20); // the final value is always sent
  });

  it("turns a client cancellation into cancel{CLIENT_CANCELLED} for the plugin", async () => {
    const { client, mock } = await harness();
    const ac = new AbortController();
    const call = client.callTool({ name: "test_create_frame", arguments: { name: "X" } }, undefined, { signal: ac.signal });
    await sleep(200);
    ac.abort();
    await expect(call).rejects.toThrow();
    await sleep(100);
    expect(mock.received.find((m) => m.t === "cancel")).toMatchObject({ reason: "CLIENT_CANCELLED" });
  });
});
