// The MCP prompts: one table row per entry point, each composed from the skills.
//
// A prompt is a starting message the user picks from the client's menu
// (Claude Desktop's attachment menu, Claude Code's slash list) [C-168]. Its
// message is the row's preamble, the skill's SKILL.md body, at most one
// section, and a closing line with the calls for the rest — the same bytes
// figma_get_guide serves, so a prompt cannot drift from the guide [C-237].
//
// MCP prompt arguments are strings, so every argument is one — a list such as
// clientLanguages travels comma-separated, as the official
// create_design_system_rules prompt takes it. Claude Code splits a typed line
// on whitespace across the arguments [C-176], so a preamble must read well with
// any argument missing or cut short.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG_TOPIC, sectionBySlug, skillByShort, type Skill, type SkillSection } from "./skills.js";

export interface PromptArg {
  name: string;
  description: string;
  /** Kept only where an existing prompt already required it; new prompts take every argument as optional. */
  required?: boolean;
}

export type PromptArgs = Readonly<Record<string, string | undefined>>;

export interface PromptRow {
  name: string;
  title: string;
  description: string;
  /** In order: a client that fills arguments from a typed line fills them in this order. */
  args: readonly PromptArg[];
  /**
   * Adds the optional `checkpoint` argument after `args`: "storyboard" stops
   * the work for the user's approval once the plan exists (the decision line
   * and styleframes; for motion, the storyboard and the probe); "none" (the
   * default) runs to the end, as an owned brief does.
   */
  checkpoint?: boolean;
  /** The skill whose SKILL.md body the message carries (a short name). */
  skill: string;
  /**
   * At most one section, from any skill (section slugs are unique across the
   * tree) — or chosen from the arguments, e.g. a critique's motion checks when
   * its `lens` names a motion lens. A function is checked at registration with
   * no arguments, and again on every call.
   */
  section?: string | ((args: PromptArgs) => string | undefined);
  preamble: (args: PromptArgs) => string;
}

export const CHECKPOINT_VALUES = ["storyboard", "none"] as const;
export type Checkpoint = (typeof CHECKPOINT_VALUES)[number];

const CHECKPOINT_ARG: PromptArg = {
  name: "checkpoint",
  description: '"storyboard" to stop for approval once the plan exists (decision line and styleframes; for motion, the storyboard too); "none" (default) to run to the end.',
};

/**
 * Read the checkpoint argument. Not refused when unrecognised: a client that
 * splits the typed line on whitespace can land a word of the brief here
 * [C-176], so the word is handed to the agent instead of failing the prompt or
 * vanishing.
 */
export function readCheckpoint(raw: string | undefined): { checkpoint: Checkpoint; stray?: string } {
  const v = (raw ?? "").trim();
  const lower = v.toLowerCase();
  if (lower === "" || lower === "none") return { checkpoint: "none" };
  if (lower === "storyboard") return { checkpoint: "storyboard" };
  return { checkpoint: "none", stray: v };
}

function checkpointText(raw: string | undefined): string {
  const { checkpoint, stray } = readCheckpoint(raw);
  if (checkpoint === "storyboard") {
    return (
      "\n\nCheckpoint: stop once the plan can be shown — the decision line with the styleframes the gear builds (at " +
      "the section gear, the direction cards), and for a motion piece the storyboard and the technical probe too — show " +
      "them to me with where they are, and wait for my approval before building."
    );
  }
  if (stray !== undefined) {
    return `\n\nThe checkpoint argument read "${stray}", which is neither "storyboard" nor "none", so there is no checkpoint; if those words belong to the brief, read them as part of it.`;
  }
  return "";
}

/** The skill and the section a row carries; a row naming either wrongly fails at registration, not in a user's prompt. */
function partsOf(row: PromptRow, args: PromptArgs = {}): { skill: Skill; section?: { skill: Skill; section: SkillSection } } {
  const skill = skillByShort(row.skill);
  if (!skill) throw new Error(`prompt ${row.name}: no skill "${row.skill}" in src/skills`);
  const slug = typeof row.section === "function" ? row.section(args) : row.section;
  if (slug === undefined) return { skill };
  const section = sectionBySlug(slug);
  if (!section) throw new Error(`prompt ${row.name}: no section "${slug}" in src/skills`);
  return { skill, section };
}

/** "Fetch the rest" — this skill's sections the message does not carry, as exact calls. */
function closing(skill: Skill, carried?: SkillSection): string {
  const rest = skill.sections.filter((s) => s !== carried).map((s) => `figma_get_guide { topic: "${skill.short}", section: "${s.slug}" }`);
  return [
    "---",
    ...(rest.length ? [`Fetch the other sections of the ${skill.short} skill when a step needs them: ${rest.join("; ")}.`] : []),
    `Every skill and its sections: figma_get_guide { topic: "${CATALOG_TOPIC}" }.`,
  ].join("\n");
}

/** The message a row composes for these arguments. */
export function promptText(row: PromptRow, args: PromptArgs): string {
  const { skill, section } = partsOf(row, args);
  return (
    row.preamble(args) +
    (row.checkpoint ? checkpointText(args.checkpoint) : "") +
    `\n\n${skill.body}` +
    (section ? `\n\n${section.section.body}` : "") +
    `\n\n${closing(skill, section?.section)}`
  );
}

const has = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/**
 * A lens of the critique skill's motion set: motion craft, design and type,
 * technical QA, the brief's own lens. Matched on a word, since a client that splits the typed line on
 * whitespace may pass only "motion" or "technical" [C-176]; "finish QA" and
 * "type and composition" are still lenses, so "qa" and "type" alone are not.
 */
export function isMotionLens(lens: string | undefined): boolean {
  return has(lens) && /\b(motion|technical|animat\w*|video|brief)\b|\bdesign and type\b/i.test(lens);
}

/** The prompts. The integrator adds rows; each needs only data and a preamble. */
export const PROMPTS: readonly PromptRow[] = [
  {
    name: "build_in_figma",
    title: "Build in Figma, section by section",
    description: "Design something complete in the open Figma file from a short brief — the agent owns the decisions, builds a section per call and checks each one.",
    args: [{ name: "brief", description: "What to design, e.g. \"a pricing section with three plans\".", required: true }],
    skill: "workflow",
    section: "build",
    preamble: ({ brief }) =>
      `Design this in the open Figma file: ${brief}\n\n` +
      "Own the brief: make the design decisions yourself and deliver a finished design without asking me step " +
      "by step — use realistic placeholder content where facts are missing and list it at the end. Build one " +
      "section per tool call and check each section; do not send the whole page as one payload. State the gear " +
      "first: a section runs the design skill's section gear (a three-line brief, two directions, one critique " +
      'round); for a page or more, follow the design skill instead: figma_get_guide { topic: "design" }.',
  },
  {
    name: "design_in_figma",
    title: "Design in Figma, from brief to sign-off",
    description: "Design a page, screen, poster or campaign piece the way a senior designer does: a brief, two or three directions, styleframes, a system, the build, and measured critique rounds.",
    args: [{ name: "brief", description: 'What to design, e.g. "a landing page for a bike repair co-op".' }],
    checkpoint: true,
    skill: "design",
    section: "brief",
    preamble: ({ brief }) =>
      `Design this in the open Figma file: ${has(brief) ? brief.trim() : "what I asked for in this conversation"}.\n\n` +
      "Own the brief: state the gear first, then follow the design skill below, making every decision yourself " +
      "without asking me step by step. Use realistic placeholder content where facts are missing and list it at the end.",
  },
  {
    name: "storyboard_motion",
    title: "Storyboard and build a motion piece",
    description: "Plan a motion piece (an ad, a reel, a title, an animated end card) before animating it: brief, directions, beat sheet, storyboard, styleframes, animatic and build bible; then build and review it.",
    args: [
      { name: "brief", description: 'What the piece must say, and to whom, e.g. "a 6-second end card for a running app".' },
      { name: "duration", description: 'The length in seconds, e.g. "6".' },
      { name: "placement", description: 'Where it runs, e.g. "Instagram Story"; its safe zones come from that placement\'s current spec.' },
    ],
    checkpoint: true,
    skill: "storyboard",
    section: "beat-sheet",
    preamble: ({ brief, duration, placement }) =>
      `Plan and build this motion piece in the open Figma file: ${has(brief) ? brief.trim() : "what I asked for in this conversation"}.` +
      (has(duration) ? `\nLength: ${/^\d+(\.\d+)?$/.test(duration.trim()) ? `${duration.trim()} s` : duration.trim()}.` : "") +
      (has(placement)
        ? `\nPlacement: ${placement.trim()}. Read that placement's current spec for its safe zones and delivery format, and write each figure down with its source and date; if you cannot read it, follow the skill's branch for unverified zones.`
        : "") +
      "\n\nWork as a senior motion graphic designer who owns the brief: follow the storyboard skill below through the " +
      "build bible, then store the plan on the piece's frame with figma_set_motion_plan before the first keyframe (the " +
      "keyframe tools refuse a frame without one). Build with the motion skill, pass figma_check_motion, review the " +
      "previews with the critique skill, and render the delivery with figma_export_video { final: true }. Decide " +
      "without asking me step by step; use realistic placeholder content where facts are missing and list it at the end.",
  },
  {
    name: "animate_in_figma",
    title: "Animate in Figma",
    description: "Animate layers on a Figma frame's timeline as a senior motion designer: pick the gear, plan the beats, block the poses, shape the curves, polish, and check every frame before the final render.",
    args: [
      { name: "nodeId", description: "The layer or top-level frame to animate — an id or a Figma link. Default: the selection." },
      { name: "brief", description: 'What the motion should do or say, e.g. "the switch turning on".' },
    ],
    checkpoint: true,
    skill: "motion",
    section: "easing",
    preamble: ({ nodeId, brief }) =>
      `Animate ${has(nodeId) ? `the Figma node ${nodeId.trim()}` : "the selected layers"} in the open Figma file` +
      (has(brief) ? `: ${brief.trim()}.` : ", as I asked in this conversation.") +
      "\n\nWork as a senior motion graphic designer who owns the brief. Pick the gear and say it first, then run its " +
      "stages in order: brief; the plan, stored with figma_set_motion_plan before the first keyframe (the keyframe " +
      "tools refuse a frame without one); styleframes; blocking on the beats; splining; polish; figma_check_motion " +
      "until ok: true; a preview render judged with figma_review_video; then the delivery with figma_export_video " +
      "{ final: true }. UI micro-motion stays light: the product's own duration and curve tokens, a one-beat plan and " +
      "one check. A piece longer than about 2 s is planned with the storyboard skill first. Own the decisions.",
  },
  {
    name: "critique_design",
    title: "Critique a design or motion piece",
    description: "Review a Figma design or motion piece like a panel of senior critics: measured findings lens by lens, fixes as tool calls, and rounds until the sign-off bar.",
    args: [
      { name: "nodeId", description: "The design or animated frame to review — an id or a Figma link. Default: the selection." },
      {
        name: "lens",
        description:
          'One lens, or "all" (default). Still: message, type and composition, colour and imagery, copy, originality, finish QA. Motion: motion craft, design and type, technical QA, the brief\'s own lens.',
      },
    ],
    skill: "critique",
    section: ({ lens }) => (isMotionLens(lens) ? "motion-checks" : "lenses"),
    preamble: ({ nodeId, lens }) => {
      const target = has(nodeId) ? `the Figma node ${nodeId.trim()}` : "the selected design";
      const one = has(lens) && lens.trim().toLowerCase() !== "all";
      return (
        `Critique ${target} in the open Figma file with ${one ? `the ${lens!.trim()} lens` : "every lens its gear calls for"}, ` +
        "following the critique skill below. Measure before you judge, write every finding in its schema, then fix " +
        "and re-check in rounds until the sign-off bar or the third round." +
        // No lens named: the message carries the still checklists, so a motion piece is pointed at its own.
        (one
          ? ""
          : ' If it is a motion piece, run the motion lenses with their checklist: figma_get_guide { topic: "critique", section: "motion-checks" }.')
      );
    },
  },
  {
    // A judging seat (base workflow §2, decisions §10.1): isolation by context, declared and recorded. Its section
    // is always `lenses`, where message and originality live; motion's own checklist is a call away, since the
    // motion-checks section would take the message past the 16,000-byte budget.
    name: "critique_cold",
    title: "Review a design cold, from a fresh context",
    description:
      "Score the message and originality of a Figma design as a reviewer who did not build it: from the brief, its references and the renders only, the verdict before the numbers, nothing written to the canvas.",
    args: [
      { name: "nodeId", description: "The work to review, or its brief: a node id, a brief id or a Figma link. Default: the selection." },
      {
        name: "lenses",
        description: 'Comma-separated lenses. Default: those the gear gives a cold reviewer, message and originality (a brand: positioning; a deck: story; icons: recognition; motion: the brief\'s own lens).',
      },
    ],
    skill: "critique",
    section: "lenses",
    preamble: ({ nodeId, lenses }) => {
      const target = has(nodeId) ? `the Figma node ${nodeId.trim()}` : "the selected design";
      const named = has(lenses) && lenses.trim().toLowerCase() !== "all" ? lenses.trim() : undefined;
      return (
        `Review ${target} cold, as a reviewer who did not build it, with ` +
        (named
          ? `these lenses: ${named}.`
          : "the lenses its gear gives a cold reviewer: message and originality, or the role's own lens for what the work " +
            "says (brand: positioning; deck: story; icons: recognition; motion: the brief's own lens, with " +
            'figma_get_guide { topic: "critique", section: "motion-checks" }).') +
        "\n\nRun in a fresh context: a subagent or a new conversation that saw nothing of the build. If this one holds " +
        'the build (its calls, notes or reasoning), say so first and mark every score reviewer: "self".\n\n' +
        `1. Read only: figma_get_brief { nodeId: ${has(nodeId) ? `"${nodeId.trim()}"` : "<the selection>"} } (the brief, ` +
        "its references, its deliverables); the references it names (render a board of them too); figma_export_node { nodeId } " +
        "for each deliverable, and the squint at maxSize the long side ÷ 8. Nothing from the build: no notes, critiques " +
        "or check results.\n" +
        "2. In your reply, before any check: the cold read (the reading order, first to third, and the one-sentence " +
        "takeaway), then each lens's verdict, score 1–10 and findings, in the schema below.\n" +
        '3. Only then figma_check_layout { nodeId, audit: ["craft", "tells"] }: merge its numbers in and say what each ' +
        "missed, the numbers and your eye. Move a score only for a finding.\n" +
        "4. Never write to the canvas (no create, edit, delete or sign-off); the builder fixes.\n" +
        '5. Hand back, for the lead\'s figma_sign_off, [{ lens, score, verdict, remaining?, reviewer: "agent:<your name>" }], ' +
        "each finding with its fix, and the cold read."
      );
    },
  },
  {
    name: "build_board",
    title: "Build a FigJam board",
    description: "Build a complete board in the open FigJam file from a short brief — a retro, a brainstorm, a decision board — one zone per call, each one checked.",
    args: [{ name: "brief", description: "What the board is for, e.g. \"a sprint retro for six people\".", required: true }],
    skill: "figjam",
    section: "spec",
    preamble: ({ brief }) =>
      `Build this board in the open FigJam file: ${brief}\n\n` +
      "Own the brief: plan the zones yourself and deliver a finished board without asking me step by step — " +
      "use realistic placeholder content where facts are missing and list it at the end. One white wrapper " +
      "section, then one zone per tool call, each checked before the next.",
  },
  {
    name: "build_deck",
    title: "Build a Figma Slides deck",
    description: "Build a complete deck in the open Figma Slides file from a short brief — plan every slide first, then build 3–5 slides per batch and check each batch.",
    args: [
      { name: "brief", description: "What the deck must say, and to whom, e.g. \"a 10-minute product update for the leadership team\".", required: true },
      { name: "slideCount", description: "How many slides, as a number in a string. Default: as many as the content needs." },
    ],
    skill: "slides",
    section: "spec",
    preamble: ({ brief, slideCount }) =>
      `Build this deck in the open Figma Slides file: ${brief}` +
      (has(slideCount) ? `\nNumber of slides: ${slideCount.trim()}.` : "") +
      "\n\nOwn the brief: plan every slide and the look yourself, then build without asking me step by step — " +
      "use realistic placeholder content where facts are missing and list it at the end. A new deck of 5 or more " +
      'slides runs the design skill\'s page gear first (figma_get_guide { topic: "design" }): the brief, direction ' +
      "cards and styleframes. Build 3–5 slides per batch and check each batch.",
  },
  {
    name: "design_to_code",
    title: "Turn a Figma design into code",
    description: "Read a design faithfully (layout, text, tokens, components, assets, motion) and implement it in this project's stack.",
    args: [
      { name: "nodeId", description: "The node to implement — an id or a Figma link. Default: the selection." },
      { name: "target", description: "The framework / styling to use, if not the project's own." },
    ],
    skill: "design-to-code",
    preamble: ({ nodeId, target }) =>
      `Implement ${nodeId ? `the Figma node ${nodeId}` : "the selected Figma design"} as code${target ? ` (${target})` : ""}, ` +
      "reusing this project's existing components and tokens.",
  },
  {
    name: "create_design_system_rules",
    title: "Write design-system rules for this codebase",
    description: "Read the Figma file's tokens and components and this codebase, then write a rules section so later design-to-code runs stay consistent.",
    args: [
      { name: "clientLanguages", description: 'Comma-separated languages, e.g. "typescript,css".' },
      { name: "clientFrameworks", description: 'Comma-separated frameworks, e.g. "react,tailwind".' },
      { name: "rulesPath", description: "Where to write the rules. Default: the client's rules file (AGENTS.md, CLAUDE.md, .cursor/rules/)." },
    ],
    skill: "design-to-code",
    section: "rules",
    preamble: ({ clientLanguages, clientFrameworks, rulesPath }) => {
      const stack = [clientLanguages, clientFrameworks].filter(has).join("; ");
      return (
        "Create design-system rules for this codebase from the open Figma file" +
        (stack ? ` — the stack is ${stack}` : "") +
        (rulesPath ? `, and write them to ${rulesPath}` : "") +
        "."
      );
    },
  },
  {
    name: "code_to_design",
    title: "Build a Figma design from code",
    description: "Recreate a screen or component that exists in code in the open Figma file — its fonts, components, icons and content taken from the source.",
    args: [
      { name: "source", description: "The code to build from: a file path or a component name.", required: true },
      { name: "target", description: "Where in Figma: a page or frame name, an id, or a Figma link. Default: an empty spot on the current page." },
    ],
    skill: "code-to-design",
    // The spec grammar, not the build walkthrough: its invented pricing copy is the habit this prompt replaces.
    section: "spec",
    preamble: ({ source, target }) =>
      `Build ${source} in the open Figma file${target ? `, in ${target}` : ""}. The code is the brief: take content, ` +
      "fonts, components and icons from it, and build one section per tool call.",
  },
];

/**
 * Register every row: arguments in order, then `checkpoint` where the row takes
 * it. `onUse` hears each row a client gets, so the skill it carries counts as read.
 */
export function registerPrompts(server: McpServer, rows: readonly PromptRow[] = PROMPTS, onUse?: (row: PromptRow) => void): void {
  for (const row of rows) {
    partsOf(row);
    const args = [...row.args, ...(row.checkpoint ? [CHECKPOINT_ARG] : [])];
    const argsSchema: Record<string, z.ZodType<string | undefined>> = {};
    for (const a of args) argsSchema[a.name] = a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description);
    server.registerPrompt(row.name, { title: row.title, description: row.description, argsSchema }, (values: PromptArgs) => {
      const text = promptText(row, values);
      onUse?.(row);
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    });
  }
}
