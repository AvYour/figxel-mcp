// figma_create_animatic's planner: which frames each plate is on screen, the
// keys that switch it, its slate, and the one create_from_spec spec the plugin
// builds. No Figma in here: the server refuses bad options before the bridge
// is asked, the plugin (src/plugin/ops/animatic.ts) reads the board and writes
// what this plans, and a test evaluates every key frame by frame through
// motion-curves.ts. No runtime dependencies beyond errors.ts and the other
// shared modules (the plugin bundles this, ES2017).
//
// An animatic is the storyboard played back at its intended pace [C-228]:
// panel n is on screen exactly on the frames its duration caption gives,
// [startFrame, endFrame) at the board's fps. Frame k shows the timeline at
// k / fps [C-193], so a change on frame k is a cut pair, two LINEAR keys
// inside the interval before it [C-240] — never HOLD, whose step was measured
// on one probe only [C-189].
//
// A video export renders the end frame too: a timeline of d seconds, kept to
// the microsecond, is ceil(d · fps) + 1 frames in every format [C-194]. The
// animatic's timeline therefore ends just short of frame E − 1 of a board E
// frames long, (E − 1 − END_MARGIN) / fps, so its render holds exactly E
// frames, the board's own length, and the last panel is not one frame longer
// than planned. Not on frame E − 1 itself: that is the edge between E and
// E + 1 frames, and Figma's rounding of the duration decides the side (see
// END_MARGIN).

import { BridgeError, ErrorCode } from "./errors.js";
import { cutPairKeys, type KeyText } from "./motion-curves.js";
import { CAPTION_NAME, fmt, panelNumber, timecode, type Aspect } from "./storyboard.js";
import { VIDEO_FPS } from "./video.js";

export const BURN_INS = ["none", "panel", "full"] as const;
export type BurnIn = (typeof BURN_INS)[number];

export const ANIMATIC_LIMITS = {
  width: [64, 4096],
  dissolveFrames: [0, 12],
} as const;

/** How far `drift` pushes a plate's art over the panel: 3 %, so a held panel is not a freeze. */
export const DRIFT_SCALE = 1.03;

/**
 * How far short of frame E − 1 the timeline ends, in frames. A timeline of
 * exactly (E − 1) / fps sits on the edge between E and E + 1 frames, and
 * Figma's rounding picks the side: it keeps a duration to the microsecond (a
 * timeline set to 86/24 s read back 3.583333), and on 2026-10-13 the dissolve
 * probe's 89/30 s, kept as 2.966667, rendered 91 frames at 30 fps where 90
 * were planned (spikes/results/live-animatic.json) [C-194]. A hundredth of a
 * frame is far wider than that rounding and far inside a cut pair's last key,
 * 0.15 frame before its frame [C-240], so every key still plays and the
 * render is ceil(d · fps) + 1 = E frames (round(d · fps) + 1 would give E
 * too, so the margin holds even if a later measurement overturns ceil).
 */
export const END_MARGIN = 0.01;

/** The caption rows a `full` slate shows after the timing, in this order. */
export const SLATE_CAPTIONS = ["beat", "action", "camera", "transition"] as const;
export type SlateCaption = (typeof SLATE_CAPTIONS)[number];

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

// ── options ──────────────────────────────────────────────────────────────────

export interface AnimaticOptions {
  /** Plate width in px; undefined takes the aspect's default (plateSize). */
  width?: number;
  burnIn: BurnIn;
  dissolveFrames: number;
  drift: boolean;
}

/**
 * The tool's options, checked. Throws INVALID_PARAM naming the field; nothing
 * here touches Figma, so a refusal from it changed nothing. `storyboardId`,
 * `pageId`, `x`, `y`, `session` and `idempotencyKey` are left alone.
 */
export function readAnimaticOptions(params: Record<string, unknown>): AnimaticOptions {
  const w = params.width;
  const [wMin, wMax] = ANIMATIC_LIMITS.width;
  if (w !== undefined && (typeof w !== "number" || !Number.isFinite(w) || w < wMin || w > wMax)) {
    throw invalid(`\`width\` must be a number of pixels from ${wMin} to ${wMax}.`);
  }
  const b = params.burnIn ?? "panel";
  if (typeof b !== "string" || !(BURN_INS as readonly string[]).includes(b)) throw invalid(`\`burnIn\` must be one of ${BURN_INS.join(", ")}.`);
  const d = params.dissolveFrames ?? 0;
  const [dMin, dMax] = ANIMATIC_LIMITS.dissolveFrames;
  if (typeof d !== "number" || !Number.isInteger(d) || d < dMin || d > dMax) throw invalid(`\`dissolveFrames\` must be a whole number from ${dMin} to ${dMax}.`);
  const drift = params.drift ?? false;
  if (typeof drift !== "boolean") throw invalid("`drift` must be true or false.");
  return { ...(typeof w === "number" ? { width: w } : {}), burnIn: b as BurnIn, dissolveFrames: d, drift };
}

const RATIO: Record<Aspect, number> = { "9:16": 16 / 9, "4:5": 5 / 4, "1:1": 1, "16:9": 9 / 16 };

/** The plate size: `width` (default 1080, or 1920 for 16:9) and a height that follows the board's aspect. */
export function plateSize(aspect: Aspect, width?: number): { width: number; height: number } {
  const w = Math.round((width ?? (aspect === "16:9" ? 1920 : 1080)) * 100) / 100;
  return { width: w, height: Math.max(1, Math.round(w * RATIO[aspect])) };
}

// ── timing ───────────────────────────────────────────────────────────────────

/** A panel as the board reads now: its frames at the board's fps, and how it leaves. */
export interface TimedPanel {
  index: number;
  startFrame: number;
  /** The first frame of the next panel: the panel is on [startFrame, endFrame). */
  endFrame: number;
  /** The panel's transition caption: how it leaves for the next panel. */
  transition?: string;
}

/** A transition caption that asks for a dissolve: it starts with "dissolve" (or "cross-dissolve"). */
export function isDissolve(transition: string | undefined): boolean {
  return typeof transition === "string" && /^\s*(cross[\s-]*)?dissolve/i.test(transition);
}

export interface PlatePlan {
  index: number;
  /** The first frame the plate is on screen. */
  inFrame: number;
  /** The first frame of the next panel, as the board plans it. */
  outFrame: number;
  /** The last frame the plate is on screen, under a dissolve into the next panel included. */
  lastFrame: number;
  /** Frames this plate takes to fade in over the one before it. */
  dissolveIn?: number;
  /** Opacity at rest: 1 for the first plate, 0 for the others, so a still shows panel 1. */
  restOpacity: 0 | 1;
  /** The plate's OPACITY keys: a key at t = 0, then a cut pair (or a dissolve ramp) at each boundary. */
  opacity: KeyText[];
  /** The SCALE_XY keys of the plate's art, with `drift`. */
  drift?: KeyText[];
}

export interface AnimaticPlan {
  fps: number;
  /** E: the board's length in frames, and the frames its render holds. */
  durationFrames: number;
  /** E / fps: the board's length. */
  durationS: number;
  /** (E − 1 − END_MARGIN) / fps: what the timeline is set to, because the end frame renders too [C-194]. */
  timelineS: number;
  expectedFrames: number;
  plates: PlatePlan[];
  /** Every boundary whose transition caption asked for a dissolve; `frames` 0 means it stayed a cut. */
  dissolves: Array<{ from: number; to: number; frames: number; asked: number }>;
}

const VALUE_ON = "1";
const VALUE_OFF = "0";
const linear = (t: number, value: string): KeyText => ({ t, value, easing: "LINEAR" });

/**
 * Plan every plate's keys from the panels' frames. Refuses (INVALID_PARAM) a
 * panel that would never show and a board shorter than two frames; panels
 * must run back to back from frame 0, as readStoryboardTiming gives them.
 *
 * A dissolve out of panel i into panel j (i's transition caption starts with
 * "dissolve") fades j in over i, which stays fully on underneath: on frame
 * k + m of a dissolve n frames long starting on j's first frame k, j's
 * opacity is (m + 1) / (n + 1), and i cuts out on frame k + n, under a plate
 * that is fully on by then. n is at most j's length minus one frame, so j is
 * fully on before it leaves in turn.
 */
export function planAnimatic(panels: readonly TimedPanel[], fps: number, opts: { dissolveFrames: number; drift: boolean }): AnimaticPlan {
  if (!Number.isInteger(fps) || fps < 1) throw invalid(`The board's fps ${fps} is not a whole number of frames per second.`);
  if (panels.length === 0) throw invalid("The board lists no panels.");
  let expect = 0;
  for (const p of panels) {
    const nn = panelNumber(p.index);
    if (p.startFrame !== expect) {
      throw invalid(`Panel ${nn} starts on frame ${p.startFrame}, not ${expect}: the panels must run back to back from frame 0.`);
    }
    if (p.endFrame <= p.startFrame) {
      throw invalid(`Panel ${nn} lasts less than one frame at ${fps} fps, so it would never show.`, `Edit its duration caption on the board to at least one frame (${fmt(1 / fps)} s).`);
    }
    expect = p.endFrame;
  }
  const E = expect;
  if (E < 2) throw invalid(`The board is ${E} frame long at ${fps} fps; an animatic needs at least 2 frames.`);
  const timelineS = (E - 1 - END_MARGIN) / fps;
  // A key on frame E − 1 (a dissolve or a drift that ends on the last frame)
  // goes on the timeline's end instead, END_MARGIN sooner: a key after the end never plays.
  const keyTime = (frame: number) => Math.min(frame / fps, timelineS);

  // The dissolve, if any, out of each panel into the next.
  const dissolves: AnimaticPlan["dissolves"] = [];
  const out = panels.map((p, i): number => {
    const next = panels[i + 1];
    if (!next || opts.dissolveFrames <= 0 || !isDissolve(p.transition)) return 0;
    const frames = Math.max(0, Math.min(opts.dissolveFrames, next.endFrame - next.startFrame - 1));
    dissolves.push({ from: p.index, to: next.index, frames, asked: opts.dissolveFrames });
    return frames;
  });

  const plates = panels.map((p, i): PlatePlan => {
    const inFrame = p.startFrame;
    const last = i === panels.length - 1;
    const dissolveIn = i > 0 ? out[i - 1]! : 0;
    const dissolveOut = out[i]!;
    const cutOut = last ? undefined : p.endFrame + dissolveOut;
    const lastFrame = cutOut === undefined ? E - 1 : cutOut - 1;
    const restOpacity: 0 | 1 = inFrame === 0 ? 1 : 0;

    const opacity: KeyText[] = [linear(0, restOpacity ? VALUE_ON : VALUE_OFF)];
    if (inFrame > 0) {
      if (dissolveIn > 0) {
        // One LINEAR segment from 0 on frame k − 1 to 1 on frame k + n: frame
        // k + m samples (m + 1) / (n + 1). Both keys sit on frames, except an
        // end on the board's last frame, which keyTime pulls a hundredth of a frame in.
        if (inFrame - 1 > 0) opacity.push(linear((inFrame - 1) / fps, VALUE_OFF));
        opacity.push(linear(keyTime(inFrame + dissolveIn), VALUE_ON));
      } else {
        opacity.push(...cutPairKeys(inFrame, fps, VALUE_OFF, VALUE_ON));
      }
    }
    if (cutOut !== undefined) opacity.push(...cutPairKeys(cutOut, fps, VALUE_ON, VALUE_OFF));

    let drift: KeyText[] | undefined;
    if (opts.drift && lastFrame > inFrame) {
      const to = `${DRIFT_SCALE},${DRIFT_SCALE}`;
      // Held at 1 until the plate comes on, then a LINEAR push to its last frame on screen.
      drift = inFrame > 0 ? [linear(0, "1,1"), linear(inFrame / fps, "1,1")] : [linear(0, "1,1")];
      drift.push(linear(keyTime(lastFrame), to));
    }

    return {
      index: p.index,
      inFrame,
      outFrame: p.endFrame,
      lastFrame,
      ...(dissolveIn > 0 ? { dissolveIn } : {}),
      restOpacity,
      opacity,
      ...(drift ? { drift } : {}),
    };
  });

  return {
    fps,
    durationFrames: E,
    durationS: round4(E / fps),
    timelineS,
    expectedFrames: E,
    plates,
    dissolves,
  };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

// ── slates ───────────────────────────────────────────────────────────────────

/**
 * A panel's label from its card header as the board shows it. The storyboard
 * writes "02 · Vase · 0:01.2"; the number and the start time are dropped
 * (the animatic computes its own timing), the title kept. A header a person
 * rewrote is kept whole after the number; none at all gives "Panel 02".
 */
export function panelLabel(index: number, header?: string): string {
  const nn = panelNumber(index);
  const text = header?.trim();
  if (!text) return `Panel ${nn}`;
  const parts = text.split(" · ");
  if (parts.length >= 2 && /^\d+$/.test(parts[0]!) && /^\d+:\d{2}\.\d$/.test(parts[parts.length - 1]!)) {
    const title = parts.slice(1, -1).join(" · ").trim();
    return title ? `${nn} · ${title}` : `Panel ${nn}`;
  }
  return text.startsWith(nn) ? text : `${nn} · ${text}`;
}

export interface SlateInput {
  label: string;
  startS: number;
  endS: number;
  startFrame: number;
  endFrame: number;
  durationS: number;
  /** Filled caption rows as the board shows them; an empty caption is left out. */
  captions: Partial<Record<SlateCaption, string>>;
}

/** The slate's lines: none; the panel's label; or the label, its timing and its filled captions. */
export function slateLines(burnIn: BurnIn, s: SlateInput): string[] {
  if (burnIn === "none") return [];
  if (burnIn === "panel") return [s.label];
  const timing = `${timecode(s.startS)} → ${timecode(s.endS)} · f${s.startFrame} → f${s.endFrame} · ${fmt(s.durationS)} s`;
  const rows = SLATE_CAPTIONS.filter((c) => s.captions[c] !== undefined).map((c) => `${CAPTION_NAME[c]}: ${s.captions[c]}`);
  return [s.label, timing, ...rows];
}

// ── the spec ─────────────────────────────────────────────────────────────────

type SpecNode = Record<string, unknown>;

const BLACK = "#000000";
const SLATE_BACKING = "#000000B3";
const SLATE_INK = "#FFFFFF";

export interface PlateSpecInput {
  index: number;
  startS: number;
  restOpacity: 0 | 1;
  slate: string[];
}

export interface AnimaticRefs {
  root: string;
  plates: Array<{ plate: string; art: string; slate?: string }>;
}

/**
 * The animatic as one create_from_spec root: a black clipping top-level frame
 * holding one plate per panel, all at 0,0 and stacked in panel order (the
 * last on top). A plate is a black frame at rest opacity with its art (a
 * rectangle the op fills with the panel's picture) and, with a burn-in, a
 * slate in its top-left corner sized to the plate.
 */
export function compileAnimaticSpec(
  title: string,
  at: { x: number; y: number },
  size: { width: number; height: number },
  plates: readonly PlateSpecInput[],
): { root: SpecNode; refs: AnimaticRefs } {
  const fontSize = Math.max(10, Math.round(size.width / 30));
  const small = Math.max(8, Math.round(fontSize * 0.72));
  const margin = Math.max(4, Math.round(size.width * 0.04));
  const pad = Math.max(2, Math.round(fontSize * 0.45));
  const maxText = Math.max(16, Math.round(size.width - 2 * margin - 2 * pad));
  const refs: AnimaticRefs = { root: "animatic", plates: [] };

  const children = plates.map((p): SpecNode => {
    const nn = panelNumber(p.index);
    const r: AnimaticRefs["plates"][number] = { plate: `p${p.index}_plate`, art: `p${p.index}_art` };
    const kids: SpecNode[] = [{ type: "rectangle", name: `Plate ${nn} / Art`, ref: r.art, x: 0, y: 0, width: size.width, height: size.height, fill: BLACK }];
    if (p.slate.length) {
      r.slate = `p${p.index}_slate`;
      kids.push({
        type: "frame",
        name: `Plate ${nn} / Slate`,
        ref: r.slate,
        x: margin,
        y: margin,
        layout: "vertical",
        gap: Math.max(2, Math.round(fontSize * 0.2)),
        padding: pad,
        background: SLATE_BACKING,
        children: p.slate.map((line, i): SpecNode => {
          const sizePx = i === 0 ? fontSize : small;
          // A line that would run past the plate wraps at its width; a short one hugs.
          const wide = line.length * sizePx * 0.56 > maxText;
          return {
            type: "text",
            name: i === 0 ? "Label" : `Line ${i}`,
            content: line,
            fontSize: sizePx,
            weight: i === 0 ? "Semi Bold" : "Regular",
            color: SLATE_INK,
            ...(wide ? { width: maxText } : {}),
          };
        }),
      });
    }
    refs.plates.push(r);
    return {
      type: "frame",
      name: `Plate ${nn} · ${timecode(p.startS)}`,
      ref: r.plate,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      background: BLACK,
      clipsContent: true,
      opacity: p.restOpacity,
      children: kids,
    };
  });

  return {
    root: {
      type: "frame",
      name: `Animatic · ${title}`,
      ref: refs.root,
      x: at.x,
      y: at.y,
      width: size.width,
      height: size.height,
      background: BLACK,
      clipsContent: true,
      children,
    },
    refs,
  };
}

// ── the render it hands back ─────────────────────────────────────────────────

/**
 * The figma_export_video call that plays the animatic back: at the board's
 * fps, at half the plate width (a check render stays small), under a jobId
 * named after the piece. MP4 renders 12, 24, 30 or 60 fps only [C-116]; a
 * board timed at another rate gets the nearest and a note, because its cut
 * pairs sit between that rate's frames.
 */
export function renderCall(animaticId: string, title: string, fps: number, width: number): { render: string; renderNote?: string } {
  const offered = VIDEO_FPS.MP4;
  const renderFps = offered.includes(fps) ? fps : offered.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  const half = Math.round(width / 4) * 2;
  const renderWidth = half >= 64 ? half : Math.round(width / 2) * 2;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "piece";
  const render = `figma_export_video { nodeId: "${animaticId}", fps: ${renderFps}, width: ${renderWidth}, jobId: "animatic-${slug}" }`;
  return renderFps === fps
    ? { render }
    : {
        render,
        renderNote: `The board is timed at ${fps} fps, which MP4 does not render (12, 24, 30 or 60); at ${renderFps} fps its cuts land on the nearest frames, not exactly. Retime the board at an offered rate for an exact animatic.`,
      };
}
