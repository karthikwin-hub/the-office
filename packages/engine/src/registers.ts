import {
  BILL_FIELD_LABEL,
  BillField,
  type BillMapping,
  type Document,
  missingBillFields,
  type Region,
  type SheetBillKind,
  type Totals,
} from "@office/contracts";
import { checkExtraction, type ExtractContext, type ExtractedLine, type Extraction, gstinValid } from "./extract";
import { pctOf } from "./money";
import { layoutKey } from "./sales/formats";
import { dateOf, norm, numberOf, paiseOf, stateOf } from "./sales/parse";

/**
 * Bills and invoices listed in a spreadsheet (a register): one bill per row, or one line per row with the bill's
 * number repeated or left blank under the first line, as Tally and most billing tools export them. Columns are
 * found by their headers, or as the owner confirmed them once; every amount is read from its cell or computed here,
 * never by a model (ADR 0010).
 */

export { layoutKey };

/** At most this many bills are read from one sheet; the rest are listed as skipped. */
export const MAX_REGISTER_BILLS = 500;
/** Rows kept with each bill to show where its figures came from. */
const MAX_ROWS_PER_BILL = 60;

/** Header names that usually mean each field, compared after `norm`. More specific names come first. */
const GUESS: Record<BillField, string[]> = {
  number: [
    "invoice no",
    "invoice number",
    "bill no",
    "bill number",
    "supplier invoice no",
    "supplier invoice number",
    "voucher no",
    "voucher number",
    "vch no",
    "inv no",
    "document no",
    "document number",
    "doc no",
    "invoice",
    "bill",
  ],
  date: ["invoice date", "bill date", "voucher date", "document date", "doc date", "invoice dt", "inv dt", "bill dt", "vch dt", "date", "dt"],
  party: [
    "supplier name",
    "name of supplier",
    "vendor name",
    "customer name",
    "name of customer",
    "buyer name",
    "party name",
    "ledger name",
    "trade name",
    "supplier",
    "vendor",
    "customer",
    "buyer",
    "party",
    "billed to",
    "particulars",
  ],
  gstin: [
    "gstin uin",
    "gstin",
    "supplier gstin",
    "customer gstin",
    "party gstin",
    "gstin of supplier",
    "gstin of recipient",
    "gst no",
    "gst number",
    "gstin no",
  ],
  placeOfSupply: ["place of supply", "pos", "state"],
  description: ["item description", "item name", "description of goods", "stock item", "product name", "item", "description", "product", "goods"],
  hsn: ["hsn sac", "hsn code", "hsn", "sac"],
  qty: ["quantity", "billed quantity", "billed qty", "qty"],
  unit: ["uqc", "uom", "unit"],
  rate: ["unit price", "rate per unit", "rate", "price"],
  taxable: ["taxable value", "taxable amount", "assessable value", "amount before tax", "value before tax", "basic amount", "taxable"],
  gstRate: ["gst rate", "tax rate", "rate of tax", "gst"],
  cgst: ["cgst amount", "central tax amount", "central tax", "cgst"],
  sgst: ["sgst amount", "sgst utgst amount", "state ut tax amount", "state tax amount", "state ut tax", "state tax", "sgst utgst", "sgst", "utgst"],
  igst: ["igst amount", "integrated tax amount", "integrated tax", "igst"],
  tax: ["total tax", "total gst", "tax amount", "gst amount", "tax"],
  total: ["invoice value", "invoice amount", "bill amount", "total amount", "grand total", "gross total", "net total", "line total", "item total", "total"],
};
const AMOUNT_FIELDS = new Set<BillField>(["taxable", "cgst", "sgst", "igst", "tax", "total"]);

/**
 * The columns that look like each field, from their names. Exact names are taken before names that only start with
 * one, and each column is used once, so "IGST Rate" is not taken for the IGST amount.
 */
export function guessBillMapping(headers: string[]): BillMapping {
  const ns = headers.map(norm);
  const used = new Set<number>();
  const out: BillMapping = {};
  const take = (f: BillField, i: number) => {
    out[f] = headers[i]!;
    used.add(i);
  };
  for (const f of Object.keys(GUESS) as BillField[]) {
    const i = GUESS[f].map((a) => ns.findIndex((h, k) => h === a && !used.has(k))).find((k) => k >= 0);
    if (i !== undefined) take(f, i);
  }
  for (const f of Object.keys(GUESS) as BillField[]) {
    if (out[f]) continue;
    for (const a of GUESS[f]) {
      const i = ns.findIndex((h, k) => !used.has(k) && h.startsWith(`${a} `) && !(AMOUNT_FIELDS.has(f) && /\b(rate|percent|pct)\b/.test(h)));
      if (i >= 0) {
        take(f, i);
        break;
      }
    }
  }
  return out;
}

/** How many of the fields a register needs these headers seem to have, out of four. */
export const registerScore = (m: BillMapping) => 4 - missingBillFields(m).length;

/** The header row: the one of the top rows whose names look most like a register's. */
export function findRegisterHeader(rows: string[][]): { at: number; mapping: BillMapping } {
  let best = { at: 0, mapping: {} as BillMapping, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const mapping = guessBillMapping(rows[i]!);
    const score = registerScore(mapping) * 10 + Object.keys(mapping).length;
    if (score > best.score) best = { at: i, mapping, score };
  }
  return { at: best.at, mapping: best.mapping };
}

/**
 * When the header names leave a field unfound, a language model may say which column holds it. It sees the header
 * row and three rows under it, and may only name headers that are there: it copies no figures.
 */
export function layoutPrompt(
  headers: string[],
  sample: string[][],
  business: { legalName: string; gstin: string },
): { system: string; user: string; schema: object } {
  const fields = BillField.options;
  const cols = headers.map((h) => h.slice(0, 80));
  return {
    system: [
      "You map the columns of a spreadsheet that lists Indian GST bills or invoices, for an accounts office. Answer only with JSON in the given schema.",
      `Our business is ${business.legalName}, GSTIN ${business.gstin}. If the rows are bills from suppliers, kind is purchase_bill; if they are invoices we issued, sales_invoice.`,
      `For each field, give the column header that holds it, copied exactly from this list, or null if no column holds it: ${JSON.stringify(cols)}.`,
      "Each header may be used for one field only. Never write a header that is not in the list, and never write a figure.",
      `The fields: ${fields.map((f) => `${f} (${BILL_FIELD_LABEL[f]})`).join(", ")}.`,
    ].join("\n"),
    user: [JSON.stringify(cols), ...sample.slice(0, 3).map((r) => JSON.stringify(r.slice(0, cols.length).map((c) => c.slice(0, 60))))].join("\n"),
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["purchase_bill", "sales_invoice"] },
        mapping: { type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: ["string", "null"] }])) },
      },
      required: ["kind", "mapping"],
    },
  };
}

/**
 * The model's answer, kept only where it names a real header not already taken; what the header names found stays.
 * Anything else in the answer is ignored.
 */
export function fromLayoutAnswer(answer: unknown, headers: string[], guess: BillMapping): { kind: SheetBillKind | null; mapping: BillMapping } {
  const a = (answer ?? {}) as { kind?: unknown; mapping?: Record<string, unknown> };
  const out: BillMapping = { ...guess };
  const used = new Set(Object.values(guess));
  for (const f of BillField.options) {
    const h = a.mapping?.[f];
    if (out[f] || typeof h !== "string" || !headers.includes(h) || used.has(h)) continue;
    out[f] = h;
    used.add(h);
  }
  return { kind: a.kind === "purchase_bill" || a.kind === "sales_invoice" ? a.kind : null, mapping: out };
}

/** Purchase or sales, from the headers and any title rows above them; purchases when nothing says. */
export function registerKind(rows: string[][], headerAt: number, file: string): SheetBillKind {
  const text = [file, ...rows.slice(0, headerAt + 1).flat()].join(" ").toLowerCase();
  if (/\b(sales register|sales invoices?|customer|buyer|recipient|billed to|outward)\b/.test(text)) return "sales_invoice";
  return "purchase_bill";
}

const partyFor = (ctx: ExtractContext, kind: "vendor" | "customer", gstin: string | null, name: string | null) =>
  (gstin && ctx.parties.find((p) => p.gstin === gstin)) ||
  (name ? ctx.parties.find((p) => p.kind === kind && p.name.toLowerCase() === name.toLowerCase()) : undefined) ||
  null;

/**
 * A bill read earlier in the same file may have added its supplier to the books: match the party again, just before
 * staging, so one new supplier is added once and the duplicate check sees the bills already staged.
 */
export function rematch(e: Extraction, ctx: ExtractContext): Extraction {
  if (e.partyId) return e;
  const party = partyFor(ctx, e.kind === "purchase_bill" ? "vendor" : "customer", e.partyGstin, e.partyName);
  if (!party) return e;
  const out = { ...e, partyId: party.id, partyName: party.name };
  out.checks = [...checkExtraction(out, ctx), ...e.checks.filter((c) => c.key === "rows")];
  // A party another bill in this file added is not known yet: the check says so until the owner approves it.
  if (party.id.endsWith("-new"))
    out.checks = out.checks.map((c) => (c.key === "party" ? { ...c, ok: false, detail: `${party.name} is new: another bill from this file adds them.` } : c));
  return out;
}

export type RegisterBill = {
  extraction: Extraction;
  /** The rows it was read from, for `Document.sheet`. */
  sheet: NonNullable<Document["sheet"]>;
};
export type RegisterSkip = { row: number; reason: string };

const GST_RATES = [0, 3, 5, 12, 18, 28, 40];
const TOTAL_ROW = /^\s*(grand\s+)?(sub\s*)?totals?\b/i;

/**
 * Reads every bill in a sheet with the columns the owner confirmed. Rows with the same number and party are one bill;
 * a row with no number, under a bill, is another line of it. Each bill is checked exactly as a PDF bill is.
 */
export function readRegister(input: { name: string; rows: string[][]; headerAt: number; mapping: BillMapping; kind: SheetBillKind; ctx: ExtractContext }): {
  bills: RegisterBill[];
  skipped: RegisterSkip[];
} {
  const { rows, headerAt, mapping, kind, ctx } = input;
  const headers = rows[headerAt] ?? [];
  const col = Object.fromEntries(
    (Object.keys(mapping) as BillField[]).map((f) => [f, headers.indexOf(mapping[f]!)]).filter(([, i]) => (i as number) >= 0),
  ) as Partial<Record<BillField, number>>;
  const cell = (r: string[], f: BillField) => (col[f] === undefined ? undefined : (r[col[f]!] ?? "").trim());
  const skipped: RegisterSkip[] = [];
  type Group = { key: string; rows: { n: number; cells: string[] }[] };
  const groups = new Map<string, Group>();
  let last: Group | null = null;

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const n = i + 1;
    if (!r.some((c) => c.trim())) continue;
    // A total row says so in its first cell, or where the number or party would be; an item may be called "Total …".
    const first = r.findIndex((c) => c.trim());
    if ([first === col.description ? undefined : r[first], cell(r, "number"), cell(r, "party")].some((c) => c && TOTAL_ROW.test(c))) {
      skipped.push({ row: n, reason: "a total row" });
      last = null;
      continue;
    }
    const number = cell(r, "number");
    const amount = paiseOf(cell(r, "taxable")) ?? paiseOf(cell(r, "total"));
    if (!number) {
      // Tally prints the number on a bill's first line only.
      if (last && amount !== null) last.rows.push({ n, cells: r });
      else skipped.push({ row: n, reason: "no bill number" });
      continue;
    }
    if (amount === null) {
      skipped.push({ row: n, reason: "no taxable value or total" });
      continue;
    }
    const who = (cell(r, "gstin") || cell(r, "party") || "").toUpperCase();
    const key = `${norm(number)}|${norm(who)}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= MAX_REGISTER_BILLS) {
        skipped.push({ row: n, reason: `more than ${MAX_REGISTER_BILLS} bills in one sheet; send the rest in another file` });
        continue;
      }
      g = { key, rows: [] };
      groups.set(key, g);
    }
    g.rows.push({ n, cells: r });
    last = g;
  }

  const own = new Set([ctx.business.gstin, ...(ctx.business.otherGstins ?? [])].filter(Boolean));
  const partyKind = kind === "purchase_bill" ? "vendor" : "customer";
  const bills: RegisterBill[] = [];
  for (const g of groups.values()) {
    const kept = g.rows.slice(0, MAX_ROWS_PER_BILL);
    const first = kept[0]!.cells;
    const regions: Region[] = [];
    const at = (key: string, label: string, f: BillField, row: number) => {
      if (col[f] !== undefined && (kept[row]?.cells[col[f]!] ?? "").trim())
        regions.push({ key, label, page: 1, box: [0, 0, 0, 0], cell: { row, col: col[f]! } });
    };
    const firstOf = (f: BillField) => kept.map((x) => cell(x.cells, f)).find((v) => v) ?? null;
    const number = cell(first, "number") || null;
    const date = dateOf(firstOf("date") ?? undefined);
    const read = firstOf("gstin")
      ?.toUpperCase()
      .replace(/[^0-9A-Z]/g, "");
    const gstin = read && !own.has(read) ? read : null;
    const name = firstOf("party");
    const party = partyFor(ctx, partyKind, gstin, name);
    const partyState = (gstin && gstinValid(gstin) ? gstin.slice(0, 2) : null) ?? party?.stateCode ?? null;
    const placeOfSupply =
      stateOf(firstOf("placeOfSupply") ?? undefined) ?? (kind === "purchase_bill" ? ctx.business.stateCode : (partyState ?? ctx.business.stateCode));
    const printed = (f: BillField) => kept.reduce((a, x) => a + (paiseOf(cell(x.cells, f)) ?? 0), 0);
    const hasSplit = col.cgst !== undefined || col.sgst !== undefined || col.igst !== undefined;
    // What the sheet charged decides the split when it shows one; otherwise the states do, as for a PDF bill.
    const intra = hasSplit
      ? printed("igst") === 0
      : (kind === "purchase_bill" ? (partyState ?? ctx.business.stateCode) : placeOfSupply) === ctx.business.stateCode;

    at("number", kind === "purchase_bill" ? "Bill number" : "Invoice number", "number", 0);
    at("date", "Date", "date", 0);
    at("party", kind === "purchase_bill" ? "Supplier" : "Customer", "party", 0);
    at("gstin", kind === "purchase_bill" ? "Supplier GSTIN" : "Customer GSTIN", "gstin", 0);

    const rowTotals = kept.map((x) => paiseOf(cell(x.cells, "total")));
    const rateOf = (c: string[]) => {
      const raw = numberOf(cell(c, "gstRate")?.replace("%", ""));
      // A cell formatted as a percentage in Excel holds 0.18 for 18%.
      return raw !== null && raw > 0 && raw < 1 ? raw * 100 : raw;
    };
    const taxOf = (c: string[]) =>
      hasSplit && [cell(c, "cgst"), cell(c, "sgst"), cell(c, "igst")].some((v) => v)
        ? (paiseOf(cell(c, "cgst")) ?? 0) + (paiseOf(cell(c, "sgst")) ?? 0) + (paiseOf(cell(c, "igst")) ?? 0)
        : paiseOf(cell(c, "tax"));
    // Equal totals on every line are each line's own when its tax is its GST rate on that total less the tax;
    // otherwise they are the bill's total, printed on each of its lines.
    const ownTotal = (x: (typeof kept)[number], t: number) => {
      const tax = taxOf(x.cells);
      if (tax === null || t - tax <= 0) return false;
      const rate = rateOf(x.cells) ?? (tax * 100) / (t - tax);
      return GST_RATES.some((r) => Math.abs(r - rate) <= 0.5) && Math.abs(pctOf(t - tax, Math.round(rate) * 100) - tax) <= 100;
    };
    const repeated =
      kept.length > 1 &&
      rowTotals.every((t) => t !== null && t === rowTotals[0]) &&
      !(col.taxable === undefined && kept.every((x) => ownTotal(x, rowTotals[0]!)));
    const lines: ExtractedLine[] = kept.map((x, k) => {
      const c = x.cells;
      const rowTax = taxOf(c);
      const rowTotal = paiseOf(cell(c, "total"));
      // Without a taxable column, a line's own total less its tax; a repeated bill total says nothing about the line.
      const taxable = paiseOf(cell(c, "taxable")) ?? (rowTotal !== null && !repeated ? rowTotal - (rowTax ?? 0) : 0);
      const printedRate = rateOf(c);
      const implied = rowTax !== null && taxable > 0 ? (rowTax * 100) / taxable : null;
      const gstRate =
        printedRate !== null ? Math.round(printedRate) : implied !== null ? (GST_RATES.find((r) => Math.abs(r - implied) <= 0.5) ?? Math.round(implied)) : 0;
      const half = pctOf(taxable, gstRate * 50);
      const qty = Math.max(1, Math.round(numberOf(cell(c, "qty")) ?? 1));
      const description = cell(c, "description") || `Line ${k + 1}`;
      const sku = ctx.skus.find((s) => s.name.toLowerCase() === description.toLowerCase()) ?? null;
      const unit = (cell(c, "unit") || (col.qty === undefined ? "OTH" : "NOS")).toUpperCase().slice(0, 3);
      at(`line.${k}.description`, `Line ${k + 1} description`, "description", k);
      at(`line.${k}.qty`, `Line ${k + 1} quantity`, "qty", k);
      at(`line.${k}.taxable`, `Line ${k + 1} taxable value`, col.taxable !== undefined ? "taxable" : "total", k);
      at(`line.${k}.rate`, `Line ${k + 1} GST rate`, "gstRate", k);
      at(`line.${k}.tax`, `Line ${k + 1} tax`, hasSplit ? (intra ? "cgst" : "igst") : "tax", k);
      return {
        skuId: sku?.id ?? null,
        description,
        hsn: (cell(c, "hsn") || sku?.hsn || "").replace(/\s/g, ""),
        qty,
        unit,
        ratePaise: paiseOf(cell(c, "rate")) ?? Math.round(taxable / qty),
        discountPct: 0,
        taxablePaise: taxable,
        gstRate,
        cgstPaise: intra ? half : 0,
        sgstPaise: intra ? half : 0,
        igstPaise: intra ? 0 : pctOf(taxable, gstRate * 100),
        printedTaxPaise: rowTax ?? (intra ? 2 * half : pctOf(taxable, gstRate * 100)),
      };
    });

    const taxable = lines.reduce((a, l) => a + l.taxablePaise, 0);
    const lineTax = lines.reduce((a, l) => a + l.printedTaxPaise, 0);
    const totals: Totals = { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, totalPaise: 0 };
    if (hasSplit) Object.assign(totals, { cgstPaise: printed("cgst"), sgstPaise: printed("sgst"), igstPaise: printed("igst") });
    else if (intra) Object.assign(totals, { cgstPaise: Math.floor(lineTax / 2), sgstPaise: lineTax - Math.floor(lineTax / 2) });
    else totals.igstPaise = lineTax;
    const tax = totals.cgstPaise + totals.sgstPaise + totals.igstPaise;
    if (col.total === undefined || rowTotals.every((t) => t === null)) totals.totalPaise = taxable + tax;
    else {
      // A total repeated on every line is the bill's total when it adds up to the lines; equal line totals are summed.
      const billTotal = kept.length === 1 || (repeated && (col.taxable === undefined || Math.abs(rowTotals[0]! - (taxable + tax)) <= 100));
      totals.totalPaise = billTotal ? rowTotals[0]! : rowTotals.reduce<number>((a, t) => a + (t ?? 0), 0);
      at("totals.total", kind === "purchase_bill" ? "Bill total" : "Invoice total", "total", 0);
      const diff = totals.totalPaise - (taxable + tax);
      if (Math.abs(diff) <= 100) totals.roundOffPaise = diff;
    }

    const e: Extraction = {
      kind,
      docType: "invoice",
      registration: null,
      number,
      date,
      partyName: party?.name ?? name,
      partyGstin: gstin,
      partyId: party?.id ?? null,
      placeOfSupply,
      intra,
      lines,
      totals,
      regions,
      checks: [],
      method: "sheet",
    };
    e.checks = checkExtraction(e, ctx);
    if (g.rows.length > kept.length) {
      e.checks.push({ key: "rows", label: "Every row read", ok: false, detail: `Only the first ${MAX_ROWS_PER_BILL} of ${g.rows.length} lines were read.` });
    }
    bills.push({
      extraction: e,
      sheet: {
        name: input.name.slice(0, 200),
        headers: headers.slice(0, 200).map((h) => h.slice(0, 200)),
        rows: kept.map((x) => ({ n: x.n, cells: x.cells.slice(0, 200).map((v) => v.slice(0, 500)) })),
      },
    });
  }
  return { bills, skipped };
}
