import { ROUTES } from "@office/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asCaller, callerFor, openOffice } from "./office";

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
