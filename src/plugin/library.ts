// figma_check_layout's `library` audit: what a design-system designer checks
// before the system ships (role spec §4.8) — every semantic token valued in
// every mode, no alias pointing at nothing, semantic tokens scoped by role,
// code syntax for the platforms the system serves, and every component
// described.
//
// Tokens are the file's, not the subtree's: they are read once, before the
// judging, through figma.variables (getLocalVariablesAsync,
// getLocalVariableCollectionsAsync, and getVariableByIdAsync for an alias
// whose target is not local). A semantic token is one the design-system skill
// would call so: an alias in some mode, or a token in a collection with more
// than one mode; primitives sit in one mode with `scopes: []`. Descriptions are
// read off the component sets and main components in the checked subtree.
//
// Warnings where a token is broken: a mode with no value, an alias that no
// longer resolves. The rest is info until calibrated (§4.9). The judging is a
// plain function; readLibrary is its one lookup, as check.ts makes the
// others beforehand.

import { type RoleContext } from "./a11y.js";
import { field } from "./board-read.js";
import type { Census, Finding, Index } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Every limit of the library audit, to calibrate here. */
export const LIBRARY = {
  /** Variables read, and alias targets looked up one by one, so a large system stays fast. */
  variableCap: 5000,
  lookupCap: 500,
  /** Names listed in a grouped finding. */
  listed: 5,
  /** details.platforms → the codeSyntax platform it needs (Variable.codeSyntax: WEB, ANDROID, iOS). */
  platforms: { web: "WEB", responsive: "WEB", desktop: "WEB", ios: "iOS", android: "ANDROID" } as Readonly<Record<string, "WEB" | "iOS" | "ANDROID">>,
} as const;

export interface VariableFacts {
  id: string;
  name: string;
  collectionId: string;
  resolvedType: string;
  valuesByMode: Record<string, unknown>;
  scopes: string[];
  codeSyntax: Record<string, string>;
}

export interface CollectionFacts {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  isExtension: boolean;
}

/** The file's tokens as the audit reads them; `read: false` (with why) when figma.variables could not be read. */
export interface LibraryFacts {
  read: boolean;
  why?: string;
  variables: VariableFacts[];
  collections: Map<string, CollectionFacts>;
  /** Alias targets that do not resolve, by id. */
  unresolved: Set<string>;
}

type Variables = {
  getLocalVariablesAsync?: (type?: string) => Promise<unknown[]>;
  getLocalVariableCollectionsAsync?: () => Promise<unknown[]>;
  getVariableByIdAsync?: (id: string) => Promise<unknown>;
};

const isAlias = (v: unknown): v is { type: "VARIABLE_ALIAS"; id: string } =>
  !!v && typeof v === "object" && (v as Any).type === "VARIABLE_ALIAS" && typeof (v as Any).id === "string";

/** Read the file's local variables and collections, and resolve every alias target that is not local. Never throws. */
export async function readLibrary(api: unknown): Promise<LibraryFacts> {
  const none = (why: string): LibraryFacts => ({ read: false, why, variables: [], collections: new Map(), unresolved: new Set() });
  const vars = field<Variables | null>(api, "variables");
  if (!vars || typeof vars.getLocalVariablesAsync !== "function") return none("this file's variables cannot be read here (no figma.variables)");
  let rawVars: unknown[];
  try {
    rawVars = ((await vars.getLocalVariablesAsync.call(vars)) ?? []) as unknown[];
  } catch (err) {
    return none(`reading the variables failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const variables: VariableFacts[] = [];
  for (const v of rawVars.slice(0, LIBRARY.variableCap)) {
    const id = field<string>(v, "id");
    if (typeof id !== "string") continue;
    const modes = field<Record<string, unknown>>(v, "valuesByMode");
    const scopes = field<unknown[]>(v, "scopes");
    const code = field<Record<string, unknown>>(v, "codeSyntax");
    variables.push({
      id,
      name: String(field(v, "name") ?? id),
      collectionId: String(field(v, "variableCollectionId") ?? ""),
      resolvedType: String(field(v, "resolvedType") ?? ""),
      valuesByMode: modes && typeof modes === "object" ? modes : {},
      scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
      codeSyntax: code && typeof code === "object"
        ? Object.fromEntries(Object.entries(code).filter((e): e is [string, string] => typeof e[1] === "string"))
        : {},
    });
  }
  const collections = new Map<string, CollectionFacts>();
  if (typeof vars.getLocalVariableCollectionsAsync === "function") {
    try {
      for (const c of ((await vars.getLocalVariableCollectionsAsync.call(vars)) ?? []) as unknown[]) {
        const id = field<string>(c, "id");
        const modes = field<unknown[]>(c, "modes");
        if (typeof id !== "string") continue;
        collections.set(id, {
          id,
          name: String(field(c, "name") ?? id),
          modes: Array.isArray(modes)
            ? modes.filter((m): m is { modeId: string; name: string } => !!m && typeof (m as Any).modeId === "string").map((m) => ({ modeId: m.modeId, name: String(m.name ?? m.modeId) }))
            : [],
          isExtension: field(c, "isExtension") === true,
        });
      }
    } catch {
      /* no collections: the modes rule has nothing to compare against */
    }
  }
  // An alias to a local variable resolves; any other is looked up once.
  const local = new Set(variables.map((v) => v.id));
  const unresolved = new Set<string>();
  const asked = new Set<string>();
  for (const v of variables) {
    for (const value of Object.values(v.valuesByMode)) {
      if (!isAlias(value) || local.has(value.id) || asked.has(value.id) || asked.size >= LIBRARY.lookupCap) continue;
      asked.add(value.id);
      let target: unknown = null;
      try {
        target = typeof vars.getVariableByIdAsync === "function" ? await vars.getVariableByIdAsync.call(vars, value.id) : undefined;
      } catch {
        target = null;
      }
      // Without a way to ask, an alias is not called broken.
      if (target === null) unresolved.add(value.id);
    }
  }
  return { read: true, variables, collections, unresolved };
}

type Push = (n: { id: string; name: string }, kind: string, severity: Finding["severity"], detail: string) => void;

const listOf = (names: string[]) =>
  `${names.slice(0, LIBRARY.listed).map((n) => `"${n}"`).join(", ")}${names.length > LIBRARY.listed ? `, and ${names.length - LIBRARY.listed} more` : ""}`;

export function judgeLibrary(c: Census, ix: Index, rc: RoleContext, lib: LibraryFacts): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const unmeasured: string[] = [];
  if (lib.read) {
    const semantic = (v: VariableFacts) => {
      const col = lib.collections.get(v.collectionId);
      return Object.values(v.valuesByMode).some(isAlias) || (!!col && col.modes.length > 1);
    };
    modeValues(lib, semantic, push);
    aliases(lib, push);
    scopes(lib, semantic, push);
    const platforms = (rc.brief?.details as Any | undefined)?.platforms;
    if (Array.isArray(platforms) && platforms.length) codeSyntax(lib, platforms, push);
    else if (lib.variables.length) unmeasured.push(`code_syntax_missing (${rc.brief ? "the brief lists no details.platforms" : "no brief was given: figma_check_layout { briefId }"})`);
  } else {
    unmeasured.push(`mode_value_missing, alias_broken, scope_all and code_syntax_missing (${lib.why})`);
  }
  descriptions(c, push);
  if (unmeasured.length) push(c.rootNode, "library_unmeasured", "info", `not measured: ${unmeasured.join("; ")}. The rest of the library audit ran.`);
  return out;
}

/** mode_value_missing: a semantic token with no value in one of its collection's modes — a frame in that mode shows nothing, or the wrong value. */
function modeValues(lib: LibraryFacts, semantic: (v: VariableFacts) => boolean, push: Push): void {
  for (const v of lib.variables) {
    const col = lib.collections.get(v.collectionId);
    if (!col || col.isExtension || !semantic(v)) continue; // an extension inherits what it does not override
    const missing = col.modes.filter((m) => v.valuesByMode[m.modeId] === undefined || v.valuesByMode[m.modeId] === null);
    if (!missing.length) continue;
    push(v, "mode_value_missing", "warning",
      `has no value in the mode${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m.name}"`).join(", ")} of "${col.name}": a frame set to ` +
        "that mode shows nothing, or the wrong value. Give it one (figma_set_variable_value) — an alias to a primitive, as its other modes have.");
  }
}

/** alias_broken: an alias whose target no longer resolves — deleted, or in a library this file no longer reaches. */
function aliases(lib: LibraryFacts, push: Push): void {
  if (!lib.unresolved.size) return;
  for (const v of lib.variables) {
    const col = lib.collections.get(v.collectionId);
    const broken = Object.keys(v.valuesByMode).filter((m) => {
      const value = v.valuesByMode[m];
      return isAlias(value) && lib.unresolved.has(value.id);
    });
    if (!broken.length) continue;
    const mode = (id: string) => col?.modes.find((m) => m.modeId === id)?.name ?? id;
    const first = v.valuesByMode[broken[0]!] as { id: string };
    push(v, "alias_broken", "warning",
      `aliases ${first.id}${broken.length > 1 ? " and more" : ""} in ${broken.map((m) => `"${mode(m)}"`).join(", ")}, which no longer resolves: the token ` +
        "has no value there. Point it at a live variable (figma_set_variable_value \"alias:<name>\"), or import the library it came from.");
  }
}

/** Variables by collection, in reading order: one grouped finding per collection keeps a large system's report short. */
function byCollection(list: VariableFacts[]): Map<string, VariableFacts[]> {
  const out = new Map<string, VariableFacts[]>();
  for (const v of list) out.set(v.collectionId, [...(out.get(v.collectionId) ?? []), v]);
  return out;
}

/** scope_all: semantic tokens left at ALL_SCOPES, offered by every picker for every field (design-system skill: scopes by role). */
function scopes(lib: LibraryFacts, semantic: (v: VariableFacts) => boolean, push: Push): void {
  const open = lib.variables.filter((v) => v.resolvedType !== "BOOLEAN" && semantic(v) && v.scopes.indexOf("ALL_SCOPES") >= 0);
  for (const [id, list] of byCollection(open)) {
    const col = lib.collections.get(id);
    const others = list.length - 1;
    push(list[0]!, "scope_all", "info",
      `is a semantic token in "${col?.name ?? id}" left at ALL_SCOPES${others ? `, as ${others === 1 ? "is 1 other" : `are ${others} others`} ` +
        `(${listOf(list.map((v) => v.name))})` : ""}: every picker offers ${others ? "them" : "it"} for every field. Scope each by its role — ` +
        "backgrounds FRAME_FILL / SHAPE_FILL, text TEXT_FILL, borders STROKE_COLOR, spacing GAP, radii CORNER_RADIUS — with " +
        "figma_set_variable_properties.");
  }
}

/** code_syntax_missing: a token with no code syntax for a platform details.platforms names (WEB, iOS, ANDROID). */
function codeSyntax(lib: LibraryFacts, platforms: unknown[], push: Push): void {
  const wanted = new Set<"WEB" | "iOS" | "ANDROID">();
  for (const p of platforms) {
    const k = typeof p === "string" ? p.trim().toLowerCase() : "";
    const syntax = LIBRARY.platforms[k];
    if (syntax) wanted.add(syntax);
  }
  for (const platform of wanted) {
    const missing = lib.variables.filter((v) => !(v.codeSyntax[platform] ?? "").trim());
    for (const [id, list] of byCollection(missing)) {
      const col = lib.collections.get(id);
      const others = list.length - 1;
      push(list[0]!, "code_syntax_missing", "info",
        `has no ${platform} code syntax${others ? `, nor ${others === 1 ? "has 1 other token" : `have ${others} other tokens`} in "${col?.name ?? id}" ` +
          `(${listOf(list.map((v) => v.name))})` : ""}, and the system serves ${platform} (details.platforms): a developer reading the file cannot ` +
          `tell the token's name in code. Add it as the codebase writes it (figma_set_variable_properties codeSyntax ${platform}).`);
    }
  }
}

/** description_missing: a component set, or a component outside a set, with no description — the assets panel and Dev Mode say nothing about when to use it. */
function descriptions(c: Census, push: Push): void {
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    const n: NodeLike = l.node;
    if (n.type !== "COMPONENT_SET" && !(n.type === "COMPONENT" && n.parent?.type !== "COMPONENT_SET")) continue;
    // Not a member the guarded view exposes: read off the node, as a missing one reads undefined.
    const d = field(n, "description");
    if (typeof d !== "string" || d.trim()) continue;
    push(n, "description_missing", "info",
      "has no description: the assets panel and Dev Mode say nothing about when to use it. Add one (figma_set_description), with a " +
        "documentation link where the system has docs.");
  }
}
