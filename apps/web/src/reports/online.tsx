import { CHANNEL_NAME, type ColumnMapping, FIELD_LABEL, type OnlineSalesReport, REQUIRED_FIELDS, SALES_CHANNELS, type SalesChannel, type SalesField, type SalesImport } from "@office/contracts";
import { inrShort } from "@office/engine";
import { Amount, CoveringNote, LedgerTable } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { q, useChange } from "../api/queries";
import { count, isOwner, Register, Section, shortDate } from "../screens/common";

/** Each channel keeps one colour across the page, from the skin's own series colours. */
const SERIES = ["var(--series-1, #2f5f8f)", "var(--series-2, #c9962c)", "var(--series-3, #2f7a5a)", "var(--series-4, #8e2f5a)", "var(--series-5, #5d4a8a)", "var(--series-6, #b8452e)"];
const pctText = (p: number | null) => (p === null ? "New" : `${p >= 0 ? "+" : "−"}${Math.abs(p)}%`);
const STATUS: Record<SalesImport["status"], string> = { read: "Read", needs_mapping: "Waiting for you", duplicate: "Seen before", unreadable: "Could not read", payout: "Payout read", dropped: "Not read" };
const VIA: Record<SalesImport["via"], string> = { email: "Email", whatsapp: "WhatsApp", upload: "Upload" };

export function OnlineSalesView({ report, compact }: { report: OnlineSalesReport; compact?: boolean }) {
  const colour = new Map(report.channels.map((c, i) => [c.channel, SERIES[i % SERIES.length]!]));
  return (
    <>
      {compact ? null : <CoveringNote note={[{ text: report.note }]} from="From the Marketplace Manager" />}
      {report.hasData ? (
        <>
          <Register
            items={[
              { label: `Online sales, ${report.period.label}`, value: inrShort(report.totals.grossPaise) },
              { label: "Orders", value: report.totals.orders.toLocaleString("en-IN") },
              { label: "Average order", value: inrShort(report.totals.aovPaise) },
              { label: "Returns", value: `${report.totals.returnsPct}%`, ...(report.totals.returnsPct >= 10 ? { tone: "red" as const } : {}) },
              { label: "Against the period before", value: pctText(report.totals.vsPreviousPct), ...(report.totals.vsPreviousPct !== null && report.totals.vsPreviousPct < 0 ? { tone: "red" as const } : {}) },
            ]}
          />
          <Section title="By channel">
            <LedgerTable
              caption="Online sales by channel"
              rows={report.channels}
              rowKey={(r) => r.channel}
              initialSort={{ id: "g", desc: true }}
              columns={[
                { id: "n", header: "Channel", cell: (r) => <span className="os-channel"><i style={{ background: colour.get(r.channel) }} aria-hidden="true" />{r.name}</span>, sortBy: (r) => r.name },
                // A platform that reports only totals by product (Myntra) gives units but no orders.
                { id: "o", header: "Orders", cell: (r) => (r.orders || !r.units ? r.orders.toLocaleString("en-IN") : <span title={`${r.name} reports totals by product, not orders`}>–</span>), sortBy: (r) => r.orders, numeric: true },
                { id: "g", header: "Sales", cell: (r) => <Amount paise={r.grossPaise} rupees />, sortBy: (r) => r.grossPaise, numeric: true },
                { id: "a", header: "Average order", cell: (r) => (r.orders ? <Amount paise={r.aovPaise} rupees /> : "–"), sortBy: (r) => r.aovPaise, numeric: true, secondary: true },
                { id: "r", header: "Returns", cell: (r) => `${r.returnsPct}%`, sortBy: (r) => r.returnsPct, numeric: true },
                { id: "c", header: "Cancelled", cell: (r) => r.cancelled.toLocaleString("en-IN"), sortBy: (r) => r.cancelled, numeric: true, secondary: true },
                { id: "v", header: "Change", cell: (r) => pctText(r.vsPreviousPct), sortBy: (r) => r.vsPreviousPct ?? 0, numeric: true, secondary: true },
                { id: "l", header: "Latest day", cell: (r) => (r.lastDate ? shortDate(r.lastDate) : "–"), secondary: true },
              ]}
            />
          </Section>
          {compact ? null : <Weeks report={report} colour={colour} />}
          <Section title="Products">
            <LedgerTable
              caption="Online sales by product"
              rows={report.skus}
              rowKey={(r) => r.key}
              initialSort={{ id: "g", desc: true }}
              limit={compact ? 8 : 25}
              rowTone={(r) => (r.returnsPct >= 10 && r.units >= 5 ? "red" : undefined)}
              columns={[
                { id: "n", header: "Product", cell: (r) => r.name, sortBy: (r) => r.name },
                { id: "ch", header: "Sold on", cell: (r) => r.channels.map((c) => CHANNEL_NAME[c]).join(", "), secondary: true },
                { id: "u", header: "Units", cell: (r) => r.units.toLocaleString("en-IN"), sortBy: (r) => r.units, numeric: true },
                { id: "g", header: "Sales", cell: (r) => <Amount paise={r.grossPaise} rupees />, sortBy: (r) => r.grossPaise, numeric: true },
                { id: "r", header: "Returned", cell: (r) => (r.returnedUnits ? `${r.returnedUnits.toLocaleString("en-IN")} (${r.returnsPct}%)` : "–"), sortBy: (r) => r.returnsPct, numeric: true },
              ]}
            />
            {!compact && report.unsold.length ? <p className="muted">Not sold online in this period: {report.unsold.slice(0, 8).map((s) => s.name).join(", ")}{report.unsold.length > 8 ? ` and ${report.unsold.length - 8} more` : ""}.</p> : null}
          </Section>
          {compact ? null : (
            <div className="os-places">
              <Section title="States">
                <LedgerTable
                  caption="Online sales by state"
                  rows={report.states}
                  rowKey={(r) => r.state}
                  initialSort={{ id: "g", desc: true }}
                  limit={12}
                  columns={[
                    { id: "n", header: "State", cell: (r) => r.name, sortBy: (r) => r.name },
                    { id: "o", header: "Orders", cell: (r) => r.orders.toLocaleString("en-IN"), sortBy: (r) => r.orders, numeric: true },
                    { id: "g", header: "Sales", cell: (r) => <Amount paise={r.grossPaise} rupees />, sortBy: (r) => r.grossPaise, numeric: true },
                  ]}
                />
              </Section>
              <Section title="Cities">
                <LedgerTable
                  caption="Online sales by city"
                  rows={report.cities}
                  rowKey={(r) => r.city}
                  initialSort={{ id: "g", desc: true }}
                  limit={12}
                  columns={[
                    { id: "n", header: "City", cell: (r) => r.city, sortBy: (r) => r.city },
                    { id: "o", header: "Orders", cell: (r) => r.orders.toLocaleString("en-IN"), sortBy: (r) => r.orders, numeric: true },
                    { id: "g", header: "Sales", cell: (r) => <Amount paise={r.grossPaise} rupees />, sortBy: (r) => r.grossPaise, numeric: true },
                  ]}
                />
              </Section>
            </div>
          )}
          {!compact && report.payouts.length ? <Payouts report={report} /> : null}
        </>
      ) : null}
    </>
  );
}

function Weeks({ report, colour }: { report: OnlineSalesReport; colour: Map<SalesChannel, string> }) {
  const max = Math.max(1, ...report.weeks.map((w) => w.totalPaise));
  return (
    <Section title="Week by week">
      <ol className="os-weeks" aria-label="Online sales in each of the last eight weeks">
        {report.weeks.map((w) => (
          <li key={w.week}>
            <span className="os-week-bar" style={{ height: `${Math.round((w.totalPaise / max) * 100)}%` }} title={`Week of ${w.label}: ${inrShort(w.totalPaise)}`}>
              {report.channels.map((c) =>
                w.byChannel[c.channel] ? <span key={c.channel} style={{ flexGrow: w.byChannel[c.channel], background: colour.get(c.channel) }} /> : null,
              )}
            </span>
            <span className="os-week-total">{w.totalPaise ? inrShort(w.totalPaise) : "–"}</span>
            <span className="os-week-label">{w.label}</span>
          </li>
        ))}
      </ol>
      <p className="os-legend">
        {report.channels.map((c) => (
          <span key={c.channel} className="os-channel">
            <i style={{ background: colour.get(c.channel) }} aria-hidden="true" />
            {c.name}
          </span>
        ))}
      </p>
    </Section>
  );
}

function Payouts({ report }: { report: OnlineSalesReport }) {
  return (
    <Section title="Payouts">
      {report.payouts.map((p) => (
        <details key={p.id} className="os-payout">
          <summary>
            {CHANNEL_NAME[p.channel]}
            {p.from && p.to ? `, ${shortDate(p.from)} to ${shortDate(p.to)}` : ""}: <strong>{inrShort(p.netPaise)}</strong>
            {p.paidOn ? ` paid on ${shortDate(p.paidOn)}` : ""}
          </summary>
          <ul>
            {p.parts.map((x) => (
              <li key={x.label}>
                <span>{x.label}</span>
                <Amount paise={x.paise} />
              </li>
            ))}
          </ul>
        </details>
      ))}
      <p className="muted">Fees and taxes withheld are shown as the platform reported them. They are not in your books yet.</p>
    </Section>
  );
}

/** The Marketplace Manager's room: the report, where reports come from, and what has come in. */
export function MarketplacePanel({ preview }: { preview?: boolean }) {
  const res = useQuery(q.onlineSales());
  const r = res.data;
  if (preview) return <p className="muted">Once hired, this room reads the sales and settlement reports Amazon, Flipkart, Meesho, Blinkit and the other apps send you, and shows what sold where. It has its own email address, and takes files on WhatsApp too.</p>;
  if (res.error) return <p className="form-error">{res.error.message}</p>;
  if (!r) return <p className="loading">Counting online sales</p>;
  return (
    <>
      <OnlineSalesView report={r} compact />
      <Waiting imports={r.imports.filter((i) => i.status === "needs_mapping")} />
      <Sources report={r} />
      <Imports imports={r.imports} />
    </>
  );
}

function Sources({ report }: { report: OnlineSalesReport }) {
  return (
    <Section title="Sending reports in">
      {report.address ? (
        <p>
          Email reports to <strong className="ea-address">{report.address}</strong>, or send them to the office on WhatsApp. Mail from the platforms and from people in the office is read; anything else is set aside.
        </p>
      ) : null}
      <ul className="ea-steps">
        <li>Amazon: the tax report (MTR, B2C and B2B) from Reports → Tax Document Library, or the transaction report from Payments → Reports, with its fees and transfers; not both for the same month, or the orders count twice. Settlement reports from Payments too.</li>
        <li>Flipkart: the Sales Report from Reports in Seller Hub. Meesho: the GST reports, sales and returns. Myntra: the monthly P&amp;L report from the Partner Portal; it gives totals by product, so Myntra shows sales but no order count.</li>
        <li>Blinkit, Zepto, Instamart and others: any sales sheet they send. A new layout is confirmed once; after that it is read on its own.</li>
        <li>If a platform sends only a link to its portal, download the file and forward it.</li>
      </ul>
      {isOwner() ? <Upload /> : null}
    </Section>
  );
}

function Upload() {
  const change = useChange<{ imports: SalesImport[]; message: string }>();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const send = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) return setMessage("Files up to 10 MB, please.");
    const text = /\.(csv|txt|tsv)$/i.test(f.name);
    let content: string;
    if (text) content = await f.text();
    else {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      content = btoa(bin);
    }
    change.mutate(() => api.uploadSales(f.name, content, text ? "text" : "base64"), { onSuccess: (r) => setMessage(r.message) });
  };
  return (
    <div className="os-upload">
      <input
        ref={input}
        type="file"
        accept=".csv,.txt,.tsv,.xlsx,.xlsm,.zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void send(f);
          e.target.value = "";
        }}
      />
      <button type="button" className="btn" disabled={change.isPending} onClick={() => input.current?.click()}>
        {change.isPending ? "Reading it" : "Upload a report"}
      </button>
      {message ? <p aria-live="polite" className="os-message">{message}</p> : null}
      {change.error ? <p className="form-error">{change.error.message}</p> : null}
    </div>
  );
}

const FIELDS = Object.keys(FIELD_LABEL) as SalesField[];

function Waiting({ imports }: { imports: SalesImport[] }) {
  if (!imports.length || !isOwner()) return null;
  return (
    <Section title={`New layouts to confirm (${imports.length})`}>
      {imports.map((i) => (
        <MappingEditor key={i.id} imp={i} />
      ))}
    </Section>
  );
}

function MappingEditor({ imp }: { imp: SalesImport }) {
  const detail = useQuery({ queryKey: ["online-sales", "import", imp.id], queryFn: () => api.salesImport(imp.id) });
  const change = useChange();
  const [channel, setChannel] = useState<SalesChannel>(imp.channel);
  const [edits, setEdits] = useState<ColumnMapping>({});
  const d = detail.data;
  if (!d) return <p className="loading">Opening {imp.file}</p>;
  const mapping: ColumnMapping = { ...d.mapping, ...edits };
  const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  return (
    <form
      className="cs-form os-mapping"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) as ColumnMapping;
        change.mutate(() => api.mapSales(imp.id, channel, clean));
      }}
    >
      <p>
        <strong>{imp.file}</strong>, {count(imp.rows, "row")}, came in by {VIA[imp.via].toLowerCase()} on {shortDate(imp.receivedAt)}.
      </p>
      <label htmlFor={`ch-${imp.id}`}>Platform</label>
      <select id={`ch-${imp.id}`} className="input" value={channel} onChange={(e) => setChannel(e.target.value as SalesChannel)}>
        {SALES_CHANNELS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="os-fields">
        {FIELDS.map((f) => (
          <label key={f}>
            <span>
              {FIELD_LABEL[f]}
              {REQUIRED_FIELDS.includes(f) ? " *" : ""}
            </span>
            <select className="input" value={mapping[f] ?? ""} onChange={(e) => setEdits({ ...edits, [f]: e.target.value })}>
              <option value="">Not in this file</option>
              {d.headers.filter(Boolean).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {d.sample.length ? (
        <div className="os-sample" role="region" aria-label="The first rows" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {d.headers.map((h, i) => (
                  <th key={`${h}-${i}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.sample.map((r, i) => (
                <tr key={i}>
                  {d.headers.map((_, j) => (
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={change.isPending || missing.length > 0}>
          Read it this way
        </button>
        <button type="button" className="btn" disabled={change.isPending} onClick={() => change.mutate(() => api.removeSales(imp.id))}>
          Do not read it
        </button>
        {missing.length ? <span className="muted">Choose {missing.map((m) => FIELD_LABEL[m].toLowerCase()).join(", ")}.</span> : null}
      </div>
      {change.error ? <p className="form-error">{change.error.message}</p> : null}
    </form>
  );
}

function Imports({ imports }: { imports: SalesImport[] }) {
  const change = useChange();
  if (!imports.length) return null;
  return (
    <Section title="Reports received">
      <LedgerTable
        caption="Sales reports received"
        rows={imports}
        rowKey={(r) => r.id}
        initialSort={{ id: "at", desc: true }}
        limit={12}
        rowTone={(r) => (r.status === "unreadable" || r.status === "needs_mapping" ? "red" : undefined)}
        columns={[
          { id: "at", header: "Came in", cell: (r) => shortDate(r.receivedAt), sortBy: (r) => r.receivedAt },
          { id: "f", header: "Report", cell: (r) => <span title={r.file}>{r.formatName}</span>, sortBy: (r) => r.formatName },
          { id: "v", header: "By", cell: (r) => VIA[r.via], secondary: true },
          { id: "s", header: "Status", cell: (r) => STATUS[r.status], sortBy: (r) => r.status },
          { id: "n", header: "What was in it", cell: (r) => r.note, secondary: true },
          ...(isOwner()
            ? [
                {
                  id: "x",
                  header: "",
                  cell: (r: SalesImport) =>
                    r.status === "read" || r.status === "payout" ? (
                      <button type="button" className="btn-link" disabled={change.isPending} onClick={() => window.confirm(`Remove ${r.file} and the sales read from it?`) && change.mutate(() => api.removeSales(r.id))}>
                        Remove
                      </button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
    </Section>
  );
}
