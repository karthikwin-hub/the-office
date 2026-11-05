import { type BusinessFacts, type CannedAnswer, CS_CHANNEL_NAMES, type CsMessage, type CsThreadView, type CustomerDeskView, type FactKey, type Order, type OrderStatus } from "@office/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { q, useChange } from "../api/queries";
import { count, isOwner, Section, shortDate } from "./common";

const ist = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const FACTS: { key: FactKey | "humanContact"; label: string; hint: string }[] = [
  { key: "hours", label: "Opening hours", hint: "Monday to Saturday, 9:30 am to 7 pm" },
  { key: "address", label: "Address and directions", hint: "Shop number, street, landmark" },
  { key: "delivery", label: "Delivery", hint: "Where you deliver, how long it takes, what it costs" },
  { key: "returns", label: "Returns and exchanges", hint: "What can come back, and within how many days" },
  { key: "payments", label: "Payments", hint: "UPI, cards, credit terms" },
  { key: "humanContact", label: "How to reach a person", hint: "Anil on +91 98xxx xxxxx, 10 am to 6 pm" },
];

const STATUSES: OrderStatus[] = ["received", "packed", "dispatched", "delivered", "cancelled"];
const GROUND: Record<string, string> = { answer: "Your saved answer", fact: "Your business facts", order: "Their order", balance: "Their invoices", verify: "Asked who they are", greeting: "Courtesy", holding: "Holding reply", owner: "You", none: "" };

/** The Customer Service agent's desk: its conversations, what it answers from, and where customers reach it. */
export function CustomerServicePanel({ preview }: { preview?: boolean }) {
  const desk = useQuery(q.customers());
  const d = desk.data;
  if (!d) return <p className="loading">Fetching the conversations</p>;
  const readOnly = preview || !isOwner();
  return (
    <>
      {preview ? null : <Conversations d={d} readOnly={!isOwner()} />}
      {preview || !isOwner() ? null : <TryIt />}
      <Facts facts={d.facts} readOnly={readOnly} />
      <Answers answers={d.answers} readOnly={readOnly} />
      {preview ? null : <Orders readOnly={readOnly} />}
      {preview ? null : <Channels d={d} readOnly={readOnly} />}
    </>
  );
}

function Conversations({ d, readOnly }: { d: CustomerDeskView; readOnly: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const waiting = d.threads.filter((t) => t.waiting);
  return (
    <Section title="Conversations" aside={waiting.length ? <span className="cs-waiting">{count(waiting.length, "customer")} waiting</span> : null}>
      {d.threads.length ? (
        <ul className="cs-threads">
          {d.threads.map((t) => (
            <li key={t.id}>
              <button type="button" className="cs-thread-row" aria-current={open === t.id} aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span className="cs-thread-name">{t.name}</span>
                <span className="muted">
                  {CS_CHANNEL_NAMES[t.channel]}, {shortDate(t.lastAt)} {ist(t.lastAt)}
                  {t.waiting ? <span className="cs-waiting"> · waiting for you</span> : null}
                </span>
                <span className="cs-thread-preview">{t.preview}</span>
              </button>
              {open === t.id ? <Thread id={t.id} readOnly={readOnly} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No customer has written yet. Once WhatsApp, the support address or the website chat is on, conversations appear here.</p>
      )}
    </Section>
  );
}

function Messages({ messages }: { messages: CsMessage[] }) {
  return (
    <ul className="cs-messages">
      {messages.map((m) => (
        <li key={m.id} className={`cs-message${m.direction === "out" ? " cs-message-out" : ""}${m.status === "failed" ? " cs-message-failed" : ""}`}>
          {m.text}
          <span className="cs-message-meta">
            {m.direction === "in" ? "Customer" : m.by === "owner" ? "You" : "The agent"}, {ist(m.at)}
            {m.direction === "out" && m.ground && GROUND[m.ground] ? ` · from ${GROUND[m.ground]!.toLowerCase()}` : ""}
            {m.status === "draft" ? " · waiting for your approval" : ""}
            {m.status === "failed" ? ` · not sent: ${m.error ?? "failed"}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Thread({ id, readOnly }: { id: string; readOnly: boolean }) {
  const t = useQuery(q.thread(id));
  const change = useChange<CsThreadView>();
  const [text, setText] = useState("");
  if (!t.data) return <p className="loading">Opening the conversation</p>;
  const v = t.data;
  return (
    <div className="cs-conversation">
      {v.thread.verifiedContact ? <p className="muted">Confirmed as {v.thread.verifiedContact}.</p> : <p className="muted">The agent has not confirmed who this is, so it tells them nothing about orders or accounts.</p>}
      <Messages messages={v.messages} />
      {v.pending.length ? <p className="cs-waiting">Waiting on your desk: {v.pending.join("; ")}</p> : null}
      {readOnly ? null : (
        <form
          className="cs-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) change.mutate(() => api.replyThread(id, text.trim()), { onSuccess: () => setText("") });
          }}
        >
          <label htmlFor={`reply-${id}`}>Write to them yourself</label>
          <textarea id={`reply-${id}`} className="input" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={change.isPending || !text.trim()}>
              Send as you
            </button>
          </div>
          {change.error ? <p className="form-error">{change.error.message}</p> : null}
        </form>
      )}
    </div>
  );
}

function TryIt() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ messages: CsMessage[]; notes: string[] } | null>(null);
  const change = useChange<Awaited<ReturnType<typeof api.tryAgent>>>();
  return (
    <Section title="Try it as a customer">
      <p className="section-lede">Write what a customer might. You see what the agent would say and why. Nothing is sent to anyone.</p>
      <form
        className="cs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          change.mutate(() => api.tryAgent(text.trim()), {
            onSuccess: (r) => {
              setResult({ messages: r.thread.messages, notes: r.notes });
              setText("");
            },
          });
        }}
      >
        <label htmlFor="cs-try">Message</label>
        <input id="cs-try" className="input" maxLength={2000} placeholder="Where is my order SO-1042?" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button type="submit" className="btn" disabled={change.isPending || !text.trim()}>
            Send to the agent
          </button>
        </div>
      </form>
      {change.error ? <p className="form-error">{change.error.message}</p> : null}
      {result ? (
        <div className="cs-conversation" aria-live="polite">
          <Messages messages={result.messages.slice(-6)} />
          {result.notes.map((n) => (
            <p key={n} className="cs-notes">
              {n}
            </p>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function Facts({ facts, readOnly }: { facts: BusinessFacts; readOnly: boolean }) {
  const [draft, setDraft] = useState<BusinessFacts>(facts);
  const change = useChange();
  const dirty = FACTS.some((f) => draft[f.key] !== facts[f.key]);
  return (
    <Section title="Business facts">
      <p className="section-lede">The agent answers these questions word for word from what you write here. Leave one empty and it hands that question to you.</p>
      <form
        className="cs-form"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(() => api.saveFacts(Object.fromEntries(FACTS.map((f) => [f.key, draft[f.key]]))));
        }}
      >
        {FACTS.map((f) => (
          <div key={f.key}>
            <label htmlFor={`fact-${f.key}`}>{f.label}</label>
            <textarea id={`fact-${f.key}`} className="input" rows={2} maxLength={600} placeholder={f.hint} value={draft[f.key]} readOnly={readOnly} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          </div>
        ))}
        {readOnly ? null : (
          <div className="row">
            <button type="submit" className="btn" disabled={!dirty || change.isPending}>
              Save the facts
            </button>
            {change.isSuccess && !dirty ? <span className="muted">Saved.</span> : null}
          </div>
        )}
      </form>
    </Section>
  );
}

const blank = { title: "", examples: "", answer: "" };

function Answers({ answers, readOnly }: { answers: CannedAnswer[]; readOnly: boolean }) {
  const change = useChange();
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const body = (f: typeof blank, enabled = true) => ({ title: f.title.trim(), examples: f.examples.split("\n").map((x) => x.trim()).filter(Boolean), answer: f.answer.trim(), enabled });
  const submit = () => {
    const b = body(form, editing ? (answers.find((a) => a.id === editing)?.enabled ?? true) : true);
    if (!b.title || !b.answer) return;
    change.mutate(() => (editing ? api.saveAnswer(editing, b) : api.addAnswer(b)), {
      onSuccess: () => {
        setForm(blank);
        setEditing(null);
      },
    });
  };
  return (
    <Section title={`Saved answers (${answers.length})`}>
      <p className="section-lede">Your own answers to the questions customers ask most. The agent sends them as written; it never writes a reply of its own.</p>
      <ul className="cs-answers">
        {answers.map((a) => (
          <li key={a.id}>
            <span className="cs-answer-title">{a.title}</span>
            {a.enabled ? null : <span className="muted"> (off)</span>}
            <p>{a.answer}</p>
            {a.examples.length ? <p className="muted">Asked as: {a.examples.map((x) => `"${x}"`).join(", ")}</p> : null}
            {readOnly ? null : (
              <div className="row">
                <button type="button" className="btn btn-quiet" onClick={() => change.mutate(() => api.saveAnswer(a.id, { title: a.title, examples: a.examples, answer: a.answer, enabled: !a.enabled }))} disabled={change.isPending}>
                  {a.enabled ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    setEditing(a.id);
                    setForm({ title: a.title, examples: a.examples.join("\n"), answer: a.answer });
                  }}
                >
                  Change
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => change.mutate(() => api.removeAnswer(a.id))} disabled={change.isPending}>
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <form
          className="cs-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="ans-title">{editing ? "Change the answer" : "Add an answer"}</label>
          <input id="ans-title" className="input" maxLength={120} placeholder="Short name, for example GST invoice" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label htmlFor="ans-examples">How customers ask it, one per line</label>
          <textarea id="ans-examples" className="input" rows={3} value={form.examples} onChange={(e) => setForm({ ...form, examples: e.target.value })} />
          <label htmlFor="ans-answer">Your answer</label>
          <textarea id="ans-answer" className="input" rows={3} maxLength={2000} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
          <div className="row">
            <button type="submit" className="btn" disabled={change.isPending || !form.title.trim() || !form.answer.trim()}>
              {editing ? "Save the answer" : "Add the answer"}
            </button>
            {editing ? (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {change.error ? <p className="form-error">{change.error.message}</p> : null}
        </form>
      )}
    </Section>
  );
}

const newOrder = { number: "", customer: "", phone: "", email: "", items: "", expectedOn: "" };

function Orders({ readOnly }: { readOnly: boolean }) {
  const orders = useQuery(q.orders());
  const change = useChange<unknown>();
  const [form, setForm] = useState(newOrder);
  const [imported, setImported] = useState<string | null>(null);
  const list: Order[] = orders.data?.orders ?? [];
  return (
    <Section title={`Orders (${list.length})`}>
      <p className="section-lede">What the agent tells customers who ask where their order is. It shows an order only to the phone or email on it. Update one from WhatsApp too: "order 1042 dispatched" and the tracking link.</p>
      {list.length ? (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Customer</th>
              <th scope="col">Items</th>
              <th scope="col">Expected</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id}>
                <td>{o.number}</td>
                <td>
                  {o.customer}
                  <span className="muted"> {o.phone || o.email}</span>
                </td>
                <td>{o.items}</td>
                <td>{o.expectedOn ? shortDate(o.expectedOn) : "-"}</td>
                <td>
                  {readOnly ? (
                    o.status
                  ) : (
                    <select className="input" aria-label={`Status of ${o.number}`} value={o.status} disabled={change.isPending} onChange={(e) => change.mutate(() => api.saveOrder(o.id, { status: e.target.value as OrderStatus }))}>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No orders yet. Add them here, or import a spreadsheet saved as CSV.</p>
      )}
      {readOnly ? null : (
        <>
          <form
            className="cs-form"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate(() => api.addOrder({ number: form.number, customer: form.customer, phone: form.phone, email: form.email, items: form.items, expectedOn: form.expectedOn || null }), { onSuccess: () => setForm(newOrder) });
            }}
          >
            <label htmlFor="ord-number">Add an order</label>
            <div className="row">
              <input id="ord-number" className="input" placeholder="Order number" required maxLength={40} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
              <input className="input" aria-label="Customer" placeholder="Customer" required maxLength={120} value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} />
            </div>
            <div className="row">
              <input className="input" aria-label="Phone" placeholder="Phone" maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input className="input" aria-label="Email" placeholder="Email" type="email" maxLength={200} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="row">
              <input className="input" aria-label="Items" placeholder="Items" maxLength={500} value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} />
              <input className="input" aria-label="Expected on" type="date" value={form.expectedOn} onChange={(e) => setForm({ ...form, expectedOn: e.target.value })} />
            </div>
            <div className="row">
              <button type="submit" className="btn" disabled={change.isPending || !form.number.trim() || !form.customer.trim()}>
                Add the order
              </button>
            </div>
          </form>
          <div className="cs-form">
            <label htmlFor="ord-csv">Import orders from a CSV file</label>
            <input
              id="ord-csv"
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const content = await file.text();
                change.mutate(() => api.importOrders(content), {
                  onSuccess: (r) => {
                    const x = r as Awaited<ReturnType<typeof api.importOrders>>;
                    setImported(`${count(x.added, "order")} added, ${x.updated} updated${x.skipped.length ? `; skipped: ${x.skipped.slice(0, 3).join("; ")}` : ""}.`);
                  },
                });
                e.target.value = "";
              }}
            />
            <p className="muted">Columns: order number, customer, phone, email, items, status, placed, expected, tracking. A number already here is updated.</p>
            {imported ? <p aria-live="polite">{imported}</p> : null}
          </div>
          {change.error ? <p className="form-error">{change.error.message}</p> : null}
        </>
      )}
    </Section>
  );
}

function Channels({ d, readOnly }: { d: CustomerDeskView; readOnly: boolean }) {
  const change = useChange();
  const snippet = d.widget.snippet ? `<script src="${window.location.origin}${d.widget.snippet}" async></script>` : null;
  return (
    <Section title="Where customers reach the agent">
      <dl className="cs-form">
        <dt>WhatsApp</dt>
        <dd>
          Customers who message your own WhatsApp Business number are answered here. Connect the number under Settings, Channels; the office's shared number is never used for customers. {d.whatsappThisMonth} replies this month; Meta does not charge for the first 1,000 conversations a business answers each month.
        </dd>
        <dt>Email</dt>
        <dd>{d.supportEmail ? <>Forward your customer email to <strong>{d.supportEmail}</strong>, or give customers this address. Replies come from the office with this address to answer to.</> : "Hire the agent to get a support address."}</dd>
        <dt>Website chat</dt>
        <dd>
          {d.widget.enabled ? "On." : "Off."}{" "}
          {readOnly ? null : (
            <button type="button" className="btn btn-quiet" onClick={() => change.mutate(() => api.setWidget(!d.widget.enabled))} disabled={change.isPending}>
              {d.widget.enabled ? "Turn off" : "Turn on"}
            </button>
          )}
          {d.widget.enabled && snippet ? (
            <>
              <p>Paste this before the end of the body on every page of your website:</p>
              <code className="cs-snippet">{snippet}</code>
            </>
          ) : null}
        </dd>
        <dt>
          <label htmlFor="cs-retention">Keep conversations for</label>
        </dt>
        <dd>
          <select id="cs-retention" className="input" value={d.retentionMonths} disabled={readOnly || change.isPending} onChange={(e) => change.mutate(() => api.saveCsSettings(Number(e.target.value)))}>
            {[3, 6, 12, 24, 36].map((m) => (
              <option key={m} value={m}>
                {m} months
              </option>
            ))}
          </select>{" "}
          <span className="muted">Older conversations are deleted each morning.</span>
        </dd>
      </dl>
    </Section>
  );
}
