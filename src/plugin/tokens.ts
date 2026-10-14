// Design tokens as text, and the rules a token obeys before it is written.
//
// One dialect for reads and writes: a variable value read here ("#1a2b3c80",
// "16", "true", "alias:color/blue/500") is exactly what figma_create_variables
// and figma_set_variable_value accept — strings, as every write schema takes
// them — so a token copied out of a read goes straight back into a write
// without translation. Style values are one line in the design-context
// dialect (dialect.ts), so figma_get_styles and figma_get_design_context
// describe a paint, and a layout grid, the same way.
//
// API per @figma/plugin-typings 1.141.0: Variable.name, description,
// hiddenFromPublishing and scopes are writable; codeSyntax is read-only and
// set through setVariableCodeSyntax / removeVariableCodeSyntax [C-106]. Which
// scopes a type takes is Figma's own table, not a guess: a scope the type
// cannot take is refused here, before the variable exists [C-106].

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { effectText, layoutGridText, num, paintText, r2 } from "./dialect.js";

type Any = Record<string, unknown>;

// ── the variables API, narrowed ─────────────────────────────────────────────

export interface ModeRecord {
  modeId: string;
  name: string;
}

export interface CollectionRecord {
  id: string;
  name: string;
  key?: string;
  remote?: boolean;
  hiddenFromPublishing?: boolean;
  isExtension?: boolean;
  defaultModeId?: string;
  variableIds?: readonly string[];
  modes: ReadonlyArray<ModeRecord>;
  addMode?(name: string): string;
  renameMode?(modeId: string, name: string): void;
  removeMode?(modeId: string): void;
}

export interface VariableRecord {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  key?: string;
  remote?: boolean;
  description?: string;
  hiddenFromPublishing?: boolean;
  scopes?: string[];
  codeSyntax?: Readonly<Partial<Record<string, string>>>;
  valuesByMode?: Readonly<Record<string, unknown>>;
  setValueForMode(modeId: string, value: unknown): void;
  setVariableCodeSyntax?(platform: string, value: string): void;
  removeVariableCodeSyntax?(platform: string): void;
  resolveForConsumer?(consumer: unknown): { value: unknown; resolvedType: string };
}

export interface VariablesApi {
  getLocalVariableCollectionsAsync?(): Promise<ReadonlyArray<CollectionRecord>>;
  getLocalVariablesAsync?(type?: string): Promise<ReadonlyArray<VariableRecord>>;
  getVariableByIdAsync?(id: string): Promise<VariableRecord | null>;
  getVariableCollectionByIdAsync?(id: string): Promise<CollectionRecord | null>;
  createVariable?(name: string, collection: CollectionRecord, type: string): VariableRecord;
  setBoundVariableForPaint?(paint: unknown, field: string, variable: unknown): unknown;
  setBoundVariableForEffect?(effect: unknown, field: string, variable: unknown): unknown;
  setBoundVariableForLayoutGrid?(grid: unknown, field: string, variable: unknown): unknown;
}

/** figma.variables, or UNSUPPORTED naming what is missing. */
export function variablesApi(...needs: Array<keyof VariablesApi>): VariablesApi {
  const v = (globalThis as unknown as { figma: { variables?: VariablesApi } }).figma.variables;
  const missing = needs.filter((n) => typeof v?.[n] !== "function");
  if (!v || missing.length) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type has no variables API${v ? ` (missing ${missing.join(", ")})` : ""}.`);
  }
  return v;
}

export const VARIABLE_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const;

// ── the value dialect ───────────────────────────────────────────────────────

const channel = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");

/** A colour the way the write tools take it: "#rrggbb", or "#rrggbbaa" when not opaque. */
export function hexa(c: { r: number; g: number; b: number; a?: number }): string {
  const base = `#${channel(c.r)}${channel(c.g)}${channel(c.b)}`;
  const a = typeof c.a === "number" ? c.a : 1;
  return Math.round(a * 255) < 255 ? `${base}${channel(a)}` : base;
}

export function isAlias(v: unknown): v is { type: "VARIABLE_ALIAS"; id: string } {
  return !!v && typeof v === "object" && (v as Any).type === "VARIABLE_ALIAS" && typeof (v as Any).id === "string";
}

/** Figma keeps FLOAT values in single precision: 1.2 reads back as 1.2000000476837158. */
const tidy = (n: number) => Math.round(n * 10000) / 10000;

/**
 * One variable value in the write dialect. An alias is named by its target
 * (`aliasName`, which the caller resolved beforehand — names need the async
 * API, this does not), falling back to the id when the target is gone. A
 * number or a boolean is a string too ("16", "true"): every write takes
 * `value` as a string, so a JSON 16 copied out of a read would be refused.
 */
export function valueText(v: unknown, aliasName: (id: string) => string | undefined = () => undefined): unknown {
  if (isAlias(v)) return `alias:${aliasName(v.id) ?? v.id}`;
  if (typeof v === "number") return String(tidy(v));
  if (typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Any;
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") return hexa(o as { r: number; g: number; b: number; a?: number });
    // VariableComposedColor: a colour and an opacity, either of them an alias.
    if ("color" in o) return { color: valueText(o.color, aliasName), opacity: valueText(o.opacity, aliasName) };
  }
  return v;
}

/** Every alias id inside `values`, so their names can be fetched before valueText runs. */
export function aliasIds(values: Iterable<unknown>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (isAlias(v)) out.add(v.id);
    else if (v && typeof v === "object" && "color" in (v as Any)) {
      for (const part of [(v as Any).color, (v as Any).opacity]) if (isAlias(part)) out.add(part.id);
    }
  }
  return [...out];
}

/**
 * Names behind ids, each asked once per call: variables (an alias target may
 * be a library variable, which getVariableByIdAsync still resolves),
 * collections and styles.
 */
export class TokenNames {
  private vars = new Map<string, Promise<VariableRecord | null>>();
  private cols = new Map<string, Promise<CollectionRecord | null>>();
  private styles = new Map<string, Promise<Any | null>>();
  private figma = (globalThis as unknown as { figma: Any & { variables?: VariablesApi } }).figma;

  variable(id: string): Promise<VariableRecord | null> {
    let p = this.vars.get(id);
    if (!p) {
      const api = this.figma.variables;
      p = api?.getVariableByIdAsync ? api.getVariableByIdAsync(id).catch(() => null) : Promise.resolve(null);
      this.vars.set(id, p);
    }
    return p;
  }

  collection(id: string): Promise<CollectionRecord | null> {
    let p = this.cols.get(id);
    if (!p) {
      const api = this.figma.variables;
      p = api?.getVariableCollectionByIdAsync ? api.getVariableCollectionByIdAsync(id).catch(() => null) : Promise.resolve(null);
      this.cols.set(id, p);
    }
    return p;
  }

  style(id: string): Promise<Any | null> {
    let p = this.styles.get(id);
    if (!p) {
      const get = this.figma.getStyleByIdAsync as ((id: string) => Promise<Any | null>) | undefined;
      p = get ? get.call(this.figma, id).catch(() => null) : Promise.resolve(null);
      this.styles.set(id, p);
    }
    return p;
  }

  /** A sync name lookup for every id given, for valueText and the style lines. */
  async namer(ids: Iterable<string>): Promise<(id: string) => string | undefined> {
    const found = new Map<string, string>();
    for (const id of ids) {
      const v = await this.variable(id);
      if (v) found.set(id, v.name);
    }
    return (id) => found.get(id);
  }
}

// ── names ───────────────────────────────────────────────────────────────────

// Figma's variables page: a variable name "cannot contain certain special
// characters such as `.{}`", and a mode name is at most 40 characters
// [C-127]. Checked before
// anything is written, so a Tailwind "spacing/0.5" is refused up front instead
// of by createVariable halfway through a batch.
const NAME_FORBIDS = /[.{}]/g;
export const MODE_NAME_MAX = 40;

/** A new variable name Figma will take, or INVALID_PARAM naming the characters it will not. */
export function checkVariableName(name: string, field: string): string {
  const bad = [...new Set(name.match(NAME_FORBIDS) ?? [])];
  if (bad.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` "${name}" contains ${bad.map((c) => `"${c}"`).join(", ")}; Figma does not allow ${bad.length > 1 ? "them" : "it"} in a variable name.`, {
      hint: 'Write the step another way, e.g. "spacing/0_5" or "spacing/0-5" for 0.5.',
    });
  }
  return name;
}

/** A mode name within Figma's 40-character limit. */
export function checkModeName(name: string, field: string): string {
  if (name.length > MODE_NAME_MAX) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` "${name}" is ${name.length} characters; a mode name is at most ${MODE_NAME_MAX}.`);
  }
  return name;
}

// ── scopes and code syntax [C-106] ──────────────────────────────────────────

/** @figma/plugin-typings 1.141.0, `type VariableScope`. */
export const VARIABLE_SCOPES = [
  "ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL",
  "STROKE_COLOR", "STROKE_FLOAT", "EFFECT_FLOAT", "EFFECT_COLOR", "OPACITY", "COLOR_OPACITY", "FONT_FAMILY", "FONT_STYLE",
  "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT",
] as const;

// Figma's VariableScope page, per type [C-106]. A BOOLEAN takes none.
const SCOPES_FOR: Record<string, ReadonlySet<string>> = {
  COLOR: new Set(["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR", "EFFECT_COLOR"]),
  FLOAT: new Set([
    "ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "STROKE_FLOAT", "EFFECT_FLOAT", "OPACITY", "COLOR_OPACITY",
    "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT",
  ]),
  STRING: new Set(["ALL_SCOPES", "TEXT_CONTENT", "FONT_FAMILY", "FONT_STYLE"]),
  BOOLEAN: new Set(),
};
const FILL_SCOPES = new Set(["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL"]);

/**
 * Scopes decide which property pickers offer a variable. Figma's default is
 * ALL_SCOPES, which puts a primitive like blue/500 in every picker; `[]` hides
 * it, which is what primitives that are only aliased want. A scope the type
 * cannot take, ALL_SCOPES with anything else, or ALL_FILLS with a single fill
 * scope is refused — the pairs Figma's own page rules out [C-106]. Without a
 * `type` only the names and the exclusive pairs are checked; the caller checks
 * each variable's type later.
 */
export function checkScopes(type: string | undefined, raw: unknown, field = "scopes"): string[] {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be an array of scope names, e.g. ["FRAME_FILL", "SHAPE_FILL"] ([] hides the variable from every picker).`);
  }
  const scopes = [...new Set((raw as string[]).map((s) => s.trim().toUpperCase()))];
  const unknown = scopes.filter((s) => !(VARIABLE_SCOPES as readonly string[]).includes(s));
  if (unknown.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` has unknown scope(s): ${unknown.join(", ")}.`, { hint: `Scopes: ${VARIABLE_SCOPES.join(", ")}.` });
  }
  const allowed = type === undefined ? new Set<string>(VARIABLE_SCOPES) : (SCOPES_FOR[type] ?? new Set<string>());
  const wrong = scopes.filter((s) => !allowed.has(s));
  if (wrong.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${type} variable cannot be scoped ${wrong.join(", ")}.`, {
      hint: allowed.size ? `A ${type} variable takes: ${[...allowed].join(", ")}.` : `A ${type} variable takes no scopes; leave \`${field}\` out.`,
    });
  }
  if (scopes.includes("ALL_SCOPES") && scopes.length > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: ALL_SCOPES already covers every field; it cannot be combined with ${scopes.filter((s) => s !== "ALL_SCOPES").join(", ")}.`);
  }
  if (scopes.includes("ALL_FILLS") && scopes.some((s) => FILL_SCOPES.has(s))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: ALL_FILLS already covers FRAME_FILL, SHAPE_FILL and TEXT_FILL; give one or the others.`);
  }
  return scopes;
}

/** CodeSyntaxPlatform, as Figma spells it (typings 1.141.0). */
export const PLATFORMS = ["WEB", "ANDROID", "iOS"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `{ WEB?, ANDROID?, iOS? }` → [platform, value] pairs; "" means remove that platform. */
export function checkCodeSyntax(raw: unknown, field = "codeSyntax"): Array<[Platform, string]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be an object like { "WEB": "var(--color-bg)" }.`);
  }
  const out: Array<[Platform, string]> = [];
  for (const [k, v] of Object.entries(raw as Any)) {
    if (v === undefined) continue;
    const platform = PLATFORMS.find((p) => p.toLowerCase() === k.toLowerCase());
    if (!platform) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.${k}\` is not a platform; use WEB, ANDROID or iOS.`);
    if (typeof v !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.${k}\` must be a string ("" removes it).`);
    out.push([platform, v.trim()]);
  }
  return out;
}

/** What figma_create_variable(s) and figma_set_variable_properties may change on a variable. */
export interface VariableProps {
  name?: string;
  scopes?: string[];
  codeSyntax?: Array<[Platform, string]>;
  description?: string;
  hiddenFromPublishing?: boolean;
}

/** Validate the property fields of `p` for a variable of `type` (undefined: skip the scope check). */
export function readVariableProps(p: Any, type: string | undefined, at = ""): VariableProps {
  const out: VariableProps = {};
  if (p.name !== undefined) {
    if (typeof p.name !== "string" || p.name.trim() === "") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}name\` must be a non-empty string.`);
    out.name = checkVariableName(p.name.trim(), `${at}name`);
  }
  if (p.scopes !== undefined) out.scopes = checkScopes(type, p.scopes, `${at}scopes`);
  if (p.codeSyntax !== undefined) {
    // `{}` names no platform: counting it as a change would answer "ok, changed: []".
    const syntax = checkCodeSyntax(p.codeSyntax, `${at}codeSyntax`);
    if (syntax.length) out.codeSyntax = syntax;
  }
  if (p.description !== undefined) {
    if (typeof p.description !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}description\` must be a string.`);
    out.description = p.description;
  }
  if (p.hiddenFromPublishing !== undefined) {
    if (typeof p.hiddenFromPublishing !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}hiddenFromPublishing\` must be true or false.`);
    out.hiddenFromPublishing = p.hiddenFromPublishing;
  }
  return out;
}

export const hasProps = (p: VariableProps) => Object.keys(p).length > 0;

/**
 * Write validated properties onto a variable; returns the fields changed. A
 * code syntax of "" removes that platform, and only when it is set — removing
 * one that is not there is not a change.
 */
export function applyVariableProps(v: VariableRecord, p: VariableProps): string[] {
  const changed: string[] = [];
  if (p.name !== undefined && p.name !== v.name) {
    v.name = p.name;
    changed.push("name");
  }
  // A BOOLEAN takes no scopes: [] is already what it has, so there is nothing to write.
  if (p.scopes !== undefined && !(v.resolvedType === "BOOLEAN" && p.scopes.length === 0)) {
    v.scopes = p.scopes;
    changed.push("scopes");
  }
  for (const [platform, value] of p.codeSyntax ?? []) {
    if (value === "") {
      if (v.codeSyntax?.[platform] === undefined) continue;
      v.removeVariableCodeSyntax!(platform);
    } else {
      v.setVariableCodeSyntax!(platform, value);
    }
    changed.push(`codeSyntax.${platform}`);
  }
  if (p.description !== undefined) {
    v.description = p.description;
    changed.push("description");
  }
  if (p.hiddenFromPublishing !== undefined) {
    v.hiddenFromPublishing = p.hiddenFromPublishing;
    changed.push("hiddenFromPublishing");
  }
  return changed;
}

/** The members a read reports for a variable: only what is set, so an empty field is not noise. */
export function variableMembers(v: VariableRecord): Any {
  const out: Any = { scopes: [...(v.scopes ?? [])] };
  const syntax = Object.fromEntries(Object.entries(v.codeSyntax ?? {}).filter(([, s]) => typeof s === "string" && s !== ""));
  if (Object.keys(syntax).length) out.codeSyntax = syntax;
  if (v.description) out.description = v.description;
  if (v.hiddenFromPublishing) out.hiddenFromPublishing = true;
  return out;
}

// ── text lengths, case, decoration ──────────────────────────────────────────

/**
 * "auto" | "24" | "150%" for a line height, "0.5" | "-2%" for letter spacing
 * — the grammar figma_set_text_properties uses, so a style and a node take the
 * same strings. A bare number is px: a figma_create_from_spec text's numbers
 * (and the storyboard's) arrive as numbers, and so do figma_create_text's px
 * values (textLengthsForPlugin on the server).
 */
export function parseLength(raw: unknown, field: string, allowAuto: boolean): { unit: string; value?: number } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return { unit: "PIXELS", value: raw };
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (allowAuto && s === "auto") return { unit: "AUTO" };
  const m = /^(-?\d+(?:\.\d+)?)\s*(px|%)?$/.exec(s);
  if (!m) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be ${allowAuto ? '"auto", ' : ""}a number of px ("24") or a percent ("150%").`);
  return { unit: m[2] === "%" ? "PERCENT" : "PIXELS", value: Number(m[1]) };
}

/**
 * parseLength for a line height a create or a style writes: "auto", or px /
 * percent of at least 0 — above 0 where the tool only ever took a positive one
 * (figma_create_text, a text style). Checked while nothing exists, so a negative
 * leading is refused with its field rather than half-way through a build.
 */
export function parseLineHeight(raw: unknown, field: string, positive: boolean): { unit: string; value?: number } | undefined {
  const lh = parseLength(raw, field, true);
  if (lh && lh.unit !== "AUTO" && (positive ? !((lh.value ?? 0) > 0) : (lh.value ?? 0) < 0)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be "auto" or ${positive ? "greater than 0" : "at least 0"}: px ("24") or a percent ("150%").`);
  }
  return lh;
}

export const TEXT_CASES: Record<string, string> = { original: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE", "small-caps": "SMALL_CAPS" };
export const TEXT_DECORATIONS: Record<string, string> = { none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH" };

export function pickEnum(raw: unknown, table: Record<string, string>, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const v = table[String(raw).toLowerCase()];
  if (!v) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be one of ${Object.keys(table).join(", ")}.`);
  return v;
}

export function nonNegative(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a number ≥ 0.`);
  return raw;
}

// ── style values ────────────────────────────────────────────────────────────

/** "Inter Semi Bold 24/32 -1% upper" — a text style the way a designer reads it. */
export function textLine(s: Any): string {
  const font = (s.fontName as { family?: string; style?: string } | undefined) ?? {};
  const lh = s.lineHeight as { unit?: string; value?: number } | undefined;
  const lhText = !lh || lh.unit === "AUTO" ? "auto" : lh.unit === "PERCENT" ? `${r2(lh.value ?? 0)}%` : `${r2(lh.value ?? 0)}`;
  const parts = [`${font.family ?? "?"} ${font.style ?? "?"} ${r2(num(s.fontSize) ?? 0)}/${lhText}`];
  const ls = s.letterSpacing as { unit?: string; value?: number } | undefined;
  if (ls && ls.value) parts.push(ls.unit === "PERCENT" ? `${r2(ls.value)}%` : `${r2(ls.value)}px`);
  if (typeof s.textCase === "string" && s.textCase !== "ORIGINAL") parts.push(s.textCase.toLowerCase().replace(/_/g, "-"));
  if (typeof s.textDecoration === "string" && s.textDecoration !== "NONE") parts.push(s.textDecoration.toLowerCase());
  const ps = num(s.paragraphSpacing);
  if (ps) parts.push(`paragraph ${r2(ps)}`);
  const pi = num(s.paragraphIndent);
  if (pi) parts.push(`indent ${r2(pi)}`);
  return parts.join(" ");
}

const fieldAt = (field: string, i: number) => (i === 0 ? field : `${field}[${i}]`);

/**
 * The variables bound inside a style, as "<field>" → alias id, in the field
 * names figma_update_style takes back: TEXT fields by name, a paint's colour
 * as "color", an effect's as "effect.radius", a grid's as "grid.count" —
 * "[i]" when it is not the first entry.
 */
export function styleBindings(style: Any): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const take = (field: string, alias: unknown) => {
    if (isAlias(alias)) out.push([field, alias.id]);
  };
  if (style.type === "TEXT") {
    for (const [field, alias] of Object.entries((style.boundVariables as Any | undefined) ?? {})) take(field, alias);
  }
  const lists: Array<[string, unknown]> = [["", style.paints], ["effect.", style.effects], ["grid.", style.layoutGrids]];
  for (const [prefix, list] of lists) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      for (const [field, alias] of Object.entries(((entry as Any | undefined)?.boundVariables as Any | undefined) ?? {})) take(fieldAt(`${prefix}${field}`, i), alias);
    });
  }
  return out;
}

/** One style's value as a single line, in design-context dialect (dialect.ts). */
export function styleValue(style: Any, varName: (id: string) => string | undefined = () => undefined): string {
  switch (style.type) {
    case "PAINT": {
      const paints = Array.isArray(style.paints) ? (style.paints as Any[]) : [];
      if (!paints.length) return "none";
      return paints
        .map((p) => {
          const bound = ((p.boundVariables as Any | undefined)?.color as { id?: string } | undefined)?.id;
          return paintText(p, 1, 1, bound ? (varName(bound) ?? bound) : undefined);
        })
        .join(", ");
    }
    case "TEXT":
      return textLine(style);
    case "EFFECT": {
      const effects = Array.isArray(style.effects) ? (style.effects as Any[]) : [];
      return effects.length ? effects.map(effectText).join(", ") : "none";
    }
    case "GRID": {
      // The grid line design context writes, so a grid style and the frame using it read alike ("columns auto" included).
      const grids = Array.isArray(style.layoutGrids) ? (style.layoutGrids as Any[]) : [];
      return grids.length ? grids.map(layoutGridText).join("; ") : "none";
    }
    default:
      return String(style.type ?? "style").toLowerCase();
  }
}
