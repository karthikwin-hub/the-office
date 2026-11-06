import { readFileSync } from "node:fs";
import type { ImportCheck, ImportKind, Role } from "@office/contracts";
import { emptyBooks, loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { ageingReport, cashReport, dispatch, expectedTdsByBill, gstPeriods, outwardFor, OfficeService, salesReport, tdsQuarters } from "../src";

const template = (kind: ImportKind) => readFileSync(new URL(`../../../apps/web/public/templates/${kind}.csv`, import.meta.url), "utf8");
const KINDS: ImportKind[] = ["parties", "products", "open-items"];
const all = (booksFrom = "2026-11-01"): ImportCheck => ({ booksFrom, files: KINDS.map((kind) => ({ kind, name: `${kind}.csv`, csv: template(kind), file: `/api/o/o1/files/doc-${kind}` })) });
const only = (kind: ImportKind, csv: string, booksFrom = "2026-11-01"): ImportCheck => ({ booksFrom, files: [{ kind, name: `${kind}.csv`, csv }] });

const fresh = () => new OfficeService(emptyBooks({ owner: "Anil Kaveri", asOf: "2026-11-05" }));
const call = (office: OfficeService, path: string, body: unknown, role: Role = "owner") =>
  dispatch(office, { method: "POST", path, query: new URLSearchParams(), body, role, user: { name: role === "owner" ? "Anil Kaveri" : "Rajesh Mehta", email: `${role}@example.in` }, mode: "mock" });

/** Stages the three templates and approves them as the owner. */
function imported() {
  const office = fresh();
  const staged = office.stageOnboarding(all(), "Rajesh Mehta");
  office.decide(staged.item!.id, { action: "approve" }, "Anil Kaveri");
  return office;
}

describe("bringing in existing books", () => {
  it("reads the templates as shipped without a single issue", () => {
    const p = fresh().checkOnboarding(all());
    expect(p.issues).toEqual([]);
    expect(p.ready).toBe(true);
    expect(p.counts).toEqual({ customers: 2, suppliers: 2, products: 4, stock: 3, invoices: 2, bills: 2, receivablePaise: 72_720_00, payablePaise: 2_45_000_00 });
    expect(p.files.map((f) => f.rows)).toEqual([4, 4, 4]);
  });

  it("changes nothing until the owner approves one Desk item", () => {
    const office = fresh();
    const { item } = office.stageOnboarding(all(), "Rajesh Mehta");
    expect(item).toMatchObject({ kind: "onboarding", agentId: "accountant", status: "pending" });
    expect(item!.title).toBe("Bring in your books from before 1 Nov 2026");
    expect(office.books.parties).toEqual([]);
    expect(office.books.business.booksFrom).toBeUndefined();
    expect(office.desk().items.some((i) => i.id === item!.id)).toBe(true);
    // Never goes ahead on its own, however much the Accountant is trusted.
    office.books.agents.find((a) => a.agentId === "accountant")!.trustLevel = "autonomous";
    expect(office.routine(item!)).toBeNull();
  });

  it("lets the accountant bring the files but leaves the approval to the owner", () => {
    const office = fresh();
    const staged = call(office, "/api/onboarding/stage", all(), "accountant");
    expect(staged.status).toBe(200);
    const id = (staged.body as { item: { id: string } }).item.id;
    expect(call(office, `/api/desk/${id}`, { action: "approve" }, "accountant").status).toBe(403);
    expect(call(office, `/api/desk/${id}`, { action: "approve" }).status).toBe(200);
    expect(office.books.parties).toHaveLength(4);
  });

  it("brings in parties, products, stock and what is still owed, each linked to its row", () => {
    const office = imported();
    const b = office.books;
    expect(b.business.booksFrom).toBe("2026-11-01");
    expect(b.parties.map((p) => [p.name, p.kind])).toEqual([
      ["Sharada Builders Pvt Ltd", "customer"],
      ["Ravi Kumar", "customer"],
      ["Havells Distributors Hubli", "vendor"],
      ["Nagesh Electrical Contractors", "vendor"],
    ]);
    const sharada = b.parties[0]!;
    expect(sharada).toMatchObject({ pan: "AABCS1234K", stateCode: "29", entity: "company", paymentTermsDays: 30, creditLimitPaise: 5_00_000_00, tan: "BLRS12345E" });
    expect(b.parties[3]).toMatchObject({ tdsSection: "194C", supplyKind: "service", entity: "individual", stateCode: "29" });
    expect(b.skus.map((s) => s.id)).toEqual(["CBL-2.5-RED", "MCB-32A-SP", "LED-9W-CW", "SRV-INSTALL"]);
    expect(b.stock.find((s) => s.skuId === "LED-9W-CW")).toMatchObject({ onHand: 300, reorderPoint: 80, location: "Back store", lastReceivedOn: "2026-11-01" });

    const inv = b.invoices.find((i) => i.number === "KE/25-26/0412")!;
    expect(inv).toMatchObject({ opening: true, status: "posted", dueDate: "2026-10-15", totals: { totalPaise: 68_000_00, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 } });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.description).toBe("Brought forward: Rs 68,000.00 outstanding of Rs 1,18,000.00, invoice dated 15 Sept 2026");
    const doc = b.documents.find((d) => d.id === inv.docId)!;
    expect(doc).toMatchObject({ channel: "import", from: "open-items.csv, row 2", file: "/api/o/o1/files/doc-open-items", status: "posted", refId: inv.id });
    // No due date in the file: the party's terms decide it.
    expect(b.invoices.find((i) => i.number === "KE/25-26/0437")!.dueDate).toBe("2026-10-17");
    expect(b.teamLog.at(-2)!.text).toBe("Brought in 2 customers, 2 suppliers, 4 products, 2 unpaid invoices worth ₹72,720 and 2 unpaid bills worth ₹2.5 lakh from before 1 Nov 2026.");
  });

  it("counts brought-forward invoices towards ageing and statements, but never towards GST, sales or TDS", () => {
    const office = imported();
    const l = office.ledger;
    const ageing = ageingReport(l);
    expect(ageing.rows.map((r) => r.partyId).sort()).toEqual(office.books.parties.filter((p) => p.kind === "customer").map((p) => p.id).sort());
    expect(ageing.totalPaise).toBe(72_720_00);
    expect(outwardFor(l, "2026-09").invoices).toEqual([]);
    expect(outwardFor(l, "2026-10").invoices).toEqual([]);
    expect(salesReport(l, "2026-04-01", "2026-11-05").totals.invoices).toBe(0);
    expect([...expectedTdsByBill(l).values()].filter(Boolean)).toEqual([]);
    expect(gstPeriods(l)).toEqual(["2026-11"]);
    expect(tdsQuarters(l)).toEqual(["FY2026-27-Q3"]);
    const payable = cashReport(l).weeks.flatMap((w) => w.items).filter((i) => i.direction === "out" && i.label.includes("HDH-8831"));
    expect(payable.map((i) => i.amountPaise)).toEqual([2_36_000_00]);
    const sharada = office.books.parties[0]!.id;
    expect(office.partyView(sharada).recent[0]!.label).toBe("Brought forward, invoice KE/25-26/0412");
    expect(office.partyView(sharada).open.map((o) => o.outstandingPaise)).toEqual([68_000_00]);
  });

  it("keeps the start date fixed once the first import is approved", () => {
    const office = imported();
    const later = office.checkOnboarding(only("parties", "type,name,state\ncustomer,Lakshmi Traders,Karnataka\n", "2026-10-01"));
    expect(later).toMatchObject({ booksFrom: "2026-11-01", booksFromFixed: true, ready: true });
    office.updateSettings({ business: { ...office.books.business, booksFrom: "2026-04-01" } });
    expect(office.books.business.booksFrom).toBe("2026-11-01");
  });

  it("points at the row and column of everything that needs fixing", () => {
    const office = fresh();
    const csv = [
      "Type,Name,GSTIN,State,Payment terms (days)",
      "customer,Sharada Builders,29AABCS1234K1Z,,",
      "",
      "dealer,Ravi Kumar,,Karnataka,",
      "supplier,Havells,,Atlantis,thirty",
      "customer,Sharada builders,,29,",
    ].join("\n");
    const p = office.checkOnboarding(only("parties", csv));
    expect(p.ready).toBe(false);
    expect(p.issues.map((i) => [i.row, i.column])).toEqual([
      [2, "gstin"],
      [2, "state"],
      [4, "type"],
      [5, "state"],
      [5, "payment_terms_days"],
    ]);
    expect(p.issues[0]!.message).toContain("is not a GSTIN");
  });

  it("refuses open items from after the start date, unknown parties and repeated numbers", () => {
    const office = imported();
    const csv = [
      "type,number,date,party,total,outstanding",
      "invoice,KE/25-26/0412,01/10/2026,Sharada Builders Pvt Ltd,100,100",
      "invoice,KE/26-27/0001,03/11/2026,Ravi Kumar,100,100",
      "invoice,KE/25-26/0500,03/10/2026,Nobody Pvt Ltd,100,100",
      "bill,X-1,31/09/2026,Havells Distributors Hubli,100,100",
      "invoice,KE/25-26/0501,03/10/2026,Ravi Kumar,100,250",
      "invoice,KE/25-26/0502,03/10/2026,Ravi Kumar,100,100",
      "invoice,KE/25-26/0502,04/10/2026,Ravi Kumar,100,100",
    ].join("\n");
    const p = office.checkOnboarding(only("open-items", csv));
    expect(p.issues.map((i) => [i.row, i.column])).toEqual([
      [2, "number"],
      [3, "date"],
      [4, "party"],
      [5, "date"],
      [6, "outstanding"],
      [8, "number"],
    ]);
  });

  it("asks for the template's columns, a start date that has happened, and one import at a time", () => {
    const office = fresh();
    expect(office.checkOnboarding(only("products", "code,title\nA,B\n")).issues[0]).toMatchObject({ file: "products", row: 1, column: "sku, name, hsn, gst_rate, price" });
    expect(office.checkOnboarding(all("2026-12-01")).issues[0]).toMatchObject({ file: null, column: "books_from" });
    office.stageOnboarding(all(), "Rajesh Mehta");
    expect(office.checkOnboarding(all()).issues[0]!.message).toContain("already waiting on the Desk");
    expect(call(office, "/api/onboarding/stage", all()).status).toBe(422);
  });

  it("limits a file to 2,000 rows", () => {
    const rows = Array.from({ length: 2001 }, (_, i) => `customer,Customer ${i},,29,`);
    const p = fresh().checkOnboarding(only("parties", ["type,name,gstin,state,city", ...rows].join("\n")));
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]!.message).toContain("Up to 2,000 rows");
    expect(call(fresh(), "/api/onboarding/check", only("parties", "x".repeat(1_000_001))).status).toBe(400);
  });

  it("goes in whole or not at all when the books changed after the check", () => {
    const office = fresh();
    const { item } = office.stageOnboarding(all(), "Rajesh Mehta");
    office.books.skus.push({ id: "MCB-32A-SP", name: "Added by hand", hsn: "8536", unit: "NOS", gstRate: 18, pricePaise: 100, costPaise: 0, category: "X" });
    const r = call(office, `/api/desk/${item!.id}`, { action: "approve" });
    expect(r.status).toBe(409);
    expect(office.books.parties).toEqual([]);
    expect(office.books.staged.find((s) => s.id === item!.id)!.status).toBe("pending");
  });

  it("ignores edits sent with the approval", () => {
    const office = fresh();
    const { item } = office.stageOnboarding(all(), "Rajesh Mehta");
    call(office, `/api/desk/${item!.id}`, { action: "approve", edits: { parties: [], booksFrom: "2020-01-01" } });
    expect(office.books.parties).toHaveLength(4);
    expect(office.books.business.booksFrom).toBe("2026-11-01");
  });

  it("leaves the returns of books that already have history alone", () => {
    const books = loadBooks();
    const office = new OfficeService(books);
    const period = gstPeriods(office.ledger).at(-1)!;
    const before = outwardFor(office.ledger, period);
    const customer = books.parties.find((p) => p.kind === "customer")!;
    const csv = `type,number,date,party,total,outstanding\ninvoice,OLD-1,${period}-05,${customer.name},"10,000","10,000"\n`;
    const { item } = office.stageOnboarding(only("open-items", csv, office.asOf), "Rajesh Mehta");
    expect(item).not.toBeNull();
    office.decide(item!.id, { action: "approve" }, "Anil Kaveri");
    expect(outwardFor(office.ledger, period)).toEqual(before);
    expect(office.ledger.receivableInvoices.length).toBe(office.ledger.salesInvoices.length + 1);
  });
});
