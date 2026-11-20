# 0001. One Durable Object per office holds its books

- **Status:** accepted
- **Date:** 2026-11-05 (`8daa09e`, the first commit; multi-tenancy in `89f9ab6`)
- **Deciders:** founders

## Context

Each business's books are confidential and must never reach another business. A shared database with an `office_id`
column on every table makes isolation depend on every query remembering a filter. The books also need a single,
consistent writer: agents, people, email and webhooks all change them, often at once.

## Decision

Each office is one `Office` Durable Object (`apps/api/src/office-agent.ts`), named by the office id, with its books in
its own SQLite database. It is the only writer of those books. The Worker reaches it only through `toOffice`
(`apps/api/src/app.ts`), and the Durable Object checks that the caller is for its own id (see 0006). Files sit in R2
under `o/<officeId>/` with keys built by the server (`apps/api/src/keys.ts`).

## Consequences

- There is no query that can return another office's rows: a whole class of isolation bug cannot happen.
- One writer per office removes concurrency problems; requests to one office run one at a time.
- Work across offices (the nightly purge, the console's list) goes through the control plane (0002), never by reading
  books. The operator has no command to read an office's books.
- Each office migrates its own schema on start (`schema_version`), so schema steps must be safe to run on any older
  office, and saved books must keep loading.
- One office's load cannot be spread across machines; the free plan's limits per Durable Object request apply (0005).
