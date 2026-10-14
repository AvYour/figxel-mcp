// Design tokens: variables and styles as a design system needs them — created
// in batches with scopes and code syntax, renamed and re-described in place,
// shown in a chosen mode, and read back with their values (tools.md § read,
// § create, § modify, § style).
//
// The official Figma MCP reaches all of this only by writing Plugin API
// JavaScript; its own skills insist on what the old tools could not do: set
// scopes on every variable, give it a WEB code syntax, alias semantic tokens to
// primitives, show Dark by pinning a mode on a frame, and update a style in
// place so its consumers stay linked [C-105] [C-106] [C-108].
//
// Conventions kept from the rest of the plugin: every check that can fail runs
// before the first write (guard.ts), multi-node and multi-variable ops answer
// per item, and code.ts commits one undo step for the whole call.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { PLUGIN_NAME, SETUP_COMMAND } from "../../shared/version.js";
import type { OpContext, PluginOp } from "./index.js";
import { bindTarget, findStyle, findVariable, fontsOf, isStyleTarget, TEXT_FIELDS, type VariableLike } from "../bind.js";
import { CancelledError, createPacer } from "../chunk.js";
import { beforeMutating } from "../guard.js";
import { clearMode, preloadFonts, resolveCollection, resolveMode, setMode } from "../modes.js";
import { ensureLoaded } from "../pages.js";
import { byId, decodeCursor, encodeCursor, int, str, strList, walk, type FigmaLike, type NodeLike } from "../read.js";
import {
  aliasIds,
  applyVariableProps,
  checkModeName,
  checkScopes,
  checkVariableName,
  hasProps,
  isAlias,
  nonNegative,
  parseLength,
  parseLineHeight,
  pickEnum,
  readVariableProps,
  styleBindings,
  styleValue,
  TEXT_CASES,
  TEXT_DECORATIONS,
  TokenNames,
  valueText,
  VARIABLE_TYPES,
  variableMembers,
  variablesApi,
  type CollectionRecord,
  type ModeRecord,
  type VariableProps,
  type VariableRecord,
} from "../tokens.js";
import { loadFont, nearest, parseColor, parseVariableValue, weightParam, weightToStyle, type FigmaWrite, type LoadedFont } from "../write.js";
import { resolveAll, type ItemResult } from "./modify.js";
import { toLayoutGrid } from "./shapes.js";
import { toEffect, toPaint } from "./style.js";

type Any = Record<string, unknown>;
const api = () => (globalThis as unknown as { figma: FigmaWrite & Any }).figma;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── values and aliases ──────────────────────────────────────────────────────

/**
 * The variable an "alias:<ref>" points at: an id (any variable Figma resolves,
 * a library one included) or a name — this collection's first, then any local
 * one, and a name two other collections share is refused rather than guessed.
 */
async function aliasTarget(ref: string, field: string, collectionId?: string): Promise<VariableRecord> {
  if (!ref) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: "alias:" needs a variable name or id after it.`);
  if (ref.startsWith("VariableID:")) return (await findVariable({ id: ref }, "alias")) as unknown as VariableRecord;
  const all = await variablesApi("getLocalVariablesAsync").getLocalVariablesAsync!();
  const named = all.filter((v) => v.name === ref);
  const own = named.filter((v) => v.variableCollectionId === collectionId);
  if (own.length === 1) return own[0]!;
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: ${named.length} variables are named "${ref}".`, {
      hint: `Alias by id instead: ${named.map((v) => `alias:${v.id}`).join(", ")}.`,
    });
  }
  const names = all.map((v) => v.name);
  throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: no variable named "${ref}" to alias.`, {
    hint: names.length ? `Nearest: ${nearest(ref, names).join(", ")}` : "This file defines no variables yet.",
  });
}

const aliasRef = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.trim().startsWith("alias:") ? raw.trim().slice("alias:".length).trim() : undefined;

/**
 * A value in the string form every variable write takes, or "alias:<name|id>"
 * for a variable of the same type. A STRING variable used to store
 * "alias:color/x" as its literal text; it is an alias now, like every type.
 */
export async function variableValue(type: string, raw: unknown, field: string, collectionId?: string): Promise<unknown> {
  const ref = aliasRef(raw);
  if (ref === undefined) return parseVariableValue(type, raw, field);
  const target = await aliasTarget(ref, field, collectionId);
  if (target.resolvedType !== type) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: an alias must have the same type — "${target.name}" is ${target.resolvedType}, this variable is ${type}.`);
  }
  return { type: "VARIABLE_ALIAS", id: target.id };
}

/** The local variable in `collection` already called `name`, if any. */
async function takenName(collectionId: string, name: string): Promise<VariableRecord | undefined> {
  const all = await variablesApi("getLocalVariablesAsync").getLocalVariablesAsync!();
  return all.find((v) => v.variableCollectionId === collectionId && v.name === name);
}

type TextLike = Any & { type: string };

/**
 * A STRING bound to a text's fontFamily or fontStyle switches that text to a
 * font of the new name, so the font it switches TO is loaded as well — an
 * unavailable one is left for Figma's own refusal, as bindNodeField does.
 */
async function loadSwitchedFonts(page: TextLike, variableId: string, value: string, loaded: Set<string>): Promise<void> {
  const find = page.findAllWithCriteria as ((c: { types: string[] }) => TextLike[]) | undefined;
  if (typeof find !== "function") return;
  const load = (api() as unknown as { loadFontAsync?(f: { family: string; style: string }): Promise<void> }).loadFontAsync;
  for (const t of find.call(page, { types: ["TEXT"] })) {
    const bound = (t.boundVariables ?? {}) as Any;
    // A text field binds per range, so Figma reports a list of aliases for it.
    const uses = (field: string) => [bound[field]].flat().some((a) => isAlias(a) && a.id === variableId);
    const family = uses("fontFamily");
    if (!family && !uses("fontStyle")) continue;
    for (const f of fontsOf(t)) {
      const next = family ? { family: value, style: f.style } : { family: f.family, style: value };
      const key = `${next.family}\u0000${next.style}`;
      if (loaded.has(key)) continue;
      loaded.add(key);
      await load?.call(api(), next).catch(() => undefined);
    }
  }
}

/**
 * setValueForMode on a variable text may already use. The official figma-use
 * notes name setValueForMode among the writes that need the fonts of the text
 * they touch [C-105]: a STRING bound to a label's characters, or a FLOAT bound
 * to its size, cannot change while that label's font is unloaded. The fonts
 * of the current page are loaded only once Figma refuses for one, then the
 * write is tried again — loading them before every token write would make
 * each call pay for the few that need it. `loaded` spans one call.
 */
export async function setValueLoadingFonts(v: { id: string; setValueForMode(modeId: string, value: unknown): void }, modeId: string, value: unknown, loaded: Set<string>): Promise<void> {
  try {
    v.setValueForMode(modeId, value);
    return;
  } catch (err) {
    if (!/unloaded font/i.test(message(err))) throw err;
  }
  const page = api().currentPage as unknown as TextLike;
  await preloadFonts(page, loaded);
  if (typeof value === "string" && value) await loadSwitchedFonts(page, v.id, value, loaded);
  v.setValueForMode(modeId, value);
}

export interface PreparedVariable {
  name: string;
  type: string;
  value: unknown;
  collection: CollectionRecord;
  mode: ModeRecord;
  props: VariableProps;
}

/**
 * Everything figma_create_variable checks before the variable exists: a bad
 * value, a scope the type cannot take, an alias to nothing, or a name the
 * collection already has would otherwise leave an ALL_SCOPES variable behind
 * — or a second variable under the same name, which Figma does not refuse
 * [C-106]. A library collection is refused here too: Figma's own throw would
 * come after the check, so the refusal could not say nothing changed.
 */
export async function prepareVariable(params: Any): Promise<PreparedVariable> {
  const name = str(params, "name")?.trim();
  const collectionId = str(params, "collectionId");
  const type = (str(params, "type") ?? "").toUpperCase();
  if (!name || !collectionId) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` and `collectionId` are required.");
  checkVariableName(name, "name");
  if (!(VARIABLE_TYPES as readonly string[]).includes(type)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`type\` must be COLOR, FLOAT, STRING or BOOLEAN (got "${type}").`);
  }
  const collection = await resolveCollection({ id: collectionId });
  if ((collection as CollectionRecord).remote) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `"${collection.name}" is a library collection; library collections are read-only here.`, {
      hint: "Create the variable in its library file and publish, or in a local collection (figma_create_variable_collection).",
    });
  }
  const modeRef = str(params, "modeId");
  const mode = modeRef ? resolveMode(collection, modeRef) : collection.modes[0];
  if (!mode) throw new BridgeError(ErrorCode.INVALID_PARAM, `The collection "${collection.name}" has no modes.`);
  const value = await variableValue(type, params.value, "value", collection.id);
  const props = readVariableProps({ ...params, name: undefined }, type);
  const existing = await takenName(collection.id, name);
  if (existing) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `The collection "${collection.name}" already has a variable named "${name}" (${existing.id}).`, {
      hint: "Change it with figma_set_variable_value / figma_set_variable_properties, or create several at once with figma_create_variables { ifExists }.",
    });
  }
  return { name, type, value, collection: collection as CollectionRecord, mode, props };
}

/**
 * Write the properties of a variable that now exists. A refusal here is after
 * the variable was made, so it says so — the agent fixes the property rather
 * than creating a second copy.
 */
export function finishVariable(v: VariableRecord, props: VariableProps): string[] {
  try {
    return applyVariableProps(v, props);
  } catch (err) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `The variable "${v.name}" was created, but Figma refused a property: ${message(err)}`, {
      hint: "Fix it with figma_set_variable_properties, or delete it with figma_delete_variable.",
      partial: { created: [{ id: v.id, name: v.name }] },
    });
  }
}

// ── figma_create_variables ──────────────────────────────────────────────────

interface PlannedVariable {
  name: string;
  type: string;
  action: "create" | "skip" | "update";
  existing?: VariableRecord;
  values: Array<{ mode: ModeRecord; value: unknown; batchAlias?: string }>;
  props: VariableProps;
}

/**
 * A token set in one call: primitives, then semantic aliases to them, with
 * scopes and code syntax. Everything is validated before the first variable
 * exists — names, modes, values, scopes, and alias targets that must already
 * exist or come EARLIER in the batch with the same type — so a failure creates
 * nothing. Then it creates in order, yielding every ~12 ms as create_from_spec
 * does, so a large set keeps the editor responsive and can be cancelled.
 */
const createVariables: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const plan = await beforeMutating(async () => {
      const vars = variablesApi("createVariable", "getLocalVariablesAsync", "getVariableCollectionByIdAsync");
      const collectionId = str(ctx.params, "collectionId");
      if (!collectionId) throw new BridgeError(ErrorCode.INVALID_PARAM, "`collectionId` is required.");
      const collection = (await resolveCollection({ id: collectionId })) as CollectionRecord;
      if (collection.remote) throw new BridgeError(ErrorCode.INVALID_PARAM, `"${collection.name}" is a library collection; library collections are read-only here.`);
      const ifExists = str(ctx.params, "ifExists") ?? "error";
      if (!["error", "skip", "update"].includes(ifExists)) throw new BridgeError(ErrorCode.INVALID_PARAM, '`ifExists` must be "error", "skip" or "update".');
      const raw = ctx.params.variables;
      if (!Array.isArray(raw) || raw.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`variables` needs at least one entry.");
      if (raw.length > 200) throw new BridgeError(ErrorCode.INVALID_PARAM, "`variables` takes at most 200 entries per call.");

      const inCollection = new Map((await vars.getLocalVariablesAsync!()).filter((v) => v.variableCollectionId === collection.id).map((v) => [v.name, v]));
      const planned: PlannedVariable[] = [];
      const byName = new Map<string, PlannedVariable>();
      const taken: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const at = `variables[${i}]`;
        const e = raw[i] as Any;
        if (!e || typeof e !== "object" || Array.isArray(e)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` must be an object.`);
        const name = typeof e.name === "string" ? e.name.trim() : "";
        if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.name\` is required.`);
        if (byName.has(name)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.name\` "${name}" appears twice in this call.`);
        const type = String(e.type ?? "").toUpperCase();
        if (!(VARIABLE_TYPES as readonly string[]).includes(type)) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.type\` must be COLOR, FLOAT, STRING or BOOLEAN (got "${String(e.type)}").`);
        }
        const existing = inCollection.get(name);
        // Only a name about to be created: one the collection already has, Figma took.
        if (!existing) checkVariableName(name, `${at}.name`);
        let action: PlannedVariable["action"] = "create";
        if (existing) {
          if (ifExists === "error") taken.push(`${name} (${existing.id})`);
          action = ifExists === "skip" ? "skip" : "update";
          // A kept variable of another type would make every alias to it wrong.
          if (ifExists !== "error" && existing.resolvedType !== type) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: "${name}" exists as ${existing.resolvedType}; it cannot be ${ifExists === "skip" ? "kept" : "updated"} as ${type}.`);
          }
        }
        if (!Array.isArray(e.values) || e.values.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.values\` needs at least one { mode, value }.`);
        const values: PlannedVariable["values"] = [];
        const seenModes = new Set<string>();
        for (let k = 0; k < e.values.length; k++) {
          const vAt = `${at}.values[${k}]`;
          const entry = e.values[k] as Any;
          if (!entry || typeof entry.mode !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${vAt}.mode\` is required (a mode name or id).`);
          const mode = resolveMode(collection, entry.mode);
          if (seenModes.has(mode.modeId)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${vAt}\`: mode "${mode.name}" is given twice.`);
          seenModes.add(mode.modeId);
          const ref = aliasRef(entry.value);
          const inBatch = ref !== undefined ? byName.get(ref) : undefined;
          if (ref !== undefined && ref === name) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${vAt}.value\`: "${name}" cannot alias itself.`);
          if (inBatch) {
            if (inBatch.type !== type) {
              throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${vAt}.value\`: an alias must have the same type — "${ref}" is ${inBatch.type}, this variable is ${type}.`);
            }
            values.push({ mode, value: undefined, batchAlias: ref });
            continue;
          }
          if (ref !== undefined && raw.slice(i + 1).some((later) => (later as Any)?.name === ref)) {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${vAt}.value\`: "${ref}" comes later in this call; list alias targets before the variables that alias them.`);
          }
          values.push({ mode, value: await variableValue(type, entry.value, `${vAt}.value`, collection.id) });
        }
        const props = readVariableProps({ ...e, name: undefined }, type, `${at}.`);
        const p: PlannedVariable = { name, type, action, values, props, ...(existing ? { existing } : {}) };
        planned.push(p);
        byName.set(name, p);
      }
      if (taken.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `The collection "${collection.name}" already has: ${taken.join(", ")}.`, {
          hint: 'Pass ifExists "skip" to keep them, or "update" to set the given values and properties on them.',
        });
      }
      return { collection, planned, byName, vars };
    });

    const { collection, planned, byName, vars } = plan;
    const made = new Map<string, VariableRecord>();
    const items: Array<{ name: string; id?: string; ok: boolean; skipped?: true; updated?: true; error?: string }> = [];
    const created: Array<{ id: string; name: string }> = [];
    const updated: Array<{ id: string; name: string }> = [];
    const pacer = createPacer(planned.length, {
      yieldToHost: ctx.yieldToHost,
      onProgress: (done, all) => ctx.progress(done, all, "creating"),
      isCancelled: ctx.isCancelled,
    });
    ctx.progress(0, planned.length, "creating");
    let current = "";
    const fonts = new Set<string>();
    try {
      for (const p of planned) {
        current = p.name;
        if (p.action === "skip") {
          made.set(p.name, p.existing!);
          items.push({ name: p.name, id: p.existing!.id, ok: true, skipped: true });
          await pacer.tick();
          continue;
        }
        const v = p.action === "update" ? p.existing! : vars.createVariable!(p.name, collection, p.type);
        if (p.action === "create") created.push({ id: v.id, name: v.name });
        else updated.push({ id: v.id, name: v.name });
        made.set(p.name, v);
        for (const { mode, value, batchAlias } of p.values) {
          const target = batchAlias !== undefined ? (made.get(batchAlias) ?? byName.get(batchAlias)?.existing) : undefined;
          await setValueLoadingFonts(v, mode.modeId, target ? { type: "VARIABLE_ALIAS", id: target.id } : value, fonts);
        }
        applyVariableProps(v, p.props);
        items.push({ name: p.name, id: v.id, ok: true, ...(p.action === "update" ? { updated: true as const } : {}) });
        await pacer.tick();
      }
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      // `created: []` is the "provably nothing changed" marker (guard.ts), so it
      // is only written when nothing was updated either: an update may have set
      // some of its values before Figma refused the next one.
      throw new BridgeError(cancelled ? ErrorCode.CANCELLED : ErrorCode.INVALID_PARAM, cancelled ? message(err) : `Figma refused "${current}": ${message(err)}`, {
        hint: created.length || updated.length
          ? `${created.length} variable(s) were created and ${updated.length} updated before it stopped (partial). Re-run the rest with ifExists "skip", or Ctrl+Z the whole call.`
          : "Nothing was created.",
        partial: { ...(created.length || !updated.length ? { created } : {}), ...(updated.length ? { updated } : {}), failedAt: current },
      });
    }
    ctx.progress(planned.length, planned.length, "done");
    return {
      collectionId: collection.id,
      created: created.length,
      skipped: items.filter((i) => i.skipped).length,
      updated: updated.length,
      items,
    };
  },
};

// ── figma_set_variable_properties ───────────────────────────────────────────

const setVariableProperties: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const prep = await beforeMutating(async () => {
      const ids = strList(ctx.params, "variableIds");
      const names = strList(ctx.params, "variableNames");
      if (!ids === !names) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give exactly one of `variableIds` or `variableNames`.");
      const refs = (ids ?? names)!;
      if (refs.length > 500) throw new BridgeError(ErrorCode.INVALID_PARAM, "At most 500 variables per call.");
      // Type-independent checks first; scopes are checked per variable, against its own type.
      const shared = readVariableProps(ctx.params, undefined);
      if (!hasProps(shared)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Nothing to change: give `name`, `scopes`, `codeSyntax`, `description` or `hiddenFromPublishing`.");
      }
      if (shared.name !== undefined && refs.length > 1) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` renames one variable; this call targets several.");
      const vars = variablesApi("getVariableByIdAsync", "getLocalVariablesAsync");
      const local = await vars.getLocalVariablesAsync!();
      const targets: Array<{ ref: string; v?: VariableRecord; props?: VariableProps; error?: string }> = [];
      for (const ref of refs) {
        let v: VariableRecord | null = null;
        if (ids) v = await vars.getVariableByIdAsync!(ref);
        else {
          const hits = local.filter((x) => x.name === ref);
          if (hits.length > 1) {
            targets.push({ ref, error: `${hits.length} variables are named "${ref}": ${hits.map((h) => h.id).join(", ")} — use variableIds` });
            continue;
          }
          v = hits[0] ?? null;
        }
        if (!v) {
          targets.push({ ref, error: ids ? "not found" : `not found (nearest: ${nearest(ref, local.map((x) => x.name), 3).join(", ")})` });
          continue;
        }
        if (v.remote) {
          targets.push({ ref, v, error: "a library variable; library variables are read-only here" });
          continue;
        }
        try {
          const props = shared.scopes !== undefined ? { ...shared, scopes: checkScopes(v.resolvedType, shared.scopes) } : shared;
          if (props.name !== undefined) {
            const clash = local.find((x) => x.variableCollectionId === v!.variableCollectionId && x.name === props.name && x.id !== v!.id);
            if (clash) throw new BridgeError(ErrorCode.INVALID_PARAM, `its collection already has a variable named "${props.name}" (${clash.id})`);
          }
          targets.push({ ref, v, props });
        } catch (err) {
          targets.push({ ref, v, error: message(err) });
        }
      }
      // One target that cannot change at all is a refusal, not a result: nothing changed.
      if (targets.length === 1 && targets[0]!.error) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${targets[0]!.ref}\`: ${targets[0]!.error}.`);
      return targets;
    });

    const items: Array<ItemResult & { name?: string; changed?: string[] }> = [];
    for (const t of prep) {
      const id = t.v?.id ?? t.ref;
      if (t.error || !t.v || !t.props) {
        items.push({ id, ...(t.v ? { name: t.v.name } : {}), ok: false, error: t.error ?? "not found" });
        continue;
      }
      try {
        const changed = applyVariableProps(t.v, t.props);
        items.push({ id, name: t.v.name, ok: true, changed });
      } catch (err) {
        items.push({ id, name: t.v.name, ok: false, error: message(err) });
      }
    }
    return { updated: items.filter((i) => i.ok).length, items };
  },
};

// ── figma_update_variable_collection ────────────────────────────────────────

const updateVariableCollection: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const id = str(ctx.params, "collectionId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`collectionId` is required.");
      const collection = (await resolveCollection({ id })) as CollectionRecord;
      if (collection.remote) throw new BridgeError(ErrorCode.INVALID_PARAM, `"${collection.name}" is a library collection; library collections are read-only here.`);
      const name = ctx.params.name;
      if (name !== undefined && (typeof name !== "string" || name.trim() === "")) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` must be a non-empty string.");
      const hidden = ctx.params.hiddenFromPublishing;
      if (hidden !== undefined && typeof hidden !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`hiddenFromPublishing` must be true or false.");

      const renames: Array<{ mode: ModeRecord; name: string }> = [];
      const rawRenames = ctx.params.renameModes;
      if (rawRenames !== undefined) {
        if (!Array.isArray(rawRenames)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`renameModes` must be an array of { mode, name }.");
        rawRenames.forEach((r, i) => {
          const e = r as Any;
          if (!e || typeof e.mode !== "string" || typeof e.name !== "string" || e.name.trim() === "") {
            throw new BridgeError(ErrorCode.INVALID_PARAM, `\`renameModes[${i}]\` needs \`mode\` (name or id) and a non-empty \`name\`.`);
          }
          const mode = resolveMode(collection, e.mode);
          if (renames.some((x) => x.mode.modeId === mode.modeId)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`renameModes\`: mode "${mode.name}" is renamed twice.`);
          renames.push({ mode, name: checkModeName(e.name.trim(), `renameModes[${i}].name`) });
        });
      }
      const removes: ModeRecord[] = [];
      if (ctx.params.removeModes !== undefined && !Array.isArray(ctx.params.removeModes)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`removeModes` must be an array of mode names or ids.");
      }
      for (const ref of strList(ctx.params, "removeModes") ?? []) {
        const mode = resolveMode(collection, ref);
        if (!removes.some((m) => m.modeId === mode.modeId)) removes.push(mode);
      }
      if (renames.some((r) => removes.some((m) => m.modeId === r.mode.modeId))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "A mode cannot be renamed and removed in one call.");
      }
      if (removes.length >= collection.modes.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A collection keeps at least one mode; "${collection.name}" has ${collection.modes.length}.`);
      }
      // The names the modes will have afterwards must stay unique.
      const after = collection.modes
        .filter((m) => !removes.some((r) => r.modeId === m.modeId))
        .map((m) => renames.find((r) => r.mode.modeId === m.modeId)?.name ?? m.name);
      const dup = after.find((n, i) => after.indexOf(n) !== i);
      if (dup) throw new BridgeError(ErrorCode.INVALID_PARAM, `Two modes would be named "${dup}".`);
      if (name === undefined && hidden === undefined && !renames.length && !removes.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Nothing to change: give `name`, `hiddenFromPublishing`, `renameModes` or `removeModes`.");
      }
      // Removing a mode deletes the value every variable holds for it: count them, so the result says what went.
      const removed: Array<{ mode: string; modeId: string; values: number }> = [];
      if (removes.length) {
        const all = (await variablesApi("getLocalVariablesAsync").getLocalVariablesAsync!()).filter((v) => v.variableCollectionId === collection.id);
        for (const m of removes) removed.push({ mode: m.name, modeId: m.modeId, values: all.filter((v) => v.valuesByMode?.[m.modeId] !== undefined).length });
      }
      return { collection, name: typeof name === "string" ? name.trim() : undefined, hidden: hidden as boolean | undefined, renames, removes, removed };
    });

    const c = p.collection;
    const done: string[] = [];
    try {
      if (p.name !== undefined) {
        c.name = p.name;
        done.push("name");
      }
      if (p.hidden !== undefined) {
        c.hiddenFromPublishing = p.hidden;
        done.push("hiddenFromPublishing");
      }
      for (const r of p.renames) {
        c.renameMode!(r.mode.modeId, r.name);
        done.push(`renamed ${r.mode.name} → ${r.name}`);
      }
      for (const m of p.removes) {
        c.removeMode!(m.modeId);
        done.push(`removed ${m.name}`);
      }
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused a change to "${c.name}": ${message(err)}`, {
        hint: done.length ? `Applied before the refusal: ${done.join("; ")}.` : "Nothing was changed.",
        partial: done.length ? { changed: done } : { created: [] },
      });
    }
    return {
      id: c.id,
      name: c.name,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      changed: done,
      ...(p.removed.length ? { removed: p.removed } : {}),
    };
  },
};

// ── figma_set_variable_mode [C-105] ─────────────────────────────────────────

/**
 * Show a frame, component, section or page in a chosen mode — Dark on one
 * screen, Light on the next. Without this a mode can be created and valued but
 * nothing on the canvas ever renders it. Only the collection OBJECT is passed:
 * the id overload is deprecated and throws under documentAccess "dynamic-page".
 */
const setVariableMode: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const p = await beforeMutating(async () => {
      const ids = strList(ctx.params, "nodeIds");
      if (!ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of node ids.");
      const clear = ctx.params.clear === true;
      const modeRef = str(ctx.params, "mode");
      if (clear === (modeRef !== undefined)) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give exactly one of `mode` (name or id) or `clear: true`.");
      const collection = await resolveCollection({ id: str(ctx.params, "collectionId"), name: str(ctx.params, "collectionName") });
      const mode = modeRef !== undefined ? resolveMode(collection, modeRef) : undefined;
      return { ids, collection, mode };
    });

    const items: ItemResult[] = [];
    const loaded = new Set<string>();
    for (const { id, node } of await resolveAll(p.ids)) {
      if (!node) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      const n = node as unknown as Any & { type: string };
      try {
        if (typeof n.setExplicitVariableModeForCollection !== "function") throw new Error(`a ${n.type} cannot take a variable mode (frames, components, sections and pages can)`);
        if (n.type === "PAGE") await ensureLoaded(n as { type: string });
        await preloadFonts(n, loaded);
        if (p.mode) setMode(n, p.collection, p.mode.modeId);
        else clearMode(n, p.collection);
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: message(err) });
      }
    }
    const single = p.collection.modes.length === 1;
    return {
      updated: items.filter((i) => i.ok).length,
      items,
      collection: { id: p.collection.id, name: p.collection.name },
      ...(p.mode ? { mode: p.mode } : { cleared: true }),
      ...(single ? { note: `"${p.collection.name}" has only one mode, so nothing looks different (Starter files allow one mode per collection [C-047]).` } : {}),
    };
  },
};

// ── styles: create and update in place [C-108] ──────────────────────────────

type StyleKind = "PAINT" | "TEXT" | "EFFECT" | "GRID";
const FACTORY: Record<StyleKind, string> = { PAINT: "createPaintStyle", TEXT: "createTextStyle", EFFECT: "createEffectStyle", GRID: "createGridStyle" };

/** Fields each kind takes, so a field the style cannot hold is refused by name. */
const KIND_FIELDS: Record<StyleKind, readonly string[]> = {
  PAINT: ["color", "opacity", "fills"],
  TEXT: ["fontFamily", "weight", "fontSize", "lineHeight", "letterSpacing", "case", "decoration", "paragraphSpacing", "paragraphIndent"],
  EFFECT: ["effects"],
  GRID: ["grids"],
};

function opacityParam(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) throw new BridgeError(ErrorCode.INVALID_PARAM, "`opacity` must be a number from 0 to 1.");
  return raw;
}

/** PAINT: exactly one of `color` (hex) or `fills` (figma_set_fills entries). */
function paintsFrom(params: Any): unknown[] | undefined {
  const hasColor = params.color !== undefined;
  const hasFills = params.fills !== undefined;
  const opacity = opacityParam(params.opacity);
  if (!hasColor && !hasFills) {
    if (opacity !== undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`opacity` goes with `color` or `fills`.");
    return undefined;
  }
  if (hasColor && hasFills) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `color` or `fills`, not both.");
  if (hasColor) {
    const paint = parseColor(params.color, "color");
    if (opacity !== undefined) paint.opacity = opacity;
    return [paint];
  }
  if (!Array.isArray(params.fills) || params.fills.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`fills` needs at least one entry.");
  return params.fills.map((f, i) => toPaint(f, i, opacity));
}

/**
 * figma_update_style with `opacity` alone: every paint keeps what it is — its
 * colour, gradient or image, and the variable bound to it — and takes the new
 * opacity. Rebuilding the paint from `color` would drop that binding.
 */
function fadePaints(style: Any, opacity: number): unknown[] {
  const paints = Array.isArray(style.paints) ? (style.paints as Any[]) : [];
  if (!paints.length) throw new BridgeError(ErrorCode.INVALID_PARAM, `"${String(style.name)}" has no paints for \`opacity\` to fade; give \`color\` or \`fills\`.`);
  return paints.map((p) => ({ ...p, opacity }));
}

/** TEXT fields other than the font, in the figma_set_text_properties string grammar. */
function textFields(params: Any): Any {
  const out: Any = {};
  if (params.fontSize !== undefined) {
    if (typeof params.fontSize !== "number" || !(params.fontSize > 0)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`fontSize` must be a positive number.");
    out.fontSize = params.fontSize;
  }
  const lh = parseLineHeight(params.lineHeight, "lineHeight", true);
  if (lh) out.lineHeight = lh;
  const ls = parseLength(params.letterSpacing, "letterSpacing", false);
  if (ls) out.letterSpacing = ls;
  const textCase = pickEnum(params.case, TEXT_CASES, "case");
  if (textCase) out.textCase = textCase;
  const deco = pickEnum(params.decoration, TEXT_DECORATIONS, "decoration");
  if (deco) out.textDecoration = deco;
  const ps = nonNegative(params.paragraphSpacing, "paragraphSpacing");
  if (ps !== undefined) out.paragraphSpacing = ps;
  const pi = nonNegative(params.paragraphIndent, "paragraphIndent");
  if (pi !== undefined) out.paragraphIndent = pi;
  return out;
}

function descriptionParam(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`description` must be a string.");
  return raw;
}

function nonEmptyList(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` needs at least one entry.`);
  if (raw.length > 16) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` takes at most 16 entries.`);
  return raw;
}

interface PreparedStyle {
  create: () => Any & { id: string; name: string };
  name: string;
  props: Any;
  description?: string;
  font?: LoadedFont;
  variable?: { id: string; name: string };
}

/** Bind the colour of paint `index` in `paints` (a copy comes back; nothing in the document changes). */
function bindPaintColour(paints: unknown[], index: number, v: VariableLike, at: string): void {
  if (v.resolvedType !== "COLOR") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` binds a COLOR variable; "${v.name}" is ${v.resolvedType}.`);
  const p = paints[index] as { type?: string } | undefined;
  if (!p) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: there is no paint ${index} (the style has ${paints.length}).`);
  if (p.type !== "SOLID") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: paint ${index} is a ${p.type}; only SOLID paints bind a colour.`);
  const bind = variablesApi("setBoundVariableForPaint").setBoundVariableForPaint!;
  paints[index] = bind(p, "color", v);
}

/**
 * Everything a new style is made of, checked before it exists, so a bad
 * colour, an unloadable font or a malformed grid never leaves an empty style.
 */
async function prepareStyle(kind: StyleKind, params: Any): Promise<PreparedStyle> {
  const figma = api();
  const create = figma[FACTORY[kind]];
  if (typeof create !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type has no ${kind.toLowerCase()} styles (no figma.${FACTORY[kind]}).`);
  const name = str(params, "name")?.trim();
  if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` is required.");
  const description = descriptionParam(params.description);
  const base = { create: () => (create as () => Any & { id: string; name: string }).call(figma), name, ...(description !== undefined ? { description } : {}) };

  if (kind === "PAINT") {
    const paints = paintsFrom(params);
    if (!paints) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `color` (hex) or `fills` (entries as in figma_set_fills).");
    const varId = str(params, "variableId");
    const varName = str(params, "variableName");
    let variable: { id: string; name: string } | undefined;
    if (varId || varName) {
      // A semantic colour style made already bound to its token [C-108].
      const v = await findVariable({ id: varId, name: varName });
      bindPaintColour(paints, 0, v, "variable");
      variable = { id: v.id, name: v.name };
    }
    return { ...base, props: { paints }, ...(variable ? { variable } : {}) };
  }
  if (kind === "TEXT") {
    if (params.fontSize === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`fontSize` must be a positive number.");
    const fields = textFields(params);
    const font = await loadFont(figma, str(params, "fontFamily"), weightToStyle(weightParam(params)));
    // fontName first: the other text fields apply to the loaded font.
    return { ...base, props: { fontName: { family: font.family, style: font.style }, ...fields }, font };
  }
  if (kind === "EFFECT") return { ...base, props: { effects: nonEmptyList(params.effects, "effects").map((e, i) => toEffect(e, i)) } };
  return { ...base, props: { layoutGrids: nonEmptyList(params.grids, "grids").map((g, i) => toLayoutGrid(g, i)) } };
}

/** figma_create_paint_style / text / effect / grid — one implementation, so they cannot drift apart. */
export function createStyleOp(kind: StyleKind): PluginOp {
  return {
    write: true,
    async run(ctx: OpContext) {
      const p = await beforeMutating(() => prepareStyle(kind, ctx.params));
      const style = p.create();
      try {
        style.name = p.name;
        Object.assign(style, p.props);
        if (p.description !== undefined) style.description = p.description;
      } catch (err) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `The style "${p.name}" was created, but Figma refused a value: ${message(err)}`, {
          hint: "Fix it with figma_update_style, or delete it with figma_delete_style.",
          partial: { created: [{ id: style.id, name: p.name }] },
        });
      }
      return {
        id: style.id,
        name: style.name,
        kind,
        ...(p.font ? { font: { family: p.font.family, style: p.font.style, fellBack: p.font.fellBack } } : {}),
        ...(kind === "EFFECT" ? { effectCount: (p.props.effects as unknown[]).length } : {}),
        ...(kind === "GRID" ? { gridCount: (p.props.layoutGrids as unknown[]).length } : {}),
        ...(p.variable ? { variable: p.variable } : {}),
      };
    },
  };
}

/** Which variable types a TEXT style field binds (typings: VariableBindableTextField). */
function textFieldTypes(field: string): readonly string[] {
  if (field === "fontFamily" || field === "fontStyle") return ["STRING"];
  if (field === "fontWeight") return ["FLOAT", "STRING"];
  return ["FLOAT"];
}

const LISTS: Record<string, string> = { PAINT: "paints", EFFECT: "effects", GRID: "layoutGrids" };

/**
 * Change a local style in place: its name, description, values and the
 * variables bound inside it. The style object stays the same, so every node
 * using it follows — delete-and-recreate would detach them all [C-108].
 */
const updateStyle: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const params = ctx.params;
    const p = await beforeMutating(async () => {
      const asked = params.type;
      if (asked !== undefined && !isStyleTarget(asked)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`type` must be fill, stroke, text, effect or grid.");
      const ref = await findStyle({ id: str(params, "styleId"), name: str(params, "styleName") }, asked);
      const style = (await (api().getStyleByIdAsync as (id: string) => Promise<Any | null>).call(api(), ref.id)) as (Any & { id: string; name: string }) | null;
      if (!style) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No style with id \`${ref.id}\`.`);
      if (style.remote === true) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `"${style.name}" is a library style; library styles are read-only here.`, {
          hint: "Change it in its library file and publish, or create a local style with figma_create_*_style.",
        });
      }
      const kind = String(style.type) as StyleKind;
      if (!KIND_FIELDS[kind]) throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${String(style.type)} style cannot be changed by this tool.`);
      for (const [other, fields] of Object.entries(KIND_FIELDS)) {
        if (other === kind) continue;
        const wrong = fields.find((f) => params[f] !== undefined && !KIND_FIELDS[kind].includes(f));
        if (wrong) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${wrong}\` belongs to a ${other.toLowerCase()} style; "${style.name}" is a ${kind} style.`);
      }

      const name = params.name;
      if (name !== undefined && (typeof name !== "string" || name.trim() === "")) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` must be a non-empty string.");
      const description = descriptionParam(params.description);
      const props: Any = {};
      let font: LoadedFont | undefined;
      if (kind === "PAINT") {
        const fadeOnly = params.opacity !== undefined && params.color === undefined && params.fills === undefined;
        const paints = fadeOnly ? fadePaints(style, opacityParam(params.opacity)!) : paintsFrom(params);
        if (paints) props.paints = paints;
      } else if (kind === "TEXT") {
        const fields = textFields(params);
        const current = style.fontName as { family: string; style: string };
        const family = str(params, "fontFamily");
        const weight = weightParam(params);
        if (family !== undefined || weight !== undefined) {
          font = await loadFont(api(), family ?? current.family, weight !== undefined ? weightToStyle(weight) : current.style);
          props.fontName = { family: font.family, style: font.style };
        } else if (Object.keys(fields).length || Array.isArray(params.variables)) {
          // A text style's values change only with its own font loaded.
          try {
            await api().loadFontAsync(current);
          } catch {
            throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `The style's font "${current.family} ${current.style}" cannot be loaded here, so the style cannot be changed.`, {
              hint: "Give `fontFamily` / `weight` for a font this Figma has.",
            });
          }
        }
        Object.assign(props, fields);
      } else if (kind === "EFFECT") {
        if (params.effects !== undefined) props.effects = nonEmptyList(params.effects, "effects").map((e, i) => toEffect(e, i));
      } else if (params.grids !== undefined) {
        props.layoutGrids = nonEmptyList(params.grids, "grids").map((g, i) => toLayoutGrid(g, i));
      }

      // Variables inside the style. Paints, effects and grids are bound on a
      // copy of the list (the variables API returns bound copies), then the
      // list is assigned once; text fields bind on the style itself.
      const textBinds: Array<{ field: string; variable: VariableLike }> = [];
      const bound: string[] = [];
      if (params.variables !== undefined) {
        if (!Array.isArray(params.variables)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`variables` must be an array of { field, variableId | variableName, index? }.");
        const listKey = LISTS[kind];
        const list = listKey ? [...((props[listKey] ?? style[listKey] ?? []) as unknown[])] : [];
        for (let i = 0; i < params.variables.length; i++) {
          const at = `variables[${i}]`;
          const e = params.variables[i] as Any;
          const field = typeof e?.field === "string" ? e.field : "";
          const index = e?.index === undefined ? 0 : e.index;
          if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.index\` must be an integer ≥ 0.`);
          const v = await findVariable({ id: typeof e?.variableId === "string" ? e.variableId : undefined, name: typeof e?.variableName === "string" ? e.variableName : undefined });
          if (kind === "TEXT") {
            if (!TEXT_FIELDS.has(field)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.field\` "${field}" is not a text-style field; use ${[...TEXT_FIELDS].join(", ")}.`);
            const types = textFieldTypes(field);
            if (!types.includes(v.resolvedType)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: ${field} binds a ${types.join(" or ")} variable; "${v.name}" is ${v.resolvedType}.`);
            textBinds.push({ field, variable: v });
          } else if (kind === "PAINT") {
            if (field !== "color") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.field\` must be "color" for a paint style.`);
            bindPaintColour(list, index, v, at);
          } else {
            const target = bindTarget(field);
            const wantKind = kind === "EFFECT" ? "effect" : "grid";
            if (target.kind !== wantKind) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.field\` must be ${wantKind}.<field> for a ${kind.toLowerCase()} style (e.g. "${wantKind === "effect" ? "effect.color" : "grid.count"}").`);
            const f = target.field;
            const want = f === "color" ? "COLOR" : "FLOAT";
            if (v.resolvedType !== want) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: ${field} binds a ${want} variable; "${v.name}" is ${v.resolvedType}.`);
            const entry = list[index] as Any | undefined;
            if (!entry) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: there is no ${wantKind} ${index} (the style has ${list.length}).`);
            if (kind === "EFFECT") {
              const type = String(entry.type);
              const blur = type === "LAYER_BLUR" || type === "BACKGROUND_BLUR";
              if (blur ? f !== "radius" : type !== "DROP_SHADOW" && type !== "INNER_SHADOW") {
                throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: effect ${index} is a ${type}; ${blur ? "a blur binds only effect.radius" : "it has no bindable fields"}.`);
              }
              list[index] = variablesApi("setBoundVariableForEffect").setBoundVariableForEffect!(entry, f, v);
            } else {
              if (entry.pattern === "GRID" && f !== "sectionSize") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\`: grid ${index} is a square GRID; it binds only grid.sectionSize.`);
              list[index] = variablesApi("setBoundVariableForLayoutGrid").setBoundVariableForLayoutGrid!(entry, f, v);
            }
          }
          bound.push(index ? `${field}[${index}]` : field);
        }
        if (listKey && params.variables.length) props[listKey] = list;
      }
      if (name === undefined && description === undefined && !Object.keys(props).length && !textBinds.length) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `Nothing to change: give \`name\`, \`description\`, a ${kind.toLowerCase()} value (${KIND_FIELDS[kind].join(", ")}) or \`variables\`.`);
      }
      return { style, kind, name: typeof name === "string" ? name.trim() : undefined, description, props, textBinds, bound, font };
    });

    const s = p.style;
    const done: string[] = [];
    try {
      if (p.name !== undefined) {
        s.name = p.name;
        done.push("name");
      }
      if (p.description !== undefined) {
        s.description = p.description;
        done.push("description");
      }
      for (const [k, v] of Object.entries(p.props)) {
        s[k] = v;
        done.push(k);
      }
      for (const b of p.textBinds) {
        (s.setBoundVariable as (f: string, v: VariableLike) => void).call(s, b.field, b.variable);
        done.push(`variables.${b.field}`);
      }
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused a change to "${s.name}": ${message(err)}`, {
        hint: done.length ? `Applied before the refusal: ${done.join(", ")}.` : "Nothing was changed.",
        partial: done.length ? { changed: done } : { created: [] },
      });
    }
    const names = new TokenNames();
    const bindings = styleBindings(s);
    const namer = await names.namer(bindings.map(([, id]) => id));
    return {
      id: s.id,
      name: s.name,
      kind: p.kind,
      changed: done,
      value: styleValue(s, namer),
      ...(p.bound.length ? { bound: p.bound } : {}),
      ...(bindings.length ? { variables: Object.fromEntries(bindings.map(([f, id]) => [f, namer(id) ?? id])) } : {}),
      ...(p.font ? { font: { family: p.font.family, style: p.font.style, fellBack: p.font.fellBack } } : {}),
    };
  },
};

// ── reads: styles and variables with their values ───────────────────────────

const STYLE_READERS: Array<[StyleKind, string]> = [
  ["PAINT", "getLocalPaintStylesAsync"],
  ["TEXT", "getLocalTextStylesAsync"],
  ["EFFECT", "getLocalEffectStylesAsync"],
  ["GRID", "getLocalGridStylesAsync"],
];

/** A style as every read reports it: key, a one-line value, and only the members that are set. */
function styleEntry(s: Any, namer: (id: string) => string | undefined): Any {
  const bindings = styleBindings(s);
  return {
    id: s.id,
    name: s.name,
    key: s.key ?? null,
    value: styleValue(s, namer),
    ...(typeof s.description === "string" && s.description ? { description: s.description } : {}),
    ...(bindings.length ? { variables: Object.fromEntries(bindings.map(([f, id]) => [f, namer(id) ?? id])) } : {}),
    ...(s.remote === true ? { remote: true } : {}),
  };
}

/**
 * figma_get_styles: every local style with its value — "Inter Semi Bold 24/32
 * -1% upper", "drop-shadow 0 4 12 0 #0000001a" — so an agent picks a style by
 * what it is, not by a name that may mislead.
 */
export async function listStyles(ctx: OpContext): Promise<Any> {
  const type = str(ctx.params, "type")?.toUpperCase();
  const limit = int(ctx.params, "limit", 500, 2000) || 500;
  const scopeKey = `styles:${type ?? "all"}`;
  const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);
  const figma = api();
  const all: Array<[StyleKind, Any]> = [];
  const kinds: StyleKind[] = [];
  for (const [kind, reader] of STYLE_READERS) {
    if (type && type !== kind) continue;
    const read = figma[reader] as (() => Promise<readonly Any[]>) | undefined;
    if (typeof read !== "function") continue; // absent in this editor type (e.g. FigJam)
    kinds.push(kind);
    for (const s of await read.call(figma)) all.push([kind, s]);
  }
  const page = all.slice(offset, offset + limit);
  const namer = await new TokenNames().namer(page.flatMap(([, s]) => styleBindings(s).map(([, id]) => id)));
  const styles: Record<string, Any[]> = {};
  for (const kind of kinds) styles[kind] = [];
  for (const [kind, s] of page) styles[kind]!.push(styleEntry(s, namer));
  const more = offset + page.length < all.length;
  return {
    filter: type ?? null,
    styles,
    count: page.length,
    total: all.length,
    truncated: more,
    ...(more ? { nextCursor: encodeCursor(scopeKey, offset + page.length) } : {}),
  };
}

/** Values keyed by mode NAME — what figma_set_variable_value takes back. A shared name gets its id appended. */
function modeValues(v: VariableRecord, c: CollectionRecord | undefined, namer: (id: string) => string | undefined): Any {
  const out: Any = {};
  const modes = c?.modes ?? Object.keys(v.valuesByMode ?? {}).map((modeId) => ({ modeId, name: modeId }));
  for (const m of modes) {
    const raw = v.valuesByMode?.[m.modeId];
    if (raw === undefined) continue;
    const key = m.name in out ? `${m.name} (${m.modeId})` : m.name;
    out[key] = valueText(raw, namer);
  }
  return out;
}

async function fileDefs(ctx: OpContext): Promise<Any> {
  const vars = variablesApi("getLocalVariableCollectionsAsync", "getLocalVariablesAsync");
  const collectionId = str(ctx.params, "collectionId");
  const collections = await vars.getLocalVariableCollectionsAsync!();
  const wanted = collectionId ? collections.filter((c) => c.id === collectionId) : [...collections];
  if (collectionId && wanted.length === 0) {
    throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No local variable collection with id \`${collectionId}\`.`, { hint: "figma_get_variable_defs without collectionId lists them." });
  }
  const colById = new Map(wanted.map((c) => [c.id, c]));
  const all = (await vars.getLocalVariablesAsync!()).filter((v) => colById.has(v.variableCollectionId));
  const limit = int(ctx.params, "limit", 500, 2000) || 500;
  const scopeKey = `vars:${collectionId ?? "all"}`;
  const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);
  const page = all.slice(offset, offset + limit);
  const namer = await new TokenNames().namer(aliasIds(page.flatMap((v) => Object.values(v.valuesByMode ?? {}))));
  const more = offset + page.length < all.length;
  return {
    collections: wanted.map((c) => ({
      id: c.id,
      name: c.name,
      key: c.key ?? null,
      defaultMode: c.modes.find((m) => m.modeId === c.defaultModeId)?.name ?? c.modes[0]?.name ?? null,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      ...(c.hiddenFromPublishing ? { hiddenFromPublishing: true } : {}),
      ...(c.isExtension ? { isExtension: true } : {}),
      variableCount: all.filter((v) => v.variableCollectionId === c.id).length,
    })),
    variables: page.map((v) => ({
      id: v.id,
      name: v.name,
      resolvedType: v.resolvedType,
      collectionId: v.variableCollectionId,
      key: v.key ?? null,
      values: modeValues(v, colById.get(v.variableCollectionId), namer),
      ...variableMembers(v),
    })),
    count: page.length,
    total: all.length,
    truncated: more,
    ...(more ? { nextCursor: encodeCursor(scopeKey, offset + page.length) } : {}),
    note:
      "Values per mode NAME in the write dialect, all strings (\"#rrggbbaa\", \"16\", \"true\", \"alias:<name>\") — figma_set_variable_value takes them as they are. " +
      "Local variables only: pass nodeId for the variables and styles a design actually uses (library ones included), " +
      "figma_get_library_variables for enabled libraries. Modes beyond the first are paid-plan only.",
  };
}

const STYLE_SLOTS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"] as const;

/** Every variable id a node is bound to: its fields, and inside its paints, effects and grids. */
function boundIds(node: NodeLike): string[] {
  const n = node as unknown as Any;
  const out: string[] = [];
  const take = (v: unknown, depth: number) => {
    if (isAlias(v)) out.push(v.id);
    else if (Array.isArray(v)) for (const x of v) take(x, depth + 1);
    else if (v && typeof v === "object" && depth < 3) for (const x of Object.values(v)) take(x, depth + 1);
  };
  try {
    take(n.boundVariables, 0);
    for (const key of ["fills", "strokes", "effects", "layoutGrids"]) {
      const list = n[key];
      if (Array.isArray(list)) for (const e of list) take((e as Any | undefined)?.boundVariables, 0);
    }
  } catch {
    /* a getter that throws on this node type: nothing bound to read */
  }
  return out;
}

/**
 * The official get_variable_defs shape: the variables and styles a design
 * uses, by name, with values — resolved for the node that uses them, so a
 * frame pinned to Dark reports Dark [C-105]. Library tokens appear here too,
 * which the file-wide listing (local only) cannot show.
 */
async function scopedDefs(ctx: OpContext, nodeId: string): Promise<Any> {
  const root = await byId(api() as unknown as FigmaLike, nodeId);
  if (root.type === "PAGE") await ensureLoaded(root as { type: string });
  const collectionId = str(ctx.params, "collectionId");
  const maxNodes = int(ctx.params, "maxNodes", 2000, 20000) || 2000;
  const scopeKey = `varscope:${root.id}:${collectionId ?? ""}`;
  const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);

  const consumers = new Map<string, NodeLike>();
  const styleIds = new Set<string>();
  let index = 0;
  let visited = 0;
  let more = false;
  await walk(
    root,
    (node) => {
      if (index++ < offset) return;
      if (visited >= maxNodes) {
        more = true;
        return false;
      }
      visited++;
      for (const id of boundIds(node)) if (!consumers.has(id)) consumers.set(id, node);
      const n = node as unknown as Any;
      for (const slot of STYLE_SLOTS) {
        const id = n[slot];
        if (typeof id === "string" && id) styleIds.add(id); // a mixed id is a symbol: skipped
      }
    },
    ctx,
    { yieldEvery: 300 },
  );

  const names = new TokenNames();
  const flatVars: Any = {};
  const varDetails: Any[] = [];
  for (const [id, consumer] of consumers) {
    const v = await names.variable(id);
    if (!v || (collectionId && v.variableCollectionId !== collectionId)) continue;
    const c = await names.collection(v.variableCollectionId);
    let value: unknown;
    try {
      value = valueText(v.resolveForConsumer?.(consumer).value);
    } catch {
      value = undefined;
    }
    const key = v.name in flatVars ? `${v.name} (${c?.name ?? v.variableCollectionId})` : v.name;
    flatVars[key] = value ?? null;
    const syntax = variableMembers(v).codeSyntax;
    varDetails.push({
      id: v.id, name: v.name, key: v.key ?? null, remote: v.remote === true, collection: c?.name ?? null, resolvedType: v.resolvedType, value: value ?? null,
      ...(syntax ? { codeSyntax: syntax } : {}),
    });
  }

  const styles: Any[] = [];
  for (const id of styleIds) {
    const s = await names.style(id);
    if (s) styles.push(s);
  }
  const namer = await names.namer(styles.flatMap((s) => styleBindings(s).map(([, id]) => id)));
  const flatStyles: Any = {};
  const styleDetails: Any[] = [];
  for (const s of styles) {
    const value = styleValue(s, namer);
    const name = String(s.name);
    flatStyles[name in flatStyles ? `${name} (${String(s.type).toLowerCase()})` : name] = value;
    styleDetails.push({ id: s.id, name, key: s.key ?? null, remote: s.remote === true, type: s.type, value });
  }
  return {
    scope: { id: root.id, name: root.name, type: root.type },
    variables: flatVars,
    styles: flatStyles,
    details: { variables: varDetails, styles: styleDetails },
    nodeCount: visited,
    truncated: more,
    ...(more
      ? {
          nextCursor: encodeCursor(scopeKey, offset + visited),
          note: `Stopped at maxNodes=${maxNodes}; call again with cursor for the tokens in the rest of the subtree.`,
        }
      : {}),
  };
}

/** figma_get_variable_defs: the file's local tokens, or — with nodeId — the ones a design uses. */
export async function variableDefs(ctx: OpContext): Promise<Any> {
  const nodeId = str(ctx.params, "nodeId");
  return nodeId ? scopedDefs(ctx, nodeId) : fileDefs(ctx);
}

// ── figma_get_library_variables [C-107] ─────────────────────────────────────

interface TeamLibrary {
  getAvailableLibraryVariableCollectionsAsync?(): Promise<ReadonlyArray<{ key: string; name: string; libraryName: string }>>;
  getVariablesInLibraryCollectionAsync?(key: string): Promise<ReadonlyArray<{ key: string; name: string; resolvedType: string }>>;
}

const LIBRARY_HINT =
  `It needs the teamlibrary permission in the plugin manifest (run \`${SETUP_COMMAND}\` to copy the current plugin, then re-run the ${PLUGIN_NAME} plugin in Figma) and the library enabled ` +
  "in this file (Assets → Libraries) — a plugin cannot enable a library itself.";

/**
 * Library variables a plugin CAN list (components and styles it cannot): the
 * collections of every library enabled for this file, then a collection's
 * variables by key. Importing one is by key, through the variables API.
 */
const getLibraryVariables: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    let lib: TeamLibrary | undefined;
    try {
      lib = (api() as unknown as { teamLibrary?: TeamLibrary }).teamLibrary;
    } catch {
      lib = undefined;
    }
    if (!lib || typeof lib.getAvailableLibraryVariableCollectionsAsync !== "function" || typeof lib.getVariablesInLibraryCollectionAsync !== "function") {
      throw new BridgeError(ErrorCode.UNSUPPORTED, "figma.teamLibrary is not available to this plugin.", { hint: LIBRARY_HINT });
    }
    const query = str(ctx.params, "query")?.toLowerCase();
    const key = str(ctx.params, "collectionKey");
    if (!key) {
      let collections: ReadonlyArray<{ key: string; name: string; libraryName: string }>;
      try {
        collections = await lib.getAvailableLibraryVariableCollectionsAsync();
      } catch (err) {
        throw new BridgeError(ErrorCode.UNSUPPORTED, `Figma would not list library variable collections: ${message(err)}`, { hint: LIBRARY_HINT });
      }
      const hits = collections
        .filter((c) => !query || c.name.toLowerCase().includes(query) || c.libraryName.toLowerCase().includes(query))
        .map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName }));
      return {
        collections: hits,
        count: hits.length,
        ...(collections.length === 0 ? { note: `No enabled library has published variables. ${LIBRARY_HINT}` } : {}),
      };
    }
    const type = str(ctx.params, "type")?.toUpperCase();
    if (type && !(VARIABLE_TYPES as readonly string[]).includes(type)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`type` must be COLOR, FLOAT, STRING or BOOLEAN.");
    let list: ReadonlyArray<{ key: string; name: string; resolvedType: string }>;
    try {
      list = await lib.getVariablesInLibraryCollectionAsync(key);
    } catch (err) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, `Figma would not list the library collection \`${key}\`: ${message(err)}`, {
        hint: `figma_get_library_variables without collectionKey lists the keys. ${LIBRARY_HINT}`,
      });
    }
    const hits = list.filter((v) => (!query || v.name.toLowerCase().includes(query)) && (!type || v.resolvedType === type));
    const limit = int(ctx.params, "limit", 200, 1000) || 200;
    const scopeKey = `libvars:${key}:${query ?? ""}:${type ?? ""}`;
    const offset = decodeCursor(str(ctx.params, "cursor"), scopeKey);
    const page = hits.slice(offset, offset + limit).map((v) => ({ key: v.key, name: v.name, resolvedType: v.resolvedType }));
    const more = offset + page.length < hits.length;
    return {
      collectionKey: key,
      variables: page,
      count: page.length,
      total: hits.length,
      truncated: more,
      ...(more ? { nextCursor: encodeCursor(scopeKey, offset + page.length) } : {}),
    };
  },
};

export const TOKEN_OPS: Record<string, PluginOp> = {
  get_library_variables: getLibraryVariables,
  create_variables: createVariables,
  create_grid_style: createStyleOp("GRID"),
  set_variable_properties: setVariableProperties,
  update_variable_collection: updateVariableCollection,
  set_variable_mode: setVariableMode,
  update_style: updateStyle,
};
