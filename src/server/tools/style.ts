// The style group on the server side (tools.md § style), Phase 2 subset:
// fills, strokes, corner radius (spec §12). Named styles, variable binding,
// effects, blend modes and reactions arrive with Phase 3.
//
// Schemas stay inside the portable subset (test/schema-portability.test.ts):
// a fill entry is one object with separate optional fields rather than a union
// of "hex string | rgba | gradient | image", because `anyOf` is not portable
// across model providers (params.ts fillEntry). The plugin enforces "exactly
// one form per entry".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { effectEntry, fillEntry, fitDescription, gradientEntry, hexColor } from "./params.js";

const PER_ITEM =
  "Returns per-item results: `{ updated, items: [{ id, ok, error? }] }` — one node failing does not fail the call.";

const nodeIds = z.array(z.string()).min(1).max(500).describe("Nodes to change.");
const unit = z.number().min(0).max(1);
const side = z.number().min(0).optional();

/** @figma/plugin-typings 1.141.0, `type BlendMode`. */
const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
] as const;

export function registerStyle(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  const tool = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) =>
        forwardTool(bridge, op, args, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        }),
    );
  };

  tool(
    "set_fills",
    "Set fills",
    "Replace the fill paints of nodes: solid colours, gradients, images, several stacked fills (bottom first — " +
      "`[{ image }, { gradient }]` is a photo under a scrim on one node). A gradient is linear, radial, angular or " +
      "diamond; a linear one takes a CSS `angle` (90 = left → right, the default; 180 = top → bottom), fitted to each " +
      "node's own size; radial and diamond take `center` / `radius`, angular takes `center` only. An `image` entry " +
      "reuses an image already in the file by the `imageHash` figma_import_image returns; to bring a new picture in use " +
      "figma_import_image. An empty `fills` removes every fill. Every entry is validated before any node changes. This " +
      "sets raw paints — to apply a named local style use figma_apply_style_to_node; for outlines use figma_set_strokes. " +
      PER_ITEM,
    {
      nodeIds,
      fills: z.array(fillEntry).max(16).describe("Bottom to top, as in Figma's fill list."),
      opacity: unit.optional().describe("Default opacity for entries that do not set their own."),
    },
  );

  tool(
    "set_strokes",
    "Set strokes",
    "Set the outline (stroke) of nodes: exactly one of a solid `color`, a `gradient` (as in figma_set_fills), or " +
      "`remove: true` to take it off; plus weight, alignment, dashes, line ends (`cap`) and corners (`join`). " +
      "`sides` sets per-side weights on frames, rectangles, components and instances: a side left out is 0 — so " +
      "`{ sides: { bottom: 1 } }` is a bottom border — unless `weight` is given, which then fills it. This is the " +
      "border — for the inside colour use figma_set_fills. " +
      PER_ITEM,
    {
      nodeIds,
      color: hexColor.optional().describe("Stroke colour, #rgb / #rrggbb / #rrggbbaa."),
      gradient: gradientEntry.optional().describe("A gradient stroke instead of `color`."),
      remove: z.boolean().optional().describe("Remove every stroke instead; give nothing else with it."),
      weight: z.number().min(0).optional().describe("Stroke weight in px."),
      sides: z
        .object({ top: side, right: side, bottom: side, left: side })
        .strict()
        .optional()
        .describe("Per-side weights in px — a bottom border, a table-row divider, an input underline."),
      align: z.enum(["INSIDE", "CENTER", "OUTSIDE"]).optional(),
      dashPattern: z.array(z.number().min(0)).max(8).optional().describe("Dash and gap lengths in px, e.g. [4, 2]."),
      cap: z
        .enum(["none", "round", "square", "arrow", "arrow-filled", "triangle", "circle", "diamond"])
        .optional()
        .describe("End decoration of open paths and lines, as in figma_create_line."),
      join: z.enum(["miter", "bevel", "round"]).optional().describe("How corners of the path are joined."),
    },
  );

  tool(
    "set_corner_radius",
    "Set corner radius",
    "Round the corners of nodes: one `radius` for all corners, or `radii` [topLeft, topRight, bottomRight, " +
      "bottomLeft] per corner (frames and rectangles); `smoothing` 0–1 makes them continuous like iOS (0.6 is the " +
      "iOS squircle) and can be set alone. " +
      PER_ITEM,
    {
      nodeIds,
      radius: z.number().min(0).optional().describe("Same radius for every corner."),
      radii: z.array(z.number().min(0)).min(4).max(4).optional().describe("[topLeft, topRight, bottomRight, bottomLeft]."),
      smoothing: unit.optional().describe("Corner smoothing 0–1 (0 = circular arcs)."),
    },
  );

  tool(
    "set_effects",
    "Set effects",
    "Replace the effects of nodes: drop shadow, inner shadow, layer blur, background blur (either blur can ramp " +
      "with `progressive`), noise, texture and glass. An empty `effects` array removes them all. Every entry is " +
      "validated before any node changes, and a field of another effect type is refused. To apply a named effect " +
      "style use figma_apply_style_to_node. " +
      PER_ITEM,
    {
      nodeIds,
      effects: z.array(effectEntry).max(16).describe("Effects in Figma's order."),
    },
  );

  tool(
    "set_blend_mode",
    "Set blend mode",
    "Set how nodes blend with what is beneath them (MULTIPLY, SCREEN, OVERLAY, …). PASS_THROUGH applies to frames and " +
      "groups. For transparency use figma_set_opacity. " +
      PER_ITEM,
    {
      nodeIds,
      blendMode: z.enum(BLEND_MODES),
    },
  );

  tool(
    "set_layout_grids",
    "Set layout grids",
    "Replace the layout grids of frames — the column grid a page is designed on (e.g. 12 columns, 24 gutter, 80 " +
      "margin), rows, or a square grid. Visible only in the editor, never in exports. An empty `grids` removes them. " +
      PER_ITEM,
    {
      nodeIds,
      grids: z
        .array(
          z.object({
            pattern: z.enum(["columns", "rows", "grid"]),
            count: z.number().int().min(1).optional().describe("Columns or rows (columns/rows)."),
            gutter: z.number().min(0).optional().describe("px between columns/rows, default 20."),
            margin: z.number().min(0).optional().describe("px from the frame edge (stretch / start / end)."),
            alignment: z.enum(["stretch", "center", "start", "end"]).optional().describe("Default stretch."),
            sectionSize: z.number().positive().optional().describe("Column/row width (not stretch), or the cell size (grid)."),
            color: hexColor.optional().describe("#rrggbbaa; default alpha 10%."),
            visible: z.boolean().optional(),
          }).strict(),
        )
        .max(16),
    },
  );

  tool(
    "apply_style_to_node",
    "Apply style",
    "Apply a local style (paint, text, effect or grid) by id or by name — the node then follows the style. Give " +
      "`type` when a name is shared across kinds, or to apply a paint style as the stroke (default: fill). " +
      "figma_get_styles lists local styles; a style from a library (not listed there) is applied by the `id` that " +
        "figma_get_design_context returns in `stylesUsed`. For a raw colour use figma_set_fills. " +
      PER_ITEM,
    {
      nodeIds,
      styleId: z.string().optional().describe("A style id from figma_get_styles."),
      styleName: z.string().optional().describe('Or its exact name, e.g. "Brand/Primary".'),
      type: z.enum(["fill", "stroke", "text", "effect", "grid"]).optional(),
    },
  );

  tool(
    "bind_variable_to_node",
    "Bind variable",
    "Bind a variable (design token) to a property of nodes so it follows the variable. `field`: fill, " +
      "stroke (COLOR; `index` picks the paint, which must be SOLID — a gradient or image is refused, not replaced), " +
      "radius, gap, padding (all four sides), width, height, opacity, visible; \"effect.color\" / \"effect.radius\" / " +
      "\"effect.spread\" / \"effect.offsetX\" / \"effect.offsetY\" and \"grid.count\" / \"grid.gutterSize\" / \"grid.offset\" / " +
      "\"grid.sectionSize\" with `index` for the effect or grid; on text, the text fields (fontSize, lineHeight, " +
      "letterSpacing, fontFamily, fontStyle, fontWeight) go to Figma as is, a refusal coming back per item; or " +
      "any Figma bindable field (paddingLeft, topLeftRadius, characters). " +
      "Library variables bind by the id figma_get_variable_defs { nodeId } reports; a token inside a style: " +
      "figma_update_style. " +
      PER_ITEM,
    {
      nodeIds,
      field: z.string().describe('e.g. "fill", "radius", "gap", "padding", "effect.color", "fontSize".'),
      variableId: z.string().optional().describe('e.g. "VariableID:1:2".'),
      variableName: z.string().optional().describe('Or its full name, e.g. "color/bg/default".'),
      index: z.number().int().min(0).optional().describe("Which paint, effect or grid (0 = the first, the default)."),
    },
  );

  tool(
    "set_reactions",
    "Set prototype reactions",
    "Replace a node's prototype interactions. `reactions` is a JSON array. Shorthand per entry: " +
      '{ "trigger": "ON_CLICK", "action": { "type": "NODE", "destinationId": "12:3", "transition": "SMART_ANIMATE", ' +
      '"duration": 0.3 } } — duration in seconds; navigation defaults to NAVIGATE. Figma\'s full Reaction shape (what ' +
      "figma_get_reactions returns) is accepted as is. Other actions: BACK, CLOSE, URL ({ type, url }).",
    {
      nodeId: z.string(),
      reactions: z.string().describe("JSON array of reactions; [] removes all."),
    },
  );

  tool(
    "remove_reactions",
    "Remove prototype reactions",
    "Remove every prototype interaction from a node.",
    { nodeId: z.string() },
  );
}

// Paint styles take the same entries as figma_set_fills (tools/tokens.ts), so
// a gradient a node can have, a style can have too.
export { fillEntry };
