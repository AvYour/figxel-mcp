// A brief's `avoid` list: the tells kinds the work must not show (role quality
// plan W1 and W3, docs/superpowers/plans/2026-10-20-role-quality.md).
//
// `defaultToAvoid` and `direction0` stay prose; `avoid` is what the checks
// match. At the page and top gears a finding whose kind the list names is a
// warning in figma_check_layout, whatever the kind's own severity, and a
// warning fails figma_sign_off: no answer clears it, only the work or the
// brief changing does. The same gears run the tells audit by default, in
// figma_check_layout and on what figma_create_from_spec builds.
//
// One set of rules for the server (figma_set_brief's refusal, the create
// call's summary) and the plugin (the record, the check). No runtime
// dependencies beyond the shared tables: the plugin bundles this (ES2017).

import { signOffSet, type BriefRecord, type Gear, type RoleId } from "./roles.js";
import { isTellKind, TELL_KINDS } from "./tells-kinds.js";

/** Entries an avoid list holds at most. */
export const AVOID_MAX = 24;

/** The gears at which the list binds and tells run by default. */
export const AVOID_GEARS: readonly Gear[] = ["page", "top"];

export const avoidBinds = (gear: Gear): boolean => AVOID_GEARS.indexOf(gear) >= 0;

/** A stored list as the checks read it: its tells kinds, once each; anything else in it is ignored. */
export function avoidOf(brief: { avoid?: unknown } | undefined): string[] {
  const raw = brief?.avoid;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) if (typeof k === "string" && isTellKind(k) && out.indexOf(k) < 0) out.push(k);
  return out;
}

/** The kinds a brief makes warnings of: its avoid list at the page and top gears, none elsewhere. */
export function boundKinds(brief: (Pick<BriefRecord, "gear"> & { avoid?: unknown }) | undefined): string[] {
  return brief && avoidBinds(brief.gear) ? avoidOf(brief) : [];
}

/**
 * Whether the tells audit runs by default under a brief: at the page and top
 * gears, where the role's sign-off judges tells (ux, graphic, brand,
 * presentation), or where the brief avoids one (any role).
 */
export function tellsByDefault(role: RoleId, gear: Gear, avoid: readonly string[]): boolean {
  if (!avoidBinds(gear)) return false;
  return avoid.length > 0 || (signOffSet(role, gear)?.audits ?? []).indexOf("tells") >= 0;
}

/** The kind a near miss meant: "cluster:4" or "Card trio" for cluster_4 or card_trio. */
function meant(entry: string): string | undefined {
  const k = entry.trim().toLowerCase().replace(/[\s:.-]+/g, "_");
  return isTellKind(k) ? k : undefined;
}

/** Why a list cannot be stored, or null: every entry must be a tells kind (measured or planned). */
export function avoidRefusal(list: readonly unknown[]): { message: string; hint: string } | null {
  const bad = list.filter((e) => typeof e !== "string" || !isTellKind(e));
  if (!bad.length) return null;
  const named = bad.map((e) => {
    const m = typeof e === "string" ? meant(e) : undefined;
    return `${JSON.stringify(e)}${m ? ` (did you mean "${m}"?)` : ""}`;
  });
  return {
    message: `\`avoid\` takes tells kinds, and ${named.join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`,
    hint: `The kinds: ${TELL_KINDS.join(", ")}. figma_get_guide { topic: "design", section: "tells" } says what each one measures.`,
  };
}

/** The sentence a finding's detail ends with once the brief's avoid list makes it a warning. */
export const avoidNote = (kind: string): string =>
  `The brief's avoid list names ${kind}: a warning no answer at sign-off clears. Change the work, or the brief on the owner's word.`;

/**
 * Make each finding of a kind the brief avoids a warning (an error stays an
 * error), its detail saying why. In place; a finding already bound is left
 * as it is, so running it twice changes nothing. Returns how many it bound.
 */
export function bindAvoid(issues: Array<{ kind: string; severity: string; detail: string }>, brief: (Pick<BriefRecord, "gear"> & { avoid?: unknown }) | undefined): number {
  const kinds = boundKinds(brief);
  if (!kinds.length) return 0;
  let n = 0;
  for (const i of issues) {
    if (kinds.indexOf(i.kind) < 0) continue;
    const note = avoidNote(i.kind);
    if (i.detail.indexOf(note) >= 0) continue;
    if (i.severity !== "error") i.severity = "warning";
    i.detail = `${i.detail} ${note}`;
    n++;
  }
  return n;
}
