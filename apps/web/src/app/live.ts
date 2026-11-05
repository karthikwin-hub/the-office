import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { officePath } from "../api/client";

/**
 * The Office says "changed" over a WebSocket whenever the books move, and every
 * open screen refetches. If the socket drops, screens poll once a minute until
 * it is back.
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
      };
      socket.onmessage = (e) => {
        try {
          if ((JSON.parse(String(e.data)) as { type?: string }).type === "changed") refresh();
        } catch {
          /* other agent messages are not for the screens */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
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
    };
  }, [enabled, qc]);

  return state;
}
