import type { AgeingReport, AgeingRow, OpenInvoice, StagedChange } from "@office/contracts";
import { addDays, dateLabel, daysBetween } from "./dates";
import type { Ledger } from "./ledger";
import { inr, inrShort } from "./money";

export function bucketOf(daysOverdue: number): number {
  if (daysOverdue <= 0) return 0;
  if (daysOverdue <= 30) return 1;
  if (daysOverdue <= 60) return 2;
  if (daysOverdue <= 90) return 3;
  return 4;
}

export function openInvoices(l: Ledger): OpenInvoice[] {
  const out: OpenInvoice[] = [];
  for (const inv of l.receivableInvoices) {
    const outstanding = l.outstanding(inv.id);
    if (outstanding <= 0) continue;
    const daysOverdue = daysBetween(inv.dueDate, l.asOf);
    out.push({
      invoiceId: inv.id,
      number: inv.number,
      partyId: inv.partyId,
      partyName: l.party(inv.partyId).name,
      date: inv.date,
      dueDate: inv.dueDate,
      daysOverdue,
      totalPaise: inv.totals.totalPaise,
      outstandingPaise: outstanding,
      bucket: bucketOf(daysOverdue),
      docId: inv.docId,
    });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/** Average days paid after the due date, weighted by amount, over fully settled invoices. */
export function paymentBehaviour(l: Ledger, partyId: string): { avgDaysLate: number | null; lastPaymentOn: string | null } {
  let weighted = 0;
  let total = 0;
  let last: string | null = null;
  for (const inv of l.receivableInvoices) {
    if (inv.partyId !== partyId) continue;
    const s = l.settled(inv.id);
    if (s.lastOn && (!last || s.lastOn > last)) last = s.lastOn;
    if (l.outstanding(inv.id) > 0 || !s.lastOn) continue;
    weighted += daysBetween(inv.dueDate, s.lastOn) * inv.totals.totalPaise;
    total += inv.totals.totalPaise;
  }
  return { avgDaysLate: total ? Math.round(weighted / total) : null, lastPaymentOn: last };
}

export function ageingReport(l: Ledger): AgeingReport {
  const open = openInvoices(l);
  const byParty = new Map<string, OpenInvoice[]>();
  for (const o of open) byParty.set(o.partyId, [...(byParty.get(o.partyId) ?? []), o]);
  const rows: AgeingRow[] = [];
  for (const [partyId, list] of byParty) {
    const party = l.party(partyId);
    const buckets = [0, 0, 0, 0, 0];
    for (const o of list) buckets[o.bucket]! += o.outstandingPaise;
    const behaviour = paymentBehaviour(l, partyId);
    rows.push({
      partyId,
      name: party.name,
      city: party.city,
      termsDays: party.paymentTermsDays ?? 30,
      buckets,
      totalPaise: buckets.reduce((a, b) => a + b, 0),
      oldestDaysOverdue: Math.max(...list.map((o) => o.daysOverdue)),
      openInvoices: list.length,
      avgDaysLate: behaviour.avgDaysLate,
      lastPaymentOn: behaviour.lastPaymentOn,
      figureId: `ageing:party:${partyId}`,
    });
  }
  rows.sort((a, b) => b.buckets.slice(1).reduce((x, y) => x + y, 0) - a.buckets.slice(1).reduce((x, y) => x + y, 0) || b.totalPaise - a.totalPaise);
  const bucketTotals = [0, 1, 2, 3, 4].map((i) => rows.reduce((acc, r) => acc + r.buckets[i]!, 0));
  const totalPaise = bucketTotals.reduce((a, b) => a + b, 0);
  const overdue = totalPaise - bucketTotals[0]!;
  const over60 = bucketTotals[3]! + bucketTotals[4]!;
  const overdueCustomers = rows.filter((r) => r.buckets.slice(1).some((b) => b > 0)).length;
  const worst = rows[0];
  return {
    asOf: l.asOf,
    note: [
      { text: "Customers owe " },
      { text: inrShort(totalPaise), figureId: "ageing:total" },
      { text: ` across ${open.length} invoices. ` },
      { text: inrShort(overdue), figureId: "ageing:overdue", tone: "red" },
      { text: ` is past its due date, with ${overdueCustomers} customers late. ` },
      { text: inrShort(over60), figureId: "ageing:over60", tone: "red" },
      { text: " is more than 60 days overdue" },
      ...(worst
        ? [{ text: `; the largest overdue balance is ${worst.name}'s at ` }, { text: inrShort(worst.buckets.slice(1).reduce((a, b) => a + b, 0)), figureId: worst.figureId }, { text: "." }]
        : [{ text: "." }]),
    ],
    bucketTotals,
    bucketFigureIds: [0, 1, 2, 3, 4].map((i) => `ageing:bucket:${i}`),
    totalPaise,
    rows,
    open,
  };
}

export type ReminderPolicy = { firstAfterDays: number; firmAfterDays: number; finalAfterDays: number; minimumPaise: number };
export const DEFAULT_POLICY: ReminderPolicy = { firstAfterDays: 1, firmAfterDays: 16, finalAfterDays: 46, minimumPaise: 10_000_00 };

export type Tone = "polite" | "firm" | "final";

export function toneFor(daysOverdue: number, policy: ReminderPolicy = DEFAULT_POLICY): Tone | null {
  if (daysOverdue >= policy.finalAfterDays) return "final";
  if (daysOverdue >= policy.firmAfterDays) return "firm";
  if (daysOverdue >= policy.firstAfterDays) return "polite";
  return null;
}

export function reminderLetter(l: Ledger, partyId: string, overdue: OpenInvoice[], tone: Tone): { subject: string; body: string } {
  const party = l.party(partyId);
  const biz = l.books.business;
  const total = overdue.reduce((a, o) => a + o.outstandingPaise, 0);
  const list = overdue.map((o) => `  ${o.number} dated ${dateLabel(o.date)}, due ${dateLabel(o.dueDate)}: Rs. ${inr(o.outstandingPaise)}`).join("\n");
  const greeting = `Dear ${party.contact.name},`;
  const sign = `\n\nRegards,\nAccounts, ${biz.legalName}\n${biz.phone}`;
  const bank = `\n\nBank details: ${biz.bank}.`;
  if (tone === "polite")
    return {
      subject: `Payment reminder: ${overdue.length === 1 ? overdue[0]!.number : `${overdue.length} invoices`} from ${biz.name}`,
      body: `${greeting}\n\nA gentle reminder that the following ${overdue.length === 1 ? "invoice is" : "invoices are"} now past due:\n\n${list}\n\nTotal due: Rs. ${inr(total)}.${bank} If you have already paid, please share the UTR so we can match it.${sign}`,
    };
  if (tone === "firm")
    return {
      subject: `Overdue: Rs. ${inr(total, { rupees: true })} from ${biz.name}`,
      body: `${greeting}\n\nOur records show the following ${overdue.length === 1 ? "invoice remains" : "invoices remain"} unpaid beyond the agreed ${party.paymentTermsDays}-day terms:\n\n${list}\n\nTotal overdue: Rs. ${inr(total)}. Please arrange payment by ${dateLabel(addDays(l.asOf, 7))}, or call us to agree a date.${bank}${sign}`,
    };
  return {
    subject: `Final reminder before credit hold: Rs. ${inr(total, { rupees: true })}`,
    body: `${greeting}\n\nDespite earlier reminders, the following ${overdue.length === 1 ? "invoice is" : "invoices are"} still unpaid:\n\n${list}\n\nTotal overdue: Rs. ${inr(total)}. Unless we receive payment or a confirmed payment date by ${dateLabel(addDays(l.asOf, 5))}, we will have to place further orders on hold. Interest at 18% per annum applies to late payments as stated on our invoices.${bank}${sign}`,
  };
}

/** The Credit Controller's drafts: one reminder per customer with overdue invoices. */
export function draftReminders(l: Ledger, policy: ReminderPolicy = DEFAULT_POLICY): StagedChange[] {
  const byParty = new Map<string, OpenInvoice[]>();
  for (const o of openInvoices(l)) if (o.daysOverdue >= policy.firstAfterDays) byParty.set(o.partyId, [...(byParty.get(o.partyId) ?? []), o]);
  const drafts: StagedChange[] = [];
  for (const [partyId, overdue] of byParty) {
    const total = overdue.reduce((a, o) => a + o.outstandingPaise, 0);
    if (total < policy.minimumPaise) continue;
    const oldest = Math.max(...overdue.map((o) => o.daysOverdue));
    const tone = toneFor(oldest, policy)!;
    const party = l.party(partyId);
    const letter = reminderLetter(l, partyId, overdue, tone);
    drafts.push({
      id: `rem-${partyId}-${l.asOf}`,
      agentId: "credit-controller",
      kind: "reminder",
      createdAt: `${l.asOf}T10:30:00+05:30`,
      title: `Send ${tone === "polite" ? "a reminder" : tone === "firm" ? "a firm reminder" : "a final reminder"} to ${party.name} for ${overdue.length === 1 ? overdue[0]!.number : `${overdue.length} invoices`}, ${inrShort(total)}, oldest ${oldest} days overdue`,
      summary: `By email to ${party.contact.email}. ${tone === "final" ? "Mentions a credit hold if not paid in 5 days." : tone === "firm" ? "Asks for payment within 7 days." : "Friendly first reminder."}`,
      evidence: overdue.slice(0, 4).map((o) => ({ label: `${o.number}, due ${dateLabel(o.dueDate)}`, ref: { kind: "document" as const, id: o.docId, region: "dueDate" } })),
      payload: { partyId, tone, to: party.contact.email, subject: letter.subject, body: letter.body, invoiceIds: overdue.map((o) => o.invoiceId) },
      status: "pending",
    });
  }
  return drafts.sort((a, b) => (b.title.includes("final") ? 1 : 0) - (a.title.includes("final") ? 1 : 0));
}
