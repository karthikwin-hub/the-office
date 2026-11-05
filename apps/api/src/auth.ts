import type { Role } from "@office/contracts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { count, eq, isNull, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env";
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

export function makeAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, password: { hash: hashPassword, verify: verifyPassword } },
    user: { additionalFields: { role: { type: "string", required: false, input: false, defaultValue: "accountant" } } },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    databaseHooks: {
      user: {
        create: {
          /** The first person to sign up owns the office; after that only invited addresses may join. */
          before: async (u) => {
            const [{ n }] = (await db.select({ n: count() }).from(schema.user)) as [{ n: number }];
            if (n === 0) return { data: { ...u, role: "owner" satisfies Role } };
            const email = u.email.toLowerCase();
            const invite = await db.query.invitation.findFirst({ where: and(eq(schema.invitation.email, email), isNull(schema.invitation.acceptedAt)) });
            if (!invite) throw new APIError("FORBIDDEN", { message: "This office is invitation only. Ask the owner to invite this email address." });
            return { data: { ...u, role: invite.role } };
          },
          after: async (u) => {
            await db.update(schema.invitation).set({ acceptedAt: new Date() }).where(eq(schema.invitation.email, u.email.toLowerCase()));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;
export type Member = { id: string; name: string; email: string; role: Role };

export async function members(env: Env): Promise<{ users: Member[]; invited: { email: string; role: Role }[] }> {
  const db = drizzle(env.DB, { schema });
  const users = await db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role }).from(schema.user);
  const invited = await db.select({ email: schema.invitation.email, role: schema.invitation.role }).from(schema.invitation).where(isNull(schema.invitation.acceptedAt));
  return { users, invited };
}

export async function invite(env: Env, email: string, by: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.invitation)
    .values({ email: email.toLowerCase(), role: "accountant", invitedBy: by, createdAt: new Date() })
    .onConflictDoUpdate({ target: schema.invitation.email, set: { invitedBy: by, createdAt: new Date(), acceptedAt: null } });
}
