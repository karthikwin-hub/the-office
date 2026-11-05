import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import {
  applyTranslation,
  detectLanguage,
  digestChannel,
  fingerprint,
  handleWhatsApp,
  keepsFigures,
  newSession,
  OfficeService,
  parseCommand,
  PHRASES,
  render,
  REVIEW_ON_DESK,
  WA_LIST,
  WA_MAX,
  type WaPerson,
  type WaSession,
} from "../src";

const owner: WaPerson = { name: "Anil Kulkarni", email: "anil@kaverielectricals.in", role: "owner" };
const accountant: WaPerson = { name: "Rajesh Mehta", email: "rajesh@mehtaassociates.in", role: "accountant" };
const opts = { base: "https://office.example" };
let seq = 0;
const say = (office: OfficeService, who: WaPerson, session: WaSession, text: string, extra: object = {}) =>
  handleWhatsApp(office, who, session, { id: `wamid.${++seq}`, text, at: "2026-11-04T09:00:00+05:30", ...extra }, opts);
const text = (t: { parts: { text: string }[] }) => render(t.parts);

describe("WhatsApp: reading what people send", () => {
  it("reads commands and numbered answers in English, Hindi and Marathi", () => {
    expect(parseCommand("desk")).toEqual({ kind: "desk" });
    expect(parseCommand("Hi")).toEqual({ kind: "desk" });
    expect(parseCommand("Good morning")).toEqual({ kind: "desk" });
    expect(parseCommand("नमस्ते")).toEqual({ kind: "desk" });
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("JOIN 4821")).toEqual({ kind: "join", code: "4821" });
    expect(parseCommand("1 yes, 2 later 3 no")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }, { n: 2, action: "later" }, { n: 3, action: "reject" }] });
    expect(parseCommand("1 haan 2 nahi 3 baad mein")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }, { n: 2, action: "reject" }, { n: 3, action: "later" }] });
    expect(parseCommand("१ हाँ २ नहीं")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }, { n: 2, action: "reject" }] });
    expect(parseCommand("1 हो, 2 नाही")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }, { n: 2, action: "reject" }] });
    expect(parseCommand("all yes")).toEqual({ kind: "decide", items: [{ n: "all", action: "approve" }] });
    expect(parseCommand("sab haan")).toEqual({ kind: "decide", items: [{ n: "all", action: "approve" }] });
    expect(parseCommand("1 2 yes")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }, { n: 2, action: "approve" }] });
    expect(parseCommand("1yes")).toEqual({ kind: "decide", items: [{ n: 1, action: "approve" }] });
    expect(parseCommand("3")).toEqual({ kind: "show", n: 3 });
    expect(parseCommand("Who owes me the most?")).toEqual({ kind: "ask", text: "Who owes me the most?" });
    expect(parseCommand("No stock of 32 A MCBs?").kind).toBe("ask");
  });

  it("tells the language from the script and from common words, and stays quiet on bare commands", () => {
    expect(detectLanguage("सबसे ज़्यादा बकाया किस पर है?")).toBe("hi");
    expect(detectLanguage("सर्वात जास्त थकबाकी कोणाकडे आहे?")).toBe("mr");
    expect(detectLanguage("સૌથી વધુ બાકી કોની પાસે છે?")).toBe("gu");
    expect(detectLanguage("அதிகம் பாக்கி யாரிடம்?")).toBe("ta");
    expect(detectLanguage("ఎక్కువ బాకీ ఎవరిది?")).toBe("te");
    expect(detectLanguage("ಹೆಚ್ಚು ಬಾಕಿ ಯಾರದು?")).toBe("kn");
    expect(detectLanguage("সবচেয়ে বেশি বাকি কার কাছে?")).toBe("bn");
    expect(detectLanguage("sabse zyada kaun baaki hai")).toBe("hi");
    expect(detectLanguage("Who owes me the most?")).toBe("en");
    expect(detectLanguage("1 yes 2 no")).toBeNull();
    expect(detectLanguage("desk")).toBeNull();
  });

  it("has every phrase in every language, with the same placeholders", () => {
    const keys = Object.keys(PHRASES.en);
    for (const [lang, table] of Object.entries(PHRASES)) {
      expect(Object.keys(table).sort(), lang).toEqual([...keys].sort());
      for (const k of keys) {
        const want = (PHRASES.en as Record<string, string>)[k]!.match(/\{\w+\}/g)?.sort() ?? [];
        const got = (table as Record<string, string>)[k]!.match(/\{\w+\}/g)?.sort() ?? [];
        expect(got, `${lang}.${k}`).toEqual(want);
      }
    }
  });
});

describe("WhatsApp: the desk", () => {
  it("sends a short digest and a numbered list of up to nine, with the rest on the desk", () => {
    const office = new OfficeService(loadBooks());
    const t = say(office, owner, newSession(), "desk");
    const out = text(t);
    expect(out).toMatch(/^Hello Anil\./);
    expect(out).toContain(`${office.desk().items.length} waiting on your desk:`);
    expect(t.session.list).toHaveLength(WA_LIST);
    expect(out).toContain("9. ");
    expect(out).not.toContain("10. ");
    expect(out).toContain(`And ${office.desk().items.length - WA_LIST} more on your desk: https://office.example/desk`);
    expect(out).toContain("Reply like 1 yes, 2 no, 3 later, or all yes.");
    expect(t.parts.filter((p) => p.translate)).toHaveLength(WA_LIST);
  });

  it("approves and rejects by number through decide, and leaves 'later' alone", () => {
    const office = new OfficeService(loadBooks());
    for (const i of office.desk().items) if (REVIEW_ON_DESK.has(i.kind)) office.decide(i.id, { action: "reject" }, "Anil Kulkarni");
    let s = say(office, owner, newSession(), "desk").session;
    const simple = s.list.filter((l) => !REVIEW_ON_DESK.has(office.allStaged().find((x) => x.id === l.id)!.kind));
    expect(simple.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = simple;
    const t = say(office, owner, s, `${a!.n} yes ${b!.n} no ${c!.n} later`);
    s = t.session;
    const byId = (id: string) => office.allStaged().find((x) => x.id === id)!;
    expect(byId(a!.id)).toMatchObject({ status: "approved", decidedBy: "Anil Kulkarni", note: "Decided on WhatsApp" });
    expect(byId(b!.id).status).toBe("rejected");
    expect(byId(c!.id).status).toBe("pending");
    expect(t.decided.map((d) => d.id)).toEqual([a!.id, b!.id]);
    expect(text(t)).toContain(`${a!.n}: approved.`);
    expect(text(t)).toContain(`${c!.n}: left for later.`);
    expect(text(say(office, owner, s, `${a!.n} yes`))).toContain(`${a!.n} is no longer waiting.`);
  });

  it("answers in Hindi when asked in Hindi, using the same numbers", () => {
    const office = new OfficeService(loadBooks());
    const s = say(office, owner, newSession(), "नमस्ते").session;
    expect(s.language).toBe("hi");
    const first = s.list.find((l) => !REVIEW_ON_DESK.has(office.allStaged().find((x) => x.id === l.id)!.kind))!;
    const t = say(office, owner, s, `${first.n} हाँ`);
    expect(text(t)).toBe(`${first.n}: मंज़ूर।`);
  });

  it("refuses the accountant's approvals politely, but answers their questions", () => {
    const office = new OfficeService(loadBooks());
    const s = say(office, accountant, newSession(), "desk").session;
    expect(text(say(office, accountant, s, "desk"))).not.toContain("Reply like");
    const before = office.desk().items.length;
    const t = say(office, accountant, s, "all yes");
    expect(text(t)).toBe("Only the owner can approve work. You can still ask questions.");
    expect(office.desk().items.length).toBe(before);
    expect(text(say(office, accountant, s, "How much GST do I pay?"))).toMatch(/GST/);
  });

  it("will not approve an item that changed after the list was sent", () => {
    const office = new OfficeService(loadBooks());
    const s = say(office, owner, newSession(), "desk").session;
    const l = s.list.find((x) => !REVIEW_ON_DESK.has(office.allStaged().find((i) => i.id === x.id)!.kind))!;
    const item = office.allStaged().find((x) => x.id === l.id)!;
    item.summary = `${item.summary} Amount revised.`;
    expect(fingerprint(item)).not.toBe(l.print);
    const t = say(office, owner, s, `${l.n} yes`);
    expect(text(t)).toBe(`${l.n} has changed since the list was sent. Send desk to look again.`);
    expect(item.status).toBe("pending");
  });

  it("sends calendars, payroll and broadcasts to the desk instead of approving them by number", () => {
    const office = new OfficeService(loadBooks());
    const s = say(office, owner, newSession(), "desk").session;
    const review = s.list.find((l) => REVIEW_ON_DESK.has(office.allStaged().find((x) => x.id === l.id)!.kind));
    expect(review).toBeDefined();
    const t = say(office, owner, s, "all yes");
    expect(office.allStaged().find((x) => x.id === review!.id)!.status).toBe("pending");
    expect(text(t)).toContain(`${review!.n} needs a proper look before it goes. Open it on your desk: https://office.example/desk`);
  });

  it("handles a repeated delivery only once", () => {
    const office = new OfficeService(loadBooks());
    const s = say(office, owner, newSession(), "desk").session;
    const l = s.list.find((x) => !REVIEW_ON_DESK.has(office.allStaged().find((i) => i.id === x.id)!.kind))!;
    const msg = { id: "wamid.same", text: `${l.n} no`, at: "2026-11-04T09:01:00+05:30" };
    const once = handleWhatsApp(office, owner, s, msg, opts);
    const again = handleWhatsApp(office, owner, once.session, msg, opts);
    expect(once.decided).toHaveLength(1);
    expect(again).toMatchObject({ duplicate: true, parts: [], decided: [] });
  });

  it("asks without a list, says so; a number alone shows the item", () => {
    const office = new OfficeService(loadBooks());
    expect(text(say(office, owner, newSession(), "1 yes"))).toBe("Send desk to see what is waiting.");
    const s = say(office, owner, newSession(), "desk").session;
    const out = text(say(office, owner, s, "2"));
    expect(out).toContain(`2. ${office.allStaged().find((x) => x.id === s.list[1]!.id)!.title}`);
    expect(text(say(office, owner, s, "12 yes"))).toBe("There is no 12 on the list. Send desk for a fresh list.");
  });
});

describe("WhatsApp: questions, voice and length", () => {
  it("passes questions to the Office Manager and links each figure to its source", () => {
    const office = new OfficeService(loadBooks());
    const t = say(office, owner, newSession(), "Who owes me the most?");
    const out = text(t);
    expect(out).toMatch(/^Customers owe ₹/);
    expect(out).toContain("https://office.example/?figure=ageing%3Atotal");
    expect(t.parts[0]!.translate).toBe(true);
  });

  it("uses the English of a question asked in another language, and repeats a voice note back first", () => {
    const office = new OfficeService(loadBooks());
    const t = say(office, owner, newSession(), "सबसे ज़्यादा बकाया किस पर है?", { heard: true, english: "Who owes me the most?" });
    expect(t.session.language).toBe("hi");
    expect(t.parts[0]!.text).toBe('मैंने सुना: "सबसे ज़्यादा बकाया किस पर है?"');
    expect(t.parts[1]!.text).toMatch(/^Customers owe/);
  });

  it("keeps replies inside WhatsApp's limit", () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ text: `${i + 1}. A long line about a bill that is waiting on the desk` }));
    const out = render(long);
    expect(out.length).toBeLessThanOrEqual(WA_MAX);
    expect(out.endsWith("\n…")).toBe(true);
    expect(render([{ text: "short" }])).toBe("short");
  });

  it("keeps amounts, numbers and links through translation, or falls back to English", () => {
    const src = "Customers owe ₹59.9 lakh (https://office.example/?figure=ageing%3Atotal) in all; invoice KE/26-27/046 is 40 days late.";
    expect(keepsFigures(src, "ग्राहकों पर कुल ₹59.9 लाख (https://office.example/?figure=ageing%3Atotal) बकाया है; इनवॉइस KE/26-27/046 को 40 दिन हो गए।")).toBe(true);
    expect(keepsFigures(src, "ग्राहकों पर कुल ₹60 लाख बकाया है; इनवॉइस KE/26-27/046 को 40 दिन हो गए।")).toBe(false);
    const parts = [{ text: "Hello." }, { text: src, translate: true }, { text: "Bill for ₹18,450", translate: true }];
    const out = applyTranslation(parts, ["ग्राहकों पर ₹59 लाख", "₹18,450 का बिल"]);
    expect(out[0]!.text).toBe("Hello.");
    expect(out[1]!.text).toBe(src);
    expect(out[2]!.text).toBe("₹18,450 का बिल");
  });

  it("sends the morning digest on WhatsApp only inside the 24-hour window, else by template or email", () => {
    const now = Date.parse("2026-11-05T03:15:00Z");
    const recent = "2026-11-04T09:00:00+05:30";
    const old = "2026-11-03T09:00:00+05:30";
    expect(digestChannel({ wantsWhatsApp: true, lastAt: recent, now, template: false })).toBe("whatsapp");
    expect(digestChannel({ wantsWhatsApp: true, lastAt: old, now, template: false })).toBe("email");
    expect(digestChannel({ wantsWhatsApp: true, lastAt: old, now, template: true })).toBe("template");
    expect(digestChannel({ wantsWhatsApp: true, lastAt: null, now, template: false })).toBe("email");
    expect(digestChannel({ wantsWhatsApp: false, lastAt: recent, now, template: true })).toBe("email");
  });
});
