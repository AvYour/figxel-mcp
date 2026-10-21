# Trust — the contract between the parts, 2026-10-19

Three workers build the [trust spec](2026-10-19-trust-spec.md) at once: the plugin (A), the server (B) and the skills (C). This page is what they agree on. Where it and the spec differ, this page wins; where it is silent, the spec decides. Already on `release/figxel`: the error codes `STALE` and `ROLLBACK_BLOCKED` (`src/shared/errors.ts`, both "never reached": safe to retry), and `RequestMsg.guard?: { conflicts: "refuse" | "warn" | "off"; force?: boolean }` (`src/shared/protocol.ts`).

## Ownership

| Part | Owns (may edit) | Must not edit |
|---|---|---|
| **A — plugin** | `src/plugin/trust.ts` (new: attribution, view times, the guard, the savepoint and rollback ops), `src/plugin/stress.ts` (new: the stress-test op), `src/plugin/events.ts`, `src/plugin/code.ts` and `src/plugin/ops/index.ts` (the dispatcher hooks and op registration); tests `test/trust-plugin.test.ts`, `test/stress-test.test.ts` | `src/server/`, `src/shared/` (beyond reading), `src/skills/`, `docs/` |
| **B — server** | `src/server/journal.ts`, `src/server/tools/trust.ts` (new); `src/server/bridge.ts` (sending `guard`), `src/server/config.ts` (`BRIDGE_CONFLICTS`), `src/server/tools/{forward,create,index,meta,batch}.ts`, `src/shared/ops.ts`, `src/shared/editors.ts`; `docs/reference/tools.md` (rows, counts, the candidates row removed); tests `test/journal.test.ts`, `test/trust-tools.test.ts`, `NEW_TOOLS` in `test/agent-guidance.test.ts`, and the count updates other tests need | `src/plugin/`, `src/skills/`, other docs |
| **C — skills** | `src/skills/` (workflow index and its `build`, `tools`, `safety` references; ux `states` and `content`; design `finish`), the server instructions text in `src/server/guides.ts` only if needed; `REWRITTEN` entries in `test/skills.test.ts` | code, other tests, `docs/` |
| **Main agent** | `docs/reference/claims.md`, `docs/reference/protocol.md` and every other locked document, merging, the release | — |

## Plugin ops (A implements; B forwards)

Op names and groups: `get_changes` (read), `savepoint` (style; writes nothing to the document, so no `commitUndo`, and it is never guarded), `rollback` (style, destructive), `stress_test` (style, a write, one undo step).

### The guard, in the dispatcher

For every write op, before it runs, read `msg.guard` (absent: do nothing). Targets are the ids the op modifies: `nodeId`, `nodeIds`, and ids inside `items`, `steps`, `updates` and similar arrays — not `parentId`. A target is stale when a person or a collaborator changed it, or anything under it, after the agent's view time for it (spec §2.1–§2.3). Then:

- `conflicts: "refuse"` and no `force`: throw `STALE` before the op runs, `partial: { created: [], conflicts }`, with the spec's message and hint.
- `conflicts: "warn"`, or `force: true`: run the op and add `conflicts` to its result (an object result gains the key; a non-object result is wrapped as `{ result, conflicts }` — prefer objects).
- `"off"`: nothing.

A conflict is `{ nodeId, name, by: "person" | "collaborator", at, viewedAt }`.

### `get_changes` (read)

Params: `sinceMs?` (epoch ms). Result: `{ watchedPageId, commits, conflicts: Conflict[], changes: [{ nodeId, name, by: "person" | "collaborator", at }] (the latest per node, capped at 200), pageSwitches: [{ at, pageId, by: "agent" | "person" }] }`.

### `savepoint`

Params: none. Result: `{ commits, at, pageId }` — `commits` counts the `commitUndo()` calls this plugin run has made (the dispatcher increments it on every write op), `at` is `Date.now()`.

### `rollback`

Params: `commits` (the savepoint's count), `sinceMs` (the savepoint's `at`), `createdIds` (from the server's journal). Refused with `ROLLBACK_BLOCKED`, before any undo, when since `sinceMs` a person or a collaborator changed anything on the watched page, or the page was switched by anyone but the agent; `partial: { created: [], changed: [{ nodeId, name, by, at }], safe: createdIds }` and a hint naming `figma_delete_nodes { nodeIds: createdIds }`. Otherwise `figma.triggerUndo()` `current − commits` times (the counter goes down with each), then checks `createdIds` are gone. Result: `{ undone, verified, stillThere }`.

### `stress_test`

Params: `nodeId`, `cases?` (`expand`, `long`, `numbers`, `many`, `empty`; default all), `keep?` (default false), `audits?` (the `figma_check_layout` audit names; `craft` always runs). Behaviour and result per spec §3.

## Server (B implements)

- `BRIDGE_CONFLICTS` (`refuse` default, `warn`, `off`; any other value stops the server, as `BRIDGE_PROCESS` does). Every write request carries `guard: { conflicts, force }`, `force` from the call's new `force?: boolean` write param (shared write params, so every write tool has it; also top-level on `figma_batch`).
- The journal (spec §2.4) in `src/server/journal.ts`, fed from the forwarding path for write ops, per file session, the last 1,000 entries.
- Tools: `figma_get_changes { since?, limit? }` (journal + the plugin's `get_changes`), `figma_savepoint { label }`, `figma_rollback { savepointId, confirm: true }` (created ids from the journal since the savepoint; on success the entries are marked rolled back), `figma_stress_test { nodeId, cases?, keep?, audits? }`. Descriptions ≤ 1,024 characters, ending whole with the editors suffix.
- Registration: read += `get_changes`; style += `savepoint`, `rollback`, `stress_test`; editor rows Design yes (the live run is pending, said in the row, as the role tools do), FigJam and Slides unmeasured. Counts: 144 in the catalog, 140 by default; read 24, style 24.

## Skills (C implements)

The workflow's loop: `figma_savepoint` at the start of each instruction; the report lists what changed from `figma_get_changes`; when the person wants the instruction undone, `figma_rollback`, and when it is refused, explain and offer deleting what was created — never `figma_undo_step`. A `STALE` refusal means: read the node again, then redo the write; never `force` without the person's word. ux `states` and `content`, design `finish`: run `figma_stress_test` on every screen before sign-off and fix what it breaks. Tool rows for the four tools in the workflow `tools` reference.

## Rules

As the [roles contract](2026-10-16-roles-contract.md#rules-for-every-worker): English only, the repository's comment style, no edits to claims or locked docs (B edits only `tools.md` and re-locks it), the full suite before finishing, commits with the noreply identity and no Co-Authored-By trailer, no push, a report of every deviation. Start by bringing your worktree to `release/figxel` (`git merge --ff-only release/figxel`): worktrees are created from `main`.
