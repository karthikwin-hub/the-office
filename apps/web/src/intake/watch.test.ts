import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSignal } from "../app/live";
import { UNREAD_FALLBACK_MS, UNREAD_FOCUS_GAP_MS, watchUnread } from "./watch";

/** A tab: the office's socket, whether the tab is in view, and every time it asked for unread documents. */
function tab(delay = 0) {
  const t = {
    open: false,
    hidden: false,
    looks: 0,
    listeners: new Set<(s: LiveSignal) => void>(),
    returns: new Set<() => void>(),
    say(s: LiveSignal) {
      if (s !== "unread") t.open = s === "open";
      for (const l of t.listeners) l(s);
    },
    comeBack() {
      t.hidden = false;
      for (const r of t.returns) r();
    },
  };
  const stop = watchUnread({
    look: () => {
      if (t.hidden) return false;
      t.looks++;
      return true;
    },
    live: { open: () => t.open, on: (l) => (t.listeners.add(l), () => void t.listeners.delete(l)) },
    onReturn: (r) => (t.returns.add(r), () => void t.returns.delete(r)),
    every: (fn, ms) => {
      const i = setInterval(fn, ms);
      return () => clearInterval(i);
    },
    delay: () => delay,
    after: (fn, ms) => {
      const i = setTimeout(fn, ms);
      return () => clearTimeout(i);
    },
  });
  return Object.assign(t, { stop });
}

describe("looking for documents to read", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("asks once, then only when the office says one arrived, not every minute, while the socket is open", () => {
    const t = tab();
    expect(t.looks).toBe(1);
    t.say("open");
    expect(t.looks).toBe(2);
    vi.advanceTimersByTime(8 * 60 * 60_000);
    expect(t.looks).toBe(2);
    t.say("unread");
    expect(t.looks).toBe(3);
  });

  it("asks every 10 minutes only while the socket is down, and again when it is back", () => {
    const t = tab();
    vi.advanceTimersByTime(UNREAD_FALLBACK_MS - 1);
    expect(t.looks).toBe(1);
    vi.advanceTimersByTime(1);
    expect(t.looks).toBe(2);
    t.say("open");
    expect(t.looks).toBe(3);
    vi.advanceTimersByTime(3 * UNREAD_FALLBACK_MS);
    expect(t.looks).toBe(3);
    t.say("closed");
    vi.advanceTimersByTime(UNREAD_FALLBACK_MS);
    expect(t.looks).toBe(4);
  });

  it("looks when the person comes back to the tab, at most every 30 seconds, and always when a signal came while away", () => {
    const t = tab();
    t.say("open");
    t.comeBack();
    expect(t.looks).toBe(2);
    vi.advanceTimersByTime(UNREAD_FOCUS_GAP_MS);
    t.comeBack();
    expect(t.looks).toBe(3);

    t.hidden = true;
    t.say("unread");
    expect(t.looks).toBe(3);
    t.comeBack();
    expect(t.looks).toBe(4);
  });

  it("waits before looking in a tab not in front, once however many signals come meanwhile", () => {
    const t = tab(10_000);
    t.say("open");
    t.say("unread");
    t.say("unread");
    expect(t.looks).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(t.looks).toBe(3);
    vi.advanceTimersByTime(60_000);
    expect(t.looks).toBe(3);
  });

  it("stops listening when the screen goes", () => {
    const t = tab();
    t.stop();
    t.say("unread");
    t.comeBack();
    vi.advanceTimersByTime(UNREAD_FALLBACK_MS);
    expect(t.looks).toBe(1);
  });
});
