import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Books, Party } from "@office/contracts";
import { emptyBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { docTypeOf, extractInvoice, parseAmount, parseDate, type TextItem } from "../src/extract";
import { fromModel } from "../src/extract-model";
import { computeGstr1, computeGstr3b } from "../src/gst";
import { OfficeService } from "../src/office";

/**
 * Documents printed by TallyPrime, read from their text layers. They come from a prospect's samples
 * with every name, GSTIN, address and bank detail replaced; the layout is exactly as printed.
 */
const layer = (name: string): TextItem[] => JSON.parse(readFileSync(join(__dirname, "fixtures/tally", `${name}.json`), "utf8"));

const OWN = "27AABCS1234Q1Z4";
const OWN_GJ = "24AABCS1234Q2Z9";
const COURIER = "27AAACB5678R1ZW";

function books(): Books {
  const b = emptyBooks({ asOf: "2026-11-17", owner: "Owner" } as Parameters<typeof emptyBooks>[0]);
  Object.assign(b.business, {
    name: "Sample Traders",
    legalName: "Sample Traders (OPC) Private Limited",
    gstin: OWN,
    stateCode: "27",
    pan: "AABCS1234Q",
    otherGstins: [OWN_GJ],
  });
  b.states = { ...b.states, "24": "Gujarat", "27": "Maharashtra", "30": "Goa" };
  return b;
}

const courier: Party = {
  id: "V01",
  kind: "vendor",
  name: "Swift Parcel Logistics Pvt Ltd",
  entity: "company",
  gstin: COURIER,
  pan: "AAACB5678R",
  stateCode: "27",
  city: "Mumbai",
  contact: { name: "", phone: "", email: "" },
  supplyKind: "service",
  tdsSection: "194C",
  paymentTermsDays: 30,
};

function office(b = books()) {
  const o = new OfficeService(b);
  let n = 0;
  const read = (name: string) => {
    const id = `doc-t${++n}`;
    o.receiveDocument({ id, file: `/${name}.pdf`, channel: "email", from: "accounts@example.com", pages: 1 });
    return { id, ...o.read(id, layer(name)) };
  };
  return { o, read };
}

describe("parsing Tally's figures", () => {
  it("reads two-digit years and a rupee sign mapped to another glyph", () => {
    expect(parseDate("9-Oct-26")).toBe("2026-10-09");
    expect(parseDate("11-Jul-26")).toBe("2026-07-11");
    expect(parseAmount("ī169.92")).toBe(16992);
    expect(parseAmount("ī 169.92")).toBe(16992);
  });
  it("knows a document by its printed title", () => {
    expect(docTypeOf(layer("courier-bill"))).toBe("invoice");
    expect(docTypeOf(layer("b2c-invoice-other-registration"))).toBe("invoice");
    expect(docTypeOf(layer("proforma"))).toBe("proforma");
    expect(docTypeOf(layer("delivery-note"))).toBe("delivery_note");
  });
});

describe("a purchase bill with tax in rows of its own", () => {
  it("reads the supplier under the title, the rate from the tax rows and the taxable value from the HSN summary", () => {
    const b = books();
    b.parties.push(courier);
    const e = extractInvoice(layer("courier-bill"), b);
    expect(e).toMatchObject({
      kind: "purchase_bill",
      docType: "invoice",
      registration: OWN,
      number: "MC/07/2627/P/8",
      date: "2026-07-11",
      partyId: "V01",
      partyGstin: COURIER,
      placeOfSupply: "27",
      intra: true,
    });
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]).toMatchObject({
      description: "Courier Services Jun 2026 Annexure Attached",
      hsn: "996812",
      qty: 1,
      gstRate: 18,
      taxablePaise: 3091100,
      cgstPaise: 278199,
      sgstPaise: 278199,
      igstPaise: 0,
    });
    expect(e.totals).toEqual({ taxablePaise: 3091100, cgstPaise: 278199, sgstPaise: 278199, igstPaise: 0, roundOffPaise: 2, totalPaise: 3647500 });
    expect(e.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("names a new supplier from the masthead, not the title above it", () => {
    expect(extractInvoice(layer("courier-bill"), books()).partyName).toBe("SWIFT PARCEL LOGISTICS PVT LTD");
  });

  it("stages the bill with TDS for a contractor, and sets the copy aside", () => {
    const b = books();
    b.parties.push(courier);
    const { o, read } = office(b);
    const first = read("courier-bill");
    expect(first.staged?.kind).toBe("ledger_entry");
    const bill = o.books.bills.find((x) => x.docId === first.id)!;
    expect(bill.gstin).toBeUndefined();
    expect(bill.tds?.section).toBe("194C");
    o.decide(first.staged!.id, { action: "approve" }, "Owner");
    expect(read("courier-bill").staged?.status).toBe("rejected");
  });
});

describe("a sale to an unregistered customer from another registration", () => {
  it("knows its own Gujarat GSTIN, the rate before tax and the place of supply under the consignee", () => {
    const e = extractInvoice(layer("b2c-invoice-other-registration"), books());
    expect(e).toMatchObject({
      kind: "sales_invoice",
      docType: "invoice",
      registration: OWN_GJ,
      partyGstin: null,
      partyName: "Corner Salon",
      number: "2026/27/104",
      date: "2026-10-09",
      placeOfSupply: "30",
      intra: false,
    });
    expect(e.lines[0]).toMatchObject({
      description: "Northwind Legendary Shave Foam - 400 ml",
      hsn: "34013012",
      qty: 24,
      unit: "NOS",
      ratePaise: 12458,
      taxablePaise: 298992,
      gstRate: 18,
      igstPaise: 53819,
    });
    expect(e.totals).toEqual({ taxablePaise: 298992, cgstPaise: 0, sgstPaise: 0, igstPaise: 53819, roundOffPaise: 0, totalPaise: 352811 });
    expect(e.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(["party"]);
  });

  it("finds an unregistered customer already in the books by name", () => {
    const b = books();
    b.parties.push({
      ...courier,
      id: "C01",
      kind: "customer",
      name: "Corner Salon",
      gstin: null,
      pan: "",
      stateCode: "30",
      tdsSection: null,
      supplyKind: undefined,
    });
    const e = extractInvoice(layer("b2c-invoice-other-registration"), b);
    expect(e.partyId).toBe("C01");
    expect(e.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("without the other registration in Settings, takes it for the customer's GSTIN", () => {
    const b = books();
    delete b.business.otherGstins;
    expect(extractInvoice(layer("b2c-invoice-other-registration"), b).partyGstin).toBe(OWN_GJ);
  });

  it("files it under the Gujarat GSTIN's GSTR-1 as B2C small, and keeps it out of the main GSTIN's returns", () => {
    const { o, read } = office();
    const r = read("b2c-invoice-other-registration");
    expect(r.staged?.summary).toMatch(/Gujarat registration 24AABCS1234Q2Z9/);
    expect(r.staged?.summary).toMatch(/B2C small/);
    o.decide(r.staged!.id, { action: "approve" }, "Owner");
    const inv = o.books.invoices.find((x) => x.docId === r.id)!;
    expect(inv.gstin).toBe(OWN_GJ);
    expect(o.ledger.party(inv.partyId).stateCode).toBe("30");

    const main = computeGstr1(o.ledger, "2026-10");
    expect(main.b2b).toEqual([]);
    expect(main.b2cs).toEqual([]);
    expect(computeGstr3b(o.ledger, "2026-10").sup_details.osup_det.iamt).toBe(0);

    const gj = computeGstr1(o.ledger, "2026-10", OWN_GJ);
    expect(gj.gstin).toBe(OWN_GJ);
    expect(gj.b2b).toEqual([]);
    expect(gj.b2cl).toEqual([]);
    expect(gj.b2cs).toEqual([{ sply_ty: "INTER", pos: "30", typ: "OE", rt: 18, txval: 2989.92, iamt: 538.19, camt: 0, samt: 0, csamt: 0 }]);
    expect(gj.hsn.data[0]).toMatchObject({ hsn_sc: "34013012", uqc: "NOS", qty: 24, txval: 2989.92, iamt: 538.19 });
    expect(computeGstr3b(o.ledger, "2026-10", OWN_GJ).sup_details.osup_det).toMatchObject({ txval: 2989.92, iamt: 538.19 });
  });

  it("puts an inter-state B2C invoice above ₹1 lakh in B2C large", () => {
    const { o, read } = office();
    const r = read("b2c-invoice-other-registration");
    o.decide(r.staged!.id, { action: "approve" }, "Owner");
    const inv = o.books.invoices.find((x) => x.docId === r.id)!;
    inv.totals = { ...inv.totals, totalPaise: 1_20_000_00 };
    const gj = computeGstr1(o.ledger, "2026-10", OWN_GJ);
    expect(gj.b2cs).toEqual([]);
    expect(gj.b2cl).toEqual([
      {
        pos: "30",
        inv: [{ inum: "2026/27/104", idt: "09-10-2026", val: 120000, itms: [{ num: 1801, itm_det: { rt: 18, txval: 2989.92, iamt: 538.19, csamt: 0 } }] }],
      },
    ]);
  });
});

describe("documents that are filed, not posted", () => {
  it("reads a proforma in full and files it, saying what is odd about it", () => {
    const { o, read } = office();
    const e = extractInvoice(layer("proforma"), o.books);
    expect(e).toMatchObject({ kind: "sales_invoice", docType: "proforma", number: "2026-27/S046", date: "2026-11-14", placeOfSupply: "30", intra: false });
    expect(e.lines.map((l) => [l.qty, l.ratePaise, l.taxablePaise, l.igstPaise])).toEqual(Array(4).fill([36, 100, 3600, 648]));
    expect(e.totals).toMatchObject({ taxablePaise: 14400, igstPaise: 2592, totalPaise: 16992 });

    const r = read("proforma");
    expect(r.staged?.kind).toBe("file_document");
    expect(r.message).toMatch(/proforma invoice/);
    expect(r.staged?.summary).toMatch(/₹1\.00 a unit/);
    expect(r.staged?.summary).toMatch(/says NIL, but ₹25\.92 is charged/);
    expect(o.books.invoices).toEqual([]);
    expect(o.books.parties).toEqual([]);

    o.decide(r.staged!.id, { action: "approve" }, "Owner");
    expect(o.books.documents.find((d) => d.id === r.id)).toMatchObject({ status: "filed", docType: "proforma" });
    expect(computeGstr1(o.ledger, "2026-11").b2b).toEqual([]);
  });

  it("files a delivery note and flags that it carries no value", () => {
    const { o, read } = office();
    const r = read("delivery-note");
    expect(r.staged?.kind).toBe("file_document");
    expect(r.staged?.title).toBe("File delivery note DC/03/26-27: 100 nos to Marketplace Services Pvt Ltd");
    expect(r.staged?.summary).toMatch(/rule 55/);
    const e = extractInvoice(layer("delivery-note"), o.books);
    expect(e.lines.map((l) => [l.description, l.qty])).toEqual([
      ["Northwind Legendary Eau de Toilette with Free Deodorant 100ml", 50],
      ["Northwind Sport Eau de Toilette with Deo Free - 100 ml", 50],
    ]);
    o.decide(r.staged!.id, { action: "reject", note: "Not needed" }, "Owner");
    expect(o.books.documents.find((d) => d.id === r.id)?.status).toBe("rejected");
  });

  it("never lets a trusted Accountant file or post them on its own", () => {
    const b = books();
    b.agents = b.agents.map((a) => (a.agentId === "accountant" ? { ...a, trustLevel: "trusted" } : a));
    const { read } = office(b);
    expect(read("proforma").staged?.status).toBe("pending");
  });
});

describe("other GST registrations in Settings", () => {
  it("keeps only valid GSTINs under the same PAN", () => {
    const o = new OfficeService(books());
    const s = o.updateSettings({ business: { ...o.books.business, otherGstins: [OWN_GJ.toLowerCase(), COURIER, OWN, "24AABCS1234Q2Z0"] } });
    expect(s.business.otherGstins).toEqual([OWN_GJ]);
    expect(o.updateSettings({ business: { ...o.books.business, otherGstins: [] } }).business.otherGstins).toBeUndefined();
  });
});

// The proforma's layout reprinted as Tally prints a tax invoice and a credit note: the heading says "Tax Invoice" on both.
const reprint = (as: "invoice" | "credit_note"): TextItem[] =>
  layer("proforma").map((i) => {
    if (i.str === "PROFORMA INVOICE") return { ...i, str: "Tax Invoice" };
    if (as === "credit_note" && i.str === "Invoice No.") return { ...i, str: "Credit Note No." };
    if (as === "credit_note" && i.str === "2026-27/S046") return { ...i, str: "41" };
    if (as === "credit_note" && i.str === "Reference No. & Date.") return { ...i, str: "Original Invoice No. & Date." };
    return i;
  });

describe("what the page says over its heading or a model", () => {
  it('knows a credit note by its number field when Tally heads it "Tax Invoice", and files it', () => {
    expect(docTypeOf(reprint("credit_note"))).toBe("credit_note");
    expect(docTypeOf(reprint("invoice"))).toBe("invoice");
    const { o } = office();
    o.receiveDocument({ id: "doc-cn", file: "/Credit Note_41.pdf", channel: "email", from: "accounts@example.com", pages: 1 });
    const r = o.read("doc-cn", reprint("credit_note"));
    expect(r.staged).toMatchObject({ kind: "file_document", status: "pending", title: "File credit note 41 to Coastal Distributors, ₹169.92" });
    expect(o.books.invoices).toEqual([]);
  });

  it("keeps the sale a sale when a model reading takes the buyer for the seller", () => {
    const { o } = office();
    const items = reprint("invoice");
    const at = (s: string) => items.findIndex((i) => i.str.includes(s));
    const answer = {
      kind: "purchase_bill",
      number: { value: "2026-27/S046", item: at("2026-27/S046") },
      date: { value: "14-Nov-26", item: null },
      partyName: { value: "Coastal Distributors", item: null },
      partyGstin: { value: OWN, item: null },
      lines: [{ description: "Item", qty: 144, unit: "nos", rate: "1.00", taxable: "144.00", gstRate: 18, tax: "25.92" }],
      totals: { taxable: { value: "144.00" }, igst: { value: "25.92" }, total: { value: "169.92" } },
    };
    const e = fromModel(answer, items, o.books);
    expect(e.kind).toBe("sales_invoice");
    // Our own GSTIN is never taken for the customer's.
    expect(e.partyGstin).toBeNull();
  });

  it("sets aside a proforma that comes in again, as it does a repeated bill", () => {
    const { o, read } = office();
    expect(read("proforma").staged?.status).toBe("pending");
    const again = read("proforma");
    expect(again.staged).toMatchObject({ kind: "file_document", status: "rejected", decidedBy: "The Accountant" });
    expect(again.message).toBe("2026-27/S046 came in before and is already on your desk.");
    expect(o.books.staged.filter((s) => s.kind === "file_document" && s.status === "pending")).toHaveLength(1);
    expect(o.books.documents.find((d) => d.id === again.id)?.status).toBe("rejected");
  });
});
