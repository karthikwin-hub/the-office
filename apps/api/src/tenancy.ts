import type { Role } from "@office/contracts";
import { b64url } from "./social/tokens";

/**
 * The control plane: which offices exist, who belongs to each, and where inbound
 * mail and webhooks go. The books themselves never come here; each office keeps
 * them in its own Durable Object. Every query that returns office data names the
 * office it is for.
 */

export type OfficeStatus = "active" | "suspended" | "deleting";
export type OfficeRow = { id: string; name: string; slug: string; status: OfficeStatus; createdBy: string | null; createdAt: number; deletedAt: number | null };
export type RouteKind = "email" | "wa_phone" | "meta_page" | "ig_account" | "threads" | "linkedin" | "x";
export type Member = { userId: string; name: string; email: string; role: Role; since: number };
export type Invitation = { email: string; role: Role; invitedBy: string; createdAt: number; expiresAt: number };
export type UserRef = { id: string; name: string; email: string; emailVerified: boolean };

export const INVITE_TTL_MS = 14 * 24 * 3600_000;
/** How many offices one person may open: in a day, and in all. */
export const OPEN_LIMIT = { perDay: 3, total: 10 };
/** A deleted office can be restored for this long; then its books and files are purged. */
export const PURGE_AFTER_MS = 30 * 24 * 3600_000;

const enc = new TextEncoder();
const emailKey = (e: string) => e.trim().toLowerCase();

/** `off_` and 16 random letters and digits: unguessable, and never derived from the business name. */
export function newOfficeId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return `off_${[...random(16)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}
export const OFFICE_ID = /^(off_[a-z2-9]{16}|kaveri-electricals)$/;

/** "Kaveri Electricals" becomes "kaveri-electricals-7k2x": readable in an email address, unique with the suffix. */
export function slugFor(name: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "office";
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return `${base}-${[...random(4)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function hashToken(token: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(token)));
}

type OfficeDb = { id: string; name: string; slug: string; status: OfficeStatus; created_by: string | null; created_at: number; deleted_at: number | null };
const toOffice = (r: OfficeDb): OfficeRow => ({ id: r.id, name: r.name, slug: r.slug, status: r.status, createdBy: r.created_by, createdAt: r.created_at, deletedAt: r.deleted_at });

export class ControlPlane {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  /* ---------- Offices and who is in them ---------- */

  async office(id: string): Promise<OfficeRow | null> {
    const r = await this.db.prepare("SELECT * FROM office WHERE id = ?").bind(id).first<OfficeDb>();
    return r ? toOffice(r) : null;
  }

  /** The caller's role in this office, or null if they are not in it. */
  async membership(officeId: string, userId: string): Promise<{ office: OfficeRow; role: Role } | null> {
    const r = await this.db
      .prepare("SELECT o.*, m.role AS member_role FROM membership m JOIN office o ON o.id = m.office_id WHERE m.office_id = ? AND m.user_id = ?")
      .bind(officeId, userId)
      .first<OfficeDb & { member_role: Role }>();
    return r ? { office: toOffice(r), role: r.member_role } : null;
  }

  /** An office being deleted disappears for everyone but its owners, who may still restore it. */
  async officesOf(userId: string): Promise<{ id: string; name: string; role: Role; status: OfficeStatus }[]> {
    const { results } = await this.db
      .prepare("SELECT o.id, o.name, o.status, m.role FROM membership m JOIN office o ON o.id = m.office_id WHERE m.user_id = ? AND (o.status != 'deleting' OR m.role = 'owner') ORDER BY o.name")
      .bind(userId)
      .all<{ id: string; name: string; status: OfficeStatus; role: Role }>();
    return results;
  }

  /** Opens a new, empty office owned by this person, with its own email-in address. */
  async createOffice(input: { name: string; owner: UserRef; ingestDomain: string }): Promise<OfficeRow | { error: string }> {
    const at = this.now();
    const counts = await this.db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today FROM office WHERE created_by = ?")
      .bind(at - 24 * 3600_000, input.owner.id)
      .first<{ total: number; today: number | null }>();
    if ((counts?.today ?? 0) >= OPEN_LIMIT.perDay) return { error: "You have opened several offices today. Try again tomorrow." };
    if ((counts?.total ?? 0) >= OPEN_LIMIT.total) return { error: "You have opened as many offices as one account may. Write to us if you need more." };
    const name = input.name.trim().slice(0, 80);
    for (let i = 0; i < 5; i++) {
      const row: OfficeRow = { id: newOfficeId(), name, slug: slugFor(name), status: "active", createdBy: input.owner.id, createdAt: at, deletedAt: null };
      const taken = await this.db.prepare("SELECT 1 FROM office WHERE id = ? OR slug = ?").bind(row.id, row.slug).first();
      if (taken) continue;
      await this.db.batch([
        this.db.prepare("INSERT INTO office (id, name, slug, status, created_by, created_at) VALUES (?, ?, ?, 'active', ?, ?)").bind(row.id, row.name, row.slug, row.createdBy, at),
        this.db.prepare("INSERT INTO membership (office_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(row.id, input.owner.id, at),
        this.db.prepare("INSERT INTO route (kind, external_id, office_id, created_at) VALUES ('email', ?, ?, ?)").bind(ingestAddress(row.slug, input.ingestDomain), row.id, at),
        this.auditStmt(row.id, input.owner.email, "office.opened", name),
      ]);
      return row;
    }
    return { error: "Could not open the office. Try again." };
  }

  async rename(officeId: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 80);
    if (clean) await this.db.prepare("UPDATE office SET name = ? WHERE id = ? AND name != ?").bind(clean, officeId, clean).run();
  }

  async setStatus(officeId: string, status: OfficeStatus, actor: string): Promise<boolean> {
    const deletedAt = status === "deleting" ? this.now() : null;
    const r = await this.db.prepare("UPDATE office SET status = ?, deleted_at = ? WHERE id = ?").bind(status, deletedAt, officeId).run();
    if (r.meta.changes) await this.audit(officeId, actor, `office.${status}`);
    return r.meta.changes > 0;
  }

  /** Offices deleted long enough ago that their books and files can go. */
  async purgeDue(): Promise<OfficeRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM office WHERE status = 'deleting' AND deleted_at < ?").bind(this.now() - PURGE_AFTER_MS).all<OfficeDb>();
    return results.map(toOffice);
  }

  /** The last of an office: its people, invitations, routes and links go; the audit trail stays. */
  async forget(officeId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM route WHERE office_id = ?").bind(officeId),
      this.db.prepare("DELETE FROM wa_code WHERE office_id = ?").bind(officeId),
      this.db.prepare("UPDATE wa_link SET active_office_id = NULL WHERE active_office_id = ?").bind(officeId),
      this.db.prepare("DELETE FROM invitation WHERE office_id = ?").bind(officeId),
      this.db.prepare("DELETE FROM membership WHERE office_id = ?").bind(officeId),
      this.db.prepare("DELETE FROM office WHERE id = ?").bind(officeId),
      this.auditStmt(officeId, "system", "office.purged"),
    ]);
  }

  async members(officeId: string): Promise<Member[]> {
    const { results } = await this.db
      .prepare("SELECT u.id AS user_id, u.name, u.email, m.role, m.created_at FROM membership m JOIN `user` u ON u.id = m.user_id WHERE m.office_id = ? ORDER BY m.role DESC, u.name")
      .bind(officeId)
      .all<{ user_id: string; name: string; email: string; role: Role; created_at: number }>();
    return results.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, since: r.created_at }));
  }

  /** Changes someone's role; an office always keeps at least one owner. */
  async setRole(officeId: string, userId: string, role: Role, actor: string): Promise<string | null> {
    const members = await this.members(officeId);
    const target = members.find((m) => m.userId === userId);
    if (!target) return "That person is not in this office.";
    if (target.role === "owner" && role !== "owner" && members.filter((m) => m.role === "owner").length === 1) return "The office needs an owner. Make someone else the owner first.";
    await this.db.batch([this.db.prepare("UPDATE membership SET role = ? WHERE office_id = ? AND user_id = ?").bind(role, officeId, userId), this.auditStmt(officeId, actor, "member.role", `${target.email} is now ${role}`)]);
    return null;
  }

  /** The owner hands the office to someone already in it, and stays on as an accountant. */
  async transferOwnership(officeId: string, fromUserId: string, toUserId: string, actor: string): Promise<string | null> {
    if (fromUserId === toUserId) return "You already own this office.";
    const members = await this.members(officeId);
    const to = members.find((m) => m.userId === toUserId);
    if (!to) return "That person is not in this office.";
    await this.db.batch([
      this.db.prepare("UPDATE membership SET role = 'owner' WHERE office_id = ? AND user_id = ?").bind(officeId, toUserId),
      this.db.prepare("UPDATE membership SET role = 'accountant' WHERE office_id = ? AND user_id = ?").bind(officeId, fromUserId),
      this.auditStmt(officeId, actor, "office.transferred", `to ${to.email}`),
    ]);
    return null;
  }

  async removeMember(officeId: string, userId: string, actor: string): Promise<string | null> {
    const members = await this.members(officeId);
    const target = members.find((m) => m.userId === userId);
    if (!target) return "That person is not in this office.";
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) return "The only owner cannot leave. Hand the office to someone first, or delete it.";
    await this.db.batch([
      this.db.prepare("DELETE FROM membership WHERE office_id = ? AND user_id = ?").bind(officeId, userId),
      this.db.prepare("DELETE FROM wa_code WHERE office_id = ? AND user_id = ?").bind(officeId, userId),
      this.db.prepare("UPDATE wa_link SET active_office_id = NULL WHERE user_id = ? AND active_office_id = ?").bind(userId, officeId),
      this.auditStmt(officeId, actor, actor === target.email ? "member.left" : "member.removed", target.email),
    ]);
    return null;
  }

  /* ---------- Invitations: a link with a one-time token, for one address ---------- */

  async invitations(officeId: string): Promise<Invitation[]> {
    const { results } = await this.db
      .prepare("SELECT email, role, invited_by, created_at, expires_at FROM invitation WHERE office_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
      .bind(officeId, this.now())
      .all<{ email: string; role: Role; invited_by: string; created_at: number; expires_at: number }>();
    return results.map((r) => ({ email: r.email, role: r.role, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at }));
  }

  /** A new token replaces any earlier invitation for the same address. Only its hash is kept. */
  async invite(officeId: string, email: string, role: Role, by: string): Promise<{ token: string; expiresAt: number }> {
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const at = this.now();
    const expiresAt = at + INVITE_TTL_MS;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO invitation (office_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (office_id, email) DO UPDATE SET role = excluded.role, token_hash = excluded.token_hash, invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at, accepted_at = NULL",
        )
        .bind(officeId, emailKey(email), role, await hashToken(token), by, at, expiresAt),
      this.auditStmt(officeId, by, "invitation.sent", `${emailKey(email)} as ${role}`),
    ]);
    return { token, expiresAt };
  }

  async revokeInvite(officeId: string, email: string, by: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM invitation WHERE office_id = ? AND email = ? AND accepted_at IS NULL").bind(officeId, emailKey(email)).run();
    if (r.meta.changes) await this.audit(officeId, by, "invitation.revoked", emailKey(email));
    return r.meta.changes > 0;
  }

  /** What an invitation link is for, before it is accepted: shown to the person who opened it. */
  async peekInvite(token: string): Promise<{ officeName: string; email: string; role: Role } | null> {
    const r = await this.db
      .prepare("SELECT i.email, i.role, o.name FROM invitation i JOIN office o ON o.id = i.office_id WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ? AND o.status = 'active'")
      .bind(await hashToken(token), this.now())
      .first<{ email: string; role: Role; name: string }>();
    return r ? { officeName: r.name, email: r.email, role: r.role } : null;
  }

  /** The token proves the link was received; the verified address proves it was received by the person it was sent to. */
  async acceptInvite(token: string, user: UserRef): Promise<{ officeId: string; role: Role } | { error: string }> {
    const r = await this.db
      .prepare("SELECT i.office_id, i.email, i.role, o.status FROM invitation i JOIN office o ON o.id = i.office_id WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?")
      .bind(await hashToken(token), this.now())
      .first<{ office_id: string; email: string; role: Role; status: OfficeStatus }>();
    if (!r || r.status !== "active") return { error: "This invitation has expired or was already used. Ask for a new one." };
    if (emailKey(user.email) !== r.email) return { error: `This invitation is for ${r.email}. Sign in with that address to accept it.` };
    if (!user.emailVerified) return { error: "Confirm your email address first, then open the invitation again." };
    const at = this.now();
    await this.db.batch([
      this.db.prepare("INSERT INTO membership (office_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (office_id, user_id) DO NOTHING").bind(r.office_id, user.id, r.role, at),
      this.db.prepare("UPDATE invitation SET accepted_at = ? WHERE office_id = ? AND email = ?").bind(at, r.office_id, r.email),
      this.auditStmt(r.office_id, user.email, "invitation.accepted", r.role),
    ]);
    const m = await this.membership(r.office_id, user.id);
    return { officeId: r.office_id, role: m?.role ?? r.role };
  }

  /* ---------- Routes: the only way inbound mail and webhooks find an office ---------- */

  async routeFor(kind: RouteKind | RouteKind[], externalId: string): Promise<string | null> {
    const kinds = Array.isArray(kind) ? kind : [kind];
    const r = await this.db
      .prepare(`SELECT r.office_id FROM route r JOIN office o ON o.id = r.office_id WHERE r.kind IN (${kinds.map(() => "?").join(",")}) AND r.external_id = ? AND o.status = 'active'`)
      .bind(...kinds, externalId)
      .first<{ office_id: string }>();
    return r?.office_id ?? null;
  }

  async routesOf(officeId: string, kind?: RouteKind): Promise<{ kind: RouteKind; externalId: string }[]> {
    const { results } = await (kind
      ? this.db.prepare("SELECT kind, external_id FROM route WHERE office_id = ? AND kind = ?").bind(officeId, kind)
      : this.db.prepare("SELECT kind, external_id FROM route WHERE office_id = ?").bind(officeId)
    ).all<{ kind: RouteKind; external_id: string }>();
    return results.map((r) => ({ kind: r.kind, externalId: r.external_id }));
  }

  /** Claims an inbound id for this office. Fails if another office already has it, so no one can hijack another business's page. */
  async claimRoute(officeId: string, kind: RouteKind, externalId: string): Promise<boolean> {
    await this.db.prepare("INSERT INTO route (kind, external_id, office_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, external_id) DO NOTHING").bind(kind, externalId, officeId, this.now()).run();
    const owner = await this.db.prepare("SELECT office_id FROM route WHERE kind = ? AND external_id = ?").bind(kind, externalId).first<{ office_id: string }>();
    return owner?.office_id === officeId;
  }

  async dropRoute(officeId: string, kind: RouteKind, externalId: string): Promise<void> {
    await this.db.prepare("DELETE FROM route WHERE office_id = ? AND kind = ? AND external_id = ?").bind(officeId, kind, externalId).run();
  }

  /* ---------- Audit ---------- */

  private auditStmt(officeId: string, actor: string, action: string, detail: string | null = null) {
    return this.db.prepare("INSERT INTO audit (office_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)").bind(officeId, actor, action, detail, this.now());
  }

  async audit(officeId: string, actor: string, action: string, detail: string | null = null): Promise<void> {
    await this.auditStmt(officeId, actor, action, detail).run();
  }

  async auditTrail(officeId: string, limit = 50): Promise<{ actor: string; action: string; detail: string | null; at: number }[]> {
    const { results } = await this.db.prepare("SELECT actor, action, detail, at FROM audit WHERE office_id = ? ORDER BY at DESC, id DESC LIMIT ?").bind(officeId, limit).all<{ actor: string; action: string; detail: string | null; at: number }>();
    return results;
  }
}

/** Mail to this address reaches only this office. */
export const ingestAddress = (slug: string, domain: string) => `${slug}@${domain}`.toLowerCase();
