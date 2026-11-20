# Configuration

> **In one paragraph.** Everything The Office needs is declared in `apps/api/wrangler.jsonc` (bindings and plain settings) and in Worker secrets (keys and tokens). Secrets are kept in Infisical and put into Cloudflare from there; they never appear in files, chat or logs, and this document names them without values. Social channels and WhatsApp are optional: an office without a platform's keys posts by hand and says so in Settings. Two items are needed before inviting real businesses: a real sending address and a real inbound email domain.

## 1. Bindings

| Binding | Type | Resource | Used for |
| --- | --- | --- | --- |
| `ASSETS` | Static assets | `apps/web/dist` | The React app; `/api/*` and `/media/*` go to the Worker first |
| `DB` | D1 | `office` | Control plane: accounts, sessions, offices, memberships, invitations, routes, WhatsApp links, audit |
| `DOCS` | R2 | `office-docs` | Documents and media under `o/<officeId>/` |
| `AI` | Workers AI | | Reading documents, transcribing voice notes, translation |
| `Office` | Durable Object namespace | class `Office` (SQLite) | One per business |
| `MAILER` | Send Email | | Fallback sender when `RESEND_API_KEY` is not set (delivers only to addresses verified on the account); used locally |
| `CHAT_LIMIT` | Rate limit | namespace `1001`, 20 a minute | Website chat messages, counted per widget and visitor IP; over the limit answers 429 |

## 2. Plain settings (`vars` in `wrangler.jsonc`)

| Name | Meaning | Live value today |
| --- | --- | --- |
| `DATA_MODE` | `live` for the real Worker | `live` |
| `MAIL_FROM` | The address mail is sent from | `support@snilldai.com`, sent through Resend (go-live runbook, Part 2); the name shown is the business's |
| `INGEST_DOMAIN` | Each office receives mail at `<slug>@INGEST_DOMAIN` | `in.office.snilld.in` (Email Routing on that subdomain, runbook Part 3) |
| `BETTER_AUTH_URL` | The app, where businesses sign in: sign-in, invitation and confirmation links, and the social sign-in callbacks | `https://app.office.snilld.in` |
| `APP_DOMAIN` | Optional. The bare domain shows the product page, `app.<APP_DOMAIN>` is the app, `console.<APP_DOMAIN>` the platform console, and an office with a subdomain opens on `<subdomain>.<APP_DOMAIN>`; the sign-in cookie covers them all. Without it, everything is on one host (the console at `/?platform`) | `office.snilld.in` |
| `PLATFORM_OWNERS` | Comma-separated addresses that may use the platform console: every business's account, onboarding, suspending. Each signs in with a confirmed address; no one else gets past a 403 | `puja@snilldai.com` |
| `TURNSTILE_SITE_KEY` | Required on live, together with `TURNSTILE_SECRET`. The public Turnstile site key the website chat shows | Not set: on live the website chat answers 503; locally and in the mockups it relies on the rate limit |
| `INDIA_BACKUP_ENDPOINT`, `INDIA_BACKUP_BUCKET`, `INDIA_BACKUP_REGION` | The S3-compatible bucket in an Indian region that holds the daily copy of every office's books (for example an `ap-south-1` endpoint); set with the two `INDIA_BACKUP_*` secrets. See section 4d | Not set (the copy is skipped and Settings says so) |

Local-only settings, passed with `--var` to `wrangler dev`, never set on live:

| Name | Meaning |
| --- | --- |
| `OFFICE_SEED` | `sample` opens new offices with the Kaveri Electricals books |
| `EMAIL_VERIFICATION` | `off` skips email confirmation. Never on live: it would also let sign-up show which addresses have accounts |

The web build reads one flag: `VITE_DATA=mock` builds the demo; anything else builds the live app.

## 3. Secrets

Secrets are kept in Infisical, one environment per place the code runs, and put on each Worker from there with `wrangler secret put`. `sh tools/admin/set-secrets.sh live` (or `staging`) does this for the two required secrets, and puts `RESEND_API_KEY` and `TURNSTILE_SECRET` on the Worker if they are there. On staging it creates a missing required secret; on live it stops instead, because a new `BETTER_AUTH_SECRET` signs everyone out and makes enrolled authenticators unreadable, and a new `SOCIAL_TOKEN_KEY` makes sealed platform tokens unreadable: copy live's values into `prod` first, or pass `--rotate` to make new ones on purpose. Run it yourself, not through an agent.

| Infisical environment | Holds | Who may read it | Used by |
| --- | --- | --- | --- |
| `dev` | Local development only: no value that works on staging or live | Everyone on the project, coding agents included | `wrangler dev`, `api-local` in `.claude/launch.json`, tests |
| `staging` | The staging Worker's secrets (its own `BETTER_AUTH_SECRET` and `SOCIAL_TOKEN_KEY`, and a sending-only `RESEND_API_KEY` so sign-up mail arrives; never live's) and `CLOUDFLARE_API_TOKEN_OFFICE_STAGING` | Engineers; no agent | `set-secrets.sh staging`; `deploy.sh staging` by hand when CI cannot |
| `prod` | The live Worker's secrets and `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE` | The owners only (restrict it in the project's access control; if the plan has no per-environment roles, keep live in an Infisical project of its own) | `set-secrets.sh live`; `deploy.sh live` by hand when CI cannot |

Releases normally go out from GitHub Actions (`.github/workflows/deploy.yml`), which reads only its own GitHub environment's secrets: `CLOUDFLARE_API_TOKEN_OFFICE_STAGING` in the `staging` environment and `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE` in `live`. A deploy needs nothing else: the Worker's own secrets stay on the Worker. Keep each token in exactly two places, its Infisical environment and its GitHub environment, and rotate both together.

Each deploy token is made from Cloudflare's "Edit Cloudflare Workers" template with D1 edit added, limited to one account (and, on live, to the `snilld.in` zone for the custom domains). Staging's token belongs to the staging account when staging has one of its own (`account_id` in `env.staging`), so it cannot reach live at all.

| Name | Required | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions; encrypts two-step sign-in secrets and backup codes; a subkey seals the caller header the Worker sends to each office. Rotating it signs everyone out and makes enrolled authenticators unreadable, so owners enrol again |
| `RESEND_API_KEY` | Yes on live | Sends all mail through Resend from `MAIL_FROM` (the `snilldai.com` domain, shared with Clubs and Sports OS); without it mail falls back to `MAILER` |
| `SOCIAL_TOKEN_KEY` | For channels, WhatsApp, backups and purges | The current root key: per-office keys are derived from it to seal platform tokens and the copies of the books (section 4d); it also signs media links and OAuth state. Rotate it as in section 3a, never by replacing it alone |
| `SOCIAL_TOKEN_KEYS_OLD` | After a rotation | The root keys `SOCIAL_TOKEN_KEY` replaced, comma-separated, newest first. They open what they sealed and seal nothing new |
| `META_APP_ID`, `META_APP_SECRET` | For Facebook and webhooks | The Meta app; the secret verifies webhook signatures |
| `META_VERIFY_TOKEN` | For webhooks | Checked on Meta's webhook handshake |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | For Instagram | Instagram API with Instagram login |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | For Threads | The Threads use case of the Meta app |
| `WHATSAPP_TOKEN` | For WhatsApp | System-user token for the WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | For WhatsApp | The shared business number used by every office |
| `WHATSAPP_TEMPLATE` | For broadcasts | Approved template name for messages outside the 24-hour window |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | For LinkedIn | LinkedIn app |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | For X | X app (OAuth 2.0) |
| `TURNSTILE_SECRET` | Required on live, for the website chat; set together with `TURNSTILE_SITE_KEY` | Verifies the Turnstile token on each chat message. Without it the website chat answers 503 on live; locally and in the mockups it accepts messages within the rate limit |
| `INDIA_BACKUP_ACCESS_KEY_ID`, `INDIA_BACKUP_SECRET_ACCESS_KEY` | For companies' books (rule 3(5)) | A key that may only put objects into the India bucket; signs each upload with AWS Signature Version 4 |

The deploy tokens are passed to wrangler as `CLOUDFLARE_API_TOKEN` at run time by `tools/admin/deploy.sh`. The wrangler login on developer machines belongs to another company's account, so nothing here is deployed with `wrangler login`.

> **Rule:** no `.env` or `.dev.vars` files. Commands that need secrets run as `infisical run --env=<environment> -- <command>`, and a machine a coding agent works on uses only `dev`.

## 3a. Rotating the root key

`SOCIAL_TOKEN_KEY` is a root key: nothing is encrypted with it directly; every office's keys are derived from it (`apps/api/src/keyring.ts`). Each thing sealed with one records the root key's id, a short value derived from the key that reveals nothing about it: platform-token rows, media-link signatures, sign-in states, and the header of every sealed copy of the books. Everything new is sealed with `SOCIAL_TOKEN_KEY`; anything older opens with the key its id names, from `SOCIAL_TOKEN_KEY` or `SOCIAL_TOKEN_KEYS_OLD`. Things sealed before ids existed (before this change) name no key, and every configured key is tried on them.

To rotate on live (staging is the same with `staging`; run it yourself, not through an agent):

1. In Infisical `prod`, set `SOCIAL_TOKEN_KEYS_OLD` to the current `SOCIAL_TOKEN_KEY` value, followed by any keys already listed there, comma-separated.
2. Set `SOCIAL_TOKEN_KEY` to a new value: `openssl rand -hex 32`.
3. `sh tools/admin/set-secrets.sh live`. It puts `SOCIAL_TOKEN_KEYS_OLD` on the Worker before `SOCIAL_TOKEN_KEY`, so at no moment does the Worker lack a key it needs.

After that, platform tokens move to the new key the next time each is read; media links signed with the old key work until they expire (an hour) and sign-in states for ten minutes. Copies in India and copies retained after a purge keep naming the old key, and open as long as it is listed. So an old key stays in `SOCIAL_TOKEN_KEYS_OLD` for as long as anything sealed with it is kept: eight years after the last copy it sealed (section 4d). Remove it only then. If a key is removed too early, opening fails with "Sealed with root key `<id>`, which is not in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD"; put the key back. `tools/admin/open-backup.mjs` reads both secrets the same way.

A rotation protects what is sealed from then on. After a suspected leak of a root key, rotate at once; what the leaked key sealed stays readable to whoever holds it until it is sealed again, which is not automated yet.

## 4. Email

| Item | What to configure | Status |
| --- | --- | --- |
| Sending | Resend, from `support@snilldai.com` (domain already verified there, with SPF, DKIM and DMARC); secret `RESEND_API_KEY`. Message-ID, In-Reply-To and References are set so customer replies thread. Without the key, mail goes through the `send_email` binding, which reaches only addresses verified on the Cloudflare account | Code done; **open until `RESEND_API_KEY` is on the Worker** |
| Receiving | A subdomain for inbound mail (for example `in.<our domain>`), an Email Routing catch-all rule sending to the Worker, and `INGEST_DOMAIN` set to it | **Open** |
| Legacy address | `bills@the-office.example` is routed to the original office; replace when the domain is set | Open |
| Customer service address | Hiring the Customer Service agent claims `<slug>.help@INGEST_DOMAIN` (route kind `support_email`); replies go out through Resend threaded on the customer's message, with Reply-To set to that address | Works once receiving and sending are set up |

## 4a. Website chat and route kinds

The `route` table sends inbound traffic to one office. Its kinds are `email` (bills), `support_email` (customer service mail), `widget` (a website chat key), `wa_phone` (an office's own WhatsApp number), and the social page and account kinds. The Customer Service agent claims and releases its `support_email` and `widget` routes itself when it is hired or the chat is switched on or off; `admin.mjs route` is not needed for them.

The chat snippet a business pastes into its website loads `/w/<key>.js` and talks to `/api/chat/<key>` (open to any site, no cookies). A disabled chat or an agent that is not hired answers 404. Customer service uses at most 150 of the office's 400 daily AI calls (quota `cs_ai`); after that it carries on with its keyword rules alone and hands the owner anything they cannot place.

## 4b. Weather for the Lived-in skin

`GET /api/o/<office>/weather` is answered by the Worker, never the office. It reads the caller's approximate location from Cloudflare (`cf.latitude`, `cf.longitude`, `cf.city`), rounds it to 0.1 degrees, and asks MET Norway's `locationforecast/2.0/compact` API, caching each rounded area for an hour with the Cache API. The request carries the User-Agent `the-office/1.0 (<BETTER_AUTH_URL>; <MAIL_FROM>)`, as MET Norway's terms require an identifying name and contact, so both must be real before go-live. No key or secret is needed. Any failure answers `{ "weather": null }` and the team simply does not mention the weather. MET Norway's data is CC BY 4.0; the credit is shown in Settings beside the skin. Persona names are kept in the office's own storage (`office_kv`, key `personas`).

## 4c. Bringing in existing books

Nothing to configure. The templates are static files at `/templates/parties.csv`, `/templates/products.csv` and `/templates/open-items.csv` (from `apps/web/public/templates/`). `POST /api/o/<office>/onboarding/check` reads the files and changes nothing; `POST /api/o/<office>/onboarding/stage` stores each CSV in R2 under the office's `docs/` prefix and puts one `onboarding` item on the Desk. Both are open to the owner and the accountant; only the owner approves, at any trust level. Limits: 2,000 rows and 1 MB a file, 3 files a request; the staged item must fit in about 1.5 MB, as it is kept in one row of the office's SQLite. The first approved import sets `business.booksFrom`, which then cannot change.

## 4d. Compliance

**The office prepares and reminds; you or your CA file on the government portals.** Nothing here logs in to the GST, income-tax, TRACES or MCA portals, and no portal credentials or DSCs are ever stored.

- **The calendar** needs no configuration. It is computed in the engine (`packages/engine/src/compliance`) from the profile in Settings and the books. A government extension goes in `overrides.ts` with its circular number and date, and takes effect for every office on the next deploy.
- **Routes** are under `/api/o/<office>/compliance` (`ROUTES.compliance*` in `packages/contracts`): the view, the profile, the master-data check, events, manual items, mark filed and reopen, assign, snooze, the SRN, papers and the filing pack, the books record, the edit log and the auditor's statement. The owner and the accountant may use all of them; marking filed and assigning are written to the item's trail with the person's name.
- **Proof of filing** is posted as a form to `/api/o/<office>/compliance/proof` (PDF, PNG, JPEG or WebP, 10 MB at most) and kept in `DOCS` with the office's other files.
- **Reminders** come from the `compliance-due` routine of the Compliance Officer: 7 days, 2 days and on the day, then weekly while late, in the morning digest, by email and on WhatsApp.
- **The edit log** is the `book_edits` table in each office's SQLite. Triggers refuse any update or delete, and each entry carries the hash of the one before. When an office is purged, its books and log are sealed (below) and written to `DOCS` as `retained/<officeId>/<time>.json.gz.enc`, with a keep-until date of 31 March eight years after the financial year of the purge.
- **The daily copy in India** runs at the end of each office's morning routines once the three `INDIA_BACKUP_*` settings and two secrets are set. Each office writes `<officeId>/<date>.json.gz.enc` (the books and the edit log, sealed), replacing the copy from the same day. Give the bucket a lifecycle rule that keeps objects for at least eight years. The key must be allowed to put, list and delete objects in the bucket: deleting is how a purged office's copies go. The last copy and any error show in Settings, under **Books record**.
- **Sealing.** Both copies are encrypted before they leave the office (`apps/api/src/envelope.ts`): the gzipped JSON is encrypted with a fresh AES-256-GCM data key, and that key is wrapped with the office's own key, derived with HKDF from `SOCIAL_TOKEN_KEY` and the office id, as the platform-token keys are. Without `SOCIAL_TOKEN_KEY` no copy goes to India (Settings shows why) and no office is purged. Each copy's header names the root key that sealed it; after a rotation (section 3a) older copies open with the old key from `SOCIAL_TOKEN_KEYS_OLD`, so keep it there for eight years after the rotation.
- **Opening a copy.** Fetch the file: from the India bucket with the provider's console or CLI, or from R2 with `wrangler r2 object get office-docs/retained/<officeId>/<time>.json.gz.enc --file backups/<name>.enc --remote`. Then `infisical run --env=dev --silent -- node tools/admin/open-backup.mjs backups/<name>.enc backups/<name>.json` checks and decrypts it with the root key its header names (`SOCIAL_TOKEN_KEY` or one in `SOCIAL_TOKEN_KEYS_OLD`) and writes `{ office, at or purgedAt, keepUntil, books, edits }`. `books` is the same object the owner's export holds and `edits` is the edit log with its hash chain. Keep both files in `backups/` (git-ignored) and delete them when done. Loading the books back into a live office is not automated yet: it is an engineering step, done with the business.

## 5. Social channels and WhatsApp

| Platform | Where it is set up | Settings needed |
| --- | --- | --- |
| Facebook Pages | Meta app with Facebook Login for Business | `META_APP_ID`, `META_APP_SECRET`; redirect URI `https://<host>/api/channels/facebook/callback` |
| Instagram | Meta app, Instagram product (Instagram login) | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`; redirect `/api/channels/instagram/callback` |
| Threads | Meta app, Threads use case | `THREADS_APP_ID`, `THREADS_APP_SECRET`; redirect `/api/channels/threads/callback` |
| Webhooks (comments, messages) | Meta app webhooks pointing at `https://<host>/api/hooks/meta` | `META_VERIFY_TOKEN`; fields for the page, Instagram and WhatsApp |
| WhatsApp (shared number) | WhatsApp Business Account, a phone number, a system user | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optionally `WHATSAPP_TEMPLATE` |
| WhatsApp (an office's own number) | The office's own WhatsApp Business Account, connected in Settings | Routed with `admin.mjs route <office> wa_phone <phone number id>` |
| LinkedIn | LinkedIn developer app with the Community Management or Share products | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| X | X developer app, OAuth 2.0 with PKCE | `X_CLIENT_ID`, `X_CLIENT_SECRET` |

Without a platform's keys, its channel works in **manual** mode: the Social Media Manager prepares a publishing pack (text, image, steps) and the owner marks the post as posted.

## 6. Domain and schedule

- **Custom domain:** the platforms' redirect URIs use the app, `https://app.office.snilld.in/api/channels/<platform>/callback`, for every office; after connecting, the owner is sent back to their own office's address.
- **Cron:** `30 21 * * *` (21:30 UTC, 03:00 in India) purges offices deleted more than 30 days ago, deletes their daily copies in India (at most 40 requests to the bucket a night, the rest the next night), and deletes retained copies past their keep-until date.
- **Per-office alarms:** each office schedules its own daily digest (default 08:45 office time) and social publishing.

## 7. Platform console and admin tool

**The platform console**, `console.office.snilld.in`, is for the addresses in `PLATFORM_OWNERS`. It lists every business on the platform: name, owners, people, status, when and how it opened (signed up, or onboarded by whom), its email-in and web address, a pending owner invitation, and the date of its last account change. From it a platform owner onboards a business (an empty office and a 14-day owner invitation emailed from `MAIL_FROM`), sends the invitation again, and suspends or opens an office. It reads only the control plane (D1): no office's books, files or conversations are shown or reachable, and every action is written to that office's audit trail under the platform owner's address. The API is `/api/platform` (`PLATFORM_ROUTES` in `packages/contracts`), refused with 403 to anyone else.

**The admin tool** covers the rest. Run through Infisical's `prod` environment for live: `infisical run --env=prod --silent -- node tools/admin/admin.mjs <command>`. Add `--env staging` (through Infisical's `staging` environment) to work on the staging Worker's database, or `--local` for the local development database.

| Command | What it does |
| --- | --- |
| `list` | Every office with status, people, routes, history count and last activity |
| `suspend <office>`, `resume <office>` | Closes an office to its people (they see 423), or opens it again |
| `invite-owner <office> <email>` | A new 14-day owner invitation link, for an office that has lost its owner |
| `route <office> <kind> <external id>` | Sends a page, account or WhatsApp number to an office |
| `purge-soon <office>` | A deleted office is purged at the next nightly run instead of after 30 days |
| `backup` | Exports the control plane as SQL into `backups/` (git-ignored; holds account data) |
| `forget-user <email>` | Removes a person's account, sessions, memberships, WhatsApp link and consent records; refuses if they are the only owner of an office |
| `requests` | Lists account deletion requests still open from before deletion became self-serve, oldest first |
| `requests done <id>` | Completes a deletion request: runs `forget-user` for that person and marks the request done |
| `subdomain <office> <label>` | Gives an office its own address, `<label>.office.snilld.in`, in two runs: the first adds the custom domain to `wrangler.jsonc` (commit and deploy), the second checks the address answers and switches the office over. Labels are 2 to 32 lower-case letters, digits or hyphens; `app`, `console`, `demo`, `www`, `api`, `mail`, `in` and a few more are refused |
| `subdomain <office> --remove` | Takes the address away (commit and deploy afterwards); the office opens on the app again |

## 8. Go-live checklist

| # | Item | Owner | Status |
| --- | --- | --- | --- |
| 1 | The product in the Snilld Cloudflare account, beside the `snilld.in` zone | Business and engineering | Open: config ready (`office.snilld.in`), the move is runbook Part 1 |
| 2 | Sending: Resend from `support@snilldai.com`; `RESEND_API_KEY` in Infisical and on the Worker | Engineering done; key: operator | **Open, blocks sign-up** |
| 3 | Receiving: Email Routing catch-all on `in.office.snilld.in` | Engineering | Open: `INGEST_DOMAIN` set |
| 4 | `office.snilld.in`, `app.office.snilld.in`, `console.office.snilld.in` and `demo.office.snilld.in` on the Workers; redirect URIs on the app | Engineering | Open: product page, console and demo attached 6 November 2026; `app` attached by the next deploy |
| 5 | `BETTER_AUTH_SECRET` and `SOCIAL_TOKEN_KEY` set as Worker secrets | Engineering | Done 5 November 2026 with `tools/admin/set-secrets.sh` |
| 6 | Meta app reviewed and live (Pages, Instagram, Threads, WhatsApp, webhooks) | Business and engineering | Per platform |
| 7 | WhatsApp Business number verified and display name approved | Business | Per account |
| 8 | Privacy notice and terms covering accounting data, AI processing and WhatsApp | Business and legal | **In progress:** drafts in `docs/legal`, published at `/legal/...`; see the legal checklist below |
| 9 | Workers Paid plan when the first non-pilot office signs up | Business | When needed |
| 10 | Backups before every migration; rollback rehearsed once | Engineering | Process in place |
| 11 | Monitoring: Workers Issues automation and alert monitors on error rate, 5xx, failed exports, backups and nightly runs, CPU limit (`04-deployment.md`, section 9) | Engineering | Open: the logs are in place; an owner sets the alerts up in the dashboard |
| 12 | Migrations `0003_legal.sql` (consent and deletion requests) and `0004_office_locale.sql` (office locale) applied to the live database | Engineering | Open: `pnpm run deploy` through Infisical applies them before deploying |
| 13 | A bucket in an Indian region for the daily copy of companies' books (rule 3(5) of the Companies (Accounts) Rules); `INDIA_BACKUP_*` settings and secrets set | Business and engineering | Open: code done; until it is set, Settings tells each company its books have no India copy |

## 9. Legal checklist

| # | Item | Status |
| --- | --- | --- |
| 1 | A lawyer in India reviews the privacy notice, terms, data processing terms and subprocessor list | Open |
| 2 | Bracketed details completed: legal name, registered address, grievance officer, contact address, response times | Open |
| 3 | When a document changes, raise its version in `LEGAL_DOCUMENTS` (`packages/contracts`) and the date at its top; everyone is asked to accept it once more | Process in place |
| 4 | Each business using the Customer Service agent puts the customer AI notice (`docs/legal/customer-notice-template.md`) on its website and WhatsApp profile | Per business, at hiring |
| 5 | People delete their own accounts in Settings, at once. Requests left open from before are checked with `admin.mjs requests` and completed within 30 days | Process in place |
| 6 | Subprocessor list kept current when a provider is added (for example an email sending service) | Ongoing |

## 10. Security incidents

A personal data breach is any loss, leak or unauthorised access to personal data we hold, whether account data or a business's books and customer messages.

1. **Who decides.** The engineer on call contains it (revoke keys, suspend the affected office, rotate `BETTER_AUTH_SECRET` or `SOCIAL_TOKEN_KEY` through Infisical) and tells the founder the same day. The founder decides what is notified and signs it off.
2. **Record.** Start a written record at once: what happened, when it was found, which offices and people, what data, what was done. Keep it even if nothing turns out to be notifiable.
3. **Tell the businesses.** Each affected business is told without undue delay and within 24 hours of confirming it, as the data processing terms promise, so it can meet its own duties to its customers and staff.
4. **Tell the Data Protection Board and the people affected.** Under the Digital Personal Data Protection Rules, the Board gets a first report without delay and a detailed report within 72 hours of becoming aware; people whose account data is affected are told in plain language what happened, the likely effect and what they can do. Confirm the current timelines with the lawyer, as the rules are new.
5. **Logs.** The rules expect logs that can show what happened to be kept for a year. Workers Logs keeps them 3 days on the free plan, so this is a **gap**: export Worker logs to long-term storage (for example Logpush to R2, which needs the paid plan) before the first pilot. Until then, copy an incident's log lines (found by their request ids) into its written record at once.
6. **Afterwards.** Write down the cause and the fix, and add a test or check so it cannot happen the same way again.
