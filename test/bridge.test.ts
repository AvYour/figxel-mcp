import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BridgeError } from "../src/shared/errors.js";
import { CLOSE, DEFAULT_LIMITS } from "../src/shared/protocol.js";
import { NO_SESSION_HINT, TOKEN_HINT, tokenHint, type Bridge } from "../src/server/bridge.js";
import { Base64Sink, bytesOf } from "../src/server/binary.js";
import { connectedMock, newToken, sleep, startBridge, startMock, type MockPlugin } from "./helpers.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(bridgeOpts: Parameters<typeof startBridge>[0] = {}, mockOpts: Parameters<typeof connectedMock>[2] = {}) {
  const token = newToken();
  const bridge = await startBridge({ token, ...bridgeOpts });
  cleanup.push(() => bridge.close());
  const mock = await connectedMock(bridge, token, mockOpts);
  cleanup.push(() => mock.close());
  return { token, bridge, mock };
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

function rawClient(port: number, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; close: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const close = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("open", () => resolve({ ws, close }));
    ws.on("error", reject);
  });
}

function hello(token: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    t: "hello", protocolVersion: 1, token, instanceId: "raw-1", pluginVersion: "0", apiVersion: "1.0.0",
    editorType: "figma", ops: ["get_metadata"], file: { name: "Raw", key: null }, page: null, user: null, ...extra,
  });
}

const requestsSeen = (mock: MockPlugin) => mock.received.filter((m) => m.t === "request");

describe("handshake (protocol.md §1)", () => {
  it("welcomes a valid plugin and reports the session", async () => {
    const { bridge, mock } = await setup();
    const welcome = mock.received.find((m) => m.t === "welcome") as unknown as { limits: unknown; protocolVersion: number };
    expect(welcome.protocolVersion).toBe(1);
    expect(welcome.limits).toEqual(DEFAULT_LIMITS);
    const st = bridge.status();
    expect(st.listening).toBe(true);
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0]!.file.name).toBe("Mock File");
    expect(st.sessions[0]!.active).toBe(true);
    expect(st.sessions[0]!.page).toEqual({ id: "0:1", name: "Page 1" });
  });

  it("accepts the mock's missing Origin and the iframe's null Origin", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const { ws } = await rawClient(bridge.port, { Origin: "null" });
    cleanup.push(() => ws.close());
    const welcome = new Promise<string>((r) => ws.once("message", (d) => r(String(d))));
    ws.send(hello(token));
    expect(JSON.parse(await welcome).t).toBe("welcome");
  });

  it("closes a web-page origin with 4003", async () => {
    const bridge = await startBridge();
    cleanup.push(() => bridge.close());
    const { close } = await rawClient(bridge.port, { Origin: "https://any-site.example" });
    expect(await close).toBe(CLOSE.FORBIDDEN_ORIGIN);
  });

  it("closes a wrong token with 4001 and turns the NO_SESSION hint into a token hint", async () => {
    const bridge = await startBridge({ token: newToken() });
    cleanup.push(() => bridge.close());
    const mock = startMock({ token: newToken(), port: bridge.port });
    cleanup.push(() => mock.close());
    expect((await mock.closed()).code).toBe(CLOSE.AUTH_FAILED);
    expect(bridge.status().lastAuthFailureAt).not.toBeNull();
    const err = await rejection(bridge.request("get_metadata", {}));
    expect(err.code).toBe("NO_SESSION");
    expect(err.hint).toBe(tokenHint(bridge.tokenWhere));
    expect(err.hint!.startsWith(TOKEN_HINT)).toBe(true);
  });

  it("closes a silent connection with 4008", async () => {
    const bridge = await startBridge({ helloTimeoutMs: 100 });
    cleanup.push(() => bridge.close());
    const { close } = await rawClient(bridge.port);
    expect(await close).toBe(CLOSE.HELLO_TIMEOUT);
  });

  it("closes a second hello with 4002", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const { ws, close } = await rawClient(bridge.port);
    ws.send(hello(token));
    ws.send(hello(token));
    expect(await close).toBe(CLOSE.DUPLICATE_HELLO);
  });

  it("closes an unsupported protocolVersion with 4005", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const mock = startMock({ token, port: bridge.port, protocolVersion: 2 });
    cleanup.push(() => mock.close());
    expect((await mock.closed()).code).toBe(CLOSE.PROTOCOL_MISMATCH);
  });

  it("replaces a session from the same instanceId with 4004 — no ghost sessions", async () => {
    const { token, bridge, mock } = await setup();
    const oldClosed = mock.closed();
    const twin = await connectedMock(bridge, token, { instanceId: mock.instanceId });
    cleanup.push(() => twin.close());
    expect((await oldClosed).code).toBe(CLOSE.SESSION_REPLACED);
    expect(bridge.status().sessions).toHaveLength(1);
    expect(bridge.status().sessions[0]!.sessionId).toBe(twin.state.sessionId);
  });
});

describe("requests (protocol.md §3–§4)", () => {
  it("forwards a read op without an idempotencyKey", async () => {
    const { bridge, mock } = await setup();
    const data = (await bridge.request("get_metadata", {})) as { name: string };
    expect(data.name).toBe("Mock File");
    expect(requestsSeen(mock)[0]).not.toHaveProperty("idempotencyKey");
    // Unique across processes: a random prefix per bridge, then a counter (the 2026-10-14 audit's probe p2).
    expect(requestsSeen(mock)[0]!.id).toMatch(/^r-[0-9a-f]{8}-\d+$/);
  });

  it("gives every write op an idempotencyKey and returns it", async () => {
    const { bridge, mock } = await setup();
    const generated = (await bridge.request("create_frame", { name: "A" })) as { idempotencyKey: string };
    expect(generated.idempotencyKey).toMatch(/^k-[0-9a-f-]{36}$/);
    const own = (await bridge.request("create_frame", { name: "B" }, { idempotencyKey: "hero-v1" })) as {
      idempotencyKey: string;
    };
    expect(own.idempotencyKey).toBe("hero-v1");
    expect(requestsSeen(mock).map((r) => r.idempotencyKey)).toEqual([generated.idempotencyKey, "hero-v1"]);
  });

  it("answers UNSUPPORTED for an op the plugin did not advertise", async () => {
    const { bridge } = await setup();
    const err = await rejection(bridge.request("get_styles", {}));
    expect(err.code).toBe("UNSUPPORTED");
    // Steps someone who installed the package can take, never "rebuild".
    expect(err.hint).toMatch(/close the Figxel plugin window and run it again \(Plugins → Development → Figxel\)/);
    expect(err.hint).toContain("npx -y figxel-mcp@latest setup");
    expect(err.hint).not.toMatch(/rebuild|dist\//);
  });

  it("waits for a reconnecting plugin up to sessionWaitMs", async () => {
    const token = newToken();
    const bridge = await startBridge({ token, sessionWaitMs: 3000 });
    cleanup.push(() => bridge.close());
    const pending = bridge.request("get_metadata", {});
    await sleep(300);
    const mock = startMock({ token, port: bridge.port });
    cleanup.push(() => mock.close());
    expect(((await pending) as { name: string }).name).toBe("Mock File");
  });

  it("answers NO_SESSION with the open-the-plugin hint when nothing connects", async () => {
    const bridge = await startBridge({ sessionWaitMs: 100 });
    cleanup.push(() => bridge.close());
    const err = await rejection(bridge.request("create_frame", {}, { idempotencyKey: "x" }));
    expect(err.code).toBe("NO_SESSION");
    expect(err.hint).toBe(NO_SESSION_HINT);
    expect(err.idempotencyKey).toBe("x");
  });

  it("picks a session by file name or sessionId", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const a = await connectedMock(bridge, token, { fileName: "Alpha" });
    const b = await connectedMock(bridge, token, { fileName: "Beta" });
    cleanup.push(() => a.close(), () => b.close());
    expect(((await bridge.request("get_metadata", {}, { session: "alpha" })) as { name: string }).name).toBe("Alpha");
    expect(((await bridge.request("get_metadata", {}, { session: b.state.sessionId! })) as { name: string }).name).toBe("Beta");
    const err = await rejection(bridge.request("get_metadata", {}, { session: "Gamma" }));
    expect(err.message).toMatch(/No connected Figma session matches "Gamma"/);
  });
});

describe("timeouts are idle-based (protocol.md §4)", () => {
  it("STALLs a silent op, sends cancel{STALLED}, and keeps the key", async () => {
    const { bridge, mock } = await setup({}, { scenario: "stall" });
    const started = Date.now();
    const err = await rejection(
      bridge.request("create_frame", {}, { idleTimeoutMs: 200, idempotencyKey: "stall-1" }),
    );
    expect(err.code).toBe("STALLED");
    expect(err.idempotencyKey).toBe("stall-1");
    expect(err.hint).toMatch(/retry with the same idempotencyKey \(stall-1\)/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    await sleep(20);
    expect(mock.received.find((m) => m.t === "cancel")).toMatchObject({ reason: "STALLED" });
  });

  // 2026-10-13 acceptance run: figma_suggest_fonts STALLED and was told to
  // "retry with the same idempotencyKey" — a read, which has none.
  it("tells a stalled read to call again, and names no idempotencyKey it does not have", async () => {
    const { bridge } = await setup({}, { scenario: "stall" });
    const err = await rejection(bridge.request("get_metadata", {}, { idleTimeoutMs: 200 }));
    expect(err.code).toBe("STALLED");
    expect(err.idempotencyKey).toBeUndefined();
    expect(err.hint).not.toMatch(/idempotencyKey/);
    expect(err.hint).toMatch(/call the tool again\. It changes no design data, so a retry is safe/);
  });

  it("lets an op run far past the idle timeout while progress flows (test e, in miniature)", async () => {
    const { bridge } = await setup({}, { scenario: "slow", durationMs: 900, progressMs: 100 });
    const seen: number[] = [];
    const started = Date.now();
    const data = await bridge.request("create_frame", { name: "Long" }, {
      idleTimeoutMs: 300,
      onProgress: (p) => seen.push(p.done),
    });
    expect(Date.now() - started).toBeGreaterThan(800);
    expect((data as { name: string }).name).toBe("Long");
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
  });

  it("drops a session whose plugin stops answering pings, failing pending work with NO_SESSION", async () => {
    const token = newToken();
    const bridge = await startBridge({ token, limits: { heartbeatMs: 100 } });
    cleanup.push(() => bridge.close());
    const { ws } = await rawClient(bridge.port);
    cleanup.push(() => ws.terminate());
    const welcomed = new Promise((r) => ws.once("message", r));
    ws.send(hello(token));
    await welcomed;
    const err = await rejection(bridge.request("get_metadata", {}, { idleTimeoutMs: 10_000 }));
    expect(err.code).toBe("NO_SESSION");
    expect(bridge.status().sessions).toHaveLength(0);
  });
});

describe("back-pressure (protocol.md §4)", () => {
  it("rejects with BUSY only once the queue is full, and sends one request at a time", async () => {
    const { bridge, mock } = await setup({ limits: { maxQueueDepth: 2 } }, { scenario: "stall" });
    const opts = { idleTimeoutMs: 60_000 };
    const inFlight = [bridge.request("get_metadata", {}, opts), bridge.request("get_metadata", {}, opts), bridge.request("get_metadata", {}, opts)];
    for (const p of inFlight) p.catch(() => {});
    const err = await rejection(bridge.request("get_metadata", {}, opts));
    expect(err.code).toBe("BUSY");
    await sleep(50);
    expect(requestsSeen(mock)).toHaveLength(1); // sequential per session
  });
});

describe("binary payloads (protocol.md §2 chunk)", () => {
  it("reassembles a chunked result: an export op's bytes as a Buffer, never one long base64 string", async () => {
    const { bridge, mock } = await setup({ limits: { chunkBytes: 1000 } });
    const data = (await bridge.request("export_node", { fakeBytes: 5000 })) as { binary: Buffer; bytes: number; chunks?: number };
    expect(data.bytes).toBe(5000);
    expect(Buffer.isBuffer(data.binary)).toBe(true);
    expect(data.binary).toEqual(Buffer.alloc(5000, 7));
    expect(bytesOf(data)).toEqual(Buffer.alloc(5000, 7));
    expect(data).not.toHaveProperty("base64");
    expect(data).not.toHaveProperty("chunks");
    expect(mock.received.filter((m) => m.t === "request")).toHaveLength(1);
  });

  it("decodes chunks that split a base64 quantum", () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    const b64 = bytes.toString("base64");
    const sink = new Base64Sink();
    for (let i = 0; i < b64.length; i += 7) sink.push(b64.slice(i, i + 7)); // 7 is not a multiple of 4
    expect(sink.finish()).toEqual(bytes);
  });
});

describe("idempotency (protocol.md §3)", () => {
  it("attaches a second call with an in-flight key instead of sending a new frame", async () => {
    const { bridge, mock } = await setup({}, { scenario: "slow", durationMs: 300, progressMs: 100 });
    const [a, b] = await Promise.all([
      bridge.request("create_frame", { name: "Once" }, { idempotencyKey: "same" }),
      bridge.request("create_frame", { name: "Once" }, { idempotencyKey: "same" }),
    ]);
    expect(a).toEqual(b);
    expect(requestsSeen(mock)).toHaveLength(1);
  });

  it("refuses an in-flight key reused for another op", async () => {
    const { bridge } = await setup({}, { scenario: "slow", durationMs: 300, progressMs: 100 });
    const first = bridge.request("create_frame", {}, { idempotencyKey: "k1" });
    const err = await rejection(bridge.request("set_text", {}, { idempotencyKey: "k1" }));
    expect(err.code).toBe("INVALID_PARAM");
    expect(err.message).toMatch(/already used for op `create_frame`/);
    await first;
  });

  it("survives a mid-op disconnect: NO_SESSION carries the key, the retry is replayed, nothing runs twice (test g, in miniature)", async () => {
    const { bridge, mock } = await setup(
      { sessionWaitMs: 3000 },
      { scenario: "drop", durationMs: 400, progressMs: 100, reconnectDelayMs: 100 },
    );
    const err = await rejection(bridge.request("create_frame", { name: "Hero" }, { idempotencyKey: "landing-v1" }));
    expect(err.code).toBe("NO_SESSION");
    expect(err.idempotencyKey).toBe("landing-v1");
    await sleep(600); // the op finishes inside the "sandbox" while disconnected
    const retry = (await bridge.request("create_frame", { name: "Hero" }, { idempotencyKey: "landing-v1" })) as {
      replayed?: boolean;
      id: string;
    };
    expect(retry.replayed).toBe(true);
    expect(retry.id).toBe("1:1"); // the first and only node the mock created
  });

  it("B-2: the job in flight when the plugin closes is marked dispatched; a queued one is not", async () => {
    const { bridge, mock } = await setup({}, { scenario: "stall" });
    const opts = { idleTimeoutMs: 60_000 };
    const sent = rejection(bridge.request("create_frame", { name: "Sent" }, { ...opts, idempotencyKey: "sent-1" }));
    const queued = rejection(bridge.request("create_frame", { name: "Queued" }, { ...opts, idempotencyKey: "queued-1" }));
    await sleep(50);
    expect(requestsSeen(mock)).toHaveLength(1); // only the first reached the plugin
    mock.close();
    const [inFlight, waiting] = await Promise.all([sent, queued]);
    expect(inFlight).toMatchObject({ code: "NO_SESSION", idempotencyKey: "sent-1", partial: { dispatched: true } });
    expect(inFlight.hint).toMatch(/Inspect the canvas/);
    expect(waiting).toMatchObject({ code: "NO_SESSION", idempotencyKey: "queued-1" });
    expect(waiting.partial).toBeUndefined();
  });
});

describe("cancellation & shutdown", () => {
  it("forwards a client cancel as cancel{CLIENT_CANCELLED}", async () => {
    const { bridge, mock } = await setup({}, { scenario: "slow", durationMs: 2000, progressMs: 100 });
    const ac = new AbortController();
    const p = bridge.request("create_frame", {}, { signal: ac.signal, idempotencyKey: "c1" });
    await sleep(150);
    ac.abort();
    const err = await rejection(p);
    expect(err.code).toBe("CANCELLED");
    expect(err.idempotencyKey).toBe("c1");
    await sleep(30);
    expect(mock.received.find((m) => m.t === "cancel")).toMatchObject({ reason: "CLIENT_CANCELLED" });
  });

  it("closes plugins with 4010 on shutdown", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    const mock = await connectedMock(bridge, token);
    cleanup.push(() => mock.close());
    const closed = mock.closed();
    await bridge.close();
    expect((await closed).code).toBe(CLOSE.SERVER_SHUTDOWN);
  });
});

describe("port held by something else (spec §4.6)", () => {
  it("stays alive, reports PORT_IN_USE, and takes over when the port frees up", async () => {
    // A foreign process: accepts TCP but never speaks the peer protocol.
    const foreign = createNetServer((s) => {
      s.resume(); // a real server reads its sockets — a non-reading one would never see our client hang up
      s.on("error", () => {});
    });
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
    const port = (foreign.address() as { port: number }).port;
    const bridge: Bridge = await startBridge({ port, listenRetryMs: 100 });
    cleanup.push(() => bridge.close());
    expect(bridge.role).toBe("none");
    expect(bridge.status().reason).toBe("PORT_IN_USE");
    const err = await rejection(bridge.request("get_metadata", {}));
    expect(err.code).toBe("PORT_IN_USE");
    await new Promise<void>((r) => foreign.close(() => r()));
    for (let i = 0; i < 60 && !bridge.isListening; i++) await sleep(100);
    expect(bridge.role).toBe("hub");
    expect(bridge.port).toBe(port);
  }, 15_000);

  it("refuses to share with a hub from another installation (different token)", async () => {
    const hub = await startBridge({ token: newToken() });
    cleanup.push(() => hub.close());
    const stranger = await startBridge({ token: newToken(), port: hub.port, listenRetryMs: 60_000 });
    cleanup.push(() => stranger.close());
    expect(stranger.role).toBe("none");
    expect(stranger.status().reason).toBe("PORT_IN_USE");
  });
});

describe("sharing one Figma connection between MCP clients (hub / proxy)", () => {
  async function hubAndProxy(mockOpts: Parameters<typeof connectedMock>[2] = {}) {
    const token = newToken();
    const hub = await startBridge({ token });
    cleanup.push(() => hub.close());
    const mock = await connectedMock(hub, token, mockOpts);
    cleanup.push(() => mock.close());
    const proxy = await startBridge({ token, port: hub.port });
    cleanup.push(() => proxy.close());
    return { token, hub, proxy, mock };
  }

  it("a second process on the same port becomes a proxy and reaches the plugin through the hub", async () => {
    const { hub, proxy } = await hubAndProxy();
    expect(hub.role).toBe("hub");
    expect(proxy.role).toBe("proxy");
    expect(((await proxy.request("get_metadata", {})) as { name: string }).name).toBe("Mock File");
    const st = await proxy.statusAsync();
    expect(st).toMatchObject({ role: "proxy", hubPid: process.pid, listening: false });
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0]!.file.name).toBe("Mock File");
    expect(hub.status().peers).toBe(1);
  });

  it("forwards progress, write keys, and errors through the proxy", async () => {
    const { proxy } = await hubAndProxy({ scenario: "slow", durationMs: 500, progressMs: 100 });
    const seen: number[] = [];
    const data = (await proxy.request("create_frame", { name: "Via proxy" }, { onProgress: (p) => seen.push(p.done) })) as {
      name: string;
      idempotencyKey: string;
    };
    expect(data.name).toBe("Via proxy");
    expect(data.idempotencyKey).toMatch(/^k-/);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const err = await rejection(proxy.request("get_styles", {}));
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("dedupes the same idempotencyKey across two AI apps — one execution", async () => {
    const { hub, proxy, mock } = await hubAndProxy({ scenario: "slow", durationMs: 300, progressMs: 100 });
    const [a, b] = await Promise.all([
      hub.request("create_frame", { name: "Once" }, { idempotencyKey: "shared-1" }),
      proxy.request("create_frame", { name: "Once" }, { idempotencyKey: "shared-1" }),
    ]);
    expect(a).toEqual(b);
    expect(requestsSeen(mock)).toHaveLength(1);
  });

  it("forwards a client cancel from the proxy to the plugin", async () => {
    const { proxy, mock } = await hubAndProxy({ scenario: "slow", durationMs: 2000, progressMs: 100 });
    const ac = new AbortController();
    const p = proxy.request("create_frame", {}, { signal: ac.signal, idempotencyKey: "c-proxy" });
    await sleep(250);
    ac.abort();
    const err = await rejection(p);
    expect(err.code).toBe("CANCELLED");
    expect(err.idempotencyKey).toBe("c-proxy");
    await sleep(100);
    expect(mock.received.find((m) => m.t === "cancel")).toMatchObject({ reason: "CLIENT_CANCELLED" });
  });

  it("when the hub exits, the proxy takes over the port and the plugin reconnects to it", async () => {
    const { hub, proxy, mock } = await hubAndProxy();
    const port = hub.port;
    const closed = mock.closed();
    await hub.close();
    expect((await closed).code).toBe(CLOSE.SERVER_SHUTDOWN);
    for (let i = 0; i < 60 && proxy.role !== "hub"; i++) await sleep(50);
    expect(proxy.role).toBe("hub");
    expect(proxy.port).toBe(port);
    mock.reconnect(); // the real plugin does this on its own within ≤ 3 s (protocol.md §5)
    await mock.welcomed();
    expect(((await proxy.request("get_metadata", {})) as { name: string }).name).toBe("Mock File");
  });

  it("a call in flight when the hub exits fails with NO_SESSION carrying its key", async () => {
    const { hub, proxy } = await hubAndProxy({ scenario: "slow", durationMs: 2000, progressMs: 100 });
    const failed = rejection(proxy.request("create_frame", {}, { idempotencyKey: "lost-1" }));
    await sleep(200);
    await hub.close();
    const err = await failed;
    expect(err.code).toBe("NO_SESSION");
    expect(err.idempotencyKey).toBe("lost-1");
    // B-2: the hub had the call, so its outcome is unknown — not safe to retry blind.
    expect(err.partial).toEqual({ dispatched: true });
  });
});
