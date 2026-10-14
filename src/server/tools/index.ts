// Tool registration. The toolset (BRIDGE_TOOLSET + BRIDGE_ALLOW_EVAL) decides
// which catalog tools are wanted; a tool is registered only once it is
// implemented. Phase 0 implemented figma_status; Phase 1 adds the read group
// (spec §12). Later phases add a module per group here (create.ts, modify.ts, …).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OPS, selectOps, toolName } from "../../shared/ops.js";
import type { Bridge } from "../bridge.js";
import type { Config, Logger } from "../config.js";
import { createShapeRecorder, registerBatch } from "./batch.js";
import { registerCheckMotion } from "./check-motion.js";
import { registerComponents } from "./components.js";
import { registerCreate } from "./create.js";
import { registerGuide } from "./guide.js";
import { registerTypography } from "./typography.js";
import { registerEval } from "./eval.js";
import { registerExport } from "./export.js";
import { registerFigjam } from "./figjam.js";
import { registerModify } from "./modify.js";
import { registerMotion } from "./motion.js";
import { registerNavigate } from "./navigate.js";
import { registerStatus } from "./meta.js";
import { registerRead } from "./read.js";
import { registerReview } from "./review.js";
import { registerSlides } from "./slides.js";
import { registerStoryboard } from "./storyboard.js";
import { registerStyle } from "./style.js";
import { registerTokens } from "./tokens.js";

/** Read ops whose server-side tool is implemented (spec §12 phase 1). */
const IMPLEMENTED_READ = [
  "get_metadata", "get_pages", "get_node", "get_nodes_info", "get_selection", "get_design_context",
  "search_nodes", "scan_nodes_by_types", "scan_text_nodes", "get_styles", "get_variable_defs",
  "get_local_components", "get_fonts", "get_annotations", "get_reactions", "check_layout", "suggest_fonts",
  "get_library_variables", "get_component", "get_motion_context", "check_motion", "get_slide_grid",
] as const;

/** Create ops implemented so far (spec §12 phase 2). */
const IMPLEMENTED_CREATE = [
  "create_from_spec", "create_frame", "create_text", "create_rectangle", "create_ellipse",
  "create_line", "create_polygon", "create_star", "create_vector",
  "create_section", "create_page", "create_instance", "convert_to_component", "combine_as_variants", "create_variable_collection",
  "create_variable", "create_paint_style", "create_text_style", "create_effect_style", "import_svg", "import_image",
  "create_variables", "create_grid_style", "import_library_assets", "create_slot",
  "create_stickies", "create_shapes_with_text", "create_connectors", "create_table", "create_code_block", "create_link_preview",
  "create_slides", "create_storyboard", "create_animatic",
] as const;

/** Export ops implemented so far (spec §12 phase 1: figma_export_node). */
const IMPLEMENTED_EXPORT = ["export_node", "save_screenshots", "export_frames_to_pdf", "download_assets", "export_video", "review_video"] as const;

/** Style ops implemented so far (spec §12 phase 2: fills, strokes, corner radius). */
const IMPLEMENTED_STYLE = [
  "set_fills", "set_strokes", "set_corner_radius", "set_effects", "set_blend_mode", "set_layout_grids", "apply_style_to_node",
  "bind_variable_to_node", "set_reactions", "remove_reactions",
  "set_variable_mode", "update_style", "set_description", "set_keyframes", "remove_keyframes", "set_scroll_behavior", "set_prototype_flows",
  "set_slide_transition",
] as const;

/** Meta ops answered by the plugin (figma_status is the bridge's own). */
const IMPLEMENTED_META = ["select", "navigate_page", "zoom_to"] as const;

/** Modify ops implemented so far (spec §12 phase 2). */
const IMPLEMENTED_MODIFY = [
  "set_text", "set_text_properties", "set_text_range", "find_replace_text", "rename_node", "batch_rename_nodes", "move_nodes",
  "resize_nodes", "rotate_nodes", "reorder_nodes", "reparent_nodes", "clone_node",
  "delete_nodes", "group_nodes", "ungroup_nodes", "boolean_nodes", "flatten_nodes", "set_mask", "set_visible", "set_locked", "set_opacity", "set_auto_layout",
  "set_constraints", "swap_component", "detach_instance", "add_component_property", "set_instance_properties", "add_variable_mode", "set_variable_value",
  "delete_variable", "delete_variable_collection", "delete_style", "undo_step",
  "set_clips_content", "batch", "set_variable_properties", "update_variable_collection",
  "edit_component_property", "delete_component_property", "reset_slot",
  "edit_table", "edit_connectors", "set_board_properties", "fit_sections",
  "set_slide_grid", "move_slides", "set_slide_properties",
] as const;

// Guard against these lists drifting from the catalog: a name here that tools.md
// does not list would register a tool the documentation never promised.
for (const op of [...IMPLEMENTED_READ, ...IMPLEMENTED_CREATE, ...IMPLEMENTED_MODIFY, ...IMPLEMENTED_STYLE, ...IMPLEMENTED_EXPORT, ...IMPLEMENTED_META]) {
  if (!OPS.has(op)) {
    throw new Error(`tools/index.ts marks \`${op}\` as implemented, but it is not in the catalog (shared/ops.ts)`);
  }
}

/** Phase 4: the escape hatch. Registered only when both keys allow it. */
const IMPLEMENTED_EVAL = ["eval"] as const;

const IMPLEMENTED = new Set<string>(["status", "get_guide", ...IMPLEMENTED_READ, ...IMPLEMENTED_CREATE, ...IMPLEMENTED_MODIFY, ...IMPLEMENTED_STYLE, ...IMPLEMENTED_EXPORT, ...IMPLEMENTED_META, ...IMPLEMENTED_EVAL]);

export interface Registration {
  selected: string[];
  registered: string[];
}

export function registerTools(server: McpServer, bridge: Bridge, config: Config, startedAt: number, logger?: Logger): Registration {
  const selected = selectOps(config.toolset, config.allowEval).map(toolName);
  const registered = selected.filter((t) => IMPLEMENTED.has(t.slice("figma_".length)));
  const ctx = { bridge, config, startedAt, selectedTools: selected, registeredTools: registered };

  const wanted = (op: string) => registered.includes(toolName(op));
  // figma_batch validates each step against the shape its own tool registered,
  // so the shapes are recorded from the first register call on.
  const shapeOf = createShapeRecorder(server);
  if (wanted("status")) registerStatus(server, ctx);
  registerGuide(server, wanted);
  // Each group registers once and skips the ops the toolset did not select, so
  // BRIDGE_TOOLSET=core registers only the core tier within each group.
  registerRead(server, bridge, wanted);
  registerCreate(server, bridge, wanted);
  registerModify(server, bridge, wanted, logger);
  registerStyle(server, bridge, wanted);
  registerNavigate(server, bridge, wanted);
  registerTypography(server, bridge, { exportDir: config.exportDir, exportRoots: config.exportRoots }, wanted);
  registerExport(server, bridge, { exportDir: config.exportDir, exportRoots: config.exportRoots }, wanted);
  registerTokens(server, bridge, wanted);
  registerComponents(server, bridge, wanted);
  registerMotion(server, bridge, { exportDir: config.exportDir, exportRoots: config.exportRoots }, wanted);
  registerCheckMotion(server, bridge, wanted);
  registerReview(server, { exportDir: config.exportDir, exportRoots: config.exportRoots }, wanted);
  registerFigjam(server, bridge, wanted);
  registerSlides(server, bridge, wanted);
  registerStoryboard(server, bridge, wanted);
  // The two-key rule (ADR #9) is enforced here: without BRIDGE_ALLOW_EVAL the op
  // is not selected, so `wanted` is already false and this returns immediately.
  if (logger) registerEval(server, bridge, logger, wanted, config.allowEval);
  // Last: a batch step may name any tool registered above.
  registerBatch(server, bridge, wanted, shapeOf);

  return { selected, registered };
}
