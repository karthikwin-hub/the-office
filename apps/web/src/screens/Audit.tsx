import type { Finding } from "@office/contracts";
import { monthLabel, quarterLabel } from "@office/engine";
import { Amount, CoveringNote, Stamp, useFigures } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { q, useDecide, useImportReturn } from "../api/queries";
import { PeriodPicker } from "../reports/accounts";
import { isOwner, Page, PageHead, Section, shortDate } from "./common";

const periodLabel = (p: string) => (p.startsWith("FY") ? quarterLabel(p) : monthLabel(p));
const SEVERITY = { high: "Fix before filing", medium: "Fix this month", low: "Worth checking" } as const;

/** The accountant's filed returns, as downloaded from the GST portal or their TDS software. */
function ImportReturn({ onImported }: { onImported: (period: string) => void }) {
  const imp = useImportReturn();
  const input = useRef<HTMLInputElement>(null);
  const take = async (file: File) => {
    const r = await imp.mutateAsync({ content: await file.text() }).catch(() => null);
    if (r) onImported(r.period);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="toolbar-actions">
      <button type="button" className="btn" onClick={() => input.current?.click()} disabled={imp.isPending} aria-describedby="import-help">
        {imp.isPending ? "Reading the return…" : "Import a filed return"}
      </button>
      <input ref={input} type="file" accept=".json,.csv,application/json,text/csv" hidden onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} />
      <span id="import-help" className={imp.isError ? "toolbar-error" : "muted toolbar-note"} role={imp.isError ? "alert" : undefined}>
        {imp.isError
          ? imp.error.message
          : imp.data
            ? `${imp.data.form} for ${periodLabel(imp.data.period)}: ${imp.data.summary}. ${imp.data.findings ? `${imp.data.findings} difference${imp.data.findings === 1 ? "" : "s"}.` : "Matches the books."}`
            : "GSTR-1, GSTR-3B or GSTR-2B JSON from the portal, or 26Q as CSV."}
      </span>
    </div>
  );
}

export function AuditScreen() {
  const [period, setPeriod] = useState<string>();
  const audit = useQuery(q.audit(period));
  const desk = useQuery(q.desk());
  const office = useQuery(q.office());
  const a = audit.data;
  const firm = office.data?.business.accountantFirm.split(",")[0] ?? "your accountant";
  const owner = isOwner();

  return (
    <Page ready={Boolean(a)} error={audit.error}>
      {a ? (
        <>
          <PageHead
            title={owner ? "Your accountant's returns, checked" : "Returns checked against the books"}
            lede={`The Auditor recomputes every return from the source documents and compares it with what ${firm} prepared or filed. Differences are explained in plain words, with the page that proves them.`}
          />
          <CoveringNote note={a.note} from="From the Auditor" />
          <div className="toolbar">
            <PeriodPicker value={a.period} options={a.periods} label={periodLabel} onChange={setPeriod} name="Period" />
            <ImportReturn onImported={setPeriod} />
          </div>
          <Section title="Returns">
            <ul className="returns">
              {a.returns.map((r) => (
                <li key={r.id}>
                  <span className="returns-form">{r.form}</span>
                  <span>{periodLabel(r.period)}</span>
                  <span className="muted">
                    {r.status === "filed" ? `Filed ${r.filedOn ? shortDate(r.filedOn) : ""}` : `Draft${r.sharedOn ? `, shared ${shortDate(r.sharedOn)}` : ""}`}
                  </span>
                  <span>{r.matched ? <Stamp kind="matched" /> : <Stamp kind="mismatch" />}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Line by line">
            <div className="ledger-wrap">
              <table className="ledger compare">
                <caption className="visually-hidden">Books compared with returns</caption>
                <thead>
                  <tr>
                    <th scope="col">Return</th>
                    <th scope="col">Line</th>
                    <th scope="col" className="num">
                      Your books
                    </th>
                    <th scope="col" className="num">
                      The return
                    </th>
                    <th scope="col" className="num">
                      Difference
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Result</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.comparisons.map((c, i) => (
                    <tr key={i} className={c.diffPaise ? "row-red" : undefined}>
                      <td>{c.form}</td>
                      <td>{c.line}</td>
                      <td className="num">
                        <Amount paise={c.booksPaise} rupees />
                      </td>
                      <td className="num">
                        <Amount paise={c.filedPaise} rupees />
                      </td>
                      <td className="num">{c.diffPaise ? <Amount paise={c.diffPaise} rupees tone="red" /> : <span className="muted">None</span>}</td>
                      <td>{c.diffPaise ? <Stamp kind="mismatch" /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title={a.findings.length ? `What is wrong and what to do (${a.findings.length})` : "Nothing to fix"}>
            {a.findings.length === 0 ? <p>The returns for this period match the books line for line.</p> : null}
            {a.findings.map((f) => (
              <FindingItem key={f.id} f={f} item={desk.data?.items.find((i) => i.id === `aud-${f.id}`) ?? desk.data?.decided.find((i) => i.id === `aud-${f.id}`)} owner={owner} firm={firm} />
            ))}
          </Section>
        </>
      ) : null}
    </Page>
  );
}

function FindingItem({ f, item, owner, firm }: { f: Finding; item?: { id: string; status: string; decidedBy?: string }; owner: boolean; firm: string }) {
  const { openDocument, open } = useFigures();
  const decide = useDecide();
  return (
    <article className={`finding finding-${f.severity}`} aria-labelledby={`f-${f.id}`}>
      <p className="finding-meta">
        <span>{SEVERITY[f.severity]}</span>
        <span className="muted">
          {f.form}, {periodLabel(f.period)}
        </span>
        <span className="finding-impact">
          <Amount paise={f.impactPaise} tone="red" rupees /> at stake
        </span>
      </p>
      <h3 id={`f-${f.id}`}>{f.title}</h3>
      <p>{f.explanation}</p>
      <p className="finding-action">
        <strong>What to do:</strong> {f.action}
      </p>
      <ul className="approval-evidence" aria-label="Evidence">
        {f.evidence.map((e, i) => (
          <li key={i}>
            <button type="button" className="btn-link" onClick={() => (e.ref.kind === "document" && e.ref.id ? openDocument(e.ref.id, e.ref.region) : e.ref.kind === "figure" && e.ref.id ? open(e.ref.id) : undefined)}>
              {e.label}
            </button>
          </li>
        ))}
      </ul>
      {item ? (
        item.status === "pending" ? (
          <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, decision: { action: "approve", note: owner ? undefined : "Acknowledged; will correct before filing." } })}>
            {owner ? `Raise with ${firm}` : "Acknowledge and correct"}
          </button>
        ) : (
          <p className="approval-result">
            <strong>{owner ? "Raised with accountant" : "Acknowledged"}</strong>
            {item.decidedBy ? ` by ${item.decidedBy}` : ""}
          </p>
        )
      ) : null}
    </article>
  );
}
