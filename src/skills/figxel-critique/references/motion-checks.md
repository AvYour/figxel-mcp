# Motion checks — the checklist the run's critics wrote

Every item below comes from a finding of the 2026-10-09 run or from a standard; thresholds marked "run" were set on that run at 30 fps on a 1080 × 1920 frame. Work in order: A needs only the keys, B to G need one render and the bible's frames-to-check. Where the brief or the bible declares a choice (a still open, a hard-cut grammar, a loop), the plan's `accept` records it with its reason, figma_check_motion lists it apart, and the check holds the piece to that declaration instead.

| Lens | Groups |
|---|---|
| motion craft (MC) | A, C, F |
| design and type (DT) | D, E |
| technical QA (TQ) | B, G |
| the brief's own lens (BL) | the message read at speed, the brand time and the CTA hold, as numbers (`read_time`, `brand_late`, `cta_short`) |
| originality (OR) | round 1 only, the last section below |

**Set-up for a round.** figma_check_motion { nodeId, fps } first: it applies the plan's `bpm`, `holds`, `brandId`, `ctaId` and `accept`. Then one render at the delivery fps in job mode, figma_export_video { nodeId, fps, saveTo, jobId: "<piece>-r<n>" }, and figma_review_video on the file in batches you can see: the metrics, the sheet and up to 6 close-ups in one call, then stills 7 at a time, each call with `maxImages: 8` (section `sampling`). Close-ups and stills come from the frames-to-check table, a close-up starting a few frames before every cut and handoff. Write each finding in the critique schema, "where" as the layer's name and id plus "t s (fN–fM)". Without ffmpeg on the server machine, run A and the styleframe stills, and say in the report that the motion itself was not seen.

## A. From the keys (figma_check_motion rule in brackets)
1. **One-frame pops.** No unblurred, uncovered frame carries 40 % or more of a move (the tool's calibrated line; section `easing` of the motion skill), and no unblurred step passes about 150 px (`concentrated_step`, `pop_in`, `strobe`).
2. **Visible exits.** An exit that ends in view is at a tenth of its size or less on its last visible frame (`vanish_mid_move`).
3. **Guards.** An OPACITY guard switches on only once the shape is big enough to read, and off only when it is near nothing; no round cap shows as a dot at zero length (`roundcap_zero_trim`).
4. **Grid.** Every key on k/fps, cuts as cut pairs, no HOLD (`unrendered_extreme`, `off_grid`, `hold_easing`).
5. **Offsets.** 2 frames or more inside a stagger group, each on the grid (`no_stagger`, `off_grid`).
6. **Hits.** Each accent peaks on its beat frame, so its attack starts before the beat (`beat_offset` with `bpm`).
7. **Punch shape.** The attack is shorter than the release, and the peak holds for more than one frame (`one_frame_extreme`).
8. **Overshoots.** Hand-keyed, no more than the bible's restraint rules allow, with no long tail into the apex.
9. **Blur phase.** The blur peaks on the move's fastest frames at about 5–8 % of the step there, and is gone before the element must read sharp (`blur_off_speed`).
10. **Morphs.** WIDTH and HEIGHT share a curve while the shape must stay round (`clamped_morph`).
11. **Simultaneity.** No drift stops on the frame another move starts; no echo or ripple is born underneath the thing that triggers it.
12. **Arrivals and ends.** An arrival holds for 3 frames or more (`arrival_not_held`); every track keys t = 0 (`first_key_late`); no key falls after the timeline's end (`timeline_end`).

## B. Every frame (figma_review_video metrics and stills)
1. **Frame 0** does the job the brief's frame-0 field gives it, sharp: the hook or the brand for a feed or story ad (`cold_open` from the keys; `stills: [0]`). A brief that opens from black or on a still says so, and `cold_open` is left out of `rules`.
2. **No freeze** of 0.5 s or more outside a declared hold (`freezes`).
3. **No flicker frame:** one frame unlike both neighbours while they match each other (`flickers`).
4. **No residue** on plain grounds after an exit: specks, slivers on a mask edge (stills and close-ups).
5. **Fast edges carry blur** matched to their step (close-ups).
6. **Photosensitivity.** Nothing flashes more than three times in any one second. The tool's `flash` is a craft metric (a whole-frame jump of 40/255 on a frame not declared a cut), not the WCAG test, and it skips declared cuts. So run one extra figma_review_video { path, metrics: true, maxImages: 0 } with no `cuts` and no `holds`, and count the `flashes` that fall inside any window of fps frames. More than three is a blocker; a count near three goes in the report as unverified, since WCAG counts pairs of opposing luminance changes of 10 % or more.

## C. Cuts and handoffs (close-ups around every one; `cuts` declared)
The continuity checks (1–3) apply to cuts meant to read as one continuous move: a match cut, a push-through, a whip. A hard cut, a smash cut or a cut on the beat is a change on purpose and is held to the bible's cut grammar (4).
1. **Match cut.** The shared shape is on screen for 3 frames or more, and the two sides are identical on the swap frame; a shape seen for one frame was the run's only blocker.
2. **Speed.** Take the per-frame zoom factor (for a pan, the step in px) of the last step before the cut and of the first step after it; the larger divided by the smaller stays under 1.10. ×1.32 against ×1.27 read as one move; ×1.27 against ×1.08 read as a brake.
3. **Tone.** No frame's mean brightness steps by more than 20 of 255 across the cut frames; the run's 59/255 jump read as a white flash, and a tonal bridge brought it to 9.2. `spikes` in the metrics flag a jump.
4. **Cut grammar.** Each hard cut does what the bible's cut grammar says (lands on a beat, carries the planned accent, or is a plain cut on purpose); a bare swap into a dead hold that the bible did not plan reads as a slideshow.
5. **Wipes** cross the last corner at speed and land where the landing is seen.
6. **Timing.** Each declared cut lands on its frame; figma_review_video reports one that lands early or late.

## D. Type and reading
1. Read time max(5/6 s, 0.3 s × words) from fully legible to covered; the CTA 2.5 s or more (`read_time`, `cta_short`).
2. Dimmed text that must be read keeps its contrast, computed at its dimmed opacity over its ground.
3. Figures read correctly in the chosen face; two sizes in one style are equal or clearly different.
4. The type vocabulary the bible declares (which mechanism each line uses, in and out) is used consistently.
5. Type and the shapes that cross it differ in colour on every frame of the crossing.

## E. Layout over time
figma_check_layout sees only the rest state, so these are computed from the keys, and stills confirm them: for each move, its extreme offset from the keys (figma_check_motion { includeActivity: true } lists the fastest frames) added to the layer's rest bounds from figma_get_nodes_info.
1. **Collisions and tangencies** on every frame of holds, drifts, anticipations and pushes: the run's critics flagged gaps of 2–15 px between type and edges.
2. **Clip lines** sit on real edges in the picture.
3. **Drifts** keep the margins: the drift's extreme offset stays inside them; a lockup drifts as one unit.
4. **Overscan:** a full-bleed plate that scales below 1 is wider by at least (1 − s) × width / 2 on each side.
5. **Safe zones** from the brief hold on every frame where text, logo or CTA moves.
6. **Accents read:** thick enough for the viewing size, with 3:1 or more against their ground, and visible from their first frame.

## F. Rhythm
1. Hits on downbeats, secondary hits on beats or on whole-frame subdivisions, at a stated BPM or on the music's own beats (figma_check_motion { beatTimes } from figma_analyze_audio), or on the timed voice-over.
2. The end structure the brief names: an end card (with a breath before it, if planned), a loop seam, a held last pose.
3. Each scene's activity (the frame-difference curve) stays above any planned breath, so the breath reads as a contrast; a scene stiller than the breath reads as dead.
4. The device count per stretch stays within the bible's restraint rules.

## G. Finish and delivery
1. The last frame is settled and clean; for a loop, it is one step before frame 0's pose (the motion skill's `formats` section).
2. `frameCount` equals `expectedFrames`: the render includes the end frame, ceil(d · fps) + 1 in every format.
3. Stills are cut by frame index (`stills`, `frameIndices`), never by a rounded time.
4. The master meets the placement's spec. With sound: it was joined after the last picture fix (figma_add_audio), its warnings are answered, its true peak is at or under −1 dBTP, effects sit on their cuts and accents, and the piece still reads with the sound off. The audio is the user's licensed track or a generated one, named in the report.
5. After every round of fixes, re-check each changed span and its neighbours: the run's fixes caused 4 new issues in round 2 and 3 in round 3.

## Originality: at the directions, on the styleframes, and in round 1
Before anything moves, hold the chosen direction against card 0 (the storyboard's obvious version), the generated looks and the motion habits of generated work. In review round 1, do it again on the render: answer every `template_move` and `easing_census` info from figma_check_motion (fixed, or kept with a reason in the report), and compare the piece's transitions and accents with card 0 and the bible's vocabulary. A match is either a brand given, with its evidence, or a finding.

Evidence (claim ids, for maintainers): [C-206] [C-246] [C-243] [C-240] [C-242] [C-196] [C-222] [C-259] [C-261] [C-258] [C-230] [C-241] [C-075] [C-207] [C-221] [C-244] [C-194] [C-208] [C-219] [C-209] [C-260] [C-184] [C-332]
