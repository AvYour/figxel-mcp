# The build bible

The bible is the one source the build follows: every decision written down as data, so each scene is built against it and each review has a target. The 2026-10-09 run built 93 animated layers, 182 tracks and 681 keys from one [C-206]. One agent writes it and then builds from it [C-238].

**Where it lives.** Where the client has files: a Markdown bible with a JSON of the keyframes beside it, both written from one source. Otherwise: text frames beside the board on the Storyboard page, `Bible / <title>`, one figma_create_from_spec text block per part. On the canvas, keep what the build and the review must read back: the piece, the conventions, the container tree, the handoffs, the read times and the frames to check. The tracks themselves live in the figma_set_keyframes calls, written scene by scene from the package; copying hundreds of keys into text frames costs more to write and to read than it saves.

## What it holds
1. **The piece.** The concept in one sentence; the spine and its grafts; the restraint rules; the placement fields (frame 0, brand by, end structure, stillness, cut grammar).
2. **Tempo and frame.** fps, BPM and first downbeat, frames per beat, the timeline length (it becomes `timelineDuration`), the frame's name, size and position, and the hits table from the beat sheet.
3. **Conventions**, written once and used by every scene:
   - the easing roles as tokens with their exact strings, each with the line of the brief that chose it (figma_get_guide { topic: "motion", section: "easing" });
   - the type vocabulary (which mechanism each line uses, in and out) and the transition vocabulary, each with its reason;
   - the notation, `<layer> <FIELD>: @t value EASE · @t value EASE`, where the easing on a key shapes the move into it;
   - cut pairs for every jump: the old value at (k − 0.75)/fps and the new one at (k − 0.15)/fps, both LINEAR, never HOLD [C-240];
   - the resting state: every layer built visible and laid out, hidden only by keys, because a still shows the rest state [C-116];
   - masks: a plain FRAME that clips, with no fill and no auto-layout; auto-layout only on rows whose spacing animates, each with a fixed width and height;
   - blur: a LAYER_BLUR set on the layer before any key, and the key on that blur's own index, "effect:<i>:RADIUS"; Figma's blur has no direction [C-184], so where a fast move needs a directional cue, stretch it along its travel (SCALE on that axis) or trail echo copies;
   - pivots: any scale or rotation about a point other than the layer's centre is a probe item, with the result and its counter-translation written here;
   - holds, in frames (figma_review_video's unit), converted to seconds for figma_check_motion;
   - the z-order, the safe zone, the smallest text size in frame pixels, the fonts that load.
4. **The container tree.** One container per scene, full-frame, listed bottom to top, each switched on and off by cut pairs on the container itself. Every switch happens under full cover or onto an identical picture.
5. **Packages.** One per scene: its layers (name, type, parent, position, size, content), its styleframe to clone, build rules, the moves in words with their roles and frames, and each mechanism's check and fallback from the probe.
6. **Handoffs.** Every event that crosses scenes: its frame, what happens, and what must hold on that frame (identical pictures at a match cut, continuous speed and blur at a push).
7. **Read times.** Per block: words, readable from–to, time needed [C-241].
8. **Frames to check.** One line per frame: t, frame, and what must be visible on it. Include frame 0; every hit's beat frame; a frame before, on and after every transition and handoff; one mid-frame of every drift and hold; the last frame. A round reviews at most 6 close-up windows and 21 stills (the critique skill's `sampling` section), so mark the rows each round must see.

## Frames to check, the shape of the table
| # | t (frame) | What must be visible |
|---|---|---|
| 1 | 0.000 (0) | what the brief's frame-0 field asks for; nothing blurred |
| 2 | <beat t> (<k>) | the hit at its peak; the layers of the scene before gone |
| 3 | <last t> (<last k>) | the planned end: the end card settled, or the pose one step before frame 0 for a loop |

Each row says what a still must show, in words a reviewer can check against the picture, with positions where they matter. In review these rows become the `stills` and the `closeups` of figma_review_video; a row the render fails is a finding.

## Budget, per gear
| Gear | Guide reads | Styleframes | Renders | Review rounds |
|---|---|---|---|---|
| edit | the motion index and the section the fix needs | none | the whole timeline once (an export always renders all of it [C-184]), then a close-up of the span | 1 |
| UI micro-motion | the motion index, `easing` | the key poses | a small GIF | 1 |
| sting | the motion index, `beat-sheet` | one key pose | one per pass at most, one per round | 1 |
| piece | each section once, when its stage starts | 3–6 | one animatic per retime, one per pass at most, one per round | 3 |

A round's review is at most four figma_review_video calls on its one render.

## Validate before building
- every key on k/fps, except the cut pairs;
- the first key of every track at t = 0 (figma_check_motion flags `first_key_late` otherwise);
- at most 100 keys per track and 50 tracks per figma_set_keyframes call, the tool's limits;
- every blur track keyed at its own effect's index;
- the same `timelineDuration` in every package's first call;
- every read time met in the table, the brand by its time, the CTA hold.

Then build in passes: figma_get_guide { topic: "motion", section: "passes" }.
