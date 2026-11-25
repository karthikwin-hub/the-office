import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PostVariant, SocialMessage } from "@office/contracts";
import { OfficeService } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { rootKeys } from "../src/keyring";
import { type ChannelAdapter, failure, PlatformError, type Tokens } from "../src/social/adapter";
import { afterFailure, SocialHost } from "../src/social/host";
import { linkedin, linkedinVersion } from "../src/social/linkedin";
import { signedMedia, signMedia, verifyMedia } from "../src/social/media";
import { facebook, instagram, threads, whatsapp } from "../src/social/meta";
import { routeIdsFor } from "../src/social/routes";
import { challengeFor, newState, readState, SpentStates } from "../src/social/oauth";
import { open, seal, subkey, TokenVault } from "../src/social/tokens";
import { metaChallenge, parseMetaDelivery, sameSecret, verifyMetaSignature } from "../src/social/webhooks";
import { x } from "../src/social/x";

/** Root keys as the Worker reads them: the current one, then any it replaced. */
const ring = (current: string, ...old: string[]) => rootKeys({ SOCIAL_TOKEN_KEY: current, SOCIAL_TOKEN_KEYS_OLD: old.join(",") })!;

const SECRET = "test-secret-that-is-only-for-tests";

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number)[]) {
      const st = db.prepare(query);
      const rows = /^\s*(select|pragma)/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

type Recorded = { method: string; url: string; body: string; headers: Headers };
/** A stand-in for the platforms: answers by URL pattern, in order, and keeps what was sent. */
function recorder(routes: [RegExp, (r: Recorded) => Response | object][]) {
  const calls: Recorded[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    const r = { method: init.method ?? "GET", url, body, headers: new Headers(init.headers) };
    calls.push(r);
    const hit = routes.find(([re]) => re.test(`${r.method} ${url}`));
    if (!hit) return new Response(JSON.stringify({ error: { message: `no route for ${r.method} ${url}` } }), { status: 404 });
    const out = hit[1](r);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { f, calls };
}

const tokens: Tokens = { access: "tok", refresh: null, expiresAt: null, account: "1784", extra: { username: "kaveri" } };
const variant = (over: Partial<PostVariant> = {}): PostVariant => ({
  channelId: "ch-instagram",
  platform: "instagram",
  text: "Diwali lights in stock",
  mediaIds: [],
  link: null,
  status: "scheduled",
  externalId: null,
  url: null,
  publishedAt: null,
  error: null,
  approvedHash: null,
  metrics: null,
  ...over,
});
const picture = {
  id: "media-u1",
  url: "https://office.example/media/media-u1?exp=1&sig=s",
  kind: "image" as const,
  alt: "Ceiling fan, white",
  contentType: "image/jpeg",
};

describe("tokens at rest", () => {
  it("round-trips and refuses a row moved to another channel", async () => {
    const key = await subkey(SECRET, "tokens", "AES-GCM");
    const sealed = await seal(key, "ch-instagram", tokens);
    expect(sealed).not.toContain("tok");
    expect(await open(key, "ch-instagram", sealed)).toEqual(tokens);
    await expect(open(key, "ch-facebook", sealed)).rejects.toThrow();
    await expect(open(await subkey("another-secret", "tokens", "AES-GCM"), "ch-instagram", sealed)).rejects.toThrow();
  });

  it("stores tokens in the Office's SQLite and reads nothing without the key", async () => {
    const sql = sqlStorage();
    const vault = new TokenVault(sql, ring(SECRET));
    await vault.put("ch-x", tokens);
    expect(vault.has("ch-x")).toBe(true);
    expect(await vault.get("ch-x")).toEqual(tokens);
    expect(await new TokenVault(sql, null).get("ch-x")).toBeNull();
    expect(await new TokenVault(sql, ring("wrong-secret-entirely")).get("ch-x")).toBeNull();
    vault.drop("ch-x");
    expect(vault.has("ch-x")).toBe(false);
  });

  it("seals each office's tokens with its own key, and moves old rows to it on read", async () => {
    const sql = sqlStorage();
    await new TokenVault(sql, ring(SECRET)).put("ch-x", tokens);
    const a = new TokenVault(sql, ring(SECRET), "off_a");
    expect(await a.get("ch-x")).toEqual(tokens);
    expect(sql.exec<{ key_version: number }>("SELECT key_version FROM social_tokens").toArray()[0]!.key_version).toBe(1);
    expect(await new TokenVault(sql, ring(SECRET), "off_b").get("ch-x")).toBeNull();
    expect(await new TokenVault(sql, ring(SECRET), "off_a").get("ch-x")).toEqual(tokens);
  });
});

describe("signed media links", () => {
  it("accepts its own unexpired signature, for its own office, and nothing else", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = await signMedia(ring(SECRET), "off_a", "media-u1", exp);
    expect(await verifyMedia(ring(SECRET), "off_a", "media-u1", String(exp), sig)).toBe(true);
    expect(await verifyMedia(ring(SECRET), "off_b", "media-u1", String(exp), sig)).toBe(false);
    expect(await verifyMedia(ring(SECRET), "off_a", "media-u2", String(exp), sig)).toBe(false);
    expect(await verifyMedia(ring(SECRET), "off_a", "media-u1", String(exp + 1), sig)).toBe(false);
    expect(await verifyMedia(ring("other-secret-value"), "off_a", "media-u1", String(exp), sig)).toBe(false);
    expect(await verifyMedia(ring(SECRET), "off_a", "media-u1", String(exp), sig, (exp + 1) * 1000)).toBe(false);
    expect(await verifyMedia(ring(SECRET), "off_a", "../docs/doc-1", String(exp), sig)).toBe(false);
  });

  it("signs uploads and passes static samples through as absolute links", async () => {
    const out = await signedMedia(ring(SECRET), "https://office.example/", "off_a", [
      { id: "media-u9", url: "/api/o/off_a/social/media/media-u9", kind: "image", alt: "", skuId: null, rights: "own", width: null, height: null },
      { id: "media-01", url: "/samples/media-01.svg", kind: "image", alt: "", skuId: null, rights: "own", width: null, height: null },
    ]);
    expect(out[0]!.url).toMatch(/^https:\/\/office\.example\/media\/off_a\/media-u9\?exp=\d+&sig=[\w-]{12}\.[\w-]+$/);
    expect(out[1]!.url).toBe("https://office.example/samples/media-01.svg");
  });
});

describe("Meta webhooks", () => {
  const appSecret = "meta-app-secret-for-tests";
  const sign = (body: string) => `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;

  it("verifies X-Hub-Signature-256 over the raw body", async () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(await verifyMetaSignature(appSecret, body, sign(body))).toBe(true);
    expect(await verifyMetaSignature(appSecret, `${body} `, sign(body))).toBe(false);
    expect(await verifyMetaSignature("other", body, sign(body))).toBe(false);
    expect(await verifyMetaSignature(appSecret, body, null)).toBe(false);
    expect(await verifyMetaSignature(appSecret, body, "sha1=abc")).toBe(false);
  });

  it("answers the subscription handshake only with the right token", () => {
    const u = new URL("https://o.example/api/hooks/meta?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42");
    expect(metaChallenge(u, "tok")).toBe("42");
    expect(metaChallenge(u, "other")).toBeNull();
    expect(metaChallenge(u, undefined)).toBeNull();
    for (const token of ["to", "tokk", "tok ", "TOK", ""]) expect(metaChallenge(u, token), token).toBeNull();
  });

  it("compares the verify token without stopping at the first wrong character", () => {
    expect(sameSecret("verify-token-1", "verify-token-1")).toBe(true);
    for (const guess of ["verify-token-", "verify-token-12", "Verify-token-1", "", "x"]) expect(sameSecret(guess, "verify-token-1"), guess).toBe(false);
    expect(sameSecret("", "")).toBe(false);
    // Every byte of the guess is read whether or not an early one is wrong: a counting secret sees the same reads for both.
    const reads = (guess: string) => {
      let n = 0;
      const secret = new Proxy(new TextEncoder().encode("verify-token-1"), {
        get: (t, k) => (typeof k === "string" && /^\d+$/.test(k) && n++, Reflect.get(t, k)),
      });
      const enc = TextEncoder.prototype.encode;
      TextEncoder.prototype.encode = function (this: TextEncoder, v?: string) {
        return v === "verify-token-1" ? (secret as unknown as Uint8Array) : enc.call(this, v);
      };
      try {
        sameSecret(guess, "verify-token-1");
      } finally {
        TextEncoder.prototype.encode = enc;
      }
      return n;
    };
    expect(reads("xerify-token-1")).toBe(reads("verify-token-x"));
  });

  it("reads Instagram comments, Page comments and WhatsApp messages, and drops our own", () => {
    const ig = {
      object: "instagram",
      entry: [
        {
          id: "1784",
          time: 1793000000,
          changes: [
            { field: "comments", value: { id: "c1", text: "Price of the 4 ft LED batten?", from: { id: "99", username: "sunil" }, media: { id: "m1" } } },
            { field: "comments", value: { id: "c2", text: "Thanks!", from: { id: "1784", username: "kaveri" } } },
          ],
        },
      ],
    };
    const fb = {
      object: "page",
      entry: [
        {
          id: "55",
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "p_c9",
                post_id: "55_1",
                message: "Do you deliver to Chakan?",
                from: { id: "7", name: "Ravi Patil" },
                created_time: 1793000100,
              },
            },
          ],
        },
      ],
    };
    const wa = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "919800000001", profile: { name: "Asha" } }],
                messages: [
                  { id: "wamid.1", from: "919800000001", timestamp: "1793000200", type: "text", text: { body: "Is the 1.5 ton AC stabiliser available?" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const own = new Set(["1784"]);
    const got = [...parseMetaDelivery(ig, own), ...parseMetaDelivery(fb, own), ...parseMetaDelivery(wa, own)];
    expect(got.map((m) => [m.id, m.platform, m.kind, m.author])).toEqual([
      ["ig-c1", "Instagram", "comment", "@sunil"],
      ["fb-p_c9", "Facebook", "comment", "Ravi Patil"],
      ["wa-wamid.1", "WhatsApp", "dm", "Asha"],
    ]);
    expect(got[2]!.threadId).toBe("919800000001");
  });
});

describe("sign-in state", () => {
  it("round-trips for its platform and gives the same PKCE verifier back", async () => {
    const { state, verifier } = await newState(ring(SECRET), "x", "anil@kaveri.in", "off_a");
    const back = await readState(ring(SECRET), "x", state);
    expect(back).toEqual({ by: "anil@kaveri.in", verifier, officeId: "off_a", nonce: expect.stringMatching(/^[\w-]{22}$/), expiresAt: expect.any(Number) });
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(await challengeFor(verifier)).toMatch(/^[\w-]{43}$/);
  });

  it("refuses another platform, a tampered state and an expired one", async () => {
    const { state } = await newState(ring(SECRET), "instagram", "anil@kaveri.in", "off_a", Date.now() - 11 * 60_000);
    expect(await readState(ring(SECRET), "instagram", state)).toBeNull();
    const ok = (await newState(ring(SECRET), "instagram", "a", "off_a")).state;
    expect(await readState(ring(SECRET), "facebook", ok)).toBeNull();
    expect(await readState(ring(SECRET), "instagram", `${ok}x`)).toBeNull();
    expect(await readState(ring("other-secret-value"), "instagram", ok)).toBeNull();
  });

  it("is taken once, and remembered only until it would have expired", async () => {
    const sql = sqlStorage();
    const spent = new SpentStates(sql);
    const now = Date.now();
    const a = (await readState(ring(SECRET), "x", (await newState(ring(SECRET), "x", "anil@kaveri.in", "off_a", now)).state, now))!;
    const b = (await readState(ring(SECRET), "x", (await newState(ring(SECRET), "x", "anil@kaveri.in", "off_a", now)).state, now))!;
    expect(spent.spend(a, now)).toBe(true);
    expect(spent.spend(a, now)).toBe(false);
    expect(new SpentStates(sql).spend(a, now + 60_000)).toBe(false);
    expect(spent.spend(b, now)).toBe(true);
    spent.spend({ nonce: "later", expiresAt: now + 20 * 60_000 }, a.expiresAt + 1);
    expect(sql.exec("SELECT nonce FROM oauth_state_spent ORDER BY nonce").toArray()).toEqual([{ nonce: "later" }]);
  });
});

describe("failures and retries", () => {
  it("classifies platform errors", () => {
    expect(failure(400, { error: { message: "Invalid OAuth access token", code: 190 } }).kind).toBe("expired");
    expect(failure(400, { error: { message: "Application request limit reached", code: 4 } }).kind).toBe("rate_limited");
    expect(failure(429, { title: "Too Many Requests" }, new Headers({ "retry-after": "900" })).retryAfterSeconds).toBe(900);
    expect(failure(503, null).kind).toBe("retry");
    expect(failure(400, { error: { message: "Bad caption", code: 100 } }).kind).toBe("final");
  });

  it("backs off 1, 4 and 16 minutes, then gives up; a rate limit stops at once", () => {
    const e = new PlatformError("down", "retry");
    expect(afterFailure(e, 1, 0)).toEqual({ retryAt: 60_000 });
    expect(afterFailure(e, 2, 0)).toEqual({ retryAt: 240_000 });
    expect(afterFailure(e, 3, 0)).toEqual({ retryAt: 960_000 });
    expect(afterFailure(e, 4, 0)).toEqual({ stop: { final: true } });
    expect(afterFailure(new PlatformError("slow down", "retry", 9999), 1, 0)).toEqual({ retryAt: 3_600_000 });
    expect(afterFailure(new PlatformError("429", "rate_limited"), 1, 0)).toEqual({ stop: { rateLimited: true } });
    expect(afterFailure(new PlatformError("190", "expired"), 1, 0)).toEqual({ stop: { expired: true } });
  });
});

describe("adapters against recorded responses", () => {
  const keys = { id: "app", secret: "shh" };

  it("Instagram: container, status, publish, permalink", async () => {
    const { f, calls } = recorder([
      [/POST .*\/1784\/media$/, () => ({ id: "cont-1" })],
      [/GET .*\/cont-1\?fields=status_code/, () => ({ status_code: "FINISHED" })],
      [/POST .*\/1784\/media_publish$/, () => ({ id: "m-9" })],
      [/GET .*\/m-9\?fields=permalink/, () => ({ permalink: "https://www.instagram.com/p/abc/" })],
    ]);
    const r = await instagram(keys, f, { gapMs: 0 }).publish(tokens, variant(), [picture]);
    expect(r).toEqual({ externalId: "m-9", url: "https://www.instagram.com/p/abc/" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("image_url")).toBe(picture.url);
    expect(form.get("caption")).toBe("Diwali lights in stock");
    expect(form.get("alt_text")).toBe("Ceiling fan, white");
    expect(new URLSearchParams(calls[2]!.body).get("creation_id")).toBe("cont-1");
  });

  it("Instagram: a single video goes out as a Reel, waiting while Instagram processes it", async () => {
    const clip = { ...picture, id: "media-v1", kind: "video" as const, contentType: "video/mp4" };
    let polls = 0;
    const { f, calls } = recorder([
      [/POST .*\/1784\/media$/, () => ({ id: "cont-v" })],
      [/GET .*\/cont-v\?fields=status_code/, () => ({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" })],
      [/POST .*\/1784\/media_publish$/, () => ({ id: "m-v" })],
      [/GET .*\/m-v\?fields=permalink/, () => ({ permalink: "https://www.instagram.com/reel/abc/" })],
    ]);
    const r = await instagram(keys, f, { gapMs: 0 }).publish(tokens, variant(), [clip]);
    expect(r).toEqual({ externalId: "m-v", url: "https://www.instagram.com/reel/abc/" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("media_type")).toBe("REELS");
    expect(form.get("video_url")).toBe(clip.url);
    expect(form.has("image_url")).toBe(false);
    expect(polls).toBe(3);
  });

  it("Instagram: refuses a post without a picture, and maps an expired token", async () => {
    await expect(instagram(keys, recorder([]).f).publish(tokens, variant(), [])).rejects.toMatchObject({ kind: "final" });
    const { f } = recorder([[/media$/, () => new Response(JSON.stringify({ error: { message: "Session has expired", code: 190 } }), { status: 400 })]]);
    await expect(instagram(keys, f).publish(tokens, variant(), [picture])).rejects.toMatchObject({ kind: "expired" });
  });

  it("Instagram: says what to set up when the app keys are missing", async () => {
    await expect(instagram(null).authorizeUrl({ state: "s", redirect: "r", verifier: "v" })).rejects.toMatchObject({
      kind: "not_set_up",
      message: expect.stringContaining("INSTAGRAM_APP_ID"),
    });
  });

  it("Facebook: a text post with its link goes to the Page feed", async () => {
    const { f, calls } = recorder([[/POST .*\/55\/feed$/, () => ({ id: "55_77" })]]);
    const r = await facebook(keys, f).publish(
      { ...tokens, account: "55" },
      variant({ platform: "facebook", link: "https://kaveri.in/?utm_source=facebook" }),
      [],
    );
    expect(r).toEqual({ externalId: "55_77", url: "https://www.facebook.com/55_77" });
    expect(new URLSearchParams(calls[0]!.body).get("link")).toBe("https://kaveri.in/?utm_source=facebook");
  });

  it("Facebook: a video goes to the Page's videos with the text as its description", async () => {
    const clip = { ...picture, id: "media-v1", kind: "video" as const, contentType: "video/mp4" };
    const { f, calls } = recorder([[/POST .*\/55\/videos$/, () => ({ id: "v-88" })]]);
    const r = await facebook(keys, f).publish({ ...tokens, account: "55" }, variant({ platform: "facebook" }), [clip, picture]);
    expect(r).toEqual({ externalId: "v-88", url: "https://www.facebook.com/55/videos/v-88" });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("file_url")).toBe(clip.url);
    expect(form.get("description")).toBe("Diwali lights in stock");
    expect(calls).toHaveLength(1);
  });

  it("Facebook: takes a post down by deleting it", async () => {
    const { f, calls } = recorder([[/DELETE .*\/55_77\?access_token=tok$/, () => ({ success: true })]]);
    await facebook(keys, f).remove!({ ...tokens, account: "55" }, "55_77");
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("Facebook: picks the Page and its token at sign-in", async () => {
    const { f } = recorder([
      [/oauth\/access_token\?client_id/, () => ({ access_token: "short" })],
      [/oauth\/access_token\?grant_type=fb_exchange_token/, () => ({ access_token: "long" })],
      [/me\/accounts/, () => ({ data: [{ id: "55", name: "Kaveri Electricals", access_token: "page-tok", followers_count: 1800 }] })],
    ]);
    const c = await facebook(keys, f).exchange({ code: "c", redirect: "r", verifier: "v" });
    expect(c).toMatchObject({ handle: "Kaveri Electricals", followers: 1800, tokens: { access: "page-tok", account: "55", expiresAt: null } });
  });

  it("Threads: a text post is created and published", async () => {
    const { f, calls } = recorder([
      [/POST .*\/1784\/threads$/, () => ({ id: "t-cont" })],
      [/POST .*\/1784\/threads_publish$/, () => ({ id: "t-1" })],
      [/GET .*\/t-1\?fields=permalink/, () => ({ permalink: "https://www.threads.net/@kaveri/post/x" })],
    ]);
    const r = await threads(keys, f, { gapMs: 0 }).publish(tokens, variant({ platform: "threads" }), []);
    expect(r.externalId).toBe("t-1");
    expect(new URLSearchParams(calls[0]!.body).get("media_type")).toBe("TEXT");
  });

  it("WhatsApp: replies inside the window, refuses after it, and sends templates for broadcasts", async () => {
    const { f, calls } = recorder([[/POST .*\/phone-1\/messages$/, () => ({ messages: [{ id: "wamid.out" }] })]]);
    const wa = whatsapp({ app: { id: "app", secret: "shh" }, configId: "cfg-1" }, f);
    const t = { ...tokens, account: "phone-1", extra: { template: "festive_offer", templateLanguage: "en" } };
    const msg = { id: "wa-1", threadId: "919800000001", externalId: "wamid.1", replyBy: new Date(Date.now() + 3600_000).toISOString() } as SocialMessage;
    expect(await wa.reply(t, msg, "Yes, in stock.")).toEqual({ externalId: "wamid.out" });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      messaging_product: "whatsapp",
      to: "919800000001",
      type: "text",
      text: { body: "Yes, in stock." },
      context: { message_id: "wamid.1" },
    });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
    await expect(wa.reply(t, { ...msg, replyBy: new Date(Date.now() - 1000).toISOString() }, "Late")).rejects.toMatchObject({ kind: "final" });
    const sent = await wa.broadcast!(t, { template: "festive_offer", language: "en", text: "Line one\nLine two", audience: ["919800000001", "919800000002"] });
    expect(sent).toEqual({ sent: 2, failed: 0 });
    expect(JSON.parse(calls[1]!.body).template).toMatchObject({
      name: "festive_offer",
      language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Line one · Line two" }] }],
    });
  });

  it("WhatsApp: each business signs up its own number, which gets its own token and broadcast template", async () => {
    await expect(
      whatsapp({ app: { id: "app", secret: "shh" }, configId: null }).authorizeUrl({ state: "s", redirect: "r", verifier: "v" }),
    ).rejects.toMatchObject({
      kind: "not_set_up",
      message: expect.stringContaining("WHATSAPP_CONFIG_ID"),
    });
    const { f, calls } = recorder([
      [/GET .*\/oauth\/access_token\?/, () => ({ access_token: "biz-tok" })],
      [/GET .*\/debug_token\?/, () => ({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba-7"] }] } })],
      [/GET .*\/waba-7\/phone_numbers\?/, () => ({ data: [{ id: "phone-77", display_phone_number: "+91 98000 00077" }] })],
      [/POST .*\/waba-7\/subscribed_apps$/, () => ({ success: true })],
      [/POST .*\/phone-77\/register$/, () => new Response(JSON.stringify({ error: { message: "already registered", code: 100 } }), { status: 400 })],
      [/POST .*\/waba-7\/message_templates$/, () => ({ id: "tpl-1", status: "PENDING" })],
    ]);
    const wa = whatsapp({ app: { id: "app", secret: "shh" }, configId: "cfg-1" }, f);
    const url = new URL(await wa.authorizeUrl({ state: "st", redirect: "https://office.example/api/channels/whatsapp/callback", verifier: "v" }));
    expect(url.searchParams.get("config_id")).toBe("cfg-1");
    expect(url.searchParams.get("state")).toBe("st");
    const c = await wa.exchange({ code: "c", redirect: "r", verifier: "v" });
    expect(c).toEqual({
      tokens: {
        access: "biz-tok",
        refresh: null,
        expiresAt: null,
        account: "phone-77",
        extra: { waba: "waba-7", template: "office_news", templateLanguage: "en" },
      },
      handle: "+91 98000 00077",
      followers: null,
    });
    expect(calls.find((x) => x.url.endsWith("/subscribed_apps"))!.headers.get("authorization")).toBe("Bearer biz-tok");
    const tpl = JSON.parse(calls.find((x) => x.url.endsWith("/message_templates"))!.body);
    expect(tpl).toMatchObject({ name: "office_news", category: "MARKETING" });
    expect(tpl.components[0].text).toMatch(/\{\{1\}\}/);
  });

  it("WhatsApp: refuses a sign-up that picked no business account", async () => {
    const { f } = recorder([
      [/oauth\/access_token/, () => ({ access_token: "biz-tok" })],
      [/debug_token/, () => ({ data: { granular_scopes: [{ scope: "business_management", target_ids: ["b-1"] }] } })],
    ]);
    await expect(
      whatsapp({ app: { id: "app", secret: "shh" }, configId: "cfg-1" }, f).exchange({ code: "c", redirect: "r", verifier: "v" }),
    ).rejects.toMatchObject({
      kind: "final",
    });
  });

  it("LinkedIn: posts as the member with the current version header, escaping its markup", async () => {
    const { f, calls } = recorder([
      [/POST https:\/\/api\.linkedin\.com\/rest\/posts$/, () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } })],
    ]);
    const r = await linkedin(keys, f).publish({ ...tokens, account: "urn:li:person:abc" }, variant({ platform: "linkedin", text: "Wiring (new) #safety" }), []);
    expect(r).toEqual({ externalId: "urn:li:share:7", url: "https://www.linkedin.com/feed/update/urn:li:share:7/" });
    expect(calls[0]!.headers.get("linkedin-version")).toBe(linkedinVersion());
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ author: "urn:li:person:abc", commentary: "Wiring \\(new\\) \\#safety", lifecycleState: "PUBLISHED" });
    expect(linkedinVersion(new Date("2026-01-15T00:00:00Z"))).toBe("202512");
  });

  it("X: posts with OAuth 2 and maps a 429 to a rate limit", async () => {
    const { f, calls } = recorder([[/POST https:\/\/api\.x\.com\/2\/tweets$/, () => ({ data: { id: "1855" } })]]);
    expect(await x(keys, f).publish(tokens, variant({ platform: "x" }), [])).toEqual({ externalId: "1855", url: "https://x.com/kaveri/status/1855" });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
    const limited = recorder([[/tweets$/, () => new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 })]]);
    await expect(x(keys, limited.f).publish(tokens, variant({ platform: "x" }), [])).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("X: the sign-in link carries a PKCE challenge", async () => {
    const u = new URL(await x(keys).authorizeUrl({ state: "s", redirect: "https://o/cb", verifier: "v".repeat(43) }));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await challengeFor("v".repeat(43)));
  });
});

describe("publishing from the Office", () => {
  const setup = async (adapter: Partial<ChannelAdapter>) => {
    const books = structuredClone(loadBooks());
    const office = new OfficeService(books, { asOf: "2026-11-05" });
    const vault = new TokenVault(sqlStorage(), ring(SECRET));
    await vault.put("ch-instagram", tokens);
    const kv = new Map<string, string>();
    let now = Date.parse("2026-11-05T13:05:00Z");
    const fake = { platform: "instagram", publish: async () => ({ externalId: "m-1", url: "https://www.instagram.com/p/m1/" }), ...adapter } as ChannelAdapter;
    const host = new SocialHost(
      office,
      vault,
      { instagram: fake },
      {
        base: "https://o.example",
        officeId: "off_a",
        mediaKeys: ring(SECRET),
        kv: (k, v) => (v === undefined ? (kv.get(k) ?? null) : (kv.set(k, v), v)),
        now: () => now,
      },
    );
    return { office, host, kv, tick: (ms: number) => (now += ms) };
  };

  it("drops demo channels that have no stored sign-in back to posting by hand", async () => {
    const { office, host } = await setup({});
    host.reconcile();
    const mode = (id: string) => office.books.channels.find((c) => c.id === id)!.mode;
    expect(mode("ch-instagram")).toBe("connected");
    expect(mode("ch-facebook")).toBe("manual");
  });

  it("publishes a due post and records its link", async () => {
    const { office, host } = await setup({});
    host.reconcile();
    office.publishDue("2026-11-05T13:05:00Z");
    await host.run(office.takeEffects());
    const v = office.books.posts.find((p) => p.id === "post-05")!.variants.find((x) => x.channelId === "ch-instagram")!;
    expect(v).toMatchObject({ status: "published", externalId: "m-1", url: "https://www.instagram.com/p/m1/" });
  });

  it("retries a platform outage with backoff, without publishing twice", async () => {
    let n = 0;
    const { office, host, tick } = await setup({
      publish: async () => {
        n++;
        if (n === 1) throw new PlatformError("Service unavailable", "retry");
        return { externalId: "m-2", url: null };
      },
    });
    host.reconcile();
    office.publishDue("2026-11-05T13:05:00Z");
    await host.run(office.takeEffects());
    const v = () => office.books.posts.find((p) => p.id === "post-05")!.variants.find((x) => x.channelId === "ch-instagram")!;
    expect(v().status).toBe("scheduled");
    expect(v().error).toMatch(/Trying again/);
    const wake = host.nextWake()!;
    await host.run([{ kind: "publish", postId: "post-05", channelId: "ch-instagram" }]);
    expect(n).toBe(1);
    tick(wake - Date.parse("2026-11-05T13:05:00Z"));
    await host.run([{ kind: "publish", postId: "post-05", channelId: "ch-instagram" }]);
    expect(n).toBe(2);
    expect(v().status).toBe("published");
  });

  it("stops publishing on a channel that rate-limits and leaves the post for posting by hand", async () => {
    const { office, host } = await setup({
      publish: async () => {
        throw new PlatformError("Application request limit reached", "rate_limited");
      },
    });
    host.reconcile();
    office.publishDue("2026-11-05T13:05:00Z");
    await host.run(office.takeEffects());
    expect(office.books.channels.find((c) => c.id === "ch-instagram")!.status).toBe("rate_limited");
    expect(office.publishDue("2026-11-05T13:10:00Z").some((e) => e.channelId === "ch-instagram")).toBe(false);
  });

  it("wakes for the next scheduled post", async () => {
    const { host } = await setup({});
    expect(host.nextWake()).toBe(Date.parse("2026-11-06T11:00:00+05:30"));
  });
});

describe("the ids an office claims for its channels", () => {
  it("claims a business's own WhatsApp number and account, never the shared number or the template beside them", () => {
    const extra = { waba: "1029384756", template: "office_news", templateLanguage: "en" };
    expect(routeIdsFor("whatsapp", ["1122334455", ...Object.values(extra)], "9988776655")).toEqual([
      { kind: "wa_phone", id: "1122334455" },
      { kind: "wa_phone", id: "1029384756" },
    ]);
    expect(routeIdsFor("whatsapp", ["9988776655"], "9988776655")).toEqual([]);
    expect(routeIdsFor("instagram", ["1784", "kaveri"], undefined)).toEqual([
      { kind: "ig_account", id: "1784" },
      { kind: "ig_account", id: "kaveri" },
    ]);
  });
});
