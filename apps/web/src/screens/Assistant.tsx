import type { AgendaDay, AgendaItem, AssistantView, Task } from "@office/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client";
import { q, useChange } from "../api/queries";
import { count, isOwner, Section, shortDate } from "./common";

const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const KIND_LABEL: Record<AgendaItem["kind"], string> = { event: "Meeting", task: "To do", office: "The office", focus: "Free time" };

/** The Executive Assistant's room: one owner's next three days, their tasks, and how their calendar and email reach it. */
export function AssistantPanel({ preview }: { preview?: boolean }) {
  if (!isOwner()) return <p className="muted">The assistant works for each owner on their own. Their calendar, emails and tasks are not shown to anyone else, the accountant included.</p>;
  if (preview) return <p className="muted">Once hired, this room plans your next three days from your calendar, your tasks and what the office needs from you, and drafts replies to the emails you forward to it. Only you see it.</p>;
  return <AssistantRoom />;
}

function AssistantRoom() {
  const res = useQuery(q.assistant());
  const v = res.data;
  if (res.error) return <p className="form-error">{res.error.message}</p>;
  if (!v) return <p className="loading">Looking at your calendar</p>;
  return (
    <>
      <Agenda days={v.days} connected={v.calendar.connected} />
      <Tasks tasks={v.tasks} />
      <Mail v={v} />
      <CalendarLink v={v} />
      <Forwarding v={v} />
    </>
  );
}

function Agenda({ days, connected }: { days: AgendaDay[]; connected: boolean }) {
  return (
    <Section title="Your next three days">
      {connected ? null : <p className="section-lede">Give the assistant your calendar below and your meetings appear here, with a brief from the books before each meeting with a customer or supplier.</p>}
      <div className="ea-days">
        {days.map((d, n) => (
          <section key={d.date} className={`ea-day${n === 0 ? " ea-today" : ""}`} aria-label={d.label}>
            <h3>{d.label}</h3>
            {d.items.length ? (
              <ol className="ea-items">
                {d.items.map((i, k) => (
                  <li key={`${i.kind}-${i.title}-${k}`} className={`ea-item ea-${i.kind}`}>
                    <span className="ea-when">{i.at ? `${i.at}${i.until ? `–${i.until}` : ""}` : KIND_LABEL[i.kind]}</span>
                    <span className="ea-what">
                      {i.link ? <Link to={i.link as "/desk"}>{i.title}</Link> : i.title}
                      {i.detail ? <span className="ea-detail">{i.detail}</span> : null}
                      {i.brief?.length ? (
                        <span className="ea-brief">
                          {i.brief.map((b) => (
                            <span key={b}>{b}</span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Nothing planned.</p>
            )}
          </section>
        ))}
      </div>
    </Section>
  );
}

function Tasks({ tasks }: { tasks: Task[] }) {
  const change = useChange();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done").slice(0, 5);
  return (
    <Section title="Your to-do list" aside={open.length ? <span className="muted">{count(open.length, "open task")}</span> : null}>
      <p className="section-lede">
        Add one here, or on WhatsApp: <em>remind me to call Sharma on Friday</em>. Send <em>done call Sharma</em> when it is done.
      </p>
      {open.length ? (
        <ul className="ea-tasks">
          {open.map((t) => (
            <li key={t.id}>
              <label>
                <input type="checkbox" checked={false} disabled={change.isPending} onChange={() => change.mutate(() => api.changeTask(t.id, { status: "done" }))} />
                <span>{t.title}</span>
              </label>
              <span className="muted">
                {t.due ? `by ${shortDate(t.due)}` : "no date"}
                {t.source === "whatsapp" ? ", from WhatsApp" : t.source === "draft" ? ", from a reply you sent" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing on your list.</p>
      )}
      <form
        className="cs-form ea-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          change.mutate(() => api.addTask(title.trim(), due || null), { onSuccess: () => (setTitle(""), setDue("")) });
        }}
      >
        <label htmlFor="ea-task">New task</label>
        <div className="row">
          <input id="ea-task" className="input" maxLength={200} placeholder="Send the revised quote to Mehta Builders" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input aria-label="Due on" className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button type="submit" className="btn" disabled={change.isPending || !title.trim()}>
            Add
          </button>
        </div>
      </form>
      {done.length ? (
        <details className="ea-done">
          <summary>Done lately ({done.length})</summary>
          <ul>
            {done.map((t) => (
              <li key={t.id}>
                <s>{t.title}</s>{" "}
                <button type="button" className="btn-link" onClick={() => change.mutate(() => api.changeTask(t.id, { status: "open" }))}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

const OUTCOME: Record<AssistantView["mail"][number]["outcome"], string> = { drafted: "Reply drafted", to_accountant: "Passed to the Accountant", to_customer_service: "Passed to Customer Service", noted: "Kept" };

function Mail({ v }: { v: AssistantView }) {
  if (!v.mail.length) return null;
  return (
    <Section title="Emails you forwarded">
      <ul className="cs-threads">
        {v.mail.slice(0, 10).map((m) => (
          <li key={m.id} className="ea-mail">
            <span className="cs-thread-name">{m.fromName ?? m.from}</span>
            <span className="muted">
              {ist(m.at)} · {OUTCOME[m.outcome]}
            </span>
            <span className="cs-thread-preview">{m.subject || "(no subject)"}</span>
          </li>
        ))}
      </ul>
      {v.mail.some((m) => m.outcome === "drafted") ? (
        <p className="muted">
          Drafted replies wait on <Link to="/desk">your desk</Link>. You can change them before they go; they leave from the office's address in your name, and answers come back to you.
        </p>
      ) : null}
    </Section>
  );
}

function CalendarLink({ v }: { v: AssistantView }) {
  const change = useChange();
  const [url, setUrl] = useState("");
  const cal = v.calendar;
  return (
    <Section title="Your calendar">
      {cal.connected ? (
        <>
          <p>
            Reading <strong>{cal.label ?? "your calendar"}</strong>
            {cal.fetchedAt ? `, last read ${ist(cal.fetchedAt)}` : ""}: {count(cal.events, "event")} in the next two weeks.
            {v.sample ? " In this demo it is a sample week." : ""}
          </p>
          {cal.error ? <p className="form-error">{cal.error}</p> : null}
          <button type="button" className="btn" disabled={change.isPending} onClick={() => change.mutate(() => api.dropCalendar())}>
            Stop reading my calendar
          </button>
        </>
      ) : (
        <>
          <ol className="ea-steps">
            <li>
              Open <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noreferrer">Google Calendar settings</a> on a computer.
            </li>
            <li>Under <em>Settings for my calendars</em>, choose your calendar, then <em>Integrate calendar</em>.</li>
            <li>
              Copy the <em>Secret address in iCal format</em> and paste it here. Outlook and Apple calendars give a similar private link.
            </li>
          </ol>
          <form
            className="cs-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) change.mutate(() => api.setCalendar(url.trim()), { onSuccess: () => setUrl("") });
            }}
          >
            <label htmlFor="ea-cal">Secret address</label>
            <input id="ea-cal" className="input" type="url" inputMode="url" autoComplete="off" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={change.isPending || !url.trim()}>
                {change.isPending ? "Reading it" : "Read my calendar"}
              </button>
            </div>
          </form>
          <p className="muted">The address is kept encrypted and only read by the office. Anyone with it can see your calendar, so do not share it elsewhere; you can make a new one in Google at any time.</p>
        </>
      )}
      {change.error ? <p className="form-error">{change.error.message}</p> : null}
    </Section>
  );
}

function Forwarding({ v }: { v: AssistantView }) {
  if (!v.address) return null;
  return (
    <Section title="Emails for the assistant">
      <p>
        Forward an email to <strong className="ea-address">{v.address}</strong> and a reply is drafted for your desk. A bill or invoice goes to the Accountant. Only mail from your own address is read.
      </p>
      <details>
        <summary>Forward automatically from Gmail</summary>
        <ol className="ea-steps">
          <li>In Gmail, open Settings, then <em>Forwarding and POP/IMAP</em>, and add the address above.</li>
          <li>Gmail sends a confirmation code to the assistant; it appears here. Enter it in Gmail.</li>
          <li>Make a filter (for example, mail from your customers' domains) and choose <em>Forward it to</em> the assistant.</li>
        </ol>
        {v.forwarding ? (
          <p className="ea-code">
            Gmail's confirmation code{v.forwarding.code ? <>: <strong>{v.forwarding.code}</strong></> : " arrived"}
            {v.forwarding.link ? (
              <>
                {" "}
                or{" "}
                <a href={v.forwarding.link} target="_blank" rel="noreferrer">
                  confirm with Gmail's link
                </a>
              </>
            ) : null}
            .
          </p>
        ) : null}
      </details>
    </Section>
  );
}
