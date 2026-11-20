import { createHmac } from "node:crypto";

/** The key an authenticator app is given, in base32 (RFC 4648), as bytes. */
function base32(key: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of key.replace(/[\s=]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error(`Not a base32 key: ${key}`);
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const step = (at: number) => Math.floor(at / 30_000);

/** The six digits an authenticator app shows at `at` (RFC 6238: SHA-1, 30 seconds). */
export function totp(key: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step(at)));
  const mac = createHmac("sha1", base32(key)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** A code from a later 30-second step than `after`, waiting for it if need be: a used code is not taken twice. */
export async function nextTotp(key: string, after: number): Promise<{ code: string; at: number }> {
  while (step(Date.now()) <= step(after)) await new Promise((r) => setTimeout(r, 500));
  const at = Date.now();
  return { code: totp(key, at), at };
}
