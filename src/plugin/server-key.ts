// Where the plugin keeps a server's token in clientStorage. Apart from
// server-url.ts, which needs the browser's URL, because the sandbox (code.ts)
// has no URL global.

/** This computer's token under the key plugins already used; a hub's under its address. */
export const tokenKey = (server: string | null, localKey: string): string => (server ? `figxel.token ${server}` : localKey);
