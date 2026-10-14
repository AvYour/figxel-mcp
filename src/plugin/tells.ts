// figma_check_layout's `tells` audit: a census of the look generated design
// converges on — one default sans at two weights, a timid type scale,
// everything centred, a tracked caps label over every heading, identical icon
// cards in threes, cards in cards, one radius and one soft shadow on
// everything, a violet wash, a glow behind the headline, emoji for icons,
// template chrome strings, a rule under every heading. Figma's own slide
// guidance, Anthropic's frontend-design skill and practitioners name these
// [C-218] [C-219] [C-220]; NN/g saw broad prompts land on the same flat
// minimalism [C-217].
//
// Each is legitimate when the brief chose it, and none is calibrated yet
// against finished work, so every finding is info [C-248].
// spikes/calibrate-tells.mjs decides which rules separate the two; their
// thresholds sit in TELLS for that.

import { childrenOf } from "./board-read.js";
import { type Census, type Finding, type Index, type Layer, type Rgb, hex, intersect, r1, right, bottom } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Faces a tool or framework sets when nobody chooses one. A decision, to calibrate [C-248]. */
export const DEFAULT_FACES: ReadonlySet<string> = new Set(
  ["Inter", "Roboto", "Arial", "Helvetica", "Helvetica Neue", "SF Pro", "SF Pro Display", "SF Pro Text", "Segoe UI", "Open Sans", "system-ui"]
    .map((f) => f.toLowerCase()),
);

/** Every threshold of the tells audit: uncalibrated decisions [C-248]. */
export const TELLS = {
  /** Root-level type tells need this many texts to say anything. */
  minTexts: 3,
  /** default_typeface: one default family in this many styles or fewer. */
  defaultStyles: 2,
  /** flat_hierarchy: largest ÷ body under this, on frames this wide or wider; narrower frames use the second. */
  wideFrame: 1080,
  hierarchyWide: 2,
  hierarchyNarrow: 1.6,
  /** too_many_sizes: more distinct sizes than this. */
  maxSizes: 6,
  /** mostly_centred: over this share of multi-line characters centred; centred_block from this many lines. */
  centredShare: 0.5,
  centredLines: 3,
  /** A heading is at least this × the body size: section level, so card titles do not dilute the ratios below. */
  headingStep: 1.4,
  /** eyebrow_everywhere: the heading under a label is at least this × the label. */
  eyebrowStep: 1.2,
  /** eyebrow_everywhere: caps labels tracked this much (em), this short, over this share of headings. */
  eyebrowTracking: 0.04,
  eyebrowChars: 40,
  eyebrowShare: 0.5,
  /** measure and leading of body text [C-210]. */
  measureMin: 45,
  measureMax: 90,
  leadingMin: 1.2,
  leadingMax: 1.45,
  /** card_trio: this many identical siblings; an icon fits this square. */
  trio: 3,
  iconMax: 96,
  /** nested_cards: a card is at least this big. */
  cardWidth: 120,
  cardHeight: 60,
  /** one_radius: one radius on this many containers. */
  oneRadius: 4,
  /** same_shadow: one shadow on this share of filled containers, and on this many. */
  shadowShare: 0.8,
  shadowMin: 3,
  /** default_gradient: saturated stops inside this hue band, over this share of the frame or on a button. */
  hueFrom: 220,
  hueTo: 300,
  washShare: 0.25,
  /** glow: a layer blur this strong. */
  glowBlur: 40,
  /** divider_everywhere: this share of headings followed by a line this thin. */
  dividerShare: 0.7,
  dividerMax: 2,
} as const;

type Push = (l: Layer | null, kind: string, detail: string) => void;

export function judgeTells(c: Census, ix: Index): Finding[] {
  const out: Finding[] = [];
  // A tell with no one layer to point at names the root.
  const push: Push = (l, kind, detail) => {
    const node = l?.node ?? c.rootNode;
    out.push({ kind, severity: "info", nodeId: node.id, name: node.name, detail });
  };
  typeface(ix, push);
  hierarchy(c, ix, push);
  sizes(ix, push);
  centring(ix, push);
  eyebrows(ix, push);
  reading(ix, push);
  cardTrios(c, ix, push);
  nestedCards(c, push);
  radii(c, push);
  shadows(c, push);
  washes(c, ix, push);
  glows(c, ix, push);
  emoji(ix, push);
  chrome(ix, push);
  dividers(ix, push);
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** default_typeface (T1): one default family at two weights — the face nobody chose. */
function typeface(ix: Index, push: Push): void {
  if (ix.texts.length < TELLS.minTexts) return;
  const families = new Map<string, Set<string>>();
  for (const t of ix.texts) {
    for (const r of t.text!.runs) {
      if (!r.family) continue;
      const styles = families.get(r.family) ?? new Set<string>();
      families.set(r.family, styles);
      styles.add(r.style);
    }
  }
  if (families.size !== 1) return;
  const [family, styles] = [...families][0]!;
  if (!DEFAULT_FACES.has(family.toLowerCase()) || styles.size > TELLS.defaultStyles) return;
  push(null, "default_typeface",
    `every text is ${family}, in ${plural(styles.size, "style")} (${[...styles].join(", ")}) — the face a tool sets when nobody chooses. ` +
      "Choose one from the subject's world, or pair a display face with it; fine when the brand sets it.");
}

/** flat_hierarchy (T2): the largest text too close to the body to give the eye an entry point. */
function hierarchy(c: Census, ix: Index, push: Push): void {
  if (ix.texts.length < TELLS.minTexts || ix.body <= 0) return;
  let top: Layer | null = null;
  let largest = 0;
  for (const t of ix.texts) {
    for (const r of t.text!.runs) {
      if (r.size > largest) {
        largest = r.size;
        top = t;
      }
    }
  }
  const wide = (c.root?.box.width ?? 0) >= TELLS.wideFrame;
  const need = wide ? TELLS.hierarchyWide : TELLS.hierarchyNarrow;
  const ratio = largest / ix.body;
  if (!top || ratio >= need) return;
  push(top, "flat_hierarchy",
    `is the largest text at ${r1(largest)} px, ${ratio.toFixed(2)}× the ${r1(ix.body)} px body; ${wide ? `a frame ${TELLS.wideFrame} px or wider` : "a frame this size"} ` +
      `wants ${need}× or more for an entry point. Scale the display up from a ratio on the body size; fine for a dense tool UI.`);
}

/** too_many_sizes: more levels than a reader can tell apart. */
function sizes(ix: Index, push: Push): void {
  const all = new Set<number>();
  for (const t of ix.texts) for (const r of t.text!.runs) if (r.size > 0) all.add(Math.round(r.size * 2) / 2);
  if (all.size <= TELLS.maxSizes) return;
  push(null, "too_many_sizes",
    `uses ${all.size} text sizes (${[...all].sort((x, y) => x - y).join(", ")} px) — more levels than a reader tells apart. ` +
      "Keep a scale of a few sizes from one ratio.");
}

/** mostly_centred, centred_block (T3): centring is the alignment nobody decides. */
function centring(ix: Index, push: Push): void {
  let multi = 0;
  let centred = 0;
  for (const t of ix.texts) {
    const f = t.text!;
    if (f.lines < 2) continue;
    multi += f.chars.length;
    if (f.align !== "CENTER") continue;
    centred += f.chars.length;
    if (f.lines >= TELLS.centredLines) {
      push(t, "centred_block",
        `is a centred block of about ${f.lines} lines — ragged on both sides, so each line starts somewhere new. Left-align it; centre only titles and one-line statements.`);
    }
  }
  if (multi && centred / multi > TELLS.centredShare) {
    push(null, "mostly_centred",
      `${Math.round((100 * centred) / multi)}% of the multi-line text is centred — the no-decision alignment. Give the layout a strong left edge.`);
  }
}

/** The headings: texts that step clearly above the body. An emoji set large is an icon, not a heading. */
function headingsOf(ix: Index): Layer[] {
  return ix.body > 0 ? ix.texts.filter((t) => t.text!.size >= TELLS.headingStep * ix.body && !emojiOnly(t.text!.chars)) : [];
}

/** The next visible sibling, or the parent's when `l` is the last child. */
function nextOf(ix: Index, l: Layer, climb = 1): Layer | null {
  const p = l.node.parent;
  if (!p) return null;
  const sibs = ix.kids(p);
  const next = sibs[sibs.indexOf(l) + 1];
  if (next) return next;
  const up = ix.byNode.get(p);
  return climb > 0 && up ? nextOf(ix, up, climb - 1) : null;
}

/** The first text with something in it at or under `l`. */
function firstText(ix: Index, l: Layer, depth = 2): Layer | null {
  if (l.text) return l.text.chars.trim() ? l : null;
  if (depth <= 0) return null;
  for (const k of ix.kids(l.node)) {
    const t = firstText(ix, k, depth - 1);
    if (t) return t;
  }
  return null;
}

/** eyebrow_everywhere (T4): a small tracked caps label over most headings. */
function eyebrows(ix: Index, push: Push): void {
  const headings = new Set(headingsOf(ix));
  if (!headings.size) return;
  let count = 0;
  for (const t of ix.texts) {
    const f = t.text!;
    if (!f.caps || f.tracking < TELLS.eyebrowTracking || f.lines !== 1 || f.chars.trim().length > TELLS.eyebrowChars || !/[A-Za-z]/.test(f.chars)) continue;
    const next = nextOf(ix, t, 0);
    const heading = next ? firstText(ix, next) : null;
    if (heading && headings.has(heading) && heading.text!.size >= TELLS.eyebrowStep * f.size) count++;
  }
  if (!count || count / headings.size < TELLS.eyebrowShare) return;
  push(null, "eyebrow_everywhere",
    `${count} of ${plural(headings.size, "heading")} ${count === 1 ? "has" : "have"} a small tracked all-caps label right above — template chrome that appears whatever ` +
      "the content. Keep a label only where it says what the heading does not.");
}

/** measure, leading (T6): body text set for filling its box, not for reading [C-210]. */
function reading(ix: Index, push: Push): void {
  if (ix.body <= 0) return;
  for (const t of ix.texts) {
    const f = t.text!;
    if (f.size <= 0 || f.size >= TELLS.headingStep * ix.body) continue;
    if (f.lines >= 3) {
      // The last line is short; half of it is a fair guess with no line boxes to read.
      const perLine = [...f.chars].filter((ch) => !BREAKS.has(ch.codePointAt(0)!)).length / (f.lines - 0.5);
      if (perLine < TELLS.measureMin || perLine > TELLS.measureMax) {
        push(t, "measure",
          `sets about ${Math.round(perLine)} characters per line over ${f.lines} lines; reading text is comfortable at ` +
            `${TELLS.measureMin}–${TELLS.measureMax}. ${perLine > TELLS.measureMax ? "Narrow" : "Widen"} its column (figma_resize_nodes).`);
      }
    }
    const lead = f.leading;
    if (lead !== undefined && f.lines >= 2 && Math.abs(f.size - ix.body) <= 0.15 * ix.body
      && (lead < TELLS.leadingMin - 0.005 || lead > TELLS.leadingMax + 0.005)) {
      push(t, "leading",
        `is body text at ${lead.toFixed(2)}× line height; body reads best at ${TELLS.leadingMin}–${TELLS.leadingMax}×. ` +
          `Set lineHeight near ${Math.round(f.size * 1.35)} px (figma_set_text_properties).`);
    }
  }
}

const CARD_HOLDERS = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);
const VECTORISH = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);

/** Whether a text sits anywhere under `n`. */
function holdsText(ix: Index, n: NodeLike, depth = 4): boolean {
  return depth > 0 && ix.kids(n).some((k) => (k.text ? k.text.chars.trim() !== "" : holdsText(ix, k.node, depth - 1)));
}

/** A card's contents in order: I an icon or a small image, T a text, M anything bigger. */
function skeleton(ix: Index, n: NodeLike, depth = 0): string {
  let s = "";
  for (const k of ix.kids(n)) {
    const type = k.node.type;
    if (k.text) s += emojiOnly(k.text.chars) ? "I" : k.text.chars.trim() ? "T" : "";
    else if (VECTORISH.has(type) || (k.box.width <= TELLS.iconMax && k.box.height <= TELLS.iconMax && !holdsText(ix, k.node))) s += "I";
    else if (CARD_HOLDERS.has(type) && depth < 3) s += skeleton(ix, k.node, depth + 1);
    else s += "M";
  }
  return s;
}

function fillKey(a: Any): string {
  const fills = visible(a.fills);
  const top = fills[fills.length - 1];
  if (!top) return "none";
  return top.type === "SOLID" ? hex(top.color as Rgb) : String(top.type);
}

/** card_trio (L2): three or more identical icon + title + text siblings — the feature-trio kit. */
function cardTrios(c: Census, ix: Index, push: Push): void {
  const parents = c.root ? [c.root, ...c.layers] : c.layers;
  for (const p of parents) {
    const kids = ix.kids(p.node);
    if (kids.length < TELLS.trio) continue;
    let run: Array<{ l: Layer; key: string }> = [];
    const flush = () => {
      if (run.length >= TELLS.trio && /^IT{2,}$/.test(run[0]!.key.split("|").pop()!)) {
        const names = run.slice(0, 3).map((x) => `"${x.l.node.name}"`).join(", ");
        push(run[0]!.l, "card_trio",
          `${names}${run.length > 3 ? ` and ${run.length - 3} more` : ""} are ${run.length} identical cards of icon + title + text — the ` +
            "feature-trio kit, whatever each item weighs. Rank them: give the one that matters most more room, or set them as a list.");
      }
      run = [];
    };
    for (const k of kids) {
      if (!CARD_HOLDERS.has(k.node.type) || k.inInstance) {
        flush();
        continue;
      }
      const key = `${k.node.type}|${radius(k.a).key}|${fillKey(k.a)}|${skeleton(ix, k.node)}`;
      const first = run[0];
      if (first && (first.key !== key || Math.abs(first.l.box.width - k.box.width) > 1 || Math.abs(first.l.box.height - k.box.height) > 1)) flush();
      run.push({ l: k, key });
    }
    flush();
  }
}

/** A container's corner radius, and a key that tells mixed corners apart. */
function radius(a: Any): { value: number; key: string } {
  if (typeof a.cornerRadius === "number") return { value: a.cornerRadius, key: String(r1(a.cornerRadius)) };
  const corners = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"].map((k) => (typeof a[k] === "number" ? (a[k] as number) : 0));
  return { value: Math.max(...corners), key: corners.map(r1).join("/") };
}

const CARD_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

/** nested_cards (L3): filled, rounded containers inside one another. */
function nestedCards(c: Census, push: Push): void {
  const isCard = (l: Layer) => CARD_TYPES.has(l.node.type) && l.filled && !l.inInstance && radius(l.a).value > 0
    && l.box.width >= TELLS.cardWidth && l.box.height >= TELLS.cardHeight;
  const cards = new Set<NodeLike>();
  if (c.root && isCard(c.root)) cards.add(c.rootNode);
  for (const l of c.layers) if (isCard(l)) cards.add(l.node);
  for (const l of c.layers) {
    if (!cards.has(l.node)) continue;
    for (let p = l.node.parent; p; p = p.parent) {
      if (!cards.has(p)) continue;
      push(l, "nested_cards",
        `is a filled, rounded card inside the card "${p.name}" (${p.id}) — boxes in boxes flatten the hierarchy. Group with space and type; ` +
          "keep a container only where grouping needs one.");
      break;
    }
  }
}

const RADIUS_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "RECTANGLE"]);

/** one_radius, nested_radius (S3): one kit radius everywhere; an inner corner as round as its outer one. */
function radii(c: Census, push: Push): void {
  const painted = (c.root ? [c.root, ...c.layers] : c.layers)
    .filter((l) => RADIUS_TYPES.has(l.node.type) && !l.inInstance && (l.filled || l.stroked))
    .map((l) => ({ l, r: radius(l.a) }))
    .filter((x) => x.r.value > 0);
  const byNode = new Map(painted.map((x) => [x.l.node, x]));
  // A pill is a shape of its own, not a radius setting.
  const rounded = painted.filter((x) => x.l !== c.root && x.r.value < Math.min(x.l.box.width, x.l.box.height) / 2 - 0.5);
  const keys = new Set(rounded.map((x) => x.r.key));
  if (rounded.length >= TELLS.oneRadius && keys.size === 1) {
    push(null, "one_radius",
      `${rounded.length} containers all have radius ${[...keys][0]} — a kit setting, not a system. Set radius by role and size, or go sharp if the direction says so.`);
  }
  for (const x of rounded) {
    let outer: { l: Layer; r: { value: number } } | undefined;
    for (let p = x.l.node.parent; p && !outer; p = p.parent) outer = byNode.get(p);
    if (!outer) continue;
    const P = outer.l.box;
    const B = x.l.box;
    const inset = Math.min(B.x - P.x, right(P) - right(B), B.y - P.y, bottom(P) - bottom(B));
    if (inset <= 0.5 || x.r.value < outer.r.value) continue;
    push(x.l, "nested_radius",
      `has radius ${r1(x.r.value)} inside "${outer.l.node.name}" (radius ${r1(outer.r.value)}), inset ${r1(inset)} px — an inner corner as ` +
        `round as the outer one looks pinched. Inner = outer − inset: about ${Math.max(0, r1(outer.r.value - inset))}.`);
  }
}

function visible(list: unknown): Any[] {
  return Array.isArray(list) ? (list as Any[]).filter((p) => p.visible !== false) : [];
}

/** A drop shadow as one comparable string. */
function shadowKey(a: Any): string | null {
  const s = visible(a.effects).find((e) => e.type === "DROP_SHADOW");
  if (!s) return null;
  const color = s.color as (Rgb & { a?: number }) | undefined;
  const offset = s.offset as { x?: number; y?: number } | undefined;
  const alpha = typeof color?.a === "number" ? color.a : 1;
  return `${color ? hex(color) : "?"} ${Math.round(alpha * 100)}% ${offset?.x ?? 0},${offset?.y ?? 0} blur ${s.radius ?? 0}` +
    (typeof s.spread === "number" && s.spread ? ` spread ${s.spread}` : "");
}

const FILL_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "RECTANGLE"]);

/** same_shadow (S4): one soft shadow under nearly every filled container — elevation as decoration. */
function shadows(c: Census, push: Push): void {
  const filled = c.layers.filter((l) => FILL_TYPES.has(l.node.type) && l.filled && !l.inInstance);
  const counts = new Map<string, number>();
  for (const l of filled) {
    const k = shadowKey(l.a);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [key, n] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  if (n < TELLS.shadowMin || n / filled.length < TELLS.shadowShare) return;
  push(null, "same_shadow",
    `${n} of ${filled.length} filled containers carry the same drop shadow (${key}) — elevation as decoration. Lift only what sits above something, in few levels.`);
}

/** Hue (degrees), saturation and lightness of a colour. */
function hsl(c: Rgb): { h: number; s: number; l: number } {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === c.r ? ((c.g - c.b) / d) % 6 : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

/** A small rounded container holding a label, or one named for a button. */
function buttonish(ix: Index, l: Layer): boolean {
  if (/\b(button|btn|cta)\b/i.test(l.node.name)) return true;
  return CARD_TYPES.has(l.node.type) && radius(l.a).value > 0 && l.box.height <= 72 && l.box.width <= 480 && ix.kids(l.node).some((k) => k.text);
}

/** default_gradient (S1): a violet-to-indigo wash nobody chose, over much of the frame or on a button. */
function washes(c: Census, ix: Index, push: Push): void {
  const area = c.root ? c.root.box.width * c.root.box.height : 0;
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    for (const p of visible(l.a.fills)) {
      if (!String(p.type).startsWith("GRADIENT_")) continue;
      const stops = Array.isArray(p.gradientStops) ? (p.gradientStops as Array<{ color?: Rgb }>) : [];
      const hues = stops.filter((s) => s.color).map((s) => hsl(s.color!)).filter((x) => x.s >= 0.25 && x.l > 0.1 && x.l < 0.95);
      if (!hues.length || !hues.every((x) => x.h >= TELLS.hueFrom && x.h <= TELLS.hueTo)) continue;
      const share = area ? (l.box.width * l.box.height) / area : 0;
      const button = buttonish(ix, l);
      if (share < TELLS.washShare && !button) continue;
      const span = `${Math.round(Math.min(...hues.map((x) => x.h)))}–${Math.round(Math.max(...hues.map((x) => x.h)))}°`;
      push(l, "default_gradient",
        `is painted with a blue-violet gradient (hue ${span}) ${share >= TELLS.washShare ? `over ${Math.round(share * 100)}% of the frame` : "on a button"} — ` +
          "the wash generated UIs default to. Take colour from the subject, or keep the gradient with a reason (light, a material).");
      break;
    }
  }
}

/** glow (S2): a radial gradient or a heavy blur behind text — atmosphere standing in for an idea. */
function glows(c: Census, ix: Index, push: Push): void {
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    const radial = visible(l.a.fills).some((p) => p.type === "GRADIENT_RADIAL");
    const blur = Math.max(0, ...visible(l.a.effects).filter((e) => e.type === "LAYER_BLUR").map((e) => (typeof e.radius === "number" ? e.radius : 0)));
    if (!radial && blur < TELLS.glowBlur) continue;
    const over = ix.texts.find((t) => (t.order > l.order || ix.isAncestor(l.node, t.node)) && intersect(l.box, t.text!.glyphs));
    if (!over) continue;
    push(l, "glow",
      `${radial ? "a radial gradient" : `a ${r1(blur)} px layer blur`} glows behind "${over.node.name}" (${over.node.id}) — atmosphere standing in ` +
        "for an idea. Get depth from scale, contrast and real surfaces; keep it when light is the subject.");
  }
}

// Invisible and separator characters by code point: written literally, they
// would break a regex literal (a line separator ends the line) or vanish in review.
/** Line and paragraph breaks: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
const BREAKS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);
/** What joins or restyles an emoji rather than standing alone: VS16, ZWJ, the keycap. */
const JOINERS = new Set([0xfe0f, 0x200d, 0x20e3]);

/** A text's lines, split at any break. */
function linesOf(s: string): string[] {
  const out = [""];
  for (const ch of s) {
    if (BREAKS.has(ch.codePointAt(0)!)) out.push("");
    else out[out.length - 1] += ch;
  }
  return out;
}

/** Code points drawn as typographic marks in text faces, not as emoji, unless asked to be (U+FE0F). */
const TEXT_MARKS = new Set([0x2605, 0x2606, 0x2713, 0x2717]);

/** Emoji ranges, written out: the sandbox targets ES2017, which has no \p{Extended_Pictographic}. */
function pictographic(cp: number): boolean {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return !TEXT_MARKS.has(cp);
  return cp === 0x2b50 || cp === 0x2b55 || cp === 0x2b1b || cp === 0x2b1c;
}

/** Whether `s` opens with an emoji: a pictograph, or any character asked to draw as one. */
function startsWithEmoji(s: string): boolean {
  const cp = s.codePointAt(0);
  if (cp === undefined) return false;
  if (pictographic(cp)) return true;
  return s.charCodeAt(cp > 0xffff ? 2 : 1) === 0xfe0f;
}

/** A text that is nothing but emoji: an icon set in type. */
function emojiOnly(s: string): boolean {
  const t = s.trim();
  return t !== "" && [...t].every((ch) => pictographic(ch.codePointAt(0)!) || JOINERS.has(ch.codePointAt(0)!) || ch.trim() === "") && startsWithEmoji(t);
}

/** emoji_icon (I1): an emoji standing in for an icon, a bullet or a section marker. */
function emoji(ix: Index, push: Push): void {
  for (const t of ix.texts) {
    const lines = linesOf(t.text!.chars).map((l) => l.trim());
    const line = lines.find((l) => l && startsWithEmoji(l));
    if (!line) continue;
    push(t, "emoji_icon",
      `${lines.length > 1 ? "starts a line" : "starts"} with "${[...line][0]}" — an emoji standing in for an icon. Draw icons in one weight (figma_import_svg), or drop them.`);
  }
}

const META = /\S\s+[·•]\s+\S/;
const ARROW = /(→|↗|->)\s*$/;
const LABEL_DASH = /^([A-Z0-9][A-Z0-9&'’. ]*[A-Z0-9])\s+[—–]\s+\S/;
const NUMBERED = /^0[1-9](?![0-9])/;

/** chrome_string (C3): template strings that appear whatever the subject. */
function chrome(ix: Index, push: Push): void {
  const numbered: Layer[] = [];
  for (const t of ix.texts) {
    const s = t.text!.chars.trim();
    const found: string[] = [];
    if (s.length <= 120 && META.test(s)) found.push("an \"A · B · C\" meta string");
    if (s.length <= 40 && ARROW.test(s)) found.push("an arrow appended to a label");
    const dash = LABEL_DASH.exec(s);
    if (dash && (dash[1]!.match(/[A-Z]/g) ?? []).length >= 2) found.push("\"LABEL — fragment\"");
    if (NUMBERED.test(s)) numbered.push(t);
    if (!found.length) continue;
    push(t, "chrome_string",
      `reads "${s.slice(0, 40)}${s.length > 40 ? "…" : ""}": ${found.join(", ")} — template chrome that appears whatever the subject. Write it as content.`);
  }
  if (numbered.length >= 2) {
    push(null, "chrome_string",
      `${numbered.length} texts are numbered 01, 02, … (${numbered.slice(0, 3).map((t) => `"${t.node.name}"`).join(", ")}) — right for real steps ` +
        "in order, a template habit on anything else.");
  }
}

/** A hairline rule: a line, or a box no taller than dividerMax that is far wider than tall. */
function isRule(l: Layer): boolean {
  if (l.node.type === "LINE") return l.box.width >= l.box.height;
  return ["RECTANGLE", "VECTOR", "FRAME"].includes(l.node.type) && (l.filled || l.stroked) && !(childrenOf(l.node) ?? []).length
    && l.box.height <= TELLS.dividerMax && l.box.width >= 4 * Math.max(1, l.box.height);
}

/** divider_everywhere (C4): a rule under nearly every heading — separation by habit. */
function dividers(ix: Index, push: Push): void {
  const headings = headingsOf(ix);
  if (headings.length < 2) return;
  const ruled = headings.filter((h) => {
    const next = nextOf(ix, h);
    return next !== null && isRule(next);
  });
  if (ruled.length / headings.length < TELLS.dividerShare) return;
  push(null, "divider_everywhere",
    `${ruled.length} of ${headings.length} headings have a hairline rule right after them — separation by habit. Separate with space, ` +
      "colour or a change of layout; keep a rule where it divides something.");
}
