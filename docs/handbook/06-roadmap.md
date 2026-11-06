# Roadmap

> **In one paragraph.** Six phases are complete: the design and clickable demo, the Accounts team on a live Worker, the Social Media Manager, the refined Floor, WhatsApp in eight languages, and multi-tenant offices. Alongside go-live readiness, Phase 6b added Routines with a run history and a first version of the Customer Service agent. Go-live readiness itself is mostly configuration (email, domain, legal review of the drafted privacy notice and terms; the secrets are now set) and is what stands between today and the first pilot businesses. After that come a measured pilot, features for accounting firms, deeper teams in the Hiring Hall, and billing. International markets are the final phase and are deliberately not started: they begin only when traction signals appear, with low-cost readiness work folded into the earlier phases.

## Overview

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Design and clickable demo | Done |
| 1 | Accounts team on the live Worker | Done |
| 2 | Social Media Manager | Done |
| 3 | The Floor, refined | Done |
| 4 | WhatsApp in your own language | Done |
| 5 | Multi-tenant offices | Done |
| 6 | Go-live readiness | **Next** |
| 6b | Routines and the Customer Service agent | Done (first version) |
| 7 | Pilot and accuracy | Planned |
| 8 | Accounting firms | Planned |
| 9 | Deeper teams | Planned |
| 10 | Plans and billing | Planned |
| 11 | International markets | Not started, by design |

## Completed

### Phase 0: Design and clickable demo

- The whole office designed and built as working screens on sample data before any backend: the Floor, the Boardroom with a tab per team, the Desk, a room per agent, the Hiring Hall, Settings, the accountant's view, phone layouts.
- One contract (zod schemas) shared by the demo and the real backend; Mock Service Worker answering the real routes; a UI kit with Storybook stories for every state.
- A deterministic synthetic business (Kaveri Electricals): about 300 invoice PDFs, 40 products, 25 customers, purchase bills with TDS.
- Review rounds with screenshot sets at desktop and phone sizes.

### Phase 1: Accounts team on the live Worker

- Cloudflare Worker, an `Office` Durable Object, better-auth on D1, R2 for documents, Workers AI for reading.
- The Accountant reading emailed and uploaded documents (text layer in the browser, vision model for scans), staged with source links and duplicate detection.
- The deterministic GST and TDS engine with unit tests; GSTR-1 JSON and GSTR-3B and TDS Excel exports with real formulas.
- The Credit Controller's ageing and escalating reminders; the Auditor's comparison of filed returns with computed figures.
- Trust levels, the Desk, live updates over a WebSocket.

### Phase 2: Social Media Manager

- A monthly calendar, per-channel drafts with every price and claim checked against the books, publishing after approval.
- Instagram, Facebook, Threads, LinkedIn, X and WhatsApp broadcast behind one channel interface; manual mode with a publishing pack for channels without keys.
- Listening: comments and messages arrive by webhook, enquiries become leads, replies are drafted for approval.

### Phase 3: The Floor, refined

- The Floor shows only staffed rooms, each with a headline figure; the Desk as a column on wide screens.
- Six office skins saved per person; the Boardroom and Hiring Hall lead with the owner's team.

### Phase 4: WhatsApp in your own language

- Approvals and questions on WhatsApp: numbered lists, "approve 1 3", items that need full review open on the Desk.
- English, Hindi, Marathi, Gujarati, Tamil, Telugu, Kannada and Bengali, including native digits; voice notes transcribed and repeated back before acting.
- A daily digest by WhatsApp or email.

### Phase 5: Multi-tenant offices

- A control plane in D1; office APIs under `/api/o/:officeId/` with membership checks that answer "not found" to everyone else; each office's Durable Object refuses callers from another office.
- Files under per-office prefixes; platform tokens sealed with a per-office key; inbound email, webhooks, OAuth and the shared WhatsApp number routed to exactly one office.
- One login, many offices; self-serve office creation; invitations, roles, handover, export, deletion with 30 days to restore.
- Daily AI and upload allowances per office; logs tagged by office; a two-office isolation test suite; the admin tool.
- The original office migrated in place, keeping its id.

### Phase 6b: Routines and the Customer Service agent

- **Routines:** every scheduled job is a named routine with an owner agent, a pause switch, "run now" and 90 days of run history (outcome, counts, errors) on a Routines page and in each agent's room. Two new routines: the reorder check (drafts purchase orders when the Storekeeper is hired) and returns and filings due in the next seven days.
- **Customer Service agent, first version:** answers the business's customers on WhatsApp (the business's own number only), a support email address per office and a website chat widget. It confirms who the customer is before giving a balance, answers order status, facts and saved answers from the books, and hands everything else to the owner with a summary. The model only classifies; the words come from the books. Trust levels decide what it sends on its own. The owner replies from the agent's room or from WhatsApp ("reply 2 …"), updates orders with "order 1042 shipped", and saves a good reply as an answer for next time.
- **Guardrails:** an AI disclosure on the first reply, flood and duplicate guards, a per-office AI sub-allowance, a rate limit per website visitor and optional Turnstile, retention of conversations for a period the owner sets.
- **Orders** come in by hand or CSV behind an `OrderSource` interface, so a shop connector can be added later.
- Research, competitors and the later phases are in [Customer service](08-customer-service.md).

## Next and planned

### Phase 6: Go-live readiness (next)

**Goal:** real businesses can sign up, send documents and be reached, safely.

| Work | Detail |
| --- | --- |
| Secrets on live | Done 5 November 2026: `BETTER_AUTH_SECRET` and `SOCIAL_TOKEN_KEY` are in Infisical and on the live Worker |
| Sending email | A provider that can reach any address; `MAIL_FROM` on our domain; SPF, DKIM, DMARC |
| Receiving email | Email Routing catch-all on an inbound subdomain; `INGEST_DOMAIN` set |
| Domain | **Built, to be deployed** (6 November 2026): `office.snilld.in` is the product page, `console.office.snilld.in` the sign-in, and each customer's office opens on its own address such as `kaveri.office.snilld.in`, with one sign-in across them (the Clubs and Sports OS pattern). Moving the Worker into the Snilld account, which holds `snilld.in`, is the first step of the go-live runbook |
| Privacy and terms | **In progress.** Drafts in `docs/legal` (privacy notice, terms, data processing terms, subprocessors, a customer AI notice template) are published at `/legal/...`, with consent recorded at sign-up and self-serve account download and deletion requests. Waiting on review by a lawyer in India and the bracketed details (company name, address, grievance officer) |
| Monitoring | Error-rate alerts; a weekly `admin.mjs list` review |
| Bringing in existing books | Done 6 November 2026: customers and suppliers, products and stock, and unpaid invoices and bills from three CSV templates, checked row by row in Settings and approved as one Desk card; the books get a fixed start date, and brought-forward items count towards ageing and statements but not returns |
| Readiness habit | Done 6 November 2026: `country`, `currency`, `locale` and `timeZone` are on the office record (India values only; migration `0004_office_locale.sql`), returned with each office and shown in Settings, so new code reads them instead of constants |

**Exit criteria:** a new person can sign up, confirm their email, open an office, receive a bill by email and approve it, on the custom domain, with secrets set and the checklist in the configuration document closed.

### Phase 7: Pilot and accuracy

**Goal:** ten real offices using the product weekly; evidence that the reading is accurate enough to trust.

| Work | Detail |
| --- | --- |
| Pilot onboarding | Ten businesses, with their accountants invited |
| Evaluation set | A saved set of real (anonymised) documents with expected readings; every model or prompt change is scored against it; the score feeds each agent's accuracy record |
| Cost meter per agent | AI calls and estimated cost per agent per month shown in its room, a soft warning at 80% of the office's allowance and a pause at 100% |
| Request a revision | A third choice on the Desk besides Approve and Reject: send the work back to the agent with a note |
| Feedback loop | Owner and accountant interviews every two weeks; changes tracked against the BRD success measures |

**Exit criteria:** 8 of 10 offices active weekly after a month; reading accuracy measured and published per agent; at least one Auditor difference per office confirmed by its accountant.

### Phase 8: Accounting firms

**Goal:** an accountant who looks after many businesses gets more from The Office than from their current tools, and brings clients.

| Work | Detail |
| --- | --- |
| Firm view | One screen across all client offices: returns due, differences open, documents waiting |
| Anchored comments | Comments on a specific line of a document or figure, threaded, visible to owner and accountant |
| Staff roles | Limited roles for staff (for example, upload and view only) |
| Partner programme | Referral terms for firms that bring client offices |

**Exit criteria:** at least two firms with five or more client offices each.

### Phase 9: Deeper teams

**Goal:** the Sales, Marketing, Operations and People rooms work from live data, not only the books.

| Work | Detail |
| --- | --- |
| Accounting connectors | A `BusinessBackend` interface; Tally import first, for businesses that keep their books there |
| Customer service, phase two | Shopify and WooCommerce order connectors, Instagram and Facebook messages, customer voice notes, a searchable knowledge base, and order changes made by the agent with approval |
| Agent configuration history | Every change to an agent's instructions or trust level is versioned and can be rolled back |
| Team templates | Hire a ready-made team (for example "Accounts for a wholesaler") in one step |
| Connector permissions | For each outside service an agent can use: Allowed, Ask first or Off |

**Exit criteria:** at least one non-Accounts team in weekly use by three pilot offices.

### Phase 10: Plans and billing

**Goal:** the product pays for itself.

| Work | Detail |
| --- | --- |
| Plans | Free (one office, the Accounts team in Trainee), paid tiers by office count and teams |
| Billing | Subscriptions per office; WhatsApp broadcast costs passed through transparently |
| Mobile | Installable web app (PWA) with notifications |

**Exit criteria:** first paying offices; platform cost below 10% of revenue.

### Phase 11: International markets (not started, by design)

**Trigger:** at least one of the traction signals in the BRD: inbound interest from a market, a pilot request, an accounting-firm partner or a distribution partner.

| Step | Detail |
| --- | --- |
| 1. Discovery | Two to four weeks for the market showing interest: interviews with owners and accountants, the tax and e-invoicing rules, the accounting software in use, the channel mix, the privacy obligations |
| 2. Jurisdiction pack | The country's tax lines, registers, return files, filed-return import and filing calendar, behind the pack interface; India's GST and TDS refactored into the first pack |
| 3. Locale and region | Office locale in use everywhere; data region chosen at office opening (EU jurisdiction for EU offices) |
| 4. Connectors | QuickBooks and Xero (US, UK, Australia), Sage or DATEV (EU), Peppol e-invoicing where used |
| 5. Channels | SMS alongside WhatsApp for the US; languages for the market |
| 6. Pilot | Five offices in the new market before general availability |

**Already in earlier phases, so this phase starts from a good place:** office locale fields (Phase 6), the `BusinessBackend` interface (Phase 9), the market-neutral positioning in every document, and the code habits listed in the architecture document.

## Ideas adopted from the Paperclip review

| Idea | Phase |
| --- | --- |
| Cost meter and budget pause per agent | 7 |
| Evaluation sets with saved test runs | 7 |
| "Request revision" as an approval outcome | 7 |
| Anchored comments on documents | 8 |
| Routines as first-class, with run history | 6b (done) |
| Versioned agent configuration with rollback | 9 |
| Installable team templates | 9 |
| Connector permissions: Allowed, Ask first, Off | 9 |
