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
| `BRIDGE_PROCESS` | `strict` | How the motion process is enforced `[C-338]`. `strict`: keyframe tools answer `PROCESS_REQUIRED` until the agent has read the motion skill and stored a plan for the frame (`figma_set_motion_plan`), and a final video render (`final: true`) waits for a passing `figma_check_motion`. `guided`: those calls run and their results list the skipped steps as `processWarnings`. `off`: no checks. Any other value stops the server |
| `BRIDGE_HOME` | `~/.figxel` | Holds the token, the plugin copy and the exports |
| `BRIDGE_EXPORT_DIR` | `<home>/exports` | Where a relative `saveTo` path goes |
| `BRIDGE_EXPORT_ROOTS` | *(empty)* | More folders that exports may write to. Separate them with `;` on Windows and `:` on macOS and Linux |
| `BRIDGE_SESSION_WAIT_MS` | `5000` | How long a call waits for a reconnecting plugin before it answers `NO_SESSION` (0–600000) |
| `BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr, which your app keeps in its MCP log |
| `BRIDGE_FFMPEG` | `ffmpeg` | The ffmpeg program, as a name on PATH or a full path. A full path also finds `ffprobe` in the same folder |
| `BRIDGE_FFPROBE` | `ffprobe` | The ffprobe program, when it is not beside `BRIDGE_FFMPEG` or on PATH |
| `BRIDGE_VIDEO_MAX_WAIT_S` | `45` | The longest one `figma_export_video` call waits for a render (0–600), whatever its `wait` asks. Raise it only for an app whose tool-call timeout is longer than 60 s |
| `BRIDGE_PORT` | `38452` | For tests only: the plugin always connects to 38452 |

`BRIDGE_AUTOLAUNCH` is still accepted and does nothing; auto-launch was removed ([roadmap § Opening the plugin](reference/roadmap.md#opening-the-plugin)).
