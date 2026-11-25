import type { OfficeService } from "@office/engine";
import { CS_SCHEMA } from "../customer/desk";
import { QuotaError } from "../quota";
import { modelJson, TEXT_MODEL } from "../reading";

type Run = (model: string, input: unknown) => Promise<unknown>;

/**
 * Asks the model about the comments and messages the rules were unsure of. It only picks one of the owner's saved
 * answers or facts, or says it is sensitive; the engine checks the pick and builds the reply from the owner's words.
 * A model error leaves the message with the owner; a spent allowance stops for the day.
 */
export async function sortInbox(ai: Ai | null, office: OfficeService): Promise<{ asked: number; sorted: number }> {
  const jobs = ai ? office.inboxSortJobs() : [];
  let asked = 0;
  let sorted = 0;
  for (const job of jobs) {
    try {
      const run = ai!.run.bind(ai) as unknown as Run;
      asked++;
      const answer = modelJson(
        await run(TEXT_MODEL, {
          messages: [
            { role: "system", content: job.system },
            { role: "user", content: job.user },
          ],
          response_format: { type: "json_schema", json_schema: CS_SCHEMA },
          max_tokens: 300,
          temperature: 0,
        }),
      );
      if (office.applyInboxSort(job.messageId, answer)) sorted++;
    } catch (e) {
      if (e instanceof QuotaError) {
        asked--;
        break;
      }
    }
  }
  return { asked, sorted };
}
