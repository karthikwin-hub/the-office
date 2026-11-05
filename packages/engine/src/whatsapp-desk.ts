import { AGENT_BY_ID, type Note, type Role, type StagedChange, type WaLanguage, WA_LANGUAGE_NAMES } from "@office/contracts";
import type { OfficeService } from "./office";
import { phrase, WORDS } from "./whatsapp-phrases";

export { phrase, PHRASES, type PhraseKey } from "./whatsapp-phrases";

/** WhatsApp refuses a text message longer than this. */
export const WA_MAX = 4096;
/** How many waiting items one list shows; more than nine stops being easy to answer by number. */
export const WA_LIST = 9;
/** Work that needs reading in full before it goes; on WhatsApp it is opened on the desk, not approved by number. */
export const REVIEW_ON_DESK = new Set(["audit_flag", "share_file", "payroll_run", "campaign", "calendar", "broadcast", "post"]);

export type WaPerson = { name: string; email: string; role: Role };
export type WaListed = { n: number; id: string; print: string };
/** What the office remembers of one conversation: the numbers on the last list, and the messages already handled. */
export type WaSession = { list: WaListed[]; seen: string[]; lastAt: string | null; language: WaLanguage };
export const newSession = (language: WaLanguage = "en"): WaSession => ({ list: [], seen: [], lastAt: null, language });
/** A piece of a reply. Fixed phrases are already in the person's language; `translate` marks free text in English. */
export type WaPart = { text: string; translate?: boolean };
export type WaMessage = { id: string; text: string; at: string; /** said in a voice note, so it is repeated back first */ heard?: boolean; /** the question in English, when it was asked in another language */ english?: string; language?: WaLanguage | null };
export type WaTurn = { parts: WaPart[]; session: WaSession; decided: StagedChange[]; duplicate: boolean };
export type WaOptions = { base: string; /** the person chose a language in Settings rather than "auto" */ fixedLanguage?: WaLanguage | null };

export type WaAction = "approve" | "reject" | "later";
export type WaCommand =
  | { kind: "desk" }
  | { kind: "help" }
  | { kind: "join"; code: string }
  | { kind: "decide"; items: { n: number | "all"; action: WaAction }[] }
  | { kind: "show"; n: number }
  | { kind: "ask"; text: string };

const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0ae6, 0x0be6, 0x0c66, 0x0ce6];
/** Hindi, Bengali, Gujarati, Tamil, Telugu and Kannada digits become 0-9. */
function asciiDigits(s: string): string {
  return s.replace(/[\u0966-\u096f\u09e6-\u09ef\u0ae6-\u0aef\u0be6-\u0bef\u0c66-\u0c6f\u0ce6-\u0cef]/g, (c) => {
    const code = c.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9)!;
    return String(code - zero);
  });
}

const words = (s: string) =>
  asciiDigits(s)
    .toLowerCase()
    .replace(/(\d)([^\d\s])/gu, "$1 $2")
    .replace(/([^\d\s])(\d)/gu, "$1 $2")
    .split(/[\s,.;:!।|()\-–]+/u)
    .filter(Boolean);
const inSet = (w: string, set: string[]) => set.includes(w);
const actionOf = (w: string): WaAction | null => (inSet(w, WORDS.yes) ? "approve" : inSet(w, WORDS.no) ? "reject" : inSet(w, WORDS.later) ? "later" : null);

/** What a message asks for. Anything that is not a command is a question for the Office Manager. */
export function parseCommand(text: string): WaCommand {
  const raw = text.trim();
  const join = /^join\s*(\d{4})$/i.exec(asciiDigits(raw));
  if (join) return { kind: "join", code: join[1]! };
  const w = words(raw);
  if (!w.length) return { kind: "desk" };
  if (w.length <= 3 && (w.every((x) => inSet(x, WORDS.help)) || raw === "?")) return { kind: "help" };
  if (w.length <= 3 && w.some((x) => inSet(x, WORDS.desk)) && w.every((x) => inSet(x, WORDS.desk) || ["good", "morning", "there", "office"].includes(x))) return { kind: "desk" };
  if (/^good\s+morning$/i.test(raw)) return { kind: "desk" };

  const known = (x: string) => /^\d+$/.test(x) || actionOf(x) !== null || inSet(x, WORDS.all) || inSet(x, WORDS.filler);
  if (!w.every(known)) return { kind: "ask", text: raw };
  const items: { n: number | "all"; action: WaAction }[] = [];
  let waiting: (number | "all")[] = [];
  let lastAction: WaAction | null = null;
  for (const x of w) {
    if (/^\d+$/.test(x)) waiting.push(Number(x));
    else if (inSet(x, WORDS.all)) waiting.push("all");
    else {
      const a = actionOf(x);
      if (!a) continue;
      // "1 yes 2 no" and "yes 1 2" both read naturally; an action with nothing waiting applies to the numbers after it.
      if (waiting.length) {
        for (const n of waiting) items.push({ n, action: a });
        waiting = [];
      }
      lastAction = a;
    }
  }
  if (waiting.length && lastAction) for (const n of waiting) items.push({ n, action: lastAction });
  if (items.length) return { kind: "decide", items };
  if (waiting.length === 1 && typeof waiting[0] === "number") return { kind: "show", n: waiting[0] };
  if (lastAction) return { kind: "decide", items: [{ n: 0, action: lastAction }] };
  return { kind: "ask", text: raw };
}

const MARATHI = /(?:^|[\s,.?!।])(आहे|नाही|काय|मला|तुम्ही|सगळे|आणि|झाले|केले|नंतर|किती|कोण|कोणाकडे|होय|द्या|पाठवा)(?=$|[\s,.?!।])/u;
const ROMAN_HINDI = /\b(haan|nahi|nahin|kya|hai|hain|kitna|kitne|kaun|mujhe|mera|baad|sab|bhai|batao|kab|kaise)\b/;
const ROMAN_MARATHI = /\b(aahe|ahe|nako|kay|mala|tumhi|sagle|zala|kiti|kon|majha|sang)\b/;
const COMMAND_ONLY = new Set([...WORDS.yes, ...WORDS.no, ...WORDS.later, ...WORDS.all, ...WORDS.filler, ...WORDS.desk, ...WORDS.help, "good", "morning"]);

/** The language a message is written in, or null when it is only numbers and command words. */
export function detectLanguage(text: string): WaLanguage | null {
  if (/[\u0980-\u09ff]/.test(text)) return "bn";
  if (/[\u0a80-\u0aff]/.test(text)) return "gu";
  if (/[\u0b80-\u0bff]/.test(text)) return "ta";
  if (/[\u0c00-\u0c7f]/.test(text)) return "te";
  if (/[\u0c80-\u0cff]/.test(text)) return "kn";
  if (/[\u0900-\u097f]/.test(text)) return MARATHI.test(text) ? "mr" : "hi";
  const t = text.toLowerCase();
  if (ROMAN_MARATHI.test(t)) return "mr";
  if (ROMAN_HINDI.test(t)) return "hi";
  return words(t).some((x) => /^[a-z]{3,}$/.test(x) && !COMMAND_ONLY.has(x)) ? "en" : null;
}

/** Changes whenever the item does, so a number on an old list cannot approve something the owner has not seen. */
export function fingerprint(item: StagedChange): string {
  const s = `${item.status}|${item.title}|${item.summary}|${JSON.stringify(item.payload)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const firstSentence = (s: string, max = 110) => {
  const one = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const deskLink = (base: string) => `${base.replace(/\/$/, "")}/desk`;
export const figureLink = (base: string, figureId: string) => `${base.replace(/\/$/, "")}/?figure=${encodeURIComponent(figureId)}`;

/** A short digest and the numbered list; the numbers are remembered until the next list. */
export function deskParts(office: OfficeService, person: WaPerson, session: WaSession, opts: WaOptions & { morning?: boolean }): { parts: WaPart[]; session: WaSession } {
  const lang = session.language;
  const items = office.desk().items;
  const first = person.name.split(/\s+/)[0] || person.name;
  const parts: WaPart[] = [{ text: phrase(opts.morning ? "goodMorning" : "hello", lang, { name: first }) }];
  if (!items.length) return { parts: [...parts, { text: phrase("none", lang) }], session: { ...session, list: [] } };
  const shown = items.slice(0, WA_LIST);
  const list = shown.map((it, i) => ({ n: i + 1, id: it.id, print: fingerprint(it) }));
  parts.push({ text: phrase("waiting", lang, { count: items.length }) });
  for (const [i, it] of shown.entries()) {
    const who = AGENT_BY_ID[it.agentId]?.short ?? "";
    parts.push({ text: `${i + 1}. ${it.title}${who ? ` (${who})` : ""}\n   ${firstSentence(it.summary)}`, translate: true });
  }
  if (items.length > shown.length) parts.push({ text: `${phrase("more", lang, { count: items.length - shown.length })} ${deskLink(opts.base)}` });
  if (person.role === "owner") parts.push({ text: phrase("reply", lang) });
  return { parts, session: { ...session, list } };
}

/** An item read from a photo or a voice note joins the list, so the owner can answer it by number straight away. */
export function addToList(session: WaSession, item: StagedChange): { n: number; session: WaSession } {
  const existing = session.list.find((l) => l.id === item.id);
  if (existing) return { n: existing.n, session };
  const n = Math.max(0, ...session.list.map((l) => l.n)) + 1;
  return { n, session: { ...session, list: [...session.list, { n, id: item.id, print: fingerprint(item) }] } };
}

/** An answer from the Office Manager, with each figure followed by the link that opens where it came from. */
export function answerText(answer: Note, base: string): string {
  let links = 0;
  return answer
    .map((s) => {
      if (!("figureId" in s) || links >= 3) return s.text;
      links++;
      return `${s.text} (${figureLink(base, s.figureId)})`;
    })
    .join("");
}

/**
 * One message in, one reply out. Approvals go through the same `decide` as the web desk,
 * so trust rules and the log apply; only the owner may approve, and only what they were shown.
 */
export function handleWhatsApp(office: OfficeService, person: WaPerson, session: WaSession, msg: WaMessage, opts: WaOptions): WaTurn {
  if (session.seen.includes(msg.id)) return { parts: [], session, decided: [], duplicate: true };
  const language = opts.fixedLanguage ?? msg.language ?? detectLanguage(msg.text) ?? session.language;
  let s: WaSession = { ...session, language, lastAt: msg.at, seen: [...session.seen, msg.id].slice(-200) };
  const lang = s.language;
  const parts: WaPart[] = msg.heard ? [{ text: `${phrase("heard", lang)} "${msg.text}"` }] : [];
  const decided: StagedChange[] = [];
  const cmd = parseCommand(msg.text);

  switch (cmd.kind) {
    case "join":
      parts.push({ text: phrase("linked", lang) });
      break;
    case "help":
      parts.push({ text: phrase("help", lang) });
      break;
    case "desk": {
      const d = deskParts(office, person, s, opts);
      parts.push(...d.parts);
      s = d.session;
      break;
    }
    case "show": {
      const l = s.list.find((x) => x.n === cmd.n);
      const item = l && office.allStaged().find((x) => x.id === l.id);
      if (!l || !item) parts.push({ text: phrase(s.list.length ? "missing" : "noList", lang, { n: cmd.n }) });
      else {
        parts.push({ text: `${cmd.n}. ${item.title}\n${item.summary}`, translate: true });
        if (item.status !== "pending") parts.push({ text: phrase("gone", lang, { n: cmd.n }) });
        else if (person.role === "owner" && !REVIEW_ON_DESK.has(item.kind)) parts.push({ text: phrase("replyOne", lang, { n: cmd.n }) });
        else if (person.role === "owner") parts.push({ text: `${phrase("review", lang, { n: cmd.n })} ${deskLink(opts.base)}` });
      }
      break;
    }
    case "decide": {
      if (person.role !== "owner") {
        parts.push({ text: phrase("ownerOnly", lang) });
        break;
      }
      if (!s.list.length) {
        parts.push({ text: phrase("noList", lang) });
        break;
      }
      const targets: { n: number; action: WaAction }[] = [];
      for (const it of cmd.items) {
        if (it.n === "all") for (const l of s.list) targets.push({ n: l.n, action: it.action });
        else if (it.n === 0 && s.list.length === 1) targets.push({ n: s.list[0]!.n, action: it.action });
        else if (it.n === 0) parts.push({ text: phrase("reply", lang) });
        else targets.push({ n: it.n, action: it.action });
      }
      const done = new Set<number>();
      for (const t of targets) {
        if (done.has(t.n)) continue;
        done.add(t.n);
        const l = s.list.find((x) => x.n === t.n);
        const item = l && office.allStaged().find((x) => x.id === l.id);
        if (!l || !item) parts.push({ text: phrase("missing", lang, { n: t.n }) });
        else if (item.status !== "pending") parts.push({ text: phrase("gone", lang, { n: t.n }) });
        else if (fingerprint(item) !== l.print) parts.push({ text: phrase("changed", lang, { n: t.n }) });
        else if (t.action === "later") parts.push({ text: phrase("later", lang, { n: t.n }) });
        else if (REVIEW_ON_DESK.has(item.kind)) parts.push({ text: `${phrase("review", lang, { n: t.n })} ${deskLink(opts.base)}` });
        else {
          const d = office.decide(item.id, { action: t.action, note: "Decided on WhatsApp" }, person.name);
          decided.push(d);
          parts.push({ text: phrase(t.action === "approve" ? "approved" : "rejected", lang, { n: t.n }) });
        }
      }
      break;
    }
    case "ask": {
      const a = office.ask(msg.english ?? cmd.text);
      parts.push({ text: answerText(a.answer, opts.base), translate: true });
      break;
    }
  }
  return { parts, session: s, decided, duplicate: false };
}

/**
 * How the morning digest reaches someone who asked for it on WhatsApp. A free message only fits
 * inside the 24 hours after they last wrote; after that only a paid template can, if one is set up.
 */
export function digestChannel(o: { wantsWhatsApp: boolean; lastAt: string | null; now: number; template: boolean }): "whatsapp" | "template" | "email" {
  if (!o.wantsWhatsApp) return "email";
  if (o.lastAt && o.now - Date.parse(o.lastAt) < 24 * 3600_000) return "whatsapp";
  return o.template ? "template" : "email";
}

/** A quotation asked for in a voice note becomes a lead the Quote Desk drafts from; nothing goes to the customer yet. */
export function noteQuoteRequest(office: OfficeService, r: { party: string; need: string; by: string }): string {
  const id = `lead-wa-${Date.now().toString(36)}`;
  const day = office.asOf;
  office.books.leads.push({ id, name: r.party || "Customer from a voice note", city: "", source: "WhatsApp voice note", stage: "new", valuePaise: 0, need: r.need, createdOn: day, lastTouchOn: day, nextStep: "Draft the quotation" });
  const agent = office.hired("quote-desk") ? "quote-desk" : "sales-rep";
  office.log(agent, `${r.by} asked on WhatsApp for a quotation${r.party ? ` for ${r.party}` : ""}: "${r.need.slice(0, 120)}".`, { kind: "lead", id });
  return id;
}

/** Joins the parts and keeps the reply inside WhatsApp's limit, cutting at a line rather than mid-word. */
export function render(parts: WaPart[], max = WA_MAX): string {
  const text = parts.map((p) => p.text).join("\n\n");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 2);
  const at = cut.lastIndexOf("\n");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}\n…`;
}

/** Amounts, numbers, invoice numbers and links: what a translation must leave exactly as it was. */
export function protectedTokens(text: string): string[] {
  return text.match(/https?:\/\/\S+|₹\s?[\d,]+(?:\.\d+)?(?:\s?(?:lakh|crore))?|[A-Z]{1,6}[/-][\w/-]*\d[\w/-]*|\d[\d,./:-]*/g) ?? [];
}

/** True when every protected token of the English survives in the translation. */
export function keepsFigures(source: string, translated: string): boolean {
  const norm = (t: string) => t.replace(/\s?(lakh|crore)$/, "").replace(/\s/g, "");
  const out = translated.replace(/\s/g, "");
  return protectedTokens(source).every((t) => out.includes(norm(t)));
}

/** The instruction for the text model that translates free text; figures and links are kept as written. */
export function translatePrompt(lang: WaLanguage, texts: string[]): { system: string; user: string } {
  return {
    system: [
      `Translate each numbered line from English into ${WA_LANGUAGE_NAMES[lang]}, in a plain, polite tone for a business owner in India.`,
      "Keep every rupee amount, number, date, invoice or bill number, name and link exactly as written, including ₹ and the words lakh and crore.",
      'Answer only with JSON: {"lines": ["...", "..."]}, one translated line for each numbered line, in the same order.',
    ].join("\n"),
    user: texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ⏎ ")}`).join("\n"),
  };
}

/** Puts the model's lines back into the reply; any line that lost a figure stays in English. */
export function applyTranslation(parts: WaPart[], lines: unknown): WaPart[] {
  const got = Array.isArray(lines) ? lines : [];
  let i = 0;
  return parts.map((p) => {
    if (!p.translate) return p;
    const t = got[i++];
    const text = typeof t === "string" ? t.replace(/\s*⏎\s*/g, "\n").trim() : "";
    return text && keepsFigures(p.text, text) ? { text } : { text: p.text };
  });
}
