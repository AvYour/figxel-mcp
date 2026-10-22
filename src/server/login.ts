// Signing a person in to a team's hub with an account they already have
// (cloud bridge): Figma [C-415] [C-416] or Google [C-418]. The hub only learns
// who they are, never anything of theirs: an id that never changes, an email
// and a name. Who may come in is the hub's call (oauth.ts): a private Figma app
// admits the members of its own team, Google admits the addresses the operator
// lists, or anyone when sign-up is open.

import { createHash, randomBytes } from "node:crypto";

export type ProviderId = "figma" | "google";

export interface Identity {
  provider: ProviderId;
  /** The provider's stable id for the person: Figma's user id, Google's `sub`. */
  subject: string;
  email: string | null;
  /** True only when the provider vouches for the email (Google's email_verified; Figma's own account email). */
  emailVerified: boolean;
  name: string | null;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Where to send the person, with our state and PKCE challenge. */
  authorizeUrl(redirectUri: string, state: string, challenge: string): string;
  /** The code from the callback, exchanged for who the person is. */
  identify(code: string, redirectUri: string, verifier: string): Promise<Identity>;
}

type Fetch = typeof fetch;

export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new Error(`${what} answered HTTP ${res.status}`);
  return body;
}

/** Figma: a private OAuth app admits the members of the team it belongs to [C-415]; `current_user:read` reads who they are [C-416]. */
export function figmaProvider(clientId: string, clientSecret: string, fetchImpl: Fetch = fetch): Provider {
  return {
    id: "figma",
    label: "Figma",
    authorizeUrl(redirectUri, state, challenge) {
      const u = new URL("https://www.figma.com/oauth");
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "current_user:read",
        state,
        response_type: "code",
        // S256 is the only method Figma takes, and it documents no parameter to name it [C-415].
        code_challenge: challenge,
      }).toString();
      return u.toString();
    },
    async identify(code, redirectUri, verifier) {
      const token = await json(
        await fetchImpl("https://api.figma.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({ redirect_uri: redirectUri, code, grant_type: "authorization_code", code_verifier: verifier }),
        }),
        "Figma's token endpoint",
      );
      const me = await json(
        await fetchImpl("https://api.figma.com/v1/me", { headers: { authorization: `Bearer ${String(token.access_token)}` } }),
        "Figma's /v1/me",
      );
      if (typeof me.id !== "string" || !me.id) throw new Error("Figma did not say who signed in");
      return {
        provider: "figma",
        subject: me.id,
        email: typeof me.email === "string" ? me.email : null,
        emailVerified: typeof me.email === "string",
        name: typeof me.handle === "string" ? me.handle : null,
      };
    },
  };
}

/** Google: OpenID Connect, `sub` as the key, the email only when Google verified it [C-418]. */
export function googleProvider(clientId: string, clientSecret: string, fetchImpl: Fetch = fetch): Provider {
  return {
    id: "google",
    label: "Google",
    authorizeUrl(redirectUri, state, challenge) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return u.toString();
    },
    async identify(code, redirectUri, verifier) {
      const token = await json(
        await fetchImpl("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, grant_type: "authorization_code", code_verifier: verifier }),
        }),
        "Google's token endpoint",
      );
      const me = await json(
        await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${String(token.access_token)}` } }),
        "Google's userinfo",
      );
      if (typeof me.sub !== "string" || !me.sub) throw new Error("Google did not say who signed in");
      return {
        provider: "google",
        subject: me.sub,
        email: typeof me.email === "string" ? me.email : null,
        emailVerified: me.email_verified === true,
        name: typeof me.name === "string" ? me.name : null,
      };
    },
  };
}

/**
 * Whether a Google account may come in: sign-up open to anyone, or a verified
 * email that the operator listed, by address or by domain (`@example.com`).
 */
export function googleAdmits(identity: Identity, allow: readonly string[], open: boolean): boolean {
  if (!identity.emailVerified || !identity.email) return false;
  if (open) return true;
  const email = identity.email.toLowerCase();
  return allow.some((a) => (a.startsWith("@") ? email.endsWith(a) : email === a));
}
