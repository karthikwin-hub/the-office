import { everyKey, keyById, keyId, type RootKeys } from "../keyring";
import { log } from "../log";
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
 * signature says nothing about the token key. `scope` gives each office its own token key.
 */
export async function subkey(
  secret: string,
  purpose: "tokens" | "media" | "state" | "backup" | "files",
  usage: "AES-GCM" | "HMAC",
  scope?: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  const params = { name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/social"), info: enc.encode(scope ? `${purpose}:${scope}` : purpose) };
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

/**
 * Which office key sealed a row: 0 is the single-office key from before; 1 is the office's own key. Separately,
 * `key_id` names the root key it was derived from (`keyId`; null for rows sealed before root keys had ids).
 * Rows are resealed with the current office key and root key whenever they are read, so after a rotation every
 * token in use moves to the new root key on its next read.
 */
export const KEY_VERSION = 1;

/** Platform tokens in the Office's SQLite, encrypted at rest. Nothing here is ever sent to a browser. */
export class TokenVault {
  /** Without an office id (tests, the old single office before it learns its id) rows stay on the shared key. */
  constructor(
    private readonly sql: SqlStorage,
    private readonly keys: RootKeys | null,
    private readonly officeId?: string,
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS social_tokens (channel_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const cols = sql.exec<{ name: string }>("PRAGMA table_info(social_tokens)").toArray();
    if (!cols.some((c) => c.name === "key_version")) sql.exec("ALTER TABLE social_tokens ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0");
    if (!cols.some((c) => c.name === "key_id")) sql.exec("ALTER TABLE social_tokens ADD COLUMN key_id TEXT");
  }

  get ready(): boolean {
    return this.keys !== null;
  }

  private get current(): number {
    return this.officeId ? KEY_VERSION : 0;
  }

  private key(root: string, version: number): Promise<CryptoKey> {
    return subkey(root, "tokens", "AES-GCM", version === KEY_VERSION ? this.officeId : undefined);
  }

  async put(channelId: string, tokens: Tokens): Promise<void> {
    if (!this.keys) throw new Error("SOCIAL_TOKEN_KEY is not set");
    const version = this.current;
    const sealed = await seal(await this.key(this.keys.current, version), channelId, tokens);
    this.sql.exec(
      "INSERT INTO social_tokens (channel_id, sealed, updated_at, key_version, key_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at, key_version = excluded.key_version, key_id = excluded.key_id",
      channelId,
      sealed,
      Date.now(),
      version,
      await keyId(this.keys.current),
    );
  }

  /** The tokens, or null when there are none or they cannot be opened (the platform then shows as needing to be connected again). */
  async get(channelId: string): Promise<Tokens | null> {
    if (!this.keys) return null;
    const row = this.sql
      .exec<{ sealed: string; key_version: number; key_id: string | null }>(
        "SELECT sealed, key_version, key_id FROM social_tokens WHERE channel_id = ?",
        channelId,
      )
      .toArray()[0];
    if (!row) return null;
    if (row.key_version === KEY_VERSION && !this.officeId) return null;
    let roots: string[];
    if (row.key_id) {
      const root = await keyById(this.keys, row.key_id);
      if (!root) {
        log("warn", "tokens.root-key-missing", { channel: channelId, message: `sealed with root key ${row.key_id}, which is no longer configured` });
        return null;
      }
      roots = [root];
    } else roots = everyKey(this.keys);
    for (const root of roots) {
      try {
        const tokens = await open<Tokens>(await this.key(root, row.key_version), channelId, row.sealed);
        if (row.key_version !== this.current || row.key_id !== (await keyId(this.keys.current))) await this.put(channelId, tokens);
        return tokens;
      } catch {
        // Another root key, or a row that was changed: try the next.
      }
    }
    return null;
  }
  has(channelId: string): boolean {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM social_tokens WHERE channel_id = ?", channelId).toArray()[0]!.n > 0;
  }

  drop(channelId: string): void {
    this.sql.exec("DELETE FROM social_tokens WHERE channel_id = ?", channelId);
  }
}
