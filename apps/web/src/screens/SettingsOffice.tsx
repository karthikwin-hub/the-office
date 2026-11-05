import type { InviteResult, OfficeAdmin, Role } from "@office/contracts";
import { dateLabel } from "@office/engine";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isLive, officeAdmin } from "../api/client";
import { q } from "../api/queries";
import { goToOffice } from "../app/Offices";
import { isOwner, Section } from "./common";

const ROLE_NOTE: Record<Role, string> = {
  owner: "Owner: approves work, hires, invites and changes settings",
  accountant: "Accountant: reads everything, downloads returns, answers the Auditor",
};

/** The office as an account: who is in it, who is invited, its email address, and handing it over, exporting or deleting it. */
export function OfficeSettings() {
  const admin = useQuery(q.officeAdmin());
  if (!admin.data) return admin.error ? <Section title="Your office"><p className="form-error">{admin.error.message}</p></Section> : null;
  return <OfficePanel a={admin.data} />;
}

function OfficePanel({ a }: { a: OfficeAdmin }) {
  const qc = useQueryClient();
  const owner = isOwner();
  const owners = a.members.filter((m) => m.role === "owner").length;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["office-admin"] });
  const setRole = useMutation({ mutationFn: ({ userId, role }: { userId: string; role: Role }) => officeAdmin.setRole(userId, role), onSettled: refresh });
  const remove = useMutation({ mutationFn: officeAdmin.remove, onSettled: refresh });
  const revoke = useMutation({ mutationFn: officeAdmin.revoke, onSettled: refresh });
  const leave = useMutation({ mutationFn: officeAdmin.leave, onSuccess: () => (isLive ? location.assign("/") : refresh()) });
  const me = a.members.find((m) => m.you);
  const err = setRole.error ?? remove.error ?? revoke.error ?? leave.error;

  return (
    <Section title="Your office">
      <dl className="details">
        <div>
          <dt>Name</dt>
          <dd>
            {a.name}
            {owner ? <span className="muted"> · change it under Business</span> : null}
          </dd>
        </div>
        <div>
          <dt>Email for bills</dt>
          <dd className="num">{a.ingestEmail}</dd>
        </div>
      </dl>

      <h3 className="settings-sub">People</h3>
      <ul className="people">
        {a.members.map((m) => (
          <li key={m.userId}>
            <strong>{m.name}</strong> <span className="muted">{m.email}</span>
            {owner && !m.you ? (
              <span className="people-actions">
                <label className="visually-hidden" htmlFor={`role-${m.userId}`}>
                  Role for {m.name}
                </label>
                <select id={`role-${m.userId}`} className="input" value={m.role} onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as Role })} disabled={setRole.isPending}>
                  <option value="owner">Owner</option>
                  <option value="accountant">Accountant</option>
                </select>
                <button type="button" className="btn btn-quiet" onClick={() => remove.mutate(m.userId)} disabled={remove.isPending}>
                  Remove
                </button>
              </span>
            ) : (
              <span>
                {ROLE_NOTE[m.role]}
                {m.you ? " (you)" : ""}
              </span>
            )}
          </li>
        ))}
        {a.invitations.map((i) => (
          <li key={i.email}>
            <strong>Invited</strong> <span className="muted">{i.email}</span>
            <span>
              As {i.role === "owner" ? "an owner" : "the accountant"}, until {dateLabel(i.expiresAt.slice(0, 10))}
            </span>
            {owner ? (
              <span className="people-actions">
                <button type="button" className="btn btn-quiet" onClick={() => revoke.mutate(i.email)} disabled={revoke.isPending}>
                  Revoke
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {err ? <p className="form-error">{err.message}</p> : null}
      {owner ? <InviteForm onSent={refresh} /> : null}

      {owner ? <Handover a={a} onDone={refresh} /> : null}
      {me && !(me.role === "owner" && owners === 1) ? (
        <p>
          <button type="button" className="btn btn-quiet" onClick={() => leave.mutate()} disabled={leave.isPending}>
            Leave this office
          </button>
        </p>
      ) : null}

      {owner ? <OwnerTools a={a} /> : null}
    </Section>
  );
}

/** The link is shown as well as emailed, so the owner can pass it on another way if the email does not arrive. */
function InviteForm({ onSent }: { onSent: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("accountant");
  const [sent, setSent] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const send = useMutation({
    mutationFn: () => officeAdmin.invite(email.trim(), role),
    onSuccess: (r) => {
      setSent(r);
      setCopied(false);
      setEmail("");
      onSent();
    },
  });
  return (
    <div className="invite">
      <form
        className="office-inline"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <label htmlFor="invite">Invite someone</label>
        <input id="invite" className="input" type="email" required placeholder="name@firm.in" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="visually-hidden" htmlFor="invite-role">
          Role
        </label>
        <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="accountant">As the accountant</option>
          <option value="owner">As an owner</option>
        </select>
        <button type="submit" className="btn" disabled={send.isPending}>
          Invite
        </button>
      </form>
      {send.error ? <p className="form-error">{send.error.message}</p> : null}
      {sent ? (
        <div className="invite-link" role="status">
          <p>
            {sent.emailed ? `Invitation emailed to ${sent.email}.` : `Email is not set up here, so send ${sent.email} this link yourself.`} It works once, until {dateLabel(sent.expiresAt.slice(0, 10))}.
          </p>
          <div className="office-inline">
            <input className="input" readOnly value={sent.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                void navigator.clipboard?.writeText(sent.link);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Handing the office to someone already in it; the owner stays on as the accountant. */
function Handover({ a, onDone }: { a: OfficeAdmin; onDone: () => void }) {
  const others = a.members.filter((m) => !m.you);
  const [to, setTo] = useState("");
  const transfer = useMutation({ mutationFn: () => officeAdmin.transfer(to), onSuccess: () => (isLive ? location.reload() : onDone()) });
  if (!others.length) return null;
  return (
    <form
      className="office-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (to) transfer.mutate();
      }}
    >
      <label htmlFor="handover">Hand the office to</label>
      <select id="handover" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Choose someone</option>
        {others.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={!to || transfer.isPending}>
        Hand over
      </button>
      <span className="field-help">You stay on as the accountant.</span>
      {transfer.error ? <span className="form-error">{transfer.error.message}</span> : null}
    </form>
  );
}

function OwnerTools({ a }: { a: OfficeAdmin }) {
  const [confirm, setConfirm] = useState("");
  const exportAll = useMutation({ mutationFn: officeAdmin.exportAll });
  const del = useMutation({ mutationFn: () => officeAdmin.deleteOffice(confirm), onSuccess: () => (isLive ? location.assign("/") : undefined) });
  const restore = useMutation({ mutationFn: officeAdmin.restore, onSuccess: () => (isLive ? goToOffice(a.id) : undefined) });
  return (
    <>
      <h3 className="settings-sub">History</h3>
      {a.audit.length ? (
        <ul className="office-audit">
          {a.audit.slice(0, 12).map((e, i) => (
            <li key={i}>
              <span className="num muted">{dateLabel(e.at.slice(0, 10))}</span> <span>{auditLine(e)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing yet.</p>
      )}

      <h3 className="settings-sub">Your data</h3>
      <p>
        <button type="button" className="btn" onClick={() => exportAll.mutate()} disabled={exportAll.isPending}>
          {exportAll.isPending ? "Preparing" : "Download everything"}
        </button>{" "}
        <span className="field-help">The books as JSON and every stored bill and picture, in one zip.</span>
      </p>
      {exportAll.error ? <p className="form-error">{exportAll.error.message}</p> : null}

      {a.status === "deleting" ? (
        <p>
          This office is being deleted{a.purgeAt ? ` and will be gone for good on ${dateLabel(a.purgeAt.slice(0, 10))}` : ""}.{" "}
          <button type="button" className="btn" onClick={() => restore.mutate()} disabled={restore.isPending}>
            Restore it
          </button>
        </p>
      ) : (
        <form
          className="danger-zone"
          onSubmit={(e) => {
            e.preventDefault();
            del.mutate();
          }}
        >
          <label htmlFor="delete-confirm">
            Delete the office. Everyone loses access at once; the books and files are kept 30 days in case you change your mind, then removed for good. Type <strong>{a.name}</strong> to confirm.
          </label>
          <div className="office-inline">
            <input id="delete-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            <button type="submit" className="btn btn-danger" disabled={confirm.trim() !== a.name || del.isPending}>
              Delete the office
            </button>
          </div>
          {del.error ? <p className="form-error">{del.error.message}</p> : null}
          {del.data ? <p role="status">Deleted. It can be restored until {dateLabel(del.data.purgeAt.slice(0, 10))}.</p> : null}
        </form>
      )}
    </>
  );
}

const ACTIONS: Record<string, string> = {
  "office.opened": "opened the office",
  "office.deleting": "deleted the office",
  "office.active": "restored the office",
  "office.suspended": "suspended the office",
  "office.transferred": "handed the office over",
  "office.exported": "downloaded everything",
  "invitation.sent": "invited",
  "invitation.revoked": "revoked the invitation for",
  "invitation.accepted": "joined",
  "member.role": "changed a role:",
  "member.removed": "removed",
  "member.left": "left the office",
};

function auditLine(e: OfficeAdmin["audit"][number]): string {
  const what = ACTIONS[e.action] ?? e.action;
  const detail = e.action === "office.opened" || e.action === "member.left" || e.action === "invitation.accepted" ? "" : (e.detail ?? "");
  return `${e.actor} ${what}${detail ? ` ${detail}` : ""}`;
}
