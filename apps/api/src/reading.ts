import type { Business } from "@office/contracts";
import { type ExtractContext, type Extraction, extractInvoice, fromModel, MODEL_SCHEMA, modelPrompt, needsModel, type TextItem } from "@office/engine";

type Run = (model: string, input: unknown) => Promise<unknown>;

export const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Models answer with an object, a JSON string, or JSON wrapped in prose; take the outermost object. */
export function modelJson(answer: unknown): unknown {
  const r = (answer as { response?: unknown })?.response ?? answer;
  if (r && typeof r === "object") return r;
  const s = String(r ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not answer with JSON.");
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * The rules read first. Only when they miss the number, the lines or a total
 * that adds up does the text model read the same runs, and its answer is kept
 * only if it checks out better than the rules did.
 */
export async function readText(ai: Ai, items: TextItem[], ctx: ExtractContext): Promise<Extraction> {
  const rules = extractInvoice(items, ctx);
  if (!needsModel(rules)) return rules;
  const run = ai.run.bind(ai) as unknown as Run;
  const { system, user } = modelPrompt(items, ctx.business);
  try {
    const answer = await run(TEXT_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: MODEL_SCHEMA },
      max_tokens: 2048,
      temperature: 0,
    });
    const model = fromModel(modelJson(answer), items, ctx);
    const failed = (e: Extraction) => e.checks.filter((c) => !c.ok).length;
    return needsModel(model) || failed(model) > failed(rules) ? rules : model;
  } catch {
    return rules;
  }
}

/** A scan has no text to point at, so the card says nothing can be highlighted and the owner compares by eye. */
export async function readScan(ai: Ai, image: ArrayBuffer, ctx: ExtractContext & { business: Business }): Promise<Extraction> {
  const run = ai.run.bind(ai) as unknown as Run;
  const { system } = modelPrompt([], ctx.business);
  const input = {
    messages: [
      { role: "system", content: `${system}\nThe JSON schema is: ${JSON.stringify(MODEL_SCHEMA)}\nThere are no numbered runs for an image, so set every item to null.` },
      { role: "user", content: "Read this invoice or bill and answer with the JSON only." },
    ],
    image: [...new Uint8Array(image)],
    max_tokens: 2048,
    temperature: 0,
  };
  let answer: unknown;
  try {
    answer = await run(VISION_MODEL, input);
  } catch (e) {
    // Meta's licence for this model has to be accepted once per account before it answers.
    if (!/agree/i.test(String(e))) throw e;
    await run(VISION_MODEL, { prompt: "agree" });
    answer = await run(VISION_MODEL, input);
  }
  return fromModel(modelJson(answer), [], ctx);
}
