# Claim Verification — Agent Contract

How to check the external facts Figxel's design depends on, the claims in [`docs/reference/claims.md`](../reference/claims.md), and report the results.

**Why this exists:** four mistakes in one design session were all the same type — an external claim with no tracked source. Verification done by **a single agent inside one context** does not catch them, because that agent reads its own documents and tends to believe them. Verification must come from a separate context with adversarial instructions: **look for reasons the claim is wrong**, not confirmation.

## Roles

| Role | May do | May not do |
|---|---|---|
| **Main agent** (the session that owns the change, for a maintainer or contributor) | Edit `claims.md`; accept or reject a verifier's proposal | — |
| **Verifier subagent** | Fetch sources, compare, **report** | **Edit any file.** No `write_file`/`patch` in the task |

This split is deliberate: if a verifier could write, two writers could collide, and verification could become a way to write down unverified claims.

## When to Run

| Trigger | Scope |
|---|---|
| Before Phase 0 starts | All claims with status `contradiction` + `to-verify` |
| Before writing user documentation | All `verified` claims whose "Checked" date is > 30 days old |
| When adding a tool or op | Any newly introduced claim |
| Whenever a Figma fact feels suspicious | The relevant claims |
| Before a release / handoff | The entire registry |

## Protocol

**Input:** a list of claim IDs (e.g. `C-012,C-013,C-021,C-025`).

**Steps per claim:**

1. **Read the claim as written** — do not assume what it means.
2. **Fetch the primary source.** Official documentation, installed code, or a measurement on a real installation (the claim records which machine and version). **Not** a blog, a summary, or this document itself.
3. **Look for a counter-argument first.** Before concluding "true", ask: which version/plan/seat would make this claim false? Is there another official page that disagrees?
4. **Quote exactly.** For `verified`, include the source sentence in the report.
5. **If sources conflict → `contradiction`.** Do not pick whichever is most convenient for the design. Tell the main agent it must be tested.
6. **If a claim underpins the design and is unproven → `to-verify`.** Do not promote it to `verified` without a quotation.

**Binding rules:**

- **Do not change a claim to match the existing implementation.** If the claim is right but the implementation is wrong, the implementation is what gets reported.
- **Do not promote a status without a quotation.** "Seems right" is not `verified`.
- **If a source is unreachable, report `to-verify`** along with what blocked it (paywall, page changed, login required). Do not guess.
- **If a claim turns out to be true but its design rationale is weak**, report both as separate findings — that is the most useful outcome.
- **Do not report beyond what was asked.** Stay on the given IDs.

## Report Format

One block per claim. Terse, no preamble.

```
C-012 — setTimeout in the plugin sandbox  (RESOLVED 2026-10-07 — measured, not read)
Status: RESOLVED — setTimeout and fetch ARE present; the "How plugins run" page is wrong
Evidence: developers.figma.com/docs/plugins/how-plugins-run/ → "browser APIs like
  XMLHttpRequest, fetch, setTimeout, and the DOM are not directly available from
  the sandbox". developers.figma.com/docs/plugins/frozen-plugins/ → "A typical way
  to do this is to use setTimeout(() => { … }, 1)".
Note: two official Figma pages genuinely conflict. Cannot be resolved from
  documentation — spike §14.1 is required. Claim C-013 (microtasks are not enough)
  can only be settled by the same spike.
Proposal: keep the status; do not change the design until the spike runs.
```

When a claim has changed:

```
C-021 — figma.fileKey is private-plugin only
Status: CHANGED → verified
Evidence: <exact quotation from the source + URL>
Impact: §14.9 no longer needs testing; §5.8 (onboarding) may mention fileKey.
Proposal: promote to verified, stamp the date.
```

When a new claim is found (not in the registry):

```
NEW — A Figma plugin cannot be launched from a CLI
Evidence: <quotation + URL>
Proposal: add as a new claim; it underpins ADR #20 (auto-launch via quick action).
```

## Limits of Authority

Verifiers **report**; the main agent **decides and writes**. If a report contains a proposal, it is a proposal — not a change.

If a verifier finds that a **design decision** (section I of the registry) rests on a claim that turns out to be wrong, that is the highest-priority finding: report it first and name which part of the spec needs revisiting.

## Mechanical Checks

Besides human verification, there is an automated check that needs no network:

```bash
node scripts/check-claims.mjs
```

It verifies: every `[C-0xx]` referenced by a document exists in the registry; every registry entry has a recognised status, a source/reference, and a date; no duplicate IDs; and sections A–H do not use the `decision` label. This catches administrative drift — not the truth of the content. Truth still needs a verifier.
