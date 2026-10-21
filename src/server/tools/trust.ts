// Trust on the server side (docs/superpowers/plans/2026-10-19-trust-spec.md):
//
//   figma_get_changes  the journal of this process's write calls in a file
//     (journal.ts, spec §2.4), merged with the plugin's get_changes: what a
//     person here or a collaborator changed, the conflicts with what the agent
//     had read or written, the page switches.
//   figma_savepoint    the point before an instruction (spec §2.5): the plugin
//     answers its undo count, its clock and its page; the server stores them
//     with the journal's position, per file. Nothing in the document changes.
//   figma_rollback     back to a savepoint in one call, only when that is safe:
//     the server names the nodes the journal says were made since, the plugin
//     refuses (ROLLBACK_BLOCKED, before any undo) when anyone else changed the
//     page since, else undoes one step per call and checks those nodes are gone.
//   figma_stress_test  the content stress test (spec §3), run by the plugin.
//
// The plugin ops (src/plugin/trust.ts, src/plugin/stress.ts) hold the change
// log, the guard and the undo; this side holds the journal and the savepoints.
// "Savepoint", not "checkpoint": a checkpoint already means a stop for the
// person's approval in the prompts and the skills.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { toolName } from "../../shared/ops.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME } from "../../shared/version.js";
import type { Bridge } from "../bridge.js";
import { callFile, entryView, journalOf, type CallFile, type Journal, type Savepoint } from "../journal.js";
import { errorResult, okResult } from "../results.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";
import { WRITE_PARAMS } from "./create.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

/** The stress test's cases (spec §3); rtl waits until right-to-left wrapping is measured. */
export const STRESS_CASES = ["expand", "long", "numbers", "many", "empty"] as const;
/** figma_check_layout's audit names (tools/read.ts); test/trust-tools.test.ts keeps the two lists equal. */
export const STRESS_AUDITS = ["tokens", "names", "fonts", "board", "craft", "tells", "handoff", "a11y", "states", "copy", "system", "deck", "mark", "icons", "library"] as const;

/** Calls figma_get_changes returns by default, newest last. */
const DEFAULT_LIMIT = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (ms: number) => new Date(ms).toISOString();

const SESSION = { session: WRITE_PARAMS.session };

const CHANGES_DESCRIPTION =
  "What changed in this file: what you report at the end of an instruction, and what a person reads to review your " +
  "work. `journal`: the write calls this server sent to the file, newest last, each { seq, at, tool, summary, ok, " +
  "error?, created? (nodes it made), targets? (nodes it named), rolledBack? }, with each savepoint as its own entry. " +
  "From the plugin: `changes` (the latest change per node by a person here or a collaborator; one that leaves a node " +
  "as you last wrote or read it is yours, however late), `conflicts` (such a " +
  "change to a node you had read or written), `pageSwitches`, `watchedPageId` (only that page is watched). `since`: " +
  'the calls after a seq ("12") or after a savepoint ("sp-3"); `limit`: the newest calls (default 100). `savepoints` ' +
  "lists this file's. The journal lives in this server process: a restart starts it empty. Reads only.";

const SAVEPOINT_DESCRIPTION =
  "Mark the point before an instruction, so figma_rollback can take back everything done after it in one call. Make " +
  "one at the start of every instruction a person gives: it writes nothing to the document and costs nothing. Result " +
  "{ savepointId, label, at, pageId, journalSeq }; figma_get_changes { since: savepointId } lists what was done since. " +
  "Savepoints live in this server process: a restart forgets them, and a rollback forgets the ones made after its own.";

const ROLLBACK_DESCRIPTION =
  "Take back everything you did since a savepoint, in one call, only when that is safe. Refused with ROLLBACK_BLOCKED " +
  "before any undo when, since the savepoint, a person or a collaborator changed anything on the page the plugin " +
  "watches, a local variable or style changed without you, or the page was switched by anyone but you: an undo would " +
  "take their edit too. Your own changes reported late do not block it. The refusal lists what " +
  "changed (partial.changed) and offers the safe part: figma_delete_nodes on the nodes you made since (partial.safe), " +
  "which touches nobody's edits. Otherwise one undo per call since the savepoint, then a check that the nodes made " +
  "since are gone: { savepointId, undone, verified, stillThere, calls }. Use it instead of figma_undo_step. Requires " +
  "`confirm: true`.";

const STRESS_DESCRIPTION =
  "Does the design survive real content? Copies the frame once per case beside it, applies the case to the copy, " +
  "runs figma_check_layout (craft plus `audits`) on the original and on each copy, and reports what each case broke " +
  "that the original does not have, by the original's layer path. Cases: expand (every text grown as translation " +
  "grows it, 300 % up to 10 characters down to 130 % past 70), long (names and titles at their longest), numbers " +
  "(every number large: 9 → 12,345), many (lists of three or more instances tripled), empty (those lists emptied); " +
  "default all. The copies are removed unless `keep: true` (then they stay, selected). One undo step. Result " +
  "{ baseline: { ok, counts }, cases: [{ case, broke: [{ kind, severity, path, detail }], ok }], kept? }. Run it on " +
  "every screen before sign-off and fix what it breaks.";

const ROLLBACK_WARNING =
  "figma_rollback takes back every call you made since the savepoint, with Figma's undo, and is refused when anyone " +
  "else changed the page since. Pass confirm: true to run it.";

/** A savepoint as figma_get_changes lists it. */
const savepointView = (s: Savepoint) => ({ savepointId: s.id, label: s.label, at: iso(s.at), journalSeq: s.journalSeq });

function fileLabel(file: Pick<CallFile, "name" | "key">): string {
  return `"${file.name ?? file.key}"`;
}

/** The savepoint `id` names, checked against the file the call goes to; a BridgeError when there is none. */
function savepointFor(journal: Journal, id: string, file: CallFile | null): Savepoint {
  const sp = journal.findSavepoint(id);
  if (!sp) {
    const known = file ? journal.savepoints(file.key) : [];
    throw new BridgeError(ErrorCode.INVALID_PARAM, `No savepoint "${id}" in this server process${file ? ` for ${fileLabel(file)}` : ""}.`, {
      hint: known.length
        ? `This file's savepoints: ${known.map((s) => `${s.id} "${s.label}"`).join(", ")}.`
        : "figma_savepoint { label } makes one at the start of an instruction. Savepoints live in this server process: a restart forgets them, and a rollback forgets the ones made after its own.",
    });
  }
  if (file && sp.file !== file.key) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `Savepoint ${id} was made in "${sp.fileName ?? sp.file}", not in ${fileLabel(file)}, where this call goes.`, {
      hint: `Pass session: "${sp.fileName ?? sp.sessionId ?? sp.file}" to work in the file it was made in.`,
    });
  }
  return sp;
}

/** The safe part of a refused rollback: deleting what the agent made since, which takes nobody's edits. */
function safePart(created: readonly string[]): string {
  return created.length
    ? `The safe part: figma_delete_nodes { nodeIds: [${created.map((id) => `"${id}"`).join(", ")}] } removes the ${created.length} node(s) you made since the savepoint and touches nobody's edits; ask the person first.`
    : "You made no node since the savepoint, so nothing is left to delete; the person can undo the rest by hand.";
}

// ── figma_get_changes ───────────────────────────────────────────────────────

async function getChanges(bridge: Bridge, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const session = args.session as string | undefined;
  const since = typeof args.since === "string" && args.since.trim() !== "" ? args.since.trim() : undefined;
  const limit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
  const journal = journalOf(bridge);
  const file = await callFile(bridge, session);

  // `since` in the journal's terms (a seq), and in the plugin's (its clock).
  let afterSeq = 0;
  let sinceMs: number | undefined;
  if (since !== undefined) {
    if (/^\d+$/.test(since)) {
      afterSeq = Number(since);
      if (file) sinceMs = journal.entry(file.key, afterSeq)?.at;
    } else {
      try {
        const sp = savepointFor(journal, since, file);
        afterSeq = sp.journalSeq;
        sinceMs = sp.at;
      } catch (err) {
        return errorResult(err, { readOnly: true });
      }
    }
  }

  // The plugin's half. Without it the journal still stands; without a file there is nothing to show.
  let plugin: Record<string, unknown> | null = null;
  let pluginError: Record<string, unknown> | null = null;
  try {
    const data = await bridge.request("get_changes", sinceMs !== undefined ? { sinceMs } : {}, {
      ...(session !== undefined ? { session } : {}),
      signal: extra.signal,
    });
    plugin = isObject(data) ? data : {};
  } catch (err) {
    if (!file) return errorResult(err, { readOnly: true });
    const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
    pluginError = { code: e.code, message: e.message, ...(e.hint !== undefined ? { hint: e.hint } : {}) };
  }

  const entries = file ? journal.since(file.key, afterSeq) : [];
  const shown = entries.slice(-limit);
  // Past 1,000 calls the oldest are dropped: say how many of the asked-for ones are gone.
  const dropped = file ? Math.max(0, journal.firstSeq(file.key) - (afterSeq + 1)) : 0;
  const { journal: _j, savepoints: _s, ...fromPlugin } = plugin ?? {};
  return okResult({
    file: file?.name ?? null,
    since: since ?? null,
    lastSeq: file ? journal.lastSeq(file.key) : 0,
    journal: shown.map(entryView),
    ...(entries.length > shown.length ? { omitted: entries.length - shown.length } : {}),
    ...(dropped > 0 ? { dropped, droppedNote: `The journal keeps the last ${journal.limit} calls per file; ${dropped} older call(s) in this range are no longer kept.` } : {}),
    savepoints: file ? journal.savepoints(file.key).map(savepointView) : [],
    ...(plugin ? fromPlugin : { plugin: pluginError }),
  });
}

// ── figma_savepoint ─────────────────────────────────────────────────────────

async function savepoint(bridge: Bridge, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const session = args.session as string | undefined;
  const key = args.idempotencyKey as string | undefined;
  const label = String(args.label ?? "").trim();
  if (!label) {
    return errorResult(new BridgeError(ErrorCode.INVALID_PARAM, "`label` is empty: say what the instruction is, in a few words.").withKey(key), { unchanged: true });
  }
  // Looked up while the plugin answers; the savepoint is stored under the file the call went to.
  const file = callFile(bridge, session);
  return forwardTool(bridge, "savepoint", {}, extra, {
    session,
    idempotencyKey: key,
    journal: false,
    shape: async (data) => {
      const d = isObject(data) ? data : {};
      if (typeof d.commits !== "number" || typeof d.at !== "number") {
        throw new BridgeError(ErrorCode.INTERNAL, "The plugin answered the savepoint without its undo count and time, so nothing was stored.", {
          hint: `The plugin is older than this server: ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}).`,
        });
      }
      const f = (await file) ?? (await callFile(bridge, session));
      if (!f) throw new BridgeError(ErrorCode.NO_SESSION, "The file the savepoint was made in is no longer connected, so nothing was stored.");
      const sp = journalOf(bridge).savepoint(f, { label, commits: d.commits, at: d.at, pageId: typeof d.pageId === "string" ? d.pageId : null, idempotencyKey: key });
      return okResult({ savepointId: sp.id, label: sp.label, at: iso(sp.at), pageId: sp.pageId, journalSeq: sp.journalSeq });
    },
  });
}

// ── figma_rollback ──────────────────────────────────────────────────────────

async function rollback(bridge: Bridge, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> {
  const session = args.session as string | undefined;
  const key = args.idempotencyKey as string | undefined;
  // Refused here, before Figma was asked: nothing changed, a corrected retry is safe.
  const refuse = (err: unknown) => errorResult(err instanceof BridgeError ? err.withKey(key) : err, { unchanged: true });
  if (args.confirm !== true) return refuse(new BridgeError(ErrorCode.INVALID_PARAM, "`confirm` must be true.", { hint: ROLLBACK_WARNING }));
  const id = String(args.savepointId ?? "").trim();
  const journal = journalOf(bridge);
  const file = await callFile(bridge, session);
  let sp: Savepoint;
  try {
    sp = savepointFor(journal, id, file);
  } catch (err) {
    return refuse(err);
  }
  const createdIds = journal.createdSince(sp);
  const record = (result: CallToolResult) => {
    if (!file) return;
    const s = (result.structuredContent ?? {}) as { code?: unknown; safeToRetry?: unknown };
    journal.record(file, {
      tool: toolName("rollback"),
      summary: `${toolName("rollback")} ${sp.id} ${JSON.stringify(sp.label)}`,
      ok: result.isError !== true,
      ...(result.isError ? { error: typeof s.code === "string" ? s.code : ErrorCode.INTERNAL, unchanged: s.safeToRetry === true } : {}),
    });
  };

  // A plugin run again since the savepoint counts its undo steps from 0: which are this agent's is unknown.
  if (file?.instanceId && sp.instanceId && file.instanceId !== sp.instanceId) {
    const blocked = refuse(
      new BridgeError(
        ErrorCode.ROLLBACK_BLOCKED,
        `figma_rollback was refused before any undo: the ${PLUGIN_NAME} plugin was run again since savepoint ${sp.id}, so its undo count started over and cannot tell which undo steps are yours.`,
        { hint: safePart(createdIds), partial: { created: [], changed: [], safe: createdIds } },
      ),
    );
    record(blocked);
    return blocked;
  }

  const result = await forwardTool(bridge, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds }, extra, {
    session,
    idempotencyKey: key,
    journal: false,
    shape: (data) => {
      const d = isObject(data) ? data : {};
      const undone = typeof d.undone === "number" ? d.undone : 0;
      const stillThere = Array.isArray(d.stillThere) ? d.stillThere.filter((x): x is string => typeof x === "string") : [];
      // Only an undo that ran takes the calls back; with none, the journal stays as it was.
      const calls = undone > 0 ? journal.rolledBackTo(sp).length : 0;
      return okResult({
        savepointId: sp.id,
        label: sp.label,
        undone,
        verified: d.verified === true,
        stillThere,
        calls,
        ...(stillThere.length
          ? {
              hint:
                `Figma undid ${undone} step(s), but ${stillThere.length} node(s) made since the savepoint are still there. ` +
                "Read them (figma_get_nodes_info) before anything else, and delete them with figma_delete_nodes only once you know they are yours.",
            }
          : {}),
      });
    },
  });
  record(result);
  return result;
}

// ── registration ────────────────────────────────────────────────────────────

export function registerTrust(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  if (wanted("get_changes")) {
    server.registerTool(
      "figma_get_changes",
      {
        title: "What changed in this file",
        description: fitDescription(CHANGES_DESCRIPTION),
        inputSchema: {
          since: z
            .string()
            .max(64)
            .optional()
            .describe('Only what came after: a journal seq as a string ("12") or a savepoint id ("sp-3"). Default: everything kept.'),
          limit: z.number().int().min(1).max(1000).optional().describe("The newest calls to return, at most. Default 100."),
          ...SESSION,
        },
        annotations: readAnnotations("get_changes"),
      },
      async (args: Record<string, unknown>, extra: Extra) => getChanges(bridge, args, extra),
    );
  }

  if (wanted("savepoint")) {
    server.registerTool(
      "figma_savepoint",
      {
        title: "Savepoint before an instruction",
        description: fitDescription(SAVEPOINT_DESCRIPTION),
        inputSchema: {
          label: z.string().min(1).max(120).describe('The instruction in a few words, e.g. "Hero copy from the brief".'),
          ...WRITE_PARAMS,
        },
        annotations: writeAnnotations("savepoint"),
      },
      async (args: Record<string, unknown>, extra: Extra) => savepoint(bridge, args, extra),
    );
  }

  if (wanted("rollback")) {
    server.registerTool(
      "figma_rollback",
      {
        title: "Roll back to a savepoint",
        description: fitDescription(ROLLBACK_DESCRIPTION),
        inputSchema: {
          savepointId: z.string().min(1).max(64).describe('The savepoint to go back to, as figma_savepoint returned it ("sp-3").'),
          confirm: z.boolean().describe("Must be true: you have read the description."),
          ...WRITE_PARAMS,
        },
        annotations: writeAnnotations("rollback"),
      },
      async (args: Record<string, unknown>, extra: Extra) => rollback(bridge, args, extra),
    );
  }

  if (wanted("stress_test")) {
    server.registerTool(
      "figma_stress_test",
      {
        title: "Stress-test a design with real content",
        description: fitDescription(STRESS_DESCRIPTION),
        inputSchema: {
          nodeId: z.string().describe("The frame to test: a screen, a card, a section."),
          cases: z.array(z.enum(STRESS_CASES)).min(1).max(STRESS_CASES.length).optional().describe("Which cases to run. Default all five."),
          keep: z.boolean().optional().describe("Leave the copies beside the frame, selected, for the person to see. Default false."),
          audits: z
            .array(z.enum(STRESS_AUDITS))
            .max(STRESS_AUDITS.length)
            .optional()
            .describe("figma_check_layout audits to run besides craft, which always runs, e.g. [\"a11y\", \"copy\"]."),
          ...WRITE_PARAMS,
        },
        annotations: writeAnnotations("stress_test"),
      },
      async (args: Record<string, unknown>, extra: Extra) =>
        forwardTool(bridge, "stress_test", args, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        }),
    );
  }
}
