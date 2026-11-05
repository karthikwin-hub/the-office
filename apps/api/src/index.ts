import { app, purgeDeleted, receiveEmail } from "./app";
import type { Env } from "./env";

export { Office } from "./office-agent";

export default {
  fetch: app.fetch,
  /** Bills and invoices emailed to an office's own address: attachments go to that office's files, and the Office reads what it can. */
  email: (message: ForwardableEmailMessage, env: Env) => receiveEmail(message, env),
  scheduled: async (_event: ScheduledController, env: Env) => void (await purgeDeleted(env)),
} satisfies ExportedHandler<Env>;
