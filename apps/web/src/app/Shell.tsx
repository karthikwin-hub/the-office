import type { AskResponse } from "@office/contracts";
import { dateLabel } from "@office/engine";
import { CoveringNote, FigureContext, SourceViewer } from "@office/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { account, ApiError, isLive, viewingAs } from "../api/client";
import { q, useAsk } from "../api/queries";
import { useBackgroundReader } from "../intake/intake";
import { useApplySkin } from "./prefs";
import { OfficeGate, OfficeSwitcher } from "./Offices";
import { useLiveUpdates } from "./live";

/** In the live app nothing of an office loads until someone has signed in and chosen an office they are in. */
export function Shell() {
  if (!isLive) return <OfficeShell />;
  return (
    <OfficeGate>
      <SessionGate />
    </OfficeGate>
  );
}

function SessionGate() {
  const session = useQuery(q.session());
  if (!session.data)
    return session.error ? (
      <main className="signin">
        <p className="form-error" role="alert">
          The office could not be reached. {session.error instanceof ApiError && session.error.status === 404 ? "You are not in this office any more." : session.error.message}
        </p>
        <a href="/">Go to my offices</a>
      </main>
    ) : null;
  return <OfficeShell />;
}

function OfficeShell() {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const office = useQuery(q.office());
  const session = useQuery(q.session());
  const role = viewingAs();
  const live = useLiveUpdates(isLive);
  useBackgroundReader(isLive);
  useApplySkin();
  const signOut = useMutation({ mutationFn: account.signOut, onSettled: () => location.assign("/") });

  const figures = useMemo(
    () => ({
      open: (figure: string) => void navigate({ to: ".", search: (s) => ({ ...s, figure, doc: undefined, region: undefined }), resetScroll: false }),
      openDocument: (doc: string, region?: string | null) => void navigate({ to: ".", search: (s) => ({ ...s, doc, region: region ?? undefined }), resetScroll: false }),
    }),
    [navigate],
  );

  return (
    <FigureContext.Provider value={figures}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <OfficeSwitcher fallback={office.data?.business.name ?? ""} />
        <nav className="topbar-nav" aria-label="Spaces">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ "aria-current": "page" }}>
            Floor
          </Link>
          <Link to="/boardroom" activeProps={{ "aria-current": "page" }}>
            Boardroom
          </Link>
          <Link to="/desk" activeProps={{ "aria-current": "page" }}>
            {role === "owner" ? "Your desk" : "Owner's desk"}
            {office.data?.deskCount ? (
              <span className="topbar-count num" aria-label={`, ${office.data.deskCount} waiting`}>
                {office.data.deskCount}
              </span>
            ) : null}
          </Link>
        </nav>
        <div className="topbar-side">
          <button type="button" className="btn btn-quiet" onClick={() => void navigate({ to: ".", search: (s) => ({ ...s, ask: "open" }), resetScroll: false })}>
            Ask the office manager
          </button>
          <nav className="topbar-secondary" aria-label="Office">
            <Link to="/hiring" activeProps={{ "aria-current": "page" }}>
              Hiring hall
            </Link>
            <Link to="/settings" activeProps={{ "aria-current": "page" }}>
              Settings
            </Link>
          </nav>
          {office.data ? (
            <span className="topbar-asof" title={isLive ? (live === "connected" ? "Updates as the team works" : "Reconnecting; checking every minute") : undefined}>
              Books as of {dateLabel(office.data.business.asOf)}
              {isLive && live !== "connected" ? <span className="muted"> · reconnecting</span> : null}
            </span>
          ) : null}
          {isLive ? (
            <button type="button" className="btn btn-quiet" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      {role === "accountant" ? (
        <p className="role-banner">
          You are signed in as {session.data?.user.name ?? "the accountant"} from {office.data?.business.accountantFirm ?? "your firm"}. You can read everything, download the return files and answer the Auditor. Approvals stay with the owner.
        </p>
      ) : null}
      {session.data?.mode === "mock" ? <p className="mock-banner">Sample office. Every figure is generated, and nothing you approve is sent.</p> : null}
      <main id="main" className="main">
        <Outlet />
      </main>
      <SourceHost figure={search.figure} doc={search.doc} region={search.region} asOf={office.data?.business.asOf} />
      <AskPanel open={search.ask === "open"} onClose={() => void navigate({ to: ".", search: (s) => ({ ...s, ask: undefined }), resetScroll: false })} />
    </FigureContext.Provider>
  );
}

function SourceHost({ figure, doc, region, asOf }: { figure?: string; doc?: string; region?: string; asOf?: string }) {
  const navigate = useNavigate();
  const trace = useQuery({ ...q.trace(figure ?? ""), enabled: Boolean(figure) });
  const firstDoc = trace.data?.rows.find((r) => r.docId);
  const docId = doc ?? (figure ? firstDoc?.docId ?? undefined : undefined);
  const activeRegion = doc ? region : figure ? firstDoc?.region ?? undefined : region;
  const document = useQuery({ ...q.document(docId ?? ""), enabled: Boolean(docId) });
  const selected = trace.data ? trace.data.rows.findIndex((r) => r.docId === docId && (r.region ?? undefined) === (activeRegion ?? undefined)) : undefined;
  const close = useCallback(() => void navigate({ to: ".", search: (s) => ({ ...s, figure: undefined, doc: undefined, region: undefined }), resetScroll: false }), [navigate]);
  const open = Boolean(figure || doc);
  return (
    <SourceViewer
      open={open}
      onClose={close}
      trace={figure ? (trace.data ?? null) : null}
      traceLoading={Boolean(figure) && trace.isLoading}
      doc={docId ? (document.data ?? null) : null}
      docLoading={Boolean(docId) && document.isLoading}
      region={activeRegion}
      selectedRow={selected !== undefined && selected >= 0 ? selected : undefined}
      onSelectRow={(r) => void navigate({ to: ".", search: (s) => ({ ...s, doc: r.docId ?? undefined, region: r.region ?? undefined }), resetScroll: false })}
      onRegion={(key) => void navigate({ to: ".", search: (s) => ({ ...s, doc: docId, region: key }), resetScroll: false })}
      asOf={asOf}
      docActions={
        document.data?.party ? (
          <p className="source-doc-foot">
            <Link to="/parties/$partyId" params={{ partyId: document.data.party.id }} onClick={close}>
              Everything with {document.data.party.name}
            </Link>
          </p>
        ) : null
      }
    />
  );
}

const STARTERS = ["What is waiting for me?", "Who owes me the most?", "Has my accountant filed everything correctly?", "What GST do I pay this month?"];

/** The Office Manager: answers in sentences whose figures open their proof. */
function AskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ask = useAsk();
  const [thread, setThread] = useState<{ q: string; a: AskResponse | null }[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.show();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const send = (question: string) => {
    if (!question.trim()) return;
    setThread((t) => [...t, { q: question, a: null }]);
    setText("");
    ask.mutate(question, { onSuccess: (a) => setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a } : x))) });
  };
  const last = thread.at(-1)?.a;

  return (
    <dialog ref={ref} className="ask-panel" aria-label="Ask the office manager" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="ask-head">
        <h2>The Office Manager</h2>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="ask-thread" aria-live="polite">
        {thread.length === 0 ? <p className="muted">Ask about the business in your own words. Every figure in the answer opens the documents behind it.</p> : null}
        {thread.map((t, i) => (
          <div key={i} className="ask-turn">
            <p className="ask-q">{t.q}</p>
            {t.a ? <CoveringNote note={t.a.answer} title="Answer" /> : <p className="muted">Checking the books</p>}
          </div>
        ))}
      </div>
      <div className="ask-suggest">
        {(last?.followUps ?? STARTERS).slice(0, 4).map((s) => (
          <button key={s} type="button" className="btn ask-chip" onClick={() => send(s)} disabled={ask.isPending}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="ask-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="ask-input" className="visually-hidden">
          Your question
        </label>
        <input id="ask-input" ref={input} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Which customers are slowest to pay?" maxLength={500} />
        <button type="submit" className="btn btn-primary" disabled={ask.isPending || !text.trim()}>
          Ask
        </button>
      </form>
    </dialog>
  );
}
