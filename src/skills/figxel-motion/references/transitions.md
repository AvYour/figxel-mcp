# Transitions — recipes, continuity and restraint

A transition is where the idea shows, so it comes from the idea: a designed transition grows out of something already on screen (a shape that becomes the next frame, a direction of travel that carries over, a colour that floods the frame, a word that turns into an object). A hard cut on a beat needs no motive. These recipes are mechanics, not a menu; none is a default, and a piece uses few of them. The bible's cut grammar (section `formats`) says which changes are continuous moves and which are cuts on purpose.

## Continuity across a cut meant to read as one move
For a match cut, a push-through or a whip, check four things on the frames either side of the cut:
- **Speed:** take the per-frame zoom factor (for a pan, the step in px) of the last step before the cut and of the first step after it; the larger divided by the smaller stays under 1.10 [C-261]. ×1.32 into the cut against ×1.27 out read as one move; ×1.27 against ×1.08 read as a brake [C-258].
- **Direction and origin:** the move continues the same way, and a zoom keeps its origin.
- **Tone:** no frame's mean brightness steps by more than 20 of 255 across the cut frames [C-261]. A jump of about 59/255 read as a white flash; a tonal bridge brought the largest step to 9.2 [C-258].
- **Join:** a whip joins where the blur peaks, with the same direction and speed and matched brightness on both sides [C-230].

figma_review_video shows all four: close-ups starting a few frames before the cut, and `cuts` declared so the jump on the cut frame is expected while one a frame early or late is reported. A hard or smash cut is a change on purpose and is not held to these four.

## Recipes
| Transition | Build | Check |
|---|---|---|
| Match cut | the outgoing shape lands on the incoming shape's size, position and colour; the scenes swap on one frame with a cut pair on each container | the shared shape stays on screen 3 frames or more, and the two sides are identical on the swap frame; no reversal of size or direction inside one frame [C-259] |
| Push-through (zoom cut) | the outgoing container dives on an accelerating curve into the point of entry; the incoming one starts enlarged and blurred and decelerates | zoom rate and origin continuous; blur continuous across the cut; a tonal bridge where the two scenes differ in brightness. A scale about a point other than the layer's centre is a technical probe item: where the probe shows SCALE turning about the centre, a TRANSLATION on the same easing of (1 − s) × (the point − the centre) moves the origin |
| Whip | a symmetric move with a blur ramp peaking at the join; Figma's blur has no direction [C-184], so a slight stretch along the direction of travel (SCALE on that axis) carries the speed | 20 frames or more for a whip curve; same direction and speed both sides [C-230] |
| Iris or bloom | two or three circles stacked 2 frames apart, WIDTH = HEIGHT keyed together with CORNER_RADIUS = WIDTH/2; the content inside counter-translated so it stays put | never rely on the radius clamp [C-196]; cross the last corner while still fast, but land inside the frame so the landing is seen; blur scaled to the step [C-243] |
| Plate wipe | coloured plates crossing inside a clipping frame, 2 frames apart | a symmetric curve with blur, not a whip over a few frames; a plate never crosses type of its own colour |
| Mask reveal | text inside a plain clipping frame (no fill, no auto-layout), rising from below the clip line | the clip line sits on a real edge in the picture, or the letters are sliced by an invisible line |
| Morph (circle to rectangle to pill) | WIDTH, HEIGHT, CORNER_RADIUS and translation on one layer | W and H on the same curve while the shape must stay round [C-196]; start squaring while still growing; land on the beat |
| Hard cut | a cut pair on each container [C-240] | lands on its frame; what the incoming picture does on arrival (a settle, an accent, nothing) is the bible's call, and an unplanned dead hold after it reads as a slideshow |
| Cross-fade | OPACITY on both sides | reads as a prototype fade [C-260]; use it when dissolves are the piece's idiom, and then consistently |

Every container switch happens under full cover or onto an identical picture, by cut pairs on the container itself; write each handoff in the bible with the frame and what must hold on it.

## Motivation and restraint
- A designed transition with no motive on screen is decoration: cut it, or make it a hard cut on a beat.
- Count devices per stretch against the bible's restraint rules. A piece about calm may need one transition device in all; a piece about energy may earn more, but each still has a motive.
- Entrances and exits follow the transition and type vocabulary the bible declares, so the piece speaks one language.
