# Subprocessors

> **Draft for legal review.** Version 2026-11-06. We give [30] days' notice on this page, and by email to owners, before adding a subprocessor.

These are the companies that receive personal data so that Agentic Office can work, and what each one receives.

| Company | Service | What it receives | Where | Always used? |
| --- | --- | --- | --- | --- |
| Cloudflare, Inc. | Workers and Durable Objects (the application and each office's storage) | Everything in Agentic Office | Cloudflare's global network | Yes |
| Cloudflare, Inc. | D1 (accounts, sign-ins, offices, memberships, consent records, audit) | Account data | Cloudflare's global network | Yes |
| Cloudflare, Inc. | R2 (documents, pictures, voice notes) | Files the business uploads or emails in | Cloudflare's global network | Yes |
| Cloudflare, Inc. | Workers AI (reading documents, transcribing voice notes, translating, understanding customer messages) | The text, images or audio being read; inference only, not used for training | Cloudflare's global network | When an agent reads something |
| Cloudflare, Inc. | Email Routing | Email to the office's addresses | Cloudflare's global network | Yes |
| Resend, Inc. | Sending email (confirmations, invitations, reminders, digests, replies to customers) | Recipient's address, the message | [The region of the snilldai.com domain in Resend; confirm in the Resend dashboard] | Yes |
| Cloudflare, Inc. | Turnstile (website chat check) | The visitor's browser signals | Cloudflare's global network | Only when turned on |
| Meta Platforms, Inc. | WhatsApp Business Platform (Cloud API) | Messages to and from linked owners and the business's customers, phone numbers, voice notes | Meta's data centres | When WhatsApp is used |
| Meta Platforms, Inc. | Facebook, Instagram and Threads APIs | Posts, comments, messages and page insights for connected accounts | Meta's data centres | Only for connected platforms |
| LinkedIn Corporation | LinkedIn API | Posts and their results for a connected page | LinkedIn's data centres | Only when connected |
| X Corp. | X API | Posts and their results for a connected account | X's data centres | Only when connected |
| MET Norway (Norwegian Meteorological Institute) | Weather forecast API (api.met.no), forecast data under CC BY 4.0 | A location rounded to about ten kilometres, and our service's name; no account or office data | Norway | Only for people who choose the Lived-in look |

Meta, LinkedIn and X also process the data under their own terms, because the business holds its own account with them.
