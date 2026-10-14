# Using Figxel

How to work with an AI agent that has Figxel: what to ask, what it does on its own, and how to check what it made. This page is for people. The agent gets its own guidance from the server (the skills under [`src/skills/`](../src/skills/)), and [Using Figxel as an Agent](agents/using-the-mcp.md) explains why each of its rules exists.

It assumes Figxel is set up; the [README Quickstart](../README.md#quickstart) takes a few minutes. Ids such as `[C-198]` point to the [claim registry](reference/claims.md), where each external fact has its source and the date it was checked.

## Your first session

### 1. Check the connection

1. In Figma desktop, open the file you want to work in and run the plugin: **Plugins → Development → Figxel**. Leave it running. No agent can start it for you: Figma has no command or link that runs a plugin `[C-016]`.
2. In your AI app, ask: *"Call figma_status."*
3. The answer lists every connected file with its editor (Figma Design, FigJam or Figma Slides) and the tools that do not run there (`unavailableTools`).

If it says no plugin is connected, run the plugin again. If it asks for a restart (`restart: "plugin"` or `restart: "client"`), close the plugin window and run it again, or restart your AI app, as the hint says. [Troubleshooting](../README.md#troubleshooting) covers the rest.

### 2. Pick a file and a spot

- **Work in one file.** When several files run the plugin, a call goes to the most recently active one unless the agent names a file. Name the file in your request when more than one is connected.
- **Point at things** by selecting them in Figma ("the selected frame") or by pasting a Figma link to a layer. Every tool that takes a layer accepts its id or a link.
- **Leave the spot to the agent.** New work goes into a new frame at an empty spot on the current page, never on top of what is there. Say where if you care: "to the right of the Home screen", "on the Marketing page".
- **Expect a working page.** For a page or anything bigger, the agent keeps its brief, directions and styleframes on an "Explorations" page, and a motion piece gets a "Storyboard" page. Say "no new pages" to keep them in sections on the current page instead. A Starter file holds only 3 pages `[C-048]`; then the agent uses sections and says so.

### 3. Let the agent work

Give it a job, for example *"Design a landing page hero for a fictional pottery studio."* Without asking you step by step, the agent:

1. Reads its skill with `figma_get_guide` and states the gear: how big the job is ([Gears](#gears-how-big-the-job-is)).
2. Looks at the file: your selection, the pages, and the type, colours, spacing and styles of an existing screen.
3. Writes a short brief and, for a page or bigger, compares two or three directions on styleframes before it chooses one.
4. Creates a wrapper frame at an empty spot and builds one section per call with `figma_create_from_spec`.
5. Checks each section with `figma_check_layout` and one render, and fixes what it finds with targeted edits.
6. Runs critique rounds, then selects the result and zooms to it (`figma_select`, `figma_zoom_to`).
7. Reports what it built, the choices it made, the placeholder content to replace, and anything left open.

Facts only you know (your prices, your bio, client names) become realistic placeholders listed at the end, instead of a stop to ask `[C-085]`. The agent asks only when a choice changes the whole result, such as which of two files to use, or when your code and your Figma file disagree on a token.

## How to ask

### A brief beats a command

A command makes you the designer: *"Add a blue button under the heading"* gets exactly that. A brief lets the agent design: it decides structure, copy, imagery and every size from what you want to achieve. For anything new, give a brief:

| Part | What to say | Example |
|---|---|---|
| Audience | Who it is for | Adults who have never touched clay |
| Message | The one thing it must say | You can make something real in one weekend |
| Format | Size, medium, placement | Desktop landing page, 1440 wide |
| Tone | How it should feel | Warm and a little playful, not rustic |
| Constraints | What is fixed | Our logo and colours from the Brand page; must show dates and price |

A brief can be one line. What you leave out, the agent decides and reports. What you give (a brand, a style guide, a reference) it treats as decided, and it varies only what you left open. Commands are still right for small edits: *"Change the price on the selected card to 45 EUR."*

### Gears: how big the job is

The agent scales its process to the job and states the gear at the start of its first reply `[C-239]`:

| Gear | When | What the agent does | Critique rounds |
|---|---|---|---|
| Edit | A word, a colour, one element | Matches what is there; one check | 0 |
| Section | A part added to a design already on the canvas | A three-line brief, two directions in words | 1 |
| Page | A page, a screen, a deck, or one view on its own, such as a landing hero | The full brief, two or three directions, a styleframe of the hero | 2 |
| Top | A campaign or brand piece, or one view that must stop a stranger who did not come for it, such as a poster or a feed ad | The whole process, three styleframes | 3 |

Motion has its own gears: edit, UI micro-motion (one component changing state, under about a second), sting (one beat under about 2 s, such as a logo sting) and piece (an ad, a reel or a title with several beats).

If the agent picks a gear you did not mean, say so: *"This is a section, keep it light"* or *"Treat this as top gear."*

### Seeing the plan before the build

By default the agent runs to the end. To approve the direction first, say so in the brief:

- *"Show me the directions and styleframes before you build, and wait for my OK."*
- For motion: *"Stop after the storyboard so I can approve it."*

The agent then stops once the plan exists (for motion: the storyboard, the styleframes and a test of every technique it has not tried before), selects it in Figma and waits. Reply *"Approved, go ahead"*, or with changes. The prompts below offer the same choice as their `checkpoint` argument, set to `storyboard`.

### Prompts in your app's menu

Apps that show MCP prompts offer ten starting points, such as `design_in_figma`, `storyboard_motion`, `animate_in_figma`, `critique_design`, `build_board` and `build_deck`. Claude Code lists them as `/figxel:design_in_figma` and splits what you type after one on spaces `[C-176]`; VS Code lists them as `/figxel.design_in_figma` `[C-178]`. [Using Figxel as an Agent § Prompts](agents/using-the-mcp.md#prompts) has every argument.

You do not need them. A plain message works, because the server tells every agent to read its skill before it designs, animates or reviews.

## Example requests

Each example is a message you can paste, followed by what to expect. Slow Wheel is a fictional pottery studio.

### A landing page

> Design a landing page for Slow Wheel, a pottery studio that runs weekend wheel-throwing classes. Audience: adults 25 to 45 who have never touched clay. Message: you can make something real in one weekend. Desktop, 1440 wide. Tone: warm, a little playful, not rustic. It must show the next class dates, the price and a booking button.

What to expect:

- **Page gear**, two critique rounds.
- On an Explorations page: the brief, a "Direction 0" (the obvious version, written down so it can be avoided) and two or three real directions, then a styleframe of the hero for the leading one.
- The page in a new frame at an empty spot, built section by section (header, hero, classes, pricing, footer), each checked before the next.
- A report with the placeholders to replace: dates, price, address, photos.

For something smaller, ask for less: *"Add a FAQ section under the pricing table."*

### A screen from existing code

> Rebuild the settings screen from `src/app/settings/page.tsx` in Figma, on the App page. Take fonts, copy and components from the code; default state first.

This needs an AI app that can read your project's files. What to expect:

- Content and fonts come from the code, never invented. The agent checks that Figma has the code's fonts (`figma_get_fonts`) and flags any text that fell back to another font.
- Components the file already has are reused as instances; a new one becomes a component once, then instances. Your SVG icons are imported as they are (`figma_import_svg`), never redrawn.
- Local images can be imported only from the exports folder or a folder listed in `BRIDGE_EXPORT_ROOTS` ([Configuration](../README.md#configuration)), so the agent asks you to add the folder, or copies the file there.
- One question you will get: when a value in the code and a Figma token disagree, it asks which one wins.

The other direction works too: paste a Figma link and ask the agent to implement the design in your stack. It reads the design and its render, downloads the assets (`figma_download_assets`), and compares its result with the render.

### A design system and tokens

> Set up tokens in this file for Slow Wheel: colours (clay, cream, charcoal and neutrals), spacing on a 4 px scale, radius, and text styles for display, heading, body and label. Light and dark modes. Then make a Button component with Size and State variants.

What to expect:

- The agent first reads what the file has (`figma_get_styles`, `figma_get_variable_defs`) and decides whose system it is: it applies your own, and treats another brand's styles as reference only.
- Then, in order: a variable collection with a whole token family per call, with scopes and code names; colour, text and effect styles; components with properties and variants; the Dark values of each variable.
- Variable modes are a paid-plan feature: in a Starter file Figma refuses the second mode, and the agent reports it `[C-047]`. The Plugin API keeps every plan limit `[C-045]`.
- Library components, styles and variables are imported by key (`figma_import_library_assets`), read from a screen that uses them or from the library file open in Figma too.

### Editing an existing design

> In the selected pricing card, make the price larger and align it with the plan name. Keep everything else as it is.

What to expect:

- **Edit gear**: targeted edits that match what is there (the file's styles, sizes and spacing), then one check. No rebuild, no new pages.
- Only what you asked changes. A small edit is one tool call, so it is one undo step ([Undo](#undo-and-what-the-agent-deletes)).
- A larger change to a design on the canvas, such as *"add a testimonials section in the style of this page"*, runs at the section gear: two directions in words, one build, one critique round.

### A motion ad or social reel

> Make a 12-second Instagram Reel ad for Slow Wheel's weekend class, 1080×1920 at 30 fps. Audience: people scrolling on a Sunday evening. Message: book a weekend, leave with your own mug. End on the booking URL and the logo. Stop after the storyboard so I can approve it.

The agent works like a motion designer, and by default the tools hold it to that order ([The motion process setting](#the-motion-process-setting)):

1. **Brief and directions**, on a "Storyboard" page.
2. **Beat sheet and storyboard.** The beats on a tempo grid, then timed panels with `figma_create_storyboard`. Every line of copy stays on screen long enough to read `[C-241]`.
3. **Styleframes** at delivery size, and a test of every technique it has not tried before. With *"stop after the storyboard"*, the agent stops here and waits for you.
4. **Animatic and build bible.** `figma_create_animatic` waits for its live verification, so the agent may build a rough animatic by hand or skip it, and says which.
5. **The plan on the frame.** `figma_set_motion_plan` stores the brief and the beats on the ad's frame, after checking them: times on the frame grid, no gaps, every beat long enough for its copy. Keyframes are refused until the frame has a plan.
6. **Animation in passes**: poses on the beats, then curves, then polish, with `figma_check_motion` after each pass. It judges every frame from the keyframes, without a render.
7. **Preview renders** with `figma_export_video`, looked at with `figma_review_video`, over up to three critique rounds `[C-239]`.
8. **The final render**: `figma_export_video` with `final: true`, which runs only after `figma_check_motion` passes at the delivery frame rate with no keyframe change since.
9. **Sound**, when the brief has it. Figma's video export has no audio `[C-184]`, so sound is joined to the final render: `figma_add_audio` mixes the tracks onto it without encoding the picture again. Give the agent your own track and it reads the tempo and beats first (`figma_analyze_audio`), so the hits land on the music's real beats; without one, `figma_generate_audio` makes a simple bed and effects offline. Use only audio you have the rights to.

What to expect:

- A `PROCESS_REQUIRED` answer in the transcript is not a failure. Nothing changed; the answer names the step that comes first, and the agent takes it and carries on.
- Renders land in the exports folder (`~/.figxel/exports` by default) as MP4, GIF or WebM `[C-026]`. A long render answers with a job id that the agent collects later, so a short tool-call timeout does not lose it `[C-249]`.
- Motion is a Figma beta that Figma turns on per user `[C-115]`. Without it the motion tools answer `UNSUPPORTED`, and the agent delivers the static design and tells you.
- `figma_review_video`, `figma_analyze_audio` and `figma_add_audio` need ffmpeg on your PATH, or named by `BRIDGE_FFMPEG`; `figma_generate_audio` does not. Without ffmpeg the agent judges from `figma_check_motion` and still frames, and says the motion itself was not seen.
- Keep the Figma window restored while it renders ([Tips](#tips)).

Smaller motion follows a lighter path: *"Animate the selected toggle switching on, using our duration tokens"* is UI micro-motion, with a one-beat plan, one check, a small GIF and a reduced-motion version.

### A critique of a design or a video

> Critique the selected landing page as a panel of senior designers. Report only; do not change anything yet.

What to expect:

- A **cold read** first: from the renders alone, what is seen first, second and third, and the takeaway in one sentence, compared with the brief.
- Then the **lenses**, one at a time: message; type and composition; colour and imagery; copy; originality; finish QA. Each finding has a severity (blocker, major or minor), the measured numbers and a fix written as tool calls, and each lens gets a score out of 10.
- Without "report only", the agent applies the fixes in rounds until the sign-off bar (no blocker or major, every lens at 8 or above, `figma_check_layout` clean) or the round budget, three at most `[C-239]`.

For an animation in the file, the lenses are motion craft, design and type, technical QA, the brief's own lens and originality, measured with `figma_check_motion` and a render reviewed frame by frame.

For a video made elsewhere, put the file in the exports folder (or a folder listed in `BRIDGE_EXPORT_ROOTS`) and ask:

> Review `reel-v3.mp4` in the exports folder: a contact sheet, close-ups of each transition, and anything that freezes, flickers or jumps.

`figma_review_video` returns a contact sheet, close-ups, stills and per-frame metrics, and writes each image beside the video. The keyframe check needs the animation in Figma, so for an outside video only the video review applies.

### A FigJam board

> Summarize the stickies on this board by theme, and list the action items with their owners.

Reads, search and checks run on boards today. The board writes (stickies, connectors, tables, sections and the rest) are built and unit-tested, but Figxel refuses each one until a live run on a real board verifies it; `figma_status` lists what a board refuses `[C-129]`. A refusal changes nothing.

Once board writes are verified, a request such as *"Make a sprint retro board: went well, to improve, actions, and a voting area"* runs like a design: a wrapper section, one zone per call, connectors last, and a board check after every zone. To try the writes before then, `BRIDGE_ALLOW_UNVERIFIED=1` lets them run. It is meant for measuring runs, so use a copy of the board: undo on boards is not yet measured `[C-151]`.

### A Slides deck

> Read this deck and draft speaker notes for each slide here in the chat. Then export the deck as a PDF.

Reads and the PDF export run in decks today (`figma_get_slide_grid`, `figma_export_frames_to_pdf`). Deck writes wait for live verification, as on boards.

Once they run, a new deck of five or more slides is a page-gear job: a brief, two or three directions, styleframes of a title slide and a content slide, a plan for every slide, then three to five slides per batch, each batch checked. Restyling an existing deck happens in place: the agent never deletes slides to rebuild them unless you ask to start over `[C-155]`.

## Reviewing the agent's work

### Checks and renders

- **`figma_check_layout`** measures a frame and returns numbers with a fix for each finding: text that overflows instead of wrapping, overlapping or clipped content, low contrast, placeholder copy, and raw colours where the file has styles. With `audit: ["craft", "tells"]` it adds finish defects and signs of a generated look. `ok: true` means no errors and no warnings. Ask for it on any frame: *"Run figma_check_layout with the craft and tells audits on the hero and list the findings."*
- **Renders** (`figma_export_node`) are for judgement. Positions and sizes come from the document, not the picture: a model once called a card cut off that ended 200 px inside its frame `[C-070]`. To keep renders, ask the agent to save them (`figma_save_screenshots`); they land in the exports folder.
- **The report** at the end lists the choices, the placeholders and what remains. A finding kept on purpose is named there with its reason.

### Videos

- `figma_export_video` writes the file and says where. A preview and a final render with the same settings are the same video: `final: true` only marks the delivery, and it is the step the motion process checks.
- `figma_review_video` cuts a render into a contact sheet, every-frame close-ups and frame-exact stills, and writes them beside the video, so you can see what the agent saw.
- `figma_check_motion` gives the numbers behind a motion finding: the layer, the frame and the size of the jump.

### Undo, and what the agent deletes

- **One call, one undo step.** Every write call ends with one undo boundary `[C-023]`, so Ctrl+Z in Figma (Cmd+Z on macOS) takes back the agent's most recent call `[C-059]`. A whole section built with `figma_create_from_spec` is one call. On boards and decks this is not yet measured `[C-151]`.
- **Undo through the agent reaches further.** `figma_undo_step` asks for confirmation because it returns to the agent's last checkpoint, so a change you made by hand since then can go too `[C-024]`. If you have edited by hand, ask the agent to delete what it created instead (`figma_delete_nodes`).
- **The agent deletes only what it created**: by exact id, and only ids its own calls returned in this session. It never deletes by searching for a name, never deletes a frame it did not create without asking, and builds at an empty spot so it never covers your work.
- **Its working pages are yours.** Delete the Explorations or Storyboard page once you no longer need it.

## The motion process setting

`BRIDGE_PROCESS` decides how strictly the tools hold an agent to the motion process. With **`strict`**, the default, `figma_set_keyframes` and `figma_remove_keyframes` answer `PROCESS_REQUIRED` until the agent has read the motion skill in this session and the frame has a plan (`figma_set_motion_plan`), and a final render (`final: true`) waits for a passing `figma_check_motion` at its frame rate since the frame's last keyframe change; previews always render, and a refusal changes nothing. With **`guided`**, those calls run and their results list the skipped steps as `processWarnings`, which suits a quick retime of an animation planned elsewhere. With **`off`**, nothing is checked. The plan is stored in the file and survives restarts; the rest belongs to the running server, so after your app restarts the agent reads the skill and runs the check again. Keyframes you change by hand are not seen, so ask for a fresh `figma_check_motion` before the final render. Set the variable in the server entry's environment, as [Configuration](../README.md#configuration) shows.

## Tips

- **Keep Figma restored, not minimized, while a video renders.** Behind other windows is fine; it does not need focus. A minimized window once stalled a render for about 40 minutes, and Figma ends a render it has not finished after about 240 s `[C-198]`. If renders keep ending in that timeout with the window restored, quit and reopen Figma desktop `[C-318]`. While Figma renders, the agent's other Figma calls answer `BUSY` and change nothing.
- **One file at a time.** Run the plugin in the file you are working in, or name the file in your request when several are connected.
- **Let a call finish before you edit the same frame.** If you change something the agent built, tell it, so it reads the frame again before its next edit.
- **Long calls and timeouts.** Each app has its own tool-call timeout. Codex waits 60 s by default `[C-287]`, Claude Desktop cut a video call at about 60 s `[C-197]`, and others wait far longer ([the table](clients.md#tool-call-timeouts-differ-a-lot), with how to raise them). After a timeout the agent can retry a write with the same key, and it never runs twice. Video renders run as jobs, so a timeout does not lose them `[C-249]`.
- **Apps with a tool limit.** VS Code allows 128 tools per request `[C-286]` and Windsurf 100 `[C-289]`, fewer than Figxel registers. Untick tools in the app's picker, or set `BRIDGE_TOOLSET`: `core` gives 20 tools for building and checking still designs, with no motion tools. For motion, keep at least the `read`, `style` and `export` groups, which hold `figma_check_motion`, the keyframe tools with `figma_set_motion_plan`, and the video tools ([tools.md § Trimming the toolset](reference/tools.md#trimming-the-toolset)).
- **Starter files.** A Starter file holds 3 pages `[C-048]` and has no variable modes `[C-047]`. The agent works around the page limit with sections, and reports Figma's refusal of a mode.
- **ffmpeg** on your PATH enables `figma_review_video`, the audio analysis and mix, and the frame-exact stills of `figma_export_video`; `BRIDGE_FFMPEG` names it when it is elsewhere, and `figma_status` says whether it runs.
- **Files go to the exports folder.** Renders, PDFs and saved screenshots land in `~/.figxel/exports` unless you allow other folders with `BRIDGE_EXPORT_ROOTS`.
- **If the plugin stops mid-task**, the agent tells you what it built so far, checks once more and stops, instead of waiting. Run the plugin again and say *"continue"*.

## Where to go next

- [README](../README.md): setup, [Configuration](../README.md#configuration), [Privacy](../README.md#privacy) and [Troubleshooting](../README.md#troubleshooting).
- [Using Figxel From Any AI App](clients.md): setup per app, tool-call timeouts, and [installing the skills](clients.md#installing-the-skills) into apps that load them.
- [Using Figxel as an Agent](agents/using-the-mcp.md): how the agent works and why each rule exists.
- [The skills](../src/skills/): the exact text the agent reads.
- [Tool catalog](reference/tools.md): every tool, its parameters, and [which editor runs it](reference/tools.md#editor-support).
- [Roadmap](reference/roadmap.md#next-steps): what comes next, including the live runs for FigJam and Slides.
- Found a problem? [Open an issue](https://github.com/AvYour/figxel-mcp/issues).

New since 0.1.0: sound for motion pieces (`figma_analyze_audio`, `figma_generate_audio`, `figma_add_audio`), and `setup --register`, which lists the plugin in Figma desktop so the manual import can be skipped ([Quickstart](../README.md#quickstart)). The [changelog](../CHANGELOG.md) has the rest.
