import type { OfficeService } from "@office/engine";
import { QuotaError } from "../quota";
import { modelJson, TEXT_MODEL } from "../reading";

type Run = (model: string, input: unknown) => Promise<unknown>;

/**
 * Rewrites a drafted month's captions with the model, one channel version at a time. The engine keeps a caption
 * only if its figures are the books' own and it passes every check the template did; anything else, a model error
 * or a spent allowance leaves the template version. The calendar's desk card says how many the model wrote.
 */
export async function writeWithAi(ai: Ai | null, office: OfficeService, calendarId: string): Promise<{ written: number; tried: number }> {
  const jobs = ai ? office.aiDraftJobs(calendarId) : [];
  let written = 0;
  let tried = 0;
  for (const job of jobs) {
    tried++;
    try {
      const run = ai!.run.bind(ai) as unknown as Run;
      const answer = modelJson(
        await run(TEXT_MODEL, {
          messages: [
            { role: "system", content: job.prompt.system },
            { role: "user", content: job.prompt.user },
          ],
          response_format: { type: "json_schema", json_schema: job.prompt.schema },
          max_tokens: 500,
          temperature: 0.6,
        }),
      );
      if (office.applyAiDraft(job.postId, job.channelId, answer)) written++;
    } catch (e) {
      if (e instanceof QuotaError) {
        tried--;
        break;
      }
    }
  }
  office.noteAiDrafts(calendarId, written, tried);
  return { written, tried };
}
