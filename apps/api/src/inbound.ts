import { plainAddress } from "./assistant";
import type { InboundDocs } from "./caller";
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
export function ownerOf<T extends { email: string }>(owners: T[], mail: { from: string | null; envelope: string; authenticated?: boolean; envelopeSigned?: boolean }): { owner: T; proven: boolean } | null {
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
export const forwardedByHand = (owner: { email: string }, mail: { from: string | null; authenticated?: boolean }) => Boolean(mail.authenticated) && plainAddress(mail.from) === owner.email.toLowerCase();
