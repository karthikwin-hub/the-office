# 0008. A daily copy in India for rule 3(5)

- **Status:** accepted (code done; the bucket is an owner step)
- **Date:** 2026-11-06 (`fdd3b8f`)
- **Deciders:** founders

## Context

Rule 3(5) of the Companies (Accounts) Rules 2014 asks a company that keeps its books electronically for a backup on
servers physically in India, taken every day. Cloudflare offers an India location only on its enterprise Data
Localisation Suite.

## Decision

Each office writes a copy of its books and edit log every morning, after its morning round, to an S3-compatible bucket
in an Indian region (`backupToIndia` in `apps/api/src/office-agent.ts`; `putObject` with AWS Signature Version 4 in
`apps/api/src/backup.ts`). The copy is sealed first (0007). Settings shows the last copy or its failure. A purged
office's copies are deleted by the nightly cron (`eraseBackups` in `apps/api/src/app.ts`).

## Consequences

- Until the `INDIA_BACKUP_*` settings exist, no copy is made and Settings tells each company so.
- The bucket's key needs put, list and delete on that bucket only.
- Whoever runs the bucket in India holds sealed copies, and must be named as a subprocessor once chosen.
