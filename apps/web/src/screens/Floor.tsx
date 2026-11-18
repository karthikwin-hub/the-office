import type { StagedChange } from "@office/contracts";
import { actionFor, ClosedLedger, dioramaSupport, FloorPlan, khataYear, LivingFloor, personaLabel, TeamLog } from "@office/ui";
import type { DioramaProps } from "@office/ui/diorama";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { q, useDecide } from "../api/queries";
import { useChosenSkin, usePrefs, useSimplePicture, useSkin } from "../app/prefs";
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

/** The 3D Lived-in office comes in its own download; if it cannot be fetched, the drawn floor takes its place. */
function CouldNotLoad({ onFallback }: DioramaProps) {
  useEffect(() => onFallback("the 3D office could not be downloaded"), [onFallback]);
  return null;
}
const Diorama = lazy<ComponentType<DioramaProps>>(() =>
  import("@office/ui/diorama")
    .then((m) => ({ default: m.Diorama }))
    .catch(() => ({ default: CouldNotLoad })),
);

/** `?at=18:40&temp=36` sets the Lived-in office's clock and weather, for the picture only: demos and screenshots. */
function pictureOverrides(): { at: number | null; temp: number | null } {
  const p = new URLSearchParams(location.search);
  const m = /^(\d{1,2}):(\d{2})$/.exec(p.get("at") ?? "");
  const t = Number(p.get("temp"));
  return { at: m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : null, temp: p.has("temp") && Number.isFinite(t) ? t : null };
}

/** Until the six compliance questions are answered, the filing calendar is only partly known. */
function CalendarNudge() {
  const view = useQuery(q.compliance());
  const open = view.data?.answers.filter((a) => !a.answered).length ?? 0;
  if (!open) return null;
  return (
    <p className="floor-setup">
      {`Answer ${open === view.data!.answers.length ? "" : "the last "}${count(open, "question")} to build your filing calendar. `}
      <Link to="/settings" hash="compliance">
        Answer them in Settings
      </Link>
    </p>
  );
}

export function FloorScreen() {
  const office = useQuery(q.office());
  const [prefs, setPrefs] = usePrefs();
  const skin = useSkin();
  const lived = skin.id === "lived-in";
  // On a phone the Lived-in office is the plain floor, still with the team's names on the doors.
  const people = useChosenSkin() === "lived-in";
  const [simple] = useSimplePicture();
  const [fallback, setFallback] = useState<string | null>(null);
  const use3d = lived && !simple && !fallback && dioramaSupport().ok;
  const picture = useMemo(pictureOverrides, []);
  const navigate = useNavigate();
  const ambient = useQuery({ ...q.ambient(), enabled: people });
  const weather = useQuery({ ...q.weather(), enabled: lived });
  const names = ambient.data?.names ?? {};
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
              {v.rooms.some((r) => r.agentId === "compliance-officer" && r.hired) ? <CalendarNudge /> : null}
            </div>
            {use3d ? (
              <Suspense
                fallback={
                  <div className="diorama">
                    <ClosedLedger name={v.business.name || "Your office"} year={khataYear(Date.now())} />
                  </div>
                }
              >
                <Diorama
                  view={v}
                  names={names}
                  ambient={ambient.data ?? null}
                  weather={weather.data?.weather ?? null}
                  at={picture.at}
                  tempC={picture.temp}
                  onFallback={setFallback}
                  onOpen={(t) => (t.kind === "room" ? navigate({ to: "/rooms/$agentId", params: { agentId: t.id } }) : navigate({ to: t.kind === "desk" ? "/desk" : "/hiring" }))}
                  renderLink={(agentId, className, children, label) => (
                    <Link to="/rooms/$agentId" params={{ agentId }} className={className} aria-label={label}>
                      {children}
                    </Link>
                  )}
                  renderDeskLink={(className, children, label) => (
                    <Link to="/desk" className={className} aria-label={label}>
                      {children}
                    </Link>
                  )}
                />
              </Suspense>
            ) : (
              <FloorPlan
                rooms={v.rooms}
                arriving={v.arriving}
                wholeFloor={prefs.wholeFloor}
                texture={skin.texture}
                nameFor={people && !lived ? (id) => personaLabel(id, names) : undefined}
                overlay={lived ? (plan) => <LivingFloor plan={plan} inputs={{ rooms: v.rooms, log: v.log, arriving: v.arriving, names, ambient: ambient.data ?? null, weather: weather.data?.weather ?? null }} /> : undefined}
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
            )}
            <div className="floor-legend muted">
              {use3d ? (
                <p>
                  Click a room or its name to open it. Your desk is at the end of the corridor, with a sheet on the pile for everything waiting.
                  {vacant ? (
                    <>
                      {" "}
                      Rooms lying flat on the page are empty; <Link to="/hiring">hire in the hiring hall</Link>.
                    </>
                  ) : null}
                </p>
              ) : (
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
              )}
              <div className="floor-tools">
                {vacant && !use3d ? (
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
            <TeamLog entries={v.log} title="Today on the floor" heading={false} label={people ? (id) => personaLabel(id, names) : undefined} />
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
                  {actionFor(i).verb}
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
