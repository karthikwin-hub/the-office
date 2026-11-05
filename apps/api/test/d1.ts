import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

const value = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.getTime() : (v as SQLInputValue));

/** Enough of D1 over Node's SQLite for the control plane and Better Auth, with the real migrations applied. */
export function d1(opts: { migrate?: boolean } = {}): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const statement = (query: string, params: unknown[] = []) => {
    const run = () => {
      const r = db.prepare(query).run(...params.map(value));
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
    };
    const all = () => ({ success: true, results: db.prepare(query).all(...params.map(value)), meta: { changes: 0, duration: 0 } });
    const s = {
      bind: (...p: unknown[]) => statement(query, p),
      first: async (col?: string) => {
        const row = db.prepare(query).get(...params.map(value)) as Record<string, unknown> | undefined;
        return row === undefined ? null : col ? (row[col] ?? null) : row;
      },
      all: async () => all(),
      run: async () => (/^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query) ? all() : run()),
      raw: async () => (db.prepare(query).all(...params.map(value)) as Record<string, unknown>[]).map((r) => Object.values(r)),
      _run: () => (/^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query) ? all() : run()),
    };
    return s;
  };
  const api = {
    sqlite: db,
    prepare: (query: string) => statement(query),
    batch: async (stmts: ReturnType<typeof statement>[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (query: string) => {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  };
  if (opts.migrate !== false) for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  return api as unknown as D1Database & { sqlite: DatabaseSync };
}

/** A person straight into the user table, for tests that do not need to sign in. */
export function addUser(db: D1Database & { sqlite: DatabaseSync }, u: { id: string; name: string; email: string; verified?: boolean }) {
  const at = Date.now();
  db.sqlite.prepare("INSERT INTO `user` (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(u.id, u.name, u.email, u.verified === false ? 0 : 1, at, at);
  return { id: u.id, name: u.name, email: u.email, emailVerified: u.verified !== false };
}
