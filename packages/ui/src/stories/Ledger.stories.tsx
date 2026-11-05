import type { Meta, StoryObj } from "@storybook/react";
import { AgeingBuckets } from "../AgeingBuckets";
import { Amount, CoveringNote, Stamp } from "../Figure";
import { LedgerTable, type LedgerColumn } from "../LedgerTable";
import { ageing, sales } from "./data";

type Sku = (typeof sales.bySku)[number];
const skuColumns: LedgerColumn<Sku>[] = [
  { id: "name", header: "SKU", cell: (r) => r.name, sortBy: (r) => r.name },
  { id: "hsn", header: "HSN", cell: (r) => r.hsn, secondary: true },
  { id: "qty", header: "Quantity", cell: (r) => r.qty.toLocaleString("en-IN"), sortBy: (r) => r.qty, numeric: true, secondary: true },
  { id: "taxable", header: "Taxable value", cell: (r) => <Amount paise={r.taxablePaise} figureId={r.figureId} />, sortBy: (r) => r.taxablePaise, numeric: true, footer: <Amount paise={sales.bySku.reduce((a, r) => a + r.taxablePaise, 0)} /> },
];

const meta: Meta = { title: "Boardroom/Ledger" };
export default meta;

export const SalesBySku: StoryObj = {
  render: () => <LedgerTable caption="Sales by SKU" showCaption rows={sales.bySku} columns={skuColumns} rowKey={(r) => r.skuId} initialSort={{ id: "taxable", desc: true }} limit={12} />,
};

export const Empty: StoryObj = {
  render: () => <LedgerTable caption="Sales by SKU" showCaption rows={[]} columns={skuColumns} rowKey={(r) => r.skuId} empty={<p>No sales in this period. Choose an earlier month.</p>} />,
};

type Row = (typeof ageing.rows)[number];
export const AgeingByCustomer: StoryObj = {
  render: () => (
    <LedgerTable<Row>
      caption="Who owes what"
      showCaption
      rows={ageing.rows}
      rowKey={(r) => r.partyId}
      rowTone={(r) => (r.buckets[4]! > 0 ? "red" : undefined)}
      columns={[
        { id: "name", header: "Customer", cell: (r) => r.name, sortBy: (r) => r.name },
        ...[0, 1, 2, 3, 4].map((i) => ({ id: `b${i}`, header: ["Not due", "1–30", "31–60", "61–90", "90+"][i]!, cell: (r: Row) => (r.buckets[i] ? <Amount paise={r.buckets[i]!} rupees /> : ""), sortBy: (r: Row) => r.buckets[i]!, numeric: true, secondary: i < 3 })),
        { id: "total", header: "Total", cell: (r) => <Amount paise={r.totalPaise} figureId={r.figureId} rupees />, sortBy: (r) => r.totalPaise, numeric: true },
      ]}
      initialSort={{ id: "total", desc: true }}
    />
  ),
};

export const Buckets: StoryObj = { render: () => <AgeingBuckets totals={ageing.bucketTotals} /> };
export const BucketsAllCurrent: StoryObj = { render: () => <AgeingBuckets totals={[ageing.totalPaise, 0, 0, 0, 0]} /> };

export const Note: StoryObj = { render: () => <CoveringNote note={sales.note} from="From the Accountant" /> };

export const Stamps: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <Stamp kind="overdue" />
      <Stamp kind="mismatch" />
      <Stamp kind="paid" />
      <Stamp kind="matched" />
    </div>
  ),
};
