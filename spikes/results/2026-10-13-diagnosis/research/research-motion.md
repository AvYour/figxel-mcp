# Motion skill research: how professional motion designers work, mapped onto Figma Motion

Workstream: motion-process. Date: 2026-10-13. Status: research and a draft for the main agent. No repository file was edited.

**Claim IDs.** This file uses local IDs `MC-01` to `MC-39` (section 7). The sibling drafts already use C-168 to C-197 (`delivery.md` uses C-168 to C-189; `research-design.md` uses C-168 to C-197), so registry numbers must be assigned when the drafts are merged. Statuses follow the registry: `verified`, `measured`, `to-verify`, `contradiction`, `decision`. Only the main agent writes the registry.

**Inputs read:** `scratchpad/motion/` (`inventory.md` §4, `final-spec.md` §0 to §3 and E, Appendices A and B, `tool-findings.md`, `r0/motion-eval.cjs`); the 2026-10-09 journal `wf_c23489f2-d18/journal.jsonl` (61 lines: 3 directors, 3 judges, the synthesis, the rig and 5 scene builders, the render, 9 critic results in 3 rounds, 3 fixers, the finish); `src/server/guides.ts` (the `MOTION` topic), `src/server/tools/motion.ts`; `@figma/plugin-typings` 1.141.0; the official `figma-use-motion` skill (2.2.120), read for its structure only; the sibling drafts `delivery.md`, `research-design.md` and `live-probe-2026-10-13.md`; and the external sources in section 7.

---

## 0. Findings in brief

1. **Professional motion work moves through stages, and each stage is cheaper to change than the one after it.** The stages are: brief, directions, beat sheet, storyboard, styleframes, animatic, blocking, refining, polish, review and delivery [MC-07] [MC-08] [MC-09] [MC-10]. The 2026-10-09 run did the directions, the judges, a build bible and three review rounds. It **skipped styleframes, the animatic and sound**. 14 of its 73 critic findings were static faults that a still image would have shown: 7 type or composition faults and 7 collisions visible at rest. A styleframe review could have caught these before any keyframe was written. Two of them (R1D1, R1D7) were builder placement errors, which a styleframe only prevents when the animation is built on the reviewed frames.
2. **The biggest class of motion defect is mechanical, and it can be predicted from the keys alone.** 15 of the 73 findings came from an easing that put most of a move into one frame: an ease-in ending on a cut, a whip curve on a short span, or a 3-frame ease-out. Figma samples frame k at exactly t = k/30, and its `cubic:` easing is the same curve as CSS `cubic-bezier` [MC-27]. That makes the per-frame step computable before any render (table in §3.3).
3. **Layout has to be checked over time, not only at rest.** 14 findings were collisions or tangencies. At least 7 of them existed only while something moved: a drift, an anticipation pull-back, the camera push, an exit. A still of the resting state never shows these.
4. **Rhythm and life:** 6 findings were dead spans, 2 were hits landing after the beat, and 5 were badly shaped eases: symmetric punches, a long tail at the apex of an overshoot, a landing that happens off-screen.
5. **The lenses catch different things.** 9 issues were reported by two or three lenses. Every other issue was caught by one lens only: the design lens caught figures reading "IO%", contrast and the optical centre; QA caught one-frame specks and the frame count; the motion lens caught dead spans and speed breaks at cuts. Running several lenses is not redundant.
6. **Fixes cause regressions.** At least 4 distinct issues in round 2 (7 findings) and 3 findings in round 3 were side effects of the previous round's fixes. Every round has to re-check the neighbours of each change.
7. **Figma Motion covers most of the craft vocabulary.** It can animate transforms, size, corner radius, opacity, path trims, layout spacing, solid colours and blur. It has gaps:
   - no directional motion blur, only Gaussian or progressive blur [MC-28];
   - no audio in the video export [MC-28];
   - no per-glyph text animation, so animated type needs one node per word or letter inside a clip frame;
   - every export renders the whole timeline [MC-28].

   The skill has to turn each gap into a known workaround.
8. **UI motion tokens are tuned for short UI moves.** Material [MC-01], Carbon [MC-03] and Fluent [MC-04] tokens pop on a full-screen move at 30 fps. Material's emphasized-decelerate curve puts 52 % of a 15-frame move into its first frame (§3.3). Video needs its own easing roles, checked per frame in pixels.
9. **Platform specs change, so treat them as live data.** Meta's current Instagram Stories ad spec says to keep about 14 % at the top, 35 % at the bottom and 6 % on each side free of text and logos, and recommends 1440 × 2560 [MC-21]. The 2026-10-09 bible used 250 px top and 340 px bottom from older guidance [MC-22]. Under today's spec the ad's "moku.store" line and footer sit inside the covered band. The skill must read safe zones at brief time.
10. **Today's `motion` topic verifies with a 12 fps GIF and three frames.** That is right for UI micro-motion, but it cannot see a one-frame pop in a 30 fps piece. Film-grade review needs the delivery frame rate. The tool also caps one call at 12 stills (`MAX_FRAMES`), and every call re-renders the whole piece [MC-28], so the review plan has to be designed around those limits (section 8).

---

## 1. Evidence

### 1.1 The 2026-10-09 run in numbers

**Pipeline:**
1. Inventory, and a critique of the old ad against a senior bar.
2. Three motion directors, each writing a spec with keyframes: type-led "Slow down.", graphic shape-led "One circle of clay", camera-led "One Camera".
3. Three judges: motion craft, ad effectiveness, buildability.
4. Synthesis into one build bible: `final-spec.md` plus a keyframes JSON with 175 nodes, 93 animated layers, 182 tracks and 681 keys, validated against the 1/30 s grid.
5. The rig and five scene builders, in parallel.
6. One render.
7. Three rounds of three critics (motion craft, design and type, technical QA), each followed by a fixer.
8. The finish.

**Judges' scores of the specs** (craft / ad / build): type 8.5 / 8 / 8, graphic 9 / 7.5 / 7, camera 8 / 6.5 / 7.5. The type spec became the spine, with grafts from the other two, plus restraint rules: no whip, one camera move, at most two devices between 6 and 9 s.

**Critics:**

| Round | Motion craft | Design & type | Technical QA | Findings | Blocker / major / minor |
|---|---|---|---|---|---|
| r1 (render r0) | 6.5 | 6.5 | 7 | 36 | 1 / 9 / 26 |
| r2 (render r1) | 8 | 7 | 7.5 | 22 | 0 / 4 / 18 |
| r3 (render r2) | 8 | 8 | 7.5 | 15 | 0 / 3 / 12 |
| total | | | | **73** | **1 / 16 / 56** |

**Fixers:** r1 applied 30 fixes and skipped 10 (superseded, merged or conflicting); r2 applied 26 and skipped 3; r3 applied 7 changes covering only the 3 majors and left the 12 minors open. There was no fourth critique.

Every scene builder reported `ok`. The first render still drew 36 findings, including a blocker and 9 majors. **Self-checks by the builder do not replace an outside review.**

**The old ad's critique** (inventory §4) is a catalogue of what reads as generated motion:
- a blank first frame;
- one move (fade plus a small slide) on 15 of 23 layers;
- staggers of 4.5 frames, off the frame grid;
- a slideshow rhythm: build, freeze, exit, gap;
- about 3.2 s of 12 frozen;
- camera pushes that ease to a stop;
- default spring pops;
- the brand first seen at 9.1 s;
- the CTA held for 1.63 s;
- a logo fade-in on black.

### 1.2 External sources used (details in section 7)

| Topic | IDs |
|---|---|
| Easing and duration in design systems | MC-01 Material 3, MC-02 Material (legacy guidance), MC-03 Carbon, MC-04 Fluent 2, MC-05 Apple HIG |
| Animation principles and workflow | MC-06 twelve principles, MC-10 blocking then splining, MC-11 speed graph (to-verify), MC-14 shutter angle |
| Pre-production | MC-07 storyboard, MC-08 animatic, MC-09 style frames and design boards, MC-24 brief |
| Editing and transitions | MC-12 match cut, MC-13 whip pan, MC-25 Murch (to-verify) |
| Reading | MC-15, MC-16 subtitle reading speed and duration, MC-17 silent reading rate |
| Accessibility | MC-18 flashes, MC-19 contrast, MC-20 animation from interactions |
| Platform | MC-21 Meta Stories spec, MC-22 the conflicting safe zone, MC-23 first 3 s and sound |
| Tooling facts | MC-26 ffmpeg filters, MC-28 plugin typings, MC-27 and MC-29 to MC-33 measured in the run |

---

## 2. The process as numbered stages

**Gear first.** For UI micro-motion (one component, under about 1 s, on a product screen), run stages 1, 10, 11 and 12 in light form, using the productive tokens of the product's own design system [MC-03]. For a piece (an ad, a reel, a title, a product film, an animated end card), run every stage. The rest of this section is about a piece.

| # | Stage | What it produces | Exit gate | In figma-mcp |
|---|---|---|---|---|
| 1 | **Brief** | One page: objective; audience; the single-minded message (one sentence); mandatories (brand, product, offer, CTA, legal); placement and format; duration; sound on or off; safe zones read **today** from the platform's spec [MC-21] [MC-23]; how success is judged [MC-24] | The message fits in one sentence, and each mandatory has a reason | No tool. Inventory what exists with `figma_get_design_context` and `figma_get_motion_context` |
| 2 | **Concept directions** | 2 or 3 directions that differ in kind, each starting from a different source: type, shape, camera, character or data. Each has: the idea in one paragraph, the one device that carries it, how it serves the message, frame 0, the end frame, risks, and a cost in layers and tracks | Judged through 3 lenses (craft, effectiveness, buildability). Choose a spine and at most a few grafts, and write restraint rules (a cap on devices per stretch, at most one whip, and so on) | Text first. Optional thumbnails on a scratch page |
| 3 | **Script / beat sheet and BPM grid** | A table with columns: bar.beat, t (s), frame, hit, on-screen copy, word count, readable from–to, device. Choose a tempo so that one beat is a whole number of frames [MC-39]. Major hits go on downbeats, secondary hits on beats or 8ths. Plan **one breath** (nothing new arrives, only drifts) directly before the end card | Every line meets its read time [MC-35]. The brand shows by 3 s [MC-23]. The CTA holds for at least 2.5 s. Frame 0 carries a message | No tool. The table is a text node on the storyboard page, or a file where the client has files |
| 4 | **Storyboard** | One panel per shot or beat. Columns: #, timecode in/out (s and frame), thumbnail, action, camera, transition in and out, audio/VO cue, on-screen text with words and hold time, notes. A panel is a decision, not an illustration [MC-07] | Every transition is motivated by something already on screen, so no transition exists without a reason. Every panel is readable at phone size | One frame per panel built with `figma_create_from_spec`, at a reduced size (for example 270 × 480) in a grid on a "Storyboard" page, with notes as text |
| 5 | **Styleframes (design boards)** | 3 to 6 full-resolution stills in the final look [MC-09]: frame 0 (the poster and hook), the product hero, the offer, the end card, and **one mid-transition frame** | A static critique passes on each: type (figure style, sizes, hierarchy), collisions and tangencies, safe zones, contrast ≥ 3:1 for large type [MC-19], palette, image fit. Most of the run's static findings would have been caught here | Real frames at delivery size, built through the design skill's loop, judged with `figma_export_node` and `figma_check_layout` |
| 6 | **Technical probe** | A short render (about 2 s of timeline) of every mechanism the boards rely on that nobody has measured: spacing reflow, radius clamping while the size animates [MC-31], the scale pivot while WIDTH is off rest, zero-length trims with round caps, what the blur ramp looks like | Each mechanism either works or has a named fallback | A sandbox frame at an empty spot, `figma_set_keyframes`, then `figma_export_video` with `frames` |
| 7 | **Animatic** | The boards on the timeline: each panel switched on and off by frame-exact cut pairs [MC-38] at its beat-sheet times, rendered small at the delivery frame rate. If there is a track, it is muxed in for review (Figma's export has no audio [MC-28]) [MC-08] | Pacing, read times, brand time, CTA hold and the breath work at full speed. Panels are retimed here, never later | A dedicated top-level frame. Panels are child frames with OPACITY cut pairs. `figma_export_video` (MP4, delivery fps, small width) |
| 8 | **Build bible** | Keyframes as data, generated from one source and validated, plus conventions: easing tokens, cut pairs, resting state, mask rules, z-order, package boundaries, the frames to check with what must be visible in each | Validated: every key on the grid; caps (100 keys per track, 50 tracks per call); blur prerequisites present; the timeline length fixed | JSON beside the bible where the client has files; otherwise a table on a "Bible" page. One package per scene |
| 9 | **Blocking pass** | Every layer built in its visible resting layout; poses keyed on the beat times with cut pairs or LINEAR holds, with no shaped easing yet [MC-10] | The composition at every beat frame matches the boards | `figma_create_from_spec`, `figma_set_keyframes`, readback with `figma_get_motion_context` |
| 10 | **Refining pass (curves)** | An easing role assigned to every move (§3.4). The per-frame values computed from the keys, which is the numeric speed graph [MC-27]. Overlap and offsets of at least 2 frames [MC-36]. Anticipation where weight matters. Speed matched across every cut [MC-13] | No frame carries more than about 25 % of a large move unless the edge is blurred or covered (§6 A1). Every hit peaks on its beat frame | `figma_set_keyframes` per layer. The numbers come from the keys, not from pictures |
| 11 | **Polish pass** | Follow-through and settles on secondaries; blur ramps scaled to the per-frame step [MC-37]; drifts so that no hold is dead; at most about 3 hand-keyed overshoots; tonal bridges across cuts; a clean, settled last frame | The A, C and E checks in §6 pass on the keys | As above |
| 12 | **Review** | One render at delivery fps; a contact sheet; every-frame close-ups of each transition; stills cut by frame index [MC-30]; scans for freezes, flicker and luma steps; then 3 lenses (motion craft, design & type, technical QA) plus the brief's lens, each in a fresh context, writing findings in one schema | Two conditions: no blocker or major remains, and the last round introduced no regression. Otherwise merge the fixes (resolving conflicts between lenses), apply them as one batch, re-render once and review again | `figma_export_video`, `figma_get_motion_context`. ffmpeg on the machine for sheets and scans [MC-26] |
| 13 | **Delivery** | The master trimmed to the exact frame count [MC-29]; encoded to the placement's spec (for Meta: H.264, constant frame rate, AAC stereo of at least 128 kbps, 9:16) [MC-21]; audio muxed; a poster frame; captions if sound carries meaning; a final frame-0 and last-frame check | The file plays from frame 0 with a message on screen, ends settled, and matches the spec | `figma_export_video { saveTo }`, then ffmpeg trim and mux where available |

**Why the order matters.**
- **Stages 1 to 3 cost minutes.** The message, the read times and the rhythm are fixed while they cost nothing to change.
- **Stage 4 comes before any animation** because it is the cheapest place to find a missing transition motive or an overloaded beat [MC-07]. In the old ad, a 33-word scene that could never be read was exactly this kind of failure.
- **Stage 5 removes the static faults** before they are multiplied across frames.
- **Stage 7 is the first time the piece is seen at speed.** Retiming here costs keys on a few panels; after stage 11 it costs a rebuild [MC-08].
- **Stages 9 to 11 separate pose, curve and finish** [MC-10]. Shaping easing on a move that is in the wrong place is wasted work, and a fully splined move that has never been blocked tends to look soft and undecided.

---

## 3. Mapping onto Figma Motion

### 3.1 What Figma Motion can and cannot do

| Practice | How it is done in Figma Motion through figma-mcp | Limit or trap |
|---|---|---|
| Timeline and frame grid | Keys in seconds. Frame k is sampled at exactly k/30 at 30 fps [MC-27] | The export renders the end frame too, so a 14.4 s timeline gives 433 frames [MC-29]. Trim on delivery |
| Cuts | Cut pairs: the old value at k/30 − 0.025 and the new value at k/30 − 0.005, both LINEAR [MC-38] | A HOLD written at a 3-decimal time (2.467) fires one frame after the intended one, because 2.467 > 74/30. Use cut pairs, or exact k/30 times |
| Position, rotation, scale | `TRANSLATION_X/Y/XY`, `ROTATION`, `SCALE_X/Y/XY` [MC-28]. Translation and rotation add to the rest pose, and scale multiplies it | Scale pivots on the node's own centre. To pivot elsewhere, counter-translate on the same curve (T = (1 − s)·offset), as the run did for the push-through |
| Arcs | Separate `TRANSLATION_X` and `TRANSLATION_Y` tracks with different easings bend the path; a single `TRANSLATION_XY` track always moves in a straight line | Alternatively, rotate a parent around an offset pivot |
| Squash and stretch | `SCALE_X` and `SCALE_Y` in opposite directions on shapes, keeping the area roughly constant [MC-06] | Avoid it on type |
| Masks, wipes, irises | Clip frames (`clipsContent`, no auto-layout) with animated `WIDTH`/`HEIGHT`/`CORNER_RADIUS`; the content inside is counter-translated so it stays fixed on screen | `WIDTH`/`HEIGHT` do not animate on groups or vectors (the current topic). A "circle" made from a radius keeps its shape only while W = H, because the radius clamps at min(W,H)/2 [MC-31] |
| Trim-path draws | `PATH_TRIM_START`/`END` on the vectors of an imported SVG | A round cap at zero length can show a dot (the judges' risk list); guard it with OPACITY while the length is 0 |
| Tracking animation | `STACK_SPACING` on an auto-layout row with FIXED size | Children of an animated row must not get TRANSLATION keys (bible §3.5). Every spacing track needs a TRANSLATION_X fallback until it is measured |
| Colour changes | `fill:<i>` / `stroke:<i>` on SOLID paints | Keyframed fills are raw hex, unbound from variables (bible §3.6). A colour change applies to the whole node, so a wipe passing over text needs a frame-exact flip |
| Motion blur | `effect:0:RADIUS` on a LAYER_BLUR that exists first | Gaussian only, with no direction [MC-28], so its peak must sit on the fastest frames and scale with the step [MC-37]. A large blur on type turns it to mush |
| Shutter feel | None. Blur ramps fake it; 180° shutter blur covers about half the frame interval [MC-14] | The fake is per layer and uniform. Keep it below the threshold where type stops reading |
| Kinetic type | One text node per word or letter, each inside its own clip frame; rises with TRANSLATION_Y; blur on the first, fastest frames; scale punches on the parent row | No per-glyph animator; node count grows fast (the run had 93 animated layers) |
| Camera | A container per scene, keyed as the camera (scale and translation with pivot compensation) | There is no 3D and no depth of field. Parallax means separate containers drifting at different rates |
| Sound | Not in Figma: the export settings have no audio member [MC-28] | The beat grid is arithmetic; the track is muxed after export |
| Seeing it move | `figma_export_video` renders the whole top-level frame across the full duration [MC-28]. `frames` returns at most 12 stills per call and needs ffmpeg on the server machine | Each call re-renders everything. The run's renders took 28 to 47 s at 1080 × 1920. The window must not be minimized [MC-32]. A client that times out long calls cancels the render |
| Still renders | `figma_export_node` shows the resting state only [C-116] | Keep every resting state visible and laid out, and hide things only with keyframes (bible §3.4). Whether keying t=0 OPACITY rewrites the base opacity is to-verify [MC-33] |
| Animation styles | Readable in `figma_get_motion_context`; cannot be applied through figma-mcp yet | Manual keyframes only |

### 3.2 The classic principles in Figma terms [MC-06]

| Principle | In Figma Motion | Seen in the run |
|---|---|---|
| Squash and stretch | Opposed `SCALE_X`/`SCALE_Y` on shapes | Not used. The dot's squeeze before the burst (96 → 90 → 84 → 80) is a cousin of it |
| Anticipation | A small reverse key before the move, e.g. a 0.965 pull-back before a 2.6× dive, or a 3 % swell before a collapse | Missing on the dive (R1M7); a "stall" posing as anticipation (R1Q13) |
| Staging | One focal action per beat; dim the rest (OPACITY to about 0.6, not 0.35) | Dimming to 0.35 made the list illegible (R2D3) |
| Straight ahead vs pose to pose | Keyframes are pose to pose: block first (stage 9) | |
| Follow-through and overlap | Secondaries lag by 2 to 4 frames, overshoot and settle with three hand-keyed keys | The pointer dot's 3-frame lag; the ring's lag and settle |
| Slow in and slow out | Cubic easing roles (§3.4) | Front-loaded curves caused 15 findings (§4.2) |
| Arcs | Separate X and Y tracks with different easings | |
| Secondary action | Ring spin, ripple, arrow nudge | The ripple hidden under the pill on its first frames (R1M4) |
| Timing | Frames per action, placed on the beat grid | Hits starting on the beat peak after it (R2M1) |
| Exaggeration | 6 to 8 % punches, used sparingly, at most about three overshoots per piece | Judges rejected stock back-ease and spring overshoots |
| Solid drawing, appeal | Composition and type quality | The styleframe stage |

### 3.3 How much of a move lands in one frame (computed from MC-27)

The share of the total travel in the single largest frame step, for a move over N frames at 30 fps (`skills-work/curves.cjs`):

| Curve | 3 | 5 | 8 | 10 | 15 | 20 | 30 |
|---|---|---|---|---|---|---|---|
| expo-out `0.16,1,0.3,1` | 90 % | 75 % | 58 % | 49 % | 36 % | 28 % | 19 % |
| Material emphasized-decelerate `0.05,0.7,0.1,1` [MC-01] | 89 % | 78 % | 68 % | 62 % | 52 % | 45 % | 35 % |
| Material standard `0.2,0,0,1` [MC-01] | 73 % | 50 % | 35 % | 34 % | 23 % | 19 % | 13 % |
| ease-in `0.7,0,0.84,0` | 90 % | 75 % | 58 % | 49 % | 36 % | 28 % | 19 % |
| Material emphasized-accelerate `0.3,0,0.8,0.15` [MC-01] | 70 % | 52 % | 37 % | 32 % | 23 % | 18 % | 13 % |
| in-out `0.65,0,0.35,1` | 70 % | 50 % | 29 % | 25 % | 19 % | 14 % | 9 % |
| whip `0.83,0,0.17,1` | 81 % | 66 % | 36 % | 33 % | 33 % | 22 % | 17 % |
| soft `0.45,0,0.55,1` | 56 % | 35 % | 22 % | 18 % | 12 % | 9 % | 6 % |
| `0.7,0,0.3,1` | 74 % | 54 % | 31 % | 27 % | 22 % | 16 % | 11 % |

The share of travel still left on the last frame before the end key, for an exit that ends on a cut: ease-in leaves 75 % at 5 frames and 49 % at 10; soft leaves 7 % and 2 %; in-out leaves 4 % and 1 %.

The table reproduces the critics' measurements:
- the whip over 15 frames put "30 %" into one frame (R1M3);
- the 3-frame arrow nudge put "90 %" into its first frame (R1Q10);
- the 5-frame ease-in iris close was still at 60 to 75 % of its size on its last visible frame (R1Q1).

Multiply the share by the distance in pixels to get the step. If the step is over about 150 px with no blur, or the share is over about 25 % on a large edge, the move pops (§6 A1).

### 3.4 Easing roles for video

These are run-derived decisions, checked against the per-frame table above, not copied from UI tokens:

| Role | Curve family | Rule |
|---|---|---|
| Arrival on screen | Strong ease-out, e.g. `0.16,1,0.3,1` | Long enough that the first frame stays under about 25 % (15 frames or more for a large move), or blur the first frames |
| Exit that leaves the frame or ends behind cover | Ease-in, e.g. `0.7,0,0.84,0` | Allowed only if the last visible frame is covered, blurred, or the element is already small |
| Exit that ends visibly (a close, a collapse, a trim) | Soft or in-out | The element must be at 7 % of its size or less on its last visible frame (R1Q1, R1Q3 to R1Q5) |
| Move across the screen | In-out, e.g. `0.65,0,0.35,1` or `0.7,0,0.3,1` | Avoid the whip below about 20 frames (R1M3, R3Q4) |
| Punch on a beat | Fast attack, e.g. `0.2,0.7,0.4,1`, then a slower release, e.g. `0.33,0,0.2,1` | Start the attack about 2 frames before the beat, so the peak lands on the beat frame and holds about 2 frames. Never a symmetric spike (R2M1, R3M2, R3Q6) |
| Overshoot accent | Three hand-keyed keys: past, back, rest, e.g. 1.08 → 0.985 → 1 | At most about 3 per piece. No stock back-ease or spring as the default |
| Settle, dim, blur ramp | Soft `0.45,0,0.55,1` | |
| Drift and hold | LINEAR | A hold still moves (§6 F) |
| Cut | LINEAR cut pair [MC-38] | Never HOLD |

UI motion (product screens) is the other mode. It uses the product's tokens [MC-01] [MC-03] and durations of about 70 to 700 ms [MC-03]. Exits may be shorter than entrances [MC-02]. Duration grows with distance and size [MC-03] [MC-04]. It must respect reduced-motion settings [MC-05] [MC-20].

### 3.5 Transitions in Figma terms

| Transition | Build | Checks the critics applied |
|---|---|---|
| **Match cut** (graphic match) [MC-12] | The outgoing shape lands on the incoming shape's size, position and colour, and the scenes swap on one frame | Hold the matched shape for 3 to 4 frames so the eye registers it (R1M1). On the swap frame the two must be pixel-identical (R2M2, R2Q4). No reversal of direction or size inside one frame (R1Q2) |
| **Push-through / zoom cut** | Ease-in dive on the outgoing container, pivot-compensated; the incoming container starts large and blurred and eases out | Match the per-frame zoom rate across the cut (×1.27 vs ×1.08 was flagged; ×1.32 vs ×1.27 passed) and the zoom origin (R1M2, R1Q7). **Match tone**: a 59/255 luma jump read as a white flash; a tonal bridge brought it to 9.2 (R3M1) [MC-13] |
| **Whip** | A fast in-out with a ramped blur; scale stretch along the direction | Same direction and same speed on both sides; join where the blur peaks; match brightness at the join [MC-13]. The run allowed at most one whip in the piece |
| **Iris / bloom wipe** | Two or more stacked circles 2 frames apart; W = H = 2r animated with the radius; content counter-translated | Overshoot the end size so the last corner is crossed while still fast, but land inside the frame so the soft landing is seen (R1M9, R2M4). Blur scaled to the step: 12 px on 400 to 458 px steps strobed; 32 px fixed it (R3Q5) |
| **Stacked plate wipe** | Coloured plates crossing inside a clip, 2 frames apart | Whip over 9 frames put 468 of 980 px into one frame; in-out with blur 24 fixed it (R3Q4). Same colour crossing same-colour type hides the type (R2Q6) |
| **Mask reveal** | Text inside a plain clip frame, rising from below the clip line | The clip line must lie on a real edge in the picture, or letters get sliced by an invisible line (R3Q1) |
| **Morph** (circle → rectangle → pill) | `WIDTH`, `HEIGHT`, `CORNER_RADIUS`, translation | Keep W and H on the same curve while round (R3Q3); start squaring while still growing and land on the beat (R1M10) |
| **Hard cut on the beat** | Cut pairs | Give the incoming image a small settle (1.06 → 1) so the cut carries impact (R3M3) |
| **Cross-fade** | OPACITY | Reads as a prototype fade; the only fade in the piece was flagged (R2M3). Avoid it unless the style is built on dissolves |

### 3.6 Kinetic typography

- **Type is the message; motion should not cost reading.** Count words. The read time runs from "fully legible" to "covered" [MC-35].
- **Split by meaning.** Use per-word rises for phrases and per-letter only for a single word that carries the concept, as "S l o w" and "down." did in the run. Inside a group the offset is 2 frames [MC-36]; 1-frame offsets read as colour fringes.
- **Blur and punches.** Put blur on the first, fastest frames of a rise (8 to 10 px on display type) and nowhere else (R3Q2). Put a scale punch of about 6 % on the beat, peaking on the beat frame (R2M1, R3M2).
- **Tracking.** Animate spacing on a FIXED auto-layout row. It works well as the hook on frame 0.
- **Exits use the same mechanism as entrances.** Use a mask and blur, not a fade (R2M3), and add an OPACITY guard so no anti-aliased fragment is left on the mask edge (R2Q2).
- **Figure style.** Check numerals in the chosen face. Old-style figures made "10%" read "IO%" (R1D2). Lining figures cannot be switched on through the Plugin API, so change the face for the figures.
- **Size and layout.** Display type of 200 px or more is legible on a phone at 9:16. Keep secondary Inter text at 28 px or more. Two lines in one style must differ clearly in size, or be identical: 56 vs 60 px read as a mistake (R3D4).

### 3.7 Measured traps and the state of the 2026-10-09 tool defects

- **Not reproduced on 2026-10-13** (`live-probe-2026-10-13.md`, main agent): the multi-track call applying only its last track, the x+y move moving only y, and the move inside a batch that did nothing. The probe attributes them to build skew between the hub and the plugin. **The skill must not encode workarounds for them** (`delivery.md` §8, rule 7). The defensive readback the probe proposes (report tracks that did not land) belongs in the tool.
- **Twin ids.** Ids were readable but rejected every write; they were transient and gone after a reload. The fix belongs in the tool.
- **Still open and measured:** the end frame is rendered [MC-29]; a minimized Figma window stalls the export [MC-32]; an input seek of (k + 0.5)/30 lands on frame k + 1 [MC-30]; the radius clamps [MC-31].
- **To-verify:** whether keying t=0 OPACITY rewrites the base opacity [MC-33].

---

## 4. What the 2026-10-09 critics measured

Finding IDs: `R<round><lens><n>`. M = motion craft, D = design & type, Q = technical QA; n is the order inside that critic's result in `journal.jsonl`. Each finding has exactly one primary category, and the counts sum to 73. Tally script: `skills-work/tally.cjs`.

### 4.1 Recurring finding types

| Category | Count | Severity | Finding IDs | Typical measurement |
|---|---|---|---|---|
| Collision / tangency (type or graphic against an edge or other type) | 14 | 6 major, 8 minor | R1D1, R1D3, R1D6, R1D9, R1Q6, R2D2, R2D5, R2D6, R2Q1, R2Q6, R3D1, R3D2, R3D3, R3Q1 | Dimension line through the "$" bar; ripple through "moku.store" on f401–f403; band edge 3–11 px into the baseline during the drift |
| **One-frame pop** (most of a move, or an appearance or vanish, in one frame) | 10 | 2 major, 8 minor | R1M3, R1Q1, R1Q3, R1Q4, R1Q5, R1Q8, R1Q10, R1Q11, R2Q3, R3Q4 | Disc Ø 331 → 606 → 739 (+275 px in one frame); slit 53 % of its close in the last frame; ring vanishing at 63 % length |
| Static design (type, composition, copy, imagery) | 7 | 1 major, 6 minor | R1D2, R1D4, R1D5, R1D7, R1D11, R2D7, R3D4 | "IO%" old-style figures; block centred 135 px above the safe area's centre; 56 vs 60 px |
| **Dead span** (nothing moves, or a drift stalls) | 6 | 1 major, 5 minor | R1M5, R1M6, R1M11, R1Q13, R2M7, R3M3 | Mean frame diff 0.08–0.12 against the designed breath's 0.22; end card 0.03–0.04 for 26 + 25 frames |
| Ease shape (symmetric punch, apex tail, landing off-screen) | 5 | 5 minor | R1M9, R2M4, R2M5, R3M2, R3Q6 | Punch widths 732, 754, **776**, 755, 743: a one-frame cusp; bloom landing at Ø 4050 when Ø 2900 covers the frame |
| Match-cut handoff (dot not held, not identical) | 4 | 1 blocker, 1 major, 2 minor | R1M1, R1Q2, R2M2, R2Q4 | The dot on screen for one frame; Ø 84 → 96 snap on the swap frame |
| Cut continuity (speed or tone breaks at a cut) | 3 | 2 major, 1 minor | R1M2, R1Q7, R3M1 | Zoom ×1.27/frame into the cut, ×1.08 out; a 59/255 luma jump, 97.7 % of pixels changed |
| Weak or occluded accent | 3 | 1 major, 2 minor | R1M4, R1D8, R1Q9 | Ripple under the punched pill for 3 frames, then a 1 px hairline at about 2.7:1 |
| Sequencing (a late separate event, an exit too late, waiting) | 3 | 3 minor | R1M10, R2D4, R3M4 | Field shrinking into a pill while still reading "order."; label off-centre until the arrow draws |
| Blur missing, undersized or out of phase | 3 | 3 minor | R2M6, R3Q2, R3Q5 | Blur peak when the letter has moved 8 px, gone by the 40 px frame; 12 px blur on 458 px steps |
| Hit lands after the beat | 2 | 2 minor | R1M8, R2M1 | Attack starting on the beat puts the peak 2 frames late; a 5-frame empty plate across the downbeat |
| Read time / legibility | 2 | 1 major, 1 minor | R1D10, R2D3 | "By hand." 0.63 s; dimmed list at 2.16:1, about 0.1 s per word |
| Residue / speck | 2 | 2 minor | R1Q12, R2Q2 | A 2 × 2 px dot for one frame; an anti-aliased descender tip on a mask edge for 5 frames |
| Delivery (frame count) | 2 | 2 minor | R1Q14, R2Q7 | 433 frames for a 432-frame timeline |
| Drift breaks the layout or a lockup | 2 | 1 major, 1 minor | R2D1, R3M5 | Scale about the frame centre pushed the column 17 px past the 64 margin; the logo-to-rule gap grew 58 → 70 |
| Edge reveal (overscan missing) | 2 | 2 minor | R2D8, R2Q5 | A 0.965 pull-back showed 13/24 px cream slivers at the band's sides |
| Missing anticipation | 1 | minor | R1M7 | A dive with an ease-in and no wind-up; blur leading the motion |
| Inconsistent vocabulary | 1 | minor | R2M3 | The only cross-fade among mask exits |
| Morph shape | 1 | minor | R3Q3 | W outran H, so the "circle" rendered as a stadium (chord 198–215 px against 111) |

### 4.2 Root causes (not exclusive; each tag lists its findings)

| Root cause | Findings | IDs |
|---|---|---|
| An easing concentrates the travel in one frame | 15 | R1M1, R1M3, R1M9, R1M11, R1Q1, R1Q2, R1Q3, R1Q4, R1Q5, R1Q8, R1Q10, R1Q11, R2Q3, R2M4, R3Q4 |
| Only rest poses or stills were checked; the fault exists only in motion | 9 | R1D6, R1Q6, R2D1, R2D8, R2Q5, R2Q6, R3D1, R3Q1, R3M5 |
| Blur missing, too small, or peaking at the wrong time | 8 | R1M3, R1M7, R1Q8, R2Q3, R2M6, R3Q2, R3Q4, R3Q5 |
| The move starts exactly on its event (peak late, occluded, or a stall) | 5 | R1M4, R1M8, R1Q9, R1Q13, R2M1 |
| Symmetric or apex-heavy accent | 4 | R2M1, R2M5, R3M2, R3Q6 |
| Built differently from the spec | 2 | R1D1, R1D7 |
| Visible on a still at rest (styleframe-catchable) | 14 | the 7 static design findings plus R1D1, R1D3, R1D9, R2D2, R2D6, R3D2, R3D3 |

### 4.3 Overlap between lenses and regressions

- **Overlap.** 9 issues were found by more than one lens: the dot handoff (R1M1, R1Q2), the push-through (R1M2, R1Q7), the ripple (R1M4, R1D8, R1Q9), the headline under the bug (R1D6, R1Q6), the ripple against the URL (R2D5, R2Q1), the pull-back edges (R2D8, R2Q5), the squeeze at the handoff (R2M2, R2Q4), the headline against the band edge (R3D1, R3Q1) and the punches (R3M2, R3Q6). That leaves **63 distinct issues** among 73 findings.
- **Regressions caused by the previous round's fixes.** In r2: the drift that broke the grid (R2D1); the enlarged ripple crossing the URL (R2D5, R2Q1); the added pull-back revealing edges (R2D8, R2Q5); the added squeeze making the dot re-grow on the swap frame (R2M2, R2Q4). That is 4 issues and 7 findings. In r3: the band move leaving the mask clip line inside the photo (R3Q1); the headline crossing the moved band during the drift (R3D1); the added logo drift splitting the lockup (R3M5).
- **Conflicting fixes.** Lenses asked for opposite changes (hold "By hand." longer vs exit earlier; different overscan and ripple values). The fixer merged them; the merge step is part of the process.

### 4.4 How the critics measured (the methods the skill should name)

- **Frame-difference curves:** the mean absolute difference per frame on a small grey copy. Dead under about 0.12; the designed breath at about 0.22. Freeze detection with a 0.5 s minimum (ffmpeg's default minimum is 2 s [MC-26]).
- **Edge geometry per frame:** diameters, widths, positions and chords (a circle test) measured on full-resolution frames around each transition.
- **Luma per frame and luma step across a cut,** with the share of pixels that changed. The acceptance used: no step above 20 across the cut frames.
- **Flicker scan:** a frame that differs from both neighbours while the neighbours match each other.
- **Residue scan:** non-ground pixels on plain fields where E.2 says "nothing else".
- **Contrast ratios** on measured colours [MC-19].
- **Keyframe evaluation at k/30** (`r0/motion-eval.cjs`): per-frame values and deltas from the keys, which is the numeric speed graph [MC-27].
- **Readback** of every layer's tracks with `figma_get_motion_context`.
- **Delivery checks:** frame count, duration, and PSNR after a re-encode.
- **Views:** a contact sheet (6 fps, 9 × 10 tiles), every-frame close-ups (8 × 3 tiles) of each transition, and full-resolution stills cut by frame index [MC-30].

---

## 5. Draft skill outline

Written in my own words, for the catalog in `delivery.md` §4: `motion` (craft and mechanics), `storyboard` (pre-production and the bible), `critique` (review). The user asked for a "storyboard" skill; the stages 1 to 8 below are its content. The sizes are targets under delivery's budgets: index 5,000 bytes or less, each section 10,000 bytes or less.

### 5.1 `motion`: index (SKILL.md body)

**Description (300 bytes or less):** Plan, animate and review motion on a Figma frame's timeline: ads, reels, titles, animated end cards and UI micro-motion. Covers the stages from brief to delivery, easing roles, transitions, kinetic type, and the frame checks that keep motion from looking generated.

**Body:**
- **When.** Anything that moves on a Figma timeline. Prototype transitions belong to the `prototype` topic. When a motion tool answers UNSUPPORTED, stop and deliver the static design.
- **Gear.** UI micro-motion: build → check keys → one small render. A piece: run the stages below; the `storyboard` skill holds stages 1 to 8 and `critique` holds stage 12.
- **The stages, one line each with its exit gate** (section 2 of this research, compressed): brief → directions → beat sheet → storyboard → styleframes → probe → animatic → bible → blocking → curves → polish → review → delivery.
- **Hard rules (each one a measured failure):**
  1. Frame 0 already carries the message, and the last frame is settled and clean.
  2. Every key sits on the frame grid; cuts are cut pairs, never HOLD.
  3. No frame carries more than about a quarter of a big move unless the edge is blurred or covered (check the keys before rendering).
  4. Offsets inside a group are 2 frames or more; a hit peaks on its beat frame.
  5. Nothing holds dead for more than 0.5 s; holds drift.
  6. Layout is checked on every frame of drifts and holds, not only at rest.
  7. Each word stays readable long enough (`formats` section).
  8. Review at the delivery frame rate, through several lenses, and re-check the neighbours of every fix.
- **Sections:** `easing`, `principles`, `transitions`, `kinetic-type`, `formats`, `passes`, `mechanics` (today's topic, revised).

### 5.2 `motion` sections

**`easing` (about 5 KB)**
- Easing roles for video: arrival, exits (covered vs visible), moves across the screen, punch (attack and release), overshoot accent, settle, drift, cut. Give each a curve string ready for `figma_set_keyframes` (§3.4).
- The per-frame share table (§3.3), and the rule for using it: multiply by the distance in pixels; over about 150 px per frame needs blur.
- Asymmetry: a fast attack with a slow release that hangs; never an isosceles spike.
- Overshoot is hand-keyed (past, back, rest), at most about three per piece; stock back-ease or a spring is not a default.
- UI mode: use the product's tokens and short durations; exits a little shorter; duration grows with distance; honour reduced motion [MC-01] to [MC-05] [MC-20].

**`principles` (about 4 KB)**
- The classic principles mapped to fields, as in §3.2: anticipation as a small reverse key, follow-through as lag and settle, arcs from split X and Y tracks, staging by dimming to about 0.6.
- Timing and spacing: timing is how many frames a move takes; spacing is how far it travels in each frame; the spacing is what the eye reads [MC-06].
- Tells of generated motion (inventory §4): the same move on every layer, slideshow rhythm, fade-ins, default springs, pushes that ease to a stop, a blank first frame, off-grid staggers, a logo fading in on black.

**`transitions` (about 7 KB)**
- One recipe per transition in §3.5, each with its build, the tracks it needs, and its check.
- Motivation: every transition grows out of something already on screen, such as a shape, a colour or a motion direction [MC-12].
- Continuity across cuts: speed, direction, zoom origin and tone match [MC-13].
- Restraint: count devices per stretch; one whip at most.

**`kinetic-type` (about 4 KB)**
- §3.6: split by meaning; one node per word or letter in plain clip frames; tracking on FIXED rows; blur only on the fastest frames; the punch on the beat; exits by mask, with a guard; check the figure style; minimum sizes for 9:16.

**`formats` (about 5 KB)**
- Read time: at least 5/6 s per block and 0.3 s per word, from fully legible to covered; numbers and prices count as words; the CTA at least 2.5 s [MC-35] [MC-15] [MC-16] [MC-17].
- The brand and the key message within the first 3 s; design for sound on, but read correctly with sound off [MC-23].
- Safe zones and resolution are read from the platform's current spec at brief time. Meta Stories today: 14 % top, 35 % bottom, 6 % sides clear, 1440 × 2560, 9:16 [MC-21] (and record the older figures as a conflict [MC-22]).
- Tempo: choose a BPM where one beat is a whole number of frames; at 30 fps that is 60, 72, 75, 90, 100, 120, 150 or 180 BPM [MC-39].
- Flash safety: no more than three large luminance flips per second [MC-18]. A single big luma jump at a cut is a craft fault (R3M1), not a seizure risk.
- Delivery spec: frame count, codec, constant frame rate, audio, poster frame [MC-21] [MC-29].

**`passes` (about 4 KB)**
- Blocking: the visible rest layout first; poses on beats; cut pairs; check the beat frames against the boards.
- Curves: assign roles; compute the per-frame steps; fix pops; overlap; anticipation; speed matched across cuts.
- Polish: settles, blur scaled to the step, drifts, accents, tonal bridges, a clean last frame.
- Render once per pass at the most, never per small change [MC-28].

**`mechanics` (today's `MOTION` topic, revised)**
- Keep today's rules (fields, value strings, easing names, additive and multiplicative transforms, timeline growth).
- Add: frame k = k/30 [MC-27]; cut pairs [MC-38]; the end-frame render [MC-29]; radius clamping [MC-31]; LAYER_BLUR as the only blur, with no direction [MC-28]; no audio [MC-28]; whole-timeline renders [MC-28]; the window must not be minimized [MC-32].
- Change verification: the GIF at 12 fps stays for UI micro-motion. For a piece, render MP4 at the delivery fps and use `frames` per phase, as the critique skill describes.

### 5.3 `storyboard` sections (stages 1 to 8)

- **`brief`.** The one-page brief (§2 stage 1): one problem, one message, mandatories, placement read live, success measures [MC-24] [MC-21] [MC-23].
- **`directions`.** 2 or 3 directions that differ in kind (type-, shape-, camera-, character- or data-led), each with its device, frame 0, end frame, risks and cost. Judge with three lenses in separate passes (craft, effectiveness, buildability); one agent can run them one after another. Choose a spine and grafts, and write the restraint rules.
- **`beat-sheet`.** The BPM grid and the table, with hits on downbeats, the read-time column, the breath before the end card, and the brand and CTA times.
- **`boards`.** Panel conventions (#, timecode in seconds and frames, thumbnail, action, camera, transition in and out, audio/VO, on-screen words and hold, notes) [MC-07]. Panels as small frames on a "Storyboard" page. Every transition motivated.
- **`styleframes-animatic`.** 3 to 6 styleframes, including one mid-transition frame, with a static critique [MC-09]. Then the animatic: panels switched by cut pairs on the beat grid, rendered small at the delivery fps, with the track muxed if available; retime here [MC-08].
- **`bible`.** Keyframes as data from one source; conventions; validation; packages; the "frames to check" table, one line per still with what must be visible (the run's E.2 is the model).

### 5.4 `critique` sections (stage 12)

- **`lenses`.** Motion craft, design & type, technical QA, and the brief's own lens (for example ad effectiveness). Each runs in a fresh context or pass with its own checklist (section 6).
- **`sampling`.** One render per round. A contact sheet for the whole piece. Every-frame close-ups across each transition, hit and handoff. Stills by frame index. Freeze, flicker and luma scans where ffmpeg exists [MC-26] [MC-30]. With only the tool: `frames` per phase, at most 12 per call, chosen from the "frames to check" table, plus the numeric checks from the keys.
- **`findings`.** One schema everywhere: severity, time and frame, layer name and id, problem with its measurement, fix as exact keys; a score; a verdict (`delivery.md` §8, rule 3).
- **`rounds`.** Merge conflicting fixes; apply them in one batch; re-render once; re-check the neighbours of every change for regressions. Stop when no blocker or major remains and the last round introduced no regression.

---

## 6. The critic-derived checklist

Every item comes from a run finding (IDs) or a source. Thresholds marked "run" are decisions calibrated on the 2026-10-09 run, at 30 fps on a 1080 × 1920 frame; they are not external standards.

**A. Before rendering, from the keys (no render needed)**
1. **One-frame pop.** For every move, compute the per-frame step from the curve [MC-27]. Flag when one frame carries more than about 25 % of the travel on an edge longer than about 300 px, or a step over about 150 px with no blur on that frame (run: R1M3, R1Q8, R3Q4).
2. **Visible exits.** Where an exit ends on screen, the element is at 7 % of its size or less on its last visible frame; a trim is at 0.96 or more before its guard cuts (run: R1Q1, R1Q3 to R1Q5).
3. **Guards.** An OPACITY guard switches on only when the shape is already big enough to read and off only when it is near zero. No 2 × 2 px specks (R1Q12, R1Q11).
4. **Grid.** Every key sits on k/30; cuts use pairs [MC-38]; there is no HOLD.
5. **Offsets.** 2 frames or more inside a stagger group [MC-36]; never several layers starting on the same frame unless they are meant to read as one.
6. **Hits.** Each accent's peak value falls on its beat frame, so the attack starts before the beat (R1M8, R2M1).
7. **Punch shape.** The attack is shorter than the release; the release keeps 80 % or more of the punch for about 2 frames (R3M2, R3Q6).
8. **Overshoot.** The approach to the apex is not a long expo tail (R2M5); count the overshoots and keep them at about 3 or fewer.
9. **Blur phase.** Each blur peak sits on the move's fastest frames; the radius is about 5 to 8 % of the per-frame step there; it is back to 0 before the element must read sharp [MC-37] (R3Q2, R3Q5).
10. **Morphs.** W and H share a curve while the shape must stay round (R3Q3).
11. **Simultaneity.** No drift stops on the frame a move starts (R1Q13); a ripple or echo is not born under the element that triggers it (R1M4).
12. **Caps.** 100 keys or fewer per track, 50 tracks or fewer per call; blur prerequisites present.

**B. Every frame (from the render)**
1. **Frame 0** shows the hook and the brand or message, with no blur and no blank (inventory §4) [MC-23].
2. **No freeze** longer than 0.5 s outside a designed breath; even the breath keeps drifts. Use a frame-diff curve, or freezedetect with `d=0.5` [MC-26] (R1M5, R1M6, R2M7).
3. **No flicker frame:** a frame that differs from both neighbours while they match each other (R3Q6).
4. **No residue** on plain grounds after exits (R1Q12, R2Q2).
5. **Edges moving fast enough to strobe** carry blur matched to their step (R3Q4, R3Q5).

**C. Cuts and handoffs**
1. A **match cut** holds its shared shape for 3 to 4 frames, and the two sides are pixel-identical on the swap frame (R1M1, R2M2, R2Q4).
2. **Speed continuity:** the per-frame zoom factor (or pan speed) on each side of a cut agrees within about 10 %. ×1.27 into the cut against ×1.08 out failed; ×1.32 against ×1.27 passed (run: R1M2, R1Q7, R3M1) [MC-13].
3. **Tone continuity:** the mean-luma step across the cut frames is 20/255 or less, and frame diff on the cut frame stays close to the surrounding transition frames (run: R3M1).
4. A **hard cut on a beat** carries an impact (a settle, a punch), not a bare swap followed by a dead hold (R3M3).
5. **Wipes** cross the last corner at speed and land where the landing can be seen (R1M9, R2M4).

**D. Type and reading**
1. Read time is at least max(5/6 s, 0.3 s × words) from fully legible to covered [MC-35]; the CTA is at least 2.5 s; dimmed items stay at 3:1 or more [MC-19] (R1D10, R2D3).
2. Figures read correctly in the chosen face (R1D2); two sizes in one style are equal or clearly different (R3D4).
3. Exits use the same mechanism as entrances (R2M3).
4. Type and the graphics behind it differ in colour at every frame of a crossing (R2Q6).

**E. Layout over time**
1. **Collisions and tangencies** are checked on every frame of holds, drifts, anticipations and pushes, not only at rest. Clearance is 20 px or more; anything under about 10 px reads as a mistake (R1D9, R2D6, R3D1 to R3D3).
2. **Clip lines** sit on real edges in the picture (R3Q1).
3. **Drifts** pivot where the grid needs them. Margins hold during the drift; a lockup drifts as one unit (R2D1, R3M5).
4. **Overscan** any full-bleed plate that scales below 1, by at least (1 − s)·W/2 per side (R2D8, R2Q5).
5. **Safe zones** come from the current platform spec, and are checked on every frame where text moves [MC-21].
6. **Accents** must read: a stroke of at least about 4 px on a phone, contrast with the ground, and visible from its first frame (R1M4, R1D8, R1Q9).

**F. Rhythm**
1. Hits on downbeats, secondary hits on beats or 8ths; a stated BPM [MC-39].
2. One breath directly before the end card, with drifts.
3. Activity during a scene stays above the breath's activity, so the breath reads as a contrast (R1M5).
4. The device count per stretch stays within the restraint rules.

**G. Finish and delivery**
1. The last frame is settled and clean.
2. The frame count equals duration × fps; trim the extra end frame [MC-29].
3. Stills for review are cut by frame index [MC-30].
4. Encode to the placement's spec; mux the audio; set a poster frame [MC-21].
5. **After fixes,** re-check every changed span and its neighbours (§4.3).

---

## 7. Claims

All were checked on 2026-10-13 unless stated otherwise. Quotes are the fetcher's rendering, under 15 words, one per source at most.

| ID | Claim | Status | Source |
|---|---|---|---|
| MC-01 | **Material 3 motion tokens.** Durations run short1 = 50 ms … short4 = 200, medium1 = 250 … medium4 = 400, long1 = 450 … long4 = 600, extralong1 = 700 … extralong4 = 1000 ms. Easings: emphasizedDecelerate (0.05, 0.7, 0.1, 1), emphasizedAccelerate (0.3, 0, 0.8, 0.15), standard (0.2, 0, 0, 1), standardDecelerate (0, 0, 0, 1), standardAccelerate (0.3, 0, 1, 1); legacy (0.4, 0, 0.2, 1) | verified | Flutter `packages/flutter/lib/src/material/motion.dart` (master, raw.githubusercontent.com), whose `Durations` and `Easing` are generated from the Material token database and link to m3.material.io/styles/motion/easing-and-duration/tokens-specs. The m3 page itself rendered empty to the fetcher |
| MC-02 | **Material (legacy guidance).** Mobile transitions are typically about 300 ms; entering 225 ms; leaving 195 ms; large full-screen 375 ms; tablet about 30 % longer. Leaving elements may be shorter because they need less attention. Deceleration curve (0, 0, 0.2, 1) for entering, acceleration (0.4, 0, 1, 1) for leaving, standard (0.4, 0, 0.2, 1) | verified | https://m1.material.io/motion/duration-easing.html. Archived Material 1 guidance; use it for the principle, not the numbers |
| MC-03 | **Carbon.** Productive motion (subtle, for task flows) vs expressive motion (for rare, significant moments). Duration tokens: fast-01 70, fast-02 110, moderate-01 150, moderate-02 240, slow-01 400, slow-02 700 ms. Curves: standard productive (0.2, 0, 0.38, 0.9), expressive (0.4, 0.14, 0.3, 1); entrance (0, 0, 0.38, 0.9) and (0, 0, 0.3, 1); exit (0.2, 0, 1, 0.9) and (0.4, 0.14, 1, 1). Duration grows with travel distance or size, on a non-linear scale; exit easing accelerates out | verified | https://carbondesignsystem.com/elements/motion/overview/ |
| MC-04 | **Fluent 2.** Motion is functional, natural, consistent and appealing. Larger elements get more time, and distance matters. Staggering uses short offsets, varied for repeated content. Avoid flashes and sudden jarring movement. Offer a no-motion setting | verified | https://fluent2.microsoft.design/motion. No token values appear on this page |
| MC-05 | **Apple HIG Motion.** Add motion only when it serves a purpose; never rely on motion alone to convey meaning; keep feedback brief and precise; let people skip or cancel motion; avoid sustained oscillation (visionOS, around 0.2 Hz). Quote: "Don't add motion for the sake of adding motion." | verified | https://developer.apple.com/design/human-interface-guidelines/motion via its JSON (`/tutorials/data/design/human-interface-guidelines/motion.json`); page last updated 2025-09-09 |
| MC-06 | **The twelve principles** from Thomas and Johnston, *The Illusion of Life: Disney Animation* (1981): squash and stretch, anticipation, staging, straight ahead and pose to pose, follow through and overlapping action, slow in and slow out, arc, secondary action, timing, exaggeration, solid drawing, appeal. Timing means the frame count of an action; slow in and out means more frames near the extremes | verified (secondary) | https://en.wikipedia.org/wiki/Twelve_basic_principles_of_animation, which cites the book |
| MC-07 | **Storyboard.** A visual plan of a video, scene by scene. Panels carry visuals, action captions, camera directions (angle, movement, transitions), timing and sequence notes, dialogue and numbering. It is made before production to avoid costly reshoots and edits, and to align the team | verified | https://www.adobe.com/in/products/firefly/discover/what-is-a-storyboard.html |
| MC-08 | **Animatic.** Each panel and scene is timed to the intended pace of the action and to the soundtrack, then played to test the pace. Storyboard Pro gives every panel 1 s by default | verified | https://docs.toonboom.com/help/storyboard-pro-25/storyboard/timing/about-timing.html |
| MC-09 | **Style frames and design boards are a recognised motion-design stage.** *Design for Motion* (Austin Shaw, Routledge, 2nd ed. 2019) teaches how to create them; its chapters include concept development and design boards by style (type-driven, illustrative, info-graphics, character-driven, tactile, modern) | verified | https://www.routledge.com/Design-for-Motion-Fundamentals-and-Techniques-of-Motion-Design/Shaw/p/book/9781138318656 |
| MC-10 | **Blocking then splining.** Animators often block in stepped mode, with no interpolation, to focus on poses and timing, then switch to spline. Converting can make motion feel mushy and needs refinement | verified (education blog, moderate trust) | https://www.pluralsight.com/blog/film-games/stepped-vs-spline-curves-blocking-animation |
| MC-11 | **Speed graph.** After Effects' Graph Editor has a value graph (property values) and a speed graph (rate of change); the height of the speed graph is speed | to-verify | helpx.adobe.com/after-effects/using/speed.html. A direct fetch returned 403; the text was seen only in a search-index excerpt |
| MC-12 | **Match cut.** An edit where two shots are linked by matching composition, action or subject. A graphic match lines up shape, colour or movement. Kubrick's bone-to-satellite cut in *2001* is the canonical example | verified (secondary) | https://en.wikipedia.org/wiki/Match_cut |
| MC-13 | **Whip-pan transitions.** Join the shots where the blur begins and ends; keep the same direction and a matched speed on both sides; match brightness and colour at the join, or soften it | verified (education site) | https://nofilmschool.com/how-to-do-a-whip-pan |
| MC-14 | **Shutter angle.** 180° is by far the most common cinema setting, about 1/48 s at 24 fps, which exposes about half the frame interval. A larger angle smears motion; a smaller one stutters | verified | https://www.reddigitalcinema.com/red-101/shutter-angle-tutorial |
| MC-15 | **Netflix English reading speed.** Up to 20 characters per second for adult programmes and 17 for children's; at most 42 characters per line | verified | https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide |
| MC-16 | **Netflix event duration.** At least 5/6 s per subtitle event (20 frames at 24 fps), at most 7 s | verified | https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements |
| MC-17 | **Silent reading rate.** A meta-analysis of 190 studies finds about 238 words per minute on average for adults | verified | BPS Research Digest, https://www.bps.org.uk/research-digest/most-comprehensive-review-date-finds-average-persons-reading-speed-slower, on Brysbaert (2019), *J. Memory and Language* 109, 104047. Participant counts differ between the digest and the paper; this is not load-bearing |
| MC-18 | **WCAG 2.3.1.** No more than three general or red flashes in any one second, or flashing below the area threshold. A general flash is a pair of opposing changes of 10 % or more of relative luminance, where the darker state is below 0.80 | verified | https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html |
| MC-19 | **WCAG 1.4.3.** Contrast of at least 4.5:1 for text; 3:1 for large text (18 pt or more, or 14 pt bold) | verified | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html |
| MC-20 | **WCAG 2.3.3 (AAA).** Motion triggered by interaction can be turned off unless it is essential; the techniques use `prefers-reduced-motion` | verified | https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html |
| MC-21 | **Meta Instagram Stories video ad spec.** 9:16; 1440 × 2560 recommended; MP4, MOV or GIF; H.264, square pixels, constant frame rate, progressive; stereo AAC at 128 kbps or more; duration 1 s to 60 min; at most 4 GB. Keep roughly 14 % of the top, 35 % of the bottom and 6 % of each side free of text and logos. Quote: "leaving roughly 14% of the top, 35% of the bottom" | verified | https://en-gb.facebook.com/business/ads-guide/update/video/instagram-story (the same figures on the localized page) |
| MC-22 | **A 250 px top / 340 px bottom Stories safe zone** (about 13 % and 18 % of 1920), which some third-party pages attribute to Meta and which the 2026-10-09 bible §3.13 used, conflicts with MC-21's 35 % bottom | contradiction | socialk.it and Hootsuite pages (search results, 2026-10-13); `final-spec.md` §3.13. **Do not use as a load-bearer:** read the live spec at brief time |
| MC-23 | **Meta.** Capture attention and deliver the key or brand message within the first 3 seconds; sound (music, voice-over, effects) raises engagement; use 4:5 for feed and 9:16 for Stories and Reels | verified | https://www.facebook.com/business/ads/automation/tailored-campaigns (served in Japanese to the fetcher) |
| MC-24 | **Briefs.** The IPA guide written with BetterBriefs and Mark Ritson says: one brief per problem; strategy settled before the brief; commercial, behavioural and attitudinal objectives linked; a briefing conversation to confirm a shared understanding | verified (industry-body summary) | https://commscouncil.nz/resources/client-guidance/better-briefs |
| MC-25 | **Murch's "rule of six"** for a cut: emotion 51 %, story 23 %, rhythm 10 %, eye-trace 7 %, 2D plane 5 %, 3D space 4 % (*In the Blink of an Eye*) | to-verify | Secondary only (nofilmschool.com, filmdaft.com); the book was not checked |
| MC-26 | **ffmpeg 9.0 filters.** `freezedetect`: noise tolerance `n` defaults to 0.001 and the minimum duration `d` to 2 s, so a 0.5 s rule needs `d=0.5`. `tile` lays out successive frames, with a default layout of 6x5. `select` keeps frames by an expression in which `n` is the frame index | verified | The installed binary's own help (`ffmpeg -h filter=freezedetect`, `tile`, `select`), ffmpeg 9.0 gyan.dev full build |
| MC-27 | **Figma samples rendered frame k at exactly t = k/30, and its `cubic:` easing equals CSS cubic-bezier.** The old ad's photo edge on frames 89–96 sat at 927, 669, 477, 339, 242, 173, 124 and 89 px, matching cubic(0.16, 1, 0.3, 1) evaluated at k/30 to the pixel; sampling at frame centres would give 789, 565 and so on. The per-frame shares in §3.3 also reproduce the critics' measurements (R1M3, R1Q10, R1Q1) | measured (2026-10-09) | `journal.jsonl` judge:build result; `final-spec.md` §3.3 |
| MC-28 | **Plugin typings 1.141.0:** <br>- blur effects are `LAYER_BLUR` or `BACKGROUND_BLUR` with `blurType` `NORMAL` or `PROGRESSIVE`, so there is no directional or motion blur;<br>- the keyframe property fields are the list at :6083–6114 (transforms, size, radii, stroke and border weights, stack spacing and padding, grid gaps, opacity, path trims), with no shear, 3D or per-glyph text;<br>- the video export settings (MP4, GIF, WEBM) have no audio member;<br>- the export encodes the whole top-level frame across the animation's duration | verified | `node_modules/@figma/plugin-typings/plugin-api.d.ts` v1.141.0 :4375–4412, :4621–4628, :6083–6114, :5205–5317 (no "audio" anywhere in the file), :9047 |
| MC-29 | **The video export renders the end frame:** a 14.4 s timeline at 30 fps produced 433 frames (f0–f432, 14.433 s). Trim with `-frames:v 432` | measured (2026-10-09, r0 to r3) | `journal.jsonl` render and critic:qa results (R1Q14, R2Q7); the r3 fixer |
| MC-30 | **ffmpeg input seek** `-ss (k+0.5)/30` returns frame k+1, because frames before the seek point are dropped. Cut stills by index (`select=eq(n\,k)`) or seek to (k − 0.25)/30 | measured (2026-10-09) | `scratchpad/motion/tool-findings.md`; the r1 fixer |
| MC-31 | **Corner radius clamps at min(W, H)/2.** When WIDTH and HEIGHT run on different curves, a "circle" renders as a stadium (chord 198–215 px against 111 for a true circle) | measured (2026-10-09) | `journal.jsonl` R3Q3 |
| MC-32 | **Figma's video export does not progress while the Figma window is minimized** (the plugin stalled for about 40 min) | measured (2026-10-09; environment) | `tool-findings.md` |
| MC-33 | **Keying a layer's t=0 OPACITY rewrites its base opacity,** so `figma_export_node` of a layer that starts invisible renders 1 × 1 | to-verify | Seen by the S3 builder on 2026-10-09 (`tool-findings.md`). The 2026-10-13 live probe did not reproduce the general case with a HEIGHT key; OPACITY itself is untested |
| MC-34 | **Per-frame share table** (§3.3) for the listed curves at N = 3 to 30 frames | measured (computed) | `skills-work/curves.cjs`; valid given MC-27 |
| MC-35 | **Read time** = max(5/6 s, 0.3 s × words), counted from fully legible to covered; numbers and prices count as words; the CTA is held for at least 2.5 s | decision | Derived from MC-15 (20 cps is about 0.27–0.3 s per word), MC-16 (5/6 s minimum), MC-17 (238 wpm is about 0.25 s per word) and the run (R1D10: 0.63 s for 2 words read as rushed; the bible's CTA rule) |
| MC-36 | **Offsets inside a stagger group are 2 frames or more at 30 fps.** 1-frame offsets read as colour fringes on one object; separate gestures may start 1 frame apart | decision | The judge:craft result (2026-10-09); `final-spec.md` Appendix B; consistent with MC-04's short offsets |
| MC-37 | **Blur on any edge moving faster than about 150 px per frame:** the peak on the fastest frames, a radius of about 5–8 % of the per-frame step there, back to 0 before the element must read sharp | decision | `final-spec.md` Appendix B (the 150 px rule); R3Q4 (14 px on 468 px strobed, fixed at 24 on 296 px), R3Q5 (12 px on 458 px, fixed at 32), R3Q2 (peak out of phase) |
| MC-38 | **Cut pairs:** a jump at frame k is two LINEAR keys, the old value at k/30 − 0.025 and the new at k/30 − 0.005; never HOLD | decision | `final-spec.md` §3.3; it depends on MC-27 |
| MC-39 | **Choose a tempo where one beat is a whole number of frames** (fps × 60 / BPM is an integer): at 30 fps that is 60, 72, 75, 90, 100, 120, 150 or 180 BPM; at 24 fps 60, 72, 80, 90, 96, 120, 144, 160 or 180 | decision | Arithmetic; the run used 100 BPM = 18 frames per beat |

**Facts that are not claims** (the repository's own behaviour, already registered or in code):
- motion is a gated beta, and animating the top-level frame is refused [C-115];
- video export formats and fps, and a still showing only the resting state [C-116];
- `frames` is capped at 12 per call (`MAX_FRAMES` in `src/server/tools/motion.ts`), and stills need ffmpeg on the server machine;
- animation styles cannot be applied through figma-mcp (the `MOTION` topic).

---

## 8. Recommendations for figma-mcp (not edits)

1. **A keyframe lint tool, `figma_check_motion { nodeId }`.** It mirrors `figma_check_layout`. From the keys alone [MC-27], with no render and no ffmpeg, it reports:
   - pops (A1, A2);
   - specks at guard frames (A3);
   - off-grid keys and HOLD (A4);
   - offsets under 2 frames (A5);
   - peaks off the beat, given a `bpm` (A6);
   - symmetric punches (A7);
   - blur out of phase or undersized (A9);
   - W ≠ H while round (A10);
   - dead spans, as the per-frame sum of motion under a threshold (B2 approximated);
   - the timeline length against the last key.

   This is the only check that works for every client, including one with no shell. It also catches the largest finding class (15 of 73) before any render.
2. **Review sampling without re-rendering.** Every `figma_export_video` call re-renders the whole timeline [MC-28], and the 12 stills per call make frame-by-frame review costly. Two options: cache the last render and serve `frames` from it, or let one call return a contact sheet and frame ranges (a sheet plus close-ups of N frames around given times), with stills cut by frame index [MC-30].
3. **Trim on export.** Offer an option to drop the extra end frame, so the frame count equals duration × fps [MC-29].
4. **Revise the `motion` topic's verify step.** Keep the 12 fps GIF for UI micro-motion. For a piece, render MP4 at the delivery fps, pick `frames` per phase from the frames-to-check table, and name the minimized-window stall [MC-32].
5. **Entry prompts per `delivery.md`:** `animate_in_figma` and `storyboard_motion`, plus `critique_design` with `lens` (motion, design, qa, brief). Each must run in one agent as sequential passes. Parallel subagents are an optional speed-up only, which keeps the skill client-agnostic.
6. **Safe zones as data.** The `formats` section should tell the agent to read the placement's live spec at brief time [MC-21] [MC-22], not ship fixed pixel numbers.
7. **Audio.** Say plainly that Figma exports no audio [MC-28]. The beat grid is arithmetic, and the track is muxed downstream when the client has a shell.

---

## 9. Open questions

- MC-11 (speed graph wording) and MC-25 (Murch's weights) still need a primary source. Neither is a load-bearer here.
- MC-33: a live probe should key `OPACITY` from 0 at t = 0 on a fresh layer, then read `opacity` and run `figma_export_node`.
- Exporting at `width: 1440` from a 1080 × 1920 frame to meet MC-21: does Figma re-render vectors and type sharply at the export width, or upscale a raster? To-verify, with a probe render compared at 100 %.
- Whether the "frame k at k/30" result [MC-27] also holds at 24 and 60 fps exports (measured only at 30).
- Instagram Reels, TikTok and YouTube Shorts safe zones were not researched. The skill should treat every placement's spec as live data.
