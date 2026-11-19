import { ROUTES } from "@office/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CALLER_HEADER, system } from "../../src/caller";
import { CALLER_SEAL_HEADER, sealCaller } from "../../src/caller-seal";
import { asCaller, asSystem, callerFor, listen, openOffice } from "./office";

const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the office's own routes", () => {
  it("answer only the office itself, never a person in it, owner or not", async () => {
    const { id, owner, stub } = await openOffice();
    const me = callerFor(id, owner);
    for (const path of ["/internal/export", "/internal/purge", "/internal/email", "/internal/chat-messages", "/internal/social/meta", "/internal/whatsapp", "/internal/disconnect"]) {
      const res = await stub.fetch(await asCaller(me, path, post({ from: null, subject: "", docs: [], skipped: [], visitor: "v" })));
      expect(res.status, path).toBe(404);
    }
    expect((await stub.fetch(await asCaller(me, ROUTES.settings))).status).toBe(200);

    const exported = await stub.fetch(await asSystem(id, "/internal/export"));
    expect(exported.status).toBe(200);
    expect(((await exported.json()) as { office: string }).office).toBe(id);
  });

  it("trusts a caller only when the Worker sealed exactly that caller", async () => {
    const { id, owner, stub } = await openOffice();
    const header = JSON.stringify(system(id));
    const as = async (h: Record<string, string>) => (await stub.fetch(new Request("https://office.internal/internal/export", { ...post(), headers: { "content-type": "application/json", ...h } }))).status;

    expect(await as({ [CALLER_HEADER]: header })).toBe(401);
    expect(await as({ [CALLER_HEADER]: header, [CALLER_SEAL_HEADER]: "forged" })).toBe(401);
    expect(await as({ [CALLER_HEADER]: header, [CALLER_SEAL_HEADER]: await sealCaller("another-secret", header) })).toBe(401);
    expect(await as({ [CALLER_HEADER]: header, [CALLER_SEAL_HEADER]: await sealCaller(env.BETTER_AUTH_SECRET, JSON.stringify(callerFor(id, owner))) })).toBe(401);
    expect(await as({ [CALLER_HEADER]: header, [CALLER_SEAL_HEADER]: await sealCaller(env.BETTER_AUTH_SECRET, header) })).toBe(200);

    const unsealed = new Request("https://office.internal/api/live", { headers: { upgrade: "websocket", [CALLER_HEADER]: JSON.stringify(callerFor(id, owner)) } });
    const heard = await listen(await stub.fetch(unsealed));
    expect(heard.messages).toEqual([]);
    expect(heard.closed?.code).toBe(1008);
  });
});
