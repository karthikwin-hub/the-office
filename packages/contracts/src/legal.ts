import { z } from "zod";

/**
 * The documents a person accepts or reads before using the office. A new version date asks
 * everyone once more on their next visit; the consent record keeps which version each person saw.
 */
export const LEGAL_DOCUMENTS = {
  terms: { title: "Terms of service", version: "2026-11-05", path: "/legal/terms" },
  privacy: { title: "Privacy notice", version: "2026-11-05", path: "/legal/privacy" },
} as const;
export type LegalDocument = keyof typeof LEGAL_DOCUMENTS;
export const LegalDocumentId = z.enum(["terms", "privacy"]);

/** Every public page, including the ones nobody accepts but anyone may read. */
export const LEGAL_PAGES = ["terms", "privacy", "subprocessors", "data-processing", "ai-notice"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

export const ConsentRequest = z.object({ documents: z.array(z.object({ document: LegalDocumentId, version: z.string().min(1).max(20) })).min(1).max(4) }).strict();

/** A person's own rights, without asking the owner of any office: a copy of their account data, or its deletion. */
export const RightsRequestKind = z.enum(["delete"]);
export const RightsRequest = z.object({ kind: RightsRequestKind, note: z.string().trim().max(1000).optional() }).strict();
export const RightsRequestView = z.object({ id: z.string(), kind: RightsRequestKind, status: z.enum(["open", "done", "withdrawn"]), createdAt: z.string() });
export type RightsRequestView = z.infer<typeof RightsRequestView>;
