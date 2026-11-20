// Opens a sealed copy of an office's books: a daily copy from the bucket in India (`<officeId>/<date>.json.gz.enc`)
// or a copy retained after a purge (`retained/<officeId>/<time>.json.gz.enc` in R2). It needs the root key that
// sealed it: the Worker's SOCIAL_TOKEN_KEY, or one of the keys it replaced, in SOCIAL_TOKEN_KEYS_OLD. Run it through
// Infisical, and write the result into backups/ (git-ignored), never the repo:
//
//   infisical run --env=dev --silent -- node tools/admin/open-backup.mjs <sealed file> backups/<name>.json
//
// The result is the JSON the office wrote: { office, at | purgedAt, books, edits }. The format is described in
// apps/api/src/envelope.ts and the root keys in apps/api/src/keyring.ts; this file repeats only the opening, so it
// runs on Node alone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const enc = new TextEncoder();
const dec = new TextDecoder();
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A root key's id, as `keyId` in apps/api/src/keyring.ts derives it. */
async function keyId(secret) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/root"), info: enc.encode("key-id") }, base, 72);
  return Buffer.from(bits).toString("base64url");
}

/** The root keys, current first, as `rootKeys` in apps/api/src/keyring.ts reads them from the Worker's secrets. */
export function rootKeys(vars) {
  const current = vars.SOCIAL_TOKEN_KEY?.trim();
  if (!current) return [];
  const old = (vars.SOCIAL_TOKEN_KEYS_OLD ?? "")
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k && k !== current);
  return [...new Set([current, ...old])];
}

/** The office's backup key, as `subkey(secret, "backup", "AES-GCM", officeId)` in apps/api/src/social/tokens.ts derives it. */
async function officeKey(secret, officeId) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("the-office/social"), info: enc.encode(`backup:${officeId}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

/**
 * The copy's contents. `secrets` is one root key or a list of them, current first. Throws if the file is not a sealed
 * copy, was changed, or was sealed with a root key that is not given.
 */
export async function openBackup(secrets, bytes) {
  const roots = typeof secrets === "string" ? [secrets] : secrets;
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 8 || dec.decode(buf.subarray(0, 4)) !== "OFB1") throw new Error("Not a sealed copy of an office's books.");
  const len = 8 + new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4);
  const header = JSON.parse(dec.decode(buf.subarray(8, len)));
  if (header.v !== 1) throw new Error(`Unknown version ${header.v}.`);
  // Copies made before root keys had ids name none: every key given is tried on them.
  let tried = roots;
  if (header.kid) {
    const ids = await Promise.all(roots.map(keyId));
    const i = ids.indexOf(header.kid);
    if (i < 0) throw new Error(`Sealed with root key ${header.kid}, which is not in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD.`);
    tried = [roots[i]];
  }
  const [wrapIv, wrapped] = header.dek.split(".");
  let raw = null;
  for (const secret of tried) {
    try {
      raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64url(wrapIv), additionalData: enc.encode(`the-office/backup-key:${header.office}`) },
        await officeKey(secret, header.office),
        fromB64url(wrapped),
      );
      break;
    } catch {
      // Another root key: try the next.
    }
  }
  if (!raw) throw new Error("No root key given opens this copy's data key.");
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const zipped = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(header.iv), additionalData: buf.subarray(0, len) }, dek, buf.subarray(len));
  return JSON.parse(gunzipSync(Buffer.from(zipped)).toString("utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [input, output] = process.argv.slice(2);
  const secrets = rootKeys(process.env);
  if (!input || !output) {
    console.error("Usage: node tools/admin/open-backup.mjs <sealed file> <output .json>");
    process.exit(1);
  }
  if (!secrets.length) {
    console.error("SOCIAL_TOKEN_KEY is not set. Run this through `infisical run`.");
    process.exit(1);
  }
  if (existsSync(output)) {
    console.error(`${output} exists already; choose another name.`);
    process.exit(1);
  }
  const data = await openBackup(secrets, readFileSync(input));
  writeFileSync(output, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Opened the books of ${data.office} (${data.at ?? data.purgedAt}): ${output}. Delete it once you are done.`);
}
