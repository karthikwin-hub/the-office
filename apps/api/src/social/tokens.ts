import type { Tokens } from "./adapter";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * Separate keys for separate jobs, all from the one Worker secret, so a leaked media link
 * signature says nothing about the token key.
 */
export async function subkey(secret: string, purpose: "tokens" | "media" | "state", usage: "AES-GCM" | "HMAC"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  const params = { name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/social"), info: enc.encode(purpose) };
  return usage === "AES-GCM"
    ? crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    : crypto.subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
}

/** `iv.ciphertext`, both base64url. The channel id is bound in as associated data, so a row cannot be moved to another channel. */
export async function seal(key: CryptoKey, channelId: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(channelId) }, key, enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(data)}`;
}

export async function open<T>(key: CryptoKey, channelId: string, sealed: string): Promise<T> {
  const [iv, data] = sealed.split(".");
  if (!iv || !data) throw new Error("Malformed token row");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(channelId) }, key, fromB64url(data));
  return JSON.parse(dec.decode(plain)) as T;
}

/** Platform tokens in the Office's SQLite, encrypted at rest. Nothing here is ever sent to a browser. */
export class TokenVault {
  private key: Promise<CryptoKey> | null;

  constructor(
    private readonly sql: SqlStorage,
    secret: string | undefined,
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS social_tokens (channel_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    this.key = secret ? subkey(secret, "tokens", "AES-GCM") : null;
  }

  get ready(): boolean {
    return this.key !== null;
  }

  async put(channelId: string, tokens: Tokens): Promise<void> {
    if (!this.key) throw new Error("SOCIAL_TOKEN_KEY is not set");
    const sealed = await seal(await this.key, channelId, tokens);
    this.sql.exec("INSERT INTO social_tokens (channel_id, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at", channelId, sealed, Date.now());
  }

  async get(channelId: string): Promise<Tokens | null> {
    if (!this.key) return null;
    const row = this.sql.exec<{ sealed: string }>("SELECT sealed FROM social_tokens WHERE channel_id = ?", channelId).toArray()[0];
    if (!row) return null;
    try {
      return await open<Tokens>(await this.key, channelId, row.sealed);
    } catch {
      return null;
    }
  }

  has(channelId: string): boolean {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM social_tokens WHERE channel_id = ?", channelId).toArray()[0]!.n > 0;
  }

  drop(channelId: string): void {
    this.sql.exec("DELETE FROM social_tokens WHERE channel_id = ?", channelId);
  }
}
