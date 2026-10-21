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
//
// The second half (role quality plan W2, 2026-10-20) measures what the product
// redesign showed and the eye had judged: sameness (skeleton_repeat,
// flat_rhythm, boxiness, centred_stage), the dashboard kit (icon_tile,
// kpi_tile, greeting_title, accent_share), second-order defaults (hue_pair,
// reflex_display_face), and the design skill's cluster table, computed
// (cluster_1 … cluster_6). Their thresholds are our own uncalibrated
// decisions too; where a number came from the design skills research
// record, the comment says so.

import { childrenOf } from "./board-read.js";
import { type Census, type Finding, type Index, type Layer, type Rect, type Rgb, hex, intersect, overlapX, overlapY, r1, right, bottom } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Faces a tool or framework sets when nobody chooses one. A decision, to calibrate [C-248]. */
export const DEFAULT_FACES: ReadonlySet<string> = new Set(
  ["Inter", "Roboto", "Arial", "Helvetica", "Helvetica Neue", "SF Pro", "SF Pro Display", "SF Pro Text", "Segoe UI", "Open Sans", "system-ui"]
    .map((f) => f.toLowerCase()),
);

/**
 * Display faces generated work reaches for by reflex: a dated list, as of
 * 2026-10-20, from the design skills research record
 * (docs/superpowers/plans/2026-10-20-design-skills-research.md, "a dated list
 * of second-order defaults"). A list like this goes stale as it is published
 * — today's distinctive face is tomorrow's default — so it carries its date
 * and is revised, not trusted. Lower case; an entry also matches the family's
 * cuts ("cormorant" matches Cormorant Garamond, "dm serif" DM Serif Display).
 * Inter is here as a display face only: as the whole page's face it is
 * DEFAULT_FACES' default_typeface. Uncalibrated [C-248].
 */
export const REFLEX_DISPLAY_FACES: readonly string[] = [
  "fraunces", "playfair display", "cormorant", "lora", "crimson", "newsreader", "syne", "space grotesk", "space mono",
  "ibm plex sans", "ibm plex serif", "ibm plex mono", "dm sans", "dm serif", "outfit", "plus jakarta sans", "instrument sans", "inter",
];

/** Whether a family is on the reflex list, or one of its cuts. */
export function reflexFace(family: string): boolean {
  const f = family.trim().toLowerCase();
  return REFLEX_DISPLAY_FACES.some((r) => f === r || f.startsWith(`${r} `));
}

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

  // The kinds below were added on 2026-10-20 (role quality plan W2). Every
  // number is our own uncalibrated decision [C-248], set from the product
  // screens and the fixtures; calibration moves them.

  /** A saturated colour: HSL saturation at least this, lightness inside this band (not near black or white). */
  saturation: 0.45,
  satLightMin: 0.2,
  satLightMax: 0.85,
  /** icon_tile: a tile is a filled square or circle of tileMin–tileMax px, sides within tileSquare of each other, holding a smaller icon. */
  tileMin: 16,
  tileMax: 64,
  tileSquare: 0.2,
  /** icon_tile: more than this share of three or more sibling cards start with one. */
  tileShare: 0.5,
  /** kpi_tile: a figure at least this × the body size; its label at most the figure ÷ this. */
  kpiStep: 1.5,
  /** kpi_tile and cluster 6: a sparkline is a path at least this many times wider than tall (and 40 px wide), or this many bars of one width on one baseline. */
  sparkAspect: 2.5,
  sparkBars: 4,
  /** accent_share: the most-used saturated colour on this many layers, this share of them on chrome or decoration. */
  accentMin: 4,
  accentChrome: 0.6,
  /** accent_share and cluster 6: a bar is at least this share of the root's height (a sidebar, at most sideWidth of its width) or width (a top bar, at most topHeight of its height). */
  barSpan: 0.8,
  sideWidth: 0.3,
  topHeight: 0.15,
  /** flat_rhythm: this many auto-layout containers with a gap; gaps this ratio apart are two levels; fewer levels than rhythmLevels is flat. */
  rhythmMin: 4,
  rhythmStep: 1.25,
  rhythmLevels: 3,
  /** flat_rhythm: the space between sections wants this × the largest gap inside them. */
  sectionStep: 1.5,
  /** boxiness: more than this share of the text's characters inside boxes (card-sized, filled or stroked, below the root, not a full-width band); or boxes this deep. */
  boxShare: 0.6,
  boxDepth: 3,
  /** centred_stage: an app screen is a desktop frame this wide or wider at this height ÷ width, or a phone frame in this width band at this height ÷ width. */
  desktopWidth: 960,
  desktopRatio: [0.45, 0.85],
  phoneWidth: [320, 480],
  phoneRatio: [1.6, 2.4],
  /** centred_stage: a region is at least this share of the screen; a stage is centred within stageTol of the region's size, at most stageShare of its area and stageWidth of its width. */
  regionShare: 0.4,
  stageTol: 0.05,
  stageShare: 0.25,
  stageWidth: 0.6,
  /** skeleton_repeat: this many views or sections on one structure; a section spans sectionSpan of the root's width and is sectionHeight px tall; a structure has skeletonParts parts, read skeletonDepth levels down. */
  skeletonRun: 3,
  sectionSpan: 0.6,
  sectionHeight: 160,
  skeletonParts: 4,
  skeletonDepth: 3,
  /**
   * hue_pair: the two most-used saturated colours (each on hueUses layers or
   * more) are hueNear° of hue apart or less, but more than hueSame° (closer
   * is one colour's ramp), and within hueLight of lightness. "About 20°"
   * comes from the design skills research record (2026-10-20), not a
   * registered claim: our decision until calibrated.
   */
  hueUses: 2,
  hueNear: 20,
  hueSame: 6,
  hueLight: 0.2,
  /** cluster_1 … cluster_6: report a look matched on this many of its features. */
  clusterMin: 2,
  /**
   * Clusters 1 and 2: the cluster table's own "about" numbers (the design
   * skill's tells section), read as bands. Cluster 1: a ground lighter than
   * warmLight, of a hue in warmHue, tinted at least warmSat; a clay accent of
   * a hue in clayHue at a lightness in clayLight, saturated at least claySat.
   * Cluster 2: a ground darker than darkLight; an accent of an acid green
   * (acidHue) or a vermilion to red-orange (vermilionHue, wrapping past 0°).
   */
  warmLight: 0.9,
  warmHue: [20, 60],
  warmSat: 0.1,
  clayHue: [10, 30],
  clayLight: [0.3, 0.7],
  claySat: 0.35,
  darkLight: 0.1,
  acidHue: [65, 110],
  vermilionHue: [350, 30],
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
  const eyebrowCount = eyebrows(ix, push);
  reading(ix, push);
  cardTrios(c, ix, push);
  nestedCards(c, push);
  const oneRadius = radii(c, push);
  const shadow = shadows(c, push);
  washes(c, ix, push);
  glows(c, ix, push);
  emoji(ix, push);
  chrome(ix, push);
  dividers(ix, push);
  // Sameness and structure.
  skeletonRepeat(c, ix, push);
  flatRhythm(c, ix, push);
  boxiness(c, ix, push);
  centredStage(c, ix, push);
  // The dashboard kit.
  const colours = saturatedUses(c);
  const tiles = iconTiles(c, ix, push);
  const stats = kpiTiles(c, ix, push);
  const greeting = greetingTitle(ix, push);
  const accent = accentShare(c, ix, colours, push);
  // Second-order defaults.
  huePair(colours, push);
  reflexDisplayFace(ix, push);
  // The looks of the design skill's cluster table, from the facts above.
  clusters(c, ix, { eyebrows: eyebrowCount, oneRadius, shadow, tiles, stats, greeting, accent }, colours, push);
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

/** eyebrow_everywhere (T4): a small tracked caps label over most headings. Returns how many headings have one (cluster 5). */
function eyebrows(ix: Index, push: Push): number {
  const headings = new Set(headingsOf(ix));
  if (!headings.size) return 0;
  let count = 0;
  for (const t of ix.texts) {
    const f = t.text!;
    if (!f.caps || f.tracking < TELLS.eyebrowTracking || f.lines !== 1 || f.chars.trim().length > TELLS.eyebrowChars || !/[A-Za-z]/.test(f.chars)) continue;
    const next = nextOf(ix, t, 0);
    const heading = next ? firstText(ix, next) : null;
    if (heading && headings.has(heading) && heading.text!.size >= TELLS.eyebrowStep * f.size) count++;
  }
  if (!count || count / headings.size < TELLS.eyebrowShare) return count;
  push(null, "eyebrow_everywhere",
    `${count} of ${plural(headings.size, "heading")} ${count === 1 ? "has" : "have"} a small tracked all-caps label right above — template chrome that appears whatever ` +
      "the content. Keep a label only where it says what the heading does not.");
  return count;
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

/** one_radius, nested_radius (S3): one kit radius everywhere; an inner corner as round as its outer one. Returns the one radius when one_radius fired (cluster 4). */
function radii(c: Census, push: Push): string | null {
  const painted = (c.root ? [c.root, ...c.layers] : c.layers)
    .filter((l) => RADIUS_TYPES.has(l.node.type) && !l.inInstance && (l.filled || l.stroked))
    .map((l) => ({ l, r: radius(l.a) }))
    .filter((x) => x.r.value > 0);
  const byNode = new Map(painted.map((x) => [x.l.node, x]));
  // A pill is a shape of its own, not a radius setting.
  const rounded = painted.filter((x) => x.l !== c.root && x.r.value < Math.min(x.l.box.width, x.l.box.height) / 2 - 0.5);
  const keys = new Set(rounded.map((x) => x.r.key));
  const one = rounded.length >= TELLS.oneRadius && keys.size === 1 ? [...keys][0]! : null;
  if (one !== null) {
    push(null, "one_radius",
      `${rounded.length} containers all have radius ${one} — a kit setting, not a system. Set radius by role and size, or go sharp if the direction says so.`);
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
  return one;
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

/**
 * same_shadow (S4): one soft shadow under nearly every filled container — elevation as decoration.
 * Returns the shadow when it fired, and whether it is cluster 4's soft grey one (a grey or black at a quarter opacity or less).
 */
function shadows(c: Census, push: Push): { key: string; softGrey: boolean } | null {
  const filled = c.layers.filter((l) => FILL_TYPES.has(l.node.type) && l.filled && !l.inInstance);
  const counts = new Map<string, number>();
  const firstOf = new Map<string, Layer>();
  for (const l of filled) {
    const k = shadowKey(l.a);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!firstOf.has(k)) firstOf.set(k, l);
  }
  const [key, n] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  if (n < TELLS.shadowMin || n / filled.length < TELLS.shadowShare) return null;
  push(null, "same_shadow",
    `${n} of ${filled.length} filled containers carry the same drop shadow (${key}) — elevation as decoration. Lift only what sits above something, in few levels.`);
  const s = visible(firstOf.get(key)!.a.effects).find((e) => e.type === "DROP_SHADOW");
  const color = s?.color as (Rgb & { a?: number }) | undefined;
  const alpha = typeof color?.a === "number" ? color.a : 1;
  return { key, softGrey: !!color && hsl(color).s < 0.15 && hsl(color).l < 0.35 && alpha <= 0.25 };
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
/** A clock time leading a text (07:20, 07:20:15, 06h45, 07 am, 9 p.m.): a timetable, not numbering. "01.01" stays numbering. */
const CLOCK = /^\d{1,2}(?::\d{2}(?::\d{2})?\b|h\d{2}\b|\s?[ap]\.?m\.?(?![a-z]))/i;

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
    if (NUMBERED.test(s) && !CLOCK.test(s)) numbered.push(t);
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

// ── the second half: sameness, the dashboard kit, second-order defaults ─────

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

/** A saturated colour: a hue that reads as a colour, not a grey, a black or a white. */
function saturated(c: Rgb): boolean {
  const x = hsl(c);
  return x.s >= TELLS.saturation && x.l >= TELLS.satLightMin && x.l <= TELLS.satLightMax;
}

/** Degrees between two hues, the short way round the wheel. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Whether a hue lies in a band of the wheel; a band may wrap past 0° ([350, 30]). */
function inHue(h: number, band: readonly [number, number]): boolean {
  return band[0] <= band[1] ? h >= band[0] && h <= band[1] : h >= band[0] || h <= band[1];
}

/** The solid colours a layer paints: its top fill (a text's ink) and its top stroke, from 10 % opacity. */
function paintsOf(l: Layer): Rgb[] {
  const out: Rgb[] = [];
  if (l.solid && l.solid.opacity >= 0.1) out.push(l.solid.color);
  const weight = l.a.strokeWeight;
  if (l.stroked && l.strokeSolid && l.strokeSolid.opacity >= 0.1 && (typeof weight !== "number" || weight > 0)) out.push(l.strokeSolid.color);
  return out;
}

type Uses = Array<{ color: Rgb; key: string; layers: Layer[] }>;

/** Saturated colours by the layers that paint them, most used first; a ground (half the root or more) is not a use. */
function saturatedUses(c: Census): Uses {
  const whole = c.root ? area(c.root.box) : 0;
  const by = new Map<string, Uses[number]>();
  for (const l of c.layers) {
    if (whole && area(l.box) >= 0.5 * whole) continue;
    for (const p of paintsOf(l)) {
      if (!saturated(p)) continue;
      const key = hex(p);
      const u = by.get(key) ?? { color: p, key, layers: [] };
      by.set(key, u);
      if (u.layers[u.layers.length - 1] !== l) u.layers.push(l);
    }
  }
  return [...by.values()].sort((x, y) => y.layers.length - x.layers.length);
}

/** Whether words (a text that is not only emoji) sit at or under `l`. */
function holdsWords(ix: Index, l: Layer, depth = 4): boolean {
  if (l.text) return l.text.chars.trim() !== "" && !emojiOnly(l.text.chars);
  return depth > 0 && ix.kids(l.node).some((k) => holdsWords(ix, k, depth - 1));
}

/** Texts with something in them at or under `l`, three levels down. */
function textsUnder(ix: Index, l: Layer, depth = 3): Layer[] {
  if (l.text) return l.text.chars.trim() ? [l] : [];
  return depth > 0 ? ix.kids(l.node).flatMap((k) => textsUnder(ix, k, depth - 1)) : [];
}

/** Whether a layer under `l`, three levels down, passes `test`. */
function anyUnder(ix: Index, l: Layer, test: (x: Layer) => boolean, depth = 3): boolean {
  return ix.kids(l.node).some((k) => test(k) || (depth > 1 && !k.text && anyUnder(ix, k, test, depth - 1)));
}

/** A text's characters per line, from its line count: the last line is short, half of it is a fair guess. */
const perLine = (t: Layer) => [...t.text!.chars].filter((ch) => !BREAKS.has(ch.codePointAt(0)!)).length / Math.max(0.5, t.text!.lines - 0.5);

/** The largest run of type: the display. */
function displayRun(ix: Index): { t: Layer; family: string; size: number } | null {
  let best: { t: Layer; family: string; size: number } | null = null;
  for (const t of ix.texts) for (const r of t.text!.runs) if (r.family && (!best || r.size > best.size)) best = { t, family: r.family, size: r.size };
  return best;
}

// ── sameness and structure ──────────────────────────────────────────────────

/** One letter per node type in a structure; anything else is X. */
const SHAPE_LETTER: Record<string, string> = {
  FRAME: "F", COMPONENT: "C", INSTANCE: "I", GROUP: "G", SECTION: "S", RECTANGLE: "R", ELLIPSE: "E", LINE: "L",
  VECTOR: "V", BOOLEAN_OPERATION: "V", STAR: "V", POLYGON: "V",
};
/** Types a structure looks into. */
const NESTS = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP", "SECTION"]);

/**
 * A node's structure, TELLS.skeletonDepth levels down from its children: each
 * child in order, as its type, its auto-layout direction, whether it is boxed
 * (filled or stroked) and its width in twelfths of its parent's — a leaf adds
 * its height to the nearest power of two, a text is its size, a container
 * adds its own children's structure in brackets. A run of identical children
 * is one part marked "+", so a grid of four cards reads as one of six; a
 * container's height follows its content, so it is left out on purpose.
 */
function structure(ix: Index, n: NodeLike, width: number, depth = 1): string {
  const parts: string[] = [];
  for (const k of ix.kids(n)) {
    let part: string;
    if (k.text) part = `T${Math.round(k.text.size)}`;
    else {
      const letter = SHAPE_LETTER[k.node.type] ?? "X";
      const boxed = k.filled || k.stroked ? "b" : "";
      const w = width > 0 ? Math.round((12 * k.box.width) / width) : 0;
      part = NESTS.has(k.node.type) && depth < TELLS.skeletonDepth && ix.kids(k.node).length
        ? `${letter}${String(k.a.layoutMode ?? "NONE").charAt(0)}${boxed}${w}[${structure(ix, k.node, k.box.width, depth + 1)}]`
        : `${letter}${boxed}${w}.${Math.round(Math.log2(Math.max(1, k.box.height)))}`;
    }
    const last = parts[parts.length - 1];
    if (last === part || last === `${part}+`) parts[parts.length - 1] = `${part}+`;
    else parts.push(part);
  }
  return parts.join(" ");
}

/** The parts of a structure, nested ones included. */
const partsOf = (s: string) => s.split(/[\s[\]]+/).filter(Boolean).length;

/** The parts of a structure at its top level. */
function topParts(s: string): number {
  let depth = 0;
  let n = s ? 1 : 0;
  for (const ch of s) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === " " && depth === 0) n++;
  }
  return n;
}

function repeatDetail(nodes: readonly NodeLike[], what: string, sig: string): string {
  const names = nodes.slice(0, 3).map((n) => `"${n.name}"`).join(", ");
  return `${names}${nodes.length > 3 ? ` and ${nodes.length - 3} more` : ""} — ${nodes.length} ${what} — share one structure: the same ` +
    `${plural(topParts(sig), "block")} in the same order, of the same kinds and widths, ${TELLS.skeletonDepth} levels down. One template ` +
    `filled in ${nodes.length} times; keep the tokens and compose each for its own content.`;
}

/** skeleton_repeat inside one root: three or more of its sections (on a page, its frames) built on one structure. */
function skeletonRepeat(c: Census, ix: Index, push: Push): void {
  const R = c.root?.box;
  const groups = new Map<string, Layer[]>();
  for (const s of ix.kids(c.rootNode)) {
    if (s.text || !NESTS.has(s.node.type) || ix.kids(s.node).length < 2) continue;
    // A section is a band across the frame; a row of cards or a list item is not.
    if (R && (s.box.width < TELLS.sectionSpan * R.width || s.box.height < TELLS.sectionHeight)) continue;
    const sig = structure(ix, s.node, s.box.width);
    if (partsOf(sig) < TELLS.skeletonParts) continue;
    groups.set(sig, [...(groups.get(sig) ?? []), s]);
  }
  for (const [sig, list] of groups) {
    if (list.length < TELLS.skeletonRun) continue;
    push(list[0]!, "skeleton_repeat", repeatDetail(list.map((l) => l.node), R ? "sections of this frame" : "frames on this page", sig));
  }
}

/** A root's structure, for skeleton_repeat across the roots of one figma_check_layout call; null when it has too few parts to compare. */
export function structureOf(c: Census, ix: Index): string | null {
  if (!c.root) return null;
  const sig = structure(ix, c.rootNode, c.root.box.width);
  return partsOf(sig) >= TELLS.skeletonParts ? sig : null;
}

/** skeleton_repeat across roots: three or more roots of one check built on one structure — views filled into one template. Info, as every tell [C-248]. */
export function skeletonAcross(roots: ReadonlyArray<{ node: NodeLike; structure: string }>): Finding[] {
  const groups = new Map<string, NodeLike[]>();
  for (const r of roots) groups.set(r.structure, [...(groups.get(r.structure) ?? []), r.node]);
  const out: Finding[] = [];
  for (const [sig, nodes] of groups) {
    if (nodes.length < TELLS.skeletonRun) continue;
    out.push({ kind: "skeleton_repeat", severity: "info", nodeId: nodes[0]!.id, name: nodes[0]!.name, detail: repeatDetail(nodes, "views in this check", sig) });
  }
  return out;
}

const AXES = new Set(["HORIZONTAL", "VERTICAL"]);

/** The gaps an auto-layout sets between its children, over 0 px: its item spacing (unless space-between), a wrap's cross gap, a grid's row and column gaps. */
function gapsOf(ix: Index, l: Layer): number[] {
  const a = l.a;
  const mode = String(a.layoutMode ?? "NONE");
  if (!AXES.has(mode) && mode !== "GRID") return [];
  if (ix.kids(l.node).filter((k) => k.flow).length < 2) return [];
  const raw: unknown[] = mode === "GRID"
    ? [a.gridRowGap, a.gridColumnGap]
    : [a.primaryAxisAlignItems === "SPACE_BETWEEN" ? undefined : a.itemSpacing, a.layoutWrap === "WRAP" ? a.counterAxisSpacing : undefined];
  return raw.filter((v): v is number => typeof v === "number" && v > 0);
}

/** How many levels below the root a node sits; the root is -1. */
function depthOf(c: Census, n: NodeLike): number {
  if (n === c.rootNode) return -1;
  let d = 0;
  for (let p = n.parent; p && p !== c.rootNode; p = p.parent) d++;
  return d;
}

const pad = (l: Layer, side: string) => (typeof l.a[side] === "number" ? (l.a[side] as number) : 0);

/**
 * flat_rhythm: the view's spacing forms fewer than three levels — its
 * auto-layout gaps, and the space between its sections — or that space
 * between sections is not clearly wider than the largest gap inside them.
 * The sections are the children of its shallowest auto-layout of
 * containers; the space between two counts their padding, so bands spaced
 * by padding at gap 0 are measured too. Built by hand, nothing is measured.
 */
function flatRhythm(c: Census, ix: Index, push: Push): void {
  const own = (c.root ? [c.root, ...c.layers] : c.layers).filter((l) => !l.text && !l.inInstance && l.node.type !== "INSTANCE");
  const spaced = own.map((l) => ({ l, gaps: gapsOf(ix, l) })).filter((x) => x.gaps.length);
  if (spaced.length < TELLS.rhythmMin) return;
  // The space between sections, as their median.
  let between: { space: number; first: Layer; inner: number } | null = null;
  const outer = own
    .filter((l) => AXES.has(String(l.a.layoutMode)) && ix.kids(l.node).filter((k) => k.flow && !k.text).length >= 2)
    .sort((x, y) => depthOf(c, x.node) - depthOf(c, y.node))[0];
  if (outer) {
    const vertical = outer.a.layoutMode === "VERTICAL";
    const flow = ix.kids(outer.node).filter((k) => k.flow);
    const spaces: number[] = [];
    for (let i = 1; i < flow.length; i++) {
      const [p, n] = [flow[i - 1]!, flow[i]!];
      if (p.text || n.text) continue;
      spaces.push(vertical
        ? n.box.y - bottom(p.box) + pad(p, "paddingBottom") + pad(n, "paddingTop")
        : n.box.x - right(p.box) + pad(p, "paddingRight") + pad(n, "paddingLeft"));
    }
    const sections = flow.filter((k) => !k.text);
    const inner = Math.max(0, ...spaced.filter((x) => sections.some((s) => s.node === x.l.node || ix.isAncestor(s.node, x.l.node))).flatMap((x) => x.gaps));
    const mid = [...spaces].sort((x, y) => x - y)[Math.floor((spaces.length - 1) / 2)];
    if (mid !== undefined) between = { space: mid, first: sections[0]!, inner };
  }
  const all = spaced.flatMap((x) => x.gaps).concat(between && between.space > 0 ? [between.space] : []);
  const values = [...new Set(all.map(r1))].sort((x, y) => x - y);
  const levels: number[] = []; // each level's smallest gap
  for (const v of values) if (!levels.length || v >= TELLS.rhythmStep * levels[levels.length - 1]!) levels.push(v);
  const reasons: string[] = [];
  if (levels.length < TELLS.rhythmLevels) {
    reasons.push(`its spacing has ${levels.length === 1 ? "one level" : `${levels.length} levels`} (${values.join(", ")} px) across ${spaced.length} auto-layouts`);
  }
  if (between && between.inner > 0 && between.space < TELLS.sectionStep * between.inner - 0.5) {
    reasons.push(`its sections ("${between.first.node.name}", …) sit ${r1(between.space)} px apart, under ${TELLS.sectionStep}× the ${r1(between.inner)} px gap inside them`);
  }
  if (!reasons.length) return;
  push(null, "flat_rhythm",
    `${reasons.join("; and ")} — the spacing forms no groups. Space tight inside a group, wider between groups and widest between sections: three levels or more.`);
}

/** boxiness: most of the text inside boxes below the root, or boxes three deep — containers doing the grouping that space and type should do. */
function boxiness(c: Census, ix: Index, push: Push): void {
  if (ix.texts.length < TELLS.minTexts) return;
  const R = c.root?.box;
  // A box: card-sized, filled or stroked, below the root; a band across the whole frame, or a frame on the page, is the ground, not a box.
  const isBox = (l: Layer | undefined): l is Layer => !!l && l !== c.root && !l.text && CARD_TYPES.has(l.node.type) && (l.filled || l.stroked)
    && l.box.width >= TELLS.cardWidth && l.box.height >= TELLS.cardHeight
    && l.node.parent?.type !== "PAGE" && !(R && l.box.width >= 0.9 * R.width);
  let chars = 0;
  let boxed = 0;
  let deepest: string[] = [];
  for (const t of ix.texts) {
    const n = t.text!.chars.trim().length;
    chars += n;
    const chain: string[] = [];
    for (let p = t.node.parent; p && p !== c.rootNode; p = p.parent) if (isBox(ix.byNode.get(p))) chain.unshift(p.name);
    if (chain.length) boxed += n;
    if (chain.length > deepest.length) deepest = chain;
  }
  const reasons: string[] = [];
  if (chars && boxed / chars > TELLS.boxShare) reasons.push(`${Math.round((100 * boxed) / chars)}% of the text (by characters) sits inside filled or stroked boxes below the frame`);
  if (deepest.length >= TELLS.boxDepth) reasons.push(`boxes nest ${deepest.length} deep (${deepest.map((n) => `"${n}"`).join(" > ")})`);
  if (!reasons.length) return;
  push(null, "boxiness",
    `${reasons.join(", and ")} — containers doing the grouping that space and type should do. Remove the boxes that group nothing; ` +
      "keep one where a group is acted on as one.");
}

/** Whether a frame has an app screen's proportions: a desktop or a phone, not a poster, a banner or a long page. */
function appScreen(b: Rect): boolean {
  const ratio = b.height / Math.max(1, b.width);
  const [dLo, dHi] = TELLS.desktopRatio;
  const [wLo, wHi] = TELLS.phoneWidth;
  const [pLo, pHi] = TELLS.phoneRatio;
  return (b.width >= TELLS.desktopWidth && ratio >= dLo && ratio <= dHi) || (b.width >= wLo && b.width <= wHi && ratio >= pLo && ratio <= pHi);
}

/** Layers named for something that floats over the screen by design. */
const OVERLAY = /\b(dialog|modal|popover|sheet|toast|menu|overlay|scrim|tooltip|lightbox)\b/i;

/** centred_stage: on an app screen, the main block centred both ways in its region and much smaller than it — a small island in an empty field. */
function centredStage(c: Census, ix: Index, push: Push): void {
  const root = c.root;
  if (!root || !appScreen(root.box)) return;
  const screen = area(root.box);
  const regions = [root, ...c.layers.filter((l) => !l.text && !l.inInstance && NESTS.has(l.node.type) && area(l.box) >= TELLS.regionShare * screen)];
  for (const R of regions) {
    const B = R.box;
    const kids = ix.kids(R.node);
    for (const k of kids) {
      const b = k.box;
      if (!holdsWords(ix, k) || OVERLAY.test(k.node.name)) continue;
      if (area(b) > TELLS.stageShare * area(B) || b.width > TELLS.stageWidth * B.width) continue;
      if (Math.abs(b.x + b.width / 2 - (B.x + B.width / 2)) > TELLS.stageTol * B.width) continue;
      if (Math.abs(b.y + b.height / 2 - (B.y + B.height / 2)) > TELLS.stageTol * B.height) continue;
      // A dialog over a scrim centres by design: a translucent layer under it covers the region.
      const scrim = kids.some((o) => o !== k && o.order < k.order && !o.text && o.filled && area(o.box) >= 0.9 * area(B)
        && (o.solid?.opacity ?? 1) * (typeof o.a.opacity === "number" ? o.a.opacity : 1) < 0.95);
      // Words above it in its column: one block of a stack, not a stage.
      const above = kids.some((o) => o !== k && bottom(o.box) <= b.y + 0.5 && overlapX(o.box, b) > 0 && holdsWords(ix, o));
      if (scrim || above) continue;
      push(k, "centred_stage",
        `sits centred on both axes in "${R.node.name}" (${Math.round(B.width)}×${Math.round(B.height)}), at ${Math.round((100 * area(b)) / area(B))}% of its area — ` +
          "the centred stage: a small island in an empty field. Start the content where reading starts in the region and give the region to what the " +
          "user came to do; fine for a sign-in or an empty state.");
      return;
    }
  }
}

// ── the dashboard kit ───────────────────────────────────────────────────────

const squareish = (b: Rect) => Math.abs(b.width - b.height) <= TELLS.tileSquare * Math.max(b.width, b.height);

/**
 * An icon tile: a small filled square or circle with a smaller icon in it — a
 * filled frame holding the icon, or a group whose first layer is a filled
 * shape the size of the group with the icon over it. Words make it an avatar
 * or a badge, not a tile.
 */
function iconTile(ix: Index, l: Layer): boolean {
  if (l.text || !CARD_HOLDERS.has(l.node.type)) return false;
  const b = l.box;
  if (b.width < TELLS.tileMin || b.height < TELLS.tileMin || b.width > TELLS.tileMax || b.height > TELLS.tileMax || !squareish(b)) return false;
  if (holdsWords(ix, l)) return false;
  const kids = ix.kids(l.node);
  const icon = (k: Layer) => area(k.box) > 0 && k.box.width <= 0.85 * b.width && k.box.height <= 0.85 * b.height;
  if (l.filled) return kids.some(icon);
  const back = kids[0];
  return !!back && !back.text && back.filled && area(back.box) >= 0.9 * area(b) && kids.slice(1).some(icon);
}

function tileShape(ix: Index, l: Layer): string {
  const back = ix.kids(l.node)[0];
  const round = radius(l.a).value >= Math.min(l.box.width, l.box.height) / 2 - 0.5 || (!l.filled && back?.node.type === "ELLIPSE");
  return round ? "circle" : "square";
}

/**
 * The icon tile a card starts with, or null: its first child in an
 * auto-layout, else the one nearest its top-left corner. A background that
 * fills the card is skipped, and a header row is looked into, two levels at most.
 */
function leadTile(ix: Index, card: Layer, depth = 0): Layer | null {
  const B = card.box;
  const kids = ix.kids(card.node).filter((k) => k.text || area(k.box) < 0.9 * area(B));
  if (!kids.length) return null;
  const auto = AXES.has(String(card.a.layoutMode));
  const corner = (k: Layer) => k.box.x - B.x + (k.box.y - B.y);
  const first = auto ? (kids.find((k) => k.flow) ?? kids[0]!) : kids.reduce((m, k) => (corner(k) < corner(m) ? k : m));
  if (iconTile(ix, first)) return first;
  return depth < 2 && !first.text && CARD_HOLDERS.has(first.node.type) && holdsWords(ix, first) ? leadTile(ix, first, depth + 1) : null;
}

/** A card for icon_tile: a container of card size, from this view (not inside an instance), that holds words. */
const cardLike = (ix: Index, l: Layer) => !l.text && !l.inInstance && CARD_HOLDERS.has(l.node.type)
  && l.box.width >= TELLS.cardWidth && l.box.height >= TELLS.cardHeight && holdsWords(ix, l);

/** icon_tile: most of three or more sibling cards open with an icon in a small filled square or circle. Returns whether it fired (cluster 6). */
function iconTiles(c: Census, ix: Index, push: Push): boolean {
  let fired = false;
  for (const p of c.root ? [c.root, ...c.layers] : c.layers) {
    if (p.text) continue;
    const cards = ix.kids(p.node).filter((k) => cardLike(ix, k));
    if (cards.length < TELLS.trio) continue;
    const tiled = cards.map((k) => ({ k, t: leadTile(ix, k) })).filter((x): x is { k: Layer; t: Layer } => x.t !== null);
    if (tiled.length / cards.length <= TELLS.tileShare) continue;
    const { k, t } = tiled[0]!;
    const names = tiled.slice(0, 3).map((x) => `"${x.k.node.name}"`).join(", ");
    push(k, "icon_tile",
      `${tiled.length} of ${cards.length} sibling cards (${names}${tiled.length > 3 ? ", …" : ""}) start with an icon in a ` +
        `${Math.round(Math.max(t.box.width, t.box.height))} px filled ${tileShape(ix, t)} — the icon tile, added whatever each card says. Keep an icon ` +
        "only where it speeds recognition, at text size without the chip, or drop it.");
    fired = true;
  }
  return fired;
}

/** A figure as a dashboard shows it: "1,284", "$12.4k", "98%", "+3.1", "142 ms". */
const FIGURE = /^[+\-−±↑↓▲▼]?\s?[$€£¥]?\s?\d[\d.,:\s]*\s?(%|[A-Za-z×]{1,3})?$/;
/** A change set as a signed percentage: "+12%", "−3.4 %", "↑ 8%". */
const DELTA = /^[+\-−↑↓▲▼]\s?\d[\d.,]*\s?%$/;

/** A big figure: a short number set at least kpiStep × the body size. */
function bigFigure(ix: Index, t: Layer): boolean {
  const s = t.text!.chars.trim();
  return ix.body > 0 && s.length <= 14 && FIGURE.test(s) && t.text!.size >= TELLS.kpiStep * ix.body;
}

/** A sparkline: a path far wider than tall, or a row of bars of one width on one baseline at different heights. */
function sparkline(ix: Index, l: Layer): boolean {
  const b = l.box;
  if ((l.node.type === "VECTOR" || l.node.type === "BOOLEAN_OPERATION") && (l.stroked || l.filled)
    && b.width >= 40 && b.height >= 8 && b.width >= TELLS.sparkAspect * b.height) return true;
  if (l.text || !CARD_HOLDERS.has(l.node.type)) return false;
  const bars = ix.kids(l.node).filter((k) => k.filled && (k.node.type === "RECTANGLE" || (k.node.type === "FRAME" && !ix.kids(k.node).length)));
  if (bars.length < TELLS.sparkBars) return false;
  const w = bars[0]!.box.width;
  const base = bottom(bars[0]!.box);
  const row = bars.filter((k) => Math.abs(k.box.width - w) <= 1 && Math.abs(bottom(k.box) - base) <= 1);
  return row.length >= TELLS.sparkBars && new Set(row.map((k) => Math.round(k.box.height))).size >= 2;
}

interface Stat { l: Layer; figure: Layer; label: Layer; tile: boolean; spark: boolean; delta: boolean }

/** A stat tile: a container holding one big figure and a small label, with what decorates it. */
function statOf(ix: Index, l: Layer): Stat | null {
  if (l.text || l.inInstance || !CARD_HOLDERS.has(l.node.type)) return null;
  const texts = textsUnder(ix, l);
  const figures = texts.filter((t) => bigFigure(ix, t));
  if (figures.length !== 1) return null;
  const figure = figures[0]!;
  const label = texts.find((t) => t !== figure && /[A-Za-z]/.test(t.text!.chars) && t.text!.size * TELLS.kpiStep <= figure.text!.size);
  if (!label) return null;
  return {
    l, figure, label,
    tile: anyUnder(ix, l, (x) => iconTile(ix, x)),
    spark: anyUnder(ix, l, (x) => sparkline(ix, x)),
    delta: texts.some((t) => DELTA.test(t.text!.chars.trim())),
  };
}

/** Stat tiles three or more side by side under one parent. */
function statRows(c: Census, ix: Index): Stat[][] {
  const rows: Stat[][] = [];
  for (const p of c.root ? [c.root, ...c.layers] : c.layers) {
    if (p.text) continue;
    const stats = ix.kids(p.node).map((k) => statOf(ix, k)).filter((s): s is Stat => s !== null);
    if (stats.length < TELLS.trio) continue;
    const groups: Stat[][] = [];
    for (const s of stats) {
      const g = groups.find((x) => overlapY(x[0]!.l.box, s.l.box) >= 0.5 * Math.min(x[0]!.l.box.height, s.l.box.height));
      if (g) g.push(s);
      else groups.push([s]);
    }
    rows.push(...groups.filter((g) => g.length >= TELLS.trio));
  }
  return rows;
}

/** kpi_tile: three or more stat tiles in a row, each a big figure and a small label with an icon tile or a sparkline. Returns every stat row (cluster 6). */
function kpiTiles(c: Census, ix: Index, push: Push): Stat[][] {
  const rows = statRows(c, ix);
  for (const row of rows) {
    const kit = row.filter((s) => s.tile || s.spark);
    if (kit.length < TELLS.trio) continue;
    const s = kit[0]!;
    const names = kit.slice(0, 3).map((x) => `"${x.l.node.name}"`).join(", ");
    const what = kit.every((x) => x.tile) ? "an icon tile" : kit.every((x) => x.spark) ? "a sparkline" : "an icon tile or a sparkline";
    push(s.l, "kpi_tile",
      `${names}${kit.length > 3 ? ", …" : ""} are ${kit.length} KPI tiles side by side, each a ${r1(s.figure.text!.size)} px figure over a ` +
        `${r1(s.label.text!.size)} px label with ${what} — the dashboard kit's stat strip. Set the figures as type in one divided row, and give the ` +
        "figure that answers the screen's question the most room.");
  }
  return rows;
}

/** A title that greets: "Welcome back", "Hello", "Hi ", "Good morning", "How can I help" … A list we chose, uncalibrated [C-248]. */
const GREETING = /^\s*(?:welcome|hello|hi|hey|greetings|good (?:morning|afternoon|evening|day)|how (?:can|may) (?:i|we) help|what can i (?:help|do)|nice to see you|good to see you|ready when you are)(?=[\s,!.?…:]|$)/i;

/** greeting_title: the view's top heading greets — the dashboard kit's and the chat start screen's opening line. Returns it (cluster 6). */
function greetingTitle(ix: Index, push: Push): Layer | null {
  if (!ix.texts.length) return null;
  const largest = Math.max(...ix.texts.map((t) => t.text!.size));
  const heads = ix.texts
    .filter((t) => t.text!.size > 0 && (t.text!.size >= largest - 0.01 || (ix.body > 0 && t.text!.size >= TELLS.headingStep * ix.body)))
    .sort((x, y) => y.text!.size - x.text!.size || x.order - y.order);
  const hit = heads.find((t) => t.text!.chars.trim().length <= 80 && GREETING.test(t.text!.chars));
  if (!hit) return null;
  const s = hit.text!.chars.trim();
  push(hit, "greeting_title",
    `reads "${s.slice(0, 40)}${s.length > 40 ? "…" : ""}" — a greeting as the view's title, the opening line of the dashboard kit and the chat start screen. ` +
      "Title the view with what it is, a noun the navigation uses, or lead with the answer to the screen's question.");
  return hit;
}

/** Names that mark navigation or app chrome. */
const CHROME_NAME = /\b(nav|navigation|navbar|sidebar|side ?bar|side ?nav|menu|tabs?|tab ?bar|toolbar|top ?bar|app ?bar|header|footer|breadcrumbs?|rail)\b/i;
/** Names that mark a chart or a table: what it paints is data. */
const DATA_NAME = /\b(chart|graph|plot|sparkline|spark|series|legend|axis|trend|data|table)\b/i;
const BUTTON_NAME = /\b(button|btn|cta)\b/i;

/** A bar of app chrome by its place: a sidebar along a side of the root, or a top bar across its top. */
function chromeBar(c: Census, l: Layer): boolean {
  const R = c.root?.box;
  if (!R || l.text) return false;
  const b = l.box;
  const side = b.height >= TELLS.barSpan * R.height && b.width >= 32 && b.width <= TELLS.sideWidth * R.width
    && (Math.abs(b.x - R.x) <= 2 || Math.abs(right(b) - right(R)) <= 2);
  const top = b.width >= TELLS.barSpan * R.width && b.height <= TELLS.topHeight * R.height && Math.abs(b.y - R.y) <= 2;
  return side || top;
}

/** What a layer painted with the accent serves: data, an action, or chrome and decoration (everything else). */
function accentRole(c: Census, ix: Index, l: Layer): "data" | "action" | "chrome" {
  if (l.text && /\d/.test(l.text.chars)) return "data";
  const up: Layer[] = [];
  for (let n: NodeLike | null | undefined = l.node; n && n !== c.rootNode; n = n.parent) {
    const x = ix.byNode.get(n);
    if (x) up.push(x);
  }
  if (up.some((x) => DATA_NAME.test(x.node.name))) return "data";
  if (up.slice(0, 4).some((x) => BUTTON_NAME.test(x.node.name))) return "action";
  if (up.some((x) => CHROME_NAME.test(x.node.name) || chromeBar(c, x))) return "chrome";
  return up.slice(0, 3).some((x) => buttonish(ix, x)) ? "action" : "chrome";
}

/**
 * accent_share: the saturated accent spent on chrome rather than on data or
 * the one primary action. The proxy: the most-used saturated colour (by the
 * layers painting it, fill or stroke, from 10 % opacity; a ground of half the
 * frame or more is not a use) is the accent. Each layer it paints is data (a
 * text with a digit, or anything under a layer named for a chart or a table),
 * an action (under a layer named button or CTA, or a small rounded container
 * with a label outside the chrome), or chrome: under a layer named for
 * navigation or a bar, in a sidebar or top bar by its place, and every other
 * icon, tile, rule and shape. Uncalibrated [C-248]. Returns whether it fired (cluster 6).
 */
function accentShare(c: Census, ix: Index, colours: Uses, push: Push): boolean {
  const accent = colours[0];
  if (!accent || accent.layers.length < TELLS.accentMin) return false;
  const roles = { data: 0, action: 0, chrome: 0 };
  const chromeLayers: Layer[] = [];
  for (const l of accent.layers) {
    const r = accentRole(c, ix, l);
    roles[r]++;
    if (r === "chrome") chromeLayers.push(l);
  }
  const n = accent.layers.length;
  if (roles.chrome / n < TELLS.accentChrome) return false;
  const distinct = [...new Set(chromeLayers.map((l) => l.node.name))];
  const names = distinct.slice(0, 3).map((name) => `"${name}"`).join(", ");
  push(null, "accent_share",
    `the accent ${accent.key} paints ${n} layers: ${roles.chrome} on chrome or decoration (${names}${distinct.length > 3 ? ", …" : ""}), ${roles.data} on data ` +
      `and ${roles.action} on ${roles.action === 1 ? "an action" : "actions"} — accent spent on furniture, so nothing stands out. Keep it for the data ` +
      "that answers the screen's question and for the one primary action.");
  return true;
}

// ── second-order defaults ───────────────────────────────────────────────────

/** hue_pair: the primary and the accent within about 20° of hue — one hue pretending to be two. */
function huePair(colours: Uses, push: Push): void {
  const used = colours.filter((u) => u.layers.length >= TELLS.hueUses);
  const primary = used[0];
  if (!primary) return;
  const P = hsl(primary.color);
  // The first other colour that is not a step of the primary's own ramp.
  const accent = used.slice(1).find((u) => hueGap(hsl(u.color).h, P.h) > TELLS.hueSame);
  if (!accent) return;
  const A = hsl(accent.color);
  const gap = hueGap(A.h, P.h);
  if (gap > TELLS.hueNear || Math.abs(A.l - P.l) > TELLS.hueLight) return;
  push(null, "hue_pair",
    `its two main colours, ${primary.key} (hue ${Math.round(P.h)}°, on ${plural(primary.layers.length, "layer")}) and ${accent.key} ` +
      `(hue ${Math.round(A.h)}°, on ${plural(accent.layers.length, "layer")}), are ${Math.round(gap)}° of hue apart — one hue pretending to be two. ` +
      "Give the accent a hue of its own, or use one colour and its tints.");
}

/** reflex_display_face: the display set in a face from the dated reflex list (REFLEX_DISPLAY_FACES). */
function reflexDisplayFace(ix: Index, push: Push): void {
  if (ix.texts.length < 2 || ix.body <= 0) return;
  const d = displayRun(ix);
  if (!d || d.size < TELLS.headingStep * ix.body || !reflexFace(d.family)) return;
  push(d.t, "reflex_display_face",
    `sets the display in ${d.family} at ${r1(d.size)} px — a face generated work reaches for by reflex (a dated list of such faces, 2026-10-20). ` +
      "Choose the display face from the subject's world and give its reason in one line; fine when the brand owns it.");
}

// ── the clusters ────────────────────────────────────────────────────────────

/** What the other tells found, for the clusters' features. */
interface Kit {
  eyebrows: number;
  oneRadius: string | null;
  shadow: { key: string; softGrey: boolean } | null;
  tiles: boolean;
  stats: Stat[][];
  greeting: Layer | null;
  accent: boolean;
}

/** The frame's ground: the root's own solid fill, else an opaque solid layer covering it, else what its ancestors paint. */
function groundOf(c: Census): Rgb | null {
  const root = c.root;
  if (!root) return null;
  if (root.filled) return root.solid && root.solid.opacity >= 0.99 ? root.solid.color : null;
  const whole = area(root.box);
  for (const l of c.layers) if (!l.text && l.solid && l.solid.opacity >= 0.99 && area(l.box) >= 0.9 * whole) return l.solid.color;
  return c.backdrop(c.rootNode);
}

/** Serif faces by name: a short list we chose, or "Serif" in the name (not "Sans Serif"). Uncalibrated. */
const SERIF_FACES = [
  "playfair", "cormorant", "fraunces", "dm serif", "bodoni", "bodoni moda", "didot", "libre caslon", "libre baskerville", "baskerville", "garamond",
  "eb garamond", "instrument serif", "gloock", "abril fatface", "prata", "canela", "ogg", "noe display", "editorial new", "gt super", "tiempos",
  "lora", "newsreader", "crimson", "source serif", "noto serif", "georgia", "times", "merriweather", "spectral", "young serif",
];
function serifFace(family: string): boolean {
  const f = family.trim().toLowerCase();
  return (f.includes("serif") && !f.includes("sans")) || SERIF_FACES.some((s) => f === s || f.startsWith(`${s} `));
}
const MONO_FACE = /mono|code|courier|consolas|menlo|monaco|inconsolata/i;

/** The body text's colour: the ink carrying most characters at the body size. */
function bodyInk(ix: Index): Rgb | null {
  if (ix.body <= 0) return null;
  const by = new Map<string, { c: Rgb; n: number }>();
  for (const t of ix.texts) {
    const f = t.text!;
    if (!f.fg || Math.abs(f.size - ix.body) > 0.15 * ix.body) continue;
    const u = by.get(hex(f.fg)) ?? { c: f.fg, n: 0 };
    u.n += f.chars.length;
    by.set(hex(f.fg), u);
  }
  return [...by.values()].sort((x, y) => y.n - x.n)[0]?.c ?? null;
}

/** Cluster 5's ink: a neutral near-black from about #0B0B0B to #151515, or a near-black tinted toward a hue. */
function chromeInk(c: Rgb): boolean {
  const { l } = hsl(c);
  if (l > 0.15) return false;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 3 / 255 || (l >= 0.035 && l <= 0.085);
}

/**
 * cluster_1 … cluster_6: the looks of the design skill's cluster table,
 * counted feature by feature, reported as "matches cluster N on k of m
 * features" from TELLS.clusterMin. The table's own numbers ("about") are the
 * thresholds, as decisions to calibrate [C-248].
 */
function clusters(c: Census, ix: Index, kit: Kit, colours: Uses, push: Push): void {
  const ground = groundOf(c);
  const G = ground ? hsl(ground) : null;
  const all = c.root ? [c.root, ...c.layers] : c.layers;
  const whole = c.root ? area(c.root.box) : 0;
  const display = displayRun(ix);
  const short = ix.texts.map((t) => t.text!.chars.trim());

  // Cluster 1: a clay accent, beside the warm ground and the serif.
  let clay: string | null = null;
  for (const l of c.layers) {
    if (clay || (whole && area(l.box) >= 0.5 * whole)) continue;
    for (const p of paintsOf(l)) {
      const x = hsl(p);
      if (x.s >= TELLS.claySat && inHue(x.h, TELLS.clayHue) && x.l >= TELLS.clayLight[0] && x.l <= TELLS.clayLight[1]) clay = hex(p);
    }
  }
  // Cluster 2: one saturated hue family, acid green or vermilion.
  const accent = colours[0];
  const A = accent ? hsl(accent.color) : null;
  const oneHue = !!A && colours.every((u) => hueGap(hsl(u.color).h, A.h) <= TELLS.hueNear);
  // Cluster 3: hairlines, square corners, narrow columns.
  const lines: number[] = [];
  for (const l of c.layers) {
    if (l.text || l.inInstance) continue;
    const weight = typeof l.a.strokeWeight === "number" ? l.a.strokeWeight : 1;
    if (l.node.type === "LINE") lines.push(weight);
    else if (isRule(l) && l.filled) lines.push(Math.min(l.box.width, l.box.height));
    else if (l.stroked && weight > 0) lines.push(weight);
  }
  const painted = c.layers.filter((l) => RADIUS_TYPES.has(l.node.type) && !l.inInstance && (l.filled || l.stroked) && !isRule(l));
  const narrow = ix.texts.filter((t) => t.text!.lines >= 3 && ix.body > 0 && Math.abs(t.text!.size - ix.body) <= 0.15 * ix.body && perLine(t) < TELLS.measureMin);
  // Cluster 4: three or more cards of one size and radius under one parent.
  let sameCards: { n: number; key: string } | null = null;
  for (const p of all) {
    if (p.text) continue;
    const by = new Map<string, number>();
    for (const k of ix.kids(p.node)) {
      if (k.text || k.inInstance || !RADIUS_TYPES.has(k.node.type) || !(k.filled || k.stroked)) continue;
      const r = radius(k.a);
      if (r.value <= 0 || k.box.width < TELLS.cardWidth || k.box.height < TELLS.cardHeight) continue;
      const key = `${Math.round(k.box.width)}×${Math.round(k.box.height)}, radius ${r.key}`;
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    for (const [key, n] of by) if (n >= TELLS.trio && (!sameCards || n > sameCards.n)) sameCards = { n, key };
  }
  const wash = whole > 0 && all.some((l) => area(l.box) >= TELLS.washShare * whole && visible(l.a.fills).some((p) => String(p.type).startsWith("GRADIENT_")));
  // Cluster 5: template chrome.
  const ink = bodyInk(ix);
  const mono = ix.texts.find((t) => t.text!.lines === 1 && t.text!.chars.trim().length <= 40 && ix.body > 0 && t.text!.size <= ix.body
    && t.text!.runs.some((r) => MONO_FACE.test(r.family)));
  // Cluster 6: the dashboard kit.
  const R = c.root?.box;
  const sidebar = R ? c.layers.find((l) => {
    if (l.text || l.inInstance || !l.solid || l.solid.opacity < 0.9) return false;
    const b = l.box;
    if (b.height < TELLS.barSpan * R.height || b.width < 32 || b.width > TELLS.sideWidth * R.width) return false;
    if (Math.abs(b.x - R.x) > 2 && Math.abs(right(b) - right(R)) > 2) return false;
    const x = hsl(l.solid.color);
    return (x.h >= 200 && x.h <= 250 && x.s >= 0.15 && x.l <= 0.35) || saturated(l.solid.color);
  }) : undefined;
  const figures = ix.texts.filter((t) => bigFigure(ix, t));
  const branded = figures.filter((t) => t.text!.fg && saturated(t.text!.fg));
  const areaChart = c.layers.some((l) => (l.node.type === "VECTOR" || l.node.type === "BOOLEAN_OPERATION") && l.box.width >= 120 && l.box.width >= 1.5 * l.box.height
    && visible(l.a.fills).some((p) => p.type === "GRADIENT_LINEAR"
      && (Array.isArray(p.gradientStops) ? (p.gradientStops as Array<{ color?: { a?: number } }>) : []).some((s) => (s.color?.a ?? 1) <= 0.35)));

  const looks: Array<{ n: number; name: string; features: Array<[boolean, string]> }> = [
    { n: 1, name: "warm off-white with a serif and clay", features: [
      [!!G && G.l > TELLS.warmLight && inHue(G.h, TELLS.warmHue) && G.s >= TELLS.warmSat, `a warm off-white ground (${ground ? hex(ground) : ""})`],
      [!!display && serifFace(display.family), `a serif display (${display?.family ?? ""})`],
      [clay !== null, `a clay accent (${clay ?? ""})`],
    ] },
    { n: 2, name: "near-black with one acid accent", features: [
      [!!G && G.l < TELLS.darkLight, `a near-black ground (${ground ? hex(ground) : ""})`],
      [!!A && (inHue(A.h, TELLS.acidHue) || inHue(A.h, TELLS.vermilionHue)), `an acid green or vermilion accent (${accent?.key ?? ""}, hue ${A ? Math.round(A.h) : 0}°)`],
      [oneHue, "no other saturated colour"],
    ] },
    { n: 3, name: "the broadsheet", features: [
      [lines.length >= 2 && Math.max(...lines) <= 1, `${lines.length} strokes and rules, all 1 px or less`],
      [painted.length >= TELLS.trio && painted.every((l) => radius(l.a).value === 0), `radius 0 on all ${painted.length} painted containers`],
      [narrow.length >= 2, `${narrow.length} narrow columns of body text (under ${TELLS.measureMin} characters a line)`],
    ] },
    { n: 4, name: "the software kit", features: [
      [sameCards !== null, `${sameCards?.n ?? 0} cards of one size and radius (${sameCards?.key ?? ""})`],
      [kit.oneRadius !== null, `one radius on every container (${kit.oneRadius ?? ""})`],
      [!!kit.shadow?.softGrey, `one soft grey shadow on each card (${kit.shadow?.key ?? ""})`],
      [wash, "a gradient wash"],
    ] },
    { n: 5, name: "template chrome", features: [
      [kit.eyebrows > 0, "tracked capital labels over headings"],
      [short.some((s) => s.length <= 120 && META.test(s)), "middle-dot meta strings"],
      [short.some((s) => (LABEL_DASH.exec(s)?.[1]?.match(/[A-Z]/g) ?? []).length >= 2), "\"WORD — fragment\" labels"],
      [!!ink && chromeInk(ink), `near-black or tinted text (${ink ? hex(ink) : ""})`],
      [!!mono, `small monospaced labels (${mono?.text!.runs[0]?.family ?? ""})`],
      [short.some((s) => s.length <= 40 && ARROW.test(s)), "an arrow on links and buttons"],
    ] },
    { n: 6, name: "the dashboard kit", features: [
      [!!sidebar, `a navy, slate or saturated sidebar ("${sidebar?.node.name ?? ""}", ${sidebar?.solid ? hex(sidebar.solid.color) : ""})`],
      [kit.tiles || kit.stats.some((row) => row.every((s) => s.tile)), "an icon tile on every card or KPI"],
      [branded.length >= 2 && 2 * branded.length >= figures.length, `big KPI values in the brand colour (${branded.length} of ${figures.length})`],
      [kit.stats.some((row) => row.every((s) => s.delta || s.spark)), "a \"+%\" pill or a sparkline on every KPI"],
      [!!kit.greeting, "a greeting title"],
      [areaChart, "a gradient area chart"],
      [kit.accent, "the accent on chrome"],
    ] },
  ];
  for (const look of looks) {
    const hit = look.features.filter((f) => f[0]);
    if (hit.length < TELLS.clusterMin) continue;
    push(null, `cluster_${look.n}`,
      `matches cluster ${look.n}, ${look.name}, on ${hit.length} of ${look.features.length} features: ${hit.map((f) => f[1]).join("; ")}. ` +
        "Fine when the brief chose the look; otherwise name it as a decision, or move off it.");
  }
}
