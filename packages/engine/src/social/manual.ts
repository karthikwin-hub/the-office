import type { Books, PostMetrics, PublishingPack } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { parseCsv } from "../imports";
import { RULES } from "./channels";

/** Everything needed to post by hand on a channel that is not connected. */
export function publishingPack(books: Books, postId: string, channelId: string): PublishingPack {
  const post = books.posts.find((p) => p.id === postId);
  const v = post?.variants.find((x) => x.channelId === channelId);
  const ch = books.channels.find((c) => c.id === channelId);
  if (!post || !v || !ch) throw new Error(`No ${channelId} version of ${postId}`);
  const media = books.media.filter((m) => v.mediaIds.includes(m.id));
  const name = PLATFORM_NAMES[v.platform];
  const steps = [
    media.length ? `Save the ${media.length === 1 ? "picture" : `${media.length} pictures`} to your phone.` : RULES[v.platform].media.required ? `${name} needs a picture: add one before posting.` : "No picture is needed.",
    `Open ${name}${ch.handle ? ` as ${ch.handle}` : ""} and start a new ${v.platform === "whatsapp" ? "Status update" : "post"}.`,
    "Copy the text below and paste it in.",
    ...(media.some((m) => m.alt) && v.platform !== "whatsapp" ? ["Paste each picture's description into its alt text setting."] : []),
    `Post it${post.at ? ` around ${new Date(post.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}` : ""}.`,
    "Copy the post's link and paste it here under Mark as posted, so its results can be matched later.",
  ];
  return { postId, channelId, platform: v.platform, handle: ch.handle, text: v.text, media, at: post.at, steps };
}

const HEADERS: Record<keyof PostMetrics | "url" | "id", RegExp> = {
  url: /^(permalink|post link|link|url|post url|tweet permalink)$/i,
  id: /^(post id|id|media id|tweet id)$/i,
  views: /^(views|impressions|reach|plays)$/i,
  likes: /^(likes|reactions|like count)$/i,
  comments: /^(comments|replies|comment count)$/i,
  saves: /^(saves|saved)$/i,
  shares: /^(shares|reposts|retweets|forwards)$/i,
  clicks: /^(clicks|link clicks|url clicks|website clicks)$/i,
  enquiries: /^(enquiries|messages|conversations started)$/i,
};

const norm = (u: string) => u.trim().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();

/**
 * Reads a metrics export from Instagram, Facebook, LinkedIn or X and attaches the numbers to the posts
 * they belong to, matched by the URL pasted at "Mark as posted" or the platform's post id.
 */
export function importMetrics(books: Books, content: string): { matched: number; unmatched: number } {
  const rows = parseCsv(content.replace(/^\uFEFF/, "")).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) throw new Error("No rows found. Export the post-level metrics as CSV and try again.");
  const header = rows[0]!.map((h) => h.trim());
  const col = (k: keyof typeof HEADERS) => header.findIndex((h) => HEADERS[k].test(h));
  const urlCol = col("url");
  const idCol = col("id");
  if (urlCol < 0 && idCol < 0) throw new Error("The file needs a permalink or post id column to match posts.");
  const num = (r: string[], k: keyof PostMetrics) => {
    const i = col(k);
    return i < 0 ? 0 : Number((r[i] ?? "").replace(/[,\s]/g, "")) || 0;
  };
  let matched = 0;
  let unmatched = 0;
  for (const r of rows.slice(1)) {
    const url = urlCol >= 0 ? norm(r[urlCol] ?? "") : "";
    const id = idCol >= 0 ? (r[idCol] ?? "").trim() : "";
    const v = books.posts.flatMap((p) => p.variants).find((x) => (url && x.url && norm(x.url) === url) || (id && x.externalId === id));
    if (!v) {
      unmatched++;
      continue;
    }
    v.metrics = { views: num(r, "views"), likes: num(r, "likes"), comments: num(r, "comments"), saves: num(r, "saves"), shares: num(r, "shares"), clicks: num(r, "clicks"), enquiries: num(r, "enquiries") };
    matched++;
  }
  return { matched, unmatched };
}
