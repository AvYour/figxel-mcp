# Feature research and the next big release — 2026-10-19

The owner asked to hold the next release until it carries a big feature, chosen from user feedback and from what the field needs. This record holds the evidence, the candidates scored, and a recommendation. It is a working plan, not a decision: the owner picks. External facts here come from two research subagents (sources read 2026-10-19) and are not yet in `docs/reference/claims.md`; any of them that shapes the design is registered, with its quote, before it is relied on.

## Inputs

**Feedback Figxel has had.**

- After the 0.1.1 launch post: a designer asked for a structural check (how much is bound to variables and styles, detached instances, duplicate styles) — built as the `handoff` audit. A founder asked whether Figxel reads the file's own components and variables before building (it does). The founder of a design-QA product asked whether a check of the built page against the Figma frame, once real content is in, would help after Figxel builds a design.
- The owner: the agent must act as the professional each task needs, with planning before and testing after (built: the role process, ADR #42); sound from the owner's own licensed files (held); a way without the plugin (none sanctioned: the REST API cannot write and the official MCP is Figma's own); robust video export.
- A user: the plugin showed "Connected" while the app said the token was refused (fixed in 0.1.1).

**What people report (research report 1: forum, GitHub, Hacker News, blogs; Reddit could not be read).** Themes by frequency and intensity:

1. Setup, access and quotas around the official server: a client allowlist (Hacker News, 189 points, 2026-10-01; forum thread 52507), OAuth failures across clients, seat requirements, rate limits (Framelink #258). Figxel works through a local plugin in Figma desktop instead.
2. Design-system adherence: generated designs build look-alikes instead of the library's components and hardcode values (forum 42235; Bitovi's test of the official write tool, 2026-03-25).
3. Design-to-code fidelity: wrong overrides returned silently, partial context taken as complete.
4. Generic output: a published checklist of AI tells (purple gradients, Inter, uniform spacing, missing states); weak copy.
5. Code to design: captures lose content and effects and have no link to the team's libraries (Codeminer42, 2026-03-06; forum 52135, 56218).
6. Safe co-editing, the highest intensity: an agent rewrote a text from a stale read and destroyed a person's concurrent edit, unrecoverable (claude-code #87469, 2026-08-17); unrequested edits and partial undo (forum 55378); no parallel work across files (figwright #209).
7. Real content, states, edge cases and localization: flows and states left undefined, RTL shipped mirrored, invented focus and disabled styles.
8. Responsive variants: one breakpoint designed, the others broken; "a desktop-only audit is worse than no audit" (savvy.co.il, 2026-09-30).
9. Design QA of the shipped page against Figma: argued as the best use of AI in Figma (forum 46468); only small vendors try.
10. Handoff: agents should write annotations and specs, not only read them.
11. Motion and prototyping: prototype tools incomplete in other bridges; motion still needs tuning by people.

**The field (research report 2: Figma's docs and release notes, GitHub, npm).**

- The official server: about 18 read and 14 write tools; writing through `use_figma` (Plugin API JavaScript), captures (`generate_figma_design`, with no link to libraries), images, shaders, diagrams, Code Connect. Writing needs a paid plan, the remote server and a Full seat outside drafts; it is free in beta and announced to become usage-based; only allowlisted clients connect, and adding new ones was paused (forum, 2026-08-27); locally installed fonts are not available to it. Figma states a goal of parity with the Plugin API.
- Figma's own AI: the Figma agent (generally available 2026-10-06, on AI credits), Motion (keyframes, presets, audio, text animation, Lottie export), Make, Check designs (lints raw values and contrast; Organization and Enterprise only), native DTCG import and export of variables.
- Open-source bridges: figma-console-mcp (about 127,000 downloads a month; two-way DTCG token sync, 14 WCAG checks, design-code parity, version-history diff — the closest competitor on design systems and QA), figwright (about 1,100 stars; motion, export, prototype flows, several open files, code maps and a design diff; no layout or accessibility lint), Framelink (about 350,000 downloads a month; read-only), Talk to Figma (older, unauthenticated relay). All of them are development plugins, as Figxel is.
- The complaints about bridges: fragile connections and setup, timeouts on large files, quotas, token bloat, abandoned projects, unauthenticated relays, view-only seats.
- The strategic risk: Figma's parity goal shrinks any lead in tool count. Figxel's durable lead is the process and quality layer (skills, roles, audits, sign-off), any client.

**Registry drift the research found** (to verify and update before the release): the official tool list grew past [C-087]'s 18 tools; [C-003]'s Organization rate limit; [C-007]'s Dev seat now writes in drafts; [C-153]'s screenshot read now covers Slides.

## Candidates

Scores are judgements from the evidence above: need (how often and how hard people ask), unique (whether anyone serves it well), effort (relative to the role process, which was about 3,000 lines of code and 2,400 of tests), and fit (how much it builds on what Figxel has).

| # | Candidate | Need | Unique | Effort | Fit | Notes |
|---|---|---|---|---|---|---|
| 1 | **Safe co-editing**: a stale-read guard on writes (refuse an overwrite of a node a person changed since the agent read it, using the content fingerprint), a change journal per session (what the agent changed, reviewable), and checkpoints with a rollback of a whole instruction | Highest intensity (data loss) | Nobody | Medium | High: fingerprint, idempotency, one undo step per call, sessions per file already exist | Rollback must refuse when a person edited after the checkpoint, or it repeats the data-loss bug |
| 2 | **Content and state stress test**: copies of a frame at an empty spot with long text, pseudo-localised and expanded text, RTL, empty and error data, and large numbers; each checked; a report of what breaks; the original untouched | Medium-high; matches the design-QA founder's "real content" point inside Figma | Nearly nobody (one paid tier) | Small-medium | High: `figma_check_layout`, the `states` and `copy` audits | Cheapest high-value item |
| 3 | **Responsive variants**: breakpoint frames generated from one source, then audited as a set (reflow at 320 CSS px, targets per platform, type floor) | Medium | Few | Medium | Medium-high | Needs a rule for what changes per breakpoint; the ux skill's flows section is where it is taught |
| 4 | **Flows from a brief**: screens, reactions and flow starts, then a reachability and dead-end audit | Medium | Figma's agent prototyping is "coming soon" | Small-medium | High: reactions, flows and the ux role exist | Pairs with 3 |
| 5 | **Browser bridge, design QA**: a frame against the live page at each breakpoint (positions, sizes, type, colour, text), with a report | Underserved, high value | Small vendors only | High | Medium | Uses a local headless browser through the DevTools protocol, with no new runtime dependency; overlaps the founder who asked — decide build or partner first |
| 6 | **Browser bridge, capture and systemise**: a URL or HTML rebuilt as layers on the file's own components and variables, with auto layout, then the system audit | High expectation | Nobody remaps captures onto the library | High | Medium | Shares the browser infrastructure with 5; fragile on complex pages |
| 7 | **Comments round trip**: read comments, cluster, apply, reply | Requested, unanswered by Figma | Yes | Medium | Low-medium | The Plugin API cannot read comments; it needs the REST API and a personal token, so a new secret to handle |
| 8 | **Local and CJK fonts** | Specific, loud in one community | Official server cannot | Tiny (a spike) | High | A live check, then a claim and a line in the README |
| 9 | **Two-way token sync (DTCG, Tailwind)** | Medium | No: figma-console-mcp and Figma's native DTCG lead | Medium | Medium | Not a place to compete now |
| 10 | **Live verification debt**: FigJam and Slides writes (16 tools refused until measured), the role process, the motion gate, video export by window state | Users meet refusals today | — | Small per run, needs the owner | High | Not a feature, but it turns built work into usable work |

## Recommendation

Lead with what Figma's parity goal cannot erase: the process and quality layer, any client. In order:

1. **The next release, "trust": safe co-editing (1) and the content and state stress test (2)**, shipped with the role process already built. Both answer the sharpest feedback — data loss from stale writes, and designs that break once real content arrives — and both build on what exists (the fingerprint, the audits). Before it ships: one live session for the role process, the handoff audit and these two, the local-fonts spike (8), and the registry drift above.
2. **Then "flows": responsive variants (3) and flows from a brief (4)**, the ux role's natural next steps.
3. **Then "browser bridge": design QA (5) and capture and systemise (6)**, one infrastructure for both. Talk to the design-QA founder first: integrating or partnering may serve users better than building 5.
4. **Throughout:** the live runs of item 10, a few at a time, so the FigJam and Slides tools stop refusing.

Not now: token sync (9), comments (7) until a token-handling design exists, shaders and Figma's credit-based tools.

## Decided (2026-10-19)

- **The next release carries "trust"**: safe co-editing (1) and the content and state stress test (2), released with the role process as 0.2.0.
- **Design QA against the live page (5): talk to the design-QA founder first** about integrating or partnering, before building it.

## Decisions for the owner (as asked)

- Which theme goes into the next release: "trust" (recommended), "flows", or "browser bridge".
- Design QA against the live page: build it, or talk to the founder who asked about integrating.
- Whether the next release is 0.2.0 with the role process and the chosen feature together (recommended), or 0.2.0 now and the feature in 0.3.0.
