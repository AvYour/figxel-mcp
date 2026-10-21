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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  type RequestMsg,
  type ServerToPlugin,
} from "../shared/protocol.js";
import { tokenFingerprint } from "../shared/token.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME, SETUP_COMMAND, VERSION } from "../shared/version.js";
import { figmaWords, isRenderTimeout, isSmallRender, renderTimeoutHint, type RenderSize } from "../shared/video.js";
import { Base64Sink, withBase64 } from "./binary.js";
import type { ConflictsMode, Logger } from "./config.js";
import { parseFrame } from "./frames.js";
import { PLUGIN_BUILD_ID } from "./plugin-build.js";
import {
  PEER_FEATURES,
  PEER_PROTOCOL_VERSION,
  parseHubToPeer,
  parsePeerToHub,
  type ChunkField,
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

/** This process's token file and the fingerprint of its token (shared/token.ts): never the token itself. */
export interface TokenWhere {
  tokenPath: string | null;
  fingerprint: string;
}

/**
 * A plugin's token was refused by THIS process. The plugin window shows the
 * fingerprint of the token it saved, so naming ours lets a person compare.
 */
export function tokenHint(where?: TokenWhere): string {
  const ours = where
    ? ` This server's token file is ${where.tokenPath ?? "(not named)"}, fingerprint ${where.fingerprint}; the plugin window shows the fingerprint of the token it saved.`
    : "";
  return (
    `A plugin tried to connect to this server and was refused: its token does not match this server's token file. Run \`${SETUP_COMMAND}\`, ` +
    `which prints the token and its fingerprint, and paste the token into the ${PLUGIN_NAME} plugin.${ours}`
  );
}
export const TOKEN_HINT = tokenHint();
export const HUB_LOST_HINT =
  `The ${PRODUCT_NAME} process that held the Figma connection exited; another one takes over within seconds. Retry — with the same idempotencyKey for write tools.`;

/** What a proxy learned when the hub holding the port refused its token. */
export interface PeerRefusal {
  at: number;
  /** null: an older hub, which closes without saying who it is. */
  hubPid: number | null;
  hubTokenPath: string | null;
  hubFingerprint: string | null;
}

/**
 * The port is held by a server of another installation — another token file —
 * so this process can neither listen nor share it, and the plugin talks to that
 * other server. Before, this read "not a compatible server", or nothing at all.
 */
export function peerRefusedMessage(r: PeerRefusal, own: TokenWhere, port: number): { message: string; hint: string } {
  const who = r.hubPid !== null ? `${PRODUCT_NAME} server (pid ${r.hubPid})` : `${PRODUCT_NAME} server, of this or an older version,`;
  const theirs = r.hubTokenPath || r.hubFingerprint ? ` (${[r.hubTokenPath, r.hubFingerprint && `fingerprint ${r.hubFingerprint}`].filter(Boolean).join(", ")})` : "";
  return {
    message:
      `Port ${port} is held by another ${who} that uses a different token file${theirs}, so it refused this server, ` +
      `whose token file is ${own.tokenPath ?? "(not named)"} (fingerprint ${own.fingerprint}). A plugin that shows "Connected" is connected to that other server.`,
    hint:
      `Use one server: close the other AI app${r.hubPid !== null ? ` (or the program that started pid ${r.hubPid})` : ""} and this server takes over the port within seconds; ` +
      `or run \`${SETUP_COMMAND}\` in the same environment as this AI app (the same user and the same BRIDGE_HOME), paste the token it prints into the ${PLUGIN_NAME} plugin, ` +
      "and restart both AI apps. The plugin window shows the fingerprint of the token it saved.",
  };
}

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
 *
 * Such an op has no idle limit in the bridge. Its job is detached from the
 * call (figma_export_video's job mode), exportAsync reports nothing while it
 * renders, and a minimized window can hold a render for 40 minutes that then
 * finishes [C-198]: a STALLED at 600 s threw that result away and left the
 * plugin busy anyway. A plugin that is gone is caught by the socket closing or
 * by the heartbeat (the plugin window answers pings while the sandbox renders).
 */
const HOLDS_THE_PLUGIN: ReadonlySet<string> = new Set(["export_video"]);
/** After this long a render is past the usual, and a minimized Figma window is the likely cause [C-198]. */
const RENDER_SLOW_MS = 120_000;
/** Past Figma's own 4-minute limit [C-198] with the window restored, the render may never answer. */
const RENDER_LOST_MS = 300_000;

/**
 * Why a render holds the plugin. "running": the bridge waits for it.
 * "cancelled": its job was dropped, but Figma finishes it. "earlier": an
 * earlier server process sent it (the plugin's hello said so). "abandoned":
 * the bridge stopped waiting for another reason.
 */
export type HoldState = "running" | "cancelled" | "earlier" | "abandoned";

/** The BUSY a call gets while a render holds the plugin. Nothing was sent, so nothing ran. */
export function renderBusyError(render: { jobId: string | undefined; elapsedMs: number | null; state: HoldState }, idempotencyKey: string | undefined): BridgeError {
  const what = `a video render${render.jobId ? ` (figma_export_video job "${render.jobId}")` : ""}`;
  const s = render.elapsedMs === null ? null : Math.round(render.elapsedMs / 1000);
  const notSent = "This call was not sent to Figma.";
  const message =
    s === null
      ? `Figma is about to start ${what}; this call was not sent to Figma.`
      : render.state === "cancelled"
        ? `Figma is still finishing ${what} that was cancelled, ${s} s after it began: Figma cannot stop a render it has begun. ${notSent}`
        : render.state === "earlier"
          ? `Figma is still busy with ${what} that an earlier ${PRODUCT_NAME} process started, with no result after ${s} s: Figma cannot stop a render it has begun. ${notSent}`
          : render.state === "abandoned"
            ? `Figma is still busy with ${what}, with no result after ${s} s: Figma cannot stop a render it has begun. ${notSent}`
            : `Figma is busy with ${what}, ${s} s so far; this call was not sent to Figma.`;
  const hint = [
    `Nothing changed, so a retry is safe${idempotencyKey ? ` with the same idempotencyKey (${idempotencyKey})` : ""}: call again once the render ends.`,
    "Figma renders one thing at a time and ends a render it has not finished in about 4 min.",
    render.jobId ? `Whoever started it collects it with figma_export_video { jobId: "${render.jobId}" }; do not start another export meanwhile.` : "Do not start another export meanwhile.",
    ...(s !== null && s * 1000 >= RENDER_SLOW_MS ? ["No result after 2 min: a minimized Figma window stops video export, so ask the user to restore it."] : []),
    ...(s !== null && s * 1000 >= RENDER_LOST_MS ? [renderLostAdvice(s)] : []),
  ].join(" ");
  return new BridgeError(ErrorCode.BUSY, message, { hint, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

/** What to do about a render that has not answered for longer than Figma's own limit. */
export function renderLostAdvice(elapsedS: number): string {
  return (
    `If the Figma window is restored and there is still no result after ${Math.round(elapsedS / 60)} min, the render may never answer: ` +
    `ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}), which ends the wait; that render's result is lost.`
  );
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
  /** The file the token was read from: named in token hints, with the token's fingerprint, never the token. */
  tokenPath?: string;
  /** BRIDGE_CONFLICTS of this process: the guard every write it sends carries. Default "refuse". */
  conflicts?: ConflictsMode;
}

/** The stale-write guard a write request carries (trust spec §2.3; protocol.ts RequestMsg.guard). */
export type Guard = NonNullable<RequestMsg["guard"]>;

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
  /** A write's `force`: overwrite a target someone changed since the agent's read, on purpose (trust spec §2.3). */
  force?: boolean;
  /** Set by the hub for a write a proxy forwarded: that proxy's guard, sent on as it is. */
  guard?: Guard;
}

/** JSON-safe session view — it travels between hub and proxies. */
export interface SessionView extends Omit<SessionState, "ops"> {
  ops: string[];
  active: boolean;
  /**
   * Video export in this plugin window: Figma's render timeouts in a row (a
   * success resets it; 2 or more means the exporter is likely stuck [C-318]),
   * and the render holding the plugin, if any. Absent from an older hub.
   */
  videoExport?: {
    timeoutsInARow: number;
    rendering: { jobId: string | null; elapsedS: number; state: HoldState } | null;
  };
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
  /** THIS process's token file and its token's fingerprint (also for a proxy: its own, not the hub's). */
  tokenPath?: string | null;
  tokenFingerprint?: string;
  /** A proxy whose join the hub refused: the hub holding the port uses another token file. */
  peerRefusal?: PeerRefusal | null;
  /** A hub: the last server process with another token that tried to share it. */
  lastPeerAuthFailure?: { at: number; pid: number } | null;
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
  /** A chunked payload on its way: decoded as it arrives (binary.ts). */
  chunks: { head: BinaryData; expected: number; received: number; sink: Base64Sink } | null;
  detachSignal: () => void;
  jobId: string | undefined;
  guard: Guard | undefined;
}

class Session {
  readonly queue: Job[] = [];
  current: Job | null = null;
  /**
   * A HOLDS_THE_PLUGIN op sent and not yet answered by the plugin — also after
   * the bridge stopped waiting for it (a cancel), or sent by an earlier server
   * process (the plugin's hello): the plugin goes on rendering, and only its
   * `result` for that id says it is free again.
   */
  holding: { id: string; jobId: string | undefined; sentAt: number; state: HoldState } | null = null;
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
  /** It said "result-chunks" in its hello: a large result may go in pieces. */
  chunks: boolean;
}

/** A call this proxy forwarded to the hub. */
interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: BridgeError) => void;
  onProgress: ((p: Progress) => void) | undefined;
  detachSignal: () => void;
  /** A chunked result on its way: the head, and its payload so far. */
  assembling?: { head: Record<string, unknown>; field: ChunkField; expected: number; received: number; sink: Base64Sink };
}

/** Binary bytes per `call-chunk`: 6 MiB of bytes is 8 MiB of base64, as the plugin's chunks are. */
const PEER_CHUNK_BYTES = 6 * 1024 * 1024;
/** A base64 string goes in slices of this many characters (a multiple of 4, so each slice decodes alone). */
const PEER_CHUNK_CHARS = 8 * 1024 * 1024;
/** Room for the JSON around a payload when a whole result must fit one frame of an older proxy. */
const FRAME_MARGIN = 64 * 1024;

/** Send one text frame and wait until ws has handed it on, so a long result is never queued whole. */
function sendDrained(socket: WebSocket, text: string): Promise<boolean> {
  if (socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  return new Promise((resolve) => socket.send(text, (err) => resolve(!err)));
}

const MIB = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

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
  /** Hub: the last server process with another token that tried to share this hub. */
  private lastPeerAuthFailure: { at: number; pid: number } | null = null;
  /**
   * Request ids are `r-<prefix>-<n>`, the prefix random per process. Plain
   * `r-<n>` restarted at r-1 in every process, and the plugin outlives them:
   * after a hub change, an old render's result answered the new hub's request
   * that happened to carry the same id (2026-10-14 audit, probe p2).
   */
  private readonly requestPrefix = randomBytes(4).toString("hex");
  private nextRequest = 1;
  private nextSession = 1;
  private nextPeerCall = 1;
  private electionAttempts = 0;
  private closed = false;
  /** Figma's render timeouts in a row, per plugin window (instanceId): it outlives sessions and job stores [C-318]. */
  private readonly renderTimeouts = new Map<string, number>();
  /** The figma_export_video job of each render this bridge sent, by request id, for a plugin that reconnects mid-render. */
  private readonly sentRenders = new Map<string, string | undefined>();
  // proxy state
  private hub: WebSocket | null = null;
  private hubPid: number | null = null;
  /** The hub holding the port refused this process's token: what it said about itself. Cleared on a welcome. */
  private peerRefusal: PeerRefusal | null = null;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly statusWaiters = new Map<string, (status: BridgeStatus | null) => void>();

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.tokenHash = hashToken(opts.token);
    this.boundPort = opts.port;
  }

  /** This process's token file and fingerprint, for hints and figma_status. */
  get tokenWhere(): TokenWhere {
    return { tokenPath: this.opts.tokenPath ?? null, fingerprint: tokenFingerprint(this.opts.token) };
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
    this.peerRefusal = null;
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
      let refused: Extract<HubToPeer, { t: "peer-refused" }> | null = null;
      let tooBig = false;
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
          features: [...PEER_FEATURES],
        };
        ws.send(JSON.stringify(hello));
      });
      ws.on("message", (raw) => {
        const msg = parseHubToPeer(String(raw));
        if (!msg) return;
        if (msg.t === "peer-welcome") {
          this.hub = ws;
          this.hubPid = msg.hubPid;
          this.peerRefusal = null;
          done(true, "welcomed");
          return;
        }
        if (msg.t === "peer-refused") {
          refused = msg;
          return;
        }
        this.onHubMessage(msg);
      });
      ws.on("close", (code) => {
        if (!settled) {
          // A hub of another installation refuses this token with 4001; a new one says who it is first.
          if (refused || code === CLOSE.AUTH_FAILED) {
            const was = this.peerRefusal;
            this.peerRefusal = {
              at: Date.now(),
              hubPid: refused?.hubPid ?? null,
              hubTokenPath: refused?.tokenPath ?? null,
              hubFingerprint: refused?.fingerprint ?? null,
            };
            if (!was) {
              const { message } = peerRefusedMessage(this.peerRefusal, this.tokenWhere, this.opts.port);
              this.opts.logger.warn(message);
            }
          }
          return done(false, refused || code === CLOSE.AUTH_FAILED ? "refused: another token file" : "closed before welcome");
        }
        if (this.hub === ws) this.onHubLost(tooBig ? CLOSE.MESSAGE_TOO_BIG : code);
      });
      // A message over maxPayload: ws closes the socket itself, and the close then reports 1006, not 1009.
      ws.on("error", (err) => {
        if ((err as { code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") tooBig = true;
      });
    });
  }

  private onHubLost(code?: number): void {
    this.hub = null;
    const hubPid = this.hubPid;
    this.hubPid = null;
    this.currentRole = "none";
    // A result too large for one frame closes the socket with 1009 (an older hub
    // sends a result in one piece). The hub is still there; say what happened.
    const tooBig = code === CLOSE.MESSAGE_TOO_BIG;
    // Every pending call was forwarded to the hub, which may have sent it on to
    // the plugin: its outcome is unknown, so it is marked as dispatched (results.ts).
    for (const [id, call] of this.pendingCalls) {
      this.pendingCalls.delete(id);
      call.detachSignal();
      call.reject(
        tooBig
          ? new BridgeError(
              ErrorCode.INTERNAL,
              `A result was larger than one message between ${PRODUCT_NAME} processes carries (${MIB(this.limits.maxFrameBytes)}), so the connection to the ${PRODUCT_NAME} process holding Figma${hubPid !== null ? ` (pid ${hubPid})` : ""} closed. The call itself ran in Figma.`,
              {
                hint:
                  `That process is older and sends a result in one piece: ask the user to restart the AI app that started it (figma_status names its pid), ` +
                  "which updates it, or ask for less (a smaller or shorter render). This process reconnects by itself.",
                partial: { dispatched: true },
              },
            )
          : new BridgeError(ErrorCode.NO_SESSION, "The shared Figma connection went away mid-call.", {
              hint: HUB_LOST_HINT,
              partial: { dispatched: true },
            }),
      );
    }
    for (const w of this.statusWaiters.values()) w(null);
    this.statusWaiters.clear();
    if (this.closed) return;
    this.opts.logger.info(tooBig ? "proxy: a result too large for one frame closed the hub connection — joining again" : "proxy: the hub exited — racing for the port");
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
        if (msg.ok && msg.chunks !== undefined && msg.chunks > 0) {
          const head = msg.data && typeof msg.data === "object" && !Array.isArray(msg.data) ? (msg.data as Record<string, unknown>) : {};
          call.assembling = { head, field: msg.field ?? "base64", expected: msg.chunks, received: 0, sink: new Base64Sink() };
          return;
        }
        this.pendingCalls.delete(msg.id);
        call.detachSignal();
        if (msg.ok) call.resolve(msg.data);
        else call.reject(toBridgeError(msg.error));
        return;
      }
      case "call-chunk": {
        const call = this.pendingCalls.get(msg.id);
        const a = call?.assembling;
        if (!call || !a) return;
        if (msg.seq !== a.received) {
          this.pendingCalls.delete(msg.id);
          call.detachSignal();
          call.reject(new BridgeError(ErrorCode.INTERNAL, `Result piece ${msg.seq} arrived out of order (expected ${a.received}).`, { partial: { dispatched: true } }));
          return;
        }
        a.sink.push(msg.base64);
        a.received++;
        if (a.received < a.expected) return;
        this.pendingCalls.delete(msg.id);
        call.detachSignal();
        const bytes = a.sink.finish();
        call.resolve({ ...a.head, ...(a.field === "binary" ? { binary: bytes } : { base64: bytes.toString("base64") }) });
        return;
      }
      case "status-result": {
        const w = this.statusWaiters.get(msg.id);
        this.statusWaiters.delete(msg.id);
        w?.(msg.status as BridgeStatus);
        return;
      }
      case "peer-welcome":
      case "peer-refused":
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
      // The same window: a render this bridge sent it is still running there.
      if (replaced.holding) session.holding = replaced.current?.id === replaced.holding.id ? { ...replaced.holding, state: "abandoned" } : replaced.holding;
      this.failAll(replaced, "replaced by a new connection from the same plugin window");
      replaced.socket.close(CLOSE.SESSION_REPLACED, "SESSION_REPLACED");
    }
    // A render an earlier server process sent is still running in the sandbox
    // (C-271: a hub restarted mid-render): calls answer BUSY instead of queueing
    // behind it in the plugin until they STALL.
    const running = hello.running;
    if (running && HOLDS_THE_PLUGIN.has(running.op) && session.holding?.id !== running.id) {
      // Our own id (the plugin reconnected to this hub): its job is known, and it was not another process's.
      const ours = running.id.startsWith(`r-${this.requestPrefix}-`);
      session.holding = { id: running.id, jobId: ours ? this.sentRenders.get(running.id) : undefined, sentAt: now - running.elapsedMs, state: ours ? "abandoned" : "earlier" };
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
      // It is told who holds the port and which token file this hub uses, so it can say so.
      this.lastPeerAuthFailure = { at: Date.now(), pid: hello.pid };
      this.opts.logger.warn(`rejected ${PRODUCT_NAME} process ${hello.pid}: it uses another token file (this hub's: ${this.opts.tokenPath ?? "not named"})`);
      const { tokenPath, fingerprint } = this.tokenWhere;
      const refused: HubToPeer = { t: "peer-refused", hubPid: process.pid, tokenPath, fingerprint };
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(refused));
      socket.close(CLOSE.AUTH_FAILED, "AUTH_FAILED");
      return null;
    }
    const peer: PeerConn = { socket, pid: hello.pid, calls: new Map(), chunks: hello.features?.includes("result-chunks") === true };
    this.peers.add(peer);
    this.sendPeer(peer, { t: "peer-welcome", hubPid: process.pid, serverVersion: VERSION, features: [...PEER_FEATURES] });
    this.opts.logger.info(`hub: ${PRODUCT_NAME} process ${hello.pid} (${hello.serverVersion}) is sharing this Figma connection`);
    return peer;
  }

  private sendPeer(peer: PeerConn, msg: HubToPeer): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(msg));
  }

  /**
   * A successful result, to a proxy. A large binary payload goes as a head plus
   * `call-chunk` frames to a proxy that takes them ("result-chunks"), each
   * frame sent once the previous one is out. Anything else goes in one frame —
   * unless that frame is larger than a proxy's socket takes, which would close
   * the connection with 1009 and read there as "the hub exited": then the proxy
   * gets an honest error instead.
   */
  private async sendCallResult(peer: PeerConn, id: string, data: unknown): Promise<void> {
    const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const binary = d && Buffer.isBuffer(d.binary) ? d.binary : undefined;
    const text = d && typeof d.base64 === "string" ? d.base64 : undefined;
    const payloadChars = binary ? Math.ceil(binary.length / 3) * 4 : (text?.length ?? 0);
    if (d && peer.chunks && payloadChars > PEER_CHUNK_CHARS) {
      const { binary: _b, base64: _s, ...head } = d;
      const field: ChunkField = binary ? "binary" : "base64";
      const n = binary ? Math.ceil(binary.length / PEER_CHUNK_BYTES) : Math.ceil(text!.length / PEER_CHUNK_CHARS);
      if (!(await sendDrained(peer.socket, JSON.stringify({ t: "call-result", id, ok: true, data: head, chunks: n, field } satisfies HubToPeer)))) return;
      for (let seq = 0; seq < n; seq++) {
        const base64 = binary ? binary.subarray(seq * PEER_CHUNK_BYTES, (seq + 1) * PEER_CHUNK_BYTES).toString("base64") : text!.slice(seq * PEER_CHUNK_CHARS, (seq + 1) * PEER_CHUNK_CHARS);
        if (!(await sendDrained(peer.socket, JSON.stringify({ t: "call-chunk", id, seq, base64 } satisfies HubToPeer)))) return;
      }
      return;
    }
    const frame = JSON.stringify({ t: "call-result", id, ok: true, data: withBase64(data) } satisfies HubToPeer);
    const size = Buffer.byteLength(frame);
    if (size > this.limits.maxFrameBytes - FRAME_MARGIN) {
      const error = new BridgeError(
        ErrorCode.INTERNAL,
        `The result is ${MIB(size)}, more than one message between ${PRODUCT_NAME} processes carries (${MIB(this.limits.maxFrameBytes)}), and this process cannot take it in pieces. The call itself ran in Figma.`,
        {
          hint: peer.chunks
            ? "Ask for less: a smaller render, or fewer nodes per call."
            : `This ${PRODUCT_NAME} process is older than the one holding the Figma connection (pid ${process.pid}): ask the user to restart the AI app it serves, which updates it, or ask for less (a smaller or shorter render).`,
          partial: { dispatched: true },
        },
      );
      this.sendPeer(peer, { t: "call-result", id, ok: false, error: toPeerError(error) });
      return;
    }
    await sendDrained(peer.socket, frame);
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
          .then(
            (data) => this.sendCallResult(peer, msg.id, data),
            (err: unknown) => this.sendPeer(peer, { t: "call-result", id: msg.id, ok: false, error: toPeerError(err) }),
          )
          .catch((err: unknown) => this.opts.logger.warn(`could not send a result to ${PRODUCT_NAME} process ${peer.pid}: ${err instanceof Error ? err.message : String(err)}`))
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
        if (msg.seq !== job.chunks.received) {
          this.finish(session, job, new BridgeError(ErrorCode.INTERNAL, `chunk ${msg.seq} arrived out of order`));
          return;
        }
        // Decoded as it arrives: a 300 MB video is never one 400 MB string (binary.ts).
        job.chunks.sink.push(msg.base64);
        job.chunks.received++;
        this.armIdle(session, job);
        if (job.chunks.received === job.chunks.expected) {
          const { head, sink } = job.chunks;
          const { chunks: _n, ...rest } = head;
          const bytes = sink.finish();
          // An export op's reader takes the Buffer (bytesOf); any other op gets the base64 string it always had.
          this.finish(session, job, OPS.get(job.op)?.exportOp ? { ...rest, binary: bytes } : { ...rest, base64: bytes.toString("base64") });
        }
        return;
      }
      case "result": {
        // The plugin is free of a render once it answers it, waited for or not.
        if (session.holding?.id === msg.id) {
          session.holding = null;
          this.countRender(session, msg);
        }
        const job = session.current;
        if (!job || job.id !== msg.id) {
          this.opts.logger.debug(`ignored a result for ${msg.id} (no longer waiting)`);
          return;
        }
        session.answered = true;
        if (!msg.ok) {
          const code = isErrorCode(msg.error.code) ? msg.error.code : ErrorCode.INTERNAL;
          const err = new BridgeError(code, msg.error.message, {
            ...(msg.error.hint !== undefined ? { hint: msg.error.hint } : {}),
            ...(msg.partial !== undefined ? { partial: msg.partial } : {}),
          });
          this.finish(session, job, HOLDS_THE_PLUGIN.has(job.op) ? this.renderFailure(session, err) : err);
          return;
        }
        const head = msg.data as Partial<BinaryData> | null;
        if (head && typeof head === "object" && typeof head.chunks === "number" && head.chunks > 0) {
          job.chunks = { head: head as BinaryData, expected: head.chunks, received: 0, sink: new Base64Sink() };
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

  // ── Figma's render timeouts, counted per plugin window [C-318] ─────────────

  /** Figma's time limit, as a plugin of any age reports it: TIMEOUT, or UNSUPPORTED with Figma's words. */
  private static isTimeout(code: string, message: string): boolean {
    return code === ErrorCode.TIMEOUT || (code === ErrorCode.UNSUPPORTED && isRenderTimeout(figmaWords(message)));
  }

  /** The plugin answered a render, waited for or not: a success resets the count, a timeout adds one. */
  private countRender(session: Session, msg: Extract<PluginToServer, { t: "result" }>): void {
    const key = session.state.instanceId;
    if (msg.ok) this.renderTimeouts.set(key, 0);
    else if (Bridge.isTimeout(msg.error.code, msg.error.message)) this.renderTimeouts.set(key, (this.renderTimeouts.get(key) ?? 0) + 1);
  }

  /**
   * A render's failure as the agent gets it. A timeout is TIMEOUT whatever the
   * plugin's age, with the hint the count calls for: on the second in a row, or
   * on a render too small to need 4 minutes, a Figma restart [C-318].
   */
  private renderFailure(session: Session, err: BridgeError): BridgeError {
    if (!Bridge.isTimeout(err.code, err.message)) return err;
    const inARow = Math.max(1, this.renderTimeouts.get(session.state.instanceId) ?? 1);
    const render = (err.partial as { render?: RenderSize } | null | undefined)?.render;
    const message = err.code === ErrorCode.TIMEOUT ? err.message : err.message.replace(/^Figma could not export /, "Figma gave up rendering ");
    return new BridgeError(ErrorCode.TIMEOUT, message, {
      hint: renderTimeoutHint({ inARow, small: isSmallRender(render) }),
      ...(err.partial !== undefined ? { partial: err.partial } : {}),
    });
  }

  // ── requests ──────────────────────────────────────────────────────────────

  /**
   * Forward an op to a plugin session — directly as the hub, or through the
   * hub as a proxy. Rejects only with BridgeError. Write ops always carry an
   * idempotencyKey (agent-supplied or generated here, so even a proxy that
   * loses its hub mid-call can return it), and every result/error for them
   * carries it back (protocol.md §3). Every write carries the stale-write
   * guard too (trust spec §2.3): this process's BRIDGE_CONFLICTS and the
   * call's `force`, or the guard of the proxy that forwarded it.
   */
  async request(op: string, params: Record<string, unknown>, opts: RequestOptions = {}): Promise<unknown> {
    const info = OPS.get(op);
    const write = info?.write ?? false;
    const key = write ? (opts.idempotencyKey ?? `k-${randomUUID()}`) : undefined;
    // `agent` names this process, so the plugin can tell one agent's undo steps from another's.
    const guard: Guard | undefined = write ? (opts.guard ?? { conflicts: this.opts.conflicts ?? "refuse", force: opts.force === true, agent: this.requestPrefix }) : undefined;

    if (this.currentRole === "proxy") return this.forwardToHub(op, params, opts, key, guard);

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

    const promise = this.dispatch(op, params, opts, key, info?.exportOp ?? false, guard);
    if (key) {
      this.inflight.set(key, { op, promise });
      promise.then(
        () => this.inflight.delete(key),
        () => this.inflight.delete(key),
      );
    }
    return promise;
  }

  private forwardToHub(op: string, params: Record<string, unknown>, opts: RequestOptions, key: string | undefined, guard: Guard | undefined): Promise<unknown> {
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
          // This process's BRIDGE_CONFLICTS and the call's force, as allowUnverified: the hub sends them on.
          ...(guard ? { guard } : {}),
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
    guard: Guard | undefined,
  ): Promise<unknown> {
    if (this.currentRole === "none" && this.reason === ErrorCode.PORT_IN_USE) {
      if (this.peerRefusal) {
        // The port's holder is a server of another installation: say so, and which token files.
        const { message, hint } = peerRefusedMessage(this.peerRefusal, this.tokenWhere, this.opts.port);
        throw new BridgeError(ErrorCode.PORT_IN_USE, message, { hint, ...(key ? { idempotencyKey: key } : {}) });
      }
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
        id: `r-${this.requestPrefix}-${this.nextRequest++}`,
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
        guard,
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
  private renderAhead(session: Session): { jobId: string | undefined; elapsedMs: number | null; state: HoldState } | null {
    const held = session.holding;
    if (held) {
      // Waited for by this bridge, or not: then why not, never "cancelled" unless it was.
      const state: HoldState = session.current?.id === held.id ? "running" : held.state === "running" ? "abandoned" : held.state;
      return { jobId: held.jobId, elapsedMs: Date.now() - held.sentAt, state };
    }
    const queued = session.queue.find((j) => HOLDS_THE_PLUGIN.has(j.op));
    return queued ? { jobId: queued.jobId, elapsedMs: null, state: "running" } : null;
  }

  private pump(session: Session): void {
    if (session.current || !this.registry.has(session.state.sessionId)) return;
    const job = session.queue.shift();
    if (!job) return;
    session.current = job;
    if (HOLDS_THE_PLUGIN.has(job.op)) {
      session.holding = { id: job.id, jobId: job.jobId, sentAt: Date.now(), state: "running" };
      this.sentRenders.set(job.id, job.jobId);
      if (this.sentRenders.size > 64) this.sentRenders.delete(this.sentRenders.keys().next().value!);
    }
    session.send({
      t: "request",
      id: job.id,
      op: job.op,
      params: job.params,
      idleTimeoutMs: job.idleTimeoutMs,
      ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
      ...(job.guard ? { guard: job.guard } : {}),
    });
    this.armIdle(session, job);
  }

  private armIdle(session: Session, job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    // No idle limit for a render (HOLDS_THE_PLUGIN): its result is awaited, however late.
    if (HOLDS_THE_PLUGIN.has(job.op)) return;
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
      if (session.holding?.id === job.id) session.holding.state = "cancelled";
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
    const message =
      arg && this.registry.size > 0
        ? `No connected Figma session matches "${arg}".`
        : "No Figma plugin is connected.";
    const current = authFailureIsCurrent(this.lastAuthFailureAt, this.registry.list().map((s) => s.state.connectedAt));
    return new BridgeError(ErrorCode.NO_SESSION, message, {
      hint: current ? tokenHint(this.tokenWhere) : NO_SESSION_HINT,
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
    const { tokenPath, fingerprint } = this.tokenWhere;
    return {
      role: this.currentRole,
      listening: this.currentRole === "hub",
      reason: this.reason,
      port: this.boundPort,
      host: HOST,
      hubPid: this.currentRole === "proxy" ? this.hubPid : this.currentRole === "hub" ? process.pid : null,
      peers: this.peers.size,
      lastAuthFailureAt: this.lastAuthFailureAt,
      sessions: this.registry.list().map((s) => {
        const render = this.renderAhead(s);
        return {
          ...s.state,
          ops: [...s.state.ops],
          active: s === active,
          videoExport: {
            timeoutsInARow: this.renderTimeouts.get(s.state.instanceId) ?? 0,
            rendering:
              render && render.elapsedMs !== null
                ? { jobId: render.jobId ?? null, elapsedS: Math.round(render.elapsedMs / 1000), state: render.state }
                : null,
          },
        };
      }),
      serverBuild: PLUGIN_BUILD_ID,
      allowUnverified: this.opts.allowUnverified === true,
      tokenPath,
      tokenFingerprint: fingerprint,
      peerRefusal: this.peerRefusal,
      lastPeerAuthFailure: this.lastPeerAuthFailure,
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
      // Ours, not the hub's: the token file this process (the one the agent talks to) reads.
      tokenPath: own.tokenPath ?? null,
      tokenFingerprint: own.tokenFingerprint ?? tokenFingerprint(this.opts.token),
      peerRefusal: null,
      lastPeerAuthFailure: remote.lastPeerAuthFailure ?? null,
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

/**
 * Whether a plugin's refused token is the problem now: refused within the last
 * 10 minutes, and no session has connected since. A failure older than a
 * session's connect is an earlier attempt that was then fixed (the user pasted
 * the right token): reporting it next to a working connection blamed the plugin
 * for a problem it no longer had.
 */
export function authFailureIsCurrent(at: number | null, connectedAts: readonly number[], now = Date.now()): boolean {
  if (at === null || now - at >= AUTH_FAILURE_HINT_MS) return false;
  return !connectedAts.some((c) => c >= at);
}

/** Write results always carry the idempotencyKey back (protocol.md §2). */
function withKey(data: unknown, key: string | undefined): unknown {
  if (!key || !data || typeof data !== "object" || Array.isArray(data)) return data;
  if ("idempotencyKey" in data) return data;
  return { ...(data as Record<string, unknown>), idempotencyKey: key };
}
