// figma_export_video's failure modes found by the 2026-10-14 audit, at the
// bridge: the stuck exporter [C-318], a result too large for the hub → proxy
// hop, a render the bridge stopped waiting for, request ids that repeated
// across hub processes (C-271), and a proxy refused by a hub of another token
// file. The plugin is a raw socket whose sandbox — its queue and the op it
// runs — survives reconnects, as src/plugin/code.ts does; it holds a render
// until the test releases it, and answers it however the test says.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BridgeError } from "../src/shared/errors.js";
import { tokenFingerprint } from "../src/shared/token.js";
import { authFailureIsCurrent, NO_SESSION_HINT, type Bridge } from "../src/server/bridge.js";
import { bytesOf } from "../src/server/binary.js";
import { loadConfig } from "../src/server/config.js";
import { buildStatus, type StatusContext } from "../src/server/tools/meta.js";
import { newToken, sleep, startBridge } from "./helpers.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Frame = { t: string; id?: string; op?: string; [k: string]: unknown };
type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; hint?: string }; partial?: unknown };

const VIDEO_HEAD = { nodeId: "1:2", exportedNodeId: "1:1", name: "Hero", format: "MP4", mime: "video/mp4" };

/** A plugin sandbox that runs one op at a time and holds export_video until release(answer). */
function fakeSandbox(token: string, opts: { chunkChars?: number; hello?: Record<string, unknown> } = {}) {
  let ws: WebSocket | null = null;
  const queue: Frame[] = [];
  let running: Frame | null = null;
  let runningSince = 0;
  const log: string[] = [];
  const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const answer = (req: Frame, a: Answer) => {
    log.push(`answered ${req.op} ${req.id}`);
    if (!a.ok) return send({ t: "result", id: req.id, ...a });
    const b64 = typeof a.data.base64 === "string" ? a.data.base64 : undefined;
    const chunk = opts.chunkChars ?? 8 * 1024 * 1024;
    if (b64 && b64.length > chunk) {
      const { base64: _b, ...head } = a.data;
      const n = Math.ceil(b64.length / chunk);
      send({ t: "result", id: req.id, ok: true, data: { ...head, chunks: n } });
      for (let s = 0; s < n; s++) send({ t: "chunk", id: req.id, seq: s, base64: b64.slice(s * chunk, (s + 1) * chunk) });
    } else send({ t: "result", id: req.id, ok: true, data: a.data });
  };
  const drain = () => {
    if (running) return;
    const req = queue.shift();
    if (!req) return;
    running = req;
    runningSince = Date.now();
    if (req.op === "export_video") {
      send({ t: "progress", id: req.id, done: 0, phase: "rendering MP4" });
      return; // held until release()
    }
    answer(req, { ok: true, data: { op: req.op, answeredFor: req.id } });
    running = null;
    drain();
  };
  const sandbox = {
    log,
    requests: () => log.filter((l) => l.startsWith("got ")),
    running: () => running,
    async connect(port: number, withRunning = true) {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const sock = ws;
      await new Promise<void>((resolve, reject) => {
        sock.on("open", () =>
          sock.send(
            JSON.stringify({
              t: "hello", protocolVersion: 1, token, instanceId: "sandbox-1", pluginVersion: "0", apiVersion: "1.0.0", editorType: "figma",
              ops: ["export_video", "get_pages", "get_selection", "create_frame"], file: { name: "Robust", key: null }, page: null, user: null,
              ...(withRunning ? { running: running ? { op: running.op, id: running.id, elapsedMs: Date.now() - runningSince } : null } : {}),
              ...opts.hello,
            }),
          ),
        );
        sock.on("error", reject);
        sock.on("message", (raw) => {
          const m = JSON.parse(String(raw)) as Frame;
          if (m.t === "welcome") return resolve();
          if (m.t === "ping") return void sock.send(JSON.stringify({ t: "pong", at: Date.now() }));
          if (m.t === "request") {
            log.push(`got ${m.op} ${m.id}`);
            queue.push(m);
            drain();
          }
          if (m.t === "cancel") log.push(`cancel ${m.id} ${m.reason}`);
        });
      });
    },
    /** Figma finishes the render it is running, with this answer. */
    release(a: Answer = { ok: true, data: { ...VIDEO_HEAD, bytes: 4, base64: "dmlkIQ==" } }) {
      const r = running!;
      running = null;
      answer(r, a);
      drain();
    },
    close() {
      ws?.terminate();
    },
  };
  cleanup.push(() => sandbox.close());
  return sandbox;
}

async function hub(token = newToken(), port = 0): Promise<{ hub: Bridge; token: string }> {
  const b = await startBridge({ token, port, sessionWaitMs: 2000, tokenPath: "/home/a/.figxel/token" });
  cleanup.push(() => b.close());
  return { hub: b, token };
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

const timeout = (render?: { frames: number; width: number; height: number }): Answer => ({
  ok: false,
  error: { code: "TIMEOUT", message: 'Figma gave up rendering "Hero" as MP4: Video export timed out', hint: "the plugin's hint" },
  ...(render ? { partial: { render } } : {}),
});
const BIG = { frames: 433, width: 1080, height: 1920 };
const SMALL = { frames: 25, width: 400, height: 436 };
const videoState = (b: Bridge) => b.status().sessions[0]!.videoExport!;

// ── 1. the stuck exporter [C-318] ─────────────────────────────────────────────

describe("Figma's render timeouts in a row (C-318)", () => {
  it("the first timeout of a large render says render again; the second in a row says restart Figma; a success resets the count", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);

    let render = rejection(b.request("export_video", { nodeId: "1:2" }, { jobId: "a" }));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release(timeout(BIG));
    let err = await render;
    expect(err.code).toBe("TIMEOUT");
    expect(err.hint).toMatch(/render again\. A large render[\s\S]*If the next render times out too, Figma's video exporter is likely stuck/);
    expect(videoState(b).timeoutsInARow).toBe(1);

    render = rejection(b.request("export_video", { nodeId: "1:2" }, { jobId: "b" }));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release(timeout(BIG));
    err = await render;
    expect(err.hint).toMatch(/^2 renders in a row ended in Figma's 4-minute limit, so Figma's video exporter is likely stuck\. In that state every render times out until Figma restarts, and fewer frames do not help\. Ask the user to save their work, quit Figma completely and reopen it, then run the Figxel plugin again/);
    expect(videoState(b).timeoutsInARow).toBe(2);

    const ok = b.request("export_video", { nodeId: "1:2" }, { jobId: "c" });
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release();
    await ok;
    expect(videoState(b).timeoutsInARow).toBe(0);
  });

  it("the first timeout of a small render already says restart Figma: it should have taken seconds", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);
    const render = rejection(b.request("export_video", { nodeId: "1:2" }, {}));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release(timeout(SMALL));
    expect((await render).hint).toMatch(/^A render this small should take seconds, so Figma's video exporter is likely stuck/);
  });

  it("an older plugin's UNSUPPORTED 'Video export timed out' counts too, and reaches the agent as TIMEOUT", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);
    const render = rejection(b.request("export_video", { nodeId: "1:2" }, {}));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release({ ok: false, error: { code: "UNSUPPORTED", message: 'Figma could not export "Hero" as MP4: Video export timed out', hint: "keyframes" } });
    const err = await render;
    expect(err).toMatchObject({ code: "TIMEOUT", message: 'Figma gave up rendering "Hero" as MP4: Video export timed out' });
    expect(err.hint).not.toMatch(/keyframes/);
    expect(videoState(b).timeoutsInARow).toBe(1);
  });

  it("the count is per plugin window and outlives a reconnect and a render nobody waits for", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);
    const ac = new AbortController();
    const dropped = rejection(b.request("export_video", { nodeId: "1:2" }, { signal: ac.signal }));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    ac.abort(); // figma_export_video { jobId, cancel: true }: Figma renders on
    expect((await dropped).code).toBe("CANCELLED");
    sandbox.release(timeout(BIG)); // the late answer still counts
    await vi.waitFor(() => expect(videoState(b).timeoutsInARow).toBe(1));
    await sandbox.connect(b.port); // the same window reconnects: a new session
    await vi.waitFor(() => expect(b.status().sessions).toHaveLength(1));
    expect(videoState(b).timeoutsInARow).toBe(1);
  });
});

// ── 3. a render the bridge stopped waiting for ───────────────────────────────

describe("a render has no idle limit in the bridge (minimized window, C-198)", () => {
  it("a render past its idle time is still waited for, and its late result resolves the job", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);
    let settled = false;
    const render = b.request("export_video", { nodeId: "1:2" }, { idleTimeoutMs: 200, jobId: "min" }).finally(() => (settled = true));
    await sleep(600); // three idle windows: the old bridge answered STALLED here and threw the result away
    expect(settled).toBe(false);
    expect(sandbox.log.filter((l) => l.startsWith("cancel"))).toEqual([]);
    // Meanwhile a call answers BUSY, and says the render is running, not that it was cancelled.
    const busy = await rejection(b.request("get_pages", {}));
    expect(busy.message).toMatch(/^Figma is busy with a video render \(figma_export_video job "min"\), \d+ s so far/);
    sandbox.release();
    const data = (await render) as Record<string, unknown>;
    expect(bytesOf(data)!.toString()).toBe("vid!");
    expect(await b.request("get_pages", {})).toMatchObject({ op: "get_pages" });
  });
});

// ── 4. a hub that exits mid-render (C-271) ───────────────────────────────────

describe("request ids are unique per process, and a new hub learns of a render an earlier one sent (C-271)", () => {
  it("a new hub's call is never answered with an old render's result, and answers BUSY while that render runs", async () => {
    const token = newToken();
    const { hub: a } = await hub(token);
    const port = a.port;
    const sandbox = fakeSandbox(token);
    await sandbox.connect(port);
    await a.request("get_pages", {});
    const lost = a.request("export_video", { nodeId: "1:2" }, { jobId: "old" }).catch((e: BridgeError) => e.code);
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    const oldId = sandbox.running()!.id!;
    await a.close(); // the client closed hub A's stdin
    expect(await lost).toBe("CANCELLED");

    const { hub: b } = await hub(token, port);
    await sandbox.connect(port); // the plugin reconnects; its hello says the render still runs
    await vi.waitFor(() => expect(b.status().sessions).toHaveLength(1));
    expect(b.status().sessions[0]!.videoExport!.rendering).toMatchObject({ jobId: null, state: "earlier" });

    const busy = await rejection(b.request("get_selection", {}));
    expect(busy.code).toBe("BUSY");
    expect(busy.message).toMatch(/^Figma is still busy with a video render that an earlier Figxel process started, with no result after \d+ s/);

    sandbox.release(); // Figma finishes A's render; its id is A's alone
    await vi.waitFor(() => expect(b.status().sessions[0]!.videoExport!.rendering).toBeNull());
    const pages = (await b.request("get_pages", {})) as { op: string; answeredFor: string };
    expect(pages.op).toBe("get_pages");
    expect(pages.answeredFor).not.toBe(oldId);
    const prefixA = /^r-([0-9a-f]{8})-\d+$/.exec(oldId)![1];
    expect(pages.answeredFor).toMatch(/^r-[0-9a-f]{8}-\d+$/);
    expect(pages.answeredFor.startsWith(`r-${prefixA}-`)).toBe(false);
  });

  it("a plugin that reconnects to the same hub mid-render: BUSY names the render's job and says no result yet, not 'an earlier process'", async () => {
    const { hub: b, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(b.port);
    const render = rejection(b.request("export_video", { nodeId: "1:2" }, { jobId: "mine" }));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.close(); // the socket drops; the sandbox renders on
    expect((await render).code).toBe("NO_SESSION");
    await sandbox.connect(b.port);
    await vi.waitFor(() => expect(b.status().sessions).toHaveLength(1));
    const busy = await rejection(b.request("get_pages", {}));
    expect(busy.message).toMatch(/^Figma is still busy with a video render \(figma_export_video job "mine"\), with no result after \d+ s/);
    sandbox.release();
    await vi.waitFor(() => expect(b.status().sessions[0]!.videoExport!.rendering).toBeNull());
  });

  it("an older plugin, which says nothing in its hello, still never gets its ids mixed up", async () => {
    const token = newToken();
    const { hub: a } = await hub(token);
    const port = a.port;
    const sandbox = fakeSandbox(token);
    await sandbox.connect(port, false);
    await a.request("get_pages", {});
    void a.request("export_video", { nodeId: "1:2" }, {}).catch(() => {});
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    await a.close();
    const { hub: b } = await hub(token, port);
    await sandbox.connect(port, false);
    await vi.waitFor(() => expect(b.status().sessions).toHaveLength(1));
    const queued = b.request("get_pages", {}, { idleTimeoutMs: 5_000 });
    await sleep(50);
    sandbox.release(); // the old render's result, for A's id: B ignores it
    expect(await queued).toMatchObject({ op: "get_pages" });
  });
});

// ── 2 and 12. a result too large for one frame ───────────────────────────────

describe("a 40 MiB result through hub, proxy and plugin", () => {
  it("reaches the proxy in pieces, decoded as it comes, and the proxy keeps its connection", async () => {
    const { hub: h, token } = await hub();
    const proxy = await startBridge({ token, port: h.port, sessionWaitMs: 2000 });
    cleanup.push(() => proxy.close());
    expect(proxy.role).toBe("proxy");
    const sandbox = fakeSandbox(token);
    await sandbox.connect(h.port);
    const bytes = Buffer.alloc(30 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    const render = proxy.request("export_video", { nodeId: "1:2" }, { jobId: "big" });
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release({ ok: true, data: { ...VIDEO_HEAD, bytes: bytes.length, base64: bytes.toString("base64") } }); // 40 MiB of base64
    const data = (await render) as Record<string, unknown>;
    expect(data).toMatchObject(VIDEO_HEAD);
    expect(Buffer.isBuffer(data.binary)).toBe(true);
    expect(bytesOf(data)!.equals(bytes)).toBe(true);
    await sleep(100);
    expect(proxy.role).toBe("proxy"); // the old hop closed the socket with 1009 and read as "the hub exited"
  }, 30_000);

  it("an older proxy, which cannot take pieces, gets an honest error instead of a closed connection", async () => {
    const { hub: h, token } = await hub();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(h.port);
    const old = new WebSocket(`ws://127.0.0.1:${h.port}`, { maxPayload: 32 * 1024 * 1024 });
    cleanup.push(() => old.terminate());
    const messages: Frame[] = [];
    let closed: number | null = null;
    old.on("close", (code) => (closed = code));
    await new Promise<void>((resolve) => {
      old.on("open", () => old.send(JSON.stringify({ t: "peer-hello", protocolVersion: 1, token, pid: 4242, serverVersion: "0.1.0" })));
      old.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Frame;
        messages.push(m);
        if (m.t === "peer-welcome") resolve();
      });
    });
    old.send(JSON.stringify({ t: "call", id: "c-1", op: "export_video", params: { nodeId: "1:2" }, opts: {} }));
    await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
    sandbox.release({ ok: true, data: { ...VIDEO_HEAD, bytes: 30 * 1024 * 1024, base64: Buffer.alloc(30 * 1024 * 1024).toString("base64") } });
    await vi.waitFor(() => expect(messages.some((m) => m.t === "call-result")).toBe(true), { timeout: 10_000 });
    const result = messages.find((m) => m.t === "call-result") as unknown as { ok: boolean; error: { code: string; message: string; hint: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toMatch(/more than one message between Figxel processes carries/);
    expect(result.error.hint).toMatch(/older than the one holding the Figma connection/);
    expect(closed).toBeNull();
  }, 30_000);

  it("an older hub that sends one frame too large: the proxy says so, not that the hub exited, and joins again", async () => {
    // A hub of peer protocol 1 without "result-chunks": welcomes, then answers a call in one 33 MiB frame.
    const token = newToken();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (s) =>
      s.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Frame;
        if (m.t === "peer-hello") s.send(JSON.stringify({ t: "peer-welcome", hubPid: 777, serverVersion: "0.1.0" }));
        if (m.t === "call") s.send(JSON.stringify({ t: "call-result", id: m.id, ok: true, data: { ...VIDEO_HEAD, base64: "A".repeat(33 * 1024 * 1024) } }));
      }),
    );
    const proxy = await startBridge({ token, port, sessionWaitMs: 2000 });
    cleanup.push(() => proxy.close());
    expect(proxy.role).toBe("proxy");
    const err = await rejection(proxy.request("export_video", { nodeId: "1:2" }, {}));
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toMatch(/^A result was larger than one message between Figxel processes carries \(32 MiB\), so the connection to the Figxel process holding Figma \(pid 777\) closed\. The call itself ran in Figma\./);
    expect(err.hint).toMatch(/restart the AI app that started it/);
    expect(err.partial).toEqual({ dispatched: true });
    await vi.waitFor(() => expect(proxy.role).toBe("proxy"), { timeout: 5_000 });
  }, 30_000);
});

// ── 13. two servers, two token files ─────────────────────────────────────────

describe("a proxy refused by a hub of another token file", () => {
  it("says which process holds the port and which token files differ, never blaming the plugin", async () => {
    const { hub: h } = await hub(newToken());
    const ownToken = newToken();
    const proxy = await startBridge({ token: ownToken, port: h.port, sessionWaitMs: 0, listenRetryMs: 60_000, tokenPath: "/home/b/.figxel/token" });
    cleanup.push(() => proxy.close());
    await vi.waitFor(() => expect(proxy.status().peerRefusal).not.toBeNull());
    const refusal = proxy.status().peerRefusal!;
    expect(refusal).toMatchObject({ hubPid: process.pid, hubTokenPath: "/home/a/.figxel/token", hubFingerprint: h.status().tokenFingerprint });
    expect(proxy.status().tokenFingerprint).toBe(tokenFingerprint(ownToken));
    expect(h.status().lastPeerAuthFailure).toMatchObject({ pid: process.pid });

    const err = await rejection(proxy.request("get_pages", {}));
    expect(err.code).toBe("PORT_IN_USE");
    expect(err.message).toMatch(new RegExp(`held by another Figxel server \\(pid ${process.pid}\\) that uses a different token file \\(/home/a/\\.figxel/token, fingerprint [0-9a-f]{4}\\.\\.\\.[0-9a-f]{4}\\)`));
    expect(err.message).toContain(`whose token file is /home/b/.figxel/token (fingerprint ${tokenFingerprint(ownToken)})`);
    expect(err.message).toMatch(/A plugin that shows "Connected" is connected to that other server/);
    expect(err.hint).toMatch(/close the other AI app[\s\S]*run `npx -y figxel-mcp@latest setup` in the same environment as this AI app/);
    expect(err.message).not.toContain(ownToken);
  });
});

describe("figma_status", () => {
  const ctxFor = (bridge: Bridge, media?: StatusContext["media"]) => ({
    bridge,
    config: loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-st-")), BRIDGE_PORT: "0" }),
    startedAt: Date.now(),
    selectedTools: [],
    registeredTools: [],
    ...(media ? { media } : {}),
  });

  it("a refused server is told apart from a refused plugin, with both token files and fingerprints", async () => {
    const { hub: h } = await hub(newToken());
    const proxy = await startBridge({ token: newToken(), port: h.port, sessionWaitMs: 0, listenRetryMs: 60_000, tokenPath: "/home/b/.figxel/token" });
    cleanup.push(() => proxy.close());
    await vi.waitFor(() => expect(proxy.status().peerRefusal).not.toBeNull());
    const st = (await buildStatus(ctxFor(proxy))) as { hint: string; token: Record<string, unknown>; auth: Record<string, unknown> };
    expect(st.hint).toMatch(/held by another Figxel server \(pid \d+\) that uses a different token file \(\/home\/a\/\.figxel\/token/);
    expect(st.hint).not.toMatch(/A plugin tried to connect/);
    expect(st.token).toMatchObject({ tokenPath: "/home/b/.figxel/token", fingerprint: proxy.status().tokenFingerprint });
    expect(st.auth).toMatchObject({ plugin: null, server: { hubPid: process.pid, hubTokenPath: "/home/a/.figxel/token", hubFingerprint: h.status().tokenFingerprint } });
    const hubSt = (await buildStatus(ctxFor(h))) as { auth: { refusedServer?: { pid: number } } };
    expect(hubSt.auth.refusedServer).toMatchObject({ pid: process.pid });
  });

  it("a plugin refused before a session connected is history, not the hint; the timeouts in a row and ffmpeg are shown", async () => {
    const { hub: h, token } = await hub();
    const wrong = new WebSocket(`ws://127.0.0.1:${h.port}`);
    await new Promise<void>((resolve) => {
      wrong.on("open", () =>
        wrong.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: newToken(), instanceId: "w", pluginVersion: "0", apiVersion: "1", editorType: "figma", ops: [], file: { name: "W", key: null }, page: null, user: null })),
      );
      wrong.on("close", () => resolve());
    });
    const sandbox = fakeSandbox(token);
    await sandbox.connect(h.port);
    for (const id of ["a", "b"]) {
      const render = rejection(h.request("export_video", { nodeId: "1:2" }, { jobId: id }));
      await vi.waitFor(() => expect(sandbox.running()?.op).toBe("export_video"));
      sandbox.release(timeout(BIG));
      await render;
    }
    const media = async () => ({ ffmpeg: { command: "ffmpeg", available: true, version: "ffmpeg version 9" }, ffprobe: { command: "ffprobe", available: false, error: "not found" }, note: "install it" });
    const st = (await buildStatus(ctxFor(h, media))) as { hint: string; auth: { plugin: { current: boolean } }; sessions: Array<{ videoExport: { timeoutsInARow: number } }>; video: Record<string, unknown> };
    expect(st.hint).toMatch(/^Connected to "Robust"/);
    expect(st.auth.plugin.current).toBe(false);
    expect(st.sessions[0]!.videoExport.timeoutsInARow).toBe(2);
    expect(st.hint).toMatch(/Video export: 2 renders in a row timed out in "Robust", so Figma's video exporter is likely stuck\. In that state every render times out until Figma restarts/);
    expect(st.video).toMatchObject({ ffmpeg: { available: true }, ffprobe: { available: false }, maxWaitS: 45, note: "install it" });
  });
});

describe("a plugin's refused token is the problem only until a session connects after it", () => {
  it("a failure older than a session's connect is not current", () => {
    const now = 1_000_000;
    expect(authFailureIsCurrent(null, [], now)).toBe(false);
    expect(authFailureIsCurrent(now - 1000, [], now)).toBe(true);
    expect(authFailureIsCurrent(now - 1000, [now - 500], now)).toBe(false);
    expect(authFailureIsCurrent(now - 1000, [now - 2000], now)).toBe(true);
    expect(authFailureIsCurrent(now - 11 * 60_000, [], now)).toBe(false);
  });

  it("NO_SESSION after a fixed token gives the open-the-plugin hint, not the token hint", async () => {
    const { hub: h, token } = await hub();
    const wrong = new WebSocket(`ws://127.0.0.1:${h.port}`);
    await new Promise<void>((resolve) => {
      wrong.on("open", () =>
        wrong.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: newToken(), instanceId: "w", pluginVersion: "0", apiVersion: "1", editorType: "figma", ops: [], file: { name: "W", key: null }, page: null, user: null })),
      );
      wrong.on("close", () => resolve());
    });
    expect(h.status().lastAuthFailureAt).not.toBeNull();
    const sandbox = fakeSandbox(token);
    await sandbox.connect(h.port); // the user pasted the right token
    const err = await rejection(h.request("get_pages", {}, { session: "no such file" }));
    expect(err.code).toBe("NO_SESSION");
    expect(err.hint).toBe(NO_SESSION_HINT);
  });
});
