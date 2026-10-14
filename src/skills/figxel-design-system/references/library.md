# Building a design library — tokens, styles, components

Order matters: variables before styles, styles before components, and every component bound to tokens. Names are deterministic, so a rerun finds what exists and continues; never delete to start over.

## 0. Read what exists — always first
- figma_get_variable_defs: collections, modes, values, scopes, codeSyntax. Copy the file's naming ("color/bg/default" or "Colors/Background"), its scope habits and its mode names; never start a second scheme.
- figma_get_styles and figma_get_local_components: what is there, with values, keys and variant properties.
- Team libraries: figma_get_library_variables lists their variables by collection key; figma_import_library_assets { assets: [{ kind, key }] } imports a component, set, style or variable. Keys come from figma_get_design_context (componentsUsed, stylesUsed, variablesUsed) on a screen that uses them, or from the library file opened in a second session.
Exit: you can name each existing token family and its naming pattern.

## 1. Foundations — primitives, then semantic aliases
- Primitives (the raw palette, the spacing scale, radii) in their own collection with `scopes: []`, so they never appear in Figma's pickers.
- Semantic tokens in a collection with modes (Light, Dark), each value an alias: "alias:color/blue/500". One figma_create_variables call per family, a value per mode; `ifExists: "skip"` resumes a half-built family.
- Scopes by role: backgrounds FRAME_FILL / SHAPE_FILL, text colour TEXT_FILL, borders STROKE_COLOR, spacing GAP, radii CORNER_RADIUS, sizes WIDTH_HEIGHT, type FONT_SIZE / LINE_HEIGHT / LETTER_SPACING.
- codeSyntax WEB as the codebase writes it: "var(--color-bg-default)". Change scopes, codeSyntax or names later with figma_set_variable_properties; rename collections and modes with figma_update_variable_collection.
- A mode shows on a frame only once applied: figma_set_variable_mode { nodeIds, collectionName, mode: "Dark" }.
Exit: figma_get_variable_defs lists every token with a value per mode, scopes and codeSyntax.

## 2. Styles
- The type ramp as text styles (figma_create_text_style), elevation as effect styles, layout grids as grid styles (figma_create_grid_style), paint styles bound to a variable (variableName).
- Change a style in place with figma_update_style: deleting and recreating it detaches every layer that uses it.
- figma_set_description on each: when to use it.
Exit: figma_get_styles shows each style's value and bound variables.

## 3. Components — one page each
- A page per component (figma_create_page), built with figma_create_from_spec, every fill, stroke, padding, gap and radius bound through `variables` — no raw values.
- Variants: name each component "Size=Large, State=Hover", build them all in ONE figma_create_from_spec, then figma_combine_as_variants { componentIds, columns: "State" } lays the set out as a grid. Keep a set at 30 combinations or fewer; split by a property beyond that.
- Properties: TEXT for labels, BOOLEAN to show or hide a part, INSTANCE_SWAP for icons with `preferredValues` (the icon components). Rename or rewire with figma_edit_component_property instead of deleting and re-adding.
- figma_set_description, with a documentationLink, on every set.
Exit per component: figma_check_layout { nodeId, audit: ["tokens", "names"] } reports no unbound_color, and figma_get_component shows the properties you meant.

## 4. Document and validate
- A foundations page: swatches filled from the semantic tokens, the type ramp as text in its styles.
- figma_check_layout { audit: ["tokens", "names", "fonts"] } on every page; fix each warning.
- Report what you built, by page, and anything you could not bind.
