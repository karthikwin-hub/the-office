import { BOOKS_PROVIDER, type Books, type ComplianceProfile, type FilingPack, type MasterCheck, type Obligation, type Paper } from "@office/contracts";
import { dateLabel, monthEnd, quarterMonths } from "../dates";
import { itcFor, outwardFor, setOff } from "../gst";
import { Ledger } from "../ledger";
import { r2 } from "../money";
import { tdsDepositDue, tdsRef } from "../tds";
import { buildObligations } from "./calendar";
import { billOpenPaise, estimateTax, fyFromLabel, fyLabel, msmeLimitDays, msmeProtected, profileOf } from "./profile";
import { kycDue } from "./rules";

const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
const paper = (filename: string, rows: (string | number | null | undefined)[][]): Paper => ({ filename, mime: "text/csv", content: csv(rows) });

/** The months a period covers: "2026-10", "FY2026-27-Q2", "2026-27" or a half-year "2026-27-H1". */
function monthsOf(period: string): string[] {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return [period];
  if (period.startsWith("FY")) return quarterMonths(period);
  const fy = fyFromLabel(period);
  const all = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return `${m >= 4 ? fy : fy + 1}-${String(m).padStart(2, "0")}`;
  });
  if (period.endsWith("-H1")) return all.slice(0, 6);
  if (period.endsWith("-H2")) return all.slice(6);
  return all;
}

/** A CSV the CA can work from, for any item the calendar marks as having papers. */
export function workingPaper(books: Books, obligationId: string, asOf = books.business.asOf): Paper | null {
  const o = buildObligations(books, asOf).find((x) => x.id === obligationId);
  if (!o) return null;
  const l = new Ledger(books, asOf);
  const p = profileOf(books);
  const name = (s: string) => `${s}_${o.period.replace(/[^A-Za-z0-9-]/g, "")}.csv`;
  const months = monthsOf(o.period);
  switch (o.ruleId) {
    case "tds-deposit":
    case "tds-return": {
      const rows: (string | number | null)[][] = [["Bill", "Date", "Deductee", "PAN", "Section (1961 Act)", "Section 393 reference", "Payment code", "Amount liable (₹)", "TDS (₹)", "Deposit due"]];
      for (const b of l.postedBills) {
        if (!b.tds || !months.includes(b.date.slice(0, 7))) continue;
        const party = l.party(b.partyId);
        const ref = tdsRef(b.tds.section, b.date, party);
        rows.push([b.number, b.date, party.name, party.pan, b.tds.section, ref.code ? ref.reference : "", ref.code, r2(b.tds.basePaise), r2(b.tds.amountPaise), tdsDepositDue(b.date)]);
      }
      return paper(name(o.ruleId === "tds-deposit" ? "TDS_challan" : o.form.replace(/\s/g, "")), rows);
    }
    case "gstr1":
    case "gstr3b":
    case "gstr9": {
      const rows: (string | number | null)[][] = [["Month", "Taxable outward (₹)", "Output tax (₹)", "Eligible ITC (₹)", "Bills not in GSTR-2B", "Cash payable (₹)"]];
      for (const m of months.filter((x) => monthEnd(x) <= asOf || x === asOf.slice(0, 7))) {
        const out = outwardFor(l, m);
        const itc = itcFor(l, m);
        const pay = setOff(out, itc.eligible).payable;
        rows.push([m, r2(out.taxablePaise), r2(out.igstPaise + out.cgstPaise + out.sgstPaise), r2(itc.eligible.igstPaise + itc.eligible.cgstPaise + itc.eligible.sgstPaise), itc.notIn2b.length, r2(pay.totalPaise)]);
      }
      return paper(name(o.form.replace(/\s/g, "")), rows);
    }
    case "advance-tax": {
      const est = estimateTax(l, p);
      return paper(name("Advance_tax"), [
        ["Line", "Amount (₹)", "Note"],
        ["Profit for the year, estimated", r2(est.profitPaise), est.basis],
        ["Tax for the year", r2(est.taxPaise), "22% plus 10% surcharge and 4% cess"],
        ["This instalment", r2(o.amountPaise ?? 0), o.title],
      ]);
    }
    case "msme1": {
      const rows: (string | number | null)[][] = [["Supplier", "Udyam number", "Category", "Bill", "Bill date", "Days allowed", "Amount (₹)", "Unpaid now (₹)", "Days since bill", "Reason for delay"]];
      for (const b of l.payableBills) {
        const party = l.party(b.partyId);
        if (!msmeProtected(party) || !months.includes(b.date.slice(0, 7))) continue;
        const open = billOpenPaise(l, b);
        rows.push([party.name, party.udyamNumber ?? "", party.udyamCategory ?? "", b.number, b.date, msmeLimitDays(party), r2(b.totals.totalPaise), r2(open), Math.round((Date.parse(asOf) - Date.parse(b.date)) / 86_400_000), ""]);
      }
      return paper(name("MSME-1"), rows);
    }
    case "dpt3":
      return paper(name("DPT-3"), [["Lender", "Kind", "Amount (₹)", "Taken on", "Secured", "Repaid on"], ...p.loans.map((x) => [x.lender, x.kind.replace("_", " "), r2(x.amountPaise), x.takenOn, x.secured ? "Yes" : "No", x.closedOn ?? ""])]);
    case "aoc4":
      return paper(name("AOC-4"), [
        ["Field", "Value"],
        ["CIN", p.cin],
        ["Company", books.business.legalName],
        ["Financial year", `${fyLabel(fyFromLabel(o.period))} (1 April ${fyFromLabel(o.period)} to 31 March ${fyFromLabel(o.period) + 1})`],
        ["Turnover, previous year (₹)", r2(books.business.prevYearTurnoverPaise)],
        ["Paid-up capital (₹)", p.paidUpCapitalPaise === null ? "" : r2(p.paidUpCapitalPaise)],
        ["Auditor", p.auditor],
        ["Books of account kept in electronic form with", BOOKS_PROVIDER.name],
        ["Service provider's address", BOOKS_PROVIDER.address],
        ["Where the books are kept", BOOKS_PROVIDER.servers],
        ["Backup in India", BOOKS_PROVIDER.backup],
        ...books.parties.filter((x) => x.related).map((x) => ["Related party (AOC-2)", x.name]),
      ]);
    case "mgt7": {
      const g = (k: string) => p.shareholders.filter((s) => s.gender === k).length;
      return paper(name(o.form), [
        ["Field", "Value"],
        ["CIN", p.cin],
        ["Shareholders", p.shareholders.length],
        ["Of whom men / women / other / companies", `${g("male")} / ${g("female")} / ${g("other")} / ${g("entity")}`],
        ["Directors", p.directors.map((d) => `${d.name} (${d.din})`).join("; ")],
        ["Board meetings in the year", p.boardMeetings.filter((d) => months.includes(d.slice(0, 7))).join("; ")],
        ["AGM held on", p.agms.find((a) => a.fy === o.period)?.heldOn ?? p.plannedAgmOn ?? ""],
        ...p.shareholders.map((s) => [`Shareholder: ${s.name}`, `${s.shares} shares${s.foreign ? ", outside India" : ""}`]),
      ]);
    }
    default:
      return paper(name(o.form.replace(/\s/g, "")), [
        ["Item", o.title],
        ["Due", o.dueOn],
        ["Amount (₹)", o.amountPaise === null ? "" : r2(o.amountPaise)],
        ["Why", o.why],
        ...o.documents.map((d) => ["Document", d]),
      ]);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const amountOf = (s: string) => {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Labels on the MCA's "View company master data" page, and what we call them. */
const MASTER_LABELS: [RegExp, string][] = [
  [/^cin$|^llpin|corporate identification/i, "cin"],
  [/company name/i, "name"],
  [/roc (name|code)/i, "roc"],
  [/registered address|registered office/i, "address"],
  [/email/i, "email"],
  [/authori[sz]ed capital/i, "authorised"],
  [/paid[- ]?up capital/i, "paidUp"],
  [/company status/i, "status"],
  [/date of last agm/i, "lastAgm"],
  [/date of (latest )?balance sheet/i, "balanceSheet"],
  [/date of incorporation/i, "incorporated"],
  [/active compliance/i, "activeCompliance"],
];

/** Reads master data copied from the MCA portal: "Label: value" or label and value on the same line separated by tabs. */
export function parseMasterData(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([^:\t]+?)\s*(?::|\t+)\s*(.*)$/.exec(line);
    const label = m ? m[1]! : line;
    let value = m ? m[2]! : "";
    if (!value && i + 1 < lines.length && !MASTER_LABELS.some(([re]) => re.test(lines[i + 1]!))) value = lines[i + 1]!;
    const key = MASTER_LABELS.find(([re]) => re.test(label))?.[1];
    if (key && value && !(key in fields)) fields[key] = value.trim();
  }
  const dins = [...text.matchAll(/\b(\d{8})\b/g)].map((x) => x[1]!);
  if (dins.length) fields.dins = [...new Set(dins)].join(",");
  return fields;
}

/** The master data against the profile, row by row. */
export function masterChecks(books: Books, p: ComplianceProfile): MasterCheck[] {
  const f = p.masterData?.fields ?? {};
  if (!p.masterData) return [];
  const rows: MasterCheck[] = [];
  const add = (field: string, portal: string | undefined, office: string, ok: boolean, note: string) => rows.push({ field, portal: portal ?? "Not shown", office, ok, note });
  add("CIN", f.cin, p.cin, norm(f.cin ?? "") === norm(p.cin), "Must match exactly.");
  add("Name", f.name, books.business.legalName, norm(f.name ?? "") === norm(books.business.legalName), "The name on every form comes from the master data.");
  add("Status", f.status, "Active", /^active$/i.test(f.status ?? ""), "Forms other than those to revive the company cannot be filed unless it is Active.");
  if (f.activeCompliance) add("Active compliance", f.activeCompliance, "ACTIVE Compliant", /compliant/i.test(f.activeCompliance) && !/non/i.test(f.activeCompliance), "Set by the INC-22A filing.");
  if (f.roc || p.roc) add("ROC", f.roc, p.roc, !p.roc || norm(f.roc ?? "").includes(norm(p.roc).slice(0, 6)), "The ROC mapping changed on 16 February 2026; use what the portal shows.");
  if (f.address || p.registeredOffice) add("Registered office", f.address, p.registeredOffice, norm(f.address ?? "").slice(0, 20) === norm(p.registeredOffice).slice(0, 20), "A change needs INC-22 first.");
  if (f.authorised || p.authorisedCapitalPaise) add("Authorised capital", f.authorised, p.authorisedCapitalPaise ? `₹${(p.authorisedCapitalPaise / 100).toLocaleString("en-IN")}` : "", amountOf(f.authorised ?? "") === p.authorisedCapitalPaise, "Changes need SH-7.");
  if (f.paidUp || p.paidUpCapitalPaise !== null) add("Paid-up capital", f.paidUp, p.paidUpCapitalPaise !== null ? `₹${(p.paidUpCapitalPaise / 100).toLocaleString("en-IN")}` : "", amountOf(f.paidUp ?? "") === p.paidUpCapitalPaise, "A difference usually means a PAS-3 was missed.");
  if (f.email) add("Email", f.email, books.business.email, norm(f.email) === norm(books.business.email), "The ROC's notices go here.");
  const lastAgm = [...p.agms].sort((a, b) => (a.heldOn < b.heldOn ? 1 : -1))[0];
  if (f.lastAgm || lastAgm) add("Last AGM", f.lastAgm, lastAgm?.heldOn ?? "", Boolean(f.lastAgm && lastAgm && dateMatches(f.lastAgm, lastAgm.heldOn)), "Updates when AOC-4 or MGT-7 for that year is approved.");
  const dins = (f.dins ?? "").split(",").filter(Boolean);
  for (const d of p.directors) add(`Director ${d.name}`, dins.includes(d.din) ? d.din : "Not on the portal", d.din, dins.includes(d.din), "A director not on the portal needs DIR-12.");
  return rows;
}

function dateMatches(portal: string, iso: string): boolean {
  const [y, m, d] = iso.split("-");
  return portal.includes(iso) || portal.replace(/[^0-9]/g, "") === `${d}${m}${y}`;
}

const STEPS = [
  "Sign in to the MCA V3 portal with the Business User login of the director or professional who will sign.",
  "Check the company's master data matches the office (the table above); fix anything first, or the form will be rejected.",
  "Open the web form, enter the values below and attach the documents listed.",
  "Sign with the DSC of a director whose DIN is active and whose DSC is associated with their login; the professional certifies where the form asks.",
  "Pay the fee and note the SRN here. Straight-through forms are approved at once; others go to the ROC.",
  "If the ROC asks for changes, resubmit within the time it gives (usually 15 days) under the same SRN.",
];

/** Everything needed to file one MCA form: master data, values, attachments, who can sign, and the SRN. */
export function filingPack(books: Books, obligationId: string, asOf = books.business.asOf): FilingPack | null {
  const o = buildObligations(books, asOf).find((x) => x.id === obligationId);
  if (!o || !o.mca) return null;
  const p = profileOf(books);
  const master = masterChecks(books, p);
  const prefill = prefillFor(books, p, o);
  const signers = p.directors.map((d) => {
    const problems: string[] = [];
    if (!/^\d{8}$/.test(d.din)) problems.push("no DIN recorded");
    if (!d.dscExpiresOn) problems.push("DSC expiry not recorded");
    else if (d.dscExpiresOn < o.dueOn) problems.push(`DSC expires ${dateLabel(d.dscExpiresOn)}, before the due date`);
    if (kycDue(d, asOf) < asOf) problems.push("DIR-3 KYC overdue, so the DIN is deactivated");
    if (!d.mcaSigner) problems.push("not set up to sign on the portal");
    return { name: d.name, din: d.din, ok: problems.length === 0, note: problems.length ? problems.join("; ") : `Can sign; DSC valid to ${dateLabel(d.dscExpiresOn!)}.` };
  });
  return {
    obligationId: o.id,
    form: o.form,
    title: o.title,
    dueOn: o.dueOn,
    master: { checkedOn: p.masterData?.checkedOn ?? null, rows: master, status: p.masterData?.fields.status ?? null },
    prefill,
    attachments: o.documents.map((d) => ({ name: d, note: "" })),
    signers,
    srn: o.srn,
    steps: STEPS,
  };
}

function prefillFor(books: Books, p: ComplianceProfile, o: Obligation): FilingPack["prefill"] {
  const b = books.business;
  const rows: FilingPack["prefill"] = [
    { label: "CIN", value: p.cin, from: "Profile" },
    { label: "Company name", value: b.legalName, from: "Settings" },
  ];
  const rs = (paise: number | null) => (paise === null ? "" : `₹${(paise / 100).toLocaleString("en-IN")}`);
  switch (o.ruleId) {
    case "aoc4":
    case "csr2": {
      const fy = fyFromLabel(o.period);
      rows.push(
        { label: "Financial year", value: `1 April ${fy} to 31 March ${fy + 1}`, from: "Calendar" },
        { label: "AGM date", value: p.agms.find((a) => a.fy === o.period)?.heldOn ?? p.plannedAgmOn ?? "", from: "Profile" },
        { label: "Auditor", value: p.auditor, from: "Profile" },
        { label: "Turnover", value: rs(b.prevYearTurnoverPaise), from: "Settings" },
        { label: "Paid-up capital", value: rs(p.paidUpCapitalPaise), from: "Profile" },
        { label: "Books kept in electronic form: service provider", value: BOOKS_PROVIDER.name, from: "Rule 3(6)" },
        { label: "Service provider's address", value: BOOKS_PROVIDER.address, from: "Rule 3(6)" },
        { label: "Location of the servers", value: BOOKS_PROVIDER.servers, from: "Rule 3(6)" },
        { label: "Backup", value: BOOKS_PROVIDER.backup, from: "Rule 3(5)" },
      );
      break;
    }
    case "mgt7": {
      const g = (k: string) => p.shareholders.filter((s) => s.gender === k).length;
      const fy = fyFromLabel(o.period);
      rows.push(
        { label: "Shareholders (men / women / other / companies)", value: `${g("male")} / ${g("female")} / ${g("other")} / ${g("entity")}`, from: "Profile" },
        { label: "Directors", value: String(p.directors.length), from: "Profile" },
        { label: "Board meetings held", value: p.boardMeetings.filter((d) => d >= `${fy}-04-01` && d <= `${fy + 1}-03-31`).join(", "), from: "Profile" },
        { label: "AGM date", value: p.agms.find((a) => a.fy === o.period)?.heldOn ?? p.plannedAgmOn ?? "", from: "Profile" },
        { label: "Paid-up capital", value: rs(p.paidUpCapitalPaise), from: "Profile" },
        { label: "Turnover", value: rs(b.prevYearTurnoverPaise), from: "Settings" },
      );
      break;
    }
    case "dpt3": {
      for (const kind of ["director", "shareholder", "related_company", "bank", "nbfc", "other"] as const) {
        const sum = p.loans.filter((x) => x.kind === kind).reduce((a, x) => a + x.amountPaise, 0);
        if (sum) rows.push({ label: `Loans from ${kind.replace("_", " ")}s`, value: rs(sum), from: "Profile" });
      }
      break;
    }
    case "adt1":
    case "event-adt1":
      rows.push({ label: "Auditor", value: p.auditor, from: "Profile" }, { label: "Term ends with the AGM for", value: p.auditorTermEndsFy ?? "", from: "Profile" });
      break;
    case "dir3kyc": {
      const d = p.directors.find((x) => x.din === o.period || x.id === o.period);
      if (d) rows.push({ label: "Director", value: d.name, from: "Profile" }, { label: "DIN", value: d.din, from: "Profile" });
      break;
    }
    case "msme1":
      rows.push({ label: "Amount owed beyond 45 days", value: rs(o.amountPaise), from: "Books" });
      break;
    default: {
      const e = p.events.find((x) => x.id === o.period);
      if (e) rows.push({ label: "What happened", value: e.detail, from: "Profile" }, { label: "Date", value: e.on, from: "Profile" });
    }
  }
  return rows.filter((r) => r.value !== "");
}
