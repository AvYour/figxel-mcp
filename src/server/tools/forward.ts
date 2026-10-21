// The generic path for every plugin-backed tool: forward the op, stream
// progress to the MCP client, propagate client cancellation, shape the result.
//
// It is also the one chokepoint where node ids are made addressable: "12-34",
// an instance id and a pasted figma.com link all become the "12:34" form the
// plugin resolves (figma-url.ts), and a link's file name picks the session when
// more than one file is connected.
//
// And where every write is journalled (journal.ts, trust spec §2.4) and gets
// its `force` (spec §2.3): the param leaves the op's params here and travels in
// the request's guard, which the bridge builds.

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { EDITOR_LABEL, isEditor, type Editor } from "../../shared/editors.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { OPS, toolName } from "../../shared/ops.js";
import type { Bridge } from "../bridge.js";
import { fileNameKey, normalizeIdParams, type LinkedFile } from "../figma-url.js";
import { callFile, createdIdsOf, journalOf, summarize, targetIdsOf, type CallFile } from "../journal.js";
import { ProgressForwarder } from "../mcp-progress.js";
import { errorResult, okResult, reachedNothing } from "../results.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ForwardArgs {
  session?: string | undefined;
  idempotencyKey?: string | undefined;
  idleTimeoutMs?: number | undefined;
  /** Shape a successful result differently from plain JSON (e.g. an image block). Throwing becomes an error result. */
  shape?: ((data: unknown) => CallToolResult | Promise<CallToolResult>) | undefined;
  /** A write's `force` (trust spec §2.3). Also read from the params, and from the call's mark (markForced). */
  force?: boolean | undefined;
  /** false: the tool journals the call itself (figma_savepoint, figma_rollback; tools/trust.ts). */
  journal?: boolean | undefined;
}

// A write tool's `force: true` holds for every request its call sends, whatever
// params the tool builds for its op (figma_set_brief, figma_set_motion_plan and
// figma_batch build their own): the registration hook (batch.ts
// createShapeRecorder) marks the call's `extra`, which is one object per call.
const forcedCalls = new WeakSet<object>();

/** This call was made with `force: true`: its writes overwrite a stale target on purpose. */
export function markForced(extra: Extra): void {
  forcedCalls.add(extra);
}

/**
 * Write ops that change nothing in the document: a savepoint only marks the
 * plugin's undo count and the journal (trust spec §2.5). Not counted by
 * writeEpoch, so making one at the start of an instruction leaves a render and
 * a passing figma_check_motion as fresh as they were.
 */
const MARKS_ONLY: ReadonlySet<string> = new Set(["savepoint"]);

type SessionRow = { sessionId: string; active?: boolean; file?: { name?: string | null }; editorType?: string };

/** The editor a link names against the one a connected file runs: they differ, so the file is not the linked one. */
interface EditorMismatch {
  link: Editor;
  editorType: string;
  file: string | undefined;
}

const editorLabel = (editorType: string) => (isEditor(editorType) ? EDITOR_LABEL[editorType] : `editorType "${editorType}"`);

/**
 * The session a link points at. Only consulted when the caller named none:
 * an explicit `session` always wins. With several files open, the link's file
 * name decides — and a link to a file that is not open is refused rather than
 * run against whichever file happens to be active. A Design file and its board
 * often share a name, so among name matches the link's own editor (/design/,
 * /board/, /slides/) decides. With one file open whose name differs, the
 * mismatch is returned for forwardTool to judge: the slug is only the name at
 * the time the link was copied, so it may just be stale. An editor that
 * differs is never stale — a board is never the Design file — and is returned
 * the same way. A session that does not say its editor is judged by name alone.
 */
async function sessionForLinks(
  bridge: Bridge,
  files: LinkedFile[],
): Promise<{ session?: string; mismatch?: { slug: string; file: string | undefined }; editorMismatch?: EditorMismatch }> {
  if (files.length === 0) return {};
  const distinct = new Set(files.map((f) => `${f.key}/${f.branchKey ?? ""}`));
  if (distinct.size > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "These links come from different Figma files; one call works in one file.", {
      hint: "Split the call per file, or pass `session` with the file each one belongs to.",
    });
  }
  const slug = files.find((f) => f.slug)?.slug;
  const editor = files.find((f) => f.editor)?.editor;
  if (!slug && !editor) return {};
  let sessions: SessionRow[];
  try {
    sessions = (await bridge.statusAsync()).sessions;
  } catch {
    return {};
  }
  if (sessions.length === 0) return {}; // the request itself reports NO_SESSION
  const otherEditor = (s: SessionRow) => editor !== undefined && typeof s.editorType === "string" && s.editorType !== editor;
  const differs = (s: SessionRow): EditorMismatch => ({ link: editor!, editorType: s.editorType!, file: s.file?.name || undefined });
  if (sessions.length === 1) {
    const only = sessions[0]!;
    if (otherEditor(only)) return { editorMismatch: differs(only) };
    if (!slug) return {};
    return fileNameKey(only.file?.name ?? "") === fileNameKey(slug) ? {} : { mismatch: { slug, file: only.file?.name || undefined } };
  }
  if (!slug) return {};
  const want = fileNameKey(slug);
  const matching = sessions.filter((s) => fileNameKey(s.file?.name ?? "") === want);
  if (matching.length === 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `The linked file "${slug}" is not open in Figma.`, {
      hint: `Connected files: ${sessions.map((s) => `"${s.file?.name ?? "?"}"`).join(", ")}. Open the file and run the plugin there, or pass \`session\`.`,
    });
  }
  const sameEditor = matching.filter((s) => !otherEditor(s));
  const pick = (list: SessionRow[]) => (list.find((s) => s.active) ?? list[0]!);
  if (sameEditor.length) return { session: pick(sameEditor).sessionId };
  const named = pick(matching);
  return { session: named.sessionId, editorMismatch: differs(named) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A non-fatal warning where the agent reads it: inside the data of a plain
 * result, as one more text block after a shaped one (an image result has no
 * JSON to put it in). An error carries it too — a NODE_NOT_FOUND whose cause
 * is the other file otherwise reads as "deleted, or on another page".
 */
function withWarning(data: unknown, shaped: CallToolResult | undefined, warning: string): CallToolResult {
  if (!shaped) return isObject(data) ? okResult({ ...data, warning }) : withWarning(data, okResult(data), warning);
  return {
    ...shaped,
    ...(shaped.structuredContent ? { structuredContent: { ...shaped.structuredContent, warning } } : {}),
    content: [...shaped.content, { type: "text", text: `warning: ${warning}` }],
  };
}

/**
 * NO_SESSION normally means the call never left the bridge, so a retry is safe
 * (results.ts). Once the plugin has reported progress the call demonstrably
 * reached it, and a connection lost after that leaves its outcome unknown.
 */
function afterDispatch(err: unknown): unknown {
  if (!(err instanceof BridgeError) || err.code !== ErrorCode.NO_SESSION) return err;
  return new BridgeError(err.code, err.message, {
    hint: err.hint,
    idempotencyKey: err.idempotencyKey,
    partial: { ...(isObject(err.partial) ? err.partial : {}), dispatched: true },
  });
}

/** A call after addressing: ids normalised, the session a link names, and any warning about the link. */
export interface Addressed {
  params: Record<string, unknown>;
  session: string | undefined;
  warning: string | undefined;
}

/**
 * Addressing alone, for a tool that dispatches on its own schedule
 * (figma_export_video's job mode). Throws BridgeError when the link is
 * refused — before Figma is asked anything.
 */
export async function addressCall(bridge: Bridge, op: string, params: Record<string, unknown>, session: string | undefined): Promise<Addressed> {
  const normalized = normalizeIdParams(params);
  let warning: string | undefined;
  if (session === undefined) {
    const picked = await sessionForLinks(bridge, normalized.files);
    session = picked.session;
    if (picked.editorMismatch) {
      // Same rule as a name mismatch below, without its "renamed" escape:
      // a board or a deck is never the Design file the ids came from.
      const { link, editorType, file } = picked.editorMismatch;
      const what = `The link points at a ${EDITOR_LABEL[link]} file but the connected file${file ? ` "${file}"` : ""} is ${editorLabel(editorType)}`;
      if (!OPS.get(op)?.readOnly) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `${what}; node ids are per file.`, {
          hint: `Open the linked ${EDITOR_LABEL[link]} file in Figma and run the plugin there.`,
        });
      }
      warning = `${what}; ids were used as given.`;
    } else if (picked.mismatch) {
      const { slug, file } = picked.mismatch;
      // Node ids are per-file counters: "1:5" from another file is usually
      // some unrelated layer here. A read of it is harmless and the slug may
      // only be stale, so it runs; a write could recolour or delete that layer.
      if (file !== undefined && !OPS.get(op)?.readOnly) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `The link points at "${slug}" but the connected file is "${file}"; node ids are per file.`, {
          hint: `Open the linked file and run the plugin there. If "${file}" is that file renamed, pass \`session: "${file}"\` to run it anyway.`,
        });
      }
      warning = `The link points at "${slug}" but the connected file is "${file ?? "?"}"; ids were used as given.`;
    }
  }
  return { params: normalized.params, session, warning };
}

// Every document write this process sends counts here. figma_export_video
// hands a render out again only while no write has run since it started
// (tools/motion.ts): after a write, the file shows a state that is gone.
//
// A write counts from the moment it is sent, so one still in flight makes a
// render stale. One refused before it reached the document — BUSY while a
// render holds Figma, NO_SESSION, or a plugin refusal with `created: []` — is
// struck off again: it changed nothing, and counting it threw a good render
// away (2026-10-14 audit). Writes are numbered, so striking one off never
// hides another sent meanwhile.
let writes = 0;
const voided = new Set<number>();

/** The number of the last write this process sent to Figma. */
export function writeEpoch(): number {
  return writes;
}

/** Writes sent after `epoch` that may have changed the document: in flight, done, or failed half-way. */
export function writesSince(epoch: number): number {
  let n = 0;
  for (let w = epoch + 1; w <= writes; w++) if (!voided.has(w)) n++;
  return n;
}

/** Number a write as it is sent. */
export function writeSent(): number {
  return ++writes;
}

/** A write that provably reached nothing: it no longer makes renders stale. */
export function writeVoided(n: number): void {
  voided.add(n);
  // Old entries matter only to renders started before them; keep the set small.
  if (voided.size > 10_000) for (const w of voided) if (w <= writes - 10_000) voided.delete(w);
}

/** A write call in its file's journal (journal.ts): what it did, or how it failed. No file connected, no entry. */
function journalCall(bridge: Bridge, file: CallFile | null, op: string, params: Record<string, unknown>, outcome: { data: unknown } | { err: unknown }): void {
  if (!file) return;
  const call = { tool: toolName(op), summary: summarize(op, params), targets: targetIdsOf(params) };
  if ("data" in outcome) {
    journalOf(bridge).record(file, { ...call, ok: true, created: createdIdsOf(op, outcome.data) });
    return;
  }
  const e = outcome.err;
  journalOf(bridge).record(file, {
    ...call,
    ok: false,
    error: e instanceof BridgeError ? e.code : ErrorCode.INTERNAL,
    unchanged: reachedNothing(e),
    // A build that failed half-way says in `partial.created` what exists.
    created: e instanceof BridgeError ? createdIdsOf(op, e.partial) : [],
  });
}

export async function forwardTool(
  bridge: Bridge,
  op: string,
  params: Record<string, unknown>,
  extra: Extra,
  args: ForwardArgs = {},
): Promise<CallToolResult> {
  const write = OPS.get(op)?.write === true;
  // `force` is not the op's: it travels in the request's guard (bridge.ts).
  let force = args.force === true || forcedCalls.has(extra);
  let sent = params;
  if (write && "force" in params) {
    const { force: own, ...rest } = params;
    force ||= own === true;
    sent = rest;
  }
  // Addressing first: a bad link is refused before Figma is asked anything.
  let forwarded: Record<string, unknown>;
  let session: string | undefined;
  let warning: string | undefined;
  try {
    ({ params: forwarded, session, warning } = await addressCall(bridge, op, sent, args.session));
  } catch (err) {
    // Refused before Figma was asked: nothing changed, and the key is the one to retry with.
    return errorResult(err instanceof BridgeError ? err.withKey(args.idempotencyKey) : err, { unchanged: true });
  }
  // The file is looked up while the call runs, so the journal adds no wait.
  const file = write && args.journal !== false ? callFile(bridge, session) : undefined;
  const writeNo = write && !MARKS_ONLY.has(op) ? writeSent() : undefined;
  const progress = new ProgressForwarder(
    {
      progressToken: extra._meta?.progressToken,
      send: (n) => extra.sendNotification(n as ServerNotification),
    },
    { label: toolName(op) },
  );
  let reached = false;
  let answered = false;
  try {
    const data = await bridge.request(op, forwarded, {
      ...(session !== undefined ? { session } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
      ...(write ? { force } : {}),
      onProgress: (p) => {
        reached = true;
        progress.update(p);
      },
      signal: extra.signal,
    });
    answered = true;
    if (file) journalCall(bridge, await file, op, forwarded, { data });
    await progress.finish();
    const shaped = args.shape ? await args.shape(data) : undefined;
    if (warning) return withWarning(data, shaped, warning);
    return shaped ?? okResult(data);
  } catch (err) {
    if (!extra.signal.aborted) await progress.finish();
    const outcome = reached ? afterDispatch(err) : err;
    // A shape that throws after the call ran leaves the call journalled as done.
    if (file && !answered) journalCall(bridge, await file, op, forwarded, { err: outcome });
    if (writeNo !== undefined && reachedNothing(outcome)) writeVoided(writeNo);
    const failed = errorResult(outcome, { readOnly: OPS.get(op)?.readOnly ?? false });
    return warning ? withWarning(undefined, failed, warning) : failed;
  }
}
