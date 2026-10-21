# Roles wave A — the contract between the parts, 2026-10-16

Wave A of the [role spec](2026-10-14-roles-spec.md) is built by four workers at once: the audits (plugin), the brief and sign-off ops (plugin), the role process and its tools (server), and the skills. This page is what they agree on, so the parts fit when they are merged. Where this page and the spec differ, this page wins; where it is silent, the spec decides. The shared table is `src/shared/roles.ts` (committed): roles, gears, details keys, sign-off sets, platform targets, records and their parsers. Change it only by agreement (say so in the report).

## Ownership

| Part | Owns (may edit) | Must not edit |
|---|---|---|
| **A — audits** | `src/plugin/a11y.ts`, `states.ts`, `copy.ts`, `system.ts` (new); `src/plugin/ops/check.ts`, `src/plugin/craft.ts` (the §4.0 fixes); `src/server/tools/read.ts` (only `figma_check_layout`: the `audit` enum and its max, `briefId?`, the description); tests `test/a11y-audit.test.ts`, `test/states-audit.test.ts`, `test/copy-audit.test.ts`, `test/system-audit.test.ts`, and updates to `test/check-*.test.ts` | anything under `src/server/` but that one tool, `src/shared/`, `src/skills/`, `docs/` |
| **B — brief ops** | `src/plugin/ops/brief.ts`, `src/plugin/fingerprint.ts` (new); `src/plugin/ops/index.ts` (register the three ops); tests `test/brief-ops.test.ts`, `test/fingerprint.test.ts` | `src/plugin/ops/check.ts` (call `checkLayout` as it is), `src/server/`, `src/shared/`, `src/skills/`, `docs/` |
| **C — role process** | `src/server/role-process.ts`, `src/server/tools/brief.ts` (new); `src/server/mcp.ts`, `src/server/motion-process.ts` (the shared skill ledger), `src/server/tools/{index,create,figjam,slides,storyboard,batch,export,meta,guide,prompts,resources}.ts` (gates, registration, the ledger — in `guide.ts` not the description text); `src/shared/ops.ts`, `src/shared/editors.ts`; `docs/reference/tools.md` (the rows and counts the tests parse); tests `test/role-process.test.ts`, `test/brief-tools.test.ts`, `test/sign-off.test.ts`, `NEW_TOOLS` in `test/agent-guidance.test.ts`, and `BRIDGE_PROCESS: "off"` in tests that create top-level work | `src/plugin/`, `src/skills/`, `src/server/tools/read.ts`, other docs |
| **D — skills** | `src/skills/figxel-ux/` (new), the edits to the design, critique, workflow, design-system and code-to-design skills, the server instructions text, the `figma_get_guide` description text; `REWRITTEN` in `test/skills.test.ts`, `IN_SCOPE` in `test/skills-acceptance.test.ts` | code, other tests, `docs/` |
| **Main agent** | `docs/reference/claims.md` and every other locked document, merging, the release | — |

## Plugin ops (B implements; C forwards)

All three read and write shared plugin data under `BRIEF_NAMESPACE` with the keys `BRIEF_KEY`, `SIGN_OFF_KEY` and `BRIEF_INDEX_KEY` from `src/shared/roles.ts`. The server has checked every parameter before it sends one; the plugin still refuses a malformed one with `INVALID_PARAM`.

### `set_brief` (write)

Params:

```
brief: { role, gear, title, lines: BriefLines, details, direction0?, directions?, chosen?, styleframes?, system?, deliverables? }
       — on an update, only the fields to change; `lines` and `details` merge key by key; `deliverables` adds ids
briefId?   — the node the brief is stored on: update that record
reopen?    — with briefId: status back to "open"
nodeId?    — store on this node instead of drawing a block
block?     — draw a block (default: true at page, top and piece; false otherwise; never in Slides)
pageId?, x?, y?
```

It stores a `BriefRecord` (id = the storing node's id, status "open" on a new brief, createdAt / updatedAt ISO), draws or redraws the block when there is one (a frame named `Brief · <title>`, 720 wide, vertical auto-layout, at an empty spot on `pageId` or the current page; FigJam: a section; lines Role · gear, Message, Goal, Audience, Success, Tone, Default to avoid, and a last line `Status: open — not signed off`), and upserts the file's index on `figma.root` (`upsertIndex`; when writing the root fails, on the page instead, and say so with `indexOn: "page"`). With no block and no `nodeId` it stores on the page.

Result: `{ briefId, blockId?, stored: "block" | "node" | "page", status, indexOn: "root" | "page", record: BriefRecord }`.

### `get_brief` (read)

Params: `nodeId?`, `briefId?`, `fingerprint?` (boolean), `target?` (`{ parentId?, pageId? }`).

- `briefId`: the record on that node.
- `nodeId`: the node's own record; else its top-level frame's; else the brief whose `deliverables` lists it or its top-level frame (from the index); else its page's. Its `signOff` record too, when it has one.
- `fingerprint: true` with `nodeId`: compute the node's fingerprint now and compare it with its sign-off's.
- No `nodeId` or `briefId`: every open brief in the file, from the index.
- `target`: the facts the gate needs, read only for the gate: the target's type, whether it sits at page level, its child count, and in Slides whether any slide in the deck has content.

Result: `{ brief?: BriefRecord, signOff?: SignOffRecord, fingerprint?: string, fresh?: boolean, open: BriefIndexEntry[], target?: { type, topLevel, childCount, deckHasContent? }, invalid?: string }`.

### `sign_off` (write)

Params:

```
briefId                 — the brief (the server resolved it)
nodeIds?                — the deliverables; default the brief's `deliverables`; none → INVALID_PARAM saying to name them
audits: AuditName[]     — from signOffSet(role, gear)
tokensWhenSystem?       — add "tokens" when the file has a design system
answerKinds: AuditName[]— infos of these audits that remain must be answered
answers: Answer[]
lenses: LensScore[], rounds: number, exceptions: LensScore[], placeholders: string[]
serverBlockers: string[]— what the server found (an incomplete brief, missing lenses); recorded, and they make ok false
build: { server, skills }
```

For each deliverable it runs `checkLayout` with the audits and the brief as `CheckOptions.brief` (part A adds that option; until it is merged, pass the audits it knows), takes errors and warnings as failures, lists the infos of `answerKinds` that no answer covers as `unanswered`, computes the fingerprint (`src/plugin/fingerprint.ts`), and writes a `SignOffRecord` on the deliverable — a failing attempt too. `ok` = no server blocker, no error or warning, nothing unanswered. On a pass: the brief's status becomes "signed", `lastSignOff` and `deliverables` are updated, the block's status line becomes `Status: signed off <date>`, the index is updated, and the deliverables are selected and zoomed to.

Result: `{ ok, checks: CheckSummary[], issues: Issue[] (errors and warnings, capped), unanswered: Issue[], fingerprints: Record<nodeId, string>, signedAt, briefStatus }`.

### Fingerprint

`src/plugin/fingerprint.ts`: a 32-bit FNV-1a hex string over the subtree in walk order, as the spec §3.2 lists (id, type, visible, x / y / width / height rounded to 0.5 px, characters, font family / style / size per run, solid fill and stroke hex with opacity, stroke weight, corner radius, effects count, layout mode, gap and padding, image hashes). Nodes carrying a `brief` record are skipped. It must be stable for an unchanged subtree and change for any edit in the list.

## `checkLayout` and the brief (A implements; B calls)

`CheckOptions` gains `brief?: BriefRecord`. From it the audits read: `details.platform`, `details.viewport` (device width for unit conversion: device units = frame px × device width ÷ frame width), `details.screens`, `details.controls`, `details.insets`, `lines.format`, `lines.minTextSize`, `lines.safeArea`, `system`. `figma_check_layout { briefId }` reads the record on that node and passes it in. Every audit skips a node that carries a `brief` record (the brief block is a working note). New `AuditKind`s: `a11y`, `states`, `copy`, `system` (wave B adds `deck`, `mark`, `icons`, `library`).

## Server (C implements)

- `RoleProcess` beside `MotionProcess`, one skill ledger for both (`noteSkill` fans out). `inForce` per file: the session's file key, else file name + editor type.
- Tools `figma_set_brief` (style group, write), `figma_get_brief` (read group), `figma_sign_off` (style group, write), with the parameters, validation order, lint and results of spec §3.4–§3.6. Not batchable. `figma_set_brief` computes `missingForSignOff` and `lint` from the record the plugin returns.
- The gate of spec §3.3 on `figma_create_frame`, `figma_create_from_spec`, `figma_create_section`, `figma_create_slides`, `figma_create_storyboard` and `figma_batch` steps, reading `get_brief { target }` when the parent is not obvious; the final-export gate of §3.7 on `figma_export_node` and `figma_export_frames_to_pdf` (`final?: boolean`), reading `get_brief { nodeId, fingerprint: true }`. The messages of §3.8 (N1, N2, B1–B3, E1, E2, S1, S2). Strict, guided, off as the motion gate; strict degrades to guided where §3.9 says.
- A role whose `skill` is not among the bundled skills (graphic, brand until wave B) is satisfied by its `fallbackSkill`.
- `figma_status` gains the `process` block of §3.8.
- Editor cells: `set_brief` and `sign_off` yes in Design; FigJam and Slides unmeasured; `get_brief` everywhere.
- Tool counts: 137 in the catalog, 136 registered by default; read 23, style 21.

## Rules for every worker

- Everything in English. Comments in the repository's style: why, with the spec section or the standard named.
- Do not edit `docs/reference/claims.md` or other locked documents (only C edits `docs/reference/tools.md`, and runs `node scripts/lock-docs.mjs --update` for it).
- `npm run typecheck` and the tests you touched must pass; run the full `npx vitest run` before you finish and report the result.
- Commit on your branch with `git -c user.name="Darrel Gusti" -c user.email="83781875+AvYour@users.noreply.github.com" commit`, no Co-Authored-By trailer. Do not push.
- Report: what you built, file by file; any change to this contract or to `roles.ts` you needed; what is left; test results.
