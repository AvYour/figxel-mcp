# The 2026-10-09 motion run — record

The multi-agent build of the Moku Instagram Story ad v2 (frame "Moku — IG Story Ad v2 (motion)"): an inventory, three motion directors, three judges, a synthesis (the build bible), a rig and five scene builders, a render, and three rounds of three critics with a fixer after each. Claims C-1xx/C-2xx in `docs/reference/claims.md` cite these files.

- `agents/jNN-<agent>.json` — every agent's structured result, one file per line of the run's workflow journal; `NN` is the 0-based journal line, so "journal line 18" is `agents/j18-judge_build.json`.
- `critic-findings.json`, `fixer-reports.json`, `builder-reports.json` — the same results grouped by role.
- `final-spec.md` — the build bible the builders followed; `inventory.md` — the inventory and the critique of the first ad; `tool-findings.md` — the figma-mcp defects the agents reported.

The 2026-10-13 diagnosis of those defects is in `../2026-10-13-diagnosis/`.

Moku is a fictional demo brand made up for this test run; it is not a real company, shop or client.

Personal paths in these records were anonymised for publication, without moving any line: `~` is the home folder, `<tmp>` the system temp folder, `<session>` the agent session's folder, `<repo>` this repository.
