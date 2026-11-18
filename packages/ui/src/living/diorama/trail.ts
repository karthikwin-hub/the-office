import type { OfficeView } from "@office/contracts";

/**
 * What changed in the office since the floor last looked, as things to act out: a document
 * arriving, a sheet carried to the owner's desk, a decision stamped or crumpled, someone
 * hired or let go. Pure and remembering what it has already shown, so a refetch never
 * replays history and the first look at the floor acts nothing out.
 */

export type Channel = "email" | "upload" | "whatsapp" | "social" | "other";
export type TrailEvent =
  | { kind: "arrive"; docId: string; agentId: string; channel: Channel; label: string }
  | { kind: "toDesk"; agentId: string; count: number }
  | { kind: "decide"; id: string; agentId: string; status: "approved" | "rejected" }
  | { kind: "hire"; agentId: string }
  | { kind: "leave"; agentId: string };

export type TrailState = { started: boolean; arrived: string[]; decided: string[]; waiting: Record<string, number>; hired: string[] };
export const startTrail = (): TrailState => ({ started: false, arrived: [], decided: [], waiting: {}, hired: [] });

type Snapshot = Pick<OfficeView, "rooms" | "arriving" | "decided">;

const channelOf = (c: OfficeView["arriving"][number]["channel"]): Channel =>
  c === "email" || c === "upload" || c === "whatsapp" || c === "social" ? c : "other";

export function trail(prev: TrailState, view: Snapshot): { state: TrailState; events: TrailEvent[] } {
  const hired = view.rooms.filter((r) => r.hired).map((r) => r.agentId);
  const waiting = Object.fromEntries(view.rooms.map((r) => [r.agentId, r.waitingCount]));
  const arriving = view.arriving ?? [];
  const decided = view.decided ?? [];
  const next: TrailState = {
    started: true,
    arrived: [...new Set([...prev.arrived, ...arriving.map((a) => a.docId)])].slice(-100),
    decided: [...new Set([...prev.decided, ...decided.map((d) => d.id)])].slice(-100),
    waiting,
    hired,
  };
  if (!prev.started) return { state: next, events: [] };

  const events: TrailEvent[] = [];
  const was = new Set(prev.hired);
  const now = new Set(hired);
  for (const id of hired) if (!was.has(id)) events.push({ kind: "hire", agentId: id });
  for (const id of prev.hired) if (!now.has(id)) events.push({ kind: "leave", agentId: id });
  for (const a of arriving) if (!prev.arrived.includes(a.docId)) events.push({ kind: "arrive", docId: a.docId, agentId: a.agentId, channel: channelOf(a.channel), label: a.label });
  // Oldest decision first, so the pile comes down in the order the owner worked.
  for (const d of decided.slice().reverse()) if (!prev.decided.includes(d.id)) events.push({ kind: "decide", id: d.id, agentId: d.agentId, status: d.status });
  for (const id of hired) {
    const more = (waiting[id] ?? 0) - (prev.waiting[id] ?? 0);
    if (more > 0 && was.has(id)) events.push({ kind: "toDesk", agentId: id, count: more });
  }
  return { state: next, events };
}
