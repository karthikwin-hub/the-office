import { AGENTS, TEAMS, type AgentState } from "@office/contracts";
import { HireCard } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { q, useHire } from "../api/queries";
import { isOwner, Page, PageHead } from "./common";

export function HiringScreen() {
  const hiring = useQuery(q.hiring());
  const hire = useHire();
  const owner = isOwner();
  const states = hiring.data?.agents ?? [];
  const byTeam = (hired: boolean) =>
    TEAMS.map((t) => ({ team: t, states: AGENTS.filter((a) => a.team === t.id).flatMap((a) => states.filter((s) => s.agentId === a.id && s.hired === hired)) })).filter((g) => g.states.length);
  const staff = byTeam(true);
  const vacancies = byTeam(false);
  const open = vacancies.reduce((n, g) => n + g.states.length, 0);
  const card = (s: AgentState, compact = false) => (
    <HireCard
      key={s.agentId}
      state={s}
      compact={compact}
      readOnly={!owner || s.agentId === "office-manager"}
      busy={hire.isPending && hire.variables?.agentId === s.agentId}
      onHire={() => hire.mutate({ agentId: s.agentId, change: { hired: true } })}
      onLetGo={() => hire.mutate({ agentId: s.agentId, change: { hired: false } })}
    />
  );

  return (
    <Page ready={Boolean(hiring.data)} error={hiring.error}>
      <PageHead
        title="Hiring hall"
        lede={`${open ? `${open} rooms are empty.` : "Every room is staffed."} Everyone starts as a trainee, so nothing they do leaves the office until you approve it. They earn trust from the work you approve without changes.`}
      />
      <section className="hiring-staff" aria-labelledby="hiring-staff">
        <h2 id="hiring-staff">Your team</h2>
        {staff.map((g) => (
          <section key={g.team.id} className="hiring-team" aria-label={g.team.name}>
            <h3 className="hiring-team-name">{g.team.name}</h3>
            {g.states.map((s) => card(s))}
          </section>
        ))}
      </section>
      {open ? (
        <section className="hiring-vacancies" aria-labelledby="hiring-vacancies">
          <h2 id="hiring-vacancies">Vacancies ({open})</h2>
          <div className="hiring-vacancy-grid">
            {vacancies.map((g) => (
              <section key={g.team.id} className="hiring-team" aria-label={g.team.name}>
                <h3 className="hiring-team-name">{g.team.name}</h3>
                {g.states.map((s) => card(s, true))}
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </Page>
  );
}
