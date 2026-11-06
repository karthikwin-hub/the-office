import { BRAND, type Role } from "@office/contracts";

/** Who is asking, in which office. Built by the Worker from the session and a checked membership; a browser cannot set it. */
export type Caller = { userId: string; name: string; email: string; role: Role; officeId: string };
export const CALLER_HEADER = "x-office-caller";
/** The office itself, for mail, webhooks and alarms. */
export const system = (officeId: string): Caller => ({ userId: "system", name: BRAND.name, email: "office@localhost", role: "owner", officeId });

export type InboundDocs = { from: string | null; subject: string; docs: { id: string; mimeType: string; filename: string }[]; skipped: string[] };

export const newDocId = () => `doc-u${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
