import { ROUTES } from "@office/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { system } from "../../src/caller";
import { attachmentRequest } from "../../src/files";
import { asCaller, asSystem, callerFor, openOffice } from "./office";

type Results = { results: { status: string; staged: number; duplicates: number; cardId?: string }[]; message: string };
type Desk = { items: { id: string; kind: string; status: string; payload: Record<string, unknown> }[] };

const csv = (numbers: string[]) =>
  [
    "Invoice No,Invoice Date,Supplier Name,Taxable Value,CGST Amount,SGST Amount,IGST Amount,Invoice Value",
    ...numbers.map((n) => `${n},10-11-2026,Shakti Cables,1000.00,90.00,90.00,,1180.00`),
  ].join("\n");

describe("a register of bills uploaded to the Accountant", () => {
  it("waits for its columns once, then every bill in it is staged, and the next file in that layout is read on its own", async () => {
    const { id, owner, stub } = await openOffice();
    const as = callerFor(id, owner);
    const upload = async (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return stub.fetch(await asCaller(as, ROUTES.registers, { method: "POST", body: form }));
    };

    expect((await upload(new File(["%PDF-1.4 a bill"], "bill.pdf", { type: "application/pdf" }))).status).toBe(415);

    const first = await upload(new File([csv(["P-1", "P-2"])], "november.csv", { type: "text/csv" }));
    expect(first.status).toBe(200);
    const r1 = (await first.json()) as Results;
    expect(r1.results).toMatchObject([{ status: "needs_layout" }]);
    const cardId = r1.results[0]!.cardId!;

    // The file is kept, sealed, with the office's other files.
    const listed = await env.DOCS.list({ prefix: `o/${id}/` });
    expect(listed.objects.length).toBe(1);

    const approve = await stub.fetch(
      await asCaller(as, `${ROUTES.desk}/${cardId}`, {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(approve.status).toBe(200);
    const desk = (await (await stub.fetch(await asCaller(as, ROUTES.desk))).json()) as Desk;
    const bills = desk.items.filter((i) => i.kind === "ledger_entry");
    expect(bills).toHaveLength(2);
    expect(bills.every((b) => b.status === "pending")).toBe(true);

    const second = (await (await upload(new File([csv(["P-2", "P-3"])], "december.csv", { type: "text/csv" }))).json()) as Results;
    expect(second.results).toMatchObject([{ status: "read", staged: 1, duplicates: 1 }]);
  });
});

describe("another kind of spreadsheet, named by the owner", () => {
  it("reads an orders file once its columns are confirmed, and only from the owner", async () => {
    const { id, owner, stub } = await openOffice();
    const send = async (who: "owner" | "accountant", kind: string) => {
      const form = new FormData();
      form.set("file", new File(["Name,Created at,Fulfillment Status\n#S-1,2026-11-18,unfulfilled"], "orders_export.csv", { type: "text/csv" }));
      form.set("kind", kind);
      return stub.fetch(await asCaller(callerFor(id, owner, who), ROUTES.sheets, { method: "POST", body: form }));
    };
    expect((await send("accountant", "orders")).status).toBe(403);
    expect((await send("owner", "sales_report")).status).toBe(400);
    const r = (await (await send("owner", "orders")).json()) as Results;
    expect(r.results).toMatchObject([{ status: "needs_layout", sheetKind: "orders" }]);
  });
});

describe("a register sent to the accounts address", () => {
  it("is recognised and reaches the Accountant, not the bill reader", async () => {
    const { id, owner, stub } = await openOffice();
    const bytes = new TextEncoder().encode(csv(["E-1"]));
    const r = attachmentRequest("doc-mail-reg", { content: bytes, mimeType: "text/csv", filename: "purchases.csv" }, "bills@supplier.test");
    expect((await stub.fetch(await asCaller(system(id), new URL(r.url).pathname, { method: "PUT", body: bytes, headers: r.headers }))).status).toBe(200);
    const res = await stub.fetch(
      await asSystem(id, "/internal/email", {
        from: "owner@example.test",
        subject: "November purchases",
        docs: [{ id: "doc-mail-reg", mimeType: "text/csv", filename: "purchases.csv" }],
        skipped: [],
      }),
    );
    expect(((await res.json()) as { sheets: string[] }).sheets[0]).toMatch(/layout I have not seen/);
    const desk = (await (await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.desk))).json()) as Desk;
    expect(desk.items.find((i) => i.kind === "sheet_layout")?.payload).toMatchObject({ sheetKind: "bill_register", file: "purchases.csv" });
    // It is not taken for a bill waiting to be read.
    expect(desk.items.some((i) => i.kind === "ledger_entry")).toBe(false);
  });
});

describe("a sales report sent to the accounts address", () => {
  it("is read as sales only from someone the sales address would take it from", async () => {
    const { id, owner, stub } = await openOffice();
    const hire = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hired: true }) };
    expect((await stub.fetch(await asCaller(callerFor(id, owner), "/api/hiring/marketplace-manager", hire))).status).toBe(200);
    const report = new TextEncoder().encode("Order Id,Order Date,SKU,Quantity,Invoice Amount\nAMZ-1,10-11-2026,FAN-1,1,99999.00");
    const r = attachmentRequest("doc-mail-sales", { content: report, mimeType: "text/csv", filename: "orders.csv" }, "x@attacker.test");
    await stub.fetch(await asCaller(system(id), new URL(r.url).pathname, { method: "PUT", body: report, headers: r.headers }));
    const res = await stub.fetch(
      await asSystem(id, "/internal/email", {
        from: "x@attacker.test",
        subject: "report",
        docs: [{ id: "doc-mail-sales", mimeType: "text/csv", filename: "orders.csv" }],
        skipped: [],
      }),
    );
    // Not proven, and neither a member nor a platform: it is not added to the owner's sales.
    expect(((await res.json()) as { sheets: string[] }).sheets[0]).not.toMatch(/^Read /);
    const sales = (await (await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.onlineSales))).json()) as { imports: unknown[] };
    expect(sales.imports).toEqual([]);
  });
});
