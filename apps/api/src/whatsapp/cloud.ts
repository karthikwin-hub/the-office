import { type Fetch, call, PlatformError } from "../social/adapter";
import { GRAPH_VERSION } from "../social/meta";

const FB = `https://graph.facebook.com/${GRAPH_VERSION}`;
export type WaKeys = { token: string; phoneId: string; template: string | null };

/** A free text message; WhatsApp only delivers it inside the 24 hours after the person last wrote. */
export async function sendText(keys: WaKeys, to: string, body: string, f: Fetch = fetch): Promise<string | null> {
  const r = await call<{ messages?: { id: string }[] }>(f, `${FB}/${keys.phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${keys.token}` },
    json: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
  });
  return r.messages?.[0]?.id ?? null;
}

/** A paid utility template for the morning digest, when the 24-hour window has closed. */
export async function sendTemplate(keys: WaKeys, to: string, summary: string, f: Fetch = fetch): Promise<string | null> {
  if (!keys.template) throw new PlatformError("No WhatsApp template is set up", "not_set_up");
  const r = await call<{ messages?: { id: string }[] }>(f, `${FB}/${keys.phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${keys.token}` },
    json: { messaging_product: "whatsapp", to, type: "template", template: { name: keys.template, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: summary.replace(/\s*\n\s*/g, " · ").slice(0, 1024) }] }] } },
  });
  return r.messages?.[0]?.id ?? null;
}

/**
 * A photo, PDF or voice note: the media id gives a short-lived link, which needs the same token.
 * Anything over `max` bytes is refused before it is downloaded.
 */
export async function downloadMedia(keys: WaKeys, mediaId: string, max: number, f: Fetch = fetch): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const meta = await call<{ url?: string; mime_type?: string; file_size?: number }>(f, `${FB}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${keys.token}` } });
  if (!meta.url) throw new PlatformError("WhatsApp did not give a link to the file", "final");
  if ((meta.file_size ?? 0) > max) throw new PlatformError("The file is too large", "final");
  const res = await f(meta.url, { headers: { authorization: `Bearer ${keys.token}` } });
  if (!res.ok) throw new PlatformError(`WhatsApp would not hand over the file (${res.status})`, "retry");
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > max) throw new PlatformError("The file is too large", "final");
  return { bytes, mimeType: (meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
}
