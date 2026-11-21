import type { Env } from "./env";

/**
 * Who is signed in, read without building Better Auth: on the free plan a Worker request has about 10 ms of CPU, and
 * building Better Auth with its plugins on an isolate's first request takes more than that (docs/adr/0005).
 *
 * This reads exactly what Better Auth's getSession reads: its signed session cookie (HMAC-SHA256 under
 * BETTER_AUTH_SECRET, checked as better-call checks it), then the session and its user in D1. It answers only the
 * plain cases: no cookie or a bad signature, a session that is not there, and a live session that needs no renewal.
 * Anything else, an expired session (Better Auth deletes it), one due for renewal (Better Auth writes the new expiry)
 * or a setup it does not know (no secret, rotated secrets), it leaves to Better Auth.
 */

/** A session ends after 12 hours without use; while in use it is renewed at most once an hour. Better Auth is given the same. */
export const SESSION_EXPIRES_IN = 12 * 60 * 60;
export const SESSION_UPDATE_AGE = 60 * 60;

export type SignedIn = {
  user: { id: string; name: string; email: string; emailVerified: boolean; twoFactorEnabled: boolean };
  session: { createdAt: Date; stepUpAt: Date | null };
};

/** `none`: nobody is signed in. `ask`: Better Auth must decide. `ok`: signed in, with the results of any statements sent alongside. */
export type SessionRead = { state: "none" } | { state: "ask" } | { state: "ok"; signedIn: SignedIn; token: string; extra: D1Result[] };

/**
 * Who a control-plane statement is about: a person's id, or the person whose session has this token. The second lets a
 * statement go in the session's own D1 round trip (readSession's `extra`) and find rows only for that session's person.
 */
export type Who = { userId: string } | { token: string };
export const whoIs = (who: Who): [sql: string, arg: string] =>
  "token" in who ? ["(SELECT user_id FROM session WHERE token = ?)", who.token] : ["?", who.userId];

/** Better Auth's name for the cookie: `__Secure-` on an https BETTER_AUTH_URL, as its cookie getter decides. */
export const sessionCookieName = (env: Pick<Env, "BETTER_AUTH_URL">) =>
  `${env.BETTER_AUTH_URL?.startsWith("https://") ? "__Secure-" : ""}better-auth.session_token`;

/** The first cookie of this name in a Cookie header, as better-call parses it (trimmed, unquoted, URI-decoded). */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  let index = 0;
  while (index < header.length) {
    const eq = header.indexOf("=", index);
    if (eq === -1) break;
    let end = header.indexOf(";", index);
    if (end === -1) end = header.length;
    else if (end < eq) {
      index = header.lastIndexOf(";", eq - 1) + 1;
      continue;
    }
    if (header.slice(index, eq).trim() === name) {
      let v = header.slice(eq + 1, end).trim();
      if (v.codePointAt(0) === 34) v = v.slice(1, -1);
      try {
        return v.includes("%") ? decodeURIComponent(v) : v;
      } catch {
        return v;
      }
    }
    index = end + 1;
  }
  return null;
}

const enc = new TextEncoder();
/** One imported key per secret for the isolate's life; better-call imports it again on every request. */
const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // A failed import is not kept, so the next request tries again.
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

/** The token a signed cookie value carries, or null when its signature is not this secret's. */
export async function signedToken(value: string, secret: string): Promise<string | null> {
  const at = value.lastIndexOf(".");
  if (at < 1) return null;
  const token = value.slice(0, at);
  const signature = value.slice(at + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  let mac: Uint8Array;
  try {
    mac = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  return (await crypto.subtle.verify("HMAC", await keyFor(secret), mac, enc.encode(token))) ? token : null;
}

type Row = {
  expires_at: number;
  created_at: number;
  step_up_at: number | null;
  id: string;
  name: string;
  email: string;
  email_verified: number;
  two_factor_enabled: number;
};

/** Better Auth's tables store dates as whole seconds (drizzle's `timestamp` mode). */
const date = (seconds: number) => new Date(seconds * 1000);

/**
 * Reads the session from the request's cookie. `extra` adds statements to the same D1 round trip, each given the
 * session token: they must join through `session` on that token, so they find nothing for anyone else's session.
 */
export async function readSession(
  env: Pick<Env, "DB" | "BETTER_AUTH_URL" | "BETTER_AUTH_SECRET">,
  headers: Headers,
  extra: (token: string) => D1PreparedStatement[] = () => [],
  now = Date.now(),
): Promise<SessionRead> {
  const secret = env.BETTER_AUTH_SECRET;
  // Better Auth would use its own default secret, or a list of rotated ones: those are its to judge.
  if (!secret || (env as { BETTER_AUTH_SECRETS?: string }).BETTER_AUTH_SECRETS) return { state: "ask" };
  const value = cookieValue(headers.get("cookie"), sessionCookieName(env));
  if (!value) return { state: "none" };
  const token = await signedToken(value, secret);
  if (!token) return { state: "none" };
  const [found, ...rest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT s.expires_at, s.created_at, s.step_up_at, u.id, u.name, u.email, u.email_verified, u.two_factor_enabled FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?",
    ).bind(token),
    ...extra(token),
  ]);
  const row = (found?.results as Row[] | undefined)?.[0];
  if (!row) return { state: "none" };
  const expiresAt = row.expires_at * 1000;
  // Expired: Better Auth deletes it.
  if (expiresAt < now) return { state: "ask" };
  // Due for renewal (Better Auth's own test, with our settings): Better Auth renews it, unless the person chose not to be
  // remembered, when it returns the session as it is; so do we, or every later request would ask it again.
  if (expiresAt - SESSION_EXPIRES_IN * 1000 + SESSION_UPDATE_AGE * 1000 <= now) {
    const notRemembered = cookieValue(headers.get("cookie"), sessionCookieName(env).replace("session_token", "dont_remember"));
    if (!notRemembered || !(await signedToken(notRemembered, secret))) return { state: "ask" };
  }
  return {
    state: "ok",
    token,
    extra: rest,
    signedIn: {
      user: { id: row.id, name: row.name, email: row.email, emailVerified: Boolean(row.email_verified), twoFactorEnabled: Boolean(row.two_factor_enabled) },
      session: { createdAt: date(row.created_at), stepUpAt: row.step_up_at == null ? null : date(row.step_up_at) },
    },
  };
}
