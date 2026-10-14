# Diagnosis of the 2026-10-09 tool defects — record (2026-10-13)

- `live-probe-2026-10-13.md` — the main agent's live probe on a consistent build: the multi-track, x/y and batch-move defects did not reproduce; the twin id 30:14989 no longer resolved.
- `bug-move.md` — the move defects traced to Figma's second-id periods and to x/y written as two setters.
- `bug-keyframes.md` — the keyframe and video-timeout diagnosis (hypotheses, the probe, the proposed fixes, the claims proposed).
- `r1-calls.txt`, `s3-calls.txt`, `fix-r1.txt`, `fix-r2.txt` — the tool calls and answers extracted from the agents' transcripts that the diagnosis rests on.
- `scripts/` — the calibration prototype for `figma_check_motion` (`audit-proto2.mjs`, `calibration.txt`) and the helper scripts behind the counted findings (`tally.cjs`) and the per-frame curve table (`curves.cjs`).

The ad under diagnosis was built for Moku, a fictional demo brand. Personal paths in these records were anonymised for publication, without moving any line: `~` is the home folder, `<tmp>` the system temp folder, `<session>` the agent session's folder, `<repo>` this repository.
