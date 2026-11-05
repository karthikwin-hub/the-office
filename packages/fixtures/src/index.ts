/// <reference path="./json.d.ts" />
import raw from "../data/office.json";
import { AGENTS, Books, DEFAULT_VOICE } from "@office/contracts";

const sample = raw as { seed: number; states: Record<string, string> };

/**
 * The seeded sample business (Kaveri Electricals), validated against the contracts.
 * Regenerate with `pnpm data`. Each call returns a fresh copy that callers may mutate.
 */
export function loadBooks(): Books {
  return Books.parse(structuredClone(raw));
}

export { sampleRoutineRuns } from "./routines";
export { sampleCustomerService, sampleConversations } from "./customers";

export const SEED_AS_OF = "2026-11-04";
/** The sample business's generator seed; empty books use 0. */
export const SAMPLE_SEED = sample.seed;

/** India's financial year starts on 1 April. */
const fyStart = (asOf: string) => {
  const [y, m] = asOf.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04-01`;
};

/**
 * A new business's books: no records yet, the business details left for the owner to fill in
 * under Settings, and only the Office Manager and the Accountant on the team, as trainees.
 */
export function emptyBooks(opts: { owner: string; asOf: string; email?: string }): Books {
  return Books.parse({
    seed: 0,
    generatedFor: opts.asOf,
    business: { id: "office", name: "Your business", legalName: "", pan: "", gstin: "", tan: "", stateCode: "", address: "", email: opts.email ?? "", phone: "", bank: "", fyStart: fyStart(opts.asOf), asOf: opts.asOf, prevYearTurnoverPaise: 0, owner: opts.owner, accountantFirm: "" },
    states: structuredClone(sample.states),
    parties: [],
    skus: [],
    documents: [],
    invoices: [],
    bills: [],
    payments: [],
    filedReturns: [],
    gstr2b: [],
    form26as: [],
    leads: [],
    quotes: [],
    campaigns: [],
    festivalCalendar: [],
    competitorPrices: [],
    posts: [],
    socialInbox: [],
    brandVoice: {
      ...DEFAULT_VOICE,
      tone: "Plain, warm and practical, like someone behind the counter who knows the products.",
      pillars: [
        { id: "products", name: "Products and services", share: 40, description: "What you sell and who it suits" },
        { id: "know-how", name: "Know-how", share: 30, description: "Tips that help customers choose and use it" },
        { id: "offers", name: "Offers and events", share: 20, description: "Schemes, events and festival timings" },
        { id: "behind", name: "Behind the counter", share: 10, description: "Team, deliveries and customers" },
      ],
    },
    stock: [],
    purchaseOrders: [],
    rfqs: [],
    compliance: [],
    employees: [],
    agents: AGENTS.map((a) => {
      const hired = a.id === "office-manager" || a.id === "accountant";
      return { agentId: a.id, hired, trustLevel: "trainee", hiredOn: hired ? opts.asOf : null, accuracy: { checked: 0, correct: 0 } };
    }),
    teamLog: [],
    staged: [],
  });
}
