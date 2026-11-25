import { type Channel, type OwnerPost, platformOf } from "@office/contracts";
import { parseCsv } from "../imports";

/** One row of an owner's posting sheet, before its pictures are uploaded. */
export type SheetRow = { row: number; at: string | null; channelIds: string[]; text: string; files: string[] };

export const SHEET_TEMPLATE = `date,time,channels,caption,files
2026-12-01,11:00,Instagram; Facebook,"New ceiling fans are in. Come and see them at the counter.",fan-white.jpg
2026-12-03,,Facebook,"Switch off at the mains before you change a fitting.",
`;

const COLUMNS = {
  date: ["date", "day"],
  time: ["time"],
  channels: ["channels", "channel", "where"],
  caption: ["caption", "text", "post"],
  files: ["files", "file", "pictures", "media"],
};

/** 2026-12-01, 01/12/2026 or 1-12-2026 (day first, as written in India). */
function dateOf(s: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  return dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}` : null;
}

/**
 * Reads a sheet of posts: a date, an optional time, the channels by name, the caption and the picture or video
 * file names. Every problem is named by its row; a row with no date takes the channels' next free day.
 */
export function readPostSheet(text: string, channels: Channel[]): { rows: SheetRow[]; errors: string[] } {
  const [head, ...body] = parseCsv(text);
  const errors: string[] = [];
  if (!head) return { rows: [], errors: ["The sheet is empty."] };
  const names = head.map((h) => h.toLowerCase().trim());
  const col = (k: keyof typeof COLUMNS) => names.findIndex((n) => COLUMNS[k].includes(n));
  const at = { date: col("date"), time: col("time"), channels: col("channels"), caption: col("caption"), files: col("files") };
  if (at.caption < 0 || at.channels < 0)
    return { rows: [], errors: ["The sheet needs a caption column and a channels column; download the template to start."] };
  const rows: SheetRow[] = [];
  body.forEach((cells, i) => {
    const n = i + 2;
    const cell = (k: keyof typeof at) => (at[k] >= 0 ? (cells[at[k]] ?? "").trim() : "");
    const caption = cell("caption");
    if (!caption) return errors.push(`Row ${n}: the caption is empty.`);
    const ids: string[] = [];
    for (const name of cell("channels")
      .split(/[;,|]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const ch = channels.find((c) => c.platform === platformOf(name));
      if (!ch || (platformOf(name) === "google" && !/google/i.test(name))) return errors.push(`Row ${n}: no channel called "${name}".`);
      ids.push(ch.id);
    }
    if (!ids.length) return errors.push(`Row ${n}: name at least one channel.`);
    let when: string | null = null;
    if (cell("date")) {
      const d = dateOf(cell("date"));
      const t = cell("time") || "11:00";
      if (!d || !/^\d{1,2}:\d{2}$/.test(t)) return errors.push(`Row ${n}: write the date as 2026-12-01 and the time as 11:00.`);
      when = `${d}T${t.padStart(5, "0")}:00+05:30`;
    }
    rows.push({
      row: n,
      at: when,
      channelIds: [...new Set(ids)],
      text: caption,
      files: cell("files")
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  });
  if (!rows.length && !errors.length) errors.push("The sheet has no posts.");
  return { rows, errors };
}

/** The rows as posts, once each file name has an uploaded picture or video. */
export function sheetPosts(rows: SheetRow[], mediaByName: Map<string, string>): OwnerPost[] {
  return rows.map((r) => ({
    text: r.text,
    channelIds: r.channelIds,
    versions: [],
    mediaIds: r.files.map((f) => {
      const id = mediaByName.get(f.toLowerCase());
      if (!id) throw new Error(`Row ${r.row}: attach ${f} with the sheet.`);
      return id;
    }),
    link: null,
    skuIds: [],
    at: r.at,
  }));
}
