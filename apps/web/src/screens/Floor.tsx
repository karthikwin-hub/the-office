import type { StagedChange } from "@office/contracts";
import { ACTIONS, FloorPlan, TeamLog } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { q, useDecide } from "../api/queries";
import { usePrefs, useSkin } from "../app/prefs";
import { SkinMenu } from "./SkinMenu";
import { count, isOwner, Page, theAgent } from "./common";

/** Work whose body has to be seen before it is approved: never one click from the floor. */
const REVIEW_ON_DESK = new Set(["audit_flag", "share_file", "payroll_run", "campaign", "calendar", "broadcast", "post"]);
const WIDE_DESK = "(min-width: 1600px)";

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function FloorScreen() {
  const office = useQuery(q.office());
  const [prefs, setPrefs] = usePrefs();
  const skin = useSkin();
  const wideDesk = useMedia(WIDE_DESK);
  const v = office.data;
  const waiting = v?.rooms.filter((r) => r.waitingCount > 0).sort((a, b) => b.waitingCount - a.waitingCount) ?? [];
  const hired = v?.rooms.filter((r) => r.hired).length ?? 0;
  const owner = v?.business.owner.trim() ?? "";
  const first = owner && !owner.includes("@") ? owner.split(" ")[0] : "";
  const vacant = v ? v.rooms.length - hired : 0;

  return (
    <Page ready={Boolean(v)} error={office.error} wide>
      {v ? (
        <div className={`floor${wideDesk && v.deskCount ? " floor-with-desk" : ""}`}>
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
              wholeFloor={prefs.wholeFloor}
              texture={skin.texture}
              renderLink={(agentId, className, children, label) => (
                <Link to="/rooms/$agentId" params={{ agentId }} className={className} aria-label={label}>
                  {children}
                </Link>
              )}
              renderHiringLink={(className, children, label) => (
                <Link to="/hiring" className={className} aria-label={label}>
                  {children}
                </Link>
              )}
            />
            <div className="floor-legend muted">
              <p>
                A shaded room is working now. The number at a door is what that agent has left on your desk.
                {vacant ? (
                  <>
                    {" "}
                    {prefs.wholeFloor ? "Dashed rooms are empty; " : `${count(vacant, "room")} ${vacant === 1 ? "is" : "are"} vacant; `}
                    <Link to="/hiring">hire in the hiring hall</Link>.
                  </>
                ) : null}
              </p>
              <div className="floor-tools">
                {vacant ? (
                  <button type="button" className="link-button" aria-pressed={prefs.wholeFloor} onClick={() => setPrefs({ wholeFloor: !prefs.wholeFloor })}>
                    {prefs.wholeFloor ? "Show only staffed rooms" : "Show the whole floor"}
                  </button>
                ) : null}
                <SkinMenu />
              </div>
            </div>
          </div>
          {wideDesk && v.deskCount ? <DeskColumn /> : null}
          <details className="floor-log" open>
            <summary className="floor-log-summary">Today on the floor</summary>
            <TeamLog entries={v.log} title="Today on the floor" heading={false} />
          </details>
        </div>
      ) : null}
    </Page>
  );
}

/** The top of the desk, beside the floor on wide screens. Routine work can be approved here; anything with a body opens on the desk. */
function DeskColumn() {
  const desk = useQuery(q.desk());
  const decide = useDecide();
  const owner = isOwner();
  const items = desk.data?.items ?? [];
  const top = items.slice(0, 3);
  return (
    <aside className="floor-desk" aria-labelledby="floor-desk-title">
      <h2 id="floor-desk-title" className="floor-desk-title">
        On your desk
      </h2>
      <ol className="floor-desk-list">
        {top.map((i: StagedChange) => (
          <li key={i.id} className="floor-desk-item">
            <p className="floor-desk-from">From {theAgent(i.agentId)}</p>
            <p className="floor-desk-what">{i.title}</p>
            <p className="floor-desk-why">{i.summary}</p>
            <div className="floor-desk-actions">
              {owner && !REVIEW_ON_DESK.has(i.kind) ? (
                <button type="button" className="btn btn-primary btn-small" disabled={decide.isPending} onClick={() => decide.mutate({ id: i.id, decision: { action: "approve" } })}>
                  {ACTIONS[i.kind].verb}
                </button>
              ) : null}
              <Link to="/desk" className="btn btn-small">
                {owner && !REVIEW_ON_DESK.has(i.kind) ? "Open" : "Review"}
              </Link>
            </div>
          </li>
        ))}
      </ol>
      {items.length > top.length ? (
        <p className="floor-desk-more">
          <Link to="/desk">And {count(items.length - top.length, "more")} on your desk</Link>
        </p>
      ) : null}
    </aside>
  );
}
