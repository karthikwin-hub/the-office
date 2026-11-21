import { describe, expect, it, vi } from "vitest";

// Counts how often Better Auth is built, to show a signed-in request no longer builds it.
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock("better-auth", async (original) => {
  const real = await original<typeof import("better-auth")>();
  return {
    ...real,
    betterAuth: ((options: Parameters<typeof real.betterAuth>[0]) => {
      builds.count++;
      return real.betterAuth(options);
    }) as typeof real.betterAuth,
  };
});

import { AccountRecords } from "../src/account";
import { app } from "../src/app";
import { makeAuth } from "../src/auth";
import type { Env } from "../src/env";
import { cookieValue, readSession, SESSION_EXPIRES_IN, sessionCookieName, signedToken } from "../src/session";
import { ControlPlane } from "../src/tenancy";
import { d1 } from "./d1";
import { withCookies } from "./two-factor";

const BASE = "http://localhost:8787";

function makeEnv(db = d1(), base = BASE) {
  return {
    ASSETS: { fetch: async () => new Response("the app") },
    DB: db,
    DATA_MODE: "test",
    EMAIL_VERIFICATION: "off",
    MAIL_FROM: "office@the-office.test",
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "session-test-secret-not-a-real-one-0",
  } as unknown as Env & { DB: ReturnType<typeof d1> };
}

async function signedUp(env: Env, email = `asha-${crypto.randomUUID().slice(0, 8)}@kaveri.test`) {
  const res = await app.request(
    `${BASE}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ name: "Asha Rao", email, password: "a-long-password-1" }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return withCookies("", res);
}

const headers = (cookie: string) => new Headers({ cookie });
const betterAuth = (env: Env, cookie: string) => makeAuth(env).api.getSession({ headers: headers(cookie) });

describe("reading the session without Better Auth", () => {
  it("names the cookie as Better Auth does, on http and https", async () => {
    for (const base of [BASE, "https://app.office.test"]) {
      const env = makeEnv(d1(), base);
      const ctx = await makeAuth(env).$context;
      expect(sessionCookieName(env)).toBe(ctx.authCookies.sessionToken.name);
    }
  });

  it("finds the same person and session as Better Auth's getSession", async () => {
    const env = makeEnv();
    const cookie = await signedUp(env);
    const read = await readSession(env, headers(cookie));
    const ba = await betterAuth(env, cookie);
    expect(read.state).toBe("ok");
    if (read.state !== "ok" || !ba) throw new Error("not signed in");
    expect(read.signedIn.user).toEqual({
      id: ba.user.id,
      name: ba.user.name,
      email: ba.user.email,
      emailVerified: Boolean(ba.user.emailVerified),
      twoFactorEnabled: Boolean(ba.user.twoFactorEnabled),
    });
    expect(read.signedIn.session.createdAt.getTime()).toBe(ba.session.createdAt.getTime());
    expect(read.signedIn.session.stepUpAt).toBe(ba.session.stepUpAt ?? null);
  });

  it("refuses a cookie whose signature is wrong, or another secret's, as Better Auth does", async () => {
    const env = makeEnv();
    const cookie = await signedUp(env);
    const name = sessionCookieName(env);
    const value = cookieValue(cookie, name)!;
    const token = value.slice(0, value.lastIndexOf("."));
    const forged = [
      `${token}.${"A".repeat(43)}=`,
      `${token}x${value.slice(value.lastIndexOf("."))}`,
      token,
      `${token}.not-base64-at-all-not-base64-at-all-not-b=`,
    ];
    for (const v of forged) {
      const c = `${name}=${encodeURIComponent(v)}`;
      expect(await readSession(env, headers(c))).toEqual({ state: "none" });
      expect(await betterAuth(env, c)).toBeNull();
    }
    expect(await readSession({ ...env, BETTER_AUTH_SECRET: "another-secret-entirely-not-a-real-one" }, headers(cookie))).toEqual({ state: "none" });
  });

  it("finds nobody without a cookie, or for a session that is gone", async () => {
    const env = makeEnv();
    expect(await readSession(env, headers(""))).toEqual({ state: "none" });
    const cookie = await signedUp(env);
    env.DB.sqlite.exec("DELETE FROM session");
    expect(await readSession(env, headers(cookie))).toEqual({ state: "none" });
    expect(await betterAuth(env, cookie)).toBeNull();
  });

  it("leaves an expired session to Better Auth, which deletes it", async () => {
    const env = makeEnv();
    const cookie = await signedUp(env);
    env.DB.sqlite.exec(`UPDATE session SET expires_at = ${Math.floor(Date.now() / 1000) - 60}`);
    expect(await readSession(env, headers(cookie))).toEqual({ state: "ask" });
    const res = await app.request(`${BASE}/api/me`, { headers: { cookie } }, env);
    expect(res.status).toBe(401);
    expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
  });

  it("leaves a session due for renewal to Better Auth, which renews it", async () => {
    const env = makeEnv();
    const cookie = await signedUp(env);
    const due = Math.floor(Date.now() / 1000) + SESSION_EXPIRES_IN - 2 * 3600;
    env.DB.sqlite.exec(`UPDATE session SET expires_at = ${due}`);
    expect(await readSession(env, headers(cookie))).toEqual({ state: "ask" });
    const res = await app.request(`${BASE}/api/me`, { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const { expires_at } = env.DB.sqlite.prepare("SELECT expires_at FROM session").get() as { expires_at: number };
    expect(expires_at).toBeGreaterThan(due + 3600);
    // Renewed, the next request is answered without Better Auth.
    expect((await readSession(env, headers(cookie))).state).toBe("ok");
  });

  it("leaves rotated secrets, or none, to Better Auth", async () => {
    const env = makeEnv();
    const cookie = await signedUp(env);
    expect(await readSession({ ...env, BETTER_AUTH_SECRET: "" }, headers(cookie))).toEqual({ state: "ask" });
    expect(await readSession({ ...env, BETTER_AUTH_SECRETS: "1:one,2:two" } as Env, headers(cookie))).toEqual({ state: "ask" });
  });

  it("imports the signing key once per isolate, not on every request", async () => {
    const secret = `a-fresh-secret-for-this-test-${crypto.randomUUID()}`;
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      for (let i = 0; i < 3; i++) await signedToken(`token.${"A".repeat(43)}=`, secret);
      expect(spy.mock.calls.filter(([, key]) => new TextDecoder().decode(key as Uint8Array) === secret)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a signed-in request without building Better Auth", async () => {
    // The setup file loaded the app before the mock above: load it again, so its Better Auth is the counted one.
    vi.resetModules();
    const { app: counted } = await import("../src/app");
    (await import("../src/auth")).passwordWork.iterations = 1_000;
    const db = d1();
    const cookie = withCookies(
      "",
      await counted.request(
        `${BASE}/api/auth/sign-up/email`,
        {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json" },
          body: JSON.stringify({ name: "Asha Rao", email: "asha@kaveri.test", password: "a-long-password-1" }),
        },
        makeEnv(db),
      ),
    );
    expect(builds.count).toBeGreaterThan(0);
    // A new env object stands for a new isolate's: Better Auth is built once per env.
    const env = makeEnv(db);
    const before = builds.count;
    const res = await counted.request(`${BASE}/api/me`, { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { name: string } }).user.name).toBe("Asha Rao");
    // Nobody signed in: still no Better Auth.
    expect((await counted.request(`${BASE}/api/me`, {}, env)).status).toBe(401);
    expect(builds.count).toBe(before);
  });
});

describe("cookieValue", () => {
  it("takes the first cookie of the name, trimmed, unquoted and decoded, as better-call does", () => {
    expect(cookieValue("a=1; b=2", "b")).toBe("2");
    expect(cookieValue("b=first; b=second", "b")).toBe("first");
    expect(cookieValue(' b = "x%2Ey" ', "b")).toBe("x.y");
    expect(cookieValue("ab=1", "b")).toBeNull();
    expect(cookieValue("b=%E0%A4%A", "b")).toBe("%E0%A4%A");
    expect(cookieValue(null, "b")).toBeNull();
  });
});

/** The D1 calls a request makes: a batch counts once, as it is one round trip. */
function counting(db: ReturnType<typeof d1>) {
  const calls = { n: 0 };
  type S = ReturnType<ReturnType<typeof d1>["prepare"]>;
  const wrap = (s: S): S =>
    ({
      ...s,
      bind: (...a: unknown[]) => wrap(s.bind(...a)),
      first: (col?: string) => (calls.n++, col === undefined ? s.first() : s.first(col)),
      all: () => (calls.n++, s.all()),
      run: () => (calls.n++, s.run()),
      raw: () => (calls.n++, s.raw()),
    }) as S;
  const counted = { ...db, prepare: (q: string) => wrap(db.prepare(q)), batch: (st: S[]) => (calls.n++, db.batch(st)) } as typeof db;
  return { db: counted, calls };
}

describe("one D1 round trip per request", () => {
  async function office(db: ReturnType<typeof d1>, cookie: string, role = "accountant") {
    const env = makeEnv(db);
    const read = await readSession(env, headers(cookie));
    if (read.state !== "ok") throw new Error("not signed in");
    const made = await new ControlPlane(db).createOffice({
      name: "Kaveri Electricals",
      owner: { id: "someone-else", name: "Someone", email: "someone@kaveri.test", emailVerified: true },
      ingestDomain: "in.office.test",
    });
    if ("error" in made) throw new Error(made.error);
    db.sqlite
      .prepare("INSERT INTO membership (office_id, user_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(made.id, read.signedIn.user.id, role, Date.now());
    return made.id;
  }
  const officeNs = (seen: string[]) => ({
    idFromName: (n: string) => n,
    get: (n: string) => ({ fetch: async () => (seen.push(n), Response.json({ ok: true })) }),
  });

  it("answers /api/me with one, the same as asking for each", async () => {
    const plain = d1();
    plain.sqlite.exec(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('someone-else', 'Someone', 'someone@kaveri.test', 1, 'owner', 0, 0)",
    );
    const cookie = await signedUp(makeEnv(plain));
    const id = await office(plain, cookie);
    const { db, calls } = counting(plain);
    const res = await app.request(`${BASE}/api/me`, { headers: { cookie } }, makeEnv(db));
    expect(res.status).toBe(200);
    expect(calls.n).toBe(1);
    const me = (await res.json()) as { offices: { id: string }[]; consentNeeded: unknown[]; deletionRequested: boolean };
    expect(me.offices.map((o) => o.id)).toEqual([id]);
    // The same answer the separate queries give.
    const read = await readSession(makeEnv(plain), headers(cookie));
    if (read.state !== "ok") throw new Error("not signed in");
    const user = read.signedIn.user.id;
    const records = new AccountRecords(plain);
    expect(me.offices).toEqual(JSON.parse(JSON.stringify(await new ControlPlane(plain).officesOf(user))));
    expect(me.consentNeeded).toEqual(await records.consentNeeded(user));
    expect(me.deletionRequested).toBe(await records.deletionRequested(user));
  });

  it("checks the membership in the session's round trip before an office route reaches the office", async () => {
    const plain = d1();
    plain.sqlite.exec(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('someone-else', 'Someone', 'someone@kaveri.test', 1, 'owner', 0, 0)",
    );
    const cookie = await signedUp(makeEnv(plain));
    const id = await office(plain, cookie);
    const { db, calls } = counting(plain);
    const seen: string[] = [];
    const env = { ...makeEnv(db), Office: officeNs(seen) } as unknown as Env;
    expect((await app.request(`${BASE}/api/o/${id}/documents/unread`, { headers: { cookie } }, env)).status).toBe(200);
    expect(calls.n).toBe(1);
    expect(seen).toEqual([id]);
  });

  it("finds no membership for another person's session", async () => {
    const plain = d1();
    plain.sqlite.exec(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('someone-else', 'Someone', 'someone@kaveri.test', 1, 'owner', 0, 0)",
    );
    const member = await signedUp(makeEnv(plain));
    const id = await office(plain, member);
    const outsider = await signedUp(makeEnv(plain));
    const seen: string[] = [];
    const env = { ...makeEnv(plain), Office: officeNs(seen) } as unknown as Env;
    expect((await app.request(`${BASE}/api/o/${id}/documents/unread`, { headers: { cookie: outsider } }, env)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("still checks the membership when Better Auth answers for the session", async () => {
    const plain = d1();
    plain.sqlite.exec(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('someone-else', 'Someone', 'someone@kaveri.test', 1, 'owner', 0, 0)",
    );
    const member = await signedUp(makeEnv(plain));
    const id = await office(plain, member);
    const outsider = await signedUp(makeEnv(plain));
    // Every session due for renewal: readSession leaves them to Better Auth, and nothing comes back with the session.
    plain.sqlite.exec(`UPDATE session SET expires_at = ${Math.floor(Date.now() / 1000) + SESSION_EXPIRES_IN - 2 * 3600}`);
    const seen: string[] = [];
    const env = { ...makeEnv(plain), Office: officeNs(seen) } as unknown as Env;
    expect((await app.request(`${BASE}/api/o/${id}/documents/unread`, { headers: { cookie: outsider } }, env)).status).toBe(404);
    expect((await app.request(`${BASE}/api/o/${id}/documents/unread`, { headers: { cookie: member } }, env)).status).toBe(200);
    expect(seen).toEqual([id]);
  });
});
