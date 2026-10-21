# Trust — safe co-editing and the content stress test: design spec, 2026-10-19

The feature the owner chose for the next release ([feature research](2026-10-19-feature-research.md)); the decision is ADR #43 `[C-397]`. Two parts:

1. **Safe co-editing.** An agent and people work in the same file. Today an agent can overwrite what a person changed after the agent read it, and the only undo is Figma's, which also takes back the person's edits. The research found this the most intense unsolved pain: an agent rewrote a text from a stale read and destroyed a person's edit, unrecoverably.
2. **The content stress test.** A design that looks right with tidy placeholder copy breaks once real content arrives: long names, translations, big numbers, empty lists. Figxel can show that inside Figma, before any code exists.

Built on what Figxel has: one undo step per tool call, idempotent writes, the plugin's change events (`src/plugin/events.ts`), the content fingerprint (`src/plugin/fingerprint.ts`), and `figma_check_layout` with its audits.

## 1. Facts this rests on

Registered in `docs/reference/claims.md` before anything relies on them; what is not measured is `to-verify` and is measured in the live session before the feature is called done.

- **Change origin.** A node change's `origin` is `'LOCAL'` when it comes "from the user running the plugin" and `'REMOTE'` when it comes from another user in the file. The plugin's own writes are therefore LOCAL too: Figma does not tell a person's edit from the plugin's (plugin typings 1.141.0, `BaseDocumentChange.origin`) `[C-392]`.
- **Change events are batched.** Figma "will not call the 'documentchange' callback synchronously and will instead batch the updates and send them to the callback periodically" `[C-393]`. Figxel listens to the current page's `nodechange` instead, which `dynamic-page` allows without loading every page (ADR #25). Whether `nodechange` is batched the same way, and how long after a write its events arrive, is **to-verify** (live) `[C-394]`.
- **Undo.** `figma.triggerUndo()` reverts to the last `commitUndo()` savepoint, so a person's edits made after it are reverted too `[C-024]`; one undo right after a tool call takes that call back `[C-059]`. Whether several undos in a row take back exactly as many tool calls, and how a person's edit between them interacts, is **to-verify** (live) `[C-395]`.
- **Text expansion in translation.** IBM's figures, quoted by W3C: up to 10 characters 200–300 %, 11–20 characters 180–200 %, 21–30 characters 160–180 %, 31–50 characters 140–160 %, over 70 characters 130 % (the 51–70 row is printed as 151–170 %); "the smaller the source message, the higher the likely translation length". `[C-396]`.

## 2. Safe co-editing

### 2.1 Who changed what (plugin)

The plugin already sees every change on the current page through `nodechange`. It now attributes each change:

- **The agent's.** While an op runs, and for a short settle window after it ends (default 1,500 ms, a measured number replaces it), changes to nodes in the op's **footprint** are the agent's. The footprint is the node ids the op names in its params (`nodeId`, `nodeIds`, `parentId`, ids inside items and steps), the ids it created or returned, and their ancestors up to the page and all their descendants — auto-layout reflow and text resizing move parents and children the op never named.
- **A person's, here.** A `LOCAL` change outside every footprint window.
- **A collaborator's.** A `REMOTE` change.

Each attributed change is kept with its time and its ancestry (the node and every ancestor at the time of the change), so "did anything under X change" is a set lookup. Kept in the plugin's memory: the last 2,000 changes, and per node the latest person or collaborator change. A page switch is recorded too.

Revised 2026-10-20 after the live role tests: the window alone took the agent's own late-reported changes for a person's (findings 6, 6b, 6c). Time is now only a hint and content decides; see [§2.6](#26-content-decides-time-is-a-hint-2026-10-20).

Honest limits, stated in the docs: only the current page is watched (a person's edit on another page is not seen); `figma_eval` writes are the agent's own but have no footprint, so they read as a person's; a person editing a node inside the agent's footprint during the settle window is attributed to the agent. As built (2026-10-19), also: a deleted layer the plugin never saw before counts only for itself; in the stress test's copies a text with several styles takes its first style, and a list inside an instance is neither grown nor emptied. The constants a live run must confirm are `SETTLE_MS` (1,500), `REFLOW` (auto-layout siblings report their moves) and `UNDO.emptyCommitIsAStep` (false) in `src/plugin/trust.ts`.

### 2.2 What the agent has seen (plugin)

Every read op that returns a node's content (`get_node`, `get_nodes_info`, `get_design_context`, `get_selection`, `export_node`, `check_layout`, `get_brief`, `scan_text_nodes`, the motion reads) records, per root it read, the time. A write the agent made also counts as seeing what it wrote. The latest read or write covering a node — the node itself or an ancestor — is the agent's **view time** for it.

### 2.3 The stale-write guard (plugin, enforced before the op runs)

Before a write op that **modifies existing nodes** (its targets: `nodeId`, `nodeIds`, ids in items and steps; not `parentId`, since adding into a frame overwrites nothing) runs, the plugin checks each target: a change by a person or a collaborator to the target or anything under it, after the agent's view time for the target. If there is one, the op is refused before any change:

- code `STALE` (new), `safeToRetry: true`, `partial: { created: [] }`
- message: `figma_set_text was refused before any change: "Hero / Title" (12:34) was edited by you after the agent last read it (12:07:31, 40 s ago). Writing now could overwrite that edit.`
- hint: `Read it again (figma_get_node { nodeId: "12:34" } or figma_get_design_context), then send the call again; or pass force: true to overwrite on purpose.`

A target the agent never read or wrote has no view time and is not checked: the guard prevents overwriting what changed since the agent looked, not every write. Every write tool takes `force?: boolean`. The setting `BRIDGE_CONFLICTS` is `refuse` (default), `warn` (the call runs; the result lists the conflict under `conflicts`), or `off`.

### 2.4 The change journal (server)

Every write call through this server process is journalled: sequence number, time, tool, the file's session, the ids it created and the ids it targeted, a one-line summary of the call (the tool's own short form, never image data or long text), whether it succeeded, and the plugin's undo-savepoint count after it. Kept in memory for the process (the last 1,000 entries per file).

New read tool **`figma_get_changes`**: the journal for a file, newest last, with `since` (a sequence number or a savepoint id) and `limit`; plus the conflicts the plugin saw (a person's or a collaborator's change to something the agent had touched). This is what an agent reports to the person at the end ("what I changed"), and what a person reads to review the agent's work.

### 2.5 Savepoints and rollback

New write tools (style group):

- **`figma_savepoint { label }`** — marks the point before an instruction: the plugin returns its undo-savepoint count, the time and the current page; the server stores them with the journal position. Free and instant; the skills tell agents to make one at the start of each instruction.
- **`figma_rollback { savepointId, confirm: true }`** — takes back everything the agent did since that savepoint, in one call, **only when that is safe**:
  - Refused (`ROLLBACK_BLOCKED`, new code) when, since the savepoint, a person or a collaborator changed anything on the watched page, or the page was switched by anyone but the agent: an undo would revert their edit too `[C-024]`, or reach a page the plugin cannot see. The refusal lists what changed and offers the safe part: `figma_delete_nodes` on the nodes the agent created since the savepoint (from the journal), which never touches anyone's edits.
  - Otherwise: `figma.triggerUndo()` once per undo savepoint the agent made since (each tool call is one), verified afterwards: the nodes the journal says were created are gone. A mismatch stops and reports.
  - Not under `BRIDGE_CONFLICTS=off`? It still works: safety of the rollback does not depend on the setting.

`figma_undo_step` stays as it is, documented as the unsafe single step; the skills move to savepoint and rollback.

### 2.6 Content decides, time is a hint (2026-10-20)

The live role tests (2026-10-19, findings 6, 6b, 6c) showed Figma reporting `nodechange` events seconds to minutes after the write, in batches, with the Figma window in the background and also in front, and some of the agent's own changes with origin `REMOTE`. Stamped on arrival, they fell outside the 1,500 ms window and read as a person's or a collaborator's: false `STALE` refusals, and a journal listing the agent's own work as the person's. The window was measured not to be enough [C-394]. The rule as built (`src/plugin/trust.ts`, `src/plugin/echo.ts`):

- **What counts as a conflict.** A target conflicts only if its content changed since the agent's last view of it. The view is what the agent last read, or what its own last write left behind.
- **Attribution.** A `LOCAL` change inside an op's footprint window is the agent's, as before. Any other change, `LOCAL` or `REMOTE`, is the agent's when it leaves the node as the agent last saw it: its own late echo. Anything else is a person's (`LOCAL`) or a collaborator's (`REMOTE`).
- **What the agent has seen, by content.** A hash per node property, compared on exactly the properties a change names (a `PROPERTY_CHANGE` lists them, plugin typings 1.141.0). Recorded when a write ends: in full for what it named or made and everything under what it made; position, size and place for ancestors and for the children of each direct parent and auto-layout ancestor; geometry, resolved modes and bound values under what it named. A read records its roots and what is under them in full. A change the window gives to the agent records what it names. Bounded: 6,000 nodes, 500 per write, 250 per read; a property never recorded is never vouched for.
- **Variables and styles (6b).** Hashes are binding-aware: a value bound to a variable or linked to a style hashes as that variable or style, with the node's resolved modes beside it. A new variable value re-colours its bound nodes without changing their hashes, so a late re-colouring matches what the agent saw, and a write to such a node overwrites nothing anyone did to the node. A write that re-resolves bound nodes (`set_variable_value`, `create_variables`, `update_variable_collection`, `update_style`, the deletes) also covers the whole watched page for its run and settle window: finding exactly the bound nodes would mean walking the page on every such write. The trade-off: a person's edit anywhere on that page in those 1.5 s counts as the agent's. A node the agent never recorded passes only when every value the change names follows variables or styles the agent's own write changed, aliases included.
- **Rollback is not weaker.** A person's or a collaborator's change with different content blocks it as before. Because a variable's new value no longer shows as a layer change, the plugin also watches the file's local variables, collections and styles: it reads them at each savepoint, before and after every write that can change them, after an undo, and at the rollback itself. A difference the agent's own writes do not explain blocks the rollback (`ROLLBACK_BLOCKED`, listed in `partial.changed` with `by: "someone else"`). This is stricter than before: such a change is caught even when no bound layer is on the watched page.
- **Constants.** `SETTLE_MS` (1,500) and `REFLOW` are unchanged: content decides the late cases, and a longer window would only give the agent more of a person's edits.

Honest limits added: a person's edit to a node the agent was writing, made just before the write and reported after it, reads as part of what the write left; a person's mode switch or variable change that happens while the agent's own variable write is in flight, on nodes bound only to variables that write changed, reads as the agent's until the resource watch sees it at the next savepoint, variable write or rollback. What a live run must confirm is listed for `spikes/live-trust.mjs` in §5.

## 3. The content stress test

New tool **`figma_stress_test { nodeId, cases?, keep?, audits? }`** (style group; a write, because it builds copies; one undo step):

1. Clones the frame once per case to an empty spot beside it, named `<frame> · stress: <case>`.
2. Applies the case to the copy:
   - `expand` — every text grows as translation grows it: by its length in characters, 300 % up to 10, 200 % up to 20, 180 % up to 30, 160 % up to 50, 150 % up to 70, 130 % beyond (the top of each IBM band, §1), with accented pseudo-characters so the copy reads as a test (`[Ŝéñð ñöŵ ···]`).
   - `long` — names, titles and labels at their longest plausible form: each text doubled in words, single words replaced by a 24-character compound.
   - `numbers` — every run of digits becomes a large value of the same form (`9` → `12,345`, `$9.99` → `$12,345.99`, `3%` → `100%`).
   - `many` — every auto-layout list of three or more instances of one component gets three times as many items.
   - `empty` — those lists drop to none; texts stay.
   - (`rtl` is not in this release: whether Figma renders and wraps right-to-left text in a frame's fonts is to-verify.)
3. Runs `figma_check_layout` on the original (the baseline) and on each copy, with `craft` and the audits asked for, and reports **what each case broke**: findings on a copy that the baseline does not have, mapped back to the original's layer by path (`Card / Title overflows by 46 px under expand`).
4. Deletes the copies unless `keep: true` (then they stay, selected, for the person to see).

Result: `{ baseline: { ok, counts }, cases: [{ case, broke: [{ kind, severity, path, detail }], ok }], kept?: [ids] }`. Texts in instances are overridden in the copy only; fonts are loaded per run; a text whose font is missing is skipped and listed.

Skills: the ux skill's `states` and `content` sections and the design skill's `finish` run it on every screen before sign-off; the ux sign-off set may add it later, once calibrated.

## 4. Tools, counts and settings

| Tool | Group | Kind |
|---|---|---|
| `figma_get_changes` | read | reads the journal (server) and the plugin's conflict log |
| `figma_savepoint` | style | writes nothing to the document; marks the journal and the plugin |
| `figma_rollback` | style | write, destructive (needs `confirm: true`) |
| `figma_stress_test` | style | write, one undo step, leaves nothing unless `keep` |

140 → 144 in the catalog, 136 → 140 registered by default. `force?: boolean` on every write tool (through the shared write params). New error codes `STALE` and `ROLLBACK_BLOCKED`. New setting `BRIDGE_CONFLICTS` (`refuse` | `warn` | `off`, default `refuse`). Editors: all four Design `yes` after the live run; FigJam and Slides unmeasured.

## 5. Live checks before release

A spike `spikes/live-trust.mjs`: the delay between a write and its `nodechange` events, and whether every change of a write lands inside the settle window; a person's edit during an agent's write; three tool calls then three undos (each takes back one call); a person's edit between two calls and what one undo does; rollback refused after an edit by hand; the stress test on a real card grid, every case.

Added for the content rule (§2.6): with Figma in the background, the agent's own late events leave `figma_get_changes` empty and the next write unrefused; every property name Figma sends for those writes is one the plugin records (a name it does not know is never vouched for); a palette change through variables, reported late, refuses nothing and lists nothing; a mode switched by hand, a variable changed in the Variables panel and a text retyped by hand each still give `STALE` or `ROLLBACK_BLOCKED`; and the time the after-state recording adds to a large `figma_create_from_spec` and a large read.

## 6. Order

Wave 1 in parallel: (A) the plugin — attribution, view times, the guard, savepoint and rollback ops, the stress-test op; (B) the server — the journal, `figma_get_changes`, the savepoint and rollback tools, `force`, `BRIDGE_CONFLICTS`, the stress-test tool, codes, registration; (C) the skills — workflow loop (savepoint at the start of an instruction, the journal in the report, rollback instead of `figma_undo_step`), ux `states`/`content` and design `finish` (the stress test). Then the main agent: claims, docs (tools.md, configuration, usage "Reviewing and undoing the agent's work", README, spec ADR #43, CHANGELOG), merge, gates.
