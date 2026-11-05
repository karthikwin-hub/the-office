import { AGENTS, TEAMS } from "@office/contracts";
import { HireCard } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { q, useHire } from "../api/queries";
import { isOwner, Page, PageHead } from "./common";

export function HiringScreen() {
  const hiring = useQuery(q.hiring());
  const hire = useHire();
  const owner = isOwner();
  const states = hiring.data?.agents ?? [];
  const open = states.filter((s) => !s.hired).length;

  return (
    <Page ready={Boolean(hiring.data)} error={hiring.error}>
      <PageHead
        title="Hiring hall"
        lede={`${open ? `${open} rooms are empty.` : "Every room is staffed."} Everyone starts as a trainee, so nothing they do leaves the office until you approve it. They earn trust from the work you approve without changes.`}
      />
      {TEAMS.map((t) => {
        const team = AGENTS.filter((a) => a.team === t.id);
        return (
          <section key={t.id} className="hiring-team" aria-labelledby={`team-${t.id}`}>
            <h2 id={`team-${t.id}`}>{t.name}</h2>
            {team.map((a) => {
              const s = states.find((x) => x.agentId === a.id);
              return s ? (
                <HireCard
                  key={a.id}
                  state={s}
                  readOnly={!owner || a.id === "office-manager"}
                  busy={hire.isPending && hire.variables?.agentId === a.id}
                  onHire={() => hire.mutate({ agentId: a.id, change: { hired: true } })}
                  onLetGo={() => hire.mutate({ agentId: a.id, change: { hired: false } })}
                />
              ) : null;
            })}
          </section>
        );
      })}
    </Page>
  );
}
