import { BILL_FIELD_LABEL, BILL_REQUIRED, BillField, type BillMapping, missingBillFields, type SheetBillKind, type StagedChange } from "@office/contracts";
import { useEffect, useId, useState } from "react";

type Payload = { kind: SheetBillKind; mapping: BillMapping; headers: string[]; sample: string[][]; suggested?: BillField[] };

/**
 * A register in a new layout: which column holds each field, with the first rows under it, for the owner to confirm
 * once. What the owner changes goes with the approval; nothing is read until then (ADR 0010).
 */
export function SheetLayoutBody({ item, onChange }: { item: StagedChange; onChange: (edits: Record<string, unknown> | undefined) => void }) {
  const p = item.payload as Payload;
  const id = useId();
  const [kind, setKind] = useState<SheetBillKind>(p.kind);
  const [mapping, setMapping] = useState<BillMapping>(p.mapping);
  const editable = item.status === "pending";
  const missing = missingBillFields(mapping);
  const suggested = new Set(p.suggested ?? []);

  useEffect(() => {
    const changed = kind !== p.kind || JSON.stringify(mapping) !== JSON.stringify(p.mapping);
    onChange(changed ? { kind, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) } : undefined);
  }, [kind, mapping, p.kind, p.mapping, onChange]);

  return (
    <div className="os-mapping">
      <fieldset className="field" disabled={!editable}>
        <legend>These are</legend>
        <label className="check">
          <input type="radio" name={`${id}-kind`} checked={kind === "purchase_bill"} onChange={() => setKind("purchase_bill")} /> Bills from suppliers
        </label>
        <label className="check">
          <input type="radio" name={`${id}-kind`} checked={kind === "sales_invoice"} onChange={() => setKind("sales_invoice")} /> Invoices you issued
        </label>
      </fieldset>
      <div className="os-fields">
        {BillField.options.map((f) => (
          <label key={f}>
            <span>
              {BILL_FIELD_LABEL[f]}
              {BILL_REQUIRED.includes(f) ? " *" : ""}
              {suggested.has(f) && mapping[f] === p.mapping[f] ? " (suggested by AI)" : ""}
            </span>
            <select
              className="input"
              aria-label={BILL_FIELD_LABEL[f]}
              value={mapping[f] ?? ""}
              disabled={!editable}
              onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value || undefined }))}
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
          Choose the column for {missing.map((m) => BILL_FIELD_LABEL[m].toLowerCase()).join(", ")} before approving. A taxable value or a total is enough.
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
