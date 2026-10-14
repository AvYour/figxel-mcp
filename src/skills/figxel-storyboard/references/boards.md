# Boards — panels that are decisions

A panel records a decision: what the viewer sees, reads and hears in that span, and how it hands off to the next. It is not an illustration. Panels carry the visuals, the action, the camera and the transitions, the timing and the words, numbered in order [C-227].

## What figma_create_storyboard builds
A wrapper `Storyboard / <title>` at an empty spot (`pageId` for the Storyboard page): a header with the meta line (aspect, fps, BPM, duration, panel count), then one card per panel, `Panel nn · m:ss.s`, holding a clipping thumbnail at the aspect and the caption rows. The result gives `storyboardId`, `durationS`, `durationFrames`, and for each panel `thumbId`, `captionIds`, `startS`, `endS`, `startFrame`, `endFrame`, `bar` (with `bpm`), `words`, `readOk` and, for a styleframe panel, `styleframeId`. Text follows the file's text styles when it has them. The whole board is one undo step.

The duration caption is the plan. Someone who edits "1.2 s" on the canvas retimes that panel, and the animatic reads the caption, not the original call.

## Captions
- `beat` — the story beat (hook, proof, offer, sign-off), not the music beat.
- `onScreen` — the exact words; they set the read time.
- `action` — what moves, and where it ends.
- `camera` — the framing (wide, close, detail) and the move (push, pan, none).
- `transition` — how the panel leaves, and the thing on screen that motivates it.
- `audio` — the music cue, a sound, or "silent".
- `notes` — what the build needs: a mechanism to probe, a constraint, a handoff that must hold.

Fill only the rows the piece needs; `captions` picks the rows when you want fewer.

## Thumbnails
Rough, grey and fast: a thumbnail decides composition (where the focal element sits, where the type sits, what the crop cuts), not finish. Draw into it with figma_create_from_spec { parentId: <thumbId>, spec }, sized to the thumbnail (216 × 384 is the 9:16 default):

{"type":"frame","name":"Sketch","width":216,"height":384,"layout":"none","children":[
  {"type":"rectangle","name":"Focal element","x":40,"y":88,"width":136,"height":168,"fill":"#8f8f8f"},
  {"type":"text","name":"Copy","x":24,"y":284,"width":168,"content":"The panel's words","fontSize":18,"color":"#1c1c1c"}
]}

Each thumbnail comes with a hint text (`hintId` in the result); delete it with figma_delete_nodes once the sketch is drawn. Show a move as its start and end poses, or as a line of travel, and say the rest in `action`. Mark the safe zone once on the first thumbnail if the brief has one. When a panel's styleframe exists, delete the thumbnail's Sketch frame (and its hint, if still there) before the snapshot: figma_import_image sets the thumbnail's fill, and a sketch left inside would cover it (section `animatic`, figma_get_guide { topic: "storyboard", section: "animatic" }).

## Every designed transition has a motive
A designed transition grows out of something already on screen: a shape that becomes the next frame, a direction of travel that carries over the cut, a colour that floods the frame, a word that turns into an object. Write that motive into `transition`. A hard cut on a beat needs no motive; what it carries on arrival is the cut grammar's call. A transition that is only decoration is removed. Count the devices per stretch against the restraint rules from the judging.

## The lists, before going on
- `offBeat` — a panel that starts off the beat grid, with `nearestBeat` and `offsetFrames`. Move it onto the beat, or note why the syncopation is meant.
- `readTime` — a panel whose copy needs more time (`needS`) than the panel has (`haveS`). The copy is legible for less than the whole panel, because the entrance and exit take frames, so leave room for both. Cut words before stretching time.
- `snapped` — durations rounded to frames or beats; check that the total still fits the brief.

Retime one panel by editing its duration caption: figma_set_text { nodeId: <captionIds.duration>, content: "1.5 s" }. Retime many by calling figma_create_storyboard again and deleting the old board by its id.

## A board by hand
When figma_create_storyboard is refused as not yet verified in this editor, build the same board with figma_create_from_spec { pageId: <Storyboard page>, spec }: a wrapper frame `Storyboard / <title>` with a horizontal, wrapping layout, then one card per panel. Compute each panel's times yourself, back to back from 0: start frame = round(start s × fps), last frame = the next panel's start frame − 1, and the read time from the words [C-241]; write them into the captions, and check the beat grid by hand (a start frame divisible by the frames per beat is on the beat). One card:

{"type":"frame","name":"Panel 01 · 0:00.0","layout":"vertical","gap":8,"padding":12,"background":"#ffffff","children":[
  {"type":"frame","name":"Thumb","width":216,"height":384,"background":"#e6e6e6","clipsContent":true},
  {"type":"text","name":"Time","content":"0.0–2.4 s · f0–f71 · 1.1","fontSize":14,"width":216},
  {"type":"text","name":"On screen","content":"The panel's exact words","fontSize":14,"width":216},
  {"type":"text","name":"Transition","content":"How it leaves, and its motive","fontSize":14,"width":216}
]}

Sketch into each Thumb as above. The styleframes are then frames you make at delivery size, named `SF nn · <title>` (section `animatic`), and the board's numbers are the plan the animatic checks.

## Exit gate
- figma_check_layout { nodeId: <storyboardId> } returns ok.
- One look at the whole board, figma_export_node { nodeId: <storyboardId> }: every panel reads at a glance, and the sequence tells the story without the captions.
- Every designed transition has a motive; the board's total matches the brief's duration.
