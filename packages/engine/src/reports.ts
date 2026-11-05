import type { CashReport, GstReport, SalesReport, TdsReport } from "@office/contracts";
import { paymentBehaviour, openInvoices } from "./ageing";
import { addDays, dateLabel, monthKey, monthLabel, nextMonth, quarterLabel, quarterMonths, quarterOf, weekStart } from "./dates";
import { gstDueDates, itcFor, outwardFor, setOff } from "./gst";
import type { Ledger } from "./ledger";
import { inrShort } from "./money";
import { expectedCustomerTds, expectedTdsByBill, SECTION_NOTE, TDS_RULES, tdsDepositDue } from "./tds";

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function salesReport(l: Ledger, from?: string, to?: string): SalesReport {
  const start = from ?? l.books.business.fyStart;
  const end = to ?? l.asOf;
  const invoices = l.invoicesIn(start, end);
  const bySku = new Map<string, { qty: number; taxable: number; cost: number; invoices: Set<string> }>();
  const byCustomer = new Map<string, { taxable: number; invoices: number }>();
  const byMonth = new Map<string, number>();
  let tax = 0;
  for (const inv of invoices) {
    tax += inv.totals.cgstPaise + inv.totals.sgstPaise + inv.totals.igstPaise;
    const c = byCustomer.get(inv.partyId) ?? { taxable: 0, invoices: 0 };
    c.taxable += inv.totals.taxablePaise;
    c.invoices += 1;
    byCustomer.set(inv.partyId, c);
    byMonth.set(monthKey(inv.date), (byMonth.get(monthKey(inv.date)) ?? 0) + inv.totals.taxablePaise);
    for (const line of inv.lines) {
      if (!line.skuId) continue;
      const s = bySku.get(line.skuId) ?? { qty: 0, taxable: 0, cost: 0, invoices: new Set() };
      s.qty += line.qty;
      s.taxable += line.taxablePaise;
      s.cost += line.qty * l.sku(line.skuId).costPaise;
      s.invoices.add(inv.id);
      bySku.set(line.skuId, s);
    }
  }
  const total = invoices.reduce((a, i) => a + i.totals.taxablePaise, 0);
  const margin = [...bySku.values()].reduce((a, s) => a + s.taxable - s.cost, 0);
  let running = 0;
  const skuRows = [...bySku.entries()]
    .sort((a, b) => b[1].taxable - a[1].taxable)
    .map(([skuId, s]) => {
      running += s.taxable;
      const sku = l.sku(skuId);
      return {
        skuId,
        name: sku.name,
        category: sku.category,
        hsn: sku.hsn,
        unit: sku.unit,
        qty: s.qty,
        invoices: s.invoices.size,
        taxablePaise: s.taxable,
        marginPaise: s.taxable - s.cost,
        marginPct: pct(s.taxable - s.cost, s.taxable),
        sharePct: pct(s.taxable, total),
        cumulativePct: pct(running, total),
        figureId: `sales:sku:${skuId}:${start}:${end}`,
      };
    });
  const top80 = skuRows.findIndex((r) => r.cumulativePct >= 80) + 1;
  const months = [...byMonth.keys()].sort();
  const lastFull = months.filter((m) => m < monthKey(l.asOf)).at(-1);
  const prev = lastFull ? months[months.indexOf(lastFull) - 1] : undefined;
  const topCustomer = [...byCustomer.entries()].sort((a, b) => b[1].taxable - a[1].taxable)[0];
  const note: SalesReport["note"] = [
    { text: `Sales from ${dateLabel(start)} to ${dateLabel(end)} were ` },
    { text: inrShort(total), figureId: `sales:total:${start}:${end}` },
    { text: ` before GST, across ${invoices.length} invoices to ${byCustomer.size} customers, at a gross margin of ${pct(margin, total)}%. ` },
  ];
  if (lastFull && prev) {
    const change = pct(byMonth.get(lastFull)! - byMonth.get(prev)!, byMonth.get(prev)!);
    note.push({ text: `${monthLabel(lastFull, "long").split(" ")[0]} brought in ` }, { text: inrShort(byMonth.get(lastFull)!), figureId: `sales:month:${lastFull}` }, { text: `, ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% on the month before. ` });
  }
  if (top80 > 0) note.push({ text: `${top80} of ${skuRows.length} SKUs make up 80% of sales` });
  if (topCustomer) note.push({ text: `, and the largest customer is ${l.party(topCustomer[0]).name} at ` }, { text: inrShort(topCustomer[1].taxable), figureId: `sales:party:${topCustomer[0]}:${start}:${end}` }, { text: "." });
  return {
    from: start,
    to: end,
    note,
    totals: { taxablePaise: total, taxPaise: tax, invoices: invoices.length, customers: byCustomer.size, marginPaise: margin },
    bySku: skuRows,
    byCustomer: [...byCustomer.entries()]
      .sort((a, b) => b[1].taxable - a[1].taxable)
      .map(([partyId, c]) => ({ partyId, name: l.party(partyId).name, city: l.party(partyId).city, invoices: c.invoices, taxablePaise: c.taxable, sharePct: pct(c.taxable, total), figureId: `sales:party:${partyId}:${start}:${end}` })),
    byMonth: months.map((m) => ({ month: m, taxablePaise: byMonth.get(m)!, figureId: `sales:month:${m}` })),
  };
}

export function gstPeriods(l: Ledger): string[] {
  const out: string[] = [];
  for (let p = monthKey(l.books.business.fyStart); p <= monthKey(l.asOf); p = nextMonth(p)) out.push(p);
  return out.reverse();
}

export function gstReport(l: Ledger, period?: string): GstReport {
  const periods = gstPeriods(l);
  const p = period ?? periods.find((x) => x < monthKey(l.asOf)) ?? periods[0]!;
  const out = outwardFor(l, p);
  const itc = itcFor(l, p);
  const so = setOff(out, itc.eligible);
  const byRate = new Map<number, { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }>();
  const hsn = new Map<string, { hsn: string; description: string; uqc: string; qty: number; rate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }>();
  for (const inv of out.invoices)
    for (const line of inv.lines) {
      const r = byRate.get(line.gstRate) ?? { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
      r.taxablePaise += line.taxablePaise;
      r.cgstPaise += line.cgstPaise;
      r.sgstPaise += line.sgstPaise;
      r.igstPaise += line.igstPaise;
      byRate.set(line.gstRate, r);
      const key = `${line.hsn}|${line.unit}|${line.gstRate}`;
      const h = hsn.get(key) ?? { hsn: line.hsn, description: line.skuId ? l.sku(line.skuId).category : line.description, uqc: line.unit, qty: 0, rate: line.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
      h.qty += line.qty;
      h.taxablePaise += line.taxablePaise;
      h.cgstPaise += line.cgstPaise;
      h.sgstPaise += line.sgstPaise;
      h.igstPaise += line.igstPaise;
      hsn.set(key, h);
    }
  const due = gstDueDates(p);
  const filings = (["GSTR-1", "GSTR-3B"] as const).map((form) => {
    const r = l.books.filedReturns.find((x) => x.form === form && x.period === p);
    return { form, period: p, status: r ? r.status : ("not_started" as const), dueOn: form === "GSTR-1" ? due.gstr1 : due.gstr3b, filedOn: r?.filedOn ?? null };
  });
  const outputTax = out.cgstPaise + out.sgstPaise + out.igstPaise;
  const eligibleTax = itc.eligible.cgstPaise + itc.eligible.sgstPaise + itc.eligible.igstPaise;
  const notIn2bTax = itc.notIn2b.reduce((a, b) => a + b.totals.cgstPaise + b.totals.sgstPaise + b.totals.igstPaise, 0);
  return {
    period: p,
    note: [
      { text: `In ${monthLabel(p)} the business charged ` },
      { text: inrShort(outputTax), figureId: `gst:outward:${p}` },
      { text: ` of GST on ${out.invoices.length} invoices and can claim ` },
      { text: inrShort(eligibleTax), figureId: `gst:itc-eligible:${p}` },
      { text: ` of input credit${itc.has2b ? " that suppliers have reported in GSTR-2B" : " (provisional until GSTR-2B is available)"}. ` },
      ...(notIn2bTax
        ? [{ text: "A further " }, { text: inrShort(notIn2bTax), figureId: `gst:itc-missing:${p}`, tone: "red" as const }, { text: " in the books is not yet in GSTR-2B. " }]
        : []),
      { text: "Cash payable after set-off is " },
      { text: inrShort(so.payable.totalPaise), figureId: `gst:payable:${p}` },
      { text: `, due with GSTR-3B by ${dateLabel(due.gstr3b)}.` },
    ],
    outward: { taxablePaise: out.taxablePaise, cgstPaise: out.cgstPaise, sgstPaise: out.sgstPaise, igstPaise: out.igstPaise, invoices: out.invoices.length, figureId: `gst:outward:${p}` },
    byRate: [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) => ({ rate, ...v })),
    hsn: [...hsn.values()].sort((a, b) => b.taxablePaise - a.taxablePaise),
    itc: {
      books: { ...itc.books, figureId: `gst:itc:${p}` },
      eligible: { ...itc.eligible, figureId: `gst:itc-eligible:${p}` },
      notIn2b: itc.notIn2b.map((b) => ({ billId: b.id, number: b.number, vendor: l.party(b.partyId).name, date: b.date, taxPaise: b.totals.cgstPaise + b.totals.sgstPaise + b.totals.igstPaise, docId: b.docId })),
    },
    payable: so.payable,
    filings,
    periods,
  };
}

export function tdsQuarters(l: Ledger): string[] {
  const qs = new Set<string>();
  for (let p = monthKey(l.books.business.fyStart); p <= monthKey(l.asOf); p = nextMonth(p)) qs.add(quarterOf(`${p}-01`));
  return [...qs].reverse();
}

export function tdsReport(l: Ledger, quarter?: string): TdsReport {
  const quarters = tdsQuarters(l);
  const q = quarter ?? quarters[0]!;
  const months = new Set(quarterMonths(q));
  const expected = expectedTdsByBill(l);
  const filed = l.books.filedReturns.find((r) => r.form === "26Q" && r.period === q);
  const filedByBill = filed && filed.form === "26Q" ? new Map(filed.data.deductions.map((d) => [d.billId, d.tdsPaise])) : null;
  const deductions: TdsReport["deductions"] = [];
  for (const b of l.books.bills) {
    if (!months.has(b.date.slice(0, 7)) || b.status === "rejected") continue;
    const e = expected.get(b.id);
    if (!e && !b.tds) continue;
    const vendor = l.party(b.partyId);
    deductions.push({
      billId: b.id,
      docId: b.docId,
      vendor: vendor.name,
      pan: vendor.pan,
      section: e?.section ?? b.tds!.section,
      date: b.date,
      basePaise: e?.basePaise ?? b.tds!.basePaise,
      expectedPaise: e?.amountPaise ?? 0,
      bookedPaise: b.tds?.amountPaise ?? 0,
      filedPaise: filedByBill ? (filedByBill.get(b.id) ?? 0) : null,
      ruleRateBp: e?.rateBp ?? 0,
      bookedRateBp: b.tds?.rateBp ?? 0,
    });
  }
  const bySection = new Map<string, { deductees: Set<string>; base: number; tds: number }>();
  for (const d of deductions) {
    const s = bySection.get(d.section) ?? { deductees: new Set(), base: 0, tds: 0 };
    s.deductees.add(d.pan);
    s.base += d.basePaise;
    s.tds += d.expectedPaise;
    bySection.set(d.section, s);
  }
  const expectedCustomer = expectedCustomerTds(l);
  const credited = new Map(l.books.form26as.map((c) => [c.invoiceId, c.tdsCreditedPaise]));
  const receivable: TdsReport["receivable"] = [];
  for (const [invoiceId, amount] of expectedCustomer) {
    const inv = l.invoice(invoiceId)!;
    if (!months.has(inv.date.slice(0, 7)) || !l.settled(invoiceId).tds) continue;
    receivable.push({ invoiceId, number: inv.number, customer: l.party(inv.partyId).name, expectedPaise: amount, creditedPaise: credited.get(invoiceId) ?? 0, docId: inv.docId });
  }
  const totalExpected = deductions.reduce((a, d) => a + d.expectedPaise, 0);
  const totalBooked = deductions.reduce((a, d) => a + d.bookedPaise, 0);
  const short = totalExpected - totalBooked;
  return {
    quarter: q,
    quarters,
    note: [
      { text: `For ${quarterLabel(q)} the rules call for ` },
      { text: inrShort(totalExpected), figureId: `tds:total:${q}` },
      { text: ` of TDS on ${deductions.length} bills. ` },
      ...(short > 100
        ? [{ text: "The books deducted " }, { text: inrShort(short), figureId: `tds:short:${q}`, tone: "red" as const }, { text: " less than the rules require. " }]
        : [{ text: "The books match the rules. " }]),
      { text: filed ? `The 26Q return was filed on ${dateLabel(filed.filedOn ?? filed.dueOn)}.` : "The 26Q return for this quarter is not due yet." },
    ],
    bySection: [...bySection.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([section, s]) => ({ section, nature: TDS_RULES[section as keyof typeof TDS_RULES].nature, rate: TDS_RULES[section as keyof typeof TDS_RULES].rateLabel, deductees: s.deductees.size, basePaise: s.base, tdsPaise: s.tds, figureId: `tds:section:${section}:${q}` })),
    deductions,
    receivable,
    sectionNote: SECTION_NOTE,
  };
}

export function cashReport(l: Ledger): CashReport {
  const months = new Map<string, { in: number; out: number }>();
  for (const p of l.books.payments) {
    if (p.date > l.asOf) continue;
    const m = months.get(monthKey(p.date)) ?? { in: 0, out: 0 };
    if (p.direction === "in") m.in += p.amountPaise;
    else m.out += p.amountPaise;
    months.set(monthKey(p.date), m);
  }
  const start = weekStart(l.asOf);
  const weeks = [0, 1, 2, 3].map((i) => ({ weekOf: addDays(start, i * 7), items: [] as CashReport["weeks"][number]["items"] }));
  const place = (date: string, item: CashReport["weeks"][number]["items"][number]) => {
    const d = date < l.asOf ? l.asOf : date;
    const w = weeks.find((x) => d >= x.weekOf && d < addDays(x.weekOf, 7));
    if (w) w.items.push({ ...item, date: d });
  };
  const late = new Map<string, number>();
  for (const o of openInvoices(l)) {
    if (!late.has(o.partyId)) late.set(o.partyId, Math.max(0, paymentBehaviour(l, o.partyId).avgDaysLate ?? 0));
    const expected = addDays(o.dueDate, late.get(o.partyId)!);
    if (o.bucket >= 4) continue; // over 90 days: not counted on
    place(expected, { label: `${o.partyName}, ${o.number}`, amountPaise: o.outstandingPaise, direction: "in", date: expected });
  }
  for (const b of l.books.bills) {
    if (l.vendorBillPaid(b.id) || b.status === "rejected") continue;
    const tds = b.tds?.amountPaise ?? 0;
    place(addDays(b.date, 30), { label: `${l.party(b.partyId).name}, ${b.number}`, amountPaise: b.totals.totalPaise - tds, direction: "out", date: addDays(b.date, 30) });
  }
  const lastMonth = gstPeriods(l).find((x) => x < monthKey(l.asOf))!;
  const out = outwardFor(l, lastMonth);
  const gst = setOff(out, itcFor(l, lastMonth).eligible).payable.totalPaise;
  place(gstDueDates(lastMonth).gstr3b, { label: `GST for ${monthLabel(lastMonth)} (GSTR-3B)`, amountPaise: gst, direction: "out", date: gstDueDates(lastMonth).gstr3b });
  const tdsDue = [...expectedTdsByBill(l).entries()].filter(([id, e]) => e && l.bill(id)!.date.startsWith(lastMonth)).reduce((a, [, e]) => a + (e?.amountPaise ?? 0), 0);
  place(tdsDepositDue(`${lastMonth}-15`), { label: `TDS deducted in ${monthLabel(lastMonth)}`, amountPaise: tdsDue, direction: "out", date: tdsDepositDue(`${lastMonth}-15`) });
  const salaries = l.books.employees.reduce((a, e) => a + e.monthlyGrossPaise, 0);
  place(`${nextMonth(monthKey(l.asOf))}-01`, { label: "Salaries for the month", amountPaise: salaries, direction: "out", date: `${nextMonth(monthKey(l.asOf))}-01` });
  const result = weeks.map((w) => ({
    weekOf: w.weekOf,
    expectedInPaise: w.items.filter((i) => i.direction === "in").reduce((a, i) => a + i.amountPaise, 0),
    expectedOutPaise: w.items.filter((i) => i.direction === "out").reduce((a, i) => a + i.amountPaise, 0),
    items: w.items.sort((a, b) => b.amountPaise - a.amountPaise),
  }));
  const inTotal = result.reduce((a, w) => a + w.expectedInPaise, 0);
  const outTotal = result.reduce((a, w) => a + w.expectedOutPaise, 0);
  const tightest = [...result].sort((a, b) => a.expectedInPaise - a.expectedOutPaise - (b.expectedInPaise - b.expectedOutPaise))[0]!;
  return {
    asOf: l.asOf,
    note: [
      { text: "Over the next four weeks the books expect " },
      { text: inrShort(inTotal), figureId: "cash:in" },
      { text: " from customers and " },
      { text: inrShort(outTotal), figureId: "cash:out" },
      { text: ` of payments, including GST, TDS and salaries. The tightest week starts ${dateLabel(tightest.weekOf)}, when payments exceed receipts by ` },
      tightest.expectedOutPaise > tightest.expectedInPaise
        ? { text: inrShort(tightest.expectedOutPaise - tightest.expectedInPaise), figureId: `cash:week:${tightest.weekOf}`, tone: "red" as const }
        : { text: "nothing", figureId: `cash:week:${tightest.weekOf}` },
      { text: "." },
    ],
    months: [...months.entries()].sort().map(([month, v]) => ({ month, receiptsPaise: v.in, paymentsPaise: v.out, netPaise: v.in - v.out })),
    weeks: result,
    assumptions: [
      "Each customer pays as late as their average on past invoices.",
      "Invoices more than 90 days overdue are left out of expected receipts.",
      "Supplier bills are paid 30 days after the bill date, net of TDS.",
      "Salaries are paid on the 1st at gross; deductions are not yet netted off.",
      "Opening bank balance is not connected yet, so this shows movements only.",
    ],
  };
}

export { quarterLabel };
