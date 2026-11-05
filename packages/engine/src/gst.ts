import type { Bill, Gstr1, Gstr3b, Invoice, Line, Totals } from "@office/contracts";
import { dateLabel, monthKey } from "./dates";
import type { Ledger } from "./ledger";
import { lineTaxable, pctOf, r2, roundToRupee } from "./money";

export type TaxSplit = { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };

const zero = (): TaxSplit => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });

function add(into: TaxSplit, t: TaxSplit): TaxSplit {
  into.taxablePaise += t.taxablePaise;
  into.cgstPaise += t.cgstPaise;
  into.sgstPaise += t.sgstPaise;
  into.igstPaise += t.igstPaise;
  return into;
}

/** Recompute a line's tax from quantity, rate and place of supply. */
export function computeLine(
  input: Pick<Line, "qty" | "ratePaise" | "discountPct" | "gstRate">,
  intraState: boolean,
): Pick<Line, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise"> {
  const taxablePaise = lineTaxable(input.qty, input.ratePaise, input.discountPct);
  if (intraState) {
    const half = pctOf(taxablePaise, input.gstRate * 50);
    return { taxablePaise, cgstPaise: half, sgstPaise: half, igstPaise: 0 };
  }
  return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: pctOf(taxablePaise, input.gstRate * 100) };
}

export function computeTotals(lines: Pick<Line, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise">[]): Totals {
  const t = lines.reduce((acc, l) => add(acc, l), zero());
  const gross = t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise;
  const totalPaise = roundToRupee(gross);
  return { ...t, roundOffPaise: totalPaise - gross, totalPaise };
}

/** Intra-state supply when the place of supply is the supplier's own state (IGST Act, s.10 for goods). */
export function isIntraState(supplierState: string, placeOfSupply: string): boolean {
  return supplierState === placeOfSupply;
}

export type InvoiceCheck = { invoiceId: string; field: string; printed: number; computed: number };

/** Verify every printed figure on an invoice against a fresh computation. */
export function checkInvoice(inv: Invoice, supplierState: string): InvoiceCheck[] {
  const intra = isIntraState(supplierState, inv.placeOfSupply);
  const issues: InvoiceCheck[] = [];
  const fresh = inv.lines.map((l, i) => {
    const c = computeLine(l, intra);
    for (const k of ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise"] as const)
      if (c[k] !== l[k]) issues.push({ invoiceId: inv.id, field: `line.${i}.${k}`, printed: l[k], computed: c[k] });
    return c;
  });
  const totals = computeTotals(fresh);
  for (const k of Object.keys(totals) as (keyof Totals)[])
    if (totals[k] !== inv.totals[k]) issues.push({ invoiceId: inv.id, field: `totals.${k}`, printed: inv.totals[k], computed: totals[k] });
  return issues;
}

function inPeriod(iso: string, period: string): boolean {
  return monthKey(iso) === period;
}

function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function fp(period: string): string {
  const [y, m] = period.split("-");
  return `${m}${y}`;
}

/** GSTR-1 in the GST portal's offline-tool JSON shape (B2B and HSN tables). */
export function computeGstr1(l: Ledger, period: string): Gstr1 {
  const rows = new Map<string, Gstr1["b2b"][number]["inv"]>();
  const hsn = new Map<string, { hsn: string; uqc: string; rt: number; desc: string; qty: number } & TaxSplit>();
  for (const inv of l.salesInvoices.filter((i) => inPeriod(i.date, period))) {
    const party = l.party(inv.partyId);
    const byRate = new Map<number, TaxSplit>();
    for (const line of inv.lines) {
      add(byRate.get(line.gstRate) ?? byRate.set(line.gstRate, zero()).get(line.gstRate)!, line);
      const key = `${line.hsn}|${line.unit}|${String(line.gstRate).padStart(3, "0")}`;
      const h = hsn.get(key) ?? { hsn: line.hsn, uqc: line.unit, rt: line.gstRate, desc: line.skuId ? l.sku(line.skuId).category : line.description, qty: 0, ...zero() };
      h.qty += line.qty;
      add(h, line);
      hsn.set(key, h);
    }
    const list = rows.get(party.gstin!) ?? [];
    list.push({
      inum: inv.number,
      idt: ddmmyyyy(inv.date),
      val: r2(inv.totals.totalPaise),
      pos: inv.placeOfSupply,
      rchrg: inv.reverseCharge ? "Y" : "N",
      inv_typ: "R",
      itms: [...byRate.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([rt, v]) => ({
          num: rt * 100 + 1,
          itm_det: { rt, txval: r2(v.taxablePaise), iamt: r2(v.igstPaise), camt: r2(v.cgstPaise), samt: r2(v.sgstPaise), csamt: 0 },
        })),
    });
    rows.set(party.gstin!, list);
  }
  return {
    gstin: l.books.business.gstin,
    fp: fp(period),
    b2b: [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ctin, inv]) => ({ ctin, inv })),
    hsn: {
      data: [...hsn.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([, v], i) => ({
          num: i + 1,
          hsn_sc: v.hsn,
          desc: v.desc,
          uqc: v.uqc,
          qty: v.qty,
          rt: v.rt,
          txval: r2(v.taxablePaise),
          iamt: r2(v.igstPaise),
          camt: r2(v.cgstPaise),
          samt: r2(v.sgstPaise),
          csamt: 0,
        })),
    },
  };
}

export function outwardFor(l: Ledger, period: string): TaxSplit & { invoices: Invoice[] } {
  const invoices = l.salesInvoices.filter((i) => inPeriod(i.date, period));
  const t = invoices.reduce((acc, i) => add(acc, i.totals), zero());
  return { ...t, invoices };
}

export type ItcResult = {
  books: TaxSplit;
  eligible: TaxSplit;
  bills: Bill[];
  eligibleBills: Bill[];
  notIn2b: Bill[];
  has2b: boolean;
};

/**
 * Input tax credit for a month. Credit is only eligible when the supplier has
 * reported the invoice in GSTR-2B (CGST Act s.16(2)(aa)); without a 2B statement
 * the books figure is shown as provisional.
 */
export function itcFor(l: Ledger, period: string): ItcResult {
  const bills = l.postedBills.filter((b) => inPeriod(b.date, period) && b.itcEligible);
  const statement = l.books.gstr2b.find((g) => g.period === period);
  const reported = new Set(statement?.data.docdata.b2b.map((e) => `${e.ctin}|${e.inum}`) ?? []);
  const eligibleBills: Bill[] = [];
  const notIn2b: Bill[] = [];
  for (const b of bills) {
    const gstin = l.party(b.partyId).gstin;
    if (!statement || reported.has(`${gstin}|${b.number}`)) eligibleBills.push(b);
    else notIn2b.push(b);
  }
  return {
    books: bills.reduce((acc, b) => add(acc, b.totals), zero()),
    eligible: eligibleBills.reduce((acc, b) => add(acc, b.totals), zero()),
    bills,
    eligibleBills,
    notIn2b,
    has2b: Boolean(statement),
  };
}

export function computeGstr3b(l: Ledger, period: string): Gstr3b {
  const out = outwardFor(l, period);
  const itc = itcFor(l, period).eligible;
  return {
    gstin: l.books.business.gstin,
    ret_period: fp(period),
    sup_details: { osup_det: { txval: r2(out.taxablePaise), iamt: r2(out.igstPaise), camt: r2(out.cgstPaise), samt: r2(out.sgstPaise), csamt: 0 } },
    itc_elg: { itc_avl: [{ ty: "OTH", iamt: r2(itc.igstPaise), camt: r2(itc.cgstPaise), samt: r2(itc.sgstPaise), csamt: 0 }] },
  };
}

/**
 * Set off input tax credit against output tax (CGST Act s.49 and rule 88A):
 * IGST credit first against IGST, then CGST and SGST; CGST credit against CGST
 * then IGST; SGST credit against SGST then IGST. CGST and SGST never cross.
 */
export function setOff(output: TaxSplit, credit: TaxSplit) {
  const due = { i: output.igstPaise, c: output.cgstPaise, s: output.sgstPaise };
  const cr = { i: credit.igstPaise, c: credit.cgstPaise, s: credit.sgstPaise };
  const use = (from: keyof typeof cr, to: keyof typeof due) => {
    const n = Math.min(cr[from], due[to]);
    cr[from] -= n;
    due[to] -= n;
  };
  use("i", "i");
  use("i", "c");
  use("i", "s");
  use("c", "c");
  use("c", "i");
  use("s", "s");
  use("s", "i");
  return {
    payable: { igstPaise: due.i, cgstPaise: due.c, sgstPaise: due.s, totalPaise: due.i + due.c + due.s },
    carriedForward: { igstPaise: cr.i, cgstPaise: cr.c, sgstPaise: cr.s },
  };
}

export function gstDueDates(period: string): { gstr1: string; gstr3b: string } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const base = `${ny}-${String(nm).padStart(2, "0")}`;
  return { gstr1: `${base}-11`, gstr3b: `${base}-20` };
}

export function describeBill(b: Bill, vendorName: string): string {
  return `${b.number} from ${vendorName}, ${dateLabel(b.date)}`;
}
