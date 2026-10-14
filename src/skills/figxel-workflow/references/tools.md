# Choosing a tool

| Intent | Tool |
|---|---|
| Is Figma connected, is everything current | figma_status (follow build.restart; `skills` is the version of the guides) |
| How to work: the skills | figma_get_guide (no arguments: the loop; topic "skills": every skill and its sections) |
| What the user selected | figma_get_selection |
| Pages | figma_get_pages, figma_navigate_page, figma_create_page |
| Understand a design | figma_get_design_context (follow nextCursor) |
| One node / several nodes | figma_get_node, figma_get_nodes_info |
| Find things | figma_search_nodes, figma_scan_nodes_by_types, figma_scan_text_nodes |
| The design system | figma_get_design_context (stylesUsed, incl. library), figma_get_styles (local, with values), figma_get_variable_defs (values per mode; { nodeId } for one screen's tokens), figma_get_local_components, figma_get_component, figma_get_fonts |
| Team libraries | figma_get_library_variables, figma_import_library_assets (components, sets, styles, variables by key) |
| **A whole section or screen** | **figma_create_from_spec** (frames, text, shapes, svg icons, images, instances in one call) |
| A single container | figma_create_frame (+ figma_set_auto_layout to change it later) |
| Text | figma_create_text, figma_set_text, figma_find_replace_text |
| Typography | figma_get_fonts (what loads: scope "available" filtered by `families` or `query`, never the whole list), figma_suggest_fonts (optional: style names; its ranking is the default to beat), figma_set_text_properties, figma_set_text_range |
| Icons and images | figma_import_svg, figma_import_image |
| A layer of this file as a picture (a styleframe into a storyboard panel) | figma_import_image { renderNodeId, nodeId } |
| Shapes | figma_create_rectangle, figma_create_ellipse, figma_create_polygon, figma_create_star, figma_create_line, figma_create_vector (any SVG path) |
| Shape operations | figma_boolean_nodes (union / subtract / intersect / exclude), figma_flatten_nodes, figma_set_mask |
| Components | figma_convert_to_component, figma_combine_as_variants, figma_add_component_property, figma_edit_component_property, figma_delete_component_property, figma_create_instance, figma_set_instance_properties, figma_swap_component, figma_detach_instance |
| Slots | figma_create_slot, figma_reset_slot |
| Descriptions and doc links | figma_set_description (components, sets, styles, variables) |
| Paint | figma_set_fills, figma_set_strokes, figma_set_corner_radius, figma_set_effects, figma_set_opacity, figma_set_blend_mode |
| Clip content | figma_set_clips_content |
| Layout grids | figma_set_layout_grids, figma_create_grid_style |
| Tokens | figma_create_variables (a family per call), figma_set_variable_properties (scopes, codeSyntax), figma_update_variable_collection, figma_apply_style_to_node, figma_bind_variable_to_node, figma_create_variable…, figma_create_…_style, figma_update_style |
| Show a mode (e.g. Dark) | figma_set_variable_mode |
| Arrange | figma_move_nodes (x and y written together and read back), figma_resize_nodes (width, height, sizing), figma_rotate_nodes, figma_reorder_nodes, figma_reparent_nodes, figma_group_nodes, figma_set_constraints |
| Duplicate | figma_clone_node (lands right after its source) |
| **A polish pass** (many small edits, one undo) | figma_batch (`itemsFailed` lists nodes a step could not change) |
| Check | figma_check_layout (audits tokens, names, fonts, craft, tells; `safeArea`, `minTextSize`), figma_export_node (one view at a time: the default cap to read it, `maxSize` about its long side ÷ 8 to squint) |
| Assets for code | figma_download_assets (renders + original image bytes) |
| Show the user | figma_select, figma_zoom_to |
| Remove your own work | figma_delete_nodes (ids you created) |
| Prototype | figma_set_reactions, figma_get_reactions, figma_set_scroll_behavior, figma_set_prototype_flows |
| Motion (timeline animation) | figma_get_motion_context, figma_set_keyframes, figma_remove_keyframes (every track read back) |
| Plan a motion piece | figma_create_storyboard (panels, timing, `offBeat` and `readTime` lists), figma_create_animatic (the board as timed plates, ready to render); both still unverified in Design, so their writes are refused there unless BRIDGE_ALLOW_UNVERIFIED is set; the storyboard skill then builds them by hand |
| Check keyframes before rendering | figma_check_motion (pops, one frame carrying a move, dead stretches, read times, beats) |
| See it move | figma_export_video (job mode: `jobId`, `wait`; exact frames with `frameIndices`), then figma_review_video on the file (contact sheet, close-ups, stills, metrics; at most `maxImages` pictures inline, so batch them; no second render) |

On a FigJam board (topic figjam):

| Intent | Tool |
|---|---|
| Read the board | figma_get_design_context (stickies, shapes, connectors with their `connectors` edge list, tables, code), figma_get_metadata (`board`: top-level sections, counts by type) |
| **A zone** (section, title, stickies or cards, connectors by ref) | **figma_create_from_spec** with the FigJam types |
| Many stickies into an existing zone | figma_create_stickies |
| Flowchart steps, decisions, databases | figma_create_shapes_with_text |
| Lines between nodes | figma_create_connectors (after the nodes exist; never move them later), figma_edit_connectors |
| Rows and columns of data | figma_create_table, figma_edit_table (cells, rows, columns) |
| Code, a web page | figma_create_code_block, figma_create_link_preview |
| Colour by palette name, wide stickies, shape type, code language | figma_set_board_properties |
| Fit sections to their content | figma_fit_sections |
| Check a zone | figma_check_layout (audit board) |

In a Figma Slides deck (topic slides):

| Intent | Tool |
|---|---|
| The deck: rows, slides, notes | figma_get_slide_grid — start here |
| Add slides | figma_create_slides (3–5 per call), then figma_create_from_spec per slide |
| Reorder, regroup | figma_move_slides (a few slides), figma_set_slide_grid (the whole deck) |
| Skip a slide, speaker notes | figma_set_slide_properties |
| Transitions | figma_set_slide_transition |
| Check a batch of slides | figma_check_layout (nodeIds) |
| Focus a slide, grid or single view | figma_zoom_to (view) |
| The deck as one PDF | figma_export_frames_to_pdf (deck: true) |
