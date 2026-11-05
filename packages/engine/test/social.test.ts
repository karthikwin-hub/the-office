import { Books as BooksSchema, type Books, type Post } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger";
import { OfficeService } from "../src/office";
import { charCount, fit, textHash } from "../src/social/channels";
import { checkPost } from "../src/social/checks";
import { fromDraft } from "../src/social/drafts";
import { classify, isThankYou } from "../src/social/inbox";
import { importMetrics } from "../src/social/manual";
import { planMonth, shareSlots } from "../src/social/planner";

const fresh = (): Books => structuredClone(loadBooks());
const office = (b = fresh(), level: "trainee" | "trusted" = "trusted") => {
  b.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel = level;
  return new OfficeService(b, { asOf: "2026-11-04" });
};
const post = (b: Books, id: string): Post => b.posts.find((p) => p.id === id)!;
const failing = (o: OfficeService, p: Post) => checkPost(o.ledger, p, o.books.brandVoice, { now: "2026-11-04" }).filter((c) => !c.ok);

describe("channel rules", () => {
  it("counts X links as 23 characters and trims hashtags to the channel's limit", () => {
    expect(charCount("x", "Price list: https://kaverielectricals.in/a/very/long/path?utm_source=x")).toBe("Price list: ".length + 23);
    const out = fit("x", "New stock in. #a #b #c #d #e", { hashtags: [] });
    expect(out.text.match(/#\w+/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("hashes text the same way every time, and differently after an edit", () => {
    expect(textHash("Diwali lights in stock")).toBe(textHash("Diwali lights in stock"));
    expect(textHash("Diwali lights in stock")).not.toBe(textHash("Diwali lights in stock!"));
  });
});

describe("post checks against the books", () => {
  it("passes a calendar post whose figures match the price list", () => {
    const o = office();
    expect(failing(o, post(o.books, "post-05"))).toEqual([]);
  });

  it("fails a price that is not on the price list, a comparative claim and a competitor's name", () => {
    const o = office();
    const keys = failing(o, post(o.books, "post-09")).map((c) => c.key);
    expect(keys).toContain("price");
    expect(keys).toContain("claims");
  });

  it("fails a post for a product that has run out", () => {
    const o = office();
    const p = post(o.books, "post-05");
    o.books.stock.find((s) => s.skuId === p.skuIds[0])!.onHand = 0;
    o.ledger = new Ledger(o.books, "2026-11-04");
    expect(failing(o, p).map((c) => c.key)).toContain("stock");
  });

  it("fails a version too long for its channel", () => {
    const o = office();
    const p = structuredClone(post(o.books, "post-05"));
    p.variants[0] = { ...p.variants[0]!, platform: "x", text: "Fresh stock at the counter. ".repeat(12) };
    const c = failing(o, p).find((x) => x.key === "length");
    expect(c?.channelId).toBe(p.variants[0]!.channelId);
  });

  it("calls out a price that changed in the books after the post was drafted", () => {
    const o = office();
    const p = post(o.books, "post-05");
    o.books.skus.find((s) => s.id === p.skuIds[0])!.pricePaise += 5000;
    o.ledger = new Ledger(o.books, "2026-11-04");
    const price = failing(o, p).find((c) => c.key === "price");
    expect(price?.detail).toMatch(/books now say/);
  });

  it("accepts a model's draft only when every figure cites a fact", () => {
    const facts = post(fresh(), "post-05").facts;
    const price = facts.find((f) => f.kind === "price")!;
    expect(fromDraft({ text: `Now ${price.value} at the counter.`, factIds: [price.id] }, facts)).not.toBeNull();
    expect(fromDraft({ text: "Now ₹1 at the counter.", factIds: [] }, facts)).toBeNull();
  });
});

describe("the monthly planner", () => {
  it("splits slots by pillar share and largest remainder", () => {
    const s = shareSlots([{ id: "a", share: 40 }, { id: "b", share: 30 }, { id: "c", share: 20 }, { id: "d", share: 10 }], 13);
    expect([...s.values()].reduce((a, b) => a + b, 0)).toBe(13);
    expect(s.get("a")).toBe(5);
    expect(s.get("d")).toBe(1);
  });

  it("posts on Mondays, Wednesdays and Fridays, close to the pillar shares", () => {
    const o = office();
    const cal = planMonth(o.ledger, "2026-12");
    expect(cal.id).toBe("cal-2026-12");
    expect(cal.slots).toHaveLength(13);
    for (const s of cal.slots) expect([1, 3, 5]).toContain(new Date(`${s.date}T12:00:00Z`).getUTCDay());
    for (const p of o.books.brandVoice.pillars) {
      const n = cal.slots.filter((s) => s.pillarId === p.id).length;
      expect(Math.abs(n - (p.share * 13) / 100)).toBeLessThanOrEqual(2);
    }
  });
});

describe("trust", () => {
  const praise = { id: "msg-t1", platform: "Instagram", channelId: "ch-instagram", kind: "comment" as const, author: "@meera", at: "2026-11-04T10:00:00+05:30", rating: null, text: "Lovely shop, very helpful staff. Thank you!" };

  it("lets a trusted manager send thank-you replies on its own, and nothing else", () => {
    const o = office();
    const r = o.receiveMessages([
      praise,
      { ...praise, id: "msg-t2", kind: "review", platform: "Google reviews", channelId: "ch-google", rating: 2, text: "Waited an hour and the fan was faulty." },
      { ...praise, id: "msg-t3", kind: "dm", platform: "WhatsApp", channelId: "ch-whatsapp", text: "Thank you for the quick delivery!" },
    ]);
    expect(r.replied).toBe(1);
    expect(o.books.socialInbox.find((m) => m.id === "msg-t1")!.status).toBe("replied");
    expect(o.books.socialInbox.find((m) => m.id === "msg-t2")!.status).toBe("open");
    expect(o.books.socialInbox.find((m) => m.id === "msg-t3")!.status).toBe("open");
    expect(o.takeEffects()).toEqual([expect.objectContaining({ kind: "reply", messageId: "msg-t1", channelId: "ch-instagram" })]);
  });

  it("keeps a trainee's thank-you replies on the desk", () => {
    const o = office(fresh(), "trainee");
    expect(o.receiveMessages([praise]).replied).toBe(0);
  });

  it("never thanks with figures or promises", () => {
    const m = { ...praise, sentiment: "positive", intent: "praise", draftReply: "", status: "open", postId: null, threadId: null, externalId: null, leadId: null, replyBy: null } as const;
    expect(isThankYou(m, "Thank you, Meera!")).toBe(true);
    expect(isThankYou(m, "Thank you! Use code 10 for ₹100 off.")).toBe(false);
    expect(isThankYou(m, "Thank you, we will deliver tomorrow.")).toBe(false);
  });

  it("publishes an approved calendar post at its time when nothing changed", () => {
    const o = office();
    const out = o.publishDue("2026-11-05T13:00:00Z");
    expect(out.filter((e) => e.kind === "publish" && e.postId === "post-05").map((e) => e.channelId).sort()).toEqual(["ch-facebook", "ch-instagram"]);
    expect(post(o.books, "post-05").variants.find((v) => v.channelId === "ch-threads")!.error).toMatch(/by hand/);
  });

  it("sends a calendar post back to the desk when its price changed", () => {
    const o = office();
    const p = post(o.books, "post-05");
    o.books.skus.find((s) => s.id === p.skuIds[0])!.pricePaise += 5000;
    o.ledger = new Ledger(o.books, "2026-11-04");
    const out = o.publishDue("2026-11-05T13:00:00Z");
    expect(out.some((e) => e.kind === "publish" && e.postId === "post-05")).toBe(false);
    expect(p.status).toBe("draft");
    const staged = o.books.staged.find((s) => s.kind === "post" && s.status === "pending" && (s.payload as { postId: string }).postId === "post-05");
    expect(staged?.summary).toMatch(/Held back at publishing time/);
  });

  it("holds back a post edited after approval", () => {
    const o = office();
    const p = post(o.books, "post-05");
    p.variants[0]!.text += " Limited stock.";
    o.publishDue("2026-11-05T13:00:00Z");
    expect(p.status).toBe("draft");
    expect(o.postClearance(p).ok).toBe(false);
  });

  it("always asks before a WhatsApp broadcast", () => {
    const o = office();
    o.books.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel = "autonomous";
    const bc = o.books.staged.find((s) => s.kind === "broadcast" && s.status === "pending");
    expect(bc).toBeDefined();
    expect(o.runTrusted([bc!])).toEqual([]);
  });
});

describe("the inbox", () => {
  it("classifies enquiries, complaints and praise", () => {
    expect(classify("What is the price of the 1.5 sq mm wire? Is it available?", null).intent).toBe("enquiry");
    expect(classify("Worst service, the fan stopped working", 1).sentiment).toBe("negative");
    expect(classify("Great shop, thank you", 5).intent).toBe("praise");
  });

  it("passes an enquiry to the Sales Rep as a lead", () => {
    const o = office();
    o.receiveMessages([{ id: "msg-e1", platform: "Instagram", channelId: "ch-instagram", kind: "comment", author: "@sunil_builders", at: "2026-11-04T11:00:00+05:30", rating: null, text: "Price for 20 LED panels? Need them this week for a site." }]);
    const m = o.books.socialInbox.find((x) => x.id === "msg-e1")!;
    expect(m.leadId).toBe("lead-msg-e1");
    const lead = o.books.leads.find((l) => l.id === "lead-msg-e1")!;
    expect(lead).toBeDefined();
    expect(o.books.teamLog.some((e) => e.agentId === "sales-rep" && e.ref?.id === "lead-msg-e1")).toBe(true);
  });

  it("does not take the same comment twice", () => {
    const o = office();
    const raw = { id: "ig-1", externalId: "1", platform: "Instagram", channelId: "ch-instagram", kind: "comment" as const, author: "@a", at: "2026-11-04T11:00:00+05:30", rating: null, text: "Nice" };
    o.receiveMessages([raw]);
    expect(o.receiveMessages([{ ...raw, id: "ig-1b" }]).added).toHaveLength(0);
  });
});

describe("books saved before social media", () => {
  it("get one channel per platform, posted by hand, matching the upgraded posts", () => {
    const old = structuredClone(loadBooks()) as Partial<Books>;
    delete old.channels;
    delete old.calendars;
    const b = BooksSchema.parse(old);
    expect(b.channels.map((c) => c.id)).toEqual(["ch-instagram", "ch-facebook", "ch-threads", "ch-linkedin", "ch-x", "ch-whatsapp", "ch-google"]);
    expect(b.channels.every((c) => c.mode === "manual" && c.status === "manual")).toBe(true);
    expect(b.calendars).toEqual([]);
    expect(BooksSchema.parse(structuredClone(old)).channels).not.toBe(b.channels);
  });
});

describe("manual publishing", () => {
  it("matches a CSV export to posts by the link pasted at Mark as posted", () => {
    const b = fresh();
    const v = post(b, "post-03").variants.find((x) => x.url)!;
    const r = importMetrics(b, `Permalink,Impressions,Likes,Comments,Saves\n${v.url},1200,80,6,14\nhttps://example.com/nope,1,1,1,1\n`);
    expect(r).toEqual({ matched: 1, unmatched: 1 });
    expect(v.metrics).toMatchObject({ views: 1200, likes: 80, saves: 14 });
  });
});
