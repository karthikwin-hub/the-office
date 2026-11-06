import type { Decision, StagedChange, StagedKind } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import { useId, useState, type ReactNode } from "react";
import { useFigures } from "./Figure";

/** The button names the action; the result repeats it in the past tense. */
export const ACTIONS: Record<StagedKind, { verb: string; done: string }> = {
  ledger_entry: { verb: "Post bill", done: "Bill posted" },
  reminder: { verb: "Send reminder", done: "Reminder sent" },
  audit_flag: { verb: "Raise with accountant", done: "Raised with accountant" },
  share_file: { verb: "Share file", done: "File shared" },
  quote: { verb: "Send quotation", done: "Quotation sent" },
  campaign: { verb: "Schedule campaign", done: "Campaign scheduled" },
  post: { verb: "Schedule post", done: "Post scheduled" },
  social_reply: { verb: "Post reply", done: "Reply posted" },
  calendar: { verb: "Approve calendar", done: "Calendar approved" },
  broadcast: { verb: "Send broadcast", done: "Broadcast sent" },
  purchase_order: { verb: "Send order", done: "Order sent" },
  payroll_run: { verb: "Release payslips", done: "Payslips released" },
  customer_reply: { verb: "Send reply", done: "Reply sent" },
  handoff: { verb: "Send your answer", done: "Answered" },
  onboarding: { verb: "Bring into the books", done: "Brought into the books" },
  compliance_action: { verb: "Agree", done: "Agreed" },
};

/** Payload fields the owner may rewrite before approving. */
const EDITABLE: Record<string, string> = { subject: "Subject", body: "Message", reply: "Reply", caption: "Caption", message: "Message" };

type Props = {
  item: StagedChange;
  onDecide?: (d: Decision) => void;
  busy?: boolean;
  /** Approvals the current user is not allowed to make. */
  readOnly?: string | false;
  showAgent?: boolean;
  /** Extra text resolved by the app, e.g. a social message being replied to. */
  context?: Record<string, string>;
  /** What is being approved, drawn by the app: a post's versions, a month's calendar. */
  body?: ReactNode;
};

export function ApprovalCard({ item, onDecide, busy, readOnly, showAgent = true, context, body }: Props) {
  const handoff = item.kind === "handoff";
  const [mode, setMode] = useState<"view" | "edit" | "reject">(handoff ? "edit" : "view");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [save, setSave] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const { openDocument, open } = useFigures();
  const id = useId();
  const action = ACTIONS[item.kind];
  const agent = AGENT_BY_ID[item.agentId];
  const editable = Object.entries(item.payload).filter(([k, v]) => k in EDITABLE && typeof v === "string") as [string, string][];
  const decided = item.status !== "pending";

  return (
    <article className={`approval${decided ? " approval-decided" : ""}`} aria-labelledby={`${id}-t`}>
      <header className="approval-head">
        {showAgent && agent ? <span className="approval-agent">{agent.short}</span> : null}
        {!decided && !handoff ? <span className="approval-ai">Drafted by AI, checked by you</span> : null}
        <time className="approval-time num" dateTime={item.createdAt}>
          {item.createdAt.slice(11, 16)}
        </time>
      </header>
      <h3 id={`${id}-t`} className="approval-title">
        {item.title}
      </h3>
      <p className="approval-summary">{item.summary}</p>
      {context ? (
        <dl className="approval-context">
          {Object.entries(context).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body}
      {mode === "edit" ? (
        <div className="approval-edit">
          {editable.map(([k, v]) => (
            <div className="field" key={k}>
              <label htmlFor={`${id}-${k}`}>{EDITABLE[k]}</label>
              {k === "subject" ? (
                <input id={`${id}-${k}`} className="input" defaultValue={v} onChange={(e) => setEdits((x) => ({ ...x, [k]: e.target.value }))} />
              ) : (
                <textarea id={`${id}-${k}`} className="input" rows={Math.min(14, v.split("\n").length + 2)} defaultValue={v} onChange={(e) => setEdits((x) => ({ ...x, [k]: e.target.value }))} />
              )}
            </div>
          ))}
          {handoff ? (
            <div className="approval-save">
              <label className="check">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save as one of your answers, so the agent can send it next time
              </label>
              {save ? (
                <div className="field">
                  <label htmlFor={`${id}-save`}>What the answer is about</label>
                  <input id={`${id}-save`} className="input" value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} placeholder="For example: Delivery to Pune" />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : editable.length ? (
        <details className="approval-preview">
          <summary>Read the {item.kind === "reminder" ? "letter" : "text"}</summary>
          {editable.map(([k, v]) => (
            <div key={k} className="approval-preview-field">
              {k === "subject" ? <p className="approval-subject">{v}</p> : <p className="approval-body">{v}</p>}
            </div>
          ))}
        </details>
      ) : null}
      {item.evidence.length ? (
        <ul className="approval-evidence" aria-label="Evidence">
          {item.evidence.map((e, i) => (
            <li key={i}>
              <button
                type="button"
                className="btn-link"
                onClick={() => (e.ref.kind === "document" && e.ref.id ? openDocument(e.ref.id, e.ref.region) : e.ref.kind === "figure" && e.ref.id ? open(e.ref.id) : undefined)}
                disabled={!(e.ref.kind === "document" || e.ref.kind === "figure") || !e.ref.id}
              >
                {e.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {decided ? (
        <p className="approval-result">
          <strong>{item.status === "approved" ? action.done : "Rejected"}</strong>
          {item.decidedBy ? ` by ${item.decidedBy}` : ""}
          {item.decidedAt ? ` at ${new Date(item.decidedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
          {item.note ? `. ${item.note}` : ""}
        </p>
      ) : readOnly ? (
        <p className="approval-result muted">{readOnly}</p>
      ) : mode === "reject" ? (
        <form
          className="approval-reject"
          onSubmit={(e) => {
            e.preventDefault();
            onDecide?.({ action: "reject", note: note || undefined });
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-why`}>Why are you rejecting this?</label>
            <input id={`${id}-why`} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="The agent learns from your reason" autoFocus />
          </div>
          <div className="approval-actions">
            <button type="submit" className="btn" disabled={busy}>
              Reject
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (handoff && save && !saveTitle.trim())}
            onClick={() => {
              const all = { ...edits, ...(handoff && save && saveTitle.trim() ? { saveAs: saveTitle.trim() } : {}) };
              onDecide?.({ action: "approve", edits: Object.keys(all).length ? all : undefined });
            }}
          >
            {mode === "edit" && !handoff ? `${action.verb} with changes` : action.verb}
          </button>
          {editable.length && mode !== "edit" ? (
            <button type="button" className="btn" onClick={() => setMode("edit")}>
              Edit
            </button>
          ) : null}
          {handoff ? (
            <button type="button" className="btn btn-quiet" onClick={() => setMode("reject")}>
              Close without replying
            </button>
          ) : mode === "edit" ? (
            <button type="button" className="btn btn-quiet" onClick={() => (setMode("view"), setEdits({}))}>
              Discard changes
            </button>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={() => setMode("reject")}>
              Reject
            </button>
          )}
        </div>
      )}
    </article>
  );
}
