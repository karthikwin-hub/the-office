import type { Role, WaLanguage } from "@office/contracts";
import { newSession, type WaSession } from "@office/engine";

/** The Office's key-value table; numbers live only here and in D1, never in logs. */
export type Kv = (k: string, v?: string) => string | null;
/** One person's phone, linked once for every office they belong to; replies go to the office they last chose. */
export type Link = { phone: string; userId: string; email: string; name: string; activeOfficeId: string | null; language: "auto" | WaLanguage; digest: boolean; linkedAt: number };
/** The person behind a message, as the office they are talking to sees them. */
export type WaPerson = { phone: string; userId: string; name: string; email: string; role: Role; language: "auto" | WaLanguage; digest: boolean };

export const CODE_TTL_MS = 15 * 60_000;
/** Wrong codes from one number before it has to wait. Six digits and five tries an hour make guessing hopeless. */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 3600_000;

/** WhatsApp gives numbers as digits with the country code; keep only the digits. */
export const normalisePhone = (p: string) => p.replace(/\D/g, "");

type LinkDb = { phone: string; user_id: string; email: string; name: string; active_office_id: string | null; language: string; digest: number; linked_at: number };
const toLink = (r: LinkDb): Link => ({ phone: r.phone, userId: r.user_id, email: r.email, name: r.name, activeOfficeId: r.active_office_id, language: r.language as Link["language"], digest: Boolean(r.digest), linkedAt: r.linked_at });
const LINK_SELECT = "SELECT l.phone, l.user_id, u.email, u.name, l.active_office_id, l.language, l.digest, l.linked_at FROM wa_link l JOIN `user` u ON u.id = l.user_id";

/**
 * Who is on WhatsApp, across every office on the shared number. A phone belongs to one
 * person; a JOIN code belongs to one person in one office and works once.
 */
export class WaDirectory {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new six-digit code for this person in this office, replacing any they had. */
  async newJoinCode(officeId: string, userId: string, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): Promise<{ code: string; expiresAt: string }> {
    const at = this.now();
    const expiresAt = at + CODE_TTL_MS;
    await this.db.prepare("DELETE FROM wa_code WHERE user_id = ? OR expires_at < ?").bind(userId, at).run();
    for (let i = 0; i < 20; i++) {
      const code = String(100000 + Math.floor(random() * 900000));
      const r = await this.db.prepare("INSERT INTO wa_code (code, office_id, user_id, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING").bind(code, officeId, userId, expiresAt).run();
      if (r.meta.changes) return { code, expiresAt: new Date(expiresAt).toISOString() };
    }
    throw new Error("Could not make a code");
  }

  /**
   * `JOIN 482193` from a phone links that number to the person the code was made for, in that office.
   * `onlyOffice` is for an office's own number, which may only redeem its own codes.
   */
  async redeem(phone: string, code: string, onlyOffice?: string): Promise<{ link: Link; officeId: string } | { error: "badCode" | "tooMany" }> {
    const number = normalisePhone(phone);
    const at = this.now();
    const tries = await this.db.prepare("SELECT failures, window_start FROM wa_attempt WHERE phone = ?").bind(number).first<{ failures: number; window_start: number }>();
    const fresh = !tries || at - tries.window_start > FAILURE_WINDOW_MS;
    if (!fresh && tries.failures >= MAX_FAILURES) return { error: "tooMany" };
    const c = await this.db.prepare("SELECT office_id, user_id FROM wa_code WHERE code = ? AND expires_at > ?").bind(code, at).first<{ office_id: string; user_id: string }>();
    const member = c && (!onlyOffice || c.office_id === onlyOffice) ? await this.db.prepare("SELECT 1 FROM membership WHERE office_id = ? AND user_id = ?").bind(c.office_id, c.user_id).first() : null;
    if (!c || !member) {
      await this.db
        .prepare("INSERT INTO wa_attempt (phone, failures, window_start) VALUES (?, 1, ?) ON CONFLICT (phone) DO UPDATE SET failures = CASE WHEN ? THEN 1 ELSE failures + 1 END, window_start = CASE WHEN ? THEN ? ELSE window_start END")
        .bind(number, at, fresh ? 1 : 0, fresh ? 1 : 0, at)
        .run();
      return { error: "badCode" };
    }
    const previous = await this.linkOfUser(c.user_id);
    await this.db.batch([
      this.db.prepare("DELETE FROM wa_code WHERE code = ?").bind(code),
      this.db.prepare("DELETE FROM wa_attempt WHERE phone = ?").bind(number),
      // One phone per person and one person per phone: a new link replaces either old one.
      this.db.prepare("DELETE FROM wa_link WHERE (user_id = ? AND phone != ?) OR (phone = ? AND user_id != ?)").bind(c.user_id, number, number, c.user_id),
      this.db
        .prepare(
          "INSERT INTO wa_link (phone, user_id, active_office_id, language, digest, linked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (phone) DO UPDATE SET active_office_id = excluded.active_office_id, linked_at = excluded.linked_at",
        )
        .bind(number, c.user_id, c.office_id, previous?.language ?? "auto", previous?.digest ? 1 : 0, at),
    ]);
    return { link: (await this.linkByPhone(number))!, officeId: c.office_id };
  }

  async linkByPhone(phone: string): Promise<Link | null> {
    const r = await this.db.prepare(`${LINK_SELECT} WHERE l.phone = ?`).bind(normalisePhone(phone)).first<LinkDb>();
    return r ? toLink(r) : null;
  }

  async linkOfUser(userId: string): Promise<Link | null> {
    const r = await this.db.prepare(`${LINK_SELECT} WHERE l.user_id = ?`).bind(userId).first<LinkDb>();
    return r ? toLink(r) : null;
  }

  /** The linked phones of people in this office, for its morning digest. */
  async linksIn(officeId: string): Promise<(Link & { role: Role })[]> {
    const { results } = await this.db.prepare(`${LINK_SELECT.replace("SELECT ", "SELECT m.role, ")} JOIN membership m ON m.user_id = l.user_id WHERE m.office_id = ?`).bind(officeId).all<LinkDb & { role: Role }>();
    return results.map((r) => ({ ...toLink(r), role: r.role }));
  }

  /** This phone's person, as a member of this office; null if they are not in it. */
  async personIn(officeId: string, phone: string): Promise<WaPerson | null> {
    const l = await this.linkByPhone(phone);
    if (!l) return null;
    const m = await this.db.prepare("SELECT role FROM membership WHERE office_id = ? AND user_id = ?").bind(officeId, l.userId).first<{ role: Role }>();
    return m ? { phone: l.phone, userId: l.userId, name: l.name, email: l.email, role: m.role, language: l.language, digest: l.digest } : null;
  }

  async update(userId: string, change: Partial<Pick<Link, "language" | "digest">>): Promise<Link | null> {
    const l = await this.linkOfUser(userId);
    if (!l) return null;
    const next = { ...l, ...change };
    await this.db.prepare("UPDATE wa_link SET language = ?, digest = ? WHERE phone = ?").bind(next.language, next.digest ? 1 : 0, l.phone).run();
    return next;
  }

  async setActive(phone: string, officeId: string): Promise<void> {
    await this.db.prepare("UPDATE wa_link SET active_office_id = ? WHERE phone = ?").bind(officeId, normalisePhone(phone)).run();
  }

  /** A phone linked before offices shared one number: kept for the same person if they are still in that office. */
  async importLegacy(officeId: string, old: { phone: string; email: string; language: Link["language"]; digest: boolean; linkedAt: string }): Promise<boolean> {
    const u = await this.db.prepare("SELECT u.id FROM `user` u JOIN membership m ON m.user_id = u.id WHERE lower(u.email) = ? AND m.office_id = ?").bind(old.email.trim().toLowerCase(), officeId).first<{ id: string }>();
    if (!u) return false;
    const r = await this.db
      .prepare("INSERT INTO wa_link (phone, user_id, active_office_id, language, digest, linked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(normalisePhone(old.phone), u.id, officeId, old.language, old.digest ? 1 : 0, Date.parse(old.linkedAt) || this.now())
      .run();
    return r.meta.changes > 0;
  }

  async unlink(userId: string): Promise<Link | null> {
    const l = await this.linkOfUser(userId);
    if (l) await this.db.batch([this.db.prepare("DELETE FROM wa_link WHERE user_id = ?").bind(userId), this.db.prepare("DELETE FROM wa_code WHERE user_id = ?").bind(userId)]);
    return l;
  }
}

/** Each office remembers its own numbered list and the messages it has seen for each phone. */
export function sessionFor(kv: Kv, phone: string): WaSession {
  const v = kv(`wa:session:${normalisePhone(phone)}`);
  if (!v) return newSession();
  try {
    return JSON.parse(v) as WaSession;
  } catch {
    return newSession();
  }
}
export const saveSession = (kv: Kv, phone: string, s: WaSession) => void kv(`wa:session:${normalisePhone(phone)}`, JSON.stringify(s));

/** Enough of the number for its owner to recognise it: "+91 ••••• ••480". */
export function maskPhone(phone: string): string {
  const d = normalisePhone(phone);
  if (d.length < 6) return "•••";
  const country = d.length > 10 ? d.slice(0, d.length - 10) : "";
  const tail = d.slice(-3);
  return `${country ? `+${country} ` : ""}••••• ••${tail}`;
}
