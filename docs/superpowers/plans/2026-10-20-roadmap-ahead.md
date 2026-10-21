# The road ahead — plan, 2026-10-20

The owner asked for a deep plan of everything ahead. This plan ties together the earlier records, decided items and findings into one order of work, with exit criteria and the decisions still open. It replaces nothing: it points at the records that hold the detail. It is a working plan; it changes as work lands.

The earlier records:

- the [roadmap](../../reference/roadmap.md#next-steps),
- the [next releases plan](2026-10-16-next-releases.md),
- the [feature research](2026-10-19-feature-research.md),
- the [role tests](2026-10-19-role-tests.md),
- the [role quality plan](2026-10-20-role-quality.md).

## 1. Where Figxel stands

- **Released:** 0.1.1 on npm (published by hand on 2026-10-19). The plugin stays a development plugin installed by `setup`; Figma Community rejected it [C-342].
- **Built but not released:** 0.2.0 on the `release/figxel` branch, local and not pushed:
  - the role process (phase 8),
  - the `handoff` audit,
  - trust (phase 9): the stale-write guard, the change journal, savepoints and rollback, the stress test.
  - The catalog holds 144 tools, 140 registered by default; the full suite was green when trust landed.
- **Live verification debt:**
  - the roles, handoff and trust spikes;
  - the role acceptance runs;
  - the FigJam and Slides writes (16 tools refuse until measured);
  - the motion gate end to end;
  - rendering with the window covered;
  - macOS.
- **Findings open from 2026-10-19** (the role tests):
  - Blockers: false `STALE` on the agent's own changes (6, 6b, 6c).
  - High: craft checks that ignore clipping and scrolling (10), sign-off demanding another brand's tokens (12), a translucent bound colour turning solid (15), an interrupted spec leaving loose nodes with no report (17), overlays counted as covered (18, 26), a multi-root check that froze the plugin (24).
  - Medium and low: about a dozen more.
- **What the product redesign proved:**
  - The tools can carry a full product redesign: 14 screens, 11 states, both modes and a coded implementation in parallel.
  - The role process did not stop a generic result ([role quality plan](2026-10-20-role-quality.md#what-happened)).

## 2. The bet

Figxel's lead has to be what a larger tool count cannot erase: **the discipline of a professional designer, built into software**. That means:

- a brief before the work, measured checks after it, and a sign-off that means something;
- work shared with people without losing theirs;
- any MCP client, running locally.

Three outcomes say whether the bet is working:

| Outcome | Measured by |
|---|---|
| The work reads as a professional's | The share of benchmark briefs (§4) whose output a blind reviewer cannot tell from a professional's, and the count of `avoid` matches left at sign-off |
| No one loses work | Data-loss incidents (target: none), and false refusals per session (target: under one) |
| It is easy to start and keep using | Setup success on a clean machine per OS, time to the first built frame, and npm downloads per month |

## 3. Horizons

Each horizon ends in a release with its exit criteria. The sizes are relative (S, M, L), not dates.

### H0 · Ship 0.2.0: make what is built trustworthy

| # | Work | Size | Exit |
|---|---|---|---|
| 0.1 | Attribute changes by content, not only by time (findings 6, 6b, 6c): a target unchanged since the agent's last view is not a conflict, and a variable or style write covers the nodes bound to it | M | The trust spike passes with Figma in front and behind; no false `STALE` in a 30-minute build |
| 0.2 | Bound the work of `figma_check_layout` across roots and report progress (finding 24); report what an interrupted spec left (finding 17) | S | Twelve 1440-wide screens check without a stall; a timed-out spec lists its nodes |
| 0.3 | Overlays and clipping in the craft checks (findings 10, 18, 26); centred text no longer made fill-width (25) | S | The product's Effort menu, save bar and scrolling regions pass without workarounds |
| 0.4 | The live session the owner wanted before 0.2.0: the roles, handoff and trust spikes, plus one UX acceptance run (the product run counts as practice, not as the run) | M | `spikes/results/*` recorded; claims [C-381] [C-382] [C-394] [C-395] re-statused |
| 0.5 | Registry drift from the feature research, re-verified | S | `check-claims` green with re-dated sources |
| 0.6 | Release engineering: trusted publishing in the release workflow (the token path broke for 0.1.1), then push `release/figxel` to the public repository and tag | S | 0.2.0 on npm with provenance; release notes; README and `docs/usage.md` show the role process and trust |

### H1 · 0.3.0 "Craft": work that reads as a professional's

The [role quality plan](2026-10-20-role-quality.md), plus what it unlocks.

On 2026-10-20 the owner set the priority: Figxel's purpose is the quality of what it makes, in any client. The [base workflow](2026-10-20-base-workflow.md#10-decisions-2026-10-20) therefore starts the quality levers before the 0.2.0 release, which waits for them; only the false `STALE` fix (0.1) must land before it. The panel (1.3b) waits for the benchmark to show a gain.

| # | Work | Size |
|---|---|---|
| 1.1 | W1 and W3: an `avoid` list on the brief that binds, and tells while building | S–M |
| 1.2 | W2: the new tells kinds (`skeleton_repeat`, `icon_tile_everywhere`, `even_spacing`, `boxiness`, `centred_stage`, `cluster_match`) | M |
| 1.3 | W4: an independent reviewer on the message and originality lenses, the `critique-cold` prompt, the owner fallback | M |
| 1.3b | W4b: a panel of reviewers with different jobs (art director, UX, accessibility, engineer, the owner's proxy) and a chair who merges their findings; directions from separate agents at page and top gear | M |
| 1.4 | W8: icon sets, Heroicons first: `figma_search_icons` and `figma_insert_icon` [C-399] | M |
| 1.5 | W5 and W6: references as a taste anchor; owner feedback opens two alternatives | S |
| 1.6 | **Pattern recipes** in the role skills: professional answers to recurring problems, with numbers. A settings page as grouped rows with inline controls. A dense data table with tabular figures. An empty state that leads to the first action. A command bar. Each is written as "when, what, measured how", never as one house style | M |
| 1.7 | **A handoff pack:** one call that writes, for a coding agent, the tokens per mode, text styles, components, and each screen's render and measurements. It formalises what the product run did by hand to code in parallel | M |
| 1.8 | The wave B acceptance runs: one brief each for graphic, brand and presentation, from the first call to sign-off | M |

**Exit:**

- The product brief, re-run, is caught by its own `avoid` list during the build.
- A top-gear sign-off refuses self-scored message and originality lenses.
- The benchmark (§4) scores better than the 2026-10-19 baseline.

### H2 · 0.4.0 "Flows": screens that work together

From the feature research (candidates 3 and 4):

- Flows from a brief: screens, reactions and flow starts.
- A reachability and dead-end audit.
- Responsive variants generated from one source, then audited as a set (reflow, targets per platform, type floor).
- The ux skill's `flows` section is where it is taught.

**Exit:** a booking flow and a settings flow built from briefs, at two breakpoints each, with no dead end and the set audited.

### H3 · 0.5.0 "Bridge": Figma and the shipped product

From the feature research (candidates 5 and 6):

- **Design QA of the live page against the frame.** Decided: talk to the design-QA founder first. The conversation with the design-QA tool's maker has started, so the outcome decides between three options:
  - Integrate: Figxel calls their tool and reads its report before sign-off.
  - Partner.
  - Build: a local headless browser over the DevTools protocol.
- **Capture and systemise:** a page rebuilt on the file's own components and variables, then the system audit. It shares the browser infrastructure with design QA.

**Exit:**

- A frame and its coded page compared at two breakpoints, with a report.
- A captured page rebuilt with at least 80 % of its fills and texts bound to the file's system.

### H4 · Hardening and reach (throughout)

- **Phase 5:** real multi-session use, reconnect storms, load tests on 10,000+ nodes, and a token budget per tool result.
- **FigJam and Slides:** the five live spikes, so the 16 board and deck tools stop refusing.
- **macOS:** a first live run and a green blocking CI job.
- **The motion gate end to end,** and video export with the window covered.
- **The tool-description audit (phase 4):** each description says when to use the tool and when not, measured by a tools-only client walking the skills.
- **Local and CJK fonts:** a spike, a claim and a README line (feature research candidate 8).

### H5 · People around it

- **A gallery of before-and-after runs:**
  - A brief, its directions and the signed result, honest about the misses.
  - The product redesign is the first entry, once the H1 work re-runs it.
- **Contributor paths:**
  - "good first issue" labels on detector kinds and pattern recipes.
  - A guide to adding a tells kind with its fixtures.
- **Skills that travel:** the `src/skills/` folders installable on their own in clients that read Agent Skills, so the process helps even where the plugin is not installed.
- **Partners:** design QA (H3), and coding agents through the handoff pack (H1).

## 4. A benchmark for "professional"

Today quality is judged once, by the agent that did the work. The fix is a fixed set of briefs run before each release and scored the same way each time.

- **The briefs:**
  - a booking flow (ux),
  - a settings area (ux, from the product run),
  - a poster (graphic),
  - a wordmark (brand),
  - a six-slide deck (presentation),
  - a motion sting (motion).
- **The scores for each run:**
  - `figma_check_layout` errors and warnings;
  - the tells counts and `avoid` matches;
  - the blind reviewer's lens scores;
  - calls made, refusals and false positives;
  - time to sign-off.
- **The blind review:**
  - The review panel of role quality W4b sees the renders beside renders of professional work on the same brief.
  - Each reviewer says which is which and why.
  - The owner checks a sample by eye.
- **Where it lives:** the briefs are stored next to the spikes. The results go to `spikes/results/` and a table in the release notes, so a regression in quality is as visible as a failing test.
- **What it feeds:** calibration (role quality W7). Its labelled outputs are the corpus, alongside finished files the owner allows.

## 5. Cross-cutting rules

- **Claims first:** every new external fact (an icon set's licence, a client's support for MCP sampling, a design-QA tool's interface) is registered before a design depends on it.
- **Measured before yes:** an editor cell or a capability turns to yes only from a live run's results file.
- **No silent behaviour change:**
  - A new tool enters the catalog through `docs/reference/tools.md` (candidates first).
  - A changed default is announced in the release notes.
- **Local and private:** nothing leaves the machine unless the user's request sends it. That includes run reports, which stay opt-in and local.

## 6. Risks

| Risk | Effect | Answer |
|---|---|---|
| Figma closes the gap in tool count, or its own agent improves | The tool count stops mattering | Compete on process, quality and trust (§2); keep any client and local first |
| Plugin distribution stays development-only | Setup friction | `setup` stays the path; measure setup success (§2); keep the README honest about it |
| Quality work stays subjective | No progress is visible | The benchmark (§4) and calibration turn it into numbers |
| One maintainer | Slow or stalled work | Contributor paths (H5), small workstreams, records that let anyone pick up a thread |
| Trademark risk on the name | A forced rename | Accepted by the owner [C-272]; keep "works with Figma, not affiliated" |
| Live runs need the owner at Figma desktop | Verification lags the code | Batch them into sessions of 60–90 minutes with a script, as the next releases plan does |

## 7. Not now

- Two-way token sync.
- A comments round trip, until a design for handling the REST token exists.
- Shaders, and Figma's credit-based tools.
- A mode on top of the official server's `use_figma` (the owner's choice, 2026-10-16).
- Audio beyond the owner's licensed files.

## 8. Decisions for the owner

Each decision has a recommendation (2026-10-20), not yet the owner's answer.

1. **0.2.0's contents.**
   - The options: the role process, handoff and trust as built with H0 fixed first; or ship sooner and fix in 0.2.1.
   - Recommended: H0 first. The release's theme is trust, and false `STALE` refusals break exactly that claim. The fixes need no Figma session; one live session then proves them.
2. **0.3.0's theme.**
   - The options: "Craft" (H1) or "Flows" (H2) first.
   - Recommended: Craft. Flows built from generic screens stay generic, and Craft answers the verdict on the product run.
3. **The benchmark.**
   - The question: which briefs, and which professional files may serve as the comparison and the calibration corpus.
   - Recommended: start with three briefs (the settings area, the booking flow, the poster) to keep the owner's live time small, and add the rest later.
   - For comparison: the owner's own work, or files whose licence allows it. The product run before H1 is the first generated sample.
4. **Design QA.**
   - The options: integrate, partner or build, after the conversation with that tool's maker.
   - Recommended: wait for the answer without blocking anything, since it matters only at H3. Integrate if that tool can be run from another tool; build only if it cannot fit.
5. **Icon sets.**
   - The options: Heroicons alone at first, or Heroicons plus one more.
   - Recommended: Heroicons alone. One set done fully (search, a component made once, a bound colour) beats two done halfway.
6. **The independent reviewer.**
   - The question: whether a short owner score is acceptable as the fallback where a client cannot run a second agent.
   - Recommended: yes, as two lenses scored 1–10 with one sentence each. A skipped review is marked "self-reviewed".
