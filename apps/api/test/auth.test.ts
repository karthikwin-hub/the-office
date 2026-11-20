import { pbkdf2Sync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { hashPassword, ITERATIONS, needsRehash, passwordWork, verifyPassword } from "../src/auth";
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
      const res = await post(
        env,
        "/api/auth/sign-in/email",
        { email: "anil@kaveri.test", password: "a-wrong-password-1" },
        { "x-forwarded-for": xff, "cf-connecting-ip": "203.0.113.7" },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
    // Someone else, at another address, is not locked out by it.
    const other = await post(
      env,
      "/api/auth/sign-in/email",
      { email: "bina@shah.test", password: "a-wrong-password-1" },
      { "cf-connecting-ip": "198.51.100.4" },
    );
    expect(other.status).not.toBe(429);
  });

  it("still limits a caller with no Cloudflare address, sharing one bucket", async () => {
    const { env } = liveEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++)
      statuses.push(
        (await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: "a-wrong-password-1" }, { "x-forwarded-for": randomIp() })).status,
      );
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

describe("password hashes", () => {
  const lowered = passwordWork.iterations;
  beforeAll(() => void (passwordWork.iterations = ITERATIONS));
  afterAll(() => void (passwordWork.iterations = lowered));
  /** A hash as the Worker made them before: one PBKDF2 call of 100,000 iterations. */
  const legacy = (password: string) => {
    const salt = randomBytes(16);
    return `pbkdf2-sha256$100000$${salt.toString("base64")}$${pbkdf2Sync(password.normalize("NFKC"), salt, 100_000, 32, "sha256").toString("base64")}`;
  };

  it("makes new hashes with ITERATIONS iterations, in rounds Cloudflare accepts, and still reads the old ones", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(new RegExp(`^pbkdf2-sha256-chain\\$${ITERATIONS}\\$`));
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash, password: "a-long-password-2" })).toBe(false);
    const old = legacy(PASSWORD);
    expect(needsRehash(old)).toBe(true);
    expect(await verifyPassword({ hash: old, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: old, password: "a-long-password-2" })).toBe(false);
  });

  it("takes as much work to check an old hash as a new one, so timing does not say which addresses have accounts", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const work = () => derive.mock.calls.reduce((n, [params]) => n + (params as { iterations: number }).iterations, 0);
    await verifyPassword({ hash: legacy(PASSWORD), password: "a-wrong-password-1" });
    const old = work();
    derive.mockClear();
    await hashPassword("a-wrong-password-1");
    expect(old).toBe(work());
    derive.mockRestore();
  });

  it("hashes an old password again at the next right sign-in, and not after a wrong one", async () => {
    const { env, db } = liveEnv("test");
    await signUp(env, "anil@kaveri.test");
    const stored = () => (db.sqlite.prepare("SELECT password FROM account WHERE provider_id = 'credential'").get() as { password: string }).password;
    db.sqlite.prepare("UPDATE account SET password = ?").run(legacy(PASSWORD));
    const before = stored();

    expect((await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: "a-wrong-password-1" })).status).toBe(401);
    expect(stored()).toBe(before);

    expect((await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: PASSWORD })).status).toBe(200);
    expect(stored()).toMatch(new RegExp(`^pbkdf2-sha256-chain\\$${ITERATIONS}\\$`));
    expect((await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: PASSWORD })).status).toBe(200);
  });
});

describe("making an account", () => {
  /** Verification on, as in production, with mail kept in memory. */
  function verifyingEnv() {
    const { env, db } = liveEnv("test");
    const sent: { to: string; raw: string }[] = [];
    Object.assign(env, { EMAIL_VERIFICATION: undefined, MAILER: { send: async (m: { to: string; raw: string }) => void sent.push(m) } });
    const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, ""), "base64").toString("utf8");
    const subjectOf = (raw: string) =>
      (/^Subject: (.*)$/m.exec(raw)?.[1] ?? "").replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));
    return { env, db, sent, bodyOf, subjectOf };
  }
  const signUpAs = (env: Env, email: string, password = PASSWORD) => post(env, "/api/auth/sign-up/email", { name: "Someone", email, password });
  const shape = async (res: Response) => {
    const body = (await res.json()) as { token: unknown; user: Record<string, unknown> };
    return {
      status: res.status,
      cookies: (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().length,
      token: body.token,
      keys: Object.keys(body.user).sort(),
      email: body.user.email,
      emailVerified: body.user.emailVerified,
    };
  };

  it("answers the same whether or not the address already has an account", async () => {
    const { env, sent, subjectOf } = verifyingEnv();
    expect((await signUpAs(env, "anil@kaveri.test")).status).toBe(200);
    sent.length = 0;
    const again = await shape(await signUpAs(env, "anil@kaveri.test", "another-long-password"));
    const fresh = await shape(await signUpAs(env, "nobody@nowhere.test", "another-long-password"));
    expect(again).toEqual({ ...fresh, email: "anil@kaveri.test" });
    expect(fresh).toMatchObject({ status: 200, cookies: 0, token: null, emailVerified: false });
    // Each address gets one message: the owner of the existing account hears of the attempt.
    expect(sent.map((m) => m.to).sort()).toEqual(["anil@kaveri.test", "nobody@nowhere.test"]);
    expect(subjectOf(sent.find((m) => m.to === "anil@kaveri.test")!.raw)).toMatch(/tried to make an account/);
    expect(subjectOf(sent.find((m) => m.to === "nobody@nowhere.test")!.raw)).toMatch(/Confirm your email/);
  });

  it("signs in through the emailed link, and sends it again to someone signing in before opening it", async () => {
    const { env, sent, bodyOf } = verifyingEnv();
    await signUpAs(env, "anil@kaveri.test");
    const early = await post(env, "/api/auth/sign-in/email", { email: "anil@kaveri.test", password: PASSWORD });
    expect(early.status).toBe(403);
    expect(sent).toHaveLength(2);
    const link = /https?:\/\/\S+verify-email\S+/.exec(bodyOf(sent.at(-1)!.raw))![0];
    const opened = await app.request(link, { headers: { origin: BASE } }, env);
    expect(opened.status).toBeLessThan(400);
    const me = await get(env, "/api/me", withCookies("", opened));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
  });
});
