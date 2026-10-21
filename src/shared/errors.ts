// Canonical error codes — spec §10. Used by the bridge, the plugin, and the
// mock plugin. No runtime dependencies (the plugin bundles import this).

export const ErrorCode = {
  NO_SESSION: "NO_SESSION",
  PORT_IN_USE: "PORT_IN_USE",
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAM",
  FONT_LOAD_FAILED: "FONT_LOAD_FAILED",
  STALLED: "STALLED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  BUSY: "BUSY",
  UNSUPPORTED: "UNSUPPORTED",
  /**
   * The motion process (BRIDGE_PROCESS=strict) wants an earlier step first:
   * the motion skill read, a motion plan, or a passing figma_check_motion.
   * Answered by the server before anything is sent, so nothing changed.
   */
  PROCESS_REQUIRED: "PROCESS_REQUIRED",
  /**
   * A write would overwrite a node someone else changed after the agent last
   * read or wrote it (BRIDGE_CONFLICTS=refuse; trust spec §2.3). Refused by
   * the plugin before the op runs, so nothing changed.
   */
  STALE: "STALE",
  /**
   * A rollback would also undo someone else's edit, or reach a page the plugin
   * cannot see (trust spec §2.5). Refused before any undo, so nothing changed.
   */
  ROLLBACK_BLOCKED: "ROLLBACK_BLOCKED",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const CODES = new Set<string>(Object.values(ErrorCode));
export function isErrorCode(value: string): value is ErrorCode {
  return CODES.has(value);
}

export interface BridgeErrorInit {
  hint?: string;
  idempotencyKey?: string;
  partial?: unknown;
}

/** An error that reaches the agent as a structured tool result (protocol.md §9). */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly partial: unknown;

  constructor(code: ErrorCode, message: string, init: BridgeErrorInit = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.hint = init.hint;
    this.idempotencyKey = init.idempotencyKey;
    this.partial = init.partial;
  }

  /** The same error, carrying the idempotency key the agent should retry with. */
  withKey(idempotencyKey: string | undefined): BridgeError {
    if (!idempotencyKey || this.idempotencyKey) return this;
    return new BridgeError(this.code, this.message, {
      hint: this.hint,
      idempotencyKey,
      partial: this.partial,
    });
  }
}
