import { INDIA, type Me, type OfficeAdmin, type Role } from "@office/contracts";
import type { OfficeService } from "@office/engine";
import { HttpResponse } from "msw";

type Person = { name: string; email: string };
const OFFICE_ID = "kaveri-electricals";
const day = 24 * 3600_000;

let state: { status: OfficeAdmin["status"]; purgeAt: string | null; members: OfficeAdmin["members"]; invitations: OfficeAdmin["invitations"]; audit: OfficeAdmin["audit"] } | null = null;

function seed(users: Record<Role, Person>) {
  const at = (days: number) => new Date(Date.parse("2026-11-04T10:00:00+05:30") - days * day).toISOString();
  return (state ??= {
    status: "active",
    purgeAt: null,
    members: [
      { userId: "u-anil", ...users.owner, role: "owner", since: at(400), you: false },
      { userId: "u-rajesh", ...users.accountant, role: "accountant", since: at(380), you: false },
    ],
    invitations: [],
    audit: [
      { actor: users.accountant.email, action: "invitation.accepted", detail: "accountant", at: at(380) },
      { actor: users.owner.email, action: "invitation.sent", detail: `${users.accountant.email} as accountant`, at: at(381) },
      { actor: users.owner.email, action: "office.opened", detail: "Kaveri Electricals", at: at(400) },
    ],
  });
}

/** Who is signed in to the sample office, as the live app's `/api/me` would say. */
export function mockMe(role: Role, users: Record<Role, Person>, office: OfficeService): Response {
  const u = users[role];
  return HttpResponse.json({
    user: { id: role === "owner" ? "u-anil" : "u-rajesh", name: u.name, email: u.email, emailVerified: true },
    offices: [{ id: OFFICE_ID, name: office.books.business.name, role, status: "active", locale: INDIA }],
    verificationRequired: false,
    consentNeeded: [],
    deletionRequested: false,
  } satisfies Me);
}

/** The owner's Office section, in memory: invitations, roles and deletion work, and nothing leaves the page. */
export async function mockOfficeAdmin(request: Request, path: string, role: Role, office: OfficeService, users: Record<Role, Person>): Promise<Response | null> {
  if (!path.startsWith("/api/office-admin")) return null;
  const s = seed(users);
  const me = role === "owner" ? "u-anil" : "u-rajesh";
  const by = users[role].email;
  const now = new Date().toISOString();
  const ownerOnly = role === "owner" ? null : HttpResponse.json({ error: "Only the owner can do that." }, { status: 403 });
  const body: unknown = request.method === "GET" ? {} : await request.json().catch(() => ({}));
  const view = (): OfficeAdmin => ({
    id: OFFICE_ID,
    name: office.books.business.name,
    status: s.status,
    ingestEmail: office.settings().ingestEmail,
    locale: INDIA,
    purgeAt: s.purgeAt,
    members: s.members.map((m) => ({ ...m, you: m.userId === me })),
    invitations: role === "owner" ? s.invitations : [],
    audit: role === "owner" ? s.audit : [],
  });
  const log = (action: string, detail: string | null = null) => s.audit.unshift({ actor: by, action, detail, at: now });

  if (path === "/api/office-admin" && request.method === "GET") return HttpResponse.json(view());
  if (ownerOnly && path !== "/api/office-admin/leave") return ownerOnly;
  if (path === "/api/office-admin/invitations" && request.method === "POST") {
    const email = String((body as { email?: string }).email ?? "").trim().toLowerCase();
    const r: Role = (body as { role?: Role }).role === "owner" ? "owner" : "accountant";
    if (!/^\S+@\S+\.\S+$/.test(email)) return HttpResponse.json({ error: "Enter the email address to invite." }, { status: 400 });
    if (s.members.some((m) => m.email === email)) return HttpResponse.json({ error: `${email} is already in this office.` }, { status: 409 });
    const expiresAt = new Date(Date.now() + 14 * day).toISOString();
    s.invitations = [{ email, role: r, invitedBy: by, expiresAt }, ...s.invitations.filter((i) => i.email !== email)];
    log("invitation.sent", `${email} as ${r}`);
    return HttpResponse.json({ email, link: `${location.origin}/?invite=sample-invitation-for-the-mockup`, emailed: false, expiresAt });
  }
  const inv = /^\/api\/office-admin\/invitations\/(.+)$/.exec(path);
  if (inv && request.method === "DELETE") {
    const email = decodeURIComponent(inv[1]!);
    s.invitations = s.invitations.filter((i) => i.email !== email);
    log("invitation.revoked", email);
    return HttpResponse.json({ ok: true });
  }
  const member = /^\/api\/office-admin\/members\/(.+)$/.exec(path);
  if (member) {
    const target = s.members.find((m) => m.userId === decodeURIComponent(member[1]!));
    if (!target) return HttpResponse.json({ error: "That person is not in this office." }, { status: 404 });
    const owners = s.members.filter((m) => m.role === "owner").length;
    if (request.method === "PUT") {
      const r: Role = (body as { role?: Role }).role === "owner" ? "owner" : "accountant";
      if (target.role === "owner" && r !== "owner" && owners === 1) return HttpResponse.json({ error: "The office needs an owner. Make someone else the owner first." }, { status: 409 });
      target.role = r;
      log("member.role", `${target.email} is now ${r}`);
      return HttpResponse.json({ ok: true });
    }
    if (request.method === "DELETE") {
      if (target.role === "owner" && owners === 1) return HttpResponse.json({ error: "The only owner cannot leave. Hand the office to someone first, or delete it." }, { status: 409 });
      s.members = s.members.filter((m) => m !== target);
      log("member.removed", target.email);
      return HttpResponse.json({ ok: true });
    }
  }
  if (path === "/api/office-admin/leave" && request.method === "POST") return HttpResponse.json({ error: "The sample office keeps both of its people." }, { status: 409 });
  if (path === "/api/office-admin/transfer" && request.method === "POST") return HttpResponse.json({ error: "The sample office stays with its owner." }, { status: 409 });
  if (path === "/api/office-admin/export" && request.method === "GET") {
    log("office.exported", "books only");
    return new HttpResponse(JSON.stringify({ office: OFFICE_ID, exportedAt: now, books: office.books }, null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="Kaveri-Electricals-export.json"' } });
  }
  if (path === "/api/office-admin" && request.method === "DELETE") {
    if (String((body as { confirm?: string }).confirm ?? "").trim() !== office.books.business.name) return HttpResponse.json({ error: `Type ${office.books.business.name} to delete the office.` }, { status: 400 });
    s.status = "deleting";
    s.purgeAt = new Date(Date.now() + 30 * day).toISOString();
    log("office.deleting");
    return HttpResponse.json({ ok: true, purgeAt: s.purgeAt });
  }
  if (path === "/api/office-admin/restore" && request.method === "POST") {
    s.status = "active";
    s.purgeAt = null;
    log("office.active");
    return HttpResponse.json({ ok: true });
  }
  return HttpResponse.json({ error: "Not found" }, { status: 404 });
}
