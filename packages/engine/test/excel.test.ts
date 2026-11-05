import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBooks } from "@office/fixtures";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { exportFile, gstr3bWorkbook, tdsWorkbook } from "../src/excel";
import { Ledger } from "../src/ledger";
import { gstReport, tdsReport } from "../src/reports";

const l = new Ledger(loadBooks());
const OUT = process.env.EXPORT_DIR;

async function open(bytes: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb;
}

/** Cached result of a formula cell, in paise. */
const paise = (wb: ExcelJS.Workbook, sheet: string, ref: string) => {
  const v = wb.getWorksheet(sheet)!.getCell(ref).value as { formula?: string; result?: number };
  expect(v.formula, `${sheet}!${ref} should be a formula`).toBeTruthy();
  return Math.round((v.result ?? 0) * 100);
};

describe("GSTR-3B working", () => {
  for (const period of gstReport(l).periods) {
    it(`agrees with the GST report for ${period}`, async () => {
      const file = await gstr3bWorkbook(l, period);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, file.filename), Buffer.from(file.bytes));
      }
      const wb = await open(file.bytes);
      expect(wb.worksheets.map((w) => w.name)).toEqual(["GSTR-3B", "Outward supplies", "Input credit", "Notes"]);
      const rep = gstReport(l, period);
      expect(paise(wb, "GSTR-3B", "B6")).toBe(rep.outward.taxablePaise);
      expect(paise(wb, "GSTR-3B", "C10")).toBe(rep.itc.eligible.igstPaise);
      expect(paise(wb, "GSTR-3B", "D10")).toBe(rep.itc.eligible.cgstPaise);
      expect(paise(wb, "GSTR-3B", "E18")).toBe(rep.payable.totalPaise);
      expect(paise(wb, "GSTR-3B", "C17") + paise(wb, "GSTR-3B", "D17") + paise(wb, "GSTR-3B", "E17")).toBe(rep.payable.totalPaise);
    });
  }
});

describe("26Q working", () => {
  for (const quarter of tdsReport(l).quarters) {
    it(`agrees with the TDS report for ${quarter}`, async () => {
      const file = await tdsWorkbook(l, quarter);
      if (OUT) writeFileSync(join(OUT, file.filename), Buffer.from(file.bytes));
      const wb = await open(file.bytes);
      expect(wb.worksheets.map((w) => w.name)).toEqual(["By section", "Deductions", "Deducted by customers", "Notes"]);
      const rep = tdsReport(l, quarter);
      const total = wb.getWorksheet("By section")!.getColumn(1).values.indexOf("Total");
      expect(paise(wb, "By section", `F${total}`)).toBe(rep.bySection.reduce((a, s) => a + s.tdsPaise, 0));
    });
  }
});

describe("export routes", () => {
  it("serves the workbooks and ignores other paths", async () => {
    const period = gstReport(l).period;
    const f = await exportFile(l, `/api/exports/gstr3b/${period}`);
    expect(f?.filename).toMatch(/^GSTR3B_.*\.xlsx$/);
    expect(await exportFile(l, "/api/exports/gstr1/2026-09")).toBeNull();
    expect(await exportFile(l, "/api/office")).toBeNull();
  });
});
