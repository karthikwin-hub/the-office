import { z } from "zod";
import { OfficeLocale } from "./locale";
import {
  AgentState,
  Bill,
  Business,
  Campaign,
  ComplianceEvent,
  Document,
  FestivalDate,
  Invoice,
  IsoDate,
  IsoDateTime,
  Lead,
  LogEntry,
  Paise,
  Party,
  BrandVoice,
  Channel,
  ContentCalendar,
  MediaAsset,
  Platform,
  Post,
  Quote,
  Ref,
  Rfq,
  SocialMessage,
  StagedChange,
  TrustLevel,
} from "./entities";

/** Prose with figures that link to their proof (the covering note) */
export const Segment = z.union([
  z.object({ text: z.string() }),
  z.object({ text: z.string(), figureId: z.string(), tone: z.enum(["red", "green"]).optional() }),
]);
export const Note = z.array(Segment);
export type Note = z.infer<typeof Note>;

export const RoomStatus = z.object({
  agentId: z.string(),
  hired: z.boolean(),
  trustLevel: TrustLevel,
  status: z.enum(["working", "idle", "waiting", "not_hired"]),
  now: z.string(),
  todayCount: z.number().int(),
  waitingCount: z.number().int(),
  /** The one figure that matters most in this room today, traceable like any other. */
  headline: z.object({ label: z.string(), value: z.string(), figureId: z.string().optional(), tone: z.enum(["red", "green"]).optional() }).optional(),
});
export type RoomStatus = z.infer<typeof RoomStatus>;

export const OfficeView = z.object({
  business: Business.pick({ name: true, legalName: true, gstin: true, asOf: true, owner: true, accountantFirm: true }),
  rooms: z.array(RoomStatus),
  log: z.array(LogEntry),
  deskCount: z.number().int(),
  arriving: z.array(z.object({ docId: z.string(), agentId: z.string(), label: z.string() })),
});
export type OfficeView = z.infer<typeof OfficeView>;

export const Kpi = z.object({
  label: z.string(),
  value: z.string(),
  figureId: z.string().optional(),
  tone: z.enum(["red", "green"]).optional(),
});
export type Kpi = z.infer<typeof Kpi>;

export const AgentRoomView = z.object({
  agentId: z.string(),
  state: AgentState,
  status: RoomStatus,
  kpis: z.array(Kpi),
  log: z.array(LogEntry),
  pending: z.array(StagedChange),
  accuracyPct: z.number().nullable(),
  promotion: z.object({ to: TrustLevel, reason: z.string() }).nullable(),
});
export type AgentRoomView = z.infer<typeof AgentRoomView>;

export const DeskView = z.object({ items: z.array(StagedChange), decided: z.array(StagedChange) });
export type DeskView = z.infer<typeof DeskView>;

export const Decision = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
  edits: z.record(z.unknown()).optional(),
});
export type Decision = z.infer<typeof Decision>;

/* ---------- Reports ---------- */

export const SkuSalesRow = z.object({
  skuId: z.string(),
  name: z.string(),
  category: z.string(),
  hsn: z.string(),
  unit: z.string(),
  qty: z.number().int(),
  invoices: z.number().int(),
  taxablePaise: Paise,
  marginPaise: Paise,
  marginPct: z.number(),
  sharePct: z.number(),
  cumulativePct: z.number(),
  figureId: z.string(),
});
export type SkuSalesRow = z.infer<typeof SkuSalesRow>;

export const SalesReport = z.object({
  from: IsoDate,
  to: IsoDate,
  note: Note,
  totals: z.object({ taxablePaise: Paise, taxPaise: Paise, invoices: z.number().int(), customers: z.number().int(), marginPaise: Paise }),
  bySku: z.array(SkuSalesRow),
  byCustomer: z.array(
    z.object({ partyId: z.string(), name: z.string(), city: z.string(), invoices: z.number().int(), taxablePaise: Paise, sharePct: z.number(), figureId: z.string() }),
  ),
  byMonth: z.array(z.object({ month: z.string(), taxablePaise: Paise, figureId: z.string() })),
});
export type SalesReport = z.infer<typeof SalesReport>;

export const AGEING_BUCKETS = ["Not yet due", "1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"] as const;

export const AgeingRow = z.object({
  partyId: z.string(),
  name: z.string(),
  city: z.string(),
  termsDays: z.number().int(),
  buckets: z.array(Paise).length(5),
  totalPaise: Paise,
  oldestDaysOverdue: z.number().int(),
  openInvoices: z.number().int(),
  avgDaysLate: z.number().nullable(),
  lastPaymentOn: IsoDate.nullable(),
  figureId: z.string(),
});
export type AgeingRow = z.infer<typeof AgeingRow>;

export const OpenInvoice = z.object({
  invoiceId: z.string(),
  number: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  date: IsoDate,
  dueDate: IsoDate,
  daysOverdue: z.number().int(),
  totalPaise: Paise,
  outstandingPaise: Paise,
  bucket: z.number().int().min(0).max(4),
  docId: z.string(),
});
export type OpenInvoice = z.infer<typeof OpenInvoice>;

export const AgeingReport = z.object({
  asOf: IsoDate,
  note: Note,
  bucketTotals: z.array(Paise).length(5),
  bucketFigureIds: z.array(z.string()).length(5),
  totalPaise: Paise,
  rows: z.array(AgeingRow),
  open: z.array(OpenInvoice),
});
export type AgeingReport = z.infer<typeof AgeingReport>;

const TaxSplit = z.object({ taxablePaise: Paise, cgstPaise: Paise, sgstPaise: Paise, igstPaise: Paise });
export const GstReport = z.object({
  period: z.string(),
  note: Note,
  outward: TaxSplit.extend({ invoices: z.number().int(), figureId: z.string() }),
  byRate: z.array(TaxSplit.extend({ rate: z.number().int() })),
  hsn: z.array(TaxSplit.extend({ hsn: z.string(), description: z.string(), uqc: z.string(), qty: z.number().int(), rate: z.number().int() })),
  itc: z.object({
    books: TaxSplit.extend({ figureId: z.string() }),
    eligible: TaxSplit.extend({ figureId: z.string() }),
    notIn2b: z.array(z.object({ billId: z.string(), number: z.string(), vendor: z.string(), date: IsoDate, taxPaise: Paise, docId: z.string() })),
  }),
  payable: z.object({ igstPaise: Paise, cgstPaise: Paise, sgstPaise: Paise, totalPaise: Paise }),
  filings: z.array(z.object({ form: z.string(), period: z.string(), status: z.enum(["draft", "filed", "not_started"]), dueOn: IsoDate, filedOn: IsoDate.nullable() })),
  periods: z.array(z.string()),
});
export type GstReport = z.infer<typeof GstReport>;

export const TdsDeduction = z.object({
  billId: z.string(),
  docId: z.string(),
  vendor: z.string(),
  pan: z.string(),
  section: z.string(),
  date: IsoDate,
  basePaise: Paise,
  expectedPaise: Paise,
  bookedPaise: Paise,
  filedPaise: Paise.nullable(),
  ruleRateBp: z.number().int(),
  bookedRateBp: z.number().int(),
});
export type TdsDeduction = z.infer<typeof TdsDeduction>;

export const TdsReport = z.object({
  quarter: z.string(),
  quarters: z.array(z.string()),
  note: Note,
  bySection: z.array(
    z.object({ section: z.string(), nature: z.string(), rate: z.string(), deductees: z.number().int(), basePaise: Paise, tdsPaise: Paise, figureId: z.string() }),
  ),
  deductions: z.array(TdsDeduction),
  receivable: z.array(
    z.object({ invoiceId: z.string(), number: z.string(), customer: z.string(), expectedPaise: Paise, creditedPaise: Paise, docId: z.string() }),
  ),
  sectionNote: z.string(),
});
export type TdsReport = z.infer<typeof TdsReport>;

export const CashReport = z.object({
  asOf: IsoDate,
  note: Note,
  months: z.array(z.object({ month: z.string(), receiptsPaise: Paise, paymentsPaise: Paise, netPaise: Paise })),
  weeks: z.array(
    z.object({
      weekOf: IsoDate,
      expectedInPaise: Paise,
      expectedOutPaise: Paise,
      items: z.array(z.object({ label: z.string(), amountPaise: Paise, direction: z.enum(["in", "out"]), date: IsoDate })),
    }),
  ),
  assumptions: z.array(z.string()),
});
export type CashReport = z.infer<typeof CashReport>;

export const Reorder = z.object({
  partyId: z.string(),
  name: z.string(),
  orders: z.number().int(),
  avgIntervalDays: z.number().int(),
  lastOrderOn: IsoDate,
  daysSince: z.number().int(),
  expectedOn: IsoDate,
  status: z.enum(["ok", "due", "late"]),
  typicalPaise: Paise,
});
export type Reorder = z.infer<typeof Reorder>;

export const SalesTeamReport = z.object({
  note: Note,
  pipeline: z.array(z.object({ stage: z.string(), count: z.number().int(), valuePaise: Paise })),
  leads: z.array(Lead),
  quotes: z.array(Quote.extend({ customer: z.string(), overdueWarning: z.string().nullable() })),
  reorders: z.array(Reorder),
});
export type SalesTeamReport = z.infer<typeof SalesTeamReport>;

export const MarketingReport = z.object({
  note: Note,
  campaigns: z.array(Campaign.extend({ skuNames: z.array(z.string()), returnMultiple: z.number().nullable() })),
  slowMovers: z.array(
    z.object({ skuId: z.string(), name: z.string(), onHand: z.number().int(), soldLast60: z.number().int(), daysOfStock: z.number().int().nullable(), stockValuePaise: Paise }),
  ),
  prices: z.array(
    z.object({
      skuId: z.string(),
      name: z.string(),
      ourPricePaise: Paise,
      offers: z.array(z.object({ marketplace: z.string(), seller: z.string(), pricePaise: Paise })),
      gapPct: z.number(),
    }),
  ),
  calendar: z.array(FestivalDate),
});
export type MarketingReport = z.infer<typeof MarketingReport>;

/** A check on a post, for one channel or for all of them. */
export const PostCheck = z.object({ key: z.string(), label: z.string(), ok: z.boolean(), detail: z.string(), channelId: z.string().nullable() });
export type PostCheck = z.infer<typeof PostCheck>;

export const SocialPerformance = z.object({
  byChannel: z.array(z.object({ channelId: z.string(), platform: Platform, posts: z.number().int(), views: z.number(), engagements: z.number(), rate: z.number(), enquiries: z.number() })),
  byPillar: z.array(z.object({ pillarId: z.string(), name: z.string(), posts: z.number().int(), views: z.number(), rate: z.number() })),
  /** From posts to invoices: leads that came from social, their quotes, and what those customers were invoiced since. */
  funnel: z.object({ posts: z.number().int(), views: z.number(), clicks: z.number(), enquiries: z.number(), leads: z.number().int(), quotes: z.number().int(), invoicedPaise: Paise, partyIds: z.array(z.string()), leadIds: z.array(z.string()) }),
  best: z.array(z.object({ postId: z.string(), channelId: z.string(), reason: z.string() })),
  experiment: z.string(),
});
export type SocialPerformance = z.infer<typeof SocialPerformance>;

export const SocialReport = z.object({
  note: Note,
  posts: z.array(Post),
  inbox: z.array(SocialMessage),
  ratings: z.object({ average: z.number(), count: z.number().int() }),
  channels: z.array(Channel),
  voice: BrandVoice,
  calendars: z.array(ContentCalendar),
  media: z.array(MediaAsset),
  checks: z.record(z.array(PostCheck)),
  performance: SocialPerformance,
});
export type SocialReport = z.infer<typeof SocialReport>;

/** What to post by hand on a channel that is not connected. */
export const PublishingPack = z.object({
  postId: z.string(),
  channelId: z.string(),
  platform: Platform,
  handle: z.string(),
  text: z.string(),
  media: z.array(MediaAsset),
  at: z.string(),
  steps: z.array(z.string()),
});
export type PublishingPack = z.infer<typeof PublishingPack>;

export const VariantEdit = z.object({ text: z.string().min(1).max(5000).optional(), link: z.string().url().nullable().optional(), mediaIds: z.array(z.string()).max(10).optional() });
export const MarkPosted = z.object({ url: z.string().url().max(500) });
export const ChannelSetup = z.object({ handle: z.string().min(1).max(100).optional(), mode: z.enum(["connected", "manual"]).optional(), postingHours: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).optional() });
export const MetricsImport = z.object({ content: z.string().min(1).max(2_000_000) });

export const OperationsReport = z.object({
  note: Note,
  stock: z.array(
    z.object({
      skuId: z.string(),
      name: z.string(),
      category: z.string(),
      onHand: z.number().int(),
      unit: z.string(),
      reorderPoint: z.number().int(),
      leadTimeDays: z.number().int(),
      soldLast30: z.number().int(),
      daysOfCover: z.number().int().nullable(),
      status: z.enum(["reorder", "ok", "excess"]),
      stockValuePaise: Paise,
    }),
  ),
  purchaseOrders: z.array(z.object({ id: z.string(), number: z.string(), vendor: z.string(), date: IsoDate, status: z.string(), lines: z.number().int(), totalPaise: Paise })),
  rfqs: z.array(Rfq.extend({ recommended: z.string(), reason: z.string() })),
  compliance: z.array(ComplianceEvent.extend({ daysLeft: z.number().int() })),
});
export type OperationsReport = z.infer<typeof OperationsReport>;

export const PayrollLine = z.object({
  employeeId: z.string(),
  name: z.string(),
  role: z.string(),
  grossPaise: Paise,
  payableDays: z.number(),
  earnedPaise: Paise,
  pfEmployeePaise: Paise,
  esiEmployeePaise: Paise,
  ptPaise: Paise,
  netPaise: Paise,
  pfEmployerPaise: Paise,
  esiEmployerPaise: Paise,
});
export type PayrollLine = z.infer<typeof PayrollLine>;

export const PeopleReport = z.object({
  period: z.string(),
  note: Note,
  lines: z.array(PayrollLine),
  totals: PayrollLine.omit({ employeeId: true, name: true, role: true, payableDays: true }),
  assumptions: z.array(z.string()),
});
export type PeopleReport = z.infer<typeof PeopleReport>;

/* ---------- The Auditor ---------- */

export const Finding = z.object({
  id: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  form: z.string(),
  period: z.string(),
  title: z.string(),
  explanation: z.string(),
  action: z.string(),
  impactPaise: Paise,
  evidence: z.array(z.object({ label: z.string(), ref: Ref })),
});
export type Finding = z.infer<typeof Finding>;

export const Comparison = z.object({
  form: z.string(),
  line: z.string(),
  booksPaise: Paise,
  filedPaise: Paise,
  diffPaise: Paise,
});
export type Comparison = z.infer<typeof Comparison>;

export const AuditReport = z.object({
  period: z.string(),
  periods: z.array(z.string()),
  note: Note,
  returns: z.array(z.object({ id: z.string(), form: z.string(), period: z.string(), status: z.string(), filedOn: IsoDate.nullable(), sharedOn: IsoDate.nullable(), matched: z.boolean() })),
  comparisons: z.array(Comparison),
  findings: z.array(Finding),
});
export type AuditReport = z.infer<typeof AuditReport>;

/* ---------- Drill-down ---------- */

export const TraceRow = z.object({
  label: z.string(),
  detail: z.string(),
  date: IsoDate,
  amountPaise: Paise,
  docId: z.string().nullable(),
  region: z.string().nullable(),
});
export type TraceRow = z.infer<typeof TraceRow>;

export const Trace = z.object({ figureId: z.string(), title: z.string(), totalPaise: Paise, rows: z.array(TraceRow) });
export type Trace = z.infer<typeof Trace>;

export const DocumentView = z.object({
  document: Document,
  invoice: Invoice.nullable(),
  bill: Bill.nullable(),
  party: Party.nullable(),
  outstandingPaise: Paise.nullable(),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const PartyView = z.object({
  party: Party,
  ageing: AgeingRow.nullable(),
  open: z.array(OpenInvoice),
  recent: z.array(z.object({ date: IsoDate, label: z.string(), amountPaise: Paise, docId: z.string().nullable() })),
  reminders: z.array(StagedChange),
});
export type PartyView = z.infer<typeof PartyView>;

/* ---------- Office Manager ---------- */

export const AskRequest = z.object({ question: z.string().min(1).max(500) });
export const AskResponse = z.object({ answer: Note, followUps: z.array(z.string()) });
export type AskResponse = z.infer<typeof AskResponse>;

/* ---------- Document intake ---------- */

/** A run of text from a PDF's text layer; positions are page fractions, origin top left. */
export const TextItem = z.object({ str: z.string().max(500), page: z.number().int().min(1), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type TextItem = z.infer<typeof TextItem>;
export const ReadRequest = z.object({ items: z.array(TextItem).max(6000) });
export const IngestResult = z.object({ document: Document, staged: StagedChange.nullable(), message: z.string() });
export type IngestResult = z.infer<typeof IngestResult>;

/* ---------- Hiring, settings, session ---------- */

export const HiringView = z.object({ agents: z.array(AgentState) });
export type HiringView = z.infer<typeof HiringView>;
export const HiringChange = z.object({ hired: z.boolean().optional(), trustLevel: TrustLevel.optional() });

export const Role = z.enum(["owner", "accountant"]);
export type Role = z.infer<typeof Role>;

export const Settings = z.object({
  business: Business,
  users: z.array(z.object({ name: z.string(), email: z.string(), role: Role })),
  /** Live office only: addresses the owner has invited who have not signed up yet. */
  invited: z.array(z.object({ email: z.string(), role: Role })).optional(),
  ingestEmail: z.string(),
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  reminderPolicy: z.object({ firstAfterDays: z.number().int(), firmAfterDays: z.number().int(), finalAfterDays: z.number().int(), sendFrom: z.string() }),
});
export type Settings = z.infer<typeof Settings>;

export const SkinId = z.enum(["blueprint", "open-plan", "cubicles", "counting-house", "loft", "night-shift", "lived-in"]);
export type SkinId = z.infer<typeof SkinId>;

/** One person's view of the office; it follows them from machine to machine. */
export const Prefs = z.object({ skin: SkinId.catch("blueprint"), wholeFloor: z.boolean().catch(false) });
export type Prefs = z.infer<typeof Prefs>;
export const DEFAULT_PREFS: Prefs = { skin: "blueprint", wholeFloor: false };
/** Reading forgives a retired skin; a change has to name one that exists. */
export const PrefsChange = z.object({ skin: SkinId, wholeFloor: z.boolean() }).partial().strict();

/* ---------- The office on WhatsApp ---------- */

export const WaLanguage = z.enum(["en", "hi", "mr", "gu", "ta", "te", "kn", "bn"]);
export type WaLanguage = z.infer<typeof WaLanguage>;
export const WA_LANGUAGE_NAMES: Record<WaLanguage, string> = {
  en: "English",
  hi: "हिन्दी (Hindi)",
  mr: "मराठी (Marathi)",
  gu: "ગુજરાતી (Gujarati)",
  ta: "தமிழ் (Tamil)",
  te: "తెలుగు (Telugu)",
  kn: "ಕನ್ನಡ (Kannada)",
  bn: "বাংলা (Bengali)",
};

/** One person's link between their own WhatsApp number and the office. The number itself is shown only masked. */
export const WhatsAppStatus = z.object({
  /** The office can send and receive WhatsApp messages: the Cloud API keys are set, or this is the demo. */
  available: z.boolean(),
  linked: z.boolean(),
  /** For example "+91 ••••• ••480". */
  number: z.string().nullable(),
  /** "auto" answers in the language of the person's last message. */
  language: z.union([z.literal("auto"), WaLanguage]),
  digest: z.boolean(),
  /** The office's own WhatsApp number to send JOIN to, when known. */
  businessNumber: z.string().nullable(),
  /** A paid template is set up, so the morning digest can reach them even after 24 hours of silence. */
  template: z.boolean(),
});
export type WhatsAppStatus = z.infer<typeof WhatsAppStatus>;
export const WhatsAppChange = z.object({ language: z.union([z.literal("auto"), WaLanguage]), digest: z.boolean() }).partial().strict();
export const JoinCode = z.object({ code: z.string().regex(/^\d{6}$/), expiresAt: IsoDateTime, businessNumber: z.string().nullable(), link: z.string().nullable() });
export type JoinCode = z.infer<typeof JoinCode>;
/** The demo phone on the mock site: a typed message, or one of the sample voice notes. */
export const WhatsAppDemoMessage = z.object({ text: z.string().max(2000).optional(), voice: z.string().optional() });
export const WhatsAppDemoReply = z.object({ heard: z.string().nullable(), reply: z.string() });
export type WhatsAppDemoReply = z.infer<typeof WhatsAppDemoReply>;

export const Session = z.object({ user: z.object({ name: z.string(), email: z.string() }), role: Role, mode: z.enum(["mock", "live"]) });
export type Session = z.infer<typeof Session>;

/* ---------- Offices: one account, any number of businesses ---------- */

export const OfficeStatus = z.enum(["active", "suspended", "deleting"]);
/** An office's own address is `<subdomain>.<APP_DOMAIN>`: lower-case letters, digits and inner hyphens, 2 to 32 long. */
export const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
/** Labels that are ours, never an office's: `app` signs businesses in, `console` is the platform owners', `demo` is the sample office. */
export const RESERVED_SUBDOMAINS = new Set(["console", "demo", "www", "app", "api", "admin", "auth", "mail", "email", "in", "help", "support", "status", "docs", "blog", "static", "cdn", "assets", "media", "dev", "staging", "test"]);
export const subdomainProblem = (label: string): string | null =>
  !SUBDOMAIN.test(label) ? "Use 2 to 32 lower-case letters, digits or hyphens, starting and ending with a letter or digit." : RESERVED_SUBDOMAINS.has(label) ? `"${label}" is kept for the product itself; choose another.` : null;

export const OfficeSummary = z.object({ id: z.string(), name: z.string(), role: Role, status: OfficeStatus, locale: OfficeLocale, subdomain: z.string().nullable().default(null) });
export type OfficeSummary = z.infer<typeof OfficeSummary>;
/** Who is signed in and which offices they can open. Nothing about any office's books. */
export const Me = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), emailVerified: z.boolean() }),
  offices: z.array(OfficeSummary),
  /** Opening an office or accepting an invitation needs a confirmed address. */
  verificationRequired: z.boolean(),
  /** Documents this person has not yet accepted in their current version. Nothing else opens until they have. */
  consentNeeded: z.array(z.object({ document: z.enum(["terms", "privacy"]), version: z.string() })).default([]),
  /** An open request to delete this account, if they made one. */
  deletionRequested: z.boolean().default(false),
});
export type Me = z.infer<typeof Me>;
export const OpenOffice = z.object({ name: z.string().trim().min(2).max(80) });
export const InvitationPeek = z.object({ officeName: z.string(), email: z.string(), role: Role });
export type InvitationPeek = z.infer<typeof InvitationPeek>;
export const AcceptInvitation = z.object({ token: z.string().min(20).max(100) });

/** The owner's view of the office as an account: its people, invitations, address and history. */
export const OfficeAdmin = z.object({
  id: z.string(),
  name: z.string(),
  status: OfficeStatus,
  ingestEmail: z.string(),
  /** The office's own web address, once an operator has given it one. */
  address: z.string().nullable().default(null),
  locale: OfficeLocale,
  /** When a deleted office is purged for good, if it is being deleted. */
  purgeAt: IsoDateTime.nullable(),
  members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), role: Role, since: IsoDateTime, you: z.boolean() })),
  invitations: z.array(z.object({ email: z.string(), role: Role, invitedBy: z.string(), expiresAt: IsoDateTime })),
  audit: z.array(z.object({ actor: z.string(), action: z.string(), detail: z.string().nullable(), at: IsoDateTime })),
});
export type OfficeAdmin = z.infer<typeof OfficeAdmin>;
export const OfficeRename = z.object({ name: z.string().trim().min(2).max(80) });
export const InviteRequest = z.object({ email: z.string().trim().email().max(200), role: Role.default("accountant") });
/** The link works once, for 14 days; the owner can pass it on themselves if the email does not arrive. */
export const InviteResult = z.object({ email: z.string(), link: z.string(), emailed: z.boolean(), expiresAt: IsoDateTime });
export type InviteResult = z.infer<typeof InviteResult>;
export const RoleChange = z.object({ role: Role });
export const TransferRequest = z.object({ userId: z.string().min(1) });
/** Deleting asks for the business name, typed out. */
export const DeleteOffice = z.object({ confirm: z.string() });

/* ---------- Routes ---------- */

/** Routes for the account, outside any office. */
/* ---------- The platform owners' console: every business on the platform, never its books ---------- */

export const PlatformBusiness = z.object({
  id: z.string(),
  name: z.string(),
  status: OfficeStatus,
  opened: IsoDateTime,
  /** Who opened it: null when the business signed up itself, else the platform owner who onboarded it. */
  onboardedBy: z.string().nullable(),
  address: z.string().nullable(),
  ingestEmail: z.string(),
  owners: z.array(z.object({ name: z.string(), email: z.string() })),
  people: z.number().int(),
  /** The latest owner invitation not yet accepted. */
  ownerInvite: z.object({ email: z.string(), expiresAt: IsoDateTime, expired: z.boolean() }).nullable(),
  /** The last change to the account (people, invitations, settings, status); not the work in the books. */
  lastEvent: IsoDateTime.nullable(),
});
export type PlatformBusiness = z.infer<typeof PlatformBusiness>;
export const PlatformView = z.object({ you: z.object({ name: z.string(), email: z.string() }), businesses: z.array(PlatformBusiness) });
export type PlatformView = z.infer<typeof PlatformView>;
export const PlatformOnboard = z.object({ name: z.string().trim().min(2).max(80), ownerEmail: z.string().trim().email().max(200) });
export const PlatformStatusChange = z.object({ status: z.enum(["active", "suspended"]) });
/** The owner's link works once, for 14 days; it is shown in case the email does not arrive. */
export const PlatformInvited = z.object({ id: z.string(), name: z.string(), email: z.string(), link: z.string(), emailed: z.boolean(), expiresAt: IsoDateTime });
export type PlatformInvited = z.infer<typeof PlatformInvited>;

export const PLATFORM_ROUTES = {
  view: "/api/platform",
  businesses: "/api/platform/businesses",
  status: (id: string) => `/api/platform/businesses/${encodeURIComponent(id)}/status`,
  ownerInvite: (id: string) => `/api/platform/businesses/${encodeURIComponent(id)}/owner-invitation`,
} as const;

export const ACCOUNT_ROUTES = {
  me: "/api/me",
  offices: "/api/offices",
  invitation: (token: string) => `/api/invitations/${encodeURIComponent(token)}`,
  acceptInvitation: "/api/invitations/accept",
  consent: "/api/account/consent",
  accountExport: "/api/account/export",
  accountRequests: "/api/account/requests",
} as const;

/** Every route below is inside one office: the app sends it as `/api/o/<office id>/...`. */
export const ROUTES = {
  officeAdmin: "/api/office-admin",
  officeRestore: "/api/office-admin/restore",
  officeInvitations: "/api/office-admin/invitations",
  officeInvitation: (email: string) => `/api/office-admin/invitations/${encodeURIComponent(email)}`,
  officeMember: (userId: string) => `/api/office-admin/members/${encodeURIComponent(userId)}`,
  officeTransfer: "/api/office-admin/transfer",
  officeLeave: "/api/office-admin/leave",
  officeExport: "/api/office-admin/export",
  session: "/api/session",
  office: "/api/office",
  agent: (id: string) => `/api/agents/${id}`,
  desk: "/api/desk",
  decide: (id: string) => `/api/desk/${id}`,
  sales: "/api/reports/sales",
  ageing: "/api/reports/ageing",
  gst: "/api/reports/gst",
  tds: "/api/reports/tds",
  cash: "/api/reports/cash",
  salesTeam: "/api/reports/sales-team",
  marketing: "/api/reports/marketing",
  social: "/api/reports/social",
  operations: "/api/reports/operations",
  people: "/api/reports/people",
  audit: "/api/audit",
  trace: (figureId: string) => `/api/trace/${encodeURIComponent(figureId)}`,
  document: (id: string) => `/api/documents/${id}`,
  documents: "/api/documents",
  unread: "/api/documents/unread",
  readDocument: (id: string) => `/api/documents/${id}/read`,
  file: (id: string) => `/api/files/${id}`,
  importReturn: "/api/returns/import",
  onboardingCheck: "/api/onboarding/check",
  onboardingStage: "/api/onboarding/stage",
  party: (id: string) => `/api/parties/${id}`,
  ask: "/api/ask",
  hiring: "/api/hiring",
  hire: (agentId: string) => `/api/hiring/${agentId}`,
  settings: "/api/settings",
  prefs: "/api/prefs",
  whatsapp: "/api/whatsapp",
  whatsappCode: "/api/whatsapp/code",
  whatsappDemo: "/api/whatsapp/demo",
  exportGstr1: (period: string) => `/api/exports/gstr1/${period}`,
  exportGstr3b: (period: string) => `/api/exports/gstr3b/${period}`,
  exportTds: (quarter: string) => `/api/exports/tds/${quarter}`,
  socialVoice: "/api/social/voice",
  socialChannel: (id: string) => `/api/social/channels/${id}`,
  socialConnect: (platform: string) => `/api/channels/${platform}/connect`,
  socialCalendarDraft: "/api/social/calendar/draft",
  socialVariant: (postId: string, channelId: string) => `/api/social/posts/${postId}/variants/${channelId}`,
  socialPosted: (postId: string, channelId: string) => `/api/social/posts/${postId}/variants/${channelId}/posted`,
  socialPack: (postId: string, channelId: string) => `/api/social/posts/${postId}/variants/${channelId}/pack`,
  socialMetricsImport: "/api/social/metrics/import",
  socialMedia: "/api/social/media",
  routines: "/api/routines",
  routine: (id: string) => `/api/routines/${encodeURIComponent(id)}`,
  routineRuns: (id: string) => `/api/routines/${encodeURIComponent(id)}/runs`,
  runRoutine: (id: string) => `/api/routines/${encodeURIComponent(id)}/run`,
  customers: "/api/customers",
  customerThread: (id: string) => `/api/customers/threads/${encodeURIComponent(id)}`,
  customerReply: (id: string) => `/api/customers/threads/${encodeURIComponent(id)}/reply`,
  customerFacts: "/api/customers/facts",
  customerSettings: "/api/customers/settings",
  customerAnswers: "/api/customers/answers",
  customerAnswer: (id: string) => `/api/customers/answers/${encodeURIComponent(id)}`,
  customerWidget: "/api/customers/widget",
  customerTry: "/api/customers/try",
  orders: "/api/orders",
  order: (id: string) => `/api/orders/${encodeURIComponent(id)}`,
  ordersImport: "/api/orders/import",
  ambient: "/api/ambient",
  personas: "/api/personas",
  weather: "/api/weather",
} as const;
