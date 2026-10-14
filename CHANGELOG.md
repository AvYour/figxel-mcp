# Changelog

Notable changes to `figxel-mcp`, newest first. A version marked **Unreleased** has not been published yet; its heading gets the release date when it is tagged ([CONTRIBUTING.md § Releasing](CONTRIBUTING.md#releasing)).

## 0.1.1 — 2026-10-14

### Added

- **The motion process, enforced by the tools** (`BRIDGE_PROCESS`, default `strict`): `figma_set_motion_plan` records a frame's brief and beat sheet, checked before it is stored (beats on the frame grid, back to back, each long enough to read, accents on the beat grid) and kept in the file; `figma_set_keyframes` and `figma_remove_keyframes` answer the new `PROCESS_REQUIRED` until the agent has read the motion skill and the frame has a plan; `figma_export_video` takes `final: true` for the delivery render, which waits for a `figma_check_motion` that passed as the plan's own check (it applies the plan's tempo, holds, brand and CTA, and its `accept`, the findings the brief intends, each with a reason the delivery's result repeats) with no change to the file since, by any write or any change Figma reports, while previews always render. `guided` turns the refusals into `processWarnings`; `off` turns the checks off. The motion skill opens with the senior motion designer's role and the stages in order. A final call that names a render already running or done (its `jobId`, or the same settings) attaches to it before the check is read, so a delivery retried after a client timeout collects its own render.
- **A guide for people**, `docs/usage.md`: what to ask, what the agent does on its own, how to review its work, and the motion process setting.
- **Sound for motion pieces**, joined after the render because Figma's video export has none: `figma_analyze_audio` reads the tempo, beat times, a downbeat guess and the loudness of the user's own music; `figma_generate_audio` synthesizes a music bed (four styles, energy by section) and sound effects offline into a 48 kHz WAV, deterministic per seed, and can derive the effects from an animated frame's moves, cuts and text; `figma_add_audio` mixes up to 8 tracks onto an MP4, MOV or WebM render with the video stream copied, optionally to a target loudness. `figma_check_motion` takes `beatTimes` to check accents against the music's real beats. The motion, storyboard and critique skills gained a sound-design part. `figma_analyze_audio` and `figma_add_audio` need ffmpeg; `figma_generate_audio` does not. They run the programs `BRIDGE_FFMPEG` and `BRIDGE_FFPROBE` name, like the video tools.
- **`setup --register`**, optional: with Figma desktop closed, it lists the plugin under Plugins → Development by writing into Figma's settings file the same entries an import writes, after a backup next to it, so the manual import can be skipped. It refuses while Figma runs or when the file is not in the measured form, and changes only Figxel's entries. `--dry-run` shows the change and writes nothing, `--force` moves a registration from another folder, and `setup --unregister` removes the entries. The file's form was measured on Windows; macOS is experimental, and whether Figma then lists the plugin is not yet verified live.
- 136 tools by default, 137 with `figma_eval`: `figma_set_motion_plan` and the three audio tools are new.

### Fixed

- **Video export when Figma's exporter is stuck.** Figma can get into a state where every render ends in its 4-minute limit until it is restarted. The server now counts the timeouts in a row per plugin window: on the second, or on a timeout of a small render, the hint says to save, quit and reopen Figma and run the plugin again, instead of "render fewer frames". `figma_status` shows the count (`videoExport.timeoutsInARow`).
- **A large video through a second AI app.** A result over about 24 MB was lost when the app was sharing another app's Figma connection, and the error said that the other server had exited. Large results now travel in pieces between the two servers; an older server gets an honest error instead.
- **A render with the Figma window minimized** is no longer cut off after 10 minutes and thrown away when it finishes; the calls that answer `BUSY` meanwhile no longer say it was cancelled. Past 5 minutes the hint says how to end the wait.
- **A server restarted in the middle of a render** could hand the old render's result to an unrelated call: request ids are now unique per process, and the plugin tells a new server that a render is still running, so calls answer `BUSY` instead of stalling.
- **A frame with nothing animated** is refused at once with what to do; Figma's bare "Video export failed" on an animated frame is retryable rather than a reason to stop.
- **`figma_export_video` answers inside its wait**: frames are counted as soon as the video is written, stills are cut only while the call's wait lasts (the rest come back as `framesPending`), and one call waits at most 45 s (`BRIDGE_VIDEO_MAX_WAIT_S`). Stills are at most 1024 px on the long side.
- **ffmpeg**: `BRIDGE_FFMPEG` and `BRIDGE_FFPROBE` name the programs, `figma_status` says whether they run, and the hints say to restart the AI app after installing ffmpeg.
- **`saveTo` paths**: a path inside an allowed folder written another way (a Windows short path, `/tmp` against `/private/tmp`) is accepted; a leading `~` is refused with what to pass instead; a video that cannot be written where asked is saved under a default name with a warning instead of being lost.
- **A finished render is reused only for the same file**, also for another layer it already showed, and a write refused with `BUSY` no longer makes it stale. The timeline's length comes to the microsecond, and a GIF reports its own frame rate and length.
- **Very large videos** are kept as bytes inside the server, not as one long text string.
- **Token mismatches are told apart.** The plugin window shows a fingerprint of its token (the first and last four characters) next to "Connected", and `setup` and `figma_status` show the server's, so two servers with different token files are visible at a glance. `figma_status` separates a refused plugin from a server refused by another server, names the token files, and no longer reports an old refused attempt once the plugin has connected.

## 0.1.0 — 2026-10-14

The first public release, as **Figxel**. The project was called figma-mcp during development.

### Install

- The npm package `figxel-mcp`, with no runtime dependencies. `npx -y figxel-mcp@latest setup` creates the token, copies the plugin into `~/.figxel/plugin`, and prints the token, the manifest to import in Figma desktop, and the entries for Claude Desktop, Claude Code and any other stdio MCP app for your operating system.
- The server keeps `~/.figxel/plugin` current when it starts, so after an update you re-run the plugin instead of importing it again.
- `figxel-mcp --version`, `--help` and `--print-token`; an unknown argument exits with an error instead of starting a server.
- Node.js 22 or later.

### What an agent can do

- 132 tools by default, plus `figma_eval` on opt-in: read, create, modify, style and export in Figma Design files.
- Design systems: components, variants, instances and their properties, styles, variables with modes and scopes, library assets imported by key.
- Prototypes and motion: reactions and flows, keyframe animation, video export to MP4, GIF or WebM in job mode (a client timeout no longer discards a render), and `figma_review_video` for contact sheets and stills.
- Storyboards with `figma_create_storyboard`; `figma_create_animatic` is built and waits for its live run.
- Self-checks: `figma_check_layout`, with its `craft` and `tells` audits, and `figma_check_motion`.
- FigJam and Figma Slides: reads in every editor; 16 board and deck tools whose writes stay refused until live runs verify them.
- Eleven skills (workflow, design, storyboard, motion, critique, design system, design to code, code to design, prototype, FigJam, Slides), served through `figma_get_guide`, ten MCP prompts and `skill://` resources.
- Several AI apps share one Figma connection.

### Safety

- A bridge that listens only on `127.0.0.1:38452`, a 32-byte token handshake, an origin check, exports limited to allowed folders, `figma_eval` off by default, and an editor gate that refuses writes not yet verified in a file's editor.
- One undo step per tool call, and `idempotencyKey` so a retried write never runs twice.

### Renamed from figma-mcp

- MCP server name `figxel`; plugin name in Figma `Figxel`. The plugin's manifest id stays `figma-mcp-bridge`, so a saved token is kept.
- Home folder `~/.figxel`; a token in `~/.figma-mcp` is copied once.
- Selection resource `figxel://session/<id>/selection`; skill folders `figxel-<short>`.

### Project

- MIT licence; CI on Node 22 and 24 across Ubuntu, Windows and macOS; a tag-driven release workflow that publishes to npm with provenance and attaches the plugin as a zip to the GitHub Release.

### Known limitations

- Nothing has been run live on macOS yet.
- FigJam and Slides writes, and `figma_create_animatic`, are refused until their live runs are recorded.
