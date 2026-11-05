import type { Platform, PostMetrics, PostVariant, SocialMessage } from "@office/contracts";
import type { IncomingMessage } from "@office/engine";

/** What a platform gave back at sign-in, kept encrypted in the Office. `account` is the id posts are made as. */
export type Tokens = {
  access: string;
  refresh: string | null;
  /** Epoch milliseconds, when the platform says. */
  expiresAt: number | null;
  account: string;
  /** Platform-specific ids, such as the Facebook Page or the WhatsApp phone number. */
  extra: Record<string, string>;
};

/** A picture or video at a public, short-lived link, which Instagram and Threads fetch themselves. */
export type SignedMedia = { id: string; url: string; kind: "image" | "video"; alt: string; contentType: string };

export type Connected = { tokens: Tokens; handle: string; followers: number | null };

export type Pulled = { messages: IncomingMessage[]; metrics: { externalId: string; metrics: PostMetrics }[] };

export type AppKeys = { id: string; secret: string };

/** Each platform speaks through one of these; the Office never sees a platform's API. */
export interface ChannelAdapter {
  readonly platform: Platform;
  /** The platform's sign-in page. `verifier` is set for platforms that use PKCE. */
  authorizeUrl(o: { state: string; redirect: string; verifier: string }): Promise<string>;
  /** Finishes sign-in: swaps the code for tokens and reads who we are posting as. */
  exchange(o: { code: string; redirect: string; verifier: string }): Promise<Connected>;
  publish(t: Tokens, v: PostVariant, media: SignedMedia[]): Promise<{ externalId: string; url: string | null }>;
  reply(t: Tokens, to: SocialMessage, text: string): Promise<{ externalId: string | null }>;
  /** New comments and messages, and the latest numbers for posts we published. */
  pull(t: Tokens, o: { since: string; externalIds: string[] }): Promise<Pulled>;
  /** Long-lived tokens that can be renewed are renewed before they lapse. */
  refresh?(t: Tokens): Promise<Tokens>;
  /** A paid template message to everyone who opted in. WhatsApp only. */
  broadcast?(t: Tokens, o: { template: string; language: string; text: string; audience: string[] }): Promise<{ sent: number; failed: number }>;
}

export type FailureKind = "rate_limited" | "expired" | "retry" | "final" | "not_set_up";

/** A platform said no. `kind` decides what the Office does next: stop, ask to reconnect, try later or give up. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

/** Meta reports expired tokens as code 190 and throttling as 4, 17, 32 or 613, whatever the HTTP status. */
const META_EXPIRED = new Set([190, 102]);
const META_THROTTLED = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006, 80008, 130429, 131048, 131056]);

/** Maps a platform's error answer to what the Office should do about it. */
export function failure(status: number, body: unknown, headers?: Headers): PlatformError {
  const err = (body as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
  const detail = (body as { detail?: string; title?: string; message?: string } | null) ?? {};
  const message = (err?.message ?? detail.detail ?? detail.message ?? detail.title ?? `HTTP ${status}`).slice(0, 240);
  const retryAfter = Number(headers?.get("retry-after")) || null;
  if (status === 429 || (err?.code !== undefined && META_THROTTLED.has(err.code))) return new PlatformError(message, "rate_limited", retryAfter);
  if (status === 401 || (err?.code !== undefined && META_EXPIRED.has(err.code))) return new PlatformError(message, "expired");
  if (status >= 500 || status === 408) return new PlatformError(message, "retry", retryAfter);
  return new PlatformError(message, "final");
}

/** One call to a platform: JSON in and out, errors classified. */
export async function call<T>(f: Fetch, url: string, init: RequestInit & { json?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  let res: Response;
  try {
    res = await f(url, { ...init, headers, body });
  } catch (e) {
    throw new PlatformError(`Could not reach the platform: ${e instanceof Error ? e.message : String(e)}`, "retry");
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text.slice(0, 240) };
  }
  if (!res.ok || (parsed as { error?: unknown } | null)?.error) throw failure(res.status, parsed, res.headers);
  return parsed as T;
}

export const notSetUp = (platform: string, names: string[]) => new PlatformError(`${platform} is not set up for this office yet: add ${names.join(" and ")} as Worker secrets.`, "not_set_up");
