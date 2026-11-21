import { z } from "zod";

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

/** A layout the owner confirmed, kept per office by its header row. */
export const SheetLayout = z.object({ kind: SheetBillKind, mapping: BillMapping });
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
