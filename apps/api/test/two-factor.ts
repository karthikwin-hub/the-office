import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The six digits an authenticator app shows for this otpauth:// URI, as RFC 6238 with SHA-1 and 30 seconds. */
export function totp(uri: string, at = Date.now()): string {
  const key = base32(new URL(uri).searchParams.get("secret") ?? "");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The cookie header after a response: what was there, with whatever the response set or cleared. */
export function withCookies(cookie: string, res: Response): string {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const),
  );
  for (const set of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const pair = set.split(";")[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (!value || /max-age=0/i.test(set)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

type Post = (path: string, body: unknown, cookie: string) => Response | Promise<Response>;

/** Turns two-factor sign-in on the way the web app does: ask for the secret with the password, then confirm one code. */
export async function enrolTwoFactor(post: Post, cookie: string, password: string): Promise<{ cookie: string; uri: string; backupCodes: string[] }> {
  const enabled = await post("/api/auth/two-factor/enable", { password }, cookie);
  if (enabled.status !== 200) throw new Error(`enable ${enabled.status} ${await enabled.text()}`);
  const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
  const verified = await post("/api/auth/two-factor/verify-totp", { code: totp(totpURI) }, cookie);
  if (verified.status !== 200) throw new Error(`verify ${verified.status} ${await verified.text()}`);
  return { cookie: withCookies(cookie, verified), uri: totpURI, backupCodes };
}
