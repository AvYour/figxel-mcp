// figma_create_storyboard's planner and its record reader. No Figma in here:
// the server refuses a bad plan before the bridge is asked, the plugin builds
// exactly what was planned as ONE create_from_spec spec (so the board inherits
// that builder's checks, pacing, progress and single undo step), and a test
// pins the timing without a canvas. No runtime dependencies beyond errors.ts
// (the plugin bundles this, ES2017).
//
// A storyboard plans a piece panel by panel before anything is animated
// [C-227]. Timing is derived, never typed twice: each panel's duration is
// snapped to whole frames by default, frame k sits at k / fps [C-193], and
// bar.beat follows from the tempo [C-244]. The visible duration caption is
// the plan once the board exists: a person who edits "1.5 s" on the canvas
// retimes the panel, and the reader below parses that text first.

import { BridgeError, ErrorCode } from "./errors.js";

export const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Caption rows, in the fixed order a card shows them. */
export const CAPTIONS = ["timecode", "duration", "beat", "onScreen", "action", "camera", "transition", "audio", "notes"] as const;
export type Caption = (typeof CAPTIONS)[number];

/** The caption rows a panel fills itself; timecode and duration are derived. */
export const PANEL_TEXT_FIELDS = ["beat", "onScreen", "action", "camera", "transition", "audio", "notes"] as const;
type PanelTextField = (typeof PANEL_TEXT_FIELDS)[number];

export const SNAPS = ["frame", "beat", "none"] as const;
export type Snap = (typeof SNAPS)[number];

export const STORYBOARD_LIMITS = {
  panels: 48,
  totalS: 600,
  panelS: 60,
  title: 120,
  panelTitle: 80,
  text: 400,
  fps: [1, 60],
  bpm: [30, 300],
  beatsPerBar: [1, 12],
  columns: [1, 12],
  thumbWidth: [96, 1080],
  styleframeWidth: [64, 4096],
} as const;

/** Where the record lives: shared plugin data, readable by any plugin, so a re-imported dev plugin with a new id still finds it [C-188]. */
export const STORYBOARD_NAMESPACE = "figmamcp";
export const STORYBOARD_KEY = "storyboard";

/** What an unfilled caption shows, and what a reader treats as empty. */
export const EMPTY_CAPTION = "—";

/** A caption row's name; its label on the card is the same in capitals. */
export const CAPTION_NAME: Record<Caption, string> = {
  timecode: "Time",
  duration: "Duration",
  beat: "Beat",
  onScreen: "On screen",
  action: "Action",
  camera: "Camera",
  transition: "Transition",
  audio: "Audio / VO",
  notes: "Notes",
};

const RATIO: Record<Aspect, number> = { "9:16": 16 / 9, "4:5": 5 / 4, "1:1": 1, "16:9": 9 / 16 };
const DEFAULTS: Record<Aspect, { columns: number; thumbWidth: number; styleframeWidth: number }> = {
  "9:16": { columns: 6, thumbWidth: 216, styleframeWidth: 1080 },
  "4:5": { columns: 5, thumbWidth: 288, styleframeWidth: 1080 },
  "1:1": { columns: 5, thumbWidth: 300, styleframeWidth: 1080 },
  "16:9": { columns: 4, thumbWidth: 384, styleframeWidth: 1920 },
};

// The board's own spacing. The wrap grid is a horizontal auto-layout whose
// rows are spaced by rowGap [C-095]; its width is fixed so it wraps at `columns`.
const PAD = 64;
const BOARD_GAP = 48;
const GRID_GAP = 48;
const ROW_GAP = 64;
const CARD_GAP = 12;
const CAPTION_GAP = 10;
/** Styleframes sit in a row to the right of the board, this far from it and from each other. */
const BESIDE = 400;
const STYLEFRAME_GAP = 200;

const HINT = "Draw or place here";
const HINT_SIZE = 12;
const HINT_LINE = 16;

// ── small helpers ────────────────────────────────────────────────────────────

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** A number for people: at most `places` decimals, no trailing zeros ("1.5", "0.967", "2"). */
export function fmt(n: number, places = 3): string {
  return String(round(n, places));
}

/** m:ss.s, as a cue sheet writes it: 3.6 → "0:03.6", 75.25 → "1:15.3". */
export function timecode(s: number): string {
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths - m * 600) / 10;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** The first frame sampled at or after `t`: frame k shows the timeline at k / fps [C-193]. */
export function frameAt(t: number, fps: number): number {
  return Math.max(0, Math.ceil(t * fps - 1e-6));
}

/** bar.beat of beat index `b` (0-based): beat 6 in 4/4 is "2.3". */
export function barBeat(b: number, beatsPerBar: number): string {
  const whole = Math.max(0, Math.round(b));
  return `${Math.floor(whole / beatsPerBar) + 1}.${(whole % beatsPerBar) + 1}`;
}

/** Words in a line of copy; a number counts as a word, a lone dash or dot does not. */
export function countWords(text: string): number {
  // Any letter or digit, ASCII or not, makes a token a word. A plain range
  // rather than \p{L}: the plugin targets ES2017.
  return text.split(/\s+/).filter((t) => /[0-9A-Za-zÀ-￿]/.test(t) && !/^[–—·]+$/.test(t)).length;
}

/** Seconds a line needs on screen: max(5/6 s, 0.3 s per word) [C-241]. */
export function readTimeS(words: number): number {
  return words > 0 ? Math.max(5 / 6, 0.3 * words) : 0;
}

/** Two-digit panel number: 3 → "03". */
export const panelNumber = (index: number) => String(index).padStart(2, "0");

// ── the plan ─────────────────────────────────────────────────────────────────

export interface PlannedPanel {
  /** 1-based, in board order. */
  index: number;
  title?: string;
  /** As asked, before snapping. */
  askedS: number;
  /** As built: snapped unless `snap: "none"`. */
  durationS: number;
  startS: number;
  endS: number;
  /** The first frame the panel shows on. */
  startFrame: number;
  /** The first frame of the next panel: the panel shows on [startFrame, endFrame). */
  endFrame: number;
  /** bar.beat of the beat nearest the panel's start, with `bpm`. */
  bar?: string;
  words: number;
  needS: number;
  readOk: boolean;
  /** Every caption row's text, as the card shows it. */
  text: Record<Caption, string>;
  source?: string;
  image?: string;
  styleframe: boolean;
}

export interface StoryboardPlan {
  title: string;
  aspect: Aspect;
  fps: number;
  bpm?: number;
  beatsPerBar: number;
  snap: Snap;
  captions: Caption[];
  columns: number;
  thumbWidth: number;
  thumbHeight: number;
  styleframeWidth: number;
  styleframeHeight: number;
  gridWidth: number;
  boardWidth: number;
  durationS: number;
  durationFrames: number;
  panels: PlannedPanel[];
  offBeat: Array<{ index: number; startS: number; nearestBeat: string; offsetFrames: number }>;
  snapped: Array<{ index: number; from: number; to: number }>;
  readTime: Array<{ index: number; words: number; needS: number; haveS: number }>;
  /** Set when a beat is not a whole number of frames at this fps. */
  tempoNote?: string;
}

function intIn(params: Record<string, unknown>, key: string, [min, max]: readonly [number, number], fallback: number): number {
  const v = params[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`\`${key}\` must be a whole number from ${min} to ${max}.`);
  return v;
}

function numIn(params: Record<string, unknown>, key: string, [min, max]: readonly [number, number]): number | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw invalid(`\`${key}\` must be a number from ${min} to ${max}.`);
  return v;
}

const PANEL_KEYS = new Set<string>(["durationS", "title", ...PANEL_TEXT_FIELDS, "source", "image", "styleframe"]);

interface PanelIn {
  durationS: number;
  title?: string;
  fields: Partial<Record<PanelTextField, string>>;
  source?: string;
  image?: string;
  styleframe: boolean;
}

function readPanel(raw: unknown, i: number): PanelIn {
  const at = `panels[${i}]`;
  if (!isObject(raw)) throw invalid(`\`${at}\` must be an object with at least \`durationS\`.`);
  for (const k of Object.keys(raw)) {
    if (!PANEL_KEYS.has(k)) throw invalid(`\`${at}.${k}\` is not a panel field.`, `A panel takes ${[...PANEL_KEYS].join(", ")}.`);
  }
  const d = raw.durationS;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0 || d > STORYBOARD_LIMITS.panelS) {
    throw invalid(`\`${at}.durationS\` must be a number of seconds above 0 and at most ${STORYBOARD_LIMITS.panelS}.`);
  }
  const text = (key: string, max: number): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw invalid(`\`${at}.${key}\` must be text.`);
    if (v.length > max) throw invalid(`\`${at}.${key}\` is ${v.length} characters; the limit is ${max}.`);
    return v.trim() ? v.trim() : undefined;
  };
  const fields: Partial<Record<PanelTextField, string>> = {};
  for (const f of PANEL_TEXT_FIELDS) {
    const v = text(f, STORYBOARD_LIMITS.text);
    if (v !== undefined) fields[f] = v;
  }
  const id = (key: "source" | "image"): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) throw invalid(`\`${at}.${key}\` must be ${key === "source" ? "a node id" : "an imageHash"}.`);
    return v.trim();
  };
  const source = id("source");
  const image = id("image");
  if (source && image) {
    throw invalid(`\`${at}\` gives both \`source\` and \`image\`: one picture per thumbnail.`, "`source` snapshots a node of this file; `image` reuses an imageHash already in it.");
  }
  if (raw.styleframe !== undefined && typeof raw.styleframe !== "boolean") throw invalid(`\`${at}.styleframe\` must be true or false.`);
  const title = text("title", STORYBOARD_LIMITS.panelTitle);
  return {
    durationS: d,
    ...(title ? { title } : {}),
    fields,
    ...(source ? { source } : {}),
    ...(image ? { image } : {}),
    styleframe: raw.styleframe === true,
  };
}

function captionsFor(raw: unknown, panels: PanelIn[]): Caption[] {
  const filled = new Set<PanelTextField>();
  for (const p of panels) for (const f of PANEL_TEXT_FIELDS) if (p.fields[f] !== undefined) filled.add(f);
  if (raw === undefined) return CAPTIONS.filter((c) => c === "timecode" || c === "duration" || filled.has(c as PanelTextField));
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("`captions` must be a list of caption rows.", `Rows: ${CAPTIONS.join(", ")}.`);
  const asked = new Set<Caption>();
  raw.forEach((c, i) => {
    if (typeof c !== "string" || !(CAPTIONS as readonly string[]).includes(c)) {
      throw invalid(`\`captions[${i}]\` ${JSON.stringify(c)} is not a caption row.`, `Rows: ${CAPTIONS.join(", ")}.`);
    }
    asked.add(c as Caption);
  });
  // A filled field that no row shows would vanish from the board without a word.
  for (const f of filled) {
    if (asked.has(f)) continue;
    const i = panels.findIndex((p) => p.fields[f] !== undefined);
    throw invalid(`\`panels[${i}].${f}\` is filled, but \`captions\` leaves out "${f}".`, `Add "${f}" to captions, or leave captions out to show every filled row.`);
  }
  return CAPTIONS.filter((c) => asked.has(c));
}

/**
 * Check and plan a storyboard from the tool's params. Throws INVALID_PARAM
 * naming the field on anything it cannot build; nothing here touches Figma, so
 * a refusal from it changed nothing. Unknown top-level keys are left alone: the
 * call also carries `session`, `idempotencyKey`, `pageId`, `x` and `y`.
 */
export function planStoryboard(params: Record<string, unknown>): StoryboardPlan {
  const title = typeof params.title === "string" ? params.title.trim() : "";
  if (!title || title.length > STORYBOARD_LIMITS.title) throw invalid(`\`title\` must be 1–${STORYBOARD_LIMITS.title} characters.`);
  if (typeof params.aspect !== "string" || !(ASPECTS as readonly string[]).includes(params.aspect)) {
    throw invalid(`\`aspect\` must be one of ${ASPECTS.join(", ")}.`);
  }
  const aspect = params.aspect as Aspect;
  const fps = intIn(params, "fps", STORYBOARD_LIMITS.fps, 30);
  const bpm = numIn(params, "bpm", STORYBOARD_LIMITS.bpm);
  if (params.beatsPerBar !== undefined && bpm === undefined) throw invalid("`beatsPerBar` needs `bpm`: without a tempo there are no bars.");
  const beatsPerBar = intIn(params, "beatsPerBar", STORYBOARD_LIMITS.beatsPerBar, 4);
  const snapRaw = params.snap ?? "frame";
  if (typeof snapRaw !== "string" || !(SNAPS as readonly string[]).includes(snapRaw)) throw invalid(`\`snap\` must be one of ${SNAPS.join(", ")}.`);
  const snap = snapRaw as Snap;
  if (snap === "beat" && bpm === undefined) throw invalid('`snap: "beat"` needs `bpm`.', 'Give the tempo, or snap to "frame".');

  if (!Array.isArray(params.panels) || params.panels.length === 0) throw invalid("`panels` must list at least one panel.");
  if (params.panels.length > STORYBOARD_LIMITS.panels) {
    throw invalid(`\`panels\` has ${params.panels.length} panels; a board holds at most ${STORYBOARD_LIMITS.panels}.`, "Split the piece into several boards, one per sequence.");
  }
  const inputs = params.panels.map(readPanel);
  const captions = captionsFor(params.captions, inputs);

  const defaults = DEFAULTS[aspect];
  const columns = Math.min(intIn(params, "columns", STORYBOARD_LIMITS.columns, defaults.columns), inputs.length);
  const thumbWidth = round(numIn(params, "thumbWidth", STORYBOARD_LIMITS.thumbWidth) ?? defaults.thumbWidth, 2);
  const thumbHeight = Math.round(thumbWidth * RATIO[aspect]);
  const styleframeWidth = round(numIn(params, "styleframeWidth", STORYBOARD_LIMITS.styleframeWidth) ?? defaults.styleframeWidth, 2);
  const styleframeHeight = Math.round(styleframeWidth * RATIO[aspect]);

  // Durations: whole frames, whole beats, or as given.
  const beatS = bpm === undefined ? 0 : 60 / bpm;
  const snapped: StoryboardPlan["snapped"] = [];
  const spans: Array<{ startS: number; endS: number; durationS: number }> = [];
  let frames = 0; // running total, snap frame
  let beats = 0; // running total, snap beat
  let clock = 0; // running total, snap none
  inputs.forEach((p, i) => {
    let startS: number;
    let endS: number;
    if (snap === "frame") {
      const f = Math.max(1, Math.round(p.durationS * fps));
      startS = frames / fps;
      frames += f;
      endS = frames / fps;
    } else if (snap === "beat") {
      const b = Math.max(1, Math.round(p.durationS / beatS));
      startS = beats * beatS;
      beats += b;
      endS = beats * beatS;
    } else {
      startS = clock;
      clock += p.durationS;
      endS = clock;
    }
    const durationS = endS - startS;
    if (Math.abs(durationS - p.durationS) > 1e-9) snapped.push({ index: i + 1, from: p.durationS, to: round(durationS, 4) });
    spans.push({ startS, endS, durationS });
  });
  const durationS = spans[spans.length - 1]!.endS;
  if (durationS > STORYBOARD_LIMITS.totalS + 1e-9) {
    throw invalid(`The panels run ${fmt(durationS, 2)} s; a board plans at most ${STORYBOARD_LIMITS.totalS} s.`, "Split the piece into several boards.");
  }

  const offBeat: StoryboardPlan["offBeat"] = [];
  const readTime: StoryboardPlan["readTime"] = [];
  const panels: PlannedPanel[] = inputs.map((p, i) => {
    const index = i + 1;
    const span = spans[i]!;
    const startFrame = frameAt(span.startS, fps);
    const endFrame = frameAt(span.endS, fps);
    if (endFrame <= startFrame) {
      throw invalid(`\`panels[${i}]\` (${fmt(p.durationS)} s) falls between two frames at ${fps} fps, so it would never show.`, 'Lengthen it, or leave `snap` at "frame".');
    }
    let bar: string | undefined;
    if (bpm !== undefined) {
      const at = span.startS / beatS;
      const nearest = Math.round(at);
      bar = barBeat(nearest, beatsPerBar);
      const offsetFrames = Math.round((span.startS - nearest * beatS) * fps);
      if (offsetFrames !== 0) offBeat.push({ index, startS: round(span.startS, 4), nearestBeat: bar, offsetFrames });
    }
    const words = p.fields.onScreen ? countWords(p.fields.onScreen) : 0;
    const needS = readTimeS(words);
    const readOk = span.durationS + 1e-9 >= needS;
    if (!readOk) readTime.push({ index, words, needS: round(needS, 2), haveS: round(span.durationS, 4) });
    const shown = endFrame - startFrame;
    const text = {} as Record<Caption, string>;
    text.timecode = `${timecode(span.startS)} → ${timecode(span.endS)} · f${startFrame} → f${endFrame}${bar ? ` · bar ${bar}` : ""}`;
    // The seconds come first: they are what a reader parses back.
    text.duration = `${fmt(span.durationS)} s · ${shown} f`;
    for (const f of PANEL_TEXT_FIELDS) text[f] = p.fields[f] ?? EMPTY_CAPTION;
    return {
      index,
      ...(p.title ? { title: p.title } : {}),
      askedS: p.durationS,
      durationS: round(span.durationS, 6),
      startS: round(span.startS, 4),
      endS: round(span.endS, 4),
      startFrame,
      endFrame,
      ...(bar ? { bar } : {}),
      words,
      needS: round(needS, 2),
      readOk,
      text,
      ...(p.source ? { source: p.source } : {}),
      ...(p.image ? { image: p.image } : {}),
      styleframe: p.styleframe,
    };
  });

  let tempoNote: string | undefined;
  if (bpm !== undefined) {
    // A tempo where one beat is a whole number of frames keeps every hit on a frame [C-244].
    const perBeat = (fps * 60) / bpm;
    if (Math.abs(perBeat - Math.round(perBeat)) > 1e-6) {
      tempoNote = `At ${fmt(bpm)} BPM one beat is ${fmt(perBeat, 2)} frames at ${fps} fps, so beats fall between frames. A tempo where fps × 60 / BPM is a whole number keeps every beat on a frame.`;
    }
  }

  const gridWidth = columns * thumbWidth + (columns - 1) * GRID_GAP;
  return {
    title, aspect, fps, ...(bpm !== undefined ? { bpm } : {}), beatsPerBar, snap, captions, columns,
    thumbWidth, thumbHeight, styleframeWidth, styleframeHeight, gridWidth, boardWidth: gridWidth + 2 * PAD,
    durationS: round(durationS, 4),
    durationFrames: frameAt(durationS, fps),
    panels, offBeat, snapped, readTime,
    ...(tempoNote ? { tempoNote } : {}),
  };
}

// ── the spec ─────────────────────────────────────────────────────────────────

/** The text roles on a board, with the size and weight each takes when the file has no style for it. */
export const TEXT_ROLES = {
  title: { size: 40, weight: "Semi Bold", strong: true, names: /title|display|heading|h1|h2/i },
  meta: { size: 15, weight: "Regular", strong: false, names: /body|text|paragraph|subtitle/i },
  head: { size: 15, weight: "Semi Bold", strong: true, names: /head|title|subtitle|label|strong|h[3-6]/i },
  label: { size: 11, weight: "Semi Bold", strong: true, names: /label|caption|overline|eyebrow|caps|tag|micro/i },
  value: { size: 13, weight: "Regular", strong: false, names: /body|text|caption|small|paragraph/i },
  hint: { size: HINT_SIZE, weight: "Regular", strong: false, names: /caption|small|hint|note|body/i },
} as const;
export type TextRole = keyof typeof TEXT_ROLES;

export interface TextStyleInfo {
  id: string;
  name: string;
  fontSize: number;
  fontName: { family: string; style: string };
}

/** Light to Medium read as regular; Semi Bold and heavier as strong. */
const isStrong = (style: string) => /semi|demi|bold|black|heavy|extra|ultra/i.test(style) && !/light/i.test(style);

/**
 * The file's own text style for each role, when it has one close enough: a
 * size within 15 % (at least 1 px) of the role's and the same weight class,
 * nearest size first, then a name that says what it is for, then the name.
 * Roles nothing fits keep the board's raw values.
 */
export function matchTextStyles(styles: readonly TextStyleInfo[]): Partial<Record<TextRole, TextStyleInfo>> {
  const out: Partial<Record<TextRole, TextStyleInfo>> = {};
  for (const role of Object.keys(TEXT_ROLES) as TextRole[]) {
    const want = TEXT_ROLES[role];
    const fits = styles.filter(
      (s) => typeof s.fontSize === "number" && Math.abs(s.fontSize - want.size) <= Math.max(1, want.size * 0.15) && isStrong(s.fontName.style) === want.strong,
    );
    fits.sort(
      (a, b) =>
        Math.abs(a.fontSize - want.size) - Math.abs(b.fontSize - want.size) ||
        Number(want.names.test(b.name)) - Number(want.names.test(a.name)) ||
        a.name.localeCompare(b.name),
    );
    if (fits[0]) out[role] = fits[0];
  }
  return out;
}

type SpecNode = Record<string, unknown>;

const INK = "#111114";
const BODY = "#1A1A1E";
const MUTED = "#55555C";
const LABEL = "#6B6B73";
const THUMB = "#E6E6EA";
const HINT_INK = "#5C5C66";

/** The refs the compiled spec declares, so the op maps create_from_spec's `refs` back to panels. */
export interface PanelRefs {
  card: string;
  thumb: string;
  hint?: string;
  captions: Partial<Record<Caption, string>>;
  styleframe?: string;
}

export interface CompiledStoryboard {
  roots: SpecNode[];
  board: string;
  panels: PanelRefs[];
}

/** How many lines the hint takes in a thumbnail, estimated wide (about 0.62 em a character) so it is never cut. */
function hintLines(width: number): number {
  const perLine = Math.max(1, Math.floor(width / (HINT_SIZE * 0.62)));
  let lines = 1;
  let used = 0;
  for (const w of HINT.split(" ")) {
    const need = used === 0 ? w.length : used + 1 + w.length;
    if (need > perLine && used > 0) {
      lines++;
      used = w.length;
    } else used = need;
  }
  return lines;
}

/**
 * The plan as create_from_spec roots: the board (a white vertical auto-layout
 * with a header and a wrapping grid of cards) and, for each panel that asked
 * for one, an empty full-size styleframe in a row to its right. `textStyles`
 * maps a role to a style id the file defines.
 */
export function compileStoryboardSpec(
  plan: StoryboardPlan,
  at: { x: number; y: number },
  textStyles: Partial<Record<TextRole, string>> = {},
): CompiledStoryboard {
  const text = (role: TextRole, content: string, extra: SpecNode = {}): SpecNode => {
    const r = TEXT_ROLES[role];
    const style = textStyles[role];
    return {
      type: "text",
      content,
      fontSize: r.size,
      weight: r.weight,
      ...extra,
      ...(style ? { style: { text: style } } : {}),
    };
  };
  const legend =
    `Each card: number, title and start time; the frame; then ${plan.captions.map((c) => CAPTION_NAME[c]).join(", ")}. ` +
    "Retime a panel by editing its duration: that text is the plan.";
  const meta = [plan.aspect, `${plan.fps} fps`, ...(plan.bpm !== undefined ? [`${fmt(plan.bpm)} BPM`] : []), `${fmt(plan.durationS, 2)} s`, `${plan.panels.length} panel${plan.panels.length === 1 ? "" : "s"}`].join(" · ");

  const refs: PanelRefs[] = [];
  const cards = plan.panels.map((p): SpecNode => {
    const nn = panelNumber(p.index);
    const r: PanelRefs = { card: `p${p.index}_card`, thumb: `p${p.index}_thumb`, captions: {} };
    // A filled thumbnail needs no prompt to draw in it.
    const filled = p.source !== undefined || p.image !== undefined;
    const hintWidth = plan.thumbWidth - 24;
    const lines = hintLines(hintWidth);
    const hintFits = lines * HINT_LINE + 8 <= plan.thumbHeight;
    if (!filled && hintFits) r.hint = `p${p.index}_hint`;
    const rows = plan.captions.map((c): SpecNode => {
      r.captions[c] = `p${p.index}_${c}`;
      return {
        type: "frame",
        name: CAPTION_NAME[c],
        layout: "vertical",
        gap: 2,
        sizing: { width: "fill" },
        children: [
          text("label", CAPTION_NAME[c].toUpperCase(), { name: "Label", color: LABEL, letterSpacing: 0.6 }),
          text("value", p.text[c], { name: `Panel ${nn} / ${c}`, ref: r.captions[c], color: BODY, lineHeight: 18 }),
        ],
      };
    });
    refs.push(r);
    return {
      type: "frame",
      name: `Panel ${nn} · ${timecode(p.startS)}`,
      ref: r.card,
      layout: "vertical",
      gap: CARD_GAP,
      width: plan.thumbWidth,
      children: [
        text("head", [nn, ...(p.title ? [p.title] : []), timecode(p.startS)].join(" · "), { name: `Panel ${nn} / Title`, color: INK }),
        {
          type: "frame",
          name: `Panel ${nn} / Frame`,
          ref: r.thumb,
          width: plan.thumbWidth,
          height: plan.thumbHeight,
          background: THUMB,
          // Clipped like the frame it stands for; no layout, so a sketch drawn
          // into it keeps the x/y it is given.
          clipsContent: true,
          children: r.hint
            ? [
                text("hint", HINT, {
                  name: `Panel ${nn} / Hint`,
                  ref: r.hint,
                  color: HINT_INK,
                  align: "center",
                  lineHeight: HINT_LINE,
                  width: hintWidth,
                  x: 12,
                  y: Math.max(4, Math.round((plan.thumbHeight - lines * HINT_LINE) / 2)),
                }),
              ]
            : [],
        },
        { type: "frame", name: `Panel ${nn} / Captions`, layout: "vertical", gap: CAPTION_GAP, sizing: { width: "fill" }, children: rows },
      ],
    };
  });

  const board: SpecNode = {
    type: "frame",
    name: `Storyboard / ${plan.title}`,
    ref: "board",
    x: at.x,
    y: at.y,
    layout: "vertical",
    padding: PAD,
    gap: BOARD_GAP,
    background: "#FFFFFF",
    children: [
      {
        type: "frame",
        name: "Header",
        layout: "vertical",
        gap: 8,
        width: plan.gridWidth,
        children: [
          text("title", plan.title, { name: "Title", color: INK }),
          text("meta", meta, { name: "Meta", color: MUTED }),
          text("value", legend, { name: "Legend", color: MUTED, lineHeight: 18 }),
        ],
      },
      { type: "frame", name: "Panels", layout: "horizontal", wrap: true, gap: GRID_GAP, rowGap: ROW_GAP, width: plan.gridWidth, children: cards },
    ],
  };

  const roots: SpecNode[] = [board];
  let sx = at.x + plan.boardWidth + BESIDE;
  for (const p of plan.panels) {
    if (!p.styleframe) continue;
    const ref = `p${p.index}_sf`;
    refs[p.index - 1]!.styleframe = ref;
    roots.push({
      type: "frame",
      name: `SF ${panelNumber(p.index)} · ${p.title ?? `Panel ${panelNumber(p.index)}`}`,
      ref,
      x: sx,
      y: at.y,
      width: plan.styleframeWidth,
      height: plan.styleframeHeight,
      background: "#FFFFFF",
      clipsContent: true,
    });
    sx += plan.styleframeWidth + STYLEFRAME_GAP;
  }
  return { roots, board: "board", panels: refs };
}

// ── the record and its reader ────────────────────────────────────────────────

export interface RecordPanel {
  index: number;
  /** The card. */
  id: string;
  thumbId: string;
  captionIds: Partial<Record<Caption, string>>;
  /** The planned duration: a fallback only, when the caption is gone or no longer parses. */
  plannedS: number;
  styleframeId?: string;
  /** The panel's `source`: the node figma_create_animatic renders again at plate size. */
  sourceId?: string;
  /** The panel's `image`: an imageHash in this file. */
  imageHash?: string;
}

export interface StoryboardRecord {
  v: 1;
  title: string;
  aspect: Aspect;
  fps: number;
  bpm?: number;
  beatsPerBar: number;
  panels: RecordPanel[];
}

/** The record as stored on the board. Ids only: the values live in the visible captions. */
export function storyboardRecord(plan: StoryboardPlan, ids: { panels: Array<Omit<RecordPanel, "index" | "plannedS">> }): StoryboardRecord {
  return {
    v: 1,
    title: plan.title,
    aspect: plan.aspect,
    fps: plan.fps,
    ...(plan.bpm !== undefined ? { bpm: plan.bpm } : {}),
    beatsPerBar: plan.beatsPerBar,
    panels: plan.panels.map((p, i) => ({
      index: p.index,
      ...ids.panels[i]!,
      plannedS: p.durationS,
      ...(p.source ? { sourceId: p.source } : {}),
      ...(p.image ? { imageHash: p.image } : {}),
    })),
  };
}

/** Parse a stored record; a missing or foreign one is refused, naming the node. */
export function parseStoryboardRecord(raw: string, nodeId: string): StoryboardRecord {
  const notOne = (why: string) =>
    new BridgeError(ErrorCode.INVALID_PARAM, `\`${nodeId}\` is not a storyboard figma_create_storyboard made: ${why}.`, {
      hint: "Pass the board's storyboardId (the wrapper frame), or build one with figma_create_storyboard.",
    });
  if (!raw) throw notOne("it carries no storyboard record");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw notOne("its record is not JSON");
  }
  if (!isObject(data) || data.v !== 1) throw notOne(`its record has version ${isObject(data) ? JSON.stringify(data.v) : "none"}, not 1`);
  const fps = data.fps;
  if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 60) throw notOne("its record has no valid fps");
  if (!Array.isArray(data.panels) || data.panels.length === 0) throw notOne("its record lists no panels");
  const panels = data.panels.map((p, i): RecordPanel => {
    if (!isObject(p) || typeof p.id !== "string" || typeof p.thumbId !== "string" || typeof p.plannedS !== "number" || !isObject(p.captionIds)) {
      throw notOne(`panel ${i + 1} of its record is malformed`);
    }
    return {
      index: typeof p.index === "number" ? p.index : i + 1,
      id: p.id,
      thumbId: p.thumbId,
      captionIds: p.captionIds as Partial<Record<Caption, string>>,
      plannedS: p.plannedS,
      ...(typeof p.styleframeId === "string" ? { styleframeId: p.styleframeId } : {}),
      ...(typeof p.sourceId === "string" ? { sourceId: p.sourceId } : {}),
      ...(typeof p.imageHash === "string" ? { imageHash: p.imageHash } : {}),
    };
  });
  return {
    v: 1,
    title: typeof data.title === "string" ? data.title : "",
    aspect: (ASPECTS as readonly unknown[]).includes(data.aspect) ? (data.aspect as Aspect) : "9:16",
    fps,
    ...(typeof data.bpm === "number" ? { bpm: data.bpm } : {}),
    beatsPerBar: typeof data.beatsPerBar === "number" ? data.beatsPerBar : 4,
    panels,
  };
}

const DURATION = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(s|sec|secs|second|seconds|f|fr|frame|frames)?(?![A-Za-z])/i;

/**
 * Seconds from a duration caption as a person may leave it: "1.5 s · 45 f",
 * "2s", "1,5 sec", "45 f" (frames, at `fps`). The first number and its unit
 * win; anything else, or a value at or below zero, is undefined.
 */
export function parseDurationCaption(text: string, fps: number): number | undefined {
  const m = DURATION.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return /^f/i.test(m[2] ?? "") ? value / fps : value;
}

export interface ReadPanel extends RecordPanel {
  durationS: number;
  startS: number;
  endS: number;
  startFrame: number;
  endFrame: number;
  /** "caption" when the visible duration parsed; "planned" when the record's value stood in. */
  from: "caption" | "planned";
  /** The caption text that did not parse. */
  captionConflict?: string;
  /** The duration caption, or its node, is gone. */
  captionMissing?: true;
}

export interface StoryboardReading {
  title: string;
  aspect: Aspect;
  fps: number;
  bpm?: number;
  beatsPerBar: number;
  durationS: number;
  durationFrames: number;
  panels: ReadPanel[];
  captionConflicts: Array<{ index: number; text: string; usedS: number }>;
}

/**
 * Timing from the record and each panel's duration caption text (undefined
 * when there is no caption or its node is gone): the caption first; the
 * planned value when it is missing (tolerated) or does not parse (reported as
 * a captionConflict). Times run back to back from 0.
 */
export function readStoryboardTiming(record: StoryboardRecord, durationTexts: ReadonlyArray<string | undefined>): StoryboardReading {
  let clock = 0;
  const captionConflicts: StoryboardReading["captionConflicts"] = [];
  const panels = record.panels.map((p, i): ReadPanel => {
    const text = durationTexts[i];
    const parsed = text === undefined ? undefined : parseDurationCaption(text, record.fps);
    const durationS = parsed ?? p.plannedS;
    if (text !== undefined && parsed === undefined) captionConflicts.push({ index: p.index, text, usedS: p.plannedS });
    const startS = clock;
    clock += durationS;
    return {
      ...p,
      durationS,
      startS: round(startS, 4),
      endS: round(clock, 4),
      startFrame: frameAt(startS, record.fps),
      endFrame: frameAt(clock, record.fps),
      from: parsed === undefined ? "planned" : "caption",
      ...(text !== undefined && parsed === undefined ? { captionConflict: text } : {}),
      ...(text === undefined ? { captionMissing: true as const } : {}),
    };
  });
  return {
    title: record.title,
    aspect: record.aspect,
    fps: record.fps,
    ...(record.bpm !== undefined ? { bpm: record.bpm } : {}),
    beatsPerBar: record.beatsPerBar,
    durationS: round(clock, 4),
    durationFrames: frameAt(clock, record.fps),
    panels,
    captionConflicts,
  };
}
