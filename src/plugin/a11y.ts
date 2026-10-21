// figma_check_layout's `a11y` audit: whether anyone can operate what a UI/UX
// designer drew — targets big enough to hit and far enough apart, a visible
// focus state, an input whose edge can be found, an error said in words, a
// label for every field, text that survives being enlarged, controls clear of
// the system bars (role spec §4.1). The numbers are the standards' own: WCAG
// 2.2 on the web, Apple's Human Interface Guidelines on iOS, Android's
// touch-target guidance; the platform and the device width come from the
// brief (src/shared/roles.ts), and without one the frame is a web page in CSS px.
//
// It also holds what the other role audits share: the brief's platform and
// its unit conversion (device units = frame px × device width ÷ frame width),
// which layers are controls, and the states a component's variants declare.
// Like craft and tells, it is judged after check.ts's walk from the census;
// the only lookups — each instance's main component — are made once by
// check.ts beforehand, so these stay plain functions.

import { PLATFORMS, PLATFORM_MIN_TEXT, PLATFORM_TARGETS, type BriefRecord, type Platform } from "../shared/roles.js";
import { childrenOf, field } from "./board-read.js";
import { contrastRatio } from "./context.js";
import { type Census, type Finding, type Index, type Layer, type Rect, type Rgb, bottom, hex, mix, r1, right } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Every threshold of the a11y audit, each from the standard named beside it. */
export const A11Y = {
  /** Minimum and recommended target sizes and spacing per platform, in device units (src/shared/roles.ts). */
  targets: PLATFORM_TARGETS,
  /** target_spacing on the web: the circle an undersized target needs clear of other targets, in CSS px (WCAG 2.2 SC 2.5.8). */
  spacingCircle: 24,
  /** focus_indicator_weak: a ring at least this thick, in CSS px, and this contrast against the default's pixels (SC 2.4.13). */
  focusThickness: 2,
  focusContrast: 3,
  /** weak_boundary: an input's edge against what is behind it (SC 1.4.11). */
  boundaryContrast: 3,
  /** input_unlabelled: a label sits within this many frame px above or left of its input, or the parent's gap when larger. */
  labelGap: 16,
  /** Instances whose main component check.ts looks up, and targets compared pairwise, so a large page stays fast. */
  mainCap: 400,
  pairCap: 400,
} as const;

const PLATFORM_NAME: Readonly<Record<Platform, string>> = { web: "the web", responsive: "the web", desktop: "desktop", ios: "iOS", android: "Android" };
/** Platforms with a pointer and a keyboard: hover exists, and focus visible is WCAG 2.2 SC 2.4.7 AA. */
export const pointerPlatform = (p: Platform) => p === "web" || p === "responsive" || p === "desktop";

// ── the brief: platform and units ────────────────────────────────────────────

/** An instance's main component, as check.ts looked it up after the walk. */
export interface MainInfo {
  id: string;
  name: string;
  /** From a library: its states are judged in the library's file. */
  remote: boolean;
  /** Its component set, when it is a variant. */
  set: NodeLike | null;
}

/** The frame a node sits in, and the device units one frame px stands for there. */
export interface Screen {
  node: NodeLike;
  box: Rect;
  scale: number;
  viewport?: { width: number; height: number };
}

/** What the role audits read from the brief, and what they share. */
export interface RoleContext {
  brief?: BriefRecord;
  platform: Platform;
  /** True when the brief named the platform; false when the web was assumed. */
  platformGiven: boolean;
  /** `details.a11y` is "AAA": 44 × 44 is then the web's minimum (WCAG 2.2 SC 2.5.5). */
  aaa: boolean;
  /** Names `details.controls` lists, lower-cased: layers to treat as controls. */
  controls: ReadonlySet<string>;
  mains: ReadonlyMap<NodeLike, MainInfo>;
  /** The audits running: states leaves a missing focus state to a11y when both run. */
  audits: ReadonlySet<string>;
  screenOf(n: NodeLike): Screen | null;
  /** Device units per frame px at `n`; 1 without a viewport. */
  scale(n: NodeLike): number;
  /**
   * Top-level frames by name, for screen_state_missing and the mark's
   * versions (check.ts lists them), with the node where it was read.
   */
  frames: ReadonlyArray<{ id: string; name: string; node?: NodeLike }>;
}

const SIZE = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/;

/** `details.viewport`: "390x844", a list of them, or { width, height } entries. */
export function parseViewports(v: unknown): Array<{ width: number; height: number }> {
  const list: unknown[] = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: Array<{ width: number; height: number }> = [];
  for (const e of list) {
    if (typeof e === "string") {
      const m = SIZE.exec(e);
      if (m) out.push({ width: Number(m[1]), height: Number(m[2]) });
    } else if (e && typeof e === "object" && typeof (e as Any).width === "number" && typeof (e as Any).height === "number") {
      out.push({ width: (e as Any).width as number, height: (e as Any).height as number });
    }
  }
  return out.filter((s) => s.width > 0 && s.height > 0);
}

/** The viewport whose width is nearest the frame's (by ratio), the first on a tie: a 390 frame is the phone, a 1440 one the desktop. */
function bestViewport(list: ReadonlyArray<{ width: number; height: number }>, frameWidth: number) {
  let best: { width: number; height: number } | undefined;
  let off = Infinity;
  for (const v of list) {
    const d = Math.abs(Math.log(frameWidth / v.width));
    if (d < off - 1e-9) {
      best = v;
      off = d;
    }
  }
  return best;
}

const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
const SCREEN_ENDS = new Set(["PAGE", "DOCUMENT", "SECTION", "SLIDE"]);
/** Components are drawn at device size on their own canvas: a viewport does not scale them. */
const CANVAS_TYPES = new Set(["COMPONENT", "COMPONENT_SET"]);

function boxOf(n: unknown): Rect | null {
  const b = field<Rect | null>(n, "absoluteBoundingBox");
  return b && Number.isFinite(b.width) && Number.isFinite(b.height) ? b : null;
}

export function roleContext(o: {
  brief?: BriefRecord;
  mains?: ReadonlyMap<NodeLike, MainInfo>;
  audits?: ReadonlySet<string>;
  frames?: ReadonlyArray<{ id: string; name: string; node?: NodeLike }>;
} = {}): RoleContext {
  const details = (o.brief?.details ?? {}) as Any;
  const p = details.platform;
  const platformGiven = typeof p === "string" && (PLATFORMS as readonly string[]).indexOf(p) >= 0;
  const platform = (platformGiven ? p : "web") as Platform;
  const viewports = parseViewports(details.viewport);
  const listed = Array.isArray(details.controls) ? (details.controls as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const screens = new Map<NodeLike, Screen | null>();
  const screenOf = (n: NodeLike): Screen | null => {
    let top: NodeLike | null = null;
    for (let q: NodeLike | null | undefined = n; q && !SCREEN_ENDS.has(q.type); q = field<NodeLike | null>(q, "parent")) {
      if (SCREEN_TYPES.has(q.type)) top = q;
    }
    if (!top) return null;
    if (screens.has(top)) return screens.get(top)!;
    const box = boxOf(top);
    let s: Screen | null = null;
    if (box && box.width > 0) {
      const vp = CANVAS_TYPES.has(top.type) ? undefined : bestViewport(viewports, box.width);
      s = { node: top, box, scale: vp ? vp.width / box.width : 1, ...(vp ? { viewport: vp } : {}) };
    }
    screens.set(top, s);
    return s;
  };
  return {
    ...(o.brief ? { brief: o.brief } : {}),
    platform,
    platformGiven,
    aaa: details.a11y === "AAA",
    controls: new Set(listed.map((s) => s.trim().toLowerCase())),
    mains: o.mains ?? new Map(),
    audits: o.audits ?? new Set(),
    screenOf,
    scale: (n) => screenOf(n)?.scale ?? 1,
    frames: o.frames ?? [],
  };
}

/**
 * min_text's default floor (role spec §4.0): the platform's smallest text
 * (Apple HIG: iOS 11 pt) in frame px at the text's frame, when the brief names
 * a platform that has one. The brief's own minTextSize still wins (check.ts).
 */
export function textFloorOf(rc: RoleContext): ((n: NodeLike) => { px: number; source: string } | undefined) | undefined {
  const min = PLATFORM_MIN_TEXT[rc.platform];
  if (min === undefined || !rc.platformGiven) return undefined;
  const unit = A11Y.targets[rc.platform].unit;
  return (n) => {
    const s = rc.scale(n);
    return { px: min / s, source: `${PLATFORM_NAME[rc.platform]}'s ${min} ${unit} minimum, Apple HIG${s !== 1 ? `, at this frame's scale of ${Math.round(s * 100) / 100} ${unit} per px` : ""}` };
  };
}

// ── controls ────────────────────────────────────────────────────────────────

/** A layer name as words: camelCase split, separators to spaces, lower case — "IconButton/Primary" is "icon button primary". */
export function words(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// The spec's list (§4.1), as whole words, with the spellings designers use for
// the same control (check box, drop-down, combo box, text area).
const CONTROL = /(^| )(button|btn|link|tab|toggle|switch|check ?box|radio|chip|input|field|text ?field|text ?area|select|drop ?down|combo(?: ?box)?|menu ?item|slider|stepper|search|icon ?button|fab)s?(?= |$)/g;
const INPUT = /^(input|field|text ?field|text ?area|select|drop ?down|combo(?: ?box)?|search)s?$/;
const TOGGLE = /^(toggle|switch|check ?box|radio)s?$/;
/** An icon named for what it shows ("Icon / Search") is not the control it pictures. */
const ICON = /(^| )(icon|icons|ic|glyph|glyphs)( |$)/;

export type ControlType = "button" | "input" | "toggle";

/** The control word a name ends on (its head noun: "search button" is a button), or null. */
export function controlWord(name: string): string | null {
  const w = words(name);
  const found = w.match(CONTROL);
  if (!found) return null;
  const last = found[found.length - 1]!.trim();
  if (ICON.test(w) && !/^icon ?button/.test(last)) return null;
  return last;
}

export function controlTypeOf(word: string): ControlType {
  const w = word.replace(/s$/, "");
  return INPUT.test(w) || INPUT.test(word) ? "input" : TOGGLE.test(w) || TOGGLE.test(word) ? "toggle" : "button";
}

const CLICK = new Set(["ON_CLICK", "ON_PRESS", "ON_DRAG", "MOUSE_UP", "MOUSE_DOWN"]);

/** The trigger of a reaction that makes the layer something people press, or null. */
export function clickTrigger(a: unknown): string | null {
  const list = field(a, "reactions");
  if (!Array.isArray(list)) return null;
  for (const r of list as Any[]) {
    const t = r && typeof r === "object" ? (r.trigger as Any | null | undefined) : undefined;
    if (t && typeof t.type === "string" && CLICK.has(t.type)) return t.type;
  }
  return null;
}

/** A layer's own name, then its main component's and its component set's. */
export function namesOf(l: Pick<Layer, "node">, rc: RoleContext): string[] {
  const out = [l.node.name];
  if (l.node.type === "INSTANCE") {
    const m = rc.mains.get(l.node);
    if (m) {
      out.push(m.name);
      if (m.set) out.push(m.set.name);
    }
  } else if (l.node.type === "COMPONENT") {
    const p = field<NodeLike | null>(l.node, "parent");
    if (p?.type === "COMPONENT_SET") out.push(p.name);
  }
  return out;
}

export interface Control {
  l: Layer;
  type: ControlType;
  /** How it was found: "reaction ON_CLICK", "name \"button\"", "details.controls". */
  why: string;
  byName: boolean;
  /** Its own target, not part of an enclosing control of the same kind (an icon in a button, a base in a button). */
  target: boolean;
}

const found = new WeakMap<Census, Control[]>();

/**
 * The controls in a census, in the spec's order (§4.1): a layer with a
 * reaction people trigger by pressing (ON_CLICK, ON_PRESS, ON_DRAG, MOUSE_UP,
 * MOUSE_DOWN); an instance or component whose own, main-component or
 * component-set name names a control; a name `details.controls` lists. A text
 * run with a hyperlink in a paragraph is inline (WCAG 2.2 SC 2.5.8's inline
 * exception) and never found here; a several-line text with a reaction is a
 * paragraph too.
 */
export function controlsOf(c: Census, ix: Index, rc: RoleContext): Control[] {
  const cached = found.get(c);
  if (cached) return cached;
  const out: Control[] = [];
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (l.node.type === "COMPONENT_SET") continue; // a set holds variants; it is not pressed itself
    const trigger = clickTrigger(l.a);
    const listed = rc.controls.has(l.node.name.trim().toLowerCase());
    if (l.text && trigger && l.text.lines > 1 && !listed) continue;
    let word: string | null = null;
    if (l.node.type === "INSTANCE" || l.node.type === "COMPONENT") {
      for (const name of namesOf(l, rc)) if (!word) word = controlWord(name);
    }
    if (!trigger && !word && !listed) continue;
    out.push({
      l,
      type: word ? controlTypeOf(word) : controlTypeOf(controlWord(l.node.name) ?? "button"),
      why: trigger ? `reaction ${trigger}` : word ? `name "${word}"` : "details.controls",
      byName: !!word && !trigger && !listed,
      target: true,
    });
  }
  // A control named as such inside a component or instance control of its
  // kind is part of it: the base inside a button, the field inside an input.
  // A button inside an input (a clear button) or inside a clickable card is
  // its own target, and so is anything with its own reaction or listing.
  const byNode = new Map(out.map((x) => [x.l.node, x]));
  for (const x of out) {
    if (!x.byName) continue;
    for (let p = x.l.node.parent; p; p = p.parent) {
      const outer = byNode.get(p);
      if (outer && outer.type === x.type && (p.type === "INSTANCE" || p.type === "COMPONENT")) {
        x.target = false;
        break;
      }
    }
  }
  found.set(c, out);
  return out;
}

// ── states ──────────────────────────────────────────────────────────────────

/** Variant values, normalised (role spec §4.2): the words designers use for one state. */
export const STATE_WORDS: Readonly<Record<string, string>> = {
  default: "default", enabled: "default", rest: "default", resting: "default", normal: "default", idle: "default",
  hover: "hover", hovered: "hover", hovering: "hover",
  focus: "focus", focused: "focus", keyboard: "focus",
  pressed: "pressed", active: "pressed", down: "pressed",
  disabled: "disabled", inactive: "disabled",
  error: "error", invalid: "error",
  loading: "loading", busy: "loading",
  selected: "selected", checked: "selected", on: "selected",
  filled: "filled",
};

/** The states a variant value names: "Focus visible" is focus, "Hover / Selected" both, "Unchecked" and "Not selected" none. */
export function statesOf(value: string): Set<string> {
  const out = new Set<string>();
  const w = words(value).split(" ");
  if (w.indexOf("not") >= 0 || w.indexOf("no") >= 0) return out;
  for (const x of w) {
    const s = STATE_WORDS[x];
    if (s) out.add(s);
  }
  return out;
}

/** A variant's properties: variantProperties when Figma gives them, else read off its name ("State=Hover, Size=L"). */
export function variantPropsOf(v: NodeLike): Record<string, string> {
  const props = field<Record<string, unknown> | null>(v, "variantProperties");
  const out: Record<string, string> = {};
  if (props && typeof props === "object") {
    for (const k of Object.keys(props)) if (typeof props[k] === "string") out[k] = props[k] as string;
    if (Object.keys(out).length) return out;
  }
  for (const pair of v.name.split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** A component set's properties and their values: variantGroupProperties, else gathered from its variants. */
export function variantGroups(set: NodeLike): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const groups = field<Record<string, { values?: unknown }> | null>(set, "variantGroupProperties");
  if (groups && typeof groups === "object") {
    for (const k of Object.keys(groups)) {
      const vals = groups[k]?.values;
      if (Array.isArray(vals)) out[k] = vals.filter((x): x is string => typeof x === "string");
    }
    if (Object.keys(out).length) return out;
  }
  for (const v of variantsOf(set)) {
    const props = variantPropsOf(v);
    for (const k of Object.keys(props)) {
      const list = out[k] ?? (out[k] = []);
      if (list.indexOf(props[k]!) < 0) list.push(props[k]!);
    }
  }
  return out;
}

export function variantsOf(set: NodeLike): NodeLike[] {
  return (childrenOf(set) ?? []).filter((v) => v.type === "COMPONENT" && field(v, "visible") !== false);
}

/** "true", "yes", "on": a boolean variant property is set. */
const TRUE = /^(true|yes|on)$/i;

/** Every state a set's variants declare: from each value, and from a boolean property named for a state ("Disabled=True"). */
export function setStates(groups: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(groups)) {
    for (const v of groups[k]!) for (const s of statesOf(v)) out.add(s);
    if (groups[k]!.some((v) => TRUE.test(v.trim()))) for (const s of statesOf(k)) out.add(s);
  }
  return out;
}

/** The states one variant shows (its values, and its boolean properties that are on). */
export function variantStates(props: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(props)) {
    for (const s of statesOf(props[k]!)) out.add(s);
    if (TRUE.test(props[k]!.trim())) for (const s of statesOf(k)) out.add(s);
  }
  return out;
}

const INACTIVE = /\b(disabled|inactive)\b/i;

/**
 * True when a component or instance shows an inactive state: a variant value
 * matching disabled or inactive, or a boolean property so named that is on
 * (role spec §4.0). `a` is the node's view.
 */
export function shownInactive(n: NodeLike, a: Any): boolean {
  if (n.type === "COMPONENT") {
    const p = field<NodeLike | null>(n, "parent");
    if (p?.type !== "COMPONENT_SET") return false;
    const props = variantPropsOf(n);
    return Object.keys(props).some((k) => INACTIVE.test(props[k]!) || (INACTIVE.test(k) && TRUE.test(props[k]!.trim())));
  }
  if (n.type !== "INSTANCE") return false;
  const cp = a.componentProperties as Record<string, { type?: string; value?: unknown }> | null | undefined;
  if (cp && typeof cp === "object") {
    for (const k of Object.keys(cp)) {
      const e = cp[k];
      if (!e) continue;
      if (e.type === "VARIANT" && typeof e.value === "string" && INACTIVE.test(e.value)) return true;
      if (e.type === "BOOLEAN" && e.value === true && INACTIVE.test(k.split("#")[0]!)) return true;
    }
  }
  const vp = a.variantProperties as Record<string, unknown> | null | undefined;
  return !!vp && typeof vp === "object" && Object.keys(vp).some((k) => typeof vp[k] === "string" && INACTIVE.test(vp[k] as string));
}

/** A control's component set — its own (a variant's parent) or its main component's — when it is local. */
export function setOf(l: Pick<Layer, "node">, rc: RoleContext): NodeLike | null {
  if (l.node.type === "COMPONENT") {
    const p = field<NodeLike | null>(l.node, "parent");
    return p?.type === "COMPONENT_SET" ? p : null;
  }
  if (l.node.type !== "INSTANCE") return null;
  const m = rc.mains.get(l.node);
  return m && !m.remote ? m.set : null;
}

export interface ControlSet {
  set: NodeLike;
  type: ControlType;
  /** An instance in the checked tree that uses it, when the set is judged because of it. */
  usedBy?: NodeLike;
}

/** Interactive component sets: in the checked tree, named or listed as controls, or with a pressable variant; and the sets of its control instances. */
export function controlSets(c: Census, ix: Index, rc: RoleContext): ControlSet[] {
  const out = new Map<NodeLike, ControlSet>();
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (l.node.type !== "COMPONENT_SET") continue;
    const word = controlWord(l.node.name);
    const listed = rc.controls.has(l.node.name.trim().toLowerCase());
    const pressed = variantsOf(l.node).some((v) => clickTrigger(v));
    if (word || listed || pressed) out.set(l.node, { set: l.node, type: controlTypeOf(word ?? "button") });
  }
  for (const x of controlsOf(c, ix, rc)) {
    const set = setOf(x.l, rc);
    if (!set || out.has(set)) continue;
    out.set(set, { set, type: x.type, ...(x.l.node.type === "INSTANCE" ? { usedBy: x.l.node } : {}) });
  }
  return [...out.values()];
}

/** The variant of `set` that shows `state`, with the same other properties as `like` when one does. */
export function variantFor(set: NodeLike, state: string, like?: Record<string, string>): NodeLike | null {
  let any: NodeLike | null = null;
  for (const v of variantsOf(set)) {
    const props = variantPropsOf(v);
    const shown = variantStates(props);
    if (!shown.has(state)) continue;
    // "Type=Default, State=Focus" is the focus variant, not the default one.
    if (state === "default" && [...shown].some((s) => s !== "default" && s !== "selected" && s !== "filled")) continue;
    if (!like) return v;
    any = any ?? v;
    const same = Object.keys(like).every((k) => {
      const mine = props[k];
      if (mine === undefined) return false;
      // The property that carries the state differs by definition.
      return mine === like[k] || statesOf(mine).size > 0 || statesOf(like[k]!).size > 0;
    });
    if (same) return v;
  }
  return any;
}

// ── paint ───────────────────────────────────────────────────────────────────

function solidOf(list: unknown): { color: Rgb; opacity: number } | null {
  if (!Array.isArray(list)) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as Any;
    if (p.visible === false) continue;
    if (p.type === "SOLID") return { color: p.color as Rgb, opacity: typeof p.opacity === "number" ? p.opacity : 1 };
    return null;
  }
  return null;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A visible ring: a solid stroke at least `min` thick, a solid shadow spread that wide, or a child named focus, ring or outline. */
function ringOf(v: NodeLike, min: number): { color: Rgb; weight: number; how: string } | null {
  const stroke = solidOf(field(v, "strokes"));
  const weight = num(field(v, "strokeWeight"), 0);
  if (stroke && weight >= min - 1e-6) return { color: stroke.color, weight, how: `a ${r1(weight)} px stroke` };
  const effects = field<Any[]>(v, "effects");
  if (Array.isArray(effects)) {
    for (const e of effects) {
      if (e.visible === false || (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW")) continue;
      const spread = num(e.spread, 0);
      const col = e.color as (Rgb & { a?: number }) | undefined;
      if (spread >= min - 1e-6 && col && num(col.a, 1) >= 0.99) return { color: col, weight: spread, how: `a ${r1(spread)} px shadow ring` };
    }
  }
  for (const k of childrenOf(v) ?? []) {
    if (field(k, "visible") === false || !/\b(focus|ring|outline)\b/i.test(k.name)) continue;
    const ks = solidOf(field(k, "strokes"));
    const kw = num(field(k, "strokeWeight"), 0);
    if (ks && kw >= min - 1e-6) return { color: ks.color, weight: kw, how: `the ${r1(kw)} px "${k.name}" layer` };
  }
  return null;
}

/** The texts a variant shows, sorted: what tells two states apart in words. */
export function textsOf(v: NodeLike, cap = 200): string[] {
  const out: string[] = [];
  const stack = [...(childrenOf(v) ?? [])];
  for (let seen = 0; stack.length && seen < cap; seen++) {
    const n = stack.pop()!;
    if (field(n, "visible") === false) continue;
    if (n.type === "TEXT") {
      const chars = field<string>(n, "characters");
      if (typeof chars === "string" && chars.trim()) out.push(chars.trim());
    }
    stack.push(...(childrenOf(n) ?? []));
  }
  return out.sort();
}

// ── the rules ───────────────────────────────────────────────────────────────

type Push = (n: NodeLike, kind: string, severity: Finding["severity"], detail: string) => void;

export function judgeA11y(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const controls = controlsOf(c, ix, rc);
  const targets = controls.filter((x) => x.target);
  targetSizes(targets, ix, rc, push);
  focusStates(c, ix, rc, push);
  boundaries(c, targets, push);
  errorsInColourOnly(c, ix, rc, push);
  labels(ix, targets, push);
  fixedTextBoxes(ix, controls, rc, push);
  safeAreas(targets, rc, push);
  return out;
}

/** Edge-to-edge distance between two boxes; 0 when they touch or overlap. */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - right(b), b.x - right(a));
  const dy = Math.max(0, a.y - bottom(b), b.y - bottom(a));
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether a circle at (cx, cy) with radius r crosses `box` (its nearest point is inside the circle). */
function circleHits(cx: number, cy: number, r: number, box: Rect): boolean {
  const nx = Math.min(Math.max(cx, box.x), right(box)) - cx;
  const ny = Math.min(Math.max(cy, box.y), bottom(box)) - cy;
  return nx * nx + ny * ny < r * r - 1e-6;
}

/**
 * target_size and target_spacing (WCAG 2.2 SC 2.5.8 and 2.5.5; Apple HIG
 * control sizes; Android's 48 dp touch target and 8 dp separation).
 *
 * On the web a target under 24 × 24 CSS px still passes SC 2.5.8 when a 24 px
 * circle centred on it crosses no other target and no other undersized
 * target's circle; it is then info, and a warning only when the circle is
 * crossed — target_size for the size, target_spacing for what it crosses.
 * SC 2.5.5 (AAA, 44 × 44) has no spacing exception, so a brief asking for AAA
 * makes 44 the minimum.
 */
function targetSizes(targets: Control[], ix: Index, rc: RoleContext, push: Push): void {
  const t = A11Y.targets[rc.platform];
  const web = pointerPlatform(rc.platform);
  const list = targets.slice(0, A11Y.pairCap);
  const nested = (a: Control, b: Control) => ix.isAncestor(a.l.node, b.l.node) || ix.isAncestor(b.l.node, a.l.node);
  const dims = (x: Control) => {
    const s = rc.scale(x.l.node);
    return { w: x.l.box.width * s, h: x.l.box.height * s, s };
  };
  const size = (d: { w: number; h: number }) => `${r1(d.w)} × ${r1(d.h)} ${t.unit}`;
  const scaleNote = (s: number) => (Math.abs(s - 1) > 0.005 ? ` (1 frame px = ${Math.round(s * 100) / 100} ${t.unit} on the brief's viewport)` : "");
  const undersized = new Set(list.filter((x) => Math.min(dims(x).w, dims(x).h) < (web ? A11Y.spacingCircle : t.minimum) - 1e-6));

  for (const x of list) {
    const d = dims(x);
    const small = Math.min(d.w, d.h);
    if (web && rc.aaa) {
      if (small < t.recommended - 1e-6) {
        push(x.l.node, "target_size", "warning",
          `is ${size(d)}${scaleNote(d.s)}, under 44 × 44: the brief asks for AAA, and WCAG 2.2 SC 2.5.5 sets 44 × 44 with no spacing exception. ` +
            "Grow it (figma_resize_nodes) or its padding.");
      }
      continue;
    }
    if (web) {
      if (undersized.has(x)) {
        // The circle, in frame px: 24 CSS px across, centred on the box.
        const r = A11Y.spacingCircle / 2 / d.s;
        const cx = x.l.box.x + x.l.box.width / 2;
        const cy = x.l.box.y + x.l.box.height / 2;
        const hit = list.find((o) => {
          if (o === x || nested(o, x)) return false;
          if (circleHits(cx, cy, r, o.l.box)) return true;
          if (!undersized.has(o)) return false;
          const ox = o.l.box.x + o.l.box.width / 2 - cx;
          const oy = o.l.box.y + o.l.box.height / 2 - cy;
          const ro = A11Y.spacingCircle / 2 / rc.scale(o.l.node);
          return ox * ox + oy * oy < (r + ro) * (r + ro) - 1e-6;
        });
        if (hit) {
          push(x.l.node, "target_size", "warning",
            `is ${size(d)}${scaleNote(d.s)}, under the 24 × 24 minimum of WCAG 2.2 SC 2.5.8, and too close to another target for its ` +
              "spacing exception (target_spacing). Grow it to 24 × 24 (figma_resize_nodes, or padding around the icon).");
          push(x.l.node, "target_spacing", "warning",
            `a 24 CSS px circle centred on it crosses "${hit.l.node.name}" (${hit.l.node.id}): an undersized target passes WCAG 2.2 SC 2.5.8 ` +
              "only when that circle touches no other target. Grow it to 24 × 24, or move the two apart.");
        } else {
          push(x.l.node, "target_size", "info",
            `is ${size(d)}${scaleNote(d.s)}, under 24 × 24, but passes WCAG 2.2 SC 2.5.8 by its spacing: a 24 px circle on it touches no ` +
              "other target. 44 × 44 (SC 2.5.5, AAA) is the comfortable size; keep the spacing if it stays small.");
        }
      } else if (small < t.recommended - 1e-6) {
        push(x.l.node, "target_size", "info",
          `is ${size(d)}${scaleNote(d.s)}: it passes the 24 × 24 minimum (WCAG 2.2 SC 2.5.8) but not 44 × 44 (SC 2.5.5, AAA). ` +
            "Grow it where space allows (figma_resize_nodes or padding).");
      }
      continue;
    }
    if (small < t.minimum - 1e-6) {
      push(x.l.node, "target_size", "warning",
        rc.platform === "ios"
          ? `is ${size(d)}${scaleNote(d.s)}, under iOS's 28 × 28 pt minimum (Apple HIG; 44 × 44 pt by default). Grow its frame (figma_resize_nodes) or its padding.`
          : `is ${size(d)}${scaleNote(d.s)}, under Android's 48 × 48 dp touch target. Grow it, or pad a smaller icon out to 48 dp (figma_resize_nodes or padding).`);
    } else if (small < t.recommended - 1e-6) {
      push(x.l.node, "target_size", "info",
        `is ${size(d)}${scaleNote(d.s)}, under iOS's 44 × 44 pt default (Apple HIG); 28 pt is the floor. Grow it where space allows.`);
    }
  }

  // Android: 8 dp between targets (Google Accessibility Help). iOS gives no number.
  if (rc.platform !== "android") return;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (nested(a, b)) continue;
      const g = gapBetween(a.l.box, b.l.box) * rc.scale(b.l.node);
      if (g >= t.spacing - 1e-6) continue;
      push(b.l.node, "target_spacing", "info",
        `sits ${r1(g)} dp from "${a.l.node.name}" (${a.l.node.id}); Android asks 8 dp or more between touch targets (Google Accessibility Help). Move them apart.`);
    }
  }
}

/**
 * focus_state_missing (WCAG 2.2 SC 2.4.7: a visible focus indicator) and
 * focus_indicator_weak (SC 2.4.13: a 2 CSS px ring at 3:1 against the
 * unfocused pixels). Judged per interactive component set: the variants are
 * where a focus state lives.
 */
function focusStates(c: Census, ix: Index, rc: RoleContext, push: Push): void {
  for (const cs of controlSets(c, ix, rc)) {
    const groups = variantGroups(cs.set);
    if (!Object.keys(groups).length) continue;
    const listing = Object.keys(groups).map((k) => `${k} = ${groups[k]!.join(", ")}`).join("; ");
    const used = cs.usedBy ? ` (used here by "${cs.usedBy.name}", ${cs.usedBy.id})` : "";
    const hasFocus = Object.keys(groups).some((k) => groups[k]!.some((v) => /focus|keyboard/i.test(v))) || setStates(groups).has("focus");
    if (!hasFocus) {
      push(cs.set, "focus_state_missing", pointerPlatform(rc.platform) ? "warning" : "info",
        `is a ${cs.type} with no focus variant${used} (${listing}): a keyboard user cannot see where they are. WCAG 2.2 SC 2.4.7 asks a ` +
          "visible focus indicator — add a Focus variant with a 2 px ring at 3:1 against the default (SC 2.4.13)" +
          (pointerPlatform(rc.platform) ? "." : `; info on ${PLATFORM_NAME[rc.platform]}, where touch comes first but keyboards and switch control still focus.`));
      continue;
    }
    const focus = variantsOf(cs.set).find((v) => variantStates(variantPropsOf(v)).has("focus") || Object.keys(variantPropsOf(v)).some((k) => /focus|keyboard/i.test(variantPropsOf(v)[k]!)));
    if (!focus) continue;
    const base = variantFor(cs.set, "default", variantPropsOf(focus));
    if (!base) continue;
    const min = A11Y.focusThickness / rc.scale(focus);
    const ring = ringOf(focus, min);
    const before = ringOf(base, min);
    if (!ring || (before && hex(before.color) === hex(ring.color) && Math.abs(before.weight - ring.weight) < 0.01)) {
      push(focus, "focus_indicator_weak", "info",
        `the focus variant adds no stroke, outline or effect 2 px thick or more over "${base.name}": the indicator may be too slight to ` +
          "see (WCAG 2.2 SC 2.4.13, AAA: a 2 CSS px perimeter at 3:1). Add a 2 px ring in a colour 3:1 against the default.");
      continue;
    }
    // The default variant's pixels where the ring is: its stroke there, else its fill.
    const under = solidOf(field(base, "strokes")) ?? solidOf(field(base, "fills"));
    if (!under) continue;
    const ratio = contrastRatio(ring.color, under.color);
    if (ratio >= A11Y.focusContrast) continue;
    push(focus, "focus_indicator_weak", "info",
      `its focus indicator (${ring.how}, ${hex(ring.color)}) is ${ratio.toFixed(2)}:1 against the default variant's ${hex(under.color)} there; ` +
        "WCAG 2.2 SC 2.4.13 (AAA) asks 3:1 between the focused and unfocused pixels. Darken or recolour the ring.");
  }
}

/**
 * weak_boundary (WCAG 2.2 SC 1.4.11): an input's edge against what is behind
 * it — its stroke, else its fill; an input that paints neither is judged by
 * the child that draws its box or its underline. Inactive ones are exempt.
 */
function boundaries(c: Census, targets: Control[], push: Push): void {
  type Seen = { seen: Rgb; ratio: number; what: string };
  for (const x of targets) {
    if ((x.type !== "input" && x.type !== "toggle") || x.l.inactive) continue;
    const behind = c.backdrop(x.l.node);
    if (!behind) continue;
    const alpha = num(x.l.a.opacity, 1);
    const judge = (p: { color: Rgb; opacity: number } | null, what: string): Seen | null => {
      if (!p) return null;
      const seen = mix(p.color, behind, p.opacity * alpha);
      return { seen, ratio: contrastRatio(seen, behind), what };
    };
    let edges = [judge(x.l.strokeSolid, "stroke"), judge(x.l.solid, "fill")].filter((v): v is Seen => !!v);
    if (!edges.length) {
      // The box or the underline is drawn by a child as wide as the field.
      for (const k of childrenOf(x.l.node) ?? []) {
        const kb = boxOf(k);
        if (!kb || field(k, "visible") === false || kb.width < 0.5 * x.l.box.width) continue;
        const line = kb.height <= 3;
        if (line && bottom(kb) < bottom(x.l.box) - 4) continue; // a rule mid-field is not its edge
        edges = [judge(solidOf(field(k, "strokes")), line ? "underline" : `"${k.name}" stroke`), judge(solidOf(field(k, "fills")), line ? "underline" : `"${k.name}" fill`)]
          .filter((v): v is Seen => !!v);
        if (edges.length) break;
      }
    }
    const best = edges.sort((p, q) => q.ratio - p.ratio)[0];
    if (!best || best.ratio >= A11Y.boundaryContrast) continue;
    const what = best.what;
    push(x.l.node, "weak_boundary", "warning",
      `its edge is ${best.ratio.toFixed(2)}:1 against what is behind it (${hex(best.seen)} ${what} on ${hex(behind)}); the boundary that ` +
        `shows where a${x.type === "input" ? "n input" : " control"} is needs 3:1 (WCAG 2.2 SC 1.4.11). Darken its stroke (figma_set_strokes), ` +
        "or give it a fill that stands off the ground.");
  }
}

/** error_colour_only (WCAG 2.2 SC 1.4.1 and SC 3.3.1): an input's error variant that changes paint and says nothing new in text. */
function errorsInColourOnly(c: Census, ix: Index, rc: RoleContext, push: Push): void {
  for (const cs of controlSets(c, ix, rc)) {
    if (cs.type !== "input") continue;
    for (const v of variantsOf(cs.set)) {
      const props = variantPropsOf(v);
      if (!variantStates(props).has("error")) continue;
      const base = variantFor(cs.set, "default", props);
      if (!base || base === v) continue;
      const mine = textsOf(v);
      const theirs = textsOf(base);
      if (mine.join("\n") !== theirs.join("\n")) continue;
      push(v, "error_colour_only", "warning",
        `shows the same text as "${base.name}"${mine.length ? ` (${mine.slice(0, 3).map((s) => `"${s.slice(0, 30)}"`).join(", ")})` : ""} — only its ` +
          "colours change, so a user who cannot tell the colours apart is not told there is an error, nor what it is (WCAG 2.2 SC 1.4.1, " +
          "SC 3.3.1). Add the error message in text to this variant, next to the field.");
    }
  }
}

/** input_unlabelled (WCAG 2.2 SC 3.3.2): a text input with no label beside it and none inside but its placeholder. */
function labels(ix: Index, targets: Control[], push: Push): void {
  for (const x of targets) {
    if (x.type !== "input" || x.l.node.type !== "INSTANCE") continue;
    const inside = ix.texts.filter((t) => ix.isAncestor(x.l.node, t.node));
    if (inside.length >= 2) continue; // a label and a value or placeholder
    const parent = x.l.node.parent ? ix.byNode.get(x.l.node.parent) : undefined;
    const gap = Math.max(A11Y.labelGap, num(parent?.a.itemSpacing, 0));
    const box = x.l.box;
    const labelled = ix.texts.some((t) => {
      if (ix.isAncestor(x.l.node, t.node)) return false;
      const g = t.text!.glyphs;
      const above = bottom(g) <= box.y + 1 && box.y - bottom(g) <= gap && Math.min(right(g), right(box)) - Math.max(g.x, box.x) > 0;
      const left = right(g) <= box.x + 1 && box.x - right(g) <= gap && Math.min(bottom(g), bottom(box)) - Math.max(g.y, box.y) > 0;
      return above || left;
    });
    if (labelled) continue;
    const only = inside[0]?.text!.chars.trim();
    const holds = only ? `only "${only.slice(0, 40)}", a placeholder that goes as the user types` : "no text at all";
    push(x.l.node, "input_unlabelled", "info",
      `has no visible label: no text within ${gap} px above or left of it, and inside it ${holds}. Add a label above it ` +
        "(WCAG 2.2 SC 3.3.2: labels or instructions where input is asked).");
  }
}

/**
 * text_fixed_box (WCAG 2.2 SC 1.4.4 and 1.4.12): text in a control set in a
 * fixed box or cut with an ellipsis is clipped when a user enlarges it or
 * re-spaces it. Line height alone is never judged: SC 1.4.12 is about
 * surviving a user's override, not the design's own leading.
 */
function fixedTextBoxes(ix: Index, controls: Control[], rc: RoleContext, push: Push): void {
  const byNode = new Map(controls.map((x) => [x.l.node, x]));
  const seen = new Set<string>();
  for (const t of ix.texts) {
    const resize = t.a.textAutoResize;
    const cut = t.a.textTruncation === "ENDING";
    if (resize !== "NONE" && resize !== "TRUNCATE" && !cut) continue;
    let owner: Control | undefined;
    for (let p = t.node.parent; p && !owner; p = p.parent) owner = byNode.get(p);
    if (!owner) continue;
    // An instance's text box is its component's: once per component, not per copy.
    const main = owner.l.node.type === "INSTANCE" ? rc.mains.get(owner.l.node) : undefined;
    const key = `${main?.id ?? owner.l.node.id}|${t.node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(t.node, "text_fixed_box", "info",
      `sits in the ${owner.type} "${owner.l.node.name}" ${cut ? "and is cut with an ellipsis (textTruncation ENDING)" : "in a fixed box (textAutoResize NONE)"}: ` +
        "text a user enlarges to 200% (WCAG 2.2 SC 1.4.4) or re-spaces (SC 1.4.12) is clipped. Let it hug or wrap " +
        "(figma_set_text_properties autoResize \"hug\" or \"wrap\", truncate false) and the control hug the text.");
  }
}

/** safe_area_platform (Apple HIG Layout; Android edge-to-edge since API 35): a control inside the inset band the brief records. */
function safeAreas(targets: Control[], rc: RoleContext, push: Push): void {
  if (rc.platform !== "ios" && rc.platform !== "android") return;
  const insets = (rc.brief?.details as Any | undefined)?.insets as Any | undefined;
  if (!insets || typeof insets !== "object") return;
  const top = num(insets.top, 0);
  const low = num(insets.bottom, 0);
  if (top <= 0 && low <= 0) return;
  const unit = A11Y.targets[rc.platform].unit;
  const source = typeof insets.source === "string" && insets.source.trim() ? `, from ${insets.source.trim()}` : "";
  const covers = rc.platform === "ios"
    ? "the status bar, the Dynamic Island or the home indicator cover (Apple HIG Layout: keep controls in the safe area)"
    : "the system bars cover once the app draws edge to edge (Android 15, API 35)";
  for (const x of targets) {
    const screen = rc.screenOf(x.l.node);
    if (!screen || screen.node.type === "COMPONENT" || screen.node.type === "COMPONENT_SET" || screen.node === x.l.node) continue;
    const b = x.l.box;
    const intoTop = top > 0 ? screen.box.y + top / screen.scale - b.y : 0;
    const intoBottom = low > 0 ? bottom(b) - (bottom(screen.box) - low / screen.scale) : 0;
    if (intoTop > 0.5) {
      push(x.l.node, "safe_area_platform", "info",
        `reaches ${r1(intoTop * screen.scale)} ${unit} into the top inset (${top} ${unit}${source}) that ${covers}. Move it below the inset.`);
    } else if (intoBottom > 0.5) {
      push(x.l.node, "safe_area_platform", "info",
        `reaches ${r1(intoBottom * screen.scale)} ${unit} into the bottom inset (${low} ${unit}${source}) that ${covers}. Move it above the inset.`);
    }
  }
}
