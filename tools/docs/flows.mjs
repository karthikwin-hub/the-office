#!/usr/bin/env node
// The owners' process diagrams in the reference guide ("How the work flows"), drawn from the data at the
// foot of this file into docs/reference/diagrams/flow-<id>.svg. Run by tools/docs/reference.mjs before it
// builds the page, or on its own:  node tools/docs/flows.mjs
//
// Every diagram is columns of boxes joined by arrows. An agent's diagram always has the same four columns
// (what starts it, what it does, your Desk, what happens next), a tag saying how much of it is built, and a
// "Not yet" strip for what its job description promises but the code does not do. Describe what happens
// today: a diagram must never read as a promise. Text is wrapped to its box, and the build stops if a word
// cannot fit, so no diagram goes out with clipped text.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "../../docs/reference/diagrams");
const W = 960;
const PAD = 12;
const GAP = 30;
const TITLE = 13.5;
const TEXT = 12;
const LINE = 16;
// A conservative average glyph width for Atkinson Hyperlegible, as a fraction of the font size.
const GLYPH = 0.57;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Words into lines no wider than the box; a word that cannot fit at all is an error, not a clipped word. */
function wrap(text, width, size, where) {
  const max = Math.floor((width - 2 * PAD) / (size * GLYPH));
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (word.length > max) throw new Error(`flows: "${word}" is too long for its box in ${where} (${max} characters fit)`);
      if (!line) line = word;
      else if (line.length + 1 + word.length <= max) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const KINDS = {
  box: "box",
  desk: "desk",
  done: "done",
  stop: "stop",
  none: "none",
};

/** One box, laid out: its lines and its height. */
function layoutBox(b, width, where) {
  const title = b.title ? wrap(b.title, width, TITLE, where) : [];
  const body = (b.lines ?? (b.text ? [b.text] : [])).flatMap((t, i, all) => wrap(all.length > 1 && b.lines ? `• ${t}` : t, width, TEXT, where));
  const h = PAD + title.length * (LINE + 1) + body.length * LINE + PAD - 2;
  return { ...b, kind: KINDS[b.kind ?? "box"] ?? "box", titleLines: title, bodyLines: body, w: width, h: Math.max(h, 40) };
}

/**
 * A diagram: columns of boxes, arrows between boxes by id. Arrows go right between columns and down within a
 * column. `status` is the tag at the top right; `notYet` the strip along the foot.
 */
function draw(d) {
  const where = `flow-${d.id}`;
  const widths = d.columns.map((c) => c.width);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  if (total > W - 20) throw new Error(`flows: ${where} is ${total}px wide; at most ${W - 20} fit`);
  let x = (W - total) / 2;
  const top = d.status ? 62 : 40;
  const boxes = new Map();
  const cols = d.columns.map((c, ci) => {
    let y = top;
    const laid = c.boxes.map((b) => {
      const indent = b.indent ?? 0;
      const l = layoutBox(b, c.width - indent, `${where}, column ${ci + 1}`);
      const placed = { ...l, x: x + indent, y, indent };
      if (b.id) {
        if (boxes.has(b.id)) throw new Error(`flows: ${where} has two boxes called ${b.id}`);
        boxes.set(b.id, { ...placed, col: ci });
      }
      y += l.h + (c.gap ?? 18);
      return placed;
    });
    const col = { head: c.head, x, width: c.width, boxes: laid, bottom: y - (c.gap ?? 18) };
    x += c.width + GAP;
    return col;
  });
  let bottom = Math.max(...cols.map((c) => c.bottom));
  let foot = "";
  if (d.notYet?.length) {
    const text = `Not yet: ${d.notYet.join("; ")}.`;
    const width = total;
    const lines = wrap(text, width, TEXT, `${where}, not yet`);
    const fy = bottom + 26;
    const fx = (W - total) / 2;
    const fh = PAD + lines.length * LINE + PAD - 4;
    foot = `<rect class="nyet" x="${fx}" y="${fy}" width="${width}" height="${fh}" rx="4"/>${lines.map((l, i) => `<text class="ny" x="${fx + PAD}" y="${fy + PAD + 10 + i * LINE}">${esc(l)}</text>`).join("")}`;
    bottom = fy + fh;
  }
  const H = Math.ceil(bottom + 14);

  const arrows = (d.edges ?? []).map(([from, to]) => {
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b) throw new Error(`flows: ${where} has an arrow from ${from} to ${to}, but no such box`);
    if (a.col === b.col) {
      if (b.y < a.y) throw new Error(`flows: ${where} has an arrow up its column, from ${from} to ${to}`);
      // Into a fork: straight down into it. Past a fork to the next step: down the left of the column, beside it.
      const cx = b.indent ? b.x + b.w / 2 : cols[a.col].x + 28;
      return `<path class="ln" d="M${cx} ${a.y + a.h}V${b.y - 2}"/>`;
    }
    if (b.col < a.col) throw new Error(`flows: ${where} has an arrow going left, from ${from} to ${to}`);
    const y1 = a.y + Math.min(a.h / 2, 24);
    const y2 = b.y + Math.min(b.h / 2, 24);
    const x1 = a.x + a.w;
    const x2 = b.x - 2;
    const mid = cols[a.col].x + cols[a.col].width + GAP / 2;
    if (b.col === a.col + 1) return `<path class="ln" d="M${x1} ${y1}H${mid}V${y2}H${x2}"/>`;
    // Skipping a column: below that column's boxes, so the line never crosses one.
    const under = Math.max(...cols.slice(a.col + 1, b.col).map((c) => c.bottom)) + 14;
    const mid2 = cols[b.col].x - GAP / 2;
    return `<path class="ln" d="M${x1} ${y1}H${mid}V${under}H${mid2}V${y2}H${x2}"/>`;
  });

  const heads = cols.map((c) => (c.head ? `<text class="hd" x="${c.x}" y="${top - 12}">${esc(c.head.toUpperCase())}</text>` : "")).join("");
  const tag = d.status
    ? (() => {
        const label = { works: "Works today", reports: "Reports only", partly: "Partly built" }[d.status];
        if (!label) throw new Error(`flows: ${where} has an unknown status ${d.status}`);
        const tw = Math.ceil(label.length * TEXT * 0.62) + 24;
        return `<rect class="tag-${d.status}" x="${W - 12 - tw}" y="10" width="${tw}" height="24" rx="12"/><text class="tg" x="${W - 12 - tw / 2}" y="26" text-anchor="middle">${esc(label)}</text>`;
      })()
    : "";
  const body = cols
    .flatMap((c) => c.boxes)
    .map((b) => {
      const ty = b.y + PAD + 11;
      const t = b.titleLines.map((l, i) => `<text class="t" x="${b.x + PAD}" y="${ty + i * (LINE + 1)}">${esc(l)}</text>`).join("");
      const sy = ty + b.titleLines.length * (LINE + 1);
      const s = b.bodyLines.map((l, i) => `<text class="s" x="${b.x + PAD}" y="${sy + i * LINE}">${esc(l)}</text>`).join("");
      return `<rect class="${b.kind}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4"/>${t}${s}`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t-${d.id}">
  <title id="t-${d.id}">${esc(d.alt)}</title>
  <defs><marker id="a-${d.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#27408B"/></marker></defs>
  <style>
    .box{fill:#fff;stroke:#2A2D31;stroke-width:1.3}
    .desk{fill:#E8ECF6;stroke:#27408B;stroke-width:1.6}
    .done{fill:#EEF4EE;stroke:#3C6E47;stroke-width:1.3}
    .stop{fill:#F7F1EC;stroke:#8A5A2B;stroke-width:1.3}
    .none{fill:#fafafa;stroke:#9AA1AB;stroke-width:1.2;stroke-dasharray:5 4}
    .nyet{fill:#fbfaf7;stroke:#9AA1AB;stroke-width:1.2;stroke-dasharray:5 4}
    .t{font-size:${TITLE}px;fill:#2A2D31;font-weight:700}
    .s{font-size:${TEXT}px;fill:#4A5260}
    .ny{font-size:${TEXT}px;fill:#5A6270;font-style:italic}
    .hd{font-size:11px;fill:#5A6270;font-weight:700;letter-spacing:.08em}
    .tg{font-size:12px;font-weight:700;fill:#fff}
    .tag-works{fill:#3C6E47}
    .tag-reports{fill:#5A6270}
    .tag-partly{fill:#8A5A2B}
    .ln{stroke:#27408B;stroke-width:1.4;fill:none;marker-end:url(#a-${d.id})}
  </style>
  ${heads}${tag}
  ${arrows.join("")}
  ${body}
  ${foot}
</svg>
`;
}

// ── An agent's diagram: always the same four columns ───────────────────────────────────────────────
const C = { in: 170, does: 280, desk: 205, next: 185 };
/** A fork sits to the right of the main line of steps, so the arrow from one step to the next passes beside it. */
const INDENT = 56;
/** `starts`, `does`, `desk` and `next` are lists of boxes; arrows join each start to the first step, the steps in turn, a step to each Desk card (the last step unless a card names `from`), and each card to the results that name it. */
function agent(a) {
  const n = (p, i) => `${p}${i}`;
  const edges = [];
  a.starts.forEach((_, i) => edges.push([n("in", i), "do0"]));
  // Each step follows the last main step before it; a fork (`branch: true`, or the number of the step it leaves) hangs off its step.
  const prevMain = (i) => {
    for (let j = i - 1; j >= 0; j--) if (!a.does[j].branch) return j;
    return -1;
  };
  a.does.forEach((s, i) => {
    const from = typeof s.branch === "number" ? s.branch : prevMain(i);
    if (i && from >= 0) edges.push([n("do", from), n("do", i)]);
  });
  const deskBoxes = a.desk.length ? a.desk : [{ kind: "none", title: "Nothing on your Desk", text: a.noDesk ?? "It drafts nothing for you to approve." }];
  deskBoxes.forEach((c, i) => edges.push([n("do", c.from ?? lastStep(a.does)), n("dk", i)]));
  a.next.forEach((r, i) => edges.push([r.from === undefined ? n("dk", 0) : typeof r.from === "string" ? r.from : n("dk", r.from), n("nx", i)]));
  return {
    id: a.id,
    alt: a.alt,
    status: a.status,
    notYet: a.notYet,
    columns: [
      { head: "What starts it", width: C.in, boxes: a.starts.map((b, i) => ({ ...b, id: n("in", i) })) },
      {
        head: "What it does",
        width: C.does,
        gap: 16,
        boxes: a.does.map((b, i) => ({ ...b, id: n("do", i), kind: b.kind ?? (b.branch ? "stop" : "box"), indent: b.branch ? INDENT : 0 })),
      },
      { head: "On your Desk", width: C.desk, boxes: deskBoxes.map((b, i) => ({ ...b, id: n("dk", i), kind: b.kind ?? "desk" })) },
      { head: "What happens next", width: C.next, boxes: a.next.map((b, i) => ({ ...b, id: n("nx", i), kind: b.kind ?? "done" })) },
    ],
    edges,
  };
}
const lastStep = (does) => {
  for (let i = does.length - 1; i >= 0; i--) if (!does[i].branch) return i;
  return 0;
};

// ── The diagrams ───────────────────────────────────────────────────────────────────────────────────
const MORNING = { title: "The morning round", text: "Every morning at the digest time, 08:45 unless you change it in Settings" };

export const FLOWS = [
  {
    id: "overview",
    alt: "How work moves through your office: it comes in, the agent for that job drafts what should happen, you decide on your Desk, and the result goes into your books or out to the right person",
    columns: [
      {
        head: "Ways in",
        width: 195,
        boxes: [
          {
            id: "mail",
            title: "Email",
            lines: [
              "Bills and invoices: your office's address",
              "Marketplace reports: its .sales address",
              "Your own email: its .assistant address",
              "Customers: its .help address",
            ],
          },
          { id: "up", title: "Upload in the app", text: "PDFs, photos, sales reports and the CSV files of your existing books" },
          { id: "wa", title: "WhatsApp", text: "The office's shared number for you and your people; your own business number for customers" },
          { id: "soc", title: "Instagram, Facebook, Threads", text: "Comments, reviews and messages" },
          { id: "am", ...MORNING },
        ],
      },
      {
        head: "The agents",
        width: 220,
        boxes: [
          {
            id: "ag",
            title: "The agent for that job",
            text: "Reads it, checks it against your books and drafts what should happen. Every amount and tax figure is worked out by code, never by AI.",
          },
          {
            id: "unk",
            kind: "stop",
            title: "From someone new?",
            text: "A document from a sender who is not in your books is never posted on its own, at any trust level: it waits for you.",
          },
          { id: "dup", kind: "stop", title: "Seen before?", text: "The same bill, invoice, proforma or report again is set aside without asking." },
        ],
      },
      {
        head: "Your Desk",
        width: 210,
        boxes: [
          {
            id: "desk",
            kind: "desk",
            title: "A card on your Desk",
            text: "Says exactly what will happen, with the page behind each figure. Approve, edit or reject: on the web, or by number on WhatsApp for most cards.",
          },
          { id: "alone", kind: "none", title: "Or done on its own", text: "Only routine work, and only for an agent you have made Trusted or Autonomous." },
        ],
      },
      {
        head: "The result",
        width: 205,
        boxes: [
          { id: "books", kind: "done", title: "Your books", text: "Posted bills and invoices feed GST, TDS, who owes you and the Boardroom." },
          { id: "sent", kind: "done", title: "Sent out", text: "Payment reminders, replies to customers, posts and replies to your own email." },
          { id: "filed", kind: "done", title: "Filed for the record", text: "Proformas, delivery notes and credit notes: kept, not posted." },
          {
            id: "log",
            kind: "done",
            title: "The team log and the digest",
            text: "Every action is written in the log; the morning digest tells you what happened.",
          },
        ],
      },
    ],
    edges: [
      ["mail", "ag"],
      ["up", "ag"],
      ["wa", "ag"],
      ["soc", "ag"],
      ["am", "ag"],
      ["ag", "unk"],
      ["unk", "dup"],
      ["ag", "desk"],
      ["desk", "alone"],
      ["desk", "books"],
      ["desk", "sent"],
      ["desk", "filed"],
      ["alone", "log"],
    ],
  },
  {
    id: "trust",
    alt: "Trust levels: every agent starts as a Trainee, you can promote it to Trusted and then Autonomous when its record allows, and some work always waits for you",
    columns: [
      {
        head: "Trainee",
        width: 205,
        boxes: [
          {
            id: "tr",
            title: "Every card waits for you",
            text: "Each agent starts here. Every decision you make is counted; an approval without changes counts as correct.",
          },
          {
            id: "p1",
            kind: "none",
            title: "Promotion offered",
            text: "After 50 decisions with 97% approved unchanged. Nothing promotes itself: you choose the level in the agent's room.",
          },
        ],
      },
      {
        head: "Trusted",
        width: 245,
        boxes: [
          {
            id: "ts",
            title: "Routine work goes ahead alone",
            lines: [
              "A bill or invoice from a party already in your books, every check passed, under ₹1 lakh",
              "A polite first payment reminder",
              "A quotation or purchase order under ₹1 lakh",
              "A thank-you to a 4 or 5 star review, with no figures or promises",
              "A post from a calendar you approved, unchanged and passing every check again",
            ],
          },
          { id: "p2", kind: "none", title: "Promotion offered", text: "After 300 decisions with 99.5% approved unchanged." },
        ],
      },
      {
        head: "Autonomous",
        width: 190,
        boxes: [
          {
            id: "au",
            title: "Acts, and reports",
            text: "Everything goes ahead on its own and is logged, except the work that always waits. Social replies and posts keep the Trusted rules.",
          },
        ],
      },
      {
        head: "Always waits for you",
        width: 210,
        boxes: [
          {
            id: "aa",
            kind: "desk",
            title: "At every level",
            lines: [
              "Bringing in your books",
              "A new layout of sales report",
              "A customer handed to you",
              "Replies to your own email",
              "Audit findings",
              "Sharing files with your accountant",
              "Compliance proposals",
              "Campaigns, social calendars and WhatsApp broadcasts",
              "Payroll runs",
            ],
          },
        ],
      },
    ],
    edges: [
      ["tr", "p1"],
      ["p1", "ts"],
      ["ts", "p2"],
      ["p2", "au"],
    ],
  },
  {
    id: "morning",
    alt: "The morning round: at the digest time each hired agent does its morning work in a fixed order, then the digest goes to each owner by WhatsApp or email",
    columns: [
      {
        head: "When",
        width: 170,
        boxes: [
          { id: "m", ...MORNING },
          { id: "run", kind: "none", title: "Run now", text: "Any routine can also be run from its room, or paused there." },
        ],
      },
      {
        head: "In this order",
        width: 300,
        gap: 10,
        boxes: [
          { id: "r1", title: "1. Trusted work", text: "Agents you have made Trusted or Autonomous finish the routine cards waiting" },
          { id: "r2", title: "2. Payment reminders", text: "Approved reminders that could not be sent are tried again" },
          { id: "r3", title: "3. Social media", text: "Comments and results fetched; posts due published; from the 25th, next month's calendar drafted" },
          { id: "r4", title: "4. Reorder check", text: "Purchase orders drafted for items at or under their reorder level" },
          { id: "r5", title: "5. Online sales", text: "The last day the marketplace reports cover, and products whose returns are climbing" },
          { id: "r6", title: "6. Filings due", text: "Reminders 7 days and 2 days before, on the day, and weekly while late" },
          { id: "r7", title: "7. Customers waiting", text: "Hand-offs waiting more than 4 hours; WhatsApp chats about to close" },
          { id: "r8", title: "8. Your agenda", text: "Each owner's next three days, for that owner only" },
          { id: "r9", title: "9. The digest", text: "What is waiting on your Desk, and what each routine did" },
        ],
      },
      {
        head: "How it reaches you",
        width: 200,
        boxes: [
          { id: "d1", kind: "done", title: "WhatsApp", text: "If you chose the digest and wrote to the office in the last 24 hours" },
          { id: "d2", kind: "done", title: "A WhatsApp template", text: "Otherwise, if one is set up" },
          { id: "d3", kind: "done", title: "Email", text: "Otherwise" },
        ],
      },
      {
        head: "Then",
        width: 180,
        boxes: [
          {
            id: "rep",
            kind: "desk",
            title: "Reply to decide",
            text: '"1 yes 2 no" or "all yes" on WhatsApp. Campaigns, calendars, broadcasts, posts, audit findings, file shares and payroll open on the Desk instead.',
          },
        ],
      },
    ],
    edges: [
      ["m", "r1"],
      ["run", "r1"],
      ["r1", "r2"],
      ["r2", "r3"],
      ["r3", "r4"],
      ["r4", "r5"],
      ["r5", "r6"],
      ["r6", "r7"],
      ["r7", "r8"],
      ["r8", "r9"],
      ["r9", "d1"],
      ["r9", "d2"],
      ["r9", "d3"],
      ["d1", "rep"],
    ],
  },

  // ── Front office ──
  agent({
    id: "office-manager",
    alt: "The Office Manager: answers your questions with figures you can open, does the trusted work each morning and sends the digest",
    status: "works",
    starts: [
      { title: "Ask the office manager", text: "The box at the top of every page" },
      { title: "WhatsApp", text: '"ask" and your question, by text or voice' },
      MORNING,
    ],
    does: [
      { title: "1. Finds what you asked about", text: "Who owes you, sales, GST, TDS, audit, stock, what is waiting, and more" },
      { title: "2. Answers from your books", text: "Each figure in the answer opens the documents behind it. No AI writes the figures." },
      { title: "3. Each morning", text: "Lets Trusted agents finish routine work, then puts the digest together" },
    ],
    desk: [],
    noDesk: "It answers and reports; it drafts nothing for you to approve.",
    next: [
      { title: "The answer", text: "On the page or on WhatsApp", from: "dk0" },
      { title: "The morning digest", text: "By WhatsApp or email to each owner", from: "dk0" },
    ],
    notYet: ["flagging problems between agents"],
  }),
  agent({
    id: "customer-service",
    alt: "Customer Service: answers your customers on WhatsApp, email and website chat from your own answers and records, and hands anything sensitive to you",
    status: "works",
    starts: [
      { title: "Your business WhatsApp", text: "Customers write to your own number" },
      { title: "Email", text: "To the office's .help address" },
      { title: "Website chat", text: "When you switch it on" },
      { ...MORNING, text: "Chases customers still waiting" },
    ],
    does: [
      { title: "1. Knows the customer", text: "By their number or email; on the website by an order number and phone or email" },
      { title: "2. Understands the message", text: "Rules first; the AI model only when the rules are unsure (150 a day)" },
      {
        title: "Sensitive or unsure?",
        branch: true,
        text: "Refunds, complaints, legal threats, anger, price talk, cancellations, asking for a person, or low confidence: handed to you",
      },
      {
        title: "3. Otherwise answers",
        text: "From your saved answers, business facts, order status or the customer's balance. The first reply says it is an AI and how to reach you.",
      },
    ],
    desk: [
      { title: '"Reply to <name> on <channel>"', text: "While it is a Trainee, and when a Trusted agent answers from business facts", from: 3 },
      { title: '"<name> on <channel> wants …"', text: "A hand-off: always waits for you. The customer is told someone will reply.", from: 2 },
    ],
    next: [
      { title: "Approve", text: "The reply goes to the customer, as written or as you edited it", from: 0 },
      { title: "Answer a hand-off", text: "Your reply is sent, and can be saved as a new answer for next time", from: 1 },
      { kind: "stop", title: "Reject", text: "Nothing is sent; a hand-off is closed", from: 1 },
    ],
  }),
  agent({
    id: "executive-assistant",
    alt: "The Executive Assistant: each owner's own calendar, three-day agenda, tasks and replies to forwarded emails, private to that owner",
    status: "works",
    starts: [
      { title: "Email you forward", text: "To the office's .assistant address, from your own address only" },
      { title: "Your calendar", text: "Its private link, read every morning and when you open the room" },
      { title: "Tasks", text: 'In the room, or "remind me…" and "done…" on WhatsApp' },
      MORNING,
    ],
    does: [
      { title: "Has a bill or invoice attached?", branch: false, kind: "stop", text: "Passed to the Accountant" },
      { title: "1. Drafts a reply", text: "With the AI model (100 a day), or a plain template when it is not available" },
      { title: "2. Checks the figures", text: "Any amount in the draft that your books do not hold is flagged" },
      {
        title: "3. Plans your three days",
        text: "Meetings with a short brief from the books on that customer or supplier, tasks, filings due and a free slot",
      },
    ],
    desk: [{ title: '"Reply to <sender>: <subject>"', text: "Always waits for you. Only you see it: not other owners, not the accountant.", from: 2 }],
    next: [
      { title: "Send reply", text: "Goes from the office's address in your name; replies come to you. A promise in it becomes a follow-up task." },
      { title: "Your agenda", text: "In your own morning digest", from: "do3" },
    ],
    notYet: ["a brief sent just before each meeting (today it is in the morning agenda)", "reading Gmail and creating calendar events directly"],
  }),

  // ── Accounts ──
  agent({
    id: "accountant",
    alt: "The Accountant: reads each bill and invoice, checks it, sets aside duplicates, files proformas and notes, and puts the rest on your Desk to post",
    status: "works",
    starts: [
      { title: "Email", text: "To the office's address: PDFs and photos, up to 5 a message" },
      { title: "Upload", text: "In the Accountant's room" },
      { title: "From the assistant", text: "Bills attached to email you forwarded" },
      { title: "WhatsApp", text: "A photo of a bill, or a voice note" },
    ],
    does: [
      {
        title: "1. Reads the page",
        text: "Rules read the text first; the AI model only where the rules miss something; scans by the vision model. Emailed PDFs are read when someone next opens the app.",
      },
      { title: "2. What is it?", text: "By its title and its number field: tax invoice or bill, proforma, delivery note, credit or debit note" },
      { title: "Proforma, challan or note?", branch: true, text: "Filed for the record, not posted" },
      {
        title: "3. Checks it",
        text: "GSTIN check digit, lines times rates, tax by rate, CGST and SGST or IGST for the place of supply, the total, TDS due, input credit",
      },
      { title: "Already in the books?", branch: 3, text: "Set aside as a duplicate, without asking" },
    ],
    desk: [
      {
        title: '"Post bill <no> from <supplier>" or "Record sales invoice <no> to <customer>"',
        text: "Failed checks are listed on the card. Trusted: goes ahead alone only if every check passed, the party is known and it is under ₹1 lakh.",
        from: 3,
      },
      { title: '"File proforma … / delivery note … / credit note …"', text: "Always waits for you", from: 2 },
    ],
    next: [
      { title: "Approve", text: "Posted: it counts in GST, TDS, who owes you and what you owe. A new party is added.", from: 0 },
      { title: "File it", text: "Kept with its page; nothing changes in the books or returns", from: 1 },
      { kind: "stop", title: "Reject", text: "The bill is rejected or the invoice cancelled", from: 0 },
    ],
    notYet: ["matching bank receipts to invoices", "posting credit notes and stock movements"],
  }),
  agent({
    id: "onboarding",
    alt: "Bringing in your books: the CSV templates are checked row by row, then one card on your Desk brings in the parties, products, stock and unpaid items from before your start date",
    status: "works",
    starts: [
      { title: "Settings → Bring in your books", text: "Up to three CSV files: parties, products, unpaid invoices and bills" },
      { title: "Tally parties", text: "Today written into the same parties template; no direct Tally import yet" },
    ],
    does: [
      { title: "1. Check the files", text: "Every row: required columns, GSTIN check digit, duplicates. Each problem is listed with its row." },
      { title: "Problems?", branch: true, text: "Fix the file and check again; nothing is staged" },
      { title: "2. Bring them in", text: "One card is put on the Desk for the Accountant's import" },
    ],
    desk: [
      {
        title: '"Bring in your books from before <date>"',
        text: "Shows how many customers, suppliers and products, and what is owed each way. Always waits for you.",
      },
    ],
    next: [
      { title: "Approve", text: "Parties, products and stock are added; each unpaid item comes in as a brought-forward invoice or bill." },
      { kind: "stop", title: "Reject", text: "Nothing is added" },
    ],
  }),
  agent({
    id: "credit-controller",
    alt: "The Credit Controller: works out who is overdue each time you open the Desk and drafts a reminder of the right tone for each customer",
    status: "works",
    starts: [
      { title: "Your posted invoices", text: "Due dates from each customer's payment terms (30 days unless set)" },
      { ...MORNING, text: "Retries reminders that could not be sent; Trusted sends polite ones" },
    ],
    does: [
      { title: "1. Who is overdue", text: "Overdue invoices grouped by customer; customers owing under ₹10,000 in all are left alone" },
      { title: "2. Picks the tone", text: "From the oldest invoice: polite from 1 day late, firm from 16 days, final from 46 days" },
      { title: "3. Writes the letter", text: "Listing each invoice and the total" },
    ],
    desk: [
      {
        title: '"Send a reminder / a firm reminder / a final reminder to <customer>"',
        text: "Edit the subject and letter before approving. Trusted: polite first reminders go alone.",
      },
    ],
    next: [
      { title: "Approve", text: "Emailed to the customer in your business's name, replies to you; tried again up to 3 times if it fails" },
      { kind: "stop", title: "Reject", text: "Not sent; drafted again another day if still overdue" },
    ],
  }),
  agent({
    id: "tax-clerk",
    alt: "The Tax Clerk: works out GST and TDS from the posted books by fixed rules and prepares the return files for download",
    status: "reports",
    starts: [{ title: "You open GST or TDS", text: "In the Boardroom, or ask for a file" }],
    does: [
      { title: "1. Works out the returns", text: "GSTR-1 and GSTR-3B, and TDS by section, from posted documents only, by fixed rules" },
      { title: "2. Prepares the files", text: "GSTR-1 as the portal's JSON; GSTR-3B and TDS as spreadsheets" },
    ],
    desk: [],
    noDesk: "Nothing in the real flow; the demo shows a sample card.",
    next: [
      { title: "Download", text: "You or your accountant file them on the portal; the office never files" },
      { title: "Ask the office manager", text: '"What GST do I pay this month?"' },
    ],
    notYet: ["sending the files to your accountant from the Desk"],
  }),
  agent({
    id: "auditor",
    alt: "The Auditor: when you bring in a filed return or GSTR-2B, compares it with the books and puts each difference on your Desk to raise with your accountant",
    status: "partly",
    starts: [{ title: "Bring in a filed return", text: "GSTR-1, GSTR-3B or 26Q as filed, or the GSTR-2B statement" }],
    does: [
      { title: "1. Compares with the books", text: "Each return against what the books say it should be" },
      { title: "2. Checks credit and TDS", text: "Input credit claimed for bills not in GSTR-2B; TDS customers deducted that is missing from Form 26AS" },
      { title: "3. Explains each difference", text: "With the documents on both sides" },
    ],
    desk: [{ title: '"Raise with <firm>: <finding>"', text: "One card per finding. Always waits; your accountant can decide it too." }],
    next: [
      { title: "Approve", text: "Recorded as raised in the log" },
      { kind: "stop", title: "Reject", text: "Dismissed" },
      { title: "The Audit screen", text: "Every finding with its working", from: "do2" },
    ],
    notYet: ["checking anything before a return is brought in", "raising a finding contacts no one yet"],
  }),

  // ── Sales ──
  agent({
    id: "sales-rep",
    alt: "The Sales Rep: shows the pipeline of leads that come in from social media enquiries and WhatsApp voice notes",
    status: "reports",
    starts: [
      { title: "A social media enquiry", text: "The Social Media Manager turns it into a lead" },
      { title: "A WhatsApp voice note", text: "Asking for a quote, when the Quote Desk is not hired" },
    ],
    does: [{ title: "1. Keeps the pipeline", text: "Open leads, their value and stage, new this week" }],
    desk: [],
    next: [{ title: "Boardroom → Pipeline", text: "And answers about leads through the Office Manager" }],
    notYet: ["qualifying enquiries", "following up open leads", "moving leads between stages"],
  }),
  agent({
    id: "quote-desk",
    alt: "The Quote Desk: shows your quotations and which customers are overdue",
    status: "reports",
    starts: [{ title: "A WhatsApp voice note", text: 'Asking for a quote becomes a lead marked "Draft the quotation"' }],
    does: [{ title: "1. Lists your quotations", text: "With customers more than 60 days overdue marked" }],
    desk: [],
    noDesk: "Nothing in the real flow; the demo shows a sample card.",
    next: [{ title: "Boardroom → Quotations", text: "Open, sent and accepted quotations" }],
    notYet: ["drafting quotations from your price list", "discounts within your limits", "sending a quotation when you approve it"],
  }),
  agent({
    id: "marketplace-manager",
    alt: "The Marketplace Manager: reads the sales and payout reports the marketplaces send into sales by channel, product, state and city, asking you once about a new layout",
    status: "works",
    starts: [
      { title: "Email", text: "To the office's .sales address, from your people or the platforms; anything else is set aside" },
      { title: "Upload", text: "In its room: CSV, XLSX or zip" },
      { title: "WhatsApp", text: "A spreadsheet sent to the office" },
    ],
    does: [
      { title: "Same file as before?", branch: false, kind: "stop", text: "Set aside; nothing counted twice" },
      {
        title: "1. Recognises the report",
        text: "Amazon tax, transaction and settlement reports; Flipkart; Meesho; Myntra's P&L; or a layout you confirmed before",
      },
      { title: "A layout it has not seen?", branch: true, text: "It guesses the columns and asks you once" },
      {
        title: "2. Reads every row",
        text: "Into sales and returns by channel, product, state and city; fees, TCS, TDS and transfers into payouts. A row it cannot read is listed, never guessed.",
      },
    ],
    desk: [{ title: '"Read <file> as <platform> sales"', text: "Always waits for you. Choose the date, order, quantity and amount columns.", from: 2 }],
    next: [
      { title: "Read it this way", text: "The file is read, and every file in that layout after it, without asking" },
      { kind: "stop", title: "Reject", text: "The file is not read" },
      {
        title: "Online sales and payouts",
        text: "In the Boardroom; each morning, the last day's sales and any product whose returns are climbing go in the digest",
        from: "do3",
      },
    ],
    notYet: ["posting online sales to the books with GST", "matching payouts to the bank"],
  }),
  agent({
    id: "account-manager",
    alt: "The Account Manager: learns each customer's ordering rhythm from their invoices and shows who is due or late to reorder",
    status: "reports",
    starts: [{ title: "Your posted invoices", text: "Customers with at least 3 orders on different days" }],
    does: [
      { title: "1. Learns the rhythm", text: "The usual gap between each customer's orders" },
      { title: "2. Due or late?", text: "Due once the usual gap has passed; late at 1.4 times it" },
    ],
    desk: [],
    next: [{ title: "Boardroom → Reorders", text: "Who is due and late, and the latest in the sales report" }],
    notYet: ["drafting reorder nudges", "spotting customers who are buying less"],
  }),

  // ── Marketing ──
  agent({
    id: "marketer",
    alt: "The Marketer: shows slow-moving stock, your campaigns and the festival dates ahead",
    status: "reports",
    starts: [{ title: "Your stock and sales", text: "Each product's stock against its last 60 days of sales" }],
    does: [
      { title: "1. Finds slow stock", text: "Products with more than 120 days of stock at the recent rate" },
      { title: "2. Lists campaigns and dates", text: "Your campaigns, and festivals and sale dates ahead" },
    ],
    desk: [],
    noDesk: "Nothing in the real flow; the demo shows a sample card.",
    next: [
      { title: "Boardroom tabs", text: "Campaigns, Slow stock, Dates ahead" },
      { title: "Social media", text: "Slow stock and campaigns become post topics in the monthly calendar" },
    ],
    notYet: ["drafting campaigns", "working out the sales each campaign brought"],
  }),
  agent({
    id: "market-watcher",
    alt: "The Market Watcher: compares your prices with competitor prices held in the office",
    status: "reports",
    starts: [{ title: "Competitor prices", text: "Held in the office's books" }],
    does: [{ title: "1. Compares each product", text: "Your price against the market's, as a percentage" }],
    desk: [],
    next: [{ title: "Boardroom → Market prices", text: "Products priced more than 5% above the market are marked" }],
    notYet: ["collecting competitor prices", "an alert when you are priced out"],
  }),

  // ── Social media ──
  agent({
    id: "social-messages",
    alt: "The Social Media Manager, messages and reviews: sorts each comment, review and message, passes enquiries to sales, and drafts a reply for your Desk",
    status: "works",
    starts: [
      { title: "Instagram, Facebook, Threads", text: "Comments, reviews and messages, as they arrive" },
      { ...MORNING, text: "Fetches anything missed" },
    ],
    does: [
      { title: "1. Sorts it", text: "Spam, complaint, enquiry, question or praise" },
      { title: "Spam?", branch: true, text: "Kept, and nothing else happens" },
      { title: "2. An enquiry becomes a lead", text: "For the Sales Rep's pipeline" },
      { title: "3. Drafts a reply", text: "In your brand's voice; any price is checked against your books" },
    ],
    desk: [
      {
        title: '"Reply to <author>\'s review / comment / message on <platform>"',
        text: "Trusted: only thank-yous to 4 and 5 star reviews with no figures or promises go alone.",
      },
    ],
    next: [
      { title: "Approve", text: "Posted through the platform if connected; otherwise ready to paste" },
      { kind: "stop", title: "Reject", text: "No reply" },
    ],
    notYet: ["an alert when the review rating drops"],
  }),
  agent({
    id: "social-posts",
    alt: "The Social Media Manager, calendar and posts: drafts next month's calendar, puts each post on your Desk, and checks it again before it goes out",
    status: "works",
    starts: [
      { ...MORNING, text: "From the 25th, if next month has no calendar" },
      { title: "Draft a calendar", text: "The button in its room, any time" },
    ],
    does: [
      {
        title: "1. Plans the month",
        text: "Festival posts first, then your content themes, weighted to what did best last month, with slow stock and campaigns as topics",
      },
      { title: "2. Each post on your Desk", text: "Once the calendar is approved, in each channel's version" },
      { title: "3. Checks again at posting time", text: "Prices and facts against the books, and that the text is what you approved" },
      { title: "Changed or a check fails?", branch: true, text: "Held back and returned to your Desk" },
    ],
    desk: [
      { title: '"Approve the <month> calendar: N posts"', text: "Always waits for you", from: 0 },
      { title: '"Publish <topic> on <channels>, <date>"', text: "Trusted: an unchanged post from your calendar that passes every check goes alone", from: 1 },
      { title: '"Send <topic> on WhatsApp to N customers"', text: "A broadcast: always waits, with its cost", from: 1 },
    ],
    next: [
      { title: "Calendar approved", text: "Its posts come to the Desk one by one", from: 0 },
      { title: "Post approved", text: "Scheduled; at its time published if the channel is connected, otherwise a pack to post by hand", from: 1 },
      { kind: "stop", title: "Reject", text: "A rejected calendar removes its draft posts", from: 0 },
    ],
  }),

  // ── Operations ──
  agent({
    id: "storekeeper",
    alt: "The Storekeeper: each morning finds items at or under their reorder level and drafts one purchase order per supplier",
    status: "works",
    starts: [MORNING, { title: "Run now", text: "In its room" }],
    does: [
      { title: "1. What is low", text: "Items with stock at or under their reorder level" },
      { title: "Already ordered, or never bought?", branch: true, text: "Left out: an open order exists, or no bill shows who supplies it" },
      { title: "2. How much", text: "Enough to reach the reorder level after the last 30 days' sales, at the rate on the last bill" },
      { title: "3. One order per supplier", text: "Grouped from the items' last bills" },
    ],
    desk: [{ title: '"Reorder from <supplier>, ₹<total>"', text: "Trusted: under ₹1 lakh goes ahead at the next morning round. Autonomous: any amount." }],
    next: [
      { title: "Approve", text: "Marked as sent in the books" },
      { kind: "stop", title: "Reject", text: "Cancelled, not sent; drafted again from the next day if still low" },
      { title: "The digest", text: "How many items are low and how many orders were drafted", from: "do3" },
    ],
    notYet: [
      "emailing the order to the supplier",
      "setting reorder levels from sales",
      "stock changing with sales and bills (it comes from your products file)",
    ],
  }),
  agent({
    id: "buyer",
    alt: "The Buyer: compares vendor quotes held in the office and recommends one on price, lead time and credit",
    status: "reports",
    starts: [{ title: "Vendor quotes", text: "Held in the office's books" }],
    does: [{ title: "1. Scores each quote", text: "Price, lead time and credit days together; the lowest score is recommended" }],
    desk: [],
    next: [{ title: "Its room", text: "Open requests for quotes, and the recommended supplier" }],
    notYet: ["collecting quotes from suppliers"],
  }),
  agent({
    id: "compliance-officer",
    alt: "The Compliance Officer: keeps the company's filing calendar from its profile, reminds whoever files each item, and proposes actions from the books",
    status: "works",
    starts: [
      { title: "Your company's profile", text: "Type, registrations, directors, events" },
      { title: "Filing proofs", text: "Uploaded, with the SRN" },
      MORNING,
    ],
    does: [
      { title: "1. Builds the calendar", text: "GST, TDS, PF and ESI, ROC and income tax dates for this company" },
      { title: "2. Reminds", text: "7 days and 2 days before, on the day, then weekly while late, naming who files: you, or your CA or CS" },
      { title: "3. Checks the books", text: "MSME suppliers to be paid within 45 days; advance tax to set aside" },
    ],
    desk: [{ title: '"Pay MSME suppliers first" / "Set aside advance tax"', text: "Always waits for you; comes back next month if rejected" }],
    next: [
      { title: "Approve", text: "The cash plan pays micro and small suppliers by their legal limit, or sets the advance tax aside for its date" },
      { title: "Working papers", text: "The filing pack to download; mark filed, assign or snooze", from: "do1" },
      { title: "The digest", text: "What is due and who files it", from: "do1" },
    ],
    notYet: ["Desk cards for ROC events"],
  }),

  // ── People ──
  agent({
    id: "payroll-clerk",
    alt: "The Payroll Clerk: works out pay, PF, ESI and professional tax from attendance held in the office",
    status: "reports",
    starts: [{ title: "Employees and attendance", text: "Held in the office's books" }],
    does: [{ title: "1. Works out pay", text: "Gross pay, PF, ESI and professional tax by state slab" }],
    desk: [],
    next: [
      { title: "Its room", text: "The month's payroll summary" },
      { title: "Compliance", text: "PF and ESI amounts in the filing calendar" },
    ],
    notYet: ["entering attendance", "a payroll run for you to approve", "payslips"],
  }),
];

/** Writes every diagram, removing ones no longer described. Returns how many were written. */
export function writeFlows() {
  mkdirSync(OUT, { recursive: true });
  const ids = new Set(FLOWS.map((f) => `flow-${f.id}.svg`));
  for (const f of readdirSync(OUT)) if (f.startsWith("flow-") && !ids.has(f)) rmSync(join(OUT, f));
  for (const f of FLOWS) writeFileSync(join(OUT, `flow-${f.id}.svg`), draw(f));
  return FLOWS.length;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`Wrote ${writeFlows()} diagrams to docs/reference/diagrams`);
