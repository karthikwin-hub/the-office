import type { PersonaNames } from "@office/contracts";
import { AGENT_BY_ID, TEAMS } from "@office/contracts";
import { ApprovalCard, HireCard, personaFor, TeamLog, TrustLevel } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { q, useDecide, useHire } from "../api/queries";
import { useApprovalBody } from "../reports/social";
import { count, isOwner, Register, theAgent, useApprovalContext } from "./common";

/** What an accountant may decide; everything else waits for an owner. */
const ACCOUNTANT_MAY = new Set(["audit_flag", "share_file"]);
/** Enough to work through without leaving the floor; the rest are a click away in the room. */
const SHOWN = 4;

/**
 * The right-hand panel of the Floor on a desktop: the room someone clicked, or the owner's desk,
 * without leaving the floor. The full page is one link away.
 */
export function PanelShell({ title, kicker, open, onClose, children }: { title: string; kicker: string; open: ReactNode; onClose: () => void; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Keyboard and screen-reader users land on the panel they opened.
  useEffect(() => heading.current?.focus({ preventScroll: true }), [title]);
  return (
    <aside className="floor-panel" aria-labelledby="floor-panel-title">
      <div className="floor-panel-head">
        <div>
          <p className="floor-panel-kicker">{kicker}</p>
          <h2 id="floor-panel-title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <button type="button" className="floor-panel-close" onClick={onClose} aria-label="Close, back to today on the floor" title="Close (Esc)">
          ×
        </button>
      </div>
      <p className="floor-panel-links">
        {open}
        <button type="button" className="link-button" onClick={onClose}>
          Back to today on the floor
        </button>
      </p>
      {children}
    </aside>
  );
}

export function AgentPanel({ agentId, names, people, onClose }: { agentId: string; names: PersonaNames; people: boolean; onClose: () => void }) {
  const room = useQuery(q.agent(agentId));
  const def = AGENT_BY_ID[agentId];
  const owner = isOwner();
  const hire = useHire();
  const decide = useDecide();
  const contextFor = useApprovalContext();
  const bodyFor = useApprovalBody();
  if (!def) return null;
  const wing = TEAMS.find((t) => t.id === def.team)?.wing ?? "";
  const title = people ? `${personaFor(agentId, names).name}, ${def.short}` : def.title;
  const v = room.data;
  return (
    <PanelShell
      title={title}
      kicker={wing}
      onClose={onClose}
      open={
        <Link to="/rooms/$agentId" params={{ agentId }} className="floor-panel-open">
          Open the full room
        </Link>
      }
    >
      {!v ? (
        <p className="muted">{room.error ? "This room could not be opened just now." : "One moment."}</p>
      ) : !v.state.hired ? (
        <div className="floor-panel-body">
          <p className="muted">This room is empty.</p>
          <HireCard state={v.state} readOnly={!owner} busy={hire.isPending} onHire={() => hire.mutate({ agentId, change: { hired: true } })} />
        </div>
      ) : (
        <div className="floor-panel-body">
          <p className="room-now-line">
            <span className={`room-dot room-dot-${v.status.status}`} aria-hidden="true" />
            <span>
              {v.status.status === "working" ? "Working now: " : v.status.status === "waiting" ? "Waiting for you. Last: " : "Last: "}
              {v.status.now}
            </span>
          </p>
          <p className="floor-panel-standing">
            <TrustLevel level={v.state.trustLevel} compact />
            <span className="muted">{v.accuracyPct === null ? "No work checked yet" : `${v.accuracyPct}% of ${count(v.state.accuracy.checked, "piece")} of work approved without changes`}</span>
          </p>
          <Register items={v.kpis} />
          {v.promotion && owner ? (
            <div className="promotion">
              <p>
                <strong>Ready for promotion to {v.promotion.to}.</strong> {v.promotion.reason}
              </p>
              <button type="button" className="btn btn-primary" disabled={hire.isPending} onClick={() => hire.mutate({ agentId, change: { trustLevel: v.promotion!.to } })}>
                Promote to {v.promotion.to}
              </button>
            </div>
          ) : null}
          {v.pending.length ? (
            <section aria-labelledby="floor-panel-waiting">
              <h3 id="floor-panel-waiting" className="floor-panel-section">
                Waiting for you ({v.pending.length})
              </h3>
              {v.pending.slice(0, SHOWN).map((i) => (
                <ApprovalCard
                  key={i.id}
                  item={i}
                  showAgent={false}
                  context={contextFor(i)}
                  body={bodyFor(i)}
                  busy={decide.isPending && decide.variables?.id === i.id}
                  readOnly={!owner && !ACCOUNTANT_MAY.has(i.kind) ? "Waiting for the owner to approve." : false}
                  onDecide={(decision) => decide.mutate({ id: i.id, decision })}
                />
              ))}
              {v.pending.length > SHOWN ? (
                <p className="floor-panel-more">
                  <Link to="/rooms/$agentId" params={{ agentId }}>
                    And {v.pending.length - SHOWN} more in the room
                  </Link>
                </p>
              ) : null}
            </section>
          ) : (
            <p className="muted">Nothing from {theAgent(agentId)} is waiting for you.</p>
          )}
          <TeamLog title={`What ${theAgent(agentId)} did`} entries={v.log.slice(0, 8)} showAgent={false} empty="Nothing recorded yet." />
        </div>
      )}
    </PanelShell>
  );
}
