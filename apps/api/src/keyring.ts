import type { Env } from "./env";

/**
 * The root keys every office key is derived from: `SOCIAL_TOKEN_KEY` is the current one, which seals everything new;
 * `SOCIAL_TOKEN_KEYS_OLD` lists the ones it replaced (comma- or space-separated), which only open what they sealed.
 *
 * Each sealed thing records the id of the root key that sealed it (`keyId`): a token row, a media link's signature,
 * a sign-in state and an envelope's header. The id is derived from the key with HKDF, so it says nothing about the key,
 * and it cannot be mislabelled: a key carries its own id. Things sealed before ids existed have none; for them every
 * configured key is tried, current first.
 */
export type RootKeys = { readonly current: string; readonly old: readonly string[] };

export function rootKeys(env: Pick<Env, "SOCIAL_TOKEN_KEY" | "SOCIAL_TOKEN_KEYS_OLD">): RootKeys | null {
  const current = env.SOCIAL_TOKEN_KEY?.trim();
  if (!current) return null;
  const old = [
    ...new Set(
      (env.SOCIAL_TOKEN_KEYS_OLD ?? "")
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter((k) => k && k !== current),
    ),
  ];
  return { current, old };
}

/** Current first: the order to try keys in when a sealed thing does not say which one sealed it. */
export const everyKey = (keys: RootKeys): string[] => [keys.current, ...keys.old];

const enc = new TextEncoder();
const ids = new Map<string, Promise<string>>();

/** A root key's id: 12 base64url characters (72 bits) from HKDF of the key. Safe to store and show; it reveals nothing about the key. */
export function keyId(secret: string): Promise<string> {
  let id = ids.get(secret);
  if (!id) {
    id = crypto.subtle
      .importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"])
      .then((base) => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/root"), info: enc.encode("key-id") }, base, 72))
      .then((bits) =>
        btoa(String.fromCharCode(...new Uint8Array(bits)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_"),
      );
    ids.set(secret, id);
  }
  return id;
}

export const KEY_ID = /^[\w-]{12}$/;

/** The configured root key with this id, or null when it is not configured (any more). */
export async function keyById(keys: RootKeys, id: string): Promise<string | null> {
  for (const k of everyKey(keys)) if ((await keyId(k)) === id) return k;
  return null;
}

/** Thrown when a sealed thing names a root key that is no longer in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD. */
export class RootKeyMissing extends Error {
  constructor(readonly id: string) {
    super(`Sealed with root key ${id}, which is not in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD. Put that key back in SOCIAL_TOKEN_KEYS_OLD to open it.`);
    this.name = "RootKeyMissing";
  }
}
