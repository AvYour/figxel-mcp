// The one convention every write op shares for failing before it touches the
// document (tools.md § Conventions): a refusal that provably changed nothing
// says so with `partial: { created: [] }`.
//
// That marker is load-bearing, not decoration. code.ts reads it (changedNothing)
// to free the idempotencyKey, so a corrected retry under the same key runs
// instead of replaying the refusal; and it is the evidence a result needs
// before it may call a retry safe [C-096]. A write op that validates outside
// this wrapper leaves the agent unable to tell "nothing happened" from
// "something may have".

import { BridgeError, ErrorCode } from "../shared/errors.js";

/**
 * Rethrow `err` as a BridgeError that reports nothing changed. Only call it
 * where that is true: before the first write of the op.
 */
export function unchanged(err: unknown): never {
  const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
  throw new BridgeError(e.code, e.message, { ...(e.hint ? { hint: e.hint } : {}), partial: { created: [] } });
}

/**
 * Run every check that can fail before the document changes. Figma applies a
 * write the moment it is made, so a check failing after the first one would
 * leave a half-edited layer behind; failing here changed nothing and says so.
 */
export async function beforeMutating<T>(prepare: () => T | Promise<T>): Promise<T> {
  try {
    return await prepare();
  } catch (err) {
    return unchanged(err);
  }
}
