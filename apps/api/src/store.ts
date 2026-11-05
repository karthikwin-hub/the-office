import { Books } from "@office/contracts";
import { z } from "zod";

type Sql = SqlStorage;

/**
 * The books live in the Office agent's own SQLite, one row per record, so a
 * write after a request only touches what changed. Collections without ids
 * (the business, the state codes) are kept whole under the id "_".
 */
export class BooksStore {
  private written = new Map<string, string>();

  constructor(private readonly sql: Sql) {
    sql.exec("CREATE TABLE IF NOT EXISTS book_rows (coll TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (coll, id))");
  }

  load(): Books | null {
    const rows = this.sql.exec<{ coll: string; id: string; json: string }>("SELECT coll, id, json FROM book_rows ORDER BY coll, ord").toArray();
    if (!rows.length) return null;
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      this.written.set(`${r.coll}\u0000${r.id}`, r.json);
      if (r.id === "_") raw[r.coll] = JSON.parse(r.json);
      else ((raw[r.coll] ??= []) as unknown[]).push(JSON.parse(r.json));
    }
    for (const [k, v] of Object.entries(Books.shape)) if (raw[k] === undefined && (v as z.ZodTypeAny)._def.typeName === z.ZodFirstPartyTypeKind.ZodArray) raw[k] = [];
    return Books.parse(raw);
  }

  /** Writes the records that differ from what is stored and removes the ones that are gone. Returns how many rows changed. */
  save(books: Books): number {
    const seen = new Set<string>();
    let changed = 0;
    for (const [coll, value] of Object.entries(books)) {
      const ids = Array.isArray(value) ? value.map((v) => (v && typeof v === "object" && "id" in v ? String(v.id) : null)) : [];
      const byId = Array.isArray(value) && ids.every((i) => i !== null && i !== "_") && new Set(ids).size === ids.length;
      const entries: [string, unknown][] = byId ? value.map((v, n) => [ids[n]!, v]) : [["_", value]];
      entries.forEach(([id, v], ord) => {
        const key = `${coll}\u0000${id}`;
        seen.add(key);
        const json = JSON.stringify(v);
        if (this.written.get(key) === json) return;
        this.sql.exec("INSERT INTO book_rows (coll, id, ord, json) VALUES (?, ?, ?, ?) ON CONFLICT (coll, id) DO UPDATE SET ord = excluded.ord, json = excluded.json", coll, id, ord, json);
        this.written.set(key, json);
        changed++;
      });
    }
    for (const key of [...this.written.keys()]) {
      if (seen.has(key)) continue;
      const [coll, id] = key.split("\u0000") as [string, string];
      this.sql.exec("DELETE FROM book_rows WHERE coll = ? AND id = ?", coll, id);
      this.written.delete(key);
      changed++;
    }
    return changed;
  }
}
