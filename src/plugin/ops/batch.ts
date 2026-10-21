// figma_batch — a polish pass in one call and one undo step.
//
// Fills, a radius, a shadow and a rename on a section were four calls and four
// Ctrl+Z steps. The official server does any mix of edits in one script; here a
// batch runs existing op implementations in order inside ONE op, so the runner
// (code.ts) commits once [C-096]. Each step is the real op with its own
// validation and its own per-item results — nothing is re-implemented.
//
// The contract is create_from_spec's: no rollback (one undo step already
// covers the whole batch), stop at the first failure, and say exactly how far
// it got. Only modify and style ops that are not destructive may run, and not
// the ones that replace their nodes with new ids (group, boolean, flatten,
// clone), so every id a later step names still exists when it runs.

import { editorRefusal } from "../../shared/editors.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { OPS } from "../../shared/ops.js";
import { PRODUCT_NAME } from "../../shared/version.js";
import { beforeMutating } from "../guard.js";
import { editorType } from "../safe.js";
import type { OpContext, PluginOp } from "./index.js";

/** Edits a batch may not hold, beyond the destructive ones: they change which ids exist. */
export const BATCH_EXCLUDED: ReadonlySet<string> = new Set(["batch", "group_nodes", "boolean_nodes", "flatten_nodes", "clone_node"]);
/** A motion plan: its checks live on the server (src/server/motion-plan.ts), which a batch step never meets. */
const PLAN_OP = "set_motion_plan";
/** A brief and a sign-off: the server checks the lines, the lenses and the blockers first (roles spec §3.4, §3.6). */
const ROLE_OPS: ReadonlySet<string> = new Set(["set_brief", "sign_off"]);
/**
 * Trust (2026-10-19): a savepoint marks the undo count between calls, so inside
 * a batch it would mark the middle of one undo step; the stress test builds and
 * removes copies as one undo step of its own. (rollback is destructive.)
 */
const SOLO_OPS: ReadonlySet<string> = new Set(["savepoint", "stress_test"]);
export const MAX_STEPS = 50;

/** Why `op` cannot be a batch step, or null when it can. */
export function notBatchable(op: string): string | null {
  if (op === "batch") return "a batch cannot hold another batch";
  if (SOLO_OPS.has(op)) return `"${op}" runs on its own call`;
  const info = OPS.get(op);
  if (!info) return `"${op}" is not a ${PRODUCT_NAME} op`;
  if (info.group !== "modify" && info.group !== "style") return `"${op}" is a ${info.group} op; a batch holds modify and style edits`;
  if (info.destructive) return `"${op}" is destructive and runs on its own call`;
  if (BATCH_EXCLUDED.has(op)) return `"${op}" replaces nodes with new ids, so later steps could name nodes that no longer exist`;
  if (op === PLAN_OP) return `"${op}" is checked by the server and stored on its own call, before the keyframes that need it`;
  if (ROLE_OPS.has(op)) return `"${op}" is checked by the server and runs on its own call`;
  return null;
}

export interface Step {
  op: string;
  params: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `steps` as sent: a JSON array (or its string, per the portable schema rule)
 * of `{ op, params }`, 1–50 long, each op batchable. Throws INVALID_PARAM naming
 * the step — the caller runs this before any step does.
 */
export function parseSteps(raw: unknown): Step[] {
  let steps = raw;
  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`steps` is a string but not valid JSON.");
    }
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps\` must be an array of 1–${MAX_STEPS} { "op": "<name>", "params": { … } } entries.`);
  }
  return steps.map((s, i): Step => {
    if (!isObject(s) || typeof s.op !== "string" || !s.op.trim()) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}]\` needs \`op\`: a tool name without "figma_", e.g. "set_fills".`);
    }
    const op = s.op.trim().replace(/^figma_/, "");
    const why = notBatchable(op);
    if (why) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].op\`: ${why}.`);
    if (s.params !== undefined && !isObject(s.params)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].params\` must be an object.`);
    for (const k of Object.keys(s)) {
      if (k !== "op" && k !== "params") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].${k}\` is not a step field: a step is { op, params }.`);
    }
    return { op, params: (s.params as Record<string, unknown> | undefined) ?? {} };
  });
}

/** The plugin's "provably nothing changed" marker on an error's partial (idempotency.ts changedNothing). */
const changedNothing = (partial: unknown) => {
  const created = (partial as { created?: unknown } | null | undefined)?.created;
  return Array.isArray(created) && created.length === 0;
};

/**
 * The batch op. `lookup` returns the op table at call time — the table holds
 * this op too, so it cannot be captured when the module loads.
 */
export function makeBatchOp(lookup: () => Record<string, PluginOp>): PluginOp {
  return {
    write: true,
    async run(ctx: OpContext) {
      const ops = lookup();
      const steps = await beforeMutating(() => {
        const steps = parseSteps(ctx.params.steps);
        // The runner's editor backstop covers the batch op itself; each step is
        // checked here, before the first one runs, so a refused batch changed nothing.
        const editor = editorType();
        steps.forEach((s, i) => {
          if (!ops[s.op]) {
            throw new BridgeError(ErrorCode.UNSUPPORTED, `\`steps[${i}].op\`: this plugin window does not implement "${s.op}".`, {
              hint: "Close the plugin window and run it again so it loads the current build.",
            });
          }
          const refused = editorRefusal(s.op, editor, { allowUnverified: false, layer: "plugin" });
          if (refused) throw new BridgeError(ErrorCode.UNSUPPORTED, `steps[${i}]: ${refused.message}`, { hint: refused.hint });
        });
        return steps;
      });

      const done: Array<{ index: number; op: string; ok: true; result: unknown }> = [];
      // Each step reports its own progress in its own units; the batch's count is the one that means something here.
      const quiet: OpContext = { ...ctx, progress: () => {} };
      for (let i = 0; i < steps.length; i++) {
        const { op, params } = steps[i]!;
        ctx.progress(i, steps.length, op);
        try {
          if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled between steps.");
          done.push({ index: i, op, ok: true, result: await ops[op]!.run({ ...quiet, params }) });
        } catch (err) {
          const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
          // Only a first step that changed nothing leaves the whole batch
          // unchanged; after any completed step the document has moved.
          const untouched = i === 0 && changedNothing(e.partial);
          throw new BridgeError(e.code, `steps[${i}] (${op}): ${e.message}`, {
            hint: untouched
              ? `${e.hint ? `${e.hint} ` : ""}Nothing was changed.`
              : `${e.hint ? `${e.hint} ` : ""}${done.length} step(s) were applied before it (partial.steps) and stay applied: one Ctrl+Z undoes the whole batch, or continue from partial.failedAt.`,
            partial: untouched
              ? { created: [], failedAt: 0 }
              : { steps: done, failedAt: i, ...(e.partial !== undefined ? { stepPartial: e.partial } : {}) },
          });
        }
      }
      ctx.progress(steps.length, steps.length, "done");
      // A step is ok when it ran; its nodes report their own `ok`. On
      // 2026-10-09 an agent read a step's ok: true as "the node moved" while
      // the move had been lost [C-203], so every node that failed inside a
      // completed step is listed once more, where it cannot be missed.
      const itemsFailed = done.flatMap((s) => failedItems(s.result).map((f) => ({ step: s.index, op: s.op, ...f })));
      return { steps: done, completed: done.length, ...(itemsFailed.length ? { itemsFailed } : {}) };
    },
  };
}

/** The per-item failures a step's result carries (`items: [{ id, ok: false, error }]`), if any. */
function failedItems(result: unknown): Array<{ id: string; error: string }> {
  const items = isObject(result) ? result.items : undefined;
  if (!Array.isArray(items)) return [];
  return items
    .filter((it): it is { id: string; ok: false; error?: unknown } => isObject(it) && it.ok === false && typeof it.id === "string")
    .map((it) => ({ id: it.id, error: typeof it.error === "string" ? it.error : "failed" }));
}
