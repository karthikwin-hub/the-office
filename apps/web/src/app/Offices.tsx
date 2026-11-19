import { BRAND, type Me, type OfficeSummary } from "@office/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { account, ApiError, isLive, setActiveOffice } from "../api/client";
import { q } from "../api/queries";
import { BrandPlate, ConsentGate, LegalFooter } from "./Legal";
import { TwoFactorGate } from "./Security";
import { SignIn } from "./SignIn";
import { appUrl, hasAppDomain, officeUrl, place } from "./site";

const ACTIVE_KEY = "office.active";
const INVITE_KEY = "office.invite";
const params = () => new URLSearchParams(location.search);

/** Opens an office in a fresh page, so nothing cached from another office is shown on the way: on its own address if it has one, else on the app. */
export function goToOffice(id: string, path = "/", subdomain?: string | null) {
  if (subdomain && hasAppDomain()) return location.assign(officeUrl(subdomain, path));
  localStorage.setItem(ACTIVE_KEY, id);
  location.assign(appUrl(`${path}${path.includes("?") ? "&" : "?"}office=${encodeURIComponent(id)}`));
}

/** The same page on the office's own address, without the `office` parameter the app needed. */
function onOwnAddress(subdomain: string): string {
  const search = params();
  search.delete("office");
  const query = search.toString();
  return officeUrl(subdomain, `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

/**
 * The invitation token, kept in this browser for a day while the person signs in or makes an account, so the
 * page their confirmation email opens (often a new tab) still offers to join. It never goes in a URL a server sees.
 */
const INVITE_KEPT_MS = 24 * 3600_000;
const keptInvite = {
  get(): string | null {
    try {
      const v = JSON.parse(localStorage.getItem(INVITE_KEY) ?? "null") as { token?: unknown; until?: unknown } | null;
      if (v && typeof v.token === "string" && typeof v.until === "number" && v.until > Date.now()) return v.token;
    } catch {
      // Unreadable or blocked storage: as if nothing was kept.
    }
    keptInvite.drop();
    return null;
  },
  set(token: string) {
    try {
      localStorage.setItem(INVITE_KEY, JSON.stringify({ token, until: Date.now() + INVITE_KEPT_MS }));
    } catch {
      // Storage blocked: the link still works if opened again.
    }
  },
  drop() {
    try {
      localStorage.removeItem(INVITE_KEY);
      sessionStorage.removeItem(INVITE_KEY);
    } catch {
      // Nothing to drop.
    }
  },
};

/**
 * The invitation token from the link, or the one kept from it. Links carry it after `#`, which never reaches
 * a server; links sent before that carry `?invite=`. Either way it leaves the address bar at once, so it is
 * not in the history or passed on to another page.
 */
function inviteToken(): string | null {
  const u = new URL(location.href);
  const hash = new URLSearchParams(u.hash.slice(1));
  const fromUrl = hash.get("invite") ?? u.searchParams.get("invite");
  if (fromUrl) {
    keptInvite.set(fromUrl);
    hash.delete("invite");
    u.searchParams.delete("invite");
    const rest = hash.toString();
    history.replaceState(history.state, "", u.pathname + u.search + (rest ? `#${rest}` : ""));
    return fromUrl;
  }
  return keptInvite.get();
}

/** A used or expired invitation: dropped from this browser, so signing in goes straight to the person's offices. */
function forgetSpentInvite() {
  keptInvite.drop();
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
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn invite={invite} onInviteSpent={forgetSpentInvite} />;
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
  if (me.data.twoFactor.required && !me.data.twoFactor.enabled) return <TwoFactorGate me={me.data} />;
  if (invite) return <AcceptInvitation token={invite} me={me.data} />;
  if (params().has("open")) return <OpenOffice me={me.data} />;
  const here = place();
  if (here.kind === "office") {
    const mine = me.data.offices.find((o) => o.subdomain === here.subdomain && o.status !== "deleting");
    if (!mine) return <NotYourOffice address={location.host} />;
    if (mine.status === "suspended") return <Suspended name={mine.name} others={me.data.offices.some((o) => o.id !== mine.id && o.status === "active")} />;
    setActiveOffice(mine.id);
    return <>{children}</>;
  }
  const active = chooseOffice(me.data.offices);
  if (!active) return me.data.offices.length ? <OfficePicker me={me.data} /> : <OpenOffice me={me.data} />;
  if (active.status === "suspended") return <Suspended name={active.name} others={me.data.offices.some((o) => o.id !== active.id && o.status === "active")} />;
  if (active.subdomain && hasAppDomain()) {
    location.replace(onOwnAddress(active.subdomain));
    return null;
  }
  setActiveOffice(active.id);
  return <>{children}</>;
}

function Suspended({ name, others }: { name: string; others: boolean }) {
  return (
    <Door title={`${name} is suspended`} lede={<>No one can open this office for now. Its books and files are kept as they were. Write to {BRAND.name} to have it opened again.</>}>
      {others ? (
        <a
          className="btn btn-primary"
          href={appUrl("/")}
          onClick={() => {
            localStorage.removeItem(ACTIVE_KEY);
          }}
        >
          Go to my other offices
        </a>
      ) : null}
      <SignOutLink />
    </Door>
  );
}

function NotYourOffice({ address }: { address: string }) {
  return (
    <Door title="This is not one of your offices" lede={<>You are signed in, but not as someone in the office at <strong>{address}</strong>. Ask its owner for an invitation, or go to your own offices.</>}>
      <a className="btn btn-primary" href={appUrl("/")}>
        Go to my offices
      </a>
      <SignOutLink />
    </Door>
  );
}

function Door({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <BrandPlate />
        <h1>{title}</h1>
        {lede ? <p className="muted">{lede}</p> : null}
        {children}
      </div>
      <LegalFooter />
    </main>
  );
}

function SignOutLink() {
  // Signing out on the way in leaves no invitation behind for the next person on this browser.
  const out = useMutation({ mutationFn: account.signOut, onSettled: () => (keptInvite.drop(), location.assign("/")) });
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

function AcceptInvitation({ token, me }: { token: string; me: Me }) {
  const peek = useQuery({ queryKey: ["invitation", token], queryFn: () => account.peekInvitation(token), retry: false });
  const accept = useMutation({
    mutationFn: () => account.acceptInvitation(token),
    onSuccess: (r) => {
      keptInvite.drop();
      goToOffice(r.officeId);
    },
  });
  const forget = () => {
    keptInvite.drop();
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
  // Signed in as someone else, often on a shared computer: say so before anything is pressed, and offer the way through.
  if (me.user.email.trim().toLowerCase() !== p.email.trim().toLowerCase()) return <SwitchAccount token={token} invited={p.email} signedInAs={me.user.email} officeName={p.officeName} onLater={forget} />;
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

function SwitchAccount({ token, invited, signedInAs, officeName, onLater }: { token: string; invited: string; signedInAs: string; officeName: string; onLater: () => void }) {
  const out = useMutation({
    mutationFn: account.signOut,
    // The token is kept, so the sign-in page opens on making an account for the invited address.
    onSettled: () => {
      keptInvite.set(token);
      location.assign("/");
    },
  });
  return (
    <Door title={`Join ${officeName}`} lede={<>This invitation is for <strong>{invited}</strong>, but this browser is signed in as <strong>{signedInAs}</strong>.</>}>
      <p>Sign out, then make an account for {invited} (or sign in, if it already has one). The invitation will be waiting.</p>
      <div className="approval-actions">
        <button type="button" className="btn btn-primary" onClick={() => out.mutate()} disabled={out.isPending}>
          Sign out and continue as {invited}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onLater}>
          Not now
        </button>
      </div>
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
              <button type="button" className="office-choice" onClick={() => goToOffice(o.id, "/", o.subdomain)} disabled={o.status !== "active"}>
                <strong>{o.name}</strong>
                <span className="muted">{o.status === "suspended" ? "Suspended" : o.role === "owner" ? "Owner" : "Accountant"}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {restore.error ? <p className="form-error">{restore.error.message}</p> : null}
      <p>
        <a href={appUrl("/?open=1")}>Open another office</a>
      </p>
      <SignOutLink />
    </Door>
  );
}

function OpenOffice({ me }: { me: Me }) {
  const [name, setName] = useState(() => (params().get("name") ?? "").slice(0, 80));
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
          <a href={appUrl("/")}>Back to my offices</a>
        )}
      </p>
      {first ? <SignOutLink /> : null}
    </Door>
  );
}

/** The business name in the top bar; with more than one office, it opens the list to switch. */
export function OfficeSwitcher({ fallback }: { fallback: string }) {
  const me = useQuery({ ...q.me(), enabled: isLive });
  const here = place();
  const current = me.data?.offices.find((o) => (here.kind === "office" ? o.subdomain === here.subdomain : o.id === localStorage.getItem(ACTIVE_KEY)));
  const name = fallback || current?.name || BRAND.name;
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
              <button type="button" className="link-button" onClick={() => goToOffice(o.id, "/", o.subdomain)}>
                {o.name}
              </button>
            </li>
          ))}
        </ul>
        <a href={appUrl("/?open=1")}>Open another office</a>
      </div>
    </details>
  );
}
