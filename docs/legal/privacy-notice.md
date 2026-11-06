# Privacy notice

> **Draft for legal review.** Written in plain language for a lawyer in India to check before real businesses are invited. Text in [square brackets] must be completed. Version 2026-11-06.

This notice explains what Agentic Office does with personal data: what it collects, why, where it is kept, for how long, who else sees it, and what you can do about it. It is a separate document from the [terms of service](/legal/terms) so that you can read it on its own.

## Who we are, and our two roles

Agentic Office is run by [legal name of the company], [registered address], India ("we").

We have two different roles, and this notice says which one applies to each piece of data.

- **For your account** (your name, email address, password, the offices you belong to, your WhatsApp link and your preferences) we decide why and how the data is used. Under India's Digital Personal Data Protection Act, 2023 we are the **data fiduciary** for it.
- **For a business's books and its customers' messages** we act on the business's instructions. The business is the data fiduciary towards its own customers, suppliers and staff, and we are its **data processor**. The [data processing terms](/legal/data-processing) set out what we do for the business.

If you are a customer of a business that uses Agentic Office and you want your data corrected or deleted, ask that business first. We will help it answer you.

## What we collect, and why

| Data | Whose | Why we use it | Where it is kept | How long | Shared with |
| --- | --- | --- | --- | --- | --- |
| Name, email address, password (stored only as a hash) | You | To create your account and sign you in | Cloudflare D1 | Until your account is deleted | Cloudflare (hosting) |
| Sign-in sessions, IP address, browser | You | To keep you signed in and to protect accounts | Cloudflare D1 | Sessions: 7 days, renewed while you use the office. Security records: 1 year | Cloudflare |
| Which offices you are in, your role, invitations | You | To show you only the offices you belong to | Cloudflare D1 | While you are a member, and in the office's audit record for 1 year after | Cloudflare |
| Your acceptance of these documents (version, date, country) | You | To prove what you agreed to | Cloudflare D1 | As long as the account exists, then 1 year | Cloudflare |
| Your WhatsApp number, if you link it | You | To send you the digest and let you approve work on WhatsApp | Cloudflare D1 and the office's storage | Until you unlink it | Meta (WhatsApp Cloud API) |
| Your preferences (theme, language, digest) | You | To remember how you like the office | The office's storage | While you are a member | Cloudflare |
| Your approximate location (an area about ten kilometres across), only if you choose the Lived-in look | You | To mention the local weather in the team's small talk | Not kept; the forecast is cached for an hour against the area, not against you | One hour | MET Norway (the Norwegian Meteorological Institute) receives the area, not who you are |
| The business's books: bills, invoices, payments, stock, payroll, parties | The business, its customers, suppliers and staff | To run the business's accounts, as the business asks | The office's storage (Cloudflare Durable Objects) | For the life of the office, and 30 days after it is deleted | Cloudflare |
| Documents the business uploads or emails in (PDFs, photos) | The business and the people named in them | To read bills and invoices into the books | Cloudflare R2 | For the life of the office, and 30 days after it is deleted | Cloudflare; Cloudflare Workers AI reads them |
| Customer conversations (WhatsApp, email, website chat) | The business's customers | To answer customers and hand questions to the business | The office's storage | 12 months by default; the business can choose 3 to 36 months | Cloudflare; Meta for WhatsApp; Cloudflare Workers AI reads them |
| Social media posts, comments and messages | The business and people who write to it | To publish posts and keep the inbox | The office's storage | For the life of the office | Meta, LinkedIn or X, only for the platforms the business connects |
| Voice notes sent to the office on WhatsApp | You | To turn them into text and act on them | The office's storage (the transcript); the audio in Cloudflare R2 | As the business's documents | Meta, Cloudflare Workers AI |

We do not sell personal data, use it for advertising, or build profiles of people.

## AI in Agentic Office

Several agents in Agentic Office read text with AI models run by Cloudflare Workers AI. They read bills and invoices, transcribe and translate WhatsApp voice notes, and work out what a customer's message is about.

- The models are used for **inference only**. Cloudflare does not use what they read to train models, and neither do we.
- The Customer Service agent **does not write its own replies**. It answers only from the business's saved answers, the business facts the owner wrote, and lookups in the books (an order's status, an invoice balance). Anything else goes to a person at the business.
- Customers are told in the first message that they are talking to an AI assistant, and how to reach a person.
- Anything that changes the books, spends money or sends something on the business's behalf waits for a person to approve it, unless the owner has chosen to trust that agent with routine work.

## WhatsApp, email and social media

- **WhatsApp.** Messages go through Meta's WhatsApp Business Platform. Meta processes them under its own terms and privacy policy. We send customers only replies to messages they sent, inside WhatsApp's 24-hour window, and never use the conversations for anything except answering them.
- **Email.** Mail sent to an office's addresses is received and sent through Cloudflare Email Routing.
- **Social platforms.** When a business connects Facebook, Instagram, Threads, LinkedIn or X, we keep the platform's sign-in token encrypted, and fetch and publish only what the business's features need.

## Where the data is

Agentic Office runs on Cloudflare's global network. Data may be stored and processed outside India, including in the European Union and the United States. We rely on Cloudflare's security and transfer commitments, listed with every other company that receives data in the [subprocessors list](/legal/subprocessors).

## How long we keep it

- **The business's books and documents:** for as long as the office exists, and 30 days after the owner deletes it, so that a mistake can be undone. Then they are erased.
- **Customer conversations:** 12 months by default, deleted each morning once they are older than the period the business chose.
- **Your account:** until you delete it. Your name may stay in an office's audit record (who approved what) for as long as the business must keep its accounts.
- **Security records** (sign-ins, refused requests, audit of changes): 1 year.
- **Backups:** Cloudflare keeps point-in-time copies of the databases for up to 30 days. Data deleted from Agentic Office leaves those copies within 30 days.

## Your rights

You can, at any time:

- **Get a copy** of your account data: Settings, Your account, "Download my data".
- **Correct** your name or email address in Settings, or ask us.
- **Delete your account**: Settings, Your account, "Delete my account". We confirm and complete it within [30] days. If you are the only owner of an office, hand it to someone else or delete the office first.
- **Withdraw consent** to anything that relies on it, such as the WhatsApp link (unlink it in Settings) or the digest. Withdrawing does not affect what was done before.
- **Nominate** someone to act for you if you die or cannot act yourself, by writing to the grievance officer.
- **Complain** to us, and if you are not satisfied with our answer, to the **Data Protection Board of India**.

## Grievance officer

[Name], [designation]
Email: [grievance@domain]
Address: [postal address]

We acknowledge a grievance within [48 hours] and answer within [30 days].

## Children

Agentic Office is for businesses and the people who work in them. It is not meant for anyone under 18, and we do not knowingly hold a child's account.

## Security

Every office is kept apart from every other, in its own storage. Passwords are stored only as hashes; platform tokens are encrypted; and all traffic is encrypted in transit. If a breach affects your data, we tell you and the businesses concerned without delay, and the Data Protection Board as the law requires.

## Changes

When this notice changes, its version date changes and you are asked to read it again the next time you sign in.
