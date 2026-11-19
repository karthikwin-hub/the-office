import { z } from "zod";
import { IsoDate, IsoDateTime, Paise } from "./entities";

/**
 * Online sales: the reports Amazon, Flipkart, Meesho and the quick-commerce apps send a seller,
 * read by the Marketplace Manager into lines the office can count. Phase A keeps them apart from
 * the books; nothing here is posted to the ledger.
 */

export const SALES_CHANNELS = [
  { id: "amazon", name: "Amazon", kind: "marketplace" },
  { id: "flipkart", name: "Flipkart", kind: "marketplace" },
  { id: "meesho", name: "Meesho", kind: "marketplace" },
  { id: "myntra", name: "Myntra", kind: "marketplace" },
  { id: "blinkit", name: "Blinkit", kind: "quick" },
  { id: "zepto", name: "Zepto", kind: "quick" },
  { id: "instamart", name: "Swiggy Instamart", kind: "quick" },
  { id: "bigbasket", name: "BigBasket", kind: "quick" },
  { id: "jiomart", name: "JioMart", kind: "marketplace" },
  { id: "website", name: "Your website", kind: "own" },
  { id: "other", name: "Other", kind: "marketplace" },
] as const;
export const SalesChannel = z.enum(["amazon", "flipkart", "meesho", "myntra", "blinkit", "zepto", "instamart", "bigbasket", "jiomart", "website", "other"]);
export type SalesChannel = z.infer<typeof SalesChannel>;
export const CHANNEL_NAME: Record<SalesChannel, string> = Object.fromEntries(SALES_CHANNELS.map((c) => [c.id, c.name])) as Record<SalesChannel, string>;

/** What a report column can mean. The first four are needed to count a sale. */
export const SalesField = z.enum(["date", "order", "qty", "gross", "sku", "item", "taxable", "tax", "discount", "state", "city", "status", "invoice"]);
export type SalesField = z.infer<typeof SalesField>;
export const REQUIRED_FIELDS: SalesField[] = ["date", "order", "qty", "gross"];
export const FIELD_LABEL: Record<SalesField, string> = {
  date: "Date",
  order: "Order number",
  qty: "Quantity",
  gross: "Amount the customer paid",
  sku: "SKU",
  item: "Item name",
  taxable: "Value before GST",
  tax: "GST",
  discount: "Discount",
  state: "Customer's state",
  city: "Customer's city",
  status: "Sold, returned or cancelled",
  invoice: "Invoice number",
};

/** Which column holds each field, by its header as written in the file. */
export const ColumnMapping = z.record(SalesField, z.string());
export type ColumnMapping = z.infer<typeof ColumnMapping>;

export const SalesLineStatus = z.enum(["sold", "returned", "cancelled"]);
export type SalesLineStatus = z.infer<typeof SalesLineStatus>;

/**
 * One line of one order, as the platform reported it. Amounts in paise; a return is recorded as a
 * return, not as a negative sale. A platform that reports only totals by product for a month (Myntra's
 * P&L report) gives one line per product with an empty order, counted in sales and units but not in orders.
 */
export const SalesLine = z.object({
  id: z.string(),
  importId: z.string(),
  channel: SalesChannel,
  date: IsoDate,
  order: z.string(),
  invoice: z.string().nullable(),
  /** The SKU as the platform wrote it, and the office's SKU it matched, if any. */
  sellerSku: z.string().nullable(),
  skuId: z.string().nullable(),
  item: z.string().nullable(),
  qty: z.number(),
  grossPaise: Paise,
  taxablePaise: Paise.nullable(),
  taxPaise: Paise.nullable(),
  discountPaise: Paise.nullable(),
  /** GST state code, e.g. "27" for Maharashtra. */
  state: z.string().nullable(),
  city: z.string().nullable(),
  status: SalesLineStatus,
  /** Row in the file, counting the header as row 1. */
  row: z.number().int(),
});
export type SalesLine = z.infer<typeof SalesLine>;

export const SalesImport = z.object({
  id: z.string(),
  channel: SalesChannel,
  /** The layout recognised, e.g. "amazon-mtr-b2c", or "mapped" for one the owner mapped. */
  format: z.string(),
  formatName: z.string(),
  file: z.string(),
  via: z.enum(["email", "whatsapp", "upload"]),
  sender: z.string().nullable(),
  receivedAt: IsoDateTime,
  hash: z.string(),
  status: z.enum(["read", "needs_mapping", "duplicate", "unreadable", "payout", "dropped"]),
  rows: z.number().int(),
  lines: z.number().int(),
  /** Lines already in the office from an earlier report. */
  repeated: z.number().int(),
  skipped: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  period: z.object({ from: IsoDate, to: IsoDate }).nullable(),
  grossPaise: Paise,
  note: z.string(),
});
export type SalesImport = z.infer<typeof SalesImport>;

/** A settlement or payout statement: what the platform paid and what it kept. */
export const Payout = z.object({
  id: z.string(),
  importId: z.string(),
  channel: SalesChannel,
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  paidOn: IsoDate.nullable(),
  /** Sales, refunds, fees, taxes withheld and the rest, as the statement groups them. */
  parts: z.array(z.object({ label: z.string(), paise: z.number().int() })),
  netPaise: z.number().int(),
});
export type Payout = z.infer<typeof Payout>;

const Money = z.number().int();
export const OnlineSalesReport = z.object({
  period: z.object({ from: IsoDate, to: IsoDate, label: z.string() }),
  previous: z.object({ from: IsoDate, to: IsoDate }),
  hasData: z.boolean(),
  totals: z.object({ orders: z.number().int(), units: z.number(), grossPaise: Money, returnedPaise: Money, returnsPct: z.number(), aovPaise: Money, vsPreviousPct: z.number().nullable() }),
  channels: z.array(
    z.object({
      channel: SalesChannel,
      name: z.string(),
      kind: z.enum(["marketplace", "quick", "own"]),
      orders: z.number().int(),
      units: z.number(),
      grossPaise: Money,
      returnedPaise: Money,
      returnsPct: z.number(),
      cancelled: z.number().int(),
      aovPaise: Money,
      vsPreviousPct: z.number().nullable(),
      lastDate: IsoDate.nullable(),
    }),
  ),
  /** Weeks starting Monday, oldest first, with each channel's sales. */
  weeks: z.array(z.object({ week: IsoDate, label: z.string(), byChannel: z.record(Money), totalPaise: Money })),
  skus: z.array(z.object({ key: z.string(), skuId: z.string().nullable(), name: z.string(), units: z.number(), grossPaise: Money, returnedUnits: z.number(), returnsPct: z.number(), channels: z.array(SalesChannel) })),
  /** SKUs in the catalogue that sold nothing online in the period, while others did. */
  unsold: z.array(z.object({ skuId: z.string(), name: z.string() })),
  states: z.array(z.object({ state: z.string(), name: z.string(), orders: z.number().int(), grossPaise: Money })),
  cities: z.array(z.object({ city: z.string(), orders: z.number().int(), grossPaise: Money })),
  payouts: z.array(Payout),
  imports: z.array(SalesImport),
  /** Where the platforms' reports can be sent. */
  address: z.string().nullable(),
  /** One plain sentence for the room and the digest. */
  note: z.string(),
});
export type OnlineSalesReport = z.infer<typeof OnlineSalesReport>;

export const SalesMappingInput = z.object({ channel: SalesChannel, mapping: ColumnMapping }).strict();
export const SalesUploadInput = z.object({ file: z.string().min(1).max(200), content: z.string().min(1).max(15_000_000), encoding: z.enum(["text", "base64"]) }).strict();

/** `<slug>.sales@<domain>`: where a seller sends the reports the platforms email them. */
export const salesAddress = (ingestEmail: string): string | null => {
  const at = ingestEmail.indexOf("@");
  return at > 0 ? `${ingestEmail.slice(0, at)}.sales${ingestEmail.slice(at)}` : null;
};
