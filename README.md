# Agentic Office by Snilld AI

Called "The Office" in older documents and in code names (`@office/*`, the `the-office` Worker); the public name is set once in `packages/contracts/src/brand.ts`.

AI agents on an office floor plan for a small Indian business. Every figure links to the documents it was added up from, and each agent works under a trust level the owner sets.

- `apps/web`: React app (Vite, TanStack Router and Query). `VITE_DATA=mock` builds the in-browser demo.
- `apps/api`: Cloudflare Worker (Hono), the `Office` Durable Object, better-auth on D1, R2 for documents, Workers AI.
- `packages/contracts`, `packages/engine`, `packages/fixtures`, `packages/ui`: schemas, the books and agents, the Kaveri Electricals sample business, shared components.
- `tools`: synthetic data, screenshots, live end-to-end checks, export verification.

Live: https://office.snilld.in (sign-in at https://console.office.snilld.in, each customer on `<customer>.office.snilld.in`). Demo: https://demo.office.snilld.in. Both run in the Snilld Cloudflare account; the move there is Part 1 of `docs/runbooks/phase-6-go-live.md`.

## New machine

```sh
# Node 22 and pnpm 10 (the repo pins pnpm in package.json)
pnpm install

# Python tooling: synthetic data and export checks
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt

# Secrets live in Infisical, never in files
infisical login
```

The proprietary `pdf` and `xlsx` skills under `.cursor/skills` are not in git; copy them over by hand if you need them.

## Everyday commands

```sh
pnpm dev                 # mock demo in the browser, no backend
pnpm test && pnpm typecheck
pnpm docs                # rebuilds docs/handbook/the-office-handbook.html from the Markdown in docs/handbook

# Live Worker locally, with a fresh office (add --var OFFICE_SEED:sample for the Kaveri sample books).
# --local-upstream keeps requests on localhost (otherwise wrangler rewrites them to the live custom domain and
# sign-in refuses the origin); APP_DOMAIN is cleared for the same reason. Build the web app first (pnpm build) and
# apply migrations (pnpm --filter @office/api run db:migrate:local). Also in .claude/launch.json as "api-local".
cd apps/api && infisical run --env=dev -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_SNILLD_OFFICE" ./node_modules/.bin/wrangler dev --port 8787 --local-upstream localhost:8787 --var BETTER_AUTH_SECRET:$(openssl rand -hex 32) --var SOCIAL_TOKEN_KEY:$(openssl rand -hex 32) --var BETTER_AUTH_URL:http://localhost:8787 --var EMAIL_VERIFICATION:off --var APP_DOMAIN:'

# The same with one address per office: open http://office.localhost:8787 (product page), http://app.office.localhost:8787
# (businesses) and http://console.office.localhost:8787 (platform owners, the addresses in PLATFORM_OWNERS);
# give an office an address with `node tools/admin/admin.mjs subdomain <office> <label> --local`
#   --var BETTER_AUTH_URL:http://app.office.localhost:8787 --var APP_DOMAIN:office.localhost --var PLATFORM_OWNERS:you@example.com
# The mock demo shows the console at http://localhost:5173/?platform.
```

## Deploy

Releases go out from GitHub Actions (`.github/workflows/deploy.yml`): every green push to `main` goes to staging and is checked there; live goes out from Actions → Deploy → Run workflow, after a reviewer approves. Each deploy backs up the control plane before migrating. See `docs/handbook/04-deployment.md`, section 7.

When CI cannot, an owner deploys by hand from their own machine (both builds write to `apps/web/dist`, so one at a time):

```sh
# Staging, then live: build, back up, migrate, deploy
infisical run --env=staging --silent -- sh tools/admin/deploy.sh staging
infisical run --env=prod --silent -- sh tools/admin/deploy.sh live

# Demo (then rebuilds the live app)
infisical run --env=prod --silent -- sh tools/admin/deploy.sh demo
```

Worker secrets (`BETTER_AUTH_SECRET`, `SOCIAL_TOKEN_KEY`, the optional social and WhatsApp keys) are put with `wrangler secret put`. `sh tools/admin/set-secrets.sh live` (or `staging`) creates the two required ones in that Infisical environment if missing and puts them on that Worker, without printing values; run it yourself. See `docs/handbook/05-configuration.md`, section 3.

The handbook for the team and consultants is `docs/handbook/the-office-handbook.html` (open it in a browser, or print to PDF).

## Contributing

Read `AGENTS.md` first (Claude Code loads it through `CLAUDE.md`): the layout, the commands, and the rules every change
follows here. In short: secrets only through Infisical, one commit per item with a test that fails before and passes
after, `pnpm typecheck`, `pnpm lint` and `pnpm test` green, and `/security-review` and `/code-review` on any change to
`apps/api`. Pull requests go against `main`; nobody merges their own or deploys by hand. The decisions behind the design
are in `docs/adr/`; the threat model and the ASVS checklist are in `docs/security/`.
