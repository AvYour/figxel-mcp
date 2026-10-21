// figma_check_layout's `copy` audit: the words of an interface, read the way a
// content designer reads them (role spec §4.3). A button says what happens
// (Apple HIG Writing: a verb), one capitalisation style serves one kind of
// element, an error message is human-readable and never an interjection
// (Apple HIG Writing; NN/g error-message guidelines), and one thing is
// written one way — one wording, one dash, one kind of quote mark (the design
// skill's `finish`), which until now only a read of figma_scan_text_nodes
// could find.
//
// Every kind is info: each may be the brief's choice, and none is calibrated
// against finished work yet. Plain functions over the census, after the walk.

import { type RoleContext, controlsOf, words } from "./a11y.js";
import type { Census, Finding, Index, Layer } from "./craft.js";
import type { NodeLike } from "./read.js";

/** Every list and limit of the copy audit, to calibrate here. */
export const COPY = {
  /** generic_label: labels that say nothing about what happens (compared lower-case, trimmed, without a trailing arrow or full stop). */
  generic: ["submit", "ok", "click here", "learn more", "read more", "go", "yes", "no", "continue"],
  /** error_interjection: Apple HIG Writing — no "oops" in an error. */
  interjection: /\b(oops|uh[- ]?oh|whoops)\b/i,
  /** error_code_only: a code is "around" words when a sibling text has this many words. */
  wordsAround: 3,
  /** label_case_mixed: words title case leaves lower-case. */
  smallWords: ["a", "an", "the", "and", "but", "or", "nor", "for", "of", "to", "at", "by", "as", "via", "per", "vs"],
  /** copy_variants: texts longer than this are paragraphs, compared by the skill's read, not here. */
  variantMaxChars: 200,
} as const;

/** A node named for a button or a call to action, whatever its type. */
const BUTTON_NAME = /(^| )(button|btn|cta)s?( |$)/;

type Push = (n: NodeLike, kind: string, detail: string) => void;

export function judgeCopy(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, detail) => out.push({ kind, severity: "info", nodeId: n.id, name: n.name, detail });
  const labels = buttonLabels(c, ix, rc);
  genericLabels(labels, push);
  mixedCase(c, labels, push);
  interjections(ix, push);
  codesOnly(ix, push);
  variants(ix, push);
  return out;
}

/** The text in each button-like node: a control of the button kind, or a layer named button, btn or cta. */
function buttonLabels(c: Census, ix: Index, rc: RoleContext): Array<{ owner: NodeLike; t: Layer }> {
  const owners = new Set<NodeLike>();
  for (const x of controlsOf(c, ix, rc)) if (x.type === "button") owners.add(x.l.node);
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) if (!l.text && BUTTON_NAME.test(words(l.node.name))) owners.add(l.node);
  const out: Array<{ owner: NodeLike; t: Layer }> = [];
  for (const t of ix.texts) {
    let owner: NodeLike | undefined;
    for (let p = t.node.parent; p && !owner; p = p.parent) if (owners.has(p)) owner = p;
    if (owner) out.push({ owner, t });
  }
  return out;
}

/** A label as compared: lower-case, trimmed, without a trailing arrow, chevron or full stop. */
const bare = (s: string) => s.trim().toLowerCase().replace(/[\s.!→›>»]+$/, "").trim();

/** generic_label: a button that says nothing about what it does — "a button says what happens" (Apple HIG Writing: a verb). */
function genericLabels(labels: Array<{ owner: NodeLike; t: Layer }>, push: Push): void {
  for (const { owner, t } of labels) {
    const s = bare(t.text!.chars);
    if ((COPY.generic as readonly string[]).indexOf(s) < 0) continue;
    push(t.node, "generic_label",
      `the button "${owner.name}" says "${t.text!.chars.trim()}", which tells nobody what happens. Name the action and its object ` +
        "(\"Book the bench\", \"Send invoice\"): a button says what it does (Apple HIG Writing: start with a verb).");
  }
}

/** A label's capitalisation: title case, sentence case, or neither (one word, all caps, a lower-case start, or a proper noun inside). */
export function caseStyle(s: string): "title" | "sentence" | null {
  const ws = s.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (ws.length < 2 || s === s.toUpperCase()) return null;
  const cap = (w: string) => /^[^A-Za-z]*[A-Z]/.test(w);
  if (!cap(ws[0]!)) return null;
  const rest = ws.slice(1).filter((w) => (COPY.smallWords as readonly string[]).indexOf(w.toLowerCase().replace(/[^a-z]/g, "")) < 0);
  if (!rest.length) return null;
  const caps = rest.filter(cap).length;
  return caps === rest.length ? "title" : caps === 0 ? "sentence" : null;
}

/** label_case_mixed: button labels in one deliverable set in title case and in sentence case (Apple HIG Writing: one style per element type). */
function mixedCase(c: Census, labels: Array<{ owner: NodeLike; t: Layer }>, push: Push): void {
  const by: Record<"title" | "sentence", string[]> = { title: [], sentence: [] };
  for (const { t } of labels) {
    if (t.a.textCase === "UPPER" || t.a.textCase === "LOWER" || t.a.textCase === "TITLE") continue; // the style, not the words, sets the case
    const s = t.text!.chars.trim();
    const style = caseStyle(s);
    if (style && by[style].indexOf(s) < 0) by[style].push(s);
  }
  if (!by.title.length || !by.sentence.length) return;
  const show = (list: string[]) => list.slice(0, 3).map((s) => `"${s.slice(0, 30)}"`).join(", ");
  push(c.rootNode, "label_case_mixed",
    `its buttons mix title case (${show(by.title)}) and sentence case (${show(by.sentence)}). Pick one style for every button ` +
      "(Apple HIG Writing: one capitalisation style per kind of element) and rewrite the others (figma_set_text).");
}

/** error_interjection: "Oops", "Uh-oh", "Whoops" in an interface (Apple HIG Writing). */
function interjections(ix: Index, push: Push): void {
  for (const t of ix.texts) {
    const m = COPY.interjection.exec(t.text!.chars);
    if (!m) continue;
    push(t.node, "error_interjection",
      `says "${m[0]}" — an interjection makes light of the user's problem (Apple HIG Writing). Say what happened and what to do next, plainly.`);
  }
}

// An error code with nothing human around it: "Error 500", "Error code: 0x80070005",
// "ERR_CONNECTION_REFUSED", "0x80070005". A bare number is a statistic as often as a code, so it is not one here.
const CODE = [
  /^(error|err|error code|code|status)\s*[:#-]?\s*[A-Za-z]*[-_]?[0-9][0-9A-Za-z_.-]*[.!]?$/i,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^0x[0-9a-f]{4,}$/i,
];
const wordCount = (s: string) => s.trim().split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length;

/** error_code_only: an error code with no words around it (NN/g error-message guidelines: human-readable language). */
function codesOnly(ix: Index, push: Push): void {
  for (const t of ix.texts) {
    const s = t.text!.chars.trim();
    if (s.length > 60 || !CODE.some((re) => re.test(s))) continue;
    const parent = t.node.parent;
    const around = parent ? ix.kids(parent).some((k) => k !== t && !!k.text && wordCount(k.text.chars) >= COPY.wordsAround) : false;
    if (around) continue;
    push(t.node, "error_code_only",
      `reads "${s}" with no words around it: a code tells the user nothing (NN/g: error messages in human-readable language). Say what ` +
        "went wrong and what to do next; keep the code beside the message for support, if at all.");
  }
}

/** A string with case, punctuation, dashes and quote marks taken out: what it says, not how it is set. */
export function copyKey(s: string): string {
  return s
    .toLowerCase()
    // ASCII punctuation, then quote marks, dashes, the ellipsis and the non-breaking space.
    .replace(/[!-/:-@[-`{-~]/g, " ")
    .replace(/[‘’‚‛“”„‟′″«»‹›‐-―−… ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** copy_variants: one thing written two ways — "Sign up" and "Sign-up", "don't" and "don’t" (design `finish`: one wording, one dash, one quote mark). */
function variants(ix: Index, push: Push): void {
  const groups = new Map<string, Map<string, Layer[]>>();
  for (const t of ix.texts) {
    const raw = t.text!.chars.trim();
    if (raw.length > COPY.variantMaxChars) continue;
    const key = copyKey(raw);
    if (key.length < 2 || !/[a-z]/.test(key)) continue;
    const byRaw = groups.get(key) ?? new Map<string, Layer[]>();
    groups.set(key, byRaw);
    byRaw.set(raw, [...(byRaw.get(raw) ?? []), t]);
  }
  for (const byRaw of groups.values()) {
    if (byRaw.size < 2) continue;
    // The most used spelling is the house one; each other spelling is reported once, on its first text.
    const ranked = [...byRaw].sort((a, b) => b[1].length - a[1].length);
    const [house, houseUses] = ranked[0]!;
    for (const [raw, uses] of ranked.slice(1)) {
      push(uses[0]!.node, "copy_variants",
        `reads "${raw.slice(0, 60)}"${uses.length > 1 ? ` (${uses.length} texts)` : ""}, and "${houseUses[0]!.node.name}" (${houseUses[0]!.node.id}) ` +
          `writes the same thing "${house.slice(0, 60)}". Write one thing one way — one wording, one dash, one kind of quote mark (figma_find_replace_text).`);
    }
  }
}
