# Environment and Prior Art

What existed before Figxel was started (it was called figma-mcp then), what that earlier work taught, and the environment the project was first measured on. **The goal: do not throw away earlier work, but do not inherit its problems either.**

Recorded on 2026-10-06 and 2026-10-07. The versions in §5 were read from the development machine, not copied from older notes, and two rows were updated on 2026-10-14 where the claim registry says so.

Figxel's runtime data lives in its home folder, `~/.figxel/` (`BRIDGE_HOME` moves it; spec §4.3). None of the earlier work below is part of Figxel or needed to run it.

---

## 1. An earlier REST MCP server (Python)

**What it was:** a read-only MCP server over Figma's REST API, written before this project.

| Aspect | Detail |
|---|---|
| Size | 205 lines, one file, no dependencies beyond the `mcp` SDK |
| Auth | `FIGMA_TOKEN` (a personal access token) from the environment |
| Tools | `whoami`, `get_file`, `get_node`, `export_image`, `get_comments`, `get_local_variables` |
| Base | `https://api.figma.com/v1` |

**What was worth keeping:**
- `_extract_file_key`: accepts a full Figma URL or a bare key.
- `_normalize_node_id`: `1-2` ⇄ `1:2`.
- `_extract_node_id_from_url`: pulls `?node-id=` out of a URL.
- The `_request` pattern with readable HTTP errors.

**Limitations that motivated this project:**
- Read-only (REST cannot write to the canvas).
- Subject to Figma's REST rate limits (spec §1).
- Requires a personal access token.
- No normalized design context, no styles, no selection, no fonts, and so on.

**Treatment:** the three helpers above were ported to TypeScript in `src/server/figma-url.ts`. Comments stay out of reach of a plugin (spec §3); they are reachable only through the REST API.

---

## 2. The "Design Generator" plugin (JS)

**What it was:** a Figma plugin run by hand: paste a JSON spec, press Generate.

| File | Size | Contents |
|---|---|---|
| `manifest.json` | 7 lines | `name: "Design Generator"`, `main: code.js`, `ui: ui.html`, `editorType: ["figma"]`; no `id`, no `documentAccess`, no `networkAccess` |
| `code.js` | 264 lines | Sandbox: node builders, auto-layout and `figma.ui.onmessage` |
| `ui.html` | 116 lines | JSON textarea, Generate and Clear buttons, a status line |
| `README.md` | — | Usage |
| `examples/landing-hero.json` | — | An example 1440×900 hero-section spec |

**What was used directly (the core of Phase 2):**
- `hexToRgb` / `paint(color, opacity)`: colour conversion and a SOLID paint object.
- `hasBg`: distinguishes `"none"`/`"transparent"` from a real colour.
- `FONT_FAMILIES = ["Inter","Roboto","Arial","Helvetica Neue"]` with `weightToStyle` and `loadFont` with an ordered fallback.
- `enumOr`: agent-friendly strings to Figma API enums (`horizontal`→`HORIZONTAL`, `space-between`→`SPACE_BETWEEN`, …).
- `applyPadding`: a number or `[t,r,b,l]`.
- `applyAutoLayout`: layoutMode, sizing, itemSpacing, alignment, wrap.
- Per-type builders `buildText`, `buildRect`, `buildEllipse`, `buildButton` and `buildFrame`, with `buildNode` as the recursive dispatch.
- Post-create layout: top-level nodes stacked vertically 64 px apart, then `scrollAndZoomIntoView`.

**Limitations the bridge fixes:**
- An agent cannot invoke it: the JSON must be pasted by hand.
- It returns no node ids (only a count), so steps cannot be chained.
- No `commitUndo`, no per-node failure report.
- No style, variable or component binding; it cannot read context.
- No `documentAccess: "dynamic-page"`: its synchronous node access had to move to async APIs.

**Treatment:** the logic was **ported** into the plugin's `create_from_spec` (`src/plugin/ops/create.ts`, with shared helpers in `src/plugin/write.ts`) and extended with structured results, `commitUndo`, chunking and per-node reporting. The original stayed outside this repository as a reference (spec §15 #7).

---

## 3. A third-party plugin-based server (figma-mcp-rust)

**What it was:** a third-party MCP server with a companion Figma plugin, published on npm as `@alvinindra/figma-mcp-rust`, tried before this project started. Two scripts from those experiments drove it over stdio: one sent `initialize` and a sequence of tool calls that chained node ids into a company-profile layout; a later version used FIXED sizing so that explicit section heights held, and parented every section into a root auto-layout with `itemSpacing: 0`.

Its plugin manifest, read directly:

| Field | Value | What it meant for this project |
|---|---|---|
| `name` | `"Figma MCP Rust"` | Why this project's plugin got a distinct name: `figma-mcp bridge` at first (spec ADR #23), `Figxel` since 2026-10-14 |
| `id` | `"figma-mcp-rust"` | Evidence that a development plugin may use an arbitrary string `id` `[C-022]` (spec §14.7) |
| `networkAccess.allowedDomains` | `["*"]` with a `reasoning` | The plugin connects to `ws://127.0.0.1:1994` from its iframe and worked on the development machine, so an iframe WebSocket to loopback works. `["*"]` was the fallback if a `ws://127.0.0.1:38452` entry was rejected (spec §14.2), and it was needed `[C-060]` |
| `documentAccess` | `"dynamic-page"` | The same as this project |
| `editorType` | `["figma", "dev"]` | This project's was `["figma"]` until 2026-10-09 and has been `["figma", "figjam", "slides"]` since; never `dev` (spec ADR #33) `[C-128]` |

**Empirical lessons from those experiments:**
1. **`primaryAxisSizingMode = FIXED` and `counterAxisSizingMode = FIXED`** are required for explicit heights to hold; with `AUTO` a section shrinks to its content. So `sizing: "fixed"` is the default in `create_from_spec` when a width or height is given.
2. **Parenting into a single root auto-layout with `itemSpacing: 0`** is more reliable than a manual `y` cursor, which drifts.
3. The pattern **"create a node, take its id, use that id as the parent of the next"** is the right agent workflow, so **every create returns an id** (tools.md § create).
4. Spawning an MCP server over stdio (initialize, a tool call, read the result) is a pattern usable for integration tests.

**Treatment:** a behaviour comparison only. It was not a foundation, because a third-party package cannot be extended here. Its port (1994) does not conflict with 38452.

---

## 4. The first live run (2026-10-07)

### What ran

| Layer | State on 2026-10-07 |
|---|---|
| Server | MCP server over stdio; hub/proxy sharing; token and origin checks |
| Plugin | Imported in Figma desktop 126.9.11, session live, `clientStorage` token persistence measured |
| Tools registered | **16**: `figma_status` and the 15 read tools (Phase 1) |
| Tests | 97 across 9 files; typecheck clean |
| Not implemented yet | Phases 2–4 (create, modify, style, export, eval) |

The read tools were `get_metadata`, `get_pages`, `get_node`, `get_nodes_info`, `get_selection`, `get_design_context`, `search_nodes`, `scan_nodes_by_types`, `scan_text_nodes`, `get_styles`, `get_variable_defs`, `get_local_components`, `get_fonts`, `get_annotations` and `get_reactions`.

**One wire-level fix worth knowing about:** the MCP TypeScript SDK hardcodes JSON Schema draft-07 into every tool schema that has parameters, and the Anthropic API rejects that dialect, which would have broken every tool on Claude Desktop, silently, at the provider. `src/server/schema-dialect.ts` removes the key, and `test/schema-dialect.test.ts` keeps it that way. A tool with no parameters was never affected, which is why this stayed invisible until Phase 1.

### Verified against the real canvas

Not just against mocks: all 15 read tools ran against a live Figma desktop with the plugin connected, on a file whose main frame holds 5,000 rectangles.

| What | Result |
|---|---|
| Every read tool returns without error | **15/15** |
| Paging a 5,000-node subtree, `limit=1000` | 5 pages, **5,000 distinct ids, zero duplicates**, 354 ms total |
| `truncated` flag | `true` on pages 1–4, `false` on the last; never wrong |
| A cursor from one query offered to another | **refused** (`does not belong to this query`) |
| The same cursor on its own query | **accepted**, so the refusal is scoping, not blanket |
| A well-formed cursor with a tampered offset | 0 nodes, no crash, no silent rewind |
| 500-node `get_design_context` | 24 ms |

The last three are asserted in `test/cursor.test.ts` (63 cases), verified by removing the scope check and confirming that exactly the four scope tests fail.

**Measured, not assumed:** every `figma_*` name the plugin advertises is checked against the catalog, and every tool schema is checked against a conservative cross-provider subset. Both guards earned their place; the schema guard is what found C-055.

### Client facts that shaped the timeout design

Figxel is not tied to any client (spec Goal 5, ADR #30); per-client setup is in [docs/clients.md](../clients.md). Hermes was the first client measured, and these facts, read from its source and `--help` (v0.21.5), shaped the timeout design:

| Fact | Source | Impact |
|---|---|---|
| `hermes mcp add <name> [--command …] [--env K=V …] --args …`: **`--args` must be the last option** `[C-034]` | `hermes mcp add --help` | The registration command order in docs/clients.md |
| `hermes mcp configure <name>` toggles the tool selection `[C-034]` | `hermes mcp configure --help` | The main route for trimming the toolset in Hermes (spec §5.6.5) |
| `hermes mcp test <name>` | `hermes mcp --help` | A connection check after registration |
| The tool-call timeout defaults to **300 s of wall-clock time**, per server through `mcp_servers.<name>.timeout` `[C-031]` | `tools/mcp_tool_common.py` | Spec §5.5 Limit 6: it must be raised for long ops |
| `call_tool` is invoked **without** a progress callback `[C-031]` | `tools/mcp_tool_handlers.py` | Progress does not extend a tool call in Hermes; `idempotencyKey` is the safeguard |
| A new user message during a tool call interrupts the call | `tools/mcp_tool_handlers.py` | Like the timeout, safe thanks to idempotency |
| Per-server options `lazy`, `idle_timeout_seconds` and `max_lifetime_seconds` (off by default) | `tools/mcp_tool_discovery.py`, `mcp_tool_server_run.py` | If they are on, Hermes may restart the server; the plugin reconnects on its own (protocol §5) |
| Config file: `%LOCALAPPDATA%\hermes\config.yaml` on Windows (`hermes config path`) | `hermes config --help` | Where `timeout` goes |

---

## 5. Verified environment

Read from the development machine (Windows 11) on 2026-10-06. Package versions are `npm view <pkg> version` that day (the newest in the registry), pinned in `package.json` at the Phase 0 scaffold.

| Item | Version | Notes |
|---|---|---|
| Node | **v24.19.0** on PATH `[C-032]` | An earlier note said v26.7.0: that is the Node that Hermes bundles for its own MCP servers, which ran the bridge on 2026-10-07, so the bridge works under both `[C-032]`. Figxel requires Node 22 or later: 22 is maintained until 2027-04-30 and 24 is the active LTS line `[C-292]`. Node 24 has a global `WebSocket` (used by the mock plugin) |
| npm | 11.17.0 | — |
| Git | 2.54.0.windows.1 | Line endings handled by `.gitattributes` |
| Hermes | v0.21.5 (2026-09-24) | — |
| Figma desktop | `app-126.8.18`, `app-126.9.11` and `app-126.9.13` installed on 2026-10-14; 126.9.13 last ran `[C-033]` | Squirrel runs the newest. On 2026-10-06 the installed set was 126.8.16, 126.8.18 and 126.9.11. Figma desktop exists for macOS and Windows only `[C-273]`; the live runs so far were on Windows |
| `@modelcontextprotocol/sdk` | 1.32.1 | peer `zod: ^3.25 \|\| ^4.0`, so **zod 4 is compatible** (checked, no longer an open question) |
| `@figma/plugin-typings` | 1.141.0 | — |
| `ws` | 8.22.0 | — |
| esbuild | 0.28.2 | — |
| vitest | 5.0.3 | — |
| zod | 4.6.5 | — |
| typescript | 7.0.2 | Typecheck only (`tsc --noEmit`); bundling is done by esbuild |
| `pdf-lib` | 1.17.1 | Used by `figma_export_frames_to_pdf` (tools.md § export) |

---

## 6. Summary: used, reworked, retired

| Earlier work | Used | Reworked / merged | Retired |
|---|---|---|---|
| The REST MCP server (§1) | its URL and node-id helpers | ported to `src/server/figma-url.ts` | not part of Figxel |
| The "Design Generator" plugin (§2) | its builder logic | became `create_from_spec` and the plugin ops | revisited after Phase 2 (spec §15 #7) |
| figma-mcp-rust (§3) | a comparison, and the proof that loopback WebSockets work | its sizing and parenting lessons folded into the spec | not part of Figxel |
