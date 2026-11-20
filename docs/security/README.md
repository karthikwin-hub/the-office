# Security and code quality

The state of security and code quality in Agentic Office, what protects the books of each business, and what is still
to do. Last updated 20 November 2026, after the security release (live version `daea9f8f`, `main` at `514e18c`).

The full review, with every finding, its evidence and the tracker, is a private document held by the founders. This
page is the part that belongs next to the code: the controls in place, how they are checked, and the open work. It
leaves out how to exploit anything still open.

Alongside it: the [threat model](threat-model.md) (assets, actors, trust boundaries, and the threats and controls of
each main flow, with the residual risks) and the [ASVS 4.0.3 Level 2 checklist](asvs.md) (each relevant requirement,
its status and its evidence). The decisions behind the design are in [`docs/adr/`](../adr/README.md).

## Where it stands

A review of the whole product on 19 November 2026 (commit `9efe047`) scored security 2.5 out of 5 and code quality
2.5 out of 5 against an enterprise bar of 4.5 and 4. Isolation between businesses was already sound; the gaps were
at the edges: sign-in, browser defences, inbound email, the platform console and outdated dependencies.

| | 19 November | 20 November |
| --- | --- | --- |
| High findings open | 7 | 0 |
| Medium findings open | 10 | 1 (production secrets environment); retention and deletion in review |
| Dependency advisories (`pnpm audit --prod`) | 24, 2 critical | 8, none high or critical in code that runs; the critical two are test tooling never shipped in the Worker |
| Automated tests | 547 | 643, including 11 that run the office Durable Object inside workerd |
| Checks before merge | None | GitHub Actions on each pull request: type check, every test, lint, dependency audit, Claude security review |

Each fix shipped with a test that fails before it and passes after. The fixes were pull requests
[#2](https://github.com/karthikwin-hub/the-office/pull/2) to [#8](https://github.com/karthikwin-hub/the-office/pull/8).

## Controls in place

### Isolation between businesses

- One Durable Object, with its own SQLite database, per office. No shared table of books.
- Every office route checks membership in D1; anyone else gets the same 404 as an office that does not exist.
- The Worker sets the caller header itself and seals it with an HMAC (a subkey of `BETTER_AUTH_SECRET`,
  `apps/api/src/caller-seal.ts`). The Durable Object accepts only a sealed caller for its own office id, and its
  `/internal/*` routes only the system caller.
- Files live under `o/<officeId>/` in R2; keys are built by the server, never from client paths.

### Sign-in and sessions (`apps/api/src/auth.ts`, `apps/api/src/step-up.ts`)

- better-auth 1.7. Rate limits are counted in D1 per client address from `cf-connecting-ip`, which a client cannot
  set; a made-up `X-Forwarded-For` does not escape them.
- Two-step sign-in (TOTP with ten single-use backup codes) is required for office owners and platform owners. Until
  they enrol, owner routes and the console answer 403 `two_factor_required`, and the app opens enrolment first.
- Sessions end after 12 idle hours. Export, inviting, changing a role, handing an office over, deleting an office,
  removing a member, revoking an invitation and every change from the console need a sign-in or a step-up within the
  last 15 minutes.
- Passwords: PBKDF2-SHA256, chained in rounds of at most 100,000 (Cloudflare's limit per call). New hashes take
  100,000 iterations while the product is on the Workers free plan; see the parked item in the roadmap.
- Sign-up answers the same whether or not an address already has an account. Keep `EMAIL_VERIFICATION` unset in
  production: `off` brings back immediate sign-in, and with it the difference.

### Browser (`apps/api/src/edge.ts`, `apps/web/public/_headers`)

- Every response carries a strict Content-Security-Policy (scripts from the app itself, the one inline script by
  hash, Turnstile and Cloudflare Web Analytics), HSTS, `frame-ancestors 'none'`, Referrer-Policy and
  Permissions-Policy. A test keeps `_headers` and the Worker's policy identical, and another recomputes the inline
  script's hash.
- Every non-GET request under `/api` must come from the app's own origin, with a JSON, multipart or image body.
  Webhooks, the public website chat and sign-in callbacks are exempt by design.
- Stored files show in the browser only as PDF or PNG, JPEG or WebP, under `Content-Security-Policy: sandbox`;
  everything else downloads as bytes. Document ids are full random UUIDs.

### Inbound email (`apps/api/src/mail.ts`, `apps/api/src/inbound.ts`, `apps/api/src/filetype.ts`)

- A sender counts as a known party, a member or an owner only when Cloudflare's own `Authentication-Results`
  header (the top one, from `mx.cloudflare.net`) shows DMARC passed, or a DKIM signature aligned with the `From:`
  domain passed. Mail that is not proven still arrives, but waits on the owner's desk.
- The `X-Forwarded-For` header of a message is ignored.
- What is stored is typed from the file's name and bytes, never from what the sender declared.
- The office checks hourly limits and the upload allowance before anything is written to R2.
- Outgoing headers cannot carry line breaks.

### The platform console and invitations (`apps/api/src/app.ts`, `apps/api/src/tenancy.ts`)

- The console may invite an owner only into an office that has none, never sees the invitation link, and cannot
  make a platform owner an office's owner. Once an office has an owner, an owner invitation from outside the office
  stops working.
- Invitation tokens travel after `#` and in request bodies, never in a URL a server logs.

### WhatsApp linking (`apps/api/src/whatsapp/links.ts`)

- JOIN codes are 8 characters from an unambiguous alphabet, with a limit per number and a limit across all numbers
  together. A linked phone is written to the office's audit trail and shown in Settings.

### The office Durable Object (`apps/api/src/office-agent.ts`)

- Cloudflare `agents` SDK 0.33; its sub-agent paths are refused.
- The live WebSocket sends nothing before the caller is checked, is read-only (any client message closes it), and
  closes when a member is removed or the office is suspended or deleted.
- A request that fails partway reopens the books as last saved, so a half-applied change is never written later.

### Size and abuse limits

- Zip and XLSX files are measured before and while they are unzipped (`packages/engine/src/sales/sheets.ts`).
- The website chat requires Turnstile on live (it answers 503 without `TURNSTILE_SECRET`), limits polling and new
  conversations, and shows orders or balances only after a one-time code sent to the email or WhatsApp number on
  the order.
- Per office per day: 400 AI calls (150 for customer service) and 250 MB of uploads.

### Retention and deletion (`apps/api/src/backup.ts`, `apps/api/src/envelope.ts`, `apps/api/src/account.ts`)

- The copies of an office's books that leave its Durable Object, the daily copy in India and the copy retained after
  a purge, are encrypted with a fresh AES-256-GCM data key per copy, wrapped by the office's own key (HKDF of
  `SOCIAL_TOKEN_KEY` and the office id). `tools/admin/open-backup.mjs` opens one; the handbook (configuration, §4d)
  says how to restore.
- The nightly cron purges offices deleted 30 days ago, then deletes their daily copies in India (queued in
  `backup_erasure` and retried each night until done), then deletes retained copies whose eight years are over.
  Each step is written to the office's audit trail.
- "Delete my account" deletes at once after a step-up: sessions, sign-ins, two-factor secret, memberships, WhatsApp
  link, consent records and invitations. It is refused while the person is the only owner of an office others work
  in; an office they are alone in is deleted with them. The audit trail and the done request keep no name or address.

### Logs (`apps/api/src/log.ts`)

- One structured line per event, with the request id (Cloudflare's ray id, on every response as `x-request-id` and
  passed to the office's Durable Object) and the office id. A line takes only named fields, never a request; free text
  loses anything quoted and anything shaped like an email address, phone number, amount, long number, PAN, GSTIN, IFSC or
  token, cut to 1,000 characters first so scrubbing stays cheap. A test builds lines from a request full of secrets and
  personal data and finds none of them.
- `app.onError` logs a thrown error once and answers a generic message. Cloudflare's own request logs leave out query
  strings (`redact_query_string`), so an OAuth code or a media link's signature is not kept there either.

### Unchanged and still sound

Invitations stored only as a hash, single use, bound to one address, 14 days; platform tokens encrypted with AES-GCM
under per-office HKDF keys; Meta webhooks verified over the raw body; signed, expiring media links; parameterised SQL
everywhere; zod on every request body; agents that stage every write for approval.

## How it is checked

- **Every pull request:** GitHub Actions runs `pnpm typecheck` and `pnpm test`, `pnpm lint`, and
  `pnpm audit --prod --audit-level high` (`.github/workflows/ci.yml`); each fails the check. Run `/security-review`
  and `/code-review` in Claude Code on any change to `apps/api`, as the house guidelines ask.
- **Dependency audit:** a high or critical advisory in a production dependency fails CI. Two are ignored, by GHSA id
  under `auditConfig` in `pnpm-workspace.yaml`: the critical tinypool advisories (GHSA-5gmw-xhrv-c9v3,
  GHSA-85c8-ppgw-ccpr). pnpm counts them as production only because better-auth declares `vitest` as an optional
  peer and pnpm links it to our test runner; `wrangler deploy --dry-run` bundles no vitest or tinypool code. The
  moderate advisories left (esbuild in drizzle-kit, vitest and its mocker in the same test-runner path, uuid in
  exceljs) do not fail the check. Remove an ignore once the test runner moves to vitest 4.1.12 or later.
- **Security review on every pull request:** `.github/workflows/security-review.yml` runs Anthropic's
  `claude-code-security-review` Action (pinned by commit) and comments on what it finds. It reviews only branches
  pushed to this repository (the Action is not hardened against prompt injection) and skips Renovate's bumps. What
  it should not report is in `docs/security/false-positive-filtering.txt`, which replaces the Action's defaults:
  update it when a control here changes. It needs the `ANTHROPIC_API_KEY` repository secret.
- **Lint and format:** `pnpm lint` runs `biome check`: Biome's recommended rules and its formatter (`biome.json`: two
  spaces, double quotes, 160 characters; markdown and `wrangler.jsonc` are left as written). `pnpm format` rewrites
  files to match. Errors, and any file not formatted, fail CI. Some recommended rules are lowered to warnings because fixing them changes how the app
  behaves, so each fix needs its own review: React keys and hook dependencies (`noArrayIndexKey`,
  `useExhaustiveDependencies`), the accessibility rules that fire today, and two idioms the code uses on purpose
  (`noAssignInExpressions` for `??=` and `while ((m = re.exec(s)))`, `useIterableCallbackReturn` for
  `forEach((x) => set.add(x))`). `apps/web/index.html` is exempt from `noInnerDeclarations` because its inline
  script is pinned by hash in the security policy. Other findings are suppressed one line at a time, with the reason.
- **Dependencies:** Renovate (`renovate.json`) opens one pull request of minor and patch updates each Monday
  morning, India time; 0.x packages and majors come on their own. Security updates open at once. Nothing merges
  automatically.
- **Locally:** the real Worker runs with `api-local` in `.claude/launch.json` (see the README for the command).
- **Every release,** once it is turned on (see open work): the Deploy workflow (`.github/workflows/deploy.yml`)
  deploys each merge to staging and checks it; live goes out only after a reviewer approves, with the control plane
  backed up (encrypted) first.
- **After every release**, on staging and on app, office and console.office.snilld.in, `sh tools/admin/smoke.sh
  <address>` runs these checks (the Deploy workflow runs it after each deploy):

  ```sh
  curl -sI https://app.office.snilld.in/ | grep -iE "content-security|strict-transport|x-frame"
  curl -s -o /dev/null -w "%{http_code}\n" https://app.office.snilld.in/api/office          # 401
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://app.office.snilld.in/api/offices \
    -H "content-type: application/json" -H "origin: https://example.com" -d '{}'            # 403
  ```

## Open work

In priority order. The private review's tracker holds the detail.

| Work | Why |
| --- | --- |
| A restricted Infisical `prod` environment, and rotating what has been in `dev` | Live secrets sit in the shared development environment. The code is ready (each deploy target takes its own token from its own environment); the owners create `staging` and `prod` and move the secrets |
| Confirm Cloudflare stamps `Authentication-Results` on every inbound message (send one test email) | The inbound-email controls rely on it |
| Turnstile site key and secret before any office turns on the website chat | Without them the chat is closed on live |
| A Cloudflare rate-limit rule on `/api/auth/*` (optional; the free plan allows one) | A layer in front of the Worker's own limits |
| Give the India bucket's key list and delete permission (not only put) before setting `INDIA_BACKUP_*` | A purged office's copies in India cannot be deleted without it |
| Bring the privacy notice in line with self-serve deletion and the eight-year retained copy; publish it as a new version | It still says deletion is completed within 30 days, and that books are erased 30 days after an office is deleted |
| Encrypt the office's live files in R2 with the office's key | R2 encrypts at rest, but with Cloudflare's key: anyone with the bucket can read them |
| A command to load an opened backup into a new office | Restoring books is an engineering step today |
| Turn on staging and the Deploy workflow: the staging resources, the GitHub `staging` and `live` environments (live with required reviewers) and their secrets | Releases still go out from a laptop. The code is ready: `env.staging`, `.github/workflows/deploy.yml`, and a backup before every migration that stops the deploy if it fails (`docs/handbook/04-deployment.md`, section 7) |
| Branch protection on `main` requiring the CI checks; then the lint warnings (React keys and hook dependencies, accessibility) | Checks only gate a merge once they are required |
| The three accessibility problems the end-to-end run lists as known (`e2e/support/axe.ts`: room links on the floor, chart marks in the Boardroom, contrast of inactive routines) | Serious under WCAG 2.1 AA; the run fails on any new one |
| Withdraw an invitation by its id, not the invitee's email in the URL path | Cloudflare's own request logs keep paths for 3 days |
| Alerts on the structured logs: a Workers Issues automation and monitors for error rate, 5xx, failed exports, backups to India and nightly runs, and the CPU limit | The logs, with request and office ids, are in place (`docs/handbook/04-deployment.md`, section 9); the alerts are set up in the Cloudflare dashboard by an owner |
| Split `OfficeService` and the Durable Object's router | Large files slow review |
| Rotatable root key for platform tokens; drop `mockServiceWorker.js` from the live build; move `PLATFORM_OWNERS` out of `wrangler.jsonc` | Remaining low findings |
| An external penetration test and a DPDP Act gap review | Before the first enterprise customer |

**Parked:** the Cloudflare Workers Paid plan, and with it 600,000 password-hash iterations
(`docs/handbook/06-roadmap.md`).
