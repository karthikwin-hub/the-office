import type { Platform } from "@office/contracts";
import type { OfficeService, SocialEffect } from "../office";

const FAKE_URL: Record<Platform, (id: string) => string> = {
  instagram: (id) => `https://www.instagram.com/p/mock${id}/`,
  facebook: (id) => `https://www.facebook.com/kaverielectricals/posts/${id}`,
  threads: (id) => `https://www.threads.net/@kaverielectricals/post/mock${id}`,
  linkedin: (id) => `https://www.linkedin.com/feed/update/urn:li:share:${id}`,
  x: (id) => `https://x.com/kaveri_elec/status/${id}`,
  whatsapp: () => "",
  google: (id) => `https://g.page/kaveri-electricals/update/${id}`,
};

let seq = 9000;

/**
 * Plays the platforms' part in the mockups: posts publish with a believable link, replies and
 * broadcasts go through, and a rate-limited channel answers 429 as the real one would.
 */
export function runMockEffects(office: OfficeService, effects: SocialEffect[] = office.takeEffects()): void {
  for (const e of effects) {
    const ch = office.books.channels.find((c) => c.id === e.channelId);
    if (!ch) continue;
    if (e.kind === "reply") continue;
    if (ch.status === "rate_limited") {
      office.markFailed(e.postId, e.channelId, "429 Too Many Requests", { rateLimited: true });
      continue;
    }
    const id = String(++seq);
    office.markPublished(e.postId, e.channelId, { externalId: id, url: FAKE_URL[ch.platform](id) || null });
  }
}

/** The mockups' stand-in for OAuth: the channel connects at once with its current handle. */
export function mockConnect(office: OfficeService, platform: string) {
  const ch = office.books.channels.find((c) => c.platform === platform);
  if (!ch) throw new Error(`No channel for ${platform}`);
  return office.connectChannel(ch.id, ch.handle || `@${office.books.business.name.toLowerCase().replace(/\W+/g, "")}`);
}
