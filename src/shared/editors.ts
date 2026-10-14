// The editor table: which ops run in Figma Design, FigJam and Figma Slides
// files, and the words a refusal uses when one does not [C-129].
//
// One explicit row per op in OPS (ops.ts imports nothing from here, so there is
// no cycle), and test/editor-gate.test.ts fails on an op without a row: deny by
// default, so a new op cannot ship without a decision for each editor. The same
// test pins docs/reference/tools.md § Editor support to these cells.
//
// A cell is
//   "yes"        runs;
//   "no"         refused for every call — only where the typings and Figma's
//                own pages agree it cannot run there [C-133] [C-134];
//   "unmeasured" not verified yet: reads run, writes are refused at the bridge
//                unless BRIDGE_ALLOW_UNVERIFIED lets a measuring run through.
// A contradicted fact maps to "unmeasured", never to "no", so a contradiction
// is never a load-bearer (AGENTS.md). A cell turns "yes" only from a result
// recorded under spikes/results/; set_motion_plan's row says why it is the
// one exception.
//
// The same function refuses at two layers: the bridge (authoritative; every MCP
// client reaches the plugin through it) and the plugin (a backstop for an older
// hub build, "no" cells only). No runtime dependencies: the plugin bundles it.

import { OPS, toolName } from "./ops.js";
import { PRODUCT_NAME } from "./version.js";

export const EDITORS = ["figma", "figjam", "slides"] as const;
export type Editor = (typeof EDITORS)[number];
export type Support = "yes" | "no" | "unmeasured";

export const EDITOR_LABEL: Record<Editor, string> = { figma: "Figma Design", figjam: "FigJam", slides: "Figma Slides" };
export const SHORT_LABEL: Record<Editor, string> = { figma: "Design", figjam: "FigJam", slides: "Slides" };

export interface EditorRow {
  figma: Support;
  figjam: Support;
  slides: Support;
  /** Why a "no" cell cannot run — the second sentence of its refusal. */
  why?: string;
  /** What to do instead, per editor — the hint's "In FigJam: …" sentence. */
  instead?: Partial<Record<Editor, string>>;
}

const U = "unmeasured";
const row = (figma: Support, figjam: Support, slides: Support, more: Pick<EditorRow, "why" | "instead"> = {}): EditorRow => ({
  figma,
  figjam,
  slides,
  ...more,
});
/** Its code touches nothing editor-specific, or the bridge answers it: runs in every editor. */
const everywhere = (): EditorRow => row("yes", "yes", "yes");
/** Verified on the Design canvas only; FigJam and Slides wait for a spike. */
const designOnlySoFar = (): EditorRow => row("yes", U, U);

const STYLES_WHY = "The Plugin API creates local styles only in Figma Design files.";
const COMPONENTS_WHY = "The Plugin API creates components and variants only in Figma Design files.";
// getTopLevelFrame "will throw an error if called in FigJam or Slides", and video
// export is "only available when running in Figma" (plugin-api.d.ts:6459, 9047).
const MOTION_WHY = "Keyframe motion is read from a layer's top-level frame, and the Plugin API finds one only in Figma Design files.";
const VIDEO_WHY = "The Plugin API exports video only in Figma Design files.";
const STILL = "export a still image with figma_export_node";
// createSticky, createConnector, createCodeBlock and createLinkPreviewAsync are
// "only available in FigJam" in the typings and in Working in FigJam / Slides
// [C-132] [C-134]. createShapeWithText and createTable say the same in the
// typings, but Working in Slides lists both as supported [C-137]: their Slides
// cells stay unmeasured and their reason names Design alone.
const BOARD_WHY = (what: string) => `The Plugin API creates ${what} only in FigJam files.`;
const NOT_IN_DESIGN = (what: string) => `The Plugin API does not create ${what} in Figma Design files.`;
const ON_A_SLIDE = "build it on a slide with figma_create_from_spec";
// createSlide, createSlideRow and the slide grid are "only available in Figma Slides" [C-134].
const SLIDES_WHY = "Slides and the slide grid exist only in Figma Slides files.";
const FRAMES = "lay frames out with figma_create_frame";

export const EDITOR_SUPPORT: Readonly<Record<string, EditorRow>> = {
  // meta — status and the guide are answered by the bridge; the rest move the view.
  status: everywhere(),
  get_guide: everywhere(),
  select: everywhere(),
  navigate_page: everywhere(),
  zoom_to: everywhere(),
  // read
  get_metadata: everywhere(),
  get_design_context: everywhere(),
  get_node: everywhere(),
  get_selection: everywhere(),
  get_nodes_info: everywhere(),
  get_variable_defs: designOnlySoFar(),
  get_styles: designOnlySoFar(),
  get_local_components: designOnlySoFar(),
  get_fonts: everywhere(),
  search_nodes: everywhere(),
  scan_nodes_by_types: everywhere(),
  scan_text_nodes: everywhere(),
  get_pages: everywhere(),
  get_annotations: designOnlySoFar(),
  get_reactions: designOnlySoFar(),
  suggest_fonts: everywhere(),
  check_layout: everywhere(),
  get_library_variables: designOnlySoFar(),
  get_component: designOnlySoFar(),
  get_motion_context: row("yes", "no", "no", { why: MOTION_WHY }),
  // A read, so it runs; Design turns yes from spikes/results/live-check-motion.json.
  check_motion: row(U, "no", "no", { why: MOTION_WHY }),
  get_slide_grid: row("no", "no", "yes", {
    why: SLIDES_WHY,
    instead: { figma: "read the page with figma_get_metadata", figjam: "read the board with figma_get_metadata" },
  }),
  // create — createPage in FigJam [C-142] and createSection in Slides [C-137] are contradicted, so unmeasured.
  create_from_spec: designOnlySoFar(),
  create_frame: designOnlySoFar(),
  create_text: designOnlySoFar(),
  create_rectangle: designOnlySoFar(),
  create_ellipse: designOnlySoFar(),
  create_line: designOnlySoFar(),
  create_polygon: designOnlySoFar(),
  create_star: designOnlySoFar(),
  create_vector: designOnlySoFar(),
  create_section: designOnlySoFar(),
  create_page: designOnlySoFar(),
  create_instance: designOnlySoFar(),
  convert_to_component: row("yes", "no", U, { why: COMPONENTS_WHY }),
  combine_as_variants: row("yes", "no", U, { why: COMPONENTS_WHY }),
  create_variable_collection: designOnlySoFar(),
  create_variable: designOnlySoFar(),
  create_paint_style: row("yes", "no", "no", { why: STYLES_WHY }),
  create_text_style: row("yes", "no", "no", { why: STYLES_WHY }),
  create_effect_style: row("yes", "no", "no", { why: STYLES_WHY }),
  import_svg: designOnlySoFar(),
  import_image: designOnlySoFar(),
  create_variables: designOnlySoFar(),
  create_grid_style: row("yes", "no", "no", { why: STYLES_WHY }),
  import_library_assets: designOnlySoFar(),
  create_slot: designOnlySoFar(),
  // FigJam board tools: unmeasured on a board until spikes/live-figjam.mjs records them.
  create_stickies: row("no", U, "no", {
    why: BOARD_WHY("stickies"),
    instead: { figma: "build a card with figma_create_from_spec", slides: ON_A_SLIDE },
  }),
  create_shapes_with_text: row("no", U, U, {
    why: NOT_IN_DESIGN("shapes with text"),
    instead: { figma: "build the shape and its label with figma_create_from_spec" },
  }),
  create_connectors: row("no", U, "no", {
    why: BOARD_WHY("connectors"),
    instead: { figma: "draw lines with figma_create_line or figma_create_vector", slides: "draw lines with figma_create_line" },
  }),
  create_table: row("no", U, U, {
    why: NOT_IN_DESIGN("tables"),
    instead: { figma: "lay rows and columns out with figma_create_from_spec" },
  }),
  create_code_block: row("no", U, "no", {
    why: BOARD_WHY("code blocks"),
    instead: { figma: "set the code as text with figma_create_text", slides: "set the code as text with figma_create_text" },
  }),
  create_link_preview: row("no", U, "no", {
    why: BOARD_WHY("link previews"),
    instead: { figma: "put the link in a text layer with figma_create_text", slides: "put the link in a text layer with figma_create_text" },
  }),
  create_slides: row("no", "no", U, { why: SLIDES_WHY, instead: { figma: FRAMES, figjam: "group content with figma_create_section" } }),
  // Design: yes from spikes/results/live-storyboard.json (2026-10-13, 14 of 14
  // probes). Boards and decks stay unmeasured: its snapshots go through
  // createImage, which is unknown there [C-150].
  create_storyboard: row("yes", U, U),
  // Unmeasured in Design until spikes/results/live-animatic.json; Motion is Design-only [C-115].
  create_animatic: row(U, "no", "no", { why: MOTION_WHY, instead: { figjam: STILL, slides: STILL } }),
  // modify
  set_text: designOnlySoFar(),
  set_text_properties: designOnlySoFar(),
  set_text_range: designOnlySoFar(),
  find_replace_text: designOnlySoFar(),
  rename_node: designOnlySoFar(),
  batch_rename_nodes: designOnlySoFar(),
  move_nodes: designOnlySoFar(),
  resize_nodes: designOnlySoFar(),
  rotate_nodes: designOnlySoFar(),
  reorder_nodes: designOnlySoFar(),
  reparent_nodes: designOnlySoFar(),
  clone_node: designOnlySoFar(),
  delete_nodes: designOnlySoFar(),
  group_nodes: designOnlySoFar(),
  ungroup_nodes: designOnlySoFar(),
  boolean_nodes: designOnlySoFar(),
  flatten_nodes: designOnlySoFar(),
  set_mask: designOnlySoFar(),
  set_visible: designOnlySoFar(),
  set_locked: designOnlySoFar(),
  set_opacity: designOnlySoFar(),
  set_auto_layout: designOnlySoFar(),
  set_constraints: designOnlySoFar(),
  swap_component: designOnlySoFar(),
  detach_instance: designOnlySoFar(),
  add_component_property: designOnlySoFar(),
  set_instance_properties: designOnlySoFar(),
  add_variable_mode: designOnlySoFar(),
  set_variable_value: designOnlySoFar(),
  delete_variable: designOnlySoFar(),
  delete_variable_collection: designOnlySoFar(),
  delete_style: designOnlySoFar(),
  // triggerUndo's reach in FigJam and Slides is unmeasured [C-151].
  undo_step: designOnlySoFar(),
  set_clips_content: designOnlySoFar(),
  // A batch does nothing of its own: the gate checks each of its steps instead.
  batch: everywhere(),
  set_variable_properties: designOnlySoFar(),
  update_variable_collection: designOnlySoFar(),
  edit_component_property: designOnlySoFar(),
  delete_component_property: designOnlySoFar(),
  reset_slot: designOnlySoFar(),
  edit_table: row("no", U, U, { why: NOT_IN_DESIGN("tables") }),
  edit_connectors: row("no", U, "no", { why: BOARD_WHY("connectors") }),
  // Applies FigJam node properties per type; in Design the paints are figma_set_fills / figma_set_strokes.
  set_board_properties: row("no", U, U, {
    why: "Its properties belong to FigJam node types (stickies, shapes with text, connectors, code blocks).",
    instead: { figma: "colour layers with figma_set_fills and figma_set_strokes" },
  }),
  // Sections exist in Design and FigJam; whether a deck takes them is contradicted [C-137]. No editor measured yet.
  fit_sections: row(U, U, U),
  set_slide_grid: row("no", "no", U, { why: SLIDES_WHY }),
  move_slides: row("no", "no", U, { why: SLIDES_WHY, instead: { figma: "move frames with figma_move_nodes" } }),
  set_slide_properties: row("no", "no", U, { why: SLIDES_WHY }),
  // style
  set_fills: designOnlySoFar(),
  set_strokes: designOnlySoFar(),
  set_corner_radius: designOnlySoFar(),
  set_effects: designOnlySoFar(),
  set_blend_mode: designOnlySoFar(),
  set_layout_grids: designOnlySoFar(),
  apply_style_to_node: designOnlySoFar(),
  bind_variable_to_node: designOnlySoFar(),
  set_reactions: designOnlySoFar(),
  remove_reactions: designOnlySoFar(),
  set_variable_mode: designOnlySoFar(),
  update_style: designOnlySoFar(),
  set_description: designOnlySoFar(),
  set_keyframes: designOnlySoFar(),
  remove_keyframes: designOnlySoFar(),
  set_scroll_behavior: designOnlySoFar(),
  set_prototype_flows: designOnlySoFar(),
  // The sources disagree whether transitions run at all [C-139]: unmeasured until spikes/live-slides.mjs records them.
  set_slide_transition: row("no", "no", U, {
    why: SLIDES_WHY,
    instead: { figma: "animate between frames with figma_set_reactions" },
  }),
  // Design: yes ahead of its own live run, the one exception to "a cell turns
  // yes only from a recorded result" (spec ADR #35, #41). Its one Plugin API
  // call, setSharedPluginData on a frame, and the read-back are what
  // spikes/results/live-storyboard.json measured for the storyboard record
  // [C-188], but not on an animated frame; and as unmeasured it would refuse
  // every keyframe write under the default BRIDGE_PROCESS=strict. The run is
  // listed in docs/reference/roadmap.md § Next steps. A plan exists for
  // keyframes, which run in Design only.
  set_motion_plan: row("yes", "no", "no", { why: MOTION_WHY }),
  // export
  export_node: everywhere(),
  save_screenshots: everywhere(),
  export_frames_to_pdf: everywhere(),
  download_assets: everywhere(),
  export_video: row("yes", "no", "no", {
    why: VIDEO_WHY,
    instead: { figjam: STILL, slides: `${STILL}, or the deck as a PDF with figma_export_frames_to_pdf` },
  }),
  // Reads a video file on disk; Figma is never asked.
  review_video: everywhere(),
  // Read and write audio files on disk. generate_audio { nodeId } reads the frame through
  // check_motion's op, and the gate judges that op by its own row.
  analyze_audio: everywhere(),
  add_audio: everywhere(),
  generate_audio: everywhere(),
  // eval — two-key opt-in; the script, not this code, decides what it touches.
  eval: everywhere(),
};

/** Deny by default: an op with no row is unmeasured everywhere — reads run, writes wait. */
const NO_ROW: EditorRow = row(U, U, U);

export function isEditor(value: unknown): value is Editor {
  return typeof value === "string" && (EDITORS as readonly string[]).includes(value);
}

export function rowOf(op: string): EditorRow {
  return EDITOR_SUPPORT[op] ?? NO_ROW;
}

/** The cell for `op` in `editorType`; "unknown-editor" for dev, buzz, or a plugin that sent none. */
export function supportOf(op: string, editorType: string | undefined): Support | "unknown-editor" {
  return isEditor(editorType) ? rowOf(op)[editorType] : "unknown-editor";
}

export type GateLayer = "bridge" | "plugin";

export interface GateOptions {
  /** BRIDGE_ALLOW_UNVERIFIED for this call: lets an "unmeasured" write through, never a "no". */
  allowUnverified: boolean;
  layer: GateLayer;
  /** The session the call would run in, named in the message. */
  session?: { sessionId: string; file: string | null };
  /** The other connected files, so the hint can name one where the op runs. */
  others?: ReadonlyArray<{ sessionId: string; file: string | null; editorType: string }>;
}

type Verdict = "no" | "unmeasured" | "unknown-editor" | null;

/**
 * Why `op` may not run in `editorType` at this layer, or null when it may.
 * Ops answered by the bridge and ops outside the catalog are never gated (the
 * bridge's own "too old" check meets the latter). The plugin layer refuses only
 * "no" cells: whether an unmeasured write may run is the bridge's call, which
 * knows the flag, and an unknown editor is the bridge's to name.
 */
function verdict(op: string, editorType: string | undefined, allowUnverified: boolean, layer: GateLayer): Verdict {
  const info = OPS.get(op);
  if (!info || info.bridgeOnly) return null;
  const cell = supportOf(op, editorType);
  if (cell === "unknown-editor") return layer === "bridge" ? cell : null;
  if (cell === "no") return "no";
  if (cell === U && layer === "bridge" && info.write && !allowUnverified) return U;
  return null;
}

/** Whether `op` runs in `editorType` under these options. */
export function runsIn(op: string, editorType: string | undefined, opts: Pick<GateOptions, "allowUnverified" | "layer">): boolean {
  return verdict(op, editorType, opts.allowUnverified, opts.layer) === null;
}

function fileLabel(f: { sessionId: string; file: string | null }): string {
  return f.file ?? f.sessionId;
}

/**
 * The refusal for `op` in `editorType`, or null when it runs. Exact texts:
 *   no          `figma_create_paint_style does not run in FigJam files (session s-4, "Retro board"). <why>`
 *   unmeasured  `figma_set_fills has not been verified in FigJam files yet, so Figxel refuses its writes there (…).`
 *   unknown     `figma_x cannot run here: the plugin reports editorType "dev"; Figxel runs in …`
 * The hint says where it runs, what to use instead, and which connected file
 * runs it (pass `session`), else which kind of file to open.
 */
export function editorRefusal(op: string, editorType: string | undefined, opts: GateOptions): { message: string; hint: string } | null {
  const v = verdict(op, editorType, opts.allowUnverified, opts.layer);
  if (v === null) return null;
  const tool = toolName(op);
  if (v === "unknown-editor") {
    return {
      message:
        `${tool} cannot run here: the plugin reports editorType "${editorType ?? "none"}"; ` +
        `${PRODUCT_NAME} runs in ${EDITOR_LABEL.figma}, ${EDITOR_LABEL.figjam} and ${EDITOR_LABEL.slides} files.`,
      hint: "Open one of those files and run the plugin there.",
    };
  }
  const editor = editorType as Editor;
  const r = rowOf(op);
  const where = opts.session ? ` (session ${opts.session.sessionId}, "${opts.session.file ?? "untitled"}")` : "";
  const message =
    v === "no"
      ? `${tool} does not run in ${EDITOR_LABEL[editor]} files${where}.${r.why ? ` ${r.why}` : ""}`
      : `${tool} has not been verified in ${EDITOR_LABEL[editor]} files yet, so ${PRODUCT_NAME} refuses its writes there${where}.`;

  const verified = EDITORS.filter((e) => r[e] === "yes");
  const hint: string[] = [verified.length ? `Runs in: ${verified.map((e) => EDITOR_LABEL[e]).join(", ")}.` : "Not verified in any editor yet."];
  const instead = r.instead?.[editor];
  if (instead) hint.push(`In ${EDITOR_LABEL[editor]}: ${instead}.`);
  const elsewhere = (opts.others ?? []).filter((o) => isEditor(o.editorType) && verdict(op, o.editorType, opts.allowUnverified, "bridge") === null);
  if (elsewhere.length) {
    const named = elsewhere.map((o) => `"${fileLabel(o)}" (${EDITOR_LABEL[o.editorType as Editor]}, ${o.sessionId})`).join(", ");
    hint.push(`Connected files where it runs: ${named} — pass session: "${fileLabel(elsewhere[0]!)}".`);
  } else if (verified.length) {
    hint.push(`Open a ${EDITOR_LABEL[verified[0]!]} file and run the plugin there.`);
  }
  return { message, hint: hint.join(" ") };
}

/**
 * The ops a batch's `steps` name, prefix stripped, or null when `steps` is not
 * a readable list (the plugin then refuses it, naming the field). Steps arrive
 * parsed from the server, or as the JSON string a raw caller sends.
 */
export function stepOps(steps: unknown): string[] | null {
  let list = steps;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  return list.map((s) => {
    const op = (s as { op?: unknown } | null)?.op;
    return typeof op === "string" ? op.trim().replace(/^figma_/, "") : "";
  });
}

/**
 * editorRefusal for a whole call: a batch is refused whole, before any step
 * runs, at the first step that may not run, its message prefixed `steps[i]: `.
 */
export function callRefusal(op: string, params: Record<string, unknown>, editorType: string | undefined, opts: GateOptions): { message: string; hint: string } | null {
  const own = editorRefusal(op, editorType, opts);
  if (own || op !== "batch") return own;
  const ops = stepOps(params.steps) ?? [];
  for (let i = 0; i < ops.length; i++) {
    const others = opts.others?.filter((o) => ops.every((s) => verdict(s, o.editorType, opts.allowUnverified, "bridge") === null));
    const step = editorRefusal(ops[i]!, editorType, { ...opts, ...(others ? { others } : {}) });
    if (step) return { message: `steps[${i}]: ${step.message}`, hint: step.hint };
  }
  return null;
}

/**
 * The sentence appended to a tool description: "" when the op runs everywhere,
 * else " Editors: Design only.", " Editors: Design; unverified: FigJam, Slides.",
 * " Editors: FigJam only, unverified." and so on.
 */
export function editorsSuffix(op: string): string {
  const r = rowOf(op);
  const yes = EDITORS.filter((e) => r[e] === "yes").map((e) => SHORT_LABEL[e]);
  const unverified = EDITORS.filter((e) => r[e] === U).map((e) => SHORT_LABEL[e]);
  if (yes.length === EDITORS.length) return "";
  if (!yes.length) {
    const only = unverified.length === 1 && EDITORS.some((e) => r[e] === "no");
    return only ? ` Editors: ${unverified[0]} only, unverified.` : ` Editors: unverified in ${unverified.join(", ")}.`;
  }
  if (!unverified.length) return yes.length === 1 ? ` Editors: ${yes[0]} only.` : ` Editors: ${yes.join(", ")}.`;
  return ` Editors: ${yes.join(", ")}; unverified: ${unverified.join(", ")}.`;
}

/** The tools refused at the bridge in `editor` (for figma_status): every "no", and unmeasured writes unless allowed. */
export function refusedTools(editor: Editor, allowUnverified: boolean): string[] {
  return [...OPS.keys()].filter((op) => verdict(op, editor, allowUnverified, "bridge") !== null).map(toolName);
}

/** The tools whose cell in `editor` is "unmeasured", reads included (they run, unverified). */
export function unverifiedTools(editor: Editor): string[] {
  return [...OPS.keys()].filter((op) => !OPS.get(op)!.bridgeOnly && rowOf(op)[editor] === U).map(toolName);
}
