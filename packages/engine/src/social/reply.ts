import type { Books, BusinessFacts, CannedAnswer, FactKey, SocialMessage } from "@office/contracts";
import { type Classification, classifierPrompt, classifyRules, decisive, FACT_NAMES, HUMAN_TOPIC_NAMES, MIN_CONFIDENCE, scoreAnswers } from "../customer/brain";
import { figuresIn } from "./checks";
import { draftReply, greetName } from "./inbox";

/** Text that tries to steer the agent instead of asking the business something. It always goes to the owner. */
const STEERING =
  /\b(ignore (all |any |the |your )?(previous|prior|above|earlier|other) (instructions|rules|prompts?)|system prompt|disregard (your|the|all) (instructions|rules)|you are now (an? )?(ai|assistant|bot|chatbot)|pretend (to be|you are) (an? )?(ai|assistant|bot)|new instructions)\b/i;

export type ReplyPlan = Pick<SocialMessage, "draftReply" | "basis" | "answerId" | "toOwner" | "sortedBy">;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The owner's words a reply quotes: a saved answer, or a business fact. */
export function sourceText(books: Pick<Books, "customerService">, answerId: string | null): string | null {
  if (!answerId) return null;
  if (answerId.startsWith("fact:")) return books.customerService.facts[answerId.slice(5) as FactKey] || null;
  return books.customerService.answers.find((a) => a.id === answerId && a.enabled)?.answer ?? null;
}

/** Every figure in the reply is one the owner wrote in the answer or fact it quotes. */
export function backedBySource(reply: string, source: string | null): boolean {
  const own = new Set(figuresIn(source ?? "").map((f) => `${f.kind}:${f.value}`));
  return figuresIn(reply).every((f) => own.has(`${f.kind}:${f.value}`));
}

/**
 * What to reply, and whether it may go without the owner. The words come from the owner's saved answers and business
 * facts, quoted as written, or from a thank-you; the model only ever picks which one. Steering, complaints, refunds,
 * price talk, asking for a person, orders and balances, and anything no answer fits wait for the owner.
 */
export function planReply(
  books: Pick<Books, "customerService" | "business">,
  m: Pick<SocialMessage, "author" | "intent" | "sentiment" | "kind" | "platform" | "text" | "rating">,
  c: Classification,
): ReplyPlan {
  const name = greetName(m.author);
  const first = name ?? "They";
  const thanks = `Thanks for asking${name ? `, ${name}` : ""}.`;
  // A rules match that is not certain waits for the model's look, or for the owner where there is no model.
  const unsure = c.method === "rules" && !decisive(c);
  const held = (why: string): ReplyPlan => ({
    draftReply: draftReply(m, books.business.name, books.business.phone),
    basis: "template",
    answerId: null,
    toOwner: why,
    sortedBy: c.method,
  });
  if (STEERING.test(m.text)) return held("it tries to give the agent instructions");
  // A 4 or 5 star review is praise even when its words also name a price.
  const praise = m.sentiment === "positive" && (m.intent === "praise" || (m.kind === "review" && (m.rating ?? 0) >= 4));
  // "Best price, thank you!" is praise, not haggling; a refund, legal threat or anger never is.
  if (c.intent === "sensitive" && !(praise && c.topic === "negotiation")) return held(`${first} ${HUMAN_TOPIC_NAMES[c.topic ?? "complaint"]}`);
  if (c.intent === "human") return held(`${first} asks for a person`);
  if (m.intent === "complaint" || m.sentiment === "negative") return held(`${first} is unhappy`);
  if (praise)
    return {
      draftReply: draftReply({ ...m, intent: "praise" }, books.business.name, books.business.phone),
      basis: "thanks",
      answerId: null,
      toOwner: null,
      sortedBy: c.method,
    };
  if (c.intent === "answer" && c.answerId) {
    const a = books.customerService.answers.find((x) => x.id === c.answerId && x.enabled);
    if (a)
      return {
        draftReply: `${thanks} ${a.answer}`,
        basis: "saved_answer",
        answerId: a.id,
        toOwner: c.confidence < MIN_CONFIDENCE || unsure ? `not sure your saved answer "${a.title}" fits` : null,
        sortedBy: c.method,
      };
  }
  if (c.intent === "fact" && c.fact && books.customerService.facts[c.fact])
    return {
      draftReply: `${thanks} ${sentence(FACT_NAMES[c.fact])}: ${books.customerService.facts[c.fact]}`,
      basis: "fact",
      answerId: `fact:${c.fact}`,
      toOwner: c.confidence < MIN_CONFIDENCE || unsure ? `not sure your ${FACT_NAMES[c.fact]} answers it` : null,
      sortedBy: c.method,
    };
  if (c.intent === "thanks" || c.intent === "greeting")
    return {
      draftReply: draftReply({ ...m, intent: "praise" }, books.business.name, books.business.phone),
      basis: "thanks",
      answerId: null,
      toOwner: null,
      sortedBy: c.method,
    };
  if (c.intent === "order_status" || c.intent === "balance") return held(`${first} asks about an order or what they owe, which is not answered in public`);
  return held("none of your saved answers fits");
}

/** The rules' reading of a message, from the owner's saved answers and facts. */
export const sortByRules = (books: Pick<Books, "customerService">, text: string): Classification =>
  classifyRules(text, books.customerService.answers, books.customerService.facts);

/** Whether the model could add anything: the rules are unsure, and steering never reaches it. */
export const worthAsking = (m: Pick<SocialMessage, "text">, c: Classification) => !decisive(c) && !STEERING.test(m.text);

/** The model's prompt for one message: it picks among the closest saved answers and the facts written, nothing else. */
export function inboxPrompt(
  books: Pick<Books, "customerService" | "business">,
  text: string,
): { system: string; user: string; candidates: CannedAnswer[]; facts: BusinessFacts } {
  // The closest answers first, then the owner's others: shared words miss "fan" against "fans", and a small business has few.
  const scored = scoreAnswers(text, books.customerService.answers).map((s) => s.answer);
  const rest = books.customerService.answers.filter((a) => a.enabled && !scored.includes(a));
  const candidates = [...scored, ...rest].slice(0, 8);
  const facts = books.customerService.facts;
  return { ...classifierPrompt(books.business.name || "the business", text, [], candidates, facts), candidates, facts };
}
