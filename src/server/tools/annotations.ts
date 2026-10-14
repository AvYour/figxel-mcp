// MCP annotations shared by the tool groups.
//
// These are not cosmetic: a client with an approval mode uses `destructiveHint`
// to decide whether to ask the user first, and `readOnlyHint` to decide whether
// it can be retried freely. Getting them wrong is how an agent deletes
// something without a prompt.
//
// `shared/ops.ts` holds the table (DESTRUCTIVE, WRITE_GROUPS, READ_ONLY_GROUPS),
// and test/ops.test.ts checks it against tools.md. This module only translates.

import { OPS } from "../../shared/ops.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * Annotations for a write op.
 *
 * `idempotentHint` is set for ops that accept an idempotencyKey — which is
 * every write op here, because the bridge attaches one. It tells the client that
 * a retry with the same key is safe, which is exactly what the bridge guarantees.
 */
export function writeAnnotations(op: string): ToolAnnotations {
  const info = OPS.get(op);
  return {
    readOnlyHint: false,
    destructiveHint: info?.destructive ?? false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

export function readAnnotations(op: string): ToolAnnotations {
  const info = OPS.get(op);
  return {
    readOnlyHint: info?.readOnly ?? true,
    destructiveHint: false,
    openWorldHint: false,
  };
}
