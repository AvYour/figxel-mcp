// The Figma Slides tools on the server side: figma_get_slide_grid (read),
// figma_create_slides (create), figma_set_slide_grid, figma_move_slides,
// figma_set_slide_properties (modify) and figma_set_slide_transition (style).
//
// Every one forwards as is; the plugin validates the cross-field rules (one
// anchor, a field per item, delay with after-delay) before its first change,
// so a refusal there is still `created: []` and safe to retry [C-096]. What
// happens here is the schema — strict, inside the portable subset.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription, hexColor } from "./params.js";

/** SlideTransition.style (d.ts:12372-12395); the plugin's list is the same (test/slides.test.ts pins it). */
export const TRANSITION_STYLES = [
  "NONE", "DISSOLVE",
  "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP",
  "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP",
  "MOVE_FROM_LEFT", "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM",
  "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT", "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM",
  "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP", "MOVE_OUT_TO_BOTTOM",
  "SMART_ANIMATE",
] as const;
/** SlideTransition.curve (d.ts:12403-12404). */
export const TRANSITION_CURVES = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW"] as const;

const SESSION = {
  session: z.string().optional().describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const slideId = z.string().describe('A slide id ("12:34") or a figma.com/slides link to it.');

/**
 * Register the Slides tools. Wired in tools/index.ts before registerBatch, so a
 * batch step can name the modify and style ones. Slide ids ("12-34", a pasted
 * /slides/ link) are normalised by forwardTool like every node id (figma-url.ts
 * ID_KEYS lists slideId, slideIds, afterSlideId and beforeSlideId), so a link
 * also picks the deck's session and a batch step gets the same treatment.
 */
export function registerSlides(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
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

  if (wanted("get_slide_grid")) {
    server.registerTool(
      "figma_get_slide_grid",
      {
        title: "Get the slide grid",
        description: fitDescription(
          "Read a Figma Slides deck as its grid — start here in a deck. Rows (each row is a section: id, name) of slides " +
            "in presentation order; per slide its id, name, row, col, index, skipped, child count and speaker notes, " +
            "and with includeSummary its background, title (its largest text) and interactive elements; " +
            "includeTransitions adds each slide's transition. Reads the slides only, never the opaque rows or grid. " +
            "`unsupported` names what this Figma build does not expose (speakerNotes, transition). An empty deck has no " +
            "rows: the first figma_create_slides makes row 0. Paginated by slide (limit, cursor); rowIndex reads one " +
            "row. A slide's layers: figma_get_design_context or figma_scan_text_nodes with the slide id; its picture: " +
            "figma_export_node.",
        ),
        inputSchema: {
          includeNotes: z.boolean().optional().describe("Each slide's speaker notes (markdown). Default true."),
          includeTransitions: z.boolean().optional().describe("Each slide's transition, or transitionError. Default false."),
          includeSummary: z.boolean().optional().describe("Per slide: background, title, interactive elements. Default true."),
          rowIndex: z.number().int().min(0).optional().describe("Read one row (section) only."),
          limit: z.number().int().min(1).max(2000).optional().describe("Slides per call. Default 500."),
          cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
          ...SESSION,
        },
        annotations: readAnnotations("get_slide_grid"),
      },
      async (args: Record<string, unknown>, extra: Extra) => forwardTool(bridge, "get_slide_grid", args, extra, { session: args.session as string | undefined }),
    );
  }

  write(
    "create_slides",
    "Create slides",
    "Add 1–20 empty 1920×1080 slides to a Figma Slides deck, in list order. Then give each its content with one " +
      "figma_create_from_spec (parentId = the slide id), and check the batch with figma_check_layout — 3–5 slides per " +
      "call. Per item: name, background (hex; it goes on the slide, since rows and the grid have no fill), skipped, " +
      "and where: `row` + `col`, counted against the grid the earlier items left (row = the current row count opens a " +
      "new last row), or neither for the end of the deck. On an empty deck the first slide makes row 0. Every position " +
      "is checked before the first slide exists. Returns each slide's id, row, col and index as read back. Not for " +
      "frames on a page (figma_create_frame); to reorder use figma_move_slides, to regroup figma_set_slide_grid. Do " +
      "not delete and rebuild slides to restyle a deck: edit them in place.",
    {
      slides: z
        .array(
          z
            .object({
              name: z.string().max(200).optional(),
              row: z.number().int().min(0).optional().describe("Row (section) index; the current row count opens a new last row."),
              col: z.number().int().min(0).optional().describe("Position in that row; default its end. Needs `row`."),
              background: hexColor.optional().describe("The slide's fill, e.g. \"#0b1020\"."),
              skipped: z.boolean().optional().describe("Leave it out of the presentation. Default false."),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    },
  );

  write(
    "set_slide_grid",
    "Regroup the slide grid",
    "Restate a whole Figma Slides deck's grouping in one step: `rows` lists every slide id in its new row (section) " +
      "and order, each row with an optional name (1–3 words; \"\" restores the default label). Every slide of the " +
      "deck must appear exactly once — a missing, repeated or unknown id is refused, listed by id, before anything " +
      "changes; no slide is ever removed. Returns the rows as they are afterwards, how many slides moved and rows " +
      "were renamed, and rows left empty or removed. To move a few slides without restating the deck use " +
      "figma_move_slides; to rename one section use figma_rename_node on its row id (figma_get_slide_grid lists them).",
    {
      rows: z
        .array(
          z
            .object({
              slideIds: z.array(slideId).min(1).max(500),
              name: z.string().max(60).optional().describe("The section name; \"\" restores the default label."),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    },
  );

  write(
    "move_slides",
    "Move slides",
    "Move slides within a Figma Slides deck as one block, in the order given, to exactly one anchor: after or before " +
      "another slide (`afterSlideId` / `beforeSlideId`), or into a row (`row`, optional `col`, both counted once the " +
      "moved slides are taken out; row = the row count opens a new last row). An anchor that is itself being moved is " +
      "refused before anything changes. Every slide stays in the deck; a row the move empties stays as an empty " +
      "section and is listed in `emptiedRows`. Per-slide results with the new row, col and index. To restate the " +
      "whole deck's grouping use figma_set_slide_grid.",
    {
      slideIds: z.array(slideId).min(1).max(200).describe("The slides to move, in the order they should end up."),
      afterSlideId: slideId.optional().describe("Put them right after this slide."),
      beforeSlideId: slideId.optional().describe("Put them right before this slide."),
      row: z.number().int().min(0).optional().describe("Put them in this row (section); the row count opens a new last row."),
      col: z.number().int().min(0).optional().describe("With `row`: their position in it; default its end."),
    },
  );

  write(
    "set_slide_properties",
    "Set slide properties",
    "Per slide of a Figma Slides deck: `skipped` (left out of the presentation, kept in the deck) and `speakerNotes` " +
      "(the presenter's notes as markdown; \"\" clears). Notes keep lists, bold, italic and strikethrough; headings, " +
      "code and links stay literal text and earn a warning. Write notes only when asked or for a deck meant to be " +
      "presented: short bullets that add to the slide, not a script. If this Figma build does not expose speaker " +
      "notes, a call that sets them is refused before anything changes. Per-slide results. Slide names: " +
      "figma_rename_node; backgrounds: figma_set_fills on the slide; transitions: figma_set_slide_transition.",
    {
      slides: z
        .array(
          z
            .object({
              slideId,
              skipped: z.boolean().optional(),
              speakerNotes: z.string().max(20000).optional().describe("Markdown; \"\" clears the notes."),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    },
  );

  write(
    "set_slide_transition",
    "Set slide transitions",
    "Set the transition into each of these Figma Slides slides: `style` (DISSOLVE, SMART_ANIMATE, SLIDE_FROM_LEFT, " +
      "PUSH_FROM_RIGHT, … or NONE), `duration` 0.01–10 s, `curve`, and `timing`: on-click, or after-delay with " +
      "`delay` 0–30 s (a delay with on-click is refused: Figma sets it to 0). Fields left out keep each slide's " +
      "current value. Each slide's transition is read before anything changes: if this Figma build does not " +
      "implement transitions the call is refused, nothing changed. Returns each slide's transition as read back. Not " +
      "prototype interactions (figma_set_reactions) or layer animation (figma_set_keyframes).",
    {
      slideIds: z.array(slideId).min(1).max(500),
      style: z.enum(TRANSITION_STYLES).describe("The transition style; NONE removes it."),
      duration: z.number().min(0.01).max(10).optional().describe("Seconds."),
      curve: z.enum(TRANSITION_CURVES).optional().describe("Easing (EASE_IN_AND_OUT, not EASE_IN_OUT)."),
      timing: z.enum(["on-click", "after-delay"]).optional().describe("What starts it."),
      delay: z.number().min(0).max(30).optional().describe("Seconds, with timing after-delay only."),
    },
  );
}
