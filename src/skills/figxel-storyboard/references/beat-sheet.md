# Brief, directions and the beat sheet

Stages 1–3 are text and arithmetic. They fix the message, the read times and the rhythm while changing them is free.

## 1. The brief
Write it before the first node, as one text block on the Storyboard page (figma_create_from_spec). Start from the design skill's brief (figma_get_guide { topic: "design", section: "brief" }): one problem, one brief, the strategy settled before it [C-236]. Add the motion fields:
- **Message:** one sentence with no "and".
- **Placement:** where it plays; aspect, delivery size, duration, and an fps Figma exports (12, 24, 30 or 60 for MP4 [C-116]).
- **Placement fields:** frame 0's job, brand by, the end structure, where stillness is allowed, and the cut grammar (the motion skill's `formats` section). Their defaults hold only for feed and story ads: the brand or key message within the first 3 s [C-235], so frame 0 opens on the hook; an end card. A title, a loop, an icon, a brand film or a broadcast spot sets each from its own brief.
- **Safe zones:** given by the brief, or read from the placement's current spec now, with the figures, the source and the date. Where two sources disagree, keep text, logo and CTA clear of both. With no way to read the page: the figures registered here with their date, marked "not re-read" (Meta's Stories figures, read 2026-10-13 [C-233]); for any other placement a conservative area you state, and "safe zones unverified" first in the report. Never stop to ask.
- **Sound:** on or off, and whether the piece must read without it. Figma exports no audio [C-184], so music is planned on the tempo grid and joined downstream.
- **Brand by** its time and the **CTA**, when there is one, readable for 2.5 s or more [C-241].
- **Mandatories:** brand, product, offer, legal lines, each with its reason.
- **Success:** the checks it implies (read times, brand time, frame count).

Inventory before you decide: figma_get_design_context on the brand's existing work, figma_get_motion_context on anything that already moves (its curves and timings are givens to match), figma_get_fonts for the families that load. A brand, a system or a reference the user gave is decided; the directions vary only what it leaves open.

## 2. Directions — real alternatives

### Card 0, the obvious version
Before any real card, write the piece this brief would get by default, in concrete terms: what frame 0 shows, the device (for example: the tagline word by word on a brand-colour field, then the logo and the CTA), the transitions, the curves, the palette and the type. It is your own one-pass answer, written down so every real card can be measured against it. It goes on the Storyboard page beside the cards.

### The cards
Write 2–3 directions, one after another, each from a different origin, the design skill's three (figma_get_guide { topic: "design", section: "directions" }): a principle from the subject's world, the message, or the audience's moment. Then name the device that carries each: type-led, shape-led, camera-led, object- or character-led, product- or data-led. NN/g's parallel design makes three or more alternatives and merges the best [C-216]; a piece gets two or three.

The cards differ from card 0 and from each other in their device and in at least two of: the idea, the type, the composition, the colour, the imagery. A version of the same idea in another palette is not a second direction.

Each card is a frame on the Storyboard page (text and swatches): name · the idea in one sentence · its origin · the one device that carries it · why it serves the message · frame 0 · the end · type and colour, each with where it comes from (the subject, or the brand's style or variable id) · its risk · its cost (scenes, animated layers, tracks).

### The originality check
Before judging, answer for every card:
1. **Swap test.** Put a competitor's name on the card. If nothing else would have to change, it is generic: revise it.
2. **Card 0.** It differs from card 0 in its device and in where its palette and type come from. If not, revise it.
3. **Looks.** Compare its colours and type with the design skill's cluster table (section `tells` of the design skill) [C-219] and write "matches cluster N on k of m features" for any match.
4. **Motion habits** [C-209] [C-260]: the same fade and small rise on most layers; one arrival and one exit curve on everything; a slideshow rhythm of build, freeze and exit; a blank frame 0 the brief did not ask for; spring pops; a logo fading in on black.
5. **Verdict.** A match is either a brand given, with its evidence (the style, variable or file it came from, or the user's words, quoted), or the card is revised until its look and its device come from this subject: its materials, its process, its words, its place. The 2026-10-09 test run, an ad for a fictional brand, matched two of those clusters; its palette was that brand's own, so it was a given, but no lens said so [C-208].

### Judging
Four passes over the cards, one after another, each starting by re-reading the brief, each scoring every card 1–10 with one line of reason. Anchors: 9–10, nothing a senior designer would change; 8, minor doubts; 7, one real weakness; 5–6, it misses a line of the brief; 4 or less, it fails the message.
1. **Craft:** composition, type, the motion vocabulary, how it reads at the delivery size.
2. **Effectiveness:** the brief's own success lines: the message, the brand time, the CTA.
3. **Originality:** the check's answers: how far, and why, it stands from card 0 and the defaults.
4. **Buildability:** pass or fail, not a score: every mechanism measured or worth a probe; the layer and track count within the gear's budget (section `bible`). A fail is revised or dropped; buildability never ranks a cheaper card above a better one.

Choose a spine (the best combined craft, effectiveness and originality among the cards that pass), graft the best parts of the others [C-216], and write restraint rules: how many devices may share a stretch, how many accents, which moves never happen. Close with one decision line: chosen, why, grafted, rejected.

## 3. The tempo grid
Pick the delivery fps, then a tempo at which one beat is a whole number of frames: fps × 60 / BPM is an integer [C-244]. At 30 fps that is 60, 72, 75, 90, 100, 120, 150 or 180 BPM; at 24 fps 60, 72, 80, 90, 96, 120, 144, 160 or 180. Eighths are whole frames too only at 60, 75, 90, 100, 150 and 180 BPM at 30 fps, and at 60, 72, 80, 90, 120, 144 and 180 at 24 fps. The brief's tone chooses. A piece without music still uses the grid: it is the rhythm the cuts and hits land on.
- **A supplied track:** its BPM and the time of its first downbeat set the grid; pass them as `bpm` and `beatOffset` to figma_check_motion, round every hit to the nearest frame, and keep the default tolerance of 1 frame (`beatToleranceFrames`).
- **A voice-over-led spot:** the hits go on the frames where the words land, not on a BPM. Before the recording exists, time the script at a speaking rate you assume, write the rate in the brief as an assumption, and retime at the animatic when the recording arrives.

The arithmetic, at 30 fps and 100 BPM: a beat is 18 frames (0.6 s), an eighth 9 frames, a bar of four beats 72 frames (2.4 s).

| bar.beat | t (s) | frame |
|---|---|---|
| 1.1 | 0.0 | 0 |
| 1.2 | 0.6 | 18 |
| 1.3 | 1.2 | 36 |
| 1.4 | 1.8 | 54 |
| 2.1 | 2.4 | 72 |

## 4. The beat sheet
One row per hit, with these columns: bar.beat · t (s) · frame · hit · on-screen copy · words · readable from–to · device.
- Frame 0 does what the brief's frame-0 field says.
- Major hits on downbeats; secondary hits on beats, on whole-frame eighths, or on the nearest frame.
- Read time: max(5/6 s, 0.3 s × words), numbers and prices counted as words [C-241]. "Readable from–to" runs from the frame the entrance finishes to the frame the exit starts, so it is shorter than the panel.
- The brand fully visible by its time; the CTA, when there is one, readable for 2.5 s or more.
- The end structure the brief names: an end card (with a breath before it if planned: nothing new arrives, only drifts move), a loop seam, or a held last pose.

## 5. Into panels
The rows become the panels of figma_create_storyboard, one panel per shot or beat, back to back from 0:

```
figma_create_storyboard { title: "<piece>", aspect: "9:16", fps: 30, bpm: 100, panels: [
  {"durationS": 2.4, "title": "<name>", "beat": "<story beat>", "onScreen": "<exact words>", "action": "<what moves>", "camera": "<framing and move>", "transition": "<how it leaves, and its motive on screen>", "audio": "<cue>", "styleframe": true},
  …
] }
```

- `styleframe: true` on the 3–6 key panels gives each an empty full-size frame and a `styleframeId`.
- Durations snap to whole frames by default (`snapped` lists the changes); `snap: "beat"` snaps to whole beats.
- Read `offBeat` and `readTime` in the result and fix both before going on: move a start onto the beat, cut words, lengthen or split a panel, or write why an off-beat start is meant.
- If the call is refused as not yet verified in this editor, build the board by hand (section `boards`).

Then the board itself: figma_get_guide { topic: "storyboard", section: "boards" }.
