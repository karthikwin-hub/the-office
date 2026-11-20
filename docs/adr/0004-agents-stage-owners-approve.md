# 0004. Agents stage changes; owners approve

- **Status:** accepted
- **Date:** 2026-11-05 (`8daa09e`; the Customer Service agent's fixed reply shape in `e04b9ef`)
- **Deciders:** founders

## Context

Agents act on untrusted input: bills, email, WhatsApp messages, website chat and model output. A model can be wrong or
be steered by text inside a document. The books are legal records, and the owner answers for them.

## Decision

Every change an agent proposes is a staged item on the Desk, with a link to its source. It is applied when a person
approves it, or when the owner has set the agent's trust level to let routine work through
(`packages/engine/src/office.ts`, `routine`: trusted agents under ₹1 lakh with every check passed, autonomous agents
for routine and unusual work). Some kinds always wait for the owner whatever the trust level (`ALWAYS_ASK`: email replies, payroll,
shared files, campaigns, broadcasts, hand-overs, bringing in existing books, compliance actions and more). Accountants may decide only some kinds
(`packages/engine/src/dispatch.ts`). Models answer in a fixed JSON shape (`MODEL_SCHEMA`, `CS_SCHEMA`); amounts and tax
come from the engine, and the Customer Service agent never sends model-written text to a customer.

## Consequences

- A wrong reading or a steered model produces a wrong proposal, not a wrong ledger.
- Trust levels are the owner's decision and each automatic step is recorded in the team log; raising one widens what
  goes through unseen.
- New agent features must stage; a direct write path from an agent or a model is a defect.
