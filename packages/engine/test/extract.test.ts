import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBooks } from "@office/fixtures";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { extractInvoice, gstinValid, parseAmount, parseDate } from "../src/extract";
import { fromModel, needsModel } from "../src/extract-model";
import { OfficeService } from "../src/office";
import { readTextLayer } from "../src/textlayer";

const books = loadBooks();
const DOCS = join(__dirname, "../../../apps/web/public/docs");

async function read(file: string) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(join(DOCS, file.replace(/^\/docs\//, "")))), useSystemFonts: true, verbosity: 0 }).promise;
  return readTextLayer(pdf);
}

describe("parsing", () => {
  it("reads Indian amounts and dates", () => {
    expect(parseAmount("25,31,364.00")).toBe(253136400);
    expect(parseAmount("₹ 1,93,070.14")).toBe(19307014);
    expect(parseAmount("(0.03)")).toBe(-3);
    expect(parseAmount("-0.5")).toBe(-50);
    expect(parseAmount("18%")).toBeNull();
    expect(parseDate("02 Nov 2026")).toBe("2026-11-02");
    expect(parseDate("2/11/2026")).toBe("2026-11-02");
    expect(parseDate("2 November, 2026")).toBe("2026-11-02");
  });
  it("checks GSTIN check digits", () => {
    expect(gstinValid(books.business.gstin)).toBe(true);
    expect(gstinValid(books.business.gstin.slice(0, 14) + (books.business.gstin.endsWith("9") ? "8" : "9"))).toBe(false);
  });
});

/**
 * The Accountant's evaluation set: every generated document, read back from its
 * PDF and compared with what the generator wrote. Its pass rate is the accuracy
 * the trust level is judged against.
 */
describe("evaluation set", () => {
  const bills = books.bills.map((b) => ({ kind: "purchase_bill" as const, rec: b, doc: books.documents.find((d) => d.id === b.docId)! }));
  const invoices = books.invoices.filter((_, i) => i % 5 === 0).map((v) => ({ kind: "sales_invoice" as const, rec: v, doc: books.documents.find((d) => d.id === v.docId)! }));
  const ctx = { ...books, bills: [], invoices: [] };

  it.each([...bills, ...invoices].map((x) => [x.doc.id, x] as const))("%s reads exactly", async (_id, { kind, rec, doc }) => {
    const e = extractInvoice(await read(doc.file), ctx);
    expect(e.kind).toBe(kind);
    expect(e.number).toBe(rec.number);
    expect(e.date).toBe(rec.date);
    expect(e.partyId).toBe(rec.partyId);
    expect(e.placeOfSupply).toBe(rec.placeOfSupply);
    expect(e.totals).toEqual(rec.totals);
    expect(e.lines.map((l) => [l.hsn, l.qty, l.unit, l.taxablePaise, l.gstRate, l.cgstPaise + l.sgstPaise + l.igstPaise])).toEqual(
      rec.lines.map((l) => [l.hsn, l.qty, l.unit, l.taxablePaise, l.gstRate, l.cgstPaise + l.sgstPaise + l.igstPaise]),
    );
    expect(e.lines.map((l) => l.skuId)).toEqual(rec.lines.map((l) => l.skuId));
    expect(e.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
    // Every highlighted field overlaps the box the generator drew for it.
    for (const want of doc.regions) {
      const got = e.regions.find((r) => r.key === want.key);
      if (!got || want.key === "terms" || want.key === "dueDate") continue;
      const [ax, ay, aw, ah] = want.box;
      const [bx, by, bw, bh] = got.box;
      const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
      const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
      expect(ix * iy, `${want.key} overlaps`).toBeGreaterThan(0.5 * Math.min(aw * ah, bw * bh));
    }
  });
});

describe("intake", () => {
  it("reads, stages, posts and refuses a duplicate", async () => {
    const fresh = loadBooks();
    const target = fresh.bills.find((b) => b.status === "posted" && b.tds)!;
    const doc = fresh.documents.find((d) => d.id === target.docId)!;
    fresh.bills = fresh.bills.filter((b) => b.id !== target.id);
    fresh.agents.find((a) => a.agentId === "accountant")!.trustLevel = "trainee";
    const office = new OfficeService(fresh);
    const items = await read(doc.file);

    office.receiveDocument({ id: "doc-u0001", file: doc.file, channel: "email", from: "billing@supplier.in", pages: 1 });
    expect(office.unread().map((d) => d.id)).toContain("doc-u0001");
    const first = office.read("doc-u0001", items);
    expect(first.staged?.status).toBe("pending");
    expect(first.message).toMatch(/Every check passed/);
    expect(office.unread().map((d) => d.id)).not.toContain("doc-u0001");
    const bill = office.books.bills.find((b) => b.docId === "doc-u0001")!;
    expect(bill.status).toBe("staged");
    expect(bill.totals).toEqual(target.totals);
    expect(bill.tds?.section).toBe(target.tds!.section);
    expect(office.desk().items.some((i) => i.id === first.staged!.id)).toBe(true);

    office.decide(first.staged!.id, { action: "approve" }, "Anil Kaveri");
    expect(bill.status).toBe("posted");
    expect(office.ledger.postedBills.some((b) => b.id === bill.id)).toBe(true);

    office.receiveDocument({ id: "doc-u0002", file: doc.file, channel: "upload", from: null, pages: 1 });
    const again = office.read("doc-u0002", items);
    expect(again.staged?.status).toBe("rejected");
    expect(office.desk().items.some((i) => i.id === again.staged!.id)).toBe(false);
  });

  it("rejecting keeps the bill out of the books", async () => {
    const fresh = loadBooks();
    const target = fresh.bills.find((b) => b.status === "posted")!;
    fresh.bills = fresh.bills.filter((b) => b.id !== target.id);
    const office = new OfficeService(fresh);
    office.receiveDocument({ id: "doc-u0003", file: "/x.pdf", channel: "upload", from: null, pages: 1 });
    const r = office.read("doc-u0003", await read(fresh.documents.find((d) => d.id === target.docId)!.file));
    office.decide(r.staged!.id, { action: "reject", note: "Not ours" }, "Anil Kaveri");
    expect(office.books.bills.find((b) => b.docId === "doc-u0003")?.status).toBe("rejected");
    expect(office.books.documents.find((d) => d.id === "doc-u0003")?.status).toBe("rejected");
  });

  it("lets a trusted Accountant post small, clean bills on its own", async () => {
    const fresh = loadBooks();
    const small = fresh.bills.find((b) => b.status === "posted" && b.totals.totalPaise < 1_00_000_00 && fresh.parties.find((p) => p.id === b.partyId)?.gstin)!;
    const large = fresh.bills.find((b) => b.status === "posted" && b.totals.totalPaise > 1_00_000_00)!;
    fresh.bills = fresh.bills.filter((b) => b !== small && b !== large);
    const office = new OfficeService(fresh);
    const checked = office.books.agents.find((a) => a.agentId === "accountant")!.accuracy.checked;
    for (const [id, b] of [["doc-u0010", small], ["doc-u0011", large]] as const) {
      office.receiveDocument({ id, file: "/x.pdf", channel: "upload", from: null, pages: 1 });
      office.read(id, await read(fresh.documents.find((d) => d.id === b.docId)!.file));
    }
    expect(office.books.bills.find((b) => b.docId === "doc-u0010")?.status).toBe("posted");
    expect(office.books.staged.find((s) => s.id === "chg-doc-u0010")?.decidedBy).toBe("The Accountant, trusted");
    expect(office.books.bills.find((b) => b.docId === "doc-u0011")?.status).toBe("staged");
    expect(office.books.agents.find((a) => a.agentId === "accountant")!.accuracy.checked).toBe(checked);
  });

  it("never acts alone on unplanned posts, unhappy messages or the accountant's files", () => {
    const fresh = loadBooks();
    for (const a of fresh.agents) a.trustLevel = "autonomous";
    const office = new OfficeService(fresh);
    const done = office.runTrusted();
    expect(done.some((d) => ["post", "campaign", "share_file", "audit_flag", "calendar", "broadcast"].includes(d.kind))).toBe(false);
    for (const d of done.filter((x) => x.kind === "social_reply")) {
      const m = office.books.socialInbox.find((x) => x.id === (d.payload as { messageId: string }).messageId)!;
      expect(m.sentiment).toBe("positive");
      expect(m.kind).not.toBe("dm");
    }
    expect(done.some((d) => d.kind === "quote")).toBe(true);
  });

  it("says when a page has no text layer", () => {
    const office = new OfficeService(loadBooks());
    office.receiveDocument({ id: "doc-u0004", file: "/scan.pdf", channel: "upload", from: null, pages: 1 });
    expect(office.read("doc-u0004", []).message).toMatch(/scan/);
  });
});

describe("model reading", () => {
  it("keeps only the citations that are really on the page", async () => {
    const bill = books.bills.find((b) => b.status === "posted" && b.totals.cgstPaise > 0)!;
    const items = await read(books.documents.find((d) => d.id === bill.docId)!.file);
    const at = (s: string) => items.findIndex((i) => i.str.includes(s));
    const rupees = (p: number) => (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    const party = books.parties.find((p) => p.id === bill.partyId)!;
    const answer = (totalItem: number) => ({
      kind: "purchase_bill",
      number: { value: bill.number, item: at(bill.number) },
      date: { value: bill.date, item: null },
      partyName: { value: party.name, item: null },
      partyGstin: { value: party.gstin, item: at(party.gstin!) },
      lines: bill.lines.map((l) => ({ description: l.description, hsn: l.hsn, qty: l.qty, unit: l.unit, rate: rupees(l.ratePaise), taxable: rupees(l.taxablePaise), gstRate: l.gstRate, tax: rupees(l.cgstPaise + l.sgstPaise + l.igstPaise) })),
      totals: { taxable: { value: rupees(bill.totals.taxablePaise) }, cgst: { value: rupees(bill.totals.cgstPaise) }, sgst: { value: rupees(bill.totals.sgstPaise) }, roundOff: { value: rupees(bill.totals.roundOffPaise) }, total: { value: rupees(bill.totals.totalPaise), item: totalItem } },
    });
    const ctx = { ...books, bills: [], invoices: [] };
    const good = fromModel(answer(items.findLastIndex((i) => i.str === rupees(bill.totals.totalPaise))), items, ctx);
    expect(good.totals).toEqual(bill.totals);
    expect(good.partyId).toBe(bill.partyId);
    expect(good.regions.map((r) => r.key)).toEqual(expect.arrayContaining(["number", "gstin", "totals.total"]));
    expect(good.checks.filter((c) => !c.ok)).toEqual([]);
    expect(needsModel(good)).toBe(false);

    const miscited = fromModel(answer(at(bill.number)), items, ctx);
    expect(miscited.regions.find((r) => r.key === "totals.total")).toEqual(good.regions.find((r) => r.key === "totals.total"));

    const invented = answer(0);
    invented.totals.total = { value: "9,99,999.00", item: 0 };
    const wrong = fromModel(invented, items, ctx);
    expect(wrong.regions.some((r) => r.key === "totals.total")).toBe(false);
    expect(wrong.checks.find((c) => c.key === "grounded")?.ok).toBe(false);
    expect(wrong.checks.find((c) => c.key === "total")?.ok).toBe(false);

    const scan = fromModel(answer(0), [], ctx);
    expect(scan.regions).toEqual([]);
    expect(scan.checks.find((c) => c.key === "grounded")?.detail).toMatch(/image/);
  });
});

describe("checks", () => {
  it("flags a duplicate and a total that does not add up", async () => {
    const b = books.bills[0]!;
    const doc = books.documents.find((d) => d.id === b.docId)!;
    const items = await read(doc.file);
    const dup = extractInvoice(items, books);
    expect(dup.checks.find((c) => c.key === "duplicate")?.ok).toBe(false);
    const total = items.find((i) => i.str === (b.totals.totalPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 }))!;
    const tampered = extractInvoice(
      items.map((i) => (i === total ? { ...i, str: "9,99,999.00" } : i)),
      { ...books, bills: [] },
    );
    expect(tampered.checks.find((c) => c.key === "total")?.ok).toBe(false);
  });
});
