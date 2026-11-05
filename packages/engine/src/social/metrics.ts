import type { PostMetrics, PostVariant, Quote, SocialPerformance } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import type { Ledger } from "../ledger";

const engagements = (m: PostMetrics) => m.likes + m.comments + m.saves + (m.shares ?? 0);
const rate = (e: number, v: number) => (v ? Math.round((e / v) * 1000) / 10 : 0);
const SOCIAL_SOURCE = /instagram|facebook|threads|linkedin|whatsapp|twitter|\bx\b|social/i;

/** Reach and engagement by channel and pillar, and the funnel from post to enquiry, quote and invoice. */
export function performance(l: Ledger): SocialPerformance {
  const published: { postId: string; pillar: string | null; v: PostVariant & { metrics: PostMetrics } }[] = [];
  for (const p of l.books.posts) for (const v of p.variants) if (v.status === "published" && v.metrics) published.push({ postId: p.id, pillar: p.pillar, v: v as PostVariant & { metrics: PostMetrics } });

  const byChannelMap = new Map<string, SocialPerformance["byChannel"][number]>();
  for (const { v } of published) {
    const row = byChannelMap.get(v.channelId) ?? { channelId: v.channelId, platform: v.platform, posts: 0, views: 0, engagements: 0, rate: 0, enquiries: 0 };
    row.posts++;
    row.views += v.metrics.views;
    row.engagements += engagements(v.metrics);
    row.enquiries += v.metrics.enquiries ?? 0;
    byChannelMap.set(v.channelId, row);
  }
  for (const m of l.books.socialInbox) {
    if (m.intent !== "enquiry") continue;
    const row = byChannelMap.get(m.channelId);
    if (row && !published.some((p) => p.v.channelId === m.channelId && (p.v.metrics.enquiries ?? 0) > 0)) row.enquiries++;
  }
  const byChannel = [...byChannelMap.values()].map((r) => ({ ...r, rate: rate(r.engagements, r.views) })).sort((a, b) => b.views - a.views);

  const pillars = l.books.brandVoice.pillars;
  const byPillar = pillars.map((p) => {
    const list = published.filter((x) => x.pillar === p.id);
    const views = list.reduce((a, x) => a + x.v.metrics.views, 0);
    return { pillarId: p.id, name: p.name, posts: new Set(list.map((x) => x.postId)).size, views, rate: rate(list.reduce((a, x) => a + engagements(x.v.metrics), 0), views) };
  });

  const inboxLeads = new Set(l.books.socialInbox.map((m) => m.leadId).filter((x): x is string => !!x));
  const leads = l.books.leads.filter((x) => inboxLeads.has(x.id) || SOCIAL_SOURCE.test(x.source));
  const leadIds = new Set(leads.map((x) => x.id));
  const quotes = l.books.quotes.filter((q) => q.leadId && leadIds.has(q.leadId));
  const partyIds = [...new Set(quotes.map((q) => q.partyId).filter((x): x is string => !!x))];
  const invoicedPaise = partyIds.reduce((a, pid) => a + socialInvoices(l, pid, quotes).reduce((s, i) => s + i.totals.totalPaise, 0), 0);
  const funnel = {
    posts: new Set(published.map((p) => p.postId)).size,
    views: published.reduce((a, p) => a + p.v.metrics.views, 0),
    clicks: published.reduce((a, p) => a + (p.v.metrics.clicks ?? 0), 0),
    enquiries: byChannel.reduce((a, r) => a + r.enquiries, 0),
    leads: leads.length,
    quotes: quotes.length,
    invoicedPaise,
    partyIds,
    leadIds: [...leadIds],
  };

  const best = [...published]
    .filter((p) => p.v.metrics.views >= 50)
    .sort((a, b) => rate(engagements(b.v.metrics), b.v.metrics.views) - rate(engagements(a.v.metrics), a.v.metrics.views))
    .slice(0, 3)
    .map((p) => ({ postId: p.postId, channelId: p.v.channelId, reason: `${rate(engagements(p.v.metrics), p.v.metrics.views)}% of ${p.v.metrics.views.toLocaleString("en-IN")} viewers engaged on ${PLATFORM_NAMES[p.v.platform]}${p.v.metrics.saves ? `, ${p.v.metrics.saves} saved it` : ""}` }));

  return { byChannel, byPillar, funnel, best, experiment: nextExperiment(byChannel, byPillar, l) };
}

/** A customer's invoices since their lead first got in touch on social media. */
export function socialInvoices(l: Ledger, partyId: string, quotes: Quote[]) {
  const leadIds = new Set(quotes.filter((q) => q.partyId === partyId).map((q) => q.leadId));
  const since = l.books.leads.filter((x) => leadIds.has(x.id)).map((x) => x.createdOn).sort()[0] ?? quotes.find((q) => q.partyId === partyId)?.date ?? l.asOf;
  return l.salesInvoices.filter((i) => i.partyId === partyId && i.date >= since);
}

/** One change to try next month, from the clearest gap in the numbers. */
function nextExperiment(byChannel: SocialPerformance["byChannel"], byPillar: SocialPerformance["byPillar"], l: Ledger): string {
  const pillars = byPillar.filter((p) => p.posts > 0).sort((a, b) => b.rate - a.rate);
  const channels = byChannel.filter((c) => c.posts > 0).sort((a, b) => b.rate - a.rate);
  const unused = l.books.channels.filter((c) => !byChannel.some((b) => b.channelId === c.id) && c.status !== "error");
  if (pillars.length >= 2 && pillars[0]!.rate >= pillars.at(-1)!.rate * 1.5) {
    const top = pillars[0]!;
    const low = pillars.at(-1)!;
    return `${top.name} posts engage ${top.rate}% of viewers against ${low.rate}% for ${low.name.toLowerCase()}. Next month, move two ${low.name.toLowerCase()} slots to ${top.name.toLowerCase()} and compare.`;
  }
  if (channels.length >= 2 && channels.at(-1)!.enquiries === 0) return `${PLATFORM_NAMES[channels.at(-1)!.platform]} brings views but no enquiries. Try ending posts there with a WhatsApp link for a month.`;
  if (unused[0]) return `Nothing has gone out on ${PLATFORM_NAMES[unused[0].platform]} yet. Publish the next two product posts there too and compare enquiries.`;
  return "Post at 7 pm instead of 11 am for two weeks and compare engagement.";
}
