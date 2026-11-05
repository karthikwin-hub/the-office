import type { WaLanguage } from "@office/contracts";
import { detectLanguage, parseCommand, phrase } from "@office/engine";
import { metaPieces, parseWhatsAppMessages, waMessagePieces } from "./social/webhooks";
import type { ControlPlane, RouteKind } from "./tenancy";
import type { WaDirectory, WaPerson } from "./whatsapp/links";

/** What one webhook delivery becomes: pieces for each office, and the few answers the Worker gives itself. */
export type MetaPlan = {
  /** Comments, reviews and messages to an office's own page or number, for its inbox. */
  deliveries: { officeId: string; body: unknown }[];
  /** Someone in an office, writing to the shared number. */
  office: { officeId: string; body: unknown; person: WaPerson; joined: boolean; heading?: string }[];
  /** Answers that belong to no office: a wrong code, or a choice between offices. */
  replies: { to: string; text: string }[];
  /** Entries no office claims; dropped, and counted for the log. */
  unrouted: number;
};

const KIND_BY_OBJECT: Record<string, RouteKind[]> = { page: ["meta_page"], instagram: ["ig_account"], threads: ["threads"] };

/**
 * Splits a Meta delivery by who it belongs to. An office receives only entries for a page,
 * account or number it has connected; the shared WhatsApp number is split per sender,
 * by the phone's link and the office that person last chose.
 */
export async function planMeta(cp: ControlPlane, dir: WaDirectory, body: unknown, sharedPhoneId: string | undefined): Promise<MetaPlan> {
  const plan: MetaPlan = { deliveries: [], office: [], replies: [], unrouted: 0 };
  const byOffice = new Map<string, { object: unknown; entry: unknown[] }>();
  const deliver = (officeId: string, object: unknown, entry: unknown) => {
    const d = byOffice.get(officeId) ?? { object, entry: [] };
    d.entry.push(entry);
    byOffice.set(officeId, d);
  };

  for (const piece of metaPieces(body)) {
    if (piece.object === "whatsapp_business_account") {
      if (sharedPhoneId && piece.phoneNumberId === sharedPhoneId) {
        for (const sub of waMessagePieces(piece)) await planShared(cp, dir, sub.from, sub.body, plan);
        continue;
      }
      const officeId = piece.phoneNumberId ? await cp.routeFor("wa_phone", piece.phoneNumberId) : null;
      if (officeId) deliver(officeId, piece.body.object, piece.body.entry![0]);
      else plan.unrouted++;
      continue;
    }
    const kinds = KIND_BY_OBJECT[piece.object];
    const officeId = kinds && piece.entryId ? await cp.routeFor(kinds, piece.entryId) : null;
    if (officeId) deliver(officeId, piece.body.object, piece.body.entry![0]);
    else plan.unrouted++;
  }
  for (const [officeId, d] of byOffice) plan.deliveries.push({ officeId, body: d });
  return plan;
}

async function planShared(cp: ControlPlane, dir: WaDirectory, from: string, body: unknown, plan: MetaPlan) {
  const m = parseWhatsAppMessages(body)[0];
  if (!m) return;
  const cmd = m.kind === "text" ? parseCommand(m.text) : null;
  let link = await dir.linkByPhone(from);
  const lang = (): WaLanguage => (link && link.language !== "auto" ? link.language : (detectLanguage(m.text) ?? "en"));

  if (cmd?.kind === "join") {
    const r = await dir.redeem(from, cmd.code);
    if ("error" in r) {
      plan.replies.push({ to: from, text: phrase(r.error, lang()) });
      return;
    }
    link = r.link;
    const person = await dir.personIn(r.officeId, from);
    if (person) plan.office.push({ officeId: r.officeId, body, person, joined: true, heading: await headingFor(cp, link.userId, r.officeId) });
    return;
  }
  // A number no one has linked is a stranger to every office; the shared number has no inbox.
  if (!link) {
    plan.unrouted++;
    return;
  }

  const offices = (await cp.officesOf(link.userId)).filter((o) => o.status === "active");
  if (cmd?.kind === "switch") {
    if (offices.length <= 1) plan.replies.push({ to: from, text: phrase(offices.length ? "oneOffice" : "noOffice", lang()) });
    else if (cmd.n === null || !offices[cmd.n - 1]) {
      const list = offices.map((o, i) => `${i + 1}. ${o.name}${o.id === link!.activeOfficeId ? " ✓" : ""}`).join("\n");
      plan.replies.push({ to: from, text: phrase("switchList", lang(), { list }) });
    } else {
      const chosen = offices[cmd.n - 1]!;
      await dir.setActive(from, chosen.id);
      plan.replies.push({ to: from, text: phrase("switched", lang(), { office: chosen.name }) });
    }
    return;
  }

  let officeId = link.activeOfficeId && offices.some((o) => o.id === link!.activeOfficeId) ? link.activeOfficeId : null;
  if (!officeId && offices.length) {
    officeId = offices[0]!.id;
    await dir.setActive(from, officeId);
  }
  const person = officeId ? await dir.personIn(officeId, from) : null;
  if (!officeId || !person) {
    plan.replies.push({ to: from, text: phrase("noOffice", lang()) });
    return;
  }
  plan.office.push({ officeId, body, person, joined: false, heading: offices.length > 1 ? offices.find((o) => o.id === officeId)?.name : undefined });
}

async function headingFor(cp: ControlPlane, userId: string, officeId: string): Promise<string | undefined> {
  const offices = (await cp.officesOf(userId)).filter((o) => o.status === "active");
  return offices.length > 1 ? offices.find((o) => o.id === officeId)?.name : undefined;
}
