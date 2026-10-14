// The plugin sandbox — spec §5.2. Thin wiring: route ops, run them one at a
// time, apply idempotency, report progress, commit one undo step per write op.

import { editorRefusal } from "../shared/editors.js";
import { BridgeError, ErrorCode } from "../shared/errors.js";
import { PROTOCOL_VERSION, type CancelMsg, type EventMsg, type RequestMsg } from "../shared/protocol.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, VERSION } from "../shared/version.js";
import { CancelledError, chooseYield, createUiScheduler, throttleProgress, type YieldMode } from "./chunk.js";
import { pageEvent, selectionEvent, startEvents } from "./events.js";
import { changedNothing, IdempotencyStore, type StoredResult } from "./idempotency.js";
import type { HelloInfo, SandboxToUi, UiToSandbox } from "./messages.js";
import { PLUGIN_OPS } from "./ops/index.js";
import { editorType } from "./safe.js";

// Option A, chosen by the yield spike (2026-10-07, Figma desktop 126.9.11,
// spikes/results/yield.json): setTimeout exists, fires, and hands the editor
// a turn (100 probes handled, worst input latency 69 ms), and spec §14.1's
// rule is "A if available and responsive". chooseYield falls back to option B
// on its own if a future Figma drops setTimeout. Option C never yielded.
const YIELD_MODE: YieldMode = "timer";
// An identifier, not the product name: plugins that already saved a token read
// it under this key, so it stays across the rename (src/shared/version.ts).
const TOKEN_KEY = "figma-mcp.token";

const post = (msg: SandboxToUi) => figma.ui.postMessage(msg);
const scheduler = createUiScheduler((m) => post(m));
const yieldToHost = chooseYield(YIELD_MODE, scheduler);
const store = new IdempotencyStore();

const instanceId = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("");

function fileKey(): string | null {
  // Documented as private-plugin only (claim C-021, to be verified in Phase 0).
  try {
    return typeof figma.fileKey === "string" ? figma.fileKey : null;
  } catch {
    return null;
  }
}

function helloInfo(): HelloInfo {
  let user: HelloInfo["user"] = null;
  try {
    const u = figma.currentUser;
    if (u) user = { id: u.id ?? null, name: u.name };
  } catch {
    user = null;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    pluginVersion: VERSION,
    buildId: typeof __PLUGIN_BUILD_ID__ === "string" ? __PLUGIN_BUILD_ID__ : "dev",
    apiVersion: figma.apiVersion,
    editorType: figma.editorType,
    ops: Object.keys(PLUGIN_OPS),
    file: { name: figma.root.name, key: fileKey() },
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    user,
    // A reconnect may reach a new server process while an op the old one sent
    // still runs here (a render, for minutes): say so, and the new one answers
    // BUSY instead of queueing calls behind it until they STALL.
    running: running ? { op: running.op, id: running.id, elapsedMs: Math.max(0, Date.now() - runningSince) } : null,
  };
}

const emit = (msg: EventMsg) => post({ kind: "wire", msg });

// ── requests: one at a time, attach/replay through the idempotency map ─────

const queue: RequestMsg[] = [];
const cancelled = new Set<string>();
let running: RequestMsg | null = null;
let runningSince = 0;

function reply(id: string, result: StoredResult, extra: { replayed?: boolean } = {}): void {
  if (result.ok) {
    const data =
      extra.replayed && result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? { ...(result.data as Record<string, unknown>), replayed: true }
        : result.data;
    post({ kind: "wire", msg: { t: "result", id, ok: true, data } });
  } else {
    post({
      kind: "wire",
      msg: {
        t: "result",
        id,
        ok: false,
        error: result.error,
        ...(result.partial !== undefined ? { partial: result.partial } : {}),
      },
    });
  }
}

function toStored(err: unknown, key: string | undefined): StoredResult {
  if (err instanceof CancelledError) {
    return { ok: false, error: { code: ErrorCode.CANCELLED, message: err.message }, partial: { done: err.done } };
  }
  if (err instanceof BridgeError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
      ...(err.partial !== undefined ? { partial: err.partial } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: ErrorCode.INTERNAL, message: key ? `${message} (idempotencyKey ${key})` : message } };
}

function onRequest(req: RequestMsg): void {
  const key = req.idempotencyKey;
  if (key && store.status(key) === "running") {
    const outcome = store.begin(key, req.op, req.id);
    if (outcome.kind === "conflict") {
      reply(req.id, {
        ok: false,
        error: { code: ErrorCode.INVALID_PARAM, message: `idempotencyKey already used for op \`${outcome.op}\`` },
      });
    }
    return; // attached: answered when the running op finishes
  }
  queue.push(req);
  void drain();
}

function onCancel(msg: CancelMsg): void {
  const queued = queue.findIndex((r) => r.id === msg.id);
  if (queued >= 0) {
    queue.splice(queued, 1);
    reply(msg.id, { ok: false, error: { code: ErrorCode.CANCELLED, message: `Cancelled (${msg.reason}) before it ran.` } });
    return;
  }
  cancelled.add(msg.id);
}

async function drain(): Promise<void> {
  if (running) return;
  while (queue.length > 0) {
    const req = queue.shift()!;
    running = req;
    runningSince = Date.now();
    try {
      await execute(req);
    } finally {
      running = null;
      cancelled.delete(req.id);
    }
  }
}

async function execute(req: RequestMsg): Promise<void> {
  const op = PLUGIN_OPS[req.op];
  const key = req.idempotencyKey;
  if (!op) {
    // Two different causes, two different fixes, and saying the wrong one wastes
    // the user's time. The plugin is a live process: updating its files changes
    // nothing inside Figma until the plugin window is closed and run again, and
    // "too old" would send someone to reinstall when the actual fix is a restart.
    const advertised = Object.keys(PLUGIN_OPS).length;
    reply(req.id, {
      ok: false,
      error: {
        code: ErrorCode.UNSUPPORTED,
        message: `This plugin window does not implement op "${req.op}".`,
        hint:
          advertised === 0
            ? `The plugin has no document ops at all — it predates them. In Figma, close the plugin window and run it again from ${PLUGIN_MENU_PATH}.`
            : `This plugin window advertises ${advertised} op(s) and none is "${req.op}". An update only takes effect after the ${PLUGIN_NAME} plugin window is closed and run again (${PLUGIN_MENU_PATH}), because the running plugin is the old bundle.`,
      },
    });
    return;
  }

  // The editor backstop [C-129]. The bridge refuses first, but an older hub
  // build has no gate, so a "no" cell is refused here too. Only "no": whether
  // an unmeasured write may run is the bridge's call, which knows
  // BRIDGE_ALLOW_UNVERIFIED. Before store.begin and before the op, so it pins
  // no idempotencyKey and commits no undo step.
  const refused = editorRefusal(req.op, editorType(), { allowUnverified: false, layer: "plugin" });
  if (refused) {
    reply(req.id, {
      ok: false,
      error: { code: ErrorCode.UNSUPPORTED, message: refused.message, hint: refused.hint },
      ...(op.write ? { partial: { created: [] } } : {}),
    });
    return;
  }

  if (key) {
    const outcome = store.begin(key, req.op, req.id);
    if (outcome.kind === "replay") return reply(req.id, outcome.result, { replayed: true });
    if (outcome.kind === "conflict") {
      return reply(req.id, {
        ok: false,
        error: { code: ErrorCode.INVALID_PARAM, message: `idempotencyKey already used for op \`${outcome.op}\`` },
      });
    }
  }

  // With attached requests still waiting, a cancel only detaches the cancelled one.
  const isCancelled = () =>
    key ? store.waiters(key).every((w) => cancelled.has(w)) : cancelled.has(req.id);
  const progress = throttleProgress((done, total, phase) =>
    post({
      kind: "wire",
      msg: {
        t: "progress",
        id: req.id,
        done,
        ...(total !== undefined ? { total } : {}),
        ...(phase !== undefined ? { phase } : {}),
      },
    }),
  );

  let result: StoredResult;
  try {
    const data = await op.run({ requestId: req.id, params: req.params, yieldToHost, progress, isCancelled });
    const keyed = key && data && typeof data === "object" && !Array.isArray(data);
    result = { ok: true, data: keyed ? { ...(data as Record<string, unknown>), idempotencyKey: key } : data };
  } catch (err) {
    result = toStored(err, key);
  }
  if (op.write) figma.commitUndo(); // one tool call = one Ctrl+Z step, even on partial failure

  // A failure that reports `partial.created: []` provably changed nothing, so it
  // must not pin the key: a corrected retry under the same key should run, not
  // replay this error. Anything that may have touched the document is recorded.
  const targets = key ? (changedNothing(result) ? store.abandon(key) : store.complete(key, result)) : [req.id];
  for (const id of targets) reply(id, result);
  post({ kind: "activity", text: `${req.op} ${result.ok ? "ok" : result.error.code}` });
}

// ── wiring ────────────────────────────────────────────────────────────────

figma.ui.onmessage = (raw: unknown) => {
  const msg = raw as UiToSandbox;
  switch (msg.kind) {
    case "tick":
      scheduler.onTick(msg.id);
      return;
    case "wire":
      if (msg.msg.t === "request") onRequest(msg.msg);
      else if (msg.msg.t === "cancel") onCancel(msg.msg);
      return;
    case "save-token":
      void figma.clientStorage.setAsync(TOKEN_KEY, msg.token);
      return;
    case "need-hello":
      post({ kind: "hello-info", hello: helloInfo() });
      return;
    case "connected":
      // protocol.md §5: after the handshake, sync selection and page state.
      emit(selectionEvent());
      emit(pageEvent());
      return;
  }
};

figma.showUI(__html__, { width: 300, height: 280, themeColors: true, title: PLUGIN_NAME });
startEvents({ emit, delay: (ms) => scheduler.delay(ms) });

void (async () => {
  const stored = (await figma.clientStorage.getAsync(TOKEN_KEY)) as unknown;
  post({ kind: "init", token: typeof stored === "string" && stored ? stored : null, hello: helloInfo() });
})();
