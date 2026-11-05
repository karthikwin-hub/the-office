import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { EmailMessage } from "cloudflare:email";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env";
import { plainMessage } from "./mail";
import * as schema from "./schema";

/**
 * Scrypt, Better Auth's default, takes longer than the free plan's 10 ms of CPU.
 * PBKDF2 runs natively in WebCrypto; the iteration count is stored with each
 * hash so it can be raised later without locking anyone out.
 */
const ITERATIONS = 100_000;
const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iter, salt, want] = hash.split("$");
  if (scheme !== "pbkdf2-sha256" || !iter || !salt || !want) return false;
  const got = new Uint8Array(await derive(password, unb64(salt), Number(iter)));
  const expected = unb64(want);
  if (got.byteLength !== expected.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < got.byteLength; i++) diff |= got[i]! ^ expected[i]!;
  return diff === 0;
}

/** People confirm their address before they open an office or accept an invitation, unless this is a local test. */
export const verificationRequired = (env: Pick<Env, "EMAIL_VERIFICATION">) => env.EMAIL_VERIFICATION !== "off";

/** One plain message from the platform's address; false when mail is not set up here. */
export async function sendMail(env: Pick<Env, "MAILER" | "MAIL_FROM">, to: string, subject: string, body: string, fromName = "The Office"): Promise<boolean> {
  if (!env.MAILER) return false;
  try {
    await env.MAILER.send(new EmailMessage(env.MAIL_FROM, to, plainMessage({ fromName, from: env.MAIL_FROM, to, subject, body })));
    return true;
  } catch (e) {
    console.error("mail not sent", e instanceof Error ? e.message : "unknown error");
    return false;
  }
}

/**
 * Anyone may make an account. An account on its own sees nothing: it opens an office of its
 * own, or joins one through an invitation link. Which offices it is in lives in `membership`.
 */
export function makeAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, password: { hash: hashPassword, verify: verifyPassword } },
    emailVerification: {
      sendOnSignUp: verificationRequired(env),
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(env, user.email, "Confirm your email for The Office", [`Hello ${user.name},`, "", "Open this link to confirm your email address:", url, "", "If you did not make an account, ignore this message."].join("\n"));
      },
    },
    user: { additionalFields: { role: { type: "string", required: false, input: false, defaultValue: "accountant" } } },
    // No cookie cache: every request reads D1 for the membership anyway, and a cached session that fails its check signs the person out.
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: env.DATA_MODE === "live", window: 60, max: 30, customRules: { "/sign-in/email": { window: 60, max: 8 }, "/sign-up/email": { window: 3600, max: 10 }, "/send-verification-email": { window: 600, max: 3 } } },
  });
}

export type Auth = ReturnType<typeof makeAuth>;
