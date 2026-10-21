// What the agent last saw of each node, property by property, and of the
// file's variables and styles: the content side of trust.ts's attribution.
//
// Figma delivers nodechange events late and in batches. In the live role
// tests a change made at 04:12:03.9 was reported at 04:12:06.2, another more
// than a minute after it was made, and some of the agent's own changes came
// with origin REMOTE (role tests, findings 6, 6b and 6c) [C-394]. A settle
// window cannot attribute those, so trust.ts uses time only as a hint and
// decides by content: a change that leaves the node as the agent last saw it
// is the agent's own late echo, whatever its arrival time or origin.
//
// Each change names its kind, and a property change the properties that
// changed (NodeChange and NodeChangeProperty, plugin typings 1.141.0). So the
// record here is a hash per property, not one per node: a late change is
// matched on exactly the properties it names. A record comes from what the
// agent's write left behind (trust.ts records it when the op ends), from what
// a read returned, or from a change the timing already gave to the agent.
//
// Hashes are binding-aware. A value bound to a variable, or linked to a
// style, hashes as that variable or style, not as the colour or number it
// resolves to, and the node's resolved variable modes are kept beside it. So
// a variable's new value re-colouring the nodes bound to it changes no node's
// hash: a write to such a node overwrites nothing anyone did to the node
// itself. A change to a variable or a style is caught by the resource watch
// instead (readResources), which rollback runs: Figma's undo would take such
// a change back too [C-024].
//
// Structural types only and every read guarded (board-read's `field`): a node
// that throws on a member it lacks reads as absent [C-145].

import { STORYBOARD_NAMESPACE } from "../shared/storyboard.js";
import { childrenOf, field, heldText, type NodeLike } from "./board-read.js";

type Any = Record<string, unknown>;

const isObject = (v: unknown): v is Any => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every property a nodechange can name (NodeChangeProperty, plugin typings 1.141.0), `stokeTopWeight` spelt as Figma spells it. */
export const NODE_PROPS: readonly string[] = [
  "pointCount", "name", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "parent", "pluginData",
  "constraints", "locked", "visible", "opacity", "blendMode", "layoutGrids", "guides", "characters", "openTypeFeatures",
  "styledTextSegments", "vectorNetwork", "effects", "exportSettings", "arcData", "autoRename", "fontName", "innerRadius",
  "fontSize", "lineHeight", "leadingTrim", "paragraphIndent", "paragraphSpacing", "textWrapStyle", "listSpacing",
  "hangingPunctuation", "hangingList", "letterSpacing", "textAlignHorizontal", "textAlignVertical", "textCase",
  "textDecoration", "textAutoResize", "textTruncation", "maxLines", "fills", "topLeftRadius", "topRightRadius",
  "bottomLeftRadius", "bottomRightRadius", "constrainProportions", "strokes", "strokeWeight", "strokeAlign", "strokeCap",
  "strokeJoin", "strokeMiterLimit", "booleanOperation", "overflowDirection", "dashPattern", "backgrounds",
  "handleMirroring", "cornerRadius", "cornerSmoothing", "relativeTransform", "x", "y", "rotation", "isMask", "maskType",
  "clipsContent", "type", "overlayPositionType", "overlayBackgroundInteraction", "overlayBackground",
  "prototypeStartNode", "prototypeBackgrounds", "expanded", "fillStyleId", "strokeStyleId", "backgroundStyleId",
  "textStyleId", "effectStyleId", "gridStyleId", "description", "layoutMode", "layoutWrap", "paddingLeft", "paddingTop",
  "paddingRight", "paddingBottom", "itemSpacing", "counterAxisSpacing", "layoutAlign", "counterAxisSizingMode",
  "primaryAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "counterAxisAlignContent", "layoutGrow",
  "layoutPositioning", "itemReverseZIndex", "hyperlink", "mediaData", "stokeTopWeight", "strokeBottomWeight",
  "strokeLeftWeight", "strokeRightWeight", "reactions", "flowStartingPoints", "shapeType", "connectorStart",
  "connectorEnd", "connectorLineType", "connectorStartStrokeCap", "connectorEndStrokeCap", "codeLanguage",
  "widgetSyncedState", "componentPropertyDefinitions", "componentPropertyReferences", "componentProperties", "embedData",
  "linkUnfurlData", "text", "authorVisible", "authorName", "code", "textBackground", "gridAutoTracks",
  "gridItemsPositioning", "animationStyles", "animations", "manualKeyframeTracks",
];

/** Not a Figma property: the node's resolved variable modes, kept beside the properties whose values are bound. */
export const MODES = "@modes";

const INDEX = new Map<string, number>([...NODE_PROPS, MODES].map((p, i) => [p, i]));
const SLOTS = INDEX.size;
const MODES_SLOT = INDEX.get(MODES)!;

/** What a write moves on a node it did not name: a sibling that reflows, a parent that hugs, a child that follows. */
export const GEOMETRY_PROPS: readonly string[] = ["x", "y", "width", "height", "rotation", "relativeTransform", "parent"];

/** Properties a variable or a style can re-resolve: under a node whose modes the agent set, only their bound values are recorded. */
const LINKABLE_PROPS: readonly string[] = ["fills", "strokes", "effects", "layoutGrids", "backgrounds", "styledTextSegments"];

/** Node-level bindings that are lists, one alias per paint or effect: the paint itself carries the binding. */
const LISTED = new Set(["fills", "strokes", "effects", "layoutGrids", "textRangeFills"]);

/** A node property, and the style id that sets it when the node is linked to a style. */
const STYLE_OF: Readonly<Record<string, string>> = {
  fills: "fillStyleId", strokes: "strokeStyleId", effects: "effectStyleId", layoutGrids: "gridStyleId", backgrounds: "backgroundStyleId",
};

/** Text fields a text style sets: on a node or a text segment linked to one, the style id stands for them. */
const TEXT_STYLE_KEYS: readonly string[] = [
  "fontName", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "paragraphIndent", "paragraphSpacing",
  "listSpacing", "textCase", "textDecoration", "leadingTrim", "hangingPunctuation", "hangingList",
];
const TEXT_STYLED = new Set(TEXT_STYLE_KEYS);

/** Text segment fields, newest first; an older Figma refuses a field it does not know, so the basic set is tried after. */
const SEGMENT_FIELDS: readonly (readonly string[])[] = [
  ["fontName", "fontSize", "fontWeight", "textDecoration", "textCase", "lineHeight", "letterSpacing", "fills", "textStyleId",
    "fillStyleId", "listOptions", "indentation", "paragraphIndent", "paragraphSpacing", "hyperlink", "boundVariables",
    "textStyleOverrides"],
  ["fontName", "fontSize", "textDecoration", "textCase", "lineHeight", "letterSpacing", "fills", "textStyleId", "fillStyleId", "hyperlink"],
];

/** A parent's child ids are read once per pass, so a node's index costs one walk of its siblings, not one per node. */
const MAX_SIBLINGS = 1_000;
/** A value's text is hashed up to this many characters (a vector network, a long plugin-data value). */
const MAX_CHARS = 20_000;

// ── hashing ─────────────────────────────────────────────────────────────────

/** FNV-1a over UTF-16 code units; never 0, which a record uses for "not recorded". */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h;
}

interface Out {
  parts: string[];
  len: number;
  /** A variable or a style stood in for a value. */
  bound: boolean;
  /** The variables and styles referenced. */
  refs: string[];
}

const newOut = (): Out => ({ parts: [], len: 0, bound: false, refs: [] });
const joined = (o: Out) => o.parts.join("");

function put(o: Out, s: string): void {
  if (o.len >= MAX_CHARS) return;
  o.parts.push(s);
  o.len += s.length;
}

function isAlias(v: unknown): v is { type: "VARIABLE_ALIAS"; id: string } {
  return isObject(v) && v.type === "VARIABLE_ALIAS" && typeof v.id === "string";
}

/** Every variable id an alias, a list of them or an object of them names. */
function aliasIds(v: unknown, out: string[], depth = 0): string[] {
  if (depth > 4) return out;
  if (isAlias(v)) out.push(v.id);
  else if (Array.isArray(v)) for (const x of v) aliasIds(x, out, depth + 1);
  else if (isObject(v)) for (const k of Object.keys(v)) aliasIds(v[k], out, depth + 1);
  return out;
}

/** A node reached through a property (a page's prototype start node): its id, never its content. */
function nodeRef(o: Any): string | undefined {
  const id = field(o, "id");
  return typeof id === "string" && typeof field(o, "type") === "string" && field(o, "parent") !== undefined ? id : undefined;
}

/**
 * A value as stable text: keys sorted, numbers to four decimals, figma.mixed
 * as "mixed". `aware`: a field an object binds to a variable writes the
 * variable, and a segment or paint linked to a style writes the style.
 */
function write(v: unknown, o: Out, aware: boolean, depth = 0): void {
  if (o.len >= MAX_CHARS) return;
  if (depth > 12) return put(o, "…");
  switch (typeof v) {
    case "undefined":
      return put(o, "u");
    case "symbol":
      return put(o, "mixed");
    case "number":
      return put(o, Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : String(v));
    case "boolean":
      return put(o, v ? "t" : "f");
    case "string":
      return put(o, JSON.stringify(v));
    case "function":
      return;
    case "bigint":
      return put(o, String(v));
  }
  if (v === null) return put(o, "null");
  if (Array.isArray(v)) {
    put(o, "[");
    for (const x of v) {
      write(x, o, aware, depth + 1);
      put(o, ",");
    }
    return put(o, "]");
  }
  const obj = v as Any;
  if (isAlias(obj)) {
    o.refs.push(obj.id);
    o.bound = true;
    return put(o, `var:${obj.id}`);
  }
  const ref = nodeRef(obj);
  if (ref !== undefined) return put(o, `node:${ref}`);
  const bv = aware && isObject(obj.boundVariables) ? obj.boundVariables : undefined;
  const skip = new Set<string>();
  if (aware) {
    for (const [styleKey, keys] of [["textStyleId", TEXT_STYLE_KEYS], ["fillStyleId", ["fills"]]] as const) {
      const id = obj[styleKey];
      if (typeof id !== "string" || !id) continue;
      for (const k of keys) skip.add(k);
      o.bound = true;
      o.refs.push(id);
    }
  }
  put(o, "{");
  for (const k of Object.keys(obj).sort()) {
    if ((bv && k === "boundVariables") || skip.has(k)) continue;
    const alias = bv ? bv[k] : undefined;
    if (alias !== undefined && alias !== null) {
      const ids = aliasIds(alias, []);
      o.bound = true;
      o.refs.push(...ids);
      put(o, `${k}=var:${ids.join("|")};`);
      continue;
    }
    put(o, `${k}:`);
    write(obj[k], o, aware, depth + 1);
    put(o, ";");
  }
  // A bound field the object does not list as its own (a paint's colour is always listed; be safe).
  if (bv) for (const k of Object.keys(bv).sort()) if (!(k in obj)) put(o, `${k}=var:${aliasIds(bv[k], []).join("|")};`);
  put(o, "}");
}

/** One hashing pass: a parent's child ids, read once. */
export interface HashContext {
  kids: Map<string, readonly string[] | null>;
}

export const newContext = (): HashContext => ({ kids: new Map() });

function childIds(parent: unknown, parentId: string, ctx?: HashContext): readonly string[] | null {
  const cached = ctx?.kids.get(parentId);
  if (cached !== undefined) return cached;
  const kids = childrenOf(parent as NodeLike);
  let ids: readonly string[] | null = null;
  if (kids && kids.length <= MAX_SIBLINGS) ids = kids.map((k) => String(field(k, "id") ?? ""));
  ctx?.kids.set(parentId, ids);
  return ids;
}

function segmentsOf(node: unknown): unknown {
  const fn = field<(fields: readonly string[]) => unknown>(node, "getStyledTextSegments");
  if (typeof fn !== "function") return undefined;
  for (const fields of SEGMENT_FIELDS) {
    try {
      return fn.call(node, fields);
    } catch {
      /* a field this Figma does not know: the basic set next */
    }
  }
  return undefined;
}

/** This plugin's own plugin data and its shared namespace: each key with a hash of its whole value. */
function pluginDataOf(node: unknown): unknown {
  const keys = field<() => string[]>(node, "getPluginDataKeys");
  const get = field<(key: string) => string>(node, "getPluginData");
  const sharedKeys = field<(ns: string) => string[]>(node, "getSharedPluginDataKeys");
  const getShared = field<(ns: string, key: string) => string>(node, "getSharedPluginData");
  if (typeof keys !== "function" && typeof sharedKeys !== "function") return undefined;
  const out: string[] = [];
  try {
    if (typeof keys === "function" && typeof get === "function") for (const k of keys.call(node)) out.push(`p:${k}=${fnv(get.call(node, k))}`);
  } catch {
    /* unreadable here: what was read stands */
  }
  try {
    if (typeof sharedKeys === "function" && typeof getShared === "function") {
      for (const k of sharedKeys.call(node, STORYBOARD_NAMESPACE)) out.push(`s:${k}=${fnv(getShared.call(node, STORYBOARD_NAMESPACE, k))}`);
    }
  } catch {
    /* as above */
  }
  return out.sort();
}

/** Properties read another way than `node[prop]`. */
const READERS: Readonly<Record<string, (node: unknown, ctx?: HashContext) => unknown>> = {
  // The parent and the place among its children: a reorder is a change.
  parent: (node, ctx) => {
    const p = field(node, "parent");
    if (!p) return null;
    const pid = String(field(p, "id") ?? "");
    const kids = childIds(p, pid, ctx);
    return `${pid}#${kids ? kids.indexOf(String(field(node, "id") ?? "")) : -1}`;
  },
  styledTextSegments: (node) => segmentsOf(node),
  // A sticky's, a shape's or a connector's text sublayer; a TEXT node reports `characters`.
  text: (node) => (field(node, "type") === "TEXT" ? undefined : heldText(node as NodeLike)),
  pluginData: (node) => pluginDataOf(node),
};

export interface PropHash {
  hash: number;
  /** A variable or a style stood in for (part of) the value: it also depends on the node's modes. */
  bound: boolean;
  /** The variables and styles it references. */
  refs: string[];
  /** All of it follows variables or styles: nothing in it can change except through them. */
  linked: boolean;
}

/** The hash of one property as it is now, or undefined when the node has no such property. */
export function hashProp(node: unknown, prop: string, ctx?: HashContext): PropHash | undefined {
  const o = newOut();
  let linked = false;
  const special = READERS[prop];
  if (special) {
    const v = special(node, ctx);
    if (v === undefined) return undefined;
    write(v, o, true);
  } else {
    const name = prop === "stokeTopWeight" ? "strokeTopWeight" : prop;
    const styleKey = STYLE_OF[name] ?? (TEXT_STYLED.has(name) ? "textStyleId" : undefined);
    const styleId = styleKey ? field(node, styleKey) : undefined;
    const bv = field(node, "boundVariables");
    const binding = isObject(bv) && !LISTED.has(name) ? bv[name] : undefined;
    if (typeof styleId === "string" && styleId) {
      if (field(node, name) === undefined) return undefined;
      o.bound = true;
      o.refs.push(styleId);
      put(o, `style:${styleId}`);
      linked = true;
    } else if (binding !== undefined && binding !== null) {
      const ids = aliasIds(binding, []);
      o.bound = true;
      o.refs.push(...ids);
      put(o, `var:${ids.join("|")}`);
      linked = ids.length > 0;
    } else {
      const v = field(node, name);
      if (v === undefined) return undefined;
      write(v, o, true);
      // A list whose every paint or effect is bound: only its variables can move it.
      linked = Array.isArray(v) && v.length > 0 && v.every((x) => isObject(x) && isObject(x.boundVariables) && aliasIds(x.boundVariables, []).length > 0);
    }
  }
  return { hash: fnv(joined(o)), bound: o.bound, refs: o.refs, linked };
}

/** The node's resolved variable modes, hashed. */
export function modesHash(node: unknown): number {
  const o = newOut();
  write(field(node, "resolvedVariableModes"), o, false);
  return fnv(joined(o));
}

// ── records ─────────────────────────────────────────────────────────────────

/** What the agent last saw of one node: a hash per property slot (0: not recorded). */
export interface Seen {
  h: Uint32Array;
  /** Every property was recorded at once (a read, or what the agent wrote or made). */
  full: boolean;
  removed: boolean;
}

/**
 * How much of a node a record takes:
 *  - full: every property — what the agent wrote, made or read;
 *  - geometry: position, size and place — what a write moves on a node it did not name;
 *  - binding: geometry, the modes, and the properties whose values are bound —
 *    under a node the agent wrote (a mode set on a frame re-resolves everything
 *    inside it), without taking a raw value the agent never wrote for its own.
 */
export type Scope = "full" | "geometry" | "binding";

export const removedRecord = (): Seen => ({ h: new Uint32Array(SLOTS), full: true, removed: true });

/**
 * Record `node` at `scope`. A full record replaces what was there; a partial
 * one updates its slots in `into` and keeps the rest — the last that is known.
 */
export function snapshot(node: unknown, scope: Scope, ctx?: HashContext, into?: Seen): Seen {
  const rec: Seen = scope !== "full" && into && !into.removed ? into : { h: new Uint32Array(SLOTS), full: false, removed: false };
  let bound = false;
  const set = (p: string, onlyBound: boolean) => {
    const i = INDEX.get(p);
    if (i === undefined) return;
    const h = hashProp(node, p, ctx);
    if (onlyBound && !h?.bound) return;
    rec.h[i] = h ? h.hash : 0;
    if (h?.bound) bound = true;
  };
  if (scope === "full") for (const p of NODE_PROPS) set(p, false);
  else {
    for (const p of GEOMETRY_PROPS) set(p, false);
    if (scope === "binding") {
      for (const p of LINKABLE_PROPS) set(p, true);
      const bv = field(node, "boundVariables");
      if (isObject(bv)) for (const p of Object.keys(bv)) if (!LISTED.has(p)) set(p, true);
    }
  }
  if (bound || scope === "binding") rec.h[MODES_SLOT] = modesHash(node);
  if (scope === "full") rec.full = true;
  return rec;
}

/**
 * Record what one change named (the agent's, by timing): its properties as
 * they are now, the modes with any that is bound. Without a list (a
 * creation), the whole node.
 */
export function noteChange(node: unknown, props: readonly string[] | undefined, into?: Seen, ctx?: HashContext): Seen {
  if (!props?.length) return snapshot(node, "full", ctx);
  const rec: Seen = into && !into.removed ? into : { h: new Uint32Array(SLOTS), full: false, removed: false };
  let bound = false;
  for (const p of props) {
    const i = INDEX.get(p);
    if (i === undefined) continue;
    const h = hashProp(node, p, ctx);
    rec.h[i] = h ? h.hash : 0;
    if (h?.bound) bound = true;
  }
  if (bound) rec.h[MODES_SLOT] = modesHash(node);
  return rec;
}

/**
 * Whether a change left `node` as the agent last saw it. `props` are the
 * properties the change names; without them (a creation) a full record is
 * compared whole, and anything less cannot vouch for an unknown change. A
 * property the record does not hold passes only when its value follows
 * variables or styles the agent itself changed (`affected`, from the resource
 * watch).
 */
export function unchangedSince(
  rec: Seen,
  node: unknown,
  props: readonly string[] | undefined,
  affected: ReadonlySet<string>,
  ctx?: HashContext,
): boolean {
  let names = props?.length ? props : undefined;
  if (!names) {
    if (!rec.full) return false;
    names = NODE_PROPS;
  }
  let modes: number | undefined;
  for (const p of names) {
    const i = INDEX.get(p);
    // A property this build does not know (a newer Figma's) cannot be vouched for.
    if (i === undefined) return false;
    const want = rec.h[i]!;
    if (want === 0) {
      // A full record took every property: one it has no hash for was absent then. Absent still: unchanged.
      if (rec.full && hashProp(node, p, ctx) === undefined) continue;
      if (explainedBy(node, [p], affected, ctx)) continue;
      return false;
    }
    const h = hashProp(node, p, ctx);
    if (!h || h.hash !== want) return false;
    if (h.bound) {
      modes ??= modesHash(node);
      if (rec.h[MODES_SLOT] !== modes) return false;
    }
  }
  return true;
}

/**
 * Whether a change to a node the agent has no record of is explained by the
 * agent's own variable or style writes: every property it names follows only
 * variables and styles in `affected`.
 */
export function explainedBy(node: unknown, props: readonly string[], affected: ReadonlySet<string>, ctx?: HashContext): boolean {
  if (!props.length || !affected.size) return false;
  for (const p of props) {
    const h = hashProp(node, p, ctx);
    if (!h || !h.linked || !h.refs.length || !h.refs.every((id) => affected.has(id))) return false;
  }
  return true;
}

// ── the resource watch ──────────────────────────────────────────────────────

export interface Resource {
  hash: number;
  name: string;
  kind: "variable" | "collection" | "style";
}

/** The file's local variables, collections and styles, hashed, with what each references. */
export interface Resources {
  items: Map<string, Resource>;
  /** Per id, the variables it references: an alias, a variable bound inside a style. */
  deps: Map<string, string[]>;
}

const VARIABLE_FIELDS = ["name", "resolvedType", "valuesByMode", "scopes", "codeSyntax", "description", "hiddenFromPublishing"];
const COLLECTION_FIELDS = ["name", "modes", "defaultModeId", "hiddenFromPublishing", "variableIds"];
const STYLE_FIELDS = [
  "name", "type", "description", "paints", "effects", "layoutGrids", "fontName", "fontSize", "lineHeight", "letterSpacing",
  "paragraphIndent", "paragraphSpacing", "listSpacing", "textCase", "textDecoration", "leadingTrim", "boundVariables",
];
const STYLE_GETTERS = ["getLocalPaintStylesAsync", "getLocalTextStylesAsync", "getLocalEffectStylesAsync", "getLocalGridStylesAsync"];

/** Read every local variable, collection and style; null when this editor has none of the APIs. */
export async function readResources(api: unknown): Promise<Resources | null> {
  const items = new Map<string, Resource>();
  const deps = new Map<string, string[]>();
  let any = false;
  const list = async (owner: unknown, name: string): Promise<readonly unknown[] | null> => {
    const fn = field<() => Promise<unknown>>(owner, name);
    if (typeof fn !== "function") return null;
    try {
      const got = await fn.call(owner);
      return Array.isArray(got) ? got : null;
    } catch {
      return null;
    }
  };
  const add = (x: unknown, kind: Resource["kind"], fields: readonly string[]) => {
    const id = field(x, "id");
    if (typeof id !== "string") return;
    const o = newOut();
    for (const f of fields) {
      put(o, `${f}:`);
      write(field(x, f), o, false);
      put(o, ";");
    }
    items.set(id, { hash: fnv(joined(o)), name: String(field(x, "name") ?? ""), kind });
    deps.set(id, o.refs);
  };
  const vars = field(api, "variables");
  const variables = await list(vars, "getLocalVariablesAsync");
  if (variables) {
    any = true;
    for (const v of variables) add(v, "variable", VARIABLE_FIELDS);
  }
  const collections = await list(vars, "getLocalVariableCollectionsAsync");
  if (collections) {
    any = true;
    for (const c of collections) add(c, "collection", COLLECTION_FIELDS);
  }
  for (const getter of STYLE_GETTERS) {
    const styles = await list(api, getter);
    if (!styles) continue;
    any = true;
    for (const s of styles) add(s, "style", STYLE_FIELDS);
  }
  return any ? { items, deps } : null;
}

/** What differs between two readings: changed, added or removed. */
export function changedBetween(before: Resources, after: Resources): Array<{ id: string; name: string; kind: Resource["kind"] }> {
  const out: Array<{ id: string; name: string; kind: Resource["kind"] }> = [];
  for (const [id, r] of after.items) {
    const was = before.items.get(id);
    if (!was || was.hash !== r.hash) out.push({ id, name: r.name, kind: r.kind });
  }
  for (const [id, r] of before.items) if (!after.items.has(id)) out.push({ id, name: r.name, kind: r.kind });
  return out;
}

/** `ids` and everything that resolves through them: a variable aliasing one, a style binding one. */
export function dependentsOf(ids: readonly string[], state: Resources): Set<string> {
  const users = new Map<string, string[]>();
  for (const [id, refs] of state.deps) {
    for (const r of refs) {
      const list = users.get(r);
      if (list) list.push(id);
      else users.set(r, [id]);
    }
  }
  const out = new Set<string>(ids);
  const queue = [...ids];
  for (let i = 0; i < queue.length; i++) {
    for (const u of users.get(queue[i]!) ?? []) {
      if (out.has(u)) continue;
      out.add(u);
      queue.push(u);
    }
  }
  return out;
}
