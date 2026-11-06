import type { Trace, TraceRow } from "@office/contracts";
import { AGEING_BUCKETS } from "@office/contracts";
import { auditAll } from "./audit";
import { openInvoices } from "./ageing";
import { addDays, dateLabel, monthKey, monthLabel, quarterLabel, quarterMonths } from "./dates";
import { itcFor, outwardFor } from "./gst";
import type { Ledger } from "./ledger";
import { cashReport } from "./reports";
import { expectedTdsByBill } from "./tds";
import { performance, socialInvoices } from "./social/metrics";
import { marketingReport, operationsReport, payrollFor } from "./teams";
import { complianceView } from "./compliance";

const sum = (rows: TraceRow[]) => rows.reduce((a, r) => a + r.amountPaise, 0);

function invoiceRows(l: Ledger, invoices: ReturnType<Ledger["invoicesIn"]>, field: "taxable" | "total" | "tax" = "taxable"): TraceRow[] {
  return invoices.map((inv) => ({
    label: inv.number,
    detail: l.party(inv.partyId).name,
    date: inv.date,
    amountPaise: field === "taxable" ? inv.totals.taxablePaise : field === "total" ? inv.totals.totalPaise : inv.totals.cgstPaise + inv.totals.sgstPaise + inv.totals.igstPaise,
    docId: inv.docId,
    region: field === "taxable" ? "totals.taxable" : field === "total" ? "totals.total" : inv.totals.igstPaise ? "totals.igst" : "totals.cgst",
  }));
}

/**
 * Resolve a figure id (as placed on every number in the UI) into the records
 * that make it up, each linked to the page region it was read from.
 */
export function trace(l: Ledger, figureId: string): Trace {
  const parts = figureId.split(":");
  const [kind, sub] = parts;
  const build = (title: string, rows: TraceRow[], total?: number): Trace => ({ figureId, title, rows, totalPaise: total ?? sum(rows) });

  if (kind === "sales") {
    if (sub === "sku") {
      const [, , skuId, from, to] = parts as [string, string, string, string, string];
      const rows: TraceRow[] = [];
      for (const inv of l.invoicesIn(from, to))
        inv.lines.forEach((line, i) => {
          if (line.skuId === skuId)
            rows.push({ label: inv.number, detail: `${l.party(inv.partyId).name}: ${line.qty} ${line.unit}`, date: inv.date, amountPaise: line.taxablePaise, docId: inv.docId, region: `line.${i}.taxable` });
        });
      return build(`${l.sku(skuId).name}: taxable sales, ${dateLabel(from)} to ${dateLabel(to)}`, rows);
    }
    if (sub === "party") {
      const [, , partyId, from, to] = parts as [string, string, string, string, string];
      return build(`Sales to ${l.party(partyId).name}`, invoiceRows(l, l.invoicesIn(from, to).filter((i) => i.partyId === partyId)));
    }
    if (sub === "month") {
      const m = parts[2]!;
      return build(`Sales in ${monthLabel(m)}`, invoiceRows(l, l.salesInvoices.filter((i) => monthKey(i.date) === m)));
    }
    if (sub === "total") return build(`Sales, ${dateLabel(parts[2]!)} to ${dateLabel(parts[3]!)}`, invoiceRows(l, l.invoicesIn(parts[2]!, parts[3]!)));
  }

  if (kind === "ageing") {
    const open = openInvoices(l);
    const rows = (list: typeof open): TraceRow[] =>
      list.map((o) => ({ label: o.number, detail: `${o.partyName}: ${o.daysOverdue > 0 ? `${o.daysOverdue} days overdue` : `due ${dateLabel(o.dueDate)}`}`, date: o.date, amountPaise: o.outstandingPaise, docId: o.docId, region: "dueDate" }));
    if (sub === "bucket") return build(`Outstanding: ${AGEING_BUCKETS[Number(parts[2])]!.toLowerCase()}`, rows(open.filter((o) => o.bucket === Number(parts[2]))));
    if (sub === "party") return build(`Outstanding from ${l.party(parts[2]!).name}`, rows(open.filter((o) => o.partyId === parts[2])));
    if (sub === "overdue") return build("Overdue invoices", rows(open.filter((o) => o.bucket > 0)));
    if (sub === "over60") return build("Invoices more than 60 days overdue", rows(open.filter((o) => o.bucket >= 3)));
    return build("All outstanding invoices", rows(open));
  }

  if (kind === "gst") {
    const period = parts[2]!;
    if (sub === "outward") return build(`Output GST, ${monthLabel(period)}`, invoiceRows(l, outwardFor(l, period).invoices, "tax"));
    if (sub === "payable") return build(`Output GST, ${monthLabel(period)} (before credit)`, invoiceRows(l, outwardFor(l, period).invoices, "tax"));
    const itc = itcFor(l, period);
    const bills = sub === "itc-eligible" ? itc.eligibleBills : sub === "itc-missing" ? itc.notIn2b : itc.bills;
    return build(
      sub === "itc-missing" ? `Credit in the books but not in GSTR-2B, ${monthLabel(period)}` : `Input tax credit, ${monthLabel(period)}`,
      bills.map((b) => ({ label: b.number, detail: l.party(b.partyId).name, date: b.date, amountPaise: b.totals.cgstPaise + b.totals.sgstPaise + b.totals.igstPaise, docId: b.docId, region: b.totals.igstPaise ? "totals.igst" : "totals.cgst" })),
    );
  }

  if (kind === "tds") {
    const quarter = parts.at(-1)!;
    const months = new Set(quarterMonths(quarter));
    const expected = expectedTdsByBill(l);
    const rows: TraceRow[] = [];
    for (const b of l.books.bills) {
      const e = expected.get(b.id);
      if (!e || !months.has(b.date.slice(0, 7))) continue;
      if (sub === "section" && e.section !== parts[2]) continue;
      const booked = b.tds?.amountPaise ?? 0;
      if (sub === "short" && booked >= e.amountPaise) continue;
      rows.push({ label: b.number, detail: `${l.party(b.partyId).name}, section ${e.section}`, date: b.date, amountPaise: sub === "short" ? e.amountPaise - booked : e.amountPaise, docId: b.docId, region: "totals.taxable" });
    }
    return build(sub === "short" ? `TDS short-deducted, ${quarterLabel(quarter)}` : sub === "section" ? `TDS under ${parts[2]}, ${quarterLabel(quarter)}` : `TDS, ${quarterLabel(quarter)}`, rows);
  }

  if (kind === "cash") {
    const report = cashReport(l);
    const items = report.weeks.flatMap((w) => w.items.map((i) => ({ ...i, weekOf: w.weekOf })));
    const pick = sub === "week" ? items.filter((i) => i.weekOf === parts.slice(2).join(":")) : items.filter((i) => i.direction === sub);
    return build(sub === "week" ? `Expected cash, week of ${dateLabel(parts.slice(2).join(":"))}` : sub === "in" ? "Expected receipts" : "Expected payments", pick.map((i) => ({ label: i.label, detail: i.direction === "in" ? "Receipt" : "Payment", date: i.date, amountPaise: i.direction === "in" ? i.amountPaise : -i.amountPaise, docId: null, region: null })));
  }

  if (kind === "audit") {
    const period = parts[2]!;
    const findings = auditAll(l).findings.filter((f) => f.period === period);
    return build(
      `Differences found, ${period.startsWith("FY") ? quarterLabel(period) : monthLabel(period)}`,
      findings.map((f) => {
        const doc = f.evidence.find((e) => e.ref.kind === "document");
        return { label: f.form, detail: f.title, date: l.asOf, amountPaise: f.impactPaise, docId: doc?.ref.id ?? null, region: doc?.ref.region ?? null };
      }),
    );
  }

  if (kind === "pipeline") {
    const open = l.books.leads.filter((x) => !["won", "lost"].includes(x.stage));
    return build("Open leads", open.map((x) => ({ label: x.name, detail: `${x.stage}, ${x.source}`, date: x.createdOn, amountPaise: x.valuePaise, docId: null, region: null })));
  }

  if (kind === "marketing") {
    return build("Slow-moving stock at cost", marketingReport(l).slowMovers.map((s) => ({ label: s.name, detail: `${s.onHand} on hand, ${s.soldLast60} sold in 60 days`, date: l.asOf, amountPaise: s.stockValuePaise, docId: null, region: null })));
  }

  if (kind === "compliance" && sub === "at-risk") {
    const v = complianceView(l.books, l.asOf);
    const rows: TraceRow[] = [
      ...v.obligations
        .filter((o) => o.lateCostPaise && (o.state === "late" || (o.state !== "filed" && o.state !== "snoozed" && o.daysLeft <= 7)))
        .map((o) => ({ label: o.form, detail: o.state === "late" ? `${o.title}: ${-o.daysLeft} days late. ${o.lateCostNote}` : `${o.title}: a week's delay. ${o.lateCostNote}`, date: o.dueOn, amountPaise: o.lateCostPaise, docId: null, region: null })),
      ...v.checks.filter((c) => c.tone === "red" && c.amountPaise).map((c) => ({ label: c.title, detail: c.summary, date: l.asOf, amountPaise: c.amountPaise, docId: null, region: null })),
    ];
    return build("At risk from late filings and the checks on the books", rows);
  }

  if (kind === "operations") {
    return build("Excess stock at cost", operationsReport(l).stock.filter((s) => s.status === "excess").map((s) => ({ label: s.name, detail: `${s.onHand} ${s.unit} on hand`, date: l.asOf, amountPaise: s.stockValuePaise, docId: null, region: null })));
  }

  if (kind === "social") {
    const f = performance(l).funnel;
    const quotes = l.books.quotes.filter((q) => q.leadId && f.leadIds.includes(q.leadId) && q.partyId);
    const rows = f.partyIds.flatMap((pid) => invoiceRows(l, socialInvoices(l, pid, quotes), "total"));
    return build("Invoiced to customers who came from social media, since they first got in touch", rows);
  }

  if (kind === "sku") {
    const sku = l.sku(sub!);
    const st = l.books.stock.find((s) => s.skuId === sku.id);
    return build(`${sku.name}: price list${st ? ` and stock (${st.onHand} ${sku.unit} on hand at ${st.location})` : ""}`, [
      { label: "Price before GST", detail: `${sku.gstRate}% GST, HSN ${sku.hsn}`, date: l.asOf, amountPaise: sku.pricePaise, docId: null, region: null },
      { label: "Price with GST", detail: "As written in posts", date: l.asOf, amountPaise: Math.round((sku.pricePaise * (100 + sku.gstRate)) / 100 / 100) * 100, docId: null, region: null },
    ], sku.pricePaise);
  }

  if (kind === "payroll") {
    const period = parts[2]!;
    const lines = payrollFor(l, period);
    return build(
      sub === "net" ? `Net pay, ${monthLabel(period)}` : `PF and ESI, ${monthLabel(period)}`,
      lines.map((x) => ({ label: x.name, detail: x.role, date: `${period}-01`, amountPaise: sub === "net" ? x.netPaise : x.pfEmployeePaise + x.pfEmployerPaise + x.esiEmployeePaise + x.esiEmployerPaise, docId: null, region: null })),
    );
  }

  return build("Figure not recognised", []);
}

export function upcomingWindow(l: Ledger, days: number) {
  return { from: l.asOf, to: addDays(l.asOf, days) };
}
