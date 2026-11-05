import type { Platform } from "@office/contracts";
import { b64url, fromB64url, subkey } from "./tokens";

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATE_TTL_MS = 10 * 60_000;

type State = { p: Platform; n: string; exp: number; by: string };

/**
 * The `state` sent to a platform's sign-in page: who started it, for which platform, until when, signed.
 * The PKCE verifier is derived from it, so nothing has to be stored while the owner is away signing in.
 */
export async function newState(secret: string, platform: Platform, by: string, now = Date.now()): Promise<{ state: string; verifier: string }> {
  const body: State = { p: platform, n: b64url(crypto.getRandomValues(new Uint8Array(16))), exp: now + STATE_TTL_MS, by };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const key = await subkey(secret, "state", "HMAC");
  const state = `${payload}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))}`;
  return { state, verifier: await verifierFor(key, body.n) };
}

export async function readState(secret: string, platform: string, state: string | null, now = Date.now()): Promise<{ by: string; verifier: string } | null> {
  const [payload, sig] = (state ?? "").split(".");
  if (!payload || !sig) return null;
  const key = await subkey(secret, "state", "HMAC");
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  const body = JSON.parse(dec.decode(fromB64url(payload))) as State;
  if (body.p !== platform || body.exp < now) return null;
  return { by: body.by, verifier: await verifierFor(key, body.n) };
}

async function verifierFor(key: CryptoKey, nonce: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`pkce:${nonce}`)));
}

/** S256 code challenge for PKCE. */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

export const callbackUrl = (base: string, platform: Platform) => `${base.replace(/\/$/, "")}/api/channels/${platform}/callback`;
