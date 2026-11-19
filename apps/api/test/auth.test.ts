import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { d1 } from "./d1";
import { enrolTwoFactor, totp, withCookies } from "./two-factor";

const BASE = "http://localhost:8787";
const PASSWORD = "a-long-password-1";

/** Just enough of the Worker's bindings to sign up and sign in; "live" switches the rate limit on. */
function liveEnv(mode = "live") {
  const db = d1();
  const env = {
    ASSETS: { fetch: async () => new Response("the app") },
    DB: db,
    DATA_MODE: mode,
    EMAIL_VERIFICATION: "off",
    MAIL_FROM: "office@the-office.test",
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "auth-test-secret-not-a-real-one-000",
  } as unknown as Env;
  return { env, db };
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env);
const get = (env: Env, path: string, cookie: string) => app.request(`${BASE}${path}`, { headers: { origin: BASE, cookie } }, env);
const postAs = (env: Env) => (path: string, body: unknown, cookie: string) => post(env, path, body, cookie ? { cookie } : {});

async function signUp(env: Env, email: string): Promise<string> {
  const res = await post(env, "/api/auth/sign-up/email", { name: "Anil Kulkarni", email, password: PASSWORD });
  expect(res.status).toBe(200);
  return withCookies("", res);
}

const randomIp = () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 254) + 1).join(".");

describe("the sign-in rate limit", () => {
  it("counts by Cloudflare's address, whatever X-Forwarded-For claims", async () => {
    const { env } = liveEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const xff = i % 2 ? randomIp() : `not-an-ip-${i}`;
      const res = await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: "a-wrong-password-1" }, { "x-forwarded-for": xff, "cf-connecting-ip": "203.0.113.7" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
    // Someone else, at another address, is not locked out by it.
    const other = await post(env, "/api/auth/sign-in/email", { email: "bina@shah.test", password: "a-wrong-password-1" }, { "cf-connecting-ip": "198.51.100.4" });
    expect(other.status).not.toBe(429);
  });

  it("still limits a caller with no Cloudflare address, sharing one bucket", async () => {
    const { env } = liveEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: "a-wrong-password-1" }, { "x-forwarded-for": randomIp() })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("keeps the counts in D1, so another isolate sees them", async () => {
    const { env, db } = liveEnv();
    await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: "a-wrong-password-1" }, { "cf-connecting-ip": "203.0.113.9" });
    const rows = db.sqlite.prepare("SELECT key, count FROM rate_limit").all() as { key: string; count: number }[];
    expect(rows).toEqual([expect.objectContaining({ key: expect.stringContaining("203.0.113.9"), count: 1 })]);
  });
});

describe("two-factor sign-in", () => {
  it("asks for the authenticator's code after the password, and only then signs in", async () => {
    const { env } = liveEnv("test");
    const enrolled = await enrolTwoFactor(postAs(env), await signUp(env, "anil@kaveri.test"), PASSWORD);
    expect(enrolled.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrolled.backupCodes).toHaveLength(10);
    expect(((await (await get(env, "/api/me", enrolled.cookie)).json()) as { twoFactor: unknown }).twoFactor).toEqual({ enabled: true, required: false });

    const first = await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: PASSWORD });
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    const halfway = withCookies("", first);
    expect(halfway).not.toMatch(/session_token/);
    expect((await get(env, "/api/me", halfway)).status).toBe(401);

    expect((await post(env, "/api/auth/two-factor/verify-totp", { code: "000000" }, { cookie: halfway })).status).toBe(401);
    const second = await post(env, "/api/auth/two-factor/verify-totp", { code: totp(enrolled.uri) }, { cookie: halfway });
    expect(second.status).toBe(200);
    expect((await get(env, "/api/me", withCookies(halfway, second))).status).toBe(200);
  });

  it("takes a backup code once in place of the authenticator", async () => {
    const { env } = liveEnv("test");
    const { backupCodes } = await enrolTwoFactor(postAs(env), await signUp(env, "anil@kaveri.test"), PASSWORD);
    const signIn = async () => withCookies("", await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: PASSWORD }));
    const once = await post(env, "/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] }, { cookie: await signIn() });
    expect(once.status).toBe(200);
    expect((await post(env, "/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] }, { cookie: await signIn() })).status).toBe(401);
  });

  it("is not needed by people who have not turned it on", async () => {
    const { env } = liveEnv("test");
    await signUp(env, "carol@firm.test");
    const res = await post(env, "/api/auth/sign-in/email", { email: "carol@firm.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await get(env, "/api/me", withCookies("", res))).status).toBe(200);
  });
});
