// The `tells` audit's kinds, in the one list the plugin, the bridge and a
// brief's `avoid` list share (role quality plan, W1 and W2:
// docs/superpowers/plans/2026-10-20-role-quality.md).
//
// The first list is what src/plugin/tells.ts reports today. The second is
// planned: a planned kind is a valid `avoid` entry and is mapped to the tells
// audit, but nothing reports it until tells.ts measures it. A cluster of the
// design skill's tells table is reported as its own kind, cluster_1 … cluster_6,
// so an `avoid` entry can name one.
//
// No runtime dependencies: the plugin bundles this (ES2017).

export const TELL_KINDS_MEASURED = [
  "default_typeface", "flat_hierarchy", "too_many_sizes", "centred_block", "mostly_centred", "eyebrow_everywhere", "measure", "leading",
  "card_trio", "nested_cards", "one_radius", "nested_radius", "same_shadow", "default_gradient", "glow", "emoji_icon", "chrome_string",
  "divider_everywhere",
  // Measured since 2026-10-20 (role quality plan W2). Sameness and structure.
  "skeleton_repeat", "flat_rhythm", "boxiness", "centred_stage",
  // The dashboard kit (cluster 6).
  "icon_tile", "kpi_tile", "greeting_title", "accent_share",
  // Second-order defaults.
  "hue_pair", "reflex_display_face",
  // The clusters of the design skill's tells table.
  "cluster_1", "cluster_2", "cluster_3", "cluster_4", "cluster_5", "cluster_6",
] as const;

/** Kinds named before tells.ts measures them: none at the moment, since W2 measured every planned one. */
export const TELL_KINDS_PLANNED = [] as const;

export const TELL_KINDS = [...TELL_KINDS_MEASURED, ...TELL_KINDS_PLANNED] as const;
export type TellKind = (typeof TELL_KINDS)[number];

const SET: ReadonlySet<string> = new Set<string>(TELL_KINDS);

/** Whether `s` names a tells kind, measured or planned. */
export function isTellKind(s: string): s is TellKind {
  return SET.has(s);
}
