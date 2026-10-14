# Design-system rules for a codebase

Write a rules section once, so every later design-to-code run in this project makes the same choices. The create_design_system_rules prompt starts this playbook.

1. Read the Figma side:
   - figma_get_variable_defs: every token, with values per mode and codeSyntax.
   - figma_get_styles: text, paint, effect and grid styles with values.
   - figma_get_local_components: components and variant sets (figma_get_component for one's properties).
   - figma_get_design_context on one representative screen: the styles, variables and components (library ones included) a real screen uses.
2. Read the codebase: where components live and how they are named, the token sources (CSS variables, the Tailwind theme, theme objects), the styling approach, and how icons and images are stored.
3. Write ONE section into the client's rules file — AGENTS.md, CLAUDE.md, .cursor/rules/, or the path the user named. Append; never overwrite what is there. It states:
   - The flow: figma_get_design_context → figma_export_node (the visual target, never an asset) → figma_download_assets { nodeIds, dir: <the project's asset folder> } → implement → render and compare. `dir` must sit inside the export directory or a BRIDGE_EXPORT_ROOTS entry, so the rule also says the asset folder must be listed in BRIDGE_EXPORT_ROOTS; without `dir` the files land in the export directory.
   - Layout: which layout primitives auto-layout maps to.
   - Components: their folder and naming, and a table "Figma component → code component" for those that exist.
   - Tokens: a table "Figma variable or style → code token" (codeSyntax where set), and what must never be hardcoded: colours, spacing, radii, type.
   - Assets: where downloaded images and icons go, and that no icon package is added.
4. Show the user the section and the file it went into.
