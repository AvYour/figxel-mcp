# Kinetic type — words that move and still read

Type is usually the message, so motion must never cost reading. Count the words before animating anything: each line needs max(5/6 s, 0.3 s × words) fully legible, from the frame its entrance finishes to the frame its exit starts; numbers and prices count as words [C-241]. figma_check_motion's `read_time` measures it from the keys.

## Choose the mechanism from what the words mean
One move on every line is a tell of generated motion; so is the same masked rise on every word. For each line, ask what the words do (insist, list, count, turn, arrive, answer) and pick the mechanism that does the same. The bible names the mechanism for each line, with its reason.

| Mechanism | When the words… | Build in Figma | Check |
|---|---|---|---|
| Scale contrast | insist, or one word outweighs the rest | the key word in its own text node; SCALE on it, or on its row for the whole line | `concentrated_step`, `near_size` at rest |
| Tracking | open up, breathe, settle | one text per letter in an auto-layout row with a fixed width and height; STACK_SPACING on the row, no TRANSLATION on its children; keep a TRANSLATION_X fallback until the probe shows the spacing animate | `read_time`; the probe's render |
| Cut-on | count, list, land on beats | each word switched on by an OPACITY cut pair on its beat [C-240] | `beat_offset` with `bpm`, `read_time` |
| Write-on | are drawn or signed: a mark, an underline, outlined lettering | a vector path with a stroke; PATH_TRIM_END (or PATH_TRIM_START) keys on it (live text cannot be trimmed: no per-glyph text [C-184]) | `roundcap_zero_trim`, `pop_in` |
| Replacement | change: a number counts, a word turns into another | the texts stacked in one place, swapped by cut pairs, each held for its read time | `read_time` per state |
| Position | move from one idea to the next | the line itself travels to its new place in the composition with TRANSLATION | `concentrated_step`, the safe zone over time (section `passes`) |
| Colour change | mark, select, warn | a key on the text's "fill:0" (a solid paint) | contrast of both colours [C-075] |
| Mask reveal | arrive from behind something | the text in a plain clipping frame (a FRAME that clips, no fill, no auto-layout), rising with TRANSLATION_Y while the frame stays put | the clip line on a real edge; no sliver left on the mask edge |

Split by meaning too: per word for a phrase that builds, per letter only for the word that carries the idea, a whole line as a block when the line is one thought. Inside a group, the offset between words or letters is 2 frames or more; one frame apart reads as a colour fringe on a single object [C-242]. Decide which word lands on the beat, and let the others lead into it.

Keep every word visible at rest and hide it only with keys, so figma_export_node still shows the composed line [C-116].

## Speed, blur and the beat
- Blur only the fastest frames of a fast move, scaled to the step [C-243], and none on any frame that must be read. Large blur on type turns it to mush.
- A punch peaks on its beat frame: the attack starts about 2 frames before the beat and the release is slower than the attack (section `easing`, figma_get_guide { topic: "motion", section: "easing" }).
- Exits follow the bible's type vocabulary: a line leaves the way its mechanism implies (a mask reveal sinks back behind its clip line; a cut-on cuts off). End an exit behind a clip line with an OPACITY guard as a cut pair, so no anti-aliased sliver stays on the mask edge.

## Figures, sizes and contrast
- Check the numerals in the chosen face at display size. Old-style figures made "10%" read "IO%" in the run [C-207]; when the face only draws old-style figures, set the numbers in a face that has lining ones.
- Two lines in one style are either the same size or clearly different: 56 px against 60 px read as a mistake [C-207].
- The smallest text follows the viewing size. On a phone, labels at 22–24 px on a 1080-wide story read at about 8 pt [C-207]; set `minTextSize` in figma_check_layout in frame pixels.
- Where type crosses a moving shape, the two differ in colour on every frame of the crossing; a plate of the type's own colour hides it.
- Dimmed lines that must still be read keep their contrast [C-075].

## Checks
- figma_check_motion { nodeId, fps }: `read_time`, `no_stagger`, `pop_in`, `vanish_mid_move`, `blur_off_speed`, and each mechanism's check above.
- figma_check_layout { nodeId, audit: ["craft"] } on each styleframe: `oldstyle_figures`, `near_size`, `min_text`.
- figma_review_video close-ups across every entrance and exit, so each letter's path can be seen frame by frame.
