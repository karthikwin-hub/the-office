import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";
import type { Env } from "./env";
import { billType, sheetType } from "./filetype";
import { isSheetFile } from "./sales";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export type Attachment = { filename: string; mimeType: string; content: ArrayBuffer };
export type Inbound = {
  from: string | null;
  name: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  attachments: Attachment[];
  skipped: string[];
  /** The `From:` address is proven: DMARC passed, or a DKIM signature of its own domain did. */
  authenticated: boolean;
  /** The domains whose DKIM signatures passed. */
  signedBy: string[];
  /** SPF passed: for this envelope domain, or (null) for the envelope as it came. Undefined when it did not pass. */
  spfFor?: string | null;
};

/** Email Routing's name for itself in the `Authentication-Results` header it puts on top of every message. */
export const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";

export const domainOf = (address: string | null | undefined) => (/@([^\s<>"@]+?)\.?>?$/.exec((address ?? "").trim())?.[1] ?? "").toLowerCase() || null;
/** DMARC's relaxed alignment, without a public-suffix list: the same domain, or one inside the other. */
export const aligned = (signer: string, domain: string) => signer === domain || domain.endsWith(`.${signer}`) || signer.endsWith(`.${domain}`);

type Header = { key: string; value: string };

/**
 * A header value with its comments and quoted strings blanked out (a quoted string becomes `""`),
 * so text inside them cannot pass for structure. Null when a quote or comment does not close.
 */
function structure(v: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\" && (quoted || depth)) {
      i++;
      continue;
    }
    if (quoted) {
      if (c === '"') {
        quoted = false;
        out += '"';
      }
      continue;
    }
    if (depth) {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) out += " ";
      continue;
    }
    if (c === '"') {
      quoted = true;
      out += '"';
    } else if (c === "(") depth = 1;
    else if (c === ")") return null;
    else out += c;
  }
  return quoted || depth ? null : out;
}
const CLOUDFLARE_ID = /^\s*mx\.cloudflare\.net(\s+\d+)?\s*$/i;
const spaced = (v: string) => v.replace(/\s+/g, " ").trim();

/**
 * Whether Cloudflare found the sender to be who `From:` says. Only the topmost
 * `Authentication-Results` header of the message is read, and only when it is also the first of
 * `results` (what `message.headers.get("authentication-results")` gives: every such header joined
 * with commas, Cloudflare's own first) and names mx.cloudflare.net. Any other was written by the
 * sender, so a second one in Cloudflare's name means none is believed, and so does a header whose
 * comments or quotes do not close. Authenticated: DMARC passed for the `From:` domain, or a DKIM
 * signature passed whose domain aligns with it. A message with no single, plain `From:` is never
 * authenticated.
 */
export function mailVerdict(
  results: string | null | undefined,
  headers: Header[],
  from: string | null,
): Pick<Inbound, "authenticated" | "signedBy" | "spfFor"> {
  const none = { authenticated: false, signedBy: [] };
  const stamped = headers.filter((h) => h.key.toLowerCase() === "authentication-results");
  const top = stamped[0];
  if (!results || !top) return none;
  const joined = spaced(results);
  const first = spaced(top.value);
  if (joined !== first && !joined.startsWith(`${first},`)) return none;
  const parsed = structure(first);
  if (parsed === null) return none;
  const [id, ...parts] = parsed.split(";");
  if (!CLOUDFLARE_ID.test(id ?? "")) return none;
  if (stamped.slice(1).some((h) => CLOUDFLARE_ID.test((structure(h.value) ?? h.value).split(";")[0] ?? ""))) return none;
  const signedBy: string[] = [];
  let dmarcFrom: string | null | undefined;
  let spfFor: string | null | undefined;
  const seen = new Set<string>();
  for (const part of parts) {
    const m = /^\s*([\w-]+)\s*=\s*([\w-]+)(.*)$/s.exec(part);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    // Each method's first result is the one; a later repeat is not believed.
    if (method !== "dkim" && seen.has(method)) continue;
    seen.add(method);
    if (m[2]!.toLowerCase() !== "pass") continue;
    const props = new Map([...m[3]!.matchAll(/([\w.-]+)\s*=\s*([^\s;,]+)/g)].map((p) => [p[1]!.toLowerCase(), p[2]!.toLowerCase()]));
    if (method === "dkim") {
      const d = props.get("header.d") ?? domainOf(props.get("header.i"));
      if (d) signedBy.push(d.replace(/\.$/, ""));
    }
    if (method === "dmarc") dmarcFrom = props.get("header.from") ?? null;
    if (method === "spf") {
      const mailfrom = props.get("smtp.mailfrom");
      spfFor = mailfrom ? (mailfrom.includes("@") ? domainOf(mailfrom) : mailfrom.replace(/\.$/, "")) : null;
    }
  }
  const fromHeaders = headers.filter((h) => h.key.toLowerCase() === "from");
  const fromDomain = fromHeaders.length === 1 && (fromHeaders[0]!.value.match(/@/g) ?? []).length === 1 ? domainOf(from) : null;
  const dmarc = Boolean(fromDomain) && dmarcFrom !== undefined && (dmarcFrom === null || dmarcFrom === fromDomain);
  return { authenticated: dmarc || Boolean(fromDomain && signedBy.some((d) => aligned(d, fromDomain))), signedBy, ...(spfFor !== undefined ? { spfFor } : {}) };
}

/** Google's own forwarding confirmation, proven to be from Google. */
export const fromGoogleForwarding = (mail: { from: string | null; authenticated?: boolean }) =>
  Boolean(mail.authenticated) && (mail.from ?? "").trim().toLowerCase() === "forwarding-noreply@google.com";

/**
 * Whether the envelope sender is proven, as for an owner's Gmail filter forward (`anil+caf_=…@gmail.com`):
 * SPF passed for the envelope's domain, so it left that provider's servers, and the provider's own
 * DKIM signature passed. DKIM alone is not enough: a signed message can be replayed from anywhere.
 */
export const envelopeProven = (mail: Pick<Inbound, "signedBy" | "spfFor">, envelope: string | null | undefined) => {
  const d = domainOf(envelope);
  return Boolean(d && mail.spfFor !== undefined && (mail.spfFor === null || mail.spfFor === d) && mail.signedBy.some((s) => aligned(s, d)));
};

/**
 * Keeps the PDFs and pictures of an email; anything else is listed as skipped so the log can say so.
 * With `sheets`, for the sales address, it keeps spreadsheets, CSV, text exports and zips instead.
 */
export async function parseInbound(raw: ReadableStream | ArrayBuffer, opts: { sheets?: boolean; results?: string | null } = {}): Promise<Inbound> {
  const mail = await PostalMime.parse(raw instanceof ArrayBuffer ? raw : await new Response(raw).arrayBuffer());
  const attachments: Attachment[] = [];
  const skipped: string[] = [];
  for (const a of mail.attachments) {
    const name = a.filename ?? "attachment";
    const content = typeof a.content === "string" ? (new TextEncoder().encode(a.content).buffer as ArrayBuffer) : (a.content as ArrayBuffer);
    // The sender's type is only a hint; what is stored comes from the name and the bytes.
    const kind = opts.sheets ? (isSheetFile(name, a.mimeType) ? sheetType(name, content) : null) : billType(name, a.mimeType, content);
    if (!kind || content.byteLength > MAX_BYTES || attachments.length >= (opts.sheets ? 10 : MAX_ATTACHMENTS)) skipped.push(name);
    else attachments.push({ filename: name, mimeType: kind, content });
  }
  const from = mail.from?.address ?? null;
  return {
    from,
    name: mail.from?.name || null,
    subject: mail.subject ?? "",
    text: mail.text ?? "",
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    attachments,
    skipped,
    ...mailVerdict(opts.results, mail.headers, from),
  };
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** A header value on one line: an address or message id from a received message cannot add headers of its own. */
export const oneLine = (v: string) => v.replace(/[\r\n\0]+/g, " ").trim();

/** A plain-text message in UTF-8, as `send_email` takes it. */
export function plainMessage(m: {
  fromName: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string | null;
}): string {
  const domain = m.from.split("@")[1] ?? "localhost";
  const id = oneLine(m.messageId ?? `<${crypto.randomUUID()}@${domain}>`);
  const inReplyTo = m.inReplyTo ? oneLine(m.inReplyTo) : "";
  const headers = [
    `From: =?UTF-8?B?${b64(m.fromName)}?= <${oneLine(m.from)}>`,
    `To: <${oneLine(m.to)}>`,
    ...(m.replyTo ? [`Reply-To: <${oneLine(m.replyTo)}>`] : []),
    `Subject: =?UTF-8?B?${b64(m.subject)}?=`,
    `Message-ID: ${id}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
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
      const inReplyTo = m.inReplyTo ? oneLine(m.inReplyTo) : "";
      const headers: Record<string, string> = { "Message-ID": oneLine(id), ...(inReplyTo ? { "In-Reply-To": inReplyTo, References: inReplyTo } : {}) };
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: `${oneLine(m.fromName).replace(/[<>"]/g, "")} <${from}>`,
          to: [oneLine(m.to)],
          subject: oneLine(m.subject),
          text: m.body,
          ...(m.replyTo ? { reply_to: oneLine(m.replyTo) } : {}),
          headers,
        }),
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
