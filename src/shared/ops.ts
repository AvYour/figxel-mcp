// Op table — mirrors docs/reference/tools.md, the source of truth for the tool
// list. test/ops.test.ts parses tools.md and fails if this table drifts.
//
// An op name is the tool name without the `figma_` prefix. Per-op zod param
// schemas are added with each phase's tools (src/server/tools/*.ts); Phase 0
// only implements `figma_status`.

export const GROUPS = ["meta", "read", "create", "modify", "style", "export", "eval"] as const;
export type Group = (typeof GROUPS)[number];

export interface OpInfo {
  group: Group;
  /** Document-write op: carries an idempotencyKey and ends with commitUndo(). */
  write: boolean;
  /** MCP `readOnlyHint` — meta/read/export groups. */
  readOnly: boolean;
  /** MCP `destructiveHint`. */
  destructive: boolean;
  /** Answered by the bridge itself, never forwarded to the plugin. */
  bridgeOnly: boolean;
  /** A single host call (exportAsync) — gets the export idle timeout. */
  exportOp: boolean;
}

const BY_GROUP: Record<Group, readonly string[]> = {
  meta: ["status", "get_guide", "select", "navigate_page", "zoom_to"],
  read: [
    "get_metadata", "get_design_context", "get_node", "get_selection", "get_nodes_info",
    "get_variable_defs", "get_styles", "get_local_components", "get_fonts", "search_nodes",
    "scan_nodes_by_types", "scan_text_nodes", "get_pages", "get_annotations", "get_reactions", "suggest_fonts", "check_layout",
    "get_library_variables", "get_component", "get_motion_context", "check_motion", "get_slide_grid",
  ],
  create: [
    "create_from_spec", "create_frame", "create_text", "create_rectangle", "create_ellipse",
    "create_line", "create_polygon", "create_star", "create_vector",
    "create_section", "create_page", "create_instance", "convert_to_component", "combine_as_variants",
    "create_variable_collection", "create_variable", "create_paint_style", "create_text_style",
    "create_effect_style", "import_svg", "import_image",
    "create_variables", "create_grid_style", "import_library_assets", "create_slot",
    "create_stickies", "create_shapes_with_text", "create_connectors", "create_table", "create_code_block", "create_link_preview",
    "create_slides", "create_storyboard", "create_animatic",
  ],
  modify: [
    "set_text", "set_text_properties", "set_text_range", "find_replace_text", "rename_node", "batch_rename_nodes", "move_nodes",
    "resize_nodes", "rotate_nodes", "reorder_nodes", "reparent_nodes", "clone_node",
    "delete_nodes", "group_nodes", "ungroup_nodes", "boolean_nodes", "flatten_nodes", "set_mask", "set_visible", "set_locked", "set_opacity",
    "set_auto_layout", "set_constraints", "swap_component", "detach_instance", "add_component_property", "set_instance_properties",
    "add_variable_mode", "set_variable_value", "delete_variable", "delete_variable_collection", "delete_style",
    "undo_step",
    "set_clips_content", "batch", "set_variable_properties", "update_variable_collection",
    "edit_component_property", "delete_component_property", "reset_slot",
    "edit_table", "edit_connectors", "set_board_properties", "fit_sections",
    "set_slide_grid", "move_slides", "set_slide_properties",
  ],
  style: [
    "set_fills", "set_strokes", "set_corner_radius", "set_effects", "set_blend_mode", "set_layout_grids",
    "apply_style_to_node", "bind_variable_to_node", "set_reactions", "remove_reactions",
    "set_variable_mode", "update_style", "set_description", "set_keyframes", "remove_keyframes",
    "set_scroll_behavior", "set_prototype_flows", "set_slide_transition",
  ],
  export: ["export_node", "save_screenshots", "export_frames_to_pdf", "download_assets", "export_video", "review_video"],
  eval: ["eval"],
};

const WRITE_GROUPS = new Set<Group>(["create", "modify", "style", "eval"]);
const READ_ONLY_GROUPS = new Set<Group>(["meta", "read", "export"]);
// update_variable_collection: `removeModes` deletes every variable's value for
// the mode. reset_slot: drops the layers added into a slot. edit_table: removed
// rows and columns take their cells' text. Each loses work, so each carries
// destructiveHint and none may run inside figma_batch.
const DESTRUCTIVE = new Set([
  "delete_nodes", "detach_instance", "ungroup_nodes", "delete_variable", "delete_variable_collection", "delete_style",
  "delete_component_property", "update_variable_collection", "reset_slot", "undo_step", "eval", "edit_table",
]);
// review_video reads a file the bridge already wrote: no Figma call, no plugin op.
const BRIDGE_ONLY = new Set(["status", "get_guide", "review_video"]);

export const OPS: ReadonlyMap<string, OpInfo> = new Map(
  GROUPS.flatMap((group) =>
    BY_GROUP[group].map((op): [string, OpInfo] => [
      op,
      {
        group,
        write: WRITE_GROUPS.has(group),
        readOnly: READ_ONLY_GROUPS.has(group),
        destructive: DESTRUCTIVE.has(op),
        bridgeOnly: BRIDGE_ONLY.has(op),
        exportOp: group === "export",
      },
    ]),
  ),
);

export const TOOL_PREFIX = "figma_";
export const toolName = (op: string): string => `${TOOL_PREFIX}${op}`;
export const opName = (tool: string): string =>
  tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool;

/** tools.md § Trimming the toolset — the curated 20-tool `core` tier. */
export const CORE_OPS: readonly string[] = [
  "status", "get_guide", "check_layout", "get_design_context", "get_node", "get_selection", "export_node", "create_from_spec",
  "create_frame", "create_text", "set_text", "set_fills", "move_nodes", "resize_nodes",
  "delete_nodes", "search_nodes", "get_variable_defs", "get_styles", "navigate_page", "zoom_to",
];

export type Toolset =
  | { kind: "full" }
  | { kind: "core" }
  | { kind: "none" }
  | { kind: "groups"; groups: Group[] };

/**
 * Parse `BRIDGE_TOOLSET`. Throws on an unrecognised value — tools.md: "the
 * server refuses to start … rather than silently falling back to `full`".
 */
export function parseToolset(raw: string | undefined): Toolset {
  const value = (raw ?? "").trim();
  if (value === "" || value === "full") return { kind: "full" };
  if (value === "core") return { kind: "core" };
  if (value === "none") return { kind: "none" };
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const unknown = parts.filter((p) => !(GROUPS as readonly string[]).includes(p));
  if (parts.length === 0 || unknown.length > 0) {
    throw new Error(
      `BRIDGE_TOOLSET="${raw}" is not recognised` +
        (unknown.length ? ` (unknown group: ${unknown.join(", ")})` : "") +
        `. Use full, core, none, or a comma list of: ${GROUPS.join(", ")}.`,
    );
  }
  return { kind: "groups", groups: [...new Set(parts)] as Group[] };
}

export function toolsetLabel(toolset: Toolset): string {
  return toolset.kind === "groups" ? toolset.groups.join(",") : toolset.kind;
}

/**
 * The ops the toolset selects, before asking whether each is implemented yet.
 * Standing rules (tools.md): `status` is always in; `get_guide` is in every
 * toolset except `none`, because its skills are how an agent learns to use
 * the tools it was given; `eval` needs both `allowEval` and a toolset that
 * includes the `eval` group.
 */
export function selectOps(toolset: Toolset, allowEval: boolean): string[] {
  const all = [...OPS.keys()];
  let picked: string[];
  switch (toolset.kind) {
    case "full":
      picked = all;
      break;
    case "core":
      picked = [...CORE_OPS];
      break;
    case "none":
      picked = [];
      break;
    case "groups":
      picked = all.filter((op) => toolset.groups.includes(OPS.get(op)!.group));
      break;
  }
  const out = new Set(picked);
  out.add("status");
  if (toolset.kind !== "none") out.add("get_guide");
  if (!allowEval) out.delete("eval");
  return all.filter((op) => out.has(op));
}
