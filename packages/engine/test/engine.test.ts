import {
  AgeingReport,
  AgentRoomView,
  AGENTS,
  AuditReport,
  CashReport,
  DeskView,
  GstReport,
  MarketingReport,
  OfficeView,
  OperationsReport,
  PeopleReport,
  SalesReport,
  SalesTeamReport,
  SocialReport,
  TdsReport,
  Trace,
} from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import {
  ageingReport,
  auditAll,
  auditReport,
  cashReport,
  checkInvoice,
  computeGstr1,
  dispatch,
  gstReport,
  Ledger,
  marketingReport,
  OfficeService,
  operationsReport,
  peopleReport,
  salesReport,
  salesTeamReport,
  socialReport,
  tdsReport,
  trace,
} from "../src";

const books = loadBooks();
const l = new Ledger(books);

describe("books", () => {
  it("every sales invoice reconciles line by line", () => {
    const bad = l.salesInvoices.map((i) => ({ n: i.number, issues: checkInvoice(i, books.business.stateCode) })).filter((x) => x.issues.length);
    expect(bad).toEqual([]);
  });

  it("engine GSTR-1 matches the filed September return", () => {
    const filed = books.filedReturns.find((r) => r.form === "GSTR-1" && r.period === "2026-09");
    expect(filed).toBeTruthy();
    const ours = computeGstr1(l, "2026-09");
    expect(JSON.stringify(ours.b2b)).toEqual(JSON.stringify((filed as { data: { b2b: unknown } }).data.b2b));
  });
});

describe("auditor", () => {
  it("finds exactly the planted errors", () => {
    const f = auditAll(l).findings;
    const titles = f.map((x) => `${x.form} ${x.period}: ${x.title}`).join("\n");
    expect(titles).toMatch(/KE\/26-27\/0257/);
    expect(titles).toMatch(/DLC\/2610\/488/);
    expect(titles).toMatch(/Mehta/);
    expect(titles).toMatch(/rent|Shirke/i);
    expect(titles).toMatch(/26AS|Sahyog/);
    expect(f.length).toBeGreaterThanOrEqual(5);
    expect(f.length).toBeLessThanOrEqual(7);
  });
});

describe("reports satisfy their contracts", () => {
  const cases: [string, { parse: (x: unknown) => unknown }, () => unknown][] = [
    ["sales", SalesReport, () => salesReport(l)],
    ["ageing", AgeingReport, () => ageingReport(l)],
    ["gst", GstReport, () => gstReport(l)],
    ["tds", TdsReport, () => tdsReport(l)],
    ["cash", CashReport, () => cashReport(l)],
    ["sales team", SalesTeamReport, () => salesTeamReport(l)],
    ["marketing", MarketingReport, () => marketingReport(l)],
    ["social", SocialReport, () => socialReport(l)],
    ["operations", OperationsReport, () => operationsReport(l)],
    ["people", PeopleReport, () => peopleReport(l)],
    ["audit", AuditReport, () => auditReport(l)],
  ];
  for (const [name, schema, fn] of cases) it(name, () => void schema.parse(fn()));
});

describe("office", () => {
  const office = new OfficeService(loadBooks());

  it("floor, rooms and desk parse", () => {
    OfficeView.parse(office.officeView());
    for (const a of AGENTS) AgentRoomView.parse(office.agentRoom(a.id));
    DeskView.parse(office.desk());
    expect(office.desk().items.length).toBeGreaterThan(5);
  });

  it("every figure id on the reports traces to rows that add up", () => {
    const ids = new Set<string>();
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object")
        for (const [k, v] of Object.entries(x)) {
          if (k === "figureId" && typeof v === "string") ids.add(v);
          else walk(v);
        }
    };
    [salesReport(l), ageingReport(l), gstReport(l), tdsReport(l), cashReport(l), marketingReport(l), operationsReport(l), peopleReport(l), auditReport(l), salesTeamReport(l)].forEach(walk);
    for (const a of AGENTS) walk(office.kpis(a.id));
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) {
      const t = Trace.parse(trace(l, id));
      expect(t.title, id).not.toBe("Figure not recognised");
      expect(t.rows.length, id).toBeGreaterThan(0);
    }
  });

  it("each staffed room on the floor shows one of its own figures, and it traces to rows", () => {
    const rooms = office.officeView().rooms;
    const withHeadline = rooms.filter((r) => r.headline);
    expect(withHeadline.length).toBeGreaterThanOrEqual(8);
    for (const r of rooms) if (!r.hired) expect(r.headline, r.agentId).toBeUndefined();
    for (const r of withHeadline) {
      const h = r.headline!;
      expect(office.kpis(r.agentId).some((k) => k.label === h.label && k.value === h.value), r.agentId).toBe(true);
      expect(h.value, r.agentId).not.toMatch(/^(₹?0|None|-)$/);
      if (h.figureId) expect(trace(l, h.figureId).rows.length, r.agentId).toBeGreaterThan(0);
    }
    expect(withHeadline.filter((r) => r.headline!.figureId).length).toBeGreaterThanOrEqual(5);
  });

  it("approving a staged bill posts it", () => {
    const item = office.desk().items.find((i) => i.kind === "ledger_entry")!;
    const billId = (item.payload as { billId: string }).billId;
    office.decide(item.id, { action: "approve" }, "Anil Kulkarni");
    expect(office.books.bills.find((b) => b.id === billId)!.status).toBe("posted");
    expect(office.desk().items.find((i) => i.id === item.id)).toBeUndefined();
  });

  it("dispatch serves every route and enforces roles", () => {
    const owner = { role: "owner" as const, user: { name: "Anil Kulkarni", email: "a@x" }, mode: "mock" as const };
    const get = (path: string, role = owner) => dispatch(office, { method: "GET", path, query: new URLSearchParams(), ...role });
    for (const p of ["/api/session", "/api/office", "/api/desk", "/api/reports/sales", "/api/reports/ageing", "/api/reports/gst", "/api/reports/tds", "/api/reports/cash", "/api/reports/sales-team", "/api/reports/marketing", "/api/reports/social", "/api/reports/operations", "/api/reports/people", "/api/audit", "/api/documents", "/api/hiring", "/api/settings", "/api/agents/accountant", "/api/trace/ageing%3Atotal", "/api/parties/C01", "/api/exports/gstr1/2026-10"])
      expect(get(p).status, p).toBe(200);
    expect(get("/api/parties/NOPE").status).toBe(404);
    const reminder = office.desk().items.find((i) => i.kind === "reminder")!;
    const asAccountant = { ...owner, role: "accountant" as const };
    expect(dispatch(office, { method: "POST", path: `/api/desk/${reminder.id}`, query: new URLSearchParams(), body: { action: "approve" }, ...asAccountant }).status).toBe(403);
    expect(dispatch(office, { method: "POST", path: `/api/desk/${reminder.id}`, query: new URLSearchParams(), body: { action: "approve" }, ...owner }).status).toBe(200);
  });

  it("answers questions with traceable figures", () => {
    const a = office.ask("Who owes me the most?");
    expect(a.answer.some((s) => "figureId" in s)).toBe(true);
  });
});
