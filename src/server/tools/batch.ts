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
import { errorResult } from "../results.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
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
 */
export function createShapeRecorder(server: McpServer): ShapeOf {
  const shapes = new Map<string, z.ZodRawShape>();
  const original = server.registerTool.bind(server) as (name: string, config: { inputSchema?: unknown; description?: unknown }, cb: unknown) => unknown;
  (server as unknown as { registerTool: typeof original }).registerTool = (name, rawConfig, cb) => {
    const config = withEditors(name, rawConfig);
    const schema = config?.inputSchema;
    if (schema && typeof schema === "object" && !(schema instanceof z.ZodType)) {
      shapes.set(name.replace(/^figma_/, ""), schema as z.ZodRawShape);
      return original(name, { ...config, inputSchema: z.object(schema as z.ZodRawShape).strict() }, cb);
    }
    return original(name, config, cb);
  };
  return (op) => shapes.get(op);
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
export const MAX_STEPS = 50;

/** Why `op` cannot be a batch step, or null when it can. */
export function batchRefusal(op: string): string | null {
  if (op === "batch") return "a batch cannot hold another batch";
  const info = OPS.get(op);
  if (!info) return `"${op}" is not a ${PRODUCT_NAME} op`;
  if (info.group !== "modify" && info.group !== "style") return `"${op}" is a ${info.group} op; a batch holds modify and style edits`;
  if (info.destructive) return `"${op}" is destructive and runs on its own call`;
  if (EXCLUDED.has(op)) return `"${op}" replaces nodes with new ids, so later steps could name nodes that no longer exist`;
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

export function registerBatch(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, shapeOf: ShapeOf): void {
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
          "step's ok means it ran; each node it could not change is listed in itemsFailed: [{ step, op, id, error }].",
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
      return forwardTool(bridge, "batch", { steps }, extra, {
        session: args.session as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      });
    },
  );
}
