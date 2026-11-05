import type { RoutineRun } from "@office/contracts";

/** A week of mornings for the sample office, with one failure and one pause, so the Routines page has something to show. */
export function sampleRoutineRuns(asOf: string, digestTime = "08:45"): RoutineRun[] {
  const runs: RoutineRun[] = [];
  const at = (daysAgo: number, minutes: number) => {
    const d = new Date(Date.parse(`${asOf}T${digestTime}:00+05:30`) - daysAgo * 86_400_000 + minutes * 60_000);
    return d.toISOString();
  };
  const add = (daysAgo: number, step: number, routine: string, outcome: RoutineRun["outcome"], summary: string, counts: Record<string, number> = {}, error: string | null = null) => {
    const startedAt = at(daysAgo, step * 0.2);
    runs.push({ id: `run-sample-${routine}-${daysAgo}`, routine, trigger: "schedule", startedAt, finishedAt: new Date(Date.parse(startedAt) + 4000).toISOString(), outcome, summary, counts, error });
  };
  for (let d = 1; d <= 7; d++) {
    add(d, 0, "trusted-work", d % 3 ? "ok" : "nothing", d % 3 ? `${d % 3 === 1 ? 2 : 1} items done on their own: by the accountant.` : "Nothing routine was waiting.", { done: d % 3 ? (d % 3 === 1 ? 2 : 1) : 0 });
    add(d, 1, "send-reminders", d === 4 ? "partial" : d % 2 ? "ok" : "nothing", d === 4 ? "1 reminder sent; 1 could not be sent and will be tried again." : d % 2 ? "2 reminders sent." : "No approved reminder is waiting to go out.", { sent: d % 2 ? 2 : d === 4 ? 1 : 0, failed: d === 4 ? 1 : 0 });
    if (d === 3) add(d, 2, "social-morning", "failed", "Stopped with an error: Instagram did not answer in time.", {}, "Instagram did not answer in time (504).");
    else add(d, 2, "social-morning", "ok", `Results for ${4 + d} posts; ${d % 2} new comments and reviews.`, { metrics: 4 + d, messages: d % 2 });
    add(d, 3, "reorder-check", "ok", "3 items to reorder: FR PVC wire 1.5 sq mm, 90 m coil, FR PVC wire 2.5 sq mm, 90 m coil and 1 more. Each already has a purchase order open.", { items: 3, drafted: 0 });
    add(d, 4, "compliance-due", d <= 5 ? "ok" : "nothing", d <= 5 ? "GSTR-1 by 11 Nov" : "Nothing is due in the next seven days.", { due: d <= 5 ? 1 : 0 });
    if (d === 6) add(d, 6, "morning-digest", "skipped", "Paused by the owner.");
    else add(d, 6, "morning-digest", "ok", `Sent to 1 owner. ${8 - d} waiting on the desk.`, { email: 1, whatsapp: 0, waiting: 8 - d });
    add(d, 30, "publish-posts", d % 2 ? "ok" : "nothing", d % 2 ? "1 post published." : "No post was due.", { published: d % 2, failed: 0 });
  }
  return runs;
}
