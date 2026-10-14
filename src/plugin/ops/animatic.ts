// figma_create_animatic in the plugin: read a storyboard as the canvas shows
// it now, render each panel's best picture, build the animatic as ONE
// create_from_spec call, then key every plate and read every track back.
//
// Everything that can refuse runs before the first node exists — the record
// and its captions, the Motion probe, the plan, every render — so a refusal
// provably changed nothing (`created: []`); the runner commits one undo step
// for the whole call. The planner (shared/animatic.ts) owns the frames, the
// keys and the spec; this file owns what needs Figma.
//
// The keys go through the verified writer of figma_set_keyframes [C-250]:
// every layer carries one track, written alone and read back after a host
// turn through a new handle, and written again if Figma dropped it. On
// 2026-10-09 several tracks written to one layer in one synchronous run kept
// only the last [C-201]; one track per write, each read back, cannot lose one
// silently. The duration is set last, on the timeline the settled handle
// reports [C-182] [C-183], and then every track is read back once more.

import {
  compileAnimaticSpec,
  panelLabel,
  planAnimatic,
  plateSize,
  readAnimaticOptions,
  renderCall,
  SLATE_CAPTIONS,
  slateLines,
  type AnimaticOptions,
  type AnimaticPlan,
  type SlateCaption,
} from "../../shared/animatic.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { KeyText } from "../../shared/motion-curves.js";
import { EMPTY_CAPTION, type ReadPanel, type StoryboardReading } from "../../shared/storyboard.js";
import { beforeMutating } from "../guard.js";
import { bindingAt, keyframesToText, type KeyframeFieldLike, type KeyframeText } from "../motion-fields.js";
import { reqStr, str, TEMPORARY_ID_HINT } from "../read.js";
import { tryGet } from "../safe.js";
import { num, parentFor, type FigmaWrite, type NodeLikeW } from "../write.js";
import { MAX_IMAGE_SIDE, renderToImage } from "./assets.js";
import { CREATE_OPS, type Created } from "./create.js";
import type { OpContext, PluginOp } from "./index.js";
import { GATED, noMotion, planTracks, verifyTracks, type TrackPlan } from "./motion.js";
import { emptySpot, readStoryboard } from "./storyboard.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;
type Any = Record<string, unknown>;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Motion = NodeLikeW & {
  [key: string]: unknown;
  applyManualKeyframeTrack?(field: KeyframeFieldLike, track: { keyframes: unknown[] }): void;
  setTimelineDuration?(id: string, duration: number): void;
};

type Renderable = NodeLikeW & { width: number; height: number; exportAsync(settings: Any): Promise<Uint8Array> };

// ── Motion ───────────────────────────────────────────────────────────────────

/** Read a Motion member; a gated account (Figma's "not a supported API") is UNSUPPORTED [C-115]. */
function motionRead(node: Motion, key: string): unknown {
  if (!(key in node)) throw noMotion(`a ${node.type} has no \`${key}\` — this Figma build has no Motion API.`);
  try {
    return node[key];
  } catch (err) {
    if (GATED.test(message(err))) throw noMotion(message(err));
    throw err;
  }
}

/** Probe on an existing node, before anything is created: every member the keys need exists and reads. */
function requireMotion(node: Motion): void {
  for (const fn of ["applyManualKeyframeTrack", "setTimelineDuration"] as const) {
    if (typeof node[fn] !== "function") throw noMotion(`a ${node.type} has no \`${fn}\` — this Figma build has no Motion API.`);
  }
  motionRead(node, "timelines");
}

function timelineOf(node: Motion): { id: string; duration: number } | undefined {
  const t = motionRead(node, "timelines");
  const first = Array.isArray(t) ? (t[0] as unknown) : undefined;
  if (typeof first !== "object" || first === null) return undefined;
  const { id, duration } = first as { id?: unknown; duration?: unknown };
  return typeof id === "string" && typeof duration === "number" ? { id, duration } : undefined;
}

// ── the board as it is now ───────────────────────────────────────────────────

async function textOf(figma: FigmaWrite, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const node = await figma.getNodeByIdAsync(id);
  const chars = node ? tryGet<unknown>(node, "characters") : undefined;
  if (!chars?.ok || typeof chars.value !== "string") return undefined;
  const t = chars.value.trim();
  return t && t !== EMPTY_CAPTION ? t : undefined;
}

/** The card's header text ("02 · Vase · 0:01.2"), which carries the panel's title. */
async function headerOf(figma: FigmaWrite, cardId: string): Promise<string | undefined> {
  const card = await figma.getNodeByIdAsync(cardId);
  const kids = card ? tryGet<readonly NodeLikeW[]>(card, "children") : undefined;
  if (!kids?.ok || !Array.isArray(kids.value)) return undefined;
  const head = kids.value.find((k) => k.type === "TEXT" && /\/ Title$/.test(k.name));
  return head ? textOf(figma, head.id) : undefined;
}

interface PanelTexts {
  label: string;
  transition?: string;
  captions: Partial<Record<SlateCaption, string>>;
}

async function panelTexts(figma: FigmaWrite, p: ReadPanel): Promise<PanelTexts> {
  const captions: Partial<Record<SlateCaption, string>> = {};
  for (const c of SLATE_CAPTIONS) {
    const t = await textOf(figma, p.captionIds[c]);
    if (t !== undefined) captions[c] = t;
  }
  return {
    label: panelLabel(p.index, await headerOf(figma, p.id)),
    ...(captions.transition !== undefined ? { transition: captions.transition } : {}),
    captions,
  };
}

/** The page to build on: `pageId`, or the page the board is on, loaded so its children read. */
async function pageFor(figma: FigmaWrite, pageId: string | undefined, board: NodeLikeW): Promise<NodeLikeW> {
  let id = pageId;
  if (!id) {
    let n: NodeLikeW | null | undefined = board;
    while (n && n.type !== "PAGE" && n.type !== "PAGE_NODE") n = n.parent;
    if (!n) return figma.currentPage;
    id = n.id;
  }
  const page = await parentFor(figma, id);
  if (page.type !== "PAGE" && page.type !== "PAGE_NODE") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`pageId\` \`${id}\` is a ${page.type}, not a page.`, {
      hint: "An animatic is a top-level frame: give a page id, or leave pageId out for the board's page.",
    });
  }
  return page;
}

// ── pictures ─────────────────────────────────────────────────────────────────

type From = "styleframe" | "source" | "thumb";

interface Picture {
  from: From;
  paints: unknown[];
  /** Nothing is drawn or placed for this panel yet: its plate shows the thumbnail's own fill. */
  blank?: true;
  note?: string;
}

const BLACK = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };

function renderable(n: NodeLikeW | null): n is Renderable {
  if (!n) return false;
  const w = tryGet<unknown>(n, "width");
  const h = tryGet<unknown>(n, "height");
  return typeof (n as unknown as Any).exportAsync === "function" && w.ok && h.ok && typeof w.value === "number" && typeof h.value === "number" && w.value > 0 && h.value > 0;
}

function visibleFills(n: NodeLikeW): Any[] | undefined {
  const f = tryGet<unknown>(n, "fills");
  if (!f.ok || !Array.isArray(f.value)) return undefined;
  return (f.value as Any[]).filter((p) => p && p.visible !== false);
}

const childrenOf = (n: NodeLikeW): readonly NodeLikeW[] => {
  const k = tryGet<readonly NodeLikeW[]>(n, "children");
  return k.ok && Array.isArray(k.value) ? k.value : [];
};

/** A styleframe as figma_create_storyboard left it: no children, and white or no fill. Nothing to show yet. */
function untouchedStyleframe(n: NodeLikeW): boolean {
  if (childrenOf(n).length > 0) return false;
  const fills = visibleFills(n);
  if (!fills) return false;
  if (fills.length === 0) return true;
  const only = fills[0]!;
  const c = only.color as { r?: number; g?: number; b?: number } | undefined;
  return fills.length === 1 && only.type === "SOLID" && !!c && c.r === 1 && c.g === 1 && c.b === 1 && (only.opacity ?? 1) === 1;
}

/** A thumbnail with nothing drawn or placed in it: at most the board's hint, and no image. */
function blankThumb(n: NodeLikeW): boolean {
  const hintOnly = childrenOf(n).every((k) => k.type === "TEXT" && /\/ Hint$/.test(k.name));
  return hintOnly && !(visibleFills(n) ?? []).some((p) => p.type === "IMAGE");
}

/** The render width that covers the plate at 1x once FILL crops it, within the image cap [C-076]. */
function coverWidth(src: { width: number; height: number }, plate: { width: number; height: number }): number {
  const scale = Math.max(plate.width / src.width, plate.height / src.height);
  return Math.max(1, Math.floor(Math.min(src.width * scale, MAX_IMAGE_SIDE, (MAX_IMAGE_SIDE * src.width) / src.height)));
}

async function rendered(figma: FigmaWrite, node: Renderable, plate: { width: number; height: number }, field: string): Promise<unknown[]> {
  const r = await renderToImage(figma, node, coverWidth(node, plate), field);
  return [{ type: "IMAGE", imageHash: r.image.hash, scaleMode: "FILL" }];
}

/**
 * The panel's best picture: its styleframe once something is drawn in it,
 * else its `source` rendered again at plate size (or its `image`), else its
 * thumbnail — rendered when something is drawn or placed there, its own fill
 * when not.
 */
async function pictureFor(figma: FigmaWrite, p: ReadPanel, plate: { width: number; height: number }): Promise<Picture> {
  const nn = String(p.index).padStart(2, "0");
  if (p.styleframeId) {
    const sf = await figma.getNodeByIdAsync(p.styleframeId);
    if (renderable(sf) && !untouchedStyleframe(sf)) return { from: "styleframe", paints: await rendered(figma, sf, plate, `panel ${nn} styleframe`) };
  }
  let note: string | undefined;
  if (p.sourceId) {
    const src = await figma.getNodeByIdAsync(p.sourceId);
    if (renderable(src)) return { from: "source", paints: await rendered(figma, src, plate, `panel ${nn} source`) };
    note = `Panel ${nn}'s source ${p.sourceId} is gone or cannot be rendered; its thumbnail stands in.`;
  }
  if (p.imageHash) {
    const getImage = (figma as unknown as { getImageByHash?: (h: string) => unknown }).getImageByHash;
    if (typeof getImage === "function" && getImage.call(figma, p.imageHash)) {
      return { from: "source", paints: [{ type: "IMAGE", imageHash: p.imageHash, scaleMode: "FILL" }] };
    }
    note = `Panel ${nn}'s image ${p.imageHash} is no longer in the file; its thumbnail stands in.`;
  }
  const thumb = await figma.getNodeByIdAsync(p.thumbId);
  if (!thumb) {
    return { from: "thumb", paints: [BLACK], blank: true, note: `Panel ${nn}'s thumbnail ${p.thumbId} is gone; its plate is black.` };
  }
  if (blankThumb(thumb) || !renderable(thumb)) {
    const fills = visibleFills(thumb);
    return { from: "thumb", paints: fills && fills.length ? fills.map((f) => ({ ...f })) : [BLACK], blank: true, ...(note ? { note } : {}) };
  }
  return { from: "thumb", paints: await rendered(figma, thumb, plate, `panel ${nn} thumbnail`), ...(note ? { note } : {}) };
}

// ── the op ───────────────────────────────────────────────────────────────────

/** One keyed layer: a plate's OPACITY, or its art's SCALE_XY with drift. */
interface Layer {
  /** The plate's position on the board, 0-based. */
  pos: number;
  index: number;
  ref: "plate" | "art";
  field: "OPACITY" | "SCALE_XY";
  keys: KeyText[];
  plan: TrackPlan;
}

interface Prepared {
  options: AnimaticOptions;
  reading: StoryboardReading & { storyboardId: string };
  plan: AnimaticPlan;
  size: { width: number; height: number };
  page: NodeLikeW;
  at: { x: number; y: number };
  texts: PanelTexts[];
  pictures: Picture[];
  layers: Layer[];
}

/** A failure after the build: what exists, and what was left undone. */
function afterBuild(err: unknown, created: Created[], step: string): never {
  throw new BridgeError(err instanceof BridgeError ? err.code : ErrorCode.INTERNAL, `The animatic was built, but ${step} failed: ${message(err)}`, {
    hint:
      `${created.length} node(s) exist (ids in partial.created). Tell the user to press Ctrl+Z to undo the whole call, ` +
      "or delete the animatic with figma_delete_nodes and run the call again.",
    partial: { created, failedAt: step },
  });
}

/** Two key lists in the string forms, equal within float noise; an easing Figma leaves out reads as LINEAR. */
function sameKeys(want: KeyframeText[], got: KeyframeText[]): boolean {
  if (want.length !== got.length) return false;
  return want.every((k, i) => {
    const g = got[i]!;
    if (Math.abs(k.t - g.t) > 1e-4) return false;
    const a = k.value.split(",").map(Number);
    const b = g.value.split(",").map(Number);
    if (a.length !== b.length || a.some((x, j) => !Number.isFinite(x) || Math.abs(x - b[j]!) > 1e-3)) return false;
    return (k.easing ?? "LINEAR") === (g.easing ?? "LINEAR");
  });
}

const createAnimatic: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const prep = await beforeMutating(async (): Promise<Prepared> => {
      const options = readAnimaticOptions(ctx.params);
      const storyboardId = reqStr(ctx.params, "storyboardId");
      // The record and the duration captions as the canvas shows them now; a
      // node that is not a board is refused here, naming it.
      const reading = await readStoryboard(storyboardId);
      const board = (await figma.getNodeByIdAsync(storyboardId)) as Motion;
      requireMotion(board);
      const texts: PanelTexts[] = [];
      for (const p of reading.panels) texts.push(await panelTexts(figma, p));
      const plan = planAnimatic(
        reading.panels.map((p, i) => ({ index: p.index, startFrame: p.startFrame, endFrame: p.endFrame, ...(texts[i]!.transition ? { transition: texts[i]!.transition } : {}) })),
        reading.fps,
        options,
      );
      // Every track is checked as figma_set_keyframes would check it, while nothing exists.
      const layers: Layer[] = [];
      plan.plates.forEach((pl, pos) => {
        layers.push({ pos, index: pl.index, ref: "plate", field: "OPACITY", keys: pl.opacity, plan: planTracks([{ field: "OPACITY", keyframes: pl.opacity }])[0]! });
        if (pl.drift) layers.push({ pos, index: pl.index, ref: "art", field: "SCALE_XY", keys: pl.drift, plan: planTracks([{ field: "SCALE_XY", keyframes: pl.drift }])[0]! });
      });
      const size = plateSize(reading.aspect, options.width);
      const page = await pageFor(figma, str(ctx.params, "pageId"), board);
      const spot = emptySpot(page);
      const at = { x: num(ctx.params, "x") ?? spot.x, y: num(ctx.params, "y") ?? spot.y };
      const pictures: Picture[] = [];
      for (const p of reading.panels) {
        if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while rendering the panels; nothing was built.");
        ctx.progress(pictures.length, reading.panels.length, "pictures");
        pictures.push(await pictureFor(figma, p, size));
        await ctx.yieldToHost();
      }
      return { options, reading, plan, size, page, at, texts, pictures, layers };
    });
    const { options, reading, plan, size, page, at, texts, pictures, layers } = prep;

    const spec = compileAnimaticSpec(
      reading.title,
      at,
      size,
      reading.panels.map((p, i) => ({
        index: p.index,
        startS: p.startS,
        restOpacity: plan.plates[i]!.restOpacity,
        slate: slateLines(options.burnIn, {
          label: texts[i]!.label,
          startS: p.startS,
          endS: p.endS,
          startFrame: p.startFrame,
          endFrame: p.endFrame,
          durationS: p.durationS,
          captions: texts[i]!.captions,
        }),
      })),
    );
    let built: { created: Created[]; nodeCount: number; refs?: Record<string, string> };
    try {
      built = (await CREATE_OPS.create_from_spec!.run({ ...ctx, params: { spec: spec.root, pageId: page.id } })) as typeof built;
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      throw new BridgeError(err.code, `Building the animatic failed: ${err.message}`, {
        hint: `${err.hint ? `${err.hint} ` : ""}(The spec paths are the animatic's internal layout.)`,
        partial: err.partial,
      });
    }
    const created = built.created;
    const refs = built.refs ?? {};
    const idOf = (ref: string): string => {
      const id = refs[ref];
      if (!id) afterBuild(new Error(`the builder returned no node for "${ref}"`), created, "mapping the plates");
      return id;
    };
    const animaticId = idOf(spec.refs.root);
    const ids = spec.refs.plates.map((r) => ({ plate: idOf(r.plate), art: idOf(r.art), ...(r.slate ? { slate: idOf(r.slate) } : {}) }));

    try {
      for (let i = 0; i < ids.length; i++) {
        const art = await figma.getNodeByIdAsync(ids[i]!.art);
        if (!art) throw new Error(`plate ${i + 1}'s art ${ids[i]!.art} is gone`);
        (art as unknown as Any).fills = pictures[i]!.paints;
      }
    } catch (err) {
      afterBuild(err, created, "placing the pictures");
    }

    // One track per layer, written alone and read back before the next.
    const layerId = (l: Layer) => ids[l.pos]![l.ref];
    const notApplied: Array<{ index?: number; layerId: string; field: string; keyframes?: KeyText[] }> = [];
    let rewritten = 0;
    let live: Motion | undefined;
    for (let n = 0; n < layers.length; n++) {
      const l = layers[n]!;
      const id = layerId(l);
      const step = `keying panel ${l.index}'s ${l.field}`;
      ctx.progress(n, layers.length, "keyframes");
      try {
        const handle = (await figma.getNodeByIdAsync(id)) as Motion | null;
        if (!handle) throw new BridgeError(ErrorCode.INTERNAL, `\`${id}\` stopped resolving right after the build.`, { hint: TEMPORARY_ID_HINT });
        try {
          handle.applyManualKeyframeTrack!(l.plan.field, { keyframes: l.plan.keyframes });
        } catch (err) {
          if (GATED.test(message(err))) throw noMotion(message(err));
          throw err;
        }
        const settled = await verifyTracks(ctx, id, [l.plan], new Map([[l.plan.text, []]]));
        live = settled.live;
        if ((settled.attempts.get(l.plan.text) ?? 1) > 1) rewritten++;
        if (settled.missing.length > 0) notApplied.push({ index: l.index, layerId: id, field: l.field, keyframes: l.keys });
      } catch (err) {
        afterBuild(err, created, step);
      }
    }
    ctx.progress(layers.length, layers.length, "keyframes");

    // The duration last, on the timeline the settled handle reports [C-182].
    const notes: string[] = [];
    let timeline: { id: string; duration: number } | undefined;
    try {
      const tl = live ? timelineOf(live) : undefined;
      if (tl) {
        if (Math.abs(tl.duration - plan.timelineS) > 1e-6) live!.setTimelineDuration!(tl.id, plan.timelineS);
      } else {
        notes.push("Figma reported no timeline for the plates, so the duration was not set.");
      }
    } catch (err) {
      afterBuild(err, created, "setting the timeline duration");
    }

    // Then every track once more, each through a new handle, and the rest opacities.
    const restOff: number[] = [];
    try {
      for (const l of layers) {
        const id = layerId(l);
        if (notApplied.some((x) => x.layerId === id && x.field === l.field)) continue;
        const fresh = (await figma.getNodeByIdAsync(id)) as Motion | null;
        const got = fresh ? keyframesToText(bindingAt(motionRead(fresh, "manualKeyframeTracks"), l.plan.field)?.keyframes) : [];
        if (!sameKeys(keyframesToText(l.plan.keyframes), got)) notApplied.push({ index: l.index, layerId: id, field: l.field, keyframes: l.keys });
        if (fresh && l.field === "OPACITY") {
          const o = tryGet<unknown>(fresh, "opacity");
          if (o.ok && typeof o.value === "number" && Math.abs(o.value - plan.plates[l.pos]!.restOpacity) > 1e-3) restOff.push(l.index);
        }
      }
      const root = (await figma.getNodeByIdAsync(ids[0]!.plate)) as Motion | null;
      timeline = root ? timelineOf(root) : undefined;
      if (timeline && Math.abs(timeline.duration - plan.timelineS) > 1e-4) notApplied.push({ layerId: animaticId, field: "timelineDuration" });
    } catch (err) {
      afterBuild(err, created, "reading the tracks back");
    }

    const verified = notApplied.length === 0;
    if (rewritten > 0) notes.push(`Figma dropped ${rewritten} track(s) on the first write; they were written again and read back.`);
    if (restOff.length) notes.push(`Figma rests panel(s) ${restOff.join(", ")} at an opacity other than planned; figma_export_node may show them.`);
    for (const p of pictures) if (p.note) notes.push(p.note);
    if (reading.captionConflicts.length) {
      notes.push(`Duration caption(s) of panel(s) ${reading.captionConflicts.map((c) => c.index).join(", ")} did not parse; the planned durations stood in.`);
    }
    const { render, renderNote } = renderCall(animaticId, reading.title, plan.fps, size.width);
    if (renderNote) notes.push(renderNote);
    const blank = reading.panels.filter((_, i) => pictures[i]!.blank).map((p) => p.index);
    notes.unshift(
      `${plan.plates.length > 1 ? `Panels 2–${plan.plates.length} rest at opacity 0; figma_export_node shows panel 1 only.` : "One panel: the animatic holds it for its length."} ` +
        `The timeline runs ${round4(plan.timelineS)} s, just short of frame ${plan.expectedFrames - 1}, because the end frame renders too, so the render holds exactly ${plan.expectedFrames} frames. ` +
        "Render it, then judge the pace with figma_review_video on the file.",
    );

    return {
      animaticId,
      storyboardId: reading.storyboardId,
      title: reading.title,
      aspect: reading.aspect,
      width: size.width,
      height: size.height,
      fps: plan.fps,
      durationS: plan.durationS,
      timelineS: round4(plan.timelineS),
      expectedFrames: plan.expectedFrames,
      panels: plan.plates.map((pl, i) => ({
        index: pl.index,
        layerId: ids[i]!.plate,
        artId: ids[i]!.art,
        ...(ids[i]!.slate ? { slateId: ids[i]!.slate } : {}),
        inFrame: pl.inFrame,
        outFrame: pl.outFrame,
        ...(pl.lastFrame !== pl.outFrame - 1 ? { lastFrame: pl.lastFrame } : {}),
        ...(pl.dissolveIn ? { dissolveIn: pl.dissolveIn } : {}),
        image: pictures[i]!.from,
        ...(pictures[i]!.blank ? { blank: true } : {}),
      })),
      ...(plan.dissolves.length ? { dissolves: plan.dissolves } : {}),
      ...(blank.length ? { blank } : {}),
      ...(reading.captionConflicts.length ? { captionConflicts: reading.captionConflicts } : {}),
      verified,
      ...(verified
        ? {}
        : {
            notApplied,
            hint:
              "Figma did not keep these. Send each track alone with figma_set_keyframes { nodeId: layerId, tracks: [{ field, keyframes }] } " +
              "(a timelineDuration entry: figma_set_keyframes { nodeId: a plate's layerId, timelineDuration }), then read it back with figma_get_motion_context.",
          }),
      ...(timeline ? { timeline: { id: timeline.id, duration: round4(timeline.duration) } } : {}),
      ...(timeline && timeline.id !== animaticId
        ? {
            timelineNote:
              `Figma reports the animatic's timeline as ${timeline.id}, not the frame's own id ${animaticId}. Inside an animated frame Figma can ` +
              "list layers under temporary ids for a while: keep addressing layers by the ids this call returned.",
          }
        : {}),
      render,
      created: [animaticId],
      nodeCount: built.nodeCount,
      note: notes.join(" "),
    };
  },
};

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Wired into PLUGIN_OPS by the integrator (src/plugin/ops/index.ts). */
export const ANIMATIC_OPS: Record<string, PluginOp> = {
  create_animatic: createAnimatic,
};
