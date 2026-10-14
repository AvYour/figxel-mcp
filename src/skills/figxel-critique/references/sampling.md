# Sampling: how to see the work

Numbers first, pictures second. A check reads the document and cannot be fooled by a render; a render shows what no number can (an image that dissolves into its ground, a mark that reads as something else). A model's reading of a picture is not a measurement: one reported a card cut off at a frame's edge where the document showed 200 px to spare. So every finding's numbers come from a check or from figma_get_design_context, figma_get_node or figma_get_nodes_info, and the render decides only what it alone can see.

One sample per round. Re-sampling after every small fix spends renders and hides regressions; sample once, run every lens on that sample, fix, and sample again in the next round.

## A still design

1. **The checks.** figma_check_layout { nodeId: <wrapper or styleframe>, audit: ["craft", "tells"] }. Add `minTextSize`, the brief's floor in frame px, and `safeArea` ("x,y,width,height" in the frame's own coordinates, from the brief) only for a placement whose interface covers part of the frame; a web view passes none, and its fold is measured as the brief's success line says. Errors and warnings are findings as they stand; every info, craft and tells alike, is a question a lens answers.
2. **One view at a time.** A whole long page rendered at once is too small to judge: a 1440 × 5000 page capped at 1024 px shows 16 px body text at about 3 px. Render each view instead (the design skill's `finish` section): a page's sections, the hero first; a poster, a story, a slide or a styleframe whole.
   - The read: figma_export_node { nodeId: <view> } at the default cap, which one view fits.
   - The squint: figma_export_node { nodeId: <view>, maxSize: <long side ÷ 8> }: what reads first, and do the groups hold?
   The round's sample is the first view plus every view the brief's success lines name.
3. **Close-ups.** For a detail too small to judge, render the part itself, figma_export_node { nodeId: <the section or element> }. Look at every place a check flagged, and at the focal point.
4. **The numbers for a finding.** figma_get_design_context { nodeId } or figma_get_nodes_info { nodeIds } for positions, sizes, fonts and colours; figma_scan_text_nodes { nodeId } for every string. Write them into the finding's `measured`.

For a set of views (pages, slides, styleframes), compare their reads side by side for a repeated skeleton.

## A motion piece

The keys first, because they need no render:

1. **figma_check_motion { nodeId, fps, bpm }** with the delivery frame rate, and the tempo when there is one. Add `holds` for intended stillness (in seconds here) and `brandId` / `ctaId` to time the brand and the call to action. Fix every warning before rendering; the rules come from the findings of a measured test run.
2. **One render per round,** at the delivery frame rate, in job mode with your own id per round: figma_export_video { nodeId, format: "MP4", fps: <delivery fps>, jobId: "<piece>-r<n>" }. If it answers `status: "rendering"`, call figma_export_video { jobId: "<piece>-r<n>" } again to collect it; never start a second render while one runs. Job mode exists because a client that ends calls at about 60 s once took a running render down with the call. Keep the Figma window restored, not minimized: a minimized window stalled a render for about 40 minutes. Figma ends a render it has not finished in about 4 minutes with TIMEOUT: render the round again, at a smaller `width` if it repeats.
3. **figma_review_video on the file, in batches you can see.** The tool returns at most `maxImages` pictures inline (default 4, at most 8), in the order sheet, close-ups, stills, and the contact sheet always takes the first slot. Every picture is also written to disk, but a file on disk counts as seen only where the client can open files. So:
   - First call: figma_review_video { path, expectFrames, cuts, holds, closeups, maxImages: 8 } — the metrics, the sheet and up to 6 close-ups: windows around every transition, hit and handoff the bible lists; the spacing between tiles is the speed.
   - Then figma_review_video { path, stills, metrics: false, maxImages: 8 } with up to 7 stills per call, until every row of the frames-to-check table has been seen: frame 0, every hit, every resting state, the last frame (frame k is the timeline at k / fps).
   - Cap a round at 6 close-ups and 21 stills, four calls on one render; what does not fit goes to the next round, or two adjacent rows share one close-up.
   - `expectFrames`: the export's `expectedFrames`; Figma renders the end frame too, ceil(d · fps) + 1 frames in every format, so a 14.4 s timeline at 30 fps has 433.
   - `cuts` and `holds` (in frames here): where a cut or a stillness is intended, so they are not reported as defects.
   - The metrics flag freezes, one-frame flickers, flashes and jumps; their defaults come from the run's measured numbers.
4. **Layout over time** comes from numbers, not from stills: for each drift, push or anticipation, take the move's extreme offset from its keys (figma_check_motion { includeActivity: true } lists the fastest frames, the keys give the values), add it to the layer's rest bounds from figma_get_nodes_info, and compare with the bible's minimum spacing and the `safeArea`. Stills only confirm what the numbers flag. figma_check_layout { nodeId, audit: ["craft"] } sees the rest state alone; at least 7 of the run's collisions existed only in motion.

For an animatic, `cuts` are the panels' `inFrame` values from the latest figma_create_animatic result, panel 1 left out. For UI micro-motion, a small GIF is enough: figma_export_video { nodeId, format: "GIF", fps: 12, width: 480, frameIndices: [0, 6, 12] }.

## When ffmpeg is missing

figma_review_video needs ffmpeg and ffprobe on the machine that runs the bridge and answers UNSUPPORTED without them; the stills of figma_export_video need ffmpeg too. Then judge from figma_check_motion's numbers and from stills of the styleframes (figma_export_node), and say in the report that the motion itself was not seen.

## Before you write a finding

- The number came from a check or the document, not from the picture.
- The `where` names the layer and its id; for motion, the time and the frames.
- The `fix` is a tool call or an exact value someone could apply without asking you.

Evidence (claim ids, for maintainers): [C-070] [C-207] [C-248] [C-092] [C-212] [C-073] [C-246] [C-249] [C-197] [C-198] [C-193] [C-195] [C-194] [C-247] [C-206] [C-270]
