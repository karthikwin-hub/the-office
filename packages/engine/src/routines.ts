import { ROUTINE_BY_ID, ROUTINES, type RoutineOutcome, type RoutineRun, type RoutineView, type StagedChange } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import { addDays, dateLabel } from "./dates";
import type { OfficeService } from "./office";
import { dueReminders } from "./compliance";

/** Where a routine's runs are kept: the office's own SQLite when live, memory in the mockups and tests. */
export interface RoutineLog {
  record(run: RoutineRun): void;
  runs(routine: string, limit: number): RoutineRun[];
  last(routine: string): RoutineRun | null;
  since(routine: string, fromIso: string): RoutineRun[];
  paused(routine: string): boolean;
  setPaused(routine: string, paused: boolean): void;
  /** Deletes runs started before this time; returns how many went. */
  prune(beforeIso: string): number;
}

export class MemoryRoutineLog implements RoutineLog {
  private all: RoutineRun[] = [];
  private stopped = new Set<string>();
  record(run: RoutineRun) {
    this.all.push(run);
  }
  runs(routine: string, limit: number) {
    return this.all.filter((r) => r.routine === routine).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
  }
  last(routine: string) {
    return this.runs(routine, 1)[0] ?? null;
  }
  since(routine: string, fromIso: string) {
    return this.all.filter((r) => r.routine === routine && r.startedAt >= fromIso);
  }
  paused(routine: string) {
    return this.stopped.has(routine);
  }
  setPaused(routine: string, paused: boolean) {
    if (paused) this.stopped.add(routine);
    else this.stopped.delete(routine);
  }
  prune(beforeIso: string) {
    const before = this.all.length;
    this.all = this.all.filter((r) => r.startedAt >= beforeIso);
    return before - this.all.length;
  }
}

/** Runs are kept this long. */
export const ROUTINE_KEEP_DAYS = 90;

export type StepResult = { outcome?: RoutineOutcome; summary: string; counts?: Record<string, number> };

let seq = 0;
const runId = () => `run-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Runs one routine and records what happened, whatever happens: a failure is kept with its error
 * and does not stop the routines after it. A paused routine is recorded as skipped; one whose agent
 * is not on the team does not run and leaves no record.
 */
export async function runRoutine(office: OfficeService, id: string, trigger: RoutineRun["trigger"], fn: () => StepResult | Promise<StepResult>): Promise<RoutineRun | null> {
  const def = ROUTINE_BY_ID[id];
  if (!def) throw new Error(`Unknown routine ${id}`);
  if (!office.hired(def.agentId)) return null;
  const log = office.routines;
  const startedAt = new Date().toISOString();
  let run: RoutineRun;
  if (trigger === "schedule" && log.paused(id)) {
    run = { id: runId(), routine: id, trigger, startedAt, finishedAt: startedAt, outcome: "skipped", summary: "Paused by the owner.", counts: {}, error: null };
  } else {
    try {
      const r = await fn();
      run = { id: runId(), routine: id, trigger, startedAt, finishedAt: new Date().toISOString(), outcome: r.outcome ?? "ok", summary: r.summary, counts: r.counts ?? {}, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      run = { id: runId(), routine: id, trigger, startedAt, finishedAt: new Date().toISOString(), outcome: "failed", summary: `Stopped with an error: ${error.slice(0, 200)}`, counts: {}, error: error.slice(0, 1000) };
      office.log(def.agentId, `"${def.title}" failed: ${error.slice(0, 160)}`);
    }
  }
  log.record(run);
  return run;
}

/** The parts of a routine that only the host can do: email, WhatsApp, the platforms. The mockups pretend. */
export type RoutineHost = {
  sendReminders(items: StagedChange[]): Promise<{ sent: number; failed: number }>;
  socialMorning(): Promise<StepResult>;
  publish(): Promise<StepResult>;
  /** Sends the morning digest with the lines the other routines found. */
  digest(notes: string[]): Promise<StepResult>;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Approved reminders that have not gone out: the ones just approved, and earlier failures with tries left, tried at least an hour ago. */
export function reminderQueue(office: OfficeService, just: StagedChange[], now = Date.now()): StagedChange[] {
  const ids = new Set(just.map((s) => s.id));
  const retry = office.books.staged.filter((s) => {
    const p = s.payload as { sentAt?: string; sendError?: string; attempts?: number; triedAt?: string };
    return s.kind === "reminder" && s.status === "approved" && !ids.has(s.id) && !p.sentAt && p.sendError && (p.attempts ?? 0) < 3 && (!p.triedAt || now - Date.parse(p.triedAt) >= 3600_000);
  });
  return [...just.filter((s) => s.kind === "reminder"), ...retry];
}

/** One routine, by itself: what "Run now" does, and what the morning round does for each in turn. */
export async function runOne(office: OfficeService, id: string, trigger: RoutineRun["trigger"], host: RoutineHost, notes: string[] = []): Promise<RoutineRun | null> {
  switch (id) {
    case "trusted-work":
      return runRoutine(office, id, trigger, async (): Promise<StepResult> => {
        const done = office.runTrusted();
        const queue = done.filter((s) => s.kind === "reminder");
        const sent = queue.length ? await host.sendReminders(queue) : { sent: 0, failed: 0 };
        if (!done.length) return { outcome: "nothing", summary: "Nothing routine was waiting.", counts: { done: 0 } };
        const by = new Map<string, number>();
        for (const d of done) by.set(d.agentId, (by.get(d.agentId) ?? 0) + 1);
        const who = [...by].map(([a, n]) => `${n} by ${AGENT_BY_ID[a]?.title.replace(/^The /, "the ") ?? a}`).join(", ");
        notes.push(`${plural(done.length, "routine task")} done by trusted agents.`);
        return { outcome: sent.failed ? "partial" : "ok", summary: `${plural(done.length, "item")} done on their own: ${who}.${sent.sent ? ` ${plural(sent.sent, "reminder")} sent.` : ""}${sent.failed ? ` ${plural(sent.failed, "reminder")} could not be sent.` : ""}`, counts: { done: done.length, sent: sent.sent, failed: sent.failed } };
      });
    case "send-reminders":
      return runRoutine(office, id, trigger, async (): Promise<StepResult> => {
        const queue = reminderQueue(office, []);
        if (!queue.length) return { outcome: "nothing", summary: "No approved reminder is waiting to go out.", counts: { sent: 0 } };
        const r = await host.sendReminders(queue);
        return { outcome: r.failed ? (r.sent ? "partial" : "failed") : "ok", summary: `${plural(r.sent, "reminder")} sent${r.failed ? `; ${r.failed} could not be sent and will be tried again` : ""}.`, counts: { sent: r.sent, failed: r.failed } };
      });
    case "social-morning":
      return runRoutine(office, id, trigger, () => host.socialMorning());
    case "publish-posts":
      return runRoutine(office, id, trigger, () => host.publish());
    case "reorder-check":
      return runRoutine(office, id, trigger, () => {
        const r = office.reorderCheck();
        if (r.items.length) notes.push(`${plural(r.items.length, "item")} at or under the reorder level${r.drafted ? `; ${plural(r.drafted, "purchase order")} drafted` : ""}.`);
        return r.items.length
          ? { summary: `${plural(r.items.length, "item")} to reorder: ${r.items.slice(0, 5).join(", ")}${r.items.length > 5 ? ` and ${r.items.length - 5} more` : ""}. ${r.drafted ? `${plural(r.drafted, "purchase order")} drafted for your desk.` : r.covered ? "Each already has a purchase order open." : "No supplier on record to draft an order for."}`, counts: { items: r.items.length, drafted: r.drafted } }
          : { outcome: "nothing", summary: "Every item is above its reorder level.", counts: { items: 0, drafted: 0 } };
      });
    case "compliance-due":
      return runRoutine(office, id, trigger, () => {
        const due = office.complianceDue(7);
        const nudge = new Set(dueReminders(office.books, office.asOf).map((o) => o.id));
        for (const d of due) if (nudge.has(d.id)) notes.push(`${d.line}${d.assignee ? ` (${d.assignee === "owner" ? "you" : d.assignee.toUpperCase()} to do)` : ""}`);
        const late = due.filter((d) => d.state === "late");
        if (nudge.size) office.log("compliance-officer", `Reminded you about ${plural(nudge.size, "filing")}: ${due.filter((d) => nudge.has(d.id)).map((d) => d.form).join(", ")}.`, { kind: "report", id: "compliance" });
        return due.length
          ? { summary: `${due.map((d) => `${d.form} ${d.state === "late" ? `late since ${dateLabel(d.dueOn)}` : `by ${dateLabel(d.dueOn)}`}`).join("; ")}.`, counts: { due: due.length, late: late.length, reminded: nudge.size } }
          : { outcome: "nothing", summary: "Nothing is due in the next seven days.", counts: { due: 0, late: 0, reminded: 0 } };
      });
    case "handoff-chase":
      return runRoutine(office, id, trigger, () => {
        const r = office.customers.chase(Date.now());
        if (r.waiting.length) notes.push(`${plural(r.waiting.length, "customer")} waiting more than four hours for you: ${r.waiting.slice(0, 3).join(", ")}.`);
        if (r.closing.length) notes.push(`WhatsApp closes soon for ${r.closing.join(", ")}: reply before it does.`);
        const parts = [
          r.waiting.length ? `${plural(r.waiting.length, "customer")} waiting more than four hours` : "",
          r.closing.length ? `${plural(r.closing.length, "WhatsApp chat")} closing within three hours` : "",
          r.pruned ? `${plural(r.pruned, "old conversation")} deleted` : "",
        ].filter(Boolean);
        return parts.length ? { summary: `${parts.join("; ")}.`, counts: { waiting: r.waiting.length, closing: r.closing.length, pruned: r.pruned } } : { outcome: "nothing", summary: "No customer is waiting on you.", counts: { waiting: 0, closing: 0, pruned: 0 } };
      });
    case "morning-digest":
      return runRoutine(office, id, trigger, () => host.digest(notes));
  }
  throw new Error(`Unknown routine ${id}`);
}

/** A routine that cannot be run now, with a reason for the owner. */
export class RoutineError extends Error {}

/** "Run now" from the Routines page: the owner's, at most once a minute for each routine. */
export async function runNow(office: OfficeService, id: string, host: RoutineHost): Promise<RoutineRun> {
  const def = ROUTINE_BY_ID[id];
  if (!def) throw new Error(`Unknown routine ${id}`);
  if (!office.hired(def.agentId)) throw new RoutineError(`${AGENT_BY_ID[def.agentId]?.title ?? "Its agent"} is not on the team, so this routine does not run.`);
  const last = office.routines.runs(id, 10).find((r) => r.trigger === "manual");
  if (last && Date.now() - Date.parse(last.startedAt) < 60_000) throw new RoutineError("It ran a moment ago. Try again in a minute.");
  return (await runOne(office, id, "manual", host))!;
}

/** The morning round: each routine in turn, then the digest with what they found. Old runs are pruned. */
export async function morningRound(office: OfficeService, host: RoutineHost): Promise<RoutineRun[]> {
  const notes: string[] = [];
  const runs: RoutineRun[] = [];
  for (const r of ROUTINES) {
    if (r.schedule !== "morning") continue;
    const run = await runOne(office, r.id, "schedule", host, notes);
    if (run) runs.push(run);
  }
  office.routines.prune(new Date(Date.now() - ROUTINE_KEEP_DAYS * 86_400_000).toISOString());
  return runs;
}

/** The next time the morning round runs: the digest time in India, today if it is still ahead, otherwise tomorrow. */
export function nextMorning(digestTime: string, now = Date.now()): string {
  const ist = new Date(now + 5.5 * 3600_000);
  const today = ist.toISOString().slice(0, 10);
  const at = (day: string) => Date.parse(`${day}T${digestTime}:00+05:30`);
  const t = at(today) > now ? at(today) : at(addDays(today, 1));
  return new Date(t).toISOString();
}

/** Each routine with its next run, last outcome and pause. The host may know the publishing alarm exactly; otherwise the next scheduled post is used. */
export function routinesView(office: OfficeService, now = Date.now(), publishAt?: number | null): RoutineView[] {
  const digest = office.settings().digestTime;
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const nextPost =
    publishAt !== undefined
      ? (publishAt ?? undefined)
      : office.books.posts
          .filter((p) => p.status === "scheduled" && p.variants.some((v) => v.status === "scheduled"))
          .map((p) => Date.parse(p.at))
          .filter((t) => Number.isFinite(t))
          .sort((a, b) => a - b)[0];
  return ROUTINES.map((r) => {
    const active = office.hired(r.agentId);
    const paused = office.routines.paused(r.id);
    const nextRunAt = !active || paused ? null : r.schedule === "morning" ? nextMorning(digest, now) : nextPost !== undefined ? new Date(Math.max(nextPost, now)).toISOString() : null;
    return {
      id: r.id,
      title: r.title,
      agentId: r.agentId,
      does: r.does,
      schedule: r.schedule === "morning" ? `Every morning at ${digest}` : "When a post is due, and on retries",
      active,
      paused,
      nextRunAt,
      last: office.routines.last(r.id),
      failedThisWeek: office.routines.since(r.id, weekAgo).filter((x) => x.outcome === "failed" || x.outcome === "partial").length,
    };
  });
}
