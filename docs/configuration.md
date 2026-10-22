# Configuration

Every setting Figxel reads, its default, and where to set it; the README's [Configuration](../README.md#configuration) names the two most people change.

Ids such as `[C-286]` point to the [claim registry](reference/claims.md), where each external fact has its source and the date it was checked.

## Where to set them

Settings are environment variables, set in the environment your AI app starts the server with: an `env` setting in the server entry in Codex `[C-287]` and Gemini CLI `[C-288]`, `--env KEY=value` in Claude Code `[C-279]`, and the other apps as [docs/clients.md](clients.md) shows. Flags accept only `0` or `1`, and an invalid value stops the server with a message on stderr.

## Every setting

| Variable | Default | What it does |
|---|---|---|
| `BRIDGE_TOOLSET` | `full` | Which tools to register: `full`, `core` (a curated 20-tool set), `none` (only `figma_status`), or a comma list of groups: `meta`, `read`, `create`, `modify`, `style`, `export`, `eval`. Use it for apps with a tool limit, such as VS Code (128 `[C-286]`) and Windsurf (100 `[C-289]`), or untick tools in the app's own picker. Group sizes: [tools.md](reference/tools.md) |
| `BRIDGE_ALLOW_EVAL` | `0` | `1` registers `figma_eval`, which runs Plugin API JavaScript. The toolset must include the `eval` group (`full` does) |
| `BRIDGE_ALLOW_UNVERIFIED` | `0` | `1` lets this process run writes that are not yet verified in a file's editor. Meant for measuring runs |
| `BRIDGE_PROCESS` | `strict` | How the design process is enforced `[C-338]` `[C-384]`. `strict`: new work (a new top-level frame, component or section, a spec into an empty frame, a new deck or board, a storyboard) answers `PROCESS_REQUIRED` until a brief for its role is in force (`figma_set_brief`, after the role's skill is read); a final export (`final: true` on `figma_export_node`, `figma_export_frames_to_pdf` or `figma_export_video`) waits for a passing `figma_sign_off` newer than the last change; keyframe tools wait for the motion skill and a plan for the frame (`figma_set_motion_plan`), and a final video render for a passing `figma_check_motion`. Edits of existing work are never gated. `guided`: those calls run and their results list the skipped steps as `processWarnings`. `off`: no checks. Any other value stops the server |
| `BRIDGE_CONFLICTS` | `refuse` | What a write does to a node someone else changed after the agent last read or wrote it `[C-397]`. `refuse`: the write answers `STALE` and changes nothing until the agent reads the node again, or the call passes `force: true`. `warn`: the write runs and its result lists the conflict under `conflicts`. `off`: no check. A rollback refuses to undo anyone else's edit whatever this says. Any other value stops the server |
| `BRIDGE_HOME` | `~/.figxel` | Holds the token, the plugin copy and the exports; a computer that joined a team's hub, that hub (`hub.json`); on a team's hub, its table of people (`hub-people.json`) |
| `BRIDGE_EXPORT_DIR` | `<home>/exports` | Where a relative `saveTo` path goes |
| `BRIDGE_EXPORT_ROOTS` | *(empty)* | More folders that exports may write to. Separate them with `;` on Windows and `:` on macOS and Linux |
| `BRIDGE_SESSION_WAIT_MS` | `5000` | How long a call waits for a reconnecting plugin before it answers `NO_SESSION` (0–600000) |
| `BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr, which your app keeps in its MCP log |
| `BRIDGE_FFMPEG` | `ffmpeg` | The ffmpeg program, as a name on PATH or a full path. A full path also finds `ffprobe` in the same folder |
| `BRIDGE_FFPROBE` | `ffprobe` | The ffprobe program, when it is not beside `BRIDGE_FFMPEG` or on PATH |
| `BRIDGE_VIDEO_MAX_WAIT_S` | `45` | The longest one `figma_export_video` call waits for a render (0–600), whatever its `wait` asks. Raise it only for an app whose tool-call timeout is longer than 60 s |
| `BRIDGE_HUB_URL` | *(empty)* | Connects to a team's hub at this address instead of this computer ([docs/clients.md § Connecting to a team's hub](clients.md#connecting-to-a-teams-hub)): `wss://…`, or `ws://` only to `127.0.0.1` or `localhost` (a tunnel). The process then never takes port 38452 and keeps trying while the hub is away. Files are still read and written on this computer. Unset, the process uses the hub `figxel-mcp join` saved in `<home>/hub.json`, if any |
| `BRIDGE_TOKEN` | *(empty)* | Your token for that hub, 64 hexadecimal characters, from whoever runs it. Used in place of the home folder's token file, and in place of the token `join` saved |
| `BRIDGE_HUB_PUBLIC_URL` | *(empty)* | For `figxel-mcp hub` only: the hub's own `wss://` address as people reach it, so `hub add` prints an invite (the address and the person's token in one line) instead of the token alone ([docs/hub.md](hub.md#people-and-tokens)) |
| `BRIDGE_HUB_WEB` | `0` | For `figxel-mcp hub` only: `1` also serves MCP over HTTP at `/mcp` for web clients and apps by URL, signed in with a person's token; needs `BRIDGE_HUB_PUBLIC_URL` ([docs/hub.md § Web clients](hub.md#web-clients)) |
| `BRIDGE_HUB_REDIRECT_HOSTS` | *(empty)* | For `figxel-mcp hub` with `BRIDGE_HUB_WEB` only: a comma list of the hosts an app signing in with OAuth may return to, such as `claude.ai,chatgpt.com,localhost`. Empty: any https host, or localhost |
| `BRIDGE_HUB_FIGMA_CLIENT_ID`, `BRIDGE_HUB_FIGMA_CLIENT_SECRET` | *(empty)* | For `figxel-mcp hub` with `BRIDGE_HUB_WEB` only: a Figma OAuth app, for **Continue with Figma**; both or neither ([docs/hub.md § Sign-in with Figma or Google](hub.md#sign-in-with-figma-or-google)) |
| `BRIDGE_HUB_GOOGLE_CLIENT_ID`, `BRIDGE_HUB_GOOGLE_CLIENT_SECRET` | *(empty)* | Likewise, a Google OAuth client, for **Continue with Google** |
| `BRIDGE_HUB_GOOGLE_ALLOW` | *(empty)* | A comma list of emails and `@domains` a Google sign-in comes in with, besides the emails of people in the table |
| `BRIDGE_HUB_SIGNUP` | `team` | `open` lets any Google account in, as a new person on its first sign-in. `team`: Figma's own team, the table's emails and `BRIDGE_HUB_GOOGLE_ALLOW` only |
| `BRIDGE_HUB_BIND` | `127.0.0.1` | For `figxel-mcp hub` only: the address the hub listens on. `0.0.0.0` only inside a container whose network reaches nothing but the TLS proxy in front of it ([docs/hub.md](hub.md)) |
| `BRIDGE_PORT` | `38452` | For tests only: the plugin always connects to 38452 on this computer |

`BRIDGE_AUTOLAUNCH` is still accepted and does nothing; auto-launch was removed ([roadmap § Opening the plugin](reference/roadmap.md#opening-the-plugin)).
