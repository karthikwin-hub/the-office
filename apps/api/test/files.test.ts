import { describe, expect, it, vi } from "vitest";
import { openBackup } from "../../../tools/admin/open-backup.mjs";
import { envelopeHeader, open } from "../src/envelope";
import { OfficeFiles } from "../src/files";
import { rootKeys } from "../src/keyring";
import { docKey, mediaKey } from "../src/keys";

const OLD = "files-root-key-before-rotation";
const NEW = "files-root-key-after-rotation";
const ring = (current: string, ...old: string[]) => rootKeys({ SOCIAL_TOKEN_KEY: current, SOCIAL_TOKEN_KEYS_OLD: old.join(",") })!;
const A = "off_aaaaaaaaaaaaaaaa";
const B = "off_bbbbbbbbbbbbbbbb";

/** R2, in memory, as the office uses it. */
function r2() {
  const m = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const bucket = {
    map: m,
    put: async (key: string, data: Uint8Array | string, o: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } = {}) =>
      void m.set(key, { bytes: typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data), ...o }),
    get: async (key: string) => {
      const v = m.get(key);
      return v
        ? {
            httpMetadata: v.httpMetadata,
            customMetadata: v.customMetadata,
            get body() {
              return new Blob([v.bytes]).stream();
            },
            arrayBuffer: async () => v.bytes.slice().buffer,
          }
        : null;
    },
  };
  return bucket;
}
const text = async (body: ReadableStream<Uint8Array> | Uint8Array) => new Response(body).text();

describe("the office's stored files", () => {
  it("seal the bytes, type, name and sender with the office's key, and give them back", async () => {
    const docs = r2();
    const files = new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), A);
    await files.put(docKey(A, "doc-1"), "%PDF-1.4 bill", "application/pdf", { filename: "bill.pdf", by: "bills@supplier.test" });
    const stored = docs.map.get(docKey(A, "doc-1"))!;
    expect(stored.customMetadata).toEqual({ sealed: "OFB1" });
    expect(stored.httpMetadata).toEqual({ contentType: "application/octet-stream" });
    expect(new TextDecoder("latin1").decode(stored.bytes)).not.toMatch(/bill|supplier|pdf/i);
    expect(envelopeHeader(stored.bytes)).toMatchObject({ kek: "SOCIAL_TOKEN_KEY/hkdf-sha256/files", office: A, obj: docKey(A, "doc-1") });
    // Not a copy of the books: the backup opener refuses it.
    await expect(open(ring(NEW), stored.bytes, A)).rejects.toThrow(/sealed for files/);
    await expect(openBackup([NEW], stored.bytes)).rejects.toThrow(/stored file, not a copy/);

    const f = (await files.get(docKey(A, "doc-1")))!;
    expect(f).toMatchObject({ contentType: "application/pdf", meta: { filename: "bill.pdf", by: "bills@supplier.test" }, sealed: true });
    expect(await text(f.body)).toBe("%PDF-1.4 bill");
    expect(new TextDecoder().decode((await files.bytes(docKey(A, "doc-1")))!)).toBe("%PDF-1.4 bill");
    expect(await files.get(docKey(A, "doc-none"))).toBeNull();
  });

  it("read older plain files as they are, metadata and all", async () => {
    const docs = r2();
    await docs.put(mediaKey(A, "media-u1"), "jpeg", { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { by: "anil@kaveri.test" } });
    const f = (await new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), A).get(mediaKey(A, "media-u1")))!;
    expect(f).toMatchObject({ contentType: "image/jpeg", meta: { by: "anil@kaveri.test" }, sealed: false });
    expect(await text(f.body)).toBe("jpeg");
  });

  it("are the office's own: another office cannot address them, and a copied file does not open there", async () => {
    const docs = r2();
    await new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), A).put(docKey(A, "doc-1"), "A's bill");
    const b = new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), B);
    await expect(b.get(docKey(A, "doc-1"))).rejects.toThrow(/Not this office's file/);
    await expect(b.put(docKey(A, "doc-2"), "x")).rejects.toThrow(/Not this office's file/);
    docs.map.set(docKey(B, "doc-1"), docs.map.get(docKey(A, "doc-1"))!);
    await expect(b.get(docKey(B, "doc-1"))).rejects.toThrow();
  });

  it("keep opening after the root key is rotated, and say which key is missing once it is gone", async () => {
    const docs = r2();
    await new OfficeFiles(docs as unknown as R2Bucket, ring(OLD), A).put(docKey(A, "doc-1"), "before");
    const after = new OfficeFiles(docs as unknown as R2Bucket, ring(NEW, OLD), A);
    expect(await text((await after.get(docKey(A, "doc-1")))!.body)).toBe("before");
    await after.put(docKey(A, "doc-2"), "after");
    const removed = new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), A);
    expect(await text((await removed.get(docKey(A, "doc-2")))!.body)).toBe("after");
    await expect(removed.get(docKey(A, "doc-1"))).rejects.toThrow(/not in SOCIAL_TOKEN_KEY or SOCIAL_TOKEN_KEYS_OLD/);
  });

  it("are stored plain without SOCIAL_TOKEN_KEY, logged once, and a sealed one is not opened without it", async () => {
    const docs = r2();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const plain = new OfficeFiles(docs as unknown as R2Bucket, null, A);
      await plain.put(docKey(A, "doc-1"), "plain", "application/pdf", { filename: "a.pdf" });
      await plain.put(docKey(A, "doc-2"), "plain");
      expect(docs.map.get(docKey(A, "doc-1"))).toMatchObject({ httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: "a.pdf" } });
      expect(warn.mock.calls.filter(([l]) => (l as { event?: string }).event === "files.unsealed")).toHaveLength(1);
      await new OfficeFiles(docs as unknown as R2Bucket, ring(NEW), A).put(docKey(A, "doc-3"), "sealed");
      await expect(plain.get(docKey(A, "doc-3"))).rejects.toThrow(/SOCIAL_TOKEN_KEY is not set/);
    } finally {
      warn.mockRestore();
    }
  });
});
