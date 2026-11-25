import type { Books, Channel, Post } from "@office/contracts";
import { addDays } from "../dates";

/** The hour an owner's post goes out when they leave the time to us: 11:00, moved inside the channel's posting hours. */
function slotTime(ch: Channel): string {
  const { from, to } = ch.postingHours;
  if ("11:00" < from) return from;
  if ("11:00" > to) return from;
  return "11:00";
}

const dayOf = (at: string) => at.slice(0, 10);

/**
 * The first day from `now` on which none of these channels has a post yet, at the latest of their slot
 * times, and at least 30 minutes ahead. `taken` holds channel-days already claimed in the same batch.
 */
export function nextFreeTime(books: Books, channelIds: string[], now: string, taken: Set<string> = new Set()): string {
  const channels = channelIds.map((id) => books.channels.find((c) => c.id === id)).filter((c): c is Channel => !!c);
  const time = channels.map(slotTime).sort().at(-1) ?? "11:00";
  const used = new Set(taken);
  for (const p of books.posts) for (const v of p.variants) if (v.status !== "skipped" && v.status !== "failed") used.add(`${v.channelId}|${dayOf(p.at)}`);
  const earliest = Date.parse(now) + 30 * 60_000;
  let day = dayOf(now);
  for (let i = 0; i < 366; i++, day = addDays(day, 1)) {
    const at = `${day}T${time}:00+05:30`;
    if (Date.parse(at) < earliest) continue;
    if (channelIds.every((id) => !used.has(`${id}|${day}`))) return at;
  }
  return `${day}T${time}:00+05:30`;
}

/** Marks the channel-days a post takes, so the next post in a sheet does not land on them. */
export function claimDays(post: Post, taken: Set<string>) {
  for (const v of post.variants) taken.add(`${v.channelId}|${dayOf(post.at)}`);
}

/** Products the caption names, so their price and stock can be checked even when the owner did not tag them. */
export function skusNamed(books: Books, text: string): string[] {
  const t = text.toLowerCase();
  return books.skus.filter((s) => s.name.length >= 4 && t.includes(s.name.toLowerCase())).map((s) => s.id);
}
