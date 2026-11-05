import { DatabaseSync } from "node:sqlite";
import { type IncomingMessage, OfficeService } from "@office/engine";
import { loadBooks, sampleCustomerService } from "@office/fixtures";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshText, splitCustomerDms, toSupportInbound, widgetScript } from "../src/customer/channels";
import { CustomerDesk } from "../src/customer/desk";
import { SqlCsStore } from "../src/customer/store";

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

function world(opts: { own?: boolean } = {}) {
  const sql = sqlStorage();
  const o = new OfficeService(loadBooks(), { asOf: "2026-11-04", conversations: new SqlCsStore(sql) });
  const cs = sampleCustomerService("2026-11-04");
  o.books.customerService = cs.setup;
  o.books.orders = cs.orders;
  o.setHiring("customer-service", { hired: true, trustLevel: "trusted" });
  const mail: { to: string; raw: string }[] = [];
  const kv = new Map<string, string>();
  const desk = new CustomerDesk({
    office: o,
    kv: (k, v) => (v === undefined ? (kv.get(k) ?? null) : (kv.set(k, v), v)),
    ai: null,
    ownKeys: async () => (opts.own ? { token: "own", phoneId: "own-number", template: null } : null),
    sharedKeys: () => ({ token: "shared", phoneId: "shared-number", template: null }),
    mailer: { send: async (m: { to: string; raw: string }) => void mail.push(m) } as unknown as SendEmail,
    mailFrom: "office@the-office.test",
    businessName: "Kaveri Electricals",
    supportAddress: "kaveri.help@in.the-office.test",
    ownersOnWhatsApp: async () => [],
    log: () => {},
  });
  return { o, desk, mail };
}

let graph: ReturnType<typeof vi.fn>;
beforeEach(() => {
  graph = vi.fn(async () => Response.json({ messages: [{ id: "wamid.out" }] }));
  vi.stubGlobal("fetch", graph);
});
afterEach(() => vi.unstubAllGlobals());

describe("customer email", () => {
  it("replies in the customer's thread, and their answer to that reply joins the same conversation", async () => {
    const { o, desk, mail } = world();
    const first = await desk.receive(toSupportInbound({ from: "Accounts@SharmaTraders.in", name: "Rakesh", subject: "Order", text: "Will I get a GST invoice?", messageId: "<c1@sharma.test>", inReplyTo: null }));
    expect(first.outcome).toBe("sent");
    expect(mail).toHaveLength(1);
    const parsed = await PostalMime.parse(mail[0]!.raw);
    expect(parsed.inReplyTo).toBe("<c1@sharma.test>");
    expect(parsed.subject).toBe("Re: Order");
    expect(parsed.replyTo?.[0]?.address).toBe("kaveri.help@in.the-office.test");
    const second = await desk.receive(toSupportInbound({ from: "accounts@sharmatraders.in", name: "Rakesh", subject: "Re: Order", text: "Thanks!\n\nOn Wed, 4 Nov 2026, Kaveri wrote:\n> Yes. Every order comes with a GST tax invoice.", messageId: "<c2@sharma.test>", inReplyTo: parsed.messageId ?? null }));
    expect(second.thread.id).toBe(first.thread.id);
    const ins = o.customers.threadView(first.thread.id).messages.filter((m) => m.direction === "in");
    expect(ins.at(-1)!.text).toBe("Thanks!");
  });

  it("keeps only the new part of a reply", () => {
    expect(freshText("Where is it?\r\n\r\nOn Mon, 2 Nov 2026 at 10:00, Kaveri <x@y> wrote:\r\n> old")).toBe("Where is it?");
    expect(freshText("Fine.\n-- \nRakesh Sharma\nSharma Traders")).toBe("Fine.");
    expect(freshText("Ok\n\nSent from my iPhone")).toBe("Ok");
  });
});

describe("customer WhatsApp", () => {
  it("answers from the office's own number, and never from the shared one", async () => {
    const own = world({ own: true });
    await own.desk.receive({ channel: "whatsapp", key: "919489305653", name: "Rakesh", text: "Will I get a GST invoice?", at: new Date().toISOString() });
    const [url, init] = graph.mock.calls.at(-1)!;
    expect(String(url)).toContain("own-number");
    expect(String((init as RequestInit).body)).toContain("919489305653");

    graph.mockClear();
    const shared = world();
    const r = await shared.desk.receive({ channel: "whatsapp", key: "919489305653", name: "Rakesh", text: "Will I get a GST invoice?", at: new Date().toISOString() });
    expect(graph).not.toHaveBeenCalled();
    const out = shared.o.customers.threadView(r.thread.id).messages.at(-1)!;
    expect(out.status).toBe("failed");
    expect(out.error).toContain("own WhatsApp number");
  });

  it("sends customers' messages to the agent only while it is on the team", () => {
    const dm: IncomingMessage = { id: "wa-1", externalId: "wamid.1", platform: "WhatsApp", channelId: "", kind: "dm", author: "Rakesh", at: "2026-11-04T10:00:00Z", rating: null, text: "Hi", postId: null, threadId: "919489305653" };
    const comment: IncomingMessage = { ...dm, id: "fb-1", platform: "Facebook", kind: "comment", threadId: "post-1" };
    expect(splitCustomerDms([dm, comment], true)).toMatchObject({ customers: [{ channel: "whatsapp", key: "919489305653", text: "Hi", externalId: "wamid.1" }], rest: [comment] });
    expect(splitCustomerDms([dm, comment], false)).toEqual({ customers: [], rest: [dm, comment] });
  });
});

describe("the website chat script", () => {
  it("carries the key, the origin and the AI notice, and the Turnstile key only when set", () => {
    const js = widgetScript("wkaverichat01", "https://office.example", null);
    expect(js).toContain('"key":"wkaverichat01"');
    expect(js).toContain("AI assistant");
    expect(js).toContain('"siteKey":null');
    expect(widgetScript("wkaverichat01", "https://office.example", "0x4AAA")).toContain('"siteKey":"0x4AAA"');
  });
});
