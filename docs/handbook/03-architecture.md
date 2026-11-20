# Technical architecture

> **In one paragraph.** The Office is one Cloudflare Worker serving a React app and an API, plus one Durable Object per business that holds that business's books in its own private SQLite database and is their only writer. A small shared D1 database (the control plane) knows only who belongs to which office and where inbound mail and webhooks go. Files sit in R2 under a prefix per office. Documents are read with open-weight models on Workers AI, but every amount and every tax figure is computed by deterministic, unit-tested code. The same React app runs as a clickable demo with no backend at all, answering the real API routes from sample data inside the browser.

![System context](diagrams/system-context.svg)

## 1. Codebase

A pnpm monorepo in TypeScript.

| Package | What it holds | Key libraries (licence) |
| --- | --- | --- |
| `apps/web` | The React app: Floor, Boardroom, Desk, rooms, Hiring Hall, Settings, office picker | React 19, Vite, TanStack Router, Query and Table (MIT), MSW for the demo (MIT), pdf.js for reading text layers in the browser (Apache-2.0) |
| `apps/api` | The Worker: routing, sign-in, the control plane, inbound email and webhooks, the `Office` Durable Object | Hono (MIT), Cloudflare Agents SDK (MIT), better-auth (MIT), Drizzle ORM (Apache-2.0) |
| `packages/contracts` | Every entity and API response as a zod schema, plus the route table | zod (MIT) |
| `packages/engine` | The books and the agents as pure TypeScript: ledger, GST, TDS, ageing, audit, reports, social, WhatsApp desk, Excel exports | ExcelJS (MIT) |
| `packages/fixtures` | The Kaveri Electricals sample business | |
| `packages/ui` | Shared components with Storybook stories: floor plan, ledger table, source viewer, approval card | Storybook (MIT) |
| `tools` | Synthetic data, screenshots, end-to-end checks, export verification, the admin tool | Python reportlab (BSD), Playwright (Apache-2.0) |

**One contract.** The web app, the demo's mock handlers, the Worker and the engine import the same zod types, so the demo cannot drift from the real product. Switching between them is a build flag (`VITE_DATA=mock` or `live`).

**Tests.** 426 engine tests (tax, ageing, audit, social, WhatsApp desk, customer service, routines, imports), 208 Worker tests (including a two-office isolation suite, sign-in and two-step sign-in, inbound mail, security headers, the website chat, the export archive and account rights), 14 tests that run the office Durable Object inside workerd (`apps/api/test/do/`, among them a 57 MB export), 5 web app tests, and Storybook stories for every component state. GitHub Actions runs the type check and every test on each pull request. The browser end-to-end script (`tools/e2e/live.mjs`) predates two-step sign-in and needs updating.

## 2. Runtime

| Piece | Role | Why this choice |
| --- | --- | --- |
| Worker (Hono) | Serves the app, signs people in, checks membership, routes each request to its office, receives email and webhooks, runs the nightly purge | Global edge, no servers, free tier |
| `Office` Durable Object | One per business. Holds the books in SQLite, runs the agents, schedules its own alarms (daily digest, social publishing), pushes live updates over a WebSocket | A single writer per business removes a whole class of concurrency and isolation problems |
| D1 | Control plane: accounts, sessions, offices, memberships, invitations, routes, WhatsApp links, audit | Small, shared, relational; holds no books |
| R2 | Original documents and social media images under `o/<officeId>/` | S3-compatible, no egress fees |
| Workers AI | Reading documents (Llama 3.3 70B for text layers, Llama 3.2 11B Vision for scans), Whisper for voice notes, translation for WhatsApp | Open-weight models, no API key, a free daily allowance |
| Email | Email Routing delivers inbound mail to the Worker; the `send_email` binding sends reminders, invitations and digests | No third-party mail service |

**On the Workers free plan.** The product runs on Cloudflare's free plan: about 10 ms of CPU and 128 MB of memory for each Worker request, 100,000 Worker requests and 100,000 Durable Object requests a day, and 30 s of CPU for each request to a Durable Object. So the Worker does no heavy work itself, and nothing asks the backend on a timer when it can be told instead:

- **Export.** The office's Durable Object writes the archive (`apps/api/src/export.ts`, `zip.ts`). It lists only the office's own keys under `o/<officeId>/`, keeps the books as they are, and streams a stored (uncompressed) ZIP: each file's bytes go out as R2 hands them over, its CRC-32 worked out on the way, then a data descriptor, so neither side holds a whole file or the archive. One request to the office reads at most 250 files, to stay inside what one invocation may ask of R2, so a big export comes in parts; the Worker pipes the parts into one download without running code for each chunk. Writing 200 MB (the cap, as before) costs the Durable Object about 0.6 s of CPU. The archive holds `books.json` and `files/...`, as before.
- **Live updates.** Every open tab keeps one WebSocket to its office, which hibernates while quiet. The office says `{"type":"changed"}` after every saved change, and adds `"unread":true` when an emailed document arrived for a browser to read. A tab asks for unread documents when told so, when the socket opens again and when the person comes back to the tab; only while its socket is down does it ask on its own, every 10 minutes, and refetch its screens once a minute.
- **Website chat.** The widget asks for replies every 5 s while the visitor waits for an answer (up to two minutes after they wrote), every 30 s otherwise and every minute while the page is out of view.

## 3. How a request finds its office

Every office API lives under `/api/o/:officeId/`. Account-level routes (`/api/me`, `/api/offices`, `/api/invitations/...`, `/api/auth/...`) do not.

![Request path](diagrams/request-path.svg)

1. **Session.** better-auth checks the session cookie against D1. No session: 401.
2. **Membership.** The office id must have the right format and the person must have a membership row. Anything else: 404, identical to an office that does not exist. Suspended offices answer 423; offices being deleted answer 404 except to their owner's restore and export.
3. **To the office.** The Worker forwards to the Durable Object named after the office id and sets the caller (person, role, office) itself. Headers from the browser that could claim a role are discarded.
4. **The office checks again.** The Durable Object knows its own id (stored on first start) and refuses any caller whose office does not match. Even a bug in the Worker could not hand one office's books to another.

The WebSocket for live updates follows the same path.

## 4. Inbound routing

Some traffic arrives without a signed-in person: email, platform webhooks, OAuth callbacks and WhatsApp messages. Each is resolved to exactly one office, or dropped.

![Inbound routing](diagrams/inbound-routing.svg)

| Channel | How the office is found |
| --- | --- |
| Email | Each office has `<slug>@INGEST_DOMAIN`. The `route` table maps the address to the office. Unknown addresses are rejected at the SMTP stage. |
| Meta webhooks (Facebook, Instagram, Threads, WhatsApp on an office's own number) | The signature is checked, then each entry is routed by its page or account id. One delivery can be split across several offices. |
| OAuth callbacks (connecting a social account) | The signed `state` names the office and the owner who started it; the callback checks both before storing tokens. |
| Shared WhatsApp number | One number serves every office. The sender's phone is linked to a person by a six-digit JOIN code issued in Settings. A person in several offices gets a heading on each message and can switch with a short command; ambiguous messages ask which office. It is never used to talk to a business's customers. |
| Customer messages | WhatsApp messages from customers to an office's own number go to its Customer Service agent when hired (otherwise to the Social Media Manager, as before). Mail to `<slug>.help@INGEST_DOMAIN` is a `support_email` route. The website chat posts to `/api/chat/<key>`, a `widget` route, after a per-visitor rate limit and an optional Turnstile check; it carries no cookies and answers 404 when the chat is off. |

## 5. Where data lives

![Data placement](diagrams/data-placement.svg)

- **The control plane (D1)** never holds books. It answers "who is this person, which offices are theirs, and where does this email or webhook go".
- **Each office's Durable Object** holds its books in its own SQLite database. There is no shared table of invoices with an `office_id` column to forget in a query.
- **Files (R2)** live under `o/<officeId>/docs/` and `o/<officeId>/media/`. They are served only through the office's own path, or through a signed media link (for the social platforms to fetch images) that names the office.

Besides the books, each office's SQLite database has a few tables of its own:

| Table | Holds | Kept for |
| --- | --- | --- |
| `routine_run` | One row per routine run: routine, trigger (schedule or by hand), start and finish, outcome, a summary, counts and any error | 90 days |
| `cs_thread` | One row per customer conversation: channel, the customer's key on it (phone, email address or visitor id), name, the matched party and whether identity was confirmed, status, hand-offs, time to first reply | The office's retention period (12 months by default), then deleted with its messages |
| `cs_message` | Each message in and out: who wrote it (customer, agent or a named person), the intent and what grounded the reply, sending status, the platform's message id for de-duplication | As its conversation |

The control plane adds two tables for each person's own rights (migration `0003_legal.sql`): `consent` (which version of which document a person accepted, when, and from which country) and `rights_request` (account deletions: since November 2026 one done row per deletion with no name or address; older rows are requests an operator completed). Neither holds books. Migration `0008_backup_erasure.sql` adds `backup_erasure`: purged offices whose daily copies in India are still to be deleted.

## 6. Security model

| Concern | Control |
| --- | --- |
| Sign-in | better-auth with email and password, email confirmation before opening an office or accepting an invitation; sign-up answers the same for new and existing addresses; rate limits counted in D1 per `cf-connecting-ip` |
| Two-step sign-in | TOTP with ten backup codes, required for office owners and platform owners before any owner action or console change |
| Sessions | End after 12 idle hours; export, invites, role changes, hand-over, deletion, member removal and console changes need a sign-in or step-up within 15 minutes |
| Passwords | PBKDF2-SHA256 chained in rounds Cloudflare accepts; 100,000 iterations on the Workers free plan, upgraded at each sign-in when raised |
| Tenant isolation | Membership check in the Worker; the caller header set by the Worker and sealed with an HMAC; the Durable Object accepts only a sealed caller for its own id, and `/internal/*` only the system caller; per-office storage; per-office file prefix |
| Browser | Strict Content-Security-Policy, HSTS, no framing, Referrer-Policy and Permissions-Policy on every response; every non-GET `/api` request must come from the app's own origin |
| Stored files | Shown in the browser only as PDF or image, sandboxed; anything else downloads. Ids are random UUIDs. Types come from the file's name and bytes, never the sender |
| Inbound email | A sender is trusted only on Cloudflare's own `Authentication-Results` (DMARC, or aligned DKIM); unproven mail waits on the desk; limits and the upload allowance are checked before anything is stored |
| Live connection | The WebSocket says nothing before the caller check, takes no messages from browsers (it carries only `changed`, with `unread` when a document arrived), and closes when someone is removed or the office is suspended |
| Failed requests | A request that fails partway reopens the books as last saved |
| Invitations | Single-use token, only its hash stored, bound to the invited address, expires after 14 days; the token travels after `#` and in request bodies, never in a logged URL. The console invites an owner only into an office with no owner and never sees the link |
| Social and WhatsApp tokens | Encrypted at rest with a key derived per office (HKDF from `SOCIAL_TOKEN_KEY` and the office id), with a key version for rotation |
| Webhooks | Meta signatures verified with the app secret; the verify token checked on the handshake |
| Media links | HMAC-signed, expiring, scoped to one office |
| Fair use | Per-office daily allowance: 400 AI calls (at most 150 for customer service), 250 MB of uploads; a 429 with a plain explanation when spent |
| Public website chat | No cookies or credentials; rate-limited per widget and visitor IP, polling included; Turnstile required on live; at most 300 new conversations an office a day; orders and balances only after a one-time code to the contact on the order; message length capped; a disabled chat is indistinguishable from none |
| WhatsApp linking | JOIN codes of 8 unambiguous characters, limited per number and across all numbers; each link is audited and shown in Settings |
| Secrets | Held in Infisical and put as Worker secrets; never in files or logs |
| Audit | Office events (invitations, role changes, handover, deletion, restore) in the `audit` table; agent work in each office's team log |
| Operator access | The admin tool works on the control plane only; it has no command to read an office's books |

The security review of November 2026, what it fixed and what is still open: [`docs/security/README.md`](../security/README.md). The [threat model](../security/threat-model.md) sets out each flow's threats and the control that answers each; the [ASVS 4.0.3 Level 2 checklist](../security/asvs.md) gives each requirement's status and evidence. The decisions behind this architecture are recorded in [`docs/adr/`](../adr/README.md).

## 7. Reading documents

1. **Text layer first, in the browser.** Uploaded PDFs are opened with pdf.js and their text layer is extracted on the person's device. This keeps CPU off the Worker.
2. **Model reads the text.** The Worker asks the text model to extract header, lines and tax into a strict JSON shape.
3. **Scans go to the vision model.** Documents without a text layer are rendered to an image and read by the vision model.
4. **Deterministic checks.** The engine recomputes every line and tax amount, checks the result against the stated totals, and detects duplicates.
5. **Staged, never posted.** The result becomes a staged change on the Desk with a link to the document and the highlighted region.

## 8. The engine

`packages/engine` is the heart of the product and has no dependency on Cloudflare. It runs identically in the Durable Object, in the browser demo and in tests.

- Money is integer paise with half-up rounding, mirrored exactly by the Python synthetic-data generator so test data and engine agree to the paisa.
- GST: place of supply, CGST and SGST versus IGST, HSN summary, GSTR-1 and GSTR-3B.
- TDS: sections 194C, 194J, 194Q (with the turnover threshold) and 194H; deposit due dates; 26Q.
- Ageing from invoice payment terms; reminder escalation.
- The Auditor's comparison of filed returns with computed figures, with reasons.
- The social calendar, drafting and price checks; the WhatsApp desk's command parser in eight languages.
- The Customer Service agent's brain: rules first (greetings, order numbers, balance questions, always-human topics such as refunds and complaints), then, only when the rules are unsure, a model call that must answer in a fixed JSON shape choosing among the business's facts and saved answers. Every reply is built from the books, a fact or a saved answer; the model never writes text for the customer. The host (`CustomerDesk` in the Worker) sends what the agent decides on WhatsApp or email and records the result.
- Routines: each scheduled step is wrapped so its outcome, counts and errors are recorded, a paused routine is skipped, and one failing routine does not stop the others.

## 9. The demo (mock mode)

The same production web app is built with `VITE_DATA=mock`. Mock Service Worker answers every real API route inside the browser from the sample books, running the real engine. The demo is used for sales conversations, design reviews and screenshots, and needs no backend.

## 10. Operations

- **Schema changes.** D1 uses numbered SQL migrations. Each Durable Object keeps a `schema_version` and runs its own steps once on start (for example, moving files to the per-office prefix).
- **Nightly job.** A cron at 21:30 UTC purges offices deleted more than 30 days ago (Durable Object storage, R2 prefix, control-plane rows; the books and edit log are first sealed into `retained/`), deletes their daily copies in India, and deletes retained copies whose eight years are over. Each step is in the office's audit trail.
- **Admin tool.** `tools/admin/admin.mjs`: list offices with activity, suspend and resume, send an owner invitation, add a route, purge a deleted office early, back up the control plane, remove a person on request. `tools/admin/open-backup.mjs` opens a sealed copy of an office's books.
- **Logs.** One structured line per event (`apps/api/src/log.ts`), with the request id (Cloudflare's ray id, also on every response as `x-request-id` and passed to the office) and the office id; never a secret or a person's data. Workers Logs keeps them 3 days; the queries and alerts are in `04-deployment.md`, section 9.

## 11. International readiness (design only)

Nothing in this section is built. It records where the code assumes India today, and where a market plug-in would go, so that expansion is an addition rather than a rewrite.

### 11.1 Already market-neutral

- Multi-tenancy, sign-in, roles, invitations, export and deletion.
- The source-linked books model, staged changes, the Desk, trust levels and the team log.
- The agent and room structure, the Floor, the Hiring Hall.
- The social channel interface (any platform behind one adapter).
- The WhatsApp desk's command model and the translation mechanism (fixed phrases per language, free text translated).

### 11.2 Where India is assumed today

A read-only audit of the codebase found these assumptions:

| Assumption | Where | Files affected (approx.) | Seam for another market |
| --- | --- | --- | --- |
| India time for "today", digest and cron times | `apps/api/src/time.ts` (`istDate`, `digestCron` fixed at UTC+5:30), several `Asia/Kolkata` formats | 10 | A time zone on the office record; `istDate` becomes `officeDate(office)` |
| Indian number and date formatting | `toLocaleString("en-IN")` across UI and engine copy | 20 | A locale on the office record, passed to one formatting module |
| Rupees and paise | `money.ts` (integer paise, Indian grouping), the ₹ sign in copy | 23 | A currency code on the office; integer minor units already generalise (cents, pence) |
| Indian tax identifiers in the business record | `Business` has `pan`, `gstin`, `tan`, `stateCode` | 19 for GSTIN | A `taxIds` map defined by the jurisdiction pack |
| GST and TDS rules, registers and returns | `gst.ts`, `tds.ts`, `excel.ts`, `audit.ts`, `imports.ts` | 18 for TDS | A jurisdiction pack interface: `taxLines`, `registers`, `returns`, `importFiled`, `filingCalendar` |
| Indian-language phrases and digit scripts | `whatsapp-phrases.ts`, digit normalisation in `whatsapp-desk.ts` | WhatsApp only | Add languages to the phrase table; the mechanism is generic |
| Indian phone formats | Country code 91 in WhatsApp handling and tests | 6 | E.164 throughout; validation per country |
| Festival calendar for the Marketer | Engine copy and fixtures | Few | A market calendar supplied by the pack |
| Sample data | `packages/fixtures`, `tools/synthetic` | All fixtures | One sample business per market for demos |

### 11.3 Seams to add when a market is entered

| Seam | What it would look like |
| --- | --- |
| Jurisdiction pack | A module per country implementing tax lines, registers, return files, filed-return import and the filing calendar. India's GST and TDS become the first pack. |
| Office locale | `country`, `currency`, `locale` and `timeZone` on the office record (`OfficeLocale` in `packages/contracts/src/locale.ts`; India only today), with `officeDate(locale)` for the office's own today. Chosen when the office is opened once a second market exists. |
| Channel adapters | The WhatsApp desk's logic behind a messaging interface, so SMS (for the US) or another channel can carry the same commands. |
| Accounting connectors | A `BusinessBackend` interface (planned since the first design) with readers for Tally (India), QuickBooks and Xero (US, UK, Australia), Sage and DATEV (EU). |
| E-invoicing | An outbound and inbound adapter for Peppol (EU, Australia, UK) and India's IRN, behind the same interface. |
| Data region | A region on the office record, mapped to Cloudflare's jurisdiction options (see the deployment document). |

### 11.4 Cheap habits to keep now

- No new hard-coded currency, locale or time zone: pass them in, even if the only value today is India's.
- Tax logic only inside the engine, never in the Worker or the UI.
- New business fields that are tax identifiers go into a structure that can hold other countries' identifiers.
- New copy avoids India-only idioms in core screens; India-specific wording lives with the India pack.

The existing [design plan](../design-plan.md) records the visual system: palette, type, the floor plan and the review rounds.
