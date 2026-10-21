# Figxel — Design Spec

| | |
|---|---|
| **Date** | 2026-10-06 |
| **Author** | Darrel Gusti, with AI agents |
| **Name** | The project is **Figxel** (npm package `figxel-mcp`, MCP server name `figxel`, plugin `Figxel`) since 2026-10-14 (ADR #40). It was called figma-mcp when this spec was written, and this dated file keeps its old name |
| **Status** | **Approved for implementation.** All decisions are locked (§15). Four design load-bearers await Phase 0 spike evidence (§14) — the results may change §5.5 and §5.7 |
| **Scope** | One project: a read-write MCP server for Figma desktop over the plugin path (local) |
| **Target** | Everything the official `use_figma` does, plus reading design context/screenshots/variables — through a plugin in the user's own Figma desktop |

> **Positioning (2026-10-14).** §1 and §2.1 argue from cost and quota, as the project did when this spec was written. Figxel is not offered as a way around Figma's limits or fees: Figma's Acceptable Use Policy forbids circumventing service limits and using the services to avoid fees owed `[C-036]`. Figxel is a local, plugin-based, read-write server for Figma Design, FigJam and Slides with design, storyboard, motion and critique skills; the factual comparison of the paths into Figma is [Roadmap § Why a plugin](../../reference/roadmap.md#why-a-plugin).

Companion documents: [tool catalog](../../reference/tools.md) (source of truth for the tool list), [protocol](../../reference/protocol.md) (wire-level), [current state](../../reference/current-state.md) (prior assets + environment).

---

## 1. The Problem

Three official paths connect an agent to Figma, and all of them cost money or quota. The figures below were checked against Figma's docs on **2026-10-06** ([MCP rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/), [REST rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)) — these numbers have already changed at least once since this spec's first draft, so recheck them before using them in user documentation.

| Path | What it can do | Its limits |
|---|---|---|
| **Official Figma MCP** (remote `mcp.figma.com` / desktop) | Read design context, screenshots, variables; write to the canvas via `use_figma` (JavaScript Plugin API) `[C-008]` | Read tools are quota-limited. **Starter plan: 20 calls/month; View/Collab seat on a paid plan: 6/month.** Dev/Full seat: Starter 200/day + 10/min, Professional 200/day + 15/min, Organization & Enterprise 600/day + 20/min |
| **Figma REST API** | Read files, nodes, variables, export images | **Read-only** `[C-005]`. Tier 1 (GET file/nodes/image): Starter 20/month, View/Collab on a paid plan 6/month; Dev/Full 10–20/min depending on plan |
| **Figma plugin** | Full read **and** write access to the open document | Must be launched by the user in Figma desktop; no quota, no cost |

Context for "20 per month": one normal agent work session — read the file, pull context for one frame, take a screenshot, read variables — burns **5–10 calls in seconds**. A month's quota can be gone by the second session.

The plugin runs inside the desktop app, needs no extra seat, has no rate limit, and never touches the external network. That is the path this project takes.

## 2. Goals

1. **Capability equivalent to the official paths for real work:** read design context, screenshots, variables/styles, and **write/modify nodes directly on the canvas**.
2. **Free** — no Dev/Full seat needed, no subscription of any kind.
3. **No quota** — no tool-call cap, no per-minute limit (§2.1).
4. **Local & safe** — loopback only (`127.0.0.1`), with a token handshake.
5. **Client- and model-agnostic** — a standard stdio MCP server that any MCP client can register (Claude Desktop, Claude Code, Hermes, VS Code, Codex, Cursor, Gemini CLI, …), whatever model it runs. No client is privileged, and several can share one Figma connection at once (§4.2). Per-client setup: [docs/clients.md](../../clients.md).
6. **Context-efficient** — responses normalized and bounded by depth/limit, not a raw JSON dump that can run to hundreds of thousands of characters.

### 2.1 "Free & No Quota" — A Precise Definition

So this claim can be tested rather than taken on faith. **One distinction matters more than all the rest: the plugin bypasses *quota*, not *plan features*.** The Plugin API mirrors the plan's restrictions `[C-045]` — it cannot hand a Starter user a capability the plan does not include.

**What is genuinely uncapped:**

| Limit on the official path | Here |
|---|---|
| 20 calls/month (Starter) or 6/month (View/Collab on a paid plan) | **none** |
| 200–600 / day, 10–20 / min (Dev/Full seat) | **none** |
| Paid seat | **not needed** — see the plan caveat below |
| REST tier | **not via REST** |
| Figma personal access token | **no Figma token needed at all** |

No counter, no quota, no subscription. Call #1 and call #10,000 cost the same: nothing.

**Plan features are a separate axis — and they still apply.** Working on a Starter (free) file:

| Capability | Starter | Affected tool |
|---|---|---|
| Variables (collections, values, binding) | ✅ **available on any plan** `[C-046]` | `figma_create_variable`, `figma_bind_variable_to_node`, … all work |
| Variable **modes** (Light/Dark, etc.) | ❌ paid only `[C-047]` | `figma_add_variable_mode` **fails** — the agent is told to delete the tool or upgrade |
| **Pages per file** | ❌ **3 maximum** `[C-048]` | `figma_create_page` **fails** past 3 — the error text comes straight from Figma |
| Dev Mode, team libraries | ❌ paid only `[C-049]` | Not needed — this project exists to replace Dev Mode, and library search was already out of scope |

This is not a footnote. A user on Starter gets **full read/write, unlimited calls, no cost** — but three pages per file and no variable modes. Those are Figma's product decisions, not bridge limits, and the bridge cannot route around them.

**What stays limited technically — and is stated openly:**

| Real limit | Nature | Mitigation |
|---|---|---|
| The plugin runs on Figma's **main thread** → UI freezes during heavy work | Figma's architecture | Time-based yield (§5.5 Limit 1) — **measured**: a real yield costs ~1 frame (~18–20 ms), so a responsive op runs **2.8×–3.7×** longer than one that freezes Figma `[C-050]` |
| Node throughput per second | Machine performance | Batching; progress reported; `BUSY` prevents queue pile-up |
| Document size / memory | Hardware | Pagination (`nextCursor`), `maxNodes`, file-based export |
| **The MCP client's tool-call timeout** | Client-side; defaults differ per client and can be raised — **to unbounded** in Hermes `[C-042]` | Per-client knobs in [docs/clients.md](../../clients.md) (Hermes: 300 s default, raisable to ~49.7 days via `mcp_servers.<name>.timeout`). Safety net if a client gives up anyway: `idempotencyKey` (§5.5 Limit 6) |
| The plugin's execution time limit | **None** `[C-011]` — a plugin that never calls `closePlugin()` runs on | The foundation of the strategy; nothing to mitigate |

**What may be promised:** *no cap on how many times it is called, no cost, no seat.*
**What may not be promised:** *instant operations on giant documents*; *that a single tool call may run for however long in any client* (see §5.5 Limit 6); or *paid-plan features on a Starter file* — three pages and variable modes stay out of reach `[C-047]` `[C-048]`. Nor is any of this a way around Figma's limits or fees (see Positioning in the header) `[C-036]`.

## 3. Non-Goals (YAGNI)

Deliberately **not** built in v1:

- **Publishing to the Figma Community.** The plugin is used as a *development plugin* (Import plugin from manifest).
- **Multiuser / realtime collaboration.** One user, one machine.
- **Features whose data lives in Figma's service rather than the document** — the plugin cannot reach them:
  - Code Connect (`*_code_connect_*`)
  - `generate_figma_design` (live URL capture by Figma's server), `create_new_file` (account-level)
  - Hosted services: `generate_image`, `weave_*`, shaders, generative plugins
  - Team-library search (`search_design_system`, `get_libraries`)
  - Comments (the plugin API does not expose comments; Figma's REST API does, outside Figxel)
- **The Dev Mode editor** (ADR #33). The manifest's `editorType` is `["figma", "figjam", "slides"]` since 2026-10-09 `[C-128]`; FigJam and Figma Slides are in scope (§4.7), and `["figjam", "dev"]` is not even a valid combination `[C-131]`.
- **Figma in the browser.** A development plugin is imported only in the desktop app `[C-274]`, so the target is **Figma desktop**, which exists for macOS and Windows and not for Linux `[C-273]`. The live runs so far were on Windows (auto-launch, §5.7, was Windows-specific and has been removed).
- **A fancy plugin GUI.** The plugin UI is only: connection status, token input, a short activity log.

Note: the official `use_figma` is **not** a hosted AI service — it runs Plugin API JavaScript in the file. Its counterpart here is the typed tools in the catalog plus `figma_eval` (opt-in). Detail in [tools.md § Not implemented](../../reference/tools.md#not-implemented).

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Any MCP client (Claude Desktop, Claude Code, Hermes, …)     │
│   MCP tools (stdio, JSON-RPC)                                │
└───────────────────────────┬──────────────────────────────────┘
                            │ stdio
┌───────────────────────────▼──────────────────────────────────┐
│  Bridge process  (Node, single process)                      │
│                                                              │
│  ┌────────────────────┐        ┌──────────────────────────┐  │
│  │ MCP server         │  op    │ WebSocket server         │  │
│  │ (McpServer+stdio)  ├───────►│ ws://127.0.0.1:38452     │  │
│  │  • tool registry   │        │  • token + origin check  │  │
│  │  • zod schemas     │◄───────┤  • sessions + queue      │  │
│  │  • result shaping  │ result │  • idle timer, heartbeat │  │
│  │  • file export     │        │  • idempotency (in-flight)│ │
│  └────────────────────┘        └────────────┬─────────────┘  │
└─────────────────────────────────────────────┼────────────────┘
                                              │ ws (loopback only)
┌─────────────────────────────────────────────▼────────────────┐
│  Figma desktop app                                           │
│  ┌──────────────────────────┐   postMessage   ┌───────────┐  │
│  │ Plugin UI (iframe)       │◄───────────────►│ Sandbox   │  │
│  │  ui.html                 │                 │ code.js   │  │
│  │  • WebSocket client      │                 │ • figma.* │  │
│  │  • reconnect/backoff     │                 │ • ops     │  │
│  │  • token input           │                 │ • DTO     │  │
│  │  • yield ack (§5.5)      │                 │ • idemp.  │  │
│  └──────────────────────────┘                 └───────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Why three layers

This is a Figma constraint that dictates the design, not a stylistic choice ([How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)):

- **The plugin sandbox (`code.js`) has no network access.** It has the whole plugin API (`figma.*`) but cannot open a WebSocket.
- **The UI iframe (`ui.html`) has network access** and browser APIs, but no access to the document.
- The bridge between them is `figma.ui.postMessage` ⇄ `parent.postMessage`.

So: the WebSocket lives in `ui.html`, document execution in `code.js`, and the bridge talks to `ui.html`.

### 4.2 One process, not two

The MCP server (stdio) and the WebSocket server run in **one Node process**:

- One lifecycle: the MCP client spawns the bridge when it needs it and closes it when done. No orphaned daemon.
- Installation = one entry in the client config.

Each MCP client spawns its own bridge process, and port 38452 can only be held by one of them. So the processes **share** it (ADR #30):

- The process that binds the port is the **hub**: it owns the plugin sessions, exactly as above.
- A process that finds the port held by a Figxel hub of the same installation becomes a **proxy**: it joins the hub over the same port (`peer-hello`, proven with the same token the plugin uses — `src/server/peer.ts`) and forwards its tool calls, progress, and cancellation. In-flight idempotency lives in the hub, so one `idempotencyKey` used from two clients still executes once.
- When the hub's client exits, the proxies race for the port; the winner becomes the hub and the plugin reconnects to it within its ≤ 3 s backoff (protocol §5).
- Additions to the peer protocol are named in `features` (in `peer-hello` and `peer-welcome`), never by a new version, which a hub refuses: a new proxy must still join an older hub. `result-chunks`: a result whose binary payload is larger than one frame goes to the proxy as a head plus `call-chunk` frames, as the plugin sends it (protocol §2); a proxy's socket takes at most `maxFrameBytes` (32 MiB) per frame, and one 40 MiB result closed it with 1009, which read as "the hub exited". An older proxy gets an honest `INTERNAL` error instead of a frame it cannot take, and a proxy that still meets an oversized frame (an older hub) says the result was too large rather than that the hub exited: ws reports that as its own error, `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, and the close as 1006, not 1009 `[C-334]`.
- A hub refuses a process with another token (another `BRIDGE_HOME`, another user) with close `4001`, after a `peer-refused` message naming its pid, its token file and its token's fingerprint. That process then says, in its errors and in `figma_status`, that the port is held by another server with another token file — not that the plugin's token is wrong.

No client owns Figma, there is still no daemon to orphan, and the plugin protocol is unchanged (plugins never send `peer-hello`).

### 4.3 Port, token, and file paths

| Item | Value | Reason |
|---|---|---|
| WebSocket port | `38452` | 3055 is used by `cursor-talk-to-figma-mcp`; 38451 by `figma-ui-mcp` |
| Interface | `127.0.0.1` only | Never binds to `0.0.0.0` |
| Home | `~/.figxel/` | On Windows: `%USERPROFILE%\.figxel\`. `BRIDGE_HOME` moves it. Until 2026-10-14 it was `~/.figma-mcp/` |
| Token | `~/.figxel/token` | 32 random bytes → 64 hex characters, created by `setup` or on first bridge start. POSIX: mode `0600`. Windows: inherits the `%USERPROFILE%` ACL (that user only) — no extra step in v1. When `BRIDGE_HOME` is unset and the file is missing, a valid `~/.figma-mcp/token` is copied once at start (never over an existing token), so a plugin that saved the old token keeps working |
| Plugin copy | `~/.figxel/plugin/` | `manifest.json`, `code.js`, `ui.html`: written by `setup` from the plugin bundled with the package; this manifest is what the user imports. In MCP mode the server re-copies any file whose bytes differ at start, but only into a folder `setup` created |
| Export dir | `~/.figxel/exports/` | Screenshots/assets are written to disk by the **bridge**, not base64 into the context |
| Log | **stderr only** | stdout is the MCP JSON-RPC channel; one `console.log` corrupts the framing. Tested in CI |

### 4.4 Configuration (env vars)

All read by `src/server/config.ts` at start. An invalid value → the bridge refuses to start with a clear message on stderr.

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_TOOLSET` | `full` | Tool groups to register ([tools.md](../../reference/tools.md#trimming-the-toolset)) |
| `BRIDGE_ALLOW_EVAL` | `0` | `1` = register `figma_eval` |
| `BRIDGE_ENABLE_AUDIO` | `0` | `1` = register the `audio` group, held back from the release on 2026-10-14 (§7); for development only |
| `BRIDGE_ALLOW_UNVERIFIED` | `0` | `1` = let this process's calls run writes whose editor cell is still **unmeasured** — for a measuring run only (§4.7). A **no** cell stays refused. Like `BRIDGE_ALLOW_EVAL` it belongs to the process the MCP client talks to: a proxy forwards its own flag with each call |
| `BRIDGE_PROCESS` | `strict` | How the tools hold an agent to the design process (ADR #41, #42): `strict` refuses new work until a brief for its role is in force, and a final export until a passing sign-off newer than the last change; for motion it refuses a keyframe write until this process has read the motion skill and the frame has a motion plan, and a final render until a `figma_check_motion` passed as the plan's own check with no change to the file since, with `PROCESS_REQUIRED`; `guided` runs those calls and adds `processWarnings`; `off` tracks nothing. Any other value stops the server. Like `BRIDGE_ALLOW_EVAL` it belongs to the process the MCP client talks to |
| `BRIDGE_CONFLICTS` | `refuse` | What a write does to a node someone else changed after the agent last read or wrote it (ADR #43): `refuse` answers `STALE`, `warn` runs and lists `conflicts`, `off` checks nothing; `force` per call overrides it. Any other value stops the server |
| `BRIDGE_AUTOLAUNCH` | `0` | Inert since 2026-10-07, when auto-launch was removed (§5.7, ADR #32); still parsed so an old configuration does not fail |
| `BRIDGE_SESSION_WAIT_MS` | `5000` | How long to wait for a reconnecting plugin before `NO_SESSION` |
| `BRIDGE_HOME` | `~/.figxel` | Token, plugin copy & export location. When it is set, the one-time token copy from `~/.figma-mcp` is skipped |
| `BRIDGE_EXPORT_DIR` | `$BRIDGE_HOME/exports` | Default root for a relative `saveTo` |
| `BRIDGE_EXPORT_ROOTS` | *(empty)* | Extra roots export may write to (e.g. a project's `public/` folder), separated by `path.delimiter` (`;` on Windows, `:` on macOS and Linux) |
| `BRIDGE_PORT` | `38452` | **Tests only** (`0` = random port). In real use the port is pinned in the plugin manifest |
| `BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` (to stderr) |
| `BRIDGE_FFMPEG` | `ffmpeg` | The ffmpeg program the video tools run: a name on PATH or a full path. A full path alone also finds ffprobe in the same folder |
| `BRIDGE_FFPROBE` | `ffprobe` | The ffprobe program, when it is not beside `BRIDGE_FFMPEG` or on PATH |
| `BRIDGE_VIDEO_MAX_WAIT_S` | `45` | The longest one `figma_export_video` call waits, whatever its `wait` asks (0–600): a margin under clients that cut a call at 60 s `[C-030]` |

CLI: the npm package `figxel-mcp` installs the bin `figxel-mcp` (`dist/server.js`); users run it as `npx -y figxel-mcp@latest …`. With no argument it is the MCP stdio server, and before serving it refreshes the plugin copy (§4.3). `setup` creates the token if absent, copies the plugin into `<home>/plugin`, and prints the token, the manifest to import and entries for MCP clients (`setup --json` prints the same as JSON; used during onboarding, §5.8). `setup --register` (opt-in, `figma-register.ts`) then writes the plugin's entries into Figma desktop's own list of development plugins, `localFileExtensions` in `%APPDATA%\Figma\settings.json` on Windows `[C-275]`, in the shape measured there `[C-319]`, so the manual import (§5.8 step 3) can be skipped; running the plugin stays manual `[C-016]`. It refuses on Linux `[C-273]`, while Figma desktop runs (Figma writes the file itself while it runs `[C-321]`; on Windows the check looks for `Figma.exe` itself, not the helper processes beside it `[C-322]`), and on a file whose structure is not the measured one; it backs the file up next to itself, writes it through a temporary file and a rename, keeps every byte outside Figxel's entries, and gives new entries an id above every id the list uses or refers to, because Figma's own ids follow no order and stale entries stay behind `[C-320]`. A file with no list yet gets one; what Figma does with that is not yet measured `[C-325]`. A registration of the same plugin id from another folder is kept and reported, or moved with `--force`; `setup --unregister` removes the entries for `<home>/plugin`; `--dry-run` with either prints the change and writes nothing, not even the token or the plugin copy. macOS uses `~/Library/Application Support/Figma/settings.json`, which is not yet measured `[C-324]`, so it is reported as experimental. `--print-token` prints the token, creating it if absent; `--version` and `--help` print to stdout and exit 0; an unknown argument exits 2 with the help. `setup` (except `--unregister` and `--dry-run`), `--print-token` and MCP mode all run the one-time token copy first.

### 4.5 Repo layout & build outputs

```
figxel-mcp/
├── src/
│   ├── shared/          protocol.ts · ops.ts · errors.ts · version.ts   (the contract, both sides)
│   │                    editors.ts (the editor table, §4.7) · figjam.ts · grid-layout.ts
│   ├── server/          mcp.ts (entry) · setup.ts (the CLI) · bridge.ts · peer.ts · sessions.ts · frames.ts · config.ts
│   │                    results.ts · exports.ts · mcp-progress.ts · figma-url.ts · schema-dialect.ts
│   │                    tools/  index · meta · read · create · modify · style · navigate · export
│   │                            forward · params · annotations · figjam · slides
│   └── plugin/          manifest.json · code.ts · ui.html · ui.ts · messages.ts · events.ts
│                        chunk.ts · idempotency.ts · read.ts (DTO) · write.ts · bind.ts
│                        safe.ts · sublayer.ts · board-read.ts · spec-types.ts
│                        figjam/  nodes · palette · spec-types        slides/  grid
│                        ops/  index · read · create · modify · style · component · variable · meta · export
│                              figjam · slides
├── test/                *.test.ts (fakes inline, shaped after @figma/plugin-typings)
├── tools/               build.mjs · mock-plugin.mjs
├── scripts/             check-docs.mjs · check-claims.mjs · check-language.mjs · lock-docs.mjs
├── spikes/              live probes against the real canvas + results/
├── docs/
└── dist/                (gitignored, output of `npm run build`; what the npm package ships)
    ├── server.js        single bundle — the `figxel-mcp` bin, runs without node_modules
    ├── build-id.json    the plugin and skills build ids (figma_status compares against it)
    ├── THIRD_PARTY_NOTICES.md   every package the server bundle inlines, with its licence text
    └── plugin/          manifest.json · code.js · ui.html   ← copied by `setup` into <home>/plugin, which is imported into Figma
                                                             (a clone may import dist/plugin directly)
```

Build rules (esbuild, one `npm run build`, target < 1 s; `prepack` runs it before `npm pack` and `npm publish`):

| Output | From | Notes |
|---|---|---|
| `dist/server.js` | `src/server/mcp.ts` | `platform: node`, `bundle: true` — dependencies bundled in, so the package has no runtime dependencies. Line 1 is `#!/usr/bin/env node` (it is the bin) |
| (all three bundles) | `package.json` | Its `version` is injected as `__PACKAGE_VERSION__`, so the version is written only in `package.json`; unbundled code reads `0.0.0-dev` |
| `dist/build-id.json` | the plugin sources and `src/skills` | `pluginBuildId` and `skillsBuildId`, which `figma_status` compares with the running plugin and server |
| `dist/THIRD_PARTY_NOTICES.md` | esbuild's metafile | A table of the bundled packages, then each licence text verbatim; the build fails if a bundled package has no licence file |
| `dist/plugin/code.js` | `src/plugin/code.ts` | `target: es2017` (conservative; raised if the spike proves the sandbox supports newer) |
| `dist/plugin/ui.html` | `src/plugin/ui.html` + `ui.ts` | **Script inlined** into the HTML — Figma loads `ui` as a single file; a `<script src>` to a local file is not loaded |
| `dist/plugin/manifest.json` | `src/plugin/manifest.json` | Copied as-is |

Typecheck: `tsc --noEmit` (TypeScript 7). Tests: `vitest run`. Docs: `node scripts/check-docs.mjs`.

### 4.6 Bridge process lifecycle

| Event | Behaviour |
|---|---|
| Start | One-time token copy from `~/.figma-mcp` (§4.3) → read/create token → refresh `<home>/plugin` if `setup` created it (a failure is logged, never fatal) → start MCP stdio → listen on `127.0.0.1:38452` |
| Port already taken (`EADDRINUSE`) by a Figxel hub of this installation — another MCP client's bridge | Become a **proxy** (§4.2): `figma_status` reports `role: "proxy"` and the hub's sessions; tool calls go through the hub. If the hub exits, race for the port and take over |
| Port taken by anything else — another program, an older Figxel version, another installation's token | **Do not exit.** The MCP server stays alive; `figma_status` reports `role: "none", reason: "PORT_IN_USE"`; other tools are answered `PORT_IN_USE`. Retry every 5 s — once the port frees up, this bridge takes over |
| stdin closed (MCP client finished) / SIGTERM / SIGINT | Close every plugin connection with `4010`, then exit within ≤ 1 s — the port must be released so the next bridge can listen |
| Tool call with no session yet | Wait `BRIDGE_SESSION_WAIT_MS` (the plugin reconnects every ≤ 3 s, protocol §5) → `NO_SESSION` (auto-launch, §5.7, was removed on 2026-10-07) |
| Uncaught error in one request's handler | Caught → `INTERNAL` for that request. **The bridge never crashes because of one request** |

### 4.7 Editor types

The plugin runs in three editors: Figma Design, FigJam and Figma Slides (manifest `editorType`, ADR #33) `[C-128]`. A tool does not behave the same in all three — the Plugin API creates stickies and connectors only in FigJam, slides only in Slides, and styles and components only in Design `[C-132]` `[C-133]` `[C-134]` — so which tool runs where is one table, decided per op before anything reaches Figma (ADR #34, #35) `[C-129]`:

```
hello.editorType ─► session ─► src/shared/editors.ts ─► bridge gate ─────► plugin gate ─► op
(figma.editorType)             one row per op:          authoritative      backstop for an
                               yes / no / unmeasured                       older hub: "no" only
                                        └─► figma_status: editor, unavailableTools, unverifiedTools
```

1. **The plugin reports its editor.** `hello.editorType` is `figma.editorType`, and the bridge keeps it on the session ([protocol §2](../../reference/protocol.md#hello-required-once)).
2. **One table.** `src/shared/editors.ts` holds one explicit row per op, with a cell per editor: **yes** runs; **no** is refused for every call, and is used only where the typings and Figma's own pages agree; **unmeasured** runs reads and refuses writes. A contradicted fact maps to unmeasured, never to no, so a contradiction is never a load-bearer. A test fails on an op without a row (deny by default), and pins [tools.md § Editor support](../../reference/tools.md#editor-support) to the table cell for cell.
3. **The bridge gate** (authoritative) runs in `dispatch()` right after the session is chosen and before the "plugin too old" check, so a board asked for a Design-only tool gets the real reason. A refusal is `UNSUPPORTED` naming the editor and the file, with `partial: { created: [] }` on a write and `safeToRetry: true`; its hint names a connected file where the tool runs. A `figma_batch` is checked step by step and refused whole before its first step runs. Proxies forward to the hub (§4.2), so every MCP client passes the same gate.
4. **Session choice.** A file name that several connected files share picks the one whose editor runs the op; with no `session` the most recently active file is used, as before — never a silent reroute to another file. A link names its editor (`/board/` FigJam, `/slides/` Figma Slides, the rest Figma Design).
5. **The plugin gate** is a backstop for an older hub build that has no gate: `execute()` and the batch op refuse the **no** cells of `figma.editorType` before the idempotency store begins, so nothing runs, no undo step is committed and no key is pinned (§5.2). Unmeasured cells are the bridge's call, because only the bridge knows the flag below.
6. **Measuring.** `BRIDGE_ALLOW_UNVERIFIED=1` (§4.4) lets unmeasured writes through, for the calls of the process that sets it. A proxy sends its own flag with each forwarded call (an optional `allowUnverified` in the peer call options — an older hub ignores it and stays strict), and the hub applies its own flag OR the forwarding proxy's, for that call only. A live spike joins the user's running hub as a proxy, so it can measure without the user's MCP client being restarted, while that client stays strict. A cell turns **yes** only from a result recorded under `spikes/results/` (ADR #35).
7. **Discovery.** `figma_status` lists each session's `editor`, `unavailableTools` and `unverifiedTools`, and the bridge's `allowUnverified`; the description of a tool that does not run everywhere ends with an `Editors:` sentence. The tool list itself is not per session: tools belong to the server, and files in several editors can be connected at once.

Outside Figma Design a member a node type lacks may throw rather than read as undefined `[C-145]`, so reads there go through a guard (`src/plugin/safe.ts`), and the opaque slide grid and rows are never read beyond their id, name, type and box `[C-136]`.

## 5. Components

### 5.1 `src/server/` — Bridge + MCP

| File | Responsibility |
|---|---|
| `mcp.ts` | Entry: parse CLI, build the `McpServer`, register tools per the toolset, `StdioServerTransport`, shutdown |
| `bridge.ts` | WebSocket server: origin + token handshake, request/response, idle timer, heartbeat, chunk reassembly, in-flight idempotency |
| `sessions.ts` | `Map<sessionId, Session>`, replacement per `instanceId`, active-session selection, per-session queue |
| `peer.ts` | Hub ⇄ proxy messages (`peer-hello`, `call`, `call-progress`, `call-result`, `call-cancel`, `status-request`) — how several MCP clients share one Figma connection (§4.2) |
| `tools/*.ts` | Per-group tool definitions (`meta`, `read`, `create`, `modify`, `style`, `navigate` for the plugin-backed meta tools, `export`): zod schema + description + op mapping; `forward.ts` is the shared forward-and-shape path, `params.ts` the portable parameter shapes |
| `frames.ts` | zod validation of every frame the plugin sends |
| `schema-dialect.ts` | Strips the draft-07 `$schema` the SDK adds to tool schemas `[C-055]` |
| `results.ts` | Builds MCP results: text/JSON, image content blocks, `structuredContent`, error formatting (`"<CODE>: <message>\n<hint>"`) |
| `exports.ts` | Path validation (`saveTo`, `dir`, `outputPath`) against allowed roots, file writing, PDF merging |
| `figma-url.ts` | Helpers ported from the old REST server: `1-2` ⇄ `1:2`, extracting `node-id` from a Figma URL, and the editor a link names (`/board/`, `/slides/`, §4.7) |
| `errors.ts` | Error taxonomy → structured codes + guiding hints |
| `config.ts` | Env vars, §4.4 |
| `mcp-progress.ts` | Plugin `progress` → `notifications/progress` (10/s coalescing, monotonically increasing); log fallback at most once per 5 s; `extra.signal` → `cancel` |

(`autolaunch.ts` / `autolaunch.ps1` were removed with auto-launch — ADR #32.)

**Principle:** `bridge.ts` does not know what a "frame" or a "text" is. It forwards `{op, params}` and returns results. Design knowledge lives in the plugin; MCP knowledge lives in `tools/` + `results.ts`. That is what makes the bridge testable without Figma.

### 5.2 `src/plugin/` — Figma plugin

| File | Responsibility |
|---|---|
| `manifest.json` | §9 |
| `code.ts` | Sandbox: wire `figma.ui.onmessage`, route ops, the editor backstop (below), `clientStorage` for the token, register events |
| `ui.html` + `ui.ts` | WebSocket client, backoff, token form, status, yield replies (§5.5) |
| `ops/*.ts` | The implementation of each op — **functions reading the `figma` global**, unit-tested against a fake API. The fakes are shaped after `@figma/plugin-typings`, not after the code: fakes that mirrored the code once let four tools pass that could never work `[C-056]`; every tool is also run on the real canvas by `spikes/live-all-tools.py` |
| `read.ts` | Node → compact DTO serializer, cursors, tree walking (used by reads). The single place normalization happens — the bridge does not normalize again |
| `ops/create.ts` | Includes the `create_from_spec` builder (an evolution of the old `figma-plugin/code.js`) |
| `write.ts` | Write helpers: colours, padding and other string-form parameters, alignment, font loading with family fallback |
| `bind.ts` | Variable binding and local-style application, shared by the style tools and `create_from_spec` |
| `events.ts` | `selectionchange`, `currentpagechange`, `currentPage.on("nodechange")` → events debounced 150 ms |
| `chunk.ts` | `forEachChunked()` / `mapChunked()` + `yieldToHost` (§5.5 Limit 1) + progress throttling |
| `idempotency.ts` | `idempotencyKey` → running/done map (protocol §3) |
| `safe.ts` | Guarded member reads (`has`, `tryGet`, `apiHas`): outside Figma Design a missing member may throw instead of reading as undefined `[C-145]` |
| `sublayer.ts` | The text of a sticky, a shape with text or a connector lives in a text sublayer, a code block's in `code`; one helper finds it and loads its fonts `[C-135]` |
| `board-read.ts` | FigJam and Slides node types for the reads: stickies, shapes, connectors, tables, code blocks, slides, and the opaque slide grid and rows |
| `spec-types.ts` + `figjam/spec-types.ts` | The `create_from_spec` extension contract: a node type registers its fields, editors and builder (stickies, shapes, tables, code blocks, connectors built last by `ref`) |
| `figjam/`, `slides/` | Board builders and palettes; the slide grid read and written through its tree |

**The editor backstop** (§4.7). `execute()` checks the op against `src/shared/editors.ts` for `figma.editorType` after the op lookup and **before** the idempotency store begins: a **no** cell is answered `UNSUPPORTED` with `partial: { created: [] }` on a write, without running the op or calling `commitUndo`, so its key is not pinned and a retry in the right file runs normally. The batch op checks every step before the first one runs. It applies only **no** cells — whether an unmeasured write may run is decided by the bridge.

**Separating `ops/` from `code.ts` is an important decision:** document logic is tested in Vitest against a fake `figma` object, without opening Figma. `code.ts` becomes thin wiring.

API notes that bind every op (because of `documentAccess: "dynamic-page"`): access nodes via `figma.getNodeByIdAsync`; change pages via `figma.setCurrentPageAsync` (assigning `figma.currentPage = …` is not supported); do not rely on `figma.on("documentchange")` (it requires `loadAllPagesAsync`).

### 5.3 `src/shared/` — the shared contract

`protocol.ts` (WS message types), `ops.ts` (op names + per-op zod param schemas + a `write` flag), `errors.ts` (error codes), `editors.ts` (the editor table and the refusal text both gates use, §4.7), `figjam.ts` (the board vocabulary reads and writes share: shape types, magnets, caps, code languages, and the one-string connector endpoint grammar whose formatter is its parser's exact inverse), `grid-layout.ts` (placing items by their real sizes). One source of truth → no drift between the two sides.

### 5.4 `tools/mock-plugin.mjs`

A Node script that **pretends to be the plugin**: connects to the bridge (Node's global WebSocket, no Origin), handshakes with the token, answers ops with fake data shaped exactly like the real DTO — including `progress`, `chunk`, and idempotency semantics (attach/replay).

- Tests the MCP server end-to-end without opening Figma (CI-friendly).
- Scenario modes: `--slow` (long progress), `--stall` (stops reporting), `--drop` (disconnects midway) to exercise timeouts & retries.

This is not a bonus — it is what makes TDD possible.

### 5.5 Defeating Limits — the "No Quota" Strategy in Practice

The most important part of the spec: this is where "free and no quota" turns from a slogan into design. There are seven limits; five are fully defeated, one partially (outside our control), one is physics.

#### Foundational Finding: the Figma Plugin Has No Time Limit

Figma's docs ([How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)): a plugin that is not properly closed *"runs indefinitely"* — the user sees a "Running [plugin name]" toast until they close it.

That means: **while the plugin is open, it is an execution engine with no duration ceiling.** The bridge does not need to close and reopen the plugin. The plugin opens once and lives for the work session. The cost: the "Running" toast stays visible — handled with an honest plugin UI (connection status + last activity).

#### Limit 1: Figma's main thread → UI freeze

The plugin runs on the main thread. A loop with no pause = Figma hangs, and the button that closes the plugin stops working.

**The obstacle — settled by measurement, not by the docs.** Figma's docs say *"browser APIs like `XMLHttpRequest`, `fetch`, `setTimeout`, and the DOM are not directly available from the sandbox."* Another official page explicitly recommends `setTimeout`. The two contradicted each other, so the mechanism was **tested** rather than picked from documentation `[C-012]`. **The measured answer: `setTimeout` is present and works.** That first page is wrong — and `fetch` is present too, which nobody expected.

**Correction to an earlier draft — confirmed, and worse than predicted.** The old draft relied on `await Promise.resolve()` and claimed it was enough. The spike killed it: option C blocked the entire run in **7 of 7** attempts, handled zero probe messages, and left Cancel unreachable. It was even marginally *slower* than doing nothing at all. The microtask queue is drained completely before the host gets a turn, so that path can never yield `[C-013]`.

**The workaround: `yieldToHost` — a timer by default, with iframe ping-pong as the automatic fallback.** Both were measured, so this is no longer a guess.

| Option | How | Status |
|---|---|---|
| **A. Timer** | `new Promise(r => setTimeout(r, 0))` | **The default.** `setTimeout` exists in the sandbox and genuinely hands Figma a turn `[C-012]`. Feature-detected once at plugin start (`typeof setTimeout === "function"`), so a future Figma that removes it falls back instead of breaking |
| **B. Iframe ping-pong** | Sandbox `postMessage({t:"yield"})` to the UI → the UI replies immediately → the sandbox resumes on `onmessage`. A message from the iframe is delivered by the host as a new task | **The automatic fallback, and it also works** — measured responsive, with slightly better throughput than A (2,229 ms vs 2,926 ms) and a tighter slice (12 ms vs 15 ms) |
| C. Microtask | `await Promise.resolve()` | **Tested and eliminated** — 7/7 runs blocked entirely, zero probes handled, worse than no yield at all `[C-013]`. Keep it out of the code; the entry stays for the record |

```ts
// src/plugin/chunk.ts
export type YieldToHost = () => Promise<void>;

export async function forEachChunked<T>(
  items: readonly T[],
  work: (item: T, i: number) => void | Promise<void>,
  opts: {
    yieldToHost: YieldToHost;                       // A or B, chosen once at plugin start
    budgetMs?: number;                              // default 12
    onProgress?: (done: number, total: number) => void;  // throttled to ≤ 4/second
    isCancelled?: () => boolean;
  },
): Promise<void> {
  const budget = opts.budgetMs ?? 12;
  let sliceStart = Date.now();
  for (let i = 0; i < items.length; i++) {
    await work(items[i], i);
    if (Date.now() - sliceStart >= budget) {
      opts.onProgress?.(i + 1, items.length);
      await opts.yieldToHost();                     // the host gets a turn: repaint, input, cancel message
      if (opts.isCancelled?.()) throw new CancelledError(i + 1);
      sliceStart = Date.now();
    }
  }
}
```

Because a cancel from the bridge arrives as a message (`onmessage`), **that message can only be processed when a real yield occurs** — measured: Cancel stopped the work in 8 ms under both A and B, and was unreachable under C `[C-013]`.

**The last-resort safety net** (if both A and B fail to keep the UI responsive): the bridge splits the work into several small requests (e.g. 200 nodes each), each a full event-loop turn. More round-trips, but **still no cap on volume** — only efficiency is lost.

**The accepted consequence, with the real number.** A real yield costs about one rendered frame, ~18–20 ms, so a heavy op that stays responsive runs **2.8×–3.7× longer** than one that freezes Figma `[C-050]`. That is the whole trade: input stays alive (probes answered within 69 ms, Cancel in 8 ms) and the work takes roughly three times as long. A frozen Figma is still worse — but the cost is a multiple, not a few percent, and any progress display or duration estimate must use the measured figure.

#### Limit 2: Throughput per op

**The workaround:** *do not send per node; send one batch and process it inside Figma.*

That is `figma_create_from_spec`: 40 separate calls (40 round-trips + 40 validations + 40 canvas refreshes) become **1 call**. Other multi-node tools (`set_fills`, `move_nodes`, …) accept `nodeIds[]` on the same principle.

The principle: **number of requests ≠ number of nodes.** Performance is determined by total work, not by the number of calls.

#### Limit 3: Response size / context window

A 50,000-node document → raw JSON can run to hundreds of MB. No context window survives that.

| Technique | How it works |
|---|---|
| **Compact over raw** | `figma_get_design_context` returns a normalized DTO, not Figma JSON |
| **Depth & limit** | Defaults `depth=2`, `maxNodes=2000`, `maxChildrenPerNode=50` |
| **Cursor** | `truncated: true` + `nextCursor`; the agent continues instead of guessing |
| **File-based** | Large screenshots/exports → disk, return the path |

Implementation note: `exportAsync({format: "JSON_REST_V1"})` returns the same node representation as the REST API `GET /files/:key/nodes` ([ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)) — a candidate raw source for `dto.ts` whose speed should be compared against manual traversal in Phase 1.

#### Limit 4: Round-trip & latency

A loopback WebSocket (~1–3 ms per round-trip) plus batching (Limit 2). The expensive part is not the network but building nodes inside Figma — and that is already optimized through batching.

#### Limit 5: Getting the progress signal to the MCP client

The plugin sends `progress`, the bridge receives it, the idle timer resets — good. But the agent only sees a tool call that "hangs" if progress stops at the bridge.

**The workaround:** the bridge forwards progress as MCP `notifications/progress` (with the request's `progressToken`), coalesced to at most 10/second, monotonically increasing, stopping after `result`. A client without a `progressToken` gets an `info` log at most once per 5 seconds. Detail: [protocol §9](../../reference/protocol.md#9-mapping-to-mcp-client-visible).

Progress makes work **visible**. Whether progress also **extends** the tool call depends on the client — see Limit 6.

#### Limit 6: The MCP client's timeout (configurable per client — to unbounded in Hermes)

This limit was missed in an earlier draft, and it breaks the claim that "a 4-hour op keeps running" **at the default setting**:

- **Hermes v0.21.5** `[C-031]`:** the tool-call timeout defaults to **300 s wall-clock**, and `call_tool` is invoked without a progress callback — progress does **not** extend it.
- TypeScript-SDK-based clients: 60 s default, extended by progress only when `resetTimeoutOnProgress` is used.

**But the timeout is not fixed — it is configurable up to a semantic "unbounded".** In `agent/deadline.py` `[C-042]`:

```
MAX_SAFE_TIMEOUT_S = _WINDOWS_MAX_WAIT_S if win32 else 31_536_000.0
# ~49.7 days on Windows (DWORD-ms cap) or 365 days elsewhere.
# Source comment: "One year is the semantic 'unbounded'."
```

So `mcp_servers.figxel.timeout` can be raised to **~49.7 days on Windows** — far beyond any real Figma operation. **With that set, Hermes genuinely imposes no practical limit.**

For a protocol-level solution there is also the **MCP Tasks extension** `[C-044]`: a server answers `tools/call` with `CreateTaskResult` (`resultType: "task"`) plus a `taskId`, and the client polls `tasks/get` for the result. The server is the sole decider. **Hermes does not implement it** `[C-043]` — an all-files search finds zero matches — so this path is a Phase 5 option, not a Phase 0 one.

**The workaround, in layers:**

1. **Raise the client timeout** for this server, in whichever client is used — [docs/clients.md](../../clients.md) lists each client's knob (in Hermes: `mcp_servers.figxel.timeout: 3600` or higher). This is the primary fix.
2. **MCP Tasks extension** (Phase 5, optional) — for clients that implement it, this removes the timeout question entirely: the client gets a handle immediately and polls. Gated behind capability negotiation; a server **must not** return a task to a client that did not declare support.
3. **`idempotencyKey`** (§5.6.2) — the safety net for when a client gives up anyway: the plugin still finishes the op (or stops cleanly on a cancel) and the result is stored. An agent retrying with the same key **gets that result — with no duplicate execution**.
4. **Agent guidance in the tool descriptions:** for very large work, split `create_from_spec` per section and supply your own `idempotencyKey`.

What is promised: *no hard limit on volume or duration, given a configured client* — with the client-side settings documented, and work never lost or duplicated if a client gives up regardless. What is not promised: *that a default-configured client of unknown type will wait forever* — that depends on the client, and the honest answer is written down for each.

#### Limit 7: Machine time & memory (physics)

Creating 1 million nodes takes time and RAM, however clever the design.

**The workaround:** *scale is measured in minutes, not in "rejected".*

| | Official path | This bridge |
|---|---|---|
| Large work | Rejected once quota runs out | **Accepted** — it runs, for however many minutes |
| Resumable? | Wait for the next quota period | Yes — partial results + `failedAt` + idempotency |
| Cost | Subscription + seat | Zero |
| Upper bound | Policy (changes without notice) | Hardware |

#### Summary: Workaround Map

| Limit | Nature | Workaround | Result |
|---|---|---|---|
| Plugin execution duration | **None** (finding) | Plugin stays open | An execution engine with no duration ceiling |
| Main-thread freeze | Figma's architecture | `yieldToHost` every 12 ms (timer or iframe ping-pong) + cancel-aware | UI stays responsive |
| Throughput per op | Figma's API | Batching: 1 call = N nodes | Requests do not grow with nodes |
| Context window | Model | DTO + depth/limit + cursor + file | Scales to enormous documents |
| Round-trip | Local network | WebSocket + batch | ~1–3 ms |
| Invisible progress | MCP protocol | Coalesced `notifications/progress` | The agent knows work is alive |
| Client timeout | Client-side, **raisable to unbounded** `[C-042]` | Raise the client timeout; `idempotencyKey` as the safety net; MCP Tasks extension as a Phase 5 option `[C-044]` | No work lost or duplicated |
| Time & memory | **Physics** | Accepted, not rejected; progress + cancel | No hard limit |

**Design principle:** *no hard limit on volume or cost — only on time, and time never discards work.*

### 5.6 Safety & Correctness — What Can Go Wrong Without Limits

Giving an agent unlimited capability also gives it unlimited potential for damage.

#### 5.6.1 Undo: A Danger That Must Not Be Disguised

The API fact ([`figma.commitUndo`](https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/)): *"By default, plugin actions are not committed to undo history."* Without `commitUndo()`, every plugin action merges into one — and for a plugin that stays open all day, that means an entire agent session's work could become a single undo step. So **every write op ends with `commitUndo()`**.

`figma.triggerUndo()` returns to the last `commitUndo()` checkpoint — **the user's manual changes after that checkpoint are reverted too**:

```
1. Agent creates a frame        → commitUndo()   ← checkpoint
2. User manually: moves the frame, changes colour  ← user's work, no plugin checkpoint
3. Agent calls figma_undo_step()                   → triggerUndo()
4. → Back to the checkpoint. The user's work in step 2 can be LOST.
```

(The exact behaviour of step 4 is verified empirically — §14.8. Measured so far: undo takes back the most recent tool call `[C-059]`; whether the user's manual edits go with it is still open, so the warning stays.)

| Rule | Reason |
|---|---|
| The `figma_undo_step` description carries an explicit warning | The agent knows the risk before calling |
| The `confirm: true` parameter is **required** | Prevents reflex calls |
| A successful response includes a `warning` | No surprises after the fact |
| Logged to stderr | Audit trail |
| The description points to `figma_delete_nodes` with the ids returned at create time | The safe way to undo agent work |

Rejected alternative: providing no undo at all — which would leave the agent unable to fix its own mistakes. The risk is *stated*, not hidden.

#### 5.6.2 Idempotency: The Double-Retry Hazard

```
1. Agent calls create_from_spec(800 nodes)
2. The plugin runs; the MCP client times out at 300 s (or the connection drops)
3. The agent retries the same request — reasonable behaviour
4. The plugin, which had already finished, creates the 800 nodes AGAIN → 1,600 nodes
```

**The workaround: an agent-controllable `idempotencyKey`.**

- Every document-write tool accepts `idempotencyKey?`. Empty → the bridge generates one (`k-<uuid>`) and **always** returns it in both results and errors.
- The plugin keeps a key → `running` / `done` map (LRU 1000, 15 minutes) in sandbox memory: a finished key returns the old result (`replayed: true`); a still-running key means the new request **attaches** and receives the same result when it completes. Never a double execution.
- The bridge does the same for requests still in flight within its own process.
- **Why the agent should supply its own key:** if it is the *client* that times out (not the bridge), the agent never receives the bridge-generated key. Only an agent-owned key can be used to retry. The `figma_create_from_spec` description recommends this.
- An acknowledged limit: the map lives in the sandbox — it survives WS disconnects and bridge restarts, and is lost when the plugin closes. If the plugin closes mid-op, the outcome is unknown; the agent inspects the canvas before retrying.

Wire detail: [protocol §3](../../reference/protocol.md#idempotency).

#### 5.6.3 Racing With the User

The agent and the user can touch the same node. Figma offers no locking for plugins, and we do not pretend otherwise.

| Situation | Behaviour |
|---|---|
| The user deleted a node before the agent touched it | `NODE_NOT_FOUND` for that item (per-item results) — it does not quietly create a new node |
| The user edits while a batch op runs (only possible at a yield point) | The op continues. The `result` includes `concurrentEdits: <n>` — the number of `nodechange` events on nodes **outside** the set the op touched. **This undercounts by construction** `[C-025]`: the plugin's writes, the user's edits and the user's Ctrl+Z all arrive as `origin: "LOCAL"`, so the id filter that removes the op's own changes also removes any user edit or undo *on those same nodes*. The number is a floor, not a count — treat it as "the user touched something else", never as "the user touched nothing" |
| The user presses Ctrl+Z while an op runs | **Cannot be detected reliably, and is measurably indistinguishable from an edit** — the plugin API has no undo event, and `nodechange` does not distinguish an undo from an ordinary edit `[C-025]`. The op continues. Because one op = one checkpoint, a Ctrl+Z after the op completes undoes the whole op — that is how the user rejects agent work |

What is **not** done: locking the document. Pretending to be safe is more dangerous than being honest about the risk.

#### 5.6.4 The User Closing the Plugin

The user can close the plugin at any time. The `close` event docs say: run as little code as possible and avoid async operations in its callback — so the plugin is **not** relied upon to "say goodbye".

1. The bridge detects it from the closed WebSocket (immediately, not by waiting for the 45 s heartbeat).
2. Pending requests → `NO_SESSION` with the message "plugin disconnected (likely closed)", the last known progress, and the `idempotencyKey`.
3. Changes already applied are **not** rolled back — that is the user's decision. Ctrl+Z is available.
4. The idempotency map is lost with the sandbox (§5.6.2) — the error hint asks the agent to inspect the canvas before retrying.

#### 5.6.5 Tool Discovery — 89 Tools and How to Manage Them

(The heading keeps the count it was first written with, so links to it hold; the live count is in the [catalog](../../reference/tools.md) and §7.)

Every MCP tool enters the model's context every turn: 140 tools by default since the trust pass of 2026-10-19. The estimate for 112 was ≈ 5,000–9,000 tokens, used or not (the exact figure is measured when the final descriptions are written, Phase 4). That cost is stated, but it is not used as a reason to restrict — and the list is the same in every editor (§4.7).

**Decision: every tool in the [catalog](../../reference/tools.md) is registered by default** (140 since 2026-10-19, counted in tools.md; `figma_eval` follows only when opted in, and so does the held-back `audio` group, §7).

The saving happens where it belongs — **on the client side**:

- The client's own tool picker, where it has one (e.g. `hermes mcp configure figxel`) — select tools per server without changing bridge code.
- **The bridge does not guess** a subset for everyone.

**`BRIDGE_TOOLSET`** remains as a second route: clients without a tool picker, Docker/headless, debugging. Tiers and rules are in [tools.md § Trimming the toolset](../../reference/tools.md#trimming-the-toolset). Two rules locked in here: `figma_status` is always registered; `figma_undo_step` sits in the `modify` group (not `meta`) so that `BRIDGE_TOOLSET=read` truly reads only.

**If tool-selection accuracy drops**, that is a **description** problem, not a count problem: write descriptions with sharp discriminators. Do not hide tools.

### 5.7 Removing Friction: Auto-Connect

The most reasonable criticism of the plugin architecture: *"it's a hassle, you have to open the plugin every time."* This section answers it honestly.

#### 5.7.1 The Fact That Changes the Problem

**The plugin only needs to be opened once per Figma session — not per tool call, and not per agent session.**

A plugin that never calls `closePlugin()` stays open `[C-011]`, and its UI keeps reconnecting to the bridge (backoff ≤ 3 s, protocol §5). The bridge lives and dies with the MCP client; the plugin waits patiently:

```
Morning: open Figma → open the plugin once (≈10 s; the token is already stored)
All day: each new agent session → the bridge starts → the plugin connects by itself within ≤ 3 s — ZERO clicks
Close Figma → the plugin closes with it → repeat once tomorrow
```

#### 5.7.2 What CANNOT Be Automated (platform limits)

| Route | Status |
|---|---|
| CLI / deep link to run a plugin | ❌ Does not exist `[C-016]`. `figma://` opens a *file*, not a plugin |
| Plugin auto-run when a file opens | ⚠️ Organisation-level only (admin settings) — not for personal accounts |
| Plugin running in the background without being opened | ❌ Not permitted by Figma |
| A third party launching the plugin | ❌ Plugin actions must be triggered by the user `[C-015]` |

This is Figma's security model, not a limitation of our design.

#### 5.7.3 What CAN Be Automated: Quick Actions

Figma desktop has **quick actions** for searching and running a plugin by name. **`Ctrl+/` did not open it on Figma 126.9.11** — measured, three keystrokes delivered and nothing appeared; Figma's own accessibility text advertises **`Ctrl+K`**, which was not pursued once auto-launch was removed. That can be sent programmatically with PowerShell `SendKeys` — installing nothing.

```
# src/server/autolaunch.ps1 — run by the bridge when it needs a session
1. Find the main Figma.exe window
2. Restore if minimised; SetForegroundWindow(hwnd)
3. VERIFY foreground == Figma. If not → abort, send NOTHING
4. SendWait("^/")                         → open quick actions
5. Sleep 250 ms; verify foreground again
6. SendWait("figma-mcp bridge{ENTER}")    → the EXACT plugin name (see the naming note)
7. The bridge waits up to 10 s for a session
```

**The plugin name must be unique.** The development machine already had a dev plugin **Figma MCP Rust** (id `figma-mcp-rust`, current-state §3). Quick-action search is fuzzy — typing `figma-mcp` could select that one. So the plugin name in the manifest was **`figma-mcp bridge`** (ADR #23; it has been `Figxel` since 2026-10-14, ADR #40), and the spike measures that the top quick-action hit really is our plugin.

**Mandatory safeguards (this is screen automation, not an API):**

| Safeguard | Rule |
|---|---|
| **Opt-in** | Off by default. Enabled only with `BRIDGE_AUTOLAUNCH=1` |
| **Foreground check** before **every** keystroke | Not Figma → abort. The most important safeguard |
| **Rate limit** | At most 1 attempt per 30 s; at most 3 per hour |
| **Short timeout** | At most 10 s waiting for a session; failure → manual instructions |
| **Always a fallback** | Any failure → `NO_SESSION` with clear instructions |
| **Never mid-op** | Triggered only when there is **no session** |

**Risks stated openly:**

- **Auto-launch steals focus.** The user is usually in the terminal or the AI app while the agent works. The bridge brings Figma forward — the user's next keystrokes go to Figma, not the terminal. This is an inherent cost, not a bug.
- **Windows may refuse `SetForegroundWindow`** from a background process (foreground lock) — the window only blinks in the taskbar. In that case the foreground check fails and auto-launch aborts (safe, but useless). How often this happens is one of the spike's metrics.
- **Focus race** of ~250 ms between the check and the keystroke: the keystroke could land in another window. Small, but not zero.
- **Non-US keyboard layouts:** `^/` may map to a different combination.
- **The shortcut changes in a future Figma version** → failure must be *loud*, and manual instructions are always included.
- **The plugin is not imported / was removed** → quick actions open but the plugin is not there. After 2 consecutive failures, `figma_status` reports `autolaunch.lastError` with re-import instructions.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| AutoHotkey | An extra dependency; PowerShell ships with every Windows |
| "Run last plugin" (`Ctrl+Alt+P`) | Runs the *last* plugin — wrong if the user ran another plugin in between |
| Keystrokes from the plugin sandbox | The sandbox has no OS access |
| Auto-launch always on | Sending keystrokes to a user's screen without permission is not acceptable |

#### 5.7.4 Graceful Degradation

| Layer | Condition | What happens |
|---|---|---|
| **1. Sticky connection** | The plugin is open & connected | Full capability, zero clicks |
| **2. Waiting for reconnect** | The bridge just started, the plugin is backing off | The bridge waits ≤ `BRIDGE_SESSION_WAIT_MS` (5 s) — the plugin connects by itself |
| ~~**3. Auto-launch** (opt-in)~~ **REMOVED 2026-10-07** | ~~No plugin, `BRIDGE_AUTOLAUNCH=1`~~ | **There is no layer 3.** See the removal note below the table |
| **4. Manual instructions** | Anything else | `NO_SESSION`: *"Open the plugin in Figma: Plugins → Development → Figxel. Once it is open it reconnects by itself, so this is needed only after Figma restarts or the plugin window is closed. Not in that menu yet: run `npx -y figxel-mcp@latest setup` and import the plugin from the manifest it prints."* If a connection attempt was refused for a token reason, and no session has connected since, the hint changes: *"A plugin tried to connect to this server and was refused: its token does not match this server's token file. Run `npx -y figxel-mcp@latest setup`, which prints the token and its fingerprint, and paste the token into the Figxel plugin."* It adds this server's token file and the token's fingerprint (its first and last four characters), which the plugin window shows for its own token, so the two can be compared. A refusal older than a session's connect is history and changes nothing. |
| **5. Read via REST** (at the agent level) | Read-only work, the plugin cannot be opened | The agent uses a REST-based server, if the user has one. Not bridge behaviour — and it is subject to Figma's REST rate limits (§1) |

**Why layer 3 is gone (removed 2026-10-07).** Three real attempts were run. The input technique was fixed and verified — `strayRisk: false` with SendInput, where SendKeys had typed the plugin name into another application `[C-052]`. The plugin nevertheless **never opened once**, and the guard meant to make the feature safe turned out to be unsound: an idle threshold cannot distinguish "the operator is away" from "the operator is thinking", and one attempt fired on 85 seconds of thinking.

But the failures are not why it was removed. It was removed on the operator's reasoning, which no amount of tuning would have fixed: **the point of the path was to send input to the plugin, and every variant of it had to raise Figma to the foreground first — taking the screen away from whatever the operator was doing.** A feature whose premise is interrupting the person using the computer is not one to make more reliable. The plugin is run from inside Figma, by a person, and that is the only method the design supports.

#### 5.7.5 ~~What Must Be Measured~~ — Superseded: auto-launch removed 2026-10-07

| Metric | Target | If it fails |
|---|---|---|
| ~~Auto-launch success while Figma is **not** in the foreground (the real case)~~ | ~~≥ 95% over 20 attempts~~ | **Measured: never succeeded in 3 attempts.** No further attempts will be made — the feature is removed |
| ~~Time from trigger to a ready session~~ | ~~≤ 5 s~~ | Moot — no session was ever created |
| Stray keystrokes landing in another application | ~~**0** over 50 attempts~~ | Technique **fixed** before removal: SendKeys leaked (typed into another app), SendInput did not — `strayRisk: false` on every run after the rewrite `[C-052]` |
| ~~Top quick-action hit is our plugin~~ | ~~20/20~~ | Moot. Both chords were tried: `Ctrl+/` opened nothing in Figma 126.9.11, and Figma's own accessibility text advertises **`Ctrl+K`**, which was not pursued once removal was decided |

Without these numbers, "auto-connect" is just a claim.

### 5.8 First Run (onboarding)

The flow a new user follows since the npm package (2026-10-14); the README quickstart is its step-by-step form. It needs Figma desktop, which exists for macOS and Windows only `[C-273]`, and Node.js 22 or later `[C-292]`.

1. Quit Figma desktop (closing its window does not quit it on Windows `[C-341]`), then `npx -y figxel-mcp@latest setup --register` (`-y` skips npx's install prompt `[C-282]`) → creates the token, copies the plugin into `<home>/plugin` (`~/.figxel/plugin`), lists the plugin in Figma desktop's settings, after a backup, so nothing has to be imported (§4.4) `[C-319]` `[C-323]`, and prints the token, the Figma steps and entries for MCP clients. Without `--register` setup leaves Figma's settings alone and prints the manifest path for step 3.
2. Register with any MCP client — a stdio server, command `npx` with the arguments `-y figxel-mcp@latest`; on Windows, for a client that starts servers without a shell, `cmd /c npx -y figxel-mcp@latest` `[C-281]`. Exact steps per client (Claude Desktop, Claude Code, Cursor, VS Code, Codex, Gemini CLI, Devin Desktop, Hermes) are in [docs/clients.md](../../clients.md). Raise that client's tool-call timeout where its default is short (§5.5 Limit 6).
3. Only without `--register`, or when Figxel is not under Plugins → Development (macOS is experimental `[C-324]`): Figma desktop → open or create a file → **Plugins → Development → Import plugin from manifest…** (the Help Center calls it "Import new plugin from manifest...") `[C-274]` → select the manifest setup printed. Either way once only: Figma reads the plugin's files from that path each time the plugin runs, so an update needs a re-run, not a re-import `[C-275]`.
4. Run **Plugins → Development → Figxel** → paste the token → **Save** → it is stored in `figma.clientStorage`, which is keyed by the plugin id; the id stays `figma-mcp-bridge`, so a saved token survives updates `[C-276]`. Whether re-importing the same id from another folder keeps it is not measured `[C-276]`. Status: "waiting for bridge" or "connected".
5. Restart the MCP client; the agent calls `figma_status` → it sees the active file & page.

After that, daily use: open Figma → run the plugin once → done. After an update: restart the MCP client, whose `figxel-mcp@latest` entry starts the newest version `[C-283]` and refreshes `<home>/plugin` (§4.3) → close the Figxel plugin window and run it again `[C-275]`.

A clone runs the same flow with `npm install` → `npm run build`, command `node <clone>/dist/server.js`, and `dist/plugin/manifest.json` imported directly; `node dist/server.js --print-token` prints the token.

## 6. Bridge Protocol (summary)

The full specification is in [`protocol.md`](../../reference/protocol.md). The shape is one JSON object per text frame:

```jsonc
// plugin → bridge (handshake)
{ "t": "hello", "protocolVersion": 1, "token": "…", "instanceId": "…", "pluginVersion": "0.1.0",
  "ops": ["create_frame", "…"], "file": { "name": "Landing Page", "key": null },
  "page": { "id": "0:1", "name": "Home" }, "user": { "id": "…", "name": "…" } }

// bridge → plugin
{ "t": "welcome", "sessionId": "s-1", "protocolVersion": 1, "limits": { … } }
{ "t": "request", "id": "r-17", "op": "create_frame", "params": { … },
  "idleTimeoutMs": 30000, "idempotencyKey": "k-…" }

// plugin → bridge
{ "t": "progress", "id": "r-17", "done": 1500, "total": 8000 }
{ "t": "result", "id": "r-17", "ok": true, "data": { … } }
{ "t": "result", "id": "r-17", "ok": false, "error": { "code": "NODE_NOT_FOUND", "message": "…", "hint": "…" } }
{ "t": "event", "name": "selection_changed", "data": { … } }
```

Protocol decisions:

1. **The token is in the handshake, not in every request.** A bad token → close `4001`. Plus an Origin filter (`null`/absent) as defence in depth.
2. **`id` is required on every request** — reliable result matching.
3. **Sequential per session.** The plugin API is single-threaded; serialization removes races and makes undo grouping sensible. Queue of 32 → `BUSY` (back-pressure, not a quota); a call that would wait behind a video render answers `BUSY` at once, since Figma cannot stop a render and a call waiting minutes in silence runs into the client's timeout `[C-197]` `[C-271]`.
4. **IDLE-based timeout, not duration.** One timer per request (30 s; export ops 120 s), reset on every `progress`. Expiry → `STALLED`. No duration ceiling in the bridge.
5. **`progress` is a contract.** Ops > ~5 s must report at least once per second (and no more often than every 250 ms).
6. **Heartbeat 15 s, drop after 45 s of silence.**
7. **Reconnect: backoff 0.5 s → cap 3 s** on the UI side; the bridge keeps no state across connections, except session replacement per `instanceId`.
8. **Multi-session from the start, simple by default.** Two open Figma files = two sessions; tools accept `session?`, defaulting to the most recently active.
9. **Idempotency for every write op**, with the key optionally from the agent (§5.6.2).
10. **Binary payloads are chunked** (> 8 MB) — nothing is rejected for size.
11. **`figma_eval`** is an ordinary op, but its tool is registered only when `BRIDGE_ALLOW_EVAL=1`.

## 7. Tool Surface

The full list + parameters + comparison with the official server: [`tools.md`](../../reference/tools.md). In summary:

| Group | Count | Examples |
|---|---|---|
| **meta** | 5 | `figma_status`, `figma_get_guide`, `figma_select`, `figma_navigate_page`, `figma_zoom_to` |
| **read** | 24 | `figma_get_design_context`, `figma_check_layout`, `figma_check_motion`, `figma_get_variable_defs`, `figma_get_component`, `figma_get_library_variables`, `figma_get_motion_context`, `figma_search_nodes`, `figma_get_slide_grid`, … |
| **create** | 34 | `figma_create_from_spec`, `figma_create_storyboard`, `figma_create_animatic`, `figma_create_frame`, `figma_create_text`, `figma_create_vector`, `figma_combine_as_variants`, `figma_create_variables`, `figma_import_library_assets`, `figma_create_slot`, `figma_create_stickies`, `figma_create_connectors`, `figma_create_slides`, … |
| **modify** | 47 | `figma_set_text`, `figma_move_nodes`, `figma_set_auto_layout`, `figma_batch`, `figma_set_variable_properties`, `figma_edit_component_property`, `figma_undo_step`, `figma_edit_table`, `figma_fit_sections`, `figma_move_slides`, … |
| **style** | 24 | `figma_set_fills`, `figma_set_strokes`, `figma_apply_style_to_node`, `figma_bind_variable_to_node`, `figma_set_variable_mode`, `figma_update_style`, `figma_set_keyframes`, `figma_set_motion_plan`, `figma_set_slide_transition`, … |
| **export** | 6 | `figma_export_node`, `figma_save_screenshots`, `figma_export_frames_to_pdf`, `figma_download_assets`, `figma_export_video`, `figma_review_video` |
| **audio** | 3 | `figma_analyze_audio`, `figma_add_audio`, `figma_generate_audio` (held back, opt-in) |
| **eval** | 1 | `figma_eval` (opt-in) |

**144 in the catalog; 140 registered by default.** The parity pass of 2026-10-08 added 23 tools so that what the official server reaches through `use_figma` JavaScript or its own read tools `[C-087]` has a typed counterpart here — design tokens with scopes and modes, library import by key, component property editing and slots, motion keyframes and video, prototype scrolling and flows, asset download, and one-undo batches. The FigJam and Slides pass of 2026-10-09 added 16 more: 10 for FigJam boards (stickies, shapes with text, connectors, tables, code blocks, link previews, and editing tables, connectors, board properties and section sizes) and 6 for Figma Slides decks (the slide grid read and written, new slides, moving slides, slide properties and transitions), and extended about 25 existing tools to work on a board or a slide. The motion process of 2026-10-14 added `figma_set_motion_plan`, the plan the keyframe tools wait for (ADR #41). The role process of 2026-10-16 added `figma_set_brief`, `figma_get_brief` and `figma_sign_off`, the brief new work waits for and the sign-off that ends it (ADR #42). The trust pass of 2026-10-19 added `figma_get_changes`, `figma_savepoint`, `figma_rollback` and `figma_stress_test` (ADR #43). The sound pass of the same day added 3 export tools, because Figma's video export has no audio `[C-184]`: `figma_analyze_audio` (the tempo, beats and loudness of the user's music), `figma_generate_audio` (a bed and effects synthesized offline, optionally derived from an animated frame's keys) and `figma_add_audio` (tracks muxed onto a render with the video stream copied). They work on files inside the export roots and have no plugin op; `figma_generate_audio { nodeId }` reads the frame through `figma_check_motion`'s op. On the same day they were held back from the release, with their code and tests kept: the owner judged the generated sound not good enough yet, and the path for the user's own licensed files is not built. They moved to their own `audio` group, registered only with `BRIDGE_ENABLE_AUDIO=1` and a toolset that includes it, as `figma_eval` needs its own key; no skill, prompt or server instruction names them ([the held-back record](../plans/2026-10-14-audio-held.md)).

**Which tool runs in which editor** is one table — [tools.md § Editor support](../../reference/tools.md#editor-support), pinned by a test to `src/shared/editors.ts` (§4.7). Every Design cell of the 113 earlier tools is **yes**; the board and deck tools are **no** in Design, except `figma_fit_sections`, which sizes Design sections too and is **unmeasured** there until its spike; most FigJam and Slides cells start **unmeasured**, so their writes are refused until a live run records them (ADR #35). FigJam and Slides content is built with the same `figma_create_from_spec` — board node types joined by `ref`, one spec per slide (ADR #37) — and read with the same `figma_get_design_context` `[C-153]`.

**`figma_create_from_spec` is the flagship.** One round-trip builds a whole section (a tree of frames/text/buttons/shapes/vector paths/SVG icons/images/auto-layout/instances, with style & variable binding), not 40 separate calls; an agent builds a design as a wrapper frame plus one call per section `[C-085]`. A direct evolution of the existing `figma-plugin/code.js` — now invoked by an agent instead of pasted by hand.

**Why batching is the core of the "no quota" promise:** the number of requests does not grow with the number of nodes. 800 nodes = **one** spec. There is no point at which work becomes "too large to call" — only duration grows.

Naming rule: every tool is prefixed `figma_` on the MCP side (some clients namespace tools per server, but the prefix keeps the list readable in those that do not).

**Flood-control parameters (optional):** `depth`, `maxNodes`, `maxChildrenPerNode`, `limit`, `cursor`. The defaults are safe; the agent can narrow them, or widen them up to the machine's memory limit.

## 8. Data Flow

**Read:**
`tools/call` → zod → `bridge.request(op, params)` → a `request` frame → `code.ts` routing → `ops/read.ts` (`figma.*`) → `dto.ts` (depth/limit) → `result` → `results.ts` → MCP `content: [{type:"text", text: JSON}]` + `structuredContent`.

**Large read (split, not rejected):**
`figma_get_design_context` on an enormous subtree → the op stops at `maxNodes` → `truncated: true` + `nextCursor` → the agent calls again with `cursor` until exhausted.

**Screenshot / export:**
`figma_export_node(nodeId, format, scale, saveTo?)` → the bridge separates out `saveTo` → the plugin runs `node.exportAsync({format, constraint:{type:"SCALE", value: scale}})` → bytes → base64 (chunked when large) → the bridge:
- with no `saveTo` and a PNG/JPG ≤ 5 MB → an **image content block** (`{type:"image", mimeType, data}`) so a vision model actually sees it;
- with `saveTo`, or > 5 MB, or PDF → `exports.ts` validates the path, writes the file, and returns `{path, bytes, format, scale}`.

**Write:**
`figma_create_frame(...)` / `figma_create_from_spec(spec)` → the bridge's editor gate (§4.7) → the plugin builds nodes → `commitUndo()` → a compact DTO (id, name, w/h, x/y) + `idempotencyKey` → the agent uses the ids for the next step.

**Large write (still one request):**
`create_from_spec` with 800 nodes → `forEachChunked` + `yieldToHost` → `progress` at least once per second → the bridge's idle timer resets → `notifications/progress` to the client → a result carrying the ids of every node.

**Events:**
`selectionchange` / `currentpagechange` / `currentPage.on("nodechange")` → 150 ms debounce → an `event` frame → session state → read via `figma_status` / `figma_get_selection`. (The MCP resource `figxel://session/<id>/selection` arrived in Phase 4, as `figma://` until 2026-10-14.)

**Context bound:** defaults `depth=2`, `maxNodes=2000`, `maxChildrenPerNode=50`. These bounds protect the *context window*, they do not reject work — the agent can always continue via `nextCursor`.

## 9. Security

| Risk | Mitigation |
|---|---|
| Another local process connects to the port and modifies the document | Loopback bind + a **256-bit token** (32 random bytes) |
| A web page in a browser connects to `ws://127.0.0.1:38452` | Any Origin other than `null`/absent is rejected (`4003`); a web page also cannot guess the token |
| Another `null`-origin iframe (e.g. another plugin) | Origin cannot distinguish it — the **token** is the gate |
| `figma_eval` abusing the sandbox | **Off by default**, two keys (env + toolset), every call logged (length + hash) |
| A tool verified in Figma Design writing to a board or a deck where it was never run | The editor gate (§4.7): an **unmeasured** write is refused before Figma is asked; `BRIDGE_ALLOW_UNVERIFIED=1` lifts that only for the calls of the process that sets it, and never for a **no** cell |
| Path traversal through export | `exports.ts`: relative paths resolve from `BRIDGE_EXPORT_DIR`; absolute paths must be inside `BRIDGE_EXPORT_DIR` or `BRIDGE_EXPORT_ROOTS` (after `realpath`); anything else is `INVALID_PARAM` |
| Token leaking into logs/chat | The token is never sent to the MCP client; only `tokenPresent`, `tokenPath` and a fingerprint of 8 of its 64 hex characters (the first and last four), which the plugin window and `setup` show too. The token is never written to logs |
| Client document content leaking into logs | Write-op `params` are not logged by default — only op, id, duration, size |
| stdout corruption (breaking JSON-RPC) | All diagnostics to stderr; tested in CI |

The plugin manifest (`src/plugin/manifest.json`):

```json
{
  "name": "Figxel",
  "id": "figma-mcp-bridge",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma", "figjam", "slides"],
  "documentAccess": "dynamic-page",
  "permissions": ["currentuser", "teamlibrary"],
  "networkAccess": {
    "allowedDomains": ["*"],
    "reasoning": "Connects to the local Figxel server at ws://127.0.0.1:38452 (loopback only). Figma rejects IP-literal entries in allowedDomains, so \"*\" is required; the bridge accepts only connections presenting its 32-byte token."
  }
}
```

- `networkAccess` **is enforced** by Figma: *"Your plugin can only access the domains that you specify"* ([manifest](https://developers.figma.com/docs/plugins/manifest/)); a local server in `allowedDomains` makes `reasoning` mandatory. (An earlier draft claimed this rule applied only to published plugins — there is no basis for that in the documentation; corrected.) The narrow entry this spec first planned, `ws://127.0.0.1:38452`, is **rejected at import**, and `localhost` resolved to `::1` before `127.0.0.1` here `[C-060]` — so the manifest uses `["*"]` + `reasoning`, the fallback §14.2 prescribed. The gate is the token, as it always was for any `null`-origin caller.
- `name` is the menu entry, **Plugins → Development → Figxel** (`figma-mcp bridge` until 2026-10-14, ADR #40). `id` keeps its old value on purpose: `figma.clientStorage`, where the plugin saves the token, is keyed by plugin id, so a new id would make every user paste the token again `[C-276]`.
- `documentAccess: "dynamic-page"` is mandatory for new plugins → all node access goes through async APIs (§5.2).
- `permissions`: `currentuser` is required for `figma.currentUser` (the user name in `figma_status`); `teamlibrary` for `figma.teamLibrary`, the enabled libraries' variables that `figma_get_library_variables` lists `[C-107]`.
- `editorType` lists the three editors the plugin runs in (ADR #33) `[C-128]`. `dev` is left out, and `["figjam", "dev"]` is not a valid combination anyway `[C-131]`. What runs in each editor is gated per tool (§4.7), not by the manifest.

## 10. Error Handling

Canonical error codes (`src/shared/errors.ts`, used by both sides):

| Code | When | Message/hint to the agent |
|---|---|---|
| `NO_SESSION` | No plugin connected (after the §4.6 wait), or the plugin disconnected mid-request | Instructions for opening the plugin (§5.7.4 layer 4) + `idempotencyKey` for write ops |
| `PORT_IN_USE` | This bridge failed to listen on 38452 (another process holds it) | "Port 38452 is held by a process that is not a compatible Figxel server." Hint: "Close whatever holds the port (another program, or an older Figxel version); this bridge takes over automatically within ≤ 5 s." A compatible Figxel hub is shared as a proxy instead (§4.2). A Figxel hub with another token file that refused this process: its pid, both token files and fingerprints, and how to use one server (close the other app, or run setup in the same environment and restart both apps) |
| `NODE_NOT_FOUND` | The id does not exist / was deleted | Include the requested id + a suggestion to use `figma_search_nodes` |
| `INVALID_PARAM` | zod failed, style/variable name missing, path outside the roots, key reused for another op | The offending field path + available values where relevant |
| `FONT_LOAD_FAILED` | Font unavailable, including every fallback | The list of available fonts |
| `STALLED` | No `progress` within the request's idle timeout | "The operation stopped reporting. Check whether Figma is frozen, or behind another window, where the plugin runs slowly `[C-124]`". A write (it has a key) adds "retry with the same `idempotencyKey` (<key>)". A read, export or view change (no key) adds "call the tool again — it changes no design data" |
| `TIMEOUT` | `figma_eval`'s own time limit; Figma gave up loading a page or node for the plugin (its text quoted) `[C-262]`; or Figma ended a video render it had not finished, about 240 s after it began `[C-198]` | The page or node named, `figma_navigate_page { pageId }` or retry in a moment; for a render, keep the Figma window restored and render again (a large render may need fewer frames). On the second render timeout in a row in a plugin window, or a timeout of a small render (under 200 million pixels rendered `[C-337]`), Figma's exporter is likely stuck: save, quit and reopen Figma, then run the plugin again; fewer frames do not help `[C-318]`. Never `UNSUPPORTED`, which tells an agent to stop |
| `CANCELLED` | Cancelled by the MCP client, or bridge shutdown | `partial` (what finished) + `idempotencyKey` |
| `BUSY` | Session queue > 32 — temporary back-pressure; or a video render holds the plugin (sent and not yet answered, or queued), so the call is not sent | "Queue full. Wait for previous requests to finish"; for a render: its `jobId` and elapsed seconds, why it holds the plugin (running, cancelled, or no result yet from an earlier process — never "cancelled" unless it was), that nothing changed and a retry is safe once it ends, after 2 min that a minimized Figma window stops video export, and after 5 min that closing and re-running the plugin ends the wait |
| `UNSUPPORTED` | The op is absent from the plugin's `ops` (plugin older than bridge), or it does not run — or is not yet verified — in the session's editor (§4.7). The editor is checked first | "The connected plugin is older than this server: ask the user to close the Figxel plugin window and run it again (Plugins → Development → Figxel). If the op is still missing, run `npx -y figxel-mcp@latest setup` and import the plugin from the manifest it prints."; for the editor: the editor and the file, why, and a connected file where the tool runs (pass `session` with its name) or the kind of file to open. An editor refusal reaches nothing, so a write carries `partial: { created: [] }` and every editor refusal is `safeToRetry: true` |
| `PROCESS_REQUIRED` | `BRIDGE_PROCESS=strict` (ADR #41, #42): new work with no brief in force for the file, `figma_set_brief` before the role's skill was read, a final export (`final: true`) of a deliverable whose sign-off is missing, failing or older than its last change; a keyframe write before this process read the motion skill or before the frame has a motion plan; a final render (`figma_export_video` `final: true`) before a whole `figma_check_motion` on the frame passed at that fps as the plan's own check (nothing looser than the plan), against the plan the frame still carries, with no change to the file since (no write through this process, no change the plugin reported). Answered by the server before anything is sent | What is missing, and the exact calls that satisfy it (`figma_get_guide { topic: "motion" }`, `figma_set_motion_plan { … }`, `figma_check_motion { … }`); `partial: { created: [], missing }`, `safeToRetry: true`. A preview render is never refused |
| `STALE` | `BRIDGE_CONFLICTS=refuse` (ADR #43): a write to a node a person or collaborator changed after the agent last read or wrote it, without `force`. Answered by the plugin before the op runs | Which node, who changed it and when; `partial: { created: [], conflicts }`, `safeToRetry: true`; the hint: read it again, then send the call again, or `force: true` |
| `ROLLBACK_BLOCKED` | `figma_rollback` (ADR #43) when, since the savepoint, a person, a collaborator or another agent changed anything, the page was switched by anyone but the agent, or the plugin was run again | `partial: { created: [], changed, safe }`: what changed, and the nodes the agent created that `figma_delete_nodes` can remove instead; nothing was undone |
| `INTERNAL` | Unexpected bug; Figma refused a video render of an animated frame without a reason ("Video export failed"); a result too large for the connection between two Figxel processes | A short stack + the op; for the render, render again once, then restart Figma; for the result, which process to restart, or ask for less |

`AUTH_FAILED` is not a tool error — it is a WebSocket close code (`4001`). Its effect on the agent appears as `NO_SESSION` with a token hint (§5.7.4).

**No error code means "work too large" or "quota exhausted".** That is the core of the design. What remains are abnormal conditions only: stuck, temporarily full, unsupported, not connected.

Policies:

- **Multi-node ops return per-item results** (`[{id, ok, error?}]`). The agent fixes only what failed.
- **`create_from_spec` is semi-atomic:** a mid-way failure → `partial` carries the nodes already created + `failedAt`; all of it is one undo checkpoint. No ghost rollback.
- **Every write op ends with `commitUndo()`.**
- **The bridge never crashes because of the plugin** or because of one request.
- **Partial results are always reported** — finished work is not discarded and can be continued.

## 11. Testing

Tests first, then implementation (TDD).

| Level | Tool | Coverage |
|---|---|---|
| Unit — protocol | Vitest | Frame parse/serialize, per-op zod schemas, token & origin, idle timer (fake timers), queue & `BUSY`, session replacement per `instanceId`, chunk reassembly, in-flight idempotency |
| Unit — plugin ops | Vitest + `test/fake-figma.ts` | Every op against a fake `figma`; `dto.ts` (depth, limit, hex, `truncated`); `chunk.ts` (budget, cancel, progress throttle); `idempotency.ts` (attach, replay, LRU) — **without opening Figma** |
| Integration | Vitest + `tools/mock-plugin.mjs` | MCP tool call → WS → mock → result, end-to-end; `--slow`, `--stall`, `--drop` scenarios |
| MCP contract | `npx @modelcontextprotocol/inspector` | Tool schemas valid, descriptions readable, stdout clean |
| Docs | `node scripts/check-docs.mjs` | Relative links & anchors valid; heading tool counts = table rows; every referenced `figma_*` exists in the catalog |
| Unit — editor gate | Vitest (`test/editor-gate.test.ts`, `test/editor-integration.test.ts`) | One row per op and the tools.md table equal to it; the yes / no / unmeasured truth table at both layers; a bridge refusal sends no frame and reports `created: []` with `safeToRetry: true`; the editor reason before "too old"; a batch refused whole; the plugin backstop commits no undo and pins no key; through a proxy, an unmeasured write runs with the proxy's own `BRIDGE_ALLOW_UNVERIFIED` and is refused without it, while a **no** cell is refused either way; every description within 1024 characters with its `Editors:` sentence; the new tools registered before `figma_batch` |
| Unit — motion process | Vitest (`test/motion-process.test.ts`) | The plan checker rule by rule; the store op and `get_motion_context`'s plans against the plugin fakes; each gate in `strict`, `guided` and `off`; skill reads through `figma_get_guide`, the prompts and the `skill://` resources; a final render after a passing check, refused after a keyframe write, and previews always rendering |
| Unit — boards and decks | Vitest, fakes shaped after the typings (`test/editor-fakes.ts`, `figjam-fakes.ts`, `slides-fakes.ts`, `write-fakes.ts`) | Members that throw when touched, sublayer text, tables without children or cell ids, the opaque slide grid and rows, a layer whose x/y shifts by -240 when set before it is attached to a slide `[C-146]` |
| Live — FigJam & Slides | `spikes/live-editors.mjs`, `live-editors-write.mjs`, `live-reads.mjs`, `live-figjam.mjs`, `live-slides.mjs` | The only evidence that turns an editor cell to **yes** or **no**: one record per probe in `spikes/results/<spike>.json`, with the exact value or Figma's exact error message |
| Manual smoke | Figma desktop | Checklist: import the manifest, paste the token, `figma_status`, read context, screenshot, create a frame, set text, export a PNG to file, Ctrl+Z once = one op |
| **Load & responsiveness** | Vitest + Figma desktop | (a) `create_from_spec` with 5,000 nodes completes without rejection; (b) the Figma UI stays responsive during the op (yield works); (c) `progress` flows at least once per second; (d) a mid-op cancel produces correct partial results; (e) a 4-minute op is **not** `STALLED` by the bridge while progress flows; (f) a 20,000-node document is read in full via `nextCursor`; (g) a client timeout mid-op → retry with the same key → same result, **zero duplicates** |

**Tests (e) and (g) are the most important.** (e) proves the bridge timeout is idle-based and not a disguised duration ceiling. (g) proves that a *client* timeout — outside our control — neither discards nor duplicates work. If either fails, the design has not met its goal.

`test/fake-figma.ts`: minimal implementations of `createFrame`, `createText`, `appendChild`, `getNodeByIdAsync`, `loadFontAsync`, `exportAsync`, `commitUndo`, `ui.postMessage`, and so on. An upfront investment that pays repeatedly.

## 12. Roadmap

| Phase | Contents | Usable outcome |
|---|---|---|
| **0. Walking skeleton** | **Yield spike (§14.1)** & **auto-launch spike (§5.7.5)** first; scaffold (`package.json`, tsconfig, esbuild, Vitest, CI); `src/shared`; WS + MCP bridge + token + origin; `chunk.ts` + `idempotency.ts` + `progress` plumbing; `mock-plugin.mjs`; `figma_status` end-to-end; registration with an MCP client; verify the rest of §14.2–§14.7 | Plugin connected, proven alive; both spikes have **written numbers** |
| **1. Read** | `figma_get_metadata`, `figma_get_design_context` (+cursor), `figma_get_node`, `figma_get_selection`, `figma_get_nodes_info`, `figma_export_node`, `figma_get_variable_defs`, `figma_get_styles`, `figma_get_fonts`, `figma_search_nodes`, `figma_get_pages` | The agent understands a design → generates code; large documents read in full |
| **2. Core write** | `figma_create_from_spec` (chunking + progress), basic `figma_create_*`, `figma_set_text`, move/resize/rename/delete/clone/group/reparent, `figma_set_fills`/`strokes`/`corner_radius`, `commitUndo` per op | The agent builds and reshapes whole screens; large specs are never rejected |
| **3. Structure & system** | Components (convert/instance/swap/detach), styles, variables (collection/mode/value/bind), full auto-layout, constraints, the rest of the read/modify/style groups | The agent manages the design system |
| **4. Parity & polish** | `figma_eval` opt-in, `figma_save_screenshots`, `figma_export_frames_to_pdf`, the selection resource (`figxel://session/<id>/selection`, `figma://` until 2026-10-14), candidate decisions (tools.md), **audit every tool description** + measure actual tokens | The "equivalent to `use_figma`" claim is verified |
| **5. Hardening** | Real multi-session, reconnect storm, 10,000+ node load tests, re-measure auto-launch on the latest Figma version, multi-client daemon option if needed, final README quickstart | Used daily without thinking |
| **6. FigJam & Slides** | The manifest widened to FigJam and Figma Slides (ADR #33); the editor table and its two gates, `BRIDGE_ALLOW_UNVERIFIED` (§4.7, ADR #34, #35); 16 tools for boards and decks and about 25 existing tools extended to them; `create_from_spec` board node types and one spec per slide (ADR #37); the `figjam` and `slides` playbooks and the `build_board` / `build_deck` prompts; five live spikes | An agent builds boards and decks with the same loop it uses on a screen. **Implemented and unit-tested on 2026-10-09; the live runs are still to do**, and until they record results the unmeasured FigJam and Slides cells keep refusing writes ([plan record](../plans/2026-10-09-figjam-slides.md)) |
| **7. Skills: design, motion, storyboard, critique** | Agent guidance moved byte for byte into Agent Skills folders under `src/skills/`, bundled into the server and served five ways with `figma_get_guide` as the floor (ADR #38); four process skills — `design`, `storyboard`, `motion`, `critique` — that run a designer's and a motion designer's process as passes in one agent `[C-238]`, scaled by a gear and ended by a sign-off bar `[C-239]`; `figma_check_motion`, `figma_review_video`, `figma_create_storyboard` and `figma_create_animatic`; the `craft` and `tells` audits of `figma_check_layout` `[C-248]`; job mode on `figma_export_video` (ADR #39); the four defects of 2026-10-09 fixed so that ok means read back `[C-250]`; four new prompts, three with a `checkpoint` argument | An agent designs from a brief through directions, styleframes and measured critique rounds, and plans, builds and reviews a motion piece, in any MCP client. **Implemented and unit-tested on 2026-10-13; most live runs are still to do**, and `figma_create_storyboard` and `figma_create_animatic` refuse their writes in Design until theirs record results ([plan record](../plans/2026-10-13-skills.md)) |
| **8. Roles** | The role table (`src/shared/roles.ts`), `figma_set_brief`, `figma_get_brief` and `figma_sign_off`, the gate on new work and on final exports (ADR #42); `figma_check_layout`'s role audits `a11y`, `states`, `copy`, `system`, `deck`, `mark`, `icons` and `library` `[C-391]`; the `ux`, `graphic` and `brand` skills and a workflow per role in the others | Every piece of new work is done as the professional it needs would do it, from a brief to a sign-off. **Implemented and unit-tested on 2026-10-16; the live spike and the acceptance runs are still to do** ([next releases plan](../plans/2026-10-16-next-releases.md)) |
| **9. Trust** | Change attribution, the stale-write guard (`BRIDGE_CONFLICTS`, `force`, `STALE`), the change journal (`figma_get_changes`), savepoints with a rollback that never undoes anyone else's edit (`figma_savepoint`, `figma_rollback`), and `figma_stress_test` (ADR #43) | A person and an agent work in one file without either losing work, and a design is tested against real content before code. **Implemented and unit-tested on 2026-10-19; the live run is still to do** ([trust spec](../plans/2026-10-19-trust-spec.md)) |

**Ordering note:** `chunk.ts`, `progress`, and `idempotency.ts` belong in **Phase 0**. Added later, every op already written has to be torn apart.

Each phase gets its own implementation plan under `docs/superpowers/plans/`. This spec is the parent, not a replacement for a plan.

## 13. Decisions (ADR-lite)

| # | Decision | Rejected alternative | Reason |
|---|---|---|---|
| 1 | Plugin path + WS bridge | REST-only; official MCP | REST is read-only & quota-limited; the official MCP is quota-limited per seat. The plugin is the only write path without a quota |
| 2 | TypeScript/Node for **both** the plugin and the server | Python (continuing the old `server.py`) | The plugin **must** be JS. One language + `src/shared` = one contract. The Python REST server stays in use as a complement |
| 3 | `ws` + esbuild + Vitest + zod | A heavy bundler/framework | Build < 1 s, no magic |
| 4 | One process (MCP + bridge) per client | A separate always-on daemon | Installation without autostart, no orphan. Several clients still share one Figma connection — each process is MCP + bridge, and they sort out hub and proxies among themselves (ADR #30) |
| 5 | Sequential per session | Parallel | The plugin API is single-threaded; undo grouping is correct |
| 6 | Token handshake + Origin filter | No auth | A local port that can write documents without auth is a hole; the cost is ~20 lines |
| 7 | Normalized DTO + depth/limit, built in the plugin | Raw JSON; normalization in the bridge | Raw JSON destroys the context and burdens the WS. One place to normalize |
| 8 | Port 38452 | 3055 / 38451 | Both are taken by popular projects |
| 9 | `figma_eval` opt-in, two keys | Always on; not at all | A `use_figma` counterpart needs an escape hatch, but the default must be safe |
| 10 | Dev plugin (Import from manifest) | Publish to Community | No review, immediately usable |
| 11 | **IDLE-based bridge timeout** | A 30 s per-request ceiling (the first design) | A duration ceiling is a disguised hard limit. Idle-based accepts large work as long as it progresses |
| 12 | **Time-based yield, 12 ms budget** | Chunk every N nodes | Heavy and light nodes take different times, so a time budget preserves responsiveness whatever the load. **Measured 2026-10-07:** the budget is honoured for work (max slice 12–15 ms) and each yield then costs ~18–20 ms on top, so the effective period is budget + ~1 frame `[C-050]`. The 12 ms value itself is **left unchanged, pending a decision** |
| 13 | **`progress` is required for long ops** | Optional | Distinguishes "working" from "stuck" |
| 14 | **Batching (`create_from_spec`)** | One tool call per node | 800 calls = 800 chances to fail + 800 results in the context |
| 15 | **Partial results, not all-or-nothing** | Automatic rollback | Rollback discards work that succeeded |
| 16 | **Forwarding progress to MCP** | Swallowing progress in the bridge | Clients that use it do not give up; the agent sees work is alive |
| 17 | **An agent-settable `idempotencyKey`** + attach/replay in the plugin | A key derived from the bridge request id only | A bridge-made key does not protect retries after a *client* timeout, the most common case (Hermes 300 s) |
| 18 | **`figma_undo_step` with `confirm` + a warning** | Hiding `triggerUndo`'s behaviour | Undo can erase the user's manual work; the risk is stated |
| 19 | **Every tool registered; trimming on the client** | Defaulting to the `core` subset | A client's tool picker (e.g. `hermes mcp configure`) selects per server; the bridge does not guess. `BRIDGE_TOOLSET` for clients without a picker |
| 20 | ~~**Auto-launch opt-in, off by default**~~ **SUPERSEDED BY #32 (2026-10-07): removed entirely** | Always on; not at all | Was: keystrokes sent to a user's screen + focus theft need explicit permission. The spike showed permission is not enough — the mechanism cannot distinguish an absent operator from a present one `[C-053]` |
| 21 | **Not using Figma's internal protocol**, even though possible | Reverse-engineering the internal WebSocket | Figma's ToS forbids reverse-engineering; the risk is suspension of an account used for client work. The benefit is reachable via the plugin + auto-launch |
| 22 | **`yieldToHost` = timer (A), with iframe ping-pong (B) as an automatic fallback** — decided by the spike, not by preference | Microtask yield (the earlier draft) | Measured `[C-012]` `[C-013]`: `setTimeout` exists and yields (so A is the default); B also works and is marginally faster; the microtask blocked 7/7 runs and was worse than no yield at all |
| 23 | ~~**Plugin name `figma-mcp bridge`**~~ **SUPERSEDED BY #40 (2026-10-14): the plugin is named `Figxel`** | `figma-mcp` | Was: `figma-mcp-rust` is already imported; a name that prefixes another plugin makes quick actions ambiguous |
| 24 | **`figma_status` is answered by the bridge, without a plugin** | Status as a plugin op | A diagnostic tool must not fail with `NO_SESSION` |
| 25 | **Events from `currentPage.on("nodechange")`** | `figma.on("documentchange")` | Under `dynamic-page`, `documentchange` requires `loadAllPagesAsync` (expensive in large files) |
| 29 | **"No quota" is scoped to quota, not to plan features** | Implying the plugin unlocks everything on a free file | The Plugin API mirrors the plan's restrictions `[C-045]`. Starter still caps a file at 3 pages `[C-048]` and has no variable modes `[C-047]`. Stating this prevents a user discovering it at the worst moment; the tools carry the specific note |
| 27 | **Client timeout is documented as configurable, not as a wall** | Treating the 300 s default as immovable | `MAX_SAFE_TIMEOUT_S` in Hermes is ~49.7 days on Windows and its own comment calls a year "the semantic 'unbounded'" `[C-042]`. Stating the real ceiling turns "outside our control" into "one config line" |
| 28 | **MCP Tasks extension deferred to Phase 5** | Building it now | Hermes does not implement it `[C-043]`, and a server must not return a task to a client that did not declare support `[C-044]`. It is the right long-term answer for other clients, but it cannot help the Phase 0 target |
| 26 | **A process that cannot get the port never exits** | Crash / exit | An MCP client treats a dead server as gone and may keep respawning it. Held by a Figxel hub → share it as a proxy (ADR #30); held by anything else → stay alive, report `PORT_IN_USE`, and take over when the port frees up |
| 30 | **Hub / proxy: MCP clients share one Figma connection** | One client per machine (the first app to start owns Figma); a separate always-on daemon | Decided 2026-10-07: the server (then called figma-mcp) must not be tied to any one client — Claude Desktop, Claude Code, Hermes and the rest are peers. Electing the hub by who binds the port needs no daemon and no extra lifecycle, keeps the plugin protocol unchanged, and the shared token proves a peer belongs to the same installation |
| 31 | **The yield trade is documented as 2.8×–3.7×, not "a few percent"** | Leaving the optimistic estimate in place | The first estimate was wrong by roughly 6–25×. Progress UI, duration estimates and the "unlimited" promise would all mislead a user about how long a heavy operation takes if it stayed `[C-050]` |
| 32 | **Auto-launch is removed, not repaired** | Tuning the idle gate, or keeping it opt-in as a fallback | Three real attempts: the input technique was fixed (SendInput, `strayRisk: false`) but the plugin never opened, and the gate fired on 85 s of the operator thinking rather than being away `[C-053]`. More fundamentally — the operator's reasoning, which shaped this decision — the path's premise is taking the screen away from whoever is using the computer, which is the wrong price for opening a panel. The plugin is run from inside Figma, by a person. Consequence: `BRIDGE_AUTOLAUNCH` is inert and `figma_status` no longer reports it |
| 33 | **The plugin runs in FigJam and Figma Slides; Dev Mode stays out** (2026-10-09) | Keeping the Design-only v1 (§3 said so until this ADR); adding `dev` too | The user's decision `[C-128]`. The official server reaches boards and decks through `use_figma` JavaScript, with a FigJam reader and no Slides reader `[C-153]`, so typed tools close a real gap. Dev Mode writes nothing to the document and this project exists to replace it `[C-049]`; `["figjam", "dev"]` is not a valid manifest anyway `[C-131]` |
| 34 | **A static per-op editor table, enforced at the bridge and again in the plugin** (§4.7) | Filtering `hello.ops` by editor; probing `typeof figma.x` at call time; a tool list per session | `hello.ops` means "implemented by this build": filtering it would report a board's refusal as "plugin too old". A member a node lacks may throw rather than read as undefined, so probing can crash where it should refuse `[C-145]`. Tools belong to the server, and files in several editors are connected at once. One table gives one refusal text for both layers, a test that denies an op without a row, and the tools.md table pinned to it `[C-129]` |
| 35 | **Unmeasured cells refuse writes and run reads; a cell turns yes only from a recorded spike; `BRIDGE_ALLOW_UNVERIFIED` per process for measuring runs** | Trusting the typings for yes; reading a contradicted source as no; a hub-wide flag | The typings and Figma's own pages are conflicting on sections, shapes and tables in Slides, speaker notes, transitions and the view property `[C-137]` `[C-138]` `[C-139]` `[C-140]` — a spike settles each; an untested yes is how the untracked-claim failure starts (AGENTS.md). The one exception is `set_motion_plan` in Design (ADR #41). A **no** needs both sources to agree. The flag belongs to the process the MCP client talks to, like `BRIDGE_ALLOW_EVAL`: a spike measures as a proxy of the user's hub without the user's client being restarted, and that client stays strict |
| 36 | **The local diagram layout is deferred** `[C-130]` | A local `figma_create_diagram` now (a layered layout plus a Mermaid subset) | Every input it rests on is unmeasured — connector endpoint units, defaults and routing `[C-148]` `[C-149]`; it is about as large as the rest of the pass; and there is no official render to compare against, since `generate_diagram` is hosted `[C-154]`. Diagrams are hand-built from shapes with text and connectors in one `figma_create_from_spec` per zone; the re-entry criteria are in the [plan record](../plans/2026-10-09-figjam-slides.md) |
| 37 | **FigJam and Slides content reuses `figma_create_from_spec` and `figma_get_design_context`** | A separate board reader like the official `get_figjam`; a `content` parameter on `figma_create_slides`; a separate slide-row tool | One spec validator and one undo step per call. Board node types register as spec types (sticky, shape, table, code, connector — connectors built last, in their final parent, never moved `[C-149]`); a slide is filled by one spec with array roots, a few slides per batch `[C-155]`; a new row is `figma_create_slides` with `row` = the row count. `figma_get_design_context` reads every board node type and the connector graph from inside the plugin, in every editor — the official server needs `get_figjam` because its `get_metadata` does not work on FigJam `[C-153]` |
| 38 | **Agent guidance lives in Agent Skills folders under `src/skills/`, served five ways; the tools are the floor** (2026-10-13) | Guidance as TypeScript strings in `src/server/guides.ts` (until `a6ebb06`); the MCP skills extension's own methods; a Claude Code plugin package | One tree, one walker, the same bytes on every surface: `figma_get_guide` — every client has tools, so it is the floor, registered in every toolset but `none` — a pointer in the `instructions`, the prompts, `skill://` resources and the folders installed as skills `[C-237]`. Markdown in the Agent Skills format, with only `name` and `description` in its frontmatter, loads as it is in Claude Code, Codex, Cursor, VS Code and Gemini CLI `[C-174]` `[C-175]` `[C-177]` `[C-178]`. The resources follow the extension's layout, so its methods become additive later `[C-172]`; they wait because no mainstream client consumes them and this SDK does not speak their protocol revision `[C-173]`. A plugin package would serve one client and namespace the skills twice. Byte budgets and a drift test (`test/skills.test.ts`) keep every surface equal to the files |
| 39 | **`figma_export_video` runs as a job, detached from the call's cancel** (2026-10-13) | Forwarding the client's cancel to the plugin job (the earlier path); relying on progress notifications; MCP Tasks | A client cut the call at about 60 s and the forwarded cancel discarded a render Figma cannot stop `[C-197]`; progress keeps a call alive only where the client opts in `[C-030]` `[C-170]`. A call waits at most `wait` seconds (default 40) and answers `rendering` with a `jobId`; the render goes on, its result is kept 30 minutes, and the same `jobId` collects it `[C-249]`. This departs on purpose from "free its resources" on cancel `[C-171]`. Tasks stay deferred: a server may return a task only to a client that declared support, and Hermes does not implement them `[C-043]` `[C-044]` (ADR #28); the job store can sit behind them later, while job mode works in every client now |
| 40 | **The product is Figxel, shipped as the npm package `figxel-mcp`** (2026-10-14): MCP server name `figxel`, plugin name `Figxel`, home `~/.figxel`, skill folders `figxel-*`, resource scheme `figxel://`; the manifest id stays `figma-mcp-bridge` | Keeping the name `figma-mcp`; a new manifest id along with the new name | The public release needed a new name: `figma-mcp` carried Figma's name, which Figma's trademark guidelines do not allow in a third party's product name `[C-272]`. The manifest id is never shown to users and keys `figma.clientStorage`, where the plugin saves the token, so keeping it keeps every saved token `[C-276]`; a one-time copy of `~/.figma-mcp/token` keeps the server side equal (§4.3). Users install with `npx -y figxel-mcp@latest setup` (§5.8) instead of building a clone |
| 41 | **The motion process is enforced by the tools, not only taught** (2026-10-14) `[C-338]`: `BRIDGE_PROCESS`, default `strict`. A keyframe write needs the motion skill read in this process and a plan on the frame (`figma_set_motion_plan`, stored in shared plugin data); a final render needs a whole `figma_check_motion` at its fps that passed as the plan's own check (the check applies the plan, a looser call does not count, and a finding the brief intends is accepted in the plan with its reason), with no change to the file since; a preview always renders | Advice in the skills alone; a plan kept in server memory; refusing every render until a check passes | The owner's decision: any agent animating through Figxel must work like a professional motion designer, and a skill an agent may skip is advice. The plan lives in the file, so every session, client and later server reads the same one; the read and check state is per process, as each client is its own process (a proxy keeps its own while the hub holds the connection). Previews stay free because judging motion needs renders; only the delivery waits. A final call that names a render already running or done (its `jobId`, or the same settings) attaches to it before the plan is read, because that read answers `BUSY` while a render holds the plugin; one that matches a preview still rendering answers `BUSY` under `strict`, and the finished preview becomes the delivery once the gate can read. `guided` keeps the guidance without refusals, and `off` exists for measuring runs and scripts. A check goes stale on any write sent through this process and on any change the plugin reports on its current page (ADR #25), so an undo, a clone, a text edit, `figma_eval`, another client and an edit by hand are all seen, whatever frame id they name; a change reported just before a check costs one more check. Without `accept` the gate would hold a still open forever, and without the plan's own check a loosened one would pass. `set_motion_plan`'s Design cell is yes ahead of its own live run, the one exception to ADR #35: its one write is the measured storyboard write `[C-188]`, and as unmeasured it would refuse every keyframe write under the default. The run is in the roadmap's Next steps |
| 42 | **The role process: new work needs a role brief, done is a sign-off** (2026-10-16) `[C-383]` `[C-384]` `[C-385]` `[C-386]`: under the same `BRIDGE_PROCESS`, new work — a new top-level frame, component or section, a spec into an empty top-level frame, a new deck or board, a storyboard — waits for a brief in force for the file (`figma_set_brief`, after the skill of the role it needs is read: ux, graphic, illustration, brand, presentation, design-system, board or motion, each with its own workflow); the work ends with `figma_sign_off`, which runs the role's audits on the deliverables, takes the critique lens scores, rounds and answers, and writes a sign-off with a content fingerprint on each; a final export (`final: true` on `figma_export_node`, `figma_export_frames_to_pdf`, `figma_export_video`) waits for a passing sign-off newer than the last change. Edits are never gated; strict degrades to guided where it cannot be satisfied | Advice in the skills alone; one generic process for every kind of work; gating edits too; keeping briefs in server memory | The owner asked that the agent act as the professional each task needs, with planning before the work and testing after it, enforced by the tools as the motion process is (ADR #41). Records live in the file, so a second agent adopts an open brief with one read and the user sees which work is unsigned; the measured audits are the floor, and self-scored lenses are recorded where the user can see them ([role spec](../plans/2026-10-14-roles-spec.md)) |
| 43 | **Trust: the agent never silently overwrites a person's edit** (2026-10-19) `[C-392]` `[C-397]`: the plugin attributes every change on the watched page to the agent (inside an op's footprint and settle window) or to a person or collaborator; a write to a node someone else changed after the agent last read or wrote it answers `STALE` (`BRIDGE_CONFLICTS`: refuse by default, warn, off; `force` per call); every write is journalled (`figma_get_changes`); `figma_rollback` takes the agent back to a `figma_savepoint` only when nobody else — person, collaborator or another agent sharing the plugin — changed anything since, else it refuses and offers deleting what the agent created; `figma_stress_test` checks a frame under translated, longer and bigger content | Trusting Figma's undo alone; an undo that reaches whatever is on the stack; a guard on every write including adds into a frame | The research of 2026-10-19 found an agent overwriting a person's edit from a stale read the most intense unsolved pain, and a design breaking once real content arrives a common one. Figma does not tell a plugin's own change from a person's (`origin` is LOCAL for both), so the plugin attributes changes itself; what a live run must measure is `[C-394]` `[C-395]` ([trust spec](../plans/2026-10-19-trust-spec.md)) |

## 14. To Verify During Implementation

An honest list of what is **not yet** proven. Do not claim it is correct before testing.

**Design load-bearers (if they fail, the spec changes) — all in Phase 0:**

1. ~~**The yield primitive.**~~ **DONE 2026-10-07.** `setTimeout` exists and yields, so option A is the default, B the automatic fallback, C eliminated (7/7 blocked) `[C-012]` `[C-013]`. Overhead measured at ~18–20 ms per yield — **2.8×–3.7×** total, not the "few percent" this spec assumed `[C-050]`. Raw data: `spikes/results/{probe,yield}.json`. **One sub-check stays open:** run 7's "human check" boxes are all empty, contradicting its objective probe data — the drawing/menu test during a run must be repeated once, deliberately.
2. ~~**Specific `networkAccess` entries.**~~ **DONE 2026-10-07, negative:** the IP-literal entry is rejected at import, so the manifest uses `["*"]` + `reasoning` `[C-060]`; the iframe's Origin is `"null"` as expected. Original item: That a WebSocket from the plugin iframe to loopback *can* work already has evidence: the Figma MCP Rust plugin connects to `ws://127.0.0.1:1994` on the development machine — but with `allowedDomains: ["*"]`. What needs proving: a narrow `ws://127.0.0.1:38452` entry is accepted (IP-literal form vs `localhost`). If rejected → `["*"]` + `reasoning`, exactly like that plugin; the gate stays the token. Also record the Origin header the iframe actually sends (expectation: `null`).
3. **The plugin is not killed by Figma for idling for hours** (GC, memory, laptop sleep, file switch). Test: leave the plugin open for 8 hours with the bridge coming and going.
4. **The real client timeout.** Hermes: confirm `mcp_servers.figxel.timeout` is honoured (and whether `hermes config set mcp_servers.figxel.timeout 1800` is accepted, or whether it must go through `hermes config edit`); whether Hermes sends `notifications/cancelled` on timeout.

**Functional:**

5. `exportAsync({format:"PDF"})` for a frame on the installed version; output size for a large frame.
6. `figma.clientStorage` stores the token across plugin sessions, and survives a rebuild (same manifest id).
7. The manifest `id` for a dev plugin. Early evidence: Figma MCP Rust uses an arbitrary string (`"figma-mcp-rust"`) and works. Plan: `"figma-mcp-bridge"`. What needs proving: `clientStorage` is bound to that id and stable across builds.
8. **`triggerUndo()` against manual changes** — empirical confirmation of the §5.6.1 scenario before writing the tool description. **Half measured 2026-10-07:** one `figma_undo_step` right after a tool call took that call back `[C-059]`. Still open: whether a manual edit made between two tool calls is reverted with it — this needs a person editing between the calls, so it is a deliberate test, not something the all-tools probe can do alone.
9. `figma.fileKey` for a dev plugin (the docs say private plugins with `enablePrivatePluginApi` only). If unavailable, `file.key` stays `null` — no feature depends on it.
10. The sandbox syntax target (`es2017` vs newer).
11. The official path's quota/pricing figures (§1) — recheck whenever user documentation is written.

**FigJam and Slides (Phase 6) — settled only by the live runs** (`spikes/live-*.mjs`, one record per probe under `spikes/results/`; order and user steps in the [plan record](../plans/2026-10-09-figjam-slides.md)). Until then the cells that rest on them stay unmeasured:

12. Whether touching a member a node type lacks, or an opaque node's property, throws rather than reads as undefined `[C-145]`. `src/plugin/safe.ts` guards both outcomes.
13. The (-240, -240) shift of a layer whose x/y is set before its final append to a slide, and whether it is intermittent `[C-146]`. The builder attaches top-down and reports any `drift` it reads back; it never compensates.
14. A sticky's size (240×240, 416×240 when wide), its growth with its text, and its default font `[C-147]`.
15. Connector defaults (label font and fill, line type, caps) and the units of a point on a node `[C-148]`; whether a reparent or an x/y write leaves a stale route, and whether re-assigning an endpoint re-routes `[C-149]`.
16. Images on a board or a slide (`createImage`, `createImageAsync`) `[C-150]`.
17. One undo step per tool call in FigJam and Slides, as in Design `[C-151]`.
18. Whether a development plugin needs re-importing after its `editorType` changes, whether `clientStorage` (the saved token) is shared across editors, and whether selection and node-change events arrive from a board or a deck `[C-152]`.
19. A table column's minimum width `[C-161]`; whether a refused link preview leaves a node behind `[C-162]`; row identity, pruning and default names when slides are regrouped `[C-164]`; a section's `arrange` defaults `[C-166]`; the range of a list level's indent `[C-167]`.
20. The conflicting sources, each settled by a spike, never by choosing one: components, sections, shapes with text and tables in Slides `[C-137]`; speaker notes `[C-138]`; slide transitions `[C-139]`; the view property `[C-140]`; `SectionNode.resize()` `[C-141]`; pages in FigJam `[C-142]`; DART as a code language `[C-143]`; the section palette `[C-144]`.

## 15. Open Questions — ALL RESOLVED

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Product name / server name in MCP clients | **Figxel**: npm package `figxel-mcp`, MCP server name `figxel`, plugin name `Figxel` (manifest id `figma-mcp-bridge`). Until 2026-10-14: `figma-mcp`, plugin `figma-mcp bridge` | ADR #40 (superseding #23) |
| 2 | Repo location | **[github.com/AvYour/figxel-mcp](https://github.com/AvYour/figxel-mcp)** | — |
| 3 | Auto-connect | **Opt-in, off by default** (`BRIDGE_AUTOLAUNCH=1`) | §5.7 |
| 4 | Port | **38452** | §4.3 |
| 5 | `figma_eval` | **Present, opt-in** (`BRIDGE_ALLOW_EVAL=1`) | tools.md |
| 6 | Toolset | **Every catalog tool active by default** (128 since 2026-10-09; [tools.md](../../reference/tools.md) holds the count); trimming on the client + `BRIDGE_TOOLSET` | §5.6.5 |
| 7 | Prior assets | Left as references until the bridge is stable; revisited after Phase 2 | current-state.md |

One thing **not** left open as a question: the reverse-engineering route into Figma's internal protocol — deliberately rejected (ADR #21).

---

**Appendix A — Environment and prior art (the earlier work this project learned from, and the verified environment):** [`current-state.md`](../../reference/current-state.md).
