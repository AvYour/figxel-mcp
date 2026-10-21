---
name: figxel-storyboard
description: Plan a motion piece (ad, reel, title, animated end card) in Figma before animating it. Brief and directions, a beat sheet on a tempo grid, storyboard panels, styleframes, an animatic that tests timing at speed, and a build bible. Not for turning screen recordings into annotated storyboards.
---

# Storyboard — plan a motion piece before the first keyframe

A storyboard plans a piece panel by panel before production [C-227]; an animatic plays the panels at their planned times to test the pace [C-228]; styleframes settle the look on real frames first [C-229]. The 2026-10-09 run skipped styleframes and the animatic, and 14 of its 73 review findings were visible on a still at rest [C-206].

**When.** Any motion piece longer than about 2 s, or with more than one beat. UI micro-motion and a one-beat sting go straight to the `motion` skill.

**Where.** A "Storyboard" page holds the brief, the cards, the board, the styleframes, the animatic and the bible (figma_create_page { name: "Storyboard" }, once). If figma_create_page is refused (a Starter file holds 3 pages [C-048]), put the plan in a section "Storyboard" beside the piece (figma_create_section) and say so in the report. The piece goes on the user's page, at an empty spot.

**Checkpoint.** You own the brief and run to the end [C-085]. With `checkpoint: "storyboard"`, or a brief that asks to see the plan first, stop after stage 6: show the board, the styleframes and the probe's results, naming each unprobed mechanism's fallback (figma_select, figma_zoom_to), and wait for approval before building. List any later retime in the report.

**When a tool is refused.** figma_create_animatic is not yet verified in Design files and may be refused. Then, without stopping, build the animatic by hand or not at all (section `animatic`), and a refused board with figma_create_from_spec (section `boards`); say which in the report.

## The stages and their exit gates
1. **Brief and inventory** (section `beat-sheet`): figma_set_brief { role: "motion", gear: "piece", title, goal, message, success, details } on the Storyboard page, with the design brief's lines and `details` placement, durationS, fps. Exit: the message in one sentence; each mandatory has a reason; the placement fields written; safe zones with their source, or marked unverified.
2. **Directions and judging** (section `beat-sheet`): card 0, then 2–3 cards from different origins, the originality check, four judging passes. Exit: spine, grafts and restraint rules written.
3. **Beat sheet on a tempo grid** (section `beat-sheet`). Exit: read times met; brand by its time; the CTA hold; the end structure the brief names [C-241] [C-244].
4. **Storyboard** (section `boards`): figma_create_storyboard { title, aspect, fps, bpm, panels }, rough thumbnails. Exit: `offBeat` and `readTime` empty or justified; figma_check_layout ok on the board.
5. **Styleframes** (section `animatic`): 3–6 real frames of the chosen direction at delivery size, critiqued at rest, snapshotted into their panels. Exit: each passes the still lenses.
6. **Technical probe** (section `animatic`): a sandbox for every mechanism not yet measured. Exit: each works or has a named fallback.
7. **Animatic** (section `animatic`): figma_create_animatic { storyboardId }, a small render, figma_review_video. Exit: pacing, read times, brand time, CTA hold and the planned end work at speed.
8. **Build bible** (section `bible`). Exit: every scene has a keyframe package; every transition and hit has a frame to check.
9. **The plan on the frame**: the piece's frame at delivery size, then figma_set_motion_plan { nodeId, brief, beats, holds, brandId, ctaId, accept }, the beat sheet as beats back to back, each with its copy, action and transition; what `brief` leaves out (audience, message, format, duration, fps) comes from the motion brief. Exit: the plan accepted; the keyframe tools refuse a frame without one.

Then build with the `motion` skill (section `passes`), review with the `critique` skill, and figma_sign_off { nodeId, lenses, rounds, fps } before the final render.

## Hard rules
1. Frame 0 does the job the brief's frame-0 field gives it.
2. Every line meets its read time [C-241].
3. Every designed transition grows out of something already on screen; a hard cut on a beat needs no motive.
4. Retime at the animatic, never later.
5. The bible lists the frames to check, and every review round uses them.
6. No palette, typeface, transition or move is a default: each is decided from the brief and held against card 0 [C-208].

## Sections
- section `beat-sheet` (references/beat-sheet.md, or figma_get_guide { topic: "storyboard", section: "beat-sheet" }) — the motion brief, card 0, directions, judging, tempo, the beat sheet.
- section `boards` (references/boards.md, or figma_get_guide { topic: "storyboard", section: "boards" }) — panels, thumbnails, motivated transitions, a board by hand.
- section `animatic` (references/animatic.md, or figma_get_guide { topic: "storyboard", section: "animatic" }) — styleframes, the technical probe, the animatic and retiming.
- section `bible` (references/bible.md, or figma_get_guide { topic: "storyboard", section: "bible" }) — the build bible, frames to check, the budget per gear.
