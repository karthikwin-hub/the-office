import { CHANNEL_NAME, type OnlineSalesReport, type Payout, SALES_CHANNELS, type SalesChannel, type SalesImport, type SalesLine, type Sku } from "@office/contracts";
import { addDays, daysBetween, weekStart } from "../dates";
import { inrShort } from "../money";
import { STATE_NAME } from "./parse";

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);
const label = (from: string, to: string) => {
  const f = (d: string, year: boolean) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `${f(from, from.slice(0, 4) !== to.slice(0, 4))} to ${f(to, true)}`;
};

type Sums = { orders: Set<string>; units: number; gross: number; returned: number; returnedUnits: number; cancelled: Set<string>; last: string | null };
const sums = (): Sums => ({ orders: new Set(), units: 0, gross: 0, returned: 0, returnedUnits: 0, cancelled: new Set(), last: null });
function add(s: Sums, l: SalesLine) {
  if (l.status === "sold") {
    s.orders.add(`${l.channel}|${l.order}`);
    s.units += l.qty;
    s.gross += l.grossPaise;
  } else if (l.status === "returned") {
    s.returned += l.grossPaise;
    s.returnedUnits += l.qty;
  } else s.cancelled.add(`${l.channel}|${l.order}`);
  if (!s.last || l.date > s.last) s.last = l.date;
}

/**
 * Online sales over a period, against the same length of time before it. Sales are what the
 * platforms reported as shipped or sold; returns are counted on the day the platform reported them.
 */
export function onlineSalesReport(opts: { lines: SalesLine[]; previous: SalesLine[]; from: string; to: string; skus: Sku[]; payouts: Payout[]; imports: SalesImport[]; address: string | null }): OnlineSalesReport {
  const { lines, from, to } = opts;
  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const total = sums();
  const prevTotal = sums();
  const byChannel = new Map<SalesChannel, Sums>();
  const prevByChannel = new Map<SalesChannel, Sums>();
  for (const l of lines) {
    add(total, l);
    if (!byChannel.has(l.channel)) byChannel.set(l.channel, sums());
    add(byChannel.get(l.channel)!, l);
  }
  for (const l of opts.previous) {
    add(prevTotal, l);
    if (!prevByChannel.has(l.channel)) prevByChannel.set(l.channel, sums());
    add(prevByChannel.get(l.channel)!, l);
  }
  const kindOf = (c: SalesChannel) => SALES_CHANNELS.find((x) => x.id === c)?.kind ?? "marketplace";
  const channels = [...byChannel]
    .map(([channel, s]) => ({
      channel,
      name: CHANNEL_NAME[channel],
      kind: kindOf(channel),
      orders: s.orders.size,
      units: s.units,
      grossPaise: s.gross,
      returnedPaise: s.returned,
      returnsPct: pct(s.returned, s.gross),
      cancelled: s.cancelled.size,
      aovPaise: s.orders.size ? Math.round(s.gross / s.orders.size) : 0,
      vsPreviousPct: change(s.gross, prevByChannel.get(channel)?.gross ?? 0),
      lastDate: s.last,
    }))
    .sort((a, b) => b.grossPaise - a.grossPaise);

  // Eight weeks up to the end of the period, Monday first.
  const lastWeek = weekStart(to);
  const weekKeys = Array.from({ length: 8 }, (_, i) => addDays(lastWeek, -7 * (7 - i)));
  const weekMap = new Map(weekKeys.map((w) => [w, {} as Record<string, number>]));
  for (const l of [...opts.previous, ...lines]) {
    if (l.status !== "sold") continue;
    const w = weekMap.get(weekStart(l.date));
    if (w) w[l.channel] = (w[l.channel] ?? 0) + l.grossPaise;
  }
  const weeks = weekKeys.map((week) => {
    const byC = weekMap.get(week)!;
    return { week, label: new Date(`${week}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }), byChannel: byC, totalPaise: Object.values(byC).reduce((a, b) => a + b, 0) };
  });

  const skuName = new Map(opts.skus.map((s) => [s.id, s.name]));
  const bySku = new Map<string, { skuId: string | null; name: string; units: number; gross: number; returnedUnits: number; channels: Set<SalesChannel> }>();
  for (const l of lines) {
    const key = l.skuId ?? (l.sellerSku || l.item || "Unnamed item").toLowerCase();
    const cur = bySku.get(key) ?? { skuId: l.skuId, name: (l.skuId && skuName.get(l.skuId)) || l.item || l.sellerSku || "Unnamed item", units: 0, gross: 0, returnedUnits: 0, channels: new Set() };
    if (l.status === "sold") {
      cur.units += l.qty;
      cur.gross += l.grossPaise;
    } else if (l.status === "returned") cur.returnedUnits += l.qty;
    cur.channels.add(l.channel);
    bySku.set(key, cur);
  }
  const skus = [...bySku].map(([key, s]) => ({ key, skuId: s.skuId, name: s.name, units: s.units, grossPaise: s.gross, returnedUnits: s.returnedUnits, returnsPct: pct(s.returnedUnits, s.units), channels: [...s.channels] })).sort((a, b) => b.grossPaise - a.grossPaise);
  const soldIds = new Set(skus.map((s) => s.skuId).filter(Boolean));
  const unsold = soldIds.size ? opts.skus.filter((s) => !soldIds.has(s.id)).map((s) => ({ skuId: s.id, name: s.name })).slice(0, 20) : [];

  const byState = new Map<string, { orders: Set<string>; gross: number }>();
  const byCity = new Map<string, { orders: Set<string>; gross: number }>();
  for (const l of lines) {
    if (l.status !== "sold") continue;
    for (const [map, key] of [[byState, l.state], [byCity, l.city]] as const) {
      if (!key) continue;
      const cur = map.get(key) ?? { orders: new Set<string>(), gross: 0 };
      cur.orders.add(`${l.channel}|${l.order}`);
      cur.gross += l.grossPaise;
      map.set(key, cur);
    }
  }
  const states = [...byState].map(([state, s]) => ({ state, name: STATE_NAME[state] ?? state, orders: s.orders.size, grossPaise: s.gross })).sort((a, b) => b.grossPaise - a.grossPaise);
  const cities = [...byCity].map(([city, s]) => ({ city, orders: s.orders.size, grossPaise: s.gross })).sort((a, b) => b.grossPaise - a.grossPaise).slice(0, 15);

  const totals = {
    orders: total.orders.size,
    units: total.units,
    grossPaise: total.gross,
    returnedPaise: total.returned,
    returnsPct: pct(total.returned, total.gross),
    aovPaise: total.orders.size ? Math.round(total.gross / total.orders.size) : 0,
    vsPreviousPct: change(total.gross, prevTotal.gross),
  };
  const top = channels[0];
  const note = !lines.length
    ? opts.imports.length
      ? "No online sales in this period."
      : "No sales report has come in yet. Send the reports your marketplaces email you to the address below, or upload one."
    : `${inrShort(totals.grossPaise)} online from ${channels.length === 1 ? channels[0]!.name : `${channels.length} channels`} in ${label(from, to)}, ${totals.orders.toLocaleString("en-IN")} orders${totals.vsPreviousPct !== null ? `, ${totals.vsPreviousPct >= 0 ? "up" : "down"} ${Math.abs(totals.vsPreviousPct)}% on the ${days} days before` : ""}. ${channels.length > 1 && top ? `${top.name} brought ${pct(top.grossPaise, totals.grossPaise)}%. ` : ""}Returns were ${totals.returnsPct}% of sales.`;

  return {
    period: { from, to, label: label(from, to) },
    previous: { from: prevFrom, to: prevTo },
    hasData: lines.length > 0,
    totals,
    channels,
    weeks,
    skus: skus.slice(0, 25),
    unsold,
    states,
    cities,
    payouts: opts.payouts,
    imports: opts.imports,
    address: opts.address,
    note,
  };
}
