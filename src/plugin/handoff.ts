// figma_check_layout { audit: ["handoff"] } — whether a frame can be handed on.
//
// The visual checks say a frame looks right; this says whether it is connected
// to the file's system: what share of its solid paints, texts, auto-layout
// spacing and corner radii resolve to variables or styles rather than raw
// values, which frames are detached instances, and which local styles it uses
// that repeat another style or a variable. A file can pass every visual check
// and still be unusable downstream because nothing in it is bound to anything
// (asked for by a designer after the 0.1.1 launch post).
//
// Counting follows the tokens audit: a node inside an instance takes its values
// from the component, so it is the component's business, not this frame's; the
// instance itself is counted as a use of the system. Hidden nodes are skipped by
// the walk that feeds this.

import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;
type Severity = "error" | "warning" | "info";
type Issue = { kind: string; severity: Severity; nodeId: string; name: string; detail: string };
type Rgb = { r: number; g: number; b: number };

export interface Share {
  bound: number;
  total: number;
}

export interface HandoffTally {
  paints: Share;
  texts: Share;
  spacing: Share;
  radii: Share;
  instances: number;
  /** Frames Figma records as detached from a component [C-343]. */
  detached: Array<{ id: string; name: string; info: { type: "local"; componentId: string } | { type: "library"; componentKey: string } }>;
}

export const emptyTally = (): HandoffTally => ({
  paints: { bound: 0, total: 0 },
  texts: { bound: 0, total: 0 },
  spacing: { bound: 0, total: 0 },
  radii: { bound: 0, total: 0 },
  instances: 0,
  detached: [],
});

export function mergeTally(into: HandoffTally, from: HandoffTally): void {
  for (const k of ["paints", "texts", "spacing", "radii"] as const) {
    into[k].bound += from[k].bound;
    into[k].total += from[k].total;
  }
  into.instances += from.instances;
  into.detached.push(...from.detached);
}

const AUTO_LAYOUT = new Set(["HORIZONTAL", "VERTICAL"]);
/** A text's typography bound to variables (VariableBindableTextField in the plugin typings). */
const TYPE_FIELDS = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "letterSpacing"];
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Whether every segment of a text with mixed styles has a text style. */
function allSegmentsStyled(a: Any): boolean {
  const seg = a.getStyledTextSegments as ((f: string[]) => Array<{ textStyleId?: unknown }>) | undefined;
  if (typeof seg !== "function") return false;
  try {
    const parts = seg.call(a, ["textStyleId"]);
    return parts.length > 0 && parts.every((p) => nonEmpty(p.textStyleId));
  } catch {
    return false;
  }
}

/** One visible node outside any instance: what it holds, and how much of it is bound. */
export function tallyNode(t: HandoffTally, n: NodeLike, a: Any): void {
  if (n.type === "INSTANCE") {
    t.instances++;
    return;
  }
  const bv = (a.boundVariables ?? {}) as Any;

  // Solid paints: a style on the whole list binds every paint in it.
  for (const [list, styleKey] of [[a.fills, "fillStyleId"], [a.strokes, "strokeStyleId"]] as const) {
    if (!Array.isArray(list)) continue;
    const styled = nonEmpty(a[styleKey]);
    for (const p of list as Any[]) {
      if (p.type !== "SOLID" || p.visible === false) continue;
      t.paints.total++;
      if (styled || (p.boundVariables as Any | undefined)?.color) t.paints.bound++;
    }
  }

  if (n.type === "TEXT") {
    t.texts.total++;
    const style = a.textStyleId;
    const styled = nonEmpty(style) || (typeof style === "symbol" && allSegmentsStyled(a)) || TYPE_FIELDS.some((k) => bv[k]);
    if (styled) t.texts.bound++;
  }

  if (AUTO_LAYOUT.has(String(a.layoutMode))) {
    // With space-between the gap is computed, not chosen: nothing to bind.
    const keys = a.primaryAxisAlignItems === "SPACE_BETWEEN" ? [] : ["itemSpacing"];
    keys.push("paddingTop", "paddingRight", "paddingBottom", "paddingLeft");
    for (const k of keys) {
      if (typeof a[k] !== "number" || (a[k] as number) <= 0) continue;
      t.spacing.total++;
      if (bv[k]) t.spacing.bound++;
    }
  }

  if (typeof a.cornerRadius === "number") {
    if (a.cornerRadius > 0) {
      t.radii.total++;
      if (bv.topLeftRadius || bv.cornerRadius) t.radii.bound++;
    }
  } else if (typeof a.cornerRadius === "symbol") {
    // Mixed corners: each one is its own value.
    for (const k of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) {
      if (typeof a[k] !== "number" || (a[k] as number) <= 0) continue;
      t.radii.total++;
      if (bv[k]) t.radii.bound++;
    }
  }

  if (n.type === "FRAME") {
    let info: unknown;
    try {
      info = a.detachedInfo;
    } catch {
      info = null; // an editor without the member: nothing to report
    }
    const d = info as { type?: unknown; componentId?: unknown; componentKey?: unknown } | null | undefined;
    if (d && d.type === "local" && typeof d.componentId === "string") {
      t.detached.push({ id: n.id, name: n.name, info: { type: "local", componentId: d.componentId } });
    } else if (d && d.type === "library" && typeof d.componentKey === "string") {
      t.detached.push({ id: n.id, name: n.name, info: { type: "library", componentKey: d.componentKey } });
    }
  }
}

const percent = (s: Share): number | null => (s.total ? Math.round((100 * s.bound) / s.total) : null);

function phrase(s: Share, what: string): string {
  const p = percent(s);
  return p === null ? `no ${what}` : `${p}% of ${what} (${s.bound}/${s.total})`;
}

function hex(c: Rgb): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

type Api = Any & { variables?: Any };
const maybeApi = () => (globalThis as unknown as { figma?: Api }).figma;

async function call<T>(owner: unknown, fn: unknown, ...args: unknown[]): Promise<T | undefined> {
  if (typeof fn !== "function") return undefined;
  try {
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(owner, args)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A paint style's one solid colour, unless the style itself is bound to a variable. */
function styleColour(style: Any): string | null {
  const paints = style.paints as Any[] | undefined;
  if (!Array.isArray(paints) || paints.length !== 1) return null;
  const p = paints[0]!;
  if (p.type !== "SOLID" || p.visible === false || (p.boundVariables as Any | undefined)?.color) return null;
  const a = typeof p.opacity === "number" ? p.opacity : 1;
  return `${hex(p.color as Rgb)}@${Math.round(a * 100)}`;
}

function textKey(style: Any): string | null {
  const font = style.fontName as { family?: unknown; style?: unknown } | undefined;
  if (!font || typeof font.family !== "string" || typeof style.fontSize !== "number") return null;
  return JSON.stringify([font.family, font.style, style.fontSize, style.lineHeight ?? null, style.letterSpacing ?? null]);
}

/**
 * Local styles this frame uses that repeat another local style, or the default
 * value of a local colour variable: two sources for one decision, so a change
 * to one leaves the other behind.
 */
async function duplicateStyles(used: ReadonlySet<string>): Promise<Issue[]> {
  const f = maybeApi();
  if (!f || !used.size) return [];
  const out: Issue[] = [];
  const paintStyles = ((await call<Any[]>(f, f.getLocalPaintStylesAsync)) ?? []) as Any[];
  const textStyles = ((await call<Any[]>(f, f.getLocalTextStylesAsync)) ?? []) as Any[];

  // Colour variables by their value in their collection's default mode.
  const varsByColour = new Map<string, string[]>();
  const vars = f.variables;
  const colourVars = ((await call<Any[]>(vars, vars?.getLocalVariablesAsync, "COLOR")) ?? []) as Any[];
  if (colourVars.length) {
    const collections = ((await call<Any[]>(vars, vars?.getLocalVariableCollectionsAsync)) ?? []) as Any[];
    const defaultMode = new Map(collections.map((c) => [String(c.id), String(c.defaultModeId)]));
    for (const v of colourVars) {
      const value = (v.valuesByMode as Any | undefined)?.[defaultMode.get(String(v.variableCollectionId)) ?? ""] as Any | undefined;
      if (!value || value.type === "VARIABLE_ALIAS" || typeof value.r !== "number") continue;
      const key = `${hex(value as unknown as Rgb)}@${Math.round((typeof value.a === "number" ? value.a : 1) * 100)}`;
      varsByColour.set(key, [...(varsByColour.get(key) ?? []), String(v.name)]);
    }
  }

  const repeats = (styles: Any[], keyOf: (s: Any) => string | null) => {
    const byKey = new Map<string, Any[]>();
    for (const s of styles) {
      const k = keyOf(s);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), s]);
    }
    return byKey;
  };
  const paintsByKey = repeats(paintStyles, styleColour);
  for (const s of paintStyles) {
    if (!used.has(String(s.id))) continue;
    const key = styleColour(s);
    if (!key) continue;
    const twins = (paintsByKey.get(key) ?? []).filter((o) => o.id !== s.id).map((o) => `"${String(o.name)}"`);
    const sameVars = varsByColour.get(key) ?? [];
    if (!twins.length && !sameVars.length) continue;
    const parts = [
      ...(twins.length ? [`the style${twins.length > 1 ? "s" : ""} ${twins.slice(0, 3).join(", ")}`] : []),
      ...(sameVars.length ? [`the variable${sameVars.length > 1 ? "s" : ""} ${sameVars.slice(0, 3).map((v) => `"${v}"`).join(", ")}`] : []),
    ];
    out.push({
      kind: "duplicate_style", severity: "info", nodeId: String(s.id), name: String(s.name),
      detail: `is a paint style with the same colour (${key.split("@")[0]}) as ${parts.join(" and ")}: two sources for one colour. ` +
        (sameVars.length
          ? `Bind the layers to the variable (figma_bind_variable_to_node), or bind this style's paint to it, so one change reaches both.`
          : `Keep one and point the layers at it (figma_apply_style_to_node).`),
    });
  }
  const textsByKey = repeats(textStyles, textKey);
  for (const s of textStyles) {
    if (!used.has(String(s.id))) continue;
    const key = textKey(s);
    if (!key) continue;
    const twins = (textsByKey.get(key) ?? []).filter((o) => o.id !== s.id).map((o) => `"${String(o.name)}"`);
    if (!twins.length) continue;
    out.push({
      kind: "duplicate_style", severity: "info", nodeId: String(s.id), name: String(s.name),
      detail: `is a text style identical to ${twins.slice(0, 3).join(", ")} (same font, size, line height and letter spacing). Keep one and point the texts at it (figma_apply_style_to_node).`,
    });
  }
  return out;
}

export interface HandoffReport {
  issues: Issue[];
  summary: {
    paints: Share & { percent: number | null };
    texts: Share & { percent: number | null };
    spacing: Share & { percent: number | null };
    radii: Share & { percent: number | null };
    instances: number;
    detached: number;
    duplicateStyles: number;
    verdict: string;
  };
}

/** The numbers and findings for a whole check, once every root has been walked. */
export async function handoffReport(t: HandoffTally, usedStyleIds: ReadonlySet<string>, system: { found: boolean; why: string }): Promise<HandoffReport> {
  const issues: Issue[] = [];
  const f = maybeApi();
  for (const d of t.detached.slice(0, 200)) {
    let from: string;
    if (d.info.type === "local") {
      const comp = await call<{ name?: string }>(f, f?.getNodeByIdAsync, d.info.componentId);
      from = comp?.name ? `the local component "${comp.name}" (${d.info.componentId})` : `a local component that no longer exists (${d.info.componentId})`;
    } else {
      from = `a library component (key ${d.info.componentKey})`;
    }
    issues.push({
      kind: "detached_instance", severity: "warning", nodeId: d.id, name: d.name,
      detail: `was detached from ${from}: it no longer follows the component, so a fix there never reaches it. ` +
        "Put an instance back (figma_create_instance, then set its properties), or make this a component if the change was meant to stay.",
    });
  }
  const dupes = await duplicateStyles(usedStyleIds);
  issues.push(...dupes);

  const withPercent = (s: Share) => ({ ...s, percent: percent(s) });
  const counted = [phrase(t.paints, "solid paints"), phrase(t.texts, "texts"), phrase(t.spacing, "auto-layout spacing values"), phrase(t.radii, "corner radii")];
  const extras = [
    `${t.instances} instance${t.instances === 1 ? "" : "s"}`,
    `${t.detached.length} detached`,
    ...(dupes.length ? [`${dupes.length} duplicate style${dupes.length === 1 ? "" : "s"}`] : []),
  ];
  const verdict = system.found
    ? `Bound to the file's variables or styles: ${counted.join(", ")}. ${extras.join(", ")}.` +
      (t.paints.bound < t.paints.total || t.texts.bound < t.texts.total || t.spacing.bound < t.spacing.total || t.radii.bound < t.radii.total
        ? ' audit: ["tokens"] lists each raw value with the variable to bind.'
        : "")
    : `This file has nothing to bind to yet (${system.why}), so these shares are expected to be low: ${counted.join(", ")}. ${extras.join(", ")}. ` +
      'Set up the tokens first: figma_get_guide { topic: "design-system" }.';
  return {
    issues,
    summary: {
      paints: withPercent(t.paints),
      texts: withPercent(t.texts),
      spacing: withPercent(t.spacing),
      radii: withPercent(t.radii),
      instances: t.instances,
      detached: t.detached.length,
      duplicateStyles: dupes.length,
      verdict,
    },
  };
}
