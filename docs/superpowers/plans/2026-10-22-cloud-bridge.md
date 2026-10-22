# Cloud bridge (0.3.0)

Status: **released in 0.3.0 on 2026-10-22**, phases A, B and C live through `mcp.figxel.moirelabs.dev` (claude.ai, ChatGPT and the plugin); Figxel Cloud is by invitation. Planned as 0.4.0, released as 0.3.0, the next number after 0.2.1. Proposed and approved the same day.

## Goal

In the owner's words: the bridge runs in the cloud, not locally as now; exports and imports still land on each person's own machine; the owner and the team use it first; and every client can use it, web clients included. Public sign-up comes later.

```
AI app on a laptop ──▶ npx figxel-mcp (laptop: tools, files, ffmpeg) ──┐
An agent on the server (optional) ──────────────────────────────────────┤
Web client (claude.ai, ChatGPT) ──▶ https://mcp.figxel.<team domain>/mcp ┼──▶ hub ◀── plugin in Figma desktop
  (no disk: the server's web peer runs the tools, files come back as links)│
```

Nothing on a laptop listens any more: the plugin and every MCP process connect out to the hub, and the hub pairs a person's agents with that person's Figma.

### Who reaches it how

| Client | Path | Sign-in |
|---|---|---|
| Claude Code, Codex, Cursor, VS Code, Gemini CLI, Claude Desktop with a local server | `npx figxel-mcp` with `BRIDGE_HUB_URL`: files on the laptop | the person's token |
| Any agent running on the server (optional, e.g. one reached from a chat app) | a local peer on the server | the person's token |
| claude.ai and Claude Desktop custom connectors | the HTTP endpoint | the token as a request header, or OAuth `[C-406]` |
| Cursor, VS Code, Claude Code by URL | the HTTP endpoint | the token as a header |
| ChatGPT developer mode | the HTTP endpoint | OAuth only `[C-407]` |

## What already works

A code map of 2026-10-22 (file:line in the repository at release/figxel 2c0f98f) found:

- **Files already stay local.** Every tool handler, every file write (`saveTo`, the auto-saved large exports, PDFs, video and its stills, screenshots, downloaded assets) and ffmpeg run in the process the MCP client talks to; only `bridge.request` crosses to the hub, which re-frames bytes and never writes (src/server/tools/forward.ts:295-311, src/server/bridge.ts:860-893). With a remote hub, files land on the laptop that asked, and an agent on the server writes to the server.
- **Large results already travel in chunks** to a peer that offers `result-chunks` (6 MiB per frame, bridge.ts:364-369, 860-875).
- **The manifest already allows the domain.** `networkAccess.allowedDomains: ["*"]` (src/plugin/manifest.json:17-22) permits a `wss://` host; only its `reasoning` text must change.

## What changes

1. **The plugin's server address becomes a setting.** Today it is a constant, `ws://127.0.0.1:38452` (src/plugin/ui.ts:19). It moves to `clientStorage` beside the token, with a field in the plugin window; empty means local, as now. The copy setup refreshes in `~/.figxel/plugin` stays generic: the address is never baked into it.
2. **A hub mode: `figxel-mcp hub`.** A pure relay on the server: it binds `127.0.0.1` there behind Caddy, registers no MCP tools and has no stdio transport, so nothing it runs writes files. It reads a token table instead of one token file: one entry per person, stored as a hash.
3. **A peer of a remote hub: `BRIDGE_HUB_URL`.** Set to `wss://mcp.figxel.<team domain>`, a local process never binds the port and never elects itself hub (risk 1 below); it dials the URL over TLS, reconnects with backoff instead of racing for a port, and uses internet timeouts for the handshake. Its token comes from `BRIDGE_TOKEN` or the person's token file.
4. **One person, one boundary.** The hub learns who a socket is from the token in `hello` (plugin) or `peer-hello` (peer). A plugin session is owned by that person; a peer lists, selects, waits for and addresses only its own person's sessions; idempotency keys and render timers are kept per person; a refusal reveals nothing about another person's files, nor the hub's pid or token path.
5. **A heartbeat on every socket** well inside Cloudflare's idle window `[C-405]`: the plugin's 15 s heartbeat stays, and peer and hub ping each other every 30 s (today the peer socket has none).
6. **Origin.** The rule stays (no Origin, or `null`, which is what the plugin's iframe sends). The setup guide says Caddy and Cloudflare must not add an Origin header, and a health check must accept the hub's `426` answer to plain HTTP.
7. **Versions.** The peer protocol gets a version range instead of one pinned number, so updating the hub does not lock out peers one release behind; the build-id advice in `figma_status` names the hub's operator instead of "restart the MCP client".
8. **An HTTP endpoint for clients without a local process.** A web peer on the server, beside the hub, serves MCP over streaming HTTP at `/mcp`, the transport claude.ai and ChatGPT both speak `[C-406]` `[C-407]`. It runs the same tools as a local peer, as the person its sign-in names. Small images come back inline as now; a file it would have written (a large export, a PDF, a video) goes to a per-person folder on the server and comes back as a short-lived download link; an import takes a URL, or a file uploaded first to the same endpoint. Files are deleted after a short time.
9. **Sign-in for the HTTP endpoint.** First the person's token as a request header, which claude.ai's connectors, Cursor, VS Code and Claude Code accept `[C-406]`. Then OAuth for ChatGPT, which accepts nothing else `[C-407]`: the hub becomes an OAuth authorization server with its metadata, Dynamic Client Registration and Client ID Metadata Documents, PKCE, and a sign-in page where a team member proves who they are with their token; the access token it issues names that person, so isolation works the same way as for a peer. Both callbacks are registered: claude.ai's hosted one and a loopback one for local clients `[C-406]`.

## Security

Four conditions before anyone uses the hub, agreed with the owner on 2026-10-22:

1. Isolation between persons is built and passes a live test with two people.
2. The hub's subdomain is DNS-only at Cloudflare, not proxied: TLS ends at Caddy on the server, so Cloudflare never sees design data, and its idle and message limits do not apply `[C-405]`. The heartbeat stays for NAT and proxies on the way.
3. The hub runs as a non-root user in a container of its own on the shared server.
4. A person's token can be revoked at once, and the plugin window says which hub it is connected to and as whom.

On a public endpoint the token is the only gate, so: 256-bit tokens, hashed at rest, compared in constant time (as today); failed handshakes rate-limited (not yet built); logs keep ids and timings, never design content; the hub reachable only by Caddy, which terminates TLS (loopback, or a container network with no published port). Spec principle 4, "Local & safe — loopback only", is amended for hub mode by a new ADR (#44) rather than dropped: the local mode stays the default and unchanged.

## Not in 0.3.0

Public sign-up. The person table is built so it can become accounts later, with its own sign-in in place of the token.

## Work order

Three phases; the team can use each on the server as soon as it lands, and 0.3.0 is released when all three pass their live runs.

**Phase A: the bridge in the cloud (local apps, and any agent on the server).**

1. The plugin's address setting, with its tests (ui.ts, code.ts, messages.ts, ui.html).
2. Ownership in the session registry and the hub: person from token, filtering, per-person maps, quiet refusals.
3. `BRIDGE_HUB_URL`: no local election, wss, backoff, peer heartbeat; tests with a hub on a random port and a fake TLS-less URL.
4. `figxel-mcp hub` with its token table and a command to add and remove a person.
5. Deployment on the team's server: a systemd unit, the Caddy route with WebSocket upgrade, DNS at Cloudflare (the owner), tokens for the owner and the team. **As built:** a container instead of a systemd unit, because Caddy runs in a container of its own and cannot reach the host's loopback: the hub listens on that container network (`BRIDGE_HUB_BIND`), publishes no port, runs as uid 1000 with a read-only root, no capabilities and 256 MB; the route sets `stream_close_delay` because a Caddy reload otherwise closes every WebSocket `[C-408]`. Steps 1-4 were checked first through an SSH tunnel with spikes/live-hub.mjs (a mock plugin and a real process: welcome names the person, status shows only the person's file, a call goes through and back in about 185 ms, a stranger's plugin and process are refused and learn nothing). [docs/hub.md](../../hub.md) is the operator guide.

**Phase A live runs, 2026-10-22**, through wss://mcp.figxel.moirelabs.dev (Caddy, Let's Encrypt, DNS-only, so not through Cloudflare's proxy):

- a mock plugin and a real process held idle for 30 minutes stay connected, and a call afterwards goes through (spikes/results/live-hub-idle.json);
- two people: each status lists only its own file, the other's file by name reads as one that does not exist, neither plugin receives the other's calls (live-hub-two.json);
- a stranger's plugin and process are refused and learn nothing; removing a person closes their connected plugin with 4001 about 2 s later;
- a 23.5 MiB video rendered in the owner's real Figma reaches the laptop through the hub, bytes equal (live-hub-export.json, 114 s, mostly the render);
- the owner's real plugin connected through the hub once the laptop's router dropped a cached NXDOMAIN from before the record existed (up to the zone's 30-minute negative TTL).

Done after the live runs, the same day: a limit on refused tokens per address (20 in 10 minutes turns it away for 15); version skew checked rather than a version range, since the peer protocol already stays at 1 and adds features, and a hub now keeps a newer write op's key and guard; a leak found and fixed, where a refusal for a file's editor named another person's connected files; and invites, after the owner found the setup impractical: `hub add` prints `wss://hub#token` (with BRIDGE_HUB_PUBLIC_URL), the plugin's Team hub field takes it, and `figxel-mcp join` saves it in `<home>/hub.json` for every AI app on the computer (`leave` forgets it). Still to do for Phase A: the two-person test with a second real person.

**Phase B: the HTTP endpoint with a token header (claude.ai, Cursor, VS Code, Claude Code by URL).**

6. The web peer on streaming HTTP, signed in by the token header, as one person.
7. Download links and uploads: the per-person folder, short-lived links, URL and upload imports, cleanup.

**Phase B built and deployed, 2026-10-22** (src/server/web.ts, test/web.test.ts, docs/hub.md § Web clients, protocol.md §12): `BRIDGE_HUB_WEB=1` serves MCP over Streamable HTTP at /mcp in the hub process; each session is createApp with a Bridge joined to the hub over loopback as the bearer token's person, its tools confined to `<home>/web/<person>`; results get `downloads` links (an hour); POST /files uploads. Live through https://mcp.figxel.moirelabs.dev/mcp with the owner's real Figma (spikes/results/live-hub-web.json): a wrong token 401; initialize 576 ms; 140 tools; status names the web endpoint; a frame exported in 2.6 s came back as a link that served the PNG. Still to do: claude.ai with the header and Cursor or VS Code by URL, each building one frame (the owner's accounts).

**Phase C built and deployed, 2026-10-22** (src/server/oauth.ts, test/oauth.test.ts): the hub is its own authorization server [C-414], with Protected Resource Metadata, RFC 8414 metadata, Dynamic Client Registration and Client ID Metadata Documents (fetched over https from public addresses only, checked at connect time), PKCE S256, exact redirects, a sign-in page that names the app and its return host, `fxa_` access tokens (an hour, in memory) and rotated `fxr_` refresh tokens (30 days, hashed in hub-oauth.json). A grant stands for the person's table entry, and a web session joins the hub with a credential of its own (Bridge.sessionToken), so removing the person ends both. Live through the domain (spikes/results/live-hub-oauth.json): nine checks from the 401 to a rotated refresh, and an MCP call with the access token reached the owner's Figma. Still to do: ChatGPT and claude.ai themselves, each building one frame (the owner's accounts).

**A cold security review of the cloud diff, 2026-10-22, and its fixes.** High: a download link could be minted for `<folder>/../<other person>/…` from text a tool echoed (a layer name); links now resolve `..` and symbolic links and are checked again when served (test/web.test.ts reproduces it). Medium: another person's plugin presenting the same window id replaced a person's session (the registry now matches person and window); open registration could evict working clients (limited per address, eviction only of clients with no live grant); client-document fetches were unlimited and missed NAT64, 6to4, IPv4-compatible and reserved ranges (limited, capped, ranges added); phishing through a self-registered client (the return host in large type, `BRIDGE_HUB_REDIRECT_HOSTS`). Low: oversized OAuth bodies now get 413; a web session's status no longer shows its internal address or credential's fingerprint; web sessions of a removed person are closed. Found live the same day: the hub could not fetch claude.ai's client document (Node asks a DNS hook for all addresses; the hook answered one); fixed, and claude.ai's id now opens the sign-in page.

**Sign-in with Figma or Google, 2026-10-22** (the owner: "like MCP servers in general"; Figma and Google both, invites kept as the other way in). claude.ai passes no identity to a connector, so the hub signs people in itself: Figma through a private OAuth app, which admits its own team without review [C-415]; Google for the verified emails the operator lists, or anyone with BRIDGE_HUB_SIGNUP=open [C-418]. A sign-in is the person with that verified email (`hub email`), so an invite's person and their account are one. The plugin signs in through the browser with a device flow (`/device/code`, `/device`, `/device/token`) and gets a credential of its own, persisted hashed and ended with the person [C-417]. Anthropic offers no sign-in with Claude for outside apps; OpenAI's "Sign in with ChatGPT" was reported but not checked against its docs, so it is not offered. Tests: test/login.test.ts, the plugin's browser sign-in in test/plugin-bundle.test.ts.

**Figxel Cloud as the plugin's first way in, 2026-10-22.** The owner, testing as a new user, found typing the hub's address too much for the public. Reversing "the address is never baked into it" (What changes, item 1): the plugin opens on Welcome to Figxel with one Sign in button that signs in to `wss://mcp.figxel.moirelabs.dev` (server-url.ts CLOUD_URL) through the browser; this computer's server is one click away, another hub's address goes in through Change, and Reset forgets everything. Sign-up stays closed (team mode) until the owner opens it; a public Figma OAuth app needs Figma's review [C-415].

**Phase C: OAuth (ChatGPT, and claude.ai without a header).**

8. The authorization server: metadata, Dynamic Client Registration, Client ID Metadata Documents, PKCE, the sign-in page, tokens bound to a person; both callbacks.

**Throughout.** Docs: ADR #44 in the spec, protocol.md (peer ping, person, the HTTP endpoint), configuration.md (`BRIDGE_HUB_URL`, `BRIDGE_TOKEN`, the hub's settings), clients.md (connecting each client to a hub), troubleshooting.md; a claim for every external fact first.

**Live runs before release:** a plugin and a peer idle for 30 minutes through Cloudflare stay connected; a 25 MB video export reaches the laptop in chunks through Cloudflare, and reaches a web client as a link (whether Cloudflare limits a WebSocket message's size is not documented and is measured here); two people on one hub cannot see each other's sessions, by peer, by header or by OAuth; claude.ai with a header and ChatGPT with OAuth each build one frame end to end.

## Risks the code map named

1. Election is still "bind the port to become hub" (bridge.ts:479-506): a remote address without a hard "never bind" mode would make the first local process a second hub that the plugin never reaches. Step 3 removes the election in that mode.
2. No tenant boundary exists (one token hash, bridge.ts:447; a global session registry, src/server/sessions.ts:34-36; the hub-wide status to any peer, bridge.ts:918-919). Step 2 comes before anything is deployed.
3. An Origin header added by a proxy closes every plugin with a terminal 4003 (bridge.ts:706-711), and idle peer sockets die behind Cloudflare unnoticed until a call. Steps 5 and 6 of "What changes" cover both.
