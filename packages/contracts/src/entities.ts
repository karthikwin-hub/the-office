import { z } from "zod";

/** Every amount is an integer number of paise. */
export const Paise = z.number().int();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoDateTime = z.string();
export const StateCode = z.string().regex(/^\d{2}$/);
export const Gstin = z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);

export const Business = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  pan: z.string(),
  /** Blank until the owner enters it in Settings; a new office starts without one. */
  gstin: Gstin.or(z.literal("")),
  tan: z.string(),
  stateCode: StateCode.or(z.literal("")),
  address: z.string(),
  email: z.string(),
  phone: z.string(),
  bank: z.string(),
  fyStart: IsoDate,
  asOf: IsoDate,
  prevYearTurnoverPaise: Paise,
  owner: z.string(),
  accountantFirm: z.string(),
  /**
   * The first day these books are kept for, set by the first approved import of existing books and then fixed.
   * Invoices and bills brought forward from before it count towards balances, but never towards returns or sales.
   */
  booksFrom: IsoDate.optional(),
});
export type Business = z.infer<typeof Business>;

export const Contact = z.object({ name: z.string(), phone: z.string(), email: z.string() });

export const TdsSection = z.enum(["194C", "194H", "194I", "194J", "194Q"]);
export type TdsSection = z.infer<typeof TdsSection>;

export const Party = z.object({
  id: z.string(),
  kind: z.enum(["customer", "vendor"]),
  name: z.string(),
  entity: z.enum(["company", "firm", "individual"]),
  gstin: Gstin.nullable(),
  pan: z.string(),
  stateCode: StateCode,
  city: z.string(),
  contact: Contact,
  paymentTermsDays: z.number().int().optional(),
  creditLimitPaise: Paise.optional(),
  buyerType: z.string().optional(),
  tan: z.string().nullable().optional(),
  supplyKind: z.enum(["goods", "service", "professional", "rent", "commission"]).optional(),
  tdsSection: TdsSection.nullable().optional(),
  tdsRateBp: z.number().int().optional(),
});
export type Party = z.infer<typeof Party>;

export const Sku = z.object({
  id: z.string(),
  name: z.string(),
  hsn: z.string(),
  unit: z.string(),
  gstRate: z.number().int(),
  pricePaise: Paise,
  costPaise: Paise,
  category: z.string(),
});
export type Sku = z.infer<typeof Sku>;

/** [x, y, w, h] as fractions of the page, origin top-left */
export const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Region = z.object({ key: z.string(), label: z.string(), page: z.number().int(), box: Box });
export type Region = z.infer<typeof Region>;

export const DocumentStatus = z.enum(["reading", "staged", "posted", "rejected"]);
export const Document = z.object({
  id: z.string(),
  kind: z.enum(["sales_invoice", "purchase_bill"]),
  refId: z.string().nullable(),
  file: z.string(),
  pages: z.number().int(),
  receivedAt: IsoDateTime,
  channel: z.enum(["generated", "email", "upload", "whatsapp", "import"]),
  from: z.string().nullable(),
  status: DocumentStatus,
  regions: z.array(Region),
});
export type Document = z.infer<typeof Document>;

export const Line = z.object({
  skuId: z.string().nullable(),
  description: z.string(),
  hsn: z.string(),
  qty: z.number().int(),
  unit: z.string(),
  ratePaise: Paise,
  discountPct: z.number().int(),
  taxablePaise: Paise,
  gstRate: z.number().int(),
  cgstPaise: Paise,
  sgstPaise: Paise,
  igstPaise: Paise,
});
export type Line = z.infer<typeof Line>;

export const Totals = z.object({
  taxablePaise: Paise,
  cgstPaise: Paise,
  sgstPaise: Paise,
  igstPaise: Paise,
  roundOffPaise: Paise,
  totalPaise: Paise,
});
export type Totals = z.infer<typeof Totals>;

export const Invoice = z.object({
  id: z.string(),
  number: z.string(),
  date: IsoDate,
  partyId: z.string(),
  docId: z.string(),
  placeOfSupply: StateCode,
  reverseCharge: z.boolean(),
  termsDays: z.number().int(),
  dueDate: IsoDate,
  lines: z.array(Line),
  totals: Totals,
  status: z.enum(["staged", "posted", "cancelled"]),
  /** Brought forward from before `booksFrom`: what is still owed on it, outside returns and sales. */
  opening: z.boolean().optional(),
});
export type Invoice = z.infer<typeof Invoice>;

export const BillTds = z.object({ section: TdsSection, rateBp: z.number().int(), basePaise: Paise, amountPaise: Paise });
export type BillTds = z.infer<typeof BillTds>;

export const Bill = z.object({
  id: z.string(),
  number: z.string(),
  date: IsoDate,
  partyId: z.string(),
  docId: z.string(),
  kind: z.enum(["goods", "service", "professional", "rent", "commission"]),
  placeOfSupply: StateCode,
  lines: z.array(Line),
  totals: Totals,
  itcEligible: z.boolean(),
  tds: BillTds.nullable(),
  status: z.enum(["staged", "posted", "rejected"]),
  /** Brought forward from before `booksFrom`: what is still owed on it, outside returns and input tax credit. */
  opening: z.boolean().optional(),
});
export type Bill = z.infer<typeof Bill>;

export const Allocation = z.object({
  invoiceId: z.string().optional(),
  billId: z.string().optional(),
  amountPaise: Paise,
  tdsPaise: Paise,
});
export const Payment = z.object({
  id: z.string(),
  date: IsoDate,
  partyId: z.string(),
  direction: z.enum(["in", "out"]),
  amountPaise: Paise,
  mode: z.string(),
  reference: z.string(),
  allocations: z.array(Allocation),
  tdsDeductedPaise: Paise,
  tdsSection: TdsSection.nullable(),
});
export type Payment = z.infer<typeof Payment>;

/* ---------- GST and TDS return formats (subset of the official JSON) ---------- */

const ItmDet = z.object({ rt: z.number(), txval: z.number(), iamt: z.number(), camt: z.number(), samt: z.number(), csamt: z.number() });
export const Gstr1 = z.object({
  gstin: z.string(),
  fp: z.string(),
  b2b: z.array(
    z.object({
      ctin: z.string(),
      inv: z.array(
        z.object({
          inum: z.string(),
          idt: z.string(),
          val: z.number(),
          pos: z.string(),
          rchrg: z.string(),
          inv_typ: z.string(),
          itms: z.array(z.object({ num: z.number(), itm_det: ItmDet })),
        }),
      ),
    }),
  ),
  hsn: z.object({
    data: z.array(
      z.object({
        num: z.number(),
        hsn_sc: z.string(),
        desc: z.string(),
        uqc: z.string(),
        qty: z.number(),
        rt: z.number(),
        txval: z.number(),
        iamt: z.number(),
        camt: z.number(),
        samt: z.number(),
        csamt: z.number(),
      }),
    ),
  }),
});
export type Gstr1 = z.infer<typeof Gstr1>;

const TaxAmounts = z.object({ iamt: z.number(), camt: z.number(), samt: z.number(), csamt: z.number() });
export const Gstr3b = z.object({
  gstin: z.string(),
  ret_period: z.string(),
  sup_details: z.object({ osup_det: TaxAmounts.extend({ txval: z.number() }) }),
  itc_elg: z.object({ itc_avl: z.array(TaxAmounts.extend({ ty: z.string() })) }),
});
export type Gstr3b = z.infer<typeof Gstr3b>;

export const TdsReturnRow = z.object({
  section: TdsSection,
  deducteePan: z.string(),
  deducteeName: z.string(),
  billId: z.string(),
  paidOn: IsoDate,
  amountPaidPaise: Paise,
  tdsPaise: Paise,
  depositedOn: IsoDate,
});
export type TdsReturnRow = z.infer<typeof TdsReturnRow>;
export const Tds26q = z.object({ tan: z.string(), quarter: z.string(), deductions: z.array(TdsReturnRow) });
export type Tds26q = z.infer<typeof Tds26q>;

const ReturnBase = {
  id: z.string(),
  period: z.string(),
  status: z.enum(["draft", "filed"]),
  filedOn: IsoDate.nullable(),
  sharedOn: IsoDate.nullable(),
  dueOn: IsoDate,
  filedBy: z.string(),
};
export const FiledReturn = z.discriminatedUnion("form", [
  z.object({ ...ReturnBase, form: z.literal("GSTR-1"), data: Gstr1 }),
  z.object({ ...ReturnBase, form: z.literal("GSTR-3B"), data: Gstr3b }),
  z.object({ ...ReturnBase, form: z.literal("26Q"), data: Tds26q }),
]);
export type FiledReturn = z.infer<typeof FiledReturn>;

export const Gstr2bEntry = z.object({
  ctin: z.string(),
  trdnm: z.string(),
  inum: z.string(),
  idt: z.string(),
  val: z.number(),
  txval: z.number(),
  iamt: z.number(),
  camt: z.number(),
  samt: z.number(),
});
export const Gstr2b = z.object({
  period: z.string(),
  data: z.object({ gstin: z.string(), rtnprd: z.string(), docdata: z.object({ b2b: z.array(Gstr2bEntry) }) }),
});
export type Gstr2b = z.infer<typeof Gstr2b>;

export const Form26asCredit = z.object({
  quarter: z.string(),
  deductorTan: z.string(),
  deductorName: z.string(),
  section: TdsSection,
  invoiceId: z.string(),
  receiptId: z.string(),
  creditedOn: IsoDate,
  amountPaidPaise: Paise,
  tdsCreditedPaise: Paise,
});
export type Form26asCredit = z.infer<typeof Form26asCredit>;

/* ---------- Sales ---------- */

export const LeadStage = z.enum(["new", "contacted", "quoted", "won", "lost"]);
export const Lead = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  source: z.string(),
  stage: LeadStage,
  valuePaise: Paise,
  need: z.string(),
  createdOn: IsoDate,
  lastTouchOn: IsoDate,
  nextStep: z.string(),
});
export type Lead = z.infer<typeof Lead>;

export const Quote = z.object({
  id: z.string(),
  number: z.string(),
  date: IsoDate,
  leadId: z.string().nullable(),
  partyId: z.string().nullable(),
  status: z.enum(["draft", "sent", "accepted", "expired"]),
  validUntil: IsoDate,
  lines: z.array(Line),
  totals: Totals,
});
export type Quote = z.infer<typeof Quote>;

/* ---------- Marketing ---------- */

export const Campaign = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.string(),
  skuIds: z.array(z.string()),
  status: z.enum(["draft", "planned", "running", "ended"]),
  start: IsoDate,
  end: IsoDate,
  budgetPaise: Paise,
  spentPaise: Paise,
  reach: z.number().int(),
  enquiries: z.number().int(),
  attributedSalesPaise: Paise,
});
export type Campaign = z.infer<typeof Campaign>;

export const FestivalDate = z.object({ date: IsoDate, name: z.string(), relevance: z.string() });
export const CompetitorPrice = z.object({
  skuId: z.string(),
  marketplace: z.string(),
  seller: z.string(),
  pricePaise: Paise,
  seenOn: IsoDate,
});
export type CompetitorPrice = z.infer<typeof CompetitorPrice>;

/* ---------- Social ---------- */

/** Channels the Social Media Manager can work on. Google is reviews and updates, kept by hand. */
export const Platform = z.enum(["instagram", "facebook", "threads", "linkedin", "x", "whatsapp", "google"]);
export type Platform = z.infer<typeof Platform>;

export const PLATFORM_NAMES: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  linkedin: "LinkedIn",
  x: "X",
  whatsapp: "WhatsApp",
  google: "Google Business Profile",
};

/** Reads a platform out of a free-text label such as "Google reviews" or "WhatsApp broadcast". */
export function platformOf(label: string): Platform {
  const s = label.toLowerCase();
  if (s.includes("insta")) return "instagram";
  if (s.includes("facebook")) return "facebook";
  if (s.includes("thread")) return "threads";
  if (s.includes("linkedin")) return "linkedin";
  if (s.includes("whatsapp")) return "whatsapp";
  if (s === "x" || s.includes("twitter")) return "x";
  return "google";
}

export const Channel = z.object({
  id: z.string(),
  platform: Platform,
  handle: z.string(),
  /** Connected channels publish and listen through their API; manual ones get a publishing pack. */
  mode: z.enum(["connected", "manual"]),
  status: z.enum(["connected", "manual", "expired", "rate_limited", "error"]),
  lastError: z.string().nullable().default(null),
  connectedAt: IsoDateTime.nullable().default(null),
  followers: z.number().int().nullable().default(null),
  postingHours: z.object({ from: z.string(), to: z.string() }).default({ from: "09:00", to: "21:00" }),
});
export type Channel = z.infer<typeof Channel>;

/** Books saved before channels existed get one per platform, posted by hand until connected. Ids match the upgraded posts. */
const defaultChannels = () => Platform.options.map((platform) => ({ id: `ch-${platform}`, platform, handle: "", mode: "manual" as const, status: "manual" as const }));

export const Pillar = z.object({ id: z.string(), name: z.string(), share: z.number().int().min(0).max(100), description: z.string() });
export type Pillar = z.infer<typeof Pillar>;

export const Language = z.enum(["en", "hi", "mr"]);
export type Language = z.infer<typeof Language>;

export const BrandVoice = z.object({
  tone: z.string(),
  dos: z.array(z.string()),
  donts: z.array(z.string()),
  samples: z.array(z.string()),
  languages: z.array(Language).min(1),
  hashtags: z.array(z.string()),
  emoji: z.enum(["none", "light", "free"]),
  pillars: z.array(Pillar),
  signoff: z.string(),
});
export type BrandVoice = z.infer<typeof BrandVoice>;

export const DEFAULT_VOICE: BrandVoice = {
  tone: "Plain, warm and practical, like a counter manager who knows the products.",
  dos: ["Name the product and what it does for the buyer", "Say where and when stock is available"],
  donts: ["No claims we cannot prove", "No competitor names"],
  samples: [],
  languages: ["en"],
  hashtags: [],
  emoji: "light",
  pillars: [
    { id: "products", name: "Products in stock", share: 40, description: "What is on the shelf and who it suits" },
    { id: "know-how", name: "Know-how", share: 30, description: "Safety, wiring and energy tips" },
    { id: "offers", name: "Offers and events", share: 20, description: "Schemes, meets and festival timings" },
    { id: "behind", name: "Behind the counter", share: 10, description: "Team, deliveries and customers" },
  ],
  signoff: "",
};

export const MediaAsset = z.object({
  id: z.string(),
  url: z.string(),
  kind: z.enum(["image", "video"]),
  alt: z.string(),
  skuId: z.string().nullable(),
  rights: z.enum(["own", "stock", "generated"]),
  width: z.number().int().nullable().default(null),
  height: z.number().int().nullable().default(null),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** A figure a post may state, with where it comes from. Checks match every number in a post to one of these. */
export const PostFact = z.object({
  id: z.string(),
  kind: z.enum(["price", "discount", "stock", "date", "spec", "count"]),
  label: z.string(),
  value: z.string(),
  ref: z.object({ kind: z.string(), id: z.string().nullable() }),
});
export type PostFact = z.infer<typeof PostFact>;

export const PostMetrics = z.object({
  views: z.number(),
  likes: z.number(),
  comments: z.number(),
  saves: z.number(),
  shares: z.number().default(0),
  clicks: z.number().default(0),
  enquiries: z.number().default(0),
});
export type PostMetrics = z.infer<typeof PostMetrics>;

export const VariantStatus = z.enum(["draft", "scheduled", "published", "failed", "skipped"]);
export const PostVariant = z.object({
  channelId: z.string(),
  platform: Platform,
  text: z.string(),
  mediaIds: z.array(z.string()).default([]),
  link: z.string().nullable().default(null),
  status: VariantStatus,
  externalId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  publishedAt: IsoDateTime.nullable().default(null),
  error: z.string().nullable().default(null),
  /** Hash of the text as the owner approved it; a calendar post that has changed since goes back to the desk. */
  approvedHash: z.string().nullable().default(null),
  metrics: PostMetrics.nullable().default(null),
});
export type PostVariant = z.infer<typeof PostVariant>;

const PostShape = z.object({
  id: z.string(),
  topic: z.string(),
  pillar: z.string().nullable().default(null),
  calendarId: z.string().nullable().default(null),
  campaignId: z.string().nullable().default(null),
  status: z.enum(["draft", "scheduled", "published"]),
  at: IsoDateTime,
  skuIds: z.array(z.string()),
  facts: z.array(PostFact).default([]),
  variants: z.array(PostVariant).min(1),
});

/** One topic, written natively for each channel. Older single-platform posts are upgraded on load. */
export const Post = z.preprocess((raw) => {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || Array.isArray(p.variants)) return raw;
  const platform = platformOf(String(p.platform ?? ""));
  return {
    ...p,
    topic: String(p.text ?? "").split(/[.!?]/)[0]!.slice(0, 80),
    variants: [{ channelId: `ch-${platform}`, platform, text: p.text, status: p.status, metrics: p.metrics ?? null, publishedAt: p.status === "published" ? p.at : null }],
  };
}, PostShape);
export type Post = z.infer<typeof PostShape>;

const MessageShape = z.object({
  id: z.string(),
  platform: z.string(),
  channelId: z.string(),
  kind: z.enum(["comment", "review", "dm", "mention"]),
  author: z.string(),
  at: IsoDateTime,
  rating: z.number().int().nullable(),
  text: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  intent: z.enum(["enquiry", "complaint", "praise", "question", "spam"]),
  draftReply: z.string(),
  status: z.enum(["open", "replied"]),
  postId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  externalId: z.string().nullable().default(null),
  leadId: z.string().nullable().default(null),
  /** WhatsApp only allows a free reply within 24 hours of the customer's last message. */
  replyBy: IsoDateTime.nullable().default(null),
});

export const SocialMessage = z.preprocess((raw) => {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m.kind) return raw;
  const platform = platformOf(String(m.platform ?? ""));
  const text = String(m.text ?? "").toLowerCase();
  const intent = /\b(price|rate|quote|stock|available|need|pieces|pcs|order)\b|\?$/.test(text) && m.sentiment !== "negative" ? (/\b(price|rate|quote|need|pieces|pcs|order|stock)\b/.test(text) ? "enquiry" : "question") : m.sentiment === "negative" ? "complaint" : m.sentiment === "positive" ? "praise" : "question";
  return { ...m, channelId: `ch-${platform}`, kind: m.rating !== null && m.rating !== undefined ? "review" : "comment", intent };
}, MessageShape);
export type SocialMessage = z.infer<typeof MessageShape>;

export const CalendarSlot = z.object({ date: IsoDate, pillarId: z.string(), topic: z.string(), channelIds: z.array(z.string()), postId: z.string().nullable() });
export type CalendarSlot = z.infer<typeof CalendarSlot>;

export const ContentCalendar = z.object({
  id: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  status: z.enum(["draft", "approved", "superseded"]),
  slots: z.array(CalendarSlot),
  createdAt: IsoDateTime,
  approvedAt: IsoDateTime.nullable().default(null),
  approvedBy: z.string().nullable().default(null),
});
export type ContentCalendar = z.infer<typeof ContentCalendar>;

/* ---------- Operations ---------- */

export const StockLevel = z.object({
  skuId: z.string(),
  onHand: z.number().int(),
  reorderPoint: z.number().int(),
  leadTimeDays: z.number().int(),
  location: z.string(),
  lastReceivedOn: IsoDate,
});
export type StockLevel = z.infer<typeof StockLevel>;

export const PurchaseOrder = z.object({
  id: z.string(),
  number: z.string(),
  vendorId: z.string(),
  date: IsoDate,
  status: z.enum(["draft", "sent", "received"]),
  lines: z.array(z.object({ skuId: z.string(), qty: z.number().int(), ratePaise: Paise })),
  totalPaise: Paise,
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

export const Rfq = z.object({
  id: z.string(),
  title: z.string(),
  skuId: z.string(),
  qty: z.number().int(),
  quotes: z.array(z.object({ vendorName: z.string(), ratePaise: Paise, leadDays: z.number().int(), terms: z.string() })),
});
export type Rfq = z.infer<typeof Rfq>;

export const ComplianceEvent = z.object({
  id: z.string(),
  date: IsoDate,
  form: z.string(),
  description: z.string(),
  authority: z.string(),
  status: z.enum(["upcoming", "done", "overdue"]),
});
export type ComplianceEvent = z.infer<typeof ComplianceEvent>;

/* ---------- Customer service ---------- */

export const OrderStatus = z.enum(["received", "packed", "dispatched", "delivered", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** A customer's order, kept so the Customer Service agent can say where it is. Added by hand, from a CSV or by a WhatsApp command. */
export const Order = z.object({
  id: z.string(),
  number: z.string().min(1).max(40),
  partyId: z.string().nullable().default(null),
  customer: z.string().max(120),
  /** The phone and email on the order: only someone writing from one of them is told about it. */
  phone: z.string().max(30).default(""),
  email: z.string().max(200).default(""),
  items: z.string().max(500),
  status: OrderStatus,
  placedOn: IsoDate,
  expectedOn: IsoDate.nullable().default(null),
  tracking: z.string().max(500).nullable().default(null),
  note: z.string().max(500).default(""),
  updatedAt: IsoDateTime,
});
export type Order = z.infer<typeof Order>;

/** One of the owner's usual answers: one topic, a few ways customers ask it, and the reply sent word for word. */
export const CannedAnswer = z.object({
  id: z.string(),
  title: z.string().min(1).max(120),
  examples: z.array(z.string().max(300)).max(10),
  answer: z.string().min(1).max(2000),
  enabled: z.boolean(),
});
export type CannedAnswer = z.infer<typeof CannedAnswer>;

/** What the agent may say about the business itself. An empty fact is never guessed at; the question goes to the owner. */
export const BusinessFacts = z.object({
  hours: z.string().max(300).default(""),
  /** When a person is around to answer, in the office's time zone; outside it, a hand-off says when to expect a reply. */
  opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:30"),
  closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("19:00"),
  /** 0 is Sunday. */
  openDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5, 6]),
  address: z.string().max(500).default(""),
  delivery: z.string().max(1000).default(""),
  returns: z.string().max(1000).default(""),
  payments: z.string().max(500).default(""),
  /** How a customer reaches a person, said in every disclosure: a phone number, an email or "reply PERSON". */
  humanContact: z.string().max(200).default(""),
});
export type BusinessFacts = z.infer<typeof BusinessFacts>;
export type FactKey = "hours" | "address" | "delivery" | "returns" | "payments";

export const CustomerServiceSetup = z.object({
  facts: BusinessFacts,
  answers: z.array(CannedAnswer).default([]),
  /** The chat on the business's website. The key is public; it only finds this office's widget. */
  widget: z.object({ enabled: z.boolean(), key: z.string().nullable() }).default({ enabled: false, key: null }),
  /** Conversations older than this are deleted by the morning round. */
  retentionMonths: z.number().int().min(1).max(36).default(12),
  /** The address the business forwards its support mail to, once the agent is hired. */
  supportEmail: z.string().nullable().default(null),
});
export type CustomerServiceSetup = z.infer<typeof CustomerServiceSetup>;
export const DEFAULT_CUSTOMER_SERVICE: CustomerServiceSetup = { facts: BusinessFacts.parse({}), answers: [], widget: { enabled: false, key: null }, retentionMonths: 12, supportEmail: null };

/* ---------- People ---------- */

export const Employee = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  monthlyGrossPaise: Paise,
  joinedOn: IsoDate,
  pan: z.string().nullable(),
  attendance: z.object({
    period: z.string(),
    workingDays: z.number().int(),
    present: z.number().int(),
    paidLeave: z.number().int(),
    unpaidAbsence: z.number().int(),
  }),
});
export type Employee = z.infer<typeof Employee>;

/* ---------- The team ---------- */

export const TrustLevel = z.enum(["trainee", "trusted", "autonomous"]);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const AgentState = z.object({
  agentId: z.string(),
  hired: z.boolean(),
  trustLevel: TrustLevel,
  hiredOn: IsoDate.nullable(),
  accuracy: z.object({ checked: z.number().int(), correct: z.number().int() }),
});
export type AgentState = z.infer<typeof AgentState>;

export const RefKind = z.enum([
  "document",
  "party",
  "report",
  "return",
  "audit",
  "quote",
  "lead",
  "campaign",
  "post",
  "social",
  "channel",
  "calendar",
  "purchase_order",
  "compliance",
  "figure",
  "conversation",
  "order",
]);
export const Ref = z.object({ kind: RefKind, id: z.string().nullable(), region: z.string().optional() });
export type Ref = z.infer<typeof Ref>;

export const LogEntry = z.object({
  id: z.string(),
  at: IsoDateTime,
  agentId: z.string(),
  text: z.string(),
  ref: Ref.nullable(),
});
export type LogEntry = z.infer<typeof LogEntry>;

export const StagedKind = z.enum([
  "ledger_entry",
  "reminder",
  "audit_flag",
  "share_file",
  "quote",
  "campaign",
  "post",
  "social_reply",
  "calendar",
  "broadcast",
  "purchase_order",
  "payroll_run",
  "customer_reply",
  "handoff",
  "onboarding",
]);
export type StagedKind = z.infer<typeof StagedKind>;

export const StagedChange = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: StagedKind,
  createdAt: IsoDateTime,
  title: z.string(),
  summary: z.string(),
  evidence: z.array(z.object({ label: z.string(), ref: Ref })),
  payload: z.record(z.unknown()),
  status: z.enum(["pending", "approved", "rejected"]),
  decidedAt: IsoDateTime.optional(),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
});
export type StagedChange = z.infer<typeof StagedChange>;

/* ---------- The whole dataset ---------- */

export const Books = z.object({
  seed: z.number().int(),
  generatedFor: IsoDate,
  business: Business,
  states: z.record(z.string()),
  parties: z.array(Party),
  skus: z.array(Sku),
  documents: z.array(Document),
  invoices: z.array(Invoice),
  bills: z.array(Bill),
  payments: z.array(Payment),
  filedReturns: z.array(FiledReturn),
  gstr2b: z.array(Gstr2b),
  form26as: z.array(Form26asCredit),
  leads: z.array(Lead),
  quotes: z.array(Quote),
  campaigns: z.array(Campaign),
  festivalCalendar: z.array(FestivalDate),
  competitorPrices: z.array(CompetitorPrice),
  posts: z.array(Post),
  socialInbox: z.array(SocialMessage),
  channels: z.array(Channel).default(defaultChannels),
  brandVoice: BrandVoice.default(DEFAULT_VOICE),
  calendars: z.array(ContentCalendar).default([]),
  media: z.array(MediaAsset).default([]),
  stock: z.array(StockLevel),
  purchaseOrders: z.array(PurchaseOrder),
  rfqs: z.array(Rfq),
  compliance: z.array(ComplianceEvent),
  employees: z.array(Employee),
  orders: z.array(Order).default([]),
  customerService: CustomerServiceSetup.default(DEFAULT_CUSTOMER_SERVICE),
  agents: z.array(AgentState),
  teamLog: z.array(LogEntry),
  staged: z.array(StagedChange),
});
export type Books = z.infer<typeof Books>;
