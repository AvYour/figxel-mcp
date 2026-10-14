// Binding variables to node fields and applying local styles — shared by
// figma_bind_variable_to_node, figma_apply_style_to_node, and the `variables` /
// `style` maps of figma_create_from_spec (tools.md § create_from_spec rules).
//
// API shapes follow @figma/plugin-typings 1.141.0 under documentAccess
// "dynamic-page": setBoundVariable takes a Variable object (the id form is
// deprecated and throws on dynamic-page), styles are set with the *Async
// setters, and paints, effects and layout grids are bound through
// figma.variables.setBoundVariableForPaint / ForEffect / ForLayoutGrid, each of
// which returns a bound COPY that must be assigned back [C-108].

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { beforeMutating } from "./guard.js";
import { str, strList } from "./read.js";
import { localStyles, nearest, type NamedRef } from "./write.js";

export interface VariableLike {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId?: string;
}

interface VariablesApi {
  getVariableByIdAsync?(id: string): Promise<VariableLike | null>;
  getLocalVariablesAsync?(): Promise<readonly VariableLike[]>;
  setBoundVariableForPaint?(paint: unknown, field: string, variable: VariableLike | null): unknown;
  setBoundVariableForEffect?(effect: unknown, field: string, variable: VariableLike | null): unknown;
  setBoundVariableForLayoutGrid?(grid: unknown, field: string, variable: VariableLike | null): unknown;
}

interface FigmaBind {
  variables?: VariablesApi;
  getStyleByIdAsync?(id: string): Promise<{ id: string; name: string; type: string } | null>;
  loadFontAsync?(font: { family: string; style: string }): Promise<void>;
}

const api = () => (globalThis as unknown as { figma: FigmaBind }).figma;

/**
 * A variable by id ("VariableID:1:2") or by its full name ("color/bg/default").
 * A name two local variables share — "color/bg/brand" in a Brand A and a Brand
 * B collection — is refused rather than guessed, as aliases and collection
 * names are: binding whichever came first would follow the wrong brand.
 */
export async function findVariable(ref: { id?: string | undefined; name?: string | undefined }, field = "variable"): Promise<VariableLike> {
  const vars = api().variables;
  if (!vars?.getVariableByIdAsync || !vars.getLocalVariablesAsync) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no variables API.");
  }
  if (ref.id) {
    const v = await vars.getVariableByIdAsync(ref.id);
    if (!v) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No variable with id \`${ref.id}\`.`, { hint: "figma_get_variable_defs lists them." });
    return v;
  }
  if (!ref.name) throw new BridgeError(ErrorCode.INVALID_PARAM, `Give \`${field}Id\` or \`${field}Name\`.`);
  const all = await vars.getLocalVariablesAsync();
  const hits = all.filter((v) => v.name === ref.name);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `${hits.length} variables are named "${ref.name}".`, {
      hint: `Pass one by id instead: ${hits.map((h) => h.id).join(", ")}.`,
    });
  }
  const names = all.map((v) => v.name);
  throw new BridgeError(ErrorCode.INVALID_PARAM, `No variable named "${ref.name}".`, {
    hint: names.length ? `Nearest: ${nearest(ref.name, names).join(", ")}` : "This file defines no variables yet.",
  });
}

/**
 * Friendly field names → what Figma binds. Anything else that Figma calls a
 * bindable field (VariableBindableNodeField / VariableBindableTextField) is
 * passed through unchanged, so nothing Figma supports is locked out.
 */
const ALIASES: Record<string, readonly string[]> = {
  radius: ["cornerRadius"],
  gap: ["itemSpacing"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  size: ["width", "height"],
};
const PAINT_FIELDS: Record<string, "fills" | "strokes"> = { fill: "fills", background: "fills", fills: "fills", stroke: "strokes", strokes: "strokes" };

/** VariableBindableTextField (typings 1.141.0): bound on a TEXT node or a text style. */
export const TEXT_FIELDS: ReadonlySet<string> = new Set([
  "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent",
]);
/** VariableBindableEffectField / VariableBindableLayoutGridField (typings 1.141.0). */
const EFFECT_FIELDS: readonly string[] = ["color", "radius", "spread", "offsetX", "offsetY"];
const GRID_FIELDS: readonly string[] = ["count", "gutterSize", "offset", "sectionSize"];
const SHADOWS = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const BLURS = new Set(["LAYER_BLUR", "BACKGROUND_BLUR"]);

/** What a `field` string names: one paint list, one effect field, one grid field, or node fields. */
export type BindTarget =
  | { kind: "paint"; prop: "fills" | "strokes" }
  | { kind: "effect"; field: string }
  | { kind: "grid"; field: string }
  | { kind: "node"; fields: readonly string[] };

/**
 * Read a `field` before any node changes. "effect.<f>" and "grid.<f>" exist
 * because `effects` and `layoutGrids` are not node fields Figma binds — a
 * variable binds one field of ONE effect or grid, through the variables API.
 */
export function bindTarget(field: string): BindTarget {
  const paint = PAINT_FIELDS[field];
  if (paint) return { kind: "paint", prop: paint };
  const m = /^(effect|grid)\.(.+)$/.exec(field);
  if (m) {
    const kind = m[1] as "effect" | "grid";
    const allowed = kind === "effect" ? EFFECT_FIELDS : GRID_FIELDS;
    if (!allowed.includes(m[2]!)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`field\` "${field}" is not bindable; ${kind === "effect" ? "an effect" : "a grid"} binds ${allowed.map((f) => `${kind}.${f}`).join(", ")}.`);
    }
    return kind === "effect" ? { kind, field: m[2]! } : { kind, field: m[2]! };
  }
  if (field === "effects" || field === "layoutGrids") {
    const kind = field === "effects" ? "effect" : "grid";
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`field\` "${field}" is a list; bind one field of one entry, e.g. "${kind}.${kind === "effect" ? "color" : "count"}" with \`index\`.`);
  }
  return { kind: "node", fields: ALIASES[field] ?? [field] };
}

type Bindable = Record<string, unknown> & {
  type: string;
  setBoundVariable?(field: string, variable: VariableLike | null): void;
};

function wantType(variable: VariableLike, want: string, what: string): void {
  if (variable.resolvedType !== want) throw new Error(`${what} binds a ${want} variable, "${variable.name}" is ${variable.resolvedType}`);
}

/** Copy `list`, bind entry `index` through `bind`, return the copy to assign back. */
function bindEntry(list: unknown, index: number, what: string, bind: (entry: Record<string, unknown>) => unknown): unknown[] {
  if (typeof list === "symbol") throw new Error(`its ${what}s are mixed`);
  const copy = Array.isArray(list) ? [...(list as unknown[])] : [];
  const entry = copy[index] as Record<string, unknown> | undefined;
  if (!entry) throw new Error(`it has no ${what} ${index} (it has ${copy.length})`);
  copy[index] = bind(entry);
  return copy;
}

/**
 * Bind one field of one node. Throws a plain Error with a node-level reason
 * (callers report it per item). `index` picks the paint, effect or grid; it
 * is ignored for plain node fields. Synchronous on purpose: create_from_spec
 * calls it mid-build on text whose fonts it has already loaded.
 */
export function bindField(node: Bindable, field: string, variable: VariableLike, index = 0): void {
  if (!Number.isInteger(index) || index < 0) throw new Error(`\`index\` must be an integer ≥ 0 (got ${index})`);
  const target = bindTarget(field);
  const vars = api().variables;

  if (target.kind === "paint") {
    const prop = target.prop;
    wantType(variable, "COLOR", `a ${field}`);
    if (!(prop in node)) throw new Error(`a ${node.type} has no ${prop}`);
    const bindPaint = vars?.setBoundVariableForPaint;
    if (!bindPaint) throw new Error("this editor type cannot bind paints");
    const current = node[prop];
    // Mixed fills are a text with runs of different colours: there is no one
    // list to bind into, and treating it as empty would repaint every run.
    if (typeof current === "symbol") throw new Error(`its ${prop} are mixed (runs of different colours); give it one ${field} first`);
    const paints = Array.isArray(current) ? [...(current as unknown[])] : [];
    let base: unknown;
    if (paints.length === 0 && index === 0) {
      base = { type: "SOLID", color: { r: 0, g: 0, b: 0 } }; // nothing painted yet: a solid to carry the variable
    } else {
      const p = paints[index] as { type?: string } | undefined;
      if (!p) throw new Error(`it has no ${prop === "fills" ? "fill" : "stroke"} ${index} (it has ${paints.length})`);
      // Only a SOLID paint has one colour to bind. Rebinding a gradient or an
      // image used to replace it with a flat black — silent loss of the fill.
      if (p.type !== "SOLID") throw new Error(`paint ${index} is a ${p.type}; only SOLID paints bind a colour`);
      base = p;
    }
    paints[index] = bindPaint.call(vars, base, "color", variable);
    node[prop] = paints;
    return;
  }

  if (target.kind === "effect") {
    const f = target.field;
    wantType(variable, f === "color" ? "COLOR" : "FLOAT", `effect.${f}`);
    if (!("effects" in node)) throw new Error(`a ${node.type} has no effects`);
    const bind = vars?.setBoundVariableForEffect;
    if (!bind) throw new Error("this editor type cannot bind effects");
    node.effects = bindEntry(node.effects, index, "effect", (e) => {
      const type = String(e.type);
      // A shadow binds all five; a blur only its radius; noise, texture and
      // glass bind nothing (typings 1.141.0, each effect's boundVariables).
      if (BLURS.has(type) ? f !== "radius" : !SHADOWS.has(type)) {
        throw new Error(`effect ${index} is a ${type}; ${BLURS.has(type) ? "a blur binds only effect.radius" : "it has no bindable fields"}`);
      }
      return bind.call(vars, e, f, variable);
    });
    return;
  }

  if (target.kind === "grid") {
    const f = target.field;
    wantType(variable, "FLOAT", `grid.${f}`);
    if (!("layoutGrids" in node)) throw new Error(`a ${node.type} has no layout grids`);
    const bind = vars?.setBoundVariableForLayoutGrid;
    if (!bind) throw new Error("this editor type cannot bind layout grids");
    node.layoutGrids = bindEntry(node.layoutGrids, index, "grid", (g) => {
      if (g.pattern === "GRID" && f !== "sectionSize") throw new Error(`grid ${index} is a square GRID; it binds only grid.sectionSize`);
      return bind.call(vars, g, f, variable);
    });
    return;
  }

  if (typeof node.setBoundVariable !== "function") throw new Error(`a ${node.type} cannot bind variables`);
  for (const f of target.fields) {
    // A TEXT has fontName, not fontFamily / fontStyle, yet both are bindable
    // text fields (typings: VariableBindableTextField). The official notes deny
    // some text fields that the typings allow, so Figma decides, and its
    // message comes back per item [C-109].
    const textField = node.type === "TEXT" && TEXT_FIELDS.has(f);
    if (!textField && !(f in node)) throw new Error(`a ${node.type} has no ${f}`);
    node.setBoundVariable(f, variable);
  }
}

type FontName = { family: string; style: string };

/** Every font a text node uses (all runs), or its one fontName. */
export function fontsOf(node: Record<string, unknown>): FontName[] {
  const all = node.getRangeAllFontNames as ((s: number, e: number) => FontName[]) | undefined;
  const len = typeof node.characters === "string" ? node.characters.length : 0;
  if (typeof all === "function" && len > 0) {
    try {
      return all.call(node, 0, len);
    } catch {
      /* fall through to fontName */
    }
  }
  const fn = node.fontName;
  return fn && typeof fn === "object" ? [fn as FontName] : [];
}

/**
 * bindField for a node that may be a TEXT the caller has not loaded: its fonts
 * are loaded first (the official notes require it before setBoundVariable
 * touches text [C-105]), and for a STRING bound to fontFamily / fontStyle, the
 * font it will switch to — an unavailable one is refused here instead of
 * half-applied [C-109].
 */
export async function bindNodeField(node: Bindable, field: string, variable: VariableLike, index = 0): Promise<void> {
  if (node.type === "TEXT") {
    const figma = api();
    const current = fontsOf(node);
    for (const f of current) await figma.loadFontAsync?.(f).catch(() => undefined);
    const target = bindTarget(field);
    const switches = target.kind === "node" ? target.fields.filter((f) => f === "fontFamily" || f === "fontStyle") : [];
    const resolve = (variable as { resolveForConsumer?: (c: unknown) => { value: unknown } }).resolveForConsumer;
    if (switches.length && variable.resolvedType === "STRING" && typeof resolve === "function") {
      let value: unknown;
      try {
        value = resolve.call(variable, node).value;
      } catch {
        value = undefined;
      }
      if (typeof value === "string" && value) {
        for (const f of current) {
          const next = switches.includes("fontFamily") ? { family: value, style: f.style } : { family: f.family, style: value };
          try {
            await figma.loadFontAsync?.(next);
          } catch {
            throw new Error(`"${variable.name}" names the font "${next.family} ${next.style}", which this Figma cannot load`);
          }
        }
      }
    }
  }
  bindField(node, field, variable, index);
}

/**
 * Everything figma_bind_variable_to_node checks before the first node
 * changes. A refusal here changed nothing and says so (guard.ts), so a
 * corrected retry under the same idempotencyKey runs.
 */
export function bindingFor(params: Record<string, unknown>): Promise<{ field: string; index: number; variable: VariableLike }> {
  return beforeMutating(async () => {
    if (!strList(params, "nodeIds")) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of node ids.");
    const field = str(params, "field");
    if (!field) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '`field` is required, e.g. "fill", "stroke", "radius", "gap", "padding", "width".');
    }
    const target = bindTarget(field);
    const raw = params.index;
    if (raw !== undefined && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`index` must be an integer ≥ 0.");
    }
    const index = (raw as number | undefined) ?? 0;
    if (index > 0 && target.kind === "node") {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`index\` picks a paint, effect or grid; "${field}" has no list to pick from.`);
    }
    const variable = await findVariable({ id: str(params, "variableId"), name: str(params, "variableName") });
    return { field, index, variable };
  });
}

// ── styles ───────────────────────────────────────────────────────────────────

export type StyleTarget = "fill" | "stroke" | "text" | "effect" | "grid";
const KIND_OF: Record<StyleTarget, string> = { fill: "PAINT", stroke: "PAINT", text: "TEXT", effect: "EFFECT", grid: "GRID" };
const SETTER: Record<StyleTarget, string> = {
  fill: "setFillStyleIdAsync",
  stroke: "setStrokeStyleIdAsync",
  text: "setTextStyleIdAsync",
  effect: "setEffectStyleIdAsync",
  grid: "setGridStyleIdAsync",
};

export function isStyleTarget(v: unknown): v is StyleTarget {
  return typeof v === "string" && v in KIND_OF;
}

/**
 * A local style by id or name. `target` narrows a name lookup to one kind and
 * decides fill vs stroke for a PAINT style; without it a name must be unique
 * across kinds.
 */
export async function findStyle(
  ref: { id?: string | undefined; name?: string | undefined },
  target?: StyleTarget,
): Promise<NamedRef & { kind: string }> {
  if (ref.id) {
    // Local style ids end with a comma (`S:abc…,`) — measured: the id Figma
    // returns resolves, and the same id with the comma stripped does NOT
    // (`getStyleByIdAsync` returns null). A trailing comma reads like a typo, so
    // the natural human move is to delete it and then get "not found" for a
    // style that is right there. Accepting both spellings costs nothing and
    // removes the trap.
    const candidates = ref.id.endsWith(",") ? [ref.id, ref.id.slice(0, -1)] : [ref.id, `${ref.id},`];
    for (const id of candidates) {
      const s = await api().getStyleByIdAsync?.(id);
      if (s) return { id: s.id, name: s.name, kind: s.type };
    }
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No style with id \`${ref.id}\`.`, { hint: "figma_get_styles lists them." });
  }
  if (!ref.name) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `styleId` or `styleName`.");
  const all = await localStyles(api() as never);
  const pool = target ? all.filter((s) => s.kind === KIND_OF[target]) : all;
  const hits = pool.filter((s) => s.name === ref.name);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `"${ref.name}" names styles of several kinds (${hits.map((h) => h.kind).join(", ")}).`, {
      hint: "Pass `type` (fill, stroke, text, effect or grid) to pick one.",
    });
  }
  const names = pool.map((s) => s.name);
  throw new BridgeError(ErrorCode.INVALID_PARAM, `No ${target ? `${KIND_OF[target].toLowerCase()} ` : ""}style named "${ref.name}".`, {
    hint: names.length ? `Nearest: ${nearest(ref.name, names).join(", ")}` : "This file defines no such styles yet.",
  });
}

/** Which slot a style fills on a node: PAINT defaults to fill. */
export function targetFor(kind: string, asked?: StyleTarget): StyleTarget {
  if (asked) {
    if (KIND_OF[asked] !== kind) throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${kind} style cannot be applied as \`${asked}\`.`);
    return asked;
  }
  const byKind: Record<string, StyleTarget> = { PAINT: "fill", TEXT: "text", EFFECT: "effect", GRID: "grid" };
  const t = byKind[kind];
  if (!t) throw new BridgeError(ErrorCode.UNSUPPORTED, `Styles of kind ${kind} cannot be applied by this tool.`);
  return t;
}

/** Apply a resolved style to one node. Throws a plain Error with a node-level reason. */
export async function applyStyle(node: Record<string, unknown> & { type: string }, styleId: string, target: StyleTarget): Promise<void> {
  const setter = node[SETTER[target]];
  if (typeof setter !== "function") throw new Error(`a ${node.type} cannot take a ${target} style`);
  await (setter as (id: string) => Promise<void>).call(node, styleId);
}
