import { ROUTES } from "@office/contracts";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asCaller, asSystem, callerFor, listen, openOffice, person, settle } from "./office";

type Stub = Awaited<ReturnType<typeof openOffice>>["stub"];
const upgrade = { headers: { upgrade: "websocket" } };
const live = async (stub: Stub, caller: Parameters<typeof asCaller>[0]) => listen(await stub.fetch(await asCaller(caller, "/api/live", upgrade)));
const changeSettings = async (stub: Stub, caller: Parameters<typeof asCaller>[0], digestTime: string) =>
  stub.fetch(await asCaller(caller, ROUTES.settings, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ digestTime }) }));

describe("the live connection", () => {
  it("tells a member nothing on connect, and only that the books changed afterwards", async () => {
    const { id, owner, stub } = await openOffice();
    const heard = await live(stub, callerFor(id, owner));
    expect(heard.closed).toBeNull();
    expect(heard.messages).toEqual([]);
    expect((await changeSettings(stub, callerFor(id, owner), "09:15")).status).toBe(200);
    await settle();
    expect(heard.messages.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual(["changed"]);
  });

  it("closes a socket meant for another office, having said nothing on it", async () => {
    const a = await openOffice();
    const b = await openOffice();
    const heard = await live(a.stub, callerFor(b.id, b.owner));
    expect(heard.messages).toEqual([]);
    expect(heard.closed?.code).toBe(1008);
    const nobody = await live(a.stub, null);
    expect(nobody.messages).toEqual([]);
    expect(nobody.closed?.code).toBe(1008);
  });

  it("closes a socket that sends anything, and saves and passes on none of it", async () => {
    const { id, owner, stub } = await openOffice();
    const accountant = await person("Carol");
    const listener = await live(stub, callerFor(id, owner));
    const sender = await live(stub, callerFor(id, accountant, "accountant"));
    sender.socket!.send(JSON.stringify({ type: "cf_agent_state", state: { injected: true } }));
    await settle();
    expect(sender.closed?.code).toBe(1008);
    expect(sender.messages).toEqual([]);
    expect(listener.messages).toEqual([]);
    await runInDurableObject(stub, (o) => expect(o.state).toBeUndefined());

    const rpc = await live(stub, callerFor(id, owner));
    rpc.socket!.send(JSON.stringify({ type: "rpc", id: "1", method: "setState", args: [{ injected: true }] }));
    await settle();
    expect(rpc.closed?.code).toBe(1008);
    expect(rpc.messages).toEqual([]);
    await runInDurableObject(stub, (o) => expect(o.state).toBeUndefined());
  });

  it("closes the sockets of someone removed, and all of them when the office closes, on the office's own word only", async () => {
    const { id, owner, stub } = await openOffice();
    const carol = await person("Carol");
    const anil = await live(stub, callerFor(id, owner));
    const carols = [await live(stub, callerFor(id, carol, "accountant")), await live(stub, callerFor(id, carol, "accountant"))];

    const forged = await stub.fetch(await asCaller(callerFor(id, owner), "/internal/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: carol.id }) }));
    expect(forged.status).toBe(404);
    await settle();
    expect(carols.map((c) => c.closed)).toEqual([null, null]);

    expect((await stub.fetch(await asSystem(id, "/internal/disconnect", { userId: carol.id }))).status).toBe(200);
    await settle();
    expect(carols.map((c) => c.closed?.code)).toEqual([1008, 1008]);
    expect(anil.closed).toBeNull();

    expect((await stub.fetch(await asSystem(id, "/internal/disconnect"))).status).toBe(200);
    await settle();
    expect(anil.closed?.code).toBe(1008);
  });
  it("says when a document arrives unread, so open screens read it without asking every minute", async () => {
    const { id, owner, stub } = await openOffice();
    const heard = await live(stub, callerFor(id, owner));
    const email = (docId: string) => asSystem(id, "/internal/email", { from: "bills@supplier.test", subject: "Bill", docs: [{ id: docId, mimeType: "application/pdf", filename: "bill.pdf" }], skipped: [] });
    const said = () => heard.messages.map((m) => (JSON.parse(m) as { type: string; unread?: boolean }).unread === true);

    expect((await stub.fetch(await email("doc-unread-1"))).status).toBe(200);
    await settle();
    expect(said()).toEqual([true]);

    // The books change, but no new document waits: nothing to read.
    expect((await changeSettings(stub, callerFor(id, owner), "09:15")).status).toBe(200);
    await settle();
    expect(said()).toEqual([true, false]);

    // Another arrives while the first still waits: only the new one is news.
    expect((await stub.fetch(await email("doc-unread-2"))).status).toBe(200);
    await settle();
    expect(said()).toEqual([true, false, true]);
  });
});
