# The Office

AI agents on an office floor plan for a small Indian business. Every figure links to the documents it was added up from, and each agent works under a trust level the owner sets.

- `apps/web`: React app (Vite, TanStack Router and Query). `VITE_DATA=mock` builds the in-browser demo.
- `apps/api`: Cloudflare Worker (Hono), the `Office` Durable Object, better-auth on D1, R2 for documents, Workers AI.
- `packages/contracts`, `packages/engine`, `packages/fixtures`, `packages/ui`: schemas, the books and agents, the Kaveri Electricals sample business, shared components.
- `tools`: synthetic data, screenshots, live end-to-end checks, export verification.

Live: https://the-office.the-office-agents.workers.dev · Demo: https://the-office-mock.the-office-agents.workers.dev

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

# Live Worker locally, with a fresh office (add --var OFFICE_SEED:sample for the Kaveri sample books)
cd apps/api && infisical run --env=dev -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS" ./node_modules/.bin/wrangler dev --port 8787 --var BETTER_AUTH_SECRET:$(openssl rand -hex 32) --var SOCIAL_TOKEN_KEY:$(openssl rand -hex 32) --var BETTER_AUTH_URL:http://localhost:8787'
```

## Deploy

Both builds write to `apps/web/dist`, so build and deploy one at a time.

```sh
# Live
pnpm build
cd apps/api && infisical run --env=dev -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS" ./node_modules/.bin/wrangler d1 migrations apply office --remote && ./node_modules/.bin/wrangler deploy'

# Demo
pnpm build:mock
cd apps/api && infisical run --env=dev -- sh -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_OFFICE_AGENTS" ./node_modules/.bin/wrangler deploy -c ../web/wrangler.mock.jsonc'
```

Worker secrets (`BETTER_AUTH_SECRET`, `SOCIAL_TOKEN_KEY`, the optional social and WhatsApp keys) are put with `wrangler secret put`; see the comment in `apps/api/wrangler.jsonc`. `sh tools/admin/set-secrets.sh` creates the two required ones in Infisical if missing and puts them on the live Worker, without printing values; run it yourself.

The handbook for the team and consultants is `docs/handbook/the-office-handbook.html` (open it in a browser, or print to PDF).
