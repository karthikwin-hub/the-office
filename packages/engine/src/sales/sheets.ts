import type { Sheet } from "./parse";
import { parseDelimited } from "./parse";

/**
 * Turns a report file into sheets of text: CSV, tab-separated text, XLSX, or a ZIP of any of them
 * (Amazon sends its reports zipped). Loaded only when a file arrives, since the spreadsheet reader is large.
 */
const MAX_ROWS = 100_000;
const MAX_ZIP_ENTRIES = 20;
const MAX_UNZIPPED = 60 * 1024 * 1024;

export class SheetError extends Error {}

const kindOf = (name: string, bytes: Uint8Array): "zip" | "xlsx" | "xls" | "text" => {
  const lower = name.toLowerCase();
  const zipMagic = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith(".xls") && !zipMagic) return "xls";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (zipMagic) return lower.endsWith(".zip") ? "zip" : "xlsx";
  return "text";
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string; error?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return cellText(o.text);
    if (o.error) return "";
  }
  return String(v).trim();
}

async function xlsxSheets(bytes: Uint8Array): Promise<Sheet[]> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const out: Sheet[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const values = (row.values as unknown[]).slice(1).map(cellText);
      if (values.some((c) => c)) rows.push(values);
    });
    out.push({ name: ws.name, rows });
  });
  return out;
}

export async function readSheets(name: string, data: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const kind = kindOf(name, bytes);
  if (kind === "xls") throw new SheetError("This is an old Excel file (.xls). Open it and save it as .xlsx or .csv, then send it again.");
  if (kind === "xlsx") {
    try {
      return await xlsxSheets(bytes);
    } catch {
      throw new SheetError("The spreadsheet could not be opened. Save it as .xlsx or .csv and send it again.");
    }
  }
  if (kind === "zip") {
    const JSZip = (await import("jszip")).default;
    const z = await JSZip.loadAsync(bytes);
    const entries = Object.values(z.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name)).slice(0, MAX_ZIP_ENTRIES);
    const out: Sheet[] = [];
    let total = 0;
    for (const e of entries) {
      const inner = await e.async("uint8array");
      total += inner.byteLength;
      if (total > MAX_UNZIPPED) throw new SheetError("The zip file holds more than the office reads at once. Send the reports one at a time.");
      if (!/\.(csv|txt|tsv|xlsx|xlsm)$/i.test(e.name)) continue;
      for (const s of await readSheets(e.name, inner)) out.push({ ...s, name: entries.length > 1 ? `${e.name.split("/").pop()}${s.name && s.name !== e.name ? `: ${s.name}` : ""}` : s.name });
    }
    return out;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (/\u0000/.test(text.slice(0, 2000))) {
    // UTF-16, as some portals save "Unicode text".
    const t16 = new TextDecoder(bytes[0] === 0xfe ? "utf-16be" : "utf-16le").decode(bytes);
    return [{ name, rows: parseDelimited(t16).slice(0, MAX_ROWS) }];
  }
  return [{ name, rows: parseDelimited(text).slice(0, MAX_ROWS) }];
}
