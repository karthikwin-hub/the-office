import { Books as BooksSchema, type Books, type Post } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/dispatch";
import { Ledger } from "../src/ledger";
import { OfficeService } from "../src/office";
import { charCount, fit, textHash } from "../src/social/channels";
import { checkPost } from "../src/social/checks";
import { fromDraft } from "../src/social/drafts";
import { classify, isThankYou } from "../src/social/inbox";
import { importMetrics } from "../src/social/manual";
import { nextFreeTime } from "../src/social/own";
import { readPostSheet, sheetPosts } from "../src/social/sheet";
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
    const s = shareSlots(
      [
        { id: "a", share: 40 },
        { id: "b", share: 30 },
        { id: "c", share: 20 },
        { id: "d", share: 10 },
      ],
      13,
    );
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
  const praise = {
    id: "msg-t1",
    platform: "Instagram",
    channelId: "ch-instagram",
    kind: "comment" as const,
    author: "@meera",
    at: "2026-11-04T10:00:00+05:30",
    rating: null,
    text: "Lovely shop, very helpful staff. Thank you!",
  };

  it("lets a trusted manager send thank-you replies on its own, and nothing else", () => {
    const o = office();
    const r = o.receiveMessages([
      praise,
      {
        ...praise,
        id: "msg-t2",
        kind: "review",
        platform: "Google reviews",
        channelId: "ch-google",
        rating: 2,
        text: "Waited an hour and the fan was faulty.",
      },
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
    const m = {
      ...praise,
      sentiment: "positive",
      intent: "praise",
      draftReply: "",
      status: "open",
      postId: null,
      threadId: null,
      externalId: null,
      leadId: null,
      replyBy: null,
    } as const;
    expect(isThankYou(m, "Thank you, Meera!")).toBe(true);
    expect(isThankYou(m, "Thank you! Use code 10 for ₹100 off.")).toBe(false);
    expect(isThankYou(m, "Thank you, we will deliver tomorrow.")).toBe(false);
  });

  it("publishes an approved calendar post at its time when nothing changed", () => {
    const o = office();
    const out = o.publishDue("2026-11-05T13:00:00Z");
    expect(
      out
        .filter((e) => e.kind === "publish" && e.postId === "post-05")
        .map((e) => e.channelId)
        .sort(),
    ).toEqual(["ch-facebook", "ch-instagram"]);
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
    o.receiveMessages([
      {
        id: "msg-e1",
        platform: "Instagram",
        channelId: "ch-instagram",
        kind: "comment",
        author: "@sunil_builders",
        at: "2026-11-04T11:00:00+05:30",
        rating: null,
        text: "Price for 20 LED panels? Need them this week for a site.",
      },
    ]);
    const m = o.books.socialInbox.find((x) => x.id === "msg-e1")!;
    expect(m.leadId).toBe("lead-msg-e1");
    const lead = o.books.leads.find((l) => l.id === "lead-msg-e1")!;
    expect(lead).toBeDefined();
    expect(o.books.teamLog.some((e) => e.agentId === "sales-rep" && e.ref?.id === "lead-msg-e1")).toBe(true);
  });

  it("does not take the same comment twice", () => {
    const o = office();
    const raw = {
      id: "ig-1",
      externalId: "1",
      platform: "Instagram",
      channelId: "ch-instagram",
      kind: "comment" as const,
      author: "@a",
      at: "2026-11-04T11:00:00+05:30",
      rating: null,
      text: "Nice",
    };
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
    // A later export with a title row above its header and no saves column keeps the saves already counted.
    importMetrics(b, `LinkedIn post analytics, 1-30 Nov 2026\nPost link,Impressions,Reactions,Comments\n${v.url},1500,95,n/a\n`);
    expect(v.metrics).toMatchObject({ views: 1500, likes: 95, comments: 6, saves: 14 });
  });
});

describe("the owner's own posts", () => {
  const at = "2026-11-20T18:00:00+05:30";
  const one = (o: OfficeService, row: Record<string, unknown>, confirm = false) =>
    o.addOwnerPosts(
      { confirm, posts: [{ text: "Come see our new fans.", channelIds: ["ch-facebook"], versions: [], mediaIds: [], link: null, skuIds: [], at, ...row }] },
      "Asha",
    );

  it("schedules the owner's post at their time with no desk card", () => {
    const o = office(fresh(), "trainee");
    const desk = o.books.staged.length;
    const r = one(o, {});
    expect(r).toMatchObject({ saved: true, warnings: [] });
    const p = post(o.books, r.posts[0]!.id);
    expect(p).toMatchObject({ source: "owner", status: "scheduled", at });
    expect(p.variants[0]).toMatchObject({ status: "scheduled", approvedHash: textHash("Come see our new fans.") });
    expect(o.books.staged.length).toBe(desk);
  });

  it("takes each channel's next free day when no time is given, one day per post in a sheet", () => {
    const b = fresh();
    expect(nextFreeTime(b, ["ch-facebook"], "2026-11-05T12:00:00+05:30")).toBe("2026-11-07T11:00:00+05:30");
    expect(nextFreeTime(b, ["ch-linkedin"], "2026-11-05T12:00:00+05:30")).toBe("2026-11-06T11:00:00+05:30");
    const o = office(b);
    const r = o.addOwnerPosts(
      {
        confirm: true,
        posts: [1, 2].map((n) => ({
          text: `Tip ${n}: switch off at the mains first.`,
          channelIds: ["ch-facebook"],
          versions: [],
          mediaIds: [],
          link: null,
          skuIds: [],
          at: null,
        })),
      },
      "Asha",
    );
    const days = r.posts.map((p) => p.at.slice(0, 10));
    expect(new Set(days).size).toBe(2);
    for (const d of days) expect(o.books.posts.filter((p) => p.at.startsWith(d) && p.variants.some((v) => v.channelId === "ch-facebook"))).toHaveLength(1);
  });

  it("warns about a wrong price for a product it names, and saves only once the owner confirms", () => {
    const o = office();
    const before = o.books.posts.length;
    const row = { text: "FR PVC wire 1.0 sq mm, 90 m coil now ₹999 only." };
    const first = one(o, row);
    expect(first.saved).toBe(false);
    expect(first.warnings.map((w) => w.detail).join(" ")).toMatch(/999/);
    expect(o.books.posts.length).toBe(before);
    const second = one(o, row, true);
    expect(second.saved).toBe(true);
    expect(post(o.books, second.posts[0]!.id).skuIds).toContain("SKU-101");
    expect(post(o.books, second.posts[0]!.id).topic).toBe("FR PVC wire 1.0 sq mm, 90 m coil now ₹999 only");
  });

  it("refuses a whole sheet when one row names a channel that does not exist, naming the row", () => {
    const o = office();
    const before = o.books.posts.length;
    const rows = [
      { text: "One", channelIds: ["ch-facebook"], versions: [], mediaIds: [], link: null, skuIds: [], at },
      { text: "Two", channelIds: ["ch-tiktok"], versions: [], mediaIds: [], link: null, skuIds: [], at },
    ];
    expect(() => o.addOwnerPosts({ confirm: true, posts: rows }, "Asha")).toThrow(/Row 2/);
    expect(o.books.posts.length).toBe(before);
  });

  it("sends a video only to Instagram and Facebook", () => {
    const o = office();
    o.addMedia({ id: "media-v1", url: "/m/v1", kind: "video", alt: "", skuId: null, rights: "own", width: null, height: null });
    expect(() => one(o, { mediaIds: ["media-v1"], channelIds: ["ch-instagram", "ch-x"] })).toThrow(/untick X/);
    expect(one(o, { mediaIds: ["media-v1"], channelIds: ["ch-instagram", "ch-facebook"] }, true).saved).toBe(true);
  });

  it("refuses a time that has passed", () => {
    expect(() => one(office(), { at: "2026-11-01T10:00:00+05:30" })).toThrow(/passed/);
  });

  it("publishes the owner's post at its time even when a check fails, since they confirmed it", () => {
    const o = office(fresh(), "trainee");
    const r = one(o, { text: "FR PVC wire 1.0 sq mm, 90 m coil now ₹999 only." }, true);
    const out = o.publishDue("2026-11-20T18:05:00+05:30");
    expect(out).toContainEqual({ kind: "publish", postId: r.posts[0]!.id, channelId: "ch-facebook" });
  });

  it("keeps an edited owner post scheduled, moves it, and removes it before it goes out", () => {
    const o = office();
    const id = one(o, {}).posts[0]!.id;
    const desk = o.books.staged.length;
    o.editVariant(id, "ch-facebook", { text: "Come see our new ceiling fans." });
    expect(post(o.books, id)).toMatchObject({ status: "scheduled" });
    expect(post(o.books, id).variants[0]!.approvedHash).toBe(textHash("Come see our new ceiling fans."));
    expect(o.books.staged.length).toBe(desk);
    o.movePost(id, "2026-11-21T10:00:00+05:30");
    expect(post(o.books, id).at).toBe("2026-11-21T10:00:00+05:30");
    o.cancelOwnerPost(id);
    expect(o.books.posts.some((p) => p.id === id)).toBe(false);
    expect(() => o.cancelOwnerPost("post-05")).toThrow();
  });

  it("is reached through the owner-only route", () => {
    const o = office();
    const body = { posts: [{ text: "Hello", channelIds: ["ch-facebook"], at }] };
    const as = (role: "owner" | "accountant") =>
      dispatch(o, {
        method: "POST",
        path: "/api/social/posts",
        query: new URLSearchParams(),
        body,
        role,
        user: { name: "Asha", email: "asha@example.com" },
        mode: "live",
      });
    expect(as("accountant").status).toBe(403);
    expect(as("owner")).toMatchObject({ status: 200, body: { saved: true } });
  });
});

describe("a sheet of the owner's posts", () => {
  it("reads dates, channels by name and file names, and names every bad row", () => {
    const b = fresh();
    const sheet = `Date,Time,Channels,Caption,Files
2026-12-01,18:30,Instagram; Facebook,"New fans, in white and brown.",fan.jpg; fan2.jpg
05/12/2026,,facebook,Switch off at the mains first.,
2026-12-07,,TikTok,Hello,
,,Instagram,,
13/2026,,Facebook,Bad date,
`;
    const { rows, errors } = readPostSheet(sheet, b.channels);
    expect(rows).toEqual([
      {
        row: 2,
        at: "2026-12-01T18:30:00+05:30",
        channelIds: ["ch-instagram", "ch-facebook"],
        text: "New fans, in white and brown.",
        files: ["fan.jpg", "fan2.jpg"],
      },
      { row: 3, at: "2026-12-05T11:00:00+05:30", channelIds: ["ch-facebook"], text: "Switch off at the mains first.", files: [] },
    ]);
    expect(errors).toEqual([
      'Row 4: no channel called "TikTok".',
      "Row 5: the caption is empty.",
      "Row 6: write the date as 2026-12-01 and the time as 11:00.",
    ]);
    const posts = sheetPosts(
      rows,
      new Map([
        ["fan.jpg", "media-a"],
        ["fan2.jpg", "media-b"],
      ]),
    );
    expect(posts[0]!.mediaIds).toEqual(["media-a", "media-b"]);
    expect(() => sheetPosts(rows, new Map([["fan.jpg", "media-a"]]))).toThrow(/Row 2: attach fan2.jpg/);
  });
});

describe("AI drafts for the month", () => {
  const drafted = () => {
    const o = office();
    const card = o.draftCalendar("2027-01");
    const calendarId = (card.payload as { calendarId: string }).calendarId;
    return { o, calendarId, jobs: o.aiDraftJobs(calendarId) };
  };

  it("asks for every version of the month's drafts, with the voice and the facts in the prompt", () => {
    const { o, jobs } = drafted();
    expect(jobs.length).toBeGreaterThan(5);
    const job = jobs.find((j) => post(o.books, j.postId).facts.some((f) => f.kind === "price"))!;
    expect(job.prompt.system).toContain(o.books.brandVoice.tone);
    expect(job.prompt.user).toContain(post(o.books, job.postId).facts.find((f) => f.kind === "price")!.value);
  });

  it("keeps the model's caption only when its figures are the books' own and it passes the checks", () => {
    const { o, jobs } = drafted();
    const job = jobs.find((j) => post(o.books, j.postId).facts.some((f) => f.kind === "price"))!;
    const p = post(o.books, job.postId);
    const v = () => p.variants.find((x) => x.channelId === job.channelId)!;
    const template = v().text;
    const price = p.facts.find((f) => f.kind === "price")!;
    expect(o.applyAiDraft(job.postId, job.channelId, { text: "Now just ₹1 at the counter.", factIds: [price.id] })).toBe(false);
    expect(o.applyAiDraft(job.postId, job.channelId, { text: "Cheapest in town, come today.", factIds: [] })).toBe(false);
    expect(v().text).toBe(template);
    const good = `Fresh stock at the counter, ${price.value}. Ask us which one suits your home.`;
    expect(o.applyAiDraft(job.postId, job.channelId, JSON.stringify({ text: good, factIds: [price.id] }))).toBe(true);
    expect(v().text).toContain(price.value);
    o.noteAiDrafts(o.books.calendars.find((c) => c.month === "2027-01")!.id, 1, jobs.length);
    expect(o.books.staged.find((s) => s.id === "chg-cal-2027-01")!.summary).toContain(`Written with AI: 1 of ${jobs.length}`);
  });

  it("names the owner's competitors in the prompt and fails a post that names one", () => {
    const o = office();
    o.updateVoice({ ...o.books.brandVoice, competitors: ["Sharma Electricals"] });
    const p = structuredClone(post(o.books, "post-05"));
    p.variants[0]!.text = "Better service than Sharma Electricals.";
    expect(
      checkPost(o.ledger, p, o.books.brandVoice)
        .filter((c) => !c.ok)
        .map((c) => c.key),
    ).toContain("claims");
  });

  it("keeps the festivals the owner chose, once each and in date order", () => {
    const o = office();
    const set = o.setFestivals([
      { date: "2027-10-29", name: "Diwali", relevance: "Lights" },
      { date: "2027-03-22", name: "Holi", relevance: "Colours" },
      { date: "2027-10-29", name: "Diwali", relevance: "Lights" },
    ]);
    expect(set.map((f) => f.name)).toEqual(["Holi", "Diwali"]);
  });
});

describe("the owner approves the plan, not each post", () => {
  const approvedMonth = (level: "trusted" | "autonomous") => {
    const b = fresh();
    b.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel = level;
    const o = new OfficeService(b, { asOf: "2026-11-04" });
    o.setFestivals([]);
    const card = o.draftCalendar("2027-01");
    const calendarId = (card.payload as { calendarId: string }).calendarId;
    const posts = o.books.posts.filter((p) => p.calendarId === calendarId);
    // The sample has no photos for these products: leave Instagram out, and describe every picture.
    for (const m of o.books.media) m.alt ||= "A product on the counter";
    for (const p of posts) for (const v of p.variants) if (v.platform === "instagram") v.status = "skipped";
    o.decide(card.id, { action: "approve" }, "Asha");
    const claims = (p: Post) => p.variants.some((v) => /₹|%|\b(only|just|last)\s+\d+\s/i.test(v.text));
    return { o, posts, claims };
  };

  it("lets a trusted agent schedule the plan's plain posts, and leaves posts with a price or stock claim to the owner", () => {
    const { o, posts, claims } = approvedMonth("trusted");
    const agent = posts.filter((p) => p.approvedBy === "agent");
    expect(agent.length).toBeGreaterThan(0);
    expect(agent.every((p) => p.status === "scheduled" && !claims(p))).toBe(true);
    const withClaims = posts.filter(claims);
    expect(withClaims.length).toBeGreaterThan(0);
    for (const p of withClaims) {
      expect(p.status).toBe("draft");
      expect(o.books.staged.some((s) => s.kind === "post" && s.status === "pending" && (s.payload as { postId: string }).postId === p.id)).toBe(true);
    }
  });

  it("lets an autonomous agent schedule checked posts with claims too", () => {
    const { posts, claims } = approvedMonth("autonomous");
    expect(posts.some((p) => claims(p) && p.approvedBy === "agent" && p.status === "scheduled")).toBe(true);
  });

  it("waits until the owner has been told, then two hours, before an agent's post goes out", () => {
    const { o, posts } = approvedMonth("trusted");
    const p = posts.find((x) => x.approvedBy === "agent" && x.variants.some((v) => v.channelId === "ch-facebook" && v.status === "scheduled"))!;
    const at = p.at;
    const due = new Date(Date.parse(at) + 60_000).toISOString();
    expect(o.publishDue(due).some((e) => "postId" in e && e.postId === p.id)).toBe(false);
    expect(Date.parse(p.at) - Date.parse(at)).toBe(24 * 3600_000);
    const told = new Date(Date.parse(p.at) - 6 * 3600_000).toISOString();
    const lines = o.noticeDue(told);
    expect(lines.some((l) => l.includes(p.topic) && l.includes("unless you stop it"))).toBe(true);
    expect(o.noticeDue(told).some((l) => l.includes(p.topic))).toBe(false);
    expect(o.publishDue(new Date(Date.parse(told) + 3600_000).toISOString()).some((e) => "postId" in e && e.postId === p.id)).toBe(false);
    expect(o.publishDue(new Date(Date.parse(p.at) + 60_000).toISOString())).toContainEqual({ kind: "publish", postId: p.id, channelId: "ch-facebook" });
  });

  it("does not hold a post the owner approved on the desk", () => {
    const o = office(fresh(), "trainee");
    const card = o.draftCalendar("2027-01");
    o.decide(card.id, { action: "approve" }, "Asha");
    const item = o.books.staged.find((s) => s.kind === "post" && s.status === "pending")!;
    o.decide(item.id, { action: "approve" }, "Asha");
    const p = post(o.books, (item.payload as { postId: string }).postId);
    expect(p.approvedBy).toBe("owner");
    expect(o.publishDue(new Date(Date.parse(p.at) + 60_000).toISOString()).some((e) => "postId" in e && e.postId === p.id)).toBe(true);
  });

  it("stops an agent's post on the owner's word, back to the desk, and drops the agent a trust level", () => {
    const { o, posts } = approvedMonth("trusted");
    const p = posts.find((x) => x.approvedBy === "agent")!;
    o.stopPost(p.id, "Asha");
    expect(p.status).toBe("draft");
    const item = o.books.staged.find((s) => s.kind === "post" && s.status === "pending" && (s.payload as { postId: string }).postId === p.id)!;
    expect(item.payload.holdForOwner).toBe(true);
    expect(o.routine(item)).toBeNull();
    expect(o.books.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel).toBe("trainee");
  });

  it("takes a live post down: through Facebook's API, by hand on Instagram, with a trust level for the agent's own", () => {
    const { o, posts } = approvedMonth("autonomous");
    const p = posts.find((x) => x.approvedBy === "agent" && x.variants.some((v) => v.channelId === "ch-facebook"))!;
    for (const v of p.variants) Object.assign(v, { status: "published", externalId: `ext-${v.channelId}` });
    o.takeEffects();
    expect(o.takeDown(p.id, "ch-facebook", "Asha").byHand).toBe(false);
    expect(o.takeEffects()).toEqual([{ kind: "remove", postId: p.id, channelId: "ch-facebook" }]);
    expect(o.books.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel).toBe("trusted");
    const other = p.variants.find((v) => v.channelId !== "ch-facebook")!;
    expect(o.takeDown(p.id, other.channelId, "Asha").byHand).toBe(true);
    expect(() => o.takeDown(p.id, "ch-facebook", "Asha")).toThrow(/not live/);
  });
});
