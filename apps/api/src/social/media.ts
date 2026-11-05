import type { MediaAsset } from "@office/contracts";
import type { SignedMedia } from "./adapter";
import { b64url, fromB64url, subkey } from "./tokens";

const enc = new TextEncoder();
export const MEDIA_ID = /^media-[\w-]{1,64}$/;
/** Instagram and Threads fetch within minutes; an hour covers retries. */
export const MEDIA_TTL_SECONDS = 3600;

export async function signMedia(secret: string, id: string, exp: number): Promise<string> {
  const key = await subkey(secret, "media", "HMAC");
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${exp}`)));
}

/** True only for an unexpired link signed by this office. */
export async function verifyMedia(secret: string, id: string, exp: string | null, sig: string | null, now = Date.now()): Promise<boolean> {
  if (!MEDIA_ID.test(id) || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  const key = await subkey(secret, "media", "HMAC");
  let bytes: Uint8Array;
  try {
    bytes = fromB64url(sig);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, bytes, enc.encode(`${id}.${exp}`));
}

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4" };

/**
 * Public links for a post's pictures. Uploaded photos live in R2 behind a signature;
 * the sample pictures are static files and need none.
 */
export async function signedMedia(secret: string, base: string, assets: MediaAsset[], now = Date.now()): Promise<SignedMedia[]> {
  const exp = Math.floor(now / 1000) + MEDIA_TTL_SECONDS;
  const root = base.replace(/\/$/, "");
  return Promise.all(
    assets.map(async (m) => {
      const ext = m.url.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
      const stored = m.url.startsWith("/api/social/media/");
      const url = stored ? `${root}/media/${m.id}?exp=${exp}&sig=${await signMedia(secret, m.id, exp)}` : /^https?:/.test(m.url) ? m.url : `${root}${m.url}`;
      return { id: m.id, url, kind: m.kind, alt: m.alt, contentType: stored ? (m.kind === "video" ? "video/mp4" : "image/jpeg") : (TYPES[ext] ?? "application/octet-stream") };
    }),
  );
}
