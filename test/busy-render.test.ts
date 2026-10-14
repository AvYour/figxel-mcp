// A video render holds the plugin for minutes, and Figma cannot stop it once
// begun [C-197] [C-198]. On 2026-10-13 three reads queued behind a render a
// proxy had asked for, said nothing for 60 s, and were cut by the MCP client's
// timeout; the client then restarted the hub's process ("shutting down (stdin
// closed)"), which took the shared Figma connection, and the render, with it.
// The cancel itself was harmless, and is pinned here too. What changed: a call
// that would wait behind a render now answers BUSY at once and is never sent.
//
// The hub is the whole app behind a real MCP client; the plugin is a raw
// socket that runs one op at a time, as src/plugin/code.ts does, and holds the
// ops a test names until the test releases them.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BridgeError } from "../src/shared/errors.js";
import { renderBusyError, type Bridge } from "../src/server/bridge.js";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { createApp, type App } from "../src/server/mcp.js";
import { newToken, quietLogger, sleep, startBridge } from "./helpers.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Frame = { t: string; id?: string; op?: string; idempotencyKey?: string; [k: string]: unknown };
type Answer = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

const VIDEO = { nodeId: "1:2", exportedNodeId: "1:2", name: "Hero", format: "MP4", mime: "video/mp4", bytes: 4, base64: "dmlkIQ==" };

/**
 * A plugin that runs one request at a time. Ops in `hold` wait for release();
 * the rest answer at once — once the plugin is free. `answer: false` answers nothing.
 */
async function fakePlugin(port: number, token: string, { hold = ["export_video"], answer = true }: { hold?: string[]; answer?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Frame[] = [];
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  const queue: Frame[] = [];
  let running: Frame | null = null;
  const finish = (req: Frame) => {
    const data = req.op === "export_video" ? VIDEO : { op: req.op, ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}) };
    send({ t: "result", id: req.id, ok: true, data });
    running = null;
    drain();
  };
  const drain = () => {
    if (running || !answer) return;
    const req = queue.shift();
    if (!req) return;
    running = req;
    if (hold.includes(req.op!)) {
      send({ t: "progress", id: req.id, done: 0, phase: `running ${req.op}` });
      return;
    }
    finish(req);
  };
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () =>
      send({
        t: "hello", protocolVersion: 1, token, instanceId: `busy-${Math.random()}`, pluginVersion: "0", apiVersion: "1.0.0", editorType: "figma",
        ops: ["export_video", "get_pages", "get_selection", "get_styles", "create_frame"], file: { name: "Busy", key: null }, page: null, user: null,
      }),
    );
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      received.push(msg);
      if (msg.t === "welcome") return resolve();
      if (msg.t === "ping") return send({ t: "pong", at: Date.now() });
      if (msg.t === "request") {
        queue.push(msg);
        drain();
      }
      // A cancel does not stop a held op: Figma finishes a render it has begun.
    });
  });
  cleanup.push(() => ws.terminate());
  return {
    received,
    requests: () => received.filter((m) => m.t === "request").map((m) => m.op),
    cancels: () => received.filter((m) => m.t === "cancel"),
    running: () => running?.op,
    /** Figma finishes the op it is running. */
    release() {
      finish(running!);
    },
  };
}

async function hubWithClient(): Promise<{ app: App; client: Client; token: string }> {
  const home = mkdtempSync(join(tmpdir(), "fmcp-busy-"));
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "0" });
  const token = readOrCreateToken(config.tokenPath);
  const app = await createApp(config, token, quietLogger);
  cleanup.push(() => app.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "busy-test", version: "0" });
  await Promise.all([app.server.connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  return { app, client, token };
}

async function hubAlone() {
  const token = newToken();
  const hub = await startBridge({ token });
  cleanup.push(() => hub.close());
  return { hub, token };
}

/** A process-level failure — what would end a real server: an unhandled rejection or an uncaught throw. */
function watchProcess(): unknown[] {
  const failures: unknown[] = [];
  const onFailure = (e: unknown) => failures.push(e);
  process.on("unhandledRejection", onFailure);
  process.on("uncaughtException", onFailure);
  cleanup.push(() => {
    process.off("unhandledRejection", onFailure);
    process.off("uncaughtException", onFailure);
  });
  return failures;
}

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a rejection");
}

/** The hub's own queue for its one session (bridge.ts Session.queue). */
const queueOf = (bridge: Bridge) => (bridge as unknown as { registry: { list(): Array<{ queue: unknown[] }> } }).registry.list()[0]!.queue;

const READS = ["figma_get_pages", "figma_get_selection", "figma_get_styles"];

describe("calls behind a video render answer BUSY at once (2026-10-13)", () => {
  it("three reads behind a proxy's render answer BUSY well inside the client's timeout, the render completes, and the hub stays", async () => {
    const failures = watchProcess();
    const { app, client, token } = await hubWithClient();
    const plugin = await fakePlugin(app.bridge.port, token);
    const proxy = await startBridge({ token, port: app.bridge.port });
    cleanup.push(() => proxy.close());
    expect(proxy.role).toBe("proxy");

    const render = proxy.request("export_video", { nodeId: "1:2", format: "MP4" }, { idleTimeoutMs: 60_000, jobId: "hero-r1" });
    await vi.waitFor(() => expect(plugin.running()).toBe("export_video"));

    // The client's own limit, as the 60 s one that cut these calls live [C-197]: on the old code each one waits it out.
    const started = Date.now();
    const answers = (await Promise.all(READS.map((name) => client.callTool({ name, arguments: {} }, undefined, { timeout: 2_000 })))) as Answer[];
    expect(Date.now() - started).toBeLessThan(1_000);
    for (const a of answers) {
      expect(a.isError).toBe(true);
      expect(a.structuredContent).toMatchObject({ code: "BUSY", safeToRetry: true });
      expect(a.structuredContent!.message).toMatch(/^Figma is busy with a video render \(figma_export_video job "hero-r1"\), \d+ s so far; this call was not sent to Figma\.$/);
      expect(a.structuredContent!.hint).toMatch(/Nothing changed, so a retry is safe: call again once the render ends\./);
      expect(a.structuredContent!.hint).toMatch(/figma_export_video \{ jobId: "hero-r1" \}/);
    }

    plugin.release();
    expect(await render).toMatchObject({ format: "MP4", base64: VIDEO.base64 });
    // Nothing but the render ever reached Figma, and the hub serves the next call.
    expect(plugin.requests()).toEqual(["export_video"]);
    const after = (await client.callTool({ name: "figma_get_pages", arguments: {} })) as Answer;
    expect(after.isError).toBeFalsy();
    expect(app.bridge.role).toBe("hub");
    expect(failures).toEqual([]);
  });

  it("a write behind a render keeps its key unused: BUSY carries it, and the same key runs once the render ends", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token);
    const render = hub.request("export_video", { nodeId: "1:2" }, { idleTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(plugin.running()).toBe("export_video"));

    const err = await rejection(hub.request("create_frame", { name: "Hero" }, { idempotencyKey: "hero-v1" }));
    expect(err).toMatchObject({ code: "BUSY", idempotencyKey: "hero-v1" });
    expect(err.message).toMatch(/^Figma is busy with a video render, \d+ s so far; this call was not sent to Figma\.$/);
    expect(err.hint).toMatch(/a retry is safe with the same idempotencyKey \(hero-v1\)/);
    expect(err.hint).toMatch(/Do not start another export meanwhile\./);

    plugin.release();
    await render;
    expect(await hub.request("create_frame", { name: "Hero" }, { idempotencyKey: "hero-v1" })).toMatchObject({ op: "create_frame", idempotencyKey: "hero-v1" });
    expect(plugin.requests()).toEqual(["export_video", "create_frame"]);
  });

  it("a second render is refused too, not queued for minutes", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token);
    const first = hub.request("export_video", { nodeId: "1:2" }, { idleTimeoutMs: 60_000, jobId: "a" });
    await vi.waitFor(() => expect(plugin.running()).toBe("export_video"));
    const err = await rejection(hub.request("export_video", { nodeId: "1:3" }, { idleTimeoutMs: 60_000, jobId: "b" }));
    expect(err.code).toBe("BUSY");
    expect(err.message).toMatch(/job "a"/);
    plugin.release();
    await first;
    expect(plugin.requests()).toEqual(["export_video"]);
  });

  it("a render the bridge stopped waiting for still holds the plugin: calls answer BUSY until Figma answers it", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token);
    const ac = new AbortController();
    const render = rejection(hub.request("export_video", { nodeId: "1:2" }, { idleTimeoutMs: 60_000, jobId: "dropped", signal: ac.signal }));
    await vi.waitFor(() => expect(plugin.running()).toBe("export_video"));
    ac.abort(); // figma_export_video { jobId, cancel: true }: Figma renders on
    expect((await render).code).toBe("CANCELLED");
    await vi.waitFor(() => expect(plugin.cancels()).toHaveLength(1));

    // On the old code this read went to a plugin still rendering, and waited there until it STALLED.
    const err = await rejection(hub.request("get_pages", {}, { idleTimeoutMs: 300 }));
    expect(err.code).toBe("BUSY");
    expect(err.message).toMatch(/^Figma is still finishing a video render \(figma_export_video job "dropped"\) that was cancelled, \d+ s after it began: Figma cannot stop a render it has begun\. This call was not sent to Figma\.$/);

    plugin.release(); // the plugin answers the render nobody waits for
    await sleep(50);
    expect(await hub.request("get_pages", {})).toEqual({ op: "get_pages" });
    expect(plugin.requests()).toEqual(["export_video", "get_pages"]);
  });

  it("a render waiting in the queue counts: a call that would queue behind it answers BUSY", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token, { hold: ["get_styles", "export_video"] });
    const styles = hub.request("get_styles", {}, { idleTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(plugin.running()).toBe("get_styles"));
    const render = hub.request("export_video", { nodeId: "1:2" }, { idleTimeoutMs: 60_000, jobId: "next" });
    await sleep(20);

    const err = await rejection(hub.request("get_pages", {}));
    expect(err.code).toBe("BUSY");
    expect(err.message).toBe('Figma is about to start a video render (figma_export_video job "next"); this call was not sent to Figma.');

    plugin.release();
    await styles;
    await vi.waitFor(() => expect(plugin.running()).toBe("export_video"));
    plugin.release();
    await render;
    expect(plugin.requests()).toEqual(["get_styles", "export_video"]);
  });

  it("the BUSY hint names a minimized window once a render passes 2 min [C-198]", () => {
    const slow = renderBusyError({ jobId: undefined, elapsedMs: 121_000, cancelled: false }, undefined);
    expect(slow.message).toMatch(/121 s so far/);
    expect(slow.hint).toMatch(/minimized Figma window stops video export/);
    expect(renderBusyError({ jobId: undefined, elapsedMs: 30_000, cancelled: false }, undefined).hint).not.toMatch(/minimized/);
  });
});

describe("the queue around a long op", () => {
  it("cancelling three queued reads neither crashes the hub nor touches the op in flight, and drops them from the queue", async () => {
    // The suspected cause of the 2026-10-13 exit, ruled out: the hub logged a clean
    // "shutting down (stdin closed)". A long op that is not a render still queues calls.
    const failures = watchProcess();
    const { app, client, token } = await hubWithClient();
    const plugin = await fakePlugin(app.bridge.port, token, { hold: ["create_frame"] });
    const proxy = await startBridge({ token, port: app.bridge.port });
    cleanup.push(() => proxy.close());
    const long = proxy.request("create_frame", { name: "Long" }, { idleTimeoutMs: 60_000, idempotencyKey: "long-1" });
    await vi.waitFor(() => expect(plugin.running()).toBe("create_frame"));

    // The client gives up on each and sends notifications/cancelled.
    const reads = READS.map((name) => client.callTool({ name, arguments: {} }, undefined, { timeout: 300 }));
    for (const r of reads) await expect(r).rejects.toThrow(/timed out/i);
    await sleep(50);
    expect(queueOf(app.bridge)).toHaveLength(0);

    plugin.release();
    expect(await long).toMatchObject({ op: "create_frame", idempotencyKey: "long-1" });
    await sleep(50);
    expect(plugin.requests()).toEqual(["create_frame"]);
    expect(((await client.callTool({ name: "figma_get_pages", arguments: {} })) as Answer).isError).toBeFalsy();
    expect(failures).toEqual([]);
  });

  it("a call waiting in the bridge's queue never STALLs: its idle timer starts when the plugin is sent it", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token, { hold: ["create_frame"] });
    const long = hub.request("create_frame", {}, { idleTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(plugin.running()).toBe("create_frame"));
    let settled = false;
    const queued = hub.request("get_pages", {}, { idleTimeoutMs: 200 }).finally(() => (settled = true));
    await sleep(600); // three idle windows in the queue
    expect(settled).toBe(false);
    plugin.release();
    await long;
    expect(await queued).toEqual({ op: "get_pages" });
  });

  it("a STALLED on a plugin that has answered nothing since it connected says it may be busy with an earlier process's op", async () => {
    const { hub, token } = await hubAlone();
    await fakePlugin(hub.port, token, { answer: false });
    const err = await rejection(hub.request("get_pages", {}, { idleTimeoutMs: 200 }));
    expect(err.code).toBe("STALLED");
    expect(err.hint).toMatch(/^The plugin has answered nothing since it connected \d+ s ago, so it may still be finishing an op an earlier Figxel process sent it/);
    expect(err.hint).toMatch(/then call the tool again\. It changes no design data, so a retry is safe\.$/);
  });

  it("once the plugin has answered, a STALLED hint goes back to the frozen-window advice alone", async () => {
    const { hub, token } = await hubAlone();
    const plugin = await fakePlugin(hub.port, token, { hold: ["get_styles"] });
    expect(await hub.request("get_pages", {})).toEqual({ op: "get_pages" });
    const err = await rejection(hub.request("get_styles", {}, { idleTimeoutMs: 200 }));
    expect(err.code).toBe("STALLED");
    expect(err.hint).toMatch(/^Check whether Figma is frozen/);
    plugin.release();
  });
});
