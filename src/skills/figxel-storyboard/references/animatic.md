# Styleframes, the technical probe and the animatic

## Styleframes (stage 5)
Styleframes are finished stills of the piece's key moments, in the final look, at delivery size: the stage where motion design settles how it looks before anything moves [C-229]. In the 2026-10-09 run, 14 of 73 review findings were visible on a still at rest, and a styleframe stage would have met them before any keyframe existed [C-206].

The direction was chosen in stage 2: these are 3–6 moments of that one direction, not new directions. Do not run the design skill's brief, directions or rounds again. Build:
- frame 0, as the brief's frame-0 field describes it;
- the hero moment;
- the offer or the proof;
- the end (an end card, a loop's seam, the last pose);
- one mid-transition frame: the hardest moment of the edit, caught halfway.

How:
- Set the system first, from the bible's conventions and the design skill's `system` section (figma_get_guide { topic: "design", section: "system" }); then build with the workflow's build loop (figma_get_guide { topic: "workflow", section: "build" }): one figma_create_from_spec per part.
- Build into each panel's `styleframeId` frame. When the board was built by hand, make the frames yourself at delivery size on the Storyboard page, figma_create_frame { name: "SF 01 · <title>", parentId: <page id>, width, height }. Name the layers as the bible will, because the motion build starts from these frames.
- Check at rest: figma_check_layout { nodeId, audit: ["craft", "tells"], safeArea, minTextSize }, with `safeArea` from the brief and `minTextSize` in frame pixels. Fix every error and warning, and answer every info.
- Look: the read and the squint of each frame (the design skill's `finish` section). Then run the still lenses (figma_get_guide { topic: "critique", section: "lenses" }); originality is judged on the set of styleframes against card 0 and the defaults in the originality check (section `beat-sheet`); it ran on the cards in stage 2 and runs again in review round 1 on the render. One round.
- Snapshot each into the board: first delete the thumbnail's sketch and its hint (figma_delete_nodes { nodeIds: [<Sketch id>, <hintId>] }), then figma_import_image { renderNodeId: <styleframeId>, nodeId: <thumbId> }. Run the import again after every styleframe fix.

## Technical probe (stage 6)
List every mechanism the boards rely on that nobody has measured in this file: spacing that animates on an auto-layout row, a radius morph while the size animates [C-196], a scale or rotation about a point other than the layer's centre, a trim with round caps, a blur ramp on type, a mask edge over a photo, and the frame grid and cut pairs when the delivery fps is not 24 or 30. Then probe each one:
1. A sandbox top-level frame at an empty spot on the Storyboard page, built with figma_create_from_spec { pageId: <Storyboard page>, spec }, holding the few layers the mechanism needs.
2. A one-beat plan on the sandbox, figma_set_motion_plan { nodeId, brief, beats } (the keyframe tools refuse a frame without one); then keys with figma_set_keyframes, and the numbers with figma_check_motion { nodeId }.
3. One short render with exact stills: figma_export_video { nodeId, fps, width: 540, frameIndices, jobId: "probe-<n>" }. When the move needs every frame, figma_review_video { path, closeups, maxImages: 8 } on the file.
4. Delete the sandbox by the ids your calls returned (figma_delete_nodes).

Exit: each mechanism works, or the bible names its fallback.

**Checkpoint.** When the brief asked to see the plan first, stop here: show the board, the styleframes and the probe's results, with the fallback of anything left unprobed (figma_select, figma_zoom_to), and wait for approval.

## The animatic (stage 7)
The animatic plays the panels at their planned times, so the pace is judged at speed while changing it still costs nothing [C-228].
1. figma_create_animatic { storyboardId } builds `Animatic · <title>`: a top-level frame with one plate per panel, each switched on and off by frame-exact cut pairs [C-240]. A plate shows the panel's styleframe, else its `source`, else the thumbnail. `burnIn` labels each plate with its panel number and title (the default; "full" adds its time, frames and captions); `dissolveFrames` applies only where a panel's transition caption starts with "dissolve"; `drift: true` adds a slow push so a held plate is not a freeze.
2. Render it small at the delivery fps in job mode. The result's `render` line is the call, for example figma_export_video { nodeId: <animaticId>, fps: 30, width: 540, jobId: "animatic-<title>" }. When it answers status "rendering", call figma_export_video { jobId } again later; never start a second export meanwhile.
3. figma_review_video { path, cuts, expectFrames, maxImages: 8 }, with `cuts` = the `inFrame` of every panel after the first, from the latest figma_create_animatic result (never the board's first `startFrame` values, which go stale once captions are retimed), and `expectFrames` from the animatic's `expectedFrames`. Read the contact sheet as a strip of the piece; the metrics say whether each declared cut lands on its frame.
4. Judge at speed, and write each answer as a number in frames or seconds: does every panel hold long enough to read; does the brand show by its time; does the CTA hold; does the planned end read; does any stretch drag or crowd? With a music track, each panel's `inFrame` should sit within a frame of one of its beats.
5. Retime by editing duration captions (figma_set_text on `captionIds.duration`), delete the old animatic by its id, and run figma_create_animatic again. Retime here, never after the build: after the passes the same change costs keys on every layer. After a checkpoint's approval, every retime goes in the report.

**When figma_create_animatic is refused** as not yet verified: build one by hand. A top-level frame at the delivery aspect on the Storyboard page; one plate per panel inside it, figma_import_image { renderNodeId: <styleframe or thumbnail>, parentId: <animatic frame>, x: 0, y: 0, width, height }; then a plan on that frame, figma_set_motion_plan { nodeId, brief, beats } with one beat per panel, and one figma_set_keyframes per plate, its OPACITY switched on at the panel's first frame and off after its last by cut pairs [C-240] (plate 1 starts on), with `timelineDuration` the board's total. Take the panels' frames from the current captions. Or skip the animatic, check the timing on the board's numbers, and say so in the report.

When the account has no Motion (UNSUPPORTED), skip the animatic: check the timing on the board's numbers, say so in the report, and deliver the styleframes [C-115].

## Exit gate
Pacing, read times, brand time, CTA hold and the planned end work at speed; the board's captions and the animatic agree; the styleframes are snapshotted into the board. Next: section `bible` (figma_get_guide { topic: "storyboard", section: "bible" }).
