---
name: figxel-critique
description: Review a Figma design or motion piece like a panel of senior critics. Run each lens in turn, measure every finding, write the fix as tool calls, merge conflicting fixes, re-check the neighbours of every change, and stop at the sign-off bar or the gear's round budget.
---

# Critique — measured lenses, in rounds

A maker cannot see their own first build: in a measured run every builder reported ok, and the first critique round made 36 findings. A critique here is a sequence of lenses: each a separate pass with its own checklist, each finding with a number, each fix written as tool calls. One agent runs them in turn. Message and originality go to a reviewer who has not seen your intentions: the critique_cold prompt, or the owner. A review that could not run in a fresh context opens its report with "self-reviewed".

## Set up

1. **Cold read first.** Before re-reading the brief, take the round's sample (a still: the read and the squint of each view, as the design skill's `finish` section says; motion: section `sampling`) and write, from the renders alone: the reading order (what is seen first, second, third) and the one-sentence takeaway. Your build notes cannot be unseen, so commit these to the reply first.
2. Re-read the brief: figma_get_brief { nodeId: <the work> }, or the user's request. Compare: the first element against the brief's focal point, the takeaway against its message line. A mismatch is a major finding of the message lens.
3. **Verdict before numbers.** From the renders and the brief alone, write each lens's verdict and findings (section `lenses`). Only then read the measurements (figma_check_layout; for motion, figma_check_motion) and merge: a number confirms, sharpens or adds a finding. Write one line on what the eye missed and one on what the numbers missed. A census read first steers judgement toward what a tool can count.

## Lenses by gear

| Work | Lenses | Read | Rounds |
|---|---|---|---|
| A section | message; type and composition; finish QA | `lenses` | 1 |
| A page, screen or deck | message; type and composition; colour and imagery; copy; originality; finish QA | `lenses`, `rounds` | 2 |
| A top-gear piece | the same six | `lenses`, `rounds` | 3 |
| A motion piece | motion craft; design and type; technical QA; the brief's own lens; originality at the directions, on the styleframes and in round 1 on the render | `motion-checks`, `sampling`, `rounds` | 3 (a sting 1) |

Read the first section of the Read column now, the next when a round reaches its step. A role adds its own lenses: ux adds usability and accessibility (figma_get_guide { topic: "ux", section: "usability" }).

## The finding schema

```
<lens> · score <1–10> · verdict <pass | fix>
- <severity> · where: <layer name and id; for motion "t s (fN–fM)"> · measured: <the numbers> · problem: <one sentence> · fix: <tool calls or exact values>
```

Severity is set by these triggers, not by how the judge feels about the piece:

- **Blocker:** a figma_check_layout error or a figma_check_motion error; the message unreadable; text cut or covered; contrast failing on content people need.
- **Major:** the cold read's first element or takeaway differs from the brief; a cluster match no one named; an unanswered craft info at the focal point; the build off its own rules on a key element; missing substance, a view made "clean" by being mostly empty, running text set small or grey, or an idea that stops after the first view.
- **Minor:** craft a peer would catch elsewhere: a tangency, near-equal sizes, a punctuation slip.

Scores follow the findings: a blocker caps the lens at 5, a major at 7; 8 means only minors remain, each with a fix or a reason; 9 means the minors are fixed and nothing is left but taste; 10 means a senior designer would change nothing. Section `rounds` has a worked finding.

## The sign-off bar

- No blocker or major finding in any lens; every lens at 8 or above.
- figma_check_layout ok: true, and every craft and tells info answered: fixed, or kept with its reason in the report.
- For motion: figma_check_motion ok: true, any finding the brief intends in the plan's `accept` and named in the report; every `template_move` and `easing_census` info answered.
- The last round introduced no regression.
- Stop at the bar or at the gear's round budget, three at most; then report what is left. figma_sign_off records it, scores and rounds.

## A round

Sample → cold read → verdicts, then the numbers → merge the fixes → apply them in one batch → check → look for regressions in the neighbours of every change. Section `rounds` has each step.

## Sections of this skill
- `lenses` (references/lenses.md) — each lens's checklist, the squint test, originality.
- `motion-checks` (references/motion-checks.md) — the motion lenses' checks: keys, frames, cuts, reading, layout, rhythm, delivery.
- `sampling` (references/sampling.md) — how to see a still or a motion piece: checks, renders, close-ups, stills, metrics.
- `rounds` (references/rounds.md) — finding ids, merging conflicting fixes, one batch, regressions, when to stop.

Evidence (claim ids, for maintainers): [C-206] [C-238] [C-239] [C-386]
