// Typography: choosing fonts that fit a design, and changing text the way a
// designer does in the right-hand panel.
//
//   figma_suggest_fonts         read the design's type and the machine's fonts,
//                               suggest heading/body pairings and a type scale
//   figma_set_text_properties   font, weight, size, line height, spacing, case,
//                               alignment, colour on whole text nodes
//   figma_set_text_range        the same on part of a text ("make 'Pro' bold")
//
// Every suggestion is a font Figma can actually load here — the catalogue
// (fonts-catalog.ts) describes faces, listAvailableFontsAsync decides what
// exists. API per @figma/plugin-typings 1.141.0: getRangeAllFontNames,
// getStyledTextSegments, setRangeFontName / FontSize / Fills / TextDecoration /
// TextCase / Hyperlink; a text node's fonts must be loaded before it is edited.
// Paragraph and design-system members [C-103]: setRangeParagraphSpacing /
// ParagraphIndent / ListOptions / TextStyleIdAsync / FillStyleIdAsync /
// BoundVariable, and the whole-node textAlignVertical, leadingTrim,
// textWrapStyle, textTruncation and maxLines.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { forEachChunked } from "../chunk.js";
import { fontIndex } from "../font-index.js";
import { FONT_CATALOG, MOOD_WORDS, TYPE_SCALES, fontInfo, type FontInfo } from "../fonts-catalog.js";
import { byId, int, selectionOf, str, walk, type FigmaLike, type NodeLike } from "../read.js";
import {
  loadFont,
  nearestStyle,
  parseColor,
  styleWeight,
  stylesOf,
  weightParam,
  weightToStyle,
  type FigmaWrite,
} from "../write.js";
import { requireIds, resolveAll, type ItemResult } from "./modify.js";
import { findStyle, findVariable, type VariableLike } from "../bind.js";
import { beforeMutating } from "../guard.js";
import { has, tryGet } from "../safe.js";
import { loadTextFonts as loadHolderFonts, textTarget, type TextHolder, type TextTarget } from "../sublayer.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite & FigmaLike }).figma;
type Any = Record<string, unknown>;
type FontName = { family: string; style: string };

// ── reading the type a design uses ─────────────────────────────────────────

interface TextUse {
  fonts: Map<string, { family: string; styles: Set<string>; nodes: number }>;
  sizes: Map<number, number>;
  texts: Array<{ id: string; size: number | null; chars: number }>;
  /** Layers visited, and whether the whole design was read before a cap. */
  visited: number;
  complete: boolean;
}

/**
 * How much of a design figma_suggest_fonts reads: enough text to see which
 * fonts and sizes it uses, never the whole of a 20,000-layer page. By count,
 * and by time, because a slice's yield costs about a second while Figma's
 * window is in the background [C-124] — the cap keeps that case to seconds.
 */
export const TEXT_SCAN = { maxNodes: 5000, maxMs: 5000 } as const;

function fontsOfText(t: Any): FontName[] {
  const chars = typeof t.characters === "string" ? t.characters : "";
  if (chars.length && typeof t.getRangeAllFontNames === "function") {
    try {
      return (t.getRangeAllFontNames as (s: number, e: number) => FontName[])(0, chars.length);
    } catch {
      /* fall through to fontName */
    }
  }
  const f = t.fontName as FontName | symbol | undefined;
  return f && typeof f === "object" ? [f] : [];
}

/**
 * The fonts and sizes of the text under `root`, through walk(): time slices
 * that report progress at every yield [C-124], a cancel that stops the read
 * instead of ranking a half-read design, and the TEXT_SCAN caps.
 */
async function readTextUse(root: NodeLike, ctx: Pick<OpContext, "yieldToHost" | "isCancelled" | "progress">): Promise<TextUse> {
  const use: TextUse = { fonts: new Map(), sizes: new Map(), texts: [], visited: 0, complete: true };
  const started = Date.now();
  await walk(
    root,
    (node) => {
      if (use.visited >= TEXT_SCAN.maxNodes || Date.now() - started > TEXT_SCAN.maxMs) {
        use.complete = false;
        return false;
      }
      use.visited++;
      if (node.type !== "TEXT") return;
      const t = node as unknown as Any;
      const fonts = fontsOfText(t);
      for (const f of fonts) {
        const key = f.family.toLowerCase();
        const entry = use.fonts.get(key) ?? { family: f.family, styles: new Set<string>(), nodes: 0 };
        entry.styles.add(f.style);
        use.fonts.set(key, entry);
      }
      for (const key of new Set(fonts.map((f) => f.family.toLowerCase()))) use.fonts.get(key)!.nodes++;
      const size = typeof t.fontSize === "number" ? t.fontSize : null;
      if (size !== null) use.sizes.set(size, (use.sizes.get(size) ?? 0) + 1);
      use.texts.push({ id: node.id, size, chars: typeof t.characters === "string" ? t.characters.length : 0 });
    },
    { yieldToHost: ctx.yieldToHost, isCancelled: () => ctx.isCancelled(), progress: (done, total) => ctx.progress(done, total, "reading the design's text") },
    // Checked every 50 layers, not walk()'s 200: a text layer costs a font read.
    { yieldEvery: 50 },
  );
  return use;
}

// ── scoring ─────────────────────────────────────────────────────────────────

function moodTags(mood: string): Set<string> {
  const tags = new Set<string>();
  for (const word of mood.toLowerCase().split(/[\s,/+&-]+/).filter(Boolean)) {
    for (const t of MOOD_WORDS[word] ?? [word]) tags.add(t);
  }
  return tags;
}

function overlap(a: readonly string[], b: Set<string>): string[] {
  return a.filter((t) => b.has(t));
}

function pickStyle(styles: readonly string[], prefs: string[]): string | undefined {
  for (const p of prefs) {
    const hit = styles.find((s) => s.toLowerCase().replace(/\s+/g, "") === p.toLowerCase().replace(/\s+/g, ""));
    if (hit) return hit;
  }
  return undefined;
}

interface Candidate {
  family: string;
  info: FontInfo;
  known: boolean;
  styles: string[];
  matched: string[];
  body: number;
  heading: number;
}

const USE_CATEGORY: Record<string, Partial<Record<FontInfo["category"], number>>> = {
  ui: { sans: 1.5, mono: -1, display: -2, script: -3 },
  mobile: { sans: 1.5, mono: -1, display: -2, script: -3 },
  marketing: { sans: 0.5, serif: 0.5, display: 0.5, script: -1 },
  editorial: { serif: 1.5, sans: 0.3, slab: 0.5 },
  code: { mono: 2.5, sans: 0.5 },
  brand: { display: 0.8, serif: 0.5, sans: 0.5 },
};

function score(family: string, styles: string[], tags: Set<string>, use: string): Candidate | null {
  const { info, known } = fontInfo(family);
  const matched = overlap(info.tags, tags);
  if (!known && tags.size > 0 && matched.length === 0) return null; // unknown face, no evidence it fits
  const weights = new Set(styles.filter((s) => !/italic|oblique/i.test(s)).map((s) => styleWeight(s).weight));
  const hasRegular = weights.has(400);
  const hasStrong = [500, 600, 700, 800].some((w) => weights.has(w));
  const catFit = USE_CATEGORY[use]?.[info.category] ?? 0;
  const mood = matched.length * 1.5;
  const known1 = known ? 1 : 0;
  const body =
    info.roles.includes("body") && hasRegular && hasStrong && !["display", "script"].includes(info.category)
      ? 2 + mood + catFit + known1 + (weights.size >= 4 ? 0.5 : 0) + (info.tags.includes("readable") ? 0.5 : 0)
      : -Infinity;
  const heading =
    (info.roles.includes("heading") || info.roles.includes("display")) && (hasStrong || info.category === "display")
      ? 2 + mood * 1.3 + catFit * 0.6 + known1 + (info.category === "display" && use === "marketing" ? 0.5 : 0)
      : -Infinity;
  return { family, info, known, styles, matched, body, heading };
}

function headingStyle(styles: string[]): string {
  return pickStyle(styles, ["Bold", "Semi Bold", "SemiBold", "Medium", "Regular"]) ?? nearestStyle(styles, "Bold") ?? styles[0]!;
}
function bodyStyle(styles: string[]): string {
  return pickStyle(styles, ["Regular", "Book", "Normal", "Roman"]) ?? nearestStyle(styles, "Regular") ?? styles[0]!;
}

// ── figma_suggest_fonts ─────────────────────────────────────────────────────

const suggestFonts: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const figma = api();
    const mood = str(ctx.params, "mood") ?? "";
    const use = (str(ctx.params, "use") ?? "ui").toLowerCase();
    if (!(use in USE_CATEGORY)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`use` must be ui, mobile, marketing, editorial, code or brand.");
    const limit = int(ctx.params, "limit", 5, 20);
    // Grouped once per session, in slices that report progress (font-index.ts).
    const available = await fontIndex(figma, { pace: ctx });
    if (!available) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor cannot list fonts.");

    // The design to fit: an explicit node, else the one selected layer, else the
    // page. The selection lives on the page; PluginAPI has no `selection` [C-097].
    const id = str(ctx.params, "nodeId");
    const selected = selectionOf(figma);
    const root = id ? await byId(figma, id) : selected.length === 1 ? selected[0]! : figma.currentPage;
    const used = await readTextUse(root, ctx);

    const tags = moodTags(mood);
    const cands: Candidate[] = [];
    await forEachChunked(
      available.families,
      ({ family, styles }) => {
        const c = score(family, styles, tags, use);
        if (c) cands.push(c);
      },
      { yieldToHost: ctx.yieldToHost, isCancelled: () => ctx.isCancelled(), onProgress: (done, total) => ctx.progress(done, total, "ranking fonts") },
    );
    const bodies = cands.filter((c) => c.body > -Infinity).sort((a, b) => b.body - a.body).slice(0, 8);
    const heads = cands.filter((c) => c.heading > -Infinity).sort((a, b) => b.heading - a.heading).slice(0, 8);

    const same = use === "ui" || use === "mobile" || tags.has("minimal") || tags.has("neutral");
    const pairs: Array<{ heading: Candidate; body: Candidate; score: number }> = [];
    for (const h of heads) {
      for (const b of bodies) {
        let s = h.heading + b.body;
        if (h.family === b.family) s += same ? 1.5 : 0.3;
        else if (h.info.category !== b.info.category) s += 1; // contrast reads as intent
        else s -= 0.8; // two different faces of the same kind read as a mistake
        if (h.info.category === "mono" && b.info.category === "mono" && use !== "code") s -= 2;
        pairs.push({ heading: h, body: b, score: s });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    const describe = (c: Candidate) => `${c.family} (${c.info.category}${c.matched.length ? `; ${c.matched.join(", ")}` : ""})`;
    const suggestions = pairs.slice(0, limit).map((p) => ({
      heading: { family: p.heading.family, style: headingStyle(p.heading.styles), styles: p.heading.styles },
      body: { family: p.body.family, style: bodyStyle(p.body.styles), styles: p.body.styles },
      why:
        p.heading.family === p.body.family
          ? `One family for everything — ${describe(p.heading)}; hierarchy from size and weight.`
          : `${describe(p.heading)} for headings over ${describe(p.body)} for text.`,
      score: Math.round(p.score * 10) / 10,
    }));

    const inUse = [...used.fonts.values()]
      .sort((a, b) => b.nodes - a.nodes)
      .map((u) => ({
        family: u.family,
        styles: [...u.styles],
        textNodes: u.nodes,
        available: available.byFamily.has(u.family.toLowerCase()),
        ...(FONT_CATALOG.has(u.family.toLowerCase()) ? { category: fontInfo(u.family).info.category } : {}),
        ...(tags.size ? { fitsMood: overlap(fontInfo(u.family).info.tags, tags) } : {}),
      }));

    // Heading vs body split of the existing text, so the agent can apply a choice in two calls.
    const sized = used.texts.filter((t) => t.size !== null);
    const sizes = [...new Set(sized.map((t) => t.size!))].sort((a, b) => a - b);
    const bodySize = sized.length ? [...used.sizes.entries()].sort((a, b) => b[1] - a[1])[0]![0] : null;
    const applyPlan =
      sized.length && bodySize !== null
        ? {
            headingNodeIds: sized.filter((t) => t.size! > bodySize * 1.2).map((t) => t.id).slice(0, 500),
            bodyNodeIds: sized.filter((t) => t.size! <= bodySize * 1.2).map((t) => t.id).slice(0, 500),
            how: "figma_set_text_properties { nodeIds: headingNodeIds, fontFamily: <heading>, weight: <heading style> } then the same for bodyNodeIds — sizes and per-word bold are kept.",
          }
        : undefined;

    return {
      scope: { id: root.id, name: root.name, type: root.type },
      ...(mood ? { mood, matchedTags: [...tags] } : {}),
      use,
      inUse,
      ...(inUse.length && inUse[0]!.available
        ? { consistency: `The design already uses ${inUse[0]!.family}. Keeping it is the safe choice; change it only on purpose, everywhere at once.` }
        : {}),
      suggestions,
      typeScale: TYPE_SCALES[use === "code" || use === "brand" ? "ui" : use] ?? TYPE_SCALES.ui,
      ...(sizes.length ? { sizesInUse: sizes } : {}),
      ...(applyPlan ? { applyPlan } : {}),
      scanned: { layers: used.visited, textLayers: used.texts.length, complete: used.complete },
      ...(used.complete
        ? {}
        : {
            scanNote:
              `Read the first ${used.visited} layers of "${root.name}", not all of it, so inUse, sizesInUse and applyPlan cover those only. ` +
              "Pass nodeId (one frame or section) to fit a part of the page completely.",
          }),
      availableFamilies: available.families.length,
      note: "Only fonts this Figma can load are suggested. Style names are the family's own (\"SemiBold\" vs \"Semi Bold\") — pass them as given.",
    };
  },
};

// ── editing text like the right-hand panel ─────────────────────────────────

function parseLength(raw: unknown, field: string, allowAuto: boolean): { unit: string; value?: number } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return { unit: "PIXELS", value: raw };
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (allowAuto && s === "auto") return { unit: "AUTO" };
  const m = /^(-?\d+(?:\.\d+)?)\s*(px|%)?$/.exec(s);
  if (!m) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be ${allowAuto ? '"auto", ' : ""}a number of px ("24") or a percent ("150%").`);
  return { unit: m[2] === "%" ? "PERCENT" : "PIXELS", value: Number(m[1]) };
}

const CASES: Record<string, string> = { original: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE", "small-caps": "SMALL_CAPS" };
const DECOS: Record<string, string> = { none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH" };
const ALIGNS: Record<string, string> = { left: "LEFT", center: "CENTER", right: "RIGHT", justified: "JUSTIFIED" };
// "truncate" is no longer a resize mode: the typings deprecate textAutoResize
// TRUNCATE for textTruncation [C-103], so it becomes a fixed box that truncates.
const RESIZE: Record<string, string> = { hug: "WIDTH_AND_HEIGHT", wrap: "HEIGHT", fixed: "NONE", truncate: "NONE" };
const VALIGNS: Record<string, string> = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };
const TRIMS: Record<string, string> = { none: "NONE", "cap-height": "CAP_HEIGHT" };
const WRAPS: Record<string, string> = { auto: "AUTO", balance: "BALANCE", pretty: "PRETTY" };
const LISTS: Record<string, string> = { none: "NONE", ordered: "ORDERED", unordered: "UNORDERED" };

function pickEnum(raw: unknown, table: Record<string, string>, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const v = table[String(raw).toLowerCase()];
  if (!v) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be one of ${Object.keys(table).join(", ")}.`);
  return v;
}

function atLeastZero(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a number ≥ 0.`);
  return raw;
}

interface TextEdit {
  family?: string;
  weight?: string | number;
  fontSize?: number;
  lineHeight?: { unit: string; value?: number };
  letterSpacing?: { unit: string; value?: number };
  align?: string;
  textCase?: string;
  decoration?: string;
  fill?: unknown;
  autoResize?: string;
  // Per paragraph: a range widens to the paragraphs it touches [C-103].
  paragraphSpacing?: number;
  paragraphIndent?: number;
  list?: string;
  // Whole node only.
  alignVertical?: string;
  leadingTrim?: string;
  wrapStyle?: string;
  truncation?: "ENDING" | "DISABLED";
  maxLines?: number;
  /** autoResize "truncate" asked for, so a build without textTruncation can still truncate the old way. */
  legacyTruncate?: boolean;
}

/** The parts of an edit that belong to the whole text node, never to a range. */
const WHOLE_NODE = ["align", "autoResize", "alignVertical", "leadingTrim", "wrapStyle", "truncation", "maxLines"] as const;
/** What each whole-node field is called on the tool, for refusals. */
const WHOLE_PARAM: Record<(typeof WHOLE_NODE)[number], string> = {
  align: "align", autoResize: "autoResize", alignVertical: "alignVertical", leadingTrim: "leadingTrim",
  wrapStyle: "wrapStyle", truncation: "truncate", maxLines: "maxLines",
};

function readEdit(params: Record<string, unknown>): TextEdit {
  const e: TextEdit = {};
  const family = str(params, "fontFamily");
  if (family) e.family = family;
  const weight = weightParam(params);
  if (weight !== undefined) e.weight = weight;
  if (params.fontSize !== undefined) {
    if (typeof params.fontSize !== "number" || params.fontSize <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`fontSize` must be a positive number.");
    e.fontSize = params.fontSize;
  }
  const lh = parseLength(params.lineHeight, "lineHeight", true);
  if (lh) e.lineHeight = lh;
  const ls = parseLength(params.letterSpacing, "letterSpacing", false);
  if (ls) e.letterSpacing = ls;
  const align = pickEnum(params.align, ALIGNS, "align");
  if (align) e.align = align;
  const textCase = pickEnum(params.case, CASES, "case");
  if (textCase) e.textCase = textCase;
  const deco = pickEnum(params.decoration, DECOS, "decoration");
  if (deco) e.decoration = deco;
  if (params.color !== undefined) e.fill = parseColor(params.color, "color");
  const resize = pickEnum(params.autoResize, RESIZE, "autoResize");
  if (resize) e.autoResize = resize;

  const spacing = atLeastZero(params.paragraphSpacing, "paragraphSpacing");
  if (spacing !== undefined) e.paragraphSpacing = spacing;
  const indent = atLeastZero(params.paragraphIndent, "paragraphIndent");
  if (indent !== undefined) e.paragraphIndent = indent;
  const list = pickEnum(params.list, LISTS, "list");
  if (list) e.list = list;
  const valign = pickEnum(params.alignVertical, VALIGNS, "alignVertical");
  if (valign) e.alignVertical = valign;
  const trim = pickEnum(params.leadingTrim, TRIMS, "leadingTrim");
  if (trim) e.leadingTrim = trim;
  const wrap = pickEnum(params.wrapStyle, WRAPS, "wrapStyle");
  if (wrap) e.wrapStyle = wrap;

  // Truncation, three ways in: maxLines (an ellipsis after n lines), truncate
  // (on or off), and autoResize "truncate" (a fixed box that ends in one).
  const truncateAsked = String(params.autoResize ?? "").toLowerCase() === "truncate";
  if (params.maxLines !== undefined) {
    if (typeof params.maxLines !== "number" || !Number.isInteger(params.maxLines) || params.maxLines < 1) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`maxLines` must be a whole number ≥ 1.");
    }
    e.maxLines = params.maxLines;
  }
  if (params.truncate !== undefined && typeof params.truncate !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`truncate` must be true or false.");
  if (params.truncate === false && (e.maxLines !== undefined || truncateAsked)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`truncate: false\` contradicts \`${e.maxLines !== undefined ? "maxLines" : 'autoResize: "truncate"'}\`, which truncates.`);
  }
  if (params.truncate === false) e.truncation = "DISABLED";
  else if (params.truncate === true || e.maxLines !== undefined || truncateAsked) e.truncation = "ENDING";
  if (truncateAsked) e.legacyTruncate = true;
  return e;
}

/** Members a node must have for an edit — checked before its first write, so a refusal leaves it as it was. */
function missingFor(node: Any, e: TextEdit, whole: boolean): string[] {
  const need: string[] = [];
  if (e.paragraphSpacing !== undefined) need.push("setRangeParagraphSpacing");
  if (e.paragraphIndent !== undefined) need.push("setRangeParagraphIndent");
  if (e.list) need.push("setRangeListOptions");
  if (whole) {
    if (e.alignVertical) need.push("textAlignVertical");
    if (e.leadingTrim) need.push("leadingTrim");
    if (e.wrapStyle) need.push("textWrapStyle");
    // autoResize "truncate" alone falls back to the deprecated TRUNCATE where
    // this build has no textTruncation; maxLines and truncate need the real one.
    const legacyOnly = e.legacyTruncate && e.maxLines === undefined;
    if (e.truncation && !legacyOnly) need.push("textTruncation");
    if (e.maxLines !== undefined) need.push("maxLines");
  }
  // has(), not `in`: on a board a member the node lacks may throw when touched [C-145].
  return need.filter((m) => !has(node, m));
}

/**
 * The whole-node fields that exist on a TextNode only. A sticky's, shape's,
 * connector's or table cell's text is a TextSublayerNode — NonResizableTextMixin
 * plus fills (plugin-api.d.ts:10403) — with no textAlignHorizontal,
 * textAlignVertical, textAutoResize, textTruncation or maxLines (TextNode,
 * d.ts:10963-10993) [C-135].
 */
const TEXT_NODE_ONLY = ["align", "alignVertical", "autoResize", "truncation", "maxLines"] as const;

/** The texts an edit applies to: the TEXT itself, a board node's sublayer, or every cell of a table. Null: none. */
function editTargets(node: NodeLike): TextTarget[] | null {
  if (node.type === "TABLE") {
    const t = node as unknown as { numRows?: number; numColumns?: number; cellAt?(r: number, c: number): unknown };
    if (typeof t.cellAt !== "function") return null;
    const out: TextTarget[] = [];
    for (let r = 0; r < (t.numRows ?? 0); r++) {
      for (let c = 0; c < (t.numColumns ?? 0); c++) {
        const text = tryGet<TextHolder | undefined>(t.cellAt(r, c), "text");
        if (text.ok && text.value) out.push({ kind: "sublayer", owner: node, target: text.value });
      }
    }
    return out;
  }
  const one = textTarget(node);
  return one && one.kind !== "code" ? [one] : null;
}

/** Load every font a text node already uses — Figma refuses edits otherwise. */
async function loadTextFonts(figma: FigmaWrite, t: Any): Promise<void> {
  for (const f of fontsOfText(t)) await figma.loadFontAsync(f);
}

/**
 * The font each run of text should end up in. A new family keeps each run's
 * weight (a bold word stays bold); a new weight applies to every run.
 */
async function targetFont(figma: FigmaWrite, current: FontName, e: TextEdit): Promise<{ font: FontName; fellBack: boolean }> {
  const family = e.family ?? current.family;
  const style = e.weight !== undefined ? weightToStyle(e.weight) : current.style;
  const loaded = await loadFont(figma, family, style);
  return { font: { family: loaded.family, style: loaded.style }, fellBack: loaded.fellBack };
}

async function applyEdit(figma: FigmaWrite, node: Any, e: TextEdit, start: number, end: number, whole: boolean): Promise<{ fellBack?: FontName[] }> {
  const fell: FontName[] = [];
  if (e.family || e.weight !== undefined) {
    const segs =
      typeof node.getStyledTextSegments === "function"
        ? (node.getStyledTextSegments as (f: string[], s?: number, e?: number) => Array<{ start: number; end: number; fontName: FontName }>)(["fontName"], start, end)
        : [{ start, end, fontName: node.fontName as FontName }];
    for (const seg of segs) {
      const { font, fellBack } = await targetFont(figma, seg.fontName, e);
      if (fellBack) fell.push(font);
      (node.setRangeFontName as (s: number, e: number, f: FontName) => void)(seg.start, seg.end, font);
    }
  }
  if (e.fontSize !== undefined) (node.setRangeFontSize as (s: number, e: number, v: number) => void)(start, end, e.fontSize);
  if (e.fill) (node.setRangeFills as (s: number, e: number, v: unknown[]) => void)(start, end, [e.fill]);
  if (e.decoration) (node.setRangeTextDecoration as (s: number, e: number, v: string) => void)(start, end, e.decoration);
  if (e.textCase) (node.setRangeTextCase as (s: number, e: number, v: string) => void)(start, end, e.textCase);
  if (e.lineHeight) (node.setRangeLineHeight as (s: number, e: number, v: unknown) => void)(start, end, e.lineHeight);
  if (e.letterSpacing) (node.setRangeLetterSpacing as (s: number, e: number, v: unknown) => void)(start, end, e.letterSpacing);
  if (e.paragraphSpacing !== undefined) (node.setRangeParagraphSpacing as (s: number, e: number, v: number) => void)(start, end, e.paragraphSpacing);
  if (e.paragraphIndent !== undefined) (node.setRangeParagraphIndent as (s: number, e: number, v: number) => void)(start, end, e.paragraphIndent);
  if (e.list) (node.setRangeListOptions as (s: number, e: number, v: unknown) => void)(start, end, { type: e.list });
  if (whole) {
    if (e.align) node.textAlignHorizontal = e.align;
    if (e.alignVertical) node.textAlignVertical = e.alignVertical;
    if (e.leadingTrim) node.leadingTrim = e.leadingTrim;
    if (e.wrapStyle) node.textWrapStyle = e.wrapStyle;
    const modern = has(node, "textTruncation");
    if (e.autoResize) node.textAutoResize = e.legacyTruncate && !modern ? "TRUNCATE" : e.autoResize;
    if (e.truncation && modern) node.textTruncation = e.truncation;
    // maxLines only applies once truncation is ENDING, so it is written after.
    if (e.maxLines !== undefined) node.maxLines = e.maxLines;
  }
  return fell.length ? { fellBack: fell } : {};
}

/** Only the whole-node part of an edit — what an empty text can still take. */
function wholeOnly(e: TextEdit): TextEdit {
  const out: TextEdit = {};
  for (const k of WHOLE_NODE) if (e[k] !== undefined) (out as Record<string, unknown>)[k] = e[k];
  if (e.legacyTruncate) out.legacyTruncate = true;
  return out;
}

const setTextProperties: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const edit = await beforeMutating(async () => {
      requireIds(ctx);
      const e = readEdit(ctx.params);
      if (!Object.keys(e).length) {
        throw new BridgeError(
          ErrorCode.INVALID_PARAM,
          "Give at least one property: fontFamily, weight, fontSize, lineHeight, letterSpacing, align, case, decoration, color, autoResize, " +
            "paragraphSpacing, paragraphIndent, list, maxLines, truncate, alignVertical, leadingTrim, wrapStyle.",
        );
      }
      if (e.family) {
        const fam = await stylesOf(figma, e.family);
        if (!fam) {
          throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `"${e.family}" is not available in this Figma.`, {
            hint: "figma_suggest_fonts lists families that are, ranked for the design.",
          });
        }
        e.family = fam.family; // the family's own capitalisation
      }
      return e;
    });
    const items: Array<ItemResult & { font?: FontName; fellBack?: FontName[]; cells?: number }> = [];
    const boxOnly = TEXT_NODE_ONLY.filter((k) => edit[k] !== undefined).map((k) => `\`${WHOLE_PARAM[k]}\``);
    for (const { id, node } of await resolveAll(requireIds(ctx))) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const targets = editTargets(node as unknown as NodeLike);
      if (!targets) {
        items.push({ id, ok: false, error: `a ${node.type} is not text` });
        continue;
      }
      // Refused before this node's first write: a sublayer has no box of its own [C-135].
      if (node.type !== "TEXT" && boxOnly.length) {
        items.push({ id, ok: false, error: `${[...new Set(boxOnly)].join(", ")} set a TEXT node's own box; a ${node.type}'s text has none` });
        continue;
      }
      try {
        for (const target of targets) {
          const missing = missingFor(target.target as unknown as Any, edit, true);
          if (missing.length) throw new Error(`this Figma's text has no ${missing.join(", ")}`);
        }
        for (const target of targets) {
          if (target.kind === "text") await loadTextFonts(figma, target.target as unknown as Any);
          else await loadHolderFonts(target, figma);
        }
        let r: { fellBack?: FontName[] } = {};
        for (const target of targets) {
          const t = target.target as unknown as Any;
          const len = typeof t.characters === "string" ? t.characters.length : 0;
          const one = len > 0 ? await applyEdit(figma, t, edit, 0, len, true) : {};
          if (one.fellBack) r = { fellBack: [...(r.fellBack ?? []), ...one.fellBack] };
          const whole = wholeOnly(edit);
          if (len === 0 && Object.keys(whole).length) await applyEdit(figma, t, whole, 0, 0, true);
        }
        const fn = targets[0] ? tryGet<FontName | symbol>(targets[0].target, "fontName") : null;
        items.push({
          id, ok: true,
          ...(fn?.ok && typeof fn.value === "object" ? { font: fn.value } : {}),
          ...(node.type === "TABLE" ? { cells: targets.length } : {}),
          ...r,
        });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

// ── a range bound to the design system: styles, variables, in-file links ─────

type Hyperlink = { type: "URL" | "NODE"; value: string };

/**
 * `link` is a URL, or "node:<id>" for a link to a layer in this file
 * (HyperlinkTarget NODE [C-103]). The node is looked up first: a link to
 * nothing would be accepted by Figma and go nowhere.
 */
async function linkTarget(raw: string | undefined): Promise<Hyperlink | undefined> {
  if (!raw) return undefined;
  const m = /^node:\s*(.+)$/i.exec(raw.trim());
  if (!m) return { type: "URL", value: raw };
  const id = m[1]!.trim().replace(/^(\d+)-(\d+)$/, "$1:$2"); // the URL form of an id, as a pasted link carries it
  const target = await api().getNodeByIdAsync(id);
  if (!target) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `\`link\` points at node \`${id}\`, which does not exist.`);
  return { type: "NODE", value: target.id };
}

/** Style ids start "S:"; anything else is a name. */
const styleRef = (v: string) => (v.startsWith("S:") ? { id: v } : { name: v });
/** Variable ids start "VariableID:"; anything else is a name. */
const variableRef = (v: string) => (v.startsWith("VariableID:") ? { id: v } : { name: v });

/** The text fields a range binds a variable to (VariableBindableTextField [C-103]) and the types each takes. */
const RANGE_VARIABLES: Record<string, readonly string[]> = {
  fontSize: ["FLOAT"],
  fontFamily: ["STRING"],
  fontStyle: ["STRING"],
  fontWeight: ["FLOAT", "STRING"],
  lineHeight: ["FLOAT"],
  letterSpacing: ["FLOAT"],
  paragraphSpacing: ["FLOAT"],
  paragraphIndent: ["FLOAT"],
};

async function variableFor(ref: string, field: string, types: readonly string[]): Promise<VariableLike> {
  let v: VariableLike;
  try {
    v = await findVariable(variableRef(ref));
  } catch (err) {
    if (err instanceof BridgeError) throw new BridgeError(err.code, `\`${field}\`: ${err.message}`, err.hint ? { hint: err.hint } : {});
    throw err;
  }
  if (!types.includes(v.resolvedType)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` binds a ${types.join(" or ")} variable; "${v.name}" is ${v.resolvedType}.`);
  }
  return v;
}

async function styleFor(ref: string, field: string, target: "text" | "fill", kind: string): Promise<{ id: string; name: string }> {
  const s = await findStyle(styleRef(ref), target);
  // An id lookup does not filter by kind, so a paint style's id could arrive as `textStyle`.
  if (s.kind !== kind) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` needs a ${kind} style; "${s.name}" is ${s.kind}.`);
  return { id: s.id, name: s.name };
}

/** The style a bound fontWeight lands on in `family`: matched the way loadFont matches a weight, keeping the run's slant. */
async function styleForWeight(figma: FigmaWrite, family: string, weight: number | string, current: string): Promise<string> {
  const base = weightToStyle(weight);
  const wanted = styleWeight(current).italic && !/italic|oblique/i.test(base) ? `${base} Italic` : base;
  const known = await stylesOf(figma, family);
  return (known && nearestStyle(known.styles, wanted)) ?? wanted;
}

/**
 * Fonts a range will be switched to — Figma refuses the switch, and a binding
 * that lands on a new font ("Requires any new fonts to be loaded" [C-103]),
 * unless each is loaded first. Worked out per run in the order setTextRange
 * writes: the text style replaces the run's font, `fontFamily` / `weight`
 * apply as applyEdit will, then each bound family, style or weight. Taking the
 * runs as they were before the edit loaded a font nothing would use, and left
 * the binding to fail after the earlier writes had landed.
 */
async function fontsAhead(
  figma: FigmaWrite,
  t: Any,
  ranges: Array<[number, number]>,
  edit: TextEdit,
  styleId: string | undefined,
  bound: Map<string, VariableLike>,
): Promise<void> {
  const fonts: FontName[] = [];
  let styleFont: FontName | undefined;
  if (styleId) {
    const style = (await (figma as unknown as { getStyleByIdAsync?(id: string): Promise<Any | null> }).getStyleByIdAsync?.(styleId)) ?? null;
    const f = style?.fontName as FontName | undefined;
    if (f && typeof f === "object") fonts.push((styleFont = f));
  }
  // A bound value resolves per node; resolveForConsumer gives what this node will show.
  const resolved = (field: string): unknown => {
    const v = bound.get(field) as (VariableLike & { resolveForConsumer?(n: unknown): { value: unknown } }) | undefined;
    return v?.resolveForConsumer?.(t)?.value;
  };
  const asText = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const family = asText(resolved("fontFamily"));
  const style = asText(resolved("fontStyle"));
  const w = resolved("fontWeight");
  const weight = typeof w === "number" && Number.isFinite(w) ? w : asText(w);

  const all = t.getRangeAllFontNames as ((s: number, e: number) => FontName[]) | undefined;
  const found = styleFont ? [styleFont] : ranges.flatMap(([s, e]) => (typeof all === "function" ? all.call(t, s, e) : fontsOfText(t)));
  const runs = [...new Map(found.map((f) => [`${f.family}|${f.style}`, f])).values()];
  for (let run of runs) {
    // targetFont loads what applyEdit will ask for, so that write finds it ready too.
    if (edit.family || edit.weight !== undefined) run = (await targetFont(figma, run, edit)).font;
    if (family === undefined && style === undefined && weight === undefined) continue;
    const fam = family ?? run.family;
    fonts.push({ family: fam, style: style ?? (weight !== undefined ? await styleForWeight(figma, fam, weight, run.style) : run.style) });
  }
  const seen = new Set<string>();
  for (const f of fonts) {
    const key = `${f.family}|${f.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await figma.loadFontAsync(f);
    } catch {
      throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `The range would switch to ${f.family} ${f.style}, which this Figma cannot load.`, {
        hint: "figma_get_fonts and figma_suggest_fonts list what is available.",
      });
    }
  }
}

/** [start, end) widened to the whole lines it touches, the last line's newline included. */
export function wholeLines(chars: string, start: number, end: number): [number, number] {
  const from = chars.lastIndexOf("\n", Math.max(0, start - 1));
  const s = start === 0 || from < 0 ? 0 : from + 1;
  const nl = chars.indexOf("\n", Math.max(start, end - 1));
  return [s, nl < 0 ? chars.length : nl + 1];
}

/** `indent`: a list level, a whole number 0–5 (create-text.md:271) [C-167]. */
function readIndent(params: Record<string, unknown>): number | undefined {
  const v = params.indent;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 5) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`indent` must be a whole number from 0 to 5 (1 is a top-level list item).");
  }
  return v;
}

const setTextRange: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    // Everything resolves before the first write — the node, the ranges, every
    // style, variable, link target and font — so a refusal changed nothing.
    const p = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      const edit = readEdit(ctx.params);
      const indent = readIndent(ctx.params);
      const wholeAsked = WHOLE_NODE.filter((k) => edit[k] !== undefined).map((k) => `\`${WHOLE_PARAM[k]}\``);
      if (wholeAsked.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `${[...new Set(wholeAsked)].join(", ")} apply to the whole node — use figma_set_text_properties.`);
      }
      const textStyleRef = str(ctx.params, "textStyle");
      const fillStyleRef = str(ctx.params, "fillStyle");
      const colorVariableRef = str(ctx.params, "colorVariable");
      const colourWays = [edit.fill ? "color" : "", fillStyleRef ? "fillStyle" : "", colorVariableRef ? "colorVariable" : ""].filter(Boolean);
      if (colourWays.length > 1) throw new BridgeError(ErrorCode.INVALID_PARAM, `Give one of \`${colourWays.join("`, `")}\` — each sets the range's colour.`);

      const variables: Array<[string, VariableLike]> = [];
      if (ctx.params.variables !== undefined) {
        const raw = ctx.params.variables;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`variables` must be an object such as { \"fontSize\": \"type/body/size\" }.");
        }
        const entries = Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== undefined);
        const unknown = entries.filter(([k]) => !(k in RANGE_VARIABLES)).map(([k]) => k);
        if (unknown.length) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`variables\` takes only ${Object.keys(RANGE_VARIABLES).join(", ")} (got ${unknown.join(", ")}).`);
        }
        for (const [k, v] of entries) {
          if (typeof v !== "string" || !v.trim()) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`variables.${k}\` must be a variable name or id.`);
          variables.push([k, await variableFor(v.trim(), `variables.${k}`, RANGE_VARIABLES[k]!)]);
        }
      }
      const link = await linkTarget(str(ctx.params, "link"));
      if (!Object.keys(edit).length && indent === undefined && !link && !textStyleRef && !fillStyleRef && !colorVariableRef && !variables.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Give at least one property to apply to the range.");
      }
      const textStyle = textStyleRef ? await styleFor(textStyleRef, "textStyle", "text", "TEXT") : undefined;
      const fillStyle = fillStyleRef ? await styleFor(fillStyleRef, "fillStyle", "fill", "PAINT") : undefined;
      let colorPaint: unknown;
      if (colorVariableRef) {
        const v = await variableFor(colorVariableRef, "colorVariable", ["COLOR"]);
        const bind = (figma as unknown as { variables?: { setBoundVariableForPaint?(p: unknown, f: string, v: unknown): unknown } }).variables;
        if (typeof bind?.setBoundVariableForPaint !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor cannot bind a paint to a variable (no setBoundVariableForPaint).");
        colorPaint = bind.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
      }

      const node = await byId(figma as unknown as FigmaLike, id);
      if (node.type === "TABLE") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is a TABLE: its cells have no id, so a range cannot name one.`, {
          hint: "figma_set_text_properties styles every cell at once; figma_edit_table writes one cell.",
        });
      }
      // A sticky's, shape's or connector's text is a sublayer with the same range setters [C-135].
      const target = editTargets(node);
      if (!target?.[0]) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is a ${node.type}, not text.`);
      const holder = target[0];
      const t = holder.target as unknown as Any;
      const missing = missingFor(t, edit, false);
      if (textStyle) missing.push("setRangeTextStyleIdAsync");
      if (fillStyle) missing.push("setRangeFillStyleIdAsync");
      if (variables.length) missing.push("setRangeBoundVariable");
      if (indent !== undefined) missing.push("setRangeIndentation");
      const absent = missing.filter((m) => !has(t, m));
      if (absent.length) throw new BridgeError(ErrorCode.UNSUPPORTED, `This Figma's text has no ${absent.join(", ")}.`);
      const chars = typeof t.characters === "string" ? t.characters : "";

      // The range: explicit offsets, or every occurrence of `match` (or the nth).
      const ranges: Array<[number, number]> = [];
      const match = typeof ctx.params.match === "string" ? ctx.params.match : undefined;
      if (match !== undefined) {
        if (!match) throw new BridgeError(ErrorCode.INVALID_PARAM, "`match` is empty.");
        for (let i = chars.indexOf(match); i >= 0; i = chars.indexOf(match, i + match.length)) ranges.push([i, i + match.length]);
        const nth = int(ctx.params, "occurrence", 0, 10000);
        if (nth > 0) {
          if (nth > ranges.length) throw new BridgeError(ErrorCode.INVALID_PARAM, `"${match}" occurs ${ranges.length} time(s), not ${nth}.`);
          ranges.splice(0, ranges.length, ranges[nth - 1]!);
        }
        if (!ranges.length) throw new BridgeError(ErrorCode.INVALID_PARAM, `"${match}" does not occur in the text.`, { hint: `The text is: "${chars.slice(0, 120)}"` });
      } else {
        const start = typeof ctx.params.start === "number" ? ctx.params.start : NaN;
        const end = typeof ctx.params.end === "number" ? ctx.params.end : NaN;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > chars.length || start >= end) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `Give \`match\`, or \`start\` < \`end\` within 0–${chars.length}.`);
        }
        ranges.push([start, end]);
      }

      // A connector whose label font is unusable gets Inter Medium first — a
      // write [C-148], so it waits until every check has passed (below).
      const resetFirst = holder.owner.type === "CONNECTOR";
      if (holder.kind === "text") await loadTextFonts(figma, t);
      else if (!resetFirst) await loadHolderFonts(holder, figma);
      if (!resetFirst) await fontsAhead(figma, t, ranges, edit, textStyle?.id, new Map(variables));
      return { id, t, holder, resetFirst, chars, ranges, edit, link, textStyle, fillStyle, colorPaint, variables, indent };
    });
    if (p.resetFirst) {
      await loadHolderFonts(p.holder, figma);
      await fontsAhead(figma, p.t, p.ranges, p.edit, p.textStyle?.id, new Map(p.variables));
    }

    const { t, ranges, edit } = p;
    // A list level belongs to whole lines: the range widens to the lines it
    // touches, newline included, as the official recipe sets it
    // (create-text.md:265-271) [C-167]. `list` keeps the range it was given,
    // which Figma applies per paragraph [C-103].
    const lineWise = p.indent !== undefined;
    const fell: FontName[] = [];
    for (const [s, e] of ranges) {
      // The style first, so the raw properties given with it override it, as in the panel.
      if (p.textStyle) await (t.setRangeTextStyleIdAsync as (s: number, e: number, id: string) => Promise<void>)(s, e, p.textStyle.id);
      const r = await applyEdit(figma, t, edit, s, e, false);
      if (r.fellBack) fell.push(...r.fellBack);
      if (p.fillStyle) await (t.setRangeFillStyleIdAsync as (s: number, e: number, id: string) => Promise<void>)(s, e, p.fillStyle.id);
      if (p.colorPaint) (t.setRangeFills as (s: number, e: number, v: unknown[]) => void)(s, e, [p.colorPaint]);
      for (const [field, v] of p.variables) (t.setRangeBoundVariable as (s: number, e: number, f: string, v: unknown) => void)(s, e, field, v);
      if (p.link) (t.setRangeHyperlink as (s: number, e: number, v: unknown) => void)(s, e, p.link);
      if (p.indent !== undefined) {
        const [ls, le] = wholeLines(p.chars, s, e);
        (t.setRangeIndentation as (s: number, e: number, v: number) => void)(ls, le, p.indent);
      }
    }
    return {
      id: p.id,
      ...(p.holder.kind === "sublayer" ? { type: p.holder.owner.type } : {}),
      ranges: ranges.map(([s, e]) => ({ start: s, end: e, text: p.chars.slice(s, e) })),
      ...(lineWise ? { lines: ranges.map(([s, e]) => wholeLines(p.chars, s, e)).map(([s, e]) => ({ start: s, end: e })) } : {}),
      ...(p.textStyle ? { textStyle: p.textStyle } : {}),
      ...(p.fillStyle ? { fillStyle: p.fillStyle } : {}),
      ...(p.variables.length ? { bound: Object.fromEntries(p.variables.map(([f, v]) => [f, v.name])) } : {}),
      ...(p.link ? { link: p.link } : {}),
      ...(fell.length ? { fellBack: fell } : {}),
    };
  },
};

export const TYPOGRAPHY_OPS: Record<string, PluginOp> = {
  suggest_fonts: suggestFonts,
  set_text_properties: setTextProperties,
  set_text_range: setTextRange,
};
