# AGENTS.md

For coding agents and new engineers. Rules and pointers only; the detail lives in the docs linked below.

## What this is

Agentic Office (code name The Office, `@office/*`) keeps the books of small Indian businesses: AI agents on an office
floor plan read bills, sales and messages, and stage changes that the owner approves. Every figure links to the
documents it came from. The books are confidential: each business ("office") is a tenant that must never see another.

- One Cloudflare Worker (Hono) serves the React app and the API, signs people in and routes each request to its office.
- One `Office` Durable Object per business holds its books in its own SQLite database and is their only writer.
- D1 is the control plane (accounts, sessions, memberships, invitations, routes, audit); it holds no books.
- R2 holds files under `o/<officeId>/`; Workers AI reads documents; the engine computes every amount.

Architecture: `docs/handbook/03-architecture.md`. Decisions: `docs/adr/`. Security: `docs/security/README.md`,
`docs/security/threat-model.md`, `docs/security/asvs.md`.

## Layout

| Path | Holds |
| --- | --- |
| `apps/api` | The Worker (`src/app.ts`), sign-in (`src/auth.ts`), the control plane (`src/tenancy.ts`), the `Office` Durable Object (`src/office-agent.ts`), D1 migrations (`migrations/`), tests (`test/`, workerd tests in `test/do/`) |
| `apps/web` | The React app (Vite, TanStack Router and Query); `VITE_DATA=mock` builds the in-browser demo |
| `packages/contracts` | Every entity and API body as a zod schema, and the route table |
| `packages/engine` | The books and the agents as pure TypeScript, no Cloudflare dependency |
| `packages/fixtures` | The Kaveri Electricals sample business |
| `packages/ui` | Shared components with Storybook stories |
| `tools` | Admin tool, deploy scripts, docs builders, synthetic data, screenshots, end-to-end checks |
| `docs` | Handbook, reference guide, ADRs, security, legal, runbooks |

## Commands

Node 22 and pnpm 10 (pinned in `package.json`).

```sh
pnpm install
pnpm typecheck            # tsc in every package
pnpm lint                 # biome check: lint and format; CI fails on either
pnpm format               # biome format --write; run before committing
pnpm test                 # every package; apps/api also runs the workerd Durable Object tests
pnpm dev                  # the mock demo, no backend
pnpm build                # the live web app (the Worker serves apps/web/dist)
pnpm docs                 # docs/handbook/*.md -> docs/handbook/the-office-handbook.html
pnpm docs:reference       # docs/reference/agentic-office-reference.md -> docs/reference/index.html
```

The real Worker runs locally as `api-local` in `.claude/launch.json` (the full command is in the README). Migrations
apply locally with `pnpm --filter @office/api run db:migrate:local`.

## Rules that hold here

- **Secrets only through Infisical** (`infisical run --env=dev -- ...`). Never create `.env` or `.dev.vars`, never
  print a secret, never put one in a file, a log or a test fixture.
- **Never read or commit `docs/data_samples/` or `backups/`.** They hold real client data and control-plane exports.
- **Workers free plan.** About 10 ms of CPU per Worker request. Heavy work (exports, reading, imports, routines)
  happens in the office's Durable Object, and nothing polls when it can be told. Nothing may need the paid plan
  (`docs/adr/0005-workers-free-plan.md`).
- **Migrations only add.** New D1 migrations add tables and columns; never drop or rewrite one that has shipped. A
  Durable Object's own schema steps run once, keyed by `schema_version` in `office-agent.ts`.
- **Agents stage every write.** An agent's change becomes a staged item on the Desk; it is applied when the owner
  approves it, or by a trust level the owner set (`packages/engine/src/office.ts`, `routine`). Never add a path that
  lets a model or an agent write to the books directly.
- **Tenancy.** Every Worker call into an office goes through `toOffice` (`apps/api/src/app.ts`), which sets and seals
  the caller; the Office refuses an unsealed caller or one for another office. Membership is checked on every request.
  R2 keys are built by the server (`apps/api/src/keys.ts`), never from a client path. Never trust a caller header,
  role or office id that came from a browser, an email or a webhook.
- **One commit per item, with a test** that fails before the change and passes after it. `pnpm typecheck`,
  `pnpm lint` and `pnpm test` pass before a pull request.
- **Review.** Run `/security-review` and `/code-review` in Claude Code on any change to `apps/api`, and fix or note
  what they find in the pull request.
- **Never merge, push to `main`, deploy or run `db:migrate --remote`.** Releases go from CI through staging
  (`docs/handbook/04-deployment.md`, section 7).
- **Public repository.** Docs describe controls and name open risks, never how to exploit one.

## Working guidelines

Before building anything new, adding agent tooling, or starting a long task, read the house guidelines,
`best_practices/GUIDELINES.md` (kept outside this repository; ask the founders for it). This repository's own rules
win where they differ. In short:

1. **Reuse first.** Look in this repo's `packages/` and `tools/`, then the installed dependencies, before writing new
   code. Playwright with axe for browser tests; the Cloudflare Vitest plugin for Workers tests, not hand-made mocks.
2. **Think before coding; simplicity first; surgical changes; goal-driven execution.** State assumptions, write the
   least code, touch only what the task needs, and turn the task into a check that passes or fails.
3. **Spend fewer tokens.** Run the free checks first and pass on only the failures; filter large output; find code by
   symbol; keep this file short.
4. **Agent tooling.** Read a skill, hook or MCP server before installing it, pin it, and never let a tool merge,
   deploy or write `AGENTS.md` or `CLAUDE.md` on its own.
