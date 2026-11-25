# 0012. Planned social posts go out after a hold the owner can stop

- **Status:** accepted (Phase 6c of the roadmap)
- **Date:** 2026-11-25 (accepted by the founders on 25 November 2026)
- **Deciders:** founders

Number 0011 is taken on another branch (n8n, not adopted).

## Context

ADR 0004 has every agent change wait on the Desk unless the owner's trust level lets routine work through. For social
posts that meant a Desk card per post, which is what keeps owners from using the Social Media Manager: a month is a
dozen posts across several channels. Owners asked for the agent to post on its own, the way Buffer and Postiz post a
queue, while keeping the checks against the books that neither of them has.

## Decision

For the Social Media Manager only, the owner approves the month's plan (the calendar card, which always asks) and the
agent posts inside it on its own, within its trust level:

- **Trusted:** posts from the approved calendar that are unchanged since approval, pass every check again, and state
  no price, percentage or stock count. Posts with such a claim come to the Desk.
- **Autonomous:** the same, with checked claims too.
- **Before any of these goes out**, the morning digest and the activity log list it as going out "unless you stop it",
  and it waits at least two hours after that (`noticeDue`, `publishDue` in `packages/engine/src/office.ts`). A post
  the owner was not told about moves a day on rather than going out unannounced.
- **The owner can stop it** (back to the Desk, held for the owner) **or take it down** once live (deleted through
  Facebook's API; marked, with instructions, where the platform lets no app delete). Either costs the agent one trust
  level; promotion back stays the owner's, in the Hiring hall.
- **The owner's own posts** are approved by writing them: they go out at their time with no Desk card, and the checks
  warn before saving instead of blocking.

Everything else in ADR 0004 is unchanged: campaigns, calendars and WhatsApp broadcasts always ask; model output is
kept only when every figure in it is a cited fact from the books; a trainee's posts all wait on the Desk.

## Consequences

- An agent's post reaches the public without a person looking at that post, only at its plan. The guards are the
  approved plan, the checks against the books at approval and again at posting time, the notice and two-hour hold,
  and the drop in trust after a stop or take-down.
- A wrong or off-brand post is possible at trusted and autonomous levels; it is limited to what the plan covers, and
  owners who want every post on the Desk keep the agent at trainee.
- New social features that publish must go through the calendar's approval or the owner's own hand, and respect the
  hold; a path that posts without either is a defect.
