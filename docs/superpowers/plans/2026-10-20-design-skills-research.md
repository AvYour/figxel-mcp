# Design skills on GitHub: what Figxel can learn — research record, 2026-10-20

The owner suggested looking at published design skills (2026-10-20). A research subagent read about fifteen of them and reported. This record keeps what matters for Figxel, in our own words.

The external facts here (licences, star counts, the skills' measurements) come from that subagent, read on 2026-10-20. They are **not** in `docs/reference/claims.md`. Any of them that shapes the design is registered, with its quote, before it is relied on, as the [feature research](2026-10-19-feature-research.md) did. The one fact already registered is the Heroicons package layout [C-399].

## The short version

- **Process and measurement.** Figxel is already ahead: Direction 0, the clusters, cold reads, severity caps, sign-off.
- **The owner's complaint lands where Figxel has nothing.** There is no guidance for app screens and dashboards, no rule for choosing light or dark, and no guard against a page made "clean" by being empty.
- **One source covers app screens with numbers:** taste-skill's app-screens chapter. Its evidence is weak:
  - a study of 23 screens chosen by its own owner;
  - critique scores given by model jurors, not people;
  - in its own blind tests, the skill beat the baseline in a minority of rounds.
- So its numbers are a starting point to test, not rules to adopt.

## Sources, most useful first

| Source | Licence (as reported) | What it adds |
|---|---|---|
| Leonxlnx/taste-skill (`SKILL.md`, `references/app-screens.md`, `critique.md`, `research.md`) | MIT | Measured app-screen rules; a dashboard-kit look; score caps; count of left edges; one layout word per section |
| pbakaus/impeccable (`SKILL.md`, `reference/craft-floor.md`, `new-work.md`, `operate.md`, `critique.md`) | Apache-2.0, with a NOTICE | Modes (persuade, operate, read, experience); a named colour strategy; light or dark from the physical scene; a dated list of reflex display faces; critique that judges before it reads the detector |
| funboy322/avoid-ai-design | MIT | "Dark mode nobody asked for"; an icon in a tinted chip; a stat strip; a silhouette test; severity by who notices; what not to over-flag |
| anthropics/skills `frontend-design` (Figxel already cites it) | Apache-2.0 per skill | Unused ideas: spend boldness in one place; remove one accessory before finishing; the hero-metric default |
| jakubkrehel/make-interfaces-feel-better (`icons.md`, `surfaces.md`) | MIT | Icon stroke matched to text weight; native sizes only; outline by default, fill for the active state; concentric radius only for small insets |
| Dammyjay93/interface-design | MIT | The signature shown in five places; token names that evoke a world |
| vercel-labs/web-interface-guidelines | MIT (the skill wrapper has no licence) | Optical alignment; nested radii; icon and text lockups |
| ibelick/ui-skills (`improve-ui`) | MIT | Try to falsify each finding before reporting it; at most three findings |
| emilkowalski/skills (`emil-design-eng`) | MIT | Animate by how often the user sees it; short UI durations |
| nexu-io/open-design `critique` | Apache-2.0 | Keep, fix and quick-win lists; do not average failures away |
| nextlevelbuilder/ui-ux-pro-max | MIT | A counterexample: lookup by category recommends the category's default (dark, glass dashboards) |
| anthropics/claude-cookbooks, frontend aesthetics | MIT | A lesson: a list of "distinctive" fonts becomes the next default |

Text is rewritten, not copied. Copying would need the licence kept: for MIT, the copyright and permission notice; for Apache-2.0, the licence text, the NOTICE file and a note of changes.

## Ideas, and where they go

| Idea | Where in Figxel | Workstream |
|---|---|---|
| **An app-screen chapter for the ux role.** See the bullets below the table | A new section of the `ux` skill | Role quality H1 (pattern recipes) |
| **A sixth cluster, "the dashboard kit".** A navy or saturated sidebar, an icon tile on every KPI, big KPI values in the brand colour, a "+%" pill and a sparkline on each, a greeting title, a gradient area chart, the accent on chrome. Measurable kinds: `icon_tile`, `greeting_title`, `accent_share`, `kpi_tile` | `tells.md`, `src/plugin/tells.ts` | W2 |
| **Light or dark from one sentence of physical scene** (who, where, under what light), never from the category; "dark nobody asked for" as a tell | The design skill's `brief` and `system` sections, `tells.md` | W1, W2 |
| **A mode and a colour strategy named before colours.** An operate screen borrows only type, palette, density and one signature move from its world | `system.md`, the direction card in `directions.md`, the `ux` skill | W5 (look), H1 |
| **A dated list of second-order defaults:** reflex display faces next to `default_typeface`; "one hue pretending to be two" (primary and accent within about 20° of hue) | `tells.md`, `src/plugin/tells.ts` | W2 |
| **A substance guard.** Removing tells is half the job: a view of mostly empty ground, small grey running text, or an idea that stops after the first view caps a lens | The critique skill's severity triggers and `lenses.md` | W4 |
| **Judge before the census.** The cold read and the originality verdict come from the renders and the brief; the measured findings come after, then the two are merged; a single-context review says so first | The critique skill; the reviewer seat of the [base workflow](2026-10-20-base-workflow.md) | W4, W4b |
| **Sameness inside one view:** one word per section layout (the same word twice in a row is the template showing), a count of distinct left edges, a small black silhouette beside the category default, section gaps clearly larger than gaps inside a section (`flat_rhythm`) | `lenses.md`, `finish.md`, `src/plugin/tells.ts` | W2 |
| **Icon rules with numbers:** one set per piece, native sizes only, outline by default and fill for the active state, no tinted chip by default, stroke matched to text weight. With Heroicons, small sizes take the 20 or 16 px solid sets [C-399] | `system.md`, the `ux` skill, the icon tools | W8 |
| **Radius from data,** to test: tight (4–8) or soft (16–24); concentric radii only for small insets | `system.md`, `one_radius` and `nested_radius` | W2 |
| Smaller ideas: a signature shown in five places; remove one accessory; falsify each finding and keep at most three per lens; personas in the usability lens; motion timed by how often it is seen | `directions.md`, `finish.md`, `rounds.md`, the `ux` skill, the `prototype` skill | H1 |

**The app-screen chapter** would cover:

- the screen's one question and one finding;
- the largest block answering the question;
- the main job one click away;
- KPIs as type in one divided container (no icon tile, no sparkline);
- a noun title, no greeting;
- the sidebar on the page ground;
- the accent on data;
- tabular figures, right-aligned;
- honest zero and empty states;
- one element only this product has.

## Where the sources disagree

These cannot carry the design until a test settles them (AGENTS.md):

- **Colour on working screens.** About 3 % coloured pixels (taste), against "a grey screen with one accent is the category default" (impeccable), against 60/30/10 (interface-design).
- **Border and shadow.** "Never both" (taste, impeccable) against "combine them" (Vercel).
- **Pure black grounds.** Banned in one source, measured on real dark screens in another.
- **Card radius.** 12–16 px in one source, rare in another's study.
- **Section entrances.** Required in one source, a generic default in two others.

## For the product redesign

Most of the cluster the research names is what the product's screens did:

- an icon tile on every card;
- a sparkline on every usage KPI;
- dark chosen as the category's default rather than from a scene;
- the settings pages as one template.

The owner asked for dark, so dark was a given. The scene sentence would still have made it a recorded decision rather than a default.
