import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openBackup } from "../../../tools/admin/open-backup.mjs";
import { gzip, sealedCopy } from "../src/backup";
import { envelopeHeader, open } from "../src/envelope";
import { KEY_ID, keyId, RootKeyMissing, rootKeys } from "../src/keyring";
import type { Tokens } from "../src/social/adapter";
import { signMedia, verifyMedia } from "../src/social/media";
import { newState, readState } from "../src/social/oauth";
import { b64url, subkey, TokenVault } from "../src/social/tokens";

/** Two root keys: OLD sealed things before the rotation, NEW is current after it. */
const OLD = "root-key-before-the-rotation-for-tests";
const NEW = "root-key-after-the-rotation-for-tests";
const ring = (current: string, ...old: string[]) => rootKeys({ SOCIAL_TOKEN_KEY: current, SOCIAL_TOKEN_KEYS_OLD: old.join(", ") })!;
const before = ring(OLD);
const after = ring(NEW, OLD);
const removed = ring(NEW);

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = /^\s*(select|pragma)/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}
const tokens: Tokens = { access: "tok", refresh: null, expiresAt: null, account: "1784", extra: {} };
const enc = new TextEncoder();

describe("root keys", () => {
  it("reads the current key and the old ones, and has none without SOCIAL_TOKEN_KEY", () => {
    expect(rootKeys({})).toBeNull();
    expect(rootKeys({ SOCIAL_TOKEN_KEY: " ", SOCIAL_TOKEN_KEYS_OLD: OLD })).toBeNull();
    expect(rootKeys({ SOCIAL_TOKEN_KEY: NEW, SOCIAL_TOKEN_KEYS_OLD: ` ${OLD},${NEW}  ${OLD}\nthird` })).toEqual({ current: NEW, old: [OLD, "third"] });
  });

  it("gives each key a short id that stays the same and tells keys apart", async () => {
    expect(await keyId(OLD)).toMatch(KEY_ID);
    expect(await keyId(OLD)).toBe(await keyId(OLD));
    expect(await keyId(OLD)).not.toBe(await keyId(NEW));
    expect(await keyId(OLD)).not.toContain(OLD.slice(0, 6));
  });
});

describe("rotating SOCIAL_TOKEN_KEY", () => {
  it("keeps platform tokens readable, moves them to the new key on read, and fails without the old key", async () => {
    const sql = sqlStorage();
    await new TokenVault(sql, before, "off_a").put("ch-x", tokens);
    const keyOf = () => sql.exec<{ key_id: string | null }>("SELECT key_id FROM social_tokens").toArray()[0]!.key_id;
    expect(keyOf()).toBe(await keyId(OLD));
    // Before it is read again, the old key must still be there.
    expect(await new TokenVault(sql, removed, "off_a").get("ch-x")).toBeNull();
    expect(await new TokenVault(sql, after, "off_a").get("ch-x")).toEqual(tokens);
    expect(keyOf()).toBe(await keyId(NEW));
    // Read once, it needs the old key no more.
    expect(await new TokenVault(sql, removed, "off_a").get("ch-x")).toEqual(tokens);
    // New tokens are sealed with the new key.
    await new TokenVault(sql, after, "off_a").put("ch-y", tokens);
    expect(sql.exec<{ key_id: string }>("SELECT key_id FROM social_tokens WHERE channel_id = 'ch-y'").toArray()[0]!.key_id).toBe(await keyId(NEW));
  });

  it("opens token rows sealed before rows named their root key", async () => {
    const sql = sqlStorage();
    await new TokenVault(sql, before, "off_a").put("ch-x", tokens);
    sql.exec("UPDATE social_tokens SET key_id = NULL");
    expect(await new TokenVault(sql, after, "off_a").get("ch-x")).toEqual(tokens);
    expect(sql.exec<{ key_id: string }>("SELECT key_id FROM social_tokens").toArray()[0]!.key_id).toBe(await keyId(NEW));
  });

  it("vouches for media links and sign-ins only with the current key: an old key that stays configured cannot forge them", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const old = await signMedia(before, "off_a", "media-u1", exp);
    expect(old.startsWith(`${await keyId(OLD)}.`)).toBe(true);
    expect(await verifyMedia(before, "off_a", "media-u1", String(exp), old)).toBe(true);
    expect(await verifyMedia(after, "off_a", "media-u1", String(exp), old)).toBe(false);
    const fresh = await signMedia(after, "off_a", "media-u1", exp);
    expect(fresh.startsWith(`${await keyId(NEW)}.`)).toBe(true);
    expect(await verifyMedia(after, "off_a", "media-u1", String(exp), fresh)).toBe(true);
    // Naming the current key does not help a signature made with the old one, nor does naming none.
    const mac = old.split(".")[1]!;
    expect(await verifyMedia(after, "off_a", "media-u1", String(exp), `${await keyId(NEW)}.${mac}`)).toBe(false);
    expect(await verifyMedia(after, "off_a", "media-u1", String(exp), mac)).toBe(false);
    // A link signed before links named their key verifies with the key that is still current.
    const legacy = b64url(await crypto.subtle.sign("HMAC", await subkey(OLD, "media", "HMAC"), enc.encode(`off_a/media-u1.${exp}`)));
    expect(await verifyMedia(before, "off_a", "media-u1", String(exp), legacy)).toBe(true);
    // Whoever holds a key cannot make a link that lasts longer than an hour.
    const far = exp + 30 * 86_400;
    expect(await verifyMedia(after, "off_a", "media-u1", String(far), await signMedia(after, "off_a", "media-u1", far))).toBe(false);

    const { state, verifier } = await newState(before, "x", "anil@kaveri.in", "off_a");
    expect((await readState(before, "x", state))?.verifier).toBe(verifier);
    expect(await readState(after, "x", state)).toBeNull();
    const started = await newState(after, "x", "anil@kaveri.in", "off_a");
    expect((await readState(removed, "x", started.state))?.verifier).toBe(started.verifier);
    expect(await readState(after, "x", (await newState(after, "x", "a", "off_a", Date.now() + 86_400_000)).state)).toBeNull();
  });

  it("keeps sealed backups and retained copies open with the old key, seals new ones with the new key, and says which key is missing", async () => {
    const books = { office: "off_kaveri1234567890ab", at: "2026-11-20T00:00:00.000Z", books: { business: { name: "Kaveri" } }, edits: [] };
    const sealed = await sealedCopy(before, books.office, books);
    expect(envelopeHeader(sealed)!.kid).toBe(await keyId(OLD));
    expect((await open(after, sealed, books.office)).office).toBe(books.office);
    expect(await openBackup([NEW, OLD], sealed)).toEqual(books);

    const err = await open(removed, sealed).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootKeyMissing);
    expect((err as Error).message).toContain(await keyId(OLD));
    await expect(openBackup([NEW], sealed)).rejects.toThrow(/not in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD/);

    const fresh = await sealedCopy(after, books.office, books);
    expect(envelopeHeader(fresh)!.kid).toBe(await keyId(NEW));
    expect(await openBackup([NEW], fresh)).toEqual(books);
  });

  it("opens copies sealed before headers named their root key", async () => {
    const books = { office: "off_kaveri1234567890ab", at: "2026-11-01T00:00:00.000Z", books: {}, edits: [] };
    const legacy = await legacySeal(OLD, books.office, await gzip(JSON.stringify(books)));
    expect(envelopeHeader(legacy)!.kid).toBeUndefined();
    expect((await open(after, legacy, books.office)).office).toBe(books.office);
    expect(await openBackup([NEW, OLD], legacy)).toEqual(books);
    await expect(open(removed, legacy)).rejects.toThrow(/No configured root key/);
  });
});

/** A copy as `envelope.ts` sealed it before headers carried `kid` (the copies already in India and in retained/). */
async function legacySeal(secret: string, officeId: string, plain: ArrayBuffer): Promise<Uint8Array> {
  const kek = await subkey(secret, "backup", "AES-GCM", officeId);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: enc.encode(`the-office/backup-key:${officeId}`) }, kek, raw);
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = enc.encode(
    JSON.stringify({
      v: 1,
      alg: "A256GCM",
      kek: "SOCIAL_TOKEN_KEY/hkdf-sha256/backup",
      office: officeId,
      dek: `${b64url(wrapIv)}.${b64url(wrapped)}`,
      iv: b64url(iv),
    }),
  );
  const prefix = new Uint8Array(8 + head.byteLength);
  prefix.set(enc.encode("OFB1"), 0);
  new DataView(prefix.buffer).setUint32(4, head.byteLength);
  prefix.set(head, 8);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: prefix }, dek, plain));
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}
