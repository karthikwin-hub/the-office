import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ROUTES } from "@office/contracts";
import { describe, expect, it } from "vitest";
import { rootKeys } from "../src/keyring";
import { app } from "../src/app";
import { API_CSP, appCsp, BASE_HEADERS, FILE_CSP, ownOrigin, SKIN_SCRIPT_HASH } from "../src/edge";
import { newDocId } from "../src/caller";
import type { Env } from "../src/env";
import { docKey, mediaKey } from "../src/keys";
import { signMedia } from "../src/social/media";
import { d1 } from "./d1";
import { enrolTwoFactor } from "./two-factor";

/** Root keys as the Worker reads them: the current one, then any it replaced. */
const ring = (current: string, ...old: string[]) => rootKeys({ SOCIAL_TOKEN_KEY: current, SOCIAL_TOKEN_KEYS_OLD: old.join(",") })!;

const BASE = "http://localhost:8787";
const WEB = join(import.meta.dirname, "..", "..", "web");
const enc = new TextEncoder();

/** R2, in memory. */
function r2() {
  const m = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  return {
    put: async (key: string, data: string | Uint8Array, o: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}) =>
      void m.set(key, { bytes: typeof data === "string" ? enc.encode(data) : data, ...o }),
    get: async (key: string) => {
      const v = m.get(key);
      return v
        ? {
            key,
            size: v.bytes.byteLength,
            httpMetadata: v.httpMetadata,
            customMetadata: v.customMetadata,
            get body() {
              return new Blob([v.bytes]).stream();
            },
          }
        : null;
    },
  };
}

function makeEnv(
  assets: () => Response = () => new Response("<!doctype html><title>the app</title>", { headers: { "content-type": "text/html; charset=utf-8" } }),
) {
  const docs = r2();
  const seen: string[] = [];
  const env = {
    ASSETS: { fetch: async () => assets() },
    DB: d1(),
    DOCS: docs,
    Office: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async (req: Request) => (seen.push(`${req.method} ${new URL(req.url).pathname}`), Response.json({ ok: true })) }),
    },
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

const req = (w: World, path: string, init: RequestInit = {}, cookie?: string) =>
  app.request(`${BASE}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } }, w.env);

async function owner(w: World) {
  const res = await req(w, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ name: "Anil Kulkarni", email: "anil@kaveri.test", password: "a-long-password-1" }),
  });
  expect(res.status).toBe(200);
  const cookie = (res.headers as unknown as { getSetCookie(): string[] })
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const opened = await req(
    w,
    ACCOUNT_ROUTES.offices,
    { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ name: "Kaveri Electricals" }) },
    cookie,
  );
  expect(opened.status).toBe(201);
  const office = ((await opened.json()) as { id: string }).id;
  // Owners turn on two-factor sign-in before anything of their office opens.
  const post = (path: string, body: unknown, c: string) =>
    req(w, path, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }, c);
  return { cookie: (await enrolTwoFactor(post, cookie, "a-long-password-1")).cookie, office };
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
    expect(appCsp({ APP_DOMAIN: "office.snilld.in" })).toContain(
      "connect-src 'self' https://cloudflareinsights.com wss://office.snilld.in wss://*.office.snilld.in;",
    );
    expect(appCsp({})).toContain("connect-src 'self' https://cloudflareinsights.com;");
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
    const set = Object.fromEntries(
      rule
        .map(
          (l) =>
            l
              .trim()
              .split(/:\s(.*)/s)
              .slice(0, 2) as [string, string],
        )
        .map(([k, v]) => [k.toLowerCase(), v]),
    );
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
    const posted = await req(w, "/api/chat/wabcdefgh1", {
      method: "POST",
      headers: { origin: "https://shop.example", "content-type": "application/json" },
      body: JSON.stringify({ visitor: "v1234567890", text: "hello" }),
    });
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

describe("changes come only from the app's own pages", () => {
  const json = (origin: string | null, body: unknown, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { ...(origin ? { origin } : {}), "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });

  it("refuses a signed-in person's request forged from another site, and takes the app's own", async () => {
    const w = makeEnv();
    const { cookie } = await owner(w);
    const forged = await req(w, ACCOUNT_ROUTES.offices, json("https://evil.test", { name: "Forged" }), cookie);
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: expect.stringMatching(/did not come from the app/) });
    expect((await req(w, ACCOUNT_ROUTES.offices, json(null, { name: "No origin" }), cookie)).status).toBe(403);
    expect((await req(w, ACCOUNT_ROUTES.offices, json("null", { name: "Sandboxed" }), cookie)).status).toBe(403);
    const offices = async () => ((await (await req(w, ACCOUNT_ROUTES.me, {}, cookie)).json()) as { offices: { name: string }[] }).offices.map((o) => o.name);
    expect(await offices()).toEqual(["Kaveri Electricals"]);
    expect((await req(w, ACCOUNT_ROUTES.offices, json(BASE, { name: "Mehta Hardware" }), cookie)).status).toBe(201);
    expect((await offices()).sort()).toEqual(["Kaveri Electricals", "Mehta Hardware"]);
  });

  it("refuses a body a plain HTML form could send, even from the app", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const res = await req(w, `/api/o/${office}/settings`, { method: "PUT", headers: { origin: BASE, "content-type": type }, body: '{"x":1}' }, cookie);
      expect([type, res.status]).toEqual([type, 415]);
    }
    expect(w.seen).toEqual([]);
  });

  it("checks uploads and body-less changes by Origin too", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    const upload = (origin: string) => {
      const form = new FormData();
      form.set("file", new File(["%PDF-1.4"], "bill.pdf", { type: "application/pdf" }));
      return req(w, `/api/o/${office}/documents`, { method: "POST", headers: { origin }, body: form }, cookie);
    };
    expect((await upload("https://evil.test")).status).toBe(403);
    expect((await req(w, `/api/o/${office}/office-admin/leave`, { method: "POST", headers: { origin: "https://evil.test" } }, cookie)).status).toBe(403);
    expect(w.seen).toEqual([]);
    expect((await upload(BASE)).status).toBe(200);
    expect((await req(w, `/api/o/${office}/routines/compliance-due/run`, { method: "POST", headers: { origin: BASE } }, cookie)).status).toBe(200);
    expect(
      (
        await req(
          w,
          `/api/o/${office}/office-admin/restore`,
          { method: "POST", headers: { origin: BASE, "content-length": "0" }, body: new Uint8Array(0) },
          cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (await req(w, `/api/o/${office}/settings`, { method: "PUT", headers: { origin: BASE, "content-length": "7" }, body: '{"x":1}' }, cookie)).status,
    ).toBe(415);
    expect(
      (
        await req(
          w,
          `/api/o/${office}/documents/doc-1/scan`,
          { method: "POST", headers: { origin: BASE, "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(w.seen).toEqual(["POST /api/documents", "POST /api/routines/compliance-due/run", "POST /api/documents/doc-1/scan"]);
  });

  it("opens the live connection only for the app's own pages", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    const live = (origin: string | null) => req(w, `/api/o/${office}/live`, { headers: { upgrade: "websocket", ...(origin ? { origin } : {}) } }, cookie);
    expect((await live("https://evil.test")).status).toBe(403);
    expect((await live(null)).status).toBe(403);
    expect(w.seen).toEqual([]);
    expect((await live(BASE)).status).toBe(200);
    expect(w.seen).toEqual(["GET /api/live"]);
  });

  it("knows the app's addresses: its own host, BETTER_AUTH_URL, APP_DOMAIN and the offices under it", () => {
    const env = { BETTER_AUTH_URL: "https://app.office.snilld.in", APP_DOMAIN: "office.snilld.in" };
    const at = "https://kaveri.office.snilld.in/api/o/off_x/settings";
    for (const o of [
      "https://app.office.snilld.in",
      "https://office.snilld.in",
      "https://console.office.snilld.in",
      "https://kaveri.office.snilld.in",
      "https://mehta.office.snilld.in",
    ])
      expect([o, ownOrigin(env, o, at)]).toEqual([o, true]);
    for (const o of [
      "https://evil.test",
      "https://evil-office.snilld.in",
      "https://office.snilld.in.evil.test",
      "http://kaveri.office.snilld.in",
      "https://kaveri.office.snilld.in:8443",
      "https://snilld.in",
      "null",
      "",
      "https://kaveri.office.snilld.in/path",
    ])
      expect([o, ownOrigin(env, o, "https://app.office.snilld.in/api/offices")]).toEqual([o, false]);
    expect(ownOrigin({ BETTER_AUTH_URL: BASE }, "https://the-office.example.workers.dev", "https://the-office.example.workers.dev/api/offices")).toBe(true);
    expect(ownOrigin({ BETTER_AUTH_URL: BASE }, "https://other.example.workers.dev", "https://the-office.example.workers.dev/api/offices")).toBe(false);
  });

  it("leaves what is cross-origin by design to its own checks", async () => {
    const w = makeEnv();
    const hook = await req(w, "/api/hooks/meta", json(null, { object: "instagram", entry: [] }, { "x-hub-signature-256": "sha256=00" }));
    expect([hook.status, await hook.text()]).toEqual([401, "Bad signature"]);
    const chat = await req(w, "/api/chat/wabcdefgh1", json("https://shop.example", { visitor: "v1234567890", text: "hello" }));
    expect(chat.status).toBe(404);
  });

  it("holds sign-in to the app's Origin too, which Better Auth checks only when a cookie comes with it", async () => {
    const w = makeEnv();
    await owner(w);
    const signIn = (origin: string | null) => req(w, "/api/auth/sign-in/email", json(origin, { email: "anil@kaveri.test", password: "a-long-password-1" }));
    for (const origin of ["https://evil.test", null]) {
      const res = await signIn(origin);
      expect([origin, res.status]).toEqual([origin, 403]);
      expect((res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()).toEqual([]);
    }
    expect((await signIn(BASE)).status).toBe(200);
  });
});

describe("stored files", () => {
  it("sends a file stored as a web page as a sandboxed download, whatever it is called", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    await w.docs.put(docKey(office, "doc-u1"), "<script>fetch('/api/me')</script>", {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { filename: "statement.csv" },
    });
    const res = await req(w, `/api/o/${office}/files/doc-u1`, {}, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="statement.csv"');
    expect(res.headers.get("content-security-policy")).toBe(FILE_CSP);
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toBe("<script>fetch('/api/me')</script>");
    for (const type of ["image/svg+xml", "text/html; charset=utf-8", "application/xhtml+xml", "text/plain", "text/csv", "", "APPLICATION/PDFX"]) {
      await w.docs.put(docKey(office, "doc-u2"), "x", { httpMetadata: type ? { contentType: type } : {} });
      const r = await req(w, `/api/o/${office}/files/doc-u2`, {}, cookie);
      expect([type, r.headers.get("content-type"), r.headers.get("content-disposition")]).toEqual([
        type,
        "application/octet-stream",
        'attachment; filename="doc-u2"',
      ]);
    }
  });

  it("still shows a PDF or a photo in the browser, sandboxed", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    await w.docs.put(docKey(office, "doc-u1"), "%PDF-1.4", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: "bill.pdf" } });
    const pdf = await req(w, `/api/o/${office}/files/doc-u1`, {}, cookie);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('inline; filename="bill.pdf"');
    expect(pdf.headers.get("content-security-policy")).toBe(FILE_CSP);
    expect(await pdf.text()).toBe("%PDF-1.4");
    for (const [stored, sent] of [
      ["image/png", "image/png"],
      ["image/jpeg", "image/jpeg"],
      ["image/jpg", "image/jpeg"],
      ["IMAGE/WEBP", "image/webp"],
    ]) {
      await w.docs.put(docKey(office, "doc-u2"), "x", { httpMetadata: { contentType: stored } });
      const r = await req(w, `/api/o/${office}/files/doc-u2`, {}, cookie);
      expect([stored, r.headers.get("content-type"), r.headers.get("content-disposition")]).toEqual([stored, sent, 'inline; filename="doc-u2"']);
    }
  });

  it("keeps a filename in any script without breaking the header", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    await w.docs.put(docKey(office, "doc-u1"), "%PDF", {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { filename: 'बिल "नवंबर"\r\n.pdf' },
    });
    const res = await req(w, `/api/o/${office}/files/doc-u1`, {}, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="___ _____.pdf"; filename*=UTF-8''${encodeURIComponent("बिल नवंबर.pdf")}`);
  });

  it("does the same for pictures, signed in or by a signed link", async () => {
    const w = makeEnv();
    Object.assign(w.env, { SOCIAL_TOKEN_KEY: "edge-media-key" });
    const { cookie, office } = await owner(w);
    await w.docs.put(mediaKey(office, "media-u1"), "<svg onload=alert(1)>", { httpMetadata: { contentType: "image/svg+xml" } });
    await w.docs.put(mediaKey(office, "media-u2"), "jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const exp = Math.floor(Date.now() / 1000) + 600;
    for (const id of ["media-u1", "media-u2"]) {
      const inApp = await req(w, `/api/o/${office}/social/media/${id}`, {}, cookie);
      const signed = await req(w, `/media/${office}/${id}?exp=${exp}&sig=${await signMedia(ring("edge-media-key"), office, id, exp)}`);
      for (const r of [inApp, signed]) {
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe(FILE_CSP);
        expect([id, r.headers.get("content-type"), r.headers.get("content-disposition")]).toEqual(
          id === "media-u1" ? [id, "application/octet-stream", "attachment"] : [id, "image/jpeg", "inline"],
        );
      }
    }
  });
});

describe("document ids", () => {
  it("are a random UUID behind doc-, which the file route serves", async () => {
    const ids = Array.from({ length: 500 }, () => newDocId());
    for (const id of ids) expect(id).toMatch(/^doc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    const id = ids[0]!;
    await w.docs.put(docKey(office, id), "%PDF-1.4", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: "bill.pdf" } });
    await w.docs.put(docKey(office, `${id}.txt`), "what the voice note said", { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    expect(await (await req(w, `/api/o/${office}/files/${id}`, {}, cookie)).text()).toBe("%PDF-1.4");
    expect(await (await req(w, `/api/o/${office}/files/${id}.txt`, {}, cookie)).text()).toBe("what the voice note said");
  });

  it("lets the owner download a filing's proof, which is kept under proof-", async () => {
    const w = makeEnv();
    const { cookie, office } = await owner(w);
    const id = `proof-${crypto.randomUUID()}`;
    await w.docs.put(docKey(office, id), "%PDF-1.4 challan", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: "challan.pdf" } });
    const res = await req(w, `/api/o/${office}/files/${id}`, {}, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('inline; filename="challan.pdf"');
    expect(await res.text()).toBe("%PDF-1.4 challan");
    for (const bad of ["proof-", "media-u1", "other-1", "proofx-1"])
      expect([bad, (await req(w, `/api/o/${office}/files/${bad}`, {}, cookie)).status]).toEqual([bad, 404]);
  });
});
