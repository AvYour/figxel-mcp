// The motion process, enforced by the tools (BRIDGE_PROCESS; spec ADR #41).
//
// A motion designer reads the brief, plans the piece beat by beat, animates on
// that plan, checks every frame and only then renders the delivery. The skills
// teach that order; this module makes the tools keep it, so an agent that skips
// a step is stopped by the call it skipped to, with the calls that satisfy it:
//
//   figma_set_keyframes, figma_remove_keyframes (also as figma_batch steps)
//     need the motion skill read in this process (figma_get_guide on the motion
//     or storyboard skill, their prompts, or their skill:// resources) and a
//     motion plan on the layer's top-level frame (figma_set_motion_plan).
//   figma_export_video { final: true } needs the last figma_check_motion on
//     that frame in this process to have passed, whole, at the render's fps,
//     as the plan's own check: the check applies the frame's plan (its tempo,
//     holds, brand, CTA and accepted findings) and anything looser in the call
//     keeps it from counting (tools/check-motion.ts). The plan must be the one
//     it judged, and the file unchanged since: no write sent through this
//     process (writeEpoch) and no change the plugin reported on its current
//     page (lastNodesChanged, from nodechange), which covers an undo, a clone
//     or a text edit, figma_eval, another client and an edit by hand alike.
//     A preview always renders.
//
// "strict" (the default) refuses with PROCESS_REQUIRED before anything is sent;
// "guided" runs the call and lists what was skipped as `processWarnings`; "off"
// tracks nothing. The state is this process's: each MCP client has its own
// process, and a proxy keeps its own client's state while the hub holds the
// Figma connection. A frame is keyed by its file's session too, since node ids
// are per file. The plan lives in the file (shared plugin data), so every
// process and every later session reads the same plan.
//
// A change Figma reports from the moment a check began counts against it, so
// an edit made just before the check may too: the plugin reports changes
// debounced. That doubt costs one more check, never a delivery of a state no
// check saw.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, ErrorCode } from "../shared/errors.js";
import type { MotionPlanRecord } from "../shared/motion-plan.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME } from "../shared/version.js";
import type { Bridge } from "./bridge.js";
import type { ProcessMode } from "./config.js";
import { writeEpoch } from "./tools/forward.js";

/** The skills whose reading counts as reading the motion skill (figma_get_guide topics, prompt rows, skill:// folders). */
export const MOTION_SKILLS: ReadonlySet<string> = new Set(["motion", "storyboard"]);
/** The ops the keyframe gate stands in front of, directly or as batch steps. */
export const KEYFRAME_OPS: ReadonlySet<string> = new Set(["set_keyframes", "remove_keyframes"]);

export const SKILL_CALL = 'figma_get_guide { topic: "motion" }';
export const planCall = (frameId: string) =>
  `figma_set_motion_plan { nodeId: "${frameId}", brief: { audience, message, format, durationS, fps }, beats: [{ name, from, to, onScreen, action, transition }] }`;
export const checkCall = (frameId: string, fps: number) => `figma_check_motion { nodeId: "${frameId}", fps: ${fps} }`;
export const finalCall = (frameId: string, fps: number) => `figma_export_video { nodeId: "${frameId}", fps: ${fps}, final: true }`;

/** Node ids are per file, so a frame is keyed by the session it lives in as well. */
const keyOf = (frameId: string, session: string) => `${session}|${frameId}`;

/** A plan as the check and the final gate compare it: its stored JSON, or null for none. */
export const planKey = (plan: MotionPlanRecord | null | undefined): string | null => (plan ? JSON.stringify(plan) : null);

/** A finding the plan accepted, as the delivery's result names it. */
export interface AcceptedNote {
  rule: string;
  name: string;
  frame: number;
  frames?: [number, number];
  reason: string;
}

/** What the last figma_check_motion on a frame said, as the final gate reads it. */
export interface CheckRecord {
  ok: boolean;
  fps: number;
  /** Every rule over the whole timeline, every layer read: no `rules`, `from` or `to`, not truncated. */
  full: boolean;
  /** Where the call was looser than the frame's plan or the measured defaults (tools/check-motion.ts withPlan). */
  gaps: string[];
  /** The plan it judged against (planKey). */
  plan: string | null;
  /** writeEpoch() when the check began. */
  epoch: number;
  /** Date.now() when the check began. */
  at: number;
  accepted: AcceptedNote[];
}

/** The file as a final render finds it (fileNow), held against a check's record. */
export interface FileNow {
  /** writeEpoch() now. */
  epoch: number;
  /** When Figma last reported a change in the frame's file; Infinity when there is no telling. */
  changedAt: number;
  /** The frame's plan now (planKey); left out when it was not read. */
  plan?: string | null;
}

/**
 * The file now: this process's write count, when the plugin last reported a
 * change in `session` (in any connected file when it is ""), and the frame's
 * plan when the caller read it. Any doubt reads as a change just now.
 */
export async function fileNow(bridge: Bridge, session: string, plan?: MotionPlanRecord | null): Promise<FileNow> {
  const epoch = writeEpoch();
  const at = (changedAt: number): FileNow => ({ epoch, changedAt, ...(plan !== undefined ? { plan: planKey(plan) } : {}) });
  let rows: Array<{ sessionId: string; lastNodesChanged?: { at: number } | null }>;
  try {
    rows = (await bridge.statusAsync()).sessions;
  } catch {
    return at(Number.POSITIVE_INFINITY);
  }
  const mine = session === "" ? rows : rows.filter((s) => s.sessionId === session);
  if (session !== "" && mine.length === 0) return at(Number.POSITIVE_INFINITY);
  return at(Math.max(Number.NEGATIVE_INFINITY, ...mine.map((s) => s.lastNodesChanged?.at ?? Number.NEGATIVE_INFINITY)));
}

export class MotionProcess {
  private skill: string | null = null;
  private readonly checks = new Map<string, CheckRecord>();
  /** The tools registered on this server, so a refusal can say that figma_check_motion is not among them. */
  registered: ReadonlySet<string> = new Set();

  constructor(readonly mode: ProcessMode) {}

  /** Whether anything is tracked: false only with BRIDGE_PROCESS=off. */
  get active(): boolean {
    return this.mode !== "off";
  }

  /** How the motion skill was first read in this process, or null. */
  get skillRead(): string | null {
    return this.skill;
  }

  /** A skill was read (`short` is its figma_get_guide topic); only the motion and storyboard skills count. */
  noteSkill(short: string, via: string): void {
    if (this.skill === null && MOTION_SKILLS.has(short)) this.skill = via;
  }

  /** figma_check_motion judged the frame of `session` (sessionIdOf). The last check on a frame is the one that counts. */
  noteCheck(frameId: string, check: CheckRecord, session = ""): void {
    this.checks.set(keyOf(frameId, session), check);
  }

  /** The last check on the frame, if one ran in this process. */
  lastCheck(frameId: string, session = ""): CheckRecord | undefined {
    return this.checks.get(keyOf(frameId, session));
  }

  /** What still stands between the frame and a final render at `fps`, with the file as `now` finds it: [] when it may run. */
  finalBlockers(frameId: string, fps: number, session: string, now: FileNow): string[] {
    const c = this.checks.get(keyOf(frameId, session));
    if (!c) return ["figma_check_motion has not run on this frame in this session"];
    const out: string[] = [];
    if (!c.ok) {
      out.push(
        "the last figma_check_motion on this frame did not pass (ok: false): fix its errors and warnings; stillness the brief intends goes in the plan's `holds`, and any other finding it intends in the plan's `accept`",
      );
    }
    if (!c.full) out.push("the last figma_check_motion on this frame judged only some rules, a window or some layers (`rules`, `from`, `to`, `maxNodes`); a final render needs the whole check");
    if (c.gaps.length) out.push(`the last figma_check_motion was looser than the frame's plan (${c.gaps.join("; ")}): leave those out and the check applies the plan's own`);
    if (c.fps !== fps) out.push(`the last figma_check_motion judged ${c.fps} fps and this render is ${fps} fps: check at the delivery rate`);
    if (now.plan !== undefined && now.plan !== c.plan) out.push("the frame's motion plan is not the one the last figma_check_motion judged against");
    else if (now.epoch !== c.epoch) out.push(`the file changed after the last figma_check_motion (a write sent through ${PRODUCT_NAME})`);
    else if (now.changedAt >= c.at) out.push("the file changed after the last figma_check_motion (Figma reported a change: an edit by hand, by another client or through figma_eval, or an undo)");
    return out;
  }
}

// ── reading the plan ─────────────────────────────────────────────────────────

type SessionRow = { sessionId: string; active?: boolean; file?: { name?: string | null } };

/**
 * The id of the session a call goes to: the one `session` names (an id or a
 * file name), else the active one, as the bridge picks for a call without it.
 * "" when there is no telling, such as before any plugin connected: frames
 * then key as if every one were in one file.
 */
export async function sessionIdOf(bridge: Bridge, session: string | undefined): Promise<string> {
  let sessions: SessionRow[];
  try {
    sessions = (await bridge.statusAsync()).sessions as SessionRow[];
  } catch {
    return session ?? "";
  }
  const picked =
    session === undefined
      ? (sessions.find((s) => s.active) ?? (sessions.length === 1 ? sessions[0] : undefined))
      : (sessions.find((s) => s.sessionId === session) ?? sessions.find((s) => (s.file?.name ?? "").toLowerCase() === session.toLowerCase()));
  return picked?.sessionId ?? session ?? "";
}

export interface PlanLookup {
  /** The top-level frame around the node; null for a page, a section or a node outside every frame. */
  frameId: string | null;
  frameName: string | undefined;
  plan: MotionPlanRecord | null;
  /** Why a stored plan could not be read. */
  invalid: string | undefined;
  /** The session the frame lives in (sessionIdOf). */
  session: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The plan of the top-level frame around `nodeId` (already addressed): one
 * figma_get_motion_context read of that layer alone, which names the frame and
 * carries its plan. A plugin that predates plans answers without them.
 */
export async function lookUpPlan(bridge: Bridge, nodeId: string, session: string | undefined, signal?: AbortSignal): Promise<PlanLookup> {
  const data = await bridge.request("get_motion_context", { nodeId, recursive: false, maxNodes: 1 }, {
    ...(session !== undefined ? { session } : {}),
    ...(signal ? { signal } : {}),
  });
  const d = isObject(data) ? data : {};
  const ids = isObject(d.scope) ? d.scope.topLevelFrameIds : undefined;
  if (!Array.isArray(ids)) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "The connected plugin predates motion plans, so the frame's plan cannot be read.", {
      hint: `Ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}).`,
    });
  }
  const frameId = typeof ids[0] === "string" ? ids[0] : null;
  const entry = (Array.isArray(d.motionPlans) ? d.motionPlans : []).find((p) => isObject(p) && p.frameId === frameId) as Record<string, unknown> | undefined;
  return {
    session: await sessionIdOf(bridge, session),
    frameId,
    frameName: typeof entry?.name === "string" ? entry.name : undefined,
    plan: isObject(entry?.plan) ? (entry.plan as unknown as MotionPlanRecord) : null,
    invalid: typeof entry?.invalid === "string" ? entry.invalid : undefined,
  };
}

/** A failed plan read, said as the step of the call it stands in front of. */
function lookupFailed(tool: string, mode: ProcessMode, err: unknown): BridgeError {
  const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
  return new BridgeError(e.code, `Before ${tool}, ${PRODUCT_NAME} reads the frame's motion plan (BRIDGE_PROCESS=${mode}), and that read failed: ${e.message}`, {
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    partial: { created: [] },
  });
}

const frameLabel = (look: PlanLookup) => `the top-level frame ${look.frameName ? `"${look.frameName}" ` : ""}(${look.frameId})`;

// ── the gates ────────────────────────────────────────────────────────────────

export interface GateResult {
  /** Strict mode's answer: send nothing, return this. */
  refusal?: BridgeError;
  /** Guided mode's: run the call, and add these as `processWarnings`. */
  warnings: string[];
  /** The session the frame lives in (sessionIdOf); "" when unknown. */
  session: string;
  /** finalGate: the findings the plan accepted in the check that cleared the render, for its result. */
  accepted?: AcceptedNote[];
}

/** The plan and skill a keyframe write on `nodeId` needs. Call only while the process is active. */
export async function keyframeGate(proc: MotionProcess, bridge: Bridge, tool: string, nodeId: string, session: string | undefined, signal?: AbortSignal): Promise<GateResult> {
  const missing: string[] = [];
  const calls: string[] = [];
  if (!proc.skillRead) {
    missing.push("the motion skill has not been read in this session");
    calls.push(SKILL_CALL);
  }
  let look: PlanLookup;
  try {
    look = await lookUpPlan(bridge, nodeId, session, signal);
  } catch (err) {
    const failed = lookupFailed(tool, proc.mode, err);
    if (proc.mode === "strict") return { refusal: failed, warnings: [], session: "" };
    return { warnings: [...missing.map((m, i) => `${m}: ${calls[i]}.`), failed.message], session: "" };
  }
  const at = { session: look.session };
  if (look.frameId !== null && !look.plan) {
    missing.push(`${frameLabel(look)} has no motion plan${look.invalid ? ` (${look.invalid})` : ""}`);
    calls.push(planCall(look.frameId));
  }
  if (missing.length === 0) return { warnings: [], ...at };
  if (proc.mode === "strict") {
    return {
      refusal: new BridgeError(
        ErrorCode.PROCESS_REQUIRED,
        `${tool} was refused before any change: a motion designer plans before animating, and this session skipped a step. Missing: ${missing.join("; ")}.`,
        { hint: `First ${calls.join(", then ")}. Then send this call again.`, partial: { created: [], missing } },
      ),
      warnings: [],
      ...at,
    };
  }
  return { warnings: missing.map((m, i) => `${m}: ${calls[i]}.`), ...at };
}

/** What a final render of the frame around `nodeId` at `fps` needs. Call only while the process is active. */
export async function finalGate(proc: MotionProcess, bridge: Bridge, nodeId: string, session: string | undefined, fps: number, signal?: AbortSignal): Promise<GateResult> {
  const tool = "figma_export_video { final: true }";
  let look: PlanLookup;
  try {
    look = await lookUpPlan(bridge, nodeId, session, signal);
  } catch (err) {
    const failed = lookupFailed(tool, proc.mode, err);
    return proc.mode === "strict" ? { refusal: failed, warnings: [], session: "" } : { warnings: [failed.message], session: "" };
  }
  // A page or a node outside every frame: Figma refuses the render itself, in its own words.
  if (look.frameId === null) return { warnings: [], session: look.session };
  const accepted = proc.lastCheck(look.frameId, look.session)?.accepted ?? [];
  const at = { session: look.session, ...(accepted.length ? { accepted } : {}) };
  const blockers = proc.finalBlockers(look.frameId, fps, look.session, await fileNow(bridge, look.session, look.plan));
  if (blockers.length === 0) return { warnings: [], ...at };
  const check = checkCall(look.frameId, fps);
  const absent =
    proc.registered.size > 0 && !proc.registered.has("figma_check_motion")
      ? " figma_check_motion is not registered on this server: the read group must be in BRIDGE_TOOLSET."
      : "";
  if (proc.mode === "strict") {
    return {
      refusal: new BridgeError(
        ErrorCode.PROCESS_REQUIRED,
        `A final render of ${frameLabel(look)} waits for a passing check; nothing was rendered: ${blockers.join("; ")}.`,
        {
          hint: `Run ${check}, fix what it finds until ok: true, then ${finalCall(look.frameId, fps)}. A preview (no \`final\`) renders now.${absent}`,
          partial: { created: [], missing: blockers },
        },
      ),
      warnings: [],
      ...at,
    };
  }
  return { warnings: blockers.map((b) => `${b}: ${check}.`), ...at };
}

/**
 * A result with `processWarnings` added where the agent reads it: in the data
 * of a JSON result, else as one more text block.
 */
export function withProcessWarnings(result: CallToolResult, warnings: readonly string[]): CallToolResult {
  if (warnings.length === 0) return result;
  const s = result.structuredContent;
  const first = result.content[0];
  if (!result.isError && s && first?.type === "text") {
    const structured = { ...s, processWarnings: [...warnings] };
    return { ...result, structuredContent: structured, content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...result.content.slice(1)] };
  }
  return { ...result, content: [...result.content, { type: "text", text: `processWarnings: ${warnings.join(" ")}` }] };
}
