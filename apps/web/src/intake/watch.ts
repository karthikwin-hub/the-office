import type { LiveSignal } from "../app/live";

/** Only while the office's socket is down: how often a screen asks whether documents wait to be read. */
export const UNREAD_FALLBACK_MS = 10 * 60_000;
/** Coming back to the tab looks again, but not more often than this. */
export const UNREAD_FOCUS_GAP_MS = 30_000;

export type UnreadWatchDeps = {
  /** Asks for the unread documents and reads them; false when it could not look now (the tab is hidden). */
  look: () => boolean;
  live: { open: () => boolean; on: (listener: (s: LiveSignal) => void) => () => void };
  /** Calls back when the person comes back to the tab. */
  onReturn: (listener: () => void) => () => void;
  every: (fn: () => void, ms: number) => () => void;
  /**
   * How long to wait before looking when the office says a document arrived. Every open tab hears it at once; a tab
   * not in front waits a little, so the one in front usually reads it and the others find nothing left.
   */
  delay: () => number;
  after: (fn: () => void, ms: number) => () => void;
  now?: () => number;
};

/**
 * When a screen looks for documents to read: once at the start, whenever the office says one arrived
 * (or the socket opens again, as one may have arrived while it was down), when the person comes back
 * to the tab, and every 10 minutes only while the socket is down. Returns how to stop.
 */
export function watchUnread(d: UnreadWatchDeps): () => void {
  const now = d.now ?? Date.now;
  let last = 0;
  // A signal that came while the tab was hidden is still owed a look when the person comes back.
  let owed = false;
  const look = () => {
    owed = !d.look();
    if (!owed) last = now();
  };
  look();
  let waiting: (() => void) | null = null;
  const soon = () => {
    const ms = d.delay();
    if (ms <= 0) return look();
    waiting ??= d.after(() => {
      waiting = null;
      look();
    }, ms);
  };
  const stops = [
    d.live.on((s) => {
      if (s === "unread") soon();
      if (s === "open") look();
    }),
    d.onReturn(() => {
      if (owed || now() - last >= UNREAD_FOCUS_GAP_MS) look();
    }),
    d.every(() => {
      if (!d.live.open()) look();
    }, UNREAD_FALLBACK_MS),
  ];
  return () => {
    stops.forEach((stop) => stop());
    waiting?.();
  };
}
