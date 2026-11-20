import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { morningRound, OfficeService, type RoutineHost, reminderQueue } from "../src";

const host = (seen: string[][] = []): RoutineHost => ({
  sendReminders: async (items) => ({ sent: items.length, failed: 0 }),
  socialMorning: async () => ({ outcome: "nothing", summary: "Nothing new." }),
  publish: async () => ({ outcome: "nothing", summary: "No post was due." }),
  digest: async (notes) => (seen.push([...notes]), { summary: "sent" }),
});

describe("reorder check", () => {
  it("lists items at their reorder level and drafts one purchase order per supplier for the desk", () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    o.setHiring("storekeeper", { hired: true });
    const low = o.books.stock.find((s) => s.onHand > 0)!;
    low.onHand = low.reorderPoint;
    const r = o.reorderCheck();
    expect(r.items.length).toBeGreaterThan(0);
    const cards = o.books.staged.filter((s) => s.kind === "purchase_order" && s.status === "pending" && s.id.startsWith("chg-po-auto-"));
    expect(cards.length).toBe(r.drafted);
    if (r.drafted) {
      const po = o.books.purchaseOrders.find((p) => p.id === (cards[0]!.payload as { poId: string }).poId)!;
      expect(po.status).toBe("draft");
      expect(po.lines.every((l) => l.qty > 0)).toBe(true);
    }
    expect(o.reorderCheck().drafted).toBe(0);
  });

  it("cancels a rejected order, so the item is drafted again on a later day", () => {
    const books = loadBooks();
    const low = books.stock.find((s) => s.onHand > 0)!;
    low.onHand = low.reorderPoint;
    const o = new OfficeService(books, { asOf: "2026-11-04" });
    o.setHiring("storekeeper", { hired: true });
    const first = o.reorderCheck();
    expect(first.drafted).toBeGreaterThan(0);
    const card = o.books.staged.find((s) => s.kind === "purchase_order" && s.status === "pending")!;
    const poId = (card.payload as { poId: string }).poId;
    const skus = o.books.purchaseOrders.find((p) => p.id === poId)!.lines.map((l) => l.skuId);
    o.decide(card.id, { action: "reject" }, "Anil Kaveri");
    expect(o.books.purchaseOrders.find((p) => p.id === poId)!.status).toBe("cancelled");
    expect(o.reorderCheck().drafted).toBe(0); // not again the same day
    const next = new OfficeService(o.books, { asOf: "2026-11-05" });
    next.setHiring("storekeeper", { hired: true });
    expect(next.reorderCheck().drafted).toBeGreaterThan(0);
    const again = next.books.purchaseOrders.filter((p) => p.status === "draft" && p.date === "2026-11-05").flatMap((p) => p.lines.map((l) => l.skuId));
    expect(skus.every((s) => again.includes(s))).toBe(true);
  });

  it("only lists, and drafts nothing, without the Storekeeper", () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    o.setHiring("storekeeper", { hired: false });
    const before = o.books.staged.length;
    o.reorderCheck();
    expect(o.books.staged.length).toBe(before);
  });
});

describe("compliance due", () => {
  it("returns filings due within the window, soonest first", () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    const due = o.complianceDue(7);
    expect(due.every((d) => d.daysLeft <= 7 && d.state !== "filed")).toBe(true);
    expect([...due].sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1))).toEqual(due);
    expect(due.some((d) => d.form === "GSTR-1")).toBe(true);
  });

  it("nudges seven days ahead with what missing it costs, and puts reorders into the morning digest", async () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    o.setHiring("compliance-officer", { hired: true });
    o.setHiring("storekeeper", { hired: true });
    const seen: string[][] = [];
    await morningRound(o, host(seen));
    const notes = seen[0]!;
    expect(notes.some((n) => /^GSTR-1 for October 2026 by /.test(n))).toBe(true);
    if (o.reorderCheck().items.length) expect(notes.some((n) => n.includes("reorder level"))).toBe(true);
  });
});

describe("reminders that failed", () => {
  it("are tried again an hour later, at most three times", () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    const now = Date.now();
    const base = {
      agentId: "credit-controller",
      kind: "reminder" as const,
      createdAt: "2026-11-04T09:00:00+05:30",
      title: "r",
      summary: "",
      evidence: [],
      status: "approved" as const,
    };
    o.books.staged.push(
      { ...base, id: "r1", payload: { sendError: "x", attempts: 1, triedAt: new Date(now - 2 * 3600_000).toISOString() } },
      { ...base, id: "r2", payload: { sendError: "x", attempts: 1, triedAt: new Date(now - 60_000).toISOString() } },
      { ...base, id: "r3", payload: { sendError: "x", attempts: 3, triedAt: new Date(now - 5 * 3600_000).toISOString() } },
      { ...base, id: "r4", payload: { sentAt: new Date(now).toISOString() } },
    );
    expect(reminderQueue(o, [], now).map((s) => s.id)).toEqual(["r1"]);
  });
});
