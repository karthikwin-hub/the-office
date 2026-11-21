import {
  BILL_FIELD_LABEL,
  type BillField,
  type BillMapping,
  type Document,
  missingBillFields,
  type SheetBillKind,
  type SheetLayout,
  type StagedChange,
} from "@office/contracts";
import type { OfficeService } from "./office";
import { findRegisterHeader, layoutKey, type RegisterSkip, readRegister, registerKind, registerScore, rematch } from "./registers";
import type { Sheet } from "./sales/parse";

/** A register waiting for the owner to confirm its columns. Kept apart from the books, as a sheet can be large. */
export type PendingRegister = {
  file: string;
  /** The stored file every bill read from it links to. */
  fileUrl: string;
  sheet: string;
  rows: string[][];
  headerAt: number;
  via: Document["channel"];
  from: string | null;
  auto: boolean;
  /** Rows of the sheet past what is kept, which are not read. */
  cut?: number;
};

/** Where confirmed layouts and waiting registers are kept: the office's SQLite when live, memory in the demo and the tests. */
export interface RegisterStore {
  layout(key: string): SheetLayout | null;
  saveLayout(key: string, l: SheetLayout): void;
  pending(id: string): PendingRegister | null;
  setPending(id: string, p: PendingRegister | null): void;
}

export class MemoryRegisterStore implements RegisterStore {
  private layouts = new Map<string, SheetLayout>();
  private waiting = new Map<string, PendingRegister>();
  layout(key: string) {
    return this.layouts.get(key) ?? null;
  }
  saveLayout(key: string, l: SheetLayout) {
    this.layouts.set(key, structuredClone(l));
  }
  pending(id: string) {
    return this.waiting.get(id) ?? null;
  }
  setPending(id: string, p: PendingRegister | null) {
    if (p) this.waiting.set(id, p);
    else this.waiting.delete(id);
  }
}

export class RegisterError extends Error {}

/** What happened to one sheet of a file. */
export type RegisterResult = {
  sheet: string;
  status: "read" | "needs_layout" | "not_a_register";
  /** Bills or invoices read and staged, posted on their own, or set aside as already in the books. */
  staged: number;
  posted: number;
  duplicates: number;
  skipped: RegisterSkip[];
  /** The `sheet_layout` card waiting for the owner, when the layout is new. */
  cardId?: string;
  message: string;
};

const MAX_SHEETS = 10;
export const MAX_PENDING_ROWS = 20_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
const KIND_NAME: Record<SheetBillKind, string> = { purchase_bill: "purchase bills", sales_invoice: "sales invoices" };

/**
 * The Accountant's reading of registers: bills or invoices listed in a spreadsheet. A layout seen before is read at
 * once; a new one waits for the owner to confirm its columns on the Desk, once (ADR 0010).
 */
export class RegisterService {
  constructor(
    private office: OfficeService,
    readonly store: RegisterStore,
  ) {}

  /** Sheets in a new layout whose header names leave a needed field unfound: a model may suggest those columns. */
  unclear(sheets: Sheet[]): { index: number; headers: string[]; sample: string[][]; guess: BillMapping }[] {
    return sheets.slice(0, MAX_SHEETS).flatMap((sheet, index) => {
      const { at, mapping: guess } = findRegisterHeader(sheet.rows);
      const headers = sheet.rows[at] ?? [];
      if (this.store.layout(layoutKey(headers)) || registerScore(guess) < 2 || !missingBillFields(guess).length) return [];
      return [{ index, headers, sample: sheet.rows.slice(at + 1, at + 4), guess }];
    });
  }

  /**
   * Reads each sheet of a file. `proposed` holds, by sheet, columns a model suggested for a new layout
   * (`fromLayoutAnswer`); the owner still confirms them on the card.
   */
  receive(f: {
    file: string;
    fileUrl: string;
    sheets: Sheet[];
    via: Document["channel"];
    from: string | null;
    auto: boolean;
    id: string;
    proposed?: ({ kind: SheetBillKind | null; mapping: BillMapping } | null | undefined)[];
  }): RegisterResult[] {
    return f.sheets.slice(0, MAX_SHEETS).map((sheet, n) => {
      const importId = f.sheets.length > 1 ? `${f.id}-${n + 1}` : f.id;
      const found = findRegisterHeader(sheet.rows);
      const at = found.at;
      const help = f.proposed?.[n];
      const guess = help?.mapping ?? found.mapping;
      const suggested = (Object.keys(guess) as BillField[]).filter((k) => !found.mapping[k]);
      const pending: PendingRegister = {
        file: f.file.slice(0, 200),
        fileUrl: f.fileUrl,
        sheet: sheet.name,
        rows: sheet.rows.slice(0, MAX_PENDING_ROWS),
        cut: Math.max(0, sheet.rows.length - MAX_PENDING_ROWS),
        headerAt: at,
        via: f.via,
        from: f.from,
        auto: f.auto,
      };
      const known = this.store.layout(layoutKey(sheet.rows[at] ?? []));
      if (known) return this.read(importId, pending, known);
      if (registerScore(guess) < 3) {
        return {
          sheet: sheet.name,
          status: "not_a_register",
          staged: 0,
          posted: 0,
          duplicates: 0,
          skipped: [],
          message: `${sheet.name} does not look like a list of bills or invoices: no columns for the number, date, party and amount.`,
        };
      }
      const kind = help?.kind ?? registerKind(sheet.rows, at, f.file);
      this.store.setPending(importId, pending);
      const card = this.layoutCard(importId, pending, kind, guess, suggested);
      this.office.books.staged.push(card);
      this.office.log("accountant", `A list of ${KIND_NAME[kind]} in a new layout came in (${f.file}); it waits for you to confirm its columns.`, {
        kind: "sheet_import",
        id: importId,
      });
      return {
        sheet: sheet.name,
        status: "needs_layout",
        staged: 0,
        posted: 0,
        duplicates: 0,
        skipped: [],
        cardId: card.id,
        message: `${sheet.name} is in a layout I have not seen. Confirm its columns on your desk once; files like it are read on their own after that.`,
      };
    });
  }

  /** Checks the owner's columns before the card is approved; the error says what to fix. */
  check(importId: string, kind: unknown, mapping: unknown): SheetLayout {
    const p = this.store.pending(importId);
    if (!p) throw new RegisterError("This file is no longer waiting. Send it again.");
    if (kind !== "purchase_bill" && kind !== "sales_invoice") throw new RegisterError("Say whether these are purchase bills or sales invoices.");
    const headers = p.rows[p.headerAt] ?? [];
    const m = (mapping ?? {}) as BillMapping;
    const bad = Object.entries(m).find(([f, h]) => !(f in BILL_FIELD_LABEL) || typeof h !== "string" || !headers.includes(h));
    if (bad) throw new RegisterError(`"${String(bad[1])}" is not a column in this file.`);
    const missing = missingBillFields(m);
    if (missing.length) throw new RegisterError(`Choose the column for ${missing.map((x) => BILL_FIELD_LABEL[x].toLowerCase()).join(", ")}.`);
    return { kind, mapping: m };
  }

  /** The owner approved the columns: keep the layout, and read the file. */
  applyLayout(importId: string, kind: unknown, mapping: unknown): RegisterResult {
    const layout = this.check(importId, kind, mapping);
    const p = this.store.pending(importId)!;
    this.store.saveLayout(layoutKey(p.rows[p.headerAt] ?? []), layout);
    this.store.setPending(importId, null);
    return this.read(importId, p, layout);
  }

  drop(importId: string) {
    this.store.setPending(importId, null);
  }

  private read(importId: string, p: PendingRegister, layout: SheetLayout): RegisterResult {
    const read = readRegister({
      name: p.sheet,
      rows: p.rows,
      headerAt: p.headerAt,
      mapping: layout.mapping,
      kind: layout.kind,
      ctx: this.office.books,
    });
    const { bills } = read;
    const skipped = p.cut
      ? [
          ...read.skipped,
          {
            row: MAX_PENDING_ROWS + 1,
            reason: `${plural(p.cut, "more row")} after row ${MAX_PENDING_ROWS.toLocaleString("en-IN")} were not read; send them in another file`,
          },
        ]
      : read.skipped;
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
    const what = KIND_NAME[layout.kind];
    const parts = [
      staged ? `${staged} ${staged === 1 ? "waits on your desk with its checks" : "wait on your desk with their checks"}` : "",
      posted ? `${posted} posted on their own` : "",
      duplicates ? `${duplicates} ${duplicates === 1 ? "was" : "were"} already in the books` : "",
      skipped.length ? `${plural(skipped.length, "row")} left out` : "",
    ].filter(Boolean);
    const message = bills.length
      ? `Read ${plural(bills.length, what.slice(0, -1), what)} from ${p.sheet}: ${parts.join("; ")}.`
      : `Nothing could be read from ${p.sheet}: ${skipped[0]?.reason ?? "no rows"}.`;
    this.office.log("accountant", message, { kind: "sheet_import", id: importId });
    return { sheet: p.sheet, status: "read", staged, posted, duplicates, skipped: skipped.slice(0, 200), message };
  }

  private layoutCard(importId: string, p: PendingRegister, kind: SheetBillKind, mapping: BillMapping, suggested: BillField[]): StagedChange {
    const headers = p.rows[p.headerAt] ?? [];
    const missing = missingBillFields(mapping);
    const found = (Object.keys(mapping) as BillField[]).map((f) => `${BILL_FIELD_LABEL[f]}: "${mapping[f]}"`);
    const rows = Math.max(0, p.rows.length - p.headerAt - 1);
    return {
      id: `sheet-layout-${importId}`,
      agentId: "accountant",
      kind: "sheet_layout",
      createdAt: new Date().toISOString(),
      title: `Read ${p.file} as ${KIND_NAME[kind]}`,
      summary:
        (missing.length
          ? `A layout I have not seen. I could not find ${missing.map((m) => BILL_FIELD_LABEL[m].toLowerCase()).join(", ")}: choose the columns before approving.`
          : `A layout I have not seen. I read it as ${found.join("; ")}. Approve to read its ${plural(rows, "row")}: each bill comes to your desk with its checks, and files in this layout are read on their own after this.`) +
        (suggested.length
          ? ` The AI suggested the columns for ${suggested.map((m) => BILL_FIELD_LABEL[m].toLowerCase()).join(", ")} from the first rows; check them against the sample.`
          : ""),
      evidence: [{ label: p.file, ref: { kind: "sheet_import", id: importId } }],
      payload: { importId, kind, mapping, headers, sample: p.rows.slice(p.headerAt + 1, p.headerAt + 4), missing, suggested, file: p.file, sheet: p.sheet },
      status: "pending",
    };
  }
}
