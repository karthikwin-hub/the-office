/**
 * Reading the values in a platform's report: Indian amounts, the date styles the platforms use,
 * state names, and comma- or tab-separated text. Nothing here guesses: a value it cannot read is null.
 */

/** A sheet as rows of text, whatever file it came from. */
export type Sheet = { name: string; rows: string[][] };

/** Comma- or tab-separated text; Amazon's flat files are tab-separated `.txt`. */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  // The separator is the one the busiest of the first lines uses, so a title line above the header does not decide it.
  const top = clean.slice(0, 20_000).split(/\r?\n/).slice(0, 10);
  const count = (re: RegExp) => Math.max(0, ...top.map((l) => l.match(re)?.length ?? 0));
  const tabs = count(/\t/g);
  const commas = count(/,/g);
  const semis = count(/;/g);
  const sep = tabs > commas && tabs >= semis ? "\t" : semis > commas + 2 ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

/** "₹1,23,456.50", "Rs. 120", "(45.00)", "-12" → paise. Blank or a dash is null. */
export function paiseOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || /^[-–—]$/.test(s) || /^n\/?a$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/₹|rs\.?|inr/gi, "").replace(/[,\s]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return negative ? -paise : paise;
}

export function numberOf(raw: string | undefined): number | null {
  const p = paiseOf(raw);
  return p === null ? null : p / 100;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** "Oct", "Sept" or "October": the regexes take up to four letters, so a full name is looked up by its first three. */
const monthOf = (word: string) => MONTHS[word.toLowerCase()] ?? MONTHS[word.slice(0, 3).toLowerCase()];
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};

/**
 * The date in India for the styles the platforms write: ISO with or without a time or zone,
 * day first (03-10-2026, 03/10/2026, 03.10.2026), "03-Oct-2026", "Oct 3, 2026", or a spreadsheet
 * serial number. A time with a zone is turned into the date in India.
 */
export function dateOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?/i.exec(s))) {
    if (m[4] && m[7]) {
      const zone = /^(utc|gmt|z)$/i.test(m[7]) ? "Z" : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7];
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${zone}`);
      if (Number.isFinite(t)) return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
    }
    return iso(+m[1]!, +m[2]!, +m[3]!);
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(utc|gmt)?)?/i.exec(s))) {
    const d = iso(+m[3]!, +m[2]!, +m[1]!);
    if (d && m[4] && m[6]) {
      const t = Date.parse(`${d}T${m[4].padStart(2, "0")}:${m[5]}:00Z`);
      return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
    }
    return d;
  }
  // "03-Oct-2026", or Amazon's "1 Oct 2026 8:33:52 pm UTC".
  if ((m = /^(\d{1,2})[-\s]([a-z]{3,4})[a-z]*[-\s,]+(\d{2,4})(?:[\s,T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*(utc|gmt|z)?)?/i.exec(s))) {
    const mo = monthOf(m[2]!);
    const d = mo ? iso(+m[3]!, mo, +m[1]!) : null;
    if (d && m[4] && m[7]) {
      let h = +m[4] % 12;
      if (!m[6]) h = +m[4];
      else if (m[6].toLowerCase() === "pm") h += 12;
      const t = Date.parse(`${d}T${String(h).padStart(2, "0")}:${m[5]}:00Z`);
      if (Number.isFinite(t)) return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
    }
    return d;
  }
  if ((m = /^([a-z]{3,4})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s))) {
    const mo = monthOf(m[1]!);
    return mo ? iso(+m[3]!, mo, +m[2]!) : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 36_000 && serial < 80_000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

const STATES: [string, string[]][] = [
  ["01", ["jammu and kashmir", "jammu & kashmir", "j&k", "jk"]],
  ["02", ["himachal pradesh", "hp"]],
  ["03", ["punjab", "pb"]],
  ["04", ["chandigarh", "ch"]],
  ["05", ["uttarakhand", "uttaranchal", "uk"]],
  ["06", ["haryana", "hr"]],
  ["07", ["delhi", "new delhi", "nct of delhi", "dl"]],
  ["08", ["rajasthan", "rj"]],
  ["09", ["uttar pradesh", "up"]],
  ["10", ["bihar", "br"]],
  ["11", ["sikkim", "sk"]],
  ["12", ["arunachal pradesh", "ar"]],
  ["13", ["nagaland", "nl"]],
  ["14", ["manipur", "mn"]],
  ["15", ["mizoram", "mz"]],
  ["16", ["tripura", "tr"]],
  ["17", ["meghalaya", "ml"]],
  ["18", ["assam", "as"]],
  ["19", ["west bengal", "wb"]],
  ["20", ["jharkhand", "jh"]],
  ["21", ["odisha", "orissa", "od", "or"]],
  ["22", ["chhattisgarh", "chattisgarh", "cg"]],
  ["23", ["madhya pradesh", "mp"]],
  ["24", ["gujarat", "gj"]],
  ["26", ["dadra and nagar haveli and daman and diu", "dadra and nagar haveli", "daman and diu", "dnh", "dd"]],
  ["27", ["maharashtra", "mh"]],
  ["29", ["karnataka", "ka"]],
  ["30", ["goa", "ga"]],
  ["31", ["lakshadweep", "ld"]],
  ["32", ["kerala", "kl"]],
  ["33", ["tamil nadu", "tamilnadu", "tn"]],
  ["34", ["puducherry", "pondicherry", "py"]],
  ["35", ["andaman and nicobar islands", "andaman and nicobar", "andaman & nicobar islands", "an"]],
  ["36", ["telangana", "ts", "tg"]],
  ["37", ["andhra pradesh", "ap"]],
  ["38", ["ladakh", "la"]],
];
const STATE_BY_NAME = new Map(STATES.flatMap(([code, names]) => names.map((n) => [n, code] as const)));
export const STATE_NAME: Record<string, string> = Object.fromEntries(
  STATES.map(([code, names]) => [code, names[0]!.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/ And /g, " and ")]),
);

/** "MAHARASHTRA", "Maharashtra", "MH" or "27" → "27". */
export function stateOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^state of /, "");
  if (/^\d{1,2}$/.test(s)) {
    const code = s.padStart(2, "0");
    return STATE_NAME[code] ? code : null;
  }
  return STATE_BY_NAME.get(s) ?? null;
}

/** Headers compared without case, punctuation or spacing. */
export const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
