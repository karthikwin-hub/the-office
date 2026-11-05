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
| `MAILER` | Send Email | | Reminders, invitations, confirmations, digests |

## 2. Plain settings (`vars` in `wrangler.jsonc`)

| Name | Meaning | Live value today |
| --- | --- | --- |
| `DATA_MODE` | `live` for the real Worker | `live` |
| `MAIL_FROM` | The address mail is sent from | Placeholder (`office@the-office.example`); must be replaced |
| `INGEST_DOMAIN` | Each office receives mail at `<slug>@INGEST_DOMAIN` | Placeholder (`in.the-office.example`); must be replaced |
| `BETTER_AUTH_URL` | The public URL used in links and cookies | The live workers.dev URL |

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

`sh tools/admin/set-secrets.sh` does this for the two required secrets, creating them in Infisical first if they are missing. Run it yourself, not through an agent.

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

In Infisical (environment `dev`), the Cloudflare deploy token is held as `CLOUDFLARE_API_TOKEN_OFFICE_AGENTS` and passed to wrangler as `CLOUDFLARE_API_TOKEN` at run time.

> **Rule:** no `.env` or `.dev.vars` files. Commands that need secrets run as `infisical run --env=dev -- <command>`.

## 4. Email

| Item | What to configure | Status |
| --- | --- | --- |
| Sending | A domain we own, added to Cloudflare, with Email Routing enabled; `MAIL_FROM` on that domain; SPF and DKIM records. Note: the `send_email` binding delivers only to addresses verified on the Cloudflare account, so mail to arbitrary customers and new sign-ups needs a sending service (for example Amazon SES, Postmark or Resend) or Cloudflare's own email sending when available on the account. | **Open: blocks self-serve sign-up on live** |
| Receiving | A subdomain for inbound mail (for example `in.<our domain>`), an Email Routing catch-all rule sending to the Worker, and `INGEST_DOMAIN` set to it | **Open** |
| Legacy address | `bills@the-office.example` is routed to the original office; replace when the domain is set | Open |

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
| `forget-user <email>` | Removes a person's account, sessions, memberships and WhatsApp link; refuses if they are the only owner of an office |

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
| 8 | Privacy notice and terms covering accounting data, AI processing and WhatsApp | Business and legal | Open |
| 9 | Workers Paid plan when the first non-pilot office signs up | Business | When needed |
| 10 | Backups before every migration; rollback rehearsed once | Engineering | Process in place |
| 11 | Monitoring: Workers observability alerts on error rate | Engineering | Open |
