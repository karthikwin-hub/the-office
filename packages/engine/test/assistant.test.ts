import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { dispatch, figureCheck, gmailConfirmation, OfficeService, parseIcs, parseReminder, partyForEvent, type ApiRequest } from "../src";

const ASOF = "2026-11-04"; // a Wednesday
const OWNER = { name: "Anil Kaveri", email: "anil@kaverielectricals.in" };
const ACCT = { name: "Rajesh Mehta", email: "rajesh@mehtaassociates.in" };

function office() {
  const o = new OfficeService(loadBooks(), { asOf: ASOF });
  o.setHiring("executive-assistant", { hired: true, trustLevel: "trainee" });
  return o;
}
const req = (method: string, path: string, body?: unknown, who: "owner" | "accountant" = "owner"): ApiRequest => ({ method, path, query: new URLSearchParams(), body, role: who, user: who === "owner" ? OWNER : ACCT, mode: "mock" });

const window = (from: string, days: number) => [Date.parse(`${from}T00:00:00+05:30`), Date.parse(`${from}T00:00:00+05:30`) + days * 86_400_000] as const;
const ics = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Anil's work", ...events, "END:VCALENDAR"].join("\r\n");

describe("reading a calendar's private address", () => {
  it("handles zones, all-day events, folded lines and escaped text", () => {
    const text = ics(
      ["BEGIN:VEVENT", "UID:a", "DTSTART;TZID=Asia/Kolkata:20261104T100000", "DTEND;TZID=Asia/Kolkata:20261104T110000", "SUMMARY:Review with\\, the bank", "LOCATION:MG Road", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:b", "DTSTART:20261104T043000Z", "DTEND:20261104T050000Z", "SUMMARY:A very long title that Google", " folds onto the next line", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:c", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106", "SUMMARY:Diwali", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:d", "DTSTART;TZID=Europe/London:20261104T090000", "DURATION:PT30M", "SUMMARY:Call with London", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:e", "DTSTART:20261104T090000Z", "STATUS:CANCELLED", "SUMMARY:Gone", "END:VEVENT"].join("\r\n"),
    );
    const { events, name } = parseIcs(text, ...window(ASOF, 3));
    expect(name).toBe("Anil's work");
    const by = Object.fromEntries(events.map((e) => [e.title, e]));
    expect(by["Review with, the bank"]!.start).toBe("2026-11-04T04:30:00.000Z");
    expect(by["A very long title that Googlefolds onto the next line"]).toBeTruthy();
    expect(by.Diwali!.allDay).toBe(true);
    // London is on GMT in November: 09:00 there is 14:30 in India.
    expect(by["Call with London"]!.start).toBe("2026-11-04T09:00:00.000Z");
    expect(by["Call with London"]!.end).toBe("2026-11-04T09:30:00.000Z");
    expect(by.Gone).toBeUndefined();
  });

  it("repeats daily, weekly and monthly, skipping dates and moved occurrences", () => {
    const text = ics(
      ["BEGIN:VEVENT", "UID:stand", "DTSTART;TZID=Asia/Kolkata:20261102T100000", "DTEND;TZID=Asia/Kolkata:20261102T101500", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "EXDATE;TZID=Asia/Kolkata:20261106T100000", "SUMMARY:Stand-up", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:stand", "RECURRENCE-ID;TZID=Asia/Kolkata:20261104T100000", "DTSTART;TZID=Asia/Kolkata:20261104T120000", "DTEND;TZID=Asia/Kolkata:20261104T121500", "SUMMARY:Stand-up (moved)", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:gst", "DTSTART;VALUE=DATE:20260920", "RRULE:FREQ=MONTHLY;BYMONTHDAY=20", "SUMMARY:GSTR-3B", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:daily", "DTSTART:20261103T023000Z", "DTEND:20261103T030000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Gym", "END:VEVENT"].join("\r\n"),
      ["BEGIN:VEVENT", "UID:board", "DTSTART;TZID=Asia/Kolkata:20260101T150000", "DTEND;TZID=Asia/Kolkata:20260101T160000", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:Board", "END:VEVENT"].join("\r\n"),
    );
    const { events } = parseIcs(text, ...window("2026-11-02", 28));
    const titles = (t: string) => events.filter((e) => e.title === t).map((e) => e.start.slice(0, 10));
    // Mon 2, (Wed 4 moved), (Fri 6 skipped), Mon 9 ...
    expect(titles("Stand-up").slice(0, 3)).toEqual(["2026-11-02", "2026-11-09", "2026-11-11"]);
    expect(events.find((e) => e.title === "Stand-up (moved)")!.start).toBe("2026-11-04T06:30:00.000Z");
    expect(titles("GSTR-3B")).toEqual(["2026-11-19"]); // all-day, midnight in India is the evening before in UTC
    expect(titles("Gym")).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(titles("Board")).toEqual(["2026-11-27"]);
  });
});

describe("reminders", () => {
  it("reads the date out of the sentence", () => {
    expect(parseReminder("remind me to call Sharma on Friday", ASOF)).toEqual({ title: "Call Sharma", due: "2026-11-06" });
    expect(parseReminder("Remind me to send the PO tomorrow", ASOF)).toEqual({ title: "Send the PO", due: "2026-11-05" });
    expect(parseReminder("remind me about the insurance renewal in 2 weeks", ASOF)).toEqual({ title: "The insurance renewal", due: "2026-11-18" });
    expect(parseReminder("remind me to pay rent by 1 dec", ASOF)).toEqual({ title: "Pay rent", due: "2026-12-01" });
    expect(parseReminder("remind me to file the ITR", ASOF)).toEqual({ title: "File the ITR", due: null });
    expect(parseReminder("yaad dilana bank jaana kal", ASOF)).toEqual({ title: "Bank jaana", due: "2026-11-05" });
    expect(parseReminder("what is due today", ASOF)).toBeNull();
  });
});

describe("the agenda and meeting briefs", () => {
  it("finds the customer a meeting is with and briefs from the books", () => {
    const o = office();
    const party = o.books.parties.find((p) => p.kind === "customer")!;
    const found = partyForEvent(o, { title: "Catch-up", attendees: [{ email: party.contact.email.toLowerCase(), name: null }] }, OWNER.email);
    expect(found?.id).toBe(party.id);
    expect(partyForEvent(o, { title: `Lunch with ${party.name}`, attendees: [] })?.id).toBe(party.id);
    expect(partyForEvent(o, { title: "Dentist", attendees: [{ email: "someone@gmail.com", name: null }] })).toBeNull();
  });

  it("puts meetings, tasks and the desk into three days, with a brief and free time", () => {
    const o = office();
    o.setHiring("compliance-officer", { hired: true, trustLevel: "trainee" });
    dispatch(o, req("PUT", "/api/assistant/calendar", { url: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" }));
    dispatch(o, req("POST", "/api/assistant/tasks", { title: "Call the transporter", due: "2026-11-05" }));
    const v = dispatch(o, req("GET", "/api/assistant")).body as import("@office/contracts").AssistantView;
    expect(v.days.map((d) => d.date)).toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
    const today = v.days[0]!;
    expect(today.items.some((i) => i.kind === "event" && i.brief?.length)).toBe(true);
    expect(today.items.some((i) => i.kind === "office" && i.link === "/desk")).toBe(true);
    expect(v.days[1]!.items.some((i) => i.kind === "task" && i.title === "Call the transporter")).toBe(true);
    expect(o.assistant.briefing(OWNER.email)).toContain("Today, ");
    expect(o.assistant.briefing(OWNER.email, true)!.split("\n").length).toBeLessThan(12);
  });
});

describe("drafted replies", () => {
  const mail = (o: OfficeService) => {
    const party = o.books.parties.find((p) => p.kind === "customer")!;
    return { party, from: party.contact.email, fromName: party.contact.name, replyTo: party.contact.email, subject: "Statement please", text: "Please share our outstanding balance.", messageId: "<m1@example.com>" };
  };

  it("flags a figure the books do not hold", () => {
    const o = office();
    expect(figureCheck(o, "You owe ₹9,99,999.00 on invoice ZZ-404.", null)).toHaveLength(2);
    const inv = o.ledger.receivableInvoices[0]!;
    expect(figureCheck(o, `Invoice ${inv.number} for ₹${(inv.totals.totalPaise / 100).toFixed(2)}`, null)).toEqual([]);
  });

  it("are the owner's alone: on their desk, not the accountant's, and sent only by them", () => {
    const o = office();
    const m = mail(o);
    const { draft } = o.assistant.receiveMail(OWNER.email, m, { subject: "Re: Statement please", body: "Dear Sir, we will send it today.", promise: "Send the statement" });
    expect(draft).toBeTruthy();
    const mine = dispatch(o, req("GET", "/api/desk")).body as { items: { id: string }[] };
    const theirs = dispatch(o, req("GET", "/api/desk", undefined, "accountant")).body as { items: { id: string }[] };
    expect(mine.items.some((i) => i.id === draft!.id)).toBe(true);
    expect(theirs.items.some((i) => i.id === draft!.id)).toBe(false);
    expect((dispatch(o, req("GET", "/api/office")).body as { deskCount: number }).deskCount).toBe((dispatch(o, req("GET", "/api/office", undefined, "accountant")).body as { deskCount: number }).deskCount + 1);
    expect(dispatch(o, req("GET", "/api/assistant", undefined, "accountant")).status).toBe(403);
    expect(dispatch(o, req("POST", `/api/desk/${draft!.id}`, { action: "approve" }, "accountant")).status).toBe(404);
    // Nothing of the email reaches the shared log.
    expect(JSON.stringify(o.books.teamLog)).not.toContain("Statement please");
    expect(JSON.stringify(o.books)).not.toContain("outstanding balance");

    const r = dispatch(o, req("POST", `/api/desk/${draft!.id}`, { action: "approve" }));
    expect(r.body).toMatchObject({ status: "approved", kind: "email_reply" });
    const tasks = (dispatch(o, req("GET", "/api/assistant")).body as { tasks: { title: string }[] }).tasks;
    expect(tasks.some((t) => t.title === "Follow up: Send the statement")).toBe(true);
  });

  it("recognises Gmail's forwarding confirmation", () => {
    expect(gmailConfirmation("Gmail Team <forwarding-noreply@google.com>", "(#123456789) Gmail Forwarding Confirmation - Receive Mail from anil@gmail.com", "Confirmation code: 123456789\n\nhttps://mail-settings.google.com/mail/vf-abc")).toEqual({ code: "123456789", link: "https://mail-settings.google.com/mail/vf-abc" });
    expect(gmailConfirmation("someone@client.com", "Order", "hi")).toBeNull();
  });
});

describe("WhatsApp tasks", () => {
  it("adds and finishes a task from a message", () => {
    const o = office();
    expect(o.assistant.fromMessage(OWNER.email, "remind me to call Sharma on Friday")).toContain("Call Sharma");
    expect(o.assistant.fromMessage(OWNER.email, "done call sharma")).toBe("Marked done: Call Sharma.");
    expect(o.assistant.fromMessage(OWNER.email, "hello")).toBeNull();
  });
});

describe("tasks on WhatsApp", () => {
  it("go to the owner's list through the WhatsApp desk, and not for the accountant", async () => {
    const { handleWhatsApp } = await import("../src");
    const newWaSession = () => ({ list: [], seen: [], lastAt: null, language: "en" as const });
    const o = office();
    const turn = handleWhatsApp(o, { ...OWNER, role: "owner" }, newWaSession(), { id: "w1", text: "remind me to call the bank tomorrow", at: new Date().toISOString() }, { base: "https://app" });
    expect(turn.parts[0]!.text).toContain("Call the bank");
    expect(o.assistant.view(OWNER.email, false).tasks[0]!.due).toBe("2026-11-05");
    handleWhatsApp(o, { ...ACCT, role: "accountant" }, newWaSession(), { id: "w2", text: "remind me to call the bank tomorrow", at: new Date().toISOString() }, { base: "https://app" });
    expect(o.assistant.view(ACCT.email, false).tasks).toHaveLength(0);
  });
});

describe("forwarded emails", () => {
  it("finds the original sender in a Gmail and an Outlook forward", async () => {
    const { readForward } = await import("../src");
    const gmail = "Can you draft a reply?\n\n---------- Forwarded message ---------\nFrom: Rakesh Sharma <rakesh@sharmatraders.in>\nDate: Tue, 3 Nov 2026 at 10:02\nSubject: Statement please\nTo: Anil <anil@kaverielectricals.in>\n\nPlease send our statement.\n";
    expect(readForward(gmail)).toMatchObject({ from: "rakesh@sharmatraders.in", name: "Rakesh Sharma", subject: "Statement please", body: "Please send our statement.", note: "Can you draft a reply?" });
    const outlook = "________________________________\nFrom: Priya <priya@vendor.co.in>\nSent: Monday, November 2, 2026 4:10 PM\nTo: Anil\nSubject: Revised rates\n\nRates go up 4% from December.";
    expect(readForward(outlook)).toMatchObject({ from: "priya@vendor.co.in", subject: "Revised rates", body: "Rates go up 4% from December." });
    expect(readForward("Just a note to myself")).toBeNull();
  });
});
