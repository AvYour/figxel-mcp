## What and why

<!-- What this pull request changes and why. Link the issue it closes, if any. -->

## How it was tested

<!-- The tests you added or ran. If anything ran live on a real canvas: the operating system, the Figma desktop version, the spike, and its results file under spikes/results/. Otherwise write "not run live". -->

## Checklist

- [ ] Tests are added or updated, and `npm run check` passes (typecheck, tests, check-docs, check-claims, lock-docs).
- [ ] `node scripts/check-language.mjs` passes: everything is in English.
- [ ] The documents that own the change are updated: `docs/reference/tools.md` and `src/shared/editors.ts` for a tool, `docs/reference/protocol.md` for the protocol, `src/skills/` for agent guidance, `README.md` for anything a user sees, and `CHANGELOG.md`.
- [ ] No new external fact is stated without a claim id; facts that need one are listed below for the maintainers to register.
- [ ] Locked documents I changed are listed below, and I ran `node scripts/lock-docs.mjs --update`.
- [ ] Attachments carry no personal data (Figma user name and id, file names, paths with my user name).

## New external facts

<!-- For each: the claim in one sentence, the source (a specific URL and what it says), the date you read it (YYYY-MM-DD), and the status you propose. Write "none" if there are none. -->

## Locked documents changed

<!-- File and reason, or "none". -->
