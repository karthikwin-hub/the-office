import { AGEING_BUCKETS } from "@office/contracts";
import { Amount, ApprovalCard, LedgerTable, Stamp } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { q, useDecide } from "../api/queries";
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
