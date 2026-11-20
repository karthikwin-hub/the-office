import { ROUTES } from "@office/contracts";
import type { OfficeService } from "@office/engine";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Office } from "../../src/office-agent";
import { asCaller, callerFor, openOffice } from "./office";

type Inside = { office: OfficeService; syncSalesRoute: () => Promise<void> };
const inside = (o: Office) => o as unknown as Inside;
const stored = (state: DurableObjectState) => state.storage.sql.exec("SELECT coll, id, json FROM book_rows ORDER BY coll, ord").toArray();
const put = (path: string, body: unknown) => ({
  method: path.includes("hiring") ? "POST" : "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("a request that fails", () => {
  it("leaves the books exactly as they were, for this request and the next one that saves", async () => {
    const { id, owner, stub } = await openOffice();
    const me = callerFor(id, owner);
    expect((await stub.fetch(await asCaller(me, ROUTES.settings))).status).toBe(200);
    const { before, inMemory } = await runInDurableObject(stub, (o, state) => {
      // The engine hires the agent, then claiming its address fails.
      inside(o).syncSalesRoute = async () => {
        throw new Error("the control plane is down");
      };
      return { before: stored(state), inMemory: structuredClone(inside(o).office.books) };
    });

    const res = await stub.fetch(await asCaller(me, "/api/hiring/marketplace-manager", put("/api/hiring", { hired: true })));
    expect(res.status).toBe(500);
    await runInDurableObject(stub, (o) => expect(inside(o).office.books).toEqual(inMemory));

    expect((await stub.fetch(await asCaller(me, ROUTES.settings, put(ROUTES.settings, { digestTime: "09:15" })))).status).toBe(200);
    await runInDurableObject(stub, (o, state) => {
      expect(stored(state)).toEqual(before);
      expect(inside(o).office.hired("marketplace-manager")).toBe(false);
      expect(inside(o).office.settings().digestTime).toBe("09:15");
    });
  });

  it("does not undo another request that is still working", async () => {
    const { id, owner, stub } = await openOffice();
    const me = callerFor(id, owner);
    expect((await stub.fetch(await asCaller(me, ROUTES.settings))).status).toBe(200);
    await runInDurableObject(stub, (o) => {
      const slow = o as unknown as { syncAssistantRoute: () => Promise<void> };
      slow.syncAssistantRoute = () => new Promise((r) => setTimeout(r, 300));
      inside(o).syncSalesRoute = async () => {
        throw new Error("the control plane is down");
      };
    });
    const working = stub.fetch(await asCaller(me, "/api/hiring/executive-assistant", put("/api/hiring", { hired: true })));
    await new Promise((r) => setTimeout(r, 50));
    expect((await stub.fetch(await asCaller(me, "/api/hiring/marketplace-manager", put("/api/hiring", { hired: true })))).status).toBe(500);
    expect((await working).status).toBe(200);
    await runInDurableObject(stub, (o) => expect(inside(o).office.hired("executive-assistant")).toBe(true));
  });
});
