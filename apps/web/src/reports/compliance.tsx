import { type Assignee, type ComplianceCheck, type ComplianceView as View, type MasterCheck, type Obligation, type SrnStatus } from "@office/contracts";
import { Amount, CoveringNote, LedgerTable, type LedgerColumn } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { compliance, savePaper, viewingAs } from "../api/client";
import { q, useChange } from "../api/queries";
import { count, longDate, Section, shortDate } from "../screens/common";

const STATE: Record<Obligation["state"], string> = { upcoming: "Due", preparing: "Being prepared", ready: "Ready to file", filed: "Filed", late: "Late", snoozed: "Snoozed" };
const WHO: Record<Assignee, string> = { owner: "You", ca: "The CA", cs: "The CS" };
const SRN_STATUS: Record<SrnStatus, string> = { draft: "Saved, not yet paid", pay_fees: "Waiting for the fee", under_processing: "Under processing", resubmission: "Sent back for resubmission", approved: "Approved", rejected: "Rejected" };
/** The books' date: a filing is marked on the day the books are at, not the computer's. */
const AsOf = createContext(new Date().toISOString().slice(0, 10));
const useToday = () => useContext(AsOf);
const LATER_SHOWN = 8;
const isOpen = (o: Obligation) => o.state !== "filed" && o.state !== "snoozed";

/** "4 of 6 answered: 31 filings found", with the way to the questions when some are open. */
export function ProfileProgress({ view }: { view: View }) {
  const done = view.answers.filter((a) => a.answered).length;
  const total = view.answers.length;
  const filings = view.obligations.filter((o) => o.source !== "manual").length;
  if (done === total) return <p className="muted">{`All ${total} questions answered: ${count(filings, "filing")} found.`}</p>;
  return (
    <p className="compliance-nudge">
      <strong>{`Answer ${total - done} more ${total - done === 1 ? "question" : "questions"} to finish your filing calendar.`}</strong>{" "}
      {`${done} of ${total} answered: ${count(filings, "filing")} found so far. Still open: ${view.answers.filter((a) => !a.answered).map((a) => a.question.toLowerCase()).join("; ")}.`}{" "}
      <Link to="/settings" hash="compliance">
        Answer them in Settings
      </Link>
    </p>
  );
}

/** The Compliance Officer's room: what is next, and how complete the profile is. */
export function ComplianceRoomCard({ view }: { view: View }) {
  const next = view.obligations.filter(isOpen).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1)).slice(0, 3);
  return (
    <>
      <Section title="Next up">
        <ProfileProgress view={view} />
        <ObligationLines items={next} />
        <p className="muted">
          <Link to="/boardroom/$team/$tab" params={{ team: "operations", tab: "compliance" }}>
            The whole calendar, with the checks from the books
          </Link>
        </p>
      </Section>
    </>
  );
}

function ObligationLines({ items, selected, onSelect }: { items: Obligation[]; selected?: string | null; onSelect?: (id: string | null) => void }) {
  if (!items.length) return <p className="muted">Nothing here.</p>;
  return (
    <ul className="obligations">
      {items.map((o) => (
        <li key={o.id} className={o.state === "late" ? "is-red" : o.state === "filed" ? "is-done" : undefined}>
          <div className="obligation-line">
            <span className="obligation-form">{o.form}</span>
            <span>
              {o.line}
              {o.override ? <span className="muted">{` Extended by ${o.override.circular}.`}</span> : null}
            </span>
            <span className="obligation-meta">
              {STATE[o.state]}
              {o.assignee ? `, ${WHO[o.assignee].toLowerCase()}` : ""}
            </span>
            {onSelect ? (
              <button type="button" className="btn btn-small" aria-expanded={selected === o.id} onClick={() => onSelect(selected === o.id ? null : o.id)}>
                {selected === o.id ? "Close" : "Open"}
              </button>
            ) : null}
          </div>
          {selected === o.id ? <ObligationDetail o={o} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The calendar, the checks from the books, and what the CA/CS needs to file. */
export function ComplianceView({ view }: { view: View }) {
  const [as, setAs] = useState<"owner" | "ca">(viewingAs() === "accountant" ? "ca" : "owner");
  const [selected, setSelected] = useState<string | null>(null);
  const [allLater, setAllLater] = useState(false);
  const late = view.obligations.filter((o) => o.state === "late");
  const open = view.obligations.filter((o) => o.state !== "late" && isOpen(o)).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  const lanes: [string, Obligation[]][] = [
    ["Late", late],
    ["This week", open.filter((o) => o.daysLeft <= 7)],
    ["This month", open.filter((o) => o.daysLeft > 7 && o.daysLeft <= 31)],
    ["Later", open.filter((o) => o.daysLeft > 31)],
  ];
  const snoozed = view.obligations.filter((o) => o.state === "snoozed");
  const filed = view.obligations.filter((o) => o.state === "filed").sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1));
  return (
    <AsOf.Provider value={view.asOf}>
      <CoveringNote note={view.note} from="From the Compliance Officer" />
      <ProfileProgress view={view} />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show the calendar for">
          <button type="button" aria-pressed={as === "owner"} onClick={() => setAs("owner")}>
            For the owner
          </button>
          <button type="button" aria-pressed={as === "ca"} onClick={() => setAs("ca")}>
            For the CA or CS
          </button>
        </div>
      </div>
      <dl className="register compliance-register">
        <div>
          <dt>At risk if nothing is done</dt>
          <dd>
            <Amount paise={view.atRiskPaise} figureId="compliance:at-risk" short tone={view.atRiskPaise ? "red" : undefined} label="At risk" />
          </dd>
        </div>
        <div>
          <dt>Late</dt>
          <dd>{late.length}</dd>
        </div>
        <div>
          <dt>Due in 30 days</dt>
          <dd>{open.filter((o) => o.daysLeft <= 30).length}</dd>
        </div>
        <div>
          <dt>Filed on time</dt>
          <dd>{`${view.health.filedOnTime} of ${view.health.filedOnTime + view.health.filedLate}`}</dd>
        </div>
        <div>
          <dt>Late fees paid</dt>
          <dd>
            <Amount paise={view.health.lateFeesPaise} short />
          </dd>
        </div>
      </dl>
      <p className="muted table-note">The office prepares and reminds; you or your CA file on the government portals.</p>
      {as === "owner" ? (
        <>
          {lanes.map(([title, items]) =>
            items.length || title !== "Late" ? (
              <Section key={title} title={title}>
                <ObligationLines items={title === "Later" && !allLater ? items.slice(0, LATER_SHOWN) : items} selected={selected} onSelect={setSelected} />
                {title === "Later" && items.length > LATER_SHOWN ? (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setAllLater(!allLater)}>
                    {allLater ? "Show the next few only" : `Show all ${items.length}, to ${shortDate(items.at(-1)!.dueOn)}`}
                  </button>
                ) : null}
              </Section>
            ) : null,
          )}
          {snoozed.length ? (
            <Section title="Snoozed">
              <ObligationLines items={snoozed} selected={selected} onSelect={setSelected} />
            </Section>
          ) : null}
        </>
      ) : (
        <>
          <InviteCa />
          <WorkingView view={view} selected={selected} onSelect={setSelected} />
        </>
      )}
      <ChecksPanel checks={view.checks} />
      {filed.length ? (
        <Section title="Filed">
          <details>
            <summary>{`${count(filed.length, "filing")} marked filed, newest first`}</summary>
            <ObligationLines items={filed} selected={selected} onSelect={setSelected} />
          </details>
        </Section>
      ) : null}
      <ManualItemForm />
      {as === "ca" ? <AuditTrail /> : null}
    </AsOf.Provider>
  );
}

/** The CA/CS works best from inside the office: offered to the owner when nobody has the accountant's role yet. */
function InviteCa() {
  const admin = useQuery({ ...q.officeAdmin(), enabled: viewingAs() === "owner" });
  const a = admin.data;
  if (!a || a.members.some((m) => m.role === "accountant") || a.invitations.some((i) => i.role === "accountant")) return null;
  return (
    <p className="compliance-nudge">
      {"Your CA or CS is not in the office yet. Invited as the accountant, they see this view, download the working papers and mark items filed with the proof. "}
      <Link to="/settings" hash="invite">
        Invite them in Settings
      </Link>
    </p>
  );
}

/** The CA/CS's list: every item, filtered by authority, with its figures. */
function WorkingView({ view, selected, onSelect }: { view: View; selected: string | null; onSelect: (id: string | null) => void }) {
  const [authority, setAuthority] = useState("all");
  const authorities = [...new Set(view.obligations.map((o) => o.authority))].sort();
  const rows = view.obligations.filter((o) => o.state !== "filed" && (authority === "all" || o.authority === authority)).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  const open = rows.find((o) => o.id === selected);
  const cols: LedgerColumn<Obligation>[] = [
    { id: "f", header: "Form", cell: (o) => <strong>{o.form}</strong>, sortBy: (o) => o.form },
    { id: "t", header: "For", cell: (o) => o.title, sortBy: (o) => o.title, secondary: true },
    { id: "a", header: "With", cell: (o) => o.authority, sortBy: (o) => o.authority, secondary: true },
    { id: "d", header: "Due", cell: (o) => shortDate(o.dueOn), sortBy: (o) => o.dueOn },
    { id: "s", header: "State", cell: (o) => `${STATE[o.state]}${o.assignee ? `, ${WHO[o.assignee].toLowerCase()}` : ""}`, sortBy: (o) => o.state },
    { id: "p", header: "To pay", cell: (o) => (o.amountPaise === null ? "" : <Amount paise={o.amountPaise} rupees />), sortBy: (o) => o.amountPaise ?? 0, numeric: true },
    { id: "l", header: "Late cost", cell: (o) => (o.lateCostPaise ? <Amount paise={o.lateCostPaise} rupees tone={o.state === "late" ? "red" : undefined} /> : ""), sortBy: (o) => o.lateCostPaise, numeric: true, secondary: true },
    {
      id: "x",
      header: "",
      cell: (o) => (
        <button type="button" className="btn btn-small" aria-expanded={selected === o.id} onClick={() => onSelect(selected === o.id ? null : o.id)}>
          {selected === o.id ? "Close" : "Open"}
        </button>
      ),
    },
  ];
  return (
    <Section
      title="Every open item"
      aside={
        <div className="field field-inline">
          <label htmlFor="cmp-authority">Authority</label>
          <select id="cmp-authority" className="input" value={authority} onChange={(e) => setAuthority(e.target.value)}>
            <option value="all">All</option>
            {authorities.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <LedgerTable caption="Open filings and payments" rows={rows} columns={cols} rowKey={(o) => o.id} initialSort={{ id: "d" }} rowTone={(o) => (o.state === "late" ? "red" : undefined)} limit={40} />
      {open ? (
        <div className="obligation-detail-standalone">
          <h3 className="h2">{`${open.form}: ${open.title}`}</h3>
          <ObligationDetail o={open} />
        </div>
      ) : null}
    </Section>
  );
}

/** Why it applies, what is needed, where to file, and the actions on it. */
function ObligationDetail({ o }: { o: Obligation }) {
  const change = useChange();
  const run = (f: () => Promise<unknown>) => change.mutate(f);
  const [paperError, setPaperError] = useState<string | null>(null);
  return (
    <div className="obligation-detail">
      <dl className="details">
        <div>
          <dt>Due</dt>
          <dd>{`${longDate(o.dueOn)}${o.state === "late" ? `, ${count(-o.daysLeft, "day")} late` : o.state === "filed" ? "" : `, in ${count(o.daysLeft, "day")}`}`}</dd>
        </div>
        <div>
          <dt>Why it applies</dt>
          <dd>{o.why}</dd>
        </div>
        {o.amountPaise !== null ? (
          <div>
            <dt>To pay with it</dt>
            <dd>
              <Amount paise={o.amountPaise} rupees />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{o.state === "late" ? "Cost so far" : "Cost of a week's delay"}</dt>
          <dd>
            {o.lateCostPaise ? <Amount paise={o.lateCostPaise} rupees tone={o.state === "late" ? "red" : undefined} /> : "Nothing"}
            {o.lateCostNote ? <span className="muted">{` ${o.lateCostNote}`}</span> : null}
          </dd>
        </div>
        {o.risk ? (
          <div>
            <dt>The worst case</dt>
            <dd className="is-red">{o.risk}</dd>
          </div>
        ) : null}
        {o.override ? (
          <div>
            <dt>Extended</dt>
            <dd>{`${o.override.circular}: ${o.override.note}`}</dd>
          </div>
        ) : null}
        {o.documents.length ? (
          <div>
            <dt>You will need</dt>
            <dd>
              <ul className="plain-list">
                {o.documents.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>File on</dt>
          <dd>
            <a href={o.portal.url} target="_blank" rel="noreferrer">
              {o.portal.name}
            </a>
          </dd>
        </div>
        {o.state === "filed" ? (
          <div>
            <dt>Filed</dt>
            <dd>
              {o.filedOn ? longDate(o.filedOn) : "Yes"}
              {o.ack ? `, acknowledgement ${o.ack}` : ""}
              {o.proof ? (
                <>
                  {", "}
                  {/^(\/|https?:)/.test(o.proof.file) ? (
                    <a href={o.proof.file} target="_blank" rel="noreferrer">
                      {o.proof.name}
                    </a>
                  ) : (
                    o.proof.name
                  )}
                </>
              ) : null}
            </dd>
          </div>
        ) : null}
        {o.snoozedUntil ? (
          <div>
            <dt>Snoozed until</dt>
            <dd>{`${longDate(o.snoozedUntil)}${o.snoozeReason ? `: ${o.snoozeReason}` : ""}`}</dd>
          </div>
        ) : null}
      </dl>
      {o.papers ? (
        <p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPaperError(null);
              compliance.paper(o.id).then(savePaper, (e: Error) => setPaperError(e.message));
            }}
          >
            Download the working papers
          </button>
          {paperError ? <span className="toolbar-error" role="alert">{` ${paperError}`}</span> : null}
        </p>
      ) : null}
      {o.state !== "filed" ? (
        <div className="obligation-actions">
          <AssignControls o={o} run={run} busy={change.isPending} />
          <FiledForm o={o} />
          <SnoozeForm o={o} run={run} busy={change.isPending} />
        </div>
      ) : (
        <p>
          <button type="button" className="btn btn-quiet" disabled={change.isPending} onClick={() => run(() => compliance.reopen(o.id))}>
            It is not filed after all
          </button>
        </p>
      )}
      {o.mca ? <FilingPackPanel o={o} /> : null}
      {o.source === "manual" ? (
        <p>
          <button type="button" className="btn btn-danger btn-small" disabled={change.isPending} onClick={() => run(() => compliance.removeManual(o.id))}>
            Remove this item
          </button>
        </p>
      ) : null}
      {change.error ? <p className="form-error">{change.error.message}</p> : null}
    </div>
  );
}

function AssignControls({ o, run, busy }: { o: Obligation; run: (f: () => Promise<unknown>) => void; busy: boolean }) {
  return (
    <div className="obligation-form-row">
      <div className="field">
        <label htmlFor={`who-${o.id}`}>Who is doing it</label>
        <select id={`who-${o.id}`} className="input" value={o.assignee ?? ""} disabled={busy} onChange={(e) => run(() => compliance.assign(o.id, { assignee: (e.target.value || null) as Assignee | null }))}>
          <option value="">Nobody yet</option>
          <option value="owner">You (the owner)</option>
          <option value="ca">The CA</option>
          <option value="cs">The CS</option>
        </select>
      </div>
      <button type="button" className="btn btn-small" disabled={busy || o.state === "preparing"} onClick={() => run(() => compliance.assign(o.id, { assignee: o.assignee, progress: "preparing" }))}>
        Being prepared
      </button>
      <button type="button" className="btn btn-small" disabled={busy || o.state === "ready"} onClick={() => run(() => compliance.assign(o.id, { assignee: o.assignee, progress: "ready" }))}>
        Ready to file
      </button>
    </div>
  );
}

function FiledForm({ o }: { o: Obligation }) {
  const change = useChange();
  const today = useToday();
  const [filedOn, setFiledOn] = useState(today);
  const [ack, setAck] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate(async () => {
      const proof = file ? await compliance.uploadProof(file) : null;
      return compliance.markFiled(o.id, { filedOn, ack: ack.trim(), proof });
    });
  };
  return (
    <form className="obligation-form-row" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`filed-${o.id}`}>Filed on</label>
        <input id={`filed-${o.id}`} className="input num" type="date" value={filedOn} max={today} onChange={(e) => setFiledOn(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`ack-${o.id}`}>Acknowledgement, challan or SRN</label>
        <input id={`ack-${o.id}`} className="input code" value={ack} maxLength={80} onChange={(e) => setAck(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`proof-${o.id}`}>Proof (PDF or picture, up to 10 MB)</label>
        <input id={`proof-${o.id}`} className="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <button type="submit" className="btn btn-primary" disabled={change.isPending || !filedOn}>
        Mark filed
      </button>
      {change.error ? <span className="form-error">{change.error.message}</span> : null}
    </form>
  );
}

function SnoozeForm({ o, run, busy }: { o: Obligation; run: (f: () => Promise<unknown>) => void; busy: boolean }) {
  const today = useToday();
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  if (o.state === "snoozed")
    return (
      <p>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run(() => compliance.snooze(o.id, { until: null, reason: "" }))}>
          Bring it back now
        </button>
      </p>
    );
  return (
    <details className="obligation-snooze">
      <summary>Snooze it</summary>
      <form
        className="obligation-form-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => compliance.snooze(o.id, { until, reason: reason.trim() }));
        }}
      >
        <div className="field">
          <label htmlFor={`until-${o.id}`}>Until</label>
          <input id={`until-${o.id}`} className="input num" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <div className="field field-wide">
          <label htmlFor={`why-${o.id}`}>Why</label>
          <input id={`why-${o.id}`} className="input" value={reason} maxLength={300} placeholder="For example: not applicable this year, the CA confirmed" onChange={(e) => setReason(e.target.value)} />
        </div>
        <button type="submit" className="btn" disabled={busy || !until || !reason.trim()}>
          Snooze
        </button>
      </form>
    </details>
  );
}

/** What the CA/CS needs on the MCA portal: master data, the figures, attachments, signers and the SRN. */
function FilingPackPanel({ o }: { o: Obligation }) {
  const pack = useQuery(q.compliancePack(o.id));
  if (!pack.data) return <p className="loading">Preparing the filing pack</p>;
  const p = pack.data;
  return (
    <section className="filing-pack" aria-label={`Filing pack for ${p.form}`}>
      <h4>{`Filing pack for ${p.form}`}</h4>
      <h5>Master data on the MCA portal</h5>
      {p.master.rows.length ? (
        <MasterRows rows={p.master.rows} />
      ) : (
        <p className="muted">Not checked yet. Paste the company's master data from the MCA portal below: wrong master data fails the form's pre-scrutiny, and it shows any filing the portal thinks is overdue.</p>
      )}
      {p.master.checkedOn ? <p className="muted table-note">{`Checked on ${longDate(p.master.checkedOn)}${p.master.status ? `; the portal shows the company as ${p.master.status}` : ""}.`}</p> : null}
      <MasterPaste />
      {p.prefill.length ? (
        <>
          <h5>What the form will ask for</h5>
          <LedgerTable
            caption="Values for the form"
            rows={p.prefill}
            rowKey={(r) => r.label}
            columns={[
              { id: "l", header: "Field", cell: (r) => r.label },
              { id: "v", header: "Value", cell: (r) => <span className="num">{r.value}</span> },
              { id: "f", header: "From", cell: (r) => r.from, secondary: true },
            ]}
          />
        </>
      ) : null}
      <h5>Attachments</h5>
      <ul className="plain-list">
        {p.attachments.map((a) => (
          <li key={a.name}>
            <strong>{a.name}</strong>
            {a.note ? <span className="muted">{`: ${a.note}`}</span> : null}
          </li>
        ))}
      </ul>
      <h5>Who signs</h5>
      {p.signers.length ? (
        <ul className="plain-list">
          {p.signers.map((s) => (
            <li key={s.name} className={s.ok ? undefined : "is-red"}>
              <strong>{s.name}</strong>
              {s.din ? <span className="num">{` (DIN ${s.din})`}</span> : null}
              {`: ${s.note}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="is-red">No director is marked as signing MCA forms. Mark one in the compliance profile, with their DSC's expiry date.</p>
      )}
      <h5>Steps on the portal</h5>
      <ol className="pack-steps">
        {p.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <SrnForm o={o} />
    </section>
  );
}

function MasterRows({ rows }: { rows: MasterCheck[] }) {
  return (
    <LedgerTable
      caption="Master data compared with the profile"
      rows={rows}
      rowKey={(r) => r.field}
      rowTone={(r) => (r.ok ? undefined : "red")}
      columns={[
        { id: "f", header: "Field", cell: (r) => r.field },
        { id: "p", header: "On the portal", cell: (r) => r.portal || <span className="muted">Not shown</span> },
        { id: "o", header: "In the office", cell: (r) => r.office || <span className="muted">Not entered</span> },
        { id: "n", header: "", cell: (r) => (r.ok ? "Matches" : r.note) },
      ]}
    />
  );
}

export function MasterPaste() {
  const change = useChange<{ rows: MasterCheck[] }>();
  const [text, setText] = useState("");
  return (
    <details className="master-paste">
      <summary>Paste the master data from the MCA portal</summary>
      <p className="field-help">On the MCA portal, open View Company or LLP Master Data, search the CIN, select all the text on the page and paste it here.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(() => compliance.checkMaster(text));
        }}
      >
        <textarea className="input" rows={6} aria-label="Master data from the MCA portal" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="approval-actions">
          <button type="submit" className="btn" disabled={change.isPending || text.trim().length < 20}>
            Check it against the profile
          </button>
          {change.data ? <span role="status">{change.data.rows.every((r) => r.ok) ? "Everything matches." : `${count(change.data.rows.filter((r) => !r.ok).length, "difference")} to fix.`}</span> : null}
        </div>
        {change.error ? <p className="form-error">{change.error.message}</p> : null}
      </form>
    </details>
  );
}

function SrnForm({ o }: { o: Obligation }) {
  const change = useChange();
  const today = useToday();
  const [s, setS] = useState({ number: o.srn?.number ?? "", createdOn: o.srn?.createdOn ?? today, challan: o.srn?.challan ?? "", status: (o.srn?.status ?? "pay_fees") as SrnStatus, remarks: o.srn?.remarks ?? "", resubmitBy: o.srn?.resubmitBy ?? "" });
  const set = (k: keyof typeof s) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value });
  return (
    <>
      <h5>Service request (SRN)</h5>
      {o.srn ? <p>{`SRN ${o.srn.number}, created ${longDate(o.srn.createdOn)}: ${SRN_STATUS[o.srn.status]}${o.srn.resubmitBy ? `. Resubmit by ${longDate(o.srn.resubmitBy)}` : ""}.`}</p> : <p className="muted">The SRN is created when the form is first saved on the portal. The signed form must be uploaded within 15 days of it, or the SRN lapses.</p>}
      <form
        className="obligation-form-row"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(() => compliance.srn(o.id, { ...s, number: s.number.trim(), resubmitBy: s.status === "resubmission" && s.resubmitBy ? s.resubmitBy : null }));
        }}
      >
        <div className="field">
          <label htmlFor={`srn-${o.id}`}>SRN</label>
          <input id={`srn-${o.id}`} className="input code" value={s.number} maxLength={20} onChange={set("number")} />
        </div>
        <div className="field">
          <label htmlFor={`srn-on-${o.id}`}>Created on</label>
          <input id={`srn-on-${o.id}`} className="input num" type="date" value={s.createdOn} onChange={set("createdOn")} />
        </div>
        <div className="field">
          <label htmlFor={`srn-ch-${o.id}`}>Challan</label>
          <input id={`srn-ch-${o.id}`} className="input code" value={s.challan} maxLength={40} onChange={set("challan")} />
        </div>
        <div className="field">
          <label htmlFor={`srn-st-${o.id}`}>Status</label>
          <select id={`srn-st-${o.id}`} className="input" value={s.status} onChange={set("status")}>
            {(Object.keys(SRN_STATUS) as SrnStatus[]).map((k) => (
              <option key={k} value={k}>
                {SRN_STATUS[k]}
              </option>
            ))}
          </select>
        </div>
        {s.status === "resubmission" ? (
          <>
            <div className="field">
              <label htmlFor={`srn-by-${o.id}`}>Resubmit by</label>
              <input id={`srn-by-${o.id}`} className="input num" type="date" value={s.resubmitBy} onChange={set("resubmitBy")} />
            </div>
            <div className="field field-wide">
              <label htmlFor={`srn-rm-${o.id}`}>The officer's remarks</label>
              <textarea id={`srn-rm-${o.id}`} className="input" rows={2} maxLength={1000} value={s.remarks} onChange={set("remarks")} />
            </div>
          </>
        ) : null}
        <button type="submit" className="btn" disabled={change.isPending || !s.number.trim()}>
          Save the SRN
        </button>
        {change.error ? <span className="form-error">{change.error.message}</span> : null}
      </form>
    </>
  );
}

/** The checks only the books can do: MSME dues, loans, advance tax, TDS gaps and limits about to be crossed. */
function ChecksPanel({ checks }: { checks: ComplianceCheck[] }) {
  if (!checks.length) return null;
  return (
    <Section title="Checks from the books">
      <ul className="compliance-checks">
        {checks.map((c) => (
          <li key={c.id} className={`check-${c.tone}`}>
            <div className="check-head">
              <strong>{c.title}</strong>
              {c.amountPaise ? <Amount paise={c.amountPaise} rupees tone={c.tone === "red" ? "red" : undefined} /> : null}
            </div>
            <p>{c.summary}</p>
            {c.rows.length ? (
              <details>
                <summary>{count(c.rows.length, "line")}</summary>
                <ul className="plain-list">
                  {c.rows.map((r, i) => (
                    <li key={`${r.label}-${i}`}>
                      <strong>{r.label}</strong>
                      {`: ${r.detail}`}
                      {r.amountPaise !== null ? (
                        <>
                          {" "}
                          <Amount paise={r.amountPaise} rupees />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {c.proposal ? (
              <p className="muted">
                {`Proposed on your desk: ${c.proposal.label}. `}
                <Link to="/desk">Open the desk</Link>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ManualItemForm() {
  const change = useChange();
  const [m, setM] = useState({ form: "", dueOn: "", description: "", authority: "" });
  const set = (k: keyof typeof m) => (e: { target: { value: string } }) => setM({ ...m, [k]: e.target.value });
  return (
    <Section title="Add something the calendar does not know">
      <p className="section-lede">A licence renewal, a pollution board consent, a lender's covenant: anything with a date. It gets the same reminders.</p>
      <form
        className="obligation-form-row"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(async () => {
            await compliance.addManual({ form: m.form.trim(), dueOn: m.dueOn, description: m.description.trim(), authority: m.authority.trim() || "Other" });
            setM({ form: "", dueOn: "", description: "", authority: "" });
          });
        }}
      >
        <div className="field">
          <label htmlFor="man-form">What it is</label>
          <input id="man-form" className="input" maxLength={60} value={m.form} placeholder="Factory licence" onChange={set("form")} />
        </div>
        <div className="field">
          <label htmlFor="man-due">Due on</label>
          <input id="man-due" className="input num" type="date" value={m.dueOn} onChange={set("dueOn")} />
        </div>
        <div className="field">
          <label htmlFor="man-auth">With</label>
          <input id="man-auth" className="input" maxLength={60} value={m.authority} placeholder="Directorate of Industrial Safety" onChange={set("authority")} />
        </div>
        <div className="field field-wide">
          <label htmlFor="man-desc">Note</label>
          <input id="man-desc" className="input" maxLength={300} value={m.description} onChange={set("description")} />
        </div>
        <button type="submit" className="btn" disabled={change.isPending || !m.form.trim() || !m.dueOn}>
          Add to the calendar
        </button>
        {change.error ? <span className="form-error">{change.error.message}</span> : null}
      </form>
    </Section>
  );
}

function AuditTrail() {
  const log = useQuery(q.complianceAudit());
  return (
    <Section title="Who did what">
      {log.data ? (
        log.data.entries.length ? (
          <ul className="plain-list audit-trail">
            {log.data.entries.slice(0, 30).map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="muted num">{`${shortDate(e.at)} ${e.at.slice(11, 16)}`}</span> {e.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing recorded yet.</p>
        )
      ) : (
        <p className="loading">Fetching the books</p>
      )}
    </Section>
  );
}

export function ComplianceReport({ children }: { children: (v: View) => ReactNode }) {
  const view = useQuery(q.compliance());
  return view.data ? <>{children(view.data)}</> : <p className="loading">Fetching the books</p>;
}
