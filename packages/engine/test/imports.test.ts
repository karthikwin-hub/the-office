import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { auditReport } from "../src/audit";
import { dispatch } from "../src/dispatch";
import { extractInvoice, type TextItem } from "../src/extract";
import { computeGstr1, computeGstr3b } from "../src/gst";
import { ImportError, importReturn, parseCsv } from "../src/imports";
import { OfficeService } from "../src/office";
import { tdsReport } from "../src/reports";

const fresh = () => new OfficeService(loadBooks());
const forms = (o: OfficeService, period: string) => auditReport(o.ledger, period).findings.map((f) => f.form);

describe("importing filed returns", () => {
  it("a corrected GSTR-1 clears the missing-invoice finding", () => {
    const o = fresh();
    const period = "2026-10";
    expect(forms(o, period)).toContain("GSTR-1");
    const r = o.importReturn(JSON.stringify(computeGstr1(o.ledger, period)), "Rajesh Mehta", "2026-11-11");
    expect(r).toMatchObject({ form: "GSTR-1", period });
    expect(forms(o, period)).not.toContain("GSTR-1");
    expect(o.books.filedReturns.filter((f) => f.form === "GSTR-1" && f.period === period)).toHaveLength(1);
  });

  it("reads GSTR-3B from the portal's JSON, ignoring fields it does not use", () => {
    const o = fresh();
    const period = "2026-10";
    const portal = { ...computeGstr3b(o.ledger, period), inward_sup: { isup_details: [] }, intr_ltfee: {} };
    o.importReturn(JSON.stringify(portal), "Rajesh Mehta");
    expect(forms(o, period)).not.toContain("GSTR-3B");
  });

  it("reads 26Q from CSV and finds the short deduction again", () => {
    const o = fresh();
    const rep = tdsReport(o.ledger, "FY2026-27-Q2");
    const header = "Section,Deductee PAN,Deductee name,Bill no,Paid on,Amount paid,TDS,Deposited on";
    const csv = (rate: (d: (typeof rep.deductions)[number]) => number) =>
      [header, ...rep.deductions.map((d) => [d.section, d.pan, `"${d.vendor}"`, o.ledger.bill(d.billId)!.number, d.date, (d.basePaise / 100).toFixed(2), (rate(d) / 100).toFixed(2), d.date.slice(0, 8) + "28"].join(","))].join("\n");
    o.importReturn(csv((d) => d.expectedPaise), "Rajesh Mehta");
    expect(forms(o, "FY2026-27-Q2")).not.toContain("26Q");
    o.importReturn(csv((d) => (d.section === "194J" ? Math.round(d.expectedPaise / 5) : d.expectedPaise)), "Rajesh Mehta");
    expect(forms(o, "FY2026-27-Q2")).toContain("26Q");
  });

  it("flattens the portal's nested GSTR-2B", () => {
    const o = fresh();
    const s = o.books.gstr2b[0]!;
    const portal = {
      data: {
        gstin: s.data.gstin,
        rtnprd: s.data.rtnprd,
        docdata: { b2b: s.data.docdata.b2b.map((e) => ({ ctin: e.ctin, trdnm: e.trdnm, inv: [{ inum: e.inum, dt: e.idt, val: e.val, items: [{ num: 1, rt: 18, txval: e.txval, igst: e.iamt, cgst: e.camt, sgst: e.samt }] }] })) },
      },
    };
    const r = importReturn(o.ledger, JSON.stringify(portal), null);
    expect(r.kind).toBe("gstr2b");
    if (r.kind === "gstr2b") expect(r.statement.data.docdata.b2b).toEqual(s.data.docdata.b2b);
  });

  it("refuses another business's return and unknown files", () => {
    const o = fresh();
    const other = { ...computeGstr3b(o.ledger, "2026-10"), gstin: "29ABCDE1234F1Z5" };
    expect(() => importReturn(o.ledger, JSON.stringify(other), null)).toThrow(ImportError);
    expect(() => importReturn(o.ledger, '{"hello":1}', null)).toThrow(/not a GSTR-1/);
    const res = dispatch(o, { method: "POST", path: "/api/returns/import", query: new URLSearchParams(), body: { content: "nonsense" }, role: "accountant", user: { name: "R", email: "r@x" }, mode: "mock" });
    expect(res.status).toBe(422);
  });

  it("parses quoted CSV cells", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
  });
});

describe("a supplier seen for the first time", () => {
  it("is added with the bill and the bill waits for approval", () => {
    const o = fresh();
    o.receiveDocument({ id: "doc-u0100", file: "/x.pdf", channel: "upload", from: "accounts@newco.in", pages: 1 });
    const row = (str: string, x: number, y: number): TextItem => ({ str, page: 1, x, y, w: 0.01 * str.length, h: 0.015 });
    const items = [
      row("Newco Wires", 0.07, 0.04),
      row("GSTIN 27AAACN1234F1Z1", 0.07, 0.07),
      row("Bill no", 0.07, 0.11),
      row("NW/1", 0.07, 0.13),
      row("Date", 0.34, 0.11),
      row("03 Nov 2026", 0.34, 0.13),
      row("Billed to", 0.55, 0.11),
      row("Kaveri Electricals Private Limited", 0.55, 0.13),
      row("Description", 0.1, 0.2),
      row("HSN", 0.42, 0.2),
      row("Qty", 0.53, 0.2),
      row("Rate", 0.62, 0.2),
      row("Taxable", 0.72, 0.2),
      row("GST", 0.82, 0.2),
      row("Tax", 0.9, 0.2),
      row("Copper wire", 0.1, 0.23),
      row("8544", 0.42, 0.23),
      row("10 ROL", 0.53 + 0.03 - 0.06, 0.23),
      row("100.00", 0.62 + 0.04 - 0.06, 0.23),
      row("1,000.00", 0.72 + 0.07 - 0.08, 0.23),
      row("18%", 0.82 + 0.03 - 0.03, 0.23),
      row("180.00", 0.9 + 0.03 - 0.06, 0.23),
      row("Taxable value", 0.66, 0.3),
      row("1,000.00", 0.85, 0.3),
      row("CGST", 0.66, 0.32),
      row("90.00", 0.87, 0.32),
      row("SGST", 0.66, 0.34),
      row("90.00", 0.87, 0.34),
      row("Total", 0.66, 0.37),
      row("1,180.00", 0.85, 0.37),
    ];
    expect(extractInvoice(items, o.books).partyId).toBeNull();
    const r = o.read("doc-u0100", items);
    expect(r.staged?.status).toBe("pending");
    const party = o.books.parties.find((p) => p.gstin === "27AAACN1234F1Z1");
    expect(party?.name).toBe("Newco Wires");
    expect(r.staged?.summary).toMatch(/not in your books yet/);
  });
});
