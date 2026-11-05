import { AGENT_BY_ID, type AmbientView, type LogEntry, type OfficeView, type PersonaNames, type RoomStatus, type Weather } from "@office/contracts";
import { personaFor } from "./personas";
import { type Exchange, fill, PHRASES, type Topic } from "./phrases";

/**
 * Decides what the team does on the Lived-in floor. Pure: the same inputs, time
 * and random numbers give the same scenes. It only reads what the Floor already
 * shows, so it cannot change, add to or contradict any agent's work.
 */

export type Spot = { kind: "home" } | { kind: "door"; agentId: string } | { kind: "coffee"; slot: 0 | 1 };
export type Scene =
  | { id: number; kind: "say"; agentId: string; text: string; source: "log" | "arrival" | "ambient"; at: number; until: number }
  | { id: number; kind: "walk"; agentId: string; to: Spot; at: number };

export type DirectorInputs = {
  rooms: RoomStatus[];
  log: LogEntry[];
  arriving: OfficeView["arriving"];
  names?: PersonaNames;
  ambient?: AmbientView | null;
  weather?: Weather | null;
  reducedMotion?: boolean;
};

export type DirectorState = {
  started: boolean;
  seen: string[];
  arrived: string[];
  lastLogAt: number;
  lastAmbientAt: number;
  gap: number;
  used: string[];
  usedOn: string;
  nextId: number;
};

export const TIMING = {
  say: 6000,
  /** How long a walk to the kettle is given before anyone speaks. */
  walk: 5500,
  reply: 5000,
  /** No small talk within this long of real work appearing in the log. */
  quietAfterLog: 60_000,
  gapMin: 60_000,
  gapMax: 120_000,
  /** A log line this recent is still worth saying when the floor first opens. */
  fresh: 90_000,
} as const;

export const startState = (): DirectorState => ({ started: false, seen: [], arrived: [], lastLogAt: 0, lastAmbientAt: 0, gap: 0, used: [], usedOn: "", nextId: 1 });

/** A small seeded generator, so a test can replay a day on the floor. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A log line as said aloud: the same words, shortened at a word with an ellipsis. */
export function spoken(text: string, max = 96): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, "")}…`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WORDS = ["", "a month", "two months", "three months", "four months", "five months", "six months", "seven months", "eight months", "nine months", "ten months", "eleven months", "a year"];

/** The office's clock: India time. */
export function officeClock(now: number): { date: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** True on the last Monday-to-Friday day of the month. */
export function lastWorkingDay(iso: string): boolean {
  const wd = dayOf(iso);
  if (wd === 0 || wd === 6) return false;
  for (let d = addDays(iso, 1); d.slice(0, 7) === iso.slice(0, 7); d = addDays(d, 1)) if (dayOf(d) !== 0 && dayOf(d) !== 6) return false;
  return true;
}

/** "a month", "two months", "a year", "two years"; null if today is not a monthly anniversary. */
export function anniversary(hiredOn: string, today: string): string | null {
  if (hiredOn >= today || hiredOn.slice(8) !== today.slice(8)) return null;
  const months = (Number(today.slice(0, 4)) - Number(hiredOn.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(hiredOn.slice(5, 7));
  if (months < 1) return null;
  if (months <= 12) return WORDS[months]!;
  if (months % 12) return null;
  const years = months / 12;
  return years === 1 ? "a year" : `${["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][years] ?? "many"} years`;
}

function weatherTopic(w: Weather): { topic: Topic; feel?: string } {
  if (w.sky === "storm") return { topic: "storm" };
  if (w.sky === "rain") return { topic: "rain" };
  if (w.sky === "fog") return { topic: "fog" };
  if (w.sky === "snow" || w.tempC <= 18) return { topic: "cool" };
  if (w.tempC >= 33) return { topic: "hot", feel: w.tempC >= 38 ? "baking" : "hot" };
  return { topic: w.sky === "cloudy" ? "cloudy" : "clear" };
}

function timeTopic(hour: number): Topic | null {
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 13 && hour < 15) return "lunch";
  if (hour >= 15 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 21) return "evening";
  if (hour >= 21 || hour < 5) return "late";
  return null;
}

const MANNER_INDEX = { warm: 0, dry: 1, brisk: 2 } as const;

/** Other agents named in a log line, so the speaker can take the work to them. */
function mentioned(text: string, self: string, onFloor: Set<string>): string | null {
  const lower = text.toLowerCase();
  for (const id of onFloor) {
    if (id === self) continue;
    const def = AGENT_BY_ID[id];
    if (!def) continue;
    for (const word of [def.title, def.short]) {
      const w = word.toLowerCase();
      if (w.length > 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return id;
    }
  }
  return null;
}

type Candidate = { key: string; topic: Topic; listener?: string; values?: Record<string, string> };

/** The scenes to start now, and the director's memory for next time. */
export function direct(prev: DirectorState, inputs: DirectorInputs, now: number, rng: () => number): { state: DirectorState; scenes: Scene[] } {
  const s: DirectorState = { ...prev, seen: [...prev.seen], arrived: [...prev.arrived], used: [...prev.used] };
  const scenes: Scene[] = [];
  const id = () => s.nextId++;
  const onFloor = new Set(inputs.rooms.filter((r) => r.hired).map((r) => r.agentId));
  const motion = !inputs.reducedMotion;
  const names = inputs.names ?? {};

  /* Real work: each new team-log line is said by the agent who wrote it. */
  const fresh = inputs.log.filter((e) => !s.seen.includes(e.id)).sort((a, b) => a.at.localeCompare(b.at));
  const speak = s.started ? fresh : fresh.filter((e) => onFloor.has(e.agentId) && now - Date.parse(e.at) < TIMING.fresh).slice(-1);
  let t = now;
  const busyUntil = new Map<string, number>();
  for (const e of speak.slice(-3)) {
    if (!onFloor.has(e.agentId)) continue;
    const at = Math.max(t, busyUntil.get(e.agentId) ?? 0);
    scenes.push({ id: id(), kind: "say", agentId: e.agentId, text: spoken(e.text), source: "log", at, until: at + TIMING.say });
    let free = at + TIMING.say;
    const other = motion ? mentioned(e.text, e.agentId, onFloor) : null;
    if (other) {
      scenes.push({ id: id(), kind: "walk", agentId: e.agentId, to: { kind: "door", agentId: other }, at: free });
      scenes.push({ id: id(), kind: "walk", agentId: e.agentId, to: { kind: "home" }, at: free + 8000 });
      free += 8000 + TIMING.walk;
    }
    busyUntil.set(e.agentId, free);
    t = at + 1500;
  }
  if (s.started ? fresh.length : speak.length) s.lastLogAt = now;
  s.seen = [...s.seen, ...fresh.map((e) => e.id)].slice(-300);

  /* A document arriving: reception says who it is for, in the words the Floor already shows. */
  const arrival = inputs.arriving[0];
  if (arrival && !s.arrived.includes(arrival.docId)) {
    if (s.started && onFloor.has("office-manager") && arrival.agentId !== "office-manager") {
      scenes.push({ id: id(), kind: "say", agentId: "office-manager", text: spoken(`For ${personaFor(arrival.agentId, names).name}: ${arrival.label}`), source: "arrival", at: now, until: now + TIMING.say });
    }
    s.arrived = [...s.arrived, arrival.docId].slice(-50);
  }

  if (!s.started) {
    s.started = true;
    s.lastAmbientAt = now - TIMING.gapMin + 20_000;
    s.gap = TIMING.gapMin;
  }

  /* Small talk, only when the floor is quiet. */
  const working = inputs.rooms.some((r) => r.hired && r.status === "working");
  const quiet = !working && now - s.lastLogAt >= TIMING.quietAfterLog && now - s.lastAmbientAt >= s.gap && scenes.length === 0;
  const idle = inputs.rooms.filter((r) => r.hired && r.status === "idle" && r.waitingCount === 0).map((r) => r.agentId);
  if (!motion || !quiet || idle.length < 2) return { state: s, scenes };

  const clock = officeClock(now);
  const today = inputs.ambient?.today ?? clock.date;
  if (s.usedOn !== today) [s.used, s.usedOn] = [[], today];
  const md = today.slice(5);
  const idleSet = new Set(idle);
  const candidates: Candidate[] = [];
  for (const who of idle) if (personaFor(who, names).birthday === md) candidates.push({ key: `birthday:${who}`, topic: "birthday", listener: who });
  for (const f of inputs.ambient?.festivals ?? []) {
    const d = daysBetween(today, f.date);
    if (d === 0) candidates.push({ key: `festival:${f.name}`, topic: "festival-today", values: { festival: f.name } });
    else if (d > 0 && d < 7) candidates.push({ key: `festival-soon:${f.name}`, topic: "festival-soon", values: { festival: f.name, day: d === 1 ? "tomorrow" : `on ${WEEKDAYS[dayOf(f.date)]}` } });
  }
  for (const [who, hired] of Object.entries(inputs.ambient?.hiredOn ?? {})) {
    const span = hired && idleSet.has(who) ? anniversary(hired, today) : null;
    if (span) candidates.push({ key: `anniversary:${who}`, topic: "anniversary", listener: who, values: { span } });
  }
  if (lastWorkingDay(today) && clock.hour >= 10) candidates.push({ key: "month-end", topic: "month-end" });
  if (inputs.weather) {
    const w = weatherTopic(inputs.weather);
    candidates.push({ key: `weather:${Math.floor(clock.hour / 3)}`, topic: w.topic, values: { ...(inputs.weather.city ? { city: inputs.weather.city } : {}), ...(w.feel ? { feel: w.feel } : {}) } });
  }
  if (clock.weekday === 1 && clock.hour < 13) candidates.push({ key: "monday", topic: "monday" });
  if (clock.weekday === 5 && clock.hour >= 14) candidates.push({ key: "friday", topic: "friday" });
  const tod = timeTopic(clock.hour);
  if (tod) candidates.push({ key: tod, topic: tod });

  const pick = candidates.find((c) => !s.used.includes(c.key));
  if (!pick) return { state: s, scenes };

  const listener = pick.listener ?? idle[Math.floor(rng() * idle.length)]!;
  const others = idle.filter((x) => x !== listener);
  const speaker = others[Math.floor(rng() * others.length)]!;
  const a = personaFor(speaker, names);
  const b = personaFor(listener, names);
  const lines = PHRASES[pick.topic].filter((x) => pick.values?.city || !x.join(" ").includes("{city}"));
  if (!lines.length) return { state: s, scenes };
  const lean = MANNER_INDEX[a.manner] % lines.length;
  const ex: Exchange = lines[rng() < 0.5 ? lean : Math.floor(rng() * lines.length)]!;
  const values = { a: a.name, b: b.name, drink: b.drink, ...pick.values };

  const talk = now + TIMING.walk;
  const back = talk + TIMING.say + TIMING.reply + 1000;
  scenes.push(
    { id: id(), kind: "walk", agentId: speaker, to: { kind: "coffee", slot: 0 }, at: now },
    { id: id(), kind: "walk", agentId: listener, to: { kind: "coffee", slot: 1 }, at: now + 400 },
    { id: id(), kind: "say", agentId: speaker, text: fill(ex[0], values), source: "ambient", at: talk, until: talk + TIMING.say },
    { id: id(), kind: "say", agentId: listener, text: fill(ex[1], values), source: "ambient", at: talk + TIMING.say - 500, until: talk + TIMING.say + TIMING.reply },
    { id: id(), kind: "walk", agentId: speaker, to: { kind: "home" }, at: back },
    { id: id(), kind: "walk", agentId: listener, to: { kind: "home" }, at: back + 600 },
  );
  s.used.push(pick.key);
  s.lastAmbientAt = now;
  s.gap = TIMING.gapMin + Math.floor(rng() * (TIMING.gapMax - TIMING.gapMin));
  return { state: s, scenes };
}
