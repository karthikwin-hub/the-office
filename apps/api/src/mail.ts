import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";
import type { Env } from "./env";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export type Attachment = { filename: string; mimeType: string; content: ArrayBuffer };
export type Inbound = { from: string | null; name: string | null; subject: string; text: string; messageId: string | null; inReplyTo: string | null; attachments: Attachment[]; skipped: string[] };

/** Keeps the PDFs and pictures of an email; anything else is listed as skipped so the log can say so. */
export async function parseInbound(raw: ReadableStream | ArrayBuffer): Promise<Inbound> {
  const mail = await PostalMime.parse(raw instanceof ArrayBuffer ? raw : await new Response(raw).arrayBuffer());
  const attachments: Attachment[] = [];
  const skipped: string[] = [];
  for (const a of mail.attachments) {
    const name = a.filename ?? "attachment";
    const content = typeof a.content === "string" ? (new TextEncoder().encode(a.content).buffer as ArrayBuffer) : (a.content as ArrayBuffer);
    const kind = a.mimeType === "application/pdf" || /\.pdf$/i.test(name) ? "application/pdf" : /^image\/(png|jpe?g|webp)$/.test(a.mimeType) ? a.mimeType : null;
    if (!kind || content.byteLength > MAX_BYTES || attachments.length >= MAX_ATTACHMENTS) skipped.push(name);
    else attachments.push({ filename: name, mimeType: kind, content });
  }
  return { from: mail.from?.address ?? null, name: mail.from?.name || null, subject: mail.subject ?? "", text: mail.text ?? "", messageId: mail.messageId ?? null, inReplyTo: mail.inReplyTo ?? null, attachments, skipped };
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** A plain-text message in UTF-8, as `send_email` takes it. */
export function plainMessage(m: { fromName: string; from: string; to: string; subject: string; body: string; replyTo?: string; messageId?: string; inReplyTo?: string | null }): string {
  const domain = m.from.split("@")[1] ?? "localhost";
  const id = m.messageId ?? `<${crypto.randomUUID()}@${domain}>`;
  const headers = [
    `From: =?UTF-8?B?${b64(m.fromName)}?= <${m.from}>`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: =?UTF-8?B?${b64(m.subject)}?=`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = b64(m.body).replace(/.{1,76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export type Outbound = { fromName: string; to: string; subject: string; body: string; replyTo?: string; messageId?: string; inReplyTo?: string | null };
/** Sends one plain-text message from MAIL_FROM and resolves to its Message-ID; throws with the reason if it could not go. */
export type Sender = (m: Outbound) => Promise<string>;

/**
 * Resend when RESEND_API_KEY is set: it reaches any address, from MAIL_FROM on a domain verified in Resend.
 * Otherwise Cloudflare's send_email binding, which delivers only to addresses verified on the account.
 * Null when neither is set up.
 */
export function mailSender(env: Pick<Env, "MAILER" | "MAIL_FROM" | "RESEND_API_KEY">, fetcher: typeof fetch = fetch): Sender | null {
  const from = env.MAIL_FROM;
  const domain = from.split("@")[1] ?? "localhost";
  const idFor = (m: Outbound) => m.messageId ?? `<${crypto.randomUUID()}@${domain}>`;
  if (env.RESEND_API_KEY) {
    const key = env.RESEND_API_KEY;
    return async (m) => {
      const id = idFor(m);
      const headers: Record<string, string> = { "Message-ID": id, ...(m.inReplyTo ? { "In-Reply-To": m.inReplyTo, References: m.inReplyTo } : {}) };
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `${m.fromName.replace(/[<>"]/g, "")} <${from}>`, to: [m.to], subject: m.subject, text: m.body, ...(m.replyTo ? { reply_to: m.replyTo } : {}), headers }),
      });
      if (!res.ok) throw new Error(`the mail service refused the message (${res.status})`);
      return id;
    };
  }
  const mailer = env.MAILER;
  if (!mailer) return null;
  return async (m) => {
    const id = idFor(m);
    await mailer.send(new EmailMessage(from, m.to, plainMessage({ ...m, from, messageId: id })));
    return id;
  };
}
