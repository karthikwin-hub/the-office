import type { Me, OfficeSummary } from "@office/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { account, ApiError, isLive, setActiveOffice } from "../api/client";
import { q } from "../api/queries";
import { ConsentGate, LegalFooter } from "./Legal";
import { SignIn } from "./SignIn";

const ACTIVE_KEY = "office.active";
const INVITE_KEY = "office.invite";
const params = () => new URLSearchParams(location.search);

/** Opens an office in a fresh page, so nothing cached from another office is shown on the way. */
export function goToOffice(id: string, path = "/") {
  localStorage.setItem(ACTIVE_KEY, id);
  location.assign(`${path}${path.includes("?") ? "&" : "?"}office=${encodeURIComponent(id)}`);
}

/** The invitation token from the link, kept while the person signs in or makes an account. */
function inviteToken(): string | null {
  const fromUrl = params().get("invite");
  if (fromUrl) sessionStorage.setItem(INVITE_KEY, fromUrl);
  return sessionStorage.getItem(INVITE_KEY);
}

/** `?office=` first, then the office last opened on this device, then the only one; never an office the person is not in. */
function chooseOffice(offices: OfficeSummary[]): OfficeSummary | null {
  const usable = offices.filter((o) => o.status !== "deleting");
  const wanted = params().get("office") ?? localStorage.getItem(ACTIVE_KEY);
  const found = usable.find((o) => o.id === wanted) ?? (usable.length === 1 ? usable[0]! : null);
  if (found) localStorage.setItem(ACTIVE_KEY, found.id);
  return found;
}

/**
 * In the live app, nothing of an office loads until the person is signed in, has confirmed
 * their address and has chosen an office they belong to. Every request after this names it.
 */
export function OfficeGate({ children }: { children: ReactNode }) {
  const me = useQuery(q.me());
  const invite = inviteToken();
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn invited={Boolean(invite)} />;
  if (!me.data)
    return me.error ? (
      <Door title="The office could not be reached">
        <p className="form-error" role="alert">
          {me.error.message}
        </p>
      </Door>
    ) : null;
  if (me.data.verificationRequired && !me.data.user.emailVerified) return <ConfirmEmail me={me.data} />;
  if (me.data.consentNeeded.length) return <ConsentGate me={me.data} />;
  if (invite) return <AcceptInvitation token={invite} />;
  if (params().has("open")) return <OpenOffice me={me.data} />;
  const active = chooseOffice(me.data.offices);
  if (!active) return me.data.offices.length ? <OfficePicker me={me.data} /> : <OpenOffice me={me.data} />;
  setActiveOffice(active.id);
  return <>{children}</>;
}

function Door({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <p className="signin-plate">The Office</p>
        <h1>{title}</h1>
        {lede ? <p className="muted">{lede}</p> : null}
        {children}
      </div>
      <LegalFooter />
    </main>
  );
}

function SignOutLink() {
  const out = useMutation({ mutationFn: account.signOut, onSettled: () => location.assign("/") });
  return (
    <p className="signin-switch">
      <button type="button" className="link-button" onClick={() => out.mutate()} disabled={out.isPending}>
        Sign out
      </button>
    </p>
  );
}

function ConfirmEmail({ me }: { me: Me }) {
  const qc = useQueryClient();
  const resend = useMutation({ mutationFn: () => account.resendVerification(me.user.email) });
  return (
    <Door title="Confirm your email" lede={<>We sent a link to <strong>{me.user.email}</strong>. Open it to confirm the address; then you can open an office or accept an invitation.</>}>
      <div className="approval-actions">
        <button type="button" className="btn btn-primary" onClick={() => void qc.invalidateQueries({ queryKey: ["me"] })}>
          I have confirmed it
        </button>
        <button type="button" className="btn" onClick={() => resend.mutate()} disabled={resend.isPending || resend.isSuccess}>
          {resend.isSuccess ? "Sent again" : "Send the link again"}
        </button>
      </div>
      {resend.error ? <p className="form-error">{resend.error.message}</p> : null}
      <SignOutLink />
    </Door>
  );
}

function AcceptInvitation({ token }: { token: string }) {
  const peek = useQuery({ queryKey: ["invitation", token], queryFn: () => account.peekInvitation(token), retry: false });
  const accept = useMutation({
    mutationFn: () => account.acceptInvitation(token),
    onSuccess: (r) => {
      sessionStorage.removeItem(INVITE_KEY);
      goToOffice(r.officeId);
    },
  });
  const forget = () => {
    sessionStorage.removeItem(INVITE_KEY);
    location.assign("/");
  };
  if (peek.error)
    return (
      <Door title="This invitation cannot be used" lede={peek.error.message}>
        <button type="button" className="btn" onClick={forget}>
          Go to my offices
        </button>
      </Door>
    );
  if (!peek.data) return null;
  const p = peek.data;
  return (
    <Door
      title={`Join ${p.officeName}`}
      lede={p.role === "owner" ? "You were invited as an owner: you approve the team's work, hire and change settings." : "You were invited as the accountant: you can read everything, download returns and answer the Auditor. Approvals stay with the owner."}
    >
      <p>
        The invitation is for <strong>{p.email}</strong>.
      </p>
      <div className="approval-actions">
        <button type="button" className="btn btn-primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
          Join the office
        </button>
        <button type="button" className="btn btn-quiet" onClick={forget}>
          Not now
        </button>
      </div>
      {accept.error ? (
        <p className="form-error" role="alert">
          {accept.error.message}
        </p>
      ) : null}
      <SignOutLink />
    </Door>
  );
}

function OfficePicker({ me }: { me: Me }) {
  const restore = useMutation({ mutationFn: (id: string) => account.restoreOffice(id), onSuccess: (_r, id) => goToOffice(id) });
  return (
    <Door title={`Hello, ${me.user.name.split(" ")[0]}`} lede="Which office are you working in?">
      <ul className="office-list">
        {me.offices.map((o) => (
          <li key={o.id}>
            {o.status === "deleting" ? (
              <div className="office-choice" aria-disabled="true">
                <span>
                  <strong>{o.name}</strong> <span className="muted">is being deleted</span>
                </span>
                <button type="button" className="btn" onClick={() => restore.mutate(o.id)} disabled={restore.isPending}>
                  Restore
                </button>
              </div>
            ) : (
              <button type="button" className="office-choice" onClick={() => goToOffice(o.id)} disabled={o.status !== "active"}>
                <strong>{o.name}</strong>
                <span className="muted">{o.status === "suspended" ? "Suspended" : o.role === "owner" ? "Owner" : "Accountant"}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {restore.error ? <p className="form-error">{restore.error.message}</p> : null}
      <p>
        <a href="/?open=1">Open another office</a>
      </p>
      <SignOutLink />
    </Door>
  );
}

function OpenOffice({ me }: { me: Me }) {
  const [name, setName] = useState("");
  const open = useMutation({ mutationFn: () => account.openOffice(name.trim()), onSuccess: (o) => goToOffice(o.id) });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    open.mutate();
  };
  const first = me.offices.length === 0;
  return (
    <Door
      title="Open your office"
      lede={first ? "Name the business. You will own its office: you approve the team's work, hire and invite your accountant. Its books are seen only by the people you invite." : "A separate office for another business, with its own books, people and email address."}
    >
      <form onSubmit={onSubmit} className="signin-form">
        <div className="field">
          <label htmlFor="office-name">Business name</label>
          <input id="office-name" className="input" required minLength={2} maxLength={80} placeholder="Kaveri Electricals" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {open.error ? (
          <p className="form-error" role="alert">
            {open.error.message}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={open.isPending || name.trim().length < 2}>
          {open.isPending ? "Opening" : "Open the office"}
        </button>
      </form>
      <p className="signin-switch">
        {first ? (
          <>Invited to someone else's office? Open the link in the invitation email.</>
        ) : (
          <a href="/">Back to my offices</a>
        )}
      </p>
      {first ? <SignOutLink /> : null}
    </Door>
  );
}

/** The business name in the top bar; with more than one office, it opens the list to switch. */
export function OfficeSwitcher({ fallback }: { fallback: string }) {
  const me = useQuery({ ...q.me(), enabled: isLive });
  const current = me.data?.offices.find((o) => o.id === localStorage.getItem(ACTIVE_KEY));
  const name = fallback || current?.name || "The Office";
  const others = me.data?.offices.filter((o) => o.id !== current?.id && o.status === "active") ?? [];
  if (!isLive)
    return (
      <a href="/" className="topbar-business">
        {fallback}
      </a>
    );
  return (
    <details className="office-switch">
      <summary className="topbar-business">{name}</summary>
      <div className="office-switch-menu">
        {others.length ? <p className="muted">Switch to</p> : null}
        <ul>
          {others.map((o) => (
            <li key={o.id}>
              <button type="button" className="link-button" onClick={() => goToOffice(o.id)}>
                {o.name}
              </button>
            </li>
          ))}
        </ul>
        <a href="/?open=1">Open another office</a>
      </div>
    </details>
  );
}
