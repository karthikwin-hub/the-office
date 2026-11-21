import { env, runInDurableObject } from "cloudflare:test";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { IMPORT_PART_FILES, importKey } from "../../src/import";
import { officePrefix } from "../../src/keys";
import type { Office } from "../../src/office-agent";
import { ZipWriter } from "../../src/zip";
import { asCaller, callerFor, openOffice, person } from "./office";

/** The office id the export came from, on live. */
const FROM = "off_abcdefghijkmnpqr";
const PDF = new TextEncoder().encode("%PDF-1.4\n% a bill\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** An export as the owner downloads it from live (export.ts): books.json, then files under files/. */
async function exportZip(files: [string, Uint8Array | string][], booksJson?: string): Promise<Uint8Array> {
  const books = loadBooks();
  books.documents[0]!.file = `/api/o/${FROM}/files/doc-1`;
  const json = booksJson ?? JSON.stringify({ office: FROM, exportedAt: new Date().toISOString(), books, settings: { digestTime: "07:45" } });
  const zip = new ZipWriter();
  const parts: Uint8Array[] = [];
  for await (const c of zip.entry("books.json", json)) parts.push(c);
  for (const [name, data] of files) for await (const c of zip.entry(name, data)) parts.push(c);
  parts.push(zip.finish());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const upload = async (officeId: string, who: Parameters<typeof callerFor>[1], zip: Uint8Array, role: "owner" | "accountant" = "owner") =>
  asCaller(callerFor(officeId, who, role), "/api/office-admin/import", {
    method: "POST",
    headers: { "content-type": "application/zip", "content-length": String(zip.length) },
    body: zip,
  });
const next = (officeId: string, who: Parameters<typeof callerFor>[1]) =>
  asCaller(callerFor(officeId, who), "/api/office-admin/import/next", { method: "POST" });
const booksOf = (stub: DurableObjectStub<Office>) =>
  runInDurableObject(stub, (o) => (o as unknown as { office: { books: ReturnType<typeof loadBooks> } }).office.books);

describe("loading an export from live into a new office (staging)", () => {
  it("takes the books and every file, a batch at a time, with links moved and nothing left acting on its own", async () => {
    const { id, owner, stub } = await openOffice();
    const media = Array.from({ length: IMPORT_PART_FILES + 5 }, (_, i) => [`files/media/media-${i}`, PNG] as [string, Uint8Array]);
    const zip = await exportZip([["files/docs/doc-1", PDF], ...media, ["files/other/x", "not a document"], ["files/docs/../escape", "no"]]);

    const started = await stub.fetch(await upload(id, owner, zip));
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ done: 0, total: media.length + 1, skipped: 0, finished: false });

    let steps = 0;
    let last: { done: number; total: number; skipped: number; finished: boolean } = { done: 0, total: 0, skipped: 0, finished: false };
    while (!last.finished && steps < 5) {
      const res = await stub.fetch(await next(id, owner));
      expect(res.status).toBe(200);
      last = await res.json();
      steps++;
    }
    expect(steps).toBe(2);
    expect(last).toEqual({ done: media.length + 1, total: media.length + 1, skipped: 0, finished: true });

    const books = await booksOf(stub);
    const sample = loadBooks();
    expect(books.documents).toHaveLength(sample.documents.length);
    expect(books.invoices).toHaveLength(sample.invoices.length);
    expect(books.documents[0]!.file).toBe(`/api/o/${id}/files/doc-1`);
    expect(JSON.stringify(books)).not.toContain(FROM);
    // On staging nothing acts for the business by itself.
    expect(new Set(books.agents.map((a) => a.trustLevel))).toEqual(new Set(["trainee"]));
    expect(books.channels.every((c) => c.mode === "manual" && c.status === "manual" && c.connectedAt === null)).toBe(true);

    // The bill opens through the office, sealed with this office's key and typed from its bytes.
    const file = await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-1"));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    expect((await env.DOCS.head(`${officePrefix(id)}docs/doc-1`))?.customMetadata?.sealed).toBe("OFB1");
    expect(await env.DOCS.head(`${officePrefix(id)}media/media-0`)).not.toBeNull();
    // Only documents and pictures, only under this office: the other entries were never stored.
    expect(await env.DOCS.head(`${officePrefix(id)}other/x`)).toBeNull();
    expect((await env.DOCS.list({ prefix: officePrefix(id) })).objects.some((o) => o.key.includes(".."))).toBe(false);
    // The upload is gone once its files are in.
    expect(await env.DOCS.head(importKey(id))).toBeNull();

    // Now the office has books: a second import is refused.
    const again = await stub.fetch(await upload(id, owner, zip));
    expect(again.status).toBe(409);
  });

  it("keeps the business details from the export, even after the new office saved its own settings", async () => {
    const { id, owner, stub: office } = await openOffice();
    // Anything the owner changes first saves the empty office's settings, business details and all.
    const prefs = await office.fetch(
      await asCaller(callerFor(id, owner), "/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skin: "loft" }),
      }),
    );
    expect(prefs.status).toBe(200);
    expect((await office.fetch(await upload(id, owner, await exportZip([])))).status).toBe(200);
    const sample = loadBooks();
    const books = await booksOf(office);
    expect(books.business.name).toBe(sample.business.name);
    expect(books.business.gstin).toBe(sample.business.gstin);
    expect(books.business.address).toBe(sample.business.address);
  });

  it("carries on an import already under way rather than refusing it", async () => {
    const { id, owner, stub: office } = await openOffice();
    const zip = await exportZip([["files/docs/doc-3", PDF]]);
    expect(await (await office.fetch(await upload(id, owner, zip))).json()).toEqual({ done: 0, total: 1, skipped: 0, finished: false });
    // The page was closed before the files were copied; choosing the export again carries on.
    const again = await office.fetch(await upload(id, owner, zip));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ done: 1, total: 1, skipped: 0, finished: true });
  });

  it("is for the owner only", async () => {
    const { id } = await openOffice();
    const accountant = await person("Bina");
    const res = await stub(id).fetch(await upload(id, accountant, await exportZip([]), "accountant"));
    expect(res.status).toBe(403);
    expect(await env.DOCS.head(importKey(id))).toBeNull();
  });

  it("refuses what is not an export, and keeps nothing of it", async () => {
    const { id, owner, stub: office } = await openOffice();
    const notZip = new TextEncoder().encode("just some text, not an archive at all");
    const res = await office.fetch(await upload(id, owner, notZip));
    expect(res.status).toBe(400);
    expect(await env.DOCS.head(importKey(id))).toBeNull();

    const badBooks = await exportZip([], JSON.stringify({ office: FROM, books: { not: "books" } }));
    const res2 = await office.fetch(await upload(id, owner, badBooks));
    expect(res2.status).toBe(400);
    expect(await env.DOCS.head(importKey(id))).toBeNull();
    expect((await booksOf(office)).documents).toHaveLength(0);
  });

  it("counts a file whose bytes do not match the archive's check as skipped", async () => {
    const { id, owner, stub: office } = await openOffice();
    const zip = await exportZip([["files/docs/doc-2", PDF]]);
    // Flip a byte of the PDF inside the archive: its CRC-32 no longer matches.
    const pdfAt = findBytes(zip, PDF);
    expect(pdfAt).toBeGreaterThan(0);
    zip[pdfAt + 3] = (zip[pdfAt + 3] ?? 0) ^ 0xff;
    expect((await office.fetch(await upload(id, owner, zip))).status).toBe(200);
    const res = await office.fetch(await next(id, owner));
    expect(await res.json()).toEqual({ done: 1, total: 1, skipped: 1, finished: true });
    expect(await env.DOCS.head(`${officePrefix(id)}docs/doc-2`)).toBeNull();
  });
});

const stub = (id: string) => env.Office.get(env.Office.idFromName(id));

function findBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
