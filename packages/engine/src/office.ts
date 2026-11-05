import type {
  AgentRoomView,
  AskResponse,
  Bill,
  Books,
  Decision,
  DeskView,
  Document,
  DocumentView,
  IngestResult,
  Invoice,
  Kpi,
  LogEntry,
  OfficeView,
  PartyView,
  BrandVoice,
  Channel,
  ContentCalendar,
  MediaAsset,
  Post,
  PostMetrics,
  PostVariant,
  RoomStatus,
  Settings,
  SocialMessage,
  StagedChange,
  TrustLevel,
} from "@office/contracts";
import { AGENT_BY_ID, AGENTS, PLATFORM_NAMES, PROMOTION_RULES } from "@office/contracts";
import { textHash } from "./social/channels";
import { checkPost } from "./social/checks";
import { isThankYou, leadFrom, newMessage } from "./social/inbox";
import { draftCalendar, planMonth } from "./social/planner";
import { ageingReport, DEFAULT_POLICY, draftReminders, openInvoices } from "./ageing";
import { auditAll, auditFlags, auditReport } from "./audit";
import { importReturn } from "./imports";
import { addDays, dateLabel, monthKey, monthLabel } from "./dates";
import { Ledger } from "./ledger";
import { inr, inrShort } from "./money";
import { extractInvoice, type Extraction, type TextItem } from "./extract";
import { gstReport, salesReport, tdsReport } from "./reports";
import { expectedTdsByBill } from "./tds";
import { marketingReport, operationsReport, peopleReport, salesTeamReport, socialReport } from "./teams";

/** Always the owner's call, whatever the agent's trust level: spending, payroll, what goes to the accountant, and the month's plan. */
const ALWAYS_ASK = new Set(["audit_flag", "share_file", "payroll_run", "campaign", "calendar", "broadcast"]);
export const TRUSTED_LIMIT_PAISE = 1_00_000_00;
/** Meta's marketing-message rate for India, roughly; the card says to check the current rate. */
export const WHATSAPP_MARKETING_PAISE = 78;

/** Work for the host after a change: the Worker calls the platforms, the mock pretends to. */
export type SocialEffect =
  | { kind: "publish"; postId: string; channelId: string }
  | { kind: "reply"; messageId: string; channelId: string; text: string }
  | { kind: "broadcast"; postId: string; channelId: string; audience: number };

export type IncomingMessage = Pick<SocialMessage, "id" | "platform" | "channelId" | "kind" | "author" | "at" | "rating" | "text"> & Partial<Pick<SocialMessage, "postId" | "threadId" | "externalId">>;

/** Wall-clock time in India on the books' date, as the log and staged items record it. */
function istNow(asOf: string): string {
  return `${asOf}T${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 19)}+05:30`;
}

export type OfficeOptions = { asOf?: string; ingestEmail?: string };

export class OfficeService {
  readonly books: Books;
  ledger: Ledger;
  private settingsState: Settings;

  constructor(books: Books, opts: OfficeOptions = {}) {
    this.books = books;
    this.ledger = new Ledger(books, opts.asOf);
    this.settingsState = {
      business: books.business,
      users: [
        { name: books.business.owner, email: "anil@kaverielectricals.in", role: "owner" },
        { name: "Rajesh Mehta", email: "rajesh@mehtaassociates.in", role: "accountant" },
      ],
      ingestEmail: opts.ingestEmail ?? `${books.business.id}@in.the-office.app`,
      digestTime: "08:45",
      reminderPolicy: { firstAfterDays: DEFAULT_POLICY.firstAfterDays, firmAfterDays: DEFAULT_POLICY.firmAfterDays, finalAfterDays: DEFAULT_POLICY.finalAfterDays, sendFrom: books.business.email },
    };
  }

  get asOf() {
    return this.ledger.asOf;
  }

  private state(agentId: string) {
    return this.books.agents.find((a) => a.agentId === agentId)!;
  }

  hired(agentId: string) {
    return this.state(agentId)?.hired ?? false;
  }

  /** Stored proposals plus the ones computed from the books right now. */
  allStaged(): StagedChange[] {
    const stored = new Map(this.books.staged.map((s) => [s.id, s]));
    const computed = [...(this.hired("credit-controller") ? draftReminders(this.ledger, { ...DEFAULT_POLICY, ...this.settingsState.reminderPolicy }) : []), ...(this.hired("auditor") ? auditFlags(this.ledger) : [])];
    for (const c of computed) if (!stored.has(c.id)) stored.set(c.id, c);
    return [...stored.values()].filter((s) => this.hired(s.agentId) || s.status !== "pending");
  }

  pending(): StagedChange[] {
    return this.allStaged()
      .filter((s) => s.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  today(): LogEntry[] {
    return this.books.teamLog.filter((e) => e.at.slice(0, 10) === this.asOf).sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  room(agentId: string): RoomStatus {
    const s = this.state(agentId);
    const def = AGENT_BY_ID[agentId]!;
    if (!s?.hired) return { agentId, hired: false, trustLevel: s?.trustLevel ?? "trainee", status: "not_hired", now: def.job.split(".")[0]!, todayCount: 0, waitingCount: 0 };
    const log = this.today().filter((e) => e.agentId === agentId);
    const waiting = this.pending().filter((p) => p.agentId === agentId).length;
    const reading = agentId === "accountant" && this.books.documents.some((d) => d.status === "reading");
    const latestAt = this.today()[0]?.at ?? `${this.asOf}T18:00:00`;
    const recent = log[0] && Date.parse(latestAt) - Date.parse(log[0].at) < 75 * 60_000;
    const status: RoomStatus["status"] = reading || recent ? "working" : waiting ? "waiting" : "idle";
    return {
      agentId,
      hired: true,
      trustLevel: s.trustLevel,
      status,
      now: reading ? "Reading a bill that just arrived by email" : (log[0]?.text ?? "Nothing new today"),
      todayCount: this.todayCount(agentId, log.length),
      waitingCount: waiting,
    };
  }

  private todayCount(agentId: string, fallback: number): number {
    if (agentId === "accountant") return this.books.documents.filter((d) => d.receivedAt.slice(0, 10) === this.asOf || d.status === "staged").length + this.ledger.salesInvoices.filter((i) => i.date === this.asOf).length;
    if (agentId === "credit-controller") return draftReminders(this.ledger).length;
    if (agentId === "auditor") return auditAll(this.ledger).findings.length;
    if (agentId === "social-media-manager") return this.books.socialInbox.filter((m) => m.status === "open").length + this.books.posts.filter((p) => p.variants.some((v) => v.publishedAt?.slice(0, 10) === this.asOf)).length;
    if (agentId === "storekeeper") return this.books.stock.length;
    return fallback;
  }

  officeView(): OfficeView {
    const b = this.books.business;
    return {
      business: { name: b.name, legalName: b.legalName, gstin: b.gstin, asOf: this.asOf, owner: b.owner, accountantFirm: b.accountantFirm },
      rooms: AGENTS.map((a) => this.room(a.id)),
      log: this.today().filter((e) => this.hired(e.agentId) || e.agentId === "you"),
      deskCount: this.pending().length,
      arriving: [
        ...this.books.documents.filter((d) => d.status === "reading").map((d) => ({ docId: d.id, agentId: "accountant", label: d.from ? `Email from ${d.from}` : "Upload" })),
        ...(this.hired("social-media-manager")
          ? this.books.socialInbox
              .filter((m) => m.status === "open" && Date.now() - Date.parse(m.at) < 3_600_000)
              .map((m) => ({ docId: m.id, agentId: "social-media-manager", label: `${m.kind === "review" ? "Review" : m.kind === "dm" ? "Message" : "Comment"} from ${m.author}` }))
          : []),
      ],
    };
  }

  kpis(agentId: string): Kpi[] {
    const l = this.ledger;
    const lastMonth = gstReport(l).period;
    switch (agentId) {
      case "office-manager": {
        const p = this.pending();
        return [
          { label: "Waiting on your desk", value: String(p.length) },
          { label: "Agents at work", value: String(this.books.agents.filter((a) => a.hired).length) },
          { label: "Digest sent", value: `Today, ${this.settingsState.digestTime}` },
        ];
      }
      case "accountant": {
        const month = monthKey(this.asOf);
        const read = this.books.documents.filter((d) => d.receivedAt.slice(0, 7) === month).length;
        const staged = this.books.bills.filter((x) => x.status === "staged");
        return [
          { label: `Documents read in ${monthLabel(month, "long").split(" ")[0]}`, value: String(read) },
          { label: "Bills waiting to be posted", value: String(staged.length) },
          { label: "Value waiting", value: inrShort(staged.reduce((a, x) => a + x.totals.totalPaise, 0)) },
        ];
      }
      case "credit-controller": {
        const a = ageingReport(l);
        return [
          { label: "Overdue", value: inrShort(a.totalPaise - a.bucketTotals[0]!), figureId: "ageing:overdue", tone: "red" },
          { label: "Over 60 days", value: inrShort(a.bucketTotals[3]! + a.bucketTotals[4]!), figureId: "ageing:over60", tone: "red" },
          { label: "Customers late", value: String(a.rows.filter((r) => r.buckets.slice(1).some((x) => x > 0)).length) },
        ];
      }
      case "tax-clerk": {
        const g = gstReport(l);
        const t = tdsReport(l);
        return [
          { label: `GST payable for ${monthLabel(lastMonth, "long").split(" ")[0]}`, value: inrShort(g.payable.totalPaise), figureId: `gst:payable:${lastMonth}` },
          { label: "TDS this quarter", value: inrShort(t.deductions.reduce((x, d) => x + d.expectedPaise, 0)), figureId: `tds:total:${t.quarter}` },
          { label: "Next return", value: `GSTR-1 by ${dateLabel(g.filings[0]!.dueOn)}` },
        ];
      }
      case "auditor": {
        const f = auditAll(l).findings;
        return [
          { label: "Open differences", value: String(f.length), tone: f.length ? "red" : "green" },
          { label: "Tax at stake", value: inrShort(f.reduce((x, y) => x + y.impactPaise, 0)), tone: "red" },
          { label: "Returns checked", value: String(this.books.filedReturns.length) },
        ];
      }
      case "sales-rep":
      case "quote-desk":
      case "account-manager": {
        const s = salesTeamReport(l);
        if (agentId === "account-manager")
          return [
            { label: "Customers late to reorder", value: String(s.reorders.filter((r) => r.status === "late").length) },
            { label: "Due this week", value: String(s.reorders.filter((r) => r.status === "due").length) },
          ];
        if (agentId === "quote-desk")
          return [
            { label: "Quotations out", value: String(s.quotes.filter((q) => q.status === "sent").length) },
            { label: "Accepted value", value: inrShort(s.quotes.filter((q) => q.status === "accepted").reduce((a, q) => a + q.totals.totalPaise, 0)), tone: "green" },
            { label: "Drafts", value: String(s.quotes.filter((q) => q.status === "draft").length) },
          ];
        const open = s.leads.filter((x) => !["won", "lost"].includes(x.stage));
        return [
          { label: "Open leads", value: String(open.length) },
          { label: "Pipeline value", value: inrShort(open.reduce((a, x) => a + x.valuePaise, 0)), figureId: "pipeline:open" },
          { label: "New this week", value: String(s.leads.filter((x) => x.stage === "new").length) },
        ];
      }
      case "marketer":
      case "market-watcher": {
        const m = marketingReport(l);
        if (agentId === "market-watcher") return [{ label: "SKUs watched", value: String(m.prices.length) }, { label: "Priced over 5% above market", value: String(m.prices.filter((p) => p.gapPct > 5).length), tone: "red" }];
        return [
          { label: "Campaigns running", value: String(m.campaigns.filter((c) => c.status === "running").length) },
          { label: "Slow stock at cost", value: inrShort(m.slowMovers.reduce((a, x) => a + x.stockValuePaise, 0)), figureId: "marketing:slow", tone: "red" },
          { label: "Sales per rupee spent, Diwali scheme", value: `${m.campaigns.find((c) => c.id === "camp-01")?.returnMultiple ?? "-"}x` },
        ];
      }
      case "social-media-manager": {
        const s = socialReport(l);
        return [
          { label: "Waiting for a reply", value: String(s.inbox.filter((m) => m.status === "open").length) },
          { label: "Rating", value: `${s.ratings.average} of 5` },
          { label: "Scheduled posts", value: String(s.posts.filter((p) => p.status === "scheduled").length) },
          { label: "Invoiced from social leads", value: inrShort(s.performance.funnel.invoicedPaise), figureId: "social:invoiced", tone: "green" },
        ];
      }
      case "storekeeper":
      case "buyer":
      case "compliance-officer": {
        const o = operationsReport(l);
        if (agentId === "buyer") return [{ label: "Open requests for quotes", value: String(o.rfqs.length) }];
        if (agentId === "compliance-officer") {
          const next = o.compliance.filter((c) => c.status === "upcoming");
          return [
            { label: "Next filing", value: next[0] ? `${next[0].form}, ${next[0].daysLeft} days` : "None" },
            { label: "Due in 30 days", value: String(next.filter((c) => c.daysLeft <= 30).length) },
          ];
        }
        return [
          { label: "SKUs to reorder", value: String(o.stock.filter((s) => s.status === "reorder").length), tone: "red" },
          { label: "Excess stock at cost", value: inrShort(o.stock.filter((s) => s.status === "excess").reduce((a, s) => a + s.stockValuePaise, 0)), figureId: "operations:excess" },
          { label: "Purchase orders open", value: String(o.purchaseOrders.filter((p) => p.status !== "received").length) },
        ];
      }
      case "payroll-clerk": {
        const p = peopleReport(l);
        return [
          { label: `Net pay for ${monthLabel(p.period, "long").split(" ")[0]}`, value: inrShort(p.totals.netPaise), figureId: `payroll:net:${p.period}` },
          { label: "People", value: String(p.lines.length) },
        ];
      }
    }
    return [];
  }

  agentRoom(agentId: string): AgentRoomView {
    const state = this.state(agentId);
    const accuracyPct = state.accuracy.checked ? Math.round((state.accuracy.correct / state.accuracy.checked) * 1000) / 10 : null;
    let promotion: AgentRoomView["promotion"] = null;
    const rate = state.accuracy.checked ? state.accuracy.correct / state.accuracy.checked : 0;
    if (state.hired && state.trustLevel === "trainee" && state.accuracy.checked >= PROMOTION_RULES.trusted.minChecked && rate >= PROMOTION_RULES.trusted.minAccuracy)
      promotion = { to: "trusted", reason: `${state.accuracy.correct} of ${state.accuracy.checked} pieces of work approved without changes (${accuracyPct}%).` };
    if (state.hired && state.trustLevel === "trusted" && state.accuracy.checked >= PROMOTION_RULES.autonomous.minChecked && rate >= PROMOTION_RULES.autonomous.minAccuracy)
      promotion = { to: "autonomous", reason: `${state.accuracy.correct} of ${state.accuracy.checked} approved without changes (${accuracyPct}%).` };
    return {
      agentId,
      state,
      status: this.room(agentId),
      kpis: state.hired ? this.kpis(agentId) : [],
      log: this.books.teamLog.filter((e) => e.agentId === agentId).sort((a, b) => (a.at < b.at ? 1 : -1)),
      pending: this.pending().filter((p) => p.agentId === agentId),
      accuracyPct,
      promotion,
    };
  }

  desk(): DeskView {
    const all = this.allStaged();
    return {
      items: all.filter((s) => s.status === "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      decided: all.filter((s) => s.status !== "pending").sort((a, b) => ((a.decidedAt ?? "") < (b.decidedAt ?? "") ? 1 : -1)),
    };
  }

  log(agentId: string, text: string, ref: LogEntry["ref"] = null, at?: string) {
    this.books.teamLog.push({ id: `log-${this.books.teamLog.length + 1}-${Date.now() % 100000}`, at: at ?? istNow(this.asOf), agentId, text, ref });
  }

  /** A document has arrived and is waiting to be read. */
  receiveDocument(input: { id: string; file: string; channel: Document["channel"]; from: string | null; pages: number; receivedAt?: string }): Document {
    const existing = this.books.documents.find((d) => d.id === input.id);
    if (existing) return existing;
    const doc: Document = { id: input.id, kind: "purchase_bill", refId: null, file: input.file, pages: input.pages, receivedAt: input.receivedAt ?? istNow(this.asOf), channel: input.channel, from: input.from, status: "reading", regions: [] };
    this.books.documents.push(doc);
    this.log("accountant", input.channel === "email" ? `Received a document by email from ${input.from ?? "an unknown sender"}.` : "Received an uploaded document.", { kind: "document", id: doc.id });
    return doc;
  }

  /** Documents received but not yet read; emailed PDFs wait for a browser to read their text layer. */
  unread(): Document[] {
    return this.books.documents.filter((d) => d.status === "reading");
  }

  /**
   * Turns what the Accountant read into a staged bill or invoice and an approval
   * card. Nothing reaches the books until the card is approved; a duplicate is
   * set aside without asking.
   */
  stageExtraction(docId: string, e: Extraction): StagedChange {
    const doc = this.books.documents.find((d) => d.id === docId);
    if (!doc) throw new Error(`No document ${docId}`);
    const prior = this.books.staged.find((s) => s.kind === "ledger_entry" && (s.payload as { docId?: string }).docId === docId);
    if (prior) return prior;
    const failed = e.checks.filter((c) => !c.ok);
    const dup = failed.find((c) => c.key === "duplicate");
    doc.kind = e.kind;
    doc.regions = e.regions;

    const partyKind = e.kind === "purchase_bill" ? "vendor" : "customer";
    let partyId = e.partyId;
    if (!partyId) {
      partyId = `${partyKind === "vendor" ? "V" : "C"}${String(this.books.parties.filter((p) => p.kind === partyKind).length + 1).padStart(2, "0")}-new`;
      const name = e.partyName ?? "Unnamed party";
      this.books.parties.push({
        id: partyId,
        kind: partyKind,
        name,
        entity: /\b(pvt|ltd|limited)\b/i.test(name) ? "company" : /\b(llp|& co|traders|associates|enterprises)\b/i.test(name) ? "firm" : "individual",
        gstin: e.partyGstin,
        pan: e.partyGstin?.slice(2, 12) ?? "",
        stateCode: e.partyGstin?.slice(0, 2) ?? this.books.business.stateCode,
        city: "",
        contact: { name: "", phone: "", email: doc.from ?? "" },
        ...(partyKind === "customer" ? { paymentTermsDays: 30 } : {}),
      });
      this.ledger.reindex();
    }
    const party = this.ledger.party(partyId);
    const lines = e.lines.map(({ printedTaxPaise: _printed, ...l }) => l);
    const tax = e.totals.cgstPaise + e.totals.sgstPaise + e.totals.igstPaise;
    const number = e.number ?? `Unnumbered ${docId}`;
    const date = e.date ?? this.asOf;
    const items = lines.length === 1 ? "One item" : `${lines.length} items`;
    const payload: Record<string, unknown> = { docId, checks: e.checks, method: e.method };
    let title: string;
    let summary: string;

    if (e.kind === "purchase_bill") {
      const id = `bill-${docId.replace(/^doc-/, "")}`;
      const bill: Bill = { id, number, date, partyId, docId, kind: party.supplyKind ?? "goods", placeOfSupply: e.placeOfSupply ?? this.books.business.stateCode, lines, totals: e.totals, itcEligible: Boolean(e.partyGstin) && tax > 0, tds: null, status: dup ? "rejected" : "staged" };
      this.books.bills.push(bill);
      this.ledger.reindex();
      bill.tds = dup ? null : (expectedTdsByBill(this.ledger).get(id) ?? null);
      doc.refId = id;
      payload.billId = id;
      title = `Post bill ${number} from ${party.name}, ₹${inr(e.totals.totalPaise, { rupees: e.totals.totalPaise % 100 === 0 })}`;
      summary = `${items}; input tax ₹${inr(tax)}${bill.itcEligible ? "" : " (no credit: the supplier is not registered)"}. ${bill.tds ? `TDS under ${bill.tds.section} of ₹${inr(bill.tds.amountPaise)} to be deducted on payment.` : "No TDS applies."}`;
    } else {
      const id = `inv-${docId.replace(/^doc-/, "")}`;
      const terms = party.paymentTermsDays ?? 30;
      const invoice: Invoice = { id, number, date, partyId, docId, placeOfSupply: e.placeOfSupply ?? this.books.business.stateCode, reverseCharge: false, termsDays: terms, dueDate: addDays(date, terms), lines, totals: e.totals, status: dup ? "cancelled" : "staged" };
      this.books.invoices.push(invoice);
      this.ledger.reindex();
      doc.refId = id;
      payload.invoiceId = id;
      title = `Record sales invoice ${number} to ${party.name}, ₹${inr(e.totals.totalPaise, { rupees: e.totals.totalPaise % 100 === 0 })}`;
      summary = `${items}; output tax ₹${inr(tax)}. Due ${dateLabel(invoice.dueDate)} on ${terms}-day terms.`;
    }
    const toCheck = failed.filter((c) => c.key !== "duplicate");
    if (toCheck.length) summary += ` Check before approving: ${toCheck.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join("; ")}.`;

    const evidence: StagedChange["evidence"] = [
      { label: e.kind === "purchase_bill" ? "Bill total" : "Invoice total", ref: { kind: "document", id: docId, region: "totals.total" } },
      ...(e.partyGstin ? [{ label: e.kind === "purchase_bill" ? "Supplier GSTIN" : "Customer GSTIN", ref: { kind: "document" as const, id: docId, region: "gstin" } }] : []),
    ];
    const item: StagedChange = {
      id: `chg-${docId}`,
      agentId: "accountant",
      kind: "ledger_entry",
      createdAt: istNow(this.asOf),
      title,
      summary,
      evidence,
      payload,
      status: dup ? "rejected" : "pending",
      ...(dup ? { decidedAt: new Date().toISOString(), decidedBy: "The Accountant", note: dup.detail } : {}),
    };
    this.books.staged.push(item);
    doc.status = dup ? "rejected" : "staged";
    this.log(
      "accountant",
      dup ? `Set aside ${number} from ${party.name}: ${dup.detail}` : `Read ${number} from ${party.name}${toCheck.length ? `; ${toCheck.length === 1 ? "one check needs" : `${toCheck.length} checks need`} a look` : ""}.`,
      { kind: "document", id: docId },
    );
    return item;
  }

  /** Reads a received document from its text layer and stages what it found. */
  read(docId: string, items: TextItem[]): IngestResult {
    const document = this.books.documents.find((d) => d.id === docId);
    if (!document) throw new Error(`No document ${docId}`);
    if (document.status !== "reading") {
      const staged = this.books.staged.find((s) => (s.payload as { docId?: string }).docId === docId) ?? null;
      return { document, staged, message: "Already read." };
    }
    if (!items.length) return { document, staged: null, message: "This page has no text layer; it is a scan and needs the vision model." };
    return this.ingest(docId, extractInvoice(items, this.books));
  }

  /**
   * Stages a reading, from the rules or a model, and lets a trusted Accountant
   * post it unless `auto` is off (mail from an unknown sender always waits).
   */
  ingest(docId: string, e: Extraction, auto = true): IngestResult {
    const document = this.books.documents.find((d) => d.id === docId);
    if (!document) throw new Error(`No document ${docId}`);
    if (document.status !== "reading") {
      const staged = this.books.staged.find((s) => (s.payload as { docId?: string }).docId === docId) ?? null;
      return { document, staged, message: "Already read." };
    }
    if (!e.number && !e.lines.length && !e.totals.totalPaise) {
      this.failDocument(docId, "it does not look like a GST invoice or bill.");
      return { document, staged: null, message: "This does not look like a GST invoice or bill." };
    }
    const staged = this.stageExtraction(docId, e);
    const failed = e.checks.filter((c) => !c.ok);
    const why = auto ? this.routine(staged) : null;
    const [posted] = why ? this.runTrusted([staged]) : [];
    if (posted && why) return { document, staged: posted, message: `Posted on its own: the Accountant is ${why.level} and ${why.reason}.` };
    return {
      document,
      staged,
      message:
        staged.status === "rejected"
          ? (staged.note ?? "Set aside as a duplicate.")
          : failed.length
            ? `Read and waiting on your desk; ${failed.length === 1 ? "one check needs" : `${failed.length} checks need`} a look.`
            : "Read and waiting on your desk. Every check passed.",
    };
  }

  /** Files what the accountant actually filed (or a GSTR-2B statement) so the Auditor can compare it with the books. */
  importReturn(content: string, by: string, filedOn: string | null = null): { form: string; period: string; summary: string; findings: number } {
    const r = importReturn(this.ledger, content, filedOn);
    if (r.kind === "gstr2b") {
      this.books.gstr2b = [...this.books.gstr2b.filter((g) => g.period !== r.period), r.statement];
    } else {
      this.books.filedReturns = [...this.books.filedReturns.filter((f) => !(f.form === r.form && f.period === r.period)), r.filed];
    }
    this.ledger.reindex();
    const form = r.kind === "gstr2b" ? "GSTR-2B" : r.form;
    const findings = auditReport(this.ledger, r.period).findings.length;
    this.log("auditor", `${by} imported ${form} for ${r.period.startsWith("FY") ? r.period : monthLabel(r.period)} (${r.summary}). ${findings ? `${findings} difference${findings === 1 ? "" : "s"} with the books.` : "It matches the books."}`, { kind: "audit", id: r.period });
    return { form, period: r.period, summary: r.summary, findings };
  }

  /** The document could not be read at all. */
  failDocument(docId: string, reason: string) {
    const doc = this.books.documents.find((d) => d.id === docId);
    if (!doc) throw new Error(`No document ${docId}`);
    doc.status = "rejected";
    this.log("accountant", `Could not read the document: ${reason}`, { kind: "document", id: docId });
  }

  decide(id: string, decision: Decision, by: string): StagedChange {
    const item = this.allStaged().find((s) => s.id === id);
    if (!item) throw new Error(`No staged change ${id}`);
    if (item.status !== "pending") return item;
    const decided: StagedChange = {
      ...item,
      status: decision.action === "approve" ? "approved" : "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: by,
      note: decision.note,
      payload: { ...item.payload, ...(decision.edits ?? {}) },
    };
    const idx = this.books.staged.findIndex((s) => s.id === id);
    if (idx >= 0) this.books.staged[idx] = decided;
    else this.books.staged.push(decided);

    const state = this.state(item.agentId);
    state.accuracy.checked += 1;
    if (decision.action === "approve" && !decision.edits) state.accuracy.correct += 1;

    if (decision.action === "approve") this.apply(decided);
    else this.withdraw(decided);
    this.log("you", `${by} ${decision.action === "approve" ? "approved" : "rejected"}: ${item.title}${decision.note ? `. Note: ${decision.note}` : ""}`, item.evidence[0]?.ref ?? null);
    return decided;
  }

  /**
   * Why a pending item may go ahead without the owner, or null if it must wait.
   * Trusted agents handle routine work under ₹1 lakh; autonomous agents handle
   * everything except the decisions that stay with the owner.
   */
  routine(item: StagedChange): { level: TrustLevel; reason: string } | null {
    if (item.status !== "pending" || ALWAYS_ASK.has(item.kind)) return null;
    const level = this.state(item.agentId)?.trustLevel ?? "trainee";
    if (level === "trainee") return null;
    if (item.kind === "post" || item.kind === "social_reply") return this.socialRoutine(item, level);
    if (level === "autonomous") return { level, reason: "it acts on routine and unusual work alike" };
    const p = item.payload as { billId?: string; invoiceId?: string; checks?: { ok: boolean }[]; tone?: string; quoteId?: string; poId?: string };
    const under = (paise: number | undefined) => paise !== undefined && paise < TRUSTED_LIMIT_PAISE;
    const ok = (reason: string) => ({ level, reason });
    switch (item.kind) {
      case "ledger_entry": {
        const rec = p.billId ? this.books.bills.find((b) => b.id === p.billId) : this.books.invoices.find((i) => i.id === p.invoiceId);
        const party = rec ? this.ledger.findParty(rec.partyId) : undefined;
        const clean = Boolean(p.checks?.length) && (p.checks ?? []).every((c) => c.ok) && party && !party.id.endsWith("-new");
        return clean && under(rec?.totals.totalPaise) ? ok("every check passed for a known party, under ₹1 lakh") : null;
      }
      case "reminder":
        return p.tone === "polite" ? ok("it is a polite first reminder") : null;
      case "quote":
        return under(this.books.quotes.find((x) => x.id === p.quoteId)?.totals.totalPaise) ? ok("it is under ₹1 lakh") : null;
      case "purchase_order":
        return under(this.books.purchaseOrders.find((x) => x.id === p.poId)?.totalPaise) ? ok("it is under ₹1 lakh") : null;
      default:
        return null;
    }
  }

  /**
   * What the Social Media Manager may do without the owner, at any trust level above trainee:
   * thank-you replies to positive reviews and comments, and posts from a calendar the owner approved
   * that have not changed since and pass every check again. Anything else waits.
   */
  private socialRoutine(item: StagedChange, level: TrustLevel): { level: TrustLevel; reason: string } | null {
    const p = item.payload as { messageId?: string; reply?: string; postId?: string };
    if (item.kind === "social_reply") {
      const m = this.books.socialInbox.find((x) => x.id === p.messageId);
      return m && m.status === "open" && isThankYou(m, p.reply ?? m.draftReply) ? { level, reason: "it is a thank-you to a positive review or comment, with no figures or promises" } : null;
    }
    const post = this.books.posts.find((x) => x.id === p.postId);
    if (!post) return null;
    const c = this.postClearance(post);
    return c.ok ? { level, reason: c.reason } : null;
  }

  /** Whether a post may go out on its own: in an approved calendar, unchanged since, and passing every check today. */
  postClearance(post: Post): { ok: boolean; reason: string } {
    const cal = post.calendarId ? this.books.calendars.find((c) => c.id === post.calendarId) : undefined;
    if (!cal || cal.status !== "approved" || !cal.slots.some((s) => s.postId === post.id)) return { ok: false, reason: "it is not in a calendar you approved" };
    const changed = post.variants.find((v) => v.status !== "skipped" && v.approvedHash !== textHash(v.text));
    if (changed) return { ok: false, reason: `the ${PLATFORM_NAMES[changed.platform]} version changed after you approved the calendar` };
    const failed = checkPost(this.ledger, post, this.books.brandVoice, { now: this.asOf }).filter((c) => !c.ok);
    if (failed.length) return { ok: false, reason: failed.map((c) => c.detail).join("; ") };
    return { ok: true, reason: "it is in the calendar you approved, unchanged since, and every check passed again" };
  }

  /** Lets trusted and autonomous agents carry out their routine work. Returns what they did. */
  runTrusted(items: StagedChange[] = this.allStaged()): StagedChange[] {
    const done: StagedChange[] = [];
    for (const item of items) {
      const why = this.routine(item);
      if (!why) continue;
      const title = AGENT_BY_ID[item.agentId]?.title ?? "The agent";
      const decided: StagedChange = { ...item, status: "approved", decidedAt: new Date().toISOString(), decidedBy: `${title}, ${why.level}`, note: `Went ahead on its own: ${why.reason}.` };
      const idx = this.books.staged.findIndex((s) => s.id === item.id);
      if (idx >= 0) this.books.staged[idx] = decided;
      else this.books.staged.push(decided);
      this.apply(decided);
      done.push(decided);
    }
    return done;
  }

  /** A rejected ledger entry leaves its bill or invoice out of the books; a rejected calendar drops its drafts. */
  private withdraw(item: StagedChange) {
    if (item.kind === "calendar") {
      const cal = this.books.calendars.find((c) => c.id === (item.payload as { calendarId?: string }).calendarId);
      if (!cal) return;
      cal.status = "superseded";
      const ids = new Set(cal.slots.map((s) => s.postId));
      this.books.posts = this.books.posts.filter((p) => !(ids.has(p.id) && p.status === "draft"));
      return;
    }
    if (item.kind !== "ledger_entry") return;
    const p = item.payload as { billId?: string; invoiceId?: string };
    const bill = p.billId ? this.books.bills.find((b) => b.id === p.billId) : undefined;
    const inv = p.invoiceId ? this.books.invoices.find((i) => i.id === p.invoiceId) : undefined;
    if (bill) bill.status = "rejected";
    if (inv) inv.status = "cancelled";
    const doc = this.books.documents.find((d) => d.id === (bill?.docId ?? inv?.docId));
    if (doc) doc.status = "rejected";
    this.ledger.reindex();
  }

  /** Side effects of an approval on the books. Sending email is the host's job. */
  private apply(item: StagedChange) {
    const p = item.payload as Record<string, string>;
    switch (item.kind) {
      case "ledger_entry": {
        const inv = p.invoiceId ? this.books.invoices.find((i) => i.id === p.invoiceId) : undefined;
        if (inv) {
          inv.status = "posted";
          const doc = this.books.documents.find((d) => d.id === inv.docId);
          if (doc) doc.status = "posted";
          this.ledger.reindex();
          this.log("accountant", `Recorded invoice ${inv.number} in the books.`, { kind: "document", id: inv.docId });
        }
        const bill = this.books.bills.find((b) => b.id === p.billId);
        if (bill) {
          bill.status = "posted";
          const doc = this.books.documents.find((d) => d.id === bill.docId);
          if (doc) doc.status = "posted";
          this.ledger.reindex();
          this.log("accountant", `Posted bill ${bill.number} to the books.`, { kind: "document", id: bill.docId });
        }
        break;
      }
      case "reminder":
        this.log("credit-controller", `Sent the reminder to ${p.to}.`, { kind: "party", id: p.partyId ?? null });
        break;
      case "audit_flag":
        this.log("auditor", `Raised with ${this.books.business.accountantFirm.split(",")[0]}: ${String(p.action)}`, { kind: "audit", id: String(p.period) });
        break;
      case "share_file":
        this.log("tax-clerk", `Shared the file with ${this.books.business.accountantFirm.split(",")[0]}.`, { kind: "return", id: p.returnId ?? null });
        break;
      case "quote": {
        const q = this.books.quotes.find((x) => x.id === p.quoteId);
        if (q) q.status = "sent";
        this.log("quote-desk", `Sent quotation ${q?.number ?? ""}.`, { kind: "quote", id: p.quoteId ?? null });
        break;
      }
      case "campaign": {
        const c = this.books.campaigns.find((x) => x.id === p.campaignId);
        if (c) c.status = "planned";
        this.log("marketer", `Scheduled the campaign "${c?.name ?? ""}".`, { kind: "campaign", id: p.campaignId ?? null });
        break;
      }
      case "calendar":
        this.approveCalendar(p.calendarId!, item.decidedBy ?? "You");
        break;
      case "post":
        this.schedulePost(p.postId!);
        break;
      case "broadcast": {
        const post = this.books.posts.find((x) => x.id === p.postId);
        const v = post?.variants.find((x) => x.channelId === p.channelId);
        if (post && v) {
          v.status = "scheduled";
          this.effects.push({ kind: "broadcast", postId: post.id, channelId: v.channelId, audience: Number((item.payload as { audience?: number }).audience ?? 0) });
          this.log("social-media-manager", `Sending the WhatsApp broadcast for "${post.topic}".`, { kind: "post", id: post.id });
        }
        break;
      }
      case "social_reply": {
        const m = this.books.socialInbox.find((x) => x.id === p.messageId);
        if (!m) break;
        const text = p.reply ?? m.draftReply;
        m.status = "replied";
        m.draftReply = text;
        const ch = this.books.channels.find((c) => c.id === m.channelId);
        if (ch?.mode === "connected" && ch.status === "connected") this.effects.push({ kind: "reply", messageId: m.id, channelId: ch.id, text });
        this.log("social-media-manager", ch?.mode === "connected" ? `Replied to ${m.author} on ${PLATFORM_NAMES[ch.platform]}.` : `Reply to ${m.author} is ready to paste on ${m.platform}.`, { kind: "social", id: m.id });
        break;
      }
      case "purchase_order": {
        const po = this.books.purchaseOrders.find((x) => x.id === p.poId);
        if (po) po.status = "sent";
        this.log("storekeeper", `Sent purchase order ${po?.number ?? ""}.`, { kind: "purchase_order", id: p.poId ?? null });
        break;
      }
      case "payroll_run":
        this.log("payroll-clerk", "Released payslips.");
        break;
    }
  }

  /* ---------- Social media ---------- */

  effects: SocialEffect[] = [];

  takeEffects(): SocialEffect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  private channel(id: string): Channel | undefined {
    return this.books.channels.find((c) => c.id === id);
  }

  private post(id: string): Post {
    const p = this.books.posts.find((x) => x.id === id);
    if (!p) throw new Error(`No post ${id}`);
    return p;
  }

  private channelList(post: Post): string {
    const names = post.variants.filter((v) => v.status !== "skipped").map((v) => PLATFORM_NAMES[v.platform]);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "no channel");
  }

  /** Puts a post on the desk with its checks, and every figure linked to its source. */
  stagePost(post: Post, note?: string): StagedChange {
    const n = this.books.staged.filter((s) => s.kind === "post" && (s.payload as { postId?: string }).postId === post.id).length;
    const open = this.books.staged.find((s) => s.kind === "post" && s.status === "pending" && (s.payload as { postId?: string }).postId === post.id);
    if (open) return open;
    const checks = checkPost(this.ledger, post, this.books.brandVoice, { now: this.asOf });
    const failed = checks.filter((c) => !c.ok);
    const evidence: StagedChange["evidence"] = [
      ...post.skuIds.map((id) => ({ label: `${this.books.skus.find((s) => s.id === id)?.name ?? id}: price and stock`, ref: { kind: "figure" as const, id: `sku:${id}` } })),
      ...(post.campaignId ? [{ label: "The campaign", ref: { kind: "campaign" as const, id: post.campaignId } }] : []),
      { label: "The post", ref: { kind: "post" as const, id: post.id } },
    ];
    const item: StagedChange = {
      id: `chg-post-${post.id}${n ? `-${n + 1}` : ""}`,
      agentId: "social-media-manager",
      kind: "post",
      createdAt: istNow(this.asOf),
      title: `Publish "${post.topic}" on ${this.channelList(post)}, ${dateLabel(post.at.slice(0, 10))}`,
      summary: [note, failed.length ? `Check before approving: ${failed.map((c) => c.detail).join("; ")}.` : "Every check passed: prices, stock, dates, length and claims."].filter(Boolean).join(" "),
      evidence,
      payload: { postId: post.id, checks },
      status: "pending",
    };
    this.books.staged.push(item);
    return item;
  }

  /** Plans a month, drafts every slot, and puts the calendar on the desk as one card. */
  draftCalendar(month: string): StagedChange {
    const existing = this.books.calendars.find((c) => c.month === month && c.status !== "superseded");
    const prior = existing && this.books.staged.find((s) => s.kind === "calendar" && (s.payload as { calendarId?: string }).calendarId === existing.id);
    if (existing && prior) return prior;
    const { calendar, posts } = draftCalendar(this.ledger, planMonth(this.ledger, month));
    this.books.calendars = [...this.books.calendars.filter((c) => c.id !== calendar.id), calendar];
    this.books.posts.push(...posts);
    const channels = new Set(calendar.slots.flatMap((s) => s.channelIds));
    const byPillar = this.books.brandVoice.pillars.map((p) => `${calendar.slots.filter((s) => s.pillarId === p.id).length} ${p.name.toLowerCase()}`).join(", ");
    const failing = posts.filter((p) => checkPost(this.ledger, p, this.books.brandVoice).some((c) => !c.ok)).length;
    const item: StagedChange = {
      id: `chg-cal-${month}`,
      agentId: "social-media-manager",
      kind: "calendar",
      createdAt: istNow(this.asOf),
      title: `Approve the ${monthLabel(month)} calendar: ${posts.length} posts across ${channels.size} channels`,
      summary: `${byPillar}.${failing ? ` ${failing} draft${failing === 1 ? " fails" : "s fail"} a check and will wait for you after approval.` : ""} Approving lets a trusted Social Media Manager publish each post at its time, if it is unchanged and passes every check again then.`,
      evidence: [{ label: "The calendar", ref: { kind: "calendar", id: calendar.id } }],
      payload: { calendarId: calendar.id, postIds: posts.map((p) => p.id) },
      status: "pending",
    };
    this.books.staged = [...this.books.staged.filter((s) => s.id !== item.id), item];
    this.log("social-media-manager", `Drafted the ${monthLabel(month)} calendar: ${posts.length} posts.`, { kind: "calendar", id: calendar.id });
    return item;
  }

  private approveCalendar(calendarId: string, by: string) {
    const cal = this.books.calendars.find((c) => c.id === calendarId);
    if (!cal) return;
    for (const other of this.books.calendars) if (other.month === cal.month && other.id !== cal.id && other.status === "approved") other.status = "superseded";
    cal.status = "approved";
    cal.approvedAt = istNow(this.asOf);
    cal.approvedBy = by;
    if (cal.slots.some((s) => !s.postId)) {
      const drafted = draftCalendar(this.ledger, cal);
      cal.slots = drafted.calendar.slots;
      this.books.posts.push(...drafted.posts.filter((p) => !this.books.posts.some((x) => x.id === p.id)));
    }
    const staged: StagedChange[] = [];
    for (const s of cal.slots) {
      const post = s.postId ? this.books.posts.find((p) => p.id === s.postId) : undefined;
      if (!post || post.status !== "draft") continue;
      for (const v of post.variants) v.approvedHash = textHash(v.text);
      staged.push(this.stagePost(post, "From the calendar you approved."));
    }
    this.log("social-media-manager", `${by} approved the ${monthLabel(cal.month)} calendar.`, { kind: "calendar", id: cal.id });
    this.runTrusted(staged);
  }

  /** An approved post waits for its time. WhatsApp to customers goes as a broadcast, which always asks. */
  private schedulePost(postId: string) {
    const post = this.post(postId);
    post.status = "scheduled";
    for (const v of post.variants) {
      if (v.status === "skipped" || v.status === "published") continue;
      v.approvedHash = textHash(v.text);
      const ch = this.channel(v.channelId);
      if (v.platform === "whatsapp" && ch?.mode === "connected") {
        v.status = "draft";
        this.stageBroadcast(post, v);
      } else v.status = "scheduled";
    }
    this.log("social-media-manager", `Scheduled "${post.topic}" for ${this.channelList(post)} on ${dateLabel(post.at.slice(0, 10))}.`, { kind: "post", id: post.id });
  }

  stageBroadcast(post: Post, v: PostVariant): StagedChange {
    const id = `chg-bc-${post.id}`;
    const prior = this.books.staged.find((s) => s.id === id && s.status === "pending");
    if (prior) return prior;
    const audience = this.channel(v.channelId)?.followers ?? 0;
    const cost = audience * WHATSAPP_MARKETING_PAISE;
    const item: StagedChange = {
      id,
      agentId: "social-media-manager",
      kind: "broadcast",
      createdAt: istNow(this.asOf),
      title: `Send "${post.topic}" on WhatsApp to ${audience.toLocaleString("en-IN")} customers, about ${inrShort(cost)}`,
      summary: `A broadcast is a paid marketing message to customers who agreed to hear from you, at roughly ₹${(WHATSAPP_MARKETING_PAISE / 100).toFixed(2)} each in India; check Meta's current rate. It always asks.`,
      evidence: [{ label: "The post", ref: { kind: "post", id: post.id } }],
      payload: { postId: post.id, channelId: v.channelId, audience, costPaise: cost, text: v.text },
      status: "pending",
    };
    this.books.staged.push(item);
    return item;
  }

  /**
   * Called when a post's time comes. Every check runs again: if a price changed or the stock ran out,
   * the post goes back to the desk instead. Channels that are not connected get a publishing pack.
   */
  publishDue(now: string): SocialEffect[] {
    const out: SocialEffect[] = [];
    for (const post of this.books.posts) {
      if (post.status !== "scheduled" || Date.parse(post.at) > Date.parse(now)) continue;
      const due = post.variants.filter((v) => v.status === "scheduled");
      if (!due.length) continue;
      const failed = checkPost(this.ledger, post, this.books.brandVoice, { now: post.at }).filter((c) => !c.ok && c.key !== "duplicate");
      const changed = due.find((v) => v.approvedHash !== textHash(v.text));
      if (failed.length || changed) {
        const why = changed ? `the ${PLATFORM_NAMES[changed.platform]} text changed after approval` : failed.map((c) => c.detail).join("; ");
        post.status = "draft";
        for (const v of due) v.status = "draft";
        this.stagePost(post, `Held back at publishing time: ${why}.`);
        this.log("social-media-manager", `Held back "${post.topic}": ${why}. It is back on your desk.`, { kind: "post", id: post.id });
        continue;
      }
      const auto: string[] = [];
      for (const v of due) {
        const ch = this.channel(v.channelId);
        if (ch?.mode === "connected" && ch.status === "connected") {
          out.push({ kind: "publish", postId: post.id, channelId: v.channelId });
          auto.push(PLATFORM_NAMES[v.platform]);
        } else if (!v.error) {
          v.error = ch?.status === "rate_limited" ? `${PLATFORM_NAMES[v.platform]} is limiting posts; post it by hand` : "Post by hand from the publishing pack";
          this.log("social-media-manager", `"${post.topic}" is due on ${PLATFORM_NAMES[v.platform]}. The publishing pack is ready to post by hand.`, { kind: "post", id: post.id });
        }
      }
      if (auto.length) this.log("social-media-manager", `Publishing "${post.topic}" to ${auto.length === 1 ? auto[0] : `${auto.length} channels`}.`, { kind: "post", id: post.id });
    }
    this.effects.push(...out);
    return out;
  }

  markPublished(postId: string, channelId: string, result: { externalId: string | null; url: string | null; at?: string }, by = "social-media-manager") {
    const post = this.post(postId);
    const v = post.variants.find((x) => x.channelId === channelId);
    if (!v) throw new Error(`No ${channelId} version of ${postId}`);
    Object.assign(v, { status: "published", externalId: result.externalId, url: result.url, publishedAt: result.at ?? istNow(this.asOf), error: null });
    if (post.variants.every((x) => x.status === "published" || x.status === "skipped" || x.status === "failed")) post.status = "published";
    else if (post.status === "draft") post.status = "scheduled";
    this.log(by === "social-media-manager" ? by : "you", `${by === "social-media-manager" ? "Published" : `${by} posted`} "${post.topic}" on ${PLATFORM_NAMES[v.platform]}.`, { kind: "post", id: post.id });
    return post;
  }

  /** A platform refused or failed. A rate limit stops publishing on that channel until the owner reconnects it. */
  markFailed(postId: string, channelId: string, error: string, opts: { rateLimited?: boolean; final?: boolean; expired?: boolean } = {}) {
    const post = this.post(postId);
    const v = post.variants.find((x) => x.channelId === channelId);
    const ch = this.channel(channelId);
    if (!v) return;
    v.error = error.slice(0, 300);
    if (opts.final) v.status = "failed";
    if (ch && (opts.rateLimited || opts.expired)) {
      ch.status = opts.rateLimited ? "rate_limited" : "expired";
      ch.lastError = v.error;
      this.log("social-media-manager", opts.rateLimited ? `${PLATFORM_NAMES[ch.platform]} is limiting posts, so I stopped publishing there. "${post.topic}" is ready to post by hand.` : `The ${PLATFORM_NAMES[ch.platform]} connection has expired. Reconnect it in Settings.`, { kind: "channel", id: ch.id });
    } else if (opts.final) this.log("social-media-manager", `Could not publish "${post.topic}" on ${PLATFORM_NAMES[v.platform]}: ${v.error}`, { kind: "post", id: post.id });
  }

  /** A channel stopped working outside a publish: the token lapsed, the platform throttled us, or it is not set up. */
  channelProblem(channelId: string, status: "expired" | "rate_limited" | "manual", message: string) {
    const ch = this.channel(channelId);
    if (!ch || (ch.status === status && ch.lastError === message)) return;
    ch.status = status;
    ch.lastError = message.slice(0, 300);
    if (status === "manual") ch.mode = "manual";
    const name = PLATFORM_NAMES[ch.platform];
    this.log("social-media-manager", status === "expired" ? `The ${name} connection has expired. Reconnect it in Settings.` : status === "rate_limited" ? `${name} is limiting requests, so I paused it there.` : `${name} is not connected here, so its posts go out by hand. ${message}`, { kind: "channel", id: ch.id });
  }

  /** The latest numbers from a platform, matched to our posts by the platform's id. */
  recordMetrics(channelId: string, rows: { externalId: string; metrics: PostMetrics }[]): number {
    let n = 0;
    for (const r of rows) {
      const v = this.books.posts.flatMap((p) => p.variants).find((x) => x.channelId === channelId && x.externalId === r.externalId);
      if (!v) continue;
      v.metrics = r.metrics;
      n++;
    }
    return n;
  }

  /** Editing one channel's version. A scheduled post that changes goes back to the desk. */
  editVariant(postId: string, channelId: string, edits: { text?: string; link?: string | null; mediaIds?: string[] }): Post {
    const post = this.post(postId);
    const v = post.variants.find((x) => x.channelId === channelId);
    if (!v) throw new Error(`No ${channelId} version of ${postId}`);
    if (v.status === "published") throw new Error("No edits after publishing");
    if (edits.text !== undefined) v.text = edits.text;
    if (edits.link !== undefined) v.link = edits.link;
    if (edits.mediaIds) v.mediaIds = edits.mediaIds.filter((id) => this.books.media.some((m) => m.id === id));
    if (post.status === "scheduled") {
      post.status = "draft";
      for (const x of post.variants) if (x.status === "scheduled") x.status = "draft";
      this.stagePost(post, `Edited for ${PLATFORM_NAMES[v.platform]} after it was scheduled.`);
    } else if (!this.books.staged.some((s) => s.kind === "post" && s.status === "pending" && (s.payload as { postId?: string }).postId === post.id)) this.stagePost(post);
    return post;
  }

  /** New comments, reviews and messages: enquiries become leads for the Sales Rep, and each gets a drafted reply. */
  receiveMessages(raws: IncomingMessage[]): { added: SocialMessage[]; leads: number; replied: number } {
    const added: SocialMessage[] = [];
    const items: StagedChange[] = [];
    let leads = 0;
    for (const raw of raws) {
      if (this.books.socialInbox.some((m) => m.id === raw.id || (raw.externalId && m.externalId === raw.externalId))) continue;
      const m = newMessage(this.ledger, raw);
      this.books.socialInbox.push(m);
      added.push(m);
      if (m.intent === "spam") continue;
      if (m.intent === "enquiry") {
        const lead = leadFrom(this.ledger, m);
        if (!this.books.leads.some((x) => x.id === lead.id)) this.books.leads.push(lead);
        m.leadId = lead.id;
        leads++;
        this.log("social-media-manager", `Passed ${m.author}'s enquiry on ${m.platform} to the Sales Rep.`, { kind: "lead", id: lead.id });
        if (this.hired("sales-rep")) this.log("sales-rep", `New lead from ${m.platform}: ${m.author}.`, { kind: "lead", id: lead.id });
      }
      items.push(this.stageReply(m));
    }
    if (added.length) this.log("social-media-manager", `${added.length} new ${added.length === 1 ? "message" : "comments and messages"} came in.`, { kind: "social", id: added[0]!.id });
    const replied = this.runTrusted(items).length;
    return { added, leads, replied };
  }

  stageReply(m: SocialMessage): StagedChange {
    const id = `chg-reply-${m.id}`;
    const prior = this.books.staged.find((s) => s.id === id);
    if (prior) return prior;
    const what = m.kind === "review" ? `${m.rating ?? ""}${m.rating ? "-star review" : "review"}` : m.kind === "dm" ? "message" : "comment";
    const item: StagedChange = {
      id,
      agentId: "social-media-manager",
      kind: "social_reply",
      createdAt: istNow(this.asOf),
      title: `Reply to ${m.author}'s ${what} on ${m.platform}`,
      summary: `"${m.text.slice(0, 160)}${m.text.length > 160 ? "…" : ""}"${m.leadId ? " Passed to the Sales Rep as a lead." : ""}${m.replyBy ? ` WhatsApp allows a free reply until ${new Date(m.replyBy).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.` : ""}`,
      evidence: [{ label: "The message", ref: { kind: "social", id: m.id } }, ...(m.leadId ? [{ label: "The lead", ref: { kind: "lead" as const, id: m.leadId } }] : [])],
      payload: { messageId: m.id, reply: m.draftReply },
      status: "pending",
    };
    this.books.staged.push(item);
    return item;
  }

  updateVoice(voice: BrandVoice): BrandVoice {
    this.books.brandVoice = voice;
    this.log("social-media-manager", "Updated the brand voice.");
    return voice;
  }

  setupChannel(id: string, change: { handle?: string; mode?: Channel["mode"]; postingHours?: Channel["postingHours"] }): Channel {
    const ch = this.channel(id);
    if (!ch) throw new Error(`No channel ${id}`);
    if (change.handle) ch.handle = change.handle;
    if (change.postingHours) ch.postingHours = change.postingHours;
    if (change.mode === "manual") {
      ch.mode = "manual";
      ch.status = "manual";
      ch.lastError = null;
    }
    return ch;
  }

  /** The Worker calls this after an OAuth connection succeeds. */
  connectChannel(id: string, handle: string, followers: number | null = null): Channel {
    const ch = this.channel(id);
    if (!ch) throw new Error(`No channel ${id}`);
    Object.assign(ch, { mode: "connected", status: "connected", handle, lastError: null, connectedAt: istNow(this.asOf), followers: followers ?? ch.followers });
    this.log("social-media-manager", `Connected ${PLATFORM_NAMES[ch.platform]} as ${handle}.`, { kind: "channel", id });
    return ch;
  }

  addMedia(asset: MediaAsset): MediaAsset {
    this.books.media = [...this.books.media.filter((m) => m.id !== asset.id), asset];
    return asset;
  }

  calendars(): ContentCalendar[] {
    return this.books.calendars;
  }

  hiring() {
    return { agents: this.books.agents };
  }

  setHiring(agentId: string, change: { hired?: boolean; trustLevel?: TrustLevel }) {
    const s = this.state(agentId);
    if (!s) throw new Error(`Unknown agent ${agentId}`);
    if (change.hired !== undefined && change.hired !== s.hired) {
      s.hired = change.hired;
      s.hiredOn = change.hired ? this.asOf : s.hiredOn;
      this.log("office-manager", change.hired ? `${AGENT_BY_ID[agentId]!.title} joined the team as a trainee.` : `${AGENT_BY_ID[agentId]!.title} has left the team. Their pending work was withdrawn.`);
      if (change.hired) s.trustLevel = "trainee";
    }
    if (change.trustLevel && change.trustLevel !== s.trustLevel) {
      s.trustLevel = change.trustLevel;
      this.log("office-manager", `${AGENT_BY_ID[agentId]!.title} is now ${change.trustLevel}.`);
    }
    return s;
  }

  settings(): Settings {
    return this.settingsState;
  }

  updateSettings(next: Partial<Settings>): Settings {
    const { users: _users, ingestEmail: _ingest, ...rest } = next;
    if (rest.business) {
      const current = this.books.business;
      const gstin = current.gstin || rest.business.gstin;
      const derived = gstin ? { stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12) } : {};
      Object.assign(current, rest.business, { id: current.id, gstin, asOf: current.asOf, fyStart: current.fyStart }, derived);
    }
    this.settingsState = { ...this.settingsState, ...rest, business: this.books.business };
    return this.settingsState;
  }

  documentView(id: string): DocumentView {
    const doc = this.ledger.doc(id);
    if (!doc) throw new Error(`No document ${id}`);
    const invoice = doc.kind === "sales_invoice" ? (this.ledger.invoice(doc.refId ?? "") ?? null) : null;
    const bill = doc.kind === "purchase_bill" ? (this.ledger.bill(doc.refId ?? "") ?? null) : null;
    const partyId = invoice?.partyId ?? bill?.partyId;
    return { document: doc, invoice, bill, party: partyId ? this.ledger.party(partyId) : null, outstandingPaise: invoice ? this.ledger.outstanding(invoice.id) : null };
  }

  partyView(id: string): PartyView {
    const party = this.ledger.party(id);
    const ageing = ageingReport(this.ledger).rows.find((r) => r.partyId === id) ?? null;
    const recent: PartyView["recent"] = [];
    for (const inv of this.ledger.salesInvoices.filter((i) => i.partyId === id).slice(-8)) recent.push({ date: inv.date, label: `Invoice ${inv.number}`, amountPaise: inv.totals.totalPaise, docId: inv.docId });
    for (const b of this.books.bills.filter((x) => x.partyId === id).slice(-8)) recent.push({ date: b.date, label: `Bill ${b.number}`, amountPaise: b.totals.totalPaise, docId: b.docId });
    for (const p of this.books.payments.filter((x) => x.partyId === id && x.date <= this.asOf).slice(-8))
      recent.push({ date: p.date, label: `${p.direction === "in" ? "Received" : "Paid"} by ${p.mode}, ${p.reference}`, amountPaise: p.direction === "in" ? -p.amountPaise : p.amountPaise, docId: null });
    recent.sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      party,
      ageing,
      open: openInvoices(this.ledger).filter((o) => o.partyId === id),
      recent: recent.slice(0, 12),
      reminders: this.allStaged().filter((s) => s.kind === "reminder" && (s.payload as { partyId?: string }).partyId === id),
    };
  }

  /** The Office Manager in mock mode answers from the books with fixed rules. */
  ask(question: string): AskResponse {
    const q = question.toLowerCase();
    const l = this.ledger;
    const follow = ["Who owes me the most?", "How were sales last month?", "What GST do I pay this month?", "Has my accountant filed everything correctly?", "What is waiting for me?"];
    if (/owe|outstanding|debtor|overdue|collect|receivable/.test(q)) {
      const a = ageingReport(l);
      const top = a.rows.slice(0, 3);
      return {
        answer: [
          { text: "Customers owe " },
          { text: inrShort(a.totalPaise), figureId: "ageing:total" },
          { text: " in all. The largest overdue balances are " },
          ...top.flatMap((r, i) => [
            { text: `${i ? (i === top.length - 1 ? " and " : ", ") : ""}${r.name} (` },
            { text: inrShort(r.buckets.slice(1).reduce((x, y) => x + y, 0)), figureId: r.figureId, tone: "red" as const },
            { text: `, oldest ${r.oldestDaysOverdue} days)` },
          ]),
          { text: ". The Credit Controller has reminders ready on your desk." },
        ],
        followUps: follow.filter((f) => !f.includes("owes")),
      };
    }
    if (/sale|sold|revenue|turnover|month/.test(q)) {
      const s = salesReport(l);
      return { answer: s.note, followUps: follow.filter((f) => !f.includes("sales")) };
    }
    if (/gst|3b|gstr|input credit|itc/.test(q)) return { answer: gstReport(l).note, followUps: follow.filter((f) => !f.includes("GST")) };
    if (/tds|deduct/.test(q)) return { answer: tdsReport(l).note, followUps: follow };
    if (/accountant|audit|check|correct|mismatch|filed/.test(q)) {
      const f = auditAll(l).findings;
      return {
        answer: [
          { text: `The Auditor has found ${f.length} differences between the books and your accountant's returns, with ` },
          { text: inrShort(f.reduce((a, x) => a + x.impactPaise, 0)), figureId: `audit:impact:${f[0]?.period ?? monthKey(this.asOf)}`, tone: "red" },
          { text: ` of tax at stake. The biggest: ${f.sort((a, b) => b.impactPaise - a.impactPaise)[0]?.title ?? "none"}.` },
        ],
        followUps: follow,
      };
    }
    if (/wait|approve|desk|pending|todo|to do/.test(q)) {
      const p = this.pending();
      const by = new Map<string, number>();
      for (const x of p) by.set(x.agentId, (by.get(x.agentId) ?? 0) + 1);
      return {
        answer: [{ text: `${p.length} items are waiting on your desk: ${[...by.entries()].map(([a, n]) => `${n} from ${AGENT_BY_ID[a]!.title.replace("The ", "the ")}`).join(", ")}.` }],
        followUps: follow.filter((f) => !f.includes("waiting")),
      };
    }
    if (/stock|reorder|inventory|godown/.test(q)) return { answer: operationsReport(l).note, followUps: follow };
    if (/lead|pipeline|quote/.test(q)) return { answer: salesTeamReport(l).note, followUps: follow };
    if (/review|instagram|social|post/.test(q)) return { answer: socialReport(l).note, followUps: follow };
    if (/salary|payroll|pf|esi/.test(q)) return { answer: peopleReport(l).note, followUps: follow };
    return {
      answer: [{ text: "I can answer questions about what customers owe, sales, GST, TDS, your accountant's returns, stock, leads, social media and payroll, always with figures you can open and check." }],
      followUps: follow,
    };
  }
}
