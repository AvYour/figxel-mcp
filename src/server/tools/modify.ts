// The modify group on the server side (tools.md § modify), Phase 2 core subset.
//
// Batch ops describe their per-item result shape in the tool description. That
// matters for an agent: `{ renamed: 37, items: [...] }` tells it exactly which
// three nodes failed and why, where a thrown error would leave it guessing.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fitDescription, paddingParam, positionParam, sizingParam, variableValueParam } from "./params.js";
import type { Logger } from "../config.js";
import type { Bridge } from "../bridge.js";
import { forwardTool, type Extra } from "./forward.js";
import { WRITE_PARAMS } from "./create.js";
import { writeAnnotations } from "./annotations.js";

const hex = z.string().regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Use #rgb, #rrggbb or #rrggbbaa");

const PER_ITEM =
  "Returns per-item results: `items: [{ id, ok, error? }]` — one node failing does not fail the call.";

export function registerModify(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, logger?: Logger): void {
  const tool = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) => {
        // spec §5.6.1: every undo is logged — it can take the user's manual work with it.
        if (op === "undo_step") logger?.warn(`undo_step requested: confirm=${String(args.confirm)} count=${String(args.count ?? 1)}`);
        return forwardTool(bridge, op, args, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        });
      },
    );
  };

  tool(
    "set_text",
    "Set text",
    "Replace the content of a TEXT node — or, on a board, of a sticky, shape or connector label, or a code block's " +
      "code (a table's cells: figma_edit_table). The node's current font is loaded first, so this works on text this " +
      "project did not create. If the node had more than one style (a bold word, a second font), Figma gives the new " +
      "text the first character's style and the rest is lost — the result then carries `flattened.runs` with the old " +
      "segments, so you can reapply them with figma_set_text_range.",
    { nodeId: z.string(), content: z.string() },
  );

  tool(
    "find_replace_text",
    "Find and replace text",
    "Find and replace across text: TEXT nodes and, on a board, stickies, shapes, connector labels and table cells (an " +
      "item names the node, plus `cell` \"row,column\"); code blocks with `includeCode`. Other styled runs in a text are " +
      "kept. Scope it to the page (default), the selection, or a subtree by nodeId. " +
      PER_ITEM,
    {
      find: z.string(),
      replace: z.string().describe('The new text; "" deletes each match.'),
      scope: z.enum(["page", "selection", "subtree"]).optional().describe("Default \"page\"."),
      nodeId: z.string().optional().describe("Subtree root when scope is \"subtree\"."),
      regex: z.boolean().optional().describe("Treat `find` as a regular expression. Default false."),
      caseSensitive: z.boolean().optional().describe("Default true."),
      includeCode: z.boolean().optional().describe("Also replace inside code blocks' code. Default false."),
    },
  );

  tool(
    "rename_node",
    "Rename node",
    "Rename one node. The previous name is returned, so a rename can be reported as a change rather than an assertion.",
    { nodeId: z.string(), name: z.string() },
  );

  tool(
    "batch_rename_nodes",
    "Batch rename",
    "Bulk rename by find/replace over names. Scope, optional type filter, optional regex. Useful for turning " +
      "`Frame 12` into `Card / 12`. " + PER_ITEM,
    {
      pattern: z.string().describe("Text to find in names (or a regex when `regex: true`)."),
      replace: z.string(),
      scope: z.enum(["page", "selection", "subtree"]).optional().describe("Default \"page\"."),
      nodeId: z.string().optional().describe("Subtree root when scope is \"subtree\"."),
      types: z.array(z.string()).optional().describe("Only these node types, e.g. [\"FRAME\"]."),
      regex: z.boolean().optional().describe("Default false."),
    },
  );

  tool(
    "move_nodes",
    "Move nodes",
    "Move nodes to an absolute position, or by a delta with `relative: true`. Inside an auto-layout the layout owns " +
      "x/y: `positioning: \"absolute\"` takes a child out of the flow so x/y place it — a badge on a card's corner, a close " +
      "button on a modal — while it stays inside the frame (a fill axis becomes fixed first; the item says so). " +
      "`positioning: \"auto\"` puts it back. x and y are written together and read back: an item Figma did not keep is " +
      "ok: false and says where the layer is. Slides and their rows are placed by the deck: figma_move_slides moves them; " +
      "figma_reparent_nodes changes the parent. " + PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      x: z.number().optional(),
      y: z.number().optional(),
      relative: z.boolean().optional().describe("Treat x/y as a delta. Default false (absolute)."),
      positioning: z.enum(["auto", "absolute"]).optional().describe("Children of an auto-layout only: absolute = out of the flow, placed by x/y."),
    },
  );

  tool(
    "resize_nodes",
    "Resize nodes",
    "Resize nodes, or change how they size (Figma's fixed / hug / fill). Give width and/or height; the other dimension " +
      "is kept — a text given only a width wraps and grows downwards. `sizing: { horizontal: \"fill\" }` makes a node take " +
      "its auto-layout parent's width (the fix for text that overflows). min/max limits bound a hug or fill size — a " +
      "fill paragraph with maxWidth 480 stays readable — on auto-layout frames and their direct children; " +
      "`clearLimits` removes them. A node whose size is not its own — a sticky, a table, a connector, a code block, a 1920×1080 " +
      "slide — is refused per item with the tool that sizes it. " + PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      width: z.number().nonnegative().optional(),
      height: z.number().nonnegative().optional(),
      sizing: sizingParam.optional(),
      minWidth: z.number().positive().optional(),
      maxWidth: z.number().positive().optional(),
      minHeight: z.number().positive().optional(),
      maxHeight: z.number().positive().optional(),
      clearLimits: z.array(z.enum(["minWidth", "maxWidth", "minHeight", "maxHeight"])).max(4).optional().describe("Limits to remove."),
    },
  );

  tool(
    "rotate_nodes",
    "Rotate nodes",
    "Set an absolute rotation in degrees, turning about the centre as the editor does (`pivot: \"origin\"` turns about " +
      "the top-left corner, Figma's raw behaviour). Inside an auto-layout the layout re-places the node; the item " +
      "reports pivot \"layout\". The turn is read back: an item Figma did not keep is ok: false with the rotation and " +
      "position it has. figma_move_nodes moves without turning. " + PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      angle: z.number().describe("Degrees, counter-clockwise as in Figma's rotation field (negative turns clockwise). Absolute, not a delta."),
      pivot: z.enum(["center", "origin"]).optional().describe('Default "center".'),
    },
  );

  tool(
    "reorder_nodes",
    "Reorder nodes",
    "Change z-order within each node's current parent. Slides keep their deck order: figma_move_slides reorders them. " + PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      position: positionParam,
    },
  );

  tool(
    "reparent_nodes",
    "Reparent nodes",
    "Move nodes to a new parent (frame, group, component, section, slide or page), optionally at a given index. A node " +
      "keeps its x/y numbers, now relative to the new parent; `keepPosition: true` keeps its place on the canvas instead " +
      "(a sticky dropped into a section), or `x`/`y` place it in the new parent. A moved connector's item carries a " +
      "`warning`: its route may need recreating. Slides move with figma_move_slides. " + PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      parentId: z.string().describe("The new parent."),
      index: z.number().int().nonnegative().optional().describe("Insertion index. Omit to append."),
      x: z.number().optional().describe("In the new parent's coordinates, set after the move. Not with keepPosition."),
      y: z.number().optional(),
      keepPosition: z.boolean().optional().describe("Keep each node's place on the canvas. Default false."),
    },
  );

  tool(
    "clone_node",
    "Clone node",
    "Duplicate a node with its whole subtree, optionally into another parent and at a new position. A slide is " +
      "duplicated into a slide row — right after itself, or at the end of the row `parentId` names — and the result " +
      "gives its `row` and `col`.",
    {
      nodeId: z.string(),
      x: z.number().optional().describe("Not for a slide: the deck's grid places it."),
      y: z.number().optional(),
      parentId: z.string().optional().describe("Default: the source's parent. For a slide, a SLIDE_ROW."),
      name: z.string().optional(),
    },
  );

  tool(
    "delete_nodes",
    "Delete nodes",
    "Delete nodes by id. This is the correct way to undo agent work: pass the ids the create call returned. One Ctrl+Z " +
      "reverts the whole original call. In a deck a slide row that still holds slides is refused (delete its slides " +
      "first); a row its last slide left is reported in `emptiedRows`. " + PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500) },
  );

  tool(
    "group_nodes",
    "Group nodes",
    "Wrap nodes into a GROUP. All nodes must share one parent — Figma enforces this and the error says so when it applies.",
    { nodeIds: z.array(z.string()).min(1).max(200), name: z.string().optional() },
  );

  tool(
    "set_visible",
    "Set visibility",
    "Hide or show nodes. " + PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500), visible: z.boolean() },
  );

  tool(
    "set_locked",
    "Set locked",
    "Lock or unlock nodes. " + PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500), locked: z.boolean() },
  );

  tool(
    "set_opacity",
    "Set opacity",
    "Set opacity, 0–1. " + PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500), opacity: z.number().min(0).max(1) },
  );

  tool(
    "set_auto_layout",
    "Configure auto-layout",
    "Full auto-layout configuration on one node: mode, gap, padding, alignment, wrap, and axis sizing. `mode: \"none\"` " +
      "removes auto-layout. alignX / alignY are screen directions (space-between only along the layout direction; " +
      "baseline only as alignY of a row). `wrap` needs a horizontal layout; a wrapped row spaces its rows by `rowGap` " +
      "(default: the gap) and shares the height by `alignContent`. A negative gap overlaps items (an avatar stack — " +
      "`reverseZIndex` puts the first on top). Every value is checked before the frame changes. Clipping: " +
      "figma_set_clips_content.",
    {
      nodeId: z.string(),
      mode: z.enum(["horizontal", "vertical", "none"]).optional(),
      gap: z.number().optional().describe("Space between items, px; negative overlaps them."),
      padding: paddingParam.optional(),
      alignX: z.enum(["start", "center", "end", "space-between"]).optional(),
      alignY: z.enum(["start", "center", "end", "space-between", "baseline"]).optional(),
      wrap: z.boolean().optional(),
      rowGap: z.number().nonnegative().optional().describe("Space between wrapped rows, px. Needs wrap."),
      alignContent: z.enum(["auto", "space-between"]).optional().describe("How wrapped rows share the height. Needs wrap."),
      primarySizing: z.enum(["fixed", "hug"]).optional(),
      counterSizing: z.enum(["fixed", "hug"]).optional(),
      strokesInLayout: z.boolean().optional().describe("Count the frame's stroke as space, so children sit inside it."),
      reverseZIndex: z.boolean().optional().describe("Draw the first item on top (with a negative gap)."),
    },
  );

  tool(
    "set_clips_content",
    "Set clip content",
    "Turn \"Clip content\" on or off on frames, components and instances: on crops a photo or overflow to the frame's " +
      "(rounded) edge; off stops a frame cutting off a shadow or an overhanging badge — the fix for a check_layout " +
      "`clipped` finding. A section or shape has no clipping and gets ok:false. " + PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500), clipsContent: z.boolean() },
  );

  tool(
    "ungroup_nodes",
    "Ungroup",
    "Unwrap groups: their children move up into the group's parent and the group disappears. Only GROUP nodes — to " +
      "move children out of a frame use figma_reparent_nodes. Each item reports `childIds`. " +
      PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500) },
  );

  tool(
    "boolean_nodes",
    "Boolean operation",
    "Combine shapes into one boolean shape, as Figma's toolbar does: union (merge), subtract (cut the upper shapes out of " +
      "the BOTTOM one), intersect (keep the overlap), exclude (keep what does not overlap). The shapes must share a parent; " +
      "the result takes the lowest one's place and its id is returned. Builds icons, badges, cut-out shapes and logos.",
    {
      nodeIds: z.array(z.string()).min(2).max(200).describe("The shapes, from any layer order — Figma uses their stacking."),
      operation: z.enum(["union", "subtract", "intersect", "exclude"]),
      name: z.string().optional(),
    },
  );

  tool(
    "flatten_nodes",
    "Flatten",
    "Flatten nodes into one editable vector (Ctrl+E) — for a finished icon or a boolean shape that should become a single " +
      "path. They must share a parent. Cannot be undone except with Ctrl+Z.",
    { nodeIds: z.array(z.string()).min(1).max(200), name: z.string().optional() },
  );

  tool(
    "set_mask",
    "Use as mask",
    "Make a shape a mask (or stop it being one). A mask crops the layers ABOVE it in the same parent — put it below the " +
      "image or shapes it should crop, then group them (figma_group_nodes) so the mask stays local. maskType: alpha " +
      "(default), vector (the shape's outline), luminance.",
    {
      nodeId: z.string(),
      isMask: z.boolean().optional().describe("Default true; false turns the mask off."),
      maskType: z.enum(["alpha", "vector", "luminance"]).optional(),
    },
  );

  tool(
    "set_constraints",
    "Set constraints",
    "Responsive constraints: how nodes follow their parent frame when it resizes. horizontal: left, right, center, " +
      "left-right, scale; vertical: top, bottom, center, top-bottom, scale (Figma's MIN/MAX/CENTER/STRETCH/SCALE also " +
      "accepted). Omit one axis to keep it. Children of an auto-layout frame are positioned by the layout instead. " +
      PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      horizontal: z.string().optional(),
      vertical: z.string().optional(),
    },
  );

  tool(
    "swap_component",
    "Swap component",
    "Make an existing instance show a different component (a component set swaps to its default variant, or to the " +
      "`variant` you name), keeping overrides where Figma can. A library component is given by `componentKey` / " +
      "`componentSetKey` and imported first. To switch a variant of the SAME set, figma_set_instance_properties keeps " +
      "the other values; to place a new instance use figma_create_instance.",
    {
      nodeId: z.string().describe("The INSTANCE to swap."),
      componentId: z.string().optional().describe("The COMPONENT or COMPONENT_SET to show instead. Exactly one of componentId, componentKey, componentSetKey."),
      componentKey: z.string().optional().describe("A published library component's key."),
      componentSetKey: z.string().optional().describe("A published library component set's key."),
      variant: z.string().optional().describe('For a set: which variant, e.g. "Size=Large, State=Hover".'),
    },
  );

  tool(
    "detach_instance",
    "Detach instance",
    "Detach instances into plain frames that no longer follow their component. The frame gets a new id, reported per " +
      "item as `frameId`. Cannot be re-attached. " +
      PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500) },
  );

  tool(
    "add_component_property",
    "Add component property",
    "Give a component (or component set) a property that instances can change: TEXT (wire it to text layers with " +
      "`bindNodeIds` — instances then edit the label without detaching), BOOLEAN (show/hide the bound layers), " +
      "INSTANCE_SWAP (swap a nested icon instance; default = a component id), VARIANT (on a set only). Returns the " +
      "property `key` (name + #id) that figma_set_instance_properties accepts — the plain name works too. Called again " +
      "with a name and type that exist, it reuses that property (`reused: true`) and wires the new layers; to rename, " +
      "re-default or unwire use figma_edit_component_property. A slot is figma_create_slot.",
    {
      componentId: z.string().describe("A COMPONENT, or a COMPONENT_SET — not a single variant inside a set."),
      name: z.string().describe('e.g. "Label", "Show icon".'),
      type: z.enum(["TEXT", "BOOLEAN", "INSTANCE_SWAP", "VARIANT"]),
      defaultValue: z.string().describe('Text, "true"/"false" for BOOLEAN, a component id for INSTANCE_SWAP.'),
      bindNodeIds: z.array(z.string()).max(50).optional().describe("Layers inside the component this property drives."),
      preferredValues: z.array(z.string()).max(50).optional().describe("INSTANCE_SWAP only: component or component-set ids offered first in the swap menu."),
    },
  );

  tool(
    "set_instance_properties",
    "Set instance properties",
    "Change an instance's component properties — its label text, a variant (Size, State), a boolean, a swapped icon — " +
      "the way the right panel does, keeping it linked to its component. Names may be given without their #id suffix. " +
      "figma_get_design_context lists an instance's properties; figma_get_component lists every option. A SLOT is not " +
      "set here: create layers inside it (parentId = the slot).",
    {
      nodeId: z.string().describe("The INSTANCE."),
      properties: z.string().describe('JSON object, e.g. {"Label": "Buy now", "Size": "Large", "Show icon": "false"}.'),
    },
  );

  tool(
    "add_variable_mode",
    "Add variable mode",
    "Add a mode (e.g. \"Dark\") to a variable collection; returns its modeId. Modes beyond the first need a paid plan — " +
      "on a Starter file Figma refuses, and its message is returned. Then set values per mode with " +
      "figma_set_variable_value.",
    { collectionId: z.string(), name: z.string() },
  );

  tool(
    "set_variable_value",
    "Set variable value",
    'Set a variable\'s value in one mode. `value` is a string: "#1a2b3c" for COLOR, "16" for FLOAT, text for STRING, ' +
      '"true"/"false" for BOOLEAN, or "alias:color/brand" to point at another variable of the same type. `modeId` ' +
      "takes a mode id or name and defaults to the collection's first mode.",
    {
      variableId: z.string().optional().describe('e.g. "VariableID:1:2".'),
      variableName: z.string().optional().describe('Or its full name, e.g. "color/bg/default".'),
      modeId: z.string().optional(),
      value: variableValueParam,
    },
  );

  tool(
    "delete_variable",
    "Delete variables",
    "Delete variables (design tokens) by id. Nodes bound to one keep its last resolved value. figma_get_variable_defs " +
      "lists ids. " +
      PER_ITEM,
    { variableIds: z.array(z.string()).min(1).max(500).describe('e.g. ["VariableID:1:2"].') },
  );

  tool(
    "delete_variable_collection",
    "Delete variable collection",
    "Delete a variable collection together with every variable in it.",
    { collectionId: z.string() },
  );

  tool(
    "delete_style",
    "Delete styles",
    "Delete local styles (paint, text, effect, grid) by id. Nodes that used one keep the values it gave them. " +
      "figma_get_styles lists ids. " +
      PER_ITEM,
    { styleIds: z.array(z.string()).min(1).max(500) },
  );

  tool(
    "undo_step",
    "Undo (dangerous)",
    "Trigger Figma's undo. WARNING: it returns to the last checkpoint this plugin committed, so changes the user made " +
      "BY HAND since the last tool call are lost too. Prefer figma_delete_nodes with the ids a create call returned — " +
      "that is the safe way to undo agent work. Requires `confirm: true`.",
    {
      confirm: z.boolean().describe("Must be true: you have read the warning."),
      count: z.number().int().min(1).max(20).optional().describe("Undo steps, default 1."),
    },
  );

  void hex; // kept for colour params added with later tools
}
