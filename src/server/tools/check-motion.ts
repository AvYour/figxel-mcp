// figma_check_motion on the server: forward the plugin op `check_motion`, which
// reads the animated frame as a snapshot, then judge it here
// (src/server/motion-audit.ts). The judging is on the server so that every rule
// is a pure function tested against the run's recorded snapshots [C-246].
//
// Every parameter is checked before Figma is asked anything; brandId and ctaId
// are the only ones that need the snapshot, and they are refused after it,
// which a read can afford.
//
// The snapshot carries the frame's motion plan, and the check is judged
// against it (withPlan): the plan fills the tempo, holds, brand and CTA a call
// leaves out, and its `accept` is the only way a finding stops counting
// against ok. A call looser than the plan, or than the measured defaults,
// still runs as asked, but under BRIDGE_PROCESS it cannot clear the delivery.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { MotionSnapshot } from "../../shared/motion-curves.js";
import type { MotionPlanRecord } from "../../shared/motion-plan.js";
import type { Bridge } from "../bridge.js";
import { toNodeId } from "../figma-url.js";
import {
  auditMotion,
  DEFAULT_BRAND_BY_S,
  DEFAULT_CTA_MIN_S,
  DEFAULT_THRESHOLDS,
  RULE_IDS,
  type AuditOptions,
  type Severity,
  type Thresholds,
} from "../motion-audit.js";
import { finalCall, planKey, sessionIdOf, type MotionProcess } from "../motion-process.js";
import { errorResult, okResult } from "../results.js";
import { readAnnotations } from "./annotations.js";
import { addressCall, forwardTool, writeEpoch, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

const share = z.number().positive().max(1);
const positive = z.number().positive();

// Nested objects are strict: zod's default would strip a misspelt threshold and run with the default (params.ts).
const thresholds = z
  .object({
    stepShare: share.optional().describe("One frame carrying this share of a move. Default 0.4."),
    stepPx: positive.optional().describe("Smallest jump that counts, px. Default 24."),
    strobeInfoPx: positive.optional().describe("Step with no blur reported as info, px per frame. Default 60."),
    strobeWarnPx: positive.optional().describe("Step with no blur reported as a warning. Default 150."),
    strobeAnyBlurPx: positive.optional().describe("Step no blur covers. Default 400."),
    aliveSpeedPx: positive.optional().describe("Slower than this reads as still, px per frame. Default 1."),
    deadSpanS: positive.optional().describe("Stillness reported from this long, s. Default 0.5."),
    minHoldFrames: positive.optional().describe("Frames an arrived state must stay. Default 3."),
    readSecondsPerWord: positive.optional().describe("Reading time per word, s. Default 0.3."),
    beatToleranceFrames: z.number().min(0).optional().describe("Accent offset allowed from the beat grid, frames. Default 1."),
    oneCurveShare: share.optional().describe("Share of eased moves on one curve that is reported. Default 0.7."),
    templateParents: positive.optional().describe("Parents sharing one entry move that is reported; a clipping frame around one layer is its mask, so the mask's parent counts. Default 3."),
    templateShare: share.optional().describe("Share of animated layers sharing one entry move. Default 0.4."),
  })
  .strict();

// Seconds, or frames as figma_review_video takes them: the 2026-10-14 run passed
// one tool's shape to the other, so each takes both.
const span = z
  .object({
    from: z.number().min(0).optional().describe("Seconds."),
    to: z.number().min(0).optional().describe("Seconds, after `from`."),
    fromFrame: z.number().int().min(0).optional().describe("Or frames at `fps`, inclusive, as figma_review_video takes them."),
    toFrame: z.number().int().min(0).optional().describe("Frames, inclusive."),
  })
  .strict();

type Span = { from?: number; to?: number; fromFrame?: number; toFrame?: number };

/** One hold in seconds, from either shape; refuses a mix or half of one. */
function holdInSeconds(h: Span, i: number, fps: number): { from: number; to: number } {
  const seconds = h.from !== undefined || h.to !== undefined;
  const frames = h.fromFrame !== undefined || h.toFrame !== undefined;
  const at = `\`holds[${i}]\``;
  if (seconds && frames) throw invalid(`${at} mixes seconds (from, to) with frames (fromFrame, toFrame).`, "Give one pair.");
  if (frames) {
    if (h.fromFrame === undefined || h.toFrame === undefined) throw invalid(`${at} needs both fromFrame and toFrame.`);
    if (h.toFrame < h.fromFrame) throw invalid(`${at} runs backwards: fromFrame ${h.fromFrame} > toFrame ${h.toFrame}.`);
    return { from: h.fromFrame / fps, to: h.toFrame / fps };
  }
  if (h.from === undefined || h.to === undefined) throw invalid(`${at} needs from and to (seconds), or fromFrame and toFrame.`);
  if (h.to <= h.from) throw invalid(`\`holds[${i}].to\` must be after \`holds[${i}].from\`.`);
  return { from: h.from, to: h.to };
}

export const CHECK_MOTION_SHAPE = {
  nodeId: z.string().optional().describe("The animated top-level frame, or any layer in it (id or Figma link). Default: the selection's frame, else the page's only animated frame."),
  fps: z.number().int().min(1).max(60).optional().describe("Frame rate to judge at; match the planned export. Default 30."),
  from: z.number().min(0).optional().describe("Judge from this time, s. Default the start."),
  to: z.number().min(0).optional().describe("Judge up to this time, s. Default the end."),
  bpm: z.number().min(30).max(300).optional().describe("Tempo: turns on the beat check. Default the plan's."),
  beatTimes: z
    .array(z.number().min(0))
    .min(2)
    .max(4000)
    .optional()
    .describe("The music's own beats in seconds, increasing (figma_analyze_audio's beatTimes): the beat check uses them instead of the bpm grid."),
  beatOffset: z.number().min(0).optional().describe("Time of the first downbeat, s. Default the plan's, else 0."),
  beatsPerBar: z.number().int().min(1).max(12).optional().describe("Default 4."),
  rules: z.array(z.enum(RULE_IDS)).min(1).max(30).optional().describe("Only these rules. Default all."),
  minSeverity: z.enum(["error", "warning", "info"]).optional().describe('Hide findings below this level. Default "info".'),
  limit: z.number().int().min(1).max(500).optional().describe("Max findings returned. Default 100."),
  maxNodes: z.number().int().min(1).max(5000).optional().describe("Layers read. Default 2000."),
  thresholds: thresholds.optional().describe("Override a default threshold; each comes from a measured 2026-10-09 finding."),
  holds: z.array(span).max(20).optional().describe("Intended stillness, exempt from dead_span: seconds, e.g. [{ from: 10.4, to: 10.9 }], or frames at `fps`, e.g. [{ fromFrame: 312, toFrame: 327 }]. Default the plan's."),
  brandId: z.string().optional().describe("The brand layer: turns on brand_late. Default the plan's."),
  ctaId: z.string().optional().describe("The call-to-action layer: turns on cta_short. Default the plan's."),
  brandBy: z.number().min(0).optional().describe("Brand fully visible by this time, s. Default 3."),
  ctaMinS: z.number().min(0).optional().describe("Seconds the CTA must stay readable. Default 2.5."),
  includeActivity: z.boolean().optional().describe("Add `activity`: the fastest on-screen move per frame, px."),
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const DESCRIPTION =
  "A motion designer's frame-by-frame check of an animated top-level frame from its keyframes, no render: " +
  "figma_check_layout for motion. Each issue names layer, field, frame and numbers at `fps`, with a fix. It " +
  "finds pops and vanishes mid-move, one frame carrying most of a move, fast moves without blur, blur out of phase, " +
  "one-frame peaks, arrivals never held, dead stretches (outside `holds`), a cold open, template moves, missing " +
  "staggers, keys between frames, HOLD, beat offsets (`bpm` or `beatTimes`), text too brief, a late brand or short " +
  "CTA (`brandId`, `ctaId`). The frame's plan (figma_set_motion_plan) fills bpm, holds, brandId and ctaId when " +
  "left out; its `accept` lists intended findings apart. `ok: true` = no errors or warnings. A whole passing check " +
  "(no `rules`, `from`, `to`, nothing looser than the plan) at the delivery fps unlocks figma_export_video { final: " +
  "true } until the file changes. Then figma_review_video. UNSUPPORTED: no Figma Motion here. Skill: critique.";

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

/** The audit's options from the tool's arguments, refusing what the schema cannot say. */
export function auditOptions(args: Record<string, unknown>): AuditOptions {
  const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined);
  const from = num("from");
  const to = num("to");
  if (from !== undefined && to !== undefined && to <= from) throw invalid("`to` must be after `from`.");
  const holds = ((args.holds as Span[] | undefined) ?? []).map((h, i) => holdInSeconds(h, i, num("fps") ?? 30));
  const beatTimes = args.beatTimes as number[] | undefined;
  beatTimes?.forEach((t, i) => {
    if (i > 0 && !(t > beatTimes[i - 1]!)) throw invalid(`\`beatTimes\` must increase: beatTimes[${i}] = ${t} is not after ${beatTimes[i - 1]}.`, "Pass figma_analyze_audio's beatTimes as they are.");
  });
  const id = (k: "brandId" | "ctaId") => (typeof args[k] === "string" ? toNodeId(args[k] as string, k).id : undefined);
  const opts: AuditOptions = {
    ...(num("fps") !== undefined ? { fps: num("fps")! } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(num("bpm") !== undefined ? { bpm: num("bpm")! } : {}),
    ...(num("beatOffset") !== undefined ? { beatOffset: num("beatOffset")! } : {}),
    ...(num("beatsPerBar") !== undefined ? { beatsPerBar: num("beatsPerBar")! } : {}),
    ...(beatTimes ? { beatTimes } : {}),
    ...(Array.isArray(args.rules) ? { rules: args.rules as string[] } : {}),
    ...(typeof args.minSeverity === "string" ? { minSeverity: args.minSeverity as Severity } : {}),
    ...(num("limit") !== undefined ? { limit: num("limit")! } : {}),
    ...(args.thresholds ? { thresholds: args.thresholds as Partial<Thresholds> } : {}),
    ...(holds.length ? { holds } : {}),
    ...(num("brandBy") !== undefined ? { brandBy: num("brandBy")! } : {}),
    ...(num("ctaMinS") !== undefined ? { ctaMinS: num("ctaMinS")! } : {}),
    ...(args.includeActivity === true ? { includeActivity: true } : {}),
  };
  const brandId = id("brandId");
  const ctaId = id("ctaId");
  if (brandId) opts.brandId = brandId;
  if (ctaId) opts.ctaId = ctaId;
  return opts;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * The frame's plan applied to what the call asked: the call's own values win,
 * and the plan fills what it left out — its tempo, holds, brand and CTA — and
 * brings its `accept`, which only a plan carries. `gaps` lists where the call
 * was looser than the plan or than the measured defaults: another tempo,
 * brand or CTA, a hold outside the plan's, a threshold off its default, a
 * later `brandBy` or a shorter `ctaMinS`. Stricter is never a gap.
 */
export function withPlan(asked: AuditOptions, plan: MotionPlanRecord | null): { opts: AuditOptions; fromPlan: string[]; gaps: string[] } {
  const opts: AuditOptions = { ...asked };
  const fromPlan: string[] = [];
  const gaps: string[] = [];
  const b = plan?.brief;
  if (b?.bpm !== undefined) {
    const offset = b.beatOffset ?? 0;
    if (asked.bpm === undefined) {
      opts.bpm = b.bpm;
      fromPlan.push("bpm");
    } else if (asked.bpm !== b.bpm) gaps.push(`bpm ${asked.bpm}, not the plan's ${b.bpm}`);
    if (asked.beatOffset === undefined) {
      opts.beatOffset = offset;
      if (b.beatOffset !== undefined) fromPlan.push("beatOffset");
    } else if (Math.abs(asked.beatOffset - offset) > 1e-6) gaps.push(`beatOffset ${asked.beatOffset} s, not the plan's ${offset} s`);
  }
  const planned = plan?.holds ?? [];
  if (!asked.holds?.length) {
    if (planned.length) {
      opts.holds = planned;
      fromPlan.push("holds");
    }
  } else {
    // Within half a frame: a hold given in frames converts to seconds that need not match the plan's to the digit.
    const half = 0.5 / (asked.fps ?? 30);
    asked.holds.forEach((h, i) => {
      if (!planned.some((p) => h.from >= p.from - half && h.to <= p.to + half)) gaps.push(`holds[${i}] ${r4(h.from)}–${r4(h.to)} s is not inside a hold of the plan`);
    });
  }
  for (const k of ["brandId", "ctaId"] as const) {
    const p = plan?.[k];
    if (p === undefined) continue;
    if (asked[k] === undefined) {
      opts[k] = p;
      fromPlan.push(k);
    } else if (asked[k] !== p) gaps.push(`${k} ${asked[k]}, not the plan's ${p}`);
  }
  if (plan?.accept?.length) {
    opts.accept = plan.accept;
    fromPlan.push("accept");
  }
  for (const [k, v] of Object.entries(asked.thresholds ?? {})) {
    const d = DEFAULT_THRESHOLDS[k as keyof Thresholds];
    if (typeof v === "number" && v !== d) gaps.push(`thresholds.${k} ${v}, not the default ${d}`);
  }
  if (asked.brandBy !== undefined && asked.brandBy > DEFAULT_BRAND_BY_S) gaps.push(`brandBy ${asked.brandBy} s, later than ${DEFAULT_BRAND_BY_S} s`);
  if (asked.ctaMinS !== undefined && asked.ctaMinS < DEFAULT_CTA_MIN_S) gaps.push(`ctaMinS ${asked.ctaMinS} s, shorter than ${DEFAULT_CTA_MIN_S} s`);
  return { opts, fromPlan, gaps };
}

function asSnapshot(data: unknown): MotionSnapshot {
  const d = data as Partial<MotionSnapshot> | null;
  if (!d || typeof d !== "object" || !d.root || !Array.isArray(d.nodes)) {
    throw new BridgeError(ErrorCode.INTERNAL, "The plugin's check_motion answered without a snapshot.", {
      hint: "The plugin build may predate figma_check_motion: figma_status shows whether it must be re-run.",
    });
  }
  return d as MotionSnapshot;
}

/** When a check began: a change from then on is one its snapshot may not show. */
interface Began {
  at: number;
  epoch: number;
}

/**
 * The audit, judged against the frame's plan and recorded for the motion
 * process: a final render of the frame waits for a passing whole check —
 * every rule, the whole timeline, every layer read, nothing looser than the
 * plan — at its fps, with the file unchanged since it began (motion-process.ts).
 */
function judged(snapshot: MotionSnapshot, asked: AuditOptions, proc: MotionProcess | undefined, session: string, began: Began) {
  const plan = snapshot.plan ?? null;
  const { opts, fromPlan, gaps } = withPlan(asked, plan);
  for (const k of ["brandId", "ctaId"] as const) {
    const id = opts[k];
    if (fromPlan.includes(k) && !snapshot.nodes.some((n) => n.id === id)) {
      throw invalid(
        `The frame's motion plan names \`${k}\` ${id}, which is not among the layers read in "${snapshot.root.name}".`,
        snapshot.truncated
          ? "Raise `maxNodes` so the check reads it, or store the plan again (figma_set_motion_plan) with the layer's current id."
          : "Store the plan again (figma_set_motion_plan) with the layer's current id.",
      );
    }
  }
  const result = auditMotion(snapshot, opts);
  const out = { ...result, ...(fromPlan.length ? { fromPlan } : {}), ...(snapshot.planInvalid ? { planInvalid: snapshot.planInvalid } : {}) };
  if (!proc?.active) return okResult(out);
  const whole = asked.rules === undefined && asked.from === undefined && asked.to === undefined && !result.truncated;
  const accepted = (result.accepted ?? []).map((i) => ({ rule: i.rule, name: i.name, frame: i.frame, ...(i.frames ? { frames: i.frames } : {}), reason: i.reason }));
  proc.noteCheck(result.root.id, { ok: result.ok, fps: result.fps, full: whole, gaps, plan: planKey(plan), epoch: began.epoch, at: began.at, accepted }, session);
  if (!result.ok || !whole) return okResult(out);
  if (gaps.length) {
    return okResult({
      ...out,
      processNote: `Passing, but looser than the frame's plan, so it does not clear the delivery: ${gaps.join("; ")}. Leave those out and the check applies the plan's own; a finding the brief intends goes in the plan's \`accept\`.`,
    });
  }
  return okResult({
    ...out,
    processNote: `Passing at ${result.fps} fps${plan ? " against the frame's plan" : ""}: until the file changes, the delivery may render: ${finalCall(result.root.id, result.fps)}.`,
  });
}

/**
 * Register figma_check_motion. Wired by the integrator in tools/index.ts
 * before registerBatch: registerCheckMotion(server, bridge, wanted, process).
 */
export function registerCheckMotion(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, proc?: MotionProcess): void {
  if (!wanted("check_motion")) return;
  server.registerTool(
    "figma_check_motion",
    {
      title: "Check motion frame by frame",
      description: fitDescription(DESCRIPTION),
      inputSchema: CHECK_MOTION_SHAPE,
      annotations: readAnnotations("check_motion"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      let opts: AuditOptions;
      try {
        opts = auditOptions(args);
      } catch (err) {
        return errorResult(err, { readOnly: true });
      }
      const params: Record<string, unknown> = {};
      if (typeof args.nodeId === "string") params.nodeId = args.nodeId;
      if (typeof args.maxNodes === "number") params.maxNodes = args.maxNodes;
      // The session the frame lives in, for the process: a link in nodeId may name it. A refused
      // address is forwardTool's to report, in its own words.
      let session = "";
      if (proc?.active) {
        try {
          session = await sessionIdOf(bridge, (await addressCall(bridge, "check_motion", params, args.session as string | undefined)).session);
        } catch {
          session = "";
        }
      }
      // Taken before the snapshot is asked for, so a change while it is read counts against it.
      const began: Began = { at: Date.now(), epoch: writeEpoch() };
      return forwardTool(bridge, "check_motion", params, extra, {
        session: args.session as string | undefined,
        shape: (data) => judged(asSnapshot(data), opts, proc, session, began),
      });
    },
  );
}
