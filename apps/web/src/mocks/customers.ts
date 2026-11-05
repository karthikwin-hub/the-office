import type { Role } from "@office/contracts";
import { converse, type OfficeService, RoutineError, type RoutineHost, runMockEffects, runNow } from "@office/engine";
import { sampleConversations, sampleCustomerService, sampleRoutineRuns } from "@office/fixtures";
import { HttpResponse } from "msw";

/** The sample office's Customer Service agent, its orders and a morning of conversations; and a week of routine runs. */
export function seedMock(office: OfficeService) {
  const cs = sampleCustomerService(office.asOf);
  office.books.customerService = cs.setup;
  office.books.orders = cs.orders;
  const state = office.books.agents.find((a) => a.agentId === "customer-service")!;
  Object.assign(state, { hired: true, trustLevel: "trusted", hiredOn: office.asOf });
  for (const m of sampleConversations(Date.now())) office.customers.receive(m, office.customers.prepare(m).rules);
  settleCs(office);
  for (const r of sampleRoutineRuns(office.asOf, office.settings().digestTime)) office.routines.record(r);
  office.routines.setPaused("morning-digest", false);
}

/** Nothing leaves the mockup: every reply is marked sent, and hand-offs reach no one's phone. */
export function settleCs(office: OfficeService) {
  for (const e of office.customers.takeEffects()) if (e.kind === "send") office.customers.markSent(e.messageId, `mock-${e.messageId}`);
}

function mockHost(office: OfficeService): RoutineHost {
  return {
    sendReminders: async (items) => {
      for (const i of items) (i.payload as { sentAt?: string }).sentAt = new Date().toISOString();
      return { sent: items.length, failed: 0 };
    },
    socialMorning: async () => ({ outcome: "nothing", summary: "In the sample office no platform is connected, so there were no new results." }),
    publish: async () => {
      office.publishDue(new Date().toISOString());
      const effects = office.takeEffects();
      runMockEffects(office, effects);
      return effects.length ? { summary: `${effects.length} ${effects.length === 1 ? "post" : "posts"} published (pretend).`, counts: { published: effects.length } } : { outcome: "nothing", summary: "No post was due." };
    },
    digest: async (notes) => ({ summary: `In the live office this goes to the owners by email or WhatsApp. ${office.pending().length} waiting on the desk${notes.length ? `; ${notes.length} lines from the routines` : ""}.`, counts: { waiting: office.pending().length } }),
  };
}

/** The routes the engine's dispatch cannot answer alone: "Run now" and trying the agent. */
export async function mockMore(request: Request, path: string, role: Role, office: OfficeService): Promise<Response | null> {
  const run = /^\/api\/routines\/([a-z-]+)\/run$/.exec(path);
  if (run && request.method === "POST") {
    if (role !== "owner") return HttpResponse.json({ error: "Only the owner can run a routine." }, { status: 403 });
    try {
      return HttpResponse.json(await runNow(office, run[1]!, mockHost(office)));
    } catch (e) {
      return HttpResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof RoutineError ? 409 : 404 });
    } finally {
      settleCs(office);
    }
  }
  if (path === "/api/customers/try" && request.method === "POST") {
    if (role !== "owner") return HttpResponse.json({ error: "Only the owner can try the agent." }, { status: 403 });
    const body = (await request.json().catch(() => ({}))) as { text?: string };
    const text = String(body.text ?? "").trim().slice(0, 2000);
    if (!text) return HttpResponse.json({ error: "Write a message to try." }, { status: 400 });
    const r = await converse(office.customers, { channel: "web", key: "try:owner", name: "You, trying it", text, test: true });
    return HttpResponse.json({ thread: office.customers.threadView(r.thread.id), notes: r.notes });
  }
  return null;
}
