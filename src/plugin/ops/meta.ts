// The meta group's plugin-backed tools (tools.md § meta): select, navigate to
// a page, zoom the viewport. They change what the user SEES, not the document,
// so they are not write ops — no commitUndo, nothing to undo.
//
// API per @figma/plugin-typings 1.141.0: PageNode.selection,
// figma.setCurrentPageAsync(page) (the currentPage setter throws under
// documentAccess "dynamic-page"), figma.viewport.scrollAndZoomIntoView(nodes)
// and figma.viewport.zoom. In Figma Slides, zoom_to also sets the focused
// slide and the grid / single-slide view — view state, not document data.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { str, strList } from "../read.js";
import { resolveAll, type ItemResult } from "./modify.js";
import type { NodeLikeW } from "../write.js";
import { editorType } from "../safe.js";
import { focusedSlideId, readView, setView } from "../slides/grid.js";

interface FigmaMeta {
  currentPage: NodeLikeW & { selection: readonly NodeLikeW[] };
  root: { children: readonly NodeLikeW[] };
  setCurrentPageAsync(page: NodeLikeW): Promise<void>;
  viewport: { zoom: number; scrollAndZoomIntoView(nodes: readonly NodeLikeW[]): void };
}

const api = () => (globalThis as unknown as { figma: FigmaMeta }).figma;

/** `nodeId` or `nodeIds` — tools.md gives both forms. None only where the caller allows it. */
function idsOf(ctx: OpContext, optional = false): string[] {
  const many = strList(ctx.params, "nodeIds");
  const one = str(ctx.params, "nodeId");
  const ids = [...(one ? [one] : []), ...(many ?? [])];
  if (!ids.length && !optional) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `nodeId` or `nodeIds`.");
  return ids;
}

/** The page a node lives on. */
function pageOf(node: NodeLikeW): NodeLikeW | null {
  let n: NodeLikeW | null | undefined = node;
  while (n && n.type !== "PAGE") n = n.parent;
  return n ?? null;
}

/**
 * Resolve ids and keep only nodes on ONE page — Figma can only select and show
 * what is on the current page. If they all sit on another page, switch to it
 * first, so the user sees what the agent means.
 */
async function onePage(ids: string[]): Promise<{ nodes: NodeLikeW[]; items: ItemResult[]; page: NodeLikeW | null; switched: boolean }> {
  const items: ItemResult[] = [];
  const found: NodeLikeW[] = [];
  for (const { id, node } of await resolveAll(ids)) {
    if (!node) items.push({ id, ok: false, error: "not found" });
    else if (node.type === "PAGE" || node.type === "DOCUMENT") items.push({ id, ok: false, error: `a ${node.type} cannot be selected` });
    else found.push(node);
  }
  const figma = api();
  const target = found.length ? pageOf(found[0]!) : null;
  let switched = false;
  if (target && target.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(target);
    switched = true;
  }
  const nodes: NodeLikeW[] = [];
  for (const n of found) {
    if (target && pageOf(n)?.id !== target.id) items.push({ id: n.id, ok: false, error: "on a different page from the first node" });
    else {
      nodes.push(n);
      items.push({ id: n.id, ok: true });
    }
  }
  return { nodes, items, page: target, switched };
}

const select: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const mode = (str(ctx.params, "mode") ?? "replace").toLowerCase();
    if (!["replace", "add", "toggle"].includes(mode)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`mode` must be replace, add or toggle.");
    const { nodes, items, page, switched } = await onePage(idsOf(ctx));
    const figma = api();
    // A page switch empties the selection we would add to, so "add" then means "replace".
    const current = switched ? [] : [...figma.currentPage.selection];
    let next: NodeLikeW[];
    if (mode === "replace") next = nodes;
    else if (mode === "add") next = [...current, ...nodes.filter((n) => !current.some((c) => c.id === n.id))];
    else {
      const ids = new Set(nodes.map((n) => n.id));
      next = [...current.filter((c) => !ids.has(c.id)), ...nodes.filter((n) => !current.some((c) => c.id === n.id))];
    }
    figma.currentPage.selection = next;
    return {
      selected: next.map((n) => n.id),
      ...(page ? { page: { id: page.id, name: page.name } } : {}),
      ...(switched ? { switchedPage: true } : {}),
      items,
    };
  },
};

const navigatePage: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const figma = api();
    const id = str(ctx.params, "pageId");
    const name = str(ctx.params, "pageName");
    if (!id && !name) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `pageId` or `pageName`.");
    const pages = figma.root.children;
    const page = pages.find((p) => (id ? p.id === id : p.name === name));
    if (!page) {
      throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No page ${id ? `with id \`${id}\`` : `named "${name}"`}.`, {
        hint: `Pages: ${pages.map((p) => `${p.name} (${p.id})`).join(", ")}.`,
      });
    }
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },
};

/**
 * The slide to focus for these nodes: a SLIDE among them, else the slide that
 * holds the first one — so zooming to a title on slide 3 shows slide 3 in
 * single-slide view. Null outside a deck.
 */
function slideFor(nodes: readonly NodeLikeW[]): NodeLikeW | null {
  const own = nodes.find((n) => n.type === "SLIDE");
  if (own) return own;
  let n: NodeLikeW | null | undefined = nodes[0]?.parent;
  while (n && n.type !== "SLIDE" && n.type !== "PAGE") n = n.parent;
  return n?.type === "SLIDE" ? n : null;
}

/**
 * Make `slide` the focused slide (PageNode.focusedSlide, d.ts:10737) [C-134] —
 * the one Single Slide View shows, and where Figma puts a node created there
 * without a parent (d.ts:3351-3356). A setter that throws is reported, not fatal.
 */
function focusSlide(slide: NodeLikeW): string | undefined {
  try {
    (api().currentPage as unknown as { focusedSlide: unknown }).focusedSlide = slide;
    return undefined;
  } catch (err) {
    return `focusedSlide could not be set: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const zoomTo: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const raw = ctx.params.zoom;
    let zoom: number | undefined;
    if (raw !== undefined && raw !== "fit") {
      zoom = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isFinite(zoom) || zoom <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, '`zoom` must be "fit" or a number > 0 (1 = 100%).');
    }
    const view = ctx.params.view;
    if (view !== undefined) {
      if (view !== "grid" && view !== "single-slide") throw new BridgeError(ErrorCode.INVALID_PARAM, '`view` must be "grid" or "single-slide".');
      if (editorType() !== "slides") {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `\`view\` switches a Figma Slides file between the grid and one slide; this file's editorType is "${editorType() ?? "unknown"}".`, {
          hint: "Leave `view` out here; figma_status shows each connected file's editor.",
        });
      }
    }
    const ids = idsOf(ctx, view !== undefined);
    const figma = api();
    let shown: Awaited<ReturnType<typeof onePage>> | undefined;
    if (ids.length) {
      shown = await onePage(ids);
      if (!shown.nodes.length) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, "None of the given nodes can be shown.");
      figma.viewport.scrollAndZoomIntoView(shown.nodes);
    }
    if (zoom !== undefined) figma.viewport.zoom = zoom;
    // Slides: the nodes' slide becomes the focused one, then the view switches
    // — so "single-slide" shows that slide.
    const slide = shown ? (slideFor(shown.nodes) ?? undefined) : undefined;
    const notes: string[] = [];
    if (slide) {
      const failed = focusSlide(slide);
      if (failed) notes.push(failed);
    }
    // The property that took the write is the one to report: another spelling
    // may still read its own, stale value [C-140].
    let viewProperty: string | undefined;
    if (view !== undefined) {
      const set = setView(view);
      if (set.ok) viewProperty = set.via;
      else notes.push(`No view property took "${view}"${set.tried.length ? ` (${set.tried.join("; ")})` : " (none of canvasView, slidesView, slidesMode exists here)"}.`);
    }
    const slides = slide !== undefined || view !== undefined;
    return {
      zoom: figma.viewport.zoom,
      ...(shown?.page ? { page: { id: shown.page.id, name: shown.page.name } } : {}),
      ...(shown?.switched ? { switchedPage: true } : {}),
      items: shown?.items ?? [],
      ...(slides ? { focusedSlideId: focusedSlideId(), view: viewProperty ? view : (readView()?.view ?? null) } : {}),
      ...(viewProperty ? { viewProperty } : {}),
      ...(notes.length ? { viewNote: notes.join(" ") } : {}),
    };
  },
};

export const META_OPS: Record<string, PluginOp> = {
  select,
  navigate_page: navigatePage,
  zoom_to: zoomTo,
};
