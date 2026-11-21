import { z } from "zod";
import { FIELD_LABEL as SALES_FIELD_LABEL, REQUIRED_FIELDS as SALES_REQUIRED } from "./sales";

/**
 * Bills and invoices that arrive as a spreadsheet: a register with one bill per row, or one line per row with the
 * bill's number repeated. The owner confirms once which column holds which field; the engine reads every row by code
 * (ADR 0010).
 */

/** What a column of a bill or invoice register can hold. */
export const BillField = z.enum([
  "number",
  "date",
  "party",
  "gstin",
  "placeOfSupply",
  "description",
  "hsn",
  "qty",
  "unit",
  "rate",
  "taxable",
  "gstRate",
  "cgst",
  "sgst",
  "igst",
  "tax",
  "total",
]);
export type BillField = z.infer<typeof BillField>;

/** Needed to read a bill at all; a taxable value or a total is needed as well (`missingBillFields`). */
export const BILL_REQUIRED: BillField[] = ["number", "date", "party"];

export const BILL_FIELD_LABEL: Record<BillField, string> = {
  number: "Bill or invoice number",
  date: "Date",
  party: "Supplier or customer",
  gstin: "Their GSTIN",
  placeOfSupply: "Place of supply",
  description: "Item",
  hsn: "HSN or SAC",
  qty: "Quantity",
  unit: "Unit",
  rate: "Rate",
  taxable: "Taxable value",
  gstRate: "GST rate",
  cgst: "CGST",
  sgst: "SGST",
  igst: "IGST",
  tax: "Total GST",
  total: "Total",
};

/** Which column holds each field, by its header as written in the file. */
export const BillMapping = z.partialRecord(BillField, z.string().max(200));
export type BillMapping = z.infer<typeof BillMapping>;

/** Purchase bills from suppliers, or sales invoices the business issued. */
export const SheetBillKind = z.enum(["purchase_bill", "sales_invoice"]);
export type SheetBillKind = z.infer<typeof SheetBillKind>;

/** What a spreadsheet can be. Each kind is read by the agent whose work it is, through one reader (ADR 0010). */
export const SheetKind = z.enum(["bill_register", "sales_report", "orders", "social_metrics", "parties", "products", "open_items"]);
export type SheetKind = z.infer<typeof SheetKind>;

/**
 * A kind's fields as the owner sees them, and what it needs to be read: each inner list is one need, met by any of
 * its fields (a register needs a taxable value or a total).
 */
export type SheetKindSpec = { label: string; agentId: string; fields: Record<string, string>; needs: string[][] };

const fieldsOf = (names: string[]) => Object.fromEntries(names.map((n) => [n, n.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())]));

export const SHEET_KINDS: Record<SheetKind, SheetKindSpec> = {
  bill_register: {
    label: "Bills or invoices",
    agentId: "accountant",
    fields: BILL_FIELD_LABEL,
    needs: [["number"], ["date"], ["party"], ["taxable", "total"]],
  },
  sales_report: {
    label: "Online sales report",
    agentId: "marketplace-manager",
    fields: SALES_FIELD_LABEL,
    needs: SALES_REQUIRED.map((f) => [f]),
  },
  orders: {
    label: "Orders",
    agentId: "customer-service",
    fields: {
      number: "Order number",
      customer: "Customer",
      phone: "Phone",
      email: "Email",
      items: "Items",
      status: "Status",
      placed: "Order date",
      expected: "Expected delivery",
      tracking: "Tracking",
      note: "Note",
    },
    needs: [["number"]],
  },
  social_metrics: {
    label: "Post results",
    agentId: "social-media-manager",
    fields: {
      url: "Post link",
      id: "Post id",
      views: "Views",
      likes: "Likes",
      comments: "Comments",
      saves: "Saves",
      shares: "Shares",
      clicks: "Clicks",
      enquiries: "Enquiries",
    },
    needs: [["url", "id"]],
  },
  parties: {
    label: "Customers and suppliers",
    agentId: "accountant",
    fields: fieldsOf([
      "type",
      "name",
      "gstin",
      "pan",
      "state",
      "city",
      "contact_name",
      "phone",
      "email",
      "payment_terms_days",
      "credit_limit",
      "tan",
      "tds_section",
      "entity",
    ]),
    needs: [["type"], ["name"]],
  },
  products: {
    label: "Products and stock",
    agentId: "accountant",
    fields: fieldsOf(["sku", "name", "hsn", "gst_rate", "price", "unit", "cost", "category", "on_hand", "reorder_point", "lead_time_days", "location"]),
    needs: [["sku"], ["name"], ["hsn"], ["gst_rate"], ["price"]],
  },
  open_items: {
    label: "Unpaid invoices and bills",
    agentId: "accountant",
    fields: fieldsOf(["type", "number", "date", "party", "total", "outstanding", "due_date"]),
    needs: [["type"], ["number"], ["date"], ["party"], ["total"], ["outstanding"]],
  },
};

/** Which column holds each of a kind's fields, by its header as written in the file. */
export const SheetMapping = z.record(z.string().max(60), z.string().max(200));
export type SheetMapping = z.infer<typeof SheetMapping>;

/** The needs a mapping does not meet yet, each named by its first field. */
export function missingFor(kind: SheetKind, m: SheetMapping): string[] {
  return SHEET_KINDS[kind].needs.filter((need) => !need.some((f) => m[f])).map((need) => need[0]!);
}

/**
 * A layout the owner confirmed, kept per office by its header row. `kind` says whether a register holds purchase
 * bills or sales invoices; layouts kept before other kinds existed are registers.
 */
export const SheetLayout = z.object({ sheetKind: SheetKind.default("bill_register"), kind: SheetBillKind.optional(), mapping: SheetMapping });
export type SheetLayout = z.infer<typeof SheetLayout>;

/** The fields still to choose before a register can be read. */
export function missingBillFields(m: BillMapping): BillField[] {
  const missing = BILL_REQUIRED.filter((f) => !m[f]);
  if (!m.taxable && !m.total) missing.push("taxable");
  return missing;
}

/** The owner's answer on a `sheet_layout` card. */
export const SheetLayoutInput = z.object({ kind: SheetBillKind, mapping: BillMapping });
export type SheetLayoutInput = z.infer<typeof SheetLayoutInput>;
