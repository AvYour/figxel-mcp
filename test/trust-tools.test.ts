// Trust on the server (docs/superpowers/plans/2026-10-19-trust-contract.md § Server):
// BRIDGE_CONFLICTS and the guard every write request carries, through a proxy
// too; `force` on every write tool; the journal the forwarding path feeds;
// figma_get_changes merged with the plugin's change log; figma_savepoint and
// figma_rollback, safe and refused; figma_stress_test; registration.
//
// The plugin's trust ops are answered by a fake bridge exactly as the contract
// specifies them (§ Plugin ops), so these tests do not wait for the plugin.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { editorsSuffix } from "../src/shared/editors.js";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { OPS, opName } from "../src/shared/ops.js";
import type { Bridge } from "../src/server/bridge.js";
import { ConfigError, loadConfig, readOrCreateToken } from "../src/server/config.js";
import { journalOf } from "../src/server/journal.js";
import { connect, createApp } from "../src/server/mcp.js";
import { writeEpoch } from "../src/server/tools/forward.js";
import { registerTools } from "../src/server/tools/index.js";
import { STRESS_AUDITS, STRESS_CASES } from "../src/server/tools/trust.js";
import { connectedMock, newToken, quietLogger, startBridge, type MockPlugin } from "./helpers.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const requestsSeen = (mock: MockPlugin) => mock.received.filter((m) => m.t === "request") as unknown as Array<{ op: string; params: Record<string, unknown>; guard?: unknown }>;
const home = () => mkdtempSync(join(tmpdir(), "fmcp-trust-"));

// ── BRIDGE_CONFLICTS and the guard on the wire ─────────────────────────────

describe("BRIDGE_CONFLICTS", () => {
  it("is refuse by default, takes warn and off, and anything else stops the server", () => {
    expect(loadConfig({ BRIDGE_HOME: home() }).conflicts).toBe("refuse");
    expect(loadConfig({ BRIDGE_HOME: home(), BRIDGE_CONFLICTS: "warn" }).conflicts).toBe("warn");
    expect(loadConfig({ BRIDGE_HOME: home(), BRIDGE_CONFLICTS: " off " }).conflicts).toBe("off");
    expect(() => loadConfig({ BRIDGE_HOME: home(), BRIDGE_CONFLICTS: "refuze" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_HOME: home(), BRIDGE_CONFLICTS: "refuze" })).toThrow(/BRIDGE_CONFLICTS="refuze" must be one of refuse, warn, off/);
  });
});

describe("the guard every write request carries (RequestMsg.guard)", () => {
  it("this process's mode and the call's force on a write; nothing on a read", async () => {
    for (const mode of [undefined, "warn", "off"] as const) {
      const token = newToken();
      const bridge = await startBridge({ token, ...(mode ? { conflicts: mode } : {}) });
      cleanup.push(() => bridge.close());
      const mock = await connectedMock(bridge, token);
      cleanup.push(() => mock.close());
      await bridge.request("create_frame", { name: "A" });
      await bridge.request("create_frame", { name: "B" }, { force: true });
      await bridge.request("get_metadata", {});
      const seen = requestsSeen(mock);
      expect(seen.map((r) => [r.op, r.guard]), String(mode)).toEqual([
        ["create_frame", { conflicts: mode ?? "refuse", force: false, agent: expect.stringMatching(/^[0-9a-f]{8}$/) }],
        ["create_frame", { conflicts: mode ?? "refuse", force: true, agent: expect.stringMatching(/^[0-9a-f]{8}$/) }],
        ["get_metadata", undefined],
      ]);
      // force is the guard's, never a param.
      expect(seen[1]!.params).toEqual({ name: "B" });
    }
  });

  it("through a proxy: the proxy's own mode and the call's force, sent on by the hub", async () => {
    const token = newToken();
    const hub = await startBridge({ token });
    cleanup.push(() => hub.close());
    const mock = await connectedMock(hub, token);
    cleanup.push(() => mock.close());
    const proxy = await startBridge({ token, port: hub.port, conflicts: "off" });
    cleanup.push(() => proxy.close());
    expect(proxy.role).toBe("proxy");
    await proxy.request("create_frame", { name: "Via proxy" }, { force: true });
    await hub.request("create_frame", { name: "Hub's own" });
    const guards = requestsSeen(mock).map((r) => r.guard as { agent?: string });
    expect(guards).toEqual([
      { conflicts: "off", force: true, agent: expect.stringMatching(/^[0-9a-f]{8}$/) },
      { conflicts: "refuse", force: false, agent: expect.stringMatching(/^[0-9a-f]{8}$/) },
    ]);
    // Each process names itself, so a rollback can tell one agent's undo steps from another's.
    expect(guards[0]!.agent).not.toBe(guards[1]!.agent);
  });

  it("from the MCP tool to the wire: config to bridge, force out of the params and into the guard, the call journalled", async () => {
    const config = loadConfig({ BRIDGE_HOME: home(), BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "500", BRIDGE_CONFLICTS: "warn", BRIDGE_PROCESS: "off" });
    const token = readOrCreateToken(config.tokenPath);
    const app = await createApp(config, token, quietLogger);
    cleanup.push(() => app.close());
    const mock = await connectedMock(app.bridge, token);
    cleanup.push(() => mock.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "trust-wire", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    cleanup.push(() => client.close());

    const r = (await client.callTool({ name: "figma_create_frame", arguments: { name: "Hero", force: true } })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    const req = requestsSeen(mock).find((m) => m.op === "create_frame")!;
    expect(req.guard).toEqual({ conflicts: "warn", force: true, agent: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(req.params).not.toHaveProperty("force");

    // The mock plugin predates get_changes: the journal still answers, with the plugin's error beside it.
    const changes = (await client.callTool({ name: "figma_get_changes", arguments: {} })) as { structuredContent: Record<string, unknown> };
    const s = changes.structuredContent;
    expect(s.file).toBe("Mock File");
    expect(s.journal).toEqual([expect.objectContaining({ seq: 1, tool: "figma_create_frame", ok: true, created: [expect.stringMatching(/^1:\d+$/)] })]);
    expect(s.plugin).toMatchObject({ code: "UNSUPPORTED" });
  });
});

// ── the tools, over a fake plugin ───────────────────────────────────────────

type Sent = { op: string; params: Record<string, unknown>; opts: { session?: string; force?: boolean; idempotencyKey?: string } };

/** A Figma file as the trust ops answer for it (contract § Plugin ops): an undo counter, a clock, a change log. */
class TrustWorld {
  sent: Sent[] = [];
  sessions: Array<Record<string, unknown>> = [
    { sessionId: "s-1", active: true, instanceId: "run-1", editorType: "figma", file: { name: "Co-op", key: null }, page: { id: "0:1", name: "Page 1" }, selection: null },
  ];
  commits = 0;
  clock = 1_760_000_000_000;
  nextId = 10;
  /** What get_changes reports people did. */
  log = {
    changes: [{ nodeId: "12:34", name: "Hero / Title", by: "person", at: 1_760_000_000_500 }],
    conflicts: [{ nodeId: "12:34", name: "Hero / Title", by: "person", at: 1_760_000_000_500, viewedAt: 1_760_000_000_100 }],
    pageSwitches: [],
  };
  /** A plugin built before the trust ops. */
  oldPlugin = false;
  /** Since the savepoint a person changed the page: rollback refuses. */
  blocked = false;
  /** Nodes the rollback's check finds still there. */
  stillThere: string[] = [];
  /** The plugin's savepoint answer, when a test wants another. */
  savepointAnswer: Record<string, unknown> | null = null;

  bridge(): Bridge {
    return {
      request: async (op: string, params: Record<string, unknown>, opts: Sent["opts"] = {}) => {
        this.sent.push({ op, params, opts });
        if (this.sessions.length === 0) throw new BridgeError(ErrorCode.NO_SESSION, "No Figma plugin is connected.");
        if (this.oldPlugin && ["get_changes", "savepoint", "rollback", "stress_test"].includes(op)) {
          throw new BridgeError(ErrorCode.UNSUPPORTED, `The connected plugin does not implement op "${op}".`, { hint: "Run the plugin again." });
        }
        this.clock += 1000;
        switch (op) {
          case "get_changes":
            return { watchedPageId: "0:1", commits: this.commits, ...this.log };
          case "savepoint":
            return this.savepointAnswer ?? { commits: this.commits, at: this.clock, pageId: "0:1" };
          case "rollback": {
            if (this.blocked) {
              throw new BridgeError(ErrorCode.ROLLBACK_BLOCKED, "figma_rollback was refused before any undo: \"Hero / Title\" (12:34) was edited by you after the savepoint.", {
                hint: `Undoing now would take that edit too. The safe part: figma_delete_nodes { nodeIds: ${JSON.stringify(params.createdIds)} }.`,
                partial: { created: [], changed: [{ nodeId: "12:34", name: "Hero / Title", by: "person", at: this.clock }], safe: params.createdIds },
              });
            }
            const undone = this.commits - (params.commits as number);
            this.commits -= undone;
            return { undone, verified: this.stillThere.length === 0, stillThere: this.stillThere };
          }
          case "set_text":
            throw new BridgeError(ErrorCode.STALE, 'figma_set_text was refused before any change: "Hero / Title" (12:34) was edited by you after the agent last read it.', {
              hint: 'Read it again (figma_get_node { nodeId: "12:34" }), then send the call again; or pass force: true to overwrite on purpose.',
              partial: { created: [], conflicts: this.log.conflicts },
            });
          case "create_from_spec":
            this.commits++;
            throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, "No font could be loaded for spec.children[1].", {
              partial: { created: [{ id: "6:1", name: "Card", path: "spec" }], failedAt: "spec.children[1]" },
            });
          case "stress_test":
            this.commits++;
            return {
              baseline: { ok: true, counts: { error: 0, warning: 0, info: 1 } },
              cases: [{ case: "expand", broke: [{ kind: "text_overflow", severity: "error", path: "Card / Title", detail: "overflows by 46 px" }], ok: false }],
              ...(params.keep === true ? { kept: ["9:1", "9:2"] } : {}),
            };
          case "batch":
            this.commits++;
            return { steps: [], completed: (params.steps as unknown[]).length };
          case "create_frame":
            this.commits++;
            return { id: `5:${this.nextId++}`, name: String(params.name ?? "Frame") };
          default:
            this.commits++;
            return { updated: 1, items: [] };
        }
      },
      statusAsync: async () => ({ sessions: this.sessions, allowUnverified: false }),
      status: () => ({ sessions: this.sessions }),
    } as unknown as Bridge;
  }

  ops(): string[] {
    return this.sent.map((s) => s.op);
  }

  last(op: string): Sent {
    return [...this.sent].reverse().find((s) => s.op === op)!;
  }
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

async function serve(world = new TrustWorld(), env: Record<string, string> = {}) {
  const config = loadConfig({ BRIDGE_HOME: home(), BRIDGE_PORT: "0", BRIDGE_PROCESS: "off", ...env });
  const server = new McpServer({ name: "trust", version: "0" });
  const bridge = world.bridge();
  registerTools(server, bridge, config, Date.now(), quietLogger);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "trust-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
  const data = (r: Result) => (r.structuredContent ?? JSON.parse(r.content[0]!.text!)) as Record<string, unknown>;
  return { world, bridge, client, call, data };
}

const FILE = "Co-op (figma)";

describe("force: every write tool takes it, and it reaches the guard", () => {
  it("every registered write tool has `force`; no read does", async () => {
    const { client } = await serve();
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
      const write = OPS.get(opName(t.name))?.write === true;
      expect(props.force?.type, t.name).toBe(write ? "boolean" : undefined);
    }
  });

  it("leaves the op's params and rides in the request; absent, it is false", async () => {
    const { world, call } = await serve();
    expect((await call("figma_set_fills", { nodeIds: ["12:34"], fills: [{ color: "#ffffff" }], force: true })).isError).toBeFalsy();
    expect(world.last("set_fills").params).not.toHaveProperty("force");
    expect(world.last("set_fills").opts.force).toBe(true);
    await call("figma_set_fills", { nodeIds: ["12:34"], fills: [{ color: "#ffffff" }] });
    expect(world.last("set_fills").opts.force).toBe(false);
    // A read has no force to send.
    await call("figma_get_node", { nodeId: "12:34" });
    expect(world.last("get_node").opts).not.toHaveProperty("force");
  });

  it("a tool that builds its own params passes it too: figma_batch's one force, at the top level", async () => {
    const { world, call } = await serve();
    const steps = JSON.stringify([{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } }]);
    await call("figma_batch", { steps, force: true });
    expect(world.last("batch").opts.force).toBe(true);
    expect(world.last("batch").params).toEqual({ steps: [{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } }] });
    const r = await call("figma_batch", { steps: JSON.stringify([{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5, force: true } }]) });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/steps\[0\]\.params\.force`: the batch takes one `force`, at the top level/);
  });

  it("a STALE refusal passes through, safe to retry", async () => {
    const { call, data } = await serve();
    const r = await call("figma_set_text", { nodeId: "12:34", content: "Book a bench" });
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ code: "STALE", safeToRetry: true, partial: { created: [] } });
    expect(r.content[0]!.text).toMatch(/pass force: true to overwrite on purpose/);
  });
});

describe("the journal, fed from the forwarding path", () => {
  it("records creates, edits, failures and batches, per file, with the plugin's changes beside them", async () => {
    const { world, call, data } = await serve();
    await call("figma_create_frame", { name: "Hero" });
    await call("figma_set_fills", { nodeIds: ["5:10"], fills: [{ color: "#1a2b3c" }] });
    await call("figma_set_text", { nodeId: "12:34", content: "Book a bench" });
    await call("figma_create_from_spec", { spec: JSON.stringify({ type: "frame", name: "Card", children: [{ type: "text", content: "x" }, { type: "text", content: "y" }] }), parentId: "5:10" });
    await call("figma_batch", { steps: JSON.stringify([{ op: "set_opacity", params: { nodeIds: ["5:10"], opacity: 0.5 } }, { op: "rename_node", params: { nodeId: "6:1", name: "Card" } }]) });
    // Reads are not journalled.
    await call("figma_get_node", { nodeId: "5:10" });

    const r = await call("figma_get_changes");
    const d = data(r);
    expect(d.file).toBe("Co-op");
    expect(d.lastSeq).toBe(5);
    expect(d.journal).toEqual([
      { seq: 1, at: expect.any(String), tool: "figma_create_frame", summary: 'figma_create_frame name="Hero"', ok: true, created: ["5:10"] },
      { seq: 2, at: expect.any(String), tool: "figma_set_fills", summary: "figma_set_fills nodeIds=[5:10] fills=[1]", ok: true, targets: ["5:10"] },
      { seq: 3, at: expect.any(String), tool: "figma_set_text", summary: 'figma_set_text nodeId="12:34" content="Book a bench"', ok: false, error: "STALE", unchanged: true, targets: ["12:34"] },
      { seq: 4, at: expect.any(String), tool: "figma_create_from_spec", summary: 'figma_create_from_spec spec={frame "Card"} parentId="5:10"', ok: false, error: "FONT_LOAD_FAILED", created: ["6:1"] },
      { seq: 5, at: expect.any(String), tool: "figma_batch", summary: "figma_batch steps=2: set_opacity, rename_node", ok: true, targets: ["5:10", "6:1"] },
    ]);
    // The plugin's half, as it answered.
    expect(d).toMatchObject({ watchedPageId: "0:1", commits: world.commits, changes: world.log.changes, conflicts: world.log.conflicts, pageSwitches: [] });
    expect(world.last("get_changes").params).toEqual({});
  });

  it("since a seq, newest last, `limit` the newest; the plugin asked from that call's time", async () => {
    const { world, bridge, call, data } = await serve();
    for (const name of ["A", "B", "C", "D"]) await call("figma_create_frame", { name });
    const d = data(await call("figma_get_changes", { since: "1", limit: 2 }));
    expect((d.journal as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3, 4]);
    expect(d.omitted).toBe(1);
    expect(world.last("get_changes").params).toEqual({ sinceMs: journalOf(bridge).entry(FILE, 1)!.at });
  });

  it("the journal still answers when the plugin predates get_changes; with no file, the error is the answer", async () => {
    const world = new TrustWorld();
    world.oldPlugin = true;
    const { call, data } = await serve(world);
    await call("figma_create_frame", { name: "Hero" });
    const d = data(await call("figma_get_changes"));
    expect((d.journal as unknown[]).length).toBe(1);
    expect(d.plugin).toMatchObject({ code: "UNSUPPORTED", hint: "Run the plugin again." });

    world.sessions = [];
    const r = await call("figma_get_changes");
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ code: "NO_SESSION", safeToRetry: true });
  });

  it("an unknown savepoint in `since` is INVALID_PARAM", async () => {
    const { call, data } = await serve();
    const r = await call("figma_get_changes", { since: "sp-9" });
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ code: "INVALID_PARAM", message: 'No savepoint "sp-9" in this server process for "Co-op".' });
  });
});

describe("figma_savepoint", () => {
  it("stores the plugin's mark with the journal's position; writes nothing, so the write epoch stands", async () => {
    const { world, call, data } = await serve();
    await call("figma_create_frame", { name: "Before" });
    const epoch = writeEpoch();
    const r = await call("figma_savepoint", { label: "Hero copy from the brief" });
    expect(r.isError).toBeFalsy();
    expect(writeEpoch()).toBe(epoch);
    expect(world.last("savepoint").params).toEqual({});
    const sp = data(r);
    expect(sp).toEqual({ savepointId: "sp-1", label: "Hero copy from the brief", at: new Date(world.clock).toISOString(), pageId: "0:1", journalSeq: 2 });

    await call("figma_create_frame", { name: "After" });
    const d = data(await call("figma_get_changes", { since: "sp-1" }));
    expect((d.journal as Array<{ tool: string }>).map((e) => e.tool)).toEqual(["figma_create_frame"]);
    expect(world.last("get_changes").params).toEqual({ sinceMs: Date.parse(sp.at as string) });
    expect(d.savepoints).toEqual([{ savepointId: "sp-1", label: "Hero copy from the brief", at: sp.at, journalSeq: 2 }]);
    // The savepoint is an entry of its own in the full listing.
    const all = data(await call("figma_get_changes"));
    expect((all.journal as Array<Record<string, unknown>>)[1]).toMatchObject({ tool: "figma_savepoint", savepointId: "sp-1", ok: true });
  });

  it("a retry with the same idempotencyKey answers the same savepoint", async () => {
    const { call, data } = await serve();
    const a = data(await call("figma_savepoint", { label: "Pricing section", idempotencyKey: "sp-pricing" }));
    const b = data(await call("figma_savepoint", { label: "Pricing section", idempotencyKey: "sp-pricing" }));
    expect(b.savepointId).toBe(a.savepointId);
  });

  it("a plugin that answers without its count stores nothing, and says to run it again", async () => {
    const world = new TrustWorld();
    world.savepointAnswer = { ok: true };
    const { bridge, call, data } = await serve(world);
    const r = await call("figma_savepoint", { label: "Hero" });
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ code: "INTERNAL" });
    expect(r.content[0]!.text).toMatch(/close the Figxel plugin window and run it again/);
    expect(journalOf(bridge).savepoints(FILE)).toEqual([]);
    world.oldPlugin = true;
    expect(data(await call("figma_savepoint", { label: "Hero" }))).toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("figma_rollback", () => {
  it("takes back every call since the savepoint: the undo count, the time, the nodes made since; the calls marked", async () => {
    const { world, bridge, call, data } = await serve();
    await call("figma_create_frame", { name: "Kept" });
    const sp = data(await call("figma_savepoint", { label: "Pricing" }));
    const commitsAtSavepoint = world.commits;
    await call("figma_create_frame", { name: "Pricing" });
    await call("figma_set_fills", { nodeIds: ["5:11"], fills: [{ color: "#ffffff" }] });
    await call("figma_set_text", { nodeId: "12:34", content: "x" }); // refused: STALE
    const later = data(await call("figma_savepoint", { label: "Footer" }));
    await call("figma_create_frame", { name: "Footer" });
    const epoch = writeEpoch();

    const r = await call("figma_rollback", { savepointId: sp.savepointId, confirm: true });
    expect(r.isError).toBeFalsy();
    expect(world.last("rollback").params).toEqual({ commits: commitsAtSavepoint, sinceMs: Date.parse(sp.at as string), createdIds: ["5:11", "5:12"] });
    expect(data(r)).toEqual({ savepointId: "sp-1", label: "Pricing", undone: 3, verified: true, stillThere: [], calls: 3 });
    expect(writeEpoch()).toBe(epoch + 1);

    const j = journalOf(bridge).since(FILE);
    expect(j.map((e) => [e.tool, e.rolledBack])).toEqual([
      ["figma_create_frame", false],
      ["figma_savepoint", false],
      ["figma_create_frame", true],
      ["figma_set_fills", true],
      ["figma_set_text", false],
      ["figma_savepoint", false],
      ["figma_create_frame", true],
      ["figma_rollback", false],
    ]);
    expect(j.at(-1)).toMatchObject({ ok: true, summary: 'figma_rollback sp-1 "Pricing"' });
    // The later savepoint marked a state that no longer exists.
    const gone = await call("figma_rollback", { savepointId: later.savepointId, confirm: true });
    expect(data(gone)).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(gone.content[0]!.text).toMatch(/This file's savepoints: sp-1 "Pricing"/);
  });

  it("refused by the plugin: ROLLBACK_BLOCKED passes through with its hint and the safe part; nothing is marked", async () => {
    const world = new TrustWorld();
    const { bridge, call, data } = await serve(world);
    const sp = data(await call("figma_savepoint", { label: "Hero" }));
    await call("figma_create_frame", { name: "Hero" });
    world.blocked = true;
    const r = await call("figma_rollback", { savepointId: sp.savepointId, confirm: true });
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({
      code: "ROLLBACK_BLOCKED",
      safeToRetry: true,
      partial: { created: [], changed: [{ nodeId: "12:34", by: "person" }], safe: ["5:10"] },
    });
    expect(r.content[0]!.text).toMatch(/figma_delete_nodes \{ nodeIds: \["5:10"\] \}/);
    const j = journalOf(bridge).since(FILE);
    expect(j.some((e) => e.rolledBack)).toBe(false);
    expect(j.at(-1)).toMatchObject({ tool: "figma_rollback", ok: false, error: "ROLLBACK_BLOCKED", unchanged: true });
  });

  it("a plugin run again since the savepoint: refused here before any undo, with the safe part", async () => {
    const world = new TrustWorld();
    const { call, data } = await serve(world);
    const sp = data(await call("figma_savepoint", { label: "Hero" }));
    await call("figma_create_frame", { name: "Hero" });
    world.sessions[0]!.instanceId = "run-2";
    const r = await call("figma_rollback", { savepointId: sp.savepointId, confirm: true });
    expect(data(r)).toMatchObject({ code: "ROLLBACK_BLOCKED", safeToRetry: true, partial: { created: [], safe: ["5:10"] } });
    expect(r.content[0]!.text).toMatch(/run again since savepoint sp-1/);
    expect(world.ops()).not.toContain("rollback");
  });

  it("nodes the check still finds are reported with what to do", async () => {
    const world = new TrustWorld();
    const { call, data } = await serve(world);
    const sp = data(await call("figma_savepoint", { label: "Hero" }));
    await call("figma_create_frame", { name: "Hero" });
    world.stillThere = ["5:10"];
    const d = data(await call("figma_rollback", { savepointId: sp.savepointId, confirm: true }));
    expect(d).toMatchObject({ undone: 1, verified: false, stillThere: ["5:10"] });
    expect(d.hint).toMatch(/still there\. Read them \(figma_get_nodes_info\)/);
  });

  it("needs confirm: true, a known savepoint, and the file it was made in; each refused before anything is sent", async () => {
    const world = new TrustWorld();
    const { call, data } = await serve(world);
    const sp = data(await call("figma_savepoint", { label: "Hero" }));
    const noConfirm = await call("figma_rollback", { savepointId: sp.savepointId, confirm: false });
    expect(data(noConfirm)).toMatchObject({ code: "INVALID_PARAM", message: "`confirm` must be true.", safeToRetry: true });
    expect((await call("figma_rollback", { savepointId: sp.savepointId })).isError).toBe(true);
    const unknown = await call("figma_rollback", { savepointId: "sp-42", confirm: true, idempotencyKey: "rb-1" });
    expect(data(unknown)).toMatchObject({ code: "INVALID_PARAM", idempotencyKey: "rb-1", safeToRetry: true });
    world.sessions = [
      { ...world.sessions[0]!, active: false },
      { sessionId: "s-2", active: true, instanceId: "run-9", editorType: "figma", file: { name: "Other", key: null }, page: null, selection: null },
    ];
    const elsewhere = await call("figma_rollback", { savepointId: sp.savepointId, confirm: true });
    expect(data(elsewhere)).toMatchObject({ code: "INVALID_PARAM", message: 'Savepoint sp-1 was made in "Co-op", not in "Other", where this call goes.' });
    expect(elsewhere.content[0]!.text).toMatch(/Pass session: "Co-op"/);
    expect(world.ops()).not.toContain("rollback");
  });
});

describe("figma_stress_test", () => {
  it("forwards the frame, the cases, keep and the audits; kept copies are journalled as made", async () => {
    const { world, bridge, call, data } = await serve();
    const r = await call("figma_stress_test", { nodeId: "12:345", cases: ["expand", "many"], keep: true, audits: ["a11y", "copy"] });
    expect(r.isError).toBeFalsy();
    expect(world.last("stress_test").params).toEqual({ nodeId: "12:345", cases: ["expand", "many"], keep: true, audits: ["a11y", "copy"] });
    expect(data(r)).toMatchObject({ baseline: { ok: true }, cases: [{ case: "expand", ok: false }], kept: ["9:1", "9:2"] });
    expect(journalOf(bridge).since(FILE).at(-1)).toMatchObject({ tool: "figma_stress_test", created: ["9:1", "9:2"], targets: ["12:345"] });
    expect((await call("figma_stress_test", { nodeId: "12:345", cases: ["rtl"] })).isError).toBe(true);
    expect((await call("figma_stress_test", { nodeId: "12:345", audits: ["nope"] })).isError).toBe(true);
  });

  it("takes the cases of spec §3 and exactly figma_check_layout's audit names", async () => {
    const { client } = await serve();
    const { tools } = await client.listTools();
    const items = (t: string, key: string) => (tools.find((x) => x.name === t)!.inputSchema as { properties: Record<string, { items: { enum: string[] } }> }).properties[key]!.items.enum;
    expect(items("figma_stress_test", "cases")).toEqual([...STRESS_CASES]);
    expect(items("figma_stress_test", "audits")).toEqual(items("figma_check_layout", "audit"));
    expect([...STRESS_AUDITS]).toEqual(items("figma_check_layout", "audit"));
  });
});

describe("registration", () => {
  it("the four tools, in their groups, with the annotations their nature calls for", async () => {
    const { client } = await serve();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(OPS.get("get_changes")).toMatchObject({ group: "read", readOnly: true, write: false });
    for (const op of ["savepoint", "rollback", "stress_test"]) expect(OPS.get(op), op).toMatchObject({ group: "style", write: true, readOnly: false });
    expect(byName.get("figma_get_changes")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("figma_savepoint")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("figma_rollback")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("figma_stress_test")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const name of ["figma_get_changes", "figma_savepoint", "figma_rollback", "figma_stress_test"]) {
      const d = byName.get(name)!.description!;
      expect(d.length, name).toBeLessThanOrEqual(1024);
      expect(d.endsWith(editorsSuffix(opName(name))), name).toBe(true);
      expect(editorsSuffix(opName(name))).toBe(" Editors: Design; unverified: FigJam, Slides.");
    }
    expect(byName.get("figma_rollback")!.description).toMatch(/Requires `confirm: true`\./);
  });

  it("a batch takes none of the trust writes as a step", async () => {
    const { world, call } = await serve();
    for (const [op, why] of [["savepoint", "runs on its own call"], ["stress_test", "runs on its own call"], ["rollback", "is destructive"]] as const) {
      const r = await call("figma_batch", { steps: JSON.stringify([{ op, params: {} }]) });
      expect(r.isError, op).toBe(true);
      expect(r.content[0]!.text, op).toContain(`\`steps[0].op\`: "${op}" ${why}`);
    }
    expect(world.ops()).not.toContain("batch");
  });

  it("figma_status shows the conflicts mode", async () => {
    // A real bridge, no plugin needed: figma_status is answered by the bridge itself.
    const bridge = await startBridge();
    cleanup.push(() => bridge.close());
    const server = new McpServer({ name: "trust-status", version: "0" });
    registerTools(server, bridge, loadConfig({ BRIDGE_HOME: home(), BRIDGE_PORT: "0", BRIDGE_CONFLICTS: "warn" }), Date.now(), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "trust-status", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanup.push(() => client.close());
    const st = ((await client.callTool({ name: "figma_status", arguments: {} })) as Result).structuredContent!;
    expect((st.bridge as Record<string, unknown>).conflicts).toBe("warn");
  });
});
