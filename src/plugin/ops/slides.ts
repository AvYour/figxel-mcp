// The Figma Slides tools: read the deck's grid, add slides, regroup and move
// them, skip them, give them speaker notes and transitions.
//
// Slides files only — the editor gate refuses these ops elsewhere [C-129]
// [C-134] — and each op still feature-detects the API it needs, because a hub
// older than the gate does not refuse them and a missing member may throw
// instead of reading undefined [C-145].
//
// Content is not built here: one figma_create_from_spec per slide (parentId =
// the slide) does that, a few slides per call with a check after each batch,
// the official deck rhythm [C-155]. Every write validates before its first
// change (guard.ts) and the runner commits one undo step per call (code.ts)
// [C-151].

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { paintText } from "../dialect.js";
import { beforeMutating } from "../guard.js";
import { bool, decodeCursor, encodeCursor, int, str } from "../read.js";
import { apiHas, figmaGlobal, has, tryGet } from "../safe.js";
import {
  apiGridIds,
  focusedSlideId,
  gridProblems,
  gridWriter,
  idRows,
  planCreates,
  planMove,
  positionsOf,
  readView,
  requireGrid,
  slideCount,
  typeOf,
  writeGrid,
  type GridRead,
  type MoveAnchor,
  type RowNodeLike,
  type SlideNodeLike,
} from "../slides/grid.js";
import { parseColor, type SolidPaint } from "../write.js";
import type { OpContext, PluginOp } from "./index.js";

interface SlidesFigma {
  getNodeByIdAsync(id: string): Promise<unknown>;
  createSlide(row?: number, col?: number): SlideNodeLike;
  createSlideRow(row?: number): RowNodeLike;
}

const api = () => figmaGlobal() as SlidesFigma;

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A nested object takes only its own fields: a misspelt one is refused, never dropped (tools.md § Conventions). */
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw invalid(`\`${at}.${k}\` is not a field here.`, `Fields: ${allowed.join(", ")}.`);
  }
}

function wholeAt(v: unknown, at: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw invalid(`\`${at}\` must be a whole number, 0 or more.`);
  return v;
}

function boolAt(v: unknown, at: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw invalid(`\`${at}\` must be true or false.`);
  return v;
}

function textAt(v: unknown, at: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`\`${at}\` must be a string.`);
  if (v.length > max) throw invalid(`\`${at}\` is ${v.length} characters; at most ${max}.`);
  return v;
}

/** A required list of distinct ids, `min`–`max` long. */
function idList(v: unknown, at: string, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
    throw invalid(`\`${at}\` must be a list of 1–${max} slide ids.`);
  }
  const seen = new Set<string>();
  for (const id of v as string[]) {
    if (seen.has(id)) throw invalid(`\`${at}\` names ${id} twice.`);
    seen.add(id);
  }
  return v as string[];
}

/** "1:2, 1:3, … (+5 more)" — a hint stays readable for a 400-slide deck. */
function listed(ids: readonly string[], max = 20): string {
  return ids.length <= max ? ids.join(", ") : `${ids.slice(0, max).join(", ")}, … (+${ids.length - max} more)`;
}

/** Why `id` is not a slide of this deck, in a few words. */
async function notASlide(id: string): Promise<string> {
  let node: unknown = null;
  try {
    node = await api().getNodeByIdAsync(id);
  } catch {
    node = null;
  }
  if (!node) return "not found";
  const type = typeOf(node);
  return type === "SLIDE" ? "a slide outside the deck's grid" : `a ${type ?? "node"}, not a slide`;
}

/** Where a slide sits right now, read from its parent row (null when it is not in a row of the grid). */
function landed(read: GridRead | null, slide: SlideNodeLike): { row: number; col: number } | null {
  if (!read) return null;
  for (const r of read.rows) {
    const col = r.slides.findIndex((s) => s.id === slide.id);
    if (col >= 0) return { row: r.index, col };
  }
  return null;
}

// ── transitions ─────────────────────────────────────────────────────────────

/** SlideTransition.style (d.ts:12372-12395). The server's enum is the same list (test/slides.test.ts pins it). */
export const TRANSITION_STYLES = [
  "NONE", "DISSOLVE",
  "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP",
  "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP",
  "MOVE_FROM_LEFT", "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM",
  "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT", "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM",
  "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP", "MOVE_OUT_TO_BOTTOM",
  "SMART_ANIMATE",
] as const;
/** SlideTransition.curve (d.ts:12403-12404). */
export const TRANSITION_CURVES = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW"] as const;
/** The public guide's ranges, in seconds [C-139]. */
export const DURATION_RANGE = { min: 0.01, max: 10 } as const;
export const DELAY_RANGE = { min: 0, max: 30 } as const;

interface Transition {
  style: string;
  duration: number;
  curve: string;
  timing: { type: "ON_CLICK" | "AFTER_DELAY"; delay?: number };
}

/** A transition in the tools' words: timing "on-click" / "after-delay", the delay only with the latter. */
export function transitionOut(t: unknown): Record<string, unknown> {
  const v = (t ?? {}) as { style?: unknown; duration?: unknown; curve?: unknown; timing?: { type?: unknown; delay?: unknown } };
  const after = v.timing?.type === "AFTER_DELAY";
  return {
    style: v.style,
    duration: v.duration,
    curve: v.curve,
    timing: after ? "after-delay" : "on-click",
    ...(after && typeof v.timing?.delay === "number" ? { delay: v.timing.delay } : {}),
  };
}

function readTransition(slide: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!has(slide, "getSlideTransition")) return { ok: false, message: "getSlideTransition is not available on this slide" };
  try {
    return { ok: true, value: (slide as { getSlideTransition(): unknown }).getSlideTransition() };
  } catch (err) {
    return { ok: false, message: errText(err) };
  }
}

interface TransitionAsk {
  style: string;
  duration?: number;
  curve?: string;
  timing?: "on-click" | "after-delay";
  delay?: number;
}

/**
 * The transition to write: what was asked, the slide's current values for the
 * rest. No default is invented — a field with nothing to keep is asked for. A
 * delay with on-click timing is refused because Figma sets it to 0 [C-139].
 */
export function mergeTransition(current: unknown, ask: TransitionAsk, slideId: string): Transition {
  const cur = (current ?? {}) as { duration?: unknown; curve?: unknown; timing?: { type?: unknown; delay?: unknown } };
  const curType = cur.timing?.type === "AFTER_DELAY" ? "AFTER_DELAY" : "ON_CLICK";
  const type = ask.timing ? (ask.timing === "after-delay" ? "AFTER_DELAY" : "ON_CLICK") : curType;
  if (type === "ON_CLICK" && ask.delay !== undefined) {
    throw invalid("`delay` goes with timing \"after-delay\": with on-click Figma sets it to 0.", 'Pass timing: "after-delay" with the delay, or leave the delay out.');
  }
  let delay: number | undefined;
  if (type === "AFTER_DELAY") {
    delay = ask.delay ?? (curType === "AFTER_DELAY" && typeof cur.timing?.delay === "number" ? cur.timing.delay : undefined);
    if (delay === undefined) throw invalid(`Slide ${slideId} has no delay to keep: pass \`delay\` (0–30 s) with timing "after-delay".`);
  }
  const duration = ask.duration ?? (typeof cur.duration === "number" ? cur.duration : undefined);
  if (duration === undefined || (ask.style !== "NONE" && (duration < DURATION_RANGE.min || duration > DURATION_RANGE.max))) {
    throw invalid(`Slide ${slideId} has no transition duration to keep (${String(cur.duration)}): pass \`duration\` (0.01–10 s).`);
  }
  const curve = ask.curve ?? (typeof cur.curve === "string" ? cur.curve : undefined);
  if (curve === undefined) throw invalid(`Slide ${slideId} has no transition curve to keep: pass \`curve\`.`);
  return { style: ask.style, duration, curve, timing: delay === undefined ? { type } : { type, delay } };
}

// ── speaker notes ───────────────────────────────────────────────────────────

/** Markdown the notes editor keeps as literal text (slide-properties.md:82-86) [C-165]. */
const LITERAL_MARKDOWN: ReadonlyArray<[RegExp, string]> = [
  [/^ {0,3}#{1,6}\s/m, "'# ' headings are kept as literal text in speaker notes"],
  [/`/, "code (`…`) is kept as literal text in speaker notes"],
  [/\[[^\]]*\]\([^)]*\)/, "links [text](url) are kept as literal text in speaker notes"],
  [/<\/?u>/i, "underline is kept as literal text in speaker notes"],
];

export function notesWarnings(notes: string): string[] {
  return LITERAL_MARKDOWN.filter(([re]) => re.test(notes)).map(([, w]) => w);
}

// ── figma_get_slide_grid ────────────────────────────────────────────────────

/** Descendants of `root` whose type is one of `types`: the indexed findAllWithCriteria when the node has it, else a bounded walk. */
function descendantsOf(root: unknown, types: readonly string[], maxVisited = 1000): unknown[] {
  const find = tryGet<(c: { types: string[] }) => unknown[]>(root, "findAllWithCriteria");
  if (find.ok && typeof find.value === "function") {
    try {
      return [...find.value.call(root, { types: [...types] })];
    } catch {
      // fall through to the walk
    }
  }
  const out: unknown[] = [];
  const kids = tryGet<readonly unknown[]>(root, "children");
  const stack: unknown[] = kids.ok && Array.isArray(kids.value) ? [...kids.value].reverse() : [];
  let seen = 0;
  while (stack.length && seen++ < maxVisited) {
    const n = stack.pop();
    if (types.includes(typeOf(n) ?? "")) out.push(n);
    const c = tryGet<readonly unknown[]>(n, "children");
    if (c.ok && Array.isArray(c.value)) for (let i = c.value.length - 1; i >= 0; i--) stack.push(c.value[i]);
  }
  return out;
}

/** The largest text on a slide, whitespace collapsed and cut at 120 characters: what the slide is about. */
function titleOf(slide: unknown): string | undefined {
  let best: { size: number; text: string } | undefined;
  for (const t of descendantsOf(slide, ["TEXT"])) {
    const chars = tryGet(t, "characters");
    if (!chars.ok || typeof chars.value !== "string" || !chars.value.trim()) continue;
    const fs = tryGet(t, "fontSize");
    let size = fs.ok && typeof fs.value === "number" ? fs.value : 0;
    if (!size) {
      const range = tryGet<(s: number, e: number) => unknown>(t, "getRangeFontSize");
      try {
        const v = range.ok && typeof range.value === "function" ? range.value.call(t, 0, 1) : undefined;
        if (typeof v === "number") size = v;
      } catch {
        // a mixed size that cannot be read ranks last
      }
    }
    if (!best || size > best.size) best = { size, text: chars.value };
  }
  if (!best) return undefined;
  const text = best.text.replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

interface SlideReadOptions {
  notes: boolean;
  transitions: boolean;
  summary: boolean;
}

function describeSlide(slide: SlideNodeLike, at: { row: number; col: number; index: number }, opts: SlideReadOptions, unsupported: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: slide.id, name: slide.name, row: at.row, col: at.col, index: at.index };
  const skipped = tryGet(slide, "isSkippedSlide");
  if (skipped.ok && typeof skipped.value === "boolean") out.skipped = skipped.value;
  if (opts.notes) {
    // Not in plugin-typings 1.141.0; the official skill reads it [C-138].
    const notes = has(slide, "speakerNotes") ? tryGet(slide, "speakerNotes") : null;
    if (notes?.ok && typeof notes.value === "string") out.speakerNotes = notes.value;
    else unsupported.add("speakerNotes");
  }
  if (opts.transitions) {
    const t = readTransition(slide);
    if (t.ok) out.transition = transitionOut(t.value);
    else {
      out.transitionError = t.message;
      unsupported.add("transition");
    }
  }
  const kids = tryGet<readonly unknown[]>(slide, "children");
  out.childCount = kids.ok && Array.isArray(kids.value) ? kids.value.length : 0;
  if (opts.summary) {
    const fills = tryGet<ReadonlyArray<Record<string, unknown>>>(slide, "fills");
    if (fills.ok && Array.isArray(fills.value)) {
      // The last visible fill is the one on top.
      const top = [...fills.value].reverse().find((f) => f && f.visible !== false);
      const w = tryGet(slide, "width");
      const h = tryGet(slide, "height");
      if (top) out.background = paintText(top, w.ok && typeof w.value === "number" ? w.value : 1, h.ok && typeof h.value === "number" ? h.value : 1);
    }
    const title = titleOf(slide);
    if (title) out.title = title;
    // Polls, embeds, facepiles: readable and movable, never creatable [C-134].
    const interactive = descendantsOf(slide, ["INTERACTIVE_SLIDE_ELEMENT"]).map((n) => {
      const kind = tryGet(n, "interactiveSlideElementType");
      return { id: (n as { id: string }).id, type: kind.ok ? kind.value : null };
    });
    if (interactive.length) out.interactive = interactive;
  }
  return out;
}

const getSlideGrid: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const p = ctx.params;
    const opts: SlideReadOptions = {
      notes: bool(p, "includeNotes", true),
      transitions: bool(p, "includeTransitions", false),
      summary: bool(p, "includeSummary", true),
    };
    const limit = Math.max(1, int(p, "limit", 500, 2000));
    const rowIndex = wholeAt(p.rowIndex, "rowIndex");
    const read = requireGrid("figma_get_slide_grid");
    if (rowIndex !== undefined && rowIndex >= read.rows.length) {
      throw invalid(`\`rowIndex\` is ${rowIndex}, but the deck has ${read.rows.length} row(s).`);
    }
    const scope = `slide_grid|${rowIndex ?? "all"}`;
    const offset = decodeCursor(str(p, "cursor"), scope);
    const positions = positionsOf(read);
    const all = read.rows.flatMap((r) => r.slides.map((slide) => ({ slide, rowNode: r, at: positions.get(slide.id)! })));
    const list = rowIndex === undefined ? all : all.filter((e) => e.at.row === rowIndex);
    const window = list.slice(offset, offset + limit);

    const unsupported = new Set<string>();
    const rows = new Map<number, { rowId: string; index: number; name: string; slideCount: number; slides: Array<Record<string, unknown>> }>();
    const rowEntry = (r: GridRead["rows"][number]) => {
      let e = rows.get(r.index);
      if (!e) rows.set(r.index, (e = { rowId: r.node.id, index: r.index, name: r.node.name, slideCount: r.slides.length, slides: [] }));
      return e;
    };
    if (rowIndex !== undefined) rowEntry(read.rows[rowIndex]!);
    for (let i = 0; i < window.length; i++) {
      const { slide, rowNode, at } = window[i]!;
      rowEntry(rowNode).slides.push(describeSlide(slide, at, opts, unsupported));
      ctx.progress(i + 1, window.length, "reading");
      if (i % 25 === 24) await ctx.yieldToHost();
    }

    const total = slideCount(read);
    const first = read.rows.find((r) => r.slides.length)?.slides[0];
    const w = first ? tryGet(first, "width") : null;
    const h = first ? tryGet(first, "height") : null;
    // The tree is the source; Figma's own grid call is only a cross-check [C-164].
    let apiMismatch: Record<string, unknown> | undefined;
    if (offset === 0) {
      const apiRows = apiGridIds();
      const filled = (rs: string[][]) => JSON.stringify(rs.filter((r) => r.length));
      if (apiRows.ok && filled(apiRows.rows) !== filled(idRows(read))) {
        apiMismatch = { via: apiRows.via, rows: apiRows.rows, note: "Figma's grid call disagrees with the SLIDE_GRID tree; rows here follow the tree." };
      }
    }
    const view = readView();
    return {
      gridId: read.node.id,
      ...(w?.ok && h?.ok ? { slideSize: { width: w.value, height: h.value } } : {}),
      view: view ? view.view : null,
      focusedSlideId: focusedSlideId(),
      rowCount: read.rows.length,
      slideCount: total,
      rows: [...rows.values()],
      emptyRows: read.rows.filter((r) => r.slides.length === 0).map((r) => ({ rowId: r.node.id, index: r.index, name: r.node.name })),
      ...(unsupported.size ? { unsupported: [...unsupported] } : {}),
      ...(apiMismatch ? { apiMismatch } : {}),
      ...(offset + limit < list.length ? { truncated: true, nextCursor: encodeCursor(scope, offset + limit) } : {}),
      ...(total === 0 ? { note: "The deck has no slides yet: the first figma_create_slides makes row 0." } : {}),
    };
  },
};

// ── figma_create_slides ─────────────────────────────────────────────────────

interface NewSlide {
  name?: string;
  row?: number;
  col?: number;
  background?: SolidPaint;
  skipped?: boolean;
}

function parseNewSlides(raw: unknown): NewSlide[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw invalid("`slides` must be a list of 1–20 slides.", "Add 3–5 slides per call, then their content with one figma_create_from_spec per slide.");
  }
  return raw.map((item, i): NewSlide => {
    const at = `slides[${i}]`;
    if (!isObject(item)) throw invalid(`\`${at}\` must be an object: { name?, row?, col?, background?, skipped? }.`);
    onlyKeys(item, ["name", "row", "col", "background", "skipped"], at);
    const out: NewSlide = {};
    const name = textAt(item.name, `${at}.name`, 200);
    if (name !== undefined) out.name = name;
    const row = wholeAt(item.row, `${at}.row`);
    if (row !== undefined) out.row = row;
    const col = wholeAt(item.col, `${at}.col`);
    if (col !== undefined) out.col = col;
    if (item.background !== undefined) out.background = parseColor(item.background, `${at}.background`);
    const skipped = boolAt(item.skipped, `${at}.skipped`);
    if (skipped !== undefined) out.skipped = skipped;
    return out;
  });
}

const createSlides: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { items, plan } = await beforeMutating(() => {
      const items = parseNewSlides(ctx.params.slides);
      const read = requireGrid("figma_create_slides");
      if (!apiHas("createSlide")) throw new BridgeError(ErrorCode.UNSUPPORTED, "figma.createSlide is not available here.");
      const plan = planCreates(read.rows.map((r) => r.slides.length), items);
      if (plan.some((pl) => pl.call === "newRow") && !apiHas("createSlideRow")) {
        throw new BridgeError(ErrorCode.UNSUPPORTED, "figma.createSlideRow is not available here, so no new row can be opened.", { hint: "Add the slides to an existing row." });
      }
      return { items, plan };
    });

    const figma = api();
    const created: Array<{ id: string; name: string; path: string }> = [];
    const made: SlideNodeLike[] = [];
    const rowsCreated: string[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const pl = plan[i]!;
      const at = `slides[${i}]`;
      try {
        if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled between slides.");
        const rowsBefore = requireGrid("figma_create_slides").rows.map((r) => r.node.id);
        let slide: SlideNodeLike;
        if (pl.call === "newRow") {
          const row = figma.createSlideRow(pl.row);
          rowsCreated.push(row.id);
          created.push({ id: row.id, name: row.name, path: `${at}.row` });
          slide = figma.createSlide(pl.row, 0);
        } else if (pl.call === "at") {
          slide = figma.createSlide(pl.row, pl.col);
        } else {
          slide = figma.createSlide();
        }
        made.push(slide);
        const entry = { id: slide.id, name: slide.name, path: at };
        created.push(entry);
        // The first slide of an empty deck makes its row itself [C-164].
        const after = requireGrid("figma_create_slides");
        for (const r of after.rows) {
          if (!rowsBefore.includes(r.node.id) && !rowsCreated.includes(r.node.id)) {
            rowsCreated.push(r.node.id);
            created.push({ id: r.node.id, name: r.node.name, path: `${at}.row` });
          }
        }
        const where = landed(after, slide);
        if (!where || where.row !== pl.row || where.col !== pl.col) {
          warnings.push(`${at}: planned at row ${pl.row} col ${pl.col}, Figma put it ${where ? `at row ${where.row} col ${where.col}` : "outside the grid"}.`);
        }
        const s = slide as unknown as Record<string, unknown>;
        if (item.name !== undefined) slide.name = item.name;
        // Rows and the grid are opaque: a background belongs on the slide (slide-gotchas.md:200-202) [C-136].
        if (item.background) s.fills = [item.background];
        if (item.skipped !== undefined) s.isSkippedSlide = item.skipped;
        entry.name = slide.name;
      } catch (err) {
        const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, errText(err));
        throw new BridgeError(e.code, e.message, {
          hint: created.length
            ? `${created.length} node(s) were made before the failure (partial.created): press Ctrl+Z to undo the whole call, or continue from partial.failedAt.`
            : "Nothing was created.",
          partial: { created, failedAt: at },
        });
      }
      ctx.progress(i + 1, items.length, "creating");
      await ctx.yieldToHost();
    }

    const read = requireGrid("figma_create_slides");
    const pos = positionsOf(read);
    return {
      slides: made.map((s) => ({ id: s.id, name: s.name, ...(pos.get(s.id) ?? {}) })),
      rowCount: read.rows.length,
      slideCount: slideCount(read),
      ...(rowsCreated.length ? { rowsCreated } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

// ── figma_set_slide_grid ────────────────────────────────────────────────────

interface RowAsk {
  slideIds: string[];
  name?: string;
}

function parseRows(raw: unknown): RowAsk[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) throw invalid("`rows` must be a list of 1–200 rows.");
  return raw.map((r, i): RowAsk => {
    const at = `rows[${i}]`;
    if (!isObject(r)) throw invalid(`\`${at}\` must be an object: { slideIds, name? }.`);
    onlyKeys(r, ["slideIds", "name"], at);
    if (!Array.isArray(r.slideIds) || r.slideIds.length === 0 || r.slideIds.length > 500 || !r.slideIds.every((x) => typeof x === "string" && x.trim() !== "")) {
      throw invalid(`\`${at}.slideIds\` must be a list of 1–500 slide ids.`);
    }
    const name = textAt(r.name, `${at}.name`, 60);
    return { slideIds: r.slideIds as string[], ...(name !== undefined ? { name } : {}) };
  });
}

const rowsOut = (read: GridRead) => read.rows.map((r) => ({ rowId: r.node.id, index: r.index, name: r.node.name, slideIds: r.slides.map((s) => s.id) }));

/** Rows that existed before and are gone after — Figma pruned the ones the write emptied, if it prunes [C-164]. */
const rowsGone = (before: GridRead, after: GridRead) => before.rows.map((r) => r.node.id).filter((id) => !after.rows.some((r) => r.node.id === id));

const setSlideGrid: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { asked, before, nodes } = await beforeMutating(() => {
      const asked = parseRows(ctx.params.rows);
      const before = requireGrid("figma_set_slide_grid");
      const current = idRows(before).flat();
      const bad = gridProblems(current, asked.map((r) => r.slideIds));
      if (bad.missing.length || bad.duplicate.length || bad.unknown.length) {
        const parts = [
          bad.missing.length ? `Missing: ${listed(bad.missing)}.` : "",
          bad.duplicate.length ? `Repeated: ${listed(bad.duplicate)}.` : "",
          bad.unknown.length ? `Not slides of this deck: ${listed(bad.unknown)}.` : "",
        ].filter(Boolean);
        throw invalid(
          "`rows` must list every slide of the deck exactly once — Figma refuses a grid that leaves one out, and this tool never removes a slide.",
          `${parts.join(" ")} figma_get_slide_grid lists the slides; figma_move_slides moves a few without restating the deck.`,
        );
      }
      if (!gridWriter()) throw new BridgeError(ErrorCode.UNSUPPORTED, "Neither figma.setCanvasGrid nor figma.setSlideGrid is available here.");
      const byId = new Map(before.rows.flatMap((r) => r.slides).map((s) => [s.id, s]));
      return { asked, before, nodes: asked.map((r) => r.slideIds.map((id) => byId.get(id)!)) };
    });

    const was = positionsOf(before);
    const via = writeGrid(nodes);
    let after = requireGrid("figma_set_slide_grid");
    // Names follow the slides, not the index: whether Figma keeps rows by index
    // across a regroup is unmeasured [C-164], so each name goes to the row that
    // now holds exactly the slides it was asked for.
    let renamed = 0;
    const warnings: string[] = [];
    asked.forEach((r, i) => {
      if (r.name === undefined) return;
      const key = r.slideIds.join(",");
      const row = after.rows.find((x) => x.slides.map((s) => s.id).join(",") === key);
      if (!row) {
        warnings.push(`rows[${i}]: no row holds exactly these slides after the write, so its name was not set.`);
        return;
      }
      if (row.node.name !== r.name) {
        row.node.name = r.name;
        renamed++;
      }
    });
    after = requireGrid("figma_set_slide_grid");
    const now = positionsOf(after);
    const moved = [...now].filter(([id, p]) => {
      const old = was.get(id);
      return !old || old.row !== p.row || old.col !== p.col;
    }).length;
    const empty = after.rows.filter((r) => r.slides.length === 0).map((r) => ({ rowId: r.node.id, index: r.index, name: r.node.name }));
    const removed = rowsGone(before, after);
    return {
      rows: rowsOut(after),
      moved,
      renamed,
      via,
      ...(empty.length ? { emptyRows: empty } : {}),
      ...(removed.length ? { emptyRowsRemoved: removed } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

// ── figma_move_slides ───────────────────────────────────────────────────────

const moveSlides: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = ctx.params;
    const { before, ids, refused, grid } = await beforeMutating(async () => {
      const ids = idList(p.slideIds, "slideIds", 200);
      const anchors = (["afterSlideId", "beforeSlideId", "row"] as const).filter((k) => p[k] !== undefined);
      if (anchors.length !== 1) {
        throw invalid(`Give exactly one of \`afterSlideId\`, \`beforeSlideId\` or \`row\`${anchors.length ? ` (got ${anchors.join(", ")})` : ""}.`);
      }
      if (p.col !== undefined && p.row === undefined) throw invalid("`col` goes with `row`.");
      let anchor: MoveAnchor;
      if (p.row !== undefined) {
        const row = wholeAt(p.row, "row")!;
        const col = wholeAt(p.col, "col");
        anchor = col === undefined ? { row } : { row, col };
      } else {
        const key = anchors[0] as "afterSlideId" | "beforeSlideId";
        const ref = str(p, key);
        if (!ref) throw invalid(`\`${key}\` must be a slide id.`);
        anchor = key === "afterSlideId" ? { after: ref } : { before: ref };
      }
      const before = requireGrid("figma_move_slides");
      const inGrid = new Set(idRows(before).flat());
      const refused: Array<{ id: string; ok: false; error: string }> = [];
      for (const id of ids) if (!inGrid.has(id)) refused.push({ id, ok: false, error: await notASlide(id) });
      const moving = ids.filter((id) => inGrid.has(id));
      if (!moving.length) {
        throw invalid("None of `slideIds` is a slide of this deck.", refused.map((r) => `${r.id}: ${r.error}`).join("; "));
      }
      const grid = planMove(idRows(before), moving, anchor);
      if (!gridWriter()) throw new BridgeError(ErrorCode.UNSUPPORTED, "Neither figma.setCanvasGrid nor figma.setSlideGrid is available here.");
      return { before, ids, refused, grid };
    });

    const byId = new Map(before.rows.flatMap((r) => r.slides).map((s) => [s.id, s]));
    writeGrid(grid.map((r) => r.map((id) => byId.get(id)!)));
    const after = requireGrid("figma_move_slides");
    const pos = positionsOf(after);
    const items = ids.map((id) => {
      const no = refused.find((r) => r.id === id);
      if (no) return no;
      const at = pos.get(id);
      return at ? { id, ok: true, ...at } : { id, ok: false, error: "not in the grid after the move" };
    });
    const emptied = before.rows
      .filter((r) => r.slides.length > 0)
      .filter((r) => {
        const now = after.rows.find((x) => x.node.id === r.node.id);
        return !now || now.slides.length === 0;
      })
      .map((r) => ({ rowId: r.node.id, name: r.node.name, removed: !after.rows.some((x) => x.node.id === r.node.id) }));
    return {
      moved: items.filter((i) => i.ok).length,
      items,
      rows: after.rows.map((r) => ({ rowId: r.node.id, index: r.index, name: r.node.name, slideCount: r.slides.length })),
      ...(emptied.length ? { emptiedRows: emptied } : {}),
    };
  },
};

// ── figma_set_slide_properties ──────────────────────────────────────────────

interface PropsAsk {
  slideId: string;
  skipped?: boolean;
  speakerNotes?: string;
}

function parseProps(raw: unknown): PropsAsk[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw invalid("`slides` must be a list of 1–500 { slideId, skipped?, speakerNotes? }.");
  const seen = new Set<string>();
  return raw.map((item, i): PropsAsk => {
    const at = `slides[${i}]`;
    if (!isObject(item)) throw invalid(`\`${at}\` must be an object: { slideId, skipped?, speakerNotes? }.`);
    onlyKeys(item, ["slideId", "skipped", "speakerNotes"], at);
    const slideId = typeof item.slideId === "string" && item.slideId.trim() ? item.slideId : undefined;
    if (!slideId) throw invalid(`\`${at}.slideId\` must be a slide id.`);
    if (seen.has(slideId)) throw invalid(`\`${at}.slideId\`: ${slideId} is listed twice.`);
    seen.add(slideId);
    const skipped = boolAt(item.skipped, `${at}.skipped`);
    const speakerNotes = textAt(item.speakerNotes, `${at}.speakerNotes`, 20000);
    if (skipped === undefined && speakerNotes === undefined) throw invalid(`\`${at}\` sets nothing: give \`skipped\` and/or \`speakerNotes\`.`);
    return { slideId, ...(skipped !== undefined ? { skipped } : {}), ...(speakerNotes !== undefined ? { speakerNotes } : {}) };
  });
}

const setSlideProperties: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { asks, nodes } = await beforeMutating(async () => {
      const asks = parseProps(ctx.params.slides);
      const nodes = new Map<string, unknown>();
      for (const a of asks) {
        const n = await api().getNodeByIdAsync(a.slideId);
        if (n && typeOf(n) === "SLIDE") nodes.set(a.slideId, n);
      }
      // speakerNotes is in the official skill's typings, not in plugin-typings
      // 1.141.0 [C-138]: every target is checked before anything is written.
      const noNotes = asks.filter((a) => a.speakerNotes !== undefined && nodes.has(a.slideId) && !has(nodes.get(a.slideId), "speakerNotes"));
      if (noNotes.length) {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `Speaker notes are not exposed to this plugin build (no speakerNotes on ${listed(noNotes.map((a) => a.slideId))}).`, {
          hint: "Speaker notes are not exposed to this plugin build, so nothing was changed. `skipped` alone still works; write the notes in Figma's notes panel.",
        });
      }
      return { asks, nodes };
    });

    const items: Array<Record<string, unknown>> = [];
    for (const a of asks) {
      const slide = nodes.get(a.slideId) as Record<string, unknown> | undefined;
      if (!slide) {
        items.push({ id: a.slideId, ok: false, error: await notASlide(a.slideId) });
        continue;
      }
      try {
        const out: Record<string, unknown> = { id: a.slideId, ok: true };
        if (a.skipped !== undefined) {
          slide.isSkippedSlide = a.skipped;
          const back = tryGet(slide, "isSkippedSlide");
          out.skipped = back.ok ? back.value : a.skipped;
        }
        if (a.speakerNotes !== undefined) {
          slide.speakerNotes = a.speakerNotes;
          const back = tryGet(slide, "speakerNotes");
          out.speakerNotes = back.ok ? back.value : a.speakerNotes;
          const warnings = notesWarnings(a.speakerNotes);
          if (warnings.length) out.warnings = warnings;
        }
        items.push(out);
      } catch (err) {
        items.push({ id: a.slideId, ok: false, error: errText(err) });
      }
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

// ── figma_set_slide_transition ──────────────────────────────────────────────

function parseTransitionAsk(p: Record<string, unknown>): TransitionAsk {
  const style = p.style;
  if (typeof style !== "string" || !(TRANSITION_STYLES as readonly string[]).includes(style)) {
    throw invalid("`style` must be one of the slide transition styles.", `${TRANSITION_STYLES.join(", ")}.`);
  }
  const ask: TransitionAsk = { style };
  if (p.duration !== undefined) {
    if (typeof p.duration !== "number" || !(p.duration >= DURATION_RANGE.min && p.duration <= DURATION_RANGE.max)) {
      throw invalid("`duration` is in seconds, 0.01–10.");
    }
    ask.duration = p.duration;
  }
  if (p.curve !== undefined) {
    if (typeof p.curve !== "string" || !(TRANSITION_CURVES as readonly string[]).includes(p.curve)) {
      throw invalid("`curve` must be one of the transition curves.", `${TRANSITION_CURVES.join(", ")}.`);
    }
    ask.curve = p.curve;
  }
  if (p.timing !== undefined) {
    if (p.timing !== "on-click" && p.timing !== "after-delay") throw invalid('`timing` must be "on-click" or "after-delay".');
    ask.timing = p.timing;
  }
  if (p.delay !== undefined) {
    if (typeof p.delay !== "number" || !(p.delay >= DELAY_RANGE.min && p.delay <= DELAY_RANGE.max)) throw invalid("`delay` is in seconds, 0–30.");
    ask.delay = p.delay;
  }
  if (ask.timing === "on-click" && ask.delay !== undefined) {
    throw invalid("`delay` goes with timing \"after-delay\": with on-click Figma sets it to 0.", 'Pass timing: "after-delay" with the delay, or leave the delay out.');
  }
  return ask;
}

const setSlideTransition: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const plan = await beforeMutating(async () => {
      const ids = idList(ctx.params.slideIds, "slideIds", 500);
      const ask = parseTransitionAsk(ctx.params);
      const found: Array<{ id: string; slide: unknown } | { id: string; error: string }> = [];
      for (const id of ids) {
        const n = await api().getNodeByIdAsync(id);
        found.push(n && typeOf(n) === "SLIDE" ? { id, slide: n } : { id, error: await notASlide(id) });
      }
      if (!found.some((f) => "slide" in f)) {
        throw invalid("None of `slideIds` is a slide.", found.map((f) => `${f.id}: ${"error" in f ? f.error : ""}`).join("; "));
      }
      // The typings and the public guide document transitions; the official
      // skill says both calls throw "not implemented" [C-139]. Each slide's
      // current transition is read first — it is also what fields left out keep.
      return found.map((f) => {
        if (!("slide" in f)) return f;
        if (!has(f.slide, "setSlideTransition")) {
          throw new BridgeError(ErrorCode.UNSUPPORTED, "setSlideTransition is not available on slides in this Figma build.", { hint: "Nothing was changed." });
        }
        const cur = readTransition(f.slide);
        if (!cur.ok) {
          throw new BridgeError(ErrorCode.UNSUPPORTED, `Figma could not read slide ${f.id}'s transition: ${cur.message}`, {
            hint: "Slide transitions are not available to this plugin build. Nothing was changed; set them in Figma's Prototype panel.",
          });
        }
        return { ...f, next: mergeTransition(cur.value, ask, f.id) };
      });
    });

    const items: Array<Record<string, unknown>> = [];
    for (const t of plan) {
      if (!("next" in t)) {
        items.push({ id: t.id, ok: false, error: "error" in t ? t.error : "not a slide" });
        continue;
      }
      try {
        (t.slide as { setSlideTransition(x: Transition): void }).setSlideTransition(t.next);
        const back = readTransition(t.slide);
        items.push({ id: t.id, ok: true, transition: transitionOut(back.ok ? back.value : t.next) });
      } catch (err) {
        items.push({ id: t.id, ok: false, error: errText(err) });
      }
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

/** Wired into PLUGIN_OPS by the integrator (src/plugin/ops/index.ts). */
export const SLIDES_OPS: Record<string, PluginOp> = {
  get_slide_grid: getSlideGrid,
  create_slides: createSlides,
  set_slide_grid: setSlideGrid,
  move_slides: moveSlides,
  set_slide_properties: setSlideProperties,
  set_slide_transition: setSlideTransition,
};
