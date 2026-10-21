// figma_check_motion's plugin half: read one animated top-level frame as a
// snapshot, and judge nothing. The rules run on the server
// (src/server/motion-audit.ts), where they are pure functions over this data
// and can be tested against the recorded 2026-10-09 snapshots without fakes.
//
// Reads only. Every member is read through board-read.ts's guard (`field`), as
// figma_check_layout reads, so a member that throws reads as absent; the motion
// members go through `motion()`, which turns Figma's per-user gate into
// UNSUPPORTED [C-115].
//
// The frame is found by walking parents, never through getTopLevelFrame():
// inside an animated frame that has named a second root whose id stops
// resolving minutes later [C-199].

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { MotionSnapshot, SnapshotEffect, SnapshotNode, SnapshotTrack } from "../../shared/motion-curves.js";
import type { OpContext, PluginOp } from "./index.js";
import { childrenOf, field } from "../board-read.js";
import { bindingAt, fieldFromString, manualTracksToText, valueToString } from "../motion-fields.js";
// The gate's words come from motion.ts, so a gated account reads alike from every motion op [C-115].
import { GATED, noMotion } from "./motion.js";
import { readMotionPlan } from "./motion-plan.js";
import { LayerSet, byId, canvasTwins, int, lookUp, sameLayer, selectionOf, str, strList, topLevelFrameOf, walk, type FigmaLike, type NodeLike } from "../read.js";

type Any = Record<string, unknown>;

const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const invalid = (msg: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, msg, hint ? { hint } : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r2 = (v: number) => Math.round(v * 100) / 100;

type MotionKey = "timelines" | "manualKeyframeTracks" | "animationStyles";

/** One motion member. `required`: a node that lacks it means the build has no Motion API. */
function motion(node: NodeLike, key: MotionKey, required: boolean): unknown {
  if (!(key in node)) {
    if (required) throw noMotion(`a ${node.type} has no \`${key}\` — this Figma build has no Motion API.`);
    return undefined;
  }
  try {
    return (node as unknown as Any)[key];
  } catch (err) {
    if (GATED.test(message(err))) throw noMotion(message(err));
    return undefined;
  }
}

/** Containers a top-level frame may sit in without stopping being one. */
const CANVAS = new Set(["PAGE", "SECTION"]);

// The frame that holds a node comes from read.ts's topLevelFrameOf, which
// walks parents [C-199]: the frame figma_get_motion_context and
// figma_set_keyframes report, so a finding's root is the frame they name.

const label = (n: NodeLike) => `"${n.name}" (${n.id})`;

function listOf(nodes: NodeLike[]): string {
  const shown = nodes.slice(0, 10).map(label).join(", ");
  return nodes.length > 10 ? `${shown} and ${nodes.length - 10} more` : shown;
}

/** Whether any layer under `frame` carries a keyframe track, reading at most `budget` layers. */
async function animated(frame: NodeLike, budget: { left: number }, ctx: OpContext): Promise<boolean> {
  let found = false;
  await walk(
    frame,
    (n) => {
      if (budget.left-- <= 0 || found) return false;
      const tracks = motion(n, "manualKeyframeTracks", false);
      if (tracks && typeof tracks === "object" && Object.keys(tracks).length > 0) found = true;
      return found ? false : undefined;
    },
    ctx,
  );
  return found;
}

/**
 * Top-level frames on the page, those inside sections included, each once:
 * during a second-id stretch the page may list a frame a second time, under
 * its second id [C-199].
 */
function canvasFrames(page: NodeLike): NodeLike[] {
  const out: NodeLike[] = [];
  const met = new LayerSet();
  const visit = (parent: NodeLike) => {
    for (const c of childrenOf(parent) ?? []) {
      if (c.type === "SECTION") visit(c);
      else if (met.add(c)) out.push(c);
    }
  };
  visit(page);
  return out;
}

async function resolveRoot(ctx: OpContext, maxNodes: number): Promise<{ root: NodeLike; from: string }> {
  const f = api();
  const nodeId = str(ctx.params, "nodeId");
  if (nodeId) {
    const node = await byId(f, nodeId);
    if (CANVAS.has(node.type) || node.type === "DOCUMENT") {
      throw invalid(`\`nodeId\` is a ${node.type}; motion lives in a top-level frame.`, "Pass the animated frame or any layer inside it.");
    }
    const top = topLevelFrameOf(node);
    if (!top) throw invalid(`"${node.name}" is not inside a top-level frame.`, "Pass the animated frame or any layer inside it.");
    return { root: top, from: "node" };
  }
  const tops: NodeLike[] = [];
  const met = new LayerSet();
  for (const s of selectionOf(f)) {
    const top = topLevelFrameOf(s);
    if (top && met.add(top)) tops.push(top);
  }
  if (tops.length === 1) return { root: tops[0]!, from: "selection" };
  if (tops.length > 1) {
    throw invalid(`The selection spans ${tops.length} top-level frames: ${listOf(tops)}.`, "Pass `nodeId` for the one to check, or select inside one frame.");
  }
  const budget = { left: maxNodes };
  const found: NodeLike[] = [];
  const candidates = canvasFrames(f.currentPage);
  // Without the Motion API no frame would look animated; say why instead.
  if (candidates[0]) motion(candidates[0], "manualKeyframeTracks", true);
  for (const frame of candidates) if (await animated(frame, budget, ctx)) found.push(frame);
  if (found.length === 1) return { root: found[0]!, from: "page" };
  if (found.length > 1) {
    throw invalid(`Nothing is selected and this page has ${found.length} animated frames: ${listOf(found)}.`, "Pass `nodeId` for the one to check.");
  }
  throw invalid("Nothing is selected and no frame on this page has keyframes.", "Select the animated frame, or pass `nodeId`; figma_set_keyframes animates layers.");
}

function tracksOf(node: NodeLike): SnapshotTrack[] | undefined {
  const raw = motion(node, "manualKeyframeTracks", false);
  if (!raw || typeof raw !== "object") return undefined;
  const tracks = manualTracksToText(raw).map((t): SnapshotTrack => {
    // The base value is the binding's own member [C-183]; a field newer than
    // the grammar still reads through the lenient parser.
    let base: unknown;
    try {
      base = bindingAt(raw, fieldFromString(t.field))?.baseValue;
    } catch {
      base = undefined;
    }
    return { field: t.field, keyframes: t.keyframes, ...(base !== undefined && base !== null ? { base: valueToString(base) } : {}) };
  });
  return tracks.length ? tracks : undefined;
}

function effectsOf(node: NodeLike): SnapshotEffect[] | undefined {
  const list = field<unknown>(node, "effects");
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((e) => {
    const o = (e ?? {}) as Any;
    const radius = num(o.radius);
    return { type: String(o.type), ...(radius !== undefined ? { radius } : {}), ...(o.visible === false ? { visible: false } : {}) };
  });
}

/** Everything a rule reads off one node, defaults omitted so a large frame stays small on the wire. */
function describe(node: NodeLike): SnapshotNode {
  const out: SnapshotNode = { id: node.id, name: node.name, type: node.type, parentId: node.parent?.id ?? null };
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = num(field(node, k));
    if (v !== undefined) out[k] = r2(v);
  }
  const rotation = num(field(node, "rotation"));
  if (rotation) out.rotation = r2(rotation);
  const opacity = num(field(node, "opacity"));
  if (opacity !== undefined && opacity !== 1) out.opacity = r2(opacity);
  if (field(node, "visible") === false) out.visible = false;
  if (field(node, "clipsContent") === true) out.clipsContent = true;
  if (field(node, "isMask") === true) out.isMask = true;
  const layoutMode = field(node, "layoutMode");
  if (typeof layoutMode === "string" && layoutMode !== "NONE") out.layoutMode = layoutMode;
  if (field(node, "layoutPositioning") === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
  const radius = num(field(node, "cornerRadius")); // figma.mixed is a symbol: absent here
  if (radius) out.cornerRadius = r2(radius);
  const strokes = field<unknown>(node, "strokes");
  if (Array.isArray(strokes) && strokes.some((p) => (p as Any | null)?.visible !== false)) {
    const cap = field(node, "strokeCap");
    if (typeof cap === "string") out.strokeCap = cap;
    const weight = num(field(node, "strokeWeight"));
    if (weight !== undefined) out.strokeWeight = r2(weight);
  }
  if (node.type === "TEXT") {
    const chars = field(node, "characters");
    if (typeof chars === "string") out.characters = chars.slice(0, 500);
    const size = num(field(node, "fontSize"));
    if (size !== undefined) out.fontSize = size;
  }
  const effects = effectsOf(node);
  if (effects) out.effects = effects;
  const kids = childrenOf(node)?.length ?? 0;
  if (kids) out.childCount = kids;
  const tracks = tracksOf(node);
  if (tracks) out.tracks = tracks;
  const styles = motion(node, "animationStyles", false);
  if (Array.isArray(styles) && styles.length) out.animationStyles = styles.length;
  return out;
}

const checkMotion: PluginOp = {
  write: false,
  async run(ctx: OpContext): Promise<MotionSnapshot> {
    const maxNodes = Math.max(1, int(ctx.params, "maxNodes", 2000, 5000));
    const { root, from } = await resolveRoot(ctx, maxNodes);
    // The probe: a gated account or a build without Motion answers here, before any walk.
    motion(root, "manualKeyframeTracks", true);
    const timelines = motion(root, "timelines", true);
    const first = Array.isArray(timelines) ? ((timelines[0] ?? null) as Any | null) : null;
    const durationS = num(first?.duration) ?? null;

    // The plan of the frame about to be read, so the server judges against that frame's own plan.
    const stored = readMotionPlan(root);
    const { targets, gone } = await namedLayers([stored.plan?.brandId, stored.plan?.ctaId, ...(strList(ctx.params, "resolveIds") ?? [])]);

    const nodes: SnapshotNode[] = [];
    let truncated = false;
    await walk(
      root,
      (n) => {
        if (nodes.length >= maxNodes) {
          truncated = true;
          return false;
        }
        const d = describe(n);
        nodes.push(n === root ? { ...d, parentId: null } : d);
        return undefined;
      },
      ctx,
    );
    ctx.progress(nodes.length, nodes.length);
    const rootBox = nodes[0]!;
    const { aliases, unmapped, outside } = listedAs(targets, new Set(nodes.map((n) => n.id)), truncated);
    // Every id the page lists this frame under, so a check is recorded under whichever one a later call names [C-199].
    const twins = canvasTwins(root);
    return {
      root: {
        id: root.id,
        name: root.name,
        ...(twins.length ? { handles: [root.id, ...twins] } : {}),
        ...(rootBox.width !== undefined ? { width: rootBox.width } : {}),
        ...(rootBox.height !== undefined ? { height: rootBox.height } : {}),
        durationS: durationS === null ? null : Math.round(durationS * 10000) / 10000,
        ...(typeof first?.id === "string" ? { timelineId: first.id } : {}),
      },
      nodes,
      truncated,
      maxNodes,
      from,
      plan: stored.plan,
      ...(stored.invalid ? { planInvalid: stored.invalid } : {}),
      aliases,
      ...(unmapped.length ? { unmapped } : {}),
      ...(outside.length ? { outside } : {}),
      ...(gone.length ? { gone } : {}),
    };
  },
};

/** The layers behind the ids a check names, each looked up once, and the ids that resolve to nothing (`gone`). */
async function namedLayers(ids: ReadonlyArray<string | undefined>): Promise<{ targets: Array<{ id: string; handle: NodeLike }>; gone: string[] }> {
  const targets: Array<{ id: string; handle: NodeLike }> = [];
  const gone: string[] = [];
  for (const id of new Set(ids)) {
    if (typeof id !== "string" || id === "") continue;
    let handle: NodeLike | null = null;
    try {
      handle = await lookUp(api(), id);
    } catch {
      handle = null;
    }
    if (handle) targets.push({ id, handle });
    else gone.push(id);
  }
  return { targets, gone };
}

/**
 * For each named layer the walk did not read under its own id: the listed
 * id it is (`aliases`), or that two or more listed layers match it
 * (`unmapped`), or — when the walk read the whole frame — that it is not in
 * this frame (`outside`) [C-199]. The match is counted over the handle's
 * whole sibling listing, not over the layers read, so a walk cut by
 * `maxNodes` never turns two matches into one; an alias is given only when
 * its one match was read. A layer its own parent lists, missing from a cut
 * walk, is past the cut: none of them.
 */
function listedAs(
  targets: ReadonlyArray<{ id: string; handle: NodeLike }>,
  listed: ReadonlySet<string>,
  truncated: boolean,
): { aliases: Record<string, string>; unmapped: string[]; outside: string[] } {
  const aliases: Record<string, string> = {};
  const unmapped: string[] = [];
  const outside: string[] = [];
  for (const { id, handle } of targets) {
    if (listed.has(id)) continue;
    const siblings = (handle.parent ? childrenOf(handle.parent) : undefined) ?? [];
    const same = siblings.some((s) => s.id === id) ? [handle] : siblings.filter((s) => sameLayer(s, handle));
    if (same.length > 1) unmapped.push(id);
    else if (same.length === 1 && listed.has(same[0]!.id)) aliases[id] = same[0]!.id;
    else if (!truncated) outside.push(id);
  }
  return { aliases, unmapped, outside };
}

/** Wired into PLUGIN_OPS by the integrator (src/plugin/ops/index.ts). */
export const MOTION_SNAPSHOT_OPS: Record<string, PluginOp> = {
  check_motion: checkMotion,
};
