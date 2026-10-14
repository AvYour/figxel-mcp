// Grid placement for things whose real size is known only after they exist.
//
// A sticky grows taller with its text and keeps its width (240, or 416 when
// wide), so a grid laid out from one measured sticky overlaps [C-147]. The
// official recipe is two passes: create and fill everything, then place each
// row from the sizes Figma reports — x advances by each item's own width, y by
// the TALLEST item of the row; columns need not line up across rows
// (figma-use-figjam create-sticky.md "Two-pass layout"). Pure, so the stickies
// and shapes tools and the spec builder's `arrange` share one implementation.

export interface Size {
  w: number;
  h: number;
}

export interface GridOptions {
  /** Items per row, ≥ 1. */
  columns: number;
  /** Space between items, horizontally and between rows. */
  gap: number;
  /** Top-left of the first item; default 0,0. */
  origin?: { x: number; y: number };
}

export interface Placed {
  x: number;
  y: number;
  row: number;
  col: number;
}

export interface GridResult {
  positions: Placed[];
  /** The box the placed items cover, from the origin. */
  bounds: { x: number; y: number; width: number; height: number };
}

export function placeGrid(sizes: readonly Size[], opts: GridOptions): GridResult {
  if (!Number.isInteger(opts.columns) || opts.columns < 1) throw new RangeError(`columns must be an integer ≥ 1, got ${opts.columns}`);
  if (!Number.isFinite(opts.gap) || opts.gap < 0) throw new RangeError(`gap must be a number ≥ 0, got ${opts.gap}`);
  const ox = opts.origin?.x ?? 0;
  const oy = opts.origin?.y ?? 0;
  const positions: Placed[] = [];
  let y = oy;
  let width = 0;
  for (let start = 0; start < sizes.length; start += opts.columns) {
    const rowItems = sizes.slice(start, start + opts.columns);
    let x = ox;
    let tallest = 0;
    rowItems.forEach((s, col) => {
      if (!Number.isFinite(s.w) || !Number.isFinite(s.h) || s.w < 0 || s.h < 0) {
        throw new RangeError(`size ${start + col} must be finite and ≥ 0, got ${s.w}×${s.h}`);
      }
      positions.push({ x, y, row: start / opts.columns, col });
      x += s.w + opts.gap;
      tallest = Math.max(tallest, s.h);
    });
    width = Math.max(width, x - opts.gap - ox);
    y += tallest + opts.gap;
  }
  const height = sizes.length ? y - opts.gap - oy : 0;
  return { positions, bounds: { x: ox, y: oy, width: sizes.length ? width : 0, height } };
}

/**
 * Columns for an `arrange` string — one string rather than a union (tools.md §
 * Conventions): "row" puts all `count` items in one row, "column" one per row,
 * "grid:N" N per row. Throws RangeError naming the value; callers turn it into
 * INVALID_PARAM with their own path.
 */
export function arrangeColumns(arrange: string, count: number): number {
  const a = arrange.trim().toLowerCase();
  if (a === "row") return Math.max(1, count);
  if (a === "column") return 1;
  const m = /^grid:(\d+)$/.exec(a);
  if (m && Number(m[1]) >= 1) return Number(m[1]);
  throw new RangeError(`"${arrange}" is not an arrangement: use "row", "column" or "grid:N" (N ≥ 1)`);
}
