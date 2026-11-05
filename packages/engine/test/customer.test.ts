import type { TrustLevel } from "@office/contracts";
import { loadBooks, sampleCustomerService } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { classifyRules, converse, decisive, handleWhatsApp, type Inbound, newSession, OfficeService, parseClassification, parseOrderCommand, render } from "../src";

const ASOF = "2026-11-04";

function office(trustLevel: TrustLevel = "trusted") {
  const o = new OfficeService(loadBooks(), { asOf: ASOF });
  const cs = sampleCustomerService(ASOF);
  o.books.customerService = cs.setup;
  o.books.orders = cs.orders;
  o.setHiring("customer-service", { hired: true, trustLevel });
  return o;
}

const wa = (text: string, key = "919489305653"): Inbound => ({ channel: "whatsapp", key, name: "Rakesh Sharma", text, at: new Date().toISOString() });
const web = (text: string, key = "visitor-test-000000000001"): Inbound => ({ channel: "web", key, name: "Website visitor", text });
const say = (o: OfficeService, m: Inbound) => o.customers.receive(m, o.customers.prepare(m).rules);
const lastOut = (o: OfficeService, threadId: string) => o.customers.threadView(threadId).messages.filter((m) => m.direction === "out").at(-1);
const cards = (o: OfficeService, kind: string) => o.books.staged.filter((s) => s.kind === kind && s.status === "pending");

describe("reading a customer's message", () => {
  it("picks saved answers, facts and orders by rule, and is sure of the sensitive and human ones", () => {
    const { setup } = sampleCustomerService(ASOF);
    expect(classifyRules("Will I get a GST invoice?", setup.answers, setup.facts)).toMatchObject({ intent: "answer", answerId: "ans-gst-invoice" });
    expect(classifyRules("What time do you open on Saturday?", setup.answers, setup.facts)).toMatchObject({ intent: "fact", fact: "hours" });
    expect(classifyRules("where is my order SO-1042", setup.answers, setup.facts)).toMatchObject({ intent: "order_status", orderNumber: "SO-1042" });
    expect(classifyRules("How much do we owe you right now?", setup.answers, setup.facts).intent).toBe("balance");
    const refund = classifyRules("The coils were damaged, I want a refund", setup.answers, setup.facts);
    expect(refund.intent).toBe("sensitive");
    expect(decisive(refund)).toBe(true);
    expect(classifyRules("Can I talk to a PERSON please", setup.answers, setup.facts).intent).toBe("human");
    expect(classifyRules("मुझे किसी इंसान से बात करनी है", setup.answers, setup.facts).intent).toBe("human");
  });

  it("keeps the rules' call on sensitive topics and drops answers the model made up", () => {
    const { setup } = sampleCustomerService(ASOF);
    const rules = classifyRules("I want a refund", setup.answers, setup.facts);
    expect(parseClassification({ intent: "answer", answerId: "ans-gst-invoice", confidence: 0.99, summary: "x" }, rules, setup.answers, setup.facts).intent).toBe("sensitive");
    const plain = classifyRules("hmm, something about wires", setup.answers, setup.facts);
    const invented = parseClassification({ intent: "answer", answerId: "ans-made-up", confidence: 0.95, summary: "x" }, plain, setup.answers, setup.facts);
    expect(invented.answerId).toBeNull();
    expect(invented.intent).not.toBe("answer");
  });

  it("asks the model only when the rules are unsure, and falls back to them when it fails", async () => {
    const o = office();
    let asked = 0;
    await converse(o.customers, web("Will I get a GST invoice?"), async () => (asked++, {}));
    expect(asked).toBe(0);
    const r = await converse(o.customers, web("so what do you reckon about the thing", "visitor-test-000000000002"), async () => {
      asked++;
      throw new Error("model down");
    });
    expect(asked).toBe(1);
    expect(r.outcome).toBe("handed_off");
  });
});

describe("who the customer is", () => {
  it("tells a WhatsApp customer about their own orders, since the number proves who they are", () => {
    const o = office();
    const r = say(o, wa("Where is my order?"));
    expect(r.outcome).toBe("sent");
    expect(lastOut(o, r.thread.id)!.text).toContain("SO-1042");
  });

  it("tells a website visitor nothing about an order until they give the phone or email on it", () => {
    const o = office();
    const r = say(o, web("where is my order SO-1042"));
    const first = lastOut(o, r.thread.id)!;
    expect(first.ground).toBe("verify");
    expect(first.text).not.toContain("dispatched");
    say(o, web("SO-1042, my phone is 9489305653"));
    const second = lastOut(o, r.thread.id)!;
    expect(second.ground).toBe("order");
    expect(second.text).toContain("SO-1042");
  });

  it("does not show someone else's order to a number that is not on it", () => {
    const o = office();
    const r = say(o, wa("status of SO-1043?"));
    expect(lastOut(o, r.thread.id)!.text).not.toContain("Armoured");
  });
});

describe("what only the owner answers", () => {
  it("hands refunds and complaints over with a holding reply, one card per conversation", () => {
    const o = office();
    const r = say(o, wa("Two coils were damaged and I want a refund"));
    expect(r.outcome).toBe("handed_off");
    expect(lastOut(o, r.thread.id)!.ground).toBe("holding");
    expect(cards(o, "handoff")).toHaveLength(1);
    expect(o.customers.takeEffects().some((e) => e.kind === "notify")).toBe(true);
    say(o, wa("Hello? Anyone?"));
    expect(cards(o, "handoff")).toHaveLength(1);
  });

  it("sends the owner's answer from the hand-off card and can keep it as a saved answer", () => {
    const o = office();
    say(o, wa("Two coils were damaged and I want a refund"));
    const card = cards(o, "handoff")[0]!;
    o.customers.takeEffects();
    o.decide(card.id, { action: "approve", edits: { reply: "Sorry about that. Send a photo and we will replace them tomorrow.", saveAs: "Damaged goods" } }, "Asha");
    const sent = o.customers.takeEffects().filter((e) => e.kind === "send");
    expect(sent.at(-1)).toMatchObject({ channel: "whatsapp", to: "919489305653" });
    expect(o.books.customerService.answers.some((a) => a.title === "Damaged goods")).toBe(true);
  });
});

describe("trust", () => {
  it("as a trainee drafts every reply for the desk and sends nothing", () => {
    const o = office("trainee");
    const r = say(o, wa("Will I get a GST invoice?"));
    expect(r.outcome).toBe("drafted");
    expect(cards(o, "customer_reply")).toHaveLength(1);
    expect(o.customers.takeEffects().filter((e) => e.kind === "send")).toHaveLength(0);
    say(o, wa("I want a refund"));
    expect(o.customers.takeEffects().filter((e) => e.kind === "send")).toHaveLength(0);
  });

  it("when trusted, sends saved answers but drafts business facts; when autonomous, sends both", () => {
    const trusted = office("trusted");
    expect(say(trusted, wa("Will I get a GST invoice?")).outcome).toBe("sent");
    expect(say(trusted, wa("What are your opening hours?", "919000000001")).outcome).toBe("drafted");
    const auto = office("autonomous");
    expect(say(auto, wa("What are your opening hours?", "919000000001")).outcome).toBe("sent");
  });

  it("says it is an AI in its first message, and only then", () => {
    const o = office();
    const r = say(o, wa("Hi"));
    expect(lastOut(o, r.thread.id)!.text).toMatch(/AI/);
    say(o, wa("Will I get a GST invoice?"));
    expect(lastOut(o, r.thread.id)!.text).not.toMatch(/AI assistant/);
  });

  it("stops replying to a flood, and ignores a message it has already seen", () => {
    const o = office();
    let last = "";
    for (let i = 0; i < 10; i++) last = say(o, { ...wa(`hello ${i}`), externalId: `wamid-${i}` }).outcome;
    expect(last).toBe("limited");
    expect(say(o, { ...wa("hello 0"), externalId: "wamid-0" }).outcome).toBe("duplicate");
  });

  it("answers nothing while it is not on the team", () => {
    const o = office();
    o.setHiring("customer-service", { hired: false });
    expect(say(o, wa("Hi")).outcome).toBe("ignored");
  });
});

describe("the owner on WhatsApp", () => {
  const owner = { name: "Asha Kulkarni", email: "asha@kaveri.test", role: "owner" as const };
  const turn = (o: OfficeService, text: string, who: { name: string; email: string; role: "owner" | "accountant" } = owner) => handleWhatsApp(o, who, newSession(), { id: `m-${Math.random()}`, text, at: new Date().toISOString() }, { base: "https://office.test" });

  it("answers a handed-over customer with \"reply N\", and updates an order with \"order N status\"", () => {
    const o = office();
    say(o, wa("I want a refund for the damaged coils"));
    const ref = (cards(o, "handoff")[0]!.payload as { ref: number }).ref;
    o.customers.takeEffects();
    expect(render(turn(o, `reply ${ref} We will replace them tomorrow.`).parts)).toContain("Sent to Rakesh Sharma on WhatsApp");
    expect(o.customers.takeEffects().find((e) => e.kind === "send")).toMatchObject({ to: "919489305653", text: "We will replace them tomorrow." });
    expect(cards(o, "handoff")).toHaveLength(0);
    expect(render(turn(o, "order 1043 dispatched https://track.example/9").parts)).toContain("SO-1043");
    expect(o.books.orders.find((x) => x.number === "SO-1043")).toMatchObject({ status: "dispatched", tracking: "https://track.example/9" });
    expect(render(turn(o, "order 1043 delivered", { name: "CA", email: "ca@x.test", role: "accountant" }).parts)).not.toContain("SO-1043");
  });

  it("reads an owner's order update", () => {
    expect(parseOrderCommand("order 1042 dispatched https://track.example/1")).toMatchObject({ number: "1042", status: "dispatched", tracking: "https://track.example/1" });
    expect(parseOrderCommand("order so-1043 shipped")).toMatchObject({ number: "SO-1043", status: "dispatched", tracking: null });
    expect(parseOrderCommand("hello")).toBeNull();
  });
});
