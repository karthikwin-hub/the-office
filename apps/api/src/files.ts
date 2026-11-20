import { fileHeaders } from "./edge";
import { open, seal } from "./envelope";
import type { RootKeys } from "./keyring";
import { docKey, mediaKey, officePrefix } from "./keys";
import { log } from "./log";
import { MEDIA_ID } from "./social/media";

/**
 * An office's stored files in R2 (documents, proofs, pictures, emailed attachments), sealed with the office's own key:
 * `envelope.ts` with purpose `files`, a fresh data key per file, and the file's R2 key bound in, so a sealed file opens
 * only where it was stored and only for its office. The file's type, name and sender are sealed with it; R2 holds only
 * the ciphertext and `sealed: OFB1`. R2's own encryption, under Cloudflare's key, is underneath as before.
 *
 * Sealing and opening run in the office's Durable Object (30 s of CPU a request), never in a Worker request (about 10 ms
 * on the free plan): AES-GCM over a 10 MB file takes about 3 ms in workerd, measured on a laptop, which a Worker
 * request could not spare next to its own work. The Worker passes emailed attachments to the office to store, and the
 * office answers file requests.
 *
 * Files stored before this (no `sealed` metadata) are read as they are, until they are sealed in place (open work).
 * Without SOCIAL_TOKEN_KEY files are stored plain, and the office logs that once.
 */
export const SEALED_FILE = "OFB1";

/** Document and proof ids the file route serves (a voice note's transcript is `<id>.txt`). */
export const FILE_ID = /^(doc|proof)-[\w-]+(\.txt)?$/;
/** Emailed attachments are at most 10 MB each (`mail.ts`); this is a backstop on what the Worker may hand the office. */
const MAX_FILE = 25 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What is sealed with a file besides its bytes. */
export type FileMeta = { filename?: string; by?: string; transcriptOf?: string };
const META_KEYS = ["filename", "by", "transcriptOf"] as const;

export type StoredFile = { body: ReadableStream<Uint8Array> | Uint8Array; contentType: string | undefined; meta: FileMeta; sealed: boolean };

const metaOf = (m: Record<string, unknown> | undefined): FileMeta => {
  const out: FileMeta = {};
  for (const k of META_KEYS) if (typeof m?.[k] === "string") out[k] = m[k] as string;
  return out;
};

export class OfficeFiles {
  private toldUnsealed = false;

  constructor(
    private readonly docs: R2Bucket,
    private readonly keys: RootKeys | null,
    readonly officeId: string,
  ) {}

  /** Keys are built by the server (`keys.ts`); this is the last check that one is the office's own. */
  private own(key: string) {
    if (!key.startsWith(officePrefix(this.officeId))) throw new Error("Not this office's file.");
  }

  async put(key: string, data: ArrayBuffer | Uint8Array | string, contentType?: string, meta: FileMeta = {}): Promise<void> {
    this.own(key);
    const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!this.keys) {
      if (!this.toldUnsealed) {
        this.toldUnsealed = true;
        log("warn", "files.unsealed", { officeId: this.officeId, message: "SOCIAL_TOKEN_KEY is not set: files are stored without the office's key" });
      }
      await this.docs.put(key, bytes, { httpMetadata: contentType ? { contentType } : undefined, customMetadata: { ...metaOf(meta) } });
      return;
    }
    // Sealed: `u32 length | JSON {contentType, filename, by, ...} | bytes`.
    const head = enc.encode(JSON.stringify({ ...metaOf(meta), ...(contentType ? { contentType } : {}) }));
    const inner = new Uint8Array(4 + head.byteLength + bytes.byteLength);
    new DataView(inner.buffer).setUint32(0, head.byteLength);
    inner.set(head, 4);
    inner.set(bytes, 4 + head.byteLength);
    const sealed = await seal(this.keys, this.officeId, inner, { purpose: "files", obj: key });
    await this.docs.put(key, sealed, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { sealed: SEALED_FILE } });
  }

  /** The file as stored: a sealed one opened (whole, in memory), an older plain one streamed as it is. Null when there is none. */
  async get(key: string): Promise<StoredFile | null> {
    this.own(key);
    const obj = await this.docs.get(key);
    if (!obj) return null;
    if (obj.customMetadata?.sealed !== SEALED_FILE)
      return { body: obj.body, contentType: obj.httpMetadata?.contentType, meta: metaOf(obj.customMetadata), sealed: false };
    if (!this.keys) throw new Error("SOCIAL_TOKEN_KEY is not set, so this office's sealed files cannot be opened.");
    const { plain } = await open(this.keys, new Uint8Array(await obj.arrayBuffer()), this.officeId, { purpose: "files", obj: key });
    const view = new Uint8Array(plain);
    const len = new DataView(plain).getUint32(0);
    const head = JSON.parse(dec.decode(view.subarray(4, 4 + len))) as Record<string, unknown>;
    return { body: view.subarray(4 + len), contentType: typeof head.contentType === "string" ? head.contentType : undefined, meta: metaOf(head), sealed: true };
  }

  /** The file's bytes, for reading it (a scan, a sales report). */
  async bytes(key: string): Promise<ArrayBuffer | null> {
    const f = await this.get(key);
    if (!f) return null;
    return f.body instanceof Uint8Array ? (f.body.slice().buffer as ArrayBuffer) : new Response(f.body).arrayBuffer();
  }
}

const notFound = (error: string) => Response.json({ error }, { status: 404 });
const served = (f: StoredFile, filename: string | null) =>
  new Response(f.body, { headers: { ...fileHeaders(f.contentType, filename), "cache-control": "private, max-age=3600" } });

/**
 * The office's file routes, with the same headers the Worker sent before (`fileHeaders`): a member's `GET /api/files/:id`
 * and `GET /api/social/media/:id`; the Worker's `GET /internal/media/:id` for a signed public link it has checked, and
 * `PUT /internal/files/:id` for an emailed attachment. The caller is checked before this (members for /api, the Worker
 * itself for /internal). Null for any other request.
 */
export async function fileRoute(files: OfficeFiles, request: Request, path: string): Promise<Response | null> {
  const m = /^\/(api\/files|api\/social\/media|internal\/media|internal\/files)\/([^/]+)$/.exec(path);
  if (!m) return null;
  const [, where, id] = m as unknown as [string, string, string];
  if (request.method === "GET" && where === "api/files") {
    if (!FILE_ID.test(id)) return notFound("File not found");
    const f = await files.get(docKey(files.officeId, id));
    return f ? served(f, f.meta.filename ?? id) : notFound("File not found");
  }
  if (request.method === "GET" && (where === "api/social/media" || where === "internal/media")) {
    if (!MEDIA_ID.test(id)) return notFound("Picture not found");
    const f = await files.get(mediaKey(files.officeId, id));
    return f ? served(f, null) : notFound("Picture not found");
  }
  if (request.method === "PUT" && where === "internal/files") {
    if (!FILE_ID.test(id)) return notFound("File not found");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE) return Response.json({ error: "Too big." }, { status: 413 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_FILE) return Response.json({ error: "Too big." }, { status: 413 });
    let given: Record<string, unknown>;
    try {
      given = JSON.parse(decodeURIComponent(request.headers.get("x-file-meta") ?? "%7B%7D")) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Unreadable file details." }, { status: 400 });
    }
    await files.put(docKey(files.officeId, id), bytes, typeof given.contentType === "string" ? given.contentType : undefined, metaOf(given));
    return Response.json({ stored: true });
  }
  return null;
}

/** The Worker's side of `PUT /internal/files/:id`: the request that hands an emailed attachment to its office to seal and store. */
export const attachmentRequest = (id: string, a: { content: ArrayBuffer | Uint8Array; mimeType: string; filename: string }, by: string) =>
  new Request(`https://office.internal/internal/files/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: a.content,
    // Everything the sender wrote goes URI-encoded, so none of it is ever a raw header value.
    headers: {
      "content-type": "application/octet-stream",
      "x-file-meta": encodeURIComponent(JSON.stringify({ contentType: a.mimeType, filename: a.filename, by })),
    },
  });
