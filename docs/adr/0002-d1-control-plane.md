# 0002. A D1 control plane that holds no books

- **Status:** accepted
- **Date:** 2026-11-05 (`89f9ab6`, "Many businesses, one Office: each office is its own tenant")
- **Deciders:** founders

## Context

Some questions span offices: who is this person, which offices are theirs, which office does this email address or
webhook belong to, which offices are deleted and due for purging. The books cannot answer them (0001).

## Decision

A small shared D1 database is the control plane (`apps/api/src/tenancy.ts`, `apps/api/src/schema.ts`,
`apps/api/migrations/`): accounts and sessions (better-auth), offices, memberships and roles, invitations (hash only),
inbound routes, WhatsApp links, consent and rights requests, backup erasures and the office audit trail. It never
holds books, documents or their contents. New migrations only add tables and columns; the two early exceptions
(a table renamed in `0002_tenancy.sql`, short-lived codes emptied in `0007_wa_join_guard.sql`) are not repeated.

## Consequences

- Membership is checked against D1 on every office request, never cached, so removing someone takes effect at once.
- The control plane is the one shared store, so its queries must stay parameterised (Drizzle and bound statements)
  and every query that touches an office names its id.
- Every deploy backs up D1 before it migrates (`tools/admin/deploy.sh`, 0009). Migrations must keep the running
  Worker working, because the old and new Worker overlap for a few seconds.
- D1 also holds the sign-in rate-limit counts, so limits hold across isolates.
