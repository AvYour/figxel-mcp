# The base workflow: seats, stages, records — design, 2026-10-20

The owner asked to settle the base workflow before planning further (2026-10-20): what the work looks like when several agents plan and judge together. This document is that base. The [role quality plan](2026-10-20-role-quality.md) and the [road ahead](2026-10-20-roadmap-ahead.md) build on it, and their workstreams are re-read against it once it is agreed.

It extends what exists:

- the shared stage skeleton S0–S10 of the [role spec](2026-10-14-roles-spec.md),
- the working loop of the `workflow` skill,
- the critique rounds.

Nothing here is built yet.

## 1. The idea in one paragraph

Today one agent plays every part: it writes the brief, invents the directions, builds, critiques its own build and signs it off. The base workflow splits that work into **seats**. A seat is a job with a defined view: what it may see, what it must not see, and what it hands on.

- Some seats make (directions, the build). Others judge (the panel). One merges the judgements (the chair).
- The lead owns the brief and the decisions. The owner is consulted at fixed points.
- **The core rule:** a seat that judges never sees the maker's reasoning, only the brief, the references, the renders and the measured numbers.
- The same seats run in any client:
  - in parallel where the client can start subagents;
  - one after another in a fresh context where it cannot;
  - with the owner taking a judging seat where neither works.

## 2. The seats

| Seat | Job | Sees | Never sees | Hands on |
|---|---|---|---|---|
| **Owner** (the person) | Asks, answers the decisions only they can make, approves at checkpoints, may score | Everything | — | The request; answers; an optional score |
| **Lead** | Owns the brief: role and gear, the brief and its `avoid` list, the system, the choice of direction, the merge of fixes into decisions, the report | Everything | — | The brief record, the system, the decision line, the report |
| **Scout** | Looks past the obvious: the subject's world, three or more references with what each lends, the category default to avoid | The brief | Any direction or build | A references board in the file, notes on the brief |
| **Direction maker** (two or three) | Makes one direction: an idea, a type and colour stance, a layout principle, and one styleframe | The brief, the references | The other makers' directions | One direction card and its styleframe |
| **Builder** | Builds the chosen direction a section per call, checks each section, fixes | The brief, the system, the chosen styleframe, the chair's fix list | The panel's raw debate | Frames; check results per section |
| **Reviewer** (a panel of two to five, by role) | Judges cold through one lens set: art direction, UX, accessibility, engineering, the owner's goal. Writes its verdict from the renders and the brief first, then reads the measured numbers and merges the two, noting what each missed; tries to falsify each finding before keeping it | The brief, the references, the renders; the `figma_check_layout` numbers only after its verdict | The builder's notes, the other reviewers' findings | A review: lens scores, findings with numbers and fixes |
| **Chair** | Merges the reviews: removes duplicates, resolves conflicting fixes, keeps an unresolved disagreement visible, orders the fixes | The brief, all reviews | The builder's notes | One fix list; a recommendation at the choice |

One agent may hold several seats in a small job. Two seats never share a context when one of them judges the other's work.

## 3. The stages

Each stage names its seat, what it produces and the gate that ends it. The S numbers are the role spec's; the gates marked **[T]** are tools-enforced today or planned to be.

| # | Stage | Seat | Produces | Gate |
|---|---|---|---|---|
| P0 | Intake: role and gear | Lead | One line in the reply | Stated (S0) |
| P1 | Brief | Lead | `figma_set_brief`: the seven lines, `avoid`, the role's `details` | **[T]** stored, lint clean (S1, S2) |
| P2 | Look | Scout | References board; the default named; `references` on the brief | **[T]** at top gear, three or more references (planned) |
| P3 | Directions | Direction makers, in parallel | Direction 0 named; two or three directions, each with a styleframe | **[T]** recorded with their maker seats (S4) |
| P4 | Choice | Panel scores the styleframes → chair recommends → lead decides; owner checkpoint when the brief asks | The decision line; `chosen` | **[T]** recorded (S4) |
| P5 | System | Lead | Type, grid, colour, shape and spacing as numbers | **[T]** recorded (S5) |
| P6 | Build | Builder | Frames, one section per call, each checked with `craft`, `tells` and the `avoid` match | **[T]** each section's check ok (planned: tells and `avoid` by default) (S6) |
| P7 | Role passes | Builder | States, accessibility, content (ux); grid and finish (graphic); and so on per role | **[T]** the role's audits (S7) |
| P8 | Critique rounds | Panel → chair → builder | Reviews, one fix list, the fixes applied, a regression check | Round budget 1 / 2 / 3 by gear (S8) |
| P9 | Sign-off | Lead | `figma_sign_off` with the reviews and their reviewer seats | **[T]** audits clean, no `avoid` match, distinct reviewers at top (planned) (S9) |
| P10 | Report and handoff | Lead | The report: choices, placeholders, what is left, who reviewed; the handoff pack when code follows | — (S10) |
| R | Revision | Owner → lead | The redirection recorded on the brief (`revision`), the screens it touches | Back to P3 for those screens: two alternatives, then P4–P9 |

**Why P3 uses separate makers.** One agent asked for three directions tends to give three variations of one idea; separate makers who see only the brief and the references diverge for real. Direction 0 stays the lead's job: the default to steer away from, named before the makers start.

**Why P4 scores styleframes, not descriptions.** A panel judging words rewards the best writer. Judging the styleframes rewards the best design.

**Why the builder never reads the raw reviews.** The chair's list is ordered and free of conflicts; the builder spends its calls fixing, not arbitrating.

## 4. Gears scale the workflow

| Gear | Stages | Seats | Panel |
|---|---|---|---|
| Edit | Fix and check | Lead | none |
| Section | P1 (short), P6, P8 | Lead, builder | one reviewer (cold), one round |
| Page | P1–P10 | All; one scout, two makers | two or three reviewers by role, two rounds |
| Top | P1–P10 with P2 and P3 in full | All; one scout, three makers | three to five reviewers, three rounds, distinct from the makers |
| Replica | P1, P5 (from the code), P6, P7, P9 | Lead, builder; one reviewer for fidelity | one round |

The panel's roles come from the role table:

| Role | Panel |
|---|---|
| ux | Art direction, UX, accessibility, engineering, the owner's goal |
| graphic | Art direction, a placement or print reviewer, copy |
| brand | Art direction, a mark reviewer (sizes, versions, clear space), positioning |
| presentation | Story, art direction, copy |
| motion | Motion craft, design and type, technical |

## 5. Modes, by what the client can do

| Mode | When | How the seats run |
|---|---|---|
| **Team** | The client can start subagents (Claude Code, for one) | Makers and reviewers run in parallel; each gets only its seat's inputs through its prompt |
| **Solo** | No subagents | One agent runs the seats one after another; each judging seat starts a fresh context from its prompt, which fetches the brief and the renders by id and nothing else |
| **Owner in the loop** | The owner wants to see the work first, or a client cannot isolate a judging seat | The owner scores the choice at P4 and two lenses at P8 (a score 1–10 and one sentence each); anything skipped is recorded as self-reviewed |

The record says which mode ran. A review that could not be isolated is recorded and reported as such, never as independent. Its report opens with that line.

The order inside a review comes from the [design skills research](2026-10-20-design-skills-research.md): a measured census anchors judgement, so the verdict comes first and the numbers after.

## 6. Records

The workflow rests on records the tools already keep, extended:

| Record | Where | New in the base workflow |
|---|---|---|
| Brief | `figma_set_brief` (shared plugin data on a brief block) | `avoid[]`, `references[]` required at top, `revision[]` |
| Directions | The brief's `directions[]` | Each direction's maker seat |
| Reviews | New: on the brief, per round | Reviewer seat, mode, lens scores, findings with node ids and numbers |
| Fix list | New: on the brief, per round | The chair's merged and ordered fixes, open disagreements |
| Sign-off | `figma_sign_off` record per deliverable | The reviews it counted, distinct reviewers, the mode |
| Change journal | `figma_get_changes` (trust, phase 9) | — |

Whether reviews are written through a new tool or through extra fields on `figma_sign_off` and `figma_set_brief` is a design choice for the implementation spec. Either way a new tool enters `docs/reference/tools.md` as a candidate first.

## 7. What the tools provide

Figxel is an MCP server: it cannot start agents. It provides what lets any client run the seats faithfully:

- **One prompt per seat** (lead, scout, direction maker, reviewer by role, chair). Each fetches only its seat's inputs by id and says what it hands on.
- **The records** in §6, and the gates in §3 that read them.
- **The skills,** which teach each seat its job:
  - The design skill's stages map to P0–P10.
  - The critique skill becomes the reviewer's and the chair's manual.

## 8. A worked example: a product settings revision

The owner said the settings pages had too much text and should be more visual. Under the base workflow:

1. **R.** The lead records the revision on the brief: settings pages, "more visual, less text". The `avoid` list keeps "admin pages built as stacked boxed cards" (`card_trio`, `skeleton_repeat`, `icon_tile_everywhere`).
2. **P3.** Two makers each restyle one settings page from the brief and the references, without seeing each other's work. Say, one makes grouped rows with inline controls and small charts, the other a two-pane overview with a detail panel.
3. **P4.** The panel scores the two styleframes; the chair recommends one; the owner sees both if the brief asks.
4. **P6–P7.** The builder applies the choice to the eight pages, each section checked against `avoid`. A grid of identical icon cards is a warning there, not an answered info at the end.
5. **P8.** The art-direction reviewer, seeing eight pages side by side cold, names the repeated skeleton. The chair orders that fix first.
6. **P9.** Sign-off counts two or more distinct reviewers and finds no `avoid` match.

What happened on 2026-10-19 instead: one agent took the first idea (cards with icons) and judged it itself.

## 9. Architecture: engine, harness, orchestrator (proposed 2026-10-20)

The owner pointed at the harness and orchestrator idea of ECC (github.com/affaan-m/ecc, a harness for coding agents):

- **A harness** surrounds an agent in its client: role-scoped agents, skills, commands, hooks that run outside the model's context, rules, and memory for handoffs.
- **An orchestrator** coordinates them: order, fan-out, verification loops.

Mapped onto the seats and stages above, Figxel would have three layers:

| Layer | What it is | Holds | Runs where |
|---|---|---|---|
| **Engine** | The MCP server and the plugin, as today | The tools, the records (§6), the gates (§3). The source of truth, and the only layer every client gets | Any MCP client |
| **Orchestrator** | The base workflow as a state machine kept by the engine | A run record per brief: the current stage, the seats each stage needs, what each seat must hand back. A "next step" answer telling the lead which seats to start with which prompts, and why a stage cannot close yet | The engine keeps the state; the client executes the steps |
| **Harness** | An optional pack per client, installed by `setup` | One agent definition per seat, with only the tools that seat may use; the seat prompts; hooks | The client: Claude Code first, others by adapter |

Examples of harness hooks:

- after each build call, put the section's tells delta in front of the builder;
- before the lead ends a turn at top gear, say which stage is open.

**Why this split.**

- **Isolation becomes structural, not declared** (open question 1).
  - A reviewer seat defined with read-only tools (export, check, brief) cannot write, and starts with only its seat prompt.
  - Whether a client can restrict a subagent's tools this way is a fact about each client. It is verified and registered per client before the harness relies on it.
- **The orchestrator stays client-agnostic.**
  - A client without subagents follows the same "next step" answers one seat at a time (the solo mode of §5).
  - A client with them runs the fan-outs in parallel.
- **The engine stays the authority.** A harness adds speed and isolation, never a rule the engine does not also check. A user without the harness loses convenience, not safety. That keeps Figxel usable from any client.
- **Handoffs already have a home.** The brief, the reviews and the sign-off live in the Figma file, so another session, or another person's agent, can pick a run up where it stopped. This is ECC's memory idea, kept with the design rather than beside it.

**What it costs.**

- An adapter per client to keep current.
- A run record and a "next step" tool in the engine, both entering `docs/reference/tools.md` as candidates first.
- More agent calls per run. The gear table in §4 bounds them.

**Order, if adopted.**

1. The run record and "next step" in the engine (solo mode works everywhere).
2. The Claude Code harness pack (seat agents, prompts, two hooks).
3. Adapters for other clients as users ask.

## 10. Decisions (2026-10-20)

The owner delegated these, with one condition: Figxel must not drift from its purpose, which is to let any AI agent, in any MCP client, design in Figma with a professional's quality, locally and safely. The point of this work is the quality of what Figxel makes.

Every item in this document is therefore tested against one question: **does it raise the quality of the work, in every client?** What does not pass waits, however interesting.

1. **Isolation: by context, declared and recorded.**
   - A judging seat starts from its seat prompt, which fetches only the brief, the references and the renders. A subagent's fresh context or a new conversation gives that isolation in any client.
   - The seat and the mode are recorded and reported honestly.
   - Tool restrictions through a client harness are not needed for quality and wait (decision 6).
2. **Cost: start small, grow only on evidence.**
   - Section gear keeps the builder's own check, as today.
   - Page gear adds one cold reviewer: art direction, judging the message and originality lenses.
   - Top gear adds two: art direction, plus the role's own reviewer (UX for ux, placement for graphic, mark for brand, story for presentation).
   - A larger panel and the chair come only if the benchmark ([road ahead §4](2026-10-20-roadmap-ahead.md#4-a-benchmark-for-professional)) shows they raise scores.
3. **The owner's checkpoint: unchanged.**
   - The agent owns the brief and runs to the end, as the workflow skill already says.
   - It stops at the choice only when the brief or the request asks (the existing `checkpoint`).
4. **One writer on the canvas.**
   - Direction makers do not write to the file. Each returns a direction card and a styleframe spec, and the builder places them, one at a time.
   - Reviewers only read.
   - Parallel writers through one plugin connection would share one agent identity in the change journal, and a rollback could not tell them apart. One writer keeps trust's guarantees whole.
   - Separate makers are used at top gear; at page gear the lead writes the directions, and the cold reviewer scores the styleframes.
5. **Panels: from the role table, fixed.** The brief does not choose its reviewers at first.
6. **Reviews live on the brief.**
   - The sign-off record points to the reviews it counted.
   - The orchestration stays inside the engine and stays small: `figma_get_brief` answers the next stage and what is missing, with no new tool for it.
   - A client harness waits until the benchmark shows a need that the engine cannot meet.

**What this changes in the order of work.** The quality levers come first, because they change the output directly:

1. The `avoid` list that binds, and tells while building.
2. The new tells, with the dashboard-kit cluster from the [design skills research](2026-10-20-design-skills-research.md).
3. The app-screen chapter for the ux role, and a light-or-dark scene sentence in the brief.
4. One cold reviewer whose verdict comes before the numbers.
5. Then the benchmark, to measure what these changed.

The false `STALE` fix still lands before 0.2.0 is released. The release itself can wait for the quality work.

## 11. Open questions

The six questions below were asked on 2026-10-20 and settled by the decisions in §10. They stay here as the record of what was weighed.

1. **Isolation.** Subagents in one client may share one MCP connection, so the server cannot tell seats apart by transport. The seat is declared in the prompt and the record. Is a declared seat, reported honestly, enough, or should a judging seat prove isolation some other way?
2. **Cost.** A top-gear run with three makers and five reviewers over three rounds is many agent calls. Is the panel at top gear only, with one cold reviewer at page gear, the right default?
3. **Owner checkpoints.** At P4 always, only when the brief asks, or at top gear by default?
4. **Panel roles per role.** Is the table in §4 right, or should the brief be able to name its own panel?
5. **Where reviews live.** On the brief block, on each deliverable, or both?
6. **The architecture in §9.** Should the orchestrator live in the engine (state and "next step", recommended) or only in a client harness? And which harness comes first?
