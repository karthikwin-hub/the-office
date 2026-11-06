import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { AS_OF, FOCUS_CUSTOMER, FOCUS_INVOICE, INVOICE_0214 as INV, inr, OVERDUE, OVERDUE_TOTAL, SAHYOG_INVOICES } from "./kaveri";
import { Seal } from "./Seal";
import { useReducedMotion, useScrollProgress } from "./useScrollProgress";

/** Each level is this many times larger than the one inside it. */
const F = 4.2;
const DEPTH = ["₹59.9 lakh overdue", "15 customers", "4 invoices", "1 invoice", "The paper"];

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Slow at each whole level, so the reader rests on every sheet. */
const dwell = (z: number) => {
  const i = Math.floor(z);
  const f = z - i;
  return i + (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);
};

/**
 * The hero, after the Eames film: scrolling zooms into one overdue figure until it is the paper it was added up
 * from. Every level is a real sheet from the sample books, and each opens at the line the one before pointed to.
 */
export function ZoomHero({ openHref, demoHref }: { openHref: string; demoHref: string }) {
  const reduced = useReducedMotion();
  const section = useRef<HTMLElement>(null);
  const layers = useRef<(HTMLDivElement | null)[]>([]);
  const pitch = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLParagraphElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const gaugeItems = useRef<(HTMLLIElement | null)[]>([]);
  const outro = useRef<HTMLDivElement>(null);
  const focus = useRef<{ x: number; y: number }[]>([]);

  const measure = useCallback(() => {
    focus.current = layers.current.map((layer) => {
      const el = layer?.querySelector<HTMLElement>("[data-focus]");
      if (!layer || !el) return { x: 0, y: 0 };
      let x = el.offsetWidth / 2, y = el.offsetHeight / 2;
      for (let n: HTMLElement | null = el; n && n !== layer; n = n.offsetParent as HTMLElement | null) {
        x += n.offsetLeft;
        y += n.offsetTop;
      }
      return { x: x - layer.offsetWidth / 2, y: y - layer.offsetHeight / 2 };
    });
  }, []);

  useLayoutEffect(() => {
    if (reduced) return;
    measure();
    const ro = new ResizeObserver(measure);
    if (section.current) ro.observe(section.current);
    return () => ro.disconnect();
  }, [measure, reduced]);

  const frame = useCallback((p: number) => {
    const zoom = dwell(clamp((p - 0.04) / 0.68) * 4);
    const out = smooth(0.84, 0.98, p);
    layers.current.forEach((el, i) => {
      if (!el) return;
      const t = zoom - i;
      const last = i === DEPTH.length - 1;
      let opacity = i === 0 ? 1 : smooth(-0.55, -0.15, t);
      if (!last) opacity *= 1 - smooth(0.3, 0.7, t);
      let scale = F ** t;
      const f = focus.current[i] ?? { x: 0, y: 0 };
      const e = t > 0 ? smooth(0, 0.5, t) : 0;
      let x = -f.x * scale * e, y = -f.y * scale * e;
      if (last) {
        scale *= 1 - 0.82 * out;
        x = 0;
        y = -out * 40;
        opacity *= 1 - smooth(0.5, 1, out);
      }
      el.style.opacity = opacity.toFixed(3);
      el.style.visibility = opacity < 0.01 ? "hidden" : "visible";
      el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(4)})`;
      el.classList.toggle("is-current", Math.round(zoom) === i);
    });
    if (pitch.current) {
      const o = 1 - smooth(0, 0.22, zoom);
      pitch.current.style.opacity = o.toFixed(3);
      pitch.current.style.visibility = o < 0.01 ? "hidden" : "visible";
    }
    if (hint.current) hint.current.style.opacity = (1 - smooth(0, 0.08, zoom)).toFixed(3);
    if (marker.current) marker.current.style.top = `${((zoom / 4) * 100).toFixed(2)}%`;
    gaugeItems.current.forEach((li, i) => li?.classList.toggle("is-here", Math.round(zoom) === i && out < 0.5));
    if (outro.current) {
      const o = smooth(0.35, 0.9, out);
      outro.current.style.opacity = o.toFixed(3);
      outro.current.style.visibility = o < 0.01 ? "hidden" : "visible";
      outro.current.style.transform = `translate(-50%, calc(-50% + ${((1 - o) * 24).toFixed(1)}px))`;
    }
  }, []);

  useScrollProgress(section, 1, frame, !reduced);

  /** Clicking the figure does what clicking any figure in the office does: it opens the paper behind it. */
  const openPaper = () => {
    const el = section.current;
    if (!el) return;
    if (reduced) {
      el.querySelector(".paper")?.scrollIntoView({ block: "center" });
      return;
    }
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + (el.offsetHeight - window.innerHeight) * 0.76, behavior: "smooth" });
  };

  const layer = (i: number, children: ReactNode, className = "") => (
    <div
      ref={(el) => {
        layers.current[i] = el;
      }}
      className={`zoom-layer ${className}`}
    >
      {children}
    </div>
  );

  return (
    <section ref={section} className={`zoom${reduced ? " is-static" : ""}`} aria-labelledby="zoom-title">
      <div className="zoom-stage">
        {layer(
          0,
          <>
            <div ref={pitch} className="zoom-pitch">
              <h1 id="zoom-title">Every rupee in your books opens down to the paper it came from.</h1>
              <p className="zoom-lede">A team of AI agents keeps the books, chases payments and prepares your GST and TDS returns. You see every step, and nothing reaches the books until you approve it.</p>
              <div className="zoom-actions">
                <a className="btn btn-primary" href={openHref}>
                  Open your office
                </a>
                <a className="btn btn-ghost" href={demoHref}>
                  Try the demo
                </a>
              </div>
            </div>
            <article className="zoom-sheet zoom-note">
              <span className="zoom-under" aria-hidden="true" />
              <span className="zoom-under" aria-hidden="true" />
              <p className="zoom-note-from">From your Credit Controller, {AS_OF}</p>
              <p className="zoom-note-body">
                Kaveri Electricals is owed{" "}
                <button type="button" className="zoom-figure" data-focus onClick={openPaper} aria-label="₹59.9 lakh: show the paper it comes from">
                  ₹59.9 lakh
                </button>{" "}
                that is past its due date, from 15 customers. I have drafted reminders for the six oldest.
              </p>
            </article>
          </>,
          "zoom-layer-note",
        )}

        {layer(
          1,
          <article className="zoom-sheet">
            <h2 className="zoom-sheet-title">Overdue, by customer</h2>
            <table className="zoom-table">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">
                    Oldest
                  </th>
                  <th scope="col" className="num">
                    Overdue
                  </th>
                </tr>
              </thead>
              <tbody>
                {OVERDUE.map((c) => (
                  <tr key={c.name} className={c.name === FOCUS_CUSTOMER ? "zoom-hit" : undefined} data-focus={c.name === FOCUS_CUSTOMER ? "" : undefined}>
                    <td>{c.name}</td>
                    <td className="num">{c.oldestDays} days</td>
                    <td className="num">{inr(c.rupees)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    15 customers
                  </th>
                  <td className="num">{inr(OVERDUE_TOTAL)}</td>
                </tr>
              </tfoot>
            </table>
          </article>,
        )}

        {layer(
          2,
          <article className="zoom-sheet">
            <h2 className="zoom-sheet-title">Sahyog Infratech Ltd, Pune</h2>
            <p className="zoom-sheet-sub">45 days' credit. Four invoices past due.</p>
            <table className="zoom-table">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Dated</th>
                  <th scope="col" className="num">
                    Late by
                  </th>
                  <th scope="col" className="num">
                    Still due
                  </th>
                </tr>
              </thead>
              <tbody>
                {SAHYOG_INVOICES.map((v) => (
                  <tr key={v.number} className={v.number === FOCUS_INVOICE ? "zoom-hit" : undefined} data-focus={v.number === FOCUS_INVOICE ? "" : undefined}>
                    <td>{v.number}</td>
                    <td>{v.date}</td>
                    <td className="num">
                      {v.daysLate} {v.daysLate === 1 ? "day" : "days"}
                    </td>
                    <td className="num">{inr(v.rupees)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>
                    Sahyog Infratech Ltd
                  </th>
                  <td className="num">4,60,790</td>
                </tr>
              </tfoot>
            </table>
          </article>,
        )}

        {layer(
          3,
          <article className="zoom-sheet zoom-entry">
            <div>
              <h2 className="zoom-sheet-title">Invoice {INV.number}</h2>
              <p className="zoom-sheet-sub">Sahyog Infratech Ltd, 7 September, due 22 October</p>
              <table className="zoom-table">
                <tbody>
                  {INV.lines.map((l) => (
                    <tr key={l.item}>
                      <td>{l.item}</td>
                      <td className="num">{l.taxable}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>CGST and SGST at 9% each</td>
                    <td className="num">34,137.82</td>
                  </tr>
                  <tr className="zoom-rule">
                    <td>Invoice total</td>
                    <td className="num">2,23,792</td>
                  </tr>
                  <tr>
                    <td>Received {INV.receivedOn}</td>
                    <td className="num">−{INV.received}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Still due</th>
                    <td className="num">{INV.balance}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <figure className="zoom-source" data-focus>
              <span className="zoom-source-thumb" aria-hidden="true">
                <span />
                <span />
                <span />
                <span className="is-hit" />
              </span>
              <figcaption>The signed copy, page 1</figcaption>
            </figure>
          </article>,
        )}

        {layer(4, <PaperBill />, "zoom-layer-paper")}

        <div ref={outro} className="zoom-outro">
          <p>That was one figure. Your office has a team working on all of them.</p>
        </div>

        <p ref={hint} className="zoom-hint" aria-hidden="true">
          Scroll to open the figure
        </p>

        <div className="zoom-gauge">
          <span className="zoom-gauge-track" aria-hidden="true">
            <span ref={marker} className="zoom-gauge-marker" />
          </span>
          <ol aria-label="How deep you are">
            {DEPTH.map((d, i) => (
              <li
                key={d}
                ref={(el) => {
                  gaugeItems.current[i] = el;
                }}
              >
                {d}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** The triplicate copy Kaveri kept, signed and stamped by Sahyog's stores when the goods arrived. */
function PaperBill() {
  return (
    <article className="paper" aria-label={`Tax invoice ${INV.number}, the copy signed by the customer`}>
      <header className="paper-head">
        <div>
          <p className="paper-firm">Kaveri Electricals Pvt Ltd</p>
          <p>Plot 14, Bhosari MIDC, Pune 411026</p>
          <p>GSTIN 27AAFCK4821M1Z9</p>
        </div>
        <div className="paper-kind">
          <p className="paper-title">Tax invoice</p>
          <p>Triplicate for supplier</p>
        </div>
      </header>
      <dl className="paper-meta">
        <div>
          <dt>Invoice no.</dt>
          <dd>{INV.number}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{INV.date}</dd>
        </div>
        <div>
          <dt>Terms</dt>
          <dd>45 days</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{INV.due}</dd>
        </div>
      </dl>
      <p className="paper-to">
        <span>Bill to</span> Sahyog Infratech Ltd, Pune. GSTIN 27KGWCS6656D1Z4. Place of supply 27 Maharashtra
      </p>
      <table className="paper-lines">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">HSN</th>
            <th scope="col" className="num">
              Qty
            </th>
            <th scope="col" className="num">
              Rate
            </th>
            <th scope="col" className="num">
              Taxable
            </th>
          </tr>
        </thead>
        <tbody>
          {INV.lines.map((l) => (
            <tr key={l.item}>
              <td>{l.item}</td>
              <td>{l.hsn}</td>
              <td className="num">{l.qty}</td>
              <td className="num">{l.rate}</td>
              <td className="num">{l.taxable}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="paper-totals">
        <tbody>
          <tr>
            <th scope="row">Taxable value</th>
            <td className="num">{INV.taxable}</td>
          </tr>
          <tr>
            <th scope="row">CGST 9%</th>
            <td className="num">{INV.cgst}</td>
          </tr>
          <tr>
            <th scope="row">SGST 9%</th>
            <td className="num">{INV.sgst}</td>
          </tr>
          <tr>
            <th scope="row">Round off</th>
            <td className="num">{INV.roundOff}</td>
          </tr>
          <tr className="paper-hit">
            <th scope="row">Total</th>
            <td className="num">
              <mark>₹{INV.total}</mark>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="paper-words">{INV.words}</p>
      <footer className="paper-foot">
        <div className="paper-received">
          <Seal variant="approved" ring={["Sahyog Infratech Ltd", "Pune"]} word="Received" sign="Stores" date={new Date(2026, 8, 8)} className="paper-stamp" label="Received by Sahyog Infratech Ltd stores, 8 Sep 2026" />
          <svg className="paper-signature" viewBox="0 0 120 40" aria-hidden="true">
            <path d="M4 28c6-14 10-20 13-18s-4 18 0 18 8-16 12-16-2 14 3 14 7-10 11-10 0 8 4 8 9-9 14-9 3 6 8 6c6 0 10-6 16-6s10 3 30 1" />
          </svg>
        </div>
        <p className="paper-for">
          For Kaveri Electricals Pvt Ltd
          <span>Authorised signatory</span>
        </p>
      </footer>
    </article>
  );
}
