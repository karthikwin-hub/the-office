import { type Bill, type Books, type CompanyEvent, ComplianceProfile, type Party } from "@office/contracts";
import { addDays, daysBetween } from "../dates";
import type { Ledger } from "../ledger";
import { payrollFor } from "../teams";

export const CRORE = 1_00_00_000_00;
export const LAKH = 1_00_000_00;

/** The company's own answers, with defaults for anything not yet given. */
export function profileOf(books: Books): ComplianceProfile {
  return ComplianceProfile.parse(books.business.compliance ?? {});
}

/** The financial year a date falls in, by the year it starts: 2026-11-04 is in 2026 (2026-27). */
export function fyOf(iso: string): number {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return m >= 4 ? y : y - 1;
}
export const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
export const fyFromLabel = (label: string) => Number(label.slice(0, 4));

/** Companies Act s.2(85): paid-up capital up to ₹10 crore and turnover up to ₹100 crore, and not a holding or subsidiary company. */
export function smallCompany(books: Books, p: ComplianceProfile): { value: boolean | null; reason: string } {
  const turnover = books.business.prevYearTurnoverPaise;
  if (p.holdingOrSubsidiary) return { value: false, reason: "A holding or subsidiary company is never a small company." };
  if (turnover > 100 * CRORE) return { value: false, reason: `Last year's turnover of ₹${(turnover / CRORE).toFixed(1)} crore is above the ₹100 crore limit for a small company.` };
  if (p.paidUpCapitalPaise === null) return { value: null, reason: "Add the paid-up capital to know whether this is a small company." };
  if (p.paidUpCapitalPaise > 10 * CRORE) return { value: false, reason: "Paid-up capital is above the ₹10 crore limit for a small company." };
  return { value: true, reason: "Paid-up capital is up to ₹10 crore and turnover up to ₹100 crore, so this is a small company: one board meeting each half-year and MGT-7A instead of MGT-7." };
}

/** The six answers the calendar cannot do without. */
export const KEY_QUESTIONS: { id: string; question: string; answered: (p: ComplianceProfile) => boolean }[] = [
  { id: "cin", question: "The company's CIN", answered: (p) => /^[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(p.cin) },
  { id: "incorporated", question: "When the company was incorporated", answered: (p) => p.incorporatedOn !== null },
  { id: "capital", question: "Paid-up capital", answered: (p) => p.paidUpCapitalPaise !== null },
  { id: "directors", question: "Directors and their DINs", answered: (p) => p.directors.length > 0 && p.directors.every((d) => /^\d{8}$/.test(d.din)) },
  { id: "gst", question: "Whether GST returns are monthly or quarterly", answered: (p) => p.gstFrequency !== null },
  { id: "agm", question: "When the last AGM was held", answered: (p) => p.agms.length > 0 },
];

export function answers(p: ComplianceProfile) {
  return KEY_QUESTIONS.map((q) => ({ id: q.id, question: q.question, answered: q.answered(p) }));
}

/** Tax audit: turnover above ₹10 crore when cash dealings stay within 5%, as they do for a company paid by bank. */
export function taxAuditApplies(books: Books, p: ComplianceProfile): boolean {
  return p.taxAudit === "yes" || (p.taxAudit === "auto" && books.business.prevYearTurnoverPaise > 10 * CRORE);
}

/** CSR (s.135): net profit of ₹5 crore, turnover of ₹1,000 crore or net worth of ₹500 crore. */
export function csrApplies(books: Books, p: ComplianceProfile): boolean {
  return (p.netProfitPaise ?? 0) >= 5 * CRORE || books.business.prevYearTurnoverPaise >= 1000 * CRORE || (p.netWorthPaise ?? 0) >= 500 * CRORE;
}

/** AOC-4 in XBRL: paid-up capital of ₹5 crore or turnover of ₹100 crore. */
export const xbrlApplies = (books: Books, p: ComplianceProfile) => (p.paidUpCapitalPaise ?? 0) >= 5 * CRORE || books.business.prevYearTurnoverPaise >= 100 * CRORE;
/** MGT-7 certified by a practising company secretary in MGT-8: paid-up capital of ₹10 crore or turnover of ₹50 crore. */
export const mgt8Applies = (books: Books, p: ComplianceProfile) => (p.paidUpCapitalPaise ?? 0) >= 10 * CRORE || books.business.prevYearTurnoverPaise >= 50 * CRORE;

/** The normal MCA filing fee by authorised capital; late filings pay a multiple of it. */
export function normalFeePaise(p: ComplianceProfile): number {
  const c = p.authorisedCapitalPaise;
  if (c < LAKH) return 200_00;
  if (c < 5 * LAKH) return 300_00;
  if (c < 25 * LAKH) return 400_00;
  if (c < 100 * LAKH) return 500_00;
  return 600_00;
}

/** The ₹ the company still owes on a bill, after TDS and payments. */
export function billOpenPaise(l: Ledger, b: Bill): number {
  const paid = l.books.payments.filter((p) => p.direction === "out" && p.date <= l.asOf).reduce((a, p) => a + p.allocations.filter((x) => x.billId === b.id).reduce((s, x) => s + x.amountPaise + x.tdsPaise, 0), 0);
  return Math.max(0, b.totals.totalPaise - (b.tds?.amountPaise ?? 0) - paid);
}

/** When the bill was settled in full, if it was. */
export function billPaidOn(l: Ledger, b: Bill): string | null {
  if (billOpenPaise(l, b) > 0) return null;
  const dates = l.books.payments.filter((p) => p.direction === "out" && p.allocations.some((x) => x.billId === b.id)).map((p) => p.date);
  return dates.length ? dates.sort().at(-1)! : b.date;
}

/** MSMED Act s.15 and s.16: micro and small suppliers that manufacture or provide services, not traders. */
export function msmeProtected(p: Party): boolean {
  return (p.udyamCategory === "micro" || p.udyamCategory === "small") && p.udyamActivity !== "trading";
}

/** Days the company may take: what was agreed in writing, never more than 45; 15 without a written agreement. */
export const msmeLimitDays = (p: Party) => (p.writtenCreditDays !== undefined ? Math.min(45, p.writtenCreditDays) : 15);

/** The RBI bank rate the MSMED Act's interest is three times of. Check the current rate. */
export const BANK_RATE_PCT = 5.75;
/** The concessional regime for companies (s.115BAA of the 1961 Act, carried into the 2025 Act): 22% plus 10% surcharge and 4% cess. */
export const COMPANY_TAX_PCT = 25.168;

/**
 * This year's income tax from the books: sales less purchases and payroll for the year so far, scaled to
 * a full year, at the company rate. A rough guide; the CA's estimate in the profile replaces it.
 */
export function estimateTax(l: Ledger, p: ComplianceProfile): { taxPaise: number; profitPaise: number; basis: string } {
  const fy = fyOf(l.asOf);
  const from = `${fy}-04-01`;
  if (p.estimatedTaxPaise !== null) return { taxPaise: p.estimatedTaxPaise, profitPaise: Math.round((p.estimatedTaxPaise * 100) / COMPANY_TAX_PCT), basis: "your CA's estimate" };
  const sales = l.books.invoices.filter((i) => i.status === "posted" && i.date >= from && i.date <= l.asOf).reduce((a, i) => a + i.totals.taxablePaise, 0);
  const buys = l.books.bills.filter((b) => b.status === "posted" && b.date >= from && b.date <= l.asOf).reduce((a, b) => a + b.totals.taxablePaise, 0);
  const months = Math.max(1, Math.round(daysBetween(from, l.asOf) / 30.4));
  const payroll = payrollFor(l, l.asOf.slice(0, 7)).reduce((a, x) => a + x.earnedPaise + x.pfEmployerPaise + x.esiEmployerPaise, 0) * months;
  const days = Math.max(30, daysBetween(from, l.asOf) + 1);
  const profit = Math.round(((sales - buys - payroll) * 365) / days);
  return { taxPaise: Math.max(0, Math.round((profit * COMPANY_TAX_PCT) / 100)), profitPaise: profit, basis: `the books so far this year (sales less purchases and payroll, scaled to twelve months) at ${COMPANY_TAX_PCT}%` };
}

/**
 * What changed in the company between two versions of the profile that starts an ROC clock:
 * a director in or out, the registered office, capital, a secured loan taken or repaid, the auditor.
 */
export function profileEvents(before: ComplianceProfile, after: ComplianceProfile, asOf: string): CompanyEvent[] {
  const out: CompanyEvent[] = [];
  const add = (kind: CompanyEvent["kind"], on: string, detail: string, extra: Partial<CompanyEvent> = {}) =>
    out.push({ id: `evt-${kind}-${on}-${out.length + after.events.length + 1}`, kind, on, detail, auto: true, ...extra });
  const was = new Map(before.directors.map((d) => [d.id, d]));
  const now = new Map(after.directors.map((d) => [d.id, d]));
  for (const d of after.directors) if (!was.has(d.id)) add("director_joined", d.appointedOn ?? asOf, `${d.name} (DIN ${d.din || "not yet given"}) joined the board.`);
  for (const d of before.directors) if (!now.has(d.id)) add("director_left", asOf, `${d.name} (DIN ${d.din || "-"}) left the board.`);
  if (before.registeredOffice && after.registeredOffice && before.registeredOffice !== after.registeredOffice) add("office_moved", asOf, `Registered office moved to ${after.registeredOffice}.`);
  if (before.authorisedCapitalPaise && after.authorisedCapitalPaise !== before.authorisedCapitalPaise) add("authorised_capital_changed", asOf, `Authorised capital changed to ₹${(after.authorisedCapitalPaise / 100).toLocaleString("en-IN")}.`);
  if (before.paidUpCapitalPaise !== null && after.paidUpCapitalPaise !== null && after.paidUpCapitalPaise > before.paidUpCapitalPaise) {
    const foreign = after.shareholders.some((s) => s.foreign && !before.shareholders.some((b) => b.id === s.id && b.shares >= s.shares));
    add("shares_allotted", asOf, `Paid-up capital went up by ₹${((after.paidUpCapitalPaise - before.paidUpCapitalPaise) / 100).toLocaleString("en-IN")}.`, { privatePlacement: false, foreign });
  }
  const loansBefore = new Map(before.loans.map((x) => [x.id, x]));
  for (const loan of after.loans) {
    const prev = loansBefore.get(loan.id);
    if (loan.secured && !prev) add("charge_created", loan.takenOn, `Secured loan from ${loan.lender}.`);
    if (loan.secured && loan.closedOn && !prev?.closedOn) add("charge_satisfied", loan.closedOn, `Secured loan from ${loan.lender} repaid.`);
  }
  if (before.auditor && after.auditor && before.auditor !== after.auditor) add("auditor_resigned", asOf, `${before.auditor} stepped down; ${after.auditor} is to be appointed to the casual vacancy.`);
  return out.filter((e) => e.on >= addDays(asOf, -365));
}
