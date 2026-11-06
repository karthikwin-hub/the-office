import type { Books, ComplianceProfile, Director } from "@office/contracts";
import { addDays, monthEnd, monthLabel, nextMonth, quarterLabel, quarterMonths, quarterOf } from "../dates";
import { itcFor, outwardFor, setOff } from "../gst";
import type { Ledger } from "../ledger";
import { taxYearLabel, tdsDepositDue, tdsReturnDue, tdsReturnForm } from "../tds";
import { payrollFor } from "../teams";
import {
  billPaidOn,
  CRORE,
  csrApplies,
  estimateTax,
  fyLabel,
  fyOf,
  mgt8Applies,
  msmeProtected,
  normalFeePaise,
  smallCompany,
  taxAuditApplies,
  xbrlApplies,
} from "./profile";

export type Portal = { name: string; url: string };
export const PORTALS = {
  gst: { name: "GST portal", url: "https://services.gst.gov.in" },
  it: { name: "Income-tax e-filing portal", url: "https://www.incometax.gov.in" },
  traces: { name: "TRACES", url: "https://www.tdscpc.gov.in" },
  mca: { name: "MCA V3 portal", url: "https://www.mca.gov.in" },
  epfo: { name: "EPFO employer portal", url: "https://unifiedportal-emp.epfindia.gov.in" },
  esic: { name: "ESIC portal", url: "https://www.esic.gov.in" },
  pt: { name: "State professional tax portal", url: "https://mahagst.gov.in" },
  firms: { name: "RBI FIRMS portal", url: "https://firms.rbi.org.in" },
  board: { name: "The company's minutes book", url: "" },
} satisfies Record<string, Portal>;

/** What being late costs: the late fee, interest or penalty the law sets. */
export type Late =
  | { kind: "gst"; perDayPaise: number; capPaise: number; taxPaise: number }
  | { kind: "interest"; pctMonth: number; basePaise: number; minMonths: number }
  | { kind: "per-day"; perDayPaise: number; capPaise: number | null; flatPaise: number }
  | { kind: "mca-multiple"; feePaise: number }
  | { kind: "flat"; paise: number }
  | { kind: "none" };

/** Companies (Registration Offices and Fees) Rules: the normal fee times this for each band of delay. */
export function mcaMultiple(daysLate: number): number {
  if (daysLate <= 0) return 0;
  if (daysLate <= 15) return 1;
  if (daysLate <= 30) return 2;
  if (daysLate <= 60) return 4;
  if (daysLate <= 90) return 6;
  if (daysLate <= 180) return 10;
  return 12;
}

export function lateCost(late: Late, daysLate: number): number {
  if (daysLate <= 0) return 0;
  switch (late.kind) {
    case "gst":
      return Math.min(late.perDayPaise * daysLate, late.capPaise) + Math.round((late.taxPaise * 18 * daysLate) / 36500);
    case "interest":
      return Math.round((late.basePaise * late.pctMonth * Math.max(late.minMonths, Math.ceil(daysLate / 30))) / 100);
    case "per-day":
      return late.flatPaise + (late.capPaise === null ? late.perDayPaise * daysLate : Math.min(late.perDayPaise * daysLate, late.capPaise));
    case "mca-multiple":
      return late.feePaise * mcaMultiple(daysLate);
    case "flat":
      return late.paise;
    case "none":
      return 0;
  }
}

/** One item the rules work out, before the stored tracking is laid over it. */
export type RawItem = {
  ruleId: string;
  period: string;
  form: string;
  title: string;
  authority: string;
  dueOn: string;
  why: string;
  documents: string[];
  portal: Portal;
  amountPaise: number | null;
  late: Late;
  lateNote: string;
  risk: string | null;
  papers: boolean;
  mca: boolean;
  source: "rule" | "event";
  /** Filed according to the books themselves (a return the accountant shared). */
  filed?: { on: string; ack: string } | null;
};

export type Ctx = {
  books: Books;
  l: Ledger;
  p: ComplianceProfile;
  asOf: string;
  from: string;
  to: string;
  small: boolean | null;
  turnoverPaise: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const GST_THREE_YEARS = "A GST return can no longer be filed three years after its due date, so a missed one cannot be put right later.";

/** Months whose obligations could fall due inside the window. */
function months(c: Ctx): string[] {
  const out: string[] = [];
  let m = addDays(c.from, -70).slice(0, 7);
  const end = c.to.slice(0, 7);
  while (m <= end) {
    out.push(m);
    m = nextMonth(m);
  }
  return out;
}
function fys(c: Ctx): number[] {
  const out: number[] = [];
  for (let fy = fyOf(c.from) - 2; fy <= fyOf(c.to) + 1; fy++) out.push(fy);
  return out;
}
const isPast = (c: Ctx, period: string) => monthEnd(period) <= c.asOf;

/** QRMP states whose quarterly GSTR-3B is due on the 22nd; the rest file by the 24th. */
const QRMP_22 = new Set(["22", "23", "24", "27", "29", "30", "31", "32", "33", "34", "35", "36", "37", "25", "26", "38"]);

export function gstFrequency(c: Ctx): "monthly" | "quarterly" {
  if (c.turnoverPaise > 5 * CRORE) return "monthly";
  return c.p.gstFrequency ?? "monthly";
}

function gstLateCap(c: Ctx): number {
  if (c.turnoverPaise > 5 * CRORE) return 10_000_00;
  if (c.turnoverPaise > 1.5 * CRORE) return 5_000_00;
  return 2_000_00;
}

function gstRules(c: Ctx): RawItem[] {
  if (!c.books.business.gstin) return [];
  const out: RawItem[] = [];
  const freq = gstFrequency(c);
  const filed = (form: string, period: string) => {
    const r = c.books.filedReturns.find((x) => x.form === form && x.period === period && x.status === "filed");
    return r ? { on: r.filedOn ?? r.dueOn, ack: "" } : null;
  };
  for (const m of months(c)) {
    const mo = Number(m.slice(5, 7));
    const next = nextMonth(m);
    const qEnd = [6, 9, 12, 3].includes(mo);
    const payable = isPast(c, m) ? setOff(outwardFor(c.l, m), itcFor(c.l, m).eligible).payable.totalPaise : null;
    if (freq === "monthly") {
      out.push({
        ruleId: "gstr1", period: m, form: "GSTR-1", title: `GSTR-1 for ${monthLabel(m)}`, authority: "GST", dueOn: `${next}-11`,
        why: "The sales return. Customers can claim input tax credit only on invoices that appear in it, so a late GSTR-1 holds up their credit too.",
        documents: ["Sales invoices and credit notes for the month", "E-invoice IRNs, if you e-invoice"], portal: PORTALS.gst, amountPaise: null,
        late: { kind: "gst", perDayPaise: 50_00, capPaise: gstLateCap(c), taxPaise: 0 }, lateNote: "₹50 a day late fee (₹20 for a nil return), capped by turnover.",
        risk: GST_THREE_YEARS, papers: true, mca: false, source: "rule", filed: filed("GSTR-1", m),
      });
      out.push({
        ruleId: "ims", period: m, form: "IMS", title: `Review purchase invoices on IMS for ${monthLabel(m)}`, authority: "GST", dueOn: `${next}-14`,
        why: "GSTR-2B is generated on the 14th from what you accept on the Invoice Management System. Anything you have not acted on is taken as accepted, including invoices you dispute.",
        documents: ["Purchase bills for the month"], portal: PORTALS.gst, amountPaise: null, late: { kind: "none" }, lateNote: "No fee, but disputed invoices are accepted by default.",
        risk: null, papers: false, mca: false, source: "rule",
      });
      out.push({
        ruleId: "gstr3b", period: m, form: "GSTR-3B", title: `GSTR-3B and GST payment for ${monthLabel(m)}`, authority: "GST", dueOn: `${next}-20`,
        why: "The summary return that pays the month's GST after input tax credit.",
        documents: ["GSTR-2B for the month", "Sales and purchase registers"], portal: PORTALS.gst, amountPaise: payable,
        late: { kind: "gst", perDayPaise: 50_00, capPaise: gstLateCap(c), taxPaise: payable ?? 0 }, lateNote: "₹50 a day late fee, capped by turnover, plus 18% a year interest on the tax paid late.",
        risk: GST_THREE_YEARS, papers: true, mca: false, source: "rule", filed: filed("GSTR-3B", m),
      });
    } else {
      const q = quarterOf(`${m}-01`);
      if (qEnd) {
        const day3b = QRMP_22.has(c.books.business.stateCode) ? 22 : 24;
        out.push({
          ruleId: "gstr1", period: q, form: "GSTR-1", title: `GSTR-1 for ${quarterLabel(q)}`, authority: "GST", dueOn: `${next}-13`,
          why: "The quarterly sales return under QRMP. Invoices to registered customers can go up earlier through IFF so they get their credit sooner.",
          documents: ["Sales invoices and credit notes for the quarter"], portal: PORTALS.gst, amountPaise: null,
          late: { kind: "gst", perDayPaise: 50_00, capPaise: gstLateCap(c), taxPaise: 0 }, lateNote: "₹50 a day late fee, capped by turnover.",
          risk: GST_THREE_YEARS, papers: true, mca: false, source: "rule", filed: filed("GSTR-1", q),
        });
        out.push({
          ruleId: "gstr3b", period: q, form: "GSTR-3B", title: `GSTR-3B for ${quarterLabel(q)}`, authority: "GST", dueOn: `${next}-${day3b}`,
          why: "The quarterly summary return under QRMP.", documents: ["GSTR-2B for the quarter"], portal: PORTALS.gst, amountPaise: payable,
          late: { kind: "gst", perDayPaise: 50_00, capPaise: gstLateCap(c), taxPaise: payable ?? 0 }, lateNote: "₹50 a day late fee plus 18% a year interest.",
          risk: GST_THREE_YEARS, papers: true, mca: false, source: "rule", filed: filed("GSTR-3B", q),
        });
      } else {
        out.push({
          ruleId: "pmt06", period: m, form: "PMT-06", title: `GST payment for ${monthLabel(m)} (PMT-06)`, authority: "GST", dueOn: `${next}-25`,
          why: "Under QRMP the tax for the first two months of a quarter is paid monthly by challan.", documents: ["Sales and purchase registers"], portal: PORTALS.gst,
          amountPaise: payable, late: { kind: "gst", perDayPaise: 0, capPaise: 0, taxPaise: payable ?? 0 }, lateNote: "18% a year interest on tax paid late.",
          risk: null, papers: false, mca: false, source: "rule",
        });
      }
    }
    if (c.turnoverPaise <= 5 * CRORE && [4, 7, 10, 1].includes(mo)) {
      out.push({
        ruleId: "qrmp-opt", period: m, form: "QRMP", title: "Last day to switch between monthly and quarterly GST returns", authority: "GST", dueOn: monthEnd(m),
        why: "Businesses with turnover up to ₹5 crore may choose quarterly returns (QRMP); the choice for a quarter closes at the end of its first month.",
        documents: [], portal: PORTALS.gst, amountPaise: null, late: { kind: "none" }, lateNote: "The choice carries over to the next quarter.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
  }
  for (const fy of fys(c)) {
    const label = fyLabel(fy);
    if (c.turnoverPaise > 2 * CRORE) {
      const perDay = c.turnoverPaise > 20 * CRORE ? 200_00 : c.turnoverPaise > 5 * CRORE ? 100_00 : 50_00;
      const capPct = c.turnoverPaise > 20 * CRORE ? 0.5 : 0.04;
      out.push({
        ruleId: "gstr9", period: label, form: c.turnoverPaise > 5 * CRORE ? "GSTR-9 and 9C" : "GSTR-9", title: `GST annual return for FY ${label}${c.turnoverPaise > 5 * CRORE ? " with the reconciliation statement (9C)" : ""}`,
        authority: "GST", dueOn: `${fy + 1}-12-31`,
        why: `Required above ₹2 crore turnover${c.turnoverPaise > 5 * CRORE ? "; above ₹5 crore the self-certified reconciliation with the audited accounts (GSTR-9C) goes with it" : ""}.`,
        documents: ["Audited financial statements", "All GSTR-1 and GSTR-3B for the year", "ITC register"], portal: PORTALS.gst, amountPaise: null,
        late: { kind: "per-day", perDayPaise: perDay, capPaise: Math.round((c.turnoverPaise * capPct) / 100), flatPaise: 0 },
        lateNote: `₹${perDay / 100} a day late fee, capped at ${capPct}% of turnover.`, risk: GST_THREE_YEARS, papers: true, mca: false, source: "rule",
      });
    }
    out.push({
      ruleId: "itc-cutoff", period: label, form: "ITC cut-off", title: `Last day to claim input tax credit for FY ${label}`, authority: "GST", dueOn: `${fy + 1}-11-30`,
      why: "Section 16(4): credit for the year must be taken by 30 November after it ends. It is also the last day to issue credit notes, amend the year's invoices and re-claim credit reversed under rule 37A.",
      documents: ["GSTR-2B for the year", "Purchase register"], portal: PORTALS.gst, amountPaise: null, late: { kind: "none" }, lateNote: "Credit not claimed by then is lost for good.",
      risk: "Credit not claimed by 30 November is lost.", papers: false, mca: false, source: "rule",
    });
    out.push({
      ruleId: "invoice-series", period: label, form: "Invoice series", title: `Start a new invoice number series for FY ${label}`, authority: "GST", dueOn: `${fy}-04-01`,
      why: "Invoice numbers must be unique for the financial year; most businesses start a fresh series on 1 April.", documents: [], portal: PORTALS.gst, amountPaise: null,
      late: { kind: "none" }, lateNote: "", risk: null, papers: false, mca: false, source: "rule",
    });
    if (c.p.flags.exportsUnderLut) {
      out.push({
        ruleId: "lut", period: label, form: "GST RFD-11 (LUT)", title: `Letter of undertaking for exports in FY ${label}`, authority: "GST", dueOn: `${fy}-03-31`,
        why: "Exports and supplies to SEZs go out without IGST only under a letter of undertaking, given afresh for each year.", documents: ["Two witnesses' details"], portal: PORTALS.gst,
        amountPaise: null, late: { kind: "none" }, lateNote: "", risk: "Without it, exports pay IGST now and claim a refund later.", papers: false, mca: false, source: "rule",
      });
    }
    if (c.p.flags.jobWork) {
      const half = c.turnoverPaise > 5 * CRORE;
      for (const [period, due, what] of half ? ([[`${label}-H1`, `${fy}-10-25`, "April to September"], [`${label}-H2`, `${fy + 1}-04-25`, "October to March"]] as const) : ([[label, `${fy + 1}-04-25`, `FY ${label}`]] as const)) {
        out.push({
          ruleId: "itc04", period, form: "ITC-04", title: `Goods sent to job workers, ${what}`, authority: "GST", dueOn: due,
          why: `Inputs and capital goods sent to job workers and received back${half ? " (half-yearly above ₹5 crore turnover)" : " (yearly up to ₹5 crore turnover)"}.`,
          documents: ["Delivery challans to job workers"], portal: PORTALS.gst, amountPaise: null, late: { kind: "none" }, lateNote: "", risk: "Goods not back within a year (three for capital goods) are treated as supplied.", papers: false, mca: false, source: "rule",
        });
      }
    }
  }
  return out;
}

function tdsRules(c: Ctx): RawItem[] {
  const b = c.books.business;
  if (!b.tan) return [];
  const out: RawItem[] = [];
  const tdsIn = (from: string, to: string) => c.books.bills.filter((x) => x.status === "posted" && !x.opening && x.date >= from && x.date <= to).reduce((a, x) => a + (x.tds?.amountPaise ?? 0), 0);
  for (const m of months(c)) {
    const amount = isPast(c, m) || m === c.asOf.slice(0, 7) ? tdsIn(`${m}-01`, monthEnd(m)) : null;
    out.push({
      ruleId: "tds-deposit", period: m, form: "TDS challan", title: `Deposit TDS deducted in ${monthLabel(m)}`, authority: "Income Tax", dueOn: tdsDepositDue(`${m}-01`),
      why: `Tax deducted from suppliers' bills is paid to the government by the 7th of the next month (30 April for March).${m >= "2026-04" ? " From April 2026 each payment carries its section 393 payment code on the challan." : ""}`,
      documents: ["TDS register for the month"], portal: PORTALS.it, amountPaise: amount,
      late: { kind: "interest", pctMonth: 1.5, basePaise: amount ?? 0, minMonths: 2 }, lateNote: "Interest at 1.5% a month or part of a month from the date of deduction.",
      risk: "TDS deducted but not paid is treated very seriously and can be prosecuted.", papers: true, mca: false, source: "rule",
    });
  }
  for (const fy of fys(c)) {
    for (let q = 1; q <= 4; q++) {
      const quarter = `FY${fy}-${pad((fy + 1) % 100)}-Q${q}`;
      const ms = quarterMonths(quarter);
      const amount = isPast(c, ms[2]!) ? tdsIn(`${ms[0]}-01`, monthEnd(ms[2]!)) : null;
      const form = tdsReturnForm(quarter);
      const filed = c.books.filedReturns.find((r) => r.form === "26Q" && r.period === quarter && r.status === "filed");
      out.push({
        ruleId: "tds-return", period: quarter, form, title: `${form === "26Q" ? "26Q" : "Form 140"} TDS return for ${quarterLabel(quarter)} ${fy + (q === 4 ? 1 : 0)}`, authority: "Income Tax", dueOn: tdsReturnDue(quarter),
        why: form === "26Q" ? "The quarterly statement of tax deducted from payments other than salary." : "The quarterly statement of tax deducted from payments other than salary. Form 140 replaces 26Q from tax year 2026-27, with each deduction under its section 393 code.",
        documents: ["Challans paid for the quarter", "Deductees' PANs"], portal: PORTALS.traces, amountPaise: amount,
        late: { kind: "per-day", perDayPaise: 200_00, capPaise: amount ?? null, flatPaise: 0 }, lateNote: "₹200 a day until filed, up to the TDS for the quarter; a penalty of ₹10,000 to ₹1 lakh can follow.",
        risk: "Suppliers cannot claim the tax until it is filed.", papers: true, mca: false, source: "rule", filed: filed ? { on: filed.filedOn ?? filed.dueOn, ack: "" } : null,
      });
      if (c.p.flags.salaryTds) {
        out.push({
          ruleId: "tds-salary", period: quarter, form: form === "26Q" ? "24Q" : "Form 138", title: `${form === "26Q" ? "24Q" : "Form 138"} salary TDS return for ${quarterLabel(quarter)}`, authority: "Income Tax", dueOn: tdsReturnDue(quarter),
          why: "The quarterly statement of tax deducted from salaries.", documents: ["Payroll register", "Employees' declarations"], portal: PORTALS.traces, amountPaise: null,
          late: { kind: "per-day", perDayPaise: 200_00, capPaise: null, flatPaise: 0 }, lateNote: "₹200 a day until filed, up to the TDS for the quarter.", risk: null, papers: false, mca: false, source: "rule",
        });
      }
    }
    if (c.p.flags.salaryTds) {
      out.push({
        ruleId: "salary-certificate", period: fyLabel(fy), form: fy >= 2026 ? "Form 130" : "Form 16", title: `Salary TDS certificates to employees for ${taxYearLabel(fy)}`, authority: "Income Tax", dueOn: `${fy + 1}-06-15`,
        why: "Each employee gets a certificate of tax deducted from their salary.", documents: ["Form 138 (24Q) for the fourth quarter"], portal: PORTALS.traces, amountPaise: null,
        late: { kind: "per-day", perDayPaise: 100_00, capPaise: null, flatPaise: 0 }, lateNote: "₹100 a day per certificate.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
  }
  return out;
}

function incomeTaxRules(c: Ctx): RawItem[] {
  const out: RawItem[] = [];
  const est = estimateTax(c.l, c.p);
  const thisFy = fyOf(c.asOf);
  for (const fy of fys(c)) {
    const label = fyLabel(fy);
    const steps = [
      [`${fy}-06-15`, 15, "first"],
      [`${fy}-09-15`, 45, "second"],
      [`${fy}-12-15`, 75, "third"],
      [`${fy + 1}-03-15`, 100, "last"],
    ] as const;
    let prev = 0;
    for (const [due, pct, which] of steps) {
      const amount = fy === thisFy ? Math.round((est.taxPaise * (pct - prev)) / 100) : null;
      out.push({
        ruleId: "advance-tax", period: `${label}-${pct}`, form: "Advance tax", title: `Advance tax, ${which} instalment for ${taxYearLabel(fy)} (${pct}% of the year's tax)`, authority: "Income Tax", dueOn: due,
        why: `Companies pay the year's tax as they go: 15%, 45%, 75% and 100% by 15 June, September, December and March.${amount !== null ? ` Worked out from ${est.basis}.` : ""}`,
        documents: ["Profit estimate for the year"], portal: PORTALS.it, amountPaise: amount,
        late: { kind: "interest", pctMonth: 1, basePaise: amount ?? 0, minMonths: pct === 100 ? 1 : 3 }, lateNote: "Interest at 1% a month on the shortfall: three months for each of the first three instalments, one for the last.",
        risk: null, papers: true, mca: false, source: "rule",
      });
      prev = pct;
    }
    const audit = taxAuditApplies(c.books, c.p);
    if (audit) {
      out.push({
        ruleId: "tax-audit", period: label, form: fy >= 2026 ? "Tax audit report" : "Form 3CA-3CD", title: `Tax audit report for ${taxYearLabel(fy)}`, authority: "Income Tax", dueOn: `${fy + 1}-09-30`,
        why: "Turnover above ₹10 crore (with cash dealings within 5%) needs the accounts audited for tax by a chartered accountant, a month before the return.",
        documents: ["Audited financial statements", "Fixed asset register", "TDS and GST returns for the year"], portal: PORTALS.it, amountPaise: null,
        late: { kind: "flat", paise: Math.min(Math.round(c.turnoverPaise * 0.005), 1_50_000_00) }, lateNote: "Penalty of 0.5% of turnover, up to ₹1.5 lakh.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
    if (c.p.flags.transferPricing) {
      out.push({
        ruleId: "tp-report", period: label, form: fy >= 2026 ? "Form 48" : "Form 3CEB", title: `Transfer pricing report for ${taxYearLabel(fy)}`, authority: "Income Tax", dueOn: `${fy + 1}-10-31`,
        why: "Dealings with associated enterprises abroad, or specified domestic transactions, need an accountant's report.", documents: ["Intercompany agreements", "Benchmarking study"], portal: PORTALS.it, amountPaise: null,
        late: { kind: "flat", paise: 1_00_000_00 }, lateNote: "Penalty of ₹1 lakh.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
    out.push({
      ruleId: "itr", period: label, form: fy >= 2026 ? "Income-tax return" : "ITR-6", title: `Company income-tax return for ${taxYearLabel(fy)}`, authority: "Income Tax",
      dueOn: c.p.flags.transferPricing ? `${fy + 1}-11-30` : `${fy + 1}-10-31`,
      why: `Every company files a return, profit or loss${c.p.flags.transferPricing ? "; with a transfer pricing report it is due on 30 November" : ""}.`,
      documents: ["Audited financial statements", "Tax audit report", "Form 26AS and AIS"], portal: PORTALS.it, amountPaise: null,
      late: { kind: "flat", paise: 5_000_00 }, lateNote: "₹5,000 late fee, plus interest at 1% a month on any tax unpaid.", risk: "Business losses cannot be carried forward from a late return.", papers: false, mca: false, source: "rule",
    });
    if (c.p.flags.sft) {
      out.push({
        ruleId: "sft", period: label, form: fy >= 2026 ? "SFT" : "Form 61A", title: `Statement of specified financial transactions for ${taxYearLabel(fy)}`, authority: "Income Tax", dueOn: `${fy + 1}-05-31`,
        why: "Reports large cash receipts, share issues and other specified transactions.", documents: [], portal: PORTALS.it, amountPaise: null,
        late: { kind: "per-day", perDayPaise: 500_00, capPaise: null, flatPaise: 0 }, lateNote: "₹500 a day.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
    if (c.p.flags.foreignInvestment) {
      out.push({
        ruleId: "fla", period: label, form: "FLA return", title: `Foreign liabilities and assets return for FY ${label}`, authority: "RBI", dueOn: `${fy + 1}-07-15`,
        why: "Every company with foreign investment reports it to the RBI each year.", documents: ["Audited or provisional accounts", "Shareholding pattern"], portal: { name: "RBI FLAIR portal", url: "https://flair.rbi.org.in" },
        amountPaise: null, late: { kind: "none" }, lateNote: "A late return is a contravention of FEMA, settled by compounding.", risk: "Late submission fee or compounding under FEMA.", papers: false, mca: false, source: "rule",
      });
    }
  }
  return out;
}

/** When the AGM for a year's accounts was, or will be. */
export function agmDate(c: Ctx, fy: number): { on: string; held: boolean } {
  const label = fyLabel(fy);
  const held = c.p.agms.find((a) => a.fy === label);
  if (held) return { on: held.heldOn, held: true };
  if (c.p.plannedAgmOn && fyOf(c.p.plannedAgmOn) === fy + 1) return { on: c.p.plannedAgmOn, held: false };
  return { on: agmDue(c, fy), held: false };
}

function agmDue(c: Ctx, fy: number): string {
  if (c.p.incorporatedOn && fyOf(c.p.incorporatedOn) === fy) return `${fy + 1}-12-31`;
  return `${fy + 1}-09-30`;
}

/** DIR-3 KYC: once every three financial years, by 30 June. */
export function kycDue(d: Director, asOf: string): string {
  if (!d.kycDoneOn) return `${Math.max(2028, fyOf(asOf) + 1)}-06-30`;
  return `${fyOf(d.kycDoneOn) + 3}-06-30`;
}

function mcaRules(c: Ctx): RawItem[] {
  const out: RawItem[] = [];
  const fee = normalFeePaise(c.p);
  const multiple: Late = { kind: "mca-multiple", feePaise: fee };
  const multNote = "The normal fee plus additional fees: 1 times for up to 15 days late, 2 for 16–30, 4 for 31–60, 6 for 61–90, 10 for 91–180 and 12 beyond.";
  const STRIKE = "Two years of missed financial statements or annual returns disqualify every director for five years (section 164(2)), and the ROC can strike the company off (section 248).";
  const small = c.small === true;
  for (const fy of fys(c)) {
    if (c.p.incorporatedOn && `${fy + 1}-03-31` < c.p.incorporatedOn) continue;
    const label = fyLabel(fy);
    const agm = agmDate(c, fy);
    out.push({
      ruleId: "agm", period: label, form: "AGM", title: `Annual general meeting to adopt the accounts for FY ${label}`, authority: "MCA", dueOn: agmDue(c, fy),
      why: "Within six months of the year end (nine for the first AGM), and no more than fifteen months after the last one. The board approves the accounts and the auditor signs first.",
      documents: ["Audited financial statements", "Board's report", "Notice of the AGM (21 clear days)"], portal: PORTALS.board, amountPaise: null, late: { kind: "none" },
      lateNote: "Fine of up to ₹1 lakh on the company and every officer in default, and ₹5,000 for each day it continues.", risk: "The ROC can be asked to call the meeting; every filing after it is late too.",
      papers: false, mca: false, source: "rule", filed: agm.held ? { on: agm.on, ack: "" } : null,
    });
    const xbrl = xbrlApplies(c.books, c.p);
    out.push({
      ruleId: "aoc4", period: label, form: xbrl ? "AOC-4 XBRL" : "AOC-4", title: `Financial statements for FY ${label} to the ROC`, authority: "MCA", dueOn: addDays(agm.on, 30),
      why: `Within 30 days of the AGM${agm.held ? "" : " (worked out from the AGM date you plan)"}.${xbrl ? " In XBRL, because paid-up capital is ₹5 crore or more or turnover ₹100 crore or more." : ""} It also carries the company's intimation about books kept online (rule 3(6)).`,
      documents: ["Signed financial statements and auditor's report", "Board's report with annexures", "AOC-2 for related-party contracts", "List of shareholders' and directors' details as needed"],
      portal: PORTALS.mca, amountPaise: null, late: { kind: "per-day", perDayPaise: 100_00, capPaise: null, flatPaise: 0 }, lateNote: "₹100 a day additional fee, with no cap.",
      risk: STRIKE, papers: true, mca: true, source: "rule",
    });
    if (csrApplies(c.books, c.p)) {
      out.push({
        ruleId: "csr2", period: label, form: "CSR-2", title: `CSR report for FY ${label}`, authority: "MCA", dueOn: addDays(agm.on, 30),
        why: "Companies under section 135 report their CSR spending on a separate form after AOC-4.", documents: ["CSR policy", "Spending details and impact assessment if needed"], portal: PORTALS.mca,
        amountPaise: null, late: multiple, lateNote: multNote, risk: null, papers: false, mca: true, source: "rule",
      });
    }
    out.push({
      ruleId: "mgt7", period: label, form: small ? "MGT-7A" : "MGT-7", title: `Annual return for FY ${label}`, authority: "MCA", dueOn: addDays(agm.on, 60),
      why: `Within 60 days of the AGM.${small ? " Small companies file the shorter MGT-7A." : ""}${mgt8Applies(c.books, c.p) ? " A practising company secretary certifies it in MGT-8, because paid-up capital is ₹10 crore or more or turnover ₹50 crore or more." : ""}`,
      documents: ["List of shareholders and transfers", "Board and general meetings held with attendance", "Directors' remuneration", ...(mgt8Applies(c.books, c.p) ? ["MGT-8 from a practising company secretary"] : [])],
      portal: PORTALS.mca, amountPaise: null, late: { kind: "per-day", perDayPaise: 100_00, capPaise: null, flatPaise: 0 }, lateNote: "₹100 a day additional fee, with no cap.",
      risk: STRIKE, papers: true, mca: true, source: "rule",
    });
    if (c.p.auditorTermEndsFy === label || (!c.p.auditorTermEndsFy && c.p.incorporatedOn && fyOf(c.p.incorporatedOn) === fy)) {
      out.push({
        ruleId: "adt1", period: label, form: "ADT-1", title: `Auditor appointment at the AGM for FY ${label}`, authority: "MCA", dueOn: addDays(agm.on, 15),
        why: "The AGM appoints the auditor for five years; the company tells the ROC within 15 days.", documents: ["Auditor's consent and eligibility certificate", "Resolution appointing the auditor"],
        portal: PORTALS.mca, amountPaise: null, late: multiple, lateNote: multNote, risk: null, papers: false, mca: true, source: "rule",
      });
    }
    const yearEnd = `${fy + 1}-03-31`;
    const loans = c.p.loans.filter((x) => x.takenOn <= yearEnd && (!x.closedOn || x.closedOn > yearEnd));
    if (loans.length) {
      out.push({
        ruleId: "dpt3", period: label, form: "DPT-3", title: `Return of money borrowed, as at 31 March ${fy + 1}`, authority: "MCA", dueOn: `${fy + 1}-06-30`,
        why: "Every company reports loans and advances outstanding at the year end that are not deposits: from directors, shareholders, other companies and banks.",
        documents: ["Loan statements as at 31 March", "Directors' declarations that their loans are not from borrowed funds", "Auditor's certificate if any deposits"],
        portal: PORTALS.mca, amountPaise: loans.reduce((a, x) => a + x.amountPaise, 0), late: multiple, lateNote: multNote,
        risk: "Penalty of ₹5,000 plus ₹500 a day on the company and officers.", papers: true, mca: true, source: "rule",
      });
    }
    if (c.p.directors.length) {
      const first = c.p.boardMeetings.filter((d) => d >= `${fy}-04-01` && d <= yearEnd).sort()[0];
      out.push({
        ruleId: "mbp1-dir8", period: label, form: "MBP-1 and DIR-8", title: `Directors' interests and non-disqualification declarations for FY ${label}`, authority: "MCA",
        dueOn: first ?? `${fy}-06-30`,
        why: "At the first board meeting of each year every director discloses their interests (MBP-1) and confirms they are not disqualified (DIR-8). They are kept with the minutes, not filed.",
        documents: ["MBP-1 from each director", "DIR-8 from each director"], portal: PORTALS.board, amountPaise: null, late: { kind: "flat", paise: 1_00_000_00 },
        lateNote: "A director who does not disclose an interest can be fined up to ₹1 lakh.", risk: null, papers: false, mca: false, source: "rule",
        filed: first && first <= c.asOf ? { on: first, ack: "" } : null,
      });
    }
    if (!small && c.p.flags.demat) {
      for (const [period, due, what] of [[`${label}-H1`, `${fy}-11-29`, "April to September"], [`${label}-H2`, `${fy + 1}-05-30`, "October to March"]] as const) {
        out.push({
          ruleId: "pas6", period, form: "PAS-6", title: `Reconciliation of share capital, ${what}`, authority: "MCA", dueOn: due,
          why: "A private company that is not small and whose shares are in demat files a half-yearly reconciliation, certified by a CA or CS.", documents: ["RTA's reconciliation", "Depository statements"],
          portal: PORTALS.mca, amountPaise: null, late: multiple, lateNote: multNote, risk: null, papers: false, mca: true, source: "rule",
        });
      }
    }
    const msme = msmeHalfYears(c, fy);
    for (const h of msme) {
      out.push({
        ruleId: "msme1", period: h.period, form: "MSME-1", title: `Dues to micro and small suppliers, ${h.label}`, authority: "MCA", dueOn: h.dueOn,
        why: "Companies that owe micro or small suppliers for more than 45 days report each amount and the reason for the delay, half-yearly.",
        documents: ["Suppliers' Udyam numbers", "Bills unpaid beyond 45 days with the reason"], portal: PORTALS.mca, amountPaise: h.amountPaise,
        late: { kind: "per-day", perDayPaise: 1_000_00, capPaise: 2_80_000_00, flatPaise: 20_000_00 }, lateNote: "Penalty of ₹20,000 plus ₹1,000 a day, up to ₹3 lakh, on the company and on officers.",
        risk: null, papers: true, mca: true, source: "rule",
      });
    }
  }
  for (const d of c.p.directors) {
    if (d.dscExpiresOn) {
      out.push({
        ruleId: "dsc", period: d.din || d.id, form: "DSC renewal", title: `Renew ${d.name}'s digital signature certificate`, authority: "MCA", dueOn: d.dscExpiresOn,
        why: `${d.name}'s DSC expires on this date. Renew it at least a week before an MCA, GST or income-tax filing that needs their signature, then associate the new one with their MCA login.`,
        documents: ["PAN and Aadhaar of the director", "Video verification with the certifying authority"], portal: { name: "A licensed certifying authority", url: "https://cca.gov.in" }, amountPaise: null,
        late: { kind: "none" }, lateNote: "No fee, but nothing can be signed until it is renewed.", risk: d.mcaSigner ? "This director signs MCA forms; filings will wait until the DSC is renewed." : null, papers: false, mca: false, source: "rule",
      });
    }
    out.push({
      ruleId: "dir3kyc", period: d.din || d.id, form: "DIR-3 KYC", title: `DIR-3 KYC for ${d.name}`, authority: "MCA", dueOn: kycDue(d, c.asOf),
      why: `From 31 March 2026 every director confirms their KYC once every three financial years, by 30 June.${d.kycDoneOn ? "" : " Add when it was last done so the date is exact."}`,
      documents: ["The director's PAN, Aadhaar-linked mobile and email", "The director's own DSC"], portal: PORTALS.mca, amountPaise: null,
      late: { kind: "flat", paise: 5_000_00 }, lateNote: "The DIN is deactivated; ₹5,000 to reactivate it.", risk: "A deactivated director cannot sign any MCA form.", papers: false, mca: true, source: "rule",
    });
  }
  const bm = boardMeetingDue(c);
  if (bm) out.push(bm);
  if (c.p.incorporatedOn && c.p.incorporatedOn >= "2019-11-02") {
    out.push({
      ruleId: "inc20a", period: "once", form: "INC-20A", title: "Declaration that business has commenced", authority: "MCA", dueOn: addDays(c.p.incorporatedOn, 180),
      why: "Within 180 days of incorporation, confirming every subscriber has paid for their shares.", documents: ["Bank statement showing share money received"], portal: PORTALS.mca,
      amountPaise: null, late: multiple, lateNote: multNote, risk: "Penalty of ₹50,000 on the company, and the ROC can strike it off (section 248).", papers: false, mca: true, source: "rule",
    });
  }
  return out;
}

/** The next board meeting due: within 120 days of the last, or one each half-year for a small company. */
function boardMeetingDue(c: Ctx): RawItem | null {
  if (!c.p.directors.length) return null;
  const held = [...c.p.boardMeetings].filter((d) => d <= c.asOf).sort();
  const last = held.at(-1) ?? null;
  const base = {
    ruleId: "board-meeting", form: "Board meeting", authority: "MCA", documents: ["Agenda and notes sent seven days ahead", "Draft minutes of the last meeting"], portal: PORTALS.board,
    amountPaise: null, late: { kind: "none" } as Late, lateNote: "Each officer in default can be fined ₹25,000.", risk: null, papers: false, mca: false, source: "rule" as const,
  };
  if (c.small) {
    const fy = fyOf(c.asOf);
    const firstHalf = c.asOf <= `${fy}-09-30`;
    const start = firstHalf ? `${fy}-04-01` : `${fy}-10-01`;
    const end = firstHalf ? `${fy}-09-30` : `${fy + 1}-03-31`;
    if (held.some((d) => d >= start)) return null;
    return {
      ...base, period: `${fyLabel(fy)}-${firstHalf ? "H1" : "H2"}`, title: `Board meeting for ${firstHalf ? "April to September" : "October to March"}`, dueOn: end,
      why: "A small company holds at least one board meeting in each half of the year, at least 90 days apart.",
    };
  }
  const due = last ? addDays(last, 120) : addDays(c.asOf, 30);
  return {
    ...base, period: last ? `after-${last}` : "first", title: "Next board meeting", dueOn: due,
    why: `At least four board meetings a year, with no more than 120 days between two of them.${last ? ` The last was on ${last}.` : " Add the dates of past meetings for an exact date."}`,
  };
}

/** MSME-1's half-years: those where a micro or small supplier was owed beyond 45 days. */
function msmeHalfYears(c: Ctx, fy: number): { period: string; label: string; dueOn: string; amountPaise: number | null }[] {
  const msme = c.books.parties.filter((p) => p.kind === "vendor" && msmeProtected(p));
  if (!msme.length) return [];
  const ids = new Set(msme.map((p) => p.id));
  const halves = [
    { period: `${fyLabel(fy)}-H1`, label: "April to September", start: `${fy}-04-01`, end: `${fy}-09-30`, dueOn: `${fy}-10-31` },
    { period: `${fyLabel(fy)}-H2`, label: "October to March", start: `${fy}-10-01`, end: `${fy + 1}-03-31`, dueOn: `${fy + 1}-04-30` },
  ];
  return halves.flatMap((h) => {
    if (h.start > c.asOf) return [{ ...h, amountPaise: null }];
    let amount = 0;
    for (const b of c.books.bills) {
      if (b.status !== "posted" || !ids.has(b.partyId)) continue;
      const late = addDays(b.date, 45);
      const settled = billPaidOn(c.l, b) ?? "9999-12-31";
      if (late < h.end && late <= c.asOf && settled > late && settled >= h.start) amount += b.totals.totalPaise - (b.tds?.amountPaise ?? 0);
    }
    return amount > 0 || h.end >= c.asOf ? [{ ...h, amountPaise: amount || null }] : [];
  });
}

const PT_DUE: Record<string, (period: string) => string> = {
  "27": (p) => monthEnd(nextMonth(p)),
  "29": (p) => `${nextMonth(p)}-20`,
  "36": (p) => `${nextMonth(p)}-10`,
  "37": (p) => `${nextMonth(p)}-10`,
  "24": (p) => `${nextMonth(p)}-15`,
  "19": (p) => `${nextMonth(p)}-21`,
};

function labourRules(c: Ctx): RawItem[] {
  const out: RawItem[] = [];
  const staff = c.books.employees.length;
  if (!staff) return out;
  const pf = c.p.pf ?? staff >= 20;
  const esi = c.p.esi ?? staff >= 10;
  const ptState = c.p.ptState || c.books.business.stateCode;
  for (const m of months(c)) {
    const lines = isPast(c, m) ? payrollFor(c.l, m) : null;
    const sum = (f: (x: ReturnType<typeof payrollFor>[number]) => number) => (lines ? lines.reduce((a, x) => a + f(x), 0) : null);
    const next = nextMonth(m);
    if (pf) {
      const amount = sum((x) => x.pfEmployeePaise + x.pfEmployerPaise);
      out.push({
        ruleId: "pf", period: m, form: "PF ECR", title: `Provident fund for ${monthLabel(m)}`, authority: "EPFO", dueOn: `${next}-15`,
        why: "Employee and employer PF contributions for the month's wages, by electronic challan-cum-return.", documents: ["Payroll for the month", "Employees' UANs"], portal: PORTALS.epfo,
        amountPaise: amount, late: { kind: "interest", pctMonth: 1, basePaise: amount ?? 0, minMonths: 1 }, lateNote: "Interest at 12% a year plus damages of 5% to 25% a year.",
        risk: "Employees' share deducted and not paid is an offence, and the employer loses the deduction for it.", papers: false, mca: false, source: "rule",
      });
    }
    if (esi) {
      const amount = sum((x) => x.esiEmployeePaise + x.esiEmployerPaise);
      if (amount !== 0) {
        out.push({
          ruleId: "esi", period: m, form: "ESI", title: `ESI for ${monthLabel(m)}`, authority: "ESIC", dueOn: `${next}-15`,
          why: "ESI contributions for employees earning up to ₹21,000 a month.", documents: ["Payroll for the month"], portal: PORTALS.esic, amountPaise: amount,
          late: { kind: "interest", pctMonth: 1, basePaise: amount ?? 0, minMonths: 1 }, lateNote: "Interest at 12% a year plus damages.", risk: null, papers: false, mca: false, source: "rule",
        });
      }
    }
    const ptDue = PT_DUE[ptState];
    if (ptDue) {
      const amount = sum((x) => x.ptPaise);
      out.push({
        ruleId: "pt", period: m, form: "Professional tax", title: `Professional tax for ${monthLabel(m)}`, authority: "State", dueOn: ptDue(m),
        why: "Professional tax deducted from salaries, paid to the state with its return.", documents: ["Payroll for the month"], portal: PORTALS.pt, amountPaise: amount,
        late: { kind: "interest", pctMonth: 1.25, basePaise: amount ?? 0, minMonths: 1 }, lateNote: "Interest at 1.25% a month, and a late return fee.", risk: null, papers: false, mca: false, source: "rule",
      });
    }
  }
  return out;
}

/** ROC filings that a change in the company starts the clock on. */
export function eventItems(c: Ctx): RawItem[] {
  const fee = normalFeePaise(c.p);
  const multiple: Late = { kind: "mca-multiple", feePaise: fee };
  const multNote = "The normal fee plus additional fees that rise with the delay: 1 times for up to 15 days, 2 for 16–30, 4 for 31–60, 6 for 61–90, 10 for 91–180 and 12 beyond.";
  const out: RawItem[] = [];
  const mk = (e: (typeof c.p.events)[number], form: string, title: string, days: number, why: string, documents: string[], extra: Partial<RawItem> = {}): RawItem => ({
    ruleId: `event-${form.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, period: e.id, form, title, authority: form === "FC-GPR" ? "RBI" : "MCA", dueOn: addDays(e.on, days),
    why: `${why} ${e.detail}`.trim(), documents, portal: form === "FC-GPR" ? PORTALS.firms : PORTALS.mca, amountPaise: null, late: multiple, lateNote: multNote, risk: null, papers: false, mca: form !== "FC-GPR", source: "event", ...extra,
  });
  for (const e of c.p.events) {
    switch (e.kind) {
      case "director_joined":
        out.push(mk(e, "DIR-12", "Tell the ROC about the new director", 30, "Within 30 days of the appointment.", ["DIR-2 consent from the director", "Board resolution", "DIR-8 declaration"]));
        break;
      case "director_left":
        out.push(mk(e, "DIR-12", "Tell the ROC a director has left", 30, "Within 30 days of the resignation or removal.", ["Resignation letter", "Proof it was sent and received"]));
        break;
      case "director_contact_changed":
        out.push(mk(e, "DIR-6", "Update a director's details with the MCA", 30, "A director's change of name, address or contact details.", ["Proof of the change"]));
        break;
      case "office_moved":
        out.push(mk(e, "INC-22", "Tell the ROC about the new registered office", 30, "Within 30 days of the move. A move to another ROC's area or another state needs a special resolution and the ROC's or Regional Director's approval first.", ["Proof of the new address", "Owner's NOC or rent agreement", "A recent utility bill"]));
        break;
      case "authorised_capital_changed":
        out.push(mk(e, "SH-7", "Tell the ROC about the change in authorised capital", 30, "Within 30 days of the shareholders' resolution, with stamp duty by state.", ["Shareholders' resolution", "Altered memorandum and articles"]));
        break;
      case "shares_allotted":
        out.push(mk(e, "PAS-3", "Return of allotment of shares", e.privatePlacement ? 15 : 30, e.privatePlacement ? "Within 15 days of a private placement allotment." : "Within 30 days of the allotment.", ["Board resolution for the allotment", "List of allottees", "Valuation report if needed"]));
        if (e.foreign) out.push(mk(e, "FC-GPR", "Report the foreign allotment to the RBI", 30, "Shares issued to someone outside India are reported on FIRMS within 30 days of the allotment.", ["FIRC and KYC of the investor", "Valuation certificate", "CS certificate"], { late: { kind: "none" }, lateNote: "Late submission fee under FEMA." }));
        break;
      case "charge_created":
        out.push(mk(e, "CHG-1", "Register the charge with the ROC", 30, "Within 30 days of creating it. Late, the fee rises; after 60 days an ad valorem fee on the amount secured applies.", ["Loan or hypothecation agreement", "Sanction letter"], { risk: "An unregistered charge is void against a liquidator and other creditors." }));
        break;
      case "charge_satisfied":
        out.push(mk(e, "CHG-4", "Tell the ROC the charge is satisfied", 30, "Within 30 days of repaying the loan, so the charge comes off the company's record.", ["No-dues letter from the lender"]));
        break;
      case "special_resolution":
        out.push(mk(e, "MGT-14", "File the resolution with the ROC", 30, "Special resolutions, and certain board resolutions, go to the ROC within 30 days.", ["Certified copy of the resolution", "Explanatory statement"]));
        break;
      case "ben1_received":
        out.push(mk(e, "BEN-2", "Report the significant beneficial owner", 30, "Within 30 days of receiving BEN-1 from a significant beneficial owner.", ["BEN-1 declaration"]));
        break;
      case "auditor_resigned":
        out.push(mk(e, "ADT-3", "Auditor's resignation to the ROC", 30, "The outgoing auditor files ADT-3 within 30 days; chase them for it.", ["Resignation letter"]));
        out.push(mk(e, "ADT-1", "Appoint an auditor to the casual vacancy", 45, "The board fills the vacancy within 30 days (shareholders approve within three months) and ADT-1 goes within 15 days of the appointment.", ["New auditor's consent and eligibility certificate", "Board resolution"]));
        break;
    }
  }
  return out;
}

export function allRules(c: Ctx): RawItem[] {
  return [...gstRules(c), ...tdsRules(c), ...incomeTaxRules(c), ...mcaRules(c), ...labourRules(c), ...eventItems(c)];
}

export function ctxFor(books: Books, l: Ledger, p: ComplianceProfile, asOf: string): Ctx {
  const from = p.calendarFrom ?? addDays(asOf, -45);
  return { books, l, p, asOf, from, to: addDays(asOf, 366), small: smallCompany(books, p).value, turnoverPaise: books.business.prevYearTurnoverPaise };
}