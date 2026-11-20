import { app, nightly, receiveEmail } from "./app";
import type { Env } from "./env";
import { newRequestId, withRequest } from "./log";

export { Office } from "./office-agent";

export default {
  fetch: app.fetch,
  /** Bills and invoices emailed to an office's own address: attachments go to that office's files, and the Office reads what it can. */
  // Mail and the cron are not requests: each run gets an id of its own, so its log lines (and the offices') join up.
  email: (message: ForwardableEmailMessage, env: Env) => withRequest(newRequestId(), () => receiveEmail(message, env)),
  scheduled: async (_event: ScheduledController, env: Env) => void (await withRequest(newRequestId(), () => nightly(env))),
} satisfies ExportedHandler<Env>;
