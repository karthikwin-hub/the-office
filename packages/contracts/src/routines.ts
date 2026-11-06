import { z } from "zod";
import { IsoDateTime } from "./entities";

/** How a routine is woken: with the morning round at the digest time, or when a post falls due. */
export type RoutineSchedule = "morning" | "posts";

export type RoutineDef = {
  id: string;
  title: string;
  /** The agent who runs it; a routine whose agent is not hired does not run. */
  agentId: string;
  schedule: RoutineSchedule;
  /** One sentence for the owner: what happens each time it runs. */
  does: string;
};

/** Every scheduled job in an office, in the order the morning round runs them. */
export const ROUTINES: RoutineDef[] = [
  { id: "trusted-work", title: "Routine work by trusted agents", agentId: "office-manager", schedule: "morning", does: "Agents you have made trusted or autonomous finish the routine items waiting for them, within the limits on their trust level." },
  { id: "send-reminders", title: "Send approved reminders", agentId: "credit-controller", schedule: "morning", does: "Payment reminders approved since yesterday go out by email, and any that failed are tried again, up to three times." },
  { id: "social-morning", title: "Social media morning", agentId: "social-media-manager", schedule: "morning", does: "Results come in from each connected channel, overdue posts are published or held back, and from the 25th next month's calendar is drafted." },
  { id: "reorder-check", title: "Reorder check", agentId: "storekeeper", schedule: "morning", does: "Every item at or under its reorder level is listed, and a purchase order is drafted for each supplier you last bought it from." },
  { id: "compliance-due", title: "Returns and filings due", agentId: "compliance-officer", schedule: "morning", does: "Filings and payments due in seven days, in two days and today go into the morning digest with what missing them costs, and late ones are raised again every week until they are marked filed." },
  { id: "handoff-chase", title: "Customers waiting for you", agentId: "customer-service", schedule: "morning", does: "Customers handed to you more than four hours ago are listed, WhatsApp chats about to close are flagged, and conversations older than the retention period are deleted." },
  { id: "morning-digest", title: "Morning digest", agentId: "office-manager", schedule: "morning", does: "What is waiting on your desk and what the routines found goes to the owners, on WhatsApp if they asked for it, otherwise by email." },
  { id: "publish-posts", title: "Publish scheduled posts", agentId: "social-media-manager", schedule: "posts", does: "When a post's time comes, its checks run again; it is published, held back for you, or left ready to post by hand." },
];
export const ROUTINE_BY_ID: Record<string, RoutineDef> = Object.fromEntries(ROUTINES.map((r) => [r.id, r]));

export const RoutineOutcome = z.enum(["ok", "nothing", "partial", "failed", "skipped"]);
export type RoutineOutcome = z.infer<typeof RoutineOutcome>;

export const RoutineRun = z.object({
  id: z.string(),
  routine: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  outcome: RoutineOutcome,
  summary: z.string(),
  counts: z.record(z.number()),
  error: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const RoutineView = z.object({
  id: z.string(),
  title: z.string(),
  agentId: z.string(),
  does: z.string(),
  /** In plain words, for example "Every morning at 08:45". */
  schedule: z.string(),
  /** False when the agent who runs it is not on the team. */
  active: z.boolean(),
  paused: z.boolean(),
  nextRunAt: IsoDateTime.nullable(),
  last: RoutineRun.nullable(),
  /** Runs in the last seven days that needed attention. */
  failedThisWeek: z.number().int(),
});
export type RoutineView = z.infer<typeof RoutineView>;
export const RoutinesView = z.object({ routines: z.array(RoutineView) });
export type RoutinesView = z.infer<typeof RoutinesView>;
export const RoutineChange = z.object({ paused: z.boolean() }).strict();
