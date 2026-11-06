import type { RoomStatus } from "@office/contracts";
import { FloorPlan, type Plan } from "@office/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Seal } from "./Seal";
import { useReducedMotion, useScrollProgress } from "./useScrollProgress";

const STEPS: { title: string; body: string }[] = [
  { title: "Send it your paperwork", body: "Forward a bill by email, upload it, or send a photo on WhatsApp. It arrives at Reception." },
  { title: "The Accountant reads it", body: "She reads every line, works out the GST and checks that the total adds up." },
  { title: "It waits on your desk", body: "The entry sits on your desk with the bill beside it. Nothing has touched the books yet." },
  { title: "You approve it", body: "Approve, edit or reject. Your approval is the only way into the books." },
  { title: "It is in the books", body: "The bill is posted and shows in the Boardroom, still one click from the photo it came from." },
];

const BILL = [
  { item: "FR cable 2.5 sq mm, 90 m", amount: "62,400" },
  { item: "FR cable 4 sq mm, 90 m", amount: "37,600" },
  { item: "IGST 18%", amount: "18,000" },
];

const room = (agentId: string, status: RoomStatus["status"], now: string, todayCount: number, waitingCount = 0): RoomStatus => ({
  agentId,
  hired: true,
  trustLevel: "trainee",
  status,
  now,
  todayCount,
  waitingCount,
});

function roomsAt(step: number, approved: boolean, compact: boolean): RoomStatus[] {
  const accountant =
    approved
      ? room("accountant", "idle", "Posted BC/2026/0412 to the books", 5)
      : step === 1
        ? room("accountant", "working", "Reading BC/2026/0412 from Bharat Cables", 4)
        : step >= 2
          ? room("accountant", "waiting", "Staged the bill for your approval", 5, 1)
          : room("accountant", "idle", "Matched 6 bank receipts", 4);
  const rooms = [
    room("office-manager", step === 0 ? "working" : "idle", step === 0 ? "A photo arrived on WhatsApp" : "Sent the Bharat Cables bill to the Accountant", 3),
    accountant,
    room("credit-controller", "idle", "Drafted reminders for the six oldest", 6),
  ];
  if (compact) return rooms;
  return [...rooms, room("tax-clerk", "idle", "October GSTR-1 is ready", 1), room("auditor", "idle", "Compared GSTR-2B with the books", 2), room("social-media-manager", "idle", "Drafted the Diwali post", 3)];
}

const asText = (_id: string, className: string, children: ReactNode) => <span className={className}>{children}</span>;
const asHiring = (className: string, children: ReactNode) => <span className={className}>{children}</span>;

type Pt = { x: number; y: number };
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** A point along a path of straight runs, by share of its whole length. */
function along(points: Pt[], t: number): Pt {
  const lens = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let d = Math.min(1, Math.max(0, t)) * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]! || i === lens.length - 1) return lerp(points[i]!, points[i + 1]!, lens[i] ? Math.min(1, d / lens[i]!) : 1);
    d -= lens[i]!;
  }
  return points[points.length - 1]!;
}

function routeTo(plan: Plan, agentId: string): Pt[] | null {
  const r = plan.rooms.find((x) => x.agentId === agentId);
  if (!r) return null;
  const c = plan.corridor;
  const d = r.door.size / 2;
  if (!plan.narrow) {
    const y = c.y + c.h / 2;
    return [{ x: plan.entrance.x - 70, y }, { x: plan.entrance.x + 30, y }, { x: r.door.x + d, y }, { x: r.door.x + d, y: r.door.y - 26 }];
  }
  const x = c.x + c.w / 2;
  return [{ x: plan.entrance.x + 20, y: plan.entrance.y - 70 }, { x: plan.entrance.x + 20, y: plan.entrance.y + 40 }, { x, y: c.y + 14 }, { x, y: r.door.y + d }, { x: r.door.x - 26, y: r.door.y + d }];
}

/** Act two: one bill from a WhatsApp photo to the Boardroom, on the same floor plan the owner works on. */
export function BillWalk() {
  const reduced = useReducedMotion();
  const section = useRef<HTMLElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const bill = useRef<SVGGElement>(null);
  const planRef = useRef<Plan | null>(null);
  const [compact, setCompact] = useState(false);
  const [approved, setApproved] = useState(false);
  const [pressKey, setPressKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = floor.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCompact(e!.contentRect.width < 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame = useCallback((p: number) => {
    const g = bill.current;
    const plan = planRef.current;
    if (!g || !plan) return;
    const route = routeTo(plan, "accountant");
    if (!route) return;
    const s = p * STEPS.length;
    const arrive = Math.min(1, s / 0.8);
    const walk = Math.min(1, Math.max(0, (s - 1) / 0.85));
    const pos = s < 1 ? lerp(route[0]!, route[1]!, 1 - (1 - arrive) ** 3) : along(route.slice(1), walk);
    g.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
    g.style.opacity = s < 1.9 ? String(Math.min(1, arrive * 2)) : String(Math.max(0, 1 - (s - 1.9) * 6));
  }, []);

  const step = useScrollProgress(section, STEPS.length, frame, !reduced);
  const shown = reduced ? 3 : step;

  const approve = () => {
    if (approved) return;
    setApproved(true);
    setPressKey((k) => k + 1);
  };
  useEffect(() => {
    if (!reduced && step >= 4) approve();
  });

  const today = new Date();
  const desk = (
    <div className={`walk-desk${approved ? " is-approved" : ""}`} key={`desk-${pressKey}`}>
      <p className="walk-desk-from">The Accountant, for your approval</p>
      <p className="walk-desk-action">Post bill BC/2026/0412 from Bharat Cables Pvt Ltd, ₹1,18,000, due 13 November</p>
      <div className="walk-desk-evidence">
        <table>
          <tbody>
            {BILL.map((b) => (
              <tr key={b.item}>
                <td>{b.item}</td>
                <td className="num">{b.amount}</td>
              </tr>
            ))}
            <tr className="walk-desk-total">
              <th scope="row">Total</th>
              <td className="num">1,18,000</td>
            </tr>
          </tbody>
        </table>
        <BillPhoto />
      </div>
      {approved ? (
        <p className="walk-desk-done" role="status">
          Approved. Posted to the books.
        </p>
      ) : (
        <div className="walk-desk-actions">
          <button type="button" className="btn btn-approve" onClick={approve}>
            Approve
          </button>
          <button type="button" className="btn" onClick={() => setNote("In your office, Edit opens the entry with the bill beside it.")}>
            Edit
          </button>
          <button type="button" className="btn" onClick={() => setNote("In your office, Reject sends it back to the Accountant with your reason.")}>
            Reject
          </button>
        </div>
      )}
      {note && !approved ? <p className="walk-desk-note">{note}</p> : null}
      {approved ? <Seal variant="approved" date={today} press={!reduced} pressKey={pressKey} className="walk-desk-seal" /> : null}
    </div>
  );

  const panels: ReactNode[] = [
    <div className="walk-chat" key="chat">
      <p className="walk-chat-head">Kaveri Electricals office</p>
      <div className="walk-chat-msg is-mine">
        <BillPhoto />
        <p>Bharat Cables bill. Cable for the Kale site.</p>
        <span className="walk-chat-time">10:41</span>
      </div>
      <div className="walk-chat-msg">
        <p>Got it. The Accountant is reading it now.</p>
        <span className="walk-chat-time">10:41</span>
      </div>
    </div>,
    <div className="walk-read" key="read">
      <p className="walk-desk-from">The Accountant is reading BC/2026/0412</p>
      <dl>
        <div>
          <dt>Supplier</dt>
          <dd>Bharat Cables Pvt Ltd, Vapi</dd>
        </div>
        <div>
          <dt>Invoice</dt>
          <dd>BC/2026/0412, 14 October</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>2 cable lines, 1,00,000 before tax</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>IGST 18%, 18,000, because the supplier is in Gujarat</dd>
        </div>
        <div>
          <dt>Check</dt>
          <dd>Lines plus tax equal the printed total, 1,18,000</dd>
        </div>
      </dl>
    </div>,
    desk,
    desk,
    <div className="walk-board" key="board">
      <p className="walk-desk-from">Boardroom, accounts: what you owe suppliers</p>
      <table>
        <thead>
          <tr>
            <th scope="col">Supplier</th>
            <th scope="col">Due</th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="is-new">
            <td>Bharat Cables Pvt Ltd</td>
            <td>13 Nov</td>
            <td className="num">
              <span className="walk-link">1,18,000</span>
            </td>
          </tr>
          <tr>
            <td>Narmada Switchgear Ltd</td>
            <td>21 Nov</td>
            <td className="num">12,65,285</td>
          </tr>
          <tr>
            <td>Sahyadri Cables Pvt Ltd</td>
            <td>28 Nov</td>
            <td className="num">3,41,920</td>
          </tr>
        </tbody>
      </table>
      <p className="walk-log">
        <span>10:44</span> You approved: post bill BC/2026/0412 from Bharat Cables Pvt Ltd.
      </p>
      <Seal variant="approved" date={today} className="walk-board-seal" />
    </div>,
  ];

  return (
    <section ref={section} className={`walk${reduced ? " is-static" : ""}`} aria-labelledby="walk-title">
      <div className="walk-stage">
        <div className="walk-copy">
          <h2 id="walk-title">Follow one bill through your office</h2>
          <ol className="walk-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i === shown ? "is-now" : i < shown ? "is-done" : undefined} aria-current={i === shown ? "step" : undefined}>
                <span className="walk-step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="walk-visual">
          <div ref={floor} className="walk-floor">
            <FloorPlan
              rooms={roomsAt(shown, approved, compact)}
              layout={compact ? "narrow" : "wide"}
              renderLink={asText}
              renderHiringLink={asHiring}
              overlay={(plan) => {
                planRef.current = plan;
                return (
                  <g ref={bill} className="walk-bill" style={{ opacity: 0 }}>
                    <path d="M -14 -18 h 20 l 9 9 v 27 h -29 z M 6 -18 v 9 h 9" />
                    <line x1="-9" y1="-2" x2="9" y2="-2" />
                    <line x1="-9" y1="4" x2="9" y2="4" />
                    <line x1="-9" y1="10" x2="3" y2="10" />
                  </g>
                );
              }}
            />
          </div>
          <div className="walk-tray">{reduced ? <>{panels[0]}{panels[1]}{desk}{approved ? panels[4] : null}</> : <div className="walk-panel" key={shown === 3 ? 2 : shown}>{panels[shown]}</div>}</div>
        </div>
      </div>
    </section>
  );
}

/** The phone photo of the bill: slightly skewed, with the total line marked. */
function BillPhoto() {
  return (
    <span className="bill-photo" aria-hidden="true">
      <span className="bill-photo-head" />
      <span />
      <span />
      <span className="is-short" />
      <span className="bill-photo-total" />
    </span>
  );
}
