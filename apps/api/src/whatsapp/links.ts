import type { Role, WaLanguage } from "@office/contracts";
import { newSession, type WaSession } from "@office/engine";

/** The Office's key-value table; numbers live only here, never in logs. */
export type Kv = (k: string, v?: string) => string | null;
export type Link = { phone: string; email: string; name: string; role: Role; language: "auto" | WaLanguage; digest: boolean; linkedAt: string };
type Pending = { code: string; email: string; name: string; role: Role; expiresAt: string };

export const CODE_TTL_MS = 15 * 60_000;
const del = (kv: Kv, k: string) => kv(k, "");
const read = <T>(kv: Kv, k: string): T | null => {
  const v = kv(k);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};
const emailKey = (email: string) => email.trim().toLowerCase();
/** WhatsApp gives numbers as digits with the country code; keep only the digits. */
export const normalisePhone = (p: string) => p.replace(/\D/g, "");

/** A new four-digit code for this person, replacing any they had; it works once, for 15 minutes. */
export function newJoinCode(kv: Kv, person: { email: string; name: string; role: Role }, now = Date.now(), random: () => number = Math.random): { code: string; expiresAt: string } {
  const old = read<Pending>(kv, `wa:pending:${emailKey(person.email)}`);
  if (old) del(kv, `wa:code:${old.code}`);
  let code = "";
  for (let i = 0; i < 20; i++) {
    code = String(1000 + Math.floor(random() * 9000));
    const taken = read<Pending>(kv, `wa:code:${code}`);
    if (!taken || Date.parse(taken.expiresAt) < now) break;
  }
  const pending: Pending = { code, email: emailKey(person.email), name: person.name, role: person.role, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  kv(`wa:code:${code}`, JSON.stringify(pending));
  kv(`wa:pending:${pending.email}`, JSON.stringify(pending));
  return { code, expiresAt: pending.expiresAt };
}

/** `JOIN 4821` from a phone: links that number to the person the code was made for, if it is still good. */
export function redeemJoinCode(kv: Kv, phone: string, code: string, now = Date.now()): Link | null {
  const p = read<Pending>(kv, `wa:code:${code}`);
  if (!p || Date.parse(p.expiresAt) < now) return null;
  del(kv, `wa:code:${code}`);
  del(kv, `wa:pending:${p.email}`);
  const number = normalisePhone(phone);
  const previous = linkOf(kv, p.email);
  if (previous && previous.phone !== number) del(kv, `wa:link:${previous.phone}`);
  const other = linkFor(kv, number);
  if (other && other.email !== p.email) del(kv, `wa:by-email:${other.email}`);
  const link: Link = { phone: number, email: p.email, name: p.name, role: p.role, language: previous?.language ?? "auto", digest: previous?.digest ?? false, linkedAt: new Date(now).toISOString() };
  kv(`wa:link:${number}`, JSON.stringify(link));
  kv(`wa:by-email:${p.email}`, number);
  return link;
}

export const linkFor = (kv: Kv, phone: string): Link | null => read<Link>(kv, `wa:link:${normalisePhone(phone)}`);
export function linkOf(kv: Kv, email: string): Link | null {
  const phone = kv(`wa:by-email:${emailKey(email)}`);
  return phone ? linkFor(kv, phone) : null;
}

export function updateLink(kv: Kv, email: string, change: Partial<Pick<Link, "language" | "digest">>): Link | null {
  const l = linkOf(kv, email);
  if (!l) return null;
  const next = { ...l, ...change };
  kv(`wa:link:${l.phone}`, JSON.stringify(next));
  return next;
}

export function unlink(kv: Kv, email: string): boolean {
  const l = linkOf(kv, email);
  if (!l) return false;
  del(kv, `wa:link:${l.phone}`);
  del(kv, `wa:by-email:${emailKey(email)}`);
  del(kv, `wa:session:${l.phone}`);
  return true;
}

export function sessionFor(kv: Kv, phone: string): WaSession {
  return read<WaSession>(kv, `wa:session:${normalisePhone(phone)}`) ?? newSession();
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
