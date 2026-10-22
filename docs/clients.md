# Using Figxel From Any AI App

Figxel is not tied to one app or one model. It is a standard MCP server over stdio, so **any app that speaks MCP can use it, whatever model the app runs**: Claude, GPT, Gemini, GLM or a local model. What differs between apps is how you register the server, how many tools the app accepts and how long it waits for a tool call.

**Several apps can use Figma at the same time.** The first Figxel process to start holds the Figma connection (the *hub*). Every later one, from Claude Code, VS Code, Codex or a second chat, *shares* it as a proxy. If the hub's app quits, another process takes over within seconds and the plugin reconnects by itself ([spec §4.2](superpowers/specs/2026-10-06-figma-mcp-design.md#42-one-process-not-two)). `figma_status` shows which role a process has (`bridge.role`: `hub` / `proxy`) and, for a proxy, which process it shares (`bridge.hubPid`).

> After an update, **restart every app that runs Figxel**, so that they all run the same version. A process too old to share the hub's connection reports `PORT_IN_USE` until its app restarts the server (Hermes: `/reload-mcp`), and `figma_status` asks for a client restart when the hub is older than the installed version.

Each app fact below carries the id of its entry in the [claim registry](reference/claims.md), which records the source and the date it was checked (2026-10-14 for most of them).

---

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
- **Or both connect to a team's hub** on a server, when your team runs one: see [Connecting to a team's hub](#connecting-to-a-teams-hub). Files are still read and written on your computer.

## Before any app

Figxel needs **Figma desktop**, which exists for macOS 12 or later and for Windows 10 or later (64-bit, and Windows Arm); there is no Linux build `[C-273]`. It also needs **Node.js 22 or later**: Node 22 is maintained until 2027-04-30 and Node 24 is the active LTS line `[C-292]`.

Quit Figma desktop completely (on Windows, closing its window leaves it running: quit it from its icon in the notification area too `[C-341]`), then run setup once, in a terminal:

```bash
npx -y figxel-mcp@latest setup --register
```

`-y` skips npx's install prompt `[C-282]`. Setup creates the plugin token, copies the Figma plugin into `~/.figxel/plugin` (the home folder; `BRIDGE_HOME` moves it), lists the plugin in Figma desktop by writing into Figma's settings file (`%APPDATA%\Figma\settings.json` on Windows) the same entries an import writes, after a backup next to it `[C-275]` `[C-319]` `[C-323]`, and prints the token and ready-made entries for Claude Desktop, Claude Code and any other app. [Install details](#install-details) has the backup, the options and the manual import. Then, in Figma desktop, open or create a file and:

1. Run the plugin: **Plugins → Development → Figxel**. Nothing outside Figma can run a plugin, so you start it once per Figma session `[C-016]`.
2. Paste the token into the plugin window and press **Save**. Once connected, the window shows the token's fingerprint (its first and last four characters) next to **Connected**; setup prints the same fingerprint, and `figma_status` shows the one of the server your app runs. When they differ, the plugin is connected to another server.

The README's [Quickstart](../README.md#quickstart) is the same flow in four steps.

### Install details

What `setup --register` does to Figma's settings, its options, and the manual import.

- **It changes only Figxel's entries, after a backup.** Setup backs up Figma's settings file first (`settings.json.figxel-backup-<time>`, next to it), refuses while Figma runs because Figma writes that file itself `[C-321]`, and refuses a file that is not in the measured form `[C-319]`.
- **`--dry-run`** shows the change without writing anything.
- **An earlier import stays.** If you already imported Figxel from another folder, setup keeps that registration and says so; `--force` moves it to `~/.figxel/plugin` `[C-323]`.
- **`setup --unregister`** removes the entries setup wrote. Quit Figma first, as for `--register`.
- **Windows and macOS.** The settings file was measured on Windows; on macOS `--register` is experimental, because the file there is not yet measured `[C-324]`. There is no Linux build of Figma `[C-273]`.
- **The manual import.** If Figxel is not under **Plugins → Development** (or you would rather not let setup touch Figma's settings), run `npx -y figxel-mcp@latest setup` without `--register` and import the plugin by hand: **Plugins → Development → Import plugin from manifest…**, then choose the manifest setup printed: `~/.figxel/plugin/manifest.json`, or `C:\Users\<you>\.figxel\plugin\manifest.json` on Windows. Figma's Help Center calls the item "Import new plugin from manifest..." `[C-274]`. Either way this is needed only once: Figma reads the plugin's files from that path each time the plugin runs, so an update needs no re-import `[C-275]`.

### The server entry

Every app starts the same command:

| | Value |
|---|---|
| Transport | stdio |
| Command (macOS, and Windows apps that use a shell) | `npx`, with the arguments `-y` and `figxel-mcp@latest` |
| Command (Windows, the form setup prints) | `cmd`, with the arguments `/c`, `npx`, `-y` and `figxel-mcp@latest` |

**Why `cmd /c` on Windows.** On Windows `npx` is a `.cmd` file, and Node's `child_process.spawn` cannot start one without a shell: a bare `npx` fails with `ENOENT`, while `cmd /c npx …` runs `[C-281]`. An app that starts its servers without a shell therefore needs the `cmd` form. Claude Code does not, because it starts every stdio server through `cmd.exe` itself `[C-280]`. For the other apps, which one uses a shell has not been measured app by app, so the entries below use the form setup prints.

**Why `@latest`.** `npx figxel-mcp@latest` asks the registry for the newest version each time the app starts the server and reuses a downloaded copy only when it is that version `[C-283]`. Restarting the app is how it picks up an update. Running setup first also fills npx's cache for the same `figxel-mcp@latest` spec, so the app's first start only checks the registry instead of downloading the package `[C-283]`.

---

## Per app

No app is privileged. The order below says nothing about preference.

### Claude Desktop

Add an entry under `mcpServers` in `claude_desktop_config.json` (**Settings → Developer → Edit Config** creates or opens it), then quit Claude Desktop completely and start it again `[C-277]`:

| OS | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` `[C-277]` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`, also for the Microsoft Store build `[C-277]` `[C-278]` |

macOS:

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "figxel": { "command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"] }
  }
}
```

If the file already has other top-level keys, or an `mcpServers` object, add the entry beside them. Server logs go to `~/Library/Logs/Claude` on macOS and to `%APPDATA%\Claude\logs` on Windows, in `mcp-server-figxel.log`. The MCP documentation notes that npx may fail on Windows unless npm is installed globally, so that `%APPDATA%\npm` exists `[C-277]`. Claude Desktop also has a Linux beta, but no Linux config path is documented `[C-277]`, and Figma desktop has no Linux build anyway `[C-273]`.

Claude Desktop cut a `figma_export_video` call at about 60 s, twice `[C-197]`, and restarted the server about 2 s after its calls timed out `[C-271]`. That is why a video render runs as a job (see [Tool-call timeouts](#tool-call-timeouts-differ-a-lot)).

### Claude Code

```bash
claude mcp add -s user figxel -- npx -y figxel-mcp@latest
```

Everything after `--` reaches the server untouched, so `-y` goes to npx `[C-279]`. `-s user` makes the server available in every project; the default scope, `local`, covers the current project only, and `project` shares it through `.mcp.json` `[C-279]`. The same command works on native Windows, because Claude Code starts stdio servers through `cmd.exe` itself `[C-280]`. Setup prints the Windows command with `cmd /c` in front; that form has not been measured in Claude Code `[C-280]`, so the plain one above is the measured choice.

Prompts appear as `/figxel:design_in_figma` and resources are referenced with `@` `[C-176]`. The tool-call timeout and how to raise it are under [Tool-call timeouts](#tool-call-timeouts-differ-a-lot).

### Cursor

Cursor reads `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project), under the key `mcpServers` `[C-284]` ([docs](https://cursor.com/docs/mcp)):

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"]`. Cursor's MCP page states no limit on the number of tools `[C-284]`; it has not been measured with Figxel's 140 tools. If Cursor refuses that many, trim them (see [Model notes](#model-notes)).

### VS Code

VS Code reads two formats `[C-285]`:

- **Portable**, key `mcpServers`: `.mcp.json` at the workspace root, or `~/.copilot/mcp-config.json` for the user. VS Code's **MCP: Add Server** flow recommends these.
- **VS Code's own**, key `servers`: `.vscode/mcp.json` in a workspace, or the user profile's `mcp.json`. The Add Server flow calls these destinations deprecated.

The portable user file, `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"]`. Or, from a bash or zsh terminal, `code --add-mcp` adds the server to the user profile's own `mcp.json` `[C-285]`:

```bash
code --add-mcp '{"name":"figxel","command":"npx","args":["-y","figxel-mcp@latest"]}'
```

In PowerShell, edit the file instead: quoting JSON for a native command differs there.

**Too many tools.** A VS Code chat request can have at most 128 tools enabled, and fails above that with "Cannot have more than 128 tools per request." `[C-286]`. Figxel registers 140 tools by default, so it is over the limit on its own. Deselect tools (or whole servers) in the chat's tools picker, or turn on virtual tools with the setting `github.copilot.chat.virtualTools.threshold` `[C-286]`. Starting the server with a smaller `BRIDGE_TOOLSET` also works (see [Model notes](#model-notes)).

Prompts run as `/figxel.design_in_figma`, and resources are attached through **Add Context** `[C-178]`.

### Codex

```bash
codex mcp add figxel -- npx -y figxel-mcp@latest
```

On Windows, put `cmd /c` before `npx`. The same entry can be a `[mcp_servers.figxel]` table in `~/.codex/config.toml`, or in `.codex/config.toml` in a trusted project `[C-287]` ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)):

```toml
[mcp_servers.figxel]
command = "npx"
args = ["-y", "figxel-mcp@latest"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
```

On Windows: `command = "cmd"` and `args = ["/c", "npx", "-y", "figxel-mcp@latest"]`.

Codex waits **10 s for a server to start and 60 s for a tool call** by default `[C-287]`. A first start that has to download the package can exceed 10 s, so run setup first (it fills npx's cache, see [The server entry](#the-server-entry)) or raise `startup_timeout_sec` as above. Raise `tool_timeout_sec` for long calls. `enabled_tools` and `disabled_tools` filter tools per server `[C-287]`.

### Gemini CLI

Gemini CLI reads `mcpServers` in `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project) `[C-288]` ([docs](https://geminicli.com/docs/tools/mcp-server/)):

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"]`. The command form is:

```bash
gemini mcp add -s user figxel npx -- -y figxel-mcp@latest
```

Pass `-s user`: without it, `gemini mcp add` writes to the project file in the current folder `[C-288]`. The `--` keeps `-y` for npx, as in the docs' own example of a server argument that starts with a dash `[C-288]`; this exact command has not been run. A tool call times out after `timeout` milliseconds, 600,000 (10 minutes) by default, and `includeTools` / `excludeTools` filter tools `[C-288]`.

### Devin Desktop and Windsurf

Windsurf's MCP documentation now redirects to Devin Desktop's, which reads `mcpServers` from `~/.config/devin/mcp_config.json` on macOS and Linux, or `%APPDATA%\devin\mcp_config.json` on Windows `[C-289]`:

```json
{
  "mcpServers": {
    "figxel": { "command": "npx", "args": ["-y", "figxel-mcp@latest"] }
  }
}
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"]`. Whether an existing Windsurf install still reads an older config file is not documented `[C-289]`.

**Too many tools.** Cascade can use at most 100 tools at any one time `[C-289]`, and Figxel registers 140 by default, so trim them with `BRIDGE_TOOLSET` (see [Model notes](#model-notes)).

### Hermes

```bash
hermes mcp add figxel --command npx --args figxel-mcp@latest
```

On Windows: `--command cmd --args /c npx figxel-mcp@latest`. `--args` must be the last option `[C-034]`. The entry leaves out `-y`, which Hermes might read as an option of its own; npx assumes yes anyway when it runs without a terminal, as it does under an MCP app `[C-282]`. Hermes was measured with a `node` entry for a clone; the npx entry has not been run.

With no terminal attached, the "Enable all tools?" prompt cancels without saving, so answer it (`printf 'Y\n' | hermes mcp add …` when scripting). Raise the tool-call timeout: the default is 300 s of wall-clock time `[C-031]`, and it accepts up to about 49.7 days on Windows `[C-042]`:

```bash
hermes config set mcp_servers.figxel.timeout 3600
```

`hermes mcp configure figxel` selects tools per server `[C-034]`.

### Any other MCP app

Register a **stdio** server with the command from [The server entry](#the-server-entry). Nothing in Figxel is specific to one app. Check how many tools the app accepts, and how long it waits for a tool call.

### Running from a clone

Contributors run the server from a clone instead of the npm package: command `node` with the absolute path of the clone's `dist/server.js`, and the plugin imported from `dist/plugin/manifest.json`. See [CONTRIBUTING § Development setup](../CONTRIBUTING.md#development-setup).

## Connecting to a team's hub

When your team runs a hub ([docs/hub.md](hub.md)), the plugin and your AI apps connect to it instead of to this computer. Whoever runs it sends you an **invite**: one line with the hub's address and your own token, `wss://…#…`. Keep it private, as you would a password. Everything else in this page stays the same.

0. **Install the plugin**, once: quit Figma desktop, then run `npx -y figxel-mcp@latest install`. It copies the plugin into `~/.figxel/plugin` and lists it under **Plugins → Development** in Figma, as `setup --register` does, with no server and no token on your computer.
1. **The plugin.** A new Figxel window opens on **Welcome to Figxel** with one **Sign in** button, which signs in to Figxel Cloud (`mcp.figxel.moirelabs.dev`): the page that opens shows the same code as the window; sign in there with Figma or Google, and the window connects. For your team's own hub, press **Change** under Figxel Cloud and paste its address (or your invite), then **Sign in with the browser**. **Reset Figxel in this Figma**, at the bottom, forgets all of it and starts over. Each server keeps its own token, so this computer's token stays saved for later. Once connected, the window shows the hub and **Signed in as** your name: if the name is not yours, the invite is not either.
2. **Your AI apps, all at once.** In a terminal, run once:

   ```bash
   npx -y figxel-mcp@latest join 'wss://mcp.figxel.example#<your token>'
   ```

   It checks the invite against the hub, says "as <your name>", and saves it in `~/.figxel/hub.json`, which every Figxel process on this computer reads when it starts. Restart your AI apps; their server entries stay as they are.

An app can also be pointed at a hub on its own, with two settings in its server entry's environment ([Configuration § Where to set them](configuration.md#where-to-set-them)): `BRIDGE_HUB_URL`, the hub's address, and `BRIDGE_TOKEN`, your token. They win over what `join` saved. In Claude Code, for example `[C-279]`:

```bash
claude mcp add -s user figxel --env BRIDGE_HUB_URL=wss://mcp.figxel.example --env BRIDGE_TOKEN=<your token> -- npx -y figxel-mcp@latest
```

With `BRIDGE_HUB_URL` set, the server never takes this computer's port, so it cannot become a hub by accident; when the hub is away it keeps trying, and a call says it cannot reach the hub. Exports, imports, `saveTo` paths and ffmpeg run on this computer as before: only the plugin's requests and answers cross the hub. `figma_status` names the hub (`bridge.hub`) and says the process works through it.

You see only your own Figma files, and nobody else on the hub sees yours: another person's file is as if it did not exist. To go back to this computer, press **This computer** in the plugin window and run `npx -y figxel-mcp@latest leave`, then restart your AI apps; **Team hub** takes the plugin back to the same hub in one click.

### Apps by URL

When the hub runs its web endpoint ([docs/hub.md § Web clients](hub.md#web-clients)), an app with no Figxel process on your computer reaches it at `https://mcp.figxel.example/mcp`. It signs in with OAuth, where the app opens the hub's sign-in page and you continue with Figma or Google (or paste your invite), or with your token in a header, `Authorization: Bearer <your token>` (the part of your invite after `#`). Your Figma connects to the hub as above. Files come back as download links that last an hour, not as files on your computer.

- **ChatGPT** (developer mode): add the URL as a connector with OAuth `[C-407]`; it opens the hub's sign-in page.
- **claude.ai** (and Claude Desktop's connectors): add a custom connector with the URL. It signs in with OAuth, or put the header in its request headers instead `[C-406]`.
- **Claude Code** `[C-411]`:

  ```bash
  claude mcp add --transport http figxel https://mcp.figxel.example/mcp --header "Authorization: Bearer <your token>" --scope user
  ```

- **Cursor**: an entry in `mcp.json` with `url` and `headers`, the token read from an environment variable `[C-412]`:

  ```json
  { "mcpServers": { "figxel": { "url": "https://mcp.figxel.example/mcp", "headers": { "Authorization": "Bearer ${env:FIGXEL_TOKEN}" } } } }
  ```

- **VS Code**: an entry with `"type": "http"`, the token asked for once and stored by VS Code `[C-413]`:

  ```json
  { "inputs": [{ "type": "promptString", "id": "figxel-token", "description": "Figxel token", "password": true }],
    "servers": { "figxel": { "type": "http", "url": "https://mcp.figxel.example/mcp", "headers": { "Authorization": "Bearer ${input:figxel-token}" } } } }
  ```

On the sign-in page, check the app's name and the address it returns to before you press **Allow**. The app keeps an access token, never your invite; whoever runs the hub ends every app's access by removing you or giving you a new invite.

---

## Installing the skills

Nothing has to be installed for an agent to get the skills. The server serves them to every app through `figma_get_guide`, and as prompts and `skill://` resources to the apps that show those ([Using Figxel as an Agent § The skills](agents/using-the-mcp.md#the-skills)). Installing the folders as skills is optional. It lets an app that loads Agent Skills offer them by itself, before any tool call.

The skills are the eleven folders `src/skills/figxel-<short>/` in the repository. The usual set is five: `figxel-workflow`, `figxel-design`, `figxel-storyboard`, `figxel-motion` and `figxel-critique`. Where each app looks for them:

| App | Personal skill folders it reads | Prompts and resources |
|---|---|---|
| Claude Code | `~/.claude/skills`; a symlinked folder is followed `[C-175]` | Prompts as `/figxel:design_in_figma`, arguments split on whitespace; resources with `@` `[C-176]` |
| Codex | `~/.agents/skills` `[C-177]` | Its MCP page documents tools and `instructions`, not prompts or resources `[C-177]` |
| Cursor | `~/.agents/skills`, `~/.cursor/skills`, and `~/.claude/skills` for compatibility `[C-178]` | Both supported `[C-178]` |
| VS Code (Copilot) | `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills` `[C-178]` | Prompts as `/figxel.design_in_figma`; resources through Add Context `[C-178]` |
| Gemini CLI | `~/.gemini/skills`, `~/.agents/skills` `[C-178]` | Prompts as slash commands; resources with `@` `[C-178]` |

So one copy in `~/.claude/skills` and one in `~/.agents/skills` cover all five apps `[C-178]`.

**With `npx skills add`**, which installs skills from a GitHub shorthand, a git URL or a local path into the skill folders of many agents at once: globally with `-g`, and a subset with `--skill` `[C-179]`:

```bash
npx skills add AvYour/figxel-mcp/src/skills -g
```

```bash
npx skills add AvYour/figxel-mcp/src/skills -g --skill figxel-design
```

**Or by copying** the `figxel-<short>` folders from a download of the repository into `~/.claude/skills` and `~/.agents/skills`.

An installed copy does not update itself. After an update, install again; whatever an installed copy says, the text `figma_get_guide` returns is the current one.

**Contributors: link, do not copy,** so the installed skills stay equal to the clone after every pull. Windows (PowerShell), a junction per skill:

```powershell
$src = "<path to your clone>/src/skills"
foreach ($dir in "$HOME/.claude/skills", "$HOME/.agents/skills") {
  New-Item -ItemType Directory -Force $dir | Out-Null
  foreach ($s in "workflow", "design", "storyboard", "motion", "critique") {
    New-Item -ItemType Junction -Path "$dir/figxel-$s" -Target "$src/figxel-$s" | Out-Null
  }
}
```

macOS and Linux, a symbolic link per skill:

```bash
src=/path/to/your/clone/src/skills
for dir in ~/.claude/skills ~/.agents/skills; do
  mkdir -p "$dir"
  for s in workflow design storyboard motion critique; do ln -s "$src/figxel-$s" "$dir/figxel-$s"; done
done
```

Claude Code follows a symlinked skill folder `[C-175]`; whether it treats a Windows junction the same way is not yet measured. Check that the app lists the five skills; if Claude Code does not, replace the junctions with symbolic links. `npx skills add` also takes a local path `[C-179]`, but its README does not say whether such an install stays linked to the folder `[C-179]`, so after a pull, check that the installed copy changed.

---

## Updating and uninstalling

### Updating

- **With `@latest` in the entry** (as in [The server entry](#the-server-entry)), npx asks the registry for the newest version each time your app starts the server `[C-283]`. To update, restart the app.
- **The plugin follows the server.** When a new version starts, the server copies its plugin into `~/.figxel/plugin`. Close the Figxel plugin window in Figma and run it again; Figma reads the plugin files on each run, so there is nothing to re-import `[C-275]`.
- **`figma_status` tells you what is stale.** Its hint says whether to re-run the plugin or restart the app.
- **Keep every app on the same entry.** Two apps running different versions copy their own plugin into `~/.figxel/plugin` in turn, each time one of them starts the server.

### Uninstalling

1. Remove the `figxel` entry from each AI app's configuration.
2. In Figma desktop, remove Figxel from your development plugins (under **Plugins → Development**). If setup registered it (`setup --register`), you can instead quit Figma and run `npx -y figxel-mcp@latest setup --unregister`, which removes the entries setup wrote.
3. Delete the home folder, `~/.figxel` (`%USERPROFILE%\.figxel` on Windows). It holds the token, the plugin copy and, by default, your exports: move any exports you want to keep first.

---

## Tool-call timeouts differ a lot

| App | Default wait per tool call | Raise it with |
|---|---|---|
| Codex | 60 s `[C-287]` | `tool_timeout_sec` |
| Hermes | 300 s `[C-031]` | `mcp_servers.figxel.timeout` |
| Gemini CLI | 10 min `[C-288]` | `timeout` (ms) |
| Claude Code | about 28 h `[C-279]` | `MCP_TOOL_TIMEOUT` or a per-server `timeout` (ms), a hard wall-clock limit that progress does not extend `[C-176]` |
| Claude Desktop | a `figma_export_video` call was cut at about 60 s, twice `[C-197]` | not documented here; which timer fired is not known `[C-197]`. The video job answers before it |

The bridge itself has no duration limit (spec [§5.5](superpowers/specs/2026-10-06-figma-mcp-design.md#55-defeating-limits--the-no-quota-strategy-in-practice)), so the app's default is what stops a long `figma_create_from_spec`. Raise it in apps with short defaults. Whatever the app does when it gives up, retrying a write tool with the same `idempotencyKey` never runs it twice.

**Some apps cut a call at 60 s, and a video render can take longer.** An app built on the TypeScript MCP SDK with its defaults gives up on a request after 60 s, and progress resets that timer only when the app opts in `[C-030]`. On 2026-10-09 a `figma_export_video` call made through Claude Desktop was cut at about 60.4 s, twice, and the cancel discarded the render `[C-197]`. So `figma_export_video` runs as a job: a call waits at most `wait` seconds (default 40, and never more than 45 unless `BRIDGE_VIDEO_MAX_WAIT_S` raises that cap for an app with a longer timeout) and then answers `status: "rendering"` with a `jobId`. The render goes on, and calling `figma_export_video { jobId }` again collects it. A client's timeout or cancel ends only the waiting call `[C-249]`. Nothing has to be configured for this; an agent only has to call again.

**Raising the limit in Claude Code** still helps the other long calls. Set `MCP_TOOL_TIMEOUT` (milliseconds) in the environment that starts Claude Code, or a per-server `timeout` in the server's entry; either is a hard wall-clock limit per call that progress does not extend. A stdio server like this one gets no 60 s request timer there (HTTP and SSE servers do), and a separate idle check stops a stdio call that sends neither a result nor progress for 30 minutes; its own variable is `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` `[C-176]`.

```bash
MCP_TOOL_TIMEOUT=3600000 claude          # PowerShell: $env:MCP_TOOL_TIMEOUT = "3600000"; claude
```

## Model notes

- **Tool schemas are kept portable.** Every tool's input schema stays inside a conservative JSON Schema subset (no `anyOf`/`$ref`/`const`/`format`…, every object has `properties`, every array has `items`), so apps can translate it for any provider. `test/schema-portability.test.ts` enforces this in CI for every tool, including ones added later.
- **Some apps cap the number of tools.** VS Code allows 128 per chat request `[C-286]` and Devin Desktop's Cascade 100 at a time `[C-289]`, while Figxel registers 140 by default. OpenAI's function-calling guide suggests fewer than 20 functions at the start of a turn, as a soft suggestion `[C-290]`.
- **Smaller and local models do better with fewer tools.** Trim per app, in the app's own tool picker if it has one, or with an environment variable in that app's server entry: `BRIDGE_TOOLSET=core` (20 tools) or a group list such as `read,export` ([tools.md § Trimming the toolset](reference/tools.md#trimming-the-toolset)). `figma_get_guide` stays registered in every toolset but `none`, so a trimmed agent still gets the skills.
- **Nothing depends on the model.** `figma_status` is the first call for any model: it works without a plugin and says what to do next.
