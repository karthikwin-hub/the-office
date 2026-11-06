import { BRAND, LEGAL_PAGES } from "@office/contracts";
import "./product.css";
import { consoleUrl, demoUrl, hasAppDomain } from "./site";

const TEAM: { role: string; does: string }[] = [
  { role: "Accountant", does: "Reads the bills and invoices you email, upload or send on WhatsApp, and stages each entry against the document it came from." },
  { role: "Credit Controller", does: "Ages what customers owe and drafts reminders that move from polite to firm to final." },
  { role: "Tax Clerk", does: "Works out GST and TDS from the books and prepares GSTR-1, GSTR-3B and 26Q files for your accountant." },
  { role: "Auditor", does: "Compares what was filed with the books and explains each difference in plain words." },
  { role: "Social Media Manager", does: "Plans posts around your stock and the festival calendar, and publishes only what you approve." },
  { role: "Customer Service", does: "Answers customers on your website and by email from your price list and their own invoices." },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Open your office", body: "Name the business and hire the Accounts team. Bring in your parties, products and open invoices from a spreadsheet." },
  { title: "Send it your paperwork", body: "Forward bills to the office's own email address, upload them, or send a photo on WhatsApp." },
  { title: "Approve on the Desk", body: "Every entry waits on your Desk with its source beside it. Nothing reaches the books until you say so." },
];

const LEGAL_TITLES: Record<(typeof LEGAL_PAGES)[number], string> = {
  terms: "Terms of service",
  privacy: "Privacy notice",
  subprocessors: "Subprocessors",
  "data-processing": "Data processing terms",
  "ai-notice": "AI notice for your customers",
};

/** The bare app domain: what the product is, for someone who has not signed in. */
export function ProductPage() {
  const demo = hasAppDomain() ? demoUrl() : "/";
  return (
    <div className="product">
      <header className="product-bar">
        <p className="signin-plate">
          {BRAND.name} <span className="signin-plate-by">by {BRAND.maker}</span>
        </p>
        <nav aria-label="Account">
          <a href={demo}>Try the demo</a>
          <a className="btn" href={consoleUrl("/")}>
            Sign in
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="product-hero">
          <div className="product-pitch">
            <h1>Your books, kept by a team of AI agents. Nothing changes until you approve.</h1>
            <p className="product-lede">
              For owners of small businesses in India who sign off on figures they cannot check. Every number in your office opens down to the invoice it came from.
            </p>
            <div className="product-actions">
              <a className="btn btn-primary" href={consoleUrl("/?open=1")}>
                Open your office
              </a>
              <a className="btn" href={demo}>
                Try the demo
              </a>
            </div>
          </div>
          <Proof />
        </section>

        <section className="product-section" aria-labelledby="how">
          <h2 id="how">How it works</h2>
          <ol className="product-steps">
            {STEPS.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="product-section" aria-labelledby="team">
          <h2 id="team">The team you hire</h2>
          <p className="product-note">Each starts as a trainee whose every step waits for you. Promote it when its record earns it.</p>
          <dl className="product-team">
            {TEAM.map((t) => (
              <div key={t.role}>
                <dt>{t.role}</dt>
                <dd>{t.does}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="product-section product-split" aria-labelledby="accountant">
          <div>
            <h2 id="accountant">Your accountant stays</h2>
            <p>Invite them to the office. They read everything, download returns ready to upload and answer the Auditor&apos;s questions. Approvals stay with you.</p>
          </div>
          <div>
            <h2>On WhatsApp, in your language</h2>
            <p>Approve the morning&apos;s work and ask how much is overdue by text or voice note, in eight Indian languages. Every amount stays exactly as it is in the books.</p>
          </div>
        </section>
      </main>

      <footer className="product-foot">
        <nav aria-label="Legal">
          {LEGAL_PAGES.map((p) => (
            <a key={p} href={consoleUrl(`/legal/${p}`)}>
              {LEGAL_TITLES[p]}
            </a>
          ))}
        </nav>
        <p>
          Made by {BRAND.maker}. Write to <a href={`mailto:${BRAND.contact}`}>{BRAND.contact}</a>
        </p>
      </footer>
    </div>
  );
}

/** The promise, drawn: a figure on the Boardroom, traced down to the line of the bill it came from. */
function Proof() {
  return (
    <figure className="proof" aria-label="A figure traced to its source document">
      <div className="proof-figure">
        <span>Owed to Bharat Cables</span>
        <strong>₹1,18,000</strong>
        <span className="proof-meta">due 14 November, 31 days</span>
      </div>
      <div className="proof-sheet">
        <p className="proof-doc">
          <strong>Bharat Cables Pvt Ltd</strong>
          <span>Tax invoice BC/2026/0412, 14 October</span>
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">HSN</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>FR cable 2.5 sq mm, 90 m</td>
              <td>8544</td>
              <td className="num">62,400</td>
            </tr>
            <tr>
              <td>FR cable 4 sq mm, 90 m</td>
              <td>8544</td>
              <td className="num">37,600</td>
            </tr>
            <tr>
              <td>IGST 18%</td>
              <td />
              <td className="num">18,000</td>
            </tr>
            <tr className="proof-hit">
              <th scope="row" colSpan={2}>
                Total
              </th>
              <td className="num">1,18,000</td>
            </tr>
          </tbody>
        </table>
        <p className="proof-stamp">Approved by Anil</p>
      </div>
      <figcaption>Every figure opens the document behind it, with the line marked.</figcaption>
    </figure>
  );
}
