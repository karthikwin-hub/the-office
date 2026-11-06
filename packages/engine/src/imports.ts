import { type FiledReturn, Gstr1, Gstr2b, Gstr3b, type TdsReturnRow, TdsSection } from "@office/contracts";
import { quarterOf } from "./dates";
import { parseAmount, parseDate } from "./extract";
import type { Ledger } from "./ledger";
import { sectionFromCited, tdsReturnDue, tdsReturnForm } from "./tds";
import { gstDueDates } from "./gst";

/**
 * Reads what the accountant actually filed, in the formats they can download:
 * GSTR-1 and GSTR-3B JSON from the GST portal, GSTR-2B JSON, and 26Q deductions
 * as CSV (one row per deduction, as most TDS software exports them).
 */

export type Imported =
  | { kind: "return"; form: FiledReturn["form"]; period: string; filed: FiledReturn; summary: string }
  | { kind: "gstr2b"; period: string; statement: Gstr2b; summary: string };

export class ImportError extends Error {}

const periodOf = (fp: string) => {
  if (!/^\d{6}$/.test(fp)) throw new ImportError(`Return period "${fp}" should be MMYYYY.`);
  return `${fp.slice(2)}-${fp.slice(0, 2)}`;
};

/** Portal GSTR-2B nests invoices under each supplier with item-level tax; the Auditor wants one row per invoice. */
function flatten2b(raw: unknown): Gstr2b | null {
  const d = (raw as { data?: { gstin?: string; rtnprd?: string; docdata?: { b2b?: unknown[] } } }).data;
  if (!d?.docdata?.b2b || !d.rtnprd || !d.gstin) return null;
  const rows = d.docdata.b2b.flatMap((s) => {
    const sup = s as { ctin: string; trdnm?: string; inv?: { inum: string; dt?: string; idt?: string; val: number; items?: { txval: number; igst?: number; cgst?: number; sgst?: number }[]; txval?: number; iamt?: number; camt?: number; samt?: number }[]; inum?: string };
    if (!sup.inv) return [s as Gstr2b["data"]["docdata"]["b2b"][number]];
    return sup.inv.map((i) => {
      const items = i.items ?? [];
      const sum = (k: "txval" | "igst" | "cgst" | "sgst") => Math.round(items.reduce((a, x) => a + (x[k] ?? 0), 0) * 100) / 100;
      return { ctin: sup.ctin, trdnm: sup.trdnm ?? "", inum: i.inum, idt: i.dt ?? i.idt ?? "", val: i.val, txval: items.length ? sum("txval") : (i.txval ?? 0), iamt: items.length ? sum("igst") : (i.iamt ?? 0), camt: items.length ? sum("cgst") : (i.camt ?? 0), samt: items.length ? sum("sgst") : (i.samt ?? 0) };
    });
  });
  const parsed = Gstr2b.safeParse({ period: periodOf(d.rtnprd), data: { gstin: d.gstin, rtnprd: d.rtnprd, docdata: { b2b: rows } } });
  return parsed.success ? parsed.data : null;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
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

const COLUMNS: Record<keyof Omit<TdsReturnRow, "billId"> | "bill", RegExp> = {
  section: /^section/i,
  deducteePan: /pan/i,
  deducteeName: /^(deductee|name|party|vendor)(?!.*\bpan\b)/i,
  bill: /(bill|invoice)/i,
  paidOn: /(paid|payment|credit).*(on|date)|^date/i,
  amountPaidPaise: /^amount|amount paid|paid amount/i,
  tdsPaise: /^tds|tax deducted/i,
  depositedOn: /deposit/i,
};

function parse26q(l: Ledger, text: string): Imported {
  const [head, ...body] = parseCsv(text);
  if (!head) throw new ImportError("The CSV is empty.");
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, re]) => [k, head.findIndex((h) => re.test(h))])) as Record<keyof typeof COLUMNS, number>;
  const missing = Object.entries(at).filter(([k, i]) => i < 0 && k !== "deducteeName" && k !== "bill").map(([k]) => k);
  if (missing.length) throw new ImportError(`The TDS return CSV (Form 140 or 26Q) needs columns for ${missing.join(", ")}. Found: ${head.join(", ")}.`);
  const deductions: TdsReturnRow[] = body.map((r, n) => {
    const get = (k: keyof typeof COLUMNS) => (at[k] >= 0 ? (r[at[k]] ?? "") : "");
    const section = TdsSection.safeParse(sectionFromCited(get("section")));
    const paidOn = parseDate(get("paidOn"));
    const depositedOn = parseDate(get("depositedOn"));
    const amount = parseAmount(get("amountPaidPaise"));
    const tds = parseAmount(get("tdsPaise"));
    if (!section.success || !paidOn || !depositedOn || amount === null || tds === null) throw new ImportError(`Row ${n + 2} of the CSV could not be read.`);
    const pan = get("deducteePan").toUpperCase();
    const bill = l.books.bills.find((b) => b.number === get("bill") && l.party(b.partyId).pan === pan);
    return { section: section.data, deducteePan: pan, deducteeName: get("deducteeName") || (bill ? l.party(bill.partyId).name : pan), billId: bill?.id ?? "", paidOn, amountPaidPaise: amount, tdsPaise: tds, depositedOn };
  });
  if (!deductions.length) throw new ImportError("The CSV has a header but no deductions.");
  const quarter = quarterOf(deductions[0]!.paidOn);
  const filed: FiledReturn = { id: `26q-${quarter}`, form: "26Q", period: quarter, status: "filed", filedOn: null, sharedOn: null, dueOn: tdsReturnDue(quarter), filedBy: l.books.business.accountantFirm, data: { tan: l.books.business.tan, quarter, deductions } };
  const unmatched = deductions.filter((d) => !d.billId).length;
  return { kind: "return", form: "26Q", period: quarter, filed, summary: `${tdsReturnForm(quarter)}: ${deductions.length} deductions${unmatched ? `, ${unmatched} not matched to a bill` : ""}` };
}

export function importReturn(l: Ledger, content: string, filedOn: string | null): Imported {
  const text = content.trim().replace(/^\uFEFF/, "");
  if (!text.startsWith("{")) {
    const r = parse26q(l, text);
    if (r.kind === "return") r.filed.filedOn = filedOn;
    return r;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError("This is not valid JSON.");
  }
  const gstin = (raw as { gstin?: string; data?: { gstin?: string } }).gstin ?? (raw as { data?: { gstin?: string } }).data?.gstin;
  if (gstin && gstin !== l.books.business.gstin) throw new ImportError(`This return is for GSTIN ${gstin}, not ${l.books.business.gstin}.`);
  const base = (form: FiledReturn["form"], period: string) => ({ id: `${form.toLowerCase().replace("-", "")}-${period}`, period, status: "filed" as const, filedOn, sharedOn: null, filedBy: l.books.business.accountantFirm, dueOn: form === "GSTR-1" ? gstDueDates(period).gstr1 : gstDueDates(period).gstr3b });

  if ((raw as { sup_details?: unknown }).sup_details) {
    const p = Gstr3b.safeParse(raw);
    if (!p.success) throw new ImportError("This looks like GSTR-3B but is missing table 3.1 or 4.");
    const period = periodOf(p.data.ret_period);
    return { kind: "return", form: "GSTR-3B", period, filed: { ...base("GSTR-3B", period), form: "GSTR-3B", data: p.data }, summary: "Tables 3.1 and 4" };
  }
  if ((raw as { b2b?: unknown; fp?: unknown }).fp) {
    const p = Gstr1.safeParse(raw);
    if (!p.success) throw new ImportError("This looks like GSTR-1 but its B2B or HSN tables could not be read.");
    const period = periodOf(p.data.fp);
    const count = p.data.b2b.reduce((a, c) => a + c.inv.length, 0);
    return { kind: "return", form: "GSTR-1", period, filed: { ...base("GSTR-1", period), form: "GSTR-1", data: p.data }, summary: `${count} B2B invoices` };
  }
  const twoB = flatten2b(raw);
  if (twoB) return { kind: "gstr2b", period: twoB.period, statement: twoB, summary: `${twoB.data.docdata.b2b.length} supplier invoices` };
  throw new ImportError("This file is not a GSTR-1, GSTR-3B or GSTR-2B JSON, or a TDS return CSV (Form 140 or 26Q).");
}
