import type { StagedChange } from "@office/contracts";
import { AGENTS } from "@office/contracts";
import { ACTIONS, ApprovalCard } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { q, useDecide } from "../api/queries";
import { useApprovalBody } from "../reports/social";
import { count, isOwner, Page, PageHead, theAgent, useApprovalContext } from "./common";
import { ImportBody } from "./SettingsOnboarding";

const ACCOUNTANT_MAY = new Set(["audit_flag", "share_file"]);

export function DeskScreen() {
  const desk = useQuery(q.desk());
  const decide = useDecide();
  const [agent, setAgent] = useState<string>("all");
  const owner = isOwner();
  const items = desk.data?.items ?? [];
  const agents = AGENTS.filter((a) => items.some((i) => i.agentId === a.id));
  const shown = agent === "all" ? items : items.filter((i) => i.agentId === agent);
  const groups = agents.filter((a) => agent === "all" || a.id === agent).map((a) => ({ agent: a, items: shown.filter((i) => i.agentId === a.id) }));

  const approveAll = async (list: StagedChange[]) => {
    for (const i of list) await decide.mutateAsync({ id: i.id, decision: { action: "approve" } });
  };

  const contextFor = useApprovalContext();
  const bodyFor = useApprovalBody();

  return (
    <Page ready={Boolean(desk.data)} error={desk.error}>
      <PageHead
        title={owner ? "Your desk" : "The owner's desk"}
        lede={
          !owner
            ? `${count(items.length, "piece")} of work ${items.length === 1 ? "is" : "are"} waiting for the owner. You can act on the Auditor's findings and on files shared with you; the rest is for reading.`
            : items.length
              ? `${count(items.length, "piece")} of work ${items.length === 1 ? "is" : "are"} waiting for you. Nothing here has been sent, posted or filed yet.`
              : "Nothing is waiting for you. The team will put new work here as it comes in."
        }
      />
      {agents.length > 1 ? (
        <div className="filter" role="group" aria-label="Show work from">
          <button type="button" className="filter-option" aria-pressed={agent === "all"} onClick={() => setAgent("all")}>
            Everyone <span className="num">{items.length}</span>
          </button>
          {agents.map((a) => (
            <button key={a.id} type="button" className="filter-option" aria-pressed={agent === a.id} onClick={() => setAgent(a.id)}>
              {a.short} <span className="num">{items.filter((i) => i.agentId === a.id).length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {groups.map(({ agent: a, items: list }) => (
        <section key={a.id} className="desk-group" aria-labelledby={`desk-${a.id}`}>
          <div className="desk-group-head">
            <h2 id={`desk-${a.id}`} className="desk-group-title">
              From {theAgent(a.id)}
            </h2>
            {owner && list.length > 3 && list.every((i) => i.kind === list[0]!.kind) ? (
              <button type="button" className="btn" disabled={decide.isPending} onClick={() => void approveAll(list)}>
                {ACTIONS[list[0]!.kind].verb} for all {list.length}
              </button>
            ) : null}
          </div>
          {list.map((i) => (
            <ApprovalCard
              key={i.id}
              item={i}
              showAgent={false}
              context={contextFor(i)}
              body={i.kind === "onboarding" ? <ImportBody item={i} /> : bodyFor(i)}
              busy={decide.isPending && decide.variables?.id === i.id}
              readOnly={!owner && !ACCOUNTANT_MAY.has(i.kind) ? "Waiting for the owner to approve." : false}
              onDecide={(decision) => decide.mutate({ id: i.id, decision })}
            />
          ))}
        </section>
      ))}
      {desk.data?.decided.length ? (
        <details className="desk-decided">
          <summary>
            Decided today <span className="num">{desk.data.decided.length}</span>
          </summary>
          {desk.data.decided.map((i) => (
            <ApprovalCard key={i.id} item={i} showAgent context={undefined} />
          ))}
        </details>
      ) : null}
      {decide.error ? <p className="form-error">{(decide.error as Error).message}</p> : null}
      <p className="desk-foot muted">
        Every approval without changes counts toward that agent's next trust level. The Office Manager emails you this list each morning at the digest time set in settings.
      </p>
    </Page>
  );
}
