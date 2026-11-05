import type { MarketingReport, OperationsReport, PeopleReport, Reorder, SalesTeamReport } from "@office/contracts";
import { monthLabel } from "@office/engine";
import { Amount, CoveringNote, LedgerTable } from "@office/ui";
import { Link } from "@tanstack/react-router";
import { count, quantity, Section, shortDate } from "../screens/common";

const STAGES: Record<string, string> = { new: "New", contacted: "Contacted", quoted: "Quoted", negotiating: "Negotiating", won: "Won", lost: "Lost" };
const stage = (s: string) => STAGES[s] ?? s;

/* ---------- Sales team ---------- */

export function PipelineView({ report, compact }: { report: SalesTeamReport; compact?: boolean }) {
  const open = report.leads.filter((l) => !["won", "lost"].includes(l.stage));
  return (
    <>
      {compact ? null : <CoveringNote note={report.note} from="From the Sales Rep" />}
      <Section title="Pipeline">
        <ol className="pipeline">
          {report.pipeline.map((p) => (
            <li key={p.stage}>
              <span className="pipeline-stage">{stage(p.stage)}</span>
              <span className="num">{count(p.count, "lead")}</span>
              <Amount paise={p.valuePaise} short />
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Open leads">
        <LedgerTable
          caption="Open leads"
          rows={open}
          rowKey={(r) => r.id}
          initialSort={{ id: "v", desc: true }}
          columns={[
            { id: "n", header: "Lead", cell: (r) => <><strong>{r.name}</strong><br /><span className="muted">{r.need}</span></>, sortBy: (r) => r.name },
            { id: "s", header: "Stage", cell: (r) => stage(r.stage), sortBy: (r) => r.stage },
            { id: "src", header: "Came from", cell: (r) => r.source, secondary: true },
            { id: "v", header: "Value", cell: (r) => <Amount paise={r.valuePaise} rupees />, sortBy: (r) => r.valuePaise, numeric: true, footer: <Amount paise={open.reduce((a, l) => a + l.valuePaise, 0)} figureId="pipeline:open" rupees /> },
            { id: "x", header: "Next step", cell: (r) => r.nextStep, secondary: true },
            { id: "t", header: "Last contact", cell: (r) => shortDate(r.lastTouchOn), sortBy: (r) => r.lastTouchOn, secondary: true },
          ]}
        />
      </Section>
    </>
  );
}

const QUOTE_STATUS = { draft: "Draft", sent: "Sent", accepted: "Accepted", expired: "Expired" } as const;

export function QuotesView({ report }: { report: SalesTeamReport }) {
  return (
    <Section title="Quotations">
      <LedgerTable
        caption="Quotations"
        rows={report.quotes}
        rowKey={(r) => r.id}
        initialSort={{ id: "d", desc: true }}
        rowTone={(r) => (r.overdueWarning ? "red" : undefined)}
        columns={[
          { id: "n", header: "Quotation", cell: (r) => r.number, sortBy: (r) => r.number },
          { id: "c", header: "For", cell: (r) => <>{r.customer}{r.overdueWarning ? <><br /><span className="figure-red">{r.overdueWarning}</span></> : null}</>, sortBy: (r) => r.customer },
          { id: "d", header: "Date", cell: (r) => shortDate(r.date), sortBy: (r) => r.date, secondary: true },
          { id: "u", header: "Valid until", cell: (r) => shortDate(r.validUntil), secondary: true },
          { id: "s", header: "Status", cell: (r) => QUOTE_STATUS[r.status], sortBy: (r) => r.status },
          { id: "t", header: "Value", cell: (r) => <Amount paise={r.totals.totalPaise} rupees />, sortBy: (r) => r.totals.totalPaise, numeric: true },
        ]}
      />
    </Section>
  );
}

const REORDER: Record<Reorder["status"], string> = { ok: "Not yet", due: "Due this week", late: "Late" };

export function ReordersView({ report }: { report: SalesTeamReport }) {
  return (
    <Section title="Customers due to reorder">
      <p className="section-lede">Worked out from how often each customer has ordered this year. A late customer may be buying elsewhere.</p>
      <LedgerTable
        caption="Expected reorders"
        rows={report.reorders}
        rowKey={(r) => r.partyId}
        initialSort={{ id: "late", desc: true }}
        rowTone={(r) => (r.status === "late" ? "red" : undefined)}
        columns={[
          { id: "n", header: "Customer", cell: (r) => <Link to="/parties/$partyId" params={{ partyId: r.partyId }}>{r.name}</Link>, sortBy: (r) => r.name },
          { id: "o", header: "Orders this year", cell: (r) => r.orders, numeric: true, secondary: true },
          { id: "i", header: "Orders every", cell: (r) => `${r.avgIntervalDays} days`, numeric: true, secondary: true },
          { id: "l", header: "Last order", cell: (r) => shortDate(r.lastOrderOn), sortBy: (r) => r.lastOrderOn },
          { id: "late", header: "Days since", cell: (r) => r.daysSince, sortBy: (r) => r.daysSince - r.avgIntervalDays, numeric: true },
          { id: "t", header: "Typical order", cell: (r) => <Amount paise={r.typicalPaise} rupees />, numeric: true, secondary: true },
          { id: "s", header: "Reorder", cell: (r) => REORDER[r.status], sortBy: (r) => r.status },
        ]}
      />
    </Section>
  );
}

/* ---------- Marketing ---------- */

const CAMPAIGN = { draft: "Draft", planned: "Planned", running: "Running", ended: "Ended" } as const;

export function CampaignsView({ report, compact }: { report: MarketingReport; compact?: boolean }) {
  return (
    <>
      {compact ? null : <CoveringNote note={report.note} from="From the Marketer" />}
      <Section title="Campaigns">
        <LedgerTable
          caption="Campaigns"
          rows={report.campaigns}
          rowKey={(r) => r.id}
          columns={[
            { id: "n", header: "Campaign", cell: (r) => <><strong>{r.name}</strong><br /><span className="muted">{r.channel}: {r.skuNames.slice(0, 3).join(", ")}</span></> },
            { id: "s", header: "Status", cell: (r) => CAMPAIGN[r.status] },
            { id: "d", header: "Runs", cell: (r) => `${shortDate(r.start)} to ${shortDate(r.end)}`, secondary: true },
            { id: "b", header: "Spent of budget", cell: (r) => <><Amount paise={r.spentPaise} rupees /> of <Amount paise={r.budgetPaise} rupees /></>, numeric: true, secondary: true },
            { id: "e", header: "Enquiries", cell: (r) => r.enquiries, numeric: true },
            { id: "a", header: "Sales it brought", cell: (r) => <Amount paise={r.attributedSalesPaise} rupees />, numeric: true },
            { id: "x", header: "Per rupee spent", cell: (r) => (r.returnMultiple === null ? "" : `₹${r.returnMultiple.toFixed(1)}`), numeric: true },
          ]}
        />
        <p className="muted table-note">Sales are counted for a campaign when the customer quoted its scheme or code. It is an estimate, not proof.</p>
      </Section>
      {compact ? null : <FestivalsView report={report} />}
    </>
  );
}

export function FestivalsView({ report }: { report: MarketingReport }) {
  return (
    <Section title="Dates ahead">
      <ul className="filings">
        {report.calendar.map((f) => (
          <li key={f.date + f.name}>
            <span className="filings-form num">{shortDate(f.date)}</span>
            <span>{f.name}</span>
            <span className="muted">{f.relevance}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SlowStockView({ report }: { report: MarketingReport }) {
  const total = report.slowMovers.reduce((a, s) => a + s.stockValuePaise, 0);
  return (
    <Section title="Stock that is not moving">
      <p className="section-lede">SKUs with stock on hand and few or no sales in the last 60 days. The Marketer plans offers to clear them before buying more.</p>
      <LedgerTable
        caption="Slow-moving stock"
        rows={report.slowMovers}
        rowKey={(r) => r.skuId}
        initialSort={{ id: "v", desc: true }}
        columns={[
          { id: "n", header: "SKU", cell: (r) => r.name, sortBy: (r) => r.name },
          { id: "h", header: "On hand", cell: (r) => r.onHand.toLocaleString("en-IN"), numeric: true },
          { id: "s", header: "Sold in 60 days", cell: (r) => r.soldLast60, numeric: true },
          { id: "d", header: "Days of stock", cell: (r) => (r.daysOfStock === null ? "No sales" : r.daysOfStock), sortBy: (r) => r.daysOfStock ?? 9999, numeric: true, secondary: true },
          { id: "v", header: "Stock at cost", cell: (r) => <Amount paise={r.stockValuePaise} rupees />, sortBy: (r) => r.stockValuePaise, numeric: true, footer: <Amount paise={total} figureId="marketing:slow" rupees /> },
        ]}
      />
    </Section>
  );
}

export function PricesView({ report }: { report: MarketingReport }) {
  return (
    <Section title="Your prices against the market">
      <p className="section-lede">Lowest prices seen this week from sellers on marketplaces, against your list price before GST.</p>
      <LedgerTable
        caption="Competitor prices"
        rows={report.prices}
        rowKey={(r) => r.skuId}
        initialSort={{ id: "g", desc: true }}
        rowTone={(r) => (r.gapPct > 5 ? "red" : undefined)}
        columns={[
          { id: "n", header: "SKU", cell: (r) => r.name, sortBy: (r) => r.name },
          { id: "o", header: "Your price", cell: (r) => <Amount paise={r.ourPricePaise} rupees />, numeric: true },
          {
            id: "m",
            header: "Lowest seen",
            cell: (r) => {
              const best = [...r.offers].sort((a, b) => a.pricePaise - b.pricePaise)[0];
              return best ? <><Amount paise={best.pricePaise} rupees /><br /><span className="muted">{best.seller}, {best.marketplace}</span></> : null;
            },
            numeric: true,
          },
          { id: "g", header: "You are higher by", cell: (r) => `${r.gapPct.toFixed(1)}%`, sortBy: (r) => r.gapPct, numeric: true },
        ]}
      />
    </Section>
  );
}

/* ---------- Operations ---------- */

const STOCK = { reorder: "Reorder", ok: "Enough", excess: "Too much" } as const;

export function StockView({ report, compact }: { report: OperationsReport; compact?: boolean }) {
  const rows = compact ? report.stock.filter((s) => s.status !== "ok") : report.stock;
  return (
    <>
      {compact ? null : <CoveringNote note={report.note} from="From the Storekeeper" />}
      <Section title={compact ? "Needs attention" : "Stock"}>
        <LedgerTable
          caption="Stock levels"
          rows={rows}
          rowKey={(r) => r.skuId}
          initialSort={{ id: "c" }}
          limit={compact ? 10 : 20}
          rowTone={(r) => (r.status === "reorder" ? "red" : undefined)}
          columns={[
            { id: "n", header: "SKU", cell: (r) => r.name, sortBy: (r) => r.name },
            { id: "cat", header: "Category", cell: (r) => r.category, secondary: true },
            { id: "h", header: "On hand", cell: (r) => quantity(r.onHand, r.unit), sortBy: (r) => r.onHand, numeric: true },
            { id: "r", header: "Reorder at", cell: (r) => r.reorderPoint.toLocaleString("en-IN"), numeric: true, secondary: true },
            { id: "s", header: "Sold in 30 days", cell: (r) => r.soldLast30.toLocaleString("en-IN"), numeric: true, secondary: true },
            { id: "c", header: "Days of cover", cell: (r) => (r.daysOfCover === null ? "No sales" : r.daysOfCover), sortBy: (r) => r.daysOfCover ?? 9999, numeric: true },
            { id: "st", header: "Status", cell: (r) => STOCK[r.status], sortBy: (r) => r.status },
            { id: "v", header: "At cost", cell: (r) => <Amount paise={r.stockValuePaise} rupees />, sortBy: (r) => r.stockValuePaise, numeric: true, secondary: true },
          ]}
        />
      </Section>
    </>
  );
}

export function OrdersView({ report }: { report: OperationsReport }) {
  return (
    <>
      <Section title="Purchase orders">
        <LedgerTable
          caption="Purchase orders"
          rows={report.purchaseOrders}
          rowKey={(r) => r.id}
          initialSort={{ id: "d", desc: true }}
          columns={[
            { id: "n", header: "Order", cell: (r) => r.number },
            { id: "v", header: "Supplier", cell: (r) => r.vendor },
            { id: "d", header: "Date", cell: (r) => shortDate(r.date), sortBy: (r) => r.date, secondary: true },
            { id: "l", header: "Lines", cell: (r) => r.lines, numeric: true, secondary: true },
            { id: "s", header: "Status", cell: (r) => r.status.charAt(0).toUpperCase() + r.status.slice(1) },
            { id: "t", header: "Value", cell: (r) => <Amount paise={r.totalPaise} rupees />, numeric: true },
          ]}
        />
      </Section>
      <Section title="Quotes from suppliers">
        {report.rfqs.map((r) => (
          <div key={r.id} className="rfq">
            <h3>{r.title}</h3>
            <LedgerTable
              caption={r.title}
              rows={r.quotes}
              rowKey={(x) => x.vendorName}
              rowTone={(x) => (x.vendorName === r.recommended ? "green" : undefined)}
              columns={[
                { id: "v", header: "Supplier", cell: (x) => <>{x.vendorName}{x.vendorName === r.recommended ? <span className="muted">, recommended</span> : null}</> },
                { id: "r", header: "Rate", cell: (x) => <Amount paise={x.ratePaise} />, numeric: true },
                { id: "l", header: "Delivery", cell: (x) => `${x.leadDays} days`, numeric: true },
                { id: "t", header: "Terms", cell: (x) => x.terms, secondary: true },
              ]}
            />
            <p className="table-note">{r.reason}</p>
          </div>
        ))}
      </Section>
    </>
  );
}

export function ComplianceView({ report, compact }: { report: OperationsReport; compact?: boolean }) {
  const rows = compact ? report.compliance.filter((c) => c.status !== "done").slice(0, 6) : report.compliance;
  return (
    <Section title="Filing and payment calendar">
      <ul className="filings">
        {rows.map((c) => (
          <li key={c.id} className={c.status === "overdue" ? "is-red" : undefined}>
            <span className="filings-form">{c.form}</span>
            <span>{c.description}</span>
            <span className="muted num">
              {shortDate(c.date)}
              {c.status === "upcoming" ? `, in ${count(c.daysLeft, "day")}` : ""}
            </span>
            <span>{c.status === "done" ? "Done" : c.status === "overdue" ? "Overdue" : c.authority}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- People ---------- */

export function PayrollView({ report }: { report: PeopleReport }) {
  const t = report.totals;
  return (
    <>
      <CoveringNote note={report.note} from="From the Payroll Clerk" />
      <Section title={`Payroll for ${monthLabel(report.period)}`}>
        <LedgerTable
          caption="Payroll"
          rows={report.lines}
          rowKey={(r) => r.employeeId}
          columns={[
            { id: "n", header: "Name", cell: (r) => <><strong>{r.name}</strong><br /><span className="muted">{r.role}</span></>, sortBy: (r) => r.name },
            { id: "d", header: "Days paid", cell: (r) => r.payableDays, numeric: true, secondary: true },
            { id: "g", header: "Earned", cell: (r) => <Amount paise={r.earnedPaise} rupees />, numeric: true, footer: <Amount paise={t.earnedPaise} rupees /> },
            { id: "pf", header: "PF", cell: (r) => <Amount paise={r.pfEmployeePaise} rupees />, numeric: true, secondary: true, footer: <Amount paise={t.pfEmployeePaise} rupees /> },
            { id: "esi", header: "ESI", cell: (r) => (r.esiEmployeePaise ? <Amount paise={r.esiEmployeePaise} rupees /> : ""), numeric: true, secondary: true, footer: <Amount paise={t.esiEmployeePaise} rupees /> },
            { id: "pt", header: "Prof. tax", cell: (r) => <Amount paise={r.ptPaise} rupees />, numeric: true, secondary: true, footer: <Amount paise={t.ptPaise} rupees /> },
            { id: "net", header: "Net pay", cell: (r) => <Amount paise={r.netPaise} rupees />, sortBy: (r) => r.netPaise, numeric: true, footer: <Amount paise={t.netPaise} figureId={`payroll:net:${report.period}`} rupees /> },
          ]}
        />
        <p className="table-note">
          Your share on top of pay: PF <Amount paise={t.pfEmployerPaise} rupees /> and ESI <Amount paise={t.esiEmployerPaise} rupees />, <Amount paise={t.pfEmployerPaise + t.esiEmployerPaise + t.pfEmployeePaise + t.esiEmployeePaise} figureId={`payroll:statutory:${report.period}`} rupees /> in all to deposit by the 15th.
        </p>
      </Section>
      <Section title="How this is worked out">
        <ul className="assumptions">
          {report.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Section>
    </>
  );
}
