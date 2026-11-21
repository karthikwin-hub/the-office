import { type Document, SheetLayout, type SheetKind } from "@office/contracts";
import type { LayoutStore, OfficeService, WaitingSheet, SheetResult } from "@office/engine";
import { proposeLayout } from "./reading";

/**
 * Registers of bills or invoices in the office's own SQLite: the layouts the owner confirmed, by their header row,
 * and a register waiting for its columns, in chunks as one value may not exceed the storage's limit.
 */
const CHUNK = 900_000;

export class SqlLayoutStore implements LayoutStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS sheet_layout (k TEXT PRIMARY KEY, doc TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sheet_pending (import_id TEXT NOT NULL, n INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (import_id, n))");
  }
  layout(key: string) {
    const r = this.sql.exec<{ doc: string }>("SELECT doc FROM sheet_layout WHERE k = ?", key).toArray()[0];
    return r ? SheetLayout.parse(JSON.parse(r.doc)) : null;
  }
  saveLayout(key: string, l: SheetLayout) {
    this.sql.exec("INSERT INTO sheet_layout (k, doc) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET doc = excluded.doc", key, JSON.stringify(l));
  }
  pending(id: string) {
    const parts = this.sql.exec<{ part: string }>("SELECT part FROM sheet_pending WHERE import_id = ? ORDER BY n", id).toArray();
    return parts.length ? (JSON.parse(parts.map((p) => p.part).join("")) as WaitingSheet) : null;
  }
  setPending(id: string, p: WaitingSheet | null) {
    this.sql.exec("DELETE FROM sheet_pending WHERE import_id = ?", id);
    if (!p) return;
    const text = JSON.stringify(p);
    for (let n = 0; n * CHUNK < text.length; n++)
      this.sql.exec("INSERT INTO sheet_pending (import_id, n, part) VALUES (?, ?, ?)", id, n, text.slice(n * CHUNK, (n + 1) * CHUNK));
  }
}

/**
 * Reads a stored spreadsheet as one of `kinds` (ADR 0010). For a new layout whose header names leave a field unfound,
 * the text model suggests the column first; the owner confirms on the card either way.
 */
export async function readSheetFile(
  office: OfficeService,
  ai: Ai,
  f: {
    docId: string;
    name: string;
    bytes: ArrayBuffer;
    fileUrl: string;
    via: Document["channel"];
    from: string | null;
    auto: boolean;
    kinds: SheetKind[];
  },
): Promise<SheetResult[]> {
  const { readSheets, SheetError } = await import("@office/engine/sheets");
  let sheets: Awaited<ReturnType<typeof readSheets>>;
  try {
    sheets = await readSheets(f.name, f.bytes);
  } catch (e) {
    const message = e instanceof SheetError ? e.message : "The file could not be opened. Send it as XLSX or CSV.";
    return [{ sheet: f.name.slice(0, 200), sheetKind: null, status: "not_recognised", staged: 0, posted: 0, duplicates: 0, skipped: [], message }];
  }
  const proposed: Awaited<ReturnType<typeof proposeLayout>>[] = [];
  for (const u of office.intake.unclear(sheets, f.kinds)) proposed[u.index] = await proposeLayout(ai, u, office.books.business);
  return office.intake.receive({
    id: `reg-${f.docId.replace(/^doc-/, "")}`,
    file: f.name,
    fileUrl: f.fileUrl,
    sheets,
    via: f.via,
    from: f.from,
    auto: f.auto,
    kinds: f.kinds,
    proposed,
  });
}
