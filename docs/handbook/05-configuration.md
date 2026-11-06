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
| `MAILER` | Send Email | | Reminders, invitations, confirmations, digests, customer service replies |
| `CHAT_LIMIT` | Rate limit | namespace `1001`, 20 a minute | Website chat messages, counted per widget and visitor IP; over the limit answers 429 |

## 2. Plain settings (`vars` in `wrangler.jsonc`)

| Name | Meaning | Live value today |
| --- | --- | --- |
| `DATA_MODE` | `live` for the real Worker | `live` |
| `MAIL_FROM` | The address mail is sent from | Placeholder (`office@the-office.example`); must be replaced |
| `INGEST_DOMAIN` | Each office receives mail at `<slug>@INGEST_DOMAIN` | Placeholder (`in.the-office.example`); must be replaced |
| `BETTER_AUTH_URL` | The public URL used in links and cookies | The live workers.dev URL |
| `TURNSTILE_SITE_KEY` | Optional. The public Turnstile site key the website chat shows; set together with `TURNSTILE_SECRET` | Not set (the chat relies on the rate limit) |

Local-only settings, passed with `--var` to `wrangler dev`, never set on live:

| Name | Meaning |
| --- | --- |
| `OFFICE_SEED` | `sample` opens new offices with the Kaveri Electricals books |
| `EMAIL_VERIFICATION` | `off` skips email confirmation |

The web build reads one flag: `VITE_DATA=mock` builds the demo; anything else builds the live app.

## 3. Secrets

Put with `wrangler secret put <NAME>` through Infisical, for example:

```sh
infisical run --env=dev -- sh -c 'printf %s "$NAME" | wrangler secret put NAME'
```

`sh tools/admin/set-secrets.sh` does this for the two required secrets, creating them in Infisical first if they are missing, and puts `TURNSTILE_SECRET` on the Worker if it is in Infisical. Run it yourself, not through an agent.

| Name | Required | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions |
| `SOCIAL_TOKEN_KEY` | For channels and WhatsApp | Root key: per-office keys are derived from it to seal platform tokens; it also signs media links and OAuth state |
| `META_APP_ID`, `META_APP_SECRET` | For Facebook and webhooks | The Meta app; the secret verifies webhook signatures |
| `META_VERIFY_TOKEN` | For webhooks | Checked on Meta's webhook handshake |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | For Instagram | Instagram API with Instagram login |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | For Threads | The Threads use case of the Meta app |
| `WHATSAPP_TOKEN` | For WhatsApp | System-user token for the WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | For WhatsApp | The shared business number used by every office |
| `WHATSAPP_TEMPLATE` | For broadcasts | Approved template name for messages outside the 24-hour window |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | For LinkedIn | LinkedIn app |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | For X | X app (OAuth 2.0) |
| `TURNSTILE_SECRET` | Optional, for the website chat | Verifies the Turnstile token on each chat message; without it the chat accepts messages within the rate limit |

In Infisical (environment `dev`), the Cloudflare deploy token is held as `CLOUDFLARE_API_TOKEN_OFFICE_AGENTS` and passed to wrangler as `CLOUDFLARE_API_TOKEN` at run time.

> **Rule:** no `.env` or `.dev.vars` files. Commands that need secrets run as `infisical run --env=dev -- <command>`.

## 4. Email

| Item | What to configure | Status |
| --- | --- | --- |
| Sending | A domain we own, added to Cloudflare, with Email Routing enabled; `MAIL_FROM` on that domain; SPF and DKIM records. Note: the `send_email` binding delivers only to addresses verified on the Cloudflare account, so mail to arbitrary customers and new sign-ups needs a sending service (for example Amazon SES, Postmark or Resend) or Cloudflare's own email sending when available on the account. | **Open: blocks self-serve sign-up on live** |
| Receiving | A subdomain for inbound mail (for example `in.<our domain>`), an Email Routing catch-all rule sending to the Worker, and `INGEST_DOMAIN` set to it | **Open** |
| Legacy address | `bills@the-office.example` is routed to the original office; replace when the domain is set | Open |
| Customer service address | Hiring the Customer Service agent claims `<slug>.help@INGEST_DOMAIN` (route kind `support_email`); replies go out through `MAILER` threaded on the customer's message, with Reply-To set to that address | Works once receiving and sending are set up |

## 4a. Website chat and route kinds

The `route` table sends inbound traffic to one office. Its kinds are `email` (bills), `support_email` (customer service mail), `widget` (a website chat key), `wa_phone` (an office's own WhatsApp number), and the social page and account kinds. The Customer Service agent claims and releases its `support_email` and `widget` routes itself when it is hired or the chat is switched on or off; `admin.mjs route` is not needed for them.

The chat snippet a business pastes into its website loads `/w/<key>.js` and talks to `/api/chat/<key>` (open to any site, no cookies). A disabled chat or an agent that is not hired answers 404. Customer service uses at most 150 of the office's 400 daily AI calls (quota `cs_ai`); after that it carries on with its keyword rules alone and hands the owner anything they cannot place.

## 4b. Weather for the Lived-in skin

`GET /api/o/<office>/weather` is answered by the Worker, never the office. It reads the caller's approximate location from Cloudflare (`cf.latitude`, `cf.longitude`, `cf.city`), rounds it to 0.1 degrees, and asks MET Norway's `locationforecast/2.0/compact` API, caching each rounded area for an hour with the Cache API. The request carries the User-Agent `the-office/1.0 (<BETTER_AUTH_URL>; <MAIL_FROM>)`, as MET Norway's terms require an identifying name and contact, so both must be real before go-live. No key or secret is needed. Any failure answers `{ "weather": null }` and the team simply does not mention the weather. MET Norway's data is CC BY 4.0; the credit is shown in Settings beside the skin. Persona names are kept in the office's own storage (`office_kv`, key `personas`).

## 4c. Bringing in existing books

Nothing to configure. The templates are static files at `/templates/parties.csv`, `/templates/products.csv` and `/templates/open-items.csv` (from `apps/web/public/templates/`). `POST /api/o/<office>/onboarding/check` reads the files and changes nothing; `POST /api/o/<office>/onboarding/stage` stores each CSV in R2 under the office's `docs/` prefix and puts one `onboarding` item on the Desk. Both are open to the owner and the accountant; only the owner approves, at any trust level. Limits: 2,000 rows and 1 MB a file, 3 files a request; the staged item must fit in about 1.5 MB, as it is kept in one row of the office's SQLite. The first approved import sets `business.booksFrom`, which then cannot change.

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

- **Custom domain:** add the domain to Cloudflare, attach it to the `the-office` Worker as a custom domain, then update `BETTER_AUTH_URL` and every platform redirect URI to it.
- **Cron:** `30 21 * * *` (21:30 UTC, 03:00 in India) purges offices deleted more than 30 days ago.
- **Per-office alarms:** each office schedules its own daily digest (default 08:45 office time) and social publishing.

## 7. Admin tool

Run through Infisical: `infisical run --env=dev --silent -- node tools/admin/admin.mjs <command>`. Add `--local` to work on the local development database.

| Command | What it does |
| --- | --- |
| `list` | Every office with status, people, routes, history count and last activity |
| `suspend <office>`, `resume <office>` | Closes an office to its people (they see 423), or opens it again |
| `invite-owner <office> <email>` | A new 14-day owner invitation link, for an office that has lost its owner |
| `route <office> <kind> <external id>` | Sends a page, account or WhatsApp number to an office |
| `purge-soon <office>` | A deleted office is purged at the next nightly run instead of after 30 days |
| `backup` | Exports the control plane as SQL into `backups/` (git-ignored; holds account data) |
| `forget-user <email>` | Removes a person's account, sessions, memberships, WhatsApp link and consent records; refuses if they are the only owner of an office |
| `requests` | Lists open account deletion requests made from Settings, oldest first |
| `requests done <id>` | Completes a deletion request: runs `forget-user` for that person and marks the request done |

## 8. Go-live checklist

| # | Item | Owner | Status |
| --- | --- | --- | --- |
| 1 | Own a domain and add it to Cloudflare | Business | Open |
| 2 | Sending: a provider able to reach any address; `MAIL_FROM` on our domain; SPF, DKIM, DMARC | Engineering | **Open, blocks sign-up** |
| 3 | Receiving: Email Routing catch-all on `in.<domain>`; set `INGEST_DOMAIN` | Engineering | Open |
| 4 | Custom domain on the Worker; update `BETTER_AUTH_URL` and redirect URIs | Engineering | Open |
| 5 | `BETTER_AUTH_SECRET` and `SOCIAL_TOKEN_KEY` set as Worker secrets | Engineering | Done 5 November 2026 with `tools/admin/set-secrets.sh` |
| 6 | Meta app reviewed and live (Pages, Instagram, Threads, WhatsApp, webhooks) | Business and engineering | Per platform |
| 7 | WhatsApp Business number verified and display name approved | Business | Per account |
| 8 | Privacy notice and terms covering accounting data, AI processing and WhatsApp | Business and legal | **In progress:** drafts in `docs/legal`, published at `/legal/...`; see the legal checklist below |
| 9 | Workers Paid plan when the first non-pilot office signs up | Business | When needed |
| 10 | Backups before every migration; rollback rehearsed once | Engineering | Process in place |
| 11 | Monitoring: Workers observability alerts on error rate | Engineering | Open |
| 12 | Migrations `0003_legal.sql` (consent and deletion requests) and `0004_office_locale.sql` (office locale) applied to the live database | Engineering | Open: `pnpm run deploy` through Infisical applies them before deploying |

## 9. Legal checklist

| # | Item | Status |
| --- | --- | --- |
| 1 | A lawyer in India reviews the privacy notice, terms, data processing terms and subprocessor list | Open |
| 2 | Bracketed details completed: legal name, registered address, grievance officer, contact address, response times | Open |
| 3 | When a document changes, raise its version in `LEGAL_DOCUMENTS` (`packages/contracts`) and the date at its top; everyone is asked to accept it once more | Process in place |
| 4 | Each business using the Customer Service agent puts the customer AI notice (`docs/legal/customer-notice-template.md`) on its website and WhatsApp profile | Per business, at hiring |
| 5 | Deletion requests checked weekly with `admin.mjs requests` and completed within 30 days | Process in place |
| 6 | Subprocessor list kept current when a provider is added (for example an email sending service) | Ongoing |

## 10. Security incidents

A personal data breach is any loss, leak or unauthorised access to personal data we hold, whether account data or a business's books and customer messages.

1. **Who decides.** The engineer on call contains it (revoke keys, suspend the affected office, rotate `BETTER_AUTH_SECRET` or `SOCIAL_TOKEN_KEY` through Infisical) and tells the founder the same day. The founder decides what is notified and signs it off.
2. **Record.** Start a written record at once: what happened, when it was found, which offices and people, what data, what was done. Keep it even if nothing turns out to be notifiable.
3. **Tell the businesses.** Each affected business is told without undue delay and within 24 hours of confirming it, as the data processing terms promise, so it can meet its own duties to its customers and staff.
4. **Tell the Data Protection Board and the people affected.** Under the Digital Personal Data Protection Rules, the Board gets a first report without delay and a detailed report within 72 hours of becoming aware; people whose account data is affected are told in plain language what happened, the likely effect and what they can do. Confirm the current timelines with the lawyer, as the rules are new.
5. **Logs.** The rules expect logs that can show what happened to be kept for a year. Workers observability keeps logs for a short period only, so this is a **gap**: export Worker logs to long-term storage (for example Logpush to R2) before the first pilot.
6. **Afterwards.** Write down the cause and the fix, and add a test or check so it cannot happen the same way again.
