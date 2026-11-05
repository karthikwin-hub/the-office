import type { OfficeView, RoomStatus } from "@office/contracts";
import { AGENT_BY_ID, AGENTS, TEAMS, type TeamId } from "@office/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Rect = { x: number; y: number; w: number; h: number };
/** `h` doors sit in a horizontal wall; `into` is the direction the leaf swings (+1 down or right). */
type Door = { x: number; y: number; orient: "h" | "v"; into: 1 | -1; size: number };
type PlacedRoom = { agentId: string; rect: Rect; door: Door };
type WingLabel = { text: string; x: number; y: number; anchor?: "start" | "middle"; rotate?: boolean };
type Plan = { width: number; height: number; rooms: PlacedRoom[]; corridor: Rect; wings: WingLabel[]; entrance: Door; building: Rect; narrow: boolean };

const TOP: TeamId[] = ["accounts", "sales"];
const BOTTOM: TeamId[] = ["marketing", "social", "operations", "people"];
const DOOR = 34;
const NARROW_DOOR = 24;

const teamAgents = (t: TeamId) => AGENTS.filter((a) => a.team === t).map((a) => a.id);
const wingName = (t: TeamId) => TEAMS.find((x) => x.id === t)!.wing;

/** Wide plan: reception at the entrance on the left, one corridor, rooms either side. */
function widePlan(): Plan {
  const width = 1200;
  const top = 44, roomH = 176, corridorH = 76;
  const left = 16, receptionW = 168, right = width - 16;
  const corridor = { x: left + receptionW, y: top + roomH, w: right - left - receptionW, h: corridorH };
  const rooms: PlacedRoom[] = [];
  const wings: WingLabel[] = [];
  const row = (teams: TeamId[], y: number, side: "top" | "bottom") => {
    const ids = teams.flatMap(teamAgents);
    const w = corridor.w / ids.length;
    let i = 0;
    for (const t of teams) {
      wings.push({ text: wingName(t), x: corridor.x + i * w + 10, y: side === "top" ? top - 14 : y + roomH + 26 });
      for (const id of teamAgents(t)) {
        const x = corridor.x + i * w;
        rooms.push({ agentId: id, rect: { x, y, w, h: roomH }, door: { x: x + w - DOOR - 16, y: side === "top" ? y + roomH : y, orient: "h", into: side === "top" ? 1 : -1, size: DOOR } });
        i++;
      }
    }
  };
  row(TOP, top, "top");
  row(BOTTOM, top + roomH + corridorH, "bottom");
  const bH = roomH * 2 + corridorH;
  rooms.unshift({ agentId: "office-manager", rect: { x: left, y: top, w: receptionW, h: bH }, door: { x: left + receptionW, y: corridor.y + 21, orient: "v", into: 1, size: DOOR } });
  wings.unshift({ text: wingName("front"), x: left + 10, y: top - 14 });
  return {
    width,
    height: top + bH + 44,
    rooms,
    corridor,
    wings,
    entrance: { x: left, y: corridor.y + 16, orient: "v", into: 1, size: 44 },
    narrow: false,
    building: { x: left, y: top, w: right - left, h: bH },
  };
}

/** Narrow plan: the corridor runs down the page with rooms on both sides. */
function narrowPlan(): Plan {
  const width = 400;
  const left = 8, right = width - 8, corridorW = 54;
  const colW = (right - left - corridorW) / 2;
  const receptionH = 124, roomH = 140, gap = 30;
  const top = 8;
  const corridor = { x: left + colW, y: top + receptionH, w: corridorW, h: 0 };
  const rooms: PlacedRoom[] = [];
  const wings: WingLabel[] = [];
  const column = (teams: TeamId[], x: number, side: "left" | "right") => {
    let y = corridor.y;
    for (const t of teams) {
      y += gap;
      wings.push({ text: wingName(t), x: x + 8, y: y - 9 });
      for (const id of teamAgents(t)) {
        rooms.push({ agentId: id, rect: { x, y, w: colW, h: roomH }, door: { x: side === "left" ? x + colW : x, y: side === "left" ? y + roomH - NARROW_DOOR - 10 : y + 10, orient: "v", into: side === "left" ? 1 : -1, size: NARROW_DOOR } });
        y += roomH;
      }
    }
    return y;
  };
  const endL = column(TOP, left, "left");
  const endR = column(BOTTOM, left + colW + corridorW, "right");
  const bottom = Math.max(endL, endR);
  corridor.h = bottom - corridor.y;
  rooms.unshift({ agentId: "office-manager", rect: { x: left, y: top, w: right - left, h: receptionH }, door: { x: corridor.x + 12, y: top + receptionH, orient: "h", into: 1, size: NARROW_DOOR + 6 } });
  return {
    width,
    height: bottom + 12,
    rooms,
    corridor,
    wings,
    entrance: { x: right - 24 - 40, y: top, orient: "h", into: 1, size: 40 },
    narrow: true,
    building: { x: left, y: top, w: right - left, h: bottom - top },
  };
}

/** "documents read" becomes "document read"; "replies drafted" becomes "reply drafted". */
function singular(label: string) {
  const [first, ...rest] = label.split(" ");
  const one = first!.endsWith("ies") ? `${first!.slice(0, -3)}y` : first!.endsWith("s") ? first!.slice(0, -1) : first!;
  return [one, ...rest].join(" ");
}

const WIDE = widePlan();
const NARROW = narrowPlan();

/** Erase the wall at a door and draw the leaf with its swing, as on an architect's plan. */
function DoorMark({ door, waiting }: { door: Door; waiting?: number }) {
  const { x, y, orient, into, size } = door;
  const h = orient === "h";
  const gap = h ? { x1: x, y1: y, x2: x + size, y2: y } : { x1: x, y1: y, x2: x, y2: y + size };
  const leaf = h ? { x1: x + size, y1: y, x2: x + size, y2: y + into * size } : { x1: x, y1: y + size, x2: x + into * size, y2: y + size };
  const sweep = h ? (into > 0 ? 0 : 1) : into > 0 ? 1 : 0;
  const arc = `M ${x} ${y} A ${size} ${size} 0 0 ${sweep} ${leaf.x2} ${leaf.y2}`;
  return (
    <g className="door">
      <line {...gap} className="door-gap" />
      <line {...leaf} className="door-leaf" />
      <path d={arc} className="door-swing" />
      {waiting ? (
        <g className="door-count" transform={`translate(${h ? x - 14 : x + into * 14}, ${h ? y + into * 14 : y - 14})`}>
          <circle r="11" />
          <text dy="0.35em" textAnchor="middle">
            {waiting}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export type FloorPlanProps = {
  rooms: RoomStatus[];
  arriving?: OfficeView["arriving"];
  /** Link renderer so the app can use its router; defaults to a plain anchor. */
  renderLink?: (agentId: string, className: string, children: ReactNode, label: string) => ReactNode;
  hiringHref?: string;
  /** Force a layout instead of measuring, for stories and screenshots. */
  layout?: "wide" | "narrow";
};

const statusText: Record<RoomStatus["status"], string> = { working: "Working", idle: "Idle", waiting: "Waiting for you", not_hired: "Not hired" };

/**
 * The office drawn as an architect's plan. Each room is a link to that agent's
 * room; the only motion is a document travelling from the entrance to its desk.
 */
export function FloorPlan({ rooms, arriving = [], renderLink, layout }: FloorPlanProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<"wide" | "narrow">("wide");
  useLayoutEffect(() => {
    if (layout || !ref.current) return;
    const ro = new ResizeObserver(([e]) => setMeasured(e!.contentRect.width < 760 ? "narrow" : "wide"));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [layout]);
  const mode = layout ?? measured;
  const plan = mode === "wide" ? WIDE : NARROW;
  const byId = new Map(rooms.map((r) => [r.agentId, r]));
  const pct = (r: Rect) => ({ left: `${(r.x / plan.width) * 100}%`, top: `${(r.y / plan.height) * 100}%`, width: `${(r.w / plan.width) * 100}%`, height: `${(r.h / plan.height) * 100}%` });
  const link =
    renderLink ??
    ((agentId: string, className: string, children: ReactNode, label: string) => (
      <a href={`/rooms/${agentId}`} className={className} aria-label={label}>
        {children}
      </a>
    ));

  return (
    <div ref={ref} className={`floor-plan floor-plan-${mode}`} style={{ aspectRatio: `${plan.width} / ${plan.height}` }}>
      <svg viewBox={`0 0 ${plan.width} ${plan.height}`} aria-hidden="true" className="floor-plan-drawing">
        {plan.rooms.map(({ agentId, rect }) => {
          const s = byId.get(agentId);
          return <rect key={agentId} x={rect.x} y={rect.y} width={rect.w} height={rect.h} className={`room-wall room-${s?.status ?? "not_hired"}`} />;
        })}
        <rect x={plan.building.x} y={plan.building.y} width={plan.building.w} height={plan.building.h} className="building-wall" />
        {plan.rooms.map(({ agentId, door }) => {
          const s = byId.get(agentId);
          return s?.hired ? <DoorMark key={agentId} door={door} waiting={s.waitingCount} /> : null;
        })}
        <DoorMark door={plan.entrance} />
        {plan.wings.map((w) => (
          <text key={w.text} x={w.x} y={w.y} className="wing-label">
            {w.text}
          </text>
        ))}
        {plan.narrow ? null : (
          <text x={plan.corridor.x + plan.corridor.w / 2} y={plan.corridor.y + plan.corridor.h / 2} className="corridor-label" textAnchor="middle" dy="0.35em">
            Corridor
          </text>
        )}
        {arriving.length ? <Arrival plan={plan} key={arriving[0]!.docId} to={arriving[0]!.agentId} /> : null}
      </svg>
      {plan.rooms.map(({ agentId, rect }) => {
        const s = byId.get(agentId);
        const def = AGENT_BY_ID[agentId]!;
        const status = s?.status ?? "not_hired";
        const label = `${def.title}. ${statusText[status]}.${s?.waitingCount ? ` ${s.waitingCount} waiting for you.` : ""}`;
        return (
          <div key={agentId} className="room-slot" style={pct(rect)}>
            {link(
              agentId,
              `room room-${status}`,
              <>
                <span className="room-name">{def.short}</span>
                {status === "not_hired" ? (
                  <span className="room-now">Not hired</span>
                ) : (
                  <>
                    <span className="room-count">
                      <span className="num">{s!.todayCount}</span> {s!.todayCount === 1 ? singular(def.countLabel) : def.countLabel}
                    </span>
                    <span className="room-now">{s!.now}</span>
                  </>
                )}
              </>,
              label,
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A sheet of paper carried from the entrance along the corridor to a room's door. */
function Arrival({ plan, to }: { plan: Plan; to: string }) {
  const ref = useRef<SVGGElement>(null);
  const room = plan.rooms.find((r) => r.agentId === to);
  useEffect(() => {
    const el = ref.current;
    if (!el || !room) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.transform = `translate(${room.door.x + room.door.size / 2}px, ${room.door.y}px)`;
      el.style.opacity = "1";
      return;
    }
    const c = plan.corridor;
    const wide = !plan.narrow;
    const start = wide ? { x: plan.entrance.x + 30, y: c.y + c.h / 2 } : { x: plan.entrance.x + 20, y: plan.entrance.y + 40 };
    const d = room.door.size / 2;
    const turn = wide ? { x: room.door.x + d, y: c.y + c.h / 2 } : { x: c.x + c.w / 2, y: room.door.y + d };
    const end = wide ? { x: room.door.x + d, y: room.door.y } : { x: room.door.x, y: room.door.y + d };
    const mid = wide ? { x: c.x + 10, y: c.y + c.h / 2 } : { x: c.x + c.w / 2, y: c.y + 14 };
    const t = (p: { x: number; y: number }) => `translate(${p.x}px, ${p.y}px)`;
    const anim = el.animate(
      [
        { transform: t(start), opacity: 0 },
        { transform: t(start), opacity: 1, offset: 0.08 },
        { transform: t(mid), offset: 0.25 },
        { transform: t(turn), offset: 0.8 },
        { transform: t(end), opacity: 1, offset: 0.95 },
        { transform: t(end), opacity: 0 },
      ],
      { duration: 4200, easing: "cubic-bezier(0.45, 0, 0.3, 1)", iterations: 1, fill: "forwards", delay: 600 },
    );
    return () => anim.cancel();
  }, [plan, room]);
  if (!room) return null;
  return (
    <g ref={ref} className="arrival" style={{ opacity: 0 }}>
      <path d="M -8 -10 h 11 l 5 5 v 15 h -16 z M 3 -10 v 5 h 5" />
      <line x1="-5" y1="-1" x2="5" y2="-1" />
      <line x1="-5" y1="3" x2="5" y2="3" />
    </g>
  );
}
