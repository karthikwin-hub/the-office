import { readFileSync } from "node:fs";
import { type ImportCheck, PartiesView, type Role, ROUTES } from "@office/contracts";
import { emptyBooks, loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { ageingReport, dispatch, OfficeService } from "../src";
import { billOpenPaise } from "../src/compliance/profile";

const template = (kind: string) => readFileSync(new URL(`../../../apps/web/public/templates/${kind}.csv`, import.meta.url), "utf8");
const get = (office: OfficeService, path: string, role: Role = "owner") =>
  dispatch(office, { method: "GET", path, query: new URLSearchParams(), role, user: { name: "Anil Kaveri", email: `${role}@example.in` }, mode: "mock" });
const list = (office: OfficeService, role: Role = "owner") => {
  const res = get(office, ROUTES.parties, role);
  expect(res.status).toBe(200);
  return PartiesView.parse(res.body).parties;
};

/** A new office whose owner brought in only the parties template: customers and suppliers with nothing owed either way. */
function partiesOnly() {
  const office = new OfficeService(emptyBooks({ owner: "Anil Kaveri", asOf: "2026-11-05" }));
  const check: ImportCheck = { booksFrom: "2026-11-01", files: [{ kind: "parties", name: "parties.csv", csv: template("parties") }] };
  const { item } = office.stageOnboarding(check, "Anil Kaveri");
  office.decide(item!.id, { action: "approve" }, "Anil Kaveri");
  return office;
}

describe("the list of customers and suppliers", () => {
  it("lists parties brought in with no sales, bills or balance", () => {
    const office = partiesOnly();
    const rows = list(office);
    expect(rows).toHaveLength(office.books.parties.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["customer", "vendor"]));
    expect(rows.every((r) => r.owedPaise === 0)).toBe(true);
    for (const r of rows) {
      const p = office.books.parties.find((x) => x.id === r.id)!;
      expect(r).toMatchObject({ name: p.name, gstin: p.gstin, stateCode: p.stateCode, city: p.city, state: office.ledger.stateName(p.stateCode) });
    }
    // Each row opens the party's page.
    for (const r of rows) expect(get(office, ROUTES.party(r.id)).status).toBe(200);
  });

  it("shows what each customer owes and what is owed to each supplier", () => {
    const office = new OfficeService(loadBooks());
    const rows = list(office);
    expect(rows).toHaveLength(office.books.parties.length);
    const owes = new Map(ageingReport(office.ledger).rows.map((r) => [r.partyId, r.totalPaise]));
    for (const r of rows.filter((x) => x.kind === "customer")) expect(r.owedPaise, r.name).toBe(owes.get(r.id) ?? 0);
    for (const r of rows.filter((x) => x.kind === "vendor")) {
      const bills = office.ledger.payableBills.filter((b) => b.partyId === r.id);
      expect(r.owedPaise, r.name).toBe(bills.reduce((a, b) => a + billOpenPaise(office.ledger, b), 0));
      expect(r.tdsSection).toBe(office.books.parties.find((p) => p.id === r.id)!.tdsSection ?? null);
    }
    expect(rows.some((r) => r.kind === "vendor" && r.tdsSection)).toBe(true);
    // Sorted by name, so a party is found where it is expected.
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b, "en-IN")));
  });

  it("is read by the accountant as well as the owner, and changes nothing", () => {
    const office = new OfficeService(loadBooks());
    const before = JSON.stringify(office.books.parties);
    expect(list(office, "accountant")).toEqual(list(office, "owner"));
    expect(JSON.stringify(office.books.parties)).toBe(before);
    expect(
      dispatch(office, {
        method: "POST",
        path: ROUTES.parties,
        query: new URLSearchParams(),
        body: {},
        role: "owner",
        user: { name: "A", email: "a@example.in" },
        mode: "mock",
      }).status,
    ).toBe(404);
  });
});
