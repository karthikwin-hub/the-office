import { createHmac } from "node:crypto";
import { ACCOUNT_ROUTES, LEGAL_DOCUMENTS, ROUTES } from "@office/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, purgeDeleted, receiveEmail } from "../src/app";
import { CALLER_HEADER, type Caller } from "../src/caller";
import type { Env } from "../src/env";
import { docKey, mediaKey } from "../src/keys";
import { meteredAi, QUOTA, QuotaError, take } from "../src/quota";
import { signMedia } from "../src/social/media";
import { newState } from "../src/social/oauth";
import { ControlPlane, OFFICE_ID, PURGE_AFTER_MS } from "../src/tenancy";
import { WaDirectory } from "../src/whatsapp/links";
import { d1 } from "./d1";

const BASE = "http://localhost:8787";
const SECRET = "tenancy-test-secret-not-a-real-one";
const META_SECRET = "meta-secret-for-tenancy-tests";
const SHARED = "shared-number-1";
const enc = new TextEncoder();

/** R2, in memory. */
function r2() {
  const m = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const obj = (key: string) => {
    const v = m.get(key);
    if (!v) return null;
    return { key, size: v.bytes.byteLength, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata, get body() { return new Blob([v.bytes]).stream(); }, arrayBuffer: async () => v.bytes.slice().buffer };
  };
  const bucket = {
    map: m,
    put: async (key: string, data: ArrayBuffer | string | Uint8Array, o: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}) => {
      m.set(key, { bytes: typeof data === "string" ? enc.encode(data) : new Uint8Array(data), ...o });
    },
    get: async (key: string) => obj(key),
    head: async (key: string) => obj(key),
    delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => m.delete(k)),
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => obj(k)!), truncated: false }),
  };
  return bucket;
}

type Seen = { stub: string; room: string | null; path: string; caller: Caller; body: string };
/** Durable Objects that only record what reached them, and answer with whose they are. */
function officesNs() {
  const seen: Seen[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        const caller = JSON.parse(req.headers.get(CALLER_HEADER) ?? "null") as Caller;
        seen.push({ stub: id.name, room: req.headers.get("x-partykit-room"), path, caller, body: req.method === "GET" ? "" : await req.text() });
        if (path === "/internal/export") return Response.json({ office: id.name, books: { business: { name: id.name } } });
        return Response.json({ office: id.name, path });
      },
    }),
  };
  return { seen, ns };
}

function makeEnv() {
  const db = d1();
  const docs = r2();
  const { seen, ns } = officesNs();
  const sent: { to: string; raw: string }[] = [];
  const env = {
    ASSETS: { fetch: async () => new Response("the app") },
    DB: db,
    DOCS: docs,
    AI: {},
    Office: ns,
    MAILER: { send: async (m: { to: string; raw: string }) => void sent.push(m) },
    DATA_MODE: "test",
    MAIL_FROM: "office@the-office.test",
    INGEST_DOMAIN: "in.the-office.test",
    EMAIL_VERIFICATION: "off",
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: SECRET,
    SOCIAL_TOKEN_KEY: SECRET,
    META_APP_SECRET: META_SECRET,
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_PHONE_NUMBER_ID: SHARED,
  } as unknown as Env;
  return { env, db, docs, seen, sent };
}

type World = ReturnType<typeof makeEnv>;
type Person = { cookie: string; id: string; email: string; name: string };

const call = (w: World, who: Person | null, path: string, init: RequestInit = {}) =>
  app.request(`${BASE}${path}`, { ...init, headers: { origin: BASE, ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(who ? { cookie: who.cookie } : {}), ...(init.headers as Record<string, string>) } }, w.env);

async function signUp(w: World, name: string, email: string): Promise<Person> {
  const res = await call(w, null, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ name, email, password: "a-long-password-1" }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const meRes = await call(w, { cookie } as Person, ACCOUNT_ROUTES.me);
  if (meRes.status !== 200) throw new Error(`me ${meRes.status} ${await meRes.text()} cookie=${cookie.replace(/=[^;]+/g, "=…")}`);
  const me = (await meRes.json()) as { user: { id: string } };
  return { cookie, id: me.user.id, email, name };
}

async function openOffice(w: World, who: Person, name: string): Promise<string> {
  const res = await call(w, who, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Two businesses on one backend, each with its own owner. */
async function twoOffices() {
  const w = makeEnv();
  const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
  const bina = await signUp(w, "Bina Shah", "bina@shah.test");
  const A = await openOffice(w, anil, "Kaveri Electricals");
  const B = await openOffice(w, bina, "Shah Textiles");
  return { w, anil, bina, A, B, cp: new ControlPlane(w.db) };
}

const allRoutePaths = () =>
  Object.values(ROUTES)
    .map((r) => (typeof r === "function" ? (r as (...a: string[]) => string)("x1", "x2") : r))
    .filter((p): p is string => typeof p === "string" && p.startsWith("/api/"));
const inOffice = (office: string, path: string) => path.replace(/^\/api\//, `/api/o/${office}/`);

function signedMeta(body: unknown) {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` } };
}
const waText = (from: string, text: string, phoneId = SHARED) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: from, profile: { name: "x" } }], messages: [{ id: `wamid.${Math.random()}`, from, timestamp: "1793000200", type: "text", text: { body: text } }] } }] }],
});

let graph: ReturnType<typeof vi.fn>;
beforeEach(() => {
  graph = vi.fn(async () => Response.json({ messages: [{ id: "wamid.out" }] }));
  vi.stubGlobal("fetch", graph);
});
afterEach(() => vi.unstubAllGlobals());
const repliesTo = (phone: string) => graph.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes(phone)).map(([, init]) => JSON.parse(String((init as RequestInit).body)).text?.body as string);

describe("accounts and offices", () => {
  it("shows each person only the offices they are in", async () => {
    const { w, anil, bina, A, B } = await twoOffices();
    expect(OFFICE_ID.test(A) && OFFICE_ID.test(B) && A !== B).toBe(true);
    const me = async (p: Person) => ((await (await call(w, p, ACCOUNT_ROUTES.me)).json()) as { offices: { id: string; role: string }[] }).offices;
    expect(await me(anil)).toEqual([expect.objectContaining({ id: A, role: "owner" })]);
    expect(await me(bina)).toEqual([expect.objectContaining({ id: B, role: "owner" })]);
    expect((await call(w, null, ACCOUNT_ROUTES.me)).status).toBe(401);
  });

  it("opens every office in India, with its currency, number style and clock", async () => {
    const { w, anil, A } = await twoOffices();
    const offices = ((await (await call(w, anil, ACCOUNT_ROUTES.me)).json()) as { offices: { id: string; locale: unknown }[] }).offices;
    expect(offices.find((o) => o.id === A)?.locale).toEqual({ country: "IN", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" });
  });

  it("asks for a confirmed address before opening an office, outside local tests", async () => {
    const w = makeEnv();
    (w.env as { EMAIL_VERIFICATION?: string }).EMAIL_VERIFICATION = undefined;
    const p = await signUp(w, "New Person", "new@person.test");
    const res = await call(w, p, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "Anything" }) });
    expect(res.status).toBe(403);
    expect(w.sent.some((m) => m.to === "new@person.test")).toBe(true);
  });

  it("limits how many offices one person opens in a day", async () => {
    const w = makeEnv();
    const p = await signUp(w, "Busy Person", "busy@person.test");
    for (let i = 0; i < 3; i++) await openOffice(w, p, `Office ${i}`);
    expect((await call(w, p, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "One more" }) })).status).toBe(429);
  });
});

describe("one office cannot reach another", () => {
  it("answers 404, with nothing in it, for every office route asked of someone else's office", async () => {
    const { w, bina, A } = await twoOffices();
    const paths = allRoutePaths();
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toEqual(expect.arrayContaining([ROUTES.onboardingCheck, ROUTES.onboardingStage]));
    for (const p of paths)
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const res = await call(w, bina, inOffice(A, p), { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
        expect([res.status, p, method]).toEqual([404, p, method]);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    expect(w.seen).toEqual([]);
  });

  it("sends each owner's requests only to their own office, whatever the request claims", async () => {
    const { w, anil, bina, A, B } = await twoOffices();
    const res = await call(w, bina, `${inOffice(B, ROUTES.desk)}?officeId=${A}&office=${A}`, { headers: { "x-office-as": A, "x-partykit-room": A, [CALLER_HEADER]: JSON.stringify({ officeId: A, role: "owner" }) } });
    expect(await res.json()).toEqual({ office: B, path: ROUTES.desk });
    await call(w, bina, inOffice(B, ROUTES.settings), { method: "PUT", body: JSON.stringify({ officeId: A }) });
    await call(w, anil, inOffice(A, ROUTES.desk));
    for (const s of w.seen) expect([s.stub, s.room, s.caller.officeId]).toEqual([s.stub, s.stub, s.stub]);
    expect(w.seen.map((s) => [s.stub, s.caller.email])).toEqual([[B, bina.email], [B, bina.email], [A, anil.email]]);
  });

  it("refuses ids that are not office ids, and offices that do not exist", async () => {
    const { w, anil } = await twoOffices();
    for (const id of ["..", "%2e%2e", "off_AAAAAAAAAAAAAAAA", "off_short", "kaveri", "off_aaaaaaaaaaaaaaaa"]) expect((await call(w, anil, `/api/o/${id}/desk`)).status).toBe(404);
    expect((await call(w, anil, "/api/desk")).status).toBe(404);
    expect(w.seen).toEqual([]);
  });

  it("keeps files and pictures under each office's own prefix", async () => {
    const { w, anil, bina, A, B } = await twoOffices();
    await w.docs.put(docKey(A, "doc-u1"), "A's bill", { customMetadata: { filename: "bill.pdf" } });
    await w.docs.put(mediaKey(A, "media-u1"), "A's photo");
    expect(await (await call(w, anil, `/api/o/${A}/files/doc-u1`)).text()).toBe("A's bill");
    expect((await call(w, bina, `/api/o/${A}/files/doc-u1`)).status).toBe(404);
    expect((await call(w, bina, `/api/o/${B}/files/doc-u1`)).status).toBe(404);
    expect((await call(w, bina, `/api/o/${B}/files/..%2F..%2F${A}%2Fdocs%2Fdoc-u1`)).status).toBe(404);
    expect((await call(w, anil, `/api/o/${A}/social/media/media-u1`)).status).toBe(200);
    expect((await call(w, bina, `/api/o/${B}/social/media/media-u1`)).status).toBe(404);
  });

  it("signs public picture links for one office, so they open nothing in another", async () => {
    const { w, A, B } = await twoOffices();
    await w.docs.put(mediaKey(A, "media-u1"), "A's photo");
    await w.docs.put(mediaKey(B, "media-u1"), "B's photo");
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = await signMedia(SECRET, A, "media-u1", exp);
    expect(await (await call(w, null, `/media/${A}/media-u1?exp=${exp}&sig=${sig}`)).text()).toBe("A's photo");
    expect((await call(w, null, `/media/${B}/media-u1?exp=${exp}&sig=${sig}`)).status).toBe(404);
  });

  it("opens the live connection only into the caller's own office", async () => {
    const { w, anil, bina, A } = await twoOffices();
    expect((await call(w, bina, inOffice(A, "/api/live"), { headers: { upgrade: "websocket" } })).status).toBe(404);
    await call(w, anil, inOffice(A, "/api/live"), { headers: { upgrade: "websocket" } });
    expect(w.seen.map((s) => [s.stub, s.path, s.caller.email])).toEqual([[A, "/api/live", anil.email]]);
  });

  it("finishes a channel sign-in only for an owner of the office that started it", async () => {
    const { w, anil, bina, A } = await twoOffices();
    const { state } = await newState(SECRET, "x", anil.email, A);
    const back = await call(w, bina, `/api/channels/x/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("connect_error");
    expect(w.seen).toEqual([]);
    await call(w, anil, `/api/channels/x/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([[A, "/api/channels/x/callback"]]);
  });

  it("gives each office only its own pages' webhook entries, and drops pages no one has", async () => {
    const { w, cp, A, B } = await twoOffices();
    expect(await cp.claimRoute(A, "meta_page", "page-a")).toBe(true);
    expect(await cp.claimRoute(B, "meta_page", "page-b")).toBe(true);
    expect(await cp.claimRoute(B, "meta_page", "page-a")).toBe(false);
    const entry = (id: string) => ({ id, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${id}_c`, message: "hi", from: { id: "7", name: "R" } } }] });
    const res = await call(w, null, "/api/hooks/meta", { method: "POST", ...signedMeta({ object: "page", entry: [entry("page-a"), entry("page-b"), entry("page-z")] }) });
    expect(res.status).toBe(200);
    const got = w.seen.map((s) => [s.stub, s.path, (JSON.parse(s.body) as { entry: { id: string }[] }).entry.map((e) => e.id)]);
    expect(got).toEqual([[A, "/internal/social/meta", ["page-a"]], [B, "/internal/social/meta", ["page-b"]]]);
    expect((await call(w, null, "/api/hooks/meta", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } })).status).toBe(401);
  });

  it("files emailed bills only into the office whose address they were sent to, and refuses other addresses", async () => {
    const { w, anil, A } = await twoOffices();
    const admin = (await (await call(w, anil, inOffice(A, ROUTES.officeAdmin))).json()) as { ingestEmail: string };
    expect(admin.ingestEmail).toMatch(/^kaveri-electricals-[a-z2-9]{4}@in\.the-office\.test$/);
    const mail = (to: string) => {
      const raw = ["From: Supplier <bills@supplier.test>", `To: ${to}`, "Subject: Bill", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Attached.", "--b", 'Content-Type: application/pdf; name="bill.pdf"', 'Content-Disposition: attachment; filename="bill.pdf"', "Content-Transfer-Encoding: base64", "", btoa("%PDF-1.4 a bill"), "--b--", ""].join("\r\n");
      return { from: "bills@supplier.test", to, raw: new Response(raw).body!, setReject: vi.fn() } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
    };
    const good = mail(admin.ingestEmail.toUpperCase());
    await receiveEmail(good, w.env);
    expect([...w.docs.map.keys()].every((k) => k.startsWith(`o/${A}/docs/`))).toBe(true);
    expect(w.docs.map.size).toBe(1);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([[A, "/internal/email"]]);
    const stray = mail("someone-else@in.the-office.test");
    await receiveEmail(stray, w.env);
    expect(stray.setReject).toHaveBeenCalled();
    expect(w.docs.map.size).toBe(1);
  });

  it("sends mail to a support address to that office's Customer Service agent, not its bills", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "support_email", "kaveri.help@in.the-office.test");
    const raw = ["From: Mandar Joshi <mandar@joshi.test>", "To: kaveri.help@in.the-office.test", "Subject: Damaged coils", "Message-ID: <m1@joshi.test>", "In-Reply-To: <csm-1@the-office.test>", "Content-Type: text/plain", "", "Two coils were damaged.", "", "On Mon, 2 Nov 2026 at 10:00, Kaveri wrote:", "> earlier", ""].join("\r\n");
    await receiveEmail({ from: "mandar@joshi.test", to: "Kaveri.Help@in.the-office.test", raw: new Response(raw).body!, setReject: vi.fn() } as unknown as ForwardableEmailMessage, w.env);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([[A, "/internal/support-email"]]);
    expect(JSON.parse(w.seen[0]!.body)).toMatchObject({ from: "mandar@joshi.test", name: "Mandar Joshi", subject: "Damaged coils", messageId: "<m1@joshi.test>", inReplyTo: "<csm-1@the-office.test>" });
    expect(w.docs.map.size).toBe(0);
  });
});

describe("the weather for the Lived-in office", () => {
  it("is for members only, and without a location asks nobody", async () => {
    const { w, anil, bina, A } = await twoOffices();
    const outside = vi.spyOn(globalThis, "fetch");
    const res = await call(w, anil, inOffice(A, ROUTES.weather));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weather: null });
    expect(outside).not.toHaveBeenCalled();
    expect((await call(w, bina, inOffice(A, ROUTES.weather))).status).toBe(404);
    expect(w.seen.some((s) => s.path.endsWith("/weather"))).toBe(false);
    outside.mockRestore();
  });
});

describe("a person's own rights", () => {
  const me = async (w: World, p: Person) => (await (await call(w, p, ACCOUNT_ROUTES.me)).json()) as { consentNeeded: { document: string; version: string }[]; deletionRequested: boolean };
  const current = Object.entries(LEGAL_DOCUMENTS).map(([document, d]) => ({ document, version: d.version }));

  it("asks for the current terms and privacy notice until they are accepted, and refuses an old version", async () => {
    const { w, anil } = await twoOffices();
    expect((await me(w, anil)).consentNeeded).toEqual(current);
    const old = await call(w, anil, ACCOUNT_ROUTES.consent, { method: "POST", body: JSON.stringify({ documents: [{ document: "terms", version: "2020-01-01" }] }) });
    expect(old.status).toBe(409);
    expect((await call(w, anil, ACCOUNT_ROUTES.consent, { method: "POST", body: JSON.stringify({ documents: current }), headers: { "cf-ipcountry": "IN" } })).status).toBe(200);
    expect((await me(w, anil)).consentNeeded).toEqual([]);
    expect(w.db.sqlite.prepare("SELECT document, version, country FROM consent WHERE user_id = ? ORDER BY document").all(anil.id)).toEqual(current.map((c) => ({ ...c, country: "IN" })).sort((a, b) => a.document.localeCompare(b.document)));
    w.db.sqlite.prepare("UPDATE consent SET version = '2026-01-01' WHERE user_id = ? AND document = 'privacy'").run(anil.id);
    expect((await me(w, anil)).consentNeeded.map((c) => c.document)).toEqual(["privacy"]);
  });

  it("gives a person a copy of their own account, without passwords or anyone else's data", async () => {
    const { w, anil, A } = await twoOffices();
    const res = await call(w, anil, ACCOUNT_ROUTES.accountExport);
    expect(res.headers.get("content-disposition")).toContain("my-account.json");
    const text = await res.text();
    const data = JSON.parse(text) as { account: { email: string }; offices: { id: string }[]; sessions: unknown[] };
    expect(data.account.email).toBe(anil.email);
    expect(data.offices.map((o) => o.id)).toEqual([A]);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/password"\s*:|token|bina/i);
  });

  it("records a deletion request in every office's audit, refuses the only owner, and lets the request be withdrawn", async () => {
    const { w, anil, bina, A, cp } = await twoOffices();
    const ask = (p: Person) => call(w, p, ACCOUNT_ROUTES.accountRequests, { method: "POST", body: JSON.stringify({ kind: "delete" }) });
    const sole = await ask(anil);
    expect(sole.status).toBe(409);
    expect(((await sole.json()) as { error: string }).error).toContain("Kaveri Electricals");
    const { token } = await cp.invite(A, "carol@ca.test", "accountant", anil.email);
    const carol = await signUp(w, "Carol", "carol@ca.test");
    expect((await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
    const made = await ask(carol);
    expect(made.status).toBe(201);
    const r = (await made.json()) as { id: string; status: string };
    expect(r.status).toBe("open");
    expect((await ask(carol)).status).toBe(201);
    expect((await me(w, carol)).deletionRequested).toBe(true);
    expect((await cp.auditTrail(A)).some((a) => a.action === "member.deletion-requested" && a.actor === "carol@ca.test")).toBe(true);
    expect((await call(w, bina, `${ACCOUNT_ROUTES.accountRequests}/${r.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(w, carol, `${ACCOUNT_ROUTES.accountRequests}/${r.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await me(w, carol)).deletionRequested).toBe(false);
  });
});

describe("the website chat", () => {
  const post = (w: World, key: string, body: unknown, ip = "203.0.113.9") => call(w, null, `/api/chat/${key}`, { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } });
  const visitor = "visitor-aaaaaaaaaaaaaaaa";

  it("serves the script and takes messages only for a key that is switched on, without anyone signed in", async () => {
    const { w, cp, A } = await twoOffices();
    expect((await call(w, null, "/w/wkaverichat01.js")).status).toBe(404);
    expect((await post(w, "wkaverichat01", { visitor, text: "hi" })).status).toBe(404);
    await cp.claimRoute(A, "widget", "wkaverichat01");
    const js = await call(w, null, "/w/wkaverichat01.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain('"key":"wkaverichat01"');
    const res = await post(w, "wkaverichat01", { visitor, text: "Do you deliver to Satara?" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(w.seen.map((s) => [s.stub, s.path, s.caller.role])).toEqual([[A, "/internal/chat", "owner"]]);
    expect(JSON.parse(w.seen[0]!.body)).toEqual({ visitor, text: "Do you deliver to Satara?", name: null });
    expect((await post(w, "wkaverichat01", { visitor: "short", text: "hi" })).status).toBe(400);
  });

  it("stops a visitor at the rate limit, and asks for Turnstile when it is set up", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "widget", "wkaverichat01");
    let calls = 0;
    (w.env as { CHAT_LIMIT?: unknown }).CHAT_LIMIT = { limit: async ({ key }: { key: string }) => ({ success: key.endsWith("203.0.113.9") && ++calls <= 2 }) };
    expect((await post(w, "wkaverichat01", { visitor, text: "one" })).status).toBe(200);
    expect((await post(w, "wkaverichat01", { visitor, text: "two" })).status).toBe(200);
    expect((await post(w, "wkaverichat01", { visitor, text: "three" })).status).toBe(429);
    (w.env as { CHAT_LIMIT?: unknown }).CHAT_LIMIT = undefined;
    (w.env as { TURNSTILE_SECRET?: string }).TURNSTILE_SECRET = "turnstile-test";
    expect((await post(w, "wkaverichat01", { visitor, text: "no token" })).status).toBe(403);
    graph.mockImplementationOnce(async () => Response.json({ success: true }));
    expect((await post(w, "wkaverichat01", { visitor, text: "with token", turnstile: "tok" })).status).toBe(200);
    expect(w.seen.filter((s) => s.path === "/internal/chat")).toHaveLength(3);
  });
});

describe("the shared WhatsApp number", () => {
  const PHONE = "919822012345";
  it("links with a code, sends each message to the office the person chose, and switches on request", async () => {
    const { w, anil, bina, A, B, cp } = await twoOffices();
    const dir = new WaDirectory(w.db);
    const hook = (text: string, from = PHONE) => call(w, null, "/api/hooks/meta", { method: "POST", ...signedMeta(waText(from, text)) });

    await hook("JOIN 123456");
    expect(repliesTo(PHONE).at(-1)).toContain("wrong");
    expect(w.seen).toEqual([]);

    const { code } = await dir.newJoinCode(A, anil.id);
    await hook(`JOIN ${code}`);
    expect(w.seen.map((s) => [s.stub, s.path, JSON.parse(s.body).joined, JSON.parse(s.body).person.userId])).toEqual([[A, "/internal/whatsapp", true, anil.id]]);

    await hook("desk");
    expect(JSON.parse(w.seen.at(-1)!.body).heading).toBeUndefined();

    const { token } = await cp.invite(B, anil.email, "accountant", bina.email);
    expect((await call(w, anil, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
    await hook("desk");
    expect([w.seen.at(-1)!.stub, JSON.parse(w.seen.at(-1)!.body).heading]).toEqual([A, "Kaveri Electricals"]);

    const before = w.seen.length;
    await hook("switch");
    expect(repliesTo(PHONE).at(-1)).toBe("You are in these offices:\n1. Kaveri Electricals ✓\n2. Shah Textiles\nReply switch and a number, like switch 2.");
    await hook("switch 2");
    expect(repliesTo(PHONE).at(-1)).toContain("Now talking to Shah Textiles");
    expect(w.seen.length).toBe(before);
    await hook("desk");
    expect([w.seen.at(-1)!.stub, JSON.parse(w.seen.at(-1)!.body).person.role]).toEqual([B, "accountant"]);

    await hook("desk", "919000000009");
    expect(w.seen.at(-1)!.stub).toBe(B);
    expect(w.seen.filter((s) => JSON.parse(s.body).person?.phone === "919000000009")).toEqual([]);
  });

  it("stops sending to an office someone has left", async () => {
    const { w, anil, bina, A, B, cp } = await twoOffices();
    const dir = new WaDirectory(w.db);
    await cp.invite(B, anil.email, "accountant", bina.email).then(({ token }) => call(w, anil, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) }));
    await dir.redeem(PHONE, (await dir.newJoinCode(B, anil.id)).code);
    expect((await call(w, anil, inOffice(B, ROUTES.officeLeave), { method: "POST" })).status).toBe(200);
    await call(w, null, "/api/hooks/meta", { method: "POST", ...signedMeta(waText(PHONE, "desk")) });
    expect(w.seen.map((s) => s.stub)).toEqual([A]);
  });
});

describe("people in an office", () => {
  it("invites by link for one address, once, and the accountant sees the office but not its administration", async () => {
    const { w, anil, bina, A } = await twoOffices();
    const inv = (await (await call(w, anil, inOffice(A, ROUTES.officeInvitations), { method: "POST", body: JSON.stringify({ email: "carol@firm.test", role: "accountant" }) })).json()) as { link: string; emailed: boolean };
    expect(inv.emailed).toBe(true);
    const token = new URL(inv.link).searchParams.get("invite")!;
    expect(await (await call(w, bina, ACCOUNT_ROUTES.invitation(token))).json()).toEqual({ officeName: "Kaveri Electricals", email: "carol@firm.test", role: "accountant" });
    expect((await call(w, bina, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(403);
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    expect(await (await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).json()).toEqual({ officeId: A, role: "accountant" });
    expect((await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(403);

    const admin = (await (await call(w, carol, inOffice(A, ROUTES.officeAdmin))).json()) as { members: unknown[]; invitations: unknown[]; audit: unknown[] };
    expect([admin.members.length, admin.invitations, admin.audit]).toEqual([2, [], []]);
    expect((await call(w, carol, inOffice(A, ROUTES.officeAdmin), { method: "PATCH", body: JSON.stringify({ name: "Mine now" }) })).status).toBe(403);
    expect((await call(w, carol, inOffice(A, ROUTES.officeInvitations), { method: "POST", body: JSON.stringify({ email: "x@y.test" }) })).status).toBe(403);
    expect((await call(w, carol, inOffice(A, ROUTES.officeExport))).status).toBe(403);
  });

  it("keeps an owner, hands the office over, and removes people", async () => {
    const { w, anil, A, cp } = await twoOffices();
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    const { token } = await cp.invite(A, carol.email, "accountant", anil.email);
    await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) });
    expect((await call(w, anil, inOffice(A, ROUTES.officeMember(anil.id)), { method: "PUT", body: JSON.stringify({ role: "accountant" }) })).status).toBe(409);
    expect((await call(w, anil, inOffice(A, ROUTES.officeLeave), { method: "POST" })).status).toBe(409);
    expect((await call(w, anil, inOffice(A, ROUTES.officeTransfer), { method: "POST", body: JSON.stringify({ userId: carol.id }) })).status).toBe(200);
    expect((await cp.membership(A, anil.id))?.role).toBe("accountant");
    expect((await call(w, carol, inOffice(A, ROUTES.officeMember(anil.id)), { method: "DELETE" })).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect((await cp.auditTrail(A)).map((a) => a.action)).toEqual(expect.arrayContaining(["office.opened", "invitation.sent", "invitation.accepted", "office.transferred", "member.removed"]));
  });

  it("exports only the office's own books and files", async () => {
    const { w, anil, A, B } = await twoOffices();
    await w.docs.put(docKey(A, "doc-u1"), "A's bill");
    await w.docs.put(docKey(B, "doc-u2"), "B's bill");
    const res = await call(w, anil, inOffice(A, ROUTES.officeExport));
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = new TextDecoder("latin1").decode(await res.arrayBuffer());
    expect(bytes).toContain("books.json");
    expect(bytes).toContain("files/docs/doc-u1");
    expect(bytes).toContain("A's bill");
    expect(bytes).not.toContain("B's bill");
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([[A, "/internal/export"]]);
  });
});

describe("suspending, deleting and purging", () => {
  it("hides a deleted office from everyone at once, lets the owner restore it, and purges it after 30 days", async () => {
    const { w, anil, bina, A, B, cp } = await twoOffices();
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    await cp.invite(A, carol.email, "accountant", anil.email).then(({ token }) => call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) }));
    await w.docs.put(docKey(A, "doc-u1"), "A's bill");
    await w.docs.put(docKey(B, "doc-u2"), "B's bill");
    await cp.claimRoute(A, "meta_page", "page-a");

    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri" }) })).status).toBe(400);
    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) })).status).toBe(200);
    expect((await call(w, carol, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect(await cp.routeFor("meta_page", "page-a")).toBeNull();
    expect(((await (await call(w, carol, ACCOUNT_ROUTES.me)).json()) as { offices: unknown[] }).offices).toEqual([]);
    expect(((await (await call(w, anil, ACCOUNT_ROUTES.me)).json()) as { offices: unknown[] }).offices).toEqual([expect.objectContaining({ id: A, status: "deleting" })]);
    expect(((await (await call(w, anil, inOffice(A, ROUTES.officeAdmin))).json()) as { purgeAt: string | null }).purgeAt).not.toBeNull();
    expect((await call(w, anil, inOffice(A, ROUTES.officeRestore), { method: "POST" })).status).toBe(200);
    expect((await call(w, carol, inOffice(A, ROUTES.desk))).status).toBe(200);

    await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) });
    expect(await purgeDeleted(w.env)).toBe(0);
    w.db.sqlite.prepare("UPDATE office SET deleted_at = ? WHERE id = ?").run(Date.now() - PURGE_AFTER_MS - 1, A);
    w.seen.length = 0;
    expect(await purgeDeleted(w.env)).toBe(1);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([[A, "/internal/purge"]]);
    expect([...w.docs.map.keys()]).toEqual([docKey(B, "doc-u2")]);
    expect(await cp.office(A)).toBeNull();
    expect(await cp.membership(A, carol.id)).toBeNull();
    expect((await call(w, bina, inOffice(B, ROUTES.desk))).status).toBe(200);
  });

  it("closes a suspended office to its own people without saying so to anyone else", async () => {
    const { w, anil, bina, A, cp } = await twoOffices();
    await cp.setStatus(A, "suspended", "admin");
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(423);
    expect((await call(w, bina, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect(w.seen).toEqual([]);
  });
});

describe("quotas", () => {
  it("counts each office's AI calls and uploads per day, and stops at the limit", async () => {
    const store = new Map<string, string>();
    const kv = (k: string, v?: string) => (v !== undefined && store.set(k, v), store.get(k) ?? null);
    const run = vi.fn(async () => ({ response: "{}" }));
    const ai = meteredAi({ run } as unknown as Ai, () => take(kv, "2026-11-05", "ai"));
    for (let i = 0; i < QUOTA.aiCalls; i++) await ai.run("@cf/x" as never, {} as never);
    expect(() => ai.run("@cf/x" as never, {} as never)).toThrow(QuotaError);
    expect(run).toHaveBeenCalledTimes(QUOTA.aiCalls);
    take(kv, "2026-11-05", "upload", QUOTA.uploadBytes - 10);
    expect(() => take(kv, "2026-11-05", "upload", 11)).toThrow(QuotaError);
    expect(() => take(kv, "2026-11-06", "upload", 11)).not.toThrow();
  });

  it("leaves an office without Workers AI reading text layers only", () => {
    expect(meteredAi(undefined as unknown as Ai, () => undefined)).toBeUndefined();
  });
});
