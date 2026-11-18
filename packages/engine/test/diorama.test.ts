import { AGENTS, type OfficeView, type RoomStatus } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { OfficeService } from "../src/office";
import { planFor } from "../../ui/src/plan";
import { corridorSpot, exitPath, layoutFrom, outsideDoor, route, walkable, type V2 } from "../../ui/src/living/diorama/navigate";
import { daylight, istParts, moonPhase, skyColours, STATE_CAPITALS, sunAt, sundialMarks, sunTimes, whereIs, INDIA } from "../../ui/src/living/diorama/sky";
import { startTrail, trail } from "../../ui/src/living/diorama/trail";

const PUNE: [number, number] = [18.52, 73.86];
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe("the sky over the Lived-in office", () => {
  it("puts the sun about 71.5° up over Pune at noon on the March equinox", () => {
    let best = -90;
    for (let m = 11 * 60; m <= 13.5 * 60; m += 2) best = Math.max(best, sunAt(new Date(Date.parse("2026-03-20T00:00:00+05:30") + m * 60_000), ...PUNE).el);
    expect(best).toBeGreaterThan(70.8);
    expect(best).toBeLessThan(72.2);
  });

  it("has the sun below the horizon at midnight, east in the morning and west in the evening", () => {
    expect(sunAt(ist("2026-11-18T00:00:00"), ...PUNE).el).toBeLessThan(-6);
    const morning = sunAt(ist("2026-11-18T08:00:00"), ...PUNE), evening = sunAt(ist("2026-11-18T16:30:00"), ...PUNE);
    expect(morning.az).toBeGreaterThan(90);
    expect(morning.az).toBeLessThan(180);
    expect(evening.az).toBeGreaterThan(180);
    expect(evening.az).toBeLessThan(270);
  });

  it("sets the sun over Pune at about 5:55 pm on 18 November, as the almanac does", () => {
    const { day } = istParts(Date.parse("2026-11-18T06:00:00Z"));
    const { rise, set } = sunTimes(day, ...PUNE);
    expect(set + 330).toBeGreaterThan(17 * 60 + 52);
    expect(set + 330).toBeLessThan(17 * 60 + 59);
    expect(rise + 330).toBeGreaterThan(6 * 60 + 38);
    expect(rise + 330).toBeLessThan(6 * 60 + 46);
  });

  it("knows a full moon from a new one", () => {
    expect(Math.abs(moonPhase(ist("2026-11-24T20:00:00")) - 0.5)).toBeLessThan(0.05);
    const nm = moonPhase(ist("2026-11-09T12:00:00"));
    expect(Math.min(nm, 1 - nm)).toBeLessThan(0.05);
  });

  it("paints a dark sky at night and a light one at noon, and lights the lamps only after dusk", () => {
    const night = skyColours(-20).top.reduce((a, b) => a + b, 0), noon = skyColours(50).top.reduce((a, b) => a + b, 0);
    expect(night).toBeLessThan(noon / 3);
    expect(daylight(-20)).toBe(0);
    expect(daylight(30)).toBe(1);
  });

  it("finds the business's city from the weather, else its state's capital, else the middle of India", () => {
    expect(whereIs({ lat: 18.5, lon: 73.9 }, "27")).toEqual([18.5, 73.9]);
    expect(whereIs(null, "27")).toEqual(STATE_CAPITALS["27"]);
    expect(whereIs(null, "")).toEqual(INDIA);
    expect(Object.keys(STATE_CAPITALS)).toHaveLength(38);
  });

  it("prints the sundial's hours round the lamp post, morning on one side and afternoon on the other", () => {
    const marks = sundialMarks(istParts(Date.parse("2026-11-18T06:00:00Z")).day, ...PUNE);
    expect(marks.length).toBeGreaterThanOrEqual(9);
    const nine = marks.find((m) => m.hour === 9)!, three = marks.find((m) => m.hour === 15)!;
    expect(Math.sign(nine.dx)).not.toBe(Math.sign(three.dx));
  });
});

describe("walking about the floor", () => {
  const rooms: RoomStatus[] = AGENTS.map((a) => ({ agentId: a.id, hired: true, trustLevel: "trainee", status: "idle", now: "", todayCount: 0, waitingCount: 0 }));
  const L = layoutFrom(planFor(rooms, { wholeFloor: true, layout: "wide" }));

  it("lays out reception and every room of the whole floor", () => {
    expect(L.rooms["office-manager"]?.row).toBe("front");
    expect(L.order.length).toBe(15);
    expect(Object.values(L.rooms).filter((r) => r.row === "top").length).toBe(7);
  });

  it("never walks anyone through a wall: every route stays in rooms, doorways and the corridor", () => {
    const places: V2[][] = [...L.order.map((id) => exitPath(L, id)), ...L.order.map((id) => outsideDoor(L, id)), corridorSpot(L, L.deskStand), ...L.teaSpots.map((p) => corridorSpot(L, p))];
    let checked = 0;
    for (const a of places) {
      for (const b of places) {
        const pts = route(a, b);
        for (let i = 1; i < pts.length; i++) {
          const [x0, z0] = pts[i - 1]!, [x1, z1] = pts[i]!;
          const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
          for (let k = 0; k <= n; k++) {
            const p: V2 = [x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n];
            if (!walkable(L, p)) throw new Error(`a route from ${JSON.stringify(a[0])} to ${JSON.stringify(b[0])} crosses a wall at ${p.map((v) => v.toFixed(2))}`);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("keeps the owner's desk and the tea point inside the corridor", () => {
    expect(walkable(L, L.deskStand)).toBe(true);
    for (const p of L.teaSpots) expect(walkable(L, p)).toBe(true);
  });
});

describe("the paper trail", () => {
  const base = (over: Partial<Pick<OfficeView, "rooms" | "arriving" | "decided">> = {}): Pick<OfficeView, "rooms" | "arriving" | "decided"> => ({
    rooms: [
      { agentId: "office-manager", hired: true, trustLevel: "trainee", status: "idle", now: "", todayCount: 0, waitingCount: 0 },
      { agentId: "accountant", hired: true, trustLevel: "trainee", status: "idle", now: "", todayCount: 0, waitingCount: 2 },
      { agentId: "auditor", hired: false, trustLevel: "trainee", status: "not_hired", now: "", todayCount: 0, waitingCount: 0 },
    ],
    arriving: [],
    decided: [],
    ...over,
  });

  it("acts nothing out on the first look, and never replays what it has shown", () => {
    const first = trail(startTrail(), base({ arriving: [{ docId: "d1", agentId: "accountant", label: "Email from X", channel: "email" }] }));
    expect(first.events).toEqual([]);
    expect(trail(first.state, base({ arriving: [{ docId: "d1", agentId: "accountant", label: "Email from X", channel: "email" }] })).events).toEqual([]);
  });

  it("sends a new email in as an arrival, and new work to the owner's desk", () => {
    const s = trail(startTrail(), base()).state;
    const more = base({ arriving: [{ docId: "d2", agentId: "accountant", label: "Email from Box N Freight", channel: "email" }] });
    more.rooms[1] = { ...more.rooms[1]!, waitingCount: 3 };
    const { events } = trail(s, more);
    expect(events).toContainEqual({ kind: "arrive", docId: "d2", agentId: "accountant", channel: "email", label: "Email from Box N Freight" });
    expect(events).toContainEqual({ kind: "toDesk", agentId: "accountant", count: 1 });
  });

  it("stamps each decision once, oldest first", () => {
    const s = trail(startTrail(), base()).state;
    const decided = [
      { id: "c2", agentId: "accountant", status: "rejected" as const, at: "2026-11-18T10:05:00.000Z" },
      { id: "c1", agentId: "accountant", status: "approved" as const, at: "2026-11-18T10:00:00.000Z" },
    ];
    const r = trail(s, base({ decided }));
    expect(r.events.map((e) => (e.kind === "decide" ? e.id : e.kind))).toEqual(["c1", "c2"]);
    expect(trail(r.state, base({ decided })).events).toEqual([]);
  });

  it("raises a room exactly once when someone is hired, and folds it when they leave", () => {
    const s = trail(startTrail(), base()).state;
    const hired = base();
    hired.rooms[2] = { ...hired.rooms[2]!, hired: true, status: "idle" };
    const r = trail(s, hired);
    expect(r.events.filter((e) => e.kind === "hire")).toEqual([{ kind: "hire", agentId: "auditor" }]);
    expect(trail(r.state, hired).events).toEqual([]);
    expect(trail(r.state, base()).events).toContainEqual({ kind: "leave", agentId: "auditor" });
  });
});

describe("what the office tells the Lived-in floor", () => {
  it("says how each document arrived and what the desk decided today", () => {
    const office = new OfficeService(loadBooks());
    const item = office.desk().items[0]!;
    office.decide(item.id, { action: "approve" }, "Anil");
    const v = office.officeView();
    expect(v.decided?.[0]).toMatchObject({ id: item.id, agentId: item.agentId, status: "approved" });
    for (const a of v.arriving) if (a.agentId === "accountant") expect(["email", "upload", "whatsapp", "import", "generated"]).toContain(a.channel);
    expect(v.business.stateCode).toMatch(/^(\d{2})?$/);
  });
});
