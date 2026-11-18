import type { ColumnMapping, Payout, SalesChannel, SalesImport, SalesLine } from "@office/contracts";

/** A sheet waiting for the owner to say which column is which. */
export type PendingSheet = { headers: string[]; rows: string[][]; headerAt: number; file: string };

/**
 * Where online sales are kept: the office's SQLite when live, memory in the demo and the tests.
 * Apart from the books, because a busy month on a marketplace runs to thousands of lines.
 */
export interface SalesStore {
  saveImport(i: SalesImport): void;
  importById(id: string): SalesImport | null;
  importByHash(hash: string): SalesImport | null;
  /** Newest first. */
  imports(limit: number): SalesImport[];
  /** Removes an import and everything read from it. */
  removeImport(id: string): void;
  /** Adds the lines not already kept; returns how many were new. */
  addLines(lines: SalesLine[]): number;
  lines(from: string, to: string): SalesLine[];
  /** The latest date with a line on it, or null. */
  lastDate(): string | null;
  savePayout(p: Payout): void;
  payouts(limit: number): Payout[];
  pending(importId: string): PendingSheet | null;
  setPending(importId: string, sheet: PendingSheet | null): void;
  /** Layouts the owner has mapped, by `layoutKey`. */
  mapping(key: string): { channel: SalesChannel; mapping: ColumnMapping } | null;
  saveMapping(key: string, m: { channel: SalesChannel; mapping: ColumnMapping }): void;
}

export class MemorySalesStore implements SalesStore {
  private imps = new Map<string, SalesImport>();
  private ls = new Map<string, SalesLine>();
  private pays = new Map<string, Payout>();
  private pend = new Map<string, PendingSheet>();
  private maps = new Map<string, { channel: SalesChannel; mapping: ColumnMapping }>();
  saveImport(i: SalesImport) {
    this.imps.set(i.id, { ...i });
  }
  importById(id: string) {
    return this.imps.get(id) ?? null;
  }
  importByHash(hash: string) {
    return [...this.imps.values()].find((i) => i.hash === hash && i.status !== "duplicate" && i.status !== "dropped") ?? null;
  }
  imports(limit: number) {
    return [...this.imps.values()].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, limit);
  }
  removeImport(id: string) {
    this.imps.delete(id);
    this.pend.delete(id);
    for (const [k, l] of this.ls) if (l.importId === id) this.ls.delete(k);
    for (const [k, p] of this.pays) if (p.importId === id) this.pays.delete(k);
  }
  addLines(lines: SalesLine[]) {
    let added = 0;
    for (const l of lines) {
      if (this.ls.has(l.id)) continue;
      this.ls.set(l.id, { ...l });
      added++;
    }
    return added;
  }
  lines(from: string, to: string) {
    return [...this.ls.values()].filter((l) => l.date >= from && l.date <= to);
  }
  lastDate() {
    let last: string | null = null;
    for (const l of this.ls.values()) if (!last || l.date > last) last = l.date;
    return last;
  }
  savePayout(p: Payout) {
    this.pays.set(p.id, { ...p });
  }
  payouts(limit: number) {
    return [...this.pays.values()].sort((a, b) => ((a.to ?? "") < (b.to ?? "") ? 1 : -1)).slice(0, limit);
  }
  pending(importId: string) {
    return this.pend.get(importId) ?? null;
  }
  setPending(importId: string, sheet: PendingSheet | null) {
    if (sheet) this.pend.set(importId, sheet);
    else this.pend.delete(importId);
  }
  mapping(key: string) {
    return this.maps.get(key) ?? null;
  }
  saveMapping(key: string, m: { channel: SalesChannel; mapping: ColumnMapping }) {
    this.maps.set(key, m);
  }
}
