import { loadBooks } from "@office/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiRequest, dateOf, dispatch, findHeader, layoutKey, OfficeService, paiseOf, parseDelimited, stateOf } from "../src";
import { readSheets } from "../src/sales/sheets";

const ASOF = "2026-11-04";
const OWNER = { name: "Anil Kaveri", email: "anil@kaverielectricals.in" };
const req = (method: string, path: string, body?: unknown, who: "owner" | "accountant" = "owner"): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(),
  body,
  role: who,
  user: OWNER,
  mode: "mock",
});

function office() {
  const o = new OfficeService(loadBooks(), { asOf: ASOF });
  o.setHiring("marketplace-manager", { hired: true, trustLevel: "trainee" });
  return o;
}
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((c) => (/[,"]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n");
const file = (o: OfficeService, name: string, text: string, sender: string | null = null, hash = name) =>
  o.sales.receive({ file: name, sheets: [{ name, rows: parseDelimited(text) }], hash, via: "email", sender });

// Synthetic files with each platform's column names; no real seller's data.
const MTR_HEAD = [
  "Seller Gstin",
  "Invoice Number",
  "Invoice Date",
  "Transaction Type",
  "Order Id",
  "Shipment Id",
  "Shipment Date",
  "Order Date",
  "Shipment Item Id",
  "Quantity",
  "Item Description",
  "Asin",
  "Hsn/sac",
  "Sku",
  "Ship To City",
  "Ship To State",
  "Ship To Country",
  "Invoice Amount",
  "Tax Exclusive Gross",
  "Total Tax Amount",
  "Item Promo Discount",
  "Tcs Igst Amount",
];
const mtr = (b2b = false) =>
  csv([
    b2b ? [...MTR_HEAD, "Customer Bill To Gstid", "Buyer Name"] : MTR_HEAD,
    [
      "27AAAAA0000A1Z5",
      "IN-101",
      "2026-10-02 11:20:00",
      "Shipment",
      "402-1111111-0000001",
      "S1",
      "2026-10-02",
      "2026-10-01",
      "SI1",
      2,
      "Modular switch 6A",
      "B0X1",
      "8536",
      "SW-6A",
      "PUNE",
      "MAHARASHTRA",
      "IN",
      "1,180.00",
      "1000.00",
      "180.00",
      "0",
      "5.00",
      ...(b2b ? ["27BBBBB1111B1Z5", "Shah Traders"] : []),
    ],
    [
      "27AAAAA0000A1Z5",
      "IN-102",
      "2026-10-03 09:00:00",
      "Shipment",
      "402-1111111-0000002",
      "S2",
      "2026-10-03",
      "2026-10-03",
      "SI2",
      1,
      "LED panel 12W",
      "B0X2",
      "9405",
      "LED-12",
      "BENGALURU",
      "KARNATAKA",
      "IN",
      "590.00",
      "500.00",
      "90.00",
      "-10.00",
      "2.50",
      ...(b2b ? ["29CCCCC2222C1Z5", "Rao Stores"] : []),
    ],
    [
      "27AAAAA0000A1Z5",
      "CN-101",
      "2026-10-10 10:00:00",
      "Refund",
      "402-1111111-0000001",
      "S1",
      "2026-10-02",
      "2026-10-01",
      "SI1",
      1,
      "Modular switch 6A",
      "B0X1",
      "8536",
      "SW-6A",
      "PUNE",
      "MAHARASHTRA",
      "IN",
      "-590.00",
      "-500.00",
      "-90.00",
      "0",
      "-2.50",
      ...(b2b ? ["27BBBBB1111B1Z5", "Shah Traders"] : []),
    ],
    [
      "27AAAAA0000A1Z5",
      "",
      "2026-10-04 10:00:00",
      "Cancel",
      "402-1111111-0000003",
      "",
      "",
      "2026-10-04",
      "",
      1,
      "LED panel 12W",
      "B0X2",
      "9405",
      "LED-12",
      "DELHI",
      "DELHI",
      "IN",
      "0",
      "0",
      "0",
      "0",
      "0",
      ...(b2b ? ["", ""] : []),
    ],
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
    expect(imp).toMatchObject({
      status: "read",
      channel: "amazon",
      format: "amazon-mtr-b2c",
      lines: 4,
      skipped: [],
      period: { from: "2026-10-02", to: "2026-10-10" },
    });
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.find((l) => l.invoice === "IN-101")).toMatchObject({
      status: "sold",
      qty: 2,
      grossPaise: 118000,
      taxablePaise: 100000,
      taxPaise: 18000,
      state: "27",
      city: "Pune",
      sellerSku: "SW-6A",
    });
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
      [
        "settlement-id",
        "settlement-start-date",
        "settlement-end-date",
        "deposit-date",
        "total-amount",
        "currency",
        "transaction-type",
        "order-id",
        "amount-type",
        "amount-description",
        "amount",
      ],
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
    expect(o.sales.store.payouts(5)[0]).toMatchObject({
      paidOn: "2026-10-16",
      netPaise: 152050,
      parts: expect.arrayContaining([
        { label: "Sales", paise: 177000 },
        { label: "Fees: Commission", paise: -24065 },
        { label: "Tax withheld: TCS-IGST", paise: -885 },
      ]),
    });
  });

  it("reads Flipkart's sales report, whose headers carry notes", () => {
    const o = office();
    const text = csv([
      [
        "Seller GSTIN",
        "Order ID",
        "Order Item ID",
        "Product Title/Description",
        "FSN",
        "SKU",
        "Event Type",
        "Order Date",
        "Item Quantity",
        "Total Discount",
        "Final Invoice Amount (Price after discount+Shipping Charges)",
        "Taxable Value (Final Invoice Amount -Taxes)",
        "Buyer Invoice ID",
        "Buyer Invoice Date",
        "Customer's Delivery State",
      ],
      ["27AAAAA0000A1Z5", "OD1", "OI1", "Modular switch 6A", "FSN1", "SW-6A", "Sale", "2026-10-05", "3", "30", "1770", "1500", "FAX1", "2026-10-05", "Gujarat"],
      ["27AAAAA0000A1Z5", "OD2", "OI2", "LED panel 12W", "FSN2", "LED-12", "Return", "2026-10-06", "1", "0", "590", "500", "FAX2", "2026-10-07", "Gujarat"],
      [
        "27AAAAA0000A1Z5",
        "OD3",
        "OI3",
        "LED panel 12W",
        "FSN2",
        "LED-12",
        "Return Cancellation",
        "2026-10-06",
        "1",
        "0",
        "590",
        "500",
        "FAX3",
        "2026-10-07",
        "Gujarat",
      ],
    ]);
    const [imp] = file(o, "Sales Report.csv", text);
    expect(imp).toMatchObject({
      channel: "flipkart",
      format: "flipkart-sales",
      lines: 2,
      skipped: [{ row: 4, reason: expect.stringContaining("Return Cancellation") }],
    });
    expect(o.sales.store.lines("2026-10-01", "2026-10-31").find((l) => l.order === "OD1")).toMatchObject({
      grossPaise: 177000,
      taxPaise: 27000,
      state: "24",
      qty: 3,
    });
  });

  it("reads Meesho's sales and returns files", () => {
    const o = office();
    const head = [
      "identifier",
      "sup_name",
      "gstin",
      "sub_order_num",
      "order_date",
      "hsn_code",
      "quantity",
      "gst_rate",
      "total_taxable_sale_value",
      "tax_amount",
      "total_invoice_value",
      "end_customer_state_new",
    ];
    file(o, "tcs_sales.csv", csv([head, ["x", "Kaveri", "27A", "SO1", "2026-10-08", "8536", "1", "18", "100", "18", "118", "Tamil Nadu"]]));
    file(o, "tcs_sales_return.csv", csv([head, ["x", "Kaveri", "27A", "SO1", "2026-10-12", "8536", "1", "18", "100", "18", "118", "Tamil Nadu"]]));
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.map((l) => [l.order, l.status])).toEqual(
      expect.arrayContaining([
        ["SO1", "sold"],
        ["SO1", "returned"],
      ]),
    );
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
    const sheet = csv([
      head,
      ["05/10/2026", "PO-1", "LED panel 12W", "Mumbai", "4", "2,360"],
      ["06/10/2026", "PO-2", "Modular switch 6A", "Pune", "2", "1,180"],
    ]);
    const [imp] = file(o, "blinkit_daily_sales.csv", sheet, "reports@blinkit.com");
    expect(imp).toMatchObject({ status: "needs_mapping", channel: "blinkit" });
    const card = o.books.staged.find((s) => s.kind === "sales_mapping")!;
    expect(card.payload).toMatchObject({
      mapping: { date: "Date", order: "PO Number", qty: "Qty Sold", gross: "GMV", item: "Item Name", city: "City" },
      missing: [],
    });
    // The accountant can look but not decide.
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" }, "accountant")).status).toBe(403);
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" })).status).toBe(200);
    expect(o.sales.store.importById(imp!.id)).toMatchObject({ status: "read", lines: 2 });
    const next = file(
      o,
      "blinkit_daily_sales (1).csv",
      csv([head, ["07/10/2026", "PO-3", "LED panel 12W", "Mumbai", "1", "590"]]),
      "reports@blinkit.com",
      "h2",
    );
    expect(next[0]).toMatchObject({ status: "read", format: "mapped", channel: "blinkit", lines: 1 });
    expect(o.books.staged.filter((s) => s.kind === "sales_mapping")).toHaveLength(1);
    // The layout is kept in the office's one layout memory, with every other kind of sheet.
    expect(o.intake.store.layout(layoutKey(head))).toMatchObject({ sheetKind: "sales_report", channel: "blinkit", mapping: { order: "PO Number" } });
  });

  it("still reads a layout kept in the sales store before there was one layout memory", () => {
    const o = office();
    const head = ["Day", "Ref", "Units", "Value"];
    o.sales.store.saveMapping(layoutKey(head), { channel: "zepto", mapping: { date: "Day", order: "Ref", qty: "Units", gross: "Value" } });
    const [imp] = file(o, "z.csv", csv([head, ["05/10/2026", "Z-1", "2", "500"]]));
    expect(imp).toMatchObject({ status: "read", channel: "zepto", lines: 1 });
  });

  it("will not read a mapping that misses a needed column, and lets the owner fix it from the room", () => {
    const o = office();
    // A sheet that looks like nothing to do with sales is not taken for one.
    expect(
      file(
        o,
        "contacts.csv",
        csv([
          ["Name", "Phone"],
          ["Ravi", "98"],
        ]),
      )[0],
    ).toMatchObject({ status: "unreadable" });
    const [imp2] = file(
      o,
      "zepto2.csv",
      csv([
        ["Day", "Code", "Units", "Worth"],
        ["05/10/2026", "Z1", "2", "400"],
      ]),
      "zeptonow.com",
    );
    expect(imp2).toMatchObject({ status: "needs_mapping", channel: "zepto" });
    const card = o.books.staged.find((s) => s.kind === "sales_mapping")!;
    expect((card.payload as { missing: string[] }).missing).toEqual(["order", "gross"]);
    expect(dispatch(o, req("POST", `/api/desk/${card.id}`, { action: "approve" })).status).toBe(409);
    const r = dispatch(
      o,
      req("PUT", `/api/sales/imports/${imp2!.id}/mapping`, { channel: "zepto", mapping: { date: "Day", order: "Code", qty: "Units", gross: "Worth" } }),
    );
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
    expect(sheets[0]!.rows).toEqual([
      ["Order Date", "Order Id", "Quantity", "Invoice Amount"],
      ["2026-10-05", "A1", "2", "1180"],
    ]);
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("MTR_B2C.csv", mtr());
    const zipped = await readSheets("MTR.zip", await z.generateAsync({ type: "uint8array" }));
    expect(zipped).toHaveLength(1);
    expect(zipped[0]!.rows[0]![3]).toBe("Transaction Type");
    await expect(readSheets("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(/save it as \.xlsx/);
  });

  // A zip bomb: 64 MB of zeros squeezes into about 64 KB. Built once here, not kept as a file.
  const ZEROS = 64 * 1024 * 1024;
  let bombBytes: Uint8Array;
  beforeAll(async () => {
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("xl/worksheets/sheet1.csv", new Uint8Array(ZEROS), { compression: "DEFLATE" });
    bombBytes = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bombBytes.byteLength).toBeLessThan(ZEROS / 500);
  }, 60_000);
  /** A copy of the bomb whose headers say its one entry unzips to `size`, as a crafted zip would. */
  function claimSize(zip: Uint8Array, size: number) {
    const out = zip.slice();
    const v = new DataView(out.buffer);
    for (let i = 0; i + 30 <= out.length; i++) {
      const sig = v.getUint32(i, true);
      if (sig === 0x04034b50) v.setUint32(i + 22, size, true);
      else if (sig === 0x02014b50) v.setUint32(i + 24, size, true);
    }
    return out;
  }

  it("refuses a zip whose reports say they unzip to more than it reads, before unzipping them", async () => {
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("MTR_B2C.csv", mtr());
    const small = claimSize(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }), 0x7fffffff);
    await expect(readSheets("MTR.zip", small)).rejects.toThrow("The zip file holds more than the office reads at once. Send the reports one at a time.");
  });

  it("stops unzipping a report the moment it passes the limit, whatever its header claims", async () => {
    await expect(readSheets("MTR.zip", claimSize(bombBytes, 100))).rejects.toThrow(
      "The zip file holds more than the office reads at once. Send the reports one at a time.",
    );
  }, 30_000);

  it("measures an XLSX before the workbook reader unzips it, by its headers and as it reads", async () => {
    await expect(readSheets("report.xlsx", bombBytes)).rejects.toThrow(
      "The spreadsheet holds more than the office reads at once. Send the reports one at a time.",
    );
    await expect(readSheets("report.xlsx", claimSize(bombBytes, 100))).rejects.toThrow(
      "The spreadsheet holds more than the office reads at once. Send the reports one at a time.",
    );
  }, 30_000);
});

// Amazon's transaction (date range) report: notes above the header, then orders, refunds, fees and transfers.
const TXN_HEAD = [
  "date/time",
  "settlement id",
  "type",
  "order id",
  "Sku",
  "description",
  "quantity",
  "marketplace",
  "account type",
  "fulfillment",
  "order city",
  "order state",
  "order postal",
  "product sales",
  "shipping credits",
  "gift wrap credits",
  "promotional rebates",
  "Total sales tax liable(GST before adjusting TCS)",
  "TCS-CGST",
  "TCS-SGST",
  "TCS-IGST",
  "TDS (Section 194-O)",
  "selling fees",
  "fba fees",
  "other transaction fees",
  "other",
  "total",
  "Transaction Status",
  "Transaction Release Date",
];
const txn = (...rows: (string | number)[][]) =>
  [
    `"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"`,
    `"All amounts in INR, unless specified"`,
    `"Selling fees: Includes variable closing fees and referral fees."`,
    csv([TXN_HEAD, ...rows]),
  ].join("\r\n");
const order = (when: string, id: string, sku: string, qty: number, sales: string, tax: string, state: string, fees: string, total: string) => [
  when,
  "S1",
  "Order",
  id,
  sku,
  `${sku === "SW-6A" ? "Modular switch 6A" : "LED panel 12W"} | Long lasting | ISI marked`,
  qty,
  "amazon.in",
  "Card",
  "Merchant",
  "PUNE",
  state,
  "411001",
  sales,
  "0",
  "0",
  "0",
  tax,
  "0",
  "0",
  "-2.50",
  "-0.50",
  fees,
  "0",
  "-50.00",
  "0",
  total,
  "Released",
  "",
];
const amazonTxn = () =>
  txn(
    order("1 Oct 2026 8:33:52 am UTC", "402-1", "SW-6A", 1, "1,000.00", "180.00", "KARNATAKA", "-100.00", "1,027.00"),
    order("1 Oct 2026 8:40:00 pm UTC", "402-1", "LED-12", 1, "500.00", "90.00", "KARNATAKA", "-50.00", "487.00"),
    [
      "5 Oct 2026 9:00:00 am UTC",
      "S1",
      "Refund",
      "402-1",
      "LED-12",
      "LED panel 12W",
      1,
      "amazon.in",
      "Card",
      "Merchant",
      "PUNE",
      "KARNATAKA",
      "411001",
      "-500.00",
      "0",
      "0",
      "0",
      "-90.00",
      "0",
      "0",
      "2.50",
      "0",
      "50.00",
      "0",
      "50.00",
      "0",
      "-487.50",
      "Released",
      "",
    ],
    [
      "6 Oct 2026 9:00:00 am UTC",
      "S1",
      "Shipping Services",
      "402-1",
      "",
      "Easy Ship weight handling fees",
      "",
      "amazon.in",
      "",
      "Merchant",
      "",
      "",
      "",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "-88.50",
      "0",
      "-88.50",
      "Released",
      "",
    ],
    [
      "7 Oct 2026 9:00:00 am UTC",
      "S1",
      "Service Fee",
      "",
      "",
      "Cost of Advertising",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "-100.00",
      "-18.00",
      "-118.00",
      "Released",
      "",
    ],
    [
      "8 Oct 2026 10:30:00 pm UTC",
      "S1",
      "Transfer",
      "",
      "",
      "To account ending with: 999",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "-700.00",
      "-700.00",
      "Released",
      "",
    ],
  );

// Myntra's P&L workbook: a summary sheet, a glossary, and totals by SKU.
const myntraBook = (month = "October 2026") => [
  {
    name: "PnL_Summary",
    rows: [
      ["Report Specifications"],
      ["Report Type:", "Profit & Loss Report"],
      ["Orders Received During:", month],
      ["Item", "Amount (INR)", "Units"],
      ["Gross Sales", "3000", "4"],
      ["Returns and Cancellations", "-500", "-1"],
    ],
  },
  {
    name: "Glossary",
    rows: [
      ["Column Name", "Description"],
      ["sku_code", "Seller's SKU code for the product"],
    ],
  },
  {
    name: "SKU_Detail",
    rows: [
      [
        "seller_id",
        "sku_code",
        "article_type",
        "brand_name",
        "GrossSalesAmount",
        "GrossSalesUnit",
        "ReturnsandCancellationsAmount",
        "ReturnsandCancellationsUnit",
        "FwdCommissionFee",
        "RevCommissionFee",
        "FwdTaxesTCS",
        "RevTaxesTCS",
        "FwdTaxesTDS",
        "RevTaxesTDS",
        "FwdLogisticCharge",
        "RevLogisticCharge",
        "BankSettlement_Projected",
        "BankSettlement_Settled",
      ],
      ["1", "SW-6A", "Switches", "Kaveri", "2000", "3", "500", "1", "100", "25", "10", "2.5", "2", "0.5", "80", "60", "1776", "1500"],
      ["1", "MY-LAMP", "Lamps", "Kaveri", "1000", "1", "0", "0", "50", "0", "5", "0", "1", "0", "40", "0", "904", "904"],
    ],
  },
];

describe("Amazon's transaction report and Myntra's P&L", () => {
  it("reads Amazon's posted times as the date in India, and full month names", () => {
    expect(dateOf("1 Oct 2026 8:33:52 am UTC")).toBe("2026-10-01");
    expect(dateOf("1 Oct 2026 8:40:00 pm UTC")).toBe("2026-10-02");
    expect(dateOf("1 October 2026")).toBe("2026-10-01");
    expect(dateOf("September 3, 2026")).toBe("2026-09-03");
  });

  it("counts orders and refunds with GST, and puts fees, TCS, TDS and transfers in a payout", () => {
    const o = office();
    const [imp] = file(o, "Amazon Sales Report.csv", amazonTxn());
    expect(imp).toMatchObject({ format: "amazon-transactions", channel: "amazon", status: "read", lines: 3, skipped: [] });
    expect(imp!.note).toMatch(/1 order, ₹1,770.*3 rows of fees and transfers went into the payout.*paid ₹700 to your bank, last on 9 Oct/);
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.find((l) => l.sellerSku === "SW-6A")).toMatchObject({
      status: "sold",
      grossPaise: 118000,
      taxablePaise: 100000,
      taxPaise: 18000,
      state: "29",
      item: "Modular switch 6A",
      date: "2026-10-01",
    });
    expect(lines.find((l) => l.sellerSku === "LED-12" && l.status === "sold")!.date).toBe("2026-10-02");
    expect(lines.find((l) => l.status === "returned")).toMatchObject({ grossPaise: 59000, qty: 1 });
    const [p] = o.sales.store.payouts(5);
    expect(p).toMatchObject({ channel: "amazon", netPaise: 70000, paidOn: "2026-10-09", from: "2026-10-01", to: "2026-10-09" });
    const part = (label: string) => p!.parts.find((x) => x.label === label)?.paise;
    expect(part("Sales, with GST")).toBe(177000);
    expect(part("Refunds, with GST")).toBe(-59000);
    expect(part("Tax withheld: TCS")).toBe(-250);
    expect(part("Advertising")).toBe(-11800);
    expect(part("Fees: shipping")).toBe(-8850);
    // The parts add up to what was paid: what Amazon still holds is one of them.
    expect(p!.parts.reduce((a, x) => a + x.paise, 0)).toBe(70000);
  });

  it("reads Myntra's P&L as one report of sales and returns by SKU, with no orders and its payout", () => {
    const o = office();
    const [imp, ...rest] = o.sales.receive({ file: "Myntra Sales Report.xlsx", sheets: myntraBook(), hash: "m1", via: "upload", sender: null });
    expect(rest).toHaveLength(0);
    expect(o.books.staged.filter((s) => s.kind === "sales_mapping")).toHaveLength(0);
    expect(imp).toMatchObject({ format: "myntra-pnl", channel: "myntra", status: "read", lines: 3, period: { from: "2026-10-31", to: "2026-10-31" } });
    expect(imp!.note).toMatch(/^4 units, ₹3,000, 31 Oct\. Myntra expects to pay ₹2,680 for the month; ₹2,404 settled so far/);
    const lines = o.sales.store.lines("2026-10-01", "2026-10-31");
    expect(lines.every((l) => l.order === "" && l.channel === "myntra")).toBe(true);
    expect(lines.find((l) => l.sellerSku === "SW-6A" && l.status === "returned")).toMatchObject({ qty: 1, grossPaise: 50000, item: "Kaveri Switches (SW-6A)" });
    const [p] = o.sales.store.payouts(5);
    expect(p).toMatchObject({ channel: "myntra", netPaise: 268000, from: "2026-10-01", to: "2026-10-31" });
    expect(p!.parts.find((x) => x.label === "Fees: commission")!.paise).toBe(-12500);

    // Alongside Amazon: Myntra's sales count, but not in orders or the average order.
    file(o, "Amazon Sales Report.csv", amazonTxn());
    const r = o.sales.report();
    expect(r.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.channels.find((c) => c.channel === "myntra")).toMatchObject({ orders: 0, units: 4, grossPaise: 300000, aovPaise: 0 });
    expect(r.totals).toMatchObject({ orders: 1, grossPaise: 477000, aovPaise: 177000, vsPreviousPct: null });

    // The same month sent again under another name is not counted twice.
    const [again] = o.sales.receive({ file: "Myntra Oct.xlsx", sheets: myntraBook(), hash: "m2", via: "email", sender: "reports@myntra.com" });
    expect(again).toMatchObject({ lines: 3, repeated: 3 });
  });

  it("says so when Myntra's report does not give its month", () => {
    const o = office();
    const [imp] = o.sales.receive({
      file: "Myntra.xlsx",
      sheets: myntraBook("").map((s) => (s.name === "PnL_Summary" ? { ...s, rows: s.rows.filter((r) => !/received/i.test(r[0]!)) } : s)),
      hash: "m3",
      via: "upload",
      sender: null,
    });
    expect(imp).toMatchObject({ lines: 0, note: "Nothing could be read: The report does not say which month it covers." });
  });
});
