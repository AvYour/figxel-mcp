// Shapes MCP tool results — protocol.md §9 "Final result".

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, ErrorCode } from "../shared/errors.js";

export function okResult(data: unknown): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    result.structuredContent = data as Record<string, unknown>;
  }
  return result;
}

/**
 * Codes that are answered before any request reaches the document: no plugin
 * to send to, a queue that refused it, a port that never opened. Retrying one
 * cannot apply anything twice.
 */
const NEVER_REACHED = new Set<string>([ErrorCode.NO_SESSION, ErrorCode.BUSY, ErrorCode.PORT_IN_USE]);

/**
 * Except a call that had already been sent when the connection went: NO_SESSION
 * is also how the bridge fails a job in flight, and that write may have landed.
 * `partial.dispatched` marks it; with the plugin gone, so is its idempotency
 * store, and a retry would build the work twice.
 */
function neverReached(e: BridgeError): boolean {
  return NEVER_REACHED.has(e.code) && (e.partial as { dispatched?: unknown } | null | undefined)?.dispatched !== true;
}

/**
 * The plugin's "provably nothing changed" marker (tools.md § Conventions):
 * `partial.created` is an empty array. Duplicated from plugin/idempotency.ts
 * changedNothing on purpose — the server bundle does not import sandbox code,
 * and the two must agree on one fact, which test/safe-to-retry.test.ts pins.
 */
function changedNothing(partial: unknown): boolean {
  const created = (partial as { created?: unknown } | null | undefined)?.created;
  return Array.isArray(created) && created.length === 0;
}

/**
 * `isError: true`, text `"<CODE>: <message>\n<hint>"`, plus structured
 * `{ code, message, hint?, idempotencyKey?, partial?, safeToRetry }`.
 *
 * `safeToRetry` answers the one question an agent has after a failure: may it
 * call again without reading the canvas first [C-096]? True only on evidence —
 * the call only read (`opts.readOnly`), was refused before reaching the
 * document (`opts.unchanged`), the plugin reported `created: []`, or the code
 * means the request never arrived and it is not marked as sent. Everything
 * else — a timeout, a stall, a failure half-way through a write, a connection
 * lost mid-call — is false: the agent must look first (figma_get_node) rather
 * than risk doing the work twice.
 */
export function errorResult(err: unknown, opts: { readOnly?: boolean; unchanged?: boolean } = {}): CallToolResult {
  const e =
    err instanceof BridgeError
      ? err
      : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err), {
          hint: err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 3).join("\n") : undefined,
        });
  const structured: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.hint !== undefined) structured.hint = e.hint;
  if (e.idempotencyKey !== undefined) structured.idempotencyKey = e.idempotencyKey;
  if (e.partial !== undefined) structured.partial = e.partial;
  structured.safeToRetry = opts.readOnly === true || opts.unchanged === true || changedNothing(e.partial) || neverReached(e);
  return {
    isError: true,
    content: [{ type: "text", text: `${e.code}: ${e.message}${e.hint ? `\n${e.hint}` : ""}` }],
    structuredContent: structured,
  };
}
