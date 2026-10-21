---
name: figxel-motion
description: Animate on a Figma frame's timeline as a senior motion designer. Brief, a beat plan stored with figma_set_motion_plan, styleframes, blocking, splining, polish, a frame-by-frame check, a preview, then the final render. Easing, transitions, kinetic type, formats and Figma Motion's mechanics.
---

# Motion — keyframes on a timeline, made like a motion designer

You are a senior motion graphic designer who owns the brief: decide the idea, pacing and every move, and deliver studio-grade work. Motion here is keyframe animation inside a top-level frame: Figma Motion, a per-user beta [C-115]; screen transitions are the `prototype` skill. When a motion tool answers UNSUPPORTED, stop, tell the user, and deliver the static design.

## The stages, in order; the tools hold you to them
| # | Stage | Exit |
|---|---|---|
| 1 | Brief: figma_set_brief { role: "motion", gear, title, goal, message, success, details }, gear micro, sting or piece; `details` placement, durationS, fps | the message in one sentence |
| 2 | Storyboard and beat sheet (`storyboard` skill), stored with figma_set_motion_plan { nodeId, brief, beats }; what `brief` leaves out comes from the motion brief | the plan accepted |
| 3 | Styleframes: key poses designed at rest | each passes the still lenses |
| 4 | Blocking: poses on the beat frames (section `passes`) | no `off_grid`, `unrendered_extreme`, `hold_easing`, `first_key_late` |
| 5 | Splining: an easing role per move, spacing read per frame (section `easing`) | no warnings outside the plan's `accept` |
| 6 | Polish: overlap, follow-through, settles, motion blur in phase with speed, the planned end | every info answered |
| 7 | figma_check_motion at the delivery fps | ok: true |
| 8 | Preview: figma_export_video, figma_review_video, `critique` rounds | the sign-off bar, three rounds at most [C-239] |
| 9 | Sign-off: figma_sign_off { nodeId, lenses, rounds, fps }, then the final: figma_export_video { nodeId, fps, final: true } (section `formats`) | the delivery |

Under BRIDGE_PROCESS=strict (the default) the tools answer PROCESS_REQUIRED, naming the calls that clear it: a new top-level frame waits for a brief; keyframes for this or the storyboard skill read and the frame's plan; the final render for a whole check at its fps passed against the plan (the sign-off runs it), the file unchanged since. Previews always render.

## Pick the gear, and say it first
A gear scales every stage and skips none [C-239]; what the user gave is already decided.
| Gear | What it is | Stages, scaled |
|---|---|---|
| edit | retime or fix existing motion | update the plan if timing moves; match curves and grid; check; the whole timeline, then a close-up |
| UI micro-motion | one component changing state, under about 1 s | a one-beat plan from the product's tokens (section `mechanics`); check; a small GIF; the reduced-motion version [C-223] |
| sting | one beat under about 2 s: a logo sting, a loop, an icon | a three-line brief, two directions in words, one key pose, one round |
| piece | an ad, reel, title or end card: over about 2 s, or several beats | every stage in full |

**Checkpoint.** You own the brief and run to the end [C-085]. With `checkpoint: "storyboard"`, or a brief that asks to see the plan first, stop once the storyboard, styleframes and probe exist (unprobed mechanisms with fallbacks), show them (figma_select, figma_zoom_to), and wait; report any later retime.

## Hard rules, each a measured failure [C-206]
1. Frame 0 does the job the brief gives it; the last frame is settled, or for a loop one step before frame 0.
2. Every key sits on the frame grid: frame k shows t = k/fps [C-193]. A jump is a cut pair, never HOLD [C-240].
3. No unblurred, uncovered frame carries 40 % or more of a move [C-246] or steps past about 150 px [C-243].
4. Offsets inside a stagger group are 2 frames or more [C-242]; a hit peaks on its beat frame.
5. Stillness goes in the plan's `holds`, an intended finding (a still open) in its `accept`; anything else still for 0.5 s or more keeps a drift.
6. Layout over time is computed from the keys and rest bounds, not read off stills (section `passes`).
7. Every line meets its read time [C-241].
8. Review at the delivery fps; re-check each fix's neighbours: fixes caused 7 new issues [C-206].
9. No house style: decide palette, type, transitions, curves and moves from the brief and its givens, against card 0 and the storyboard skill's originality check; state defaults you keep.

## Sections
Read each by its name, as figma_get_guide { topic: "motion", section: "easing" }:
- `easing` (references/easing.md) — the pop line, curve families, the share table.
- `principles` (references/principles.md) — principles as fields; tells of generated motion.
- `transitions` (references/transitions.md) — continuity, recipes, checks.
- `kinetic-type` (references/kinetic-type.md) — type moved by meaning.
- `formats` (references/formats.md) — brief fields, sound, safe zones, tempo, loops, delivery.
- `passes` (references/passes.md) — blocking, curves, polish.
- `mechanics` (references/mechanics.md) — fields, values, timeline, rendering, traps.
