import { b64url, fromB64url } from "./social/tokens";

const enc = new TextEncoder();

/** The Worker's HMAC over the caller header, so an Office trusts a caller only when the Worker itself set it. */
export const CALLER_SEAL_HEADER = "x-office-caller-seal";

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/caller"), info: enc.encode("caller") }, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]));
    keys.set(secret, key);
  }
  return key;
}

export async function sealCaller(secret: string, header: string): Promise<string> {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set: the Worker cannot vouch for callers.");
  return b64url(await crypto.subtle.sign("HMAC", await keyFor(secret), enc.encode(header)));
}

/** True only for the seal the Worker made for exactly this header. */
export async function callerSealed(secret: string | undefined, header: string, seal: string | null): Promise<boolean> {
  if (!secret || !seal || !/^[\w-]{43}$/.test(seal)) return false;
  return crypto.subtle.verify("HMAC", await keyFor(secret), fromB64url(seal), enc.encode(header));
}
