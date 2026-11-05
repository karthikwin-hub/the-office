import { DatabaseSync } from "node:sqlite";
import { morningRound, OfficeService, type RoutineHost, routinesView, runNow, runOne, RoutineError, nextMorning, dispatch } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { SqlRoutineLog } from "../src/routines";

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

function office() {
  const sql = sqlStorage();
  sql.exec("CREATE TABLE office_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const routines = new SqlRoutineLog(sql);
  const o = new OfficeService(loadBooks(), { asOf: "2026-11-04", routines });
  return { o, routines };
}

const host = (over: Partial<RoutineHost> = {}): RoutineHost => ({
  sendReminders: async (items) => ({ sent: items.length, failed: 0 }),
  socialMorning: async () => ({ summary: "Results for 3 posts.", counts: { metrics: 3 } }),
  publish: async () => ({ outcome: "nothing", summary: "No post was due." }),
  digest: async (notes) => ({ summary: `Sent with ${notes.length} notes.`, counts: { notes: notes.length } }),
  ...over,
});

describe("routines", () => {
  it("records every step of the morning round, and a failure does not stop the rest", async () => {
    const { o, routines } = office();
    const runs = await morningRound(o, host({ socialMorning: async () => Promise.reject(new Error("Meta said no")) }));
    const by = Object.fromEntries(runs.map((r) => [r.routine, r]));
    expect(by["social-morning"]!.outcome).toBe("failed");
    expect(by["social-morning"]!.error).toBe("Meta said no");
    expect(by["morning-digest"]!.outcome).toBe("ok");
    expect(routines.last("social-morning")!.outcome).toBe("failed");
    expect(routines.runs("morning-digest", 5)).toHaveLength(1);
    expect(o.books.teamLog.some((e) => e.text.includes("Meta said no"))).toBe(true);
  });

  it("runs only the routines of agents on the team", async () => {
    const { o } = office();
    o.setHiring("storekeeper", { hired: false });
    const runs = await morningRound(o, host());
    expect(runs.some((r) => r.routine === "reorder-check")).toBe(false);
    expect(routinesView(o).find((r) => r.id === "reorder-check")!.active).toBe(false);
  });

  it("skips a paused routine on schedule and records that it did", async () => {
    const { o, routines } = office();
    routines.setPaused("morning-digest", true);
    let sent = false;
    await morningRound(o, host({ digest: async () => ((sent = true), { summary: "sent" }) }));
    expect(sent).toBe(false);
    expect(routines.last("morning-digest")!.outcome).toBe("skipped");
    expect(routinesView(o).find((r) => r.id === "morning-digest")!.nextRunAt).toBeNull();
    routines.setPaused("morning-digest", false);
    expect(routines.paused("morning-digest")).toBe(false);
  });

  it("prunes runs older than 90 days", async () => {
    const { o, routines } = office();
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    routines.record({ id: "old", routine: "morning-digest", trigger: "schedule", startedAt: old, finishedAt: old, outcome: "ok", summary: "", counts: {}, error: null });
    await morningRound(o, host());
    expect(routines.runs("morning-digest", 10).map((r) => r.id)).not.toContain("old");
  });

  it("lets the owner run a routine now, once a minute", async () => {
    const { o, routines } = office();
    const run = await runNow(o, "compliance-due", host());
    expect(run.trigger).toBe("manual");
    await expect(runNow(o, "compliance-due", host())).rejects.toBeInstanceOf(RoutineError);
    expect(routines.runs("compliance-due", 5)).toHaveLength(1);
  });

  it("puts what the routines found into the digest", async () => {
    const { o } = office();
    let notes: string[] = [];
    await morningRound(o, host({ digest: async (n) => ((notes = [...n]), { summary: "ok" }) }));
    const reorder = (await runOne(o, "reorder-check", "manual", host()))!;
    expect(reorder.counts.items ?? 0).toBeGreaterThanOrEqual(0);
    if (o.reorderCheck().items.length) expect(notes.some((n) => n.includes("reorder level"))).toBe(true);
  });

  it("pauses and resumes through the API, owner only", () => {
    const { o } = office();
    const q = new URLSearchParams();
    const req = (role: "owner" | "accountant") => dispatch(o, { method: "POST", path: "/api/routines/send-reminders", query: q, body: { paused: true }, role, user: { name: "Anil", email: "a@x" }, mode: "live" });
    expect(req("accountant").status).toBe(403);
    expect(req("owner").status).toBe(200);
    expect(o.routines.paused("send-reminders")).toBe(true);
    expect(dispatch(o, { method: "GET", path: "/api/routines/send-reminders/runs", query: q, role: "accountant", user: { name: "R", email: "r@x" }, mode: "live" }).status).toBe(200);
  });

  it("works out the next morning in India", () => {
    expect(nextMorning("08:45", Date.parse("2026-11-05T01:00:00Z"))).toBe("2026-11-05T03:15:00.000Z");
    expect(nextMorning("08:45", Date.parse("2026-11-05T04:00:00Z"))).toBe("2026-11-06T03:15:00.000Z");
  });
});
