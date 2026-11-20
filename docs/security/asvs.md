# ASVS 4.0.3 Level 2 checklist

Agentic Office against the OWASP Application Security Verification Standard 4.0.3, Level 2. Written 20 November 2026
against `main` at `8abeccd`, from the code and tests, not from a test run against live. Each relevant requirement has a
status and its evidence; code paths are under `apps/api/src/` and tests under `apps/api/test/` unless they say
otherwise. Requirements that cannot apply (SOAP, GraphQL, LDAP, XPath, unmanaged memory, physical authenticators) are
summed up at the end of their chapter.

**Met**: the control is in place, with code and usually a test. **Partly**: in place with a named gap. **Not met**:
missing. **N/A**: does not apply here. Gaps are named, never how to exploit them; the open work and its order are in
`docs/security/README.md`, the threats in `docs/security/threat-model.md`.

Update a row in the same pull request that changes its control.

## Summary

| Chapter | Met | Partly | Not met | N/A (rows) |
| --- | --- | --- | --- | --- |
| V1 Architecture | 30 | 8 | 0 | 0 |
| V2 Authentication | 29 | 4 | 6 | 3 |
| V3 Session management | 11 | 2 | 2 | 0 |
| V4 Access control | 9 | 0 | 0 | 0 |
| V5 Validation, sanitisation and encoding | 21 | 2 | 0 | 4 |
| V6 Stored cryptography | 10 | 4 | 0 | 0 |
| V7 Errors and logging | 7 | 3 | 2 | 0 |
| V8 Data protection | 9 | 7 | 0 | 0 |
| V9 Communications | 4 | 3 | 0 | 0 |
| V10 Malicious code | 2 | 2 | 0 | 0 |
| V11 Business logic | 6 | 0 | 2 | 0 |
| V12 Files and resources | 13 | 1 | 1 | 0 |
| V13 API and web service | 9 | 1 | 0 | 0 |
| V14 Configuration | 17 | 7 | 0 | 0 |

## V1 Architecture, design and threat modelling

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 1.1.1 | Secure development lifecycle | Met | `AGENTS.md`; CI on every pull request (`.github/workflows/ci.yml`); review and test per change |
| 1.1.2 | Threat modelling for design changes | Met | `docs/security/threat-model.md` |
| 1.1.3 | Security constraints in user stories | Partly | Constraints live in the handbook and ADRs, not in each story |
| 1.1.4 | Trust boundaries and data flows documented | Met | Threat model, section 3; handbook `03-architecture.md` |
| 1.1.5 | High-level architecture and remote services documented | Met | Handbook `03-architecture.md`; `docs/adr/` |
| 1.1.6 | Centralised, vetted security controls | Met | `edge.ts` (headers, origin), the `/api/*` and `/api/o/:office/*` middleware in `app.ts`, `toOffice` |
| 1.1.7 | Secure coding checklist available | Met | `AGENTS.md`, this file |
| 1.2.1 | Components run with least privilege | Partly | Worker bindings scope each store; one Worker holds every binding |
| 1.2.2 | Communication between components authenticated | Met | Sealed caller (`caller-seal.ts`, ADR 0006). Test: `test/do/internal.test.ts` |
| 1.2.3 | One vetted authentication mechanism | Met | better-auth (`auth.ts`) |
| 1.2.4 | All authentication pathways equally strong | Partly | WhatsApp acts for a person through a phone linked by a one-time code from a signed-in session (`whatsapp/links.ts`); email through a proven sender (`inbound.ts`); both stage, neither approves owner-only kinds by itself |
| 1.4.1 | Access control enforced at trusted points | Met | Worker middleware, then the office (`onRequest` in `office-agent.ts`) |
| 1.4.4 | One vetted access control mechanism | Met | Membership in D1 plus role checks in `packages/engine/src/dispatch.ts` |
| 1.4.5 | Feature- or attribute-based access control | Met | Roles, office status, freshness, two-step (`app.ts`) |
| 1.5.1 | Input and output requirements defined | Met | zod schemas in `packages/contracts` |
| 1.5.2 | No serialisation with untrusted clients | Met | JSON only, parsed by zod |
| 1.5.3 | Input validation on a trusted layer | Met | Worker and office validate every body |
| 1.5.4 | Output encoding near the interpreter | Met | React rendering; bound SQL parameters |
| 1.6.1 | Key management policy | Met | Keys derived per purpose and office (`social/tokens.ts` `subkey`) from a versioned root key (`keyring.ts`); rotation in handbook 05, section 3a |
| 1.6.2 | Key material protected | Met | Worker secrets from Infisical; never in files or logs |
| 1.6.3 | Keys replaceable | Partly | Token key version exists (`KEY_VERSION`); a versioned root key is open work |
| 1.6.4 | Client-side secrets treated as insecure | Met | No secret ships to the browser; Turnstile uses a public site key |
| 1.7.1 | Common logging format | Met | One structured line per event, with request and office ids (`apps/api/src/log.ts`) |
| 1.7.2 | Logs sent to a remote system | Met | Workers observability (`apps/api/wrangler.jsonc`) |
| 1.8.1 | Sensitive data identified | Met | Threat model, section 1; `docs/legal/` |
| 1.8.2 | Protection levels per class | Partly | Copies sealed (ADR 0007); live files under the provider's key |
| 1.9.1 | Communications between components encrypted | Met | HTTPS outside; Cloudflare's internal transport for bindings |
| 1.9.2 | Each side verifies the other | Met | Seal on Worker-to-office; signatures on webhooks; SigV4 to the India bucket |
| 1.10.1 | Source control with traceable changes | Met | Git, pull requests, one commit per item |
| 1.11.1 | Business flows documented | Met | Handbook, reference guide flow diagrams |
| 1.11.2 | High-value flows not on unsynchronised state | Met | One writer per office (ADR 0001) |
| 1.12.2 | Uploaded files served safely | Met | `fileHeaders` in `edge.ts`. Test: `edge.test.ts` "stored files" |
| 1.14.1 | Components of different trust segregated | Met | Durable Object per office; control plane apart |
| 1.14.2 | Signed binaries, trusted connections | Partly | Lockfile and registry; actions pinned where it matters; no signature checks of packages |
| 1.14.3 | Pipeline flags outdated or insecure components | Met | `pnpm audit` blocking in CI; Renovate (`renovate.json`) |
| 1.14.4 | Build pipeline deploys automatically and securely | Partly | `.github/workflows/deploy.yml` ready; its environments are an owner step |
| 1.14.5 | Deployments sandboxed | Met | Workers isolates; one Durable Object per office |
| 1.14.6 | No unsupported client technology | Met | Plain web platform |

## V2 Authentication

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 2.1.1 | Passwords at least 12 characters | Not met | Minimum is 10 (`auth.ts`, `minPasswordLength`) |
| 2.1.2 | Passwords of 64+ characters allowed, at most 128 | Met | better-auth default maximum of 128 |
| 2.1.3 | No truncation | Met | The whole password goes into PBKDF2 (`auth.ts`) |
| 2.1.4 | Any printable Unicode allowed | Met | No character rules |
| 2.1.5 | Users can change their password | Partly | Through the emailed reset link (`apps/web/src/app/SignIn.tsx`); no change form in Settings |
| 2.1.6 | Change requires the current password | Partly | The reset link stands in for it; with no change form there is nothing else to check |
| 2.1.7 | Checked against breached passwords | Not met | Open |
| 2.1.8 | Strength meter | Not met | Open |
| 2.1.9 | No composition rules | Met | Length only |
| 2.1.10 | No forced rotation | Met | None |
| 2.1.11 | Paste and password managers allowed | Met | Plain `type="password"` fields |
| 2.1.12 | Option to show the password | Not met | Open |
| 2.2.1 | Anti-automation on sign-in | Met | D1 rate limits per `cf-connecting-ip` (`auth.ts`). Test: `auth.test.ts` "the sign-in rate limit" |
| 2.2.2 | Weak authenticators limited | Met | Email links only confirm addresses and reset passwords; the second step is TOTP or a backup code |
| 2.2.3 | Notification after authentication changes | Met | Mail when two-step sign-in is turned on or off (`step-up.ts`), on a sign-up attempt with an existing address, and with every reset link |
| 2.3.1 | System-generated initial secrets random and short-lived | Met | Invitation tokens single use, 14 days, hash stored (`tenancy.ts`); reset links one hour |
| 2.3.2 | Enrolment of user-provided devices supported | Met | Any TOTP app (`twoFactor` plugin) |
| 2.3.3 | Renewal instructions sent in time | N/A | No expiring authenticators |
| 2.4.1 | Passwords stored with a salted one-way KDF | Met | PBKDF2-SHA256 (`auth.ts`). Test: `auth.test.ts` "password hashes" |
| 2.4.2 | Salt at least 32 bits, unique | Met | 16 random bytes per hash |
| 2.4.3 | PBKDF2 at least 100,000 iterations | Met | 100,000, chained (`ITERATIONS`); 600,000 parked (ADR 0005) |
| 2.4.4 | bcrypt work factor | N/A | PBKDF2 is used |
| 2.4.5 | Extra iteration with a secret salt (pepper) | Not met | Open |
| 2.5.1 | Recovery secrets not sent in clear | Met | A one-hour link, never a password |
| 2.5.2 | No hints or knowledge questions | Met | None |
| 2.5.3 | Recovery never reveals the password | Met | Passwords are only hashed |
| 2.5.4 | No shared or default accounts | Met | None; the system caller exists only inside the Worker-to-office seal |
| 2.5.5 | Notification when a factor changes | Met | Mail when two-step sign-in is turned on or off (`step-up.ts`); a password reset signs the person out everywhere |
| 2.5.6 | Secure forgotten-password flow | Met | Reset link, sessions revoked (`revokeSessionsOnPasswordReset`); two-step still asked at sign-in |
| 2.5.7 | Lost second factor: proof as strong as enrolment | Partly | Ten single-use backup codes; beyond them recovery is by the platform owners, by hand |
| 2.6.1 | Backup codes used once | Met | better-auth `twoFactor` backup codes, single use |
| 2.6.2 | Backup codes random enough | Met | Generated by better-auth from WebCrypto randomness |
| 2.7.1 | No SMS or phone for out-of-band | Met | Not used for authentication |
| 2.8.1 | Time-based codes have a lifetime | Met | TOTP 30 s windows |
| 2.8.3 | Approved algorithms for codes | Met | TOTP (RFC 6238) via better-auth |
| 2.8.4 | A code used only once in its window | Partly | Sign-in codes are checked by better-auth, step-up codes by `createOTP` in `step-up.ts`; neither path has a test for reuse |
| 2.8.5 | Reuse of a code logged and notified | Not met | Open (see V7) |
| 2.8.6 | Physical one-time-password devices revocable | N/A | None used |
| 2.10.1 | Service secrets not static passwords | Met | API keys and HMAC keys as Worker secrets |
| 2.10.2 | No default credentials for services | Met | None |
| 2.10.3 | Service secrets protected | Met | Infisical; `wrangler secret put` (`tools/admin/set-secrets.sh`) |
| 2.10.4 | No secrets in source | Met | None in the repository; CI security review checks each change |

Not applicable: 2.7.2–2.7.6 and 2.9 (no out-of-band or cryptographic authenticators).

## V3 Session management

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 3.1.1 | No session tokens in URLs | Met | Cookies only; invitation tokens after `#` (`inviteLink` in `app.ts`) |
| 3.2.1 | New token at sign-in | Met | better-auth |
| 3.2.2 | At least 64 bits of entropy | Met | better-auth random session tokens |
| 3.2.3 | Stored securely in the browser | Met | HttpOnly cookies |
| 3.2.4 | Tokens from approved randomness | Met | WebCrypto |
| 3.3.1 | Sign-out ends the session | Met | `signOut` (`apps/web/src/app/Offices.tsx`) |
| 3.3.2 | Re-authentication after 12 hours or 30 idle minutes | Partly | Ends after 12 idle hours; a session in use is renewed hourly with no absolute limit (`auth.ts`, `session`). Risky actions need a sign-in within 15 minutes |
| 3.3.3 | Option to end other sessions after a password change | Met | A reset ends every session |
| 3.3.4 | Users can see and end their sessions | Not met | Open |
| 3.4.1 | Secure attribute | Met | better-auth on HTTPS |
| 3.4.2 | HttpOnly | Met | better-auth |
| 3.4.3 | SameSite | Met | better-auth (Lax) |
| 3.4.4 | `__Host-` prefix | Not met | Cookies are shared across the office subdomains (`crossSubDomainCookies` in `auth.ts`), which `__Host-` forbids |
| 3.4.5 | Path set narrowly when sharing a domain | Partly | Path `/`; the parent domain serves only this product |
| 3.7.1 | Fresh session or step-up before sensitive actions | Met | `freshOnly`, `platformOnly` (`app.ts`), `step-up.ts`. Test: `tenancy.test.ts` "a fresh sign-in for the riskier owner actions" |

Not applicable: 3.5.1–3.5.3 (no bearer or stateless tokens), 3.6 (no federated sign-in).

## V4 Access control

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 4.1.1 | Enforced on a trusted service layer | Met | Worker middleware and the office (`app.ts`, `office-agent.ts`) |
| 4.1.2 | User and data attributes not changeable by users | Met | The caller is built and sealed by the Worker; `role` is not an input field (`auth.ts`, `input: false`) |
| 4.1.3 | Least privilege | Met | Owner and accountant roles (`packages/engine/src/dispatch.ts`); platform owners cannot read books |
| 4.1.5 | Fails securely | Met | Anything unexpected is 404 or 403. Test: `tenancy.test.ts` "answers 404 … for every office route" |
| 4.2.1 | Direct object references protected | Met | Membership per request; keys from the checked office id (`keys.ts`). Test: `tenancy.test.ts` "one office cannot reach another" |
| 4.2.2 | CSRF protection | Met | `sameOrigin` in `edge.ts`. Test: `edge.test.ts` "changes come only from the app's own pages" |
| 4.3.1 | Administrative interfaces use multi-factor | Met | Console needs two-step (`platformOnly`) |
| 4.3.2 | Directory browsing off; no metadata exposed | Met | R2 never listed to clients; static assets only from the build |
| 4.3.3 | Extra authorisation for high-value actions | Met | Step-up; `ALWAYS_ASK` kinds wait for the owner (`packages/engine/src/office.ts`) |

Requirement 4.1.4 is deleted in 4.0.3.

## V5 Validation, sanitisation and encoding

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 5.1.1 | HTTP parameter pollution | Met | Bodies parsed by zod; query values read once |
| 5.1.2 | Mass assignment | Met | zod schemas pick fields; patch schemas through `changeOf` (`packages/contracts/src/customer.ts`) |
| 5.1.3 | Positive validation | Met | zod on every request body; id patterns (`OFFICE_ID`, `WIDGET_KEY`) |
| 5.1.4 | Structured data strongly typed | Met | zod |
| 5.1.5 | Redirects only to allowed places | Met | Channel callbacks return to the app's own path; posted links must be `https:` (`packages/contracts/src/api.ts`, `MarkPosted`) |
| 5.2.1 | Rich text sanitised | N/A | No rich-text input |
| 5.2.2 | Unstructured data sanitised | Met | Length caps and types on chat and messages |
| 5.2.3 | Input to mail systems sanitised | Met | `oneLine` in `mail.ts`. Test: `worker.test.ts` "mail" |
| 5.2.4 | No `eval` or dynamic code | Met | None in the Worker; the widget script embeds values as JSON |
| 5.2.5 | Template injection | Met | No server-side templates |
| 5.2.6 | SSRF | Partly | Outbound requests go to fixed hosts, except an owner's calendar address, which must be a public `https:` host (`calendarUrl` in `assistant.ts`); a stricter check is open work. The Workers runtime has no route to a private network |
| 5.2.7 | SVG content sanitised or not scriptable | Met | SVG never served inline (`fileHeaders`) |
| 5.2.8 | Expression-language injection | N/A | None |
| 5.3.1 | Output encoding per context | Met | React; JSON responses |
| 5.3.2 | Encoding preserves the user's character set | Met | UTF-8 throughout |
| 5.3.3 | Context-aware escaping against XSS | Met | React, strict CSP. Test: `edge.test.ts` "security headers" |
| 5.3.4 | Parameterised queries | Met | Drizzle and bound `sql.exec` statements (`tenancy.ts`, `office-agent.ts`) |
| 5.3.5 | No string-built queries | Met | As above |
| 5.3.6 | JSON injection | Met | `JSON.stringify` only |
| 5.3.8 | OS command injection | N/A | No shell in the Worker |
| 5.3.9 | File inclusion | Met | Server-built keys (`keys.ts`) |
| 5.3.10 | XPath or XML injection | N/A | None |
| 5.5.1 | Serialised objects integrity-checked | Met | Sealed copies (AES-GCM, `envelope.ts`); OAuth state signed (`social/oauth.ts`) |
| 5.5.2 | XML parsers restrictive | Partly | XLSX is read with size checks while unzipping (`packages/engine/src/sales/sheets.ts`); parser settings not reviewed against external entities |
| 5.5.3 | No untrusted deserialisation | Met | `JSON.parse` then zod |
| 5.5.4 | `JSON.parse`, not `eval` | Met | Everywhere |
| Extra | Model output treated as untrusted input | Met | Fixed JSON shapes (`MODEL_SCHEMA`, `CS_SCHEMA`), engine checks, staged approval (ADR 0004) |

Not applicable: 5.3.7 (LDAP), 5.4.1–5.4.3 (memory-safe runtime).

## V6 Stored cryptography

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 6.1.1 | Regulated private data encrypted at rest | Partly | Copies of the books and stored files sealed per office (`envelope.ts`, `files.ts`); live books in the Durable Object, and files stored before 20 November 2026, under the provider's encryption |
| 6.1.3 | Regulated financial data encrypted at rest | Partly | As 6.1.1 |
| 6.2.1 | Cryptography fails securely | Met | Authenticated encryption; opening fails on change (`envelope.ts`, `social/tokens.ts`) |
| 6.2.2 | Vetted algorithms and libraries | Met | WebCrypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, PBKDF2 |
| 6.2.3 | IVs, modes and padding configured correctly | Met | Random 96-bit IVs per encryption, AES-GCM with associated data |
| 6.2.4 | Algorithms and keys replaceable | Met | Format markers (`OFB1`), `KEY_VERSION`, and the root key's id on everything sealed (`keyring.ts`) |
| 6.2.5 | No insecure algorithms | Met | MD5 only as the S3 protocol's integrity field for batch delete (`backup.ts`), not for security |
| 6.2.6 | Nonces not reused | Met | Fresh random IVs; a fresh data key per copy |
| 6.2.7 | Encrypted data authenticated | Met | AES-GCM with the header as associated data |
| 6.3.1 | Randomness from a CSPRNG | Met | `crypto.getRandomValues`, `crypto.randomUUID` |
| 6.3.2 | Random GUIDs | Met | Document ids are UUID v4 (`newDocId` in `caller.ts`). Test: `edge.test.ts` "document ids" |
| 6.3.3 | Enough entropy under load | Met | Platform CSPRNG |
| 6.4.1 | Secrets management solution | Partly | Infisical and Worker secrets; a restricted production environment is an owner step |
| 6.4.2 | Key material not exposed | Met | Keys live only in Worker secrets and derived `CryptoKey`s |

Not applicable: 6.1.2 (no health data).

## V7 Error handling and logging

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 7.1.1 | No credentials or session tokens in logs | Met | Log lines are named events with ids and counts; tokens travel only in bodies and cookies |
| 7.1.2 | No other sensitive data in logs | Partly | Lines take named fields only and free text is scrubbed (`log.ts`, `test/log.test.ts`); Cloudflare's invocation logs keep URL paths, and withdrawing an invitation puts the invitee's email in one |
| 7.1.3 | Security-relevant events logged | Partly | Office audit trail (`tenancy.ts`), edit log, `wa.join.paused`; sign-in failures are not logged by us |
| 7.1.4 | Enough detail for a timeline | Met | Request id (Cloudflare's ray id, `x-request-id`) and office id on the Worker's and the office's lines (`log.ts`) |
| 7.2.1 | Authentication decisions logged | Not met | Open (structured logs) |
| 7.2.2 | Access-control failures logged | Not met | Open (structured logs) |
| 7.3.1 | Log injection prevented | Met | Each line is an object of named fields; events and ids are checked for shape (`log.ts`) |
| 7.3.3 | Logs protected | Met | Cloudflare observability, account access only |
| 7.3.4 | Time sources synchronised | Met | Platform clock |
| 7.4.1 | Generic error messages | Met | "Something went wrong in the office" (`onRequest` in `office-agent.ts`); `app.onError` answers "Something went wrong. Try again." (`log.ts`) |
| 7.4.2 | Exceptions handled throughout | Met | Each route returns its own error; the office reopens the books on failure |
| 7.4.3 | Last-resort handler | Partly | The office catches every request; the Worker relies on Hono's default handler |

## V8 Data protection

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 8.1.1 | Sensitive data not cached by intermediaries | Met | Files `cache-control: private`; API responses behind a session |
| 8.1.2 | Server-side copies protected and purged | Partly | Exports in parts expire after 30 minutes (`export.ts`); retained copies purged by date |
| 8.1.3 | Minimal parameters per request | Met | zod schemas |
| 8.1.4 | Abnormal request volume detected | Met | Rate limits, quotas, mail and chat caps (`quota.ts`, `inbound.ts`, `app.ts`) |
| 8.1.5 | Regular backups (Level 3, recorded anyway) | Met | Daily India copy (ADR 0008); control plane backed up before each deploy (`tools/admin/deploy.sh`) |
| 8.1.6 | Backups stored securely (Level 3, recorded anyway) | Met | Sealed (ADR 0007); release backups age-encrypted |
| 8.2.1 | Anti-caching headers on sensitive data | Partly | Files and media `private`; JSON API responses rely on defaults |
| 8.2.2 | No sensitive data in browser storage | Partly | Preferences and an invitation token (24 hours) in localStorage; books only in memory |
| 8.2.3 | Client storage cleared at sign-out | Partly | Sign-out drops the invitation token and reloads; preferences stay |
| 8.3.1 | Sensitive data in bodies or headers, not URLs | Met | Invitation tokens after `#` and in bodies. Signed media links and chat visitor ids are in URLs by design |
| 8.3.2 | Users can remove or export their data | Met | Export, office deletion, account deletion (`account.ts`). Test: `tenancy.test.ts` "a person's own rights" |
| 8.3.3 | Clear language on collection and use | Partly | `docs/legal/privacy-notice.md`; it needs bringing in line with self-serve deletion |
| 8.3.4 | Sensitive data identified, with a policy | Met | Threat model, section 1; `docs/legal/data-processing.md` |
| 8.3.5 | Access to sensitive data audited | Partly | Exports and admin changes audited; reads are not |
| 8.3.7 | Encrypted with approved algorithms when required | Partly | Copies and platform tokens sealed; live files open work |
| 8.3.8 | Retention and deletion by policy | Met | 30-day purge, eight-year retained copy, nightly sweep (`nightly` in `app.ts`). Test: `test/do/purge.test.ts` |

Not applicable: 8.3.6 (memory cannot be wiped in JavaScript).

## V9 Communications

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 9.1.1 | TLS for all client connections | Met | Cloudflare edge; HSTS with subdomains (`BASE_HEADERS` in `edge.ts`) |
| 9.1.2 | Strong TLS configuration | Partly | Cloudflare's edge; the minimum version is a zone setting, not in the repository |
| 9.1.3 | Old TLS versions off | Partly | As 9.1.2 |
| 9.2.1 | Trusted certificates on outbound TLS | Met | `fetch` to `https:` hosts only |
| 9.2.2 | Encrypted connections to back ends | Met | All outbound calls HTTPS; bindings on Cloudflare's network |
| 9.2.3 | Connections to external systems authenticated | Met | API keys, SigV4 (`backup.ts`), Meta signatures |
| 9.2.5 | Back-end TLS failures logged | Partly | Failures are caught and shown (for example the India copy in Settings); not all are logged |

Not applicable: 9.2.4 (revocation checking is the platform's).

## V10 Malicious code

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 10.2.1 | No unauthorised data collection | Met | Only Cloudflare Web Analytics, listed in the CSP and the privacy notice |
| 10.2.2 | No unneeded device permissions | Met | `Permissions-Policy` denies them (`edge.ts`) |
| 10.3.2 | Integrity of third-party code | Partly | npm lockfile and audit; Turnstile and Web Analytics scripts load from Cloudflare without SRI, as their providers require |
| 10.3.3 | Subdomain takeover | Partly | DNS sits in the Cloudflare account; no automated check |

Not applicable: 10.3.1 (no client auto-update).

## V11 Business logic

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 11.1.1 | Steps in order | Met | Staged items move pending to approved or rejected (`packages/engine/src/office.ts`) |
| 11.1.2 | Realistic timing | Met | Rate limits on sign-in, JOIN codes, chat and mail |
| 11.1.3 | Limits per action and user | Met | Quotas per office (`quota.ts`); office opening limit (`OPEN_LIMIT` in `tenancy.ts`) |
| 11.1.4 | Anti-automation | Met | Turnstile on the chat; D1 rate limits |
| 11.1.5 | Business limits validated | Met | ₹1 lakh trusted limit, `ALWAYS_ASK` (`office.ts`); export caps (`export.ts`) |
| 11.1.6 | No race conditions in sensitive flows | Met | One writer per office (ADR 0001); a failed request reopens the books. Test: `test/do/rollback.test.ts` |
| 11.1.7 | Unusual activity monitored | Not met | Alerts open (structured logs) |
| 11.1.8 | Alerts on automated attacks | Not met | Open; limits refuse, but nobody is told |

## V12 Files and resources

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 12.1.1 | Large files refused | Met | 10 MB per mail attachment and WhatsApp document; 250 MB a day per office (`mail.ts`, `whatsapp/office.ts`, `quota.ts`) |
| 12.1.2 | Compressed files checked before and while unzipping | Met | `packages/engine/src/sales/sheets.ts`. Test: `packages/engine` sheet tests |
| 12.1.3 | Quota per user | Met | Per office (`quota.ts`). Test: `tenancy.test.ts` "quotas" |
| 12.2.1 | File type checked against content | Met | `filetype.ts`. Test: `filetype.test.ts` |
| 12.3.1 | Filenames not used as paths | Met | Server-built keys (`keys.ts`) |
| 12.3.2 | Filenames validated against traversal | Met | Ids match fixed patterns (`/api/o/:office/files/:id` in `app.ts`) |
| 12.3.3 | No remote inclusion from filenames | Met | As above |
| 12.3.4 | Reflected file download prevented | Met | Filename stripped of quotes and line breaks, RFC 5987 encoding (`fileHeaders`) |
| 12.3.5 | No file metadata in OS commands | Met | No shell |
| 12.3.6 | No code from untrusted sources | Met | None |
| 12.4.1 | Files stored outside the web root | Met | R2, served only through checked routes |
| 12.4.2 | Uploaded files scanned for malware | Not met | Open; files never run in the app's origin |
| 12.5.1 | Only expected file types served | Met | Static assets from the build; stored files through `fileHeaders` |
| 12.5.2 | Uploads never executed as HTML or script | Met | `Content-Security-Policy: sandbox`, `nosniff`, attachment for other types. Test: `edge.test.ts` "stored files" |
| 12.6.1 | Outbound requests to an allow-list | Partly | See 5.2.6 |


## V13 API and web service

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 13.1.1 | Same encoding throughout | Met | JSON, UTF-8 |
| 13.1.3 | No secrets in API URLs | Partly | Session and invitation secrets never in URLs; signed media links carry a short-lived signature by design |
| 13.1.4 | Authorisation at route and resource | Met | Membership, then role in the engine |
| 13.1.5 | Unexpected content types refused | Met | `BODY_TYPES` in `edge.ts` |
| 13.2.1 | Only allowed methods per route | Met | Hono routes by method; others 404 (`app.ts`) |
| 13.2.2 | Schema validation of JSON | Met | zod |
| 13.2.3 | CSRF protection for cookie-based APIs | Met | `sameOrigin` (`edge.ts`) |
| 13.2.5 | Content type checked | Met | As 13.1.5 |
| 13.2.6 | Message integrity for webhooks | Met | HMAC over the raw body (`social/webhooks.ts`). Test: `social.test.ts` "Meta webhooks" |
| Extra | The live WebSocket authenticated and read-only | Met | Same path and checks as the API; app Origin required; client messages close it. Test: `test/do/live.test.ts` |

Not applicable: 13.3 (SOAP), 13.4 (GraphQL).

## V14 Configuration

| Req | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 14.1.1 | Secure, repeatable builds | Met | pnpm lockfile, CI (`.github/workflows/ci.yml`) |
| 14.1.3 | Server configuration hardened | Partly | Worker headers and limits in code; zone settings outside the repository |
| 14.1.4 | Automated, reproducible deployment | Partly | `deploy.yml` and `tools/admin/deploy.sh` ready; GitHub environments are an owner step |
| 14.1.5 | Integrity of security configuration checked | Met | Tests pin the CSP hash and `_headers` (`edge.test.ts`) and the deploy targets (`release.test.ts`) |
| 14.2.1 | Components up to date | Met | Renovate, blocking audit |
| 14.2.2 | Unneeded features removed | Met | `mockServiceWorker.js` ships only in the demo builds (`mockWorkerOnlyInDemo` in `apps/web/vite.config.ts`; test `apps/web/src/build.test.ts`) |
| 14.2.3 | SRI on external assets | Partly | See 10.3.2 |
| 14.2.4 | Components from trusted sources | Met | npm registry, lockfile |
| 14.2.5 | Inventory of third-party libraries | Partly | `pnpm-lock.yaml` lists every package and version; no published SBOM |
| 14.2.6 | Attack surface reduced by sandboxing | Met | Workers isolates; sandboxed file serving |
| 14.3.2 | Debug modes off in production | Met | `DATA_MODE=live`; rate limits on in live (`auth.ts`) |
| 14.3.3 | No version details in headers | Met | None added |
| 14.4.1 | Content-Type with charset | Met | Hono JSON and text helpers |
| 14.4.2 | `Content-Disposition` on API responses | Partly | Files and the export are attachments (`fileHeaders`); JSON API responses carry none, with `API_CSP` instead |
| 14.4.3 | Content-Security-Policy | Met | `appCsp`, `API_CSP`, `FILE_CSP` (`edge.ts`) |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Met | `BASE_HEADERS` |
| 14.4.5 | HSTS | Met | `BASE_HEADERS` |
| 14.4.6 | Referrer-Policy | Met | `BASE_HEADERS` |
| 14.4.7 | Framing restricted | Met | `frame-ancestors 'none'` |
| 14.5.1 | Only needed HTTP methods | Met | Route table |
| 14.5.2 | Origin not used for authentication | Met | Origin is a cross-site guard on top of the session, never in place of it (`sameOrigin`) |
| 14.5.3 | CORS allow-list | Met | `*` only on the cookie-less chat API; nowhere else |
| 14.5.4 | Proxy-added headers trusted only when authenticated | Met | Caller seal; `cf-connecting-ip` only |
| Extra | Production configuration separate from development | Partly | Separate Workers and environments in code; production secrets environment is an owner step |

Not applicable: 14.1.2 (no native compilation).
