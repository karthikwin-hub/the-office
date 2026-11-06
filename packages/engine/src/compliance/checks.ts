import type { ComplianceCheck, ComplianceProfile } from "@office/contracts";
import { addDays, dateLabel, daysBetween } from "../dates";
import type { Ledger } from "../ledger";
import { inr } from "../money";
import { expectedTdsByBill, NEW_ACT_FROM, tdsRef } from "../tds";
import {
  BANK_RATE_PCT,
  billOpenPaise,
  COMPANY_TAX_PCT,
  CRORE,
  estimateTax,
  fyOf,
  msmeLimitDays,
  msmeProtected,
  mgt8Applies,
  smallCompany,
  taxAuditApplies,
  xbrlApplies,
} from "./profile";

const rupees = (paise: number) => `₹${inr(paise, { rupees: true })}`;
type Row = ComplianceCheck["rows"][number];

/**
 * MSMED Act s.15: pay micro and small suppliers within the days agreed in writing, never more than 45,
 * or 15 without an agreement. Beyond that the company owes compound interest at three times the bank
 * rate, and the unpaid amount is not deductible for income tax until paid (s.43B(h), carried into the 2025 Act).
 */
export function msmeCheck(l: Ledger): ComplianceCheck {
  const rows: Row[] = [];
  let overdue = 0;
  let interest = 0;
  let soon = 0;
  const unknown = l.books.parties.filter((p) => p.kind === "vendor" && p.udyamCategory === undefined && p.entity !== "company");
  for (const b of l.payableBills) {
    const party = l.party(b.partyId);
    if (!msmeProtected(party)) continue;
    const open = billOpenPaise(l, b);
    if (!open) continue;
    const limit = msmeLimitDays(party);
    const dueOn = addDays(b.date, limit);
    const late = daysBetween(dueOn, l.asOf);
    if (late > 0) {
      overdue += open;
      const months = late / 30.4;
      interest += Math.round(open * (Math.pow(1 + (3 * BANK_RATE_PCT) / 1200, months) - 1));
      rows.push({ label: `${party.name}, bill ${b.number}`, detail: `${party.udyamCategory === "micro" ? "Micro" : "Small"} enterprise, ${limit} days ${party.writtenCreditDays !== undefined ? "agreed in writing" : "(no written agreement)"}: due ${dateLabel(dueOn)}, ${late} day${late === 1 ? "" : "s"} late.`, amountPaise: open, ref: { kind: "document", id: b.docId } });
    } else if (late > -7) {
      soon += open;
      rows.push({ label: `${party.name}, bill ${b.number}`, detail: `Pay by ${dateLabel(dueOn)} (${-late} day${late === -1 ? "" : "s"} left).`, amountPaise: open, ref: { kind: "document", id: b.docId } });
    }
  }
  const taxAtRisk = Math.round((overdue * COMPANY_TAX_PCT) / 100);
  if (unknown.length) rows.push({ label: `${unknown.length} supplier${unknown.length === 1 ? "" : "s"} without a Udyam status`, detail: `Ask ${unknown.slice(0, 3).map((p) => p.name).join(", ")}${unknown.length > 3 ? " and others" : ""} whether they are registered on Udyam; until then the rule cannot be checked for them.`, amountPaise: null, ref: null });
  return {
    id: "msme",
    title: "Micro and small suppliers paid on time",
    tone: overdue ? "red" : soon ? "amber" : "green",
    summary: overdue
      ? `${rupees(overdue)} owed to micro and small suppliers is past the legal limit. Until it is paid, ${rupees(taxAtRisk)} of income tax is at stake because the expense is not deductible, and interest of about ${rupees(interest)} has run at ${3 * BANK_RATE_PCT}% a year, compounded monthly.`
      : soon
        ? `${rupees(soon)} to micro and small suppliers falls due within a week.`
        : "Every micro and small supplier has been paid within the legal limit.",
    amountPaise: taxAtRisk + interest,
    rows,
    proposal: overdue ? { id: "pay-msme", label: "Pay MSME suppliers first" } : null,
  };
}

/** DPT-3: what the company owes as at 31 March, and the declarations each kind of lender needs. */
export function dpt3Check(l: Ledger, p: ComplianceProfile): ComplianceCheck {
  const yearEnd = `${fyOf(l.asOf)}-03-31`;
  const open = p.loans.filter((x) => x.takenOn <= yearEnd && (!x.closedOn || x.closedOn > yearEnd));
  const NOTE: Record<string, string> = {
    director: "Exempt from deposits if the director declares in writing that it is not from borrowed money.",
    shareholder: "A private company may take it without it being a deposit, but it is reported.",
    related_company: "Exempt from deposits; reported.",
    bank: "Exempt; reported.",
    nbfc: "Exempt; reported.",
    other: "Check whether this is a deposit: if so, rules on deposits apply.",
  };
  return {
    id: "dpt3",
    title: "Money borrowed, for DPT-3",
    tone: open.some((x) => x.kind === "other") ? "amber" : "green",
    summary: open.length ? `${open.length} loan${open.length === 1 ? "" : "s"} of ${rupees(open.reduce((a, x) => a + x.amountPaise, 0))} were outstanding on 31 March, so DPT-3 is due by 30 June.` : "No loans recorded as outstanding on 31 March. Add any in the profile so DPT-3 is not missed.",
    amountPaise: 0,
    rows: open.map((x) => ({ label: `${x.lender}${x.secured ? " (secured)" : ""}`, detail: NOTE[x.kind]!, amountPaise: x.amountPaise, ref: null })),
    proposal: null,
  };
}

/** The year's tax at the company rate against what the instalments called for so far. */
export function advanceTaxCheck(l: Ledger, p: ComplianceProfile, paidPaise: number): ComplianceCheck {
  const est = estimateTax(l, p);
  const fy = fyOf(l.asOf);
  const steps: [string, number][] = [[`${fy}-06-15`, 15], [`${fy}-09-15`, 45], [`${fy}-12-15`, 75], [`${fy + 1}-03-15`, 100]];
  const done = steps.filter(([d]) => d <= l.asOf).at(-1)?.[1] ?? 0;
  const next = steps.find(([d]) => d > l.asOf);
  const due = Math.round((est.taxPaise * done) / 100);
  const short = Math.max(0, due - paidPaise);
  const nextAmount = next ? Math.round((est.taxPaise * next[1]) / 100) - Math.max(due, paidPaise) : 0;
  return {
    id: "advance-tax",
    title: "Advance tax",
    tone: short > 0 ? "red" : next && daysBetween(l.asOf, next[0]) <= 45 ? "amber" : "green",
    summary: `This year's tax is about ${rupees(est.taxPaise)}, from ${est.basis}.${short > 0 ? ` ${rupees(short)} is short of the ${done}% due by now, with interest at 1% a month.` : ""}${next ? ` Set aside ${rupees(Math.max(0, nextAmount))} for ${dateLabel(next[0])} (${next[1]}% of the year's tax).` : ""}`,
    amountPaise: short,
    rows: [
      { label: "Profit for the year, estimated", detail: est.basis, amountPaise: est.profitPaise, ref: null },
      { label: `Tax at ${COMPANY_TAX_PCT}%`, detail: "The new regime for companies: 22% plus surcharge and cess.", amountPaise: est.taxPaise, ref: null },
      { label: "Paid so far", detail: "Instalments marked paid in the calendar.", amountPaise: paidPaise, ref: null },
    ],
    proposal: next && nextAmount > 0 ? { id: "advance-tax", label: "Set aside advance tax" } : null,
  };
}

/** Deductions the rules call for this year against what the books deducted. */
export function tdsGapCheck(l: Ledger): ComplianceCheck {
  const fy = fyOf(l.asOf);
  const expected = expectedTdsByBill(l);
  const rows: Row[] = [];
  let gap = 0;
  for (const b of l.postedBills) {
    if (fyOf(b.date) !== fy) continue;
    const e = expected.get(b.id);
    const booked = b.tds?.amountPaise ?? 0;
    if (!e || e.amountPaise - booked <= 100) continue;
    const party = l.party(b.partyId);
    gap += e.amountPaise - booked;
    rows.push({ label: `${party.name}, bill ${b.number}`, detail: booked ? `Deducted ${rupees(booked)} at ${(b.tds?.rateBp ?? 0) / 100}%; ${tdsRef(e.section, b.date, party).label} calls for ${e.rateBp / 100}%.` : `No TDS deducted; ${tdsRef(e.section, b.date, party).label} applies.`, amountPaise: e.amountPaise - booked, ref: { kind: "document", id: b.docId } });
  }
  return {
    id: "tds-gaps",
    title: "TDS deducted as the rules require",
    tone: gap ? "red" : "green",
    summary: gap ? `${rupees(gap)} less TDS was deducted this year than the rules call for. The company owes it, with interest at 1% a month, and 30% of the expense can be disallowed.` : "Every bill this year has the TDS the rules call for.",
    amountPaise: gap,
    rows,
    proposal: null,
  };
}

/** Limits the company has crossed, or is near, that switch obligations on. */
export function thresholdCheck(l: Ledger, p: ComplianceProfile): ComplianceCheck {
  const b = l.books.business;
  const t = b.prevYearTurnoverPaise;
  const cr = (paise: number) => `₹${(paise / CRORE).toFixed(1)} crore`;
  const small = smallCompany(l.books, p);
  const rows: Row[] = [
    { label: t > 5 * CRORE ? "E-invoicing applies" : "E-invoicing does not apply", detail: t > 5 * CRORE ? `Turnover above ₹5 crore: every B2B invoice needs an IRN.${t >= 10 * CRORE ? " At ₹10 crore and above it must be reported to the IRP within 30 days of its date." : ""}` : "Turnover is within ₹5 crore.", amountPaise: null, ref: null },
    { label: "GST annual return", detail: t > 5 * CRORE ? "GSTR-9 and the reconciliation statement GSTR-9C." : t > 2 * CRORE ? "GSTR-9 only." : "Optional up to ₹2 crore.", amountPaise: null, ref: null },
    { label: taxAuditApplies(l.books, p) ? "Tax audit applies" : "No tax audit", detail: `Last year's turnover was ${cr(t)}; the limit is ₹10 crore when cash dealings stay within 5%.`, amountPaise: null, ref: null },
    { label: small.value ? "Small company" : small.value === false ? "Not a small company" : "Small company: not known", detail: small.reason, amountPaise: null, ref: null },
  ];
  if (xbrlApplies(l.books, p)) rows.push({ label: "AOC-4 in XBRL", detail: "Paid-up capital of ₹5 crore or turnover of ₹100 crore.", amountPaise: null, ref: null });
  if (mgt8Applies(l.books, p)) rows.push({ label: "MGT-8 certificate", detail: "A practising company secretary certifies the annual return: paid-up capital of ₹10 crore or turnover of ₹50 crore.", amountPaise: null, ref: null });
  const demat = small.value === false && !p.flags.demat;
  if (demat) rows.push({ label: "Shares must be in demat (rule 9B)", detail: "A private company that is not small must hold its shares in demat form within 18 months of the year it stopped being small, issue new shares only in demat, and get an ISIN.", amountPaise: null, ref: null });
  const nearEinv = t > 4 * CRORE && t <= 5 * CRORE;
  return {
    id: "thresholds",
    title: "Limits that change what you file",
    tone: demat ? "red" : nearEinv ? "amber" : "green",
    summary: demat ? "The company is not a small company and its shares are not in demat yet; rule 9B requires it." : `Based on last year's turnover of ${cr(t)}.`,
    amountPaise: 0,
    rows,
    proposal: null,
  };
}

/** Rule 37: credit on a bill not paid within 180 days is reversed, with interest, until it is paid. */
export function itc180Check(l: Ledger): ComplianceCheck {
  const rows: Row[] = [];
  let tax = 0;
  for (const b of l.postedBills) {
    if (!b.itcEligible) continue;
    const age = daysBetween(b.date, l.asOf);
    if (age < 150) continue;
    const open = billOpenPaise(l, b);
    if (!open) continue;
    const credit = Math.round(((b.totals.cgstPaise + b.totals.sgstPaise + b.totals.igstPaise) * open) / b.totals.totalPaise);
    if (age >= 180) tax += credit;
    rows.push({ label: `${l.party(b.partyId).name}, bill ${b.number}`, detail: age >= 180 ? `${age} days unpaid: reverse ${rupees(credit)} of credit in the next GSTR-3B.` : `${180 - age} days left to pay before ${rupees(credit)} of credit has to be reversed.`, amountPaise: credit, ref: { kind: "document", id: b.docId } });
  }
  return {
    id: "itc-180",
    title: "Suppliers paid within 180 days",
    tone: tax ? "red" : rows.length ? "amber" : "green",
    summary: tax ? `${rupees(tax)} of input tax credit is on bills unpaid for over 180 days and must be reversed until they are paid.` : rows.length ? "Some bills are nearing 180 days unpaid." : "No bill with input tax credit is near 180 days unpaid.",
    amountPaise: tax,
    rows,
    proposal: null,
  };
}

/** Rent and other services from unregistered suppliers on which the company pays GST itself. */
export function rcmCheck(l: Ledger): ComplianceCheck {
  const rows: Row[] = [];
  for (const b of l.postedBills) {
    const party = l.party(b.partyId);
    if (party.gstin || b.kind !== "rent") continue;
    if (daysBetween(b.date, l.asOf) > 120) continue;
    const gst = Math.round((b.totals.taxablePaise * 18) / 100);
    rows.push({ label: `${party.name}, bill ${b.number}`, detail: `Rent from an unregistered landlord: issue a self-invoice within 30 days (by ${dateLabel(addDays(b.date, 30))}) and pay ${rupees(gst)} GST under reverse charge in cash; the same amount is then credit.`, amountPaise: gst, ref: { kind: "document", id: b.docId } });
  }
  return {
    id: "rcm",
    title: "GST on reverse charge",
    tone: rows.length ? "amber" : "green",
    summary: rows.length ? `${rows.length} recent bill${rows.length === 1 ? "" : "s"} attract GST payable by the company under reverse charge.` : "No reverse-charge bills in the last four months.",
    amountPaise: 0,
    rows,
    proposal: null,
  };
}

/** Payments abroad need Forms 145 and 146 (formerly 15CA and 15CB) before the bank remits. */
export function foreignPaymentCheck(p: ComplianceProfile, asOf: string): ComplianceCheck | null {
  if (!p.flags.foreignPayments) return null;
  return {
    id: "foreign-payments",
    title: "Payments abroad",
    tone: "amber",
    summary: `Before each payment to someone outside India, file ${asOf >= NEW_ACT_FROM ? "Form 145 (formerly 15CA) and, above ₹5 lakh where tax applies, a CA's Form 146 (formerly 15CB)" : "Form 15CA and, where needed, a CA's Form 15CB"}. The bank will ask for the acknowledgement.`,
    amountPaise: 0,
    rows: [],
    proposal: null,
  };
}
