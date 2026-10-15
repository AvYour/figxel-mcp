# Troubleshooting

Known problems with their fixes, and the details behind the README's [Privacy](../README.md#privacy) notes.

Ids such as `[C-286]` point to the [claim registry](reference/claims.md), where each external fact has its source and the date it was checked.

## Problems and fixes

- **"No Figma plugin is connected" (`NO_SESSION`).** Run the plugin in Figma: **Plugins → Development → Figxel**. If it is not in that menu, quit Figma completely and run `npx -y figxel-mcp@latest setup --register` `[C-323]`, or run `npx -y figxel-mcp@latest setup` and import the manifest it prints `[C-274]`.
- **"Its token does not match".** Run setup again, which prints the token and its fingerprint, and paste the token into the Figxel plugin window, then press **Save**. The window shows the fingerprint of the token it saved, and `figma_status` shows the server's (`token.fingerprint`).
- **The plugin says "Connected" but your app says the token does not match, or `PORT_IN_USE`.** Two servers with different token files are running, and the plugin is connected to the other one. `figma_status` names that server's process and token file. Close the other app, or run setup in the same environment as your app (the same user and the same `BRIDGE_HOME`) and restart both.
- **`PORT_IN_USE`.** Another program, or an older Figxel, holds port 38452. Close it; Figxel takes over within 5 s.
- **The server does not start on Windows** (for example `spawn npx ENOENT` in the app's log). Use the `cmd /c npx …` form `[C-281]`. Claude Code does not need it `[C-280]`.
- **Too many tools.** VS Code refuses a request with more than 128 tools `[C-286]` and Windsurf allows 100 `[C-289]`, and Figxel alone registers 133. Set `BRIDGE_TOOLSET` (see [Configuration](configuration.md)) or untick tools in the app.
- **Codex times out on the first start.** Codex waits 10 s for a server to start `[C-287]`, and a first `npx` run has to download the package. Run `npx -y figxel-mcp@latest setup` first: npx keeps the package under the same `figxel-mcp@latest` name the client entry uses `[C-283]`. Or raise `startup_timeout_sec` `[C-287]`.
- **Long calls time out.** Each app has its own tool-call timeout; [docs/clients.md](clients.md#tool-call-timeouts-differ-a-lot) shows how to raise it. A video render answers with a job id before a short timeout and is collected later.
- **A video export stalls.** Keep the Figma window restored, not minimized, while it renders: a render stalled for about 40 minutes while the window was minimized, and Figma ends a render it has not finished after about 240 s `[C-198]`.
- **Every video export times out.** Figma's exporter can get stuck so that every render ends in that limit, small or large; quitting and reopening Figma clears it `[C-318]`. Save your work, quit Figma, reopen it and run the plugin again. `figma_status` counts the timeouts in a row (`videoExport.timeoutsInARow`).
- **Frames are missing after you installed ffmpeg.** Restart your AI app, or set `BRIDGE_FFMPEG` to its full path: a server may still run with the PATH it started with (not yet measured per app `[C-333]`).
- **`figma_status` says `restart: "plugin"` or `restart: "client"`.** Close the Figxel plugin window and run it again, or restart your AI app, as the hint says.
- **macOS.** CI runs the tests on macOS, but nothing has been run live there yet. If something fails, please [open an issue](https://github.com/AvYour/figxel-mcp/issues).
- **Logs.** The server logs to stderr, which your app keeps; Claude Desktop writes `mcp-server-figxel.log` in `~/Library/Logs/Claude` or `%APPDATA%\Claude\logs` `[C-277]`.

## Privacy details

- **Figxel runs on your machine.** The server listens only on `127.0.0.1`, the plugin connects only to it, and Figxel sends nothing to any other service. The agent's edits are ordinary edits in your Figma file.
- **Your AI app sends what the agent reads to its model provider.** That includes file, page and layer names, text content, the images the agent exports to look at, and the Figma user name and id that `figma_status` shows. The plugin asks Figma for the current user (the `currentuser` permission) so that `figma_status` can name who is connected.
- **Tools that take a URL** (`figma_import_image`, `figma_create_link_preview`) hand it to Figma, which loads it `[C-076]`.
- **The token** lives in `~/.figxel/token` (readable only by you on macOS and Linux). The plugin keeps its copy in Figma's plugin storage on your machine, which is not synchronised `[C-276]`. The server never sends the token to your AI app, and never logs it.
- **Exports** go to `~/.figxel/exports`, or to a folder you allow with `BRIDGE_EXPORT_ROOTS`. Nothing is written anywhere else.
- **Before you post `figma_status` output in an issue,** remove your Figma user name and id, file and page names, and paths that contain your user name.
