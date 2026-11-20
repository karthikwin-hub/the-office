import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { officePath } from "../api/client";

/** What the socket tells the rest of the app: it opened, it closed, or a document arrived unread. */
export type LiveSignal = "open" | "closed" | "unread";
const listeners = new Set<(signal: LiveSignal) => void>();
let socketOpen = false;

/** Whether the office's socket is open now, so a screen knows it will hear of changes without asking. */
export const liveOpen = () => socketOpen;

/** Calls `listener` with every signal from the socket; returns how to stop. */
export function onLive(listener: (signal: LiveSignal) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function signal(s: LiveSignal) {
  if (s !== "unread") socketOpen = s === "open";
  for (const l of [...listeners]) l(s);
}

/**
 * The Office says "changed" over a WebSocket whenever the books move, and every
 * open screen refetches; "unread" with it when a document arrived for a browser
 * to read. If the socket drops, screens poll once a minute until it is back.
 */
export function useLiveUpdates(enabled: boolean): "connected" | "polling" | "off" {
  const qc = useQueryClient();
  const [state, setState] = useState<"connected" | "polling" | "off">(enabled ? "polling" : "off");

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const refresh = () => void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "session" });

    const startPolling = () => {
      setState("polling");
      poll ??= setInterval(refresh, 60_000);
    };
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${officePath("/api/live")}`);
      socket.onopen = () => {
        retry = 0;
        setState("connected");
        if (poll) clearInterval(poll);
        poll = undefined;
        refresh();
        signal("open");
      };
      socket.onmessage = (e) => {
        try {
          const said = JSON.parse(String(e.data)) as { type?: string; unread?: boolean };
          if (said.type !== "changed") return;
          refresh();
          if (said.unread === true) signal("unread");
        } catch {
          /* other agent messages are not for the screens */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        signal("closed");
        startPolling();
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      socket?.close();
      if (socketOpen) signal("closed");
    };
  }, [enabled, qc]);

  return state;
}
