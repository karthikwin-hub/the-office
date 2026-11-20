import { createHash, createHmac } from "node:crypto";
import { ACCOUNT_ROUTES, LEGAL_DOCUMENTS, PLATFORM_ROUTES, type PlatformInvited, type PlatformView, ROUTES, subdomainProblem } from "@office/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, eraseBackups, purgeDeleted, receiveEmail, sweepRetained } from "../src/app";
import { authScope } from "../src/auth";
import { CALLER_HEADER, type Caller } from "../src/caller";
import { CALLER_SEAL_HEADER, callerSealed } from "../src/caller-seal";
import type { Env } from "../src/env";
import { OfficeExports } from "../src/export";
import { rootKeys } from "../src/keyring";
import { docKey, mediaKey } from "../src/keys";
import { meteredAi, QUOTA, QuotaError, take } from "../src/quota";
import { signMedia } from "../src/social/media";
import { newState } from "../src/social/oauth";
import { ControlPlane, OFFICE_ID, PURGE_AFTER_MS } from "../src/tenancy";
import { WaDirectory } from "../src/whatsapp/links";
import { d1 } from "./d1";
import { enrolTwoFactor, totp } from "./two-factor";

/** Root keys as the Worker reads them: the current one, then any it replaced. */
const ring = (current: string, ...old: string[]) => rootKeys({ SOCIAL_TOKEN_KEY: current, SOCIAL_TOKEN_KEYS_OLD: old.join(",") })!;

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
    return {
      key,
      size: v.bytes.byteLength,
      httpMetadata: v.httpMetadata,
      customMetadata: v.customMetadata,
      get body() {
        return new Blob([v.bytes]).stream();
      },
      arrayBuffer: async () => v.bytes.slice().buffer,
    };
  };
  const bucket = {
    map: m,
    put: async (key: string, data: ArrayBuffer | string | Uint8Array, o: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}) => {
      m.set(key, { bytes: typeof data === "string" ? enc.encode(data) : new Uint8Array(data), ...o });
    },
    get: async (key: string) => obj(key),
    head: async (key: string) => obj(key),
    delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => m.delete(k)),
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => obj(k)!),
      truncated: false,
    }),
  };
  return bucket;
}

/**
 * An S3-compatible bucket in India, in memory: ListObjectsV2 in pages of 1,000 and DeleteObjects. `refuse`
 * answers 403, as a key without delete permission would. Node has no MD5 in WebCrypto, which Workers do; the
 * request's Content-MD5 is checked here with Node's.
 */
function indiaStore() {
  const keys = new Set<string>();
  const deletes: number[] = [];
  const state = { keys, deletes, refuse: false, fetch: async (_u: URL | string, _i?: RequestInit) => new Response() };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (alg, data) =>
    alg === "MD5"
      ? new Uint8Array(
          createHash("md5")
            .update(new Uint8Array(data as ArrayBuffer))
            .digest(),
        ).buffer
      : digest(alg, data),
  );
  state.fetch = async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    if (state.refuse) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const h = init?.headers as Record<string, string>;
    if (!h.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return new Response("unsigned", { status: 403 });
    if (init?.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...keys].filter((k) => k.startsWith(prefix)).sort();
      const page = all.slice(0, 1000);
      const more = all.length > 1000;
      return new Response(
        `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}${more ? "<NextContinuationToken>t</NextContinuationToken>" : ""}</ListBucketResult>`,
      );
    }
    if (init?.method === "POST" && url.searchParams.has("delete")) {
      const body = new Uint8Array(init.body as ArrayBuffer);
      if (h["content-md5"] !== createHash("md5").update(body).digest("base64")) return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
      const asked = [...new TextDecoder().decode(body).matchAll(/<Key>(.*?)<\/Key>/g)].map((m) => m[1]!);
      deletes.push(asked.length);
      for (const k of asked) keys.delete(k);
      return new Response("<DeleteResult></DeleteResult>");
    }
    return new Response("not here", { status: 404 });
  };
  return state;
}

type Seen = { stub: string; room: string | null; path: string; caller: Caller; body: string; sealed: boolean };
/**
 * Durable Objects that only record what reached them, and answer with whose they are. They take mail unless `mail.admit`
 * says not, and write exports with the office's own export code.
 */
function officesNs(docs: ReturnType<typeof r2>) {
  const seen: Seen[] = [];
  const mail = { admit: true, storedBeforeAsked: [] as number[] };
  const exports = new Map<string, OfficeExports>();
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        const caller = JSON.parse(req.headers.get(CALLER_HEADER) ?? "null") as Caller;
        const sealed = await callerSealed(SECRET, req.headers.get(CALLER_HEADER) ?? "", req.headers.get(CALLER_SEAL_HEADER));
        seen.push({ stub: id.name, room: req.headers.get("x-partykit-room"), path, caller, body: req.method === "GET" ? "" : await req.text(), sealed });
        if (path === "/internal/export/plan") {
          if (!exports.has(id.name)) exports.set(id.name, new OfficeExports(docs as unknown as R2Bucket));
          return Response.json(await exports.get(id.name)!.plan(id.name, { office: id.name, books: { business: { name: id.name } } }));
        }
        if (path === "/internal/export/part") {
          const { id: exportId, part } = JSON.parse(seen.at(-1)!.body) as { id: string; part: number };
          return exports.get(id.name)?.part(exportId, part) ?? Response.json({ error: "No such export." }, { status: 410 });
        }
        if (path === "/internal/mail-admit") {
          mail.storedBeforeAsked.push(docs.map.size);
          return Response.json({ admit: mail.admit });
        }
        return Response.json({ office: id.name, path });
      },
    }),
  };
  return { seen, ns, mail };
}

function makeEnv() {
  const db = d1();
  const docs = r2();
  const { seen, ns, mail } = officesNs(docs);
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
  return { env, db, docs, seen, sent, mail };
}

type World = ReturnType<typeof makeEnv>;
type Person = { cookie: string; id: string; email: string; name: string; uri?: string };

const call = (w: World, who: Person | null, path: string, init: RequestInit = {}) =>
  app.request(
    `${BASE}${path}`,
    {
      ...init,
      headers: {
        origin: BASE,
        ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...(who ? { cookie: who.cookie } : {}),
        ...(init.headers as Record<string, string>),
      },
    },
    w.env,
  );

async function signUp(w: World, name: string, email: string): Promise<Person> {
  const res = await call(w, null, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ name, email, password: "a-long-password-1" }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers as unknown as { getSetCookie(): string[] })
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const meRes = await call(w, { cookie } as Person, ACCOUNT_ROUTES.me);
  if (meRes.status !== 200) throw new Error(`me ${meRes.status} ${await meRes.text()} cookie=${cookie.replace(/=[^;]+/g, "=…")}`);
  const me = (await meRes.json()) as { user: { id: string } };
  return { cookie, id: me.user.id, email, name };
}

/** Owners need two-factor sign-in before anything owner-only; this turns it on and keeps the new session. */
async function twoStep(w: World, who: Person): Promise<Person> {
  const enrolled = await enrolTwoFactor(
    (path, body, cookie) => call(w, { cookie } as Person, path, { method: "POST", body: JSON.stringify(body) }),
    who.cookie,
    "a-long-password-1",
  );
  Object.assign(who, { cookie: enrolled.cookie, uri: enrolled.uri });
  return who;
}

async function openOffice(w: World, who: Person, name: string): Promise<string> {
  const res = await call(w, who, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name }) });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const enrolled = w.db.sqlite.prepare("SELECT two_factor_enabled AS enabled FROM user WHERE id = ?").get(who.id) as { enabled: number };
  if (!enrolled.enabled) await twoStep(w, who);
  return id;
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
/** The text of a sent email, and the invitation token in its link. */
const mailText = (m: { raw: string }) => Buffer.from(m.raw.split("\r\n\r\n")[1]!, "base64").toString();
const inviteIn = (text: string) => decodeURIComponent(/[?#]invite=([^\s&]+)/.exec(text)![1]!);

const inOffice = (office: string, path: string) => path.replace(/^\/api\//, `/api/o/${office}/`);

function signedMeta(body: unknown) {
  const raw = JSON.stringify(body);
  return {
    body: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` },
  };
}
const waText = (from: string, text: string, phoneId = SHARED) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: phoneId },
            contacts: [{ wa_id: from, profile: { name: "x" } }],
            messages: [{ id: `wamid.${Math.random()}`, from, timestamp: "1793000200", type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

let graph: ReturnType<typeof vi.fn>;
beforeEach(() => {
  graph = vi.fn(async () => Response.json({ messages: [{ id: "wamid.out" }] }));
  vi.stubGlobal("fetch", graph);
});
afterEach(() => (vi.unstubAllGlobals(), vi.restoreAllMocks()));
const repliesTo = (phone: string) =>
  graph.mock.calls
    .filter(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes(phone))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).text?.body as string);

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
    // Signed in before confirming (as sign-ups were before confirmation was required to sign in).
    const p = await signUp(w, "New Person", "new@person.test");
    (w.env as { EMAIL_VERIFICATION?: string }).EMAIL_VERIFICATION = undefined;
    const res = await call(w, p, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "Anything" }) });
    expect(res.status).toBe(403);
    // Making an account now signs no one in; the link in the email does.
    const made = await call(w, null, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: "Other Person", email: "other@person.test", password: "a-long-password-1" }),
    });
    expect(await made.json()).toMatchObject({ token: null });
    expect(w.sent.some((m) => m.to === "other@person.test")).toBe(true);
  });

  it("limits how many offices one person opens in a day", async () => {
    const w = makeEnv();
    const p = await signUp(w, "Busy Person", "busy@person.test");
    for (let i = 0; i < 3; i++) await openOffice(w, p, `Office ${i}`);
    expect((await call(w, p, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "One more" }) })).status).toBe(429);
  });
});

describe("a forgotten password", () => {
  /** The plain-text body of a message the Worker sent, decoded from base64. */
  const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, ""), "base64").toString("utf8");
  const signIn = (w: World, email: string, password: string) =>
    call(w, null, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });

  it("sends a link that sets a new password once, and signs the old sessions out", async () => {
    const w = makeEnv();
    const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
    const asked = await call(w, null, "/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email: anil.email, redirectTo: `${BASE}/?reset-password=1` }),
    });
    expect(asked.status).toBe(200);
    const mail = w.sent.filter((m) => m.to === anil.email).pop()!;
    const link = /https?:\/\/\S+\/api\/auth\/reset-password\/\S+/.exec(bodyOf(mail.raw))![0];

    const back = await call(w, null, link.slice(BASE.length), { redirect: "manual" });
    const landing = new URL(back.headers.get("location")!);
    expect(landing.searchParams.get("reset-password")).toBe("1");
    const token = landing.searchParams.get("token")!;
    expect(token).toBeTruthy();

    const changed = await call(w, null, "/api/auth/reset-password", { method: "POST", body: JSON.stringify({ newPassword: "a-new-long-password-2", token }) });
    expect(changed.status).toBe(200);
    expect((await call(w, anil, ACCOUNT_ROUTES.me)).status).toBe(401);
    expect((await signIn(w, anil.email, "a-long-password-1")).status).toBe(401);
    expect((await signIn(w, anil.email, "a-new-long-password-2")).status).toBe(200);

    const again = await call(w, null, "/api/auth/reset-password", { method: "POST", body: JSON.stringify({ newPassword: "a-third-long-password-3", token }) });
    expect(again.status).toBe(400);
  });

  it("answers the same for an address with no account, and sends nothing", async () => {
    const w = makeEnv();
    const res = await call(w, null, "/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email: "nobody@nowhere.test", redirectTo: `${BASE}/?reset-password=1` }),
    });
    expect(res.status).toBe(200);
    expect(w.sent).toEqual([]);
  });

  it("will not send the link on to another site", async () => {
    const w = makeEnv();
    const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
    const res = await call(w, null, "/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email: anil.email, redirectTo: "https://evil.test/?reset-password=1" }),
    });
    expect(res.status).toBe(403);
    expect(w.sent.filter((m) => m.to === anil.email)).toEqual([]);
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
    // About 500 requests, each signed in through Better Auth.
  }, 20_000);

  it("sends each owner's requests only to their own office, whatever the request claims", async () => {
    const { w, anil, bina, A, B } = await twoOffices();
    const res = await call(w, bina, `${inOffice(B, ROUTES.desk)}?officeId=${A}&office=${A}`, {
      headers: { "x-office-as": A, "x-partykit-room": A, [CALLER_HEADER]: JSON.stringify({ officeId: A, role: "owner" }) },
    });
    expect(await res.json()).toEqual({ office: B, path: ROUTES.desk });
    await call(w, bina, inOffice(B, ROUTES.settings), { method: "PUT", body: JSON.stringify({ officeId: A }) });
    await call(w, anil, inOffice(A, ROUTES.desk));
    for (const s of w.seen) expect([s.stub, s.room, s.caller.officeId]).toEqual([s.stub, s.stub, s.stub]);
    expect(w.seen.map((s) => [s.stub, s.caller.email])).toEqual([
      [B, bina.email],
      [B, bina.email],
      [A, anil.email],
    ]);
  });

  it("seals every caller it sends to an office, and never passes on a caller or seal the browser sent", async () => {
    const { w, anil, A } = await twoOffices();
    const forged = JSON.stringify({ userId: "system", name: "x", email: "x@x", role: "owner", officeId: A });
    await call(w, anil, `${inOffice(A, ROUTES.desk)}`, {
      headers: { [CALLER_HEADER]: forged, [CALLER_SEAL_HEADER]: "forged-seal-forged-seal-forged-seal-forged" },
    });
    await (await call(w, anil, inOffice(A, ROUTES.officeExport))).arrayBuffer();
    expect(w.seen.map((s) => [s.path, s.caller.userId, s.sealed])).toEqual([
      ["/api/desk", anil.id, true],
      ["/internal/export/plan", "system", true],
      ["/internal/export/part", "system", true],
    ]);
  });

  it("refuses ids that are not office ids, and offices that do not exist", async () => {
    const { w, anil } = await twoOffices();
    for (const id of ["..", "%2e%2e", "off_AAAAAAAAAAAAAAAA", "off_short", "kaveri", "off_aaaaaaaaaaaaaaaa"])
      expect((await call(w, anil, `/api/o/${id}/desk`)).status).toBe(404);
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
    const sig = await signMedia(ring(SECRET), A, "media-u1", exp);
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
    const { state } = await newState(ring(SECRET), "x", anil.email, A);
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
    const entry = (id: string) => ({
      id,
      changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${id}_c`, message: "hi", from: { id: "7", name: "R" } } }],
    });
    const res = await call(w, null, "/api/hooks/meta", {
      method: "POST",
      ...signedMeta({ object: "page", entry: [entry("page-a"), entry("page-b"), entry("page-z")] }),
    });
    expect(res.status).toBe(200);
    const got = w.seen.map((s) => [s.stub, s.path, (JSON.parse(s.body) as { entry: { id: string }[] }).entry.map((e) => e.id)]);
    expect(got).toEqual([
      [A, "/internal/social/meta", ["page-a"]],
      [B, "/internal/social/meta", ["page-b"]],
    ]);
    expect((await call(w, null, "/api/hooks/meta", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } })).status).toBe(401);
  });

  it("files emailed bills only into the office whose address they were sent to, and refuses other addresses", async () => {
    const { w, anil, A } = await twoOffices();
    const admin = (await (await call(w, anil, inOffice(A, ROUTES.officeAdmin))).json()) as { ingestEmail: string };
    expect(admin.ingestEmail).toMatch(/^kaveri-electricals-[a-z2-9]{4}@in\.the-office\.test$/);
    const mail = (to: string) => {
      const raw = [
        "From: Supplier <bills@supplier.test>",
        `To: ${to}`,
        "Subject: Bill",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Attached.",
        "--b",
        'Content-Type: application/pdf; name="bill.pdf"',
        'Content-Disposition: attachment; filename="bill.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("%PDF-1.4 a bill"),
        "--b--",
        "",
      ].join("\r\n");
      return { from: "bills@supplier.test", to, raw: new Response(raw).body!, setReject: vi.fn() } as unknown as ForwardableEmailMessage & {
        setReject: ReturnType<typeof vi.fn>;
      };
    };
    const good = mail(admin.ingestEmail.toUpperCase());
    await receiveEmail(good, w.env);
    expect([...w.docs.map.keys()].every((k) => k.startsWith(`o/${A}/docs/`))).toBe(true);
    expect(w.docs.map.size).toBe(1);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([
      [A, "/internal/mail-admit"],
      [A, "/internal/email"],
    ]);
    const stray = mail("someone-else@in.the-office.test");
    await receiveEmail(stray, w.env);
    expect(stray.setReject).toHaveBeenCalled();
    expect(w.docs.map.size).toBe(1);
  });

  it("sends mail to a support address to that office's Customer Service agent, not its bills", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "support_email", "kaveri.help@in.the-office.test");
    const raw = [
      "From: Mandar Joshi <mandar@joshi.test>",
      "To: kaveri.help@in.the-office.test",
      "Subject: Damaged coils",
      "Message-ID: <m1@joshi.test>",
      "In-Reply-To: <csm-1@the-office.test>",
      "Content-Type: text/plain",
      "",
      "Two coils were damaged.",
      "",
      "On Mon, 2 Nov 2026 at 10:00, Kaveri wrote:",
      "> earlier",
      "",
    ].join("\r\n");
    await receiveEmail(
      {
        from: "mandar@joshi.test",
        to: "Kaveri.Help@in.the-office.test",
        raw: new Response(raw).body!,
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage,
      w.env,
    );
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([
      [A, "/internal/mail-admit"],
      [A, "/internal/support-email"],
    ]);
    expect(JSON.parse(w.seen[1]!.body)).toMatchObject({
      from: "mandar@joshi.test",
      name: "Mandar Joshi",
      subject: "Damaged coils",
      messageId: "<m1@joshi.test>",
      inReplyTo: "<csm-1@the-office.test>",
    });
    expect(w.docs.map.size).toBe(0);
  });
});

describe("the sales address", () => {
  it("takes spreadsheets to that office's Marketplace Manager, while the bills address still skips them", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "sales_email", "kaveri.sales@in.the-office.test");
    const raw = (to: string) =>
      [
        "From: Amazon Seller Central <no-reply@amazon.in>",
        `To: ${to}`,
        "Subject: Your report is ready",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Attached.",
        "--b",
        'Content-Type: text/csv; name="MTR.csv"',
        'Content-Disposition: attachment; filename="MTR.csv"',
        "",
        "Order Id,Quantity",
        "--b--",
        "",
      ].join("\r\n");
    await receiveEmail(
      {
        from: "no-reply@amazon.in",
        to: "kaveri.sales@in.the-office.test",
        raw: new Response(raw("kaveri.sales@in.the-office.test")).body!,
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage,
      w.env,
    );
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([
      [A, "/internal/mail-admit"],
      [A, "/internal/sales-email"],
    ]);
    expect(JSON.parse(w.seen[1]!.body)).toMatchObject({ from: "no-reply@amazon.in", docs: [{ filename: "MTR.csv" }], skipped: [] });
    expect([...w.docs.map.keys()].every((k) => k.startsWith(`o/${A}/docs/`))).toBe(true);
  });
});

describe("the assistant's address", () => {
  it("takes an owner's forwarded mail to that office's assistant, with what Cloudflare found of its sender", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "assistant_email", "kaveri.assistant@in.the-office.test");
    const raw = (top: string[]) =>
      [
        ...top,
        "From: Anil <anil@kaverielectricals.in>",
        "To: kaveri.assistant@in.the-office.test",
        "Subject: Fwd: Statement please",
        "Content-Type: text/plain",
        "",
        "---------- Forwarded message ---------",
        "From: Rakesh <rakesh@sharma.test>",
        "Subject: Statement please",
        "",
        "Please send it.",
        "",
      ].join("\r\n");
    const envelope = "anil+caf_=kaveri.assistant=in.the-office.test@kaverielectricals.in";
    const send = (top: string[], results?: string) =>
      receiveEmail(
        {
          from: envelope,
          to: "kaveri.assistant@in.the-office.test",
          headers: new Headers({
            "x-forwarded-for": "anil@kaverielectricals.in kaveri.assistant@in.the-office.test",
            ...(results ? { "authentication-results": results } : {}),
          }),
          raw: new Response(raw(top)).body!,
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        w.env,
      );
    const stamp = "mx.cloudflare.net; dkim=pass header.d=kaverielectricals.in; spf=pass; dmarc=pass";
    await send([`Authentication-Results: ${stamp}`], stamp);
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([
      [A, "/internal/mail-admit"],
      [A, "/internal/assistant-email"],
    ]);
    const proven = JSON.parse(w.seen[1]!.body);
    expect(proven).toMatchObject({ envelope, from: "anil@kaverielectricals.in", subject: "Fwd: Statement please", authenticated: true, envelopeSigned: true });
    expect(proven).not.toHaveProperty("forwardedFor");
    // The same message with a forwarding header naming the owner, but nothing from Cloudflare to back it.
    await send([
      "X-Forwarded-For: anil@kaverielectricals.in kaveri.assistant@in.the-office.test",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=kaverielectricals.in; spf=pass; dmarc=pass",
    ]);
    expect(JSON.parse(w.seen[3]!.body)).toMatchObject({ authenticated: false, envelopeSigned: false });
  });

  it("tells the office when a bill's sender could not be verified", async () => {
    const { w, anil, A } = await twoOffices();
    const admin = (await (await call(w, anil, inOffice(A, ROUTES.officeAdmin))).json()) as { ingestEmail: string };
    const raw = (top: string[]) =>
      [...top, "From: Supplier <bills@supplier.test>", `To: ${admin.ingestEmail}`, "Subject: Bill", "Content-Type: text/plain", "", "Attached.", ""].join(
        "\r\n",
      );
    const send = (results: string[]) => {
      const headers = new Headers();
      for (const r of results) headers.append("authentication-results", r);
      return receiveEmail(
        {
          from: "bills@supplier.test",
          to: admin.ingestEmail,
          headers,
          raw: new Response(raw(results.map((r) => `Authentication-Results: ${r}`))).body!,
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        w.env,
      );
    };
    await send(["mx.cloudflare.net; dmarc=pass header.from=supplier.test"]);
    await send(["mx.cloudflare.net; dmarc=fail header.from=supplier.test", "mx.cloudflare.net; dmarc=pass"]);
    const bodies = w.seen.filter((s) => s.path === "/internal/email").map((s) => JSON.parse(s.body) as { authenticated: boolean });
    expect(bodies.map((b) => b.authenticated)).toEqual([true, false]);
  });

  it("asks the office before storing anything of a message, and stores nothing it refuses", async () => {
    const { w, anil, cp, A } = await twoOffices();
    const admin = (await (await call(w, anil, inOffice(A, ROUTES.officeAdmin))).json()) as { ingestEmail: string };
    await cp.claimRoute(A, "sales_email", "kaveri.sales@in.the-office.test");
    await cp.claimRoute(A, "assistant_email", "kaveri.assistant@in.the-office.test");
    const raw = (to: string) =>
      [
        "From: Someone <x@attacker.test>",
        `To: ${to}`,
        "Subject: Bill",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        'Content-Type: application/pdf; name="bill.pdf"',
        'Content-Disposition: attachment; filename="bill.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("%PDF-1.4 a bill"),
        "--b",
        'Content-Type: text/csv; name="r.csv"',
        'Content-Disposition: attachment; filename="r.csv"',
        "",
        "a,b",
        "--b--",
        "",
      ].join("\r\n");
    const send = (to: string) =>
      receiveEmail({ from: "x@attacker.test", to, raw: new Response(raw(to)).body!, setReject: vi.fn() } as unknown as ForwardableEmailMessage, w.env);
    w.mail.admit = false;
    for (const to of [admin.ingestEmail, "kaveri.sales@in.the-office.test", "kaveri.assistant@in.the-office.test"]) await send(to);
    expect(w.docs.map.size).toBe(0);
    expect(w.seen.map((s) => s.path)).toEqual(["/internal/mail-admit", "/internal/mail-admit", "/internal/mail-admit"]);
    expect(w.seen.map((s) => JSON.parse(s.body) as { kind: string; bytes: number; from: string })).toMatchObject([
      { kind: "email", bytes: 15, from: "x@attacker.test" },
      { kind: "sales", bytes: 4 },
      { kind: "assistant", bytes: 15 },
    ]);
    w.mail.admit = true;
    await send(admin.ingestEmail);
    expect(w.mail.storedBeforeAsked).toEqual([0, 0, 0, 0]);
    expect(w.docs.map.size).toBe(1);
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
  const me = async (w: World, p: Person) =>
    (await (await call(w, p, ACCOUNT_ROUTES.me)).json()) as { consentNeeded: { document: string; version: string }[]; deletionRequested: boolean };
  const current = Object.entries(LEGAL_DOCUMENTS).map(([document, d]) => ({ document, version: d.version }));

  it("asks for the current terms and privacy notice until they are accepted, and refuses an old version", async () => {
    const { w, anil } = await twoOffices();
    expect((await me(w, anil)).consentNeeded).toEqual(current);
    const old = await call(w, anil, ACCOUNT_ROUTES.consent, {
      method: "POST",
      body: JSON.stringify({ documents: [{ document: "terms", version: "2020-01-01" }] }),
    });
    expect(old.status).toBe(409);
    expect(
      (await call(w, anil, ACCOUNT_ROUTES.consent, { method: "POST", body: JSON.stringify({ documents: current }), headers: { "cf-ipcountry": "IN" } })).status,
    ).toBe(200);
    expect((await me(w, anil)).consentNeeded).toEqual([]);
    expect(w.db.sqlite.prepare("SELECT document, version, country FROM consent WHERE user_id = ? ORDER BY document").all(anil.id)).toEqual(
      current.map((c) => ({ ...c, country: "IN" })).sort((a, b) => a.document.localeCompare(b.document)),
    );
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

  it("deletes an account at once after a step-up, refuses the only owner of an office others are in, and keeps no name in the record", async () => {
    const { w, anil, bina, A, B, cp } = await twoOffices();
    const remove = (p: Person) => call(w, p, ACCOUNT_ROUTES.account, { method: "DELETE" });
    const { token } = await cp.invite(A, "carol@ca.test", "accountant", anil.email);
    const carol = await signUp(w, "Carol", "carol@ca.test");
    expect((await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
    // The old way, a request for someone to act on, is gone.
    expect((await call(w, carol, ACCOUNT_ROUTES.accountRequests, { method: "POST", body: JSON.stringify({ kind: "delete" }) })).status).toBe(404);

    const sole = await remove(anil);
    expect(sole.status).toBe(409);
    expect(((await sole.json()) as { error: string }).error).toContain("Kaveri Electricals");
    expect(w.db.sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE id = ?").get(anil.id)).toEqual({ n: 1 });

    // Bina is alone in her office, with two-factor on and an invitation out. A session older than 15 minutes needs her code first.
    await cp.invite(B, "dev@shah.test", "accountant", bina.email);
    await call(w, bina, ACCOUNT_ROUTES.consent, { method: "POST", body: JSON.stringify({ documents: current }) });
    w.db.sqlite.prepare("UPDATE session SET created_at = created_at - 3600 WHERE user_id = ?").run(bina.id);
    const stale = await remove(bina);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "step_up_required" });
    expect((await call(w, bina, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: totp(bina.uri!) }) })).status).toBe(200);
    w.seen.length = 0;
    const done = await remove(bina);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, closed: 1 });
    expect(w.seen.map((x) => [x.stub, x.path, x.body])).toEqual([[B, "/internal/disconnect", "{}"]]);

    const count = (table: string, where: string, v: string) =>
      (w.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(v) as { n: number }).n;
    for (const t of ["session", "account", "two_factor", "membership", "consent"]) expect(count(t, "user_id = ?", bina.id), t).toBe(0);
    expect(count("user", "id = ?", bina.id)).toBe(0);
    expect(count("invitation", "lower(invited_by) = ?", bina.email)).toBe(0);
    expect((await call(w, bina, ACCOUNT_ROUTES.me)).status).toBe(401);
    // Her office is deleted with her, and purged after 30 days like any other.
    expect(await cp.office(B)).toMatchObject({ status: "deleting" });
    expect(await cp.auditTrail(B)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: "a deleted account", action: "member.account-deleted", detail: null }),
        expect.objectContaining({ action: "office.deleting" }),
      ]),
    );
    const record = w.db.sqlite.prepare("SELECT * FROM rights_request WHERE kind = 'delete' AND status = 'done'").all() as Record<string, unknown>[];
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ user_id: "", email: "", note: null, done_by: "self" });
    const written = JSON.stringify([record, w.db.sqlite.prepare("SELECT * FROM audit WHERE at >= (SELECT MAX(at) FROM audit) - 1").all()]);
    expect(written).not.toMatch(/bina|shah\.test/i);

    // An office the platform suspended stays suspended: deleting the account does not delete it.
    const dev = await signUp(w, "Dev Rao", "dev@rao.test");
    const D = await openOffice(w, dev, "Rao Traders");
    await cp.setStatus(D, "suspended", "platform@snilld.test");
    expect((await remove(dev)).status).toBe(200);
    expect(await cp.office(D)).toMatchObject({ status: "suspended" });

    // Carol leaves Kaveri with her account, which Anil keeps.
    expect((await remove(carol)).status).toBe(200);
    expect(await cp.membership(A, carol.id)).toBeNull();
    expect(await cp.office(A)).toMatchObject({ status: "active" });
    expect(await cp.auditTrail(A)).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "a deleted account", action: "member.account-deleted" })]));
  });

  it("still lets a request made before deletion was self-serve be withdrawn", async () => {
    const { w, anil, bina } = await twoOffices();
    w.db.sqlite
      .prepare("INSERT INTO rights_request (id, user_id, email, kind, status, created_at) VALUES ('req_old', ?, ?, 'delete', 'open', ?)")
      .run(anil.id, anil.email, Date.now());
    expect((await me(w, anil)).deletionRequested).toBe(true);
    expect((await call(w, bina, `${ACCOUNT_ROUTES.accountRequests}/req_old`, { method: "DELETE" })).status).toBe(404);
    expect((await call(w, anil, `${ACCOUNT_ROUTES.accountRequests}/req_old`, { method: "DELETE" })).status).toBe(200);
    expect((await me(w, anil)).deletionRequested).toBe(false);
  });
});

describe("the website chat", () => {
  const post = (w: World, key: string, body: unknown, ip = "203.0.113.9") =>
    call(w, null, `/api/chat/${key}`, { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } });
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

  it("refuses messages live when Turnstile has no secret", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "widget", "wkaverichat01");
    (w.env as { DATA_MODE: string }).DATA_MODE = "live";
    const res = await post(w, "wkaverichat01", { visitor, text: "hi", turnstile: "tok" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("not available");
    expect(w.seen.filter((s) => s.path === "/internal/chat")).toHaveLength(0);
  });

  it("limits polling for each visitor and each address, before looking up the key", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "widget", "wkaverichat01");
    const poll = (v: string, ip = "203.0.113.9") => call(w, null, `/api/chat/wkaverichat01?visitor=${v}`, { headers: { "cf-connecting-ip": ip } });
    const used = new Map<string, number>();
    const keys: string[] = [];
    (w.env as { CHAT_LIMIT?: unknown }).CHAT_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        used.set(key, (used.get(key) ?? 0) + 1);
        return { success: used.get(key)! <= 2 };
      },
    };
    expect((await poll(visitor)).status).toBe(200);
    expect((await poll(visitor)).status).toBe(200);
    const third = await poll(visitor);
    expect(third.status).toBe(429);
    expect(third.headers.get("access-control-allow-origin")).toBe("*");
    expect(keys).toContain(`poll:wkaverichat01:v:${visitor}`);
    expect(keys).toContain("poll:wkaverichat01:ip:203.0.113.9");
    // A new visitor id from the same address is still held by the address's limit.
    expect((await poll("visitor-bbbbbbbbbbbbbbbb")).status).toBe(429);
    expect((await poll("visitor-cccccccccccccccc", "198.51.100.7")).status).toBe(200);
    expect(w.seen.filter((s) => s.path === "/internal/chat-messages")).toHaveLength(3);
  });

  it("tells the visitor when the office took no new conversation today", async () => {
    const { w, cp, A } = await twoOffices();
    await cp.claimRoute(A, "widget", "wkaverichat01");
    (w.env as { Office: unknown }).Office = {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => Response.json({ messages: [], business: "Kaveri Electricals" }) }),
    };
    const res = await post(w, "wkaverichat01", { visitor, text: "hi" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain("cannot take more new conversations today");
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
    expect(w.seen.map((s) => [s.stub, s.path, JSON.parse(s.body).joined, JSON.parse(s.body).person.userId])).toEqual([
      [A, "/internal/whatsapp", true, anil.id],
    ]);

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
    await cp
      .invite(B, anil.email, "accountant", bina.email)
      .then(({ token }) => call(w, anil, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) }));
    await dir.redeem(PHONE, (await dir.newJoinCode(B, anil.id)).code);
    expect((await call(w, anil, inOffice(B, ROUTES.officeLeave), { method: "POST" })).status).toBe(200);
    w.seen.length = 0;
    await call(w, null, "/api/hooks/meta", { method: "POST", ...signedMeta(waText(PHONE, "desk")) });
    expect(w.seen.map((s) => s.stub)).toEqual([A]);
  });
});

describe("two-factor sign-in for owners", () => {
  it("keeps an owner out of their office until it is on, and leaves it optional for an accountant", async () => {
    const w = makeEnv();
    const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
    const opened = await call(w, anil, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "Kaveri Electricals" }) });
    const A = ((await opened.json()) as { id: string }).id;
    const me = async (p: Person) => ((await (await call(w, p, ACCOUNT_ROUTES.me)).json()) as { twoFactor: unknown }).twoFactor;
    expect(await me(anil)).toEqual({ enabled: false, required: true });
    for (const path of [ROUTES.desk, ROUTES.officeAdmin, ROUTES.officeExport]) {
      const res = await call(w, anil, inOffice(A, path));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "two_factor_required" });
    }
    expect(w.seen).toEqual([]);

    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    const { token } = await new ControlPlane(w.db).invite(A, carol.email, "accountant", anil.email);
    await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) });
    expect(await me(carol)).toEqual({ enabled: false, required: false });
    expect((await call(w, carol, inOffice(A, ROUTES.desk))).status).toBe(200);

    await twoStep(w, anil);
    expect(await me(anil)).toEqual({ enabled: true, required: true });
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(200);
  });
});

describe("a fresh sign-in for the riskier owner actions", () => {
  /** Moves this person's sessions, and any step-up in them, an hour into the past (D1 keeps seconds). */
  const anHourAgo = (w: World, who: Person) =>
    w.db.sqlite.prepare("UPDATE session SET created_at = created_at - 3600, step_up_at = step_up_at - 3600 WHERE user_id = ?").run(who.id);

  it("asks again for the password or a code before export, inviting, changing roles, handing over and deleting", async () => {
    const { w, anil, A } = await twoOffices();
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    const { token } = await new ControlPlane(w.db).invite(A, carol.email, "accountant", anil.email);
    await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) });
    anHourAgo(w, anil);
    const risky: [string, RequestInit][] = [
      [ROUTES.officeExport, {}],
      [ROUTES.officeInvitations, { method: "POST", body: JSON.stringify({ email: "dev@firm.test", role: "accountant" }) }],
      [ROUTES.officeMember(carol.id), { method: "PUT", body: JSON.stringify({ role: "owner" }) }],
      [ROUTES.officeTransfer, { method: "POST", body: JSON.stringify({ userId: carol.id }) }],
      [ROUTES.officeAdmin, { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) }],
      [ROUTES.officeMember(carol.id), { method: "DELETE" }],
      [ROUTES.officeInvitation("dev@firm.test"), { method: "DELETE" }],
    ];
    for (const [path, init] of risky) {
      const res = await call(w, anil, inOffice(A, path), init);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "step_up_required" });
    }
    // Everything else still works on an older session.
    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin))).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(200);

    // With two-factor on, the password alone does not confirm: a leaked password and a stolen cookie are not enough.
    expect((await call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ password: "a-long-password-1" }) })).status).toBe(400);
    expect((await call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(401);
    expect((await call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: totp(anil.uri!) }) })).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.officeExport))).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.officeInvitations), risky[1]![1])).status).toBe(200);

    // The confirmation itself goes stale.
    anHourAgo(w, anil);
    expect((await call(w, anil, inOffice(A, ROUTES.officeExport))).status).toBe(403);
  });

  it("takes the authenticator's code as the confirmation, and refuses it from someone without two-factor", async () => {
    const w = makeEnv();
    const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
    const A = (
      (await (await call(w, anil, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "Kaveri Electricals" }) })).json()) as { id: string }
    ).id;
    const enrolled = await enrolTwoFactor(
      (path, body, cookie) => call(w, { cookie } as Person, path, { method: "POST", body: JSON.stringify(body) }),
      anil.cookie,
      "a-long-password-1",
    );
    anil.cookie = enrolled.cookie;
    anHourAgo(w, anil);
    expect((await call(w, anil, inOffice(A, ROUTES.officeExport))).status).toBe(403);
    expect((await call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(401);
    expect((await call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: totp(enrolled.uri) }) })).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.officeExport))).status).toBe(200);

    const bina = await signUp(w, "Bina Shah", "bina@shah.test");
    expect((await call(w, bina, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: totp(enrolled.uri) }) })).status).toBe(401);
    expect((await call(w, bina, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ password: "a-long-password-1" }) })).status).toBe(200);
    expect((await call(w, null, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ password: "a-long-password-1" }) })).status).toBe(401);
  });

  it("will not check codes for someone already signed in with two-factor on, and emails when it is turned on", async () => {
    const { w, anil } = await twoOffices();
    // Signed in, there is nothing left to verify: such a check would only let a stolen cookie guess codes.
    for (const path of ["/api/auth/two-factor/verify-totp", "/api/auth/two-factor/verify-backup-code"])
      expect((await call(w, anil, path, { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(403);
    const subjects = w.sent
      .filter((m) => m.to === anil.email)
      .map((m) => Buffer.from(/^Subject: =\?UTF-8\?B\?([^?]*)\?=/im.exec(m.raw)?.[1] ?? "", "base64").toString());
    expect(subjects).toContain("Two-step sign-in is now on for your account");
    // An accountant may turn it off again, and is told.
    const carol = await twoStep(w, await signUp(w, "Carol Rao", "carol@firm.test"));
    expect((await call(w, carol, "/api/auth/two-factor/disable", { method: "POST", body: JSON.stringify({ password: "a-long-password-1" }) })).status).toBe(
      200,
    );
    expect(
      w.sent.filter((m) => m.to === carol.email).map((m) => Buffer.from(/^Subject: =\?UTF-8\?B\?([^?]*)\?=/im.exec(m.raw)?.[1] ?? "", "base64").toString()),
    ).toEqual(["Two-step sign-in is now on for your account", "Two-step sign-in was turned off for your account"]);
  });

  it("stops listening after ten wrong tries for one account, from whatever address", async () => {
    const { w, anil } = await twoOffices();
    const stepUp = (code: string, ip: string) =>
      call(w, anil, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code }), headers: { "cf-connecting-ip": ip } });
    // Sent all at once, as a guesser would: each still takes its own try.
    const wrong = await Promise.all(Array.from({ length: 10 }, (_, i) => stepUp("000000", `203.0.113.${i + 1}`)));
    expect(wrong.map((r) => r.status)).toEqual(Array(10).fill(401));
    expect((await stepUp(totp(anil.uri!), "198.51.100.1")).status).toBe(429);
  });

  it("ends a session after 12 hours", async () => {
    const w = makeEnv();
    const anil = await signUp(w, "Anil Kulkarni", "anil@kaveri.test");
    const row = w.db.sqlite.prepare("SELECT created_at, expires_at FROM session WHERE user_id = ?").get(anil.id) as { created_at: number; expires_at: number };
    expect(row.expires_at - row.created_at).toBe(12 * 60 * 60);
  });
});

describe("people in an office", () => {
  it("invites by link for one address, once, and the accountant sees the office but not its administration", async () => {
    const { w, anil, bina, A } = await twoOffices();
    const inv = (await (
      await call(w, anil, inOffice(A, ROUTES.officeInvitations), { method: "POST", body: JSON.stringify({ email: "carol@firm.test", role: "accountant" }) })
    ).json()) as { link: string; emailed: boolean };
    expect(inv.emailed).toBe(true);
    const token = inviteIn(inv.link);
    expect((await call(w, bina, ACCOUNT_ROUTES.peekInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
    expect((await call(w, bina, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(403);
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    expect(await (await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).json()).toEqual({
      officeId: A,
      role: "accountant",
    });
    expect((await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(403);

    const admin = (await (await call(w, carol, inOffice(A, ROUTES.officeAdmin))).json()) as { members: unknown[]; invitations: unknown[]; audit: unknown[] };
    expect([admin.members.length, admin.invitations, admin.audit]).toEqual([2, [], []]);
    expect((await call(w, carol, inOffice(A, ROUTES.officeAdmin), { method: "PATCH", body: JSON.stringify({ name: "Mine now" }) })).status).toBe(403);
    expect((await call(w, carol, inOffice(A, ROUTES.officeInvitations), { method: "POST", body: JSON.stringify({ email: "x@y.test" }) })).status).toBe(403);
    expect((await call(w, carol, inOffice(A, ROUTES.officeExport))).status).toBe(403);
  });

  it("keeps invitation tokens out of every URL a server sees: after # in the link, in the body to look up and accept", async () => {
    const { w, anil, bina, A } = await twoOffices();
    const inv = (await (
      await call(w, anil, inOffice(A, ROUTES.officeInvitations), { method: "POST", body: JSON.stringify({ email: "carol@firm.test", role: "accountant" }) })
    ).json()) as { link: string };
    const link = new URL(inv.link);
    expect([link.origin, link.pathname, link.search]).toEqual([BASE, "/", ""]);
    expect(link.hash).toMatch(/^#invite=[\w-]{40,}$/);
    expect(mailText(w.sent.at(-1)!)).toContain(inv.link);
    const token = inviteIn(inv.link);

    const peek = (body: unknown) => call(w, bina, ACCOUNT_ROUTES.peekInvitation, { method: "POST", body: JSON.stringify(body) });
    expect(ACCOUNT_ROUTES.peekInvitation).not.toContain(token);
    expect(await (await peek({ token })).json()).toEqual({ officeName: "Kaveri Electricals", email: "carol@firm.test", role: "accountant" });
    expect((await peek({ token: "x".repeat(43) })).status).toBe(404);
    expect((await peek({})).status).toBe(404);
    // The sign-in page asks before anyone has signed in.
    expect(await (await call(w, null, ACCOUNT_ROUTES.peekInvitation, { method: "POST", body: JSON.stringify({ token }) })).json()).toMatchObject({
      email: "carol@firm.test",
    });
    // The old lookup, with the token in the path, is gone.
    const old = await call(w, bina, `/api/invitations/${token}`);
    expect(old.status).toBe(404);
    expect(await old.text()).not.toContain("carol@firm.test");

    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    expect(await (await call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).json()).toEqual({
      officeId: A,
      role: "accountant",
    });
    expect((await peek({ token })).status).toBe(404);
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
    // The new owner turns on two-factor sign-in before acting as one.
    expect(await (await call(w, carol, inOffice(A, ROUTES.officeMember(anil.id)), { method: "DELETE" })).json()).toMatchObject({ code: "two_factor_required" });
    await twoStep(w, carol);
    expect((await call(w, carol, inOffice(A, ROUTES.officeMember(anil.id)), { method: "DELETE" })).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect((await cp.auditTrail(A)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["office.opened", "invitation.sent", "invitation.accepted", "office.transferred", "member.removed"]),
    );
  });

  it("exports only the office's own books and files", async () => {
    const { w, anil, A, B, cp } = await twoOffices();
    await w.docs.put(docKey(A, "doc-u1"), "A's bill");
    await w.docs.put(docKey(B, "doc-u2"), "B's bill");
    const res = await call(w, anil, inOffice(A, ROUTES.officeExport));
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = new TextDecoder("latin1").decode(await res.arrayBuffer());
    expect(bytes).toContain("books.json");
    expect(bytes).toContain("files/docs/doc-u1");
    expect(bytes).toContain("A's bill");
    expect(bytes).not.toContain("B's bill");
    expect(w.seen.map((s) => [s.stub, s.path])).toEqual([
      [A, "/internal/export/plan"],
      [A, "/internal/export/part"],
    ]);
    expect((await cp.auditTrail(A)).find((a) => a.action === "office.exported")).toMatchObject({ actor: anil.email, detail: "2 files" });
  });
});

describe("suspending, deleting and purging", () => {
  it("hides a deleted office from everyone at once, lets the owner restore it, and purges it after 30 days", async () => {
    const { w, anil, bina, A, B, cp } = await twoOffices();
    const carol = await signUp(w, "Carol Rao", "carol@firm.test");
    await cp
      .invite(A, carol.email, "accountant", anil.email)
      .then(({ token }) => call(w, carol, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) }));
    await w.docs.put(docKey(A, "doc-u1"), "A's bill");
    await w.docs.put(docKey(B, "doc-u2"), "B's bill");
    await cp.claimRoute(A, "meta_page", "page-a");

    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri" }) })).status).toBe(400);
    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) })).status).toBe(
      200,
    );
    expect((await call(w, carol, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect(await cp.routeFor("meta_page", "page-a")).toBeNull();
    expect(((await (await call(w, carol, ACCOUNT_ROUTES.me)).json()) as { offices: unknown[] }).offices).toEqual([]);
    expect(((await (await call(w, anil, ACCOUNT_ROUTES.me)).json()) as { offices: unknown[] }).offices).toEqual([
      expect.objectContaining({ id: A, status: "deleting" }),
    ]);
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

  it("deletes a purged office's copies in India, a page at a time, and tries again the next night if the store refuses", async () => {
    const { w, anil, A, B, cp } = await twoOffices();
    Object.assign(w.env, {
      INDIA_BACKUP_ENDPOINT: "https://s3.ap-south-1.example",
      INDIA_BACKUP_BUCKET: "books-in",
      INDIA_BACKUP_REGION: "ap-south-1",
      INDIA_BACKUP_ACCESS_KEY_ID: "AKID",
      INDIA_BACKUP_SECRET_ACCESS_KEY: "secret",
    });
    const store = indiaStore();
    for (let d = 0; d < 1203; d++) store.keys.add(`${A}/day-${String(d).padStart(4, "0")}.json.gz.enc`);
    store.keys.add(`${B}/2026-11-04.json.gz.enc`);
    store.keys.add(`${A}x/2026-11-04.json.gz.enc`);
    vi.stubGlobal("fetch", store.fetch);

    await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) });
    w.db.sqlite.prepare("UPDATE office SET deleted_at = ? WHERE id = ?").run(Date.now() - PURGE_AFTER_MS - 1, A);
    expect(await purgeDeleted(w.env)).toBe(1);
    expect(w.db.sqlite.prepare("SELECT office_id FROM backup_erasure").all()).toEqual([{ office_id: A }]);

    store.refuse = true;
    expect(await eraseBackups(w.env)).toBe(0);
    expect(w.db.sqlite.prepare("SELECT tries, last_error FROM backup_erasure WHERE office_id = ?").get(A)).toEqual({
      tries: 1,
      last_error: expect.stringContaining("403"),
    });
    expect(store.keys.size).toBe(1205);

    store.refuse = false;
    expect(await eraseBackups(w.env)).toBe(1);
    expect([...store.keys].sort()).toEqual([`${B}/2026-11-04.json.gz.enc`, `${A}x/2026-11-04.json.gz.enc`].sort());
    expect(store.deletes.every((n) => n <= 1000)).toBe(true);
    expect(w.db.sqlite.prepare("SELECT * FROM backup_erasure").all()).toEqual([]);
    expect(await cp.auditTrail(A)).toEqual(
      expect.arrayContaining([expect.objectContaining({ actor: "system", action: "office.backups-erased", detail: "1203 copies in India deleted" })]),
    );
    expect(await eraseBackups(w.env)).toBe(0);
  });

  it("puts erasures the store keeps refusing behind the others, so they cannot hold them back", async () => {
    const { cp, w } = await twoOffices();
    await cp.queueBackupErasure("off_aaaaaaaaaaaaaaaa");
    await cp.queueBackupErasure("off_bbbbbbbbbbbbbbbb");
    w.db.sqlite.prepare("UPDATE backup_erasure SET tries = 5, since = 0 WHERE office_id = 'off_aaaaaaaaaaaaaaaa'").run();
    expect((await cp.backupErasures(1)).map((e) => e.officeId)).toEqual(["off_bbbbbbbbbbbbbbbb"]);
  });

  it("deletes a purged office's retained books once their eight years are over, and says so in its audit", async () => {
    const { w, cp } = await twoOffices();
    const put = (key: string, keepUntil?: string) => w.docs.put(key, "books", { customMetadata: keepUntil ? { keepUntil } : {} });
    await put("retained/off_aaaaaaaaaaaaaaaa/2018-02-01T21-30-00-000Z.json", "2027-03-31");
    // A later date in the metadata wins over the key's.
    await put("retained/off_eeeeeeeeeeeeeeee/2017-06-01T21-30-00-000Z.json", "2040-03-31");
    await put("retained/off_bbbbbbbbbbbbbbbb/2026-11-04T21-30-00-000Z.json", "2035-03-31");
    // Without metadata (a listing may not carry it): the purge year in the key decides it.
    await put("retained/off_cccccccccccccccc/2017-06-01T21-30-00-000Z.json");
    await put("retained/off_dddddddddddddddd/undated.json");
    await w.docs.put(docKey("off_aaaaaaaaaaaaaaaa", "doc-1"), "not a retained copy");

    expect(await sweepRetained(w.env, new Date("2027-03-31T12:00:00Z"))).toBe(1);
    expect(await sweepRetained(w.env, new Date("2027-04-01T12:00:00Z"))).toBe(1);
    expect([...w.docs.map.keys()].filter((k) => k.startsWith("retained/")).sort()).toEqual([
      "retained/off_bbbbbbbbbbbbbbbb/2026-11-04T21-30-00-000Z.json",
      "retained/off_dddddddddddddddd/undated.json",
      "retained/off_eeeeeeeeeeeeeeee/2017-06-01T21-30-00-000Z.json",
    ]);
    expect(w.docs.map.has(docKey("off_aaaaaaaaaaaaaaaa", "doc-1"))).toBe(true);
    expect(await cp.auditTrail("off_aaaaaaaaaaaaaaaa")).toEqual([expect.objectContaining({ actor: "system", action: "office.retained-deleted" })]);
    expect(await cp.auditTrail("off_cccccccccccccccc")).toEqual([expect.objectContaining({ action: "office.retained-deleted" })]);
    expect(await cp.auditTrail("off_bbbbbbbbbbbbbbbb")).toEqual([]);
  });

  it("closes a suspended office to its own people without saying so to anyone else", async () => {
    const { w, anil, bina, A, cp } = await twoOffices();
    await cp.setStatus(A, "suspended", "admin");
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(423);
    expect((await call(w, bina, inOffice(A, ROUTES.desk))).status).toBe(404);
    expect(w.seen).toEqual([]);
  });
});

describe("open screens of someone who leaves", () => {
  it("are closed by the office when they are removed or leave, and everyone's when it is suspended or deleted", async () => {
    const { w, anil, A, cp } = await twoOffices();
    const join = async (name: string, email: string) => {
      const p = await signUp(w, name, email);
      const { token } = await cp.invite(A, email, "accountant", anil.email);
      await call(w, p, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) });
      return p;
    };
    const carol = await join("Carol Rao", "carol@firm.test");
    const dev = await join("Dev Iyer", "dev@firm.test");
    w.env.PLATFORM_OWNER_EMAILS = "puja@snilld.test";
    const puja = await twoStep(w, await signUp(w, "Puja", "puja@snilld.test"));
    w.seen.length = 0;

    expect((await call(w, anil, inOffice(A, ROUTES.officeMember(carol.id)), { method: "DELETE" })).status).toBe(200);
    expect((await call(w, dev, inOffice(A, ROUTES.officeLeave), { method: "POST" })).status).toBe(200);
    expect((await call(w, puja, PLATFORM_ROUTES.status(A), { method: "PUT", body: JSON.stringify({ status: "suspended" }) })).status).toBe(200);
    expect((await call(w, puja, PLATFORM_ROUTES.status(A), { method: "PUT", body: JSON.stringify({ status: "active" }) })).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Kaveri Electricals" }) })).status).toBe(
      200,
    );

    expect(w.seen.map((s) => [s.stub, s.path, s.caller.userId, JSON.parse(s.body || "{}")])).toEqual([
      [A, "/internal/disconnect", "system", { userId: carol.id }],
      [A, "/internal/disconnect", "system", { userId: dev.id }],
      [A, "/internal/disconnect", "system", {}],
      [A, "/internal/disconnect", "system", {}],
    ]);
  });
});

describe("the platform owners' console", () => {
  const view = async (w: World, who: Person) => (await (await call(w, who, PLATFORM_ROUTES.view)).json()) as PlatformView;

  it("has no owners while PLATFORM_OWNER_EMAILS is unset, and logs that the console is locked once per instance", async () => {
    vi.resetModules();
    const fresh = await import("../src/app");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(fresh.platformOwners({}).size).toBe(0);
      expect(fresh.platformOwners({ PLATFORM_OWNER_EMAILS: " " }).size).toBe(0);
      const told = warn.mock.calls.filter(([l]) => (l as { event?: string }).event === "platform.owners-unset");
      expect(told).toHaveLength(1);
      expect(JSON.stringify(told[0])).not.toMatch(/@/);
      expect(fresh.platformOwners({ PLATFORM_OWNER_EMAILS: " Puja@Snilld.test, ,b@snilld.test" })).toEqual(new Set(["puja@snilld.test", "b@snilld.test"]));
    } finally {
      warn.mockRestore();
    }
  });

  it("is only for the addresses in PLATFORM_OWNER_EMAILS, and shows every business's account but not its books", async () => {
    const { w, anil, A, B } = await twoOffices();
    const puja = await signUp(w, "Puja", "Puja@Snilld.test");
    expect((await call(w, puja, PLATFORM_ROUTES.view)).status).toBe(403);
    w.env.PLATFORM_OWNER_EMAILS = "someone@snilld.test, puja@snilld.test";
    expect((await call(w, anil, PLATFORM_ROUTES.view)).status).toBe(403);
    expect(
      (await call(w, anil, PLATFORM_ROUTES.businesses, { method: "POST", body: JSON.stringify({ name: "Sneaky", ownerEmail: "anil@kaveri.test" }) })).status,
    ).toBe(403);
    expect((await call(w, null, PLATFORM_ROUTES.view)).status).toBe(401);
    expect(await (await call(w, puja, PLATFORM_ROUTES.view)).json()).toMatchObject({ code: "two_factor_required" });
    expect(((await (await call(w, puja, ACCOUNT_ROUTES.me)).json()) as { twoFactor: unknown }).twoFactor).toEqual({ enabled: false, required: true });
    await twoStep(w, puja);
    const v = await view(w, puja);
    expect(v.businesses.map((b) => b.id).sort()).toEqual([A, B].sort());
    expect(v.businesses.find((b) => b.id === A)).toMatchObject({
      name: "Kaveri Electricals",
      status: "active",
      owners: [{ name: "Anil Kulkarni", email: "anil@kaveri.test" }],
      people: 1,
      onboardedBy: null,
      ownerInvite: null,
    });
    expect(Object.keys(v.businesses[0]!).sort()).toEqual([
      "address",
      "id",
      "ingestEmail",
      "lastEvent",
      "name",
      "onboardedBy",
      "opened",
      "ownerInvite",
      "owners",
      "people",
      "status",
    ]);
    expect(w.seen).toEqual([]);
  });

  it("onboards a business: an empty office, and an owner invitation by email that only that address can accept", async () => {
    const w = makeEnv();
    w.env.PLATFORM_OWNER_EMAILS = "puja@snilld.test";
    const puja = await twoStep(w, await signUp(w, "Puja", "puja@snilld.test"));
    const res = await call(w, puja, PLATFORM_ROUTES.businesses, {
      method: "POST",
      body: JSON.stringify({ name: "Mehta Hardware", ownerEmail: "Ravi@Mehta.test" }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as PlatformInvited;
    expect(made).toMatchObject({ name: "Mehta Hardware", email: "ravi@mehta.test", emailed: true });
    const invites = w.sent.filter((m) => m.to !== puja.email); // puja was told two-step sign-in is on
    expect(invites.map((m) => m.to)).toEqual(["ravi@mehta.test"]);
    const token = inviteIn(mailText(invites[0]!));
    expect((await view(w, puja)).businesses).toEqual([
      expect.objectContaining({
        id: made.id,
        people: 0,
        owners: [],
        onboardedBy: "puja@snilld.test",
        ownerInvite: expect.objectContaining({ email: "ravi@mehta.test", expired: false }),
      }),
    ]);
    expect(((await (await call(w, puja, ACCOUNT_ROUTES.me)).json()) as { offices: unknown[] }).offices).toEqual([]);

    const bina = await signUp(w, "Bina Shah", "bina@shah.test");
    expect((await call(w, bina, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).status).toBe(403);
    const ravi = await signUp(w, "Ravi Mehta", "ravi@mehta.test");
    expect(await (await call(w, ravi, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token }) })).json()).toEqual({
      officeId: made.id,
      role: "owner",
    });
    expect(await (await call(w, ravi, inOffice(made.id, ROUTES.desk))).json()).toMatchObject({ code: "two_factor_required" });
    await twoStep(w, ravi);
    expect((await call(w, ravi, inOffice(made.id, ROUTES.desk))).status).toBe(200);
    expect((await view(w, puja)).businesses[0]).toMatchObject({ owners: [{ name: "Ravi Mehta", email: "ravi@mehta.test" }], people: 1, ownerInvite: null });
    expect((await call(w, puja, PLATFORM_ROUTES.ownerInvite(made.id), { method: "POST", body: JSON.stringify({ email: "ravi@mehta.test" }) })).status).toBe(
      409,
    );
  });

  it("never invites an owner into an office that has one, and never hands the console the link", async () => {
    const { w, A } = await twoOffices();
    w.env.PLATFORM_OWNER_EMAILS = "puja@snilld.test";
    const puja = await twoStep(w, await signUp(w, "Puja", "puja@snilld.test"));
    w.sent.length = 0; // puja was told two-step sign-in is on
    const cp = new ControlPlane(w.db);
    const invite = (id: string, email: string) => call(w, puja, PLATFORM_ROUTES.ownerInvite(id), { method: "POST", body: JSON.stringify({ email }) });

    // Kaveri has an owner: the console cannot add another, under any address.
    const refused = await invite(A, "puja.personal@elsewhere.test");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/already has an owner.*Owners invite people themselves/);
    expect(await cp.invitations(A)).toEqual([]);
    expect(w.sent).toEqual([]);

    // A waiting office: the console may invite its owner, by email only, and never its own people.
    const opened = await call(w, puja, PLATFORM_ROUTES.businesses, {
      method: "POST",
      body: JSON.stringify({ name: "Mehta Hardware", ownerEmail: "ravi@mehta.test" }),
    });
    const made = (await opened.clone().json()) as PlatformInvited & { id: string };
    expect(
      (await call(w, puja, PLATFORM_ROUTES.businesses, { method: "POST", body: JSON.stringify({ name: "Mine", ownerEmail: "Puja@Snilld.test" }) })).status,
    ).toBe(403);
    expect((await invite(made.id, "puja@snilld.test")).status).toBe(403);
    const again = await invite(made.id, "ravi.mehta@mehta.test");
    expect(again.status).toBe(200);

    const responses = [await opened.text(), await again.text(), await (await call(w, puja, PLATFORM_ROUTES.view)).text()];
    const tokens = w.sent.map((m) => inviteIn(mailText(m)));
    expect(tokens).toHaveLength(2);
    for (const body of responses) {
      expect(body).not.toMatch(/invite=|"link"/);
      for (const t of tokens) expect(body).not.toContain(t);
    }
    expect(Object.keys(JSON.parse(responses[1]!)).sort()).toEqual(["email", "emailed", "expiresAt", "id", "name"]);

    // Even an owner invitation the console left pending (two calls at once, or one sent before this change)
    // cannot be accepted once the office has an owner.
    const stray = await cp.invite(A, "alias@elsewhere.test", "owner", "puja@snilld.test");
    const alias = await signUp(w, "Alias", "alias@elsewhere.test");
    const late = await call(w, alias, ACCOUNT_ROUTES.acceptInvitation, { method: "POST", body: JSON.stringify({ token: stray.token }) });
    expect([late.status, ((await late.json()) as { error: string }).error]).toEqual([
      403,
      "This office has an owner now. Ask them to invite you from the office's Settings.",
    ]);
    expect(await cp.membership(A, alias.id)).toBeNull();

    // The corrected address replaces the first: one way in, not two.
    expect((await cp.invitations(made.id)).map((i) => i.email)).toEqual(["ravi.mehta@mehta.test"]);
    expect(await cp.peekInvite(tokens[0]!)).toBeNull();
    const trail = await cp.auditTrail(made.id);
    expect(trail.filter((t) => t.actor === "puja@snilld.test").map((t) => [t.action, t.detail])).toEqual([
      ["platform.owner_invited", "ravi.mehta@mehta.test as owner"],
      ["platform.owner_invited", "ravi@mehta.test as owner"],
      ["office.onboarded", "Mehta Hardware"],
    ]);
  });

  it("suspends and opens an office again, but leaves an owner's deletion to the owner", async () => {
    const { w, anil, bina, A, B } = await twoOffices();
    w.env.PLATFORM_OWNER_EMAILS = "puja@snilld.test";
    const puja = await twoStep(w, await signUp(w, "Puja", "puja@snilld.test"));
    const status = (id: string, s: string) => call(w, puja, PLATFORM_ROUTES.status(id), { method: "PUT", body: JSON.stringify({ status: s }) });
    // A platform owner's old session reads the console but changes nothing.
    w.db.sqlite.prepare("UPDATE session SET created_at = created_at - 3600 WHERE user_id = ?").run(puja.id);
    expect((await call(w, puja, PLATFORM_ROUTES.view)).status).toBe(200);
    expect(await (await status(A, "suspended")).json()).toMatchObject({ code: "step_up_required" });
    expect((await call(w, puja, PLATFORM_ROUTES.ownerInvite(A), { method: "POST", body: JSON.stringify({ email: "someone@else.test" }) })).status).toBe(403);
    expect((await call(w, puja, "/api/auth/step-up", { method: "POST", body: JSON.stringify({ code: totp(puja.uri!) }) })).status).toBe(200);
    expect((await status(A, "suspended")).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(423);
    expect((await call(w, bina, inOffice(B, ROUTES.desk))).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.officeAdmin))).status).toBe(423);
    expect((await status(A, "active")).status).toBe(200);
    expect((await call(w, anil, inOffice(A, ROUTES.desk))).status).toBe(200);
    expect((await status(A, "deleting")).status).toBe(400);
    expect((await status("off_nosuchofficeatall", "suspended")).status).toBe(404);
    await call(w, bina, inOffice(B, ROUTES.officeAdmin), { method: "DELETE", body: JSON.stringify({ confirm: "Shah Textiles" }) });
    expect((await status(B, "active")).status).toBe(409);
    const trail = await new ControlPlane(w.db).auditTrail(A);
    expect(trail.filter((t) => t.actor === "puja@snilld.test").map((t) => t.action)).toEqual(["office.active", "office.suspended"]);
  });
});

describe("an office on its own address", () => {
  const CONSOLE = "http://app.office.localhost:8787";
  const at = (host: string, w: World, who: Person | null, path: string, init: RequestInit = {}) =>
    app.request(
      `${host}${path}`,
      {
        ...init,
        headers: { origin: host, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(who ? { cookie: who.cookie } : {}) },
      },
      w.env,
    );

  it("signs in once on the console and is signed in on every office address", async () => {
    const w = makeEnv();
    Object.assign(w.env, { BETTER_AUTH_URL: CONSOLE, APP_DOMAIN: "office.localhost" });
    const res = await at(CONSOLE, w, null, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: "Anil Kulkarni", email: "anil@kaveri.test", password: "a-long-password-1" }),
    });
    expect(res.status).toBe(200);
    const set = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
    expect(set.every((c) => /domain=office\.localhost/i.test(c))).toBe(true);
    const anil = { cookie: set.map((c) => c.split(";")[0]).join("; ") } as Person;
    const opened = await at(CONSOLE, w, anil, ACCOUNT_ROUTES.offices, { method: "POST", body: JSON.stringify({ name: "Kaveri Electricals" }) });
    const A = ((await opened.json()) as { id: string }).id;
    await w.db.prepare("UPDATE office SET subdomain = 'kaveri' WHERE id = ?").bind(A).run();
    expect(await (await at("http://office.localhost:8787", w, null, "/api/health")).json()).toMatchObject({ appDomain: "office.localhost" });
    const me = (await (await at("http://kaveri.office.localhost:8787", w, anil, ACCOUNT_ROUTES.me)).json()) as {
      offices: { id: string; subdomain: string | null }[];
    };
    expect(me.offices).toEqual([expect.objectContaining({ id: A, subdomain: "kaveri" })]);
    const signIn = await at("http://kaveri.office.localhost:8787", w, null, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "anil@kaveri.test", password: "a-long-password-1" }),
    });
    expect(signIn.status).toBe(200);
    const elsewhere = await at("http://kaveri.elsewhere.localhost:8787", w, anil, "/api/auth/sign-out", { method: "POST", body: "{}" });
    expect(elsewhere.status).toBe(403);
  });

  it("keeps a host-only cookie on any host outside APP_DOMAIN", () => {
    const env = { BETTER_AUTH_URL: "https://console.office.snilld.in", APP_DOMAIN: "office.snilld.in" };
    expect(authScope(env, "kaveri.office.snilld.in")).toEqual({
      origins: ["https://console.office.snilld.in", "https://office.snilld.in", "*.office.snilld.in"],
      cookieDomain: "office.snilld.in",
    });
    expect(authScope(env, "the-office.example.workers.dev").cookieDomain).toBeNull();
    expect(authScope(env, "evil-office.snilld.in").cookieDomain).toBeNull();
    expect(authScope({ BETTER_AUTH_URL: BASE }, "localhost:8787")).toEqual({ origins: [BASE], cookieDomain: null });
  });

  it("refuses labels that are not an address, or are ours", () => {
    expect(subdomainProblem("kaveri")).toBeNull();
    expect(subdomainProblem("mehta-and-co")).toBeNull();
    expect(subdomainProblem("console")).toMatch(/kept/);
    expect(subdomainProblem("Kaveri")).toMatch(/lower-case/);
    expect(subdomainProblem("-kaveri")).toMatch(/lower-case/);
    expect(subdomainProblem("k")).toMatch(/lower-case/);
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
