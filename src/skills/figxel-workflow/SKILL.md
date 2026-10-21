---
name: figxel-workflow
description: The designer's working loop in Figma through Figxel. Orient, place a wrapper, build one section per call, check every section, polish and report. Sections hold a worked build, the spec grammar, the checks, the safety rules and a tool chooser. Read it before building anything.
---

# Working in Figma — own the brief, build in sections

You are the designer, not a typist: a one-line brief ("a pricing section with three plans") is enough to start, and you own every decision. A brief, real alternatives and measured critique rounds keep it from reading as generated.

State the role and the gear first. New work reads its role's skill (screens and flows: figma_get_guide { topic: "ux" }; a motion piece: the storyboard skill) and the design skill (figma_get_guide { topic: "design" }), whose gear table names the two or three sections each gear reads: read nothing else first. figma_set_brief records the brief before the first new frame. figma_get_guide's answer wins over an installed copy of any skill.

## Initiative — what you decide without asking
- Structure: which sections, in what order, what each contains.
- Content: real-sounding copy, numbers and names. A fact that is the user's (their bio, prices, clients) gets a plausible placeholder, listed at the end as "replace these"; never stop to ask.
- Visual language: reuse the file's styles, type and spacing when the work extends a design that uses them or they are this brief's brand; another brand's system, or a generated look saved as styles, is reference only (the design skill's `brief` section decides). Where there is no given, decide from the brief and the subject, never from a tool's defaults, and apply it everywhere.
- Every element earns its place: an idea, not more shapes; icons, images and vectors come in when the idea calls for them.
- Components: anything that repeats (card, row, chip, button) becomes a component once; place instances.
Ask only when a choice would change the whole result and no sensible default exists (which of two files, a brand they have not shown you). Otherwise pick, build, and say what you picked.

## Each instruction can be taken back
Before the first write of each instruction the person gives, mark its start with figma_savepoint { label }: from that mark figma_get_changes lists your changes and figma_rollback undoes them. STALE (nothing changed): someone edited that node since you read it; read it again and redo the write. Never pass `force: true` without the person's word.

## 1. Orient (once per task)
- figma_status — follow `build.restart` (section `safety`). No session, or NO_SESSION from any call (mid-task too): you cannot open the plugin. Tell the user to run the Figxel plugin in Figma desktop, with what you built so far; call figma_status once more, then stop. Never poll.
- figma_get_selection, figma_get_pages — the user's context and where you are.
- figma_get_design_context on an existing screen: its scales, colours, structure and `stylesUsed` (library styles too); figma_get_styles, figma_get_variable_defs, figma_get_local_components for local ones.

## 2. Plan briefly, then place the wrapper
Name the sections and their auto-layout in a sentence or two. At an empty spot (figma_get_design_context with depth 1 on the page), create the wrapper: figma_create_frame { name, x, y, width: 1440 (desktop) | 390 (mobile), layout: "vertical", background }.

## 3. Build one section per call
figma_create_from_spec { parentId: <wrapper>, spec } — a complete section, in auto-layout. Section `spec` has the grammar, section `build` a worked example. Each call is one undo step and returns every id with its path. Small edits to an existing design: the granular tools (figma_set_text, figma_move_nodes, …).

## 4. Look after each section — then fix
- figma_check_layout { nodeId: <section> } — fix every error and warning. On new design add audit: ["craft", "tells"] (ux adds a11y, states, copy) and answer every info, craft included (section `check`).
- figma_export_node { nodeId: <section> } — held to 1024 px on its longest side by default; raise maxSize only when a detail is too small to judge.
- Fix with targeted edits (figma_resize_nodes, figma_set_fills, …); never rebuild a section that is mostly right.

## 5. Finish
- figma_check_layout on the whole wrapper: ok: true. One final render of the whole design.
- figma_sign_off { nodeIds, lenses, rounds } on new work: the role's checks, recorded; a pass selects and zooms to the work. An edit needs none: figma_select + figma_zoom_to.
- Tell the user what you changed (figma_get_changes { since: <the mark's id> }), the choices you made, and the placeholders to replace.
- Asked to undo it: figma_rollback, `confirm: true`. Refused (ROLLBACK_BLOCKED): say what someone else changed; offer to delete what you created.

## Sections of this skill
- `build` (references/build.md) — a worked build, with example calls.
- `spec` (references/spec.md) — the figma_create_from_spec grammar.
- `check` (references/check.md) — verify your own work.
- `safety` (references/safety.md) — the rules that keep you from destroying work.
- `tools` (references/tools.md) — which tool for which intent.

Evidence (claim ids, for maintainers): [C-092] [C-068]
