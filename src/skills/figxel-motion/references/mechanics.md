# Motion — keyframe animation on the timeline

Motion is animation along a frame's timeline (Figma's Motion beta). It is not a prototype transition between frames (topic "prototype"). Figma enables it per user [C-115]: when a motion tool answers UNSUPPORTED, stop — tell the user and deliver the static design; do not retry, and do not fake it with prototype transitions.

## Rules
- The timeline belongs to a top-level frame, and the layers inside it are what move: key a child, never the top-level frame itself [C-115].
- Figxel writes tracks key by key with figma_set_keyframes, one field per track [C-183]. Animation styles are listed by figma_get_motion_context but Figxel cannot apply them yet.
- Times are seconds. Values are strings by field: a number "0.5" (OPACITY, ROTATION, TRANSLATION_X …), a vector "10,20" (TRANSLATION_XY, SCALE_XY), a colour "#ff000080" ("fill:<i>", "stroke:<i>", an effect's COLOR). Only a SOLID paint animates [C-115].
- Easing names are Figma's: EASE_IN_AND_OUT, not EASE_IN_OUT [C-115]. Also LINEAR, EASE_IN, EASE_OUT, the _BACK forms, GENTLE, QUICK, BOUNCY, SLOW, HOLD (keeps the old value until its key, then steps on the frame at the key [C-189]; use a cut pair instead, below), "cubic:x1,y1,x2,y2" and "spring:<bounce 0-1>". The easing written on a key is the curve the value follows on its way to that key from the one before.
- TRANSLATION and ROTATION add to the resting transform (0 = unchanged; positive ROTATION turns counter-clockwise); SCALE multiplies it (1 = unchanged). OPACITY and the other fields replace the value.
- WIDTH and HEIGHT do not animate on a group or a vector: use SCALE_X / SCALE_Y.
- A key past the timeline's end makes the timeline grow to reach it; nothing makes it shrink except `timelineDuration` given on purpose, since every layer in the frame plays on the same timeline.

## What the frames are made of (measured)
- **Frame k of an export shows the timeline at exactly t = k/fps, and `cubic:` is the CSS cubic-bezier curve** (measured on MP4 at 24, 30 and 60 fps and on a 12 fps GIF) [C-193]. So every frame's value follows from the keys before any render: figma_check_motion computes it. Prefer `cubic:` and LINEAR; the named presets and springs are only approximated by the check.
- **Keys belong on the grid.** A key between two frames is never rendered as written, and a rounded time drifts: 2.467 s lies just after frame 74 at 30 fps (74/30 = 2.4667), so a jump keyed there shows a frame late. Put keys at k/fps.
- **A jump is a cut pair:** two LINEAR keys, the old value at (k − 0.75)/fps and the new value at (k − 0.15)/fps, so frame k − 1 shows the old value and frame k the new one. At 30 fps that is k/30 − 0.025 and k/30 − 0.005. Never HOLD [C-240].
- **The render includes the end frame:** it ends on the first frame at or after the timeline's end, so d seconds at f fps gives ceil(d · f) + 1 frames in every format: 14.4 s at 30 fps gave 433, 1.2 s at 12 fps gave 16. Figma keeps d to the microsecond, so a timeline meant to end exactly on a frame can land a hair past it and render one frame more; end it a hundredth of a frame short [C-194]. `expectedFrames` counts it.
- **Corner radius clamps at min(W, H)/2.** A circle whose WIDTH and HEIGHT run on different curves renders as a stadium; key W and H together and the radius as W/2 [C-196].
- **The scale pivot is not settled for every layer.** figma_get_motion_context lists the pivot among what the Plugin API cannot tell (`limits`), so where a scale or rotation must turn about a particular point, probe it first (the storyboard skill's technical probe). Where the probe shows SCALE turning about the layer's centre, a TRANSLATION on the same easing of (1 − s) × (the point − the centre) moves the pivot. In the edit gear, existing layers made in Figma's own editor may carry a moved origin: render once and check before trusting a computed step.
- **What Figma Motion cannot do:** blur is LAYER_BLUR or BACKGROUND_BLUR only, with no direction; no shear, no 3D, no per-glyph text; the export has no audio and always renders the whole top-level frame for the whole timeline [C-184].
- **Blur needs its effect first:** give the layer a LAYER_BLUR with figma_set_effects, then key "effect:<i>:RADIUS" at that blur's own index (0 only when the blur is the first effect); figma_set_keyframes refuses an effect index that does not exist.
- **A still is the resting state:** figma_export_node renders the rest pose only [C-116]. Keep every layer visible and laid out at rest and hide it only with keys (figma_check_motion flags `rest_state_hidden`).

## Ids and readback inside an animated frame
- Address layers by the ids your create calls returned. For stretches of seconds to minutes Figma has listed an animated frame's layers under second ids that later stopped resolving, while the created ids kept working [C-199].
- figma_set_keyframes reads every track back once Figma settles and re-applies a track that did not land: each track says `status` written or rewritten, and `timeline` names its top-level frame. A track that never lands fails INTERNAL with `partial.notApplied`: send only those tracks again [C-250].
- Several tracks of one layer go in one call; the cap is 50 tracks per call and 100 keys per track.

## Rendering
- figma_export_video is a job [C-249]. It waits up to `wait` seconds (default 40, at most 45 unless the server allows more); a longer render answers status "rendering" with a `jobId`, and figma_export_video { jobId } collects it. Name your own `jobId` for a long render and never start a second export while one runs: Figma renders one thing at a time, and meanwhile other Figma calls answer BUSY (figma_review_video and figma_get_guide still work).
- A render is a preview unless the call says `final: true`. The delivery render, figma_export_video { nodeId, fps, final: true }, waits under BRIDGE_PROCESS=strict until the last whole figma_check_motion on the frame passed at that fps against its plan, with no change to the file since (any write, an undo, an edit by hand); until then it answers PROCESS_REQUIRED and names the check.
- Keep the Figma window restored while it renders (behind other windows is fine): a minimized window stopped a render for about 40 minutes [C-198]. A 1080 × 1920 piece took 28–47 s to render [C-197]. The server waits for a render however long it takes; past 5 minutes with no result, the hint says how to end the wait.
- Figma ends a render it has not finished in about 4 minutes. That answer is TIMEOUT, not UNSUPPORTED: the frame is fine, so ask the user to keep Figma restored and render again [C-198]; a large render may need fewer frames (a lower fps or width, a shorter timeline). Figma's exporter can also get stuck, and then every render times out, small or large, until Figma restarts [C-318]. On a second TIMEOUT in a row, or one for a small render [C-337], the hint says so: ask the user to save, quit and reopen Figma and run the plugin again; fewer frames do not help. figma_status shows `videoExport.timeoutsInARow` per file.
- A frame with nothing animated is refused INVALID_PARAM before Figma renders. Any other refusal ("Video export failed") is INTERNAL: render again once; if it fails again, ask for a Figma restart.
- `frameIndices` returns exact frames as PNG, the long side at most 1024 px [C-336], when ffmpeg runs on the server machine (on PATH, or named by BRIDGE_FFMPEG); stills not cut within the call's wait come back as `framesPending`, and figma_export_video { jobId, frameIndices } cuts them. `frameCount` against `expectedFrames` checks the length. For a contact sheet, close-ups and metrics, run figma_review_video on the file.

## Recipe — a switch that turns on (UI micro-motion)
The duration and the curve come from the product: its motion tokens when it has them [C-224] [C-225]; otherwise the motion its other screens already have (figma_get_motion_context on them); otherwise a duration from the distance travelled [C-225] and a decelerating curve for an arrival, stated in the handoff. Below, <d> is that duration in seconds and <curve> that easing.
1. figma_get_motion_context { nodeId: <frame> }: what already moves inside it, how long the timeline is, and its plan in `motionPlans`.
2. Without a plan, a one-beat one, since the keyframe tools refuse a frame without it: figma_set_motion_plan { nodeId: <frame>, brief: { audience, message, format, durationS: <the timeline's length>, fps: 30 }, beats: [{ name: "switch on", from: 0, to: <the timeline's length>, onScreen: "[the switch]", action: "the knob slides right as the track fills", transition: "holds on" }] }.
3. figma_set_keyframes { nodeId: <knob>, tracks: [
     {"field":"TRANSLATION_X","keyframes":[{"t":0,"value":"0"},{"t":<d>,"value":"20","easing":"<curve>"}]}] }
   figma_set_keyframes { nodeId: <track>, tracks: [
     {"field":"fill:0","keyframes":[{"t":0,"value":"<off hex>"},{"t":<d>,"value":"<on hex>","easing":"<curve>"}]}] }
4. Siblings that move as a group start 2 frames or more apart [C-242].
5. figma_check_motion { nodeId: <frame>, fps: 30 }: fix every warning.
6. Look: figma_export_video { nodeId: <frame>, format: "GIF", fps: 12, width: 480, frameIndices }, with the frames the brief's checks need (the start, the end, and any frame a check flagged). For a piece, render MP4 at the delivery fps instead and review it with the critique skill.
7. Take a track back with figma_remove_keyframes { nodeId, fields: ["TRANSLATION_X"] }.
