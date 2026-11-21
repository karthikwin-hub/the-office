import { missingFor, SHEET_KINDS, type SheetKind, type SheetMapping } from "@office/contracts";
import { guessMapping as guessSales } from "../sales/formats";
import { norm } from "../sales/parse";

/**
 * Recognising a spreadsheet: which kind it is, where its header row is, and which column holds each field, guessed
 * from the header names. One reader for every kind (ADR 0010); a kind's rows are mapped to records by its own agent.
 */

/**
 * The columns whose names match a field's aliases. Exact names are taken before names that only start with one,
 * each column is used once, and an amount field never takes a column named as a rate or percentage.
 */
export function guessByAliases(headers: string[], aliases: Record<string, string[]>, amounts: Set<string> = new Set()): SheetMapping {
  const ns = headers.map(norm);
  const used = new Set<number>();
  const out: SheetMapping = {};
  const take = (f: string, i: number) => {
    out[f] = headers[i]!;
    used.add(i);
  };
  for (const f of Object.keys(aliases)) {
    const i = aliases[f]!.map((a) => ns.findIndex((h, k) => h === a && !used.has(k))).find((k) => k >= 0);
    if (i !== undefined) take(f, i);
  }
  for (const f of Object.keys(aliases)) {
    if (out[f]) continue;
    for (const a of aliases[f]!) {
      const i = ns.findIndex((h, k) => !used.has(k) && h.startsWith(`${a} `) && !(amounts.has(f) && /\b(rate|percent|pct)\b/.test(h)));
      if (i >= 0) {
        take(f, i);
        break;
      }
    }
  }
  return out;
}

/** Header names that usually mean each field, compared after `norm`. More specific names come first. */
const BILLS: Record<string, string[]> = {
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
const BILL_AMOUNTS = new Set(["taxable", "cgst", "sgst", "igst", "tax", "total"]);

const ORDERS: Record<string, string[]> = {
  number: ["order number", "order no", "order id", "order", "number", "name"],
  customer: ["customer name", "customer", "billing name", "shipping name", "buyer name"],
  phone: ["phone", "mobile", "phone number", "whatsapp", "billing phone", "shipping phone"],
  email: ["email", "e mail", "customer email"],
  items: ["items", "item", "products", "lineitem name", "product", "description"],
  status: ["status", "fulfillment status", "order status", "state"],
  placed: ["order date", "placed on", "placed", "created at", "date"],
  expected: ["expected on", "expected", "delivery date", "eta"],
  tracking: ["tracking link", "tracking number", "tracking", "awb"],
  note: ["notes", "note"],
};

const METRICS: Record<string, string[]> = {
  url: ["permalink", "post link", "post url", "link", "url", "tweet permalink"],
  id: ["post id", "media id", "tweet id", "id"],
  views: ["views", "impressions", "reach", "plays"],
  likes: ["likes", "reactions", "like count"],
  comments: ["comments", "replies", "comment count"],
  saves: ["saves", "saved"],
  shares: ["shares", "reposts", "retweets", "forwards"],
  clicks: ["clicks", "link clicks", "url clicks", "website clicks"],
  enquiries: ["enquiries", "messages", "conversations started"],
};

/** The template's own column names come first, then the names Tally and spreadsheets use for the same thing. */
const PARTIES: Record<string, string[]> = {
  type: ["type", "party type", "group", "under"],
  name: ["name", "party name", "ledger name", "name of ledger", "customer name", "supplier name"],
  gstin: ["gstin", "gstin uin", "gst no", "gst number"],
  pan: ["pan", "pan no", "income tax number"],
  state: ["state", "state name"],
  city: ["city", "town"],
  contact_name: ["contact name", "contact person"],
  phone: ["phone", "mobile", "mobile no", "phone no"],
  email: ["email", "e mail", "email id"],
  payment_terms_days: ["payment terms days", "credit period", "credit days"],
  credit_limit: ["credit limit"],
  tan: ["tan"],
  tds_section: ["tds section", "nature of payment"],
  entity: ["entity", "type of entity"],
};
const PRODUCTS: Record<string, string[]> = {
  sku: ["sku", "item code", "product code", "part no"],
  name: ["name", "item name", "stock item", "name of item", "product name"],
  hsn: ["hsn", "hsn sac", "hsn code"],
  gst_rate: ["gst rate", "tax rate", "rate of tax", "gst"],
  price: ["price", "selling price", "rate", "mrp"],
  unit: ["unit", "uom", "units"],
  cost: ["cost", "cost price", "purchase price"],
  category: ["category", "stock group", "group"],
  on_hand: ["on hand", "closing quantity", "closing stock", "quantity", "qty"],
  reorder_point: ["reorder point", "reorder level"],
  lead_time_days: ["lead time days", "lead time"],
  location: ["location", "godown"],
};
const OPEN_ITEMS: Record<string, string[]> = {
  type: ["type", "voucher type"],
  number: ["number", "invoice no", "bill no", "ref no", "voucher no"],
  date: ["date", "invoice date", "bill date"],
  party: ["party", "party name", "ledger name", "customer", "supplier"],
  total: ["total", "amount", "invoice amount", "bill amount", "opening amount"],
  outstanding: ["outstanding", "pending amount", "balance", "due amount"],
  due_date: ["due date", "due on"],
};

type KindReader = { guess: (headers: string[]) => SheetMapping };

const READERS: Record<SheetKind, KindReader> = {
  bill_register: { guess: (h) => guessByAliases(h, BILLS, BILL_AMOUNTS) },
  sales_report: { guess: (h) => guessSales(h) as SheetMapping },
  orders: { guess: (h) => guessByAliases(h, ORDERS) },
  social_metrics: { guess: (h) => guessByAliases(h, METRICS, new Set(["views", "likes", "comments", "saves", "shares", "clicks", "enquiries"])) },
  parties: { guess: (h) => guessByAliases(h, PARTIES) },
  products: { guess: (h) => guessByAliases(h, PRODUCTS) },
  open_items: { guess: (h) => guessByAliases(h, OPEN_ITEMS, new Set(["total", "outstanding"])) },
};

export const guessFor = (kind: SheetKind, headers: string[]): SheetMapping => READERS[kind].guess(headers);

/** How much of what a kind needs these columns meet, from 0 to 1. */
export const scoreFor = (kind: SheetKind, m: SheetMapping) => {
  const needs = SHEET_KINDS[kind].needs.length;
  return (needs - missingFor(kind, m).length) / needs;
};

export type Recognised = { at: number; kind: SheetKind; mapping: SheetMapping; score: number };

/**
 * The header row and kind: of the top rows and the kinds allowed here, the one whose names meet most of what the kind
 * needs, then the most of its needs, then the most fields found. A file's name only breaks a tie.
 */
export function recognise(rows: string[][], kinds: readonly SheetKind[]): Recognised {
  let best: Recognised & { rank: number[] } = { at: 0, kind: kinds[0]!, mapping: {}, score: 0, rank: [-1] };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    for (const kind of kinds) {
      const mapping = guessFor(kind, rows[i]!);
      const score = scoreFor(kind, mapping);
      const met = SHEET_KINDS[kind].needs.length - missingFor(kind, mapping).length;
      const rank = [score, met, Object.keys(mapping).length];
      const better = rank.findIndex((v, k) => v !== best.rank[k]!);
      if (better >= 0 && rank[better]! > best.rank[better]!) best = { at: i, kind, mapping, score, rank };
    }
  }
  return { at: best.at, kind: best.kind, mapping: best.mapping, score: best.score };
}
