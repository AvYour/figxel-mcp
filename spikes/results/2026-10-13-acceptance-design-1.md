# Acceptance run 1 (design, single agent) — 2026-10-13 — stopped before the first node

Brief: "A landing hero for a wood-fired pottery studio." The agent oriented, wrote the brief, struck the category default, wrote three directions (A "Firing log" chosen, C graft, B dropped), then the plugin died.

## Tool defects found
1. figma_suggest_fonts { mood, use: "marketing", limit: 3 } STALLED twice ("The operation stopped reporting for 30 s ... retry with the same idempotencyKey"), then the plugin session dropped (NO_SESSION) and did not return for 20+ min. This Figma lists 10,038 font styles (2,284 families). Likely the catalogue match over listAvailableFontsAsync blocks the plugin thread with no yield/progress.
2. The STALLED hint tells the agent to retry with the same idempotencyKey, but figma_suggest_fonts has no idempotencyKey parameter.
3. figma_get_fonts { scope: "available" } returned 465,683 characters (10,038 styles) — past client result limits; no family filter / query / limit parameter, so an MCP-only agent cannot use it. The skill tells agents to "list what loads with figma_get_fonts { scope: "available" }".
4. figma_get_design_context { nodeId: "0:1" } (a non-current page) failed twice with "INTERNAL: Unable to establish connection to Figma after 10 seconds. Please check your internet connection." — a misleading message (page load, not network).
5. A session absent at start: the only advice is "Open the plugin", which an agent cannot do — fine, but the skill should tell the agent to report and wait/stop rather than poll for minutes.

## Skill issues found
- Gear: "a landing hero" fits no row (section = part of an existing design; page = page/screen/deck; top = must stop a stranger).
- Givens vs brand: skills say treat the file's styles/variables as givens; here they belong to another brand (Moku) and match cluster 1. Nothing says what to do when the file's system is not the brief's brand.
- "Two styleframes if within a point" — is a 1.0 gap within? Cards have three scores + pass/fail and no combining rule.
- At the page gear with one view as the deliverable, the leading styleframe IS the deliverable: clone and refine it, or rebuild? (conflicts with "never rebuild a section that is mostly right").
- Safe zones assume a placement with a published spec; a web hero has none; "the fold" is not covered; passing safeArea flags deliberate text below the fold.
- A 16 px floor and an 18 px body differ by 11 %, so near_size fires; the ratio rule ignores a floor between steps.
- Length: 14 figma_get_guide calls (~30k tokens) before the first node; a ~20-line footer on every answer; the minTextSize formula restated ~5 times; [C-xxx] citations unresolvable through any tool — noise for client agents.

## Found later (2026-10-13, motion agents)
- figma_create_from_spec refuses a text lineHeight given as a string ('spec.children[2].lineHeight must be a number >= 0'), while figma_set_text_properties takes lineHeight as a string such as '150%': the two tools disagree on the format. Fixed 2026-10-14: figma_create_from_spec and figma_create_text take lineHeight and letterSpacing in figma_set_text_properties' strings, and a number as px.
- Claude Desktop restarts the figma-mcp stdio server about 2 s after its tool calls time out (stdin closed); a hub takes every proxy's in-flight render with it. Evidence: `2026-10-13-diagnosis/host-restart.md` [C-271]. Fixed by answering BUSY while a render holds the plugin (`src/server/bridge.ts`, `test/busy-render.test.ts`).

## Found while fixing the Boathouse end card (2026-10-14, main agent)
- Live evidence for C-201/C-202: twice, figma_set_keyframes answered 'Figma dropped 1 track(s) on the first write; they were written again and read back.' (status 'rewritten') on nodes 93:3164 and 93:3169 inside the animated frame 93:3162, during a second-id period (motion context listed children as 99:xxx while the held ids were 93:xxx). The D1 verify-and-repair loop caught and fixed it live.
- Second-id periods recur: ids 99:411... resolved for reads, then NODE_NOT_FOUND minutes later; the new hint text explained it correctly.
- Inconsistency: figma_check_motion takes holds as {from, to} in seconds; figma_review_video takes holds as {fromFrame, toFrame} in frames. Unify. Fixed 2026-10-14 (f2ed15d): each takes both shapes.
- figma_review_video called in parallel with figma_export_video answered 'No video at ...' because the file did not exist yet; fine, but a hint could say to wait for the export.
- After Figma was restarted, renders took 51 s, 11.8 s and 10.6 s (before: 240 s timeouts): the stuck-export state lived inside Figma and a restart cleared it.
