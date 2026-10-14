// Variable modes on nodes: which collection, which mode, and setting it.
//
// A frame, component or page can pin a mode per collection — Dark on one
// screen, Light on another — through setExplicitVariableModeForCollection
// [C-105]. The overload taking a collection ID is deprecated and throws under
// documentAccess "dynamic-page" (manifest.json), so everything here resolves
// to the collection OBJECT and only ever passes that.
//
// API per @figma/plugin-typings 1.141.0: figma.variables.
// getVariableCollectionByIdAsync / getLocalVariableCollectionsAsync; a
// collection carries `modes: { modeId, name }[]`. Starter files have one mode
// per collection [C-047], so a missing mode there is the plan, not a typo.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { nearest } from "./write.js";

export interface ModeRef {
  modeId: string;
  name: string;
}

export interface CollectionLike {
  id: string;
  name: string;
  modes: ReadonlyArray<ModeRef>;
}

interface VariablesApi {
  getVariableCollectionByIdAsync?(id: string): Promise<CollectionLike | null>;
  getLocalVariableCollectionsAsync?(): Promise<ReadonlyArray<CollectionLike>>;
}

// Each lookup asks only for the call it makes: a lookup by id needs no listing.
const vars = (need: keyof VariablesApi): VariablesApi => {
  const v = (globalThis as unknown as { figma: { variables?: VariablesApi } }).figma.variables;
  if (typeof v?.[need] !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no variables API.");
  return v;
};

const listModes = (c: CollectionLike) => c.modes.map((m) => `${m.name} (${m.modeId})`).join(", ");

/**
 * A collection by id — any Figma resolves, so a library collection already in
 * the file works too — or by exact name among the LOCAL collections. A name two
 * local collections share is refused rather than guessed.
 */
export async function resolveCollection(ref: { id?: string | undefined; name?: string | undefined }, field = "collection"): Promise<CollectionLike> {
  if (ref.id) {
    const c = await vars("getVariableCollectionByIdAsync").getVariableCollectionByIdAsync!(ref.id);
    if (!c) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No variable collection with id \`${ref.id}\`.`, { hint: "figma_get_variable_defs lists them." });
    return c;
  }
  if (!ref.name) throw new BridgeError(ErrorCode.INVALID_PARAM, `Give \`${field}Id\` or \`${field}Name\`.`);
  const all = await vars("getLocalVariableCollectionsAsync").getLocalVariableCollectionsAsync!();
  const found = all.filter((c) => c.name === ref.name);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `${found.length} variable collections are named "${ref.name}".`, {
      hint: `Pass \`${field}Id\` instead: ${found.map((c) => c.id).join(", ")}.`,
    });
  }
  const names = all.map((c) => c.name);
  throw new BridgeError(ErrorCode.INVALID_PARAM, `No variable collection named "${ref.name}".`, {
    hint: names.length ? `Nearest: ${nearest(ref.name, names).join(", ")}` : "This file defines no variable collections yet.",
  });
}

/** A mode of `collection` by its modeId or its exact name; the refusal lists every mode it has. */
export function resolveMode(collection: CollectionLike, ref: string): ModeRef {
  const byId = collection.modes.find((m) => m.modeId === ref);
  if (byId) return { modeId: byId.modeId, name: byId.name };
  const byName = collection.modes.filter((m) => m.name === ref);
  if (byName.length === 1) return { modeId: byName[0]!.modeId, name: byName[0]!.name };
  const why = byName.length > 1 ? `has ${byName.length} modes named "${ref}"` : `has no mode \`${ref}\``;
  throw new BridgeError(ErrorCode.INVALID_PARAM, `The collection "${collection.name}" ${why}.`, {
    hint: `Its modes: ${listModes(collection)}.${collection.modes.length === 1 ? " Starter files have one mode per collection." : ""}`,
  });
}

type ModeTarget = Record<string, unknown> & { type: string };

/**
 * Pin `modeId` of `collection` on one node, through the object overload only.
 * Throws a plain Error with a node-level reason (callers report it per item).
 */
export function setMode(node: ModeTarget, collection: CollectionLike, modeId: string): void {
  const set = node.setExplicitVariableModeForCollection;
  if (typeof set !== "function") throw new Error(`a ${node.type} cannot take a variable mode`);
  (set as (c: CollectionLike, m: string) => void).call(node, collection, modeId);
}

/** Drop the pinned mode, so the node inherits its parent's again — object overload only [C-105]. */
export function clearMode(node: ModeTarget, collection: CollectionLike): void {
  const clear = node.clearExplicitVariableModeForCollection;
  if (typeof clear !== "function") throw new Error(`a ${node.type} cannot take a variable mode`);
  (clear as (c: CollectionLike) => void).call(node, collection);
}

type FontName = { family: string; style: string };

/**
 * Load the fonts of every text under `node` (and `node` itself), skipping any
 * already in `loaded`. A mode switch can change text values bound to the
 * collection, and the official figma-use notes require the fonts of text a
 * setExplicitVariableModeForCollection touches to be loaded first [C-105]. A
 * font that fails to load is left for Figma's own error rather than guessed at.
 */
export async function preloadFonts(node: ModeTarget, loaded: Set<string>): Promise<void> {
  const figma = (globalThis as unknown as { figma: { loadFontAsync?(f: FontName): Promise<void> } }).figma;
  const find = node.findAllWithCriteria as ((c: { types: string[] }) => ModeTarget[]) | undefined;
  const texts = [...(node.type === "TEXT" ? [node] : []), ...(typeof find === "function" ? find.call(node, { types: ["TEXT"] }) : [])];
  for (const t of texts) {
    const len = typeof t.characters === "string" ? t.characters.length : 0;
    const all = t.getRangeAllFontNames as ((s: number, e: number) => FontName[]) | undefined;
    let fonts: FontName[] = [];
    try {
      fonts = typeof all === "function" && len > 0 ? all.call(t, 0, len) : t.fontName && typeof t.fontName === "object" ? [t.fontName as FontName] : [];
    } catch {
      fonts = [];
    }
    for (const f of fonts) {
      const key = `${f.family}\u0000${f.style}`;
      if (loaded.has(key)) continue;
      loaded.add(key);
      await figma.loadFontAsync?.(f).catch(() => undefined);
    }
  }
}
