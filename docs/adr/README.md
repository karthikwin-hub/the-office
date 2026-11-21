# Architecture decision records

Short records of the decisions that shape Agentic Office: what was decided, why, and what it costs. Copy
`0000-template.md` to the next number for a new one. A decision that changes is not edited away: write a new record
and mark the old one superseded.

Dates come from the git history: the first commit that carries the decision. The repository's history starts on
5 November 2026, so the earliest decisions are older than their date says.

| No. | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-durable-object-per-office.md) | One Durable Object per office holds its books | Accepted | 2026-11-05 |
| [0002](0002-d1-control-plane.md) | A D1 control plane that holds no books | Accepted | 2026-11-05 |
| [0003](0003-pdf-reading-in-the-browser.md) | PDF text layers are read in the browser | Accepted | 2026-11-05 |
| [0004](0004-agents-stage-owners-approve.md) | Agents stage changes; owners approve | Accepted | 2026-11-05 |
| [0005](0005-workers-free-plan.md) | Stay on the Workers free plan; 600,000 hash iterations parked | Accepted | 2026-11-20 |
| [0006](0006-sealed-caller-header.md) | The Worker seals the caller it sends to an office | Accepted | 2026-11-20 |
| [0007](0007-envelope-encrypted-backups.md) | Copies of the books are envelope-encrypted | Accepted | 2026-11-20 |
| [0008](0008-india-backup-rule-3-5.md) | A daily copy in India for rule 3(5) | Accepted | 2026-11-06 |
| [0009](0009-releases-from-ci-via-staging.md) | Releases go from CI, through staging | Accepted | 2026-11-20 |
| [0010](0010-reading-any-file.md) | Reading any file: convert, recognise, map | Proposed | 2026-11-21 |
