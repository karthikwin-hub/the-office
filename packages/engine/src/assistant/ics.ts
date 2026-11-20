import type { CalEvent } from "@office/contracts";

/**
 * A small reader for the iCalendar files Google, Outlook and Apple publish at a calendar's
 * private address. It covers what those calendars actually contain: time zones, all-day events,
 * daily, weekly, monthly and yearly repeats, skipped dates, moved occurrences and cancellations.
 */

type Prop = { name: string; params: Record<string, string>; value: string };
type Local = { y: number; m: number; d: number; h: number; mi: number; s: number };
type When = { local: Local; tz: string | null; utc: boolean; allDay: boolean };

const IST = "Asia/Kolkata";
/** Windows names that Outlook writes for the zones Indian businesses meet in. */
const WINDOWS_TZ: Record<string, string> = {
  "India Standard Time": IST,
  "GMT Standard Time": "Europe/London",
  "Arabian Standard Time": "Asia/Dubai",
  "Singapore Standard Time": "Asia/Singapore",
  "Eastern Standard Time": "America/New_York",
  "Pacific Standard Time": "America/Los_Angeles",
  "W. Europe Standard Time": "Europe/Berlin",
  "China Standard Time": "Asia/Shanghai",
  UTC: "UTC",
};

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
  // The value starts at the first colon that is not inside a quoted parameter.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0]!.toUpperCase(), params, value: line.slice(colon + 1) };
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: a local helper; the deprecated global unescape is not used here.
const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

function zoneOf(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const name = WINDOWS_TZ[tzid] ?? tzid.replace(/^\/+/, "");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return IST;
  }
}

function parseWhen(p: Prop): When | null {
  const v = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || p.params.VALUE === "DATE") {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { local: { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: 0, mi: 0, s: 0 }, tz: null, utc: false, allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!dt) return null;
  return { local: { y: +dt[1]!, m: +dt[2]!, d: +dt[3]!, h: +dt[4]!, mi: +dt[5]!, s: +(dt[6] ?? 0) }, tz: dt[7] ? "UTC" : (zoneOf(p.params.TZID) ?? IST), utc: Boolean(dt[7]), allDay: false };
}

/** How far a zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  if (tz === "UTC") return 0;
  if (tz === IST) return 5.5 * 3600_000;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time in a zone, as a UTC instant. All-day dates are taken in India time. */
function toMs(l: Local, tz: string | null): number {
  const zone = tz ?? IST;
  const guess = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s);
  const first = guess - offsetAt(guess, zone);
  return guess - offsetAt(first, zone);
}

function addLocalDays(l: Local, days: number): Local {
  const t = new Date(Date.UTC(l.y, l.m - 1, l.d + days));
  return { ...l, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const weekday = (l: Local) => new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay();
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86_400_000 + +(m[4] ?? 0) * 3600_000 + +(m[5] ?? 0) * 60_000 + +(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

type Rule = { freq: string; interval: number; count: number | null; until: number | null; byDay: { n: number; day: number }[]; byMonthDay: number[] };

function parseRule(v: string): Rule | null {
  const kv = Object.fromEntries(v.split(";").map((p) => p.split("=") as [string, string]).map(([k, x]) => [k.toUpperCase(), x ?? ""]));
  if (!kv.FREQ) return null;
  let until: number | null = null;
  if (kv.UNTIL) {
    const w = parseWhen({ name: "UNTIL", params: {}, value: kv.UNTIL });
    if (w) until = w.allDay ? toMs({ ...w.local, h: 23, mi: 59, s: 59 }, null) : toMs(w.local, w.tz);
  }
  const byDay = (kv.BYDAY ? kv.BYDAY.split(",") : [])
    .map((t) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ n: m[1] ? Number(m[1]) : 0, day: DAY_CODES.indexOf(m[2]!) }));
  return {
    freq: kv.FREQ.toUpperCase(),
    interval: Math.max(1, Number(kv.INTERVAL) || 1),
    count: kv.COUNT ? Number(kv.COUNT) : null,
    until,
    byDay,
    byMonthDay: kv.BYMONTHDAY ? kv.BYMONTHDAY.split(",").map(Number).filter((n) => n !== 0 && Math.abs(n) <= 31) : [],
  };
}

/** The local dates a rule produces, in order, from the first occurrence. Stops at `endMs` or after 3,000 tries. */
function* occurrences(start: When, rule: Rule, endMs: number): Generator<Local> {
  const s = start.local;
  const at = (l: Local) => toMs(l, start.allDay ? null : start.tz);
  let produced = 0;
  const emit = function* (l: Local) {
    if (rule.until !== null && at(l) > rule.until) return false;
    if (at(l) > endMs) return false;
    produced++;
    yield l;
    return !(rule.count !== null && produced >= rule.count);
  };
  for (let step = 0; step < 3000; step++) {
    let batch: Local[] = [];
    if (rule.freq === "DAILY") batch = [addLocalDays(s, step * rule.interval)];
    else if (rule.freq === "WEEKLY") {
      const weekStart = addLocalDays(s, -((weekday(s) + 6) % 7) + step * 7 * rule.interval);
      const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [weekday(s)];
      batch = days.map((d) => addLocalDays(weekStart, (d + 6) % 7)).sort((a, b) => at(a) - at(b));
    } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
      const months = rule.freq === "MONTHLY" ? step * rule.interval : step * 12 * rule.interval;
      const y = s.y + Math.floor((s.m - 1 + months) / 12);
      const m = ((s.m - 1 + months) % 12) + 1;
      const dim = daysInMonth(y, m);
      let days: number[] = [];
      if (rule.byMonthDay.length) days = rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1));
      else if (rule.byDay.length) {
        for (const b of rule.byDay) {
          const all: number[] = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.day) all.push(d);
          if (b.n === 0) days.push(...all);
          else {
            const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
            if (pick) days.push(pick);
          }
        }
      } else days = [s.d];
      batch = days.filter((d) => d >= 1 && d <= dim).sort((a, b) => a - b).map((d) => ({ ...s, y, m, d }));
    } else {
      yield s;
      return;
    }
    for (const l of batch) {
      if (at(l) < at(s)) continue;
      const more = yield* emit(l);
      if (!more) return;
    }
    if (batch.length && at(batch[0]!) > endMs) return;
  }
}

type Raw = { props: Prop[] };

const first = (r: Raw, name: string) => r.props.find((p) => p.name === name);

/**
 * The events that touch the window, as instants. Anything the file cannot say clearly is left out
 * rather than guessed. `fromMs` and `toMs` bound the window; events are returned by start time.
 */
export function parseIcs(text: string, fromMs: number, toMsBound: number): { events: CalEvent[]; name: string | null } {
  const lines = unfold(text);
  const events: Raw[] = [];
  let calName: string | null = null;
  let cur: Raw | null = null;
  let depth = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (p.value.toUpperCase() === "VEVENT" && depth === 0) cur = { props: [] };
      else if (cur) depth++;
      continue;
    }
    if (p.name === "END") {
      if (cur && depth > 0) depth--;
      else if (cur && p.value.toUpperCase() === "VEVENT") {
        events.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && depth === 0) cur.props.push(p);
    else if (!cur && p.name === "X-WR-CALNAME") calName = unescape(p.value);
  }

  // Moved or cancelled single occurrences, by event and original start.
  const overrides = new Map<string, Set<number>>();
  for (const e of events) {
    const rid = first(e, "RECURRENCE-ID");
    const uid = first(e, "UID")?.value ?? "";
    const w = rid && parseWhen(rid);
    if (!w) continue;
    const key = toMs(w.local, w.allDay ? null : w.tz);
    overrides.set(uid, (overrides.get(uid) ?? new Set()).add(key));
  }

  const out: CalEvent[] = [];
  for (const e of events) {
    if ((first(e, "STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    const startProp = first(e, "DTSTART");
    const start = startProp && parseWhen(startProp);
    if (!start) continue;
    const uid = first(e, "UID")?.value ?? `${startProp!.value}-${first(e, "SUMMARY")?.value ?? ""}`;
    const startMs = toMs(start.local, start.allDay ? null : start.tz);
    const endProp = first(e, "DTEND");
    const endW = endProp && parseWhen(endProp);
    const dur = first(e, "DURATION");
    let length = endW ? toMs(endW.local, endW.allDay ? null : endW.tz) - startMs : dur ? parseDuration(dur.value) : start.allDay ? 86_400_000 : 0;
    if (!Number.isFinite(length) || length < 0) length = 0;

    const title = unescape(first(e, "SUMMARY")?.value ?? "") || "Busy";
    const location = unescape(first(e, "LOCATION")?.value ?? "") || null;
    const attendees = e.props
      .filter((p) => p.name === "ATTENDEE" || p.name === "ORGANIZER")
      .map((p) => ({ email: p.value.replace(/^mailto:/i, "").trim().toLowerCase(), name: p.params.CN ? unescape(p.params.CN) : null, declined: (p.params.PARTSTAT ?? "").toUpperCase() === "DECLINED" }))
      .filter((a) => a.email.includes("@") && !a.declined)
      .map(({ email, name }) => ({ email, name }));
    const seen = new Set<string>();
    const people = attendees.filter((a) => (seen.has(a.email) ? false : (seen.add(a.email), true)));

    const skip = new Set<number>();
    for (const ex of e.props.filter((p) => p.name === "EXDATE")) {
      for (const v of ex.value.split(",")) {
        const w = parseWhen({ ...ex, value: v });
        if (w) skip.add(toMs(w.local, w.allDay ? null : w.tz));
      }
    }
    const isOverride = Boolean(first(e, "RECURRENCE-ID"));
    const moved = isOverride ? new Set<number>() : (overrides.get(uid) ?? new Set<number>());

    const push = (ms: number) => {
      if (ms + Math.max(length, 1) <= fromMs || ms > toMsBound) return;
      out.push({ id: `${uid}#${ms}`, title, start: new Date(ms).toISOString(), end: new Date(ms + length).toISOString(), allDay: start.allDay, location, attendees: people });
    };

    const rruleProp = first(e, "RRULE");
    const rule = !isOverride && rruleProp ? parseRule(rruleProp.value) : null;
    if (!rule) {
      push(startMs);
      continue;
    }
    for (const l of occurrences(start, rule, toMsBound)) {
      const ms = toMs(l, start.allDay ? null : start.tz);
      if (skip.has(ms) || moved.has(ms)) continue;
      push(ms);
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { events: out, name: calName };
}

/** "09:30" in India time. */
export const istClock = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(11, 16);
/** The date in India for an instant. */
export const istDate = (iso: string | number) => new Date((typeof iso === "number" ? iso : Date.parse(iso)) + 5.5 * 3600_000).toISOString().slice(0, 10);
