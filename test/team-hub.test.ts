// A team's hub (cloud bridge plan, step 2): one token per person, each plugin
// session owned by the person whose token opened it, and a person's calls,
// through a proxy as from a laptop, reach only that person's sessions.

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { clientAddress } from "../src/server/bridge.js";
import type { BridgeError } from "../src/shared/errors.js";
import { connectedMock, newToken, startBridge, startMock } from "./helpers.js";

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

/** A hub with Alice and Bob, each with a Figma file and an agent's process (a proxy) of their own. */
async function team() {
  const alice = newToken();
  const bob = newToken();
  const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }, { person: "bob", token: bob }] });
  cleanup.push(() => hub.close());
  const aliceFigma = await connectedMock(hub, alice, { fileName: "Alice's file" });
  cleanup.push(() => aliceFigma.close());
  const bobFigma = await connectedMock(hub, bob, { fileName: "Bob's file" });
  cleanup.push(() => bobFigma.close());
  const asAlice = await startBridge({ token: alice, port: hub.port });
  cleanup.push(() => asAlice.close());
  const asBob = await startBridge({ token: bob, port: hub.port });
  cleanup.push(() => asBob.close());
  return { hub, aliceFigma, bobFigma, asAlice, asBob };
}

const fileOf = async (p: Promise<unknown>) => ((await p) as { name: string }).name;

describe("a team's hub keeps each person to their own Figma", () => {
  it("each person's agent reaches their own file", async () => {
    const { asAlice, asBob } = await team();
    expect(asAlice.role).toBe("proxy");
    expect(await fileOf(asAlice.request("get_metadata", {}))).toBe("Alice's file");
    expect(await fileOf(asBob.request("get_metadata", {}))).toBe("Bob's file");
  });

  it("another person's session, by id or by file name, is as if it did not exist", async () => {
    const { asAlice, asBob } = await team();
    const bobs = (await asBob.statusAsync()).sessions[0]!.sessionId;
    // The answer for Bob's session is word for word the answer for a session that was never there.
    for (const [session, never] of [[bobs, "s-999"], ["Bob's file", "No such file"]] as const) {
      const err = await rejection(asAlice.request("get_metadata", {}, { session }));
      const none = await rejection(asAlice.request("get_metadata", {}, { session: never }));
      expect(err.code).toBe("NO_SESSION");
      expect(err.message.replace(session, "X")).toBe(none.message.replace(never, "X"));
      expect(err.hint).toBe(none.hint);
    }
  });

  it("figma_status shows a person only their own sessions", async () => {
    const { asAlice, asBob } = await team();
    expect((await asAlice.statusAsync()).sessions.map((s) => s.file.name)).toEqual(["Alice's file"]);
    expect((await asBob.statusAsync()).sessions.map((s) => s.file.name)).toEqual(["Bob's file"]);
  });

  it("the same idempotency key from two people runs twice, once in each file", async () => {
    const { asAlice, asBob, aliceFigma, bobFigma } = await team();
    await Promise.all([
      asAlice.request("create_frame", { name: "Same key" }, { idempotencyKey: "k-same" }),
      asBob.request("create_frame", { name: "Same key" }, { idempotencyKey: "k-same" }),
    ]);
    const creates = (m: typeof aliceFigma) => m.received.filter((f) => f.t === "request" && f.op === "create_frame").length;
    expect(creates(aliceFigma)).toBe(1);
    expect(creates(bobFigma)).toBe(1);
  });

  it("a token not in the table is refused, by a plugin and by a process, and learns nothing", async () => {
    const { hub } = await team();
    const stranger = newToken();
    const figma = startMock({ token: stranger, port: hub.port });
    cleanup.push(() => figma.close());
    expect((await figma.closed()).code).toBe(4001);
    const process = await startBridge({ token: stranger, port: hub.port });
    cleanup.push(() => process.close());
    const err = await rejection(process.request("get_metadata", {}));
    const said = `${err.message} ${err.hint ?? ""}`;
    expect(said).not.toMatch(/Alice|Bob|alice|bob/);
    expect(said).not.toContain(String(globalThis.process.pid)); // the hub runs in this test process: its pid is not told
  });

  it("the welcome names the person, so the plugin window shows whose token it uses; on one computer it names no one", async () => {
    const { aliceFigma, bobFigma } = await team();
    const welcome = (m: typeof aliceFigma) => m.received.find((f) => f.t === "welcome");
    expect(welcome(aliceFigma)).toMatchObject({ person: "alice" });
    expect(welcome(bobFigma)).toMatchObject({ person: "bob" });
    const token = newToken();
    const local = await startBridge({ token });
    cleanup.push(() => local.close());
    const figma = await connectedMock(local, token);
    cleanup.push(() => figma.close());
    expect(welcome(figma)).not.toHaveProperty("person");
  });

  it("a stranger's refused token is no one's news: not in a person's status, not in their NO_SESSION hint", async () => {
    const { hub, asAlice } = await team();
    const stranger = startMock({ token: newToken(), port: hub.port });
    cleanup.push(() => stranger.close());
    await stranger.closed();
    const st = await asAlice.statusAsync();
    expect(st.lastAuthFailureAt).toBeNull();
    expect(st.lastPeerAuthFailure ?? null).toBeNull();
    expect(st.peers).toBe(1); // Alice's own process, not Bob's
    const err = await rejection(asAlice.request("get_metadata", {}, { session: "s-999" }));
    expect(err.hint).not.toMatch(/A plugin tried to connect/);
  });

  it("a tool refused for the file's editor suggests only the person's own files, never another person's", async () => {
    const alice = newToken();
    const bob = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }, { person: "bob", token: bob }] });
    cleanup.push(() => hub.close());
    for (const [token, fileName, editorType] of [[alice, "Alice's board", "figjam"], [bob, "Bob's design", "figma"]] as const) {
      const figma = await connectedMock(hub, token, { fileName, editorType });
      cleanup.push(() => figma.close());
    }
    const asAlice = await startBridge({ token: alice, port: hub.port });
    cleanup.push(() => asAlice.close());
    // Paint styles run only in Design files: on a laptop the refusal points at another open Design file.
    const err = await rejection(asAlice.request("create_paint_style", { name: "x", color: "#000" }, { session: "Alice's board" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.hint).toMatch(/Open a Figma Design file/);
    expect(`${err.message} ${err.hint ?? ""}`).not.toMatch(/Bob/);
  });

  it("another person's plugin with the same window id does not push a person's session out", async () => {
    const alice = newToken();
    const bob = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }, { person: "bob", token: bob }] });
    cleanup.push(() => hub.close());
    const aliceFigma = await connectedMock(hub, alice, { fileName: "Alice's file", instanceId: "same-window" });
    cleanup.push(() => aliceFigma.close());
    const bobFigma = await connectedMock(hub, bob, { fileName: "Bob's file", instanceId: "same-window" });
    cleanup.push(() => bobFigma.close());
    expect(hub.status("alice").sessions.map((s) => s.file.name)).toEqual(["Alice's file"]);
    expect(hub.status("bob").sessions.map((s) => s.file.name)).toEqual(["Bob's file"]);
  });

  it("the hub's own process, whose token is not in the table, reaches no one's file", async () => {
    const { hub } = await team();
    expect((await rejection(hub.request("get_metadata", {}))).code).toBe("NO_SESSION");
    expect(hub.status().sessions).toEqual([]);
  });
});

describe("refused tokens from one address", () => {
  /** A plugin's hello from `address`, as the proxy beside the hub reports it; resolves with the close code, or 0 when welcomed. */
  async function helloFrom(port: number, token: string, address: string): Promise<number> {
    const ws = new WsSocket(`ws://127.0.0.1:${port}`, { headers: { "x-forwarded-for": address } });
    cleanup.push(() => ws.terminate());
    return new Promise((resolve) => {
      ws.on("open", () =>
        ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token, instanceId: `i-${address}-${Math.random()}`, pluginVersion: "0", apiVersion: "1", editorType: "figma", ops: [], file: { name: "F", key: null }, page: null, user: null })),
      );
      ws.on("message", (raw) => {
        if (String(raw).includes('"welcome"')) resolve(0);
      });
      ws.on("close", (code) => resolve(code));
    });
  }

  it("turns an address away after the limit, a correct token included, and lets other addresses in", async () => {
    const alice = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }], failureLimit: { max: 3, windowMs: 60_000, blockMs: 60_000 } });
    cleanup.push(() => hub.close());
    for (let i = 0; i < 3; i++) expect(await helloFrom(hub.port, newToken(), "203.0.113.5")).toBe(4001);
    expect(await helloFrom(hub.port, alice, "203.0.113.5")).toBe(4001); // turned away before its hello is read
    expect(await helloFrom(hub.port, alice, "198.51.100.9")).toBe(0);
  });

  it("believes X-Forwarded-For only from a proxy on a private address", () => {
    const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff ? { "x-forwarded-for": xff } : {} });
    expect(clientAddress(req("172.18.0.2", "203.0.113.5"))).toBe("203.0.113.5"); // Caddy's container
    expect(clientAddress(req("127.0.0.1", "10.0.0.1, 203.0.113.5"))).toBe("203.0.113.5"); // the entry the proxy added
    expect(clientAddress(req("::ffff:127.0.0.1", "203.0.113.5"))).toBe("203.0.113.5");
    expect(clientAddress(req("198.51.100.7", "203.0.113.5"))).toBe("198.51.100.7"); // anyone else could write the header
    expect(clientAddress(req("172.18.0.2"))).toBe("172.18.0.2");
  });
});
