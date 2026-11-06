import { type Business, IMPORT_FILES, IMPORT_MAX_BYTES, type ImportCheck, type ImportKind, type ImportPreview, type StagedChange } from "@office/contracts";
import { dateLabel, importSummary, inr } from "@office/engine";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client";
import { isOwner, Section } from "./common";

const KINDS = Object.keys(IMPORT_FILES) as ImportKind[];
type Picked = { name: string; csv: string };

/**
 * Bringing existing books into a new office: three templates, checked row by row here,
 * then one item on the Desk that the owner approves before anything goes into the books.
 */
export function OnboardingSettings({ b }: { b: Business }) {
  const qc = useQueryClient();
  const owner = isOwner();
  const [booksFrom, setBooksFrom] = useState(b.booksFrom ?? `${b.asOf.slice(0, 8)}01`);
  const [files, setFiles] = useState<Partial<Record<ImportKind, Picked>>>({});
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const body = (): ImportCheck => ({ booksFrom, files: KINDS.flatMap((kind) => (files[kind] ? [{ kind, ...files[kind]! }] : [])) });
  const check = useMutation({ mutationFn: () => api.checkImport(body()), onSuccess: setPreview });
  const stage = useMutation({
    mutationFn: () => api.stageImport(body()),
    onSuccess: () => {
      setFiles({});
      setPreview(null);
      void qc.invalidateQueries();
    },
  });

  const pick = (kind: ImportKind) => async (e: { target: HTMLInputElement }) => {
    const f = e.target.files?.[0];
    setPreview(null);
    stage.reset();
    if (!f) return setFiles((x) => ({ ...x, [kind]: undefined }));
    if (f.size > IMPORT_MAX_BYTES) {
      e.target.value = "";
      return setTooBig(`${f.name} is over 1 MB. Split it into smaller files and bring them in one after another.`);
    }
    setTooBig(null);
    setFiles((x) => ({ ...x, [kind]: { name: f.name, csv: "" } }));
    const csv = await f.text();
    setFiles((x) => ({ ...x, [kind]: { name: f.name, csv } }));
  };
  const chosen = KINDS.filter((k) => files[k]?.csv);

  return (
    <Section title="Bring in your books">
      <p className="section-lede">
        Already keeping books in Tally, Excel or a notebook? Fill in the templates with your customers and suppliers, your products and stock, and the invoices and bills still unpaid. The Accountant checks every row; nothing goes into the books until {owner ? "you approve" : "the owner approves"} it on the Desk.
      </p>
      {b.booksFrom ? (
        <p>
          Your books start on <strong>{dateLabel(b.booksFrom)}</strong>. Anything from before then comes in as brought forward: it counts towards what is owed, but not towards GST returns or sales.
        </p>
      ) : null}
      <form
        className="settings-form onboarding"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview?.ready) stage.mutate();
          else check.mutate();
        }}
      >
        <div className="settings-grid">
          <div className="field field-wide">
            <label htmlFor="ob-from">Books start on</label>
            <input
              id="ob-from"
              className="input num"
              type="date"
              value={booksFrom}
              max={b.asOf}
              readOnly={Boolean(b.booksFrom)}
              aria-describedby="ob-from-help"
              onChange={(e) => {
                setBooksFrom(e.target.value);
                setPreview(null);
              }}
            />
            <span id="ob-from-help" className="field-help">
              {b.booksFrom ? "Fixed by the first import." : "Usually the first day of this month. Unpaid invoices and bills must be dated before it. Fixed once approved."}
            </span>
          </div>
          <p className="field-help field-wide">Fill in any of the templates in Excel or Google Sheets and save each as CSV. Leave out a template you do not need.</p>
          {KINDS.map((kind) => (
            <div className="field" key={kind}>
              <label htmlFor={`ob-${kind}`}>{IMPORT_FILES[kind].label}</label>
              <input id={`ob-${kind}`} className="input" type="file" accept=".csv,text/csv" onChange={pick(kind)} aria-describedby={`ob-${kind}-help`} />
              <span id={`ob-${kind}-help`} className="field-help">
                <a href={IMPORT_FILES[kind].template} download>
                  Download the template
                </a>
              </span>
            </div>
          ))}
        </div>
        {tooBig ? <p className="form-error">{tooBig}</p> : null}
        {preview ? <Preview p={preview} /> : null}
        <div className="approval-actions">
          {preview?.ready ? (
            <button type="submit" className="btn btn-primary" disabled={stage.isPending}>
              Send to the Desk for approval
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!chosen.length || check.isPending}>
              {check.isPending ? "Checking" : "Check the files"}
            </button>
          )}
          {stage.data ? (
            <span role="status">
              Waiting on the <Link to="/desk">Desk</Link> {owner ? "for your approval" : "for the owner"}.
            </span>
          ) : null}
          {check.error ?? stage.error ? <span className="form-error">{(check.error ?? stage.error)!.message}</span> : null}
        </div>
      </form>
    </Section>
  );
}

/** The Desk card for an import: what comes in, and the first few rows to recognise it by. */
export function ImportBody({ item }: { item: StagedChange }) {
  const p = item.payload as { counts?: Record<string, number>; sample?: string[] };
  const c = p.counts ?? {};
  const rows: [string, string][] = [
    ["Customers", String(c.customers ?? 0)],
    ["Suppliers", String(c.suppliers ?? 0)],
    ["Products", c.stock ? `${c.products ?? 0}, ${c.stock} with stock` : String(c.products ?? 0)],
    ["Owed to you", c.invoices ? `${inr(c.receivablePaise ?? 0, { symbol: true })} on ${c.invoices} invoice${c.invoices === 1 ? "" : "s"}` : "Nothing"],
    ["You owe", c.bills ? `${inr(c.payablePaise ?? 0, { symbol: true })} on ${c.bills} bill${c.bills === 1 ? "" : "s"}` : "Nothing"],
  ];
  return (
    <div className="import-body">
      <dl className="approval-context">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {p.sample?.length ? (
        <details className="approval-preview">
          <summary>The first rows</summary>
          <ul className="import-sample">
            {p.sample.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Preview({ p }: { p: ImportPreview }) {
  if (p.ready)
    return (
      <p role="status" className="onboarding-ready">
        Every row reads correctly: {importSummary(p.counts)}
        {p.counts.stock ? `, with stock for ${p.counts.stock}` : ""}. The books will start on {dateLabel(p.booksFrom)}.
      </p>
    );
  return (
    <div role="alert">
      <p className="form-error">
        {p.issues.length === 1 ? "One thing needs" : `${p.issues.length >= 200 ? "At least 200 things" : `${p.issues.length} things`} need`} fixing before these can come in. Correct the file and choose it again.
      </p>
      <table className="ledger onboarding-issues">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Row</th>
            <th scope="col">Column</th>
            <th scope="col">What to fix</th>
          </tr>
        </thead>
        <tbody>
          {p.issues.map((i, n) => (
            <tr key={n}>
              <td>{i.file ? (p.files.find((f) => f.kind === i.file)?.name ?? i.file) : "All files"}</td>
              <td className="num">{i.row || ""}</td>
              <td className="code">{i.column}</td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
