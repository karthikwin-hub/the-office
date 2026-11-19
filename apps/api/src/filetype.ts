/**
 * The content type a received file is stored under. A sender's own type is never kept: it is
 * chosen from a fixed list by the file's extension and its first bytes, and a file that fits
 * none of them is not stored at all.
 */
export const SHEET_TYPES = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  text: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  zip: "application/zip",
} as const;
export const BILL_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
export type BillType = (typeof BILL_TYPES)[number];

const head = (bytes: ArrayBuffer | Uint8Array, n: number) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).subarray(0, n);
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
const isOle = (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isPdf = (b: Uint8Array) => {
  const sig = ascii("%PDF-");
  for (let i = 0; i + sig.length <= b.length; i++) if (startsWith(b, sig, i)) return true;
  return false;
};
const imageOf = (b: Uint8Array): BillType | null =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? "image/png" : startsWith(b, [0xff, 0xd8, 0xff]) ? "image/jpeg" : startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) ? "image/webp" : null;

/** Plain text: no NUL bytes, or UTF-16 (with a byte-order mark, or NULs on one side of every pair, as some portals save it). */
function isText(b: Uint8Array): boolean {
  if (isZip(b) || isOle(b) || isPdf(b)) return false;
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return true;
  let even = 0;
  let odd = 0;
  b.forEach((x, i) => {
    if (x === 0) i % 2 ? odd++ : even++;
  });
  if (!even && !odd) return true;
  return (!even || !odd) && Math.max(even, odd) >= b.length / 4;
}

/** A spreadsheet, CSV, text export or zip, under a type from `SHEET_TYPES`, or null when the bytes are not what the name says. */
export function sheetType(filename: string | null | undefined, bytes: ArrayBuffer | Uint8Array): string | null {
  const b = head(bytes, 4096);
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? "")?.[1]?.toLowerCase();
  if (ext === "xlsx") return isZip(b) ? SHEET_TYPES.xlsx : null;
  if (ext === "xlsm") return isZip(b) ? SHEET_TYPES.xlsm : null;
  if (ext === "zip") return isZip(b) ? SHEET_TYPES.zip : null;
  if (ext === "csv") return isText(b) ? SHEET_TYPES.csv : null;
  if (ext === "tsv") return isText(b) ? SHEET_TYPES.tsv : null;
  if (ext === "txt") return isText(b) ? SHEET_TYPES.text : null;
  // Portals save HTML or text tables as .xls; they are stored as text.
  if (ext === "xls") return isOle(b) ? SHEET_TYPES.xls : isZip(b) ? SHEET_TYPES.xlsx : isText(b) ? SHEET_TYPES.text : null;
  return isZip(b) ? SHEET_TYPES.zip : isOle(b) ? SHEET_TYPES.xls : isText(b) ? SHEET_TYPES.text : null;
}

/**
 * A bill as a PDF or a picture: a PDF when the sender or the name says so and the bytes agree;
 * a PNG, JPEG or WebP picture by its bytes when the sender says it is one. Anything else is null.
 */
export function billType(filename: string | null | undefined, declared: string, bytes: ArrayBuffer | Uint8Array): BillType | null {
  const b = head(bytes, 1024);
  if (declared === "application/pdf" || /\.pdf$/i.test(filename ?? "")) return isPdf(b) ? "application/pdf" : null;
  if (/^image\/(png|jpe?g|webp)$/i.test(declared)) return imageOf(b);
  return null;
}

/** A voice note's type, from the few WhatsApp sends; anything else is stored as plain bytes. */
export const audioType = (declared: string) => (/^audio\/(ogg|mpeg|mp4|aac|amr)$/i.test(declared) ? declared.toLowerCase() : "application/octet-stream");
