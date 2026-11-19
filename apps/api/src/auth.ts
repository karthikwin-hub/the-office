import { BRAND } from "@office/contracts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env";
import { mailSender } from "./mail";
import * as schema from "./schema";
import { stepUp } from "./step-up";

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
export async function sendMail(env: Pick<Env, "MAILER" | "MAIL_FROM" | "RESEND_API_KEY">, to: string, subject: string, body: string, fromName: string = BRAND.name): Promise<boolean> {
  const send = mailSender(env);
  if (!send) return false;
  try {
    await send({ fromName, to, subject, body });
    return true;
  } catch (e) {
    console.error("mail not sent", e instanceof Error ? e.message : "unknown error");
    return false;
  }
}

/**
 * Where sign-in may come from, and the domain its cookie is for. With APP_DOMAIN, every office's own address
 * and the console share one sign-in; Better Auth compares a wildcard with the host, port included.
 */
export function authScope(env: Pick<Env, "BETTER_AUTH_URL" | "APP_DOMAIN">, host?: string): { origins: string[]; cookieDomain: string | null } {
  const origins = env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : [];
  const domain = env.APP_DOMAIN?.toLowerCase();
  if (!domain || !env.BETTER_AUTH_URL) return { origins, cookieDomain: null };
  const base = new URL(env.BETTER_AUTH_URL);
  const port = base.port ? `:${base.port}` : "";
  origins.push(`${base.protocol}//${domain}${port}`, `*.${domain}${port}`);
  const name = host?.toLowerCase().replace(/:\d+$/, "");
  return { origins, cookieDomain: name && (name === domain || name.endsWith(`.${domain}`)) ? domain : null };
}

/**
 * Anyone may make an account. An account on its own sees nothing: it opens an office of its
 * own, or joins one through an invitation link. Which offices it is in lives in `membership`.
 */
export function makeAuth(env: Env, host?: string) {
  const scope = authScope(env, host);
  // Building Better Auth with its plugins costs about a millisecond of CPU, on every request; an isolate keeps one per setting.
  const key = JSON.stringify([env.BETTER_AUTH_URL, env.APP_DOMAIN ?? null, env.DATA_MODE, env.EMAIL_VERIFICATION ?? null, scope.cookieDomain]);
  let mine = built.get(env);
  if (!mine) built.set(env, (mine = new Map()));
  let auth = mine.get(key);
  if (!auth) mine.set(key, (auth = buildAuth(env, scope)));
  return auth;
}

const built = new WeakMap<Env, Map<string, ReturnType<typeof buildAuth>>>();

function buildAuth(env: Env, { origins, cookieDomain }: ReturnType<typeof authScope>) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    appName: BRAND.name,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: origins,
    advanced: {
      // Cookies on a parent domain are refused on any other host, so other hosts (workers.dev, localhost) keep their own.
      ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
      // Cloudflare sets this header itself; X-Forwarded-For is whatever the client sent, so it never names the caller.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Better Auth skips the origin check when NODE_ENV is "test"; it is never skipped here.
      disableOriginCheck: false,
    },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      password: { hash: hashPassword, verify: verifyPassword },
      // A forgotten password: a link by email, good for an hour. Asking for one says nothing about whether the account exists.
      resetPasswordTokenExpiresIn: 60 * 60,
      // Whoever knew the old password is signed out everywhere once it changes.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendMail(
          env,
          user.email,
          `Reset your password for ${BRAND.name}`,
          [`Hello ${user.name},`, "", "Open this link within an hour to choose a new password:", url, "", "If you did not ask for this, ignore this message; your password stays as it is."].join("\n"),
        );
      },
    },
    emailVerification: {
      sendOnSignUp: verificationRequired(env),
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(env, user.email, `Confirm your email for ${BRAND.name}`, [`Hello ${user.name},`, "", "Open this link to confirm your email address:", url, "", "If you did not make an account, ignore this message."].join("\n"));
      },
    },
    user: { additionalFields: { role: { type: "string", required: false, input: false, defaultValue: "accountant" } } },
    // No cookie cache: every request reads D1 for the membership anyway, and a cached session that fails its check signs the person out.
    // A session ends after 12 hours without use; while in use it is renewed at most once an hour. A sign-in counts as fresh for 15 minutes.
    session: { cookieCache: { enabled: false }, expiresIn: 12 * 60 * 60, updateAge: 60 * 60, freshAge: 15 * 60 },
    // A second step at sign-in: an authenticator app's code, or one of ten backup codes. Owners must have it; see step-up.ts.
    // Devices are never trusted for later sign-ins.
    plugins: [twoFactor({ issuer: BRAND.name, trustDeviceMaxAge: 0 }), stepUp((to, subject, lines) => sendMail(env, to, subject, lines.join("\n")))],
    // Counts live in D1, so every isolate and every restart sees the same attempts.
    rateLimit: { enabled: env.DATA_MODE === "live", storage: "database", window: 60, max: 30, customRules: { "/sign-in/email": { window: 60, max: 8 }, "/sign-up/email": { window: 3600, max: 10 }, "/send-verification-email": { window: 600, max: 3 }, "/request-password-reset": { window: 600, max: 3 }, "/forget-password": { window: 600, max: 3 }, "/reset-password": { window: 600, max: 10 } } },
  });
}

export type Auth = ReturnType<typeof makeAuth>;
