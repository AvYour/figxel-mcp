---
name: figxel-code-to-design
description: Rebuild in Figma a screen or component that already exists in code. Content, fonts, components, icons and images come from the source, never invented, and the build runs one section per call. Use when the code is the brief.
---

# From code to a Figma design

Building in Figma what already exists in code: the code is the brief. Unlike a free brief, do not invent content and do not choose fonts by mood — take both from the source.

1. Read the source the user named and list its sections, the components it renders, and their DEFAULT props. Build the default state first.
2. Font: take the family from the code (CSS variables, Tailwind theme.fontFamily, the theme) and resolve exact Figma family and style names with figma_get_fonts, `scope: "available"` with `families` set to the code's families, never the unfiltered list; a family it does not list, or no such filter, is tried in figma_create_text, whose `fellBack` says whether it loaded [C-267]. Use Inter only when the code names no font. After building, figma_check_layout { nodeId, audit: ["fonts"], expectFonts: ["<family>"] }: a wrong_font finding, or `fellBack` in a create result, is a failure to fix.
3. Components, in this order:
   - A Code Connect mapping or a Figma link for THIS file names the component: pass its node id as componentId as is.
   - Reuse what existing screens use: figma_get_design_context shows each instance's component id and key; figma_get_local_components lists the rest.
   - Only then build: one main component per source component (props become component properties and variants), then place instances — never several near-identical frames.
4. Icons: the codebase's own SVG through figma_import_svg { svg, width, height, color } (or colorVariable). currentColor imports as black, so pass the colour. Never redraw an icon from lines, rectangles or ellipses.
5. Images: figma_import_image { url }, or { path } for a local file. The bridge reads only inside the export directory or a BRIDGE_EXPORT_ROOTS entry (a relative path resolves from the export directory), so a repository file is refused unless the repository is a root: ask the user to add it to BRIDGE_EXPORT_ROOTS, or copy the file into the export directory first.
6. Tokens: bind the file's variables and styles by name (spec `variables` and `style`). When a value in code and the Figma token disagree, ASK the user which one wins — the one question you do not decide alone.
7. A web app you can open: screenshot it with your browser tool, save it under an export root, place it beside the build with figma_import_image { path } as a reference, compare with figma_export_node, then delete the reference by its returned id.
8. Check as in every build: figma_check_layout per section and one render, then compare with the source once more.
