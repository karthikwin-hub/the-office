# Business requirements

> **In one paragraph.** The Office gives the owner of a small business a team of AI agents (an Accountant, a Credit Controller, a Tax Clerk, an Auditor, a Social Media Manager and more) that work inside the owner's own books, show their work on an office floor plan, and change nothing until the owner approves. Every figure can be opened down to the document it came from. The problem it solves is universal: owners everywhere pay someone to keep their books and have no easy way to check the work. India is the first market, because the compliance load is heavy, business already runs on WhatsApp, and owner-operators are underserved. The product core is market-neutral; country-specific rules live in a jurisdiction pack. The US, EU, UK and Australia are designed for in this handbook, and nothing is built for them until there is interest or traction.

## 1. The problem

A small-business owner signs off on figures they cannot verify. Sales, purchases, tax returns and overdue payments are prepared by a bookkeeper, an in-house accountant or an outside firm, and the owner sees a summary. When something is wrong (a bill posted twice, input tax claimed from a supplier who never filed, a customer 90 days overdue that nobody chased) the owner usually finds out late, from a notice, an auditor or the bank.

Existing tools do not close that gap:

| What owners use today | Why it does not solve the problem |
| --- | --- |
| Accounting software (Tally, Zoho Books, QuickBooks, Xero) | Built for the person keeping the books, not for the owner checking them. Answers need an accountant to interpret. |
| Spreadsheets from the accountant | A snapshot with no link back to the invoices. Errors cannot be traced. |
| Generic AI chat assistants | Confident answers with no proof; they do not hold the books or the documents. |
| Agent orchestration platforms (see the Paperclip review) | Toolkits for technical teams. The owner would have to design the agents, pay for model usage and wire in accounting rules. |

**The insight.** Owners do not want "automation". They want verifiable certainty: show me the truth, show me the proof, so I can hold my accountant (human or AI) to it.

## 2. The product in business terms

- **Hire, don't configure.** The owner hires roles such as *The Accountant* from a Hiring Hall. Each comes with a job description, a work log and an accuracy record.
- **Every number has a source.** Any figure on any report opens the original invoice or bill, with the line highlighted.
- **Trust is earned.** Each agent starts as a *Trainee* (every action waits for approval), can be promoted to *Trusted* (routine work runs on its own) and then *Autonomous*.
- **The owner's accountant is a user, not a competitor.** The accountant gets a read-only seat, downloads returns and answers the Auditor's questions.
- **It works where the owner already is.** A web app on desktop and phone, plus WhatsApp in eight languages today (voice notes included) for approving work and asking questions.

## 3. Markets

### 3.1 First market: India

| Why India first | What it means for the product |
| --- | --- |
| Heavy, frequent compliance: monthly GST returns (GSTR-1, GSTR-3B), quarterly TDS returns, input tax credit matching | A deterministic GST and TDS engine and an Auditor that compares filed returns with the books is immediately valuable. |
| Business runs on WhatsApp | Approvals, questions and digests on WhatsApp, in the owner's language. |
| Large owner-operated SME segment, often with an outside accountant | The "check your accountant" story lands directly. |
| Price-sensitive | A stack that runs on a free tier keeps the cost to serve close to zero during pilots. |

The sample business used throughout the product and this handbook is **Kaveri Electricals**, an electrical trading business. It is an illustration, not a definition of the customer.

### 3.2 Expansion thesis (designed for, not built)

The same owner problem exists in every market below. What changes is the tax regime, e-invoicing, privacy law, preferred channels and the accounting software already in use. What stays the same is the core: the books with source links, the agents, the approval and trust model, multi-office accounts and the floor plan.

| Market | Tax and filing | E-invoicing | Privacy law | Channels | Accounting ecosystem |
| --- | --- | --- | --- | --- | --- |
| India (built) | GST (CGST, SGST, IGST), TDS sections 194C, 194J, 194Q, 194H; GSTR-1, GSTR-3B, 26Q | IRN e-invoicing above a turnover threshold | DPDP Act 2023 | WhatsApp first, email | Tally, Zoho Books |
| United States | State and local sales tax (economic nexus), 1099-NEC and 1099-MISC, quarterly estimated tax | Not mandated | State laws (CCPA and CPRA, others) | Email and SMS first; WhatsApp minor | QuickBooks, Xero, Bill.com |
| European Union | VAT with OSS for cross-border sales, reverse charge | ViDA: mandatory B2B e-invoicing rolling out; Peppol widely used | GDPR | WhatsApp strong in most member states, email | Xero, Sage, local packages (DATEV in Germany) |
| United Kingdom | VAT, Making Tax Digital submissions | Not mandated; Peppol available | UK GDPR | WhatsApp strong, email | Xero, QuickBooks, Sage |
| Australia | GST, BAS lodgement, Single Touch Payroll | Peppol (government-backed) | Privacy Act 1988 | WhatsApp and SMS, email | Xero, MYOB, QuickBooks |

**Expansion is gated by traction.** A market moves from "designed for" to "discovery" only when at least one of these signals appears:

1. Inbound interest from owners or accountants in that market (demo requests, waitlist sign-ups from that country).
2. A pilot request from a business willing to share real books.
3. An accounting-firm partner who would bring several clients.
4. A reseller or distribution partner in the region.

Until then, the only international work is design (this handbook) and cheap habits in the code, described in the architecture document.

## 4. Objectives

| # | Objective | Measure |
| --- | --- | --- |
| O1 | Owners can verify their books without an accountant interpreting them | Share of Boardroom figures opened to their source per active office; owner-reported confidence in pilot interviews |
| O2 | Catch errors and leakage early | Auditor differences found per return; overdue amount recovered after reminders |
| O3 | Low effort to adopt | Time from sign-up to first document read under 10 minutes; no configuration needed to hire the Accounts team |
| O4 | Earn trust gradually | Share of agents promoted from Trainee to Trusted after 30 days; approval-to-rejection ratio |
| O5 | Near-zero cost to serve during pilots | Platform cost per office per month (target: free tier for the pilot, the $5 Workers Paid plan up to about 50 offices) |
| O6 | Stay ready for other markets | No new hard-coded currency, time zone or tax rule outside the engine (checked in review) |

## 5. Stakeholders

| Stakeholder | Interest | Role in the product |
| --- | --- | --- |
| Business owner | Certainty, control, less time on paperwork | Owner of the office: hires agents, approves work, invites people |
| The owner's accountant (in-house or a firm) | Clean books, fewer queries, faster filing | Accountant seat: reads everything, downloads returns, answers the Auditor; cannot approve |
| Staff (sales, stores, admin) | Simple tasks without seeing everything | Future limited roles |
| Customers and suppliers of the business | Accurate invoices and polite reminders | Receive reminders and posts only after the owner approves |
| Platform operator (us) | Reliable, safe, cheap to run | Runs the platform with the admin tool; cannot read books through the product |
| Consultants and partners | Understand, extend, resell | Readers of this handbook |

## 6. Scope

**In scope now (built or being built):**
- Accounts team: Accountant, Credit Controller, Tax Clerk, Auditor; the Office Manager as the conversational front door.
- Social Media Manager across Instagram, Facebook, Threads, LinkedIn, X and WhatsApp broadcast, every post approved.
- WhatsApp desk for approvals and questions in eight languages, voice notes included.
- Multi-tenant offices: one login, many offices; owner and accountant roles; invitations; export and deletion.
- Sales, Marketing, Operations and People rooms working from the books (preview depth).

**Out of scope for building, in scope for design:**
- Other markets' jurisdiction packs, locales, data regions and connectors.

**Out of scope:**
- Filing returns directly with tax authorities (the product prepares files; the accountant or owner files). This is deliberate: it keeps the trust model simple and avoids licensing as a filing intermediary.
- Payroll processing and payments execution.
- Replacing the system of record when a business already uses Tally, QuickBooks or Xero (we read from it later; we do not replace it).

## 7. Business rules

Rules are split into a **core** that applies in every market and a **jurisdiction pack** per country.

### 7.1 Core rules (every market)

1. Nothing changes in the books, and nothing is sent to a customer, supplier or social channel, until it is approved by the owner or by an agent whose trust level allows that routine action.
2. Every figure shown or exported traces to one or more source documents.
3. Tax is computed by deterministic code, never by a language model. Models read documents and draft text; they do not decide amounts.
4. Each business's data is isolated. A person sees an office only through a membership, and a request for any other office is answered as if it did not exist.
5. The owner can export everything and delete the office, with 30 days to restore.
6. Agents work under a daily allowance (AI calls and storage per office) so one office cannot affect others.

### 7.2 India pack (built)

- GST place of supply, CGST and SGST for intra-state supply, IGST for inter-state, HSN summaries; GSTR-1 in the offline-tool JSON format; GSTR-3B summary in Excel.
- TDS under sections 194C, 194J, 194Q and 194H, deposit due dates and the quarterly 26Q.
- Amounts in rupees and paise with Indian digit grouping (12,34,567).
- Personal data handled under the Digital Personal Data Protection Act 2023: purpose-limited, deletable on request (the admin tool's `forget-user`).

### 7.3 Later packs (named only)

- **United States:** sales tax by nexus and jurisdiction, 1099 reporting.
- **European Union:** VAT with OSS and reverse charge; ViDA e-invoicing over Peppol.
- **United Kingdom:** VAT and Making Tax Digital submissions.
- **Australia:** GST and BAS; Single Touch Payroll for the People team.

## 8. Constraints

- **Free and open-source stack.** Every library is under a permissive licence (MIT, Apache-2.0, ISC, OFL). No paid model API is required to run the product.
- **Runs on Cloudflare's free tier** for development, demos and early pilots; the $5 per month Workers Paid plan lifts limits when real clients arrive.
- **Mobile-first for owners.** Owners check on their phones; every screen must work at phone width.
- **No secrets in files.** Secrets live in Infisical and Cloudflare's secret store.

## 9. Success measures for the pilot

| Measure | Target for the first 10 pilot offices |
| --- | --- |
| Offices with documents arriving weekly | 8 of 10 after one month |
| Auditor differences confirmed as real by the accountant | At least 1 per office per quarter |
| Owner approvals done on WhatsApp | More than half |
| Agents promoted to Trusted | At least one per office within 60 days |
| Platform cost | Within the free tier, or under the Workers Paid plan |

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Reading accuracy of open-weight models on poor scans | Medium | High | Text layer read in the browser first; vision model only for scans; every reading staged for approval; evaluation set and accuracy record per agent |
| Accountants see the product as a threat | Medium | High | Position as the accountant's ally: read-only seat, fewer queries, faster filing; accounting-firm partner programme |
| Perceived as an India-only product | Medium | Medium | Market-neutral positioning, core versus jurisdiction pack in every document, international design ready to show |
| Outside costs: WhatsApp Business conversations, email sending | High | Low to medium | Free replies inside WhatsApp's 24-hour window; broadcasts show their cost before approval |
| Platform dependency on Cloudflare | Low | Medium | Standard web APIs, SQLite storage and S3-compatible files; a migration path is described in the deployment document |
| Data-protection obligations in each market | Medium | High | Isolation by design, export and deletion built in, per-office data region designed before entering the EU |
| Tax rule changes | High | Medium | Rules isolated in the engine with unit tests; rule tables versioned by effective date |
