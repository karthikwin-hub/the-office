import { LEGAL_DOCUMENTS, type LegalDocument, type RightsRequestView } from "@office/contracts";

type RequestDb = { id: string; kind: "delete"; status: "open" | "done" | "withdrawn"; created_at: number };
const toView = (r: RequestDb): RightsRequestView => ({ id: r.id, kind: r.kind, status: r.status, createdAt: new Date(r.created_at).toISOString() });

/**
 * A person's own record, apart from any office: what they accepted, a copy of their account data,
 * and their request to be deleted. The admin tool completes deletions; nothing here deletes an account.
 */
export class AccountRecords {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** The documents whose current version this person has not accepted yet. */
  async consentNeeded(userId: string): Promise<{ document: LegalDocument; version: string }[]> {
    const { results } = await this.db.prepare("SELECT document, version FROM consent WHERE user_id = ?").bind(userId).all<{ document: string; version: string }>();
    const have = new Set(results.map((r) => `${r.document}|${r.version}`));
    return (Object.keys(LEGAL_DOCUMENTS) as LegalDocument[]).filter((d) => !have.has(`${d}|${LEGAL_DOCUMENTS[d].version}`)).map((d) => ({ document: d, version: LEGAL_DOCUMENTS[d].version }));
  }

  /** Only the current version of a document can be accepted, so nobody records agreeing to a text they were not shown. */
  async accept(userId: string, documents: { document: LegalDocument; version: string }[], country: string | null): Promise<string | null> {
    const stale = documents.find((d) => LEGAL_DOCUMENTS[d.document].version !== d.version);
    if (stale) return `The ${LEGAL_DOCUMENTS[stale.document].title.toLowerCase()} has changed. Reload the page to read the new version.`;
    await this.db.batch(documents.map((d) => this.db.prepare("INSERT INTO consent (user_id, document, version, accepted_at, country) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(userId, d.document, d.version, this.now(), country)));
    return null;
  }

  async requests(userId: string): Promise<RightsRequestView[]> {
    const { results } = await this.db.prepare("SELECT id, kind, status, created_at FROM rights_request WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(userId).all<RequestDb>();
    return results.map(toView);
  }

  async deletionRequested(userId: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS x FROM rights_request WHERE user_id = ? AND kind = 'delete' AND status = 'open'").bind(userId).first());
  }

  /** Recorded, and in the audit of every office they are in. The only owner of an office must hand it over or delete it first. */
  async requestDeletion(user: { id: string; email: string }, note: string | null): Promise<RightsRequestView | { error: string }> {
    const sole = await this.db
      .prepare(
        "SELECT o.name FROM membership m JOIN office o ON o.id = m.office_id WHERE m.user_id = ? AND m.role = 'owner' AND o.status != 'deleting' AND (SELECT COUNT(*) FROM membership x WHERE x.office_id = m.office_id AND x.role = 'owner') = 1",
      )
      .bind(user.id)
      .all<{ name: string }>();
    if (sole.results.length) return { error: `You are the only owner of ${sole.results.map((r) => r.name).join(", ")}. Hand ${sole.results.length === 1 ? "it" : "them"} to another owner, or delete ${sole.results.length === 1 ? "it" : "them"}, first.` };
    const open = await this.db.prepare("SELECT id, kind, status, created_at FROM rights_request WHERE user_id = ? AND kind = 'delete' AND status = 'open'").bind(user.id).first<RequestDb>();
    if (open) return toView(open);
    const id = `req_${crypto.randomUUID()}`;
    const at = this.now();
    const offices = await this.db.prepare("SELECT office_id FROM membership WHERE user_id = ?").bind(user.id).all<{ office_id: string }>();
    await this.db.batch([
      this.db.prepare("INSERT INTO rights_request (id, user_id, email, kind, status, note, created_at) VALUES (?, ?, ?, 'delete', 'open', ?, ?)").bind(id, user.id, user.email.toLowerCase(), note, at),
      ...offices.results.map((o) => this.db.prepare("INSERT INTO audit (office_id, actor, action, detail, at) VALUES (?, ?, 'member.deletion-requested', NULL, ?)").bind(o.office_id, user.email, at)),
    ]);
    return { id, kind: "delete", status: "open", createdAt: new Date(at).toISOString() };
  }

  async withdraw(userId: string, id: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE rights_request SET status = 'withdrawn', done_at = ?, done_by = 'self' WHERE id = ? AND user_id = ? AND status = 'open'").bind(this.now(), id, userId).run();
    return r.meta.changes > 0;
  }

  /** Everything the control plane holds about this person. Passwords and tokens are never included, not even as hashes. */
  async exportFor(userId: string) {
    const one = <T>(q: string) => this.db.prepare(q).bind(userId).first<T>();
    const all = async <T>(q: string) => (await this.db.prepare(q).bind(userId).all<T>()).results;
    const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
    const user = await one<{ id: string; name: string; email: string; email_verified: number; created_at: number }>("SELECT id, name, email, email_verified, created_at FROM user WHERE id = ?");
    if (!user) return null;
    const sessions = await all<{ created_at: number; expires_at: number; ip_address: string | null; user_agent: string | null }>("SELECT created_at, expires_at, ip_address, user_agent FROM session WHERE user_id = ? ORDER BY created_at DESC");
    const logins = await all<{ provider_id: string; created_at: number }>("SELECT provider_id, created_at FROM account WHERE user_id = ?");
    const offices = await all<{ id: string; name: string; role: string; created_at: number }>("SELECT o.id, o.name, m.role, m.created_at FROM membership m JOIN office o ON o.id = m.office_id WHERE m.user_id = ?");
    const wa = await one<{ phone: string; language: string; digest: number; linked_at: number }>("SELECT phone, language, digest, linked_at FROM wa_link WHERE user_id = ?");
    const consent = await all<{ document: string; version: string; accepted_at: number; country: string | null }>("SELECT document, version, accepted_at, country FROM consent WHERE user_id = ? ORDER BY accepted_at");
    const invitations = (await this.db.prepare("SELECT o.name AS office, i.role, i.created_at, i.accepted_at FROM invitation i JOIN office o ON o.id = i.office_id WHERE i.email = ?").bind(user.email.toLowerCase()).all<{ office: string; role: string; created_at: number; accepted_at: number | null }>()).results;
    return {
      exportedAt: new Date(this.now()).toISOString(),
      account: { id: user.id, name: user.name, email: user.email, emailVerified: Boolean(user.email_verified), createdAt: iso(user.created_at) },
      signIns: logins.map((l) => ({ method: l.provider_id === "credential" ? "email and password" : l.provider_id, since: iso(l.created_at) })),
      sessions: sessions.map((s) => ({ startedAt: iso(s.created_at), expiresAt: iso(s.expires_at), ipAddress: s.ip_address, browser: s.user_agent })),
      offices: offices.map((o) => ({ id: o.id, name: o.name, role: o.role, since: iso(o.created_at) })),
      invitations: invitations.map((i) => ({ office: i.office, role: i.role, sentAt: iso(i.created_at), acceptedAt: iso(i.accepted_at) })),
      whatsapp: wa ? { phone: wa.phone, language: wa.language, digest: Boolean(wa.digest), linkedAt: iso(wa.linked_at) } : null,
      consent: consent.map((c) => ({ document: c.document, version: c.version, acceptedAt: iso(c.accepted_at), country: c.country })),
      requests: await this.requests(userId),
      note: "This is your account. The books of each office belong to its business; an owner can export them from Settings.",
    };
  }
}
