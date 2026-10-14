# Passes — blocking, curves, polish

Build a piece in three passes over the whole timeline, not scene by finished scene: shaping the curve of a move that sits in the wrong place is wasted work, and a move curved before it was ever posed looks soft and undecided. Each pass ends with figma_check_motion; render at most once per pass, in job mode.

Before the first pass: the build bible exists (figma_get_guide { topic: "storyboard", section: "bible" }), and the piece's top-level frame stands at an empty spot on the target page with its plan stored (figma_set_motion_plan { nodeId, brief, beats }): the keyframe tools refuse a frame without one.

## 1. Blocking — every scene built, then poses on the beats
- **Build all of it before the first key.** Clone each scene's styleframe into the piece, figma_clone_node { nodeId: <styleframe>, parentId: <piece frame>, x: 0, y: 0 }, rather than building it a second time: a rebuild drifts from the frame that was critiqued [C-207]. Build a scene that has no styleframe from its panel and the bible's package, with figma_create_from_spec { parentId: <piece frame>, spec }. Every layer sits in its visible resting layout [C-116]; name layers exactly as the bible does.
- **Record the ids while nothing moves.** figma_get_node { nodeId: <scene>, depth: 4 } on each scene, and keep those ids for every later call: inside an animated frame, a listed id can turn out to be temporary [C-199].
- Key the poses at the beat frames from the beat sheet: each layer's tracks in one figma_set_keyframes call, keys at k/fps, the first key of every track at t = 0. Pass `timelineDuration` on the first call so the timeline has the bible's length from the start.
- Between poses use LINEAR holds; every jump is a cut pair [C-240]; no shaped easing yet.
- Check: figma_check_motion { nodeId, fps }, which takes the tempo from the plan. Clean of `unrendered_extreme`, `off_grid`, `hold_easing` and `first_key_late`.
- Look: one render with stills on the beat frames, figma_export_video { nodeId, fps, frameIndices, jobId: "<piece>-block" }. Each beat frame matches its panel on the board.

## 2. Curves — spacing
- Give every move its easing role from the bible's tokens (section `easing`, figma_get_guide { topic: "motion", section: "easing" }).
- For each move, travel in px × the curve's share at its span = its biggest step [C-245]. At or over the pop line (section `easing`): lengthen the span, soften the curve, blur the fastest frames [C-243], or cover the edge.
- Overlap: secondaries lag the lead by 2–4 frames, stagger offsets are 2 frames or more [C-242], and no group stops on one frame.
- Anticipation where weight matters: a small reverse key just before the move.
- Across every cut the bible marks as continuous (a match cut, a push-through, a whip), the speed matches [C-261] (section `transitions`).
- Check: figma_check_motion until it has no warnings outside the plan's `accept`, in particular `concentrated_step`, `pop_in`, `vanish_mid_move`, `strobe`, `blur_off_speed`, `one_frame_extreme`, `arrival_not_held` and `beat_offset`. Each finding names the layer, field and frames, and its `fix` often gives the replacement easing with the recomputed number.

## 3. Polish — life and finish
- Settles on secondaries; blur on every edge faster than about 150 px per frame, peaking on the fastest frames at about 5–8 % of the step and back to 0 before the element must read sharp [C-243]. The blur key goes on the blur's own effect index ("effect:<i>:RADIUS"), which need not be 0 when the layer has a shadow too.
- Stillness: every stretch the bible declares still goes in the plan's `holds`; anything else still for 0.5 s or more gets a drift.
- Accents: the planned overshoots and punches, hand-keyed, peaking on their beats, no more than the restraint rules allow.
- Tonal bridges where a continuous cut changes brightness [C-261]; overscan on any full-bleed plate that scales below 1, by at least (1 − s) × width / 2 on each side.
- The planned end: a settled last frame, or a loop seam (section `formats`).
- Check: figma_check_motion { nodeId, fps } ok: true, with every info answered and `dead_span`, `read_time`, `brand_late` and `cta_short` clean. It applies the plan's `bpm`, `holds`, `brandId` and `ctaId`, so pass none of them looser. A finding the brief intends (a still open, a hard-cut grammar, a loop) is never left standing: store the plan again with it in `accept` and its reason, and name it in the report; the delivery render lists it too. figma_check_layout { nodeId, audit: ["craft"], safeArea, minTextSize } on the resting state.

## Holds in two units
The two tools take holds in different units, and neither reads the other's shape:
- figma_check_motion: `holds: [{ from: 10.4, to: 10.9 }]`, in seconds.
- figma_review_video: `holds: [{ fromFrame: 312, toFrame: 327 }]`, inclusive frames.
Store holds in the bible in frames, and convert for the plan's `holds` and figma_check_motion: s = frame / fps (and frame = round(s × fps) the other way).

## Layout over time, from numbers
figma_check_layout sees only the rest state. For each drift, push, anticipation and overshoot: take the move's extreme offset from its keys (figma_check_motion { includeActivity: true } lists the fastest on-screen move per frame), add it to the layer's rest bounds from figma_get_nodes_info, and compare with the bible's minimum spacing, the margins and the `safeArea`. A layer that comes closer than the spacing step to another, or leaves the safe area, is a finding with its frame; stills in review confirm it.

## Then review
Hand over to the critique skill for the rounds (figma_get_guide { topic: "critique", section: "motion-checks" }): one render per round at the delivery fps with `jobId: "<piece>-r<n>"`, then figma_review_video on the file in batches of what you can see, with close-ups and stills from the bible's frames-to-check, the declared `cuts` and `holds`, and `expectFrames`.

## Fixing without breaking
- Edit only the tracks a finding names, and send all of a layer's changed tracks in one call; a batch of fixes across layers goes in one figma_batch of set_keyframes steps.
- After any fix, re-check the frames around it and the layers it touches: in the run, fixes caused 4 new issues in round 2 and 3 in round 3 [C-206].
- Never rebuild a scene that is mostly right.
