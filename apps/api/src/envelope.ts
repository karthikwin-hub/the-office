import { everyKey, KEY_ID, keyById, keyId, RootKeyMissing, type RootKeys } from "./keyring";
import { b64url, fromB64url, subkey } from "./social/tokens";

/**
 * Envelope encryption for the copies of an office's books that leave its Durable Object: the daily copy in
 * India and the copy retained after a purge. Each copy gets a fresh random data key (AES-256-GCM). The data
 * key is wrapped with the office's own key, derived with HKDF from `SOCIAL_TOKEN_KEY` exactly as the
 * platform-token keys are (`backup:<officeId>`), and travels with the copy. Opening a copy needs only that
 * root secret and the file; `tools/admin/open-backup.mjs` does it outside the Worker.
 *
 * Layout: `OFB1` | header length (4 bytes, big-endian) | header (JSON) | ciphertext. The header names the
 * office and holds the wrapped data key and the IV. The ciphertext's associated data is everything before
 * it, so a changed header (another office, another key) fails to open; the wrapped key's is the office id.
 *
 * `kid` is the id of the root key the office key was derived from (`keyring.ts`): new copies are sealed with the
 * current `SOCIAL_TOKEN_KEY`, and a copy opens with whichever configured root key its header names. Copies made before
 * root keys had ids have no `kid`; every configured key is tried on them.
 */
const MAGIC = "OFB1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export type EnvelopeHeader = { v: 1; alg: "A256GCM"; kek: "SOCIAL_TOKEN_KEY/hkdf-sha256/backup"; kid?: string; office: string; dek: string; iv: string };

const wrapAad = (officeId: string) => enc.encode(`the-office/backup-key:${officeId}`);

export async function seal(keys: RootKeys, officeId: string, plain: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const kek = await subkey(keys.current, "backup", "AES-GCM", officeId);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: wrapAad(officeId) }, kek, raw);
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  raw.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: EnvelopeHeader = {
    v: 1,
    alg: "A256GCM",
    kek: "SOCIAL_TOKEN_KEY/hkdf-sha256/backup",
    kid: await keyId(keys.current),
    office: officeId,
    dek: `${b64url(wrapIv)}.${b64url(wrapped)}`,
    iv: b64url(iv),
  };
  const head = enc.encode(JSON.stringify(header));
  const prefix = new Uint8Array(8 + head.byteLength);
  prefix.set(enc.encode(MAGIC), 0);
  new DataView(prefix.buffer).setUint32(4, head.byteLength);
  prefix.set(head, 8);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: prefix }, dek, plain));
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

/** The header of a sealed copy, or null when the bytes are not one. */
export function envelopeHeader(bytes: Uint8Array): EnvelopeHeader | null {
  if (bytes.byteLength < 8 || dec.decode(bytes.subarray(0, 4)) !== MAGIC) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (8 + len > bytes.byteLength) return null;
  try {
    const h = JSON.parse(dec.decode(bytes.subarray(8, 8 + len))) as EnvelopeHeader;
    return h.v === 1 &&
      typeof h.office === "string" &&
      typeof h.dek === "string" &&
      typeof h.iv === "string" &&
      (h.kid === undefined || (typeof h.kid === "string" && KEY_ID.test(h.kid)))
      ? h
      : null;
  } catch {
    return null;
  }
}

/**
 * The plain bytes of a sealed copy. Throws if it is not one, was changed, belongs to another office than `officeId`,
 * or names a root key that is no longer configured (`RootKeyMissing`).
 */
export async function open(keys: RootKeys, bytes: Uint8Array, officeId?: string): Promise<{ office: string; plain: ArrayBuffer }> {
  const h = envelopeHeader(bytes);
  if (!h) throw new Error("Not a sealed copy of an office's books.");
  if (officeId !== undefined && h.office !== officeId) throw new Error(`This copy belongs to ${h.office}, not ${officeId}.`);
  const len = 8 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  const [wrapIv, wrapped] = h.dek.split(".");
  if (!wrapIv || !wrapped) throw new Error("The copy's data key is malformed.");
  let roots: string[];
  if (h.kid) {
    const root = await keyById(keys, h.kid);
    if (!root) throw new RootKeyMissing(h.kid);
    roots = [root];
  } else roots = everyKey(keys);
  let raw: Uint8Array | null = null;
  for (const root of roots) {
    const kek = await subkey(root, "backup", "AES-GCM", h.office);
    try {
      raw = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(wrapIv), additionalData: wrapAad(h.office) }, kek, fromB64url(wrapped)),
      );
      break;
    } catch {
      // Another root key: try the next.
    }
  }
  if (!raw) throw new Error("No configured root key opens this copy's data key.");
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  raw.fill(0);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(h.iv), additionalData: bytes.subarray(0, len) }, dek, bytes.subarray(len));
  return { office: h.office, plain };
}
