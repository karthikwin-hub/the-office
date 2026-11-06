# Phase 6: go-live readiness, step by step

This is a working runbook for the person carrying out Phase 6 of the roadmap (`docs/handbook/06-roadmap.md`). Follow the parts in order. Each step says what to do, how to check it worked, and when to stop and ask.

**The goal:** a new person can sign up, confirm their email, open an office, email a bill to the office and approve it, all on our own domain, with every item in the go-live checklist (`docs/handbook/05-configuration.md`, section 8) closed.

## Before you start

### Ground rules

- **Secrets never go in files, chat, screenshots or tickets.** No `.env` or `.dev.vars` files. Anything that needs a secret runs as `infisical run --env=dev -- <command>`. Refer to secrets by their name only.
- **Every Cloudflare command runs through Infisical**, using the project's deploy token. The token is stored in Infisical as `CLOUDFLARE_API_TOKEN_OFFICE_AGENTS` and is passed to wrangler as `CLOUDFLARE_API_TOKEN`. Do not use `wrangler login`; on this machine it is signed in to a different Cloudflare account.
- **Do not change the existing DNS records of `snilldai.com`** (the website and Puja's mailbox depend on them). We only add new records on subdomains. If Cloudflare offers to replace or delete an existing record, stop and ask.
- **Write down what you did** in the "Log" table at the end of this file as you go: date, step, result. It becomes the record that Phase 6 is closed.

### Access you need

Ask Puja for these before starting:

| Access | Why |
| --- | --- |
| Cloudflare dashboard, account `d3b8b7d744513171ea57b5b424391de9` ("the-office-agents"), with permission to edit Workers, DNS and Email | Domains, email, monitoring |
| The DNS of `snilldai.com`: either it is already on Cloudflare, or login to the registrar where it is hosted | Adding subdomains |
| Infisical, project for The Office, environment `dev`, read access | Running deploys and the admin tool |
| The GitHub repository, permission to open pull requests | Config changes |
| A personal Gmail or Outlook address that has never been used with The Office | The final sign-up test |

### Set up your machine

From the repository root:

```sh
corepack enable
pnpm install
infisical login          # once; opens a browser
pnpm typecheck && pnpm test
```

All tests must pass before you change anything. If they do not, stop and ask.

### Decisions to confirm with Puja first

Write the answers into the Log.

1. **Which domain.** This runbook assumes these names on `snilldai.com`:

   | Name | Used for |
   | --- | --- |
   | `app.snilldai.com` | The live product |
   | `demo.snilldai.com` | The demo with sample books |
   | `in.snilldai.com` | Inbound email: each office gets `<office-slug>@in.snilldai.com` |
   | `mail.snilldai.com` | Outbound email: the product sends from `office@mail.snilldai.com` |

   If Puja prefers a separate product domain (for example `agenticoffice.in`), use it everywhere below instead. A separate domain is simpler if `snilldai.com` is not on Cloudflare or its mailbox provider makes changes risky.

2. **Who the grievance officer is**, and the company's legal name and registered address (needed in Part 6).

---

## Part 1: Put the domain on Cloudflare

Everything else depends on this.

1. In the Cloudflare dashboard, open the account above, then **Websites** (or **Domains**). Check whether `snilldai.com` is listed.
2. **If it is listed and "Active":** go to Part 2.
3. **If it is not listed:** stop and talk to Puja. Moving a domain's DNS to Cloudflare means copying every existing record (the website, the mailbox's MX, SPF and verification records) first. It is not hard, but it must be planned so the website and email do not go down. The alternative is a new domain bought on Cloudflare directly (about $10 to $15 a year), which needs no migration.

**Check:** the domain shows as **Active** under the account `d3b8b7d744513171ea57b5b424391de9`.

---

## Part 2: Sending email (checklist item 2, blocks sign-up)

Today the product can only send mail to addresses verified on the Cloudflare account. That is why new sign-ups on live cannot confirm their email. We need sending that reaches any address.

The code sends through Cloudflare's `send_email` binding (`MAILER` in `apps/api/wrangler.jsonc`). The first choice is **Cloudflare Email Sending**, because it needs no code change.

### 2a. Enable Cloudflare Email Sending on `mail.snilldai.com`

1. In the dashboard, open **Email** (it may be under **Compute & AI → Email Service**, menu names change; search for "Email Sending").
2. Choose **Onboard a domain** (or **Add sending domain**) and enter `mail.snilldai.com`.
3. Cloudflare shows the DNS records it needs: SPF (TXT), DKIM (TXT or CNAME) and usually an MX record for bounces, all on `mail.snilldai.com`. Let Cloudflare add them. They are on the subdomain only, so the main domain is not affected.
4. Wait until the domain shows as **Verified** (minutes to an hour).
5. **If Email Sending is not offered on the account, or it says it can only send to verified addresses:** stop. Tell Puja and the engineer. The fallback is a sending service (Amazon SES, Postmark or Resend). That needs a small code change in `apps/api/src/auth.ts` and `apps/api/src/office-agent.ts`, a new secret, and a new line in the subprocessors list. It is an engineering task, not part of this runbook.

### 2b. Add DMARC

In **DNS → Records**, add:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `_dmarc.mail` | `v=DMARC1; p=none; rua=mailto:puja@snilldai.com` |

`p=none` only reports. After four clean weeks of reports, change it to `p=quarantine`.

### 2c. Point the product at the new address

In a new branch, edit `apps/api/wrangler.jsonc`:

```jsonc
"MAIL_FROM": "office@mail.snilldai.com",
```

Do not deploy yet. Parts 3 and 4 change the same file, so they all go out together in Part 5.

**Check (after the deploy in Part 5):** sign up with your personal Gmail address. The confirmation email arrives within a minute and is not in spam. In Gmail, open the message, choose **Show original**, and confirm `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`. Screenshot that panel (it has no secrets) for the Log.

---

## Part 3: Receiving email (checklist item 3)

Each office receives bills at `<office-slug>@in.snilldai.com`. Cloudflare Email Routing hands that mail to the Worker.

1. In the dashboard, open the domain, then **Email → Email Routing**.
2. **Important:** if Email Routing is not yet enabled on `snilldai.com`, Cloudflare will offer to add MX records to the main domain. **Do not accept that if `snilldai.com` already receives mail elsewhere** (for example Google Workspace for `puja@snilldai.com`): it would stop that mail. Instead, look for **Settings → Subdomains** and add `in.snilldai.com`. Cloudflare then adds MX and SPF records for `in.snilldai.com` only. If the dashboard gives no way to enable routing without touching the main domain's MX, stop and ask.
3. Under **Routing rules**, edit the **Catch-all address**: action **Send to a Worker**, Worker **the-office**. Turn it **on**.
4. In your branch, edit `apps/api/wrangler.jsonc`:

   ```jsonc
   "INGEST_DOMAIN": "in.snilldai.com",
   ```

**Check (after Part 5):** in the live app, open an office and copy its email-in address from Settings. It must end in `@in.snilldai.com`. From your personal mailbox, send a PDF bill to it. Within a minute or two it appears in the Accountant's room, and a card appears on the Desk.

---

## Part 4: Custom domains (checklist item 4)

### 4a. Live on `app.snilldai.com`

In your branch, edit `apps/api/wrangler.jsonc`:

1. Add, next to `"main"`:

   ```jsonc
   "routes": [{ "pattern": "app.snilldai.com", "custom_domain": true }],
   ```

2. Change:

   ```jsonc
   "BETTER_AUTH_URL": "https://app.snilldai.com"
   ```

Sign-in links, invitation links and cookies use `BETTER_AUTH_URL`. People signed in on the old workers.dev address will need to sign in again on the new one. That is expected.

### 4b. Demo on `demo.snilldai.com`

Edit `apps/web/wrangler.mock.jsonc` and add the same kind of line:

```jsonc
"routes": [{ "pattern": "demo.snilldai.com", "custom_domain": true }],
```

### 4c. Social and WhatsApp redirect addresses

Only if any platform apps (Meta, LinkedIn, X) have been set up already: in each platform's developer console, add the new redirect URIs, keeping the old ones until the switch is confirmed:

- `https://app.snilldai.com/api/channels/facebook/callback`
- `https://app.snilldai.com/api/channels/instagram/callback`
- `https://app.snilldai.com/api/channels/threads/callback`
- `https://app.snilldai.com/api/channels/linkedin/callback`
- `https://app.snilldai.com/api/channels/x/callback`
- Meta webhooks: `https://app.snilldai.com/api/hooks/meta`

If none are set up yet, skip this; the channels work in manual mode.

### 4d. Update the documents

In the same branch, update `docs/handbook/04-deployment.md` (the Environments table) and `docs/handbook/05-configuration.md` (the Plain settings table and the go-live checklist) with the new values, then run `node tools/docs/build.mjs` to rebuild the handbook.

Open a pull request with the `wrangler.jsonc`, `wrangler.mock.jsonc` and documents changes. Ask the engineer to review it.

---

## Part 5: Release (checklist items 10 and 12)

Do this once the pull request from Parts 2 to 4 is merged. Run every command from the repository root on the `main` branch, after `git pull`.

1. **Check:**

   ```sh
   pnpm typecheck && pnpm test
   ```

2. **Back up the control plane:**

   ```sh
   infisical run --env=dev --silent -- node tools/admin/admin.mjs backup
   ```

   A new file appears in `backups/`. It holds account data: never commit, copy or share it.

3. **Build, migrate and deploy live.** This also applies any database migrations (including `0003_legal.sql`, checklist item 12):

   ```sh
   infisical run --env=dev --silent -- sh -c 'CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS pnpm run deploy'
   ```

   Use `pnpm run deploy`, not `pnpm deploy` (that is a different pnpm command and does nothing useful here). The output ends with the Worker's URLs, including `app.snilldai.com`.

4. **Deploy the demo:**

   ```sh
   infisical run --env=dev --silent -- sh -c 'CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS pnpm run deploy:mock'
   ```

   Then build the live app again so `apps/web/dist` holds the live build: `pnpm build`. (Both builds write to the same folder.)

5. **Smoke check:**

   ```sh
   curl -s https://app.snilldai.com/api/health
   curl -s -o /dev/null -w "%{http_code}\n" https://app.snilldai.com/api/o/off_aaaaaaaaaaaaaaaa/desk
   infisical run --env=dev --silent -- node tools/admin/admin.mjs list
   ```

   Expect `{"ok":true,"mode":"live"}`, then `401`, then the list of offices. Open `https://demo.snilldai.com` and check the sample office loads.

6. **If something is wrong:** roll the Worker back to the previous version and tell the engineer:

   ```sh
   infisical run --env=dev --silent -- sh -c 'cd apps/api && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS pnpm exec wrangler rollback'
   ```

7. **Rehearse a rollback once (checklist item 10):** on a quiet day, run the rollback, check the health URL, then run the deploy from step 3 again. Note the date in the Log.

---

## Part 6: Privacy notice and terms (checklist item 8)

The drafts are in `docs/legal/` and are already published at `/legal/...` on the site.

1. **Collect the blanks.** These appear in square brackets in the documents. Fill this table with Puja, then send it with the documents to the lawyer:

   | Blank | Value |
   | --- | --- |
   | Legal name of the company | |
   | Registered address, postal address, city | |
   | Grievance officer: name, designation, email (for example `grievance@snilldai.com`) | |
   | Support email (for example `support@snilldai.com`) | |
   | Company registration number | |
   | Response times: data requests [30 days], urgent issues [24 hours], acknowledgement [48 hours] | Confirm or change |
   | EU transfers: standard contractual clauses | Lawyer to advise; can stay out for an India-only launch |

   Every address used here must be a real, monitored mailbox.

2. **Lawyer review.** Send `privacy-notice.md`, `terms.md`, `data-processing.md`, `subprocessors.md` and the customer AI notice template, `customer-notice-template.md`. Ask them to also confirm the breach-notice timelines in `docs/handbook/05-configuration.md`, section 10.
3. **Apply the changes** in a branch: replace every bracketed item and apply the lawyer's edits. The documents already use the public name, Agentic Office; the company behind it is Snilld AI, whose legal name goes in the brackets.
4. **Raise the versions**, otherwise nobody is asked to accept the new text. In `packages/contracts/src/legal.ts`, set the `version` of every changed document (`terms`, `privacy`) to the day's date, for example `"2026-11-20"`, and put the same date in the "Version" line at the top of each changed document.
5. Check nothing is left in brackets:

   ```sh
   rg -n "\[[^\]]+\]" docs/legal
   ```

   Only Markdown links (`[text](/legal/...)`) should remain.
6. Run `pnpm typecheck && pnpm test`, open a pull request, and release with Part 5 once merged.

**Check:** sign in on live with your test account. You are asked to accept the updated terms and privacy notice once.

---

## Part 7: Monitoring (checklist item 11)

1. **Uptime alert.** Create a free monitor (for example UptimeRobot or Better Stack) on `https://app.snilldai.com/api/health`, checking every 5 minutes, alerting Puja and the engineer by email. It should also alert when the body does not contain `"ok":true`.
2. **Error alerts in Cloudflare.** In the dashboard, open **Notifications → Add**. Look for alerts about Workers (error rate or exceptions). If one is offered, create it for the Worker `the-office` and send it to Puja and the engineer. If none is offered on the plan, note that in the Log; the weekly review below covers it.
3. **Weekly review (every Monday, 15 minutes):**
   - `infisical run --env=dev --silent -- node tools/admin/admin.mjs list`: note the number of offices and anything suspended or unusual.
   - `infisical run --env=dev --silent -- node tools/admin/admin.mjs requests`: any account deletion request must be completed within 30 days with `admin.mjs requests done <id>`. Ask the engineer the first time.
   - In the dashboard, **Workers → the-office → Observability**: look at errors over the past week. Copy any recurring error message into a ticket for the engineer.
4. **Long-term logs (a legal gap).** The data protection rules expect logs that can explain an incident to be kept for a year; Cloudflare keeps Worker logs for a short time only. Exporting them (Logpush to an R2 bucket) needs the Workers Paid plan. Raise this with Puja together with item 9 of the checklist (the $5 a month Workers Paid plan), and once the plan is on, ask the engineer to set it up.

---

## Part 8: Office locale fields (engineering)

The roadmap item "add `country`, `currency`, `locale` and `timeZone` to the office record" was done in code on 6 November 2026. Its database migration (`0004_office_locale.sql`) goes to live with the deploy in Part 5. **Check:** after the deploy, open Settings → Office on live; it shows "Country and clock: India, INR, Asia/Kolkata".

---

## Part 9: Bringing in the first customer's books

A business that already keeps books (in Tally, Excel or a notebook) brings in what it has before it starts using the office, so reminders and statements are right from day one. This was built on 6 November 2026 and goes to live with the deploy in Part 5. Do it with the customer, on a call, after they have opened their office and filled in Settings → Business.

1. **Agree the start date.** Usually the first day of the current month. Everything dated before it comes in as "brought forward"; everything on or after it is sent as documents in the usual way (email or upload). **The start date cannot be changed after the first import is approved,** so confirm it with the owner before going further.
2. **Send the templates.** On the customer's Settings page, under **Bring in your books**, each of the three boxes has a **Download the template** link: customers and suppliers, products and stock, and unpaid invoices and bills. Each template has four example rows. Ask the customer (or their accountant) to replace the examples with their own rows and save each file as CSV. Not every template is needed: a services business can skip products.
3. **What goes in the unpaid file.** One row per invoice a customer still owes on, and one per bill the business still owes a supplier, dated before the start date. `total` is the full amount on the invoice; `outstanding` is what is still owed. Anything already paid in full is left out. A party named in this file must be in the customers and suppliers file, or already in the office.
4. **Check the files.** The owner or the accountant chooses the files and presses **Check the files**. If anything is wrong, a table shows the file, the row number as the spreadsheet shows it, the column and what to fix. Fix it in the spreadsheet, save it as CSV again, choose it again and check again.
5. **Limits.** Up to 2,000 rows and 1 MB in one file. A larger business brings its files in a few batches, one after another, approving each batch before sending the next.
6. **Send to the Desk.** When every row reads correctly, press **Send to the Desk for approval**. Nothing is in the books yet.
7. **The owner approves.** On **Your desk**, the card "Bring in your books from before …" shows the counts and the first rows. Only the owner can approve it; the accountant sees it as waiting. Approving brings everything in at once.
8. **Check.** In the Boardroom, the ageing report shows the unpaid invoices. Opening one says "Brought in from open-items.csv, row …" and links to the stored file. The GST and TDS reports start from the start date and do not include anything brought forward.

If an approval says "The books have changed since these files were checked", someone added a matching customer, product or invoice in the meantime. Reject the card, check the files again and send them again.

---

## Part 10: The exit test

Do this on `app.snilldai.com` with your personal email address, in a private browser window. Every step must pass.

1. Open `https://app.snilldai.com`. Choose to create an account. Accept the terms and privacy notice.
2. The confirmation email arrives (not in spam). Click the link. You are signed in.
3. Open a new office named "Exit test".
4. In Settings, copy the office's email-in address (`…@in.snilldai.com`).
5. From your mailbox, send a supplier bill PDF to it. A sample bill is in `apps/web/public/docs/` (for example `doc-p0002.pdf`).
6. Within a few minutes, the Accountant shows the bill, and a card appears on **Your desk**.
7. Approve the card. The team log on the Floor shows the bill posted.
8. In Settings, delete the "Exit test" office. Then, under Settings → Account, choose **Ask to delete my account**, and complete that request with `admin.mjs requests` and `admin.mjs requests done <id>` (this also proves the deletion process works).

Then update the go-live checklist in `docs/handbook/05-configuration.md`: mark items 1, 2, 3, 4, 8, 10, 11 and 12 done with the date, rebuild the handbook (`node tools/docs/build.mjs`), and open a pull request. Phase 6 is closed when it is merged.

---

## When to stop and ask

Stop and message the engineer or Puja, without trying workarounds, if:

- any step would change or delete an existing DNS record on `snilldai.com`;
- any command asks you to paste, print or save a secret value;
- a deploy, migration or test fails;
- the confirmation email lands in spam or shows a FAIL for SPF, DKIM or DMARC;
- a bill emailed to the office has not appeared after 10 minutes.

## Log

| Date | Part and step | What was done | Result | By |
| --- | --- | --- | --- | --- |
| | | | | |
