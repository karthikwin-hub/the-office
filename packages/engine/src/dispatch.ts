import {
  AnswerInput,
  AskRequest,
  BrandVoice,
  ChannelSetup,
  CsSettingsInput,
  FactsInput,
  HiringChange,
  MarkPosted,
  MediaAsset,
  MetricsImport,
  OrderChange,
  OrderInput,
  OrdersImport,
  OwnerReply,
  ReadRequest,
  type Role,
  ROUTINE_BY_ID,
  RoutineChange,
  Settings,
  VariantEdit,
  WidgetChange,
} from "@office/contracts";
import { routinesView } from "./routines";
import { importMetrics, publishingPack } from "./social/manual";
import { ageingReport } from "./ageing";
import { auditReport } from "./audit";
import { computeGstr1 } from "./gst";
import { ImportError } from "./imports";
import type { OfficeService } from "./office";
import { cashReport, gstReport, salesReport, tdsReport } from "./reports";
import { marketingReport, operationsReport, peopleReport, salesTeamReport, socialReport } from "./teams";
import { trace } from "./trace";

export type ApiRequest = { method: string; path: string; query: URLSearchParams; body?: unknown; role: Role; user: { name: string; email: string }; mode: "mock" | "live" };
export type ApiResult = { status: number; body: unknown };

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const notFound = (what: string): ApiResult => ({ status: 404, body: { error: `${what} not found` } });
const forbidden = (why: string): ApiResult => ({ status: 403, body: { error: why } });

/** The accountant can read everything and answer the Auditor, but only the owner approves work or hires. */
const ACCOUNTANT_CAN_DECIDE = new Set(["audit_flag", "share_file"]);

/**
 * Framework-free router over the engine. MSW in the browser and the Worker's
 * mock environment both call this, so the mockups and the API cannot drift.
 */
export function dispatch(office: OfficeService, req: ApiRequest): ApiResult {
  const l = office.ledger;
  const q = (k: string) => req.query.get(k) ?? undefined;
  const parts = req.path.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
  const [head, a, b] = parts;
  const get = req.method === "GET";

  try {
    if (get && head === "session") return ok({ user: req.user, role: req.role, mode: req.mode });
    if (get && head === "office") return ok(office.officeView());
    if (get && head === "agents" && a) return ok(office.agentRoom(a));
    if (head === "desk") {
      if (get && !a) return ok(office.desk());
      if (req.method === "POST" && a) {
        const item = office.allStaged().find((s) => s.id === a);
        if (!item) return notFound("Item");
        if (req.role === "accountant" && !ACCOUNTANT_CAN_DECIDE.has(item.kind)) return forbidden("Only the owner can approve this.");
        const body = (req.body ?? {}) as { action?: string; note?: string; edits?: Record<string, unknown> };
        if (body.action !== "approve" && body.action !== "reject") return { status: 400, body: { error: "action must be approve or reject" } };
        return ok(office.decide(a, { action: body.action, note: body.note, edits: body.edits }, req.user.name));
      }
    }
    if (get && head === "reports") {
      switch (a) {
        case "sales":
          return ok(salesReport(l, q("from"), q("to")));
        case "ageing":
          return ok(ageingReport(l));
        case "gst":
          return ok(gstReport(l, q("period")));
        case "tds":
          return ok(tdsReport(l, q("quarter")));
        case "cash":
          return ok(cashReport(l));
        case "sales-team":
          return ok(salesTeamReport(l));
        case "marketing":
          return ok(marketingReport(l));
        case "social":
          return ok(socialReport(l));
        case "operations":
          return ok(operationsReport(l));
        case "people":
          return ok(peopleReport(l, q("period")));
      }
      return notFound("Report");
    }
    if (get && head === "audit") return ok(auditReport(l, q("period")));
    if (req.method === "POST" && head === "returns" && a === "import") {
      const body = (req.body ?? {}) as { content?: unknown; filedOn?: unknown };
      if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 5_000_000) return { status: 400, body: { error: "Attach the return file." } };
      try {
        return ok(office.importReturn(body.content, req.user.name, typeof body.filedOn === "string" ? body.filedOn : null));
      } catch (e) {
        if (e instanceof ImportError) return { status: 422, body: { error: e.message } };
        throw e;
      }
    }
    if (get && head === "trace" && a) return ok(trace(l, parts.slice(1).join("/")));
    if (head === "documents" && a && b === "read" && req.method === "POST") {
      const parsed = ReadRequest.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: { error: "Send the document's text layer as items." } };
      if (!l.doc(a)) return notFound("Document");
      return ok(office.read(a, parsed.data.items));
    }
    if (get && head === "documents") {
      if (!a) return ok(office.books.documents.slice().sort((x, y) => (x.receivedAt < y.receivedAt ? 1 : -1)));
      if (a === "unread") return ok(office.unread());
      return l.doc(a) ? ok(office.documentView(a)) : notFound("Document");
    }
    if (get && head === "parties" && a) return l.findParty(a) ? ok(office.partyView(a)) : notFound("Party");
    if (req.method === "POST" && head === "ask") {
      const parsed = AskRequest.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: { error: "Ask a question in up to 500 characters." } };
      return ok(office.ask(parsed.data.question));
    }
    if (head === "hiring") {
      if (get && !a) return ok(office.hiring());
      if (req.method === "POST" && a) {
        if (req.role !== "owner") return forbidden("Only the owner can hire or change trust levels.");
        const parsed = HiringChange.safeParse(req.body);
        if (!parsed.success) return { status: 400, body: { error: "Invalid change" } };
        return ok(office.setHiring(a, parsed.data));
      }
    }
    if (head === "settings") {
      if (get) return ok(office.settings());
      if (req.method === "POST" || req.method === "PUT") {
        if (req.role !== "owner") return forbidden("Only the owner can change settings.");
        const parsed = Settings.partial().safeParse(req.body ?? {});
        if (!parsed.success) return { status: 400, body: { error: "Invalid settings" } };
        return ok(office.updateSettings(parsed.data));
      }
    }
    if (get && head === "exports" && a === "gstr1" && b) return ok(computeGstr1(l, b));
    if (head === "social") return social(office, req, parts.slice(1));
    if (head === "routines") return routines(office, req, parts.slice(1));
    if (head === "customers") return customers(office, req, parts.slice(1));
    if (head === "orders") return orders(office, req, parts.slice(1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(No|Unknown) /.test(msg)) return { status: 404, body: { error: msg } };
    throw e;
  }
  return notFound("Route");
}

const bad = (error: string): ApiResult => ({ status: 400, body: { error } });

/** Routines: anyone may look; pausing is the owner's. "Run now" needs the host, so it is handled there. */
function routines(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const [id, sub] = parts;
  if (req.method === "GET" && !id) return ok({ routines: routinesView(office) });
  if (!id || !ROUTINE_BY_ID[id]) return notFound("Routine");
  if (req.method === "GET" && sub === "runs") return ok({ runs: office.routines.runs(id, 50) });
  if (req.method === "POST" && !sub) {
    if (req.role !== "owner") return forbidden("Only the owner can pause or resume a routine.");
    const parsed = RoutineChange.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Send { paused: true } or { paused: false }.");
    office.routines.setPaused(id, parsed.data.paused);
    office.log("office-manager", `${req.user.name} ${parsed.data.paused ? "paused" : "resumed"} "${ROUTINE_BY_ID[id]!.title}".`);
    return ok({ routines: routinesView(office) });
  }
  return notFound("Route");
}

/** The Customer Service agent's room. Conversations are open to the team; changing the agent's knowledge or replying is the owner's. */
function customers(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const cs = office.customers;
  const [what, id, sub] = parts;
  const write = req.method !== "GET";
  if (write && req.role !== "owner") return forbidden("Only the owner can change customer service or reply to customers.");
  if (!what && !write) return ok(cs.view());
  if (what === "threads" && id && !sub && !write) return ok(cs.threadView(id));
  if (what === "threads" && id && sub === "reply" && req.method === "POST") {
    const parsed = OwnerReply.safeParse(req.body ?? {});
    return parsed.success ? ok(cs.ownerReply(id, parsed.data.text, req.user.name)) : bad("Write a reply.");
  }
  if (what === "facts" && write) {
    const parsed = FactsInput.safeParse(req.body ?? {});
    return parsed.success ? ok(cs.updateFacts(parsed.data)) : bad("Check the business facts: opening and closing times as HH:MM.");
  }
  if (what === "settings" && write) {
    const parsed = CsSettingsInput.safeParse(req.body ?? {});
    return parsed.success ? ok(cs.setRetention(parsed.data.retentionMonths)) : bad("Keep conversations for 1 to 36 months.");
  }
  if (what === "widget" && write) {
    const parsed = WidgetChange.safeParse(req.body ?? {});
    return parsed.success ? ok(cs.setWidget(parsed.data.enabled)) : bad("Send { enabled: true } or { enabled: false }.");
  }
  if (what === "answers") {
    if (!write) return ok(cs.setup.answers);
    if (req.method === "DELETE" && id) return ok(cs.removeAnswer(id));
    const parsed = AnswerInput.safeParse(req.body ?? {});
    if (!parsed.success) return bad("An answer needs a title and the reply to send.");
    return ok(id ? cs.updateAnswer(id, parsed.data) : cs.addAnswer(parsed.data));
  }
  return notFound("Route");
}

/** Orders, so the agent can say where one is: added by hand, imported from a spreadsheet, or changed on WhatsApp. */
function orders(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const cs = office.customers;
  const [id] = parts;
  const write = req.method !== "GET";
  if (write && req.role !== "owner") return forbidden("Only the owner can change orders.");
  if (!write) return ok({ orders: office.books.orders.slice().sort((a, b) => (a.placedOn < b.placedOn ? 1 : a.placedOn > b.placedOn ? -1 : a.number < b.number ? 1 : -1)) });
  if (id === "import" && req.method === "POST") {
    const parsed = OrdersImport.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Attach the orders file.");
    try {
      return ok(cs.importOrders(parsed.data.content, req.user.name));
    } catch (e) {
      return { status: 422, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (!id && req.method === "POST") {
    const parsed = OrderInput.safeParse(req.body ?? {});
    if (!parsed.success) return bad("An order needs a number and a customer.");
    try {
      return ok(cs.addOrder(parsed.data));
    } catch (e) {
      return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (id && req.method === "DELETE") return ok(cs.removeOrder(id));
  if (id && (req.method === "PUT" || req.method === "POST")) {
    const parsed = OrderChange.safeParse(req.body ?? {});
    return parsed.success ? ok(cs.updateOrder(id, parsed.data, req.user.name)) : bad("Invalid change");
  }
  return notFound("Route");
}

/** The Social Media Manager's routes. Reading is open to the team; changing anything is the owner's. */
function social(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const [what, id, sub, channelId, action] = parts;
  const write = req.method !== "GET";
  if (write && req.role !== "owner") return forbidden("Only the owner can change social media.");
  if (what === "voice" && write) {
    const parsed = BrandVoice.safeParse(req.body);
    return parsed.success ? ok(office.updateVoice(parsed.data)) : bad("Check the brand voice: it needs a tone, at least one language and pillars that add up.");
  }
  if (what === "channels" && id && write) {
    const parsed = ChannelSetup.safeParse(req.body ?? {});
    return parsed.success ? ok(office.setupChannel(id, parsed.data)) : bad("Invalid channel settings");
  }
  if (what === "calendar" && id === "draft" && write) {
    const month = (req.body as { month?: unknown } | undefined)?.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return bad("Send the month as YYYY-MM.");
    return ok(office.draftCalendar(month));
  }
  if (what === "posts" && id && sub === "variants" && channelId) {
    if (!action && write) {
      const parsed = VariantEdit.safeParse(req.body ?? {});
      return parsed.success ? ok(office.editVariant(id, channelId, parsed.data)) : bad("Invalid edit");
    }
    if (action === "posted" && write) {
      const parsed = MarkPosted.safeParse(req.body ?? {});
      if (!parsed.success) return bad("Paste the post's link.");
      return ok(office.markPublished(id, channelId, { externalId: null, url: parsed.data.url }, req.user.name));
    }
    if (action === "pack" && !write) return ok(publishingPack(office.books, id, channelId));
  }
  if (what === "metrics" && id === "import" && write) {
    const parsed = MetricsImport.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Attach the metrics file.");
    try {
      const r = importMetrics(office.books, parsed.data.content);
      office.log("social-media-manager", `${req.user.name} imported results for ${r.matched} post${r.matched === 1 ? "" : "s"}${r.unmatched ? `; ${r.unmatched} rows did not match a post` : ""}.`);
      return ok(r);
    } catch (e) {
      return { status: 422, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (what === "media" && write && req.mode === "mock") {
    const parsed = MediaAsset.safeParse(req.body);
    return parsed.success ? ok(office.addMedia(parsed.data)) : bad("Invalid picture");
  }
  if (what === "inbox" && write && req.mode === "mock") {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    return ok(office.receiveMessages(list as Parameters<OfficeService["receiveMessages"]>[0]));
  }
  return notFound("Route");
}
