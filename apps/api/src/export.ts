import { officePrefix } from "./keys";
import { streamOf, ZipWriter } from "./zip";

/**
 * An office's export: the books as JSON and every stored file, in one ZIP (`books.json`, then `files/<key>`).
 *
 * On the Workers free plan a Worker request has about 10 ms of CPU and 128 MB of memory, so the Worker does
 * none of the work: the office's Durable Object (30 s of CPU per request) reads the files from R2 and writes the
 * archive as a stream. A Durable Object request may also make only so many calls to R2, so the archive comes
 * in parts of EXPORT_PART_FILES files, each its own request; the Worker joins the parts into one download
 * without reading a byte of them (`exportArchive`).
 */

/** As before: files past this much are left out of the export. */
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Files read from R2 in one request to the office. */
export const EXPORT_PART_FILES = 250;
/**
 * Requests to the office in one export. Kept well under the free plan's 50 subrequests a Worker request, should
 * Durable Object calls count against it, with room for the sign-in, membership and audit queries around them.
 */
export const EXPORT_MAX_PARTS = 30;
/** How long a planned export waits for its parts. */
const EXPORT_TTL_MS = 30 * 60_000;
/** Exports of one office kept at once; an idle older one is dropped for a new one, one being written never is. */
const EXPORT_AT_ONCE = 3;

/** What the office tells the Worker an export holds: books.json and the files (`entries`), in `parts` requests. */
export type ExportPlan = { id: string; parts: number; entries: number };

type Pending = { at: number; prefix: string; books: string; keys: string[]; next: number; busy: boolean; zip: ZipWriter };

/** The office's side: which files go in, and each part of the archive when the Worker asks for it. */
export class OfficeExports {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly docs: R2Bucket) {}

  /** Lists the office's own files (only keys under `o/<officeId>/`) and keeps the books as they are now. */
  async plan(officeId: string, books: unknown): Promise<ExportPlan> {
    const now = Date.now();
    // The books as they are now, before any wait below lets another request change them.
    const snapshot = JSON.stringify(books);
    for (const [id, p] of this.pending) if (now - p.at > EXPORT_TTL_MS) this.pending.delete(id);
    for (const [id, p] of this.pending) if (this.pending.size >= EXPORT_AT_ONCE && !p.busy) this.pending.delete(id);
    if (this.pending.size >= EXPORT_AT_ONCE) throw new Error("Too many exports of this office are being written at once.");
    const prefix = officePrefix(officeId);
    const keys: string[] = [];
    let total = 0;
    let cursor: string | undefined;
    const most = EXPORT_PART_FILES * EXPORT_MAX_PARTS;
    listing: do {
      const page = await this.docs.list({ prefix, cursor });
      for (const o of page.objects) {
        if (!o.key.startsWith(prefix)) continue;
        if (keys.length >= most) break listing;
        if (total + o.size > EXPORT_MAX_BYTES) continue; // too big for what is left; smaller files after it still fit
        total += o.size;
        keys.push(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const id = crypto.randomUUID();
    this.pending.set(id, { at: now, prefix, books: snapshot, keys, next: 0, busy: false, zip: new ZipWriter(new Date(now)) });
    return { id, parts: Math.max(1, Math.ceil(keys.length / EXPORT_PART_FILES)), entries: keys.length + 1 };
  }

  /** Part `part` of export `id`, streamed; parts come in order, one at a time. Null for an export it does not know. */
  part(id: string, part: number): Response | null {
    const p = this.pending.get(id);
    if (!p || p.busy || part !== p.next) return null;
    p.busy = true;
    const parts = Math.max(1, Math.ceil(p.keys.length / EXPORT_PART_FILES));
    const last = part === parts - 1;
    const docs = this.docs;
    const pending = this.pending;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      let done = false;
      try {
        if (part === 0) yield* p!.zip.entry("books.json", p!.books);
        for (const key of p!.keys.slice(part * EXPORT_PART_FILES, (part + 1) * EXPORT_PART_FILES)) {
          const obj = await docs.get(key);
          if (!obj) continue; // deleted since the listing
          yield* p!.zip.entry(`files/${key.slice(p!.prefix.length)}`, obj.body);
        }
        if (last) yield p!.zip.finish();
        done = true;
      } finally {
        // A part that did not finish spoils the archive: the export is over.
        if (!done || last) pending.delete(id);
        else {
          p!.next = part + 1;
          p!.busy = false;
        }
      }
    }
    // Cancelled before it began (the download went), the part's generator never ran: the export is over all the same.
    return new Response(streamOf(chunks(), () => pending.delete(id)), { headers: { "content-type": "application/octet-stream" } });
  }
}

type IdentityStream = new () => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/**
 * The Worker's side: one download made of the office's parts in order. Each part's body is piped straight on,
 * which the runtime does without running the Worker's code for each chunk, so the Worker's CPU time is a few
 * requests' worth however big the archive is. `done` settles when the last part is through, or the download failed.
 */
export function exportArchive(plan: ExportPlan, fetchPart: (part: number) => Promise<Response>): { body: ReadableStream<Uint8Array>; done: Promise<void> } {
  // workerd's native identity stream; elsewhere (tests in Node) an ordinary one.
  const Identity = ((globalThis as { IdentityTransformStream?: IdentityStream }).IdentityTransformStream ?? TransformStream) as IdentityStream;
  const { readable, writable } = new Identity();
  const done = (async () => {
    try {
      for (let part = 0; part < plan.parts; part++) {
        const res = await fetchPart(part);
        if (!res.ok || !res.body) throw new Error(`The office could not write part ${part + 1} of the export (${res.status}).`);
        await res.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      console.error(JSON.stringify({ event: "export.failed", error: e instanceof Error ? e.message : String(e) }));
      await writable.abort(e).catch(() => undefined);
    }
  })();
  return { body: readable, done };
}
