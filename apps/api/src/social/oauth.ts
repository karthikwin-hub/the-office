import type { Platform } from "@office/contracts";
import { everyKey, keyById, keyId, type RootKeys } from "../keyring";
import { b64url, fromB64url, subkey } from "./tokens";

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATE_TTL_MS = 10 * 60_000;

/** `k` is the id of the root key that signed it (absent on states signed before root keys had ids). */
type State = { p: Platform; n: string; exp: number; by: string; o: string; k?: string };

/**
 * The `state` sent to a platform's sign-in page: who started it, in which office, for which platform,
 * until when, signed. The callback has one address for every office, so the office comes from here.
 * The PKCE verifier is derived from it, so nothing has to be stored while the owner is away signing in.
 */
export async function newState(
  keys: RootKeys,
  platform: Platform,
  by: string,
  officeId: string,
  now = Date.now(),
): Promise<{ state: string; verifier: string }> {
  const body: State = {
    p: platform,
    n: b64url(crypto.getRandomValues(new Uint8Array(16))),
    exp: now + STATE_TTL_MS,
    by,
    o: officeId,
    k: await keyId(keys.current),
  };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const key = await subkey(keys.current, "state", "HMAC");
  const state = `${payload}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))}`;
  return { state, verifier: await verifierFor(key, body.n) };
}

export async function readState(
  keys: RootKeys,
  platform: string,
  state: string | null,
  now = Date.now(),
): Promise<{ by: string; verifier: string; officeId: string; nonce: string; expiresAt: number } | null> {
  const [payload, sig] = (state ?? "").split(".");
  if (!payload || !sig) return null;
  let claimed: State;
  let mac: Uint8Array;
  try {
    claimed = JSON.parse(dec.decode(fromB64url(payload))) as State;
    mac = fromB64url(sig);
  } catch {
    return null;
  }
  if (!claimed || typeof claimed !== "object") return null;
  // The key id is read before the signature is checked only to choose the key; nothing else is trusted until it verifies.
  const named = typeof claimed.k === "string" ? await keyById(keys, claimed.k) : null;
  if (claimed.k !== undefined && !named) return null;
  let key: CryptoKey | null = null;
  for (const root of named ? [named] : everyKey(keys)) {
    const k = await subkey(root, "state", "HMAC");
    if (await crypto.subtle.verify("HMAC", k, mac, enc.encode(payload))) {
      key = k;
      break;
    }
  }
  if (!key) return null;
  const body = claimed;
  if (body.p !== platform || body.exp < now || typeof body.o !== "string" || typeof body.n !== "string") return null;
  return { by: body.by, verifier: await verifierFor(key, body.n), officeId: body.o, nonce: body.n, expiresAt: body.exp };
}

/**
 * A sign-in state is good for one callback: the Office remembers each nonce it has taken until the
 * state would have expired anyway, so a state seen in a log or a browser's history cannot be used again.
 */
export class SpentStates {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS oauth_state_spent (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
  }

  /** True the first time; false for a nonce already taken. */
  spend(state: { nonce: string; expiresAt: number }, now = Date.now()): boolean {
    this.sql.exec("DELETE FROM oauth_state_spent WHERE expires_at < ?", now);
    if (this.sql.exec("SELECT 1 FROM oauth_state_spent WHERE nonce = ?", state.nonce).toArray().length) return false;
    this.sql.exec("INSERT INTO oauth_state_spent (nonce, expires_at) VALUES (?, ?)", state.nonce, state.expiresAt);
    return true;
  }
}

async function verifierFor(key: CryptoKey, nonce: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`pkce:${nonce}`)));
}

/** S256 code challenge for PKCE. */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

export const callbackUrl = (base: string, platform: Platform) => `${base.replace(/\/$/, "")}/api/channels/${platform}/callback`;
