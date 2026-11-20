import type { MediaAsset } from "@office/contracts";
import { keyId, type RootKeys } from "../keyring";
import type { SignedMedia } from "./adapter";
import { b64url, fromB64url, subkey } from "./tokens";

const enc = new TextEncoder();
export const MEDIA_ID = /^media-[\w-]{1,64}$/;
/** Instagram and Threads fetch within minutes; an hour covers retries. */
export const MEDIA_TTL_SECONDS = 3600;

/**
 * `<root key id>.<HMAC>`. The office is part of what is signed, so a link from one office can never open another's picture;
 * the root key's id says which key to check it with after a rotation.
 */
export async function signMedia(keys: RootKeys, officeId: string, id: string, exp: number): Promise<string> {
  const key = await subkey(keys.current, "media", "HMAC");
  return `${await keyId(keys.current)}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${officeId}/${id}.${exp}`)))}`;
}

/**
 * True only for an unexpired link signed for this office and picture by the current root key, expiring within the link
 * lifetime. Old root keys stay configured to open what they sealed, so they never vouch for a link: after a rotation a
 * link signed with the old key stops working (a post that fails is tried again with a fresh link).
 */
export async function verifyMedia(keys: RootKeys, officeId: string, id: string, exp: string | null, sig: string | null, now = Date.now()): Promise<boolean> {
  if (!MEDIA_ID.test(id) || !officeId || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  // Not expired, and not dated further ahead than a link this office signs (a minute's grace for clocks).
  if (Number(exp) * 1000 < now || Number(exp) * 1000 > now + (MEDIA_TTL_SECONDS + 60) * 1000) return false;
  const dot = sig.indexOf(".");
  // Links signed before they named their key carry none; the current key must have signed them all the same.
  if (dot >= 0 && sig.slice(0, dot) !== (await keyId(keys.current))) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromB64url(sig.slice(dot + 1));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await subkey(keys.current, "media", "HMAC"), bytes, enc.encode(`${officeId}/${id}.${exp}`));
}

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4" };

/**
 * Public links for a post's pictures. Uploaded photos live in R2 behind a signature;
 * the sample pictures are static files and need none.
 */
export async function signedMedia(keys: RootKeys, base: string, officeId: string, assets: MediaAsset[], now = Date.now()): Promise<SignedMedia[]> {
  const exp = Math.floor(now / 1000) + MEDIA_TTL_SECONDS;
  const root = base.replace(/\/$/, "");
  return Promise.all(
    assets.map(async (m) => {
      const ext = m.url.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
      const stored = MEDIA_ID.test(m.id) && /^\/api\/(o\/[^/]+\/)?social\/media\//.test(m.url);
      const url = stored
        ? `${root}/media/${encodeURIComponent(officeId)}/${m.id}?exp=${exp}&sig=${await signMedia(keys, officeId, m.id, exp)}`
        : /^https?:/.test(m.url)
          ? m.url
          : `${root}${m.url}`;
      return {
        id: m.id,
        url,
        kind: m.kind,
        alt: m.alt,
        contentType: stored ? (m.kind === "video" ? "video/mp4" : "image/jpeg") : (TYPES[ext] ?? "application/octet-stream"),
      };
    }),
  );
}
