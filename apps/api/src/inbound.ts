import { gmailConfirmation } from "@office/engine";
import { plainAddress } from "./assistant";
import type { InboundDocs } from "./caller";
import { domainOf, fromGoogleForwarding } from "./mail";
import { fromPlatform } from "./sales";

/**
 * What the Worker learnt of a message's sender, from the header Cloudflare puts on top.
 * `authenticated`: the `From:` address is proven. Mail without it is still read, but nothing
 * in it is posted or taken as a member's own until someone in the office looks.
 */
export type MailDocs = InboundDocs & { authenticated?: boolean };

/** Only mail from a party already in the books, and proven to be theirs, may be posted without the owner. */
export function postsAlone(parties: { contact: { email: string } }[], from: string | null, authenticated: boolean): boolean {
  const email = from?.toLowerCase();
  return Boolean(authenticated && email && parties.some((p) => p.contact.email.toLowerCase() === email));
}

/**
 * Reports at the sales address are taken from the platforms' own domains and from people in the
 * office, and only when `From:` is proven: a forged member or platform address is refused.
 */
export function salesSender(members: Set<string>, mail: { from: string | null; authenticated?: boolean }): string | null {
  const sender = plainAddress(mail.from);
  return sender && mail.authenticated && (members.has(sender) || fromPlatform(sender)) ? sender : null;
}

/**
 * Which owner a message to the assistant is from, and whether that is proven. By hand, `From:` is the
 * owner and is authenticated. By a Gmail filter, the envelope is the owner's (`anil+caf_=…@gmail.com`)
 * and their mail provider signed the message. A forwarding header is never believed: anyone can write one.
 */
export function ownerOf<T extends { email: string }>(
  owners: T[],
  mail: { from: string | null; envelope: string; authenticated?: boolean; envelopeSigned?: boolean },
): { owner: T; proven: boolean } | null {
  const from = plainAddress(mail.from);
  const envelope = plainAddress(mail.envelope);
  const byHand = owners.find((o) => o.email.toLowerCase() === from);
  if (byHand && mail.authenticated) return { owner: byHand, proven: true };
  const byFilter = owners.find((o) => o.email.toLowerCase() === envelope);
  if (byFilter && mail.envelopeSigned) return { owner: byFilter, proven: true };
  const claimed = byHand ?? byFilter;
  return claimed ? { owner: claimed, proven: false } : null;
}

/**
 * Whether the owner forwarded this by hand, so the "Forwarded message" in its text is theirs to vouch
 * for: `From:` is the owner's and proven. A forged owner `From:` that their Gmail filter passed on is not.
 */
export const forwardedByHand = (owner: { email: string }, mail: { from: string | null; authenticated?: boolean }) =>
  Boolean(mail.authenticated) && plainAddress(mail.from) === owner.email.toLowerCase();

/**
 * How much mail the office takes. Proven senders: per address and per domain in an hour, and all of
 * them together. Unproven mail shares one smaller hourly pool and its own daily bytes, apart from the
 * office's upload allowance, so forged senders can neither lock out a real one nor use up the day.
 */
export const MAIL_LIMITS = { perSenderHour: 20, perDomainHour: 60, provenHour: 200, unprovenHour: 60, unprovenBytesDay: 50 * 1024 * 1024 };
export type MailRate = { hour: string; proven: number; unproven: number; senders: Record<string, number>; domains: Record<string, number> };
export type MailRefusal = "sender" | "domain" | "office" | "unproven";

/**
 * Counts one message against this hour's limits. `proven` is the sender's address when Cloudflare
 * proved it, else null: an unproven `From:` is anyone's to write, so it is never a key of its own.
 * Mail refused for its sender or domain does not use up the wider limit. `first` is true for the
 * first refusal of its kind in the hour, so the team log says so once rather than for every message.
 */
export function countMail(state: MailRate | null, hour: string, proven: string | null): { state: MailRate; refused: MailRefusal | null; first: boolean } {
  const s: MailRate =
    state?.hour === hour && state.domains
      ? { ...state, senders: { ...state.senders }, domains: { ...state.domains } }
      : { hour, proven: 0, unproven: 0, senders: {}, domains: {} };
  if (!proven) {
    s.unproven++;
    return s.unproven > MAIL_LIMITS.unprovenHour
      ? { state: s, refused: "unproven", first: s.unproven === MAIL_LIMITS.unprovenHour + 1 }
      : { state: s, refused: null, first: false };
  }
  if (s.proven >= MAIL_LIMITS.provenHour) {
    s.proven++;
    return { state: s, refused: "office", first: s.proven === MAIL_LIMITS.provenHour + 1 };
  }
  const n = s.senders[proven] ?? 0;
  s.senders[proven] = n + 1;
  if (n >= MAIL_LIMITS.perSenderHour) return { state: s, refused: "sender", first: n === MAIL_LIMITS.perSenderHour };
  const domain = domainOf(proven) ?? proven;
  const d = s.domains[domain] ?? 0;
  s.domains[domain] = d + 1;
  if (d >= MAIL_LIMITS.perDomainHour) return { state: s, refused: "domain", first: d === MAIL_LIMITS.perDomainHour };
  s.proven++;
  return { state: s, refused: null, first: false };
}

/** The team-log line, once an hour, for mail set aside by a limit. */
export const MAIL_REFUSED: Record<MailRefusal, (sender: string) => string> = {
  sender: (who) => `Set aside mail from ${who}: more than ${MAIL_LIMITS.perSenderHour} emails in an hour. Their mail is taken again next hour.`,
  domain: (who) =>
    `Set aside mail from ${who.split("@")[1] ?? who}: more than ${MAIL_LIMITS.perDomainHour} emails from that domain in an hour. Its mail is taken again next hour.`,
  office: () => `Set aside incoming mail: the office took ${MAIL_LIMITS.provenHour} emails this hour. Mail is taken again next hour.`,
  unproven: () =>
    `Set aside mail from senders that could not be verified: more than ${MAIL_LIMITS.unprovenHour} this hour. Such mail is taken again next hour.`,
};

/** The address Cloudflare proved for a message: `From:` when authenticated, else a proven forwarding envelope. */
export const provenSender = (a: Pick<MailAdmission, "from" | "envelope" | "authenticated" | "envelopeSigned">) =>
  a.authenticated ? plainAddress(a.from) : a.envelopeSigned ? plainAddress(a.envelope) : null;

export type MailKind = "email" | "sales" | "assistant" | "support";
/** What the Worker asks the office before it stores anything of a message. */
export type MailAdmission = {
  kind: MailKind;
  from: string | null;
  envelope: string;
  subject: string;
  authenticated: boolean;
  envelopeSigned: boolean;
  bytes: number;
};

/**
 * Whether a message's sender may leave anything in the office. Bills and support mail are taken
 * from anyone (unproven bills wait on the desk). The sales address takes proven members and
 * platforms; anyone else is refused, with a line in the log. The assistant takes only mail that
 * is, or claims to be, an owner's, and Google's proven forwarding confirmations; the rest is
 * dropped quietly, as before.
 */
export function mailSenderOk(
  a: MailAdmission,
  office: { hired: (agent: string) => boolean; members: { email: string; role: string }[] },
): "admit" | "refuse" | "drop" {
  if (a.kind === "email" || a.kind === "support") return "admit";
  if (a.kind === "sales") {
    if (!office.hired("marketplace-manager")) return "drop";
    return salesSender(new Set(office.members.map((m) => m.email.toLowerCase())), a) ? "admit" : "refuse";
  }
  if (!office.hired("executive-assistant")) return "drop";
  if (fromGoogleForwarding(a) && gmailConfirmation(a.from ?? a.envelope, a.subject, "")) return "admit";
  return ownerOf(
    office.members.filter((m) => m.role === "owner"),
    a,
  )
    ? "admit"
    : "drop";
}
