import { type Business, type CompanyEventKind, type CompanyLoan, type ComplianceFlags, type ComplianceProfile, type Director, type Shareholder } from "@office/contracts";
import { inr } from "@office/engine";
import { LedgerTable } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { compliance, savePaper } from "../api/client";
import { q, useChange } from "../api/queries";
import { MasterPaste } from "../reports/compliance";
import { count, longDate, Section, shortDate } from "./common";

const rupees = (paise: number | null) => (paise === null ? "" : String(Math.round(paise / 100)));
const paise = (text: string): number | null => {
  const n = Number(text.replace(/[,\s₹]/g, ""));
  return text.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
};
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const fyOfDate = (iso: string) => {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return m >= 4 ? y : y - 1;
};
const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;

const FLAGS: [keyof ComplianceFlags, string][] = [
  ["foreignInvestment", "A shareholder or lender is outside India (FLA return, FC-GPR)"],
  ["exportsUnderLut", "We export without paying IGST, under a LUT"],
  ["jobWork", "We send goods out for job work (ITC-04)"],
  ["demat", "Our shares are in demat, with an ISIN (PAS-6)"],
  ["foreignPayments", "We pay suppliers or services abroad (Forms 145 and 146)"],
  ["sft", "We report specified financial transactions (Form 61A)"],
  ["transferPricing", "We deal with related companies abroad or have specified domestic transactions (transfer pricing)"],
  ["salaryTds", "We deduct TDS from salaries (Form 138, Form 130)"],
];
type LoanKind = CompanyLoan["kind"];
const LOAN_KINDS: Record<LoanKind, string> = { director: "Director", shareholder: "Shareholder", related_company: "Related company", bank: "Bank", nbfc: "NBFC", other: "Other" };
const EVENT_KINDS: [CompanyEventKind, string][] = [
  ["special_resolution", "A special resolution was passed (MGT-14)"],
  ["shares_allotted", "Shares were allotted (PAS-3)"],
  ["ben1_received", "A significant beneficial owner declared on BEN-1 (BEN-2)"],
  ["auditor_resigned", "The auditor resigned (ADT-3, and a new ADT-1)"],
  ["director_contact_changed", "A director's address or email changed (DIR-6)"],
];

/** The six questions and the rest of the company, for the filing calendar. Prefilled from what the books know. */
export function ComplianceSettings({ b }: { b: Business }) {
  const view = useQuery(q.compliance());
  return (
    <Section title="Compliance profile" id="compliance">
      {view.data ? (
        <>
          <ProfileForm b={b} initial={view.data.profile} answered={view.data.answers.filter((a) => a.answered).length} questions={view.data.answers.length} filings={view.data.obligations.filter((o) => o.source !== "manual").length} small={view.data.small} />
          <EventForm />
          <MasterPaste />
        </>
      ) : (
        <p className="loading">Fetching the books</p>
      )}
    </Section>
  );
}

function ProfileForm({ b, initial, answered, questions, filings, small }: { b: Business; initial: ComplianceProfile; answered: number; questions: number; filings: number; small: { value: boolean | null; reason: string } }) {
  const save = useChange();
  const [p, setP] = useState<ComplianceProfile>(initial);
  const [capital, setCapital] = useState({ authorised: rupees(initial.authorisedCapitalPaise), paidUp: rupees(initial.paidUpCapitalPaise), profit: rupees(initial.netProfitPaise), worth: rupees(initial.netWorthPaise), tax: rupees(initial.estimatedTaxPaise) });
  const [meetings, setMeetings] = useState(initial.boardMeetings.join(", "));
  const [saved, setSaved] = useState(false);
  const lastAgm = [...p.agms].sort((x, y) => (x.heldOn < y.heldOn ? 1 : -1))[0];
  const put = (change: Partial<ComplianceProfile>) => {
    setSaved(false);
    setP({ ...p, ...change });
  };
  const text = (k: "cin" | "roc" | "registeredOffice" | "auditor", label: string, extra: { placeholder?: string; className?: string; help?: string } = {}) => (
    <div className={`field${k === "registeredOffice" ? " field-wide" : ""}`}>
      <label htmlFor={`cp-${k}`}>{label}</label>
      <input id={`cp-${k}`} className={`input ${extra.className ?? ""}`} placeholder={extra.placeholder} value={p[k]} onChange={(e) => put({ [k]: k === "cin" ? e.target.value.toUpperCase() : e.target.value })} />
      {extra.help ? <span className="field-help">{extra.help}</span> : null}
    </div>
  );
  const money = (k: keyof typeof capital, label: string, help?: string) => (
    <div className="field">
      <label htmlFor={`cp-${k}`}>{label}</label>
      <div className="input-suffix input-suffix-wide">
        <span>₹</span>
        <input id={`cp-${k}`} className="input num" inputMode="numeric" value={capital[k]} onChange={(e) => {
            setSaved(false);
            setCapital({ ...capital, [k]: e.target.value });
          }} />
      </div>
      {help ? <span className="field-help">{help}</span> : null}
    </div>
  );
  const submit = () => {
    const boardMeetings = meetings
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
      .sort();
    const next: ComplianceProfile = {
      ...p,
      authorisedCapitalPaise: paise(capital.authorised) ?? 0,
      paidUpCapitalPaise: paise(capital.paidUp),
      netProfitPaise: paise(capital.profit),
      netWorthPaise: paise(capital.worth),
      estimatedTaxPaise: paise(capital.tax),
      boardMeetings,
    };
    save.mutate(async () => {
      const v = await compliance.saveProfile(next);
      setP(v.profile);
      setSaved(true);
      return v;
    });
  };

  return (
    <form
      className="settings-form compliance-profile"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="section-lede">{`${answered} of ${questions} answered: ${count(filings, "filing")} found. The Compliance Officer works out every filing the company owes from these answers and the books, and raises a new one when something here changes.`}</p>
      <dl className="details">
        <div>
          <dt>From the books</dt>
          <dd>{`PAN ${b.pan || "not entered"}, GSTIN ${b.gstin || "not entered"}, TAN ${b.tan || "not entered"}, turnover last year ${inr(b.prevYearTurnoverPaise, { symbol: true, rupees: true })}`}</dd>
        </div>
        <div>
          <dt>Small company</dt>
          <dd>{small.reason}</dd>
        </div>
      </dl>
      <fieldset>
        <legend className="h2">The company</legend>
        <div className="settings-grid">
          {text("cin", "CIN", { className: "code", placeholder: "U31900MH2012PTC123456" })}
          <div className="field">
            <label htmlFor="cp-inc">Incorporated on</label>
            <input id="cp-inc" className="input num" type="date" value={p.incorporatedOn ?? ""} onChange={(e) => put({ incorporatedOn: e.target.value || null })} />
          </div>
          {text("roc", "Registrar of Companies", { placeholder: "ROC Pune", help: "The ROC jurisdictions were redrawn on 16 February 2026; check the one on your master data." })}
          {text("registeredOffice", "Registered office")}
          {money("authorised", "Authorised capital")}
          {money("paidUp", "Paid-up capital")}
          {money("profit", "Net profit last year", "Before tax, from the audited accounts. Sets whether CSR applies.")}
          {money("worth", "Net worth last year")}
          <label className="form-check field-wide">
            <input type="checkbox" checked={p.holdingOrSubsidiary} onChange={(e) => put({ holdingOrSubsidiary: e.target.checked })} /> The company is a holding or subsidiary company of another company
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="h2">Meetings and the auditor</legend>
        <div className="settings-grid">
          <div className="field">
            <label htmlFor="cp-agm">Last AGM held on</label>
            <input
              id="cp-agm"
              className="input num"
              type="date"
              value={lastAgm?.heldOn ?? ""}
              onChange={(e) => {
                const heldOn = e.target.value;
                const others = p.agms.filter((a) => a !== lastAgm);
                put({ agms: heldOn ? [...others, { fy: fyLabel(fyOfDate(heldOn) - 1), heldOn }] : others });
              }}
            />
            <span className="field-help">{lastAgm ? `Adopted the accounts for ${lastAgm.fy}.` : "Leave blank if the company has not held its first AGM."}</span>
          </div>
          <div className="field">
            <label htmlFor="cp-plan">Next AGM planned for</label>
            <input id="cp-plan" className="input num" type="date" value={p.plannedAgmOn ?? ""} onChange={(e) => put({ plannedAgmOn: e.target.value || null })} />
          </div>
          <div className="field field-wide">
            <label htmlFor="cp-meet">Board meetings held this year</label>
            <input id="cp-meet" className="input num" placeholder="2026-05-14, 2026-08-09" value={meetings} onChange={(e) => {
              setSaved(false);
              setMeetings(e.target.value);
            }} />
            <span className="field-help">Dates as YYYY-MM-DD, separated by commas. No more than 120 days may pass between two meetings.</span>
          </div>
          {text("auditor", "Statutory auditor")}
          <div className="field">
            <label htmlFor="cp-term">Auditor's term ends with the AGM for</label>
            <input id="cp-term" className="input num" placeholder="2026-27" value={p.auditorTermEndsFy ?? ""} onChange={(e) => put({ auditorTermEndsFy: /^\d{4}-\d{2}$/.test(e.target.value) ? e.target.value : e.target.value ? p.auditorTermEndsFy : null })} />
          </div>
        </div>
      </fieldset>
      <fieldset>
        <legend className="h2">Tax and payroll</legend>
        <div className="settings-grid">
          <div className="field">
            <label htmlFor="cp-gst">GST returns</label>
            <select id="cp-gst" className="input" value={p.gstFrequency ?? ""} onChange={(e) => put({ gstFrequency: (e.target.value || null) as ComplianceProfile["gstFrequency"] })}>
              <option value="">Not answered</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly, under QRMP</option>
            </select>
          </div>
          <YesNo id="cp-pf" label="Registered for PF" value={p.pf} onChange={(v) => put({ pf: v })} />
          <YesNo id="cp-esi" label="Registered for ESI" value={p.esi} onChange={(v) => put({ esi: v })} />
          <div className="field">
            <label htmlFor="cp-pt">Professional tax state code</label>
            <input id="cp-pt" className="input num" maxLength={2} placeholder={b.stateCode} value={p.ptState} onChange={(e) => put({ ptState: e.target.value.replace(/\D/g, "") })} />
            <span className="field-help">Blank uses the state of the GSTIN.</span>
          </div>
          <div className="field">
            <label htmlFor="cp-ta">Tax audit</label>
            <select id="cp-ta" className="input" value={p.taxAudit} onChange={(e) => put({ taxAudit: e.target.value as ComplianceProfile["taxAudit"] })}>
              <option value="auto">Work it out from turnover</option>
              <option value="yes">Yes, it applies</option>
              <option value="no">No, it does not</option>
            </select>
          </div>
          {money("tax", "This year's tax, as the CA estimates it", "Leave blank to use the office's estimate from the books.")}
        </div>
      </fieldset>
      <fieldset>
        <legend className="h2">What else applies</legend>
        <div className="flag-list">
          {FLAGS.map(([k, label]) => (
            <label key={k} className="form-check">
              <input type="checkbox" checked={p.flags[k]} onChange={(e) => put({ flags: { ...p.flags, [k]: e.target.checked } })} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <Rows<Director>
        title="Directors"
        help="Changes here start the ROC clocks: a director joining or leaving needs DIR-12 within 30 days. Mark who signs MCA forms, with their DSC's expiry date."
        rows={p.directors}
        onChange={(directors) => put({ directors })}
        blank={() => ({ id: uid("dir"), name: "", din: "", designation: "Director", appointedOn: null, kycDoneOn: null, dscExpiresOn: null, mcaSigner: false })}
        addLabel="Add a director"
        render={(d, set) => (
          <>
            <Cell label="Name">
              <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} />
            </Cell>
            <Cell label="DIN">
              <input className="input code" maxLength={8} value={d.din} onChange={(e) => set({ din: e.target.value.replace(/\D/g, "") })} />
            </Cell>
            <Cell label="Designation">
              <input className="input" value={d.designation} onChange={(e) => set({ designation: e.target.value })} />
            </Cell>
            <Cell label="Appointed on">
              <input className="input num" type="date" value={d.appointedOn ?? ""} onChange={(e) => set({ appointedOn: e.target.value || null })} />
            </Cell>
            <Cell label="Last DIR-3 KYC">
              <input className="input num" type="date" value={d.kycDoneOn ?? ""} onChange={(e) => set({ kycDoneOn: e.target.value || null })} />
            </Cell>
            <Cell label="DSC expires">
              <input className="input num" type="date" value={d.dscExpiresOn ?? ""} onChange={(e) => set({ dscExpiresOn: e.target.value || null })} />
            </Cell>
            <label className="form-check">
              <input type="checkbox" checked={d.mcaSigner} onChange={(e) => set({ mcaSigner: e.target.checked })} /> Signs MCA forms
            </label>
          </>
        )}
      />
      <Rows<CompanyLoan>
        title="Loans the company has taken"
        help="For DPT-3 by 30 June. A secured loan also needs its charge registered on CHG-1 within 30 days, and satisfied on CHG-4 when repaid."
        rows={p.loans}
        onChange={(loans) => put({ loans })}
        blank={() => ({ id: uid("loan"), lender: "", kind: "bank", amountPaise: 0, takenOn: new Date().toISOString().slice(0, 10), secured: false, closedOn: null })}
        addLabel="Add a loan"
        render={(l, set) => (
          <>
            <Cell label="Lender">
              <input className="input" value={l.lender} onChange={(e) => set({ lender: e.target.value })} />
            </Cell>
            <Cell label="Kind">
              <select className="input" value={l.kind} onChange={(e) => set({ kind: e.target.value as LoanKind })}>
                {(Object.keys(LOAN_KINDS) as LoanKind[]).map((k) => (
                  <option key={k} value={k}>
                    {LOAN_KINDS[k]}
                  </option>
                ))}
              </select>
            </Cell>
            <Cell label="Amount (₹)">
              <input className="input num" inputMode="numeric" value={rupees(l.amountPaise)} onChange={(e) => set({ amountPaise: paise(e.target.value) ?? 0 })} />
            </Cell>
            <Cell label="Taken on">
              <input className="input num" type="date" value={l.takenOn} onChange={(e) => set({ takenOn: e.target.value })} />
            </Cell>
            <Cell label="Repaid on">
              <input className="input num" type="date" value={l.closedOn ?? ""} onChange={(e) => set({ closedOn: e.target.value || null })} />
            </Cell>
            <label className="form-check">
              <input type="checkbox" checked={l.secured} onChange={(e) => set({ secured: e.target.checked })} /> Secured
            </label>
          </>
        )}
      />
      <Rows<Shareholder>
        title="Shareholders"
        help="MGT-7 asks for the shareholder list and the number of shareholders by gender."
        rows={p.shareholders}
        onChange={(shareholders) => put({ shareholders })}
        blank={() => ({ id: uid("sh"), name: "", shares: 0, gender: "male", foreign: false })}
        addLabel="Add a shareholder"
        render={(s, set) => (
          <>
            <Cell label="Name">
              <input className="input" value={s.name} onChange={(e) => set({ name: e.target.value })} />
            </Cell>
            <Cell label="Shares">
              <input className="input num" inputMode="numeric" value={String(s.shares)} onChange={(e) => set({ shares: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
            </Cell>
            <Cell label="Holder">
              <select className="input" value={s.gender} onChange={(e) => set({ gender: e.target.value as Shareholder["gender"] })}>
                <option value="male">Man</option>
                <option value="female">Woman</option>
                <option value="other">Other</option>
                <option value="entity">A company or body</option>
              </select>
            </Cell>
            <label className="form-check">
              <input type="checkbox" checked={s.foreign} onChange={(e) => set({ foreign: e.target.checked })} /> Outside India
            </label>
          </>
        )}
      />
      <div className="approval-actions">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          Save the profile
        </button>
        {saved ? <span role="status">Profile saved. The calendar is up to date.</span> : null}
        {save.error ? <span className="form-error">{save.error.message}</span> : null}
      </div>
    </form>
  );
}

function YesNo({ id, label, value, onChange }: { id: string; label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value === null ? "" : value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}>
        <option value="">Not answered</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="row-cell">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Rows<T extends { id: string }>({ title, help, rows, onChange, blank, render, addLabel }: { title: string; help: string; rows: T[]; onChange: (rows: T[]) => void; blank: () => T; render: (row: T, set: (change: Partial<T>) => void) => ReactNode; addLabel: string }) {
  return (
    <fieldset>
      <legend className="h2">{title}</legend>
      <p className="field-help">{help}</p>
      <ul className="row-editor">
        {rows.map((r) => (
          <li key={r.id}>
            {render(r, (change) => onChange(rows.map((x) => (x.id === r.id ? { ...x, ...change } : x))))}
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-small" onClick={() => onChange([...rows, blank()])}>
        {addLabel}
      </button>
    </fieldset>
  );
}

/** Things that start an ROC clock but are not in the profile. */
function EventForm() {
  const add = useChange();
  const [e, setE] = useState({ kind: "special_resolution" as CompanyEventKind, on: "", detail: "", privatePlacement: false, foreign: false });
  return (
    <details className="event-form">
      <summary>Record something that happened</summary>
      <div className="obligation-form-row">
        <div className="field">
          <label htmlFor="ev-kind">What happened</label>
          <select id="ev-kind" className="input" value={e.kind} onChange={(x) => setE({ ...e, kind: x.target.value as CompanyEventKind })}>
            {EVENT_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-on">On</label>
          <input id="ev-on" className="input num" type="date" value={e.on} onChange={(x) => setE({ ...e, on: x.target.value })} />
        </div>
        <div className="field field-wide">
          <label htmlFor="ev-detail">In a line</label>
          <input id="ev-detail" className="input" maxLength={300} value={e.detail} placeholder="Members approved the new articles" onChange={(x) => setE({ ...e, detail: x.target.value })} />
        </div>
        {e.kind === "shares_allotted" ? (
          <>
            <label className="form-check">
              <input type="checkbox" checked={e.privatePlacement} onChange={(x) => setE({ ...e, privatePlacement: x.target.checked })} /> By private placement
            </label>
            <label className="form-check">
              <input type="checkbox" checked={e.foreign} onChange={(x) => setE({ ...e, foreign: x.target.checked })} /> To someone outside India
            </label>
          </>
        ) : null}
        <button type="button" className="btn" disabled={add.isPending || !e.on || !e.detail.trim()} onClick={() => add.mutate(() => compliance.addEvent({ kind: e.kind, on: e.on, detail: e.detail.trim(), ...(e.kind === "shares_allotted" ? { privatePlacement: e.privatePlacement, foreign: e.foreign } : {}) }))}>
          Add the filing it needs
        </button>
        {add.isSuccess ? <span role="status">Added to the calendar.</span> : null}
        {add.error ? <span className="form-error">{add.error.message}</span> : null}
      </div>
    </details>
  );
}

/** Rule 3 of the Companies (Accounts) Rules: the edit log, the backup in India, and who keeps the books. */
export function BooksRecordSettings() {
  const rec = useQuery(q.booksRecord());
  const [error, setError] = useState<string | null>(null);
  const r = rec.data;
  const fy = fyOfDate(new Date().toISOString().slice(0, 10));
  const downloadLog = async () => {
    setError(null);
    try {
      const { entries } = await compliance.edits({ limit: 500 });
      const cell = (v: unknown) => `"${(typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/"/g, '""')}"`;
      const lines = [["Seq", "At", "By", "Record kind", "Record", "Action", "Field", "Before", "After", "Hash"].join(",")];
      for (const e of [...entries].reverse()) {
        const changes = e.changes.length ? e.changes : [{ field: "", before: "", after: "" }];
        for (const c of changes) lines.push([e.seq, e.at, cell(e.by), e.coll, cell(e.recordId), e.action, cell(c.field), cell(c.before), cell(c.after), e.hash].join(","));
      }
      savePaper({ filename: "Edit_log.csv", mime: "text/csv", content: lines.join("\n") + "\n" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Section title="How your books are kept">
      {r ? (
        <>
          <p className="section-lede">Companies that keep their books in software must have an edit log that cannot be turned off, a daily copy on servers in India, and must tell the ROC each year who keeps the books and where. Your auditor reports on this under Rule 11(g).</p>
          <dl className="details">
            <div>
              <dt>Books kept by</dt>
              <dd>{`${r.provider.name}, ${r.provider.address}`}</dd>
            </div>
            <div>
              <dt>Where</dt>
              <dd>{r.provider.servers}</dd>
            </div>
            <div>
              <dt>Copy in India</dt>
              <dd className={r.backup.configured && !r.backup.lastError ? undefined : "is-red"}>
                {r.backup.configured ? `${r.backup.where}. ${r.backup.lastAt ? `Last copy ${longDate(r.backup.lastAt)}.` : "No copy taken yet."}${r.backup.lastError ? ` The last attempt failed: ${r.backup.lastError}` : ""}` : r.backup.where}
              </dd>
            </div>
            <div>
              <dt>Edit log</dt>
              <dd className={r.editLog.intact ? undefined : "is-red"}>
                {`${r.editLog.since ? `Running since ${longDate(r.editLog.since)}` : "No entries yet"}: ${count(r.editLog.entries, "entry", "entries")}, ${r.editLog.thisYear} this year. ${r.editLog.intact ? "The hash chain is complete." : "The hash chain is broken: an entry was altered or removed."}`}
              </dd>
            </div>
            <div>
              <dt>Kept for</dt>
              <dd>{`${r.retentionYears} years after the year they relate to, including if the office is closed.`}</dd>
            </div>
          </dl>
          <p className="field-help">Give the name, address and server details above to your CA for AOC-4, where the company tells the ROC who keeps its books online.</p>
          <div className="approval-actions">
            <button type="button" className="btn" onClick={() => compliance.auditorStatement(fyLabel(fy)).then(savePaper, (e: Error) => setError(e.message))}>
              {`Statement for the auditor, ${fyLabel(fy)}`}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => compliance.auditorStatement(fyLabel(fy - 1)).then(savePaper, (e: Error) => setError(e.message))}>
              {`For ${fyLabel(fy - 1)}`}
            </button>
            <button type="button" className="btn" onClick={() => void downloadLog()}>
              Download the latest 500 changes
            </button>
            {error ? <span className="toolbar-error" role="alert">{error}</span> : null}
          </div>
          {r.editLog.latest.length ? (
            <details>
              <summary>The latest changes</summary>
              <LedgerTable
                caption="Latest changes to the books"
                rows={r.editLog.latest}
                rowKey={(e) => String(e.seq)}
                columns={[
                  { id: "at", header: "When", cell: (e) => `${shortDate(e.at)} ${e.at.slice(11, 16)}` },
                  { id: "by", header: "Who", cell: (e) => e.by },
                  { id: "what", header: "Record", cell: (e) => `${e.coll} ${e.recordId}` },
                  { id: "act", header: "Change", cell: (e) => (e.action === "change" ? e.changes.map((c) => c.field).join(", ") : e.action === "create" ? "Added" : e.action === "delete" ? "Removed" : "Starting point") },
                ]}
              />
            </details>
          ) : null}
        </>
      ) : (
        <p className="loading">Fetching the books</p>
      )}
    </Section>
  );
}
