import type { OfficeView, RoomStatus } from "@office/contracts";
import { AGENT_BY_ID, AGENTS, TEAMS, type TeamId } from "@office/contracts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Figure } from "./Figure";
import { DEFAULT_SKIN, type Skin } from "./skins";

type Rect = { x: number; y: number; w: number; h: number };
/** `h` doors sit in a horizontal wall; `into` is the direction the leaf swings (+1 down or right). */
type Door = { x: number; y: number; orient: "h" | "v"; into: 1 | -1; size: number };
type PlacedRoom = { agentId: string; rect: Rect; door: Door };
type WingLabel = { text: string; x: number; y: number };
type Plan = { width: number; height: number; rooms: PlacedRoom[]; alcove: Rect | null; corridor: Rect; wings: WingLabel[]; entrance: Door; building: Rect; narrow: boolean };
type Group = { team: TeamId; ids: string[] };

const ORDER: TeamId[] = ["accounts", "sales", "marketing", "social", "operations", "people"];
const DOOR = 34;
const NARROW_DOOR = 24;

const wingName = (t: TeamId) => TEAMS.find((x) => x.id === t)!.wing;

/** The wings that have someone in them, in floor order. `null` keeps every room. */
function groupsFor(keep: Set<string> | null): Group[] {
  return ORDER.map((team) => ({ team, ids: AGENTS.filter((a) => a.team === team && (!keep || keep.has(a.id))).map((a) => a.id) })).filter((g) => g.ids.length);
}

/** Splits the wings into two rows as evenly as possible without breaking a wing; the alcove, if any, goes at the end of the second row. */
function split(groups: Group[], extra: number): [Group[], Group[]] {
  const total = groups.reduce((n, g) => n + g.ids.length, 0) + extra;
  let best = 1, bestDiff = Infinity, acc = 0;
  for (let k = 1; k <= groups.length; k++) {
    acc += groups[k - 1]!.ids.length;
    const diff = Math.abs(acc - (total - acc));
    if (diff < bestDiff) [best, bestDiff] = [k, diff];
  }
  if (!groups.length) return [[], []];
  return [groups.slice(0, best), groups.slice(best)];
}

const rowIds = (gs: Group[]) => gs.flatMap((g) => g.ids);

/** Wide plan: reception at the entrance on the left, one corridor, rooms either side. Narrow offices draw a shorter building. */
function widePlan(groups: Group[], vacant: number): Plan {
  const top = 44, roomH = 176, corridorH = 76;
  const left = 16, receptionW = 168, maxRoomW = 300, fullW = 1200 - 32 - receptionW;
  const [topG, bottomG] = split(groups, vacant ? 1 : 0);
  const topN = rowIds(topG).length;
  const bottomN = rowIds(bottomG).length + (vacant ? 1 : 0);
  const most = Math.max(topN, bottomN, 1);
  const corridorW = Math.min(fullW, most * maxRoomW);
  const width = left + receptionW + corridorW + 16;
  const right = width - 16;
  const corridor = { x: left + receptionW, y: top + roomH, w: corridorW, h: corridorH };
  const rooms: PlacedRoom[] = [];
  const wings: WingLabel[] = [];
  let alcove: Rect | null = null;
  const row = (gs: Group[], y: number, side: "top" | "bottom", withAlcove: boolean) => {
    const n = rowIds(gs).length + (withAlcove ? 1 : 0);
    if (!n) return;
    const w = corridor.w / n;
    let i = 0;
    for (const g of gs) {
      wings.push({ text: wingName(g.team), x: corridor.x + i * w + 10, y: side === "top" ? top - 14 : y + roomH + 26 });
      for (const id of g.ids) {
        const x = corridor.x + i * w;
        rooms.push({ agentId: id, rect: { x, y, w, h: roomH }, door: { x: x + w - DOOR - 16, y: side === "top" ? y + roomH : y, orient: "h", into: side === "top" ? 1 : -1, size: DOOR } });
        i++;
      }
    }
    if (withAlcove) alcove = { x: corridor.x + i * w, y, w, h: roomH };
  };
  row(topG, top, "top", false);
  row(bottomG, top + roomH + corridorH, "bottom", vacant > 0);
  const bH = roomH * 2 + corridorH;
  rooms.unshift({ agentId: "office-manager", rect: { x: left, y: top, w: receptionW, h: bH }, door: { x: left + receptionW, y: corridor.y + 21, orient: "v", into: 1, size: DOOR } });
  wings.unshift({ text: wingName("front"), x: left + 10, y: top - 14 });
  return { width, height: top + bH + 44, rooms, alcove, corridor, wings, entrance: { x: left, y: corridor.y + 16, orient: "v", into: 1, size: 44 }, narrow: false, building: { x: left, y: top, w: right - left, h: bH } };
}

/** Beyond this the narrow plan's rooms grow taller than they are useful. */
const NARROW_MAX = 560;

/** Narrow plan: the corridor runs down the page with rooms on both sides. */
function narrowPlan(groups: Group[], vacant: number): Plan {
  const width = 400;
  const left = 8, right = width - 8, corridorW = 54;
  const colW = (right - left - corridorW) / 2;
  const receptionH = 124, roomH = 140, gap = 30;
  const top = 8;
  const corridor = { x: left + colW, y: top + receptionH, w: corridorW, h: 0 };
  const rooms: PlacedRoom[] = [];
  const wings: WingLabel[] = [];
  let alcove: Rect | null = null;
  const column = (gs: Group[], x: number, side: "left" | "right", withAlcove: boolean) => {
    let y = corridor.y;
    for (const g of gs) {
      y += gap;
      wings.push({ text: wingName(g.team), x: x + 8, y: y - 9 });
      for (const id of g.ids) {
        rooms.push({ agentId: id, rect: { x, y, w: colW, h: roomH }, door: { x: side === "left" ? x + colW : x, y: side === "left" ? y + roomH - NARROW_DOOR - 10 : y + 10, orient: "v", into: side === "left" ? 1 : -1, size: NARROW_DOOR } });
        y += roomH;
      }
    }
    if (withAlcove) {
      y += gap;
      alcove = { x, y, w: colW, h: roomH * 0.7 };
      y += roomH * 0.7;
    }
    return y;
  };
  const [leftG, rightG] = split(groups, vacant ? 1 : 0);
  const endL = column(leftG, left, "left", false);
  const endR = column(rightG, left + colW + corridorW, "right", vacant > 0);
  const bottom = Math.max(endL, endR, corridor.y + gap + roomH);
  corridor.h = bottom - corridor.y;
  rooms.unshift({ agentId: "office-manager", rect: { x: left, y: top, w: right - left, h: receptionH }, door: { x: corridor.x + 12, y: top + receptionH, orient: "h", into: 1, size: NARROW_DOOR + 6 } });
  return { width, height: bottom + 12, rooms, alcove, corridor, wings, entrance: { x: right - 24 - 40, y: top, orient: "h", into: 1, size: 40 }, narrow: true, building: { x: left, y: top, w: right - left, h: bottom - top } };
}

/** "documents read" becomes "document read"; "replies drafted" becomes "reply drafted". */
function singular(label: string) {
  const [first, ...rest] = label.split(" ");
  const one = first!.endsWith("ies") ? `${first!.slice(0, -3)}y` : first!.endsWith("s") ? first!.slice(0, -1) : first!;
  return [one, ...rest].join(" ");
}

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
  /** Where the vacant-rooms alcove leads. */
  hiringHref?: string;
  renderHiringLink?: (className: string, children: ReactNode, label: string) => ReactNode;
  /** Draw every room, hired or not, instead of only the staffed wings. */
  wholeFloor?: boolean;
  /** Force a layout instead of measuring, for stories and screenshots. */
  layout?: "wide" | "narrow";
  /** The skin's floor tile; how strongly it shows is the skin's `--texture-opacity`. */
  texture?: Skin["texture"];
};

const statusText: Record<RoomStatus["status"], string> = { working: "Working", idle: "Idle", waiting: "Waiting for you", not_hired: "Not hired" };

/**
 * The office drawn as an architect's plan. Each room is a link to that agent's
 * room; the only motion is a document travelling from the entrance to its desk.
 * By default only staffed rooms are drawn, and the vacancies share one alcove.
 */
export function FloorPlan({ rooms, arriving = [], renderLink, hiringHref = "/hiring", renderHiringLink, wholeFloor = false, layout, texture = DEFAULT_SKIN.texture }: FloorPlanProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Infinity);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (layout || !box) return;
    const ro = new ResizeObserver(([e]) => setRoom(e!.contentRect.width));
    ro.observe(box);
    return () => ro.disconnect();
  }, [layout]);
  const textureId = `floor-texture-${useId().replace(/:/g, "")}`;
  const hiredKey = rooms
    .filter((r) => r.hired)
    .map((r) => r.agentId)
    .sort()
    .join(",");
  const vacant = wholeFloor ? 0 : AGENTS.filter((a) => a.id !== "office-manager" && !rooms.find((r) => r.agentId === a.id)?.hired).length;
  const plans = useMemo(() => {
    const groups = groupsFor(wholeFloor ? null : new Set(hiredKey.split(",")));
    return { wide: widePlan(groups, vacant), narrow: narrowPlan(groups, vacant) };
  }, [wholeFloor, hiredKey, vacant]);
  const mode = layout ?? (room >= Math.min(760, plans.wide.width) ? "wide" : "narrow");
  const plan = plans[mode];
  const byId = new Map(rooms.map((r) => [r.agentId, r]));
  const pct = (r: Rect) => ({ left: `${(r.x / plan.width) * 100}%`, top: `${(r.y / plan.height) * 100}%`, width: `${(r.w / plan.width) * 100}%`, height: `${(r.h / plan.height) * 100}%` });
  const link =
    renderLink ??
    ((agentId: string, className: string, children: ReactNode, label: string) => (
      <a href={`/rooms/${agentId}`} className={className} aria-label={label}>
        {children}
      </a>
    ));
  const hiringLink =
    renderHiringLink ??
    ((className: string, children: ReactNode, label: string) => (
      <a href={hiringHref} className={className} aria-label={label}>
        {children}
      </a>
    ));

  return (
    <div ref={ref} className={`floor-plan floor-plan-${mode}`} style={{ aspectRatio: `${plan.width} / ${plan.height}`, maxWidth: plan.narrow ? `${NARROW_MAX}px` : `${plan.width}px` }}>
      <svg viewBox={`0 0 ${plan.width} ${plan.height}`} aria-hidden="true" className="floor-plan-drawing">
        <defs>
          <pattern id={textureId} width={texture.size} height={texture.size} patternUnits="userSpaceOnUse">
            <path d={texture.d} className="floor-texture-line" fill="none" />
          </pattern>
        </defs>
        <rect x={plan.building.x} y={plan.building.y} width={plan.building.w} height={plan.building.h} className="building-floor" />
        <rect x={plan.building.x} y={plan.building.y} width={plan.building.w} height={plan.building.h} fill={`url(#${textureId})`} className="floor-texture" />
        {plan.rooms.map(({ agentId, rect }) => {
          const s = byId.get(agentId);
          return (
            <g key={agentId}>
              <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} className={`room-wall room-${s?.status ?? "not_hired"}`} />
              {s?.hired ? <Furniture rect={rect} reception={agentId === "office-manager"} /> : null}
            </g>
          );
        })}
        {plan.alcove ? <rect x={plan.alcove.x} y={plan.alcove.y} width={plan.alcove.w} height={plan.alcove.h} className="room-wall room-not_hired room-alcove" /> : null}
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
        {plan.narrow || plan.corridor.w < 360 ? null : (
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
        const headline = status === "not_hired" ? undefined : s?.headline;
        return (
          <div key={agentId} className={`room-slot${headline ? " room-slot-headline" : ""}`} style={pct(rect)}>
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
            {headline ? (
              <span className="room-headline">
                <span className="room-headline-label">{headline.label}</span>{" "}
                <Figure figureId={headline.figureId} tone={headline.tone} label={`${def.short}: ${headline.label}`}>
                  <span className="num">{headline.value}</span>
                </Figure>
              </span>
            ) : null}
          </div>
        );
      })}
      {plan.alcove ? (
        <div className="room-slot" style={pct(plan.alcove)}>
          {hiringLink(
            "room room-not_hired room-vacant",
            <>
              <span className="room-name">Vacant rooms</span>
              <span className="room-now">
                <span className="num">{vacant}</span> {vacant === 1 ? "room is" : "rooms are"} empty. Hire for them in the hiring hall.
              </span>
            </>,
            `${vacant} vacant ${vacant === 1 ? "room" : "rooms"}: open the hiring hall`,
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A desk and chair, or the reception counter, drawn faintly so the room still reads as a plan. Each skin restyles them. */
function Furniture({ rect, reception }: { rect: Rect; reception: boolean }) {
  if (reception) {
    const w = Math.min(rect.w - 40, 110);
    const x = rect.x + (rect.w - w) / 2;
    const y = rect.y + rect.h - 92;
    return (
      <g className="furniture" aria-hidden="true">
        <path d={`M ${x} ${y} h ${w} v 26 h -${w - 26} v 34 h -26 z`} className="furniture-desk" />
        <circle cx={x + w / 2} cy={y - 14} r={8} className="furniture-chair" />
      </g>
    );
  }
  const w = 34, h = 13;
  const x = rect.x + rect.w - w - 12;
  const y = rect.y + rect.h - h - 12;
  return (
    <g className="furniture" aria-hidden="true">
      <rect x={x} y={y} width={w} height={h} rx={2} className="furniture-desk" />
      <circle cx={x + w / 2} cy={y - 8} r={5} className="furniture-chair" />
      <rect x={x + 5} y={y + 3} width={10} height={7} rx={1} className="furniture-item" />
    </g>
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