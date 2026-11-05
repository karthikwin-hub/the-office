# Review: Paperclip

> **In one paragraph.** [Paperclip](https://github.com/paperclipai/paperclip) (paperclipai/paperclip, MIT licence) is an open-source control plane for running a "company" of AI agents: an org chart, a task manager, budgets, approvals, schedules and skills wrapped around whatever agents you bring (Claude Code, Codex, Cursor, Gemini and others). It is very popular (about 111,000 stars and 18,000 forks within eight months) and aimed at technical operators who run many agents, mostly on software and content work. The overlap with The Office is in ideas, not in product: both hire agents into roles, gate their work behind approvals and isolate organisations. The Office is a finished product for a non-technical owner, with the books, the source documents and the tax rules built in. Paperclip is a general-purpose engine that expects you to supply the agents, the models and the domain. Paperclip's software is free, but running it is not: every agent's work is paid for in model usage or subscriptions. We should adopt eight of its operational ideas (listed below), not its code or its positioning.

## 1. What it is

| Aspect | Paperclip |
| --- | --- |
| Tagline | "The open-source app everyone uses to manage agents at work"; "If OpenClaw is an employee, Paperclip is the company" |
| Core idea | Define business goals, hire a team of agents (CEO, CTO, engineers, marketers), approve their strategy, set budgets, and watch the work from a dashboard |
| Who it is for | People running many coding or general agents at once ("20 Claude Code terminals open"), autonomous-business builders, platform and IT teams |
| How agents run | Agents are external: Claude Code, Codex, Cursor and Cursor Cloud, Gemini CLI, OpenCode, Pi, Hermes, Grok, Kimi, OpenClaw, or any HTTP or CLI process. "If it can receive a heartbeat, it's hired." |
| Delivery | Self-hosted (`npx paperclipai onboard`), Docker, or AWS ECS; a hosted Paperclip Cloud is on a waitlist |
| Maturity | Created March 2026; about 111k stars, 18k forks, 238 contributors, 6,500 open issues; very active |

### The four pillars

1. **Agentic task manager:** tasks with approvals and review gates, routines, verification from diffs, screenshots and tests.
2. **Org chart for agents:** a mixed human and agent org chart, roles, delegation, scoped secrets, organisation boundaries.
3. **Agent employee training:** a skill studio, evals with saved test runs, performance reviews, skill version history.
4. **Agentic OS:** cross-provider runtime, sandboxing, MCP servers and integrations, SSO and role-based access, cost controls, tracing.

### Notable mechanisms

- **Heartbeats:** a database-backed wake-up queue; agents wake for assigned work, messages or schedules.
- **Atomic task checkout:** one assignee and an execution lock per task, so two runs never take the same work.
- **Budgets:** monthly budgets per company and per agent in cents; a warning at 80% and an automatic pause at 100%.
- **Approvals:** hire requests and the CEO's strategy need board approval; outcomes are approve, reject or request revision.
- **Routines:** recurring tasks triggered by cron, webhook or API, each run a tracked task with history.
- **Governance with rollback:** configuration changes are versioned and can be rolled back.
- **Company portability:** export and import an organisation (agents, skills, projects, routines) with secrets scrubbed.
- **Plugins:** out-of-process plugins that add tools, jobs and UI.
- **Connections:** GitHub, Notion, Railway or any MCP server, each action set to Allowed, Ask first or Off.
- **Chat connectors (experimental):** Slack, Discord, Telegram, Microsoft Teams, AgentMail.

## 2. How it is built

| Layer | Technology |
| --- | --- |
| Server | Node.js 24 with Express; TypeScript |
| Database | PostgreSQL through Drizzle ORM; embedded PostgreSQL by default, Docker or hosted Postgres in production |
| Auth | better-auth (the same library The Office uses) |
| UI | React with React Router, Radix UI, Tailwind, Lexical and MDX editors, Mermaid, i18next |
| Models | Vercel AI SDK providers for Anthropic, OpenAI, Google, xAI, Amazon Bedrock and OpenRouter, plus the agents' own harnesses |
| Integrations | Model Context Protocol SDK, chat adapters (Slack, Discord, Teams, Telegram, GitHub), S3 for files, OpenTelemetry tracing, 1Password SDK for secrets |
| Deployment modes | `local_trusted` (no login, loopback only), `authenticated` + `private` (LAN, VPN, Tailscale), `authenticated` + `public` (internet, for example AWS ECS Fargate with RDS Postgres and EFS) |
| Testing | Vitest, Storybook, promptfoo evals, Playwright |

## 3. Overlap with The Office

| Capability | Paperclip | The Office | Overlap |
| --- | --- | --- | --- |
| Hire agents into named roles | Any agent into any role in an org chart | A fixed catalogue of business roles in a Hiring Hall | Concept |
| Human approval of agent work | Approval gates, review stages | The Desk: every change staged with its exact effect | Strong |
| Earned autonomy | Execution policies, pause and resume | Trust levels: Trainee, Trusted, Autonomous | Concept |
| Multiple organisations in one deployment | Companies with scoped access | Offices with membership checks and per-office storage | Strong |
| Audit trail | Durable activity log | Team log per office, control-plane audit | Strong |
| Scheduled work | Routines with history | Every scheduled job is a named routine with pause, run now and 90 days of history (added in Phase 6b) | Yes |
| Costs and budgets | Per agent, per project, with auto-pause | A daily allowance per office, no per-agent cost view | Partial |
| Skills and evals | Skill studio, evals, version history | Engine tests; no evaluation set for reading yet | Partial |
| Mobile | Mobile-ready web | Phone layouts plus WhatsApp in eight languages | Concept |
| Chat channels | Slack, Discord, Teams, Telegram (experimental) | WhatsApp (production), email | Little |
| Domain knowledge | None built in; agents bring it | Books, source documents, GST and TDS, ageing, returns, social posting | None |
| Model cost to the user | Paid by the operator through their agents | Included, on open-weight models | None |

## 4. Where The Office is stronger

1. **A finished product for a non-technical owner.** Paperclip asks the operator to choose agents, models and harnesses and to write goals. The Office asks the owner to name the business and hire the Accounts team.
2. **Every number has a source.** Figures open to the documents and lines behind them. Paperclip verifies work through diffs, screenshots and tests, which suits software, not books.
3. **Deterministic domain logic.** Tax, ageing and returns are computed by tested code; models only read and draft. Paperclip has no domain layer.
4. **Cost to serve near zero.** Open-weight models on Workers AI and Cloudflare's free tier; no per-agent API key or subscription.
5. **Built-in isolation per business.** A Durable Object per office is a stronger boundary than company-scoped checks in one shared Postgres database.
6. **Where owners already are.** WhatsApp in eight languages with voice notes, in production. Paperclip's chat connectors are experimental and target Slack, Discord and Teams.
7. **The accountant as a first-class user.** A read-only seat with exports and the Auditor's questions.

## 5. Where Paperclip is stronger

1. **A general orchestration engine:** any agent, any model, any runtime, with delegation up and down an org chart.
2. **Cost visibility and control:** per-agent and per-project spend with automatic pause.
3. **Training and evaluation:** a skill studio, saved test inputs, evals and version history.
4. **Extensibility:** plugins, MCP servers, connectors with fine-grained permissions.
5. **Governance tooling:** versioned configuration with rollback, approval revisions, organisation export and import.
6. **Community and momentum:** a very large contributor base and ecosystem.

## 6. Ideas to add to our roadmap

| Idea | What it would look like in The Office | Value | Effort | Phase |
| --- | --- | --- | --- | --- |
| Cost meter and budget pause per agent | Each room shows AI calls and estimated cost this month; a warning at 80% of the office's allowance; a pause at 100% with a Desk card to raise it | High: owners and we see what each agent costs | Small | 7 |
| Evaluation sets with saved runs | A saved set of anonymised documents with expected readings; every prompt or model change scored; the score becomes the agent's published accuracy record | High: the basis for promoting agents to Trusted | Medium | 7 |
| "Request revision" on the Desk | A third choice beside Approve and Reject: return the work to the agent with a note | Medium | Small | 7 |
| Anchored comments | Comments on a specific document line or figure, shared by owner and accountant | High for accounting firms | Medium | 8 |
| Routines with history | Digest, reminders, publishing and reorder checks shown as routines with their runs and outcomes | Medium: makes the invisible visible | Small to medium | 6b (done) |
| Versioned agent configuration | Every change to an agent's instructions and trust level recorded, with rollback | Medium | Small | 9 |
| Team templates | Hire "Accounts for a wholesaler" or "Social for a retailer" in one step | Medium for onboarding | Small | 9 |
| Connector permissions | For each outside service: Allowed, Ask first or Off, per agent | Medium, needed once connectors arrive | Medium | 9 |

**Considered and not adopted:**
- *Bring your own agent or model.* It would move cost and complexity to the owner, which is the opposite of our proposition. A bring-your-own-key option may suit large customers later.
- *Org charts with delegation between agents.* Our teams are fixed business roles; the Office Manager already routes between them.
- *Running Paperclip as our orchestration layer.* It needs a Node server and Postgres, which would replace the Durable Object per office (our isolation model) and add a fixed hosting cost. Its value to us is in ideas, not code.

## 7. Paid or free?

| Part | Paperclip | The Office |
| --- | --- | --- |
| Licence | MIT, free to use, modify and resell | Our own code on permissive open-source libraries |
| Core dependencies | Open source: Node.js, Express, PostgreSQL (embedded), Drizzle, better-auth, React | Open source: Hono, Agents SDK, Drizzle, better-auth, React, ExcelJS |
| Hosting | Self-host free on your own machine; cloud hosting is a paid server and database (for example AWS Fargate, RDS, EFS); Paperclip Cloud, a hosted service, is on a waitlist and likely to be paid | Cloudflare free tier for pilots; $5 a month Workers Paid plan beyond |
| The agents' work | **Paid.** Agents are Claude Code, Codex, Cursor, Gemini and others, each needing a paid subscription or API key (Anthropic, OpenAI, Google, xAI, OpenRouter). Free only with local open-weight models through OpenCode or similar, on your own hardware. | **Included.** Open-weight models on Workers AI within a free daily allowance |
| Optional integrations | Some are paid services: 1Password for secrets, sandbox providers, chat platforms' paid tiers | WhatsApp Business conversations (Meta charges per conversation outside the free reply window) |

> **Assessment:** Paperclip is free and open-source software built on a free stack, but it is not free to run in practice. Its model of work assumes paid agents, and the bill for tokens or subscriptions is the operator's main running cost, which is why budgets and auto-pause are among its headline features. The Office is built so that the owner never sees a model bill.

## 8. Summary for decision-makers

- Paperclip is not a competitor for our customer: it serves technical operators of agent fleets, not owners checking their books.
- It is a useful benchmark for operational maturity. Eight of its ideas are now on our roadmap, in Phases 6b to 9; routines with history is already built.
- It confirms two of our design choices: better-auth for identity, and approvals as the centre of the product.
- It is a reminder to keep one thing different: our owners must never need to understand agents, models or budgets to get value.
