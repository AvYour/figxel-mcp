# Contributing to Figxel

Thank you for helping. Figxel is open to contributors: bug reports, fixes, new tools, better skills, documentation, and live measurements on a real Figma canvas, which are worth a lot (macOS has never been run live). Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

Figxel was called figma-mcp during development. You will meet that name in dated records (plans, spike results, the design spec's file name) and in a few identifiers that must not change, such as the plugin's manifest id `figma-mcp-bridge`.

Ids such as `[C-275]` below point to the [claim registry](docs/reference/claims.md).

## Development setup

You need Node.js 22 or later `[C-292]` and git. To run the plugin you need Figma desktop on macOS or Windows `[C-273]`; the tests do not. The live spikes written in Python need Python 3.

```bash
git clone https://github.com/AvYour/figxel-mcp.git
cd figxel-mcp
npm ci
npm run build
```

`npm run build` (`tools/build.mjs`) writes:

| Output | What it is |
|---|---|
| `dist/server.js` | The MCP server and the bridge, one bundle with no runtime dependencies |
| `dist/plugin/` | The Figma plugin: `manifest.json`, `code.js`, `ui.html` |
| `dist/build-id.json` | The build id that `figma_status` compares with the running plugin's |
| `dist/THIRD_PARTY_NOTICES.md` | The licences of the bundled packages |

### Run your build in Figma

1. Print the token (created in `~/.figxel/token` if absent): `node dist/server.js --print-token`.
2. In Figma desktop, import **your clone's** `dist/plugin/manifest.json`: open a file, then **Plugins → Development → Import plugin from manifest…** (the Help Center calls it "Import new plugin from manifest...") `[C-274]`. Run it from **Plugins → Development → Figxel**, paste the token and press **Save**.
3. After each `npm run build`, close the plugin window and run it again. Figma reads the plugin files from your clone on each run, so there is nothing to re-import `[C-275]`.

If you also installed Figxel with `npx -y figxel-mcp@latest setup`, Figma now has two imports with the same plugin id. How Figma treats that has not been measured, so keep one of them. The server refreshes only the copy that setup made in `~/.figxel/plugin`, never your clone's `dist/plugin`.

### Point your AI app at the clone

Use `node` and the absolute path of your build. For apps that read `mcpServers` JSON:

```json
{
  "mcpServers": {
    "figxel-dev": { "command": "node", "args": ["/absolute/path/to/figxel-mcp/dist/server.js"] }
  }
}
```

Claude Code `[C-279]`:

```bash
claude mcp add -s user figxel-dev -- node /absolute/path/to/figxel-mcp/dist/server.js
```

`node` is a real executable on Windows too, so this needs no `cmd /c`; only `npx`, a `.cmd` file there, does `[C-281]`.

Run one Figxel at a time while you develop: every server process uses port 38452, the first one holds the Figma connection and the others share it, so an npx entry and your dev entry would mix versions. After a rebuild, restart the app as well: a running server keeps the code it started with, and `figma_status` then reports `restart: "client"`.

### Without Figma

`npm run mock-plugin` starts `tools/mock-plugin.mjs`, a Node stand-in for the plugin. It speaks the real protocol ([protocol.md](docs/reference/protocol.md)) and answers ops with fake data. It reads the token from `~/.figxel/token` (or `BRIDGE_HOME`), and takes `--slow`, `--stall`, `--drop`, `--port N`, `--token HEX` and `--file NAME`:

```bash
npm run mock-plugin -- --slow
```

The integration tests use the same mock through `startMockPlugin()`.

### Tests and checks

| Command | What it runs |
|---|---|
| `npm test` | Vitest: unit, integration and end-to-end tests. It builds `dist/` first (`test/global-setup.ts`), so a running server reports `build.restart` afterwards |
| `npm run typecheck` | Three TypeScript projects: the server, the plugin sandbox and the plugin UI |
| `npm run check:docs` | `scripts/check-docs.mjs`, `scripts/check-claims.mjs` and `scripts/lock-docs.mjs` |
| `node scripts/check-language.mjs` | Everything in the repository is English |
| `npm run check` | `typecheck`, `test` and `check:docs` together |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `typecheck`, `test`, `check:docs` and `check-language` on Node 22 and 24, on Ubuntu, Windows and macOS. The macOS job does not block until it has passed once.

### Live spikes

`spikes/live-*.mjs` and `spikes/live-all-tools.py` drive a real canvas. They need Figma desktop with the plugin running in an open file, and they write to that file, so use a scratch file. Each spike's header says what it needs, how to run it and what it settles. Results go to `spikes/results/`. Only a result recorded there may turn an editor cell in `src/shared/editors.ts` to **yes** or **no**, or re-status a claim.

### Where things are

| Path | What lives there |
|---|---|
| `src/server/` | The MCP server, the bridge, the tools, `setup` |
| `src/plugin/` | The Figma plugin: the sandbox code (`code.ts`, `ops/`) and the UI (`ui.html`, `ui.ts`) |
| `src/shared/` | The contract both sides share: protocol, op schemas, the editor table, version and names |
| `src/skills/` | The agent guidance: one Agent Skills folder per skill, bundled into the server |
| `tools/` | Build script and mock plugin |
| `test/` | Vitest suites |
| `scripts/` | The documentation gates |
| `spikes/` | Live probes against a real canvas, and their results |
| `docs/` | Reference, the design spec, agent guides, and dated plans |

## Repository conventions

[AGENTS.md](AGENTS.md) holds the conventions for people and AI coding agents alike, and the gates enforce them. If you work with a coding agent, have it read AGENTS.md before it changes anything. In short:

- **Everything is English**: prose, headings, comments, commit messages and script output. `scripts/check-language.mjs` enforces it in CI and in the pre-commit hook, because the rule leaked while it was only written down: two checkers printed non-English summaries for a whole phase and nobody noticed. Identifiers are never translated.
- **External facts are tracked.** See [Tracked claims](#tracked-claims).
- **Headings that other files link to are API.** Anchors come from heading text, so renaming a heading breaks every link to it. `scripts/check-docs.mjs` checks the links in `README.md` and `docs/`; links in the other root files, this one included, are not checked, so check them by hand.
- **The more specific document wins**: `docs/reference/tools.md` on the tool list, `docs/reference/claims.md` on external facts, `src/skills/` on what an agent is told.
- **Agent guidance lives in `src/skills/`.** Change it there, never in a copy. In the `design`, `critique`, `workflow` and `design-system` skills a file's claim ids sit on its last line, `Evidence (claim ids, for maintainers): …`, not in the prose.
- **A tool enters the catalog only through `docs/reference/tools.md`**, with its heading counts, never quietly in code.
- **Moku and Studio Kumo are fictional demo brands** used in tests and spike records.

## Tracked claims

Within a single design session, four mistakes were found, and **all four were the same type**: an external claim with no tracked source.

| What was wrong | What is actually true | ID |
|---|---|---|
| "all View/Collab = 6/month" then "= 20/month" | On 2026-10-06 Starter was 20/month and a View/Collab seat on a paid plan 6/month, two different figures. On 2026-10-08 the page reads 20/month for View/Collab on every plan: **the figure itself changed**, which is why a claim carries the date it was checked | `[C-001]` `[C-002]` |
| "microtask yield is enough to let Figma breathe" | Two official Figma pages **contradicted** each other on `setTimeout`, so it was tested: `setTimeout` **does** exist and is now the default, while the microtask blocked 7/7 runs and was worse than no yield at all | `[C-012]` `[C-013]` |
| "`export_video` is out of the plugin's reach" | Plugin API **Update 128** (16 July 2026) added MP4/GIF/WebM | `[C-026]` |
| Parity map marked write tools as `✅` matching official tools | The official server **has no** granular write tools, only `use_figma` | `[C-008]` |

So every external fact the design depends on carries an **ID** (`C-0xx`) that appears in the documents. The [registry](docs/reference/claims.md) records the source, the status and the date it was checked. A `contradiction` status flags conflicting sources, and such a claim may not carry weight until it is tested; neither may a `to-verify` one.

Verification runs two layers deep:

```bash
node scripts/check-docs.mjs      # links, anchors, tool counts, figma_* names
node scripts/check-claims.mjs    # claim IDs exist, status known, source+date present,
                                 # and 'contradiction' claims unused without a test marker
```

Mechanical checks catch administrative drift. **The truth of the content** needs a verifier from a separate context (procedure: [verification contract](docs/agents/claim-verification.md)).

### Proposing a new claim

Only the maintainers edit `docs/reference/claims.md`, so two writers never collide in it. If your change rests on an external fact that has no id yet:

1. List the fact in your pull request: the claim in one sentence, the source (a specific URL and what it says, quoted), the date you read it (`YYYY-MM-DD`), and the status you propose (`verified` for a primary source, `measured` for something you measured, with the command, machine and output).
2. A maintainer registers it with the next free id, and your change then cites `[C-0xx]`.
3. Until then, do not state the fact in the documents.

When a claim changes, every document that uses its id changes with it: grep the id.

## Locked documents

These documents were once rewritten by a parallel agent that introduced four factual errors. To stop that recurring, they are locked.

**What is locked** (exactly what `scripts/lock-docs.mjs` hashes): `README.md`, `AGENTS.md`, every `.md` file under `docs/` except `docs/superpowers/plans/`, and the `.md`, `.mjs` and `.ps1` files under `scripts/`. A new document under `docs/` joins the lock at the next `--update`.

**Not locked:** `docs/superpowers/plans/` (working plans change by design), `src/`, `test/`, `tools/`, `spikes/`, and the root files other than `README.md` and `AGENTS.md`.

**Layer 1, a recorded baseline.** `docs.lock.json` holds a line-ending-normalised sha256 for each locked file. `node scripts/lock-docs.mjs` verifies it and exits 1 on any change, added file or removed file. It runs in CI and in the pre-commit hook.

**Layer 2, the file system (Windows only).** On Windows, `node scripts/lock-docs.mjs --update` sets the read-only attribute on every locked file and on `docs.lock.json`, so an accidental edit fails. On macOS and Linux the script changes no file modes, so the baseline is the lock there.

To change a locked document on purpose:

```bash
# Windows
attrib -R <file>                      # unlock
# ... edit ...
node scripts/lock-docs.mjs --update   # record the new baseline; re-applies read-only to every locked file
attrib +R <file>                      # re-lock (already done by --update; harmless)
```

```bash
# macOS and Linux
# ... edit <file> ...
node scripts/lock-docs.mjs --update   # record the new baseline
# Optional, the same read-only layer by hand:
chmod a-w <file>                      # lock
chmod u+w <file>                      # unlock before the next edit
```

Say in your pull request which locked documents you changed and why.

**Honest limit:** this stops accidents and silent drift, not a determined process. Anyone can clear a read-only flag, and `git commit --no-verify` skips the hook. That door is documented on purpose: a lock that claims to be unbreakable is worse than one that admits it is not.

## The pre-commit hook

Turn it on once per clone:

```bash
git config core.hooksPath .githooks
```

On macOS and Linux, make sure the hook file is executable: `chmod +x .githooks/pre-commit`.

`.githooks/pre-commit` runs `check-docs`, `check-claims`, `check-language` and `lock-docs`, and any failure blocks the commit. It skips the checks when `node` is not on the PATH. CI runs the same gates, so a commit that bypasses the hook still fails there.

## Pull requests

- **Keep it small and focused**: one concern per pull request. For a new tool or a larger change, open an issue first so the shape can be agreed.
- **Test it.** Add or update tests; `npm run check` and `node scripts/check-language.mjs` must pass.
- **Update the documents that own the change**: `docs/reference/tools.md` (and the editor table in `src/shared/editors.ts`) for a tool, `docs/reference/protocol.md` for the wire protocol, `src/skills/` for agent guidance, `README.md` and the user pages in `docs/` (`usage.md`, `clients.md`, `configuration.md`, `troubleshooting.md`) for anything a user sees.
- **List new external facts** for the maintainers to register (see [Proposing a new claim](#proposing-a-new-claim)).
- **Say what ran live**, if anything: the operating system, the Figma desktop version, the spike, and its file under `spikes/results/`. Remove personal data (your Figma user name and id, file names, paths with your user name) from anything you attach.
- **Write commit messages in English**, in the style of the history: `feat:`, `fix:`, `docs:`, `chore:`.

The [pull request template](.github/pull_request_template.md) carries the checklist.

## Releasing

For maintainers. One time: the public repository `AvYour/figxel-mcp` with the repository secret `NPM_TOKEN`, an npm access token allowed to publish `figxel-mcp` (see the header of `.github/workflows/release.yml`).

For each release:

1. In [CHANGELOG.md](CHANGELOG.md), give the version being released its date in place of **Unreleased** (`## 0.2.0 — 2026-11-02`). Later changes start a new `Unreleased` heading above it.
2. Set the new `version` in `package.json` and `package-lock.json`. The build injects it into all three bundles, so no source file carries a version.
3. Commit, tag the commit `v<version>`, and push both:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. The tag starts `.github/workflows/release.yml`. It refuses a tag that is not `v` plus the `package.json` version, runs `npm ci`, `npm run check` and the language check, publishes with `npm publish --provenance --access public`, zips `dist/plugin/*` and `LICENSE` as `figxel-plugin-v<version>.zip`, and creates the GitHub Release with that zip and generated notes.
5. Check the result: `npx -y figxel-mcp@latest --version`.

The workflow publishes to npm before it creates the GitHub Release. If the release step fails after a successful publish, create the release by hand with the same `gh release create` command from the workflow, since re-running the whole job would repeat the publish step.
