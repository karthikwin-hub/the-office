import type { CsChannel, CsMessage, CsThread } from "@office/contracts";
import type { CsStore } from "@office/engine";

type ThreadRow = {
  id: string;
  channel: string;
  key: string;
  name: string;
  party_id: string | null;
  verified: string | null;
  status: string;
  subject: string | null;
  started_at: string;
  last_at: string;
  last_in_at: string | null;
  disclosed: number;
  handoffs: number;
  first_reply_s: number | null;
  test: number;
};
type MessageRow = { id: string; thread_id: string; at: string; direction: string; by_who: string; text: string; intent: string | null; ground: string | null; status: string; external_id: string | null; error: string | null };

const toThread = (r: ThreadRow): CsThread => ({
  id: r.id,
  channel: r.channel as CsChannel,
  key: r.key,
  name: r.name,
  partyId: r.party_id,
  verifiedContact: r.verified,
  status: r.status as CsThread["status"],
  subject: r.subject,
  startedAt: r.started_at,
  lastAt: r.last_at,
  lastInboundAt: r.last_in_at,
  disclosed: Boolean(r.disclosed),
  handoffs: Number(r.handoffs),
  firstReplySeconds: r.first_reply_s === null ? null : Number(r.first_reply_s),
  test: Boolean(r.test),
});
const toMessage = (r: MessageRow): CsMessage => ({
  id: r.id,
  threadId: r.thread_id,
  at: r.at,
  direction: r.direction as CsMessage["direction"],
  by: r.by_who as CsMessage["by"],
  text: r.text,
  intent: r.intent,
  ground: r.ground as CsMessage["ground"],
  status: r.status as CsMessage["status"],
  externalId: r.external_id,
  error: r.error,
});

/** Customer conversations in the office's own SQLite, next to the books but not in them. */
export class SqlCsStore implements CsStore {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cs_thread (id TEXT PRIMARY KEY, channel TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, party_id TEXT, verified TEXT, status TEXT NOT NULL, subject TEXT, started_at TEXT NOT NULL, last_at TEXT NOT NULL, last_in_at TEXT, disclosed INTEGER NOT NULL, handoffs INTEGER NOT NULL, first_reply_s INTEGER, test INTEGER NOT NULL)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS cs_thread_by_key ON cs_thread (channel, key, last_at)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cs_message (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at TEXT NOT NULL, direction TEXT NOT NULL, by_who TEXT NOT NULL, text TEXT NOT NULL, intent TEXT, ground TEXT, status TEXT NOT NULL, external_id TEXT, error TEXT)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS cs_message_by_thread ON cs_message (thread_id, at)");
    sql.exec("CREATE INDEX IF NOT EXISTS cs_message_by_external ON cs_message (external_id)");
  }

  thread(id: string) {
    const r = this.sql.exec<ThreadRow>("SELECT * FROM cs_thread WHERE id = ?", id).toArray()[0];
    return r ? toThread(r) : null;
  }

  threadByKey(channel: CsChannel, key: string) {
    const r = this.sql.exec<ThreadRow>("SELECT * FROM cs_thread WHERE channel = ? AND key = ? ORDER BY last_at DESC LIMIT 1", channel, key).toArray()[0];
    return r ? toThread(r) : null;
  }

  saveThread(t: CsThread) {
    this.sql.exec(
      "INSERT OR REPLACE INTO cs_thread (id, channel, key, name, party_id, verified, status, subject, started_at, last_at, last_in_at, disclosed, handoffs, first_reply_s, test) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.id,
      t.channel,
      t.key,
      t.name,
      t.partyId,
      t.verifiedContact,
      t.status,
      t.subject,
      t.startedAt,
      t.lastAt,
      t.lastInboundAt,
      t.disclosed ? 1 : 0,
      t.handoffs,
      t.firstReplySeconds,
      t.test ? 1 : 0,
    );
  }

  threads(limit: number) {
    return this.sql.exec<ThreadRow>("SELECT * FROM cs_thread ORDER BY last_at DESC LIMIT ?", limit).toArray().map(toThread);
  }

  messages(threadId: string) {
    return this.sql.exec<MessageRow>("SELECT * FROM cs_message WHERE thread_id = ? ORDER BY at, rowid", threadId).toArray().map(toMessage);
  }

  message(id: string) {
    const r = this.sql.exec<MessageRow>("SELECT * FROM cs_message WHERE id = ?", id).toArray()[0];
    return r ? toMessage(r) : null;
  }

  byExternal(externalId: string) {
    const r = this.sql.exec<MessageRow>("SELECT * FROM cs_message WHERE external_id = ? LIMIT 1", externalId).toArray()[0];
    return r ? toMessage(r) : null;
  }

  addMessage(m: CsMessage) {
    this.sql.exec(
      "INSERT OR REPLACE INTO cs_message (id, thread_id, at, direction, by_who, text, intent, ground, status, external_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id,
      m.threadId,
      m.at,
      m.direction,
      m.by,
      m.text,
      m.intent,
      m.ground,
      m.status,
      m.externalId,
      m.error,
    );
  }

  updateMessage(id: string, patch: Partial<CsMessage>) {
    const m = this.message(id);
    if (m) this.addMessage({ ...m, ...patch, id });
  }

  countOut(channel: CsChannel, fromIso: string) {
    const r = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM cs_message m JOIN cs_thread t ON t.id = m.thread_id WHERE t.channel = ? AND t.test = 0 AND m.direction = 'out' AND m.status = 'sent' AND m.at >= ?", channel, fromIso)
      .toArray()[0];
    return Number(r?.n ?? 0);
  }

  prune(beforeIso: string) {
    const n = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cs_thread WHERE last_at < ?", beforeIso).toArray()[0]?.n ?? 0);
    if (!n) return 0;
    this.sql.exec("DELETE FROM cs_message WHERE thread_id IN (SELECT id FROM cs_thread WHERE last_at < ?)", beforeIso);
    this.sql.exec("DELETE FROM cs_thread WHERE last_at < ?", beforeIso);
    return n;
  }
}
