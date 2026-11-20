import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EXPORT_PART_FILES, exportArchive, type ExportPlan } from "../../src/export";
import { officePrefix } from "../../src/keys";
import { crc32 } from "../../src/zip";
import { asCaller, asSystem, callerFor, openOffice } from "./office";

const MB = 1024 * 1024;
/** A file's bytes, different for each seed, so a file put in the wrong place is caught. */
const fill = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 131) & 0xff;
  return b;
};

/** Reads the whole download into one buffer, as a browser saves it. */
async function download(body: ReadableStream<Uint8Array>, most: number): Promise<Uint8Array> {
  const out = new Uint8Array(most);
  let at = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, at);
    at += value.length;
  }
  return out.subarray(0, at);
}

type Entry = { name: string; crc: number; size: number; data: Uint8Array };

/** Every file in an archive, found the way unzip finds them: from the end record, through the central directory. */
function unzip(zip: Uint8Array): Entry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  expect(at + v.getUint32(end + 12, true)).toBe(end);
  const dec = new TextDecoder();
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    expect(v.getUint16(at + 10, true)).toBe(0); // stored
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const offset = v.getUint32(at + 42, true);
    const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(offset, true)).toBe(0x04034b50);
    expect(dec.decode(zip.subarray(offset + 30, offset + 30 + v.getUint16(offset + 26, true)))).toBe(name);
    const start = offset + 30 + nameLen + v.getUint16(offset + 28, true);
    const data = zip.subarray(start, start + size);
    expect(v.getUint32(start + size, true)).toBe(0x08074b50);
    expect(v.getUint32(start + size + 4, true)).toBe(crc);
    entries.push({ name, crc, size, data });
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return entries;
}

describe("the office export", () => {
  it("writes an archive of more than 50 MB of files in parts, with only that office's files, each intact", async () => {
    const { id, stub } = await openOffice();
    const other = await openOffice();
    const prefix = officePrefix(id);
    const big = Array.from({ length: 7 }, (_, i) => ({ key: `${prefix}docs/doc-big-${i}`, data: fill(8 * MB + i, i) }));
    // Enough small files that the archive needs more than one part.
    const small = Array.from({ length: EXPORT_PART_FILES + 10 }, (_, i) => ({
      key: `${prefix}media/m-${String(i).padStart(3, "0")}`,
      data: fill(100 + i, 1000 + i),
    }));
    for (const f of [...big, ...small]) await env.DOCS.put(f.key, f.data);
    await env.DOCS.put(`${officePrefix(other.id)}docs/not-yours`, "another office's file");

    const planned = await stub.fetch(await asSystem(id, "/internal/export/plan"));
    expect(planned.status).toBe(200);
    const plan = (await planned.json()) as ExportPlan;
    expect(plan).toMatchObject({ parts: 2, entries: big.length + small.length + 1 });

    const { body, done } = exportArchive(plan, async (part) => stub.fetch(await asSystem(id, "/internal/export/part", { id: plan.id, part })));
    const zip = await download(body, 64 * MB);
    await done;
    expect(zip.length).toBeGreaterThan(56 * MB);

    const entries = unzip(zip);
    expect(entries.map((e) => e.name)).toEqual(["books.json", ...[...big, ...small].map((f) => `files/${f.key.slice(prefix.length)}`).sort()]);
    const books = JSON.parse(new TextDecoder().decode(entries[0]!.data)) as { office: string; books: unknown };
    expect(books.office).toBe(id);
    expect(books.books).toBeTruthy();
    const byName = new Map([...big, ...small].map((f) => [`files/${f.key.slice(prefix.length)}`, f.data]));
    for (const e of entries) {
      expect(crc32(e.data)).toBe(e.crc);
      const want = byName.get(e.name);
      if (want) {
        expect(e.size).toBe(want.length);
        expect(e.data.every((b, i) => b === want[i])).toBe(true);
      }
    }
    expect(entries.some((e) => e.name.includes("not-yours"))).toBe(false);

    // A finished export is gone: its parts cannot be asked for again.
    expect((await stub.fetch(await asSystem(id, "/internal/export/part", { id: plan.id, part: 0 }))).status).toBe(410);
  }, 120_000);

  it("is the office's own work: a person cannot plan or read one, and parts come only in order", async () => {
    const { id, owner, stub } = await openOffice();
    await env.DOCS.put(`${officePrefix(id)}docs/doc-1`, "a bill");
    const asOwner = await stub.fetch(
      await asCaller(callerFor(id, owner), "/internal/export/plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(asOwner.status).toBe(404);

    const plan = (await (await stub.fetch(await asSystem(id, "/internal/export/plan"))).json()) as ExportPlan;
    expect(plan.parts).toBe(1);
    expect((await stub.fetch(await asSystem(id, "/internal/export/part", { id: plan.id, part: 1 }))).status).toBe(410);
    expect((await stub.fetch(await asSystem(id, "/internal/export/part", { id: "made-up", part: 0 }))).status).toBe(410);
    const ownerPart = await stub.fetch(
      await asCaller(callerFor(id, owner), "/internal/export/part", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: plan.id, part: 0 }),
      }),
    );
    expect(ownerPart.status).toBe(404);

    const part = await stub.fetch(await asSystem(id, "/internal/export/part", { id: plan.id, part: 0 }));
    expect(part.status).toBe(200);
    const entries = unzip(new Uint8Array(await part.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["books.json", "files/docs/doc-1"]);
  });
});
