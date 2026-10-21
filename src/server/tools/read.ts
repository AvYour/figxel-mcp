// The read group on the server side (tools.md § read). Each tool forwards its
// params to the matching plugin op through the shared forward path, so progress,
// cancellation and error shaping are identical to every other tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OPS } from "../../shared/ops.js";
import type { Bridge } from "../bridge.js";
import { briefIdInForce, type RoleProcess } from "../role-process.js";
import { fitDescription } from "./params.js";
import { forwardTool, type Extra } from "./forward.js";

const SESSION = {
  session: z
    .string()
    .optional()
    .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

// `idempotencyKey` is meaningless for a read: a read has no side effect to
// deduplicate, and asking for one would suggest otherwise.
function readTool(
  server: McpServer,
  bridge: Bridge,
  wanted: (op: string) => boolean,
  op: string,
  title: string,
  description: string,
  shape: z.ZodRawShape,
  /** Fill in defaults the server knows and the plugin does not (figma_check_layout's briefId). */
  prepare?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  // The toolset decides which reads exist; an op outside it is not registered at
  // all rather than registered-and-refusing.
  if (!wanted(op)) return;
  const annotations = OPS.get(op);
  server.registerTool(
    `figma_${op}`,
    {
      title,
      description,
      inputSchema: { ...shape, ...SESSION },
      annotations: {
        readOnlyHint: annotations?.readOnly ?? true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>, extra: Extra) =>
      forwardTool(bridge, op, prepare ? await prepare(args) : args, extra, { session: args.session as string | undefined }),
  );
}

export function registerRead(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, roles?: RoleProcess): void {
  readTool(
    server,
    bridge,
    wanted,
    "get_metadata",
    "Figma file metadata",
    "File name, page list, plugin API version and editor type, plus the current page and selection size. Start here when you " +
      "know nothing about the file yet. In a FigJam board it adds `board`: the top-level sections and a count of each node " +
      "type; in a Slides deck `slides`: rows, slide counts, the focused slide and the view. Note: `fileKey` is intentionally " +
      "absent — this plugin does not request private-plugin access, so Figma returns null for it.",
    {},
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_pages",
    "List pages",
    "Every page in the document (id, name, which one is current). Use a page id with figma_get_local_components to scope a scan.",
    {},
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_node",
    "Get one node",
    "One node with its children down to `depth`, as a normalized DTO (id, name, type, childCount; with `includeGeometry` " +
      "also layout, size, position, padding, radius, fill, scrolling). FigJam and Slides nodes also carry what they are: a " +
      "sticky's or shape's `text` (200 characters), `shapeType`, a connector's endpoints and label, a table's size, a slide's " +
      "row and column; a slide grid or row is `opaque` (only its box can be read). Depth 0 returns the node alone. Children " +
      "are capped per node; the count is always reported so a cap is never mistaken for the real structure. `format: \"rest\"` " +
      "returns Figma's own REST JSON for the subtree instead (cut at 200 KB, `truncated` says so) — for a field the DTO and " +
      "figma_get_design_context leave out.",
    {
      nodeId: z.string().describe("Node id (`12:34` or `12-34`) or a Figma link to the layer. Get ids from figma_get_selection, figma_search_nodes or figma_get_design_context."),
      depth: z.number().int().min(0).max(8).optional().describe("How many child levels to include. Default 1."),
      maxChildrenPerNode: z.number().int().min(0).max(200).optional().describe("Cap on children listed per node. Default 50."),
      includeGeometry: z.boolean().optional().describe("Layout, size, position, padding, radius, fill. Default true."),
      format: z.enum(["dto", "rest"]).optional().describe('"dto" (default) or "rest" (Figma REST JSON, bounded).'),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_nodes_info",
    "Get several nodes",
    "The same as figma_get_node for many ids in one round-trip. Per-id failures are reported per id rather than failing the whole call.",
    {
      nodeIds: z.array(z.string()).min(1).max(200).describe("Node ids or Figma links to fetch."),
      depth: z.number().int().min(0).max(8).optional().describe("Child levels per node. Default 0."),
      includeGeometry: z.boolean().optional().describe("Layout, size, position, padding, radius, fill. Default true."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_selection",
    "Get the current selection",
    "The nodes the user has selected in Figma right now. This is the usual entry point for \"make this into code\": the user " +
      "selects what they mean, then this returns it.",
    {
      depth: z.number().int().min(0).max(8).optional().describe("Child levels per selected node. Default 0."),
      includeGeometry: z.boolean().optional().describe("Layout, size, position, padding, radius, fill. Default true."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_design_context",
    "Get design context",
    "READ THIS BEFORE YOU BUILD OR CODE. The design as a designer sees it: one tree with, per node, size, position, " +
      "auto-layout (gap, padding, alignment, wrap row gap, grid tracks, hug/fixed/fill, min/max), constraints, fills " +
      "(gradient angles, image hashes) / strokes / effects / radius, text with its styled runs and links, styles and " +
      "variables BY NAME, explicit variable modes, and an instance's component with its keys. `stylesUsed` / " +
      "`variablesUsed` / `componentsUsed` list the tokens and components met, with ids and keys. FigJam: sticky, shape, " +
      "connector (endpoints as the connector tools write them), table cells and code blocks, plus `connectors`, the board's " +
      "edges. Slides: each slide's row, column and index. No nodeId: every selected layer (`roots`), else the page — in a " +
      "deck the focused slide, else its outline; `scope` says which. Bounded by `maxNodes`: `truncated: true` and " +
      "`nextCursor` return the rest. Text is cut at `maxTextChars`.",
    {
      nodeId: z.string().optional().describe("Subtree root: node id or a Figma link. Defaults to the selection, then the current page (in Slides the focused slide)."),
      depth: z.number().int().min(0).max(12).optional().describe("Levels to descend: 0 is the node alone. Default 8 (a whole screen)."),
      maxNodes: z.number().int().min(1).max(20000).optional().describe("Stop after this many nodes. Default 500."),
      maxChildrenPerNode: z.number().int().min(1).max(500).optional().describe("Cap on children per node. Default 50."),
      includeGeometry: z.boolean().optional().describe("Size, position, auto-layout, constraints, radius, opacity. Default true."),
      includeStyles: z.boolean().optional().describe("Style names, text runs and instance components. Default true."),
      includeVariables: z.boolean().optional().describe("Bound variable names and values, explicit modes. Default true."),
      maxTextChars: z.number().int().min(1).max(20000).optional().describe("Characters of text shown per node. Default 400."),
      includeAnnotations: z.boolean().optional().describe("Per-node annotations (label, category). Default true."),
      includeCss: z.boolean().optional().describe("Per-node CSS from Figma's inspect panel (getCSSAsync). Default false; slower."),
      maxTableCells: z.number().int().min(1).max(5000).optional().describe("FigJam table cells read per table before it is cut (tableNote). Default 500."),
      absolute: z.boolean().optional().describe("Add `abs` per node: its box on the page (x/y are relative to the parent). Default false."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "check_layout",
    "Check a design for defects",
    "After each section and before calling anything done: a designer's last look, in numbers " +
      "(figma_export_node shows the picture). Per node, with a number and fix: text overflowing, collapsed, " +
      "overlapping or covered; content clipped or sticking out; a fill child in a hug parent; stacked frames; " +
      "placeholder copy; low contrast (WCAG); zero-size, empty or default-named nodes; text off or cut by a slide. " +
      "`audit` adds: tokens (unbound values), names (duplicates), fonts (`expectFonts`), board (FigJam), craft " +
      "(finish: sizes, edges, near-touches, contrast; `safeArea`, `minTextSize`), tells (generated look; warning if " +
      "the brief avoids it), handoff (share bound), a role's: a11y (targets, focus, labels), states, copy, system (format, scale, " +
      "grid), deck (words, headlines, floor), mark (size, versions, clear space), icons (canvas, stroke, pixels), " +
      "library (modes, aliases). `briefId`: against that brief's numbers. `ok: true` = no errors or warnings. " +
      "Default: the selection, then the page (Slides: focused slide). Reads only.",
    {
      nodeId: z.string().optional().describe("The frame or section to check. Defaults to every selected node, then the page."),
      nodeIds: z.array(z.string()).min(1).max(100).optional().describe("Several roots in one call, e.g. a batch of 3–5 slides. Not with nodeId."),
      minSeverity: z.enum(["error", "warning", "info"]).optional().describe('Hide findings below this level. Default "info".'),
      limit: z.number().int().min(1).max(1000).optional().describe("Max findings returned. Default 100."),
      maxNodes: z.number().int().min(1).max(50000).optional().describe("Stop after this many nodes. Default 3000."),
      audit: z
        .array(z.enum(["tokens", "names", "fonts", "board", "craft", "tells", "handoff", "a11y", "states", "copy", "system", "deck", "mark", "icons", "library"]))
        .max(15)
        .optional()
        .describe(
          "QA passes to add: tokens, names, fonts, board, craft (finish defects), tells (the generated look; info, a warning where a page or top brief avoids it, and run by default under one), handoff " +
            "(how much is bound to the system), a11y, states, copy, system, deck, mark, icons, library (a role's sign-off checks; with " +
            "briefId, the brief's numbers).",
        ),
      briefId: z
        .string()
        .optional()
        .describe("The node a brief is stored on (figma_set_brief returns it): the role audits measure against its platform, viewport, screens, system, room, applications, grid and platforms, and craft takes its minTextSize and safeArea. At page or top gear its `avoid` kinds are warnings, and tells run by default where its role's sign-off judges them or it avoids one. A motion brief judges layout where the viewer sees it (restPose). Default: the brief in force, unless the checked node is another brief's work (its own record, its top-level frame's, or a brief listing it), which wins; audit.brief names the one used."),
      expectFonts: z.array(z.string()).max(20).optional().describe('Font families the design should use, e.g. ["Inter"]; implies the fonts audit.'),
      safeArea: z
        .string()
        .optional()
        .describe('"x,y,width,height" in the root\'s coordinates (its top-left is 0,0), from the brief — no presets. Text, logos and CTAs outside it are flagged. Implies craft.'),
      minTextSize: z
        .number()
        .min(1)
        .max(1000)
        .optional()
        .describe("Smallest readable text in px of the frame: the device's floor × frame width ÷ device width, e.g. 28 or more on a 1080-wide story. Implies craft."),
    },
    // With no briefId, the brief in force for the file (spec §4): the role's audits measure against its numbers.
    // Sent as briefInForce, not briefId: the plugin lets the brief the checked work belongs to outrank it.
    async (args) => {
      if (args.briefId !== undefined || !roles) return args;
      const briefInForce = await briefIdInForce(roles, bridge, args.session as string | undefined);
      return briefInForce ? { ...args, briefInForce } : args;
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "search_nodes",
    "Search nodes by name or type",
    "Find nodes by name substring, by what their text says (`text`: a TEXT node's characters, a sticky's, shape's or " +
      "connector's label, a code block, a table cell — a cell hit names its `cell`), and/or Figma node type, or every instance " +
      "of a component (`componentId`; for a variant set, every variant's instances, each hit naming the variant it shows). " +
      "`scope` picks where to look: the current page (default), the current selection, or a specific subtree; the result's " +
      "`scope` says which root was searched. Paginated with `limit` + `cursor`. Every text in a subtree: figma_scan_text_nodes.",
    {
      query: z.string().optional().describe("Name substring (case-insensitive)."),
      text: z.string().optional().describe("Content substring (case-insensitive). query/type then optional."),
      exactName: z.boolean().optional().describe("Match the name exactly instead of as a substring. Default false."),
      type: z.string().optional().describe("Figma node type, e.g. FRAME, TEXT, COMPONENT, INSTANCE, RECTANGLE."),
      componentId: z.string().optional().describe("A COMPONENT or COMPONENT_SET id (or link): find its instances. query/type then optional."),
      scope: z.enum(["page", "selection", "subtree"]).optional().describe("Where to search. Default \"page\"."),
      nodeId: z.string().optional().describe("Subtree root when scope is \"subtree\": node id or a Figma link."),
      limit: z.number().int().min(1).max(500).optional().describe("Max results. Default 50."),
      cursor: z.string().optional().describe("Opaque cursor from a previous truncated call."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "scan_nodes_by_types",
    "Scan for node types",
    "Every node of the given types in a subtree, at any depth — the \"find all frames / all components\" tool. Paginated. " +
      "The result's `scope` names the root that was scanned.",
    {
      types: z.array(z.string()).min(1).max(20).describe("Node types, e.g. [\"FRAME\",\"COMPONENT\"], or on a board [\"STICKY\",\"CONNECTOR\"]."),
      nodeId: z.string().optional().describe("Subtree root: node id or a Figma link. Defaults to the one selected layer, then the current page."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max results. Default 200."),
      cursor: z.string().optional().describe("Opaque cursor from a previous truncated call."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "scan_text_nodes",
    "Scan all text",
    "Every text in a subtree with its full characters — a copy audit, a translation extract, or the text behind a screen " +
      "when figma_get_design_context cut it at maxTextChars. TEXT nodes, and on a board the text a sticky, shape or " +
      "connector holds, code blocks, and one item per non-empty table cell (its `cell`); `types` narrows it. Paginated by " +
      "item: a truncated scan says so rather than returning a partial document as if it were whole. The result's `scope` " +
      "names the root that was scanned (in Slides, with nothing selected, the focused slide). Finding one text: " +
      "figma_search_nodes { text }.",
    {
      nodeId: z.string().optional().describe("Subtree root: node id or a Figma link. Defaults to the one selected layer, then the current page."),
      types: z
        .array(z.enum(["TEXT", "STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "CODE_BLOCK", "TABLE"]))
        .min(1)
        .max(6)
        .optional()
        .describe("Only these holders. Default all six."),
      limit: z.number().int().min(1).max(5000).optional().describe("Max text items. Default 500."),
      cursor: z.string().optional().describe("Opaque cursor from a previous truncated call."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_styles",
    "List local styles",
    "Paint, text, effect and grid styles defined in THIS file, each with its key, a one-line `value` (\"Inter Semi Bold " +
      "24/32 -1% upper\", \"#1a2b3c (var: color/bg)\", \"drop-shadow 0 4 12 0 #000000 10%\", \"columns 12, gutter 24, margin " +
      "64\"), its description and the variables bound inside it — pick a style by what it is, not by its name. Local only: " +
      "a library-styled file returns count 0; read library styles with figma_get_variable_defs { nodeId } or " +
      "figma_get_design_context on a screen. Paginated with `limit` + `cursor`.",
    {
      type: z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]).optional().describe("Only this style type. Omit for all."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max styles. Default 500."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_variable_defs",
    "Get variables and their values",
    "Design tokens with their VALUES. Without `nodeId`: every local collection (modes, default mode, key) and variable with " +
      "`values` per mode name (\"#1a2b3c80\", \"16\", \"true\", \"alias:color/blue/500\" — strings, as figma_set_variable_value takes them), " +
      "`scopes`, `codeSyntax`, key and description; paginated. With `nodeId` (a frame, a screen, a page): only the variables " +
      "and styles that subtree USES, library ones included — `variables` { name: value resolved for that node, so a Dark " +
      "frame reads Dark }, `styles` { name: value line }, and `details` with ids, keys and code syntax. Variables work on any " +
      "plan; modes beyond the first are paid-only.",
    {
      nodeId: z.string().optional().describe("Read the tokens this subtree uses instead of the file-wide list."),
      collectionId: z.string().optional().describe("Only this collection."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max variables (file-wide list). Default 500."),
      maxNodes: z.number().int().min(1).max(20000).optional().describe("Nodes walked with `nodeId`. Default 2000."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_local_components",
    "List local components",
    "Components and component sets defined in this file: page, key and description of each; a variant carries its " +
      "set's id and name, a set its variant count and variant options. Scope to one page with `pageId`; without it " +
      "every page is loaded first, which takes a moment on a large file. figma_get_component reads one component's " +
      "full property definitions.",
    { pageId: z.string().optional().describe("Only this page. Omit for the whole document.") },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_fonts",
    "List fonts",
    "Fonts used by text on the current page (`scope: \"page\"`, default) — every run of mixed-style text counted, and the " +
      "text of stickies, shapes, connectors and table cells on a board — with how many nodes use each, `missingFonts` when " +
      "the file uses a font this machine lacks, and `missing: true` on each such font. `scope: \"available\"`: the families " +
      "this Figma can load, each with its exact style names, 50 per call (`limit` up to 500; `total`, `truncated` and " +
      "`nextCursor` say what is left). `query` keeps names containing a word (\"serif\", \"grotesk\"); `families` checks exact " +
      "names and lists the ones not found in `missing`. `query`, `families`, `limit` and `cursor` imply scope \"available\".",
    {
      scope: z.enum(["page", "available"]).optional().describe("Default \"page\", or \"available\" when a filter below is given."),
      query: z.string().optional().describe("Available families whose name contains this, case-insensitive, e.g. \"mono\"."),
      families: z
        .array(z.string())
        .min(1)
        .max(50)
        .optional()
        .describe('Exact family names to check, e.g. ["Inter", "Playfair Display"]: each found one with its styles; the rest in `missing`.'),
      limit: z.number().int().min(1).max(500).optional().describe("Families per call. Default 50."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_annotations",
    "Get annotations",
    "Annotations on a node or subtree — the notes designers leave for developers — each with its category (label, colour), " +
      "plus the subtree's dev resources (links to code, tickets, docs) where Figma provides them. Empty is a normal answer, " +
      "not an error. The result's `scope` names the root that was read.",
    { nodeId: z.string().optional().describe("Subtree root: node id or a Figma link. Defaults to the one selected layer, then the current page.") },
  );

  readTool(
    server,
    bridge,
    wanted,
    "get_reactions",
    "Get prototype reactions",
    "Prototype reactions: what a layer does on click, drag, hover, and where it navigates. `scope: \"node\"` (default) reads " +
      "one node; `\"subtree\"` or `\"page\"` lists every node with reactions, plus the page's flows, prototype start and " +
      "background, and frames that scroll, keep fixed layers or open as overlays. Read it before generating interactive code; " +
      "figma_set_reactions writes them.",
    {
      nodeId: z.string().optional().describe("Node id or Figma link. Required unless scope is \"page\" (then: the page it sits on)."),
      scope: z.enum(["node", "subtree", "page"]).optional().describe("Default \"node\"."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max nodes per call for subtree/page. Default 200."),
      cursor: z.string().optional().describe("Opaque cursor from a previous truncated call."),
    },
  );
}
