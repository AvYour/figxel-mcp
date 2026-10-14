// A motion plan: the brief and the beat sheet of one animated top-level frame,
// recorded before the first keyframe (figma_set_motion_plan). The server checks
// a plan (src/server/motion-plan.ts) and the plugin stores it on the frame in
// shared plugin data, beside the storyboard record's namespace [C-188], so
// every session and every later server reads the same plan; the keyframe tools
// refuse a frame without one under BRIDGE_PROCESS=strict
// (src/server/motion-process.ts).
//
// No runtime dependencies: the plugin bundles this (ES2017).

import { STORYBOARD_NAMESPACE } from "./storyboard.js";

/** Shared plugin data, readable by any plugin: the namespace the storyboard record uses. */
export const MOTION_PLAN_NAMESPACE = STORYBOARD_NAMESPACE;
export const MOTION_PLAN_KEY = "motionPlan";

export const MOTION_PLAN_LIMITS = {
  beats: 48,
  /** Seconds, as a storyboard plans at most. */
  totalS: 600,
  name: 80,
  text: 400,
  format: 120,
  holds: 20,
  cuts: 64,
  accept: 20,
  bpm: [30, 300],
  /** setSharedPluginData caps one entry at 100 kB [C-188]; the server keeps a margin under it. */
  bytes: 90_000,
} as const;

/** The rates figma_export_video renders: a plan's fps must be deliverable (shared/video.ts VIDEO_FPS) [C-116]. */
export const PLAN_FPS: readonly number[] = [8, 12, 15, 24, 30, 60];

export interface MotionPlanBrief {
  audience: string;
  message: string;
  /** Size and placement, e.g. "1080x1920 IG Reels". */
  format: string;
  durationS: number;
  fps: number;
  bpm?: number;
  beatOffset?: number;
}

export interface MotionPlanBeat {
  name: string;
  /** Seconds; beats run back to back from 0 to the brief's durationS. */
  from: number;
  to: number;
  /** Copy on screen, timed for reading; a picture is described in [brackets], which are not timed. */
  onScreen: string;
  action: string;
  /** Into the next beat; for the last beat, how the piece ends. */
  transition: string;
  /** A hit inside the beat, in seconds: on the beat grid when the brief has a tempo. */
  accent?: number;
}

/**
 * A figma_check_motion finding the brief intends (a still open, a hard-cut
 * grammar, a loop), declared with its reason: the check lists it as accepted,
 * not against ok. `from` and `to` (seconds) bound where it may sit.
 */
export interface MotionPlanAccept {
  rule: string;
  reason: string;
  from?: number;
  to?: number;
}

export interface MotionPlanRecord {
  v: 1;
  brief: MotionPlanBrief;
  beats: MotionPlanBeat[];
  holds?: Array<{ from: number; to: number }>;
  cuts?: number[];
  brandId?: string;
  ctaId?: string;
  accept?: MotionPlanAccept[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A stored plan, or why it is not one. Only the shape is read here: what makes
 * a plan sound is checked before it is stored, by the server.
 */
export function parseMotionPlan(raw: string): { plan: MotionPlanRecord } | { invalid: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { invalid: "the stored plan is not JSON" };
  }
  if (!isObject(data) || data.v !== 1) return { invalid: `the stored plan has version ${isObject(data) ? JSON.stringify(data.v) : "none"}, not 1` };
  if (!isObject(data.brief) || !Array.isArray(data.beats) || data.beats.length === 0) return { invalid: "the stored plan has no brief or no beats" };
  return { plan: data as unknown as MotionPlanRecord };
}
