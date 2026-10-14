// Typography and assets on the server side: choosing fonts that fit a design,
// editing text like Figma's text panel, and placing icons and images.

import { readFile, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { Bridge } from "../bridge.js";
import { resolveSavePath, type ExportRoots } from "../exports.js";
import { toNodeId } from "../figma-url.js";
import { errorResult } from "../results.js";
import { writeAnnotations, readAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription, hexColor, sizingParam, weightParam } from "./params.js";

const SESSION = {
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const PER_ITEM = "Returns per-item results: `items: [{ id, ok, error? }]` — one node failing does not fail the call.";

/** The text-panel properties shared by figma_set_text_properties and figma_set_text_range. */
const TEXT_PROPS = {
  fontFamily: z.string().optional().describe("A family available in this Figma (figma_suggest_fonts lists ranked ones)."),
  weight: weightParam.optional(),
  fontSize: z.number().positive().optional(),
  lineHeight: z.string().optional().describe('"auto", px ("24"), or percent ("150%").'),
  letterSpacing: z.string().optional().describe('px ("0.5") or percent ("-1%").'),
  case: z.enum(["original", "upper", "lower", "title", "small-caps"]).optional(),
  decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
  color: hexColor.optional(),
  paragraphSpacing: z.number().nonnegative().optional().describe("Vertical px between paragraphs."),
  paragraphIndent: z.number().nonnegative().optional().describe("px the first line of each paragraph is offset from the left."),
  list: z.enum(["none", "ordered", "unordered"]).optional().describe("Numbered or bulleted paragraphs; none removes the list."),
};

/** A variable name or id per bindable text field — a plain object of optional strings, which stays portable. */
const varRef = z.string().optional();
const RANGE_VARIABLES = z
  .object({
    fontSize: varRef,
    fontFamily: varRef,
    fontStyle: varRef,
    fontWeight: varRef,
    lineHeight: varRef,
    letterSpacing: varRef,
    paragraphSpacing: varRef,
    paragraphIndent: varRef,
  })
  // A field it does not list (textCase, a typo) is refused, not stripped before the plugin sees it.
  .strict()
  .describe('Bind fields of the range to variables, e.g. { "fontSize": "type/body/size" }: FLOAT for sizes and spacing, STRING for family and style, either for weight.');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function registerTypography(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean): void {
  const write = (op: string, title: string, description: string, shape: z.ZodRawShape, prepare?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) => {
        let params = args;
        try {
          if (prepare) params = await prepare(args);
        } catch (err) {
          // The bridge refused before the plugin saw the call: the document is untouched [C-096].
          return errorResult(err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err, { unchanged: true });
        }
        return forwardTool(bridge, op, params, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        });
      },
    );
  };

  if (wanted("suggest_fonts")) {
    server.registerTool(
      "figma_suggest_fonts",
      {
        title: "Suggest fonts that fit the design",
        description: fitDescription(
          "Choose typography the way a designer would: reads the fonts and sizes the design already uses, and the fonts " +
            "actually available in this Figma, then ranks heading/body pairings for the `mood` and `use` — with the exact " +
            "style names to pass on — plus a type scale. When the design already has a font, `consistency` says so: keep it " +
            "unless changing it is the point. `applyPlan` splits the existing text into heading and body node ids, so a " +
            "choice applies in two figma_set_text_properties calls. A large page is read in part — up to 5,000 layers or " +
            "5 s; `scanned` says whether it was whole — so pass nodeId to fit one frame. Reads only.",
        ),
        inputSchema: {
          mood: z.string().optional().describe('Words for the feel, e.g. "modern minimal", "editorial elegant", "playful", "technical".'),
          use: z.enum(["ui", "mobile", "marketing", "editorial", "code", "brand"]).optional().describe('What the text is for. Default "ui".'),
          nodeId: z.string().optional().describe("The design to fit. Defaults to the selection, then the page."),
          limit: z.number().int().min(1).max(20).optional().describe("Pairings to return. Default 5."),
          ...SESSION,
        },
        annotations: readAnnotations("suggest_fonts"),
      },
      async (args: Record<string, unknown>, extra: Extra) => forwardTool(bridge, "suggest_fonts", args, extra, { session: args.session as string | undefined }),
    );
  }

  write(
    "set_text_properties",
    "Set text properties",
    "Change typography on whole text nodes, like Figma's text panel: font family, weight, size, line height, letter " +
      "spacing, case, decoration, colour, paragraph spacing and indent, lists, alignment (horizontal and vertical), " +
      "resizing, truncation, leading trim, wrap style. A new family keeps each run's own weight (a bold word stays bold); " +
      "a new weight applies to all of it. A weight the family names differently (\"SemiBold\" vs \"Semi Bold\") is " +
      "matched, and anything substituted is reported as `fellBack`. `maxLines` ends the text in an ellipsis after that " +
      "many lines. On a board a sticky, shape or connector restyles its text, and a table every cell; those texts have " +
      "no alignment, resizing or truncation of their own. For part of a text use figma_set_text_range. " +
      PER_ITEM,
    {
      nodeIds: z.array(z.string()).min(1).max(500),
      ...TEXT_PROPS,
      align: z.enum(["left", "center", "right", "justified"]).optional(),
      alignVertical: z.enum(["top", "center", "bottom"]).optional().describe("Where the text sits in a box taller than it."),
      autoResize: z
        .enum(["hug", "wrap", "fixed", "truncate"])
        .optional()
        .describe("hug = one line that grows; wrap = fixed width, grows down; truncate = a fixed box ending in an ellipsis."),
      maxLines: z.number().int().min(1).optional().describe("Truncate with an ellipsis after this many lines."),
      truncate: z.boolean().optional().describe("Turn ellipsis truncation on or off."),
      leadingTrim: z.enum(["none", "cap-height"]).optional().describe("cap-height removes the vertical space above and below the glyphs."),
      wrapStyle: z.enum(["auto", "balance", "pretty"]).optional().describe("Figma's textWrapStyle."),
    },
  );

  write(
    "set_text_range",
    "Style part of a text",
    "Style part of one text node (or a sticky's, shape's or connector's text) — a bold word, a coloured price, an " +
      "underlined link, a bulleted paragraph. Pick the " +
      "part with `match` (every occurrence, or the nth with `occurrence`) or with `start`/`end` character offsets. " +
      "Paragraph spacing, paragraph indent, `list` and its `indent` level widen to the whole paragraphs the part touches. To tie the part to the " +
      "design system: `textStyle` and `fillStyle` (a local style's id or exact name), `colorVariable` (a COLOR " +
      "variable), and `variables` per text field. One colour source per call: `color`, `fillStyle` or `colorVariable`. " +
      "`link` takes a URL, or \"node:<id>\" to link to a layer in this file. Everything is checked before the text " +
      "changes. For whole-node properties (alignment, resizing, truncation) use figma_set_text_properties.",
    {
      nodeId: z.string(),
      match: z.string().optional().describe("The text to style, e.g. \"Pro\"."),
      occurrence: z.number().int().min(1).optional().describe("Only the nth match. Default: all."),
      start: z.number().int().min(0).optional(),
      end: z.number().int().min(1).optional(),
      ...TEXT_PROPS,
      indent: z.number().int().min(0).max(5).optional().describe("List level of the lines, 0–5 (1 = a top-level item); with `list` for nested bullets."),
      textStyle: z.string().optional().describe('A text style id ("S:…") or exact name, e.g. "Body/Strong".'),
      fillStyle: z.string().optional().describe("A paint style id or exact name for the text colour."),
      colorVariable: z.string().optional().describe('A COLOR variable name or id, e.g. "color/text/link".'),
      variables: RANGE_VARIABLES.optional(),
      link: z.string().optional().describe('A URL, or "node:<id>" for a layer in this file.'),
    },
  );

  write(
    "import_svg",
    "Import SVG (icon / vector)",
    "Place SVG markup as editable vectors — icons, logos, illustrations. `width` (or `height`) scales the drawing with " +
      "its vectors; `color` recolours every painted vector, the usual way to put an icon in the brand colour, and " +
      "`colorVariable` binds them to a COLOR variable instead, so the icon follows the token (stroke-only icons stay " +
      "stroke-only). The result lists the painted layers as `vectorIds`. Place it into a frame by `parentId`.",
    {
      svg: z.string().describe("The SVG markup, starting with <svg …>."),
      name: z.string().optional().describe('e.g. "Icon / Search".'),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional().describe("Scale to this width, keeping proportions."),
      height: z.number().positive().optional().describe("Or to this height."),
      color: hexColor.optional(),
      colorVariable: z.string().optional().describe('A COLOR variable name or id, e.g. "color/icon/default". Not with `color`.'),
      sizing: sizingParam.optional(),
    },
  );

  write(
    "import_image",
    "Import image",
    "Place a picture: from a `url` (http/https, fetched by Figma), a local `path` inside the export directory or " +
      "BRIDGE_EXPORT_ROOTS (read by the bridge), or `renderNodeId`: a layer of this file rendered to a picture inside " +
      "Figma — a styleframe snapshotted into a storyboard thumbnail, a frame on a mood board. With `nodeId` it becomes " +
      "that node's fill; otherwise a new rectangle at the image's own proportions (a render: the layer's own size), or " +
      "`width`/`height`. `scaleMode` fill / fit / crop / tile. PNG, JPEG or GIF, at most 4096 px a side. To look at a " +
      "layer yourself, figma_export_node returns its picture to you instead of placing it.",
    {
      url: z.string().optional(),
      path: z.string().optional().describe("A file inside an allowed root; relative paths resolve from the export directory."),
      renderNodeId: z.string().optional().describe("A layer of this file to render as the picture. Not with `url` or `path`."),
      renderWidth: z
        .number()
        .int()
        .min(16)
        .max(4096)
        .optional()
        .describe("Pixel width of the render; its height follows the layer. Default twice the target's width, within 4096 px a side."),
      nodeId: z.string().optional().describe("Fill this existing node instead of creating a rectangle."),
      parentId: z.string().optional(),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      cornerRadius: z.number().nonnegative().optional(),
      scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional().describe('Default "fill".'),
      sizing: sizingParam.optional(),
    },
    async (args) => {
      const sources = (["url", "path", "renderNodeId"] as const).filter((k) => args[k] !== undefined);
      if (sources.length > 1) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `Give one image source, not ${sources.map((k) => `\`${k}\``).join(" and ")}.`);
      }
      if (args.renderWidth !== undefined && args.renderNodeId === undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`renderWidth` sizes a `renderNodeId` render; give renderNodeId, or leave renderWidth out.");
      }
      // forwardTool converts only its known id keys: a pasted layer link or "12-34" here becomes "12:34".
      if (typeof args.renderNodeId === "string") return { ...args, renderNodeId: toNodeId(args.renderNodeId, "renderNodeId").id };
      if (typeof args.path !== "string") return args;
      // The bridge reads the file; only inside the roots export may write to.
      const file = await resolveSavePath(args.path, roots);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new BridgeError(ErrorCode.INVALID_PARAM, `No file at ${file}.`);
      if (info.size > MAX_IMAGE_BYTES) throw new BridgeError(ErrorCode.INVALID_PARAM, `${file} is ${Math.round(info.size / 1e6)} MB; the limit is 20 MB.`);
      const { path: _path, ...rest } = args;
      return { ...rest, base64: (await readFile(file)).toString("base64") };
    },
  );
}
