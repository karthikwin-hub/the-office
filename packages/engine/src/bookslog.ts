import type { BookEdit, Books } from "@office/contracts";

/**
 * The edit log the Companies (Accounts) Rules require of accounting software (rule 3(1)): every change
 * to the books, field by field, with the old and new value, who made it and when. It cannot be turned
 * off, entries are only ever added, and each carries a hash of the one before so a gap or a change shows.
 */
export interface EditLog {
  append(entries: Omit<BookEdit, "seq" | "hash">[]): void;
  list(opts?: { coll?: string; recordId?: string; limit?: number }): BookEdit[];
  all(): BookEdit[];
  count(): number;
  /** The last entry, for chaining the next one. */
  last(): BookEdit | null;
}

/** The records the log follows: what an auditor would call the books of account and their masters. */
export const AUDITED_COLLECTIONS = ["parties", "invoices", "bills", "payments", "filedReturns", "employees", "skus", "purchaseOrders", "stock", "compliance"] as const;
/** How long the books and their log are kept, from the year they relate to (Companies Act s.128(5)). */
export const RETENTION_YEARS = 8;

export type Snapshot = Map<string, Map<string, string>>;

export function snapshot(books: Books): Snapshot {
  const snap: Snapshot = new Map();
  snap.set("business", new Map([["_", JSON.stringify(books.business)]]));
  for (const coll of AUDITED_COLLECTIONS) {
    const rows = (books[coll] ?? []) as unknown[];
    snap.set(coll, new Map(rows.map((r, i) => [String((r as { id?: string; skuId?: string }).id ?? (r as { skuId?: string }).skuId ?? i), JSON.stringify(r)])));
  }
  return snap;
}

function fields(json: string): Record<string, unknown> {
  const v = JSON.parse(json) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

/** Field-level differences between two snapshots, as unchained log entries. */
export function diffSnapshots(before: Snapshot, after: Snapshot, by: string, at: string): Omit<BookEdit, "seq" | "hash">[] {
  const out: Omit<BookEdit, "seq" | "hash">[] = [];
  for (const [coll, now] of after) {
    const was = before.get(coll) ?? new Map<string, string>();
    for (const [id, json] of now) {
      const old = was.get(id);
      if (old === json) continue;
      if (old === undefined) {
        out.push({ at, by, coll, recordId: id, action: "create", changes: Object.entries(fields(json)).map(([field, after]) => ({ field, before: null, after })) });
        continue;
      }
      const a = fields(old);
      const b = fields(json);
      const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
        .map((field) => ({ field, before: a[field] ?? null, after: b[field] ?? null }));
      if (changes.length) out.push({ at, by, coll, recordId: id, action: "change", changes });
    }
    for (const [id, json] of was) if (!now.has(id)) out.push({ at, by, coll, recordId: id, action: "delete", changes: Object.entries(fields(json)).map(([field, before]) => ({ field, before, after: null })) });
  }
  return out;
}

/** The entry that opens the log: what the books held when it started. */
export function baselineEntry(books: Books, by: string, at: string): Omit<BookEdit, "seq" | "hash"> {
  return {
    at,
    by,
    coll: "books",
    recordId: "_",
    action: "baseline",
    changes: AUDITED_COLLECTIONS.map((c) => ({ field: c, before: null, after: ((books[c] ?? []) as unknown[]).length })),
  };
}

export function chain(prev: BookEdit | null, e: Omit<BookEdit, "seq" | "hash">): BookEdit {
  const seq = (prev?.seq ?? 0) + 1;
  const hash = sha256(`${prev?.hash ?? ""}|${seq}|${e.at}|${e.by}|${e.coll}|${e.recordId}|${e.action}|${JSON.stringify(e.changes)}`);
  return { ...e, seq, hash };
}

/** Whether every entry follows from the one before. */
export function verifyChain(entries: BookEdit[]): boolean {
  let prev: BookEdit | null = null;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const { seq: _s, hash: _h, ...rest } = e;
    const want = chain(prev, rest);
    if (want.seq !== e.seq || want.hash !== e.hash) return false;
    prev = e;
  }
  return true;
}

export class MemoryEditLog implements EditLog {
  private entries: BookEdit[] = [];
  append(entries: Omit<BookEdit, "seq" | "hash">[]) {
    for (const e of entries) this.entries.push(chain(this.last(), e));
  }
  list(opts: { coll?: string; recordId?: string; limit?: number } = {}) {
    return this.entries.filter((e) => (!opts.coll || e.coll === opts.coll) && (!opts.recordId || e.recordId === opts.recordId)).slice(-(opts.limit ?? 100)).reverse();
  }
  all() {
    return [...this.entries];
  }
  count() {
    return this.entries.length;
  }
  last() {
    return this.entries.at(-1) ?? null;
  }
}

/* SHA-256, synchronous so the log can be written inside a request without awaiting. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Math.floor((len * 8) / 0x1_0000_0000));
  view.setUint32(buf.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
