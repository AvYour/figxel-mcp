# The host restarted the hub after its calls timed out (2026-10-13)

Evidence for `[C-271]`. A render the live-review spike was waiting for (as a proxy) was lost when the hub's process exited. The hub did not crash: the Claude desktop app, which runs figma-mcp over stdio for this Claude Code session, closed its stdin about 2 s after three of its tool calls timed out.

## Timeline (UTC)

From the Claude Code transcripts of the session (tool results with their timestamps):

| Time | What |
|---|---|
| 09:24:56.8 | figma_status: role hub, hubPid 15688, uptime 41 s |
| 09:26:25.3 | figma_status: role hub, hubPid 15688, uptime 130 s |
| 09:27:49.3 | three tool calls answer "Request timed out" (they waited silently behind a video render) |
| 09:27:51.5 | figma_status: role **proxy**, hubPid **48304**, uptime **0** s — a new server, and a new hub |
| 09:28:57.4 | two tool calls answer "Request timed out" |
| 09:29:31.5 | figma_status: role proxy, hubPid 48304, uptime 32 s — the server was replaced again at about 09:28:59 |

STALLED answers at 09:28:27 and from 09:29:29 to 09:30:29 never caused a restart. Whether a single timed-out call is enough to cause one is not known.

## The desktop app's server log

`%LOCALAPPDATA%\Claude\logs\mcp-server-figma-mcp.log`, lines 1939-1957, read 2026-10-14. These stderr lines carry no timestamps; their order matches the timeline above.

```
1939: [figma-mcp] info: session s-1 connected: "Untitled" (plugin 0.1.0)
1940: [figma-mcp] info: session s-1 ended: plugin disconnected (likely closed)
1941: [figma-mcp] info: session s-2 connected: "Untitled" (plugin 0.1.0)
1942: [figma-mcp] info: hub: figma-mcp process 45716 (0.1.0) is sharing this Figma connection
1943: [figma-mcp] info: shutting down (stdin closed)
1944: [figma-mcp] info: hub: figma-mcp process 45716 stopped sharing
1945: [figma-mcp] info: proxy: the hub exited — racing for the port
1946: [figma-mcp] info: hub: listening on ws://127.0.0.1:38452
1947: [figma-mcp] info: hub: figma-mcp process 45716 (0.1.0) is sharing this Figma connection
1948: [figma-mcp] info: hub: figma-mcp process 5416 (0.1.0) is sharing this Figma connection
1949: [figma-mcp] info: proxy: sharing the Figma connection of figma-mcp process 48304
1950: [figma-mcp] info: figma-mcp 0.1.0: toolset full, 132 tool(s) registered
1951: [figma-mcp] info: removed the draft-07 $schema from 131 tool schema(s); the Anthropic API rejects schemas that declare that dialect (schema-dialect.ts)
1952: [figma-mcp] info: session s-1 connected: "Untitled" (plugin 0.1.0)
1953: [figma-mcp] info: hub: figma-mcp process 45716 stopped sharing
1954: [figma-mcp] info: shutting down (stdin closed)
1955: [figma-mcp] info: hub: figma-mcp process 5416 stopped sharing
1956: [figma-mcp] info: hub: figma-mcp process 25344 (0.1.0) is sharing this Figma connection
1957: [figma-mcp] info: proxy: sharing the Figma connection of figma-mcp process 48304
```

- 1943: hub 15688 shuts down because its stdin closed — no stack trace, no `fatal` line.
- 1944: its exit closes the spike's peer socket (process 45716), and with it the render the spike was waiting for.
- 1945-1949: 48304 wins the port and becomes the hub; the spike (45716) and the desktop app's new server (5416) join it.
- 1954: 5416 is closed the same way after the second pair of timeouts; 25344 replaces it.

## What it changed

The calls timed out because they sat silently in the bridge's queue behind a minutes-long render, past the client's 60 s timeout `[C-197]`. Since then, a call that would wait behind a render answers `BUSY` at once and is never sent (`src/server/bridge.ts` `renderBusyError`, pinned by `test/busy-render.test.ts`), so the client has nothing to time out on.

Not fixed: a hub that exits still takes its proxies' in-flight renders with it, and a plugin still busy with an op from an earlier hub cannot say so (only the plugin knows; that needs a plugin and protocol change).
