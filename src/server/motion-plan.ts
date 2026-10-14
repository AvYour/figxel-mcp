// figma_set_motion_plan's checker: a brief and a beat sheet for one animated
// top-level frame, judged before anything is stored. Pure, so a test pins every
// rule without a canvas; the plugin only stores what passed (src/plugin/ops/
// motion-plan.ts).
//
// The rules are the ones the tools already judge motion by, applied to the
// plan instead of the keys: every time on the frame grid (frame k is k / fps
// [C-193]), every beat long enough to read its copy (motion-audit's readNeedS,
// max(5/6 s, 0.3 s a word) [C-241]), every accent on the beat grid within
// beat_offset's tolerance when there is a tempo (nearestGridFrame) [C-244],
// beats back to back from 0 to the brief's length, and every transition named.
// An `accept` entry names a real rule and says why. All problems are listed
// at once, so one corrected call is enough.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { gridOffset } from "../shared/motion-curves.js";
import {
  MOTION_PLAN_LIMITS as L,
  PLAN_FPS,
  type MotionPlanAccept,
  type MotionPlanBeat,
  type MotionPlanBrief,
  type MotionPlanRecord,
} from "../shared/motion-plan.js";
import { toNodeId } from "./figma-url.js";
import { DEFAULT_THRESHOLDS, ISSUE_RULES, nearestGridFrame, readNeedS, words } from "./motion-audit.js";

/** A key or a boundary within this many frames of a frame is on it (motion-curves.ts ON_FRAME). */
const ON_FRAME = 0.02;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** A beat as planned, with its frames and its read time. */
export interface PlannedBeat {
  index: number;
  name: string;
  from: number;
  to: number;
  startFrame: number;
  /** The first frame of the next beat: the beat shows on [startFrame, endFrame). */
  endFrame: number;
  /** Words of the copy, [bracketed] picture notes left out. */
  words: number;
  needS: number;
  accentFrame?: number;
}

export interface MotionPlanCheck {
  record: MotionPlanRecord;
  beats: PlannedBeat[];
  durationFrames: number;
}

/** The copy a beat puts on screen: its onScreen text without the [picture notes]. */
export function copyOf(onScreen: string): string {
  return onScreen.replace(/\[[^\]]*\]/g, " ").trim();
}

/**
 * Check a plan from the tool's arguments and return the record to store.
 * Throws INVALID_PARAM listing every problem; nothing here touches Figma, so a
 * refusal changed nothing. The schema has already checked the types.
 */
export function planMotion(args: Record<string, unknown>): MotionPlanCheck {
  const problems: string[] = [];
  const text = (v: unknown, at: string, max: number): string => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) problems.push(`\`${at}\` is empty: say it in words.`);
    else if (s.length > max) problems.push(`\`${at}\` is ${s.length} characters; the limit is ${max}.`);
    return s;
  };
  const b = isObject(args.brief) ? args.brief : {};
  const fps = typeof b.fps === "number" ? b.fps : Number.NaN;
  if (!PLAN_FPS.includes(fps)) problems.push(`\`brief.fps\` ${JSON.stringify(b.fps)} is not a rate figma_export_video renders: ${PLAN_FPS.join(", ")}.`);
  const fpsOk = PLAN_FPS.includes(fps);
  const frame = (t: number) => Math.round(t * fps);
  /** Off the frame grid: the two times on it either side, for the fix. */
  const onGrid = (t: number, at: string) => {
    if (!fpsOk || gridOffset(t, fps) <= ON_FRAME) return;
    const lo = Math.floor(t * fps);
    problems.push(`\`${at}\` ${t} s falls between frames at ${fps} fps; use ${r4(lo / fps)} (frame ${lo}) or ${r4((lo + 1) / fps)} (frame ${lo + 1}).`);
  };

  const durationS = typeof b.durationS === "number" ? b.durationS : Number.NaN;
  if (!(durationS > 0) || durationS > L.totalS) problems.push(`\`brief.durationS\` must be above 0 and at most ${L.totalS} s.`);
  else onGrid(durationS, "brief.durationS");
  const bpm = typeof b.bpm === "number" ? b.bpm : undefined;
  if (bpm !== undefined && (bpm < L.bpm[0] || bpm > L.bpm[1])) problems.push(`\`brief.bpm\` must be from ${L.bpm[0]} to ${L.bpm[1]}.`);
  const beatOffset = typeof b.beatOffset === "number" ? b.beatOffset : undefined;
  if (beatOffset !== undefined && bpm === undefined) problems.push("`brief.beatOffset` needs `brief.bpm`: without a tempo there is no beat to offset.");
  if (beatOffset !== undefined && !(beatOffset >= 0 && beatOffset < durationS)) problems.push("`brief.beatOffset` must be 0 or more and before the end.");
  const brief: MotionPlanBrief = {
    audience: text(b.audience, "brief.audience", L.text),
    message: text(b.message, "brief.message", L.text),
    format: text(b.format, "brief.format", L.format),
    durationS,
    fps,
    ...(bpm !== undefined ? { bpm } : {}),
    ...(beatOffset !== undefined ? { beatOffset } : {}),
  };

  const rawBeats = Array.isArray(args.beats) ? args.beats : [];
  if (rawBeats.length === 0) problems.push("`beats` is empty: a plan needs at least one beat.");
  if (rawBeats.length > L.beats) problems.push(`\`beats\` has ${rawBeats.length} beats; a plan holds at most ${L.beats}.`);
  const beats: MotionPlanBeat[] = [];
  const planned: PlannedBeat[] = [];
  rawBeats.forEach((raw, i) => {
    const at = `beats[${i}]`;
    const x = isObject(raw) ? raw : {};
    const name = text(x.name, `${at}.name`, L.name);
    const from = typeof x.from === "number" ? x.from : Number.NaN;
    const to = typeof x.to === "number" ? x.to : Number.NaN;
    const onScreen = typeof x.onScreen === "string" ? x.onScreen.trim() : "";
    if (onScreen.length > L.text) problems.push(`\`${at}.onScreen\` is ${onScreen.length} characters; the limit is ${L.text}.`);
    const action = text(x.action, `${at}.action`, L.text);
    const transition = text(x.transition, `${at}.transition`, L.text);
    const accent = typeof x.accent === "number" ? x.accent : undefined;
    const label = `${at}${name ? ` "${name}"` : ""}`;
    if (!(to > from)) problems.push(`\`${at}.to\` (${to}) must be after \`${at}.from\` (${from}).`);
    onGrid(from, `${at}.from`);
    onGrid(to, `${at}.to`);
    // Back to back from 0: compared as frames, so 1.2667 and 1.26667 are one boundary.
    if (fpsOk) {
      const prev = beats[i - 1];
      if (i === 0 && frame(from) !== 0) problems.push(`\`${at}.from\` is ${from} s; the first beat starts at 0.`);
      if (prev && frame(from) !== frame(prev.to)) {
        problems.push(`\`${at}.from\` ${from} s does not start where \`beats[${i - 1}]\` ends (${prev.to} s): beats run back to back, with no gap or overlap.`);
      }
      if (i === rawBeats.length - 1 && Number.isFinite(durationS) && frame(to) !== frame(durationS)) {
        problems.push(`The last beat ends at ${to} s, but \`brief.durationS\` is ${durationS} s: the beats cover the whole piece.`);
      }
    }
    const copy = copyOf(onScreen);
    const n = copy ? words(copy) : 0;
    const needS = n > 0 ? readNeedS(copy) : 0;
    if (n > 0 && to - from + 1e-9 < needS) {
      const quote = copy.length > 40 ? `${copy.slice(0, 40)}…` : copy;
      problems.push(
        `${label} is ${r4(to - from)} s, but its copy "${quote}" (${n} word${n === 1 ? "" : "s"}) needs ${r2(needS)} s to read: ` +
          "lengthen the beat, cut the copy, or put a picture note in [brackets], which is not timed.",
      );
    }
    let accentFrame: number | undefined;
    if (accent !== undefined) {
      if (!(accent >= from && accent < to)) problems.push(`\`${at}.accent\` ${accent} s is outside its beat (${from}–${to} s).`);
      onGrid(accent, `${at}.accent`);
      if (fpsOk) {
        accentFrame = frame(accent);
        if (bpm !== undefined) {
          const near = nearestGridFrame(accentFrame, fps, bpm, beatOffset ?? 0);
          const off = accentFrame - near;
          if (Math.abs(off) > DEFAULT_THRESHOLDS.beatToleranceFrames) {
            problems.push(
              `\`${at}.accent\` lands on frame ${accentFrame}, ${Math.abs(off)} frames ${off > 0 ? "after" : "before"} the nearest beat or eighth ` +
                `(frame ${near}, ${r4(near / fps)} s at ${bpm} BPM): move it there.`,
            );
          }
        }
      }
    }
    beats.push({ name, from, to, onScreen, action, transition, ...(accent !== undefined ? { accent } : {}) });
    planned.push({
      index: i + 1,
      name,
      from,
      to,
      startFrame: fpsOk ? frame(from) : 0,
      endFrame: fpsOk ? frame(to) : 0,
      words: n,
      needS: r2(needS),
      ...(accentFrame !== undefined ? { accentFrame } : {}),
    });
  });

  const holds: Array<{ from: number; to: number }> = [];
  (Array.isArray(args.holds) ? args.holds : []).forEach((h, i) => {
    const x = isObject(h) ? h : {};
    const from = typeof x.from === "number" ? x.from : Number.NaN;
    const to = typeof x.to === "number" ? x.to : Number.NaN;
    if (!(from >= 0 && to > from && to <= durationS + 1e-9)) problems.push(`\`holds[${i}]\` must run forwards inside the piece (0–${durationS} s).`);
    onGrid(from, `holds[${i}].from`);
    onGrid(to, `holds[${i}].to`);
    holds.push({ from, to });
  });
  const cuts: number[] = [];
  (Array.isArray(args.cuts) ? args.cuts : []).forEach((c, i) => {
    const t = typeof c === "number" ? c : Number.NaN;
    if (!(t > 0 && t <= durationS + 1e-9)) problems.push(`\`cuts[${i}]\` ${c} s must be after 0 and inside the piece.`);
    onGrid(t, `cuts[${i}]`);
    cuts.push(t);
  });
  const id = (k: "brandId" | "ctaId"): string | undefined => {
    if (typeof args[k] !== "string") return undefined;
    try {
      return toNodeId(args[k] as string, k).id;
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  };
  const brandId = id("brandId");
  const ctaId = id("ctaId");
  // A finding the brief intends, declared with its reason: figma_check_motion lists it apart.
  const accept: MotionPlanAccept[] = [];
  (Array.isArray(args.accept) ? args.accept : []).forEach((raw, i) => {
    const at = `accept[${i}]`;
    const x = isObject(raw) ? raw : {};
    const rule = typeof x.rule === "string" ? x.rule : "";
    if (!ISSUE_RULES.includes(rule)) problems.push(`\`${at}.rule\` ${JSON.stringify(x.rule ?? null)} is not a figma_check_motion rule.`);
    const reason = text(x.reason, `${at}.reason`, L.text);
    const from = typeof x.from === "number" ? x.from : undefined;
    const to = typeof x.to === "number" ? x.to : undefined;
    // A window, when given, is where the finding may sit: from and to default to the piece's ends.
    const lo = from ?? 0;
    const hi = to ?? durationS;
    if ((from !== undefined || to !== undefined) && !(lo >= 0 && hi >= lo && hi <= durationS + 1e-9)) {
      problems.push(`\`${at}\` must run forwards inside the piece (0–${durationS} s).`);
    }
    if (from !== undefined) onGrid(from, `${at}.from`);
    if (to !== undefined) onGrid(to, `${at}.to`);
    accept.push({ rule, reason, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
  });

  const record: MotionPlanRecord = {
    v: 1,
    brief,
    beats,
    ...(holds.length ? { holds } : {}),
    ...(cuts.length ? { cuts } : {}),
    ...(brandId ? { brandId } : {}),
    ...(ctaId ? { ctaId } : {}),
    ...(accept.length ? { accept } : {}),
  };
  if (problems.length === 0 && Buffer.byteLength(JSON.stringify(record), "utf8") > L.bytes) {
    problems.push(`The plan is over ${L.bytes / 1000} kB as stored; shorten the copy and the notes.`);
  }
  if (problems.length) {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `The motion plan is not ready; nothing was stored. ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n- ${problems.join("\n- ")}`,
      { hint: "Fix every problem and send the whole plan again.", partial: { created: [], problems } },
    );
  }
  return { record, beats: planned, durationFrames: frame(durationS) };
}
