import { AGEING_BUCKETS, type Party, type PartyMsme, type PartyView } from "@office/contracts";
import { Amount, ApprovalCard, LedgerTable, Stamp } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client";
import { q, useChange, useDecide } from "../api/queries";
import { DocLink } from "../reports/accounts";
import { isOwner, Page, PageHead, Section, shortDate } from "./common";

export function PartyScreen() {
  const { partyId } = useParams({ from: "/parties/$partyId" });
  const party = useQuery(q.party(partyId));
  const decide = useDecide();
  const v = party.data;
  const p = v?.party;

  return (
    <Page ready={Boolean(v)} error={party.error}>
      {v && p ? (
        <>
          <PageHead
            back={{ to: "/boardroom/accounts/ageing", label: "Who owes you" }}
            title={p.name}
            lede={`${p.city}. ${p.kind === "customer" ? `Pays on ${p.paymentTermsDays ?? 30}-day terms` : "Supplier"}${p.gstin ? `, GSTIN ${p.gstin}` : ""}. ${p.contact.name}, ${p.contact.phone}, ${p.contact.email}.`}
          />
          {v.ageing ? (
            <dl className="register">
              <div>
                <dt>Owes you</dt>
                <dd>
                  <Amount paise={v.ageing.totalPaise} figureId={v.ageing.figureId} short />
                </dd>
              </div>
              <div>
                <dt>Overdue</dt>
                <dd>
                  <Amount paise={v.ageing.buckets.slice(1).reduce((a, b) => a + b, 0)} short tone={v.ageing.buckets[3]! + v.ageing.buckets[4]! > 0 ? "red" : undefined} />
                </dd>
              </div>
              <div>
                <dt>Oldest invoice</dt>
                <dd>{v.ageing.oldestDaysOverdue > 0 ? `${v.ageing.oldestDaysOverdue} days overdue` : "Not yet due"}</dd>
              </div>
              <div>
                <dt>Usually pays</dt>
                <dd>{v.ageing.avgDaysLate === null ? "No history" : v.ageing.avgDaysLate <= 0 ? "On time" : `${Math.round(v.ageing.avgDaysLate)} days late`}</dd>
              </div>
            </dl>
          ) : null}
          {v.reminders.filter((r) => r.status === "pending").map((r) => (
            <ApprovalCard key={r.id} item={r} readOnly={isOwner() ? false : "Waiting for the owner to approve."} onDecide={(d) => decide.mutate({ id: r.id, decision: d })} busy={decide.isPending} />
          ))}
          {v.open.length ? (
            <Section title="Open invoices">
              <LedgerTable
                caption="Open invoices"
                rows={v.open}
                rowKey={(r) => r.invoiceId}
                initialSort={{ id: "d" }}
                columns={[
                  { id: "n", header: "Invoice", cell: (r) => <DocLink docId={r.docId} region="number">{r.number}</DocLink> },
                  { id: "d", header: "Dated", cell: (r) => shortDate(r.date), sortBy: (r) => r.date },
                  { id: "due", header: "Due", cell: (r) => <DocLink docId={r.docId} region="dueDate">{shortDate(r.dueDate)}</DocLink>, sortBy: (r) => r.dueDate },
                  { id: "b", header: "Age", cell: (r) => AGEING_BUCKETS[r.bucket], secondary: true },
                  { id: "t", header: "Invoice total", cell: (r) => <Amount paise={r.totalPaise} />, numeric: true, secondary: true },
                  { id: "o", header: "Outstanding", cell: (r) => <Amount paise={r.outstandingPaise} />, numeric: true, footer: <Amount paise={v.open.reduce((a, r) => a + r.outstandingPaise, 0)} /> },
                  { id: "s", header: "", cell: (r) => (r.daysOverdue > 0 ? <Stamp kind="overdue" /> : null) },
                ]}
              />
            </Section>
          ) : null}
          {p.kind === "vendor" ? <MsmeCard partyId={p.id} party={p} /> : null}
          <Section title="Recent activity">
            <LedgerTable
              caption="Recent invoices and payments"
              rows={v.recent}
              rowKey={(r) => r.date + r.label}
              columns={[
                { id: "d", header: "Date", cell: (r) => shortDate(r.date) },
                { id: "l", header: "What", cell: (r) => (r.docId ? <DocLink docId={r.docId}>{r.label}</DocLink> : r.label) },
                { id: "a", header: "Amount", cell: (r) => <Amount paise={Math.abs(r.amountPaise)} tone={r.amountPaise < 0 ? "green" : undefined} />, numeric: true },
              ]}
            />
          </Section>
        </>
      ) : null}
    </Page>
  );
}

/** A supplier's Udyam registration: micro and small suppliers must be paid within 45 days, or 15 without a written agreement. */
function MsmeCard({ partyId, party }: { partyId: string; party: Party }) {
  const change = useChange<PartyView>();
  const [m, setM] = useState({ udyamCategory: party.udyamCategory ?? "none", udyamNumber: party.udyamNumber ?? "", udyamActivity: party.udyamActivity ?? "", days: party.writtenCreditDays === undefined ? "" : String(party.writtenCreditDays), related: party.related ?? false });
  const protectedSupplier = (m.udyamCategory === "micro" || m.udyamCategory === "small") && m.udyamActivity !== "trading";
  const days = m.days.trim() === "" ? null : Number(m.days);
  return (
    <Section title="MSME registration">
      <p className="section-lede">
        {protectedSupplier
          ? `Pay within ${days === null ? 15 : Math.min(45, days)} days of each bill. Later than that, the expense is not allowed for income tax until paid, interest at three times the bank rate is owed, and the company reports it on MSME-1.`
          : "Only micro and small manufacturers and service providers have the MSMED Act's 45-day protection; traders and medium enterprises do not."}
      </p>
      <form
        className="obligation-form-row"
        onSubmit={(e) => {
          e.preventDefault();
          const body: PartyMsme = { udyamCategory: m.udyamCategory, udyamNumber: m.udyamNumber.trim(), udyamActivity: (m.udyamActivity || null) as PartyMsme["udyamActivity"], writtenCreditDays: days, related: m.related };
          change.mutate(() => api.saveMsme(partyId, body));
        }}
      >
        <div className="field">
          <label htmlFor="msme-cat">Udyam category</label>
          <select id="msme-cat" className="input" value={m.udyamCategory} onChange={(e) => setM({ ...m, udyamCategory: e.target.value as PartyMsme["udyamCategory"] })}>
            <option value="none">Not registered</option>
            <option value="micro">Micro</option>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="msme-act">Registered for</label>
          <select id="msme-act" className="input" value={m.udyamActivity} onChange={(e) => setM({ ...m, udyamActivity: e.target.value as typeof m.udyamActivity })}>
            <option value="">Not known</option>
            <option value="manufacturing">Manufacturing</option>
            <option value="services">Services</option>
            <option value="trading">Trading</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="msme-no">Udyam number</label>
          <input id="msme-no" className="input code" placeholder="UDYAM-MH-26-0012345" maxLength={19} value={m.udyamNumber} onChange={(e) => setM({ ...m, udyamNumber: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="msme-days">Credit days agreed in writing</label>
          <input id="msme-days" className="input num" inputMode="numeric" placeholder="None" value={m.days} onChange={(e) => setM({ ...m, days: e.target.value.replace(/\D/g, "") })} />
        </div>
        <label className="form-check">
          <input type="checkbox" checked={m.related} onChange={(e) => setM({ ...m, related: e.target.checked })} /> A related party
        </label>
        <button type="submit" className="btn" disabled={change.isPending}>
          Save MSME details
        </button>
        {change.isSuccess ? <span role="status">Saved</span> : null}
        {change.error ? <span className="form-error">{change.error.message}</span> : null}
      </form>
    </Section>
  );
}
