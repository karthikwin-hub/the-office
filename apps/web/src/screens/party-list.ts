import type { PartyRow } from "@office/contracts";

export type PartyKind = "all" | PartyRow["kind"];

/** The parties of one kind whose name, GSTIN, city or state contains what was typed, in any case. */
export function filterParties(rows: PartyRow[], kind: PartyKind, search: string): PartyRow[] {
  const s = search.trim().toLowerCase();
  return rows.filter((r) => (kind === "all" || r.kind === kind) && (!s || [r.name, r.gstin ?? "", r.city, r.state].some((t) => t.toLowerCase().includes(s))));
}

export function partyCounts(rows: PartyRow[]): Record<PartyKind, number> {
  return { all: rows.length, customer: rows.filter((r) => r.kind === "customer").length, vendor: rows.filter((r) => r.kind === "vendor").length };
}
