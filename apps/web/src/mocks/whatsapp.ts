import { type JoinCode, type Role, WhatsAppChange, WhatsAppDemoMessage, type WhatsAppDemoReply, type WhatsAppStatus } from "@office/contracts";
import { detectLanguage, handleWhatsApp, newSession, noteQuoteRequest, type OfficeService, parseCommand, phrase, render, type WaSession } from "@office/engine";
import { HttpResponse } from "msw";
import { SAMPLE_VOICE } from "./voice-samples";

const STATE_KEY = "office.wa.mock";
const BUSINESS_NUMBER = "+91 20 2712 4480";
type State = { linked: boolean; language: WhatsAppStatus["language"]; digest: boolean };
const sessions = new Map<Role, WaSession>();
let pendingCode: { code: string; expiresAt: number } | null = null;
let seq = 0;

const load = (): State => ({ linked: true, language: "auto", digest: false, ...JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") });
const save = (s: State) => localStorage.setItem(STATE_KEY, JSON.stringify(s));
const status = (s: State): WhatsAppStatus => ({ available: true, linked: s.linked, number: s.linked ? "+91 ••••• ••345" : null, language: s.language, digest: s.digest, businessNumber: BUSINESS_NUMBER, template: false });

/** The mock office on WhatsApp: the same conversation module as the live office, without the models. */
export async function mockWhatsApp(request: Request, path: string, role: Role, office: OfficeService, user: { name: string; email: string }): Promise<Response | null> {
  if (path === "/api/whatsapp/code" && request.method === "POST") {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    pendingCode = { code, expiresAt: Date.now() + 15 * 60_000 };
    return HttpResponse.json({ code, expiresAt: new Date(pendingCode.expiresAt).toISOString(), businessNumber: BUSINESS_NUMBER, link: `https://wa.me/912027124480?text=${encodeURIComponent(`JOIN ${code}`)}` } satisfies JoinCode);
  }
  if (path === "/api/whatsapp") {
    const s = load();
    if (request.method === "GET") return HttpResponse.json(status(s));
    if (request.method === "DELETE") {
      save({ ...s, linked: false });
      sessions.delete(role);
      return HttpResponse.json(status({ ...s, linked: false }));
    }
    const change = WhatsAppChange.safeParse(await request.json().catch(() => null));
    if (!change.success) return HttpResponse.json({ error: "Invalid change" }, { status: 400 });
    if (!s.linked) return HttpResponse.json({ error: "Link your WhatsApp first." }, { status: 409 });
    save({ ...s, ...change.data });
    return HttpResponse.json(status({ ...s, ...change.data }));
  }
  if (path !== "/api/whatsapp/demo" || request.method !== "POST") return null;

  const body = WhatsAppDemoMessage.safeParse(await request.json().catch(() => null));
  if (!body.success) return HttpResponse.json({ error: "Send a message or pick a voice note." }, { status: 400 });
  const s = load();
  const voice = SAMPLE_VOICE.find((v) => v.id === body.data.voice);
  const text = voice?.transcript ?? body.data.text?.trim() ?? "";
  const at = new Date().toISOString();
  const reply = (r: string, heard: string | null = null) => HttpResponse.json({ heard, reply: r } satisfies WhatsAppDemoReply);

  if (!s.linked) {
    const cmd = parseCommand(text);
    const lang = detectLanguage(text) ?? "en";
    if (cmd.kind !== "join" || !pendingCode || cmd.code !== pendingCode.code || pendingCode.expiresAt < Date.now()) return reply(cmd.kind === "join" ? phrase("badCode", lang) : "This phone is not linked to the office yet. Get a code in Settings, under Your WhatsApp, and send JOIN with it.");
    pendingCode = null;
    save({ ...s, linked: true });
    return reply(phrase("linked", lang));
  }

  const person = { ...user, role };
  const fixedLanguage = s.language === "auto" ? null : s.language;
  const session = sessions.get(role) ?? newSession();
  const opts = { base: location.origin, fixedLanguage };
  const id = `demo-${++seq}`;
  if (voice && voice.kind !== "question" && role === "owner") {
    const language = fixedLanguage ?? voice.language;
    const echo = `${phrase("heard", language)} "${voice.transcript}"`;
    sessions.set(role, { ...session, language, lastAt: at, seen: [...session.seen, id] });
    if (voice.kind === "quote") {
      noteQuoteRequest(office, { party: voice.party ?? "", need: voice.english, by: user.name });
      return reply(`${echo}\n\n${phrase("quoteNoted", language)}`, voice.transcript);
    }
    const what = voice.kind === "invoice" ? `a sales invoice to ${voice.party}` : `a bill from ${voice.party} for ₹2,400`;
    return reply(`${echo}\n\nIn the live office the Accountant drafts this as ${what}, with the voice note and its transcript attached, and it waits on your desk.`, voice.transcript);
  }
  const turn = handleWhatsApp(office, person, session, { id, text, at, heard: Boolean(voice), english: voice?.english, language: voice?.language ?? null }, opts);
  sessions.set(role, turn.session);
  return reply(render(turn.parts), voice ? voice.transcript : null);
}
