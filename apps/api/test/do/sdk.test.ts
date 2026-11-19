import { ROUTES } from "@office/contracts";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asCaller, callerFor, listen, openOffice } from "./office";

describe("the Office on the agents SDK", () => {
  it("answers its own members and keeps knowing who it is", async () => {
    const { id, owner, stub } = await openOffice("Kaveri Electricals");
    const res = await stub.fetch(asCaller(callerFor(id, owner), ROUTES.settings));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { business: { name: string } }).business.name).toBe("Kaveri Electricals");
    await runInDurableObject(stub, async (_o, state) => {
      expect(state.storage.sql.exec<{ v: string }>("SELECT v FROM office_kv WHERE k = 'office:id'").one().v).toBe(id);
    });
  });

  it("does not route a path naming a sub-agent to another office's books", async () => {
    const a = await openOffice();
    const b = await openOffice();
    for (const path of [`/api/sub/office/${b.id}${ROUTES.settings}`, `/sub/office/${b.id}`, `/api/x/sub/office/${b.id}/internal/export`]) {
      const res = await a.stub.fetch(asCaller(callerFor(a.id, a.owner), path));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain(b.id);
    }
    const res = await a.stub.fetch(asCaller(callerFor(a.id, a.owner), `/api/sub/office/${b.id}`, { headers: { upgrade: "websocket" } }));
    const { messages, closed } = await listen(res);
    expect(messages).toEqual([]);
    expect(closed?.code).not.toBe(1000);
  });
});
