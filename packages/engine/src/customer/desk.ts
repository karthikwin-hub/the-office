import type { BusinessFacts, CannedAnswer, CsChannel, CsGround, CsMessage, CsThread, CsThreadView, CustomerDeskView, Kpi, Order, OrderStatus, StagedChange } from "@office/contracts";
import { CS_CHANNEL_NAMES } from "@office/contracts";
import { openInvoices } from "../ageing";
import { dateLabel } from "../dates";
import { inr } from "../money";
import type { OfficeService } from "../office";
import {
  type Classification,
  classifierPrompt,
  classifyRules,
  decisive,
  disclosure,
  emailsIn,
  FACT_NAMES,
  holdingReply,
  HUMAN_TOPIC_NAMES,
  MIN_CONFIDENCE,
  orderNumbers,
  parseClassification,
  phonesIn,
  samePhone,
  scoreAnswers,
  verifyPrompt,
} from "./brain";
import { BooksOrderSource, importOrders, type OrderSource, orderBelongsTo, STATUS_WORDS } from "./orders";
import type { CsStore } from "./store";

export const CS_AGENT = "customer-service";
/** Meta's free service messages per business number per month, from 1 October 2026. */
export const WHATSAPP_FREE_SERVICE = 1000;
const WINDOW_MS = 24 * 3600_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 8;

/** A message from a customer, as a channel hands it over. */
export type Inbound = {
  channel: CsChannel;
  /** The phone number, email address or website visitor id. */
  key: string;
  name: string;
  text: string;
  externalId?: string | null;
  subject?: string | null;
  inReplyTo?: string | null;
  at?: string;
  test?: boolean;
};

/** Work for the host: send a message on its channel, or tell the owners on WhatsApp about a hand-off. */
export type CsEffect =
  | { kind: "send"; threadId: string; messageId: string; channel: CsChannel; to: string; text: string; subject: string | null; inReplyTo: string | null }
  | { kind: "notify"; stagedId: string; ref: number; text: string };

export type ReceiveResult = { thread: CsThread; outcome: "sent" | "drafted" | "handed_off" | "duplicate" | "ignored" | "limited"; notes: string[] };

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Customer Service agent. Everything it decides is here and synchronous; reading a message with
 * the model and sending replies are the host's, so the Worker and the mockups behave the same.
 */
export class CustomerService {
  effects: CsEffect[] = [];
  readonly sources: OrderSource[];
  /** While a message is being answered: a moment after it arrived, so a replayed message is answered when it was sent. */
  private clock: string | null = null;

  constructor(
    private office: OfficeService,
    readonly store: CsStore,
    sources?: OrderSource[],
  ) {
    this.sources = sources ?? [new BooksOrderSource(office.books)];
  }

  get setup() {
    return this.office.books.customerService;
  }

  takeEffects(): CsEffect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  private trust() {
    return this.office.books.agents.find((a) => a.agentId === CS_AGENT)?.trustLevel ?? "trainee";
  }

  private business() {
    return this.office.books.business.name || "this business";
  }

  /* ---------- Reading a message ---------- */

  private findThread(m: Inbound): CsThread | null {
    if (m.inReplyTo) {
      const prior = this.store.byExternal(m.inReplyTo);
      const t = prior ? this.store.thread(prior.threadId) : null;
      if (t && t.channel === m.channel && t.key === m.key) return t;
    }
    const t = this.store.threadByKey(m.channel, m.key);
    if (!t || t.test !== Boolean(m.test)) return null;
    if (m.channel === "email" && Date.now() - Date.parse(t.lastAt) > 7 * 86_400_000) return null;
    return t;
  }

  /** The rules' reading and, unless they are already sure, what to ask the model. */
  prepare(m: Inbound): { rules: Classification; prompt: { system: string; user: string } | null; candidates: CannedAnswer[] } {
    const answers = this.setup.answers;
    const rules = classifyRules(m.text, answers, this.setup.facts);
    const candidates = scoreAnswers(m.text, answers).map((s) => s.answer);
    const pool = candidates.length ? candidates : answers.filter((a) => a.enabled).slice(0, 5);
    if (decisive(rules) || (!m.test && !this.office.hired(CS_AGENT))) return { rules, prompt: null, candidates: pool };
    const t = this.findThread(m);
    const recent = t ? this.store.messages(t.id).slice(-4).map((x) => `${x.direction === "in" ? "Customer" : "Us"}: ${x.text}`) : [];
    return { rules, prompt: classifierPrompt(this.business(), m.text, recent, pool, this.setup.facts), candidates: pool };
  }

  /** What the model said, checked against the rules and the owner's records. */
  classify(raw: unknown, rules: Classification, candidates: CannedAnswer[]): Classification {
    return parseClassification(raw, rules, candidates, this.setup.facts);
  }

  /** Works out who the customer is, from what the channel proves and what they tell us. */
  private identify(t: CsThread, text: string) {
    const parties = this.office.books.parties.filter((p) => p.kind === "customer");
    if (t.channel === "whatsapp" && !t.test) {
      t.verifiedContact = t.key;
      t.partyId = t.partyId ?? parties.find((p) => p.contact.phone && samePhone(p.contact.phone, t.key))?.id ?? null;
      return;
    }
    if (t.channel === "email" && !t.test) {
      t.verifiedContact = t.key.toLowerCase();
      t.partyId = t.partyId ?? parties.find((p) => p.contact.email && p.contact.email.toLowerCase() === t.key.toLowerCase())?.id ?? null;
      return;
    }
    if (t.verifiedContact) return;
    const recent = [...this.store.messages(t.id).filter((x) => x.direction === "in").slice(-4).map((x) => x.text), text].join("\n");
    const phones = phonesIn(recent);
    const emails = emailsIn(recent);
    for (const n of orderNumbers(recent)) {
      const o = this.findOrder(n);
      if (!o) continue;
      const phone = phones.find((p) => o.phone && samePhone(o.phone, p));
      const email = emails.find((e) => o.email && o.email.toLowerCase() === e);
      if (phone || email) {
        t.verifiedContact = phone ?? email!;
        t.partyId = o.partyId;
        return;
      }
    }
  }

  private findOrder(number: string): Order | null {
    for (const s of this.sources) {
      const o = s.find(number);
      if (o) return o;
    }
    return null;
  }

  private who(t: CsThread) {
    const c = t.verifiedContact;
    return { phone: c && !c.includes("@") ? c : null, email: c && c.includes("@") ? c : null, partyId: t.partyId };
  }

  /**
   * One message from a customer: recorded, the customer identified, then answered from the owner's
   * records, drafted for the owner, or handed over. `c` is the rules' reading or the model's, checked.
   */
  receive(m: Inbound, c: Classification): ReceiveResult {
    const now = m.at ?? new Date().toISOString();
    this.clock = m.at ? new Date(Math.min(Date.parse(m.at) + 2000, Date.now())).toISOString() : null;
    try {
      return this.answerMessage(m, c, now);
    } finally {
      this.clock = null;
    }
  }

  private answerMessage(m: Inbound, c: Classification, now: string): ReceiveResult {
    const notes: string[] = [];
    if (m.externalId && this.store.byExternal(m.externalId)) {
      const prior = this.store.byExternal(m.externalId)!;
      return { thread: this.store.thread(prior.threadId)!, outcome: "duplicate", notes };
    }
    let t = this.findThread(m);
    if (!t) {
      t = { id: newId("cst"), channel: m.channel, key: m.key, name: m.name.slice(0, 120) || CS_CHANNEL_NAMES[m.channel], partyId: null, verifiedContact: null, status: "open", subject: m.subject?.slice(0, 200) ?? null, startedAt: now, lastAt: now, lastInboundAt: null, disclosed: false, handoffs: 0, firstReplySeconds: null, test: Boolean(m.test) };
    }
    if (!m.test && !this.office.hired(CS_AGENT)) return { thread: t, outcome: "ignored", notes };
    this.identify(t, m.text);
    const recentIn = this.store.messages(t.id).filter((x) => x.direction === "in" && Date.parse(now) - Date.parse(x.at) < RATE_WINDOW_MS).length;
    this.store.addMessage({ id: newId("csm"), threadId: t.id, at: now, direction: "in", by: "customer", text: m.text.slice(0, 4000), intent: c.intent, ground: null, status: "received", externalId: m.externalId ?? null, error: null });
    t.lastAt = now;
    t.lastInboundAt = now;
    if (m.name && t.name === CS_CHANNEL_NAMES[m.channel]) t.name = m.name.slice(0, 120);
    this.supersede(t.id);

    if (recentIn >= RATE_LIMIT) {
      this.store.saveThread(t);
      notes.push("Too many messages in ten minutes; this one was recorded without a reply.");
      return { thread: t, outcome: "limited", notes };
    }

    const plan = this.answer(t, c);
    if (plan.kind === "handoff") return this.handoff(t, c, m.text, plan.reason, notes);
    const last = this.store.messages(t.id).filter((x) => x.direction === "out" && x.by === "agent").slice(-2);
    if (last.length === 2 && last.every((x) => x.text.endsWith(plan.text))) return this.handoff(t, c, m.text, "keeps asking something the agent has already answered twice", notes);

    const level = this.trust();
    const auto = plan.ground === "fact" ? level === "autonomous" : level !== "trainee";
    if (auto) {
      this.deliver(t, plan.text, "agent", plan.ground, c.intent);
      t.status = plan.ground === "verify" ? "open" : "resolved";
      this.store.saveThread(t);
      return { thread: t, outcome: "sent", notes };
    }
    const draft: CsMessage = { id: newId("csm"), threadId: t.id, at: this.clock ?? new Date().toISOString(), direction: "out", by: "agent", text: plan.text, intent: c.intent, ground: plan.ground, status: "draft", externalId: null, error: null };
    this.store.addMessage(draft);
    t.status = "waiting";
    this.store.saveThread(t);
    if (t.test) {
      notes.push(level === "trainee" ? "This reply would wait on your desk for approval, because the agent is a trainee." : "This reply would wait on your desk: only an autonomous agent answers from your business facts on its own.");
      return { thread: t, outcome: "drafted", notes };
    }
    this.office.books.staged.push({
      id: `cs-re-${draft.id}`,
      agentId: CS_AGENT,
      kind: "customer_reply",
      createdAt: this.office.nowIst(),
      title: `Reply to ${t.name} on ${CS_CHANNEL_NAMES[t.channel]}`,
      summary: `They wrote: ${quoted(m.text, 160)} The reply comes from ${groundName(plan.ground)}.`,
      evidence: [{ label: "The conversation", ref: { kind: "conversation", id: t.id } }],
      payload: { threadId: t.id, messageId: draft.id, reply: plan.text, ask: m.text.slice(0, 500), ground: plan.ground },
      status: "pending",
    });
    this.office.log(CS_AGENT, `Drafted a reply to ${t.name} on ${CS_CHANNEL_NAMES[t.channel]} for your approval.`, { kind: "conversation", id: t.id });
    return { thread: t, outcome: "drafted", notes };
  }

  /** What the agent can say, and from which record; or why it must go to the owner. */
  private answer(t: CsThread, c: Classification): { kind: "reply"; text: string; ground: CsGround } | { kind: "handoff"; reason: string } {
    const facts = this.setup.facts;
    if (c.intent === "sensitive") return { kind: "handoff", reason: HUMAN_TOPIC_NAMES[c.topic ?? "complaint"] };
    if (c.intent === "human") return { kind: "handoff", reason: "asked for a person" };
    if (c.confidence < MIN_CONFIDENCE && c.intent !== "order_status") return { kind: "handoff", reason: "asked something the agent could not answer from your records" };
    const name = first(t.name);
    switch (c.intent) {
      case "greeting":
        return { kind: "reply", ground: "greeting", text: `Hello${name && !/^(website|whatsapp|email)$/i.test(name) ? ` ${name}` : ""}! I can help with your orders, your invoices and questions about ${this.business()}. What can I do for you?` };
      case "thanks":
        return { kind: "reply", ground: "greeting", text: "You are welcome. Write any time if there is anything else." };
      case "answer": {
        const a = this.setup.answers.find((x) => x.id === c.answerId && x.enabled);
        return a ? { kind: "reply", ground: "answer", text: a.answer } : { kind: "handoff", reason: "asked something none of your answers covers" };
      }
      case "fact": {
        const v = c.fact ? facts[c.fact].trim() : "";
        if (!c.fact || !v) return { kind: "handoff", reason: `asked about your ${c.fact ? FACT_NAMES[c.fact] : "business"}, which is not in your business facts yet` };
        const label: Record<string, string> = { hours: "Our opening hours", address: "You can find us at", delivery: "On delivery", returns: "On returns", payments: "We accept" };
        return { kind: "reply", ground: "fact", text: `${label[c.fact]}: ${v}` };
      }
      case "order_status":
        return this.orderReply(t, c);
      case "balance":
        return this.balanceReply(t);
    }
    return { kind: "handoff", reason: "asked something the agent could not answer from your records" };
  }

  private orderReply(t: CsThread, c: Classification): { kind: "reply"; text: string; ground: CsGround } | { kind: "handoff"; reason: string } {
    const who = this.who(t);
    const verified = Boolean(t.verifiedContact || t.partyId);
    const asked = c.orderNumber ? this.findOrder(c.orderNumber) : null;
    let orders: Order[];
    if (asked) orders = verified && orderBelongsTo(asked, who) ? [asked] : [];
    else if (verified) orders = this.sources.flatMap((s) => s.forContact(who)).filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);
    else orders = [];
    if (!orders.length) {
      if (verified && !c.orderNumber && t.channel !== "web") return { kind: "reply", ground: "verify", text: verifyPrompt(t.channel) };
      if (verified && c.orderNumber && !asked) return { kind: "handoff", reason: `asked about order ${c.orderNumber}, which is not in your orders` };
      return { kind: "reply", ground: "verify", text: verifyPrompt(t.channel) };
    }
    const open = orders.filter((o) => o.status !== "delivered" && o.status !== "cancelled");
    const show = (open.length ? open : orders).slice(0, 3);
    const lines = show.map((o) => describeOrder(o, this.office.asOf));
    return { kind: "reply", ground: "order", text: show.length === 1 ? lines[0]! : `Here are your latest orders:\n${lines.map((l) => `- ${l}`).join("\n")}` };
  }

  private balanceReply(t: CsThread): { kind: "reply"; text: string; ground: CsGround } | { kind: "handoff"; reason: string } {
    if (!t.partyId || !this.office.ledger.findParty(t.partyId)) return { kind: "handoff", reason: "asked about their account, but their contact details do not match a customer in your books" };
    const open = openInvoices(this.office.ledger).filter((o) => o.partyId === t.partyId);
    if (!open.length) return { kind: "reply", ground: "balance", text: "Nothing is outstanding on your account. Thank you!" };
    const total = open.reduce((a, o) => a + o.outstandingPaise, 0);
    const overdue = open.filter((o) => o.daysOverdue > 0);
    const oldest = [...open].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0]!;
    return {
      kind: "reply",
      ground: "balance",
      text: `You have ${plural(open.length, "open invoice")} totalling ₹${inr(total)}${overdue.length ? `, of which ${plural(overdue.length, "is", "are")} past due` : ""}. The oldest is ${oldest.number}, due ${dateLabel(oldest.dueDate)}, with ₹${inr(oldest.outstandingPaise)} to pay.`,
    };
  }

  /** The owner must answer. The customer is told so (unless the agent is a trainee) and the owner gets the whole story. */
  private handoff(t: CsThread, c: Classification, text: string, reason: string, notes: string[]): ReceiveResult {
    const level = this.trust();
    const owner = this.office.books.business.owner;
    const tried = c.intent === "sensitive" || c.intent === "human" ? "It did not try to answer: this is always yours." : `It read this as ${c.intent.replace("_", " ")} (${Math.round(c.confidence * 100)}% sure, by ${c.method === "model" ? "the model" : "its rules"}) and found nothing it could send.`;
    if (level !== "trainee" || t.test) this.deliver(t, holdingReply(owner, this.setup.facts), "agent", "holding", c.intent);
    t.status = "handed_off";
    if (t.test) {
      this.store.saveThread(t);
      notes.push(`This would come to you: ${t.name} ${reason}.`);
      return { thread: t, outcome: "handed_off", notes };
    }
    const open = this.office.books.staged.find((s) => s.kind === "handoff" && s.status === "pending" && (s.payload as { threadId?: string }).threadId === t.id);
    if (open) {
      const p = open.payload as { ask?: string };
      open.payload = { ...open.payload, ask: `${p.ask ?? ""}\n${text}`.trim().slice(-1500) };
      open.summary = `${open.summary.split(" They wrote again:")[0]} They wrote again: "${text.slice(0, 120)}".`;
      this.store.saveThread(t);
      return { thread: t, outcome: "handed_off", notes };
    }
    t.handoffs += 1;
    this.store.saveThread(t);
    const ref = this.office.books.staged.filter((s) => s.kind === "handoff").length + 1;
    const greeting = `Hello${first(t.name) ? ` ${first(t.name)}` : ""}, this is ${first(owner) || "the owner"} from ${this.business()}. `;
    const item: StagedChange = {
      id: `cs-ho-${t.id}-${ref}`,
      agentId: CS_AGENT,
      kind: "handoff",
      createdAt: this.office.nowIst(),
      title: `${t.name} on ${CS_CHANNEL_NAMES[t.channel]} ${reason}`,
      summary: `${t.name} wrote: ${quoted(text, 200)} ${tried}${t.partyId ? ` They are ${this.office.ledger.findParty(t.partyId)?.name ?? "a customer"} in your books.` : t.verifiedContact ? "" : " The agent could not tell who they are."}`,
      evidence: [{ label: "The conversation", ref: { kind: "conversation", id: t.id } }, ...(t.partyId ? [{ label: "The customer", ref: { kind: "party" as const, id: t.partyId } }] : [])],
      payload: { threadId: t.id, reason, reply: greeting, ask: text.slice(0, 1500), channel: t.channel, ref, saveAs: "" },
      status: "pending",
    };
    this.office.books.staged.push(item);
    this.office.log(CS_AGENT, `Handed to you: ${t.name} on ${CS_CHANNEL_NAMES[t.channel]} ${reason}.`, { kind: "conversation", id: t.id });
    this.effects.push({ kind: "notify", stagedId: item.id, ref, text: `${t.name} (${CS_CHANNEL_NAMES[t.channel]}) ${reason}:\n"${text.slice(0, 300)}"\n\nReply "reply ${ref} " and your answer to send it to them.` });
    return { thread: t, outcome: "handed_off", notes };
  }

  /** A newer message makes an unanswered draft stale. */
  private supersede(threadId: string) {
    for (const s of this.office.books.staged) {
      if (s.kind !== "customer_reply" || s.status !== "pending" || (s.payload as { threadId?: string }).threadId !== threadId) continue;
      s.status = "rejected";
      s.decidedAt = new Date().toISOString();
      s.decidedBy = "The Customer Service Agent";
      s.note = "The customer wrote again before this was approved.";
      const id = (s.payload as { messageId?: string }).messageId;
      if (id) this.store.updateMessage(id, { status: "withdrawn" });
    }
  }

  /** Queues a message for its channel. The first agent message in a conversation says it is an AI and how to reach a person. */
  private deliver(t: CsThread, body: string, by: "agent" | "owner", ground: CsGround | null, intent: string | null, draftId?: string): CsMessage {
    const now = this.clock ?? new Date().toISOString();
    const text = by === "agent" && !t.disclosed ? `${disclosure(this.business(), this.setup.facts)}\n\n${body}` : body;
    if (by === "agent") t.disclosed = true;
    const lastIn = [...this.store.messages(t.id)].reverse().find((x) => x.direction === "in");
    const closed = t.channel === "whatsapp" && !t.test && (!t.lastInboundAt || Date.now() - Date.parse(t.lastInboundAt) > WINDOW_MS);
    const msg: CsMessage = { id: draftId ?? newId("csm"), threadId: t.id, at: now, direction: "out", by, text, intent, ground, status: closed ? "failed" : "sent", externalId: null, error: closed ? "More than 24 hours since the customer last wrote; WhatsApp only allows an approved template now." : null };
    if (draftId) this.store.updateMessage(draftId, msg);
    else this.store.addMessage(msg);
    if (t.firstReplySeconds === null && t.lastInboundAt) t.firstReplySeconds = Math.max(0, Math.round((Date.parse(now) - Date.parse(t.startedAt)) / 1000));
    t.lastAt = now;
    if (closed) this.office.log(CS_AGENT, `Could not reply to ${t.name} on WhatsApp: it has been more than 24 hours since they wrote. Call them, or send an approved template from WhatsApp.`, { kind: "conversation", id: t.id });
    else if (!t.test && t.channel !== "web") this.effects.push({ kind: "send", threadId: t.id, messageId: msg.id, channel: t.channel, to: t.key, text, subject: t.channel === "email" ? `Re: ${(t.subject ?? this.business()).replace(/^(re:\s*)+/i, "")}` : null, inReplyTo: lastIn?.externalId ?? null });
    return msg;
  }

  markSent(messageId: string, externalId: string | null) {
    this.store.updateMessage(messageId, { status: "sent", externalId, error: null });
  }

  markFailed(messageId: string, error: string) {
    const m = this.store.message(messageId);
    this.store.updateMessage(messageId, { status: "failed", error: error.slice(0, 500) });
    const t = m ? this.store.thread(m.threadId) : null;
    if (t) this.office.log(CS_AGENT, `Could not send the reply to ${t.name} on ${CS_CHANNEL_NAMES[t.channel]}: ${error.slice(0, 160)}`, { kind: "conversation", id: t.id });
  }

  /* ---------- The owner ---------- */

  /** An approved card: a draft goes out as written or edited; a hand-off sends the owner's answer, and can keep it as a saved answer. */
  decided(item: StagedChange, approved: boolean) {
    const p = item.payload as { threadId?: string; messageId?: string; reply?: string; ask?: string; saveAs?: string };
    const t = p.threadId ? this.store.thread(p.threadId) : null;
    if (!t) return;
    if (!approved) {
      if (item.kind === "customer_reply" && p.messageId) this.store.updateMessage(p.messageId, { status: "withdrawn" });
      if (item.kind === "handoff") t.status = "resolved";
      else t.status = "open";
      this.store.saveThread(t);
      return;
    }
    const text = (p.reply ?? "").trim();
    if (!text) return;
    if (item.kind === "customer_reply") this.deliver(t, text, "agent", (item.payload as { ground?: CsGround }).ground ?? null, null, p.messageId);
    else this.deliver(t, text, "owner", "owner", null);
    t.status = "resolved";
    this.store.saveThread(t);
    this.office.log(CS_AGENT, `Sent your reply to ${t.name} on ${CS_CHANNEL_NAMES[t.channel]}.`, { kind: "conversation", id: t.id });
    const title = typeof p.saveAs === "string" ? p.saveAs.trim() : "";
    if (item.kind === "handoff" && title && p.ask) this.addAnswer({ title: title.slice(0, 120), examples: [p.ask.split("\n").at(-1)!.slice(0, 300)], answer: text.slice(0, 2000), enabled: true });
  }

  /** The owner writing in a conversation themselves, from its page or from WhatsApp. Any card waiting on it is settled. */
  ownerReply(threadId: string, text: string, by: string): CsThreadView {
    const t = this.store.thread(threadId);
    if (!t) throw new Error(`No conversation ${threadId}`);
    this.deliver(t, text.trim().slice(0, 4000), "owner", "owner", null);
    t.status = "resolved";
    this.store.saveThread(t);
    for (const s of this.office.books.staged) {
      if ((s.kind !== "handoff" && s.kind !== "customer_reply") || s.status !== "pending" || (s.payload as { threadId?: string }).threadId !== threadId) continue;
      s.status = s.kind === "handoff" ? "approved" : "rejected";
      s.decidedAt = new Date().toISOString();
      s.decidedBy = by;
      s.note = "Answered in the conversation.";
      const id = (s.payload as { messageId?: string }).messageId;
      if (s.kind === "customer_reply" && id) this.store.updateMessage(id, { status: "withdrawn" });
    }
    this.office.log(CS_AGENT, `${by} replied to ${t.name} on ${CS_CHANNEL_NAMES[t.channel]}.`, { kind: "conversation", id: t.id });
    return this.threadView(threadId);
  }

  /** "reply 3 Your refund is on its way" from an owner on WhatsApp. */
  replyByRef(ref: number, text: string, by: string): CsThread | null {
    const card = this.office.books.staged.find((s) => s.kind === "handoff" && (s.payload as { ref?: number }).ref === ref);
    const id = card ? (card.payload as { threadId?: string }).threadId : undefined;
    if (!id || !this.store.thread(id)) return null;
    this.ownerReply(id, text, by);
    return this.store.thread(id);
  }

  /** The morning look: customers waiting on the owner for more than four hours, WhatsApp chats about to close, and old conversations deleted. */
  chase(now = Date.now()): { waiting: string[]; closing: string[]; pruned: number } {
    const pending = this.office.books.staged.filter((s) => s.kind === "handoff" && s.status === "pending");
    const waiting = pending.filter((s) => now - Date.parse(s.createdAt) > 4 * 3600_000).map((s) => this.store.thread((s.payload as { threadId: string }).threadId)?.name ?? "a customer");
    const closing = this.store
      .threads(300)
      .filter((t) => !t.test && t.channel === "whatsapp" && (t.status === "handed_off" || t.status === "waiting") && t.lastInboundAt && now - Date.parse(t.lastInboundAt) > WINDOW_MS - 3 * 3600_000 && now - Date.parse(t.lastInboundAt) < WINDOW_MS)
      .map((t) => t.name);
    const before = new Date(now);
    before.setUTCMonth(before.getUTCMonth() - this.setup.retentionMonths);
    const pruned = this.store.prune(before.toISOString());
    return { waiting, closing, pruned };
  }

  /* ---------- Views ---------- */

  threadView(id: string): CsThreadView {
    const thread = this.store.thread(id);
    if (!thread) throw new Error(`No conversation ${id}`);
    const pending = this.office.books.staged.filter((s) => s.status === "pending" && (s.kind === "handoff" || s.kind === "customer_reply") && (s.payload as { threadId?: string }).threadId === id).map((s) => s.title);
    return { thread, messages: this.store.messages(id).filter((m) => m.status !== "withdrawn"), pending };
  }

  private monthStart() {
    return `${this.office.asOf.slice(0, 7)}-01T00:00:00+05:30`;
  }

  whatsappThisMonth() {
    return this.store.countOut("whatsapp", new Date(Date.parse(this.monthStart())).toISOString());
  }

  kpis(): Kpi[] {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = this.store.threads(1000).filter((t) => !t.test && t.startedAt >= since);
    const waiting = this.office.books.staged.filter((s) => s.kind === "handoff" && s.status === "pending").length;
    const resolved = recent.filter((t) => t.status === "resolved" && t.handoffs === 0).length;
    const replies = recent.map((t) => t.firstReplySeconds).filter((x): x is number => x !== null);
    const avg = replies.length ? Math.round(replies.reduce((a, b) => a + b, 0) / replies.length) : null;
    const wa = this.whatsappThisMonth();
    return [
      { label: "Waiting for you", value: String(waiting), ...(waiting ? { tone: "red" as const } : {}) },
      { label: "Answered without you, 30 days", value: recent.length ? `${Math.round((resolved / recent.length) * 100)}%` : "-" },
      { label: "First reply, on average", value: avg === null ? "-" : avg < 90 ? `${avg} seconds` : avg < 5400 ? `${Math.round(avg / 60)} minutes` : `${Math.round(avg / 3600)} hours` },
      { label: "WhatsApp replies this month", value: `${wa} of ${WHATSAPP_FREE_SERVICE.toLocaleString("en-IN")} free`, ...(wa > WHATSAPP_FREE_SERVICE * 0.8 ? { tone: "red" as const } : {}) },
    ];
  }

  view(): CustomerDeskView {
    const s = this.setup;
    const threads = this.store.threads(100).filter((t) => !t.test).map((t) => {
      const ms = this.store.messages(t.id).filter((m) => m.status !== "withdrawn");
      const last = ms.at(-1);
      return { ...t, preview: last ? `${last.direction === "in" ? "" : last.by === "owner" ? "You: " : "Agent: "}${last.text.slice(0, 120)}` : "", waiting: t.status === "handed_off" || t.status === "waiting" };
    });
    return {
      threads,
      kpis: this.kpis(),
      facts: s.facts,
      answers: s.answers,
      widget: { enabled: s.widget.enabled, key: s.widget.key, snippet: s.widget.key ? `/w/${s.widget.key}.js` : null },
      supportEmail: s.supportEmail,
      retentionMonths: s.retentionMonths,
      whatsappThisMonth: this.whatsappThisMonth(),
    };
  }

  /* ---------- The owner's records ---------- */

  updateFacts(next: Partial<BusinessFacts>): BusinessFacts {
    this.setup.facts = { ...this.setup.facts, ...next };
    this.office.log(CS_AGENT, "Your business facts were updated.");
    return this.setup.facts;
  }

  addAnswer(a: Omit<CannedAnswer, "id">): CannedAnswer {
    const answer: CannedAnswer = { ...a, id: newId("ans") };
    this.setup.answers.push(answer);
    this.office.log(CS_AGENT, `Learned a new answer: "${answer.title}".`);
    return answer;
  }

  updateAnswer(id: string, a: Omit<CannedAnswer, "id">): CannedAnswer {
    const i = this.setup.answers.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No answer ${id}`);
    this.setup.answers[i] = { ...a, id };
    return this.setup.answers[i]!;
  }

  removeAnswer(id: string) {
    const i = this.setup.answers.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No answer ${id}`);
    this.setup.answers.splice(i, 1);
    return { removed: id };
  }

  setRetention(months: number) {
    this.setup.retentionMonths = months;
    return this.view();
  }

  /** Turning the website chat on gives it a key, kept if it is turned off and on again. */
  setWidget(enabled: boolean) {
    const w = this.setup.widget;
    if (enabled && !w.key) {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      w.key = `w${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20)}`;
    }
    w.enabled = enabled;
    this.office.log(CS_AGENT, enabled ? "Turned on the chat on your website." : "Turned off the chat on your website.");
    return this.view().widget;
  }

  /** A customer in the books with this phone or email, so the order is linked to them. */
  private linkParty(o: Pick<Order, "phone" | "email">): string | null {
    const email = o.email.toLowerCase();
    return this.office.books.parties.find((p) => p.kind === "customer" && ((o.phone && p.contact.phone && samePhone(p.contact.phone, o.phone)) || (email && p.contact.email.toLowerCase() === email)))?.id ?? null;
  }

  addOrder(input: { number: string; customer: string; phone?: string; email?: string; items?: string; status?: OrderStatus; placedOn?: string; expectedOn?: string | null; tracking?: string | null; note?: string }): Order {
    const number = input.number.replace(/^#/, "").trim().toUpperCase();
    if (this.office.books.orders.some((o) => o.number.toUpperCase() === number)) throw new Error(`Order ${number} is already here; change it instead.`);
    const o: Order = {
      id: newId("ord"),
      number,
      partyId: null,
      customer: input.customer,
      phone: input.phone ?? "",
      email: (input.email ?? "").toLowerCase(),
      items: input.items ?? "",
      status: input.status ?? "received",
      placedOn: input.placedOn ?? this.office.asOf,
      expectedOn: input.expectedOn ?? null,
      tracking: input.tracking ?? null,
      note: input.note ?? "",
      updatedAt: new Date().toISOString(),
    };
    o.partyId = this.linkParty(o);
    this.office.books.orders.push(o);
    return o;
  }

  updateOrder(id: string, change: Partial<Omit<Order, "id" | "updatedAt" | "partyId">>, by?: string): Order {
    const o = this.office.books.orders.find((x) => x.id === id || x.number.toUpperCase() === id.toUpperCase());
    if (!o) throw new Error(`No order ${id}`);
    const was = o.status;
    Object.assign(o, Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)), { updatedAt: new Date().toISOString() });
    if (change.number) o.number = change.number.replace(/^#/, "").trim().toUpperCase();
    if (change.email !== undefined) o.email = o.email.toLowerCase();
    o.partyId = this.linkParty(o) ?? o.partyId;
    if (by && change.status && change.status !== was) this.office.log(CS_AGENT, `${by} marked order ${o.number} ${change.status}.`, { kind: "order", id: o.id });
    return o;
  }

  /** "order 1042 dispatched <link>" from an owner on WhatsApp; the number may leave out its prefix. */
  orderUpdate(number: string, status: OrderStatus, tracking: string | null, by: string): Order | null {
    const n = number.toUpperCase();
    const digits = n.replace(/\D/g, "");
    const orders = this.office.books.orders;
    const o = orders.find((x) => x.number.toUpperCase() === n) ?? (digits ? orders.filter((x) => x.number.replace(/\D/g, "") === digits) : []).at(0) ?? null;
    return o ? this.updateOrder(o.id, { status, ...(tracking ? { tracking } : {}) }, by) : null;
  }

  removeOrder(id: string) {
    const i = this.office.books.orders.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No order ${id}`);
    this.office.books.orders.splice(i, 1);
    return { removed: id };
  }

  importOrders(content: string, by: string) {
    const r = importOrders(this.office.books, content, this.office.asOf, (o) => this.linkParty(o));
    this.office.log(CS_AGENT, `${by} imported orders: ${r.added} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} rows skipped` : ""}.`);
    return r;
  }
}

/** A customer's words in a summary sentence, ended with a full stop unless they already end one. */
function quoted(text: string, max: number): string {
  const s = text.length > max ? `${text.slice(0, max).trimEnd()}…` : text.trim();
  return `"${s}"${/[.!?…]$/.test(s) ? "" : "."}`;
}

function groundName(g: CsGround): string {
  switch (g) {
    case "answer":
      return "one of your saved answers";
    case "fact":
      return "your business facts";
    case "order":
      return "the customer's own order";
    case "balance":
      return "their open invoices";
    case "verify":
      return "a request to confirm who they are";
    default:
      return "a short courtesy reply";
  }
}

export function describeOrder(o: Order, today: string): string {
  const when = o.status === "delivered" || o.status === "cancelled" ? "" : o.expectedOn ? (o.expectedOn < today ? ` It was expected on ${dateLabel(o.expectedOn)}; we are checking on it.` : ` It should reach you by ${dateLabel(o.expectedOn)}.`) : "";
  return `Order ${o.number}${o.items ? ` (${o.items.slice(0, 80)})` : ""} is ${STATUS_WORDS[o.status]}.${when}${o.tracking && o.status === "dispatched" ? ` Track it here: ${o.tracking}` : ""}`;
}

/** The whole conversation turn, for hosts: the rules, then the model if they are not sure, then the agent's decision. */
export async function converse(cs: CustomerService, m: Inbound, model?: (prompt: { system: string; user: string }) => Promise<unknown>): Promise<ReceiveResult> {
  const prep = cs.prepare(m);
  let c = prep.rules;
  if (prep.prompt && model) {
    try {
      c = cs.classify(await model(prep.prompt), prep.rules, prep.candidates);
    } catch {
      c = prep.rules;
    }
  }
  return cs.receive(m, c);
}
