<!--
  The Agentic Office reference: one document for business, technical, user and support questions.
  Build the HTML page beside it with:  node tools/docs/reference.mjs   (writes docs/reference/index.html)
  Each "# " heading is a part of the document; "## " headings are its sections.
-->

# At a glance

> **In one paragraph.** Agentic Office by Snilld AI gives the owner of a small business a team of AI agents (an Accountant, a Credit Controller, a Tax Clerk, an Auditor, a Compliance Officer, a Social Media Manager and more) that work inside the business's own books. The team shows its work on an office floor plan, every figure can be opened down to the document it came from, and nothing changes until the owner approves it. India is the first market. The product runs on Cloudflare, with one private database per business, and reads documents with open-weight AI models while every amount and tax figure is calculated by tested code.

| | |
| --- | --- |
| Product name | Agentic Office by Snilld AI ("The Office" in code and older documents) |
| Who it is for | Owners of small and medium businesses, and the accountants who look after them |
| First market | India: GST, TDS, Companies Act filings, WhatsApp, Indian languages |
| Where it runs | Cloudflare (the Snilld account): one Worker, one Durable Object per business, D1, R2, Workers AI |
| The app | https://app.office.snilld.in |
| The demo | https://demo.office.snilld.in (a sample business, safe to show anyone) |
| Source code | `github.com/karthikwin-hub/the-office`, branch `main` |
| Secrets | Infisical, project for The Office, environment `dev` |

**How to use this document.** Each part stands on its own. Owners and their accountants want the **User guide**. People running the platform want the **Platform console**, the **Support manual** and **Domains and environments**. Partners and consultants start with **Business scenarios** and **Solution and architecture**. The detailed product and technical handbook (`docs/handbook`) and the go-live runbook (`docs/runbooks/phase-6-go-live.md`) go deeper; this document points to them where it summarises.

# Business scenarios

> **In one paragraph.** Each scenario below is something an owner, an accountant or our own team does with the product, from the trigger to the result. They describe the product as it is built today. "The owner approves" always means on the Desk in the app or by replying on WhatsApp.

## 1. The problem the product solves

A small-business owner signs off on figures they cannot verify. Sales, purchases, tax returns and overdue payments are prepared by a bookkeeper, an in-house accountant or an outside firm, and the owner sees a summary. When something is wrong (a bill posted twice, input tax claimed from a supplier who never filed, a customer 90 days overdue that nobody chased) the owner finds out late, from a notice, an auditor or the bank.

Owners do not want "automation". They want to see the truth and the proof, so they can hold their accountant, human or AI, to it. The product's three promises follow from that:

- **Every number has a source.** Any figure opens the bill or invoice behind it, with the line highlighted.
- **Nothing changes without the owner.** The team proposes; the owner approves, edits or rejects.
- **Trust is earned.** Each agent starts as a Trainee and can be promoted once its accuracy record shows it is reliable.

## 2. A supplier's bill arrives

| Step | What happens |
| --- | --- |
| Trigger | The owner forwards a supplier's bill to the office's own email address, uploads it in the Accountant's room, or sends a photo on WhatsApp. |
| The Accountant reads it | The bill's text is read, or a scan is read by a vision model. The supplier, GSTIN, lines, HSN or SAC codes and tax are extracted. |
| Checks | Tested code recomputes every line and the tax (CGST and SGST within the state, IGST between states), checks the totals and the GSTIN, flags TDS where it applies (for example section 194C on a courier bill over the limit) and sets aside a copy of a bill already recorded. |
| The owner decides | A card appears on Your Desk ("Post bill ₹36,475 from the courier, TDS 194C ₹618") with the document one click away. The owner approves, edits or rejects with a reason. |
| Result | The bill is in the books, linked to its document, counted in payables, GST and TDS reports, and visible in the Boardroom. |

Sales invoices are recorded the same way ("Record invoice"). Proforma invoices and delivery challans are recognised and filed without being posted. An invoice issued from the business's other GST registration is recognised as the business's own.

## 3. Customers who have not paid

The Credit Controller works out due dates from payment terms and ages every unpaid invoice into 0 to 30, 31 to 60, 61 to 90 and over 90 days. It drafts reminders that escalate from polite to firm to final, at the intervals the owner sets in Settings. Each reminder waits on the Desk; once approved it is emailed to the customer. The Boardroom shows who owes what and since when, and each figure opens the invoices behind it.

## 4. Monthly GST and TDS, and checking the accountant

1. The Tax Clerk calculates GST and TDS from the books with deterministic code, never with an AI model.
2. The accountant downloads files ready to upload: GSTR-1 in the offline tool's JSON format, and GSTR-3B and TDS summaries in Excel with live formulas.
3. After filing, the accountant's filed returns are imported, and the Auditor explains every difference from the books in plain language, with the documents linked.
4. The product prepares and reminds; the owner or the CA files on the government portals. No agent logs in to a government portal or signs with a DSC.

## 5. The company's statutory calendar

The Compliance Officer builds the company's own filing calendar from a short profile (most of it filled from the books): GST returns, TDS deposits and returns (including the change to the Income-tax Act 2025 for payments from 1 April 2026), advance tax, the income-tax return and audit, MCA forms (AOC-4, MGT-7, DIR-3 KYC, DPT-3, MSME-1 and others), PF, ESI and professional tax. Each item says why it applies, when it is due, what is at stake if missed, and who is doing it. Reminders go out 7 days and 2 days before, on the day, and weekly while late. Checks on the books, such as micro and small suppliers owed beyond 45 days, propose actions on the Desk.

## 6. Bringing in the books a business already keeps

A business moving from Tally or spreadsheets fills in three CSV templates in Settings, under **Bring in your books**: customers and suppliers, products and stock, and unpaid invoices and bills. The check reads every row and says exactly what to fix, by row number: a GSTIN whose check digit is wrong is refused with a hint, for example that a letter I was typed for the digit 1. When everything reads correctly, one card goes to the Desk; the owner approves it all at once. The first approved import fixes the date the books start from.

## 7. Approving from WhatsApp, in the owner's language

An owner who links their phone in Settings gets a daily digest and can approve from WhatsApp: "approve 1 3", "reject 2". They can ask questions in English, Hindi, Marathi, Gujarati, Tamil, Telugu, Kannada or Bengali, by text or voice note; a voice note is repeated back before anything is done. Items that need a full review, such as posts and payroll runs, open on the Desk instead.

## 8. The business's own customers ask questions

The Customer Service agent answers the business's customers on the business's WhatsApp number, by email and in a chat on the business's website. It answers order status and account balance from the books (after the customer is identified) and business facts from answers the owner has saved. It hands refunds, complaints and anything it cannot ground to the owner, with a short summary, and never leaves a customer without a reply. The AI only classifies messages; the words come from the books, the facts or a saved answer.

## 8a. The owner's own assistant

The Executive Assistant works for each owner on their own, not for the office. The owner gives it their calendar's private address (Google Calendar's "Secret address in iCal format") and forwards emails to `<slug>.assistant@in.office.snilld.in`. Each morning it plans the owner's next three days: their meetings, their tasks, and what the office needs from them that day (the desk, filings due, customers waiting), with a brief from the books before every meeting with a customer or supplier and a suggested slot for desk work. Replies to forwarded emails are drafted for the owner's own desk, checked against the books (a figure the books do not hold is flagged), and sent only when the owner approves, from the office's address in the owner's name with replies coming back to the owner. Tasks come from the room, from WhatsApp ("remind me to call Sharma on Friday") and from promises in replies the owner sent. None of it is seen by the accountant or other owners.

## 8b. Sales on Amazon, Flipkart, Blinkit and the other apps

A business that sells on marketplaces and quick-commerce apps already receives their reports by email or WhatsApp. The Marketplace Manager reads them: Amazon's tax reports (B2C and B2B), settlement reports and transaction report (orders and refunds, with its fees, TCS, TDS and bank transfers read as a payout), Flipkart's sales report, Meesho's GST reports and Myntra's monthly P&L report (totals by SKU, counted in sales and units but not in orders) are recognised by their columns; any other sheet (for example Blinkit's or Zepto's) is confirmed once by the owner, column by column, and read on its own after that. The office then shows sales by channel, week, product, state and city, with returns, cancellations, average order value and payouts, and puts the last day's online sales in the morning digest. The same file twice is set aside, and lines that come in again in an overlapping report are not counted twice. This first version does not post anything to the books; posting to the books with GST, TCS and settlements is the next step.

## 9. Social media that never misstates a price

The Social Media Manager plans a monthly calendar, drafts posts for Instagram, Facebook, Threads, LinkedIn, X and WhatsApp broadcast, checks every price and claim against the books, and publishes only after approval. It listens for comments and messages and turns enquiries into leads. Without a platform connection it prepares a publishing pack and the owner posts by hand.

## 10. An accountant who looks after several businesses

One login can belong to several offices. An owner invites their accountant by email; the accountant reads everything, downloads returns and answers the Auditor, but cannot approve or hire. The accountant switches between clients with the office menu at the top left.

## 11. Opening a new client's office (our team)

A platform owner opens the platform console, enters the business's name and the owner's email address, and presses **Open the office and invite**. The owner receives a 14-day, single-use invitation by email, makes an account with that address, and lands in an empty office ready to hire the Accounts team. Further owners and the accountant are invited from the office's own Settings.

## 12. Showing the product

The demo at https://demo.office.snilld.in runs the real app with a sample business, Kaveri Electricals, entirely in the visitor's browser. It opens on the Lived-in office: the office as a 3D pop-up book, with the team at work. Nothing in the demo is saved on a server, so it is safe to hand to anyone.

# Solution and architecture

> **In one paragraph.** The product is one Cloudflare Worker that serves the React app and the API, plus one Durable Object per business that holds that business's books in its own private SQLite database and is their only writer. A small shared database (D1, the control plane) knows only who belongs to which office and where inbound email and webhooks go. Files sit in R2 under a folder per office. Documents are read with open-weight models on Workers AI; every amount and tax figure is computed by deterministic, unit-tested code. The same app runs as the demo with no backend, answering every API route from sample data in the browser.

![System context](../handbook/diagrams/system-context.svg)

## 1. The product in three spaces

| Space | What it is for |
| --- | --- |
| **The Floor** | The team at work: a room per hired agent with what it is doing, today's count and its headline figure, and a team log alongside. In the Lived-in look the office is a 3D pop-up book (see section 8). |
| **The Boardroom** | Reports a business and its accountant already use: sales, ageing, tax registers, cash, and a tab per team. Every figure drills down to its documents. |
| **Your Desk** | Approvals. Each card says exactly what will happen, with Approve, Edit and Reject. |

## 2. The team

| Agent | Team | What it does | Depth today |
| --- | --- | --- | --- |
| Office Manager | Front office | Answers questions in plain language with linked figures; the front door of the office | Built |
| Customer Service | Front office | Answers the business's own customers on WhatsApp, email and website chat | First version built |
| Marketplace Manager | Sales | Reads marketplace and quick-commerce sales reports into sales by channel, product, state and city, with returns and payouts | First version built (reports only; not yet posted to the books) |
| Executive Assistant | Front office | Each owner's own: calendar, three-day agenda with meeting briefs, tasks, replies to forwarded emails | First version built (calendar by private link, email by forwarding) |
| Accountant | Accounts | Reads bills and invoices; stages entries linked to their documents; sets aside duplicates | Built |
| Credit Controller | Accounts | Ages debtors; drafts escalating reminders | Built |
| Tax Clerk | Accounts | GST and TDS by deterministic code; return files | Built (India) |
| Auditor | Accounts | Compares filed returns with the books and explains differences | Built |
| Compliance Officer | Operations | The company's filing calendar, checks on the books, MCA filing packs | Built (India) |
| Social Media Manager | Social | Calendar, drafts, price checks, publishing after approval | Built |
| Sales Rep, Quote Desk, Account Manager | Sales | Leads, quotations, reorder predictions | Preview on the books |
| Marketer, Market Watcher | Marketing | Festival promotions, competitor prices | Preview on the books |
| Storekeeper, Buyer | Operations | Reorder points, vendor quotes | Preview on the books |
| Payroll Clerk | People | Payroll summary and payslip runs for approval | Preview on the books |

"Preview on the books" means the room, its reports and its approval cards work from the office's books, but the agent has no live outside data source yet. For exactly what each agent does today, step by step, see **How the work flows**.

**Trust levels.** Every agent starts as a **Trainee** (everything waits for approval), can be promoted to **Trusted** (routine work runs on its own and is logged) and then **Autonomous**. Audit flags, file sharing, payroll runs, campaigns, calendars, broadcasts and posts are always reviewed on the Desk whatever the level, and the Executive Assistant's replies always wait for their owner.

## 3. Components

| Package | What it holds |
| --- | --- |
| `apps/web` | The React app (Floor, Boardroom, Desk, rooms, Hiring hall, Routines, Settings, office picker, sign-in, platform console). React 19, Vite, TanStack Router and Query. Built twice: live, and the demo with `VITE_DATA=mock`. |
| `apps/api` | The Cloudflare Worker: routing, sign-in (better-auth), the control plane, inbound email and webhooks, the `Office` Durable Object, the weather lookup. Hono, Drizzle. |
| `packages/contracts` | Every entity and API response as a zod schema, and the route table. The app, the demo, the Worker and the engine all use the same types. |
| `packages/engine` | The books and the agents as pure TypeScript: ledger, GST, TDS, ageing, audit, compliance, reports, social, WhatsApp desk, imports, Excel exports. No Cloudflare dependency. |
| `packages/ui` | Shared components: the floor plan, the 3D Lived-in office, the ledger table, the source viewer, approval cards. |
| `packages/fixtures` | The Kaveri Electricals sample business. |
| `tools` | The admin tool, deploy script, end-to-end checks, screenshots, this document's builder. |

## 4. How a request finds its office

Every office API lives under `/api/o/<officeId>/`. Account routes (`/api/me`, `/api/offices`, `/api/invitations/...`, `/api/auth/...`) do not.

![Request path](../handbook/diagrams/request-path.svg)

1. **Session.** The session cookie is checked against D1. No session: 401.
2. **Membership.** The person must be a member of the office. Anything else answers 404, exactly as an office that does not exist. A suspended office answers 423.
3. **To the office.** The Worker forwards to the Durable Object named after the office id, and sets the caller (person, role, office) itself; headers from the browser that claim a role are discarded.
4. **The office checks again.** The Durable Object knows its own id and refuses any caller for another office. Even a bug in the Worker could not hand one office's books to another.

## 5. Where data lives

![Data placement](../handbook/diagrams/data-placement.svg)

| Store | Holds | Never holds |
| --- | --- | --- |
| D1 `office` (control plane) | Accounts, sessions, offices, memberships, invitations (only a hash of each link), routes for inbound mail and webhooks, WhatsApp links, consent records, audit | Any business's books |
| One Durable Object per office (SQLite) | That office's books, staged changes, team log, routines history, customer conversations, the field-level edit log, persona names; and, apart from the books, each owner's assistant record (calendar events for two weeks, tasks, the last 50 forwarded emails, drafted replies) and their calendar address, encrypted; and online sales lines read from marketplace reports (order, product, quantity, amounts, the customer's state and city; no names or addresses), with the original files in R2 | Another office's data. The assistant records are not in the books, the backups or the eight-year retention, and are deleted when the owner leaves |
| R2 `office-docs` | Original documents and images under `o/<officeId>/`; books kept eight years after deletion under `retained/<officeId>/`, sealed with the office's key, then deleted by the nightly cron | Files outside the office's folder |

## 6. Inbound traffic

![Inbound routing](../handbook/diagrams/inbound-routing.svg)

| Channel | How the office is found |
| --- | --- |
| Bills by email | Each office has `<slug>@in.office.snilld.in`. The `route` table maps the address to the office; unknown addresses are refused. At most 5 attachments per email, PDFs and images. |
| Customer service email | `<slug>.help@in.office.snilld.in`, claimed when the Customer Service agent is hired. |
| Sales reports email | `<slug>.sales@in.office.snilld.in`, claimed when the Marketplace Manager is hired. Takes CSV, XLSX, tab-separated text and zip files, up to 10 per email and 10 MB each, from the platforms' own domains and from people in the office; anything else is set aside unread. Spreadsheets sent on WhatsApp go to the same agent. |
| Assistant email | `<slug>.assistant@in.office.snilld.in`, claimed when the Executive Assistant is hired. Only mail from an owner's own address is read (forwarded by hand, or by a Gmail filter, which sends as the owner); Gmail's forwarding confirmation code is shown in the Assistant's room. Attachments go to the Accountant. |
| WhatsApp (shared number) | One number serves every office. A person's phone is linked with a six-digit code from Settings; someone in several offices is asked which office a message is for. |
| WhatsApp (a business's own number), Facebook, Instagram, Threads | Webhook signatures are checked, then each message is routed by its page, account or number id. |
| Website chat | `/api/chat/<key>`, rate-limited per visitor, no cookies; answers 404 when the chat is off. |

## 7. Reading documents, and keeping AI away from the figures

1. **Text first, in the browser.** A PDF's text layer is extracted on the person's own device with pdf.js.
2. **A model reads the text** into a strict JSON shape (Llama 3.3 70B on Workers AI). Scans go to a vision model (Llama 3.2 11B Vision). Voice notes go to Whisper.
3. **Tested code checks it.** The engine recomputes every line and tax amount, checks the totals and the GSTIN, and looks for duplicates.
4. **Staged, never posted.** The result becomes a card on the Desk linked to the document and its highlighted region.

Money is held in integer paise. Tax is never decided by a model.

## 8. The Lived-in office (3D)

The Lived-in look turns the Floor into a papercraft pop-up book. It is a picture only: it reads the same office view as the plain Floor and changes nothing any agent does.

- **What it shows.** A red bahi-khata opens on a desk and the office folds up out of the page. The painted sky behind follows the real sun and moon over the business's city (from the weather lookup's approximate location, else the capital of its GST state). Lamps come on at dusk. The team walks the office: a paper plane brings an email to reception, sheets are carried to the pile on the owner's desk, approvals are stamped with the seal and filed, rejections are crumpled into the bin, and a new hire's room folds up out of the page.
- **Which rooms.** Only the staffed rooms, with the vacancies in one flat corner, unless the person chose **Show the whole floor**, in which case every room is drawn and the empty ones lie flat.
- **How it is built.** three.js in its own download, loaded only for this look. Shaders are compiled before the book opens; it draws at 30 frames a second when little is moving, every frame during the opening and camera moves, and nothing while the tab is hidden. Plates and speech bubbles are ordinary HTML links and text on top of the picture.
- **When it steps aside.** Phones and small tablets get the plain floor in the look worn before Lived-in, with the team's names on the doors. Without WebGL 2, with data saver on, on a low-memory device, on a device that cannot keep up in the first seconds, or when the person ticks **Use the simpler picture** in Settings, the drawn 2D Lived-in floor is shown instead.

## 9. Security model

| Concern | Control |
| --- | --- |
| Sign-in | Email and password (better-auth), email confirmation before opening an office or accepting an invitation, rate limiting by Cloudflare's own client address; sign-up does not show which addresses have accounts |
| Two-step sign-in | A code from an authenticator app (or a backup code) for office owners and platform owners, set up at their first visit |
| Sessions | End after 12 idle hours; exporting, inviting, changing roles, handing over, deleting an office and console changes ask to confirm again after 15 minutes |
| Browser | Strict security headers on every page; changes only from the app's own pages; stored files open in the browser only as PDF or picture, sandboxed |
| Inbound email | A sender is trusted only when Cloudflare proves it; anything else waits on your desk |
| Isolation between businesses | Membership check in the Worker, a sealed caller and an identity check in the Durable Object, a database per office, a file folder per office |
| Invitations | Single use, bound to the invited address, 14 days, only a hash stored, never in a URL the server logs; the console can invite an owner only into an office that has none |
| Password reset | A link by email that works once, for an hour; other sessions are signed out |
| Platform tokens | Encrypted per office with a key derived from `SOCIAL_TOKEN_KEY` |
| Operators | The platform console and admin tool see the control plane only; there is no command to read a business's books |
| Edit log | Every change to the books recorded (old and new value, who, when), hash-chained, refused by the database if anyone tries to alter it, kept eight years |
| Secrets | Infisical and Cloudflare's secret store; never in files, chat or logs |
| Owner-private data | The Executive Assistant's routes answer owners only, each for their own email address; its drafts are added to that owner's desk and floor and to nobody else's; its log lines never name an event or email |
| Fair use | Per office per day: 400 AI calls, 150 for customer service, 100 for the assistant's drafts (then plain holding replies), and 250 MB of uploads; a plain 429 when spent |

## 10. The demo build

The same app built with `VITE_DATA=mock` answers every real API route inside the browser (Mock Service Worker) from the sample books, running the real engine. Changes a visitor makes are kept in that browser only. It is deployed as its own Worker, `the-office-mock`, serving only static files.

## 11. Quality

The engine has 426 automated tests (tax, ageing, audit, compliance, imports, social, WhatsApp, the 3D office's sky, routes and paper trail), the Worker 202 (including a two-office isolation suite, sign-in and inbound mail), and 11 more run the office itself inside Cloudflare's runtime. GitHub Actions runs them, with the type check, on every pull request. The security review of November 2026 and its open work are in `docs/security/README.md`.

# Domains and environments

> **In one paragraph.** Everything the public sees is under `office.snilld.in`, in the Snilld Cloudflare account. Three addresses are websites people use (the product page, the app and the console), one is the demo, and one is not a website at all but the email domain bills are sent to. The older copy in a separate Cloudflare account was deleted on 18 November 2026.

## 1. Addresses

| Address | What it is | Who uses it |
| --- | --- | --- |
| **office.snilld.in** | The product page: the marketing site | Prospective customers |
| **app.office.snilld.in** | The app: sign in, choose an office, work in it. Invitation, confirmation and password-reset links point here; social sign-in callbacks return here | Business owners, their accountants, and our team |
| **console.office.snilld.in** | The platform console: every business's account, onboarding, invitations, suspending. Shows accounts, never books | Platform owners only (see Configuration) |
| **demo.office.snilld.in** | The public demo with the sample business Kaveri Electricals; nothing is saved on a server | Sales demonstrations, reviews |
| **in.office.snilld.in** | Not a website: the email domain for incoming mail. Each office receives bills at `<slug>@in.office.snilld.in` and customer email at `<slug>.help@in.office.snilld.in` | Businesses forward bills there |
| **`<name>`.office.snilld.in** | Optional: an office's own web address, for example `neltrade.office.snilld.in`. None are set up yet; each is added on request with `admin.mjs subdomain` | One business each |
| **support@snilldai.com** | Not a website: the sender of invitations, confirmations, password resets, reminders and digests, sent through Resend | Outgoing email |

One sign-in covers every address under `office.snilld.in`: the session cookie is set for the whole domain.

## 2. Environments

| Environment | Where | Data | Deployed by |
| --- | --- | --- | --- |
| Live | The Worker `the-office` in the Snilld Cloudflare account, on the addresses above | Real offices: D1 `office`, R2 `office-docs`, one Durable Object per office | The Deploy workflow, run by hand and approved (`deploy.sh live`) |
| Staging | The Worker `the-office-staging` on workers.dev (`env.staging` in `apps/api/wrangler.jsonc`) | Test offices only: D1 `office-staging`, R2 `office-docs-staging`, its own secrets | The Deploy workflow, on every green push to `main` (`deploy.sh staging`) |
| Demo | The Worker `the-office-mock` on demo.office.snilld.in | Sample books in the visitor's browser | An owner: `infisical run --env=prod --silent -- sh tools/admin/deploy.sh demo` |
| Local | `wrangler dev` and Vite on a developer's machine (`pnpm dev` for the mock app) | Local state only | Not deployed |
| Old account | "the-office-agents" Cloudflare account | Emptied on 18 Nov 2026 (backup in `backups/`) | Its API token is still to be revoked |

## 3. Outside services

| Service | Used for | Notes |
| --- | --- | --- |
| Cloudflare (Snilld account) | Hosting, database, files, AI models, DNS for `snilld.in`, email routing | The deploy token is `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE` in Infisical |
| Resend | Sending email from `support@snilldai.com` | `snilldai.com` is verified there (shared with Clubs and Sports OS) |
| MET Norway (api.met.no) | The weather near the viewer, for the Lived-in office | Only a location rounded to about ten kilometres is sent; data under CC BY 4.0, credited in the app |
| Meta, LinkedIn, X | Social posting, comments and messages; WhatsApp | Optional per platform; without keys a channel works by hand |
| GitHub | Source code | `karthikwin-hub/the-office` |
| Infisical | Secrets | Project for The Office, environment `dev` |

# User guide

> **In one paragraph.** This part is for the owner of a business and their accountant. It walks through getting into the office, finding your way round, approving the team's work, sending documents in, bringing in existing books, hiring and promoting agents, inviting people, and choosing how the office looks. Everything works on a phone as well as a computer.

![The Floor](../../screenshots/latest/floor-desktop.png)

## 1. Getting in

**First time, from an invitation.** Open the link in the invitation email. Make an account with the address the invitation was sent to (your name, that email address and a password of at least 10 characters), accept the terms, and confirm your address from the email you receive. You land in the office.

**Every time after that.** Go to https://app.office.snilld.in and choose **Sign in**. Invitation links work once: after you have joined, use the app's address, not the old link. An old link now opens on Sign in and says it has been used.

**Forgotten password.** On the sign-in page choose **Forgotten your password?**, enter your email address, and open the link we send. It works once, for an hour. After you choose a new password you are signed out everywhere else.

**More than one office.** If you belong to several, choose one after signing in. Switch at any time with the office name at the top left, which also offers **Open another office**.

## 2. Finding your way round

| At the top | What it opens |
| --- | --- |
| The office name | Switch office, or open another |
| **Floor** | The team at work, and today's team log |
| **Boardroom** | Reports, every figure traceable to its documents |
| **Your desk** (with a count) | Everything waiting for your decision |
| **Ask the office manager** | Questions in plain language, answered with linked figures |
| **Hiring hall** | Hire agents and set how far you trust each one |
| **Routines** | What the office does on a schedule, and when it last ran |
| **Settings** | Your business, people, channels, look and account |

## 3. The Floor

Each hired agent has a room showing what it is doing now, how much it has done today, and one figure worth your attention, such as the value of bills waiting. A number at a room's door is what that agent has left on your desk. The team log beside the floor lists today's work, newest first.

**On a computer, a click opens the agent beside the floor.** Click a room, its name plate or the agent in the picture, and the panel on the right shows what the agent is doing, its figures, what is waiting for you (approve or reject right there) and what it did today, without leaving the floor. In the Lived-in office the view glides to that room. **Open the full room** goes to the agent's own page; **×**, **Back to today on the floor** or the Esc key closes the panel. Clicking **Your desk** shows everything waiting for you in the same panel. Hold Ctrl (Cmd on a Mac) while clicking to open the full room in a new tab instead. On a phone or a narrow window, a click opens the room's own page.

Under the floor, **Show the whole floor** also draws the rooms you have not hired for, and **Skin** changes the look (see section 10).

## 4. Your Desk: approving work

![Your Desk](../../screenshots/latest/desk-desktop.png)

Each card says exactly what will happen if you approve it, with the documents one click away.

- **Approve** applies it: posts the bill, sends the reminder, files the challan.
- **Edit** lets you change the words before approving (for example a reminder's message).
- **Reject** asks why; the agent learns from your reason.
- When several cards do the same thing, **Approve all** appears above them.

Nothing reaches a customer, a supplier or a social channel until it is approved, by you or by an agent you have trusted with that routine work.

## 5. The Boardroom

![The Boardroom](../../screenshots/latest/boardroom-accounts-desktop.png)

Reports by team: Accounts (sales, purchases, ageing, GST, TDS, cash), Sales, Marketing, Social, Operations and People. Choose the **as of** date at the top. Click any figure to see the documents behind it, and any document to open it with the line highlighted. Excel downloads keep their formulas, so your accountant can check them.

## 6. Sending documents in

| Way | How |
| --- | --- |
| Email | Forward bills and invoices to your office's own address, shown in **Settings → Office** (it ends `@in.office.snilld.in`). Up to 5 PDF or image attachments per email. |
| Upload | In the Accountant's room, choose or drop files. |
| WhatsApp | Once your phone is linked (section 9), send a photo or PDF. |

The Accountant reads each document and puts a card on your desk. A copy of a bill already recorded is set aside, and the room says so. Proformas and delivery challans are filed, not posted.

## 7. Bringing in your existing books

In **Settings → Bring in your books**, download the three templates (customers and suppliers; products and stock; unpaid invoices and bills), fill them in from Tally or your spreadsheets, and upload them. **Check the files** reads every row and lists anything to fix, with the row number. When everything reads correctly, send them to your desk and approve the one card. The first approved import sets the date your books start from; it cannot be changed afterwards.

## 8. Hiring and trusting agents

![The Hiring hall](../../screenshots/latest/hiring-desktop.png)

In the **Hiring hall**, hire an agent to give it a room and set it to work. Each agent starts as a **Trainee**: everything it proposes waits for you. Its accuracy record shows how often its proposals were right. When you are comfortable, promote it to **Trusted** (routine work goes ahead and is logged) and later **Autonomous**. You can demote or let an agent go at any time.

## 8a. Your assistant

Hire **The Executive Assistant** in the Hiring hall, then open its room (Reception, beside the Office Manager).

- **Your calendar.** In Google Calendar on a computer, open **Settings → Settings for my calendars → your calendar → Integrate calendar**, copy the **Secret address in iCal format** and paste it in the room. The office reads it at once, again when you open the room if it is over an hour old, and every morning. **Stop reading my calendar** forgets it. Outlook and Apple calendars give a similar private link.
- **Your next three days.** Today in full: meetings with a brief from the books for customers and suppliers, your tasks, what is waiting on your desk, filings due and customers waiting, and a free slot for desk work. Tomorrow and the day after are shown the same way, with headlines only in the morning email.
- **Emails.** Forward an email to the address shown in the room. A reply is drafted for your desk; edit it if you like, then **Send reply**. It goes from the office's address in your name and replies come to you. A bill or invoice is passed to the Accountant. To forward automatically, add the address in Gmail under **Settings → Forwarding and POP/IMAP**; the confirmation code Gmail sends appears in the room; then make a filter that forwards the mail you want help with.
- **Tasks.** Add them in the room, or on WhatsApp: "remind me to call Sharma on Friday", "done call Sharma". Send "agenda" on WhatsApp to see today again.
- **Privacy.** Only you see your calendar, emails, tasks and drafts. Other owners and the accountant do not.

## 8b. Online sales

Hire **The Marketplace Manager** in the Hiring hall. Its room shows the address for sales reports.

- **Sending reports.** Email them to the address in the room, set a Gmail filter that forwards the platforms' report emails there, send them to the office on WhatsApp, or press **Upload a report**. CSV, XLSX and zip files are read. If a platform sends only a link to its portal, download the file and forward it.
- **Which reports.** Amazon: the tax report (MTR, B2C and B2B) from the Tax Document Library, settlement reports, and the transaction (date range) report from Payments → Reports. Send either the tax report or the transaction report for a month, not both: the same orders in each are not matched, so they would be counted twice. Flipkart: the Sales Report. Meesho: the GST sales and returns reports. Myntra: the monthly P&L report from the Partner Portal; it has no orders, so Myntra shows sales and units but no order count or average order. Blinkit, Zepto, Instamart and others: any sales sheet they send.
- **A new layout.** The first time a sheet in a new layout arrives, the room (and your desk) asks which column is the date, the order, the quantity and the amount. Choose them once and press **Read it this way**; files in the same layout are read on their own after that.
- **Reports.** **Boardroom → Sales → Online sales** shows the last 30 days the reports cover: by channel, week by week, by product with returns, by state and city, and payouts. Products whose returns pass 10% are marked.
- **Removing a report.** **Remove** next to a report in the room takes it out with everything read from it.

## 9. People, WhatsApp and the accountant

- **Invite people** in **Settings → Office**: enter their email address and choose **Owner** (everything, including approvals and hiring) or **Accountant** (reads everything and downloads returns, but cannot approve or hire). The invitation works once, for 14 days, and only for that address. You can withdraw a pending invitation, and hand ownership to someone else; an office always keeps at least one owner.
- **WhatsApp** in **Settings → WhatsApp**: link your phone with the six-digit code, choose your language and whether you want the morning digest. Then reply "approve 1 3" or "reject 2" to the list you receive, or ask a question by text or voice.
- **Your accountant** sees a banner showing their role. The Compliance Officer opens on the CA view for them: the filings as a working table, the papers to download, and the trail of every change.

## 10. How the office looks

Choose a look in **Settings → Your office** or with **Skin** under the floor. It is personal: only you see it, on any computer you sign in on.

- **Blueprint, Open plan, Cubicles, Counting house, Loft, Night shift**: the floor as an architect's plan, in different styles.
- **Lived-in**: the office as a 3D pop-up book, lit by the sun where you are, with the team named and at work. You can rename the team for your office in Settings. On a phone it shows the plain floor with the names on the doors. If it is slow on your computer, tick **Use the simpler picture**. Add `?at=18:30` to the address to see the office at that time of day, for a demonstration.

## 11. Your own account and your data

In **Settings → Your account** you can download a copy of your account data or ask for your account to be deleted. An owner can export the whole office as a zip (books and every file) and delete it in **Settings → Office**; a deleted office can be restored for 30 days.

# How the work flows

> **In one paragraph.** A diagram for each agent, for owners: what starts its work, what it does, what reaches your Desk and what happens when you approve or reject. Each diagram shows what the office does today. Where an agent's job description goes further than what is built, the diagram says so in its "Not yet" line, so nothing here is a promise.

**Reading the diagrams.** An agent's diagram always has the same four columns: **what starts it**, **what it does**, **on your Desk** and **what happens next**. Blue boxes are cards on your Desk. Green boxes are results: posted, sent, filed or reported. Brown boxes are work set aside or rejected. A dashed box means nothing happens there. The tag at the top right says how much of the agent is built:
- **Works today:** it reads, drafts and acts as shown.
- **Partly built:** most of it works; the "Not yet" line says what does not.
- **Reports only:** it shows figures from your books but drafts nothing for you yet.

## 1. How work moves through your office

![How work moves through your office](diagrams/flow-overview.svg)

Everything that comes in goes to the agent for that job: your office's own email addresses (each is shown in the agent's room), an upload, WhatsApp, your social media accounts, or the morning round. The agent checks it against your books and drafts what should happen. Every amount and tax figure is worked out by code, never by AI. You decide on your Desk, on the web or by number on WhatsApp. Only work you have allowed by trust level goes ahead without you, and a document from someone not in your books never posts on its own.

## 2. Trust levels

![Trust levels](diagrams/flow-trust.svg)

Every agent you hire starts as a Trainee. Each decision you make is counted, and only an approval without changes counts as correct. When the record is good enough, the agent's room offers a promotion. Nothing promotes itself: the level is yours to set in the agent's room, up or down, at any time. Some work always waits for you, whatever the level.

## 3. The morning round

![The morning round](diagrams/flow-morning.svg)

Once a day, at the digest time (08:45 unless you change it in **Settings**), each hired agent does its morning work in the order shown, and then the digest goes to each owner. A routine whose agent is not hired is skipped. Each routine can also be run or paused from its agent's room, and **Routines** lists them all with their last runs.

## 4. Front office

### The Office Manager

![The Office Manager](diagrams/flow-office-manager.svg)

Ask in your own words, on any page or on WhatsApp. The answer comes from your books, and every figure in it opens the documents behind it. Each morning it lets your Trusted agents finish their routine work and sends you the digest.

### Customer Service

![Customer Service](diagrams/flow-customer-service.svg)

It answers your customers on your own WhatsApp number, by email and in the website chat, from the answers you saved and your records: orders, balances and business facts. Anything sensitive or unclear comes to you as a hand-off, and the customer is told someone will reply. While it is a Trainee, every reply waits for you.

### The Executive Assistant

![The Executive Assistant](diagrams/flow-executive-assistant.svg)

Each owner has their own. It reads your calendar from its private link, plans your next three days and drafts replies to the emails you forward. Every reply waits for you, and only you see your calendar, emails, tasks and drafts.

## 5. Accounts

### The Accountant: bills and invoices

![The Accountant](diagrams/flow-accountant.svg)

Send bills and invoices by email, upload them, or forward them through your assistant. Each page is read, checked line by line and set against your books. A duplicate is set aside without asking, and a proforma, delivery note or credit note is filed for the record rather than posted. Everything else waits on your Desk with its checks, unless the Accountant is Trusted and the document is routine.

### The Accountant: bringing in your books

![Bringing in your books](diagrams/flow-onboarding.svg)

When you start, bring in your customers and suppliers, products and stock, and what was unpaid before your start date, using the three CSV templates. The files are checked row by row first; nothing comes in until you approve the one card on your Desk.

### The Credit Controller

![The Credit Controller](diagrams/flow-credit-controller.svg)

It works out who is overdue from your posted invoices and drafts a reminder of the right tone for each customer. Edit the letter if you like; when you approve, it is emailed in your business's name and replies come to you.

### The Tax Clerk

![The Tax Clerk](diagrams/flow-tax-clerk.svg)

GST and TDS are worked out from your posted books by fixed rules, and the return files are ready to download for you or your accountant to file.

### The Auditor

![The Auditor](diagrams/flow-auditor.svg)

Bring in a return as it was filed, or the GSTR-2B statement, and the Auditor compares it with your books. Each difference waits on your Desk, with its working, for you or your accountant.

## 6. Sales

### The Marketplace Manager

![The Marketplace Manager](diagrams/flow-marketplace-manager.svg)

Send it the reports Amazon, Flipkart, Meesho, Myntra and the quick-commerce apps already send you. A layout it knows is read straight away; a new one is confirmed by you once and read on its own after that. It shows sales by channel, product, state and city, with returns and payouts. It does not change your books yet.

### The Sales Rep

![The Sales Rep](diagrams/flow-sales-rep.svg)

### The Quote Desk

![The Quote Desk](diagrams/flow-quote-desk.svg)

### The Account Manager

![The Account Manager](diagrams/flow-account-manager.svg)

These three show reports from your books today. The Sales Rep keeps the pipeline of leads that come in from social media and WhatsApp, the Quote Desk lists your quotations, and the Account Manager shows which customers are due or late to reorder.

## 7. Marketing

### The Marketer

![The Marketer](diagrams/flow-marketer.svg)

### The Market Watcher

![The Market Watcher](diagrams/flow-market-watcher.svg)

Both show reports today: the Marketer finds slow-moving stock and lists your campaigns and the dates ahead, and the Market Watcher compares your prices with competitor prices held in the office. Slow stock and campaigns also become topics in the Social Media Manager's calendar.

## 8. Social media

### The Social Media Manager: messages and reviews

![The Social Media Manager: messages and reviews](diagrams/flow-social-messages.svg)

Every comment, review and message on your connected accounts is sorted. An enquiry also becomes a lead for the Sales Rep. Each reply is drafted in your brand's voice with any price checked against your books, and waits for you, except thank-yous to good reviews once the agent is Trusted.

### The Social Media Manager: calendar and posts

![The Social Media Manager: calendar and posts](diagrams/flow-social-posts.svg)

Next month's calendar is drafted from the 25th. Approve the calendar, then each post. At its time every post is checked again, and one that changed or fails a check comes back to you instead of going out.

## 9. Operations

### The Storekeeper

![The Storekeeper](diagrams/flow-storekeeper.svg)

Each morning it finds items at or under their reorder level and drafts one purchase order per supplier from the last bills. Approving marks the order sent in the books; send it to the supplier yourself for now. Rejecting cancels the draft, and the item is drafted again from the next day if it is still low.

### The Buyer

![The Buyer](diagrams/flow-buyer.svg)

### The Compliance Officer

![The Compliance Officer](diagrams/flow-compliance-officer.svg)

It keeps your company's filing calendar from its profile and reminds whoever files each item, you or your CA or CS, at 7 days, 2 days and on the day. It also checks the books for MSME suppliers to pay and advance tax to set aside. Once you agree, the Credit Controller's cash plan pays those suppliers by their legal limit, or sets the advance tax aside for its date.

## 10. People

### The Payroll Clerk

![The Payroll Clerk](diagrams/flow-payroll-clerk.svg)

# Platform console

> **In one paragraph.** The console at https://console.office.snilld.in is for the people who run the platform. It lists every business on the platform and lets a platform owner open an office for a new business, send or re-send the owner's invitation, and suspend or reopen an office. It shows accounts, not books: no office's books, files or conversations can be seen or reached from it.

## 1. Who can use it

Only the addresses in the Worker secret `PLATFORM_OWNER_EMAILS`, signed in with a confirmed address and two-step sign-in. Anyone else is refused, and with the secret unset everyone is. The list is a secret so that who runs the platform is not in the public repository. To add someone, add their address to `PLATFORM_OWNER_EMAILS` in Infisical and run `sh tools/admin/set-secrets.sh live`; no deploy is needed.

## 2. What it shows

For each business: name, owners, how many people, status (active, suspended, deleting), when and how it was opened (signed up, or onboarded by whom), its email-in address and web address, any pending owner invitation, and the date of its last account change.

## 3. Opening an office for a new business

1. Enter the business name and the owner's email address.
2. Press **Open the office and invite**. An empty office is created and the owner is emailed a 14-day invitation from `support@snilldai.com`. The link is also shown on screen with **Copy the link**, in case the email goes astray.
3. The owner makes an account with that address and lands in the office. Add more owners or the accountant from the office's own **Settings → Office**, or a second owner from the console.

## 4. Other actions

- **Send the invitation again** when an owner has not received it or it has expired.
- **Suspend** closes an office to its people (they see that it is suspended); **Open** reopens it.
- Every console action is written to that office's audit trail under the platform owner's address.

# Support manual

> **In one paragraph.** This part is for whoever answers support questions and keeps the platform running. It starts with how to tell what is wrong, lists the questions people actually ask with their fixes, then gives the procedures: the admin tool, read-only database queries, deploying and rolling back, backups, monitoring and security incidents. Every command that needs a Cloudflare token runs through Infisical; nothing is put in a file.

## 1. First steps for any problem

1. **Is the site up?** Open https://app.office.snilld.in. The sign-in page should load.
2. **Is sign-in working?** Signing in with a made-up address should say "Invalid email or password". Any other error points at the Worker or the database.
3. **Is it one person or everyone?** One person: their account, membership or invitation (sections 2 and 4). Everyone: the latest deploy (section 6) or Cloudflare's status page.
4. **Is the data there?** Read the control plane (section 5). It shows every office, person, membership and invitation.
5. **Write down** what was found and done (section 9).

## 2. Common questions

| What the person says | Likely cause | What to do |
| --- | --- | --- |
| "The invitation link does not work" | Invitation links work once and for 14 days. A used or expired link opens on Sign in with a note | If they have joined, they sign in at the app. If not, the owner sends a new invitation from **Settings → Office**, or a platform owner re-sends from the console |
| "It says the account already exists" | They tried to make a second account with an address that has one | Choose **Sign in**; the page switches there itself and keeps what was typed |
| "I forgot my password" | | **Forgotten your password?** on the sign-in page; the link works once, for an hour |
| "No email arrived" (invitation, confirmation, reset) | Spam folder; mistyped address; sending not set up | Check spam for `support@snilldai.com`. Check the address in the console. Check `RESEND_API_KEY` is on the Worker |
| "I cannot see my office" | Not a member, or suspended | Read memberships (section 5). Suspended offices are reopened from the console |
| "This invitation is for another address" | Signed in with a different email from the one invited | Sign out and sign in with the invited address, or the owner invites the address they use |
| "I emailed a bill and nothing happened" | Wrong address; more than 5 attachments; not a PDF or image; it was a duplicate | Use the address in **Settings → Office**. Emailed documents are read when someone in the office next has the app open |
| "It says the daily allowance is used" | 400 AI calls or 250 MB of uploads in a day for the office | It resets the next day; upload text PDFs rather than scans where possible |
| "My import is refused" | A row needs fixing | The check names the row and column, for example a GSTIN whose check digit is wrong; fix and check again |
| "The 3D office is slow or blank" | Older computer or graphics, data saver, or WebGL off | Tick **Use the simpler picture** in Settings; phones always get the plain floor |
| "Empty rooms show on the floor" | **Show the whole floor** is on | Choose **Show only staffed rooms** under the floor |
| "My calendar does not show in the assistant" | The link is not the secret address, or a Google Workspace admin has turned secret addresses off | Copy the **Secret address in iCal format** again (not the public address). For Workspace, the admin turns on external sharing of calendars, or the owner waits for the Google connection |
| "Forwarded emails do not arrive at the assistant" | Forwarded from an address that is not an owner's; the assistant is not hired; Gmail forwarding not confirmed | Forward from the address the owner signs in with. Hire the assistant. Enter Gmail's code, shown in the assistant's room |
| "A sales report did not appear" | Sent from an address outside the office and the platforms; a portal link rather than a file; an old .xls file; the same file sent before | Forward it from your own address. Download linked reports and attach them. Save .xls as .xlsx or CSV. The room's **Reports received** list says what happened to each file |
| "Online sales look doubled" | Two reports covering the same days | Lines already received are not counted twice; if a different layout of the same sales was confirmed as another channel, remove one report in the room |
| "The weather is missing" | The weather lookup failed or the location is unknown | Nothing to fix; the sun uses the GST state's capital instead |

## 3. The admin tool

Run from the repository root:

```sh
infisical run --env=dev --silent -- node tools/admin/admin.mjs <command>
```

| Command | What it does |
| --- | --- |
| `list` | Every office: status, people, routes, history, last activity |
| `suspend <office>` / `resume <office>` | Closes an office to its people, or opens it again |
| `invite-owner <office> <email>` | A new owner invitation link (printed, not emailed), for an office that has lost its owner |
| `route <office> <kind> <external id>` | Sends a social page, account or WhatsApp number (kind `wa_phone`) to an office |
| `purge-soon <office>` | A deleted office is purged at the next nightly run instead of after 30 days |
| `backup` | Writes the control plane as SQL into `backups/` (git-ignored; holds account data) |
| `forget-user <email>` | Removes a person's account, sessions, memberships, WhatsApp link and consent records; refuses if they are the only owner of an office |
| `requests` / `requests done <id>` | Lists deletion requests left open from before people could delete their own accounts in Settings, or completes one (check weekly; complete within 30 days) |
| `subdomain <office> <label>` | Gives an office its own address in two runs: the first adds it to `wrangler.jsonc` (commit and deploy), the second switches the office over |
| `subdomain <office> --remove` | Takes the address away (commit and deploy afterwards) |

Add `--local` to work on the local development database.

## 4. Invitations and access, step by step

- **A person cannot get in.** Look them up (section 5): does the account exist, is the address confirmed, are they a member of the office? If they are a member, they sign in at the app. If they are not, the owner invites them.
- **An office has lost its owner.** `admin.mjs invite-owner <office> <email>` prints a fresh owner link to send them.
- **Which invitation is a link?** Each link's token is stored only as a SHA-256 hash (base64url). Hash the token from the link and look it up in the `invitation` table's `token_hash` column; `accepted_at` shows whether and when it was used.

## 5. Reading the live database (read only)

Use a small script so the token stays in Infisical. From `apps/api`:

```sh
cat > "$TMPDIR/d1q.sh" <<'EOF'
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE"
exec ./node_modules/.bin/wrangler d1 execute office --remote --json --command "$1"
EOF
infisical run --env=dev --silent -- sh "$TMPDIR/d1q.sh" "SELECT name, slug, status FROM office"
```

Useful questions:

| Question | Query |
| --- | --- |
| Which offices exist? | `SELECT id, name, slug, status, datetime(created_at/1000,'unixepoch') FROM office` |
| Who has an account? | `SELECT email, email_verified, datetime(created_at,'unixepoch') FROM user` |
| Who belongs where? | `SELECT o.name, u.email, m.role FROM membership m JOIN user u ON u.id = m.user_id JOIN office o ON o.id = m.office_id` |
| Which invitations are open or used? | `SELECT o.name, i.email, i.role, datetime(i.expires_at/1000,'unixepoch'), i.accepted_at FROM invitation i JOIN office o ON o.id = i.office_id` |

Only ever run `SELECT` this way. Changes go through the app, the console or the admin tool, so they are audited. A business's books are not in D1 and cannot be read from here.

## 6. Releasing, and rolling back

1. **Check.** `pnpm test` and `pnpm typecheck` (or the per-package commands), and the end-to-end check where possible.
2. **Staging.** Every push to `main` whose checks pass is deployed to staging by the Deploy workflow in GitHub Actions, and checked there with `tools/admin/smoke.sh`.
3. **Deploy live.** Actions → Deploy → Run workflow, on `main`; a reviewer approves the `live` environment. The workflow runs `tools/admin/deploy.sh live`: it builds the app, backs up the database (and stops if that fails), applies any new database migrations, and deploys the Worker. Migrations only ever add (handbook, Deployment, section 7).
4. **Deploy the demo** when the app's screens changed: an owner runs `infisical run --env=prod --silent -- sh tools/admin/deploy.sh demo` (it rebuilds the live app afterwards, so the two builds never mix).
5. **Smoke check.** The workflow's own checks pass on app, console and the product page; the sign-in page loads; a made-up sign-in answers "Invalid email or password"; `admin.mjs list` shows the offices.

**Rolling back.** Every deploy is a version. Run `wrangler rollback` for the Worker through Infisical with the token, or redeploy the previous commit. The database is not rolled back by this: D1 Time Travel restores it to a point in time within 7 days on the free plan (30 on the paid plan), and should be needed only after a bad migration.

## 7. Backups

| What | Protection | Restore |
| --- | --- | --- |
| Worker code | A version per deploy; the source in GitHub | `wrangler rollback`, or redeploy |
| Control plane (D1) | `admin.mjs backup` before each migration; 30 days of D1 Time Travel | D1 Time Travel to a timestamp |
| Each office's books | Cloudflare's durable storage; the owner's export; deleted offices restorable for 30 days; books kept eight years under `retained/` | Restore from Settings or the admin tool |
| Daily copy in India (rule 3(5) of the Companies (Accounts) Rules) | Once the `INDIA_BACKUP_*` settings are made, each office writes a daily copy to a bucket in an Indian region | Settings → **Books record** shows the last copy |

## 8. Monitoring

- **Live logs:** `wrangler tail the-office` through Infisical shows requests and errors as they happen. Each line is one structured event with its `requestId` (the `x-request-id` on the response) and, inside an office, its `officeId`.
- **History:** Workers Logs in the Cloudflare dashboard (Snilld account → Workers → `the-office` → Observability), kept 3 days. The saved queries and the alerts to set up are in the handbook, deployment section 9.
- **Gap:** logs are kept only briefly. Exporting them to long-term storage (for example Logpush to R2) is an open item before wider pilots; the data protection rules expect a year.

## 9. Security incidents

1. **Contain.** Suspend the affected office, revoke or rotate keys through Infisical (`BETTER_AUTH_SECRET` signs everyone out; `SOCIAL_TOKEN_KEY` covers platform tokens), and tell the founder the same day.
2. **Record.** What happened, when it was found, which offices and people, what data, what was done. Keep the record even if nothing is notifiable.
3. **Tell the businesses** within 24 hours of confirming it, as the data processing terms promise.
4. **Tell the Data Protection Board and the people affected** as the Digital Personal Data Protection Rules require; confirm current timelines with the lawyer.
5. **Afterwards:** write down the cause and the fix, and add a test or check so it cannot happen the same way again.

## 10. When to escalate

Escalate to engineering when sign-in fails for everyone, when a deploy's smoke check fails, when any office can see another's data, when the database answers errors to `SELECT` queries, or when the Worker logs show the same error repeating. Escalate to the founder for anything involving personal data leaving its office, legal requests, or deleting an office or account on someone's behalf.

# Configuration

> **In one paragraph.** The Worker's resources and plain settings are declared in `apps/api/wrangler.jsonc`; keys and tokens are Worker secrets put from Infisical. This part lists what is set today. Values of secrets are never written down; only their names.

## 1. Resources

| Binding | Resource | Used for |
| --- | --- | --- |
| `ASSETS` | `apps/web/dist` | The app's files; `/api/*`, `/media/*` and `/w/*` reach the Worker first |
| `DB` | D1 database `office` | The control plane |
| `DOCS` | R2 bucket `office-docs` | Documents and media |
| `AI` | Workers AI | Reading documents, voice notes, translation |
| `Office` | Durable Object class `Office` (SQLite) | One per business |
| `MAILER` | Send Email | Fallback sender when Resend is not configured |
| `CHAT_LIMIT` | Rate limit, 20 a minute | Website chat |

## 2. Settings (live values)

| Name | Value | Meaning |
| --- | --- | --- |
| `DATA_MODE` | `live` | The real Worker |
| `MAIL_FROM` | `support@snilldai.com` | Sender of all mail, through Resend |
| `INGEST_DOMAIN` | `in.office.snilld.in` | Each office's inbound address is `<slug>@` this domain |
| `BETTER_AUTH_URL` | `https://app.office.snilld.in` | Where sign-in, invitation and reset links point |
| `APP_DOMAIN` | `office.snilld.in` | Product page on the bare domain, `app.` and `console.` below it, and offices' own addresses |
| `INDIA_BACKUP_*` | Not set | The bucket for the daily copy of books in India |
| Cron | `30 21 * * *` (03:00 India time) | Purges offices deleted more than 30 days ago |

## 3. Secrets (names only)

| Name | Required for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Sessions (required) |
| `RESEND_API_KEY` | Sending email (required on live) |
| `SOCIAL_TOKEN_KEY` | Social channels, WhatsApp, signed media links |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Facebook and Meta webhooks |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `THREADS_APP_ID`, `THREADS_APP_SECRET` | Instagram, Threads |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE` | The shared WhatsApp number |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `X_CLIENT_ID`, `X_CLIENT_SECRET` | LinkedIn, X |
| `TURNSTILE_SECRET` | Optional bot check on website chat |
| `INDIA_BACKUP_ACCESS_KEY_ID`, `INDIA_BACKUP_SECRET_ACCESS_KEY` | The India copy of books |

In Infisical, the deploy token is `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE`. The rule: no `.env` files; every command that needs a secret runs as `infisical run --env=dev -- <command>`.

# Open items and limits

> **In one paragraph.** What is not done yet, or not done fully, so nobody promises it by mistake.

| Item | Status |
| --- | --- |
| Daily copy of companies' books in an Indian region (rule 3(5)) | Code done; the bucket and its settings are not set up, so Settings tells each company its books have no India copy |
| Long-term logs | Not set up; needed before wider pilots |
| Legal review of the privacy notice, terms and data processing terms | Drafts published; a lawyer in India has not reviewed them yet |
| The old Cloudflare account ("the-office-agents") | Its Workers, database and bucket were deleted on 18 Nov 2026; revoke its API token and remove `CLOUDFLARE_API_TOKEN_OFFICE_AGENTS` from Infisical |
| Emailed documents | Read when someone in the office next has the app open, not on the server as they arrive; at most 5 attachments; no spreadsheets or zip files by email |
| Several GST registrations, credit notes, stock movements, e-commerce settlements | Partly built (other registrations recognised on invoices); fuller support planned |
| Tally | Parties and open items come in through the CSV templates; no direct Tally import or export yet |
| Agents that do less than their job description | Shown in each agent's "Not yet" line in **How the work flows**. Reports only today: the Sales Rep, Quote Desk, Account Manager, Marketer, Market Watcher, Buyer, Tax Clerk and Payroll Clerk draft nothing. Not yet anywhere: matching bank receipts, sending files to the accountant, contacting anyone about an audit finding, emailing purchase orders to suppliers, and stock moving with sales and bills |
| Filing on government portals | Out of scope by design: the office prepares, the owner or CA files |
| The Lived-in office | Not shown on phones by design; needs WebGL 2 |
| Online sales | Reports only: nothing is posted to the books yet. Next: one sales entry per channel, month, state and rate with GST (e-commerce operator supplies in GSTR-1), credit notes for returns, settlements matched to payouts with fees, TCS and 194-O TDS, and stock reduced by sales. Blinkit, Zepto and Instamart layouts are confirmed by the owner until real samples are added; no platform APIs |
| The Executive Assistant | Calendar by private link and email by forwarding only; the Google connection (reading Gmail threads, saving drafts in Gmail, creating calendar events) is the next phase and needs Google's app review, and a security assessment for Gmail. Monday's week plan and "Ask the office manager" about the agenda are not built yet |

# Glossary

| Term | Meaning |
| --- | --- |
| Office | One business's space in the product: its books, people, agents and files |
| Owner | A person with full control of an office, including approvals and hiring |
| Accountant (role) | A person who reads everything and downloads returns, but cannot approve or hire |
| Agent | An AI team member with a job, such as the Accountant or the Credit Controller |
| Desk card, staged change | A proposal waiting for the owner's decision |
| Trust level | Trainee, Trusted or Autonomous: how much an agent may do without asking |
| Team log | The running list of what the team did today |
| Routine | Work the office does on a schedule, such as the morning digest or reminders |
| Control plane | The shared database of accounts, memberships and routes; it holds no books |
| Durable Object | Cloudflare's private, single-writer store; one per office holds its books |
| Slug | The short name in an office's email address, for example `neltrade-v9sc` |
| Platform owner | One of our team allowed into the platform console |
| Lived-in | The look that shows the office as a 3D pop-up book with the team at work |
| Bahi-khata | The traditional red cloth-bound Indian account book the Lived-in office opens from |

# Where to find more

| Document | What it covers |
| --- | --- |
| `docs/handbook` (built as `docs/handbook/the-office-handbook.html` with `pnpm docs`) | Business requirements, product requirements, architecture, deployment options and costs, configuration, roadmap, customer service |
| `docs/runbooks/phase-6-go-live.md` | Step-by-step go-live: the move to the Snilld account, email, addresses, release, onboarding, the exit test, deleting the old account |
| `docs/legal` | Terms, privacy notice, data processing terms, subprocessors, the customer AI notice |
| `docs/design-plan.md` | The visual system: palette, type, the floor plan |
| `tools/admin/admin.mjs` | The admin tool's own help, at the top of the file |
| `apps/api/wrangler.jsonc` | The live configuration, with comments |
