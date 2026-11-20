import type { AgendaDay, AgendaItem, AssistantDoc, CalEvent, Party } from "@office/contracts";
import { openInvoices } from "../ageing";
import { addDays, daysBetween } from "../dates";
import { inrShort } from "../money";
import type { OfficeService } from "../office";
import { istClock, istDate } from "./ics";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DAY = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Free webmail domains say nothing about which business someone is from. */
const PUBLIC_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "rediffmail.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
]);
const LEGAL_WORDS = /\b(pvt|private|ltd|limited|llp|and|co|company|corporation|corp|inc|industries|enterprises|traders|trading|the|&|m\/s)\b\.?/gi;

/** The words that name a business, without "Pvt Ltd" and the like, for finding it in a meeting title. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_WORDS, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The customer or supplier a meeting is with: by an attendee's address, their company's domain, or the name in the title. */
export function partyForEvent(office: OfficeService, ev: Pick<CalEvent, "title" | "attendees">, ownerEmail?: string): Party | null {
  const parties = office.books.parties;
  const own = new Set([ownerEmail?.toLowerCase(), office.books.business.email?.toLowerCase()].filter(Boolean));
  const ownDomain = office.books.business.email?.split("@")[1]?.toLowerCase();
  for (const a of ev.attendees) {
    if (own.has(a.email)) continue;
    const exact = parties.find((p) => p.contact.email && p.contact.email.toLowerCase() === a.email);
    if (exact) return exact;
  }
  for (const a of ev.attendees) {
    const domain = a.email.split("@")[1];
    if (!domain || PUBLIC_MAIL.has(domain) || domain === ownDomain) continue;
    const byDomain = parties.find((p) => p.contact.email?.toLowerCase().endsWith(`@${domain}`));
    if (byDomain) return byDomain;
  }
  const title = ` ${nameKey(ev.title)} `;
  let best: Party | null = null;
  for (const p of parties) {
    const key = nameKey(p.name);
    if (key.length < 4) continue;
    if (title.includes(` ${key} `) && (!best || key.length > nameKey(best.name).length)) best = p;
  }
  return best;
}

/** What the books say about a customer or supplier, in a few lines for before the meeting. */
export function partyBrief(office: OfficeService, party: Party): string[] {
  const l = office.ledger;
  const lines: string[] = [];
  if (party.kind === "customer") {
    const open = openInvoices(l).filter((o) => o.partyId === party.id);
    const owed = open.reduce((s, o) => s + o.outstandingPaise, 0);
    const late = open.filter((o) => o.daysOverdue > 0);
    if (owed > 0) {
      const lateSum = late.reduce((s, o) => s + o.outstandingPaise, 0);
      lines.push(
        late.length
          ? `Owes you ${inrShort(owed)}; ${inrShort(lateSum)} of it is overdue, the oldest by ${plural(late[0]!.daysOverdue, "day")} (${late[0]!.number}).`
          : `Owes you ${inrShort(owed)}, none of it overdue yet.`,
      );
    } else lines.push("Owes you nothing today.");
    const last = l.receivableInvoices.filter((i) => i.partyId === party.id).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (last) lines.push(`Last invoice ${last.number} on ${DAY(last.date)}, for ${inrShort(last.totals.totalPaise)}.`);
    const quotes = office.books.quotes.filter((q) => q.partyId === party.id && q.status === "sent" && q.validUntil >= office.asOf);
    if (quotes.length)
      lines.push(`${plural(quotes.length, "open quotation")}: ${quotes.map((q) => `${q.number} for ${inrShort(q.totals.totalPaise)}`).join(", ")}.`);
    if (party.creditLimitPaise && owed > party.creditLimitPaise) lines.push(`Over their credit limit of ${inrShort(party.creditLimitPaise)}.`);
  } else {
    const unpaid = l.payableBills.filter((b) => b.partyId === party.id && !l.vendorBillPaid(b.id));
    const due = unpaid.reduce((s, b) => s + b.totals.totalPaise, 0);
    lines.push(due > 0 ? `You owe them ${inrShort(due)} on ${plural(unpaid.length, "bill")}.` : "You owe them nothing today.");
    const last = l.payableBills.filter((b) => b.partyId === party.id).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (last) lines.push(`Last bill ${last.number} on ${DAY(last.date)}, for ${inrShort(last.totals.totalPaise)}.`);
  }
  return lines;
}

type Busy = { from: number; to: number };
const WORK_FROM = "09:30";
const WORK_TO = "18:30";
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}:00+05:30`);

/** The first stretch of 45 minutes or more without a meeting in the working day, after `notBefore`. */
function freeSlot(day: string, busy: Busy[], notBefore: number): { from: number; to: number } | null {
  let cursor = Math.max(at(day, WORK_FROM), notBefore);
  const end = at(day, WORK_TO);
  const sorted = busy.filter((b) => b.to > cursor && b.from < end).sort((a, b) => a.from - b.from);
  for (const b of sorted) {
    if (b.from - cursor >= 45 * 60_000) return { from: cursor, to: b.from };
    cursor = Math.max(cursor, b.to);
  }
  return end - cursor >= 45 * 60_000 ? { from: cursor, to: Math.min(end, cursor + 90 * 60_000) } : null;
}

const round15 = (ms: number) => Math.ceil(ms / (15 * 60_000)) * 15 * 60_000;

/**
 * Today, tomorrow and the day after, from the owner's calendar, their tasks and what the office
 * needs from them. Office items only appear on the day they are due, and late ones today.
 */
export function buildAgenda(office: OfficeService, doc: AssistantDoc, owner: string, opts: { drafts: number; now?: number } = { drafts: 0 }): AgendaDay[] {
  const today = office.asOf;
  const now = opts.now ?? Date.now();
  const realToday = istDate(now) === today;
  const events = doc.calendar?.events ?? [];
  const deskItems = office.pending();
  const due = office.hired("compliance-officer") ? office.complianceDue(2) : [];
  const handoffs = office.hired("customer-service") ? office.books.staged.filter((s) => s.kind === "handoff" && s.status === "pending").length : 0;

  return [0, 1, 2].map((offset) => {
    const date = addDays(today, offset);
    const label = offset === 0 ? `Today, ${DAY(date)}` : offset === 1 ? `Tomorrow, ${DAY(date)}` : DAY(date);
    const items: AgendaItem[] = [];
    const busy: Busy[] = [];

    for (const ev of events) {
      const s = Date.parse(ev.start);
      const e = Date.parse(ev.end);
      const dayStart = at(date, "00:00");
      const dayEnd = dayStart + 86_400_000;
      if (!(s < dayEnd && Math.max(e, s + 1) > dayStart)) continue;
      const party = partyForEvent(office, ev, owner);
      const brief = party ? partyBrief(office, party) : undefined;
      const others = ev.attendees.filter((a) => a.email !== owner.toLowerCase());
      const detail =
        [
          ev.location,
          others.length
            ? `With ${others
                .slice(0, 3)
                .map((a) => a.name ?? a.email)
                .join(", ")}${others.length > 3 ? ` and ${others.length - 3} more` : ""}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || null;
      if (!ev.allDay) busy.push({ from: s, to: e });
      items.push({
        kind: "event",
        at: ev.allDay ? null : s < dayStart ? "00:00" : istClock(ev.start),
        until: ev.allDay ? null : e >= dayEnd ? null : istClock(ev.end),
        title: ev.title,
        detail,
        ...(brief ? { brief: [`${party!.name}:`, ...brief] } : {}),
        link: party ? `/parties/${encodeURIComponent(party.id)}` : null,
      });
    }

    for (const t of doc.tasks) {
      if (t.status !== "open" || (t.snoozedUntil && t.snoozedUntil > date)) continue;
      const lateToday = offset === 0 && t.due && t.due < today;
      if (t.due === date || lateToday || (offset === 0 && !t.due)) {
        items.push({
          kind: "task",
          at: null,
          until: null,
          title: t.title,
          detail: lateToday ? `Was due ${DAY(t.due!)}` : t.due ? null : "No date set",
          link: null,
          taskId: t.id,
        });
      }
    }

    if (offset === 0) {
      if (deskItems.length || opts.drafts) {
        const oldest = deskItems.length ? deskItems[deskItems.length - 1]! : null;
        const age = oldest ? daysBetween(oldest.createdAt.slice(0, 10), today) : 0;
        const parts = [
          deskItems.length ? plural(deskItems.length, "item") : "",
          opts.drafts ? plural(opts.drafts, "reply", "replies") + " I drafted" : "",
        ].filter(Boolean);
        items.push({
          kind: "office",
          at: null,
          until: null,
          title: `${parts.join(" and ")} waiting on your desk`,
          detail: age > 1 ? `The oldest has waited ${plural(age, "day")}.` : null,
          link: "/desk",
        });
      }
      if (handoffs)
        items.push({
          kind: "office",
          at: null,
          until: null,
          title: `${plural(handoffs, "customer")} waiting for your answer`,
          detail: null,
          link: "/rooms/customer-service",
        });
    }
    for (const o of due) {
      const onThisDay = o.dueOn === date || (offset === 0 && o.dueOn < today);
      if (onThisDay)
        items.push({
          kind: "office",
          at: null,
          until: null,
          title: o.dueOn < today ? `Late: ${o.title}` : `Due: ${o.title}`,
          detail: o.line,
          link: "/rooms/compliance-officer",
        });
    }

    const work = (offset === 0 ? deskItems.length + opts.drafts : 0) + items.filter((i) => i.kind === "task").length;
    if (work > 0) {
      const slot = freeSlot(date, busy, offset === 0 && realToday ? round15(now) : 0);
      if (slot) {
        const minutes = Math.max(
          10,
          Math.min(60, Math.round(((offset === 0 ? deskItems.length + opts.drafts : 0) * 1.5 + items.filter((i) => i.kind === "task").length * 10) / 5) * 5),
        );
        items.push({
          kind: "focus",
          at: istClock(new Date(slot.from).toISOString()),
          until: istClock(new Date(slot.to).toISOString()),
          title: "Free time",
          detail: `A good moment for your desk and tasks, about ${minutes} minutes.`,
          link: null,
        });
      }
    }

    const order = { office: 0, task: 1, event: 2, focus: 2 } as const;
    items.sort((a, b) =>
      (a.at === null) !== (b.at === null) ? (a.at === null ? -1 : 1) : a.at && b.at && a.at !== b.at ? (a.at < b.at ? -1 : 1) : order[a.kind] - order[b.kind],
    );
    return { date, label, items };
  });
}

/** The agenda as text for the morning email, or as a few lines for WhatsApp. */
export function agendaText(days: AgendaDay[], short = false): string {
  const line = (i: AgendaItem) => `${i.at ? `${i.at}${i.until ? `–${i.until}` : ""} ` : ""}${i.kind === "task" ? "To do: " : ""}${i.title}`;
  if (short) {
    const [today, ...rest] = days;
    const out = [
      `${today!.label}:`,
      ...today!.items
        .filter((i) => i.kind !== "focus")
        .slice(0, 6)
        .map((i) => `• ${line(i)}`),
    ];
    if (!today!.items.length) out.push("• Nothing in your calendar.");
    for (const d of rest) {
      const meets = d.items.filter((i) => i.kind === "event").length;
      const other = d.items.length - meets;
      out.push(
        `${d.label}: ${meets || other ? [meets ? plural(meets, "meeting") : "", other ? plural(other, "other item") : ""].filter(Boolean).join(", ") : "clear"}.`,
      );
    }
    return out.join("\n");
  }
  return days
    .map((d, n) => {
      const items = n === 0 ? d.items : d.items.filter((i) => i.kind !== "focus");
      const body = items.length
        ? items
            .map((i) =>
              [`  • ${line(i)}`, i.detail && n === 0 ? `    ${i.detail}` : "", ...(n === 0 && i.brief ? i.brief.map((b) => `    ${b}`) : [])]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n")
        : "  • Nothing planned.";
      return `${d.label}\n${body}`;
    })
    .join("\n\n");
}
