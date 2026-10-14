// Mixed-style text, read back the way it was written: a bold word, a coloured
// price or a link inside one TEXT node is a run with its own font, colour or
// link. figma_set_text_range writes them; without this, a read reports
// "mixed" and the run is lost to design-to-code and to an agent checking its
// own work.
//
// API per @figma/plugin-typings 1.141.0: TextNode.getStyledTextSegments(fields,
// start, end) splits the text wherever any requested field changes, and each
// segment carries the requested fields plus characters / start / end. The
// paragraph-level fields (list, link target, spacing) are read from here too
// [C-103].

import { isMixed, lineHeight, letterSpacing, num, r2 } from "./dialect.js";

type Any = Record<string, unknown>;

/** Every field a run can differ in, asked for in ONE call — each call re-walks the text. */
export const SEGMENT_FIELDS = [
  "fontName", "fontWeight", "fontSize", "fills", "textDecoration", "textCase", "letterSpacing", "lineHeight",
  "hyperlink", "textStyleId", "listOptions",
] as const;

export interface Segment {
  start: number;
  end: number;
  characters: string;
  fontName?: { family: string; style: string };
  fontWeight?: number;
  fontSize?: number;
  fills?: unknown[];
  textDecoration?: string;
  textCase?: string;
  letterSpacing?: unknown;
  lineHeight?: unknown;
  hyperlink?: { type: string; value: string } | null;
  textStyleId?: string;
  listOptions?: { type: string };
}

/** The node's segments over all its text, or undefined when the API is absent or refuses. */
export function readSegments(node: unknown): Segment[] | undefined {
  const t = node as { characters?: unknown; getStyledTextSegments?: (fields: readonly string[], start?: number, end?: number) => Segment[] };
  if (typeof t.getStyledTextSegments !== "function") return undefined;
  const len = typeof t.characters === "string" ? t.characters.length : 0;
  if (len === 0) return [];
  try {
    return t.getStyledTextSegments(SEGMENT_FIELDS, 0, len);
  } catch {
    return undefined; // a font that is not loaded, or an editor without the API: the node-level read still stands
  }
}

/** A hyperlink target as one string: the URL itself, or "node:<id>" for a link to a layer in the file. */
export function linkText(h: unknown): string | undefined {
  if (isMixed(h)) return "mixed";
  const link = h as { type?: string; value?: string } | null | undefined;
  if (!link || typeof link.value !== "string") return undefined;
  return link.type === "NODE" ? `node:${link.value}` : link.value;
}

const LIST: Record<string, string> = { ORDERED: "ordered", UNORDERED: "unordered" };

/** The list kind of the text: "ordered", "unordered", "mixed" across paragraphs, or undefined for none. */
export function listKind(segments: Segment[]): string | undefined {
  const kinds = new Set(segments.map((s) => LIST[s.listOptions?.type ?? ""]).filter(Boolean));
  if (kinds.size === 0) return undefined;
  const plain = segments.some((s) => !LIST[s.listOptions?.type ?? ""]);
  return kinds.size === 1 && !plain ? [...kinds][0] : "mixed";
}

export interface RunResolvers {
  /** A paint list in the paint dialect; one string when it is one paint. */
  color(fills: unknown[]): Promise<string | string[] | undefined>;
  /** A text style's name, or undefined. */
  style(id: string): Promise<string | undefined>;
}

export interface Runs {
  runs: Any[];
  runsOmitted?: number;
}

/**
 * The runs of a mixed-style text, each carrying only the fields that differ
 * between runs — a field all runs share is already on the node, and
 * repeating it fifty times is noise. Runs follow the shown characters: past
 * `maxChars` they are counted in `runsOmitted`, not listed. Undefined for text
 * that is one run.
 */
export async function styledRuns(segments: Segment[], maxChars: number, maxRuns: number, resolve: RunResolvers): Promise<Runs | undefined> {
  if (segments.length < 2) return undefined;
  const values: Any[] = [];
  for (const s of segments) {
    const v: Any = {};
    if (s.fontName && typeof s.fontName === "object") v.font = `${s.fontName.family} ${s.fontName.style}`;
    if (num(s.fontWeight) !== undefined) v.weight = s.fontWeight;
    if (num(s.fontSize) !== undefined) v.size = r2(s.fontSize!);
    if (Array.isArray(s.fills)) v.color = await resolve.color(s.fills);
    if (typeof s.textDecoration === "string") v.decoration = s.textDecoration.toLowerCase();
    if (typeof s.textCase === "string") v.case = s.textCase.toLowerCase();
    v.letterSpacing = letterSpacing(s.letterSpacing) ?? "0";
    v.lineHeight = lineHeight(s.lineHeight) ?? "auto";
    v.link = linkText(s.hyperlink) ?? null;
    v.style = typeof s.textStyleId === "string" && s.textStyleId ? ((await resolve.style(s.textStyleId)) ?? s.textStyleId) : null;
    values.push(v);
  }
  const key = (x: unknown) => JSON.stringify(x ?? null);
  const varying = Object.keys(Object.assign({}, ...values)).filter((k) => new Set(values.map((v) => key(v[k]))).size > 1);
  if (varying.length === 0) return undefined; // split only by a field nobody reads (list type): one run as far as the reader can tell

  const runs: Any[] = [];
  let omitted = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.start >= maxChars || runs.length >= maxRuns) {
      omitted++;
      continue;
    }
    const shown = s.end > maxChars ? `${s.characters.slice(0, maxChars - s.start)}…` : s.characters;
    const run: Any = { start: s.start, end: s.end, characters: shown };
    for (const k of varying) {
      const v = values[i]![k];
      if (v !== undefined && v !== null) run[k] = v;
    }
    runs.push(run);
  }
  return { runs, ...(omitted ? { runsOmitted: omitted } : {}) };
}

/**
 * Private Use Area code points in SF Pro / SF Compact text, as "U+10029D":
 * those are SF Symbols. The Plugin API has no code-point → symbol-name lookup,
 * so naming them is left to the reader rather than guessed.
 */
export function sfSymbols(characters: string, families: string[]): string[] | undefined {
  if (!families.some((f) => /^SF (Pro|Compact)/.test(f))) return undefined;
  const out = new Set<string>();
  for (const ch of characters) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) out.add(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    if (out.size >= 50) break;
  }
  return out.size ? [...out] : undefined;
}
