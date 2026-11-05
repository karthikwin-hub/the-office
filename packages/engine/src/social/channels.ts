import type { Platform } from "@office/contracts";

export type ChannelRules = {
  platform: Platform;
  maxChars: number;
  maxHashtags: number;
  /** "none": the platform does not make links in captions clickable, so the link goes in the bio. */
  links: "inline" | "first-comment" | "none" | "button";
  media: { images: number; video: boolean; ratio: string[]; required: boolean };
  threadable: boolean;
  /** Characters a link counts as, where the platform shortens it. */
  linkChars: number | null;
};

export const RULES: Record<Platform, ChannelRules> = {
  instagram: { platform: "instagram", maxChars: 2200, maxHashtags: 5, links: "none", media: { images: 10, video: true, ratio: ["1:1", "4:5", "1.91:1"], required: true }, threadable: false, linkChars: null },
  facebook: { platform: "facebook", maxChars: 5000, maxHashtags: 3, links: "inline", media: { images: 10, video: true, ratio: ["1:1", "4:5", "16:9"], required: false }, threadable: false, linkChars: null },
  threads: { platform: "threads", maxChars: 500, maxHashtags: 1, links: "inline", media: { images: 10, video: true, ratio: ["1:1", "4:5", "9:16"], required: false }, threadable: true, linkChars: null },
  linkedin: { platform: "linkedin", maxChars: 3000, maxHashtags: 5, links: "inline", media: { images: 9, video: true, ratio: ["1:1", "1.91:1", "4:5"], required: false }, threadable: false, linkChars: null },
  x: { platform: "x", maxChars: 280, maxHashtags: 2, links: "inline", media: { images: 4, video: true, ratio: ["16:9", "1:1"], required: false }, threadable: true, linkChars: 23 },
  whatsapp: { platform: "whatsapp", maxChars: 1024, maxHashtags: 0, links: "inline", media: { images: 1, video: true, ratio: ["1:1", "9:16"], required: false }, threadable: false, linkChars: null },
  google: { platform: "google", maxChars: 1500, maxHashtags: 0, links: "button", media: { images: 1, video: false, ratio: ["4:3", "1:1"], required: false }, threadable: false, linkChars: null },
};

const URL_RE = /https?:\/\/\S+/g;
const TAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;

/** Length as the platform counts it: X counts every link as 23 characters. */
export function charCount(platform: Platform, text: string): number {
  const rules = RULES[platform];
  const graphemes = (s: string) => [...s].length;
  if (rules.linkChars === null) return graphemes(text);
  const links = text.match(URL_RE) ?? [];
  return graphemes(text.replace(URL_RE, "")) + links.length * rules.linkChars;
}

export function hashtagsIn(text: string): string[] {
  return (text.match(TAG_RE) ?? []).map((t) => t.trim());
}

/** Adds UTM tags so a visit can be traced back to the post and channel. */
export function withUtm(link: string, platform: Platform, postId: string): string {
  try {
    const u = new URL(link);
    if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", platform);
    if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "social");
    if (!u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", postId);
    return u.toString();
  } catch {
    return link;
  }
}

export type Fitted = { text: string; firstComment: string | null; changes: string[] };

/**
 * Shapes a caption for one platform: keeps the strongest hashtags up to the platform's limit,
 * places the link where it works, and shortens at a sentence end if the text is still too long.
 */
export function fit(platform: Platform, text: string, opts: { link?: string | null; hashtags?: string[] } = {}): Fitted {
  const rules = RULES[platform];
  const changes: string[] = [];
  const inText = hashtagsIn(text);
  const wanted = [...new Set([...inText, ...(opts.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`))])];
  const keep = wanted.slice(0, rules.maxHashtags);
  if (wanted.length > keep.length) changes.push(`Kept ${keep.length} of ${wanted.length} hashtags`);
  let body = text.replace(TAG_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  let firstComment: string | null = null;
  if (opts.link) {
    if (rules.links === "inline") body = `${body}\n\n${opts.link}`;
    else if (rules.links === "first-comment") firstComment = opts.link;
    else if (rules.links === "none") {
      body = `${body}\n\nLink in bio.`;
      changes.push("Links are not clickable here, so it points to the bio");
    } else changes.push("The link goes on the post's button");
  }
  const tags = keep.length ? `\n\n${keep.join(" ")}` : "";
  let out = `${body}${tags}`;
  if (charCount(platform, out) > rules.maxChars) {
    const room = rules.maxChars - charCount(platform, tags) - 1;
    const sentences = body.match(/[^.!?\n]+[.!?]?\s*/g) ?? [body];
    let short = "";
    for (const s of sentences) {
      if (charCount(platform, short + s) > room) break;
      short += s;
    }
    if (!short) short = [...body].slice(0, Math.max(0, room - 1)).join("") + "…";
    out = `${short.trim()}${tags}`;
    changes.push(`Shortened to fit ${rules.maxChars} characters`);
  }
  return { text: out, firstComment, changes };
}

/** FNV-1a over the text: enough to tell whether a post changed after it was approved. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
