import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { exportArchive } from "../src/export";
import { crc32, streamOf, ZipWriter } from "../src/zip";

const dir = mkdtempSync(join(tmpdir(), "office-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);
const chunked = (data: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += size) c.enqueue(data.slice(i, i + size));
      c.close();
    },
  });
const collect = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());

/** What Python's zipfile, which checks every CRC, makes of an archive: each name with its size. */
const pythonReads = (file: string) =>
  JSON.parse(execFileSync("python3", ["-I", "-c", "import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([[i.filename,i.file_size] for i in z.infolist()]))", file], { encoding: "utf8" })) as [string, number][];

describe("the export archive", () => {
  it("computes CRC-32 as zlib does, a piece at a time", () => {
    const data = bytes(100_003, 1);
    expect(crc32(data)).toBe(zlibCrc32(data));
    expect(crc32(data.subarray(40_000), crc32(data.subarray(0, 40_000)))).toBe(zlibCrc32(data));
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes a stored ZIP that unzip and Python open and check, from streamed files", async () => {
    const big = bytes(3 * 1024 * 1024 + 17, 2);
    const zip = new ZipWriter(new Date(2026, 10, 20, 10, 30, 0));
    async function* all() {
      yield* zip.entry("books.json", JSON.stringify({ books: true }));
      yield* zip.entry("files/docs/doc-1", chunked(big, 64 * 1024));
      yield* zip.entry("files/docs/बिल.pdf", new Uint8Array());
      yield zip.finish();
    }
    const archive = await collect(streamOf(all()));
    const file = join(dir, "export.zip");
    writeFileSync(file, archive);
    expect(pythonReads(file)).toEqual([
      ["books.json", 14],
      ["files/docs/doc-1", big.length],
      ["files/docs/बिल.pdf", 0],
    ]);
    expect(execFileSync("unzip", ["-tq", file], { encoding: "utf8" })).toMatch(/No errors/);
    expect(execFileSync("unzip", ["-p", file, "files/docs/doc-1"], { maxBuffer: 8 * 1024 * 1024 }).equals(Buffer.from(big))).toBe(true);
  });

  it("joins the office's parts into one download, in order, and fails it when a part fails", async () => {
    const zip = new ZipWriter();
    const parts = [
      async function* () {
        yield* zip.entry("books.json", "{}");
        yield* zip.entry("files/a", bytes(1000, 3));
      },
      async function* () {
        yield* zip.entry("files/b", chunked(bytes(5000, 4), 700));
        yield zip.finish();
      },
    ];
    const asked: number[] = [];
    const { body, done } = exportArchive({ id: "x", parts: 2, entries: 3 }, async (part) => {
      asked.push(part);
      return new Response(streamOf(parts[part]!()));
    });
    const file = join(dir, "parts.zip");
    writeFileSync(file, await collect(body));
    await done;
    expect(asked).toEqual([0, 1]);
    expect(pythonReads(file)).toEqual([
      ["books.json", 2],
      ["files/a", 1000],
      ["files/b", 5000],
    ]);

    const failing = exportArchive({ id: "y", parts: 2, entries: 3 }, async (part) => (part === 0 ? new Response("part one") : Response.json({ error: "No such export." }, { status: 410 })));
    await expect(collect(failing.body)).rejects.toThrow();
    await failing.done;
  });
});
