// The WebSocket half of the bridge — protocol.md end to end.
//
// It does not know what a "frame" or a "text" is (spec §5.1): it forwards
// {op, params} to a plugin session and returns the result. Everything it
// enforces — handshake, sequential queue, idle timer, chunk reassembly,
// in-flight idempotency, heartbeat — is protocol, not design knowledge.
//
// Several MCP clients can share one Figma connection (so no single AI app
// owns Figma): the process that binds the port is the HUB and owns the
// plugin sessions; a process that finds the port held by a compatible hub
// becomes a PROXY and forwards its calls (src/server/peer.ts). When the hub
// exits, the proxies race for the port and the plugin reconnects to the
// winner. Spec §4.2 anticipated this split; the plugin protocol is unchanged.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { callRefusal } from "../shared/editors.js";
import { BridgeError, ErrorCode, isErrorCode } from "../shared/errors.js";
import { OPS } from "../shared/ops.js";
import {
  CLOSE,
  DEFAULT_LIMITS,
  HEARTBEAT_MISSES,
  HELLO_TIMEOUT_MS,
  HOST,
  PROTOCOL_VERSION,
  type BinaryData,
  type CancelReason,
  type HelloMsg,
  type Limits,
  type LogLevel,
  type PluginToServer,
  type ServerToPlugin,
} from "../shared/protocol.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME, SETUP_COMMAND, VERSION } from "../shared/version.js";
import type { Logger } from "./config.js";
import { parseFrame } from "./frames.js";
import { PLUGIN_BUILD_ID } from "./plugin-build.js";
import {
  PEER_PROTOCOL_VERSION,
  parseHubToPeer,
  parsePeerToHub,
  type HubToPeer,
  type PeerError,
  type PeerToHub,
} from "./peer.js";
import { SessionRegistry, type SessionState } from "./sessions.js";

/** How long a refused token keeps shaping the NO_SESSION hint (spec §5.7.4 layer 4). */
const AUTH_FAILURE_HINT_MS = 10 * 60_000;
/** spec §4.6 — retry every 5 s while the port is held by something that is not a compatible hub. */
const LISTEN_RETRY_MS = 5_000;
/** After losing a hub, race for the port quickly before settling into the slow retry. */
const FAST_ELECTION_MS = 250;
const FAST_ELECTION_ATTEMPTS = 20;
const PEER_HANDSHAKE_MS = 2_000;
const PEER_STATUS_MS = 2_000;

// Measured 2026-10-07 on Figma desktop 126.9.11: `Ctrl+/` opens no quick-action
// surface, and Figma's own accessibility text advertises `Ctrl+K` instead. The
// hint names the menu path first because it is the path that always works, and
// mentions the chord as a convenience rather than as the instruction. Auto-launch
// is gone (ADR #32) — nothing types into the operator's screen for them. A
// first-time user has no plugin in that menu yet, so the hint also names the
// setup command, which copies the plugin and prints the manifest to import.
export const NO_SESSION_HINT =
  `Open the plugin in Figma: ${PLUGIN_MENU_PATH}. Once it is open it reconnects by itself, so this is needed only after Figma restarts or the plugin window is closed. ` +
  `Not in that menu yet: run \`${SETUP_COMMAND}\` and import the plugin from the manifest it prints.`;
export const TOKEN_HINT =
  `A plugin tried to connect but its token is wrong — run \`${SETUP_COMMAND}\`, which prints the token, and paste it into the ${PLUGIN_NAME} plugin.`;
export const HUB_LOST_HINT =
  `The ${PRODUCT_NAME} process that held the Figma connection exited; another one takes over within seconds. Retry — with the same idempotencyKey for write tools.`;

/**
 * What to do after a STALLED, by what the call was. request() gives every write
 * an idempotencyKey and every other call none, so the key tells them apart: a
 * write is retried with its key, which never runs twice; a read, an export or
 * a view change has no key to name, and calling it again changes no design
 * data. The 2026-10-13 acceptance run was told to reuse a key that
 * figma_suggest_fonts does not have. A plugin whose window is behind another
 * one yields about once a second [C-124], the usual slow-but-alive case.
 *
 * `quietSinceMs`: the plugin has answered nothing since it connected that long
 * ago. The plugin runs one op at a time and outlives the server process that
 * sent it one, so after a hub change it can still be busy with an op this hub
 * never sent (2026-10-13: a video render, for minutes [C-198]).
 */
export function stalledHint(idempotencyKey: string | undefined, quietSinceMs?: number): string {
  const busy =
    quietSinceMs === undefined
      ? ""
      : `The plugin has answered nothing since it connected ${Math.round(quietSinceMs / 1000)} s ago, so it may still be finishing an op an earlier ${PRODUCT_NAME} process sent it (a video render holds it up to about 4 min). `;
  const look = "Check whether Figma is frozen, or behind another window, where the plugin runs slowly";
  return idempotencyKey
    ? `${busy}${look}; retry with the same idempotencyKey (${idempotencyKey}), which never runs twice.`
    : `${busy}${look}; then call the tool again. It changes no design data, so a retry is safe.`;
}

/**
 * Ops that hold the plugin for minutes, and that Figma cannot interrupt once
 * begun: one exportAsync call renders the whole video [C-197] [C-198]. While
 * one runs, a new call answers BUSY at once instead of queueing behind it. On
 * 2026-10-13 three reads waited silently behind a render until the MCP client
 * cut them at 60 s; the client then restarted the hub's process [C-271], which
 * took the shared Figma connection, and the render a proxy was waiting for, with it.
 */
const HOLDS_THE_PLUGIN: ReadonlySet<string> = new Set(["export_video"]);
/** After this long a render is past the usual, and a minimized Figma window is the likely cause [C-198]. */
const RENDER_SLOW_MS = 120_000;

/** The BUSY a call gets while a render holds the plugin. Nothing was sent, so nothing ran. */
export function renderBusyError(render: { jobId: string | undefined; elapsedMs: number | null; cancelled: boolean }, idempotencyKey: string | undefined): BridgeError {
  const what = `a video render${render.jobId ? ` (figma_export_video job "${render.jobId}")` : ""}`;
  const s = render.elapsedMs === null ? null : Math.round(render.elapsedMs / 1000);
  const message =
    s === null
      ? `Figma is about to start ${what}; this call was not sent to Figma.`
      : render.cancelled
        ? `Figma is still finishing ${what} that was cancelled, ${s} s after it began: Figma cannot stop a render it has begun. This call was not sent to Figma.`
        : `Figma is busy with ${what}, ${s} s so far; this call was not sent to Figma.`;
  const hint = [
    `Nothing changed, so a retry is safe${idempotencyKey ? ` with the same idempotencyKey (${idempotencyKey})` : ""}: call again once the render ends.`,
    "Figma renders one thing at a time and ends a render it has not finished in about 4 min.",
    render.jobId ? `Whoever started it collects it with figma_export_video { jobId: "${render.jobId}" }; do not start another export meanwhile.` : "Do not start another export meanwhile.",
    ...(s !== null && s * 1000 >= RENDER_SLOW_MS ? ["No result after 2 min: a minimized Figma window stops video export, so ask the user to restore it."] : []),
  ].join(" ");
  return new BridgeError(ErrorCode.BUSY, message, { hint, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

export type Role = "hub" | "proxy" | "none";

export interface BridgeOptions {
  token: string;
  logger: Logger;
  port: number;
  sessionWaitMs: number;
  limits?: Partial<Limits>;
  helloTimeoutMs?: number;
  listenRetryMs?: number;
  /** Plugin `log` frames, for MCP `notifications/message` (protocol.md §9). */
  onPluginLog?: (level: LogLevel, message: string, sessionId: string) => void;
  /** BRIDGE_ALLOW_UNVERIFIED of this process: its writes run where the editor cell is still unmeasured. */
  allowUnverified?: boolean;
}

export interface Progress {
  done: number;
  total?: number;
  phase?: string;
}

export interface RequestOptions {
  session?: string;
  idempotencyKey?: string;
  idleTimeoutMs?: number;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
  /** Set by the hub for a call a proxy forwarded: that proxy's BRIDGE_ALLOW_UNVERIFIED. */
  allowUnverified?: boolean;
  /** The figma_export_video job this render belongs to (video-jobs.ts): named in the BUSY other calls get meanwhile. */
  jobId?: string;
}

/** JSON-safe session view — it travels between hub and proxies. */
export interface SessionView extends Omit<SessionState, "ops"> {
  ops: string[];
  active: boolean;
}

export interface BridgeStatus {
  role: Role;
  listening: boolean;
  reason: string | null;
  port: number;
  host: string;
  /** For a proxy: the process holding the Figma connection. */
  hubPid: number | null;
  /** Other server processes sharing this hub (hub only). */
  peers: number;
  lastAuthFailureAt: number | null;
  sessions: SessionView[];
  /**
   * The plugin build id the process holding the Figma connection was built
   * with — the hub's, also when a proxy asks — so figma_status can tell a hub
   * older than dist/ from a current one. null: a hub that predates this field.
   */
  serverBuild: string | null;
  /** That process's own BRIDGE_ALLOW_UNVERIFIED; a proxy's calls run with it OR their own. */
  allowUnverified: boolean;
}

interface Job {
  id: string;
  op: string;
  params: Record<string, unknown>;
  idempotencyKey: string | undefined;
  idleTimeoutMs: number;
  onProgress: ((p: Progress) => void) | undefined;
  lastProgress: Progress | null;
  resolve: (data: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout | null;
  chunks: { head: BinaryData; expected: number; parts: string[] } | null;
  detachSignal: () => void;
  jobId: string | undefined;
}

class Session {
  readonly queue: Job[] = [];
  current: Job | null = null;
  /**
   * A HOLDS_THE_PLUGIN op sent and not yet answered by the plugin — also after
   * the bridge stopped waiting for it (a cancel, a STALLED): the plugin goes on
   * rendering, and only its `result` for that id says it is free again.
   */
  holding: { id: string; jobId: string | undefined; sentAt: number } | null = null;
  /** Whether the plugin has answered a request this bridge was waiting for since it connected. */
  answered = false;
  constructor(
    readonly socket: WebSocket,
    readonly state: SessionState,
  ) {}

  send(msg: ServerToPlugin): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

/** A proxy connected to this hub. */
interface PeerConn {
  socket: WebSocket;
  pid: number;
  calls: Map<string, AbortController>;
}

/** A call this proxy forwarded to the hub. */
interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: BridgeError) => void;
  onProgress: ((p: Progress) => void) | undefined;
  detachSignal: () => void;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function toBridgeError(e: PeerError): BridgeError {
  return new BridgeError(isErrorCode(e.code) ? e.code : ErrorCode.INTERNAL, e.message, {
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
    ...(e.partial !== undefined ? { partial: e.partial } : {}),
  });
}

function toPeerError(err: unknown): PeerError {
  const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
  return {
    code: e.code,
    message: e.message,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
    ...(e.partial !== undefined ? { partial: e.partial } : {}),
  };
}

export class Bridge {
  readonly limits: Limits;
  private readonly opts: BridgeOptions;
  private readonly tokenHash: Buffer;
  private readonly registry = new SessionRegistry<Session>();
  private readonly inflight = new Map<string, { op: string; promise: Promise<unknown> }>();
  private readonly sockets = new Set<WebSocket>();
  private readonly peers = new Set<PeerConn>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private currentRole: Role = "none";
  private reason: string | null = null;
  private boundPort: number;
  private lastAuthFailureAt: number | null = null;
  private nextRequest = 1;
  private nextSession = 1;
  private nextPeerCall = 1;
  private electionAttempts = 0;
  private closed = false;
  // proxy state
  private hub: WebSocket | null = null;
  private hubPid: number | null = null;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly statusWaiters = new Map<string, (status: BridgeStatus | null) => void>();

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.tokenHash = hashToken(opts.token);
    this.boundPort = opts.port;
  }

  get port(): number {
    return this.boundPort;
  }

  get isListening(): boolean {
    return this.currentRole === "hub";
  }

  get role(): Role {
    return this.currentRole;
  }

  /** Resolves after the first election attempt, whatever its outcome (spec §4.6). */
  start(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxFrameBytes });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
    this.heartbeat = setInterval(() => this.beat(), this.limits.heartbeatMs);
    this.heartbeat.unref();
    return this.elect();
  }

  // ── role election: bind the port (hub), or join the hub holding it (proxy) ──

  private async elect(): Promise<void> {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;

    const listened = await this.listenOnce();
    if (this.closed) return;
    if (listened === "ok") {
      this.becomes("hub");
      this.opts.logger.info(`hub: listening on ws://${HOST}:${this.boundPort}`);
      return;
    }
    if (listened === "EADDRINUSE" && (await this.joinHub())) {
      this.becomes("proxy");
      this.opts.logger.info(`proxy: sharing the Figma connection of ${PRODUCT_NAME} process ${this.hubPid}`);
      return;
    }
    this.currentRole = "none";
    this.reason = listened === "EADDRINUSE" ? ErrorCode.PORT_IN_USE : listened;
    const delay = this.electionAttempts++ < FAST_ELECTION_ATTEMPTS ? FAST_ELECTION_MS : this.retryMs;
    if (this.electionAttempts === FAST_ELECTION_ATTEMPTS + 1) {
      this.opts.logger.warn(
        `port ${this.opts.port} is held by something that is not a compatible ${PRODUCT_NAME} hub (${this.reason}) — retrying every ${this.retryMs / 1000} s`,
      );
    }
    this.retryTimer = setTimeout(() => void this.elect(), delay);
    this.retryTimer.unref();
  }

  private becomes(role: Role): void {
    this.currentRole = role;
    this.reason = null;
    this.electionAttempts = 0;
  }

  private listenOnce(): Promise<"ok" | string> {
    return new Promise((resolve) => {
      const http = createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" }).end(`${PRODUCT_NAME} bridge: WebSocket only\n`);
      });
      http.on("upgrade", (req, socket, head) => {
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
      });
      http.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      http.listen(this.opts.port, HOST, () => {
        this.http = http;
        this.boundPort = (http.address() as AddressInfo).port;
        resolve("ok");
      });
    });
  }

  private get retryMs(): number {
    return this.opts.listenRetryMs ?? LISTEN_RETRY_MS;
  }

  /** Try to join the hub holding the port; true on `peer-welcome`. */
  private joinHub(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(`ws://${HOST}:${this.opts.port}`, { maxPayload: this.limits.maxFrameBytes });
      const done = (ok: boolean, why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opts.logger.debug(`peer: join ${HOST}:${this.opts.port} → ${ok ? "welcomed" : why}`);
        if (!ok) ws.terminate();
        resolve(ok);
      };
      // A foreign process, an older version, or another installation never welcomes us.
      const timer = setTimeout(() => done(false, `no welcome (not a compatible ${PRODUCT_NAME} hub)`), PEER_HANDSHAKE_MS);
      ws.on("open", () => {
        const hello: PeerToHub = {
          t: "peer-hello",
          protocolVersion: PEER_PROTOCOL_VERSION,
          token: this.opts.token,
          pid: process.pid,
          serverVersion: VERSION,
        };
        ws.send(JSON.stringify(hello));
      });
      ws.on("message", (raw) => {
        const msg = parseHubToPeer(String(raw));
        if (!msg) return;
        if (msg.t === "peer-welcome") {
          this.hub = ws;
          this.hubPid = msg.hubPid;
          done(true, "welcomed");
          return;
        }
        this.onHubMessage(msg);
      });
      ws.on("close", () => {
        if (!settled) return done(false, "closed before welcome");
        if (this.hub === ws) this.onHubLost();
      });
      ws.on("error", () => {});
    });
  }

  private onHubLost(): void {
    this.hub = null;
    this.hubPid = null;
    this.currentRole = "none";
    // Every pending call was forwarded to the hub, which may have sent it on to
    // the plugin: its outcome is unknown, so it is marked as dispatched (results.ts).
    for (const [id, call] of this.pendingCalls) {
      this.pendingCalls.delete(id);
      call.detachSignal();
      call.reject(
        new BridgeError(ErrorCode.NO_SESSION, "The shared Figma connection went away mid-call.", {
          hint: HUB_LOST_HINT,
          partial: { dispatched: true },
        }),
      );
    }
    for (const w of this.statusWaiters.values()) w(null);
    this.statusWaiters.clear();
    if (this.closed) return;
    this.opts.logger.info("proxy: the hub exited — racing for the port");
    void this.elect();
  }

  private onHubMessage(msg: HubToPeer): void {
    switch (msg.t) {
      case "call-progress": {
        const p: Progress = { done: msg.done };
        if (msg.total !== undefined) p.total = msg.total;
        if (msg.phase !== undefined) p.phase = msg.phase;
        this.pendingCalls.get(msg.id)?.onProgress?.(p);
        return;
      }
      case "call-result": {
        const call = this.pendingCalls.get(msg.id);
        if (!call) return;
        this.pendingCalls.delete(msg.id);
        call.detachSignal();
        if (msg.ok) call.resolve(msg.data);
        else call.reject(toBridgeError(msg.error));
        return;
      }
      case "status-result": {
        const w = this.statusWaiters.get(msg.id);
        this.statusWaiters.delete(msg.id);
        w?.(msg.status as BridgeStatus);
        return;
      }
      case "peer-welcome":
        return;
    }
  }

  // ── connection & handshake (hub) ──────────────────────────────────────────

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", (err) => this.opts.logger.debug(`socket error: ${err.message}`));

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      this.opts.logger.warn(`rejected a connection from origin ${origin}`);
      socket.close(CLOSE.FORBIDDEN_ORIGIN, "FORBIDDEN_ORIGIN");
      return;
    }

    let session: Session | null = null;
    let peer: PeerConn | null = null;
    const helloTimer = setTimeout(
      () => socket.close(CLOSE.HELLO_TIMEOUT, "HELLO_TIMEOUT"),
      this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );

    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const text = raw.toString();
      if (peer) return this.onPeerFrame(peer, text);
      if (!session && text.includes('"peer-hello"')) {
        const msg = parsePeerToHub(text);
        if (msg?.t === "peer-hello") {
          clearTimeout(helloTimer);
          peer = this.onPeerHello(socket, msg);
          return;
        }
      }
      const parsed = parseFrame(text);
      if (!parsed.ok) {
        this.opts.logger.debug(`ignored frame: ${parsed.reason}`);
        return;
      }
      const msg = parsed.msg;
      if (msg.t === "hello") {
        if (session) {
          socket.close(CLOSE.DUPLICATE_HELLO, "DUPLICATE_HELLO");
          return;
        }
        clearTimeout(helloTimer);
        session = this.onHello(socket, msg);
        return;
      }
      if (!session) return; // nothing but hello counts before the handshake
      session.state.lastSeenAt = Date.now();
      this.onFrame(session, msg);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (session) this.dropSession(session, "plugin disconnected (likely closed)");
      if (peer) {
        this.peers.delete(peer);
        for (const ac of peer.calls.values()) ac.abort();
        this.opts.logger.info(`hub: ${PRODUCT_NAME} process ${peer.pid} stopped sharing`);
      }
    });
  }

  private tokenMatches(token: string): boolean {
    return timingSafeEqual(hashToken(token), this.tokenHash);
  }

  private onHello(socket: WebSocket, hello: HelloMsg): Session | null {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      socket.close(CLOSE.PROTOCOL_MISMATCH, `PROTOCOL_MISMATCH: bridge speaks ${PROTOCOL_VERSION}`);
      return null;
    }
    if (!this.tokenMatches(hello.token)) {
      this.lastAuthFailureAt = Date.now();
      this.opts.logger.warn("rejected a plugin connection: wrong token");
      socket.close(CLOSE.AUTH_FAILED, "AUTH_FAILED");
      return null;
    }
    const now = Date.now();
    const session = new Session(socket, {
      sessionId: `s-${this.nextSession++}`,
      instanceId: hello.instanceId,
      pluginVersion: hello.pluginVersion,
      buildId: hello.buildId,
      apiVersion: hello.apiVersion,
      editorType: hello.editorType,
      ops: new Set(hello.ops),
      file: hello.file,
      page: hello.page,
      user: hello.user,
      connectedAt: now,
      lastSeenAt: now,
      lastActiveAt: now,
      selection: null,
      lastNodesChanged: null,
    });
    const replaced = this.registry.add(session);
    if (replaced) {
      this.failAll(replaced, "replaced by a new connection from the same plugin window");
      replaced.socket.close(CLOSE.SESSION_REPLACED, "SESSION_REPLACED");
    }
    session.send({
      t: "welcome",
      sessionId: session.state.sessionId,
      serverVersion: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      limits: this.limits,
    });
    this.opts.logger.info(
      `session ${session.state.sessionId} connected: "${hello.file.name ?? "untitled"}" (plugin ${hello.pluginVersion})`,
    );
    return session;
  }

  private onPeerHello(socket: WebSocket, hello: Extract<PeerToHub, { t: "peer-hello" }>): PeerConn | null {
    if (hello.protocolVersion !== PEER_PROTOCOL_VERSION) {
      socket.close(CLOSE.PROTOCOL_MISMATCH, `PROTOCOL_MISMATCH: hub speaks peer protocol ${PEER_PROTOCOL_VERSION}`);
      return null;
    }
    if (!this.tokenMatches(hello.token)) {
      // Another installation (different BRIDGE_HOME). Not a plugin token problem, so no plugin hint.
      this.opts.logger.warn(`rejected ${PRODUCT_NAME} process ${hello.pid}: different token`);
      socket.close(CLOSE.AUTH_FAILED, "AUTH_FAILED");
      return null;
    }
    const peer: PeerConn = { socket, pid: hello.pid, calls: new Map() };
    this.peers.add(peer);
    this.sendPeer(peer, { t: "peer-welcome", hubPid: process.pid, serverVersion: VERSION });
    this.opts.logger.info(`hub: ${PRODUCT_NAME} process ${hello.pid} (${hello.serverVersion}) is sharing this Figma connection`);
    return peer;
  }

  private sendPeer(peer: PeerConn, msg: HubToPeer): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(msg));
  }

  private onPeerFrame(peer: PeerConn, text: string): void {
    const msg = parsePeerToHub(text);
    if (!msg) return;
    switch (msg.t) {
      case "call": {
        const ac = new AbortController();
        peer.calls.set(msg.id, ac);
        this.request(msg.op, msg.params, {
          ...msg.opts,
          signal: ac.signal,
          onProgress: (p) => this.sendPeer(peer, { t: "call-progress", id: msg.id, ...p }),
        })
          .then((data) => this.sendPeer(peer, { t: "call-result", id: msg.id, ok: true, data }))
          .catch((err: unknown) => this.sendPeer(peer, { t: "call-result", id: msg.id, ok: false, error: toPeerError(err) }))
          .finally(() => peer.calls.delete(msg.id));
        return;
      }
      case "call-cancel":
        peer.calls.get(msg.id)?.abort();
        return;
      case "status-request":
        this.sendPeer(peer, { t: "status-result", id: msg.id, status: this.status() });
        return;
      case "peer-hello":
        peer.socket.close(CLOSE.DUPLICATE_HELLO, "DUPLICATE_HELLO");
        return;
    }
  }

  private onFrame(session: Session, msg: PluginToServer): void {
    const st = session.state;
    switch (msg.t) {
      case "pong":
        return;
      case "event":
        if (msg.name === "selection_changed") {
          st.selection = msg.data;
          st.lastActiveAt = Date.now();
        } else if (msg.name === "page_changed") {
          st.page = { id: msg.data.pageId, name: msg.data.pageName };
          st.lastActiveAt = Date.now();
        } else {
          st.lastNodesChanged = { count: msg.data.count, at: msg.data.at };
        }
        return;
      case "log":
        this.opts.logger[msg.level](`plugin ${st.sessionId}: ${msg.message}`);
        this.opts.onPluginLog?.(msg.level, msg.message, st.sessionId);
        return;
      case "progress": {
        const job = session.current;
        if (!job || job.id !== msg.id) return;
        const p: Progress = { done: msg.done };
        if (msg.total !== undefined) p.total = msg.total;
        if (msg.phase !== undefined) p.phase = msg.phase;
        job.lastProgress = p;
        this.armIdle(session, job);
        job.onProgress?.(p);
        return;
      }
      case "chunk": {
        const job = session.current;
        if (!job || job.id !== msg.id || !job.chunks) return;
        if (msg.seq !== job.chunks.parts.length) {
          this.finish(session, job, new BridgeError(ErrorCode.INTERNAL, `chunk ${msg.seq} arrived out of order`));
          return;
        }
        job.chunks.parts.push(msg.base64);
        this.armIdle(session, job);
        if (job.chunks.parts.length === job.chunks.expected) {
          const { head, parts } = job.chunks;
          const { chunks: _n, ...rest } = head;
          this.finish(session, job, { ...rest, base64: parts.join("") });
        }
        return;
      }
      case "result": {
        // The plugin is free of a render once it answers it, waited for or not.
        if (session.holding?.id === msg.id) session.holding = null;
        const job = session.current;
        if (!job || job.id !== msg.id) {
          this.opts.logger.debug(`ignored a result for ${msg.id} (no longer waiting)`);
          return;
        }
        session.answered = true;
        if (!msg.ok) {
          const code = isErrorCode(msg.error.code) ? msg.error.code : ErrorCode.INTERNAL;
          this.finish(
            session,
            job,
            new BridgeError(code, msg.error.message, {
              ...(msg.error.hint !== undefined ? { hint: msg.error.hint } : {}),
              ...(msg.partial !== undefined ? { partial: msg.partial } : {}),
            }),
          );
          return;
        }
        const head = msg.data as Partial<BinaryData> | null;
        if (head && typeof head === "object" && typeof head.chunks === "number" && head.chunks > 0) {
          job.chunks = { head: head as BinaryData, expected: head.chunks, parts: [] };
          this.armIdle(session, job);
          return;
        }
        this.finish(session, job, msg.data);
        return;
      }
      case "hello":
        return; // handled before onFrame
    }
  }

  // ── requests ──────────────────────────────────────────────────────────────

  /**
   * Forward an op to a plugin session — directly as the hub, or through the
   * hub as a proxy. Rejects only with BridgeError. Write ops always carry an
   * idempotencyKey (agent-supplied or generated here, so even a proxy that
   * loses its hub mid-call can return it), and every result/error for them
   * carries it back (protocol.md §3).
   */
  async request(op: string, params: Record<string, unknown>, opts: RequestOptions = {}): Promise<unknown> {
    const info = OPS.get(op);
    const write = info?.write ?? false;
    const key = write ? (opts.idempotencyKey ?? `k-${randomUUID()}`) : undefined;

    if (this.currentRole === "proxy") return this.forwardToHub(op, params, opts, key);

    if (key) {
      const existing = this.inflight.get(key);
      if (existing) {
        if (existing.op !== op) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `idempotencyKey already used for op \`${existing.op}\``, {
            idempotencyKey: key,
          });
        }
        return existing.promise; // attach: same promise, no new frame
      }
    }

    const promise = this.dispatch(op, params, opts, key, info?.exportOp ?? false);
    if (key) {
      this.inflight.set(key, { op, promise });
      promise.then(
        () => this.inflight.delete(key),
        () => this.inflight.delete(key),
      );
    }
    return promise;
  }

  private forwardToHub(op: string, params: Record<string, unknown>, opts: RequestOptions, key: string | undefined): Promise<unknown> {
    const hub = this.hub;
    if (!hub || hub.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeError(ErrorCode.NO_SESSION, "The shared Figma connection is changing hands.", {
          hint: HUB_LOST_HINT,
          ...(key ? { idempotencyKey: key } : {}),
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const id = `c-${this.nextPeerCall++}`;
      const call: PendingCall = {
        resolve,
        reject: (err) => reject(err.withKey(key)),
        onProgress: opts.onProgress,
        detachSignal: () => {},
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled by the MCP client.").withKey(key));
          return;
        }
        const onAbort = () => {
          if (!this.pendingCalls.delete(id)) return;
          const msg: PeerToHub = { t: "call-cancel", id };
          if (hub.readyState === WebSocket.OPEN) hub.send(JSON.stringify(msg));
          call.reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled by the MCP client."));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        call.detachSignal = () => opts.signal!.removeEventListener("abort", onAbort);
      }
      this.pendingCalls.set(id, call);
      const msg: PeerToHub = {
        t: "call",
        id,
        op,
        params,
        opts: {
          ...(opts.session !== undefined ? { session: opts.session } : {}),
          ...(key !== undefined ? { idempotencyKey: key } : {}),
          ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
          // This process's flag, not the hub's: a measuring run joins the user's
          // hub as a proxy and must not need the user's own client restarted.
          ...(this.opts.allowUnverified ? { allowUnverified: true } : {}),
          ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
        },
      };
      hub.send(JSON.stringify(msg));
    });
  }

  private async dispatch(
    op: string,
    params: Record<string, unknown>,
    opts: RequestOptions,
    key: string | undefined,
    exportOp: boolean,
  ): Promise<unknown> {
    if (this.currentRole === "none" && this.reason === ErrorCode.PORT_IN_USE) {
      throw new BridgeError(ErrorCode.PORT_IN_USE, `Port ${this.opts.port} is held by a process that is not a compatible ${PRODUCT_NAME} server.`, {
        hint: `Close whatever holds the port (another program, or an older ${PRODUCT_NAME} version); this bridge takes over automatically within ≤ 5 s.`,
        ...(key ? { idempotencyKey: key } : {}),
      });
    }

    // The hub's flag OR the forwarding proxy's, for this call only.
    const allowUnverified = this.opts.allowUnverified === true || opts.allowUnverified === true;
    const runsThere = (s: Session) => this.editorRefusal(op, params, s, allowUnverified) === null;
    const session = await this.registry.waitFor(opts.session, this.opts.sessionWaitMs, runsThere);
    if (!session) throw this.noSession(opts.session, key);

    // The editor first, then "too old" [C-129]: a board asked for a Design-only
    // op gets the true reason, not "the plugin is older". Nothing is
    // sent, so a write says it changed nothing (created: []) and is safe to retry.
    const refused = this.editorRefusal(op, params, session, allowUnverified, true);
    if (refused) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, refused.message, {
        hint: refused.hint,
        ...(OPS.get(op)?.write ? { partial: { created: [] } } : {}),
        ...(key ? { idempotencyKey: key } : {}),
      });
    }

    if (!session.state.ops.has(op)) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, `The connected plugin does not implement op "${op}".`, {
        hint:
          `The connected plugin is older than this server: ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}). ` +
          `If the op is still missing, run \`${SETUP_COMMAND}\` and import the plugin from the manifest it prints.`,
        ...(key ? { idempotencyKey: key } : {}),
      });
    }

    // Not queued behind a render: the call would wait minutes in silence, past
    // the client's own timeout [C-197], and nothing could cut the render short.
    const render = this.renderAhead(session);
    if (render) throw renderBusyError(render, key);

    if (session.queue.length >= this.limits.maxQueueDepth) {
      throw new BridgeError(ErrorCode.BUSY, "Queue full.", {
        hint: "Wait for previous requests to finish, then retry.",
        ...(key ? { idempotencyKey: key } : {}),
      });
    }

    const idleTimeoutMs =
      opts.idleTimeoutMs ?? (exportOp ? this.limits.exportIdleTimeoutMs : this.limits.idleTimeoutMs);

    return new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        id: `r-${this.nextRequest++}`,
        op,
        params,
        idempotencyKey: key,
        idleTimeoutMs,
        onProgress: opts.onProgress,
        lastProgress: null,
        resolve,
        reject: (err) => reject(err.withKey(key)),
        timer: null,
        chunks: null,
        detachSignal: () => {},
        jobId: opts.jobId,
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled by the MCP client.").withKey(key));
          return;
        }
        const onAbort = () => this.cancel(session, job, "CLIENT_CANCELLED");
        opts.signal.addEventListener("abort", onAbort, { once: true });
        job.detachSignal = () => opts.signal!.removeEventListener("abort", onAbort);
      }
      session.queue.push(job);
      this.pump(session);
    });
  }

  /** shared/editors.ts callRefusal for one session; `named` adds the session and the other connected files to the text. */
  private editorRefusal(op: string, params: Record<string, unknown>, session: Session, allowUnverified: boolean, named = false) {
    const st = session.state;
    return callRefusal(op, params, st.editorType, {
      allowUnverified,
      layer: "bridge",
      ...(named
        ? {
            session: { sessionId: st.sessionId, file: st.file.name },
            others: this.registry
              .list()
              .filter((s) => s !== session)
              .map((s) => ({ sessionId: s.state.sessionId, file: s.state.file.name, editorType: s.state.editorType })),
          }
        : {}),
    });
  }

  /** The render that holds the plugin, or waits in the queue to: what a new call would wait behind. */
  private renderAhead(session: Session): { jobId: string | undefined; elapsedMs: number | null; cancelled: boolean } | null {
    const held = session.holding;
    if (held) return { jobId: held.jobId, elapsedMs: Date.now() - held.sentAt, cancelled: session.current?.id !== held.id };
    const queued = session.queue.find((j) => HOLDS_THE_PLUGIN.has(j.op));
    return queued ? { jobId: queued.jobId, elapsedMs: null, cancelled: false } : null;
  }

  private pump(session: Session): void {
    if (session.current || !this.registry.has(session.state.sessionId)) return;
    const job = session.queue.shift();
    if (!job) return;
    session.current = job;
    if (HOLDS_THE_PLUGIN.has(job.op)) session.holding = { id: job.id, jobId: job.jobId, sentAt: Date.now() };
    session.send({
      t: "request",
      id: job.id,
      op: job.op,
      params: job.params,
      idleTimeoutMs: job.idleTimeoutMs,
      ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
    });
    this.armIdle(session, job);
  }

  private armIdle(session: Session, job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      session.send({ t: "cancel", id: job.id, reason: "STALLED" });
      const last = job.lastProgress ? ` Last progress: ${job.lastProgress.done}/${job.lastProgress.total ?? "?"}.` : "";
      this.finish(
        session,
        job,
        new BridgeError(ErrorCode.STALLED, `The operation stopped reporting for ${job.idleTimeoutMs / 1000} s.${last}`, {
          hint: stalledHint(job.idempotencyKey, session.answered ? undefined : Date.now() - session.state.connectedAt),
        }),
      );
    }, job.idleTimeoutMs);
  }

  private cancel(session: Session, job: Job, reason: CancelReason): void {
    const queued = session.queue.indexOf(job);
    if (queued >= 0) {
      session.queue.splice(queued, 1);
      job.detachSignal();
      job.reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled before it was sent to the plugin."));
      return;
    }
    if (session.current === job) {
      session.send({ t: "cancel", id: job.id, reason });
      this.finish(session, job, new BridgeError(ErrorCode.CANCELLED, `Cancelled (${reason}).`));
    }
  }

  /** Settle the in-flight job and send the next one. */
  private finish(session: Session, job: Job, outcome: unknown): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.detachSignal();
    if (session.current === job) session.current = null;
    if (outcome instanceof BridgeError) {
      job.reject(outcome);
    } else {
      job.resolve(withKey(outcome, job.idempotencyKey));
    }
    this.pump(session);
  }

  private failAll(session: Session, why: string): void {
    const inFlight = session.current;
    const jobs = [...(inFlight ? [inFlight] : []), ...session.queue];
    session.current = null;
    session.queue.length = 0;
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.detachSignal();
      const last = job.lastProgress ? ` Last progress: ${job.lastProgress.done}/${job.lastProgress.total ?? "?"}.` : "";
      job.reject(
        new BridgeError(ErrorCode.NO_SESSION, `${why[0]!.toUpperCase()}${why.slice(1)}.${last}`, {
          hint: job.idempotencyKey
            ? "Inspect the canvas (figma_search_nodes) before retrying — if the plugin closed mid-op its outcome is unknown. A retry with the same idempotencyKey never executes twice while the plugin stays open."
            : NO_SESSION_HINT,
          // The job in flight was sent, so it may have landed — not safe to
          // retry blind (results.ts). A queued one never left the bridge.
          ...(job === inFlight ? { partial: { dispatched: true } } : {}),
        }),
      );
    }
  }

  private dropSession(session: Session, why: string): void {
    if (!this.registry.has(session.state.sessionId)) return;
    this.registry.remove(session.state.sessionId);
    this.failAll(session, why);
    this.opts.logger.info(`session ${session.state.sessionId} ended: ${why}`);
  }

  private noSession(arg: string | undefined, key: string | undefined): BridgeError {
    const recentAuthFailure =
      this.lastAuthFailureAt !== null && Date.now() - this.lastAuthFailureAt < AUTH_FAILURE_HINT_MS;
    const message =
      arg && this.registry.size > 0
        ? `No connected Figma session matches "${arg}".`
        : "No Figma plugin is connected.";
    return new BridgeError(ErrorCode.NO_SESSION, message, {
      hint: recentAuthFailure ? TOKEN_HINT : NO_SESSION_HINT,
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  // ── heartbeat, status, shutdown ───────────────────────────────────────────

  private beat(): void {
    const now = Date.now();
    for (const s of this.registry.list()) {
      if (now - s.state.lastSeenAt > this.limits.heartbeatMs * HEARTBEAT_MISSES) {
        this.dropSession(s, `no message for ${(this.limits.heartbeatMs * HEARTBEAT_MISSES) / 1000} s`);
        s.socket.terminate();
        continue;
      }
      s.send({ t: "ping", at: now });
    }
  }

  /** This process's own view. A proxy has no sessions of its own — use statusAsync(). */
  status(): BridgeStatus {
    const active = this.registry.select();
    return {
      role: this.currentRole,
      listening: this.currentRole === "hub",
      reason: this.reason,
      port: this.boundPort,
      host: HOST,
      hubPid: this.currentRole === "proxy" ? this.hubPid : this.currentRole === "hub" ? process.pid : null,
      peers: this.peers.size,
      lastAuthFailureAt: this.lastAuthFailureAt,
      sessions: this.registry.list().map((s) => ({ ...s.state, ops: [...s.state.ops], active: s === active })),
      serverBuild: PLUGIN_BUILD_ID,
      allowUnverified: this.opts.allowUnverified === true,
    };
  }

  /** As status(), but a proxy reports the hub's sessions. */
  async statusAsync(): Promise<BridgeStatus> {
    const own = this.status();
    const hub = this.hub;
    if (this.currentRole !== "proxy" || !hub || hub.readyState !== WebSocket.OPEN) return own;
    const id = `s-${this.nextPeerCall++}`;
    const remote = await new Promise<BridgeStatus | null>((resolve) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(id);
        resolve(null);
      }, PEER_STATUS_MS);
      this.statusWaiters.set(id, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      const msg: PeerToHub = { t: "status-request", id };
      hub.send(JSON.stringify(msg));
    });
    if (!remote) return own;
    return {
      ...remote,
      role: "proxy",
      listening: false,
      hubPid: this.hubPid,
      port: own.port,
      // An older hub sends neither field: its build is unknown, and its gate (if any) knows no flag.
      serverBuild: typeof remote.serverBuild === "string" ? remote.serverBuild : null,
      allowUnverified: remote.allowUnverified === true,
    };
  }

  /** Close every connection with 4010 and release the port (spec §4.6). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const s of this.registry.list()) {
      if (s.current) s.send({ t: "cancel", id: s.current.id, reason: "SHUTDOWN" });
      this.registry.remove(s.state.sessionId);
      for (const job of [...(s.current ? [s.current] : []), ...s.queue]) {
        if (job.timer) clearTimeout(job.timer);
        job.detachSignal();
        job.reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled (SHUTDOWN): the bridge is shutting down."));
      }
      s.current = null;
      s.queue.length = 0;
    }
    for (const [id, call] of this.pendingCalls) {
      this.pendingCalls.delete(id);
      call.detachSignal();
      call.reject(new BridgeError(ErrorCode.CANCELLED, "Cancelled (SHUTDOWN): the bridge is shutting down."));
    }
    this.hub?.close(1000, "proxy closing");
    this.hub = null;
    for (const socket of this.sockets) socket.close(CLOSE.SERVER_SHUTDOWN, "SERVER_SHUTDOWN");
    await new Promise<void>((resolve) => {
      const http = this.http;
      this.http = null;
      this.currentRole = "none";
      if (!http) return resolve();
      http.close(() => resolve());
      http.closeAllConnections?.();
      // Sockets that ignore the close handshake must not hold the port.
      setTimeout(() => {
        for (const socket of this.sockets) socket.terminate();
        resolve();
      }, 300).unref();
    });
    this.wss?.close();
  }
}

/** Write results always carry the idempotencyKey back (protocol.md §2). */
function withKey(data: unknown, key: string | undefined): unknown {
  if (!key || !data || typeof data !== "object" || Array.isArray(data)) return data;
  if ("idempotencyKey" in data) return data;
  return { ...(data as Record<string, unknown>), idempotencyKey: key };
}
