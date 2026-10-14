#!/usr/bin/env node
// A Node stand-in for the Figma plugin — spec §5.4. It speaks the real
// protocol (docs/reference/protocol.md): hello/welcome, ping/pong, progress,
// chunked binary results, cancel, and plugin-side idempotency (attach/replay).
// Ops answer with fake data. It uses Node's global WebSocket, which sends no
// Origin header — exactly as protocol.md §1 expects of the mock.
//
//   node tools/mock-plugin.mjs [--slow] [--stall] [--drop] [--port N] [--token HEX] [--file NAME]
//
//   --slow   write ops report progress for --duration ms (default 3000) before answering
//   --stall  ops never answer and never report progress (the bridge should STALL them)
//   --drop   the first op disconnects midway, keeps running, reconnects with the same
//            instanceId; a retry with the same idempotencyKey gets the stored result
//
// Also importable: `startMockPlugin(options)` is what the integration tests use.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The server's default home folder name, mirrored from HOME_DIRNAME in
 * src/shared/version.ts (this file runs under plain node, which cannot import
 * TypeScript); test/rename.test.ts pins the two equal.
 */
export const DEFAULT_HOME_DIRNAME = ".figxel";

const DEFAULT_OPS = ["get_metadata", "get_pages", "create_frame", "create_from_spec", "export_node"];
const WRITE_OPS = new Set(["create_frame", "create_from_spec"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   url?: string, token: string, instanceId?: string, ops?: string[], fileName?: string, editorType?: string,
 *   scenario?: "normal" | "slow" | "stall" | "drop", durationMs?: number, progressMs?: number,
 *   protocolVersion?: number, reconnectDelayMs?: number, log?: (line: string) => void,
 * }} options
 */
export function startMockPlugin(options) {
  const url = options.url ?? "ws://127.0.0.1:38452";
  const instanceId = options.instanceId ?? randomBytes(8).toString("hex");
  const scenario = options.scenario ?? "normal";
  const durationMs = options.durationMs ?? 3000;
  const progressMs = options.progressMs ?? 200;
  const log = options.log ?? (() => {});

  /** @type {Map<string, {op: string, status: "running"|"done", waiters: string[], result?: any}>} */
  const store = new Map();
  const cancelled = new Set();
  const received = [];
  let socket = null;
  let chunkBytes = 8 * 1024 * 1024;
  let dropped = false;
  let closedByUser = false;
  let nextNode = 1;
  const listeners = { welcome: [], close: [] };

  const state = { sessionId: null, closeCode: null, closeReason: "" };

  const send = (msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  function reply(id, result) {
    if (!result.ok) return send({ t: "result", id, ok: false, error: result.error, ...(result.partial ? { partial: result.partial } : {}) });
    const data = result.data;
    if (data && typeof data.base64 === "string" && data.base64.length > chunkBytes) {
      const n = Math.ceil(data.base64.length / chunkBytes);
      const { base64, ...head } = data;
      send({ t: "result", id, ok: true, data: { ...head, chunks: n } });
      for (let seq = 0; seq < n; seq++) send({ t: "chunk", id, seq, base64: base64.slice(seq * chunkBytes, (seq + 1) * chunkBytes) });
      return;
    }
    send({ t: "result", id, ok: true, data });
  }

  async function run(req) {
    const p = req.params ?? {};
    switch (req.op) {
      case "get_metadata":
        return { ok: true, data: { name: options.fileName ?? "Mock File", key: null, pages: [{ id: "0:1", name: "Page 1" }] } };
      case "create_from_spec":
        // Echo the shape that arrived: the real op builds from an object, never a string.
        return { ok: true, data: { rootId: "1:900", created: [], nodeCount: 0, specType: Array.isArray(p.spec) ? "array" : typeof p.spec, specKeys: p.spec && typeof p.spec === "object" ? Object.keys(p.spec) : [] } };
      case "get_pages":
        return { ok: true, data: { pages: [{ id: "0:1", name: "Page 1" }] } };
      case "export_node": {
        // The real op's result shape (src/plugin/ops/export.ts).
        const format = p.format ?? "PNG";
        const mime = { PNG: "image/png", JPG: "image/jpeg", SVG: "image/svg+xml", PDF: "application/pdf" }[format] ?? "image/png";
        const raw = format === "SVG" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : Buffer.alloc(Number(p.fakeBytes ?? 1024), 7);
        const raster = format === "PNG" || format === "JPG";
        return {
          ok: true,
          data: {
            nodeId: p.nodeId ?? "1:1", name: "Mock Node", format, ...(raster ? { scale: p.scale ?? 1 } : {}),
            mime, bytes: raw.length, base64: raw.toString("base64"),
          },
        };
      }
      case "create_frame": {
        if (scenario === "slow" || (scenario === "drop" && !dropped)) {
          const steps = Math.max(1, Math.round(durationMs / progressMs));
          for (let i = 1; i <= steps; i++) {
            await sleep(progressMs);
            if (isCancelled(req)) {
              return { ok: false, error: { code: "CANCELLED", message: "Cancelled" }, partial: { done: i - 1, total: steps } };
            }
            send({ t: "progress", id: req.id, done: i, total: steps, phase: "creating nodes" });
            if (scenario === "drop" && !dropped && i === 1) {
              dropped = true;
              log("mock: dropping the connection mid-op");
              socket.close(1000, "mock drop");
              setTimeout(connect, options.reconnectDelayMs ?? 200);
            }
          }
        }
        const id = `1:${nextNode++}`;
        return { ok: true, data: { id, name: p.name ?? "Frame", width: p.width ?? 100, height: p.height ?? 100, x: 0, y: 0 } };
      }
      default:
        return { ok: false, error: { code: "UNSUPPORTED", message: `mock does not implement ${req.op}` } };
    }
  }

  function isCancelled(req) {
    const key = req.idempotencyKey;
    if (!key) return cancelled.has(req.id);
    return store.get(key).waiters.every((w) => cancelled.has(w));
  }

  async function onRequest(req) {
    if (scenario === "stall") return; // silent forever
    const key = req.idempotencyKey;
    if (key && WRITE_OPS.has(req.op)) {
      const e = store.get(key);
      if (e && e.op !== req.op) {
        return reply(req.id, { ok: false, error: { code: "INVALID_PARAM", message: `idempotencyKey already used for op \`${e.op}\`` } });
      }
      if (e && e.status === "running") return void e.waiters.push(req.id); // attach
      if (e && e.status === "done") {
        const r = e.result.ok ? { ok: true, data: { ...e.result.data, replayed: true } } : e.result;
        return reply(req.id, r);
      }
      store.set(key, { op: req.op, status: "running", waiters: [req.id] });
    }
    let result = await run(req);
    if (key && result.ok) result = { ok: true, data: { ...result.data, idempotencyKey: key } };
    if (key && store.has(key)) {
      const e = store.get(key);
      e.status = "done";
      e.result = result;
      const waiters = e.waiters;
      e.waiters = [];
      for (const w of waiters) reply(w, result);
    } else {
      reply(req.id, result);
    }
  }

  function connect() {
    if (closedByUser) return;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      send({
        t: "hello",
        protocolVersion: options.protocolVersion ?? 1,
        token: options.token,
        instanceId,
        pluginVersion: "0.0.0-mock",
        apiVersion: "1.0.0",
        // A FigJam board or a Slides deck for the editor gate's tests (src/shared/editors.ts).
        editorType: options.editorType ?? "figma",
        ops: options.ops ?? DEFAULT_OPS,
        file: { name: options.fileName ?? "Mock File", key: null },
        page: { id: "0:1", name: "Page 1" },
        user: { id: "0", name: "Mock User" },
      });
    });
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      received.push(msg);
      if (msg.t === "welcome") {
        state.sessionId = msg.sessionId;
        chunkBytes = msg.limits.chunkBytes;
        send({ t: "event", name: "selection_changed", data: { nodeIds: [], count: 0, at: Date.now() } });
        send({ t: "event", name: "page_changed", data: { pageId: "0:1", pageName: "Page 1" } });
        for (const f of listeners.welcome.splice(0)) f(msg);
      } else if (msg.t === "ping") {
        send({ t: "pong", at: Date.now() });
      } else if (msg.t === "request") {
        void onRequest(msg);
      } else if (msg.t === "cancel") {
        cancelled.add(msg.id);
      }
    });
    socket.addEventListener("close", (ev) => {
      state.closeCode = ev.code;
      state.closeReason = ev.reason;
      for (const f of listeners.close.splice(0)) f(ev);
    });
    socket.addEventListener("error", () => {});
  }

  connect();

  return {
    instanceId,
    state,
    received,
    store,
    send,
    /** Resolves with the next `welcome`. */
    welcomed: () => new Promise((resolve) => listeners.welcome.push(resolve)),
    /** Resolves with the next close event `{ code, reason }`. */
    closed: () => new Promise((resolve) => listeners.close.push((ev) => resolve({ code: ev.code, reason: ev.reason }))),
    reconnect: connect,
    close() {
      closedByUser = true;
      socket?.close(1000, "mock closed");
    },
  };
}

function parseArgs(argv) {
  const out = { scenario: "normal" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slow") out.scenario = "slow";
    else if (a === "--stall") out.scenario = "stall";
    else if (a === "--drop") out.scenario = "drop";
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--file") out.fileName = argv[++i];
    else if (a === "--duration") out.durationMs = Number(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.BRIDGE_HOME || join(homedir(), DEFAULT_HOME_DIRNAME);
  const token = args.token ?? readFileSync(join(home, "token"), "utf8").trim();
  const port = args.port ?? Number(process.env.BRIDGE_PORT || 38452);
  const mock = startMockPlugin({ ...args, token, url: `ws://127.0.0.1:${port}`, log: (l) => console.error(l) });
  console.error(`mock plugin (${args.scenario}) → ws://127.0.0.1:${port}, instance ${mock.instanceId}`);
  mock.welcomed().then((w) => console.error(`connected as ${w.sessionId}`));
  // Like the real plugin (protocol.md §5): keep reconnecting unless the close code is terminal.
  const onClose = () =>
    mock.closed().then(({ code, reason }) => {
      console.error(`closed ${code} ${reason}`);
      if ([4001, 4003, 4004, 4005].includes(code)) process.exit(1);
      setTimeout(() => {
        mock.reconnect();
        mock.welcomed().then((w) => console.error(`connected as ${w.sessionId}`));
      }, 1000);
      onClose();
    });
  onClose();
  process.on("SIGINT", () => {
    mock.close();
    process.exit(0);
  });
}
