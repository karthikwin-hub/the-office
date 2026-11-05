import type { AgeingReport, AgentRoomView, Document, MarketingReport, OperationsReport, PeopleReport, SalesTeamReport, SocialReport, StagedChange } from "@office/contracts";
import { AGENT_BY_ID, AGENTS, TEAMS } from "@office/contracts";
import { ApprovalCard, HireCard, LedgerTable, TeamLog, TrustLevel, useFigures } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { q, useDecide, useHire } from "../api/queries";
import { useReadStored, useUpload } from "../intake/intake";
import { AgeingView, FilingList } from "../reports/accounts";
import { InboxThreads, SocialRoomPanel, useApprovalBody } from "../reports/social";
import { CampaignsView, ComplianceView, OrdersView, PayrollView, PipelineView, PricesView, QuotesView, ReordersView, SlowStockView, StockView } from "../reports/teams";
import { count, isOwner, Page, PageHead, Register, Section, shortDate, theAgent, time, useApprovalContext } from "./common";
import { WhatsAppPhone } from "./WhatsAppPhone";
import { CustomerServicePanel } from "./CustomerService";
import { RoutineList } from "./Routines";

const ACCOUNTANT_MAY = new Set(["audit_flag", "share_file"]);

export function RoomScreen() {
  const { agentId } = useParams({ from: "/rooms/$agentId" });
  const room = useQuery(q.agent(agentId));
  const def = AGENT_BY_ID[agentId];
  if (!def) return <Page ready={false} error={{ status: 404, message: "No such room" }}>{null}</Page>;
  return (
    <Page ready={Boolean(room.data)} error={room.error} wide>
      {room.data ? <RoomBody v={room.data} /> : null}
    </Page>
  );
}

function RoomBody({ v }: { v: AgentRoomView }) {
  const def = AGENT_BY_ID[v.agentId]!;
  const team = TEAMS.find((t) => t.id === def.team)!;
  const owner = isOwner();
  const hire = useHire();
  const decide = useDecide();
  const contextFor = useApprovalContext();
  const bodyFor = useApprovalBody();
  const colleagues = AGENTS.filter((a) => a.team === def.team && a.id !== def.id);

  if (!v.state.hired) {
    return (
      <>
        <PageHead back={{ to: "/", label: "Floor" }} title={def.title} lede={`${team.wing}. This room is empty.`} />
        <div className="room-empty">
          <HireCard state={v.state} readOnly={!owner} busy={hire.isPending} onHire={() => hire.mutate({ agentId: def.id, change: { hired: true } })} />
          <WorkPanel agentId={def.id} preview />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        back={{ to: "/", label: "Floor" }}
        title={def.title}
        lede={def.job}
        aside={
          <div className="room-standing">
            <TrustLevel level={v.state.trustLevel} compact />
            <span className="muted">
              {v.accuracyPct === null ? "No work checked yet" : `${v.accuracyPct}% of ${count(v.state.accuracy.checked, "piece")} of work approved without changes`}
            </span>
          </div>
        }
      />
      <p className="room-now-line">
        <span className={`room-dot room-dot-${v.status.status}`} aria-hidden="true" />
        <span>{v.status.status === "working" ? "Working now: " : v.status.status === "waiting" ? "Waiting for you. Last: " : "Last: "}</span>
        {v.status.now}
      </p>
      <Register items={v.kpis} />
      {v.promotion && owner ? (
        <div className="promotion">
          <p>
            <strong>Ready for promotion to {v.promotion.to}.</strong> {v.promotion.reason}
          </p>
          <button type="button" className="btn btn-primary" disabled={hire.isPending} onClick={() => hire.mutate({ agentId: def.id, change: { trustLevel: v.promotion!.to } })}>
            Promote to {v.promotion.to}
          </button>
        </div>
      ) : null}
      <div className="room-layout">
        <div className="room-work">
          {v.pending.length ? (
            <Section title={`Waiting for you (${v.pending.length})`}>
              {v.pending.map((i) => (
                <ApprovalCard
                  key={i.id}
                  item={i}
                  showAgent={false}
                  context={contextFor(i)}
                  body={bodyFor(i)}
                  busy={decide.isPending && decide.variables?.id === i.id}
                  readOnly={!owner && !ACCOUNTANT_MAY.has(i.kind) ? "Waiting for the owner to approve." : false}
                  onDecide={(decision) => decide.mutate({ id: i.id, decision })}
                />
              ))}
            </Section>
          ) : null}
          <WorkPanel agentId={def.id} />
        </div>
        <aside className="room-side">
          <TeamLog title={`What ${theAgent(def.id)} did`} entries={v.log.slice(0, 14)} showAgent={false} empty="Nothing recorded yet." />
          <RoomRoutines agentId={def.id} />
          <section className="room-trust" aria-label="Trust level">
            {owner ? <TrustLevel level={v.state.trustLevel} onChange={(l) => hire.mutate({ agentId: def.id, change: { trustLevel: l } })} disabled={hire.isPending} /> : <TrustLevel level={v.state.trustLevel} compact />}
          </section>
          <section className="room-duties" aria-labelledby="duties">
            <h2 id="duties" className="team-log-title">
              Duties
            </h2>
            <ul>
              {def.duties.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            {colleagues.length ? (
              <p className="muted">
                Works with{" "}
                {colleagues.map((c, i) => (
                  <span key={c.id}>
                    {i ? (i === colleagues.length - 1 ? " and " : ", ") : ""}
                    <Link to="/rooms/$agentId" params={{ agentId: c.id }}>
                      {theAgent(c.id)}
                    </Link>
                  </span>
                ))}
                .
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </>
  );
}

function RoomRoutines({ agentId }: { agentId: string }) {
  const routines = useQuery(q.routines());
  const mine = (routines.data?.routines ?? []).filter((r) => r.agentId === agentId);
  if (!mine.length) return null;
  return (
    <section className="room-routines" aria-labelledby="room-routines">
      <h2 id="room-routines" className="team-log-title">
        Routines I run
      </h2>
      <RoutineList routines={mine} showAgent={false} />
      <p className="muted">
        <Link to="/routines">Every routine in the office</Link>
      </p>
    </section>
  );
}

/** The agent's own desk: the one report or inbox it works from. */
function WorkPanel({ agentId, preview }: { agentId: string; preview?: boolean }) {
  const p = (node: ReactNode) => (
    <div className={preview ? "room-preview" : undefined}>
      {preview ? <p className="preview-note">What this room would be working on, from your books today.</p> : null}
      {node}
    </div>
  );
  switch (agentId) {
    case "office-manager":
      return p(<OfficeManagerPanel />);
    case "accountant":
      return p(<AccountantPanel />);
    case "credit-controller":
      return p(<Q k="ageing">{(d) => <AgeingView report={d} compact />}</Q>);
    case "tax-clerk":
      return p(<TaxClerkPanel />);
    case "auditor":
      return p(<AuditorPanel />);
    case "sales-rep":
      return p(<Q k="salesTeam">{(d) => <PipelineView report={d} compact />}</Q>);
    case "quote-desk":
      return p(<Q k="salesTeam">{(d) => <QuotesView report={d} />}</Q>);
    case "account-manager":
      return p(<Q k="salesTeam">{(d) => <ReordersView report={d} />}</Q>);
    case "marketer":
      return p(<Q k="marketing">{(d) => <><CampaignsView report={d} compact /><SlowStockView report={d} /></>}</Q>);
    case "market-watcher":
      return p(<Q k="marketing">{(d) => <PricesView report={d} />}</Q>);
    case "social-media-manager":
      return p(<Q k="social">{(d) => (preview ? <InboxThreads report={d} compact /> : <SocialRoomPanel report={d} />)}</Q>);
    case "storekeeper":
      return p(<Q k="operations">{(d) => <StockView report={d} compact />}</Q>);
    case "buyer":
      return p(<Q k="operations">{(d) => <OrdersView report={d} />}</Q>);
    case "compliance-officer":
      return p(<Q k="operations">{(d) => <ComplianceView report={d} compact />}</Q>);
    case "payroll-clerk":
      return p(<Q k="people">{(d) => <PayrollView report={d} />}</Q>);
    case "customer-service":
      return p(<CustomerServicePanel preview={preview} />);
  }
  return null;
}

type Reports = { ageing: AgeingReport; salesTeam: SalesTeamReport; marketing: MarketingReport; social: SocialReport; operations: OperationsReport; people: PeopleReport };

/** Fetch one report and render it when it arrives. */
function Q<K extends keyof Reports>({ k, children }: { k: K; children: (d: Reports[K]) => ReactNode }) {
  const res = useQuery(q[k]() as never) as { data?: Reports[K] };
  return res.data ? <>{children(res.data)}</> : <p className="loading">Fetching the books</p>;
}

function OfficeManagerPanel() {
  const office = useQuery(q.office());
  const navigate = useNavigate();
  const waiting = office.data?.rooms.filter((r) => r.waitingCount > 0) ?? [];
  return (
    <>
      <Section title="This morning's digest">
        <p className="section-lede">Sent to you at the digest time. It lists what each agent needs from you, most urgent first.</p>
        <ul className="digest">
          {waiting
            .sort((a, b) => b.waitingCount - a.waitingCount)
            .map((r) => (
              <li key={r.agentId}>
                <Link to="/rooms/$agentId" params={{ agentId: r.agentId }}>
                  {AGENT_BY_ID[r.agentId]!.title}
                </Link>
                <span className="num">{count(r.waitingCount, "item")}</span>
                <span className="muted">{r.now}</span>
              </li>
            ))}
        </ul>
      </Section>
      <Section title="Ask a question">
        <p className="section-lede">Ask in your own words. Every figure in the answer opens the documents it was added up from.</p>
        <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: ".", search: (s) => ({ ...s, ask: "open" }), resetScroll: false })}>
          Ask the office manager
        </button>
      </Section>
      <Section title="On WhatsApp, in your own language">
        <WhatsAppPhone />
      </Section>
    </>
  );
}

const DOC_STATUS: Record<Document["status"], string> = { reading: "Reading now", staged: "Waiting for approval", posted: "Posted", rejected: "Rejected" };

type Intake = { key: string; name: string; state: "reading" | "done" | "failed"; message: string; staged?: StagedChange | null; docId?: string };

function DocumentIntake() {
  const upload = useUpload();
  const [over, setOver] = useState(false);
  const [intake, setIntake] = useState<Intake[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const update = (key: string, next: Partial<Intake>) => setIntake((xs) => xs.map((x) => (x.key === key ? { ...x, ...next } : x)));
  const take = async (files: FileList | File[]) => {
    for (const file of [...files]) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setIntake((xs) => [{ key, name: file.name, state: "reading", message: "Reading the page" }, ...xs]);
      try {
        const r = await upload.mutateAsync(file);
        update(key, { state: "done", message: r.message, staged: r.staged, docId: r.document.id });
      } catch (e) {
        update(key, { state: "failed", message: e instanceof Error ? e.message : "Could not send the file." });
      }
    }
  };
  return (
    <>
      <div
        className={`dropzone${over ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files);
        }}
      >
        <p>
          <strong>Drop bills or invoices here</strong>, <button type="button" className="link-button" onClick={() => inputRef.current?.click()}>choose files</button>, or forward them by email.
        </p>
        <p className="muted">PDFs and photos. The Accountant reads each page, keeps a link to where every figure was printed, and prepares the ledger entry for you to approve.</p>
        <input ref={inputRef} type="file" accept="application/pdf,image/jpeg,image/png" multiple hidden onChange={(e) => e.target.files && void take(e.target.files)} />
      </div>
      {intake.length > 0 && <IntakeList items={intake} />}
    </>
  );
}

function IntakeList({ items }: { items: Intake[] }) {
  const { openDocument } = useFigures();
  return (
    <ul className="intake" aria-live="polite">
      {items.map((x) => (
        <li key={x.key} className={`intake-${x.state}`}>
          <span className="intake-name">{x.name}</span>
          <span className={x.state === "reading" ? "loading" : undefined}>{x.message}</span>
          <span className="intake-links">
            {x.docId && x.state === "done" && (
              <button type="button" className="figure-link" onClick={() => openDocument(x.docId!, "totals.total")}>
                See what was read
              </button>
            )}
            {x.staged?.status === "pending" && <Link to="/desk">On your desk</Link>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Unread({ docs }: { docs: Document[] }) {
  const read = useReadStored();
  const [results, setResults] = useState<Intake[]>([]);
  if (!docs.length && !results.length) return null;
  const go = async (d: Document) => {
    const key = d.id;
    setResults((xs) => [{ key, name: d.from ? `From ${d.from}` : d.id, state: "reading", message: "Reading the page" }, ...xs.filter((x) => x.key !== key)]);
    try {
      const r = await read.mutateAsync(d);
      setResults((xs) => xs.map((x) => (x.key === key ? { ...x, state: "done", message: r.message, staged: r.staged, docId: d.id } : x)));
    } catch (e) {
      setResults((xs) => xs.map((x) => (x.key === key ? { ...x, state: "failed", message: e instanceof Error ? e.message : "Could not read it." } : x)));
    }
  };
  return (
    <div className="unread">
      {docs.length > 0 && (
        <>
          <p>
            {docs.length === 1 ? "One document" : `${docs.length} documents`} arrived by email and {docs.length === 1 ? "is" : "are"} waiting to be read. The Accountant reads emailed PDFs in your browser while the office is open.
          </p>
          <ul className="unread-list">
            {docs.map((d) => (
              <li key={d.id}>
                <span>
                  {d.from ?? "Unknown sender"}, {shortDate(d.receivedAt)} {time(d.receivedAt)}
                </span>
                <button type="button" className="btn" disabled={read.isPending} onClick={() => void go(d)}>
                  Read now
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {results.length > 0 && <IntakeList items={results} />}
    </div>
  );
}

function AccountantPanel() {
  const docs = useQuery(q.documents());
  const { openDocument } = useFigures();
  const recent = (docs.data ?? []).slice(0, 14);
  const unread = (docs.data ?? []).filter((d) => d.status === "reading");
  return (
    <>
      <Section title="Documents in">
        <DocumentIntake />
        <Unread docs={unread} />
        <LedgerTable<Document>
          caption="Documents received, newest first"
          rows={recent}
          rowKey={(d) => d.id}
          columns={[
            { id: "t", header: "Received", cell: (d) => `${shortDate(d.receivedAt)}, ${time(d.receivedAt)}` },
            { id: "k", header: "What", cell: (d) => <button type="button" className="figure-link" onClick={() => openDocument(d.id, "number")}>{d.kind === "sales_invoice" ? "Sales invoice" : "Purchase bill"}</button> },
            { id: "f", header: "From", cell: (d) => d.from ?? { generated: "Your billing", upload: "Uploaded", email: "Email", whatsapp: "WhatsApp" }[d.channel], secondary: true },
            { id: "s", header: "Status", cell: (d) => DOC_STATUS[d.status] },
          ]}
        />
      </Section>
    </>
  );
}

function TaxClerkPanel() {
  const gst = useQuery(q.gst());
  const tds = useQuery(q.tds());
  return (
    <>
      <Section title="Returns" aside={<Link to="/boardroom/$team/$tab" params={{ team: "accounts", tab: "gst" }}>Open the GST report</Link>}>
        {gst.data ? <FilingList filings={gst.data.filings} /> : <p className="loading">Fetching the books</p>}
      </Section>
      <Section title="TDS this quarter" aside={<Link to="/boardroom/$team/$tab" params={{ team: "accounts", tab: "tds" }}>Open the TDS report</Link>}>
        {tds.data ? (
          <ul className="filings">
            {tds.data.bySection.map((s) => (
              <li key={s.section}>
                <span className="filings-form">{s.section}</span>
                <span>{s.nature}</span>
                <span className="muted">{count(s.deductees, "deductee")}</span>
                <span className="num">{(s.tdsPaise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}

function AuditorPanel() {
  const audit = useQuery(q.audit());
  const f = audit.data?.findings ?? [];
  return (
    <Section title="Differences found" aside={<Link to="/audit">Open the comparison</Link>}>
      <ul className="digest">
        {f.map((x) => (
          <li key={x.id}>
            <Link to="/audit">{x.title}</Link>
            <span className="muted">
              {x.form}, {x.period}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
