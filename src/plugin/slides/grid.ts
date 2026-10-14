// The slide grid of a Figma Slides file: read it as the node tree holds it,
// plan a change against it without touching the document, write it back in
// one call, and read or switch the Slides view.
//
// The tree is the source of truth: the page's SLIDE_GRID holds SLIDE_ROW
// children, each holding SLIDE children (ChildrenMixin, d.ts:12325, 12338)
// [C-136]. getCanvasGrid / getSlideGrid (d.ts:2070, 2029) return plain arrays
// of slides — not row nodes, so no row id or name (slide-grid.md:43) — and
// whether they list an emptied row is unmeasured [C-164], so here they are
// only a cross-check.
//
// Rows and the grid are opaque: reading fills, effects or layout on them throws
// "no such property" (slide-gotchas.md:181-203) [C-136] [C-145]. Only id, name,
// type and children are read on them, and every optional member goes through
// safe.ts.
//
// Structural types only (no plugin typings), so the tests run it against fakes.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { apiHas, editorType, figmaGlobal, has, tryGet } from "../safe.js";

export interface SlideNodeLike {
  readonly id: string;
  name: string;
  readonly type: string;
}

export interface RowNodeLike {
  readonly id: string;
  name: string;
  readonly type: string;
}

export interface GridNodeLike {
  readonly id: string;
  readonly type: string;
}

export interface GridRow {
  node: RowNodeLike;
  index: number;
  slides: SlideNodeLike[];
}

export interface GridRead {
  node: GridNodeLike;
  rows: GridRow[];
}

/** Where a slide sits: its row, its column in that row, and its place in the presentation (row-major). */
export interface SlidePosition {
  row: number;
  col: number;
  index: number;
}

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

function childrenOf(node: unknown): unknown[] {
  const got = tryGet<readonly unknown[]>(node, "children");
  return got.ok && Array.isArray(got.value) ? [...got.value] : [];
}

export function typeOf(node: unknown): string | undefined {
  const got = tryGet(node, "type");
  return got.ok && typeof got.value === "string" ? got.value : undefined;
}

/** The page's SLIDE_GRID, or null outside a Slides file. A deck has one page, whose first child is the grid (slide-grid.md:7). */
export function findGridNode(): GridNodeLike | null {
  const page = tryGet(figmaGlobal(), "currentPage");
  if (!page.ok) return null;
  for (const child of childrenOf(page.value)) if (typeOf(child) === "SLIDE_GRID") return child as GridNodeLike;
  return null;
}

/** The deck as rows of slides, from the node tree; null when the current page has no slide grid. */
export function readGrid(): GridRead | null {
  const node = findGridNode();
  if (!node) return null;
  const rows = childrenOf(node)
    .filter((r) => typeOf(r) === "SLIDE_ROW")
    .map((r, index): GridRow => ({ node: r as RowNodeLike, index, slides: childrenOf(r).filter((s) => typeOf(s) === "SLIDE") as SlideNodeLike[] }));
  return { node, rows };
}

/** readGrid, or the refusal a Slides tool gives anywhere else. */
export function requireGrid(tool: string): GridRead {
  const read = readGrid();
  if (read) return read;
  throw new BridgeError(ErrorCode.UNSUPPORTED, `${tool} works in Figma Slides files, and this page has no slide grid (editorType "${editorType() ?? "unknown"}").`, {
    hint: "Open the deck in Figma Slides and run the plugin there; figma_status shows each connected file's editor.",
  });
}

export function positionsOf(read: GridRead): Map<string, SlidePosition> {
  const out = new Map<string, SlidePosition>();
  let index = 0;
  for (const r of read.rows) r.slides.forEach((s, col) => out.set(s.id, { row: r.index, col, index: index++ }));
  return out;
}

export const idRows = (read: GridRead): string[][] => read.rows.map((r) => r.slides.map((s) => s.id));
export const slideCount = (read: GridRead): number => read.rows.reduce((n, r) => n + r.slides.length, 0);

/**
 * The grid as Figma's own grid call reports it, as ids: getCanvasGrid
 * (current) else getSlideGrid (deprecated, d.ts:2027) [C-134].
 */
export function apiGridIds(): { ok: true; rows: string[][]; via: string } | { ok: false; message: string } {
  const figma = figmaGlobal() as Record<string, () => ReadonlyArray<ReadonlyArray<{ id: string }>>>;
  for (const name of ["getCanvasGrid", "getSlideGrid"]) {
    if (!apiHas(name)) continue;
    try {
      return { ok: true, rows: figma[name]!().map((r) => r.map((s) => s.id)), via: name };
    } catch (err) {
      return { ok: false, message: `${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, message: "neither getCanvasGrid nor getSlideGrid is available" };
}

/** The call that writes the grid here, or null: setCanvasGrid (d.ts:2093), else the deprecated setSlideGrid (d.ts:2053). */
export function gridWriter(): "setCanvasGrid" | "setSlideGrid" | null {
  if (apiHas("setCanvasGrid")) return "setCanvasGrid";
  if (apiHas("setSlideGrid")) return "setSlideGrid";
  return null;
}

/**
 * Write the whole grid in ONE call, so a reorder is one change and one undo
 * step. Figma refuses a grid that leaves out a current slide (d.ts:2048-2049)
 * [C-134]; callers check that first, so its refusal is a backstop.
 */
export function writeGrid(rows: ReadonlyArray<ReadonlyArray<SlideNodeLike>>): string {
  const via = gridWriter();
  if (!via) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "Neither figma.setCanvasGrid nor figma.setSlideGrid is available, so the slide grid cannot be changed here.");
  }
  const figma = figmaGlobal() as Record<string, (grid: SlideNodeLike[][]) => void>;
  figma[via]!(rows.map((r) => [...r]));
  return via;
}

// ── planning, pure ──────────────────────────────────────────────────────────

/** How a new slide is made: createSlide() (end of the deck), createSlide(row, col), or a new row first. */
export type CreateCall = "default" | "at" | "newRow";

export interface Placement {
  row: number;
  col: number;
  call: CreateCall;
}

/**
 * Where each new slide lands, in list order, against the grid the earlier
 * items left. `shape` is the slide count per row. Throws INVALID_PARAM naming
 * the item, so nothing is created when one position is wrong.
 *
 * On a deck with no rows, the first slide is made by createSlide() with no
 * arguments, which makes row 0 (slide-grid.md:5-19) [C-164]; it is the
 * documented default either way (d.ts:1186). An omitted row is the end of the
 * last row, createSlide()'s own default. A row equal to the row count opens a
 * new row (createSlideRow, d.ts:1218).
 */
export function planCreates(shape: readonly number[], items: ReadonlyArray<{ row?: number; col?: number }>, path = "slides"): Placement[] {
  const rows = [...shape];
  return items.map((item, i): Placement => {
    const at = `${path}[${i}]`;
    if (item.col !== undefined && item.row === undefined) {
      throw invalid(`\`${at}.col\` needs \`${at}.row\`.`, "Give both, or neither to add the slide at the end of the deck.");
    }
    if (rows.length === 0) {
      if ((item.row ?? 0) !== 0 || (item.col ?? 0) !== 0) {
        throw invalid(`\`${at}\`: the deck has no rows yet, so its first slide makes row 0.`, "Pass row 0 and col 0, or leave both out.");
      }
      rows.push(1);
      return { row: 0, col: 0, call: "default" };
    }
    if (item.row === undefined) {
      const row = rows.length - 1;
      const col = rows[row]!;
      rows[row] = col + 1;
      return { row, col, call: "default" };
    }
    const row = item.row;
    if (row > rows.length) {
      throw invalid(`\`${at}.row\` is ${row}, but the deck has ${rows.length} row(s) at that point.`, `Use 0–${rows.length - 1}, or ${rows.length} to open a new last row.`);
    }
    if (row === rows.length) {
      if ((item.col ?? 0) !== 0) throw invalid(`\`${at}.col\`: row ${row} is a new, empty row, so its first slide is col 0.`);
      rows.push(1);
      return { row, col: 0, call: "newRow" };
    }
    const len = rows[row]!;
    const col = item.col ?? len;
    if (col > len) throw invalid(`\`${at}.col\` is ${col}, but row ${row} holds ${len} slide(s) at that point.`, `Use 0–${len} (${len} = the end of the row).`);
    rows[row] = len + 1;
    return { row, col, call: "at" };
  });
}

export type MoveAnchor = { after: string } | { before: string } | { row: number; col?: number };

/**
 * The grid after moving `moving` as one block, in its order. Rows keep their
 * places, emptied ones included, so the rows after them keep their indexes —
 * and, if Figma maps rows by index, their names [C-164]. `row` / `col` count
 * positions once the moving slides are out. Throws before anything is written.
 */
export function planMove(grid: ReadonlyArray<readonly string[]>, moving: readonly string[], anchor: MoveAnchor): string[][] {
  const out = new Set(moving);
  const rows = grid.map((r) => r.filter((id) => !out.has(id)));
  if ("row" in anchor) {
    if (anchor.row > rows.length) {
      throw invalid(`\`row\` is ${anchor.row}, but the deck has ${rows.length} row(s).`, `Use 0–${rows.length - 1}, or ${rows.length} to open a new last row.`);
    }
    if (anchor.row === rows.length) {
      if ((anchor.col ?? 0) !== 0) throw invalid(`\`col\`: row ${anchor.row} is a new, empty row, so the slides start at col 0.`);
      rows.push([...moving]);
      return rows;
    }
    const target = rows[anchor.row]!;
    const col = anchor.col ?? target.length;
    if (col > target.length) {
      throw invalid(`\`col\` is ${col}, but row ${anchor.row} holds ${target.length} slide(s) once the moved ones are out.`, `Use 0–${target.length}.`);
    }
    target.splice(col, 0, ...moving);
    return rows;
  }
  const after = "after" in anchor;
  const ref = after ? anchor.after : anchor.before;
  const field = after ? "afterSlideId" : "beforeSlideId";
  if (out.has(ref)) throw invalid(`\`${field}\` ${ref} is one of the slides being moved.`, "Anchor on a slide that stays where it is.");
  for (const r of rows) {
    const i = r.indexOf(ref);
    if (i >= 0) {
      r.splice(after ? i + 1 : i, 0, ...moving);
      return rows;
    }
  }
  throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `\`${field}\` ${ref} is not a slide in this deck.`, { hint: "figma_get_slide_grid lists the slides." });
}

/** What keeps `rows` from being a valid grid: current slides it leaves out, ids it repeats, ids that are not current slides. */
export function gridProblems(current: readonly string[], rows: ReadonlyArray<readonly string[]>): { missing: string[]; duplicate: string[]; unknown: string[] } {
  const known = new Set(current);
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  for (const r of rows) {
    for (const id of r) {
      if (seen.has(id)) {
        if (!duplicate.includes(id)) duplicate.push(id);
        continue;
      }
      seen.add(id);
      if (!known.has(id)) unknown.push(id);
    }
  }
  return { missing: current.filter((id) => !seen.has(id)), duplicate, unknown };
}

// ── the view ────────────────────────────────────────────────────────────────

/**
 * The viewport property that holds the Slides view, in the order tried:
 * canvasView (d.ts:3386, 'grid' | 'single-asset'), its deprecated sibling
 * slidesView (d.ts:3358, 'grid' | 'single-slide'), and slidesMode, the
 * spelling of the public Working in Slides guide. The three sources disagree
 * [C-140], so each is feature-detected and read back after a write.
 */
export const VIEW_PROPS = ["canvasView", "slidesView", "slidesMode"] as const;
export type SlidesView = "grid" | "single-slide";
const SINGLE: Record<(typeof VIEW_PROPS)[number], string> = { canvasView: "single-asset", slidesView: "single-slide", slidesMode: "single-slide" };

const viewportOf = (): unknown => {
  const got = tryGet(figmaGlobal(), "viewport");
  return got.ok ? got.value : undefined;
};

/** The current view, from the first view property that reads as a string; "single-asset" reads as "single-slide". */
export function readView(): { view: string; via: string } | null {
  const viewport = viewportOf();
  for (const prop of VIEW_PROPS) {
    const got = tryGet(viewport, prop);
    if (got.ok && typeof got.value === "string") return { view: got.value === "single-asset" ? "single-slide" : got.value, via: prop };
  }
  return null;
}

/**
 * Switch the view through the first property that takes the value and reads it
 * back. Every attempt that did not stick is reported, so a live run settles
 * which spelling this Figma build has [C-140].
 */
export function setView(view: SlidesView): { ok: true; via: string } | { ok: false; tried: string[] } {
  const viewport = viewportOf();
  const tried: string[] = [];
  for (const prop of VIEW_PROPS) {
    if (!has(viewport, prop)) continue;
    const value = view === "grid" ? "grid" : SINGLE[prop];
    try {
      (viewport as Record<string, unknown>)[prop] = value;
    } catch (err) {
      tried.push(`${prop}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const back = tryGet(viewport, prop);
    if (back.ok && back.value === value) return { ok: true, via: prop };
    tried.push(`${prop}: set to "${value}" but reads ${back.ok ? JSON.stringify(back.value) : back.message}`);
  }
  return { ok: false, tried };
}

/** currentPage.focusedSlide's id (d.ts:10737), or null when there is none or it cannot be read. */
export function focusedSlideId(): string | null {
  const page = tryGet(figmaGlobal(), "currentPage");
  const got = page.ok ? tryGet<{ id?: unknown } | null>(page.value, "focusedSlide") : page;
  return got.ok && got.value && typeof got.value.id === "string" ? got.value.id : null;
}
