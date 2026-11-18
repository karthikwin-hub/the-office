import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { dateOf, dispatch, findHeader, OfficeService, paiseOf, parseDelimited, stateOf, type ApiRequest } from "../src";
import { readSheets } from "../src/sales/sheets";

const ASOF = "2026-11-04";
const OWNER = { name: "Anil Kaveri", email: "anil@kaverielectricals.in" };
const req = (method: string, path: string, body?: unknown, who: "owner" | "accountant" = "owner"): ApiRequest => ({ method, path, query: new URLSearchParams(), body, role: who, user: OWNER, mode: "mock" });

function office() {
  const o = new OfficeService(loadBooks(), { asOf: ASOF });
  o.setHiring("marketplace-manager", { hired: true, trustLevel: "trainee" });
  return o;
}
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => (/[,"]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n");
const file = (o: OfficeService, name: string, text: string, sender: string | null = null, hash = name) => o.sales.receive({ file: name, sheets: [{ name, rows: parseDelimited(text) }], hash, via: "email", sender });

// Synthetic files with each platform's column names; no real seller's data.
const MTR_HEAD = ["Seller Gstin", "Invoice Number", "Invoice Date", "Transaction Type", "Order Id", "Shipment Id", "Shipment Date", "Order Date", "Shipment Item Id", "Quantity", "Item Description", "Asin", "Hsn/sac", "Sku", "Ship To City", "Ship To State", "Ship To Country", "Invoice Amount", "Tax Exclusive Gross", "Total Tax Amount", "Item Promo Discount", "Tcs Igst Amount"];
const mtr = (b2b = false) =>
  csv([
    b2b ? [...MTR_HEAD, "Customer Bill To Gstid", "Buyer Name"] : MTR_HEAD,
    ["27AAAAA0000A1Z5", "IN-101", "2026-10-02 11:20:00", "Shipment", "402-1111111-0000001", "S1", "2026-10-02", "2026-10-01", "SI1", 2, "Modular switch 6A", "B0X1", "8536", "SW-6A", "PUNE", "MAHARASHTRA", "IN", "1,180.00", "1000.00", "180.00", "0", "5.00", ...(b2b ? ["27BBBBB1111B1Z5", "Shah Traders"] : [])],
    ["27AAAAA0000A1Z5", "IN-102", "2026-10-03 09:00:00", "Shipment", "402-1111111-0000002", "S2", "2026-10-03", "2026-10-03", "SI2", 1, "LED panel 12W", "B0X2", "9405", "LED-12", "BENGALURU", "KARNATAKA", "IN", "590.00", "500.00", "90.00", "-10.00", "2.50", ...(b2b ? ["29CCCCC2222C1Z5", "Rao Stores"] : [])],
    ["27AAAAA0000A1Z5", "CN-101", "2026-10-10 10:00:00", "Refund", "402-1111111-0000001", "S1", "2026-10-02", "2026-10-01", "SI1", 1, "Modular switch 6A", "B0X1", "8536", "SW-6A", "PUNE", "MAHARASHTRA", "IN", "-590.00", "-500.00", "-90.00", "0", "-2.50", ...(b2b ? ["27BBBBB1111B1Z5", "Shah Traders"] : [])],
    ["27AAAAA0000A1Z5", "", "2026-10-04 10:00:00", "Cancel", "402-1111111-0000003", "", "", "2026-10-04", "", 1, "LED panel 12W", "B0X2", "9405", "LED-12", "DELHI", "DELHI", "IN", "0", "0", "0", "0", "0", ...(b2b ? ["", ""] : [])],
  ]);

describe("reading values the platforms write", () => {
  it("reads Indian amounts, day-first dates and state names", () => {
    expect(paiseOf("₹1,23,456.50")).toBe(12345650);
    expect(paiseOf("(45.00)")).toBe(-4500);
    expect(paiseOf("-")).toBeNull();
    expect(dateOf("03-10-2026")).toBe("2026-10-03");
    expect(dateOf("03.10.2026 22:30:00 UTC")).toBe("2026-10-04");
    expect(dateOf("2026-10-03T20:00:00+00:00")).toBe("2026-10-04");
    expect(dateOf("3-Oct-2026")).toBe("2026-10-03");
    expect(dateOf("Oct 3, 2026")).toBe("2026-10-03");
    expect(dateOf("46298")).toBe("2026-10-03");
    expect(dateOf("31-02-2026")).toBeNull();
    expect(stateOf("MAHARASHTRA")).toBe("27");
    expect(stateOf("Orissa")).toBe("21");
    expect(stateOf("29")).toBe("29");
  });

  it("finds the header row below a title, in comma or tab separated text", () => {
    const rows = parseDelimited(`Amazon tax report for October\n\n${MTR_HEAD.join("\t")}\n`);
    expect(findHeader(rows)).toMatchObject({ at: 1, format: { id: "amazon-mtr-b2c" } });
  });
});

describe("the platforms' reports", () => {
  it("reads Amazon's B2C tax report: sales, returns and cancellations, by state and city", () => {
    const o = office();
    const [imp] = file(o, "MTR_B2C-OCTOBER-2026.csv", mtr());
    expect(imp).toMatchObject({ status: "read", channel: "amazon", format: "amazon-mtr-b2c", lines: 4, skipped: [], period: { from: "2026-10-02", to: "2026-10-10" } });
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.find((l) => l.invoice === "IN-101")).toMatchObject({ status: "sold", qty: 2, grossPaise: 118000, taxablePaise: 100000, taxPaise: 18000, state: "27", city: "Pune", sellerSku: "SW-6A" });
    expect(lines.find((l) => l.invoice === "CN-101")).toMatchObject({ status: "returned", qty: 1, grossPaise: 59000 });
    expect(lines.filter((l) => l.status === "cancelled")).toHaveLength(1);
  });

  it("tells Amazon's B2B report from the B2C one", () => {
    const o = office();
    expect(file(o, "MTR_B2B.csv", mtr(true))[0]).toMatchObject({ format: "amazon-mtr-b2b", lines: 4 });
  });

  it("reads an Amazon settlement into what was paid and what was kept", () => {
    const o = office();
    const tsv = [
      ["settlement-id", "settlement-start-date", "settlement-end-date", "deposit-date", "total-amount", "currency", "transaction-type", "order-id", "amount-type", "amount-description", "amount"],
      ["123", "01.10.2026 00:00:00 UTC", "14.10.2026 00:00:00 UTC", "16.10.2026 05:00:00 UTC", "1520.50", "INR", "", "", "", "", ""],
      ["123", "", "", "", "", "", "Order", "402-1", "ItemPrice", "Principal", "1770.00"],
      ["123", "", "", "", "", "", "Order", "402-1", "ItemFees", "Commission", "-200.00"],
      ["123", "", "", "", "", "", "Order", "402-1", "ItemWithheldTax", "TCS-IGST", "-8.85"],
      ["123", "", "", "", "", "", "Order", "402-1", "ItemFees", "Commission", "-40.65"],
    ]
      .map((r) => r.join("\t"))
      .join("\n");
    const [imp] = file(o, "settlement.txt", tsv);
    expect(imp).toMatchObject({ status: "payout", grossPaise: 152050, period: { from: "2026-10-01", to: "2026-10-14" } });
    expect(o.sales.store.payouts(5)[0]).toMatchObject({ paidOn: "2026-10-16", netPaise: 152050, parts: expect.arrayContaining([{ label: "Sales", paise: 177000 }, { label: "Fees: Commission", paise: -24065 }, { label: "Tax withheld: TCS-IGST", paise: -885 }]) });
  });

  it("reads Flipkart's sales report, whose headers carry notes", () => {
    const o = office();
    const text = csv([
      ["Seller GSTIN", "Order ID", "Order Item ID", "Product Title/Description", "FSN", "SKU", "Event Type", "Order Date", "Item Quantity", "Total Discount", "Final Invoice Amount (Price after discount+Shipping Charges)", "Taxable Value (Final Invoice Amount -Taxes)", "Buyer Invoice ID", "Buyer Invoice Date", "Customer's Delivery State"],
      ["27AAAAA0000A1Z5", "OD1", "OI1", "Modular switch 6A", "FSN1", "SW-6A", "Sale", "2026-10-05", "3", "30", "1770", "1500", "FAX1", "2026-10-05", "Gujarat"],
      ["27AAAAA0000A1Z5", "OD2", "OI2", "LED panel 12W", "FSN2", "LED-12", "Return", "2026-10-06", "1", "0", "590", "500", "FAX2", "2026-10-07", "Gujarat"],
      ["27AAAAA0000A1Z5", "OD3", "OI3", "LED panel 12W", "FSN2", "LED-12", "Return Cancellation", "2026-10-06", "1", "0", "590", "500", "FAX3", "2026-10-07", "Gujarat"],
    ]);
    const [imp] = file(o, "Sales Report.csv", text);
    expect(imp).toMatchObject({ channel: "flipkart", format: "flipkart-sales", lines: 2, skipped: [{ row: 4, reason: expect.stringContaining("Return Cancellation") }] });
    expect(o.sales.store.lines("2026-10-01", "2026-10-31").find((l) => l.order === "OD1")).toMatchObject({ grossPaise: 177000, taxPaise: 27000, state: "24", qty: 3 });
  });

  it("reads Meesho's sales and returns files", () => {
    const o = office();
    const head = ["identifier", "sup_name", "gstin", "sub_order_num", "order_date", "hsn_code", "quantity", "gst_rate", "total_taxable_sale_value", "tax_amount", "total_invoice_value", "end_customer_state_new"];
    file(o, "tcs_sales.csv", csv([head, ["x", "Kaveri", "27A", "SO1", "2026-10-08", "8536", "1", "18", "100", "18", "118", "Tamil Nadu"]]));
    file(o, "tcs_sales_return.csv", csv([head, ["x", "Kaveri", "27A", "SO1", "2026-10-12", "8536", "1", "18", "100", "18", "118", "Tamil Nadu"]]));
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.map((l) => [l.order, l.status])).toEqual(expect.arrayContaining([["SO1", "sold"], ["SO1", "returned"]]));
  });
});

describe("repeats and new layouts", () => {
  it("sets aside the same file, and does not count lines twice when reports overlap", () => {
    const o = office();
    file(o, "a.csv", mtr(), null, "hash-1");
    expect(file(o, "a-again.csv", mtr(), null, "hash-1")[0]).toMatchObject({ status: "duplicate" });
    const overlap = file(o, "b.csv", mtr(), null, "hash-2")[0]!;
    expect(overlap).toMatchObject({ status: "read", lines: 4, repeated: 4 });
    expect(o.sales.store.lines("2026-10-01", "2026-10-31")).toHaveLength(4);
  });

  it("asks once for a layout it has not seen, then reads the same layout on its own", () => {
    const o = office();
    const head = ["Date", "PO Number", "Item Name", "City", "Qty Sold", "GMV"];
    const sheet = csv([head, ["05/10/2026", "PO-1", "LED panel 12W", "Mumbai", "4", "2,360"], ["06/10/2026", "PO-2", "Modular switch 6A", "Pune", "2", "1,180"]]);
    const [imp] = file(o, "blinkit_daily_sales.csv", sheet, "reports@blinkit.com");
    expect(imp).toMatchObject({ status: "needs_mapping", channel: "blinkit" });
    const card = o.books.staged.find((s) => s.kind === "sales_mapping")!;
    expect(card.payload).toMatchObject({ mapping: { date: "Date", order: "PO Number", qty: "Qty Sold", gross: "GMV", item: "Item Name", city: "City" }, missing: [] });
    // The accountant can look but not decide.
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" }, "accountant")).status).toBe(403);
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" })).status).toBe(200);
    expect(o.sales.store.importById(imp!.id)).toMatchObject({ status: "read", lines: 2 });
    const next = file(o, "blinkit_daily_sales (1).csv", csv([head, ["07/10/2026", "PO-3", "LED panel 12W", "Mumbai", "1", "590"]]), "reports@blinkit.com", "h2");
    expect(next[0]).toMatchObject({ status: "read", format: "mapped", channel: "blinkit", lines: 1 });
    expect(o.books.staged.filter((s) => s.kind === "sales_mapping")).toHaveLength(1);
  });

  it("will not read a mapping that misses a needed column, and lets the owner fix it from the room", () => {
    const o = office();
    // A sheet that looks like nothing to do with sales is not taken for one.
    expect(file(o, "contacts.csv", csv([["Name", "Phone"], ["Ravi", "98"]]))[0]).toMatchObject({ status: "unreadable" });
    const [imp2] = file(o, "zepto2.csv", csv([["Day", "Code", "Units", "Worth"], ["05/10/2026", "Z1", "2", "400"]]), "zeptonow.com");
    expect(imp2).toMatchObject({ status: "needs_mapping", channel: "zepto" });
    const card = o.books.staged.find((s) => s.kind === "sales_mapping")!;
    expect((card.payload as { missing: string[] }).missing).toEqual(["order", "gross"]);
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" })).status).toBe(409);
    const r = dispatch(o, req("PUT", `/api/sales/imports/${imp2!.id}/mapping`, { channel: "zepto", mapping: { date: "Day", order: "Code", qty: "Units", gross: "Worth" } }));
    expect(r.body).toMatchObject({ status: "read", lines: 1 });
    expect(o.books.staged.find((s) => s.id === card.id)!.status).toBe("approved");
  });
});

describe("the online sales report", () => {
  it("counts by channel, SKU and state, with the returns rate, and goes in the morning digest", () => {
    const o = office();
    file(o, "MTR.csv", mtr());
    const r = dispatch(o, req("GET", "/api/sales")).body as import("@office/contracts").OnlineSalesReport;
    expect(r.period.to).toBe("2026-10-10");
    expect(r.totals).toMatchObject({ orders: 2, grossPaise: 177000, returnedPaise: 59000, returnsPct: 33.3 });
    expect(r.channels[0]).toMatchObject({ channel: "amazon", orders: 2, cancelled: 1 });
    expect(r.states.map((s) => s.name)).toEqual(["Maharashtra", "Karnataka"]);
    expect(r.skus[0]).toMatchObject({ name: "Modular switch 6A", units: 2, returnedUnits: 1 });
    expect(r.note).toContain("Returns were 33.3%");
    // A report covering yesterday reaches the digest.
    const o2 = new OfficeService(loadBooks(), { asOf: "2026-10-04" });
    o2.setHiring("marketplace-manager", { hired: true, trustLevel: "trainee" });
    file(o2, "MTR.csv", mtr());
    expect(o2.sales.morning()[0]).toBe("Yesterday online: ₹590 (Amazon ₹590).");
  });

  it("is read by the accountant but changed only by the owner", () => {
    const o = office();
    const [imp] = file(o, "MTR.csv", mtr());
    expect(dispatch(o, req("GET", "/api/sales", undefined, "accountant")).status).toBe(200);
    expect(dispatch(o, req("DELETE", `/api/sales/imports/${imp!.id}`, undefined, "accountant")).status).toBe(403);
    expect(dispatch(o, req("DELETE", `/api/sales/imports/${imp!.id}`)).status).toBe(200);
    expect(o.sales.store.lines("2026-10-01", "2026-10-31")).toHaveLength(0);
  });
});

describe("files", () => {
  it("opens XLSX and zipped reports", async () => {
    const { Workbook } = await import("exceljs");
    const wb = new Workbook();
    const ws = wb.addWorksheet("Sales");
    ws.addRow(["Order Date", "Order Id", "Quantity", "Invoice Amount"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 5)), "A1", 2, 1180]);
    const xlsx = new Uint8Array(await wb.xlsx.writeBuffer());
    const sheets = await readSheets("report.xlsx", xlsx);
    expect(sheets[0]!.rows).toEqual([["Order Date", "Order Id", "Quantity", "Invoice Amount"], ["2026-10-05", "A1", "2", "1180"]]);
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("MTR_B2C.csv", mtr());
    const zipped = await readSheets("MTR.zip", await z.generateAsync({ type: "uint8array" }));
    expect(zipped).toHaveLength(1);
    expect(zipped[0]!.rows[0]![3]).toBe("Transaction Type");
    await expect(readSheets("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(/save it as \.xlsx/);
  });
});
