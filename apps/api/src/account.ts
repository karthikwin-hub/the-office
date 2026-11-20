import { LEGAL_DOCUMENTS, type LegalDocument, type RightsRequestView } from "@office/contracts";

type RequestDb = { id: string; kind: "delete"; status: "open" | "done" | "withdrawn"; created_at: number };
const toView = (r: RequestDb): RightsRequestView => ({ id: r.id, kind: r.kind, status: r.status, createdAt: new Date(r.created_at).toISOString() });

/** Who did something, in an office's audit trail, once their account is gone. */
export const DELETED_ACCOUNT = "a deleted account";

/**
 * A person's own record, apart from any office: what they accepted, a copy of their account data,
 * and deleting their account. Requests made before deletion was self-serve are listed, can be
 * withdrawn, and are completed with the admin tool.
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

  /**
   * Deletes the account at once: its sessions, sign-ins, two-factor secret, memberships, WhatsApp link, consent
   * records and invitations, then the account itself. Refused while this person is the only owner of an office
   * that still has other people in it. An active office they are alone in is deleted with them, and purged after 30 days
   * as any deleted office is. Each office's audit trail, and a done request with no name or address, record it.
   * Their name stays where the books record what they did, as the privacy notice says.
   */
  async deleteAccount(user: { id: string; email: string }): Promise<{ error: string } | { left: string[]; closed: string[] }> {
    const { results: offices } = await this.db
      .prepare(
        "SELECT m.office_id, m.role, o.name, o.status, (SELECT COUNT(*) FROM membership x WHERE x.office_id = m.office_id AND x.role = 'owner') AS owners, (SELECT COUNT(*) FROM membership x WHERE x.office_id = m.office_id) AS people FROM membership m JOIN office o ON o.id = m.office_id WHERE m.user_id = ?",
      )
      .bind(user.id)
      .all<{ office_id: string; role: string; name: string; status: string; owners: number; people: number }>();
    const sole = offices.filter((o) => o.role === "owner" && o.owners === 1 && o.people > 1 && o.status !== "deleting");
    if (sole.length) {
      const one = sole.length === 1;
      return { error: `You are the only owner of ${sole.map((o) => o.name).join(", ")}, and others work in ${one ? "it" : "them"}. Make one of them an owner, or delete ${one ? "the office" : "those offices"}, first.` };
    }
    // A suspended office stays as it is: the platform suspended it, and only the platform decides what happens to it next.
    const closed = offices.filter((o) => o.people === 1 && o.status === "active").map((o) => o.office_id);
    const at = this.now();
    const email = user.email.toLowerCase();
    const by = (q: string, ...v: unknown[]) => this.db.prepare(q).bind(...v);
    await this.db.batch([
      ...closed.flatMap((id) => [by("UPDATE office SET status = 'deleting', deleted_at = ? WHERE id = ? AND status = 'active'", at, id), by("INSERT INTO audit (office_id, actor, action, detail, at) VALUES (?, ?, 'office.deleting', 'its only member deleted their account', ?)", id, DELETED_ACCOUNT, at)]),
      ...offices.map((o) => by("INSERT INTO audit (office_id, actor, action, detail, at) VALUES (?, ?, 'member.account-deleted', NULL, ?)", o.office_id, DELETED_ACCOUNT, at)),
      by("DELETE FROM wa_code WHERE user_id = ?", user.id),
      by("DELETE FROM wa_link WHERE user_id = ?", user.id),
      by("DELETE FROM membership WHERE user_id = ?", user.id),
      by("DELETE FROM invitation WHERE email = ?", email),
      by("UPDATE invitation SET invited_by = ? WHERE lower(invited_by) = ?", DELETED_ACCOUNT, email),
      by("UPDATE office SET created_by = NULL WHERE created_by = ?", user.id),
      by("DELETE FROM consent WHERE user_id = ?", user.id),
      by("DELETE FROM two_factor WHERE user_id = ?", user.id),
      by("DELETE FROM session WHERE user_id = ?", user.id),
      by("DELETE FROM account WHERE user_id = ?", user.id),
      by("DELETE FROM verification WHERE value = ? OR lower(identifier) = ?", user.id, email),
      by("DELETE FROM rate_limit WHERE key = ?", `step-up:${user.id}`),
      // Earlier requests lose the name and address too; one done request, with neither, is the record that it was done.
      by("UPDATE rights_request SET user_id = '', email = '', note = NULL, status = CASE WHEN status = 'open' THEN 'done' ELSE status END, done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, 'self') WHERE user_id = ?", at, user.id),
      by("INSERT INTO rights_request (id, user_id, email, kind, status, note, created_at, done_at, done_by) VALUES (?, '', '', 'delete', 'done', NULL, ?, ?, 'self')", `req_${crypto.randomUUID()}`, at, at),
      by("DELETE FROM user WHERE id = ?", user.id),
    ]);
    return { left: offices.map((o) => o.office_id), closed };
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
