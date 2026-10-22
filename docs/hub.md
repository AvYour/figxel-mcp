# Running a Team's Hub

A team's hub lets a team's Figma plugins and AI apps meet on a server instead of on each laptop. This page is for whoever runs it; [docs/clients.md § Connecting to a team's hub](clients.md#connecting-to-a-teams-hub) is for the people who use it. The design and its phases are in the [cloud bridge plan](superpowers/plans/2026-10-22-cloud-bridge.md), and the decision in [spec ADR #44](superpowers/specs/2026-10-06-figma-mcp-design.md#13-decisions-adr-lite).

Ids such as `[C-408]` point to the [claim registry](reference/claims.md), where each external fact has its source and the date it was checked.

## What a hub is

```
AI app ──▶ npx figxel-mcp (laptop: tools, files, ffmpeg) ──▶ wss://mcp.figxel.example ──▶ hub (server)
                                                                                           ▲
                                                Figxel plugin in Figma (any laptop) ───────┘
```

- **A pure relay.** `figxel-mcp hub` runs the bridge alone: it registers no MCP tools and has no stdio transport, so it never writes a design file. Every tool, every export and import, and ffmpeg run in the process the person's AI app starts, on their own computer; only the plugin's requests and answers cross the hub.
- **One token per person.** The hub keeps a table of people, each with a token of their own, stored as its SHA-256 only. A plugin or a process that presents a token belongs to that token's person.
- **Each person sees only their own files.** A person's process lists, selects and calls only the Figma sessions their own token opened. Another person's file, asked for by id or by name, gets the same answer as a file that does not exist, and `figma_status` shows a person only their own sessions and processes.
- **Nothing local changes.** A laptop without `BRIDGE_HUB_URL` runs exactly as before, on `127.0.0.1`.

## Before you start

- A server with Docker, and a TLS proxy in front of the hub. This page uses Caddy, which obtains and renews the certificate by itself once the domain's record points to the server and ports 80 and 443 reach it `[C-409]`.
- A subdomain for the hub. At Cloudflare, make its record **DNS only** (grey cloud): traffic then goes straight to the server, TLS ends at Caddy and Cloudflare never sees design data `[C-410]`. Its WebSocket idle close does not apply then `[C-405]`; the hub pings every socket anyway.
- `figxel-mcp` 0.3.0 or later, the first version with `hub`.

## Run it

**1. The package and a folder for the table.** The table must be readable by the container's user only:

```bash
mkdir -p /srv/figxel-hub/data
chown 1000:1000 /srv/figxel-hub/data && chmod 700 /srv/figxel-hub/data
npm install --prefix /srv/figxel-hub/app figxel-mcp@latest
```

**2. The container.** `/srv/figxel-hub/compose.yml`, on the Docker network the proxy is on (here Caddy's, `proxy_default`):

```yaml
services:
  figxel-hub:
    image: node:22-alpine
    container_name: figxel-hub
    restart: unless-stopped
    user: "1000:1000"
    command: ["node", "/app/node_modules/figxel-mcp/dist/server.js", "hub"]
    environment:
      BRIDGE_HUB_BIND: 0.0.0.0
      BRIDGE_HOME: /data
      BRIDGE_HUB_PUBLIC_URL: wss://mcp.figxel.example
      BRIDGE_HUB_WEB: "1"
    volumes:
      - ./app:/app:ro
      - ./data:/data
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    cpus: 1.0
    pids_limit: 128
    networks: [web]
networks:
  web:
    external: true
    name: proxy_default
```

`BRIDGE_HUB_PUBLIC_URL` is the hub's own address as people reach it, so `hub add` can print an invite. `BRIDGE_HUB_WEB` turns on the [web endpoint](#web-clients) for clients with no process on the person's computer; leave it out for a relay alone. It publishes no port: only the proxy, on the same network, reaches it. `BRIDGE_HUB_BIND=0.0.0.0` is for that network; without a container, leave it at its default, `127.0.0.1`, and point the proxy at loopback. Start it with `docker compose up -d`; its log says `hub: 0 person(s) … listening on 0.0.0.0:38452` until you add someone. It uses about 35 MB of memory as a relay; each open web session runs a set of tools, hence the larger limit.

**3. The route.** Add it once the subdomain's record resolves, since Caddy asks for the certificate as soon as the route exists `[C-409]`:

```
mcp.figxel.example {
	reverse_proxy figxel-hub:38452 {
		stream_close_delay 5m
		flush_interval -1
	}
}
```

A Caddy reload closes every WebSocket at once unless the route sets `stream_close_delay` `[C-408]`; with it, connections stay up through a reload, and the plugin and the processes reconnect by themselves when they do close. `flush_interval -1` passes the web endpoint's streamed answers on as they come `[C-408]`.

**4. Check it.** `curl -i https://mcp.figxel.example/` answers `426 Upgrade Required`: that is the hub, which speaks only WebSocket. A health check must accept that answer.

## Web clients

With `BRIDGE_HUB_WEB=1` the hub also answers MCP over Streamable HTTP at `https://mcp.figxel.example/mcp`, for claude.ai and for apps pointed at a URL ([docs/clients.md § Apps by URL](clients.md#apps-by-url)). It needs `BRIDGE_HUB_PUBLIC_URL`, from which it makes download links.

- **Sign-in** is the person's own token, `Authorization: Bearer <token>`, on every request, or OAuth. A wrong token gets `401` and counts toward the same per-address limit as a refused plugin.
- **OAuth** is for clients that accept nothing else, such as ChatGPT `[C-407]`: the hub is its own authorization server `[C-414]`. The client registers itself (or is known by its metadata document, fetched only from a public address), opens the hub's sign-in page, where the person sees which app is asking and where it returns, and pastes their invite. The app then holds an access token for an hour and a refresh token for 30 days, never the invite. A grant stands for the person's entry in the table: removing them, or giving them a new invite, ends it at once. Registered apps and refresh tokens, as hashes, are kept in `<home>/hub-oauth.json`. Registration is open, as OAuth clients expect, so it is limited: 20 per address an hour, and a full table makes room only from apps nobody is signed in with. `BRIDGE_HUB_REDIRECT_HOSTS` (for example `claude.ai,chatgpt.com,localhost`) narrows the hosts an app may return to; the sign-in page shows that host in large type either way.
- **Each web session** runs the same tools a person's own process runs, joined to the hub as that person with a credential of its own (never the person's token): it sees only that person's Figma, as a laptop does. A session id works only with the token that opened it. An idle session closes after 30 minutes; a person has at most 8 open.
- **Files** a tool writes go to that person's folder on the server, `<home>/web/<name>`, the only folder its tools may read or write. Each result lists them under `downloads`, with a link that lasts an hour; the files are deleted after an hour. A link is made only for a file that, with `..` and symbolic links resolved, is in the person's folder, and that is checked again when it is served: a path the person wrote into a layer's name never reaches another folder.
- **Imports** take a URL (the plugin fetches it), or a file uploaded first: `POST /files?name=logo.png` with the bearer header and the bytes as the body (at most 25 MB) answers the `path` to give the import.
- `figma_eval` is never registered for a web session.
- **The connector's icon** in claude.ai comes from Google's favicon service for the hub's domain reduced to its last two labels, not from the hub `[C-419]`: for `mcp.figxel.example`, the favicon of `example`'s site. The hub serves the Figxel mark at `/favicon.ico` and names it in its server info for clients that use either.

## Sign-in with Figma or Google

The plugin's first screen signs in to Figxel Cloud, the Moire Labs hub at `mcp.figxel.moirelabs.dev`; a team running its own hub gives its people the address to set with **Change**, or an invite, which carries it. With the web endpoint on, people sign in the way they do with any remote MCP server: an app opens the hub's sign-in page, they press **Continue with Figma** or **Continue with Google**, and they are in. The Figma plugin does the same through the browser: **Sign in with the browser** shows a short code, the page that opens shows the same code, and after the sign-in there the plugin connects with a credential of its own. The invite stays as the other way in.

- **Figma** `[C-415]` `[C-416]`: create an OAuth app under Figma's *My Apps* for **your team**, with the callback `https://mcp.figxel.example/login/figma/callback`, and keep it **private**. A private app works for the members of that team and needs no review by Figma; anyone in the team who signs in becomes a person in the table on their first sign-in. A public app would let in any Figma user, and Figma reviews it first.
- **Google** `[C-418]`: create an OAuth client of type *Web application* with the redirect URI `https://mcp.figxel.example/login/google/callback`. A Google account comes in only with a verified email that is a person's in the table (`hub email`), or that `BRIDGE_HUB_GOOGLE_ALLOW` lists (`dina@example.com`, or a whole `@example.com`); with `BRIDGE_HUB_SIGNUP=open`, any Google account comes in.
- **The credentials** go in the container's environment (`BRIDGE_HUB_FIGMA_CLIENT_ID` and `_SECRET`, `BRIDGE_HUB_GOOGLE_CLIENT_ID` and `_SECRET`), best from a file readable by root only (`env_file` in compose.yml), never in the compose file itself.
- **One person, one account.** A sign-in is the person whose verified email it carries (`hub email <name> <address>`), so someone who already has an invite stays the same person when they sign in with Figma or Google; the account is linked to them from then on. Without a match, Figma's team member becomes a new person named after their email.
- **One sign-in per browser.** The hub remembers a browser that signed in, for 30 days (an HttpOnly, Secure, SameSite=Lax cookie): the next sign-in there, such as the plugin's after Claude's, is one **Continue as <name>** click. The click stays, because approving a code on sight would let a link with someone else's code take the person's access; **Use another account** forgets the browser.
- **Removing a person** ends their invite, their signed-in apps, their remembered browsers and their plugin's browser credential at once.

## People and tokens

Run these where the hub runs; with the container above, prefix them with `docker compose exec -T figxel-hub node /app/node_modules/figxel-mcp/dist/server.js`:

| Command | What it does |
|---|---|
| `hub add <name>` | Adds a person and prints their **invite** once, on stdout: the hub's address and their token in one line, `wss://mcp.figxel.example#<token>`. Without `BRIDGE_HUB_PUBLIC_URL` it prints the token alone. The table keeps only the token's hash. A name is lowercase letters, digits, `.`, `-` and `_`, up to 40 |
| `hub list` | The names in the table and when each was added. Never a token |
| `hub email <name> <address>` | Sets a person's email: a sign-in with Figma or Google of that verified email is them. `hub add <name> --email <address>` does it at once |
| `hub remove <name>` | Removes a person. The running hub reads the table again within seconds and closes that person's plugin and processes |

The table is `hub-people.json` in the hub's home folder (`BRIDGE_HOME`), written whole and readable by its owner only. A running hub reads it again when it changes; there is nothing to restart. To give someone a new token, remove them and add them again: the old token stops working at once.

Send each invite to its person privately: it holds their token. They paste it in the plugin window under **Team hub**, and run `npx -y figxel-mcp@latest join '<invite>'` once for their AI apps ([docs/clients.md § Connecting to a team's hub](clients.md#connecting-to-a-teams-hub)). The plugin window then shows **Signed in as** their name, and `join` says "as <name>", so a wrong invite shows at a glance.

## Security notes

- **The token is the gate.** 256 random bits per person, compared in constant time, stored as a hash. A token not in the table is refused: a plugin is closed with `4001`, a process is told only that the hub refused its token. Neither learns anyone's name, file or the hub's process id.
- **The Origin rule is the laptop's.** A connection carrying an Origin other than `null` (what the plugin's iframe sends) is closed with `4003`, so a web page cannot reach the hub. Caddy passes headers through and adds no Origin `[C-408]`; a proxy that added one would close every plugin.
- **The hub's own process reaches no one.** Its own token is random and in no table.
- **Logs** hold ids, sizes and timings, never design content, as on a laptop.
- **Refused tokens are limited per address.** After 20 refused tokens from one address within 10 minutes, the hub turns that address away for 15 minutes, a correct token included, and logs the address once. The address is the one Caddy puts in `X-Forwarded-For` `[C-408]`, believed only when the connection comes from a private address, as the proxy's does.
- **Versions.** The hub and the processes speak the same peer protocol (version 1) across releases: a new ability is announced as a feature or an optional field, which an older side ignores. A tool newer than the hub reaches the plugin all the same, and a newer write tool keeps its retry key and its guard against overwriting someone's edit. Update the hub and the team's apps within a release of each other.
- **The server's address is public** with a DNS-only record `[C-410]`; the hub listens only on the proxy's network.

## Updating

Install the new package into `/srv/figxel-hub/app` and run `docker compose up -d --force-recreate`. Plugins and processes reconnect by themselves within seconds. Each person updates their own AI apps to the same version (`npx -y figxel-mcp@latest`, then restart the app).
