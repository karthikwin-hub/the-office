import { z } from "zod";
import { BusinessFacts, CannedAnswer, IsoDate, IsoDateTime, Order, OrderStatus } from "./entities";
import { Kpi } from "./api";

export const CsChannel = z.enum(["whatsapp", "email", "web"]);
export type CsChannel = z.infer<typeof CsChannel>;
export const CS_CHANNEL_NAMES: Record<CsChannel, string> = { whatsapp: "WhatsApp", email: "Email", web: "Website chat" };

/**
 * One customer's conversation on one channel. Kept in the office's own storage, outside the books,
 * and deleted after the retention period.
 */
export const CsThread = z.object({
  id: z.string(),
  channel: CsChannel,
  /** The phone number, email address or website visitor the conversation is with. */
  key: z.string(),
  name: z.string(),
  /** The customer in the books, once the agent is sure who it is talking to. */
  partyId: z.string().nullable(),
  /** The phone or email the customer proved, for matching orders. */
  verifiedContact: z.string().nullable(),
  status: z.enum(["open", "waiting", "handed_off", "resolved"]),
  subject: z.string().nullable(),
  startedAt: IsoDateTime,
  lastAt: IsoDateTime,
  lastInboundAt: IsoDateTime.nullable(),
  /** The customer has been told they are talking to an AI and how to reach a person. */
  disclosed: z.boolean(),
  handoffs: z.number().int(),
  /** How long the first reply took, in seconds. */
  firstReplySeconds: z.number().int().nullable(),
  /** The owner trying the agent from its room; nothing in it is sent anywhere. */
  test: z.boolean().default(false),
});
export type CsThread = z.infer<typeof CsThread>;

/** What a reply was built from: one of the owner's answers, a business fact, a lookup, or nothing but courtesy. */
export const CsGround = z.enum(["answer", "fact", "order", "balance", "verify", "greeting", "holding", "owner", "none"]);
export type CsGround = z.infer<typeof CsGround>;

export const CsMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  at: IsoDateTime,
  direction: z.enum(["in", "out"]),
  by: z.enum(["customer", "agent", "owner"]),
  text: z.string(),
  intent: z.string().nullable(),
  ground: CsGround.nullable(),
  status: z.enum(["received", "sent", "draft", "failed", "withdrawn"]),
  externalId: z.string().nullable(),
  error: z.string().nullable(),
});
export type CsMessage = z.infer<typeof CsMessage>;

export const CsThreadView = z.object({ thread: CsThread, messages: z.array(CsMessage), pending: z.array(z.string()) });
export type CsThreadView = z.infer<typeof CsThreadView>;

export const CustomerDeskView = z.object({
  threads: z.array(CsThread.extend({ preview: z.string(), waiting: z.boolean() })),
  kpis: z.array(Kpi),
  facts: BusinessFacts,
  answers: z.array(CannedAnswer),
  widget: z.object({ enabled: z.boolean(), key: z.string().nullable(), snippet: z.string().nullable() }),
  supportEmail: z.string().nullable(),
  retentionMonths: z.number().int(),
  /** WhatsApp replies sent this calendar month; Meta's first 1,000 service messages a month are free. */
  whatsappThisMonth: z.number().int(),
});
export type CustomerDeskView = z.infer<typeof CustomerDeskView>;

export const AnswerInput = CannedAnswer.omit({ id: true }).extend({ examples: z.array(z.string().trim().min(1).max(300)).max(10).default([]) });
export const FactsInput = BusinessFacts.partial();
export const CsSettingsInput = z.object({ retentionMonths: z.number().int().min(1).max(36) }).strict();
export const WidgetChange = z.object({ enabled: z.boolean() }).strict();
export const OrderInput = z.object({
  number: z.string().trim().min(1).max(40),
  customer: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).default(""),
  email: z.string().trim().max(200).default(""),
  items: z.string().trim().max(500).default(""),
  status: OrderStatus.default("received"),
  placedOn: IsoDate.optional(),
  expectedOn: IsoDate.nullable().optional(),
  tracking: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});
export const OrderChange = OrderInput.partial();
export const OrdersImport = z.object({ content: z.string().min(1).max(1_000_000) });
export const OrdersImportResult = z.object({ added: z.number().int(), updated: z.number().int(), skipped: z.array(z.string()) });
export type OrdersImportResult = z.infer<typeof OrdersImportResult>;
export const OrdersView = z.object({ orders: z.array(Order) });
export type OrdersView = z.infer<typeof OrdersView>;
/** The owner writing into a conversation themselves. */
export const OwnerReply = z.object({ text: z.string().trim().min(1).max(4000) });
/** Trying the agent as a customer would, from its room. Nothing leaves the office. */
export const TryMessage = z.object({ text: z.string().trim().min(1).max(2000), name: z.string().trim().max(80).optional() });
export const TryResult = z.object({ thread: CsThreadView });
export type TryResult = z.infer<typeof TryResult>;

/** The website chat, as the widget on the business's own site talks to it. Public, keyed and rate limited. */
export const ChatPost = z.object({
  visitor: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  text: z.string().trim().min(1).max(2000),
  name: z.string().trim().max(80).optional(),
  turnstile: z.string().max(4096).optional(),
});
export const ChatMessages = z.object({ messages: z.array(z.object({ id: z.string(), at: IsoDateTime, from: z.enum(["you", "us"]), text: z.string() })), business: z.string() });
export type ChatMessages = z.infer<typeof ChatMessages>;
