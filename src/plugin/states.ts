// figma_check_layout's `states` audit: whether every interactive component has
// the states people will meet, and every screen the brief declares has its
// empty, loading and error frames (role spec §4.2). A designer who stops at
// the default state hands a developer half a component: the hover, focus,
// pressed and disabled looks get invented later, by someone else.
//
// States are read from a component set's variant properties
// (ComponentSetNode.variantGroupProperties, typings 1.141.0), normalised so
// "Enabled", "Rest" and "Default" are one state (a11y.ts STATE_WORDS). The set
// required follows Material's state layers (hover, focus, pressed) and its
// disabled tokens; screen states follow NN/g on empty states, response times
// and skeleton screens. Warnings only where a standard or the brief sets the
// requirement: focus on pointer platforms (WCAG 2.2 SC 2.4.7), an input's
// error state (SC 3.3.1), a default property name, a screen state the brief
// declares. Everything else is info until calibrated.

import { type ControlType, type RoleContext, controlSets, pointerPlatform, setStates, variantGroups, variantsOf, textsOf } from "./a11y.js";
import type { Census, Finding, Index } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Every threshold of the states audit: the states each kind of control needs, and the names that give a set away. */
export const STATES = {
  required: {
    button: ["default", "hover", "focus", "pressed", "disabled"],
    input: ["default", "focus", "filled", "error", "disabled"],
    toggle: ["default", "hover", "focus", "pressed", "disabled", "selected"],
  } as Readonly<Record<ControlType, readonly string[]>>,
  /** A button that submits also needs loading: a wait over about 1 s needs a sign (NN/g response-time limits). */
  submits: /\b(submit|save|send|pay|book|buy|order|checkout|check out|sign ?(in|up)|log ?in|register|confirm|continue|apply|create|publish|donate)\b/i,
  /** The property that carries a component's state. */
  property: /\b(state|status|interaction)s?\b/i,
  /** Figma's names for a property and a value nobody named yet. */
  defaultProperty: /^Property \d+$/i,
  defaultValue: /^Variant\d+$/i,
} as const;

/** Why each state matters, for the finding's text. */
const WHY: Readonly<Record<string, string>> = {
  default: "the resting look",
  hover: "pointer feedback",
  focus: "where the keyboard is (WCAG 2.2 SC 2.4.7)",
  pressed: "the response to a press",
  disabled: "when the action is not available",
  error: "what went wrong, in text (WCAG 2.2 SC 3.3.1)",
  filled: "a field with a value in it",
  loading: "that a submit is working (NN/g: a wait over 1 s needs a sign)",
  selected: "the on or checked value",
};

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Push = (n: NodeLike, name: string, kind: string, severity: Finding["severity"], detail: string) => void;

export function judgeStates(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, name, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name, detail });
  const interactive = controlSets(c, ix, rc);
  const judged = new Set<NodeLike>(interactive.map((x) => x.set));
  // Default names are a fault on any set, interactive or not.
  const sets = [...interactive.map((x) => x.set)];
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) if (l.node.type === "COMPONENT_SET" && !judged.has(l.node)) sets.push(l.node);
  for (const set of sets) defaultNames(set, push);
  for (const cs of interactive) missingStates(cs.set, cs.type, cs.usedBy, ix, rc, push);
  screenStates(rc, push);
  return out;
}

/** variant_default_name: a property still called "Property 1", or a value "Variant2" — nobody named what varies. */
function defaultNames(set: NodeLike, push: Push): void {
  const groups = variantGroups(set);
  const props = Object.keys(groups).filter((k) => STATES.defaultProperty.test(k.trim()));
  const values: string[] = [];
  for (const k of Object.keys(groups)) for (const v of groups[k]!) if (STATES.defaultValue.test(v.trim())) values.push(`${k} = ${v}`);
  if (!props.length && !values.length) return;
  const what = [
    ...(props.length ? [`the property ${props.map((p) => `"${p}"`).join(", ")}`] : []),
    ...(values.length ? [`the value${values.length > 1 ? "s" : ""} ${values.slice(0, 4).map((v) => `"${v}"`).join(", ")}`] : []),
  ];
  push(set, set.name, "variant_default_name", "warning",
    `still has Figma's default name for ${what.join(" and ")}: an instance's panel, a swap and the code that reads it cannot tell what it ` +
      "means. Name the property for what varies (State, Size, Type) and each value for what it is (figma_edit_component_property).");
}

/**
 * state_property_missing and state_missing, for one interactive set. The
 * states come from every property's values and from boolean properties named
 * for a state ("Disabled=True"); a set with none of them has no state
 * property to fill in, which is the finding, not a list of every state.
 */
function missingStates(set: NodeLike, type: ControlType, usedBy: NodeLike | undefined, ix: Index, rc: RoleContext, push: Push): void {
  const groups = variantGroups(set);
  const keys = Object.keys(groups);
  if (!keys.length) return;
  const found = setStates(groups);
  const used = usedBy ? ` (used here by "${usedBy.name}", ${usedBy.id})` : "";
  const listing = keys.map((k) => `${k} = ${groups[k]!.join(", ")}`).join("; ");
  if (!keys.some((k) => STATES.property.test(k)) && found.size <= 1) {
    push(set, set.name, "state_property_missing", "info",
      `is a ${type}${used} with variants but no state property (${listing}): its hover, focus, pressed and disabled looks cannot be ` +
        "picked or checked. Add a State property with a variant per state (figma_combine_as_variants).");
    return;
  }
  const required = [...STATES.required[type]];
  if (type === "button" && submits(set, usedBy, ix)) required.push("loading");
  const pointer = pointerPlatform(rc.platform);
  const warn: string[] = [];
  const info: string[] = [];
  for (const s of required) {
    if (found.has(s)) continue;
    if (s === "hover" && !pointer) continue; // no pointer, no hover
    // When a11y runs too, a missing focus state is its focus_state_missing: once is enough.
    if (s === "focus" && rc.audits.has("a11y")) continue;
    if ((s === "focus" && pointer) || (s === "error" && type === "input")) warn.push(s);
    else info.push(s);
  }
  const say = (list: string[]) => list.map((s) => `${title(s)} (${WHY[s]})`).join(", ");
  const has = found.size ? `has ${[...found].map(title).join(", ")}` : `has ${listing}`;
  if (warn.length) {
    push(set, set.name, "state_missing", "warning",
      `is a ${type}${used} that ${has}; it lacks ${say(warn)}. Add ${warn.length > 1 ? "those variants" : "that variant"} (figma_combine_as_variants).`);
  }
  if (info.length) {
    push(set, set.name, "state_missing", "info",
      `is a ${type}${used} that ${has}; it lacks ${say(info)}. Add them, or say why this ${type} never shows them.`);
  }
}

/** Whether a button set submits something: its name, the instance's name, or a label in it or its variants says so. */
function submits(set: NodeLike, usedBy: NodeLike | undefined, ix: Index): boolean {
  if (STATES.submits.test(set.name) || (usedBy && STATES.submits.test(usedBy.name))) return true;
  if (usedBy && ix.texts.some((t) => ix.isAncestor(usedBy, t.node) && STATES.submits.test(t.text!.chars))) return true;
  const first = variantsOf(set)[0];
  return !!first && textsOf(first).some((s) => STATES.submits.test(s));
}

/** "Bench booking / 01 Slots / Empty" as segments: ["bench booking", "01 slots", "empty"]. */
const segments = (name: string) => name.split("/").map((s) => s.trim().toLowerCase().replace(/\s+/g, " "));
/** "01 Slots" or "1. Slots" is the screen "Slots". */
const screenName = (seg: string) => seg.replace(/^\d+[\s.)\-:]*/, "");

/**
 * Whether a frame's name draws `state` of `screen`. The skills declare a
 * screen by its full frame name ("Booking / 02 Slots") and name its state
 * frames "<screen name> / <State>", so the frame's name equals or ends with
 * that (case-insensitive, at a "/"). A short screen name ("Slots") still
 * matches the segment before the state, a step number set aside.
 */
function draws(frame: string[], screen: string[], state: string): boolean {
  const want = [...screen, state];
  if (frame.length >= want.length && want.every((w, i) => frame[frame.length - want.length + i] === w)) return true;
  if (screen.length !== 1) return false;
  for (let i = 1; i < frame.length; i++) {
    if (frame[i] === state && screenName(frame[i - 1]!) === screenName(screen[0]!)) return true;
  }
  return false;
}

/**
 * screen_state_missing: each state `details.screens` declares has a frame
 * named `<screen> / <state>` among the deliverables or the page's top-level
 * frames. Reported on the brief, once, so the same finding from each
 * deliverable's check reads as one.
 */
function screenStates(rc: RoleContext, push: Push): void {
  const brief = rc.brief;
  const screens = (brief?.details as Any | undefined)?.screens;
  if (!brief || !Array.isArray(screens)) return;
  const names = rc.frames.map((f) => segments(f.name));
  for (const s of screens as Any[]) {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name.trim() || !Array.isArray(s.states)) continue;
    const screen = segments(s.name);
    const states = (s.states as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    const missing = states.filter((state) => {
      const want = state.trim().toLowerCase().replace(/\s+/g, " ");
      return !names.some((frame) => draws(frame, screen, want));
    });
    if (!missing.length) continue;
    const name = s.name.trim();
    push({ id: brief.id, name: brief.title, type: "FRAME" }, `brief "${brief.title}"`, "screen_state_missing", "warning",
      `declares the screen "${name}" with the state${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")}, and no top-level ` +
        `frame is named "${name} / ${title(missing[0]!.trim())}"${missing.length > 1 ? " and so on" : ""}. Build each as its own frame named ` +
        `"${name} / <State>" (empty, loading and error screens: NN/g), or take it out of details.screens (figma_set_brief).`);
  }
}
