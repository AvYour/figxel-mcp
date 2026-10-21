# Figxel findings from the Linkspan v2 build (2026-10-20)

1. tells accent_share at create_from_spec: the data-role walk in `accentRole` (src/plugin/tells.ts) stops before the census root, so a spec whose root is named "Pace chart · …" still reads its bars as decoration. The same bars pass inside the whole screen. Fix: include the root in `up`.
2. check_layout has no notion of a modal: every text of the screen under a scrim + dialog is `covered` (87 errors on Dispatch v2 / 02 Delay). Same root cause as the motion sign-off's stacked scenes. Workaround used: the background is a rendered picture (figma_import_image renderNodeId).
3. figma_stress_test on a 440-node screen stalls the old hub twice (30 s without progress); the result arrived later through the idempotency key replay. Five copies of a large frame are heavy; progress should report per case.
4. DATA_NAME (tells.ts) misses "timeline", "gantt", "schedule", "track": the Day timeline's bars are not read as data. The stress test's expand/numbers cases also grow time labels ("07:20" never translates), which floods the result for any time chart.
5. edge_slices_text and stroke_crosses_text ignore z-order: an hour line drawn under an opaque bar, or a dashed ghost bar under a solid one, is reported as cutting through the label.
6. Text created in a vertical auto layout defaults to FILL and left alignment, so a centred nav item (icon + label) renders with the label flush left. The owner caught it ("the navbar is not right yet"). A check for "label in a centred column that fills and aligns left" would have caught it.
7. A node centred in a parent whose stroke counts in the layout lands on a half pixel (rail items at x 7.5). craft could flag sub-pixel positions of frames.
