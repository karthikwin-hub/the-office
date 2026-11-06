import {
  type Books,
  type CompanyEvent,
  type ComplianceCheck,
  type ComplianceEvent,
  ComplianceProfile,
  type ComplianceView,
  type MasterCheck,
  type Obligation,
  type StagedChange,
} from "@office/contracts";
import { dateLabel } from "../dates";
import { Ledger } from "../ledger";
import { inrShort } from "../money";
import { atRisk, buildObligations, memo, trackingFor } from "./calendar";
import { advanceTaxCheck, dpt3Check, foreignPaymentCheck, itc180Check, msmeCheck, rcmCheck, tdsGapCheck, thresholdCheck } from "./checks";
import { masterChecks, parseMasterData } from "./papers";
import { answers, fyOf, profileEvents, profileOf, smallCompany } from "./profile";

export { buildObligations, atRisk } from "./calendar";
export { filingPack, parseMasterData, workingPaper } from "./papers";
export { profileOf, smallCompany, estimateTax, KEY_QUESTIONS } from "./profile";
export { lateCost, mcaMultiple } from "./rules";
export { OVERRIDES } from "./overrides";

export class ComplianceError extends Error {}

export function complianceChecks(books: Books, obligations: Obligation[], asOf = books.business.asOf): ComplianceCheck[] {
  const l = new Ledger(books, asOf);
  const p = profileOf(books);
  const fy = fyOf(asOf);
  const paid = obligations.filter((o) => o.ruleId === "advance-tax" && o.period.startsWith(`${fy}-`) && o.state === "filed").reduce((a, o) => a + (o.amountPaise ?? 0), 0);
  const all = [msmeCheck(l), advanceTaxCheck(l, p, paid), tdsGapCheck(l), itc180Check(l), rcmCheck(l), dpt3Check(l, p), thresholdCheck(l, p), foreignPaymentCheck(p, asOf)];
  const order = { red: 0, amber: 1, green: 2 } as const;
  return all.filter((c): c is ComplianceCheck => c !== null).sort((a, b) => order[a.tone] - order[b.tone]);
}

export function complianceView(books: Books, asOf = books.business.asOf): ComplianceView {
  return memo(books, `view|${asOf}`, () => makeView(books, asOf));
}

function makeView(books: Books, asOf: string): ComplianceView {
  const p = profileOf(books);
  const obligations = buildObligations(books, asOf);
  const checks = complianceChecks(books, obligations, asOf);
  const risk = atRisk(obligations) + checks.filter((c) => c.tone === "red").reduce((a, c) => a + c.amountPaise, 0);
  const filed = obligations.filter((o) => o.state === "filed");
  const late = obligations.filter((o) => o.state === "late");
  const week = obligations.filter((o) => o.state !== "filed" && o.state !== "snoozed" && o.daysLeft >= 0 && o.daysLeft <= 7);
  const open = obligations.filter((o) => o.state !== "filed");
  const note: ComplianceView["note"] = [
    ...(late.length ? [{ text: `${late.length} item${late.length === 1 ? " is" : "s are"} late. ` }] : []),
    { text: `${week.length} due this week` },
    ...(risk ? [{ text: ", and " }, { text: inrShort(risk), figureId: "compliance:at-risk", tone: "red" as const }, { text: " is at risk from late fees, interest and tax disallowed" }] : []),
    { text: "." },
    ...(open[0] ? [{ text: ` Next: ${open.find((o) => o.state !== "late")?.title ?? open[0].title}, ${dateLabel((open.find((o) => o.state !== "late") ?? open[0]).dueOn)}.` }] : []),
  ];
  return {
    asOf,
    note,
    profile: p,
    answers: answers(p),
    small: smallCompany(books, p),
    atRiskPaise: risk,
    obligations,
    checks,
    health: {
      filedOnTime: filed.filter((o) => o.filedOn! <= o.dueOn).length,
      filedLate: filed.filter((o) => o.filedOn! > o.dueOn).length,
      open: open.length,
      lateFeesPaise: filed.reduce((a, o) => a + o.lateCostPaise, 0),
    },
  };
}

function find(books: Books, id: string, asOf: string): Obligation {
  const o = buildObligations(books, asOf).find((x) => x.id === id);
  if (!o) throw new ComplianceError(`No calendar item ${id}.`);
  return o;
}

function stamp(rec: ComplianceEvent, by: string, at: string) {
  rec.updatedBy = by;
  rec.updatedAt = at;
}

/** Saves the profile. Changes that start an ROC clock (a new director, a moved office, a secured loan) become events. */
export function saveProfile(books: Books, input: ComplianceProfile, asOf: string): { profile: ComplianceProfile; events: CompanyEvent[] } {
  const before = profileOf(books);
  const next = ComplianceProfile.parse(input);
  const events = books.business.compliance ? profileEvents(before, next, asOf) : [];
  next.events = [...next.events.filter((e) => !events.some((x) => x.id === e.id)), ...events];
  next.masterData = input.masterData ?? before.masterData;
  next.calendarFrom ??= before.calendarFrom ?? `${asOf.slice(0, 7)}-01`;
  books.business.compliance = next;
  return { profile: next, events };
}

export function addEvent(books: Books, input: Pick<CompanyEvent, "kind" | "on" | "detail" | "privatePlacement" | "foreign">): CompanyEvent {
  const p = profileOf(books);
  const e: CompanyEvent = { ...input, id: `evt-${input.kind}-${input.on}-${p.events.length + 1}`, auto: false };
  p.events.push(e);
  books.business.compliance = p;
  return e;
}

export function checkMasterData(books: Books, text: string, asOf: string): MasterCheck[] {
  const fields = parseMasterData(text);
  if (!Object.keys(fields).length) throw new ComplianceError("Nothing in the text looked like the MCA's company master data. Copy the whole page from \"View company or LLP master data\".");
  const p = profileOf(books);
  p.masterData = { checkedOn: asOf, fields };
  books.business.compliance = p;
  return masterChecks(books, p);
}

export function markFiled(books: Books, id: string, input: { filedOn: string; ack: string; proof?: { file: string; name: string } | null }, by: string, at: string): Obligation {
  const o = find(books, id, at.slice(0, 10));
  const rec = trackingFor(books, o);
  rec.filedOn = input.filedOn;
  rec.status = "done";
  if (input.ack) rec.ack = input.ack;
  if (input.proof !== undefined) rec.proof = input.proof;
  rec.progress = null;
  stamp(rec, by, at);
  return find(books, id, at.slice(0, 10));
}

export function reopen(books: Books, id: string, by: string, at: string): Obligation {
  const o = find(books, id, at.slice(0, 10));
  const rec = trackingFor(books, o);
  rec.filedOn = null;
  rec.status = "upcoming";
  stamp(rec, by, at);
  return find(books, id, at.slice(0, 10));
}

export function assign(books: Books, id: string, input: { assignee: ComplianceEvent["assignee"]; progress?: ComplianceEvent["progress"] }, by: string, at: string): Obligation {
  const rec = trackingFor(books, find(books, id, at.slice(0, 10)));
  rec.assignee = input.assignee;
  if (input.progress !== undefined) rec.progress = input.progress;
  stamp(rec, by, at);
  return find(books, id, at.slice(0, 10));
}

export function snooze(books: Books, id: string, input: { until: string | null; reason: string }, by: string, at: string): Obligation {
  const rec = trackingFor(books, find(books, id, at.slice(0, 10)));
  rec.snoozedUntil = input.until;
  rec.snoozeReason = input.reason;
  stamp(rec, by, at);
  return find(books, id, at.slice(0, 10));
}

export function recordSrn(books: Books, id: string, srn: NonNullable<ComplianceEvent["srn"]>, by: string, at: string): Obligation {
  const o = find(books, id, at.slice(0, 10));
  if (!o.mca) throw new ComplianceError(`${o.form} is not an MCA form.`);
  const rec = trackingFor(books, o);
  rec.srn = srn;
  if (srn.status === "approved" && !rec.filedOn) {
    rec.filedOn = srn.createdOn;
    rec.status = "done";
    rec.ack ||= srn.number;
  }
  stamp(rec, by, at);
  return find(books, id, at.slice(0, 10));
}

export function addManual(books: Books, input: { form: string; dueOn: string; description: string; authority: string }, by: string, at: string): Obligation {
  const n = books.compliance.filter((x) => x.source === "manual").length + 1;
  const id = `man-${at.slice(0, 10).replace(/-/g, "")}-${n}`;
  books.compliance.push({ id, date: input.dueOn, form: input.form, description: input.description || input.form, authority: input.authority, status: "upcoming", source: "manual", updatedBy: by, updatedAt: at });
  return find(books, id, at.slice(0, 10));
}

export function removeManual(books: Books, id: string): void {
  const i = books.compliance.findIndex((x) => x.id === id && x.source === "manual");
  if (i < 0) throw new ComplianceError("Only items added by hand can be removed.");
  books.compliance.splice(i, 1);
}

/** The Compliance Officer's proposals for the owner's desk, from the checks that call for a decision. */
export function complianceProposals(books: Books, asOf = books.business.asOf): StagedChange[] {
  const checks = complianceView(books, asOf).checks;
  return checks
    .filter((c) => c.proposal)
    .map((c) => ({
      id: `cmp-${c.proposal!.id}-${asOf.slice(0, 7)}`,
      agentId: "compliance-officer",
      kind: "compliance_action" as const,
      createdAt: `${asOf}T09:05:00+05:30`,
      title: c.proposal!.label,
      summary: c.summary,
      evidence: c.rows.filter((r) => r.ref).slice(0, 4).map((r) => ({ label: r.label, ref: r.ref! })),
      payload: { checkId: c.id, amountPaise: c.amountPaise, rows: c.rows.filter((r) => r.amountPaise).map((r) => r.label) },
      status: "pending" as const,
    }));
}

/** Items to remind about today: seven and two days ahead, on the day, and every week once late. */
export function dueReminders(books: Books, asOf = books.business.asOf): Obligation[] {
  return buildObligations(books, asOf).filter((o) => (o.state !== "filed" && o.state !== "snoozed" && [7, 2, 0].includes(o.daysLeft)) || (o.state === "late" && -o.daysLeft % 7 === 1));
}
