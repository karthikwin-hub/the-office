import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useMemo, useState, type ReactNode } from "react";

export type LedgerColumn<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting; columns without one are not sortable. */
  sortBy?: (row: T) => number | string;
  numeric?: boolean;
  footer?: ReactNode;
  /** Hidden below 640px wide. */
  secondary?: boolean;
};

type Props<T> = {
  rows: T[];
  columns: LedgerColumn<T>[];
  rowKey: (row: T) => string;
  caption: string;
  /** Show the caption to sighted users too. */
  showCaption?: boolean;
  initialSort?: { id: string; desc?: boolean };
  empty?: ReactNode;
  rowTone?: (row: T) => "red" | "green" | undefined;
  limit?: number;
};

/** A ruled ledger: graphite head rule, soft rules between rows, totals under a double rule. */
export function LedgerTable<T>({ rows, columns, rowKey, caption, showCaption, initialSort, empty, rowTone, limit }: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []);
  const [expanded, setExpanded] = useState(false);
  const defs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        header: c.header,
        accessorFn: c.sortBy ?? (() => 0),
        enableSorting: Boolean(c.sortBy),
        sortDescFirst: c.numeric,
        cell: (ctx) => c.cell(ctx.row.original),
        meta: c,
      })),
    [columns],
  );
  const table = useReactTable({ data: rows, columns: defs, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getRowId: (r) => rowKey(r) });
  const hasFooter = columns.some((c) => c.footer !== undefined);
  const all = table.getRowModel().rows;
  const shown = limit && !expanded ? all.slice(0, limit) : all;

  if (rows.length === 0 && empty) return <div className="ledger-empty">{empty}</div>;

  return (
    <div className="ledger-wrap">
      <table className="ledger">
        <caption className={showCaption ? "ledger-caption" : "visually-hidden"}>{caption}</caption>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const c = h.column.columnDef.meta as LedgerColumn<T>;
                const sorted = h.column.getIsSorted();
                return (
                  <th key={h.id} scope="col" className={`${c.numeric ? "num" : ""}${c.secondary ? " secondary" : ""}`} aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : h.column.getCanSort() ? "none" : undefined}>
                    {h.column.getCanSort() ? (
                      <button type="button" onClick={h.column.getToggleSortingHandler()}>
                        {c.header}
                        <span className="sort-mark" aria-hidden="true">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {shown.map((r) => {
            const tone = rowTone?.(r.original);
            return (
              <tr key={r.id} className={tone ? `row-${tone}` : undefined}>
                {r.getVisibleCells().map((cell) => {
                  const c = cell.column.columnDef.meta as LedgerColumn<T>;
                  return (
                    <td key={cell.id} className={`${c.numeric ? "num" : ""}${c.secondary ? " secondary" : ""}`}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {hasFooter ? (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.id} className={`${c.numeric ? "num" : ""}${c.secondary ? " secondary" : ""}`}>
                  {c.footer}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {limit && all.length > limit ? (
        <button type="button" className="btn btn-quiet ledger-more" onClick={() => setExpanded((x) => !x)}>
          {expanded ? `Show first ${limit}` : `Show all ${all.length}`}
        </button>
      ) : null}
    </div>
  );
}
