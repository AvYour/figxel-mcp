// figma_stress_test — the content stress test (trust spec §3). A design that
// looks right with tidy placeholder copy breaks once real content arrives:
// long names, translations, big numbers, empty lists. This shows it inside
// Figma, before any code exists.
//
// Per case the frame is cloned once to an empty spot on its page, the case is
// applied to the copy, and figma_check_layout's own walk (checkLayout, with
// `craft` and the audits asked for) runs on the original — the baseline — and
// on the copy. What a case broke is a finding on its copy that the baseline
// does not have, keyed by kind and layer path, so it maps back to the
// original's layer (`Card / Title`). The copies are deleted unless `keep`; the
// original is never touched; the dispatcher commits one undo step.
//
// Every number and table here is exported, so a calibration run can change it
// in one place: the expansion bands are the top of IBM's [C-396].
//
// Limits: a text with several styles takes its first one in the copy (writing
// `characters` does that); texts whose font will not load are skipped and
// listed; a list inside an instance cannot gain or lose items, so it is left
// as it is. `names` is never run: it measures the whole page, where every copy
// repeats every name.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { childrenOf, field } from "./board-read.js";
import { beforeMutating } from "./guard.js";
import { AUDITS, checkLayout, type AuditKind, type Issue } from "./ops/check.js";
import type { OpContext, PluginOp } from "./ops/index.js";
import { emptySpot } from "./ops/storyboard.js";
import { ensureLoaded } from "./pages.js";
import type { NodeLike } from "./read.js";
import type { NodeLikeW } from "./write.js";

// ── the cases and their tables ──────────────────────────────────────────────

export const CASES = ["expand", "long", "numbers", "many", "empty"] as const;
export type StressCase = (typeof CASES)[number];
/** The cases that rewrite texts, and so need their fonts loaded. */
const TEXT_CASES: ReadonlySet<StressCase> = new Set(["expand", "long", "numbers"]);

/**
 * Translation growth by source length in characters: the top of each IBM
 * band [C-396] — up to 10 characters 300 %, up to 20 200 %, up to 30 180 %,
 * up to 50 160 %, up to 70 150 % (the spec's figure for the row printed as
 * 151–170 %), beyond 130 %.
 */
export const EXPANSION: ReadonlyArray<{ upTo: number; factor: number }> = [
  { upTo: 10, factor: 3 },
  { upTo: 20, factor: 2 },
  { upTo: 30, factor: 1.8 },
  { upTo: 50, factor: 1.6 },
  { upTo: 70, factor: 1.5 },
  { upTo: Infinity, factor: 1.3 },
];

/** Pseudo-localised letters: the copy still reads, and reads as a test. */
export const ACCENTS: Readonly<Record<string, string>> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Ŝ", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** `long`: a single word becomes one unbroken compound this long. */
export const COMPOUND_LENGTH = 24;

/** `numbers`: what a run of digits becomes. */
export const NUMBERS = {
  /** An integer part under `digits` digits. */
  integer: "12,345",
  digits: 5,
  /** A longer one keeps its digits and gains these, grouped by thousands. */
  append: "000",
  /** A percentage: the largest a share can be. */
  percent: "100",
};

/** `many` / `empty`: an auto-layout list is this many instances of one component, or more. */
export const LIST_MIN = 3;
/** `many`: a list grows to this many times its items. */
export const MANY_FACTOR = 3;

/** checkLayout's node budget per frame. */
export const MAX_NODES = 5_000;
/** Findings listed per case; the rest are counted in `more`. */
export const MAX_BROKE = 50;

// ── the transformations (pure) ──────────────────────────────────────────────

export function expansionFactor(length: number): number {
  for (const band of EXPANSION) if (length <= band.upTo) return band.factor;
  return EXPANSION[EXPANSION.length - 1]!.factor;
}

export function accent(s: string): string {
  let out = "";
  for (const ch of s) out += ACCENTS[ch] ?? ch;
  return out;
}

/**
 * `expand`: the text at its translated length, bracketed — `Send now` (8) →
 * 24 characters, `[Ŝéñð ñöŵ Ŝéñð ñöŵ Ŝéñð]`. The growth repeats the text's own
 * accented letters, so it is as wide as words are — dots would be narrower
 * than the translation they stand for — and it wraps where words do.
 */
export function expandText(s: string): string {
  if (!s.trim()) return s;
  const target = Math.ceil(s.length * expansionFactor(s.length));
  const own = accent(s);
  let body = own;
  while (body.length < target - 2) body += ` ${own}`;
  return `[${body.slice(0, Math.max(own.length, target - 2))}]`;
}

/** Digits, space and punctuation only: a price, a date, a count — not a name. */
const NOT_A_WORD = /[\s\d.,:;!?%$€£¥+\-–—()[\]{}'"/\\#*&@|<>=~^_`]/;
const hasWord = (s: string) => {
  for (const ch of s) if (!NOT_A_WORD.test(ch)) return true;
  return false;
};

/** A word made one `COMPOUND_LENGTH`-character compound: `Pricing` → `Pricingpricingpricingpri`. */
export function compound(word: string): string {
  if (word.length >= COMPOUND_LENGTH) return word;
  let out = word;
  while (out.length < COMPOUND_LENGTH) out += word.toLowerCase();
  return out.slice(0, COMPOUND_LENGTH);
}

/**
 * `long`: names, titles and labels at their longest plausible form — a text of
 * several words doubled in words, a single word a compound. A text with no
 * word in it (a price, a date) is left to `numbers`.
 */
export function longText(s: string): string {
  const trimmed = s.trim();
  if (!trimmed || !hasWord(trimmed)) return s;
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return s.replace(trimmed, compound(trimmed));
  return `${s.replace(/\s+$/, "")} ${trimmed}`;
}

function grouped(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * `numbers`: every run of digits a large value of the same form — `9` →
 * `12,345`, `$9.99` → `$12,345.99`, `3%` → `100%`. A decimal part keeps its
 * places; what stands around the number stays.
 */
export function largeNumbers(s: string): string {
  return s.replace(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?%)?/g, (_m, int: string, dec: string | undefined, pct: string | undefined) => {
    if (pct) return `${NUMBERS.percent}${dec ? `.${"0".repeat(dec.length - 1)}` : ""}${pct}`;
    const digits = int.replace(/,/g, "");
    const big = digits.length < NUMBERS.digits ? NUMBERS.integer : grouped(digits + NUMBERS.append);
    return `${big}${dec ?? ""}`;
  });
}

export const TEXT_TRANSFORMS: Readonly<Record<"expand" | "long" | "numbers", (s: string) => string>> = {
  expand: expandText,
  long: longText,
  numbers: largeNumbers,
};

// ── reading the tree ────────────────────────────────────────────────────────

type FontName = { family: string; style: string };

interface StressNode extends NodeLikeW {
  clone?(): StressNode;
  x?: number;
  y?: number;
  characters?: string;
}

interface StressFigma {
  currentPage: NodeLikeW & { selection?: readonly NodeLikeW[] };
  getNodeByIdAsync(id: string): Promise<NodeLikeW | null>;
  loadFontAsync(font: FontName): Promise<void>;
}

const api = () => (globalThis as unknown as { figma: StressFigma }).figma;
const kids = (n: NodeLikeW) => (childrenOf(n as NodeLike) ?? []) as readonly NodeLikeW[];

/** Every node of a subtree, root first. */
function walk(root: NodeLikeW): NodeLikeW[] {
  const out: NodeLikeW[] = [];
  const stack: NodeLikeW[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    const k = kids(n);
    for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]!);
  }
  return out;
}

/** Original and copy, node by node: a clone has the same tree, child by child. */
function pairUp(original: NodeLikeW, copy: NodeLikeW): Map<NodeLikeW, NodeLikeW> {
  const pairs = new Map<NodeLikeW, NodeLikeW>();
  const stack: Array<[NodeLikeW, NodeLikeW]> = [[original, copy]];
  while (stack.length) {
    const [o, c] = stack.pop()!;
    pairs.set(o, c);
    const ok = kids(o);
    const ck = kids(c);
    for (let i = 0; i < Math.min(ok.length, ck.length); i++) stack.push([ok[i]!, ck[i]!]);
  }
  return pairs;
}

/** A layer's path from the frame: `Card / Title`, the frame named as the original is. */
export function pathOf(node: NodeLikeW, root: NodeLikeW, rootName: string): string {
  const names: string[] = [];
  let n: NodeLikeW | null | undefined = node;
  for (let depth = 0; n && n.id !== root.id && depth < 100; depth++) {
    names.push(n.name);
    n = field<NodeLikeW | null>(n, "parent");
  }
  return [rootName, ...names.reverse()].join(" / ");
}

function pageOf(node: NodeLikeW): NodeLikeW | null {
  let n: NodeLikeW | null | undefined = node;
  while (n && n.type !== "PAGE") n = field<NodeLikeW | null>(n, "parent");
  return n ?? null;
}

/** The fonts a text uses, or null when they cannot be read. */
function fontsOf(t: NodeLikeW): FontName[] | null {
  const chars = field<string>(t, "characters") ?? "";
  const all = field<(s: number, e: number) => FontName[]>(t, "getRangeAllFontNames");
  if (chars.length > 0 && typeof all === "function") {
    try {
      return all.call(t, 0, chars.length);
    } catch {
      return null;
    }
  }
  const f = field<FontName | symbol>(t, "fontName");
  return f && typeof f === "object" && typeof f.family === "string" ? [f] : null;
}

const fontKey = (f: FontName) => `${f.family} ${f.style}`;

/**
 * Load every font the frame's texts use, once per run. A text whose font will
 * not load (or cannot be read) is not rewritten in any copy, and is listed.
 */
async function loadFonts(figma: StressFigma, root: NodeLikeW, rootName: string) {
  const texts = walk(root).filter((n) => n.type === "TEXT");
  const loaded = new Map<string, boolean>();
  const skipped: Array<{ nodeId: string; path: string; fonts: string[] }> = [];
  const usable = new Set<NodeLikeW>();
  for (const t of texts) {
    const fonts = fontsOf(t);
    if (!fonts) {
      skipped.push({ nodeId: t.id, path: pathOf(t, root, rootName), fonts: ["unreadable"] });
      continue;
    }
    const missing: string[] = [];
    for (const f of fonts) {
      const key = fontKey(f);
      if (!loaded.has(key)) {
        try {
          await figma.loadFontAsync(f);
          loaded.set(key, true);
        } catch {
          loaded.set(key, false);
        }
      }
      if (!loaded.get(key)) missing.push(key);
    }
    if (missing.length) skipped.push({ nodeId: t.id, path: pathOf(t, root, rootName), fonts: missing });
    else usable.add(t);
  }
  return { usable, skipped };
}

const AUTO_LAYOUTS = new Set(["HORIZONTAL", "VERTICAL", "GRID"]);

/** The component an instance shows: its id, else (no async lookup) the instance's name. */
async function componentOf(n: NodeLikeW): Promise<string> {
  const get = field<() => Promise<{ id?: string } | null>>(n, "getMainComponentAsync");
  if (typeof get === "function") {
    try {
      const main = await get.call(n);
      if (main && typeof main.id === "string") return main.id;
    } catch {
      /* the name below */
    }
  }
  return `name:${n.name}`;
}

/**
 * The lists `many` and `empty` act on: in each auto-layout, the instances of
 * one component when there are LIST_MIN or more. Not inside an instance,
 * whose children cannot be added or removed.
 */
export async function listsIn(root: NodeLikeW): Promise<Array<{ parent: NodeLikeW; items: NodeLikeW[] }>> {
  const lists: Array<{ parent: NodeLikeW; items: NodeLikeW[] }> = [];
  for (const n of walk(root)) {
    if (!AUTO_LAYOUTS.has(String(field(n, "layoutMode") ?? ""))) continue;
    if (n.type === "INSTANCE" || n.id.charAt(0) === "I") continue;
    const groups = new Map<string, NodeLikeW[]>();
    for (const k of kids(n)) {
      if (k.type !== "INSTANCE") continue;
      const key = await componentOf(k);
      const list = groups.get(key) ?? [];
      list.push(k);
      groups.set(key, list);
    }
    for (const items of groups.values()) if (items.length >= LIST_MIN) lists.push({ parent: n, items });
  }
  return lists;
}

/** `many`: each list grows to MANY_FACTOR times its items, the copies right after its last item. */
async function growLists(root: NodeLikeW): Promise<number> {
  const lists = await listsIn(root);
  for (const { parent, items } of lists) {
    let at = kids(parent).indexOf(items[items.length - 1]!) + 1;
    for (let round = 1; round < MANY_FACTOR; round++) {
      for (const item of items) {
        // clone() lands on the page: an item the list refuses must not stay there.
        const copy = (item as StressNode).clone!();
        try {
          parent.insertChild!(at++, copy);
        } catch (err) {
          copy.remove?.();
          throw err;
        }
      }
    }
  }
  return lists.length;
}

/** `empty`: each list drops to none; everything else, texts included, stays. */
async function emptyLists(root: NodeLikeW): Promise<number> {
  const lists = await listsIn(root);
  for (const { items } of lists) for (const item of items) item.remove!();
  return lists.length;
}

// ── the op ──────────────────────────────────────────────────────────────────

interface Params {
  nodeId: string;
  cases: StressCase[];
  keep: boolean;
  audits: Set<AuditKind>;
  droppedNames: boolean;
}

function parse(params: Record<string, unknown>): Params {
  const nodeId = params.nodeId;
  if (typeof nodeId !== "string" || !nodeId.trim()) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required: the frame to stress.");
  let cases: StressCase[] = [...CASES];
  if (params.cases !== undefined) {
    const raw = params.cases;
    if (!Array.isArray(raw) || !raw.length || raw.some((c) => !(CASES as readonly unknown[]).includes(c))) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`cases\` lists any of: ${CASES.join(", ")}.`);
    }
    cases = CASES.filter((c) => raw.includes(c));
  }
  if (params.keep !== undefined && typeof params.keep !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`keep` is true or false.");
  const audits = new Set<AuditKind>(["craft"]);
  let droppedNames = false;
  if (params.audits !== undefined) {
    const raw = params.audits;
    if (!Array.isArray(raw) || raw.some((k) => !(AUDITS as readonly unknown[]).includes(k))) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`audits\` lists any of: ${AUDITS.join(", ")}.`);
    }
    for (const k of raw as AuditKind[]) {
      if (k === "names") droppedNames = true;
      else audits.add(k);
    }
  }
  return { nodeId, cases, keep: params.keep === true, audits, droppedNames };
}

const ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
const key = (kind: string, path: string) => `${kind}\u0000${path}`;

type Broke = { kind: string; severity: string; path: string; detail: string };

/** A check's findings by path, through `byId` (the subtree's nodes). */
function located(issues: readonly Issue[], byId: ReadonlyMap<string, NodeLikeW>, root: NodeLikeW, rootName: string) {
  return issues.map((i) => {
    const n = byId.get(i.nodeId);
    return { issue: i, path: n ? pathOf(n, root, rootName) : `${rootName} / ${i.name}` };
  });
}

async function stressTest(ctx: OpContext) {
  const figma = api();
  const prep = await beforeMutating(async () => {
    const p = parse(ctx.params);
    const node = (await figma.getNodeByIdAsync(p.nodeId)) as StressNode | null;
    if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${p.nodeId}\`.`);
    if (node.type === "PAGE" || node.type === "DOCUMENT" || node.type === "SLIDE_GRID" || node.type === "SLIDE_ROW" || typeof node.clone !== "function") {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${node.type} cannot be stress-tested: give a frame, a component, an instance or a section.`);
    }
    const page = pageOf(node);
    if (!page) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${p.nodeId}\` is not on a page.`);
    await ensureLoaded(page as never);
    const fonts = p.cases.some((c) => TEXT_CASES.has(c)) ? await loadFonts(figma, node, node.name) : { usable: new Set<NodeLikeW>(), skipped: [] };
    const base = await checkLayout(node as NodeLike, MAX_NODES, ctx, { audit: p.audits });
    return { p, node, page, fonts, base };
  });
  const { p, node, page, fonts, base } = prep;
  const rootName = node.name;
  const original = walk(node);
  const baseById = new Map(original.map((n) => [n.id, n]));
  const baseKeys = new Set(located(base.issues, baseById, node, rootName).map((l) => key(l.issue.kind, l.path)));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of base.issues) counts[i.severity]++;

  const cases: Array<{ case: StressCase; broke: Broke[]; ok: boolean; changed: number; more?: number; note?: string }> = [];
  const kept: string[] = [];
  const made: StressNode[] = [];
  const touch = (ids: string[]) => ctx.touched?.(ids);
  try {
    for (let ci = 0; ci < p.cases.length; ci++) {
      const which = p.cases[ci]!;
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, `Cancelled before the ${which} case.`);
      ctx.progress(ci, p.cases.length, which);
      const spot = emptySpot(page);
      const copy = node.clone!();
      made.push(copy);
      touch([copy.id]);
      if (field<NodeLikeW | null>(copy, "parent")?.id !== page.id) page.appendChild!(copy);
      copy.name = `${rootName} · stress: ${which}`;
      copy.x = spot.x;
      copy.y = spot.y;
      const pairs = pairUp(node, copy);
      touch(walk(copy).map((n) => n.id));

      let changed = 0;
      if (TEXT_CASES.has(which)) {
        const transform = TEXT_TRANSFORMS[which as "expand" | "long" | "numbers"];
        for (const t of fonts.usable) {
          const c = pairs.get(t) as StressNode | undefined;
          const before = c ? field<string>(c, "characters") : undefined;
          if (!c || typeof before !== "string") continue;
          const after = transform(before);
          if (after === before) continue;
          c.characters = after; // an instance's text: overridden in the copy only
          changed++;
        }
      } else if (which === "many") changed = await growLists(copy);
      else changed = await emptyLists(copy);

      const now = walk(copy);
      touch(now.map((n) => n.id));
      const byId = new Map(now.map((n) => [n.id, n]));
      // A detail naming a layer of the copy names the original's instead.
      const back = new Map<string, string>();
      for (const [o, c] of pairs) back.set(c.id, o.id);
      const checked = await checkLayout(copy as NodeLike, MAX_NODES, ctx, { audit: p.audits });
      const seen = new Set<string>();
      const broke: Broke[] = [];
      for (const { issue, path } of located(checked.issues, byId, copy, rootName)) {
        const k = key(issue.kind, path);
        if (baseKeys.has(k) || seen.has(k)) continue;
        seen.add(k);
        const detail = issue.detail
          .split(`"${copy.name}"`).join(`"${rootName}"`)
          .replace(/I?\d+:\d+(;\d+:\d+)*/g, (id) => back.get(id) ?? id);
        broke.push({ kind: issue.kind, severity: issue.severity, path, detail });
      }
      broke.sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3));
      cases.push({
        case: which,
        broke: broke.slice(0, MAX_BROKE),
        ok: !broke.some((b) => b.severity === "error" || b.severity === "warning"),
        changed,
        ...(broke.length > MAX_BROKE ? { more: broke.length - MAX_BROKE } : {}),
        ...(changed === 0 ? { note: noteFor(which) } : {}),
      });
      if (p.keep) kept.push(copy.id);
      else copy.remove!();
    }
  } catch (err) {
    // The original was never touched: take the copies away again unless they were to stay.
    if (!p.keep) for (const c of made) if (field(c, "removed") !== true) c.remove!();
    const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
    throw new BridgeError(e.code, `The stress test stopped: ${e.message}`, {
      hint: p.keep
        ? `The copies made so far stay (partial.created); the original is unchanged. Delete them with figma_delete_nodes, or run the test again.`
        : "Its copies were removed again; the original is unchanged. Run the test again.",
      partial: { created: p.keep ? made.map((c) => c.id) : [], cases },
    });
  }
  ctx.progress(p.cases.length, p.cases.length, "done");
  if (p.keep && page.id === figma.currentPage.id) {
    try {
      figma.currentPage.selection = made;
    } catch {
      /* selection is a courtesy */
    }
  }
  return {
    baseline: { ok: counts.error === 0 && counts.warning === 0, counts },
    cases,
    ...(p.keep ? { kept } : {}),
    ...(fonts.skipped.length ? { skipped: fonts.skipped } : {}),
    ...(p.droppedNames ? { note: "`names` was not run: it measures the whole page, where every copy repeats every name." } : {}),
  };
}

function noteFor(which: StressCase): string {
  return which === "many" || which === "empty"
    ? `No auto-layout list of ${LIST_MIN} or more instances of one component: nothing to ${which === "many" ? "grow" : "empty"}.`
    : "No text this case changes.";
}

const stressOp: PluginOp = {
  write: true,
  run: (ctx: OpContext) => stressTest(ctx),
};

export const STRESS_OPS: Record<string, PluginOp> = {
  stress_test: stressOp,
};
