import type { ColumnMapping, Payout, SalesChannel, SalesField, SalesLine, SalesLineStatus, Sku } from "@office/contracts";
import { addDays } from "../dates";
import { columnFor, type Format, statusWord } from "./formats";
import { dateOf, norm, numberOf, paiseOf, stateOf } from "./parse";

export type ReadResult = {
  lines: Omit<SalesLine, "importId">[];
  skipped: { row: number; reason: string }[];
  period: { from: string; to: string } | null;
  /** Rows that are fees, transfers and the like, counted in the payout read from the same sheet. */
  inPayout?: number;
};
/** A payout as a reader finds it, before it is given its id and import. */
export type PayoutDraft = Omit<Payout, "id" | "importId">;

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
  const added = (f: "gross" | "taxable") => (opts.mapping ? [] : columnsFor(headers, opts.format?.add?.[f]));
  const plus = { gross: added("gross"), taxable: added("taxable") };
  const match = skuMatcher(opts.skus);
  let inPayout = 0;
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
    if (opts.format?.status && c.status >= 0) {
      const mapped = opts.format.status[(at(c.status) ?? "").toLowerCase()];
      if (!mapped && opts.format.rest === "payout") {
        inPayout++;
        continue;
      }
      status = mapped ?? "skip";
    }
    else if (opts.format?.statusFromName) status = opts.format.statusFromName(opts.file);
    else if (c.status >= 0) status = statusWord(at(c.status));
    if (status === "skip") {
      skipped.push({ row: rowNo, reason: `"${at(c.status) ?? ""}" is not a sale, return or cancellation.` });
      continue;
    }
    const date = dateOf(at(c.date));
    const order = at(c.order);
    const qty = numberOf(at(c.qty));
    const withAdded = (f: "gross" | "taxable") => {
      const own = paiseOf(at(c[f]));
      return own === null ? null : plus[f].reduce((a, i) => a + (paiseOf(at(i)) ?? 0), own);
    };
    const gross = withAdded("gross");
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
    // Marketplace titles run on after a "|" with selling points; the name is what comes before.
    const item = at(c.item)?.split(" | ")[0]?.trim() || null;
    const abs = (p: number | null) => (p === null ? null : Math.abs(p));
    const base = [opts.channel, order, at(c.invoice) ?? "", sellerSku ?? item ?? "", status, date, abs(gross) ?? 0].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const taxable = abs(withAdded("taxable"));
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
  return { lines, skipped, period: from && to ? { from, to } : null, inPayout };
}

/** Every column named by any of the aliases, each once. */
function columnsFor(headers: string[], aliases: string[] | undefined): number[] {
  return [...new Set((aliases ?? []).map((a) => columnFor(headers, [a])).filter((i) => i >= 0))];
}

const byAmount = (parts: Map<string, number>) =>
  [...parts]
    .filter(([, paise]) => paise !== 0)
    .map(([label, paise]) => ({ label, paise }))
    .sort((a, b) => Math.abs(b.paise) - Math.abs(a.paise));

/** An Amazon settlement report: what was paid and when, grouped the way Amazon groups it. */
export function readAmazonSettlement(rows: string[][], headerAt: number): PayoutDraft | null {
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

/**
 * The money side of Amazon's transaction report: the period's sales and refunds with GST, each
 * kind of fee, the TCS and 194-O TDS Amazon withheld, and the transfers to the seller's bank. The
 * payout is what was transferred; what the period earned but Amazon still holds is shown as a part.
 */
export function readAmazonTransactions(rows: string[][], headerAt: number): PayoutDraft | null {
  const h = rows[headerAt]!.map(norm);
  const col = (name: string) => {
    const exact = h.indexOf(name);
    return exact >= 0 ? exact : h.findIndex((x) => x.startsWith(`${name} `));
  };
  const c = {
    date: col("date time"),
    type: col("type"),
    desc: col("description"),
    total: col("total"),
    principal: ["product sales", "shipping credits", "gift wrap credits", "promotional rebates", "total sales tax liable"].map(col).filter((i) => i >= 0),
    tcs: ["tcs cgst", "tcs sgst", "tcs igst"].map(col).filter((i) => i >= 0),
    tds: col("tds"),
    selling: col("selling fees"),
    fba: col("fba fees"),
    otherFees: col("other transaction fees"),
    other: col("other"),
  };
  if (c.type < 0 || c.total < 0) return null;
  const parts = new Map<string, number>();
  const put = (label: string, paise: number) => paise && parts.set(label, (parts.get(label) ?? 0) + paise);
  let paid = 0;
  let transfers = 0;
  let paidOn: string | null = null;
  let movement = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows.slice(headerAt + 1)) {
    const type = (r[c.type] ?? "").trim();
    if (!type) continue;
    const t = type.toLowerCase();
    const v = (i: number) => (i >= 0 ? (paiseOf(r[i]) ?? 0) : 0);
    const date = dateOf(r[c.date]);
    if (date && (!from || date < from)) from = date;
    if (date && (!to || date > to)) to = date;
    const total = v(c.total);
    movement += total;
    if (t === "transfer") {
      paid -= total;
      transfers++;
      if (date && (!paidOn || date > paidOn)) paidOn = date;
    } else if (t === "order" || t === "refund") {
      put(t === "order" ? "Sales, with GST" : "Refunds, with GST", c.principal.reduce((a, i) => a + v(i), 0));
      put("Tax withheld: TCS", c.tcs.reduce((a, i) => a + v(i), 0));
      put("Tax withheld: TDS (194-O)", v(c.tds));
      put("Fees: selling", v(c.selling));
      put("Fees: FBA", v(c.fba));
      put("Fees: other transaction fees", v(c.otherFees));
      put("Other", v(c.other));
    } else {
      const desc = (r[c.desc] ?? "").trim();
      const label = t.startsWith("shipping") ? "Fees: shipping" : t.startsWith("fba") ? "Fees: FBA" : t === "service fee" ? (/advertis/i.test(desc) ? "Advertising" : `Fees: ${desc.toLowerCase() || "service"}`) : t.startsWith("reimburse") ? "Reimbursements" : t.startsWith("adjust") ? "Adjustments" : type;
      put(label, total);
    }
  }
  if (!parts.size && !transfers) return null;
  // What the period earned less what was transferred: still with Amazon (or, if negative, paid from an earlier balance).
  if (transfers) put(movement >= 0 ? "Kept by Amazon for later payouts" : "Paid from an earlier balance", -movement);
  return { channel: "amazon", from, to, paidOn, parts: byAmount(parts), netPaise: transfers ? paid : movement };
}

/**
 * Myntra's monthly P&L workbook. It gives totals by SKU, not orders, so each SKU becomes one sold
 * line and one returned line on the last day of the month, with no order number. The month is
 * read from the summary sheet ("Orders Received During: October 2026").
 */
export function readMyntraPnl(opts: { rows: string[][]; headerAt: number; sheets: { rows: string[][] }[]; skus: Sku[] }): ReadResult & { payout: PayoutDraft | null; settled: number | null } {
  const empty = (reason: string) => ({ lines: [], skipped: [{ row: opts.headerAt + 1, reason }], period: null, payout: null, settled: null });
  let month: { from: string; to: string } | null = null;
  for (const s of opts.sheets)
    for (const r of s.rows.slice(0, 30)) {
      if (!norm(r[0] ?? "").startsWith("orders received during")) continue;
      const m = /([a-z]{3,9})\s+(\d{4})/i.exec(r.slice(1).join(" "));
      const from = m ? dateOf(`1 ${m[1]} ${m[2]}`) : null;
      if (from) month = { from, to: addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1) };
    }
  if (!month) return empty("The report does not say which month it covers.");
  const h = opts.rows[opts.headerAt]!.map(norm);
  const col = (name: string) => h.indexOf(name);
  const need = ["sku code", "grosssalesamount", "grosssalesunit", "returnsandcancellationsamount", "returnsandcancellationsunit"];
  const missing = need.find((n) => col(n) < 0);
  if (missing) return empty(`The column "${missing}" is missing.`);
  const match = skuMatcher(opts.skus);
  const lines: ReadResult["lines"] = [];
  const skipped: ReadResult["skipped"] = [];
  const sums = new Map<string, number>();
  const date = month.to;
  for (let r = opts.headerAt + 1; r < opts.rows.length; r++) {
    const row = opts.rows[r]!;
    const at = (name: string) => (col(name) >= 0 ? row[col(name)]?.trim() || undefined : undefined);
    const sku = at("sku code");
    if (!row.some((x) => x.trim())) continue;
    if (!sku) {
      skipped.push({ row: r + 1, reason: "No SKU code." });
      continue;
    }
    for (const [i, name] of h.entries()) if (name) sums.set(name, (sums.get(name) ?? 0) + (paiseOf(row[i]) ?? 0));
    const item = [at("brand name"), at("article type")].filter(Boolean).join(" ") || null;
    const named = item ? `${item} (${sku})` : sku;
    const base = { channel: "myntra" as const, date, order: "", invoice: null, sellerSku: sku, skuId: match(sku, item), item: named, taxablePaise: null, taxPaise: null, discountPaise: null, state: null, city: null };
    const units = numberOf(at("grosssalesunit")) ?? 0;
    const gross = paiseOf(at("grosssalesamount")) ?? 0;
    if (units || gross) lines.push({ ...base, id: `myntra|${month.from}|${sku}|sold`, qty: Math.abs(units), grossPaise: Math.abs(gross), status: "sold", row: r + 1 });
    const backUnits = numberOf(at("returnsandcancellationsunit")) ?? 0;
    const back = paiseOf(at("returnsandcancellationsamount")) ?? 0;
    if (backUnits || back) lines.push({ ...base, id: `myntra|${month.from}|${sku}|returned`, qty: Math.abs(backUnits), grossPaise: Math.abs(back), status: "returned", row: r + 1 });
  }
  const sum = (name: string) => sums.get(name) ?? 0;
  const parts = new Map<string, number>([
    ["Sales", sum("grosssalesamount")],
    ["Returns and cancellations", -Math.abs(sum("returnsandcancellationsamount"))],
    ["Fees: commission", -sum("fwdcommissionfee") + sum("revcommissionfee")],
    ["Fees: logistics", -sum("fwdlogisticcharge")],
    ["Fees: return logistics", -sum("revlogisticcharge")],
    ["Fees: additional charges", -sum("fwdadditionalcharges") + sum("revadditionalcharges")],
    ["Tax withheld: TCS", -sum("fwdtaxestcs") + sum("revtaxestcs")],
    ["Tax withheld: TDS (194-O)", -sum("fwdtaxestds") + sum("revtaxestds")],
    ["Rewards and incentives", sum("rewardsandbenefits")],
    ["Non-order deductions", sum("nodpaidamount") - sum("noddeductedamount")],
  ]);
  const projected = sums.has("banksettlement projected") ? sum("banksettlement projected") : [...parts.values()].reduce((a, b) => a + b, 0);
  const payout: PayoutDraft = { channel: "myntra", from: month.from, to: month.to, paidOn: null, parts: byAmount(parts), netPaise: projected };
  return { lines, skipped, period: lines.length ? { from: date, to: date } : null, payout, settled: sums.has("banksettlement settled") ? sum("banksettlement settled") : null };
}
