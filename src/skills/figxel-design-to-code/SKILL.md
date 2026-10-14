---
name: figxel-design-to-code
description: Turn a Figma design into code. Read the design and its render, map layout, tokens, assets, motion and prototype links to the project's stack, verify against the render, and write a codebase's design-system rules. Use whenever Figma is the source and code is the output.
---

# From a Figma design to code

The render is the target and the data is the source: read both before writing a line, reuse what the project already has, and verify only what you were asked to build.

## Context
1. Target: the node the user names — a Figma link or an id like "12-34" goes in as `nodeId` unchanged — or figma_get_selection.
2. figma_get_design_context { nodeId } — sizes, auto-layout, constraints, text (with its styled runs), fills, effects, and the styles, variables and components each node uses, by name. `stylesUsed` carries each style's id, key and `remote` (true for a library style), not its value. figma_get_variable_defs { nodeId } gives the values of every style and variable this screen uses, library ones included, resolved; figma_get_styles lists only this file's local styles, so a library style is never there [C-081]. Follow `nextCursor` until `truncated` is false. On a large screen read `depth: 1` first, then each section by its id.
3. figma_export_node { nodeId } straight after — the visual target. It is NEVER an asset: do not ship it, and do not crop pieces out of it.
4. figma_get_reactions for what clicks and hovers do; figma_get_annotations for the designer's notes; figma_get_motion_context { nodeId } for animated layers — it reads every layer inside, because a screen never animates itself, only its layers do [C-115]. Design context marks each animated node with `motion`.
5. Text longer than 400 characters is cut in design context: raise `maxTextChars`, or read it whole with figma_scan_text_nodes.

## Implementation
- Inspect the project first: its component folders, token files and installed design-library packages. Reuse what matches; match instances to existing components by component name, variant set and properties.
- Map, do not transcribe: auto-layout column/row + gap + padding → flex or grid; alignMain/alignCross → justify/align; sizing fixed / hug / fill → fixed size / content size / flex: 1 or width: 100%; absolute positions only where the design really overlaps things.
- Tokens: style and variable names (and `codeSyntax` where set) → the project's tokens. When the two disagree, prefer the project's token and adjust minimally; mention the difference.
- Assets: figma_download_assets { nodeIds } for every image and icon — renders per the node's export settings, plus each image's original bytes without the layers drawn over it. Place every visible asset exactly in its slot; SVG icons keep their root width and height. Add no icon package, redraw nothing, and never ship a temporary URL.
- Motion (figma_get_motion_context): keyframes → CSS @keyframes or motion.dev; easing HOLD → steps(1, jump-end), "cubic:x1,y1,x2,y2" → cubic-bezier(x1, y1, x2, y2), "spring:<bounce>" → a motion.dev spring with that bounce; translation and rotation add up, scale multiplies; honour prefers-reduced-motion.
- Prototype reactions → the project's router, links and state; prototype transitions are not motion keyframes.
- Text: `openType` TNUM → font-variant-numeric: tabular-nums, LIGA/CALT → font-feature-settings. SF Symbols come back as code points (`sfSymbols`): ask the user for the symbol name rather than guess.

## Verification
- Render your code at the export's size and compare it with figma_export_node.
- Verify only the requested scope; list other mismatches you noticed instead of fixing them unasked.
- Check each asset: the file exists and is not empty, it is used at its callsite, and it renders at the design's size.

## Sections of this skill
- section `rules` (references/rules.md, or figma_get_guide { topic: "design-to-code", section: "rules" }) — write a codebase's design-system rules once, so every later run makes the same choices.
