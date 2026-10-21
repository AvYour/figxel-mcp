// Roles: the professional each kind of new work needs, and what that
// professional records before and after the work (the role process, spec ADR
// #42; design in docs/superpowers/plans/2026-10-14-roles-spec.md).
//
// A designer writes a brief before the first frame and signs the work off at
// the end; what goes in between depends on the role. A UI/UX designer plans a
// flow and the states of every screen before drawing, and tests states,
// accessibility, copy and usability before calling it done; a brand designer
// tests a mark at its smallest size and in one colour; a presentation designer
// writes the story before any slide. This table is the one place those
// differences live: the server reads it to gate new work and to check a brief
// (src/server/role-process.ts, tools/brief.ts), and the plugin reads it to run
// the role's audits at sign-off (src/plugin/ops/brief.ts).
//
// Records live in the file, in shared plugin data under the namespace the
// storyboard record and the motion plan already use [C-188]: the brief on its
// block (or on the node it was stored on), a sign-off on each deliverable, and
// an index of briefs on the document root.
//
// No runtime dependencies: the plugin bundles this (ES2017).

import { STORYBOARD_NAMESPACE } from "./storyboard.js";

export const ROLE_IDS = ["ux", "graphic", "illustration", "brand", "presentation", "design-system", "board", "motion"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** How much is asked: a part of something (section), a whole piece (page), a piece that must stand out (top), a copy of code (replica); motion has its own three. */
export const GEARS = ["section", "page", "top", "replica", "micro", "sting", "piece"] as const;
export type Gear = (typeof GEARS)[number];

/** Gears at which the design skill's seven brief lines, directions and styleframes are asked for. */
export const FULL_GEARS: readonly Gear[] = ["page", "top", "piece"];

/** The critique rounds a gear may spend before what is left is reported instead of fixed (C-239). */
export const ROUND_BUDGET: Readonly<Record<Gear, number>> = { section: 1, page: 2, top: 3, replica: 1, micro: 1, sting: 1, piece: 3 };

/** Every figma_check_layout audit a role's sign-off may run. */
export type AuditName =
  | "tokens" | "names" | "fonts" | "board" | "craft" | "tells" | "handoff"
  | "a11y" | "states" | "copy" | "system" | "deck" | "mark" | "icons" | "library";

/** What sign-off runs and asks for at one gear. */
export interface SignOffSet {
  /** figma_check_layout audits; they must come back ok (no error, no warning). */
  audits: readonly AuditName[];
  /** Also `tokens` when the file has a design system to bind to. */
  tokensWhenSystem?: boolean;
  /** The critique lenses the agent scores (critique skill); each ≥ 8 with verdict pass, or at the round budget an exception with what remains. */
  lenses: readonly string[];
  /** Infos of these audits that remain must each be fixed or answered with a reason. */
  answer: readonly AuditName[];
  /** Run the motion audit (figma_check_motion's rules) at the delivery fps. */
  motion?: boolean;
}

/** A `details` key of a role's brief. */
export interface DetailKey {
  name: string;
  /** Required at these gears (on a new brief in strict; always at sign-off). */
  requiredAt: readonly Gear[];
}

/** Lines of the brief recorded as the work goes, required at sign-off at the full gears. */
export type LaterLine = "direction0" | "directions" | "chosen" | "styleframes" | "system";

export interface RoleDef {
  id: RoleId;
  /** The professional the agent acts as. */
  professional: string;
  /** The figma_get_guide topic read before the brief. */
  skill: string;
  /** A section of that skill that is the role's own (illustration lives in the graphic skill). */
  skillSection?: string;
  /** The skill read instead while `skill` is not in this build (a later wave adds it). */
  fallbackSkill?: string;
  /** At the full gears the design skill is read too. */
  designAtFullGears: boolean;
  /** At the full gears the design skill's brief lines are asked for (audience, proof, constraints, givens, tone, format). */
  designLines: boolean;
  gears: readonly Gear[];
  /** The key `details` is filed under in the record, and its keys. Unknown keys are refused. */
  details: readonly DetailKey[];
  /** Recorded later, required at sign-off at the full gears. */
  later: readonly LaterLine[];
  /** Sign-off by gear. */
  signOff: Partial<Record<Gear, SignOffSet>>;
  /** Words in a request that point at this role, for the skills' routing rule and the classifier's hints. */
  triggers: readonly string[];
}

const ALL_STILL: readonly Gear[] = ["section", "page", "top"];
const FULL: readonly Gear[] = ["page", "top"];

const UX_FULL: SignOffSet = {
  audits: ["craft", "a11y", "states", "copy", "tells", "system"],
  tokensWhenSystem: true,
  lenses: ["message", "usability", "accessibility", "type and composition", "colour and imagery", "copy", "originality", "finish QA"],
  answer: ["craft", "tells"],
};
const GRAPHIC_FULL: SignOffSet = {
  audits: ["craft", "tells", "system", "copy"],
  lenses: ["message", "type and composition", "colour and imagery", "copy", "originality", "finish QA"],
  answer: ["craft", "tells"],
};
const ILLUSTRATION: SignOffSet = { audits: ["craft", "icons", "system"], lenses: ["recognition", "consistency", "finish QA"], answer: ["craft"] };
const BRAND: SignOffSet = {
  audits: ["craft", "tells", "mark", "system"],
  lenses: ["positioning", "mark", "type and composition", "colour", "originality", "finish QA"],
  answer: ["craft", "tells"],
};
const PRESENTATION: SignOffSet = {
  audits: ["craft", "tells", "deck", "copy", "system"],
  lenses: ["story", "type and composition", "colour and imagery", "copy", "originality", "finish QA"],
  answer: ["craft", "tells"],
};
const DESIGN_SYSTEM: SignOffSet = {
  audits: ["tokens", "names", "fonts", "states", "library", "a11y"],
  lenses: ["completeness", "naming", "tokens", "documentation", "finish QA"],
  answer: [],
};
const BOARD: SignOffSet = { audits: ["board"], lenses: ["purpose and reading order", "structure", "copy", "finish QA"], answer: [] };
const MOTION: SignOffSet = { audits: ["craft"], lenses: ["motion craft", "design and type", "technical QA", "the brief's own lens"], answer: ["craft"], motion: true };

export const ROLES: Readonly<Record<RoleId, RoleDef>> = {
  ux: {
    id: "ux",
    professional: "senior UI/UX (product) designer",
    skill: "ux",
    designAtFullGears: true,
    designLines: true,
    gears: ["section", "page", "top", "replica"],
    details: [
      { name: "platform", requiredAt: ["section", "page", "top"] }, // web, ios, android, desktop, responsive
      { name: "viewport", requiredAt: ["section", "page", "top"] }, // "390x844" or a list
      { name: "task", requiredAt: ["section", "page", "top"] },
      { name: "screens", requiredAt: FULL }, // [{ name, states[] }]
      { name: "a11y", requiredAt: [] }, // "AA" (default) or "AAA"
      { name: "controls", requiredAt: [] }, // names of interactive layers the audits should treat as controls
      { name: "insets", requiredAt: [] }, // { top, bottom, source } in device units
      { name: "source", requiredAt: ["replica"] }, // the code path a replica copies
    ],
    later: ["direction0", "directions", "chosen", "styleframes", "system"],
    signOff: {
      section: { audits: ["craft", "a11y", "states", "copy"], lenses: ["message", "accessibility", "type and composition", "finish QA"], answer: ["craft"] },
      page: UX_FULL,
      top: UX_FULL,
      replica: { audits: ["craft", "fonts", "a11y"], lenses: ["finish QA"], answer: [] },
    },
    triggers: ["screen", "app", "web app", "website", "landing page", "dashboard", "onboarding", "sign-up", "log-in", "checkout", "settings", "form", "flow", "wireframe", "modal", "dialog", "drawer", "navigation", "empty state", "mobile", "iOS", "Android", "desktop app", "admin"],
  },
  graphic: {
    id: "graphic",
    professional: "senior graphic designer",
    skill: "graphic",
    fallbackSkill: "design",
    designAtFullGears: true,
    designLines: true,
    gears: ALL_STILL,
    details: [
      { name: "medium", requiredAt: ALL_STILL }, // print, social, ooh, web, editorial, packaging
      { name: "viewing", requiredAt: ALL_STILL }, // "a phone feed, under 2 s"
      { name: "bleedMm", requiredAt: [] }, // required for print (checked by the server)
      { name: "placements", requiredAt: [] },
    ],
    later: ["direction0", "directions", "chosen", "styleframes", "system"],
    signOff: { section: { audits: ["craft", "system"], lenses: ["message", "type and composition", "finish QA"], answer: ["craft"] }, page: GRAPHIC_FULL, top: GRAPHIC_FULL },
    triggers: ["poster", "flyer", "ad", "banner", "social post", "carousel", "story", "thumbnail", "cover", "editorial", "spread", "magazine", "menu", "invitation", "certificate", "infographic", "label", "print", "billboard", "OOH", "signage"],
  },
  illustration: {
    id: "illustration",
    professional: "senior illustrator and iconographer",
    skill: "graphic",
    skillSection: "illustration",
    fallbackSkill: "design",
    designAtFullGears: true,
    designLines: true,
    gears: ALL_STILL,
    details: [
      { name: "set", requiredAt: ALL_STILL },
      { name: "grid", requiredAt: ALL_STILL }, // { size, padding, stroke?, corner? }
      { name: "sizes", requiredAt: ALL_STILL }, // px it renders at
      { name: "style", requiredAt: ALL_STILL },
    ],
    later: ["direction0", "directions", "chosen"],
    signOff: {
      section: ILLUSTRATION,
      page: { ...ILLUSTRATION, lenses: [...ILLUSTRATION.lenses, "originality"] },
      top: { ...ILLUSTRATION, lenses: [...ILLUSTRATION.lenses, "originality"] },
    },
    triggers: ["icon", "icon set", "pictogram", "illustration", "spot illustration", "hero illustration", "pattern", "mascot", "sticker", "badge"],
  },
  brand: {
    id: "brand",
    professional: "senior brand and identity designer",
    skill: "brand",
    fallbackSkill: "design",
    designAtFullGears: true,
    designLines: true,
    gears: ALL_STILL,
    details: [
      { name: "name", requiredAt: ALL_STILL },
      { name: "positioning", requiredAt: ALL_STILL },
      { name: "attributes", requiredAt: ALL_STILL }, // three words
      { name: "markType", requiredAt: ALL_STILL },
      { name: "applications", requiredAt: ALL_STILL }, // [{ name, sizePx }]
      { name: "versions", requiredAt: [] }, // default: full colour, one colour, reversed
      { name: "clearSpace", requiredAt: [] }, // "1x = cap height"
    ],
    later: ["direction0", "directions", "chosen", "styleframes", "system"],
    signOff: { section: BRAND, page: BRAND, top: BRAND },
    triggers: ["logo", "wordmark", "logotype", "monogram", "lettermark", "symbol", "brand mark", "identity", "rebrand", "brand guidelines", "brand colours", "favicon", "app icon", "business card", "letterhead"],
  },
  presentation: {
    id: "presentation",
    professional: "senior presentation designer",
    skill: "slides",
    designAtFullGears: true,
    designLines: true,
    gears: ALL_STILL,
    details: [
      { name: "room", requiredAt: ALL_STILL }, // projected, screen, both
      { name: "minutes", requiredAt: [] },
      { name: "slides", requiredAt: [] },
      { name: "arc", requiredAt: ALL_STILL },
      { name: "notes", requiredAt: [] }, // boolean
      { name: "maxWords", requiredAt: [] },
    ],
    later: ["direction0", "directions", "chosen", "styleframes", "system"],
    signOff: { section: PRESENTATION, page: PRESENTATION, top: PRESENTATION },
    triggers: ["deck", "slides", "presentation", "pitch deck", "keynote", "investor deck", "sales deck", "webinar"],
  },
  "design-system": {
    id: "design-system",
    professional: "senior design-system designer",
    skill: "design-system",
    designAtFullGears: false,
    designLines: false,
    gears: ["section", "page", "top", "replica"],
    details: [
      { name: "scope", requiredAt: ["section", "page", "top"] }, // tokens, components, both
      { name: "platforms", requiredAt: [] },
      { name: "modes", requiredAt: [] },
      { name: "source", requiredAt: ["replica"] },
      { name: "components", requiredAt: [] },
      // Its sign-off runs a11y, which measures targets in the platform's units.
      { name: "platform", requiredAt: [] },
      { name: "viewport", requiredAt: [] },
    ],
    later: [],
    signOff: { section: DESIGN_SYSTEM, page: DESIGN_SYSTEM, top: DESIGN_SYSTEM, replica: DESIGN_SYSTEM },
    triggers: ["design system", "tokens", "variables", "theme", "light/dark mode", "component library", "UI kit", "components with variants"],
  },
  board: {
    id: "board",
    professional: "workshop and information designer",
    skill: "figjam",
    designAtFullGears: false,
    designLines: false,
    gears: ["section", "page"],
    details: [
      { name: "purpose", requiredAt: ["section", "page"] },
      { name: "participants", requiredAt: ["section", "page"] },
      { name: "activity", requiredAt: ["section", "page"] },
      { name: "outcome", requiredAt: ["section", "page"] },
      { name: "minutes", requiredAt: [] },
    ],
    later: [],
    signOff: { section: BOARD, page: BOARD },
    triggers: ["FigJam", "board", "workshop", "retro", "brainstorm", "journey map", "affinity map", "flowchart", "sitemap", "kanban"],
  },
  motion: {
    id: "motion",
    professional: "senior motion designer",
    skill: "storyboard",
    designAtFullGears: false,
    designLines: true,
    gears: ["micro", "sting", "piece"],
    details: [
      { name: "placement", requiredAt: ["micro", "sting", "piece"] },
      { name: "durationS", requiredAt: ["micro", "sting", "piece"] },
      { name: "fps", requiredAt: ["micro", "sting", "piece"] },
    ],
    later: [],
    signOff: { micro: MOTION, sting: MOTION, piece: { ...MOTION, lenses: [...MOTION.lenses, "originality"] } },
    triggers: ["animate", "animation", "motion", "reel", "video ad", "title", "end card", "logo sting", "loop", "animated icon", "micro-interaction", "GIF", "MP4"],
  },
};

/** The skills whose reading counts as reading a role's skill: its own, or (motion) the motion skill too. */
export function skillsFor(role: RoleId): readonly string[] {
  return role === "motion" ? ["storyboard", "motion"] : [ROLES[role].skill];
}

export const isRole = (v: unknown): v is RoleId => typeof v === "string" && (ROLE_IDS as readonly string[]).indexOf(v) >= 0;
export const isGear = (v: unknown): v is Gear => typeof v === "string" && (GEARS as readonly string[]).indexOf(v) >= 0;
export const gearFits = (role: RoleId, gear: Gear): boolean => ROLES[role].gears.indexOf(gear) >= 0;
export const isFullGear = (gear: Gear): boolean => FULL_GEARS.indexOf(gear) >= 0;

/** Words every default claims; a brief's tone takes its three words from the subject and the audience instead. */
export const TONE_BANNED: readonly string[] = ["modern", "clean", "premium", "elegant"];

/**
 * Target sizes by platform, in device units, for the a11y audit (decision on
 * the verified standards: WCAG 2.2 SC 2.5.8 and 2.5.5 on the web, Apple's
 * minimum and default control sizes on iOS, Android's 48 dp). `minimum` is a
 * warning below it, `recommended` an info below it; `spacing` the gap the
 * platform asks between targets.
 */
export const PLATFORM_TARGETS = {
  web: { unit: "CSS px", minimum: 24, recommended: 44, spacing: 24 },
  responsive: { unit: "CSS px", minimum: 24, recommended: 44, spacing: 24 },
  desktop: { unit: "CSS px", minimum: 24, recommended: 44, spacing: 24 },
  ios: { unit: "pt", minimum: 28, recommended: 44, spacing: 0 },
  android: { unit: "dp", minimum: 48, recommended: 48, spacing: 8 },
} as const;
export type Platform = keyof typeof PLATFORM_TARGETS;
export const PLATFORMS = ["web", "responsive", "desktop", "ios", "android"] as const;

/** The smallest text a platform's own type styles go down to, in device units (Apple's table; web and Android give none). */
export const PLATFORM_MIN_TEXT: Partial<Record<Platform, number>> = { ios: 11 };

// ── records in the file ─────────────────────────────────────────────────────

export const BRIEF_NAMESPACE = STORYBOARD_NAMESPACE;
export const BRIEF_KEY = "brief";
export const SIGN_OFF_KEY = "signOff";
export const BRIEF_INDEX_KEY = "briefIndex";

export const BRIEF_LIMITS = {
  /** setSharedPluginData caps one entry at 100 kB [C-188]; a margin under it, as the motion plan keeps. */
  bytes: 90_000,
  title: 80,
  message: 200,
  text: 600,
  list: 30,
  /** Index entries kept on the document root, newest first. */
  index: 200,
  deliverables: 200,
  answers: 200,
} as const;

export interface Direction {
  name: string;
  idea: string;
  /** The score it got when the directions were compared (design skill). */
  total?: number;
}

export interface SystemNumbers {
  bodySize: number;
  ratio?: number;
  sizes?: number[];
  spacingBase?: number;
  grid?: { columns: number; gutter: number; margin: number };
  palette?: Array<{ hex: string; role: string }>;
}

export interface BriefLines {
  goal: string;
  message: string;
  success: string[];
  audience?: string;
  proof?: string[];
  constraints?: string[];
  givens?: string;
  tone?: { words: string[]; not?: string };
  format?: string;
  minTextSize?: number;
  safeArea?: string;
  assumptions?: string[];
  references?: string[];
  defaultToAvoid?: string;
}

export type BriefStatus = "open" | "signed";

/** The brief, stored on its block or on the node it was given (key "brief"). */
export interface BriefRecord {
  v: 1;
  /** The id of the node the record is stored on. */
  id: string;
  role: RoleId;
  gear: Gear;
  title: string;
  status: BriefStatus;
  createdAt: string;
  updatedAt: string;
  lines: BriefLines;
  details: Record<string, unknown>;
  /** Tells kinds the work must not show (src/shared/avoid.ts): at the page and top gears each finding of one is a warning. */
  avoid?: string[];
  direction0?: string;
  directions?: Direction[];
  chosen?: string;
  /** Node ids of the styleframes. */
  styleframes?: string[];
  system?: SystemNumbers;
  /** Node ids of the work the brief covers: top-level frames, component sets, sections, or the page for a deck. */
  deliverables: string[];
  lastSignOff?: { at: string; ok: boolean };
}

export interface CheckSummary {
  name: AuditName | "motion";
  ok: boolean;
  errors: number;
  warnings: number;
  infos: number;
  unanswered: number;
}

/**
 * Who scored a lens (role quality W4): the agent that built the piece
 * ("self"), the person who asked for it ("owner"), or another agent by the
 * name it gives ("agent:<name>"), one that saw the brief, the references and
 * the renders and nothing of the build. Declared, not proven: the record and
 * the report say who, and a self-review is never reported as independent
 * (base workflow decisions §10.1).
 */
export type Reviewer = "self" | "owner" | `agent:${string}`;

/** A reviewer as figma_sign_off takes one; an agent's name is 1–40 letters, digits, ".", "_" or "-", starting with a letter or digit. */
export const REVIEWER_FORM = /^(self|owner|agent:[A-Za-z0-9][A-Za-z0-9._-]{0,39})$/;

export const isReviewer = (v: unknown): v is Reviewer => typeof v === "string" && REVIEWER_FORM.test(v);

export interface LensScore {
  lens: string;
  score: number;
  verdict: "pass" | "fix";
  remaining?: string[];
  /** Who scored it; absent reads as "self" (a record from before reviewers has none). */
  reviewer?: Reviewer;
}

/** The reviewer of a lens score: its own, or "self". */
export const reviewerOf = (l: { reviewer?: unknown }): Reviewer => (isReviewer(l.reviewer) ? l.reviewer : "self");

/**
 * The lenses a builder cannot judge in its own work, so a cold reviewer
 * scores them (base workflow decisions §10.2, role quality W4): what the work
 * says — the message lens, or the role's own lens for it — and originality.
 * Only the ones the gear's sign-off scores count.
 */
const COLD_LENSES: Readonly<Record<RoleId, readonly string[]>> = {
  ux: ["message", "originality"],
  graphic: ["message", "originality"],
  illustration: ["recognition", "originality"],
  brand: ["positioning", "originality"],
  presentation: ["story", "originality"],
  "design-system": [],
  board: [],
  motion: ["the brief's own lens", "originality"],
};

/** The gears whose sign-off needs the cold lenses from a reviewer other than the builder: top, and motion's piece. */
export const INDEPENDENT_GEARS: readonly Gear[] = ["top", "piece"];

/** The gear at which a self-review of the cold lenses passes but is recorded and reported as `selfReviewed`. */
export const SELF_REVIEW_GEAR: Gear = "page";

/** The cold lenses of a role's sign-off at a gear: those of COLD_LENSES its lens set holds, in that order. */
export function coldLenses(role: RoleId, gear: Gear): string[] {
  const set = ROLES[role].signOff[gear];
  return set ? COLD_LENSES[role].filter((l) => set.lenses.indexOf(l) >= 0) : [];
}

const sameLens = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Who reviewed the cold lenses of one sign-off, as the record and the result say it. */
export interface ReviewOf {
  /** The cold lenses of the role at the gear. */
  cold: string[];
  /** Those of them scored by "self" or not scored at all. */
  notIndependent: string[];
  /** Every cold lens scored by a reviewer other than the builder (false when the gear has none). */
  independent: boolean;
  /** Whether the gear requires that (INDEPENDENT_GEARS): sign-off fails without it. */
  required: boolean;
  /** At the page gear: the cold lenses were self-reviewed, which passes and is said so. */
  selfReviewed: boolean;
}

export function reviewOf(role: RoleId, gear: Gear, lenses: ReadonlyArray<Pick<LensScore, "lens" | "reviewer">>): ReviewOf {
  const cold = coldLenses(role, gear);
  // The first score of a lens counts, as judgeLenses reads it.
  const notIndependent = cold.filter((name) => {
    const got = lenses.find((l) => sameLens(l.lens, name));
    return !got || reviewerOf(got) === "self";
  });
  const independent = cold.length > 0 && notIndependent.length === 0;
  return {
    cold,
    notIndependent,
    independent,
    required: cold.length > 0 && INDEPENDENT_GEARS.indexOf(gear) >= 0,
    selfReviewed: cold.length > 0 && !independent && gear === SELF_REVIEW_GEAR,
  };
}

export interface Answer {
  kind: string;
  nodeId: string;
  reason: string;
}

/** A sign-off, stored on each deliverable (key "signOff"), a failing attempt included. */
export interface SignOffRecord {
  v: 1;
  briefId: string;
  role: RoleId;
  gear: Gear;
  at: string;
  ok: boolean;
  /** The deliverable's content fingerprint when it was signed (src/plugin/fingerprint.ts). */
  fingerprint: string;
  checks: CheckSummary[];
  /** Each with its reviewer. */
  lenses: LensScore[];
  /**
   * Whether every cold lens (coldLenses) was scored by a reviewer other than
   * the builder. Absent on a record from before reviewers: read as false.
   */
  independent?: boolean;
  /** At the page gear: the cold lenses were self-reviewed (passes, and is said so). */
  selfReviewed?: true;
  rounds: number;
  answers: Answer[];
  /** Lenses under 8 accepted at the round budget, with what remains. */
  exceptions: LensScore[];
  placeholders: string[];
  build: { server?: string; skills?: string };
  /** Under a motion brief, what the layout check left to the frames (RestPose). */
  restPose?: RestPose;
}

/**
 * Under a motion brief, layout is judged where the viewer sees it (roles spec
 * §3.6): the layers keys move, and by kind the findings that rested on where
 * keys park a layer — not made, and left to the rendered frames.
 */
export interface RestPose {
  moved: number;
  notJudged: Record<string, number>;
}

/** One row of the file's index of briefs (key "briefIndex" on the document root). */
export interface BriefIndexEntry {
  id: string;
  title: string;
  role: RoleId;
  gear: Gear;
  pageId: string;
  status: BriefStatus;
  deliverables: string[];
  updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A stored brief, or why it cannot be read. Checks the shape the gates and sign-off rely on, not every line. */
export function parseBrief(json: string): { brief: BriefRecord } | { invalid: string } {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return { invalid: "the stored brief is not JSON" };
  }
  if (!isObject(v) || v.v !== 1) return { invalid: "the stored brief is not a version 1 record" };
  if (typeof v.id !== "string" || typeof v.title !== "string") return { invalid: "the stored brief has no id or title" };
  if (!isRole(v.role)) return { invalid: `the stored brief names an unknown role ${JSON.stringify(v.role)}` };
  if (!isGear(v.gear)) return { invalid: `the stored brief names an unknown gear ${JSON.stringify(v.gear)}` };
  if (v.status !== "open" && v.status !== "signed") return { invalid: "the stored brief has no status" };
  if (!isObject(v.lines) || typeof v.lines.goal !== "string" || typeof v.lines.message !== "string") return { invalid: "the stored brief has no goal or message" };
  if (!isStringArray(v.deliverables)) return { invalid: "the stored brief lists no deliverables array" };
  return { brief: v as unknown as BriefRecord };
}

/** A stored sign-off, or why it cannot be read. */
export function parseSignOff(json: string): { signOff: SignOffRecord } | { invalid: string } {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return { invalid: "the stored sign-off is not JSON" };
  }
  if (!isObject(v) || v.v !== 1) return { invalid: "the stored sign-off is not a version 1 record" };
  if (typeof v.briefId !== "string" || typeof v.ok !== "boolean" || typeof v.fingerprint !== "string" || typeof v.at !== "string") {
    return { invalid: "the stored sign-off lacks its brief, result, fingerprint or time" };
  }
  return { signOff: v as unknown as SignOffRecord };
}

/** The file's index of briefs; [] for none or an unreadable one. */
export function parseBriefIndex(json: string): BriefIndexEntry[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v.filter((e) => isObject(e) && typeof e.id === "string" && isRole(e.role)) as unknown as BriefIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** The index with `entry` put first (replacing its older row), pruned to BRIEF_LIMITS.index. */
export function upsertIndex(index: readonly BriefIndexEntry[], entry: BriefIndexEntry): BriefIndexEntry[] {
  return [entry, ...index.filter((e) => e.id !== entry.id)].slice(0, BRIEF_LIMITS.index);
}

/** The `details` keys a role requires at a gear. */
export function requiredDetails(role: RoleId, gear: Gear): string[] {
  return ROLES[role].details.filter((d) => d.requiredAt.indexOf(gear) >= 0).map((d) => d.name);
}

/** The sign-off set of a role at a gear (a gear the role does not take has none). */
export function signOffSet(role: RoleId, gear: Gear): SignOffSet | undefined {
  return ROLES[role].signOff[gear];
}
