import { FloorPlan, TeamLog } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { q } from "../api/queries";
import { count, Page, theAgent } from "./common";

export function FloorScreen() {
  const office = useQuery(q.office());
  const v = office.data;
  const waiting = v?.rooms.filter((r) => r.waitingCount > 0).sort((a, b) => b.waitingCount - a.waitingCount) ?? [];
  const hired = v?.rooms.filter((r) => r.hired).length ?? 0;
  const owner = v?.business.owner.trim() ?? "";
  const first = owner && !owner.includes("@") ? owner.split(" ")[0] : "";

  return (
    <Page ready={Boolean(v)} error={office.error} wide>
      {v ? (
        <div className="floor">
          <div className="floor-main">
            <div className="floor-head">
              <h1 className="visually-hidden">The floor</h1>
              <p className="floor-greeting">
                {v.deskCount ? (
                  <>
                    {first ? `${first}, ` : ""}
                    <Link to="/desk">{count(v.deskCount, "thing")} wait on your desk</Link>
                    {waiting.length ? `, most from ${theAgent(waiting[0]!.agentId)}` : ""}.
                  </>
                ) : (
                  <>{first ? `${first}, your` : "Your"} desk is clear.</>
                )}{" "}
                <span className="muted">
                  {hired} of {v.rooms.length} rooms are staffed.
                </span>
              </p>
              {!v.business.gstin && !v.business.legalName ? (
                <p className="floor-setup">
                  Your office is new. <Link to="/settings">Enter your business details</Link> so the Accountant can tell your bills from your invoices, then forward or upload your first documents in{" "}
                  <Link to="/rooms/$agentId" params={{ agentId: "accountant" }}>
                    the Accountant's room
                  </Link>
                  .
                </p>
              ) : null}
            </div>
            <FloorPlan
              rooms={v.rooms}
              arriving={v.arriving}
              renderLink={(agentId, className, children, label) => (
                <Link to="/rooms/$agentId" params={{ agentId }} className={className} aria-label={label}>
                  {children}
                </Link>
              )}
            />
            <p className="floor-legend muted">
              A blue room is working now. The number at a door is what that agent has left on your desk. Dashed rooms are empty; <Link to="/hiring">hire for them in the hiring hall</Link>.
            </p>
          </div>
          <aside className="floor-log">
            <TeamLog entries={v.log} title="Today on the floor" />
          </aside>
        </div>
      ) : null}
    </Page>
  );
}
