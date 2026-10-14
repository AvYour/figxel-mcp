// figma_create_storyboard in the plugin: plan, render the snapshots, build the
// board as ONE create_from_spec call, fill the snapshot thumbnails, then write
// the record. Every check and every render runs before the first node exists,
// so a refusal provably changed nothing (`created: []`); the runner commits
// one undo step for the whole board.
//
// The planner (shared/storyboard.ts) owns the numbers and the spec; this file
// owns what needs Figma: the page, an empty spot on it, the file's text
// styles, the snapshots, and the record [C-188]. readStoryboard reads a board
// back for the tools that consume one.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import {
  compileStoryboardSpec,
  matchTextStyles,
  parseStoryboardRecord,
  planStoryboard,
  readStoryboardTiming,
  storyboardRecord,
  STORYBOARD_KEY,
  STORYBOARD_NAMESPACE,
  type Caption,
  type StoryboardPlan,
  type StoryboardReading,
  type TextRole,
  type TextStyleInfo,
} from "../../shared/storyboard.js";
import { beforeMutating } from "../guard.js";
import { str } from "../read.js";
import { tryGet } from "../safe.js";
import { num, parentFor, type FigmaWrite, type NodeLikeW } from "../write.js";
import { MAX_IMAGE_SIDE, renderSource, renderToImage } from "./assets.js";
import { CREATE_OPS, type Created } from "./create.js";
import type { OpContext, PluginOp } from "./index.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;
type Any = Record<string, unknown>;

/** How far right of everything on the page a board starts when no x is given. */
const CLEARANCE = 400;

type Box = { x: number; y: number; width: number; height: number };

function boxOf(n: NodeLikeW): Box | undefined {
  const abs = tryGet<Box | null>(n, "absoluteBoundingBox");
  if (abs.ok && abs.value && typeof abs.value.x === "number" && typeof abs.value.width === "number") return abs.value;
  const read = (k: string) => {
    const v = tryGet<unknown>(n, k);
    return v.ok && typeof v.value === "number" ? v.value : undefined;
  };
  const [x, y, width, height] = [read("x"), read("y"), read("width"), read("height")];
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined ? { x, y, width, height } : undefined;
}

/** To the right of everything on the page, level with its top: a spot nobody's work is in. */
export function emptySpot(page: NodeLikeW): { x: number; y: number } {
  const kids = tryGet<readonly NodeLikeW[]>(page, "children");
  let right = -Infinity;
  let top = Infinity;
  for (const k of kids.ok && Array.isArray(kids.value) ? kids.value : []) {
    const b = boxOf(k);
    if (!b) continue;
    right = Math.max(right, b.x + b.width);
    top = Math.min(top, b.y);
  }
  return Number.isFinite(right) ? { x: Math.round(right + CLEARANCE), y: Math.round(top) } : { x: 0, y: 0 };
}

async function pageFor(figma: FigmaWrite, pageId: string | undefined): Promise<NodeLikeW> {
  if (!pageId) return figma.currentPage;
  // parentFor loads a page other than the current one before it is read.
  const page = await parentFor(figma, pageId);
  if (page.type !== "PAGE" && page.type !== "PAGE_NODE") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`pageId\` \`${pageId}\` is a ${page.type}, not a page.`, {
      hint: "A storyboard is a top-level board: give a page id, or leave pageId out for the current page.",
    });
  }
  return page;
}

/**
 * The file's own text style per role, when it has one that fits
 * (matchTextStyles). A style whose font will not load is dropped here, while
 * nothing exists: applying it half-way through the build would fail there.
 */
async function fileTextStyles(figma: FigmaWrite): Promise<Partial<Record<TextRole, TextStyleInfo>>> {
  const read = figma.getLocalTextStylesAsync as (() => Promise<ReadonlyArray<Any>>) | undefined;
  if (typeof read !== "function") return {};
  let styles: ReadonlyArray<Any>;
  try {
    styles = await read.call(figma);
  } catch {
    return {};
  }
  const info: TextStyleInfo[] = [];
  for (const s of styles) {
    const font = s.fontName as { family?: unknown; style?: unknown } | undefined;
    if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.fontSize !== "number") continue;
    if (!font || typeof font !== "object" || typeof font.family !== "string" || typeof font.style !== "string") continue;
    info.push({ id: s.id, name: s.name, fontSize: s.fontSize, fontName: { family: font.family, style: font.style } });
  }
  const matched = matchTextStyles(info);
  for (const role of Object.keys(matched) as TextRole[]) {
    try {
      await figma.loadFontAsync(matched[role]!.fontName);
    } catch {
      delete matched[role];
    }
  }
  return matched;
}

/** The width that covers a thumbnail at twice its size once FILL crops it, within the image cap [C-076]. */
function snapshotWidth(source: { width: number; height: number }, plan: StoryboardPlan): number {
  const scale = Math.max((2 * plan.thumbWidth) / source.width, (2 * plan.thumbHeight) / source.height);
  return Math.max(1, Math.floor(Math.min(source.width * scale, MAX_IMAGE_SIDE, (MAX_IMAGE_SIDE * source.width) / source.height)));
}

interface Prepared {
  plan: StoryboardPlan;
  page: NodeLikeW;
  at: { x: number; y: number };
  styles: Partial<Record<TextRole, TextStyleInfo>>;
  /** By panel index: the image hash its thumbnail takes, and where it came from. */
  fills: Map<number, { hash: string; from: "source" | "image" }>;
}

interface Built {
  created: Created[];
  nodeCount: number;
  refs?: Record<string, string>;
}

/** A failure after the build: what exists, and what was left undone. */
function afterBuild(err: unknown, created: Created[], step: string): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new BridgeError(err instanceof BridgeError ? err.code : ErrorCode.INTERNAL, `The board was built, but ${step} failed: ${message}`, {
    hint:
      `${created.length} node(s) exist (ids in partial.created). Tell the user to press Ctrl+Z to undo the whole call, ` +
      "or delete the board with figma_delete_nodes and run the call again.",
    partial: { created, failedAt: step },
  });
}

const createStoryboard: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const prep = await beforeMutating(async (): Promise<Prepared> => {
      const plan = planStoryboard(ctx.params);
      const page = await pageFor(figma, str(ctx.params, "pageId"));
      const spot = emptySpot(page);
      const at = { x: num(ctx.params, "x") ?? spot.x, y: num(ctx.params, "y") ?? spot.y };
      const fills = new Map<number, { hash: string; from: "source" | "image" }>();
      // Hashes and sources are checked before any render, so a typo in panel 9
      // does not cost eight renders first.
      const getImage = (figma as unknown as { getImageByHash?: (h: string) => unknown }).getImageByHash;
      const sources = new Map<number, Awaited<ReturnType<typeof renderSource>>>();
      for (const p of plan.panels) {
        const field = `panels[${p.index - 1}]`;
        if (p.image !== undefined) {
          if (typeof getImage !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `\`${field}.image\`: this editor cannot look images up by hash.`);
          if (!getImage.call(figma, p.image)) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.image\`: no image with hash \`${p.image}\` in this file.`, {
              hint: "Use an imageHash figma_import_image or figma_get_design_context reported, or `source` to snapshot a frame.",
            });
          }
          fills.set(p.index, { hash: p.image, from: "image" });
        }
        if (p.source !== undefined) sources.set(p.index, await renderSource(figma, p.source, `${field}.source`));
      }
      let done = 0;
      for (const [index, source] of sources) {
        if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while rendering the snapshots; nothing was built.");
        ctx.progress(done, sources.size, "snapshots");
        const r = await renderToImage(figma, source, snapshotWidth(source, plan), `panels[${index - 1}].source`);
        fills.set(index, { hash: r.image.hash, from: "source" });
        done++;
        await ctx.yieldToHost();
      }
      return { plan, page, at, styles: await fileTextStyles(figma), fills };
    });
    const { plan, page, at, styles, fills } = prep;

    const styleIds: Partial<Record<TextRole, string>> = {};
    for (const role of Object.keys(styles) as TextRole[]) styleIds[role] = styles[role]!.id;
    const spec = compileStoryboardSpec(plan, at, styleIds);
    let built: Built;
    try {
      built = (await CREATE_OPS.create_from_spec!.run({ ...ctx, params: { spec: spec.roots, pageId: page.id } })) as Built;
    } catch (err) {
      // The builder's own report stands: partial.created and failedAt name what
      // exists. Its spec paths are this tool's, so say whose they are.
      if (!(err instanceof BridgeError)) throw err;
      throw new BridgeError(err.code, `Building the storyboard failed: ${err.message}`, {
        hint: `${err.hint ? `${err.hint} ` : ""}(The spec paths are the board's internal layout.)`,
        partial: err.partial,
      });
    }
    const created = built.created;
    const refs = built.refs ?? {};
    const idOf = (ref: string): string => {
      const id = refs[ref];
      if (!id) afterBuild(new Error(`the builder returned no node for "${ref}"`), created, "mapping the panels");
      return id;
    };
    const boardId = idOf(spec.board);
    const panels = spec.panels.map((r) => ({
      id: idOf(r.card),
      thumbId: idOf(r.thumb),
      ...(r.hint ? { hintId: idOf(r.hint) } : {}),
      captionIds: Object.fromEntries(Object.entries(r.captions).map(([c, ref]) => [c, idOf(ref!)])) as Partial<Record<Caption, string>>,
      ...(r.styleframe ? { styleframeId: idOf(r.styleframe) } : {}),
    }));

    try {
      for (const [index, fill] of fills) {
        const thumb = await figma.getNodeByIdAsync(panels[index - 1]!.thumbId);
        if (!thumb) throw new Error(`thumbnail ${panels[index - 1]!.thumbId} is gone`);
        (thumb as unknown as Any).fills = [{ type: "IMAGE", imageHash: fill.hash, scaleMode: "FILL" }];
      }
    } catch (err) {
      afterBuild(err, created, "filling the snapshot thumbnails");
    }
    try {
      const board = await figma.getNodeByIdAsync(boardId);
      const write = (board as unknown as { setSharedPluginData?: (ns: string, key: string, value: string) => void } | null)?.setSharedPluginData;
      if (!board || typeof write !== "function") throw new Error("the board takes no shared plugin data");
      const record = storyboardRecord(plan, {
        panels: panels.map(({ id, thumbId, captionIds, styleframeId }) => ({ id, thumbId, captionIds, ...(styleframeId ? { styleframeId } : {}) })),
      });
      write.call(board, STORYBOARD_NAMESPACE, STORYBOARD_KEY, JSON.stringify(record));
    } catch (err) {
      afterBuild(err, created, "writing the storyboard record");
    }

    const usedStyles = Object.keys(styles) as TextRole[];
    return {
      storyboardId: boardId,
      title: plan.title,
      aspect: plan.aspect,
      fps: plan.fps,
      ...(plan.bpm !== undefined ? { bpm: plan.bpm, beatsPerBar: plan.beatsPerBar } : {}),
      snap: plan.snap,
      durationS: plan.durationS,
      durationFrames: plan.durationFrames,
      panels: plan.panels.map((p, i) => {
        const ids = panels[i]!;
        const fill = fills.get(p.index);
        return {
          index: p.index,
          id: ids.id,
          thumbId: ids.thumbId,
          ...(ids.hintId ? { hintId: ids.hintId } : {}),
          captionIds: ids.captionIds,
          durationS: p.durationS,
          startS: p.startS,
          endS: p.endS,
          startFrame: p.startFrame,
          endFrame: p.endFrame,
          ...(p.bar ? { bar: p.bar } : {}),
          words: p.words,
          readOk: p.readOk,
          ...(fill ? { image: fill.from } : {}),
          ...(ids.styleframeId ? { styleframeId: ids.styleframeId } : {}),
        };
      }),
      offBeat: plan.offBeat,
      snapped: plan.snapped,
      readTime: plan.readTime,
      ...(plan.tempoNote ? { tempoNote: plan.tempoNote } : {}),
      ...(usedStyles.length ? { textStyles: Object.fromEntries(usedStyles.map((r) => [r, styles[r]!.name])) } : {}),
      // The top-level nodes: deleting them removes everything the call made.
      created: [boardId, ...panels.flatMap((p) => (p.styleframeId ? [p.styleframeId] : []))],
      nodeCount: built.nodeCount,
      note:
        "Frames run [startFrame, endFrame). A thumbnail has no auto-layout: sketch into it with figma_create_from_spec " +
        "{ parentId: thumbId } and x/y, then delete its hintId. figma_import_image { renderNodeId, nodeId: thumbId } " +
        "snapshots a styleframe into it.",
    };
  },
};

/**
 * Read a board back: its record, then each panel's duration caption as the
 * canvas shows it now — so an edited "2 s" retimes the panel. A caption that
 * is gone is tolerated (the planned value stands in); one that no longer
 * parses is reported as a captionConflict.
 */
export async function readStoryboard(storyboardId: string): Promise<StoryboardReading & { storyboardId: string }> {
  const figma = api();
  const node = await figma.getNodeByIdAsync(storyboardId);
  if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${storyboardId}\`.`);
  const get = (node as unknown as { getSharedPluginData?: (ns: string, key: string) => string }).getSharedPluginData;
  const raw = typeof get === "function" ? String(get.call(node, STORYBOARD_NAMESPACE, STORYBOARD_KEY) ?? "") : "";
  const record = parseStoryboardRecord(raw, storyboardId);
  const texts: Array<string | undefined> = [];
  for (const p of record.panels) {
    const id = p.captionIds.duration;
    const caption = id ? await figma.getNodeByIdAsync(id) : null;
    const chars = caption ? tryGet<unknown>(caption, "characters") : undefined;
    texts.push(chars?.ok && typeof chars.value === "string" ? chars.value : undefined);
  }
  return { storyboardId, ...readStoryboardTiming(record, texts) };
}

export const STORYBOARD_OPS: Record<string, PluginOp> = {
  create_storyboard: createStoryboard,
};
