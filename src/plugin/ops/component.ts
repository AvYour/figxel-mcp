// Components (spec §12 phase 3): place an instance, swap what an instance
// shows, detach it back to a frame. Converting a frame into a component is
// figma_convert_to_component in create.ts; building one inside a spec is the
// `component` spec type.
//
// API per @figma/plugin-typings 1.141.0: createInstance() and swapComponent()
// are methods on ComponentNode / InstanceNode, detachInstance() on an instance.
//
// Every write op here runs its checks through beforeMutating (guard.ts): a
// refusal that changed nothing says so with `partial: { created: [] }`.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { instantiate } from "./create.js";
import { requireIds, resolveAll, type ItemResult } from "./modify.js";
import { findStyle } from "../bind.js";
import { beforeMutating, unchanged } from "../guard.js";
import { ensureLoaded, loadAllPages } from "../pages.js";
import { byId, decodeCursor, encodeCursor, int, pagesOf, reqStr, str, walk, type FigmaLike, type NodeLike } from "../read.js";
import { append, applySizing, num, parentFor, parseSizing, type FigmaWrite, type NodeLikeW } from "../write.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;

type Any = Record<string, unknown>;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A node that must be a COMPONENT or COMPONENT_SET. */
async function componentById(id: string | undefined, field = "componentId"): Promise<NodeLikeW> {
  if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` is required.`);
  const node = await api().getNodeByIdAsync(id);
  if (!node) {
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`, { hint: "figma_get_local_components lists the components in this file." });
  }
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is a ${node.type}, not a component.`, {
      hint: "figma_get_local_components lists the components in this file.",
    });
  }
  return node;
}

const isRemote = (n: unknown) => (n as { remote?: unknown } | null)?.remote === true;

/** A library asset cannot be edited from a file that uses it (typings 9344: "Remote components are read-only") [C-111]. */
function refuseRemote(n: NodeLikeW | { id: string; name: string }, what: string): void {
  if (isRemote(n)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${n.id}\` ("${n.name}") is a library ${what}: read-only in this file.`, {
      hint: "Change it in its library file and publish; this file picks the update up from the library.",
    });
  }
}

// ── where a component's properties live ─────────────────────────────────────

interface PropertyDef {
  type: string;
  defaultValue?: unknown;
  variantOptions?: string[];
  preferredValues?: Array<{ type: string; key: string }>;
  description?: string;
}
type Defs = Record<string, PropertyDef>;

/** componentPropertyDefinitions of a node that owns them — never a variant [C-114]. Throws whatever Figma throws. */
function readDefs(owner: NodeLikeW): Defs {
  const d = (owner as unknown as { componentPropertyDefinitions?: Defs }).componentPropertyDefinitions;
  return d && typeof d === "object" ? d : {};
}

/**
 * The node that owns a component's property definitions: a component set for
 * its variants, a plain component for itself, the main component (or its set)
 * for an instance. Reading the definitions on a variant throws, optional
 * chaining included, so nothing here touches the getter until the owner is
 * known [C-114].
 */
export async function propertyOwner(node: NodeLikeW): Promise<{ component: NodeLikeW; owner: NodeLikeW; instance?: NodeLikeW }> {
  let component = node;
  let instance: NodeLikeW | undefined;
  if (node.type === "INSTANCE") {
    const getMain = (node as unknown as { getMainComponentAsync?: () => Promise<NodeLikeW | null> }).getMainComponentAsync;
    const main = typeof getMain === "function" ? await getMain.call(node) : null;
    if (!main) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `The instance \`${node.id}\` has no main component (it may have been deleted).`);
    instance = node;
    component = main;
  }
  const at = instance ? { instance } : {};
  if (component.type === "COMPONENT_SET") return { component, owner: component, ...at };
  if (component.type !== "COMPONENT") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${node.id}\` is a ${node.type}, not a component, component set or instance.`, {
      hint: "figma_get_local_components lists the components in this file.",
    });
  }
  return { component, owner: component.parent?.type === "COMPONENT_SET" ? component.parent : component, ...at };
}

/** A COMPONENT or COMPONENT_SET to change definitions on: a variant is redirected to its set. */
async function ownerForWrite(id: string | undefined): Promise<{ owner: NodeLikeW; redirectedFrom?: string }> {
  const comp = await componentById(id);
  refuseRemote(comp, "component");
  if (comp.type === "COMPONENT" && comp.parent?.type === "COMPONENT_SET") return { owner: comp.parent, redirectedFrom: comp.id };
  return { owner: comp };
}

// ── variants by their values ────────────────────────────────────────────────

/** "Size=Large, State=Hover" → { Size: "Large", State: "Hover" }: how Figma names a variant. */
export function parseVariant(text: string, field = "variant"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must read "Property=Value, Other=Value" — "${pair}" has no "=".`);
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  if (Object.keys(out).length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must read "Property=Value, Other=Value".`);
  return out;
}

/** A variant's values: variantProperties (not deprecated on variants, typings 9653), else its name. */
function variantValues(c: NodeLikeW): Record<string, string> {
  try {
    const vp = (c as unknown as { variantProperties?: Record<string, string> | null }).variantProperties;
    if (vp && typeof vp === "object") return { ...vp };
  } catch {
    /* not a variant: fall back to the name */
  }
  try {
    return parseVariant(c.name);
  } catch {
    return {};
  }
}

/**
 * The variant of `set` whose values match every pair in `text`. A partial
 * match ("Size=Large" on a Size × State set) takes the default variant's other
 * values — what switching one property in Figma's panel does — and is refused
 * only when even that leaves a tie.
 */
export function pickVariant(set: NodeLikeW, text: string): NodeLikeW {
  const wanted = parseVariant(text);
  const variants = (set.children ?? []).filter((c) => c.type === "COMPONENT");
  const hits = variants.filter((v) => {
    const vals = variantValues(v);
    return Object.entries(wanted).every(([k, val]) => vals[k] === val);
  });
  if (hits.length === 1) return hits[0]!;
  const list = variants.map((v) => v.name).slice(0, 30).join("; ");
  if (hits.length === 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `No variant of "${set.name}" is ${text}.`, { hint: `Its variants: ${list || "none"}.` });
  }
  const dv = (set as unknown as { defaultVariant?: NodeLikeW }).defaultVariant;
  const base = dv ? variantValues(dv) : {};
  const near = hits.filter((v) => Object.entries(variantValues(v)).every(([k, val]) => k in wanted || base[k] === val));
  if (near.length === 1) return near[0]!;
  throw new BridgeError(ErrorCode.INVALID_PARAM, `${hits.length} variants of "${set.name}" match ${text}.`, {
    hint: `Name every property: ${hits.map((h) => h.name).slice(0, 10).join("; ")}.`,
  });
}

// ── library assets by key [C-110] ───────────────────────────────────────────

const ASSET_KINDS = ["component", "component_set", "style", "variable"] as const;
type AssetKind = (typeof ASSET_KINDS)[number];
const IMPORTER: Record<AssetKind, string> = {
  component: "importComponentByKeyAsync",
  component_set: "importComponentSetByKeyAsync",
  style: "importStyleByKeyAsync",
  variable: "importVariableByKeyAsync",
};

/**
 * Import one published asset. Figma rejects a key with no PUBLISHED asset
 * behind it — a local component has a key but does not import (typings 9348)
 * — and its own reason is passed on [C-110]. The importers are feature-
 * detected, so an editor without them says which call is missing.
 */
async function importAsset(kind: AssetKind, key: string): Promise<Any & { id: string; name: string }> {
  const f = api() as unknown as Any & { variables?: Any };
  const holder = kind === "variable" ? f.variables : f;
  const call = IMPORTER[kind];
  const fn = holder?.[call];
  if (typeof fn !== "function") {
    throw new BridgeError(ErrorCode.UNSUPPORTED, `figma.${kind === "variable" ? "variables." : ""}${call} is not available in this editor.`);
  }
  try {
    return (await (fn as (k: string) => Promise<Any & { id: string; name: string }>).call(holder, key)) as Any & { id: string; name: string };
  } catch (err) {
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `Figma could not import the ${kind.replace("_", " ")} with key "${key}": ${message(err)}`, {
      hint: "Only assets published to a library this file can use import by key; a local component has a key but imports only once published.",
    });
  }
}

/**
 * The component to place or swap to, from `componentId`, `componentKey` or
 * `componentSetKey` (exactly one) plus an optional `variant`. A key is
 * imported here, before anything is placed: an import adds no layer, so a
 * failure up to this point still changed nothing.
 */
export async function resolveComponentRef(params: Record<string, unknown>): Promise<{ comp: NodeLikeW; target: NodeLikeW; imported?: { kind: string; key: string } }> {
  const id = str(params, "componentId");
  const key = str(params, "componentKey");
  const setKey = str(params, "componentSetKey");
  const given = [id && "componentId", key && "componentKey", setKey && "componentSetKey"].filter((x): x is string => !!x);
  if (given.length === 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`componentId` is required (or `componentKey` / `componentSetKey` for a library component).");
  }
  if (given.length > 1) throw new BridgeError(ErrorCode.INVALID_PARAM, `Give one of componentId, componentKey or componentSetKey — not ${given.join(" and ")}.`);
  let comp: NodeLikeW;
  let imported: { kind: string; key: string } | undefined;
  if (id) {
    comp = await componentById(id);
  } else {
    const kind: AssetKind = key ? "component" : "component_set";
    comp = (await importAsset(kind, (key ?? setKey)!)) as unknown as NodeLikeW;
    imported = { kind, key: (key ?? setKey)! };
  }
  let target = comp;
  const variant = str(params, "variant");
  if (variant) {
    // A variant id with `variant` means "another variant of this one's set".
    const set = comp.type === "COMPONENT_SET" ? comp : comp.parent?.type === "COMPONENT_SET" ? comp.parent : null;
    if (!set) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`variant\` picks a variant of a component set; \`${comp.id}\` is a single ${comp.type}.`);
    target = pickVariant(set, variant);
  }
  return { comp, target, ...(imported ? { imported } : {}) };
}

// ── instances ───────────────────────────────────────────────────────────────

const createInstance: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    // Everything resolved before the instance exists — a library import too.
    // The parent is checked first, so a bad parentId costs no import.
    const p = await beforeMutating(async () => {
      const sizing = parseSizing(ctx.params.sizing);
      const parent = await parentFor(figma, str(ctx.params, "parentId"));
      return { sizing, parent, ...(await resolveComponentRef(ctx.params)) };
    });
    const node = instantiate(p.target);
    append(p.parent, node);
    const x = num(ctx.params, "x");
    const y = num(ctx.params, "y");
    const at = node as unknown as { x: number; y: number };
    if (x !== undefined) at.x = x;
    if (y !== undefined) at.y = y;
    try {
      applySizing(node, p.sizing);
    } catch (err) {
      node.remove?.();
      unchanged(err);
    }
    // Report the component actually placed: for a set, that is its default variant.
    const placed = p.target.type === "COMPONENT_SET" ? (p.target as unknown as { defaultVariant: NodeLikeW }).defaultVariant : p.target;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      componentId: placed.id,
      ...(placed !== p.comp ? { componentSetId: p.comp.type === "COMPONENT_SET" ? p.comp.id : placed.parent?.id } : {}),
      ...(p.imported ? { imported: p.imported } : {}),
    };
  },
};

const swapComponent: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      const node = await api().getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`);
      const inst = node as unknown as { swapComponent?: (c: NodeLikeW) => void };
      if (node.type !== "INSTANCE" || typeof inst.swapComponent !== "function") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is a ${node.type}, not an instance.`);
      }
      const ref = await resolveComponentRef(ctx.params);
      // A component set swaps to its default variant, as Figma's own swap menu does.
      const target = ref.target.type === "COMPONENT_SET" ? (ref.target as unknown as { defaultVariant: NodeLikeW }).defaultVariant : ref.target;
      return { node, swap: inst.swapComponent, target, imported: ref.imported };
    });
    p.swap.call(p.node, p.target);
    return { id: p.node.id, name: p.node.name, componentId: p.target.id, ...(p.imported ? { imported: p.imported } : {}) };
  },
};

const detachInstance: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const ids = await beforeMutating(() => requireIds(ctx));
    const items: Array<ItemResult & { frameId?: string }> = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const inst = node as unknown as { detachInstance?: () => NodeLikeW };
      if (node.type !== "INSTANCE" || typeof inst.detachInstance !== "function") {
        items.push({ id, ok: false, error: `a ${node.type} is not an instance` });
        continue;
      }
      try {
        // The frame that replaces the instance has its own id; report it, or the
        // agent would keep addressing a node that no longer exists.
        const frame = inst.detachInstance();
        items.push({ id, ok: true, frameId: frame.id });
      } catch (err) {
        items.push({ id, ok: false, error: message(err) });
      }
    }
    return { detached: items.filter((i) => i.ok).length, items };
  },
};

// ── variants and component properties [C-083] ───────────────────────────────
//
// figma.combineAsVariants(components, parent, index?) → ComponentSetNode (there
// is no createComponentSet: an empty set is not supported). A variant's values
// live in its NAME ("Size=Large, State=Hover"), which is how Figma derives the
// VARIANT properties of the set. addComponentProperty(name, type, default) on a
// COMPONENT or COMPONENT_SET returns the property key with its "#id" suffix; a
// layer inside is wired to it through `componentPropertyReferences`
// (characters / visible / mainComponent). InstanceNode.setProperties({ key: value }).

const GRID_PADDING = 40;

/**
 * Lay a set out as the official library skill does: one column per value of
 * `columns`, one row per combination of the other properties, every cell the
 * size of the largest variant so the columns line up. Positions come back in
 * page coordinates, for header labels placed outside the set.
 */
function gridLayout(set: NodeLikeW, columns: string, gap: number) {
  const s = set as unknown as Any & { resizeWithoutConstraints?: (w: number, h: number) => void; resize?: (w: number, h: number) => void };
  const variants = (set.children ?? []).filter((c) => c.type === "COMPONENT") as Array<NodeLikeW & { x: number; y: number; width: number; height: number }>;
  const values = variants.map(variantValues);
  let defs: Defs = {};
  try {
    defs = readDefs(set);
  } catch {
    /* a set Figma reports as broken: order by first appearance instead */
  }
  const optionsOf = (prop: string): string[] => {
    const seen = values.map((v) => v[prop]).filter((v): v is string => v !== undefined);
    const declared = defs[prop]?.variantOptions ?? [];
    return [...new Set([...declared.filter((o) => seen.includes(o)), ...seen])];
  };
  const others = [...new Set(values.flatMap((v) => Object.keys(v)))].filter((p) => p !== columns);
  const colValues = optionsOf(columns);
  const rank = others.map((p) => optionsOf(p));
  const rowOf = (v: Record<string, string>) => others.map((p) => `${p}=${v[p] ?? ""}`).join(", ");
  const rowKeys = [...new Set(values.map(rowOf))].sort((a, b) => {
    const va = a.split(", ").map((pair, i) => rank[i]!.indexOf(pair.slice(pair.indexOf("=") + 1)));
    const vb = b.split(", ").map((pair, i) => rank[i]!.indexOf(pair.slice(pair.indexOf("=") + 1)));
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return va[i]! - vb[i]!;
    return 0;
  });
  const cellW = Math.max(...variants.map((v) => v.width));
  const cellH = Math.max(...variants.map((v) => v.height));
  if ("layoutMode" in s) s.layoutMode = "NONE";
  variants.forEach((v, i) => {
    v.x = GRID_PADDING + colValues.indexOf(values[i]![columns]!) * (cellW + gap);
    v.y = GRID_PADDING + rowKeys.indexOf(rowOf(values[i]!)) * (cellH + gap);
  });
  const width = GRID_PADDING * 2 + colValues.length * cellW + (colValues.length - 1) * gap;
  const height = GRID_PADDING * 2 + rowKeys.length * cellH + (rowKeys.length - 1) * gap;
  if (typeof s.resizeWithoutConstraints === "function") s.resizeWithoutConstraints(width, height);
  else if (typeof s.resize === "function") s.resize(width, height);
  const t = s.absoluteTransform as number[][] | undefined;
  const ox = Array.isArray(t) ? t[0]![2]! : Number(s.x ?? 0);
  const oy = Array.isArray(t) ? t[1]![2]! : Number(s.y ?? 0);
  return {
    columns: colValues.map((value, i) => ({ value, x: ox + GRID_PADDING + i * (cellW + gap) })),
    rows: rowKeys.map((label, i) => ({ label: label || set.name, y: oy + GRID_PADDING + i * (cellH + gap) })),
    cell: { width: cellW, height: cellH },
  };
}

const combineAsVariants: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api() as unknown as FigmaWrite & { combineAsVariants?: (n: readonly NodeLikeW[], p: NodeLikeW, i?: number) => NodeLikeW };
    const p = await beforeMutating(async () => {
      const ids = Array.isArray(ctx.params.componentIds) ? (ctx.params.componentIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (ids.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`componentIds` must list at least one component.");
      const comps: NodeLikeW[] = [];
      for (const id of ids) {
        const c = await componentById(id, "componentIds");
        if (c.type !== "COMPONENT") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is already a component set.`);
        if (c.parent?.type === "COMPONENT_SET") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is already a variant of a set.`);
        comps.push(c);
      }
      if (comps.some((c) => c.parent?.id !== comps[0]!.parent?.id)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "The components do not share one parent.", { hint: "figma_reparent_nodes them into the same frame or page first." });
      }
      // Two variants with the same values make a set Figma reports as broken —
      // one that cannot even list its properties — so they are refused while
      // nothing exists. Pairs are compared sorted: "A=1, B=2" is "B=2, A=1".
      const byValues = new Map<string, NodeLikeW>();
      for (const c of comps) {
        let values: Record<string, string>;
        try {
          values = parseVariant(c.name);
        } catch {
          continue; // not "Property=Value": no values to compare
        }
        const key = Object.keys(values).sort().map((k) => `${k}=${values[k]}`).join(", ");
        const twin = byValues.get(key);
        if (twin && twin.id !== c.id) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${twin.id}\` and \`${c.id}\` are both "${key}": two variants with the same values make a set Figma reports as broken.`, {
            hint: "figma_rename_node one of them first.",
          });
        }
        byValues.set(key, c);
      }
      const description = ctx.params.description;
      if (description !== undefined && typeof description !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`description` must be text.");
      const gap = num(ctx.params, "gap") ?? 24;
      if (gap < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`gap` must be 0 or more.");
      const columns = str(ctx.params, "columns");
      if (columns) {
        if (ctx.params.arrange === false) throw new BridgeError(ErrorCode.INVALID_PARAM, "`columns` lays the variants out as a grid; drop `arrange: false`.");
        // The set does not exist yet, so its properties are read off the names
        // Figma will derive them from.
        const values = comps.map((c) => {
          try {
            return parseVariant(c.name);
          } catch {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${c.id}\` is named "${c.name}", not "Property=Value" — \`columns\` needs every variant named that way.`, {
              hint: "figma_rename_node each component first.",
            });
          }
        });
        const missing = comps.filter((_, i) => !(columns in values[i]!));
        if (missing.length) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`columns: "${columns}"\` is not a property of every variant (${missing.map((m) => `"${m.name}"`).join(", ")}).`, {
            hint: `Their properties: ${[...new Set(values.flatMap((v) => Object.keys(v)))].join(", ")}.`,
          });
        }
      }
      if (typeof figma.combineAsVariants !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot combine variants.");
      return { comps, description: description as string | undefined, gap, columns };
    });
    const parent = p.comps[0]!.parent!;
    const kids = parent.children ?? [];
    const index = Math.min(...p.comps.map((c) => kids.findIndex((k) => k.id === c.id)).filter((i) => i >= 0));
    let set: NodeLikeW;
    try {
      set = figma.combineAsVariants!(p.comps, parent, Number.isFinite(index) ? index : undefined);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused to combine: ${message(err)}`, { partial: { created: [] } });
    }
    const name = str(ctx.params, "name");
    if (name) set.name = name;
    const s = set as unknown as Any;
    if (p.description !== undefined) s.description = p.description;
    let grid: ReturnType<typeof gridLayout> | undefined;
    if (p.columns) {
      grid = gridLayout(set, p.columns, p.gap);
    } else if (ctx.params.arrange !== false && "layoutMode" in s) {
      // A set has no layout of its own: lay the variants out in a wrapping row so
      // they do not sit on top of each other where they were.
      s.layoutMode = "HORIZONTAL";
      s.layoutWrap = "WRAP";
      s.itemSpacing = p.gap;
      s.counterAxisSpacing = p.gap;
      s.paddingTop = s.paddingRight = s.paddingBottom = s.paddingLeft = 24;
      s.primaryAxisSizingMode = "AUTO";
      s.counterAxisSizingMode = "AUTO";
    }
    // The set exists by now, so a set Figma reports as broken (the getter
    // throws, as gridLayout expects) must still come back with its id.
    let props: Defs = {};
    let propertiesError: string | undefined;
    try {
      props = readDefs(set);
    } catch (err) {
      propertiesError = message(err);
    }
    return {
      id: set.id, name: set.name, type: set.type,
      variants: (set.children ?? []).map((c) => ({ id: c.id, name: c.name })),
      properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.variantOptions ?? v.type])),
      ...(propertiesError
        ? { propertiesError, hint: "Figma reports the set as broken, usually two variants with the same values: figma_rename_node one of them." }
        : {}),
      ...(p.description !== undefined ? { description: s.description } : {}),
      ...(grid ? { grid } : {}),
      note: 'Variant values come from each component\'s name, "Property=Value, Other=Value" — rename a variant to change them.',
    };
  },
};

const PROP_TYPES = ["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"] as const;
/** Which layer field a property of each type drives (componentPropertyReferences). */
const BINDS: Record<string, string> = { TEXT: "characters", BOOLEAN: "visible", INSTANCE_SWAP: "mainComponent" };

type Refs = Record<string, string>;
const refsOf = (n: NodeLikeW): Refs => {
  try {
    return { ...(((n as unknown as Any).componentPropertyReferences as Refs | null) ?? {}) };
  } catch {
    return {};
  }
};

/**
 * A layer inside `owner` that a property of `type` can drive. The sublayers of
 * a nested instance reference THAT instance's main component (typings 6624),
 * as ownLayers assumes, so they are refused here — before the property exists
 * — rather than by Figma after it. The nested instance itself stays bindable.
 */
async function layerToWire(owner: NodeLikeW, id: string, type: string): Promise<NodeLikeW> {
  const n = await api().getNodeByIdAsync(id);
  if (!n) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No layer \`${id}\` to bind.`);
  let p: NodeLikeW | null | undefined = n.parent;
  let nested: NodeLikeW | undefined;
  while (p && p.id !== owner.id) {
    if (p.type === "INSTANCE") nested = p; // the last one met is the outermost: the owner's own layer
    p = p.parent;
  }
  if (!p) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is not inside \`${owner.id}\`.`);
  if (nested) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is inside the nested instance \`${nested.id}\` (${nested.name}); its layers answer to that instance's own component.`, {
      hint: "Bind the nested instance itself (BOOLEAN shows or hides it, INSTANCE_SWAP swaps it), or add the property on its main component (figma_get_component on the instance gives that id).",
    });
  }
  if (type === "TEXT" && n.type !== "TEXT") throw new BridgeError(ErrorCode.INVALID_PARAM, `A TEXT property drives text; \`${id}\` is a ${n.type}.`);
  if (type === "INSTANCE_SWAP" && n.type !== "INSTANCE") throw new BridgeError(ErrorCode.INVALID_PARAM, `An INSTANCE_SWAP property drives an instance; \`${id}\` is a ${n.type}.`);
  return n;
}

/**
 * On a set, a layer wired in one variant is wired in every variant that has a
 * layer at the same name path — otherwise switching an instance to another
 * variant silently drops the property (measured live: the label stayed
 * "Button" after a switch to a variant whose label was never wired). `fits`
 * says whether a twin qualifies; a variant without one is reported.
 */
function withTwins(owner: NodeLikeW, layers: NodeLikeW[], fits: (twin: NodeLikeW) => boolean): { layers: NodeLikeW[]; unmatched: Array<{ variant: string; path: string }> } {
  const out = [...layers];
  const unmatched: Array<{ variant: string; path: string }> = [];
  if (owner.type !== "COMPONENT_SET") return { layers: out, unmatched };
  const seen = new Set(layers.map((l) => l.id));
  for (const layer of layers) {
    const at = variantPath(layer, owner.id);
    if (!at) continue;
    for (const variant of owner.children ?? []) {
      if (variant.id === at.variant.id || variant.type !== "COMPONENT") continue;
      const twin = followPath(variant, at.path);
      if (!twin || !fits(twin)) {
        unmatched.push({ variant: variant.name, path: at.path.join(" / ") });
      } else if (!seen.has(twin.id)) {
        seen.add(twin.id);
        out.push(twin);
      }
    }
  }
  return { layers: out, unmatched };
}

const typeFits = (type: string) => (n: NodeLikeW) => !(type === "TEXT" && n.type !== "TEXT") && !(type === "INSTANCE_SWAP" && n.type !== "INSTANCE");

/** Preferred swap targets are KEYS, not ids (InstanceSwapPreferredValue, typings 11082) [C-111]. */
async function toPreferred(ids: string[]): Promise<Array<{ type: string; key: string }>> {
  const out: Array<{ type: string; key: string }> = [];
  for (const id of ids) {
    const n = await componentById(id, "preferredValues");
    const key = (n as unknown as { key?: unknown }).key;
    if (typeof key !== "string" || !key) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` has no component key to offer as a preferred value.`);
    out.push({ type: n.type, key });
  }
  return out;
}

const idList = (params: Record<string, unknown>, key: string): string[] =>
  Array.isArray(params[key]) ? (params[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

const addComponentProperty: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const comp = await componentById(str(ctx.params, "componentId"));
      const owner = comp as unknown as Any & { addComponentProperty?: (n: string, t: string, d: unknown, o?: unknown) => string };
      const name = str(ctx.params, "name");
      const type = (str(ctx.params, "type") ?? "").toUpperCase();
      if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` is required.");
      if (!(PROP_TYPES as readonly string[]).includes(type)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`type\` must be ${PROP_TYPES.join(", ")}.`);
      if (comp.type === "COMPONENT" && comp.parent?.type === "COMPONENT_SET") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${comp.id}\` is a variant; add the property to its set \`${comp.parent.id}\`.`);
      }
      refuseRemote(comp, "component");
      if (type === "VARIANT" && comp.type !== "COMPONENT_SET") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "A VARIANT property belongs on a component set (figma_combine_as_variants first).");
      }
      const rawDefault = ctx.params.defaultValue;
      const def = type === "BOOLEAN" ? rawDefault === true || rawDefault === "true" : typeof rawDefault === "string" ? rawDefault : undefined;
      if (def === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`defaultValue` is required (text, \"true\"/\"false\", or a component id for INSTANCE_SWAP).");
      const prefIds = idList(ctx.params, "preferredValues");
      if (prefIds.length && type !== "INSTANCE_SWAP") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`preferredValues\` belong to an INSTANCE_SWAP property, not ${type}.`);
      }
      const preferredValues = prefIds.length ? await toPreferred(prefIds) : undefined;

      // Layers to wire, checked before the property exists.
      const bindIds = idList(ctx.params, "bindNodeIds");
      const field = BINDS[type];
      if (bindIds.length && !field) throw new BridgeError(ErrorCode.INVALID_PARAM, "A VARIANT property is not bound to layers; it comes from variant names.");
      const picked: NodeLikeW[] = [];
      for (const id of bindIds) picked.push(await layerToWire(comp, id, type));
      const { layers, unmatched } = picked.length ? withTwins(comp, picked, typeFits(type)) : { layers: picked, unmatched: [] };

      // A retry, or a variant added later, must not mint "Label#2:0" next to
      // "Label#1:0": a property of the same name and type is reused, and the
      // new layers are wired to it.
      let defs: Defs = {};
      try {
        defs = readDefs(comp);
      } catch {
        /* a set Figma reports as broken: its own addComponentProperty says why */
      }
      const existing = Object.keys(defs).find((k) => k.split("#")[0] === name && defs[k]!.type === type);
      if (!existing && typeof owner.addComponentProperty !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This node cannot take component properties.");
      return { comp, owner, name, type, def, preferredValues, field, layers, unmatched, existing, existingDef: existing ? defs[existing] : undefined };
    });

    let key: string;
    if (p.existing) {
      key = p.existing;
    } else {
      try {
        key = p.preferredValues
          ? p.owner.addComponentProperty!(p.name, p.type, p.def, { preferredValues: p.preferredValues })
          : p.owner.addComponentProperty!(p.name, p.type, p.def);
      } catch (err) {
        unchanged(new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the property: ${message(err)}`));
      }
    }
    const bound: string[] = [];
    for (const layer of p.layers) {
      (layer as unknown as Any).componentPropertyReferences = { ...refsOf(layer), [p.field!]: key };
      bound.push(layer.id);
    }
    const notes: string[] = [];
    if (p.existing) {
      const kept = p.existingDef?.defaultValue;
      if (kept !== undefined && kept !== p.def) notes.push(`Kept its default ${JSON.stringify(kept)}; figma_edit_component_property changes it.`);
      if (p.preferredValues) notes.push("Kept its preferred values; figma_edit_component_property changes them.");
    }
    if (p.unmatched.length) {
      notes.push("Some variants have no layer at the same name path, so the property does nothing in them — bind their layer with another call or rename it to match.");
    }
    return {
      componentId: p.comp.id, key, type: p.type,
      defaultValue: p.existing ? p.existingDef?.defaultValue ?? p.def : p.def,
      bound,
      ...(p.existing ? { reused: true } : {}),
      ...(p.preferredValues && !p.existing ? { preferredValues: p.preferredValues } : {}),
      ...(p.unmatched.length ? { unmatched: p.unmatched } : {}),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  },
};

/** The variant a layer sits in, and the layer names from that variant down to it. */
function variantPath(layer: NodeLikeW, setId: string): { variant: NodeLikeW; path: string[] } | undefined {
  const path: string[] = [];
  let n: NodeLikeW | null | undefined = layer;
  while (n && n.parent && n.parent.id !== setId) {
    path.unshift(n.name);
    n = n.parent;
  }
  return n && n.parent?.id === setId ? { variant: n, path } : undefined;
}

/**
 * The one layer at a name path below `root`, or undefined when absent,
 * ambiguous, or inside a nested instance (whose layers answer to its own
 * component, as in layerToWire).
 */
function followPath(root: NodeLikeW, path: string[]): NodeLikeW | undefined {
  let at: NodeLikeW = root;
  for (const name of path) {
    if (at.type === "INSTANCE") return undefined;
    const hits = (at.children ?? []).filter((c) => c.name === name);
    if (hits.length !== 1) return undefined;
    at = hits[0]!;
  }
  return at === root ? undefined : at;
}

/** Resolve "Label" to "Label#2:0" — callers know names, Figma keys carry an id suffix. */
export function resolvePropertyKey(defs: Record<string, { type: string }>, wanted: string): string | undefined {
  if (wanted in defs) return wanted;
  const matches = Object.keys(defs).filter((k) => k.split("#")[0] === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Every layer of a component or set that can reference its properties: the
 * sublayers of a nested instance reference THAT instance's main component
 * (typings 6624), so instances are not descended into.
 */
function ownLayers(owner: NodeLikeW): NodeLikeW[] {
  const out: NodeLikeW[] = [];
  const stack = [...(owner.children ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    if (n.type !== "INSTANCE") stack.push(...(n.children ?? []));
  }
  return out;
}

/** The property `wanted` names on `owner`, or INVALID_PARAM listing what exists. */
function propertyOn(owner: NodeLikeW, wanted: string | undefined): { defs: Defs; key: string; def: PropertyDef } {
  if (!wanted) throw new BridgeError(ErrorCode.INVALID_PARAM, "`property` is required: its name (\"Label\") or full key (\"Label#2:0\").");
  let defs: Defs;
  try {
    defs = readDefs(owner);
  } catch (err) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma cannot read the properties of \`${owner.id}\`: ${message(err)}`);
  }
  const key = resolvePropertyKey(defs, wanted);
  if (!key) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${owner.id}\` has no single property "${wanted}".`, {
      hint: `Its properties: ${Object.keys(defs).map((k) => `${k} (${defs[k]!.type})`).join(", ") || "none"}.`,
    });
  }
  return { defs, key, def: defs[key]! };
}

const editComponentProperty: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const { owner, redirectedFrom } = await ownerForWrite(str(ctx.params, "componentId"));
      const { key, def } = propertyOn(owner, str(ctx.params, "property"));
      const type = def.type;
      const rename = ctx.params.name;
      if (rename !== undefined && (typeof rename !== "string" || !rename.trim())) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` must be non-empty text.");
      const hasDefault = ctx.params.defaultValue !== undefined;
      const hasPreferred = Array.isArray(ctx.params.preferredValues);
      const bindIds = idList(ctx.params, "bindNodeIds");
      const unbindIds = idList(ctx.params, "unbindNodeIds");
      if (rename === undefined && !hasDefault && !hasPreferred && !bindIds.length && !unbindIds.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Nothing to change: give name, defaultValue, preferredValues, bindNodeIds or unbindNodeIds.");
      }
      // Figma's own rules for editComponentProperty (typings 9683-9689),
      // checked here so its refusal can never land half-way [C-111].
      if (hasDefault && (type === "VARIANT" || type === "SLOT")) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${type} property has no default to edit.`, {
          hint: type === "VARIANT" ? "Its default is the set's default variant (the top-left one): move that variant instead." : "A slot's default is the content of the slot in the component itself.",
        });
      }
      if (hasPreferred && type !== "INSTANCE_SWAP" && type !== "SLOT") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`preferredValues\` apply to INSTANCE_SWAP and SLOT properties; "${key}" is ${type}.`);
      }
      const field = BINDS[type];
      if ((bindIds.length || unbindIds.length) && !field) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${type} property is not wired to layers through componentPropertyReferences.`);
      }
      let defaultValue: string | boolean | undefined;
      if (hasDefault) {
        const raw = ctx.params.defaultValue;
        if (type === "BOOLEAN") {
          if (raw !== true && raw !== false && raw !== "true" && raw !== "false") throw new BridgeError(ErrorCode.INVALID_PARAM, "A BOOLEAN default is \"true\" or \"false\".");
          defaultValue = raw === true || raw === "true";
        } else if (typeof raw !== "string") {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`defaultValue` must be text.");
        } else if (type === "INSTANCE_SWAP") {
          const c = await componentById(raw, "defaultValue");
          if (c.type !== "COMPONENT") throw new BridgeError(ErrorCode.INVALID_PARAM, `An INSTANCE_SWAP default is a component; \`${raw}\` is a set — pass one of its variants.`);
          defaultValue = c.id;
        } else {
          defaultValue = raw;
        }
      }
      const preferredValues = hasPreferred ? await toPreferred(idList(ctx.params, "preferredValues")) : undefined;
      const edit: { name?: string; defaultValue?: string | boolean; preferredValues?: Array<{ type: string; key: string }> } = {
        ...(typeof rename === "string" ? { name: rename.trim() } : {}),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(preferredValues ? { preferredValues } : {}),
      };
      const o = owner as unknown as { editComponentProperty?: (k: string, v: unknown) => string };
      if (Object.keys(edit).length && typeof o.editComponentProperty !== "function") {
        throw new BridgeError(ErrorCode.UNSUPPORTED, "editComponentProperty is not available in this editor.");
      }
      const toBind: NodeLikeW[] = [];
      for (const id of bindIds) toBind.push(await layerToWire(owner, id, type));
      const toUnbind: NodeLikeW[] = [];
      for (const id of unbindIds) {
        const n = await layerToWire(owner, id, type);
        if (refsOf(n)[field!] !== key) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is not wired to "${key}".`);
        toUnbind.push(n);
      }
      const bind = toBind.length ? withTwins(owner, toBind, typeFits(type)) : { layers: [], unmatched: [] };
      const unbind = toUnbind.length ? withTwins(owner, toUnbind, (n) => refsOf(n)[field!] === key) : { layers: [] };
      return { owner, redirectedFrom, key, type, field, edit, editFn: o.editComponentProperty, bind, unbind: unbind.layers };
    });

    let key = p.key;
    if (Object.keys(p.edit).length) {
      try {
        key = p.editFn!.call(p.owner, p.key, p.edit);
      } catch (err) {
        unchanged(new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the edit: ${message(err)}`));
      }
    }
    // Whether a rename carries the layers' references to the new key is still
    // to be measured [C-113]. Any layer left on the old key is moved over, so
    // the wiring survives either way; `rewired` says it was needed.
    let rewired = 0;
    if (key !== p.key) {
      for (const layer of ownLayers(p.owner)) {
        const refs = refsOf(layer);
        const stale = Object.keys(refs).filter((f) => refs[f] === p.key);
        if (!stale.length) continue;
        for (const f of stale) refs[f] = key;
        (layer as unknown as Any).componentPropertyReferences = refs;
        rewired++;
      }
    }
    const unbound: string[] = [];
    for (const layer of p.unbind) {
      const refs = refsOf(layer);
      if (refs[p.field!] === p.key || refs[p.field!] === key) delete refs[p.field!];
      (layer as unknown as Any).componentPropertyReferences = refs;
      unbound.push(layer.id);
    }
    const bound: string[] = [];
    for (const layer of p.bind.layers) {
      (layer as unknown as Any).componentPropertyReferences = { ...refsOf(layer), [p.field!]: key };
      bound.push(layer.id);
    }
    return {
      componentId: p.owner.id, key, type: p.type,
      ...(key !== p.key ? { previousKey: p.key } : {}),
      bound, unbound,
      ...(rewired ? { rewired } : {}),
      ...(p.bind.unmatched.length ? { unmatched: p.bind.unmatched } : {}),
      ...(p.redirectedFrom ? { note: `\`${p.redirectedFrom}\` is a variant; its set \`${p.owner.id}\` holds the property and was edited.` } : {}),
    };
  },
};

const deleteComponentProperty: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const { owner, redirectedFrom } = await ownerForWrite(str(ctx.params, "componentId"));
      const { key, def } = propertyOn(owner, str(ctx.params, "property"));
      // deleteComponentProperty takes BOOLEAN, TEXT, INSTANCE_SWAP and SLOT only (typings 9702) [C-111].
      if (def.type === "VARIANT") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `"${key}" is a VARIANT property: it comes from the variant names, and Figma cannot delete one.`, {
          hint: "Rename the variants (figma_rename_node) so no name carries it.",
        });
      }
      const del = (owner as unknown as { deleteComponentProperty?: (k: string) => void }).deleteComponentProperty;
      if (typeof del !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "deleteComponentProperty is not available in this editor.");
      return { owner, redirectedFrom, key, type: def.type, del };
    });
    try {
      p.del.call(p.owner, p.key);
    } catch (err) {
      unchanged(new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused to delete "${p.key}": ${message(err)}`));
    }
    return {
      componentId: p.owner.id, deleted: p.key, type: p.type,
      ...(p.redirectedFrom ? { note: `\`${p.redirectedFrom}\` is a variant; the property was deleted from its set \`${p.owner.id}\`.` } : {}),
    };
  },
};

const setInstanceProperties: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      let props: unknown = ctx.params.properties;
      if (typeof props === "string") {
        try {
          props = JSON.parse(props);
        } catch {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`properties` is not valid JSON, e.g. {\"Label\": \"Buy\", \"Size\": \"Large\"}.");
        }
      }
      if (!props || typeof props !== "object" || Array.isArray(props)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`properties` must be an object of name → value.");
      const node = await api().getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`);
      const inst = node as unknown as Any & { setProperties?: (p: Record<string, string | boolean>) => void };
      if (node.type !== "INSTANCE" || typeof inst.setProperties !== "function") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${id}\` is a ${node.type}, not an instance.`);
      const defs = (inst.componentProperties ?? {}) as Record<string, { type: string; value: unknown }>;
      const out: Record<string, string | boolean> = {};
      for (const [name, value] of Object.entries(props as Any)) {
        const key = resolvePropertyKey(defs, name);
        if (!key) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `The instance has no property "${name}".`, {
            hint: `Its properties: ${Object.keys(defs).map((k) => `${k} (${defs[k]!.type})`).join(", ") || "none"}.`,
          });
        }
        const type = defs[key]!.type;
        // setProperties throws cannotSetSlotProperty on a SLOT (typings 11214) [C-112].
        if (type === "SLOT") {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `"${key}" is a SLOT: a slot is filled by adding layers into it, not set.`, {
            hint: `Append children to the slot (parentId = slot id) instead${slotList(node)}; figma_reset_slot empties it again.`,
          });
        }
        out[key] = type === "BOOLEAN" ? value === true || value === "true" : String(value);
      }
      return { node, inst, out };
    });
    try {
      p.inst.setProperties!(p.out);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the properties: ${message(err)}`);
    }
    const now = (p.inst.componentProperties ?? {}) as Record<string, { value: unknown }>;
    return { id: p.node.id, name: p.node.name, properties: Object.fromEntries(Object.keys(p.out).map((k) => [k, now[k]?.value])) };
  },
};

/** ": Content (I1:2;3:4), …" — the slot layers of an instance, for a hint. */
function slotList(node: NodeLikeW): string {
  const find = (node as unknown as { findAllWithCriteria?: (c: { types: string[] }) => NodeLikeW[] }).findAllWithCriteria;
  if (typeof find !== "function") return "";
  try {
    const slots = find.call(node, { types: ["SLOT"] });
    return slots.length ? ` — its slots: ${slots.slice(0, 10).map((s) => `${s.name} (${s.id})`).join(", ")}` : "";
  } catch {
    return "";
  }
}

// ── slots [C-112] ───────────────────────────────────────────────────────────
//
// ComponentNode.createSlot() makes a SlotNode child and its SLOT property in
// one call (typings 11161); a set has no createSlot. The new property's key is
// found by diffing the definitions: the `slotContentId` reference the official
// skill reads is not in typings 1.141.0, so it is only a fallback here.

const createSlot: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const comp = await componentById(str(ctx.params, "componentId"));
      if (comp.type !== "COMPONENT") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A slot goes into a component; \`${comp.id}\` is a component set — pass one of its variants.`);
      }
      refuseRemote(comp, "component");
      const make = (comp as unknown as { createSlot?: () => NodeLikeW }).createSlot;
      if (typeof make !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "ComponentNode.createSlot is not available in this Figma version.");
      const layout = str(ctx.params, "layout")?.toLowerCase();
      if (layout !== undefined && layout !== "horizontal" && layout !== "vertical") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`layout\` must be "horizontal" or "vertical"${layout === "grid" ? ": Figma refuses a grid layout on a slot" : ""}.`);
      }
      const width = num(ctx.params, "width");
      const height = num(ctx.params, "height");
      for (const [k, v] of [["width", width], ["height", height]] as const) {
        if (v !== undefined && v <= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${k}\` must be a positive number.`);
      }
      const sizing = parseSizing(ctx.params.sizing);
      // applySizing's two rules, checked while nothing exists yet.
      const compMode = (comp as unknown as { layoutMode?: string }).layoutMode;
      const parentIsAuto = compMode === "HORIZONTAL" || compMode === "VERTICAL";
      for (const axis of ["horizontal", "vertical"] as const) {
        if (sizing?.[axis] === "FILL" && !parentIsAuto) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`sizing.${axis}: fill\` needs a component with auto-layout — \`${comp.id}\` has none.`);
        }
        if (sizing?.[axis] === "HUG" && !layout) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`sizing.${axis}: hug\` needs \`layout\`: only an auto-layout slot hugs its content.`);
      }
      const owner = comp.parent?.type === "COMPONENT_SET" ? comp.parent : comp;
      let before: Set<string> | null = null;
      try {
        before = new Set(Object.keys(readDefs(owner)));
      } catch {
        /* unreadable definitions: the key falls back to the slot's own reference */
      }
      return { comp, owner, make, layout, width, height, sizing, before, name: str(ctx.params, "name") };
    });
    // The first write: a refusal here (an editor that has createSlot but will
    // not make one) still changed nothing, and must say so.
    let slot: NodeLikeW & Any & { resize?: (w: number, h: number) => void; width?: number; height?: number };
    try {
      slot = p.make.call(p.comp) as typeof slot;
    } catch (err) {
      unchanged(new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the slot: ${message(err)}`));
    }
    try {
      if (p.name) slot.name = p.name;
      if (p.layout) slot.layoutMode = p.layout === "horizontal" ? "HORIZONTAL" : "VERTICAL";
      if ((p.width !== undefined || p.height !== undefined) && typeof slot.resize === "function") {
        slot.resize(p.width ?? Number(slot.width), p.height ?? Number(slot.height));
      }
      applySizing(slot, p.sizing);
    } catch (err) {
      // The slot and its property exist by now: say so rather than claim nothing changed.
      const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INVALID_PARAM, message(err));
      throw new BridgeError(e.code, e.message, {
        hint: `The slot \`${slot.id}\` was created; adjust it with figma_set_auto_layout / figma_resize_nodes, or delete it.`,
        partial: { created: [{ id: slot.id, name: slot.name }] },
      });
    }
    let propertyKey: string | null = null;
    try {
      const after = readDefs(p.owner);
      const added = p.before ? Object.keys(after).filter((k) => !p.before!.has(k)) : [];
      propertyKey = added.find((k) => after[k]!.type === "SLOT") ?? added[0] ?? null;
    } catch {
      /* fall through to the reference */
    }
    if (!propertyKey) propertyKey = refsOf(slot).slotContentId ?? null;
    return {
      slotId: slot.id, name: slot.name, componentId: p.comp.id, propertyKey,
      ...(propertyKey ? {} : { note: "The slot exists, but its SLOT property key could not be read back; figma_get_component lists the properties." }),
    };
  },
};

const resetSlot: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const ids = await beforeMutating(() => requireIds(ctx));
    const items: ItemResult[] = [];
    for (const { id, node } of await resolveAll(ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const s = node as unknown as { resetSlot?: () => void };
      if (node.type !== "SLOT" || typeof s.resetSlot !== "function") {
        items.push({ id, ok: false, error: `a ${node.type} is not a slot` });
        continue;
      }
      try {
        s.resetSlot();
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: message(err) });
      }
    }
    return { reset: items.filter((i) => i.ok).length, items };
  },
};

// ── descriptions [C-111] ────────────────────────────────────────────────────
//
// PublishableMixin (components, sets, styles): description, descriptionMarkdown
// and documentationLinks — one link, {uri} only (typings 9300-9342). A
// Variable has a writable description and no links (11719).

interface Describable {
  kind: "node" | "style" | "variable";
  obj: Any & { id: string; name: string };
  type: string;
}

async function describable(targetId: string): Promise<Describable & { note?: string }> {
  const f = api() as unknown as { variables?: { getVariableByIdAsync?(id: string): Promise<unknown> }; getStyleByIdAsync?(id: string): Promise<unknown> };
  if (targetId.startsWith("VariableID:")) {
    const v = (await f.variables?.getVariableByIdAsync?.(targetId)) as (Any & { id: string; name: string }) | null | undefined;
    if (!v) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No variable with id \`${targetId}\`.`, { hint: "figma_get_variable_defs lists them." });
    refuseRemote(v, "variable");
    return { kind: "variable", obj: v, type: "VARIABLE" };
  }
  if (targetId.startsWith("S:")) {
    const ref = await findStyle({ id: targetId });
    const s = (await f.getStyleByIdAsync?.(ref.id)) as (Any & { id: string; name: string }) | null | undefined;
    if (!s) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No style with id \`${targetId}\`.`, { hint: "figma_get_styles lists them." });
    refuseRemote(s, "style");
    return { kind: "style", obj: s, type: `${ref.kind}_STYLE` };
  }
  const node = await api().getNodeByIdAsync(targetId);
  if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${targetId}\`.`);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${node.type} carries no description: only components, component sets, styles and variables do.`, {
      hint: node.type === "INSTANCE" ? "Describe its main component (figma_get_component gives its id)." : "figma_convert_to_component turns a frame into a component first.",
    });
  }
  refuseRemote(node, "component");
  const variantOf = node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET" ? node.parent : null;
  return {
    kind: "node", obj: node as unknown as Any & { id: string; name: string }, type: node.type,
    ...(variantOf ? { note: `\`${node.id}\` is a variant: a description usually belongs on its set \`${variantOf.id}\`, which is what the assets panel shows.` } : {}),
  };
}

const setDescription: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const targetId = str(ctx.params, "targetId");
      if (!targetId) throw new BridgeError(ErrorCode.INVALID_PARAM, "`targetId` is required: a component, component set, style or variable id.");
      const description = ctx.params.description;
      const link = ctx.params.documentationLink;
      if (description !== undefined && typeof description !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`description` must be text.");
      if (link !== undefined && typeof link !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`documentationLink` must be text.");
      if (description === undefined && link === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `description`, `documentationLink`, or both.");
      const markdown = ctx.params.markdown === true;
      if (markdown && description === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`markdown: true` needs a `description`.");
      if (link && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(link)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`documentationLink\` must be one https:// address — got "${link}". "" clears it.`);
      }
      const target = await describable(targetId);
      if (target.kind === "variable" && link !== undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "A variable has no documentation link — only components, component sets and styles do.");
      if (target.kind === "variable" && markdown) throw new BridgeError(ErrorCode.INVALID_PARAM, "A variable's description is plain text; drop `markdown`.");
      // The typings give styles descriptionMarkdown, but measured live a paint
      // style has no such property: assigning it threw "object is not
      // extensible" [C-111]. Where it is missing the text goes in as plain.
      const plainOnly = markdown && !("descriptionMarkdown" in target.obj);
      return { target, description: description as string | undefined, link: link as string | undefined, markdown: markdown && !plainOnly, plainOnly };
    });
    const o = p.target.obj;
    if (p.description !== undefined) {
      if (p.markdown) o.descriptionMarkdown = p.description;
      else o.description = p.description;
    }
    if (p.link !== undefined) o.documentationLinks = p.link ? [{ uri: p.link }] : [];
    const links = (p.target.kind === "variable" ? [] : o.documentationLinks) as ReadonlyArray<{ uri: string }> | undefined;
    return {
      id: o.id, type: p.target.type, description: o.description,
      ...(links?.[0] ? { documentationLink: links[0].uri } : {}),
      ...(p.target.note ? { note: p.target.note } : {}),
      ...(p.plainOnly ? { markdown: `A ${p.target.type} in this Figma takes no markdown description, so it was written as plain text.` } : {}),
    };
  },
};

// ── library import [C-110] ──────────────────────────────────────────────────

const importLibraryAssets: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const assets = await beforeMutating(() => {
      const raw = ctx.params.assets;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw new BridgeError(ErrorCode.INVALID_PARAM, "`assets` must list 1 to 50 { kind, key } entries.");
      return raw.map((a, i) => {
        const e = (a ?? {}) as { kind?: unknown; key?: unknown };
        const kind = typeof e.kind === "string" ? e.kind.toLowerCase() : "";
        if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`assets[${i}].kind\` must be ${ASSET_KINDS.join(", ")}.`);
        }
        if (typeof e.key !== "string" || !e.key.trim()) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`assets[${i}].key\` must be a non-empty key.`);
        return { kind: kind as AssetKind, key: e.key.trim() };
      });
    });
    // Independent imports run together: one IPC round-trip each would add up.
    // Settled by hand rather than Promise.allSettled, which ES2017 lacks.
    const settled = await Promise.all(
      assets.map((a) => importAsset(a.kind, a.key).then((value) => ({ value }), (reason: unknown) => ({ reason }))),
    );
    const items = assets.map((a, i) => {
      const r = settled[i]!;
      if (!("value" in r)) return { key: a.key, kind: a.kind, ok: false, error: message(r.reason) };
      const v = r.value;
      const set = a.kind === "component_set" ? (v as { defaultVariant?: { id: string } }).defaultVariant : undefined;
      return {
        key: a.key, kind: a.kind, ok: true, id: v.id, name: v.name,
        type: a.kind === "variable" ? "VARIABLE" : String(v.type),
        ...(a.kind === "variable" ? { resolvedType: v.resolvedType } : {}),
        ...(set ? { defaultVariantId: set.id } : {}),
      };
    });
    return { imported: items.filter((i) => i.ok).length, items };
  },
};

// ── reads ───────────────────────────────────────────────────────────────────

type FindAll = (criteria: { types: string[] }) => NodeLike[];

/** COMPONENT and COMPONENT_SET nodes under `root`: the indexed find where it exists (typings 6985), else a walk. */
async function componentsIn(root: NodeLike, ctx: OpContext): Promise<NodeLike[]> {
  const find = (root as unknown as { findAllWithCriteria?: FindAll }).findAllWithCriteria;
  if (typeof find === "function") return find.call(root, { types: ["COMPONENT", "COMPONENT_SET"] });
  const out: NodeLike[] = [];
  await walk(root, (n) => {
    if (n !== root && (n.type === "COMPONENT" || n.type === "COMPONENT_SET")) out.push(n);
  }, ctx, { yieldEvery: 300 });
  return out;
}

const textOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * figma_get_local_components (moved here from read.ts with the keys). Under
 * dynamic-page a page the user has not opened must be loaded before its
 * children can be read; without a pageId every page is loaded once and
 * searched with the indexed find [C-090].
 */
const getLocalComponents: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const pageId = str(ctx.params, "pageId");
    const f = api() as unknown as FigmaLike;
    let roots: NodeLike[];
    if (pageId) {
      const root = await byId(f, pageId);
      await ensureLoaded(root);
      roots = [root];
    } else {
      await loadAllPages();
      roots = pagesOf(f);
    }
    const components: Array<{ id: string; name: string; type: string; pageId: string; description: string | null; key: string | null; setId?: string; setName?: string }> = [];
    const componentSets: Array<{ id: string; name: string; type: string; pageId: string; description: string | null; key: string | null; variantCount: number; properties: Record<string, string[]>; error?: string }> = [];
    for (let i = 0; i < roots.length; i++) {
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while listing components.");
      const page = roots[i]!;
      for (const node of await componentsIn(page, ctx)) {
        const n = node as unknown as Any & NodeLikeW;
        if (node.type === "COMPONENT") {
          const set = node.parent?.type === "COMPONENT_SET" ? node.parent : null;
          components.push({
            id: node.id, name: node.name, type: node.type, pageId: page.id,
            description: textOrNull(n.description), key: textOrNull(n.key),
            ...(set ? { setId: set.id, setName: set.name } : {}),
          });
        } else {
          const properties: Record<string, string[]> = {};
          let error: string | undefined;
          try {
            for (const [k, d] of Object.entries(readDefs(n))) if (d.type === "VARIANT") properties[k] = d.variantOptions ?? [];
          } catch (err) {
            // A set with conflicting variant names cannot report its properties.
            error = message(err);
          }
          componentSets.push({
            id: node.id, name: node.name, type: node.type, pageId: page.id,
            description: textOrNull(n.description), key: textOrNull(n.key),
            variantCount: (node.children ?? []).filter((c) => c.type === "COMPONENT").length,
            properties, ...(error ? { error } : {}),
          });
        }
      }
      ctx.progress(i + 1, roots.length, "pages");
      await ctx.yieldToHost();
    }
    return {
      pageId: pageId ?? null,
      componentCount: components.length,
      componentSetCount: componentSets.length,
      components,
      componentSets,
    };
  },
};

/** Local components by key, for naming preferred values — loads every page, so only called when there are some. */
async function localByKey(keys: Set<string>, ctx: OpContext): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (keys.size === 0) return out;
  await loadAllPages();
  for (const page of pagesOf(api() as unknown as FigmaLike)) {
    for (const n of await componentsIn(page, ctx)) {
      const k = (n as unknown as { key?: unknown }).key;
      if (typeof k === "string" && keys.has(k)) out.set(k, { id: n.id, name: n.name });
    }
  }
  return out;
}

/**
 * Layers that drive one of `owner`'s properties. Sublayers of a nested
 * instance reference THAT instance's main component (typings 6624), so the
 * walk does not descend into instances; a reference to a key the owner does
 * not define is left out for the same reason.
 */
async function referencesIn(owner: NodeLikeW, keys: Set<string> | null, limit: number, offset: number, ctx: OpContext) {
  const items: Array<{ nodeId: string; name: string; type: string; refs: Refs; variant?: string }> = [];
  const stack: Array<{ node: NodeLikeW; variant?: string }> = [{ node: owner }];
  let index = 0;
  let seen = 0;
  let more = false;
  while (stack.length) {
    const { node, variant } = stack.pop()!;
    if (node !== owner) {
      const own = Object.fromEntries(Object.entries(refsOf(node)).filter(([, v]) => typeof v === "string" && (!keys || keys.has(v))));
      if (Object.keys(own).length && index++ >= offset) {
        if (items.length >= limit) {
          more = true;
          break;
        }
        items.push({ nodeId: node.id, name: node.name, type: node.type, refs: own, ...(variant ? { variant } : {}) });
      }
    }
    if (++seen % 200 === 0) {
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while reading the component.");
      await ctx.yieldToHost();
    }
    if (node.type === "INSTANCE" && node !== owner) continue;
    const kids = node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!;
      stack.push({ node: kid, ...(variant ? { variant } : node === owner && owner.type === "COMPONENT_SET" ? { variant: kid.name } : {}) });
    }
  }
  return { items, more };
}

const getComponent: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const node = (await byId(api() as unknown as FigmaLike, reqStr(ctx.params, "nodeId"))) as unknown as NodeLikeW;
    const { component, owner, instance } = await propertyOwner(node);
    const limit = int(ctx.params, "limit", 200, 2000) || 200;
    const scopeKey = `component_refs:${owner.id}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

    let defs: Defs | null = null;
    let propertiesError: string | undefined;
    try {
      defs = readDefs(owner);
    } catch (err) {
      // A library variant reached through an instance may come without its set
      // (typings 6324), and a broken set cannot report its definitions.
      propertiesError = message(err);
    }
    const preferredKeys = new Set(Object.values(defs ?? {}).flatMap((d) => (d.preferredValues ?? []).map((v) => v.key)));
    const names = isRemote(owner) ? new Map<string, { id: string; name: string }>() : await localByKey(preferredKeys, ctx);
    const properties = defs
      ? Object.entries(defs).map(([key, d]) => ({
          key, name: key.split("#")[0]!, type: d.type, defaultValue: d.defaultValue,
          ...(d.variantOptions ? { variantOptions: d.variantOptions } : {}),
          ...(d.preferredValues ? { preferredValues: d.preferredValues.map((v) => ({ type: v.type, key: v.key, ...(names.get(v.key) ?? {}) })) } : {}),
          ...(d.description ? { description: d.description } : {}),
        }))
      : Object.entries(((instance as unknown as Any | undefined)?.componentProperties ?? {}) as Record<string, { type: string; value: unknown }>).map(([key, d]) => ({
          key, name: key.split("#")[0]!, type: d.type, value: d.value,
        }));

    const variants = owner.type === "COMPONENT_SET"
      ? (owner.children ?? []).filter((c) => c.type === "COMPONENT").map((c) => ({ id: c.id, name: c.name, values: variantValues(c) }))
      : undefined;
    let defaultVariantId: string | undefined;
    try {
      defaultVariantId = owner.type === "COMPONENT_SET" ? (owner as unknown as { defaultVariant?: { id: string } }).defaultVariant?.id : undefined;
    } catch {
      /* a set with no valid variant */
    }
    const refs = await referencesIn(owner, defs ? new Set(Object.keys(defs)) : null, limit, offset, ctx);
    let exposedInstances: Array<{ id: string; name: string }> | undefined;
    try {
      const exposed = (instance as unknown as { exposedInstances?: NodeLikeW[] } | undefined)?.exposedInstances;
      if (Array.isArray(exposed) && exposed.length) exposedInstances = exposed.map((e) => ({ id: e.id, name: e.name }));
    } catch {
      /* not readable on this instance */
    }
    const c = component as unknown as Any;
    const links = c.documentationLinks as ReadonlyArray<{ uri: string }> | undefined;
    return {
      id: component.id, name: component.name, type: component.type,
      key: textOrNull(c.key), remote: isRemote(component), description: textOrNull(c.description),
      ...(Array.isArray(links) && links[0] ? { documentationLink: links[0].uri } : {}),
      ...(instance ? { instanceId: instance.id } : {}),
      owner: { id: owner.id, name: owner.name, type: owner.type, key: textOrNull((owner as unknown as Any).key) },
      properties,
      ...(propertiesError ? { propertiesError, ...(instance ? { note: "Definitions unreadable; `properties` are the instance's current values instead." } : {}) } : {}),
      ...(variants ? { variants } : {}),
      ...(defaultVariantId ? { defaultVariantId } : {}),
      references: refs.items,
      ...(exposedInstances ? { exposedInstances } : {}),
      truncated: refs.more,
      ...(refs.more ? { nextCursor: encodeCursor(scopeKey, offset + refs.items.length) } : {}),
    };
  },
};

export const COMPONENT_OPS: Record<string, PluginOp> = {
  create_instance: createInstance,
  swap_component: swapComponent,
  detach_instance: detachInstance,
  combine_as_variants: combineAsVariants,
  add_component_property: addComponentProperty,
  set_instance_properties: setInstanceProperties,
  get_local_components: getLocalComponents,
  get_component: getComponent,
  import_library_assets: importLibraryAssets,
  edit_component_property: editComponentProperty,
  delete_component_property: deleteComponentProperty,
  set_description: setDescription,
  create_slot: createSlot,
  reset_slot: resetSlot,
};
