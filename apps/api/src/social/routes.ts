import type { Platform } from "@office/contracts";
import type { RouteKind } from "../tenancy";

const ROUTE_KIND: Partial<Record<Platform, RouteKind>> = {
  facebook: "meta_page",
  instagram: "ig_account",
  threads: "threads",
  linkedin: "linkedin",
  x: "x",
  whatsapp: "wa_phone",
};

/**
 * The ids webhooks will name for a connected channel, which the office claims so they reach only it. The shared
 * WhatsApp number belongs to no one office; WhatsApp ids are numbers, and the template name and language kept beside
 * them are the same in every office, so they are never claimed.
 */
export function routeIdsFor(platform: Platform, ids: (string | null | undefined)[], sharedPhoneId: string | undefined): { kind: RouteKind; id: string }[] {
  const kind = ROUTE_KIND[platform];
  if (!kind) return [];
  return ids
    .filter((id): id is string => Boolean(id) && /^[\w:.-]{1,120}$/.test(id!) && !(kind === "wa_phone" && (id === sharedPhoneId || !/^\d+$/.test(id!))))
    .map((id) => ({ kind, id }));
}
