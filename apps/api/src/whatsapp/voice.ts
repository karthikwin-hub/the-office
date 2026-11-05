import { WaLanguage } from "@office/contracts";
import { applyTranslation, translatePrompt, type WaPart } from "@office/engine";
import { modelJson, TEXT_MODEL } from "../reading";

type Run = (model: string, input: unknown) => Promise<unknown>;
export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
/** Voice notes up to about ten minutes; longer ones are refused before transcription. */
export const MAX_AUDIO = 6 * 1024 * 1024;

function base64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whisper transcribes and names the language; only the languages the office answers in are kept. */
export async function transcribe(ai: Ai, audio: ArrayBuffer): Promise<{ text: string; language: WaLanguage | null }> {
  const run = ai.run.bind(ai) as unknown as Run;
  const out = (await run(WHISPER, { audio: base64(audio), vad_filter: true })) as { text?: string; transcription_info?: { language?: string } };
  const lang = WaLanguage.safeParse(out.transcription_info?.language);
  return { text: (out.text ?? "").trim(), language: lang.success ? lang.data : null };
}

export type VoiceIntent = { kind: "invoice" | "quote" | "expense" | "question"; party: string | null; english: string };
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["invoice", "quote", "expense", "question"] },
    party: { type: ["string", "null"] },
    english: { type: "string" },
  },
  required: ["kind", "party", "english"],
};

/**
 * What a voice note is for. Bill a customer, quote one, record money paid out, or a question.
 * `english` is what was said, in English, with every number and name kept as spoken.
 */
export async function sortVoice(ai: Ai, transcript: string, business: string): Promise<VoiceIntent> {
  const run = ai.run.bind(ai) as unknown as Run;
  const fallback: VoiceIntent = { kind: "question", party: null, english: transcript };
  try {
    const answer = await run(TEXT_MODEL, {
      messages: [
        {
          role: "system",
          content: [
            `You sort voice notes from the owner of ${business}, an Indian business, into one of four kinds. Answer only with JSON.`,
            '"invoice": the owner wants a customer billed for goods sold, e.g. "bill Mehta 20 MCB 32 amp at 180".',
            '"quote": the owner wants a quotation prepared for a customer.',
            '"expense": the owner paid money out, e.g. "paid 2,400 for the tempo".',
            '"question": anything else, such as asking who owes money or what GST is due.',
            "party is the customer or payee named, or null. english is the note in plain English, keeping every number, amount, unit and name exactly as spoken.",
          ].join("\n"),
        },
        { role: "user", content: transcript },
      ],
      response_format: { type: "json_schema", json_schema: INTENT_SCHEMA },
      max_tokens: 400,
      temperature: 0,
    });
    const j = modelJson(answer) as Partial<VoiceIntent>;
    if (!j || !["invoice", "quote", "expense", "question"].includes(String(j.kind))) return fallback;
    return { kind: j.kind as VoiceIntent["kind"], party: typeof j.party === "string" && j.party.trim() ? j.party.trim() : null, english: typeof j.english === "string" && j.english.trim() ? j.english.trim() : transcript };
  } catch {
    return fallback;
  }
}

/** A question asked in another language, in English for the Office Manager; figures are kept as written. */
export async function toEnglish(ai: Ai, text: string): Promise<string> {
  const run = ai.run.bind(ai) as unknown as Run;
  try {
    const answer = await run(TEXT_MODEL, {
      messages: [
        { role: "system", content: 'Translate the message into plain English. Keep numbers, amounts and names exactly as written. Answer only with JSON: {"english": "..."}' },
        { role: "user", content: text },
      ],
      max_tokens: 300,
      temperature: 0,
    });
    const e = (modelJson(answer) as { english?: unknown }).english;
    return typeof e === "string" && e.trim() ? e.trim() : text;
  } catch {
    return text;
  }
}

/** Free text in the reply goes to the text model in one call; a line that loses a figure stays in English. */
export async function translateParts(ai: Ai, parts: WaPart[], lang: WaLanguage): Promise<WaPart[]> {
  const texts = parts.filter((p) => p.translate).map((p) => p.text);
  if (lang === "en" || !texts.length) return parts.map((p) => ({ text: p.text }));
  const run = ai.run.bind(ai) as unknown as Run;
  const { system, user } = translatePrompt(lang, texts);
  try {
    const answer = await run(TEXT_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 2048,
      temperature: 0,
    });
    return applyTranslation(parts, (modelJson(answer) as { lines?: unknown }).lines);
  } catch {
    return parts.map((p) => ({ text: p.text }));
  }
}
