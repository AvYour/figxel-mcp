---
name: figxel-motion
description: Animate on a Figma frame's timeline like a motion designer. Pick the gear, block poses on the beat, shape curves so no frame pops, polish, then review at the delivery frame rate. Easing roles, transitions, kinetic type, formats and Figma Motion's mechanics. Not prototype transitions.
---

# Motion — keyframes on a timeline, made like a motion designer

Motion here is keyframe animation of the layers inside a top-level frame: Figma Motion, a beta that Figma turns on per user [C-115]. Interactions between screens are the `prototype` skill. When a motion tool answers UNSUPPORTED, stop, tell the user, and deliver the static design.

One pass straight to keyframes looks generated. The 2026-10-09 run, after a brief, three directions and a build bible, went from critic scores of 6.5–7 to 7.5–8 over three measured rounds, every lens still at "fix" [C-206]. Scale that process to the job; never drop it.

## Pick the gear, and say it first
| Gear | What it is | Process |
|---|---|---|
| edit | retime or fix existing motion | match its curves and grid; figma_check_motion; render the whole timeline, then a close-up of the span |
| UI micro-motion | one component changing state, under about 1 s | a one-line brief; the product's tokens or its existing motion (section `mechanics`); keys, figma_check_motion, a small GIF; name the reduced-motion version [C-223] |
| sting | one beat under about 2 s: a logo sting, a loop, an animated icon | a three-line brief; two directions in words; one key-pose styleframe; the passes; one round: motion craft, design and type, technical QA |
| piece | an ad, reel, title, product film or animated end card: over about 2 s, or more than one beat | every stage below |

Gears scale the process as in the design skill [C-239]; a brand, system or reference the user gave is already decided.

## A piece, stage by stage
1–8. Plan with the `storyboard` skill, from the brief to a build bible with its frames to check.
9. Blocking: every scene built first, then poses keyed on the beats. Exit: figma_check_motion clean of `off_grid`, `unrendered_extreme`, `hold_easing` and `first_key_late`.
10. Curves: an easing role on every move. Exit: no figma_check_motion warnings.
11. Polish: settles, blur ramps, drifts, accents, the planned end. Exit: figma_check_motion ok (or each warning declared in the bible), every info answered.
12. Review with the `critique` skill. Exit: the sign-off bar, three rounds at most [C-239].
13. Delivery (section `formats`).

**Checkpoint.** By default you own the brief and run to the end [C-085]. With `checkpoint: "storyboard"`, or a brief that asks to see the plan first, stop once the storyboard, styleframes and technical probe exist (each unprobed mechanism with its fallback named), show them (figma_select, figma_zoom_to), and wait. A sting shows its brief, two directions and key pose; UI micro-motion its brief and poses. Report any retime made after approval.

## Hard rules, each a measured failure [C-206]
1. Frame 0 does the job the brief gives it; the last frame is settled and clean, or for a loop one step before frame 0 (section `formats`).
2. Every key sits on the frame grid: frame k shows t = k/fps [C-193]. A jump is a cut pair, never HOLD [C-240].
3. No unblurred, uncovered frame carries 40 % or more of a move [C-246] or steps past about 150 px [C-243]. Check the keys with figma_check_motion before any render.
4. Offsets inside a stagger group are 2 frames or more [C-242]; a hit peaks on its beat frame.
5. Stillness is declared: a hold the bible lists goes in `holds`; anything else still for 0.5 s or more keeps a drift.
6. Layout over time is computed from the keys and the rest bounds, not read off stills (section `passes`).
7. Every line meets its read time [C-241].
8. Review at the delivery fps; re-check the neighbours of every fix: the run's fixes caused 7 new issues [C-206].

## No house style
No palette, typeface, transition, curve or signature move is preferred: decide each from the brief and the brand's givens, then hold it against card 0 and the defaults in the storyboard skill's originality check. A default you keep is stated in the report. One agent runs all of it as passes [C-238].

## Sections
- section `easing` (references/easing.md, or figma_get_guide { topic: "motion", section: "easing" }) — the pop line, curve families, the share table.
- section `principles` (references/principles.md, or figma_get_guide { topic: "motion", section: "principles" }) — principles as fields; tells of generated motion.
- section `transitions` (references/transitions.md, or figma_get_guide { topic: "motion", section: "transitions" }) — continuity, recipes, checks.
- section `kinetic-type` (references/kinetic-type.md, or figma_get_guide { topic: "motion", section: "kinetic-type" }) — type moved by meaning.
- section `formats` (references/formats.md, or figma_get_guide { topic: "motion", section: "formats" }) — brief fields, safe zones, tempo, loops, delivery.
- section `passes` (references/passes.md, or figma_get_guide { topic: "motion", section: "passes" }) — blocking, curves, polish.
- section `mechanics` (references/mechanics.md, or figma_get_guide { topic: "motion", section: "mechanics" }) — fields, values, timeline, rendering, traps.
