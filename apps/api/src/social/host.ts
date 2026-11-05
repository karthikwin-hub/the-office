import type { Channel, Platform } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import type { OfficeService, SocialEffect } from "@office/engine";
import { type ChannelAdapter, PlatformError, type Tokens } from "./adapter";
import { signedMedia } from "./media";
import type { TokenVault } from "./tokens";

export const MAX_ATTEMPTS = 4;
const REFRESH_BEFORE_MS = 7 * 86_400_000;
const PULL_WINDOW_MS = 30 * 86_400_000;

export type Retry = { attempt: number; notBefore: number };
export type Adapters = Partial<Record<Platform, ChannelAdapter>>;

/** What to do after a platform refused: try again later, or stop and say why. */
export function afterFailure(e: PlatformError, attempt: number, now: number): { retryAt: number } | { stop: { rateLimited?: boolean; expired?: boolean; final?: boolean; manual?: boolean } } {
  if (e.kind === "rate_limited") return { stop: { rateLimited: true } };
  if (e.kind === "expired") return { stop: { expired: true } };
  if (e.kind === "not_set_up") return { stop: { manual: true } };
  if (e.kind === "retry" && attempt < MAX_ATTEMPTS) {
    const wait = Math.min(e.retryAfterSeconds ?? 60 * 4 ** (attempt - 1), 3600);
    return { retryAt: now + wait * 1000 };
  }
  return { stop: { final: true } };
}

type Kv = (k: string, v?: string) => string | null;

/**
 * Carries the Office's social effects out to the platforms and brings answers back in.
 * The Office decides; this only calls the adapters and reports what happened.
 */
export class SocialHost {
  constructor(
    private readonly office: OfficeService,
    private readonly vault: TokenVault,
    private readonly adapters: Adapters,
    private readonly opts: { base: string; officeId: string; mediaSecret: string | undefined; kv: Kv; now?: () => number },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private get retries(): Record<string, Retry> {
    return JSON.parse(this.opts.kv("social_retries") ?? "{}") as Record<string, Retry>;
  }

  private setRetries(r: Record<string, Retry>) {
    this.opts.kv("social_retries", JSON.stringify(r));
  }

  private channel(id: string): Channel | undefined {
    return this.office.books.channels.find((c) => c.id === id);
  }

  /** Demo books arrive with channels marked connected; without tokens here, they are not. */
  reconcile(): void {
    for (const ch of this.office.books.channels) {
      if (ch.mode !== "connected" || this.vault.has(ch.id)) continue;
      ch.mode = "manual";
      ch.status = "manual";
      ch.lastError = null;
    }
  }

  private async tokens(ch: Channel): Promise<Tokens | null> {
    const t = await this.vault.get(ch.id);
    const a = this.adapters[ch.platform];
    if (!t || !a?.refresh || !t.expiresAt || t.expiresAt - this.now() > REFRESH_BEFORE_MS) return t;
    try {
      const fresh = await a.refresh(t);
      await this.vault.put(ch.id, fresh);
      return fresh;
    } catch (e) {
      if (t.expiresAt > this.now()) return t;
      throw e;
    }
  }

  async run(effects: SocialEffect[]): Promise<void> {
    for (const e of effects) {
      if (e.kind === "publish") await this.publish(e.postId, e.channelId);
      else if (e.kind === "reply") await this.reply(e.messageId, e.channelId, e.text);
      else await this.broadcast(e.postId, e.channelId);
    }
  }

  private async ready(channelId: string): Promise<{ ch: Channel; a: ChannelAdapter; t: Tokens } | { problem: PlatformError; ch: Channel | undefined }> {
    const ch = this.channel(channelId);
    const a = ch ? this.adapters[ch.platform] : undefined;
    if (!ch || !a) return { problem: new PlatformError(`${ch ? PLATFORM_NAMES[ch.platform] : "This channel"} cannot publish from here yet`, "not_set_up"), ch };
    try {
      const t = await this.tokens(ch);
      if (!t) return { problem: new PlatformError("No sign-in is stored for this channel; connect it again in Settings", "not_set_up"), ch };
      return { ch, a, t };
    } catch (e) {
      return { problem: e instanceof PlatformError ? e : new PlatformError(String(e), "expired"), ch };
    }
  }

  private async publish(postId: string, channelId: string) {
    const key = `${postId}/${channelId}`;
    const retries = this.retries;
    const prior = retries[key];
    if (prior && prior.notBefore > this.now()) return;
    const post = this.office.books.posts.find((p) => p.id === postId);
    const v = post?.variants.find((x) => x.channelId === channelId);
    if (!post || !v || v.status !== "scheduled") return;
    const r = await this.ready(channelId);
    let error: PlatformError;
    if ("a" in r) {
      try {
        const media = this.opts.mediaSecret ? await signedMedia(this.opts.mediaSecret, this.opts.base, this.opts.officeId, this.office.books.media.filter((m) => v.mediaIds.includes(m.id)), this.now()) : [];
        if (v.mediaIds.length && !media.length) throw new PlatformError("Pictures need SOCIAL_TOKEN_KEY set to make their links", "not_set_up");
        const done = await r.a.publish(r.t, v, media);
        delete retries[key];
        this.setRetries(retries);
        this.office.markPublished(postId, channelId, { externalId: done.externalId, url: done.url });
        return;
      } catch (e) {
        error = e instanceof PlatformError ? e : new PlatformError(e instanceof Error ? e.message : String(e), "retry");
      }
    } else error = r.problem;

    const attempt = (prior?.attempt ?? 0) + 1;
    const next = afterFailure(error, attempt, this.now());
    if ("retryAt" in next) {
      retries[key] = { attempt, notBefore: next.retryAt };
      this.setRetries(retries);
      this.office.markFailed(postId, channelId, `${error.message}. Trying again at ${new Date(next.retryAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}.`);
      return;
    }
    delete retries[key];
    this.setRetries(retries);
    if (next.stop.manual) {
      this.office.channelProblem(channelId, "manual", error.message);
      this.office.markFailed(postId, channelId, `${error.message}. Post it by hand from the publishing pack`);
      return;
    }
    this.office.markFailed(postId, channelId, error.message, next.stop);
  }

  private async reply(messageId: string, channelId: string, text: string) {
    const m = this.office.books.socialInbox.find((x) => x.id === messageId);
    if (!m) return;
    const r = await this.ready(channelId);
    try {
      if (!("a" in r)) throw r.problem;
      if (m.replyBy && Date.parse(m.replyBy) < this.now()) throw new PlatformError("WhatsApp's 24-hour reply window has closed", "final");
      await r.a.reply(r.t, m, text);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      m.status = "open";
      this.office.log("social-media-manager", `Could not reply to ${m.author} on ${m.platform}: ${why}. The reply is drafted for you to send by hand.`, { kind: "social", id: m.id });
      if (e instanceof PlatformError && (e.kind === "expired" || e.kind === "rate_limited")) this.office.channelProblem(channelId, e.kind, why);
    }
  }

  /** WhatsApp marketing templates go only to people who have messaged the business on WhatsApp. */
  private async broadcast(postId: string, channelId: string) {
    const post = this.office.books.posts.find((p) => p.id === postId);
    const v = post?.variants.find((x) => x.channelId === channelId);
    if (!post || !v) return;
    const r = await this.ready(channelId);
    const audience = [...new Set(this.office.books.socialInbox.filter((m) => m.channelId === channelId && m.kind === "dm" && m.threadId).map((m) => m.threadId!))];
    try {
      if (!("a" in r)) throw r.problem;
      if (!r.a.broadcast) throw new PlatformError("This channel cannot send broadcasts", "final");
      if (!audience.length) throw new PlatformError("Nobody has messaged you on WhatsApp yet, so there is no one to send to", "final");
      const sent = await r.a.broadcast(r.t, { template: r.t.extra.template ?? "", language: r.t.extra.templateLanguage ?? "en", text: v.text, audience });
      this.office.markPublished(postId, channelId, { externalId: null, url: null });
      this.office.log("social-media-manager", `The WhatsApp broadcast for "${post.topic}" went to ${sent.sent} ${sent.sent === 1 ? "customer" : "customers"}${sent.failed ? `; ${sent.failed} could not be reached` : ""}.`, { kind: "post", id: post.id });
    } catch (e) {
      const err = e instanceof PlatformError ? e : new PlatformError(String(e), "final");
      this.office.markFailed(postId, channelId, err.message, { final: true, rateLimited: err.kind === "rate_limited", expired: err.kind === "expired" });
    }
  }

  /** When the Office should next wake to publish: the next post's time, or the next retry. */
  nextWake(): number | null {
    const now = this.now();
    const times = [
      ...this.office.books.posts.filter((p) => p.status === "scheduled" && p.variants.some((v) => v.status === "scheduled")).map((p) => Date.parse(p.at)).filter((t) => t > now),
      ...Object.values(this.retries).map((r) => Math.max(r.notBefore, now + 1000)),
    ];
    return times.length ? Math.min(...times) : null;
  }

  /** The morning pull: new comments and messages on channels without webhooks, and every channel's numbers. */
  async pull(): Promise<{ messages: number; metrics: number }> {
    let messages = 0;
    let metrics = 0;
    const now = this.now();
    for (const ch of this.office.books.channels) {
      if (ch.mode !== "connected" || ch.status === "expired") continue;
      const r = await this.ready(ch.id);
      if (!("a" in r)) continue;
      const since = this.opts.kv(`social_pulled:${ch.id}`) ?? new Date(now - 3 * 86_400_000).toISOString();
      const externalIds = this.office.books.posts.flatMap((p) => p.variants).filter((v) => v.channelId === ch.id && v.externalId && v.publishedAt && now - Date.parse(v.publishedAt) < PULL_WINDOW_MS).map((v) => v.externalId!);
      try {
        const got = await r.a.pull(r.t, { since, externalIds });
        messages += this.office.receiveMessages(got.messages.map((m) => ({ ...m, channelId: ch.id }))).added.length;
        metrics += this.office.recordMetrics(ch.id, got.metrics);
        this.opts.kv(`social_pulled:${ch.id}`, new Date(now).toISOString());
        if (ch.status === "rate_limited") Object.assign(ch, { status: "connected", lastError: null });
      } catch (e) {
        if (e instanceof PlatformError && (e.kind === "expired" || e.kind === "rate_limited")) this.office.channelProblem(ch.id, e.kind, e.message);
        else console.error(`social pull failed for ${ch.id}`, e);
      }
    }
    return { messages, metrics };
  }
}
