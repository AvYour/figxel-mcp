// Motion keyframe fields as one string each, so a track can travel in a tool's
// params and results without a nested union (tools.md § Conventions: unions
// travel as one string).
//
//   "OPACITY"            a node property (KeyframePropertyFieldName)
//   "fill:0"             the paint at that index of fills
//   "stroke:1"           the paint at that index of strokes
//   "effect:0:RADIUS"    one field (EffectKeyframeFieldName) of an effect
//   "fill:0:prop:<id>"   a paint or effect animated per component property
//   "effect:0:prop:<id>" (the `propertyId` form of KeyframeField)
//
// API per @figma/plugin-typings 1.141.0, Motion (Beta, subject to change)
// [C-115]: `manualKeyframeTracks` and `animations` are records keyed by
// property name, plus `fills` / `strokes` / `effects` maps keyed by index. A
// paint entry is either a track or `{ properties: { <propertyId>: track } }`;
// an effect entry maps field names to tracks, plus an optional `properties`.
//
// Values and easings travel the same way, so what figma_get_motion_context
// reads is exactly what figma_set_keyframes accepts:
//
//   value   "120" (FLOAT)   "#ff000080" (COLOR, #rgb / #rrggbb / #rrggbbaa)   "10,20" (VECTOR)
//   easing  "EASE_OUT"   "cubic:0.4,0,0.2,1"   "spring:0.3" (bounce 0–1)

import { BridgeError, ErrorCode } from "../shared/errors.js";

/** KeyframeField from the typings, restated: the tests compile without the plugin typings. */
export type KeyframeFieldLike =
  | { type: "PROPERTY"; name: string }
  | { type: "INDEXED_ITEM"; collection: "fills" | "strokes"; index: number }
  | { type: "INDEXED_ITEM"; collection: "effects"; index: number; field: string }
  | { type: "INDEXED_ITEM"; collection: "fills" | "strokes" | "effects"; index: number; propertyId: string };

const PREFIX = { fills: "fill", strokes: "stroke", effects: "effect" } as const;

export function fieldToString(field: KeyframeFieldLike): string {
  if (field.type === "PROPERTY") return field.name;
  const head = `${PREFIX[field.collection]}:${field.index}`;
  if ("propertyId" in field) return `${head}:prop:${field.propertyId}`;
  return "field" in field ? `${head}:${field.field}` : head;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Every field a node's `manualKeyframeTracks` (or `animations`) animates, as
 * strings. Nothing is skipped: a field left out here is a track that a
 * "remove them all" would silently leave behind.
 */
export function tracksToFieldNames(tracksOrAnimations: unknown): string[] {
  if (!isObject(tracksOrAnimations)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(tracksOrAnimations)) {
    if (value === undefined || value === null) continue;
    if (key !== "fills" && key !== "strokes" && key !== "effects") {
      out.push(fieldToString({ type: "PROPERTY", name: key }));
      continue;
    }
    if (!isObject(value)) continue;
    // Keyed by index: an object or a sparse array — Object.entries reads both in index order.
    for (const [i, entry] of Object.entries(value)) {
      const index = Number(i);
      if (!Number.isInteger(index) || !isObject(entry)) continue;
      const props = isObject(entry.properties) ? Object.keys(entry.properties) : [];
      if (key === "effects") {
        for (const [f, track] of Object.entries(entry)) {
          if (f !== "properties" && track !== undefined && track !== null) out.push(fieldToString({ type: "INDEXED_ITEM", collection: key, index, field: f }));
        }
      } else if (props.length === 0 || "keyframes" in entry || "tracks" in entry) {
        out.push(fieldToString({ type: "INDEXED_ITEM", collection: key, index }));
      }
      for (const propertyId of props) out.push(fieldToString({ type: "INDEXED_ITEM", collection: key, index, propertyId }));
    }
  }
  return out;
}

// ── fields from strings ──────────────────────────────────────────────────────

/** KeyframePropertyFieldName, typings 1.141.0 (plugin-api.d.ts 6084-6114) [C-115]. */
export const PROPERTY_FIELDS = [
  "CORNER_RADIUS", "STROKE_WEIGHT", "STACK_SPACING", "STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT",
  "STACK_PADDING_BOTTOM", "WIDTH", "HEIGHT", "RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
  "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "BORDER_TOP_WEIGHT", "BORDER_BOTTOM_WEIGHT",
  "BORDER_LEFT_WEIGHT", "BORDER_RIGHT_WEIGHT", "STACK_COUNTER_SPACING", "OPACITY", "GRID_ROW_GAP", "GRID_COLUMN_GAP",
  "TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY", "ROTATION", "SCALE_X", "SCALE_Y", "SCALE_XY", "PATH_TRIM_START",
  "PATH_TRIM_END",
] as const;

/** EffectKeyframeFieldName, typings 1.141.0 (plugin-api.d.ts 6118-6135) [C-115]. */
export const EFFECT_FIELDS = [
  "OFFSET_X", "OFFSET_Y", "RADIUS", "SPREAD", "COLOR", "REFRACTION_RADIUS", "SPECULAR_ANGLE", "SPECULAR_INTENSITY",
  "CHROMATIC_ABERRATION", "SPLAY", "REFRACTION_INTENSITY", "START_RADIUS", "NOISE_SIZE_X", "NOISE_SIZE_Y", "DENSITY",
  "EFFECT_OPACITY", "SECONDARY_COLOR",
] as const;

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});
const FIELD_HINT = 'A property name ("OPACITY", "TRANSLATION_X", …), "fill:<i>", "stroke:<i>" or "effect:<i>:<field>" (e.g. "effect:0:RADIUS").';
const COLLECTION = { fill: "fills", stroke: "strokes", effect: "effects" } as const;

/**
 * The KeyframeField a string names, checking its grammar only. Reads and
 * removals take this lenient path: a field Figma reports must round-trip even
 * when it is newer than the name lists above.
 */
export function fieldFromString(s: string, at = "field"): KeyframeFieldLike {
  const raw = s.trim();
  const m = /^(fill|stroke|effect):(\d+)(?::(.+))?$/i.exec(raw);
  if (!m) {
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(raw)) return { type: "PROPERTY", name: raw.toUpperCase() };
    throw invalid(`\`${at}\` "${s}" is not a keyframe field.`, FIELD_HINT);
  }
  const prefix = m[1]!.toLowerCase() as keyof typeof COLLECTION;
  const collection = COLLECTION[prefix];
  const index = Number(m[2]);
  const rest = m[3];
  if (rest !== undefined && /^prop:/i.test(rest)) {
    const propertyId = rest.slice("prop:".length);
    if (!propertyId) throw invalid(`\`${at}\` "${s}" names no property id after "prop:".`, FIELD_HINT);
    return { type: "INDEXED_ITEM", collection, index, propertyId };
  }
  if (collection === "effects") {
    if (rest === undefined) throw invalid(`\`${at}\` "${s}" names an effect but not which of its fields.`, `Use "effect:${index}:<field>", e.g. "effect:${index}:RADIUS".`);
    return { type: "INDEXED_ITEM", collection, index, field: rest.toUpperCase() };
  }
  // A paint is animated as one colour; there is no per-channel field.
  if (rest !== undefined) throw invalid(`\`${at}\` "${s}": a ${prefix} is animated as a whole colour.`, `Use "${prefix}:${index}".`);
  return { type: "INDEXED_ITEM", collection, index };
}

/** The same, with the names checked against the typings — the write path, so a typo is refused, not sent. */
export function parseField(s: string, at = "field"): KeyframeFieldLike {
  const field = fieldFromString(s, at);
  if (field.type === "PROPERTY" && !(PROPERTY_FIELDS as readonly string[]).includes(field.name)) {
    throw invalid(`\`${at}\` "${s}" is not an animatable property.`, `Properties: ${PROPERTY_FIELDS.join(", ")}. ${FIELD_HINT}`);
  }
  if ("field" in field && !(EFFECT_FIELDS as readonly string[]).includes(field.field)) {
    throw invalid(`\`${at}\` "${s}": "${field.field}" is not an effect field.`, `Effect fields: ${EFFECT_FIELDS.join(", ")}.`);
  }
  return field;
}

export type KeyframeValueType = "FLOAT" | "COLOR" | "VECTOR";

/**
 * The value type a field's keyframes carry: the XY pairs are vectors, a paint
 * and an effect's colours are colours, everything else is a number. A
 * component-property track (`…:prop:<id>`) has no knowable type, so it is
 * undefined and cannot be written.
 */
export function fieldValueType(field: KeyframeFieldLike): KeyframeValueType | undefined {
  if (field.type === "PROPERTY") return field.name === "TRANSLATION_XY" || field.name === "SCALE_XY" ? "VECTOR" : "FLOAT";
  if ("propertyId" in field) return undefined;
  if ("field" in field) return field.field === "COLOR" || field.field === "SECONDARY_COLOR" ? "COLOR" : "FLOAT";
  return "COLOR";
}

// ── values ───────────────────────────────────────────────────────────────────

export interface KeyframeValueLike {
  type: string;
  value: unknown;
}

/** Four decimals: enough for seconds and pixels, and it hides float32 noise (0.4000000059604645). */
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function finite(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function parseValue(s: string, type: KeyframeValueType, at = "value"): KeyframeValueLike {
  if (type === "FLOAT") {
    const n = finite(s);
    if (n === undefined) throw invalid(`\`${at}\` "${s}" is not a number; this field takes one, e.g. "120" or "0.5".`);
    return { type, value: n };
  }
  if (type === "VECTOR") {
    const parts = s.split(",").map(finite);
    if (parts.length !== 2 || parts.some((p) => p === undefined)) {
      throw invalid(`\`${at}\` "${s}" is not a vector; this field takes "x,y", e.g. "10,20".`);
    }
    return { type, value: { x: parts[0]!, y: parts[1]! } };
  }
  const m = HEX.exec(s.trim());
  if (!m) throw invalid(`\`${at}\` "${s}" is not a colour; this field takes "#rrggbb" or "#rrggbbaa".`);
  let h = m[1]!.toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { type, value: { r: ch(0), g: ch(2), b: ch(4), a: h.length === 8 ? ch(6) : 1 } };
}

function colorHex(c: unknown): string {
  if (!isObject(c)) return String(c);
  const h = (v: unknown) => Math.max(0, Math.min(255, Math.round((typeof v === "number" ? v : 0) * 255))).toString(16).padStart(2, "0");
  const a = typeof c.a === "number" ? c.a : 1;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.998 ? h(a) : ""}`;
}

/** A KeyframeValue in the string form parseValue reads; the shapes it cannot write still read as data. */
export function valueToString(v: unknown): string {
  if (!isObject(v)) return String(v);
  const value = v.value;
  switch (v.type) {
    case "FLOAT":
      return typeof value === "number" ? String(r4(value)) : String(value);
    case "COLOR":
      return colorHex(value);
    case "VECTOR":
      return isObject(value) && typeof value.x === "number" && typeof value.y === "number" ? `${r4(value.x)},${r4(value.y)}` : JSON.stringify(value);
    case "BOOL":
    case "TEXT_DATA":
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

// ── easing ───────────────────────────────────────────────────────────────────

/** MotionEasing's named types (plugin-api.d.ts 5847-5865), without the two CUSTOM_* forms that need numbers. */
export const EASING_NAMES = [
  "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK",
  "GENTLE", "QUICK", "BOUNCY", "SLOW", "HOLD",
] as const;

export interface MotionEasingLike {
  type: string;
  easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number };
  easingFunctionSpring?: { bounce: number };
}

const EASING_HINT = `${EASING_NAMES.join(", ")}, "cubic:x1,y1,x2,y2" or "spring:<bounce 0-1>".`;

export function parseEasing(s: string, at = "easing"): MotionEasingLike {
  const raw = s.trim();
  const upper = raw.toUpperCase();
  if ((EASING_NAMES as readonly string[]).includes(upper)) return { type: upper };
  // The CSS spelling is the one an agent reaches for, and Figma rejects it.
  if (upper === "EASE_IN_OUT" || upper === "EASE_IN_OUT_BACK") {
    const right = upper.replace("EASE_IN_OUT", "EASE_IN_AND_OUT");
    throw invalid(`\`${at}\` "${s}" is not Figma's name for it.`, `Use "${right}".`);
  }
  const cubic = /^cubic:(.*)$/i.exec(raw);
  if (cubic) {
    const n = cubic[1]!.split(",").map(finite);
    if (n.length !== 4 || n.some((v) => v === undefined)) throw invalid(`\`${at}\` "${s}" needs four numbers: "cubic:x1,y1,x2,y2".`);
    const [x1, y1, x2, y2] = n as number[];
    // As in CSS cubic-bezier(): the x values are times and must stay in 0–1.
    if (x1! < 0 || x1! > 1 || x2! < 0 || x2! > 1) throw invalid(`\`${at}\` "${s}": x1 and x2 must be between 0 and 1.`);
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: x1!, y1: y1!, x2: x2!, y2: y2! } };
  }
  const spring = /^spring:(.*)$/i.exec(raw);
  if (spring) {
    const b = finite(spring[1]!);
    if (b === undefined || b < 0 || b > 1) throw invalid(`\`${at}\` "${s}" needs a bounce between 0 and 1: "spring:0.3".`);
    return { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: b } };
  }
  throw invalid(`\`${at}\` "${s}" is not an easing.`, `Use ${EASING_HINT}`);
}

/** A MotionEasing (or a variable alias in its place) in the string form parseEasing reads. */
export function easingToString(e: unknown): string {
  if (!isObject(e) || typeof e.type !== "string") return "";
  if (e.type === "VARIABLE_ALIAS") return `var:${String(e.id)}`;
  const bez = e.easingFunctionCubicBezier;
  if (e.type === "CUSTOM_CUBIC_BEZIER" && isObject(bez)) {
    return `cubic:${[bez.x1, bez.y1, bez.x2, bez.y2].map((v) => (typeof v === "number" ? r4(v) : v)).join(",")}`;
  }
  const spring = e.easingFunctionSpring;
  if (e.type === "CUSTOM_SPRING" && isObject(spring) && typeof spring.bounce === "number") return `spring:${r4(spring.bounce)}`;
  return e.type;
}

// ── tracks as text ───────────────────────────────────────────────────────────

export interface KeyframeText {
  t: number;
  value: string;
  easing?: string;
}

export function keyframesToText(keyframes: unknown): KeyframeText[] {
  if (!Array.isArray(keyframes)) return [];
  return keyframes.filter(isObject).map((k: Record<string, unknown>) => {
    const easing = easingToString(k.easing);
    return { t: typeof k.timelinePosition === "number" ? r4(k.timelinePosition) : NaN, value: valueToString(k.value), ...(easing ? { easing } : {}) };
  });
}

/** The track (or binding) a field addresses inside `manualKeyframeTracks` or `animations`. */
export function bindingAt(tracks: unknown, field: KeyframeFieldLike): Record<string, unknown> | undefined {
  if (!isObject(tracks)) return undefined;
  if (field.type === "PROPERTY") {
    const v = tracks[field.name];
    return isObject(v) ? v : undefined;
  }
  const items = tracks[field.collection];
  const entry = isObject(items) ? items[field.index] : undefined;
  if (!isObject(entry)) return undefined;
  if ("propertyId" in field) {
    const props = entry.properties;
    const v = isObject(props) ? props[field.propertyId] : undefined;
    return isObject(v) ? v : undefined;
  }
  if ("field" in field) {
    const v = entry[field.field];
    return isObject(v) ? v : undefined;
  }
  return entry;
}

/** Every manual track of a node as `{ field, keyframes }` in the string forms figma_set_keyframes takes. */
export function manualTracksToText(tracks: unknown): Array<{ field: string; keyframes: KeyframeText[] }> {
  return tracksToFieldNames(tracks).map((field) => ({ field, keyframes: keyframesToText(bindingAt(tracks, fieldFromString(field))?.keyframes) }));
}

const sameKeyframes = (a: KeyframeText[], b: KeyframeText[]) =>
  a.length === b.length && a.every((k, i) => k.t === b[i]!.t && k.value === b[i]!.value);

const objects = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(isObject) : []);

/**
 * The tracks in `animations` that the manual tracks do not already account
 * for — the ones an animation style generated. The typings say `animations`
 * includes style keyframes (plugin-api.d.ts 6774); the official motion skill
 * says it reflects manual tracks only. Until that is measured [C-115], a
 * sub-track matching a manual one by id or by keyframes is dropped here, so
 * either answer reads correctly: no style tracks, or only the style tracks.
 */
export function styleTracksToText(animations: unknown, manual: unknown): Array<{ field: string; operation?: string; keyframes: KeyframeText[] }> {
  const out: Array<{ field: string; operation?: string; keyframes: KeyframeText[] }> = [];
  for (const name of tracksToFieldNames(animations)) {
    const field = fieldFromString(name);
    const binding = bindingAt(animations, field);
    const own = bindingAt(manual, field);
    const ownKeyframes = keyframesToText(own?.keyframes);
    const ownIds = new Set(objects(own?.keyframes).map((k) => k.id));
    for (const track of objects(binding?.tracks)) {
      const keyframes = keyframesToText(track.keyframes);
      const ids = objects(track.keyframes).map((k) => k.id);
      const isManual =
        (own !== undefined && track.id !== undefined && track.id === own.id) ||
        (ids.length > 0 && ids.every((id) => id !== undefined && ownIds.has(id))) ||
        (own !== undefined && sameKeyframes(keyframes, ownKeyframes));
      if (isManual) continue;
      out.push({ field: name, ...(typeof track.keyframeOperation === "string" ? { operation: track.keyframeOperation } : {}), keyframes });
    }
  }
  return out;
}
