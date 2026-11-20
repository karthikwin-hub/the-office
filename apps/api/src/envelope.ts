import { everyKey, KEY_ID, keyById, keyId, RootKeyMissing, type RootKeys } from "./keyring";
import { b64url, fromB64url, subkey } from "./social/tokens";

/**
 * Envelope encryption for what an office keeps outside its Durable Object: the copies of its books (the daily copy in
 * India and the copy retained after a purge, purpose `backup`) and its stored files in R2 (purpose `files`, see
 * `files.ts`). Each object gets a fresh random data key (AES-256-GCM). The data key is wrapped with the office's own key
 * for that purpose, derived with HKDF from the root key exactly as the platform-token keys are (`backup:<officeId>`,
 * `files:<officeId>`), and travels with the object. Opening one needs only the root key and the bytes;
 * `tools/admin/open-backup.mjs` opens copies of the books outside the Worker.
 *
 * Layout: `OFB1` | header length (4 bytes, big-endian) | header (JSON) | ciphertext. The header names the office (and,
 * for a file, the R2 key it is stored under) and holds the wrapped data key and the IV. The ciphertext's associated data
 * is everything before it, so a changed header (another office, another file, another key) fails to open; the wrapped
 * key's is the purpose and the office id.
 *
 * `kid` is the id of the root key the office key was derived from (`keyring.ts`): new objects are sealed with the
 * current `SOCIAL_TOKEN_KEY`, and an object opens with whichever configured root key its header names. Copies made
 * before root keys had ids have no `kid`; every configured key is tried on them.
 */
const MAGIC = "OFB1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export type Purpose = "backup" | "files";
const KEK = { backup: "SOCIAL_TOKEN_KEY/hkdf-sha256/backup", files: "SOCIAL_TOKEN_KEY/hkdf-sha256/files" } as const;

export type EnvelopeHeader = {
  v: 1;
  alg: "A256GCM";
  kek: (typeof KEK)[Purpose];
  kid?: string;
  office: string;
  /** A stored file's R2 key: the file opens only there. */
  obj?: string;
  dek: string;
  iv: string;
};

/** What a sealed object is for, and for a file where it belongs. Defaults to a copy of the books. */
export type SealFor = { purpose?: Purpose; obj?: string };

const purposeOf = (h: EnvelopeHeader): Purpose => (h.kek === KEK.files ? "files" : "backup");
const wrapAad = (purpose: Purpose, officeId: string) => enc.encode(`the-office/${purpose}-key:${officeId}`);

export async function seal(keys: RootKeys, officeId: string, plain: ArrayBuffer | Uint8Array, to: SealFor = {}): Promise<Uint8Array> {
  const purpose = to.purpose ?? "backup";
  const kek = await subkey(keys.current, purpose, "AES-GCM", officeId);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: wrapAad(purpose, officeId) }, kek, raw);
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  raw.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: EnvelopeHeader = {
    v: 1,
    alg: "A256GCM",
    kek: KEK[purpose],
    kid: await keyId(keys.current),
    office: officeId,
    ...(to.obj !== undefined ? { obj: to.obj } : {}),
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

/** The header of a sealed object, or null when the bytes are not one. */
export function envelopeHeader(bytes: Uint8Array): EnvelopeHeader | null {
  if (bytes.byteLength < 8 || dec.decode(bytes.subarray(0, 4)) !== MAGIC) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (8 + len > bytes.byteLength) return null;
  try {
    const h = JSON.parse(dec.decode(bytes.subarray(8, 8 + len))) as EnvelopeHeader;
    return h.v === 1 &&
      (h.kek === KEK.backup || h.kek === KEK.files) &&
      typeof h.office === "string" &&
      typeof h.dek === "string" &&
      typeof h.iv === "string" &&
      (h.obj === undefined || typeof h.obj === "string") &&
      (h.kid === undefined || (typeof h.kid === "string" && KEY_ID.test(h.kid)))
      ? h
      : null;
  } catch {
    return null;
  }
}

/**
 * The plain bytes of a sealed object. Throws if it is not one, was changed, belongs to another office than `officeId`,
 * is for another purpose or (a file) another R2 key than `to` says, or names a root key that is no longer configured
 * (`RootKeyMissing`).
 */
export async function open(keys: RootKeys, bytes: Uint8Array, officeId?: string, to: SealFor = {}): Promise<{ office: string; plain: ArrayBuffer }> {
  const h = envelopeHeader(bytes);
  if (!h) throw new Error("Not a sealed copy of an office's books.");
  if (officeId !== undefined && h.office !== officeId) throw new Error(`This copy belongs to ${h.office}, not ${officeId}.`);
  const purpose = purposeOf(h);
  if (purpose !== (to.purpose ?? "backup")) throw new Error(`This is sealed for ${purpose}, not ${to.purpose ?? "backup"}.`);
  if (to.obj !== undefined && h.obj !== to.obj) throw new Error("This file was sealed for another place in storage.");
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
    const kek = await subkey(root, purpose, "AES-GCM", h.office);
    try {
      raw = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(wrapIv), additionalData: wrapAad(purpose, h.office) }, kek, fromB64url(wrapped)),
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
