# 0009. Releases go from CI, through staging

- **Status:** accepted (the GitHub environments are an owner step)
- **Date:** 2026-11-20 (`d61c2fc` staging, `e7d11d9` the Deploy workflow)
- **Deciders:** founders

## Context

Releases went out from a laptop with production secrets on it, with no staging and no backup before a migration.

## Decision

Staging is a Worker of its own (`env.staging` in `apps/api/wrangler.jsonc`), with its own D1, R2 and secrets. The
Deploy workflow (`.github/workflows/deploy.yml`) deploys every green push to `main` to staging and checks it with
`tools/admin/smoke.sh`; live goes out from the same workflow after a reviewer approves the `live` environment. Each
deploy (`tools/admin/deploy.sh <staging|live|demo>`) backs up the control plane first and stops if the backup fails.
Each target takes its tokens from its own environment.

## Consequences

- No one needs production secrets on a laptop for a normal release; a hand deploy remains for when CI cannot.
- Branch protection, the GitHub environments and their reviewers are settings the owners make; until then the gate
  is by convention.
- Agents never deploy (`AGENTS.md`).
