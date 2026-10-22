# Changelog

Notable changes to `figxel-mcp`, newest first. A version marked **Unreleased** has not been published yet; its heading gets the release date when it is tagged ([CONTRIBUTING.md § Releasing](CONTRIBUTING.md#releasing)).

## 0.3.0 — 2026-10-22

### Added

- **Figxel without a server on your computer: team hubs and Figxel Cloud.** `figxel-mcp hub` runs the bridge on a server behind TLS as a pure relay, with one account per person; the plugin and every AI app connect out to it, and each person reaches only their own Figma, their own files and their own sessions. Exports and imports still happen on the computer of the app that asked. Figxel Cloud, the Moire Labs hub at `mcp.figxel.moirelabs.dev`, is by invitation for now; anyone can run their own hub ([docs/hub.md](docs/hub.md)).
- **Apps by URL and web clients.** With `BRIDGE_HUB_WEB=1` a hub serves MCP over Streamable HTTP at `/mcp`, so claude.ai, ChatGPT, Claude Code, Cursor and VS Code connect with a URL. Files a tool writes come back as download links that last an hour, and a file can be uploaded first to import it. A person's agent (the guides read, the briefs, renders in progress) is kept across sessions, for clients that open a new session for nearly every call.
- **Sign-in like any remote MCP server.** The hub is its own OAuth authorization server `[C-414]`: **Continue with Figma** (a private Figma app admits the members of its team) or **Continue with Google** (the emails the operator lists), or an invite. A browser that signed in is remembered, so the next sign-in, such as the plugin's after Claude's, is one click.
- **The plugin signs in through the browser.** A new plugin window opens on **Welcome to Figxel** with one **Sign in** button: a code, the browser, done. The window was redesigned: a **Figxel Cloud | This computer** switch, **Signed in as**, the token's fingerprint, activity with ✓ and ✗, and **Reset Figxel in this Figma**.
- **`figxel-mcp install`**: the plugin alone, listed in Figma desktop, for Figxel Cloud users. **`join`** and **`leave`**: a team's hub for every AI app on a computer, from an invite. `hub add`, `hub email`, `hub list` and `hub remove` manage the people of a hub.
- **`figma_status`** names the hub and the person a process works as.

### Security

- Isolation between people on a hub: sessions, status, refusals, idempotency keys, editor refusals and plugin windows are each person's own, and removing a person ends everything of theirs at once.
- A limit on refused tokens per address; web sessions read and write only their person's folder, and download links are checked against the real path when made and when served; OAuth with PKCE S256 only, exact redirects, rotated refresh tokens, limited registration, and client documents fetched over https from public addresses only. An independent review of the cloud code found a cross-person download link and four lesser issues, all fixed before release.

### Upgrading

- **Local use is unchanged.** If your plugin already has a token, it connects as before. A new plugin opens on the welcome screen: choose **Use Figxel on this computer instead** and paste the token `setup` prints.

## 0.2.1 — 2026-10-22

### Fixed

- **Playing a Motion timeline in Figma no longer blocks the agent's writes once it stops.** Playback reports as a person's edits, with origin `LOCAL` and under temporary ids, and the playhead reads only while the timeline is active in the editor `[C-404]`, so every write to an animated frame was refused `STALE` while and after the timeline played. The guard now refuses only for a change that still shows: a layer back as the agent last saw it, or a property change on an id that no longer resolves, does not count. While the timeline plays the write is still refused, and the hint says to stop the timeline.
- **A text whose colour comes from keyframes is judged in the colour it shows.** `figma_check_layout` read the static fill under a fill track, so a title keyed white over a dark band was reported as dark on dark (`low_contrast`, 1.00:1) and blocked its sign-off. Before a track's first key that key's colour holds `[C-191]`, so that colour is measured now; under a motion brief, a text whose keys change its colour and whose first frame fails is left to the rendered frames and counted in `restPose`.
- **A thin outline hidden at rest is no longer reported as invisible.** `weak_graphic_contrast` measured a ring at opacity 0 as the ground on the ground ("#ffffff on #ffffff"). A layer that paints nothing is skipped, and under a motion brief a layer its keys move or fade is judged on the rendered frames.
- **A sign-off answer keeps covering its info when Figma changes a layer's id.** While Figma lists an animated frame's layers under temporary ids `[C-199]`, the ids changed between two sign-off calls and the answers stopped matching. An answer that names the same layer by another of its ids covers it now.
- **A batch of slow steps no longer stops as stalled.** `figma_batch` muted each step's own progress, so a run of long keyframe writes answered `STALLED` or `CANCELLED` although every step worked on its own. A step's progress now reaches the bridge, and a cancel is read between steps.
- **No tool description reads like an instruction to the model.** A client's prompt-injection scanner flagged `figma_set_text_range` for the words "design system:". The descriptions are reworded, and a test keeps such phrases out.

## 0.2.0 — 2026-10-21

### Upgrading

- **New work now waits for a brief.** Under `BRIDGE_PROCESS=strict`, still the default, a new top-level frame, a spec into an empty frame, a new deck or board answers `PROCESS_REQUIRED` until the agent has read its role's skill and recorded a brief with `figma_set_brief`; a final export (`final: true`) waits for `figma_sign_off`. The refusal names the calls that satisfy it, and edits are never gated. Set `BRIDGE_PROCESS=guided` for warnings instead, or `off` for the old behaviour.
- **A write can now answer `STALE`** when you edited the node after the agent last read it; the agent reads it again and repeats the write. `BRIDGE_CONFLICTS=off` turns the check off.

### Added

- **The role process: the agent works as the professional the task needs.** Eight roles — UI/UX, graphic, illustration, brand, presentation, design system, board and motion — each with its own workflow, planning before the work and testing after it. `figma_set_brief` records the brief in the file (on a brief block beside the work), `figma_get_brief` reads it and lets a second agent continue it, and `figma_sign_off` ends the work: it runs the role's audits on the deliverables, takes the agent's critique scores, rounds and reasons, and records a sign-off with a content fingerprint, which a final export of `figma_export_node`, `figma_export_frames_to_pdf` (both gain `final`) or `figma_export_video` waits for. `figma_status` shows the open briefs.
- **Trust: the agent never silently overwrites your edits.** A write to something you or a collaborator changed after the agent last read it answers `STALE` and changes nothing until the agent reads it again (`BRIDGE_CONFLICTS`: `refuse` by default, `warn` or `off`; `force: true` per call). `figma_get_changes` lists the write calls the agent sent to the file; `figma_savepoint` marks the start of an instruction and `figma_rollback` takes it back in one step, only when that undoes nothing of anyone else's — not yours, not a collaborator's, not another app's sharing the connection — and otherwise offers to delete what the agent created. 140 tools by default.
- **`figma_stress_test`**: copies of a frame with translated text (grown as IBM's translation figures say), longer names, bigger numbers, and many or no list items, each checked, with what broke mapped back to your layers.
- **Role audits in `figma_check_layout`**: `a11y` (target sizes per platform, focus states and indicators, input boundaries, errors shown only in colour, unlabelled inputs, text in fixed boxes), `states` (the states each control type needs, declared screen states), `copy` (generic labels, mixed capitalisation, interjections, bare error codes, variant spellings), `system` (format, type scale, spacing, grid, palette, optical margins), `deck`, `mark`, `icons` and `library`. `briefId` measures against a brief; by default, the brief the checked work belongs to, else the brief in force.
- **Three skills: `ux`, `graphic` and `brand`**, and a slides `story` section; every role skill names its role's workflow and sign-off.
- **`figma_set_motion_plan` takes the fields it leaves out from the motion brief.**
- **Quality first: work that reads as a professional's, not as generated.** After a full product redesign still read as generated, the role process now stops the generic look instead of only describing it:
  - **A brief can name what it avoids, and the list binds.** `figma_set_brief` takes `avoid` (tells kinds, such as `card_trio` or `cluster_6`). At the page and top gears a match is a warning that no answer clears at sign-off.
  - **Tells run while you build.** `tells` runs by default under a page or top brief, and every `figma_create_from_spec` result says which tells the new section added.
  - **Sixteen new tells kinds** for the look generated product screens fall into: a repeated skeleton across screens, flat spacing rhythm, boxes in boxes, a centred stage; the dashboard kit (icon tiles, KPI tiles with sparklines, greeting titles, the accent on chrome); one hue posing as two; reflex display faces; and the six generated looks counted as clusters.
  - **A reviewer who did not build it.** At the top gear, sign-off refuses the message and originality scores when the builder gave them itself. The new `critique_cold` prompt sets up a reviewer in a fresh context who judges from the brief and the renders before reading any numbers, or the owner scores. At the page gear a self-review is recorded as such.
  - **`figma_get_brief` answers the next stage of an open brief** and what it still lacks.
  - **Skills.**
    - A `screens` section in the ux skill: app screens and dashboards, with pattern recipes for settings, dense tables, empty states and a command bar.
    - The brief decides light or dark from one sentence of physical scene.
    - The system names a mode and a colour strategy before colours, with icon rules.
    - The critique judges before it reads the numbers, and treats an empty "clean" page as a major finding.
- **`figma_check_layout { audit: ["handoff"] }`: can this frame be handed on?** It reports the share of the frame's solid paints, texts, auto-layout spacing and corner radii that are bound to the file's variables or styles, as numbers and a one-line verdict. It also flags a frame detached from a component (`detached_instance`, a warning that names the component), and a local style the frame uses that repeats another style or a colour variable (`duplicate_style`, info). A file with nothing to bind to yet is told so instead of being graded. Asked for by a designer after the launch.

### Changed

- **`low_contrast` skips inactive components and reports logotype text as info**, as WCAG 2.2 exempts them; `min_text` takes its default floor from the brief's platform (11 pt on iOS).

### Fixed

- **A motion plan keeps working while Figma lists an animated frame under temporary ids.** For stretches of a second to about twenty minutes, Figma lists the layers of an animated frame under second ids and may show the frame twice on the page. Then `figma_check_motion` and `figma_sign_off` stopped with "the frame's motion plan names `brandId` …, which is not among the layers read", `figma_set_motion_plan` refused the frame's own layers as "not inside" it, and `figma_search_nodes` found the frame and its layers twice. The check now maps the plan's brand and CTA layers, and those a call names, to the layers it lists, and when it cannot it says why: an older plugin to re-run, two lookalike layers it cannot tell apart, a read cut short by `maxNodes`, a layer no longer in the frame, or an id that resolves to nothing. The plan accepts its frame's layers through either id, and warns when it stores one of those temporary ids or when the page lists the frame twice; a passing check counts under every id the page lists the frame under, so the final render finds it; search lists each layer once, while stacked lookalike layers stay two; and a sign-off reports a plan layer the check did not find as a blocker with what clears it, instead of failing.
- **A motion piece whose scenes stack in one frame can be signed off.** `figma_sign_off` checked the animated frame as a still, where every scene sits on top of the last, so a piece that passed `figma_check_motion` and its reviews still failed on covered, overlapping and clipped text and on layers parked outside the safe area, and its final render was refused. Under a motion brief, sign-off and `figma_check_layout` now judge layout where the viewer sees it: what rests on where keys park a layer is left to the rendered frames and counted in `restPose`, and static layers, and layers that move together, are checked as before.
- **No more `STALE` refusals for the agent's own changes.** Figma can report a write's changes seconds or minutes late, sometimes as if a collaborator made them. The trust layer now decides by content: a change that leaves a node as the agent last wrote or read it is the agent's, however late it arrives, and a re-colouring that follows a variable the agent changed is not yours. Your real edits are still protected, and a rollback is now also refused after you change a variable or style by hand.
- **`figma_check_layout` measures work against its own brief.** Without `briefId` it used the brief most recently opened in the session, even on another brief's work: a UX screen checked after a motion brief was set got the motion brief's 32 px text floor and safe area, and 171 false warnings. Now work that belongs to a brief — the node's own record, its top-level frame's, or a brief listing it among its deliverables — is measured against that brief, which outranks the one in force, and `audit.brief` says which brief was used and why (`from`). `figma_sign_off` without `briefId` picks the brief the same way, so it no longer signs a screen off against the wrong brief; `figma_get_brief` says whether it found a node's brief by the node or only by its page (`from`).
- **`chrome_string` no longer reads clock times as numbering.** A timetable's "07:20" and "07:38" were reported as "numbered 01, 02, …"; a time leading a text (07:20, 07:20:15, 06h45, 7 pm) is now left out of the 01/02 count.

## 0.1.1 — 2026-10-14

### Added

- **The motion process, enforced by the tools** (`BRIDGE_PROCESS`, default `strict`): `figma_set_motion_plan` records a frame's brief and beat sheet, checked before it is stored (beats on the frame grid, back to back, each long enough to read, accents on the beat grid) and kept in the file; `figma_set_keyframes` and `figma_remove_keyframes` answer the new `PROCESS_REQUIRED` until the agent has read the motion skill and the frame has a plan; `figma_export_video` takes `final: true` for the delivery render, which waits for a `figma_check_motion` that passed as the plan's own check (it applies the plan's tempo, holds, brand and CTA, and its `accept`, the findings the brief intends, each with a reason the delivery's result repeats) with no change to the file since, by any write or any change Figma reports, while previews always render. `guided` turns the refusals into `processWarnings`; `off` turns the checks off. The motion skill opens with the senior motion designer's role and the stages in order. A final call that names a render already running or done (its `jobId`, or the same settings) attaches to it before the check is read, so a delivery retried after a client timeout collects its own render.
- **A guide for people**, `docs/usage.md`: what to ask, what the agent does on its own, how to review its work, and the motion process setting.
- **`figma_check_motion` takes `beatTimes`**, the beat times of a music track in seconds, and checks accents against them instead of the `bpm` grid.
- **`setup --register`**, optional: with Figma desktop closed, it lists the plugin under Plugins → Development by writing into Figma's settings file the same entries an import writes, after a backup next to it, so the manual import can be skipped. It refuses while Figma runs or when the file is not in the measured form, and changes only Figxel's entries. `--dry-run` shows the change and writes nothing, `--force` moves a registration from another folder, and `setup --unregister` removes the entries. The file's form was measured on Windows; macOS is experimental, and whether Figma then lists the plugin is not yet verified live.
- 133 tools by default, 134 with `figma_eval`: `figma_set_motion_plan` is new.

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
