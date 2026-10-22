// OAuth on the hub's web endpoint through the real domain (cloud bridge plan,
// Phase C): the flow a client that speaks only OAuth runs, scripted. Metadata,
// Dynamic Client Registration, the sign-in page with the person's invite, PKCE,
// the token exchange, an MCP call with the access token, and a refresh.
//
//   node spikes/live-hub-oauth.mjs --base https://mcp.figxel.example --invite-file <path>
//
// --invite-file  a file holding the person's invite (wss://…#token); never printed
//
// Writes spikes/results/live-hub-oauth.json.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const base = arg("base");
const inviteFile = arg("invite-file");
if (!base || !inviteFile) {
  console.error("usage: node spikes/live-hub-oauth.mjs --base <https://…> --invite-file <path>");
  process.exit(2);
}
const invite = readFileSync(inviteFile, "utf8").trim();

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.error(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const started = Date.now();
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const REDIRECT = "https://oauth-check.invalid/callback"; // never followed: the code is read from the redirect itself

const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const challengeHeader = unauth.headers.get("www-authenticate") ?? "";
check("a request without a token gets 401 naming the metadata", unauth.status === 401 && challengeHeader.includes("resource_metadata="), challengeHeader);
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
check("protected resource metadata", prm.resource === `${base}/mcp` && prm.authorization_servers?.[0] === base, JSON.stringify(prm));
const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
check("authorization server metadata advertises PKCE S256", as.code_challenge_methods_supported?.includes("S256") === true, as.issuer);

const reg = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Figxel live check", redirect_uris: [REDIRECT] }) });
const { client_id } = await reg.json();
check("dynamic client registration", reg.status === 201 && /^fxc_/.test(client_id ?? ""), `HTTP ${reg.status}`);

const verifier = randomBytes(32).toString("base64url");
const params = {
  response_type: "code",
  client_id,
  redirect_uri: REDIRECT,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  state: "live",
  resource: `${base}/mcp`,
};
const page = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(params)}`);
const html = await page.text();
check("the sign-in page names the app and where it returns", page.status === 200 && html.includes("Figxel live check") && html.includes("oauth-check.invalid"), `HTTP ${page.status}`);
const post = await fetch(as.authorization_endpoint, { method: "POST", headers: FORM, body: new URLSearchParams({ ...params, credential: invite }), redirect: "manual" });
const location = post.headers.get("location") ? new URL(post.headers.get("location")) : null;
const code = location?.searchParams.get("code");
check("signing in with the invite redirects back with a code", post.status === 302 && Boolean(code) && location?.searchParams.get("state") === "live", `HTTP ${post.status}`);

const tok = await fetch(as.token_endpoint, {
  method: "POST",
  headers: FORM,
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
});
const tokens = await tok.json();
check("the code is exchanged with PKCE", tok.status === 200 && /^fxa_/.test(tokens.access_token ?? ""), `HTTP ${tok.status}, expires_in ${tokens.expires_in}`);

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
const client = new Client({ name: "live-hub-oauth", version: "0" });
await client.connect(transport);
const status = await client.callTool({ name: "figma_status", arguments: {} });
const files = (JSON.parse(status.content?.[0]?.text ?? "{}").sessions ?? []).map((s) => s.file?.name);
check("an MCP call with the access token reaches the person's Figma", files.length > 0, JSON.stringify(files));
await client.close();

const refreshed = await fetch(as.token_endpoint, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }) });
const again = await fetch(as.token_endpoint, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }) });
check("a refresh rotates the token, and the spent one is refused", refreshed.status === 200 && again.status === 400, `HTTP ${refreshed.status}, then ${again.status}`);

const result = { ranAt: new Date(started).toISOString(), issuer: new URL(base).host, checks, ok: checks.every((c) => c.ok) };
mkdirSync(path.join(REPO, "spikes/results"), { recursive: true });
writeFileSync(path.join(REPO, "spikes/results/live-hub-oauth.json"), `${JSON.stringify(result, null, 2)}\n`);
console.error(result.ok ? "all checks passed" : "some checks FAILED");
process.exit(result.ok ? 0 : 1);
