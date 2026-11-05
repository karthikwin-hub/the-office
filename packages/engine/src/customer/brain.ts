import type { BusinessFacts, CannedAnswer, FactKey } from "@office/contracts";

export type CsIntent = "order_status" | "balance" | "answer" | "fact" | "greeting" | "thanks" | "human" | "sensitive" | "other";
export type HumanTopic = "refund" | "complaint" | "legal" | "anger" | "negotiation" | "cancellation";
export const HUMAN_TOPIC_NAMES: Record<HumanTopic, string> = {
  refund: "asks for a refund",
  complaint: "has a complaint",
  legal: "mentions legal action",
  anger: "is upset",
  negotiation: "wants to negotiate the price",
  cancellation: "wants to cancel",
};

/** What the agent made of a message. The model may fill it in, but code checks every part before anything is sent. */
export type Classification = {
  intent: CsIntent;
  answerId: string | null;
  fact: FactKey | null;
  orderNumber: string | null;
  topic: HumanTopic | null;
  confidence: number;
  summary: string;
  method: "rules" | "model";
};

/**
 * Asking for a person, in English, Hindi (both scripts) and the other languages owners have asked about.
 * It always works, whatever the model says.
 */
const HUMAN_ASK =
  /\b(a (real )?(person|human)|human( being)?|real person|talk to (a|an|the|someone|somebody|your)|speak (to|with) (a|an|the|someone|somebody|your)|call me|call back|the owner|your manager|insaan|aadmi se|kisi se baat|baat karni|baat karao|manushya|vyakti)\b|इंसान|व्यक्ति|किसी से बात|बात कराओ|मालिक|ব্যক্তি|மனிதர்|వ్యక్తి|व्यक्तीशी/i;

const TOPICS: [HumanTopic, RegExp][] = [
  ["legal", /\b(lawyer|advocate|legal|court|consumer (forum|court)|police|fir|sue|suing|legal notice|vakil)\b|वकील|अदालत|पुलिस/i],
  ["refund", /\b(refund|money back|return (my|the) money|reimburse|chargeback|paisa wapas|paise wapas)\b|पैसे वापस|रिफंड/i],
  ["cancellation", /\bcancel(?!led|ed)|\bcancellation\b|रद्द/i],
  ["complaint", /\b(complain|complaint|worst|terrible|horrible|cheat|cheated|fraud|scam|damaged|broken|defective|wrong (item|product)|disappointed|unacceptable)\b|शिकायत|खराब|धोखा/i],
  ["negotiation", /\b(discount|cheaper|best price|lower (the )?price|reduce (the )?(price|rate)|negotiat|kam karo|rate kam|last price)\b|छूट|कम करो/i],
  ["anger", /\b(idiot|stupid|nonsense|useless|pathetic|shame|bloody|wtf|f+u+c+k+)\b/i],
];

const GREETING = /^(hi+|hello+|hey+|namaste|namaskar|good (morning|afternoon|evening)|hii+|helo|yo)[\s!.,]*$/i;
const THANKS = /^(thanks?|thank you|thx|ty|ok(ay)?( thanks?)?|great|perfect|dhanyavad|shukriya|धन्यवाद|शुक्रिया)[\s!.,]*$/i;
const ORDER_Q = /\b(order|delivery|deliver|shipped|dispatch|dispatched|tracking|track|parcel|courier|consignment|where is my|status|kab aayega|kab milega)\b|ऑर्डर|डिलीवरी/i;
const BALANCE_Q = /\b(how much (do|does|did)? ?(i|we|you|my company|our company) (still )?owe|what (do|does) (i|we) owe|outstanding|balance|dues?|pending (amount|payment|invoice)|my (bill|invoice)s?|statement|kitna baaki|payment due)\b|बकाया/i;
const FACT_Q: [FactKey, RegExp][] = [
  ["hours", /\b(hours|open|close|closing|timing|timings|what time|kab khul|sunday|holiday)\b|समय|खुल/i],
  ["address", /\b(address|location|where are you|located|directions|map|shop kaha|kahan hai)\b|पता/i],
  ["delivery", /\b(deliver to|delivery (area|charge|time)|do you deliver|ship to|shipping|pincode)\b/i],
  ["returns", /\b(return policy|returns?|exchange|replace|replacement|warranty)\b/i],
  ["payments", /\b(pay by|payment (method|option)s?|upi|gpay|phonepe|paytm|card|cash on delivery|cod|neft|cheque)\b/i],
];
export const FACT_NAMES: Record<FactKey, string> = { hours: "opening hours", address: "address", delivery: "delivery", returns: "returns", payments: "payment methods" };

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["the", "and", "you", "your", "for", "are", "can", "what", "how", "is", "do", "does", "have", "has", "with", "this", "that", "please", "kya", "hai", "aap", "mujhe", "will", "would", "there", "any", "get", "about"]);

/** The owner's answers that best match a message, by shared words with the title and example questions. */
export function scoreAnswers(text: string, answers: CannedAnswer[], limit = 5): { answer: CannedAnswer; score: number }[] {
  const q = new Set(words(text));
  if (!q.size) return [];
  return answers
    .filter((a) => a.enabled)
    .map((a) => {
      const best = Math.max(...[a.title, ...a.examples].map((e) => {
        const w = new Set(words(e));
        if (!w.size) return 0;
        let hit = 0;
        for (const x of q) if (w.has(x)) hit++;
        return hit / Math.max(Math.min(q.size, w.size), 1);
      }));
      return { answer: a, score: best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function humanTopic(text: string): HumanTopic | null {
  for (const [t, re] of TOPICS) if (re.test(text)) return t;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 12 && letters === letters.toUpperCase() && /!{2,}/.test(text)) return "anger";
  return null;
}

export const asksForPerson = (text: string) => HUMAN_ASK.test(text) || /^\s*person\s*$/i.test(text);

/** Order numbers as customers write them: "#1042", "order 1042", "SO-2291". */
export function orderNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:#|\border\s*(?:no\.?|number|#)?\s*)([A-Za-z]{0,4}-?\d{3,10})\b/gi)) out.add(m[1]!.toUpperCase());
  for (const m of text.matchAll(/\b([A-Za-z]{1,4}-\d{3,10})\b/g)) out.add(m[1]!.toUpperCase());
  return [...out];
}
export const phonesIn = (text: string) => [...text.matchAll(/(?:\+?\d[\d\s-]{8,16}\d)/g)].map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 10);
export const emailsIn = (text: string) => [...text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0].toLowerCase());
/** Two phone numbers are the same if their last ten digits are. */
export const samePhone = (a: string, b: string) => {
  const x = a.replace(/\D/g, "").slice(-10);
  return x.length === 10 && x === b.replace(/\D/g, "").slice(-10);
};

/** The rules alone: enough for greetings, the always-human topics, clear lookups and close matches with the owner's answers. */
export function classifyRules(text: string, answers: CannedAnswer[], facts: BusinessFacts): Classification {
  const t = text.trim();
  const base = { answerId: null, fact: null, orderNumber: orderNumbers(t)[0] ?? null, topic: null, method: "rules" as const, summary: t.slice(0, 160) };
  const topic = humanTopic(t);
  if (topic) return { ...base, intent: "sensitive", topic, confidence: 0.95 };
  if (asksForPerson(t)) return { ...base, intent: "human", confidence: 0.95 };
  if (GREETING.test(t)) return { ...base, intent: "greeting", confidence: 0.9 };
  if (THANKS.test(t)) return { ...base, intent: "thanks", confidence: 0.9 };
  const best = scoreAnswers(t, answers)[0];
  if (best && best.score >= 0.75) return { ...base, intent: "answer", answerId: best.answer.id, confidence: Math.min(0.9, best.score) };
  if (base.orderNumber || ORDER_Q.test(t)) return { ...base, intent: "order_status", confidence: base.orderNumber ? 0.85 : 0.7 };
  if (BALANCE_Q.test(t)) return { ...base, intent: "balance", confidence: 0.75 };
  for (const [key, re] of FACT_Q) if (re.test(t)) return { ...base, intent: "fact", fact: key, confidence: facts[key] ? 0.7 : 0.5 };
  if (best && best.score >= 0.5) return { ...base, intent: "answer", answerId: best.answer.id, confidence: 0.6 };
  return { ...base, intent: "other", confidence: 0.3 };
}

/** The rules are sure enough that asking the model would add nothing. */
export const decisive = (c: Classification) => c.confidence >= 0.85 || c.intent === "sensitive" || c.intent === "human";

/** Below this, a message goes to the owner rather than being answered. */
export const MIN_CONFIDENCE = 0.6;

/** What the model is asked. It picks from fixed choices; it never writes what the customer reads. */
export function classifierPrompt(business: string, text: string, recent: string[], candidates: CannedAnswer[], facts: BusinessFacts): { system: string; user: string } {
  const factKeys = (Object.keys(FACT_NAMES) as FactKey[]).filter((k) => facts[k]);
  return {
    system: [
      `You sort messages that customers send to ${business}, a small business. You never answer them yourself.`,
      "Reply with JSON only: {\"intent\": one of order_status, balance, answer, fact, greeting, thanks, human, sensitive, other; \"answerId\": the id of the matching saved answer or null; \"fact\": one of " +
        `${factKeys.join(", ") || "none"} or null; "orderNumber": the order number the customer gives, or null; "topic": one of refund, complaint, legal, anger, negotiation, cancellation, or null; "confidence": 0 to 1; "summary": one sentence saying what the customer wants}.`,
      "Use sensitive with a topic for refunds, complaints, legal threats, anger, price negotiation and cancellations. Use human when they ask for a person in any language.",
      "Use answer only when one saved answer fully answers the message. Use other for anything else, including questions unrelated to this business.",
    ].join("\n"),
    user: [
      recent.length ? `Earlier in this conversation:\n${recent.map((r) => `- ${r.slice(0, 200)}`).join("\n")}` : "",
      candidates.length ? `Saved answers:\n${candidates.map((c) => `- ${c.id}: ${c.title}${c.examples.length ? ` (for example: ${c.examples.slice(0, 3).join("; ")})` : ""}`).join("\n")}` : "Saved answers: none",
      `Message:\n${text.slice(0, 1500)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

const INTENTS = new Set<CsIntent>(["order_status", "balance", "answer", "fact", "greeting", "thanks", "human", "sensitive", "other"]);
const TOPIC_SET = new Set<HumanTopic>(["refund", "complaint", "legal", "anger", "negotiation", "cancellation"]);

/**
 * The model's reading, checked: an answer id it made up, a fact the owner never wrote or a topic that is not one of
 * ours is dropped. The rules still win on the always-human topics and on asking for a person.
 */
export function parseClassification(raw: unknown, rules: Classification, candidates: CannedAnswer[], facts: BusinessFacts): Classification {
  let o: Record<string, unknown> | null = null;
  try {
    o = typeof raw === "string" ? (JSON.parse(raw.replace(/^[^{]*/, "").replace(/[^}]*$/, "")) as Record<string, unknown>) : (raw as Record<string, unknown>);
  } catch {
    return rules;
  }
  if (!o || typeof o !== "object") return rules;
  if (rules.intent === "sensitive" || rules.intent === "human") return rules;
  const intent = INTENTS.has(o.intent as CsIntent) ? (o.intent as CsIntent) : "other";
  const answerId = typeof o.answerId === "string" && candidates.some((c) => c.id === o!.answerId) ? o.answerId : null;
  const fact = typeof o.fact === "string" && o.fact in FACT_NAMES && facts[o.fact as FactKey] ? (o.fact as FactKey) : null;
  const topic = TOPIC_SET.has(o.topic as HumanTopic) ? (o.topic as HumanTopic) : null;
  const confidence = typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0.5;
  const orderNumber = typeof o.orderNumber === "string" && /^[A-Za-z0-9#-]{3,20}$/.test(o.orderNumber) ? o.orderNumber.replace(/^#/, "").toUpperCase() : rules.orderNumber;
  const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim().slice(0, 200) : rules.summary;
  const fixed: Classification = { intent, answerId, fact, orderNumber, topic, confidence, summary, method: "model" };
  if (intent === "answer" && !answerId) return { ...fixed, intent: "other", confidence: Math.min(confidence, 0.4) };
  if (intent === "fact" && !fact) return { ...fixed, intent: "other", confidence: Math.min(confidence, 0.4) };
  if (intent === "sensitive" && !topic) return { ...fixed, topic: "complaint" };
  return fixed;
}

/* ---------- Opening hours, in India for now ---------- */

const IST = 5.5 * 3600_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isOpen(f: BusinessFacts, now = Date.now()): boolean {
  const d = new Date(now + IST);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return f.openDays.includes(d.getUTCDay()) && m >= minutes(f.opensAt) && m < minutes(f.closesAt);
}

/** "later today at 09:30", "tomorrow at 09:30" or "on Monday at 09:30". */
export function nextOpening(f: BusinessFacts, now = Date.now()): string {
  const d = new Date(now + IST);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (!f.openDays.length) return "as soon as they can";
  for (let i = 0; i < 8; i++) {
    const day = (d.getUTCDay() + i) % 7;
    if (!f.openDays.includes(day)) continue;
    if (i === 0 && m >= minutes(f.opensAt)) continue;
    return `${i === 0 ? "later today" : i === 1 ? "tomorrow" : `on ${DAY_NAMES[day]}`} at ${f.opensAt}`;
  }
  return "as soon as they can";
}

/* ---------- What the customer reads ---------- */

/** Said once, in the first reply of every conversation, wherever the customer is. */
export function disclosure(business: string, facts: BusinessFacts): string {
  const human = facts.humanContact.trim();
  return `You are chatting with ${business || "our"}'s AI assistant. To reach a person at any time, ${human ? `contact ${human} or ` : ""}reply PERSON.`;
}

export function holdingReply(owner: string, facts: BusinessFacts, now = Date.now(), why?: string): string {
  const who = owner.trim().split(/\s+/)[0] || "Someone from the team";
  const when = isOpen(facts, now) ? "shortly" : `${nextOpening(facts, now)}, when we open`;
  return `${why ? `${why} ` : ""}I have passed this to ${who}, who will reply here ${when}. You do not need to repeat anything.`;
}

export const verifyPrompt = (channel: "whatsapp" | "email" | "web") =>
  channel === "web"
    ? "I can check that for you. Please send the order number together with the phone number or email address you gave when you ordered."
    : "I could not match this number to an order. Please send the order number together with the email address or phone number you gave when you ordered.";
