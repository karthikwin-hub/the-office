import type { RoutineOutcome, RoutineRun, RoutineView } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client";
import { q, useChange } from "../api/queries";
import { isOwner, Page, PageHead } from "./common";

const OUTCOME: Record<RoutineOutcome, { label: string; tone: string }> = {
  ok: { label: "Done", tone: "ok" },
  nothing: { label: "Nothing to do", tone: "quiet" },
  partial: { label: "Partly done", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Paused", tone: "quiet" },
};

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const day = d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === new Date(today.getTime() + 86_400_000).toDateString() ? "Tomorrow" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${day}, ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
};

export function Outcome({ outcome }: { outcome: RoutineOutcome }) {
  const o = OUTCOME[outcome];
  return <span className={`outcome outcome-${o.tone}`}>{o.label}</span>;
}

export function RoutinesScreen() {
  const routines = useQuery(q.routines());
  const list = routines.data?.routines ?? [];
  const failing = list.filter((r) => r.failedThisWeek > 0).length;
  return (
    <Page ready={Boolean(routines.data)} error={routines.error}>
      <PageHead
        title="Routines"
        lede={`The work the office does on its own, on a schedule. Each run is kept for 90 days with what it did. ${failing ? `${failing === 1 ? "One routine needed" : `${failing} routines needed`} attention this week.` : "Nothing needed attention this week."}`}
      />
      <RoutineList routines={list} />
    </Page>
  );
}

/** The routines, each with its owner, schedule, next and last run; history opens underneath. */
export function RoutineList({ routines, showAgent = true }: { routines: RoutineView[]; showAgent?: boolean }) {
  const owner = isOwner();
  const change = useChange();
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const act = (id: string, run: () => Promise<unknown>) => {
    setError(null);
    change.mutate(run, { onError: (e) => setError({ id, message: e instanceof Error ? e.message : String(e) }) });
  };
  if (!routines.length) return <p className="muted">No routines.</p>;
  return (
    <ul className="routines">
      {routines.map((r) => (
        <li key={r.id} className={`routine${r.active ? "" : " routine-off"}`}>
          <div className="routine-head">
            <h3 className="routine-title">{r.title}</h3>
            {r.last ? <Outcome outcome={r.last.outcome} /> : <span className="outcome outcome-quiet">Not run yet</span>}
          </div>
          <p className="routine-does">{r.does}</p>
          <dl className="routine-facts">
            {showAgent ? (
              <div>
                <dt>Run by</dt>
                <dd>
                  <Link to="/rooms/$agentId" params={{ agentId: r.agentId }}>
                    {AGENT_BY_ID[r.agentId]?.title ?? r.agentId}
                  </Link>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>When</dt>
              <dd>{r.schedule}</dd>
            </div>
            <div>
              <dt>Next</dt>
              <dd>{!r.active ? "Not on the team" : r.paused ? "Paused" : r.nextRunAt ? when(r.nextRunAt) : "When something is due"}</dd>
            </div>
            {r.last ? (
              <div>
                <dt>Last</dt>
                <dd>
                  {when(r.last.startedAt)}: {r.last.summary}
                </dd>
              </div>
            ) : null}
          </dl>
          {owner && r.active ? (
            <div className="routine-actions">
              <button type="button" className="btn" disabled={change.isPending} onClick={() => act(r.id, () => api.runRoutine(r.id))}>
                Run now
              </button>
              <button type="button" className="btn btn-quiet" disabled={change.isPending} onClick={() => act(r.id, () => api.pauseRoutine(r.id, !r.paused))}>
                {r.paused ? "Resume" : "Pause"}
              </button>
            </div>
          ) : null}
          {error?.id === r.id ? (
            <p className="form-error" role="alert">
              {error.message}
            </p>
          ) : null}
          <History id={r.id} />
        </li>
      ))}
    </ul>
  );
}

function History({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const runs = useQuery({ ...q.routineRuns(id), enabled: open });
  return (
    <details className="routine-history" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Earlier runs</summary>
      {runs.data ? runs.data.runs.length ? <RunTable runs={runs.data.runs} /> : <p className="muted">No runs yet.</p> : <p className="loading">Fetching the runs</p>}
    </details>
  );
}

function RunTable({ runs }: { runs: RoutineRun[] }) {
  return (
    <table className="ledger routine-runs">
      <caption className="ledger-caption">Runs, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Started</th>
          <th scope="col">How</th>
          <th scope="col">Outcome</th>
          <th scope="col">What happened</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((x) => (
          <tr key={x.id}>
            <td className="num">{when(x.startedAt)}</td>
            <td>{x.trigger === "manual" ? "Run by you" : "On schedule"}</td>
            <td>
              <Outcome outcome={x.outcome} />
            </td>
            <td>
              {x.summary}
              {x.error && x.outcome === "failed" ? <span className="muted"> ({x.error.slice(0, 160)})</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
