// Variable modes and values (spec §12 phase 3). Creating collections and
// variables is in create.ts; binding a variable to a node is
// figma_bind_variable_to_node in style.ts.
//
// API per @figma/plugin-typings 1.141.0: VariableCollection.addMode(name)
// returns the new modeId; Variable.setValueForMode(modeId, value).
// Modes beyond the first are paid-plan only [C-047]: Figma throws, and its own
// message is passed back rather than paraphrased.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { findVariable } from "../bind.js";
import { beforeMutating } from "../guard.js";
import { resolveMode } from "../modes.js";
import { str, strList } from "../read.js";
import { checkModeName } from "../tokens.js";
import type { ItemResult } from "./modify.js";
import { setValueLoadingFonts, variableValue } from "./tokens.js";

interface Collection {
  id: string;
  name: string;
  modes: ReadonlyArray<{ modeId: string; name: string }>;
  addMode?(name: string): string;
}

interface Variable {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  /** A library variable, imported into this file: read-only here. */
  remote?: boolean;
  setValueForMode(modeId: string, value: unknown): void;
}

interface VariablesApi {
  getVariableCollectionByIdAsync?(id: string): Promise<Collection | null>;
  getVariableByIdAsync?(id: string): Promise<Variable | null>;
}

const vars = (): VariablesApi => {
  const v = (globalThis as unknown as { figma: { variables?: VariablesApi } }).figma.variables;
  if (!v?.getVariableCollectionByIdAsync || !v.getVariableByIdAsync) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no variables API.");
  }
  return v;
};

async function collectionById(id: string | undefined): Promise<Collection> {
  if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`collectionId` is required.");
  const c = await vars().getVariableCollectionByIdAsync!(id);
  if (!c) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No variable collection with id \`${id}\`.`, { hint: "figma_get_variable_defs lists them." });
  return c;
}

// Every check runs before the document changes, and a refusal there says so
// (guard.ts) — the same contract the create ops keep.

const addVariableMode: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { name, collection } = await beforeMutating(async () => {
      const name = str(ctx.params, "name");
      if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` is required, e.g. \"Dark\".");
      // Figma's 40-character limit [C-127], refused here so the refusal can say nothing changed.
      checkModeName(name, "name");
      const collection = await collectionById(str(ctx.params, "collectionId"));
      if (collection.modes.some((m) => m.name === name)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `The collection already has a mode named "${name}".`);
      }
      return { name, collection };
    });
    let modeId: string;
    try {
      modeId = collection.addMode!(name);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the mode: ${err instanceof Error ? err.message : String(err)}`, {
        hint: "Extra modes need a paid plan (Starter files have one mode per collection).",
        partial: { created: [] },
      });
    }
    return { collectionId: collection.id, modeId, name, modes: collection.modes.map((m) => ({ modeId: m.modeId, name: m.name })) };
  },
};

const setVariableValue: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const { variable, mode, value } = await beforeMutating(async () => {
      const variable = (await findVariable({ id: str(ctx.params, "variableId"), name: str(ctx.params, "variableName") })) as unknown as Variable;
      // Figma's own throw for a library variable would come after this check,
      // without the marker that says nothing changed (guard.ts).
      if (variable.remote) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `"${variable.name}" is a library variable; library variables are read-only here.`, {
          hint: "Change it in its library file and publish.",
        });
      }
      const collection = await collectionById(variable.variableCollectionId);
      const ref = str(ctx.params, "modeId");
      const mode = ref ? resolveMode(collection, ref) : collection.modes[0];
      if (!mode) throw new BridgeError(ErrorCode.INVALID_PARAM, `The variable's collection "${collection.name}" has no modes.`);
      // "alias:<name or id>" points this variable at another of the same type —
      // the value figma_get_variable_defs reads back, so a read round-trips.
      const value = await variableValue(variable.resolvedType, ctx.params.value, "value", variable.variableCollectionId);
      return { variable, mode, value };
    });
    // Text bound to it may use a font not loaded in this run [C-105].
    await setValueLoadingFonts(variable, mode.modeId, value, new Set());
    return { variableId: variable.id, name: variable.name, modeId: mode.modeId, mode: mode.name, type: variable.resolvedType };
  },
};

// ── deleting (Variable.remove(), VariableCollection.remove() — typings 1.141.0) ──

const deleteVariable: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const ids = await beforeMutating(() => {
      const ids = strList(ctx.params, "variableIds");
      if (!ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "`variableIds` must be a non-empty array.");
      vars();
      return ids;
    });
    const items: ItemResult[] = [];
    for (const id of ids) {
      const v = (await vars().getVariableByIdAsync!(id)) as (Variable & { remove?: () => void }) | null;
      if (!v) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      try {
        v.remove!();
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { deleted: items.filter((i) => i.ok).length, items };
  },
};

const deleteVariableCollection: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const collection = (await beforeMutating(() => collectionById(str(ctx.params, "collectionId")))) as Collection & {
      remove?: () => void;
      variableIds?: readonly string[];
    };
    const count = collection.variableIds?.length;
    collection.remove!();
    return { deleted: collection.id, name: collection.name, ...(count !== undefined ? { variableCount: count } : {}) };
  },
};

export const VARIABLE_OPS: Record<string, PluginOp> = {
  add_variable_mode: addVariableMode,
  set_variable_value: setVariableValue,
  delete_variable: deleteVariable,
  delete_variable_collection: deleteVariableCollection,
};
