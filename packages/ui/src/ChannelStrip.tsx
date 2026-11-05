import type { Channel } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";

const STATE: Record<Channel["status"], string> = {
  connected: "Connected",
  manual: "Posted by hand",
  expired: "Connection expired",
  rate_limited: "Limited by the platform",
  error: "Not working",
};

type Props = {
  channels: Channel[];
  /** The owner's actions; without them the strip only reports. */
  onConnect?: (c: Channel) => void;
  onManual?: (c: Channel) => void;
  busy?: boolean;
};

/**
 * Each channel as a bay along one wall, with its state drawn in the line beneath it:
 * a solid line when connected, a dashed one when posts go out by hand, red when the platform has stopped us.
 */
export function ChannelStrip({ channels, onConnect, onManual, busy }: Props) {
  return (
    <ul className="channel-strip" aria-label="Channels">
      {channels.map((c) => (
        <li key={c.id} className={`channel-bay channel-${c.status}`}>
          <span className="channel-name">{PLATFORM_NAMES[c.platform]}</span>
          <span className="channel-handle muted">{c.handle}</span>
          <span className="channel-state">{STATE[c.status]}</span>
          {c.followers !== null ? <span className="channel-reach muted num">{`${c.followers.toLocaleString("en-IN")} ${c.platform === "whatsapp" ? "opted in" : "followers"}`}</span> : null}
          {c.lastError && c.status !== "connected" && c.status !== "manual" ? <span className="channel-error">{c.lastError}</span> : null}
          {onConnect && c.platform !== "google" && c.status !== "connected" ? (
            <button type="button" className="btn-link" disabled={busy} onClick={() => onConnect(c)}>
              {c.status === "manual" ? "Connect" : "Reconnect"}
            </button>
          ) : null}
          {onManual && c.status !== "manual" ? (
            <button type="button" className="btn-link" disabled={busy} onClick={() => onManual(c)}>
              Post by hand instead
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
