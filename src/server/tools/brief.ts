// The role process's three tools on the server side (spec ADR #42,
// docs/superpowers/plans/2026-10-14-roles-spec.md §3.4–§3.6):
//
//   figma_set_brief  records a brief before new work, or updates one. Checked
//     here in the spec's order before anything is sent: the role's skill read
//     (role-process.ts briefSkillGate), the structure (INVALID_PARAM in every
//     mode), the gear's lines and the lint (INVALID_PARAM in strict, `lint` in
//     guided), the size. The result adds what sign-off will ask for, so it is
//     never a surprise, and the brief comes into force for its file.
//   figma_get_brief  reads one; reading an open brief adopts it, so a second
//     agent can continue the work, and its `next` says the base workflow's
//     stage the record shows and what moves it on (nextStep).
//   figma_sign_off   ends the work: the server's checks first (the brief
//     complete for its gear, the lenses at the bar or the round budget, at
//     the top gear the cold lenses from a reviewer other than the builder, the
//     motion audit at the delivery fps), then the plugin's sign_off op runs the
//     role's figma_check_layout audits, records the result with a fingerprint
//     on each deliverable and closes the brief on a pass.
//
// The plugin ops (src/plugin/ops/brief.ts) read and write the records; this
// side owns the rules. `details` is one strict object of every role's keys
// (a per-role union is not portable, tools.md § Conventions), and a key of
// another role is refused here by name, so nothing is ever stripped silently.
// None of the three is batchable (batch.ts): each is checked on its own call.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AVOID_MAX, avoidRefusal } from "../../shared/avoid.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { MotionSnapshot } from "../../shared/motion-curves.js";
import {
  BRIEF_LIMITS as L,
  GEARS,
  gearFits,
  isFullGear,
  PLATFORMS,
  requiredDetails,
  REVIEWER_FORM,
  reviewerOf,
  reviewOf,
  ROLE_IDS,
  ROLES,
  ROUND_BUDGET,
  SELF_REVIEW_GEAR,
  signOffSet,
  TONE_BANNED,
  type AuditName,
  type BriefRecord,
  type CheckSummary,
  type Gear,
  type LensScore,
  type Reviewer,
  type ReviewOf,
  type RoleId,
  type SignOffRecord,
} from "../../shared/roles.js";
import { VERSION } from "../../shared/version.js";
import type { Bridge } from "../bridge.js";
import { toNodeId } from "../figma-url.js";
import { auditMotion } from "../motion-audit.js";
import { checkCall, lookUpPlan, planCall, planKey, sessionIdOf, withProcessWarnings, type MotionProcess } from "../motion-process.js";
import { errorResult, okResult } from "../results.js";
import { briefReadOf, briefSkillGate, fileOf, noBriefAnswer, readBrief, type FileRef, type RoleProcess } from "../role-process.js";
import { SKILLS_VERSION } from "../skills.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { missingLayerHint, planAsListed, rootHandles, withPlan } from "./check-motion.js";
import { WRITE_PARAMS } from "./create.js";
import { addressCall, forwardTool, writeEpoch, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

// ── schemas ─────────────────────────────────────────────────────────────────

const text = (max: number = L.text) => z.string().min(1).max(max);
const list = (max: number = L.list) => z.array(z.string().min(1).max(L.text)).max(max);
const SESSION = { session: WRITE_PARAMS.session };

/** Every role's `details` keys, each typed; which role takes which is checked in the handler (ROLES[role].details). */
const DETAILS = z
  .object({
    // ux
    platform: z.enum(PLATFORMS).optional().describe("ux: web, ios, android, desktop or responsive."),
    // "390x844" or a list (spec §2.4): on the wire a preprocess is its output schema, the list (params.ts textLengthParam).
    viewport: z
      .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string().min(1).max(20)).min(1).max(10))
      .optional()
      .describe('ux: each target viewport as width x height, e.g. ["390x844", "1440x900"]; one may be given as a string.'),
    task: text().optional().describe("ux: the user's task in one sentence."),
    screens: z
      .array(z.object({ name: text(L.title), states: z.array(z.string().min(1).max(60)).max(L.list) }).strict())
      .max(L.list)
      .optional()
      .describe('ux: one per screen with the states it needs, e.g. [{ name: "Slots", states: ["empty", "loading", "error"] }].'),
    a11y: z.enum(["AA", "AAA"]).optional().describe('ux: the WCAG level. Default "AA".'),
    controls: list().optional().describe("ux: names of layers the audits treat as controls."),
    insets: z
      .object({ top: z.number().min(0), bottom: z.number().min(0), source: text() })
      .strict()
      .optional()
      .describe("ux: the system bars, in device units, with their source."),
    source: text().optional().describe("ux, design-system — the code path a replica copies."),
    // graphic
    medium: z.enum(["print", "social", "ooh", "web", "editorial", "packaging"]).optional().describe("graphic."),
    viewing: text().optional().describe('graphic: the moment of viewing, e.g. "a phone feed, under 2 s".'),
    bleedMm: z.number().min(0).max(50).optional().describe("graphic: bleed in mm; required for print."),
    placements: list().optional().describe("graphic: every placement it adapts to."),
    // illustration
    set: z.array(z.string().min(1).max(L.title)).min(1).max(L.deliverables).optional().describe("illustration: every icon or drawing in the set."),
    grid: z
      .object({ size: z.number().positive(), padding: z.number().min(0), stroke: z.number().positive().optional(), corner: z.number().min(0).optional() })
      .strict()
      .optional()
      .describe("illustration: the construction grid, px."),
    sizes: z.array(z.number().positive()).min(1).max(L.list).optional().describe("illustration: the px sizes it renders at."),
    style: text().optional().describe("illustration."),
    // brand
    name: text(L.title).optional().describe("brand: the name the mark carries."),
    positioning: text().optional().describe("brand: in one sentence."),
    attributes: z.array(z.string().min(1).max(40)).min(1).max(5).optional().describe("brand: three words."),
    markType: z.enum(["wordmark", "lettermark", "symbol", "combination", "emblem"]).optional().describe("brand."),
    applications: z
      .array(z.object({ name: text(L.title), sizePx: z.number().positive() }).strict())
      .min(1)
      .max(L.list)
      .optional()
      .describe("brand: each application with its smallest size in px."),
    versions: list(10).optional().describe("brand. Default full colour, one colour, reversed."),
    clearSpace: text().optional().describe('brand, e.g. "1x = cap height".'),
    // presentation
    room: z.enum(["projected", "screen", "both"]).optional().describe("presentation."),
    minutes: z.number().positive().max(600).optional().describe("presentation, board."),
    slides: z.number().int().positive().max(500).optional().describe("presentation: the target count."),
    arc: list().optional().describe("presentation: the sections of the story, in order."),
    notes: z.boolean().optional().describe("presentation: speaker notes."),
    maxWords: z.number().int().positive().max(500).optional().describe("presentation: words per slide."),
    // design-system
    scope: z.enum(["tokens", "components", "both"]).optional().describe("design-system."),
    platforms: list(10).optional().describe("design-system."),
    modes: list(20).optional().describe("design-system — the variable modes."),
    components: list(L.deliverables).optional().describe("design-system — the inventory."),
    // board
    purpose: text().optional().describe("board."),
    participants: text().optional().describe("board: who, and how many."),
    activity: text().optional().describe("board."),
    outcome: text().optional().describe("board."),
    // motion
    placement: text().optional().describe("motion: where it plays."),
    durationS: z.number().positive().max(600).optional().describe("motion."),
    fps: z.number().int().min(1).max(60).optional().describe("motion: the delivery rate."),
  })
  .strict();

const SYSTEM = z
  .object({
    bodySize: z.number().positive().describe("Body text size, px."),
    ratio: z.number().min(1).max(4).optional().describe("Type scale ratio."),
    sizes: z.array(z.number().positive()).max(20).optional().describe("The type sizes, px."),
    spacingBase: z.number().positive().optional().describe("Spacing unit, px."),
    grid: z.object({ columns: z.number().int().positive(), gutter: z.number().min(0), margin: z.number().min(0) }).strict().optional(),
    palette: z
      .array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), role: text(60) }).strict())
      .max(L.list)
      .optional()
      .describe('e.g. [{ hex: "#1F6F43", role: "action" }].'),
  })
  .strict();

/** The brief's own fields: what figma_set_brief stores (on an update, what it changes). */
const BRIEF_FIELDS = {
  role: z.enum(ROLE_IDS).optional().describe("Required on a new brief."),
  gear: z.enum(GEARS).optional().describe("Required on a new brief: section, page, top, replica (ux, design-system); micro, sting, piece (motion)."),
  title: z.string().min(1).max(L.title).optional().describe("Required on a new brief."),
  goal: text().optional().describe("What should change for the business or the person. Required on a new brief but a replica."),
  message: z.string().min(1).max(L.message).optional().describe("The one sentence a stranger takes away. Required on a new brief but a replica."),
  success: list().optional().describe("What the viewer does, then the checks that confirm it. Required on a new brief but a replica."),
  audience: text().optional().describe("Who, and where they meet the work. A page or more."),
  proof: list().optional().describe("Facts that make the message believable. A page or more."),
  constraints: list().optional().describe("Format, mandatory content, families. A page or more."),
  givens: text().optional().describe('Whose system the file holds, e.g. "none; the styles are another brand\'s". A page or more.'),
  tone: z
    .object({ words: z.array(z.string().min(1).max(40)).min(1).max(6).describe("Three words."), not: z.string().min(1).max(40).optional().describe("The word it must not be.") })
    .strict()
    .optional()
    .describe("A page or more."),
  format: text(200).optional().describe('Size with a unit and placement, e.g. "390x844 px phone". A page or more.'),
  minTextSize: z.number().positive().max(500).optional().describe("The text floor in frame px."),
  safeArea: z.string().max(60).optional().describe('"x,y,width,height" in frame px, where something covers the frame.'),
  assumptions: list().optional().describe("What you assumed; the report lists them."),
  references: list().optional(),
  defaultToAvoid: text().optional().describe("The category default this work avoids, in one line."),
  avoid: z
    .array(z.string().min(1).max(40))
    .max(AVOID_MAX)
    .optional()
    .describe(
      'defaultToAvoid and direction0 as tells kinds, e.g. ["card_trio", "one_radius"]. At page and top gear a finding of one is a warning, which fails sign-off. Replaces the list.',
    ),
  details: DETAILS.optional().describe("The role's own keys; a key of another role is refused."),
  direction0: text().optional().describe("The default direction, named to be avoided."),
  directions: z
    .array(z.object({ name: text(L.title), idea: text(), total: z.number().min(0).max(100).optional() }).strict())
    .max(10)
    .optional()
    .describe("Two or more directions, each with the score it got."),
  chosen: text(L.title).optional().describe("The direction built."),
  styleframes: z.array(z.string()).max(L.list).optional().describe("Node ids of the styleframes."),
  system: SYSTEM.optional().describe("The system as numbers."),
  deliverables: z.array(z.string()).max(L.deliverables).optional().describe("Node ids of the work the brief covers; added to the list."),
};

export const SET_BRIEF_SHAPE = {
  ...BRIEF_FIELDS,
  briefId: z.string().optional().describe("Update this brief: the fields given are merged, its block redrawn."),
  reopen: z.boolean().optional().describe("With briefId: a signed brief becomes open again, for new work on a signed piece."),
  nodeId: z.string().optional().describe("Store on this node (a target frame, a section, a slide) instead of drawing a block."),
  block: z.boolean().optional().describe("Draw a brief block. Default: at page, top and piece; never in Slides."),
  pageId: z.string().optional().describe("The page for the block. Default the current page."),
  x: z.number().optional(),
  y: z.number().optional(),
};

const LINE_KEYS = [
  "goal", "message", "success", "audience", "proof", "constraints", "givens", "tone", "format",
  "minTextSize", "safeArea", "assumptions", "references", "defaultToAvoid",
] as const;
const TOP_KEYS = ["role", "gear", "title", "details", "avoid", "direction0", "directions", "chosen", "styleframes", "system", "deliverables"] as const;

/** The design skill's lines a brief needs at a page or more (spec §2.4): a new brief in strict, and sign-off. */
const FULL_LINES = ["audience", "proof", "constraints", "givens", "tone", "format"] as const;

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ── the brief's checks ──────────────────────────────────────────────────────

/** The `details` keys a role's brief needs at a gear: requiredDetails, and bleed for print (spec §2.4). */
function neededDetails(role: RoleId, gear: Gear, details: Record<string, unknown>): string[] {
  const keys = requiredDetails(role, gear);
  if (role === "graphic" && details.medium === "print" && keys.indexOf("bleedMm") < 0) keys.push("bleedMm");
  return keys;
}

/** B2: what a new brief at this gear still lacks, as figma_set_brief names it ("audience", "details.viewport"). */
export function gearLinesMissing(role: RoleId, gear: Gear, lines: Record<string, unknown>, details: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (ROLES[role].designLines && isFullGear(gear)) for (const k of FULL_LINES) if (!present(lines[k])) out.push(k);
  for (const k of neededDetails(role, gear, details)) if (!present(details[k])) out.push(`details.${k}`);
  return out;
}

// The spec's example (§3.8 B2) with the three page lines it left out, so the call it shows passes (§2.4).
const B2_EXAMPLE =
  'Example: figma_set_brief { role: "ux", gear: "page", title: "Bench booking", goal: "members book a bench slot online", audience: "neighbours on a phone, next to a broken bike", ' +
  'message: "You fix your own bike here, with a mechanic beside you.", proof: ["six repair stands", "45-minute slots for 8 GBP, tools included"], ' +
  'constraints: ["390 px first, 1440 px second", "opening hours are mandatory"], givens: "the co-op\'s logo and green; no other styles", ' +
  'success: ["a visitor books within one scroll at 390 x 844", "every text 16 px or more on the phone"], tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" }, ' +
  'format: "390x844 px phone, 1440x900 px desktop", details: { platform: "responsive", viewport: ["390x844", "1440x900"], task: "book a 45-minute bench slot", ' +
  'screens: [{ name: "Slots", states: ["empty", "loading", "error"] }] } }';

/** B2 (§3.8): the message, and a hint that is a call which passes. */
export function gearLinesAnswer(role: RoleId, gear: Gear, missing: readonly string[]): { message: string; hint: string } {
  const keys = ROLES[role].details.map((d) => d.name);
  return {
    message: `The ${gear} gear's ${role} brief is missing: ${missing.join(", ")}.`,
    hint:
      role === "ux" && isFullGear(gear)
        ? B2_EXAMPLE
        : `Add them and send this call again: figma_set_brief { role: "${role}", gear: "${gear}", title, goal, message, success, ${missing.join(", ")} }. A ${role} brief's details: ${keys.join(", ")}.`,
  };
}

const SIZE_UNIT = /\d\s*(px|pt|dp|mm|in)\b/i;
const WXH = /^\s*\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?\s*$/i;

/** How many sentences: a sentence end (. ! ?) followed by a space and more text starts another (§3.4 step 4). */
export const sentencesIn = (s: string) => s.trim().split(/[.!?]+\s+(?=\S)/).length;

/**
 * The lint of §3.4 step 4 over the fields given: `hard` is INVALID_PARAM in
 * strict and `lint` in guided (B3); `soft` is a warning in every mode.
 */
export function lintBrief(role: RoleId, gear: Gear, lines: Record<string, unknown>, details: Record<string, unknown>): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  if (typeof lines.message === "string") {
    const n = sentencesIn(lines.message);
    if (n > 1) hard.push(`message has ${n} sentences; a stranger takes away one. Keep the first and move the rest to proof.`);
  }
  const tone = lines.tone as { words?: string[] } | undefined;
  if (tone?.words) {
    if (tone.words.length !== 3) {
      hard.push(`tone has ${tone.words.length} word${tone.words.length === 1 ? "" : "s"}; it takes three, and one it must not be (the design skill's brief section).`);
    }
    const banned = tone.words.filter((w) => TONE_BANNED.indexOf(w.trim().toLowerCase()) >= 0);
    if (banned.length) {
      const quoted = banned.map((w) => `"${w.trim().toLowerCase()}"`);
      hard.push(
        banned.length === 1
          ? `tone uses ${quoted[0]}, a word every default claims; take the three words from the subject and the audience (the design skill's brief section).`
          : `tone uses ${quoted.join(" and ")}, words every default claims; take the three words from the subject and the audience (the design skill's brief section).`,
      );
    }
  }
  if (typeof lines.format === "string" && isFullGear(gear) && role !== "board" && role !== "design-system" && !SIZE_UNIT.test(lines.format)) {
    hard.push('format has no size with a unit (px, pt, dp, mm, in), so the format check cannot measure the frame. Example: "1080x1350 px Instagram feed".');
  }
  if (Array.isArray(details.viewport)) {
    for (const v of details.viewport as string[]) {
      if (!WXH.test(v)) hard.push(`details.viewport "${v}" is not a size: write it as width x height, e.g. "390x844".`);
    }
  }
  const success = lines.success as string[] | undefined;
  if (success && success.length) {
    if (!success.some((s) => /\d/.test(s) || /\bfigma_[a-z_]+/.test(s))) {
      soft.push('success has no line with a number or a tool name, so no check can confirm it; write one a tool or a render can confirm, e.g. "the Book button is visible without scrolling at 390 x 844".');
    }
    if (isFullGear(gear) && success.length < 2) {
      soft.push(`success has ${success.length} line; at the ${gear} gear write two or more: what the viewer does or remembers, then the checks that follow from it.`);
    }
  }
  return { hard, soft };
}

/** A blocker of sign-off: what stands in the way, and the call that clears it. */
export interface Blocker {
  what: string;
  call: string;
}

/** One thing the brief lacks for sign-off: the fields, as figma_set_brief's result names them, and the blocker sign-off says. */
interface Gap extends Blocker {
  fields: string[];
}

/**
 * Everything the brief still lacks for sign-off at its gear (§3.6 step 1):
 * the always lines, the page lines, the role's details, and at a page or more
 * what is recorded as the work goes (Direction 0, two or more directions, the
 * choice, styleframes, the system). Grouped as sign-off says them.
 */
function gapsOf(b: BriefRecord): Gap[] {
  const role = ROLES[b.role];
  const lines = b.lines as unknown as Record<string, unknown>;
  const details = b.details ?? {};
  const full = isFullGear(b.gear);
  const id = b.id;
  const out: Gap[] = [];
  const missingLines: string[] = [];
  if (b.gear !== "replica") for (const k of ["goal", "message", "success"]) if (!present(lines[k])) missingLines.push(k);
  if (role.designLines && full) for (const k of FULL_LINES) if (!present(lines[k])) missingLines.push(k);
  if (missingLines.length) {
    out.push({
      fields: missingLines,
      what: `the brief is missing ${missingLines.join(", ")}: the ${b.gear} gear needs them`,
      call: `figma_set_brief { briefId: "${id}", ${missingLines.join(", ")} }`,
    });
  }
  const missingDetails = neededDetails(b.role, b.gear, details).filter((k) => !present(details[k]));
  if (missingDetails.length) {
    out.push({
      fields: missingDetails.map((k) => `details.${k}`),
      what: `the brief's details are missing ${missingDetails.join(", ")}`,
      call: `figma_set_brief { briefId: "${id}", details: { ${missingDetails.join(", ")} } }`,
    });
  }
  if (!full) return out;
  const later = role.later;
  const n = b.directions?.length ?? 0;
  const noZero = later.indexOf("direction0") >= 0 && !present(b.direction0);
  const few = later.indexOf("directions") >= 0 && n < 2;
  const unchosen = later.indexOf("chosen") >= 0 && !present(b.chosen);
  if (noZero || few) {
    out.push({
      fields: [...(noZero ? ["direction0"] : []), ...(few ? ["directions (two or more)"] : []), ...(unchosen ? ["chosen"] : [])],
      what: `the brief records ${n === 0 ? "no directions" : `${n} direction${n === 1 ? "" : "s"}${noZero ? " and no Direction 0" : ""}`}: the ${b.gear} gear needs Direction 0 and two or more`,
      call: `figma_set_brief { briefId: "${id}", direction0, directions, chosen }`,
    });
  } else if (unchosen) {
    out.push({ fields: ["chosen"], what: `the brief records no chosen direction: the ${b.gear} gear names the one it builds`, call: `figma_set_brief { briefId: "${id}", chosen }` });
  }
  if (later.indexOf("styleframes") >= 0) {
    const need = b.gear === "top" || b.gear === "piece" ? 3 : 1;
    const have = b.styleframes?.length ?? 0;
    if (have < need) {
      const howMany = need === 1 ? "one or more" : "three or more";
      out.push({
        fields: [`styleframes (${howMany})`],
        what: `the brief records ${have === 0 ? "no styleframes" : `${have} styleframe${have === 1 ? "" : "s"}`}: the ${b.gear} gear needs ${howMany}`,
        call: `figma_set_brief { briefId: "${id}", styleframes }`,
      });
    }
  }
  if (later.indexOf("system") >= 0) {
    const s = b.system;
    // Brand records its palette (spec §2.4); the roles that lay out text record the scale and spacing too.
    const gaps =
      b.role === "brand"
        ? s?.palette?.length
          ? []
          : ["palette"]
        : [
            ...(s?.bodySize ? [] : ["bodySize"]),
            ...(s?.ratio || s?.sizes?.length ? [] : ["ratio"]),
            ...(s?.spacingBase ? [] : ["spacingBase"]),
            ...(s?.palette?.length ? [] : ["palette"]),
          ];
    if (gaps.length) {
      out.push({
        fields: gaps.map((k) => `system.${k}`),
        what: s ? `the brief's system is missing ${gaps.join(", ")}` : `the brief records no system: the ${b.gear} gear writes it as numbers`,
        call: `figma_set_brief { briefId: "${id}", system: { ${gaps.join(", ")} } }`,
      });
    }
  }
  return out;
}

/** The brief's gaps as sign-off's blockers (S2). */
export function briefGaps(b: BriefRecord): Blocker[] {
  return gapsOf(b).map(({ what, call }) => ({ what, call }));
}

/** What sign-off will ask for, as figma_set_brief's result names it (§3.4): never a surprise at the end. */
export function missingForSignOff(b: BriefRecord): string[] {
  return gapsOf(b).flatMap((g) => g.fields);
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * §3.6 step 2: every lens the role and gear require, each 8 or more with
 * verdict pass — or, once `rounds` reaches the gear's budget, a lens under the
 * bar is an exception if it lists what remains (critique: stop at the bar or
 * the budget, then report what is left [C-239]).
 */
export function judgeLenses(role: RoleId, gear: Gear, lenses: readonly LensScore[], rounds: number): { blockers: Blocker[]; exceptions: LensScore[] } {
  const set = signOffSet(role, gear);
  const budget = ROUND_BUDGET[gear];
  const blockers: Blocker[] = [];
  const exceptions: LensScore[] = [];
  for (const lens of set?.lenses ?? []) {
    const got = lenses.find((l) => norm(l.lens) === norm(lens));
    if (!got) {
      blockers.push({
        what: `lens ${lens} has no score`,
        call: `score it with the critique skill (figma_get_guide { topic: "critique", section: "lenses" }) and pass it in lenses`,
      });
    } else if (got.score >= 8 && got.verdict === "pass") {
      continue;
    } else if (rounds >= budget && got.remaining?.length) {
      exceptions.push(got);
    } else if (rounds >= budget) {
      blockers.push({
        what: `lens ${lens} scored ${got.score} with verdict ${got.verdict} at the round budget (${rounds} of ${budget})`,
        call: "fix it, or list what remains in its `remaining` to report it as an exception",
      });
    } else {
      blockers.push({
        what: `lens ${lens} scored ${got.score} with verdict ${got.verdict} in round ${rounds} of ${budget}`,
        call: `run round ${rounds + 1}, or at the budget list what remains`,
      });
    }
  }
  return { blockers, exceptions };
}

/** The prompt a cold reviewer starts from (prompts.ts), as the blockers and `next` name it. */
export const COLD_PROMPT = "critique_cold";

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(" and ");

/** The way out when the cold lenses lack a reviewer other than the builder. */
const COLD_WAY_OUT =
  `run the ${COLD_PROMPT} prompt in a fresh context (a subagent, or a new conversation) and pass its scores with reviewer: "agent:<name>", ` +
  'or have the owner score them and pass reviewer: "owner"';

/**
 * Role quality W4: at the top gear (and motion's piece) the cold lenses —
 * message and originality, or the role's own lens for what the work says —
 * must come from a reviewer other than the builder; one blocker names them
 * and the way out. At the page gear a self-review passes and is said so
 * (`selfReviewed`); at the lower gears nothing is asked.
 */
export function judgeReviewers(role: RoleId, gear: Gear, lenses: readonly LensScore[]): { blockers: Blocker[]; review: ReviewOf } {
  const review = reviewOf(role, gear, lenses);
  if (!review.required || review.notIndependent.length === 0) return { blockers: [], review };
  const lacking = review.notIndependent;
  const scoredBySelf = lacking.filter((name) => lenses.some((l) => norm(l.lens) === norm(name)));
  const n = lacking.length;
  const how =
    scoredBySelf.length < n
      ? lacking.map((name) => `${quoted([name])} ${scoredBySelf.indexOf(name) >= 0 ? 'was scored by "self"' : "has no score"}`).join(", ")
      : n === review.cold.length
        ? `${n === 1 ? "it was" : n === 2 ? "both were" : "all were"} scored by "self"`
        : `${quoted(lacking)} ${n === 1 ? "was" : "were"} scored by "self"`;
  const lensWord = review.cold.length === 1 ? "lens" : "lenses";
  const need = review.cold.length === 1 ? "needs" : "need";
  return {
    blockers: [{ what: `at the ${gear} gear the ${lensWord} ${quoted(review.cold)} ${need} a reviewer other than the builder, and ${how}`, call: COLD_WAY_OUT }],
    review,
  };
}

/** Each lens with its reviewer written out: the record says who scored every lens. */
const withReviewers =(lenses: readonly LensScore[]): LensScore[] => lenses.map((l) => ({ ...l, reviewer: reviewerOf(l) }));

/**
 * The report's first line (base workflow §5): who scored which lens, and
 * "Self-reviewed" first whenever the cold lenses were not scored by a
 * reviewer other than the builder.
 */
export function reviewedLine(role: RoleId, gear: Gear, lenses: readonly LensScore[]): string {
  const review = reviewOf(role, gear, lenses);
  const by = new Map<Reviewer, string[]>();
  for (const l of lenses) {
    const r = reviewerOf(l);
    by.set(r, [...(by.get(r) ?? []), l.lens]);
  }
  const self = by.get("self") ?? [];
  const others = [...by].filter(([r]) => r !== "self").map(([r, names]) => `${r === "owner" ? "the owner" : r} scored ${names.join(", ")}`);
  const who = [...others, ...(self.length ? [`self-reviewed: ${self.join(", ")}`] : [])].join("; ");
  if (others.length === 0) return `Self-reviewed: the builder scored every lens (${self.join(", ")}).`;
  if (review.cold.length && !review.independent) {
    const n = review.notIndependent.length;
    return `Self-reviewed: ${quoted(review.notIndependent)} ${n === 1 ? "was" : "were"} not scored by a reviewer other than the builder. Reviewers: ${who}.`;
  }
  return review.independent ? `Independent review: ${who}.` : `Reviewers: ${who}.`;
}

/** S2 lines from what the plugin's sign_off found: each error and warning, then the infos nobody answered. */
export function issueBlockers(
  issues: ReadonlyArray<{ kind: string; severity: string; nodeId: string; name: string; detail: string }>,
  unanswered: ReadonlyArray<{ kind: string; nodeId: string }>,
  answerKinds: readonly AuditName[],
): Blocker[] {
  const out: Blocker[] = issues.map((i) => ({
    what: `figma_check_layout found ${i.severity === "error" ? "an error" : "a warning"}: ${i.kind} on "${i.name}" (${i.nodeId}): ${i.detail}`,
    call: "fix it with a targeted edit, then figma_sign_off again",
  }));
  if (unanswered.length) {
    const n = unanswered.length;
    out.push({
      what: `${n} ${answerKinds.join(" and ")} info${n === 1 ? " is" : "s are"} unanswered (${unanswered.map((u) => `${u.kind} ${u.nodeId}`).join(", ")})`,
      call: "fix them, or pass answers: [{ kind, nodeId, reason }]",
    });
  }
  return out;
}

// ── the next stage (base workflow §3; decisions §10.6) ──────────────────────

/** The base workflow's stages as figma_get_brief's `next` names them: P1, P3–P9 of base workflow §3. */
export const STAGES = ["brief", "directions", "choice", "system", "build", "critique", "sign-off"] as const;
export type Stage = (typeof STAGES)[number];

/** What figma_get_brief answers for an open brief: the stage its record shows, and what moves it on. */
export interface NextStep {
  stage: Stage;
  /** What the stage lacks to move on: fields as figma_set_brief names them, or what the later stages need. */
  missing: string[];
  /** The call, or the prompt, that supplies it. */
  call: string;
  /** Everything sign-off still asks of the record (missingForSignOff), with the independent review where the gear needs one. */
  forSignOff: string[];
}

/** The design skill's section that teaches a stage the record shows (every role with directions reads it at these gears). */
const STAGE_SECTION: Partial<Record<Stage, string>> = { directions: "directions", choice: "directions", system: "system" };

/** The stage a missingForSignOff field belongs to; a field that list gains later counts as the brief's. */
function stageOfField(field: string): Stage {
  if (field.startsWith("system.")) return "system";
  if (field === "chosen") return "choice";
  return /^(direction0|directions|styleframes)\b/.test(field) ? "directions" : "brief";
}

/** figma_set_brief with these fields: "details.task" and "system.ratio" under their key, a "(two or more)" note dropped. */
function setBriefCall(id: string, fields: readonly string[]): string {
  const keys: string[] = [];
  const nested = new Map<string, string[]>();
  for (const f of fields) {
    const name = f.replace(/\s*\(.*\)$/, "");
    const dot = name.indexOf(".");
    const key = dot > 0 ? name.slice(0, dot) : name;
    if (keys.indexOf(key) < 0) keys.push(key);
    if (dot > 0) nested.set(key, [...(nested.get(key) ?? []), name.slice(dot + 1)]);
  }
  return `figma_set_brief { briefId: "${id}", ${keys.map((k) => (nested.has(k) ? `${k}: { ${nested.get(k)!.join(", ")} }` : k)).join(", ")} }`;
}

/**
 * Where an open brief's record says the work is, in the base workflow's
 * stages, and what moves it on (decisions §10.6: the orchestration stays in
 * the engine, read-only). The brief's own gaps come first, in stage order;
 * then the build (no deliverables recorded), a sign-off attempt that failed,
 * and the critique. The record cannot tell a build still going on from its
 * critique, so recorded deliverables read as ready for the critique.
 * `signOff` is a deliverable's last record, when the read found one.
 */
export function nextStep(b: BriefRecord, signOff?: SignOffRecord): NextStep {
  const id = b.id;
  const fields = missingForSignOff(b);
  const review = reviewOf(b.role, b.gear, []);
  const cold = review.required
    ? [`independent review: ${quoted(review.cold)} scored by a reviewer other than the builder (the ${COLD_PROMPT} prompt in a fresh context, or the owner)`]
    : [];
  const forSignOff = [...fields, ...cold];
  const signCall = `figma_sign_off { briefId: "${id}", lenses, rounds }`;

  if (fields.length) {
    let stage: Stage = stageOfField(fields[0]!);
    for (const f of fields) if (STAGES.indexOf(stageOfField(f)) < STAGES.indexOf(stage)) stage = stageOfField(f);
    const missing = fields.filter((f) => stageOfField(f) === stage);
    const section = STAGE_SECTION[stage];
    const guide = section ? `figma_get_guide { topic: "design", section: "${section}" }, then ` : "";
    return { stage, missing, call: `${guide}${setBriefCall(id, missing)}`, forSignOff };
  }

  const last = b.lastSignOff;
  if (last && !last.ok) {
    const mine = signOff && signOff.briefId === id && signOff.at === last.at ? signOff : undefined;
    const failing = mine ? mine.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    return {
      stage: "sign-off",
      missing: [
        `a passing sign-off: the attempt at ${last.at} did not pass${failing.length ? ` (${failing.join(", ")} not ok)` : ""}`,
        ...(mine?.independent === true ? [] : cold),
      ],
      call: `fix what that attempt listed${review.required ? `, with ${quoted(review.cold)} from the ${COLD_PROMPT} prompt in a fresh context or the owner` : ""}, then ${signCall}`,
      forSignOff,
    };
  }

  if (b.deliverables.length === 0) {
    const build =
      b.role === "motion"
        ? "figma_set_motion_plan on the piece's frame before its first keyframe, the build, figma_check_motion until ok: true"
        : "one section per call, each checked with figma_check_layout";
    return { stage: "build", missing: ["deliverables"], call: `${build}; then record the frames: figma_set_brief { briefId: "${id}", deliverables }, or name them at sign-off`, forSignOff };
  }

  const lenses = signOffSet(b.role, b.gear)?.lenses ?? [];
  const budget = ROUND_BUDGET[b.gear];
  const rounds = `up to ${budget} round${budget === 1 ? "" : "s"}`;
  const how = review.required
    ? `${quoted(review.cold)} from the ${COLD_PROMPT} prompt in a fresh context, or from the owner; the other lenses with the critique skill (figma_get_guide { topic: "critique" }), ${rounds}`
    : review.cold.length && b.gear === SELF_REVIEW_GEAR
      ? `the critique skill (figma_get_guide { topic: "critique" }), ${rounds}, with ${quoted(review.cold)} from the ${COLD_PROMPT} prompt in a fresh context when you can (a self-review passes at this gear and is recorded as self-reviewed)`
      : `the critique skill (figma_get_guide { topic: "critique" }), ${rounds}`;
  return {
    stage: "critique",
    missing: [`lens scores: ${lenses.join(", ")}`, ...cold],
    call: `once every section is built and checked: ${how}; then ${signCall}`,
    forSignOff,
  };
}

// ── the tools ───────────────────────────────────────────────────────────────

const SET_DESCRIPTION =
  "Record the brief of new work before its first frame, as a senior designer writes one: role, gear, title, goal, " +
  "message and success, plus the lines the gear and the role need (audience, proof, constraints, givens, tone, format, " +
  "`details`). Roles, and the skill each reads first: ux (screens, flows, anything people operate), graphic (posters, " +
  "ads, posts, print), illustration (icons, illustration; skill graphic), brand (logos, identity), presentation (decks; " +
  "skill slides), design-system (tokens, components), board (FigJam; skill figjam), motion (skill storyboard). Stored in " +
  "the file on a brief block drawn at an empty spot, or on `nodeId`; `briefId` updates one with directions, the choice, " +
  "styleframes and the system. Under BRIDGE_PROCESS=strict a new top-level frame, a spec into an empty frame, a new deck " +
  "or a new board waits for a brief, and figma_sign_off ends it.";

const GET_DESCRIPTION =
  "Read the brief a frame was made from — role, gear, lines, directions, system, status — with its last sign-off (and " +
  "whether the frame changed since) and its motion plan; with no node, every open brief in the file. For an open brief, " +
  "`next`: the stage the record shows (brief, directions, choice, system, build, critique, sign-off), what it lacks to " +
  "move on, the call that supplies it, and what sign-off still asks for. Reading an open brief adopts it for this " +
  "session, so a second agent can continue the work. Reads only.";

const SIGN_OFF_DESCRIPTION =
  "End a piece of new work the way a studio signs it off. Runs the role's checks on the deliverables (figma_check_layout " +
  "with the role's audits and the brief's floors; for motion the frame-by-frame check at the delivery fps), checks the " +
  "brief is complete for its gear (directions, the choice, styleframes, the system), takes your critique lens scores, " +
  "rounds and a reason for every info you keep, then records the result and a fingerprint on each deliverable and on the " +
  "brief block, closes the brief, and selects and zooms to the work on a pass. At top and piece, message and originality " +
  "need a `reviewer` other than you (the critique_cold prompt in a fresh context, or the owner); at page a self-review " +
  "is recorded as one. `ok: false` lists each blocker with the " +
  "call that clears it. A final export (figma_export_node, figma_export_frames_to_pdf or figma_export_video with " +
  "`final: true`) needs a passing sign-off newer than the last change. Writes plugin data only.";

const invalid = (message: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, message, hint ? { hint } : {});

const pick = (args: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

/** A node id field as the plugin resolves it: a pasted link or "12-34" becomes "12:34". */
const idOf = (v: unknown, field: string) => (typeof v === "string" ? toNodeId(v, field).id : undefined);

/** The mode a process gate runs in for this file, or "off". */
const modeOf = (roles: RoleProcess | undefined, file: FileRef): "strict" | "guided" | "off" => (roles?.active ? roles.modeFor(file).mode : "off");

export interface BriefTools {
  roles?: RoleProcess;
  motion?: MotionProcess;
}

/** Register figma_get_brief (read), figma_set_brief and figma_sign_off (style). Before registerBatch, which refuses them as steps. */
export function registerBrief(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean, opts: BriefTools = {}): void {
  const { roles, motion } = opts;

  if (wanted("set_brief")) {
    server.registerTool(
      "figma_set_brief",
      {
        title: "Set the brief of new work",
        description: fitDescription(SET_DESCRIPTION),
        inputSchema: { ...SET_BRIEF_SHAPE, ...WRITE_PARAMS },
        annotations: writeAnnotations("set_brief"),
      },
      async (args: Record<string, unknown>, extra: Extra) => setBrief(bridge, roles, args, extra),
    );
  }

  if (wanted("get_brief")) {
    server.registerTool(
      "figma_get_brief",
      {
        title: "Get a brief",
        description: fitDescription(GET_DESCRIPTION),
        inputSchema: {
          nodeId: z.string().optional().describe("A node: its own brief, else its top-level frame's, else the brief listing it, else its page's."),
          briefId: z.string().optional().describe("The node the brief is stored on (figma_set_brief's briefId)."),
          fingerprint: z.boolean().optional().describe("With nodeId: compare the node now with its last sign-off (`fresh`)."),
          target: z
            .object({ parentId: z.string().optional(), pageId: z.string().optional() })
            .strict()
            .optional()
            .describe("The facts the process gate reads: the target's type, whether it is top level, its child count."),
          ...SESSION,
        },
        annotations: readAnnotations("get_brief"),
      },
      async (args: Record<string, unknown>, extra: Extra) => getBrief(bridge, roles, args, extra),
    );
  }

  if (wanted("sign_off")) {
    server.registerTool(
      "figma_sign_off",
      {
        title: "Sign off new work",
        description: fitDescription(SIGN_OFF_DESCRIPTION),
        inputSchema: {
          nodeId: z.string().optional().describe("The deliverable. Default the brief's deliverables."),
          nodeIds: z.array(z.string()).min(1).max(50).optional().describe("The deliverables: top-level frames, component sets, sections."),
          deck: z.boolean().optional().describe("Figma Slides: the whole deck."),
          briefId: z.string().optional().describe("Default the brief whose work the node is, else the brief in force, else its page's."),
          lenses: z
            .array(
              z
                .object({
                  lens: z.string().min(1).max(60).describe('A critique lens, e.g. "message".'),
                  score: z.number().int().min(1).max(10),
                  verdict: z.enum(["pass", "fix"]),
                  remaining: z.array(z.string().min(1).max(L.text)).max(L.list).optional().describe("At the round budget: what is left."),
                  reviewer: z
                    .string()
                    .regex(REVIEWER_FORM, 'reviewer is "self", "owner" or "agent:<name>" (1–40 letters, digits, ".", "_" or "-")')
                    .optional()
                    .describe(
                      'Who scored it: "self" (default: you), "owner" (the person), or "agent:<name>" (a reviewer in a fresh context, e.g. the critique_cold prompt). At top and piece, message and originality (or the role\'s lens for what the work says) need one other than "self".',
                    ),
                })
                .strict(),
            )
            .min(1)
            .max(20)
            .describe("Every lens of the role's sign-off, scored as the critique skill scores it, each with its reviewer."),
          rounds: z.number().int().min(1).max(10).describe("Critique rounds run."),
          answers: z
            .array(z.object({ kind: z.string().min(1).max(60), nodeId: z.string(), reason: text() }).strict())
            .max(L.answers)
            .optional()
            .describe("An info kept on purpose, with why."),
          placeholders: z.array(z.string().min(1).max(L.text)).max(100).optional().describe('Every invented fact, or ["none"].'),
          fps: z.number().int().min(1).max(60).optional().describe("Motion: the delivery rate. Default the brief's."),
          ...WRITE_PARAMS,
        },
        annotations: writeAnnotations("sign_off"),
      },
      async (args: Record<string, unknown>, extra: Extra) => signOff(bridge, roles, motion, args, extra),
    );
  }
}

// ── figma_set_brief ─────────────────────────────────────────────────────────

async function setBrief(bridge: Bridge, roles: RoleProcess | undefined, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const key = args.idempotencyKey as string | undefined;
  const refuse = (err: unknown) => errorResult(err instanceof BridgeError ? err.withKey(key) : err, { unchanged: true });
  let briefId: string | undefined;
  let addressed: Awaited<ReturnType<typeof addressCall>>;
  let fields: Record<string, unknown>;
  try {
    briefId = idOf(args.briefId, "briefId");
    fields = pick(args, [...LINE_KEYS, ...TOP_KEYS]);
    if (Array.isArray(fields.styleframes)) fields.styleframes = (fields.styleframes as string[]).map((s, i) => toNodeId(s, `styleframes[${i}]`).id);
    if (Array.isArray(fields.deliverables)) fields.deliverables = (fields.deliverables as string[]).map((s, i) => toNodeId(s, `deliverables[${i}]`).id);
    if (args.reopen === true && briefId === undefined) throw invalid("`reopen` goes with `briefId`: it opens that brief again.");
    addressed = await addressCall(bridge, "set_brief", pick(args, ["nodeId", "pageId"]), args.session as string | undefined);
  } catch (err) {
    return refuse(err);
  }
  const session = addressed.session;
  const file = await fileOf(bridge, session);

  // An update is checked against the brief it changes.
  let stored: BriefRecord | undefined;
  if (briefId !== undefined) {
    try {
      const read = await readBrief(bridge, { briefId }, session, extra.signal);
      if (!read.brief) {
        const why = read.invalid && !/no brief is stored/.test(read.invalid) ? `: ${read.invalid}` : "";
        throw invalid(`No brief to update on ${briefId}${why}.`, "figma_get_brief with no arguments lists the file's open briefs.");
      }
      stored = read.brief;
    } catch (err) {
      return refuse(err);
    }
  }
  const role = (fields.role ?? stored?.role) as RoleId | undefined;
  const gear = (fields.gear ?? stored?.gear) as Gear | undefined;
  if (!role || !gear) {
    return refuse(invalid("A new brief names its role and gear.", 'figma_set_brief { role: "ux", gear: "page", title, goal, message, success, … }; figma_get_guide { topic: "design" } says how to choose the gear.'));
  }
  const mode = modeOf(roles, file);

  // 1. The skill (§3.4): before a new brief, or before work starts again on a signed one.
  const warnings: string[] = [];
  if (roles && mode !== "off" && (stored === undefined || args.reopen === true)) {
    const gate = briefSkillGate(roles, role, gear, mode);
    if (gate.refusal) return refuse(gate.refusal);
    warnings.push(...gate.warnings);
  }

  // 2. Structure, in every mode.
  const details = (fields.details ?? {}) as Record<string, unknown>;
  const lines = pick(fields, LINE_KEYS);
  if (!gearFits(role, gear)) {
    return refuse(invalid(`The ${role} role takes the gears ${ROLES[role].gears.join(", ")}; "${gear}" is not one of them.`));
  }
  const allowed = ROLES[role].details.map((d) => d.name);
  const foreign = Object.keys(details).filter((k) => allowed.indexOf(k) < 0);
  if (foreign.length) {
    return refuse(invalid(`${foreign.map((k) => `details.${k}`).join(", ")} ${foreign.length === 1 ? "is" : "are"} not a ${role} brief's: its details are ${allowed.join(", ")}.`));
  }
  // The avoid list is matched by the checks, so it holds tells kinds only (shared/avoid.ts), each once.
  if (Array.isArray(fields.avoid)) {
    const bad = avoidRefusal(fields.avoid);
    if (bad) return refuse(invalid(bad.message, bad.hint));
    fields.avoid = [...new Set(fields.avoid as string[])];
  }
  if (stored === undefined) {
    const needs = gear === "replica" ? ["title", "details.source"] : ["title", "goal", "message", "success"];
    const lacking = needs.filter((k) => (k === "details.source" ? !present(details.source) : !present(fields[k])));
    if (lacking.length) {
      return refuse(
        invalid(`A new ${role} brief needs ${lacking.join(", ")}.`, `figma_set_brief { role: "${role}", gear: "${gear}", ${needs.map((k) => (k === "details.source" ? "details: { source }" : k)).join(", ")} }`),
      );
    }
  }

  // 3. The gear's lines, on a new brief; 4. the lint, over the fields given.
  const lint: string[] = [];
  if (stored === undefined) {
    const missing = gearLinesMissing(role, gear, lines, details);
    if (missing.length) {
      const answer = gearLinesAnswer(role, gear, missing);
      if (mode === "strict") return refuse(invalid(answer.message, answer.hint));
      lint.push(answer.message);
    }
  }
  const linted = lintBrief(role, gear, lines, details);
  if (linted.hard.length && mode === "strict") {
    return refuse(invalid(linted.hard.join(" "), "Correct those lines and send this call again."));
  }
  lint.push(...linted.hard, ...linted.soft);

  // 5. The size, as the merged record will be (lines and details merge key by key).
  const merged = { ...stored, ...pick(fields, TOP_KEYS), lines: { ...stored?.lines, ...lines }, details: { ...stored?.details, ...details } };
  const bytes = Buffer.byteLength(JSON.stringify(merged), "utf8");
  if (bytes > L.bytes) return refuse(invalid(`The brief would be ${bytes} bytes; a brief holds at most ${L.bytes} (shared plugin data caps one entry at 100 kB).`, "Shorten the longest lines."));

  // A replica's brief is the code (§2.4): its goal and message may be left out, and the record keeps them as empty lines.
  const sent = stored === undefined && gear === "replica" ? { goal: "", message: "", ...lines } : lines;
  const brief: Record<string, unknown> = { ...pick(fields, TOP_KEYS), ...(Object.keys(sent).length ? { lines: sent } : {}) };
  const params: Record<string, unknown> = {
    brief,
    ...(briefId !== undefined ? { briefId } : {}),
    ...(args.reopen === true ? { reopen: true } : {}),
    ...pick(addressed.params, ["nodeId", "pageId"]),
    ...pick(args, ["block", "x", "y"]),
  };
  // The params are addressed already: the session a link named goes with them.
  const result = await forwardTool(bridge, "set_brief", params, extra, {
    session,
    idempotencyKey: key,
    shape: (data) => {
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const record = briefReadOf({ brief: d.record }).brief;
      if (record) roles?.hold(file.key, record, "set");
      // The lint of the record as stored: an earlier guided write may have left a line the rules refuse.
      const own = record ? lintBrief(record.role, record.gear, record.lines as unknown as Record<string, unknown>, record.details ?? {}) : { hard: [], soft: [] };
      const all = [...new Set([...lint, ...own.hard, ...own.soft])];
      return okResult({ ...d, missingForSignOff: record ? missingForSignOff(record) : [], lint: all });
    },
  });
  return withProcessWarnings(result, warnings);
}

// ── figma_get_brief ─────────────────────────────────────────────────────────

async function getBrief(bridge: Bridge, roles: RoleProcess | undefined, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  let params: Record<string, unknown>;
  let addressed: Awaited<ReturnType<typeof addressCall>>;
  try {
    const briefId = idOf(args.briefId, "briefId");
    params = { ...pick(args, ["nodeId", "fingerprint", "target"]), ...(briefId !== undefined ? { briefId } : {}) };
    if (params.fingerprint === true && params.nodeId === undefined) throw invalid("`fingerprint` compares a node with its sign-off: pass `nodeId`.");
    addressed = await addressCall(bridge, "get_brief", params, args.session as string | undefined);
  } catch (err) {
    return errorResult(err, { readOnly: true });
  }
  const file = await fileOf(bridge, addressed.session);
  return forwardTool(bridge, "get_brief", params, extra, {
    session: args.session as string | undefined,
    shape: async (data) => {
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const read = briefReadOf(data);
      // Reading an open brief adopts it (§3.5): new work on it no longer waits.
      const adopted = !!read.brief && read.brief.status === "open" && roles?.active === true;
      if (adopted) roles!.hold(file.key, read.brief!, "adopted");
      let motionPlan: Record<string, unknown> = {};
      if (read.brief?.role === "motion" && typeof addressed.params.nodeId === "string") {
        try {
          const look = await lookUpPlan(bridge, addressed.params.nodeId, addressed.session, extra.signal);
          motionPlan = { motionPlan: look.plan };
        } catch {
          // The plan is the motion tools' to report; the brief stands without it.
        }
      }
      // For an open brief, the stage its record shows and what moves it on (decisions §10.6); reads nothing more.
      const next = read.brief?.status === "open" ? nextStep(read.brief, read.signOff) : undefined;
      return okResult({ ...d, ...motionPlan, ...(next ? { next } : {}), ...(adopted ? { adopted: true } : {}) });
    },
  });
}

// ── figma_sign_off ──────────────────────────────────────────────────────────

/** §3.6 step 3: the motion audit at the delivery fps over each deliverable, recorded for the motion gate's final render. */
async function motionChecks(
  bridge: Bridge,
  motion: MotionProcess | undefined,
  nodeIds: readonly string[],
  fps: number,
  session: string | undefined,
  signal: AbortSignal,
): Promise<{ blockers: Blocker[]; checks: CheckSummary[]; noted: Array<{ frameId: string; session: string; ok: boolean; plan: string | null; accepted: Array<{ rule: string; name: string; frame: number; frames?: [number, number]; reason: string }> }> }> {
  const blockers: Blocker[] = [];
  const checks: CheckSummary[] = [];
  const noted: Array<{ frameId: string; session: string; ok: boolean; plan: string | null; accepted: Array<{ rule: string; name: string; frame: number; frames?: [number, number]; reason: string }> }> = [];
  const sid = await sessionIdOf(bridge, session);
  for (const nodeId of nodeIds) {
    const began = { at: Date.now(), epoch: writeEpoch() };
    let snapshot: MotionSnapshot;
    try {
      snapshot = (await bridge.request("check_motion", { nodeId }, { ...(session !== undefined ? { session } : {}), signal })) as MotionSnapshot;
      if (!snapshot || typeof snapshot !== "object" || !snapshot.root || !Array.isArray(snapshot.nodes)) throw new BridgeError(ErrorCode.INTERNAL, "The plugin's check_motion answered without a snapshot.");
    } catch (err) {
      blockers.push({ what: `the motion check of ${nodeId} failed: ${err instanceof Error ? err.message : String(err)}`, call: checkCall(nodeId, fps) });
      checks.push({ name: "motion", ok: false, errors: 1, warnings: 0, infos: 0, unanswered: 0 });
      continue;
    }
    const plan = snapshot.plan ?? null;
    const label = `"${snapshot.root.name}" (${snapshot.root.id})`;
    if (!plan) blockers.push({ what: `${label} has no motion plan${snapshot.planInvalid ? ` (${snapshot.planInvalid})` : ""}`, call: planCall(snapshot.root.id) });
    // The plan's own check, as figma_check_motion runs it whole (tools/check-motion.ts withPlan),
    // its layers named as the snapshot lists them [C-199].
    const { opts } = withPlan({ fps }, planAsListed(plan, snapshot));
    const wholeCall = `${checkCall(snapshot.root.id, fps).slice(0, -2)}, maxNodes: 5000 }`;
    // A brand or CTA layer the check did not find: a blocker with what clears it, as figma_check_motion words it.
    const missing = (["brandId", "ctaId"] as const).filter((k) => opts[k] !== undefined && !snapshot.nodes.some((n) => n.id === opts[k]));
    for (const k of missing) {
      const named = plan?.[k] ?? opts[k]!;
      const { hint, replan } = missingLayerHint(snapshot, named);
      blockers.push({
        what: `the motion plan of ${label} names \`${k}\` ${named}, which the check did not find: ${hint}`,
        call: replan ? planCall(snapshot.root.id) : snapshot.truncated ? wholeCall : checkCall(snapshot.root.id, fps),
      });
    }
    if (missing.length) {
      // A cut read may hide the layer: say so too, whatever the hint above.
      if (snapshot.truncated && !blockers.some((b) => b.call === wholeCall)) blockers.push({ what: `the motion check read only part of ${label} (maxNodes)`, call: wholeCall });
      checks.push({ name: "motion", ok: false, errors: missing.length, warnings: 0, infos: 0, unanswered: 0 });
      continue;
    }
    const result = auditMotion(snapshot, opts);
    const accepted = (result.accepted ?? []).map((i) => ({ rule: i.rule, name: i.name, frame: i.frame, ...(i.frames ? { frames: i.frames } : {}), reason: i.reason }));
    const whole = !snapshot.truncated;
    // Recorded under every id the page lists the frame under, so a final render naming either finds it [C-199].
    for (const frameId of rootHandles(snapshot)) {
      motion?.noteCheck(frameId, { ok: result.ok, fps: result.fps, full: whole, gaps: [], plan: planKey(plan), epoch: began.epoch, at: began.at, accepted }, sid);
      noted.push({ frameId, session: sid, ok: result.ok && whole, plan: planKey(plan), accepted });
    }
    checks.push({ name: "motion", ok: result.ok && whole, errors: result.counts.error, warnings: result.counts.warning, infos: result.counts.info, unanswered: 0 });
    if (!result.ok) {
      blockers.push({ what: `figma_check_motion found ${result.counts.error} errors and ${result.counts.warning} warnings at ${fps} fps on ${label}`, call: checkCall(snapshot.root.id, fps) });
    }
    if (!whole) blockers.push({ what: `the motion check read only part of ${label} (maxNodes)`, call: wholeCall });
  }
  return { blockers, checks, noted };
}

async function signOff(bridge: Bridge, roles: RoleProcess | undefined, motion: MotionProcess | undefined, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const key = args.idempotencyKey as string | undefined;
  const refuse = (err: unknown) => errorResult(err instanceof BridgeError ? err.withKey(key) : err, { unchanged: true });
  let addressed: Awaited<ReturnType<typeof addressCall>>;
  let briefId: string | undefined;
  try {
    const named = [args.nodeId, args.nodeIds, args.deck].filter((v) => v !== undefined && v !== false).length;
    if (named > 1) throw invalid("Pass one of `nodeId`, `nodeIds` and `deck`.");
    briefId = idOf(args.briefId, "briefId");
    addressed = await addressCall(bridge, "sign_off", pick(args, ["nodeId", "nodeIds", "answers"]), args.session as string | undefined);
  } catch (err) {
    return refuse(err);
  }
  const session = addressed.session;
  const file = await fileOf(bridge, session);
  const nodeIds: string[] =
    (addressed.params.nodeIds as string[] | undefined) ??
    (typeof addressed.params.nodeId === "string" ? [addressed.params.nodeId] : args.deck === true && file.pageId ? [file.pageId] : []);

  // The brief (§3.6): the one named; else the one whose work the node is (its own record, a frame's
  // around it, a brief listing it), so a UX screen signed off while a motion brief is in force is
  // the UX brief's; else the one in force; else its page's — a page holds where work sits, not what it is.
  let record: BriefRecord | undefined;
  try {
    const inForce = roles?.inForce(file.key)?.briefId;
    let onPage: BriefRecord | undefined;
    if (briefId === undefined && nodeIds.length) {
      const read = await readBrief(bridge, { nodeId: nodeIds[0] }, session, extra.signal);
      if (read.from === "page" && inForce !== undefined) onPage = read.brief;
      else record = read.brief;
    }
    briefId ??= record ? undefined : inForce;
    if (!record && briefId !== undefined) {
      const read = await readBrief(bridge, { briefId }, session, extra.signal);
      record = read.brief ?? onPage;
    }
  } catch (err) {
    return refuse(err);
  }
  if (!record) {
    const answer = noBriefAnswer(nodeIds.length ? nodeIds : briefId ? [briefId] : []);
    const strict = modeOf(roles, file) === "strict";
    return refuse(new BridgeError(strict ? ErrorCode.PROCESS_REQUIRED : ErrorCode.INVALID_PARAM, answer.message, { hint: answer.hint, partial: { created: [], missing: answer.missing } }));
  }
  const deliverables = nodeIds.length ? nodeIds : record.deliverables;
  if (deliverables.length === 0) {
    return refuse(invalid("Name the deliverables: `nodeId`, `nodeIds` or `deck: true`. The brief lists none yet.", `figma_sign_off { briefId: "${record.id}", nodeIds: [<the top-level frames>], lenses, rounds }`));
  }
  const set = signOffSet(record.role, record.gear);
  if (!set) return refuse(invalid(`The ${record.role} role has no sign-off at the ${record.gear} gear.`));

  // The server's checks first (§3.6): each failure is a blocker, recorded with the attempt.
  const blockers: Blocker[] = [...briefGaps(record)];
  // Styleframes that no longer resolve are not a record of anything.
  if (isFullGear(record.gear) && record.styleframes?.length) {
    try {
      const info = (await bridge.request("get_nodes_info", { nodeIds: record.styleframes, depth: 0, includeGeometry: false }, { ...(session !== undefined ? { session } : {}), signal: extra.signal })) as {
        items?: Array<{ id: string; ok: boolean }>;
      } | null;
      const gone = (info?.items ?? []).filter((i) => !i.ok).map((i) => i.id);
      if (gone.length) blockers.push({ what: `the brief's styleframes ${gone.join(", ")} no longer resolve`, call: `figma_set_brief { briefId: "${record.id}", styleframes }` });
    } catch {
      // Unread, so not judged: the plugin's own checks still run.
    }
  }
  const lenses = withReviewers(args.lenses as LensScore[]);
  const rounds = args.rounds as number;
  const judged = judgeLenses(record.role, record.gear, lenses, rounds);
  blockers.push(...judged.blockers);
  // Who scored the cold lenses (W4): at top gear the builder alone does not sign it off.
  const reviewers = judgeReviewers(record.role, record.gear, lenses);
  blockers.push(...reviewers.blockers);
  let motionResult: Awaited<ReturnType<typeof motionChecks>> = { blockers: [], checks: [], noted: [] };
  const fps = (args.fps as number | undefined) ?? (typeof record.details?.fps === "number" ? (record.details.fps as number) : undefined);
  if (set.motion) {
    if (fps === undefined) blockers.push({ what: "no delivery fps: the motion check runs at the rate the piece is delivered at", call: "figma_sign_off { …, fps }" });
    else {
      motionResult = await motionChecks(bridge, motion, deliverables, fps, session, extra.signal);
      blockers.push(...motionResult.blockers);
    }
  }

  const answers = (addressed.params.answers as unknown[] | undefined) ?? [];
  const placeholders = (args.placeholders as string[] | undefined) ?? [];
  const params: Record<string, unknown> = {
    briefId: record.id,
    nodeIds: deliverables,
    audits: [...set.audits],
    ...(set.tokensWhenSystem ? { tokensWhenSystem: true } : {}),
    answerKinds: [...set.answer],
    answers,
    lenses,
    rounds,
    exceptions: judged.exceptions,
    placeholders,
    serverBlockers: blockers.map((b) => `${b.what}: ${b.call}`),
    build: { server: VERSION, skills: SKILLS_VERSION },
  };
  const result = await forwardTool(bridge, "sign_off", params, extra, {
    session,
    idempotencyKey: key,
    shape: (data) => {
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const issues = (Array.isArray(d.issues) ? d.issues : []) as Array<{ kind: string; severity: string; nodeId: string; name: string; detail: string }>;
      const unanswered = (Array.isArray(d.unanswered) ? d.unanswered : []) as Array<{ kind: string; nodeId: string; name: string; detail: string }>;
      const ok = d.ok === true && blockers.length === 0;
      const signedAt = typeof d.signedAt === "string" ? d.signedAt : undefined;
      if (ok && signedAt) {
        roles?.signedOff(file.key, record.id, signedAt, deliverables);
        // The sign-off's own write moved writeEpoch(): the audit it ran still holds for the frames it judged (§3.10).
        const now = { epoch: writeEpoch(), at: Date.now() };
        for (const n of motionResult.noted) {
          motion?.noteCheck(n.frameId, { ok: n.ok, fps: fps!, full: true, gaps: [], plan: n.plan, epoch: now.epoch, at: now.at, accepted: n.accepted }, n.session);
        }
      } else if (record.status === "open") {
        roles?.hold(file.key, record, "adopted");
      }
      const more = typeof d.moreIssues === "number" ? d.moreIssues : 0;
      const all = [
        ...blockers,
        ...issueBlockers(issues, unanswered, set.answer),
        ...(more > 0 ? [{ what: `and ${more} more errors and warnings past the ${issues.length} listed`, call: "figma_check_layout on each deliverable lists them all" }] : []),
      ];
      return okResult({
        ok,
        briefId: record.id,
        // The plugin records a failing attempt too; only a pass is a signature.
        ...(ok && signedAt ? { signedAt } : {}),
        ...(typeof d.briefStatus === "string" ? { briefStatus: d.briefStatus } : {}),
        blockers: all,
        exceptions: judged.exceptions,
        independent: reviewers.review.independent,
        ...(reviewers.review.selfReviewed ? { selfReviewed: true } : {}),
        checks: [...(Array.isArray(d.checks) ? d.checks : []), ...motionResult.checks],
        // Audits this plugin build does not run yet: reported, never counted as passed, never a blocker.
        ...(Array.isArray(d.notRun) && d.notRun.length ? { notRun: d.notRun } : {}),
        // Under a motion brief, what the layout check left to the frames (roles spec §3.6): said, never hidden.
        ...(d.restPose && typeof d.restPose === "object" ? { restPose: d.restPose } : {}),
        unanswered: unanswered.map((u) => ({ kind: u.kind, nodeId: u.nodeId, name: u.name, detail: u.detail })),
        ...(typeof d.moreUnanswered === "number" ? { moreUnanswered: d.moreUnanswered } : {}),
        ...(d.fingerprints ? { fingerprints: d.fingerprints } : {}),
        ...(typeof d.indexOn === "string" ? { indexOn: d.indexOn } : {}),
        ...(typeof d.note === "string" ? { note: d.note } : {}),
        report: {
          // First, as the base workflow asks: a review that was not cold says so before anything else.
          reviewed: reviewedLine(record.role, record.gear, lenses),
          assumptions: record.lines.assumptions ?? [],
          briefAsBuilt: {
            role: record.role,
            gear: record.gear,
            title: record.title,
            goal: record.lines.goal,
            message: record.lines.message,
            ...(record.lines.audience ? { audience: record.lines.audience } : {}),
            success: record.lines.success,
            ...(record.lines.tone ? { tone: record.lines.tone } : {}),
            ...(record.lines.format ? { format: record.lines.format } : {}),
            details: record.details ?? {},
          },
          direction: { ...pick(record as unknown as Record<string, unknown>, ["direction0", "chosen", "directions"]) },
          scores: { lenses, rounds, budget: ROUND_BUDGET[record.gear] },
          kept: answers,
          placeholders,
          where: { deliverables, brief: record.id },
        },
      });
    },
  });
  return result;
}
