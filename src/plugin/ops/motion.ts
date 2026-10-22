// Motion and prototype behaviour (tools.md § read, style, export): keyframe
// tracks and the timeline, video export of an animated frame, scroll and fixed
// layers, and the page's prototype flows.
//
// Motion is a Beta Plugin API that Figma turns on per user [C-115]. Without
// it, reading a motion member throws `"<name>" is not a supported API`, so
// every motion op probes once and answers UNSUPPORTED with a hint that says
// not to retry — the agent should tell the user, not loop. A build that
// predates the API has no members at all; that is the same answer.
//
// Values travel as strings (motion-fields.ts), so what figma_get_motion_context
// reads is exactly what figma_set_keyframes takes back.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import {
  DEFAULT_VIDEO_FPS,
  isRenderTimeout,
  isSmallRender,
  RENDER_FAILED_HINT,
  renderSize,
  renderTimeoutHint,
  VIDEO_MIME,
  videoSettings,
} from "../../shared/video.js";
import type { OpContext, PluginOp } from "./index.js";
import { beforeMutating, unchanged } from "../guard.js";
import { ensureLoaded } from "../pages.js";
import {
  bool,
  byId,
  decodeCursor,
  encodeCursor,
  int,
  reqStr,
  selectionOf,
  str,
  TEMPORARY_ID_HINT,
  topLevelFrameOf,
  walk,
  type FigmaLike,
  type NodeLike,
} from "../read.js";
import { parseColor } from "../write.js";
import { encodeBase64 } from "./export.js";
import { readMotionPlan } from "./motion-plan.js";
import {
  bindingAt,
  easingToString,
  fieldFromString,
  fieldToString,
  fieldValueType,
  keyframesToText,
  manualTracksToText,
  parseEasing,
  parseField,
  parseValue,
  styleTracksToText,
  tracksToFieldNames,
  type KeyframeFieldLike,
  type KeyframeText,
  type KeyframeValueLike,
  type MotionEasingLike,
} from "../motion-fields.js";

const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;

type Timeline = { id: string; duration: number };
type Motion = NodeLike & {
  [key: string]: unknown;
  applyManualKeyframeTrack?(field: KeyframeFieldLike, track: { keyframes: unknown[] }): void;
  removeManualKeyframeTrack?(field: KeyframeFieldLike): void;
  setTimelineDuration?(id: string, duration: number): void;
  getTopLevelFrame?(): NodeLike | undefined;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const invalid = (msg: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, msg, hint ? { hint } : {});

// ── availability ─────────────────────────────────────────────────────────────

/** Figma's words when the per-user Motion flag is off (official figma-use-motion skill) [C-115]. */
export const GATED = /not a supported API/i;
const NO_MOTION_HINT =
  "Motion (keyframes, timelines) is a Beta Plugin API that Figma enables per user, and this Figma build or account " +
  "does not have it. Do not retry: tell the user, and deliver the static design.";

/** Shared with motion-snapshot.ts, so every motion op answers a gated account in the same words. */
export function noMotion(detail: string): BridgeError {
  return new BridgeError(ErrorCode.UNSUPPORTED, `Motion is not available here: ${detail}`, { hint: NO_MOTION_HINT });
}

/** Pages and the document are not scene nodes: they never carry motion. */
const NOT_SCENE = new Set(["DOCUMENT", "PAGE"]);

type MotionKey = "timelines" | "manualKeyframeTracks" | "animations" | "animationStyles";

/** Read one motion member. A missing or gated Motion API is UNSUPPORTED; any other failure is Figma's own. */
function read(node: Motion, key: MotionKey): unknown {
  if (!(key in node)) throw noMotion(`a ${node.type} has no \`${key}\` — this Figma build has no Motion API.`);
  try {
    return node[key];
  } catch (err) {
    if (GATED.test(message(err))) throw noMotion(message(err));
    throw err;
  }
}

/** Probe before any write: every member a write needs exists, and reading one does not throw. */
function requireMotion(node: Motion): void {
  if (NOT_SCENE.has(node.type)) throw invalid(`A ${node.type} cannot be animated; pick a layer inside a frame.`);
  for (const fn of ["applyManualKeyframeTrack", "removeManualKeyframeTrack", "setTimelineDuration"] as const) {
    if (typeof node[fn] !== "function") throw noMotion(`a ${node.type} has no \`${fn}\` — this Figma build has no Motion API.`);
  }
  read(node, "timelines");
}

function firstTimeline(node: Motion): Timeline | undefined {
  const t = read(node, "timelines");
  const first = Array.isArray(t) ? (t[0] as unknown) : undefined;
  return isObject(first) && typeof first.id === "string" && typeof first.duration === "number" ? { id: first.id, duration: first.duration } : undefined;
}

// ── figma_set_keyframes ──────────────────────────────────────────────────────

export interface TrackPlan {
  text: string;
  field: KeyframeFieldLike;
  keyframes: Array<{ timelinePosition: number; value: KeyframeValueLike; easing?: MotionEasingLike }>;
}

/** Turn `tracks` into Figma's KeyframeField + ManualKeyframeTrackInput, refusing anything malformed — no node needed. */
export function planTracks(raw: unknown): TrackPlan[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid("`tracks` must be an array of { field, keyframes }.");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const at = `tracks[${i}]`;
    if (!isObject(entry)) throw invalid(`\`${at}\` must be an object { field, keyframes }.`);
    if (typeof entry.field !== "string") throw invalid(`\`${at}.field\` is required, e.g. "OPACITY" or "fill:0".`);
    const field = parseField(entry.field, `${at}.field`);
    const text = fieldToString(field);
    // applyManualKeyframeTrack replaces a track, so the second would silently win.
    if (seen.has(text)) throw invalid(`\`${at}.field\` "${text}" appears twice; give one track per field.`);
    seen.add(text);
    const type = fieldValueType(field);
    if (!type) throw invalid(`\`${at}.field\` "${text}" animates a component property, whose value type is not known; it can be read and removed, not written here.`);
    if (!Array.isArray(entry.keyframes) || entry.keyframes.length === 0) throw invalid(`\`${at}.keyframes\` needs at least one keyframe.`);
    const times = new Set<number>();
    const keyframes = entry.keyframes.map((k, j) => {
      const kat = `${at}.keyframes[${j}]`;
      if (!isObject(k)) throw invalid(`\`${kat}\` must be an object { t, value, easing? }.`);
      const t = k.t;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw invalid(`\`${kat}.t\` must be a time in seconds, 0 or more.`);
      if (times.has(t)) throw invalid(`\`${kat}.t\` ${t} repeats an earlier keyframe of this track.`, 'For a jump, use easing "HOLD" on the keyframe before it.');
      times.add(t);
      const v = typeof k.value === "number" ? String(k.value) : k.value;
      if (typeof v !== "string") throw invalid(`\`${kat}.value\` is required: "120", "#ff0000" or "10,20" by the field's type.`);
      const value = parseValue(v, type, `${kat}.value`);
      if (k.easing !== undefined && typeof k.easing !== "string") throw invalid(`\`${kat}.easing\` must be a string, e.g. "EASE_OUT".`);
      const easing = typeof k.easing === "string" ? parseEasing(k.easing, `${kat}.easing`) : undefined;
      return { timelinePosition: t, value, ...(easing ? { easing } : {}) };
    });
    keyframes.sort((a, b) => a.timelinePosition - b.timelinePosition);
    return { text, field, keyframes };
  });
}

/** Group and vector containers have no size of their own to animate (official figma-use-motion skill) [C-115]. */
const NO_SIZE_TRACKS = new Set(["GROUP", "TRANSFORM_GROUP", "VECTOR", "BOOLEAN_OPERATION"]);

/** Every check that needs the node: the target layer, then each track's paint or effect. */
function checkTargets(node: Motion, plans: TrackPlan[]): void {
  if (plans.length === 0) return;
  if (node.parent?.type === "PAGE") {
    throw invalid(`"${node.name}" is a top-level frame; Figma animates the layers inside a top-level frame, not the frame itself.`, "Animate a child layer instead — the frame's timeline plays every child's tracks.");
  }
  plans.forEach((p, i) => {
    const at = `tracks[${i}].field`;
    const f = p.field;
    if (f.type === "PROPERTY") {
      if ((f.name === "WIDTH" || f.name === "HEIGHT") && NO_SIZE_TRACKS.has(node.type)) {
        throw invalid(`\`${at}\`: ${f.name} cannot be animated on a ${node.type}.`, "Animate SCALE_X / SCALE_Y, or the size of a frame.");
      }
      return;
    }
    const list = node[f.collection];
    if (!Array.isArray(list)) throw invalid(`\`${at}\`: the ${f.collection} of "${node.name}" are mixed or absent, so "${p.text}" names nothing.`);
    if (f.index >= list.length) throw invalid(`\`${at}\`: "${node.name}" has ${list.length} ${f.collection}; there is no index ${f.index}.`);
    const item = list[f.index] as unknown;
    if (f.collection !== "effects" && (!isObject(item) || item.type !== "SOLID")) {
      throw invalid(`\`${at}\`: only a SOLID paint can be animated; ${f.collection}[${f.index}] is ${isObject(item) ? String(item.type) : "not a paint"}.`);
    }
  });
}

// ── verified track writes ────────────────────────────────────────────────────
//
// On 2026-10-09, calls that replaced several tracks of one layer kept only the
// last; the others still held their old keys in a read 6 s later, and every
// one-track call landed [C-201]. Why is open — a synchronous run that
// coalesces, a stale handle, or a forked timeline [C-202] — so the defence holds
// under each: give Figma one host turn after the writes (a microtask is not
// one [C-013]), read every track back through a NEW handle, and write again
// only what is missing, one track per host turn, each through a new handle
// [C-250]. The happy path costs that one turn: ~20 ms with Figma in front
// [C-050], ~1 s behind other windows [C-124].

/** Rounds after the first write; each re-writes only what is still missing. Three writes per track at most. */
const REPAIR_ROUNDS = 2;

/** Two values in the string forms, equal or within float32 noise of each other ("0.4" against "0.4000001"). */
function sameValue(a: string, b: string): boolean {
  if (a === b) return true;
  const xs = a.split(",");
  const ys = b.split(",");
  return xs.length === ys.length && xs.every((x, i) => {
    const p = Number(x);
    const q = Number(ys[i]);
    return x.trim() !== "" && Number.isFinite(p) && Number.isFinite(q) && Math.abs(p - q) <= 1e-3 * Math.max(1, Math.abs(p));
  });
}

const sameTimes = (want: KeyframeText[], got: KeyframeText[]) => want.length === got.length && want.every((k, i) => Math.abs(k.t - got[i]!.t) <= 1e-4);

/** `got` holds every key of `want`: its time, its value, and its easing where `want` names one (Figma fills in the rest). */
function sameKeys(want: KeyframeText[], got: KeyframeText[]): boolean {
  return sameTimes(want, got) && want.every((k, i) => sameValue(k.value, got[i]!.value) && (!k.easing || k.easing === got[i]!.easing));
}

/**
 * Whether Figma kept `p`. A track that reads back as asked did. So did one with
 * the asked key times whose values Figma stored differently, unless it is
 * exactly what the field held before the call — a dropped track was left that
 * way [C-201]. Without that second rule a value Figma normalises would be
 * written three times and reported as lost.
 */
function landed(tracks: unknown, p: TrackPlan, before: KeyframeText[] | undefined): boolean {
  const got = keyframesToText(bindingAt(tracks, p.field)?.keyframes);
  const want = keyframesToText(p.keyframes);
  return sameKeys(want, got) || (sameTimes(want, got) && !sameKeys(before ?? [], got));
}

export interface Settled<T> {
  /** The newest handle on the node, taken after the last host turn. */
  live: Motion;
  /** `live`'s manualKeyframeTracks, as the last check read them. */
  tracks: unknown;
  /** Writes per item, by text: 1 means Figma kept the first one. */
  attempts: Map<string, number>;
  /** What Figma still had not kept after every round. */
  missing: T[];
  /** Figma's words when a repeated write was itself refused. */
  refusals: Map<string, string>;
}

/**
 * After the first writes of `items`: one host turn, a check through a new
 * handle, and up to REPAIR_ROUNDS rounds that write each item still pending
 * again, one per host turn, each through a new handle. `pending` says whether
 * Figma has not kept an item yet; `rewrite` writes it once more. `partial`
 * travels with the error when the node no longer resolves, because by then
 * the first writes happened.
 */
async function settle<T extends { text: string }>(
  ctx: Pick<OpContext, "yieldToHost"> & Partial<Pick<OpContext, "progress">>,
  nodeId: string,
  items: T[],
  pending: (tracks: unknown, item: T) => boolean,
  rewrite: (handle: Motion, item: T) => void,
  partial: Record<string, unknown>,
): Promise<Settled<T>> {
  const fresh = async (): Promise<Motion> => {
    const n = (await api().getNodeByIdAsync(nodeId)) as Motion | null;
    if (n) return n;
    throw new BridgeError(ErrorCode.INTERNAL, `\`${nodeId}\` stopped resolving right after the write, so what Figma kept could not be read back.`, {
      hint: `${TEMPORARY_ID_HINT} figma_get_motion_context on the frame shows what it holds now.`,
      partial,
    });
  };
  const attempts = new Map(items.map((i) => [i.text, 1]));
  const refusals = new Map<string, string>();
  await ctx.yieldToHost();
  let live = await fresh();
  let tracks = read(live, "manualKeyframeTracks");
  let missing = items.filter((i) => pending(tracks, i));
  for (let round = 0; round < REPAIR_ROUNDS && missing.length > 0; round++) {
    ctx.progress?.(round + 1, REPAIR_ROUNDS, "repairing keyframes Figma did not keep");
    for (const item of missing) {
      try {
        rewrite(await fresh(), item);
      } catch (err) {
        if (err instanceof BridgeError) throw err;
        refusals.set(item.text, message(err)); // still pending; the next check says so
      }
      attempts.set(item.text, attempts.get(item.text)! + 1);
      await ctx.yieldToHost();
    }
    live = await fresh();
    tracks = read(live, "manualKeyframeTracks");
    // Every item again, not only the repaired ones: a repair must not have undone one that had landed.
    missing = items.filter((i) => pending(tracks, i));
  }
  return { live, tracks, attempts, missing, refusals };
}

/**
 * Check every track of `plans` after its first write and write again what
 * Figma dropped (see above). `before` is each field's keys as they read before
 * the call. Exported for figma_create_animatic, which writes its plates' keys
 * through the same check.
 */
export function verifyTracks(
  ctx: Pick<OpContext, "yieldToHost"> & Partial<Pick<OpContext, "progress">>,
  nodeId: string,
  plans: TrackPlan[],
  before: ReadonlyMap<string, KeyframeText[]>,
): Promise<Settled<TrackPlan>> {
  return settle(
    ctx,
    nodeId,
    plans,
    (tracks, p) => !landed(tracks, p, before.get(p.text)),
    (handle, p) => handle.applyManualKeyframeTrack!(p.field, { keyframes: p.keyframes }),
    { applied: plans.map((p) => p.text), failedAt: "readback" },
  );
}

/** Said when the timeline's id is not the frame's own: Figma was listing the frame under second ids [C-199]. */
const timelineNoteFor = (timelineId: string, frameId: string) =>
  `Figma reports this frame's timeline as ${timelineId}, not the frame's own id ${frameId}. Inside an animated frame Figma can ` +
  "list layers under temporary ids for a while: keep addressing layers by the ids your create calls returned.";

const setKeyframes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const prep = await beforeMutating(async () => {
      const nodeId = reqStr(ctx.params, "nodeId");
      const plans = planTracks(ctx.params.tracks);
      const d = ctx.params.timelineDuration;
      if (d !== undefined && (typeof d !== "number" || !Number.isFinite(d) || d <= 0)) throw invalid("`timelineDuration` must be a number of seconds greater than 0.");
      const duration = d as number | undefined;
      if (plans.length === 0 && duration === undefined) throw invalid("Pass `tracks`, `timelineDuration`, or both.");
      const node = (await byId(api(), nodeId)) as Motion;
      requireMotion(node);
      checkTargets(node, plans);
      // Each field's keys before the call: a dropped track is left exactly so [C-201].
      const existing = plans.length > 0 ? read(node, "manualKeyframeTracks") : undefined;
      const before = new Map(plans.map((p) => [p.text, keyframesToText(bindingAt(existing, p.field)?.keyframes)]));
      return { nodeId, node, plans, duration, before };
    });
    const { nodeId, node, plans, duration, before } = prep;

    const applied: string[] = [];
    for (const p of plans) {
      try {
        node.applyManualKeyframeTrack!(p.field, { keyframes: p.keyframes });
      } catch (err) {
        // The first refusal is the only write so far, and a refused Figma call
        // writes nothing (a gated API included), so the key is freed for a
        // corrected retry. unchanged() keeps only the hint: the message names the track.
        if (applied.length === 0) {
          unchanged(
            GATED.test(message(err))
              ? noMotion(message(err))
              : invalid(`Figma refused the track "${p.text}": ${message(err)}`, "figma_get_motion_context on an animated layer shows the shapes Figma accepts."),
          );
        }
        throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the track "${p.text}": ${message(err)}`, {
          hint: `Written before it and kept: ${applied.join(", ")}. Fix "${p.text}" and send it alone, or remove the others with figma_remove_keyframes.`,
          partial: { applied, failedAt: p.text },
        });
      }
      applied.push(p.text);
    }

    // Read back after a host turn through a new handle, and write again what
    // Figma dropped [C-250]. Everything below reads that handle.
    const check = plans.length > 0 ? await verifyTracks(ctx, nodeId, plans, before) : null;
    const live = check?.live ?? node;
    const lost = check ? check.missing.map((p) => p.text) : [];
    const kept = applied.filter((t) => !lost.includes(t));

    // Keyframes past the end of the timeline never play, so the timeline grows
    // to fit them — and never shrinks on its own, which would cut other tracks
    // that share it. An explicit duration is the agent's decision and is applied.
    // The timeline is read only now, from the handle the tracks settled on: its
    // id is the one setTimelineDuration takes [C-183] [C-182], and on
    // 2026-10-09 an id read earlier named a timeline that was gone a second later [C-199].
    const maxT = Math.max(0, ...plans.flatMap((p) => p.keyframes.map((k) => k.timelinePosition)));
    const tl = firstTimeline(live);
    let extended = false;
    let durationSet = false;
    const notes: string[] = [];
    if (tl) {
      const target = duration ?? (maxT > tl.duration ? maxT : undefined);
      if (target !== undefined && target !== tl.duration) {
        try {
          live.setTimelineDuration!(tl.id, target);
        } catch (err) {
          const refused = `Figma refused the timeline duration ${target} s: ${message(err)}`;
          // `tracks: []` + a duration: this was the only write, and it did not happen.
          if (applied.length === 0) unchanged(invalid(refused));
          throw new BridgeError(ErrorCode.INVALID_PARAM, refused, {
            hint: `The tracks were written and kept: ${kept.join(", ")}.${lost.length ? ` Figma did not keep ${lost.join(", ")}: send each alone.` : ""}`,
            partial: { applied: kept, failedAt: "timelineDuration", ...(lost.length ? { notApplied: lost } : {}) },
          });
        }
        extended = target > tl.duration;
        durationSet = true;
      }
      if (duration !== undefined && duration < maxT) notes.push(`timelineDuration ${duration} s ends before the last keyframe at ${r4(maxT)} s; keyframes after it never play.`);
    } else {
      notes.push("Figma reported no timeline for this layer, so the duration was left as it was.");
    }

    if (check && lost.length > 0) {
      const refusedAgain = lost.filter((t) => check.refusals.has(t)).map((t) => ` "${t}": ${check.refusals.get(t)}.`).join("");
      throw new BridgeError(ErrorCode.INTERNAL, `Figma did not keep ${lost.map((t) => `"${t}"`).join(", ")} after ${REPAIR_ROUNDS + 1} writes each.${refusedAgain}`, {
        hint:
          "Send each of these tracks alone, one figma_set_keyframes call per track, then read them back with " +
          `figma_get_motion_context. This was seen while Figma listed the frame's layers under temporary ids. ${TEMPORARY_ID_HINT}`,
        partial: { applied: [...kept, ...(durationSet ? ["timelineDuration"] : [])], notApplied: lost },
      });
    }

    const after = firstTimeline(live) ?? tl;
    const top = topLevelFrameOf(live);
    const rewritten = plans.filter((p) => (check?.attempts.get(p.text) ?? 1) > 1).length;
    if (rewritten > 0) notes.push(`Figma dropped ${rewritten} track(s) on the first write; they were written again and read back.`);
    const tracks = check ? check.tracks : undefined;
    return {
      nodeId: node.id,
      name: node.name,
      tracks: plans.map((p) => ({
        field: p.text,
        status: (check?.attempts.get(p.text) ?? 1) > 1 ? "rewritten" : "written",
        keyframes: keyframesToText(bindingAt(tracks, p.field)?.keyframes),
      })),
      timeline: after ? { id: after.id, duration: r4(after.duration), topLevelFrameId: top?.id ?? null } : null,
      extended,
      ...(after && top && after.id !== top.id ? { timelineNote: timelineNoteFor(after.id, top.id) } : {}),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  },
};

// ── figma_remove_keyframes ───────────────────────────────────────────────────

const removeKeyframes: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { nodeId, node, targets, notAnimated } = await beforeMutating(async () => {
      const nodeId = reqStr(ctx.params, "nodeId");
      const raw = ctx.params.fields;
      if (raw !== undefined && (!Array.isArray(raw) || raw.length === 0)) throw invalid("`fields` must be a non-empty array; omit it to remove every track.");
      const asked = raw === undefined ? undefined : (raw as unknown[]).map((f, i) => {
        if (typeof f !== "string") throw invalid(`\`fields[${i}]\` must be a string, e.g. "OPACITY".`);
        return fieldToString(fieldFromString(f, `fields[${i}]`));
      });
      const node = (await byId(api(), nodeId)) as Motion;
      requireMotion(node);
      const existing = tracksToFieldNames(read(node, "manualKeyframeTracks"));
      return {
        nodeId,
        node,
        targets: asked ? asked.filter((f) => existing.includes(f)) : existing,
        notAnimated: asked ? asked.filter((f) => !existing.includes(f)) : [],
      };
    });
    const removed: string[] = [];
    for (const f of targets) {
      try {
        node.removeManualKeyframeTrack!(fieldFromString(f));
      } catch (err) {
        const refused = `Figma refused to remove the track "${f}": ${message(err)}`;
        if (removed.length === 0) unchanged(invalid(refused));
        throw new BridgeError(ErrorCode.INVALID_PARAM, refused, { partial: { removed, failedAt: f } });
      }
      removed.push(f);
    }
    // The same readback and repair as figma_set_keyframes [C-250]. Whether a
    // removal can be dropped the way a write was is unknown [C-202]; checking
    // costs one host turn, and an unchecked "removed" is the echo that misled.
    const check = removed.length
      ? await settle(
          ctx,
          nodeId,
          removed.map((text) => ({ text })),
          (tracks, f) => tracksToFieldNames(tracks).includes(f.text),
          (handle, f) => handle.removeManualKeyframeTrack!(fieldFromString(f.text)),
          { removed, failedAt: "readback" },
        )
      : null;
    if (check && check.missing.length > 0) {
      const kept = check.missing.map((f) => f.text);
      throw new BridgeError(ErrorCode.INTERNAL, `Figma still holds ${kept.map((t) => `"${t}"`).join(", ")} after ${REPAIR_ROUNDS + 1} removals each.`, {
        hint: `Remove each of them alone, one figma_remove_keyframes call per field, then read the layer back with figma_get_motion_context. ${TEMPORARY_ID_HINT}`,
        partial: { removed: removed.filter((f) => !kept.includes(f)), notRemoved: kept },
      });
    }
    const retried = check ? removed.filter((f) => check.attempts.get(f)! > 1).length : 0;
    return {
      nodeId: node.id,
      removed,
      ...(notAnimated.length ? { notAnimated } : {}),
      remaining: tracksToFieldNames(check ? check.tracks : read(node, "manualKeyframeTracks")),
      ...(retried ? { note: `Figma kept ${retried} track(s) after the first removal; they were removed again and read back.` } : {}),
    };
  },
};

// ── figma_get_motion_context ─────────────────────────────────────────────────

/** What the Plugin API cannot tell, stated so code generated from this does not invent it [C-115]. */
export const MOTION_LIMITS = ["loopMode is not exposed by the Plugin API", "the pivot is the node centre"];

function animationStyleText(s: unknown): Record<string, unknown> | null {
  if (!isObject(s)) return null;
  // A prop is a plain value, an easing, or a variable alias; the last two read
  // in the keyframe string forms ("cubic:…", "var:<id>").
  const props = isObject(s.props)
    ? Object.fromEntries(Object.entries(s.props).map(([k, v]) => [k, isObject(v) ? easingToString(v) || JSON.stringify(v) : v]))
    : undefined;
  return {
    id: s.id,
    type: s.type,
    name: s.name,
    ...(typeof s.styleId === "string" ? { styleId: s.styleId } : {}),
    ...(typeof s.duration === "number" ? { duration: r4(s.duration) } : {}),
    ...(typeof s.timelineOffset === "number" ? { timelineOffset: r4(s.timelineOffset) } : {}),
    ...(props ? { props } : {}),
  };
}

type TrackText = { field: string; keyframes: KeyframeText[] };

function summarize(tracks: TrackText[], styleTracks: TrackText[], styles: Array<Record<string, unknown>>): string {
  const parts = [...tracks, ...styleTracks].map((t) => {
    const ks = t.keyframes;
    if (ks.length === 0) return `${t.field}: no keyframes`;
    const first = ks[0]!;
    const last = ks[ks.length - 1]!;
    return `${t.field} ${first.value} → ${last.value} over ${first.t}–${last.t} s${last.easing ? ` (${last.easing})` : ""}`;
  });
  for (const s of styles) parts.push(`style "${String(s.name)}"${typeof s.duration === "number" ? ` ${s.duration} s` : ""}`);
  return parts.join("; ");
}

function isAnimated(node: Motion): boolean {
  const styles = read(node, "animationStyles");
  return (
    tracksToFieldNames(read(node, "manualKeyframeTracks")).length > 0 ||
    tracksToFieldNames(read(node, "animations")).length > 0 ||
    (Array.isArray(styles) && styles.length > 0)
  );
}

const getMotionContext: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const f = api() as unknown as FigmaLike;
    const nodeId = str(ctx.params, "nodeId");
    // The selection lives on the page; PluginAPI has no `selection` [C-097].
    const selected = selectionOf(f);
    let roots: NodeLike[];
    let from: "node" | "selection" | "page";
    if (nodeId) {
      roots = [await byId(api(), nodeId)];
      from = "node";
    } else if (selected.length > 0) {
      roots = [...selected];
      from = "selection";
    } else {
      roots = [f.currentPage];
      from = "page";
    }
    // Descendants by default: the usual target is a screen, a top-level frame
    // that never carries keyframes itself, only its layers do [C-115] — reading
    // the frame alone answered "nothing animates" for an animated screen.
    // `recursive: false` narrows to the given layers, except a page, which
    // never animates itself either.
    const recursive = bool(ctx.params, "recursive", true) || roots.some((r) => NOT_SCENE.has(r.type));
    const maxNodes = Math.max(1, int(ctx.params, "maxNodes", 500, 2000));
    const scopeKey = `motion:${roots.map((r) => r.id).join(",")}:${recursive ? 1 : 0}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

    let index = 0;
    let more = false;
    let probed = false;
    const animated: Motion[] = [];
    for (const root of roots) {
      if (more) break;
      await walk(
        root,
        (n) => {
          if (index >= offset + maxNodes) {
            more = true;
            return false;
          }
          if (index++ < offset || NOT_SCENE.has(n.type)) return;
          const node = n as Motion;
          if (!probed) {
            read(node, "timelines"); // throws UNSUPPORTED once, before any result is shaped
            probed = true;
          }
          if (isAnimated(node)) animated.push(node);
        },
        ctx,
        recursive ? {} : { maxDepth: 0 },
      );
    }

    // A cohort is one top-level frame — the page's child, found by walking
    // parents. Keyed by the timeline id or by getTopLevelFrame(), one frame
    // came back under three ids on 2026-10-09, two of them second roots that
    // stopped resolving [C-199]; every timeline id seen is listed instead.
    const cohorts = new Map<string, { rootNodeId: string | null; timelineId: string; timelineIds: string[]; durationMs: number; memberNodeIds: string[] }>();
    // The frames this answer names, for their motion plans: each root's own, then each cohort's.
    const frames = new Map<string, NodeLike>();
    const frameOf = (n: NodeLike): NodeLike | null => {
      const top = NOT_SCENE.has(n.type) ? null : topLevelFrameOf(n);
      if (top && !frames.has(top.id)) frames.set(top.id, top);
      return top;
    };
    const topLevelFrameIds = roots.map((r) => frameOf(r)?.id ?? null);
    const nodes = animated.map((n) => {
      const manual = read(n, "manualKeyframeTracks");
      const tracks = manualTracksToText(manual);
      const styleTracks = styleTracksToText(read(n, "animations"), manual);
      const stylesRaw = read(n, "animationStyles");
      const animationStyles = (Array.isArray(stylesRaw) ? stylesRaw : []).map(animationStyleText).filter((s): s is Record<string, unknown> => s !== null);
      const timeline = firstTimeline(n);
      const topLevelFrameId = frameOf(n)?.id ?? null;
      if (timeline) {
        const key = topLevelFrameId ?? `timeline:${timeline.id}`;
        const c = cohorts.get(key) ?? { rootNodeId: topLevelFrameId, timelineId: timeline.id, timelineIds: [], durationMs: Math.round(timeline.duration * 1000), memberNodeIds: [] };
        if (!c.timelineIds.includes(timeline.id)) c.timelineIds.push(timeline.id);
        c.memberNodeIds.push(n.id);
        cohorts.set(key, c);
      }
      return {
        nodeId: n.id,
        name: n.name,
        type: n.type,
        topLevelFrameId,
        timeline: timeline ? { id: timeline.id, durationS: r4(timeline.duration) } : null,
        tracks,
        ...(styleTracks.length ? { styleTracks } : {}),
        animationStyles,
        summary: summarize(tracks, styleTracks, animationStyles),
      };
    });
    ctx.progress(index, index);
    // Nothing found while layers went unread is not "nothing animates".
    const unread = !recursive && roots.some((r) => (r.children?.length ?? 0) > 0);
    const none = unread
      ? "None of the given layers is animated; their children were not read (recursive: false). Omit recursive to read them."
      : "No animated layers here.";
    return {
      // topLevelFrameIds[i] is the frame around ids[i] (null for a page or a section): what the motion gate keys on.
      scope: { from, ids: roots.map((r) => r.id), recursive, topLevelFrameIds },
      count: nodes.length,
      nodes,
      // Each named frame's plan from figma_set_motion_plan; null when it has none.
      motionPlans: [...frames.values()].map((f) => {
        const { plan, invalid } = readMotionPlan(f);
        return { frameId: f.id, name: f.name, plan, ...(invalid ? { invalid } : {}) };
      }),
      timelineCohorts: [...cohorts.values()].map((c) =>
        c.timelineIds.length > 1 || (c.rootNodeId !== null && c.timelineIds[0] !== c.rootNodeId)
          ? {
              ...c,
              note:
                `Figma reported this frame's timeline as ${c.timelineIds.join(", ")}, not only as the frame's own id. Inside an ` +
                "animated frame Figma can list layers and timelines under temporary ids for a while: keep addressing layers by the ids your create calls returned.",
            }
          : c,
      ),
      limits: MOTION_LIMITS,
      truncated: more,
      ...(more
        ? { nextCursor: encodeCursor(scopeKey, offset + maxNodes), note: `Stopped after ${maxNodes} layers; call again with nextCursor for the rest. Cohorts cover this page of results only.` }
        : {}),
      ...(nodes.length === 0 && !more ? { note: none } : {}),
    };
  },
};

// ── figma_export_video ───────────────────────────────────────────────────────

type VideoExportable = NodeLike & { exportAsync?(settings: Record<string, unknown>): Promise<Uint8Array> } & Motion;

/** The node itself when it is a top-level frame, else the top-level frame around it — the only node Figma encodes [C-116]. */
function videoTarget(node: VideoExportable): VideoExportable {
  if (node.parent?.type === "PAGE" && node.type === "FRAME") return node;
  const top = typeof node.getTopLevelFrame === "function" ? node.getTopLevelFrame() : undefined;
  if (!top) {
    throw invalid(`"${node.name}" is not inside a top-level frame, and only a top-level frame can be exported as video.`, "Pass a layer inside an animated frame, or the frame itself.");
  }
  return top as VideoExportable;
}

/**
 * The frame's timeline, read before a render: `undefined` when it has none,
 * "unknown" when this build cannot say (no `timelines` member, or a read that
 * fails for another reason) — then the render is tried as before. A gated
 * Motion API is UNSUPPORTED: there is nothing to render without it [C-115].
 */
function timelineBeforeRender(target: VideoExportable): Timeline | undefined | "unknown" {
  if (!("timelines" in target)) return "unknown";
  try {
    return firstTimeline(target);
  } catch (err) {
    if (err instanceof BridgeError && err.code === ErrorCode.UNSUPPORTED && GATED.test(err.message)) throw err;
    return "unknown";
  }
}

const exportVideo: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const nodeId = reqStr(ctx.params, "nodeId");
    const settings = videoSettings(ctx.params);
    const node = (await byId(api(), nodeId)) as VideoExportable;
    const target = videoTarget(node);
    if (typeof target.exportAsync !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${target.type} cannot be exported.`);
    // Nothing to play: refused here, in milliseconds, rather than by Figma's
    // bare "Video export failed", which says neither why nor what to do.
    const timeline = timelineBeforeRender(target);
    if (timeline === undefined || (timeline !== "unknown" && !(timeline.duration > 0))) {
      throw invalid(
        `"${target.name}" has no animation to render: ${timeline === undefined ? "it has no timeline" : "its timeline is 0 s long"}.`,
        "Key a layer inside the frame with figma_set_keyframes (figma_get_motion_context shows what animates), then render. " +
          "figma_export_node renders a still frame.",
      );
    }
    ctx.progress(0, undefined, `rendering ${settings.format}`);
    let bytes: Uint8Array;
    try {
      bytes = await target.exportAsync(settings);
    } catch (err) {
      // A render Figma ran out of time for is no refusal of the frame: render
      // again (shared/video.ts). Its size goes along, so the bridge can tell a
      // stuck exporter (a small render that timed out) from a render too big.
      if (isRenderTimeout(message(err))) {
        const fps = typeof settings.fps === "number" ? settings.fps : DEFAULT_VIDEO_FPS[settings.format];
        const size =
          timeline !== "unknown" && typeof target.width === "number" && typeof target.height === "number"
            ? renderSize({ width: target.width, height: target.height }, settings, timeline.duration, fps)
            : undefined;
        throw new BridgeError(ErrorCode.TIMEOUT, `Figma gave up rendering "${target.name}" as ${settings.format}: ${message(err)}`, {
          hint: renderTimeoutHint({ small: isSmallRender(size) }),
          ...(size ? { partial: { render: size } } : {}),
        });
      }
      // The frame has a timeline, so this is not a missing animation, and
      // Figma said nothing more: retry once, then restart Figma. Not
      // UNSUPPORTED, which tells an agent to stop for good.
      throw new BridgeError(ErrorCode.INTERNAL, `Figma could not export "${target.name}" as ${settings.format}: ${message(err)}`, { hint: RENDER_FAILED_HINT });
    }
    ctx.progress(0, bytes.length, "encoding");
    const base64 = await encodeBase64(bytes, ctx.yieldToHost);
    let durationS: number | undefined;
    try {
      durationS = firstTimeline(target)?.duration;
    } catch {
      durationS = undefined; // the export worked; a gated timeline read must not lose it
    }
    return {
      nodeId,
      exportedNodeId: target.id,
      name: target.name,
      format: settings.format,
      mime: VIDEO_MIME[settings.format],
      bytes: bytes.length,
      // To the microsecond, as Figma keeps it: the frame count depends on it [C-194].
      ...(durationS !== undefined ? { durationS: r6(durationS) } : {}),
      base64,
    };
  },
};

// ── figma_set_scroll_behavior ────────────────────────────────────────────────

const OVERFLOW: Record<string, string> = { none: "NONE", horizontal: "HORIZONTAL", vertical: "VERTICAL", both: "BOTH" };

type Scrollable = NodeLike & {
  overflowDirection?: string;
  numberOfFixedChildren?: number;
  layoutMode?: string;
  appendChild?(child: NodeLike): void;
};

/** An instance, or a layer anywhere inside one: Figma moves none of their layers. */
function insideInstance(node: NodeLike): boolean {
  for (let n: NodeLike | null | undefined = node; n; n = n.parent) if (n.type === "INSTANCE") return true;
  return false;
}

const setScrollBehavior: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { node, overflow, fixed } = await beforeMutating(async () => {
      const nodeId = reqStr(ctx.params, "nodeId");
      const o = str(ctx.params, "overflow");
      const overflow = o === undefined ? undefined : OVERFLOW[o.toLowerCase()];
      if (o !== undefined && overflow === undefined) throw invalid('`overflow` must be "none", "horizontal", "vertical" or "both".');
      const rawFixed = ctx.params.fixedNodeIds;
      if (rawFixed !== undefined && !Array.isArray(rawFixed)) throw invalid("`fixedNodeIds` must be an array of child ids; [] makes every child scroll.");
      if (overflow === undefined && rawFixed === undefined) throw invalid("Pass `overflow`, `fixedNodeIds`, or both.");
      const node = (await byId(api(), nodeId)) as Scrollable;
      // FramePrototypingMixin: frames, components and instances (plugin-api.d.ts 9082-9111) [C-117].
      if (typeof node.overflowDirection !== "string" || typeof node.numberOfFixedChildren !== "number") {
        throw invalid(`A ${node.type} has no scroll behaviour; use a frame, component or instance.`);
      }
      const kids = node.children ?? [];
      const fixed: NodeLike[] = [];
      for (const [i, id] of ((rawFixed as unknown[] | undefined) ?? []).entries()) {
        if (typeof id !== "string") throw invalid(`\`fixedNodeIds[${i}]\` must be a node id.`);
        const child = kids.find((k) => k.id === id);
        if (!child) throw invalid(`\`fixedNodeIds[${i}]\` ${id} is not a direct child of "${node.name}".`, "Only the frame's own children can be fixed; move the layer into it first.");
        if (fixed.includes(child)) throw invalid(`\`fixedNodeIds[${i}]\` ${id} is listed twice.`);
        // Fixed children are moved to the top of the layer list; in auto-layout
        // that would also move them in the flow, so only absolute ones qualify.
        if (node.layoutMode !== undefined && node.layoutMode !== "NONE" && (child as Scrollable & { layoutPositioning?: string }).layoutPositioning !== "ABSOLUTE") {
          throw invalid(`\`fixedNodeIds[${i}]\` "${child.name}" is in the auto-layout flow; fixing it would reorder the layout.`, `figma_move_nodes { nodeIds: ["${child.id}"], positioning: "absolute" } first, then fix it.`);
        }
        fixed.push(child);
      }
      if (fixed.length > 0 && typeof node.appendChild !== "function") throw invalid(`A ${node.type} cannot reorder its children.`);
      // Figma refuses to move a layer of an instance (appendChild throws) [C-123],
      // and fixing layers means moving them: refuse here, not half-way through.
      if (fixed.length > 0 && insideInstance(node)) {
        throw invalid(
          `"${node.name}" is ${node.type === "INSTANCE" ? "an instance" : "inside an instance"}, whose layers cannot be reordered, so none can be fixed.`,
          "Fix the layers in its main component; every instance follows. `overflow` alone still works here.",
        );
      }
      return { node, overflow, fixed: rawFixed === undefined ? undefined : fixed };
    });

    // The reorder is the write Figma may still refuse, so it goes first and
    // the overflow last: a refusal of the first move has changed nothing.
    const moved: string[] = [];
    let wrote = false;
    let step = "fixedNodeIds";
    try {
      if (fixed !== undefined) {
        // Fixed layers are a section at the top of the layer list — the end of
        // `children` — not a per-layer flag (plugin-api.d.ts 9093-9096) [C-117].
        // Moving them there in the given order, then counting them, makes exactly
        // these the fixed ones. Already there in that order: nothing to move.
        const kids = node.children ?? [];
        const tail = kids.slice(kids.length - fixed.length);
        if (fixed.length > 0 && !fixed.every((c, i) => tail[i] === c)) {
          for (const child of fixed) {
            node.appendChild!(child);
            moved.push(child.id);
            wrote = true;
          }
        }
        node.numberOfFixedChildren = fixed.length;
        wrote = true;
      }
      step = "overflow";
      if (overflow !== undefined) node.overflowDirection = overflow;
    } catch (err) {
      const refused = `Figma refused \`${step}\` on "${node.name}": ${message(err)}`;
      if (!wrote) unchanged(invalid(refused));
      throw new BridgeError(ErrorCode.INVALID_PARAM, refused, {
        hint:
          step === "overflow"
            ? "The fixed layers were set and kept; only `overflow` was not written."
            : "The layers in `partial.moved` were moved and kept. figma_get_node shows the frame's order now.",
        partial: { moved, failedAt: step },
      });
    }
    return {
      nodeId: node.id,
      overflow: String(node.overflowDirection).toLowerCase(),
      fixedChildren: node.numberOfFixedChildren,
      order: (node.children ?? []).map((c) => c.id),
    };
  },
};

// ── figma_set_prototype_flows ────────────────────────────────────────────────

type PageLike = NodeLike & {
  flowStartingPoints?: ReadonlyArray<{ nodeId: string; name: string }>;
  prototypeBackgrounds?: ReadonlyArray<Record<string, unknown>>;
  loadAsync?(): Promise<void>;
};

/** A flow starts at a frame placed on the page itself (PageNode.flowStartingPoints, plugin-api.d.ts 10632-10641) [C-117]. */
const FLOW_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

function paintHex(p: unknown): string | undefined {
  if (!isObject(p) || p.type !== "SOLID" || !isObject(p.color)) return undefined;
  const c = p.color as { r: number; g: number; b: number };
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  const a = typeof p.opacity === "number" ? p.opacity : 1;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.998 ? h(a) : ""}`;
}

const setPrototypeFlows: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { page, flows, background } = await beforeMutating(async () => {
      const rawFlows = ctx.params.flows;
      const bg = str(ctx.params, "background");
      if (rawFlows === undefined && bg === undefined) throw invalid("Pass `flows`, `background`, or both.");
      if (rawFlows !== undefined && !Array.isArray(rawFlows)) throw invalid("`flows` must be an array of { nodeId, name }; [] removes every flow.");
      const background = bg === undefined ? undefined : parseColor(bg, "background");
      const pageId = str(ctx.params, "pageId");
      const page = (pageId ? await byId(api(), pageId) : api().currentPage) as PageLike;
      if (page.type !== "PAGE") throw invalid(`\`pageId\` ${page.id} is a ${page.type}, not a page.`);
      // Under dynamic-page another page's children are unreadable until loaded [C-090].
      await ensureLoaded(page);
      for (const member of ["flowStartingPoints", ...(background ? ["prototypeBackgrounds"] : [])]) {
        if (!(member in page)) throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor has no prototype flows (PageNode.${member} is missing).`);
      }
      const flows: Array<{ nodeId: string; name: string }> = [];
      for (const [i, entry] of ((rawFlows as unknown[] | undefined) ?? []).entries()) {
        const at = `flows[${i}]`;
        if (!isObject(entry) || typeof entry.nodeId !== "string" || typeof entry.name !== "string" || entry.name.trim() === "") {
          throw invalid(`\`${at}\` must be { nodeId, name } with a non-empty name.`);
        }
        if (flows.some((x) => x.nodeId === entry.nodeId)) throw invalid(`\`${at}.nodeId\` ${entry.nodeId} already starts a flow in this list.`);
        const n = await api().getNodeByIdAsync(entry.nodeId);
        if (!n) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `\`${at}.nodeId\`: no node with id \`${entry.nodeId}\`.`, { hint: TEMPORARY_ID_HINT });
        if (n.parent?.id !== page.id || !FLOW_TYPES.has(n.type)) {
          throw invalid(`\`${at}.nodeId\` "${n.name}" is not a top-level frame on page "${page.name}".`, "A flow starts at a frame placed directly on the page.");
        }
        flows.push({ nodeId: n.id, name: entry.name });
      }
      return { page, flows: rawFlows === undefined ? undefined : flows, background };
    });

    // The first starting point is the one the play button opens (plugin-api.d.ts 10633-10636).
    if (flows !== undefined) (page as { flowStartingPoints: unknown }).flowStartingPoints = flows;
    if (background !== undefined) (page as { prototypeBackgrounds: unknown }).prototypeBackgrounds = [background];
    const bg = paintHex(page.prototypeBackgrounds?.[0]);
    return {
      pageId: page.id,
      flows: (page.flowStartingPoints ?? []).map((p) => ({ nodeId: p.nodeId, name: p.name })),
      ...(bg ? { background: bg } : {}),
    };
  },
};

/** Wired into PLUGIN_OPS by the integrator (src/plugin/ops/index.ts). */
export const MOTION_OPS: Record<string, PluginOp> = {
  get_motion_context: getMotionContext,
  set_keyframes: setKeyframes,
  remove_keyframes: removeKeyframes,
  export_video: exportVideo,
  set_scroll_behavior: setScrollBehavior,
  set_prototype_flows: setPrototypeFlows,
};
