import { BRAND } from "@office/contracts";
import type { Cell, Workbook, Worksheet } from "exceljs";
import { dateLabel, monthLabel, quarterLabel } from "./dates";
import { itcFor, outwardFor, setOff } from "./gst";
import type { Ledger } from "./ledger";
import { tdsReport } from "./reports";
import { SECTION_NOTE, TDS_RULES, tdsDepositDue } from "./tds";

/**
 * Working papers for the GSTR-3B and 26Q returns. Figures copied from the books
 * are blue; everything derived from them is a live formula, so the accountant can
 * correct a row and see the return change. Cached results come from the engine,
 * so a previewer that does not recalculate still shows the engine's numbers.
 */

export type ExportFile = { filename: string; contentType: string; bytes: ArrayBuffer };

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FONT = "Arial";
const BLUE = { argb: "FF0000FF" };
const BLACK = { argb: "FF000000" };
const GREEN = { argb: "FF008000" };
const MONEY = '#,##0.00;(#,##0.00);"-"';
const DATE = "dd-mm-yyyy";
const RULE = { style: "thin" as const, color: { argb: "FF999999" } };

type Tone = "input" | "formula" | "link";
const TONE = { input: BLUE, formula: BLACK, link: GREEN };

const rupees = (paise: number) => paise / 100;
const excelDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const col = (n: number) => String.fromCharCode(64 + n);

function put(cell: Cell, value: unknown, opts: { tone?: Tone; fmt?: string; bold?: boolean; result?: number } = {}) {
  if (typeof value === "string" && value.startsWith("=")) {
    cell.value = { formula: value.slice(1), result: opts.result } as never;
  } else cell.value = value as never;
  cell.font = { name: FONT, size: 10, bold: opts.bold, color: TONE[opts.tone ?? "input"] };
  if (opts.fmt) cell.numFmt = opts.fmt;
}

function label(cell: Cell, text: string, bold = false) {
  cell.value = text;
  cell.font = { name: FONT, size: 10, bold };
}

function header(ws: Worksheet, row: number, titles: string[], widths?: number[]) {
  titles.forEach((t, i) => {
    const c = ws.getCell(row, i + 1);
    label(c, t, true);
    c.border = { bottom: RULE };
    c.alignment = { vertical: "bottom", wrapText: true };
  });
  if (widths) widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
}

function heading(ws: Worksheet, l: Ledger, title: string) {
  const b = l.books.business;
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { name: FONT, size: 13, bold: true };
  label(ws.getCell("A2"), `${b.legalName} · GSTIN ${b.gstin} · TAN ${b.tan}`);
  label(ws.getCell("A3"), `From the books as of ${dateLabel(l.asOf)}. Amounts in rupees.`);
  ws.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

const quarterTitle = (q: string) => `${quarterLabel(q)}, FY ${q.slice(2, 9)}`;

async function newBook(l: Ledger): Promise<Workbook> {
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = BRAND.name;
  wb.created = excelDate(l.asOf);
  return wb;
}

async function finish(wb: Workbook, filename: string): Promise<ExportFile> {
  const buf = await wb.xlsx.writeBuffer();
  const bytes = buf instanceof ArrayBuffer ? buf : (buf as Uint8Array).buffer.slice((buf as Uint8Array).byteOffset, (buf as Uint8Array).byteOffset + (buf as Uint8Array).byteLength);
  return { filename, contentType: XLSX, bytes: bytes as ArrayBuffer };
}

function notes(wb: Workbook, l: Ledger, lines: [string, string][]) {
  const ws = wb.addWorksheet("Notes");
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 100;
  heading(ws, l, "Notes and assumptions");
  let r = 5;
  const legend: [string, Tone][] = [
    ["Blue figures are copied from the books; change them only if the books are wrong.", "input"],
    ["Black figures are formulas.", "formula"],
    ["Green figures are carried from another sheet.", "link"],
  ];
  for (const [text, tone] of legend) put(ws.getCell(r++, 1), text, { tone });
  r++;
  for (const [k, v] of lines) {
    label(ws.getCell(r, 1), k, true);
    label(ws.getCell(r, 2), v);
    ws.getCell(r, 2).alignment = { wrapText: true, vertical: "top" };
    ws.getCell(r, 1).alignment = { vertical: "top" };
    r++;
  }
}

/** GSTR-3B working for a month: outward supplies, input credit and the rule 88A set-off. */
export async function gstr3bWorkbook(l: Ledger, period: string): Promise<ExportFile> {
  const out = outwardFor(l, period);
  const itc = itcFor(l, period);
  const missing = new Set(itc.notIn2b.map((b) => b.id));
  const wb = await newBook(l);
  const sum = wb.addWorksheet("GSTR-3B", { views: [{ showGridLines: false }] });
  const os = wb.addWorksheet("Outward supplies", { views: [{ state: "frozen", ySplit: 5 }] });
  const is = wb.addWorksheet("Input credit", { views: [{ state: "frozen", ySplit: 5 }] });

  heading(os, l, `Outward supplies, ${monthLabel(period)}`);
  header(os, 5, ["Invoice", "Date", "Customer", "Customer GSTIN", "Place of supply", "Taxable value", "Integrated tax", "Central tax", "State tax"], [14, 12, 34, 18, 10, 15, 15, 15, 15]);
  let r = 6;
  for (const inv of [...out.invoices].sort((a, b) => (a.date === b.date ? (a.number < b.number ? -1 : 1) : a.date < b.date ? -1 : 1))) {
    const p = l.party(inv.partyId);
    put(os.getCell(r, 1), inv.number);
    put(os.getCell(r, 2), excelDate(inv.date), { fmt: DATE });
    put(os.getCell(r, 3), p.name);
    put(os.getCell(r, 4), p.gstin ?? "");
    put(os.getCell(r, 5), inv.placeOfSupply);
    [inv.totals.taxablePaise, inv.totals.igstPaise, inv.totals.cgstPaise, inv.totals.sgstPaise].forEach((v, i) => put(os.getCell(r, 6 + i), rupees(v), { fmt: MONEY }));
    r++;
  }
  if (r === 6) label(os.getCell(r++, 1), "No sales invoices this month.");
  const osTotal = r;
  const osLast = r - 1;
  label(os.getCell(osTotal, 1), "Total", true);
  [out.taxablePaise, out.igstPaise, out.cgstPaise, out.sgstPaise].forEach((v, i) => {
    const c = os.getCell(osTotal, 6 + i);
    put(c, `=SUM(${col(6 + i)}6:${col(6 + i)}${osLast})`, { tone: "formula", fmt: MONEY, bold: true, result: rupees(v) });
    c.border = { top: RULE };
  });
  os.autoFilter = { from: "A5", to: `I${osLast}` };

  heading(is, l, `Input tax credit, ${monthLabel(period)}`);
  header(is, 5, ["Bill", "Date", "Supplier", "Supplier GSTIN", "Taxable value", "Integrated tax", "Central tax", "State tax", "In GSTR-2B"], [16, 12, 34, 18, 15, 15, 15, 15, 12]);
  r = 6;
  for (const b of [...itc.bills].sort((a, b) => (a.date === b.date ? (a.number < b.number ? -1 : 1) : a.date < b.date ? -1 : 1))) {
    const p = l.party(b.partyId);
    put(is.getCell(r, 1), b.number);
    put(is.getCell(r, 2), excelDate(b.date), { fmt: DATE });
    put(is.getCell(r, 3), p.name);
    put(is.getCell(r, 4), p.gstin ?? "");
    [b.totals.taxablePaise, b.totals.igstPaise, b.totals.cgstPaise, b.totals.sgstPaise].forEach((v, i) => put(is.getCell(r, 5 + i), rupees(v), { fmt: MONEY }));
    put(is.getCell(r, 9), !itc.has2b ? "No statement" : missing.has(b.id) ? "No" : "Yes");
    r++;
  }
  if (r === 6) label(is.getCell(r++, 1), "No purchase bills this month.");
  const isTotal = r;
  const isLast = r - 1;
  label(is.getCell(isTotal, 1), "Total in the books", true);
  [itc.books.taxablePaise, itc.books.igstPaise, itc.books.cgstPaise, itc.books.sgstPaise].forEach((v, i) => {
    const c = is.getCell(isTotal, 5 + i);
    put(c, `=SUM(${col(5 + i)}6:${col(5 + i)}${isLast})`, { tone: "formula", fmt: MONEY, bold: true, result: rupees(v) });
    c.border = { top: RULE };
  });
  is.autoFilter = { from: "A5", to: `I${isLast}` };

  const so = setOff(out, itc.eligible);
  const notIn2b = itc.notIn2b.reduce((a, b) => ({ i: a.i + b.totals.igstPaise, c: a.c + b.totals.cgstPaise, s: a.s + b.totals.sgstPaise }), { i: 0, c: 0, s: 0 });
  // Engine-side steps of the set-off, used only as cached results for the formulas below.
  const O = { i: out.igstPaise, c: out.cgstPaise, s: out.sgstPaise };
  const C = { i: itc.eligible.igstPaise, c: itc.eligible.cgstPaise, s: itc.eligible.sgstPaise };
  const ii = Math.min(C.i, O.i);
  const ic = Math.min(C.i - ii, O.c);
  const is_ = Math.min(C.i - ii - ic, O.s);
  const cc = Math.min(C.c, O.c - ic);
  const ci = Math.min(C.c - cc, O.i - ii);
  const ss = Math.min(C.s, O.s - is_);
  const si = Math.min(C.s - ss, O.i - ii - ci);

  heading(sum, l, `GSTR-3B working, ${monthLabel(period)}`);
  [44, 16, 16, 16, 16, 12].forEach((w, i) => (sum.getColumn(i + 1).width = w));
  header(sum, 5, ["Table 3.1 and 4", "Taxable value", "Integrated tax", "Central tax", "State tax", "Cess"]);
  const OS = "'Outward supplies'";
  const IS = "'Input credit'";
  label(sum.getCell("A6"), "3.1(a) Outward taxable supplies");
  put(sum.getCell("B6"), `=${OS}!F${osTotal}`, { tone: "link", fmt: MONEY, result: rupees(out.taxablePaise) });
  put(sum.getCell("C6"), `=${OS}!G${osTotal}`, { tone: "link", fmt: MONEY, result: rupees(O.i) });
  put(sum.getCell("D6"), `=${OS}!H${osTotal}`, { tone: "link", fmt: MONEY, result: rupees(O.c) });
  put(sum.getCell("E6"), `=${OS}!I${osTotal}`, { tone: "link", fmt: MONEY, result: rupees(O.s) });
  put(sum.getCell("F6"), 0, { fmt: MONEY });
  sum.getCell("F6").note = "No goods sold attract compensation cess.";

  label(sum.getCell("A8"), "4(A)(5) All other input credit in the books");
  put(sum.getCell("C8"), `=${IS}!F${isTotal}`, { tone: "link", fmt: MONEY, result: rupees(itc.books.igstPaise) });
  put(sum.getCell("D8"), `=${IS}!G${isTotal}`, { tone: "link", fmt: MONEY, result: rupees(itc.books.cgstPaise) });
  put(sum.getCell("E8"), `=${IS}!H${isTotal}`, { tone: "link", fmt: MONEY, result: rupees(itc.books.sgstPaise) });
  label(sum.getCell("A9"), "Less credit not yet in GSTR-2B");
  const crit = `${IS}!$I$6:$I$${isLast}`;
  put(sum.getCell("C9"), `=SUMIFS(${IS}!F6:F${isLast},${crit},"No")`, { tone: "formula", fmt: MONEY, result: rupees(notIn2b.i) });
  put(sum.getCell("D9"), `=SUMIFS(${IS}!G6:G${isLast},${crit},"No")`, { tone: "formula", fmt: MONEY, result: rupees(notIn2b.c) });
  put(sum.getCell("E9"), `=SUMIFS(${IS}!H6:H${isLast},${crit},"No")`, { tone: "formula", fmt: MONEY, result: rupees(notIn2b.s) });
  label(sum.getCell("A10"), "4(C) Net input credit available", true);
  (["C", "D", "E"] as const).forEach((c, i) => {
    const cell = sum.getCell(`${c}10`);
    put(cell, `=${c}8-${c}9`, { tone: "formula", fmt: MONEY, bold: true, result: rupees([C.i, C.c, C.s][i]!) });
    cell.border = { top: RULE };
  });

  header(sum, 12, ["6.1 Payment of tax (rule 88A order)", "", "Integrated tax", "Central tax", "State tax", ""]);
  const rows: [string, string, string, string, number[]][] = [
    ["Tax due", "=C6", "=D6", "=E6", [O.i, O.c, O.s]],
    ["Paid from integrated tax credit", "=MIN($C$10,C13)", "=MIN($C$10-C14,D13)", "=MIN($C$10-C14-D14,E13)", [ii, ic, is_]],
    ["Paid from central tax credit", "=MIN($D$10-D15,C13-C14)", "=MIN($D$10,D13-D14)", "0", [ci, cc, 0]],
    ["Paid from state tax credit", "=MIN($E$10-E16,C13-C14-C15)", "0", "=MIN($E$10,E13-E14)", [si, 0, ss]],
  ];
  rows.forEach(([name, a, b, c, res], k) => {
    const row = 13 + k;
    label(sum.getCell(row, 1), name);
    [a, b, c].forEach((f, j) => put(sum.getCell(row, 3 + j), f === "0" ? 0 : f, { tone: f === "0" ? "input" : "formula", fmt: MONEY, result: rupees(res[j]!) }));
  });
  label(sum.getCell("A17"), "Paid in cash", true);
  (["C", "D", "E"] as const).forEach((c, j) => {
    const cell = sum.getCell(`${c}17`);
    put(cell, `=${c}13-SUM(${c}14:${c}16)`, { tone: "formula", fmt: MONEY, bold: true, result: rupees([so.payable.igstPaise, so.payable.cgstPaise, so.payable.sgstPaise][j]!) });
    cell.border = { top: RULE };
  });
  label(sum.getCell("A18"), "Total cash payable", true);
  put(sum.getCell("E18"), "=SUM(C17:E17)", { tone: "formula", fmt: MONEY, bold: true, result: rupees(so.payable.totalPaise) });
  label(sum.getCell("A20"), "Credit carried forward");
  put(sum.getCell("C20"), "=C10-SUM(C14:E14)", { tone: "formula", fmt: MONEY, result: rupees(so.carriedForward.igstPaise) });
  put(sum.getCell("D20"), "=D10-SUM(C15:E15)", { tone: "formula", fmt: MONEY, result: rupees(so.carriedForward.cgstPaise) });
  put(sum.getCell("E20"), "=E10-SUM(C16:E16)", { tone: "formula", fmt: MONEY, result: rupees(so.carriedForward.sgstPaise) });

  notes(wb, l, [
    ["Source", `Posted sales invoices and purchase bills dated in ${monthLabel(period)}, as held by ${BRAND.name} on ${dateLabel(l.asOf)}. Each row names the invoice or bill it came from.`],
    ["Input credit", itc.has2b ? "Credit is claimed only for bills the supplier has reported in GSTR-2B (CGST Act s.16(2)(aa)). Bills marked No are held back and can be claimed in the month they appear." : "No GSTR-2B statement was on file, so all credit in the books is shown as provisional. Check it against GSTR-2B before filing."],
    ["Set-off", "Integrated tax credit is used first, against integrated, then central, then state tax. Central tax credit is used against central then integrated tax, and state tax credit against state then integrated tax. Central and state credit never cross (CGST Act s.49, rule 88A)."],
    ["Cess", "Nil. None of the goods sold attract compensation cess; the value is typed in, not computed."],
    ["Not included", "Interest, late fees, reverse charge supplies, exports and amendments to earlier months. Confirm these with your chartered accountant before filing."],
  ]);
  return finish(wb, `GSTR3B_${l.books.business.gstin}_${period}.xlsx`);
}

/** 26Q working for a quarter: deductions by bill, a section summary and TDS customers owe us. */
export async function tdsWorkbook(l: Ledger, quarter: string): Promise<ExportFile> {
  const rep = tdsReport(l, quarter);
  const wb = await newBook(l);
  const ss = wb.addWorksheet("By section", { views: [{ showGridLines: false }] });
  const ds = wb.addWorksheet("Deductions", { views: [{ state: "frozen", ySplit: 5 }] });
  const rs = wb.addWorksheet("Deducted by customers", { views: [{ state: "frozen", ySplit: 5 }] });

  heading(ds, l, `TDS deductions, ${quarterTitle(quarter)}`);
  header(ds, 5, ["Bill", "Date", "Deductee", "PAN", "Section", "Amount liable", "Rate", "TDS as per rules", "TDS booked", "Short (excess)", "Deposit due", "Reported in 26Q"], [16, 12, 32, 13, 9, 15, 8, 15, 15, 15, 12, 15]);
  const deds = [...rep.deductions].sort((a, b) => (a.date === b.date ? (a.billId < b.billId ? -1 : 1) : a.date < b.date ? -1 : 1));
  let r = 6;
  for (const d of deds) {
    const bill = l.bill(d.billId);
    put(ds.getCell(r, 1), bill?.number ?? d.billId);
    put(ds.getCell(r, 2), excelDate(d.date), { fmt: DATE });
    put(ds.getCell(r, 3), d.vendor);
    put(ds.getCell(r, 4), d.pan);
    put(ds.getCell(r, 5), d.section);
    put(ds.getCell(r, 6), rupees(d.basePaise), { fmt: MONEY });
    put(ds.getCell(r, 7), d.ruleRateBp / 10000, { fmt: "0.0%" });
    put(ds.getCell(r, 8), `=ROUND(F${r}*G${r},2)`, { tone: "formula", fmt: MONEY, result: rupees(d.expectedPaise) });
    put(ds.getCell(r, 9), rupees(d.bookedPaise), { fmt: MONEY });
    put(ds.getCell(r, 10), `=H${r}-I${r}`, { tone: "formula", fmt: MONEY, result: rupees(d.expectedPaise - d.bookedPaise) });
    put(ds.getCell(r, 11), excelDate(tdsDepositDue(d.date)), { fmt: DATE });
    if (d.filedPaise !== null) put(ds.getCell(r, 12), rupees(d.filedPaise), { fmt: MONEY });
    if (!d.ruleRateBp) ds.getCell(r, 7).note = `No deduction is due under the rules; the books deducted at ${d.bookedRateBp / 100}%.`;
    r++;
  }
  if (r === 6) label(ds.getCell(r++, 1), "No bills attract TDS this quarter.");
  const dLast = r - 1;
  const dTotal = r;
  label(ds.getCell(dTotal, 1), "Total", true);
  for (const c of [6, 8, 9, 10, 12]) {
    const cell = ds.getCell(dTotal, c);
    const values = deds.map((d) => [d.basePaise, d.expectedPaise, d.bookedPaise, d.expectedPaise - d.bookedPaise, d.filedPaise ?? 0][[6, 8, 9, 10, 12].indexOf(c)]!);
    put(cell, `=SUM(${col(c)}6:${col(c)}${dLast})`, { tone: "formula", fmt: MONEY, bold: true, result: rupees(values.reduce((a, b) => a + b, 0)) });
    cell.border = { top: RULE };
  }
  ds.autoFilter = { from: "A5", to: `L${dLast}` };

  heading(ss, l, `26Q working, ${quarterTitle(quarter)}`);
  header(ss, 5, ["Section", "Nature of payment", "Rate", "Deductees", "Amount liable", "TDS as per rules", "TDS booked", "Short (excess)"], [10, 32, 22, 11, 16, 16, 16, 16]);
  const D = "Deductions";
  const sections = Object.keys(TDS_RULES).sort() as (keyof typeof TDS_RULES)[];
  r = 6;
  for (const s of sections) {
    const rows = deds.filter((d) => d.section === s);
    const sec = `${D}!$E$6:$E$${dLast}`;
    put(ss.getCell(r, 1), s);
    label(ss.getCell(r, 2), TDS_RULES[s].nature);
    label(ss.getCell(r, 3), TDS_RULES[s].rateLabel);
    put(ss.getCell(r, 4), `=SUMPRODUCT((${sec}=A${r})/COUNTIFS(${D}!$D$6:$D$${dLast},${D}!$D$6:$D$${dLast},${sec},${sec}))`, { tone: "formula", fmt: "0", result: new Set(rows.map((d) => d.pan)).size });
    put(ss.getCell(r, 5), `=SUMIFS(${D}!$F$6:$F$${dLast},${sec},A${r})`, { tone: "formula", fmt: MONEY, result: rupees(rows.reduce((a, d) => a + d.basePaise, 0)) });
    put(ss.getCell(r, 6), `=SUMIFS(${D}!$H$6:$H$${dLast},${sec},A${r})`, { tone: "formula", fmt: MONEY, result: rupees(rows.reduce((a, d) => a + d.expectedPaise, 0)) });
    put(ss.getCell(r, 7), `=SUMIFS(${D}!$I$6:$I$${dLast},${sec},A${r})`, { tone: "formula", fmt: MONEY, result: rupees(rows.reduce((a, d) => a + d.bookedPaise, 0)) });
    put(ss.getCell(r, 8), `=F${r}-G${r}`, { tone: "formula", fmt: MONEY, result: rupees(rows.reduce((a, d) => a + d.expectedPaise - d.bookedPaise, 0)) });
    r++;
  }
  const sLast = r - 1;
  label(ss.getCell(r, 1), "Total", true);
  for (const c of [5, 6, 7, 8]) {
    const cell = ss.getCell(r, c);
    const v = deds.reduce((a, d) => a + [d.basePaise, d.expectedPaise, d.bookedPaise, d.expectedPaise - d.bookedPaise][c - 5]!, 0);
    put(cell, `=SUM(${col(c)}6:${col(c)}${sLast})`, { tone: "formula", fmt: MONEY, bold: true, result: rupees(v) });
    cell.border = { top: RULE };
  }

  heading(rs, l, `TDS deducted by customers under section 194Q, ${quarterTitle(quarter)}`);
  header(rs, 5, ["Invoice", "Customer", "Expected", "Credited in Form 26AS", "Not yet credited"], [14, 34, 15, 20, 16]);
  r = 6;
  for (const x of rep.receivable) {
    put(rs.getCell(r, 1), x.number);
    put(rs.getCell(r, 2), x.customer);
    put(rs.getCell(r, 3), rupees(x.expectedPaise), { fmt: MONEY });
    put(rs.getCell(r, 4), rupees(x.creditedPaise), { fmt: MONEY });
    put(rs.getCell(r, 5), `=C${r}-D${r}`, { tone: "formula", fmt: MONEY, result: rupees(x.expectedPaise - x.creditedPaise) });
    r++;
  }
  if (!rep.receivable.length) label(rs.getCell(6, 1), "No customer deducted TDS on invoices this quarter.");

  notes(wb, l, [
    ["Source", `Posted purchase bills dated in ${quarterLabel(quarter)}, as held by ${BRAND.name} on ${dateLabel(l.asOf)}. Each row names the bill it came from.`],
    ["Amount liable", "The amount the rate applies to. For section 194Q it is only the part of the year's purchases from that supplier above ₹50 lakh; for the other sections it is the bill's taxable value."],
    ["Thresholds", "194C: ₹1 lakh a year per contractor. 194J: ₹50,000 a year. 194H: ₹20,000 a year. 194I: ₹50,000 a month. 194Q: purchases above ₹50 lakh a year, and only when our turnover last year exceeded ₹10 crore."],
    ["Rates", "Typed in from the rules for each deductee (Finance Act 2025). A rule change needs the rate column updated, not the formulas."],
    ["Deposit due", "The 7th of the following month; 30 April for deductions made in March."],
    ["Section numbers", SECTION_NOTE],
  ]);
  return finish(wb, `26Q_${l.books.business.tan}_${quarter}.xlsx`);
}

/** File downloads served beside dispatch(): returns null for paths that are not exports. */
export async function exportFile(l: Ledger, path: string): Promise<ExportFile | null> {
  const [, kind, id] = path.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
  if (!path.startsWith("/api/exports/") || !id) return null;
  if (kind === "gstr3b" && /^\d{4}-\d{2}$/.test(id)) return gstr3bWorkbook(l, id);
  if (kind === "tds" && /^FY\d{4}-\d{2}-Q[1-4]$/.test(id)) return tdsWorkbook(l, id);
  return null;
}
