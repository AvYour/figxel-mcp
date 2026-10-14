// FigJam's colour palettes, per node type, by name.
//
// FigJam has no one palette: a "blue" sticky is #A8DAFF, a "blue" connector
// #3DADFF and a "red" table #F24822 against a shape's #FF7556, so a name is
// always resolved for the node type it lands on [C-156]. A colour counts as a
// palette swatch in FigJam's UI only when its channels match exactly, which is
// why every name resolves to its hex and goes through parseColor's hex/255
// (figjam-colors.md:24-26) — never through rounded decimals.
//
// Sections have NO names here: two official sources disagree on the section
// swatches [C-144], so a section takes a hex until a live run settles them.
//
// Pure apart from write.ts's parsers, so the server tests and check.ts can
// import it as it is.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { FIGJAM_TEXT_DEFAULT } from "../../shared/figjam.js";
import { nearest, parseColor, type SolidPaint } from "../write.js";

/** The node types whose colour a name can select. */
export type PaletteKind = "sticky" | "connector" | "shape" | "table" | "text" | "section";

/** A shape preset sets fill, stroke and text together, or the shape looks off-palette (create-shape-with-text.md:87-161). */
export interface ShapePreset {
  fill: string;
  stroke: string;
  text: string;
}

/** A table preset: the fill, and the text colour that reads on it (create-table.md:165-211). */
export interface TablePreset {
  fill: string;
  text: string;
}

const WHITE = "#FFFFFF";
const CHARCOAL = FIGJAM_TEXT_DEFAULT;

/** create-sticky.md:59-70 — 10 colours. */
export const STICKY_PALETTE: Readonly<Record<string, string>> = {
  white: "#FFFFFF",
  gray: "#E6E6E6",
  green: "#B3EFBD",
  teal: "#B3F4EF",
  blue: "#A8DAFF",
  violet: "#D3BDFF",
  pink: "#FFA8DB",
  red: "#FFB8A8",
  orange: "#FFD3A8",
  yellow: "#FFE299",
};

/** create-connector.md:145-159 — 13 stroke colours. */
export const CONNECTOR_PALETTE: Readonly<Record<string, string>> = {
  black: "#1E1E1E",
  "dark-gray": "#757575",
  gray: "#B3B3B3",
  "light-gray": "#D9D9D9",
  green: "#66D575",
  teal: "#5AD8CC",
  blue: "#3DADFF",
  violet: "#874FFF",
  pink: "#F849C1",
  red: "#FF7556",
  orange: "#FF9E42",
  yellow: "#FFC943",
  white: "#FFFFFF",
};

/** create-shape-with-text.md:106-131 — 21 coordinated presets. */
export const SHAPE_PRESETS: Readonly<Record<string, ShapePreset>> = {
  black: { fill: "#1E1E1E", stroke: "#B3B3B3", text: WHITE },
  "dark-gray": { fill: "#757575", stroke: "#5E5E5E", text: WHITE },
  green: { fill: "#66D575", stroke: "#3E9B4B", text: WHITE },
  teal: { fill: "#5AD8CC", stroke: "#369E94", text: WHITE },
  blue: { fill: "#3DADFF", stroke: "#007AD2", text: WHITE },
  violet: { fill: "#874FFF", stroke: "#5427B4", text: WHITE },
  pink: { fill: "#F849C1", stroke: "#B42487", text: WHITE },
  red: { fill: "#FF7556", stroke: "#DC3009", text: WHITE },
  orange: { fill: "#FF9E42", stroke: "#EB7500", text: WHITE },
  gray: { fill: "#B3B3B3", stroke: "#8F8F8F", text: CHARCOAL },
  "light-gray": { fill: "#D9D9D9", stroke: "#B3B3B3", text: CHARCOAL },
  "light-green": { fill: "#CDF4D3", stroke: "#66D575", text: CHARCOAL },
  "light-teal": { fill: "#C6FAF6", stroke: "#5AD8CC", text: CHARCOAL },
  "light-blue": { fill: "#C2E5FF", stroke: "#3DADFF", text: CHARCOAL },
  "light-violet": { fill: "#DCCCFF", stroke: "#874FFF", text: CHARCOAL },
  "light-pink": { fill: "#FFC2EC", stroke: "#F849C1", text: CHARCOAL },
  "light-red": { fill: "#FFCDC2", stroke: "#FF7556", text: CHARCOAL },
  "light-orange": { fill: "#FFE0C2", stroke: "#FF9E42", text: CHARCOAL },
  yellow: { fill: "#FFC943", stroke: "#E8A302", text: CHARCOAL },
  "light-yellow": { fill: "#FFECBD", stroke: "#FFC943", text: CHARCOAL },
  white: { fill: "#FFFFFF", stroke: "#B3B3B3", text: CHARCOAL },
};

/** create-table.md:186-211 — 21 presets; its red (#F24822) and light red differ from the shape palette's. */
export const TABLE_PRESETS: Readonly<Record<string, TablePreset>> = {
  black: { fill: "#1E1E1E", text: WHITE },
  "dark-gray": { fill: "#757575", text: WHITE },
  green: { fill: "#66D575", text: WHITE },
  teal: { fill: "#5AD8CC", text: WHITE },
  blue: { fill: "#3DADFF", text: WHITE },
  violet: { fill: "#874FFF", text: WHITE },
  pink: { fill: "#F849C1", text: WHITE },
  red: { fill: "#F24822", text: WHITE },
  orange: { fill: "#FF9E42", text: WHITE },
  gray: { fill: "#B3B3B3", text: CHARCOAL },
  "light-gray": { fill: "#D9D9D9", text: CHARCOAL },
  "light-green": { fill: "#CDF4D3", text: CHARCOAL },
  "light-teal": { fill: "#C6FAF6", text: CHARCOAL },
  "light-blue": { fill: "#C2E5FF", text: CHARCOAL },
  "light-violet": { fill: "#DCCCFF", text: CHARCOAL },
  "light-pink": { fill: "#FFC2EC", text: CHARCOAL },
  "light-red": { fill: "#FFC7C2", text: CHARCOAL },
  "light-orange": { fill: "#FFE0C2", text: CHARCOAL },
  yellow: { fill: "#FFC943", text: CHARCOAL },
  "light-yellow": { fill: "#FFECBD", text: CHARCOAL },
  white: { fill: "#FFFFFF", text: CHARCOAL },
};

/** create-text.md:118-141 — 21 text colours; its violet is #9747FF, not the shape violet. */
export const TEXT_PALETTE: Readonly<Record<string, string>> = {
  white: "#FFFFFF",
  black: "#1E1E1E",
  "dark-gray": "#757575",
  gray: "#B3B3B3",
  "light-gray": "#D9D9D9",
  green: "#66D575",
  "light-green": "#CDF4D3",
  teal: "#5AD8CC",
  "light-teal": "#C6FAF6",
  blue: "#3DADFF",
  "light-blue": "#C2E5FF",
  violet: "#9747FF",
  "light-violet": "#E4CCFF",
  pink: "#F849C1",
  "light-pink": "#FFC2EC",
  red: "#FF7556",
  "light-red": "#FFCDC2",
  orange: "#FF9E42",
  "light-orange": "#FFE0C2",
  yellow: "#FFC943",
  "light-yellow": "#FFECBD",
};

const FILLS: Record<PaletteKind, Readonly<Record<string, string>>> = {
  sticky: STICKY_PALETTE,
  connector: CONNECTOR_PALETTE,
  shape: Object.fromEntries(Object.entries(SHAPE_PRESETS).map(([k, v]) => [k, v.fill])),
  table: Object.fromEntries(Object.entries(TABLE_PRESETS).map(([k, v]) => [k, v.fill])),
  text: TEXT_PALETTE,
  // Hex only until the live run settles which swatches FigJam offers [C-144].
  section: {},
};

const LABEL: Record<PaletteKind, string> = {
  sticky: "sticky",
  connector: "connector",
  shape: "shape",
  table: "table",
  text: "text",
  section: "section",
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** "Light Blue", "lightBlue", "light_blue", "light-grey" → "light-blue" / "light-gray". */
export function paletteKey(input: string): string {
  return input
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/grey/g, "gray");
}

/** The names a `kind` takes, in palette order. */
export function paletteNames(kind: PaletteKind): string[] {
  return Object.keys(FILLS[kind]);
}

/** The hexes of a `kind`'s palette, upper case — for an audit that flags off-palette colours. */
export function paletteHexes(kind: PaletteKind): string[] {
  return Object.values(FILLS[kind]);
}

/** The palette name of `hex` for `kind`, or undefined when it is a custom colour. */
export function paletteNameOf(kind: PaletteKind, hex: string): string | undefined {
  const want = hex.replace("#", "").toUpperCase();
  return Object.entries(FILLS[kind]).find(([, h]) => h.replace("#", "") === want)?.[0];
}

/** True when `input` names a colour in ANY palette — so a typo is refused once, not per node. */
export function isKnownColorName(input: string): boolean {
  const key = paletteKey(input);
  return (Object.keys(FILLS) as PaletteKind[]).some((k) => key in FILLS[k]);
}

export interface ResolvedColor {
  paint: SolidPaint;
  /** "#RRGGBB" as resolved. */
  hex: string;
  /** The palette name, when one was given. */
  name?: string;
}

function refuseColor(kind: PaletteKind, input: unknown, field: string): never {
  const names = paletteNames(kind);
  const shown = typeof input === "string" ? JSON.stringify(input) : String(input);
  throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: ${shown} is not a ${LABEL[kind]} colour.`, {
    hint: names.length
      ? `Nearest ${LABEL[kind]} colours: ${nearest(typeof input === "string" ? paletteKey(input) : "", names).join(", ")} — or a hex like "${FILLS[kind][names[0]!]}".`
      : `A ${LABEL[kind]} takes a hex such as "#F5FBFF" for now: its swatch names are not confirmed yet [C-144].`,
  });
}

/**
 * A colour for `kind`: a palette name (any spelling paletteKey accepts) or a
 * hex. A name another kind has but this one lacks is refused with the nearest
 * names of THIS kind, so "light-blue" on a sticky says which blues a sticky has.
 */
export function resolveColor(kind: PaletteKind, input: unknown, field: string): ResolvedColor {
  if (typeof input !== "string" || !input.trim()) refuseColor(kind, input, field);
  const raw = input.trim();
  if (HEX.test(raw)) {
    const paint = parseColor(raw, field);
    return { paint, hex: hexOf(paint) };
  }
  const key = paletteKey(raw);
  const hex = FILLS[kind][key];
  if (!hex) refuseColor(kind, input, field);
  return { paint: parseColor(hex, field), hex, name: key };
}

/** A shape colour: a preset (fill, stroke and text) by name, or a hex for the fill alone. */
export function resolveShapeColor(input: unknown, field: string): { fill: SolidPaint; stroke?: SolidPaint; text?: SolidPaint; name?: string } {
  const c = resolveColor("shape", input, field);
  const preset = c.name ? SHAPE_PRESETS[c.name] : undefined;
  if (!preset) return { fill: c.paint };
  return { fill: c.paint, stroke: parseColor(preset.stroke, field), text: parseColor(preset.text, field), name: c.name };
}

/**
 * A table colour: a preset by name, or a hex. A hex gets the text colour that
 * reads on it — white on a dark fill, Charcoal on a light one — the rule the
 * presets follow (create-table.md:165-178).
 */
export function resolveTableColor(input: unknown, field: string): { fill: SolidPaint; text: SolidPaint; name?: string } {
  const c = resolveColor("table", input, field);
  const preset = c.name ? TABLE_PRESETS[c.name] : undefined;
  const text = preset ? preset.text : luminance(c.paint) < 0.5 ? WHITE : CHARCOAL;
  return { fill: c.paint, text: parseColor(text, field), ...(c.name ? { name: c.name } : {}) };
}

/** Relative luminance (WCAG), 0 black to 1 white. */
function luminance(p: SolidPaint): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(p.color.r) + 0.7152 * lin(p.color.g) + 0.0722 * lin(p.color.b);
}

const byte = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
/** "#RRGGBB" of a solid paint. */
export function hexOf(p: SolidPaint): string {
  return `#${byte(p.color.r)}${byte(p.color.g)}${byte(p.color.b)}`;
}
