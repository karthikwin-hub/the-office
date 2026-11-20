import { AGENTS, TEAMS, type RoomStatus, type TeamId } from "@office/contracts";

/**
 * The floor's geometry in plan units: where every room, door, corridor and wing label goes.
 * Pure, so the 2D plan, the Lived-in office's 3D floor and the tests all stand on the same lines.
 */

export type Rect = { x: number; y: number; w: number; h: number };
/** `h` doors sit in a horizontal wall; `into` is the direction the leaf swings (+1 down or right). */
export type Door = { x: number; y: number; orient: "h" | "v"; into: 1 | -1; size: number };
export type PlacedRoom = { agentId: string; rect: Rect; door: Door };
export type WingLabel = { text: string; x: number; y: number };
/** The drawn floor in plan units, for anything layered on top of it. */
export type Plan = {
  width: number;
  height: number;
  rooms: PlacedRoom[];
  alcove: Rect | null;
  corridor: Rect;
  wings: WingLabel[];
  entrance: Door;
  building: Rect;
  narrow: boolean;
};
type Group = { team: TeamId; ids: string[] };

/** Front office first: the Office Manager has the reception; the other front-office agents sit in the rooms beside it. */
const ORDER: TeamId[] = ["front", "accounts", "sales", "marketing", "social", "operations", "people"];
const DOOR = 34;
const NARROW_DOOR = 24;

const wingName = (t: TeamId) => TEAMS.find((x) => x.id === t)!.wing;
/** The rooms beside reception are labelled by team, so the reception's own label is not repeated. */
const groupName = (t: TeamId) => (t === "front" ? TEAMS.find((x) => x.id === t)!.name : wingName(t));

/** The wings that have someone in them, in floor order. `null` keeps every room. */
export function groupsFor(keep: Set<string> | null): Group[] {
  return ORDER.map((team) => ({
    team,
    ids: AGENTS.filter((a) => a.team === team && a.id !== "office-manager" && (!keep || keep.has(a.id))).map((a) => a.id),
  })).filter((g) => g.ids.length);
}

/** Splits the wings into two rows as evenly as possible without breaking a wing; the alcove, if any, goes at the end of the second row. */
function split(groups: Group[], extra: number): [Group[], Group[]] {
  const total = groups.reduce((n, g) => n + g.ids.length, 0) + extra;
  let best = 1,
    bestDiff = Infinity,
    acc = 0;
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
export function widePlan(groups: Group[], vacant: number): Plan {
  const top = 44,
    roomH = 176,
    corridorH = 76;
  const left = 16,
    receptionW = 168,
    maxRoomW = 300,
    fullW = 1200 - 32 - receptionW;
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
      wings.push({ text: groupName(g.team), x: corridor.x + i * w + 10, y: side === "top" ? top - 14 : y + roomH + 26 });
      for (const id of g.ids) {
        const x = corridor.x + i * w;
        rooms.push({
          agentId: id,
          rect: { x, y, w, h: roomH },
          door: { x: x + w - DOOR - 16, y: side === "top" ? y + roomH : y, orient: "h", into: side === "top" ? 1 : -1, size: DOOR },
        });
        i++;
      }
    }
    if (withAlcove) alcove = { x: corridor.x + i * w, y, w, h: roomH };
  };
  row(topG, top, "top", false);
  row(bottomG, top + roomH + corridorH, "bottom", vacant > 0);
  const bH = roomH * 2 + corridorH;
  rooms.unshift({
    agentId: "office-manager",
    rect: { x: left, y: top, w: receptionW, h: bH },
    door: { x: left + receptionW, y: corridor.y + 21, orient: "v", into: 1, size: DOOR },
  });
  wings.unshift({ text: wingName("front"), x: left + 10, y: top - 14 });
  return {
    width,
    height: top + bH + 44,
    rooms,
    alcove,
    corridor,
    wings,
    entrance: { x: left, y: corridor.y + 16, orient: "v", into: 1, size: 44 },
    narrow: false,
    building: { x: left, y: top, w: right - left, h: bH },
  };
}

/** Beyond this the narrow plan's rooms grow taller than they are useful. */
export const NARROW_MAX = 560;

/** Narrow plan: the corridor runs down the page with rooms on both sides. */
export function narrowPlan(groups: Group[], vacant: number): Plan {
  const width = 400;
  const left = 8,
    right = width - 8,
    corridorW = 54;
  const colW = (right - left - corridorW) / 2;
  const receptionH = 124,
    roomH = 140,
    gap = 30;
  const top = 8;
  const corridor = { x: left + colW, y: top + receptionH, w: corridorW, h: 0 };
  const rooms: PlacedRoom[] = [];
  const wings: WingLabel[] = [];
  let alcove: Rect | null = null;
  const column = (gs: Group[], x: number, side: "left" | "right", withAlcove: boolean) => {
    let y = corridor.y;
    for (const g of gs) {
      y += gap;
      wings.push({ text: groupName(g.team), x: x + 8, y: y - 9 });
      for (const id of g.ids) {
        rooms.push({
          agentId: id,
          rect: { x, y, w: colW, h: roomH },
          door: {
            x: side === "left" ? x + colW : x,
            y: side === "left" ? y + roomH - NARROW_DOOR - 10 : y + 10,
            orient: "v",
            into: side === "left" ? 1 : -1,
            size: NARROW_DOOR,
          },
        });
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
  rooms.unshift({
    agentId: "office-manager",
    rect: { x: left, y: top, w: right - left, h: receptionH },
    door: { x: corridor.x + 12, y: top + receptionH, orient: "h", into: 1, size: NARROW_DOOR + 6 },
  });
  return {
    width,
    height: bottom + 12,
    rooms,
    alcove,
    corridor,
    wings,
    entrance: { x: right - 24 - 40, y: top, orient: "h", into: 1, size: 40 },
    narrow: true,
    building: { x: left, y: top, w: right - left, h: bottom - top },
  };
}

/** The floor as the 2D plan draws it, whole or only the staffed wings; the Lived-in office stands its walls on the same lines. */
export function planFor(rooms: RoomStatus[], { wholeFloor, layout }: { wholeFloor: boolean; layout: "wide" | "narrow" }): Plan {
  const hired = new Set(rooms.filter((r) => r.hired).map((r) => r.agentId));
  const vacant = wholeFloor ? 0 : AGENTS.filter((a) => a.id !== "office-manager" && !hired.has(a.id)).length;
  const groups = groupsFor(wholeFloor ? null : hired);
  return layout === "wide" ? widePlan(groups, vacant) : narrowPlan(groups, vacant);
}
