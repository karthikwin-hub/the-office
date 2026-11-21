import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { type ApiRequest, dispatch, OfficeService } from "../src";
import { findRegisterHeader, fromLayoutAnswer, guessBillMapping, readRegister, registerKind } from "../src/registers";

const books = loadBooks();
const local = books.parties.find((p) => p.kind === "vendor" && p.gstin?.startsWith(books.business.stateCode))!;
const away = books.parties.find((p) => p.kind === "vendor" && p.gstin && !p.gstin.startsWith(books.business.stateCode))!;
const ctx = { ...books, bills: [], invoices: [] };
const failed = (b: { extraction: { checks: { key: string; ok: boolean }[] } }) => b.extraction.checks.filter((c) => !c.ok).map((c) => c.key);

describe("a register of bills in a spreadsheet", () => {
  it("reads one bill per row, with tax split into CGST, SGST and IGST", () => {
    const rows = [
      ["Invoice No", "Invoice Date", "Supplier Name", "GSTIN/UIN", "Taxable Value", "CGST Amount", "SGST Amount", "IGST Amount", "Invoice Value"],
      ["SI/101", "03-11-2026", local.name, local.gstin!, "10,000.00", "900.00", "900.00", "", "11,800.00"],
      ["A-77", "04/11/2026", away.name, away.gstin!, "2500", "", "", "450", "2950"],
    ];
    const { at, mapping } = findRegisterHeader(rows);
    expect(at).toBe(0);
    expect(mapping).toMatchObject({
      number: "Invoice No",
      date: "Invoice Date",
      party: "Supplier Name",
      gstin: "GSTIN/UIN",
      taxable: "Taxable Value",
      igst: "IGST Amount",
      total: "Invoice Value",
    });
    const { bills, skipped } = readRegister({ name: "Purchases", rows, headerAt: at, mapping, kind: "purchase_bill", ctx });
    expect(skipped).toEqual([]);
    expect(bills).toHaveLength(2);
    const [a, b] = bills.map((x) => x.extraction);
    expect(a).toMatchObject({ number: "SI/101", date: "2026-11-03", partyId: local.id, intra: true, method: "sheet" });
    expect(a!.totals).toEqual({ taxablePaise: 10_000_00, cgstPaise: 900_00, sgstPaise: 900_00, igstPaise: 0, roundOffPaise: 0, totalPaise: 11_800_00 });
    expect(a!.lines[0]).toMatchObject({ gstRate: 18, cgstPaise: 900_00, sgstPaise: 900_00 });
    expect(b).toMatchObject({ number: "A-77", partyId: away.id, intra: false });
    expect(b!.totals.igstPaise).toBe(450_00);
    expect(bills.map(failed)).toEqual([[], []]);
    // Each figure points at its cell.
    expect(a!.regions.find((r) => r.key === "totals.total")?.cell).toEqual({ row: 0, col: 8 });
    expect(bills[0]!.sheet.rows[0]!.n).toBe(2);
  });

  it("reads one line per row, the bill's number repeated, and finds a total that does not add up", () => {
    const rows = [
      ["Bill No.", "Bill Date", "Vendor", "Item Description", "HSN/SAC", "Qty", "Rate", "Taxable Amount", "GST %", "Tax Amount", "Bill Amount"],
      ["KE-9", "2026-11-05", local.name, "Copper wire 2.5 sq mm", "8544", "10", "1,200.00", "12,000.00", "18%", "2,160.00", "15,576.00"],
      ["KE-9", "2026-11-05", local.name, "MCB 32A", "8536", "5", "240", "1,200.00", "18%", "216.00", "15,576.00"],
      ["KE-10", "2026-11-06", local.name, "Switch board", "8537", "2", "500", "1,000.00", "18%", "180.00", "1,200.00"],
    ];
    const { at, mapping } = findRegisterHeader(rows);
    expect(mapping).toMatchObject({
      description: "Item Description",
      hsn: "HSN/SAC",
      qty: "Qty",
      rate: "Rate",
      gstRate: "GST %",
      tax: "Tax Amount",
      total: "Bill Amount",
    });
    const { bills } = readRegister({ name: "Sheet1", rows, headerAt: at, mapping, kind: "purchase_bill", ctx });
    expect(bills.map((b) => b.extraction.number)).toEqual(["KE-9", "KE-10"]);
    const nine = bills[0]!.extraction;
    expect(nine.lines.map((l) => [l.description, l.hsn, l.qty, l.ratePaise])).toEqual([
      ["Copper wire 2.5 sq mm", "8544", 10, 1200_00],
      ["MCB 32A", "8536", 5, 240_00],
    ]);
    expect(nine.totals).toMatchObject({ taxablePaise: 13_200_00, cgstPaise: 1_188_00, sgstPaise: 1_188_00, totalPaise: 15_576_00 });
    expect(failed(bills[0]!)).toEqual([]);
    // ₹1,000 + ₹180 is ₹1,180, not the ₹1,200 printed: the card says so.
    expect(failed(bills[1]!)).toEqual(["total"]);
  });

  it("reads a Tally-style register: title rows, the number on the first line only, and a total row", () => {
    const rows = [
      ["Kaveri Electricals"],
      ["Sales Register"],
      ["1-Nov-2026 to 30-Nov-2026"],
      ["Date", "Particulars", "Voucher No.", "GSTIN/UIN", "Item", "Quantity", "Value", "Integrated Tax", "Gross Total"],
      ["7-Nov-2026", "Lakshmi Stores Hosur", "KE/S/41", "", "Ceiling fan", "4", "8,000.00", "", ""],
      ["", "", "", "", "LED panel", "10", "4,000.00", "", ""],
      ["Grand Total", "", "", "", "", "", "12,000.00", "", ""],
    ];
    const { at, mapping } = findRegisterHeader(rows);
    expect(at).toBe(3);
    expect(registerKind(rows, at, "november.xlsx")).toBe("sales_invoice");
    expect(guessBillMapping(rows[3]!)).toMatchObject({
      number: "Voucher No.",
      party: "Particulars",
      description: "Item",
      igst: "Integrated Tax",
      total: "Gross Total",
    });
    const { bills, skipped } = readRegister({ name: "Sales", rows, headerAt: at, mapping: { ...mapping, taxable: "Value" }, kind: "sales_invoice", ctx });
    expect(skipped).toEqual([{ row: 7, reason: "a total row" }]);
    expect(bills).toHaveLength(1);
    const e = bills[0]!.extraction;
    expect(e.lines.map((l) => l.description)).toEqual(["Ceiling fan", "LED panel"]);
    expect(e.totals.taxablePaise).toBe(12_000_00);
    // An unknown customer and a sale with no tax shown: the card asks the owner to look.
    expect(e.partyId).toBeNull();
    expect(failed(bills[0]!)).toContain("party");
  });

  it("skips rows it cannot read and says why", () => {
    const rows = [
      ["Invoice No", "Date", "Party Name", "Taxable Value"],
      ["", "2026-11-01", "Nobody", "100"],
      ["X-1", "2026-11-01", local.name, ""],
    ];
    const { bills, skipped } = readRegister({ name: "S", rows, headerAt: 0, mapping: guessBillMapping(rows[0]!), kind: "purchase_bill", ctx });
    expect(bills).toEqual([]);
    expect(skipped).toEqual([
      { row: 2, reason: "no bill number" },
      { row: 3, reason: "no taxable value or total" },
    ]);
  });
});

describe("the Accountant and a register", () => {
  const req = (method: string, path: string, body?: unknown, role: "owner" | "accountant" = "owner"): ApiRequest => ({
    method,
    path,
    query: new URLSearchParams(),
    body,
    role,
    user: { name: "Anil Kaveri", email: "anil@example.com" },
    mode: "mock",
  });
  const register = (numbers: string[]) => [
    ["Purchase Register"],
    ["Bill Ref", "Bill Dt", "Supplier", "Supplier GSTIN", "Basic", "CGST", "SGST", "IGST", "Net"],
    ...numbers.map((n) => [n, "10-11-2026", local.name, local.gstin!, "1000", "90", "90", "", "1180"]),
  ];
  const receive = (office: OfficeService, id: string, rows: string[][], file = "nov.xlsx") =>
    office.registers.receive({ id, file, fileUrl: `/f/${id}`, sheets: [{ name: "Sheet1", rows }], via: "upload", from: null, auto: true });

  it("asks once about a new layout, then reads every bill in it, and the next file in it on its own", () => {
    const fresh = loadBooks();
    // A trainee Accountant, so every bill waits for the owner (a trusted one posts small, clean bills itself).
    fresh.agents.find((a) => a.agentId === "accountant")!.trustLevel = "trainee";
    const office = new OfficeService(fresh);
    const staged = office.books.staged.length;
    const [first] = receive(office, "reg-a1", register(["P-1", "P-2"]));
    expect(first).toMatchObject({ status: "needs_layout", cardId: "sheet-layout-reg-a1" });
    expect(office.books.staged.length).toBe(staged + 1);
    const card = office.books.staged.find((s) => s.id === first!.cardId)!;
    // "Basic" and "Net" are not names it knows: it asks for the amount before it can read anything.
    expect(card.payload.missing).toEqual(["taxable"]);
    expect(office.routine(card)).toBeNull();
    expect(dispatch(office, req("POST", `/api/desk/${card.id}`, { action: "approve" })).status).toBe(409);
    expect(dispatch(office, req("POST", `/api/desk/${card.id}`, { action: "approve", edits: { mapping: { taxable: "Nope" } } })).status).toBe(409);
    expect(dispatch(office, req("POST", `/api/desk/${card.id}`, { action: "approve" }, "accountant")).status).toBe(403);
    const mapping = { ...(card.payload.mapping as object), taxable: "Basic", total: "Net" };
    expect(dispatch(office, req("POST", `/api/desk/${card.id}`, { action: "approve", edits: { mapping } })).status).toBe(200);

    const docs = office.books.documents.filter((d) => d.file === "/f/reg-a1");
    expect(docs).toHaveLength(2);
    expect(docs[0]!.sheet?.headers[0]).toBe("Bill Ref");
    expect(docs[0]!.regions.find((r) => r.label === "Bill number")?.cell).toEqual({ row: 0, col: 0 });
    const cards = office.books.staged.filter((s) => s.kind === "ledger_entry" && docs.some((d) => d.id === (s.payload as { docId: string }).docId));
    expect(cards.map((c) => c.status)).toEqual(["pending", "pending"]);
    expect(cards.every((c) => (c.payload.checks as { ok: boolean }[]).every((x) => x.ok))).toBe(true);
    expect(office.books.bills.filter((b) => docs.some((d) => d.id === b.docId)).map((b) => b.status)).toEqual(["staged", "staged"]);

    // The same layout again: no card, the bills are read at once, and one already in the books is set aside.
    const [second] = receive(office, "reg-a2", register(["P-2", "P-3"]), "dec.xlsx");
    expect(second).toMatchObject({ status: "read", staged: 1, duplicates: 1 });
    expect(office.books.staged.filter((s) => s.kind === "sheet_layout")).toHaveLength(1);
  });

  it("adds a new supplier once for all its bills in a file, and sees their bills when the file comes again", () => {
    const fresh = loadBooks();
    fresh.agents.find((a) => a.agentId === "accountant")!.trustLevel = "trainee";
    const office = new OfficeService(fresh);
    const rows = (numbers: string[]) => [
      ["Invoice No", "Invoice Date", "Supplier Name", "Taxable Value", "Invoice Value"],
      ...numbers.map((n) => [n, "2026-11-10", "Nayak Hardware Hubli", "1000", "1000"]),
    ];
    const vendors = office.books.parties.length;
    const [card] = receive(office, "reg-d1", rows(["N-1", "N-2"]));
    office.decide(card!.cardId!, { action: "approve" }, "Anil Kaveri");
    const added = office.books.parties.slice(vendors);
    expect(added.map((p) => p.name)).toEqual(["Nayak Hardware Hubli"]);
    expect(office.books.bills.filter((b) => b.partyId === added[0]!.id)).toHaveLength(2);
    // The second bill does not call the supplier known: they are new until the owner approves.
    const second = office.books.staged.find((s) => s.kind === "ledger_entry" && /N-2/.test(s.title))!;
    expect(second.summary).toMatch(/Nayak Hardware Hubli is new/);
    const [again] = receive(office, "reg-d2", rows(["N-2", "N-3"]));
    expect(again).toMatchObject({ status: "read", staged: 1, duplicates: 1 });
  });

  it("puts columns a model suggested on the card, marked as the AI's, for the owner to confirm", () => {
    const office = new OfficeService(loadBooks());
    const sheets = [{ name: "Sheet1", rows: register(["P-1"]) }];
    const [unclear] = office.registers.unclear(sheets);
    expect(unclear).toMatchObject({ index: 0, headers: register([])[1], guess: { number: "Bill Ref", party: "Supplier" } });
    const proposed = [fromLayoutAnswer({ mapping: { taxable: "Basic", total: "Net", party: "Bill Ref" } }, unclear!.headers, unclear!.guess)];
    const [r] = office.registers.receive({ id: "reg-c1", file: "nov.xlsx", fileUrl: "/f/c1", sheets, via: "upload", from: null, auto: true, proposed });
    const card = office.books.staged.find((s) => s.id === r!.cardId)!;
    expect(card.payload).toMatchObject({ missing: [], suggested: ["taxable", "total"], mapping: { party: "Supplier", taxable: "Basic", total: "Net" } });
    expect(card.summary).toMatch(/The AI suggested the columns for taxable value, total/);
    // Nothing is read until the owner approves.
    expect(office.books.documents.some((d) => d.file === "/f/c1")).toBe(false);
  });

  it("says when a sheet is not a list of bills, and forgets a rejected layout", () => {
    const office = new OfficeService(loadBooks());
    const [r] = receive(office, "reg-b1", [
      ["Item", "Qty"],
      ["Fan", "4"],
    ]);
    expect(r!.status).toBe("not_a_register");
    const [n] = receive(office, "reg-b2", register(["P-9"]));
    office.decide(n!.cardId!, { action: "reject" }, "Anil Kaveri");
    expect(office.registers.store.pending("reg-b2")).toBeNull();
    expect(office.books.documents.some((d) => d.file === "/f/reg-b2")).toBe(false);
  });
});
