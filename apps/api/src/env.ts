import type { Office } from "./office-agent";

export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCS: R2Bucket;
  AI: Ai;
  Office: DurableObjectNamespace<Office>;
  MAILER?: SendEmail;
  /** Secret. When set, mail goes through Resend instead of MAILER, from MAIL_FROM on a domain verified there. */
  RESEND_API_KEY?: string;
  DATA_MODE: string;
  /** "sample" opens a new office with the Kaveri Electricals sample books (local testing); otherwise it starts empty. */
  OFFICE_SEED?: string;
  MAIL_FROM: string;
  /** Each office gets `<slug>@INGEST_DOMAIN`; a catch-all Email Routing rule sends that domain's mail to this Worker. */
  INGEST_DOMAIN: string;
  /** "off" lets people open offices and accept invitations without confirming their address (local testing only). */
  EMAIL_VERIFICATION?: string;
  BETTER_AUTH_URL: string;
  /**
   * When set (for example `office.snilld.in`), BETTER_AUTH_URL is where businesses sign in, `app.<APP_DOMAIN>`; the bare domain
   * shows the product page, `console.<APP_DOMAIN>` is the platform owners' console, and an office with a subdomain opens on
   * `<subdomain>.<APP_DOMAIN>`. One sign-in covers them all.
   */
  APP_DOMAIN?: string;
  /** Comma-separated email addresses of the platform owners: they alone can use the console's view of every business. */
  PLATFORM_OWNERS?: string;
  /** Set with `wrangler secret put`, never in a file. */
  BETTER_AUTH_SECRET: string;
  /**
   * Social channels. All are Worker secrets and all are optional: a platform without its keys
   * says so in Settings and its posts go out by hand. SOCIAL_TOKEN_KEY encrypts platform tokens
   * and signs media links and sign-in state.
   */
  SOCIAL_TOKEN_KEY?: string;
  /** The Meta app: Facebook Page and webhook signatures. */
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  /** Instagram API with Instagram login, from the same Meta app's Instagram product. */
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  /** The Threads use case of the Meta app has its own id and secret. */
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  /** WhatsApp Cloud API: a system user token and the business phone number's id; the template is for broadcasts. */
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_TEMPLATE?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  /** The website chat: a per-office, per-visitor limit, and Cloudflare Turnstile when both keys are set. */
  CHAT_LIMIT?: RateLimit;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
};
