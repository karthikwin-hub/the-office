import { DatabaseSync } from "node:sqlite";
import { OfficeService } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { parseInbound } from "../src/mail";
import { fromPlatform, isSheetFile, readSalesFile, salesReply, SqlSalesStore } from "../src/sales";

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

const MTR = [
  "Invoice Number,Invoice Date,Transaction Type,Order Id,Quantity,Sku,Ship To City,Ship To State,Invoice Amount,Tax Exclusive Gross,Total Tax Amount",
  "IN-1,2026-10-02,Shipment,402-1,2,SW-6A,PUNE,MAHARASHTRA,1180.00,1000.00,180.00",
  "CN-1,2026-10-09,Refund,402-1,1,SW-6A,PUNE,MAHARASHTRA,-590.00,-500.00,-90.00",
].join("\n");
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function office(sql = sqlStorage()) {
  const o = new OfficeService(loadBooks(), { asOf: "2026-11-04", sales: new SqlSalesStore(sql) });
  o.setHiring("marketplace-manager", { hired: true, trustLevel: "trainee" });
  return o;
}

describe("online sales on the server", () => {
  it("keeps lines in the office's own SQLite, once each, and apart from another office", async () => {
    const a = office();
    const b = office();
    const r = await readSalesFile(a, { name: "MTR.csv", bytes: bytes(MTR), via: "email", sender: "no-reply@amazon.in" });
    expect(r[0]).toMatchObject({ status: "read", format: "amazon-mtr-b2c", lines: 2 });
    expect(salesReply(r)).toMatch(/^Read Amazon tax report \(B2C\): 1 order, ₹1,180/);
    expect((await readSalesFile(a, { name: "MTR copy.csv", bytes: bytes(MTR), via: "email", sender: null }))[0]!.status).toBe("duplicate");
    expect(a.sales.store.lines("2026-10-01", "2026-10-31")).toHaveLength(2);
    expect(a.sales.store.lastDate()).toBe("2026-10-09");
    expect(b.sales.store.lines("2026-10-01", "2026-10-31")).toHaveLength(0);
    expect(a.sales.report().totals).toMatchObject({ orders: 1, grossPaise: 118000, returnedPaise: 59000 });
  });

  it("keeps a large sheet waiting for its columns in pieces, and reads it once mapped", async () => {
    const o = office();
    const rows = Array.from({ length: 20_000 }, (_, i) => `05/10/2026,PO-${i},LED panel with a fairly long description ${i},Mumbai,1,590`);
    const [imp] = await readSalesFile(o, {
      name: "blinkit.csv",
      bytes: bytes(["Date,PO Number,Item Name,City,Qty Sold,GMV", ...rows].join("\n")),
      via: "upload",
      sender: "owner@x.test",
    });
    expect(imp).toMatchObject({ status: "needs_mapping", channel: "blinkit" });
    expect(o.sales.store.pending(imp!.id)!.rows).toHaveLength(20_001);
    const done = o.sales.applyMapping(imp!.id, "blinkit", { date: "Date", order: "PO Number", qty: "Qty Sold", gross: "GMV", city: "City", item: "Item Name" });
    expect(done).toMatchObject({ status: "read", lines: 20_000 });
    expect(o.sales.store.pending(imp!.id)).toBeNull();
  });

  it("says why a file cannot be read", async () => {
    const o = office();
    const [imp] = await readSalesFile(o, {
      name: "old.xls",
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer as ArrayBuffer,
      via: "whatsapp",
      sender: null,
    });
    expect(imp).toMatchObject({ status: "unreadable", note: expect.stringContaining(".xlsx") });
  });

  it("knows the platforms' mail and spreadsheet files", () => {
    expect(fromPlatform("no-reply@amazon.in")).toBe(true);
    expect(fromPlatform("reports@seller.flipkart.com")).toBe(true);
    expect(fromPlatform("someone@amazon.in.example.com")).toBe(false);
    expect(isSheetFile("MTR.zip", "application/octet-stream")).toBe(true);
    expect(isSheetFile(null, "text/csv")).toBe(true);
    expect(isSheetFile("bill.pdf", "application/pdf")).toBe(false);
  });

  it("keeps spreadsheets in an email only for the sales address", async () => {
    const raw = [
      "From: a@b.test",
      "To: x@y.test",
      "Subject: r",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      'Content-Type: text/csv; name="r.csv"',
      'Content-Disposition: attachment; filename="r.csv"',
      "",
      "a,b",
      "--b",
      'Content-Type: application/pdf; name="bill.pdf"',
      'Content-Disposition: attachment; filename="bill.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa("%PDF-1.4"),
      "--b--",
      "",
    ].join("\r\n");
    const bills = await parseInbound(bytes(raw));
    expect(bills.attachments.map((a) => a.filename)).toEqual(["bill.pdf"]);
    expect(bills.skipped).toEqual(["r.csv"]);
    const sales = await parseInbound(bytes(raw), { sheets: true });
    expect(sales.attachments.map((a) => a.filename)).toEqual(["r.csv"]);
  });
});
