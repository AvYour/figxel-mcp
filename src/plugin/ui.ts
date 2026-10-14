// The plugin UI iframe — spec §5.2: WebSocket client, backoff, token form,
// status, and the timer/yield service the sandbox may not have (C-012).

import {
  CLOSE,
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  HOST,
  RECONNECT_BACKOFF_MS,
  RECONNECT_STABLE_MS,
  TERMINAL_CLOSE_CODES,
  type PluginToServer,
  type ServerToPlugin,
} from "../shared/protocol.js";
import { tokenFingerprint } from "../shared/token.js";
import { PLUGIN_NAME, SETUP_COMMAND } from "../shared/version.js";
import type { HelloInfo, SandboxToUi, UiToSandbox } from "./messages.js";

const BRIDGE_URL = `ws://${HOST}:${DEFAULT_PORT}`;
/** What brings the plugin and the server back to one version, for someone who installed the package. */
const UPDATE_STEPS = `Update both: run ${SETUP_COMMAND}, run the ${PLUGIN_NAME} plugin again, and restart your MCP client.`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLDivElement>("status");
const detailEl = $<HTMLDivElement>("detail");
const tokenForm = $<HTMLFormElement>("token-form");
const tokenInput = $<HTMLInputElement>("token-input");
const logEl = $<HTMLOListElement>("log");
const changeTokenBtn = $<HTMLButtonElement>("change-token");

let token: string | null = null;
let hello: HelloInfo | null = null;
let ws: WebSocket | null = null;
let attempt = 0;
let stopped = false;
let chunkBytes = DEFAULT_LIMITS.chunkBytes;
let stableTimer: number | undefined;
let retryTimer: number | undefined;

const toSandbox = (msg: UiToSandbox) => parent.postMessage({ pluginMessage: msg }, "*");

function setStatus(kind: "ok" | "wait" | "error", text: string, detail = ""): void {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
  detailEl.textContent = detail;
}

function activity(text: string): void {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  logEl.prepend(li);
  while (logEl.children.length > 6) logEl.lastElementChild?.remove();
}

function showTokenForm(reason: string): void {
  tokenForm.hidden = false;
  changeTokenBtn.hidden = true;
  setStatus("error", "Token needed", reason);
  tokenInput.focus();
}

/**
 * The token's fingerprint, shown next to "Connected" and in the token form.
 * `setup` and figma_status print the server's: when the two differ, the
 * plugin is connected to another server than the one the AI app talks to.
 */
const fingerprintText = (t: string | null) => `token ${tokenFingerprint(t)}`;

function send(msg: PluginToServer): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** protocol.md §2: base64 payloads over chunkBytes go out as a head `result` + N `chunk` frames. */
function sendWire(msg: PluginToServer): void {
  if (msg.t === "result" && msg.ok) {
    const data = msg.data as { base64?: unknown } | null;
    if (data && typeof data === "object" && typeof data.base64 === "string" && data.base64.length > chunkBytes) {
      const b64 = data.base64;
      const n = Math.ceil(b64.length / chunkBytes);
      const { base64: _omit, ...head } = data;
      send({ t: "result", id: msg.id, ok: true, data: { ...head, chunks: n } });
      for (let seq = 0; seq < n; seq++) {
        send({ t: "chunk", id: msg.id, seq, base64: b64.slice(seq * chunkBytes, (seq + 1) * chunkBytes) });
      }
      return;
    }
  }
  send(msg);
}

function scheduleReconnect(): void {
  if (stopped) return;
  const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
  attempt++;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => toSandbox({ kind: "need-hello" }), wait);
}

function connect(): void {
  if (!token) return showTokenForm(`Paste the token printed by: ${SETUP_COMMAND} (it prints its fingerprint too).`);
  if (!hello) return;
  window.clearTimeout(stableTimer);
  window.clearTimeout(retryTimer);
  // At most one live socket per window. A second one with the same instanceId
  // makes the bridge replace the first (4004); detach the old one first so its
  // close is recognised as superseded below, not as a failure to react to.
  const previous = ws;
  ws = null;
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close(1000, "superseded");
  const socket = new WebSocket(BRIDGE_URL);
  ws = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ t: "hello", token, ...hello }));
  };
  socket.onmessage = (ev) => {
    let msg: ServerToPlugin;
    try {
      msg = JSON.parse(String(ev.data)) as ServerToPlugin;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        chunkBytes = msg.limits.chunkBytes;
        setStatus("ok", "Connected", `Session ${msg.sessionId} · bridge ${msg.serverVersion} · ${fingerprintText(token)}`);
        changeTokenBtn.hidden = false;
        activity(`connected (${msg.sessionId})`);
        toSandbox({ kind: "connected", sessionId: msg.sessionId });
        stableTimer = window.setTimeout(() => (attempt = 0), RECONNECT_STABLE_MS);
        return;
      case "ping":
        send({ t: "pong", at: Date.now() });
        return;
      case "request":
      case "cancel":
        toSandbox({ kind: "wire", msg });
        return;
    }
  };
  socket.onclose = (ev) => {
    // A socket this window already replaced must not reconnect, stop the loop,
    // or repaint the status: the live socket owns all of that.
    if (ws !== socket) return;
    ws = null;
    window.clearTimeout(stableTimer);
    if (TERMINAL_CLOSE_CODES.includes(ev.code)) {
      stopped = true;
      if (ev.code === CLOSE.AUTH_FAILED) {
        stopped = false; // a new token restarts the loop
        const refused = token;
        token = null;
        return showTokenForm(`The bridge rejected the token (${fingerprintText(refused)}). Paste the current one: ${SETUP_COMMAND} prints it with its fingerprint.`);
      }
      if (ev.code === CLOSE.SESSION_REPLACED) return setStatus("error", "Replaced", "Another window of this plugin took over.");
      if (ev.code === CLOSE.PROTOCOL_MISMATCH) return setStatus("error", "Version mismatch", ev.reason ? `${ev.reason}. ${UPDATE_STEPS}` : UPDATE_STEPS);
      return setStatus("error", "Refused", ev.reason || `Closed with ${ev.code}.`);
    }
    if (ev.code === CLOSE.SERVER_SHUTDOWN) activity("bridge stopped — waiting for the next one");
    setStatus("wait", "Waiting for bridge…", `Starts when an agent session starts. Retrying ${BRIDGE_URL}.`);
    scheduleReconnect();
  };
}

window.onmessage = (ev: MessageEvent) => {
  const msg = (ev.data as { pluginMessage?: SandboxToUi }).pluginMessage;
  if (!msg) return;
  switch (msg.kind) {
    case "tick-request":
      // Option B yield / delay: replying from the iframe gives the host a new task.
      if (msg.ms <= 0) toSandbox({ kind: "tick", id: msg.id });
      else window.setTimeout(() => toSandbox({ kind: "tick", id: msg.id }), msg.ms);
      return;
    case "init":
      token = msg.token;
      hello = msg.hello;
      return connect();
    case "hello-info":
      hello = msg.hello;
      return connect();
    case "wire":
      return sendWire(msg.msg);
    case "activity":
      return activity(msg.text);
  }
};

tokenForm.onsubmit = (ev) => {
  ev.preventDefault();
  const value = tokenInput.value.trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    detailEl.textContent = "A token is 64 hexadecimal characters.";
    return;
  }
  token = value;
  tokenInput.value = "";
  tokenForm.hidden = true;
  toSandbox({ kind: "save-token", token: value });
  stopped = false;
  attempt = 0;
  setStatus("wait", "Connecting…");
  toSandbox({ kind: "need-hello" }); // connect() replaces the current socket, if any
};

changeTokenBtn.onclick = () => showTokenForm(`Saved: ${fingerprintText(token)}. Paste a new token; the current connection stays up until you save.`);

setStatus("wait", "Starting…");
