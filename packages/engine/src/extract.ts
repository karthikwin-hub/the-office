import type { Books, Line, Party, Region, Totals } from "@office/contracts";
import { pctOf } from "./money";

/**
 * Reads a GST invoice from its text layer. Positions are fractions of the page
 * with the origin at the top left, as the source viewer draws them, so every
 * field keeps the box it was read from.
 */

export type TextItem = { str: string; page: number; x: number; y: number; w: number; h: number };

export type Check = { key: string; label: string; ok: boolean; detail: string };

export type ExtractedLine = Line & { printedTaxPaise: number };

export type Extraction = {
  kind: "purchase_bill" | "sales_invoice";
  number: string | null;
  date: string | null;
  partyName: string | null;
  partyGstin: string | null;
  partyId: string | null;
  placeOfSupply: string | null;
  /** supplier and recipient in the same state, so CGST and SGST rather than IGST */
  intra: boolean;
  lines: ExtractedLine[];
  totals: Totals;
  regions: Region[];
  checks: Check[];
  /** "rules" when read from the layout alone, "model" when a language model located the fields */
  method: "rules" | "model";
};

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTIN check character (CBIC algorithm: base-36 weighted sum of the first 14 characters). */
export function gstinValid(g: string): boolean {
  if (!GSTIN_RE.test(g) || g.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g[i]!) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14];
}

/** "1,93,070.14", "₹ 25,31,364", "Rs. 12.5", "(0.03)" to paise; null if not an amount. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/₹|Rs\.?|INR/gi, "").replace(/\s/g, "");
  const m = /^(\()?(-)?(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?(\))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[3]!.replace(/,/g, ""));
  const frac = Number((m[4] ?? "0").padEnd(2, "0"));
  const neg = Boolean(m[2]) || (Boolean(m[1]) && Boolean(m[5]));
  return (neg ? -1 : 1) * (whole * 100 + frac);
}

/** "02 Nov 2026", "2 November 2026", "02/11/2026", "02-11-2026", "2026-11-02" to ISO. */
export function parseDate(s: string): string | null {
  const t = s.trim().replace(/,/g, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}

type Row = { page: number; y: number; items: TextItem[] };

/** Rows share a baseline; the bottom of each box tracks it across font sizes. */
function rows(items: TextItem[]): Row[] {
  const bottom = (i: TextItem) => i.y + i.h;
  const sorted = [...items].filter((i) => i.str.trim()).sort((a, b) => a.page - b.page || bottom(a) - bottom(b) || a.x - b.x);
  const out: (Row & { bottom: number })[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last.page === it.page && Math.abs(last.bottom - bottom(it)) < 0.005) last.items.push(it);
    else out.push({ page: it.page, y: it.y, bottom: bottom(it), items: [it] });
  }
  for (const r of out) {
    r.items.sort((a, b) => a.x - b.x);
    r.y = Math.min(...r.items.map((i) => i.y));
  }
  return out;
}

/** Boxes carry 2.5 pt of padding each side; a gap under a space's width joins two runs into one phrase. */
const PAD_X = 5 / 595.28;
const WORD_GAP = 0.011;

function phrases(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const r of rows(items)) {
    let cur: TextItem | null = null;
    for (const it of r.items) {
      const gap: number = cur ? it.x - (cur.x + cur.w) + PAD_X : Infinity;
      if (cur && gap < WORD_GAP) {
        const x1 = Math.max(cur.x + cur.w, it.x + it.w);
        const y0 = Math.min(cur.y, it.y);
        const y1 = Math.max(cur.y + cur.h, it.y + it.h);
        cur = { str: `${cur.str}${gap > 0.001 && !cur.str.endsWith(" ") && !it.str.startsWith(" ") ? " " : ""}${it.str}`, page: it.page, x: cur.x, y: y0, w: x1 - cur.x, h: y1 - y0 };
        out[out.length - 1] = cur;
      } else {
        cur = { ...it };
        out.push(cur);
      }
    }
  }
  return out;
}

const box = (items: TextItem[]): [number, number, number, number] => {
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + i.w));
  const y1 = Math.max(...items.map((i) => i.y + i.h));
  const r = (n: number) => Math.round(n * 100000) / 100000;
  return [r(x0), r(y0), r(x1 - x0), r(y1 - y0)];
};

const right = (i: TextItem) => i.x + i.w;

/** The value printed under a label, or after it on the same line. */
function valueFor(all: TextItem[], label: TextItem): TextItem | null {
  const inline = /[:#]\s*(.+)$/.exec(label.str);
  if (inline && inline[1]!.trim()) return label;
  const below = all
    .filter((i) => i !== label && i.page === label.page && i.y > label.y + 0.002 && i.y - label.y < 0.035 && Math.abs(i.x - label.x) < 0.03)
    .sort((a, b) => a.y - b.y)[0];
  if (below) return below;
  return all.filter((i) => i !== label && i.page === label.page && Math.abs(i.y - label.y) < 0.005 && i.x > right(label)).sort((a, b) => a.x - b.x)[0] ?? null;
}

const inlineValue = (i: TextItem) => (/[:#]\s*(.+)$/.exec(i.str)?.[1] ?? i.str).trim();

export type ExtractContext = Pick<Books, "business" | "parties" | "skus" | "bills" | "invoices">;

export function extractInvoice(items: TextItem[], ctx: ExtractContext): Extraction {
  const all = phrases(items).map((i) => ({ ...i, str: i.str.replace(/\s+/g, " ").trim() }));
  const lines = rows(all);
  const regions: Region[] = [];
  const region = (key: string, label: string, its: TextItem[]) => {
    if (its.length) regions.push({ key, label, page: its[0]!.page, box: box(its) });
  };
  const ours = ctx.business.gstin;

  const gstins = all.flatMap((i) => {
    const m = GSTIN_RE.exec(i.str);
    return m ? [{ item: i, gstin: m[1]! }] : [];
  });
  const firstGstin = gstins.sort((a, b) => a.item.page - b.item.page || a.item.y - b.item.y)[0];
  const billedTo = all.find((i) => /^(billed to|bill to|buyer|recipient)\b/i.test(i.str.trim()));
  const billedToValue = billedTo ? valueFor(all, billedTo) : null;
  const isUs = (t: string) => [ctx.business.legalName, ctx.business.name].some((n) => t.trim().toLowerCase().startsWith(n.toLowerCase()));
  const kind: Extraction["kind"] = billedToValue ? (isUs(billedToValue.str) ? "purchase_bill" : "sales_invoice") : firstGstin?.gstin === ours ? "sales_invoice" : "purchase_bill";
  const other = gstins.find((g) => g.gstin !== ours) ?? null;
  const partyGstin = other?.gstin ?? null;

  const partyKind = kind === "purchase_bill" ? "vendor" : "customer";
  const masthead = kind === "purchase_bill" ? lines[0]?.items[0] : undefined;
  const pans = all.flatMap((i) => [...i.str.matchAll(/\b([A-Z]{5}\d{4}[A-Z])\b/g)].map((m) => m[1]!)).filter((p) => p !== ctx.business.pan);
  const party: Party | null =
    (partyGstin && ctx.parties.find((p) => p.gstin === partyGstin)) ||
    ctx.parties.find((p) => p.kind === partyKind && !p.gstin && pans.includes(p.pan)) ||
    (masthead && ctx.parties.find((p) => p.kind === partyKind && p.name.toLowerCase() === masthead.str.toLowerCase())) ||
    null;
  let partyName = party?.name ?? null;
  if (kind === "purchase_bill") {
    if (masthead) {
      partyName ??= masthead.str;
      region("party", "Supplier", [masthead]);
    }
  } else {
    const v = billedToValue;
    if (v) {
      partyName ??= v.str.trim();
      region("party", "Customer", [v]);
    }
  }
  if (other) region("gstin", kind === "purchase_bill" ? "Supplier GSTIN" : "Customer GSTIN", [other.item]);

  const numberLabel = all.find((i) => /^(tax\s+)?(bill|invoice|inv)\.?\s*(no|number|#)\.?\s*[:#]?/i.test(i.str.trim()));
  const numberItem = numberLabel ? valueFor(all, numberLabel) : null;
  const number = numberItem ? inlineValue(numberItem) : null;
  if (numberItem) region("number", kind === "purchase_bill" ? "Bill number" : "Invoice number", [numberItem]);

  const dateLabel = all.find((i) => /^((invoice|bill)\s+)?date\s*:?/i.test(i.str.trim()) && !/due/i.test(i.str));
  const dateItem = dateLabel ? valueFor(all, dateLabel) : null;
  let date = dateItem ? parseDate(inlineValue(dateItem)) : null;
  if (dateItem && date) region("date", kind === "purchase_bill" ? "Bill date" : "Invoice date", [dateItem]);
  if (!date) {
    const any = all.find((i) => parseDate(i.str));
    if (any) {
      date = parseDate(any.str);
      region("date", "Date", [any]);
    }
  }

  // Goods bought are supplied where we receive them; IGST turns on the supplier's state.
  const posItem = all.some((l) => /place of supply/i.test(l.str)) ? all.find((i) => /\((\d{2})\)\s*$/.test(i.str)) : undefined;
  const printedPos = posItem ? /\((\d{2})\)\s*$/.exec(posItem.str)![1]! : null;
  if (posItem) region("pos", "Place of supply", [posItem]);
  const partyState = partyGstin?.slice(0, 2) ?? party?.stateCode ?? null;
  const placeOfSupply = printedPos ?? (kind === "purchase_bill" ? ctx.business.stateCode : (partyState ?? ctx.business.stateCode));
  const intra = kind === "purchase_bill" ? (partyState ?? ctx.business.stateCode) === ctx.business.stateCode : placeOfSupply === ctx.business.stateCode;

  // Line table: the header row names an HSN column; rows run until the totals.
  const headIdx = lines.findIndex((r) => r.items.some((i) => /^hsn/i.test(i.str.trim())));
  const extracted: ExtractedLine[] = [];
  let tableEnd = headIdx;
  if (headIdx >= 0) {
    const head = lines[headIdx]!.items;
    const col = (re: RegExp) => head.find((i) => re.test(i.str.trim()));
    const cHsn = col(/^hsn/i)!;
    const cQty = col(/^(qty|quantity)$/i);
    const cRate = col(/^rate$/i);
    const cDisc = col(/^disc/i);
    const cTaxable = col(/^(taxable|amount|value)/i);
    const cGst = col(/^(gst|gst %|rate %|tax rate)$/i);
    const cTax = head.filter((i) => /^(tax|tax amt|tax amount)$/i.test(i.str.trim())).pop();
    const cDesc = col(/^(description|item|particulars)/i);
    const near = (it: TextItem, c?: TextItem) => (c ? Math.abs(right(it) - right(c)) : Infinity);
    for (let k = headIdx + 1; k < lines.length; k++) {
      const r = lines[k]!;
      const text = r.items.map((i) => i.str.trim());
      if (text.some((t) => /^(taxable value|sub ?total|total)$/i.test(t))) {
        tableEnd = k;
        break;
      }
      const hsnItem = r.items.find((i) => /^\d{4,8}$/.test(i.str.trim()) && Math.abs(i.x - cHsn.x) < 0.04);
      if (!hsnItem) {
        const prev = extracted[extracted.length - 1];
        const words = r.items.filter((i) => !parseAmount(i.str) && cDesc && i.x >= cDesc.x - 0.01 && i.x < cHsn.x);
        if (prev && words.length) prev.description += " " + words.map((w) => w.str.trim()).join(" ");
        tableEnd = k;
        continue;
      }
      const n = extracted.length;
      const desc = r.items.filter((i) => i.x < cHsn.x - 0.005 && (!cDesc || i.x >= cDesc.x - 0.01));
      const qtyItem = r.items.find((i) => /^\d+(\.\d+)?(\s+[A-Za-z]{2,4})?$/.test(i.str.trim()) && i !== hsnItem && near(i, cQty) < 0.03);
      const [qtyStr, unitStr] = (qtyItem?.str.trim() ?? "1").split(/\s+/);
      const nums = r.items.filter((i) => i.x > cHsn.x + 0.01 && i !== qtyItem && parseAmount(i.str) !== null);
      const pick = (c?: TextItem) => (c ? nums.filter((i) => near(i, c) < 0.03).sort((a, b) => near(a, c) - near(b, c))[0] : undefined);
      const rateItem = pick(cRate);
      const taxableItem = pick(cTaxable);
      const taxItem = pick(cTax);
      const pctItems = r.items.filter((i) => /^\d{1,2}(\.\d+)?%$/.test(i.str.trim()));
      const gstItem = pctItems.sort((a, b) => near(a, cGst) - near(b, cGst))[0];
      const discItem = cDisc ? pctItems.filter((i) => i !== gstItem).sort((a, b) => near(a, cDisc) - near(b, cDisc))[0] : undefined;
      const gstRate = gstItem ? Number(gstItem.str.replace("%", "")) : 0;
      const taxable = taxableItem ? parseAmount(taxableItem.str)! : 0;
      const tax = taxItem ? parseAmount(taxItem.str)! : 0;
      const descText = desc.map((i) => i.str.trim()).join(" ");
      const sku = ctx.skus.find((s) => s.name.toLowerCase() === descText.toLowerCase()) ?? null;
      const unit = (unitStr ?? "OTH").toUpperCase();
      const half = pctOf(taxable, gstRate * 50);
      extracted.push({
        skuId: sku?.id ?? null,
        description: descText,
        hsn: hsnItem.str.trim(),
        qty: Math.round(Number(qtyStr)),
        unit,
        ratePaise: rateItem ? parseAmount(rateItem.str)! : taxable,
        discountPct: discItem ? Number(discItem.str.replace("%", "")) : 0,
        taxablePaise: taxable,
        gstRate,
        cgstPaise: intra ? half : 0,
        sgstPaise: intra ? half : 0,
        igstPaise: intra ? 0 : pctOf(taxable, gstRate * 100),
        printedTaxPaise: taxItem ? tax : half * 2,
      });
      region(`line.${n}.description`, `Line ${n + 1} description`, desc);
      region(`line.${n}.hsn`, `Line ${n + 1} HSN`, [hsnItem]);
      if (qtyItem) region(`line.${n}.qty`, `Line ${n + 1} quantity`, [qtyItem]);
      if (taxableItem) region(`line.${n}.taxable`, `Line ${n + 1} taxable value`, [taxableItem]);
      if (gstItem) region(`line.${n}.rate`, `Line ${n + 1} GST rate`, [gstItem]);
      if (taxItem) region(`line.${n}.tax`, `Line ${n + 1} tax`, [taxItem]);
      tableEnd = k;
    }
  }

  const totals: Totals = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, totalPaise: 0 };
  const TOTAL_ROWS: [RegExp, keyof Totals, string, string][] = [
    [/^(taxable value|sub ?total|taxable amount)/i, "taxablePaise", "totals.taxable", "Taxable value"],
    [/^cgst/i, "cgstPaise", "totals.cgst", "CGST"],
    [/^sgst|^utgst/i, "sgstPaise", "totals.sgst", "SGST"],
    [/^igst/i, "igstPaise", "totals.igst", "IGST"],
    [/^round(ing)?\s*off/i, "roundOffPaise", "totals.roundOff", "Round off"],
    [/^(grand total|invoice total|total amount|amount payable|total)$/i, "totalPaise", "totals.total", "Invoice total"],
  ];
  const seen = new Set<string>();
  for (const r of lines.slice(Math.max(tableEnd, 0))) {
    const labelItem = r.items[0];
    if (!labelItem) continue;
    for (const [re, key, rkey, label] of TOTAL_ROWS) {
      if (seen.has(key) || !re.test(labelItem.str.trim())) continue;
      const amount = [...r.items].reverse().find((i) => i !== labelItem && parseAmount(i.str) !== null);
      if (!amount) continue;
      totals[key] = parseAmount(amount.str)!;
      seen.add(key);
      region(rkey, label, [amount]);
      break;
    }
  }
  const words = all.find((i) => /^(rupees|indian rupees|inr)\b.*\bonly\.?$/i.test(i.str.trim()));
  if (words) region("totals.words", "Amount in words", [words]);

  const out: Extraction = { kind, number, date, partyName, partyGstin, partyId: party?.id ?? null, placeOfSupply, intra, lines: extracted, totals, regions, checks: [], method: "rules" };
  out.checks = checkExtraction(out, ctx);
  return out;
}

const inr = (p: number) => `₹${(p / 100).toFixed(2)}`;

/**
 * The grounding gate: arithmetic and identity checks that must pass before a
 * document can be posted without a second look. A failed check does not block
 * staging; it is shown on the approval card.
 */
export function checkExtraction(e: Extraction, ctx: ExtractContext): Check[] {
  const checks: Check[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });
  add("number", "Document number found", Boolean(e.number), e.number ?? "No bill or invoice number was found.");
  add("date", "Date found", Boolean(e.date), e.date ?? "No date was found.");
  if (e.partyGstin) add("gstin", "GSTIN is valid", gstinValid(e.partyGstin), gstinValid(e.partyGstin) ? e.partyGstin : `${e.partyGstin} fails the GSTIN check digit.`);
  add("party", e.kind === "purchase_bill" ? "Supplier is known" : "Customer is known", Boolean(e.partyId), e.partyId ? (e.partyName ?? "") : `${e.partyName ?? "This party"} is not in your books yet; approving adds them.`);
  add("lines", "Line items read", e.lines.length > 0, `${e.lines.length} line${e.lines.length === 1 ? "" : "s"}`);

  const badLines = e.lines.filter((l) => l.unit !== "OTH" && Math.abs(Math.round((l.qty * l.ratePaise * (100 - l.discountPct)) / 100) - l.taxablePaise) > 100);
  add("line-math", "Each line is quantity times rate", badLines.length === 0, badLines.length ? `Line ${e.lines.indexOf(badLines[0]!) + 1} does not multiply out.` : "All lines multiply out.");
  const badTax = e.lines.filter((l) => Math.abs(l.printedTaxPaise - (l.cgstPaise + l.sgstPaise + l.igstPaise)) > 2);
  add("line-tax", "Tax on each line matches its GST rate", badTax.length === 0, badTax.length ? `Line ${e.lines.indexOf(badTax[0]!) + 1} tax differs from ${badTax[0]!.gstRate}%.` : "All lines agree.");

  const linesTaxable = e.lines.reduce((a, l) => a + l.taxablePaise, 0);
  add("taxable", "Lines add up to the taxable value", Math.abs(linesTaxable - e.totals.taxablePaise) <= 100, `Lines ${inr(linesTaxable)}, stated ${inr(e.totals.taxablePaise)}`);
  const tax = e.totals.cgstPaise + e.totals.sgstPaise + e.totals.igstPaise;
  const lineTax = e.lines.reduce((a, l) => a + l.printedTaxPaise, 0);
  add("tax", "Line tax adds up to the tax charged", Math.abs(lineTax - tax) <= 2 * Math.max(1, e.lines.length), `Lines ${inr(lineTax)}, stated ${inr(tax)}`);
  const intra = e.intra;
  const splitOk = intra ? e.totals.igstPaise === 0 && Math.abs(e.totals.cgstPaise - e.totals.sgstPaise) <= 1 : e.totals.cgstPaise === 0 && e.totals.sgstPaise === 0;
  add("split", intra ? "Charged as CGST and SGST (same state)" : "Charged as IGST (other state)", splitOk || tax === 0, splitOk ? "Matches the place of supply." : "The tax type does not match the place of supply.");
  const sum = e.totals.taxablePaise + tax + e.totals.roundOffPaise;
  add("total", "Total is taxable value plus tax and round off", sum === e.totals.totalPaise && e.totals.totalPaise > 0, `${inr(sum)} against ${inr(e.totals.totalPaise)} printed`);

  const dup =
    e.number && e.partyId
      ? e.kind === "purchase_bill"
        ? ctx.bills.find((b) => b.partyId === e.partyId && b.number === e.number && b.status !== "rejected")
        : ctx.invoices.find((i) => i.number === e.number)
      : undefined;
  add("duplicate", "Not already in the books", !dup, dup ? `${e.number} is already recorded.` : "New document.");
  return checks;
}
