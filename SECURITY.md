# Security Policy

## Supported versions

Only the latest release of `figxel-mcp` gets security fixes. With the recommended client entry, `npx -y figxel-mcp@latest`, your AI app picks up a fix the next time it starts the server.

| Version | Supported |
|---|---|
| Latest release (0.1.x) | Yes |
| Anything older | No: update first |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's private vulnerability reporting on the repository:

<https://github.com/AvYour/figxel-mcp/security/advisories/new>

Include the Figxel version (`bridge.version` in `figma_status`), your operating system, the AI app you used, the steps that show the problem, and what an attacker could do with it. Remove personal data you do not need to share: your Figma user name and id, file names, and paths that contain your user name.

The maintainers will acknowledge the report, keep you informed while they work on a fix, and credit you in the release notes if you wish. This is a volunteer project, so please allow reasonable time for a fix before you disclose the problem publicly.

## Threat model in brief

Figxel is a local server: your AI app starts it on your machine, and the Figxel plugin in Figma desktop connects to it. The full analysis is in [spec §9](docs/superpowers/specs/2026-10-06-figma-mcp-design.md#9-security) and [protocol.md §7](docs/reference/protocol.md#7-protocol-security-notes).

**What Figxel defends against:**

- **Other machines.** The bridge binds only to `127.0.0.1:38452`; there is no option to listen on another address.
- **Other local programs and web pages.** A connection must present the token in its first message within 5 seconds, or it is closed. The token is 32 random bytes (64 hex characters) in `~/.figxel/token`, mode 0600 on macOS and Linux, and it is compared in constant time (SHA-256 of both sides, then `timingSafeEqual`). Other Figxel processes that share the connection present the same token.
- **Web pages in a browser.** A WebSocket upgrade whose `Origin` is anything other than absent or `null` is closed (code 4003). This is defence in depth only: Figma's plugin iframe has origin `null` `[C-018]`, as other plugins do, so the token is the real gate.
- **Writes outside the folders you allow.** The plugin never writes files. The server writes exports only inside `BRIDGE_EXPORT_DIR` (default `~/.figxel/exports`) or a folder listed in `BRIDGE_EXPORT_ROOTS`, checked on the path as written and again after resolving symbolic links; anything else is refused with `INVALID_PARAM`. `figma_review_video` reads videos only from inside the same roots.
- **Arbitrary code by default.** `figma_eval`, which runs Plugin API JavaScript in your open file, is off unless `BRIDGE_ALLOW_EVAL=1` is set and the toolset includes the `eval` group. Each call is logged with the code's length and SHA-256.
- **Leaks through logs.** The token is never sent to the AI app and never logged; `figma_status` shows only its path. Parameters of write calls, which may hold your content, are not logged by default.

The plugin's manifest allows network access to `*`, because Figma rejects an IP-literal entry such as `ws://127.0.0.1:38452` `[C-060]`. The plugin's code connects only to the loopback address.

**What Figxel does not defend against:**

- **Programs running as your user.** They can read the token file, as they can read your other files.
- **The agent itself.** Figxel gives the agent the tools you registered, including deleting layers in your open files. Each tool call is one undo step in Figma, and destructive tools carry MCP's `destructiveHint`, so an app with an approval mode can ask you first. Trim the toolset with `BRIDGE_TOOLSET` if you want fewer powers.
- **Instructions hidden in content.** The agent reads layer names and text from your files. Text in a file you did not make can try to steer the agent; review what it does with files from others.
- **Your AI app and its model provider.** What the agent reads is sent to the model provider your app uses; see the README's [Privacy](README.md#privacy) section.
