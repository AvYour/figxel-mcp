# Using Figxel as an Agent

An operating guide for any AI agent driving Figma through Figxel.

This is not a tool list — the tool list is [`docs/reference/tools.md`](../reference/tools.md). This is **how to work**, and every rule below is here because the alternative was measured and failed.

**An agent never reads this file.** A connected agent sees only what the server sends. Every word of that guidance lives in one place, the Agent Skills folders under [`src/skills/`](../../src/skills/), and the same bytes reach a model five ways: a pointer in the server `instructions` at initialize, `figma_get_guide` (the floor every client has), ten MCP prompts, `skill://` resources, and the folders themselves installed as skills `[C-237]`. `src/server/guides.ts` keeps only the `instructions` and a view of the tree under the topic names `figma_get_guide` has always answered. This page is the human-readable record of why; [The skills](#the-skills) below lists what is there.

## The one rule

**Own the brief, and build one section per tool call — checked before the next.** `[C-085]`

A short request ("a pricing page", "an about page for my portfolio") is enough. The agent decides structure, copy, imagery and decoration itself, uses realistic placeholder content where a fact belongs to the user (and lists it at the end), and asks only when a choice would change the whole result. The official Figma MCP's own skills ask for the same thing: batch related work into retry-safe calls, a complete section at a time, and validate once per composition `[C-082]`.

Why a section, not an element and not a page:

- **Not one element per call.** Each call is fast — 8 calls in 0.3 s `[C-071]` — but an agent that places one element and waits shows no initiative: the user ends up dictating every next step.
- **Not a whole page per call.** A 61-node payload has **no observation point**; if element 40 is wrong, the first evidence is the final render, and a picture is not a measurement `[C-070]`.
- **A section per call** (`figma_create_from_spec`) is one undo step, returns every id with its path, reports `font.fellBack` per text, and is small enough to check and fix before the next one.

## The loop

```
read the system  ->  wrapper frame  ->  build ONE section  ->  check + look  ->  targeted fix  ->  next section
```

1. **Read before writing.** `figma_get_design_context` carries layout, text (font, size, line height, letter spacing), paints, effects, and the styles (with ids, library included), variables and components each node uses.
2. **Extract the design system first.** Colours, type scale, spacing, and grid come from the file you are extending — not from a guess about what "looks similar".
3. **Create a wrapper frame** at an empty spot, then **one `figma_create_from_spec` per section** into it. Repeated parts become a component once, then instances.
4. **Check after each section** (`§ Measuring` below) and take one render.
5. **Fix with targeted edits**, never by rebuilding a section that is mostly right. Small edits to existing work use the granular tools directly.

The loop is how each part gets built. What comes before it (a brief, real alternatives) and after it (measured critique) is the process below.

## The process in short

A design made in one pass reads as generated. The 2026-10-09 motion run is the model the skills follow: directors, judges, a build bible, builders and three rounds of critics raised its critic scores from 6.5–7 to 7.5–8; it still lacked styleframes before the build and a lens that held its look against generated defaults, so both are stages here `[C-206]` `[C-208]`. One agent runs every role as a pass with an exit gate, one after another; subagents are an optional speed-up `[C-238]`.

**State the gear first.** It scales the process to the job `[C-239]`:

| Gear | When | Process |
|---|---|---|
| Edit | a word, a colour, one element | match what is there; one check |
| Section | a part added to a design already on the canvas | a three-line brief, two directions in words, one critique round with three lenses |
| Page | a page, screen or deck, or one view on its own such as a landing hero | the full brief, two or three directions, a styleframe of the hero (two on a near tie `[C-268]`), two rounds; with one view, the chosen styleframe is cloned to the target and refined |
| Top | a campaign or brand piece, or one view that must stop a stranger who did not come for it (a poster, an ad in a feed) | the whole process, three styleframes, three rounds |

Motion has its own gears in the `motion` skill (edit, UI micro-motion, sting, piece); a brand, system or reference the user gave is a decision already made at every gear. Styles merely saved in the file are not decided: the brief says whose they are. They are givens when the work extends a design that uses them, or when they are this brief's brand (or nobody's) and match no generated look. Another brand's styles, or a generated look nobody owns, are reference. When the brief's own brand matches a generated look, the agent asks once `[C-269]`.

**A still design** (`design` skill): gear → brief → look → directions → styleframes and the choice → system → build (the loop above) → critique rounds → finish.

**A motion piece** (`storyboard`, then `motion`, then `critique`): brief and inventory → directions and judging → beat sheet on a tempo grid → storyboard (`figma_create_storyboard`) → styleframes → technical probe → animatic (`figma_create_animatic`, a small `figma_export_video`, `figma_review_video`) → build bible → blocking → curves → polish, with `figma_check_motion` after each pass → review rounds → delivery.

**The sign-off bar** ends the rounds: no blocker or major finding, every lens at 8 or above, `figma_check_layout` ok (and `figma_check_motion` ok for motion), every craft and tells info answered, no regression in the last round — or the gear's round budget, three at most `[C-239]`.

**Where the work goes.** From the page gear up, the brief, the directions and the styleframes go on an "Explorations" page, and every motion piece gets a "Storyboard" page; both are allowed by default. Smaller gears work beside the design on the current page. A Starter file holds three pages `[C-048]`, so when a page is refused the agent uses a section on the current page and says so.

**Checkpoint.** By default the agent owns the brief and runs to the end `[C-085]`. When the brief asks to see the plan first — or the `checkpoint` argument of `design_in_figma`, `storyboard_motion` or `animate_in_figma` is `storyboard` — it stops once the decision line and the styleframes exist (for a motion piece, the storyboard and the technical probe too), shows them, and waits for approval.

## Measuring

`figma_check_layout` is the instrument every agent has: per node, with numbers and a fix, it reports text that overflows instead of wrapping, text over text, clipping, nodes sticking out of their parent, low contrast `[C-075]`, zero sizes, empty frames, default names and raw colours. `ok: true` means no errors and no warnings. Read the document, do not eyeball the picture.

On new design, add `audit: ["craft", "tells"]`. `craft` reports finish defects of the kind the 2026-10-09 critics measured (unshared edges, near-equal sizes, tangencies); `tells` reports the measurable signs of generated design, as `info` only until a calibration run shows which rules separate generic from finished work `[C-248]`. Every info is answered: fixed, or kept with its reason in the report.

`safeArea` is passed only where something covers part of the frame (a platform's interface, overscan, trim). A web or app view passes none: its fold is a success line, measured from `figma_get_design_context { absolute: true }` `[C-270]`.

Motion has the same pair of instruments. `figma_check_motion` judges the keyframes frame by frame with no render — a move that pops, a frame that carries most of a move, keys between frames, text on screen too briefly to read — with thresholds taken from the run's findings `[C-246]`. `figma_review_video` mines one render for a contact sheet, every-frame close-ups, frame-exact stills and per-frame metrics, so a review never renders twice `[C-247]`.

For anything these tools do not cover, `figma_eval` (off by default, `BRIDGE_ALLOW_EVAL=1`) can measure directly — the overlap pass `figma_check_layout` now runs looked like this when it was done by hand:

Boxes, overlaps, and frame overflow in one pass:

```js
const nx = await figma.getNodeByIdAsync("11:10959");
const boxes = [], outside = [];
const walk = (n, ox, oy) => { for (const c of n.children || []) {
  const cx = ox + c.x, cy = oy + c.y;
  if (c.type === 'TEXT' && c.characters && c.characters.trim())
    boxes.push({ name: c.name, x: Math.round(cx), y: Math.round(cy),
                 r: Math.round(cx + c.width), b: Math.round(cy + c.height) });
  if (cx < -1 || cy < -1 || cx + c.width > nx.width + 1 || cy + c.height > nx.height + 1)
    outside.push(c.name);
  walk(c, cx, cy); } };
walk(nx, 0, 0);
const hits = [];
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const A = boxes[i], B = boxes[j];
  const ox = Math.min(A.r, B.r) - Math.max(A.x, B.x);
  const oy = Math.min(A.b, B.b) - Math.max(A.y, B.y);
  if (ox > 2 && oy > 2) hits.push(A.name + ' x ' + B.name + ' (' + ox + 'x' + oy + ')');
}
return { boxes, overlaps: hits, outside };
```

Two things this catches that a screenshot does not:

- **Font substitution.** If a text node has no explicit width, `textAutoResize` is `WIDTH_AND_HEIGHT` and it will not wrap — a paragraph came out **2061 px wide inside a 1920 px frame**. Set `textAutoResize = 'HEIGHT'` and `resize(width, height)` to make it wrap, then re-measure.
- **Letter-spacing units.** `letterSpacing` can be `PIXELS` or `PERCENT`. A design authored at `-1 PERCENT` and rebuilt at `-2 PIXELS` looks identical at one font size and silently stops scaling at every other. Match the unit, not the number.

## Choosing a tool

| Intent | Tool | Note |
|---|---|---|
| A section | `figma_create_from_spec` | The default for new work: frames, text, shapes, vector paths, SVG icons, images, instances |
| One frame / container | `figma_create_frame` | The wrapper; `x`, `y`, `width`, `layout`, `background` |
| One text node | `figma_create_text` | Reports `font.fellBack` — read it |
| One shape | `figma_create_rectangle`, `figma_create_ellipse`, `figma_create_polygon`, `figma_create_star`, `figma_create_line`, `figma_create_vector` | |
| Shape operations | `figma_boolean_nodes`, `figma_flatten_nodes`, `figma_set_mask` | Shapes must share a parent |
| Components | `figma_combine_as_variants`, `figma_add_component_property`, `figma_set_instance_properties` | Change an instance without detaching it |
| Property on many nodes | `figma_set_fills`, `figma_set_opacity`, `figma_set_strokes`, … | Per-item `items[]` results |
| Geometry | `figma_move_nodes`, `figma_resize_nodes`, `figma_rotate_nodes` | Per-item results |
| Check it | `figma_check_layout` | After every section; fix errors and warnings. On new design add `audit: ["craft", "tells"]` |
| Look at it | `figma_export_node` | The render as an image the model sees — for judgement, not positions |
| Save renders to disk | `figma_save_screenshots` | Writes files, keeps image bytes out of context |
| How-to for a task | `figma_get_guide` | The skills: no arguments gives the loop, `{ topic: "skills" }` the catalog, and every answer ends with the calls for the rest |
| Plan a motion piece | `figma_create_storyboard`, then `figma_create_animatic` | Panels with derived timecodes and beats; the animatic plays them at their planned pace. Both are unmeasured in Design until their live runs (the `storyboard` skill names the fallback) |
| Check keyframes | `figma_check_motion` | After each keyframe pass and before any render; no render needed `[C-246]` |
| Render motion | `figma_export_video` | Job mode: an answer of `rendering` with a `jobId` is collected by calling again with that `jobId` `[C-249]` |
| See a render | `figma_review_video` | Contact sheet, close-ups, frame-exact stills and metrics from one file; answers while Figma renders |
| Anything not covered | `figma_eval` | Needs `BRIDGE_ALLOW_EVAL=1`; see the eval group |
| A board zone (FigJam) | `figma_create_from_spec` | Stickies, shapes with text, tables, code blocks, and connectors joined by `ref` — one zone per call; `figma_create_stickies`, `figma_create_connectors` and the other board tools for one kind at a time |
| A deck (Figma Slides) | `figma_create_slides`, then `figma_create_from_spec` per slide | Read the deck with `figma_get_slide_grid`; reorder with `figma_move_slides`, never by deleting and rebuilding slides `[C-155]` |

## Files in different editors

The plugin runs in Figma Design files, FigJam boards and Figma Slides decks, and files in all three can be connected at once. A tool runs only where [tools.md § Editor support](../reference/tools.md#editor-support) allows it `[C-129]`. What that asks of an agent:

- **Know which file is which.** `figma_status` lists every connected file with its `editor` and the tools refused there (`unavailableTools`). With files in more than one editor connected, pass `session` (the file name) on every call — without it the most recently active file is used, whatever its editor.
- **A link picks the editor.** A `/board/` link points at a FigJam file and a `/slides/` link at a deck: among files with the same name the one in that editor is used, and a write whose link names another editor's file is refused before anything changes.
- **`UNSUPPORTED` naming an editor means nothing changed** — it carries `safeToRetry: true`, and a write carries `partial: { created: [] }`. The same call in the same file gets the same answer, so switch `session` to the file the hint names, or use the tool the hint offers for this editor. `BRIDGE_ALLOW_UNVERIFIED` is for measuring runs, not a way around a refusal.
- **Read the playbook before the first write.** `figma_get_guide` topic `figjam` or `slides`: a board is a wrapper section with one zone per call and connectors last, in their final parent; a planned deck is built 3–5 slides at a time, then one spec per slide, checked per batch `[C-155]`.

## Safety — what an agent must never do

**Never delete by name search.** `figma_search_nodes` + `figma_delete_nodes` on the results will destroy work you did not create, and there is no version-history access from a plugin to undo it.

Rules that follow from that:

- Delete **by exact id**, and only ids returned by calls you made in this session.
- **Before deleting a frame you built in an earlier session, read it first.** It may already contain work, or be someone else's frame with the same name.
- **Build at separate coordinates.** A new frame goes where it cannot overlap existing work.
- **Never delete a frame you did not create** without asking. If ownership is unclear, leave it and say so.
- Deleting the user's own `Rectangle 1` to "clean up" is not cleanup.
- **Inside an animated frame, use the ids your create calls returned.** For stretches of a second to twenty minutes Figma has listed such a frame's layers under second ids that later stopped resolving, while the created ids kept working `[C-199]`.
- **A render that answers `rendering` is still running.** Call `figma_export_video { jobId }` again to collect it; never start a second render of the same frame `[C-249]`. Keep the Figma window restored while anything renders: a minimized window once stalled an export for about 40 minutes `[C-198]`. Figma ends a render it has not finished in about 4 minutes with `TIMEOUT`: the frame is fine, so render again, then with fewer frames `[C-198]`.
- **No plugin session: report and stop.** An agent cannot start the plugin `[C-068]`. It tells the user, calls `figma_status` once more, and stops; it never polls.

## Failure modes worth knowing

| Symptom | Cause | Fix |
|---|---|---|
| Text runs off the frame | `textAutoResize` is `WIDTH_AND_HEIGHT` | `figma_create_text` in a vertical auto-layout now fills and wraps by itself; otherwise `figma_resize_nodes { sizing: { horizontal: "fill" } }` or a `width` `[C-072]` |
| A `→` or icon looks broken | Drawn from rotated rectangles; rotation is about the centre | Use the glyph — `figma_create_text` reports `fellBack: false` if the font has it |
| A shadow disappears | An opaque neighbour painted over it | Vertical padding on the container `[C-069]` |
| A child's `x`/`y` ignored | `layoutMode` is the string `"NONE"`, which is truthy | Test for `"HORIZONTAL"`/`"VERTICAL"`, never truthiness `[C-067]` |
| One size given pins both axes | Old all-or-nothing sizing rule | Per-axis sizing `[C-066]` |
| `figma_eval` returns `{}` | A node was JSON-serialised | Return plain data: `.id`, `.name`, `.width` |

## Verifying your own work

A vision model describing a render **is not a measurement**, and it disagreed with the Plugin API twice on the same image — once calling a card "clearly cut off" when it ended 200 px inside the frame `[C-070]`.

Use renders for judgement calls. Use `figma_check_layout`, `figma_check_motion` and `figma_get_design_context` for facts, and `figma_eval` for anything they do not cover.

## The skills

Eleven skills, each a folder `src/skills/figxel-<short>/` holding a `SKILL.md` (frontmatter `name` and `description`, then an index) and `references/<section>.md`, one level deep `[C-174]`. The short name is the `figma_get_guide` topic; section slugs are unique across the tree. Four are process skills written for this pass. The other seven carry fifteen of the sixteen earlier topics; the sixteenth, the old `motion` text, is now the `mechanics` section of the `motion` skill. Every old topic name still resolves.

| Skill (topic) | What it is for | Sections |
|---|---|---|
| `workflow` | The loop: orient, wrapper, one section per call, check, polish, report — and where every other skill is | `build`, `spec`, `check`, `safety`, `tools` |
| `design` | A still design from brief to sign-off: gear, brief, look, directions, styleframes, system, build, critique, finish; the tells of generated design | `brief`, `directions`, `system`, `tells`, `finish` |
| `storyboard` | A motion piece planned before its first keyframe: beat sheet on a tempo grid, panels, styleframes, technical probe, animatic, build bible | `beat-sheet`, `boards`, `animatic`, `bible` |
| `motion` | Keyframe craft and Figma Motion's mechanics: gears, easing roles, principles, transitions, kinetic type, formats, blocking → curves → polish | `easing`, `principles`, `transitions`, `kinetic-type`, `formats`, `passes`, `mechanics` |
| `critique` | Measured review: lenses run one at a time, findings in one schema, fixes as tool calls, rounds up to the sign-off bar | `lenses`, `motion-checks`, `sampling`, `rounds` |
| `design-system` | Reusing or creating styles, variables and components; a library built in order; type | `library`, `typography` |
| `design-to-code` | Reading a design faithfully and implementing it; a codebase's design-system rules | `rules` |
| `code-to-design` | Rebuilding in Figma what already exists in code | — |
| `prototype` | Interactions, scrolling, flows | — |
| `figjam` | Boards: a wrapper section, one zone per call, connectors last | `board-recipes` |
| `slides` | Decks: plan every slide, 3–5 slides per batch | `deck-recipes` |

**Getting one.** `figma_get_guide` with no arguments returns `workflow`; `{ topic: "design" }` returns a skill's index; `{ topic: "design", section: "brief" }` or `{ topic: "brief" }` returns a section; `{ topic: "skills" }` returns the catalog. Every answer ends with a footer of at most 1,200 bytes: the exact calls for the skill's other sections, then one line per other skill, so a client with only tools reaches every byte. `{ topic: "motion" }` now returns the new motion index; the earlier motion text is its `mechanics` section. Text from `figma_get_guide` is authoritative over an installed copy.

**Budgets and the drift test.** In UTF-8 bytes: a description at most 300, a `SKILL.md` body at most 5,000 (and 120 lines), a reference at most 10,000, a skill at most 60,000, a prompt message at most 16,000, the `instructions` at most 2,000 with a self-contained first 512 `[C-237]`. `test/skills.test.ts` holds them, and also checks that every surface serves the files' exact bytes, that every `figma_*` call in a skill names a real tool and only its parameters, that every claim a skill cites is verified, measured or a decision, and — locally, where the official plugin is installed — that no run of 12 words is shared with the official skills. Skill text is written in this project's own words.

## Prompts

A prompt is a starting message the user picks from the client's menu, not something the model calls `[C-168]`. Each one is composed from the tree: a preamble, the skill's `SKILL.md` body, at most one section, and a closing line with the calls for the rest. Every argument is an optional string unless marked required.

| Prompt | Arguments | Carries |
|---|---|---|
| `build_in_figma` | `brief` (required) | `workflow` + `build`; a page or more is pointed at `design` |
| `design_in_figma` | `brief`, `checkpoint` | `design` + `brief` |
| `storyboard_motion` | `brief`, `duration` (seconds), `placement` (e.g. "Instagram Story"), `checkpoint` | `storyboard` + `beat-sheet` |
| `animate_in_figma` | `nodeId`, `brief`, `checkpoint` | `motion` + `easing` |
| `critique_design` | `nodeId`, `lens` (one lens or "all") | `critique` + `lenses`, or `motion-checks` for a motion lens |
| `build_board` | `brief` (required) | `figjam` + `spec` (the `figma_create_from_spec` grammar) |
| `build_deck` | `brief` (required), `slideCount` | `slides` + `spec`; a new deck of five or more slides is pointed at `design`'s page gear |
| `design_to_code` | `nodeId`, `target` | `design-to-code` |
| `create_design_system_rules` | `clientLanguages`, `clientFrameworks`, `rulesPath` | `design-to-code` + `rules` |
| `code_to_design` | `source` (required), `target` | `code-to-design` + `spec` |

**`checkpoint`** is `storyboard` (stop for approval once the plan exists — see [The process in short](#the-process-in-short)) or `none`, the default. Claude Code splits a typed line on whitespace across the arguments `[C-176]`, so every preamble reads well with an argument missing or cut short, and a `checkpoint` that is neither word is handed to the agent as part of the brief rather than refused.

## Resources

Resources are offered to the host, which decides whether the model sees them `[C-169]`. Besides the selection (`figxel://session/<sessionId>/selection`), each skill is a resource `skill://figxel-<short>/SKILL.md`, and the template `skill://{skill}/references/{section}.md` lists every section — `text/markdown`, the files' exact bytes, `audience: ["assistant"]`, registered whatever `BRIDGE_TOOLSET` says. The layout follows the MCP skills extension `[C-172]`; its own methods (`skills/list`, `skills/get`) are not served, because no mainstream client consumes them and this server's SDK does not speak that protocol revision `[C-173]`.

## Installing the skills

The folders under `src/skills/` are ordinary Agent Skills, so a skill-capable client can load them directly. A copy in `~/.claude/skills` and one in `~/.agents/skills` cover Claude Code, Codex, Cursor, VS Code and Gemini CLI `[C-175]` `[C-177]` `[C-178]`; `npx skills add AvYour/figxel-mcp/src/skills` installs them into many agents' folders at once `[C-179]`. The usual set is five: `figxel-workflow`, `figxel-design`, `figxel-storyboard`, `figxel-motion`, `figxel-critique`. An installed copy can fall behind the server, and then `figma_get_guide` is the one to trust; contributors link the folders from their clone instead (a symbolic link, or a junction on Windows), so they stay equal to it. Commands per client: [Using Figxel From Any AI App](../clients.md#installing-the-skills).

## Where these rules come from

| Rule | Evidence |
|---|---|
| Own the brief, one section per call, check each | `[C-085]`, following the official skills `[C-082]`; per-call speed `[C-071]` |
| Measure, do not trust a render | `[C-070]` — three vision readings against one API read |
| Per-axis sizing | `[C-066]`, `test/auto-layout-sizing.test.ts` |
| Never trust `layoutMode` truthiness | `[C-067]`, `test/text-wrapping.test.ts` |
| A shadow needs room, not permission | `[C-069]` |
| A plugin cannot be started from outside | `[C-068]` |
| A tool runs only where its editor cell allows; an editor refusal changed nothing | `[C-129]`, `test/editor-gate.test.ts` |
| A board one zone per call, connectors last; a deck a few slides per batch | `[C-155]`, following the official FigJam and Slides skills |
| One source of guidance in `src/skills`, served on five surfaces with `figma_get_guide` as the floor | `[C-237]`; the Agent Skills format `[C-174]`; the skills extension's layout `[C-172]` `[C-173]` |
| The process runs as passes in one agent, scaled by a gear, ended by a sign-off bar | `[C-238]` `[C-239]`; the 2026-10-09 run `[C-206]` `[C-208]` |
| Measure, then look — for motion as for stills | `[C-246]` `[C-247]` `[C-248]`, `test/motion-audit-fixtures.test.ts` |
| A write is ok only when a read-back finds it landed | `[C-250]`; the defects of 2026-10-09 `[C-201]` `[C-203]` |
| A video render runs as a job a client timeout cannot discard | `[C-249]`; the lost render `[C-197]` |
