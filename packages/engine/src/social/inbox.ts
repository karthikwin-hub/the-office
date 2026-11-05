import type { Lead, SocialMessage } from "@office/contracts";
import { PLATFORM_NAMES, platformOf } from "@office/contracts";
import type { Ledger } from "../ledger";

type Intent = SocialMessage["intent"];
type Sentiment = SocialMessage["sentiment"];

const NEGATIVE = /\b(bad|worst|poor|rude|late|delay(?:ed)?|broken|damaged|faulty|defective|not working|stopped working|refund|cheat(?:ed)?|never again|disappointed|complain|wrong|overcharged?|waste)\b/i;
const POSITIVE = /\b(thank(?:s| you)?|great|good|excellent|helpful|quick|fast|best|recommend|happy|love|genuine|reasonable|polite|nice|superb)\b/i;
const ENQUIRY = /\b(price|rate|cost|quote|quotation|stock|available|availability|deliver|delivery|order|need|want|require|pcs|pieces|boxes|coils|bulk|wholesale|dealer)\b/i;
const SPAM = /\b(followers|crypto|bitcoin|loan offer|click here|dm for promo|collab|earn \d+|promote your)\b|https?:\/\/(?!\S*(?:wa\.me|instagram\.com|facebook\.com))/i;

/** Sentiment and intent from the words and the star rating. */
export function classify(text: string, rating: number | null): { sentiment: Sentiment; intent: Intent } {
  const t = text.trim();
  if (SPAM.test(t)) return { sentiment: "neutral", intent: "spam" };
  const neg = (rating !== null && rating <= 2) || (rating === null && NEGATIVE.test(t));
  const pos = (rating !== null && rating >= 4) || (rating === null && POSITIVE.test(t) && !NEGATIVE.test(t));
  const sentiment: Sentiment = neg ? "negative" : pos ? "positive" : rating === 3 ? "neutral" : NEGATIVE.test(t) ? "negative" : "neutral";
  if (sentiment === "negative") return { sentiment, intent: "complaint" };
  if (ENQUIRY.test(t)) return { sentiment, intent: "enquiry" };
  if (/\?\s*$/.test(t)) return { sentiment, intent: "question" };
  return { sentiment, intent: sentiment === "positive" ? "praise" : "question" };
}

/** A reply that states no figures and makes no promises; complaints are taken offline. */
export function draftReply(m: Pick<SocialMessage, "author" | "intent" | "kind" | "platform">, businessName: string, phone: string): string {
  const first = m.author.split(/\s+/)[0] ?? m.author;
  switch (m.intent) {
    case "praise":
      return `Thank you, ${first}. We are glad it helped, and we look forward to seeing you again at ${businessName}.`;
    case "complaint":
      return `${first}, we are sorry about this. Please call us on ${phone} or send us a message with your bill number so the owner can look into it today.`;
    case "enquiry":
      return `Thanks for asking, ${first}. Our sales team will send you the details and a quotation shortly.`;
    case "spam":
      return "";
    default:
      return `Thanks, ${first}. ${m.kind === "dm" ? "We will reply here" : "Please send us a message"} and our team will help.`;
  }
}

const PROMISE = /\b(will|free|discount|refund|replace(?:ment)?|guarantee|warranty|deliver|tomorrow|today|tonight|offer|price|\d)\b/i;

/**
 * The one kind of reply a Trusted agent may send by itself: a thank-you to a 4 or 5 star review
 * or a positive public comment, with no figures and no promises.
 */
export function isThankYou(m: SocialMessage, reply: string): boolean {
  if (m.kind === "dm" || m.intent !== "praise" || m.sentiment !== "positive") return false;
  if (m.rating !== null && m.rating < 4) return false;
  if (!reply.trim() || /\d/.test(reply)) return false;
  return !PROMISE.test(reply);
}

/** An enquiry becomes a lead for the Sales Rep. */
export function leadFrom(l: Ledger, m: SocialMessage): Lead {
  const day = m.at.slice(0, 10);
  const named = l.books.skus.find((s) => m.text.toLowerCase().includes(s.name.toLowerCase().split(" ").slice(0, 2).join(" ")));
  const qty = Number(/(\d+)\s*(?:pcs|pieces|boxes|coils|nos|units)?/i.exec(m.text)?.[1] ?? 0);
  return {
    id: `lead-${m.id}`,
    name: m.author,
    city: "",
    source: PLATFORM_NAMES[platformOf(m.platform)],
    stage: "new",
    valuePaise: named && qty ? named.pricePaise * Math.min(qty, 10_000) : 0,
    need: m.text.slice(0, 200),
    createdOn: day,
    lastTouchOn: day,
    nextStep: `Reply on ${PLATFORM_NAMES[platformOf(m.platform)]} with a quotation`,
  };
}

/** Builds a new inbox message from a platform event, with sentiment, intent and a reply drafted. */
export function newMessage(l: Ledger, raw: Pick<SocialMessage, "id" | "platform" | "channelId" | "kind" | "author" | "at" | "rating" | "text"> & Partial<SocialMessage>): SocialMessage {
  const { sentiment, intent } = classify(raw.text, raw.rating);
  const replyBy = raw.kind === "dm" && platformOf(raw.platform) === "whatsapp" ? new Date(Date.parse(raw.at) + 24 * 3600_000).toISOString() : null;
  const m: SocialMessage = { postId: null, threadId: null, externalId: null, leadId: null, replyBy, ...raw, sentiment, intent, draftReply: "", status: "open" };
  return { ...m, draftReply: draftReply(m, l.books.business.name, l.books.business.phone) };
}
