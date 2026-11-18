import { type ColumnMapping, REQUIRED_FIELDS, type SalesChannel, type SalesField, type SalesLineStatus } from "@office/contracts";
import { norm } from "./parse";

/**
 * The layouts the platforms send, recognised by their header row. Each says which columns hold
 * which field; anything else is mapped once by the owner. Header names are compared after `norm`,
 * and an alias also matches a header that starts with it (Flipkart's headers carry long notes).
 */
export type Format = {
  id: string;
  name: string;
  channel: SalesChannel;
  kind: "sales" | "payout";
  /** Every one of these headers must be present. */
  needs: string[];
  /** None of these may be present (to tell Amazon's B2C and B2B reports apart). */
  without?: string[];
  fields: Partial<Record<SalesField, string[]>>;
  /** What the status column's words mean; anything else is skipped with its row. */
  status?: Record<string, SalesLineStatus | "skip">;
  /** When the file has no status column: "returns" for a file of returns, decided from its name. */
  statusFromName?: (file: string) => SalesLineStatus;
};

const AMAZON_FIELDS: Format["fields"] = {
  date: ["invoice date", "shipment date", "order date"],
  order: ["order id"],
  invoice: ["invoice number"],
  qty: ["quantity"],
  gross: ["invoice amount"],
  taxable: ["tax exclusive gross"],
  tax: ["total tax amount"],
  discount: ["item promo discount"],
  sku: ["sku"],
  item: ["item description"],
  state: ["ship to state"],
  city: ["ship to city"],
  status: ["transaction type"],
};
const AMAZON_STATUS: Format["status"] = { shipment: "sold", refund: "returned", cancel: "cancelled", freereplacement: "skip", "free replacement": "skip" };

export const FORMATS: Format[] = [
  {
    id: "amazon-mtr-b2b",
    name: "Amazon tax report (B2B)",
    channel: "amazon",
    kind: "sales",
    needs: ["transaction type", "order id", "invoice amount", "ship to state", "customer bill to gstid"],
    fields: AMAZON_FIELDS,
    status: AMAZON_STATUS,
  },
  {
    id: "amazon-mtr-b2c",
    name: "Amazon tax report (B2C)",
    channel: "amazon",
    kind: "sales",
    needs: ["transaction type", "order id", "invoice amount", "ship to state"],
    without: ["customer bill to gstid"],
    fields: AMAZON_FIELDS,
    status: AMAZON_STATUS,
  },
  {
    id: "amazon-settlement",
    name: "Amazon settlement report",
    channel: "amazon",
    kind: "payout",
    needs: ["settlement id", "settlement start date", "amount type", "amount description", "amount"],
    fields: {},
  },
  {
    id: "flipkart-sales",
    name: "Flipkart sales report",
    channel: "flipkart",
    kind: "sales",
    needs: ["order item id", "fsn", "event type", "final invoice amount"],
    fields: {
      date: ["buyer invoice date", "order date"],
      order: ["order id"],
      invoice: ["buyer invoice id"],
      qty: ["item quantity"],
      gross: ["final invoice amount"],
      taxable: ["taxable value"],
      discount: ["total discount"],
      sku: ["sku"],
      item: ["product title description", "product title"],
      state: ["customer s delivery state", "customers delivery state", "customer s billing state"],
      status: ["event type"],
    },
    status: { sale: "sold", return: "returned", cancellation: "cancelled", "return cancellation": "skip" },
  },
  {
    id: "meesho-gst",
    name: "Meesho GST report",
    channel: "meesho",
    kind: "sales",
    needs: ["sub order num", "total invoice value", "end customer state new"],
    fields: {
      date: ["order date"],
      order: ["sub order num"],
      qty: ["quantity"],
      gross: ["total invoice value"],
      taxable: ["total taxable sale value"],
      tax: ["tax amount"],
      sku: ["sku", "product id"],
      state: ["end customer state new"],
    },
    statusFromName: (file) => (/return/i.test(file) ? "returned" : "sold"),
  },
];
export const FORMAT_BY_ID: Record<string, Format> = Object.fromEntries(FORMATS.map((f) => [f.id, f]));

/** The column a field is in, by the first alias that names a header exactly, then by one a header starts with. */
export function columnFor(headers: string[], aliases: string[] | undefined): number {
  if (!aliases) return -1;
  const ns = headers.map(norm);
  for (const a of aliases) {
    const i = ns.indexOf(a);
    if (i >= 0) return i;
  }
  for (const a of aliases) {
    const i = ns.findIndex((h) => h.startsWith(`${a} `));
    if (i >= 0) return i;
  }
  return -1;
}

export function matches(f: Format, headers: string[]): boolean {
  const ns = new Set(headers.map(norm));
  const has = (h: string) => ns.has(h) || [...ns].some((x) => x.startsWith(`${h} `));
  return f.needs.every(has) && !(f.without ?? []).some(has);
}

/** The header row: the first of the top rows a known layout recognises, else the most header-like one. */
export function findHeader(rows: string[][]): { at: number; format: Format | null } {
  const top = rows.slice(0, 20);
  for (let i = 0; i < top.length; i++) {
    const f = FORMATS.find((x) => matches(x, top[i]!));
    if (f) return { at: i, format: f };
  }
  let best = 0;
  let score = -1;
  for (let i = 0; i < Math.min(top.length, 12); i++) {
    const cells = top[i]!.filter((c) => c.trim());
    const words = cells.filter((c) => /[a-z]/i.test(c) && !/^\d[\d,./-]*$/.test(c)).length;
    const guessed = Object.keys(guessMapping(top[i]!)).length;
    const s = words + guessed * 3;
    if (cells.length >= 3 && s > score) [best, score] = [i, s];
  }
  return { at: best, format: null };
}

/** For a layout not seen before: the columns that look like each field, from their names. */
const GUESS: Record<SalesField, string[]> = {
  date: ["order date", "invoice date", "date", "order created", "created at", "transaction date", "sale date", "day"],
  order: ["order id", "order number", "order no", "sub order", "order", "po number", "po no", "suborder id", "ref no", "reference no", "reference number", "ref", "transaction id", "bill number"],
  invoice: ["invoice number", "invoice no", "invoice id", "bill no"],
  qty: ["quantity", "qty", "units", "units sold", "item quantity", "sold qty", "quantity sold"],
  gross: ["invoice amount", "total amount", "order value", "gmv", "sale value", "sales value", "selling price", "sale amount", "sales amount", "amount", "total", "net sales", "revenue", "value"],
  taxable: ["taxable value", "taxable amount", "net amount", "amount before tax", "tax exclusive"],
  tax: ["tax amount", "gst amount", "total tax", "gst"],
  discount: ["discount", "promo discount"],
  sku: ["sku", "sku id", "sku code", "seller sku", "item code", "product code", "article code", "ean", "upc"],
  item: ["product name", "item name", "product", "item", "title", "description", "product title"],
  state: ["state", "ship to state", "customer state", "delivery state", "shipping state"],
  city: ["city", "ship to city", "delivery city", "customer city", "shipping city", "store city", "dark store city", "location"],
  status: ["status", "order status", "transaction type", "event type", "type"],
};

export function guessMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of Object.keys(GUESS) as SalesField[]) {
    const i = columnFor(headers, GUESS[field]);
    if (i >= 0 && !used.has(i) && headers[i]!.trim()) {
      out[field] = headers[i]!;
      used.add(i);
    }
  }
  return out;
}

export const missingFields = (m: ColumnMapping) => REQUIRED_FIELDS.filter((f) => !m[f]);

/** What a status word means in a sheet the owner mapped. */
export function statusWord(raw: string | undefined): SalesLineStatus | "skip" {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "sold";
  if (/cancel/.test(s)) return "cancelled";
  if (/return|refund|rto|rtv/.test(s)) return "returned";
  if (/fail|reject|pending|processing|replacement/.test(s)) return "skip";
  return "sold";
}

/** The platform behind a report, from who sent it or what the file is called. */
export function channelHint(file: string, sender: string | null): SalesChannel | null {
  const s = `${sender ?? ""} ${file}`.toLowerCase();
  if (/amazon/.test(s)) return "amazon";
  if (/flipkart|ekart/.test(s)) return "flipkart";
  if (/meesho/.test(s)) return "meesho";
  if (/blinkit|grofers/.test(s)) return "blinkit";
  if (/zepto/.test(s)) return "zepto";
  if (/swiggy|instamart/.test(s)) return "instamart";
  if (/bigbasket|bbnow/.test(s)) return "bigbasket";
  if (/jiomart|reliance/.test(s)) return "jiomart";
  if (/shopify|woocommerce/.test(s)) return "website";
  return null;
}

/** The same layout again: the headers, compared without case or spacing. */
export const layoutKey = (headers: string[]) => headers.map(norm).filter(Boolean).join("|");
