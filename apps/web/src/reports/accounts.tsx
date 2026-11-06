import * as Plot from "@observablehq/plot";
import type { AgeingReport, AgeingRow, CashReport, GstReport, OpenInvoice, SalesReport, SkuSalesRow, TdsDeduction, TdsReport } from "@office/contracts";
import { inrShort, monthLabel, quarterLabel } from "@office/engine";
import { AgeingBuckets, Amount, CoveringNote, LedgerTable, Stamp, useFigures, type LedgerColumn } from "@office/ui";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { download, exportUrl } from "../api/client";
import { longDate, quantity, Section, shortDate } from "../screens/common";
import { Chart, INK } from "./Chart";

const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

/* ---------- Sales ---------- */

export function SalesView({ report }: { report: SalesReport }) {
  const [by, setBy] = useState<"sku" | "customer">("sku");
  const months = useMemo(
    () =>
      ({
        x: { label: null, tickFormat: (m: string) => monthLabel(m, "short").split(" ")[0] },
        y: { label: "Taxable sales", tickFormat: (v: number) => inrShort(v).replace("₹", ""), grid: true },
        marks: [Plot.barY(report.byMonth, { x: "month", y: "taxablePaise", fill: INK.carbon, inset: 6 }), Plot.ruleY([0], { stroke: INK.graphite })],
      }) satisfies Plot.PlotOptions,
    [report.byMonth],
  );
  const skuCols: LedgerColumn<SkuSalesRow>[] = [
    { id: "name", header: "SKU", cell: (r) => r.name, sortBy: (r) => r.name },
    { id: "category", header: "Category", cell: (r) => r.category, secondary: true, sortBy: (r) => r.category },
    { id: "hsn", header: "HSN", cell: (r) => r.hsn, secondary: true },
    { id: "qty", header: "Quantity", cell: (r) => quantity(r.qty, r.unit), sortBy: (r) => r.qty, numeric: true, secondary: true },
    { id: "taxable", header: "Taxable value", cell: (r) => <Amount paise={r.taxablePaise} figureId={r.figureId} rupees label={r.name} />, sortBy: (r) => r.taxablePaise, numeric: true, footer: <Amount paise={report.totals.taxablePaise} figureId={`sales:total:${report.from}:${report.to}`} rupees /> },
    { id: "margin", header: "Margin", cell: (r) => `${r.marginPct.toFixed(1)}%`, sortBy: (r) => r.marginPct, numeric: true },
    { id: "share", header: "Share", cell: (r) => `${r.sharePct.toFixed(1)}%`, sortBy: (r) => r.sharePct, numeric: true, secondary: true },
  ];
  type Cust = SalesReport["byCustomer"][number];
  const custCols: LedgerColumn<Cust>[] = [
    { id: "name", header: "Customer", cell: (r) => <Link to="/parties/$partyId" params={{ partyId: r.partyId }}>{r.name}</Link>, sortBy: (r) => r.name },
    { id: "city", header: "City", cell: (r) => r.city, secondary: true },
    { id: "inv", header: "Invoices", cell: (r) => r.invoices, sortBy: (r) => r.invoices, numeric: true },
    { id: "taxable", header: "Taxable value", cell: (r) => <Amount paise={r.taxablePaise} figureId={r.figureId} rupees label={r.name} />, sortBy: (r) => r.taxablePaise, numeric: true, footer: <Amount paise={report.totals.taxablePaise} rupees /> },
    { id: "share", header: "Share", cell: (r) => `${r.sharePct.toFixed(1)}%`, sortBy: (r) => r.sharePct, numeric: true },
  ];
  return (
    <>
      <CoveringNote note={report.note} from="From the Accountant" />
      <Section title="Sales by month">
        <Chart options={months} label="Taxable sales by month this financial year" />
        <ul className="inline-figures">
          {report.byMonth.map((m) => (
            <li key={m.month}>
              <span className="muted">{monthLabel(m.month, "short")}</span> <Amount paise={m.taxablePaise} figureId={m.figureId} short label={monthLabel(m.month)} />
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={`Sales from ${longDate(report.from)} to ${longDate(report.to)}`}
        aside={
          <div className="segmented" role="group" aria-label="Group sales by">
            <button type="button" aria-pressed={by === "sku"} onClick={() => setBy("sku")}>
              By SKU
            </button>
            <button type="button" aria-pressed={by === "customer"} onClick={() => setBy("customer")}>
              By customer
            </button>
          </div>
        }
      >
        {by === "sku" ? (
          <LedgerTable caption="Sales by SKU" rows={report.bySku} columns={skuCols} rowKey={(r) => r.skuId} initialSort={{ id: "taxable", desc: true }} limit={15} />
        ) : (
          <LedgerTable caption="Sales by customer" rows={report.byCustomer} columns={custCols} rowKey={(r) => r.partyId} initialSort={{ id: "taxable", desc: true }} limit={15} />
        )}
      </Section>
    </>
  );
}

/* ---------- Ageing ---------- */

export function AgeingView({ report, compact }: { report: AgeingReport; compact?: boolean }) {
  const cols: LedgerColumn<AgeingRow>[] = [
    { id: "name", header: "Customer", cell: (r) => <Link to="/parties/$partyId" params={{ partyId: r.partyId }}>{r.name}</Link>, sortBy: (r) => r.name },
    ...[0, 1, 2, 3, 4].map(
      (i): LedgerColumn<AgeingRow> => ({
        id: `b${i}`,
        header: ["Not yet due", "1 to 30", "31 to 60", "61 to 90", "Over 90"][i]!,
        cell: (r) => (r.buckets[i] ? <Amount paise={r.buckets[i]!} rupees tone={i >= 3 ? "red" : undefined} /> : null),
        sortBy: (r) => r.buckets[i]!,
        numeric: true,
        secondary: i > 0 && i < 3,
        footer: <Amount paise={report.bucketTotals[i]!} figureId={report.bucketFigureIds[i]} rupees />,
      }),
    ),
    { id: "total", header: "Total owed", cell: (r) => <Amount paise={r.totalPaise} figureId={r.figureId} rupees label={r.name} />, sortBy: (r) => r.totalPaise, numeric: true, footer: <Amount paise={report.totalPaise} figureId="ageing:total" rupees /> },
    { id: "late", header: "Pays late by", cell: (r) => (r.avgDaysLate === null ? "" : r.avgDaysLate <= 0 ? "On time" : `${Math.round(r.avgDaysLate)} days`), sortBy: (r) => r.avgDaysLate ?? -99, numeric: true, secondary: true },
  ];
  const overdue = report.open.filter((o) => o.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue);
  const invCols: LedgerColumn<OpenInvoice>[] = [
    { id: "number", header: "Invoice", cell: (r) => <DocLink docId={r.docId} region="number">{r.number}</DocLink>, sortBy: (r) => r.number },
    { id: "party", header: "Customer", cell: (r) => r.partyName, sortBy: (r) => r.partyName },
    { id: "due", header: "Due", cell: (r) => <DocLink docId={r.docId} region="dueDate">{shortDate(r.dueDate)}</DocLink>, sortBy: (r) => r.dueDate, secondary: true },
    { id: "late", header: "Days overdue", cell: (r) => r.daysOverdue, sortBy: (r) => r.daysOverdue, numeric: true },
    { id: "out", header: "Outstanding", cell: (r) => <Amount paise={r.outstandingPaise} rupees />, sortBy: (r) => r.outstandingPaise, numeric: true },
    { id: "stamp", header: "", cell: (r) => (r.bucket >= 3 ? <Stamp kind="overdue" /> : null) },
  ];
  return (
    <>
      {compact ? null : <CoveringNote note={report.note} from="From the Credit Controller" />}
      <Section title="How old is what you are owed">
        <AgeingBuckets totals={report.bucketTotals} />
      </Section>
      <Section title="Who owes what">
        <LedgerTable caption="Amount owed by each customer, by age" rows={report.rows} columns={cols} rowKey={(r) => r.partyId} initialSort={{ id: "total", desc: true }} rowTone={(r) => (r.buckets[3]! + r.buckets[4]! > 0 ? "red" : undefined)} limit={compact ? 8 : 25} />
      </Section>
      {compact ? null : (
        <Section title="Overdue invoices">
          <LedgerTable caption="Overdue invoices, oldest first" rows={overdue} columns={invCols} rowKey={(r) => r.invoiceId} initialSort={{ id: "late", desc: true }} limit={12} />
        </Section>
      )}
    </>
  );
}

function DownloadButton({ path, filename, children }: { path: string; filename: string; children: React.ReactNode }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const start = () => {
    setState("busy");
    download(path, filename).then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  return (
    <>
      <button type="button" className="btn" onClick={start} disabled={state === "busy"} aria-busy={state === "busy"}>
        {state === "busy" ? "Preparing…" : children}
      </button>
      {state === "failed" && (
        <span className="toolbar-error" role="alert">
          Could not prepare the file.
        </span>
      )}
    </>
  );
}

export function DocLink({ docId, region, children }: { docId: string; region?: string; children: React.ReactNode }) {
  const { openDocument } = useFigures();
  return (
    <button type="button" className="figure-link" onClick={() => openDocument(docId, region)}>
      {children}
    </button>
  );
}

/* ---------- GST ---------- */

export function GstView({ report, onPeriod }: { report: GstReport; onPeriod?: (p: string) => void }) {
  const o = report.outward;
  const tax = (t: { cgstPaise: number; sgstPaise: number; igstPaise: number }) => t.cgstPaise + t.sgstPaise + t.igstPaise;
  const p = report.period;
  return (
    <>
      <CoveringNote note={report.note} from="From the Tax Clerk" />
      <div className="toolbar">
        <PeriodPicker value={p} options={report.periods} label={monthLabel} onChange={onPeriod} name="Return period" />
        <div className="toolbar-actions">
          <DownloadButton path={exportUrl.gstr1(p)} filename={`GSTR1_${p}.json`}>
            Download GSTR-1 file
          </DownloadButton>
          <DownloadButton path={exportUrl.gstr3b(p)} filename={`GSTR3B_${p}.xlsx`}>
            Download GSTR-3B workings
          </DownloadButton>
        </div>
      </div>
      <Section title={`GSTR-3B for ${monthLabel(p)}`}>
        <table className="ledger return-table">
          <caption className="visually-hidden">GSTR-3B summary</caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th className="num">Taxable value</th>
              <th className="num">IGST</th>
              <th className="num">CGST</th>
              <th className="num">SGST</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">3.1(a) Outward taxable supplies, {o.invoices} invoices</th>
              <td className="num">
                <Amount paise={o.taxablePaise} figureId={o.figureId} rupees />
              </td>
              <td className="num"><Amount paise={o.igstPaise} rupees /></td>
              <td className="num"><Amount paise={o.cgstPaise} rupees /></td>
              <td className="num"><Amount paise={o.sgstPaise} rupees /></td>
            </tr>
            <tr>
              <th scope="row">4(A) Input tax credit in your books</th>
              <td />
              <td className="num"><Amount paise={report.itc.books.igstPaise} figureId={report.itc.books.figureId} rupees /></td>
              <td className="num"><Amount paise={report.itc.books.cgstPaise} rupees /></td>
              <td className="num"><Amount paise={report.itc.books.sgstPaise} rupees /></td>
            </tr>
            <tr>
              <th scope="row">Credit you can claim, matched with GSTR-2B</th>
              <td />
              <td className="num"><Amount paise={report.itc.eligible.igstPaise} figureId={report.itc.eligible.figureId} rupees /></td>
              <td className="num"><Amount paise={report.itc.eligible.cgstPaise} rupees /></td>
              <td className="num"><Amount paise={report.itc.eligible.sgstPaise} rupees /></td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Tax to pay in cash</th>
              <td className="num">
                <Amount paise={report.payable.totalPaise} figureId={`gst:payable:${p}`} rupees />
              </td>
              <td className="num"><Amount paise={report.payable.igstPaise} rupees /></td>
              <td className="num"><Amount paise={report.payable.cgstPaise} rupees /></td>
              <td className="num"><Amount paise={report.payable.sgstPaise} rupees /></td>
            </tr>
          </tfoot>
        </table>
        <p className="muted table-note">Credit is set off IGST first, then CGST and SGST, as rule 88A requires. Only bills your suppliers have reported in GSTR-2B count toward the credit you can claim.</p>
      </Section>
      {report.itc.notIn2b.length ? (
        <Section title="Credit you cannot claim yet">
          <p className="section-lede">
            These bills are in your books, but the suppliers have not reported them in GSTR-2B. Under section 16(2)(aa), the credit waits until they do.
          </p>
          <LedgerTable
            caption="Bills missing from GSTR-2B"
            rows={report.itc.notIn2b}
            rowKey={(r) => r.billId}
            columns={[
              { id: "n", header: "Bill", cell: (r) => <DocLink docId={r.docId} region="number">{r.number}</DocLink> },
              { id: "v", header: "Supplier", cell: (r) => r.vendor },
              { id: "d", header: "Date", cell: (r) => shortDate(r.date), secondary: true },
              { id: "t", header: "Tax on the bill", cell: (r) => <Amount paise={r.taxPaise} rupees tone="red" />, numeric: true, footer: <Amount paise={sum(report.itc.notIn2b, (r) => r.taxPaise)} figureId={`gst:itc-missing:${p}`} rupees /> },
              { id: "s", header: "", cell: () => <Stamp kind="mismatch" /> },
            ]}
          />
        </Section>
      ) : null}
      <Section title="By tax rate">
        <LedgerTable
          caption="Outward supplies by GST rate"
          rows={report.byRate}
          rowKey={(r) => String(r.rate)}
          columns={[
            { id: "r", header: "Rate", cell: (r) => `${r.rate}%` },
            { id: "t", header: "Taxable value", cell: (r) => <Amount paise={r.taxablePaise} rupees />, numeric: true, footer: <Amount paise={o.taxablePaise} rupees /> },
            { id: "x", header: "Tax", cell: (r) => <Amount paise={tax(r)} rupees />, numeric: true, footer: <Amount paise={tax(o)} rupees /> },
          ]}
        />
      </Section>
      <Section title="HSN summary">
        <LedgerTable
          caption="HSN-wise summary for GSTR-1 table 12"
          rows={report.hsn}
          rowKey={(r) => `${r.hsn}-${r.rate}`}
          initialSort={{ id: "t", desc: true }}
          limit={10}
          columns={[
            { id: "h", header: "HSN", cell: (r) => r.hsn, sortBy: (r) => r.hsn },
            { id: "d", header: "Description", cell: (r) => r.description, secondary: true },
            { id: "q", header: "Quantity", cell: (r) => quantity(r.qty, r.uqc), numeric: true, secondary: true },
            { id: "r", header: "Rate", cell: (r) => `${r.rate}%`, numeric: true },
            { id: "t", header: "Taxable value", cell: (r) => <Amount paise={r.taxablePaise} rupees />, sortBy: (r) => r.taxablePaise, numeric: true },
            { id: "x", header: "Tax", cell: (r) => <Amount paise={tax(r)} rupees />, sortBy: tax, numeric: true },
          ]}
        />
      </Section>
      <Section title="Filing calendar">
        <FilingList filings={report.filings} />
      </Section>
    </>
  );
}

export function FilingList({ filings }: { filings: GstReport["filings"] }) {
  return (
    <ul className="filings">
      {filings.map((f) => (
        <li key={`${f.form}-${f.period}`}>
          <span className="filings-form">{f.form}</span>
          <span>{f.period.startsWith("FY") ? quarterLabel(f.period) : monthLabel(f.period)}</span>
          <span className="muted">{f.status === "filed" ? `Filed on ${shortDate(f.filedOn!)}` : `Due ${shortDate(f.dueOn)}`}</span>
          <span>{f.status === "filed" ? "Filed" : f.status === "draft" ? "Draft with your accountant" : "Not started"}</span>
        </li>
      ))}
    </ul>
  );
}

export function PeriodPicker({ value, options, label, onChange, name }: { value: string; options: string[]; label: (p: string) => string; onChange?: (p: string) => void; name: string }) {
  if (!onChange) return null;
  return (
    <div className="field field-inline">
      <label htmlFor={`pp-${name}`}>{name}</label>
      <select id={`pp-${name}`} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {label(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------- TDS ---------- */

export function TdsView({ report, onQuarter }: { report: TdsReport; onQuarter?: (q: string) => void }) {
  const short = report.deductions.filter((d) => d.bookedPaise < d.expectedPaise || (d.filedPaise !== null && d.filedPaise < d.expectedPaise));
  const cols: LedgerColumn<TdsDeduction>[] = [
    { id: "v", header: "Deductee", cell: (r) => <DocLink docId={r.docId}>{r.vendor}</DocLink>, sortBy: (r) => r.vendor },
    { id: "s", header: "Section", cell: (r) => r.section, sortBy: (r) => r.section },
    { id: "d", header: "Bill date", cell: (r) => shortDate(r.date), sortBy: (r) => r.date, secondary: true },
    { id: "b", header: "Paid or credited", cell: (r) => <Amount paise={r.basePaise} rupees />, sortBy: (r) => r.basePaise, numeric: true, secondary: true },
    { id: "rate", header: "Rate", cell: (r) => `${r.ruleRateBp / 100}%${r.bookedRateBp !== r.ruleRateBp ? `, booked at ${r.bookedRateBp / 100}%` : ""}`, numeric: true },
    { id: "e", header: "Should be", cell: (r) => <Amount paise={r.expectedPaise} rupees />, sortBy: (r) => r.expectedPaise, numeric: true },
    { id: "k", header: "In the books", cell: (r) => <Amount paise={r.bookedPaise} rupees tone={r.bookedPaise < r.expectedPaise ? "red" : undefined} />, numeric: true },
    { id: "f", header: `In ${report.returnForm}`, cell: (r) => (r.filedPaise === null ? <span className="muted">Not filed yet</span> : <Amount paise={r.filedPaise} rupees tone={r.filedPaise < r.expectedPaise ? "red" : undefined} />), numeric: true },
  ];
  const missing = report.receivable.filter((r) => r.creditedPaise < r.expectedPaise);
  return (
    <>
      <CoveringNote note={report.note} from="From the Tax Clerk" />
      <div className="toolbar">
        <PeriodPicker value={report.quarter} options={report.quarters} label={quarterLabel} onChange={onQuarter} name="Quarter" />
        <div className="toolbar-actions">
          <DownloadButton path={exportUrl.tds(report.quarter)} filename={`${report.returnForm === "26Q" ? "26Q" : "Form140"}_${report.quarter}.xlsx`}>
            Download {report.returnForm} workings
          </DownloadButton>
        </div>
      </div>
      <Section title="TDS you deducted, by section">
        <LedgerTable
          caption="TDS by section"
          rows={report.bySection}
          rowKey={(r) => r.section}
          columns={[
            { id: "s", header: "Section", cell: (r) => (r.reference === r.section ? r.section : <span title={`Formerly section ${r.section}`}>{r.reference}</span>) },
            { id: "code", header: "Payment code", cell: (r) => r.code || <span className="muted">None before April 2026</span>, secondary: true },
            { id: "n", header: "Nature of payment", cell: (r) => r.nature },
            { id: "r", header: "Rate", cell: (r) => r.rate, secondary: true },
            { id: "c", header: "Deductees", cell: (r) => r.deductees, numeric: true, secondary: true },
            { id: "b", header: "Paid or credited", cell: (r) => <Amount paise={r.basePaise} rupees />, numeric: true, secondary: true },
            { id: "t", header: "TDS", cell: (r) => <Amount paise={r.tdsPaise} figureId={r.figureId} rupees label={r.section} />, numeric: true, footer: <Amount paise={sum(report.bySection, (r) => r.tdsPaise)} figureId={`tds:total:${report.quarter}`} rupees /> },
          ]}
        />
        <p className="muted table-note">{report.sectionNote}</p>
      </Section>
      {short.length ? (
        <Section title="Short or missing deductions">
          <LedgerTable caption="Deductions that do not match the rule" rows={short} columns={cols} rowKey={(r) => r.billId} rowTone={() => "red"} />
        </Section>
      ) : null}
      <Section title="Every deduction this quarter">
        <LedgerTable caption="All TDS deductions" rows={report.deductions} columns={cols} rowKey={(r) => r.billId} initialSort={{ id: "d" }} limit={12} />
      </Section>
      <Section title="TDS your customers deducted from you">
        <p className="section-lede">Customers who deduct TDS on purchases from you (section 393, code 1031; formerly 194Q) must deposit it against your PAN. Credits missing from Form 26AS cannot be claimed in your income-tax return.</p>
        <LedgerTable
          caption="TDS receivable against Form 26AS"
          rows={report.receivable}
          rowKey={(r) => r.invoiceId}
          rowTone={(r) => (r.creditedPaise < r.expectedPaise ? "red" : undefined)}
          columns={[
            { id: "n", header: "Invoice", cell: (r) => <DocLink docId={r.docId} region="number">{r.number}</DocLink> },
            { id: "c", header: "Customer", cell: (r) => r.customer },
            { id: "e", header: "Deducted", cell: (r) => <Amount paise={r.expectedPaise} rupees />, numeric: true },
            { id: "k", header: "In 26AS", cell: (r) => <Amount paise={r.creditedPaise} rupees />, numeric: true },
            { id: "s", header: "", cell: (r) => (r.creditedPaise < r.expectedPaise ? <Stamp kind="mismatch" /> : <Stamp kind="matched" />) },
          ]}
        />
        {missing.length ? <p className="table-note">{missing.length === 1 ? "One credit is" : `${missing.length} credits are`} missing. The Auditor has asked your accountant to follow up with the customer.</p> : null}
      </Section>
    </>
  );
}

/* ---------- Cash ---------- */

export function CashView({ report }: { report: CashReport }) {
  const sumIn = sum(report.weeks, (w) => w.expectedInPaise);
  const sumOut = sum(report.weeks, (w) => w.expectedOutPaise);
  return (
    <>
      <CoveringNote note={report.note} from="From the Accountant" />
      <Section title="The next weeks">
        <LedgerTable
          caption="Expected cash by week"
          rows={report.weeks}
          rowKey={(r) => r.weekOf}
          columns={[
            { id: "w", header: "Week of", cell: (r) => shortDate(r.weekOf) },
            { id: "i", header: "Expected in", cell: (r) => <Amount paise={r.expectedInPaise} figureId={`cash:week:${r.weekOf}`} rupees />, numeric: true, footer: <Amount paise={sumIn} figureId="cash:in" rupees /> },
            { id: "o", header: "Expected out", cell: (r) => <Amount paise={r.expectedOutPaise} rupees />, numeric: true, footer: <Amount paise={sumOut} figureId="cash:out" rupees /> },
            { id: "n", header: "Net", cell: (r) => <Amount paise={r.expectedInPaise - r.expectedOutPaise} rupees tone={r.expectedInPaise < r.expectedOutPaise ? "red" : undefined} />, numeric: true, footer: <Amount paise={sumIn - sumOut} rupees /> },
            { id: "c", header: "Items", cell: (r) => r.items.length, numeric: true, secondary: true },
          ]}
        />
      </Section>
      <Section title="Month by month">
        <LedgerTable
          caption="Receipts and payments by month"
          rows={report.months}
          rowKey={(r) => r.month}
          columns={[
            { id: "m", header: "Month", cell: (r) => monthLabel(r.month) },
            { id: "r", header: "Received", cell: (r) => <Amount paise={r.receiptsPaise} rupees />, numeric: true },
            { id: "p", header: "Paid out", cell: (r) => <Amount paise={r.paymentsPaise} rupees />, numeric: true },
            { id: "n", header: "Net", cell: (r) => <Amount paise={r.netPaise} rupees tone={r.netPaise < 0 ? "red" : undefined} />, numeric: true },
          ]}
        />
      </Section>
      <Section title="How this forecast is made">
        <ul className="assumptions">
          {report.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Section>
    </>
  );
}
