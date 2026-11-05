import type { IncomingMessage } from "@office/engine";

const enc = new TextEncoder();

/** Meta signs each delivery with the app secret: `X-Hub-Signature-256: sha256=<hex of HMAC-SHA256 over the raw body>`. */
export async function verifyMetaSignature(appSecret: string, rawBody: ArrayBuffer | string, header: string | null): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  if (!m || !appSecret) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = new Uint8Array(m[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, sig, typeof rawBody === "string" ? enc.encode(rawBody) : rawBody);
}

/** The subscription handshake: Meta sends the token we chose, and we echo its challenge. */
export function metaChallenge(url: URL, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  const p = url.searchParams;
  return p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === verifyToken ? p.get("hub.challenge") : null;
}

type Change = { field?: string; value?: Record<string, unknown> };
type Entry = { id?: string; time?: number; changes?: Change[]; messaging?: unknown[] };
type Delivery = { object?: string; entry?: Entry[] };

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const isoFrom = (v: unknown, fallback: number) => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && /^\d+$/.test(v)) return new Date(Number(v) * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return new Date(fallback).toISOString();
};

/**
 * Turns one webhook delivery into inbox messages. Channel ids are filled in by the Office from the platform.
 * Our own replies come back as comments too; `ownIds` (our account ids) drops them.
 */
export function parseMetaDelivery(body: unknown, ownIds: Set<string> = new Set(), now = Date.now()): IncomingMessage[] {
  const d = body as Delivery;
  const out: IncomingMessage[] = [];
  for (const e of d.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value ?? {};
      if (d.object === "instagram" && (c.field === "comments" || c.field === "live_comments")) {
        const from = (v.from ?? {}) as { id?: string; username?: string };
        if (from.id && ownIds.has(from.id)) continue;
        const id = str(v.id);
        if (!id || !str(v.text)) continue;
        out.push({ id: `ig-${id}`, externalId: id, platform: "Instagram", channelId: "", kind: "comment", author: from.username ? `@${from.username}` : "Someone on Instagram", at: isoFrom(e.time, now), rating: null, text: str(v.text).slice(0, 2000), postId: null, threadId: str((v.media as { id?: string } | undefined)?.id) || null });
      }
      if (d.object === "instagram" && c.field === "mentions") {
        const id = str(v.comment_id) || str(v.media_id);
        if (id) out.push({ id: `ig-m-${id}`, externalId: id, platform: "Instagram", channelId: "", kind: "mention", author: "Someone on Instagram", at: isoFrom(e.time, now), rating: null, text: "Mentioned you", postId: null, threadId: str(v.media_id) || null });
      }
      if (d.object === "page" && c.field === "feed" && v.item === "comment" && v.verb === "add") {
        const from = (v.from ?? {}) as { id?: string; name?: string };
        if ((from.id && ownIds.has(from.id)) || !str(v.message)) continue;
        const id = str(v.comment_id);
        out.push({ id: `fb-${id}`, externalId: id, platform: "Facebook", channelId: "", kind: "comment", author: from.name ?? "Someone on Facebook", at: isoFrom(v.created_time, now), rating: null, text: str(v.message).slice(0, 2000), postId: null, threadId: str(v.post_id) || null });
      }
      if (d.object === "page" && c.field === "ratings" && v.verb === "add") {
        const id = str(v.open_graph_story_id) || str(v.review_id);
        const reviewer = (v.reviewer ?? {}) as { name?: string };
        const rec = str(v.recommendation_type);
        if (id) out.push({ id: `fb-r-${id}`, externalId: id, platform: "Facebook", channelId: "", kind: "review", author: reviewer.name ?? "A Facebook visitor", at: isoFrom(v.created_time, now), rating: typeof v.rating === "number" ? v.rating : rec === "positive" ? 5 : rec === "negative" ? 2 : null, text: str(v.review_text).slice(0, 2000) || (rec === "positive" ? "Recommends you" : "Left a rating"), postId: null, threadId: null });
      }
      if (d.object === "whatsapp_business_account" && c.field === "messages") {
        const contacts = (v.contacts ?? []) as { wa_id?: string; profile?: { name?: string } }[];
        for (const m of (v.messages ?? []) as { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }[]) {
          if (!m.id || !m.from) continue;
          const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? (m.type ? `Sent a ${m.type}` : "");
          const name = contacts.find((x) => x.wa_id === m.from)?.profile?.name;
          out.push({ id: `wa-${m.id}`, externalId: m.id, platform: "WhatsApp", channelId: "", kind: "dm", author: name ?? `+${m.from}`, at: isoFrom(m.timestamp, now), rating: null, text: text.slice(0, 2000), postId: null, threadId: m.from });
        }
      }
    }
  }
  return out;
}
