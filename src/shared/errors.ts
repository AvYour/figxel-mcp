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
