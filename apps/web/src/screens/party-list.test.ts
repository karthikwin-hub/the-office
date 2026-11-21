import type { PartyRow } from "@office/contracts";
import { describe, expect, it } from "vitest";
import { filterParties, partyCounts } from "./party-list";

const row = (r: Partial<PartyRow> & Pick<PartyRow, "id" | "name" | "kind">): PartyRow => ({
  gstin: null,
  stateCode: "29",
  state: "Karnataka",
  city: "Bengaluru",
  tdsSection: null,
  owedPaise: 0,
  ...r,
});

const rows = [
  row({ id: "C01", name: "Sharada Builders Pvt Ltd", kind: "customer", gstin: "29AABCS1234K1ZC" }),
  row({ id: "C02", name: "Ravi Kumar", kind: "customer", city: "Mysuru" }),
  row({ id: "V01", name: "Sahyadri Cables Pvt Ltd", kind: "vendor", stateCode: "27", state: "Maharashtra", city: "Pune", tdsSection: "194Q" }),
];
const ids = (r: PartyRow[]) => r.map((x) => x.id);

describe("finding a customer or supplier", () => {
  it("shows everyone until a kind is chosen or something is typed", () => {
    expect(ids(filterParties(rows, "all", ""))).toEqual(["C01", "C02", "V01"]);
    expect(ids(filterParties(rows, "all", "   "))).toEqual(["C01", "C02", "V01"]);
  });

  it("keeps to customers or to suppliers", () => {
    expect(ids(filterParties(rows, "customer", ""))).toEqual(["C01", "C02"]);
    expect(ids(filterParties(rows, "vendor", ""))).toEqual(["V01"]);
  });

  it("searches name, GSTIN, city and state, in any case", () => {
    expect(ids(filterParties(rows, "all", "pvt"))).toEqual(["C01", "V01"]);
    expect(ids(filterParties(rows, "all", "29aabcs"))).toEqual(["C01"]);
    expect(ids(filterParties(rows, "all", "mysuru"))).toEqual(["C02"]);
    expect(ids(filterParties(rows, "all", "Maharashtra"))).toEqual(["V01"]);
    expect(ids(filterParties(rows, "customer", "sahyadri"))).toEqual([]);
  });

  it("counts each kind for the filter's labels", () => {
    expect(partyCounts(rows)).toEqual({ all: 3, customer: 2, vendor: 1 });
  });
});
