// The plugin UI iframe — spec §5.2: WebSocket client, backoff, token form,
// status, and the timer/yield service the sandbox may not have (C-012).
//
// The window says, in plain words, what is happening and what to do next: one
// status and one sentence, then a card with where it connects (this computer
// or a team's hub), as whom, and the token's fingerprint; ids and versions sit
// in one small line under it.

import {
  CLOSE,
  DEFAULT_LIMITS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_STABLE_MS,
  TERMINAL_CLOSE_CODES,
  type PluginToServer,
  type ServerToPlugin,
} from "../shared/protocol.js";
import { tokenFingerprint } from "../shared/token.js";
import { PLUGIN_NAME, SETUP_COMMAND } from "../shared/version.js";
import type { HelloInfo, SandboxToUi, UiToSandbox } from "./messages.js";
import { parseInvite } from "../shared/invite.js";
import { CLOUD_NAME, CLOUD_URL, REMOTE_BACKOFF_MS, parseServer, placeOf, urlOf } from "./server-url.js";

/** What brings the plugin and the server back to one version, for someone who installed the package. */
const UPDATE_STEPS = `Update both: run ${SETUP_COMMAND}, run the ${PLUGIN_NAME} plugin again, and restart your MCP client.`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLDivElement>("status");
const detailEl = $<HTMLDivElement>("detail");
const tokenForm = $<HTMLFormElement>("token-form");
const tokenLabel = $<HTMLLabelElement>("token-label");
const tokenInput = $<HTMLInputElement>("token-input");
const useLocalBtn = $<HTMLButtonElement>("use-local");
const useHubBtn = $<HTMLButtonElement>("use-hub");
const whereHost = $<HTMLDivElement>("where-host");
const hubName = $<HTMLSpanElement>("hub-name");
const changeHubBtn = $<HTMLButtonElement>("change-hub");
const serverForm = $<HTMLFormElement>("server-form");
const serverInput = $<HTMLInputElement>("server-input");
const serverError = $<HTMLDivElement>("server-error");
const whoRow = $<HTMLDivElement>("who-row");
const whoEl = $<HTMLSpanElement>("who");
const tokenFp = $<HTMLSpanElement>("token-fp");
const changeTokenBtn = $<HTMLButtonElement>("change-token");
const metaEl = $<HTMLDivElement>("meta");
const logEl = $<HTMLOListElement>("log");
const logEmpty = $<HTMLDivElement>("log-empty");
const signInBox = $<HTMLDivElement>("sign-in-box");
const signInBtn = $<HTMLButtonElement>("sign-in");
const signInCode = $<HTMLDivElement>("sign-in-code");
const signInAgain = $<HTMLButtonElement>("sign-in-again");
const resetBtn = $<HTMLButtonElement>("reset");
const useLocalFirst = $<HTMLButtonElement>("use-local-first");
const card = $<HTMLDivElement>("card");

let token: string | null = null;
/** null: this computer's server; else a team's hub (server-url.ts). */
let server: string | null = null;
/** The last team hub used, so "Team hub" switches back in one click. */
let lastHub: string | null = null;
/** Whose token this is, as a team's hub names it in its welcome. */
let person: string | null = null;
let session: { id: string; version: string } | null = null;
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

/** The card: where, as whom, the token's fingerprint, and the session line. */
function paint(): void {
  // Before a way in is chosen (the welcome), there is no connection to describe.
  card.hidden = !server && !token && !localChosen;
  useLocalBtn.className = server ? "" : "on";
  useHubBtn.className = server ? "on" : "";
  whereHost.hidden = !server;
  hubName.textContent = server ? placeOf(server) : "";
  whoRow.hidden = !(server && person);
  whoEl.textContent = person ?? "";
  // The fingerprint (first and last four characters), never the token: setup and figma_status print the same one.
  tokenFp.textContent = token ? tokenFingerprint(token) : "not set";
  changeTokenBtn.hidden = !token;
  metaEl.hidden = !session;
  metaEl.textContent = session ? `Session ${session.id} · Figxel ${session.version}` : "";
}

/** code.ts reports "op ok" or "op CODE"; the list shows a mark instead. */
function activity(text: string): void {
  const m = /^(\S+) (ok|[A-Z_]+)$/.exec(text);
  const line = m ? (m[2] === "ok" ? `✓ ${m[1]}` : `✗ ${m[1]} · ${m[2]}`) : text;
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${line}`;
  logEl.prepend(li);
  logEmpty.hidden = true;
  while (logEl.children.length > 6) logEl.lastElementChild?.remove();
}

const fileName = () => (hello?.file.name ? `"${hello.file.name}"` : "this file");

function showTokenForm(title: string, reason: string): void {
  tokenForm.hidden = false;
  // A hub signs people in through the browser; pasting an invite stays the other way in.
  signInBox.hidden = !server;
  signInBtn.textContent = "Sign in with the browser";
  useLocalFirst.hidden = true;
  signInCode.hidden = true;
  signInAgain.hidden = true;
  tokenLabel.textContent = server ? `Or paste your invite for ${placeOf(server)}` : "Your token for this computer";
  setStatus("error", title, reason);
  paint();
  if (!server) tokenInput.focus();
}

/** Chose this computer's server on the first screen: its token form, not the welcome, until a reset. */
let localChosen = false;

/** The first screen, with nothing saved: one button signs in to Figxel Cloud, nothing to type. */
function showWelcome(): void {
  tokenForm.hidden = true;
  signInBox.hidden = false;
  signInBtn.textContent = "Sign in";
  useLocalFirst.hidden = false;
  signInCode.hidden = true;
  signInAgain.hidden = true;
  setStatus(
    "wait",
    `Welcome to ${PLUGIN_NAME}`,
    `Sign in to ${CLOUD_NAME} (by invitation for now) to connect this Figma file to your AI apps; already signed in from Claude or ChatGPT here, you only confirm. Or use ${PLUGIN_NAME} on this computer, free.`,
  );
  paint();
}

/** Where a token for the current server comes from. */
const tokenSource = () =>
  server
    ? `Sign in with your Figma or Google account in the browser, or paste the invite you were given for ${placeOf(server)}.`
    : `Using Figxel on this computer? Run ${SETUP_COMMAND} in a terminal: it prints your token. Or press ${CLOUD_NAME} to sign in.`;

/**
 * Signing in to a team's hub through the browser (the hub's device flow,
 * oauth.ts): the hub gives a short code, the person confirms it on the page
 * that opens and signs in there, and this window asks every few seconds until
 * the hub hands over this plugin's credential.
 */
let signInRun = 0;
async function signInWithBrowser(): Promise<void> {
  // With nothing chosen yet, Sign in means Figxel Cloud.
  const hub = server ?? CLOUD_URL;
  const run = ++signInRun;
  const base = hub.replace(/^ws/, "http");
  setStatus("wait", "Signing in…", `Asking ${placeOf(hub)} for a code.`);
  let start: { device_code: string; user_code: string; verification_uri_complete: string; interval: number; expires_in: number };
  try {
    const r = await fetch(`${base}/device/code`, { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    start = (await r.json()) as typeof start;
  } catch {
    if (!server) return setStatus("error", "Cannot sign in now", `${placeOf(hub)} cannot be reached. Check your internet connection and press Sign in again.`);
    return showTokenForm("Paste your invite", `${placeOf(server)} has no browser sign-in, or cannot be reached. Paste the invite you were given instead.`);
  }
  signInCode.textContent = start.user_code;
  signInCode.hidden = false;
  signInAgain.hidden = false;
  signInAgain.onclick = () => toSandbox({ kind: "open-url", url: start.verification_uri_complete });
  setStatus("wait", "Finish in your browser", `A page opened in your browser: check it shows ${start.user_code}, then sign in there. ${start.verification_uri_complete}`);
  toSandbox({ kind: "open-url", url: start.verification_uri_complete });
  const until = Date.now() + start.expires_in * 1000;
  while (run === signInRun && Date.now() < until) {
    await new Promise((r) => window.setTimeout(r, Math.max(1, start.interval) * 1000));
    if (run !== signInRun) return;
    const r = await fetch(`${base}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ device_code: start.device_code }).toString(),
    }).catch(() => null);
    const body = (await r?.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (body?.token && /^[0-9a-f]{64}$/.test(body.token)) {
      token = body.token;
      tokenForm.hidden = true;
      signInBox.hidden = true;
      attempt = 0;
      stopped = false;
      setStatus("wait", "Connecting…", `To ${placeOf(hub)}.`);
      if (server === hub) {
        toSandbox({ kind: "save-token", token: body.token });
        paint();
        toSandbox({ kind: "need-hello" });
      } else {
        // Signed in from the first screen: the hub and its credential are saved together, then the window connects.
        server = hub;
        lastHub = hub;
        paint();
        toSandbox({ kind: "save-server", server: hub, token: body.token });
      }
      return;
    }
    if (body?.error === "access_denied") {
      // Not on the hub's list. With nothing chosen yet (Figxel Cloud), the free way in is this computer.
      if (!server) {
        showWelcome();
        return setStatus(
          "error",
          "Not invited yet",
          `That account is not on ${placeOf(hub)}'s list: it is by invitation for now. Use ${PLUGIN_NAME} on this computer instead, free, or ask for an invitation.`,
        );
      }
      return showTokenForm("Not on this hub's list", `That account is not on ${placeOf(hub)}'s list. Ask whoever runs it to add you, or paste the invite you were given.`);
    }
    if (body?.error && body.error !== "authorization_pending" && body.error !== "slow_down") break;
  }
  if (run === signInRun) showTokenForm("Sign-in timed out", "The code expired before you signed in. Press Sign in with the browser again.");
}

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

/** Schedules the next try and returns how long it waits. */
function scheduleReconnect(): number {
  if (stopped) return 0;
  const steps = server ? REMOTE_BACKOFF_MS : RECONNECT_BACKOFF_MS;
  const wait = steps[Math.min(attempt, steps.length - 1)]!;
  attempt++;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => toSandbox({ kind: "need-hello" }), wait);
  return wait;
}

function connect(): void {
  if (!token) return !server && !localChosen ? showWelcome() : showTokenForm("Paste your token", tokenSource());
  if (!hello) return;
  window.clearTimeout(stableTimer);
  window.clearTimeout(retryTimer);
  // At most one live socket per window. A second one with the same instanceId
  // makes the bridge replace the first (4004); detach the old one first so its
  // close is recognised as superseded below, not as a failure to react to.
  const previous = ws;
  ws = null;
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close(1000, "superseded");
  const socket = new WebSocket(urlOf(server));
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
        // A team's hub says whose token this is: the card names it, so a wrong token shows at a glance.
        person = msg.person ?? null;
        session = { id: msg.sessionId, version: msg.serverVersion };
        tokenForm.hidden = true;
        signInBox.hidden = true;
        signInRun++; // a sign-in still asking is done
        setStatus("ok", "Connected", `Your AI apps can work in ${fileName()}.`);
        paint();
        activity(server ? `connected to ${placeOf(server)}` : "connected");
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
    session = null;
    window.clearTimeout(stableTimer);
    if (TERMINAL_CLOSE_CODES.includes(ev.code)) {
      stopped = true;
      if (ev.code === CLOSE.AUTH_FAILED) {
        stopped = false; // a new token restarts the loop
        const refused = tokenFingerprint(token);
        token = null;
        person = null;
        return server
          ? showTokenForm("Token not accepted", `${placeOf(server)} did not accept this token (${refused}). It may have been revoked: ask for a new one.`)
          : showTokenForm(
              "Token not accepted",
              `This token (${refused}) does not match Figxel on this computer. Paste the current one: ${SETUP_COMMAND} prints it with its fingerprint.`,
            );
      }
      paint();
      if (ev.code === CLOSE.SESSION_REPLACED) {
        return setStatus("error", "Open in another window", `${PLUGIN_NAME} took over in another Figma window. Use that one, or close it and run ${PLUGIN_NAME} here again.`);
      }
      if (ev.code === CLOSE.PROTOCOL_MISMATCH) return setStatus("error", "Update needed", ev.reason ? `${ev.reason}. ${UPDATE_STEPS}` : UPDATE_STEPS);
      return setStatus("error", "Connection refused", ev.reason || `Closed with ${ev.code}.`);
    }
    if (ev.code === CLOSE.SERVER_SHUTDOWN) activity(server ? "the team hub restarted" : "your AI app closed Figxel");
    const wait = Math.round(scheduleReconnect() / 1000);
    const again = wait > 0 ? `trying again in ${wait} s` : "trying again";
    if (server) {
      setStatus("wait", `Can't reach ${placeOf(server)}`, `${placeOf(server)} is not answering. Check your internet connection; ${again}.`);
    } else {
      setStatus("wait", "Waiting for your AI app", `${PLUGIN_NAME} starts with your AI app. Start a chat that uses it; this window connects by itself.`);
    }
    paint();
  };
}

/** Saves the choice (with an invite's token) and reconnects: the sandbox answers with an init carrying that server's token. */
function switchTo(next: string | null, inviteToken?: string): void {
  signInRun++; // a sign-in to the other server stops asking
  signInBox.hidden = true;
  serverForm.hidden = true;
  serverError.hidden = true;
  tokenForm.hidden = true;
  stopped = false;
  attempt = 0;
  person = null;
  session = null;
  server = next;
  if (next) lastHub = next;
  setStatus("wait", "Connecting…", `To ${placeOf(next)}.`);
  paint();
  toSandbox({ kind: "save-server", server: next, ...(next && inviteToken ? { token: inviteToken } : {}) });
}

function showServerForm(): void {
  serverForm.hidden = false;
  serverError.hidden = true;
  serverInput.value = server ?? lastHub ?? "";
  serverInput.focus();
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
      server = msg.server;
      lastHub = msg.lastHub ?? msg.server;
      hello = msg.hello;
      paint();
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
  // An invite carries the token after its #.
  const value = parseInvite(tokenInput.value)?.token ?? tokenInput.value.trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    detailEl.textContent = server ? "An invite looks like wss://…#… (64 characters after the #)." : "A token is 64 characters, 0-9 and a-f.";
    return;
  }
  signInRun++;
  signInBox.hidden = true;
  token = value;
  tokenInput.value = "";
  tokenForm.hidden = true;
  toSandbox({ kind: "save-token", token: value });
  stopped = false;
  attempt = 0;
  setStatus("wait", "Connecting…", `To ${placeOf(server)}.`);
  paint();
  toSandbox({ kind: "need-hello" }); // connect() replaces the current socket, if any
};

changeTokenBtn.onclick = () => {
  tokenForm.hidden = false;
  tokenLabel.textContent = server ? `New token for ${placeOf(server)}` : "New token for this computer";
  detailEl.textContent = "Paste the new token. You stay connected until you save.";
  tokenInput.focus();
};

useLocalBtn.onclick = () => {
  localChosen = true;
  if (server) switchTo(null);
  else {
    serverForm.hidden = true;
    if (!token) showTokenForm("Paste your token", tokenSource());
  }
};

useLocalFirst.onclick = () => {
  localChosen = true;
  showTokenForm("Paste your token", tokenSource());
};

useHubBtn.onclick = () => {
  if (server) return;
  // The hub used last, else Figxel Cloud: an address is typed only for another hub (Change).
  switchTo(lastHub ?? CLOUD_URL);
};

changeHubBtn.onclick = showServerForm;

signInBtn.onclick = () => void signInWithBrowser();

/**
 * Reset: forget the hub, every token and sign-in this plugin saved in Figma,
 * and start from the first screen. A second click within a few seconds
 * confirms it, since a plugin window cannot rely on a dialog.
 */
let resetArmed = 0;
resetBtn.onclick = () => {
  if (Date.now() - resetArmed > 5000) {
    resetArmed = Date.now();
    resetBtn.textContent = "Click again to forget the hub, tokens and sign-ins";
    window.setTimeout(() => (resetBtn.textContent = "Reset Figxel in this Figma"), 5000);
    return;
  }
  resetArmed = 0;
  resetBtn.textContent = "Reset Figxel in this Figma";
  signInRun++;
  window.clearTimeout(retryTimer);
  window.clearTimeout(stableTimer);
  const previous = ws;
  ws = null;
  previous?.close(1000, "reset");
  token = null;
  server = null;
  lastHub = null;
  person = null;
  session = null;
  stopped = false;
  attempt = 0;
  serverForm.hidden = true;
  signInBox.hidden = true;
  localChosen = false;
  activity("reset: the hub, tokens and sign-ins are forgotten");
  setStatus("wait", "Starting over…");
  paint();
  toSandbox({ kind: "reset" }); // the sandbox clears its storage and answers with a fresh init
};

serverForm.onsubmit = (ev) => {
  ev.preventDefault();
  // An invite is the hub's address and the person's token in one paste.
  const invite = parseInvite(serverInput.value);
  const parsed = parseServer(invite ? invite.url : serverInput.value);
  if (!parsed.ok) {
    serverError.textContent = parsed.error;
    serverError.hidden = false;
    return;
  }
  switchTo(parsed.server, invite?.token);
};

setStatus("wait", "Starting…");
paint();
