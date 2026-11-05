import type { Role } from "@office/contracts";
import { type CsEffect, converse, type Inbound, type OfficeService, type ReceiveResult } from "@office/engine";
import { EmailMessage } from "cloudflare:email";
import { plainMessage } from "../mail";
import { TEXT_MODEL, modelJson } from "../reading";
import { sendText, type WaKeys } from "../whatsapp/cloud";
import { type Kv, type Link, sessionFor } from "../whatsapp/links";

type Run = (model: string, input: unknown) => Promise<unknown>;

/** What the model may answer, and nothing more. */
const CS_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["order_status", "balance", "answer", "fact", "greeting", "thanks", "human", "sensitive", "other"] },
    answerId: { type: ["string", "null"] },
    fact: { type: ["string", "null"] },
    orderNumber: { type: ["string", "null"] },
    topic: { type: ["string", "null"] },
    confidence: { type: "number" },
    summary: { type: "string" },
  },
  required: ["intent", "confidence", "summary"],
};

export type DeskDeps = {
  office: OfficeService;
  kv: Kv;
  /** Workers AI counted against the agent's own allowance; null to use the rules only. */
  ai: Ai | null;
  /** The office's own WhatsApp number. Customers are never answered from the shared number. */
  ownKeys: () => Promise<WaKeys | null>;
  sharedKeys: () => WaKeys | null;
  mailer: SendEmail | undefined;
  mailFrom: string;
  businessName: string;
  /** The address customers write to; replies say to answer there. */
  supportAddress: string | null;
  /** Owners of this office linked on WhatsApp. */
  ownersOnWhatsApp: () => Promise<(Link & { role: Role })[]>;
  log: (message: string, e?: unknown) => void;
};

/**
 * The Customer Service agent's hands in the Worker, like SocialHost for the platforms: it asks the
 * model when the rules are not sure, sends what the engine queued on each channel, and tells linked
 * owners about a hand-off on WhatsApp.
 */
export class CustomerDesk {
  constructor(private d: DeskDeps) {}

  private model() {
    const ai = this.d.ai;
    if (!ai) return undefined;
    const run = ai.run.bind(ai) as unknown as Run;
    return async (p: { system: string; user: string }) =>
      modelJson(
        await run(TEXT_MODEL, {
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
          response_format: { type: "json_schema", json_schema: CS_SCHEMA },
          max_tokens: 300,
          temperature: 0,
        }),
      );
  }

  async receive(m: Inbound): Promise<ReceiveResult> {
    const r = await converse(this.d.office.customers, m, this.model());
    await this.run();
    return r;
  }

  /** Delivers whatever the agent queued. A message that cannot go is marked failed with the reason, in the conversation and the log. */
  async run(effects: CsEffect[] = this.d.office.customers.takeEffects()) {
    const cs = this.d.office.customers;
    for (const e of effects) {
      try {
        if (e.kind === "notify") await this.notify(e.text);
        else if (e.channel === "whatsapp") {
          const keys = await this.d.ownKeys();
          if (!keys) throw new Error("Connect your own WhatsApp number in Settings to answer customers there.");
          cs.markSent(e.messageId, await sendText(keys, e.to, e.text));
        } else if (e.channel === "email") {
          if (!this.d.mailer) throw new Error("Email is not set up for this office.");
          const domain = this.d.mailFrom.split("@")[1] ?? "localhost";
          const id = `<${e.messageId}@${domain}>`;
          const raw = plainMessage({ fromName: this.d.businessName, from: this.d.mailFrom, to: e.to, replyTo: this.d.supportAddress ?? undefined, subject: e.subject ?? this.d.businessName, body: e.text, messageId: id, inReplyTo: e.inReplyTo });
          await this.d.mailer.send(new EmailMessage(this.d.mailFrom, e.to, raw));
          cs.markSent(e.messageId, id);
        } else cs.markSent(e.messageId, null);
      } catch (err) {
        if (e.kind === "send") cs.markFailed(e.messageId, err instanceof Error ? err.message : String(err));
        else this.d.log("could not tell the owners about a hand-off", err);
      }
    }
  }

  /** Owners who wrote to the office on WhatsApp in the last 24 hours hear at once; the rest find it on the desk and in the digest. */
  private async notify(text: string) {
    const keys = this.d.sharedKeys();
    if (!keys) return;
    for (const l of await this.d.ownersOnWhatsApp()) {
      if (l.role !== "owner") continue;
      const last = sessionFor(this.d.kv, l.phone).lastAt;
      if (!last || Date.now() - Date.parse(last) > 23 * 3600_000) continue;
      await sendText(keys, l.phone, `*${this.d.businessName}*\n${text}`);
    }
  }
}
