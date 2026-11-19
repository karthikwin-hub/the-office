import type { ColumnMapping, Payout, SalesChannel, SalesImport, SalesLine } from "@office/contracts";
import type { OfficeService, PendingSheet, SalesStore } from "@office/engine";

/**
 * Online sales in the office's own SQLite, apart from the books. Lines are rows so a month of
 * marketplace orders never has to be loaded whole; a sheet waiting for its columns is kept in
 * chunks, as one value may not exceed the storage's limit.
 */
type LineRow = { id: string; import_id: string; channel: string; date: string; order_no: string; invoice: string | null; seller_sku: string | null; sku_id: string | null; item: string | null; qty: number; gross: number; taxable: number | null; tax: number | null; discount: number | null; state: string | null; city: string | null; status: string; row_no: number };
const CHUNK = 900_000;

const toLine = (r: LineRow): SalesLine => ({
  id: r.id,
  importId: r.import_id,
  channel: r.channel as SalesChannel,
  date: r.date,
  order: r.order_no,
  invoice: r.invoice,
  sellerSku: r.seller_sku,
  skuId: r.sku_id,
  item: r.item,
  qty: Number(r.qty),
  grossPaise: Number(r.gross),
  taxablePaise: r.taxable === null ? null : Number(r.taxable),
  taxPaise: r.tax === null ? null : Number(r.tax),
  discountPaise: r.discount === null ? null : Number(r.discount),
  state: r.state,
  city: r.city,
  status: r.status as SalesLine["status"],
  row: Number(r.row_no),
});

export class SqlSalesStore implements SalesStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sales_line (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, channel TEXT NOT NULL, date TEXT NOT NULL, order_no TEXT NOT NULL, invoice TEXT, seller_sku TEXT, sku_id TEXT, item TEXT, qty REAL NOT NULL, gross INTEGER NOT NULL, taxable INTEGER, tax INTEGER, discount INTEGER, state TEXT, city TEXT, status TEXT NOT NULL, row_no INTEGER NOT NULL)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS sales_line_date ON sales_line (date)");
    sql.exec("CREATE INDEX IF NOT EXISTS sales_line_import ON sales_line (import_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS sales_import (id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, doc TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sales_payout (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, to_date TEXT, doc TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sales_pending (import_id TEXT NOT NULL, n INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (import_id, n))");
    sql.exec("CREATE TABLE IF NOT EXISTS sales_mapping (k TEXT PRIMARY KEY, doc TEXT NOT NULL)");
  }
  saveImport(i: SalesImport) {
    this.sql.exec("INSERT INTO sales_import (id, hash, status, received_at, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, status = excluded.status, doc = excluded.doc", i.id, i.hash, i.status, i.receivedAt, JSON.stringify(i));
  }
  importById(id: string) {
    const r = this.sql.exec<{ doc: string }>("SELECT doc FROM sales_import WHERE id = ?", id).toArray()[0];
    return r ? (JSON.parse(r.doc) as SalesImport) : null;
  }
  importByHash(hash: string) {
    const r = this.sql.exec<{ doc: string }>("SELECT doc FROM sales_import WHERE hash = ? AND status NOT IN ('duplicate', 'dropped') LIMIT 1", hash).toArray()[0];
    return r ? (JSON.parse(r.doc) as SalesImport) : null;
  }
  imports(limit: number) {
    return this.sql.exec<{ doc: string }>("SELECT doc FROM sales_import ORDER BY received_at DESC LIMIT ?", limit).toArray().map((r) => JSON.parse(r.doc) as SalesImport);
  }
  removeImport(id: string) {
    this.sql.exec("DELETE FROM sales_line WHERE import_id = ?", id);
    this.sql.exec("DELETE FROM sales_payout WHERE import_id = ?", id);
    this.sql.exec("DELETE FROM sales_pending WHERE import_id = ?", id);
    this.sql.exec("DELETE FROM sales_import WHERE id = ?", id);
  }
  addLines(lines: SalesLine[]) {
    let added = 0;
    for (const l of lines) {
      if (this.sql.exec("SELECT 1 FROM sales_line WHERE id = ?", l.id).toArray().length) continue;
      this.sql.exec(
        "INSERT INTO sales_line (id, import_id, channel, date, order_no, invoice, seller_sku, sku_id, item, qty, gross, taxable, tax, discount, state, city, status, row_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        l.id,
        l.importId,
        l.channel,
        l.date,
        l.order,
        l.invoice,
        l.sellerSku,
        l.skuId,
        l.item,
        l.qty,
        l.grossPaise,
        l.taxablePaise,
        l.taxPaise,
        l.discountPaise,
        l.state,
        l.city,
        l.status,
        l.row,
      );
      added++;
    }
    return added;
  }
  lines(from: string, to: string) {
    return this.sql.exec<LineRow>("SELECT * FROM sales_line WHERE date >= ? AND date <= ?", from, to).toArray().map(toLine);
  }
  lastDate() {
    return this.sql.exec<{ d: string | null }>("SELECT MAX(date) AS d FROM sales_line").toArray()[0]?.d ?? null;
  }
  savePayout(p: Payout) {
    this.sql.exec("INSERT INTO sales_payout (id, import_id, to_date, doc) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc", p.id, p.importId, p.to, JSON.stringify(p));
  }
  payouts(limit: number) {
    return this.sql.exec<{ doc: string }>("SELECT doc FROM sales_payout ORDER BY to_date DESC LIMIT ?", limit).toArray().map((r) => JSON.parse(r.doc) as Payout);
  }
  pending(importId: string) {
    const parts = this.sql.exec<{ part: string }>("SELECT part FROM sales_pending WHERE import_id = ? ORDER BY n", importId).toArray();
    return parts.length ? (JSON.parse(parts.map((p) => p.part).join("")) as PendingSheet) : null;
  }
  setPending(importId: string, sheet: PendingSheet | null) {
    this.sql.exec("DELETE FROM sales_pending WHERE import_id = ?", importId);
    if (!sheet) return;
    const text = JSON.stringify(sheet);
    for (let n = 0; n * CHUNK < text.length; n++) this.sql.exec("INSERT INTO sales_pending (import_id, n, part) VALUES (?, ?, ?)", importId, n, text.slice(n * CHUNK, (n + 1) * CHUNK));
  }
  mapping(key: string) {
    const r = this.sql.exec<{ doc: string }>("SELECT doc FROM sales_mapping WHERE k = ?", key).toArray()[0];
    return r ? (JSON.parse(r.doc) as { channel: SalesChannel; mapping: ColumnMapping }) : null;
  }
  saveMapping(key: string, m: { channel: SalesChannel; mapping: ColumnMapping }) {
    this.sql.exec("INSERT INTO sales_mapping (k, doc) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET doc = excluded.doc", key, JSON.stringify(m));
  }
}

/** The platforms whose mail is taken at the sales address, besides the office's own people. */
const PLATFORM_DOMAINS = /(^|\.)(amazon\.(in|com)|flipkart\.com|meesho\.com|myntra\.com|blinkit\.com|grofers\.com|zeptonow\.com|zepto\.co\.in|swiggy\.(in|com)|bigbasket\.com|jiomart\.com|ril\.com)$/i;
export const fromPlatform = (address: string | null) => Boolean(address && PLATFORM_DOMAINS.test(address.split("@")[1] ?? ""));

/** A spreadsheet, CSV, text export or zip that might be a sales report. */
export const isSheetFile = (filename: string | null | undefined, mimeType: string) =>
  /\.(csv|tsv|txt|xlsx|xlsm|xls|zip)$/i.test(filename ?? "") || /^(text\/(csv|plain|tab-separated-values)|application\/(zip|x-zip-compressed|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet))$/i.test(mimeType);

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads one file into the Marketplace Manager. A file that cannot be opened is recorded with why. */
export async function readSalesFile(office: OfficeService, f: { name: string; bytes: ArrayBuffer; via: SalesImport["via"]; sender: string | null }): Promise<SalesImport[]> {
  const hash = await sha256(f.bytes);
  const { readSheets, SheetError } = await import("@office/engine/sheets");
  try {
    const sheets = await readSheets(f.name, f.bytes);
    return office.sales.receive({ file: f.name, sheets, hash, via: f.via, sender: f.sender });
  } catch (e) {
    const note = e instanceof SheetError ? e.message : "The file could not be opened. Send it as CSV or XLSX.";
    const imp: SalesImport = { id: `simp-${crypto.randomUUID().slice(0, 12)}`, channel: "other", format: "unknown", formatName: "Not readable", file: f.name.slice(0, 200), via: f.via, sender: f.sender, receivedAt: new Date().toISOString(), hash, status: "unreadable", rows: 0, lines: 0, repeated: 0, skipped: [], period: null, grossPaise: 0, note };
    office.sales.store.saveImport(imp);
    return [imp];
  }
}

/** One line back to whoever sent the file, on WhatsApp or in the upload's answer. */
export function salesReply(imports: SalesImport[]): string {
  return imports
    .map((i) =>
      i.status === "read"
        ? `Read ${i.formatName}: ${i.note}`
        : i.status === "payout"
          ? `Read ${i.formatName}: ${i.note}`
          : i.status === "needs_mapping"
            ? `${i.file} is in a layout I have not seen. Confirm its columns once on your desk and it is read.`
            : i.status === "duplicate"
              ? `${i.file}: ${i.note}`
              : `${i.file}: ${i.note}`,
    )
    .join("\n");
}
