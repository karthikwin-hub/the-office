# 0006. The Worker seals the caller it sends to an office

- **Status:** accepted
- **Date:** 2026-11-20 (`9f07316`; the unsealed caller header dates from `8daa09e`)
- **Deciders:** founders, after the security review of 19 November 2026

## Context

The Worker checks the session and the membership, then tells the office who is asking in a header. If anything other
than the Worker could set that header, it could claim any person, role or office. The office's own `/internal/*`
routes (mail, webhooks, export, purge) must be reachable only by the Worker.

## Decision

`toOffice` (`apps/api/src/app.ts`) builds the caller from the checked membership, drops any browser header that could
claim a role, and adds `x-office-caller-seal`: an HMAC of the caller under an HKDF subkey of `BETTER_AUTH_SECRET`
(`apps/api/src/caller-seal.ts`). The office (`callerOf`, `onRequest` in `apps/api/src/office-agent.ts`) answers 401
without a valid seal, 404 for a caller of another office, and 404 on `/internal/*` for anyone but the system caller.

## Consequences

- A bug in one Worker route cannot hand one office's books to another; the office checks again.
- Every new Worker-to-office call must go through `toOffice`. Tests in `apps/api/test/do/` check the seal in workerd.
- Rotating `BETTER_AUTH_SECRET` rotates the seal key and signs everyone out. During a deploy, an old isolate's request
  may be refused for a few seconds.
