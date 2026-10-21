# Accessibility — in numbers, per platform

Accessibility is not a mood or a final check: it is a set of numbers the design meets from the first section, and a walk through the screens without a mouse. The numbers below come from WCAG 2.2, Apple's Human Interface Guidelines and Android's own guidance; the brief's `details.a11y` says whether the target is AA (the default) or AAA.

## The numbers

| | Web and desktop (CSS px) | iOS (pt) | Android (dp) |
|---|---|---|---|
| Text contrast | 4.5:1; large text (24 px, or 18.66 px bold) 3:1 | the same | 4.5:1 under 18 sp (14 sp bold), else 3:1 |
| Control edges, focus indicators, icons people need | 3:1 against what is next to them | the same | the same |
| Target size | 24 × 24 minimum (AA); 44 × 44 (AAA) | 44 × 44 default; 28 × 28 the minimum | 48 × 48 |
| Space between targets | an undersized target's 24 px circle touches no other target or circle | about 12 pt of padding round a bezelled control, 24 pt round a bare one | 8 dp or more |
| Focus | visible on every control (AA); at least a 2 px perimeter with 3:1 change (AAA) | the same; the audit reports it as info | the same; info |
| Smallest text | the brief's floor | 11 pt minimum, 17 pt default | the brief's floor |
| Text enlarged | to 200 % with nothing lost | to 200 % | — |
| Narrow width | one column at 320 CSS px | — | — |

A target is the whole area that responds, not the visible shape: a 24 px icon inside a 48 px frame is a 48 px target. Build screens at the viewport's width (section `flows`), so these numbers are frame pixels; at another width the audit converts them with `details.viewport`.

**Moving content.** Anything that moves, blinks or scrolls by itself for more than five seconds beside other content (a carousel, a ticker, a looping animation) has a visible way to pause, stop or hide it.

**Colour is never the only cue.** An error, a required field, a selected item, a link in running text: each is marked by text, an icon, a weight or an underline too.

## What is exempt

- **Inactive components.** The text and edges of a disabled control have no contrast minimum. The audit skips variants whose state is Disabled or inactive; the label must still be legible.
- **Logotypes.** Text that is part of a logo or a brand name has no contrast minimum. The audit reports it as info, to answer with "logotype".
- **Decoration.** A shape that carries no information, and text that is part of a photograph with other content.
- **Text in a sentence.** A link inside a paragraph is constrained by the line height, so it is exempt from the target size.

## The a11y audit

figma_check_layout { nodeId, audit: ["a11y"], briefId } finds the interactive nodes (layers with a click or press reaction; instances and components named button, link, tab, toggle, switch, checkbox, radio, chip, input, field, select, dropdown, menu item, slider, stepper, search, icon button; and the names in `details.controls`) and measures each in the platform's units, from `details.platform` and `details.viewport`.

| Kind | Severity | Fix |
|---|---|---|
| `target_size` | warning under the minimum; info under the recommended size | grow the hit area: more padding on the instance's frame (figma_set_auto_layout { nodeId, padding }) or a minimum size (figma_resize_nodes { nodeIds, minWidth, minHeight }); the icon itself can stay small |
| `target_spacing` | warning on the web, info on Android | more gap between the targets (figma_set_auto_layout { nodeId, gap }), or larger targets |
| `focus_state_missing` | warning on the web and desktop, info on iOS and Android | add a Focus variant (section `states`) |
| `focus_indicator_weak` | info | a ring of 2 px or more whose colour has 3:1 against the default's pixels |
| `weak_boundary` | warning | an input's edge under 3:1 against the background: a darker stroke (figma_set_strokes) |
| `error_colour_only` | warning | the Error variant changes only paints: add the message text and an icon |
| `input_unlabelled` | info | a visible label above or before the field; a placeholder is not a label |
| `text_fixed_box` | info | a label in a fixed box clips when text is enlarged or re-spaced: figma_set_text_properties { nodeIds, autoResize: "hug" }, or "wrap" in a column |
| `safe_area_platform` | info | a control inside the insets in `details.insets`: move it inward |

The detector reads names and reactions, so it can miss a control or take a decoration for one. Name a missed control in `details.controls` (figma_set_brief { briefId, details }); keep a wrong info with a reason at sign-off, `answers: [{ kind, nodeId, reason }]`. Line height under 1.5 is not by itself a failure: the text-spacing rule asks that text survive a reader's own larger spacing, which a box that grows allows.

## The keyboard walk

Once the screens and their states exist, walk each screen as someone with only a keyboard, from the first control to the last:

1. List the controls in the order Tab would reach them: the reading order, top to bottom and left to right, which in an auto-layout is the layer order (figma_get_design_context lists it). An order that jumps around the screen is a finding.
2. For each control, find its Focus variant and look at it in a close-up render (figma_export_node { nodeId: <the instance> }): can you see where you are at a glance?
3. Nothing that stays on screen (a sticky header, a cookie bar, a floating button) may cover a focused control entirely.
4. Where focus goes when a dialog or a menu opens, and where it returns when it closes, is written in the screen's notes for the developer: a static frame cannot show it.
5. Nothing is reachable only by hovering or only by dragging: a keyboard and a touch screen have neither.

Write the order and what you found in the reply; the findings go into the accessibility lens.

## The accessibility lens

A lens of the critique (its finding schema and rounds), run after the audits are clean. It judges what the numbers miss: can every person get through the task?

- **Blocker:** an a11y or contrast warning left; a control a keyboard cannot reach; an error shown only by colour.
- **Major:** a focus indicator you cannot find in the close-up; a tab order that jumps; text that would be cut at 200 %; a required control inside the insets.
- **Minor:** a target under the recommended size where the minimum holds; a label that relies on its placeholder elsewhere in the flow.

Score as the critique skill does: a blocker caps the lens at 5, a major at 7. Its code in a round's finding ids is AX.

## In the report

An accessibility summary, after the sign-off: the platform and the level (AA or AAA), the a11y and states audits' results, the keyboard order of each screen, each info kept with its reason, and what the developer must build that a frame cannot show (focus movement, text scaling, pause controls).

Evidence (claim ids, for maintainers): [C-075] [C-221] [C-344] [C-345] [C-346] [C-347] [C-348] [C-349] [C-350] [C-351] [C-352] [C-353] [C-354] [C-355] [C-356] [C-357] [C-358] [C-359] [C-362] [C-363] [C-366] [C-387] [C-391]
