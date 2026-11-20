# 0007. Copies of the books are envelope-encrypted

- **Status:** accepted
- **Date:** 2026-11-20 (`7f12af7`)
- **Deciders:** founders

## Context

Copies of an office's books leave its Durable Object: the daily copy in India (0008) and the copy retained for eight
years after a purge. They sit in buckets whose keys other people and services hold, so the storage's own encryption is
not enough.

## Decision

Each copy is sealed with a fresh AES-256-GCM data key, wrapped by the office's own key, an HKDF subkey of
`SOCIAL_TOKEN_KEY` and the office id; the header is bound in as additional data (`apps/api/src/envelope.ts`,
`sealedCopy` in `apps/api/src/backup.ts`). Without `SOCIAL_TOKEN_KEY` no copy is made and a purge is refused.
`tools/admin/open-backup.mjs` opens one; the handbook (configuration, section 4d) says how to restore.

## Consequences

- A leaked bucket or key for the bucket does not expose books.
- Losing `SOCIAL_TOKEN_KEY` loses every copy; it must be kept and backed up in Infisical. A versioned root key for
  rotation is open work.
- Live files in R2 are not yet encrypted with the office's key (open work in `docs/security/README.md`).
