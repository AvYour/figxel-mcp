// How an agent should work in Figma through Figxel — delivered OVER MCP.
//
// A guide in the repository is read by people; an agent connected to the server
// sees only what the server sends: the `instructions` at initialize, the tool
// descriptions, and whatever a tool returns. The guidance itself lives in
// src/skills as Agent Skills folders (src/server/skills.ts serves them on every
// surface) [C-237]; this file keeps the instructions and a view of the skills
// under the topic names figma_get_guide has always answered.
//
// The working rhythm [C-085] follows the official Figma MCP's own skills [C-082]: take
// the brief and own the decisions, build a whole section per call, look once
// per section, fix with targeted edits. The earlier "one element per call"
// rule [C-071] made every call fast but left the agent waiting to be told the
// next element — the user saw an assistant without initiative. Measured rules
// still apply: text without a width never wraps [C-072]; a picture is not a
// measurement [C-070]; delete only what you created.
//
// The skills that mirror an official skill — design-to-code, library,
// code-to-design, rules, motion, figjam [C-155] [C-156], slides — carry that
// skill's rules, written for figma_* tools, because a client that never loads
// skills still reads these. Instructions go out at initialize, before any file
// is connected, so they cannot be per editor: they point at the figjam and
// slides topics.

import { PLUGIN_NAME, PRODUCT_NAME } from "../shared/version.js";
import { CATALOG_TOPIC, GUIDE_TOPIC_NAMES, topicBody } from "./skills.js";

/** The topics figma_get_guide answered before the skills moved to src/skills (a6ebb06); every one still resolves. */
export const GUIDE_TOPICS = [
  "workflow", "build", "design-system", "typography", "design-to-code", "check", "safety", "tools", "spec",
  "library", "prototype", "motion", "rules", "code-to-design", "figjam", "slides",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/**
 * Sent to every client at initialize — short, because some clients cap it. The
 * first 512 bytes stand alone and name figma_status, figma_get_guide and the
 * process skills, since a client may read only that much [C-176] [C-177].
 */
export const SERVER_INSTRUCTIONS = `${PRODUCT_NAME} drives the Figma file open in Figma desktop (plugin "${PLUGIN_NAME}"). Call figma_status first; follow its build.restart ("plugin" = re-run the plugin, "client" = restart the MCP client). Before you design, animate or review, read figma_get_guide. State the gear first; a section runs the design skill's section gear; a page or more runs the whole design skill (topic design). Topic storyboard plans a motion piece, motion animates, critique reviews in measured rounds; no arguments gives the loop. Every answer ends with the calls for its sections and other skills.

You are the designer who owns the brief. A short request is enough: decide structure, copy, imagery and decoration yourself, build it all, report at the end. Do not ask permission step by step or stop for missing content — use realistic placeholders and list what to replace. Ask only when a choice changes the whole result or a code token disagrees with Figma's.

Motion is gated, as a senior motion designer works: read the motion skill, figma_set_motion_plan before any keyframe, a passing figma_check_motion before figma_export_video { final: true }.

The loop:
1. Orient: figma_get_selection, figma_get_pages; learn the system from an existing screen (figma_get_design_context).
2. Wrapper: one frame at an empty spot (figma_create_frame, vertical auto-layout).
3. One section per call: figma_create_from_spec builds a whole header, hero or card grid. Repeated parts become a component once, then instances.
4. After each section: figma_check_layout (fix every error/warning) and one figma_export_node to judge. Fix with targeted edits, not rebuilds.
5. Polish what the direction calls for; finish with check_layout ok:true, figma_select + figma_zoom_to.

Safety: build at an empty spot; delete only ids your own calls returned. Retry with your idempotencyKey.

Works in Figma Design, FigJam and Slides files: figma_status shows each file's editor. On a board or a deck read figma_get_guide topic figjam or slides first.`;

function view(): Readonly<Record<GuideTopic, string>> & Readonly<Partial<Record<string, string>>> {
  const out: Record<string, string> = {};
  // Old names first: one that no longer resolves throws here, at load, not in an agent's call.
  for (const topic of [...GUIDE_TOPICS, ...GUIDE_TOPIC_NAMES.filter((t) => t !== CATALOG_TOPIC)]) out[topic] = topicBody(topic);
  return out as Record<GuideTopic, string>;
}

/**
 * What figma_get_guide returns for every topic, without the footer — read from
 * the skills tree, so it is a view and never a second copy. The old names are
 * typed; a newer skill or section is there by name too (GUIDES.mechanics).
 */
export const GUIDES = view();
