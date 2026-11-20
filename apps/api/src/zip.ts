/**
 * A plain ZIP archive with every file stored as is. Exports are mostly PDFs and photos,
 * which do not compress, so the archive stays simple and opens everywhere.
 *
 * It is written as a stream: each file's bytes go out as they are read, followed by a data
 * descriptor with their CRC-32 and size, so no file, and never the whole archive, is held in memory.
 */
const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `bytes`, carrying on from `crc` (the CRC of whatever came before them). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** UTF-8 names, and sizes and CRC in a data descriptor after the bytes. */
const FLAGS = 0x0808;
/** Without ZIP64 an archive holds this many files. */
export const ZIP_MAX_FILES = 0xffff;

type Central = { name: Uint8Array; crc: number; size: number; offset: number };

/**
 * Writes one archive a file at a time. The writer only remembers each file's name, CRC, size and
 * where it starts, so an archive can be written in parts, in separate requests, by the same writer.
 */
export class ZipWriter {
  private offset = 0;
  private readonly central: Central[] = [];
  private readonly time: number;
  private readonly date: number;

  constructor(now = new Date()) {
    this.time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    this.date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  }

  get files() {
    return this.central.length;
  }

  /** One file: its header, its bytes as they come, then its CRC-32 and size. */
  async *entry(name: string, data: Uint8Array | string | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    if (this.central.length >= ZIP_MAX_FILES) throw new Error("An archive holds at most 65,535 files.");
    const n = enc.encode(name);
    const start = this.offset;
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, FLAGS, true);
    lv.setUint16(10, this.time, true);
    lv.setUint16(12, this.date, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    yield local;
    let crc = 0;
    let size = 0;
    if (data instanceof ReadableStream) {
      const reader = data.getReader();
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(value, crc);
          size += value.length;
          yield value;
        }
        finished = true;
      } finally {
        // Stopped part way (the download was cancelled): let go of the file rather than read the rest of it.
        if (!finished) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } else {
      const bytes = typeof data === "string" ? enc.encode(data) : data;
      crc = crc32(bytes);
      size = bytes.length;
      yield bytes;
    }
    if (start + local.length + size + 16 > 0xffffffff) throw new Error("An archive holds at most 4 GB.");
    const desc = new Uint8Array(16);
    const dv = new DataView(desc.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crc, true);
    dv.setUint32(8, size, true);
    dv.setUint32(12, size, true);
    yield desc;
    this.offset = start + local.length + size + desc.length;
    this.central.push({ name: n, crc, size, offset: start });
  }

  /** The central directory and its end record, after the last file. */
  finish(): Uint8Array {
    const size = this.central.reduce((s, e) => s + 46 + e.name.length, 0);
    const out = new Uint8Array(size + 22);
    const v = new DataView(out.buffer);
    let at = 0;
    for (const e of this.central) {
      v.setUint32(at, 0x02014b50, true);
      v.setUint16(at + 4, 20, true);
      v.setUint16(at + 6, 20, true);
      v.setUint16(at + 8, FLAGS, true);
      v.setUint16(at + 12, this.time, true);
      v.setUint16(at + 14, this.date, true);
      v.setUint32(at + 16, e.crc, true);
      v.setUint32(at + 20, e.size, true);
      v.setUint32(at + 24, e.size, true);
      v.setUint16(at + 28, e.name.length, true);
      v.setUint32(at + 42, e.offset, true);
      out.set(e.name, at + 46);
      at += 46 + e.name.length;
    }
    v.setUint32(at, 0x06054b50, true);
    v.setUint16(at + 8, this.central.length, true);
    v.setUint16(at + 10, this.central.length, true);
    v.setUint32(at + 12, size, true);
    v.setUint32(at + 16, this.offset, true);
    return out;
  }
}

/** A stream that pulls from `chunks` only as fast as its reader reads, and stops them (and calls `onCancel`) when the reader goes. */
export function streamOf(chunks: AsyncGenerator<Uint8Array>, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      // A generator that never started runs no `finally` on return, so the owner is told here as well.
      await chunks.return(undefined);
      onCancel?.();
    },
  });
}
