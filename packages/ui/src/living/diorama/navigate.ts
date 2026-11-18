import type { Plan } from "../../plan";

/**
 * The 3D floor's layout, in world units (a tenth of a plan unit), centred on the building.
 * It stands on the same lines as the 2D plan, adds the yard around it, and knows how a
 * person gets from one place to another: out of their room by its door, along the middle
 * of the corridor, and in by the other door. Pure, so the tests can walk every route.
 */

export type V2 = [x: number, z: number];
export type Box = { x0: number; x1: number; z0: number; z1: number };
export type RoomGeo = Box & {
  id: string;
  row: "top" | "bottom" | "front";
  cx: number;
  cz: number;
  /** Where the person sits. */
  home: V2;
  /** The door: its centre along the wall and which side the room is on. */
  door: { x: number; z: number; orient: "h" | "v"; half: number; inDir: 1 | -1 };
};
export type Layout = {
  building: Box;
  corridor: Box;
  /** The corridor's middle line, where people walk. */
  lane: number;
  rooms: Record<string, RoomGeo>;
  /** Room ids in plan order, reception first. */
  order: string[];
  /** When only staffed rooms are drawn, the vacancies share one corner, printed flat on the page. */
  alcove: (Box & { cx: number; cz: number }) | null;
  entrance: { x: number; z: number; half: number };
  page: Box;
  yard: Box;
  gate: { x: number; z: number; half: number };
  road: { z0: number; z1: number };
  sundial: V2;
  tree: V2;
  tulsi: V2;
  cart: V2;
  scooter: V2;
  /** The owner's desk at the far end of the corridor, where the pile grows. */
  desk: V2;
  /** Where someone stands to put a sheet on the pile. */
  deskStand: V2;
  tea: V2;
  teaSpots: [V2, V2];
  wings: { text: string; x: number; z: number }[];
};

export const SCALE = 0.1;

export function layoutFrom(plan: Plan): Layout {
  const b = plan.building;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const X = (p: number) => (p - cx) * SCALE;
  const Z = (p: number) => (p - cy) * SCALE;
  const building = { x0: X(b.x), x1: X(b.x + b.w), z0: Z(b.y), z1: Z(b.y + b.h) };
  const c = plan.corridor;
  const corridor = { x0: X(c.x), x1: X(c.x + c.w), z0: Z(c.y), z1: Z(c.y + c.h) };
  const lane = (corridor.z0 + corridor.z1) / 2;
  const rooms: Record<string, RoomGeo> = {};
  const order: string[] = [];
  for (const r of plan.rooms) {
    const box = { x0: X(r.rect.x), x1: X(r.rect.x + r.rect.w), z0: Z(r.rect.y), z1: Z(r.rect.y + r.rect.h) };
    const rcx = (box.x0 + box.x1) / 2, rcz = (box.z0 + box.z1) / 2;
    const d = r.door;
    const half = (d.size * SCALE) / 2;
    if (r.agentId === "office-manager") {
      // Reception runs the height of the building; its door opens on the corridor's end.
      const door = { x: X(d.x), z: Z(d.y) + half, orient: "v" as const, half, inDir: -1 as const };
      rooms[r.agentId] = { id: r.agentId, row: "front", ...box, cx: rcx, cz: rcz, home: [rcx, lane - 9.6], door };
    } else {
      const top = r.rect.y + r.rect.h <= c.y + 0.5;
      const door = { x: X(d.x) + half, z: Z(d.y), orient: "h" as const, half, inDir: (top ? -1 : 1) as 1 | -1 };
      rooms[r.agentId] = { id: r.agentId, row: top ? "top" : "bottom", ...box, cx: rcx, cz: rcz, home: [rcx - 1.2, rcz - 1.2], door };
    }
    order.push(r.agentId);
  }
  const a = plan.alcove;
  const alcove = a ? { x0: X(a.x), x1: X(a.x + a.w), z0: Z(a.y), z1: Z(a.y + a.h), cx: X(a.x + a.w / 2), cz: Z(a.y + a.h / 2) } : null;
  const e = plan.entrance;
  const entrance = { x: X(e.x), z: Z(e.y) + (e.size * SCALE) / 2, half: (e.size * SCALE) / 2 };
  const page = { x0: building.x0 - 12.6, x1: building.x1 + 12.6, z0: building.z0 - 10.6, z1: building.z1 + 26.6 };
  const yard = { x0: building.x0 - 7.6, x1: building.x1 + 7.6, z0: building.z0 - 6.6, z1: building.z1 + 14.6 };
  const gate = { x: building.x0 + 11.4, z: yard.z1, half: 5.5 };
  const tea: V2 = [corridor.x0 + 5.1, corridor.z0 + 0.8];
  const desk: V2 = [building.x1 - 3.8, lane];
  const wings = plan.wings.map((w) => {
    const top = w.y < c.y;
    return { text: w.text, x: X(w.x), z: top ? building.z0 - 1.6 : building.z1 + 2.6 };
  });
  return {
    building, corridor, lane, rooms, order, alcove, entrance, page, yard, gate,
    road: { z0: building.z1 + 17.2, z1: building.z1 + 25.2 },
    sundial: [(building.x0 + building.x1) / 2 + 6, building.z1 + 8.6],
    tree: [building.x1 - 2.4, building.z1 + 7.6],
    tulsi: [building.x0 - 3.1, entrance.z + 4.6],
    cart: [gate.x + 17, building.z1 + 19.1],
    scooter: [gate.x + 11, building.z1 + 10.6],
    desk, deskStand: [desk[0] - 2.2, lane + 0.6],
    tea, teaSpots: [[tea[0] - 1.6, lane - 0.8], [tea[0] + 1.6, lane - 0.8]],
    wings,
  };
}

/** From a person's chair to the middle of the corridor, through their own door. */
export function exitPath(L: Layout, id: string): V2[] {
  const r = L.rooms[id];
  if (!r) return [];
  if (r.row === "front") {
    const x = r.door.x - 2.4;
    return [r.home, [x, r.home[1]], [x, r.door.z], [r.door.x, r.door.z], [r.door.x + 2, L.lane]];
  }
  const { x, z, inDir } = r.door;
  return [r.home, [x, r.home[1]], [x, z + inDir * 1.8], [x, z], [x, L.lane]];
}
/** Just inside a room's door, out to the corridor: where a visitor stands to hand something over. */
export const doorPath = (L: Layout, id: string): V2[] => exitPath(L, id).slice(2);
/** Outside a room's door in the corridor, where the director sends someone to talk to a colleague. */
export function outsideDoor(L: Layout, id: string): V2[] {
  const r = L.rooms[id];
  if (!r) return [];
  if (r.row === "front") return [[r.door.x + 1.6, L.lane]];
  return [[r.door.x, r.door.z - r.door.inDir * 1.4], [r.door.x, L.lane]];
}
/** A place in the corridor, and the step back onto its middle line. */
export const corridorSpot = (L: Layout, p: V2): V2[] => [p, [p[0], L.lane]];

/** A walk from one place to another: each place is given as its way out to the corridor. */
export function route(from: V2[], to: V2[]): V2[] {
  const pts = [...from, ...to.slice().reverse()];
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) > 1e-3);
}

/** True if a point is somewhere a person may stand: in the corridor, in a room, or at a door. */
export function walkable(L: Layout, [x, z]: V2, margin = 0.3): boolean {
  const inside = (b: Box) => x >= b.x0 + margin && x <= b.x1 - margin && z >= b.z0 + margin && z <= b.z1 - margin;
  const c = L.corridor;
  if (x >= c.x0 && x <= c.x1 - margin && z >= c.z0 + margin && z <= c.z1 - margin) return true;
  for (const r of Object.values(L.rooms)) {
    if (inside(r)) return true;
    const d = r.door;
    if (d.orient === "h" && Math.abs(x - d.x) <= d.half && Math.abs(z - d.z) <= margin + 0.01) return true;
    if (d.orient === "v" && Math.abs(z - d.z) <= d.half && Math.abs(x - d.x) <= margin + 0.01) return true;
  }
  return false;
}
