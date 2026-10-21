// figma_batch on the server side: several modify/style edits in one call and
// one undo step [C-096].
//
// `steps` is heterogeneous — each entry has its own tool's parameters — so it
// travels as a JSON string (tools.md § Conventions: a union of shapes is not
// portable). That would leave each step unchecked until the plugin met it,
// half-way through a batch. Instead every step is validated here against the
// zod shape its own tool registered, before anything is forwarded: a bad step
// fails the whole call with its path (`steps[1].params.nodeIds`) and nothing
// runs. The shapes are recorded as the tools register (createShapeRecorder), so
// a step can never drift from the tool it names.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { editorsSuffix } from "../../shared/editors.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { OPS } from "../../shared/ops.js";
import { PRODUCT_NAME } from "../../shared/version.js";
import type { Bridge } from "../bridge.js";
import { KEYFRAME_OPS, keyframeGate, withProcessWarnings, type GateResult, type MotionProcess } from "../motion-process.js";
import { errorResult } from "../results.js";
import { GATED_OPS, newWorkGate, type RoleGate, type RoleProcess } from "../role-process.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { addressCall, forwardTool, markForced, type Extra } from "./forward.js";
import { fitDescription, MAX_DESCRIPTION } from "./params.js";

/** A registered tool's input shape, by op name (no `figma_`). */
export type ShapeOf = (op: string) => z.ZodRawShape | undefined;

/**
 * Record every tool's input shape as it registers, and register it strict.
 * Call it on the server BEFORE any register function, and pass the result to
 * registerBatch, which must register LAST so every step's tool is already known.
 *
 * Strict because the SDK wraps a raw shape in a plain z.object, which strips an
 * unknown key and hands the tool the stripped copy: `figma_set_text_range
 * { align }` would report success having done nothing with `align`. Refused
 * here, on every tool at once, it is checked the way a batch step already is.
 *
 * A write tool's `force: true` is marked on its call here too (forward.ts
 * markForced), so it reaches every request the call sends, also where the tool
 * builds its op's params itself and leaves `force` out (trust spec §2.3).
 */
export function createShapeRecorder(server: McpServer): ShapeOf {
  const shapes = new Map<string, z.ZodRawShape>();
  const original = server.registerTool.bind(server) as (name: string, config: { inputSchema?: unknown; description?: unknown }, cb: unknown) => unknown;
  (server as unknown as { registerTool: typeof original }).registerTool = (name, rawConfig, rawCb) => {
    const config = withEditors(name, rawConfig);
    const cb = OPS.get(name.replace(/^figma_/, ""))?.write ? withForce(rawCb) : rawCb;
    const schema = config?.inputSchema;
    if (schema && typeof schema === "object" && !(schema instanceof z.ZodType)) {
      shapes.set(name.replace(/^figma_/, ""), schema as z.ZodRawShape);
      return original(name, { ...config, inputSchema: z.object(schema as z.ZodRawShape).strict() }, cb);
    }
    return original(name, config, cb);
  };
  return (op) => shapes.get(op);
}

/** A tool callback that marks its call forced when its arguments say `force: true`. */
function withForce(cb: unknown): unknown {
  if (typeof cb !== "function") return cb;
  const run = cb as (args: unknown, extra: Extra) => unknown;
  return (args: unknown, extra: Extra) => {
    if (isObject(args) && args.force === true) markForced(extra);
    return run(args, extra);
  };
}

/**
 * Append the Editors sentence (shared/editors.ts editorsSuffix) to a tool's
 * description, where the agent choosing a tool reads it: "Editors: Design
 * only.", "Editors: Design; unverified: FigJam, Slides." [C-129]. The body is
 * refitted first so the whole stays within the portable cap — a description
 * whose body this would cut is shortened at its source instead
 * (test/editor-gate.test.ts fails on any cut).
 */
function withEditors<C extends { description?: unknown }>(name: string, config: C): C {
  const suffix = editorsSuffix(name.replace(/^figma_/, ""));
  if (!suffix || typeof config?.description !== "string") return config;
  return { ...config, description: fitDescription(config.description, MAX_DESCRIPTION - suffix.length) + suffix };
}

// The same rule as the plugin's (src/plugin/ops/batch.ts notBatchable),
// duplicated rather than imported: the server bundle does not import sandbox
// code. test/batch.test.ts pins that the two agree on every op.
const EXCLUDED: ReadonlySet<string> = new Set(["batch", "group_nodes", "boolean_nodes", "flatten_nodes", "clone_node"]);
/** A motion plan is checked by its own tool (motion-plan.ts), which a batch step would skip. */
const PLAN_OP = "set_motion_plan";
/**
 * The role process's writes are checked by their own tools (brief.ts) — the
 * skill read, the brief's lint, the sign-off's server checks — which a batch
 * step would skip (roles spec §3.4, §3.6).
 */
const ROLE_OPS: ReadonlySet<string> = new Set(["set_brief", "sign_off"]);
/**
 * The trust ops a batch step may not be (trust spec §2.5, §3): a savepoint is
 * stored by the server (tools/trust.ts), which a step never meets, and a stress
 * test builds, checks and removes copies as an undo step of its own. A rollback
 * is destructive, so batchRefusal refuses it already. Checked in validateSteps,
 * not in batchRefusal, which mirrors the plugin's notBatchable and so changes
 * only together with it.
 */
const OWN_CALL_OPS: ReadonlySet<string> = new Set(["savepoint", "stress_test"]);
export const MAX_STEPS = 50;

/** Why `op` cannot be a batch step, or null when it can. */
export function batchRefusal(op: string): string | null {
  if (op === "batch") return "a batch cannot hold another batch";
  const info = OPS.get(op);
  if (!info) return `"${op}" is not a ${PRODUCT_NAME} op`;
  if (info.group !== "modify" && info.group !== "style") return `"${op}" is a ${info.group} op; a batch holds modify and style edits`;
  if (info.destructive) return `"${op}" is destructive and runs on its own call`;
  if (EXCLUDED.has(op)) return `"${op}" replaces nodes with new ids, so later steps could name nodes that no longer exist`;
  if (op === PLAN_OP) return `"${op}" is checked by the server and stored on its own call, before the keyframes that need it`;
  if (ROLE_OPS.has(op)) return `"${op}" is checked by the server and runs on its own call`;
  if (OWN_CALL_OPS.has(op)) return `"${op}" runs on its own call`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse and check `steps`: JSON, 1–50 `{ op, params }`, each op batchable and
 * registered here, each params object valid against that tool's own shape
 * (strictly — an unknown key is refused, not dropped). Returns the parsed steps.
 */
export function validateSteps(raw: unknown, shapeOf: ShapeOf, wanted: (op: string) => boolean): Array<{ op: string; params: Record<string, unknown> }> {
  let steps = raw;
  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch (e) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps\` is not valid JSON: ${(e as Error).message}`, {
        hint: 'Pass a JSON array serialised to a string, e.g. [{"op":"set_fills","params":{"nodeIds":["1:2"],"fills":[{"color":"#ffffff"}]}}].',
      });
    }
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps\` must be a JSON array of 1–${MAX_STEPS} { "op", "params" } entries.`);
  }
  return steps.map((s, i) => {
    if (!isObject(s) || typeof s.op !== "string" || !s.op.trim()) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}]\` needs \`op\`: a tool name without "figma_", e.g. "set_fills".`);
    }
    for (const k of Object.keys(s)) {
      if (k !== "op" && k !== "params") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].${k}\` is not a step field: a step is { op, params }.`);
    }
    const op = s.op.trim().replace(/^figma_/, "");
    const why = batchRefusal(op);
    if (why) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].op\`: ${why}.`);
    const shape = wanted(op) ? shapeOf(op) : undefined;
    if (!shape) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].op\`: figma_${op} is not registered on this server (BRIDGE_TOOLSET).`);
    }
    const params = s.params ?? {};
    if (!isObject(params)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].params\` must be an object.`);
    for (const k of Object.keys(WRITE_PARAMS)) {
      if (k in params) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].params.${k}\`: the batch takes one \`${k}\`, at the top level, for all its steps.`);
      }
    }
    const own = Object.fromEntries(Object.entries(shape).filter(([k]) => !(k in WRITE_PARAMS)));
    const parsed = z.object(own).strict().safeParse(params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const at = issue.path.map(String).join(".");
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`steps[${i}].params${at ? `.${at}` : ""}\`: ${issue.message}`, {
        hint: `The parameters are figma_${op}'s own; its tool description lists them.`,
      });
    }
    return { op, params: parsed.data as Record<string, unknown> };
  });
}

/**
 * The motion gate for a batch's keyframe steps (motion-process.ts), each layer
 * asked once: strict refuses the whole batch at the first step that may not
 * run, guided collects warnings.
 */
async function gateKeyframeSteps(
  bridge: Bridge,
  proc: MotionProcess,
  steps: Array<{ op: string; params: Record<string, unknown> }>,
  session: string | undefined,
  extra: Extra,
): Promise<{ refusal?: BridgeError; warnings: string[] }> {
  // The ids inside the steps as the plugin will see them, and the session a link names.
  const addressed = await addressCall(bridge, "batch", { steps }, session);
  const seen = new Map<string, GateResult>();
  const warnings = new Set<string>();
  for (const [i, s] of (addressed.params.steps as typeof steps).entries()) {
    if (!KEYFRAME_OPS.has(s.op)) continue;
    const nodeId = String(s.params.nodeId);
    let gate = seen.get(nodeId);
    if (!gate) {
      gate = await keyframeGate(proc, bridge, `figma_batch's figma_${s.op} step`, nodeId, addressed.session, extra.signal);
      seen.set(nodeId, gate);
    }
    if (gate.refusal) {
      const r = gate.refusal;
      return { refusal: new BridgeError(r.code, `steps[${i}]: ${r.message}`, { ...(r.hint ? { hint: r.hint } : {}), partial: r.partial }), warnings: [] };
    }
    for (const w of gate.warnings) warnings.add(w);
  }
  return { warnings: [...warnings] };
}

/**
 * The role gate for a batch's steps (role-process.ts newWorkGate), each judged
 * as its own op; strict refuses the whole batch at the first step that is new
 * work, as the motion gate does (spec §3.3). A batch holds modify and style
 * edits only, none of which is new work, so today every batch passes without a
 * read: this keeps the rule if a create op ever becomes a step.
 */
export async function gateNewWorkSteps(
  bridge: Bridge,
  roles: RoleProcess,
  steps: Array<{ op: string; params: Record<string, unknown> }>,
  session: string | undefined,
  signal?: AbortSignal,
): Promise<RoleGate> {
  if (!roles.active || !steps.some((s) => GATED_OPS.has(s.op))) return { warnings: [] };
  const addressed = await addressCall(bridge, "batch", { steps }, session);
  const warnings = new Set<string>();
  for (const [i, s] of (addressed.params.steps as typeof steps).entries()) {
    if (!GATED_OPS.has(s.op)) continue;
    const gate = await newWorkGate(roles, bridge, `figma_batch's figma_${s.op} step`, s.op, s.params, addressed.session, signal);
    if (gate.refusal) {
      const r = gate.refusal;
      return { refusal: new BridgeError(r.code, `steps[${i}]: ${r.message}`, { ...(r.hint ? { hint: r.hint } : {}), partial: r.partial }), warnings: [] };
    }
    for (const w of gate.warnings) warnings.add(w);
  }
  return { warnings: [...warnings] };
}

/** `proc` is the motion gate and `roles` the role gate a batch's steps pass (motion-process.ts, role-process.ts). */
export function registerBatch(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, shapeOf: ShapeOf, proc?: MotionProcess, roles?: RoleProcess): void {
  if (!wanted("batch")) return;
  server.registerTool(
    "figma_batch",
    {
      title: "Batch edits",
      description: fitDescription(
        "Several edits in ONE call and ONE undo step — a polish pass over what you built: fills, strokes, radius, " +
          "effects, auto-layout, sizes, text, constraints, names. `steps` is a JSON array of { \"op\": \"set_fills\", " +
          "\"params\": { … } } (tool names without figma_, 1–50), each checked against that tool's own parameters before " +
          "anything runs. Modify and style edits only: no creates (figma_create_from_spec builds), no deletes, nothing " +
          "that replaces nodes with new ids (group, boolean, flatten, clone). Steps run in order and stop at the first " +
          "failure without rolling back: the error's partial.steps and partial.failedAt say what was applied, and one " +
          "Ctrl+Z undoes the whole batch. Success: { steps: [{ index, op, ok, result }], completed, itemsFailed? }. A " +
          "step's ok means it ran; each node it could not change is listed in itemsFailed: [{ step, op, id, error }]. " +
          "Keyframe steps pass the same motion gate as figma_set_keyframes (BRIDGE_PROCESS).",
      ),
      inputSchema: {
        steps: z
          .string()
          .describe('JSON array, e.g. [{"op":"set_corner_radius","params":{"nodeIds":["1:2"],"radius":12}},{"op":"set_opacity","params":{"nodeIds":["1:3"],"opacity":0.6}}].'),
        ...WRITE_PARAMS,
      },
      annotations: writeAnnotations("batch"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      let steps: Array<{ op: string; params: Record<string, unknown> }>;
      try {
        steps = validateSteps(args.steps, shapeOf, wanted);
      } catch (err) {
        const e = err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err;
        // Refused here, so nothing reached Figma: a corrected retry is safe [C-096].
        return errorResult(e, { unchanged: true });
      }
      const forward = () =>
        forwardTool(bridge, "batch", { steps }, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        });
      const keyframes = proc?.active === true && steps.some((s) => KEYFRAME_OPS.has(s.op));
      const newWork = roles?.active === true && steps.some((s) => GATED_OPS.has(s.op));
      if (!keyframes && !newWork) return forward();
      const warnings: string[] = [];
      for (const run of [
        ...(newWork ? [() => gateNewWorkSteps(bridge, roles!, steps, args.session as string | undefined, extra.signal)] : []),
        ...(keyframes ? [() => gateKeyframeSteps(bridge, proc!, steps, args.session as string | undefined, extra)] : []),
      ]) {
        let gate: { refusal?: BridgeError; warnings: string[] };
        try {
          gate = await run();
        } catch (err) {
          return errorResult(err instanceof BridgeError ? err.withKey(args.idempotencyKey as string | undefined) : err, { unchanged: true });
        }
        if (gate.refusal) return errorResult(gate.refusal.withKey(args.idempotencyKey as string | undefined), { unchanged: true });
        warnings.push(...gate.warnings);
      }
      // Like every write, the batch moves writeEpoch(), which makes an earlier figma_check_motion stale.
      return withProcessWarnings(await forward(), warnings);
    },
  );
}
