# Formats — brief fields, reading, sound, placement, tempo, loops and delivery

## Fields the placement and the brief set
Write these into the brief. They come from where the piece plays and what it is for, never from the last piece:
- **Frame 0:** what the first frame does: the hook, the brand, the message, a still title card, a fade from black for a film title, a loop's seam.
- **Brand by:** when the brand is fully visible (`brandBy`).
- **End structure:** an end card (with or without a breath before it), a loop, a held last pose, a button's new state.
- **Stillness:** where the piece may hold still on purpose; each such stretch is declared as a hold.
- **Cut grammar:** which changes are continuous moves (match cut, push-through, whip) and which are cuts on purpose (hard, smash, on the beat).

For a feed or story ad the defaults are: the brand or the key message within the first 3 seconds [C-235], so frame 0 opens on the hook; the brand fully visible by 3 s and the CTA readable for 2.5 s or more [C-241]; an end card. A title, a loop, an animated icon, a brand film or a broadcast spot decides each field from its own brief. Declare what the brief changes in the plan, which figma_check_motion applies: `holds` for declared stillness, and `accept` for each finding the brief intends, with its reason: `cold_open` when the piece opens still or from black on purpose, `brand_late` up to the time the brief sets (`to`). A check with `rules`, a later `brandBy` or a shorter `ctaMinS` never clears the final render.

## Reading
- **Read time:** max(5/6 s, 0.3 s × words), counted from fully legible to covered; numbers and prices count as words [C-241]. Subtitle practice is the basis: about 20 characters per second for adults, and at least 5/6 s per subtitle [C-231] [C-232].
- **The call to action**, when there is one, stays fully readable for 2.5 s or more [C-241].
- figma_check_motion checks these from the keys: `read_time`, `cold_open`, and with `brandId` and `ctaId` the `brand_late` and `cta_short` rules.

## Sound
Figma's export has no audio [C-184], so sound is chosen or made, then joined to the render.
- **Sound off first.** Unless the brief says sound is on, the piece reads with the sound off: the message, the brand and the CTA live in the picture; sound adds rhythm and weight, never information.
- **Only the user's own audio.** Use music and effects the user supplied and has the rights to; never fetch a track from the web. Name the source in the report.
- **A track: analyse it before planning.** figma_analyze_audio { path } gives the tempo, `beatTimes`, a first-downbeat guess (`beatOffset`), strong onsets and the loudness. Put the beat sheet's hits on the real beats (frame = round(t × fps)) and check the keys against them with figma_check_motion { nodeId, fps, beatTimes }. Under 0.4 `confidence` the tempo is a guess: time the hits to the strong onsets and say so.
- **No track: generate one.** figma_generate_audio { durationS, bed } makes a simple bed at the plan's tempo and first downbeat, its `sections` following the beat sheet's energy (lower under the hook, lifting into the reveal). A generated bed is a temporary or simple track; say in the report that a produced, licensed track is better for a final ad.
- **Effects on cuts and accents.** figma_generate_audio { durationS, nodeId, fps } derives a whoosh per fast move, a hit per cut and a tick per text entrance. Read `derivedCues`, cut what crowds (at most one effect per beat in a busy stretch), and run again with the edited list as `cues`. A riser ends at t + durationS: end it on the hit it leads into.
- **Order.** The picture first: review the previews, then render the final (Delivery, step 1). Then make or analyse the sound and join it to the final render with figma_add_audio { video, tracks, loudness } (the music first, the effects after; the picture is copied, not encoded again), answer every warning (a track trimmed at the end, audio that stops early, a peak over −1 dBTP [C-332]), and look at the result once more with figma_review_video. Pass `loudness` only when the brief or the placement's spec gives a target; otherwise report the measured level.

## Placement and safe zones
- Aspect, delivery size, codec, frame-rate mode and audio format come from the placement's spec. Meta's Stories video ad spec, for one, names a 9:16 frame, H.264 at a constant frame rate, and AAC stereo audio [C-233].
- **Safe zones come from the brief.** When the brief names only a placement, read that placement's current spec at brief time and write the figures, the source and the date into the brief. Where two sources disagree, keep text, logo and CTA clear of both.
- **When the page cannot be read** (no web access): use figures registered here with their date, marked "not re-read" (Meta's Stories figures, read 2026-10-13 [C-233]). For a placement with no registered figures, keep text, logo and CTA inside a conservative area you state in the brief, pass it as `safeArea`, and put "safe zones unverified" first in the report. Never stop the run to ask.
- Check them on every styleframe with figma_check_layout { nodeId, safeArea: "x,y,width,height" }, and over time from the keys (section `passes`).
- `minTextSize` is in frame pixels: the device's smallest comfortable size × frame width ÷ device width.

## Tempo
- **Choose one** where a beat is a whole number of frames: fps × 60 / BPM is an integer [C-244]. At 30 fps: 60, 72, 75, 90, 100, 120, 150 or 180 BPM; at 24 fps: 60, 72, 80, 90, 96, 120, 144, 160 or 180.
- **Eighths** are whole frames only where fps × 30 / BPM is an integer: at 30 fps 60, 75, 90, 100, 150 and 180; at 24 fps 60, 72, 80, 90, 120, 144 and 180. At the other tempos put secondary hits on beats, or on the nearest frame.
- **A track the client supplies** sets its own tempo and its own beats, which drift off any one BPM: analyse it (Sound, above), put its tempo and first downbeat in the plan's brief as `bpm` and `beatOffset`, which figma_check_motion applies, pass its `beatTimes` to figma_check_motion so accents are judged against the real beats, and round every hit to the nearest frame; the default `beatToleranceFrames` of 1 allows that rounding. figma_create_storyboard takes no offset, so start the board on the first downbeat or note the shift.
- **A voice-over-led spot** is timed from the script, not a BPM: place the hits on the frames where the words land. Before the recording exists, time it at a speaking rate you assume, write that rate in the brief as an assumption, and re-time when the recording arrives.
- Pass the same `bpm` to figma_create_storyboard and the plan so the beat checks agree.

## Frame rates
- Figma exports MP4 at 12, 24, 30 or 60 fps, and GIF at 8, 12, 15, 24 or 30 [C-116]. Plan at one of them. A 25, 29.97 or 23.976 fps delivery is planned at 24 or 30 and conformed downstream with ffmpeg where a shell exists; say so in the report.
- The frame grid was measured on MP4 at 24, 30 and 60 fps and on a 12 fps GIF [C-193], and the cut pairs at 24 and 30 fps [C-240]. At any other fps, add "cut pairs at this fps" to the technical probe, and "frame grid at this fps" at a rate not listed here.

## Loops
- A loop returns to frame 0's pose at its period P. Figma renders the end frame too [C-194], so a timeline of exactly P seconds repeats frame 0's pose at the seam: a one-frame hitch on every cycle.
- Without a shell: set `timelineDuration` to (P · fps − 1.01) / fps, a hundredth of a frame short of the last frame so that Figma's rounding cannot add a frame; the render holds P · fps frames. Key the timeline's end with the pose one step before frame 0's (for a LINEAR cycle, start + (end − start) × (P · fps − 1) / (P · fps); for an eased one, the curve's value there). With a shell: render P seconds and drop the last frame with ffmpeg.
- A GIF's `loopCount` 0 loops forever.
- Check the seam: figma_review_video { path, stills: [0], closeups: [{ startFrame: <last frame − 5>, frames: 6 }] }; the step from the last frame to frame 0 matches the steps before it.
- A loop is exempt from "the last frame is settled"; frame 0 still does its brief job.

## Flashes
Nothing may flash more than three times in any one second [C-222]. figma_review_video's `flash` is a craft metric that skips declared cuts, not the WCAG test: run the count as the critique skill's motion checks describe (B6), on a pass with no `cuts` and no `holds`. A single large brightness jump at a continuous cut is a craft fault: bridge the tone (section `transitions`).

## Delivery
1. Render the master at delivery size and fps once figma_check_motion { nodeId, fps } passes: figma_export_video { nodeId, format: "MP4", fps, width, saveTo, jobId, final: true }. Any change to the file after the check (a keyframe, a text edit, an undo, an edit by hand) needs the check again first. The result lists the findings the plan accepted: name them in the report. Keep Figma's window restored until it is done [C-198].
2. Length: a d-second timeline at f fps gives ceil(d · f) + 1 frames in every format [C-194]. Compare `frameCount` with `expectedFrames`; where the placement needs the exact length and a shell exists, drop the last frame with ffmpeg; otherwise say so in the report. A GIF stores whole hundredths of a second per frame: a 12 fps GIF plays at 12.5 fps [C-266].
3. Poster: when the placement shows a still before play, check that frame as a still, figma_review_video { path, stills: [<frame>] }.
4. Last look: the first and last frames as stills, the contact sheet once more, and the frame count.
5. Report: the placement and its spec source (or "unverified"), the duration and frame count, the sound (its source, or "generated", and its measured loudness) or that the piece ships silent, what was left for downstream (trimming, conforming, encoding), and any default kept on purpose.
