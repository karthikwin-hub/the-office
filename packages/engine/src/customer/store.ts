import type { CsChannel, CsMessage, CsThread } from "@office/contracts";

/**
 * A one-time code sent to the phone or email on an order, which a website visitor types back to show the
 * order is theirs. Kept with the conversations, never in a message the visitor can read.
 */
export type CsCode = {
  id: string;
  threadId: string;
  code: string;
  /** Where it went: the email address or phone number on the order. Once typed back, the conversation is confirmed as this. */
  contact: string;
  partyId: string | null;
  orderNumber: string;
  /** What the visitor asked, answered once the code is right. */
  ask: "order_status" | "balance";
  sentAt: string;
  expiresAt: string;
  tries: number;
  /** Typed correctly, or tried too often. */
  done: boolean;
};

/**
 * Where conversations are kept: the office's own SQLite when live, memory in the mockups and tests.
 * Outside the books, so a busy chat does not make every request load and save more.
 */
export interface CsStore {
  thread(id: string): CsThread | null;
  /** The latest conversation with this phone, address or visitor on this channel. */
  threadByKey(channel: CsChannel, key: string): CsThread | null;
  saveThread(t: CsThread): void;
  /** Most recent first, up to `limit`. */
  threads(limit: number): CsThread[];
  /** Oldest first. */
  messages(threadId: string): CsMessage[];
  message(id: string): CsMessage | null;
  byExternal(externalId: string): CsMessage | null;
  addMessage(m: CsMessage): void;
  updateMessage(id: string, patch: Partial<CsMessage>): void;
  /** Messages sent on a channel since a time, for the WhatsApp monthly count. */
  countOut(channel: CsChannel, fromIso: string): number;
  /** Conversations, not the owner's tries, that started on a channel since a time. */
  countStarted(channel: CsChannel, fromIso: string): number;
  /** Deletes conversations whose last message is older than this; returns how many went. */
  prune(beforeIso: string): number;
  saveCode(c: CsCode): void;
  /** Codes sent since a time, oldest first. */
  codesSince(fromIso: string): CsCode[];
}

export class MemoryCsStore implements CsStore {
  private ts = new Map<string, CsThread>();
  private ms: CsMessage[] = [];
  private cs = new Map<string, CsCode>();
  thread(id: string) {
    return this.ts.get(id) ?? null;
  }
  threadByKey(channel: CsChannel, key: string) {
    return [...this.ts.values()].filter((t) => t.channel === channel && t.key === key).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0] ?? null;
  }
  saveThread(t: CsThread) {
    this.ts.set(t.id, { ...t });
  }
  threads(limit: number) {
    return [...this.ts.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).slice(0, limit);
  }
  messages(threadId: string) {
    return this.ms.filter((m) => m.threadId === threadId).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  message(id: string) {
    return this.ms.find((m) => m.id === id) ?? null;
  }
  byExternal(externalId: string) {
    return this.ms.find((m) => m.externalId === externalId) ?? null;
  }
  addMessage(m: CsMessage) {
    this.ms.push({ ...m });
  }
  updateMessage(id: string, patch: Partial<CsMessage>) {
    const i = this.ms.findIndex((m) => m.id === id);
    if (i >= 0) this.ms[i] = { ...this.ms[i]!, ...patch };
  }
  countOut(channel: CsChannel, fromIso: string) {
    const ids = new Set([...this.ts.values()].filter((t) => t.channel === channel && !t.test).map((t) => t.id));
    return this.ms.filter((m) => ids.has(m.threadId) && m.direction === "out" && m.status === "sent" && m.at >= fromIso).length;
  }
  countStarted(channel: CsChannel, fromIso: string) {
    return [...this.ts.values()].filter((t) => t.channel === channel && !t.test && t.startedAt >= fromIso).length;
  }
  prune(beforeIso: string) {
    const gone = [...this.ts.values()].filter((t) => t.lastAt < beforeIso).map((t) => t.id);
    for (const id of gone) this.ts.delete(id);
    const set = new Set(gone);
    this.ms = this.ms.filter((m) => !set.has(m.threadId));
    for (const [id, c] of this.cs) if (set.has(c.threadId) || c.sentAt < beforeIso) this.cs.delete(id);
    return gone.length;
  }
  saveCode(c: CsCode) {
    this.cs.set(c.id, { ...c });
  }
  codesSince(fromIso: string) {
    return [...this.cs.values()]
      .filter((c) => c.sentAt >= fromIso)
      .sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0))
      .map((c) => ({ ...c }));
  }
}
