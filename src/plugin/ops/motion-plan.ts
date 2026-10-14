// figma_set_motion_plan in the plugin: store a plan the server has checked
// (src/server/motion-plan.ts) on the top-level frame it belongs to, in shared
// plugin data, the storyboard record's namespace [C-188] — so every session,
// and every later server, reads the same plan. Every check runs before the one
// write, so a refusal changed nothing. readMotionPlan is how
// figma_get_motion_context reports a frame's plan.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { MOTION_PLAN_KEY, MOTION_PLAN_NAMESPACE, parseMotionPlan, type MotionPlanRecord } from "../../shared/motion-plan.js";
import { beforeMutating } from "../guard.js";
import { byId, reqStr, topLevelFrameOf, type FigmaLike, type NodeLike } from "../read.js";
import type { OpContext, PluginOp } from "./index.js";

type DataNode = NodeLike & {
  getSharedPluginData?(namespace: string, key: string): string;
  setSharedPluginData?(namespace: string, key: string, value: string): void;
};

const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (msg: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, msg, hint ? { hint } : {});

/** setSharedPluginData caps one entry at 100 kB [C-188]; a character is at least a byte. */
const MAX_CHARS = 100_000;

/** The plan stored on a top-level frame: null when it has none, with `invalid` when the stored text is not a plan. */
export function readMotionPlan(frame: NodeLike): { plan: MotionPlanRecord | null; invalid?: string } {
  const get = (frame as DataNode).getSharedPluginData;
  if (typeof get !== "function") return { plan: null };
  let raw: string;
  try {
    raw = String(get.call(frame, MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY) ?? "");
  } catch {
    return { plan: null };
  }
  if (!raw) return { plan: null };
  const parsed = parseMotionPlan(raw);
  return "plan" in parsed ? { plan: parsed.plan } : { plan: null, invalid: parsed.invalid };
}

/** A layer the plan names (brandId, ctaId) must be one of the frame's own. */
async function checkMember(plan: Record<string, unknown>, key: "brandId" | "ctaId", frame: NodeLike): Promise<void> {
  const id = plan[key];
  if (typeof id !== "string") return;
  let node: NodeLike;
  try {
    node = await byId(api(), id);
  } catch (err) {
    const e = err instanceof BridgeError ? err : invalid(String(err));
    throw new BridgeError(e.code, `\`${key}\`: ${e.message}`, e.hint ? { hint: e.hint } : {});
  }
  if (topLevelFrameOf(node)?.id !== frame.id) {
    throw invalid(`\`${key}\` "${node.name}" (${node.id}) is not inside "${frame.name}".`, "Name a layer of the planned frame.");
  }
}

const setMotionPlan: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { frame, json, replaced } = await beforeMutating(async () => {
      const nodeId = reqStr(ctx.params, "nodeId");
      const plan = ctx.params.plan;
      if (!isObject(plan) || plan.v !== 1 || !isObject(plan.brief) || !Array.isArray(plan.beats) || plan.beats.length === 0) {
        throw invalid("`plan` must be a checked motion plan (v 1, a brief and beats).", "figma_set_motion_plan checks the plan and sends it here.");
      }
      const json = JSON.stringify(plan);
      if (json.length > MAX_CHARS) throw invalid(`The plan is ${json.length} characters; shared plugin data holds at most 100 kB.`, "Shorten the copy and the notes.");
      const node = await byId(api(), nodeId);
      if (node.type === "PAGE" || node.type === "DOCUMENT" || node.type === "SECTION") {
        throw invalid(`\`nodeId\` is a ${node.type}; a plan belongs to an animated top-level frame.`, "Pass the frame, or any layer inside it.");
      }
      const frame = topLevelFrameOf(node);
      if (!frame) throw invalid(`"${node.name}" is not inside a top-level frame.`, "Pass the frame the piece is animated in, or any layer inside it.");
      await checkMember(plan, "brandId", frame);
      await checkMember(plan, "ctaId", frame);
      if (typeof (frame as DataNode).setSharedPluginData !== "function") {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${frame.type} takes no shared plugin data in this editor.`);
      }
      const before = readMotionPlan(frame);
      return { frame, json, replaced: before.plan !== null || before.invalid !== undefined };
    });
    (frame as DataNode).setSharedPluginData!(MOTION_PLAN_NAMESPACE, MOTION_PLAN_KEY, json);
    return { frameId: frame.id, frameName: frame.name, replaced };
  },
};

/** Wired into PLUGIN_OPS by the integrator (src/plugin/ops/index.ts). */
export const MOTION_PLAN_OPS: Record<string, PluginOp> = {
  set_motion_plan: setMotionPlan,
};
