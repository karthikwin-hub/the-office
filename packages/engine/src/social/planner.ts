import type { CalendarSlot, ContentCalendar, Platform, Post } from "@office/contracts";
import { addDays, daysBetween, monthEnd } from "../dates";
import type { Ledger } from "../ledger";
import { marketingReport } from "../teams";
import { draftPost } from "./drafts";
import { performance } from "./metrics";

const KNOW_HOW = [
  "How to pick the right MCB rating for a room",
  "Why ISI-marked wire is worth it",
  "Earthing checks every home should have",
  "LED lighting that cuts the power bill",
  "What an RCCB protects you from",
  "Sizing wire for an AC point",
];
const BEHIND = ["New stock in at the godown", "Meet the counter team", "Packing a site order", "A week of deliveries"];

/** Which platforms suit each pillar. WhatsApp is kept for offers, where customers expect it. */
const PILLAR_PLATFORMS: Record<string, Platform[]> = {
  products: ["instagram", "facebook", "threads", "x"],
  "know-how": ["instagram", "facebook", "linkedin", "threads", "x"],
  offers: ["instagram", "facebook", "whatsapp", "x", "threads"],
  behind: ["instagram", "facebook", "linkedin"],
};

/** Mondays, Wednesdays and Fridays in the month. */
function postingDays(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; d <= monthEnd(month); d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 1 || wd === 3 || wd === 5) out.push(d);
  }
  return out;
}

/** Largest-remainder split of n slots across pillar shares. */
export function shareSlots(shares: { id: string; share: number }[], n: number): Map<string, number> {
  const total = shares.reduce((a, s) => a + s.share, 0) || 1;
  const exact = shares.map((s) => ({ id: s.id, q: (s.share / total) * n }));
  const out = new Map(exact.map((e) => [e.id, Math.floor(e.q)]));
  let left = n - [...out.values()].reduce((a, b) => a + b, 0);
  for (const e of [...exact].sort((a, b) => (b.q % 1) - (a.q % 1))) {
    if (left-- <= 0) break;
    out.set(e.id, out.get(e.id)! + 1);
  }
  return out;
}

/** Fills a month's calendar: festivals first, then pillar shares, nudged towards last month's best pillar. */
export function planMonth(l: Ledger, month: string): ContentCalendar {
  const voice = l.books.brandVoice;
  const days = postingDays(month);
  const channels = l.books.channels.filter((c) => c.status !== "error");
  const channelsFor = (pillar: string) => {
    const want = PILLAR_PLATFORMS[pillar] ?? PILLAR_PLATFORMS.products!;
    return channels.filter((c) => want.includes(c.platform)).map((c) => c.id);
  };
  const counts = shareSlots(voice.pillars, days.length);
  const best = performance(l).byPillar.filter((p) => p.posts > 0).sort((a, b) => b.rate - a.rate)[0];
  if (best && counts.has(best.pillarId)) {
    const biggest = [...counts.entries()].filter(([id]) => id !== best.pillarId).sort((a, b) => b[1] - a[1])[0];
    if (biggest && biggest[1] > 1) {
      counts.set(biggest[0], biggest[1] - 1);
      counts.set(best.pillarId, counts.get(best.pillarId)! + 1);
    }
  }

  const slots: CalendarSlot[] = [];
  const free = new Set(days);
  const take = (near: string) => {
    const d = [...free].sort((a, b) => Math.abs(daysBetween(near, a)) - Math.abs(daysBetween(near, b)))[0];
    if (d) free.delete(d);
    return d;
  };
  const offersId = voice.pillars.find((p) => p.id === "offers")?.id ?? voice.pillars[0]?.id ?? "offers";
  const festivals = l.books.festivalCalendar.filter((f) => f.date >= `${month}-01` && f.date <= addDays(monthEnd(month), 5));
  for (const f of festivals) {
    if ((counts.get(offersId) ?? 0) <= 0) break;
    const d = take(addDays(f.date, -3));
    if (!d) break;
    slots.push({ date: d, pillarId: offersId, topic: `${f.name} timings and offers`, channelIds: channelsFor(offersId), postId: null });
    counts.set(offersId, counts.get(offersId)! - 1);
  }

  const inStock = new Set(l.books.stock.filter((s) => s.onHand > 0).map((s) => s.skuId));
  const slow = marketingReport(l).slowMovers.filter((s) => inStock.has(s.skuId)).map((s) => s.name);
  const products = [...slow, ...l.books.skus.filter((s) => inStock.has(s.id) && !slow.includes(s.name)).map((s) => s.name)];
  const campaigns = l.books.campaigns.filter((c) => c.status !== "ended" && c.status !== "draft" && c.end >= `${month}-01` && c.start <= monthEnd(month)).map((c) => c.name);
  const topics: Record<string, string[]> = { products: products.map((n) => `${n} in stock`), offers: campaigns, "know-how": KNOW_HOW, behind: BEHIND };
  const used = new Map<string, number>();
  const total = voice.pillars.reduce((a, p) => a + Math.max(0, counts.get(p.id) ?? 0), 0);
  const interleaved: string[] = [];
  const queues = new Map<string, number>(voice.pillars.map((p) => [p.id, counts.get(p.id) ?? 0]));
  while (interleaved.length < total) {
    for (const p of voice.pillars) {
      if ((queues.get(p.id) ?? 0) > 0) {
        interleaved.push(p.id);
        queues.set(p.id, queues.get(p.id)! - 1);
      }
    }
  }
  for (const pillar of interleaved) {
    const d = [...free].sort()[0];
    if (!d) break;
    free.delete(d);
    const list = topics[pillar]?.length ? topics[pillar]! : [voice.pillars.find((p) => p.id === pillar)?.description ?? pillar];
    const i = used.get(pillar) ?? 0;
    used.set(pillar, i + 1);
    slots.push({ date: d, pillarId: pillar, topic: list[i % list.length]!, channelIds: channelsFor(pillar), postId: null });
  }
  slots.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { id: `cal-${month}`, month, status: "draft", slots, createdAt: `${l.asOf}T09:00:00+05:30`, approvedAt: null, approvedBy: null };
}

/** Drafts a post for every slot that does not have one yet. */
export function draftCalendar(l: Ledger, cal: ContentCalendar): { calendar: ContentCalendar; posts: Post[] } {
  const posts: Post[] = [];
  const slots = cal.slots.map((s, i) => {
    if (s.postId) return s;
    const campaign = l.books.campaigns.find((c) => s.topic.includes(c.name));
    const id = `post-${cal.month.replace("-", "")}-${String(i + 1).padStart(2, "0")}`;
    const post = draftPost(l, s, { id, calendarId: cal.id, campaignId: campaign?.id ?? null, skuIds: campaign && !s.topic.includes(" in stock") ? campaign.skuIds.slice(0, 2) : undefined });
    posts.push(post);
    return { ...s, postId: id };
  });
  return { calendar: { ...cal, slots }, posts };
}
