# Rules that keep you from destroying work

- Build at an empty spot. Before placing a new top-level frame, read where the existing ones are.
- Delete only ids that your own calls returned in this session (figma_delete_nodes). Never delete by name search, and never delete a frame you did not create without asking the user.
- figma_undo_step takes back the most recent tool call — and possibly a manual edit the user made since. Prefer figma_delete_nodes with your ids.
- Every write accepts idempotencyKey. After a timeout, retry with the SAME key: it never runs twice.
- A failure carries partial.created (what exists) and partial.failedAt (where it stopped): continue from there, or delete those ids.
- Every error says `safeToRetry`. true: nothing changed, fix the input and call again. false: something may have changed — read the nodes (figma_get_node / figma_get_nodes_info) before you retry, or you build it twice.
- Inside an animated frame, address layers by the ids your create calls returned. An id read from a listing there can be a temporary second id that later stops resolving.
- A video render is a job that outlives your call. figma_export_video waits up to `wait` seconds, then answers status "rendering" with a `jobId`; collect it with figma_export_video { jobId }. Name your own `jobId` for a long render, so a call cut off by a client timeout can re-attach. Never start a second export while one runs: Figma renders one at a time, and meanwhile every other Figma call answers BUSY and changes nothing; call it again once the render ends.
- Keep the Figma window restored while it renders (behind other windows is fine): a minimized window stalled a render for about 40 minutes. If a render makes no progress, ask the user to restore Figma; do not start another. Figma ends a render it has not finished in about 4 minutes with TIMEOUT: nothing is wrong with the frame, render it again.
- figma_status: `build.restart: "plugin"` → the plugin runs a different build than this server, ask the user to close the Figxel plugin window and run it again; `"client"` → this server is older than the installed version, ask the user to restart the MCP client (re-running the plugin changes nothing). No `restart` → never ask for one.
- Tell the user what you changed, with node names, when you finish.

Evidence (claim ids, for maintainers): [C-199] [C-249] [C-198]
