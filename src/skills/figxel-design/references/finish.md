# Finish: renders, finish defects, the details pass and the report

## Renders, one view at a time

A render judges what a viewer sees at once, so render one view at a time, never a whole long page. A view is what fits the viewer's screen or eye: for a page, each section (the hero first); for a poster, a story, a slide or a styleframe, the whole frame.

- **The read:** figma_export_node { nodeId: <the view> } at the default cap of 1024 px on the long side, which one view fits; for a detail still too small, a close-up of that element, never the whole at a larger size.
- **The squint:** figma_export_node { nodeId: <the view>, maxSize: <its long side ÷ 8> } — about 180 for a 1440-wide section, 240 for a 1080 × 1920 story. The squint test proper blurs the view until only groups and the strongest element remain; this small render is the approximation used here, for what leads and whether the groups hold, never for detail.
- **A round's sample:** the read and the squint of the first view and of every view the brief's success lines name, plus close-ups of each place a check flagged (figma_export_node { nodeId: <the element> }). One sample per round, shared by every lens.

## Finish defects that read as unfinished

Every one of these was found in a measured test run; the `craft` kinds are grounded in those findings. Six of them report `info`, so figma_check_layout can answer ok: true while they remain: near_size, no_shared_edge, tangent, unbalanced_space, edge_slices_text and weak_graphic_contrast. Answer each one.

| Defect | Measured by | Fix |
|---|---|---|
| The build differs from its own rules | compare the system's numbers with figma_get_design_context | Treat the system as the test |
| Near-misses: blocks in a column sharing no edge | `no_shared_edge` | Align exactly, or offset by a full step |
| Tangencies: shapes or text almost touching | `tangent` | Overlap decisively, or clear by a spacing step |
| An edge or stroke slicing live text | `edge_slices_text`, `stroke_crosses_text` | Clear the type, or cross it on purpose |
| Two sizes almost equal | `near_size` | Equal, or clearly different |
| Old-style figures in prices and numbers | `oldstyle_figures` | Lining figures, or another face for the numerals |
| Single letters spaced apart | `glyph_gaps` | One text, tracked |
| A block sitting off its field | `unbalanced_space` | Centre it, then lift it a little on purpose |
| Text too small for the device | `min_text` with the brief's `minTextSize` | Raise it to the floor, or merge it into the next level up |
| Content outside the safe zone | `safe_area` with `safeArea` | Move it in; zones come from the brief, and a web view has none (its fold is a success line) |
| Text on a shape below the contrast minimum | `low_contrast_over_shape` | Change the text or the shape |
| Faint hairlines that carry meaning | `weak_graphic_contrast` | Thicker or stronger, 3:1 |
| A mark that reads as something else (the run's arc read as a smile) | eye: read every mark cold | Redraw it |
| One phrase written two ways; mixed dashes or quote marks | figma_scan_text_nodes { nodeId: <wrapper> }: compare every string | One wording, one dash, one kind of quote mark |

## The details pass

It comes after the last critique round's fixes, before the final check: the part a viewer never names and always notices.

- **Align ink, not boxes.** A text box or an icon frame is not its visible edge. Where a round or pointed shape looks set in from a straight edge in the read, nudge it until what you see lines up; a close-up of the group shows it.
- **Rag.** Break display lines where the sense breaks, never mid-phrase, and leave no single word alone on a heading's last line. For a heading, try Figma's balanced wrap, figma_set_text_properties { nodeIds, wrapStyle: "balance" }, and judge the result in the read; otherwise set the text's width (figma_resize_nodes) or a break in the copy (figma_set_text).
- **Figures and punctuation.** One style of numerals, one dash, one kind of quote mark, across the piece: scan every string with figma_scan_text_nodes, and check the numerals in the read at display size.
- **No tangencies, no near-misses.** Things overlap decisively or stand clear by a step of the spacing scale; blocks in one column share an edge exactly.
- **Read every mark cold.** Look at each shape, logo and crop as a stranger would: what else could it be? In the run, an arc under a wordmark read as a smile.
- **Layers.** Name every layer for what it is and remove leftovers: figma_check_layout reports `default_name`, `empty_frame` and `empty_text`.

## The final check

1. figma_check_layout { nodeId: <wrapper>, audit: ["craft", "tells"], minTextSize } → ok: true, and every craft and tells info answered: fixed, or kept with its reason in the report. Add the role's own audits: a11y, states and copy for ux; system for graphic, illustration, brand and a deck; icons for illustration, mark for brand, deck for a deck (each role's skill lists them).
2. Real content, on every screen, page view and component whose content will change (a poster, an ad or a mark with final copy skips it): figma_stress_test { nodeId: <the screen or view> }. It copies the view once per case, checks each copy against the original and reports, by layer path, what each case broke: `expand` grows every text as translation grows it, short strings most (to 300 % of its length up to 10 characters, 130 % past 70); `long` doubles each text's words and turns a single word into a 24-character compound; `numbers` makes every figure large of the same form ($9.99 becomes $12,345.99); `many` triples each auto-layout list of three or more instances of one component; `empty` drops those lists to none. Fix the layout, never the real copy: a text fills its column and wraps, a frame hugs instead of clipping, a figure hugs while the text beside it fills, an empty list gets its empty state. Then run step 1 again. It deletes its copies unless `keep: true`; a break kept on purpose goes in the report with its reason.
3. The read and the squint of the first view, and of each view the success lines name: the focal point still reads first.
4. figma_sign_off { nodeIds, lenses, rounds, answers, placeholders } on the deliverables: the screens, frames or component sets the brief covers, never the brief block or the explorations. It runs the role's audits again, checks the brief is complete for its gear (Direction 0, the directions, the choice, the styleframes, the system), takes the last round's scores (`lenses` [{ lens, score, verdict, remaining }], a lens under 8 accepted only at the round budget, with its `remaining`), a reason for every info kept (`answers` [{ kind, nodeId, reason }]) and every invented fact (`placeholders`, or ["none"]), then records the result on each deliverable and on the brief block.
5. `ok: false` lists each blocker with the call that clears it: make those calls and sign off again. On a pass it selects and zooms to the work, so the user opens onto it. An edit with no brief needs no sign-off: figma_select and figma_zoom_to instead.

## The report

Tell the user, in this order, quoting the sign-off:

- **Assumptions** — anything you decided for the user (the audience, the message, whose styles the file holds, unverified safe zones), first.
- **The sign-off** — ok, when, the checks it ran, and each lens accepted below 8 with what remains, as figma_sign_off answered. Say plainly that work is unsigned if it did not pass.
- **The brief as built** — the seven lines, updated with every decision made on the way.
- **The direction and why** — the decision line: chosen, why, what was grafted, what was rejected, and how it differs from Direction 0.
- **The scores** — each lens per round, and the findings left after the last round.
- **Tells, infos and stress-test breaks kept on purpose** — each with its reason and evidence ("brand given: paint style Brand/Green", "a real sequence"), and any text the stress test skipped for a missing font.
- **Placeholders to replace** — every invented fact: prices, names, numbers, photos, quotes.
- **What changed** — from figma_get_changes { since: <the checkpoint id> }: what you created and edited, and any edit someone else made to your work meanwhile.
- **Where things are** — the target page, and the Explorations page or section with its direction cards, styleframes and brief block (its status line now reads signed off).

Keep it short: the design is the answer, and the report says what it decided and what the user still owns.

Evidence (claim ids, for maintainers): [C-092] [C-212] [C-207] [C-248] [C-075] [C-221] [C-386] [C-385] [C-396]
