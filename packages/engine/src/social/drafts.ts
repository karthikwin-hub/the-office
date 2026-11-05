import type { BrandVoice, CalendarSlot, Channel, Platform, Post, PostFact, PostVariant } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import type { Ledger } from "../ledger";
import { RULES, fit, textHash, withUtm } from "./channels";
import { factsFor, figuresIn } from "./checks";

export type DraftPrompt = { system: string; user: string; schema: Record<string, unknown> };

/** The prompt for one channel's caption. The model may only state figures from the fact list, and must cite them. */
export function draftPrompt(topic: string, facts: PostFact[], voice: BrandVoice, platform: Platform): DraftPrompt {
  const r = RULES[platform];
  const system = [
    `You write social media posts for a small Indian business, for ${PLATFORM_NAMES[platform]}.`,
    `Voice: ${voice.tone}`,
    voice.dos.length ? `Do: ${voice.dos.join("; ")}.` : "",
    voice.donts.length ? `Don't: ${voice.donts.join("; ")}.` : "",
    `Keep it under ${r.maxChars} characters with at most ${r.maxHashtags} hashtags. Emoji: ${voice.emoji}.`,
    "State a price, percentage, count or date only if it appears in the fact list, copied exactly, and list the ids of every fact you used.",
    "Never claim to be the cheapest or best, and never name a competitor.",
    voice.samples.length ? `Past posts in this voice:\n${voice.samples.slice(0, 5).map((s) => `- ${s}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const user = `Topic: ${topic}\nFacts:\n${facts.map((f) => `[${f.id}] ${f.label}: ${f.value}`).join("\n") || "(none)"}`;
  const schema = { type: "object", properties: { text: { type: "string" }, factIds: { type: "array", items: { type: "string" } } }, required: ["text", "factIds"] };
  return { system, user, schema };
}

/**
 * Accepts a model draft only if every figure in it is one of the cited facts, written as the books have it.
 * Anything else returns null and the template draft is used instead.
 */
export function fromDraft(answer: unknown, facts: PostFact[]): { text: string; factIds: string[] } | null {
  const a = typeof answer === "string" ? safeJson(answer) : answer;
  if (!a || typeof a !== "object") return null;
  const { text, factIds } = a as { text?: unknown; factIds?: unknown };
  if (typeof text !== "string" || !text.trim() || !Array.isArray(factIds)) return null;
  const cited = facts.filter((f) => factIds.includes(f.id));
  for (const fig of figuresIn(text)) {
    const found = cited.some((f) => {
      if (fig.kind === "date") return f.kind === "date" && `${Number(f.value.slice(5, 7))}-${Number(f.value.slice(8, 10))}` === fig.value;
      if (fig.kind === "price") return f.kind === "price" && Math.round(Number(f.value.replace(/[₹,]/g, "")) * 100) === fig.value;
      if (fig.kind === "percent") return (f.kind === "discount" || f.kind === "spec") && Number.parseFloat(f.value) === fig.value;
      return f.kind === "stock" && Number(f.value) >= (fig.value as number);
    });
    if (!found) return null;
  }
  return { text: text.trim(), factIds: cited.map((f) => f.id) };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^```(?:json)?|```$/g, "").trim());
  } catch {
    return null;
  }
}

const dayName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });

/** A plain, figure-safe caption built only from the facts. Used when the model is not available. */
export function templateDraft(l: Ledger, slot: Pick<CalendarSlot, "topic" | "pillarId">, facts: PostFact[], voice: BrandVoice, platform: Platform): string {
  const biz = l.books.business.name;
  const price = facts.find((f) => f.id.startsWith("mrp:"));
  const sku = price ? l.books.skus.find((s) => s.id === price.ref.id) : undefined;
  const festival = facts.find((f) => f.id.startsWith("festival:"));
  const campaignEnd = facts.find((f) => f.id.endsWith(":end"));
  const city = l.books.business.address.split(",").map((s) => s.trim()).filter(Boolean).at(-2) ?? "";
  const lines: string[] = [];
  if (slot.pillarId === "products" && sku && price) {
    lines.push(`${sku.name}, in stock at ${biz}${city ? `, ${city}` : ""}.`);
    lines.push(`${price.value} with GST.`);
    lines.push(platform === "whatsapp" ? "Reply to this message to reserve yours." : "Message us or call to reserve yours.");
  } else if (slot.pillarId === "offers") {
    lines.push(`${slot.topic}.`);
    if (festival) lines.push(`Shop open for ${festival.label} on ${dayName(festival.value)}.`);
    if (sku && price) lines.push(`${sku.name} at ${price.value} with GST.`);
    if (campaignEnd) lines.push(`Until ${dayName(campaignEnd.value)}.`);
  } else if (slot.pillarId === "know-how") {
    lines.push(`${slot.topic}.`);
    lines.push("Ask at the counter and our team will help you pick the right part.");
  } else {
    lines.push(`${slot.topic}.`);
    lines.push(`From the team at ${biz}.`);
  }
  if (voice.signoff) lines.push(voice.signoff);
  const sep = platform === "x" || platform === "threads" ? " " : "\n";
  return lines.join(sep);
}

/** Drafts one post for a calendar slot: one fact list, and a caption written for each channel. */
export function draftPost(l: Ledger, slot: CalendarSlot, opts: { id: string; time?: string; skuIds?: string[]; campaignId?: string | null; calendarId?: string | null; link?: string | null }): Post {
  const voice = l.books.brandVoice;
  const skuIds = opts.skuIds ?? skusFor(l, slot);
  const at = `${slot.date}T${opts.time ?? "11:00"}:00+05:30`;
  const facts = factsFor(l, skuIds, at, opts.campaignId ?? null);
  const channels = slot.channelIds.map((id) => l.books.channels.find((c) => c.id === id)).filter((c): c is Channel => !!c);
  const variants: PostVariant[] = channels.map((c) => {
    const raw = templateDraft(l, slot, facts, voice, c.platform);
    const link = opts.link ? withUtm(opts.link, c.platform, opts.id) : null;
    const fitted = fit(c.platform, raw, { link, hashtags: voice.hashtags });
    const media = l.books.media.filter((m) => m.skuId && skuIds.includes(m.skuId)).slice(0, RULES[c.platform].media.images).map((m) => m.id);
    return { channelId: c.id, platform: c.platform, text: fitted.text, mediaIds: media, link, status: "draft", externalId: null, url: null, publishedAt: null, error: null, approvedHash: null, metrics: null };
  });
  return { id: opts.id, topic: slot.topic, pillar: slot.pillarId, calendarId: opts.calendarId ?? null, campaignId: opts.campaignId ?? null, status: "draft", at, skuIds, facts, variants };
}

/** The SKUs a slot is about: named in its topic, or the slow movers for product slots. */
function skusFor(l: Ledger, slot: CalendarSlot): string[] {
  const t = slot.topic.toLowerCase();
  const named = l.books.skus.filter((s) => t.includes(s.name.toLowerCase()));
  return named.slice(0, 3).map((s) => s.id);
}

export const approvedHashes = (p: Post): Post => ({ ...p, variants: p.variants.map((v) => ({ ...v, approvedHash: textHash(v.text) })) });
