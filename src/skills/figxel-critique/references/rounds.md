# Rounds: merge, fix once, re-check, stop

A round is six steps: sample, run the lenses, merge, apply one batch, check, and look for regressions. The gear sets how many rounds: one for a section or a sting, two for a page, three at most for the top gear and a motion piece.

## 1. Collect

Put every lens's findings in one list, the most severe first. Give each an id, R<round><lens code><n>: R1TC3 is round 1, type and composition, third finding. Next round's report can then say "R1TC3 fixed (now 1016)" or "R1TC3 regressed".

| Code | Lens | Code | Lens |
|---|---|---|---|
| MS | message | MC | motion craft |
| TC | type and composition | DT | design and type |
| CI | colour and imagery | TQ | technical QA |
| CP | copy | BL | the brief's own lens |
| OR | originality | QA | finish QA |

## 2. Merge

Lenses disagree. In every fix round of a measured test run, two lenses asked for opposite changes to the same thing: one wanted a line to leave earlier and another wanted it held longer, and two lenses proposed different values for the same ripple and the same overscan. Each conflict had to be settled before anything was applied. Settle them in writing, before any edit:

- **Duplicates.** One issue found by several lenses becomes one finding that lists the lenses and keeps the highest severity; the run's 73 findings were 63 distinct issues.
- **Conflicts.** Two fixes that touch the same layer and property, or the same frames, and pull different ways. Decide in this order:
  1. the brief and the chosen direction win: a fix that breaks the idea is dropped, as the run dropped a fix that would have taken the brand off screen;
  2. then the higher severity;
  3. then a third value that meets both lenses' measured targets: one frame of compromise, or one merged set of values;
  4. otherwise choose one and say why.
- **Undoing.** A fix that would reverse a fix from the last round is a conflict too: re-open both findings instead of swinging back and forth.

Write one line per conflict, for example:

`R1MC6 / R1DT10 — exit earlier vs hold longer → hold one frame longer; the read time and the clearance both pass.`

## 3. One batch

Apply the merged fixes together, as targeted edits: figma_batch for many small edits in one undo step, or the specific tools (figma_set_auto_layout, figma_resize_nodes, figma_set_text_properties, figma_set_fills, figma_set_keyframes; figma_move_nodes only for absolute layers, since an auto-layout owns its children's x and y). Read every result. A batch step that ran can still list a node it could not change in `itemsFailed`; ok means the change was read back where it was asked to be. Never rebuild a section that is mostly right.

## 4. Check

Run the checks on the whole piece, not only on the changed parts: figma_check_layout { nodeId, audit: ["craft", "tells"] }, and for motion figma_check_motion { nodeId, fps }. Then take the next round's sample (section `sampling`).

## 5. Regressions

Fixes break their neighbours. In the run, round 2 found 4 issues that round 1's fixes had caused, and round 3 found 3 more. For every change:

- Re-measure the finding's own number, and write "fixed" with the new value.
- Check its neighbours: siblings; anything within one spacing step of its new bounds; anything that shares its column edge, its colour role or its style. For motion, every frame within about six frames of a changed key, and every frame of the holds and drifts that layer is part of.
- Compare this round's checks and findings with the last round's. Anything new in a touched area is a regression.

A regression is fixed in the same round, or the change that caused it is reverted.

## 6. Score and stop

Score every lens again, and keep the table in the reply: one row per lens, one column per round.

Stop when the sign-off bar holds (the critique index), or when the gear's last round is done. After the last round, keep the best state: when the last round's changes regressed and the regression could not be fixed, revert them. Then report what is left: every remaining finding with its severity, and why it stays.

Evidence (claim ids, for maintainers): [C-239] [C-253] [C-206] [C-250]
