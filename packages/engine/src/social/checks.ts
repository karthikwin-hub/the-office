import { PLATFORM_NAMES, type BrandVoice, type Post, type PostCheck, type PostFact, type PostVariant } from "@office/contracts";
import { daysBetween, toUtc } from "../dates";
import type { Ledger } from "../ledger";
import { inr } from "../money";
import { RULES, charCount, hashtagsIn } from "./channels";

const rupees = (paise: number) => `₹${inr(paise, { rupees: true })}`;
const withGst = (paise: number, rate: number) => Math.round((paise * (100 + rate)) / 100 / 100) * 100;

/** The figures a post about these SKUs, this campaign and this date may state, each tied to its record. */
export function factsFor(l: Ledger, skuIds: string[], at: string, campaignId: string | null = null): PostFact[] {
  const out: PostFact[] = [];
  const stock = new Map(l.books.stock.map((s) => [s.skuId, s]));
  for (const id of skuIds) {
    const sku = l.books.skus.find((s) => s.id === id);
    if (!sku) continue;
    out.push({ id: `price:${id}`, kind: "price", label: `${sku.name}, price before GST`, value: rupees(sku.pricePaise), ref: { kind: "sku", id } });
    out.push({ id: `mrp:${id}`, kind: "price", label: `${sku.name}, price with ${sku.gstRate}% GST`, value: rupees(withGst(sku.pricePaise, sku.gstRate)), ref: { kind: "sku", id } });
    out.push({ id: `gst:${id}`, kind: "spec", label: `${sku.name}, GST rate`, value: `${sku.gstRate}%`, ref: { kind: "sku", id } });
    const st = stock.get(id);
    if (st) out.push({ id: `stock:${id}`, kind: "stock", label: `${sku.name} on hand`, value: String(st.onHand), ref: { kind: "stock", id } });
  }
  const campaign = campaignId ? l.books.campaigns.find((c) => c.id === campaignId) : undefined;
  if (campaign) {
    out.push({ id: `campaign:${campaign.id}:start`, kind: "date", label: `${campaign.name} starts`, value: campaign.start, ref: { kind: "campaign", id: campaign.id } });
    out.push({ id: `campaign:${campaign.id}:end`, kind: "date", label: `${campaign.name} ends`, value: campaign.end, ref: { kind: "campaign", id: campaign.id } });
  }
  const day = at.slice(0, 10);
  for (const f of l.books.festivalCalendar) {
    const gap = daysBetween(day, f.date);
    if (gap >= -3 && gap <= 30) out.push({ id: `festival:${f.date}`, kind: "date", label: f.name, value: f.date, ref: { kind: "festival", id: f.date } });
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every rupee amount, percentage, count and calendar date written in the text. */
export type FigureInText = { kind: "price" | "percent" | "count" | "date"; raw: string; value: number | string; index: number };

export function figuresIn(text: string): FigureInText[] {
  const out: FigureInText[] = [];
  const taken: [number, number][] = [];
  const add = (m: RegExpMatchArray, kind: FigureInText["kind"], value: number | string) => {
    const s = m.index!;
    const e = s + m[0].trimEnd().length;
    if (taken.some(([a, b]) => s < b && e > a)) return;
    taken.push([s, e]);
    out.push({ kind, raw: m[0].trim(), value, index: s });
  };
  for (const m of text.matchAll(/(?:₹|rs\.?\s?|inr\s?)\s?(\d[\d,]*(?:\.\d+)?)/gi)) add(m, "price", Math.round(Number(m[1]!.replace(/,/g, "")) * 100));
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) add(m, "percent", Number(m[1]));
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi)) add(m, "date", `${MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3)) + 1}-${Number(m[1])}`);
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) add(m, "date", `${MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1}-${Number(m[2])}`);
  for (const m of text.matchAll(/\b(?:only|just|last)\s+(\d+)\s+(?:left|pieces|pcs|units|in stock)\b/gi)) add(m, "count", Number(m[1]));
  return out.sort((a, b) => a.index - b.index);
}

export type TextSegment = { text: string; figure?: FigureInText; fact?: PostFact };

/** Splits a caption into plain runs and figures, each figure with the fact it matches, if any. */
export function segmentFigures(text: string, facts: PostFact[]): TextSegment[] {
  const out: TextSegment[] = [];
  let at = 0;
  for (const f of figuresIn(text)) {
    if (f.index > at) out.push({ text: text.slice(at, f.index) });
    out.push({ text: f.raw, figure: f, fact: matchFigure(f, facts) });
    at = f.index + f.raw.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

function matchFigure(f: FigureInText, facts: PostFact[]): PostFact | undefined {
  if (f.kind === "price") return facts.find((x) => x.kind === "price" && Math.abs(Number(x.value.replace(/[₹,]/g, "")) * 100 - (f.value as number)) < 100);
  if (f.kind === "percent") return facts.find((x) => (x.kind === "discount" || x.kind === "spec") && Number.parseFloat(x.value) === f.value);
  if (f.kind === "count") return facts.find((x) => (x.kind === "stock" && Number(x.value) >= (f.value as number)) || (x.kind === "count" && Number(x.value) === f.value));
  return facts.find((x) => {
    if (x.kind !== "date") return false;
    const d = new Date(toUtc(x.value));
    return `${d.getUTCMonth() + 1}-${d.getUTCDate()}` === f.value;
  });
}

const COMPARATIVE = /\b(cheapest|lowest price|best price|best in (?:town|the city|india)|number\s?(?:one|1)|no\.\s?1|guaranteed|unbeatable|better than|beats)\b/i;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/https?:\/\/\S+/g, "").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

function scriptOf(text: string): "latin" | "devanagari" | "mixed" {
  const dev = (text.match(/[\u0900-\u097F]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (dev && lat > dev) return "mixed";
  if (dev) return "devanagari";
  return "latin";
}

/** Runs every check on a post. A failed check blocks Trusted publishing and shows on the approval card. */
export function checkPost(l: Ledger, post: Post, voice: BrandVoice, opts: { now?: string } = {}): PostCheck[] {
  const out: PostCheck[] = [];
  const facts = post.facts.length ? post.facts : factsFor(l, post.skuIds, post.at, post.campaignId);
  const live = factsFor(l, post.skuIds, post.at, post.campaignId);
  const media = new Map(l.books.media.map((m) => [m.id, m]));
  const stock = new Map(l.books.stock.map((s) => [s.skuId, s]));
  const active = post.variants.filter((v) => v.status !== "skipped");

  for (const v of active) {
    const rules = RULES[v.platform];
    const n = charCount(v.platform, v.text);
    out.push({ key: "length", label: "Fits the channel", ok: n <= rules.maxChars, detail: `${n} of ${rules.maxChars} characters`, channelId: v.channelId });
    const tags = hashtagsIn(v.text).length;
    if (tags > rules.maxHashtags) out.push({ key: "hashtags", label: "Hashtags", ok: false, detail: `${tags} hashtags; this channel works best with ${rules.maxHashtags} or fewer`, channelId: v.channelId });
    if (rules.media.required && !v.mediaIds.length) out.push({ key: "media", label: "Picture", ok: false, detail: `${platformLabel(v)} needs a picture or video`, channelId: v.channelId });
    const missingAlt = v.mediaIds.filter((id) => !media.get(id)?.alt.trim());
    if (v.mediaIds.length) out.push({ key: "alt", label: "Alt text", ok: !missingAlt.length, detail: missingAlt.length ? `${missingAlt.length} picture${missingAlt.length === 1 ? " has" : "s have"} no description for screen readers` : "Every picture is described", channelId: v.channelId });
    if (v.link) out.push({ key: "utm", label: "Tracked link", ok: /[?&]utm_source=/.test(v.link), detail: /[?&]utm_source=/.test(v.link) ? "The link carries UTM tags, so visits trace back to this post" : "The link has no UTM tags, so visits cannot be traced", channelId: v.channelId });
    const script = scriptOf(v.text);
    const allowed = script === "latin" ? voice.languages.includes("en") : script === "devanagari" ? voice.languages.some((x) => x !== "en") : voice.languages.length > 1;
    if (!allowed) out.push({ key: "language", label: "Language", ok: false, detail: `Written in ${script === "latin" ? "English" : "Devanagari script"}, which is not in the brand voice's languages`, channelId: v.channelId });
  }

  const figures = new Map<string, { raw: string; fact: PostFact | undefined; kind: string }>();
  for (const v of active) for (const f of figuresIn(v.text)) if (!figures.has(f.raw)) figures.set(f.raw, { raw: f.raw, kind: f.kind, fact: matchFigure(f, facts) });
  for (const f of figures.values()) {
    const current = f.fact ? live.find((x) => x.id === f.fact!.id) : undefined;
    const stale = f.fact && current && current.value !== f.fact.value;
    const ok = !!f.fact && !stale && (f.fact.kind !== "price" || !!current);
    const key = f.kind === "price" ? "price" : f.kind === "date" ? "date" : f.kind === "count" ? "stock-claim" : "discount";
    const detail = !f.fact
      ? f.kind === "percent"
        ? `${f.raw} is not a discount on record. Add it to a campaign first.`
        : f.kind === "date"
          ? `${f.raw} does not match the campaign or the festival calendar`
          : `${f.raw} does not match the price list or stock`
      : stale
        ? `${f.raw} was ${f.fact.label.toLowerCase()} when drafted; the books now say ${current!.value}`
        : `${f.raw} matches ${f.fact.label.toLowerCase()}`;
    out.push({ key, label: f.kind === "price" ? "Price" : f.kind === "date" ? "Date" : f.kind === "count" ? "Stock claim" : "Discount", ok, detail, channelId: null });
  }

  for (const id of post.skuIds) {
    const st = stock.get(id);
    const name = l.books.skus.find((s) => s.id === id)?.name ?? id;
    if (st && st.onHand <= 0) out.push({ key: "stock", label: "In stock", ok: false, detail: `${name} is out of stock, so it should not be promoted`, channelId: null });
    else if (st) out.push({ key: "stock", label: "In stock", ok: true, detail: `${st.onHand} of ${name} on hand`, channelId: null });
  }

  const rivals = [...new Set(l.books.competitorPrices.flatMap((c) => [c.marketplace, c.seller]))].filter((x) => x.length > 2);
  for (const v of active) {
    const comp = COMPARATIVE.exec(v.text);
    const named = rivals.find((r) => new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(v.text));
    if (comp || named) out.push({ key: "claims", label: "Fair claims", ok: false, detail: comp ? `"${comp[0]}" is a comparative claim. ASCI asks that it be provable and fair, so leave it out or cite the comparison.` : `Names ${named}; leave competitors out of posts`, channelId: v.channelId });
  }

  const day = (opts.now ?? post.at).slice(0, 10);
  for (const other of l.books.posts) {
    if (other.id === post.id || Math.abs(daysBetween(other.at.slice(0, 10), post.at.slice(0, 10))) > 14) continue;
    for (const v of active) {
      const twin = other.variants.find((o) => o.channelId === v.channelId && similarity(o.text, v.text) > 0.7);
      if (twin) out.push({ key: "duplicate", label: "Not a repeat", ok: false, detail: `Very close to post ${other.id} on the same channel within 14 days`, channelId: v.channelId });
    }
  }
  if (post.status !== "published" && post.at.slice(0, 10) < day) out.push({ key: "time", label: "Time", ok: false, detail: "The publishing time has passed", channelId: null });
  return out;
}

const platformLabel = (v: PostVariant) => PLATFORM_NAMES[v.platform];

export const passes = (checks: PostCheck[], channelId?: string) => checks.every((c) => c.ok || (channelId !== undefined && c.channelId !== null && c.channelId !== channelId));
