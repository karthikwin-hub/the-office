import type { OfficeService } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newState } from "../../src/social/oauth";
import { asCaller, callerFor, openOffice } from "./office";

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.deactivate());
const books = (o: unknown) => (o as { office: OfficeService }).office.books;

describe("a channel sign-in", () => {
  it("finishes once for its state; the same callback again connects nothing", async () => {
    const { id, owner, stub } = await openOffice();
    const me = callerFor(id, owner);
    await stub.fetch(await asCaller(me, "/api/settings"));
    // A new office has no channels yet; give it the sample X channel, not connected.
    await runInDurableObject(stub, (o) => {
      const x = loadBooks().channels.find((c) => c.platform === "x")!;
      books(o).channels = [{ ...x, mode: "manual", status: "manual" }];
    });
    const x = fetchMock.get("https://api.x.com");
    x.intercept({ path: "/2/oauth2/token", method: "POST" }).reply(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 7200 }).times(2);
    x.intercept({ path: (p) => p.startsWith("/2/users/me"), method: "GET" })
      .reply(200, { data: { id: "x-account-1", username: "kaveri" } })
      .times(2);

    const { state } = await newState(env.SOCIAL_TOKEN_KEY!, "x", owner.email, id);
    const callback = async () => {
      const res = await stub.fetch(await asCaller(me, `/api/channels/x/callback?state=${encodeURIComponent(state)}&code=code-1`, { redirect: "manual" }));
      if (!res.headers.get("location")) throw new Error(`${res.status} ${await res.text()}`);
      return new URL(res.headers.get("location")!).searchParams;
    };
    expect((await callback()).get("connected")).toBe("x");
    // Disconnected again, so a second connect would show.
    await runInDurableObject(stub, (o) => void (books(o).channels[0]!.mode = "manual"));
    const again = await callback();
    expect(again.get("connected")).toBeNull();
    expect(again.get("connect_error")).toMatch(/expired/);
    await runInDurableObject(stub, (o) => expect(books(o).channels[0]!.mode).toBe("manual"));
  });
});
