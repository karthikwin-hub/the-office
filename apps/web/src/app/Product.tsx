import "@fontsource-variable/anek-latin/wdth.css";
import "@fontsource-variable/anek-devanagari/wdth.css";
import { BRAND, LEGAL_PAGES, PROMOTION_RULES, TRUST_LEVELS, WA_LANGUAGE_NAMES } from "@office/contracts";
import "./product.css";
import { BillWalk } from "./product/BillWalk";
import { Seal } from "./product/Seal";
import { YourOffice } from "./product/YourOffice";
import { ZoomHero } from "./product/ZoomHero";
import { appUrl, demoUrl, hasAppDomain } from "./site";

const TEAM: { role: string; does: string }[] = [
  { role: "Accountant", does: "Reads the bills and invoices you email, upload or send on WhatsApp, and stages each entry against the document it came from." },
  { role: "Credit controller", does: "Ages what customers owe and drafts reminders that move from polite to firm to final." },
  { role: "Tax clerk", does: "Works out GST and TDS from the books and prepares GSTR-1, GSTR-3B and the quarterly TDS return for your accountant." },
  { role: "Auditor", does: "Compares what was filed with the books and explains each difference in plain words." },
  { role: "Social media manager", does: "Plans posts around your stock and the festival calendar, and publishes only what you approve." },
  { role: "Customer service", does: "Answers customers on your website and by email from your price list and their own invoices." },
];

const EARNED: Record<string, string> = {
  trainee: "Every new hire starts here.",
  trusted: `Earned after ${PROMOTION_RULES.trusted.minChecked} checked pieces of work at ${PROMOTION_RULES.trusted.minAccuracy * 100}% accuracy.`,
  autonomous: `Earned after ${PROMOTION_RULES.autonomous.minChecked} at ${PROMOTION_RULES.autonomous.minAccuracy * 100}%.`,
};

/** Each language in its own script; the English name is the label for screen readers. */
const LANGUAGES = Object.values(WA_LANGUAGE_NAMES).map((n) => {
  const m = /^(.*) \((.*)\)$/.exec(n);
  return m ? { own: m[1]!, name: m[2]! } : { own: n, name: n };
});

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
  const open = appUrl("/?open=1");
  return (
    <div className="product">
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <header className="product-bar">
        <p className="product-brand">
          <Seal variant="full" press className="product-brand-seal" />
          <span className="product-brand-name">{BRAND.name}</span>
          <span className="product-brand-by">by {BRAND.maker}</span>
        </p>
        <nav aria-label="Account">
          <a href={demo}>Try the demo</a>
          <a className="btn" href={appUrl("/")}>
            Sign in
          </a>
        </nav>
      </header>

      <main id="main">
        <ZoomHero openHref={open} demoHref={demo} />
        <BillWalk />

        <section className="product-section" aria-labelledby="team">
          <h2 id="team">The team you hire</h2>
          <p className="product-note">Hire the roles you need from the hiring hall. Each one comes with a job description, a work log and an accuracy record.</p>
          <dl className="product-rooms">
            {TEAM.map((t) => (
              <div key={t.role}>
                <dt>{t.role}</dt>
                <dd>{t.does}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="product-section" aria-labelledby="trust">
          <h2 id="trust">Trust is earned, one step at a time</h2>
          <p className="product-note">You decide how much each agent may do without asking. Its record shows when it is ready for more.</p>
          <ol className="product-trust">
            {TRUST_LEVELS.map((t) => (
              <li key={t.id}>
                <h3>{t.name}</h3>
                <p>{t.meaning}</p>
                <p className="product-trust-earned">{EARNED[t.id]}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="product-section product-pair" aria-label="Your accountant and WhatsApp">
          <div>
            <h2>Your accountant stays</h2>
            <p>Invite them to the office. They read everything, download returns ready to upload and answer the Auditor&apos;s questions. Approvals stay with you.</p>
            <h2>On WhatsApp, in your language</h2>
            <p>Approve the morning&apos;s work and ask what is overdue by text or voice note. Every amount stays exactly as it is in the books.</p>
            <ul className="product-languages" aria-label="Languages on WhatsApp">
              {LANGUAGES.map((l) => (
                <li key={l.name} lang={l.name === "English" ? "en" : undefined} title={l.name}>
                  {l.own}
                </li>
              ))}
            </ul>
          </div>
          <div className="phone" aria-label="A WhatsApp conversation with the office, in Hindi">
            <p className="phone-head">Kaveri Electricals office</p>
            <div className="phone-msg" lang="hi">
              <p>अनिल जी, 3 बिल आपकी मंज़ूरी का इंतज़ार कर रहे हैं। कुल ₹2,84,150।</p>
              <p className="phone-gloss" lang="en">Anil ji, 3 bills are waiting for your approval. ₹2,84,150 in all.</p>
            </div>
            <div className="phone-msg is-mine">
              <span className="phone-voice" aria-hidden="true">
                <span className="phone-play" />
                <svg viewBox="0 0 120 24">
                  <path d="M2 12h2M7 8v8M12 5v14M17 9v6M22 3v18M27 7v10M32 10v4M37 6v12M42 2v20M47 8v8M52 11v2M57 6v12M62 9v6M67 4v16M72 8v8M77 10v4M82 7v10M87 11v2M92 9v6M97 5v14M102 9v6M107 11v2M112 12h2" />
                </svg>
                <span className="phone-voice-time">0:04</span>
              </span>
              <p className="phone-gloss" lang="hi">
                &ldquo;हाँ, तीनों मंज़ूर।&rdquo; <span lang="en">(Yes, approve all three.)</span>
              </p>
            </div>
            <div className="phone-msg" lang="hi">
              <p>तीनों बिल बुक्स में दर्ज हो गए।</p>
              <p className="phone-gloss" lang="en">All three bills are in the books.</p>
            </div>
          </div>
        </section>

        <YourOffice />
      </main>

      <footer className="product-foot">
        <nav aria-label="Legal">
          {LEGAL_PAGES.map((p) => (
            <a key={p} href={appUrl(`/legal/${p}`)}>
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
