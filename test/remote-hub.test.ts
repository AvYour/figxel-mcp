// BRIDGE_HUB_URL (cloud bridge plan, step 3): a process joins a team's hub by
// its address and never binds the port, so it can never become a second hub;
// it keeps trying while the hub is away, says why a call cannot go through,
// and pings the hub so the proxies on the way do not close the socket as idle.

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { buildStatus } from "../src/server/tools/meta.js";
import type { BridgeError } from "../src/shared/errors.js";
import { connectedMock, newToken, sleep, startBridge } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    return e as BridgeError;
  }
  throw new Error("expected a rejection");
}

async function until(ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

/** A team's hub with Alice's Figma connected, on `port` (0: any). */
async function aliceHub(alice: string, port = 0): Promise<Bridge> {
  const hub = await startBridge({ token: newToken(), port, people: [{ person: "alice", token: alice }] });
  cleanup.push(() => hub.close());
  const figma = await connectedMock(hub, alice, { fileName: "Alice's file" });
  cleanup.push(() => figma.close());
  return hub;
}

/** A free port, closed again: nothing listens on it. */
async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("joining a team's hub by its address (BRIDGE_HUB_URL)", () => {
  it("reaches the person's file through the hub, and never listens itself", async () => {
    const alice = newToken();
    const hub = await aliceHub(alice);
    const laptop = await startBridge({ token: alice, hubUrl: `ws://127.0.0.1:${hub.port}` });
    cleanup.push(() => laptop.close());
    expect(laptop.role).toBe("proxy");
    expect(laptop.status().listening).toBe(false);
    expect(((await laptop.request("get_metadata", {})) as { name: string }).name).toBe("Alice's file");
  });

  it("with no hub there it does not become one: a call says the hub cannot be reached", async () => {
    const port = await freePort();
    const laptop = await startBridge({ token: newToken(), port, hubUrl: `ws://127.0.0.1:${port}` });
    cleanup.push(() => laptop.close());
    await sleep(300);
    expect(laptop.role).toBe("none");
    expect(laptop.status().listening).toBe(false);
    const err = await rejection(laptop.request("get_metadata", {}));
    expect(err.code).toBe("NO_SESSION");
    expect(err.message).toBe(`Cannot reach the team's hub at 127.0.0.1:${port}.`);
  });

  it("joins again on its own once the hub is back", async () => {
    const alice = newToken();
    const first = await aliceHub(alice);
    const port = first.port;
    const laptop = await startBridge({ token: alice, hubUrl: `ws://127.0.0.1:${port}` });
    cleanup.push(() => laptop.close());
    await first.close();
    await until(() => laptop.role === "none");
    await aliceHub(alice, port);
    await until(() => laptop.role === "proxy");
    expect(((await laptop.request("get_metadata", {})) as { name: string }).name).toBe("Alice's file");
  });

  it("a token the hub does not know: the call says it was refused", async () => {
    const hub = await aliceHub(newToken());
    const laptop = await startBridge({ token: newToken(), hubUrl: `ws://127.0.0.1:${hub.port}` });
    cleanup.push(() => laptop.close());
    await until(() => laptop.role === "none");
    const err = await rejection(laptop.request("get_metadata", {}));
    expect(err.message).toBe(`The team's hub at 127.0.0.1:${hub.port} refused this process's token.`);
    expect(err.hint).toMatch(/BRIDGE_TOKEN/);
  });
});

describe("figma_status through a team's hub", () => {
  /** What figma_status returns for a process joined with BRIDGE_HUB_URL and BRIDGE_TOKEN. */
  const statusOf = async (bridge: Bridge, hubUrl: string, token: string) =>
    (await buildStatus({
      bridge,
      config: loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-hub-st-")), BRIDGE_HUB_URL: hubUrl, BRIDGE_TOKEN: token }),
      startedAt: Date.now(),
      selectedTools: [],
      registeredTools: [],
    })) as { hint: string; bridge: Record<string, unknown>; token: Record<string, unknown>; auth: Record<string, unknown> };

  it("names the hub, its host and port, and the token's source; the hub's pid is not told", async () => {
    const alice = newToken();
    const hub = await aliceHub(alice);
    const url = `ws://127.0.0.1:${hub.port}`;
    const laptop = await startBridge({ token: alice, hubUrl: url });
    cleanup.push(() => laptop.close());
    const st = await statusOf(laptop, url, alice);
    expect(st.bridge).toMatchObject({ role: "proxy", host: "127.0.0.1", port: hub.port, hub: `127.0.0.1:${hub.port}`, person: "alice", hubPid: 0 });
    expect(st.hint).toMatch(/^Connected to "Alice's file"[^.]*\. This process works through the team's hub at 127\.0\.0\.1:\d+ as alice:/);
    expect(st.hint).not.toMatch(/process \d+/);
    expect(st.token).toMatchObject({ tokenPath: null, from: "BRIDGE_TOKEN" });
  });

  it("a refused token: the hint names the hub and BRIDGE_TOKEN, not a port or a token file", async () => {
    const hub = await aliceHub(newToken());
    const url = `ws://127.0.0.1:${hub.port}`;
    const stranger = newToken();
    const laptop = await startBridge({ token: stranger, hubUrl: url });
    cleanup.push(() => laptop.close());
    await until(() => laptop.role === "none");
    const st = await statusOf(laptop, url, stranger);
    expect(st.hint).toMatch(/^The team's hub at 127\.0\.0\.1:\d+ refused this process's token\. Set BRIDGE_TOKEN/);
    expect(st.hint).not.toMatch(/Alice|alice/);
  });
});

describe("the ping between a proxy and its hub", () => {
  /** A stand-in hub that welcomes any proxy and counts its pings; `pong: false` leaves them unanswered. */
  async function fakeHub(pong: boolean) {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: pong });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    const seen = { pings: 0, connections: 0 };
    wss.on("connection", (socket) => {
      seen.connections++;
      socket.on("ping", () => seen.pings++);
      socket.on("message", (raw) => {
        if (String(raw).includes('"peer-hello"')) socket.send(JSON.stringify({ t: "peer-welcome", hubPid: 0, serverVersion: "test", features: ["result-chunks"] }));
      });
    });
    return { port: (wss.address() as AddressInfo).port, seen };
  }

  it("pings the hub while idle", async () => {
    const hub = await fakeHub(true);
    const laptop = await startBridge({ token: newToken(), hubUrl: `ws://127.0.0.1:${hub.port}`, peerPingMs: 40 });
    cleanup.push(() => laptop.close());
    expect(laptop.role).toBe("proxy");
    await until(() => hub.seen.pings >= 3, 2000);
  });

  it("lets go of a hub that stops answering, and tries again", async () => {
    const hub = await fakeHub(false);
    const laptop = await startBridge({ token: newToken(), hubUrl: `ws://127.0.0.1:${hub.port}`, peerPingMs: 40 });
    cleanup.push(() => laptop.close());
    expect(laptop.role).toBe("proxy");
    // Let go after 2.5 silent pings (100 ms here), then joined again: a second connection.
    await until(() => hub.seen.connections >= 2, 3000);
  });
});

describe("a hub a release behind the process that joins it", () => {
  it("passes on a write op it does not know with the proxy's key and guard, so the plugin still runs it once and safely", async () => {
    const alice = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }] });
    cleanup.push(() => hub.close());
    const figma = await connectedMock(hub, alice, { fileName: "Alice's file", ops: ["make_sparkles"] });
    cleanup.push(() => figma.close());
    // What a newer proxy sends for a write op of its release: the hub's catalog has no such op.
    await hub.request("make_sparkles", {}, { person: "alice", idempotencyKey: "k-new", guard: { conflicts: "refuse" } }).catch(() => {});
    const sent = figma.received.find((f) => f.t === "request" && f.op === "make_sparkles") as Record<string, unknown> | undefined;
    expect(sent).toMatchObject({ idempotencyKey: "k-new", guard: { conflicts: "refuse" } });
  });
});
