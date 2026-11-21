import { missingFor, SHEET_KINDS, type SheetBillKind, type SheetKind, type SheetMapping, type StagedChange } from "@office/contracts";
import { useEffect, useId, useState } from "react";

type Payload = {
  sheetKind?: SheetKind;
  kinds?: SheetKind[];
  kind?: SheetBillKind;
  mapping: SheetMapping;
  headers: string[];
  sample: string[][];
  suggested?: string[];
};

/**
 * A spreadsheet in a new layout: what it is, which column holds each field, and the first rows under them, for the
 * owner to confirm once. What the owner changes goes with the approval; nothing is read until then (ADR 0010).
 */
export function SheetLayoutBody({ item, onChange }: { item: StagedChange; onChange: (edits: Record<string, unknown> | undefined) => void }) {
  const p = item.payload as Payload;
  const id = useId();
  const first = p.sheetKind ?? "bill_register";
  const [sheetKind, setSheetKind] = useState<SheetKind>(first);
  const [kind, setKind] = useState<SheetBillKind | undefined>(p.kind ?? (first === "bill_register" ? "purchase_bill" : undefined));
  const [mapping, setMapping] = useState<SheetMapping>(p.mapping);
  const editable = item.status === "pending";
  const spec = SHEET_KINDS[sheetKind];
  const missing = missingFor(sheetKind, mapping);
  const required = new Set(spec.needs.filter((n) => n.length === 1).map((n) => n[0]!));
  const suggested = new Set(p.suggested ?? []);
  const kinds = (p.kinds ?? [first]).filter((k) => SHEET_KINDS[k]);

  useEffect(() => {
    const clean = Object.fromEntries(Object.entries(mapping).filter(([f, v]) => v && Object.hasOwn(spec.fields, f)));
    const changed = sheetKind !== first || kind !== p.kind || JSON.stringify(clean) !== JSON.stringify(p.mapping);
    onChange(changed ? { sheetKind, ...(sheetKind === "bill_register" ? { kind: kind ?? "purchase_bill" } : {}), mapping: clean } : undefined);
  }, [sheetKind, kind, mapping, first, p.kind, p.mapping, spec.fields, onChange]);

  return (
    <div className="os-mapping">
      {kinds.length > 1 ? (
        <div className="field">
          <label htmlFor={`${id}-what`}>This file is</label>
          <select id={`${id}-what`} className="input" value={sheetKind} disabled={!editable} onChange={(e) => setSheetKind(e.target.value as SheetKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {SHEET_KINDS[k].label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {sheetKind === "bill_register" ? (
        <fieldset className="field" disabled={!editable}>
          <legend>These are</legend>
          <label className="check">
            <input type="radio" name={`${id}-kind`} checked={kind !== "sales_invoice"} onChange={() => setKind("purchase_bill")} /> Bills from suppliers
          </label>
          <label className="check">
            <input type="radio" name={`${id}-kind`} checked={kind === "sales_invoice"} onChange={() => setKind("sales_invoice")} /> Invoices you issued
          </label>
        </fieldset>
      ) : null}
      <div className="os-fields">
        {Object.entries(spec.fields).map(([f, label]) => (
          <label key={f}>
            <span>
              {label}
              {required.has(f) ? " *" : ""}
              {suggested.has(f) && mapping[f] === p.mapping[f] ? " (suggested by AI)" : ""}
            </span>
            <select
              className="input"
              aria-label={label}
              value={mapping[f] ?? ""}
              disabled={!editable}
              onChange={(e) =>
                setMapping((m) => {
                  const next = { ...m };
                  if (e.target.value) next[f] = e.target.value;
                  else delete next[f];
                  return next;
                })
              }
            >
              <option value="">Not in this file</option>
              {p.headers.filter(Boolean).map((h, i) => (
                <option key={`${h}-${i}`} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {missing.length && editable ? (
        <p className="form-error" role="status">
          Choose the column for {missing.map((m) => spec.fields[m]!.toLowerCase()).join(", ")} before approving.
        </p>
      ) : null}
      {p.sample.length ? (
        <div className="os-sample" role="region" aria-label="The first rows" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {p.headers.map((h, i) => (
                  <th key={`${h}-${i}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.sample.map((r, i) => (
                <tr key={i}>
                  {p.headers.map((_, j) => (
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
