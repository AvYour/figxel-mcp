// An invite to a team's hub: the hub's address and one person's token in one
// string, `wss://mcp.example.com#<64 hex>`. `figxel-mcp hub add` prints it when
// the hub knows its public address (BRIDGE_HUB_PUBLIC_URL); the person pastes it
// once in the plugin window (Team hub) and once with `figxel-mcp join`. It holds
// the token, so it is shared as privately as a password.
//
// The address part is checked by whoever reads it, as any hub address is
// (server-url.ts in the plugin, config.ts in the server): wss://, or ws:// to
// this computer only.

const INVITE_RE = /^(wss?:\/\/[^\s#]+)#([0-9a-f]{64})$/;

export function inviteOf(url: string, token: string): string {
  return `${url.replace(/\/+$/, "")}#${token}`;
}

/** The address and the token, or null when the text is not an invite. */
export function parseInvite(input: string): { url: string; token: string } | null {
  const m = INVITE_RE.exec(input.trim());
  return m ? { url: m[1]!.replace(/\/+$/, ""), token: m[2]! } : null;
}
