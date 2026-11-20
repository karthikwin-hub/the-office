// Opens a sealed copy of an office's books: a daily copy from the bucket in India (`<officeId>/<date>.json.gz.enc`)
// or a copy retained after a purge (`retained/<officeId>/<time>.json.gz.enc` in R2). It needs the Worker's
// SOCIAL_TOKEN_KEY, so run it through Infisical, and write the result into backups/ (git-ignored), never the repo:
//
//   infisical run --env=dev --silent -- node tools/admin/open-backup.mjs <sealed file> backups/<name>.json
//
// The result is the JSON the office wrote: { office, at | purgedAt, books, edits }. The format is described in
// apps/api/src/envelope.ts; this file repeats only the opening, so it runs on Node alone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const enc = new TextEncoder();
const dec = new TextDecoder();
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

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

/** The copy's contents. Throws if the file is not a sealed copy, was changed, or was sealed with another secret. */
export async function openBackup(secret, bytes) {
  const buf = new Uint8Array(bytes);
  if (buf.byteLength < 8 || dec.decode(buf.subarray(0, 4)) !== "OFB1") throw new Error("Not a sealed copy of an office's books.");
  const len = 8 + new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4);
  const header = JSON.parse(dec.decode(buf.subarray(8, len)));
  if (header.v !== 1) throw new Error(`Unknown version ${header.v}.`);
  const [wrapIv, wrapped] = header.dek.split(".");
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(wrapIv), additionalData: enc.encode(`the-office/backup-key:${header.office}`) },
    await officeKey(secret, header.office),
    fromB64url(wrapped),
  );
  const dek = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const zipped = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(header.iv), additionalData: buf.subarray(0, len) }, dek, buf.subarray(len));
  return JSON.parse(gunzipSync(Buffer.from(zipped)).toString("utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [input, output] = process.argv.slice(2);
  const secret = process.env.SOCIAL_TOKEN_KEY;
  if (!input || !output) {
    console.error("Usage: node tools/admin/open-backup.mjs <sealed file> <output .json>");
    process.exit(1);
  }
  if (!secret) {
    console.error("SOCIAL_TOKEN_KEY is not set. Run this through `infisical run`.");
    process.exit(1);
  }
  if (existsSync(output)) {
    console.error(`${output} exists already; choose another name.`);
    process.exit(1);
  }
  const data = await openBackup(secret, readFileSync(input));
  writeFileSync(output, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Opened the books of ${data.office} (${data.at ?? data.purgedAt}): ${output}. Delete it once you are done.`);
}
