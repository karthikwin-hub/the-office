import type { AgentState } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import { useId } from "react";
import { ACTIONS } from "./ApprovalCard";
import { TrustLevel } from "./TrustLevel";

/** A job description in the Hiring Hall: what the agent does and what it will ask you to approve. */
export function HireCard({ state, onHire, onLetGo, busy, readOnly }: { state: AgentState; onHire?: () => void; onLetGo?: () => void; busy?: boolean; readOnly?: boolean }) {
  const def = AGENT_BY_ID[state.agentId]!;
  const id = useId();
  const pct = state.accuracy.checked ? Math.round((state.accuracy.correct / state.accuracy.checked) * 1000) / 10 : null;
  return (
    <article className={`hire${state.hired ? " hire-hired" : ""}`} aria-labelledby={`${id}-t`}>
      <div className="hire-main">
        <h3 id={`${id}-t`}>{def.title}</h3>
        <p className="hire-job">{def.job}</p>
        <ul className="hire-duties">
          {def.duties.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        {def.proposes.length ? (
          <p className="hire-asks muted">Will ask you to approve: {def.proposes.map((k) => ACTIONS[k].verb.toLowerCase()).join(", ")}.</p>
        ) : (
          <p className="hire-asks muted">Only answers and reports; never acts on its own.</p>
        )}
      </div>
      <div className="hire-side">
        {state.hired ? (
          <>
            <p>
              On the team since <span className="num">{new Date(state.hiredOn!).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}</span>
            </p>
            <TrustLevel level={state.trustLevel} compact />
            {pct !== null ? (
              <p className="muted">
                <span className="num">{pct}%</span> of <span className="num">{state.accuracy.checked}</span> approved without changes
              </p>
            ) : null}
            {readOnly ? null : (
              <button type="button" className="btn btn-quiet" onClick={onLetGo} disabled={busy}>
                Let go
              </button>
            )}
          </>
        ) : readOnly ? (
          <p className="muted">Not hired</p>
        ) : (
          <>
            <p className="muted">Starts as a trainee: everything waits for you.</p>
            <button type="button" className="btn btn-primary" onClick={onHire} disabled={busy}>
              Hire {def.title.replace(/^The /, "the ").replace(/ (\S)/g, (_, c: string) => ` ${c.toLowerCase()}`)}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
