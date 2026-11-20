import { DatabaseSync } from "node:sqlite";
import { OfficeService } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { calendarUrl, draftReply, fetchCalendar, plainAddress, SqlAssistantStore } from "../src/assistant";

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

const ICS = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Work",
  "BEGIN:VEVENT",
  "UID:1",
  "DTSTART;TZID=Asia/Kolkata:20261104T110000",
  "DTEND;TZID=Asia/Kolkata:20261104T120000",
  "SUMMARY:Bank",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("the assistant on the server", () => {
  it("keeps each owner's record apart, in the office's own SQLite", () => {
    const store = new SqlAssistantStore(sqlStorage());
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04", assistant: store });
    o.setHiring("executive-assistant", { hired: true, trustLevel: "trainee" });
    o.assistant.addTask("Anil@Kaverielectricals.in", { title: "Call the bank" });
    expect(store.owners()).toEqual(["anil@kaverielectricals.in"]);
    expect(o.assistant.view("someone@else.test", false).tasks).toEqual([]);
    expect(o.assistant.view("anil@kaverielectricals.in", false).tasks[0]!.title).toBe("Call the bank");
    store.remove("anil@kaverielectricals.in");
    expect(store.owners()).toEqual([]);
  });

  it("reads only https calendar addresses on the internet", async () => {
    expect(calendarUrl("webcal://calendar.google.com/calendar/ical/x/private-y/basic.ics")?.protocol).toBe("https:");
    expect(calendarUrl("http://calendar.google.com/x.ics")).toBeNull();
    expect(calendarUrl("https://127.0.0.1/x.ics")).toBeNull();
    expect(calendarUrl("https://localhost/x.ics")).toBeNull();
    const ok = (async () => new Response(ICS)) as unknown as typeof fetch;
    const r = await fetchCalendar("https://calendar.google.com/calendar/ical/x/private-y/basic.ics", "2026-11-04", ok);
    expect(r).toMatchObject({ label: "Work", events: [{ title: "Bank", start: "2026-11-04T05:30:00.000Z" }] });
    const refused = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchCalendar("https://calendar.google.com/x.ics", "2026-11-04", refused)).toMatchObject({ error: expect.stringContaining("Workspace") });
    const html = (async () => new Response("<html>")) as unknown as typeof fetch;
    expect(await fetchCalendar("https://calendar.google.com/x.ics", "2026-11-04", html)).toMatchObject({ error: expect.stringContaining("Secret address") });
  });

  it("knows the owner behind a forwarding alias", () => {
    expect(plainAddress("anil+caf_=kaveri.assistant=in.office.snilld.in@gmail.com")).toBe("anil@gmail.com");
    expect(plainAddress("Anil <ANIL@kaveri.in>")).toBe("anil@kaveri.in");
    expect(plainAddress(null)).toBeNull();
  });

  it("drafts a holding reply when the model is not there or answers badly", async () => {
    const o = new OfficeService(loadBooks(), { asOf: "2026-11-04" });
    const mail = { from: "x@y.test", fromName: "Ravi Kumar", subject: "Rates", text: "What are your rates?" };
    const plain = await draftReply(null, o, mail, "Anil");
    expect(plain.body).toContain("Dear Ravi");
    const broken = { run: async () => ({ response: "not json" }) } as unknown as Ai;
    expect((await draftReply(broken, o, mail, "Anil")).body).toBe(plain.body);
    const good = {
      run: async () => ({ response: { subject: "Re: Rates", body: "Dear Ravi, our rate card is attached. Regards, Anil", promise: "Send the rate card" } }),
    } as unknown as Ai;
    expect(await draftReply(good, o, mail, "Anil")).toEqual({
      subject: "Re: Rates",
      body: "Dear Ravi, our rate card is attached. Regards, Anil",
      promise: "Send the rate card",
    });
  });
});
