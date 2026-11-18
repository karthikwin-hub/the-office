import { z } from "zod";
import { IsoDate, IsoDateTime } from "./entities";

/**
 * The Executive Assistant works for one owner at a time. Everything here is that owner's own:
 * their calendar, the emails they forward, their tasks and the replies drafted for them. None of
 * it is in the books, the team log or the shared Desk; an accountant sees none of it.
 */

/** One meeting or appointment from the owner's calendar, in a window the assistant looks at. */
export const CalEvent = z.object({
  id: z.string(),
  title: z.string(),
  start: IsoDateTime,
  end: IsoDateTime,
  allDay: z.boolean(),
  location: z.string().nullable(),
  attendees: z.array(z.object({ email: z.string(), name: z.string().nullable() })),
});
export type CalEvent = z.infer<typeof CalEvent>;

export const TaskSource = z.enum(["you", "whatsapp", "email", "draft"]);
export const Task = z.object({
  id: z.string(),
  title: z.string(),
  due: IsoDate.nullable(),
  status: z.enum(["open", "done"]),
  source: TaskSource,
  createdAt: IsoDateTime,
  doneAt: IsoDateTime.nullable(),
  snoozedUntil: IsoDate.nullable(),
});
export type Task = z.infer<typeof Task>;

/** An email the owner forwarded, and what the assistant did with it. */
export const AssistantMail = z.object({
  id: z.string(),
  from: z.string(),
  fromName: z.string().nullable(),
  /** Who the reply goes to: the sender of the forwarded email, when it can be found. */
  replyTo: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  messageId: z.string().nullable(),
  at: IsoDateTime,
  outcome: z.enum(["drafted", "to_accountant", "to_customer_service", "noted"]),
  note: z.string(),
});
export type AssistantMail = z.infer<typeof AssistantMail>;

export const AgendaItem = z.object({
  kind: z.enum(["event", "task", "office", "focus"]),
  /** "09:30" in India time, or null for all day. */
  at: z.string().nullable(),
  until: z.string().nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  /** For a meeting with a customer or supplier: what the books say about them. */
  brief: z.array(z.string()).optional(),
  /** Where it opens in the app, if anywhere. */
  link: z.string().nullable(),
  taskId: z.string().optional(),
});
export type AgendaItem = z.infer<typeof AgendaItem>;

export const AgendaDay = z.object({ date: IsoDate, label: z.string(), items: z.array(AgendaItem) });
export type AgendaDay = z.infer<typeof AgendaDay>;

export const AssistantView = z.object({
  hired: z.boolean(),
  /** The owner this view belongs to. */
  owner: z.string(),
  /** Where the owner forwards emails, e.g. neltrade-v9sc.assistant@in.office.snilld.in. */
  address: z.string().nullable(),
  calendar: z.object({ connected: z.boolean(), label: z.string().nullable(), fetchedAt: IsoDateTime.nullable(), error: z.string().nullable(), events: z.number().int() }),
  /** Gmail's code for confirming a forwarding address, when Gmail has sent one. */
  forwarding: z.object({ code: z.string().nullable(), link: z.string().nullable(), at: IsoDateTime }).nullable(),
  days: z.array(AgendaDay),
  tasks: z.array(Task),
  mail: z.array(AssistantMail),
  /** True in the demo, where the calendar is a sample and no email is sent. */
  sample: z.boolean(),
});
export type AssistantView = z.infer<typeof AssistantView>;

/** Google Calendar's "Secret address in iCal format", or any private .ics link. */
export const CalendarLinkInput = z.object({ url: z.string().trim().url().max(2000).refine((u) => /^https:\/\//i.test(u) || /^webcal:\/\//i.test(u), "Use the https or webcal address your calendar gives you.") }).strict();
export const TaskInput = z.object({ title: z.string().trim().min(1, "Say what to do.").max(200), due: IsoDate.nullable().optional() }).strict();
export const TaskChange = z.object({ status: z.enum(["open", "done"]).optional(), due: IsoDate.nullable().optional(), snoozedUntil: IsoDate.nullable().optional() }).strict();

/** What the office keeps for one owner. Small: two weeks of calendar, the last 50 emails, the tasks. */
export type AssistantDoc = {
  calendar: { label: string | null; fetchedAt: string | null; error: string | null; events: CalEvent[] } | null;
  tasks: Task[];
  mail: AssistantMail[];
  /** Replies drafted for this owner, waiting or decided; only ever shown to them. */
  drafts: import("./entities").StagedChange[];
};
export const emptyAssistantDoc = (): AssistantDoc => ({ calendar: null, tasks: [], mail: [], drafts: [] });

/** `<slug>.assistant@<domain>`: where an owner forwards the emails they want help with. */
export const assistantAddress = (ingestEmail: string): string | null => {
  const at = ingestEmail.indexOf("@");
  return at > 0 ? `${ingestEmail.slice(0, at)}.assistant${ingestEmail.slice(at)}` : null;
};
