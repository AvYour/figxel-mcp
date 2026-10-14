# Figxel

**Let your AI agent read and edit your Figma files.** Figxel is a local MCP server that works with Figma desktop. Through a small plugin that you run in Figma, an AI app such as Claude, Cursor or VS Code can read, build and change designs in Figma Design, FigJam and Figma Slides files. It also ships skills that teach the agent to design, storyboard, animate and critique its own work.

> Figxel is not affiliated with, endorsed or sponsored by Figma, Inc. Figma is a trademark of Figma, Inc.

npm package: `figxel-mcp` · license: MIT · version 0.1.0, the first public release · tested live on Windows; macOS has not been run live yet (see [Troubleshooting](#troubleshooting)).

Ids such as `[C-273]` point to the [claim registry](docs/reference/claims.md), where every external fact these documents rely on has its source and the date it was checked.

## What you can do

Ask your agent, in plain words, and it uses these tools:

- **Read a design.** Layer trees with paging, design context for writing code, screenshots and exports (PNG, JPG, SVG, PDF), variables, styles, fonts and search.
- **Build and edit.** A whole section in one call from a JSON spec (`figma_create_from_spec`), or frame by frame: text, shapes, images, SVG, auto-layout, constraints, fills, strokes and effects. Each tool call is one Ctrl+Z step in Figma.
- **Work with a design system.** Components, variants, instances and component properties; paint, text, effect and grid styles; variables with modes and scopes; library assets imported by key.
- **Prototype and animate.** Reactions and prototype flows, keyframe animation (`figma_set_keyframes`), and video export to MP4, GIF or WebM (`figma_export_video`) `[C-026]`. `figma_review_video` cuts a render into contact sheets and stills so the agent can judge it frame by frame (it needs ffmpeg).
- **Storyboard.** `figma_create_storyboard` lays out timed panels for a motion piece. `figma_create_animatic` plays a board back at its planned pace; it is built and unit-tested, and refuses to write until its live run is recorded.
- **Check its own work.** `figma_check_layout` measures a frame for text that overflows instead of wrapping, clipped or overlapping content, low contrast, placeholder copy, raw colours where the file has styles or variables, and finish defects. `figma_check_motion` checks keyframes against motion rules. Both return numbers and a suggested fix, not opinions.
- **FigJam and Figma Slides.** Reads run in every editor today. The board and deck tools (stickies, connectors, tables, slides, transitions and more) are built and unit-tested, but their writes stay refused until a live run on a real board or deck verifies them. `figma_status` lists what runs in each open file.
- **Follow a process, not just call tools.** Eleven skills (workflow, design, storyboard, motion, critique, design system, design to code, code to design, prototype, FigJam and Slides) reach every app through `figma_get_guide`, ten MCP prompts and `skill://` resources.

That is 132 tools by default, plus `figma_eval` (raw Plugin API JavaScript) when you opt in. The full list is in the [tool catalog](docs/reference/tools.md).

### What it does not do

- It cannot start the plugin for you. Figma has no command line or link that runs a plugin `[C-016]`, so you open it once per Figma session.
- It does not lift your Figma plan's limits. The Plugin API applies the same plan rules as the editor `[C-045]`: a Starter file still has at most 3 pages `[C-048]` and no variable modes `[C-047]`.
- It has no reach into Figma's hosted services: Code Connect, AI generation, and library search for components and styles are out of a plugin's reach ([tools.md § Not implemented](docs/reference/tools.md#not-implemented)).
- It does not run on Linux, because Figma desktop has no Linux build `[C-273]`.

## How it works

```
Your AI app (Claude Desktop, Claude Code, Cursor, VS Code, Codex, …)
        │  MCP over stdio
        ▼
figxel-mcp (Node.js): MCP server + local bridge on ws://127.0.0.1:38452
        │  WebSocket, loopback only, token handshake
        ▼
Figxel plugin in Figma desktop: ui.html (WebSocket) ⇄ code.js (Plugin API)
```

- **Your AI app starts the server** with `npx`. Nothing runs as a background service.
- **The plugin connects to the server** on your own machine. It has to be running in Figma: open it once per Figma session. It then reconnects by itself (within 3 s) every time an app starts the server, so you do not reopen it per chat.
- **Several apps share one connection.** The first server process to bind the port holds the Figma connection and the others share it. When the app that holds it exits, another takes over within seconds ([spec §4.2](docs/superpowers/specs/2026-10-06-figma-mcp-design.md#42-one-process-not-two)).

## Requirements

- **Figma desktop** on macOS 12 or later, or Windows 10 or later (64-bit) or Windows on Arm `[C-273]`. Development plugins run only in the desktop app `[C-274]`.
- **Node.js 22 or later.** Node 22 is maintained upstream until 2027-04-30 `[C-292]`.
- **An AI app that runs local (stdio) MCP servers.** Any app works; [docs/clients.md](docs/clients.md) has the setup for the common ones.
- **Optional: ffmpeg** (it brings ffprobe) on your PATH, only for `figma_review_video`.

## Quickstart

**1. Run setup** in a terminal:

```bash
npx -y figxel-mcp@latest setup
```

It creates a token, copies the plugin into `~/.figxel/plugin`, and prints the token, the manifest path and the entries for your AI app. `-y` skips npx's install prompt `[C-282]`.

**2. Import the plugin in Figma desktop.** Open or create a file, then in the Figma menu choose **Plugins → Development → Import plugin from manifest…** (Figma's Help Center calls it "Import new plugin from manifest...") and pick the manifest setup printed: `~/.figxel/plugin/manifest.json`, or `C:\Users\<you>\.figxel\plugin\manifest.json` on Windows `[C-274]`. Run it from **Plugins → Development → Figxel**, paste the token, and press **Save**. You do this once: the path stays the same across updates `[C-275]`.

**3. Add the server to your AI app.**

Claude Desktop: open Settings → Developer → Edit Config, which opens `claude_desktop_config.json` `[C-277]` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows, also for the Microsoft Store build `[C-278]`). Add the entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

On Windows, use `cmd /c` instead: a program that starts `npx` without a shell fails there, while `cmd` starts it `[C-281]`.

```json
{
  "mcpServers": {
    "figxel": { "command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"] }
  }
}
```

Claude Code, on every operating system `[C-279]`:

```bash
claude mcp add -s user figxel -- npx -y figxel-mcp@latest
```

On Windows this plain form works because Claude Code starts servers through `cmd.exe` itself `[C-280]`. Setup prints a `cmd /c` variant for Windows; the plain form is the one measured in Claude Code.

Other apps: see [Use it from your AI app](#use-it-from-your-ai-app).

**4. Try it.** Restart your AI app (quit Claude Desktop completely, then start it again `[C-277]`), and ask it to *call figma_status*. It should list your open file. Then ask for real work, for example *"In this file, design a landing page hero for a fictional pottery studio."* The agent reads its skill through `figma_get_guide` before it designs, animates or reviews. Apps that show MCP prompts also offer ten starting points such as `design_in_figma` and `storyboard_motion` ([what each one does](docs/agents/using-the-mcp.md#prompts)).

Installing the skills into an app that loads Agent Skills is optional: [docs/clients.md § Installing the skills](docs/clients.md#installing-the-skills).

## Use it from your AI app

Every app runs the same stdio command, `npx -y figxel-mcp@latest` (`cmd /c npx -y figxel-mcp@latest` on Windows for apps that start it without a shell `[C-281]`). The per-app steps are in [docs/clients.md](docs/clients.md):

- **Claude Desktop:** `mcpServers` in `claude_desktop_config.json` `[C-277]`. See the [Quickstart](#quickstart).
- **Claude Code:** `claude mcp add -s user figxel -- npx -y figxel-mcp@latest` `[C-279]`.
- **Cursor:** `mcpServers` in `~/.cursor/mcp.json` or a project's `.cursor/mcp.json` `[C-284]`.
- **VS Code:** its own `servers` format or the portable `mcpServers` one `[C-285]`. A chat request takes at most 128 tools, so trim the toolset (see [Configuration](#configuration)) `[C-286]`.
- **Codex:** a `[mcp_servers.figxel]` table in `~/.codex/config.toml`, or `codex mcp add` `[C-287]`. Run setup first; see [Troubleshooting](#troubleshooting).
- **Gemini CLI:** `mcpServers` in `~/.gemini/settings.json`. `gemini mcp add` writes to the current project unless you pass `-s user` `[C-288]`.
- **Windsurf (Devin Desktop):** `mcpServers` in its `mcp_config.json`. Cascade allows 100 tools at a time, so trim the toolset `[C-289]`.
- **Any other MCP app** that runs a local stdio server: the command above. See [docs/clients.md](docs/clients.md).

## Updating

- **With `@latest` in the entry** (as above), npx asks the registry for the newest version each time your app starts the server `[C-283]`. To update, restart the app.
- **The plugin follows the server.** When a new version starts, the server copies its plugin into `~/.figxel/plugin`. Close the Figxel plugin window in Figma and run it again; Figma reads the plugin files on each run, so there is nothing to re-import `[C-275]`.
- **`figma_status` tells you what is stale.** Its hint says whether to re-run the plugin or restart the app.
- **Keep every app on the same entry.** Two apps running different versions copy their own plugin into `~/.figxel/plugin` in turn, each time one of them starts the server.

## Uninstall

1. Remove the `figxel` entry from each AI app's configuration.
2. In Figma desktop, remove Figxel from your development plugins (under **Plugins → Development**).
3. Delete the home folder, `~/.figxel` (`%USERPROFILE%\.figxel` on Windows). It holds the token, the plugin copy and, by default, your exports: move any exports you want to keep first.

## Configuration

Settings are environment variables, set in the environment your AI app starts the server with: an `env` setting in the server entry in Codex `[C-287]` and Gemini CLI `[C-288]`, `--env KEY=value` in Claude Code `[C-279]`, and the other apps as [docs/clients.md](docs/clients.md) shows. Flags accept only `0` or `1`, and an invalid value stops the server with a message on stderr.

| Variable | Default | What it does |
|---|---|---|
| `BRIDGE_TOOLSET` | `full` | Which tools to register: `full`, `core` (a curated 20-tool set), `none` (only `figma_status`), or a comma list of groups: `meta`, `read`, `create`, `modify`, `style`, `export`, `eval`. Use it for apps with a tool limit, such as VS Code (128 `[C-286]`) and Windsurf (100 `[C-289]`), or untick tools in the app's own picker. Group sizes: [tools.md](docs/reference/tools.md) |
| `BRIDGE_ALLOW_EVAL` | `0` | `1` registers `figma_eval`, which runs Plugin API JavaScript. The toolset must include the `eval` group (`full` does) |
| `BRIDGE_ALLOW_UNVERIFIED` | `0` | `1` lets this process run writes that are not yet verified in a file's editor. Meant for measuring runs |
| `BRIDGE_HOME` | `~/.figxel` | Holds the token, the plugin copy and the exports |
| `BRIDGE_EXPORT_DIR` | `<home>/exports` | Where a relative `saveTo` path goes |
| `BRIDGE_EXPORT_ROOTS` | *(empty)* | More folders that exports may write to. Separate them with `;` on Windows and `:` on macOS and Linux |
| `BRIDGE_SESSION_WAIT_MS` | `5000` | How long a call waits for a reconnecting plugin before it answers `NO_SESSION` (0–600000) |
| `BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr, which your app keeps in its MCP log |
| `BRIDGE_PORT` | `38452` | For tests only: the plugin always connects to 38452 |

`BRIDGE_AUTOLAUNCH` is still accepted and does nothing; auto-launch was removed ([roadmap § Opening the plugin](docs/reference/roadmap.md#opening-the-plugin)).

## Privacy

- **Figxel runs on your machine.** The server listens only on `127.0.0.1`, the plugin connects only to it, and Figxel sends nothing to any other service. The agent's edits are ordinary edits in your Figma file.
- **Your AI app sends what the agent reads to its model provider.** That includes file, page and layer names, text content, the images the agent exports to look at, and the Figma user name and id that `figma_status` shows. The plugin asks Figma for the current user (the `currentuser` permission) so that `figma_status` can name who is connected.
- **Tools that take a URL** (`figma_import_image`, `figma_create_link_preview`) hand it to Figma, which loads it `[C-076]`.
- **The token** lives in `~/.figxel/token` (readable only by you on macOS and Linux). The plugin keeps its copy in Figma's plugin storage on your machine, which is not synchronised `[C-276]`. The server never sends the token to your AI app, and never logs it.
- **Exports** go to `~/.figxel/exports`, or to a folder you allow with `BRIDGE_EXPORT_ROOTS`. Nothing is written anywhere else.
- **Before you post `figma_status` output in an issue,** remove your Figma user name and id, file and page names, and paths that contain your user name.

## Troubleshooting

- **"No Figma plugin is connected" (`NO_SESSION`).** Run the plugin in Figma: **Plugins → Development → Figxel**. If it is not in that menu, run `npx -y figxel-mcp@latest setup` and import the manifest it prints `[C-274]`.
- **"Its token is wrong".** Run setup again, which prints the token, and paste it into the Figxel plugin window, then press **Save**.
- **`PORT_IN_USE`.** Another program, or an older Figxel, holds port 38452. Close it; Figxel takes over within 5 s.
- **The server does not start on Windows** (for example `spawn npx ENOENT` in the app's log). Use the `cmd /c npx …` form `[C-281]`. Claude Code does not need it `[C-280]`.
- **Too many tools.** VS Code refuses a request with more than 128 tools `[C-286]` and Windsurf allows 100 `[C-289]`, and Figxel alone registers 132. Set `BRIDGE_TOOLSET` (see [Configuration](#configuration)) or untick tools in the app.
- **Codex times out on the first start.** Codex waits 10 s for a server to start `[C-287]`, and a first `npx` run has to download the package. Run `npx -y figxel-mcp@latest setup` first: npx keeps the package under the same `figxel-mcp@latest` name the client entry uses `[C-283]`. Or raise `startup_timeout_sec` `[C-287]`.
- **Long calls time out.** Each app has its own tool-call timeout; [docs/clients.md](docs/clients.md) shows how to raise it. A video render answers with a job id before a short timeout and is collected later.
- **A video export stalls.** Keep the Figma window restored, not minimized, while it renders: a render stalled for about 40 minutes while the window was minimized, and Figma ends a render it has not finished after about 240 s `[C-198]`.
- **`figma_status` says `restart: "plugin"` or `restart: "client"`.** Close the Figxel plugin window and run it again, or restart your AI app, as the hint says.
- **macOS.** CI runs the tests on macOS, but nothing has been run live there yet. If something fails, please [open an issue](https://github.com/AvYour/figxel-mcp/issues).
- **Logs.** The server logs to stderr, which your app keeps; Claude Desktop writes `mcp-server-figxel.log` in `~/Library/Logs/Claude` or `%APPDATA%\Claude\logs` `[C-277]`.

## Documentation

| Document | What is in it |
|---|---|
| [Using it from any AI app](docs/clients.md) | Setup per app, installing the skills, tool-call timeouts, sharing one Figma connection |
| [Using Figxel as an agent](docs/agents/using-the-mcp.md) | How an agent should work: the loop, the skills, prompts and resources, choosing a tool, the safety rules |
| [Tool catalog](docs/reference/tools.md) | Every tool and its parameters, toolsets, resources, and which editor runs each tool |
| [Protocol](docs/reference/protocol.md) | The wire protocol between the server and the plugin |
| [Design spec](docs/superpowers/specs/2026-10-06-figma-mcp-design.md) | Architecture, configuration, limits, safety, errors, testing and decisions |
| [Roadmap](docs/reference/roadmap.md) | Phases, next steps, locked decisions, and why Figxel uses a plugin |
| [Claim registry](docs/reference/claims.md) | Every external fact the design relies on, with source and date |
| [Contributing](CONTRIBUTING.md) | Development setup, conventions, tracked claims, pull requests |

Figxel was called figma-mcp during development, so dated documents (the design spec's file name, plans and spike results) keep that name.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes. Changes are listed in the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE). The npm package bundles third-party code under its own licences, listed in `dist/THIRD_PARTY_NOTICES.md`.
