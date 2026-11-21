import {
  type BillMapping,
  type Document,
  missingFor,
  SHEET_KINDS,
  type SheetBillKind,
  type SheetKind,
  type SheetLayout,
  type SheetMapping,
  type StagedChange,
} from "@office/contracts";
import { recognise, scoreFor } from "./intake/kinds";
import type { OfficeService } from "./office";
import { layoutKey, type RegisterSkip, readRegister, registerKind, rematch } from "./registers";
import type { Sheet } from "./sales/parse";

/** A sheet waiting for the owner to confirm its columns. Kept apart from the books, as a sheet can be large. */
export type WaitingSheet = {
  file: string;
  /** The stored file every record read from it links to. */
  fileUrl: string;
  sheet: string;
  rows: string[][];
  headerAt: number;
  via: Document["channel"];
  from: string | null;
  auto: boolean;
  /** Rows of the sheet past what is kept, which are not read. */
  cut?: number;
  /** The kinds this sheet may be read as, from where it came in. */
  kinds?: SheetKind[];
};

/** Where confirmed layouts and waiting sheets are kept: the office's SQLite when live, memory in the demo and the tests. */
export interface LayoutStore {
  layout(key: string): SheetLayout | null;
  saveLayout(key: string, l: SheetLayout): void;
  pending(id: string): WaitingSheet | null;
  setPending(id: string, p: WaitingSheet | null): void;
}

export class MemoryLayoutStore implements LayoutStore {
  private layouts = new Map<string, SheetLayout>();
  private waiting = new Map<string, WaitingSheet>();
  layout(key: string) {
    return this.layouts.get(key) ?? null;
  }
  saveLayout(key: string, l: SheetLayout) {
    this.layouts.set(key, structuredClone(l));
  }
  pending(id: string) {
    return this.waiting.get(id) ?? null;
  }
  setPending(id: string, p: WaitingSheet | null) {
    if (p) this.waiting.set(id, p);
    else this.waiting.delete(id);
  }
}

export class RegisterError extends Error {}

/** What happened to one sheet of a file. */
export type SheetResult = {
  sheet: string;
  sheetKind: SheetKind | null;
  status: "read" | "needs_layout" | "not_recognised";
  /** Records read and staged, posted on their own, or set aside as already in the books. */
  staged: number;
  posted: number;
  duplicates: number;
  skipped: RegisterSkip[];
  /** For kinds that keep records rather than stage them (orders, post results): how many were added and updated. */
  added?: number;
  updated?: number;
  /** The `sheet_layout` card waiting for the owner, when the layout is new. */
  cardId?: string;
  message: string;
};

/** Reads a sheet in a confirmed layout into the books, for one kind. */
export type SheetReader = (importId: string, p: WaitingSheet, layout: SheetLayout) => SheetResult;

const MAX_SHEETS = 10;
export const MAX_PENDING_ROWS = 20_000;
/** A new layout is put to the owner when its names meet at least this much of what the kind needs. */
const RECOGNISED = 0.75;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
const KIND_NAME: Record<SheetBillKind, string> = { purchase_bill: "purchase bills", sales_invoice: "sales invoices" };
const what = (l: Pick<SheetLayout, "sheetKind" | "kind">) =>
  l.sheetKind === "bill_register" ? KIND_NAME[l.kind ?? "purchase_bill"] : SHEET_KINDS[l.sheetKind].label.toLowerCase();

/**
 * One way in for every spreadsheet (ADR 0010). A sheet is recognised among the kinds allowed where it came in; a
 * layout seen before is read at once by its kind's reader, and a new one waits for the owner to confirm its columns
 * on the Desk, once.
 */
export class SheetIntake {
  private readers: Partial<Record<SheetKind, SheetReader>> = {};

  constructor(
    private office: OfficeService,
    readonly store: LayoutStore,
  ) {
    this.readers.bill_register = (id, p, l) => this.readBills(id, p, l);
  }

  /** Each agent hands in the reader for the kinds it owns. */
  register(kind: SheetKind, reader: SheetReader) {
    this.readers[kind] = reader;
  }

  /** A layout the owner confirmed for one of the top rows, whichever row the names would have guessed. */
  knownLayout(rows: string[][], kinds: readonly SheetKind[]): { at: number; layout: SheetLayout } | null {
    for (let at = 0; at < Math.min(rows.length, 20); at++) {
      const layout = this.store.layout(layoutKey(rows[at] ?? []));
      if (layout && kinds.includes(layout.sheetKind)) return { at, layout };
    }
    return null;
  }

  /** Sheets in a new layout whose header names leave a needed field unfound: a model may suggest those columns. */
  unclear(sheets: Sheet[], kinds: readonly SheetKind[] = ["bill_register"]) {
    return sheets.slice(0, MAX_SHEETS).flatMap((sheet, index) => {
      const r = recognise(sheet.rows, kinds);
      const headers = sheet.rows[r.at] ?? [];
      if (this.knownLayout(sheet.rows, kinds) || r.score < 0.5 || !missingFor(r.kind, r.mapping).length) return [];
      return [{ index, sheetKind: r.kind, headers, sample: sheet.rows.slice(r.at + 1, r.at + 4), guess: r.mapping as BillMapping }];
    });
  }

  /**
   * Reads each sheet of a file as one of `kinds`. `proposed` holds, by sheet, columns a model suggested for a new
   * layout (`fromLayoutAnswer`); the owner still confirms them on the card.
   */
  receive(f: {
    file: string;
    fileUrl: string;
    sheets: Sheet[];
    via: Document["channel"];
    from: string | null;
    auto: boolean;
    id: string;
    kinds?: SheetKind[];
    proposed?: ({ kind: SheetBillKind | null; mapping: SheetMapping } | null | undefined)[];
  }): SheetResult[] {
    const kinds = (f.kinds ?? ["bill_register"]).filter((k) => this.readers[k]);
    if (!kinds.length)
      return f.sheets
        .slice(0, 1)
        .map((s) => ({ ...empty(s.name, null), status: "not_recognised", message: "No one in the office reads this kind of file yet." }));
    return f.sheets.slice(0, MAX_SHEETS).map((sheet, n) => {
      const importId = f.sheets.length > 1 ? `${f.id}-${n + 1}` : f.id;
      const found = recognise(sheet.rows, kinds);
      const help = f.proposed?.[n];
      const mapping = help?.mapping ?? found.mapping;
      const suggested = Object.keys(mapping).filter((k) => !found.mapping[k]);
      const pending: WaitingSheet = {
        file: f.file.slice(0, 200),
        fileUrl: f.fileUrl,
        sheet: sheet.name,
        rows: sheet.rows.slice(0, MAX_PENDING_ROWS),
        cut: Math.max(0, sheet.rows.length - MAX_PENDING_ROWS),
        headerAt: found.at,
        via: f.via,
        from: f.from,
        auto: f.auto,
        kinds,
      };
      const known = this.knownLayout(sheet.rows, kinds);
      if (known) return this.read(importId, { ...pending, headerAt: known.at }, known.layout);
      if (scoreFor(found.kind, mapping) < RECOGNISED) {
        const names = kinds.map((k) => SHEET_KINDS[k].label.toLowerCase()).join(" or ");
        return { ...empty(sheet.name, null), status: "not_recognised", message: `${sheet.name} does not look like ${names}: its columns are not ones I know.` };
      }
      const layout: SheetLayout = {
        sheetKind: found.kind,
        mapping,
        ...(found.kind === "bill_register" ? { kind: help?.kind ?? registerKind(sheet.rows, found.at, f.file) } : {}),
      };
      this.store.setPending(importId, pending);
      const card = this.layoutCard(importId, pending, layout, suggested);
      this.office.books.staged.push(card);
      this.office.log(card.agentId, `A list of ${what(layout)} in a new layout came in (${f.file}); it waits for you to confirm its columns.`, {
        kind: "sheet_import",
        id: importId,
      });
      return {
        ...empty(sheet.name, found.kind),
        status: "needs_layout",
        cardId: card.id,
        message: `${sheet.name} is in a layout I have not seen. Confirm its columns on your desk once; files like it are read on their own after that.`,
      };
    });
  }

  /** Checks the owner's choice before the card is approved; the error says what to fix. */
  check(importId: string, choice: { sheetKind?: unknown; kind?: unknown; mapping?: unknown }): SheetLayout {
    const p = this.store.pending(importId);
    if (!p) throw new RegisterError("This file is no longer waiting. Send it again.");
    const sheetKind = (choice.sheetKind ?? "bill_register") as SheetKind;
    if (!(p.kinds ?? ["bill_register"]).includes(sheetKind) || !this.readers[sheetKind]) throw new RegisterError("This file cannot be read as that.");
    const kind = choice.kind;
    if (sheetKind === "bill_register" && kind !== "purchase_bill" && kind !== "sales_invoice")
      throw new RegisterError("Say whether these are purchase bills or sales invoices.");
    const headers = p.rows[p.headerAt] ?? [];
    const fields = SHEET_KINDS[sheetKind].fields;
    const m = (choice.mapping ?? {}) as SheetMapping;
    const bad = Object.entries(m).find(([f, h]) => !Object.hasOwn(fields, f) || typeof h !== "string" || !headers.includes(h));
    if (bad) throw new RegisterError(`"${String(bad[1])}" is not a column in this file.`);
    const missing = missingFor(sheetKind, m);
    if (missing.length) throw new RegisterError(`Choose the column for ${missing.map((x) => fields[x]!.toLowerCase()).join(", ")}.`);
    return { sheetKind, mapping: m, ...(sheetKind === "bill_register" ? { kind: kind as SheetBillKind } : {}) };
  }

  /** The owner approved the columns: keep the layout, and read the file. */
  applyLayout(importId: string, choice: { sheetKind?: unknown; kind?: unknown; mapping?: unknown }): SheetResult {
    const layout = this.check(importId, choice);
    const p = this.store.pending(importId)!;
    this.store.saveLayout(layoutKey(p.rows[p.headerAt] ?? []), layout);
    this.store.setPending(importId, null);
    return this.read(importId, p, layout);
  }

  drop(importId: string) {
    this.store.setPending(importId, null);
  }

  private read(importId: string, p: WaitingSheet, layout: SheetLayout): SheetResult {
    const r = this.readers[layout.sheetKind]!(importId, p, layout);
    if (!p.cut) return r;
    const reason = `${plural(p.cut, "more row")} after row ${MAX_PENDING_ROWS.toLocaleString("en-IN")} were not read; send them in another file`;
    return { ...r, skipped: [...r.skipped, { row: MAX_PENDING_ROWS + 1, reason }], message: `${r.message} ${reason[0]!.toUpperCase()}${reason.slice(1)}.` };
  }

  private readBills(importId: string, p: WaitingSheet, layout: SheetLayout): SheetResult {
    const kind = layout.kind ?? "purchase_bill";
    const { bills, skipped } = readRegister({
      name: p.sheet,
      rows: p.rows,
      headerAt: p.headerAt,
      mapping: layout.mapping as BillMapping,
      kind,
      ctx: this.office.books,
    });
    let staged = 0;
    let posted = 0;
    let duplicates = 0;
    bills.forEach((b, n) => {
      const docId = `doc-${importId.replace(/^reg-/, "r")}-${n + 1}`;
      const doc = this.office.receiveDocument({ id: docId, file: p.fileUrl, channel: p.via, from: p.from, pages: 1 });
      doc.sheet = b.sheet;
      const r = this.office.ingest(docId, rematch(b.extraction, this.office.books), p.auto);
      if (r.staged?.status === "rejected") duplicates++;
      else if (r.staged?.status === "approved") posted++;
      else if (r.staged) staged++;
    });
    const name = KIND_NAME[kind];
    const parts = [
      staged ? `${staged} ${staged === 1 ? "waits on your desk with its checks" : "wait on your desk with their checks"}` : "",
      posted ? `${posted} posted on their own` : "",
      duplicates ? `${duplicates} ${duplicates === 1 ? "was" : "were"} already in the books` : "",
      skipped.length ? `${plural(skipped.length, "row")} left out` : "",
    ].filter(Boolean);
    const message = bills.length
      ? `Read ${plural(bills.length, name.slice(0, -1), name)} from ${p.sheet}: ${parts.join("; ")}.`
      : `Nothing could be read from ${p.sheet}: ${skipped[0]?.reason ?? "no rows"}.`;
    this.office.log("accountant", message, { kind: "sheet_import", id: importId });
    return { ...empty(p.sheet, "bill_register"), status: "read", staged, posted, duplicates, skipped: skipped.slice(0, 200), message };
  }

  private layoutCard(importId: string, p: WaitingSheet, layout: SheetLayout, suggested: string[]): StagedChange {
    const spec = SHEET_KINDS[layout.sheetKind];
    const headers = p.rows[p.headerAt] ?? [];
    const missing = missingFor(layout.sheetKind, layout.mapping);
    const found = Object.keys(layout.mapping).map((f) => `${spec.fields[f]}: "${layout.mapping[f]}"`);
    const rows = Math.max(0, p.rows.length - p.headerAt - 1);
    const label = (f: string) => spec.fields[f]!.toLowerCase();
    const after = layout.sheetKind === "bill_register" ? "each bill comes to your desk with its checks, and " : "";
    return {
      id: `sheet-layout-${importId}`,
      agentId: spec.agentId,
      kind: "sheet_layout",
      createdAt: new Date().toISOString(),
      title: `Read ${p.file} as ${what(layout)}`,
      summary:
        (missing.length
          ? `A layout I have not seen. I could not find ${missing.map(label).join(", ")}: choose the columns before approving.`
          : `A layout I have not seen. I read it as ${found.join("; ")}. Approve to read its ${plural(rows, "row")}: ${after}files in this layout are read on their own after this.`) +
        (suggested.length ? ` The AI suggested the columns for ${suggested.map(label).join(", ")} from the first rows; check them against the sample.` : ""),
      evidence: [{ label: p.file, ref: { kind: "sheet_import", id: importId } }],
      payload: {
        importId,
        sheetKind: layout.sheetKind,
        kinds: p.kinds ?? [layout.sheetKind],
        ...(layout.kind ? { kind: layout.kind } : {}),
        mapping: layout.mapping,
        headers,
        sample: p.rows.slice(p.headerAt + 1, p.headerAt + 4),
        missing,
        suggested,
        file: p.file,
        sheet: p.sheet,
      },
      status: "pending",
    };
  }
}

const empty = (sheet: string, sheetKind: SheetKind | null): Omit<SheetResult, "status" | "message"> => ({
  sheet,
  sheetKind,
  staged: 0,
  posted: 0,
  duplicates: 0,
  skipped: [],
});
