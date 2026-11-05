import type { IngestResult, Role, StagedChange } from "@office/contracts";
import { addToList, deskParts, detectLanguage, handleWhatsApp, noteQuoteRequest, type OfficeService, parseCommand, phrase, render, type TextItem, type WaPart, type WaSession } from "@office/engine";
import { docKey, fileUrl } from "../keys";
import type { Fetch } from "../social/adapter";
import type { WaIncoming } from "../social/webhooks";
import { downloadMedia, type WaKeys } from "./cloud";
import { type Kv, saveSession, sessionFor, type WaPerson } from "./links";
import { MAX_AUDIO, sortVoice, toEnglish, transcribe, translateParts } from "./voice";

export const MAX_DOC = 10 * 1024 * 1024;

export type WaDeps = {
  kv: Kv;
  officeId: string;
  office: OfficeService;
  ai: Ai;
  keys: WaKeys | null;
  base: string;
  fetch?: Fetch;
  now?: number;
  newDocId: () => string;
  store: (key: string, bytes: ArrayBuffer | string, contentType: string, meta: Record<string, string>) => Promise<void>;
  readImage: (docId: string, image: ArrayBuffer, auto: boolean) => Promise<IngestResult>;
  readItems: (docId: string, items: TextItem[], auto: boolean) => Promise<IngestResult>;
};
export type WaOutcome = { to: string; text: string; decided: StagedChange[] } | null;

const line = (str: string, i: number): TextItem => ({ str: str.slice(0, 500), page: 1, x: 0.05, y: 0.05 + i * 0.03, w: 0.9, h: 0.02 });
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * One WhatsApp message to the office from someone in it. Who they are was settled before it
 * got here, from the phone's link and their membership. Nothing is posted from WhatsApp;
 * whatever is read waits on the desk. `heading` names the business when the person is in several.
 */
export async function officeWhatsApp(deps: WaDeps, m: WaIncoming, link: WaPerson, how: { joined?: boolean; heading?: string } = {}): Promise<WaOutcome> {
  const cmd = m.kind === "text" ? parseCommand(m.text) : null;
  const titled = (text: string) => (how.heading ? `*${how.heading}*\n${text}` : text);
  if (how.joined) {
    const lang = link.language === "auto" ? (detectLanguage(m.text) ?? "en") : link.language;
    saveSession(deps.kv, m.from, { ...sessionFor(deps.kv, m.from), lastAt: m.at, seen: [m.id] });
    deps.office.log("office-manager", `${link.name} linked their WhatsApp to the office.`);
    return { to: m.from, text: titled(phrase("linked", lang)), decided: [] };
  }

  let session = sessionFor(deps.kv, m.from);
  // Meta redelivers when a reply is slow; a voice note can take a while, so the id is claimed before any work.
  if (session.seen.includes(m.id) || deps.kv(`wa:msg:${m.id}`)) return null;
  deps.kv(`wa:msg:${m.id}`, m.at);
  const person = { name: link.name, email: link.email, role: link.role };
  const fixedLanguage = link.language === "auto" ? null : link.language;
  const opts = { base: deps.base, fixedLanguage, office: deps.officeId };
  let parts: WaPart[] = [];
  let decided: StagedChange[] = [];
  const mark = (language = session.language) => (session = { ...session, language: fixedLanguage ?? language, lastAt: m.at, seen: [...session.seen, m.id].slice(-200) });
  const listed = (staged: StagedChange | null): WaPart[] => {
    if (!staged || staged.status !== "pending") return [];
    const added = addToList(session, staged);
    session = added.session;
    return [{ text: staged.title, translate: true }, { text: phrase("onDesk", session.language, { n: added.n }) }];
  };

  if (m.kind === "text") {
    const language = fixedLanguage ?? detectLanguage(m.text) ?? session.language;
    const english = cmd?.kind === "ask" && language !== "en" ? await toEnglish(deps.ai, m.text) : undefined;
    const turn = handleWhatsApp(deps.office, person, session, { id: m.id, text: m.text, at: m.at, english, language }, opts);
    session = turn.session;
    parts = turn.parts;
    decided = turn.decided;
  } else if ((m.kind === "image" || m.kind === "document") && m.media) {
    mark();
    const isPdf = m.media.mimeType === "application/pdf" || /\.pdf$/i.test(m.media.filename ?? "");
    const isImage = /^image\/(png|jpe?g|webp)$/.test(m.media.mimeType);
    if (!deps.keys || (!isPdf && !isImage)) parts = [{ text: phrase("unreadable", session.language) }];
    else {
      try {
        const file = await downloadMedia(deps.keys, m.media.id, MAX_DOC, deps.fetch);
        const id = deps.newDocId();
        await deps.store(docKey(deps.officeId, id), file.bytes, isPdf ? "application/pdf" : file.mimeType, { filename: m.media.filename ?? `whatsapp-${id}`, by: link.email });
        deps.office.receiveDocument({ id, file: fileUrl(deps.officeId, id), channel: "whatsapp", from: link.name, pages: 1 });
        if (isPdf) parts = [{ text: "Got the PDF. The Accountant reads it the next time the office is open in a browser, and it will wait on your desk.", translate: true }];
        else {
          const r = await deps.readImage(id, file.bytes, false);
          parts = r.staged?.status === "pending" ? listed(r.staged) : [{ text: phrase("unreadable", session.language) }];
        }
      } catch {
        parts = [{ text: phrase("unreadable", session.language) }];
      }
    }
  } else if (m.kind === "audio" && m.media && deps.keys) {
    try {
      const audio = await downloadMedia(deps.keys, m.media.id, MAX_AUDIO, deps.fetch);
      const heard = await transcribe(deps.ai, audio.bytes);
      if (!heard.text) {
        mark();
        parts = [{ text: phrase("noVoice", session.language) }];
      } else {
        const intent = await sortVoice(deps.ai, heard.text, deps.office.books.business.name);
        const language = fixedLanguage ?? heard.language ?? detectLanguage(heard.text) ?? session.language;
        if (intent.kind === "question" || person.role !== "owner") {
          const turn = handleWhatsApp(deps.office, person, session, { id: m.id, text: heard.text, at: m.at, heard: true, english: intent.english, language }, opts);
          session = turn.session;
          parts = turn.parts;
          decided = turn.decided;
        } else {
          mark(language);
          const echo: WaPart = { text: `${phrase("heard", session.language)} "${heard.text}"` };
          if (intent.kind === "quote") {
            noteQuoteRequest(deps.office, { party: intent.party ?? "", need: intent.english, by: link.name });
            parts = [echo, { text: phrase("quoteNoted", session.language) }];
          } else {
            const id = deps.newDocId();
            await deps.store(docKey(deps.officeId, id), audio.bytes, audio.mimeType, { filename: `voice-note-${id}.ogg`, by: link.email });
            await deps.store(docKey(deps.officeId, `${id}.txt`), heard.text, "text/plain; charset=utf-8", { transcriptOf: id });
            deps.office.receiveDocument({ id, file: fileUrl(deps.officeId, id), channel: "whatsapp", from: link.name, pages: 1 });
            const b = deps.office.books.business;
            const header =
              intent.kind === "invoice" ? `Tax invoice from ${b.legalName} GSTIN ${b.gstin} to ${intent.party ?? "the customer"}` : `Bill from ${intent.party ?? "a supplier"} to ${b.legalName} GSTIN ${b.gstin}`;
            const items = [header, `Date ${dmy(deps.office.asOf)}`, intent.english, heard.text].map(line);
            const r = await deps.readItems(id, items, false);
            if (r.staged) r.staged.summary = `From a voice note: "${heard.text}". ${r.staged.summary}`;
            const onDesk = listed(r.staged);
            parts = onDesk.length ? [echo, ...onDesk] : [echo, { text: "I could not make a draft from that. Say who it is for, what, how many and at what rate.", translate: true }];
          }
        }
      }
    } catch {
      mark();
      parts = [{ text: phrase("noVoice", session.language) }];
    }
  } else {
    mark();
    parts = [{ text: phrase("help", session.language) }];
  }

  saveSession(deps.kv, m.from, session);
  const translated = await translateParts(deps.ai, parts, session.language);
  return { to: m.from, text: titled(render(translated)), decided };
}

/** The morning digest as one message, in the person's language; its numbers are remembered for the replies. */
export async function morningDigest(
  deps: Pick<WaDeps, "kv" | "office" | "ai" | "base" | "officeId">,
  phone: string,
  person: { name: string; email: string; role: Role },
  fixed: WaSession["language"] | null,
  heading?: string,
): Promise<string> {
  const session = sessionFor(deps.kv, phone);
  const d = deskParts(deps.office, person, { ...session, language: fixed ?? session.language }, { base: deps.base, morning: true, office: deps.officeId });
  saveSession(deps.kv, phone, d.session);
  const text = render(await translateParts(deps.ai, d.parts, d.session.language));
  return heading ? `*${heading}*\n${text}` : text;
}