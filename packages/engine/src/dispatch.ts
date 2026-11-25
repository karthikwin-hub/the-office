import {
  AnswerInput,
  AskRequest,
  BrandVoice,
  CalendarLinkInput,
  type ColumnMapping,
  FIELD_LABEL,
  SalesMappingInput,
  ChannelSetup,
  ComplianceAssign,
  ComplianceFiling,
  ComplianceManual,
  ComplianceSnooze,
  ComplianceSrn,
  CsSettingsInput,
  EventInput,
  FactsInput,
  FestivalsInput,
  HiringChange,
  ImportCheck,
  MarkPosted,
  MasterDataPaste,
  MediaAsset,
  MetricsImport,
  OwnerPosts,
  PostTime,
  type Obligation,
  OrderChange,
  OrderInput,
  OrdersImport,
  OwnerReply,
  ProfileInput,
  PartyMsme,
  ReadRequest,
  type Role,
  ROUTINE_BY_ID,
  RoutineChange,
  Settings,
  type StagedChange,
  TaskChange,
  TaskInput,
  VariantEdit,
  WidgetChange,
} from "@office/contracts";
import { RegisterError } from "./register-service";
import { routinesView } from "./routines";
import { missingFields } from "./sales/formats";
import { parseDelimited } from "./sales/parse";
import { SalesError } from "./sales/service";
import { publishingPack } from "./social/manual";
import { ageingReport } from "./ageing";
import { auditReport } from "./audit";
import { computeGstr1 } from "./gst";
import { ImportError } from "./imports";
import type { OfficeService } from "./office";
import { cashReport, gstReport, salesReport, tdsReport } from "./reports";
import { marketingReport, operationsReport, peopleReport, salesTeamReport, socialReport } from "./teams";
import { trace } from "./trace";
import { dateLabel } from "./dates";
import {
  addEvent,
  addManual,
  assign,
  checkMasterData,
  ComplianceError,
  complianceView,
  filingPack,
  markFiled,
  recordSrn,
  removeManual,
  reopen,
  saveProfile,
  snooze,
  workingPaper,
} from "./compliance";

export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
  role: Role;
  user: { name: string; email: string };
  mode: "mock" | "live";
};
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
  const res = routeRequest(office, req);
  if (req.method !== "GET" && res.status < 400) office.recordEdits(req.user.name);
  return res;
}

function routeRequest(office: OfficeService, req: ApiRequest): ApiResult {
  const l = office.ledger;
  const q = (k: string) => req.query.get(k) ?? undefined;
  const parts = req.path
    .replace(/^\/api\//, "")
    .split("/")
    .map(decodeURIComponent);
  const [head, a, b] = parts;
  const get = req.method === "GET";

  try {
    if (get && head === "session") return ok({ user: req.user, role: req.role, mode: req.mode });
    if (get && head === "office") return ok(withDrafts.office(office, req));
    if (get && head === "agents" && a) return ok(a === "executive-assistant" ? withDrafts.room(office, req) : office.agentRoom(a));
    if (head === "desk") {
      if (get && !a) return ok(withDrafts.desk(office, req));
      if (req.method === "POST" && a) {
        const item = office.allStaged().find((s) => s.id === a);
        if (!item) {
          // A reply drafted for one owner is theirs alone to decide.
          if (req.role !== "owner" || !office.assistant.drafts(req.user.email).some((d) => d.id === a)) return notFound("Item");
          const body = (req.body ?? {}) as { action?: string; note?: string; edits?: Record<string, unknown> };
          if (body.action !== "approve" && body.action !== "reject") return { status: 400, body: { error: "action must be approve or reject" } };
          return ok(office.assistant.decide(req.user.email, a, { action: body.action, note: body.note, edits: body.edits }, req.user.name));
        }
        if (req.role === "accountant" && !ACCOUNTANT_CAN_DECIDE.has(item.kind)) return forbidden("Only the owner can approve this.");
        if (item.kind === "sales_mapping" && (req.body as { action?: string } | undefined)?.action === "approve") {
          const missing = missingFields((item.payload as { mapping: ColumnMapping }).mapping);
          if (missing.length)
            return {
              status: 409,
              body: { error: `Choose the column for ${missing.map((m) => FIELD_LABEL[m].toLowerCase()).join(", ")} in the Marketplace Manager's room first.` },
            };
        }
        const body = (req.body ?? {}) as { action?: string; note?: string; edits?: Record<string, unknown> };
        if (body.action !== "approve" && body.action !== "reject") return { status: 400, body: { error: "action must be approve or reject" } };
        if (item.kind === "sheet_layout") {
          // Only the sheet's kind and columns can be changed, and they must fit the file.
          const p = item.payload as { importId: string; sheetKind?: unknown; kind?: unknown; mapping?: unknown };
          const edits = body.edits
            ? { sheetKind: body.edits.sheetKind ?? p.sheetKind, kind: body.edits.kind ?? p.kind, mapping: body.edits.mapping ?? p.mapping }
            : undefined;
          if (body.action === "approve") {
            try {
              office.intake.check(p.importId, edits ?? p);
            } catch (e) {
              if (e instanceof RegisterError) return { status: 409, body: { error: e.message } };
              throw e;
            }
          }
          body.edits = edits;
        }
        try {
          return ok(office.decide(a, { action: body.action, note: body.note, edits: body.edits }, req.user.name));
        } catch (e) {
          if (e instanceof ImportError) return { status: 409, body: { error: e.message } };
          throw e;
        }
      }
    }
    if (req.method === "POST" && head === "onboarding" && (a === "check" || a === "stage")) {
      const parsed = ImportCheck.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Attach the files to bring in." } };
      if (a === "check") return ok(office.checkOnboarding(parsed.data));
      const r = office.stageOnboarding(parsed.data, req.user.name);
      return r.item ? ok(r) : { status: 422, body: { error: "Some rows need fixing first.", preview: r.preview } };
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
      if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 5_000_000)
        return { status: 400, body: { error: "Attach the return file." } };
      try {
        const staged = office.stageReturn(body.content, req.user.name, typeof body.filedOn === "string" ? body.filedOn : null);
        return ok({ staged, message: "It waits on your desk. Once approved, the Auditor compares it with the books." });
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
    if (get && head === "parties" && !a) return ok(office.partiesView());
    if (get && head === "parties" && a) return l.findParty(a) ? ok(office.partyView(a)) : notFound("Party");
    if (req.method === "PUT" && head === "parties" && a && b === "msme") {
      const party = l.findParty(a);
      if (!party) return notFound("Party");
      if (party.kind !== "vendor") return bad("Udyam details are kept for suppliers.");
      const parsed = PartyMsme.safeParse(req.body ?? {});
      if (!parsed.success) return bad("Check the Udyam number (UDYAM-XX-00-0000000) and the credit days.");
      const m = parsed.data;
      Object.assign(party, {
        udyamCategory: m.udyamCategory,
        udyamNumber: m.udyamNumber || undefined,
        udyamActivity: m.udyamActivity ?? undefined,
        writtenCreditDays: m.writtenCreditDays ?? undefined,
        related: m.related || undefined,
      });
      office.log(
        "compliance-officer",
        `${req.user.name} recorded ${party.name} as ${m.udyamCategory === "none" ? "not registered on Udyam" : `a ${m.udyamCategory} enterprise${m.udyamActivity ? ` in ${m.udyamActivity}` : ""}`}${m.writtenCreditDays !== null ? `, ${m.writtenCreditDays} days agreed in writing` : ""}.`,
        { kind: "party", id: party.id },
      );
      return ok(office.partyView(a));
    }
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
    if (head === "assistant") return assistant(office, req, parts.slice(1));
    if (head === "sales") return onlineSales(office, req, parts.slice(1));
    if (head === "orders") return orders(office, req, parts.slice(1));
    if (head === "compliance") return compliance(office, req, parts.slice(1));
    if (head === "books-record") return booksRecord(office, req, parts.slice(1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(No|Unknown) /.test(msg)) return { status: 404, body: { error: msg } };
    throw e;
  }
  return notFound("Route");
}

const bad = (error: string): ApiResult => ({ status: 400, body: { error } });

/** Replies the Executive Assistant drafted are added to the desk, the floor and its room for their own owner only. */
const withDrafts = {
  mine(office: OfficeService, req: ApiRequest): StagedChange[] {
    return req.role === "owner" ? office.assistant.drafts(req.user.email) : [];
  },
  desk(office: OfficeService, req: ApiRequest) {
    const d = office.desk();
    if (req.role !== "owner") return d;
    const mine = withDrafts.mine(office, req);
    const decided = office.assistant.decidedDrafts(req.user.email);
    const newest = (x: StagedChange, y: StagedChange) => (x.createdAt < y.createdAt ? 1 : -1);
    return {
      items: [...d.items, ...mine].sort(newest),
      decided: [...d.decided, ...decided].sort((x, y) => ((x.decidedAt ?? "") < (y.decidedAt ?? "") ? 1 : -1)),
    };
  },
  office(office: OfficeService, req: ApiRequest) {
    const v = office.officeView();
    const n = withDrafts.mine(office, req).length;
    if (!n) return v;
    return {
      ...v,
      deskCount: v.deskCount + n,
      rooms: v.rooms.map((r) =>
        r.agentId === "executive-assistant" ? { ...r, waitingCount: r.waitingCount + n, status: r.status === "idle" ? ("waiting" as const) : r.status } : r,
      ),
    };
  },
  room(office: OfficeService, req: ApiRequest) {
    const v = office.agentRoom("executive-assistant");
    const mine = withDrafts.mine(office, req);
    const status = mine.length
      ? { ...v.status, waitingCount: mine.length, status: v.status.status === "idle" ? ("waiting" as const) : v.status.status }
      : v.status;
    return { ...v, status, pending: mine };
  },
};

/** Online sales: anyone in the office may look; mapping and removing reports is the owner's. Uploads need the host, which reads the file. */
function onlineSales(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const s = office.sales;
  const [what, id, sub] = parts;
  if (!what && req.method === "GET") return ok(s.report({ from: req.query.get("from") ?? undefined, to: req.query.get("to") ?? undefined }));
  if (what !== "imports" || !id) return notFound("Route");
  const imp = s.store.importById(id);
  if (!imp) return notFound("Report");
  if (req.method === "GET" && !sub) {
    const p = s.store.pending(id);
    return ok({
      import: imp,
      headers: p?.headers ?? [],
      sample: p ? p.rows.slice(p.headerAt + 1, p.headerAt + 6) : [],
      mapping:
        (
          office.books.staged.find((x) => x.kind === "sales_mapping" && (x.payload as { importId?: string }).importId === id)?.payload as
            | { mapping?: ColumnMapping }
            | undefined
        )?.mapping ?? {},
    });
  }
  if (req.role !== "owner") return forbidden("Only the owner can change how reports are read.");
  if (req.method === "DELETE" && !sub) {
    s.removeImport(id);
    return ok(s.report());
  }
  if (req.method === "PUT" && sub === "mapping") {
    const parsed = SalesMappingInput.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Choose the platform and which column is which.");
    try {
      return ok(s.mapFromRoom(id, parsed.data.channel, parsed.data.mapping, req.user.name));
    } catch (e) {
      if (e instanceof SalesError) return bad(e.message);
      throw e;
    }
  }
  return notFound("Route");
}

/** The Executive Assistant's own page: one owner's calendar, tasks and emails, never anyone else's. */
function assistant(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  if (req.role !== "owner") return forbidden("The assistant works for each owner on their own; there is nothing here for the accountant.");
  const ea = office.assistant;
  const me = req.user.email;
  const [what, id] = parts;
  const sample = req.mode === "mock";
  if (!what && req.method === "GET") return ok(ea.view(me, sample));
  if (what === "calendar") {
    if (req.method === "DELETE") {
      ea.clearCalendar(me);
      return ok(ea.view(me, sample));
    }
    if (req.method === "PUT") {
      // Live, the Worker reads the link itself before this; the demo has a sample week instead.
      const parsed = CalendarLinkInput.safeParse(req.body ?? {});
      if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Paste your calendar's private address.");
      if (req.mode !== "mock") return { status: 501, body: { error: "The calendar is read by the server." } };
      ea.setCalendar(me, { events: ea.sampleCalendar(me), label: "Sample calendar" });
      return ok(ea.view(me, sample));
    }
  }
  if (what === "tasks") {
    if (req.method === "POST" && !id) {
      const parsed = TaskInput.safeParse(req.body ?? {});
      if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Say what to do.");
      ea.addTask(me, parsed.data);
      return ok(ea.view(me, sample));
    }
    if (req.method === "PATCH" && id) {
      const parsed = TaskChange.safeParse(req.body ?? {});
      if (!parsed.success) return bad("Send a status, a due date or a snooze date.");
      if (!ea.changeTask(me, id, parsed.data)) return notFound("Task");
      return ok(ea.view(me, sample));
    }
  }
  if (what === "mail" && id && req.method === "GET") {
    const m = ea.view(me, sample).mail.find((x) => x.id === id);
    return m ? ok(m) : notFound("Email");
  }
  return notFound("Route");
}

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

/**
 * The Compliance Officer's calendar. Owner and accountant alike keep it: answer the profile, mark items
 * filed with the acknowledgement and proof, hand them to each other, and record the SRN of an MCA form.
 */
function compliance(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const [what, id, sub] = parts;
  const books = office.books;
  const at = office.nowIst();
  const by = req.user.name;
  const done = (o: Obligation, text: string) => {
    office.log("compliance-officer", `${by} ${text}`, { kind: "compliance", id: o.id });
    return ok(o);
  };
  const read = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T | null => {
    const r = schema.safeParse(req.body ?? {});
    return r.success ? (r.data as T) : null;
  };
  try {
    if (req.method === "GET" && !what) return ok(complianceView(books, office.asOf));
    if (req.method === "GET" && what === "audit")
      return ok({
        entries: books.teamLog
          .filter((e) => e.ref?.kind === "compliance" || e.agentId === "compliance-officer")
          .sort((x, y) => (x.at < y.at ? 1 : -1))
          .slice(0, 200),
      });
    if (req.method === "GET" && what === "papers" && id) {
      const p = workingPaper(books, id, office.asOf);
      return p ? ok(p) : notFound("Working paper");
    }
    if (what === "profile" && req.method === "PUT") {
      const input = read(ProfileInput);
      if (!input) return bad("Check the profile: dates as YYYY-MM-DD, DINs of eight digits and amounts in paise.");
      const r = saveProfile(books, input, office.asOf);
      office.log(
        "compliance-officer",
        `${by} updated the company profile${r.events.length ? `; ${r.events.length === 1 ? "one change starts" : `${r.events.length} changes start`} an ROC clock: ${r.events.map((e) => e.detail).join(" ")}` : "."}`,
        { kind: "compliance", id: null },
      );
      return ok(complianceView(books, office.asOf));
    }
    if (what === "master-data" && req.method === "POST") {
      const input = read(MasterDataPaste);
      if (!input) return bad("Paste the company's master data from the MCA portal.");
      const rows = checkMasterData(books, input.text, office.asOf);
      const off = rows.filter((r) => !r.ok);
      office.log(
        "compliance-officer",
        `${by} checked the MCA master data: ${off.length ? `${off.length} difference${off.length === 1 ? "" : "s"} (${off.map((r) => r.field).join(", ")})` : "everything matches"}.`,
        { kind: "compliance", id: null },
      );
      return ok({ rows });
    }
    if (what === "events" && req.method === "POST") {
      const input = read(EventInput);
      if (!input) return bad("An event needs what happened, the date and a line about it.");
      const e = addEvent(books, input);
      office.log("compliance-officer", `${by} recorded: ${e.detail}`, { kind: "compliance", id: null });
      return ok(complianceView(books, office.asOf));
    }
    if (what === "items" && !id && req.method === "POST") {
      const input = read(ComplianceManual);
      if (!input) return bad("An item needs a name and a due date.");
      return done(addManual(books, input, by, at), `added "${input.form}" to the calendar, due ${dateLabel(input.dueOn)}.`);
    }
    if (what === "items" && id && !sub && req.method === "DELETE") {
      removeManual(books, id);
      office.log("compliance-officer", `${by} removed an item added by hand.`, { kind: "compliance", id });
      return ok({ removed: id });
    }
    if (what === "items" && id && sub === "pack" && req.method === "GET") {
      const pack = filingPack(books, id, office.asOf);
      return pack ? ok(pack) : notFound("Filing pack");
    }
    if (what === "items" && id && sub === "filed" && req.method === "POST") {
      const input = read(ComplianceFiling);
      if (!input) return bad("Give the date it was filed.");
      const o = markFiled(books, id, input, by, at);
      return done(
        o,
        `marked ${o.form} filed on ${dateLabel(input.filedOn)}${input.ack ? ` (${input.ack})` : ""}${input.proof ? ", with proof attached" : ""}.`,
      );
    }
    if (what === "items" && id && sub === "filed" && req.method === "DELETE") {
      const o = reopen(books, id, by, at);
      return done(o, `reopened ${o.form}: it is no longer marked filed.`);
    }
    if (what === "items" && id && sub === "assign" && req.method === "POST") {
      const input = read(ComplianceAssign);
      if (!input) return bad("Choose the owner, the CA or the CS.");
      const o = assign(books, id, input, by, at);
      const who = input.assignee === "owner" ? "the owner" : input.assignee ? `the ${input.assignee.toUpperCase()}` : "nobody";
      return done(
        o,
        `${input.progress === "ready" ? "marked ready to file" : input.progress === "preparing" ? "started preparing" : "handed"} ${o.form}${input.progress ? "" : ` to ${who}`}.`,
      );
    }
    if (what === "items" && id && sub === "snooze" && req.method === "POST") {
      const input = read(ComplianceSnooze);
      if (!input) return bad("Give a date to snooze until, and why.");
      const o = snooze(books, id, input, by, at);
      return done(
        o,
        input.until ? `snoozed ${o.form} until ${dateLabel(input.until)}${input.reason ? `: ${input.reason}` : ""}.` : `brought ${o.form} back from snooze.`,
      );
    }
    if (what === "items" && id && sub === "srn" && req.method === "POST") {
      const input = read(ComplianceSrn);
      if (!input) return bad("An SRN needs its number, date and status.");
      const o = recordSrn(books, id, input, by, at);
      return done(
        o,
        `recorded SRN ${input.number} for ${o.form}: ${input.status.replace(/_/g, " ")}${input.resubmitBy ? `, resubmit by ${dateLabel(input.resubmitBy)}` : ""}.`,
      );
    }
    if (what === "proof" && req.method === "POST" && req.mode === "mock") {
      const body = (req.body ?? {}) as { name?: unknown };
      const name = typeof body.name === "string" && body.name ? body.name.slice(0, 200) : "proof.pdf";
      return ok({ file: `mock-proof-${Date.now()}`, name });
    }
  } catch (e) {
    if (e instanceof ComplianceError) return { status: 422, body: { error: e.message } };
    throw e;
  }
  return notFound("Route");
}

/** The books' own record for the auditor and the ROC: the edit log, the backup in India and who keeps the books. */
function booksRecord(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const [what] = parts;
  if (req.method !== "GET") return notFound("Route");
  if (!what) return ok(office.booksRecord());
  if (what === "edits") {
    const limit = Math.min(500, Math.max(1, Number(req.query.get("limit") ?? 100) || 100));
    return ok({ entries: office.edits.list({ coll: req.query.get("coll") ?? undefined, recordId: req.query.get("record") ?? undefined, limit }) });
  }
  if (what === "auditor-statement") return ok(office.auditorStatement(req.query.get("fy") ?? undefined));
  return notFound("Route");
}

/** Orders, so the agent can say where one is: added by hand, imported from a spreadsheet, or changed on WhatsApp. */
function orders(office: OfficeService, req: ApiRequest, parts: string[]): ApiResult {
  const cs = office.customers;
  const [id] = parts;
  const write = req.method !== "GET";
  if (write && req.role !== "owner") return forbidden("Only the owner can change orders.");
  if (!write)
    return ok({
      orders: office.books.orders.slice().sort((a, b) => (a.placedOn < b.placedOn ? 1 : a.placedOn > b.placedOn ? -1 : a.number < b.number ? 1 : -1)),
    });
  if (id === "import" && req.method === "POST") {
    const parsed = OrdersImport.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Attach the orders file.");
    try {
      return ok(cs.importOrders(parsed.data.content));
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

/** Runs a change whose refusal is a plain sentence for the owner. */
function refused(run: () => unknown): ApiResult {
  try {
    return ok(run());
  } catch (e) {
    return { status: 422, body: { error: e instanceof Error ? e.message : String(e) } };
  }
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
  if (what === "festivals" && write) {
    const parsed = FestivalsInput.safeParse(req.body ?? {});
    return parsed.success ? ok(office.setFestivals(parsed.data.festivals)) : bad("Each festival needs a date (YYYY-MM-DD) and a name.");
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
  if (what === "posts" && !id && req.method === "POST") {
    const parsed = OwnerPosts.safeParse(req.body ?? {});
    if (!parsed.success) return bad("Each post needs its text and at least one channel.");
    return refused(() => office.addOwnerPosts(parsed.data, req.user.name));
  }
  if (what === "posts" && id && !sub && req.method === "PUT") {
    const parsed = PostTime.safeParse(req.body ?? {});
    return parsed.success ? refused(() => office.movePost(id, parsed.data.at)) : bad("Send the new time.");
  }
  if (what === "posts" && id && !sub && req.method === "DELETE") return refused(() => office.cancelOwnerPost(id));
  if (what === "posts" && id && sub === "stop" && req.method === "POST") return refused(() => office.stopPost(id, req.user.name));
  if (what === "posts" && id && sub === "variants" && channelId && action === "takedown" && req.method === "POST")
    return refused(() => office.takeDown(id, channelId, req.user.name));
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
      // Through the office's one reader: a new export layout is confirmed once on the Desk (ADR 0010).
      const sheets = [{ name: "Post results", rows: parseDelimited(parsed.data.content) }];
      const [r] = office.intake.receive({
        id: `mets-${Date.now().toString(36)}`,
        file: "post results.csv",
        fileUrl: "",
        sheets,
        via: "upload",
        from: null,
        auto: true,
        kinds: ["social_metrics"],
      });
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
