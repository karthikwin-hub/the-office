import type { StagedKind } from "./entities";

export type TeamId = "front" | "accounts" | "sales" | "marketing" | "social" | "operations" | "people";

export const TEAMS: { id: TeamId; name: string; wing: string }[] = [
  { id: "front", name: "Front office", wing: "Reception" },
  { id: "accounts", name: "Accounts", wing: "Accounts wing" },
  { id: "sales", name: "Sales", wing: "Sales floor" },
  { id: "marketing", name: "Marketing", wing: "Marketing" },
  { id: "social", name: "Social media", wing: "Studio" },
  { id: "operations", name: "Operations", wing: "Stores and compliance" },
  { id: "people", name: "People", wing: "People" },
];

export type AgentDef = {
  id: string;
  title: string;
  short: string;
  team: TeamId;
  job: string;
  duties: string[];
  proposes: StagedKind[];
  /** what the room counts today, e.g. "documents read" */
  countLabel: string;
  /** Phase in which the agent works on live data */
  livePhase: 1 | 2 | 3;
};

export const AGENTS: AgentDef[] = [
  {
    id: "office-manager",
    title: "The Office Manager",
    short: "Office manager",
    team: "front",
    job: "Your single point of contact. Answers questions about the business with figures you can check, routes work to the right agent and raises issues that cross teams.",
    duties: ["Answer questions with linked figures", "Send the morning digest", "Flag issues between agents"],
    proposes: [],
    countLabel: "questions answered",
    livePhase: 1,
  },
  {
    id: "customer-service",
    title: "The Customer Service Agent",
    short: "Customer service",
    team: "front",
    job: "Answers your customers on WhatsApp, email and your website: order and invoice status, your usual answers, opening hours and policies. Anything it cannot answer from your records, or anything sensitive, it hands to you with a summary and a suggested reply.",
    duties: ["Answer from your own answers and records", "Tell customers they are talking to an AI, and how to reach you", "Hand refunds, complaints and anything unclear to you"],
    proposes: ["customer_reply", "handoff"],
    countLabel: "conversations",
    livePhase: 3,
  },
  {
    id: "accountant",
    title: "The Accountant",
    short: "Accountant",
    team: "accounts",
    job: "Reads every sales invoice and purchase bill that arrives by email or upload, and prepares ledger entries that keep a link to the page they came from.",
    duties: ["Read invoices and bills", "Prepare ledger entries for approval", "Match bank receipts to invoices"],
    proposes: ["ledger_entry"],
    countLabel: "documents read",
    livePhase: 1,
  },
  {
    id: "credit-controller",
    title: "The Credit Controller",
    short: "Credit controller",
    team: "accounts",
    job: "Tracks what each customer owes and when it was due, and drafts reminders that become firmer as an invoice ages. Nothing is sent without your approval.",
    duties: ["Track due dates from invoice terms", "Keep the ageing report current", "Draft payment reminders"],
    proposes: ["reminder"],
    countLabel: "reminders drafted",
    livePhase: 1,
  },
  {
    id: "tax-clerk",
    title: "The Tax Clerk",
    short: "Tax clerk",
    team: "accounts",
    job: "Works out GST and TDS from the books using fixed rules, not guesswork, and prepares the files your accountant uploads.",
    duties: ["Compute GSTR-1 and GSTR-3B", "Compute TDS by section", "Prepare files for your accountant"],
    proposes: ["share_file"],
    countLabel: "returns prepared",
    livePhase: 1,
  },
  {
    id: "auditor",
    title: "The Auditor",
    short: "Auditor",
    team: "accounts",
    job: "Compares what your accountant has filed or drafted with what the books say, and explains every difference in plain language.",
    duties: ["Compare returns with the books", "Check input tax credit against GSTR-2B", "Check TDS against the rules and Form 26AS"],
    proposes: ["audit_flag"],
    countLabel: "differences found",
    livePhase: 1,
  },
  {
    id: "sales-rep",
    title: "The Sales Rep",
    short: "Sales rep",
    team: "sales",
    job: "Qualifies new enquiries, keeps every lead moving and records what each customer needs.",
    duties: ["Qualify enquiries", "Follow up on open leads", "Keep the pipeline current"],
    proposes: [],
    countLabel: "leads followed up",
    livePhase: 2,
  },
  {
    id: "quote-desk",
    title: "The Quote Desk",
    short: "Quote desk",
    team: "sales",
    job: "Builds GST-correct quotations from your price list and checks the customer's payment record before anything is sent.",
    duties: ["Draft quotations", "Apply discounts within your limits", "Warn about customers with overdue invoices"],
    proposes: ["quote"],
    countLabel: "quotations drafted",
    livePhase: 2,
  },
  {
    id: "account-manager",
    title: "The Account Manager",
    short: "Account manager",
    team: "sales",
    job: "Learns each customer's ordering rhythm and nudges them when a reorder is late.",
    duties: ["Predict reorders", "Draft reorder nudges", "Spot customers buying less"],
    proposes: [],
    countLabel: "customers checked",
    livePhase: 2,
  },
  {
    id: "marketer",
    title: "The Marketer",
    short: "Marketer",
    team: "marketing",
    job: "Plans campaigns around slow-moving stock and the festival and wedding calendar, and reports what each campaign sold.",
    duties: ["Find slow-moving SKUs", "Draft campaigns", "Report sales from each campaign"],
    proposes: ["campaign"],
    countLabel: "campaigns tracked",
    livePhase: 3,
  },
  {
    id: "market-watcher",
    title: "The Market Watcher",
    short: "Market watcher",
    team: "marketing",
    job: "Checks marketplace prices for your key SKUs every morning so your quotes stay competitive.",
    duties: ["Track competitor prices", "Flag where you are priced out"],
    proposes: [],
    countLabel: "prices checked",
    livePhase: 3,
  },
  {
    id: "social-media-manager",
    title: "The Social Media Manager",
    short: "Social media",
    team: "social",
    job: "Drafts posts from your catalogue and replies to comments and reviews in your voice. Nothing is published without approval.",
    duties: ["Draft and schedule posts", "Draft replies to comments and reviews", "Watch review ratings"],
    proposes: ["post", "social_reply"],
    countLabel: "replies drafted",
    livePhase: 3,
  },
  {
    id: "storekeeper",
    title: "The Storekeeper",
    short: "Storekeeper",
    team: "operations",
    job: "Watches stock against reorder points and lead times, and drafts purchase orders before you run out.",
    duties: ["Track stock levels", "Set reorder points from sales", "Draft purchase orders"],
    proposes: ["purchase_order"],
    countLabel: "SKUs checked",
    livePhase: 3,
  },
  {
    id: "buyer",
    title: "The Buyer",
    short: "Buyer",
    team: "operations",
    job: "Collects vendor quotes and recommends the best mix of price, lead time and credit terms.",
    duties: ["Compare vendor quotes", "Recommend suppliers"],
    proposes: [],
    countLabel: "quotes compared",
    livePhase: 3,
  },
  {
    id: "compliance-officer",
    title: "The Compliance Officer",
    short: "Compliance",
    team: "operations",
    job: "Keeps the filing calendar for GST, TDS, PF, ESI, professional tax and company law, and warns you well before each date.",
    duties: ["Keep the filing calendar", "Warn before due dates"],
    proposes: [],
    countLabel: "dates checked",
    livePhase: 1,
  },
  {
    id: "payroll-clerk",
    title: "The Payroll Clerk",
    short: "Payroll",
    team: "people",
    job: "Prepares the monthly payroll from attendance, with PF, ESI and professional tax worked out for each person.",
    duties: ["Prepare payroll from attendance", "Compute PF, ESI and professional tax", "Prepare payslips"],
    proposes: ["payroll_run"],
    countLabel: "payslips prepared",
    livePhase: 3,
  },
];

export const AGENT_BY_ID: Record<string, AgentDef> = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

export const TRUST_LEVELS = [
  { id: "trainee", name: "Trainee", meaning: "Every action waits for your approval." },
  { id: "trusted", name: "Trusted", meaning: "Routine actions run on their own; anything unusual waits for you." },
  { id: "autonomous", name: "Autonomous", meaning: "Acts on its own and reports what it did." },
] as const;

/** Minimum accuracy over checked work before a promotion is offered */
export const PROMOTION_RULES = { trusted: { minChecked: 50, minAccuracy: 0.97 }, autonomous: { minChecked: 300, minAccuracy: 0.995 } };
