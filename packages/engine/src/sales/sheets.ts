import type { Sheet } from "./parse";
import { parseDelimited } from "./parse";

/**
 * Turns a report file into sheets of text: CSV, tab-separated text, XLSX, or a ZIP of any of them
 * (Amazon sends its reports zipped). Loaded only when a file arrives, since the spreadsheet reader is large.
 */
const MAX_ROWS = 100_000;
const MAX_ZIP_ENTRIES = 20;
const MAX_UNZIPPED = 60 * 1024 * 1024;
/** A spreadsheet has a few dozen parts; thousands means it is not one. */
const MAX_XLSX_ENTRIES = 1000;
const ZIP_TOO_BIG = "The zip file holds more than the office reads at once. Send the reports one at a time.";
const XLSX_TOO_BIG = "The spreadsheet holds more than the office reads at once. Send the reports one at a time.";

export class SheetError extends Error {}

type ZipEntry = import("jszip").JSZipObject;
/** JSZip's own chunked reader, which the typings leave out; `async` would hold the whole entry before anyone could count it. */
type ChunkStream = { on(evt: "data", fn: (chunk: Uint8Array) => void): ChunkStream; on(evt: "end", fn: () => void): ChunkStream; on(evt: "error", fn: (e: unknown) => void): ChunkStream; resume(): ChunkStream; pause(): ChunkStream };

/** The size an entry says it unzips to, from the zip's directory. It can lie, so `inflate` counts as well. */
const declaredSize = (e: ZipEntry) => {
  const n = (e as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof n === "number" && n >= 0 ? n : 0;
};

/** Refuses before unzipping anything when the directory alone says the entries are too big together. */
function checkDeclared(entries: ZipEntry[], tooBig: string) {
  let total = 0;
  for (const e of entries) {
    total += declaredSize(e);
    if (total > MAX_UNZIPPED) throw new SheetError(tooBig);
  }
}

/**
 * Unzips one entry a chunk at a time and stops the moment it passes `cap` bytes, whatever the entry claims.
 * With `keep` false nothing is held: it only counts.
 */
function inflate(e: ZipEntry, cap: number, tooBig: string, keep = true): Promise<{ bytes: Uint8Array; size: number }> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let size = 0;
    let done = false;
    const s = (e as unknown as { internalStream(type: "uint8array"): ChunkStream }).internalStream("uint8array");
    s.on("data", (chunk) => {
      if (done) return;
      size += chunk.byteLength;
      if (size > cap) {
        done = true;
        s.pause();
        reject(new SheetError(tooBig));
        return;
      }
      if (keep) parts.push(chunk);
    })
      .on("error", (err) => {
        if (done) return;
        done = true;
        reject(err);
      })
      .on("end", () => {
        if (done) return;
        done = true;
        const bytes = new Uint8Array(keep ? size : 0);
        let at = 0;
        for (const p of parts) {
          bytes.set(p, at);
          at += p.byteLength;
        }
        resolve({ bytes, size });
      })
      .resume();
  });
}

/** An XLSX is a zip: its parts are measured, declared and then real, before the workbook reader unzips it all. */
async function checkXlsxSize(bytes: Uint8Array) {
  const JSZip = (await import("jszip")).default;
  const z = await JSZip.loadAsync(bytes);
  const entries = Object.values(z.files).filter((f) => !f.dir);
  if (entries.length > MAX_XLSX_ENTRIES) throw new SheetError(XLSX_TOO_BIG);
  checkDeclared(entries, XLSX_TOO_BIG);
  let total = 0;
  for (const e of entries) total += (await inflate(e, MAX_UNZIPPED - total, XLSX_TOO_BIG, false)).size;
}

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
  await checkXlsxSize(bytes);
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
    } catch (e) {
      if (e instanceof SheetError) throw e;
      throw new SheetError("The spreadsheet could not be opened. Save it as .xlsx or .csv and send it again.");
    }
  }
  if (kind === "zip") {
    const JSZip = (await import("jszip")).default;
    const z = await JSZip.loadAsync(bytes);
    const entries = Object.values(z.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name)).slice(0, MAX_ZIP_ENTRIES);
    const reports = entries.filter((e) => /\.(csv|txt|tsv|xlsx|xlsm)$/i.test(e.name));
    checkDeclared(reports, ZIP_TOO_BIG);
    const out: Sheet[] = [];
    let total = 0;
    for (const e of reports) {
      const { bytes: inner } = await inflate(e, MAX_UNZIPPED - total, ZIP_TOO_BIG);
      total += inner.byteLength;
      for (const s of await readSheets(e.name, inner)) out.push({ ...s, name: entries.length > 1 ? `${e.name.split("/").pop()}${s.name && s.name !== e.name ? `: ${s.name}` : ""}` : s.name });
    }
    return out;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a NUL byte means the file is binary, not text.
  if (/\u0000/.test(text.slice(0, 2000))) {
    // UTF-16, as some portals save "Unicode text".
    const t16 = new TextDecoder(bytes[0] === 0xfe ? "utf-16be" : "utf-16le").decode(bytes);
    return [{ name, rows: parseDelimited(t16).slice(0, MAX_ROWS) }];
  }
  return [{ name, rows: parseDelimited(text).slice(0, MAX_ROWS) }];
}
