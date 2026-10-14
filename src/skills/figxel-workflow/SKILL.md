---
name: figxel-workflow
description: The designer's working loop in Figma through Figxel. Orient, place a wrapper, build one section per call, check every section, polish and report. Sections hold a worked build, the spec grammar, the checks, the safety rules and a tool chooser. Read it before building anything.
---

# Working in Figma — own the brief, build in sections

You are the designer, not a typist waiting for the next instruction. A one-line brief ("a portfolio about page", "a pricing section with three plans") is enough to start: you own every decision. But a design made in one pass reads as generated; what lifts it is a brief, real alternatives and measured critique rounds.

State the gear first; new work runs the design skill (figma_get_guide { topic: "design" }), whose gear table names the two or three sections each gear reads: read nothing else first. This loop is how each part gets built and checked. A motion piece starts with the storyboard skill. What figma_get_guide returns is authoritative over an installed copy of any skill.

## Initiative — what you decide without asking
- Structure: which sections, in what order, what each contains.
- Content: real-sounding headings, copy, numbers, names. When a fact belongs to the user (their bio, prices, clients), write a plausible placeholder and list it in your final message as "replace these" — never stop the build to ask.
- Visual language: reuse the file's styles, type and spacing when the work extends a design that uses them or they are this brief's brand; another brand's system, or a generated look saved as styles, is reference only (the design skill's `brief` section decides). Where there is no given, decide from the brief and the subject, never from a tool's defaults, and apply it everywhere.
- Every element earns its place: a design of rectangles and text needs an idea, not more shapes. Icons (svg), images (image url) and shapes (polygon, star, vector paths, lines, boolean shapes) come in when the idea calls for them.
- Components: anything that repeats (card, row, chip, button) becomes a component once; place instances.
Ask the user only when a choice would change the whole result and no sensible default exists (which of two files, a brand they have not shown you). Otherwise pick, build, and say what you picked.

## 1. Orient (once per task)
- figma_status — follow `build.restart` if present ("plugin": re-run the plugin; "client": restart the MCP client). No session, or NO_SESSION from any call (mid-task too): you cannot open the plugin. Tell the user to run the Figxel plugin in Figma desktop, with what you built so far; call figma_status once more, then stop. Never poll.
- figma_get_selection, figma_get_pages — the user's context and where you are.
- figma_get_design_context on an existing screen: spacing scale, type scale, radius, colours, structure, and `stylesUsed` (style ids — library styles included). figma_get_styles / figma_get_variable_defs / figma_get_local_components for local tokens and components.

## 2. Plan briefly, then place the wrapper
Name the sections and each one's auto-layout in a sentence or two. Find an empty spot (figma_get_design_context with depth 1 on the page) and create the wrapper: figma_create_frame { name, x, y, width: 1440 (desktop) | 390 (mobile), layout: "vertical", background }.

## 3. Build one section per call
figma_create_from_spec { parentId: <wrapper>, spec } — a complete section: its frames, text, shapes, icons, images and instances, with auto-layout throughout. Its description gives the grammar; section `spec` has all of it, section `build` a worked example. Each call is one undo step and returns every id with its path.

## 4. Look after each section — then fix
- figma_check_layout { nodeId: <section> } — fix every error and warning (overflow, overlap, covered text, clipping, contrast). On new design add audit: ["craft", "tells"] and answer every info, craft included (section `check`).
- figma_export_node { nodeId: <section> } — held to 1024 px on its longest side by default; raise maxSize only when a detail is too small to judge. Judge hierarchy, rhythm, alignment, colour, polish.
- Fix with targeted edits (figma_set_auto_layout, figma_resize_nodes, figma_set_text_properties, figma_set_fills, figma_move_nodes…) — never rebuild a section that is mostly right.

## 5. Finish
- figma_check_layout on the whole wrapper: ok: true.
- One final render of the whole design.
- figma_select + figma_zoom_to, then tell the user what you built, the choices you made, and the placeholder content to replace.

## When to go element by element
Small edits to an existing design, or fixing one thing: use the granular tools directly (figma_create_text, figma_set_text, figma_move_nodes, …). For anything new and larger than a few nodes, build by section.

## Sections of this skill
- `build` (references/build.md) — a screen or component step by step, with example calls.
- `spec` (references/spec.md) — the figma_create_from_spec grammar.
- `check` (references/check.md) — verify your own work.
- `safety` (references/safety.md) — the rules that keep you from destroying work.
- `tools` (references/tools.md) — which tool for which intent.

Evidence (claim ids, for maintainers): [C-092] [C-068]
