# 0005. Stay on the Workers free plan; 600,000 hash iterations parked

- **Status:** accepted (the move to the paid plan is parked)
- **Date:** 2026-11-20 (`0835abf`; the free-plan fit in `12275d0`, `c2c9285`, `a72fa46`)
- **Deciders:** founders (owner's decision of 20 November 2026)

## Context

The free plan allows about 10 ms of CPU and 128 MB per Worker request, 100,000 Worker and 100,000 Durable Object
requests a day, and 30 s of CPU per Durable Object request. OWASP's figure for PBKDF2-SHA256 is 600,000 iterations,
about 110 ms of CPU per hash, which only the paid plan allows.

## Decision

The product stays on the free plan for now, and nothing may depend on the paid plan's CPU. Heavy work runs in the
office's Durable Object (the export as a streamed ZIP, `apps/api/src/export.ts`), and nothing asks the backend on a
timer when it can be told (the `unread` push; the chat widget's back-off). Password hashes take 100,000 PBKDF2
iterations (`ITERATIONS` in `apps/api/src/auth.ts`), chained in rounds Cloudflare accepts.

Parked, not dropped (`docs/handbook/06-roadmap.md`): on the day of the move, raise `ITERATIONS` to 600,000; each hash
is upgraded at the person's next sign-in.

## Consequences

- Passwords are hashed below OWASP's current figure. Two-step sign-in for owners and platform owners, rate limits and a
  10-character minimum carry more of the weight meanwhile. This is a named residual risk in the threat model.
- Every change must fit the CPU budget; a feature that needs more is redesigned or waits for the move.
