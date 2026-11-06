import type { Books, ComplianceEvent, Obligation } from "@office/contracts";
import { dateLabel, daysBetween } from "../dates";
import { Ledger } from "../ledger";
import { inr } from "../money";
import { overrideFor } from "./overrides";
import { profileOf } from "./profile";
import { allRules, ctxFor, lateCost, type RawItem } from "./rules";

const rupees = (paise: number) => `₹${inr(paise, { rupees: true })}`;
const WEEKDAY = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" });

/** "by Thursday", "by 20 Nov 2026", "today", or how late it is. */
function when(dueOn: string, daysLeft: number): string {
  if (daysLeft === 0) return "today";
  if (daysLeft === 1) return "by tomorrow";
  if (daysLeft > 1 && daysLeft < 7) return `by ${WEEKDAY(dueOn)}`;
  return `by ${dateLabel(dueOn)}`;
}

/** The plain line the owner reads: what to do, by when, and what it costs not to. */
function lineFor(o: Pick<Obligation, "title" | "amountPaise" | "daysLeft" | "dueOn" | "state" | "lateCostPaise">, raw: RawItem): string {
  const amount = o.amountPaise ? ` (${rupees(o.amountPaise)})` : "";
  if (o.state === "filed") return `${o.title}: done.`;
  if (o.state === "late") {
    const d = -o.daysLeft;
    return `${o.title}${amount} is ${d} day${d === 1 ? "" : "s"} late${o.lateCostPaise ? ` and has cost about ${rupees(o.lateCostPaise)} so far` : ""}. ${raw.lateNote}`.trim();
  }
  const cost =
    raw.late.kind === "interest" && raw.late.basePaise
      ? ` or it costs ${rupees(Math.round((raw.late.basePaise * raw.late.pctMonth) / 100))} a month`
      : o.lateCostPaise
        ? ` or a week's delay costs about ${rupees(o.lateCostPaise)}`
        : "";
  return `${o.title}${amount} ${when(o.dueOn, o.daysLeft)}${cost}.`;
}

/** Legacy calendar entries were matched by form and date; they become tracking for the item they describe. */
function legacyKey(form: string, date: string) {
  return `${form.toUpperCase().replace(/[^A-Z0-9]/g, "")}|${date.slice(0, 7)}`;
}

/**
 * The company's calendar: every item the rules work out for the profile and the books, plus the ROC
 * filings that changes in the company started, plus anything added by hand, each with its tracking.
 */
export function buildObligations(books: Books, asOf = books.business.asOf): Obligation[] {
  return memo(books, `obligations|${asOf}`, () => build(books, asOf));
}

/** What the calendar depends on, cheaply: a change to any of it works the calendar out afresh. */
export function fingerprint(books: Books): string {
  const posted = (xs: { status: string }[]) => xs.reduce((n, x) => n + (x.status === "posted" ? 1 : 0), 0);
  return [
    books.business.asOf,
    posted(books.bills),
    posted(books.invoices),
    books.payments.length,
    books.filedReturns.map((r) => `${r.id}:${r.status}`).join(","),
    books.employees.length,
    books.parties.map((p) => `${p.id}:${p.udyamCategory ?? ""}:${p.writtenCreditDays ?? ""}:${p.udyamActivity ?? ""}`).join(","),
    JSON.stringify(books.business.compliance ?? null),
    JSON.stringify(books.compliance),
  ].join("|");
}

const cache = new WeakMap<Books, Map<string, { key: string; value: unknown }>>();
export function memo<T>(books: Books, name: string, make: () => T): T {
  const key = fingerprint(books);
  const forBooks = cache.get(books) ?? new Map<string, { key: string; value: unknown }>();
  cache.set(books, forBooks);
  const hit = forBooks.get(name);
  if (hit && hit.key === key) return hit.value as T;
  const value = make();
  forBooks.set(name, { key, value });
  return value;
}

function build(books: Books, asOf: string): Obligation[] {
  const p = profileOf(books);
  const l = new Ledger(books, asOf);
  const c = ctxFor(books, l, p, asOf);
  const stored = new Map(books.compliance.map((x) => [x.ruleId && x.period ? `${x.ruleId}:${x.period}` : x.id, x]));
  const legacy = new Map(books.compliance.filter((x) => !x.ruleId && x.source !== "manual").map((x) => [legacyKey(x.form, x.date), x]));
  const usedLegacy = new Set<string>();
  const out: Obligation[] = [];
  for (const raw of allRules(c)) {
    const id = `${raw.ruleId}:${raw.period}`;
    const ov = overrideFor(raw.ruleId, raw.period);
    const dueOn = ov && ov.dueOn > raw.dueOn ? ov.dueOn : raw.dueOn;
    let track: ComplianceEvent | undefined = stored.get(id);
    if (!track) {
      const old = legacy.get(legacyKey(raw.form, raw.dueOn));
      if (old) {
        track = old;
        usedLegacy.add(old.id);
      }
    }
    if (!track && (dueOn < c.from || dueOn > c.to)) continue;
    out.push(toObligation(raw, id, dueOn, ov && ov.dueOn > raw.dueOn ? { circular: ov.circular, note: ov.note } : null, track, asOf));
  }
  for (const x of books.compliance) {
    if (x.ruleId || usedLegacy.has(x.id) || out.some((o) => o.id === x.id)) continue;
    const raw: RawItem = {
      ruleId: "manual", period: x.id, form: x.form, title: x.description || x.form, authority: x.authority, dueOn: x.date, why: "Added by hand.", documents: [], portal: { name: "", url: "" },
      amountPaise: null, late: { kind: "none" }, lateNote: "", risk: null, papers: false, mca: false, source: "rule",
    };
    const o = toObligation(raw, x.id, x.date, null, x, asOf);
    out.push({ ...o, source: "manual" });
  }
  return out.sort((a, b) => (a.dueOn === b.dueOn ? (a.form < b.form ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1));
}

function toObligation(raw: RawItem, id: string, dueOn: string, override: Obligation["override"], track: ComplianceEvent | undefined, asOf: string): Obligation {
  const daysLeft = daysBetween(asOf, dueOn);
  const filedOn = track?.filedOn ?? (track?.status === "done" ? track.date : null) ?? raw.filed?.on ?? null;
  const snoozed = track?.snoozedUntil && track.snoozedUntil > asOf ? track.snoozedUntil : null;
  const state: Obligation["state"] = filedOn ? "filed" : snoozed ? "snoozed" : daysLeft < 0 ? "late" : track?.progress ?? "upcoming";
  const lateDays = filedOn ? Math.max(0, daysBetween(dueOn, filedOn)) : daysLeft < 0 ? -daysLeft : 0;
  const lateCostPaise = state === "filed" ? lateCost(raw.late, lateDays) : state === "late" ? lateCost(raw.late, lateDays) : lateCost(raw.late, 7);
  const base = {
    title: raw.title,
    amountPaise: raw.amountPaise,
    daysLeft,
    dueOn,
    state,
    lateCostPaise,
  };
  return {
    id,
    ruleId: raw.ruleId,
    period: raw.period,
    form: raw.form,
    title: raw.title,
    authority: raw.authority,
    dueOn,
    daysLeft,
    state,
    source: raw.source,
    assignee: track?.assignee ?? null,
    amountPaise: raw.amountPaise,
    lateCostPaise,
    lateCostNote: raw.lateNote,
    line: lineFor(base, raw),
    why: raw.why,
    documents: raw.documents,
    portal: raw.portal,
    override,
    risk: raw.risk,
    filedOn,
    ack: track?.ack || raw.filed?.ack || null,
    proof: track?.proof ?? null,
    snoozedUntil: snoozed,
    snoozeReason: snoozed ? (track?.snoozeReason ?? null) : null,
    srn: track?.srn,
    papers: raw.papers,
    mca: raw.mca,
  };
}

/** What missing the open items costs: what the late ones have cost so far, and a week's delay for those due within seven days. */
export function atRisk(obligations: Obligation[]): number {
  return obligations.filter((o) => o.state === "late" || (o.state !== "filed" && o.state !== "snoozed" && o.daysLeft <= 7)).reduce((a, o) => a + o.lateCostPaise, 0);
}

/** The stored record for an item, created from the worked-out one the first time it is tracked. */
export function trackingFor(books: Books, o: Obligation): ComplianceEvent {
  const found = books.compliance.find((x) => x.id === o.id || (x.ruleId && x.period && `${x.ruleId}:${x.period}` === o.id));
  if (found) return found;
  const legacy = books.compliance.find((x) => !x.ruleId && x.source !== "manual" && legacyKey(x.form, x.date) === legacyKey(o.form, o.dueOn));
  if (legacy) {
    legacy.ruleId = o.ruleId;
    legacy.period = o.period;
    return legacy;
  }
  const rec: ComplianceEvent = { id: o.id, date: o.dueOn, form: o.form, description: o.title, authority: o.authority, status: "upcoming", ruleId: o.ruleId, period: o.period, source: o.source };
  books.compliance.push(rec);
  return rec;
}