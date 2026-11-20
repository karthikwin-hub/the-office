import { DatabaseSync } from "node:sqlite";
import { type IncomingMessage, OfficeService } from "@office/engine";
import { loadBooks, sampleCustomerService } from "@office/fixtures";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_POLL, freshText, splitCustomerDms, toSupportInbound, turnstileOk, widgetScript } from "../src/customer/channels";
import { CustomerDesk } from "../src/customer/desk";
import { SqlCsStore } from "../src/customer/store";
import { mailSender } from "../src/mail";

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
    send: mailSender({ MAIL_FROM: "office@the-office.test", MAILER: { send: async (m: { to: string; raw: string }) => void mail.push(m) } as unknown as SendEmail }),
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

describe("sending mail", () => {
  it("goes through Resend when its key is set, threaded and from MAIL_FROM", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    const send = mailSender({ MAIL_FROM: "support@snilldai.com", RESEND_API_KEY: "re_test", MAILER: undefined }, fetcher)!;
    const id = await send({ fromName: "Kaveri Electricals", to: "a@b.test", subject: "Re: order", body: "On its way.", replyTo: "kaveri.help@in.office.snilld.in", inReplyTo: "<x@y>" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: "Kaveri Electricals <support@snilldai.com>",
      to: ["a@b.test"],
      subject: "Re: order",
      text: "On its way.",
      reply_to: "kaveri.help@in.office.snilld.in",
      headers: { "Message-ID": id, "In-Reply-To": "<x@y>", References: "<x@y>" },
    });
    expect(id).toMatch(/@snilldai\.com>$/);
  });

  it("says why when Resend refuses, and is not set up without a key or a binding", async () => {
    const refused = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(mailSender({ MAIL_FROM: "support@snilldai.com", RESEND_API_KEY: "re_test", MAILER: undefined }, refused)!({ fromName: "x", to: "a@b.test", subject: "s", body: "b" })).rejects.toThrow(/refused the message \(403\)/);
    expect(mailSender({ MAIL_FROM: "support@snilldai.com", MAILER: undefined })).toBeNull();
  });
});

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

  type Msg = { from: "you" | "us"; text: string };
  /**
   * A web page with only what the script touches, and a chat backend that answers from `thread`. Every element the
   * script makes is kept in `made`, in order: its style, then the bubble, then the panel.
   */
  function pageWithBubble(siteKey: string | null, made: Record<string, unknown>[]) {
    const found = new Map<string, Record<string, unknown>>();
    const el = (): Record<string, unknown> => {
      const e: Record<string, unknown> = { style: {}, value: "", setAttribute() {}, appendChild() {}, focus() {} };
      e.querySelector = (sel: string) => found.get(sel) ?? (found.set(sel, el()), found.get(sel)!);
      return e;
    };
    const listeners: (() => void)[] = [];
    const doc = {
      hidden: false,
      head: el(),
      body: el(),
      createElement: () => {
        const e = el();
        made.push(e);
        return e;
      },
      addEventListener: (_type: string, fn: () => void) => void listeners.push(fn),
    };
    const thread: Msg[] = [];
    const gets: number[] = [];
    const posts: { text: string; turnstile: string | null }[] = [];
    const turnstile = { callback: null as ((t: string) => void) | null, resets: 0, render: (_e: unknown, o: { callback: (t: string) => void }) => void (turnstile.callback = o.callback), reset: () => void turnstile.resets++ };
    const win: Record<string, unknown> = siteKey ? { turnstile } : {};
    const fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body!) as { text: string; turnstile: string | null };
        posts.push({ text: body.text, turnstile: body.turnstile });
        thread.push({ from: "you", text: body.text });
      } else gets.push(Date.now());
      return Response.json({ messages: [...thread], business: "Kaveri Electricals" });
    });
    const store = new Map<string, string>();
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    new Function("window", "document", "localStorage", "fetch", widgetScript("wkaverichat01", "https://office.example", siteKey))(win, doc, localStorage, fetch);
    return {
      thread,
      gets,
      posts,
      turnstile,
      el: (sel: string) => found.get(sel)!,
      setHidden: (hidden: boolean) => {
        doc.hidden = hidden;
        listeners.forEach((l) => l());
      },
    };
  }

  describe("asking for replies", () => {
    beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
    afterEach(() => void vi.useRealTimers());

    it("asks every 5 s while the visitor waits for an answer, and backs off to 30 s idle and 60 s out of view", async () => {
      const made: Record<string, unknown>[] = [];
      const p = pageWithBubble(null, made);
      const bubble = made[1]!;
      (bubble.onclick as () => void)();
      await vi.advanceTimersByTimeAsync(0);
      expect(p.gets.length).toBe(1);

      // Nothing said yet: idle.
      await vi.advanceTimersByTimeAsync(CHAT_POLL.idle - 1);
      expect(p.gets.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.gets.length).toBe(2);

      // The visitor writes; the answer is not there yet, so it asks every 5 s.
      p.el("#oc-t").value = "Where is my order 1042?";
      (p.el("#oc-f").onsubmit as (e: unknown) => void)({ preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(p.posts.map((x) => x.text)).toEqual(["Where is my order 1042?"]);
      const before = p.gets.length;
      await vi.advanceTimersByTimeAsync(3 * CHAT_POLL.waiting);
      expect(p.gets.length).toBe(before + 3);

      // The answer comes: back to 30 s.
      p.thread.push({ from: "us", text: "A code is on its way to your phone. Type it here." });
      await vi.advanceTimersByTimeAsync(CHAT_POLL.waiting);
      const answered = p.gets.length;
      await vi.advanceTimersByTimeAsync(CHAT_POLL.idle - 1);
      expect(p.gets.length).toBe(answered);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.gets.length).toBe(answered + 1);

      // Out of view: once a minute; back in view: at once.
      p.setHidden(true);
      const hidden = p.gets.length;
      await vi.advanceTimersByTimeAsync(CHAT_POLL.hidden - 1);
      expect(p.gets.length).toBe(hidden);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.gets.length).toBe(hidden + 1);
      p.setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(p.gets.length).toBe(hidden + 2);

      // Closed: it stops asking.
      (bubble.onclick as () => void)();
      const closed = p.gets.length;
      await vi.advanceTimersByTimeAsync(10 * CHAT_POLL.hidden);
      expect(p.gets.length).toBe(closed);
    });

    it("gives up the quick asking two minutes after the visitor wrote, if no answer came", async () => {
      const made: Record<string, unknown>[] = [];
      const p = pageWithBubble(null, made);
      (made[1]!.onclick as () => void)();
      p.el("#oc-t").value = "Hello?";
      (p.el("#oc-f").onsubmit as (e: unknown) => void)({ preventDefault() {} });
      // One on opening, then one every 5 s up to and including the two-minute mark.
      await vi.advanceTimersByTimeAsync(CHAT_POLL.waitFor);
      expect(p.gets.length).toBe(1 + CHAT_POLL.waitFor / CHAT_POLL.waiting);
      await vi.advanceTimersByTimeAsync(CHAT_POLL.idle - 1);
      expect(p.gets.length).toBe(1 + CHAT_POLL.waitFor / CHAT_POLL.waiting);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.gets.length).toBe(2 + CHAT_POLL.waitFor / CHAT_POLL.waiting);
    });

    it("keeps the Turnstile flow: each message carries a fresh token, and the box is reset after sending", async () => {
      const made: Record<string, unknown>[] = [];
      const p = pageWithBubble("0x4AAA", made);
      (made[1]!.onclick as () => void)();
      p.turnstile.callback!("token-1");
      p.el("#oc-t").value = "My order";
      (p.el("#oc-f").onsubmit as (e: unknown) => void)({ preventDefault() {} });
      p.el("#oc-t").value = "123456";
      (p.el("#oc-f").onsubmit as (e: unknown) => void)({ preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(p.posts).toEqual([
        { text: "My order", turnstile: "token-1" },
        { text: "123456", turnstile: null },
      ]);
      expect(p.turnstile.resets).toBe(2);
    });
  });
});

describe("the office's own conversation store", () => {
  it("counts the website conversations started since a time, leaving out the owner's tries", async () => {
    const { o, desk } = world();
    await desk.receive({ channel: "web", key: "visitor-store-000000000001", name: "Website visitor", text: "Hi" });
    await desk.receive({ channel: "web", key: "visitor-store-000000000002", name: "Website visitor", text: "Hi" });
    await desk.receive({ channel: "web", key: "visitor-store-000000000003", name: "Website visitor", text: "Hi", test: true });
    const store = o.customers.store;
    expect(store.countStarted("web", new Date(Date.now() - 60_000).toISOString())).toBe(2);
    expect(store.countStarted("web", new Date(Date.now() + 60_000).toISOString())).toBe(0);
    expect(store.countStarted("whatsapp", "2000-01-01T00:00:00Z")).toBe(0);
  });
});

describe("the website chat's one-time code", () => {
  const visitor = "visitor-code-000000000001";
  const chat = (text: string) => ({ channel: "web" as const, key: visitor, name: "Website visitor", text });

  it("goes by email to the address on the order, never into the chat, and confirms the visitor once typed back", async () => {
    const { o, desk, mail } = world();
    const r = await desk.receive(chat("Where is order SO-1042? My phone is 9489305653"));
    expect(mail).toHaveLength(1);
    const parsed = await PostalMime.parse(mail[0]!.raw);
    expect(parsed.to?.[0]?.address).toBe("accounts@sharmatraders.in");
    const code = /\b(\d{6})\b/.exec(parsed.text ?? "")![1]!;
    expect(o.customers.threadView(r.thread.id).messages.some((m) => m.text.includes(code))).toBe(false);
    expect(o.customers.store.thread(r.thread.id)!.verifiedContact).toBeNull();
    await desk.receive(chat(code));
    expect(o.customers.store.thread(r.thread.id)!.verifiedContact).toBe("accounts@sharmatraders.in");
    expect(o.customers.threadView(r.thread.id).messages.at(-1)!.ground).toBe("order");
  });

  it("asks again in website conversations confirmed the old way, without a code", () => {
    const sql = sqlStorage();
    const store = new SqlCsStore(sql);
    const thread = (id: string, channel: "web" | "whatsapp") => ({ id, channel, key: id, name: "x", partyId: "C01", verifiedContact: "919489305653", status: "open" as const, subject: null, startedAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", lastInboundAt: null, disclosed: true, handoffs: 0, firstReplySeconds: null, test: false });
    store.saveThread(thread("cst-old", "web"));
    store.saveThread(thread("cst-coded", "web"));
    store.saveThread(thread("cst-wa", "whatsapp"));
    store.saveCode({ id: "csc-1", threadId: "cst-coded", code: "123456", contact: "919489305653", partyId: "C01", orderNumber: "SO-1042", ask: "order_status", sentAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-01T00:10:00.000Z", tries: 1, done: true });
    const reopened = new SqlCsStore(sql);
    expect(reopened.thread("cst-old")).toMatchObject({ verifiedContact: null, partyId: null });
    expect(reopened.thread("cst-coded")).toMatchObject({ verifiedContact: "919489305653", partyId: "C01" });
    expect(reopened.thread("cst-wa")!.verifiedContact).toBe("919489305653");
  });

  it("goes from the office's own WhatsApp number when the order has no email, and tells the owner when it cannot", async () => {
    const own = world({ own: true });
    own.o.books.orders.find((x) => x.number === "SO-1042")!.email = "";
    await own.desk.receive(chat("Where is order SO-1042? My phone is 9489305653"));
    const [url, init] = graph.mock.calls.at(-1)!;
    expect(String(url)).toContain("own-number");
    expect(String((init as RequestInit).body)).toContain("919489305653");
    expect(String((init as RequestInit).body)).toMatch(/\d{6} is your code/);

    const none = world();
    none.o.books.orders.find((x) => x.number === "SO-1042")!.email = "";
    await none.desk.receive(chat("Where is order SO-1042? My phone is 9489305653"));
    expect(none.o.books.teamLog.at(-1)!.text).toContain("Could not send a code");
  });
});

describe("the website chat's person check", () => {
  it("shuts the chat live when Turnstile has no secret, and leaves it open in the mockups and tests", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    expect(await turnstileOk(undefined, null, null, true, fetcher)).toBe(false);
    expect(await turnstileOk(undefined, "tok", null, true, fetcher)).toBe(false);
    expect(await turnstileOk(undefined, null, null, false, fetcher)).toBe(true);
    expect(await turnstileOk("secret", null, null, true, fetcher)).toBe(false);
    expect(await turnstileOk("secret", "tok", "203.0.113.9", true, fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
