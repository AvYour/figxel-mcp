// Wire protocol between the bridge and the plugin — docs/reference/protocol.md.
//
// This file holds types and constants only, with no runtime dependencies, so
// both plugin bundles (sandbox and UI iframe) can import it without pulling
// zod in. The bridge validates incoming frames in src/server/frames.ts.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 38452;
export const HOST = "127.0.0.1";

/** protocol.md §3 `welcome.limits`. */
export interface Limits {
  maxQueueDepth: number;
  idleTimeoutMs: number;
  exportIdleTimeoutMs: number;
  heartbeatMs: number;
  maxFrameBytes: number;
  chunkBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxQueueDepth: 32,
  idleTimeoutMs: 30_000,
  exportIdleTimeoutMs: 120_000,
  heartbeatMs: 15_000,
  maxFrameBytes: 32 * 1024 * 1024,
  chunkBytes: 8 * 1024 * 1024,
};

/** protocol.md §1 — the plugin must send `hello` within this window. */
export const HELLO_TIMEOUT_MS = 5_000;
/** protocol.md §4 — 45 s of silence drops the session (3 missed heartbeats). */
export const HEARTBEAT_MISSES = 3;

/** protocol.md §6. */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  MESSAGE_TOO_BIG: 1009,
  AUTH_FAILED: 4001,
  DUPLICATE_HELLO: 4002,
  FORBIDDEN_ORIGIN: 4003,
  SESSION_REPLACED: 4004,
  PROTOCOL_MISMATCH: 4005,
  HELLO_TIMEOUT: 4008,
  SERVER_SHUTDOWN: 4010,
} as const;
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/** Close codes after which the plugin stops reconnecting (protocol.md §5). */
export const TERMINAL_CLOSE_CODES: readonly number[] = [
  CLOSE.AUTH_FAILED,
  CLOSE.FORBIDDEN_ORIGIN,
  CLOSE.SESSION_REPLACED,
  CLOSE.PROTOCOL_MISMATCH,
];

/** protocol.md §5 — 0.5 s, 1 s, 2 s, 3 s, 3 s, … */
export const RECONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 3000];
export const RECONNECT_STABLE_MS = 30_000;

export interface FileInfo {
  name: string | null;
  key: string | null;
}
export interface PageInfo {
  id: string;
  name: string;
}
export interface UserInfo {
  id: string | null;
  name: string;
}

export interface WireError {
  code: string;
  message: string;
  hint?: string;
}

// ── plugin → server ──────────────────────────────────────────────────────────

export interface HelloMsg {
  t: "hello";
  protocolVersion: number;
  token: string;
  instanceId: string;
  pluginVersion: string;
  /** Content hash of the plugin sources (tools/build.mjs). Absent on old bundles. */
  buildId?: string;
  apiVersion: string;
  editorType: string;
  ops: string[];
  file: FileInfo;
  page: PageInfo | null;
  user: UserInfo | null;
}

export interface ResultOkMsg {
  t: "result";
  id: string;
  ok: true;
  data: unknown;
}
export interface ResultErrMsg {
  t: "result";
  id: string;
  ok: false;
  error: WireError;
  partial?: unknown;
}
export type ResultMsg = ResultOkMsg | ResultErrMsg;

export interface ChunkMsg {
  t: "chunk";
  id: string;
  seq: number;
  base64: string;
}

export interface ProgressMsg {
  t: "progress";
  id: string;
  done: number;
  total?: number;
  phase?: string;
}

export interface SelectionChangedEvent {
  t: "event";
  name: "selection_changed";
  data: { nodeIds: string[]; count: number; at: number };
}
export interface PageChangedEvent {
  t: "event";
  name: "page_changed";
  data: { pageId: string; pageName: string };
}
export interface NodesChangedEvent {
  t: "event";
  name: "nodes_changed";
  data: { count: number; nodeIds: string[]; at: number };
}
export type EventMsg = SelectionChangedEvent | PageChangedEvent | NodesChangedEvent;

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogMsg {
  t: "log";
  level: LogLevel;
  message: string;
}

export interface PongMsg {
  t: "pong";
  at: number;
}

export type PluginToServer = HelloMsg | ResultMsg | ChunkMsg | ProgressMsg | EventMsg | LogMsg | PongMsg;

// ── server → plugin ──────────────────────────────────────────────────────────

export interface WelcomeMsg {
  t: "welcome";
  sessionId: string;
  serverVersion: string;
  protocolVersion: number;
  limits: Limits;
}

export interface RequestMsg {
  t: "request";
  id: string;
  op: string;
  params: Record<string, unknown>;
  idleTimeoutMs: number;
  idempotencyKey?: string;
}

export type CancelReason = "STALLED" | "CLIENT_CANCELLED" | "SHUTDOWN";
export interface CancelMsg {
  t: "cancel";
  id: string;
  reason: CancelReason;
}

export interface PingMsg {
  t: "ping";
  at: number;
}

export type ServerToPlugin = WelcomeMsg | RequestMsg | CancelMsg | PingMsg;

/** Binary payloads (exports) — protocol.md §2 `result`. */
export interface BinaryData {
  mime: string;
  bytes: number;
  base64?: string;
  chunks?: number;
}
