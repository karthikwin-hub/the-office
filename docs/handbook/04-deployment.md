# Deployment options

> **In one paragraph.** The Office runs today on Cloudflare: one Worker, one Durable Object per business, D1, R2 and Workers AI. This is the preferred option. It costs nothing for the first few offices, about $5 to $15 a month at 50 offices and roughly $40 to $150 at 500, and needs no servers to operate. Self-hosting on Cloudflare's open-source runtime and a move to containers on AWS or GCP are both possible, and are described so that the choice is a deliberate one, but each costs more to run and more to operate at our size. Data residency for other markets is designed, not built: Cloudflare can pin an office's data to the EU, and a per-office region would be chosen when the office is opened.

## 1. Environments

| Environment | URL | Data | Purpose |
| --- | --- | --- | --- |
| Live | https://office.snilld.in (product page), https://app.office.snilld.in (businesses sign in), https://console.office.snilld.in (platform console, ours), `https://<customer>.office.snilld.in` (each office given its own address) | Real offices (D1 `office`, R2 `office-docs`) in the Snilld Cloudflare account | Pilots |
| Staging | `https://the-office-staging.<subdomain>.workers.dev` (one host; the console at `/?platform`) | Test offices only (D1 `office-staging`, R2 `office-docs-staging`), its own secrets, in a staging Cloudflare account or the Snilld one (`env.staging` in `apps/api/wrangler.jsonc`) | Every merge to `main` is deployed here and checked before it can go live |
| Demo | https://demo.office.snilld.in | Sample books in the browser, no backend | Sales conversations, reviews |
| Local | `wrangler dev` on a developer machine | Local D1, R2 and Durable Object state | Development and end-to-end checks |

Until the move in the go-live runbook (`docs/runbooks/phase-6-go-live.md`, Part 1), live and demo ran on workers.dev addresses in a separate Cloudflare account ("the-office-agents"). The move is needed because a Worker can only use custom domains on a zone in its own account, and `snilld.in` is in the Snilld account.

**One address per office.** `app.office.snilld.in` is where businesses sign up, sign in and choose an office. An office given its own address (`admin.mjs subdomain`) opens on `<subdomain>.office.snilld.in`, and the app sends its people there. `console.office.snilld.in` is the platform owners' console (the addresses in `PLATFORM_OWNERS`): every business's account, onboarding and suspending, never any office's books. One sign-in covers every address: the session cookie is set for `office.snilld.in`. Each customer's address is a Workers custom domain with its own free certificate, listed under `routes` in `apps/api/wrangler.jsonc`, because a deploy replaces the Worker's custom domains with exactly that list. A wildcard route would need Cloudflare's Advanced Certificate Manager (about $10 a month for the zone), since the free certificate covers only one level below `snilld.in`.

## 2. The options

### Option A: Cloudflare Workers, Durable Objects, D1, R2 (current, preferred)

- **Shape:** exactly what the code is written for. No servers, no containers, global edge.
- **Strengths:** near-zero cost at pilot scale; one Durable Object per office gives isolation and a single writer by construction; no patching or capacity planning; R2 has no egress fees; Workers AI needs no model keys.
- **Weaknesses:** platform-specific primitives (Durable Objects, the `send_email` binding); CPU limits per request on the free plan (managed by reading PDFs in the browser); strict India-only data residency needs Cloudflare's enterprise Data Localisation Suite.

### Option B: self-hosted on `workerd` and Docker

- **Shape:** Cloudflare's runtime, `workerd`, is open source (Apache-2.0) and runs the same Worker code on our own server. Durable Objects run with local SQLite storage; R2 is replaced by an S3-compatible store (MinIO or a cloud bucket); D1 by SQLite on disk; Workers AI by a model server (for example vLLM or Ollama) or a model API; email by an SMTP relay.
- **Strengths:** full control and a choice of hosting country, including India; no platform lock-in for customers who insist on their own infrastructure.
- **Weaknesses:** we operate servers, backups, TLS, scaling and failover; a single machine holds every office's Durable Objects; GPU cost for models; several bindings need replacements and testing.
- **When:** an enterprise or government customer requires on-premises or in-country hosting.

### Option C: containers on AWS or GCP with Postgres and S3

- **Shape:** the Worker becomes a Node service (Hono runs on Node unchanged) in ECS Fargate or Cloud Run; each office's books move from a Durable Object to Postgres with a schema per office or row-level security; files to S3 or GCS; models to Bedrock or Vertex, or a self-hosted model server.
- **Strengths:** familiar to most consultants and enterprise IT; any region, including Mumbai, Frankfurt, Sydney and US regions; mature compliance certifications.
- **Weaknesses:** the single-writer-per-office guarantee has to be rebuilt with locks or queues; a fixed monthly floor even with no customers; more moving parts (load balancer, database, networking, secrets manager).
- **When:** a large partner standardises on AWS or GCP, or scale makes reserved capacity cheaper than per-request pricing.

## 3. Cost comparison

Indicative monthly platform cost in US dollars, for small offices of the size in the PRD (a few hundred documents a month each). Prices are list prices at the time of writing; confirm before committing. Outside costs (WhatsApp conversations, a domain, email sending beyond Cloudflare) are listed separately because they are the same in every option.

| Offices | Option A: Cloudflare | Option B: self-hosted `workerd` | Option C: AWS or GCP containers |
| --- | --- | --- | --- |
| 5 | $0 (free tier) | $20 to $60 (one VPS, object storage, a model API) | $80 to $150 (Fargate or Cloud Run, a small managed Postgres, a load balancer, storage) |
| 50 | $5 to $15 (Workers Paid plan; AI within or just above the free allowance) | $60 to $150 (larger VPS or GPU time for models, backups) | $150 to $300 |
| 500 | $40 to $150 (requests, Durable Object duration, AI usage) | $300 to $800 (several machines, GPU, an operator's time not included) | $400 to $900 |

What drives the Cloudflare cost at scale is Workers AI usage for reading documents and voice notes. Text-layer reading in the browser and the per-office daily allowance keep it bounded.

**Outside costs, any option:** WhatsApp Business conversations are charged by Meta per conversation category and country (replies within the 24-hour customer window are free; broadcasts show their cost on the Desk before approval). A custom domain is about $10 to $15 a year.

## 4. Comparison

| Criterion | A: Cloudflare | B: self-hosted | C: AWS or GCP |
| --- | --- | --- | --- |
| Cost at pilot scale | Best | Medium | Worst |
| Operating effort | Lowest: no servers | Highest | Medium |
| Isolation per office | Built in (Durable Object per office) | Built in, one machine | Must be engineered |
| Code changes needed | None | Bindings replaced | Durable Objects replaced |
| Data residency choice | EU and US FedRAMP jurisdictions; location hints for others; India via enterprise suite | Any country | Any cloud region |
| Lock-in | Medium (Durable Objects) | Low | Medium (managed services) |
| Fit for consultants' enterprise clients | Good, unfamiliar to some | Good for on-premises demands | Most familiar |

## 5. Recommendation

> **Decision:** stay on Option A, Cloudflare, for the pilot and the first paying customers. Move to the $5 Workers Paid plan when the first real (non-pilot) office signs up. Keep Options B and C documented and revisit only when a specific customer requirement (in-country hosting, a mandated cloud) or a cost crossover appears.

Reasons: it is what the code is built for; it is free at pilot scale; the per-office Durable Object is the cleanest isolation model available to a small team; and it keeps operations to a single deploy command. The engine and contracts have no Cloudflare dependency, and storage is SQLite and S3-compatible objects, so a later move is a port of the Worker layer, not a rewrite.

## 6. Data residency by region (design)

Per-office regions are not built yet; every office's live books sit wherever Cloudflare places them (Durable Objects are created near the first request, which for Indian users is typically in the Asia-Pacific region). The one piece that is built is the daily copy of each office's books to object storage in India, described in the India row below.

| Region | Law | What it asks of us | How we would meet it on Cloudflare |
| --- | --- | --- | --- |
| India | Digital Personal Data Protection Act 2023; Companies (Accounts) Rules 2014, rule 3 | The Act: consent and purpose limitation, deletion on request, breach notice; transfers abroad are allowed except to countries the government restricts, and some sectors (for example payments under RBI rules) require local storage. Rule 3 applies to every company that keeps its books with us: a field-level edit log that cannot be switched off, books kept for eight years, a backup **on servers physically in India taken every day**, and the provider's name and server address given to the ROC each year. | Live storage on Cloudflare alone does **not** meet rule 3(5), because Cloudflare offers an India location only on the enterprise Data Localisation Suite. The Worker therefore writes a gzipped copy of each office's books every morning to an S3-compatible bucket in an Indian region (`INDIA_BACKUP_*`, see Configuration). Until that bucket is set up, Settings tells the company its books have no India copy. The edit log and eight-year retention are built in the Durable Object. |
| European Union | GDPR | Lawful basis, processor agreements, transfer safeguards, data subject rights | Durable Objects, D1 and R2 created with the `eu` jurisdiction keep data stored in the EU. |
| United Kingdom | UK GDPR | As GDPR; EU storage is generally acceptable under the UK adequacy regulations | The `eu` jurisdiction, or a location hint for western Europe. |
| Australia | Privacy Act 1988, Australian Privacy Principles | Reasonable steps for overseas disclosure; notification of eligible breaches | Location hint for Oceania; disclosure in the privacy notice. |
| United States | State laws such as CCPA and CPRA | Notice, opt-out of sale or sharing, deletion | No storage requirement; location hints for North America. |

**Per-office region, as a design:**

1. When an office is opened, the person picks the country of the business. The country sets the default data region (for example, EU countries map to `eu`).
2. The control plane records the region on the `office` row.
3. The Worker creates the office's Durable Object from the namespace for that jurisdiction, and files go to a bucket created in that jurisdiction (`office-docs-eu`).
4. The control plane itself holds only account and routing data; if a market requires it, a regional copy of the control plane can be added with offices routed by region.
5. A region cannot be changed after opening without an export and a re-import, which is stated at the time of choice.

## 7. Release process

Releases go out from GitHub Actions (`.github/workflows/deploy.yml`), not from a laptop. Both web builds write to `apps/web/dist`, so they are built and deployed one at a time.

1. **Check.** Every pull request runs `pnpm typecheck`, `pnpm test`, `pnpm lint`, the dependency audit and the end-to-end suite (`.github/workflows/ci.yml`; a failed end-to-end run keeps its Playwright traces as an artifact for 7 days) and is merged only green; run `/security-review` and `/code-review` on changes to `apps/api`. Run the end-to-end suite yourself with `pnpm e2e` (the real Worker on your machine); walk the flows it does not cover against `api-local` in `.claude/launch.json`.
2. **Staging, on every merge.** When CI passes on a push to `main`, the Deploy workflow runs `tools/admin/deploy.sh staging` and then `tools/admin/smoke.sh` against staging. A run for a commit that is no longer the newest on `main` is skipped, so staging never goes backwards.
3. **Live, by hand.** Actions → Deploy → Run workflow, on `main`. The run checks that CI passed for that commit, deploys and checks staging again, then waits for a reviewer to approve the `live` environment. After approval it runs `deploy.sh live`, keeps the backup, and runs the smoke checks on app, console and the product page.
4. **What `deploy.sh` does,** for either target: builds the web app; backs up the control plane (`admin.mjs backup`, a D1 export) and stops if the export fails or is empty; applies D1 migrations to that target's database; deploys the Worker. The target is required and each has its own token, so neither can deploy the other.
5. **The backup.** In CI, live's export is encrypted with `age` to the owners' public key (`BACKUP_AGE_RECIPIENT`, a variable of the `live` environment) and kept as the run's artifact `control-plane-<run id>` for 7 days, even when the migration or deploy fails. The repository is public and anyone signed in to GitHub can download its artifacts, so only the encrypted copy is uploaded and the workflow will not deploy live without the key; the plain file stays on the runner, which is discarded with the job. To read it: download the artifact, then `age -d -i <owners' key file> office-live-<time>.sql.age > office.sql`. D1 Time Travel is the first way back (section 8); the export is for when that is not enough.
6. **Demo,** when the screens changed: an owner runs `deploy.sh demo` through Infisical's `prod` environment; it has no data or secrets, and rebuilds the live app afterwards so the two builds never mix.
7. **After the release:** `admin.mjs list` (through `prod`, by an owner) shows the offices.

**Migrations only add.** `deploy.sh` migrates before it deploys, so for a moment the previous version serves on the new schema, and a rollback (`wrangler rollback`, section 8) returns to code that has already seen it. Every file in `apps/api/migrations` must therefore work with both the old and the new code:

- Add tables, indexes and columns that are nullable or have a default. Never drop, rename or change the type of a column or table, and never add a `NOT NULL` column without a default.
- No data rewrite that the previous version would misread; a backfill goes in code that reads both shapes.
- Removing something takes two releases: first the code stops using it; once that version is the one a rollback would return to, a later migration may drop it. That migration is reviewed as a breaking change, with the backup from its release checked by hand.
- A merged migration is never edited: `wrangler d1 migrations apply` records each file once and will not run it again.

The Durable Object's own schema steps follow the same rule (section 8).

**By hand, only when CI cannot,** an owner on their own machine (never one a coding agent works on): `deploy.sh staging` through Infisical's `staging` environment, then `deploy.sh live` through `prod`, each as `infisical run --env=<environment> --silent -- sh tools/admin/deploy.sh <target>`. The backup then stays in `backups/` (git-ignored, readable only by you); set `BACKUP_AGE_RECIPIENT` to encrypt it, and delete it once the release has settled. `pnpm run deploy` is `deploy.sh live`. Calling `wrangler deploy` or `wrangler d1 migrations apply` yourself skips the backup.

**Free plan.** The Worker runs on Cloudflare's Workers free plan, about 10 ms of CPU per request: nothing may depend on the paid plan's allowance (see the parked item in the roadmap). The free plan's daily allowances (requests, Durable Object requests, D1 rows read, Workers AI) are per account, so staging in the Snilld account would spend live's; that is why `env.staging` recommends an account of its own. Keep staging's traffic to the smoke checks and hand testing.

Every Worker command runs through Infisical or a GitHub environment secret, so the Cloudflare tokens never touch a file.

## 8. Backups and rollback

| What | How it is protected | How to roll back |
| --- | --- | --- |
| Worker code | Every deploy creates a version | `wrangler rollback` to the previous version |
| Control plane (D1) | `deploy.sh` exports it before every migration (kept encrypted for 7 days by the Deploy workflow); D1 Time Travel keeps point-in-time history, 7 days on the free plan (30 on the paid plan) | D1 Time Travel restore to a timestamp (`wrangler d1 time-travel restore DB --timestamp <time>`); otherwise import the export into a new database |
| Office books (Durable Objects) | Each office's SQLite with Cloudflare's durability; owner export (zip) on demand; deleted offices restorable for 30 days | Restore a deleted office from Settings or the admin tool; point-in-time recovery for Durable Object storage |
| Files (R2) | Stored under the office prefix; copied into the owner's export | Re-upload from the export |

A schema step in a Durable Object runs once, is idempotent (copy, check, then delete the old key), and is versioned, so a failed step is retried on the next start rather than half-applied.

## 9. Logs and alerts

The Worker and every office write structured log lines to Workers Logs (`apps/api/src/log.ts`), which Cloudflare keeps for 3 days on the free plan. Each line is one object: `event`, `level`, `requestId`, `officeId` when known, and as needed `route` (the route's pattern, never the real path), `method`, `status`, `ms`, `step`, `count`, a fixed `message`, and an error's `errorName` and `error` (its message). A line is never given a secret, token, cookie, request or email body, document contents, or a person's name, address, phone number or an amount: it takes only those fields, never a request, and its text is written in the code. As a second guard, free text (including an error's message) loses anything quoted and anything shaped like an email address, phone number, amount, long number, PAN, GSTIN, IFSC or token; a name in unquoted text cannot be told by its shape, which is why messages are fixed text. A test (`apps/api/test/log.test.ts`) builds lines from a request full of such things and finds none of them; another keeps any new `console.*` call out of `apps/api/src`.

**Finding one request.** Every response carries `x-request-id`: Cloudflare's ray id (the `cf-ray` header), or a new id when there is none. The Worker sends the same id to the office's Durable Object, so the Worker's lines and the office's share it. Each mail delivery and each nightly run gets an id of its own. Ask a person for the `x-request-id` of a failed request (the browser's network tab shows it), then search for it in the query builder; Cloudflare's own invocation log for the request has the same ray id.

**What is logged.**

| Event | Level | When |
| --- | --- | --- |
| `request.failed` | error | A route threw; answered `{"error":"Something went wrong. Try again."}` with 500. Has the route and the error |
| `request.5xx` | error | A request ended in a 5xx without throwing (an office answered 500, for example) |
| `office.failed` | error | Something in an office failed; `message` says what: `request failed` (with the route), `backup to India failed`, `export failed`, `vision read failed`, `whatsapp reply failed`, `customer message failed`, `connect <platform> failed`, and others |
| `export.failed` | error | A download of an office's export stopped part way |
| `nightly.failed` | error | A step of the nightly cron failed (`step`: `purge`, `erase-backups`, `sweep-retained`); the other steps still ran |
| `purge.failed`, `backups-erase.failed` | error | One office's purge, or the deletion of its copies in India, failed; tried again the next night |
| `disconnect.failed`, `mail.failed`, `whatsapp.reply-failed`, `social.pull-failed` | error | An office's open screens were not closed; mail was not sent; a WhatsApp reply or a social platform's pull failed |
| `wa.join.paused` | warn | Too many wrong WhatsApp linking codes in an hour: linking is paused for every number until `until` |
| `office.purged`, `office.backups-erased`, `retained.deleted`, `account.deleted`, `meta.unrouted` | info | The nightly duties' results, a deleted account (counts only), webhook entries no office takes |

A request that succeeds, or ends in a 4xx, writes no line of its own: Cloudflare's invocation log already records it (method, URL without its query string, status, CPU time, outcome). That log keeps the URL's path, and one route puts a person's email address in it: withdrawing an invitation (`DELETE /api/o/<office>/office-admin/invitations/<email>`), so those addresses are in Workers Logs for 3 days, visible to members of the Cloudflare account. Moving that address into the request body is open work. Whether the invocation logs keep request headers is not documented; check one in the dashboard after the first deploy (the office's own invocations carry the sealed caller header, with the person's name and email).

**The free plan's budget.** Workers Logs on the free plan takes 200,000 log events a day for the whole account; each invocation log and each line counts. A request to an office is two invocations (the Worker's and the office's), so at the free plan's 100,000 requests a day the invocation logs alone could reach the limit. Nothing is sampled today (`head_sampling_rate: 1` in `apps/api/wrangler.jsonc`), because a sampled-away error line is an alert that never fires. If the daily total nears the limit (Workers & Pages → the-office → Observability shows it), first set `"invocation_logs": false`, which keeps every line in this table, before lowering the sampling rate.

**Saved queries.** In the Cloudflare dashboard: Workers & Pages → the-office → Observability → Query builder (Workers Logs). Build each one, then Save; saved queries belong to the account and every member sees them. Repeat on `the-office-staging` if it is in another account. Field names are as above; Cloudflare's own fields begin with `$workers` or `$metadata`, and the query builder lists them.

| Name | Filter | Show |
| --- | --- | --- |
| Errors by event | `level` = `error` | Count, grouped by `event`, over 24 hours |
| Server errors by route | `event` is one of `request.failed`, `request.5xx` | Count, grouped by `route` and `status` |
| Office failures | `event` = `office.failed` | Count, grouped by `message`, then by `officeId` |
| Exports that failed | `event` = `export.failed` | The lines, with `officeId` and `error` |
| Backups to India that failed | `event` = `office.failed` and `message` = `backup to India failed` | The lines, with `officeId` and `error` (the morning round runs it once a day per office) |
| The nightly run | `event` is one of `nightly.failed`, `purge.failed`, `backups-erase.failed`, `office.purged`, `office.backups-erased`, `retained.deleted` | The lines, newest first |
| CPU limit | Invocation logs whose outcome is `exceededCpu` (the outcome field is `$workers.outcome`; pick it from the field list if the name differs) | Count, grouped by the request's path |
| One request | `requestId` = the id, or the ray id as free text | Every line, oldest first |

**Alert rules: owner steps.** Nothing is set up in Cloudflare by the code or by a coding agent; an owner sets these up in the dashboard once, for live, and checks they fire on staging with a request that fails on purpose. On the free plan:

1. **Workers Issues** (Workers & Pages → the-office → Observability → Issues; turned on by `"issues": { "enabled": true }`): groups uncaught exceptions, failed invocations, 5xx answers and every line logged at `error`, which is every error event above. Add an automation that sends each new issue to the owners' email or chat (webhook). Cloudflare calls Issues free during its beta.
2. **Monitors** (Notifications → Monitors), if the account offers the Workers Logs dataset on the free plan (Cloudflare's documentation does not say; check the dataset list when making the first monitor). One monitor each, to the owners' email:

| Monitor | Rule | Every |
| --- | --- | --- |
| Error rate | `request.failed` + `request.5xx` above 2% of the Worker's invocations | 15 minutes |
| 5xx count | 20 or more `request.failed` or `request.5xx` | 10 minutes |
| Export failed | any `export.failed` | 1 hour |
| Backup to India failed | any `office.failed` with `message` = `backup to India failed` | 1 day, after the morning round |
| Nightly failed | any `nightly.failed`, `purge.failed` or `backups-erase.failed` | 1 day, after 21:30 UTC |
| CPU limit | 5 or more invocations with outcome `exceededCpu` (free plan: 10 ms of CPU a request; the person sees error 1102) | 1 hour |

3. **Without monitors,** the Issues automation covers every error line as it happens; the CPU limit and the error rate are then read each morning from the saved queries "CPU limit" and "Server errors by route", alongside the weekly `admin.mjs list` review.

The rules on incidents expect logs that show what happened to be kept for a year (`05-configuration.md`, section 10): 3 days is not that, and the free plan has no Logpush. That gap stays open until the paid plan.
