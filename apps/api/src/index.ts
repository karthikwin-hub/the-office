import { Hono } from "hono";
import { z } from "zod";
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { invite, makeAuth } from "./auth";
import type { Env } from "./env";
import { parseInbound } from "./mail";
import { CALLER_HEADER, type Caller, type InboundDocs, newDocId, SYSTEM } from "./office-agent";
import * as schema from "./schema";
import { MEDIA_ID, verifyMedia } from "./social/media";
import { metaChallenge, verifyMetaSignature } from "./social/webhooks";

export { Office } from "./office-agent";

type Vars = { caller: Caller };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function officeStub(env: Env) {
  return env.Office.get(env.Office.idFromName(env.OFFICE_ID));
}

/** Requests reach the Office only through here, carrying who is asking; anything a browser sent in that header is replaced. */
function toOffice(env: Env, req: Request, caller: Caller, url = req.url) {
  const forwarded = new Request(url, req);
  forwarded.headers.set("x-partykit-room", env.OFFICE_ID);
  forwarded.headers.set(CALLER_HEADER, JSON.stringify(caller));
  forwarded.headers.delete("x-office-as");
  return officeStub(env).fetch(forwarded);
}

app.get("/api/health", (c) => c.json({ ok: true, mode: c.env.DATA_MODE }));

/** Tells the sign-in screen whether to offer "Open your office" (no owner yet) or a plain sign-in. */
app.get("/api/auth-status", async (c) => {
  const [{ n }] = (await drizzle(c.env.DB, { schema }).select({ n: count() }).from(schema.user)) as [{ n: number }];
  return c.json({ hasOwner: n > 0 });
});

app.on(["GET", "POST"], "/api/auth/*", (c) => makeAuth(c.env).handler(c.req.raw));

/** Meta's subscription handshake, then signed deliveries. No session here: the signature is the check. */
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
  const req = new Request("https://office.internal/internal/social/meta", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  const res = await toOffice(c.env, req, SYSTEM);
  return res.ok ? c.text("OK") : c.text("Not taken", 500);
});

/** Short-lived public links to post pictures, for platforms that fetch media themselves. */
app.get("/media/:id", async (c) => {
  const id = c.req.param("id");
  if (!c.env.SOCIAL_TOKEN_KEY || !(await verifyMedia(c.env.SOCIAL_TOKEN_KEY, id, c.req.query("exp") ?? null, c.req.query("sig") ?? null))) return c.text("Not found", 404);
  const obj = await c.env.DOCS.get(`media/${id}`);
  if (!obj) return c.text("Not found", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" } });
});

app.use("/api/*", async (c, next) => {
  const session = await makeAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in to continue." }, 401);
  const role = (session.user as { role?: string }).role === "owner" ? "owner" : "accountant";
  c.set("caller", { name: session.user.name, email: session.user.email, role });
  await next();
});

app.get("/api/files/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^doc-[\w-]+$/.test(id)) return c.json({ error: "File not found" }, 404);
  const obj = await c.env.DOCS.get(`docs/${id}`);
  if (!obj) return c.json({ error: "File not found" }, 404);
  const name = (obj.customMetadata?.filename ?? id).replace(/["\\\r\n]/g, "");
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
});

app.get("/api/social/media/:id", async (c) => {
  const id = c.req.param("id");
  if (!MEDIA_ID.test(id)) return c.json({ error: "Picture not found" }, 404);
  const obj = await c.env.DOCS.get(`media/${id}`);
  if (!obj) return c.json({ error: "Picture not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});

app.post("/api/invites", async (c) => {
  const caller = c.get("caller");
  if (caller.role !== "owner") return c.json({ error: "Only the owner can invite people." }, 403);
  const parsed = z.object({ email: z.string().email().max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter the accountant's email address." }, 400);
  await invite(c.env, parsed.data.email, caller.email);
  return c.json({ invited: parsed.data.email.toLowerCase() });
});

/** Open browsers listen here and refetch when the books change. */
app.get("/api/live", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected a WebSocket" }, 426);
  return toOffice(c.env, c.req.raw, c.get("caller"));
});

app.all("/api/*", (c) => toOffice(c.env, c.req.raw, c.get("caller")));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  /** Bills and invoices emailed to the office address: attachments go to R2, the Office logs them and reads what it can. */
  async email(message: ForwardableEmailMessage, env: Env) {
    const mail = await parseInbound(message.raw);
    const docs: InboundDocs["docs"] = [];
    for (const a of mail.attachments) {
      const id = newDocId();
      await env.DOCS.put(`docs/${id}`, a.content, { httpMetadata: { contentType: a.mimeType }, customMetadata: { filename: a.filename, by: mail.from ?? message.from } });
      docs.push({ id, mimeType: a.mimeType, filename: a.filename });
    }
    const body: InboundDocs = { from: mail.from ?? message.from, subject: mail.subject, docs, skipped: mail.skipped };
    const req = new Request("https://office.internal/internal/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await toOffice(env, req, SYSTEM);
    if (!res.ok) throw new Error(`The office could not take the email (${res.status}).`);
  },
} satisfies ExportedHandler<Env>;
