import type { BookEdit } from "@office/contracts";
import { chain, type EditLog } from "@office/engine";

type Row = { seq: number; at: string; by_name: string; coll: string; record_id: string; action: BookEdit["action"]; changes: string; hash: string };

const toEdit = (r: Row): BookEdit => ({ seq: r.seq, at: r.at, by: r.by_name, coll: r.coll, recordId: r.record_id, action: r.action, changes: JSON.parse(r.changes) as BookEdit["changes"], hash: r.hash });

/**
 * The books' edit log in the office's own SQLite. Rows are only ever inserted: triggers refuse an
 * update or a delete, so not even the office's own code can rewrite history. Purging the office
 * removes the whole store, after a copy is kept for the retention period.
 */
export class SqlEditLog implements EditLog {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS book_edits (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, by_name TEXT NOT NULL, coll TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL, hash TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS book_edits_record ON book_edits (coll, record_id)");
    sql.exec("CREATE TRIGGER IF NOT EXISTS book_edits_no_update BEFORE UPDATE ON book_edits BEGIN SELECT RAISE(ABORT, 'the edit log is append-only'); END");
    sql.exec("CREATE TRIGGER IF NOT EXISTS book_edits_no_delete BEFORE DELETE ON book_edits BEGIN SELECT RAISE(ABORT, 'the edit log is append-only'); END");
  }

  append(entries: Omit<BookEdit, "seq" | "hash">[]) {
    let prev = this.last();
    for (const e of entries) {
      const next = chain(prev, e);
      this.sql.exec("INSERT INTO book_edits (seq, at, by_name, coll, record_id, action, changes, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", next.seq, next.at, next.by, next.coll, next.recordId, next.action, JSON.stringify(next.changes), next.hash);
      prev = next;
    }
  }

  list(opts: { coll?: string; recordId?: string; limit?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.coll) {
      where.push("coll = ?");
      args.push(opts.coll);
    }
    if (opts.recordId) {
      where.push("record_id = ?");
      args.push(opts.recordId);
    }
    args.push(opts.limit ?? 100);
    return this.sql.exec<Row>(`SELECT * FROM book_edits ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...args).toArray().map(toEdit);
  }

  all() {
    return this.sql.exec<Row>("SELECT * FROM book_edits ORDER BY seq").toArray().map(toEdit);
  }

  count() {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM book_edits").one().n;
  }

  last() {
    const r = this.sql.exec<Row>("SELECT * FROM book_edits ORDER BY seq DESC LIMIT 1").toArray()[0];
    return r ? toEdit(r) : null;
  }
}
