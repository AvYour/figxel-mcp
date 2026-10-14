// The FigJam board tools on the server side: figma_create_stickies,
// figma_create_shapes_with_text, figma_create_connectors, figma_create_table,
// figma_create_code_block, figma_create_link_preview (create) and
// figma_edit_table, figma_edit_connectors, figma_set_board_properties,
// figma_fit_sections (modify).
//
// Every tool forwards as is: the plugin owns the checks (figjam/nodes.ts) and
// names the item and field that failed. The schemas keep to the portable
// subset — a union travels as one string (an endpoint "12:34@right", a dash
// "10,5", a padding "32") and every nested object is strict, so a stray key is
// refused rather than stripped (params.ts).
//
// Wired by the integrator in tools/index.ts, before registerBatch, so a batch
// step may name the modify tools and the Editors sentence is appended
// (batch.ts createShapeRecorder): registerFigjam(server, bridge, wanted).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription, hexColor, paddingParam, weightParam } from "./params.js";

const MAX_ITEMS = 200;

// Descriptions for the vocabularies, said once and reused where the agent writes the value.
const STICKY_COLORS = "white, gray, green, teal, blue, violet, pink, red, orange, yellow";
const CONNECTOR_COLORS = "black, dark-gray, gray, light-gray, green, teal, blue, violet, pink, red, orange, yellow, white";
const PRESETS = "black, dark-gray, gray, light-gray, white, and green, teal, blue, violet, pink, red, orange, yellow each with a light- form (light-green, …)";
const CAPS =
  "none, arrow-lines, arrow-equilateral, triangle-filled, diamond-filled, circle-filled, erd-zero-or-one, erd-exactly-one, erd-zero-or-more, erd-one-or-more, erd-one, erd-many";
const ENDPOINT =
  'One string: "12:34" (attach; magnet auto), "12:34@right" (magnet: auto, top, bottom, left, right, center, none), ' +
  '"12:34@0.5,1" (a point on the node, 0–1 of it — to be confirmed) or "120,340" (a free point).';
const LANGUAGES = "typescript, javascript, python, go, rust, ruby, css, html, json, graphql, sql, swift, kotlin, cpp, bash, plaintext, dart";

const where = {
  parentId: z.string().optional().describe("A section or frame to put it in (id or Figma link). Default: the current page."),
  x: z.number().optional().describe("Left edge, in the parent's coordinates. Default: below what the parent holds; on the page, right of its content."),
  y: z.number().optional().describe("Top edge, in the parent's coordinates."),
};
const grid = {
  ...where,
  columns: z.number().int().min(1).max(50).optional().describe("Items per row. Default: all in one row."),
};

const lineType = z.enum(["elbowed", "straight", "curved"]);
const connectorFields = {
  label: z.string().max(10_000).optional().describe("The visible text on the line (not its layer name)."),
  lineType: lineType.optional().describe("Default elbowed."),
  startCap: z.string().optional().describe(`Start cap: ${CAPS}. Default none.`),
  endCap: z.string().optional().describe(`End cap, same values. Default arrow-lines.`),
  color: z.string().optional().describe(`Line colour: ${CONNECTOR_COLORS}, or a hex.`),
  weight: z.number().positive().optional().describe("Line width in px."),
  dash: z.string().optional().describe('"solid", "dashed", "dotted", or a dash pattern such as "10,5".'),
  labelBackground: hexColor.optional().describe("The label's background colour."),
};

/**
 * Register the board tools. Wired by the integrator in tools/index.ts:
 * registerFigjam(server, bridge, wanted), before registerBatch.
 */
export function registerFigjam(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
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

  write(
    "create_stickies",
    "Create stickies (FigJam)",
    "FigJam sticky notes, one idea each, 1–200 in one call, laid out as a grid from their REAL sizes: a sticky is 240 " +
      "wide (416 with `wide`) and grows taller with its text, so rows are placed after the text is in and never overlap. " +
      `\`color\`: ${STICKY_COLORS}, or a hex — names land on FigJam's exact swatches. The size is fixed: no width or ` +
      "height; use `wide` for about 100 words or more. `columns` per row (default one row), `gap` (default 64). Prompts, " +
      "labels and instructions are text, not stickies. The parent is never resized: `parentOverflow` says how far the " +
      "block runs past it (then figma_fit_sections). Returns created [{ index, id, x, y, width, height }] and bounds.",
    {
      stickies: z
        .array(
          z
            .object({
              text: z.string().max(10_000).describe("The note."),
              color: z.string().optional().describe(`${STICKY_COLORS}, or a hex.`),
              wide: z.boolean().optional().describe("416 wide instead of 240. Default false."),
              authorVisible: z.boolean().optional().describe("Show the author's name. Default true."),
              name: z.string().optional().describe("Layer name."),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_ITEMS),
      ...grid,
      gap: z.number().min(0).optional().describe("Space between stickies, px. Default 64."),
    },
  );

  write(
    "create_shapes_with_text",
    "Create shapes with text (FigJam)",
    "FigJam shapes with text — flowchart steps, decisions, databases, callouts — 1–200 in one call, each sized to fit " +
      "its text unless width and height are given (`fitted`). `shape`: one of 30 types in kebab case (square, ellipse, " +
      "rounded-rectangle, diamond, triangle-up, parallelogram-right, eng-database, eng-queue, eng-file, eng-folder, " +
      "hexagon, chevron, speech-bubble, …) or `label`: a numbered or lettered circle marker of 1–2 characters at a fixed " +
      `size. \`color\` is a preset that sets fill, stroke and text together: ${PRESETS}; or give hex \`fill\` / ` +
      "`stroke` / `textColor` instead. Laid out like figma_create_stickies (`columns`, `gap` default 40). Join them with " +
      "figma_create_connectors. Row and column data is figma_create_table, never a grid of shapes.",
    {
      shapes: z
        .array(
          z
            .object({
              shape: z.string().describe('A shape type in kebab case ("rounded-rectangle", "diamond", "eng-database", …) or "label".'),
              text: z.string().max(10_000).describe("All of its text: it goes in the shape."),
              color: z.string().optional().describe("A coordinated preset (fill, stroke, text), or a hex for the fill alone."),
              fill: hexColor.optional(),
              stroke: hexColor.optional(),
              textColor: hexColor.optional(),
              width: z.number().positive().optional().describe("With height; omit both to fit the text."),
              height: z.number().positive().optional(),
              fontSize: z.number().min(1).optional().describe("Default: FigJam's; 20 for a label."),
              name: z.string().optional().describe("Layer name."),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_ITEMS),
      ...grid,
      gap: z.number().min(0).optional().describe("Space between shapes, px. Default 40."),
    },
  );

  write(
    "create_connectors",
    "Create connectors (FigJam)",
    "FigJam connector lines between nodes, 1–200 in one call. Each is made IN its final parent — by default the lowest " +
      "section holding both ends, else the page — and never moved: a reparented connector keeps stale elbows, so build " +
      `connectors last. Endpoints: ${ENDPOINT} An end may not be another connector. lineType elbowed (default), ` +
      "straight or curved; caps default none at the start and arrow-lines at the end (ERD caps too); `label` is the " +
      "visible text. Change one later with figma_edit_connectors.",
    {
      connectors: z
        .array(
          z
            .object({
              from: z.string().describe(ENDPOINT),
              to: z.string().describe("Same form as `from`."),
              ...connectorFields,
              name: z.string().optional().describe("Layer name."),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_ITEMS),
      parentId: z
        .string()
        .optional()
        .describe("Where every connector goes: a section or a frame without auto-layout. Default: per connector, the lowest section holding both ends, else the page."),
    },
  );

  write(
    "create_table",
    "Create a table (FigJam)",
    "A FigJam table — the tool for any row-and-column data, never a grid of shapes. Give `rows` (text, 1–100 rows of " +
      "1–20 cells, every row the same length; all of the user's data, no placeholders) or `numRows` + `numColumns` for " +
      "an empty one: exactly one form. `header` (default true with rows) colours row 0 with `headerColor`, a table " +
      `preset (default black: dark fill, white text): ${PRESETS}, or a hex. \`fill\` colours the table; a fill is never ` +
      "removed (\"\" is refused). `columnWidths` / `rowHeights` resize; a column cannot shrink below its minimum, so the " +
      "real widths come back. `fontFamily`, `weight`, `fontSize` apply to every cell. Cells have no ids: change them " +
      "with figma_edit_table.",
    {
      rows: z.array(z.array(z.string().max(10_000)).min(1).max(20)).min(1).max(100).optional().describe("The data, row by row; row 0 is the header."),
      numRows: z.number().int().min(1).max(100).optional().describe("An empty table: with numColumns, not with rows."),
      numColumns: z.number().int().min(1).max(20).optional(),
      header: z.boolean().optional().describe("Style row 0 as a header. Default true with rows, false for an empty table."),
      headerColor: z.string().optional().describe("Header preset or hex. Default black."),
      fill: z.string().optional().describe("Table preset or hex."),
      columnWidths: z.array(z.number().positive()).max(20).optional().describe("One width per column, px."),
      rowHeights: z.array(z.number().positive()).max(100).optional().describe("One height per row, px."),
      fontFamily: z.string().optional(),
      weight: weightParam.optional(),
      fontSize: z.number().min(1).optional(),
      name: z.string().optional().describe("Layer name."),
      ...where,
    },
  );

  write(
    "create_code_block",
    "Create a code block (FigJam)",
    `A FigJam code block with syntax highlighting. \`language\` (case-insensitive): ${LANGUAGES} — dart is in the ` +
      "Plugin API but not yet confirmed on the canvas. Default plaintext; any other value is refused rather than shown " +
      "as plain text, so ask for plaintext yourself. FigJam styles it: no theme, font or size to set.",
    {
      code: z.string().max(50_000).describe("The code."),
      language: z.string().optional().describe(`${LANGUAGES}. Default plaintext.`),
      name: z.string().optional().describe("Layer name."),
      ...where,
    },
  );

  write(
    "create_link_preview",
    "Create a link preview (FigJam)",
    "Paste a web link onto a FigJam board as a card. Figma fetches the https URL and inserts an EMBED (a page that " +
      "offers oEmbed, such as a video) or a LINK_UNFURL preview (title, description and image from the page's meta " +
      "tags). The parent is checked before Figma fetches; a link Figma cannot preview is refused in Figma's own words. " +
      "Returns { id, type, title?, provider? }.",
    {
      url: z.string().max(2048).describe("An https:// link."),
      ...where,
    },
  );

  write(
    "edit_table",
    "Edit a table (FigJam)",
    "Change a FigJam table's structure and cells. Cells have no ids: they are { row, column }, 0-based. Applied in this " +
      "order, every index checked against the table's size before anything changes: removeRows / removeColumns (their " +
      "content is lost), then insertRowsAt / insertColumnsAt (positions in the table after removals; each adds one " +
      "before that index, the count appends), then moveRow / moveColumn { from, to }, then columnWidths / rowHeights " +
      "[{ index, width | height }], then `cells` (up to 2000, in the final table): text, fill (table preset or hex; \"\" " +
      "is refused — give \"#FFFFFF\" to reset), textColor. Removing every row or column is refused. Returns the new size " +
      "and per-cell results.",
    {
      nodeId: z.string().describe("The TABLE."),
      cells: z
        .array(
          z
            .object({
              row: z.number().int().min(0),
              column: z.number().int().min(0),
              text: z.string().max(10_000).optional(),
              fill: z.string().optional().describe("Table preset or hex."),
              textColor: z.string().optional().describe("Text palette name or hex."),
            })
            .strict(),
        )
        .min(1)
        .max(2000)
        .optional(),
      insertRowsAt: z.array(z.number().int().min(0)).max(100).optional(),
      insertColumnsAt: z.array(z.number().int().min(0)).max(100).optional(),
      removeRows: z.array(z.number().int().min(0)).max(100).optional(),
      removeColumns: z.array(z.number().int().min(0)).max(100).optional(),
      moveRow: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).strict().optional(),
      moveColumn: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).strict().optional(),
      columnWidths: z.array(z.object({ index: z.number().int().min(0), width: z.number().positive() }).strict()).max(100).optional(),
      rowHeights: z.array(z.object({ index: z.number().int().min(0), height: z.number().positive() }).strict()).max(100).optional(),
    },
  );

  write(
    "edit_connectors",
    "Edit connectors (FigJam)",
    "Change existing FigJam connectors in place, 1–200 per call: re-point `from` / `to` (the endpoint strings of " +
      "figma_create_connectors), or set `label`, `lineType`, caps, `color`, `weight`, `dash`, `labelBackground`. The ids " +
      "stay, so it runs inside figma_batch. Every item is parsed, and every end checked, before the first change; a " +
      "missing node or one that is not a connector is a per-item error. Returns per-item results.",
    {
      connectors: z
        .array(
          z
            .object({
              nodeId: z.string().describe("The CONNECTOR."),
              from: z.string().optional().describe(ENDPOINT),
              to: z.string().optional(),
              ...connectorFields,
            })
            .strict(),
        )
        .min(1)
        .max(MAX_ITEMS),
    },
  );

  write(
    "set_board_properties",
    "Set board properties (FigJam)",
    "FigJam properties on 1–500 nodes, each applied by node type. `color` is a palette name resolved per type — sticky " +
      "fill, shape preset (fill, stroke and text), connector line, table fill, text fill — or a hex; a section takes a " +
      "hex only for now. `wide`, `authorVisible` (stickies), `shape` (shapes with text: a shape type), `contentsHidden` " +
      "(sections), `language` (code blocks). A field that does not apply to a node's type is an error for that node, " +
      "and that node is left unchanged. Hex paints on any node: figma_set_fills.",
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      color: z.string().optional().describe("A palette name for each node's type, or a hex."),
      wide: z.boolean().optional().describe("Stickies: 416 wide instead of 240."),
      authorVisible: z.boolean().optional().describe("Stickies: show the author."),
      shape: z.string().optional().describe('Shapes with text: a shape type such as "diamond".'),
      contentsHidden: z.boolean().optional().describe("Sections: hide what they hold."),
      language: z.string().optional().describe(`Code blocks: ${LANGUAGES}.`),
    },
  );

  write(
    "fit_sections",
    "Fit sections to their content",
    "Resize sections to hug what they hold plus `padding` (\"32\" by default, or \"top,right,bottom,left\" — a board " +
      "wrapper often takes \"68,60,100,80\"), never below minWidth / minHeight. Sections listed together are fitted " +
      "inner-first, so an outer one fits its inner ones' final size. Children move only when they reach into the top " +
      "or left padding; connectors never move — they follow their ends. An empty section is left as it is, with a note. " +
      "Do not fit a participatory zone sized for the activity, or one of a grid of equal sections. Works on Figma " +
      "Design sections too. A size you choose: figma_resize_nodes. Returns per-section results with the new size.",
    {
      nodeIds: z.array(z.string()).min(1).max(MAX_ITEMS).describe("SECTION ids."),
      padding: paddingParam.optional(),
      minWidth: z.number().positive().optional(),
      minHeight: z.number().positive().optional(),
    },
  );
}

/** The ops this module registers, in catalog order — for the integrator's ops.ts and editors.ts rows. */
export const FIGJAM_TOOL_OPS = [
  "create_stickies", "create_shapes_with_text", "create_connectors", "create_table", "create_code_block", "create_link_preview",
  "edit_table", "edit_connectors", "set_board_properties", "fit_sections",
] as const;
