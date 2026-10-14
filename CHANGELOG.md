# Changelog

Notable changes to `figxel-mcp`, newest first. A version marked **Unreleased** has not been published yet; its heading gets the release date when it is tagged ([CONTRIBUTING.md § Releasing](CONTRIBUTING.md#releasing)).

## 0.1.0 — Unreleased

The first public release, as **Figxel**. The project was called figma-mcp during development.

### Install

- The npm package `figxel-mcp`, with no runtime dependencies. `npx -y figxel-mcp@latest setup` creates the token, copies the plugin into `~/.figxel/plugin`, and prints the token, the manifest to import in Figma desktop, and the entries for Claude Desktop, Claude Code and any other stdio MCP app for your operating system.
- The server keeps `~/.figxel/plugin` current when it starts, so after an update you re-run the plugin instead of importing it again.
- `figxel-mcp --version`, `--help` and `--print-token`; an unknown argument exits with an error instead of starting a server.
- Node.js 22 or later.

### What an agent can do

- 132 tools by default, plus `figma_eval` on opt-in: read, create, modify, style and export in Figma Design files.
- Design systems: components, variants, instances and their properties, styles, variables with modes and scopes, library assets imported by key.
- Prototypes and motion: reactions and flows, keyframe animation, video export to MP4, GIF or WebM in job mode (a client timeout no longer discards a render), and `figma_review_video` for contact sheets and stills.
- Storyboards with `figma_create_storyboard`; `figma_create_animatic` is built and waits for its live run.
- Self-checks: `figma_check_layout`, with its `craft` and `tells` audits, and `figma_check_motion`.
- FigJam and Figma Slides: reads in every editor; 16 board and deck tools whose writes stay refused until live runs verify them.
- Eleven skills (workflow, design, storyboard, motion, critique, design system, design to code, code to design, prototype, FigJam, Slides), served through `figma_get_guide`, ten MCP prompts and `skill://` resources.
- Several AI apps share one Figma connection.

### Safety

- A bridge that listens only on `127.0.0.1:38452`, a 32-byte token handshake, an origin check, exports limited to allowed folders, `figma_eval` off by default, and an editor gate that refuses writes not yet verified in a file's editor.
- One undo step per tool call, and `idempotencyKey` so a retried write never runs twice.

### Renamed from figma-mcp

- MCP server name `figxel`; plugin name in Figma `Figxel`. The plugin's manifest id stays `figma-mcp-bridge`, so a saved token is kept.
- Home folder `~/.figxel`; a token in `~/.figma-mcp` is copied once.
- Selection resource `figxel://session/<id>/selection`; skill folders `figxel-<short>`.

### Project

- MIT licence; CI on Node 22 and 24 across Ubuntu, Windows and macOS; a tag-driven release workflow that publishes to npm with provenance and attaches the plugin as a zip to the GitHub Release.

### Known limitations

- Nothing has been run live on macOS yet.
- FigJam and Slides writes, and `figma_create_animatic`, are refused until their live runs are recorded.
