# Phase 0 — Walking Skeleton: Implementation Log

| | |
|---|---|
| **Date** | 2026-10-07 |
| **Parent** | [Design spec](../specs/2026-10-06-figma-mcp-design.md) §12 Phase 0 · [Phase 0 order](../../reference/roadmap.md#phase-0--walking-skeleton) (in the README's Next Steps when this log was written; now in the roadmap) |
| **Status** | Code steps done and tested. **The gate is not passed yet**: both spikes and the in-Figma checks need Figma desktop and a human (below) |

This is a working plan, deliberately outside the locked documentation surface (AGENTS.md). Nothing locked was edited to produce it: `node scripts/lock-docs.mjs` still reports every locked file unchanged.

---

## Step status (README Next Steps order)

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Spike: yield primitive | ✅ **Ran 2026-10-07** — option A chosen; microtask confirmed useless | `spikes/yield/` (procedure below) |
| 2 | Spike: auto-launch | ❌ **Attempted, then REMOVED 2026-10-07.** Three real attempts: the input technique was fixed (SendInput, `strayRisk: false`) but the plugin never opened, and the idle gate fired on 85 s of thinking. Removed on the operator's reasoning — the path's premise is taking the screen from the person using it. **No further attempts** | `spikes/autolaunch/` kept as evidence |
| 3 | Claim verification | ✅ **Ran and applied 2026-10-07** — C-012/C-013 resolved by the yield spike, C-021/C-025 promoted to `measured`, C-051 added, spec §5.6.3 corrected | [Claim verification](#claim-verification) · [API probe](#api-probe-c-021-c-012-globals-c-025-runtime-shape) |
| 4 | Scaffold | ✅ | `package.json` (exact versions from current-state §5), three tsconfigs, `tools/build.mjs`, `vitest.config.ts`, `.github/workflows/ci.yml` |
| 5 | `src/shared/` | ✅ | `protocol.ts`, `ops.ts`, `errors.ts`, `version.ts` |
| 6 | `src/server/` | ✅ | WS + MCP + token + origin + idle timer + `figma_status` without a plugin + `PORT_IN_USE` |
| 7 | `src/plugin/` | ✅ | `code.ts`, `ui.html` + `ui.ts`, `chunk.ts` + `yieldToHost`, `idempotency.ts`, `events.ts`, progress plumbing |
| 8 | `tools/mock-plugin.mjs` | ✅ | `--slow` / `--stall` / `--drop`, importable by tests |
| 9 | `figma_status` end-to-end in Figma desktop + spec §14.2–§14.7 | ✅ **Ran 2026-10-07** — plugin imported, token saved, session `s-6` live; §14.2 / §14.6 / §14.7 / `figma_status` answered (checklist below) | Checklist below · raw data `spikes/results/probe.json` |
| 10 | Register with an MCP client + timeout + connection test | ✅ (2026-10-07) — first Hermes (since removed), now Claude Desktop | [Step 10](#step-10--hermes-registration) |

## What runs today

```bash
npm install
npm run build          # dist/server.js + dist/plugin/{code.js,ui.html,manifest.json}, ~0.5 s
npm run typecheck      # server+shared+tests, plugin sandbox (no DOM), plugin UI (DOM)
npm test               # 92 tests: unit, sandbox-globals and schema-portability guards, bridge+mock integration incl. hub/proxy sharing, built plugin bundles, e2e against dist/server.js
npm run check:docs     # check-docs + check-claims + lock-docs
```

Test coverage against spec §11:

| Spec §11 row | Where |
|---|---|
| Unit — protocol | `test/bridge.test.ts` (handshake and every close code, idle timer, queue & `BUSY`, session replacement, chunk reassembly, in-flight idempotency), `test/server-units.test.ts` (frame schemas, config, token, results, progress forwarding) |
| Unit — plugin | `test/plugin-units.test.ts` (`chunk.ts` budget/cancel/throttle, option B scheduler, `idempotency.ts` attach/replay/LRU/TTL). Ops come with Phase 1 |
| Integration | `test/bridge.test.ts` against `tools/mock-plugin.mjs`, including `--stall`, `--slow`, `--drop` |
| Load test (e), in miniature | An op runs 3× past its idle timeout while progress flows and is never `STALLED` |
| Load test (g), in miniature | A mid-op disconnect → `NO_SESSION` carrying the key → retry with the same key → `replayed: true`, the node created exactly once |
| MCP contract | `test/server.e2e.test.ts`: real stdio client against `dist/server.js`; stdout stays pure JSON-RPC while the plugin logs; `notifications/progress` strictly increasing and coalesced; client cancel → `cancel{CLIENT_CANCELLED}` |
| Lifecycle (spec §4.6) | Exit within 1 s of stdin closing with the port released; a second process stays alive with `PORT_IN_USE` and takes over; invalid config refuses to start |
| Built plugin, without Figma | `test/plugin-bundle.test.ts` runs `dist/plugin/code.js` and the script inlined in `dist/plugin/ui.html` in `node:vm` realms against a real bridge, with only Figma's APIs faked. The sandbox realm has **no `setTimeout`** (the worst case of `[C-012]`, which the spike must test) and the plugin still connects, debounces events through the iframe, saves a pasted token, stops on 4001, shows "Replaced" on 4004, and reconnects to a restarted bridge in under 3.5 s |
| Docs | `npm run check:docs`; and `test/ops.test.ts` parses `tools.md` so the op table cannot drift from the catalog |

## Deviations from the spec (small, deliberate)

| Spec says | Implemented | Why |
|---|---|---|
| §4.5 layout lists `src/shared/protocol.ts` as the message types | `protocol.ts` holds **types and constants only**; frame validation with zod lives in a new `src/server/frames.ts` | The plugin bundles import `protocol.ts`; keeping zod out of it keeps both plugin bundles dependency-free |
| §4.5 layout | New small files: `src/shared/version.ts`, `src/server/tools/forward.ts` (the path every plugin-backed tool takes), `src/plugin/messages.ts` (sandbox ⇄ iframe messages) | Each has one job; none changes behaviour the docs specify |
| §4.5 build "one `npm run build`" | The build script is `tools/build.mjs` | `scripts/**` is locked; a new file there makes `lock-docs` fail |
| current-state §5 versions | Exactly those, plus `@types/node` 24.19.1 and `@types/ws` 8.18.2 | Needed for the typecheck; not listed in §5 |
| §5.6.5 "every catalog tool registered" | The toolset still **selects** 68; only implemented tools are **registered** (Phase 0: `figma_status`). `figma_status` reports both numbers | Registering a tool before it exists would hand the agent a tool that cannot work. Each phase registers its group |
| §4.4 `BRIDGE_AUTOLAUNCH` | Parsed and validated, but inert; `figma_status` says so | Spec §5.7.5: no auto-launch before the spike's numbers |
| §5.5 Limit 1 "A or B, chosen at plugin start" | Now as specified: spike 1 chose option **A** (`timer`), with B as the automatic fallback — see [Spike 1](#spike-1--yield-primitive-spec-141) | Was B until the spike measured `[C-012]` |
| §5.2 events debounced 150 ms | The debounce uses a delay served by the UI iframe, not the sandbox | Kept after spike 1 found `setTimeout`: the iframe delay works whether or not a future Figma keeps it, since official pages contradict each other `[C-012]` |
| §9 manifest `allowedDomains: ["ws://127.0.0.1:38452", "ws://localhost:38452"]` | `["*"]` + `reasoning` | Figma rejected the IP-literal entry at import (see the [API probe](#api-probe-c-021-c-012-globals-c-025-runtime-shape)). Spec §14.2 prescribes exactly this fallback; the token stays the gate |
| §4.2 / §4.6 / ADR #4 / ADR #26: one MCP client per machine; a second process reports `PORT_IN_USE` | **Hub / proxy sharing** — see [Any AI app](#any-ai-app-not-locked-to-hermes) | The operator asked (2026-10-07) that figma-mcp not be locked to Hermes. With one port, whichever app started first owned Figma. Spec §4.2 anticipated this split; it is done without a daemon and without changing the plugin protocol |

## Any AI app (not locked to Hermes)

Requested on 2026-10-07: every AI app — and so every model — must be able to use figma-mcp. MCP is model-agnostic already; three things stood in the way.

| Obstacle | What was built | Evidence |
|---|---|---|
| Only one process can hold port 38452, so the first app to start owned Figma — on this machine that was the Hermes session, which had spawned the bridge with its own bundled Node 26.7.0 | **Hub / proxy.** The process that binds the port is the hub and owns the plugin sessions. A process that finds the port held by a figma-mcp hub joins it over the same port (`peer-hello` with the shared token, `src/server/peer.ts`) and forwards calls, progress, and cancellation. When the hub exits, the proxies race for the port and the plugin reconnects to the winner. `PORT_IN_USE` now means only "held by something that is not a compatible figma-mcp" | `test/bridge.test.ts` § sharing (proxy reaches the plugin; progress, keys, errors, cancel forwarded; one idempotencyKey from two apps → one execution; hub exit → proxy takes over, plugin reconnects; in-flight call → `NO_SESSION` with its key; a foreign holder and another installation's token both stay `PORT_IN_USE`), `test/server.e2e.test.ts` (two real processes) |
| Providers accept different slices of JSON Schema in function calling | A guard that lists the server's real tools through an MCP client and rejects anything outside a conservative subset | `test/schema-portability.test.ts` — runs in CI, so every tool added in Phases 1–4 is checked |
| Each app is configured differently, and default tool-call timeouts range from 60 s (Codex) to ~28 h (Claude Code) | [docs/clients.md](../../clients.md): Hermes, Claude Code, Claude Desktop, VS Code, Codex, Gemini CLI, Cursor, any other app — with each app's timeout knob | Commands verified from each installed app's `--help`; the rest from official docs, linked there |

Registered, at the operator's request: **Claude Desktop** (2026-10-07). Removed, at the operator's request: **Hermes** — figma-mcp must not be tied to it. Launching the exact command from Claude Desktop's config with a minimal environment (no Hermes, PATH reduced to `C:\Windows\system32`): the first process became the hub, a second one a proxy. Other installed apps (Claude Code, VS Code, Codex) are one command each in `docs/clients.md`.

## Spike 1 — yield primitive (spec §14.1)

1. Figma desktop → **Plugins → Development → Import plugin from manifest…** → `spikes/yield/manifest.json`.
2. Open a **scratch** file, run **figma-mcp yield spike**.
3. Press **Setup** (creates one frame, "yield-spike (safe to delete)", with 5,000 rectangles).
4. For each of **A**, **B**, **C**, **baseline**: press Run; while it runs, press **Cancel**, try drawing, try opening a menu; tick what worked; press **Record human check**.
5. Copy the JSON from the text box into the table below (or a file next to this plan).

What decides the outcome — objective, not only felt: `probeLatencyMaxMs` is how long Figma's main thread stayed blocked (the iframe probes every 20 ms). A working yield keeps it near the 12 ms budget plus the yield's cost; `blockedEntireRun: true` means no probe got through at all.

**Ran 2026-10-07** on Figma desktop 126.9.11 — 5,000 nodes × 5 passes = 25,000 rotations per run, 12 runs. Raw report: `spikes/results/yield.json` (pasted by the operator; the collector had stopped when Claude Desktop restarted). Sandbox: `typeof setTimeout` = `function`, and a 10 ms timer fired after 17 ms.

| Option | Yields to the editor? | Total ms (25,000 mods) | vs baseline | Probes handled during the run | `probeLatencyMaxMs` (p95) | Cancel |
|---|---|---|---|---|---|---|
| baseline (no yield) | **No** — blocked the whole run | 797 | 1× | 0 | — | — |
| **A `setTimeout`** | **Yes** | 2,926 | 3.7× | 100 | 69 (55) | — |
| B iframe ping-pong | **Yes** | 2,229 / 2,962 | 2.8× / 3.7× | 96 / 120 | 67 / 101 (34 / 57) | **8 ms** after the click (a cancelled run stopped at 10,332 mods) |
| C microtask | **No** — blocked in **7 of 7** runs | 716–865 | ~1× | 0 | — | — |

Findings:

- **C-013 holds on Figma's own host**, not just in browsers: a microtask never handed the editor a turn. The earlier draft's plan would have frozen Figma.
- **A and B both yield.** Worst input latency stays at ~70–100 ms (the editor handles input within a tenth of a second) instead of the whole run.
- **Each yield costs about one rendered frame**, not ~1 ms: (2,229 − 797) / 81 yields ≈ 18 ms for B, (2,926 − 797) / 108 ≈ 20 ms for A — the editor repaints the changed nodes in its turn. So for this render-heavy workload a responsive run takes ~3–4× the frozen one; spec §5.5's "overhead < 10%" estimate for B does not hold. The budget (ADR #12, 12 ms) is the dial between responsiveness and throughput — a proposal for the owner, not changed here.
- The only human-check record (the second full B run) has every box unticked, which contradicts that run's own probes and the 8 ms cancel of the run before it. Most likely nothing was tried during that 3-second run; treated as inconclusive. Draw/menu responsiveness is worth one deliberate re-check.

**Decision (spec §14.1 rule: "A if it is available and responsive"):** `YIELD_MODE = "timer"` in `src/plugin/code.ts`. `chooseYield` still falls back to option B by itself if a future Figma drops `setTimeout` — exercised by `test/plugin-bundle.test.ts`, whose sandbox realm has no timers.

## Spike 2 — auto-launch (spec §5.7.5)

Windows only. Close any Hermes session first (the spike runs its own bridge on 38452).

```bash
npm run build
```

```bash
npm run spike:autolaunch -- --attempts 20
```

Per attempt: close the plugin window in Figma, click back into the terminal, press Enter. The script runs `spikes/autolaunch/autolaunch.ps1` (foreground check before **each** keystroke) and times the session through the real bridge. Results are saved as `spikes/autolaunch/results-*.json`.

**Attempted 2026-10-07 and stopped for a reason worth recording.** The driver route was tried first, because it removes the whole stray-keystroke risk: `cua-driver` can post keys to a window *without* raising it. Figma refuses that — `background_unavailable`, *"background input is dropped by this surface"* (new claim C-052). So every keystroke this spike sends must be preceded by taking focus, which is what `autolaunch.ps1` already does and measures.

Two things were measured on the way, both real results:

| What | Result |
|---|---|
| `Ctrl+/` (what `autolaunch.ps1` types) opens no menu in Figma 126.9.11 — **and the shipped hint no longer tells users to try it** | **Observed** — sent twice to the running app with the plugin focused; the canvas was unchanged both times, and no quick-action surface appeared. The whole spike hangs on this chord, so it needs re-checking against Figma's current documented shortcut before 20 attempts are spent |
| `Ctrl+K` is a live command surface | **Observed** — after `Ctrl+K` the plugin reconnected as session `s-7`, and Figma's own accessibility text across the app reads *"press Ctrl+K"*. `autolaunch.ps1` does not use it |
| Closing and reopening the plugin does **not** require the token again (§14.6) | **Answered from timestamps**: the token file was created 11:42:08 and the plugin reconnected at 13:32:45 as a new session with no token entry in its ACTIVITY log — `figma.clientStorage` persistence holds across a close/reopen |

**Not produced:** the 20-attempt numbers. The loop needs a human to close the plugin window between attempts, and the chord under test appears not to open the surface it targets.

| Metric | Target | Result |
|---|---|---|
| Success, Figma not in the foreground | ≥ 95% over 20 | pending |
| Trigger → session ready | ≤ 5 s | pending |
| Stray keystrokes | 0 over 50 | pending (needs `--attempts 50`) |
| Top quick-action hit is our plugin, with Figma MCP Rust imported | 20/20 | pending |

## In-Figma checks (step 9)

1. `npm run build`, then `node dist/server.js --print-token` and copy the token.
2. Import `dist/plugin/manifest.json`; run **figma-mcp bridge**; paste the token. The plugin shows "Waiting for bridge…" (nothing is listening yet — expected).
3. Start a bridge (`node dist/server.js` from a terminal is enough); the plugin turns "Connected".
4. Record for spec §14.2–§14.7:

| Item | What to record | Result |
|---|---|---|
| §14.2 `networkAccess` | Does `ws://127.0.0.1:38452` in `allowedDomains` connect? If not, retry with `["*"]` + `reasoning` | ✅ **Answered, negative.** The IP-literal form is **rejected at import**: *"Invalid value for allowedDomains. 'ws://127.0.0.1:38452' must be a valid URL."* `ws://localhost:38453` is accepted. Both plugins therefore use `["*"]` + `reasoning`, the fallback §14.2 prescribes |
| §14.2 Origin | The bridge logs a rejected Origin; none should appear for the plugin (expected `null`) | ✅ **Answered:** the iframe sends `"null"`, and the bridge's Origin filter accepts it. No rejection logged |
| §14.3 Long idle | Plugin left open 8 h with the bridge stopping and starting | pending |
| §14.4 Hermes timeout | `hermes config set mcp_servers.figma-mcp.timeout 1800` accepted? Honoured? `notifications/cancelled` sent on timeout? | Accepted; read per server by `_resolve_tool_timeout`; cancel is sent — by source, see [Step 10](#step-10--hermes-registration). Not yet observed with a long op |
| §14.6 `clientStorage` | Token survives closing/reopening the plugin and a rebuild | ✅ **Answered for close/reopen, measured by timestamp:** the token file was created at 11:42:08 and the plugin reconnected at 13:32:45 as a fresh session (`s-7`) with no token entry in its ACTIVITY log — the stored token was reused. **Across a rebuild still untested** |
| §14.7 Manifest id | `"figma-mcp-bridge"` works; storage stable across builds | ✅ **Half answered:** the arbitrary-string id imports and runs (as C-022 predicted). Storage stability *across a rebuild* is still untested |
| `figma_status` | Shows the file, page, user while connected; still answers with the plugin closed | ✅ **Answered:** with a session live it reports file `Untitled`, page `Page 1`, user `<figma user>`, the selection, `pluginVersion`, `apiVersion` and `editorType`. With the plugin closed it answers from the bridge state (`sessions: []`) and exits 0 |
| §14.9 `figma.fileKey` | Not checked here — our manifest omits `enablePrivatePluginApi`, so `file.key` is always `null`. See the [API probe](#api-probe-c-021-c-012-globals-c-025-runtime-shape) | — |

## Step 10 — Hermes registration

> **Superseded the same day:** at the operator's request figma-mcp was removed from Hermes (`hermes mcp remove figma-mcp`; its old-build bridge process stopped) and registered in Claude Desktop instead — see [Any AI app](#any-ai-app-not-locked-to-hermes). What follows stays as evidence about Hermes as one MCP client among several.

Done on 2026-10-07 with Hermes v0.21.5:

```bash
hermes mcp add figma-mcp --command node --args <repo>/dist/server.js
```

```bash
hermes config set mcp_servers.figma-mcp.timeout 3600
```

```bash
hermes mcp test figma-mcp
```

| Observation | Result |
|---|---|
| `hermes mcp add` | Discovers the tools by connecting first, then asks "Enable all 1 tools? [Y/n/select]". With no TTY the prompt reads EOF and **cancels without saving** — answer it (`printf 'Y\n' \| hermes mcp add …` when scripting). Saved as the fifth entry, tools: all |
| `hermes config set mcp_servers.figma-mcp.timeout 3600` | **Accepted** (spec §14.4, first half). `hermes config get mcp_servers.figma-mcp` shows `timeout: 3600` as a number, beside `command`, `args`, `enabled: true` — no per-tool allowlist, so tools added in later phases are picked up automatically |
| `hermes mcp test figma-mcp` | Connected over stdio in 1269 ms; 1 tool discovered (`figma_status`) |
| Does Hermes send `notifications/cancelled` when its tool timeout fires? (spec §14.4, second half) | **Yes, by source.** Hermes's venv ships the MCP Python SDK 2.0.0. Its `mcp/shared/dispatcher.py` documents `cancel_on_abandon` — *"Whether abandoning this request (timeout or caller cancellation) sends `notifications/cancelled`. Defaults to `True`"* — and `mcp/client/session.py` leaves it at that default for every method except `initialize`/`server/discover`. Hermes's timeout cancels the call task, which is the caller-cancellation path. So on Hermes a client timeout takes branch (a) of protocol §4: the bridge forwards `cancel{CLIENT_CANCELLED}` and the plugin stops at its next yield with a partial result. Not yet exercised end-to-end — Phase 0 registers no long-running tool |

Consequence worth carrying into Phase 2: on Hermes, a timed-out `create_from_spec` **stops** rather than finishing in the background, and a retry with the same key replays the *partial* result. Raising `timeout` (done above) is what makes long specs finish; the key only guarantees nothing runs twice.

## Claim verification

Step 3 ran on 2026-10-07: one verifier subagent, separate context, report-only, under the [verification contract](../../agents/claim-verification.md), over C-012, C-013, C-021, C-025. The registry is locked and changes to it are the owner's call, so nothing below has been applied — these are **proposals**.

| Claim | Verifier's status | Key evidence | Proposal for `claims.md` |
|---|---|---|---|
| C-012 (sandbox timers / fetch) | **still contradiction — wider** | Against: how-plugins-run (*"setTimeout … not directly available"*). For: frozen-plugins (`setTimeout(…, 1)`), `figma.closePlugin` (*"any setTimeout or setInterval timers will be cancelled"*), `saveVersionHistoryAsync` example (`setTimeout(r, 1000)`), and `@figma/plugin-typings` 1.141.0 `index.d.ts` lines 22–27 declaring global `setTimeout`, `setInterval`, `fetch`. The Global Objects page documents a sandbox `fetch` | Keep the status, which spike 1 must test; add the three pages and the typings lines to Source; widen the note to cover `fetch`; re-stamp 2026-10-07 |
| C-013 (microtask yield) | **still to-verify** | HTML spec: a microtask checkpoint drains the whole queue before the next task — a **browser-host** rule. ECMA-262 §9.5 Note 1: hosts *"are not required to treat Jobs uniformly with respect to scheduling"*. No Figma page describes the sandbox host | Keep to-verify. Cite the HTML spec as browser behaviour and ECMA-262 as "host-defined". Spec §5.5 Limit 1 and ADR #22 say "by JavaScript semantics … almost certainly wrong": reword to "by HTML event-loop semantics; the Figma sandbox host is undocumented". The decision (B by default) stays sound because it is conservative |
| C-021 (`figma.fileKey`) | **changed → contradiction** for dev plugins | api/figma: *"Only private plugins and Figma-owned resources … need to specify enablePrivatePluginApi"* vs manifest: *"Setting this will also enable local plugins to work with these APIs during development."* Private plugins are an Organization/Enterprise feature | Reword to name both documented cases; add the manifest URL; keep it open until the probe (below) runs on the operator's real plan. Low impact — spec §14.9: no feature depends on it |
| C-025 (no undo event) | **changed → verified**, scoped to the documented API in typings 1.141.0 | `ArgFreeEventType` has no undo event; `NodeChange = CreateChange \| DeleteChange \| PropertyChange` with no undo marker; `DocumentChange.origin` is only `LOCAL` / `REMOTE`; the typings for `removed` list *"The user triggered an undo action"* beside an ordinary delete | Promote to verified with those quotes, stamp 2026-10-07. Separately, spec §5.6.3: the plugin's writes, the user's edits and the user's Ctrl+Z are all `LOCAL`, so filtering by "ids the op touched" also hides user edits/undos on those nodes — `concurrentEdits` **undercounts by construction**; the spec should say so |
| NEW — "a message from the iframe gives the editor a turn" (option B yields) | **to-verify** (no source found) | how-plugins-run says only that the two sides communicate by message passing | Add as a new to-verify claim: it underpins ADR #22 and §5.5, which call option B "guaranteed". Until spike 1 reports, that word should read "expected" |

Two findings were about **this implementation** and are fixed:

1. `src/plugin/tsconfig.sandbox.json` claimed `setTimeout` was absent from the sandbox types. It is not — the typings declare it — so the compiler cannot enforce "nothing depends on `setTimeout` before spike 1". The comment now says so, and `test/sandbox-globals.test.ts` enforces the rule on the source (no direct `setTimeout`/`setInterval`/`fetch` calls; the only timer access is `chunk.ts`'s feature-detected option A; the default stays B). `test/plugin-bundle.test.ts` already enforces it on the built bundle.
2. The C-021 check planned in step 9 ("read `file.key` in `figma_status`") could not test the claim: our manifest does not set `enablePrivatePluginApi`, so it would report `null` whatever the truth. It is replaced by `spikes/probe/` (below), which sets the flag in a separate plugin so the main plugins are not put at risk if Figma refuses that manifest.

Comments that called option B a guaranteed yield (`src/plugin/chunk.ts`, `spikes/yield/code.js`) now say "expected, not documented; spike 1 measures it".

Process note: the verifier disclosed that it broke its no-write rule by saving six raw copies of Figma doc pages into the session's temporary scratchpad (outside the repo). The repo was untouched; the copies were deleted.

## API probe (C-021, C-012 globals, C-025 runtime shape)

1. Import `spikes/probe/manifest.json` and run **figma-mcp API probe** on any file. If Figma refuses the manifest because of `enablePrivatePluginApi`, record that — it answers C-021 for this plan.
2. Press **Mark: edit** and move a shape; press **Mark: undo** and press Ctrl+Z once.
3. Copy the JSON. It records: whether `figma.fileKey` is present (presence and length only, never the key), `typeof` for every contested global plus the sandbox's full global list (the inspection how-plugins-run itself recommends), and each `nodechange` with its keys, `id`, `origin`, `type` — so the undo's shape can be compared with the edit's.

**Ran 2026-10-07** on Figma desktop 126.9.11 (user agent: Chrome 150.0.7871.250, Electron 43.7.7). Raw report: `spikes/results/probe.json`; connection log: `spikes/results/connections.json`.

| Question | Result (measured) |
|---|---|
| Manifest with `enablePrivatePluginApi` accepted for a dev plugin? | **Yes** — imported and ran |
| `figma.fileKey` present? | **Yes** — a 22-character string (key itself not recorded). The manifest page's "local plugins … during development" is right for this plan; C-021 resolves in its favour |
| `typeof setTimeout` / `setInterval` / `fetch` in the sandbox | **All `function`** (also `clearTimeout`, `clearInterval`, `atob`, `btoa`, `alert`, `console`). How-plugins-run's "not directly available" is wrong for this version. Whether `setTimeout` *yields* is spike 1's job |
| `structuredClone` / `queueMicrotask` | **Both `undefined`** — although how-plugins-run lists `structuredClone` among the sandbox's standard APIs. Another documentation mismatch |
| Sandbox engine | The global list includes `InternalError`, which is QuickJS-specific: the sandbox is not a browser event loop, so C-013 cannot be settled by the HTML spec |
| Does a `nodechange` carry `id` and `origin`? | **Yes** — keys `id`, `origin`, `type`, `properties`, `node`. The typings are right; the NodeChange web page is incomplete |
| Is the Ctrl+Z change distinguishable from the edit? | **No difference in shape**: after the undo marker every change is `PROPERTY_CHANGE`, `origin: "LOCAL"`, properties `relativeTransform`/`x`/`y` — identical to the drag that preceded it. Caveat: the probe stops at 12 changes and the drag produced many, so individual entries cannot be attributed to the Ctrl+Z itself. Consistent with C-025 |
| `allowedDomains` forms (spec §14.2) | **IP-literal rejected** at import: *"Manifest error: Invalid value for allowedDomains. 'ws://127.0.0.1:38452' must be a valid URL."* **`ws://localhost:38453` accepted.** The bridge plugin and the yield spike now use `["*"]` + `reasoning` — the fallback spec §14.2 prescribes |
| Origin the iframe sends (spec §14.2) | **`"null"`** — as the bridge's Origin filter expects |
| What `localhost` resolves to | **`::1` first** — the probe's connection arrived on the IPv6 listener. The bridge listens on `127.0.0.1` only, so narrowing the bridge plugin from `"*"` to `ws://localhost:38452` would also need an IPv6 listener (or proof that Chromium falls back to IPv4) |

## Locked documents

**Updated on 2026-10-07 with the operator's approval** (unlocked, edited, re-locked per AGENTS.md — `lock-docs --update` reported exactly these four files): README, spec, `current-state.md`, `tools.md` no longer read as Hermes-first. Spec Goal 5 is now "client- and model-agnostic"; the architecture diagrams say "any MCP client"; §4.2/§4.6, ADR #4/#26 and the new ADR #30 describe hub / proxy sharing; the README quickstart and spec §5.8 register with any client and point to `docs/clients.md` (now in the README's Documentation table); tool trimming refers to "the client's tool picker"; current-state §4 records where figma-mcp is registered and corrects the Node note (v26.7.0 is Hermes's bundled Node, not a wrong reading). Measured facts *about* Hermes as one client — its 300 s timeout, Tasks support, CLI syntax — are kept, as they are still true.

Still out of date — not part of that approval, listed for the owner:

- ~~`AGENTS.md` § Status and the README status line still say "no running code yet / Phase 0 has not started".~~ **DONE 2026-10-07** (3dc716e, owner's go-ahead): both now describe Phases 0–2; the AGENTS.md line, which had been cut off mid-word since 60d3e05, is whole again. Phases 1–2 continue in the [Phases 1–2 log](2026-10-07-phases-1-2-log.md).
- Spec §4.5 layout lists `peer.ts` now, but not `frames.ts`, `version.ts`, `tools/forward.ts`, `messages.ts`, `tools/build.mjs`.
- Spec §9 shows the narrow `allowedDomains` entries Figma rejects; the manifest uses `["*"]` per §14.2.
- `claims.md` C-032 still says the "v26.7.0" note "was wrong" (see the corrected current-state §5); C-012/C-013/C-021/C-025 and the new to-verify claim await the proposals in [Claim verification](#claim-verification) and the probe's results.
- ~~`scripts/check-docs.mjs` and `scripts/check-claims.mjs` print their summaries in Indonesian~~ **DONE 2026-10-07**: both checkers translated to English (comments, output, and the Indonesian detector words inside their regexes). Swept the whole repo by byte-level scan: zero CJK, zero remaining Indonesian outside this line and the temporary scan scripts.
- `scripts/.hermes-tmp.aYnRow` is an empty, tracked temporary file inside the locked `scripts/` folder.
