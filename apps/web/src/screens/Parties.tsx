import type { PartyRow } from "@office/contracts";
import { Amount, type LedgerColumn, LedgerTable } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { q } from "../api/queries";
import { Page, PageHead } from "./common";
import { filterParties, type PartyKind, partyCounts } from "./party-list";

const KIND_LABEL: Record<PartyKind, string> = { all: "All", customer: "Customers", vendor: "Suppliers" };

/** Every customer and supplier in the books, including those with nothing sold or bought yet. */
export function PartiesScreen() {
  const parties = useQuery(q.parties());
  const [kind, setKind] = useState<PartyKind>("all");
  const [search, setSearch] = useState("");
  const all = parties.data?.parties ?? [];
  const shown = filterParties(all, kind, search);
  const counts = partyCounts(all);
  const total = (k: PartyRow["kind"]) => shown.reduce((a, r) => a + (r.kind === k ? r.owedPaise : 0), 0);

  const columns: LedgerColumn<PartyRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (r) => (
        <Link to="/parties/$partyId" params={{ partyId: r.id }}>
          {r.name}
        </Link>
      ),
      sortBy: (r) => r.name.toLowerCase(),
    },
    { id: "kind", header: "Kind", cell: (r) => (r.kind === "customer" ? "Customer" : "Supplier"), sortBy: (r) => r.kind },
    { id: "gstin", header: "GSTIN", cell: (r) => (r.gstin ? <span className="code">{r.gstin}</span> : <span className="muted">None</span>), secondary: true },
    { id: "state", header: "State", cell: (r) => r.state, sortBy: (r) => r.state, secondary: true },
    { id: "city", header: "City", cell: (r) => r.city, sortBy: (r) => r.city },
  ];
  if (kind !== "vendor")
    columns.push({
      id: "owes",
      header: "Owes you",
      cell: (r) => (r.kind === "customer" ? <Amount paise={r.owedPaise} /> : null),
      sortBy: (r) => (r.kind === "customer" ? r.owedPaise : -1),
      numeric: true,
      footer: <Amount paise={total("customer")} />,
    });
  if (kind !== "customer")
    columns.push(
      {
        id: "owed",
        header: "You owe",
        cell: (r) => (r.kind === "vendor" ? <Amount paise={r.owedPaise} /> : null),
        sortBy: (r) => (r.kind === "vendor" ? r.owedPaise : -1),
        numeric: true,
        footer: <Amount paise={total("vendor")} />,
      },
      { id: "tds", header: "TDS section", cell: (r) => r.tdsSection ?? "", sortBy: (r) => r.tdsSection ?? "", secondary: true },
    );

  return (
    <Page ready={Boolean(parties.data)} error={parties.error} wide>
      <PageHead
        title="Customers and suppliers"
        lede="Everyone in your books, whether or not anything has been sold or bought yet. Open one to see their invoices, bills and payments."
      />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {(["all", "customer", "vendor"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {KIND_LABEL[k]} ({counts[k]})
            </button>
          ))}
        </div>
        <input
          className="input parties-search"
          type="search"
          placeholder="Search name, GSTIN, city, state"
          aria-label="Search customers and suppliers"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <LedgerTable
        caption={kind === "all" ? "Customers and suppliers" : KIND_LABEL[kind]}
        rows={shown}
        rowKey={(r) => r.id}
        initialSort={{ id: "name" }}
        columns={columns}
        empty={
          all.length ? (
            "No customer or supplier matches."
          ) : (
            <>
              No customers or suppliers yet. <Link to="/settings">Bring them in from your old books</Link>, or the Accountant adds them from the invoices and
              bills it reads.
            </>
          )
        }
      />
    </Page>
  );
}
