// A token's fingerprint: its first and last four characters, e.g. "8f3c...a91d".
//
// The plugin window, `setup` and figma_status all show it, so a person can see
// at a glance whether the plugin and the server they talk to use the same token
// — the case where two servers with different token files run at once, and the
// plugin is connected to the other one. It shows 8 of the 64 hex characters,
// never the token. No runtime dependencies (both plugin bundles import this).

export function tokenFingerprint(token: string | null | undefined): string {
  const t = (token ?? "").trim();
  if (t.length < 12) return "none";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
