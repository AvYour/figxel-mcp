// The role process, enforced by the tools (BRIDGE_PROCESS; spec ADR #42,
// docs/superpowers/plans/2026-10-14-roles-spec.md §3).
//
// A designer writes the brief before the first frame and signs the work off
// before it is delivered; the skills teach that order and this module makes
// the tools keep it, beside the motion gate (motion-process.ts), with the
// same three modes and the same refusal (PROCESS_REQUIRED, nothing sent):
//
//   New work (§3.3) waits for a brief in force for its file: a top-level
//     frame or section, a spec into the page or into an empty top-level frame,
//     the first slides of an empty deck, a storyboard. Edits never wait, and
//     the classifier errs toward "edit" (§3.1). With a brief in force the gate
//     reads nothing; without one it asks the plugin once (get_brief), for the
//     target's facts when the parent is not obvious and for the file's open
//     briefs, so a second agent is offered the one to adopt (N2).
//   figma_set_brief waits for the role's skill, and at the page gears for the
//     design skill too (§3.4 step 1), read through the one skill ledger.
//   A final export (figma_export_node, figma_export_frames_to_pdf with
//     `final: true`) waits for a passing sign-off newer than the node's last
//     change, on every node that belongs to a brief (§3.7).
//
// "strict" refuses; "guided" runs the call and lists the step as
// `processWarnings`; "off" tracks nothing. Strict degrades to guided wherever
// it could not be satisfied (§3.9): a toolset without figma_set_brief or
// figma_get_guide, an editor whose set_brief cell is not "yes", and for final
// exports a toolset without figma_sign_off. A plugin that predates briefs is
// refused in strict with the re-run hint the motion gate gives.
//
// The state is this process's, as the motion gate's is: briefs are in force
// per file (the file's key, else its name and editor, since node ids are per
// file), for the briefs this process stored or read. The records themselves
// live in the file (src/plugin/ops/brief.ts), so every process and every later
// session reads the same brief.

import { avoidOf } from "../shared/avoid.js";
import { EDITOR_LABEL, isEditor, supportOf } from "../shared/editors.js";
import { BridgeError, ErrorCode } from "../shared/errors.js";
import {
  isFullGear,
  parseBrief,
  parseSignOff,
  ROLES,
  skillsFor,
  type BriefIndexEntry,
  type BriefRecord,
  type BriefStatus,
  type Gear,
  type RoleId,
  type SignOffRecord,
} from "../shared/roles.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME } from "../shared/version.js";
import type { Bridge } from "./bridge.js";
import type { ProcessMode } from "./config.js";
import { SkillLedger } from "./motion-process.js";
import { SKILLS } from "./skills.js";

/** The ops the new-work gate stands in front of, directly or as batch steps (§3.3). */
export const GATED_OPS: ReadonlySet<string> = new Set(["create_frame", "create_from_spec", "create_section", "create_slides", "create_storyboard"]);

/** Spec roots that make new work at page level: containers. A text, a shape or a button there is a single element (§3.3). */
const SPEC_CONTAINERS: ReadonlySet<string> = new Set(["frame", "component", "section"]);
/** Node types a spec into an empty top-level target makes new work of. */
const EMPTY_TARGETS: ReadonlySet<string> = new Set(["FRAME", "SECTION"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The calls a refusal names. */
export const guideCall = (skill: string, section?: string) => `figma_get_guide { topic: "${skill}"${section ? `, section: "${section}"` : ""} }`;
export const signOffCall = (nodeIds: readonly string[], deck = false) =>
  deck
    ? "figma_sign_off { deck: true, lenses, rounds }"
    : nodeIds.length === 1
      ? `figma_sign_off { nodeId: "${nodeIds[0]}", lenses, rounds }`
      : `figma_sign_off { nodeIds: [${nodeIds.map((id) => `"${id}"`).join(", ")}], lenses, rounds }`;

/** "senior UI/UX designer": the role's professional as a sentence names them. */
export const professionalOf = (role: RoleId) => ROLES[role].professional.replace(/\s*\([^)]*\)/g, "");

// ── what counts as new work ─────────────────────────────────────────────────

/** What get_brief { target } answers: the facts the gate reads, and nothing else (contract § get_brief). */
export interface TargetFacts {
  /** Figma's node type: PAGE, FRAME, SECTION, SLIDE, … */
  type: string;
  /** Whether it sits directly on its page. */
  topLevel: boolean;
  childCount: number;
  /** Figma Slides: whether any slide of the deck has content. */
  deckHasContent?: boolean;
}

export type NewWork =
  | { kind: "edit" }
  | { kind: "new"; what: string }
  /** The parent is not obvious: ask the plugin for these facts, then classify again. */
  | { kind: "ask"; target: { parentId?: string; pageId?: string } };

const EDIT: NewWork = { kind: "edit" };

const rootTypes = (spec: unknown): string[] => (Array.isArray(spec) ? spec : [spec]).map((r) => (isObject(r) && typeof r.type === "string" ? r.type : ""));

/**
 * Whether a call makes new work (spec §3.3), from its own params, the file's
 * editor and, where the parent is not obvious, the target's facts. Returns
 * "ask" once, when those facts are needed; with them it never asks again, and
 * a fact it lacks reads as an edit.
 */
export function classifyNewWork(op: string, params: Record<string, unknown>, facts: { editor?: string | undefined; target?: TargetFacts | undefined } = {}): NewWork {
  const slides = facts.editor === "slides";
  const parentId = typeof params.parentId === "string" ? params.parentId : undefined;
  const pageId = typeof params.pageId === "string" ? params.pageId : undefined;
  const t = facts.target;
  const onPage = t?.type === "PAGE";
  switch (op) {
    case "create_storyboard":
      return { kind: "new", what: "a new storyboard" };
    case "create_frame":
      // In Slides a frame goes on a slide, never on the page.
      if (slides) return EDIT;
      if (parentId === undefined) return { kind: "new", what: "a new top-level frame" };
      if (!t) return { kind: "ask", target: { parentId } };
      return onPage ? { kind: "new", what: "a new top-level frame" } : EDIT;
    case "create_section":
      if (parentId === undefined) return { kind: "new", what: "a new section at page level" };
      if (!t) return { kind: "ask", target: { parentId } };
      return onPage ? { kind: "new", what: "a new section at page level" } : EDIT;
    case "create_slides":
      // Elsewhere the editor gate refuses it, in its own words.
      if (!slides) return EDIT;
      if (!t) return { kind: "ask", target: {} };
      return t.deckHasContent === false ? { kind: "new", what: "the first slides of an empty deck" } : EDIT;
    case "create_from_spec": {
      if (slides) {
        if (!t) return { kind: "ask", target: { ...(parentId !== undefined ? { parentId } : {}), ...(pageId !== undefined ? { pageId } : {}) } };
        return t.deckHasContent === false ? { kind: "new", what: "a spec into a deck with no content" } : EDIT;
      }
      const containers = rootTypes(params.spec).some((type) => SPEC_CONTAINERS.has(type));
      if (parentId === undefined) return containers ? { kind: "new", what: "a spec of a new top-level frame" } : EDIT;
      if (!t) return { kind: "ask", target: { parentId } };
      if (onPage) return containers ? { kind: "new", what: "a spec of a new top-level frame" } : EDIT;
      if (t.topLevel && EMPTY_TARGETS.has(t.type) && t.childCount === 0) return { kind: "new", what: "a spec into an empty top-level frame" };
      return EDIT;
    }
    default:
      // Clones, pages, single shapes, texts, images, instances, components from
      // existing nodes, and every modify and style tool (§3.3).
      return EDIT;
  }
}

// ── the file a call works in ────────────────────────────────────────────────

/** The file a call goes to, as the gates key and judge it. */
export interface FileRef {
  /** Briefs are in force under it: the file's key, else its name and editor. "" while no plugin is connected. */
  key: string;
  sessionId: string | undefined;
  editorType: string | undefined;
  name: string | undefined;
  /** The page the plugin is on. */
  pageId: string | undefined;
  /** The selection the plugin last reported. */
  selection: string[];
  /** BRIDGE_ALLOW_UNVERIFIED of the process holding the connection. */
  allowUnverified: boolean;
}

type Row = {
  sessionId: string;
  active?: boolean;
  editorType?: string;
  file?: { name?: string | null; key?: string | null } | null;
  page?: { id: string } | null;
  selection?: { nodeIds: string[] } | null;
};

/** The key a connected file's briefs are in force under. */
export const fileKeyOf = (row: Pick<Row, "file" | "editorType">): string =>
  row.file?.key || `${row.file?.name ?? "untitled"} (${row.editorType ?? "unknown editor"})`;

export function fileFromRow(row: Row | undefined, allowUnverified: boolean): FileRef {
  if (!row) return { key: "", sessionId: undefined, editorType: undefined, name: undefined, pageId: undefined, selection: [], allowUnverified };
  return {
    key: fileKeyOf(row),
    sessionId: row.sessionId,
    editorType: row.editorType,
    name: row.file?.name ?? undefined,
    pageId: row.page?.id,
    selection: row.selection?.nodeIds ?? [],
    allowUnverified,
  };
}

/**
 * The file `session` names (an id or a file name), else the active one, as
 * the bridge picks for a call without it (motion-process.ts sessionIdOf).
 * Answered by the bridge itself: no plugin read.
 */
export async function fileOf(bridge: Bridge, session: string | undefined): Promise<FileRef> {
  let st: { sessions: Row[]; allowUnverified?: boolean };
  try {
    st = (await bridge.statusAsync()) as unknown as { sessions: Row[]; allowUnverified?: boolean };
  } catch {
    return fileFromRow(undefined, false);
  }
  const rows = st.sessions ?? [];
  const picked =
    session === undefined
      ? (rows.find((s) => s.active) ?? (rows.length === 1 ? rows[0] : undefined))
      : (rows.find((s) => s.sessionId === session) ?? rows.find((s) => (s.file?.name ?? "").toLowerCase() === session.toLowerCase()));
  return fileFromRow(picked, st.allowUnverified === true);
}

// ── the process ─────────────────────────────────────────────────────────────

/** A brief as this process holds it: in force while open, listed by figma_status either way. */
export interface BriefRef {
  briefId: string;
  title: string;
  role: RoleId;
  gear: Gear;
  status: BriefStatus;
  deliverables: string[];
  /** fileKeyOf the file it lives in. */
  file: string;
  /** Stored by figma_set_brief, or adopted by reading it (figma_get_brief). */
  how: "set" | "adopted";
  signedAt?: string;
  /** The brief's avoid list (shared/avoid.ts), when it has one: whether a create's result measures tells. */
  avoid?: string[];
}

const BUNDLED: ReadonlySet<string> = new Set(SKILLS.map((s) => s.short));

export class RoleProcess {
  /** The tools registered on this server: strict holds only where the agent can satisfy it. */
  registered: ReadonlySet<string> = new Set();
  /** BRIDGE_ALLOW_UNVERIFIED of this process. */
  allowUnverified = false;
  /** Per file: the open briefs in force, most recent last. */
  private readonly open = new Map<string, BriefRef[]>();
  /** Every brief this process stored, adopted or signed off, for figma_status. */
  private readonly seen = new Map<string, BriefRef>();

  /**
   * `ledger` is the one the motion process reads too (createApp shares it);
   * `bundled` the skills this build serves (a test passes its own).
   */
  constructor(
    readonly mode: ProcessMode,
    readonly ledger: SkillLedger = new SkillLedger(),
    readonly bundled: ReadonlySet<string> = BUNDLED,
  ) {}

  /** Whether anything is tracked: false only with BRIDGE_PROCESS=off. */
  get active(): boolean {
    return this.mode !== "off";
  }

  /** Why strict cannot hold whatever the file: the toolset lacks a tool the agent would need (§3.9). */
  toolsetDegradation(final = false): string | null {
    if (this.registered.size === 0) return null;
    if (!this.registered.has("figma_set_brief")) return "figma_set_brief is not registered: BRIDGE_TOOLSET has no style group";
    if (!this.registered.has("figma_get_guide")) return "figma_get_guide is not registered: BRIDGE_TOOLSET is none";
    if (final && !this.registered.has("figma_sign_off")) return "figma_sign_off is not registered: BRIDGE_TOOLSET has no style group";
    return null;
  }

  /** Why strict cannot hold in this file's editor: the op the agent would need is not verified there (§3.9). */
  editorDegradation(file: FileRef, op = "set_brief"): string | null {
    if (file.editorType === undefined) return null;
    const cell = supportOf(op, file.editorType);
    if (cell === "yes") return null;
    if (cell === "unmeasured" && (file.allowUnverified || this.allowUnverified)) return null;
    const where = isEditor(file.editorType) ? `${EDITOR_LABEL[file.editorType]} files` : `editorType "${file.editorType}"`;
    return `figma_${op} is not verified in ${where} yet`;
  }

  /** The mode a gate runs in for `file`; `final` for a final export, which needs figma_sign_off. */
  modeFor(file: FileRef, final = false): { mode: "strict" | "guided"; why?: string } {
    if (this.mode !== "strict") return { mode: "guided" };
    const why = this.toolsetDegradation(final) ?? this.editorDegradation(file, final ? "sign_off" : "set_brief");
    return why ? { mode: "guided", why } : { mode: "strict" };
  }

  /** What figma_status shows: "strict", "guided (<why>)", "guided" or "off". */
  label(file: FileRef): string {
    if (!this.active) return "off";
    const m = this.modeFor(file);
    return m.why ? `guided (${m.why})` : m.mode;
  }

  /**
   * The skill a role reads before its brief in this build: its own, or its
   * fallback while its own is not bundled (graphic and brand until wave B);
   * null when neither is, since nothing could satisfy the gate.
   */
  skillOf(role: RoleId): { skill: string; section?: string } | null {
    const r = ROLES[role];
    if (this.bundled.has(r.skill)) return { skill: r.skill, ...(r.skillSection ? { section: r.skillSection } : {}) };
    if (r.fallbackSkill && this.bundled.has(r.fallbackSkill)) return { skill: r.fallbackSkill };
    return null;
  }

  /** The skills figma_set_brief waits for at `gear` that this process has not read, each with the call that reads it. */
  missingSkills(role: RoleId, gear: Gear): Array<{ skill: string; call: string }> {
    const out: Array<{ skill: string; call: string }> = [];
    const own = this.skillOf(role);
    if (own) {
      // The motion role counts the storyboard or the motion skill (skillsFor); a fallback counts only itself.
      const counts = own.skill === ROLES[role].skill ? skillsFor(role) : [own.skill];
      if (!counts.some((s) => this.ledger.has(s))) out.push({ skill: own.skill, call: guideCall(own.skill, own.section) });
    }
    if (ROLES[role].designAtFullGears && isFullGear(gear) && own?.skill !== "design" && this.bundled.has("design") && !this.ledger.has("design")) {
      out.push({ skill: "design", call: guideCall("design", "brief") });
    }
    return out;
  }

  /** The brief in force for a file: the most recent this process stored or read, open. */
  inForce(file: string): BriefRef | undefined {
    const list = this.open.get(file);
    return list?.[list.length - 1];
  }

  /** A brief stored or read: in force for its file while it is open, listed either way. Nothing is tracked when off. */
  hold(file: string, brief: BriefRecord, how: BriefRef["how"]): void {
    if (!this.active) return;
    const before = this.seen.get(`${file}|${brief.id}`);
    const avoid = avoidOf(brief);
    const ref: BriefRef = {
      briefId: brief.id,
      title: brief.title,
      role: brief.role,
      gear: brief.gear,
      status: brief.status,
      deliverables: [...brief.deliverables],
      file,
      how: before?.how ?? how,
      ...(brief.lastSignOff?.ok ? { signedAt: brief.lastSignOff.at } : {}),
      ...(avoid.length ? { avoid } : {}),
    };
    this.seen.set(`${file}|${brief.id}`, ref);
    const list = (this.open.get(file) ?? []).filter((r) => r.briefId !== brief.id);
    if (brief.status === "open") list.push(ref);
    if (list.length) this.open.set(file, list);
    else this.open.delete(file);
  }

  /** A passing sign-off closes its brief: it leaves inForce. */
  signedOff(file: string, briefId: string, at: string, deliverables: readonly string[]): void {
    if (!this.active) return;
    const list = (this.open.get(file) ?? []).filter((r) => r.briefId !== briefId);
    if (list.length) this.open.set(file, list);
    else this.open.delete(file);
    const ref = this.seen.get(`${file}|${briefId}`);
    if (ref) this.seen.set(`${file}|${briefId}`, { ...ref, status: "signed", signedAt: at, deliverables: [...new Set([...ref.deliverables, ...deliverables])] });
  }

  /** Every brief this process stored, adopted or signed, oldest first. */
  briefs(): BriefRef[] {
    return [...this.seen.values()];
  }
}

/**
 * The sentence figma_status's hint adds while this process holds an open
 * brief (§3.8); "" when it holds none.
 */
export function openBriefsSentence(proc: RoleProcess): string {
  const open = proc.briefs().filter((b) => b.status === "open");
  if (open.length === 0) return "";
  const named = open.map((b) => `"${b.title}" (${b.briefId})`).join(", ");
  return open.length === 1
    ? `1 brief is open and not signed off: ${named} — figma_sign_off ends it.`
    : `${open.length} briefs are open and not signed off: ${named} — figma_sign_off ends each.`;
}

/**
 * The brief in force for the file a call goes to, for a tool that reads the
 * brief by default (figma_check_layout's `briefId`, spec §4): its id, or
 * undefined. Reads nothing from the plugin.
 */
export async function briefIdInForce(proc: RoleProcess, bridge: Bridge, session: string | undefined): Promise<string | undefined> {
  if (!proc.active) return undefined;
  return proc.inForce((await fileOf(bridge, session)).key)?.briefId;
}

// ── reading the file's briefs ───────────────────────────────────────────────

/** What get_brief answers, checked: a record that cannot be read is said in `invalid`, never trusted. */
export interface BriefRead {
  brief?: BriefRecord;
  /** How a nodeId read found `brief`: the node's own work, or only its page. A plugin that does not say: "node". */
  from?: "node" | "page";
  signOff?: SignOffRecord;
  fingerprint?: string;
  fresh?: boolean;
  open: BriefIndexEntry[];
  target?: TargetFacts;
  invalid?: string;
}

/** The plugin's answer, each record held to the shape the gates rely on (shared/roles.ts parseBrief, parseSignOff). */
export function briefReadOf(data: unknown): BriefRead {
  const d = isObject(data) ? data : {};
  const out: BriefRead = { open: Array.isArray(d.open) ? (d.open.filter((e) => isObject(e) && typeof e.id === "string") as unknown as BriefIndexEntry[]) : [] };
  if (d.brief !== undefined && d.brief !== null) {
    const parsed = parseBrief(JSON.stringify(d.brief));
    if ("brief" in parsed) {
      out.brief = parsed.brief;
      if (d.from === "node" || d.from === "page") out.from = d.from;
    } else out.invalid = parsed.invalid;
  }
  if (d.signOff !== undefined && d.signOff !== null) {
    const parsed = parseSignOff(JSON.stringify(d.signOff));
    if ("signOff" in parsed) out.signOff = parsed.signOff;
    else out.invalid ??= parsed.invalid;
  }
  if (typeof d.fingerprint === "string") out.fingerprint = d.fingerprint;
  if (typeof d.fresh === "boolean") out.fresh = d.fresh;
  if (typeof d.invalid === "string") out.invalid ??= d.invalid;
  if (isObject(d.target) && typeof d.target.type === "string") {
    const t = d.target;
    out.target = {
      type: t.type as string,
      topLevel: t.topLevel === true,
      childCount: typeof t.childCount === "number" ? t.childCount : 0,
      ...(typeof t.deckHasContent === "boolean" ? { deckHasContent: t.deckHasContent } : {}),
    };
  }
  return out;
}

/** What the bridge says of a plugin without the op, as the motion gate says it of plans. */
const TOO_OLD = /does not implement op/;

/** One get_brief read. A plugin that predates briefs is said to be old, with the re-run hint. */
export async function readBrief(bridge: Bridge, params: Record<string, unknown>, session: string | undefined, signal?: AbortSignal): Promise<BriefRead> {
  let data: unknown;
  try {
    data = await bridge.request("get_brief", params, { ...(session !== undefined ? { session } : {}), ...(signal ? { signal } : {}) });
  } catch (err) {
    if (err instanceof BridgeError && err.code === ErrorCode.UNSUPPORTED && TOO_OLD.test(err.message)) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, "The connected plugin predates briefs, so the file's briefs cannot be read.", {
        hint: `Ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}).`,
      });
    }
    throw err;
  }
  return briefReadOf(data);
}

/** A failed brief read, said as the step of the call it stands in front of. */
function readFailed(tool: string, mode: ProcessMode, err: unknown): BridgeError {
  const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
  return new BridgeError(e.code, `Before ${tool}, ${PRODUCT_NAME} reads the file's briefs (BRIDGE_PROCESS=${mode}), and that read failed: ${e.message}`, {
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    partial: { created: [] },
  });
}

// ── the gates ───────────────────────────────────────────────────────────────

export interface RoleGate {
  /** Strict mode's answer: send nothing, return this. */
  refusal?: BridgeError;
  /** Guided mode's: run the call, and add these as `processWarnings`. */
  warnings: string[];
}

const PASS: RoleGate = { warnings: [] };

const refusal = (message: string, hint: string, missing: string[]) =>
  new BridgeError(ErrorCode.PROCESS_REQUIRED, message, { hint, partial: { created: [], missing } });

/** N1's hint: each role's skill as this build serves it (a role whose skill is not bundled names its fallback). */
export function newWorkHint(proc: RoleProcess): string {
  const topic = (role: RoleId) => proc.skillOf(role)?.skill ?? ROLES[role].skill;
  return (
    `Name the role the request needs and read its skill: figma_get_guide { topic: "${topic("ux")}" } for screens, flows and anything people operate; ` +
    `"${topic("graphic")}" for posters, ads, posts, print, icons and illustration; "${topic("brand")}" for logos and identity; ` +
    `"${topic("presentation")}" for decks; "${topic("design-system")}" for tokens and components; "${topic("board")}" for boards; ` +
    `"${topic("motion")}" for anything that moves. Then figma_set_brief { role, gear, title, goal, message, success } (a page or more adds the ` +
    "design skill's brief lines) and send this call again with the same idempotencyKey. Edits inside existing frames are never gated."
  );
}

/** N1 and N2 (§3.8): new work while no brief is in force, with the file's open briefs. */
export function newWorkAnswer(proc: RoleProcess, tool: string, open: readonly BriefIndexEntry[]): { message: string; hint: string; missing: string[]; warning: string } {
  const intro = `${tool} was refused before any change: a designer writes the brief before the first frame, and no brief is in force for this file in this session`;
  if (open.length === 0) {
    return {
      message: `${intro}. Missing: a brief (figma_set_brief).`,
      hint: newWorkHint(proc),
      missing: ["a brief (figma_set_brief)"],
      warning:
        'no brief is in force for this file: figma_get_guide { topic: "ux" } (or the skill of the role the work needs), then figma_set_brief { role, gear, title, goal, message, success }.',
    };
  }
  const named = open.map((e) => `"${e.title}" (${e.id})`);
  const first = open[0]!.id;
  return {
    message:
      open.length === 1
        ? `${intro}; the file holds an open brief, ${named[0]}, from an earlier session. Missing: a brief in force.`
        : `${intro}; the file holds ${open.length} open briefs, ${named.join(", ")}, from earlier sessions. Missing: a brief in force.`,
    hint:
      open.length === 1
        ? `To continue that work, read it: figma_get_brief { briefId: "${first}" }. For different work, write its own: figma_set_brief { role, gear, … }. Then send this call again.`
        : `To continue one of them, read it: figma_get_brief { briefId: "${first}" }, or another of the ids. For different work, write its own: figma_set_brief { role, gear, … }. Then send this call again.`,
    missing: ["a brief in force"],
    warning: `no brief is in force for this file, which holds ${open.length === 1 ? "an open brief" : "open briefs"}, ${named.join(", ")}: figma_get_brief { briefId: "${first}" } continues it, figma_set_brief { role, gear, … } starts different work.`,
  };
}

/**
 * The gate in front of a create call (§3.3). `params` are already addressed
 * (forward.ts addressCall) and `session` is the one they named. Call it for
 * every create; it passes edits at once, without asking anything.
 */
export async function newWorkGate(
  proc: RoleProcess,
  bridge: Bridge,
  tool: string,
  op: string,
  params: Record<string, unknown>,
  session: string | undefined,
  signal?: AbortSignal,
): Promise<RoleGate> {
  if (!proc.active || !GATED_OPS.has(op)) return PASS;
  const file = await fileOf(bridge, session);
  let work = classifyNewWork(op, params, { editor: file.editorType });
  // A brief in force: nothing to read, no latency added.
  if (work.kind === "edit" || proc.inForce(file.key)) return PASS;
  const { mode } = proc.modeFor(file);
  let read: BriefRead;
  try {
    read = await readBrief(bridge, work.kind === "ask" ? { target: work.target } : {}, file.sessionId ?? session, signal);
  } catch (err) {
    const failed = readFailed(tool, proc.mode, err);
    return mode === "strict" ? { refusal: failed, warnings: [] } : { warnings: [failed.message] };
  }
  if (work.kind === "ask") {
    work = classifyNewWork(op, params, { editor: file.editorType, target: read.target });
    if (work.kind !== "new") return PASS;
  }
  const answer = newWorkAnswer(proc, tool, read.open.filter((e) => e.status === "open"));
  return mode === "strict" ? { refusal: refusal(answer.message, answer.hint, answer.missing), warnings: [] } : { warnings: [answer.warning] };
}

/**
 * B1 (§3.8): figma_set_brief before the role's skill, and at the page gears
 * the design skill. `mode` is the one the gate runs in for the call's file.
 */
export function briefSkillGate(proc: RoleProcess, role: RoleId, gear: Gear, mode: "strict" | "guided"): RoleGate {
  if (!proc.active) return PASS;
  const missing = proc.missingSkills(role, gear);
  if (missing.length === 0) return PASS;
  if (mode === "guided") return { warnings: missing.map((m) => `the ${m.skill} skill has not been read in this session: ${m.call}.`) };
  const own = proc.skillOf(role)?.skill;
  const who = `a ${professionalOf(role)}`;
  const names = missing.map((m) => `the ${m.skill} skill`);
  const message = missing.some((m) => m.skill === own)
    ? `figma_set_brief was refused before any change: ${who} works from the ${own} skill's process, and this session has not read it. Missing: ${names.join("; ")}.`
    : `figma_set_brief was refused before any change: at the ${gear} gear ${who} also works from the design skill's process, and this session has not read it. Missing: ${names.join("; ")}.`;
  return { refusal: refusal(message, `First ${missing.map((m) => m.call).join(", then ")}. Then send this call again.`, names), warnings: [] };
}

/** S1 (§3.8): a sign-off with no brief to check the work against. */
export function noBriefAnswer(nodeIds: readonly string[]): { message: string; hint: string; missing: string[] } {
  const what = nodeIds.length ? nodeIds.join(", ") : "the work";
  return {
    message: `figma_sign_off was refused before any change: a sign-off checks work against its brief, and none covers ${what}. Missing: a brief for ${what}.`,
    hint: "If this is new work, figma_set_brief { role, gear, … } then figma_set_brief { briefId, styleframes, … } as the work goes; if it is an edit of existing work, it needs no sign-off.",
    missing: [`a brief for ${what}`],
  };
}

/** A sign-off's time as the message gives it: minutes, UTC. */
const minute = (iso: string) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? `${iso.slice(0, 16)}Z` : iso);

/** Why a node's sign-off does not clear a final export (E1, E2), or null when it does. */
export function finalBlocker(read: BriefRead, nodeId: string, file: FileRef): string | null {
  if (read.invalid && !read.brief) return `its brief cannot be read (${read.invalid})`;
  const b = read.brief;
  if (!b) return null;
  // A brief stored on the page covers a node only as one of its deliverables,
  // in Design and FigJam; in Slides the page is the deck the brief is for (§3.7).
  const pageBrief = file.pageId !== undefined && b.id === file.pageId && b.id !== nodeId && file.editorType !== "slides";
  if (pageBrief && !read.signOff && b.deliverables.indexOf(nodeId) < 0) return null;
  const s = read.signOff;
  if (!s) return "it has no sign-off";
  if (!s.ok) {
    const n = s.checks.reduce((sum, c) => sum + c.errors + c.warnings + c.unanswered, 0);
    return `its last sign-off did not pass${n > 0 ? ` (${n} blocker${n === 1 ? "" : "s"})` : ""}`;
  }
  if (read.fresh === false) {
    return `it changed after its sign-off at ${minute(s.at)} (fingerprint ${s.fingerprint}${read.fingerprint ? `, now ${read.fingerprint}` : ""})`;
  }
  return null;
}

/** E1 and E2 (§3.8): one blocked node is said exactly; several are listed. */
export function finalAnswer(
  blocked: ReadonlyArray<{ nodeId: string; name?: string | undefined; why: string }>,
  again: string,
  deck = false,
): { message: string; hint: string; missing: string[] } {
  const label = (b: { nodeId: string; name?: string | undefined }) => (b.name ? `"${b.name}" (${b.nodeId})` : b.nodeId);
  const missing = blocked.map((b) => `${label(b)}: ${b.why}`);
  const message =
    blocked.length === 1
      ? `A final export of ${label(blocked[0]!)} waits for a passing sign-off; nothing was written: ${blocked[0]!.why}.`
      : `A final export of ${blocked.length} nodes waits for a passing sign-off; nothing was written: ${missing.join("; ")}.`;
  const hint = `Run ${signOffCall(blocked.map((b) => b.nodeId), deck)}, fix what it lists until ok: true, then ${again}. An export without \`final\` writes now.`;
  return { message, hint, missing };
}

/**
 * The gate in front of a final export (§3.7): every node that belongs to a
 * brief needs a passing sign-off whose fingerprint equals the node's now, one
 * get_brief { nodeId, fingerprint: true } read per node. A node of no brief
 * exports. `again` is the export call to name in the hint.
 */
export async function finalExportGate(
  proc: RoleProcess,
  bridge: Bridge,
  nodeIds: readonly string[],
  session: string | undefined,
  again: string,
  opts: { deck?: boolean; signal?: AbortSignal } = {},
): Promise<RoleGate> {
  if (!proc.active) return PASS;
  const file = await fileOf(bridge, session);
  const { mode } = proc.modeFor(file, true);
  const tool = "a final export";
  const blocked: Array<{ nodeId: string; name?: string; why: string }> = [];
  for (const nodeId of nodeIds) {
    let read: BriefRead;
    try {
      read = await readBrief(bridge, { nodeId, fingerprint: true }, file.sessionId ?? session, opts.signal);
    } catch (err) {
      const failed = readFailed(tool, proc.mode, err);
      return mode === "strict" ? { refusal: failed, warnings: [] } : { warnings: [failed.message] };
    }
    const why = finalBlocker(read, nodeId, file);
    if (why) blocked.push({ nodeId, why });
  }
  if (blocked.length === 0) return PASS;
  // Names make the message readable; one read, and the message stands without it.
  try {
    const info = (await bridge.request("get_nodes_info", { nodeIds: blocked.map((b) => b.nodeId), depth: 0, includeGeometry: false }, {
      ...(file.sessionId ?? session ? { session: file.sessionId ?? session } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })) as { items?: Array<{ id: string; ok: boolean; node?: { name?: string } }> } | null;
    for (const item of info?.items ?? []) {
      const b = blocked.find((x) => x.nodeId === item.id);
      if (b && item.ok && typeof item.node?.name === "string") b.name = item.node.name;
    }
  } catch {
    // Ids alone.
  }
  const answer = finalAnswer(blocked, again, opts.deck === true);
  if (mode === "strict") return { refusal: refusal(answer.message, answer.hint, answer.missing), warnings: [] };
  return { warnings: blocked.map((b, i) => `${answer.missing[i]}: ${signOffCall([b.nodeId])}.`) };
}
