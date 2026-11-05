import type { LogEntry, RoomStatus } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { anniversary, direct, type DirectorInputs, type Scene, lastWorkingDay, seeded, spoken, startState, TIMING } from "../../ui/src/living/director";
import { personaFor, personaLabel, PERSONAS } from "../../ui/src/living/personas";
import { fill, PHRASES } from "../../ui/src/living/phrases";

/** Thursday 5 November 2026, 10:30 in India. */
const T0 = Date.parse("2026-11-05T05:00:00Z");
const room = (agentId: string, status: RoomStatus["status"] = "idle", waitingCount = 0): RoomStatus => ({ agentId, hired: status !== "not_hired", trustLevel: "trainee", status, now: "", todayCount: 0, waitingCount });
const entry = (id: string, agentId: string, text: string, at = T0): LogEntry => ({ id, at: new Date(at).toISOString(), agentId, text, ref: null });
const quiet = (over: Partial<DirectorInputs> = {}): DirectorInputs => ({
  rooms: [room("office-manager"), room("accountant"), room("credit-controller"), room("storekeeper")],
  log: [],
  arriving: [],
  ambient: { today: "2026-11-05", names: {}, festivals: [], hiredOn: {} },
  weather: null,
  ...over,
});

/** Runs the floor for a while, one tick a second, and collects every scene. */
function run(inputs: DirectorInputs | ((t: number) => DirectorInputs), seconds: number, seed = 7, from = T0) {
  const rng = seeded(seed);
  let state = startState();
  const scenes: Scene[] = [];
  for (let i = 0; i <= seconds; i++) {
    const t = from + i * 1000;
    const r = direct(state, typeof inputs === "function" ? inputs(t) : inputs, t, rng);
    state = r.state;
    scenes.push(...r.scenes);
  }
  return scenes;
}
const says = (scenes: Scene[], source?: string) => scenes.filter((s): s is Extract<Scene, { kind: "say" }> => s.kind === "say" && (!source || s.source === source));

describe("the Lived-in floor", () => {
  it("replays the same day the same way from the same seed", () => {
    expect(run(quiet(), 400, 3)).toEqual(run(quiet(), 400, 3));
    expect(says(run(quiet(), 400, 3), "ambient").length).toBeGreaterThan(0);
  });

  it("says a new team-log line in the agent's own words, and takes work to the agent it names", () => {
    const first = direct(startState(), quiet(), T0, seeded(1));
    const line = "Drafted 2 purchase orders for items at their reorder level; the Accountant will record them when they arrive.";
    const next = direct(first.state, quiet({ log: [entry("l1", "storekeeper", line)] }), T0 + 1000, seeded(1));
    const said = says(next.scenes)[0]!;
    expect(said).toMatchObject({ agentId: "storekeeper", source: "log" });
    expect(line.startsWith(said.text.replace(/…$/, ""))).toBe(true);
    expect(next.scenes.find((s) => s.kind === "walk")).toMatchObject({ agentId: "storekeeper", to: { kind: "door", agentId: "accountant" } });
  });

  it("does not replay old history when the floor opens, only a line from the last minute or so", () => {
    const old = entry("old", "accountant", "Read 4 bills.", T0 - 10 * 60_000);
    const recent = entry("new", "credit-controller", "Sent a reminder.", T0 - 20_000);
    const r = direct(startState(), quiet({ log: [old, recent] }), T0, seeded(1));
    expect(says(r.scenes).map((s) => s.text)).toEqual(["Sent a reminder."]);
  });

  it("keeps quiet while anyone is working or work was just logged", () => {
    expect(says(run(quiet({ rooms: [room("office-manager"), room("accountant", "working"), room("credit-controller"), room("storekeeper")] }), 600), "ambient")).toEqual([]);
    const busy = (t: number) => quiet({ log: Array.from({ length: Math.floor((t - T0) / 30_000) + 1 }, (_, i) => entry(`e${i}`, "accountant", `Read bill ${i}.`)) });
    expect(says(run(busy, 600), "ambient")).toEqual([]);
  });

  it("needs two people free for a chat, and never more than one every minute", () => {
    expect(says(run(quiet({ rooms: [room("office-manager"), room("accountant", "waiting", 3)] }), 600), "ambient")).toEqual([]);
    const starts = run(quiet(), 1800).filter((s) => s.kind === "walk" && s.to.kind === "coffee" && s.to.slot === 0).map((s) => s.at);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(TIMING.gapMin);
  });

  it("wishes a persona happy birthday only on their birthday", () => {
    const birthday = (today: string) => quiet({ ambient: { today, names: {}, festivals: [], hiredOn: {} }, rooms: [room("office-manager"), room("accountant"), room("credit-controller")] });
    const meera = PERSONAS.accountant!.birthday;
    const on = says(run(birthday(`2026-${meera}`), 200), "ambient").map((s) => s.text).join(" ");
    expect(on).toMatch(/birthday|many happy returns/i);
    expect(on).toContain("Meera");
    const off = says(run(birthday("2026-11-05"), 200), "ambient").map((s) => s.text).join(" ");
    expect(off).not.toMatch(/birthday|many happy returns/i);
  });

  it("talks about a festival that is coming, and a work anniversary, in words", () => {
    const festive = quiet({ ambient: { today: "2026-11-05", names: {}, festivals: [{ date: "2026-11-08", name: "Diwali", relevance: "" }], hiredOn: { accountant: "2026-08-05" } } });
    const text = says(run(festive, 400), "ambient").map((s) => s.text).join(" ");
    expect(text).toContain("Diwali");
    expect(text).toMatch(/three months/);
    expect(anniversary("2025-11-05", "2026-11-05")).toBe("a year");
    expect(anniversary("2026-10-04", "2026-11-05")).toBeNull();
  });

  it("only mentions the weather when it knows it, and says the city", () => {
    const none = says(run(quiet(), 2400), "ambient").map((s) => s.text).join(" ");
    expect(none).not.toMatch(/rain|umbrella|thunder|fog/i);
    const wet = quiet({ weather: { city: "Pune", tempC: 24, sky: "rain", at: new Date(T0).toISOString() } });
    expect(says(run(wet, 400), "ambient").map((s) => s.text).join(" ")).toMatch(/Pune|rain/i);
  });

  it("with reduced motion nobody walks and there is no small talk, but real work is still said", () => {
    const still = (t: number) => quiet({ reducedMotion: true, log: t > T0 + 5000 ? [entry("x", "storekeeper", "Drafted a purchase order for the Accountant.")] : [] });
    const scenes = run(still, 900);
    expect(scenes.filter((s) => s.kind === "walk")).toEqual([]);
    expect(says(scenes, "ambient")).toEqual([]);
    expect(says(scenes, "log").length).toBe(1);
  });

  it("knows the last working day of the month", () => {
    expect(lastWorkingDay("2026-10-30")).toBe(true);
    expect(lastWorkingDay("2026-10-29")).toBe(false);
    expect(lastWorkingDay("2026-10-31")).toBe(false);
    expect(spoken("a ".repeat(80)).endsWith("…")).toBe(true);
  });

  it("uses the owner's name for a persona, and its role beside it", () => {
    expect(personaLabel("accountant")).toBe("Meera, Accountant");
    expect(personaFor("accountant", { accountant: "Revathi" }).name).toBe("Revathi");
    expect(personaLabel("accountant", { accountant: "Revathi" })).toBe("Revathi, Accountant");
  });
});

describe("the small-talk phrase bank", () => {
  const all = Object.values(PHRASES).flat().flat();
  const parties = loadBooks().parties.map((p) => p.name.split(" ")[0]!).filter((w) => w.length > 3);

  it("has no amounts, digits or currency, and no customer or supplier names", () => {
    for (const line of all) {
      expect(line, line).not.toMatch(/\d|₹|\brs\b|rupee|lakh|crore|invoice|bill|payment|customer|supplier|order/i);
      for (const p of parties) expect(line.includes(p), `${line} names ${p}`).toBe(false);
    }
  });

  it("only uses the placeholders the director fills", () => {
    for (const line of all) for (const [, k] of line.matchAll(/\{(\w+)\}/g)) expect(["a", "b", "drink", "city", "festival", "day", "span", "feel"]).toContain(k);
    expect(fill("Raining in {city}, {b}.", { b: "Meera", city: "Pune" })).toBe("Raining in Pune, Meera.");
    expect(fill("{span} with us today, {b}.", { span: "a month", b: "Meera" })).toBe("A month with us today, Meera.");
  });
});
