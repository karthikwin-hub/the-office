# Phase 6: go-live readiness, step by step

This is a working runbook for the person carrying out Phase 6 of the roadmap (`docs/handbook/06-roadmap.md`). Follow the parts in order. Each step says what to do, how to check it worked, and when to stop and ask.

**The goal:** a new person can sign up, confirm their email, open an office, email a bill to the office and approve it, all on `office.snilld.in`, and a customer's office opens on its own address such as `kaveri.office.snilld.in`. Every item in the go-live checklist (`docs/handbook/05-configuration.md`, section 8) is closed.

## Before you start

### Where everything lives

The product belongs to Snilld, so it runs in the **Snilld Cloudflare account**, the same account that holds the `snilld.in` domain (and the DNS for Clubs and Sports OS). A Worker can only use a domain in its own account, which is why the product moves there in Part 1. It ran in a separate account ("the-office-agents") until now; nothing in that account needs to be kept.

| Address | What it is |
| --- | --- |
| `office.snilld.in` | The product page: what the product is, with Sign in and Try the demo |
| `console.office.snilld.in` | Where people sign up, sign in, open an office and accept invitations |
| `<customer>.office.snilld.in` | One customer's office, for example `kaveri.office.snilld.in`. Added per customer in Part 5b |
| `demo.office.snilld.in` | The demo with sample books |
| `in.office.snilld.in` | Inbound email: each office gets `<office-slug>@in.office.snilld.in` |
| `support@snilldai.com` | Outbound email, through Resend (already set up for Clubs and Sports OS; nothing to create) |

It is the same pattern as Clubs (`console.clubs.snilld.in`, `<club>.clubs.snilld.in`) and Sports OS, with one difference: those run on our VM with a wildcard certificate, while this runs on Cloudflare Workers, where each customer's address is added as its own custom domain with its own free certificate.

### Ground rules

- **Secrets never go in files, chat, screenshots or tickets.** No `.env` or `.dev.vars` files. Anything that needs a secret runs as `infisical run --env=dev -- <command>`. Refer to secrets by their name only.
- **Every Cloudflare command runs through Infisical**, using the Snilld deploy token from Part 1. It is stored in Infisical as `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE` and is passed to wrangler as `CLOUDFLARE_API_TOKEN`. Do not use `wrangler login`; on this machine it is signed in to a different company's account.
- **Do not touch the existing records of `snilld.in`.** Clubs, Sports OS, `cdn.snilld.in` and the `snilld.in` and `www` redirects depend on them. Never create a wildcard record (`*.snilld.in` or `*.office.snilld.in`); it would swallow other products' hosts. Every record this runbook needs is under `office.snilld.in`, and Cloudflare creates most of them itself.
- **Do not change anything on `snilldai.com`**, in particular its MX records (the company's mail).
- **Write down what you did** in the "Log" table at the end of this file as you go: date, step, result. It becomes the record that Phase 6 is closed.

### Access you need

Ask Puja for these before starting:

| Access | Why |
| --- | --- |
| Cloudflare dashboard, the **Snilld** account, with permission to edit Workers, D1, R2, DNS and Email for `snilld.in`, and to create API tokens | Everything in Parts 1 to 5 |
| Infisical, project for The Office, environment `dev`, permission to **add** a secret | Storing the new deploy token, running deploys and the admin tool |
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

1. **Who the grievance officer is**, and the company's legal name and registered address (needed in Part 6).
2. **The first customer's address.** A short word they recognise, usually the business's name: `kaveri`, not `kaveri-electricals-pvt-ltd`. Lower-case letters, digits and hyphens, 2 to 32 long. Some words are ours and refused: `console`, `demo`, `www`, `app`, `api`, `admin`, `mail`, `in`, `help`, `support` and a few more.

---

## Part 1: Move the product into the Snilld account

### 1a. Check the domain and note the account ID

1. In the Cloudflare dashboard, switch to the **Snilld** account (account menu at the top left).
2. Open **Domains** (or **Websites**). `snilld.in` must be listed as **Active**. If it is not there, stop and ask: it may be in another account.
3. Copy the **Account ID**. It is on the account's home page (**Account details**, or the right-hand column of the domain's Overview page), a 32-character code. It is not a secret.
4. In a new branch, replace `SNILLD_ACCOUNT_ID` with it in both `apps/api/wrangler.jsonc` and `apps/web/wrangler.mock.jsonc`.

**Check:** `rg -n SNILLD_ACCOUNT_ID apps` finds nothing.

### 1b. Create the deploy token

1. In the dashboard, open **My Profile → API Tokens → Create Token**, and start from the template **Edit Cloudflare Workers**.
2. Name it `agentic-office-deploy`. Add these permissions to the ones the template has:
   - **Account → D1 → Edit**
   - **Zone → DNS → Edit**
   - **Zone → SSL and Certificates → Edit** (each address gets its own certificate)
3. Under **Account Resources**, choose **Include → Snilld** (only this account). Under **Zone Resources**, choose **Include → Specific zone → snilld.in**.
4. Create it. Cloudflare shows the token once. **Paste it straight into Infisical**, project for The Office, environment `dev`, as `CLOUDFLARE_API_TOKEN_SNILLD_OFFICE`. Do not paste it anywhere else, and close the page.

**Check:**

```sh
infisical run --env=dev --silent -- sh tools/admin/cf.sh whoami
```

It names the Snilld account. If it names any other account, stop and ask. If it says the token is not in Infisical, check the secret's name and that it is in environment `dev`.

### 1c. Create the database and the file store

```sh
infisical run --env=dev --silent -- sh tools/admin/cf.sh d1 create office --location apac
infisical run --env=dev --silent -- sh tools/admin/cf.sh r2 bucket create office-docs
```

When wrangler asks **"Would you like Wrangler to add it on your behalf?"**, answer **no** both times: it would rewrite `wrangler.jsonc`, dropping its comments and adding a second, wrongly named binding. The first command prints a `database_id`. In your branch, replace `SNILLD_D1_DATABASE_ID` in `apps/api/wrangler.jsonc` with it. Keep the name `office` and the bucket name `office-docs`; the code expects them.

**Check:** `rg -n "SNILLD_" apps` finds nothing.

---

## Part 2: Sending email (checklist item 2, blocks sign-up)

All mail (sign-up confirmations, invitations, reminders, morning digests, replies to customers) goes out through **Resend** from `support@snilldai.com`, the same sender Clubs and Sports OS use. `snilldai.com` is already verified in Resend, with its SPF, DKIM and DMARC records in place, so there are **no DNS changes in this part**. `MAIL_FROM` in `apps/api/wrangler.jsonc` is already `support@snilldai.com`. The name shown is the business's name (or "Agentic Office"), and replies to a customer go back to the office's own address.

1. Ask Puja for the Resend API key used for `snilldai.com` (or create one in Resend: **API Keys → Create**, permission **Sending access**, domain **snilldai.com**, name `agentic-office`).
2. Add it to Infisical, in this project's **dev** environment, under the name `RESEND_API_KEY`. Never paste it in chat, a ticket or a file.
3. Run `sh tools/admin/set-secrets.sh` again. It now puts `RESEND_API_KEY` on the Worker as well. No redeploy is needed for a secret.
4. **Do not touch the MX records or any DNS record of `snilldai.com`.** Its mailbox is in use.

**Check (after the deploy in Part 5):** sign up with your personal Gmail address. The confirmation email arrives within a minute and is not in spam. In Gmail, open the message, choose **Show original**, and confirm `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`. Screenshot that panel (it has no secrets) for the Log.

---

## Part 3: Receiving email (checklist item 3)

Each office receives bills at `<office-slug>@in.office.snilld.in`. Cloudflare Email Routing hands that mail to the Worker. `INGEST_DOMAIN` in `apps/api/wrangler.jsonc` is already set to `in.office.snilld.in`.

Do this after the first deploy in Part 5 (the Worker `the-office` must exist in the account to be chosen), then come back for the check.

1. In the Snilld account, open **Domains → snilld.in → Email → Email Routing**.
2. **Important:** if Email Routing is not yet enabled on `snilld.in`, Cloudflare will offer to add MX records to `snilld.in` itself. **Do not accept.** Instead, look for **Settings → Subdomains** and add `in.office.snilld.in`. Cloudflare then adds MX and SPF records for `in.office.snilld.in` only. If the dashboard gives no way to enable routing without adding records to `snilld.in` itself, stop and ask.
3. Under **Routing rules**, edit the **Catch-all address**: action **Send to a Worker**, Worker **the-office**. Turn it **on**.

**Check:** in the live app, open an office and copy its email-in address from Settings. It must end in `@in.office.snilld.in`. From your personal mailbox, send a PDF bill to it. Within a minute or two it appears in the Accountant's room, and a card appears on the Desk.

---

## Part 4: The addresses (checklist item 4)

The product page, the console and the demo are already in the config: `office.snilld.in` and `console.office.snilld.in` under `routes` in `apps/api/wrangler.jsonc`, and `demo.office.snilld.in` in `apps/web/wrangler.mock.jsonc`. Cloudflare creates their DNS records and certificates during the deploy. Customers' addresses are added one at a time in Part 5b.

### 4a. Check nothing is in the way

In **Domains → snilld.in → DNS → Records**, search for `office`. Before the first deploy there must be **no** record named `office`, `console.office`, `demo.office` or `*.office`. If there is one, stop and ask; do not delete it yourself.

### 4b. Social and WhatsApp redirect addresses

Only if any platform apps (Meta, LinkedIn, X) have been set up already: in each platform's developer console, add the new redirect URIs, keeping the old ones until the switch is confirmed. Every office uses the console's address for these; the product sends people back to their own office afterwards.

- `https://console.office.snilld.in/api/channels/facebook/callback`
- `https://console.office.snilld.in/api/channels/instagram/callback`
- `https://console.office.snilld.in/api/channels/threads/callback`
- `https://console.office.snilld.in/api/channels/linkedin/callback`
- `https://console.office.snilld.in/api/channels/x/callback`
- Meta webhooks: `https://console.office.snilld.in/api/hooks/meta`

If none are set up yet, skip this; the channels work in manual mode.

### 4c. Open the pull request

Open a pull request with the `wrangler.jsonc` and `wrangler.mock.jsonc` changes from Part 1. Ask the engineer to review it.

---

## Part 5: Release (checklist items 10 and 12)

Do this once the pull request from Part 4 is merged. Run every command from the repository root on the `main` branch, after `git pull`.

1. **Check:**

   ```sh
   pnpm typecheck && pnpm test
   ```

2. **Build, migrate and deploy live.** On the first run this creates the Worker in the Snilld account, applies every database migration to the new database (checklist item 12), and attaches `office.snilld.in` and `console.office.snilld.in`:

   ```sh
   infisical run --env=dev --silent -- sh -c 'CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE pnpm run deploy'
   ```

   Use `pnpm run deploy`, not `pnpm deploy` (that is a different pnpm command and does nothing useful here). The output ends with the Worker's addresses, including `console.office.snilld.in`. If wrangler asks whether to replace an existing DNS record, answer **no** and stop and ask.

3. **Put the secrets on the new Worker.** Only the first time, and after the deploy (the Worker must exist):

   ```sh
   sh tools/admin/set-secrets.sh
   ```

   It reuses the values already in Infisical and ends with the list of secret names on the Worker: `BETTER_AUTH_SECRET` and `SOCIAL_TOKEN_KEY` at least.

4. **Deploy the demo:**

   ```sh
   infisical run --env=dev --silent -- sh -c 'CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE pnpm run deploy:mock'
   ```

   Then build the live app again so `apps/web/dist` holds the live build: `pnpm build`. (Both builds write to the same folder.)

5. **Smoke check.** A new certificate can take up to 15 minutes; until then the first command may fail with a certificate error. Wait and try again.

   ```sh
   curl -s https://console.office.snilld.in/api/health
   curl -s -o /dev/null -w "%{http_code}\n" https://console.office.snilld.in/api/o/off_aaaaaaaaaaaaaaaa/desk
   infisical run --env=dev --silent -- node tools/admin/admin.mjs list
   ```

   Expect `{"ok":true,"mode":"live","appDomain":"office.snilld.in"}`, then `401`, then an empty list of offices (the new database starts empty). Open `https://office.snilld.in`: the product page shows, and **Sign in** goes to the console. Open `https://demo.office.snilld.in` and check the sample office loads.

6. **Back up the control plane** from now on before every release:

   ```sh
   infisical run --env=dev --silent -- node tools/admin/admin.mjs backup
   ```

   A new file appears in `backups/`. It holds account data: never commit, copy or share it.

7. **If something is wrong:** roll the Worker back to the previous version and tell the engineer:

   ```sh
   infisical run --env=dev --silent -- sh -c 'cd apps/api && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE pnpm exec wrangler rollback'
   ```

8. **Rehearse a rollback once (checklist item 10):** after the second release, on a quiet day, run the rollback, check the health address, then run the deploy from step 2 again. Note the date in the Log.

9. **The old account.** When the exit test in Part 10 has passed, tell Puja. With her agreement, delete the Workers `the-office` and `the-office-mock`, the D1 database `office` and the R2 bucket `office-docs` in the old "the-office-agents" account, and remove `CLOUDFLARE_API_TOKEN_OFFICE_AGENTS` from Infisical. They only ever held test data.

---

## Part 5b: Giving a customer their own address

A new office first opens on `console.office.snilld.in`. To give it its own address, for example `kaveri.office.snilld.in`, do this with the label agreed with the customer. It takes two runs of the same command, with a deploy in between, because every address must be listed in `apps/api/wrangler.jsonc`: a deploy removes any address that is not there.

1. Find the office's ID (`off_…`):

   ```sh
   infisical run --env=dev --silent -- node tools/admin/admin.mjs list
   ```

2. **First run.** It checks the label and adds the address to `apps/api/wrangler.jsonc`:

   ```sh
   infisical run --env=dev --silent -- node tools/admin/admin.mjs subdomain off_xxxxxxxxxxxxxxxx kaveri
   ```

   If the label is taken or kept for the product, it says so; agree another with the customer.

3. Commit the changed `apps/api/wrangler.jsonc` (a one-line pull request is fine) and, once merged, deploy as in Part 5, step 2. Wait a few minutes for the certificate.

4. **Second run, the same command.** It checks that `https://kaveri.office.snilld.in` answers, then switches the office over:

   ```sh
   infisical run --env=dev --silent -- node tools/admin/admin.mjs subdomain off_xxxxxxxxxxxxxxxx kaveri
   ```

   If it says the address is not answering yet, wait 15 minutes and run it again.

**Check:** open `https://kaveri.office.snilld.in` in a private window and sign in as someone in that office: the office opens there. Sign in on `console.office.snilld.in` instead: you are sent on to `kaveri.office.snilld.in`. In the office's Settings, under Office, the **Web address** shows. Someone who is not in the office sees "This is not one of your offices" and nothing of it.

To take an address away: `admin.mjs subdomain off_xxxxxxxxxxxxxxxx --remove`, then commit and deploy. The office opens on the console again.

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

1. **Uptime alert.** Create a free monitor (for example UptimeRobot or Better Stack) on `https://console.office.snilld.in/api/health`, checking every 5 minutes, alerting Puja and the engineer by email. It should also alert when the body does not contain `"ok":true`.
2. **Error alerts in Cloudflare.** In the Snilld account, open **Notifications → Add**. Look for alerts about Workers (error rate or exceptions). If one is offered, create it for the Worker `the-office` and send it to Puja and the engineer. If none is offered on the plan, note that in the Log; the weekly review below covers it.
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

Do this with your personal email address, in a private browser window. Every step must pass.

1. Open `https://office.snilld.in`. Choose **Open your office**, then create an account. Accept the terms and privacy notice.
2. The confirmation email arrives (not in spam). Click the link. You are signed in on `console.office.snilld.in`.
3. Open a new office named "Exit test".
4. In Settings, copy the office's email-in address (`…@in.office.snilld.in`).
5. From your mailbox, send a supplier bill PDF to it. A sample bill is in `apps/web/public/docs/` (for example `doc-p0002.pdf`).
6. Within a few minutes, the Accountant shows the bill, and a card appears on **Your desk**.
7. Approve the card. The team log on the Floor shows the bill posted.
8. Give the office the address `exittest` with Part 5b. Open `https://exittest.office.snilld.in`: the office opens there, still signed in.
9. Take the address away again (`admin.mjs subdomain <office> --remove`, commit, deploy). In Settings, delete the "Exit test" office. Then, under Settings → Account, choose **Ask to delete my account**, and complete that request with `admin.mjs requests` and `admin.mjs requests done <id>` (this also proves the deletion process works).

Then update the go-live checklist in `docs/handbook/05-configuration.md`: mark items 1, 2, 3, 4, 8, 10, 11 and 12 done with the date, rebuild the handbook (`node tools/docs/build.mjs`), and open a pull request. Phase 6 is closed when it is merged.

---

## When to stop and ask

Stop and message the engineer or Puja, without trying workarounds, if:

- any step would change or delete an existing DNS record on `snilld.in`, or touch `snilldai.com` at all;
- any step would create a wildcard record (`*.snilld.in`, `*.office.snilld.in`);
- any command asks you to paste, print or save a secret value anywhere but Infisical;
- `wrangler whoami` names an account other than Snilld;
- a deploy, migration or test fails;
- the confirmation email lands in spam or shows a FAIL for SPF, DKIM or DMARC;
- a bill emailed to the office has not appeared after 10 minutes.

## Log

| Date | Part and step | What was done | Result | By |
| --- | --- | --- | --- | --- |
| | | | | |
