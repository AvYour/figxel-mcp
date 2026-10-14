# Audio tools held back — 2026-10-14

Date 2026-10-14. Branch `release/figxel`, from `63215a7`. Status: **held**. The three audio tools stay in the code, the tests and the catalog, but the server does not register them unless asked, and nothing an agent or a user reads by default names them.

## Why

The owner's decision on 2026-10-14: "don't release the audio yet". He listened to the sound `figma_generate_audio` makes and judged it bad, and the path built around the user's own licensed files is not built yet. So `figma_analyze_audio`, `figma_add_audio` and `figma_generate_audio` are not part of the 0.1.1 release.

## What changed

- **Registration.** The three tools left the `export` group for a new `audio` group (`src/shared/ops.ts`). Like `figma_eval`, the group needs two keys: `BRIDGE_ENABLE_AUDIO=1` (parsed in `src/server/config.ts` as `0` or `1`; any other value stops the server) **and** a toolset that includes the `audio` group (`full` does, `core` does not, a group list must name `audio`). The default registers 133 tools; `figma_eval` makes 134, the audio flag 136, both 137, the whole catalog.
- **Kept as it was:** `src/server/tools/audio.ts`, `audio-analysis.ts`, `audio-cues.ts`, `audio-dsp.ts`, `audio-loudness.ts`, `audio-synth.ts`, `wav.ts`, their tests, the editor rows in `src/shared/editors.ts`, and `figma_status`'s ffmpeg report. That report's note names `figma_analyze_audio` and `figma_add_audio` only when they are registered.
- **`figma_check_motion` keeps `beatTimes`**, a plain list of beat times; its parameter description and its refusal hint no longer point at `figma_analyze_audio`.
- **Skills** (`src/skills/`): every sound step that named an audio tool is removed; where it helps, one neutral line says that Figma's export has no audio and that sound is added after the final render, with audio the user has the rights to, in a video editing tool. The removed text is below, verbatim.
- **Docs:** README (the feature bullet, the ffmpeg requirement, the counts; the flag is left out of its configuration table on purpose), `docs/usage.md`, `docs/agents/using-the-mcp.md`, `docs/clients.md`, the roadmap, the spec (§4.4 and §7) and the CHANGELOG's 0.1.1 section. The catalog keeps the three rows unchanged in [tools.md § audio](../../reference/tools.md#audio-3), with the two-key rule in [§ Trimming the toolset](../../reference/tools.md#trimming-the-toolset). `scripts/check-docs.mjs` leaves both opt-in groups, `eval` and `audio`, out of the default count.
- **The claim registry is unchanged.** The audio rows, C-326 to C-332, stay as recorded facts.
- **Tests:** the flag's parsing (`test/server-units.test.ts`); the two-key rule and the counts (`test/ops.test.ts`); the tools absent by default and present with the flag, by toolset (`test/editor-integration.test.ts`); no skill, prompt or server instruction naming them (`test/skills.test.ts`); the status note (`test/export-video-robustness.test.ts`). The schema, description and strict-parameter tests turn the flag on, so the three schemas are still checked; `test/audio-*.test.ts` register the tools directly, as before.

## How to bring them back

- **To try them** (development only): put `BRIDGE_ENABLE_AUDIO=1` in the server entry's environment and restart the AI app. `figma_status` lists them under `toolsRegistered`.
- **To release them:**
  1. Decide the registration: keep the flag and document it as a feature, or drop the `audio` rule from `selectOps` (`src/shared/ops.ts`) so the group is on by default, or move the three ops back into `export` and remove the group, `IMPLEMENTED_AUDIO` and the flag. Then make tools.md's Count line, group table and § audio, the spec's §7 table and `OPT_IN_GROUPS` in `scripts/check-docs.mjs` agree.
  2. Restore the skill text below: each **held** block replaces its **now** block. In `test/skills.test.ts`, update the `REWRITTEN` reasons for `tools` and `motion`, and remove the test "no surface names a tool of the held-back audio group".
  3. Restore the documentation text below (README, usage, using-the-mcp, tools.md's export intro) with the new counts, and write the CHANGELOG entry for the release that ships them.
  4. Run every gate in AGENTS.md § Before committing.

## The removed text, verbatim

Each **held** block is the text at `63215a7`; each **now** block is what replaced it on 2026-10-14.

### `src/skills/figxel-motion/SKILL.md` — stage 9

Held:

```markdown
| 9 | Final: figma_export_video { nodeId, fps, final: true }, then sound (section `formats`) | the delivery |
```

Now:

```markdown
| 9 | Final: figma_export_video { nodeId, fps, final: true } (section `formats`) | the delivery |
```

### `src/skills/figxel-motion/references/formats.md` — the Sound section

Held:

```markdown
## Sound
Figma's export has no audio [C-184], so sound is chosen or made, then joined to the render.
- **Sound off first.** Unless the brief says sound is on, the piece reads with the sound off: the message, the brand and the CTA live in the picture; sound adds rhythm and weight, never information.
- **Only the user's own audio.** Use music and effects the user supplied and has the rights to; never fetch a track from the web. Name the source in the report.
- **A track: analyse it before planning.** figma_analyze_audio { path } gives the tempo, `beatTimes`, a first-downbeat guess (`beatOffset`), strong onsets and the loudness. Put the beat sheet's hits on the real beats (frame = round(t × fps)) and check the keys against them with figma_check_motion { nodeId, fps, beatTimes }. Under 0.4 `confidence` the tempo is a guess: time the hits to the strong onsets and say so.
- **No track: generate one.** figma_generate_audio { durationS, bed } makes a simple bed at the plan's tempo and first downbeat, its `sections` following the beat sheet's energy (lower under the hook, lifting into the reveal). A generated bed is a temporary or simple track; say in the report that a produced, licensed track is better for a final ad.
- **Effects on cuts and accents.** figma_generate_audio { durationS, nodeId, fps } derives a whoosh per fast move, a hit per cut and a tick per text entrance. Read `derivedCues`, cut what crowds (at most one effect per beat in a busy stretch), and run again with the edited list as `cues`. A riser ends at t + durationS: end it on the hit it leads into.
- **Order.** The picture first: review the previews, then render the final (Delivery, step 1). Then make or analyse the sound and join it to the final render with figma_add_audio { video, tracks, loudness } (the music first, the effects after; the picture is copied, not encoded again), answer every warning (a track trimmed at the end, audio that stops early, a peak over −1 dBTP [C-332]), and look at the result once more with figma_review_video. Pass `loudness` only when the brief or the placement's spec gives a target; otherwise report the measured level.
```

Now:

```markdown
## Sound
Figma's export has no audio [C-184]: the piece reads with the sound off (the message, the brand and the CTA live in the picture), and any sound is added after the final render, with audio the user has the rights to, in a video editing tool.
```

### `src/skills/figxel-motion/references/formats.md` — Tempo, a supplied track

Held:

```markdown
- **A track the client supplies** sets its own tempo and its own beats, which drift off any one BPM: analyse it (Sound, above), put its tempo and first downbeat in the plan's brief as `bpm` and `beatOffset`, which figma_check_motion applies, pass its `beatTimes` to figma_check_motion so accents are judged against the real beats, and round every hit to the nearest frame; the default `beatToleranceFrames` of 1 allows that rounding. figma_create_storyboard takes no offset, so start the board on the first downbeat or note the shift.
```

Now:

```markdown
- **A track the client supplies** sets its own tempo and its own beats, which drift off any one BPM: put its tempo and first downbeat in the plan's brief as `bpm` and `beatOffset`, which figma_check_motion applies; when its beat times are known, pass them to figma_check_motion as `beatTimes` so accents are judged against the real beats, and round every hit to the nearest frame; the default `beatToleranceFrames` of 1 allows that rounding. figma_create_storyboard takes no offset, so start the board on the first downbeat or note the shift.
```

### `src/skills/figxel-motion/references/formats.md` — Delivery, the report

Held:

```markdown
5. Report: the placement and its spec source (or "unverified"), the duration and frame count, the sound (its source, or "generated", and its measured loudness) or that the piece ships silent, what was left for downstream (trimming, conforming, encoding), and any default kept on purpose.
```

Now:

```markdown
5. Report: the placement and its spec source (or "unverified"), the duration and frame count, what was left for downstream (sound, trimming, conforming, encoding), and any default kept on purpose.
```

### `src/skills/figxel-storyboard/references/beat-sheet.md` — the brief's Sound field

Held:

```markdown
- **Sound:** on or off (unless the brief says on, the piece reads with it off), and the track: music the user supplied and has the rights to, analysed before the beat sheet, or a simple bed figma_generate_audio makes at the grid's tempo (temporary; a produced, licensed track is better for a final ad). Figma exports no audio [C-184]: sound joins the render with figma_add_audio (the motion skill's `formats` section).
```

Now:

```markdown
- **Sound:** on or off (unless the brief says on, the piece reads with it off). Figma exports no audio [C-184]: any sound is added after the final render, with audio the user has the rights to, in a video editing tool.
```

### `src/skills/figxel-storyboard/references/beat-sheet.md` — the tempo grid, a supplied track

Held:

```markdown
- **A supplied track:** analyse it first, figma_analyze_audio { path }: its tempo and first downbeat set the grid; put them in the plan's brief as `bpm` and `beatOffset` (figma_check_motion applies them), put the hits on its real beats (`beatTimes`), each rounded to the nearest frame, and check the accents with figma_check_motion { beatTimes } (the default tolerance is 1 frame, `beatToleranceFrames`). Under 0.4 `confidence` the tempo is a guess: time the hits to the strong onsets.
```

Now:

```markdown
- **A supplied track:** its tempo and first downbeat set the grid; put them in the plan's brief as `bpm` and `beatOffset` (figma_check_motion applies them). When its beat times are known, put the hits on those beats, each rounded to the nearest frame, and check the accents with figma_check_motion { beatTimes } (the default tolerance is 1 frame, `beatToleranceFrames`).
```

### `src/skills/figxel-storyboard/references/animatic.md` — judging at speed

Held:

```markdown
4. Judge at speed, and write each answer as a number in frames or seconds: does every panel hold long enough to read; does the brand show by its time; does the CTA hold; does the planned end read; does any stretch drag or crowd? With a music track, each panel's `inFrame` should sit within a frame of a beat in its `beatTimes`; when the user is to see the plan first, join the track to the small render with figma_add_audio { video, tracks } so the animatic plays with its music.
```

Now:

```markdown
4. Judge at speed, and write each answer as a number in frames or seconds: does every panel hold long enough to read; does the brand show by its time; does the CTA hold; does the planned end read; does any stretch drag or crowd? With a music track, each panel's `inFrame` should sit within a frame of one of its beats.
```

### `src/skills/figxel-critique/references/motion-checks.md` — F. Rhythm, item 1

Held:

```markdown
1. Hits on downbeats, secondary hits on beats or on whole-frame subdivisions, at a stated BPM or on the music's own beats (figma_check_motion { beatTimes } from figma_analyze_audio), or on the timed voice-over.
```

Now:

```markdown
1. Hits on downbeats, secondary hits on beats or on whole-frame subdivisions, at a stated BPM or on the music's own beat times (figma_check_motion { beatTimes }), or on the timed voice-over.
```

### `src/skills/figxel-critique/references/motion-checks.md` — G. Finish and delivery, item 4

Held:

```markdown
4. The master meets the placement's spec. With sound: it was joined after the last picture fix (figma_add_audio), its warnings are answered, its true peak is at or under −1 dBTP, effects sit on their cuts and accents, and the piece still reads with the sound off. The audio is the user's licensed track or a generated one, named in the report.
```

Now:

```markdown
4. The master meets the placement's spec, and the piece reads with the sound off: Figma's export has no audio, and any sound is added after the final render, with audio the user has the rights to, in a video editing tool.
```

### `src/skills/figxel-critique/references/motion-checks.md` — the evidence line

C-332 left with the loudness check it backed.

Held:

```markdown
Evidence (claim ids, for maintainers): [C-206] [C-246] [C-243] [C-240] [C-242] [C-196] [C-222] [C-259] [C-261] [C-258] [C-230] [C-241] [C-075] [C-207] [C-221] [C-244] [C-194] [C-208] [C-219] [C-209] [C-260] [C-184] [C-332]
```

Now:

```markdown
Evidence (claim ids, for maintainers): [C-206] [C-246] [C-243] [C-240] [C-242] [C-196] [C-222] [C-259] [C-261] [C-258] [C-230] [C-241] [C-075] [C-207] [C-221] [C-244] [C-194] [C-208] [C-219] [C-209] [C-260] [C-184]
```

### `src/skills/figxel-critique/references/sampling.md` — an animatic with music

Held:

```markdown
For an animatic, `cuts` are the panels' `inFrame` values from the latest figma_create_animatic result, panel 1 left out. With music, check the keys against its beats, figma_check_motion { nodeId, fps, beatTimes }; review the picture on the silent render, then once more on the file figma_add_audio wrote (its picture is the same stream). For UI micro-motion, a small GIF is enough: figma_export_video { nodeId, format: "GIF", fps: 12, width: 480, frameIndices: [0, 6, 12] }.
```

Now:

```markdown
For an animatic, `cuts` are the panels' `inFrame` values from the latest figma_create_animatic result, panel 1 left out. With music, check the keys against its beat times, figma_check_motion { nodeId, fps, beatTimes }, and review the picture on the silent render. For UI micro-motion, a small GIF is enough: figma_export_video { nodeId, format: "GIF", fps: 12, width: 480, frameIndices: [0, 6, 12] }.
```

### `src/skills/figxel-workflow/references/tools.md` — the sound row

Held:

```markdown
| Sound for a motion piece (Figma's export has none) | figma_analyze_audio (the user's own track: tempo, `beatTimes`, loudness), figma_generate_audio (a simple bed and effects made offline; `nodeId` derives the effects from the keys), figma_add_audio (tracks onto the render, the picture copied); only audio the user has the rights to |
```

Now:

```markdown
| Sound for a motion piece | none: Figma's export has no audio, so sound is added after the final render, with audio the user has the rights to, in a video editing tool |
```

### `src/server/tools/check-motion.ts` — `beatTimes`

The parameter's description:

Held:

```markdown
    .describe("The music's own beats in seconds, increasing (figma_analyze_audio's beatTimes): the beat check uses them instead of the bpm grid."),
```

Now:

```markdown
    .describe("The beat times of the music in seconds, increasing: the beat check uses them instead of the bpm grid."),
```

The refusal hint when the times do not increase:

Held:

```markdown
    if (i > 0 && !(t > beatTimes[i - 1]!)) throw invalid(`\`beatTimes\` must increase: beatTimes[${i}] = ${t} is not after ${beatTimes[i - 1]}.`, "Pass figma_analyze_audio's beatTimes as they are.");
```

Now:

```markdown
    if (i > 0 && !(t > beatTimes[i - 1]!)) throw invalid(`\`beatTimes\` must increase: beatTimes[${i}] = ${t} is not after ${beatTimes[i - 1]}.`, "Pass the beat times of the music in seconds, each after the one before.");
```

### `README.md`

The feature bullet under "What you can do":

Held:

```markdown
- **Add sound.** Figma's video export has no audio `[C-184]`, so sound is joined after the render. `figma_analyze_audio` reads the tempo, beats and loudness of music you supply, so the motion lands on its real beats. `figma_generate_audio` makes a simple music bed and sound effects offline (no service, no samples), and can take the effects from the frame's own moves and cuts. `figma_add_audio` mixes your tracks onto the render without encoding the picture again. Use only audio you have the rights to.
```

Now:

```markdown
(nothing: removed)
```

The count under it:

Held:

```markdown
That is 136 tools by default, plus `figma_eval` (raw Plugin API JavaScript) when you opt in. The full list is in the [tool catalog](docs/reference/tools.md).
```

Now:

```markdown
That is 133 tools by default, plus `figma_eval` (raw Plugin API JavaScript) when you opt in. The full list is in the [tool catalog](docs/reference/tools.md).
```

The ffmpeg requirement:

Held:

```markdown
- **Optional: ffmpeg** (it brings ffprobe) on your PATH, or named by `BRIDGE_FFMPEG`, for `figma_review_video`, `figma_analyze_audio`, `figma_add_audio` and the frames `figma_export_video` returns. `figma_generate_audio` does without it. `figma_status` says whether it runs.
```

Now:

```markdown
- **Optional: ffmpeg** (it brings ffprobe) on your PATH, or named by `BRIDGE_FFMPEG`, for `figma_review_video` and the frames `figma_export_video` returns. `figma_status` says whether it runs.
```

### `docs/usage.md`

The motion example's step 9:

Held:

```markdown
9. **Sound**, when the brief has it. Figma's video export has no audio `[C-184]`, so sound is joined to the final render: `figma_add_audio` mixes the tracks onto it without encoding the picture again. Give the agent your own track and it reads the tempo and beats first (`figma_analyze_audio`), so the hits land on the music's real beats; without one, `figma_generate_audio` makes a simple bed and effects offline. Use only audio you have the rights to.
```

Now (a "What to expect" bullet, not a step):

```markdown
- The render is silent: Figma's video export has no audio `[C-184]`. Add sound in your video editor afterwards, with audio you have the rights to.
```

The ffmpeg bullet under "What to expect":

Held:

```markdown
- `figma_review_video`, `figma_analyze_audio` and `figma_add_audio` need ffmpeg on your PATH, or named by `BRIDGE_FFMPEG`; `figma_generate_audio` does not. Without ffmpeg the agent judges from `figma_check_motion` and still frames, and says the motion itself was not seen.
```

Now:

```markdown
- `figma_review_video` needs ffmpeg on your PATH, or named by `BRIDGE_FFMPEG`. Without ffmpeg the agent judges from `figma_check_motion` and still frames, and says the motion itself was not seen.
```

The ffmpeg tip:

Held:

```markdown
- **ffmpeg** on your PATH enables `figma_review_video`, the audio analysis and mix, and the frame-exact stills of `figma_export_video`; `BRIDGE_FFMPEG` names it when it is elsewhere, and `figma_status` says whether it runs.
```

Now:

```markdown
- **ffmpeg** on your PATH enables `figma_review_video` and the frame-exact stills of `figma_export_video`; `BRIDGE_FFMPEG` names it when it is elsewhere, and `figma_status` says whether it runs.
```

The closing line:

Held:

```markdown
New since 0.1.0: sound for motion pieces (`figma_analyze_audio`, `figma_generate_audio`, `figma_add_audio`), and `setup --register`, which lists the plugin in Figma desktop so the manual import can be skipped ([Quickstart](../README.md#quickstart)). The [changelog](../CHANGELOG.md) has the rest.
```

Now:

```markdown
New since 0.1.0: `setup --register`, which lists the plugin in Figma desktop so the manual import can be skipped ([Quickstart](../README.md#quickstart)). The [changelog](../CHANGELOG.md) has the rest.
```

### `docs/agents/using-the-mcp.md`

The last sentence of the motion process paragraph:

Held:

```markdown
 Sound joins after the delivery render, since Figma's export has none `[C-184]`: the user's track is analysed first (`figma_analyze_audio`) so the beat sheet sits on its real beats, a bed or effects can be made offline (`figma_generate_audio`), and `figma_add_audio` mixes them onto the render; the piece still has to read with the sound off.
```

Now:

```markdown
 Figma's export has no audio `[C-184]`: the piece has to read with the sound off, and any sound is added after the delivery render, with audio the user has the rights to, in a video editing tool.
```

Three rows of "Choosing a tool":

Held:

```markdown
| Plan on a track | `figma_analyze_audio` | Tempo, `beatTimes`, a downbeat guess and loudness of the user's music; pass `beatTimes` to `figma_check_motion` |
| Make sound | `figma_generate_audio` | A bed at the plan's tempo and effects, offline; `nodeId` derives the effects from the frame's moves and cuts |
| Add sound to a render | `figma_add_audio` | Up to 8 tracks on the video's timeline, the picture copied, `loudness` optional; only audio the user has the rights to |
```

Now:

```markdown
(nothing: removed)
```

### `docs/reference/tools.md`

The last sentences of the export section's introduction (§ audio now says the same):

Held:

```markdown
 So are the three sound tools, which work on files under the same rules, every input and output alike: Figma's video export has no audio `[C-184]`, so sound is analysed, made and joined after the render. Only `figma_generate_audio { nodeId }` reaches Figma, to read an animated frame through the plugin op `figma_check_motion` reads with.
```

Now:

```markdown
(nothing: removed)
```

`figma_check_motion`'s `beatTimes` parameter:

Held:

```markdown
`beatTimes?` (2–4000 increasing seconds, the music's own beats from `figma_analyze_audio`; turns on
```

Now:

```markdown
`beatTimes?` (2–4000 increasing seconds, the beat times of the music; turns on
```

### `CHANGELOG.md` — 0.1.1, Added

Held:

```markdown
- **Sound for motion pieces**, joined after the render because Figma's video export has none: `figma_analyze_audio` reads the tempo, beat times, a downbeat guess and the loudness of the user's own music; `figma_generate_audio` synthesizes a music bed (four styles, energy by section) and sound effects offline into a 48 kHz WAV, deterministic per seed, and can derive the effects from an animated frame's moves, cuts and text; `figma_add_audio` mixes up to 8 tracks onto an MP4, MOV or WebM render with the video stream copied, optionally to a target loudness. `figma_check_motion` takes `beatTimes` to check accents against the music's real beats. The motion, storyboard and critique skills gained a sound-design part. `figma_analyze_audio` and `figma_add_audio` need ffmpeg; `figma_generate_audio` does not. They run the programs `BRIDGE_FFMPEG` and `BRIDGE_FFPROBE` name, like the video tools.
```

Now:

```markdown
- **`figma_check_motion` takes `beatTimes`**, the beat times of a music track in seconds, and checks accents against them instead of the `bpm` grid.
```

Held:

```markdown
- 136 tools by default, 137 with `figma_eval`: `figma_set_motion_plan` and the three audio tools are new.
```

Now:

```markdown
- 133 tools by default, 134 with `figma_eval`: `figma_set_motion_plan` is new.
```
