import {
  AcceptInvitation,
  ACCOUNT_ROUTES,
  BRAND,
  ChatPost,
  ConsentRequest,
  RightsRequest,
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
import type { Env } from "./env";
import { AccountRecords } from "./account";
import { type SupportMail, turnstileOk, widgetScript } from "./customer/channels";
import { docKey, mediaKey, officePrefix } from "./keys";
import { parseInbound } from "./mail";
import { planMeta } from "./routing";
import { MEDIA_ID, verifyMedia } from "./social/media";
import { readState } from "./social/oauth";
import { metaChallenge, verifyMetaSignature } from "./social/webhooks";
import { ControlPlane, ingestAddress, OFFICE_ID, type OfficeRow, PURGE_AFTER_MS } from "./tenancy";
import { sendText } from "./whatsapp/cloud";
import { WaDirectory } from "./whatsapp/links";
import { weatherFor, type Where } from "./weather";
import { zip, type ZipEntry } from "./zip";

type User = { id: string; name: string; email: string; emailVerified: boolean };
type Vars = { user: User; caller: Caller; office: OfficeRow };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** Not "forbidden": someone outside an office cannot tell whether it exists. */
const NOT_FOUND = { error: "Not found" };
const iso = (ms: number) => new Date(ms).toISOString();
const cp = (env: Env) => new ControlPlane(env.DB);

/** The one way into an office's Durable Object: named by the checked office id, carrying who is asking. */
export function toOffice(env: Env, req: Request, caller: Caller, path?: string): Promise<Response> {
  const url = new URL(req.url);
  if (path !== undefined) url.pathname = path;
  const forwarded = new Request(url, req);
  forwarded.headers.set("x-partykit-room", caller.officeId);
  forwarded.headers.set(CALLER_HEADER, JSON.stringify(caller));
  forwarded.headers.delete("x-office-as");
  return env.Office.get(env.Office.idFromName(caller.officeId)).fetch(forwarded);
}

const internal = (path: string, body: unknown) => new Request(`https://office.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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
  if (plan.unrouted) console.log(JSON.stringify({ event: "meta.unrouted", entries: plan.unrouted }));
  let ok = true;
  for (const d of plan.deliveries) ok = (await toOffice(env, internal("/internal/social/meta", d.body), system(d.officeId))).ok && ok;
  for (const o of plan.office) ok = (await toOffice(env, internal("/internal/whatsapp", { body: o.body, person: o.person, joined: o.joined, heading: o.heading }), system(o.officeId))).ok && ok;
  const keys = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? { token: env.WHATSAPP_TOKEN, phoneId: env.WHATSAPP_PHONE_NUMBER_ID, template: null } : null;
  if (keys) for (const r of plan.replies) await sendText(keys, r.to, r.text).catch(() => console.error("whatsapp reply failed"));
  return ok;
}

/** Short-lived public links to post pictures, for platforms that fetch media themselves. Signed for one office and one picture. */
app.get("/media/:office/:id", async (c) => {
  const { office, id } = c.req.param();
  if (!OFFICE_ID.test(office) || !c.env.SOCIAL_TOKEN_KEY || !(await verifyMedia(c.env.SOCIAL_TOKEN_KEY, office, id, c.req.query("exp") ?? null, c.req.query("sig") ?? null))) return c.text("Not found", 404);
  const obj = await c.env.DOCS.get(mediaKey(office, id));
  if (!obj) return c.text("Not found", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" } });
});

/* ---------- The website chat: public, on the business's own site; the key decides the office ---------- */

const CHAT_CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const WIDGET_KEY = /^w[a-z0-9]{8,40}$/;

app.get("/w/:file", async (c) => {
  const key = c.req.param("file").replace(/\.js$/, "");
  if (!WIDGET_KEY.test(key) || !(await cp(c.env).routeFor("widget", key))) return c.text("// This chat is not switched on.", 404, { "content-type": "text/javascript" });
  return c.body(widgetScript(key, new URL(c.req.url).origin, c.env.TURNSTILE_SITE_KEY ?? null), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
});

app.options("/api/chat/:key", (c) => c.body(null, 204, CHAT_CORS));

app.get("/api/chat/:key", async (c) => {
  const key = c.req.param("key");
  const visitor = c.req.query("visitor") ?? "";
  const officeId = WIDGET_KEY.test(key) ? await cp(c.env).routeFor("widget", key) : null;
  if (!officeId || !ChatPost.shape.visitor.safeParse(visitor).success) return c.json(NOT_FOUND, 404, CHAT_CORS);
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
  if (c.env.CHAT_LIMIT && !(await c.env.CHAT_LIMIT.limit({ key: `${key}:${ip ?? parsed.data.visitor}` })).success) return c.json({ error: "That is a lot of messages at once. Wait a minute and try again." }, 429, CHAT_CORS);
  if (!(await turnstileOk(c.env.TURNSTILE_SECRET, parsed.data.turnstile, ip))) return c.json({ error: "Tick the box to show you are a person, then send again." }, 403, CHAT_CORS);
  const res = await toOffice(c.env, internal("/internal/chat", { visitor: parsed.data.visitor, text: parsed.data.text, name: parsed.data.name ?? null }), system(officeId));
  return c.body(await res.text(), res.status as 200, { ...CHAT_CORS, "content-type": "application/json" });
});

/* ---------- Everything else needs someone signed in ---------- */

app.use("/api/*", async (c, next) => {
  const session = await makeAuth(c.env, new URL(c.req.url).host).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in to continue." }, 401);
  const u = session.user;
  c.set("user", { id: u.id, name: u.name, email: u.email, emailVerified: Boolean(u.emailVerified) });
  await next();
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const records = new AccountRecords(c.env.DB);
  return c.json({
    user,
    offices: await cp(c.env).officesOf(user.id),
    verificationRequired: verificationRequired(c.env),
    consentNeeded: await records.consentNeeded(user.id),
    deletionRequested: await records.deletionRequested(user.id),
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
  return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="my-account.json"', "cache-control": "no-store" } });
});

app.get(ACCOUNT_ROUTES.accountRequests, async (c) => c.json({ requests: await new AccountRecords(c.env.DB).requests(c.get("user").id) }));

app.post(ACCOUNT_ROUTES.accountRequests, async (c) => {
  const parsed = RightsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const r = await new AccountRecords(c.env.DB).requestDeletion(c.get("user"), parsed.data.note ?? null);
  return "error" in r ? c.json(r, 409) : c.json(r, 201);
});

app.delete(`${ACCOUNT_ROUTES.accountRequests}/:id`, async (c) => {
  const done = await new AccountRecords(c.env.DB).withdraw(c.get("user").id, c.req.param("id"));
  return done ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
});

app.post("/api/offices", async (c) => {
  const user = c.get("user");
  if (verificationRequired(c.env) && !user.emailVerified) return c.json({ error: "Confirm your email address first. We sent you a link when you signed up." }, 403);
  const parsed = OpenOffice.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the business a name." }, 400);
  const made = await cp(c.env).createOffice({ name: parsed.data.name, owner: user, ingestDomain: c.env.INGEST_DOMAIN });
  if ("error" in made) return c.json(made, 429);
  return c.json({ id: made.id, name: made.name, role: "owner", status: made.status }, 201);
});

app.get("/api/invitations/:token", async (c) => {
  const peek = await cp(c.env).peekInvite(c.req.param("token"));
  return peek ? c.json(peek) : c.json({ error: "This invitation has expired or was already used. Ask for a new one." }, 404);
});

app.post("/api/invitations/accept", async (c) => {
  const parsed = AcceptInvitation.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That link is not complete. Open it again from the email." }, 400);
  const r = await cp(c.env).acceptInvite(parsed.data.token, { ...c.get("user"), emailVerified: c.get("user").emailVerified || !verificationRequired(c.env) });
  return "error" in r ? c.json(r, 403) : c.json(r);
});

/* ---------- The platform owners' console: every business's account, never its books ---------- */

export const platformOwners = (env: Pick<Env, "PLATFORM_OWNERS">) =>
  new Set(
    (env.PLATFORM_OWNERS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

const platformOnly = async (c: Ctx, next: () => Promise<void>) => {
  const user = c.get("user");
  if (!platformOwners(c.env).has(user.email.toLowerCase())) return c.json({ error: "This console is for the people who run the platform. Businesses sign in at their own address." }, 403);
  if (verificationRequired(c.env) && !user.emailVerified) return c.json({ error: "Confirm your email address first, then come back." }, 403);
  await next();
};
app.use(PLATFORM_ROUTES.view, platformOnly);
app.use("/api/platform/*", platformOnly);

const ownerInviteMail = (env: Env, officeName: string, email: string, token: string) => {
  const link = `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/?invite=${encodeURIComponent(token)}`;
  const sent = sendMail(
    env,
    email,
    `Your office for ${officeName} is ready`,
    [`We have opened ${officeName} on ${BRAND.name}, with you as its owner: you approve the team's work, hire and invite your accountant.`, "", "Open this link to set up your account and step in. It works once, for 14 days:", link, "", "Sign in or make an account with this address."].join("\n"),
  );
  return { link, sent };
};

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
  const made = await cp(c.env).onboard({ name: parsed.data.name, ownerEmail: email, by: c.get("user").email, ingestDomain: c.env.INGEST_DOMAIN });
  if ("error" in made) return c.json(made, 500);
  const { link, sent } = ownerInviteMail(c.env, made.office.name, email, made.token);
  return c.json({ id: made.office.id, name: made.office.name, email, link, emailed: await sent, expiresAt: iso(made.expiresAt) } satisfies PlatformInvited, 201);
});

app.put("/api/platform/businesses/:id/status", async (c) => {
  const parsed = PlatformStatusChange.safeParse(await c.req.json().catch(() => null));
  const office = await cp(c.env).office(c.req.param("id"));
  if (!office) return c.json(NOT_FOUND, 404);
  if (!parsed.success) return c.json({ error: "Choose active or suspended." }, 400);
  if (office.status === "deleting") return c.json({ error: "Its owner is deleting this office. Only they can restore it, within 30 days." }, 409);
  if (office.status !== parsed.data.status) await cp(c.env).setStatus(office.id, parsed.data.status, c.get("user").email);
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
  if ((await plane.members(office.id)).some((m) => m.email.toLowerCase() === email)) return c.json({ error: `${email} is already in this office.` }, 409);
  const { token, expiresAt } = await plane.invite(office.id, email, "owner", c.get("user").email);
  const { link, sent } = ownerInviteMail(c.env, office.name, email, token);
  return c.json({ id: office.id, name: office.name, email, link, emailed: await sent, expiresAt: iso(expiresAt) } satisfies PlatformInvited);
});

/** The platform's sign-in comes back to one address for every office; the signed state says which office started it. */
app.get("/api/channels/:platform/callback", async (c) => {
  const platform = PlatformEnum.safeParse(c.req.param("platform"));
  const state = platform.success && c.env.SOCIAL_TOKEN_KEY ? await readState(c.env.SOCIAL_TOKEN_KEY, platform.data, c.req.query("state") ?? null) : null;
  const user = c.get("user");
  const m = state && OFFICE_ID.test(state.officeId) ? await cp(c.env).membership(state.officeId, user.id) : null;
  if (!state || !m || m.office.status !== "active" || m.role !== "owner" || state.by !== user.email) return c.redirect(`/settings?connect_error=${encodeURIComponent("That sign-in did not come from your office. Try again from Settings.")}#channels`);
  return toOffice(c.env, c.req.raw, { userId: user.id, name: user.name, email: user.email, role: m.role, officeId: m.office.id });
});

/* ---------- Inside one office: membership is checked on every request, never cached ---------- */

app.use("/api/o/:office/*", async (c, next) => {
  const id = c.req.param("office");
  if (!OFFICE_ID.test(id)) return c.json(NOT_FOUND, 404);
  const user = c.get("user");
  const m = await cp(c.env).membership(id, user.id);
  if (!m) return c.json(NOT_FOUND, 404);
  const rest = new URL(c.req.url).pathname.slice(`/api/o/${id}`.length);
  if (m.office.status === "deleting" && !(m.role === "owner" && (rest === "/office-admin" || rest === "/office-admin/restore" || rest === "/office-admin/export"))) return c.json(NOT_FOUND, 404);
  if (m.office.status === "suspended") return c.json({ error: "This office is suspended. Write to us to have it opened again." }, 423);
  c.set("office", m.office);
  c.set("caller", { userId: user.id, name: user.name, email: user.email, role: m.role, officeId: id });
  await next();
});

const ownerOnly = (c: Ctx) => (c.get("caller").role === "owner" ? null : c.json({ error: "Only the owner can do that." }, 403));

/** For the Lived-in office's small talk: the weather near the person looking, never stored with them. */
app.get(`/api/o/:office${ROUTES.weather.slice(4)}`, async (c) => {
  const cache = (globalThis as { caches?: { default?: Parameters<typeof weatherFor>[1]["cache"] } }).caches?.default ?? null;
  const userAgent = `agentic-office/1.0 (${c.env.BETTER_AUTH_URL}; ${c.env.MAIL_FROM})`;
  const weather = await weatherFor(c.req.raw.cf as Where | undefined, { fetcher: (u, i) => fetch(u, i), cache, userAgent });
  return c.json({ weather }, 200, { "cache-control": "private, max-age=900" });
});

app.get("/api/o/:office/files/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^doc-[\w-]+(\.txt)?$/.test(id)) return c.json({ error: "File not found" }, 404);
  const obj = await c.env.DOCS.get(docKey(c.get("caller").officeId, id));
  if (!obj) return c.json({ error: "File not found" }, 404);
  const name = (obj.customMetadata?.filename ?? id).replace(/["\\\r\n]/g, "");
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
});

app.get("/api/o/:office/social/media/:id", async (c) => {
  const id = c.req.param("id");
  if (!MEDIA_ID.test(id)) return c.json({ error: "Picture not found" }, 404);
  const obj = await c.env.DOCS.get(mediaKey(c.get("caller").officeId, id));
  if (!obj) return c.json({ error: "Picture not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});

/* ---------- The office as an account: people, invitations, export, deletion ---------- */

app.get("/api/o/:office/office-admin", async (c) => {
  const office = c.get("office");
  const caller = c.get("caller");
  const plane = cp(c.env);
  const owner = caller.role === "owner";
  const [members, invitations, audit, emailRoutes] = await Promise.all([plane.members(office.id), owner ? plane.invitations(office.id) : [], owner ? plane.auditTrail(office.id, 30) : [], plane.routesOf(office.id, "email")]);
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
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = InviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter the email address to invite." }, 400);
  const office = c.get("office");
  const caller = c.get("caller");
  const plane = cp(c.env);
  const email = parsed.data.email.toLowerCase();
  if ((await plane.members(office.id)).some((m) => m.email.toLowerCase() === email)) return c.json({ error: `${email} is already in this office.` }, 409);
  const { token, expiresAt } = await plane.invite(office.id, email, parsed.data.role, caller.email);
  const link = `${c.env.BETTER_AUTH_URL.replace(/\/$/, "")}/?invite=${encodeURIComponent(token)}`;
  const what = parsed.data.role === "owner" ? "as an owner" : "to read the books, download returns and answer the Auditor";
  const emailed = await sendMail(
    c.env,
    email,
    `${caller.name} invited you to ${office.name}`,
    [`${caller.name} invited you to ${office.name} on ${BRAND.name}, ${what}.`, "", "Open this link to join. It works once, for 14 days:", link, "", "Sign in or make an account with this address."].join("\n"),
    office.name,
  );
  return c.json({ email, link, emailed, expiresAt: iso(expiresAt) } satisfies InviteResult);
});

app.delete("/api/o/:office/office-admin/invitations/:email", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const done = await cp(c.env).revokeInvite(c.get("office").id, decodeURIComponent(c.req.param("email")), c.get("caller").email);
  return done ? c.json({ ok: true }) : c.json({ error: "No such invitation." }, 404);
});

app.put("/api/o/:office/office-admin/members/:user", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = RoleChange.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose owner or accountant." }, 400);
  const err = await cp(c.env).setRole(c.get("office").id, c.req.param("user"), parsed.data.role, c.get("caller").email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.delete("/api/o/:office/office-admin/members/:user", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const err = await cp(c.env).removeMember(c.get("office").id, c.req.param("user"), c.get("caller").email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.post("/api/o/:office/office-admin/leave", async (c) => {
  const caller = c.get("caller");
  const err = await cp(c.env).removeMember(caller.officeId, caller.userId, caller.email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

app.post("/api/o/:office/office-admin/transfer", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = TransferRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose who will own the office." }, 400);
  const caller = c.get("caller");
  const err = await cp(c.env).transferOwnership(caller.officeId, caller.userId, parsed.data.userId, caller.email);
  return err ? c.json({ error: err }, 409) : c.json({ ok: true });
});

/** Everything the office holds, in one archive: the books as JSON and every stored file. */
app.get("/api/o/:office/office-admin/export", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const caller = c.get("caller");
  const res = await toOffice(c.env, internal("/internal/export", {}), system(caller.officeId));
  if (!res.ok) return c.json({ error: "The office could not be read. Try again." }, 500);
  const entries: ZipEntry[] = [{ name: "books.json", data: await res.text() }];
  const prefix = officePrefix(caller.officeId);
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await c.env.DOCS.list({ prefix, cursor });
    for (const o of page.objects) {
      if (total + o.size > 200 * 1024 * 1024) break;
      const obj = await c.env.DOCS.get(o.key);
      if (!obj) continue;
      total += o.size;
      entries.push({ name: `files/${o.key.slice(prefix.length)}`, data: new Uint8Array(await obj.arrayBuffer()) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await cp(c.env).audit(caller.officeId, caller.email, "office.exported", `${entries.length} files`);
  const name = c.get("office").name.replace(/[^\w-]+/g, "-").slice(0, 40) || "office";
  return new Response(zip(entries), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}-export.zip"` } });
});

/** Deleting hides the office from everyone at once; its books and files stay 30 days in case it was a mistake. */
app.delete("/api/o/:office/office-admin", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = DeleteOffice.safeParse(await c.req.json().catch(() => null));
  const office = c.get("office");
  if (!parsed.success || parsed.data.confirm.trim() !== office.name) return c.json({ error: `Type ${office.name} to delete the office.` }, 400);
  await cp(c.env).setStatus(office.id, "deleting", c.get("caller").email);
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

/** Mail to `<slug>@INGEST_DOMAIN`: the address alone says which office it is for; any other address is refused. */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const to = message.to.trim().toLowerCase();
  const support = await cp(env).routeFor("support_email", to);
  if (support) {
    const mail = await parseInbound(message.raw);
    const body: SupportMail = { from: mail.from ?? message.from, name: mail.name, subject: mail.subject, text: mail.text, messageId: mail.messageId, inReplyTo: mail.inReplyTo };
    const res = await toOffice(env, internal("/internal/support-email", body), system(support));
    if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
    return;
  }
  const officeId = await cp(env).routeFor("email", to);
  if (!officeId) {
    message.setReject("There is no office at this address.");
    return;
  }
  const mail = await parseInbound(message.raw);
  const docs: InboundDocs["docs"] = [];
  for (const a of mail.attachments) {
    const id = newDocId();
    await env.DOCS.put(docKey(officeId, id), a.content, { httpMetadata: { contentType: a.mimeType }, customMetadata: { filename: a.filename, by: mail.from ?? message.from } });
    docs.push({ id, mimeType: a.mimeType, filename: a.filename });
  }
  const body: InboundDocs = { from: mail.from ?? message.from, subject: mail.subject, docs, skipped: mail.skipped };
  const res = await toOffice(env, internal("/internal/email", body), system(officeId));
  if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
}

/** Each night: offices deleted more than 30 days ago lose their books, files and links. */
export async function purgeDeleted(env: Env): Promise<number> {
  const plane = cp(env);
  const due = await plane.purgeDue();
  for (const o of due) {
    const res = await toOffice(env, internal("/internal/purge", {}), system(o.id));
    if (!res.ok) {
      console.error(JSON.stringify({ event: "purge.failed", office: o.id, status: res.status }));
      continue;
    }
    let cursor: string | undefined;
    do {
      const page = await env.DOCS.list({ prefix: officePrefix(o.id), cursor });
      if (page.objects.length) await env.DOCS.delete(page.objects.map((x) => x.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await plane.forget(o.id);
    console.log(JSON.stringify({ event: "office.purged", office: o.id }));
  }
  return due.length;
}
