import type { MarketingReport, OperationsReport, PayrollLine, PeopleReport, Reorder, SalesTeamReport, SocialReport } from "@office/contracts";
import { ageingReport } from "./ageing";
import { addDays, daysBetween, monthLabel } from "./dates";
import type { Ledger } from "./ledger";
import { divHalfUp, inrShort, pctOf } from "./money";
import { checkPost } from "./social/checks";
import { performance } from "./social/metrics";

function soldSince(l: Ledger, days: number): Map<string, number> {
  const from = addDays(l.asOf, -days);
  const sold = new Map<string, number>();
  for (const inv of l.invoicesIn(from, l.asOf)) for (const line of inv.lines) if (line.skuId) sold.set(line.skuId, (sold.get(line.skuId) ?? 0) + line.qty);
  return sold;
}

export function reorders(l: Ledger): Reorder[] {
  const byParty = new Map<string, { date: string; total: number }[]>();
  for (const inv of l.salesInvoices) byParty.set(inv.partyId, [...(byParty.get(inv.partyId) ?? []), { date: inv.date, total: inv.totals.totalPaise }]);
  const out: Reorder[] = [];
  for (const [partyId, list] of byParty) {
    if (list.length < 3) continue;
    const dates = [...new Set(list.map((x) => x.date))].sort();
    if (dates.length < 3) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
    const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const last = dates.at(-1)!;
    const since = daysBetween(last, l.asOf);
    const typical = Math.round(list.reduce((a, x) => a + x.total, 0) / list.length);
    out.push({
      partyId,
      name: l.party(partyId).name,
      orders: list.length,
      avgIntervalDays: avg,
      lastOrderOn: last,
      daysSince: since,
      expectedOn: addDays(last, avg),
      status: since > avg * 1.4 ? "late" : since >= avg ? "due" : "ok",
      typicalPaise: typical,
    });
  }
  return out.sort((a, b) => b.daysSince / b.avgIntervalDays - a.daysSince / a.avgIntervalDays);
}

export function salesTeamReport(l: Ledger): SalesTeamReport {
  const stages = ["new", "contacted", "quoted", "won", "lost"];
  const ageing = ageingReport(l);
  const over60 = new Map(ageing.rows.map((r) => [r.partyId, r.buckets[3]! + r.buckets[4]!]));
  const quotes = l.books.quotes.map((q) => {
    const lead = q.leadId ? l.books.leads.find((x) => x.id === q.leadId) : null;
    const customer = q.partyId ? l.party(q.partyId).name : (lead?.name ?? "Unknown");
    const late = q.partyId ? (over60.get(q.partyId) ?? 0) : 0;
    return { ...q, customer, overdueWarning: late > 0 ? `${customer} has ${inrShort(late)} more than 60 days overdue.` : null };
  });
  const open = l.books.leads.filter((x) => !["won", "lost"].includes(x.stage));
  const r = reorders(l);
  const lateReorders = r.filter((x) => x.status === "late");
  return {
    note: [
      { text: `${open.length} open leads are worth ` },
      { text: inrShort(open.reduce((a, x) => a + x.valuePaise, 0)), figureId: "pipeline:open" },
      { text: `. ${quotes.filter((q) => q.status === "sent").length} quotations are with customers, and ${lateReorders.length} regular customers are late placing their usual order` },
      ...(lateReorders[0] ? [{ text: `, starting with ${lateReorders[0].name}, who usually orders every ${lateReorders[0].avgIntervalDays} days and last ordered ${lateReorders[0].daysSince} days ago.` }] : [{ text: "." }]),
    ],
    pipeline: stages.map((stage) => {
      const list = l.books.leads.filter((x) => x.stage === stage);
      return { stage, count: list.length, valuePaise: list.reduce((a, x) => a + x.valuePaise, 0) };
    }),
    leads: l.books.leads,
    quotes,
    reorders: r,
  };
}

export function marketingReport(l: Ledger): MarketingReport {
  const sold60 = soldSince(l, 60);
  const stock = new Map(l.books.stock.map((s) => [s.skuId, s]));
  const slow = l.books.skus
    .map((s) => {
      const st = stock.get(s.id);
      const sold = sold60.get(s.id) ?? 0;
      const perDay = sold / 60;
      return { skuId: s.id, name: s.name, onHand: st?.onHand ?? 0, soldLast60: sold, daysOfStock: perDay ? Math.round((st?.onHand ?? 0) / perDay) : null, stockValuePaise: (st?.onHand ?? 0) * s.costPaise };
    })
    .filter((x) => x.onHand > 0 && (x.daysOfStock === null || x.daysOfStock > 120))
    .sort((a, b) => b.stockValuePaise - a.stockValuePaise);
  const byPrice = new Map<string, { marketplace: string; seller: string; pricePaise: number }[]>();
  for (const c of l.books.competitorPrices) byPrice.set(c.skuId, [...(byPrice.get(c.skuId) ?? []), { marketplace: c.marketplace, seller: c.seller, pricePaise: c.pricePaise }]);
  const prices = [...byPrice.entries()].map(([skuId, offers]) => {
    const sku = l.sku(skuId);
    const min = Math.min(...offers.map((o) => o.pricePaise));
    return { skuId, name: sku.name, ourPricePaise: sku.pricePaise, offers: offers.sort((a, b) => a.pricePaise - b.pricePaise), gapPct: Math.round(((sku.pricePaise - min) / min) * 1000) / 10 };
  });
  const campaigns = l.books.campaigns.map((c) => ({ ...c, skuNames: c.skuIds.map((id) => l.sku(id).name), returnMultiple: c.spentPaise ? Math.round((c.attributedSalesPaise / c.spentPaise) * 10) / 10 : null }));
  const slowValue = slow.reduce((a, x) => a + x.stockValuePaise, 0);
  const pricedAbove = prices.filter((p) => p.gapPct > 5);
  return {
    note: [
      { text: `${campaigns.filter((c) => c.status === "running").length} campaigns are running. ${slow.length} SKUs have more than four months of stock, tying up ` },
      { text: inrShort(slowValue), figureId: "marketing:slow", tone: "red" },
      { text: ` at cost. On marketplaces, ${pricedAbove.length} of ${prices.length} watched SKUs are listed more than 5% below your price.` },
    ],
    campaigns,
    slowMovers: slow,
    prices: prices.sort((a, b) => b.gapPct - a.gapPct),
    calendar: l.books.festivalCalendar,
  };
}

export function socialReport(l: Ledger): SocialReport {
  const reviews = l.books.socialInbox.filter((m) => m.rating !== null);
  const average = reviews.length ? Math.round((reviews.reduce((a, m) => a + (m.rating ?? 0), 0) / reviews.length) * 10) / 10 : 0;
  const open = l.books.socialInbox.filter((m) => m.status === "open");
  const negative = open.filter((m) => m.sentiment === "negative");
  const enquiries = open.filter((m) => m.intent === "enquiry");
  const voice = l.books.brandVoice;
  const perf = performance(l);
  const checks = Object.fromEntries(l.books.posts.filter((p) => p.status !== "published").map((p) => [p.id, checkPost(l, p, voice)]));
  const failing = Object.values(checks).filter((c) => c.some((x) => !x.ok)).length;
  const scheduled = l.books.posts.filter((p) => p.status === "scheduled").length;
  const drafts = l.books.posts.filter((p) => p.status === "draft").length;
  return {
    note: [
      { text: `${open.length} comments, messages and reviews are waiting for a reply${negative.length ? `, including ${negative.length} unhappy one${negative.length === 1 ? "" : "s"}` : ""}${enquiries.length ? `, and ${enquiries.length} ${enquiries.length === 1 ? "is an enquiry" : "are enquiries"} for the Sales Rep` : ""}. Reviews average ${average} out of 5. ${scheduled} posts are scheduled and ${drafts} drafts are waiting for approval${failing ? `; ${failing} of them ${failing === 1 ? "fails" : "fail"} a check` : ""}. Social leads have been invoiced ` },
      { text: inrShort(perf.funnel.invoicedPaise), figureId: "social:invoiced" },
      { text: " since they first got in touch." },
    ],
    posts: l.books.posts,
    inbox: l.books.socialInbox,
    ratings: { average, count: reviews.length },
    channels: l.books.channels,
    voice,
    calendars: l.books.calendars,
    media: l.books.media,
    checks,
    performance: perf,
  };
}

export function operationsReport(l: Ledger): OperationsReport {
  const sold30 = soldSince(l, 30);
  const stock = l.books.stock.map((s) => {
    const sku = l.sku(s.skuId);
    const sold = sold30.get(s.skuId) ?? 0;
    const cover = sold ? Math.round(s.onHand / (sold / 30)) : null;
    const status = s.onHand <= s.reorderPoint ? ("reorder" as const) : cover === null || cover > 120 ? ("excess" as const) : ("ok" as const);
    return { skuId: s.skuId, name: sku.name, category: sku.category, onHand: s.onHand, unit: sku.unit, reorderPoint: s.reorderPoint, leadTimeDays: s.leadTimeDays, soldLast30: sold, daysOfCover: cover, status, stockValuePaise: s.onHand * sku.costPaise };
  });
  const order = { reorder: 0, excess: 1, ok: 2 } as const;
  stock.sort((a, b) => order[a.status] - order[b.status] || b.stockValuePaise - a.stockValuePaise);
  const rfqs = l.books.rfqs.map((r) => {
    const credit = (t: string) => (/(\d+) days credit/.exec(t) ? Number(/(\d+) days credit/.exec(t)![1]) : 0);
    const min = Math.min(...r.quotes.map((q) => q.ratePaise));
    const scored = r.quotes.map((q) => ({ q, score: (q.ratePaise / min - 1) * 100 + q.leadDays * 0.3 - credit(q.terms) * 0.08 })).sort((a, b) => a.score - b.score);
    const best = scored[0]!.q;
    return { ...r, recommended: best.vendorName, reason: `${best.ratePaise === min ? "Lowest price" : `${Math.round((best.ratePaise / min - 1) * 1000) / 10}% above the lowest price`}, ${best.leadDays}-day lead time, ${best.terms.toLowerCase()}.` };
  });
  const toReorder = stock.filter((s) => s.status === "reorder");
  const next = l.books.compliance.filter((c) => c.status === "upcoming").sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  return {
    note: [
      { text: `${toReorder.length} SKUs are at or below their reorder point. Excess stock worth ` },
      { text: inrShort(stock.filter((s) => s.status === "excess").reduce((a, s) => a + s.stockValuePaise, 0)), figureId: "operations:excess" },
      { text: " is sitting in the godown." },
      ...(next ? [{ text: ` The next filing is ${next.form} on ${new Date(next.date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" })}.` }] : []),
    ],
    stock,
    purchaseOrders: l.books.purchaseOrders.map((p) => ({ id: p.id, number: p.number, vendor: l.party(p.vendorId).name, date: p.date, status: p.status, lines: p.lines.length, totalPaise: p.totalPaise })),
    rfqs,
    compliance: l.books.compliance.map((c) => ({ ...c, daysLeft: daysBetween(l.asOf, c.date) })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

/** Maharashtra professional tax slabs (men): nil to ₹7,500, ₹175 to ₹10,000, then ₹200 (₹300 in February). */
function professionalTax(grossPaise: number, period: string): number {
  if (grossPaise <= 7_500_00) return 0;
  if (grossPaise <= 10_000_00) return 175_00;
  return period.endsWith("-02") ? 300_00 : 200_00;
}

export function payrollFor(l: Ledger, period: string): PayrollLine[] {
  return l.books.employees.map((e) => {
    const a = e.attendance;
    const payable = a.present + a.paidLeave;
    const earned = divHalfUp(e.monthlyGrossPaise * payable, a.workingDays);
    const basic = divHalfUp(earned, 2);
    const pfWage = Math.min(basic, 15_000_00);
    const pfEmployee = pctOf(pfWage, 1200);
    const esiApplies = e.monthlyGrossPaise <= 21_000_00;
    const esiEmployee = esiApplies ? Math.ceil(pctOf(earned, 75) / 100) * 100 : 0;
    const esiEmployer = esiApplies ? Math.ceil(pctOf(earned, 325) / 100) * 100 : 0;
    const pt = professionalTax(e.monthlyGrossPaise, period);
    return {
      employeeId: e.id,
      name: e.name,
      role: e.role,
      grossPaise: e.monthlyGrossPaise,
      payableDays: payable,
      earnedPaise: earned,
      pfEmployeePaise: pfEmployee,
      esiEmployeePaise: esiEmployee,
      ptPaise: pt,
      netPaise: earned - pfEmployee - esiEmployee - pt,
      pfEmployerPaise: pctOf(pfWage, 1200),
      esiEmployerPaise: esiEmployer,
    };
  });
}

export function peopleReport(l: Ledger, period?: string): PeopleReport {
  const p = period ?? l.books.employees[0]?.attendance.period ?? "2026-10";
  const lines = payrollFor(l, p);
  const sum = (k: keyof PayrollLine) => lines.reduce((a, x) => a + (x[k] as number), 0);
  const totals = {
    grossPaise: sum("grossPaise"),
    earnedPaise: sum("earnedPaise"),
    pfEmployeePaise: sum("pfEmployeePaise"),
    esiEmployeePaise: sum("esiEmployeePaise"),
    ptPaise: sum("ptPaise"),
    netPaise: sum("netPaise"),
    pfEmployerPaise: sum("pfEmployerPaise"),
    esiEmployerPaise: sum("esiEmployerPaise"),
  };
  return {
    period: p,
    note: [
      { text: `Payroll for ${monthLabel(p)} covers ${lines.length} people: ` },
      { text: inrShort(totals.netPaise), figureId: `payroll:net:${p}` },
      { text: " to pay out, with " },
      { text: inrShort(totals.pfEmployeePaise + totals.pfEmployerPaise + totals.esiEmployeePaise + totals.esiEmployerPaise), figureId: `payroll:statutory:${p}` },
      { text: " of PF and ESI due by the 15th." },
    ],
    lines,
    totals,
    assumptions: [
      "Basic pay is taken as half of gross; PF is 12% of basic, capped at the ₹15,000 wage ceiling.",
      "ESI applies to gross up to ₹21,000 a month: 0.75% employee, 3.25% employer.",
      "Maharashtra professional tax on the slabs for men; women earning up to ₹25,000 are exempt, so mark them in Settings.",
      "No salary TDS: every employee is within the new-regime rebate. Confirm declarations each year.",
    ],
  };
}
