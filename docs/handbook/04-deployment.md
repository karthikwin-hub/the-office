# Deployment options

> **In one paragraph.** The Office runs today on Cloudflare: one Worker, one Durable Object per business, D1, R2 and Workers AI. This is the preferred option. It costs nothing for the first few offices, about $5 to $15 a month at 50 offices and roughly $40 to $150 at 500, and needs no servers to operate. Self-hosting on Cloudflare's open-source runtime and a move to containers on AWS or GCP are both possible, and are described so that the choice is a deliberate one, but each costs more to run and more to operate at our size. Data residency for other markets is designed, not built: Cloudflare can pin an office's data to the EU, and a per-office region would be chosen when the office is opened.

## 1. Environments

| Environment | URL | Data | Purpose |
| --- | --- | --- | --- |
| Live | https://office.snilld.in (product page), https://console.office.snilld.in (sign-in), `https://<customer>.office.snilld.in` (each office given its own address) | Real offices (D1 `office`, R2 `office-docs`) in the Snilld Cloudflare account | Pilots |
| Demo | https://demo.office.snilld.in | Sample books in the browser, no backend | Sales conversations, reviews |
| Local | `wrangler dev` on a developer machine | Local D1, R2 and Durable Object state | Development and end-to-end checks |

Until the move in the go-live runbook (`docs/runbooks/phase-6-go-live.md`, Part 1), live and demo ran on workers.dev addresses in a separate Cloudflare account ("the-office-agents"). The move is needed because a Worker can only use custom domains on a zone in its own account, and `snilld.in` is in the Snilld account.

**One address per office.** `console.office.snilld.in` is where people sign up, sign in and choose an office. An office given its own address (`admin.mjs subdomain`) opens on `<subdomain>.office.snilld.in`, and the console sends its people there. One sign-in covers every address: the session cookie is set for `office.snilld.in`. Each customer's address is a Workers custom domain with its own free certificate, listed under `routes` in `apps/api/wrangler.jsonc`, because a deploy replaces the Worker's custom domains with exactly that list. A wildcard route would need Cloudflare's Advanced Certificate Manager (about $10 a month for the zone), since the free certificate covers only one level below `snilld.in`.

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

Nothing here is built yet; every office currently stores data wherever Cloudflare places it (Durable Objects are created near the first request, which for Indian users is typically in the Asia-Pacific region).

| Region | Law | What it asks of us | How we would meet it on Cloudflare |
| --- | --- | --- | --- |
| India | Digital Personal Data Protection Act 2023 | Consent and purpose limitation, deletion on request, breach notice. Transfers abroad are allowed except to countries the government restricts; some sectors (for example payments under RBI rules) require local storage. | Current setup is compliant for an accounting product. If a customer requires in-country storage: the enterprise Data Localisation Suite, or Option B in India. |
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

Both web builds write to `apps/web/dist`, so they are built and deployed one at a time.

1. **Check:** `pnpm test`, `pnpm typecheck`, and the end-to-end check against a local Worker (`tools/e2e/live.mjs`).
2. **Back up:** `infisical run --env=dev --silent -- node tools/admin/admin.mjs backup` writes the control plane to `backups/` (git-ignored).
3. **Migrate:** apply D1 migrations to the remote database.
4. **Deploy live:** build the live web app, then `wrangler deploy` from `apps/api`.
5. **Deploy demo:** build with `VITE_DATA=mock`, then `wrangler deploy -c ../web/wrangler.mock.jsonc`.
6. **Smoke check:** health returns 200; office paths without a session return 401; a forged media link returns 404; `admin.mjs list` shows the offices.

Every Worker command runs through Infisical so the Cloudflare token never touches a file.

## 8. Backups and rollback

| What | How it is protected | How to roll back |
| --- | --- | --- |
| Worker code | Every deploy creates a version | `wrangler rollback` to the previous version |
| Control plane (D1) | `admin.mjs backup` before every migration; D1 Time Travel keeps 30 days of point-in-time history | D1 Time Travel restore to a timestamp |
| Office books (Durable Objects) | Each office's SQLite with Cloudflare's durability; owner export (zip) on demand; deleted offices restorable for 30 days | Restore a deleted office from Settings or the admin tool; point-in-time recovery for Durable Object storage |
| Files (R2) | Stored under the office prefix; copied into the owner's export | Re-upload from the export |

A schema step in a Durable Object runs once, is idempotent (copy, check, then delete the old key), and is versioned, so a failed step is retried on the next start rather than half-applied.
