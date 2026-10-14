// Design tokens on the server side: batched variables with scopes and code
// syntax, collection and mode edits, a mode shown on a frame, style updates in
// place, grid styles and the library variables a plugin can list.
//
// Every shape stays inside the portable subset (test/schema-portability.test.ts):
// a variable's values are an array of { mode, value } rather than a record,
// code syntax is an object with three declared properties, and every union
// travels as one string the plugin parses.
//
// The shared field shapes are FUNCTIONS, not constants: create.ts imports them
// and this file imports create.ts and style.ts, so a constant built at import
// time could meet a binding that the import cycle has not initialised yet.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { effectEntry, fitDescription, hexColor, weightParam } from "./params.js";
import { fillEntry } from "./style.js";

const SESSION = {
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const PER_ITEM = "Returns per-item results: `items: [{ id, ok, error? }]` — one item failing does not fail the call.";

/** @figma/plugin-typings 1.141.0, `type VariableScope`. */
export const VARIABLE_SCOPES = [
  "ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL",
  "STROKE_COLOR", "STROKE_FLOAT", "EFFECT_FLOAT", "EFFECT_COLOR", "OPACITY", "COLOR_OPACITY", "FONT_FAMILY", "FONT_STYLE",
  "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT",
] as const;

const VARIABLE_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const;

/** Scopes, code syntax, description and publishing — the properties a token carries besides its value. */
export function variablePropsShape(): z.ZodRawShape {
  return {
    scopes: z
      .array(z.enum(VARIABLE_SCOPES))
      .max(VARIABLE_SCOPES.length)
      .optional()
      .describe(
        "Which property pickers offer it. [] hides a primitive that is only aliased; semantic tokens name their fields, e.g. " +
          '["FRAME_FILL","SHAPE_FILL"] or ["GAP"]. Checked against the type; ALL_SCOPES stands alone. Default (omitted): Figma\'s ALL_SCOPES.',
      ),
    // Strict: zod's default strips an unknown key, so { web: … } or { CSS: … }
    // reached the plugin as {} and the call answered ok having set nothing.
    codeSyntax: z
      .object({ WEB: z.string().optional(), ANDROID: z.string().optional(), iOS: z.string().optional() })
      .strict()
      .optional()
      .describe('The name in code per platform, e.g. { "WEB": "var(--color-bg-brand)" }. "" removes that platform.'),
    description: z.string().max(2000).optional(),
    hiddenFromPublishing: z.boolean().optional().describe("Hide it when the file is published as a library."),
  };
}

/** TEXT style fields other than the size, in the figma_set_text_properties string grammar. */
export function textStyleShape(): z.ZodRawShape {
  return {
    fontFamily: z.string().optional().describe("Default Inter (create); the style's own family (update)."),
    weight: weightParam.optional(),
    lineHeight: z.string().optional().describe('"auto", px ("32") or percent ("150%"). A string, not a number.'),
    letterSpacing: z.string().optional().describe('px ("0.5") or percent ("-2%"). A string, not a number.'),
    case: z.enum(["original", "upper", "lower", "title", "small-caps"]).optional(),
    decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
    paragraphSpacing: z.number().min(0).optional().describe("px between paragraphs."),
    paragraphIndent: z.number().min(0).optional().describe("px of first-line indent."),
  };
}

/** PAINT style fields: one hex `color`, or `fills` as in figma_set_fills. */
export function paintStyleShape(): z.ZodRawShape {
  return {
    color: hexColor.optional().describe("A solid colour. Give this or `fills`."),
    opacity: z.number().min(0).max(1).optional(),
    fills: z.array(fillEntry).min(1).max(16).optional().describe("Several paints or a gradient, entries as in figma_set_fills."),
  };
}

/**
 * One layout grid — the entry figma_set_layout_grids takes (the plugin parses both with one function).
 * Strict, like every nested object here: zod's default strips an unknown key before the plugin sees it (params.ts).
 */
function gridEntry() {
  return z
    .object({
      pattern: z.enum(["columns", "rows", "grid"]),
      count: z.number().int().min(1).optional().describe("Columns or rows (columns/rows)."),
      gutter: z.number().min(0).optional().describe("px between columns/rows, default 20."),
      margin: z.number().min(0).optional().describe("px from the frame edge (stretch / start / end)."),
      alignment: z.enum(["stretch", "center", "start", "end"]).optional().describe("Default stretch."),
      sectionSize: z.number().positive().optional().describe("Column/row width (not stretch), or the cell size (grid)."),
      color: hexColor.optional().describe("#rrggbbaa; default alpha 10%."),
      visible: z.boolean().optional(),
    })
    .strict();
}

export const styleDescription = () => z.string().max(2000).optional().describe("What the style is for — shown in Figma's style picker.");

export function registerTokens(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  const write = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
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
  // A read carries no idempotencyKey: there is no side effect to deduplicate.
  const read = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...SESSION }, annotations: readAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) => forwardTool(bridge, op, args, extra, { session: args.session as string | undefined }),
    );
  };

  read(
    "get_library_variables",
    "List library variables",
    "Variables from the team libraries enabled in this file — the part of a library a plugin can list (its components and " +
      "styles it cannot). Without `collectionKey`: the enabled libraries' variable collections { key, name, libraryName }. " +
      "With one: that collection's variables { key, name, resolvedType }, filtered by `query` (name substring) and `type`, " +
      "paginated. Import a variable by its key before binding it. Local variables: figma_get_variable_defs. UNSUPPORTED " +
      "means the plugin lacks the teamlibrary permission or no library is enabled (Assets → Libraries). Reads only.",
    {
      collectionKey: z.string().optional().describe("A collection key from a call without it."),
      query: z.string().optional().describe("Name substring, case-insensitive (collections: name or library name)."),
      type: z.enum(VARIABLE_TYPES).optional(),
      limit: z.number().int().min(1).max(1000).optional().describe("Max variables. Default 200."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  write(
    "create_variables",
    "Create variables",
    "A token set in ONE call (one undo step): primitives first, then semantic tokens that alias them, each with a value per " +
      'mode, scopes and code syntax. Values are strings: "#1a2b3c" / "#1a2b3c80", "16", text, "true", or "alias:<name or ' +
      'id>" — the target must exist already or come EARLIER in this call, with the same type. Everything is checked before ' +
      "the first variable exists, so a refusal creates nothing. `ifExists` decides what a name the collection already has " +
      'does: "error" (default), "skip" (keep it; aliases resolve to it), or "update" (set the given values and properties). ' +
      "Up to 200 per call, paced so Figma stays responsive. For one variable figma_create_variable is enough; to change " +
      "properties later use figma_set_variable_properties.",
    {
      collectionId: z.string().describe("The collection, from figma_get_variable_defs or figma_create_variable_collection."),
      ifExists: z.enum(["error", "skip", "update"]).optional().describe('Default "error".'),
      variables: z
        .array(
          z
            .object({
              name: z.string().min(1).describe('Slash-grouped, e.g. "color/bg/brand". Figma allows no `.`, `{` or `}`: "spacing/0_5", not "spacing/0.5".'),
              type: z.enum(VARIABLE_TYPES),
              values: z
                .array(
                  z
                    .object({ mode: z.string().describe("Mode name or id."), value: z.string().describe('"#1a2b3c", "16", text, "true", or "alias:<name or id>".') })
                    .strict(),
                )
                .min(1)
                .max(40),
              ...variablePropsShape(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    },
  );

  write(
    "create_grid_style",
    "Create grid style",
    "A local GRID style — a named layout grid (e.g. 12 columns, 24 gutter, 64 margin) that frames follow via " +
      "figma_apply_style_to_node { type: \"grid\" }. Entries as in figma_set_layout_grids, which sets raw grids on frames instead.",
    {
      name: z.string(),
      grids: z.array(gridEntry()).min(1).max(16),
      description: styleDescription(),
    },
  );

  write(
    "set_variable_properties",
    "Set variable properties",
    "Change what a token carries besides its value: `name` (one variable only), `scopes`, `codeSyntax` (\"\" removes a " +
      "platform), `description`, `hiddenFromPublishing` — on many variables at once, by id or exact name. Scopes are checked " +
      "against each variable's own type. Values per mode: figma_set_variable_value. " +
      PER_ITEM,
    {
      variableIds: z.array(z.string()).min(1).max(500).optional().describe("Give this or `variableNames`."),
      variableNames: z.array(z.string()).min(1).max(500).optional().describe('Exact full names, e.g. "color/bg/brand".'),
      name: z.string().optional().describe("Rename — only when one variable is targeted."),
      ...variablePropsShape(),
    },
  );

  write(
    "update_variable_collection",
    "Update variable collection",
    "Rename a variable collection, hide it from publishing, rename its modes (e.g. \"Mode 1\" → \"Light\"), or remove modes. " +
      "Removing a mode deletes the value every variable holds for it — the result counts them per mode; the last mode is " +
      "never removed. Everything is checked before anything changes. To add a mode use figma_add_variable_mode (paid plans).",
    {
      collectionId: z.string(),
      name: z.string().optional(),
      hiddenFromPublishing: z.boolean().optional(),
      renameModes: z
        .array(z.object({ mode: z.string().describe("Mode name or id."), name: z.string().describe("At most 40 characters.") }).strict())
        .max(40)
        .optional(),
      removeModes: z.array(z.string()).max(40).optional().describe("Mode names or ids."),
    },
  );

  write(
    "set_variable_mode",
    "Set variable mode",
    "Show nodes in a chosen mode of a collection — Dark on this screen, Light on that one: frames, components, sections " +
      "and pages pin a mode, and everything inside follows. Without it every node uses the collection's default mode, so a " +
      "Dark mode can be created and valued and still never be seen. `clear: true` removes the pin (the node inherits " +
      "again). The collection by id or name, the mode by name or id. " +
      PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      collectionId: z.string().optional(),
      collectionName: z.string().optional().describe("Or the collection's exact name."),
      mode: z.string().optional().describe('Mode name or id, e.g. "Dark". Give this or `clear`.'),
      clear: z.boolean().optional().describe("Remove the pinned mode instead."),
    },
  );

  write(
    "update_style",
    "Update style",
    "Change a local style IN PLACE — every node using it follows; deleting and recreating would detach them all. By " +
      "`styleId` or `styleName` (+ `type` when a name is shared). Any kind: `name`, `description`. Paint: `color` or " +
      "`fills`, with `opacity`; `opacity` alone fades every paint and keeps bound colours. A gradient style's `angle` is " +
      "exact only on a square node — a style has no size; for an exact CSS angle on a known node use figma_set_fills, or " +
      "give `transform`. Text: font, size, line height, " +
      "letter spacing, case, decoration, paragraph spacing/indent. " +
      "Effect: `effects`. Grid: `grids`. `variables` binds tokens inside the style: text fields by name (fontSize, " +
      "fontFamily…), a paint's \"color\", \"effect.color\" / \"effect.radius\" …, \"grid.count\" …, with `index` for the " +
      "entry. A field that does not fit the style's kind, and a library style, are refused before anything changes.",
    {
      styleId: z.string().optional().describe("A style id from figma_get_styles."),
      styleName: z.string().optional().describe('Or its exact name, e.g. "Heading/H1".'),
      type: z.enum(["fill", "stroke", "text", "effect", "grid"]).optional().describe("Only to tell same-named styles apart."),
      name: z.string().optional().describe("Rename the style."),
      description: styleDescription(),
      ...paintStyleShape(),
      fontSize: z.number().positive().optional(),
      ...textStyleShape(),
      effects: z.array(effectEntry).min(1).max(16).optional().describe("Replaces the effects; entries as in figma_set_effects."),
      grids: z.array(gridEntry()).min(1).max(16).optional().describe("Replaces the grids; entries as in figma_set_layout_grids."),
      variables: z
        .array(
          z
            .object({
              field: z.string().describe('"fontSize", "color", "effect.radius", "grid.count", …'),
              variableId: z.string().optional(),
              variableName: z.string().optional(),
              index: z.number().int().min(0).optional().describe("Which paint, effect or grid. Default 0."),
            })
            .strict(),
        )
        .max(32)
        .optional(),
    },
  );
}
