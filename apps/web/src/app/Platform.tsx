import { BRAND, type PlatformBusiness, type PlatformInvited } from "@office/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { account, ApiError, platform } from "../api/client";
import { BrandPlate, LegalFooter } from "./Legal";
import { SignIn } from "./SignIn";
import { appUrl } from "./site";
import "./platform.css";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const appAddress = () => new URL(appUrl("/"), location.href).host;

type Filter = "all" | "active" | "waiting" | "suspended" | "deleting";
const waiting = (b: PlatformBusiness) => b.owners.length === 0 && b.status !== "deleting";

/**
 * The platform owners' console, on `console.<APP_DOMAIN>`: every business's account (who owns it, its people,
 * its status), onboarding a new one and suspending. Nothing from any office's books is shown or reachable here.
 */
export function PlatformConsole() {
  const view = useQuery({ queryKey: ["platform"], queryFn: platform.view, retry: false });
  if (view.error instanceof ApiError && view.error.status === 401) return <SignIn invited={false} staff={{ appAddress: appAddress(), appHref: appUrl("/") }} />;
  if (view.error)
    return (
      <main className="signin" id="main">
        <div className="signin-door">
          <BrandPlate />
          <h1>Platform console</h1>
          <p className="form-error" role="alert">
            {view.error.message}
          </p>
          <p>
            <a className="btn btn-primary" href={appUrl("/")}>
              Go to my offices
            </a>
          </p>
          <SignOut />
        </div>
        <LegalFooter />
      </main>
    );
  if (!view.data) return null;
  return <Console you={view.data.you} businesses={view.data.businesses} />;
}

function SignOut() {
  const out = useMutation({ mutationFn: account.signOut, onSettled: () => location.assign(location.pathname + location.search) });
  return (
    <button type="button" className="link-button" onClick={() => out.mutate()} disabled={out.isPending}>
      Sign out
    </button>
  );
}

function Console({ you, businesses }: { you: { name: string; email: string }; businesses: PlatformBusiness[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const counts = {
    all: businesses.length,
    active: businesses.filter((b) => b.status === "active" && !waiting(b)).length,
    waiting: businesses.filter(waiting).length,
    suspended: businesses.filter((b) => b.status === "suspended").length,
    deleting: businesses.filter((b) => b.status === "deleting").length,
  };
  const people = businesses.reduce((n, b) => n + b.people, 0);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return businesses.filter(
      (b) =>
        (filter === "all" || (filter === "waiting" ? waiting(b) : filter === "active" ? b.status === "active" && !waiting(b) : b.status === filter)) &&
        (!s || [b.name, b.address ?? "", b.ingestEmail, ...b.owners.flatMap((o) => [o.name, o.email]), b.ownerInvite?.email ?? ""].some((t) => t.toLowerCase().includes(s))),
    );
  }, [businesses, filter, search]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar platform-bar">
        <span className="topbar-business">
          {BRAND.name} <span className="muted">· Platform console</span>
        </span>
        <div className="topbar-side">
          <span className="muted">{you.email}</span>
          <SignOut />
        </div>
      </header>
      <main className="main page page-wide platform-page" id="main">
        <div className="page-head">
          <h1>Businesses on the platform</h1>
          <p className="page-lede">Every office's account: who owns it, how many people are in it, and its status. Their books stay private to the people in each office.</p>
        </div>

        <dl className="platform-figures">
          {(
            [
              ["Businesses", counts.all, "all"],
              ["Working", counts.active, "active"],
              ["Waiting for the owner", counts.waiting, "waiting"],
              ["Suspended", counts.suspended, "suspended"],
              ["Being deleted", counts.deleting, "deleting"],
            ] as const
          ).map(([label, n, f]) => (
            <div key={f} className={filter === f ? "is-on" : undefined}>
              <dt>
                <button type="button" className="link-button" onClick={() => setFilter(filter === f ? "all" : f)} aria-pressed={filter === f}>
                  {label}
                </button>
              </dt>
              <dd className="num">{n}</dd>
            </div>
          ))}
          <div>
            <dt>People in offices</dt>
            <dd className="num">{people}</dd>
          </div>
        </dl>

        <Onboard />

        <section className="section" aria-labelledby="all-businesses">
          <div className="section-head">
            <h2 id="all-businesses">{filter === "all" ? "All businesses" : `${shown.length} shown`}</h2>
            <input className="input platform-search" type="search" placeholder="Search name, owner, address" aria-label="Search businesses" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {shown.length ? (
            <div className="ledger-wrap">
              <table className="ledger platform-table">
                <thead>
                  <tr>
                    <th scope="col">Business</th>
                    <th scope="col">Owner</th>
                    <th scope="col" className="num">
                      People
                    </th>
                    <th scope="col">Opened</th>
                    <th scope="col">Last change</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((b) => (
                    <Row key={b.id} b={b} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ledger-empty muted">{businesses.length ? "No business matches." : "No businesses yet. Onboard the first one above, or wait for one to sign up."}</p>
          )}
        </section>
      </main>
    </>
  );
}

function Onboard() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<PlatformInvited | null>(null);
  const onboard = useMutation({
    mutationFn: () => platform.onboard(name.trim(), email.trim()),
    onSuccess: (r) => {
      setDone(r);
      setName("");
      setEmail("");
      void qc.invalidateQueries({ queryKey: ["platform"] });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    onboard.mutate();
  };
  return (
    <section className="section" aria-labelledby="onboard">
      <div className="section-head">
        <h2 id="onboard">Onboard a business</h2>
      </div>
      <p className="section-lede">Opens an empty office and emails its owner a link, good for 14 days. The owner makes an account with that address, steps in and runs the setup themselves. Businesses can also sign up on their own at {appAddress()}.</p>
      <form className="platform-onboard" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="pb-name">Business name</label>
          <input id="pb-name" className="input" required minLength={2} maxLength={80} placeholder="For example, Mehta Hardware" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pb-email">Owner's email</label>
          <input id="pb-email" className="input" type="email" required maxLength={200} placeholder="name@business.in" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={onboard.isPending || name.trim().length < 2 || !email.includes("@")}>
          {onboard.isPending ? "Opening" : "Open the office and invite"}
        </button>
      </form>
      {onboard.error ? (
        <p className="form-error" role="alert">
          {onboard.error.message}
        </p>
      ) : null}
      {done ? <Invited r={done} opened /> : null}
    </section>
  );
}

function Invited({ r, opened = false }: { r: PlatformInvited; opened?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="platform-invited" role="status">
      <p>
        {opened ? <>{r.name} is open. </> : null}
        {r.emailed ? (
          <>
            The invitation went to <strong>{r.email}</strong>.
          </>
        ) : (
          <>
            The email to <strong>{r.email}</strong> did not go out. Send them this link yourself:
          </>
        )}{" "}
        It works once, until {day(r.expiresAt)}.
      </p>
      <p className="platform-link">
        <code>{r.link}</code>{" "}
        <button type="button" className="btn btn-quiet" onClick={() => void navigator.clipboard.writeText(r.link).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy the link"}
        </button>
      </p>
    </div>
  );
}

function Row({ b }: { b: PlatformBusiness }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [invited, setInvited] = useState<PlatformInvited | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["platform"] });
  const status = useMutation({ mutationFn: (s: "active" | "suspended") => platform.setStatus(b.id, s), onSuccess: () => (setConfirming(false), refresh()) });
  const reinvite = useMutation({ mutationFn: (email: string) => platform.inviteOwner(b.id, email), onSuccess: (r) => (setInvited(r), refresh()) });
  const error = status.error ?? reinvite.error;
  return (
    <>
      <tr className={b.status === "active" ? undefined : "is-off"}>
        <th scope="row">
          <strong>{b.name}</strong>
          <span className="muted platform-sub">{b.address ? <a href={b.address}>{new URL(b.address).host}</a> : b.ingestEmail}</span>
        </th>
        <td>
          {b.owners.length ? (
            b.owners.map((o) => (
              <span key={o.email} className="platform-owner">
                {o.name} <span className="muted">{o.email}</span>
              </span>
            ))
          ) : b.ownerInvite ? (
            <span className={b.ownerInvite.expired ? "platform-warn" : "muted"}>
              {b.ownerInvite.expired ? "Invitation expired" : "Invited"}: {b.ownerInvite.email}
              {b.ownerInvite.expired ? null : <> · until {day(b.ownerInvite.expiresAt)}</>}
            </span>
          ) : (
            <span className="platform-warn">No owner</span>
          )}
        </td>
        <td className="num">{b.people}</td>
        <td>
          {day(b.opened)}
          <span className="muted platform-sub">{b.onboardedBy ? `by ${b.onboardedBy}` : "signed up"}</span>
        </td>
        <td>{b.lastEvent ? day(b.lastEvent) : "-"}</td>
        <td>
          <span className={`platform-status is-${waiting(b) && b.status === "active" ? "waiting" : b.status}`}>{b.status === "active" ? (waiting(b) ? "Waiting for owner" : "Working") : b.status === "suspended" ? "Suspended" : "Being deleted"}</span>
        </td>
        <td className="platform-actions">
          {b.status === "deleting" ? (
            <span className="muted">Owner's choice</span>
          ) : confirming ? (
            <>
              <button type="button" className="btn btn-danger" onClick={() => status.mutate("suspended")} disabled={status.isPending}>
                Suspend {b.name}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
                Keep it open
              </button>
            </>
          ) : b.status === "suspended" ? (
            <button type="button" className="btn" onClick={() => status.mutate("active")} disabled={status.isPending}>
              Open again
            </button>
          ) : (
            <>
              {waiting(b) && b.ownerInvite ? (
                <button type="button" className="btn" onClick={() => reinvite.mutate(b.ownerInvite!.email)} disabled={reinvite.isPending}>
                  Send the invitation again
                </button>
              ) : null}
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)}>
                Suspend
              </button>
            </>
          )}
        </td>
      </tr>
      {error || invited || confirming ? (
        <tr className="platform-note">
          <td colSpan={7}>
            {confirming ? <p className="muted">Everyone in {b.name} is shut out until it is opened again; its books, files and addresses stay as they are, and inbound email is refused meanwhile.</p> : null}
            {error ? (
              <p className="form-error" role="alert">
                {error.message}
              </p>
            ) : null}
            {invited ? <Invited r={invited} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
