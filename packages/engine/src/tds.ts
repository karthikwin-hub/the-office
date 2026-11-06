import type { Bill, Party, TdsSection } from "@office/contracts";
import { quarterOf } from "./dates";
import type { Ledger } from "./ledger";
import { bpOf } from "./money";

type Rule = {
  nature: string;
  /** rate in basis points for the payee's entity type */
  rateBp: (payee: Party) => number;
  rateLabel: string;
  /** threshold in paise; "annual" thresholds apply to the financial-year total for the payee */
  threshold: { kind: "annual" | "monthly" | "annual-excess"; paise: number };
};

/**
 * Deduction rules as amended by the Finance Act 2025. The books keep the 1961 Act's section as
 * the key; `tdsRef` gives the Income-tax Act 2025 reference and payment code for anything paid
 * or credited from 1 April 2026.
 */
export const TDS_RULES: Record<TdsSection, Rule> = {
  "194C": {
    nature: "Payments to contractors",
    rateBp: (p) => (p.entity === "individual" ? 100 : 200),
    rateLabel: "1% individuals, 2% others",
    threshold: { kind: "annual", paise: 1_00_000_00 },
  },
  "194J": {
    nature: "Fees for professional services",
    rateBp: () => 1000,
    rateLabel: "10%",
    threshold: { kind: "annual", paise: 50_000_00 },
  },
  "194H": {
    nature: "Commission or brokerage",
    rateBp: () => 200,
    rateLabel: "2%",
    threshold: { kind: "annual", paise: 20_000_00 },
  },
  "194I": {
    nature: "Rent of land or building",
    rateBp: () => 1000,
    rateLabel: "10%",
    threshold: { kind: "monthly", paise: 50_000_00 },
  },
  "194Q": {
    nature: "Purchase of goods",
    rateBp: () => 10,
    rateLabel: "0.1% above ₹50 lakh",
    threshold: { kind: "annual-excess", paise: 50_00_000_00 },
  },
};

/** The day the Income-tax Act 2025 took over from the 1961 Act. */
export const NEW_ACT_FROM = "2026-04-01";

/** Section 393's table entry and the payment code the TDS challan and Form 140 ask for. */
export const NEW_ACT: Record<TdsSection, { ref: string; code: (payee?: Pick<Party, "entity">) => string; codes: string }> = {
  "194C": { ref: "393(1) Sl. 6(i)", code: (p) => (p?.entity === "individual" ? "1023" : "1024"), codes: "1023 (individuals and HUFs), 1024 (others)" },
  "194H": { ref: "393(1) Sl. 1(ii)", code: () => "1006", codes: "1006" },
  "194I": { ref: "393(1) Sl. 2(ii)", code: () => "1009", codes: "1009" },
  "194J": { ref: "393(1) Sl. 6(iii)", code: () => "1027", codes: "1027" },
  "194Q": { ref: "393(1) Sl. 8(ii)", code: () => "1031", codes: "1031" },
};

/** How a deduction is cited on a given date: the 1961 section before 1 April 2026, section 393 and its code after. */
export function tdsRef(section: TdsSection, onDate: string, payee?: Pick<Party, "entity">): { reference: string; code: string; label: string } {
  if (onDate < NEW_ACT_FROM) return { reference: section, code: "", label: `section ${section}` };
  const n = NEW_ACT[section];
  const code = payee ? n.code(payee) : n.codes;
  return { reference: n.ref, code, label: `section ${n.ref} (code ${code}, formerly ${section})` };
}

/** Reads a section as a return cites it: "194J", "393(1) Sl. 6(iii)" or the payment code "1027". */
export function sectionFromCited(text: string): TdsSection | null {
  const t = text.replace(/\s+/g, " ").trim();
  const old = /(19\d[A-Z])\b/.exec(t);
  if (old && old[1]! in TDS_RULES) return old[1] as TdsSection;
  for (const [section, n] of Object.entries(NEW_ACT) as [TdsSection, (typeof NEW_ACT)[TdsSection]][]) {
    if (t.replace(/\s/g, "").toLowerCase().includes(n.ref.replace(/\s/g, "").toLowerCase())) return section;
    if (n.codes.split(/\D+/).filter(Boolean).some((c) => new RegExp(`(^|\\D)${c}(\\D|$)`).test(t))) return section;
  }
  return null;
}

/** The first day of a quarter like "FY2026-27-Q2". */
function quarterStart(quarter: string): string {
  const fy = Number(quarter.slice(2, 6));
  const q = Number(quarter.slice(-1));
  return [`${fy}-04-01`, `${fy}-07-01`, `${fy}-10-01`, `${fy + 1}-01-01`][q - 1]!;
}

/** The quarterly return for deductions other than salary: Form 140 from tax year 2026-27, 26Q before. */
export function tdsReturnForm(quarter: string): "Form 140" | "26Q" {
  return quarterStart(quarter) >= NEW_ACT_FROM ? "Form 140" : "26Q";
}

/** "tax year 2026-27" under the new Act, "FY 2025-26" before it. `fyStart` is the year the period begins in. */
export function taxYearLabel(fyStart: number): string {
  const span = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
  return fyStart >= 2026 ? `tax year ${span}` : `FY ${span}`;
}

export const SECTION_NOTE =
  "From 1 April 2026 the Income-tax Act 2025 applies: deductions are made under section 393 and each payment carries a code on the challan and the return, and the quarterly return is Form 140 (formerly 26Q). Anything paid or credited up to 31 March 2026 keeps its 1961 Act section and is reported on 26Q.";

/** 194Q applies only to buyers whose turnover exceeded ₹10 crore in the previous year */
export const SECTION_194Q_TURNOVER = 10_00_00_000_00;

function fyOf(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return String(m >= 4 ? y : y - 1);
}

export type ExpectedTds = { section: TdsSection; rateBp: number; basePaise: number; amountPaise: number };

/**
 * What should have been deducted on each bill, from the rules alone.
 * Bills are processed in date order so FY thresholds accumulate correctly.
 */
export function expectedTdsByBill(l: Ledger): Map<string, ExpectedTds | null> {
  const out = new Map<string, ExpectedTds | null>();
  const bills = [...l.books.bills].filter((b) => b.status !== "rejected" && !b.opening).sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  const fyTotals = new Map<string, number>();
  for (const b of bills) {
    const k = `${b.partyId}|${fyOf(b.date)}`;
    fyTotals.set(k, (fyTotals.get(k) ?? 0) + b.totals.taxablePaise);
  }
  const running = new Map<string, number>();
  for (const b of bills) {
    const vendor = l.party(b.partyId);
    const section = vendor.tdsSection;
    if (!section) {
      out.set(b.id, null);
      continue;
    }
    if (section === "194Q" && l.books.business.prevYearTurnoverPaise <= SECTION_194Q_TURNOVER) {
      out.set(b.id, null);
      continue;
    }
    const rule = TDS_RULES[section];
    const rateBp = rule.rateBp(vendor);
    const key = `${b.partyId}|${fyOf(b.date)}`;
    const base = b.totals.taxablePaise;
    if (rule.threshold.kind === "annual-excess") {
      const before = running.get(key) ?? 0;
      const after = before + base;
      running.set(key, after);
      const over = Math.min(base, Math.max(0, after - rule.threshold.paise));
      out.set(b.id, over > 0 ? { section, rateBp, basePaise: over, amountPaise: bpOf(over, rateBp) } : null);
    } else if (rule.threshold.kind === "monthly") {
      out.set(b.id, base > rule.threshold.paise ? { section, rateBp, basePaise: base, amountPaise: bpOf(base, rateBp) } : null);
    } else {
      // A recurring contract expected to cross the annual limit is deducted from the first bill.
      const fyTotal = fyTotals.get(key) ?? 0;
      out.set(b.id, fyTotal > rule.threshold.paise ? { section, rateBp, basePaise: base, amountPaise: bpOf(base, rateBp) } : null);
    }
  }
  return out;
}

/** TDS our 194Q customers should deduct from our invoices (we are the seller). */
export function expectedCustomerTds(l: Ledger): Map<string, number> {
  const out = new Map<string, number>();
  const running = new Map<string, number>();
  for (const inv of l.books.invoices.filter((i) => i.status === "posted" && !i.opening).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))) {
    const party = l.party(inv.partyId);
    if (!party.tan) continue;
    const key = `${party.id}|${fyOf(inv.date)}`;
    const after = (running.get(key) ?? 0) + inv.totals.taxablePaise;
    running.set(key, after);
    const over = Math.min(inv.totals.taxablePaise, Math.max(0, after - TDS_RULES["194Q"].threshold.paise));
    if (over > 0) out.set(inv.id, bpOf(over, 10));
  }
  return out;
}

export function billQuarter(b: Bill): string {
  return quarterOf(b.date);
}

/** TDS deposit due date: 7th of the following month (30 April for March deductions). */
export function tdsDepositDue(deductionDate: string): string {
  const [y, m] = deductionDate.split("-").map(Number) as [number, number];
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-07`;
}

/** The quarterly return's due date (Form 140, and 26Q before it): 31 July, 31 October, 31 January and 31 May. */
export function tdsReturnDue(quarter: string): string {
  const fy = Number(quarter.slice(2, 6));
  const q = Number(quarter.slice(-1));
  return [`${fy}-07-31`, `${fy}-10-31`, `${fy + 1}-01-31`, `${fy + 1}-05-31`][q - 1]!;
}
