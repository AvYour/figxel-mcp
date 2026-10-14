// figma_create_storyboard and figma_create_animatic on the server side: the
// schemas, and the plan or options checked here before the bridge is asked —
// the planners are shared with the plugin (shared/storyboard.ts,
// shared/animatic.ts), so a refusal here is the same refusal the plugin would
// give, minus the round-trip, and provably changed nothing [C-096].
//
// Registered by the integrator in tools/index.ts, before registerBatch; both
// ops are in the create group, which a batch never holds.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANIMATIC_LIMITS, BURN_INS, readAnimaticOptions } from "../../shared/animatic.js";
import { BridgeError } from "../../shared/errors.js";
import { ASPECTS, CAPTIONS, planStoryboard, SNAPS, STORYBOARD_LIMITS as L } from "../../shared/storyboard.js";
import type { Bridge } from "../bridge.js";
import { toNodeId } from "../figma-url.js";
import { errorResult } from "../results.js";
import { writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

const caption = (what: string) => z.string().max(L.text).optional().describe(what);

/** One panel: one shot or beat of the piece. Strict, so a misspelt field is refused rather than dropped. */
export const panelEntry = z
  .object({
    durationS: z.number().positive().max(L.panelS).describe("Seconds on screen. Panels run back to back from 0."),
    title: z.string().max(L.panelTitle).optional().describe('Shown in the card header, e.g. "Ash vase".'),
    beat: caption('The story beat, e.g. "hook", "product", "offer" — not the music beat.'),
    onScreen: caption("The copy visible in this panel; its words set the read time."),
    action: caption("What moves or happens."),
    camera: caption("Framing and camera move."),
    transition: caption("How it leaves for the next panel, and what motivates it."),
    audio: caption("Music cue, sound or voice-over."),
    notes: caption("Anything else for the person building it."),
    source: z.string().optional().describe("A node id in this file (a styleframe) to snapshot into the thumbnail. Not with `image`."),
    image: z.string().optional().describe("An imageHash already in this file to show in the thumbnail. Not with `source`."),
    styleframe: z.boolean().optional().describe("Also make an empty full-size frame for this panel beside the board; its id comes back as styleframeId."),
  })
  .strict();

export const STORYBOARD_SHAPE = {
  title: z.string().min(1).max(L.title).describe("The piece's name; the board is named Storyboard / <title>."),
  aspect: z.enum(ASPECTS).describe("Of every thumbnail and styleframe."),
  fps: z.number().int().min(L.fps[0]).max(L.fps[1]).optional().describe("Frame rate the frame numbers use. Default 30."),
  bpm: z.number().min(L.bpm[0]).max(L.bpm[1]).optional().describe("Tempo: adds bar.beat per panel and lists panels that start off the beat."),
  beatsPerBar: z.number().int().min(L.beatsPerBar[0]).max(L.beatsPerBar[1]).optional().describe("Default 4. Needs bpm."),
  panels: z.array(panelEntry).min(1).max(L.panels),
  captions: z
    .array(z.enum(CAPTIONS))
    .min(1)
    .max(CAPTIONS.length)
    .optional()
    .describe("Caption rows on every card, always in this order. Default: timecode, duration, and every row any panel fills."),
  columns: z.number().int().min(L.columns[0]).max(L.columns[1]).optional().describe("Cards per row. Default 6 (9:16), 5 (4:5, 1:1), 4 (16:9)."),
  thumbWidth: z.number().min(L.thumbWidth[0]).max(L.thumbWidth[1]).optional().describe("Thumbnail width in px; height follows the aspect. Default 216 / 288 / 300 / 384 by aspect."),
  styleframeWidth: z.number().min(L.styleframeWidth[0]).max(L.styleframeWidth[1]).optional().describe("Styleframe width in px. Default 1080 (1920 for 16:9)."),
  snap: z.enum(SNAPS).optional().describe('Round each duration to whole frames (default), whole beats (needs bpm), or not at all. Changes are listed in `snapped`.'),
  pageId: z.string().optional().describe("The page to build on, at its top level. Default: the current page."),
  x: z.number().optional().describe("Default: right of everything on the page."),
  y: z.number().optional(),
};

const DESCRIPTION =
  "Lay out a motion piece's storyboard before animating it: a board of cards in rows, one per panel, each a " +
  "thumbnail frame at `aspect` above caption rows (time, duration, story beat, on-screen copy, action, camera, " +
  "transition, audio, notes). Timing is derived from each panel's `durationS`, snapped to whole frames by default: " +
  "start and end in seconds and frames at `fps`, and bar.beat with `bpm`. The result lists panels that start off the " +
  "beat (`offBeat`) and copy on screen too briefly to read (`readTime`): fix both before building. A panel can " +
  "snapshot a frame of this file (`source`), show an image already in it (`image`), or get an empty full-size " +
  "styleframe beside the board (`styleframe`). Sketch into a thumbnail with figma_create_from_spec { parentId: " +
  "thumbId }. The duration caption is the plan: edit its text to retime a panel. A plan, not an animation: " +
  "figma_set_keyframes animates. Skill: storyboard (figma_get_guide). One undo step.";

/** The params as the plugin should see them: the plan checked, every panel `source` an id it can resolve. */
export function prepareStoryboard(args: Record<string, unknown>): Record<string, unknown> {
  planStoryboard(args);
  if (!Array.isArray(args.panels)) return args;
  // A pasted layer link or "12-34" becomes "12:34": forwardTool converts only
  // its known id keys, and `source` sits inside each panel.
  const panels = args.panels.map((p, i) => {
    const source = (p as { source?: unknown }).source;
    return typeof source === "string" ? { ...(p as object), source: toNodeId(source, `panels[${i}].source`).id } : p;
  });
  return { ...args, panels };
}

// ── figma_create_animatic ────────────────────────────────────────────────────

export const ANIMATIC_SHAPE = {
  storyboardId: z.string().min(1).describe("The board figma_create_storyboard returned (its storyboardId: the Storyboard / <title> frame), id or Figma link."),
  width: z
    .number()
    .min(ANIMATIC_LIMITS.width[0])
    .max(ANIMATIC_LIMITS.width[1])
    .optional()
    .describe("Plate width in px; the height follows the board's aspect. Default 1080 (1920 for 16:9)."),
  burnIn: z
    .enum(BURN_INS)
    .optional()
    .describe('"panel" (default): each plate\'s number and title in its corner; "full": also its time, frames and the beat, action, camera and transition captions; "none".'),
  dissolveFrames: z
    .number()
    .int()
    .min(ANIMATIC_LIMITS.dissolveFrames[0])
    .max(ANIMATIC_LIMITS.dissolveFrames[1])
    .optional()
    .describe('Frames of cross-fade out of a panel whose transition caption starts with "dissolve". Default 0: every change is a cut.'),
  drift: z.boolean().optional().describe("Push each plate's picture 3 % over its panel, so a held panel does not read as a freeze. Default false."),
  pageId: z.string().optional().describe("The page to build on, at its top level. Default: the board's page."),
  x: z.number().optional().describe("Default: right of everything on the page."),
  y: z.number().optional(),
};

const ANIMATIC_DESCRIPTION =
  "Play a storyboard back at its planned pace: turn a figma_create_storyboard board into an animatic, a top-level frame " +
  "`Animatic · <title>` with one plate per panel, each on screen on exactly the panel's frames, switched by frame-exact " +
  "OPACITY cut pairs. Timing is read from the board as it is now (each duration caption), at the board's fps. A plate " +
  "shows the panel's best picture: its styleframe once something is drawn in it, else its `source` rendered again, " +
  "else its thumbnail; `blank` lists panels with nothing yet. `dissolveFrames` cross-fades out of a panel whose " +
  "transition caption starts with \"dissolve\"; `drift` pushes each plate 3 %; `burnIn` labels plates. Every track " +
  "is read back (`verified`, else `notApplied`). The result's `render` is the figma_export_video call; then judge " +
  "the pace with figma_review_video. Plates 2–n rest at opacity 0, so figma_export_node shows panel 1. " +
  "Skill: storyboard (figma_get_guide). One undo step.";

/** The params as the plugin should see them: the options checked, the board an id it can resolve. */
export function prepareAnimatic(args: Record<string, unknown>): Record<string, unknown> {
  readAnimaticOptions(args);
  const id = args.storyboardId;
  // A pasted layer link or "12-34" becomes "12:34"; forwardTool converts only its known id keys.
  return typeof id === "string" ? { ...args, storyboardId: toNodeId(id, "storyboardId").id } : args;
}

function registerAnimatic(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  if (!wanted("create_animatic")) return;
  server.registerTool(
    "figma_create_animatic",
    {
      title: "Create an animatic",
      description: fitDescription(ANIMATIC_DESCRIPTION),
      inputSchema: { ...ANIMATIC_SHAPE, ...WRITE_PARAMS },
      annotations: writeAnnotations("create_animatic"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      let params: Record<string, unknown>;
      try {
        params = prepareAnimatic(args);
      } catch (err) {
        // Refused here, before the bridge was asked: nothing changed, a retry is safe [C-096].
        return errorResult(err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err, { unchanged: true });
      }
      return forwardTool(bridge, "create_animatic", params, extra, {
        session: args.session as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      });
    },
  );
}

/** Registers figma_create_storyboard and, after it, figma_create_animatic: each only when the toolset wants it. */
export function registerStoryboard(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  registerStoryboardTool(server, bridge, wanted);
  registerAnimatic(server, bridge, wanted);
}

function registerStoryboardTool(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  if (!wanted("create_storyboard")) return;
  server.registerTool(
    "figma_create_storyboard",
    {
      title: "Create a storyboard",
      description: fitDescription(DESCRIPTION),
      inputSchema: { ...STORYBOARD_SHAPE, ...WRITE_PARAMS },
      annotations: writeAnnotations("create_storyboard"),
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      let params: Record<string, unknown>;
      try {
        params = prepareStoryboard(args);
      } catch (err) {
        // Refused here, before the bridge was asked: nothing changed, a retry is safe [C-096].
        return errorResult(err instanceof BridgeError && args.idempotencyKey ? err.withKey(args.idempotencyKey as string) : err, { unchanged: true });
      }
      return forwardTool(bridge, "create_storyboard", params, extra, {
        session: args.session as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      });
    },
  );
}
