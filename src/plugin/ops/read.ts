// The read group (spec §12 phase 1, tools.md § read).
//
// Every op returns a NORMALIZED DTO, never raw Figma JSON: raw nodes carry
// fields the model does not need (and a few it must not see, like unloaded
// async asset refs). Depth, child counts and result sizes are all bounded, and
// anything truncated says so and returns a cursor.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import {
  MAX_TABLE_CELLS,
  TEXT_SCAN_TYPES,
  contentHit,
  deckOutline,
  deckView,
  field,
  sublayerOf,
  tableHolders,
  textItems,
  type TextItem,
} from "../board-read.js";
import { buildContext, decodeFrontier, encodeFrontier, MAX_TEXT_CHARS, type ContextOptions } from "../context.js";
import { hex, isMixed, overflowText } from "../dialect.js";
import { fontIndex, type FontFamily, type FontIndex, type FontLister } from "../font-index.js";
import { ensureLoaded } from "../pages.js";
import { tryGet } from "../safe.js";
import { listStyles, variableDefs } from "./tokens.js";
import {
  bool,
  byId,
  collect,
  decodeCursor,
  encodeCursor,
  int,
  lookUp,
  pagesOf,
  reqStr,
  selectionOf,
  str,
  strList,
  toDto,
  walk,
  type FigmaLike,
  type NodeDto,
  type NodeLike,
} from "../read.js";

// The plugin's `figma` global, narrowed. `PLUGIN_OPS` is built inside the
// sandbox, so the global is available at call time — this cast is the only
// place the loose global is trusted.
const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;

const DEFAULTS = {
  // A screen is typically 4–8 levels deep (screen → section → row → item → text);
  // 2 levels showed an agent the section names and nothing it could build from.
  contextDepth: 8,
  contextNodes: 500,
  depth: 2,
  maxNodes: 2000,
  maxChildrenPerNode: 50,
  searchLimit: 50,
  scanLimit: 200,
  textLimit: 500,
  reactionLimit: 200,
  /** figma_get_node format "rest": past this many characters the JSON is cut. */
  restChars: 200 * 1024,
} as const;

function bounded(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  return int(params, key, fallback, max);
}

type From = "node" | "selection" | "page" | "focusedSlide";

interface Scope {
  root: NodeLike;
  from: From;
  note?: string;
}

const isSlides = () => field((api() as unknown as Record<string, unknown>) ?? {}, "editorType") === "slides";

/**
 * The slide on screen in a deck (PageNode.focusedSlide, Slides only [C-134]),
 * or undefined. A deck's page is SLIDE_GRID → rows → every slide, so a no-node
 * read in Slides starts at the slide the user is looking at, not the deck.
 */
function focusedSlide(): NodeLike | undefined {
  if (!isSlides()) return undefined;
  const got = tryGet<NodeLike | null>(api().currentPage, "focusedSlide");
  return got.ok && got.value && got.value.type === "SLIDE" ? got.value : undefined;
}

/**
 * Where a no-nodeId read starts: the one selected layer, else (in a deck) the
 * focused slide, else the page. Several selected layers fall back like no
 * selection — and the result says so, instead of a page-wide answer passing
 * for "what I selected".
 */
async function scopeRoot(params: Record<string, unknown>): Promise<Scope> {
  const explicit = str(params, "nodeId");
  if (explicit) return { root: await byId(api(), explicit), from: "node" };
  const f = api();
  const sel = selectionOf(f);
  if (sel.length === 1) return { root: sel[0]!, from: "selection" };
  const several = sel.length > 1 ? `${sel.length} layers are selected, so this read covers ` : undefined;
  const slide = focusedSlide();
  if (slide) {
    const note = `${several ?? "Nothing is selected, so this read covers "}the focused slide "${slide.name}". Pass nodeId (the page id for the whole deck) to read something else.`;
    return { root: slide, from: "focusedSlide", note };
  }
  const note = several ? `${several}the whole page. Pass nodeId to read one of them.` : undefined;
  return { root: f.currentPage, from: "page", ...(note ? { note } : {}) };
}

/** What a read actually covered — reported with every scoped result. */
const scopeOf = (s: Scope) => ({ id: s.root.id, name: s.root.name, type: s.root.type, from: s.from });

/** The page a node sits on (itself, for a page). */
function pageOf(node: NodeLike): NodeLike | undefined {
  let n: NodeLike | null | undefined = node;
  while (n && n.type !== "PAGE") n = n.parent;
  return n ?? undefined;
}

function isInside(node: NodeLike, root: NodeLike): boolean {
  for (let n: NodeLike | null | undefined = node; n; n = n.parent) if (n === root || n.id === root.id) return true;
  return false;
}

// ── meta/read: file ──────────────────────────────────────────────────────────

/** Nodes a board outline counts before it stops; a walk is cheap, this bounds a pathological board. */
const OUTLINE_NODES = 50_000;

/**
 * A board at a glance: its top-level sections and how many of each node type
 * it holds. The official server has no metadata read for FigJam
 * (figma-use-figjam/SKILL.md:20) [C-153]; this is the outline its get_figjam gives.
 */
async function boardOutline(page: NodeLike, ctx: OpContext) {
  const sections = (page.children ?? [])
    .filter((c) => c.type === "SECTION")
    .map((s) => ({ id: s.id, name: s.name, childCount: (s.children ?? []).length }));
  const counts: Record<string, number> = {};
  let seen = 0;
  await walk(
    page,
    (n) => {
      if (n === page) return;
      if (++seen > OUTLINE_NODES) return false;
      counts[n.type] = (counts[n.type] ?? 0) + 1;
    },
    ctx,
  );
  return { sections, counts, ...(seen > OUTLINE_NODES ? { countsNote: `Counted the first ${OUTLINE_NODES} nodes only.` } : {}) };
}

const getMetadata: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const f = api() as unknown as {
      root: { name: string; children?: readonly NodeLike[] };
      apiVersion: string;
      editorType: string;
      currentPage: NodeLike;
    };
    const pages = pagesOf(f as unknown as FigmaLike);
    let outline: Record<string, unknown> = {};
    if (f.editorType === "figjam") outline = { board: await boardOutline(f.currentPage, ctx) };
    else if (f.editorType === "slides") {
      // A deck has no other read on the official side either (figma-use/SKILL.md:90) [C-153].
      const deck = deckOutline(f.currentPage);
      const slide = focusedSlide();
      const viewport = tryGet(f, "viewport");
      const view = deckView(viewport.ok ? viewport.value : undefined);
      outline = {
        slides: {
          rowCount: deck.rowCount,
          slideCount: deck.slideCount,
          rows: deck.rows,
          focusedSlideId: slide?.id ?? null,
          ...(view ? { view: view.view, viewProperty: view.property } : {}),
        },
      };
    }
    return {
      name: f.root.name,
      apiVersion: f.apiVersion,
      editorType: f.editorType,
      pageCount: pages.length,
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
      currentPage: { id: f.currentPage.id, name: f.currentPage.name },
      ...outline,
      note: "`fileKey` is not included: this plugin's manifest does not set enablePrivatePluginApi, so figma.fileKey is null by design.",
    };
  },
};

const getPages: PluginOp = {
  write: false,
  async run() {
    const f = api() as unknown as { currentPage: NodeLike };
    return { pages: pagesOf(api()).map((p) => ({ id: p.id, name: p.name, current: p.id === f.currentPage.id })) };
  },
};

// ── read: nodes ──────────────────────────────────────────────────────────────

type Exportable = { exportAsync(settings: Record<string, unknown>): Promise<unknown> };

const getNode: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const id = reqStr(ctx.params, "nodeId");
    const depth = bounded(ctx.params, "depth", 1, 8);
    const includeGeometry = bool(ctx.params, "includeGeometry", true);
    const format = str(ctx.params, "format") ?? "dto";
    if (format !== "dto" && format !== "rest") throw new BridgeError(ErrorCode.INVALID_PARAM, '`format` must be "dto" or "rest".');
    const node = await byId(api(), id);
    if (format === "rest") {
      // Figma's own REST shape of the subtree — every field, for what the DTO leaves out.
      if (typeof (node as Partial<Exportable>).exportAsync !== "function") {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${node.type} has no REST form — pick a layer inside it.`);
      }
      const json = await (node as unknown as Exportable).exportAsync({ format: "JSON_REST_V1" });
      const text = JSON.stringify(json) ?? "null";
      if (text.length <= DEFAULTS.restChars) return { nodeId: node.id, format, chars: text.length, truncated: false, rest: json };
      return {
        nodeId: node.id,
        format,
        chars: text.length,
        truncated: true,
        restText: text.slice(0, DEFAULTS.restChars),
        note: `The REST JSON is ${text.length} characters; the first ${DEFAULTS.restChars} are in restText (not valid JSON on its own). Ask for a smaller subtree, or use format "dto".`,
      };
    }
    const maxChildren = bounded(ctx.params, "maxChildrenPerNode", DEFAULTS.maxChildrenPerNode, 200);
    return { node: toDto(node, depth, maxChildren, includeGeometry) };
  },
};

const getNodesInfo: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const ids = strList(ctx.params, "nodeIds");
    if (!ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of node ids.");
    const depth = bounded(ctx.params, "depth", 0, 8);
    const includeGeometry = bool(ctx.params, "includeGeometry", true);
    const f = api();

    const items: Array<{ id: string; ok: true; node: NodeDto } | { id: string; ok: false; error: string; hint?: string }> = [];
    for (const id of ids) {
      // Per id, as the tool promises: Figma failing to fetch one node is that
      // id's error, not the call's (it failed whole on 2026-10-09).
      let node: NodeLike | null;
      try {
        node = await lookUp(f, id);
        if (node) await ensureLoaded(node); // a page's childCount needs it loaded [C-090]
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err;
        items.push({ id, ok: false, error: `${err.code}: ${err.message}`, ...(err.hint ? { hint: err.hint } : {}) });
        continue;
      }
      if (node) items.push({ id, ok: true, node: toDto(node, depth, DEFAULTS.maxChildrenPerNode, includeGeometry) });
      else items.push({ id, ok: false, error: "not found on the reachable pages" });
    }
    const found = items.filter((i) => i.ok).length;
    return { count: items.length, found, items };
  },
};

const getSelection: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const depth = bounded(ctx.params, "depth", 0, 8);
    const includeGeometry = bool(ctx.params, "includeGeometry", true);
    const sel = [...selectionOf(api())];
    return {
      count: sel.length,
      nodes: sel.map((n) => toDto(n, depth, DEFAULTS.maxChildrenPerNode, includeGeometry)),
      note: sel.length === 0 ? "Nothing is selected in Figma. Select a layer, or pass an explicit nodeId to another read." : undefined,
    };
  },
};

const getDesignContext: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const opts: ContextOptions = {
      depth: bounded(ctx.params, "depth", DEFAULTS.contextDepth, 12),
      maxNodes: bounded(ctx.params, "maxNodes", DEFAULTS.contextNodes, 20000),
      maxChildren: bounded(ctx.params, "maxChildrenPerNode", DEFAULTS.maxChildrenPerNode, 500),
      includeGeometry: bool(ctx.params, "includeGeometry", true),
      includeStyles: bool(ctx.params, "includeStyles", true),
      includeVariables: bool(ctx.params, "includeVariables", true),
      maxTextChars: Math.max(1, bounded(ctx.params, "maxTextChars", MAX_TEXT_CHARS, 20000)),
      includeAnnotations: bool(ctx.params, "includeAnnotations", true),
      includeCss: bool(ctx.params, "includeCss", false),
      maxTableCells: Math.max(1, bounded(ctx.params, "maxTableCells", MAX_TABLE_CELLS, 5000)),
      absolute: bool(ctx.params, "absolute", false),
    };
    // A cursor continues a truncated walk exactly where it stopped: its roots are
    // the not-yet-visited nodes, with the depth and fan-out of the first call.
    const cursor = str(ctx.params, "cursor");
    let roots: NodeLike[];
    let scope: From | undefined;
    let note: string | undefined;
    if (cursor) {
      const f = decodeFrontier(cursor);
      opts.depth = f.depth;
      opts.maxChildren = f.maxChildren;
      roots = [];
      for (const id of f.ids) {
        const n = await lookUp(api(), id);
        if (n) {
          await ensureLoaded(n); // [C-090]
          roots.push(n);
        }
      }
    } else if (str(ctx.params, "nodeId")) {
      roots = [(await scopeRoot(ctx.params)).root];
      scope = "node";
    } else {
      // Every selected layer is a root: three selected cards are read as three
      // cards, not as the first 500 nodes of the page.
      const sel = selectionOf(api());
      const slide = sel.length ? undefined : focusedSlide();
      if (!sel.length && !slide && isSlides()) {
        // A deck's page is every slide at depth 8: answer with its outline
        // instead, and let the caller pick the slides to read [C-155].
        const deck = deckOutline(api().currentPage, true);
        return {
          scope: "deck",
          deck,
          note: "Nothing is selected and no slide is focused, so this is the deck's outline, not its contents. " +
            "Pass nodeId (a slide id from deck.rows[].slides) to read one slide; read a few slides at a time.",
        };
      }
      roots = sel.length ? [...sel] : [slide ?? api().currentPage];
      scope = sel.length ? "selection" : slide ? "focusedSlide" : "page";
      if (slide) note = `Nothing is selected, so this reads the focused slide "${slide.name}". Pass nodeId for another slide.`;
    }
    const r = await buildContext(roots, opts, ctx);
    ctx.progress(r.nodeCount, r.nodeCount);
    const next = r.truncated ? encodeFrontier(r.frontier, opts) : undefined;
    return {
      ...(cursor ? { continued: r.roots } : roots.length > 1 ? { roots: r.roots } : { root: r.roots[0] }),
      ...(scope ? { scope } : {}),
      nodeCount: r.nodeCount,
      depth: opts.depth,
      truncated: r.truncated,
      ...(next
        ? {
            nextCursor: next,
            note: `Stopped at maxNodes=${opts.maxNodes}; ${r.frontier.length} subtree(s) not read yet (marked continued: true). Call again with cursor to read them — each comes back with its id, so place it under its parent.`,
          }
        : note
          ? { note }
          : {}),
      ...(r.textCut
        ? {
            textNote: `${r.textCut} text node(s) were cut at maxTextChars=${opts.maxTextChars} (text.length is the full count). Raise maxTextChars, or read the full text with figma_scan_text_nodes.`,
          }
        : {}),
      ...(r.tableCut
        ? {
            tableNote: `${r.tableCut} table(s) were cut at maxTableCells=${opts.maxTableCells} (table.cellsShown of rows × columns). Raise maxTableCells, or read every cell with figma_scan_text_nodes.`,
          }
        : {}),
      ...(r.connectors.length ? { connectors: r.connectors } : {}),
      ...(r.stylesUsed.length ? { stylesUsed: r.stylesUsed } : {}),
      ...(r.variablesUsed.length ? { variablesUsed: r.variablesUsed } : {}),
      ...(r.componentsUsed.length ? { componentsUsed: r.componentsUsed } : {}),
      ...(r.cssMs !== undefined ? { cssMs: r.cssMs } : {}),
      ...(r.cssNote ? { cssNote: r.cssNote } : {}),
    };
  },
};

function truncateTotal(max: number, got: number): number {
  return Math.max(max, got);
}

// ── read: search & scan ──────────────────────────────────────────────────────

type WithInstances = NodeLike & { getInstancesAsync?: () => Promise<readonly NodeLike[]> };

/** Numeric order of node ids ("2:10" after "2:9"), so a list built from an unordered API pages stably. */
function byIdOrder(a: NodeLike, b: NodeLike): number {
  const pa = a.id.split(/[:;I]/).filter(Boolean).map(Number);
  const pb = b.id.split(/[:;I]/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * Every instance of a component — of each variant, for a set — mapped to the
 * component it shows. getInstancesAsync, never the `instances` getter, which
 * throws under dynamic-page.
 */
async function instancesOf(componentId: string): Promise<Map<NodeLike, string>> {
  const comp = await byId(api(), componentId);
  const variants =
    comp.type === "COMPONENT" ? [comp] : comp.type === "COMPONENT_SET" ? (comp.children ?? []).filter((c) => c.type === "COMPONENT") : undefined;
  if (!variants) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`componentId\` must be a COMPONENT or COMPONENT_SET; ${componentId} is a ${comp.type}.`, {
      hint: "For an instance, read its component id from figma_get_design_context (component.id).",
    });
  }
  const out = new Map<NodeLike, string>();
  for (const v of variants as WithInstances[]) {
    if (typeof v.getInstancesAsync !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "getInstancesAsync is not available in this editor.");
    for (const inst of await v.getInstancesAsync()) out.set(inst, v.id);
  }
  return out;
}

const searchNodes: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const query = str(ctx.params, "query");
    const type = str(ctx.params, "type");
    const componentId = str(ctx.params, "componentId");
    const text = str(ctx.params, "text");
    if (!query && !type && !componentId && !text) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "Provide `query` (name substring), `text` (content substring), `type` and/or `componentId`.");
    }
    const exactName = bool(ctx.params, "exactName", false);
    const limit = bounded(ctx.params, "limit", DEFAULTS.searchLimit, 500);
    const scope = str(ctx.params, "scope") ?? "page";
    const f = api();

    let where: Scope;
    if (scope === "selection") {
      const sel = selectionOf(f);
      if (sel.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`scope: \"selection\"` but nothing is selected.");
      where = { root: sel[0]!, from: "selection", ...(sel.length > 1 ? { note: `${sel.length} layers are selected; only the first was searched.` } : {}) };
    } else if (scope === "subtree") {
      where = { root: await byId(f, reqStr(ctx.params, "nodeId")), from: "node" };
    } else {
      where = { root: f.currentPage, from: "page" };
    }
    const root = where.root;

    const needle = query?.toLowerCase();
    const content = text?.toLowerCase();
    // Content, not names: a sticky's layer name need not be its text, and a
    // connector's never is (create-connector.md:107). A table hit names its cell.
    const cells = new Map<NodeLike, { row: number; column: number }>();
    const matches = (node: NodeLike) => {
      if (type && node.type !== type) return false;
      if (needle) {
        const name = node.name.toLowerCase();
        if (exactName ? name !== needle : !name.includes(needle)) return false;
      }
      if (content) {
        const hit = contentHit(node, content);
        if (!hit) return false;
        if (hit.cell) cells.set(node, hit.cell);
      }
      return true;
    };
    const scopeKey = `search:${scope}:${root.id}:${query ?? ""}:${type ?? ""}${componentId ? `:${componentId}` : ""}${text ? `:text=${text}` : ""}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

    let items: NodeLike[];
    let more: boolean;
    let shows: Map<NodeLike, string> | undefined;
    if (componentId) {
      // The instances are known up front: filter them to the scope instead of walking it.
      shows = await instancesOf(componentId);
      const hits = [...shows.keys()].filter((n) => isInside(n, root) && matches(n)).sort(byIdOrder);
      items = hits.slice(offset, offset + limit);
      more = hits.length > offset + limit;
    } else {
      ({ items, more } = await collect(root, matches, limit, offset, ctx));
    }

    return {
      query: query ?? null,
      type: type ?? null,
      ...(componentId ? { componentId } : {}),
      ...(text ? { text } : {}),
      scope: scopeOf(where),
      ...(where.note ? { note: where.note } : {}),
      count: items.length,
      nodes: items.map((n) => {
        const dto = shows ? { ...toDto(n, 0), componentId: shows.get(n) } : toDto(n, 0);
        const cell = cells.get(n);
        return cell ? { ...dto, cell } : dto;
      }),
      truncated: more,
      ...(more ? { nextCursor: encodeCursor(scopeKey, offset + items.length) } : {}),
    };
  },
};

const scanNodesByTypes: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const types = strList(ctx.params, "types");
    if (!types) throw new BridgeError(ErrorCode.INVALID_PARAM, "`types` must be a non-empty array of node types.");
    const wanted = new Set(types.map((t) => t.toUpperCase()));
    const where = await scopeRoot(ctx.params);
    const root = where.root;
    const limit = bounded(ctx.params, "limit", DEFAULTS.scanLimit, 2000);
    const scopeKey = `scan_types:${root.id}:${[...wanted].sort().join(",")}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

    const { items, more } = await collect(root, (n) => wanted.has(n.type.toUpperCase()), limit, offset, ctx);
    return {
      types: [...wanted],
      scope: scopeOf(where),
      ...(where.note ? { note: where.note } : {}),
      count: items.length,
      nodes: items.map((n) => toDto(n, 0)),
      truncated: more,
      ...(more ? { nextCursor: encodeCursor(scopeKey, offset + items.length) } : {}),
    };
  },
};

/** `types` for figma_scan_text_nodes: any of TEXT_SCAN_TYPES, default all; anything else is refused by name. */
function textScanTypes(params: Record<string, unknown>): string[] {
  const raw = params.types;
  if (raw === undefined) return [...TEXT_SCAN_TYPES];
  const known = TEXT_SCAN_TYPES as readonly string[];
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((t) => typeof t !== "string" || !known.includes(t.toUpperCase()))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`types\` lists any of: ${TEXT_SCAN_TYPES.join(", ")}.`);
  }
  return [...new Set((raw as string[]).map((t) => t.toUpperCase()))].sort();
}

const scanTextNodes: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const types = textScanTypes(ctx.params);
    const wanted = new Set(types);
    const where = await scopeRoot(ctx.params);
    const root = where.root;
    const limit = bounded(ctx.params, "limit", DEFAULTS.textLimit, 5000);
    // v2 counts ITEMS — a table yields one per non-empty cell — so a cursor from
    // the node-counting v1 would resume at a shifted offset: its scope differs
    // and it is refused instead.
    const scopeKey = `scan_text:v2:${root.id}:${types.join(",")}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

    const nodes: TextItem[] = [];
    let index = 0;
    let more = false;
    await walk(
      root,
      (n) => {
        if (!wanted.has(n.type)) return;
        for (const item of textItems(n)) {
          if (index++ < offset) continue;
          if (nodes.length >= limit) {
            more = true;
            return false; // stop at the first item past the page
          }
          nodes.push(item);
        }
      },
      ctx,
    );
    return {
      scope: scopeOf(where),
      ...(where.note ? { note: where.note } : {}),
      types,
      count: nodes.length,
      nodes,
      truncated: more,
      ...(more ? { nextCursor: encodeCursor(scopeKey, offset + nodes.length) } : {}),
    };
  },
};

// ── read: styles, variables, components, fonts ───────────────────────────────

// Styles and variables WITH their values, key and description — the reads a
// design system is matched against; the implementations live with the token
// writes (tokens.ts) so a value reads in exactly the dialect it is written in.
const getStyles: PluginOp = {
  write: false,
  run: (ctx: OpContext) => listStyles(ctx),
};

const getVariableDefs: PluginOp = {
  write: false,
  run: (ctx: OpContext) => variableDefs(ctx),
};

/** The parameters that read the available fonts; any of them implies scope "available". */
const AVAILABLE_ONLY = ["query", "families", "limit", "cursor"] as const;
/** Families per call when the caller names no limit — the full list is 465,683 characters on a 10,038-style machine. */
const FONT_PAGE = 50;
/** A result's own copy: the index is the session's, and outlives this answer. */
const copy = (x: FontFamily): FontFamily => ({ family: x.family, styles: [...x.styles] });

/**
 * figma_get_fonts { scope: "available" }: families with their exact style
 * names, never the flat style list. That list was 465,683 characters on the
 * acceptance run's machine (10,038 styles, 2,284 families) — past what an MCP
 * client accepts. So it pages by family (`limit`, `cursor`), filters by part of
 * a name (`query`), or answers for named families (`families`).
 */
async function availableFonts(ctx: OpContext, f: FontLister) {
  const p = ctx.params;
  const query = str(p, "query")?.trim().toLowerCase();
  const asked = strList(p, "families");
  if (query && asked) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `families` (exact names) or `query` (part of a name), not both.");
  if (asked && (p.limit !== undefined || p.cursor !== undefined)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`limit` and `cursor` page a listing; `families` answers for each name it lists.");
  }
  if (asked && asked.length > 50) throw new BridgeError(ErrorCode.INVALID_PARAM, "`families` takes at most 50 names.");

  let index = await fontIndex(f, { pace: ctx });
  if (!index) throw new BridgeError(ErrorCode.UNSUPPORTED, "`listAvailableFontsAsync` is unavailable here.");
  const totals = () => ({ totalFamilies: index!.families.length, totalStyles: index!.styles });

  if (asked) {
    const names = [...new Map(asked.map((n) => [n.trim().toLowerCase(), n.trim()])).entries()];
    // A family installed since the session's list was read: look once more, at a fresh list.
    if (names.some(([key]) => !index!.byFamily.has(key))) index = (await fontIndex(f, { pace: ctx, maxAgeMs: 60_000 })) ?? index;
    const found = names.flatMap(([key]) => index!.byFamily.get(key) ?? []).map(copy);
    const missing = names.filter(([key]) => !index!.byFamily.has(key)).map(([, name]) => name);
    return {
      scope: "available",
      ...totals(),
      total: found.length,
      count: found.length,
      truncated: false,
      families: found,
      missing,
      ...(missing.length ? { note: "A missing family may be spelt differently here: `query` with part of its name lists near matches." } : {}),
    };
  }

  const limit = Math.max(1, int(p, "limit", FONT_PAGE, 500));
  const scopeKey = `fonts:available:${query ?? ""}`;
  const offset = decodeCursor(str(p, "cursor"), scopeKey);
  const matches = query ? index.families.filter((x) => x.family.toLowerCase().includes(query)) : index.families;
  const page = matches.slice(offset, offset + limit);
  const more = offset + page.length < matches.length;
  return {
    scope: "available",
    ...(query ? { query } : {}),
    ...totals(),
    total: matches.length,
    count: page.length,
    truncated: more,
    ...(more ? { nextCursor: encodeCursor(scopeKey, offset + page.length) } : {}),
    families: page.map(copy),
    ...(more
      ? { note: `${page.length} of ${matches.length} families. Narrow with \`query\` (part of a name), check names with \`families\`, or pass nextCursor for the next ${limit}.` }
      : {}),
  };
}

const getFonts: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const filtered = AVAILABLE_ONLY.filter((k) => ctx.params[k] !== undefined);
    const scope = str(ctx.params, "scope") ?? (filtered.length ? "available" : "page");
    const f = api() as unknown as FontLister & { currentPage: NodeLike };

    if (scope === "available") return availableFonts(ctx, f);
    if (filtered.length) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `${filtered.map((k) => `\`${k}\``).join(", ")} read the available fonts, not the page's.`, {
        hint: 'Pass scope "available" (or leave scope out) to filter the fonts this Figma can load.',
      });
    }

    // On the page: every font of every TEXT node — each run of mixed text
    // too, since a wrong family hides most often in one styled word — and of
    // the text a sticky, shape, connector or table cell holds in its sublayer
    // [C-135]. An empty sublayer draws nothing, so its font is not counted.
    type Font = { family: string; style: string };
    const seen = new Map<string, { family: string; style: string; nodeCount: number; missing?: true }>();
    const keyOf = (fn: Font) => `${fn.family}\u0000${fn.style}`;
    const flagged = new Set<string>(); // fonts of single-font nodes Figma marks as missing
    const isFont = (v: unknown): v is Font => typeof v === "object" && v !== null && typeof (v as Font).family === "string" && (v as Font).family !== "";
    const sublayerFonts = (holder: unknown): Font[] => {
      const len = (field<string>(holder, "characters") ?? "").length;
      if (!len) return [];
      const all = field<(s: number, e: number) => Font[]>(holder, "getRangeAllFontNames");
      if (typeof all === "function") {
        try {
          return all.call(holder, 0, len).filter(isFont);
        } catch {
          /* fall back to the sublayer's one font */
        }
      }
      const own = field(holder, "fontName");
      return isFont(own) ? [own] : [];
    };
    await walk(
      f.currentPage,
      (node) => {
        if (node.type === "STICKY" || node.type === "SHAPE_WITH_TEXT" || node.type === "CONNECTOR" || node.type === "TABLE") {
          const holders = node.type === "TABLE" ? tableHolders(node) : [sublayerOf(node)];
          const distinct = new Map(holders.flatMap(sublayerFonts).map((fn) => [keyOf(fn), fn]));
          for (const [key, fn] of distinct) {
            const found = seen.get(key);
            if (found) found.nodeCount++;
            else seen.set(key, { family: fn.family, style: fn.style, nodeCount: 1 });
          }
          return;
        }
        if (node.type !== "TEXT") return;
        const t = node as unknown as { fontName?: Font | symbol; hasMissingFont?: boolean; characters?: string; getStyledTextSegments?: (fields: string[], s?: number, e?: number) => Array<{ fontName?: Font }> };
        let fonts: Font[] = [];
        if (t.fontName && typeof t.fontName === "object") fonts = [t.fontName];
        else if (isMixed(t.fontName) && typeof t.getStyledTextSegments === "function") {
          try {
            fonts = t.getStyledTextSegments(["fontName"], 0, (t.characters ?? "").length).flatMap((s) => (s.fontName ? [s.fontName] : []));
          } catch {
            fonts = [];
          }
        }
        const distinct = new Map(fonts.map((fn) => [keyOf(fn), fn]));
        for (const [key, fn] of distinct) {
          const found = seen.get(key);
          if (found) found.nodeCount++;
          else seen.set(key, { family: fn.family, style: fn.style, nodeCount: 1 });
        }
        if (t.hasMissingFont === true && distinct.size === 1) flagged.add([...distinct.keys()][0]!);
      },
      ctx,
      { yieldEvery: 200 },
    );

    // Which fonts are missing: only worth asking when Figma says something is.
    // The installed list is exact even for mixed text; the per-node flag is the
    // fallback where that list is unavailable.
    const any = (f as unknown as { hasMissingFont?: unknown }).hasMissingFont;
    if (any === true) {
      let installed: FontIndex | null = null;
      try {
        // Fresh within a minute: a font the user installed to fix this is not missing.
        installed = await fontIndex(f, { pace: ctx, maxAgeMs: 60_000 });
      } catch {
        installed = null;
      }
      const has = (fn: Font) => installed!.byFamily.get(fn.family.toLowerCase())?.styles.includes(fn.style) === true;
      for (const [key, font] of seen) if (installed ? !has(font) : flagged.has(key)) font.missing = true;
    }

    return { scope, count: seen.size, fonts: [...seen.values()], ...(typeof any === "boolean" ? { missingFonts: any } : {}) };
  },
};

// ── read: annotations & reactions ───────────────────────────────────────────

type Annotation = { label?: string; labelMarkdown?: string; categoryId?: string; properties?: unknown[] };

const getAnnotations: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const where = await scopeRoot(ctx.params);
    const root = where.root;
    const raw: Array<{ nodeId: string; name: string; annotations: Annotation[] }> = [];
    await walk(
      root,
      (node) => {
        // Through field(): a deck's grid and rows have no annotations, and reading them may throw [C-145].
        const ann = field<Annotation[]>(node, "annotations");
        if (Array.isArray(ann) && ann.length > 0) raw.push({ nodeId: node.id, name: node.name, annotations: ann });
      },
      ctx,
      { yieldEvery: 200 },
    );

    // A category is an id on the annotation; its label and colour are what a reader needs.
    const categories = new Map<string, { id: string; label: string; color: string } | null>();
    const lookup = (api() as unknown as { annotations?: { getAnnotationCategoryByIdAsync?: (id: string) => Promise<{ id: string; label: string; color: string } | null> } }).annotations;
    const category = async (id: string | undefined) => {
      if (!id || typeof lookup?.getAnnotationCategoryByIdAsync !== "function") return undefined;
      if (!categories.has(id)) {
        const c = await lookup.getAnnotationCategoryByIdAsync(id).catch(() => null);
        categories.set(id, c ? { id: c.id, label: c.label, color: c.color } : null);
      }
      return categories.get(id) ?? undefined;
    };
    const out: Array<{ nodeId: string; name: string; annotations: unknown[] }> = [];
    for (const r of raw) {
      const annotations: unknown[] = [];
      for (const a of r.annotations) {
        const c = await category(a.categoryId);
        annotations.push({ ...a, ...(c ? { category: c } : {}) });
      }
      out.push({ nodeId: r.nodeId, name: r.name, annotations });
    }

    // Dev resources (links to code, tickets, docs) are typed on every node but
    // unproven in a design-mode plugin [C-094]: a refusal becomes a note, never a failed read.
    let devResources: Array<{ nodeId: string; name: string; url: string; inheritedNodeId?: string }> | undefined;
    let devResourcesNote: string | undefined;
    const get = field<(o: { includeChildren: boolean }) => Promise<Array<{ nodeId: string; name: string; url: string; inheritedNodeId?: string }>>>(root, "getDevResourcesAsync");
    if (typeof get !== "function") devResourcesNote = "getDevResourcesAsync is not available in this editor.";
    else {
      try {
        devResources = (await get.call(root, { includeChildren: true })).map((d) => ({
          nodeId: d.nodeId,
          name: d.name,
          url: d.url,
          ...(d.inheritedNodeId ? { inheritedNodeId: d.inheritedNodeId } : {}),
        }));
      } catch (err) {
        devResourcesNote = `Dev resources could not be read here: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      scope: scopeOf(where),
      count: out.length,
      nodes: out,
      ...(devResources ? { devResources } : {}),
      ...(devResourcesNote ? { devResourcesNote } : {}),
      note: where.note ?? (out.length === 0 ? "No annotations found in this subtree. Annotations are a Dev Mode feature." : undefined),
    };
  },
};

type Reaction = { action?: { type?: string; destinationId?: string | null; navigation?: string }; actions?: Array<{ type?: string; destinationId?: string | null; navigation?: string }> };

const reactionsOf = (n: NodeLike): Reaction[] => {
  // A board's and a deck's nodes mostly have no reactions, and reading one may throw [C-145].
  const r = field(n, "reactions");
  return Array.isArray(r) ? (r as Reaction[]) : [];
};

/** Read a prototype getter that a node type may not have, or may refuse. */
function proto(n: NodeLike, key: string): unknown {
  try {
    return (n as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A frame's prototype behaviour: scrolling, fixed layers, and — for an overlay — how it opens [C-117]. */
function frameInfo(n: NodeLike, asOverlay: boolean): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { nodeId: n.id, name: n.name };
  const overflow = overflowText(proto(n, "overflowDirection"));
  if (overflow) out.overflow = overflow;
  const fixed = proto(n, "numberOfFixedChildren");
  if (typeof fixed === "number" && fixed > 0) out.fixedChildren = fixed;
  if (asOverlay) {
    const bg = proto(n, "overlayBackground") as { type?: string; color?: { r: number; g: number; b: number; a: number } } | undefined;
    out.overlay = {
      position: proto(n, "overlayPositionType") ?? null,
      background: bg?.type === "SOLID_COLOR" && bg.color ? hex(bg.color, bg.color.a) : "none",
      interaction: proto(n, "overlayBackgroundInteraction") ?? null,
    };
  }
  return Object.keys(out).length > 2 ? out : undefined;
}

const getReactions: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const scope = str(ctx.params, "scope") ?? "node";
    if (scope === "node") {
      const node = await byId(api(), reqStr(ctx.params, "nodeId"));
      const reactions = reactionsOf(node);
      return { nodeId: node.id, name: node.name, count: reactions.length, reactions };
    }
    if (scope !== "subtree" && scope !== "page") throw new BridgeError(ErrorCode.INVALID_PARAM, '`scope` must be "node", "subtree" or "page".');
    const nodeId = str(ctx.params, "nodeId");
    if (scope === "subtree" && !nodeId) throw new BridgeError(ErrorCode.INVALID_PARAM, '`nodeId` is required with scope "subtree".');
    const picked = nodeId ? await byId(api(), nodeId) : api().currentPage;
    // Page scope reads the page a node sits on; flows and the prototype background live there.
    const root = scope === "page" ? (pageOf(picked) ?? picked) : picked;
    await ensureLoaded(root); // [C-090]
    const page = pageOf(root);

    const limit = bounded(ctx.params, "limit", DEFAULTS.reactionLimit, 1000);
    const scopeKey = `reactions:${scope}:${root.id}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);
    const scrolls = (n: NodeLike) => frameInfo(n, false) !== undefined;
    const { items, more } = await collect(root, (n) => reactionsOf(n).length > 0 || scrolls(n), limit, offset, ctx);

    const nodes = items.filter((n) => reactionsOf(n).length > 0).map((n) => ({ nodeId: n.id, name: n.name, reactions: reactionsOf(n) }));
    // Overlay settings matter on the frames something opens as an overlay; read them there.
    const overlayIds = new Set<string>();
    for (const n of nodes) {
      for (const r of n.reactions) {
        for (const a of [...(r.actions ?? []), ...(r.action ? [r.action] : [])]) {
          if (a.type === "NODE" && a.navigation === "OVERLAY" && a.destinationId) overlayIds.add(a.destinationId);
        }
      }
    }
    const frames = new Map<string, Record<string, unknown>>();
    for (const n of items) {
      const info = frameInfo(n, overlayIds.has(n.id));
      if (info) frames.set(n.id, info);
    }
    for (const id of overlayIds) {
      if (frames.has(id)) continue;
      const n = await api().getNodeByIdAsync(id);
      const info = n ? frameInfo(n, true) : undefined;
      if (info) frames.set(id, info);
    }

    // A board's or a deck's page may lack the prototype members, and reading one may throw [C-145].
    const p = {
      flowStartingPoints: field<ReadonlyArray<{ nodeId: string; name: string }>>(page, "flowStartingPoints"),
      prototypeStartNode: field<{ id: string } | null>(page, "prototypeStartNode"),
      prototypeBackgrounds: field<ReadonlyArray<{ type?: string; color?: { r: number; g: number; b: number }; opacity?: number }>>(page, "prototypeBackgrounds"),
    };
    const bg = Array.isArray(p.prototypeBackgrounds) ? p.prototypeBackgrounds[0] : undefined;
    return {
      scope,
      root: { id: root.id, name: root.name, type: root.type },
      count: nodes.length,
      nodes,
      flows: Array.isArray(p.flowStartingPoints) ? p.flowStartingPoints.map((x) => ({ nodeId: x.nodeId, name: x.name })) : [],
      prototypeStartNodeId: p.prototypeStartNode?.id ?? null,
      prototypeBackground: bg?.type === "SOLID" && bg.color ? hex(bg.color, bg.opacity ?? 1) : null,
      frames: [...frames.values()],
      truncated: more,
      ...(more ? { nextCursor: encodeCursor(scopeKey, offset + items.length) } : {}),
    };
  },
};

export const READ_OPS: Record<string, PluginOp> = {
  get_metadata: getMetadata,
  get_pages: getPages,
  get_node: getNode,
  get_nodes_info: getNodesInfo,
  get_selection: getSelection,
  get_design_context: getDesignContext,
  search_nodes: searchNodes,
  scan_nodes_by_types: scanNodesByTypes,
  scan_text_nodes: scanTextNodes,
  get_styles: getStyles,
  get_variable_defs: getVariableDefs,
  get_fonts: getFonts,
  get_annotations: getAnnotations,
  get_reactions: getReactions,
};
