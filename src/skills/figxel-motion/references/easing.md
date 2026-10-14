# Easing — roles for video, checked frame by frame

What the eye reads is spacing: how far an edge travels between one frame and the next. Figma samples frame k at exactly k/fps and its `cubic:` is the CSS curve [C-193], so the spacing of every move can be computed from its keys before anything renders. figma_check_motion does that computation; this section is how to choose curves it will pass.

## The pop line

A move pops instead of moving when one unblurred, uncovered frame carries 40 % or more of its travel, or when an unblurred step passes about 150 px. The 40 % is figma_check_motion's default for `concentrated_step`, calibrated on the run's findings [C-246]; the 150 px is the `strobe` limit [C-243]. Every other section points here. A brief that wants a smoother piece may pass a lower `thresholds.stepShare` on every figma_check_motion call; say so in the bible.

## The per-frame share
The largest share of a move's travel that lands in a single frame, for a move lasting N frames [C-245]:

| Curve | 3 | 5 | 8 | 10 | 15 | 20 | 30 |
|---|---|---|---|---|---|---|---|
| expo-out `cubic:0.16,1,0.3,1` | 90 % | 75 % | 58 % | 49 % | 36 % | 28 % | 19 % |
| emphasized decelerate `cubic:0.05,0.7,0.1,1` | 89 % | 78 % | 68 % | 62 % | 52 % | 45 % | 35 % |
| standard `cubic:0.2,0,0,1` | 73 % | 50 % | 35 % | 34 % | 23 % | 19 % | 13 % |
| ease-in `cubic:0.7,0,0.84,0` | 90 % | 75 % | 58 % | 49 % | 36 % | 28 % | 19 % |
| emphasized accelerate `cubic:0.3,0,0.8,0.15` | 70 % | 52 % | 37 % | 32 % | 23 % | 18 % | 13 % |
| in-out `cubic:0.65,0,0.35,1` | 70 % | 50 % | 29 % | 25 % | 19 % | 14 % | 9 % |
| whip `cubic:0.83,0,0.17,1` | 81 % | 66 % | 36 % | 33 % | 33 % | 22 % | 17 % |
| soft `cubic:0.45,0,0.55,1` | 56 % | 35 % | 22 % | 18 % | 12 % | 9 % | 6 % |
| `cubic:0.7,0,0.3,1` | 74 % | 54 % | 31 % | 27 % | 22 % | 16 % | 11 % |

How to use it: share × travel in px = the biggest step. Read across the row of the curve you chose to the shortest span under the pop line, and check that step against 150 px. When the span the beat allows is shorter, use a gentler curve, blur on the fastest frames [C-243], or cover (the edge is behind something, or off the frame). In the run, 15 of 73 findings were this one fault [C-206].

An accelerating curve carries its biggest step on its last frame. On an exit that ends on screen, that last step is the vanish: a 5-frame ease-in still has 75 % of the travel left for its final frame.

The table is measurement, not a menu: the curves in it are common ones, and a piece's own curves need not be among them.

## Roles and curve families
A role says what a move is doing; a family says the shape its curve takes. Within a family, the brief's energy picks the strength: a calm piece takes the gentle end with longer spans; an energetic one the strong end, with blur where the steps grow. Then the table, or figma_check_motion, says whether the span passes.

- **Decelerating**, strong to gentle: expo-out, emphasized decelerate, standard.
- **Accelerating**: ease-in, emphasized accelerate.
- **Symmetric**, gentle to strong: soft, in-out, `cubic:0.7,0,0.3,1`, whip.
- **LINEAR**: drifts, holds and cut pairs.
- **Hand-keyed**: punches and overshoots, written key by key.

| Role | Family | Choose by |
|---|---|---|
| Arrival | decelerating | strength from the energy; the shortest span under the pop line, or blur on its first frames |
| Exit behind cover or off the frame | accelerating | only when the last visible frame is covered, blurred or already small |
| Exit that ends in view (a close, a collapse, a trim) | symmetric, gentle end | at a tenth of its size or less on its last visible frame |
| Move across the screen | symmetric | strength from the energy; a whip only over 20 frames or more |
| Punch on a beat | hand-keyed attack and release | the attack starts about 2 frames before the beat, so the peak lands on it and holds about 2 frames; the release is slower than the attack |
| Overshoot accent | hand-keyed: past rest, back under it by less, rest | the amounts from the energy; as many as the bible's restraint rules allow; a stock back-ease or spring is never the default |
| Settle, dim, blur ramp | symmetric, gentle end | |
| Drift, hold | LINEAR | a hold still moves a little (`dead_span`), unless the bible declares it |
| Cut | LINEAR cut pair | never HOLD [C-240] |

Shape, not symmetry: a punch that rises and falls at the same rate has a one-frame peak and reads as a twitch (`one_frame_extreme`); a punch that starts on its beat peaks after it (`beat_offset` with `bpm`). An overshoot approached on a long decelerating tail stalls at the apex, then drops a second time: give it a shorter span or a gentler curve into the apex.

Name the roles once as tokens in the build bible, each with its exact string and the line of the brief that chose it, and use only those tokens. A curve set carried over from another piece, a measured test run's included, is a house style: choose again for each brief.

## UI micro-motion
A product screen is the other mode, with its own scale.
- Use the product's motion tokens when it has them. Material 3, for example, gives durations of 50–1000 ms and curves such as standard (0.2, 0, 0, 1), emphasized decelerate (0.05, 0.7, 0.1, 1) and emphasized accelerate (0.3, 0, 0.8, 0.15) [C-224].
- Carbon separates productive motion (subtle, for task flows) from expressive motion (rare, for moments that matter), with durations from 70 to 700 ms that grow with the distance travelled, and exits that accelerate [C-225].
- Without tokens, read the motion the product already has (figma_get_motion_context on its other frames) and match it; with nothing to read, derive the duration from the distance travelled [C-225] and the family from the role, and state the choice in the handoff.
- These tokens are tuned for short UI moves. On a full-screen video move they pop: emphasized decelerate puts 52 % of a 15-frame move into one frame [C-245]. Use video roles for a piece.
- Motion that an interaction triggers can be turned off by the user's setting unless it is essential [C-223]: state in the handoff what the reduced version is (an instant change, or opacity only).
- Verify with a small GIF: figma_export_video { nodeId, format: "GIF", fps: 12, width: 480, frameIndices }.
