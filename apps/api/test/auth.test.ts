import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { d1 } from "./d1";

const BASE = "http://localhost:8787";

/** Just enough of the Worker's bindings to sign up and sign in; "live" switches the rate limit on. */
function liveEnv() {
  const db = d1();
  const env = {
    ASSETS: { fetch: async () => new Response("the app") },
    DB: db,
    DATA_MODE: "live",
    EMAIL_VERIFICATION: "off",
    MAIL_FROM: "office@the-office.test",
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "auth-test-secret-not-a-real-one-000",
  } as unknown as Env;
  return { env, db };
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env);

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
