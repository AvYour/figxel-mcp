---
name: figxel-design-system
description: Reuse or create a Figma file's design system with Figxel. Styles, variables, components and team-library assets, a library built in order (tokens, styles, components), and choosing and applying type. Use when a design must follow or extend a system.
---

# Using (and creating) the file's design system

First decide whose system it is: its style, variable and collection names, the file's name and the screens that use it say so. Apply it when the user pointed at it, when the work extends a design that uses it, or when it is this brief's brand. Another brand's styles, or a generated look saved as styles, are reference: read them, never apply them to this work and never edit them; the design skill's `brief` section has the rule, and when to ask.

Read:
- figma_get_styles — paint, text, effect and grid styles, each with its value, key and bound variables.
- figma_get_variable_defs — collections and modes, and every variable's value per mode, scopes and codeSyntax. With { nodeId }, only the tokens that screen uses, resolved.
- figma_get_local_components — components and variant sets; figma_get_component for one's properties, variants and key.
- Styles from a team library are NOT in figma_get_styles (it lists local styles). Read them off an existing screen: figma_get_design_context returns `stylesUsed` with each style's `id` and `key` (remote: true for library styles) — apply those ids with figma_apply_style_to_node { styleId }.
- Library variables: figma_get_library_variables lists them by collection; figma_import_library_assets { assets: [{ kind, key }] } brings a library component, set, style or variable into the file by key. Keys come from figma_get_design_context (`componentsUsed`, `stylesUsed`, `variablesUsed`) on a screen that uses them, or from the library file opened in a second session.

Apply instead of raw values:
- figma_apply_style_to_node { nodeIds, styleName, type? } — a paint style on fill (default) or stroke, a text style, an effect style.
- **A text style is not only a font — it is font, size, line height, letter spacing and case.** Applying one to a node of a different rank does not restyle it, it replaces its type: measured on a real screen, applying a 15 px label style took a 200 px display heading down to Silkscreen 15. Match a text style to nodes of the same kind (a label style on labels, a body style on body), and leave display type on raw values — the pages of a file usually do exactly that. Read the pairing off an existing screen before applying anything: figma_get_design_context reports each node's `styles.text`, and nodes of the same rank share one.
- figma_bind_variable_to_node { nodeIds, field, variableName } — field: fill, stroke, radius, gap, padding, width, height, opacity, or any Figma bindable field.
- figma_create_instance { componentId } — never redraw a component that exists. Change an instance's variant with figma_set_instance_properties ({"Size":"Large"}); figma_swap_component swaps it to a different component, and given a component SET it lands on the set's default variant.

Create a system when the file has none and the user wants one (topic "library" has the full playbook):
- tokens: figma_create_variable_collection, then a whole family per call with figma_create_variables (value strings: "#1a2b3c", "16", "true", "alias:color/blue/500"); scopes and codeSyntax later with figma_set_variable_properties.
- styles: figma_create_paint_style, figma_create_text_style, figma_create_effect_style.
- components: build the element (a spec with type "component", or an existing frame + figma_convert_to_component), then make it configurable with figma_add_component_property (TEXT for labels, BOOLEAN to show/hide an icon, INSTANCE_SWAP for a nested icon). Variants: name each component "Size=Large, State=Default", then figma_combine_as_variants. Never detach an instance to edit it.
- light/dark: figma_add_variable_mode + figma_set_variable_value per mode (extra modes need a paid Figma plan — Figma's refusal is returned as is). A mode shows nowhere until a frame uses it: figma_set_variable_mode { nodeIds: [<frame>], collectionName, mode: "Dark" }.

figma_check_layout lists raw colours when the file has styles or variables they should be bound to; { audit: ["tokens"] } names each unbound colour, spacing and radius, and { audit: ["handoff"] } gives the share bound to the system, detached instances and duplicate styles.

**The design-system role.** New tokens, styles or components: figma_set_brief { role: "design-system", gear, title, goal, message, success, details } first, `details.scope` tokens, components or both (`platforms`, `modes`, `components` when known). Every interactive component has its states as variants of one `State` property (the ux skill's `states` section). figma_sign_off ends it: tokens, names, fonts, states and a11y must pass.

## Sections of this skill
- section `library` (references/library.md, or figma_get_guide { topic: "design-system", section: "library" }) — build a token and component library, in order.
- section `typography` (references/typography.md, or figma_get_guide { topic: "design-system", section: "typography" }) — choose fonts that fit, and apply them.
