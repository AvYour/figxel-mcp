// figma_set_motion_plan on the server side: the schema, the plan checked here
// before the bridge is asked (src/server/motion-plan.ts), so a refusal provably
// changed nothing [C-096], and a result that says what the plan means in
// frames and which figma_check_motion call judges the piece. The check reads
// the plan itself and holds the piece to it (tools/check-motion.ts).
//
// Registered by the integrator in tools/index.ts, before registerBatch; the op
// is a style write, but a batch never holds it (batch.ts).
//
// The plan extends a role-motion brief (spec §3.10): the brief comes first,
// the plan belongs to one frame, and the brief's audience, message, format,
// duration and fps need not be written twice — fields the call leaves out are
// taken from the brief named by `briefId`, else the motion brief in force.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { MOTION_PLAN_LIMITS as L, PLAN_FPS } from "../../shared/motion-plan.js";
import type { Bridge } from "../bridge.js";
import { ISSUE_RULES } from "../motion-audit.js";
import { planMotion, type MotionPlanCheck } from "../motion-plan.js";
import { SKILL_CALL, type MotionProcess } from "../motion-process.js";
import { fileOf, readBrief, type RoleProcess } from "../role-process.js";
import { errorResult, okResult } from "../results.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

// Nested objects are strict: zod's default strips an unknown key before the checker sees it (params.ts).
const brief = z
  .object({
    audience: z.string().min(1).max(L.text).optional().describe("Who it is for. Default: the motion brief's."),
    message: z.string().min(1).max(L.text).optional().describe("The one thing it must say. Default: the motion brief's."),
    format: z.string().min(1).max(L.format).optional().describe('Size and placement, e.g. "1080x1920 IG Reels". Default: the motion brief\'s format, else its placement.'),
    durationS: z.number().positive().max(L.totalS).optional().describe("Length in seconds, a whole number of frames. Default: the motion brief's."),
    fps: z.number().int().optional().describe(`Delivery rate: ${PLAN_FPS.join(", ")}. Default: the motion brief's.`),
    bpm: z.number().min(L.bpm[0]).max(L.bpm[1]).optional().describe("Tempo: accents are held to its beat grid."),
    beatOffset: z.number().min(0).optional().describe("First downbeat, s. Default 0; needs bpm."),
  })
  .strict();

const beat = z
  .object({
    name: z.string().min(1).max(L.name).describe('The story beat, e.g. "hook".'),
    from: z.number().min(0).describe("Start, s: the previous beat's `to`; the first starts at 0."),
    to: z.number().positive().describe("End, s."),
    onScreen: z
      .string()
      .max(L.text)
      .describe('The copy on screen, timed for reading; a picture note in [brackets] is not timed, e.g. "[logo on black] Bake it yourself". "" for none.'),
    action: z.string().min(1).max(L.text).describe("What moves, and how."),
    transition: z.string().min(1).max(L.text).describe("Into the next beat, and what motivates it; for the last beat, how the piece ends."),
    accent: z.number().min(0).optional().describe("A hit inside the beat, s: on the beat grid when the brief has bpm."),
  })
  .strict();

export const MOTION_PLAN_SHAPE = {
  nodeId: z.string().describe("The animated top-level frame, or any layer in it (id or Figma link)."),
  brief: brief.describe("The motion brief; fields left out come from a role-motion brief."),
  briefId: z.string().optional().describe("The role-motion brief to take left-out fields from (figma_set_brief returns its id). Default: the motion brief in force."),
  beats: z.array(beat).min(1).max(L.beats).describe("The beat sheet, in order, back to back from 0 to brief.durationS."),
  holds: z
    .array(z.object({ from: z.number().min(0).describe("Seconds."), to: z.number().min(0).describe("Seconds.") }).strict())
    .max(L.holds)
    .optional()
    .describe("Intended stillness, in seconds: what figma_check_motion's `holds` exempts."),
  cuts: z.array(z.number().min(0)).max(L.cuts).optional().describe("Planned hard cuts, in seconds."),
  brandId: z.string().optional().describe("The brand layer in the frame, for figma_check_motion's brand_late."),
  ctaId: z.string().optional().describe("The call-to-action layer in the frame, for cta_short."),
  accept: z
    .array(
      z
        .object({
          rule: z.enum(ISSUE_RULES).describe('The figma_check_motion rule, e.g. "cold_open".'),
          reason: z.string().min(1).max(L.text).describe("Why the brief wants it; the report names it."),
          from: z.number().min(0).optional().describe("Seconds: the finding starts here or later. Default 0."),
          to: z.number().min(0).optional().describe("Seconds: the finding ends here or earlier. Default the end."),
        })
        .strict(),
    )
    .max(L.accept)
    .optional()
    .describe("Findings the brief intends (a still open, a hard-cut grammar, a loop): figma_check_motion lists them in `accepted`, not against ok."),
};

const DESCRIPTION =
  "Record the plan of one animated top-level frame before animating it, as a motion designer does: the brief " +
  "(audience, message, format, durationS, fps, bpm?) and the beat sheet, beats back to back from 0 to durationS, " +
  "each with its copy on screen, action and transition. A role-motion brief (figma_set_brief { role: \"motion\" }; " +
  "`briefId`, or the one in force) fills the fields left out. Checked before anything is stored: times on the " +
  "frame grid; no gap or overlap; each beat long enough to read its copy, max(5/6 s, 0.3 s a word); accents on " +
  "the bpm grid; every transition named. Stored on the frame; a new call replaces it. figma_check_motion judges " +
  "the frame against it: bpm, holds, brandId, ctaId and `accept` (findings the brief intends, with reasons). " +
  "Under BRIDGE_PROCESS=strict the keyframe tools refuse a frame without a plan. The result gives each beat's " +
  "frames and `check`, the figma_check_motion call. One undo step.";

const INHERITED = ["audience", "message", "format", "durationS", "fps"] as const;

/**
 * The call's brief with the fields it left out taken from a role-motion brief
 * (spec §3.10): the one `briefId` names, else the motion brief in force for the
 * file. Nothing to fill, or no motion brief to fill it from: the call as sent,
 * and planMotion names what is missing.
 */
async function withBrief(bridge: Bridge, roles: RoleProcess | undefined, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const given = (args.brief && typeof args.brief === "object" ? args.brief : {}) as Record<string, unknown>;
  if (INHERITED.every((k) => given[k] !== undefined)) return args;
  const session = args.session as string | undefined;
  let briefId = args.briefId as string | undefined;
  if (briefId === undefined && roles?.active) {
    const ref = roles.inForce((await fileOf(bridge, session)).key);
    if (ref?.role === "motion") briefId = ref.briefId;
  }
  if (briefId === undefined) return args;
  const read = await readBrief(bridge, { briefId }, session, signal);
  const b = read.brief;
  if (!b) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `No brief is stored on ${briefId}${read.invalid ? ` (${read.invalid})` : ""}, so the plan's left-out fields cannot be taken from it.`);
  }
  if (b.role !== "motion") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `The brief on ${briefId} is a ${b.role} brief; a motion plan takes its fields from a motion brief.`, {
      hint: 'Write the plan\'s brief in full, or record the piece\'s own brief first: figma_set_brief { role: "motion", gear, title, goal, message, success, details: { placement, durationS, fps } }.',
    });
  }
  const d = b.details as Record<string, unknown>;
  const from: Record<string, unknown> = {
    audience: b.lines.audience,
    message: b.lines.message,
    format: b.lines.format ?? d.placement,
    durationS: d.durationS,
    fps: d.fps,
  };
  const filled = { ...given };
  for (const k of INHERITED) if (filled[k] === undefined && from[k] !== undefined) filled[k] = from[k];
  const out = { ...args, brief: filled };
  delete (out as Record<string, unknown>).briefId;
  return out;
}

/** The result: what the plugin stored, the plan in frames, and the check that judges the piece against it. */
function shapeResult(data: unknown, checked: MotionPlanCheck, proc: MotionProcess | undefined) {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const { brief: b } = checked.record;
  const frameId = typeof d.frameId === "string" ? d.frameId : undefined;
  const check: Record<string, unknown> = {
    ...(frameId ? { nodeId: frameId } : {}),
    fps: b.fps,
    ...(b.bpm !== undefined ? { bpm: b.bpm } : {}),
    ...(b.beatOffset !== undefined ? { beatOffset: b.beatOffset } : {}),
    ...(checked.record.holds ? { holds: checked.record.holds } : {}),
    ...(checked.record.brandId ? { brandId: checked.record.brandId } : {}),
    ...(checked.record.ctaId ? { ctaId: checked.record.ctaId } : {}),
  };
  return okResult({
    ...d,
    durationS: b.durationS,
    fps: b.fps,
    durationFrames: checked.durationFrames,
    beats: checked.beats,
    check,
    next:
      "Animate on these beats: block the poses on their frames, then curves, then polish. figma_check_motion with `check` " +
      "after each pass; preview renders with figma_export_video; the delivery with `final: true` once the check passes.",
    ...(proc?.active && !proc.skillRead ? { processWarnings: [`Keyframe writes also need the motion skill read in this session: ${SKILL_CALL}.`] } : {}),
  });
}

/**
 * Register figma_set_motion_plan. Wired by the integrator in tools/index.ts
 * before registerBatch: registerMotionPlan(server, bridge, wanted, process).
 */
export function registerMotionPlan(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, proc?: MotionProcess, roles?: RoleProcess): void {
  if (!wanted("set_motion_plan")) return;
  server.registerTool(
    "figma_set_motion_plan",
    {
      title: "Set the motion plan of a frame",
      description: fitDescription(DESCRIPTION),
      inputSchema: { ...MOTION_PLAN_SHAPE, ...WRITE_PARAMS },
      annotations: writeAnnotations("set_motion_plan"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      let checked: MotionPlanCheck;
      try {
        args = await withBrief(bridge, roles, args, extra.signal);
        checked = planMotion(args);
      } catch (err) {
        // Refused here, before the bridge was asked: nothing changed, a retry is safe [C-096].
        return errorResult(err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err, { unchanged: true });
      }
      return forwardTool(bridge, "set_motion_plan", { nodeId: args.nodeId, plan: checked.record }, extra, {
        session: args.session as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
        shape: (data) => shapeResult(data, checked, proc),
      });
    },
  );
}
