// figma_check_layout's `deck` audit: a presentation designer's look at every
// slide (role spec §4.5) — the words on it against the room's budget, a
// headline that says something rather than names a topic, one idea instead of
// two competing for the first look, a structure that changes as the slides do
// different jobs, lists short enough to be heard, speaker notes where the
// brief asks for them, and type large enough to read from the back of the room.
//
// A unit is a slide: each SLIDE in Figma Slides, each 1920 × 1080 top-level
// frame in Figma Design. Which slide comes first, and which slides sit next to
// each other, is read from the deck itself (the grid's rows, or the page in
// reading order), so a batch of slides checked root by root still knows its
// neighbours. The room, the word budget, the notes and the floor come from the
// brief: details.room, maxWords and notes, lines.minTextSize.
//
// Every kind is info until calibrated (§4.9), except two numbers a brief or a
// practitioner's rule sets: a word count over the brief's own budget
// (details.maxWords), and text under the floor. A projected deck whose brief
// gives no floor reads at 60 px on a 1920 px slide: Kawasaki's 10/20/30 rule
// asks for no type under 30 pt, and PowerPoint's widescreen slide is 13.333 in
// (960 pt) wide, so on a 1920 px slide a point is two pixels. Plain functions
// over the census, after the walk; the deck's order and its neighbours are
// read off the nodes with guarded reads.

import { type RoleContext, words } from "./a11y.js";
import { childrenOf, field } from "./board-read.js";
import { CRAFT, type Census, type Finding, type Index, type Layer, type Rect, overlapX, overlapY, r1 } from "./craft.js";
import type { NodeLike } from "./read.js";
import { tryGet } from "./safe.js";
import { TELLS } from "./tells.js";

type Any = Record<string, unknown>;

/** Every threshold of the deck audit, to calibrate here. */
export const DECK = {
  /** A slide in Figma Design: a top-level frame this size (Figma's slide), within sizeTol px. */
  slideWidth: 1920,
  slideHeight: 1080,
  sizeTol: 0.5,
  /** slide_words: the words a slide carries before it is dense, by room — a decision to calibrate, no published standard. */
  words: { projected: 40, screen: 90 },
  /** min_text: a projected deck's floor when the brief gives none, in px of a 1920 px slide (30 pt × 2 px per pt). */
  projectedFloor: 60,
  /** topic_title: a headline of this many words or fewer names a topic; an assertion is a sentence. */
  topicWords: 3,
  /** A title, section or closing slide: at most this many texts and words (or named for one); never a content slide. */
  sectionTexts: 2,
  sectionWords: 8,
  /** two_focal: a block at least this share of the slide competes for the eye; one this share or more is the ground. */
  focalShare: 0.1,
  groundShare: 0.9,
  /** two_focal: texts closer than this × their size are lines of one headline, not two. */
  stackedEm: 0.6,
  /** repeated_skeleton: blocks within this share of the slide sit at the same place; this many consecutive content slides. */
  skeletonTol: 0.02,
  skeletonRun: 3,
  /** bullets_dense: a list of more items than this, or items set on more lines than this. */
  maxItems: 5,
  itemLines: 2,
  /** Layers read per slide off the deck's other slides (their words and blocks), so a long deck stays fast. */
  walkCap: 1000,
} as const;

/** Names that say a slide is a title, a section or a closing, not content. */
const STRUCTURAL = /(^| )(title|cover|section|divider|chapter|agenda|outline|contents|intro|introduction|closing|end|thanks|thank you|questions|q a|appendix)( |$)/;
/** A list item's mark at the start of a paragraph: a bullet, a dash, "1." or "a)". */
const BULLET = /^\s*(?:[•·▪◦‣∙●○■□–—*+-]|\d{1,2}[.)]|[a-z][.)])\s+/;
/** A character that makes a run of text a word: a letter (Latin, Greek, Cyrillic) or a digit. Scripts written without spaces are not counted by word. */
const WORDISH = /[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** Words in a text: whitespace-separated runs with a letter or a digit in them ("40%" is a word, "—" is not). */
export function wordCount(s: string): number {
  let n = 0;
  for (const w of s.split(/\s+/)) if (WORDISH.test(w)) n++;
  return n;
}

function boxOf(n: unknown): Rect | null {
  const b = field<Rect | null>(n, "absoluteBoundingBox");
  return b && Number.isFinite(b.width) && Number.isFinite(b.height) ? b : null;
}
const visible = (n: unknown) => field(n, "visible") !== false;
const area = (b: Rect) => Math.max(0, b.width) * Math.max(0, b.height);

/** A Design frame the size of Figma's slide, at the top of its page or of a section on it. */
function slideFrame(n: NodeLike): boolean {
  if (n.type !== "FRAME" && n.type !== "COMPONENT" && n.type !== "INSTANCE") return false;
  const p = field<NodeLike | null>(n, "parent");
  if (p?.type !== "PAGE" && p?.type !== "SECTION") return false;
  const b = boxOf(n);
  return !!b && Math.abs(b.width - DECK.slideWidth) <= DECK.sizeTol && Math.abs(b.height - DECK.slideHeight) <= DECK.sizeTol;
}

/** A unit of the deck audit: a Slides slide, or a 1920 × 1080 top-level frame in Design. */
export const isSlideUnit = (n: NodeLike): boolean => n.type === "SLIDE" || slideFrame(n);

// ── the deck around a slide ──────────────────────────────────────────────────

/** What the deck audit knows of a slide, read off the node: its place in the deck, its words and the blocks it is built from. */
interface SlideFacts {
  node: NodeLike;
  box: Rect;
  /** Its place in its deck, from 0. */
  index: number;
  texts: number;
  words: number;
  /** Its blocks (elements), as shares of the slide: [x, y, width, height], top to bottom then left to right. */
  skeleton: number[][];
  /** A title, section or closing slide, and why; content slides are the rest. */
  structural: string | null;
}

/** Slides in reading order: rows top to bottom (a slide joins the row it overlaps by half its height), each row left to right. */
function readingOrder(nodes: NodeLike[]): NodeLike[] {
  const boxed = nodes.map((n) => ({ n, b: boxOf(n)! })).sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
  const rows: Array<typeof boxed> = [];
  for (const x of boxed) {
    const row = rows[rows.length - 1];
    if (row && x.b.y - row[0]!.b.y < x.b.height / 2) row.push(x);
    else rows.push([x]);
  }
  const out: NodeLike[] = [];
  for (const row of rows) for (const x of row.sort((a, b) => a.b.x - b.b.x)) out.push(x.n);
  return out;
}

/**
 * The slides of the deck `unit` belongs to, in presentation order: in Slides
 * the grid's rows in order and each row's slides (the grid and its rows are
 * opaque: only their children are read); in Design the slide-size frames of
 * the page and of the sections on it, in reading order.
 */
function deckOf(unit: NodeLike, memo: Map<NodeLike, NodeLike[]>): NodeLike[] {
  let owner: NodeLike;
  let read: () => NodeLike[];
  if (unit.type === "SLIDE") {
    const row = field<NodeLike | null>(unit, "parent");
    const grid = row?.type === "SLIDE_ROW" ? field<NodeLike | null>(row, "parent") : null;
    owner = grid?.type === "SLIDE_GRID" ? grid : row?.type === "SLIDE_ROW" ? row : unit;
    read = () => {
      if (owner === unit) return [unit];
      const rows = owner.type === "SLIDE_GRID" ? (childrenOf(owner) ?? []) : [owner];
      const out: NodeLike[] = [];
      for (const r of rows) for (const s of childrenOf(r) ?? []) if (s.type === "SLIDE" && visible(s)) out.push(s);
      return out;
    };
  } else {
    let page: NodeLike | null | undefined = unit;
    while (page && page.type !== "PAGE") page = field<NodeLike | null>(page, "parent");
    owner = page ?? unit;
    read = () => {
      if (owner === unit) return [unit];
      const found: NodeLike[] = [];
      for (const k of childrenOf(owner) ?? []) {
        if (!visible(k)) continue;
        if (slideFrame(k)) found.push(k);
        else if (k.type === "SECTION") for (const kk of childrenOf(k) ?? []) if (visible(kk) && slideFrame(kk)) found.push(kk);
      }
      return readingOrder(found);
    };
  }
  let list = memo.get(owner);
  if (!list) memo.set(owner, (list = read()));
  return list;
}

/**
 * The blocks a slide is built from: its visible children, less the grounds (a
 * leaf covering nearly all of it), and through a wrapper that holds everything
 * (one child as large as the slide, with children of its own).
 */
function elementsOf(slide: NodeLike, slideBox: Rect): Array<{ node: NodeLike; box: Rect }> {
  const full = DECK.groundShare * area(slideBox);
  let list = (childrenOf(slide) ?? []).filter(visible);
  for (let depth = 0; depth < 5; depth++) {
    const kept = list.filter((k) => {
      const b = boxOf(k);
      return b && !(area(b) >= full && !(childrenOf(k) ?? []).length);
    });
    const only = kept.length === 1 ? kept[0]! : null;
    const ob = only ? boxOf(only) : null;
    if (only && ob && area(ob) >= full && (childrenOf(only) ?? []).length) {
      list = (childrenOf(only) ?? []).filter(visible);
      continue;
    }
    list = kept;
    break;
  }
  return list.map((node) => ({ node, box: boxOf(node)! })).filter((e) => e.box && e.box.width > 0 && e.box.height > 0);
}

/** A slide's facts, read off its node (bounded): its texts and words, its blocks, whether it is structural. */
function factsOf(slide: NodeLike, index: number): SlideFacts | null {
  const box = boxOf(slide);
  if (!box || box.width <= 0 || box.height <= 0) return null;
  let texts = 0;
  let count = 0;
  const stack = [...(childrenOf(slide) ?? [])];
  for (let seen = 0; stack.length && seen < DECK.walkCap; seen++) {
    const n = stack.pop()!;
    if (!visible(n)) continue;
    if (n.type === "TEXT") {
      const chars = field<string>(n, "characters");
      if (typeof chars === "string" && chars.trim()) {
        texts++;
        count += wordCount(chars);
      }
    }
    for (const k of childrenOf(n) ?? []) stack.push(k);
  }
  const skeleton = elementsOf(slide, box)
    .map((e) => [(e.box.x - box.x) / box.width, (e.box.y - box.y) / box.height, e.box.width / box.width, e.box.height / box.height])
    .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!);
  const structural = index === 0
    ? "the first slide"
    : STRUCTURAL.test(words(slide.name))
      ? `named "${slide.name}"`
      : texts <= DECK.sectionTexts && count <= DECK.sectionWords
        ? "a few words only"
        : null;
  return { node: slide, box, index, texts, words: count, skeleton, structural };
}

/** Two skeletons match when they hold as many blocks, each within skeletonTol of the slide on every side. */
function sameSkeleton(a: number[][], b: number[][]): boolean {
  if (!a.length || a.length !== b.length) return false;
  return a.every((x, i) => x.every((v, k) => Math.abs(v - b[i]![k]!) <= DECK.skeletonTol));
}

// ── the rules ────────────────────────────────────────────────────────────────

type Push = (n: NodeLike, kind: string, severity: Finding["severity"], detail: string) => void;

const quote = (s: string, n = 40) => `"${s.replace(/\s+/g, " ").trim().slice(0, n)}${s.trim().length > n ? "…" : ""}"`;
/** A text's largest size: its runs', else its main size. */
const sizeOf = (t: Layer) => Math.max(t.text!.size, ...t.text!.runs.map((r) => r.size));

export function judgeDeck(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const units = (c.root ? [c.root, ...c.layers] : c.layers).filter((l) => isSlideUnit(l.node));
  if (!units.length) {
    push(c.rootNode, "deck_unmeasured", "info",
      "found no slide here, so nothing was measured: the deck audit reads each Figma Slides slide, or each 1920 × 1080 frame at the " +
        "top of a page in Figma Design. Check the deck's page, or its slides (nodeIds).");
    return out;
  }
  const details = (rc.brief?.details ?? {}) as Any;
  const room = typeof details.room === "string" ? details.room.trim().toLowerCase() : "";
  const projected = room === "projected" || room === "both";
  const unmeasured: string[] = [];

  // Each unit's deck and its facts, read once per deck.
  const decks = new Map<NodeLike, NodeLike[]>();
  const facts = new Map<NodeLike, SlideFacts>();
  const deckFacts = new Map<NodeLike[], SlideFacts[]>();
  for (const u of units) {
    const deck = deckOf(u.node, decks);
    if (deckFacts.has(deck)) continue;
    const list: SlideFacts[] = [];
    deck.forEach((s, i) => {
      const f = factsOf(s, i);
      if (f) {
        list.push(f);
        facts.set(s, f);
      }
    });
    deckFacts.set(deck, list);
  }

  // The texts on each unit, from the census: what is visible, as the walk read it.
  const unitSet = new Set(units.map((u) => u.node));
  const textsOn = new Map<NodeLike, Layer[]>();
  for (const t of ix.texts) {
    for (let p: NodeLike | null | undefined = t.node.parent; p; p = p.parent) {
      if (!unitSet.has(p)) continue;
      textsOn.set(p, [...(textsOn.get(p) ?? []), t]);
      break;
    }
  }

  const notesUnread = { notes: 0, frames: 0 };
  for (const u of units) {
    const texts = textsOn.get(u.node) ?? [];
    const f = facts.get(u.node) ?? factsOf(u.node, -1);
    slideWords(u, texts, details, room, push);
    floor(c, u, texts, rc, projected, push);
    bullets(texts, push);
    if (f && !f.structural) topicTitle(u, texts, push);
    twoFocal(u, texts, ix, f, push);
    if (details.notes === true) notes(u, notesUnread, push);
  }
  for (const list of deckFacts.values()) skeletons(list, unitSet, push);

  const floorGiven = c.minTextSize !== undefined;
  if (!rc.brief) unmeasured.push(`${floorGiven ? "" : "the min_text floor and "}notes_missing (no brief was given: figma_check_layout { briefId })`);
  else {
    if (!room && !floorGiven) unmeasured.push("the min_text floor (the brief names no room — details.room projected, screen or both — and no minTextSize)");
    if (notesUnread.notes) {
      unmeasured.push(`notes_missing on ${notesUnread.notes} slide${notesUnread.notes > 1 ? "s" : ""} (this Figma build does not expose speaker notes)`);
    }
    if (notesUnread.frames) unmeasured.push("notes_missing on the Design frames (a frame in Figma Design carries no speaker notes)");
  }
  if (unmeasured.length) {
    push(c.rootNode, "deck_unmeasured", "info", `not measured: ${unmeasured.join("; ")}. The rest of the deck audit ran.`);
  }
  return out;
}

/** slide_words: the words on a slide against the brief's budget (a warning) or the room's (info). Notes are not on the slide, so they never count. */
function slideWords(u: Layer, texts: Layer[], details: Any, room: string, push: Push): void {
  const count = texts.reduce((n, t) => n + wordCount(t.text!.chars), 0);
  const max = typeof details.maxWords === "number" && details.maxWords > 0 ? details.maxWords : undefined;
  const cut = "Cut before you shrink: one idea per slide, the rest in the speaker notes or on a slide of its own.";
  if (max !== undefined) {
    if (count > max) push(u.node, "slide_words", "warning", `carries ${count} words; the brief's budget is ${max} a slide (details.maxWords). ${cut}`);
    return;
  }
  const screen = room === "screen";
  const budget = screen || !room ? DECK.words.screen : DECK.words.projected;
  if (count <= budget) return;
  const why = screen
    ? `the ${budget} a deck read on screen carries`
    : room
      ? `the ${budget} a projected deck carries`
      : `${budget}, the budget of a deck read on screen (the brief names no room; a projected deck carries ${DECK.words.projected})`;
  push(u.node, "slide_words", "info", `carries ${count} words, over ${why} — a budget to calibrate, not a published standard. ${cut}`);
}

/**
 * min_text, the deck's floor: the brief's minTextSize, or for a projected deck
 * with none 60 px on a 1920 px slide (Kawasaki's 30 pt; a point is 2 px of a
 * 1920 px slide, PowerPoint's widescreen slide being 13.333 in wide). Where
 * craft runs with a floor given, craft reports it: once is enough.
 */
function floor(c: Census, u: Layer, texts: Layer[], rc: RoleContext, projected: boolean, push: Push): void {
  const given = c.minTextSize;
  if (given !== undefined && rc.audits.has("craft")) return;
  const briefs = rc.brief?.lines.minTextSize;
  const f = given !== undefined
    ? { px: given, source: given === briefs ? "the brief's minTextSize" : "minTextSize" }
    : projected
      ? {
          px: (DECK.projectedFloor * u.box.width) / DECK.slideWidth,
          source: `a projected deck's floor when the brief gives none: Kawasaki's 30 pt minimum, at 2 px per pt on a ${DECK.slideWidth} px slide`,
        }
      : undefined;
  if (!f) return;
  for (const t of texts) {
    const s = t.text!.minSize;
    if (s <= 0 || s >= f.px - 0.05) continue;
    push(t.node, "min_text", "warning",
      `is ${r1(s)} px, under this slide's floor of ${r1(f.px)} px (${f.source}) — too small to read from the back of the room. ` +
        "Enlarge it (figma_set_text_properties fontSize), or cut it and say it aloud: cut before you shrink.");
  }
}

/** The paragraphs of a list text, by Figma's list formatting or by a mark at their start; 0 when it is not a list. */
function listItems(t: Layer): { items: number; paragraphs: number } {
  const chars = t.text!.chars;
  const paras = chars.split(/\n+/).filter((p) => p.trim());
  let listed = 0;
  const seg = t.a.getStyledTextSegments;
  if (typeof seg === "function") {
    try {
      for (const s of (seg as (f: string[]) => Array<Any>).call(t.a, ["listOptions"])) {
        const type = (s.listOptions as { type?: unknown } | undefined)?.type;
        if (type !== "ORDERED" && type !== "UNORDERED") continue;
        const text = typeof s.characters === "string" ? s.characters : chars.slice(Number(s.start) || 0, Number(s.end) || 0);
        listed += text.split(/\n+/).filter((p) => p.trim()).length;
      }
    } catch {
      /* nothing loaded: the marks still tell */
    }
  }
  const marked = paras.filter((p) => BULLET.test(p)).length;
  const items = Math.max(listed, marked);
  return { items: items >= 2 ? items : 0, paragraphs: paras.length };
}

/** bullets_dense: a list of more than five items, or one whose items run past two lines ("cut before you shrink"). */
function bullets(texts: Layer[], push: Push): void {
  for (const t of texts) {
    const { items, paragraphs } = listItems(t);
    if (!items) continue;
    // Lines from the height, less the space between paragraphs: the Plugin API has no line boxes.
    const f = t.text!;
    const gap = typeof t.a.paragraphSpacing === "number" ? t.a.paragraphSpacing : 0;
    const lines = Math.max(1, Math.round((t.box.height - Math.max(0, paragraphs - 1) * gap) / f.lineHeight));
    const long = lines > DECK.itemLines * paragraphs;
    if (items <= DECK.maxItems && !long) continue;
    const parts = [
      ...(items > DECK.maxItems ? [`is a list of ${items} items, more than the ${DECK.maxItems} a slide can carry`] : []),
      ...(long ? [`${items > DECK.maxItems ? "and sets" : "sets"} about ${lines} lines for ${paragraphs} paragraph${paragraphs > 1 ? "s" : ""}, so at least one item runs past ${DECK.itemLines} lines`] : []),
    ];
    push(t.node, "bullets_dense", "info",
      `${parts.join(" ")}: a list that long is read, not heard. Cut before you shrink — keep the items that carry the point, one line each, ` +
        "and give the rest a slide of its own or the speaker notes.");
  }
}

/** topic_title: a content slide whose headline names a topic in three words or fewer — the assertion-evidence approach writes it as a sentence. */
function topicTitle(u: Layer, texts: Layer[], push: Push): void {
  const lettered = texts.filter((t) => LETTER.test(t.text!.chars));
  if (!lettered.length) return;
  const head = lettered.reduce((m, t) => (sizeOf(t) > sizeOf(m) ? t : m), lettered[0]!);
  // The slide's body: the size carrying most of its characters. A slide with no headline above it has no title to judge.
  const bySize = new Map<number, number>();
  for (const t of texts) for (const r of t.text!.runs) bySize.set(r.size, (bySize.get(r.size) ?? 0) + r.length);
  const body = [...bySize].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  if (!body || sizeOf(head) < TELLS.headingStep * body) return;
  const n = wordCount(head.text!.chars);
  if (n > DECK.topicWords) return;
  push(head.node, "topic_title", "info",
    `heads the slide "${u.node.name}" with ${quote(head.text!.chars)}, ${n} word${n > 1 ? "s" : ""}: a topic, not an assertion. The ` +
      "assertion-evidence approach writes the headline as the slide's message in one sentence (\"Renewals carried Q3: revenue up 18 %\") and " +
      "lets a picture, a chart or a diagram below be the evidence. Rewrite it (figma_set_text).");
}

/**
 * two_focal: two ideas competing on one slide — exactly two texts at its
 * largest size (lines of one headline set as two texts count once), or its
 * two largest blocks within near_size of each other with nothing else as
 * large (a pair, not a row of cards). One idea per slide (slides deck-recipes).
 */
function twoFocal(u: Layer, texts: Layer[], ix: Index, f: SlideFacts | null, push: Push): void {
  const lettered = texts.filter((t) => t.text!.chars.trim());
  if (lettered.length >= 2 && ix.body > 0) {
    const top = Math.max(...lettered.map(sizeOf));
    if (top >= TELLS.headingStep * ix.body) {
      const atTop = lettered.filter((t) => sizeOf(t) * CRAFT.nearSize >= top);
      // Union the pieces of one headline: texts that touch within a fraction of their size.
      const group = atTop.map((_, i) => i);
      const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
      for (let i = 0; i < atTop.length; i++) {
        for (let j = i + 1; j < atTop.length; j++) {
          const a = atTop[i]!.text!.glyphs;
          const b = atTop[j]!.text!.glyphs;
          const near = DECK.stackedEm * Math.max(sizeOf(atTop[i]!), sizeOf(atTop[j]!));
          const stacked = overlapX(a, b) > 0 && -overlapY(a, b) <= near;
          const inline = overlapY(a, b) > 0 && -overlapX(a, b) <= near;
          if (stacked || inline) group[find(i)] = find(j);
        }
      }
      const heads = new Map<number, Layer>();
      atTop.forEach((t, i) => {
        if (!heads.has(find(i))) heads.set(find(i), t);
      });
      if (heads.size === 2) {
        const [a, b] = [...heads.values()] as [Layer, Layer];
        push(u.node, "two_focal", "info",
          `sets ${quote(a.text!.chars, 30)} and ${quote(b.text!.chars, 30)} both at its largest size (${r1(sizeOf(a))} and ${r1(sizeOf(b))} px): two ` +
            "headlines compete for the first look. One idea per slide — make one the headline and step the other down, or split the slide.");
        return;
      }
    }
  }
  if (!f) return;
  const slideArea = area(f.box);
  const blocks = elementsOf(u.node, f.box)
    .filter((e) => e.node.type !== "TEXT" && area(e.box) >= DECK.focalShare * slideArea && area(e.box) < DECK.groundShare * slideArea)
    .sort((a, b) => area(b.box) - area(a.box));
  if (blocks.length < 2) return;
  const side = (e: { box: Rect }) => Math.sqrt(area(e.box));
  const [a, b, third] = blocks;
  if (side(a!) / side(b!) >= CRAFT.nearSize) return;
  if (third && side(a!) / side(third) < CRAFT.nearSize) return; // a row of equal blocks is a series, not two ideas
  push(u.node, "two_focal", "info",
    `its two largest blocks, "${a!.node.name}" and "${b!.node.name}", are within ${Math.round((CRAFT.nearSize - 1) * 100)} % of each other in size, ` +
      "so the eye has no first place to land. One idea per slide: give one most of the space — or keep the even split if this is a true comparison.");
}

/** notes_missing: the brief asks for speaker notes (details.notes) and a presented slide has none. Skipped slides are not presented. */
function notes(u: Layer, unmeasured: { notes: number; frames: number }, push: Push): void {
  if (u.node.type !== "SLIDE") {
    unmeasured.frames++;
    return;
  }
  if (u.a.isSkippedSlide === true) return;
  // Not in the plugin typings; read as figma_get_slide_grid reads it.
  const got = tryGet(u.node, "speakerNotes");
  if (!got.ok || typeof got.value !== "string") {
    unmeasured.notes++;
    return;
  }
  if (got.value.trim()) return;
  push(u.node, "notes_missing", "info",
    "has no speaker notes, and the brief asks for them (details.notes). Write what the slide does not say — why it matters, the bridge to the next " +
      "slide, a source — as a few short bullets (figma_set_slide_properties speakerNotes).");
}

/**
 * repeated_skeleton: three or more consecutive content slides built on one
 * structure — the opposite of intent the slides skill names. Judged over the
 * whole deck, reported on the run's first slide when the check covers any
 * slide of it, so a batch checked root by root reports it once.
 */
function skeletons(list: SlideFacts[], checked: ReadonlySet<NodeLike>, push: Push): void {
  let run: SlideFacts[] = [];
  const flush = () => {
    if (run.length >= DECK.skeletonRun && run.some((f) => checked.has(f.node))) {
      const names = run.map((f) => `"${f.node.name}"`);
      push(run[0]!.node, "repeated_skeleton", "info",
        `starts ${run.length} consecutive content slides (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}) built on one structure: ` +
          `their ${run[0]!.skeleton.length} blocks sit at the same places, within ${DECK.skeletonTol * 100} % of the slide. One structure repeated ` +
          "slide after slide reads as a template, not a deck: move where the content anchors as the slides do different jobs.");
    }
    run = [];
  };
  for (const f of list) {
    if (f.structural) {
      flush();
      continue;
    }
    const last = run[run.length - 1];
    if (last && !sameSkeleton(last.skeleton, f.skeleton)) flush();
    run.push(f);
  }
  flush();
}
