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
 * Deduction rules for FY 2026-27 as amended by the Finance Act 2025.
 * Section numbers follow the Income-tax Act, 1961. From 1 April 2026 the
 * Income-tax Act, 2025 consolidates these deductions under section 393; confirm
 * the new references with your chartered accountant before filing.
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

export const SECTION_NOTE =
  "Section numbers follow the Income-tax Act, 1961. The Income-tax Act, 2025 consolidates these deductions under section 393 from 1 April 2026; confirm the new references with your chartered accountant.";

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

/** Quarterly statement due dates for 26Q */
export function tds26qDue(quarter: string): string {
  const fy = Number(quarter.slice(2, 6));
  const q = Number(quarter.slice(-1));
  return [`${fy}-07-31`, `${fy}-10-31`, `${fy + 1}-01-31`, `${fy + 1}-05-31`][q - 1]!;
}
