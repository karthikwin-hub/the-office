import {
  AgeingReport,
  AgentRoomView,
  AGENTS,
  AuditReport,
  CashReport,
  DeskView,
  GstReport,
  HiringView,
  MarketingReport,
  OfficeView,
  OperationsReport,
  PeopleReport,
  ROUTES,
  SalesReport,
  SalesTeamReport,
  Settings,
  SocialReport,
  TdsReport,
} from "@office/contracts";
import { emptyBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { dispatch, OfficeService, type ApiRequest } from "../src";

const asOf = "2026-11-05";
const fresh = () => new OfficeService(emptyBooks({ owner: "Nisha Rao", email: "nisha@example.in", asOf }), { asOf, ingestEmail: "bills@example.in" });
const call = (office: OfficeService, path: string, method = "GET", body?: unknown) => {
  const [p, qs] = path.split("?");
  const req: ApiRequest = { method, path: p!, query: new URLSearchParams(qs), body, role: "owner", user: { name: "Nisha Rao", email: "nisha@example.in" }, mode: "live" };
  return dispatch(office, req);
};

describe("a new, empty office", () => {
  const office = fresh();

  it("starts with the owner's name and only the Office Manager and the Accountant hired", () => {
    expect(office.books.business.owner).toBe("Nisha Rao");
    expect(office.books.business.fyStart).toBe("2026-04-01");
    expect(office.books.agents.filter((a) => a.hired).map((a) => a.agentId)).toEqual(["office-manager", "accountant"]);
    expect(office.books.invoices).toEqual([]);
    expect(office.books.channels.every((c) => c.mode === "manual")).toBe(true);
  });

  const reads: [string, { parse: (x: unknown) => unknown }][] = [
    [ROUTES.office, OfficeView],
    [ROUTES.desk, DeskView],
    [ROUTES.sales, SalesReport],
    [ROUTES.ageing, AgeingReport],
    [ROUTES.gst, GstReport],
    [ROUTES.tds, TdsReport],
    [ROUTES.cash, CashReport],
    [ROUTES.salesTeam, SalesTeamReport],
    [ROUTES.marketing, MarketingReport],
    [ROUTES.social, SocialReport],
    [ROUTES.operations, OperationsReport],
    [ROUTES.people, PeopleReport],
    [ROUTES.audit, AuditReport],
    [ROUTES.hiring, HiringView],
    [ROUTES.settings, Settings],
  ];
  for (const [path, schema] of reads)
    it(`${path} answers and satisfies its contract`, () => {
      const res = call(office, path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      schema.parse(res.body);
    });

  it("every agent's room opens, hired or not", () => {
    for (const a of AGENTS) {
      const res = call(office, ROUTES.agent(a.id));
      expect(res.status, `${a.id}: ${JSON.stringify(res.body)}`).toBe(200);
      AgentRoomView.parse(res.body);
    }
  });

  it("lists, exports and questions answer without records", () => {
    for (const path of [ROUTES.documents, ROUTES.unread, ROUTES.exportGstr1("2026-10"), ROUTES.exportGstr3b("2026-10"), ROUTES.exportTds("2026-Q2")]) {
      const res = call(office, path);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
    }
    expect(call(office, ROUTES.ask, "POST", { question: "Who owes me money?" }).status).toBeLessThan(500);
  });

  it("the owner fills in the business once, and the GSTIN sets the state and PAN", () => {
    const o = fresh();
    const business = { ...o.books.business, name: "Rao Hardware", legalName: "Rao Hardware LLP", gstin: "29ABCDE1234F1Z5", address: "12 MG Road, Bengaluru", asOf: "2020-01-01" };
    const res = call(o, ROUTES.settings, "PUT", { business });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(o.books.business).toMatchObject({ name: "Rao Hardware", gstin: "29ABCDE1234F1Z5", stateCode: "29", pan: "ABCDE1234F", asOf });
    call(o, ROUTES.settings, "PUT", { business: { ...o.books.business, gstin: "27ABCDE1234F1Z5" } });
    expect(o.books.business.gstin).toBe("29ABCDE1234F1Z5");
  });

  it("hiring the rest of the team keeps every room working", () => {
    const o = fresh();
    for (const a of AGENTS) if (a.id !== "office-manager" && a.id !== "accountant") expect(call(o, ROUTES.hire(a.id), "POST", { hired: true }).status).toBe(200);
    OfficeView.parse(o.officeView());
    for (const a of AGENTS) AgentRoomView.parse(o.agentRoom(a.id));
    o.runTrusted();
    o.publishDue(`${asOf}T09:00:00.000Z`);
    o.draftCalendar("2026-12");
    expect(call(o, ROUTES.social).status).toBe(200);
    DeskView.parse(o.desk());
  });
});
