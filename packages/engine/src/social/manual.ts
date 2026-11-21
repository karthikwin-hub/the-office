import type { Books, PostMetrics, PublishingPack, SheetMapping } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { recognise } from "../intake/kinds";
import { parseDelimited } from "../sales/parse";
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
    media.length
      ? `Save the ${media.length === 1 ? "picture" : `${media.length} pictures`} to your phone.`
      : RULES[v.platform].media.required
        ? `${name} needs a picture: add one before posting.`
        : "No picture is needed.",
    `Open ${name}${ch.handle ? ` as ${ch.handle}` : ""} and start a new ${v.platform === "whatsapp" ? "Status update" : "post"}.`,
    "Copy the text below and paste it in.",
    ...(media.some((m) => m.alt) && v.platform !== "whatsapp" ? ["Paste each picture's description into its alt text setting."] : []),
    `Post it${post.at ? ` around ${new Date(post.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}` : ""}.`,
    "Copy the post's link and paste it here under Mark as posted, so its results can be matched later.",
  ];
  return { postId, channelId, platform: v.platform, handle: ch.handle, text: v.text, media, at: post.at, steps };
}

const norm = (u: string) =>
  u
    .trim()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();

const METRICS = ["views", "likes", "comments", "saves", "shares", "clicks", "enquiries"] as const;

/**
 * Attaches a metrics export's numbers to the posts they belong to, matched by the URL pasted at "Mark as posted" or
 * the platform's post id. A number the file does not have, or cannot be read, leaves the one already kept.
 */
export function readMetrics(books: Books, input: { rows: string[][]; headerAt: number; mapping: SheetMapping }): { matched: number; unmatched: number } {
  const headers = input.rows[input.headerAt] ?? [];
  const col = (f: string) => (input.mapping[f] ? headers.indexOf(input.mapping[f]!) : -1);
  const urlCol = col("url");
  const idCol = col("id");
  if (urlCol < 0 && idCol < 0) throw new Error("The file needs a permalink or post id column to match posts.");
  let matched = 0;
  let unmatched = 0;
  for (const r of input.rows.slice(input.headerAt + 1)) {
    if (!r.some((c) => c.trim())) continue;
    const url = urlCol >= 0 ? norm(r[urlCol] ?? "") : "";
    const id = idCol >= 0 ? (r[idCol] ?? "").trim() : "";
    const v = books.posts.flatMap((p) => p.variants).find((x) => (url && x.url && norm(x.url) === url) || (id && x.externalId === id));
    if (!v) {
      unmatched++;
      continue;
    }
    const before = v.metrics;
    const num = (k: (typeof METRICS)[number]) => {
      const raw = col(k) >= 0 ? (r[col(k)] ?? "").replace(/[,\s]/g, "") : "";
      return /^\d+(\.\d+)?$/.test(raw) ? Math.round(Number(raw)) : (before?.[k] ?? 0);
    };
    v.metrics = Object.fromEntries(METRICS.map((k) => [k, num(k)])) as PostMetrics;
    matched++;
  }
  return { matched, unmatched };
}

/** A metrics export as CSV text, its columns found by their names. */
export function importMetrics(books: Books, content: string): { matched: number; unmatched: number } {
  const rows = parseDelimited(content);
  const r = recognise(rows, ["social_metrics"]);
  if (rows.length < r.at + 2) throw new Error("No rows found. Export the post-level metrics as CSV and try again.");
  return readMetrics(books, { rows, headerAt: r.at, mapping: r.mapping });
}
