import type { SheetKind } from "@office/contracts";
import { describe, expect, it } from "vitest";
import { recognise } from "../src/intake/kinds";

const ALL: SheetKind[] = ["bill_register", "sales_report", "orders", "social_metrics", "parties", "products", "open_items"];

describe("recognising a spreadsheet", () => {
  it.each<[string, string[], SheetKind]>([
    ["a purchase register", ["Invoice No", "Invoice Date", "Supplier Name", "GSTIN/UIN", "Taxable Value", "CGST", "SGST", "Invoice Value"], "bill_register"],
    ["a marketplace sales report", ["Order Id", "Order Date", "SKU", "Quantity", "Invoice Amount", "Ship To State"], "sales_report"],
    ["a Shopify orders export", ["Name", "Email", "Financial Status", "Fulfillment Status", "Created at", "Lineitem name", "Phone"], "orders"],
    ["an Instagram post export", ["Post ID", "Permalink", "Impressions", "Likes", "Comments", "Saves", "Shares"], "social_metrics"],
    ["a Tally ledger list", ["Name of Ledger", "Under", "GSTIN/UIN", "State Name", "Mobile No", "Credit Period"], "parties"],
    ["a stock summary", ["Item Code", "Stock Item", "HSN/SAC", "GST Rate", "Selling Price", "Closing Quantity", "Godown"], "products"],
    ["an outstanding report", ["Voucher Type", "Ref No", "Date", "Party Name", "Opening Amount", "Pending Amount", "Due on"], "open_items"],
  ])("tells %s from the other kinds", (_, header, kind) => {
    const r = recognise([["Kaveri Electricals"], ["1-Apr-2026 to 30-Nov-2026"], header, Array(header.length).fill("x")], ALL);
    expect(r).toMatchObject({ at: 2, kind, score: 1 });
  });

  it("looks only among the kinds allowed where the file came in", () => {
    const r = recognise([["Order Id", "Order Date", "SKU", "Quantity", "Invoice Amount"]], ["bill_register"]);
    expect(r.kind).toBe("bill_register");
    expect(r.score).toBeLessThan(0.75);
  });
});
