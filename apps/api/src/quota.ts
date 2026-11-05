import type { Kv } from "./whatsapp/links";

/**
 * One office's daily allowance, so a busy or misused office cannot spend everyone's. The Customer
 * Service agent has its own model allowance, so a busy chat cannot use up the Accountant's reading.
 */
export const QUOTA = { aiCalls: 400, csAiCalls: 150, uploadBytes: 250 * 1024 * 1024 };

type What = "ai" | "cs_ai" | "upload";

export class QuotaError extends Error {
  constructor(what: What) {
    super(what === "ai" ? "This office has read as much as it can today. It will read again tomorrow." : what === "cs_ai" ? "The Customer Service agent has used today's model allowance; it answers from its rules until tomorrow." : "This office has stored as much as it can today. Try again tomorrow.");
  }
}

/** Counts against today's allowance in the office's own storage; throws once it is spent. */
export function take(kv: Kv, day: string, what: What, amount = 1): void {
  const key = `quota:${day}:${what}`;
  const used = Number(kv(key) ?? 0);
  const limit = what === "ai" ? QUOTA.aiCalls : what === "cs_ai" ? QUOTA.csAiCalls : QUOTA.uploadBytes;
  if (used + amount > limit) throw new QuotaError(what);
  kv(key, String(used + amount));
}

/** Workers AI, with every call counted against the office. Without the binding the office reads text layers only. */
export function meteredAi(ai: Ai, count: () => void): Ai {
  if (!ai) return ai;
  return new Proxy(ai, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "run" && typeof v === "function")
        return (...args: unknown[]) => {
          count();
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
