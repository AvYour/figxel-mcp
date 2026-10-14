// The create group on the server side (tools.md § create).
//
// Every tool here carries `idempotencyKey?`, and the descriptions say when to
// supply one. That is not decoration: if the *client* times out, the agent never
// receives the bridge-generated key, so only a key the agent chose can be used
// to retry without risking a second copy of the work (protocol.md §3).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  effectEntry,
  fitDescription,
  hexColor,
  paddingParam,
  sizingParam,
  textLengthParam,
  textLengthsForPlugin,
  variableValueParam,
  weightParam,
} from "./params.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../results.js";
import { forwardTool, type Extra } from "./forward.js";
import { writeAnnotations } from "./annotations.js";
import { paintStyleShape, styleDescription, textStyleShape, variablePropsShape } from "./tokens.js";

/** Shared params for every write tool: session picker + caller-owned retry key. */
export const WRITE_PARAMS = {
  session: z
    .string()
    .optional()
    .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
  idempotencyKey: z
    .string()
    .max(128)
    .optional()
    .describe(
      "Caller-owned retry key, ≤128 chars. Re-calling with the same key never executes twice: it returns the existing " +
        "result, or waits for the op still in flight. Supply your own for anything large — if the MCP client times out " +
        "(rather than the bridge), only a key you chose can be used to retry safely.",
    ),
};

const hex = hexColor;

// The spec shape, as JSON. Kept as a loose record rather than a deep zod schema
// deliberately: the plugin validates it node by node and reports the exact path
// that failed (`spec.children[2].width`), which a zod failure at the top level
// cannot do as precisely. The description carries the grammar.
const SPEC_DESCRIPTION = fitDescription(
  "Build a whole SECTION in one call (one undo step): a header, hero, card, grid of cards or footer — frames with " +
    "auto-layout, text, shapes (rectangle, ellipse, polygon, star, line, vector path), SVG icons, images by URL, " +
    "components and instances. To build anything new: a wrapper frame, then one call per section into " +
    "it by parentId; after each, figma_check_layout and one figma_export_node, then targeted fixes. Not a whole " +
    "page in one payload: a section at a time keeps every step checkable. " +
    "The full spec grammar: figma_get_guide { topic: \"spec\" }. Minimal shape: " +
    "{ \"type\": \"frame\", \"name\": \"Card\", \"layout\": \"vertical\", \"gap\": 16, \"padding\": 24, \"children\": [ " +
    "{ \"type\": \"text\", \"content\": \"Title\", \"fontSize\": 20 } ] }. A field a type does not take is refused, " +
    "never dropped. A mid-way failure does not roll back: `created[]` and `failedAt` say what exists. Supply your own " +
    "idempotencyKey for a large spec. An array of roots (a slide's content) needs parentId or pageId.",
);

/** At most this many roots in an array spec: one slide or one board zone per call [C-082] [C-155]. */
const MAX_SPEC_ROOTS = 50;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `spec` travels as a JSON string — a recursive object schema is not portable
 * across providers — but the plugin builds from an object. Parse it here, so a
 * malformed spec is answered precisely without a round-trip to Figma. An array
 * is several roots into one parent (the plugin requires parentId or pageId for it).
 */
export function parseSpecParam(raw: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  let spec = raw;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch (e) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`spec\` is not valid JSON: ${(e as Error).message}`, {
        hint: "Pass the node tree as a JSON object serialised to a string, e.g. {\"type\":\"frame\",\"children\":[…]}.",
      });
    }
  }
  if (Array.isArray(spec)) {
    if (spec.length < 1 || spec.length > MAX_SPEC_ROOTS) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`spec\` as an array takes 1–${MAX_SPEC_ROOTS} roots (got ${spec.length}).`);
    }
    const bad = spec.findIndex((r) => !isObject(r));
    if (bad >= 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`spec[${bad}]\` must be a JSON object describing a root node.`);
    return spec as Array<Record<string, unknown>>;
  }
  if (!isObject(spec)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`spec` must be a JSON object describing the root node (see the tool description for its shape).");
  }
  return spec;
}

export function registerCreate(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  const tool = (
    op: string,
    title: string,
    description: string,
    shape: z.ZodRawShape,
    prepare?: (args: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) => {
        let params = args;
        try {
          if (prepare) params = prepare(args);
        } catch (err) {
          // Refused before the bridge was asked: nothing changed, a retry is safe [C-096].
          return errorResult(
            err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err,
            { unchanged: true },
          );
        }
        return forwardTool(bridge, op, params, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        });
      },
    );
  };

  tool(
    "create_from_spec",
    "Create from spec",
    SPEC_DESCRIPTION,
    {
      spec: z
      .string()
      .describe("The node tree to build, as a JSON object serialised to a string (the tool description gives its grammar), or a JSON array of 1–50 such roots when parentId or pageId is given. Serialising it keeps the schema portable across providers — see docs/reference/tools.md."),
      parentId: z.string().optional().describe("Where to attach it: a frame, section, slide or page. Defaults to the current page (in Slides: the focused slide)."),
      pageId: z.string().optional().describe("The page to build on, at its top level, when no parentId is given. Not with parentId."),
    },
    (args) => {
      const spec = parseSpecParam(args.spec);
      if (Array.isArray(spec) && args.parentId === undefined && args.pageId === undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "An array of roots needs `parentId` or `pageId`: say where they all go.");
      }
      return { ...args, spec };
    },
  );

  tool(
    "create_frame",
    "Create frame",
    "A frame — the building block for structure. Build designs step by step: one frame per section, row or card, " +
      "each with auto-layout (`layout`, `gap`, `padding`, `alignX`/`alignY`), then add content into it by `parentId`. " +
      "An auto-layout frame hugs its content on any axis you give no size for; `sizing: { horizontal: \"fill\" }` makes it " +
      "take its parent column's width. A wrapping row (`wrap`) spaces its rows by `rowGap` (default: the gap). Content " +
      "is not clipped unless `clipsContent: true`. Name it for what it is.",
    {
      name: z.string().optional().describe('What it is, e.g. "Header", "Pricing card".'),
      width: z.number().positive().optional().describe("Fixes the width. Omit to hug (auto-layout) — a plain frame defaults to 100."),
      height: z.number().positive().optional().describe("Fixes the height. Omit to hug (auto-layout)."),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional().describe("Defaults to the current page (in Slides: the focused slide)."),
      layout: z.enum(["horizontal", "vertical", "none"]).optional().describe("Auto-layout direction: horizontal = a row, vertical = a column."),
      gap: z.number().nonnegative().optional().describe("Space between items, px."),
      padding: paddingParam.optional(),
      alignX: z.enum(["start", "center", "end", "space-between"]).optional().describe("Horizontal alignment of the items."),
      alignY: z.enum(["start", "center", "end", "space-between", "baseline"]).optional().describe("Vertical alignment of the items. baseline (a row only) lines up text baselines, e.g. \"$29 /mo\"."),
      wrap: z.boolean().optional().describe("Wrap items onto new lines (horizontal layout only)."),
      rowGap: z.number().nonnegative().optional().describe("Space between wrapped rows, px. Needs wrap; default the gap."),
      alignContent: z.enum(["auto", "space-between"]).optional().describe("How wrapped rows share the height. Needs wrap."),
      sizing: sizingParam.optional(),
      background: hex.optional().describe("Omitted: transparent inside another frame, white directly on the page."),
      cornerRadius: z.number().nonnegative().optional(),
      clipsContent: z.boolean().optional().describe("Clip children at the frame edge. Default false (shadows stay visible)."),
    },
  );

  tool(
    "create_text",
    "Create text",
    "A text node, placed into a frame by `parentId`. Inside a vertical auto-layout it fills the column and wraps " +
      "(and follows the column's centre/right alignment unless `align` is given); elsewhere give `width` for text that " +
      "should wrap — text without one stays on a single line and can overflow. The font is loaded with the documented " +
      "fallback chain; the result names the font used and flags `fellBack: true` when it is not the one requested.",
    {
      content: z.string().describe("The text. Newlines are allowed."),
      name: z.string().optional().describe('Layer name, e.g. "Title". Default: the text itself.'),
      width: z.number().positive().optional().describe("Fixed width in px; the text wraps inside it."),
      sizing: sizingParam.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional().describe("Defaults to the current page (in Slides: the focused slide)."),
      fontFamily: z.string().optional().describe("Default Inter."),
      fontSize: z.number().positive().optional(),
      weight: weightParam.optional().describe("Default Regular (in FigJam: Medium, the board's own default)."),
      color: hex.optional().describe("Default #000000 (in FigJam: #1E1E1E, the board's own text colour)."),
      align: z.enum(["left", "center", "right", "justified"]).optional(),
      lineHeight: textLengthParam.optional().describe('"auto", px ("24" or "24px") or percent ("150%"), as in figma_set_text_properties; above 0. A unitless value is px, never a multiplier.'),
      letterSpacing: textLengthParam.optional().describe('px ("0.5") or percent ("-1%"), as in figma_set_text_properties. A unitless value is px.'),
    },
    // A px value goes on as a number, which a plugin older than the string grammar still applies.
    (args) => textLengthsForPlugin(args, ["lineHeight", "letterSpacing"]),
  );

  tool(
    "create_rectangle",
    "Create rectangle",
    "A rectangle with an optional fill, corner radius and stroke.",
    {
      width: z.number().positive(),
      height: z.number().positive(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      fill: hex.optional(),
      cornerRadius: z.number().nonnegative().optional(),
      stroke: hex.optional(),
      strokeWeight: z.number().nonnegative().optional().describe("Default 1 when a stroke is given."),
      name: z.string().optional(),
      sizing: sizingParam.optional(),
    },
  );

  tool(
    "create_ellipse",
    "Create ellipse",
    "An ellipse with an optional fill.",
    {
      width: z.number().positive(),
      height: z.number().positive(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      fill: hex.optional(),
      name: z.string().optional(),
      sizing: sizingParam.optional(),
    },
  );

  tool(
    "create_line",
    "Create line",
    "A straight line: dividers, connectors, arrows, underlines, decorative strokes. `length` in px from (x, y), turned " +
      "by `angle` degrees (0 = to the right, 90 = up). `cap` decorates both ends: arrow, arrow-filled, triangle, circle, " +
      "diamond, round, square. For a divider inside an auto-layout, a 1 px figma_create_rectangle with `sizing: { " +
      "horizontal: \"fill\" }` stretches with the column; a line keeps its length.",
    {
      length: z.number().positive(),
      angle: z.number().optional().describe("Degrees, default 0."),
      color: hex.optional().describe("Default #000000."),
      weight: z.number().positive().optional().describe("Stroke weight in px, default 1."),
      cap: z.enum(["none", "round", "square", "arrow", "arrow-filled", "triangle", "circle", "diamond"]).optional(),
      dashPattern: z.array(z.number().min(0)).max(8).optional().describe("Dash and gap lengths, e.g. [4, 4]."),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      name: z.string().optional(),
    },
  );

  const shapeParams = {
    width: z.number().positive(),
    height: z.number().positive(),
    fill: hex.optional(),
    stroke: hex.optional(),
    strokeWeight: z.number().nonnegative().optional().describe("Default 1 when a stroke is given."),
    cornerRadius: z.number().nonnegative().optional().describe("Rounds the outer corners."),
    x: z.number().optional(),
    y: z.number().optional(),
    parentId: z.string().optional(),
    name: z.string().optional(),
    sizing: sizingParam.optional(),
  };

  tool(
    "create_polygon",
    "Create polygon",
    "A regular polygon — triangle (pointCount 3), diamond (4, rotated 45 with figma_rotate_nodes), pentagon, hexagon… " +
      "Badges, play buttons, decorative geometry.",
    { ...shapeParams, pointCount: z.number().int().min(3).max(60).optional().describe("Sides, default 3.") },
  );

  tool(
    "create_star",
    "Create star",
    "A star or burst: `pointCount` spikes, `innerRadius` 0–1 (low = spiky, near 1 = almost a polygon). Rating stars, " +
      "sale bursts, sparkles, decorative shapes.",
    {
      ...shapeParams,
      pointCount: z.number().int().min(3).max(60).optional().describe("Spikes, default 5."),
      innerRadius: z.number().min(0).max(1).optional().describe("Default Figma's 0.38."),
    },
  );

  tool(
    "create_vector",
    "Create vector",
    "Draw any shape from SVG path data — a blob, a wave divider, a custom arrow, a logo mark, a chart line. `path` is " +
      "the `d` of an SVG <path> (M L H V C S Q T A Z, absolute or relative). `width`/`height` scale it (one keeps its " +
      "proportions). Give `stroke` without `fill` for an open line. For a whole SVG file (an icon) use figma_import_svg.",
    {
      path: z.string().min(1).max(200_000).describe('e.g. "M0 40 C 60 0, 120 80, 180 40 L180 80 L0 80 Z".'),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fill: hex.optional(),
      stroke: hex.optional(),
      strokeWeight: z.number().nonnegative().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      name: z.string().optional(),
      sizing: sizingParam.optional(),
    },
  );

  tool(
    "create_section",
    "Create section",
    "A section — the container designers use to organise a page by flow, and on a FigJam board the structure itself: " +
      "a white wrapper, zones inside it, cards inside those (`parentId` = another section). `name: \"\"` leaves it " +
      "untitled when a title text inside carries the label. To fill a section and fit it to its content in one call, " +
      "use figma_create_from_spec with a section's `arrange` and `hug`.",
    {
      name: z.string().optional().describe('Short and navigational, e.g. "Brainstorm"; "" for none.'),
      parentId: z.string().optional().describe("A page or a section. Defaults to the current page."),
      x: z.number().optional().describe("In the parent's coordinates."),
      y: z.number().optional(),
      width: z.number().positive().optional().describe("Default 800."),
      height: z.number().positive().optional().describe("Default 600."),
      fill: hex.optional().describe("Background colour, e.g. #F5FBFF."),
      contentsHidden: z.boolean().optional().describe("Hide what is inside, as FigJam's Hide contents. Default false."),
    },
  );

  tool(
    "create_page",
    "Create page",
    "A new page. Note: a free Starter file is capped at 3 pages and Figma's own error is surfaced as-is when the cap is " +
      "hit — that is a plan limit, not a bridge limit.",
    {
      name: z.string(),
      activate: z.boolean().optional().describe("Switch to the new page. Default false."),
    },
  );

  tool(
    "convert_to_component",
    "Convert to component",
    "Turn an existing node (usually a frame) into a reusable COMPONENT, keeping its properties and children — the " +
      "toolbar's Create component. The result has its own id (returned). A node that is already a component, or sits " +
      "inside a component or instance, cannot be converted. To place copies afterwards use figma_create_instance.",
    {
      nodeId: z.string().describe("The node to convert."),
      name: z.string().optional().describe("Component name. Defaults to the node's name."),
      description: z.string().optional().describe("What the component is for — shown in the assets panel and Dev Mode."),
    },
  );

  tool(
    "combine_as_variants",
    "Combine as variants",
    "Combine components into one component set (variants), like Figma's Combine as variants. Name each component " +
      "\"Property=Value, Other=Value\" first (figma_rename_node) — Figma derives the variant properties from those " +
      "names. The components must share a parent; the set is laid out as a wrapping row unless `arrange: false`. " +
      "`columns: \"State\"` lays it out as a grid instead — a column per State value, a row per combination of the " +
      "other properties — and returns the grid's page coordinates, for header labels made with figma_create_text " +
      "outside the set. Then place variants with figma_create_instance and switch them with figma_set_instance_properties.",
    {
      componentIds: z.array(z.string()).min(1).max(200),
      name: z.string().optional().describe('The set\'s name, e.g. "Button".'),
      arrange: z.boolean().optional().describe("Lay the variants out in a wrapping row. Default true."),
      columns: z.string().optional().describe('A variant property every component names, e.g. "State": one grid column per value.'),
      gap: z.number().nonnegative().optional().describe("Space between variants, px. Default 24."),
      description: z.string().optional().describe("What the set is for — shown in the assets panel and Dev Mode."),
    },
  );

  tool(
    "create_instance",
    "Create instance",
    "Place an instance of a component, of a component set's default variant, or of the `variant` of a set you name. " +
      "Local ids come from figma_get_local_components. A library component is placed by `componentKey` or " +
      "`componentSetKey`: imported first, then placed (figma_import_library_assets imports several at once). Give " +
      "exactly one of componentId, componentKey, componentSetKey. To change which component an existing instance " +
      "shows, use figma_swap_component.",
    {
      componentId: z.string().optional().describe("A COMPONENT or COMPONENT_SET id in this file."),
      componentKey: z.string().optional().describe("A published library component's key."),
      componentSetKey: z.string().optional().describe("A published library component set's key."),
      variant: z.string().optional().describe('For a set: which variant, e.g. "Size=Large, State=Hover". Default: the set\'s default variant.'),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional().describe("Defaults to the current page (in Slides: the focused slide)."),
      sizing: sizingParam.optional(),
    },
  );

  tool(
    "create_variable_collection",
    "Create variable collection",
    "A new variable collection (a token group). Its first mode is named after `modes[0]`, or \"Default\" — never Figma's " +
      "\"Mode 1\". Extra modes beyond the first are paid-plan only — if Figma refuses one, the result carries a `warnings` " +
      "entry rather than dropping it silently. Rename or remove modes later with figma_update_variable_collection.",
    {
      name: z.string(),
      modes: z.array(z.string()).optional().describe("Mode names, first is the default. Default [\"Default\"]."),
    },
  );

  tool(
    "create_variable",
    "Create variable",
    'One design token. `value` is a string for every type: "#1a2b3c" for COLOR, "16" for FLOAT, text for STRING, ' +
      '"true"/"false" for BOOLEAN, or "alias:<variable name or id>" of the same type. Set `scopes` (which pickers offer ' +
      "it; [] for a primitive only aliased) and a WEB `codeSyntax` on every token. A name the collection already has is " +
      "refused. For a whole token set in one call use figma_create_variables. Bind one to nodes with " +
      "figma_bind_variable_to_node; extra modes (figma_add_variable_mode) need a paid plan.",
    {
      collectionId: z.string(),
      name: z.string(),
      type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
      value: variableValueParam,
      modeId: z.string().optional().describe("Mode id or name. Defaults to the collection's first mode."),
      ...variablePropsShape(),
    },
  );

  tool(
    "create_paint_style",
    "Create paint style",
    "A local PAINT style: one `color`, or `fills` (several paints, gradients — entries as in figma_set_fills). " +
      "`variableId` / `variableName` binds the first paint's colour to a COLOR variable, so a semantic colour style follows " +
      "its token. Change it later in place with figma_update_style. A gradient style's `angle` is exact only on a square " +
      "node — a style has no size; for an exact CSS angle on a known node use figma_set_fills, or give `transform`.",
    {
      name: z.string(),
      ...paintStyleShape(),
      variableId: z.string().optional().describe("Bind the first paint's colour to this COLOR variable."),
      variableName: z.string().optional().describe('Or the variable\'s full name, e.g. "color/bg/brand".'),
      description: styleDescription(),
    },
  );

  tool(
    "create_text_style",
    "Create text style",
    'A local TEXT style. `lineHeight` and `letterSpacing` are STRINGS, as in figma_set_text_properties: "auto", "32" (px) ' +
      'or "150%"; "0.5" or "-2%" — a bare JSON number is no longer accepted here. `case` (e.g. upper for labels), ' +
      "`decoration`, paragraph spacing and indent are set on the style too. Change it later in place with figma_update_style.",
    {
      name: z.string(),
      fontSize: z.number().positive().describe("Required: a text style with no size is not usable."),
      ...textStyleShape(),
      description: styleDescription(),
    },
  );

  tool(
    "create_effect_style",
    "Create effect style",
    "A local effect style (shadows, blurs) that nodes can then follow via figma_apply_style_to_node. Same effect " +
      "entries as figma_set_effects. Change it later in place with figma_update_style.",
    {
      name: z.string(),
      effects: z.array(effectEntry).min(1).max(16),
      description: styleDescription(),
    },
  );
}
