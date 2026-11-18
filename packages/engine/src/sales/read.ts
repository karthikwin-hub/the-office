import type { ColumnMapping, Payout, SalesChannel, SalesField, SalesLine, SalesLineStatus, Sku } from "@office/contracts";
import { columnFor, type Format, statusWord } from "./formats";
import { dateOf, norm, numberOf, paiseOf, stateOf } from "./parse";

export type ReadResult = { lines: Omit<SalesLine, "importId">[]; skipped: { row: number; reason: string }[]; period: { from: string; to: string } | null };

const skuKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The office's SKU for a platform's SKU: by its code, then by its name. */
export function skuMatcher(skus: Sku[]): (sellerSku: string | null, item: string | null) => string | null {
  const byId = new Map(skus.map((s) => [skuKey(s.id), s.id]));
  const byName = new Map(skus.map((s) => [skuKey(s.name), s.id]));
  return (sellerSku, item) => (sellerSku && (byId.get(skuKey(sellerSku)) ?? byName.get(skuKey(sellerSku)))) || (item && byName.get(skuKey(item))) || null;
}

/**
 * The lines in a sheet, read by a known layout or the owner's mapping. Every row either becomes a
 * line or is listed with why it was left out: no row is guessed at.
 */
export function readLines(opts: { rows: string[][]; headerAt: number; channel: SalesChannel; file: string; format: Format | null; mapping?: ColumnMapping; skus: Sku[] }): ReadResult {
  const headers = opts.rows[opts.headerAt] ?? [];
  const col = (f: SalesField): number => {
    if (opts.mapping) {
      const h = opts.mapping[f];
      return h ? headers.findIndex((x) => norm(x) === norm(h)) : -1;
    }
    return columnFor(headers, opts.format?.fields[f]);
  };
  const c = Object.fromEntries((["date", "order", "invoice", "qty", "gross", "taxable", "tax", "discount", "sku", "item", "state", "city", "status"] as SalesField[]).map((f) => [f, col(f)])) as Record<SalesField, number>;
  const match = skuMatcher(opts.skus);
  const lines: ReadResult["lines"] = [];
  const skipped: ReadResult["skipped"] = [];
  const seen = new Map<string, number>();
  let from: string | null = null;
  let to: string | null = null;

  for (let r = opts.headerAt + 1; r < opts.rows.length; r++) {
    const row = opts.rows[r]!;
    const at = (i: number) => (i >= 0 ? row[i]?.trim() || undefined : undefined);
    const rowNo = r + 1;
    if (!row.some((x) => x.trim())) continue;
    // Totals and notes at the end of a sheet are not sales.
    if (/^(grand )?total|^sum\b/i.test(row.find((x) => x.trim()) ?? "") && !at(c.order)) continue;

    let status: SalesLineStatus | "skip" = "sold";
    if (opts.format?.status && c.status >= 0) status = opts.format.status[(at(c.status) ?? "").toLowerCase()] ?? "skip";
    else if (opts.format?.statusFromName) status = opts.format.statusFromName(opts.file);
    else if (c.status >= 0) status = statusWord(at(c.status));
    if (status === "skip") {
      skipped.push({ row: rowNo, reason: `"${at(c.status) ?? ""}" is not a sale, return or cancellation.` });
      continue;
    }
    const date = dateOf(at(c.date));
    const order = at(c.order);
    const qty = numberOf(at(c.qty));
    const gross = paiseOf(at(c.gross));
    if (!date) {
      skipped.push({ row: rowNo, reason: at(c.date) ? `The date "${at(c.date)}" could not be read.` : "No date." });
      continue;
    }
    if (!order) {
      skipped.push({ row: rowNo, reason: "No order number." });
      continue;
    }
    if (qty === null && status !== "cancelled") {
      skipped.push({ row: rowNo, reason: "No quantity." });
      continue;
    }
    if (gross === null && status !== "cancelled") {
      skipped.push({ row: rowNo, reason: "No amount." });
      continue;
    }
    const sellerSku = at(c.sku) ?? null;
    const item = at(c.item) ?? null;
    const abs = (p: number | null) => (p === null ? null : Math.abs(p));
    const base = [opts.channel, order, at(c.invoice) ?? "", sellerSku ?? item ?? "", status, date, abs(gross) ?? 0].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const taxable = abs(paiseOf(at(c.taxable)));
    let tax = abs(paiseOf(at(c.tax)));
    if (tax === null && taxable !== null && gross !== null) tax = Math.max(0, Math.abs(gross) - taxable);
    lines.push({
      id: `${base}|${n}`,
      channel: opts.channel,
      date,
      order,
      invoice: at(c.invoice) ?? null,
      sellerSku,
      skuId: match(sellerSku, item),
      item,
      qty: Math.abs(qty ?? 0),
      grossPaise: abs(gross) ?? 0,
      taxablePaise: taxable,
      taxPaise: tax,
      discountPaise: abs(paiseOf(at(c.discount))),
      state: stateOf(at(c.state)),
      city: at(c.city) ? at(c.city)!.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : null,
      status,
      row: rowNo,
    });
    if (!from || date < from) from = date;
    if (!to || date > to) to = date;
  }
  return { lines, skipped, period: from && to ? { from, to } : null };
}

/** An Amazon settlement report: what was paid and when, grouped the way Amazon groups it. */
export function readAmazonSettlement(rows: string[][], headerAt: number): Omit<Payout, "id" | "importId"> | null {
  const h = rows[headerAt]!.map(norm);
  const i = (name: string) => h.indexOf(name);
  const body = rows.slice(headerAt + 1);
  const summary = body.find((r) => r[i("total amount")]?.trim());
  const parts = new Map<string, number>();
  for (const r of body) {
    const amount = paiseOf(r[i("amount")]);
    if (amount === null) continue;
    const type = r[i("amount type")]?.trim() || "Other";
    const desc = r[i("amount description")]?.trim() || "";
    const label = type === "ItemPrice" ? (desc === "Principal" ? "Sales" : `Sales: ${desc}`) : type === "ItemFees" ? `Fees: ${desc}` : type === "ItemWithheldTax" ? `Tax withheld: ${desc}` : desc ? `${type}: ${desc}` : type;
    parts.set(label, (parts.get(label) ?? 0) + amount);
  }
  if (!summary && !parts.size) return null;
  const net = summary ? (paiseOf(summary[i("total amount")]) ?? 0) : [...parts.values()].reduce((a, b) => a + b, 0);
  return {
    channel: "amazon",
    from: summary ? dateOf(summary[i("settlement start date")]) : null,
    to: summary ? dateOf(summary[i("settlement end date")]) : null,
    paidOn: summary && i("deposit date") >= 0 ? dateOf(summary[i("deposit date")]) : null,
    parts: [...parts].map(([label, paise]) => ({ label, paise })).sort((a, b) => Math.abs(b.paise) - Math.abs(a.paise)),
    netPaise: net,
  };
}
