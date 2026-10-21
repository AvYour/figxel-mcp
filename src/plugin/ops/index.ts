// The plugin's op table. Every op is a function with its dependencies passed
// in, so it can be unit-tested against a fake `figma` (spec §5.2).
//
// Phase 0 ships no document ops: figma_status is answered by the bridge, and
// the walking skeleton proves the connection, the queue, idempotency and
// progress plumbing. Phase 1 adds the read ops here (spec §12).

import type { YieldToHost } from "../chunk.js";
import { ANIMATIC_OPS } from "./animatic.js";
import { ASSET_OPS } from "./assets.js";
import { makeBatchOp } from "./batch.js";
import { BRIEF_OPS } from "./brief.js";
import { CHECK_OPS } from "./check.js";
import { COMPONENT_OPS } from "./component.js";
import { CREATE_OPS } from "./create.js";
import { EVAL_OPS } from "./eval.js";
import { EXPORT_OPS } from "./export.js";
import { FIGJAM_OPS, registerFigjamSpecTypes } from "./figjam.js";
import { META_OPS } from "./meta.js";
import { LAYOUT_OPS, MODIFY_OPS } from "./modify.js";
import { MOTION_OPS } from "./motion.js";
import { MOTION_PLAN_OPS } from "./motion-plan.js";
import { MOTION_SNAPSHOT_OPS } from "./motion-snapshot.js";
import { READ_OPS } from "./read.js";
import { SHAPE_OPS } from "./shapes.js";
import { SLIDES_OPS } from "./slides.js";
import { STORYBOARD_OPS } from "./storyboard.js";
import { STYLE_OPS } from "./style.js";
import { TOKEN_OPS } from "./tokens.js";
import { TYPOGRAPHY_OPS } from "./typography.js";
import { VARIABLE_OPS } from "./variable.js";
import { STRESS_OPS } from "../stress.js";
import { TRUST_OPS } from "../trust.js";

// create_from_spec's board types (sticky, shape, table, code, connector) are
// looked up by name at call time, so they must be registered before the first
// call: here, once, at module load.
registerFigjamSpecTypes();

export interface OpContext {
  requestId: string;
  params: Record<string, unknown>;
  yieldToHost: YieldToHost;
  /** Throttled to protocol.md §2 limits. */
  progress(done: number, total?: number, phase?: string): void;
  isCancelled(): boolean;
  /**
   * Nodes this op made or changed that its result does not list — copies it
   * deleted again — so their change events count as the agent's (trust.ts).
   * Absent outside the dispatcher.
   */
  touched?(ids: readonly string[]): void;
}

export interface PluginOp {
  /** Document-write op: ends with figma.commitUndo() (tools.md conventions). */
  write: boolean;
  run(ctx: OpContext): Promise<unknown>;
}

export const PLUGIN_OPS: Record<string, PluginOp> = {
  ...READ_OPS,
  ...CREATE_OPS,
  ...MODIFY_OPS,
  ...LAYOUT_OPS,
  ...STYLE_OPS,
  ...EXPORT_OPS,
  ...COMPONENT_OPS,
  ...VARIABLE_OPS,
  ...META_OPS,
  ...EVAL_OPS,
  ...CHECK_OPS,
  ...TYPOGRAPHY_OPS,
  ...ASSET_OPS,
  ...SHAPE_OPS,
  ...TOKEN_OPS,
  ...MOTION_OPS,
  ...MOTION_PLAN_OPS,
  ...MOTION_SNAPSHOT_OPS,
  ...FIGJAM_OPS,
  ...SLIDES_OPS,
  ...STORYBOARD_OPS,
  ...ANIMATIC_OPS,
  ...BRIEF_OPS,
  // Trust (2026-10-19): get_changes, savepoint and rollback read the plugin's
  // one change tracker, which code.ts feeds; stress_test is a write.
  ...TRUST_OPS,
  ...STRESS_OPS,
  // The lookup runs at call time, so a batch sees this whole table.
  batch: makeBatchOp(() => PLUGIN_OPS),
};
