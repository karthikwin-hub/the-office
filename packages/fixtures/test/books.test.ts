import { describe, expect, it } from "vitest";
import { loadBooks } from "../src";

describe("seeded books", () => {
  const books = loadBooks();

  it("validates against the contracts", () => {
    expect(books.invoices.length).toBeGreaterThan(250);
    expect(books.bills.length).toBeGreaterThan(60);
  });

  it("links every invoice and bill to a document with regions", () => {
    const docs = new Map(books.documents.map((d) => [d.id, d]));
    for (const r of [...books.invoices, ...books.bills]) {
      const doc = docs.get(r.docId);
      expect(doc, r.id).toBeDefined();
      expect(doc!.regions.some((g) => g.key === "totals.total")).toBe(true);
    }
  });

  it("references only known parties and SKUs", () => {
    const parties = new Set(books.parties.map((p) => p.id));
    const skus = new Set(books.skus.map((s) => s.id));
    for (const inv of books.invoices) {
      expect(parties.has(inv.partyId)).toBe(true);
      for (const l of inv.lines) expect(skus.has(l.skuId!)).toBe(true);
    }
  });

  it("never allocates more than an invoice is worth", () => {
    const paid = new Map<string, number>();
    for (const p of books.payments)
      for (const a of p.allocations)
        if (a.invoiceId) paid.set(a.invoiceId, (paid.get(a.invoiceId) ?? 0) + a.amountPaise + a.tdsPaise);
    for (const inv of books.invoices) expect(paid.get(inv.id) ?? 0).toBeLessThanOrEqual(inv.totals.totalPaise);
  });
});
