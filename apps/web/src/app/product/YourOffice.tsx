import type { RoomStatus } from "@office/contracts";
import { FloorPlan } from "@office/ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { appUrl } from "../site";
import { Seal } from "./Seal";

const asText = (_id: string, className: string, children: ReactNode) => <span className={className}>{children}</span>;
const asHiring = (className: string, children: ReactNode) => <span className={className}>{children}</span>;

const trainee = (agentId: string, now: string): RoomStatus => ({ agentId, hired: true, trustLevel: "trainee", status: "idle", now, todayCount: 0, waitingCount: 0 });

/** "Sharma Hardware's office", "Sharma Traders' office". */
const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Act three: the visitor's own business, drawn as the office they would open. Nothing typed here leaves the page. */
export function YourOffice() {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [compact, setCompact] = useState(false);
  const [seen, setSeen] = useState(false);
  const [sealed, setSealed] = useState({ key: 0, name: "" });
  const reseal = () => {
    if (name.trim() !== sealed.name) setSealed({ key: sealed.key + 1, name: name.trim() });
  };
  const floor = useRef<HTMLDivElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const shownName = name.trim() || "Sharma Hardware";
  const shownCity = city.trim() || "Indore";

  useLayoutEffect(() => {
    const el = floor.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCompact(e!.contentRect.width < 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = block.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e!.isIntersecting) {
        setSeen(true);
        io.disconnect();
      }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const rooms = [
    trainee("office-manager", `Front desk of ${shownName}, ${shownCity}`),
    trainee("accountant", "Ready for your first bill"),
    trainee("credit-controller", "Ready to age what customers owe"),
    ...(compact ? [] : [trainee("tax-clerk", "Ready for this month's GST"), trainee("auditor", "Ready to check what was filed")]),
  ];
  const href = appUrl(name.trim() ? `/?open=1&name=${encodeURIComponent(name.trim())}` : "/?open=1");
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  return (
    <section className="yours" aria-labelledby="yours-title">
      <div className="yours-intro">
        <h2 id="yours-title">Put your name on the door</h2>
        <p>This is the office you would open today: a front desk and the accounts team, each starting as a trainee. Nothing you type here leaves this page.</p>
        <form className="yours-form" onSubmit={(e) => e.preventDefault()}>
          <div className="field">
            <label htmlFor="yours-name">Business name</label>
            <input id="yours-name" className="input" maxLength={60} placeholder="Sharma Hardware" value={name} onChange={(e) => setName(e.target.value)} onBlur={reseal} autoComplete="organization" />
          </div>
          <div className="field">
            <label htmlFor="yours-city">City</label>
            <input id="yours-city" className="input" maxLength={40} placeholder="Indore" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
          </div>
        </form>
      </div>
      <div className="yours-drawing">
        <div ref={floor} className="yours-floor">
          <FloorPlan rooms={rooms} layout={compact ? "narrow" : "wide"} renderLink={asText} renderHiringLink={asHiring} />
        </div>
        <div ref={block} className="yours-block">
          <dl>
            <div>
              <dt>Client</dt>
              <dd className="yours-block-name">{shownName}</dd>
            </div>
            <div>
              <dt>Site</dt>
              <dd>{shownCity}</dd>
            </div>
            <div>
              <dt>Drawing</dt>
              <dd>Ground floor, front desk and accounts wing</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{today}</dd>
            </div>
          </dl>
          {seen ? <Seal variant="full" press pressKey={sealed.key} className="yours-seal" /> : <span className="yours-seal" />}
        </div>
      </div>
      <div className="yours-cta">
        <a className="btn btn-primary btn-large" href={href}>
          Open {name.trim() ? possessive(name.trim()) : "your"} office
        </a>
        <p>Bring your parties, products and open invoices from a spreadsheet. Invite your accountant when you are ready.</p>
      </div>
    </section>
  );
}
