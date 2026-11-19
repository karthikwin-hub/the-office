import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ROUTES } from "@office/contracts";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { API_CSP, appCsp, BASE_HEADERS, SKIN_SCRIPT_HASH } from "../src/edge";
import type { Env } from "../src/env";
import { d1 } from "./d1";

const BASE = "http://localhost:8787";
const WEB = join(import.meta.dirname, "..", "..", "web");
const enc = new TextEncoder();

/** R2, in memory. */
function r2() {
  const m = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  return {
    put: async (key: string, data: string | Uint8Array, o: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}) => void m.set(key, { bytes: typeof data === "string" ? enc.encode(data) : data, ...o }),
    get: async (key: string) => {
      const v = m.get(key);
      return v ? { key, size: v.bytes.byteLength, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata, get body() { return new Blob([v.bytes]).stream(); } } : null;
    },
  };
}

function makeEnv(assets: () => Response = () => new Response("<!doctype html><title>the app</title>", { headers: { "content-type": "text/html; charset=utf-8" } })) {
  const docs = r2();
  const seen: string[] = [];
  const env = {
    ASSETS: { fetch: async () => assets() },
    DB: d1(),
    DOCS: docs,
    Office: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async (req: Request) => (seen.push(`${req.method} ${new URL(req.url).pathname}`), Response.json({ ok: true })) }) },
    DATA_MODE: "test",
    MAIL_FROM: "office@the-office.test",
    INGEST_DOMAIN: "in.the-office.test",
    EMAIL_VERIFICATION: "off",
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "edge-test-secret-not-a-real-one",
  } as unknown as Env;
  return { env, docs, seen };
}
type World = ReturnType<typeof makeEnv>;

const req = (w: World, path: string, init: RequestInit = {}, cookie?: string) => app.request(`${BASE}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } }, w.env);

async function owner(w: World) {
  const res = await req(w, "/api/auth/sign-up/email", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ name: "Anil Kulkarni", email: "anil@kaveri.test", password: "a-long-password-1" }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const opened = await req(w, ACCOUNT_ROUTES.offices, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ name: "Kaveri Electricals" }) }, cookie);
  expect(opened.status).toBe(201);
  return { cookie, office: ((await opened.json()) as { id: string }).id };
}

const expectBase = (res: Response) => {
  for (const [k, v] of Object.entries(BASE_HEADERS)) expect([k, res.headers.get(k)]).toEqual([k, v]);
};

describe("security headers", () => {
  it("puts the strict headers and a load-nothing policy on API responses", async () => {
    const res = await req(makeEnv(), "/api/health");
    expect(res.status).toBe(200);
    expectBase(res);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe(API_CSP);
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const unsigned = await req(makeEnv(), ACCOUNT_ROUTES.me);
    expect(unsigned.status).toBe(401);
    expectBase(unsigned);
    expect(unsigned.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("gives the web app's pages the app policy, even when the asset server's headers are read-only", async () => {
    const page = await req(makeEnv(), "/settings");
    expectBase(page);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toBe(appCsp({}));
    expect(csp).toContain(`'${SKIN_SCRIPT_HASH}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);

    const w = makeEnv(() => Response.redirect(`${BASE}/elsewhere`, 302));
    const moved = await req(w, "/old");
    expect(moved.status).toBe(302);
    expectBase(moved);
  });

  it("lets the live WebSocket reach this host and the office addresses", () => {
    expect(appCsp({ APP_DOMAIN: "office.snilld.in" })).toContain("connect-src 'self' wss://office.snilld.in wss://*.office.snilld.in;");
    expect(appCsp({})).toContain("connect-src 'self';");
  });

  it("allows the one inline script in index.html by its hash", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(inline).toHaveLength(1);
    expect(`sha256-${createHash("sha256").update(inline[0]!).digest("base64")}`).toBe(SKIN_SCRIPT_HASH);
  });

  it("sends the same headers from _headers for pages the asset server sends on its own", () => {
    const lines = readFileSync(join(WEB, "public", "_headers"), "utf8").split("\n");
    const rule = lines.slice(lines.indexOf("/*") + 1).filter((l) => /^\s+\S/.test(l));
    const set = Object.fromEntries(rule.map((l) => l.trim().split(/:\s(.*)/s).slice(0, 2) as [string, string]).map(([k, v]) => [k.toLowerCase(), v]));
    const wrangler = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
    const domain = /^\s*"APP_DOMAIN":\s*"([^"]+)"/m.exec(wrangler)![1]!;
    expect(set).toEqual({ ...BASE_HEADERS, "x-frame-options": "DENY", "content-security-policy": appCsp({ APP_DOMAIN: domain }) });
  });

  it("leaves the website chat its CORS and no framing rules", async () => {
    const w = makeEnv();
    const pre = await req(w, "/api/chat/wabcdefgh1", { method: "OPTIONS", headers: { origin: "https://shop.example" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(pre.headers.get("x-frame-options")).toBeNull();
    expect(pre.headers.get("content-security-policy")).toBeNull();
    const posted = await req(w, "/api/chat/wabcdefgh1", { method: "POST", headers: { origin: "https://shop.example", "content-type": "application/json" }, body: JSON.stringify({ visitor: "v1234567890", text: "hello" }) });
    expect(posted.status).toBe(404);
    expect(posted.headers.get("access-control-allow-origin")).toBe("*");
    expect(posted.headers.get("content-security-policy")).toBeNull();
    const script = await req(w, "/w/wabcdefgh1.js");
    expect(script.headers.get("content-type")).toBe("text/javascript");
    expect(script.headers.get("x-frame-options")).toBeNull();
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    const deeper = await req(w, "/w/a/b");
    expect(deeper.headers.get("x-frame-options")).toBe("DENY");
    expect(deeper.headers.get("content-security-policy")).toBe(appCsp({}));
  });
});

