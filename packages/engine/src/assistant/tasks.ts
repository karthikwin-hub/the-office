import { addDays } from "../dates";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The next date on or after `from` that a phrase names: "friday", "tomorrow", "in 3 days", "25 nov", "25/11". */
function dateIn(phrase: string, asOf: string): { date: string; match: string } | null {
  const p = phrase.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /\b(today|aaj)\b/.exec(p))) return { date: asOf, match: m[0] };
  if ((m = /\b(day after tomorrow|parson)\b/.exec(p))) return { date: addDays(asOf, 2), match: m[0] };
  if ((m = /\b(tomorrow|tmrw|kal)\b/.exec(p))) return { date: addDays(asOf, 1), match: m[0] };
  if ((m = /\bin (\d{1,2}|a|one|two|three) (day|days|week|weeks)\b/.exec(p))) {
    const n = { a: 1, one: 1, two: 2, three: 3 }[m[1] as "a"] ?? Number(m[1]);
    return { date: addDays(asOf, m[2]!.startsWith("week") ? n * 7 : n), match: m[0] };
  }
  if ((m = /\bnext week\b/.exec(p))) return { date: addDays(asOf, (8 - weekdayOf(asOf)) % 7 || 7), match: m[0] };
  if ((m = /\b(?:on |by |this |next )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?\b/.exec(p))) {
    const want = WEEKDAYS.findIndex((d) => d.startsWith(m![1]!.slice(0, 3)));
    let gap = (want - weekdayOf(asOf) + 7) % 7;
    if (gap === 0 || /\bnext\b/.test(m[0])) gap += 7;
    return { date: addDays(asOf, gap), match: m[0] };
  }
  if (
    (m = /\b(?:on |by )?(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(p)) ||
    (m = /\b(?:on |by )?(\d{1,2})[/-](\d{1,2})\b/.exec(p))
  ) {
    const day = Number(m[1]);
    const month = /\d/.test(m[2]!) ? Number(m[2]) : MONTHS.indexOf(m[2]!) + 1;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    let y = Number(asOf.slice(0, 4));
    let iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (iso < asOf) iso = `${++y}${iso.slice(4)}`;
    return { date: iso, match: m[0] };
  }
  return null;
}

/**
 * "remind me to call Sharma on Friday" → a task for Friday. Returns null when the message is not
 * a reminder. Hinglish "yaad dilana" works as well as English.
 */
export function parseReminder(text: string, asOf: string): { title: string; due: string | null } | null {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(?:please\s+)?(?:remind me(?: to| about| that)?|reminder(?: to)?:?|todo:?|to do:?|yaad dilana)\s+(.+)$/i.exec(t);
  if (!m) return null;
  let rest = m[1]!.replace(/[.!]+$/, "");
  const when = dateIn(rest, asOf);
  if (when) rest = rest.replace(new RegExp(`\\s*${when.match.replace(/[/\\^$*+?.()|[\]{}-]/g, "\\$&")}\\s*`, "i"), " ").trim();
  rest = rest.replace(/\s+(on|by|at)$/i, "").trim();
  if (!rest) return null;
  return { title: rest.charAt(0).toUpperCase() + rest.slice(1), due: when?.date ?? null };
}

/** "done call Sharma" → the words to match against open tasks. */
export function parseDone(text: string): string | null {
  const m = /^(?:done|did|finished|ho gaya)[:\s]+(.+)$/i.exec(text.trim());
  return m ? m[1]!.trim() : null;
}
