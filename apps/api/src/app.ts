import {
  AcceptInvitation,
  type AccountDeleted,
  ACCOUNT_ROUTES,
  BRAND,
  ChatPost,
  ConsentRequest,
  DeleteOffice,
  InviteRequest,
  type InviteResult,
  type Me,
  type OfficeAdmin,
  OfficeRename,
  OpenOffice,
  Platform as PlatformEnum,
  PLATFORM_ROUTES,
  PlatformOnboard,
  PlatformStatusChange,
  type PlatformInvited,
  type PlatformView,
  RoleChange,
  ROUTES,
  TransferRequest,
} from "@office/contracts";
import { Hono, type Context } from "hono";
import { makeAuth, sendMail, verificationRequired } from "./auth";
import { CALLER_HEADER, type Caller, type InboundDocs, newDocId, system } from "./caller";
import { CALLER_SEAL_HEADER, sealCaller } from "./caller-seal";
import type { Env } from "./env";
import { AccountRecords, consentFrom, deletionFrom } from "./account";
import { backupTarget, deleteObjects, listObjects, officeBackupPrefix, retainedKeepUntil, retainedOffice } from "./backup";
import type { AssistantInbound } from "./assistant";
import { CHAT_FULL, type SupportMail, turnstileOk, widgetScript } from "./customer/channels";
import { rootKeys } from "./keyring";
import { docKey, officePrefix } from "./keys";
import { sameOrigin, securityHeaders } from "./edge";
import type { MailAdmission, MailDocs, MailKind } from "./inbound";
import { exportArchive, type ExportPlan } from "./export";
import { ARCHIVE_MAX_BYTES, importAllowed } from "./import";
import { attachmentRequest } from "./files";
import { currentRequestId, inOffice, log, newRequestId, REQUEST_ID_HEADER, requestFailed, requestLog } from "./log";
import { envelopeProven, type Inbound, parseInbound } from "./mail";
import { planMeta } from "./routing";
import { readSession, type SignedIn, type Who } from "./session";
import { verifyMedia } from "./social/media";
import { readState } from "./social/oauth";
import { isFresh, STEP_UP_NEEDED, TWO_FACTOR_NEEDED, twoFactorMissing } from "./step-up";
import { metaChallenge, verifyMetaSignature } from "./social/webhooks";
import { ControlPlane, ingestAddress, membershipOf, OFFICE_ID, type OfficeRow, officesFrom, PURGE_AFTER_MS } from "./tenancy";
import { sendText } from "./whatsapp/cloud";
import { WaDirectory } from "./whatsapp/links";
import { weatherFor, type Where } from "./weather";

type User = { id: string; name: string; email: string; emailVerified: boolean; twoFactorEnabled: boolean };
type Vars = {
  user: User;
  caller: Caller;
  office: OfficeRow;
  session: { createdAt: Date; stepUpAt: Date | null };
  /** Reads that came back with the session, by name (see `sessionReads`); a route that finds none asks D1 itself. */
  read?: Map<string, D1Result>;
};
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** Not "forbidden": someone outside an office cannot tell whether it exists. */
const NOT_FOUND = { error: "Not found" };
const iso = (ms: number) => new Date(ms).toISOString();
const cp = (env: Env) => new ControlPlane(env.DB);

/** The one way into an office's Durable Object: named by the checked office id, carrying who is asking, sealed so the Office knows the Worker said so. */
export async function toOffice(env: Env, req: Request, caller: Caller, path?: string): Promise<Response> {
  const url = new URL(req.url);
  if (path !== undefined) url.pathname = path;
  const forwarded = new Request(url, req);
  const header = JSON.stringify(caller);
  forwarded.headers.set("x-partykit-room", caller.officeId);
  forwarded.headers.set(CALLER_HEADER, header);
  forwarded.headers.set(CALLER_SEAL_HEADER, await sealCaller(env.BETTER_AUTH_SECRET, header));
  // Set here, never taken from the person asking: the office's log lines carry the Worker's id for this request.
  forwarded.headers.set(REQUEST_ID_HEADER, currentRequestId() ?? newRequestId());
  forwarded.headers.delete("x-office-as");
  return env.Office.get(env.Office.idFromName(caller.officeId)).fetch(forwarded);
}

const internal = (path: string, body: unknown) =>
  new Request(`https://office.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Someone left an office (`userId`), or it closed (everyone): its open screens stop hearing it at once. Never fails the change itself. */
async function closeLive(env: Env, officeId: string, userId?: string) {
  const res = await toOffice(env, internal("/internal/disconnect", userId ? { userId } : {}), system(officeId)).catch(() => null);
  if (!res?.ok) log("error", "disconnect.failed", { officeId, status: res?.status ?? null });
}

export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/* ---------- Every request: an id on its log lines and its response; anything thrown is logged once and answered plainly ---------- */
app.use("*", requestLog);
app.onError(requestFailed);

/* ---------- Every response: browser security headers; every change: from the app's own pages ---------- */
app.use("*", securityHeaders);
app.use("/api/*", sameOrigin);

/** Public. The web app reads `appDomain` before anything else, to know whether this host is the product page, the console or an office. */
app.get("/api/health", (c) => c.json({ ok: true, mode: c.env.DATA_MODE, appDomain: c.env.APP_DOMAIN || null }));
app.on(["GET", "POST"], "/api/auth/*", (c) => makeAuth(c.env, new URL(c.req.url).host).handler(c.req.raw));

/* ---------- Webhooks: no session; the signature is the check, and the route table decides the office ---------- */

app.get("/api/hooks/meta", (c) => {
  const challenge = metaChallenge(new URL(c.req.url), c.env.META_VERIFY_TOKEN);
  return challenge === null ? c.text("Forbidden", 403) : c.text(challenge);
});

app.post("/api/hooks/meta", async (c) => {
  const raw = await c.req.raw.arrayBuffer();
  if (raw.byteLength > 1024 * 1024) return c.text("Too large", 413);
  const sig = c.req.header("x-hub-signature-256") ?? null;
  const secrets = [c.env.META_APP_SECRET, c.env.INSTAGRAM_APP_SECRET, c.env.THREADS_APP_SECRET].filter((s): s is string => !!s);
  let ok = false;
  for (const s of secrets) if (!ok) ok = await verifyMetaSignature(s, raw, sig);
  if (!ok) return c.text("Bad signature", 401);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.text("Bad body", 400);
  }
  return c.text((await deliverMeta(c.env, body)) ? "OK" : "Not taken", 200);
});

/** Hands each office only its own part of a delivery. Returns false if an office could not take its part. */
export async function deliverMeta(env: Env, body: unknown): Promise<boolean> {
  const plan = await planMeta(cp(env), new WaDirectory(env.DB), body, env.WHATSAPP_PHONE_NUMBER_ID);
  if (plan.unrouted) log("info", "meta.unrouted", { count: plan.unrouted });
  let ok = true;
  for (const d of plan.deliveries) ok = (await toOffice(env, internal("/internal/social/meta", d.body), system(d.officeId))).ok && ok;
  for (const o of plan.office)
    ok =
      (await toOffice(env, internal("/internal/whatsapp", { body: o.body, person: o.person, joined: o.joined, heading: o.heading }), system(o.officeId))).ok &&
      ok;
  const keys = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? { token: env.WHATSAPP_TOKEN, phoneId: env.WHATSAPP_PHONE_NUMBER_ID, template: null } : null;
  if (keys) for (const r of plan.replies) await sendText(keys, r.to, r.text).catch(() => log("error", "whatsapp.reply-failed"));
  return ok;
}

/** Short-lived public links to post pictures, for platforms that fetch media themselves. Signed for one office and one picture. */
app.get("/media/:office/:id", async (c) => {
  const { office, id } = c.req.param();
  const keys = rootKeys(c.env);
  if (!OFFICE_ID.test(office) || !keys || !(await verifyMedia(keys, office, id, c.req.query("exp") ?? null, c.req.query("sig") ?? null)))
    return c.text("Not found", 404);
  // The office opens the picture (it may be sealed with its key); a public link may be cached for a while.
  const res = await toOffice(c.env, new Request(`https://office.internal/internal/media/${id}`), system(office));
  if (!res.ok) return c.text("Not found", 404);
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "public, max-age=600");
  return out;
});

/* ---------- The website chat: public, on the business's own site; the key decides the office ---------- */

const CHAT_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const WIDGET_KEY = /^w[a-z0-9]{8,40}$/;

app.get("/w/:file", async (c) => {
  const key = c.req.param("file").replace(/\.js$/, "");
  if (!WIDGET_KEY.test(key) || !(await cp(c.env).routeFor("widget", key)))
    return c.text("// This chat is not switched on.", 404, { "content-type": "text/javascript" });
  return c.body(widgetScript(key, new URL(c.req.url).origin, c.env.TURNSTILE_SITE_KEY ?? null), 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
});

app.options("/api/chat/:key", (c) => c.body(null, 204, CHAT_CORS));

/** Every key must be under the limit; one for the visitor and one for their address, so new visitor ids do not escape it. */
async function chatLimited(limit: RateLimit | undefined, keys: (string | null)[]) {
  if (!limit) return false;
  for (const key of keys) if (key && !(await limit.limit({ key })).success) return true;
  return false;
}

/** The office answers a message with the visitor's conversation; an empty one means it kept nothing. */
function chatTookNothing(body: string) {
  try {
    const m = (JSON.parse(body) as { messages?: unknown }).messages;
    return Array.isArray(m) && m.length === 0;
  } catch {
    return false;
  }
}

app.get("/api/chat/:key", async (c) => {
  const key = c.req.param("key");
  const visitor = c.req.query("visitor") ?? "";
  if (!WIDGET_KEY.test(key) || !ChatPost.shape.visitor.safeParse(visitor).success) return c.json(NOT_FOUND, 404, CHAT_CORS);
  const ip = c.req.header("cf-connecting-ip") ?? null;
  if (await chatLimited(c.env.CHAT_LIMIT, [`poll:${key}:v:${visitor}`, ip ? `poll:${key}:ip:${ip}` : null]))
    return c.json({ error: "Too many requests. Wait a minute and try again." }, 429, CHAT_CORS);
  const officeId = await cp(c.env).routeFor("widget", key);
  if (!officeId) return c.json(NOT_FOUND, 404, CHAT_CORS);
  const res = await toOffice(c.env, internal("/internal/chat-messages", { visitor }), system(officeId));
  return c.body(await res.text(), res.status as 200, { ...CHAT_CORS, "content-type": "application/json" });
});

app.post("/api/chat/:key", async (c) => {
  const key = c.req.param("key");
  const officeId = WIDGET_KEY.test(key) ? await cp(c.env).routeFor("widget", key) : null;
  if (!officeId) return c.json(NOT_FOUND, 404, CHAT_CORS);
  const parsed = ChatPost.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Write a message to send." }, 400, CHAT_CORS);
  const ip = c.req.header("cf-connecting-ip") ?? null;
  if (c.env.CHAT_LIMIT && !(await c.env.CHAT_LIMIT.limit({ key: `${key}:${ip ?? parsed.data.visitor}` })).success)
    return c.json({ error: "That is a lot of messages at once. Wait a minute and try again." }, 429, CHAT_CORS);
  const live = c.env.DATA_MODE === "live";
  // Live without a secret the widget shows no box to tick, so say the chat is shut rather than blame the visitor.
  if (live && !c.env.TURNSTILE_SECRET) return c.json({ error: "The chat is not available just now. Write to the business another way." }, 503, CHAT_CORS);
  if (!(await turnstileOk(c.env.TURNSTILE_SECRET, parsed.data.turnstile, ip, live)))
    return c.json({ error: "Tick the box to show you are a person, then send again." }, 403, CHAT_CORS);
  const res = await toOffice(
    c.env,
    internal("/internal/chat", { visitor: parsed.data.visitor, text: parsed.data.text, name: parsed.data.name ?? null }),
    system(officeId),
  );
  const body = await res.text();
  // The office keeps every message it takes; none for this visitor means it took no new conversation today.
  if (res.status === 200 && chatTookNothing(body)) return c.json({ error: CHAT_FULL }, 429, CHAT_CORS);
  return c.body(body, res.status as 200, { ...CHAT_CORS, "content-type": "application/json" });
});

/* ---------- An invitation, looked up before anyone signs in ---------- */

/**
 * An invitation link carries its token after `#`, which browsers never send: the page reads it and posts it
 * here, so no request line, and no log of one, holds a token or tells whom it was for.
 */
export const inviteLink = (env: Pick<Env, "BETTER_AUTH_URL">, token: string) =>
  `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/#invite=${encodeURIComponent(token)}`;

/** The sign-in page names the office and address an invitation is for, so the person makes the right account. Only the token's holder can ask. */
app.post(ACCOUNT_ROUTES.peekInvitation, async (c) => {
  const parsed = AcceptInvitation.safeParse(await c.req.json().catch(() => null));
  const peek = parsed.success ? await cp(c.env).peekInvite(parsed.data.token) : null;
  return peek ? c.json(peek) : c.json({ error: "This invitation has expired or was already used. Ask for a new one." }, 404);
});

/* ---------- Everything else needs someone signed in ---------- */

/** Better Auth's own answer, for what readSession leaves to it (an expired session, one due for renewal). */
async function askBetterAuth(c: Ctx): Promise<SignedIn | null> {
  const session = await makeAuth(c.env, new URL(c.req.url).host).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const u = session.user;
  return {
    user: { id: u.id, name: u.name, email: u.email, emailVerified: Boolean(u.emailVerified), twoFactorEnabled: Boolean(u.twoFactorEnabled) },
    session: { createdAt: session.session.createdAt, stepUpAt: session.session.stepUpAt ?? null },
  };
}

const IN_OFFICE = /^\/api\/o\/([^/]+)\//;

/**
 * What a route reads anyway, sent in the session's own D1 round trip: each D1 call costs a Worker 2 to 3 ms of CPU, of
 * the free plan's 10. Each statement names its person by the session token, so it finds rows only for whoever holds it.
 * Office routes still check the membership on every request; it only travels with the session.
 */
function sessionReads(c: Ctx): [name: string, statement: (who: Who) => D1PreparedStatement][] {
  const path = new URL(c.req.url).pathname;
  const office = IN_OFFICE.exec(path)?.[1];
  if (office && OFFICE_ID.test(office)) return [[`membership:${office}`, (who) => cp(c.env).membershipStatement(office, who)]];
  if (c.req.method === "GET" && path === "/api/me") {
    const records = new AccountRecords(c.env.DB);
    return [
      ["offices", (who) => cp(c.env).officesOfStatement(who)],
      ["consent", (who) => records.consentStatement(who)],
      ["deletion", (who) => records.deletionStatement(who)],
    ];
  }
  return [];
}

app.use("/api/*", async (c, next) => {
  const reads = sessionReads(c);
  const read = await readSession(c.env, c.req.raw.headers, (token) => reads.map(([, statement]) => statement({ token })));
  const signedIn = read.state === "ok" ? read.signedIn : read.state === "ask" ? await askBetterAuth(c) : null;
  if (!signedIn) return c.json({ error: "Sign in to continue." }, 401);
  c.set("user", signedIn.user);
  c.set("session", signedIn.session);
  if (read.state === "ok") c.set("read", new Map(reads.map(([name], i) => [name, read.extra[i] as D1Result])));
  await next();
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const records = new AccountRecords(c.env.DB);
  const read = c.get("read");
  const [had, consent, deletion] = [read?.get("offices"), read?.get("consent"), read?.get("deletion")];
  const offices = had ? officesFrom(had) : await cp(c.env).officesOf(user.id);
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified },
    offices,
    twoFactor: { enabled: user.twoFactorEnabled, required: platformOwners(c.env).has(user.email.toLowerCase()) || offices.some((o) => o.role === "owner") },
    verificationRequired: verificationRequired(c.env),
    consentNeeded: consent ? consentFrom(consent) : await records.consentNeeded(user.id),
    deletionRequested: deletion ? deletionFrom(deletion) : await records.deletionRequested(user.id),
  } satisfies Me);
});

/* ---------- A person's own rights: what they accepted, a copy of their data, and deletion ---------- */

app.post(ACCOUNT_ROUTES.consent, async (c) => {
  const parsed = ConsentRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Say which documents you accept." }, 400);
  const country = (c.req.raw as { cf?: { country?: string } }).cf?.country ?? c.req.header("cf-ipcountry") ?? null;
  const stale = await new AccountRecords(c.env.DB).accept(c.get("user").id, parsed.data.documents, country);
  return stale ? c.json({ error: stale }, 409) : c.json({ ok: true });
});

app.get(ACCOUNT_ROUTES.accountExport, async (c) => {
  const data = await new AccountRecords(c.env.DB).exportFor(c.get("user").id);
  if (!data) return c.json(NOT_FOUND, 404);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="my-account.json"', "cache-control": "no-store" },
  });
});

app.get(ACCOUNT_ROUTES.accountRequests, async (c) => c.json({ requests: await new AccountRecords(c.env.DB).requests(c.get("user").id) }));

/** Deleting one's own account, at once: only with a sign-in or step-up in the last 15 minutes, as for an office's riskier actions. */
app.delete(ACCOUNT_ROUTES.account, async (c) => {
  if (!isFresh(c.get("session"))) return c.json(STEP_UP_NEEDED, 403);
  const r = await new AccountRecords(c.env.DB).deleteAccount(c.get("user"));
  if ("error" in r) return c.json(r, 409);
  const user = c.get("user").id;
  for (const office of r.left) await closeLive(c.env, office, r.closed.includes(office) ? undefined : user);
  log("info", "account.deleted", { offices: r.left.length, closed: r.closed.length });
  return c.json({ ok: true, closed: r.closed.length } satisfies AccountDeleted);
});

app.delete(`${ACCOUNT_ROUTES.accountRequests}/:id`, async (c) => {
  const done = await new AccountRecords(c.env.DB).withdraw(c.get("user").id, c.req.param("id"));
  return done ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
});

app.post("/api/offices", async (c) => {
  const user = c.get("user");
  if (verificationRequired(c.env) && !user.emailVerified)
    return c.json({ error: "Confirm your email address first. We sent you a link when you signed up." }, 403);
  const parsed = OpenOffice.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the business a name." }, 400);
  const made = await cp(c.env).createOffice({ name: parsed.data.name, owner: user, ingestDomain: c.env.INGEST_DOMAIN });
  if ("error" in made) return c.json(made, 429);
  return c.json({ id: made.id, name: made.name, role: "owner", status: made.status }, 201);
});

app.post(ACCOUNT_ROUTES.acceptInvitation, async (c) => {
  const parsed = AcceptInvitation.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That link is not complete. Open it again from the email." }, 400);
  const r = await cp(c.env).acceptInvite(parsed.data.token, { ...c.get("user"), emailVerified: c.get("user").emailVerified || !verificationRequired(c.env) });
  return "error" in r ? c.json(r, 403) : c.json(r);
});

/* ---------- The platform owners' console: every business's account, never its books ---------- */

let toldNoOwners = false;

/**
 * The platform owners, from the Worker secret PLATFORM_OWNER_EMAILS (kept out of the public repository). Unset, there are
 * none: the console refuses everyone, and the first request of each Worker instance logs that it is locked.
 */
export function platformOwners(env: Pick<Env, "PLATFORM_OWNER_EMAILS">): Set<string> {
  const owners = new Set(
    (env.PLATFORM_OWNER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!owners.size && !toldNoOwners) {
    toldNoOwners = true;
    log("warn", "platform.owners-unset", { message: "PLATFORM_OWNER_EMAILS is not set: no one can use the platform console" });
  }
  return owners;
}

const platformOnly = async (c: Ctx, next: () => Promise<void>) => {
  const user = c.get("user");
  if (!platformOwners(c.env).has(user.email.toLowerCase()))
    return c.json({ error: "This console is for the people who run the platform. Businesses sign in at their own address." }, 403);
  if (verificationRequired(c.env) && !user.emailVerified) return c.json({ error: "Confirm your email address first, then come back." }, 403);
  if (twoFactorMissing(user)) return c.json(TWO_FACTOR_NEEDED, 403);
  // Onboarding, owner invitations and suspending act on every business: a stale session only reads.
  if (c.req.method !== "GET" && !isFresh(c.get("session"))) return c.json(STEP_UP_NEEDED, 403);
  await next();
};
app.use(PLATFORM_ROUTES.view, platformOnly);
app.use("/api/platform/*", platformOnly);

/** The owner's link goes only by email, to the address it is for: the console never sees it, so it cannot open an office's books. */
const ownerInviteMail = (env: Env, officeName: string, email: string, token: string) => {
  const link = inviteLink(env, token);
  return sendMail(
    env,
    email,
    `Your office for ${officeName} is ready`,
    [
      `We have opened ${officeName} on ${BRAND.name}, with you as its owner: you approve the team's work, hire and invite your accountant.`,
      "",
      "Open this link to set up your account and step in. It works once, for 14 days:",
      link,
      "",
      "Sign in or make an account with this address.",
    ].join("\n"),
  );
};
/** The people who run the platform do not own businesses on it from the console: they sign up like anyone else. */
const NOT_A_PLATFORM_OWNER = { error: "Invite the business's own owner. People who run the platform cannot be made an office's owner from the console." };

app.get(PLATFORM_ROUTES.view, async (c) => {
  const user = c.get("user");
  const now = Date.now();
  const domain = c.env.APP_DOMAIN;
  const businesses = (await cp(c.env).allOffices()).map((o) => ({
    id: o.id,
    name: o.name,
    status: o.status,
    opened: iso(o.createdAt),
    onboardedBy: o.onboardedBy,
    address: domain && o.subdomain ? `https://${o.subdomain}.${domain}` : null,
    ingestEmail: ingestAddress(o.slug, c.env.INGEST_DOMAIN),
    owners: o.owners,
    people: o.people,
    ownerInvite: o.ownerInvite ? { email: o.ownerInvite.email, expiresAt: iso(o.ownerInvite.expiresAt), expired: o.ownerInvite.expiresAt <= now } : null,
    lastEvent: o.lastEvent ? iso(o.lastEvent) : null,
  }));
  return c.json({ you: { name: user.name, email: user.email }, businesses } satisfies PlatformView);
});

app.post(PLATFORM_ROUTES.businesses, async (c) => {
  const parsed = PlatformOnboard.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the business's name and its owner's email address." }, 400);
  const email = parsed.data.ownerEmail.toLowerCase();
  if (platformOwners(c.env).has(email)) return c.json(NOT_A_PLATFORM_OWNER, 403);
  const made = await cp(c.env).onboard({ name: parsed.data.name, ownerEmail: email, by: c.get("user").email, ingestDomain: c.env.INGEST_DOMAIN });
  if ("error" in made) return c.json(made, 500);
  const emailed = await ownerInviteMail(c.env, made.office.name, email, made.token);
  return c.json({ id: made.office.id, name: made.office.name, email, emailed, expiresAt: iso(made.expiresAt) } satisfies PlatformInvited, 201);
});

app.put("/api/platform/businesses/:id/status", async (c) => {
  const parsed = PlatformStatusChange.safeParse(await c.req.json().catch(() => null));
  const office = await cp(c.env).office(c.req.param("id"));
  if (!office) return c.json(NOT_FOUND, 404);
  if (!parsed.success) return c.json({ error: "Choose active or suspended." }, 400);
  if (office.status === "deleting") return c.json({ error: "Its owner is deleting this office. Only they can restore it, within 30 days." }, 409);
  if (office.status !== parsed.data.status) await cp(c.env).setStatus(office.id, parsed.data.status, c.get("user").email);
  if (parsed.data.status === "suspended") await closeLive(c.env, office.id);
  return c.json({ ok: true });
});

app.post("/api/platform/businesses/:id/owner-invitation", async (c) => {
  const plane = cp(c.env);
  const office = await plane.office(c.req.param("id"));
  if (!office) return c.json(NOT_FOUND, 404);
  const parsed = InviteRequest.pick({ email: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter the owner's email address." }, 400);
  if (office.status !== "active") return c.json({ error: "Open the office again before inviting its owner." }, 409);
  const email = parsed.data.email.toLowerCase();
  if (platformOwners(c.env).has(email)) return c.json(NOT_A_PLATFORM_OWNER, 403);
  const made = await plane.inviteFirstOwner(office.id, email, c.get("user").email);
  if ("error" in made) return c.json(made, 409);
  const emailed = await ownerInviteMail(c.env, office.name, email, made.token);
  return c.json({ id: office.id, name: office.name, email, emailed, expiresAt: iso(made.expiresAt) } satisfies PlatformInvited);
});

/** The platform's sign-in comes back to one address for every office; the signed state says which office started it. */
app.get("/api/channels/:platform/callback", async (c) => {
  const platform = PlatformEnum.safeParse(c.req.param("platform"));
  const keys = rootKeys(c.env);
  const state = platform.success && keys ? await readState(keys, platform.data, c.req.query("state") ?? null) : null;
  const user = c.get("user");
  const m = state && OFFICE_ID.test(state.officeId) ? await cp(c.env).membership(state.officeId, user.id) : null;
  if (!state || !m || m.office.status !== "active" || m.role !== "owner" || twoFactorMissing(user) || state.by !== user.email)
    return c.redirect(`/settings?connect_error=${encodeURIComponent("That sign-in did not come from your office. Try again from Settings.")}#channels`);
  return toOffice(c.env, c.req.raw, { userId: user.id, name: user.name, email: user.email, role: m.role, officeId: m.office.id });
});

/* ---------- Inside one office: membership is checked on every request, never cached ---------- */

app.use("/api/o/:office/*", async (c, next) => {
  const id = c.req.param("office");
  if (!OFFICE_ID.test(id)) return c.json(NOT_FOUND, 404);
  const user = c.get("user");
  const had = c.get("read")?.get(`membership:${id}`);
  const m = had ? membershipOf(had) : await cp(c.env).membership(id, user.id);
  if (!m) return c.json(NOT_FOUND, 404);
  inOffice(id);
  const rest = new URL(c.req.url).pathname.slice(`/api/o/${id}`.length);
  if (
    m.office.status === "deleting" &&
    !(m.role === "owner" && (rest === "/office-admin" || rest === "/office-admin/restore" || rest === "/office-admin/export"))
  )
    return c.json(NOT_FOUND, 404);
  if (m.office.status === "suspended") return c.json({ error: "This office is suspended. Write to us to have it opened again." }, 423);
  if (m.role === "owner" && twoFactorMissing(user)) return c.json(TWO_FACTOR_NEEDED, 403);
  c.set("office", m.office);
  c.set("caller", { userId: user.id, name: user.name, email: user.email, role: m.role, officeId: id });
  await next();
});

const ownerOnly = (c: Ctx) => (c.get("caller").role === "owner" ? null : c.json({ error: "Only the owner can do that." }, 403));
/** For exporting, inviting, changing or removing people and deleting: a sign-in in the last 15 minutes, or the password or a code typed again. */
const freshOnly = (c: Ctx) => (isFresh(c.get("session")) ? null : c.json(STEP_UP_NEEDED, 403));

/** For the Lived-in office's small talk: the weather near the person looking, never stored with them. */
app.get(`/api/o/:office${ROUTES.weather.slice(4)}`, async (c) => {
  const cache = (globalThis as { caches?: { default?: Parameters<typeof weatherFor>[1]["cache"] } }).caches?.default ?? null;
  const userAgent = `agentic-office/1.0 (${c.env.BETTER_AUTH_URL}; ${c.env.MAIL_FROM})`;
  const weather = await weatherFor(c.req.raw.cf as Where | undefined, { fetcher: (u, i) => fetch(u, i), cache, userAgent });
  return c.json({ weather }, 200, { "cache-control": "private, max-age=900" });
});

// Stored files (`/api/o/:office/files/:id`, `/api/o/:office/social/media/:id`) go to the office with the rest below: they
// may be sealed with its key, which only the office opens (`files.ts`).

/* ---------- The office as an account: people, invitations, export, deletion ---------- */

app.get("/api/o/:office/office-admin", async (c) => {
  const office = c.get("office");
  const caller = c.get("caller");
  const plane = cp(c.env);
  const owner = caller.role === "owner";
  const [members, invitations, audit, emailRoutes] = await Promise.all([
    plane.members(office.id),
    owner ? plane.invitations(office.id) : [],
    owner ? plane.auditTrail(office.id, 30) : [],
    plane.routesOf(office.id, "email"),
  ]);
  const primary = ingestAddress(office.slug, c.env.INGEST_DOMAIN);
  return c.json({
    id: office.id,
    name: office.name,
    status: office.status,
    ingestEmail: emailRoutes.some((r) => r.externalId === primary) ? primary : (emailRoutes[0]?.externalId ?? primary),
    address: c.env.APP_DOMAIN && office.subdomain ? `https://${office.subdomain}.${c.env.APP_DOMAIN}` : null,
    locale: office.locale,
    purgeAt: office.status === "deleting" && office.deletedAt ? iso(office.deletedAt + PURGE_AFTER_MS) : null,
    members: members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, since: iso(m.since), you: m.userId === caller.userId })),
    invitations: invitations.map((i) => ({ email: i.email, role: i.role, invitedBy: i.invitedBy, expiresAt: iso(i.expiresAt) })),
    audit: audit.map((a) => ({ actor: a.actor, action: a.action, detail: a.detail, at: iso(a.at) })),
    importable: owner && importAllowed(c.env),
  } satisfies OfficeAdmin);
});

app.patch("/api/o/:office/office-admin", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = OfficeRename.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the business a name." }, 400);
  await cp(c.env).rename(c.get("office").id, parsed.data.name);
  return c.json({ ok: true });
});

app.post("/api/o/:office/office-admin/invitations", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const parsed = InviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter the email address to invite." }, 400);
  const office = c.get("office");
  const caller = c.get("caller");
  const plane = cp(c.env);
  const email = parsed.data.email.toLowerCase();
  if ((await plane.members(office.id)).some((m) => m.email.toLowerCase() === email)) return c.json({ error: `${email} is already in this office.` }, 409);
  const { token, expiresAt } = await plane.invite(office.id, email, parsed.data.role, caller.email);
  const link = inviteLink(c.env, token);
  const what = parsed.data.role === "owner" ? "as an owner" : "to read the books, download returns and answer the Auditor";
  const emailed = await sendMail(
    c.env,
    email,
    `${caller.name} invited you to ${office.name}`,
    [
      `${caller.name} invited you to ${office.name} on ${BRAND.name}, ${what}.`,
      "",
      "Open this link to join. It works once, for 14 days:",
      link,
      "",
      "Sign in or make an account with this address.",
    ].join("\n"),
    office.name,
  );
  return c.json({ email, link, emailed, expiresAt: iso(expiresAt) } satisfies InviteResult);
});

app.delete("/api/o/:office/office-admin/invitations/:email", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const done = await cp(c.env).revokeInvite(c.get("office").id, decodeURIComponent(c.req.param("email")), c.get("caller").email);
  return done ? c.json({ ok: true }) : c.json({ error: "No such invitation." }, 404);
});

app.put("/api/o/:office/office-admin/members/:user", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const parsed = RoleChange.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose owner or accountant." }, 400);
  const err = await cp(c.env).setRole(c.get("office").id, c.req.param("user"), parsed.data.role, c.get("caller").email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.delete("/api/o/:office/office-admin/members/:user", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const err = await cp(c.env).removeMember(c.get("office").id, c.req.param("user"), c.get("caller").email);
  if (!err) await closeLive(c.env, c.get("office").id, c.req.param("user"));
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.post("/api/o/:office/office-admin/leave", async (c) => {
  const caller = c.get("caller");
  const err = await cp(c.env).removeMember(caller.officeId, caller.userId, caller.email);
  if (!err) await closeLive(c.env, caller.officeId, caller.userId);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.post("/api/o/:office/office-admin/transfer", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const parsed = TransferRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose who will own the office." }, 400);
  const caller = c.get("caller");
  const err = await cp(c.env).transferOwnership(caller.officeId, caller.userId, parsed.data.userId, caller.email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

/**
 * Everything the office holds, in one archive: the books as JSON and every stored file. The office's Durable Object
 * reads the files and writes the archive in parts (export.ts); the Worker only joins the parts into the download.
 */
/**
 * Staging only (OFFICE_IMPORT, import.ts): the owner loads an export from live into this new, empty office. Off, the
 * routes do not exist. The Worker only checks who is asking and pipes the upload through; the office does the work.
 */
const importGate = (c: Ctx) => (importAllowed(c.env) ? (ownerOnly(c) ?? freshOnly(c)) : c.json(NOT_FOUND, 404));

app.post(`/api/o/:office${ROUTES.officeImport.slice(4)}`, async (c) => {
  const denied = importGate(c);
  if (denied) return denied;
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) return c.json({ error: "Choose the export's ZIP file." }, 411);
  if (length > ARCHIVE_MAX_BYTES) return c.json({ error: "That export is too big to import here (at most 95 MB)." }, 413);
  const caller = c.get("caller");
  const res = await toOffice(c.env, c.req.raw, caller, ROUTES.officeImport);
  if (res.ok) await cp(c.env).audit(caller.officeId, caller.email, "office.imported", null);
  return res;
});

app.post(`/api/o/:office${ROUTES.officeImportNext.slice(4)}`, async (c) => {
  const denied = importGate(c);
  if (denied) return denied;
  return toOffice(c.env, c.req.raw, c.get("caller"), ROUTES.officeImportNext);
});

app.get("/api/o/:office/office-admin/export", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const caller = c.get("caller");
  const res = await toOffice(c.env, internal("/internal/export/plan", {}), system(caller.officeId));
  if (!res.ok) return c.json({ error: "The office could not be read. Try again." }, 500);
  const plan = (await res.json()) as ExportPlan;
  await cp(c.env).audit(caller.officeId, caller.email, "office.exported", `${plan.entries} files`);
  const { body, done } = exportArchive(plan, (part) => toOffice(c.env, internal("/internal/export/part", { id: plan.id, part }), system(caller.officeId)));
  try {
    c.executionCtx.waitUntil(done);
  } catch {
    // No execution context (tests): the download's own stream keeps the parts coming.
  }
  const name =
    c
      .get("office")
      .name.replace(/[^\w-]+/g, "-")
      .slice(0, 40) || "office";
  return new Response(body, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}-export.zip"` } });
});

/** Deleting hides the office from everyone at once; its books and files stay 30 days in case it was a mistake. */
app.delete("/api/o/:office/office-admin", async (c) => {
  const denied = ownerOnly(c) ?? freshOnly(c);
  if (denied) return denied;
  const parsed = DeleteOffice.safeParse(await c.req.json().catch(() => null));
  const office = c.get("office");
  if (!parsed.success || parsed.data.confirm.trim() !== office.name) return c.json({ error: `Type ${office.name} to delete the office.` }, 400);
  await cp(c.env).setStatus(office.id, "deleting", c.get("caller").email);
  await closeLive(c.env, office.id);
  return c.json({ ok: true, purgeAt: iso(Date.now() + PURGE_AFTER_MS) });
});

app.post("/api/o/:office/office-admin/restore", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const office = c.get("office");
  if (office.status !== "deleting") return c.json({ error: "This office is not being deleted." }, 409);
  await cp(c.env).setStatus(office.id, "active", c.get("caller").email);
  return c.json({ ok: true });
});

/** The rest is the office's own: the path loses its office prefix and goes to that office's Durable Object. */
app.all("/api/o/:office/*", (c) => {
  const caller = c.get("caller");
  return toOffice(c.env, c.req.raw, caller, `/api${new URL(c.req.url).pathname.slice(`/api/o/${caller.officeId}`.length)}`);
});

app.all("/api/*", (c) => c.json(NOT_FOUND, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/** Every Authentication-Results header, as Cloudflare documents reading them; the first is its own. */
const authResults = (message: ForwardableEmailMessage) => message.headers?.get("authentication-results") ?? null;

/**
 * The office says whether to take a message before anything of it is stored: its sender, this
 * hour's limits and today's upload allowance. Nothing reaches R2 until it says yes.
 */
async function admitted(env: Env, officeId: string, kind: MailKind, mail: Inbound, envelope: string): Promise<boolean> {
  const bytes = mail.attachments.reduce((n, a) => n + a.content.byteLength, 0);
  const body: MailAdmission = {
    kind,
    from: mail.from,
    envelope,
    subject: mail.subject,
    authenticated: mail.authenticated,
    envelopeSigned: envelopeProven(mail, envelope),
    bytes,
  };
  const res = await toOffice(env, internal("/internal/mail-admit", body), system(officeId));
  if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
  return ((await res.json()) as { admit?: boolean }).admit === true;
}

/**
 * A mail's attachments go to its office, which seals each with its own key and stores it (`files.ts`): no crypto in
 * the Worker. If one cannot be stored, those already stored are removed, so a failed delivery leaves no stray files.
 */
async function storeAttachments(env: Env, officeId: string, mail: Inbound, by: string): Promise<InboundDocs["docs"]> {
  const docs: InboundDocs["docs"] = [];
  try {
    for (const a of mail.attachments) {
      const id = newDocId();
      const res = await toOffice(env, attachmentRequest(id, a, by), system(officeId));
      if (!res.ok) throw new Error(`The office could not store an attachment (${res.status}).`);
      docs.push({ id, mimeType: a.mimeType, filename: a.filename });
    }
  } catch (e) {
    if (docs.length) await env.DOCS.delete(docs.map((d) => docKey(officeId, d.id))).catch(() => undefined);
    throw e;
  }
  return docs;
}

/** Mail to `<slug>@INGEST_DOMAIN`: the address alone says which office it is for; any other address is refused. */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const to = message.to.trim().toLowerCase();
  const support = await cp(env).routeFor("support_email", to);
  if (support) {
    const mail = await parseInbound(message.raw, { results: authResults(message) });
    if (!(await admitted(env, support, "support", mail, message.from))) return;
    const body: SupportMail = {
      from: mail.from ?? message.from,
      name: mail.name,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
    };
    const res = await toOffice(env, internal("/internal/support-email", body), system(support));
    if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
    return;
  }
  const sales = await cp(env).routeFor("sales_email", to);
  if (sales) {
    const mail = await parseInbound(message.raw, { sheets: true, results: authResults(message) });
    if (!(await admitted(env, sales, "sales", mail, message.from))) return;
    const docs = await storeAttachments(env, sales, mail, mail.from ?? message.from);
    const body: MailDocs & { envelope: string } = {
      from: mail.from,
      envelope: message.from,
      subject: mail.subject,
      docs,
      skipped: mail.skipped,
      authenticated: mail.authenticated,
    };
    const res = await toOffice(env, internal("/internal/sales-email", body), system(sales));
    if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
    return;
  }
  const assistant = await cp(env).routeFor("assistant_email", to);
  if (assistant) {
    const mail = await parseInbound(message.raw, { results: authResults(message) });
    if (!(await admitted(env, assistant, "assistant", mail, message.from))) return;
    const docs = await storeAttachments(env, assistant, mail, mail.from ?? message.from);
    const body: AssistantInbound = {
      envelope: message.from,
      from: mail.from,
      name: mail.name,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      authenticated: mail.authenticated,
      envelopeSigned: envelopeProven(mail, message.from),
      docs,
      skipped: mail.skipped,
    };
    const res = await toOffice(env, internal("/internal/assistant-email", body), system(assistant));
    if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
    return;
  }
  const officeId = await cp(env).routeFor("email", to);
  if (!officeId) {
    message.setReject("There is no office at this address.");
    return;
  }
  const mail = await parseInbound(message.raw, { both: true, results: authResults(message) });
  if (!(await admitted(env, officeId, "email", mail, message.from))) return;
  const docs = await storeAttachments(env, officeId, mail, mail.from ?? message.from);
  const body: MailDocs = { from: mail.from ?? message.from, subject: mail.subject, docs, skipped: mail.skipped, authenticated: mail.authenticated };
  const res = await toOffice(env, internal("/internal/email", body), system(officeId));
  if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
}

/** Each night: offices deleted more than 30 days ago lose their books, files and links; their copies in India are queued for deletion. */
export async function purgeDeleted(env: Env): Promise<number> {
  const plane = cp(env);
  const due = await plane.purgeDue();
  for (const o of due) {
    const res = await toOffice(env, internal("/internal/purge", {}), system(o.id));
    if (!res.ok) {
      log("error", "purge.failed", { officeId: o.id, status: res.status });
      continue;
    }
    let cursor: string | undefined;
    do {
      const page = await env.DOCS.list({ prefix: officePrefix(o.id), cursor });
      if (page.objects.length) await env.DOCS.delete(page.objects.map((x) => x.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (backupTarget(env)) await plane.queueBackupErasure(o.id);
    await plane.forget(o.id);
    log("info", "office.purged", { officeId: o.id });
  }
  return due.length;
}

/**
 * Requests to the store in India one night may make. The Workers free plan allows 50 outside requests for each
 * run of the cron, and nothing else in the run makes any. An erasure that does not finish goes on the next night.
 */
const ERASE_REQUESTS = 40;

/**
 * Each night: the daily copies in India of offices purged since are deleted, a page of up to 1,000 at a time.
 * A failure is kept with the office's row and tried again the next night; the audit trail records the end.
 */
export async function eraseBackups(env: Env): Promise<number> {
  const target = backupTarget(env);
  if (!target) return 0;
  const plane = cp(env);
  let budget = ERASE_REQUESTS;
  let finished = 0;
  for (const job of await plane.backupErasures(10)) {
    if (budget < 2) break;
    let erased = 0;
    try {
      let done = false;
      while (budget >= 2) {
        budget--;
        // Always the first page: what was deleted is gone from the listing.
        const page = await listObjects(target, officeBackupPrefix(job.officeId));
        if (page.keys.length) {
          budget--;
          await deleteObjects(target, page.keys);
          erased += page.keys.length;
        }
        if (!page.truncated) {
          done = true;
          break;
        }
      }
      await plane.backupErasureProgress(job.officeId, erased, done ? job.erased + erased : null);
      if (done) {
        finished++;
        log("info", "office.backups-erased", { officeId: job.officeId, count: job.erased + erased });
      }
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await plane.backupErasureProgress(job.officeId, erased, null, why);
      log("error", "backups-erase.failed", { officeId: job.officeId }, e);
    }
  }
  return finished;
}

/** How many pages of retained copies one night looks at, so the run stays small; the rest wait for the next night. */
const SWEEP_PAGES = 10;

/**
 * Each night: a purged office's retained copy of its books and edit log (`retained/`) is deleted once the
 * keep-until date it was written with has passed, and that office's audit trail says so. A copy whose date
 * cannot be read is kept.
 */
export async function sweepRetained(env: Env, now = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const plane = cp(env);
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const listed = await env.DOCS.list({ prefix: "retained/", cursor });
    const due = listed.objects.filter((o) => {
      const until = retainedKeepUntil(o);
      return until !== null && until < today;
    });
    if (due.length) {
      await env.DOCS.delete(due.map((o) => o.key));
      deleted += due.length;
      await plane.auditMany(
        [...new Set(due.map((o) => retainedOffice(o.key)).filter((id): id is string => id !== null))].map((officeId) => ({
          officeId,
          actor: "system",
          action: "office.retained-deleted",
          detail: "the retention period of its books ended",
        })),
      );
      log("info", "retained.deleted", { count: due.length });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return deleted;
}

/** The nightly cron: deleted offices purged after 30 days, their copies in India deleted, then retained copies past their date. */
export async function nightly(env: Env): Promise<void> {
  // Each step runs even when one before it fails, so one bad office cannot hold back the others' duties.
  for (const [name, step] of [
    ["purge", purgeDeleted],
    ["erase-backups", eraseBackups],
    ["sweep-retained", sweepRetained],
  ] as const) {
    try {
      await step(env);
    } catch (e) {
      log("error", "nightly.failed", { step: name }, e);
    }
  }
}
