// The fonts this Figma can load, grouped by family once per plugin session.
//
// listAvailableFontsAsync() returns every style, flat: 10,038 styles in 2,284
// families on the machine of the 2026-10-13 acceptance run. figma_suggest_fonts
// grouped that list on every call with no yield, then read the page yielding
// every 300 layers but never reporting progress, and was declared STALLED twice
// (the C-124 failure mode). So the list is asked for once, grouped in time
// slices that report progress, and kept for the session — the plugin's run,
// keyed on its `figma` object, so a test's fresh fake starts empty too.
//
// A lookup that must see a font installed since — a load that just failed, an
// agent checking whether a family is there — asks for a fresher list with
// `maxAgeMs`; everything else reuses the session's.

import { forEachChunked, type YieldToHost } from "./chunk.js";

export interface FontFamily {
  /** The family as Figma spells it. */
  family: string;
  /** Its styles as Figma names them ("SemiBold" or "Semi Bold"), in Figma's order, without duplicates. */
  styles: string[];
}

export interface FontIndex {
  /** Lower-cased family name → the family. */
  byFamily: ReadonlyMap<string, FontFamily>;
  /** Every family, sorted by name, case-insensitively. */
  families: readonly FontFamily[];
  /** How many styles Figma listed. */
  styles: number;
  /** When the list was read (Date.now()). */
  at: number;
}

type FontName = { family: string; style: string };

export interface FontLister {
  listAvailableFontsAsync?(): Promise<ReadonlyArray<{ fontName: FontName }>>;
}

/** The op context's pacing members: a slice that spends its budget reports progress, then yields. */
export interface Pace {
  yieldToHost: YieldToHost;
  isCancelled(): boolean;
  progress?(done: number, total?: number, phase?: string): void;
}

let cache = new WeakMap<object, { list: unknown; index: FontIndex }>();

/**
 * The machine's fonts by family, or null where the editor cannot list fonts.
 * Reused for the session unless it is older than `maxAgeMs`. With `pace` the
 * grouping runs in 12 ms slices with progress (chunk.ts, spec §5.5); without
 * it, in one go — for callers that are not ops.
 */
export async function fontIndex(figma: FontLister, opts: { pace?: Pace; maxAgeMs?: number } = {}): Promise<FontIndex | null> {
  const list = figma.listAvailableFontsAsync;
  if (typeof list !== "function") return null;
  const hit = cache.get(figma);
  // The same lister too: a test fake that swaps it is a different machine.
  if (hit && hit.list === list && Date.now() - hit.index.at <= (opts.maxAgeMs ?? Infinity)) return hit.index;

  const pace = opts.pace;
  // One host call that cannot report while it runs: say so before it starts.
  pace?.progress?.(0, undefined, "listing fonts");
  const all = await list.call(figma);
  const byFamily = new Map<string, FontFamily>();
  const add = (f: { fontName: FontName }) => {
    const { family, style } = f.fontName;
    const key = family.toLowerCase();
    let entry = byFamily.get(key);
    if (!entry) byFamily.set(key, (entry = { family, styles: [] }));
    if (!entry.styles.includes(style)) entry.styles.push(style);
  };
  if (pace) {
    await forEachChunked(all, add, {
      yieldToHost: pace.yieldToHost,
      isCancelled: () => pace.isCancelled(),
      onProgress: (done, total) => pace.progress?.(done, total, "indexing fonts"),
    });
  } else {
    for (const f of all) add(f);
  }
  const keyed = [...byFamily.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const index: FontIndex = { byFamily, families: keyed.map(([, f]) => f), styles: all.length, at: Date.now() };
  cache.set(figma, { list, index });
  return index;
}

/** Test seam: forget every cached list. */
export function resetFontIndex(): void {
  cache = new WeakMap();
}
