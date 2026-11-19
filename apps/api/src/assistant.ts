import { type AssistantDoc, emptyAssistantDoc } from "@office/contracts";
import { type AssistantStore, type DraftText, type OfficeService, ownerKey, parseIcs, partyBrief, partyForEvent, replyTemplate } from "@office/engine";
import { modelJson, TEXT_MODEL } from "./reading";

/** Mail to `<slug>.assistant@…`, as the Worker hands it to the office. */
export type AssistantInbound = {
  /** The envelope sender; Gmail's automatic forwarding sends as `owner+caf_=…@…`. */
  envelope: string;
  from: string | null;
  name: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  /** `From:` is proven (see `mailVerdict`). */
  authenticated?: boolean;
  /** The envelope's own domain signed the message, as Gmail does for what its users' filters forward. */
  envelopeSigned?: boolean;
  docs: { id: string; mimeType: string; filename: string }[];
  skipped: string[];
};

/** The address behind a forwarding alias: `anil+caf_=x=y@gmail.com` is anil@gmail.com. */
export const plainAddress = (a: string | null | undefined) => {
  const m = /([^\s<>"]+)@([^\s<>"]+)/.exec(a ?? "");
  return m ? `${m[1]!.split("+")[0]}@${m[2]}`.toLowerCase() : null;
};

/** Each owner's record as one row in the office's SQLite, apart from the books. */
export class SqlAssistantStore implements AssistantStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS ea_owner (owner TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS ea_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  load(owner: string): AssistantDoc {
    const row = this.sql.exec<{ doc: string }>("SELECT doc FROM ea_owner WHERE owner = ?", ownerKey(owner)).toArray()[0];
    if (!row) return emptyAssistantDoc();
    try {
      return { ...emptyAssistantDoc(), ...(JSON.parse(row.doc) as AssistantDoc) };
    } catch {
      return emptyAssistantDoc();
    }
  }
  save(owner: string, doc: AssistantDoc) {
    this.sql.exec("INSERT INTO ea_owner (owner, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at", ownerKey(owner), JSON.stringify(doc), Date.now());
  }
  remove(owner: string) {
    this.sql.exec("DELETE FROM ea_owner WHERE owner = ?", ownerKey(owner));
  }
  owners() {
    return this.sql.exec<{ owner: string }>("SELECT owner FROM ea_owner").toArray().map((r) => r.owner);
  }
  meta(key: string) {
    return this.sql.exec<{ v: string }>("SELECT v FROM ea_meta WHERE k = ?", key).toArray()[0]?.v ?? null;
  }
  setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM ea_meta WHERE k = ?", key);
    else this.sql.exec("INSERT INTO ea_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", key, value);
  }
}

const MAX_ICS = 3 * 1024 * 1024;

/** A calendar's private address, as the office will fetch it: https only, and never to this machine or a private network. */
export function calendarUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/^webcal:\/\//i, "https://"));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  return u;
}

/** Reads the calendar at its private address: two weeks ahead and a day back. Errors are worded for the owner. */
export async function fetchCalendar(raw: string, today: string, fetcher: typeof fetch = fetch): Promise<{ events: ReturnType<typeof parseIcs>["events"]; label: string | null } | { error: string }> {
  const url = calendarUrl(raw);
  if (!url) return { error: "That is not a calendar address the office can read. Use the https or webcal link." };
  let res: Response;
  try {
    res = await fetcher(url.toString(), { headers: { accept: "text/calendar" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { error: "The calendar did not answer. Try again in a minute." };
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) return { error: "The calendar refused the link. If it is a Google Workspace calendar, your admin may have turned secret addresses off; otherwise copy the secret address again." };
  if (!res.ok) return { error: `The calendar answered with an error (${res.status}).` };
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_ICS) return { error: "The calendar is too large to read." };
  const text = await res.text();
  if (text.length > MAX_ICS) return { error: "The calendar is too large to read." };
  if (!/BEGIN:VCALENDAR/i.test(text)) return { error: "That address does not give a calendar. Use the one marked 'Secret address in iCal format'." };
  const from = Date.parse(`${today}T00:00:00+05:30`) - 86_400_000;
  const { events, name } = parseIcs(text, from, from + 16 * 86_400_000);
  return { events: events.slice(0, 400), label: name };
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" }, promise: { type: ["string", "null"] } },
  required: ["subject", "body"],
};

type Run = (model: string, input: unknown) => Promise<unknown>;

/**
 * A reply in the owner's name. The model sees the email and what the books say about the sender, and
 * nothing else; without the model, or if its answer is unusable, a plain holding reply is drafted.
 */
export async function draftReply(ai: Ai | null, office: OfficeService, mail: { from: string; fromName: string | null; subject: string; text: string }, ownerName: string): Promise<DraftText> {
  const fallback = replyTemplate(office, mail, ownerName);
  if (!ai) return fallback;
  const party = partyForEvent(office, { title: mail.subject, attendees: [{ email: mail.from.toLowerCase(), name: mail.fromName }] });
  const facts = party ? [`The sender is ${party.kind === "customer" ? "a customer" : "a supplier"}, ${party.name}.`, ...partyBrief(office, party)] : ["The sender is not a customer or supplier in the books."];
  const system = [
    `You draft email replies for ${ownerName}, who runs ${office.books.business.name || "a small business"} in India. The owner reads and edits every draft before it is sent.`,
    "Write a short, warm, businesslike reply in the language the email is written in. Sign it with the owner's name.",
    "Use only the facts given. Never invent an amount, a date, an invoice number, a discount or a commitment. If the email asks for something the facts do not settle, say the owner will check and come back.",
    'Answer with JSON: {"subject": "...", "body": "...", "promise": "a short follow-up the owner must do, or null"}.',
  ].join(" ");
  const user = `Facts from the books:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nThe email, from ${mail.fromName ?? mail.from} <${mail.from}>:\nSubject: ${mail.subject}\n\n${mail.text.slice(0, 4000)}`;
  try {
    const run = ai.run.bind(ai) as unknown as Run;
    const out = modelJson(await run(TEXT_MODEL, { messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_schema", json_schema: DRAFT_SCHEMA }, max_tokens: 600, temperature: 0.2 })) as Partial<DraftText>;
    const body = typeof out.body === "string" ? out.body.trim() : "";
    if (body.length < 10) return fallback;
    return { subject: typeof out.subject === "string" && out.subject.trim() ? out.subject.trim().slice(0, 200) : fallback.subject, body: body.slice(0, 5000), promise: typeof out.promise === "string" && out.promise.trim() ? out.promise.trim().slice(0, 160) : null };
  } catch {
    return fallback;
  }
}
