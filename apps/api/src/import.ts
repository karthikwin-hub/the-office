import type { Env } from "./env";
import type { OfficeFiles } from "./files";
import { billType } from "./filetype";
import { officePrefix } from "./keys";
import { ZIP_TAIL_BYTES, type ZipEntry, zipDirectory, zipEntries, zipEntryData } from "./zip";

/**
 * Loading an owner's export (export.ts) into a new, empty office: on staging only, to test with a copy of a real
 * business. Live never offers it: the Worker and the office both answer 404 unless OFFICE_IMPORT is "on", and only
 * `env.staging` in wrangler.jsonc sets it (a test checks live does not).
 *
 * On the free plan the Worker only pipes the upload through. The office keeps the archive in R2 under its own prefix,
 * reads the books from it, then copies its files in batches, one request each (`next`), because a request may make
 * only so many calls to R2. Each file is checked against its CRC-32 and stored with the office's own key.
 */

export const importAllowed = (env: Pick<Env, "OFFICE_IMPORT">) => env.OFFICE_IMPORT === "on";

/** Under the free plan's 100 MB request body, with room for the request around it. */
export const ARCHIVE_MAX_BYTES = 95 * 1024 * 1024;
/** Files copied in one request: a read and a write to R2 each. */
export const IMPORT_PART_FILES = 200;

/** Where the upload waits while its files are copied; removed when the import is done. */
export const importKey = (officeId: string) => `${officePrefix(officeId)}import/archive.zip`;

/** What an export's books.json holds (`exportBooks` in office-agent.ts). */
export type ExportedBooks = { office?: unknown; books?: unknown; settings?: unknown };

/** A file the export holds, by its place under the office's prefix: only stored documents and pictures are taken. */
const FILE_ENTRY = /^files\/((?:docs|media)\/[\w.-]{1,200})$/;

export type ImportProgress = { done: number; total: number; skipped: number; finished: boolean };

/** A file's type, from its bytes: a PDF, a picture, a reading's text, or plain bytes. The export does not keep it. */
export function storedType(place: string, bytes: Uint8Array): string {
  return (
    billType(null, "application/pdf", bytes) ??
    billType(null, "image/png", bytes) ??
    (place.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}

/** Rewrites the books' links to files (`/api/o/<old office>/...`) for the office they now belong to. */
export function moveLinks(json: string, from: string, to: string): string {
  return json.split(`/api/o/${from}/`).join(`/api/o/${to}/`);
}

export class OfficeImport {
  constructor(
    private readonly docs: R2Bucket,
    private readonly files: Pick<OfficeFiles, "put" | "officeId">,
  ) {}

  private get key() {
    return importKey(this.files.officeId);
  }

  /** The archive's file list, read again from R2 each time: two small reads, and nothing to keep between requests. */
  private async entries(): Promise<ZipEntry[] | null> {
    const head = await this.docs.head(this.key);
    if (!head) return null;
    const tailBytes = Math.min(head.size, ZIP_TAIL_BYTES);
    const tail = await this.docs.get(this.key, { range: { offset: head.size - tailBytes, length: tailBytes } });
    if (!tail) return null;
    const dir = zipDirectory(new Uint8Array(await tail.arrayBuffer()), head.size);
    if (!dir) return null;
    const cd = await this.docs.get(this.key, { range: { offset: dir.offset, length: dir.size } });
    return cd ? zipEntries(new Uint8Array(await cd.arrayBuffer()), dir.count) : null;
  }

  private async read(e: ZipEntry, total: number): Promise<Uint8Array | null> {
    // The local header repeats the name and may add an extra field; read enough for both, never past the end.
    const length = Math.min(30 + 4 * e.name.length + 1024 + e.size, total - e.offset);
    const got = await this.docs.get(this.key, { range: { offset: e.offset, length } });
    return got ? zipEntryData(e, new Uint8Array(await got.arrayBuffer())) : null;
  }

  /** Keeps the upload and returns its books.json, parsed; an error message for anything that is not an export. */
  async start(body: ReadableStream<Uint8Array>, length: number): Promise<{ exported: ExportedBooks; files: number } | { error: string }> {
    // R2 stores a stream only when it knows its length: workerd's FixedLengthStream says it, and fails a body that differs.
    const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    let stream = body;
    if (Fixed) {
      const fixed = new Fixed(length);
      body.pipeTo(fixed.writable).catch(() => undefined);
      stream = fixed.readable;
    }
    await this.docs.put(this.key, stream, { httpMetadata: { contentType: "application/zip" } });
    const entries = await this.entries();
    const head = await this.docs.head(this.key);
    if (!entries || !head || head.size !== length) return this.fail("That file is not an export from this app. Download it again from Settings → Office.");
    const books = entries.find((e) => e.name === "books.json");
    const data = books ? await this.read(books, head.size) : null;
    if (!data) return this.fail("The export has no readable books in it. Download it again from Settings → Office.");
    let exported: ExportedBooks;
    try {
      exported = JSON.parse(new TextDecoder().decode(data)) as ExportedBooks;
    } catch {
      return this.fail("The export's books could not be read. Download it again from Settings → Office.");
    }
    return { exported, files: entries.filter((e) => FILE_ENTRY.test(e.name)).length };
  }

  /** Copies the next batch of files, from `done` on; removes the upload after the last. */
  async next(done: number, skipped: number): Promise<ImportProgress | null> {
    const head = await this.docs.head(this.key);
    const entries = head ? await this.entries() : null;
    if (!head || !entries) return null;
    const files = entries.filter((e) => FILE_ENTRY.test(e.name));
    const prefix = officePrefix(this.files.officeId);
    for (const e of files.slice(done, done + IMPORT_PART_FILES)) {
      const data = await this.read(e, head.size);
      // The place comes from the archive, but only as a pattern-checked name under this office's own prefix.
      const place = FILE_ENTRY.exec(e.name)![1]!;
      if (data) await this.files.put(`${prefix}${place}`, data, storedType(place, data));
      else skipped++;
      done++;
    }
    const finished = done >= files.length;
    if (finished) await this.docs.delete(this.key);
    return { done, total: files.length, skipped, finished };
  }

  /** Drops the upload: the import did not go ahead. */
  async cancel() {
    await this.docs.delete(this.key);
  }

  private async fail(error: string) {
    await this.cancel();
    return { error };
  }
}
