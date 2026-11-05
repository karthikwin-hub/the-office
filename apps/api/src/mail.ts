import PostalMime from "postal-mime";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export type Attachment = { filename: string; mimeType: string; content: ArrayBuffer };
export type Inbound = { from: string | null; subject: string; attachments: Attachment[]; skipped: string[] };

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
  return { from: mail.from?.address ?? null, subject: mail.subject ?? "", attachments, skipped };
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** A plain-text message in UTF-8, as `send_email` takes it. */
export function plainMessage(m: { fromName: string; from: string; to: string; subject: string; body: string; replyTo?: string }): string {
  const domain = m.from.split("@")[1] ?? "localhost";
  const headers = [
    `From: =?UTF-8?B?${b64(m.fromName)}?= <${m.from}>`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: =?UTF-8?B?${b64(m.subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = b64(m.body).replace(/.{1,76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}
