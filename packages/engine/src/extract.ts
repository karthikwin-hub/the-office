import type { Books, DocType, Line, Party, Region, Totals } from "@office/contracts";
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
  /** What the printed title says it is. Only an invoice (or bill) is posted; the rest are filed for the record. */
  docType: DocType;
  /** The business's own GSTIN printed on the page: the issuing registration on a sale, the receiving one on a purchase. */
  registration: string | null;
  /** The tax in words, where the page prints it apart from the total ("NIL", "INR Five Hundred ... Only"). */
  taxInWords?: string;
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
  // A rupee sign some PDFs map to another glyph (Tally's "ī169.92") is dropped like ₹.
  const t = s
    .replace(/₹|Rs\.?|INR/gi, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: [^\x00-\x7F] matches any non-ASCII character on purpose.
    .replace(/^[^\x00-\x7F]{1,2}(?=\s*[\d(-])/, "")
    .replace(/\s/g, "");
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
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{4}|\d{2})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    // Tally prints "9-Oct-26": a two-digit year is this century's.
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
    if (mi >= 0) return `${year}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
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
        cur = {
          str: `${cur.str}${gap > 0.001 && !cur.str.endsWith(" ") && !it.str.startsWith(" ") ? " " : ""}${it.str}`,
          page: it.page,
          x: cur.x,
          y: y0,
          w: x1 - cur.x,
          h: y1 - y0,
        };
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

/** Printed titles, most specific first. "Delivery Note" is also a field label on invoices, so only the topmost title counts. */
const TITLES: [RegExp, DocType][] = [
  [/^pro\s*-?\s*forma\b/i, "proforma"],
  [/^(delivery\s+(note|challan)|challan)\b/i, "delivery_note"],
  [/^credit\s+note\b/i, "credit_note"],
  [/^debit\s+note\b/i, "debit_note"],
  [/^(tax\s+invoice|invoice|bill\s+of\s+supply)\b/i, "invoice"],
];
const isTitle = (s: string) => s.length <= 40 && TITLES.some(([re]) => re.test(s.trim()));

/** A note's own number field. Tally prints a credit note under the heading "Tax Invoice", so the field decides. */
const NOTE_FIELDS: [RegExp, DocType][] = [
  [/^credit\s+note\s*(no|number|#)\b/i, "credit_note"],
  [/^debit\s+note\s*(no|number|#)\b/i, "debit_note"],
];

/** The document's own title, read from the top of the first page; an untitled page is an invoice or bill. A credit or debit note number on the page outranks an "invoice" title. */
export function docTypeOf(items: TextItem[]): DocType {
  const top = items.filter((i) => i.page === 1 && i.y < 0.12 && isTitle(i.str)).sort((a, b) => a.y - b.y)[0];
  const titled = top ? TITLES.find(([re]) => re.test(top.str.trim()))![1] : "invoice";
  if (titled !== "invoice") return titled;
  const note = NOTE_FIELDS.find(([re]) => items.some((i) => i.page === 1 && re.test(i.str.trim())));
  return note ? note[1] : "invoice";
}

/**
 * Sale or purchase, from the page itself: the name in the "Bill to" block, else whose GSTIN is printed
 * first. Null when the page gives neither, so a model's reading can decide. The model is not asked when
 * the page says, because it can mistake the buyer for the seller.
 */
export function directionOf(items: TextItem[], ctx: Pick<ExtractContext, "business">): Extraction["kind"] | null {
  const all = phrases(items).map((i) => ({ ...i, str: i.str.replace(/\s+/g, " ").trim() }));
  const own = new Set([ctx.business.gstin, ...(ctx.business.otherGstins ?? [])].filter(Boolean));
  // "Buyer's Order No." is a field, not the buyer.
  const billedTo = all.find((i) => /^(billed to|bill to|buyer(?!['’]s)|recipient)\b/i.test(i.str.trim()));
  const billedToValue = billedTo ? valueFor(all, billedTo) : null;
  // A blank name would match every buyer, so only names actually entered count.
  const isUs = (t: string) =>
    [ctx.business.legalName, ctx.business.name].filter((n) => n.trim()).some((n) => t.trim().toLowerCase().startsWith(n.trim().toLowerCase()));
  if (billedToValue) return isUs(billedToValue.str) ? "purchase_bill" : "sales_invoice";
  const first = all
    .flatMap((i) => {
      const m = GSTIN_RE.exec(i.str);
      return m ? [{ item: i, gstin: m[1]! }] : [];
    })
    .sort((a, b) => a.item.page - b.item.page || a.item.y - b.item.y)[0];
  return first ? (own.has(first.gstin) ? "sales_invoice" : "purchase_bill") : null;
}

/** Tax charged in its own row below the lines, as Tally prints it: "IGST 18%", "CGST OUTPUT MH  9 %", "Round Off". */
const TAX_LABEL = /^(?:sales\s+|output\s+|input\s+)?(cgst|sgst|utgst|igst)\b/i;
const TAX_ROW = /^((?:sales\s+|output\s+|input\s+)?(cgst|sgst|utgst|igst|cess)\b|round(ing)?\s*off)/i;

/** An amount that may carry its unit, as in "124.58 nos" when the rate and its "per" column run together. */
const amountOf = (s: string) => parseAmount(s) ?? parseAmount(s.replace(/\s*(?:\/\s*)?[A-Za-z]{2,4}\.?$/, ""));
const centre = (i: TextItem) => i.x + i.w / 2;
const overlaps = (i: TextItem, c: TextItem) => i.x < right(c) && right(i) > c.x;

export type ExtractContext = Pick<Books, "business" | "parties" | "skus" | "bills" | "invoices">;

export function extractInvoice(items: TextItem[], ctx: ExtractContext): Extraction {
  const all = phrases(items).map((i) => ({ ...i, str: i.str.replace(/\s+/g, " ").trim() }));
  const lines = rows(all);
  const regions: Region[] = [];
  const region = (key: string, label: string, its: TextItem[]) => {
    if (its.length) regions.push({ key, label, page: its[0]!.page, box: box(its) });
  };
  const ours = ctx.business.gstin;
  const own = new Set([ours, ...(ctx.business.otherGstins ?? [])].filter(Boolean));
  const docType = docTypeOf(all);

  const gstins = all.flatMap((i) => {
    const m = GSTIN_RE.exec(i.str);
    return m ? [{ item: i, gstin: m[1]! }] : [];
  });
  // "Buyer's Order No." is a field, not the buyer.
  const billedTo = all.find((i) => /^(billed to|bill to|buyer(?!['’]s)|recipient)\b/i.test(i.str.trim()));
  const billedToValue = billedTo ? valueFor(all, billedTo) : null;
  const kind: Extraction["kind"] = directionOf(items, ctx) ?? "purchase_bill";
  const other = gstins.find((g) => !own.has(g.gstin)) ?? null;
  const partyGstin = other?.gstin ?? null;
  const registration = gstins.find((g) => own.has(g.gstin))?.gstin ?? null;
  const ourState = registration?.slice(0, 2) ?? ctx.business.stateCode;

  const numberLabel = all.find((i) =>
    /^(tax\s+)?(bill|invoice|inv|delivery\s+(note|challan)|challan|credit\s+note|debit\s+note)\.?\s*(no|number|#)\.?\s*[:#]?/i.test(i.str.trim()),
  );
  const partyKind = kind === "purchase_bill" ? "vendor" : "customer";
  // The supplier's name heads the page, unless a title such as "Tax Invoice" sits above it.
  const first = lines[0]?.items[0];
  const masthead =
    kind !== "purchase_bill"
      ? undefined
      : first && !isTitle(first.str)
        ? first
        : all.find(
            (i) =>
              i.page === 1 &&
              !isTitle(i.str) &&
              (!numberLabel || i.x < numberLabel.x - 0.01) &&
              !/^(gstin|state|consignee|buyer|e-?mail|contact)\b/i.test(i.str),
          );
  const pans = all.flatMap((i) => [...i.str.matchAll(/\b([A-Z]{5}\d{4}[A-Z])\b/g)].map((m) => m[1]!)).filter((p) => p !== ctx.business.pan);
  const party: Party | null =
    (partyGstin && ctx.parties.find((p) => p.gstin === partyGstin)) ||
    ctx.parties.find((p) => p.kind === partyKind && !p.gstin && pans.includes(p.pan)) ||
    (masthead && ctx.parties.find((p) => p.kind === partyKind && p.name.toLowerCase() === masthead.str.toLowerCase())) ||
    // An unregistered customer has only a name to go by.
    (kind === "sales_invoice" &&
      !partyGstin &&
      billedToValue &&
      ctx.parties.find((p) => p.kind === "customer" && !p.gstin && p.name.toLowerCase() === billedToValue.str.trim().toLowerCase())) ||
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
  let printedPos = posItem ? /\((\d{2})\)\s*$/.exec(posItem.str)![1]! : null;
  if (posItem) region("pos", "Place of supply", [posItem]);
  // Without a place of supply, goods sold go where they are shipped: Tally prints "State Name : Goa, Code : 30" under the consignee.
  if (!printedPos && kind === "sales_invoice") {
    const block = all.find((i) => /^(consignee|ship(ped)?\s+to|deliver(ed|y)\s+to)\b/i.test(i.str)) ?? billedTo;
    const code = block
      ? all.find((i) => i.page === block.page && i.y > block.y && i.y - block.y < 0.2 && Math.abs(i.x - block.x) < 0.2 && /\bcode\s*:?\s*\d{2}\b/i.test(i.str))
      : undefined;
    if (code) {
      printedPos = /\bcode\s*:?\s*(\d{2})\b/i.exec(code.str)![1]!;
      region("pos", "Place of supply", [code]);
    }
  }
  const partyState = partyGstin?.slice(0, 2) ?? party?.stateCode ?? null;
  const placeOfSupply = printedPos ?? (kind === "purchase_bill" ? ourState : (partyState ?? ourState));
  const intra = kind === "purchase_bill" ? (partyState ?? ourState) === ourState : placeOfSupply === ourState;

  // Line table: the header row names an HSN column; rows run until the totals.
  const headIdx = lines.findIndex((r) => r.items.some((i) => /^hsn/i.test(i.str.trim())));
  const extracted: ExtractedLine[] = [];
  let tableEnd = headIdx;
  let cGst: TextItem | undefined;
  let cTaxable: TextItem | undefined;
  let subtotalItem: TextItem | undefined;
  if (headIdx >= 0) {
    const head = lines[headIdx]!.items;
    const col = (re: RegExp) => head.find((i) => re.test(i.str.trim()));
    const cHsn = col(/^hsn/i)!;
    const cQty = col(/^(qty|quantity)$/i);
    // Tally can print two rate columns, the first headed "(Incl. of Tax)" on the row below: the rate before tax is the other one.
    const rateCols = head.filter((i) => /^rate$/i.test(i.str.trim()));
    const incl = (lines[headIdx + 1]?.items ?? []).find((i) => /incl/i.test(i.str));
    const cRate =
      incl && rateCols.length > 1 ? [...rateCols].sort((a, b) => Math.abs(centre(b) - centre(incl)) - Math.abs(centre(a) - centre(incl)))[0] : rateCols[0];
    const cDisc = col(/^disc/i);
    cTaxable = col(/^(taxable|amount|value)/i);
    cGst = col(/^(gst|gst %|rate %|tax rate)$/i);
    const cTax = head.filter((i) => /^(tax|tax amt|tax amount)$/i.test(i.str.trim())).pop();
    const cDesc = col(/^(description|item|particulars)/i);
    const serialCol = head.some((i) => /^(sl|s\.?\s*no|sr)\b/i.test(i.str.trim()));
    const near = (it: TextItem, c?: TextItem) => (c ? Math.abs(right(it) - right(c)) : Infinity);
    // Where descriptions start when the header is centred over them, as in Tally, rather than flush with them.
    let descLeft: number | null = null;
    for (let k = headIdx + 1; k < lines.length; k++) {
      const r = lines[k]!;
      const text = r.items.map((i) => i.str.trim());
      if (text.some((t) => /^(taxable value|sub ?total|total)$/i.test(t)) || TAX_ROW.test(text[0] ?? "")) {
        tableEnd = k;
        break;
      }
      const hsnItem = r.items.find((i) => /^\d{4,8}$/.test(i.str.trim()) && Math.abs(i.x - cHsn.x) < 0.04);
      if (!hsnItem) {
        const prev = extracted[extracted.length - 1];
        const words = r.items.filter(
          (i) => !parseAmount(i.str) && i.x < cHsn.x && ((cDesc && i.x >= cDesc.x - 0.01) || (descLeft !== null && i.x >= descLeft - 0.01)),
        );
        if (prev && words.length) prev.description += " " + words.map((w) => w.str.trim()).join(" ");
        // Tally prints the lines' sum, unlabelled, under the amount column before the tax rows.
        if (
          prev &&
          r.items.length === 1 &&
          cTaxable &&
          parseAmount(r.items[0]!.str) !== null &&
          (overlaps(r.items[0]!, cTaxable) || near(r.items[0]!, cTaxable) < 0.03)
        )
          subtotalItem = r.items[0];
        tableEnd = k;
        continue;
      }
      const n = extracted.length;
      let desc = r.items.filter((i) => i !== hsnItem && i.x < cHsn.x - 0.005 && (!cDesc || i.x >= cDesc.x - 0.01));
      if (!desc.length) {
        desc = r.items.filter((i) => i !== hsnItem && i.x < cHsn.x - 0.005 && !/^\d{1,3}\.?$/.test(i.str.trim()));
        if (desc.length) descLeft = Math.min(...desc.map((i) => i.x));
      }
      const qtyItem = r.items.find((i) => /^\d+(\.\d+)?(\s+[A-Za-z]{2,4})?$/.test(i.str.trim()) && i !== hsnItem && near(i, cQty) < 0.03);
      const [qtyStr, unitStr] = (qtyItem?.str.trim() ?? "1").split(/\s+/);
      const nums = r.items.filter((i) => i.x > cHsn.x + 0.01 && i !== qtyItem && amountOf(i.str) !== null);
      // Right-aligned figures under a centred header sit off its right edge; then the column it overlaps decides.
      const pick = (c?: TextItem) =>
        c
          ? (nums.filter((i) => near(i, c) < 0.03).sort((a, b) => near(a, c) - near(b, c))[0] ??
            nums.filter((i) => overlaps(i, c)).sort((a, b) => Math.abs(centre(a) - centre(c)) - Math.abs(centre(b) - centre(c)))[0])
          : undefined;
      const rateItem = pick(cRate);
      const taxableItem = pick(cTaxable);
      const taxItem = pick(cTax);
      const pctItems = r.items.filter((i) => /^\d{1,2}(\.\d+)?%$/.test(i.str.trim()));
      const gstItem = pctItems.sort((a, b) => near(a, cGst) - near(b, cGst))[0];
      const discItem = cDisc ? pctItems.filter((i) => i !== gstItem).sort((a, b) => near(a, cDisc) - near(b, cDisc))[0] : undefined;
      const gstRate = gstItem ? Number(gstItem.str.replace("%", "")) : 0;
      const taxable = taxableItem ? amountOf(taxableItem.str)! : 0;
      const tax = taxItem ? amountOf(taxItem.str)! : 0;
      let descText = desc.map((i) => i.str.trim()).join(" ");
      // The serial number runs into the description when the two columns touch.
      if (serialCol) descText = descText.replace(/^\d{1,3}\.?\s+(?=\D)/, "");
      const sku = ctx.skus.find((s) => s.name.toLowerCase() === descText.toLowerCase()) ?? null;
      const unit = (unitStr ?? "OTH").toUpperCase();
      const half = pctOf(taxable, gstRate * 50);
      extracted.push({
        skuId: sku?.id ?? null,
        description: descText,
        hsn: hsnItem.str.trim(),
        qty: Math.round(Number(qtyStr)),
        unit,
        ratePaise: rateItem ? amountOf(rateItem.str)! : taxable,
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
  // A description that ran on to the next row can now name a product.
  for (const l of extracted) l.skuId ??= ctx.skus.find((s) => s.name.toLowerCase() === l.description.toLowerCase())?.id ?? null;

  const totals: Totals = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, totalPaise: 0 };
  const TOTAL_ROWS: [RegExp, keyof Totals, string, string][] = [
    [/^(taxable value|sub ?total|taxable amount)/i, "taxablePaise", "totals.taxable", "Taxable value"],
    [/^(?:sales\s+|output\s+|input\s+)?cgst/i, "cgstPaise", "totals.cgst", "CGST"],
    [/^(?:sales\s+|output\s+|input\s+)?(sgst|utgst)/i, "sgstPaise", "totals.sgst", "SGST"],
    [/^(?:sales\s+|output\s+|input\s+)?igst/i, "igstPaise", "totals.igst", "IGST"],
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

  // Tally prints no "Taxable value" row: take the unlabelled subtotal, else the Total row of the HSN summary, else the lines.
  if (!seen.has("taxablePaise") && extracted.length) {
    let from = subtotalItem;
    if (!from) {
      const sIdx = lines.findIndex(
        (r, k) => k > headIdx && r.items.some((i) => /^hsn/i.test(i.str.trim())) && r.items.some((i) => /^taxable/i.test(i.str.trim())),
      );
      const head = sIdx >= 0 ? lines[sIdx]!.items.find((i) => /^taxable/i.test(i.str.trim()))! : undefined;
      const totalRow = head ? lines.slice(sIdx + 1).find((r) => r.items.some((i) => /^total$/i.test(i.str.trim()))) : undefined;
      from =
        head && totalRow
          ? totalRow.items
              .filter((i) => parseAmount(i.str) !== null && overlaps(i, head))
              .sort((a, b) => Math.abs(centre(a) - centre(head)) - Math.abs(centre(b) - centre(head)))[0]
          : undefined;
    }
    if (from) {
      totals.taxablePaise = parseAmount(from.str)!;
      region("totals.taxable", "Taxable value", [from]);
    } else totals.taxablePaise = extracted.reduce((a, l) => a + l.taxablePaise, 0);
  }

  // No GST column on the lines: the rate printed on the tax rows applies to every line, when there is just one.
  if (!cGst && extracted.length && extracted.every((l) => l.gstRate === 0)) {
    const rates = new Set<number>();
    for (const r of lines.slice(Math.max(tableEnd, 0))) {
      const m = /^(?:sales\s+|output\s+|input\s+)?(cgst|sgst|utgst|igst)\b.*?(\d{1,2}(?:\.\d+)?)\s*%/i.exec(r.items.map((i) => i.str.trim()).join(" "));
      if (m && TAX_LABEL.test(r.items[0]?.str.trim() ?? "")) rates.add(Number(m[2]) * (m[1]!.toLowerCase() === "igst" ? 1 : 2));
    }
    const rate = rates.size === 1 ? [...rates][0]! : null;
    if (rate !== null && Number.isInteger(rate))
      for (const l of extracted) {
        const half = pctOf(l.taxablePaise, rate * 50);
        Object.assign(l, { gstRate: rate, cgstPaise: intra ? half : 0, sgstPaise: intra ? half : 0, igstPaise: intra ? 0 : pctOf(l.taxablePaise, rate * 100) });
        l.printedTaxPaise = l.cgstPaise + l.sgstPaise + l.igstPaise;
      }
  }

  const words = all.find((i) => /^(rupees|indian rupees|inr)\b.*\bonly\.?$/i.test(i.str.trim()));
  if (words) region("totals.words", "Amount in words", [words]);
  const taxWordsLabel = all.find((i) => /^tax amount \(in words\)/i.test(i.str.trim()));
  const taxWordsItem = taxWordsLabel
    ? /[:]\s*(\S.*)$/.test(taxWordsLabel.str)
      ? taxWordsLabel
      : all.filter((i) => i.page === taxWordsLabel.page && Math.abs(i.y - taxWordsLabel.y) < 0.005 && i.x > taxWordsLabel.x).sort((a, b) => a.x - b.x)[0]
    : undefined;
  const taxInWords = taxWordsItem ? inlineValue(taxWordsItem) : undefined;

  const out: Extraction = {
    kind,
    docType,
    registration,
    ...(taxInWords ? { taxInWords } : {}),
    number,
    date,
    partyName,
    partyGstin,
    partyId: party?.id ?? null,
    placeOfSupply,
    intra,
    lines: extracted,
    totals,
    regions,
    checks: [],
    method: "rules",
  };
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
  const posts = e.docType === "invoice";
  add("number", "Document number found", Boolean(e.number), e.number ?? "No document number was found.");
  add("date", "Date found", Boolean(e.date), e.date ?? "No date was found.");
  if (e.partyGstin)
    add("gstin", "GSTIN is valid", gstinValid(e.partyGstin), gstinValid(e.partyGstin) ? e.partyGstin : `${e.partyGstin} fails the GSTIN check digit.`);
  const unknown = posts
    ? `${e.partyName ?? "This party"} is not in your books yet; approving adds them.`
    : `${e.partyName ?? "This party"} is not in your books.`;
  add("party", e.kind === "purchase_bill" ? "Supplier is known" : "Customer is known", Boolean(e.partyId), e.partyId ? (e.partyName ?? "") : unknown);
  add("lines", "Line items read", e.lines.length > 0, `${e.lines.length} line${e.lines.length === 1 ? "" : "s"}`);
  if (e.docType === "delivery_note") {
    // A challan carries goods, not a sale; rule 55 still wants their value and tax on it.
    const valued = e.totals.totalPaise > 0 || e.lines.some((l) => l.taxablePaise > 0);
    add(
      "value",
      "Value of the goods printed",
      valued,
      valued
        ? inr(e.totals.totalPaise || e.lines.reduce((a, l) => a + l.taxablePaise, 0))
        : "No value or tax is printed. A delivery challan should show the taxable value and tax of the goods it carries (CGST Rules, rule 55).",
    );
    return checks;
  }

  const badLines = e.lines.filter((l) => l.unit !== "OTH" && Math.abs(Math.round((l.qty * l.ratePaise * (100 - l.discountPct)) / 100) - l.taxablePaise) > 100);
  add(
    "line-math",
    "Each line is quantity times rate",
    badLines.length === 0,
    badLines.length ? `Line ${e.lines.indexOf(badLines[0]!) + 1} does not multiply out.` : "All lines multiply out.",
  );
  const badTax = e.lines.filter((l) => Math.abs(l.printedTaxPaise - (l.cgstPaise + l.sgstPaise + l.igstPaise)) > 2);
  add(
    "line-tax",
    "Tax on each line matches its GST rate",
    badTax.length === 0,
    badTax.length ? `Line ${e.lines.indexOf(badTax[0]!) + 1} tax differs from ${badTax[0]!.gstRate}%.` : "All lines agree.",
  );

  const linesTaxable = e.lines.reduce((a, l) => a + l.taxablePaise, 0);
  add(
    "taxable",
    "Lines add up to the taxable value",
    Math.abs(linesTaxable - e.totals.taxablePaise) <= 100,
    `Lines ${inr(linesTaxable)}, stated ${inr(e.totals.taxablePaise)}`,
  );
  const tax = e.totals.cgstPaise + e.totals.sgstPaise + e.totals.igstPaise;
  const lineTax = e.lines.reduce((a, l) => a + l.printedTaxPaise, 0);
  add("tax", "Line tax adds up to the tax charged", Math.abs(lineTax - tax) <= 2 * Math.max(1, e.lines.length), `Lines ${inr(lineTax)}, stated ${inr(tax)}`);
  const intra = e.intra;
  const splitOk = intra
    ? e.totals.igstPaise === 0 && Math.abs(e.totals.cgstPaise - e.totals.sgstPaise) <= 1
    : e.totals.cgstPaise === 0 && e.totals.sgstPaise === 0;
  add(
    "split",
    intra ? "Charged as CGST and SGST (same state)" : "Charged as IGST (other state)",
    splitOk || tax === 0,
    splitOk ? "Matches the place of supply." : "The tax type does not match the place of supply.",
  );
  const sum = e.totals.taxablePaise + tax + e.totals.roundOffPaise;
  add(
    "total",
    "Total is taxable value plus tax and round off",
    sum === e.totals.totalPaise && e.totals.totalPaise > 0,
    `${inr(sum)} against ${inr(e.totals.totalPaise)} printed`,
  );
  if (e.taxInWords !== undefined) {
    const nil = /^nil\b/i.test(e.taxInWords);
    add(
      "tax-words",
      "Tax in words agrees with the tax charged",
      nil === (tax === 0),
      nil && tax > 0 ? `The tax in words says NIL, but ${inr(tax)} is charged.` : e.taxInWords,
    );
  }
  if (!posts) return checks;

  const dup =
    e.number && e.partyId
      ? e.kind === "purchase_bill"
        ? ctx.bills.find((b) => b.partyId === e.partyId && b.number === e.number && b.status !== "rejected")
        : ctx.invoices.find((i) => i.number === e.number)
      : undefined;
  add("duplicate", "Not already in the books", !dup, dup ? `${e.number} is already recorded.` : "New document.");
  return checks;
}
