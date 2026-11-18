import { type AssistantDoc, type AssistantMail, type AssistantView, assistantAddress, type CalEvent, type Decision, type StagedChange, type Task } from "@office/contracts";
import { addDays } from "../dates";
import { inr } from "../money";
import type { OfficeService } from "../office";
import { openInvoices } from "../ageing";
import { agendaText, buildAgenda, partyForEvent } from "./agenda";
import { type AssistantStore, ownerKey } from "./store";
import { parseDone, parseReminder } from "./tasks";

const KEEP_MAIL = 50;
const KEEP_DECIDED = 30;
const AGENT = "executive-assistant";
/** Now, written in India time as the rest of the office's records are. */
const istNow = () => `${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 19)}+05:30`;
const newId = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A reply drafted for the owner, before it becomes a card on their own desk. */
export type DraftText = { subject: string; body: string; promise?: string | null };

/** Gmail's "please confirm forwarding" email, recognised so the code can be shown in the Assistant's room. */
export function gmailConfirmation(from: string, subject: string, text: string): { code: string | null; link: string | null } | null {
  if (!/forwarding-noreply@google\.com/i.test(from) && !/gmail forwarding confirmation/i.test(subject)) return null;
  const code = /confirmation code:\s*(\d{6,12})/i.exec(text)?.[1] ?? /\((?:#)?(\d{6,12})\)/.exec(subject)?.[1] ?? null;
  const link = /(https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>"]+)/i.exec(text)?.[1] ?? null;
  return { code, link };
}

/**
 * Figures in a draft that the books cannot back up: an amount that is not an invoice, a balance
 * or a bill, or an invoice number the books do not have. A draft that names one is flagged.
 */
export function figureCheck(office: OfficeService, text: string, partyId: string | null): string[] {
  const issues: string[] = [];
  const l = office.ledger;
  const known = new Set<number>();
  const open = openInvoices(l);
  for (const inv of l.receivableInvoices) known.add(inv.totals.totalPaise);
  for (const o of open) known.add(o.outstandingPaise);
  for (const b of l.payableBills) known.add(b.totals.totalPaise);
  for (const q of office.books.quotes) known.add(q.totals.totalPaise);
  if (partyId) known.add(open.filter((o) => o.partyId === partyId).reduce((s, o) => s + o.outstandingPaise, 0));
  const near = (paise: number) => [...known].some((k) => Math.abs(k - paise) <= 100);
  for (const m of text.matchAll(/(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)\s*(lakh|crore|k)?/gi)) {
    let rupees = Number(m[1]!.replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "lakh") rupees *= 1_00_000;
    else if (unit === "crore") rupees *= 1_00_00_000;
    else if (unit === "k") rupees *= 1000;
    const paise = Math.round(rupees * 100);
    // Rounded amounts ("₹1.2 lakh") are allowed a little more room.
    const ok = unit ? [...known].some((k) => Math.abs(k - paise) <= paise * 0.05) : near(paise);
    if (!ok) issues.push(`${m[0].trim()} is not an invoice, bill or balance in the books.`);
  }
  const numbers = new Set([...office.books.invoices.map((i) => i.number.toLowerCase()), ...office.books.bills.map((b) => b.number.toLowerCase()), ...office.books.quotes.map((q) => q.number.toLowerCase())]);
  for (const m of text.matchAll(/\b(?:invoice|bill|inv|quotation|quote)\s*(?:no\.?|number|#)?\s*([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)/gi)) {
    if (!numbers.has(m[1]!.toLowerCase())) issues.push(`${m[1]} is not an invoice, bill or quotation number in the books.`);
  }
  return [...new Set(issues)];
}

/** The reply when no model is at hand: polite, says when, and promises nothing the books do not hold. */
export function replyTemplate(office: OfficeService, mail: Pick<AssistantMail, "from" | "fromName" | "subject" | "text">, ownerName: string): DraftText {
  const party = partyForEvent(office, { title: mail.subject, attendees: [{ email: mail.from.toLowerCase(), name: mail.fromName }] });
  const name = (mail.fromName ?? party?.contact.name ?? "").split(/\s+/)[0] || "there";
  const by = new Date(`${addDays(office.asOf, 2)}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const lines = [`Dear ${name},`, "", `Thank you for your email${mail.subject ? ` about "${mail.subject.replace(/^(re|fwd?):\s*/gi, "")}"` : ""}.`];
  if (party?.kind === "customer") {
    const owed = openInvoices(office.ledger).filter((o) => o.partyId === party.id);
    const total = owed.reduce((s, o) => s + o.outstandingPaise, 0);
    if (/payment|outstanding|balance|statement|due/i.test(mail.text) && total > 0) lines.push("", `For your records, our books show ₹${inr(total)} open on ${owed.length === 1 ? `invoice ${owed[0]!.number}` : `${owed.length} invoices: ${owed.map((o) => o.number).join(", ")}`}.`);
  }
  lines.push("", `I will come back to you on this by ${by}.`, "", "Regards,", ownerName, office.books.business.name);
  return { subject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject || "your email"}`, body: lines.join("\n"), promise: `Reply to ${mail.fromName ?? mail.from} about ${mail.subject || "their email"}` };
}

/** The Executive Assistant: one private record per owner, kept apart from the books. */
export class AssistantService {
  constructor(
    private office: OfficeService,
    readonly store: AssistantStore,
  ) {}

  get hired() {
    return this.office.hired(AGENT);
  }

  private load(owner: string): AssistantDoc {
    return this.store.load(ownerKey(owner));
  }
  private save(owner: string, doc: AssistantDoc) {
    doc.mail = doc.mail.slice(0, KEEP_MAIL);
    const pending = doc.drafts.filter((d) => d.status === "pending");
    const decided = doc.drafts.filter((d) => d.status !== "pending").slice(0, KEEP_DECIDED);
    doc.drafts = [...pending, ...decided];
    this.store.save(ownerKey(owner), doc);
  }

  drafts(owner: string): StagedChange[] {
    if (!this.hired) return [];
    return this.load(owner).drafts.filter((d) => d.status === "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  decidedDrafts(owner: string): StagedChange[] {
    return this.load(owner).drafts.filter((d) => d.status !== "pending");
  }

  view(owner: string, sample: boolean, now = Date.now()): AssistantView {
    const doc = this.load(owner);
    const fwd = this.store.meta("forwarding");
    return {
      hired: this.hired,
      owner: ownerKey(owner),
      address: assistantAddress(this.office.settings().ingestEmail),
      calendar: { connected: Boolean(doc.calendar), label: doc.calendar?.label ?? null, fetchedAt: doc.calendar?.fetchedAt ?? null, error: doc.calendar?.error ?? null, events: doc.calendar?.events.length ?? 0 },
      forwarding: fwd ? (JSON.parse(fwd) as AssistantView["forwarding"]) : null,
      days: this.hired ? buildAgenda(this.office, doc, ownerKey(owner), { drafts: this.drafts(owner).length, now }) : [],
      tasks: doc.tasks.sort((a, b) => (a.status !== b.status ? (a.status === "open" ? -1 : 1) : (a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1)),
      mail: doc.mail,
      sample,
    };
  }

  /** Keeps the events from the owner's calendar; an error keeps the last good events. */
  setCalendar(owner: string, r: { events: CalEvent[]; label: string | null } | { error: string }) {
    const doc = this.load(owner);
    const at = new Date().toISOString();
    if ("error" in r) doc.calendar = { label: doc.calendar?.label ?? null, events: doc.calendar?.events ?? [], fetchedAt: doc.calendar?.fetchedAt ?? null, error: r.error };
    else doc.calendar = { label: r.label, events: r.events, fetchedAt: at, error: null };
    this.save(owner, doc);
  }
  clearCalendar(owner: string) {
    const doc = this.load(owner);
    doc.calendar = null;
    this.save(owner, doc);
  }

  addTask(owner: string, input: { title: string; due?: string | null }, source: Task["source"] = "you"): Task {
    const doc = this.load(owner);
    const task: Task = { id: newId("task"), title: input.title.trim().slice(0, 200), due: input.due ?? null, status: "open", source, createdAt: new Date().toISOString(), doneAt: null, snoozedUntil: null };
    doc.tasks.unshift(task);
    doc.tasks = doc.tasks.filter((t) => t.status === "open" || (t.doneAt && Date.now() - Date.parse(t.doneAt) < 14 * 86_400_000)).slice(0, 200);
    this.save(owner, doc);
    return task;
  }
  changeTask(owner: string, id: string, change: { status?: Task["status"]; due?: string | null; snoozedUntil?: string | null }): Task | null {
    const doc = this.load(owner);
    const t = doc.tasks.find((x) => x.id === id);
    if (!t) return null;
    if (change.status) {
      t.status = change.status;
      t.doneAt = change.status === "done" ? new Date().toISOString() : null;
    }
    if (change.due !== undefined) t.due = change.due;
    if (change.snoozedUntil !== undefined) t.snoozedUntil = change.snoozedUntil;
    this.save(owner, doc);
    return t;
  }

  /** "remind me ..." or "done ..." from WhatsApp; null when the message is neither. */
  fromMessage(owner: string, text: string): string | null {
    if (!this.hired) return null;
    const r = parseReminder(text, this.office.asOf);
    if (r) {
      this.addTask(owner, r, "whatsapp");
      const when = r.due ? new Date(`${r.due}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }) : null;
      return `Noted: ${r.title}${when ? `, for ${when}` : ""}. It will be in your morning brief. Send "done ${r.title.split(" ").slice(0, 2).join(" ").toLowerCase()}" when it is done.`;
    }
    const d = parseDone(text);
    if (d) {
      const doc = this.load(owner);
      const words = d.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const open = doc.tasks.filter((t) => t.status === "open");
      const hit = open.find((t) => t.title.toLowerCase() === d.toLowerCase()) ?? open.find((t) => words.length > 0 && words.every((w) => t.title.toLowerCase().includes(w)));
      if (!hit) return null;
      this.changeTask(owner, hit.id, { status: "done" });
      return `Marked done: ${hit.title}.`;
    }
    return null;
  }

  /** Gmail's confirmation, kept for the room to show until the owner has used it. */
  noteForwarding(conf: { code: string | null; link: string | null }) {
    this.store.setMeta("forwarding", JSON.stringify({ ...conf, at: new Date().toISOString() }));
  }

  /**
   * An email the owner forwarded. A reply is drafted for their own desk, checked against the books;
   * a bill or invoice is left to the Accountant by the host, which says so with `outcome`.
   */
  receiveMail(owner: string, mail: Omit<AssistantMail, "id" | "outcome" | "note" | "at"> & { at?: string }, draft: DraftText | null, outcome: AssistantMail["outcome"] = "drafted"): { mail: AssistantMail; draft: StagedChange | null } {
    const doc = this.load(owner);
    const rec: AssistantMail = { ...mail, id: newId("mail"), at: mail.at ?? istNow(), outcome, note: "" };
    let card: StagedChange | null = null;
    if (draft && rec.replyTo) {
      const party = partyForEvent(this.office, { title: rec.subject, attendees: [{ email: rec.replyTo.toLowerCase(), name: rec.fromName }] });
      const issues = figureCheck(this.office, draft.body, party?.id ?? null);
      card = {
        id: `ea-${rec.id}`,
        agentId: AGENT,
        kind: "email_reply",
        createdAt: rec.at,
        title: `Reply to ${rec.fromName ?? rec.replyTo}: ${rec.subject || "(no subject)"}`.slice(0, 160),
        summary: issues.length ? `Check before sending: ${issues.join(" ")}` : `A reply to the email you forwarded${party ? `, from ${party.name}` : ""}. It goes from the office in your name, with replies coming to you.`,
        evidence: [{ label: "The email you forwarded", ref: { kind: "email", id: rec.id } }, ...(party ? [{ label: party.name, ref: { kind: "party" as const, id: party.id } }] : [])],
        payload: { to: rec.replyTo, subject: draft.subject, body: draft.body, inReplyTo: rec.messageId, mailId: rec.id, quoted: rec.text.slice(0, 1500), promise: draft.promise ?? null, checks: issues.map((label) => ({ label, ok: false })) },
        status: "pending",
      };
      doc.drafts.unshift(card);
      rec.note = issues.length ? "Reply drafted; it names a figure the books do not hold." : "Reply drafted for your desk.";
    } else if (outcome === "to_accountant") rec.note = "Passed to the Accountant to read.";
    else rec.note = rec.replyTo ? "Kept for your agenda." : "Kept; no address to reply to.";
    doc.mail.unshift(rec);
    this.save(owner, doc);
    this.office.log(AGENT, card ? "Drafted a reply for you to check." : "Read an email you forwarded.");
    return { mail: rec, draft: card };
  }

  /** The owner's decision on one of their drafts. A sent reply that promised something becomes a follow-up. */
  decide(owner: string, id: string, decision: Decision, by: string): StagedChange | null {
    const doc = this.load(owner);
    const i = doc.drafts.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const item = doc.drafts[i]!;
    if (item.status !== "pending") return item;
    const decided: StagedChange = {
      ...item,
      status: decision.action === "approve" ? "approved" : "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: by,
      note: decision.note,
      payload: { ...item.payload, ...(decision.edits ?? {}) },
    };
    doc.drafts[i] = decided;
    this.save(owner, doc);
    const state = this.office.state(AGENT);
    state.accuracy.checked += 1;
    if (decision.action === "approve" && !decision.edits) state.accuracy.correct += 1;
    const promise = (decided.payload as { promise?: string | null }).promise;
    if (decision.action === "approve" && promise) this.addTask(owner, { title: `Follow up: ${promise}`, due: addDays(this.office.asOf, 2) }, "draft");
    this.office.log(AGENT, decision.action === "approve" ? "Sent a reply you approved." : "Put aside a reply you turned down.");
    return decided;
  }

  /** What happened when an approved reply was sent: when it went, or why it did not. */
  markSent(owner: string, id: string, patch: { sentAt?: string; sendError?: string }) {
    const doc = this.load(owner);
    const d = doc.drafts.find((x) => x.id === id);
    if (!d) return;
    d.payload = { ...d.payload, ...patch };
    if (patch.sentAt) delete (d.payload as { sendError?: string }).sendError;
    this.save(owner, doc);
  }

  /** The owner's part of the morning brief, or null when they have nothing to plan with. */
  briefing(owner: string, short = false): string | null {
    if (!this.hired) return null;
    const doc = this.load(owner);
    if (!doc.calendar && !doc.tasks.some((t) => t.status === "open") && !doc.drafts.some((d) => d.status === "pending")) return null;
    const days = buildAgenda(this.office, doc, ownerKey(owner), { drafts: this.drafts(owner).length });
    const head = doc.calendar?.error ? `Your calendar could not be read (${doc.calendar.error}); this is from what was read last.\n\n` : "";
    return head + agendaText(days, short);
  }

  /** The morning round's look: each owner's calendar read again is the host's job; this counts what was planned. */
  morning(owners: string[]): { owners: number; meetings: number; tasks: number } {
    let meetings = 0;
    let tasks = 0;
    let planned = 0;
    for (const o of owners) {
      const doc = this.load(o);
      if (!doc.calendar && !doc.tasks.length) continue;
      planned++;
      const today = buildAgenda(this.office, doc, ownerKey(o), { drafts: 0 })[0]!;
      meetings += today.items.filter((i) => i.kind === "event").length;
      tasks += today.items.filter((i) => i.kind === "task").length;
    }
    if (planned) this.office.log(AGENT, `Prepared the next three days for ${planned === 1 ? "you" : `${planned} owners`}.`);
    return { owners: planned, meetings, tasks };
  }

  /** The demo's calendar: a week of the kind of meetings an owner of this business has, around the books' date. */
  sampleCalendar(owner: string): CalEvent[] {
    const b = this.office.books;
    const customers = b.parties.filter((p) => p.kind === "customer");
    const vendor = b.parties.find((p) => p.kind === "vendor");
    const owed = openInvoices(this.office.ledger).sort((x, y) => y.outstandingPaise - x.outstandingPaise);
    const big = customers.find((c) => c.id === owed[0]?.partyId) ?? customers[0];
    const other = customers.find((c) => c !== big) ?? customers[1];
    const ev = (day: number, from: string, to: string, title: string, who: { email: string; name: string | null }[] = [], location: string | null = null): CalEvent => {
      const date = addDays(this.office.asOf, day);
      return { id: `sample-${day}-${from}`, title, start: new Date(`${date}T${from}:00+05:30`).toISOString(), end: new Date(`${date}T${to}:00+05:30`).toISOString(), allDay: false, location, attendees: [{ email: ownerKey(owner), name: null }, ...who] };
    };
    const with_ = (p: typeof big) => (p ? [{ email: p.contact.email.toLowerCase(), name: p.contact.name }] : []);
    return [
      ev(0, "10:00", "10:30", "Daily stand-up with the shop floor"),
      ev(0, "12:00", "13:00", big ? `Meeting with ${big.name}` : "Customer meeting", with_(big), big?.city ?? null),
      ev(0, "16:00", "16:45", "Call with the bank about the overdraft limit"),
      ev(1, "11:00", "12:00", vendor ? `Price review with ${vendor.name}` : "Supplier price review", with_(vendor)),
      ev(1, "15:30", "16:00", `Review the month with ${b.business.accountantFirm || "your CA"}`),
      ev(2, "10:00", "10:30", "Daily stand-up with the shop floor"),
      ev(2, "14:00", "15:00", other ? `Site visit: ${other.name}` : "Site visit", with_(other), other?.city ?? null),
    ];
  }
}

/**
 * The email inside a forward: who first sent it, its subject and its words, and the owner's own note
 * above it. Gmail, Outlook and Apple Mail each mark a forward their own way; null when there is none.
 */
export function readForward(text: string): { from: string; name: string | null; subject: string; body: string; note: string } | null {
  const t = text.replace(/\r\n/g, "\n");
  const mark = /^[ \t>]*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Original Message\s*-{2,}|_{10,})\s*$/im.exec(t);
  const fromLine = /^[ \t>]*From:\s*(.+)$/im;
  const start = mark ? mark.index : (fromLine.exec(t)?.index ?? -1);
  if (start < 0) return null;
  const note = t.slice(0, start).trim();
  const rest = t.slice(mark ? start + mark[0].length : start).replace(/^\n+/, "");
  const lines = rest.split("\n");
  const head: Record<string, string> = {};
  let i = 0;
  for (; i < Math.min(lines.length, 14); i++) {
    const l = lines[i]!.replace(/^[ \t>]*/, "");
    if (!l.trim()) {
      if (Object.keys(head).length) break;
      continue;
    }
    const m = /^(From|Date|Sent|Subject|To|Cc):\s*(.*)$/i.exec(l);
    if (!m) break;
    head[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  const who = head.from ?? "";
  const email = /<([^>\s]+@[^>\s]+)>/.exec(who)?.[1] ?? /([^\s<>"]+@[^\s<>"]+)/.exec(who)?.[1];
  if (!email) return null;
  const name = who.replace(/<[^>]*>/, "").replace(/["*]/g, "").trim() || null;
  const body = lines.slice(i).map((l) => l.replace(/^> ?/, "")).join("\n").trim();
  return { from: email.toLowerCase(), name: name && name.toLowerCase() !== email.toLowerCase() ? name : null, subject: head.subject ?? "", body: body.slice(0, 6000), note };
}

/** The demo's assistant: hired, with a sample week, two tasks and one forwarded email drafted for the desk. */
export function seedSampleAssistant(office: OfficeService, owner: { name: string; email: string }) {
  const state = office.state(AGENT);
  Object.assign(state, { hired: true, trustLevel: "trainee", hiredOn: office.asOf });
  const ea = office.assistant;
  ea.setCalendar(owner.email, { events: ea.sampleCalendar(owner.email), label: "Sample calendar" });
  ea.addTask(owner.email, { title: "Renew the shop's fire licence", due: addDays(office.asOf, 1) }, "whatsapp");
  ea.addTask(owner.email, { title: "Call the transporter about Monday's delivery", due: office.asOf }, "you");
  const customer = openInvoices(office.ledger).sort((a, b) => b.daysOverdue - a.daysOverdue)[0];
  const party = customer ? office.ledger.findParty(customer.partyId) : office.books.parties.find((p) => p.kind === "customer");
  if (!party) return;
  const mail = { from: party.contact.email, fromName: party.contact.name, replyTo: party.contact.email, subject: "Statement of account", text: `Dear Sir,\n\nPlease share our statement of account and confirm what is outstanding. We are closing our books for the month.\n\nRegards,\n${party.contact.name}\n${party.name}`, messageId: null };
  ea.receiveMail(owner.email, mail, replyTemplate(office, mail, owner.name));
}
