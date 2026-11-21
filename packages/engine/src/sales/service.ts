import {
  CHANNEL_NAME,
  type ColumnMapping,
  FIELD_LABEL,
  type OnlineSalesReport,
  REQUIRED_FIELDS,
  salesAddress,
  type SalesChannel,
  type SalesImport,
  type SalesLine,
  type StagedChange,
} from "@office/contracts";
import { addDays, daysBetween } from "../dates";
import { inrShort } from "../money";
import type { OfficeService } from "../office";
import { channelHint, findHeader, guessMapping, layoutKey, missingFields } from "./formats";
import type { Sheet } from "./parse";
import { type ReadResult, readAmazonSettlement, readAmazonTransactions, readLines, readMyntraPnl } from "./read";
import { onlineSalesReport } from "./report";
import type { SalesStore } from "./store";

export const SALES_AGENT = "marketplace-manager";
const MAX_PENDING_ROWS = 50_000;
const newId = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const istNow = () => `${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 19)}+05:30`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** A file as it arrived: its name, its sheets already turned into text, and a hash of its bytes. */
export type IncomingSalesFile = { file: string; sheets: Sheet[]; hash: string; via: SalesImport["via"]; sender: string | null };

/** The Marketplace Manager: reads the platforms' reports into lines, and counts them. Phase A never touches the books. */
export class SalesService {
  constructor(
    private office: OfficeService,
    readonly store: SalesStore,
  ) {}

  get hired() {
    return this.office.hired(SALES_AGENT);
  }

  /** Every sheet in the file that holds sales or a payout becomes one import. A file seen before is set aside. */
  receive(f: IncomingSalesFile): SalesImport[] {
    const base: Pick<SalesImport, "file" | "via" | "sender" | "receivedAt" | "rows" | "lines" | "repeated" | "skipped" | "period" | "grossPaise"> = {
      file: f.file.slice(0, 200),
      via: f.via,
      sender: f.sender,
      receivedAt: istNow(),
      rows: 0,
      lines: 0,
      repeated: 0,
      skipped: [],
      period: null,
      grossPaise: 0,
    };
    const earlier = this.store.importByHash(f.hash) ?? this.store.importByHash(`${f.hash}#0`);
    if (earlier) {
      const dup: SalesImport = {
        ...base,
        id: newId("simp"),
        channel: earlier.channel,
        format: earlier.format,
        formatName: earlier.formatName,
        hash: f.hash,
        status: "duplicate",
        note: `The same file came in on ${day(earlier.receivedAt)}; it was not read again.`,
      };
      this.store.saveImport(dup);
      return [dup];
    }
    const out: SalesImport[] = [];
    const sheets = f.sheets.filter((s) => s.rows.length > 1);
    // A workbook whose report has its summary and notes on other sheets is read as that one report.
    const main = sheets.find((s) => findHeader(s.rows).format?.wholeFile);
    for (const [n, sheet] of sheets.entries()) {
      if (main && sheet !== main) continue;
      const hash = sheets.length > 1 ? `${f.hash}#${n}` : f.hash;
      const label = sheets.length > 1 ? `${f.file} (${sheet.name})` : f.file;
      const r = this.readSheet({ ...f, file: label, hash }, sheet);
      if (r) out.push(r);
    }
    if (!out.length) {
      const none: SalesImport = {
        ...base,
        id: newId("simp"),
        channel: channelHint(f.file, f.sender) ?? "other",
        format: "unknown",
        formatName: "Not a sales report",
        hash: f.hash,
        status: "unreadable",
        note: f.sheets.length
          ? "No sheet in it looked like sales: no row had a date, an order number, a quantity and an amount."
          : "The file could not be opened. Send it as CSV or XLSX.",
      };
      this.store.saveImport(none);
      out.push(none);
    }
    const read = out.filter((i) => i.status === "read");
    if (read.length)
      this.office.log(
        SALES_AGENT,
        `Read ${read.length === 1 ? read[0]!.formatName : `${read.length} reports`}: ${plural(
          read.reduce((a, i) => a + i.lines - i.repeated, 0),
          "new line",
        )}.`,
        { kind: "sales_import", id: read[0]!.id },
      );
    return out;
  }

  private readSheet(f: IncomingSalesFile, sheet: Sheet): SalesImport | null {
    const { at, format } = findHeader(sheet.rows);
    const headers = sheet.rows[at] ?? [];
    const id = newId("simp");
    const base: Pick<
      SalesImport,
      "id" | "file" | "via" | "sender" | "receivedAt" | "hash" | "rows" | "lines" | "repeated" | "skipped" | "period" | "grossPaise"
    > = {
      id,
      file: f.file.slice(0, 200),
      via: f.via,
      sender: f.sender,
      receivedAt: istNow(),
      hash: f.hash,
      rows: Math.max(0, sheet.rows.length - at - 1),
      lines: 0,
      repeated: 0,
      skipped: [],
      period: null,
      grossPaise: 0,
    };
    if (format?.kind === "payout") {
      const p = readAmazonSettlement(sheet.rows, at);
      if (!p) return null;
      this.store.savePayout({ ...p, id: newId("pay"), importId: id });
      const imp: SalesImport = {
        ...base,
        channel: format.channel,
        format: format.id,
        formatName: format.name,
        status: "payout",
        grossPaise: p.netPaise,
        period: p.from && p.to ? { from: p.from, to: p.to } : null,
        note: `${CHANNEL_NAME[format.channel]} paid ${inrShort(p.netPaise)}${p.paidOn ? ` on ${day(p.paidOn)}` : ""}.`,
      };
      this.store.saveImport(imp);
      this.office.log(SALES_AGENT, `Read a ${format.name}: ${inrShort(p.netPaise)} paid.`, { kind: "sales_import", id });
      return imp;
    }
    if (format?.kind === "summary") {
      const r = readMyntraPnl({ rows: sheet.rows, headerAt: at, sheets: f.sheets, skus: this.office.books.skus });
      let extra = "";
      if (r.payout) {
        this.store.savePayout({ ...r.payout, id: newId("pay"), importId: id });
        extra = ` ${CHANNEL_NAME[format.channel]} expects to pay ${inrShort(r.payout.netPaise)} for the month${r.settled !== null ? `; ${inrShort(r.settled)} settled so far` : ""}.`;
      }
      return this.finish(
        { ...base, channel: format.channel, format: format.id, formatName: format.name, status: "read", note: "" },
        r,
        `${extra} A monthly summary by product: counted on the month's last day, without orders.`,
      );
    }
    if (format) {
      const r = readLines({ rows: sheet.rows, headerAt: at, channel: format.channel, file: f.file, format, skus: this.office.books.skus });
      let extra = "";
      if (format.alsoPayout) {
        const p = readAmazonTransactions(sheet.rows, at);
        if (p) {
          this.store.savePayout({ ...p, id: newId("pay"), importId: id });
          extra = p.paidOn ? ` ${CHANNEL_NAME[format.channel]} paid ${inrShort(p.netPaise)} to your bank, last on ${day(p.paidOn)}.` : "";
        }
      }
      return this.finish({ ...base, channel: format.channel, format: format.id, formatName: format.name, status: "read", note: "" }, r, extra);
    }

    const known = this.layout(layoutKey(headers));
    if (known) {
      const r = readLines({
        rows: sheet.rows,
        headerAt: at,
        channel: known.channel,
        file: f.file,
        format: null,
        mapping: known.mapping,
        skus: this.office.books.skus,
      });
      return this.finish(
        { ...base, channel: known.channel, format: "mapped", formatName: `${CHANNEL_NAME[known.channel]} report`, status: "read", note: "" },
        r,
      );
    }
    const guess = guessMapping(headers);
    // A sheet with fewer than two of the four fields needed is not a sales report at all.
    if (REQUIRED_FIELDS.filter((x) => guess[x]).length < 2) return null;
    const channel = channelHint(f.file, f.sender) ?? "other";
    const imp: SalesImport = {
      ...base,
      channel,
      format: "unknown",
      formatName: `${channel === "other" ? "A" : `A ${CHANNEL_NAME[channel]}`} report in a new layout`,
      status: "needs_mapping",
      note: "Waiting for you to say which column is which, once; the same layout is read on its own after that.",
    };
    this.store.saveImport(imp);
    this.store.setPending(id, { headers, rows: sheet.rows.slice(0, MAX_PENDING_ROWS), headerAt: at, file: f.file });
    this.office.books.staged.push(this.mappingCard(imp, headers, guess, sheet.rows.slice(at + 1, at + 4)));
    this.office.log(SALES_AGENT, `A sales report in a new layout came in (${f.file}); it waits for you to confirm its columns.`, { kind: "sales_import", id });
    return imp;
  }

  /**
   * A layout the owner confirmed, from the office's one layout memory (ADR 0010); layouts kept before it existed are
   * still read from the sales store.
   */
  private layout(key: string): { channel: SalesChannel; mapping: ColumnMapping } | null {
    const l = this.office.intake.store.layout(key);
    if (l?.sheetKind === "sales_report") return { channel: l.channel ?? "other", mapping: l.mapping as ColumnMapping };
    return this.store.mapping(key);
  }

  private mappingCard(imp: SalesImport, headers: string[], mapping: ColumnMapping, sample: string[][]): StagedChange {
    const missing = missingFields(mapping);
    const lines = (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).filter((k) => mapping[k]).map((k) => `${FIELD_LABEL[k]}: "${mapping[k]}"`);
    return {
      id: `sales-map-${imp.id}`,
      agentId: SALES_AGENT,
      kind: "sales_mapping",
      createdAt: imp.receivedAt,
      title: `Read ${imp.file} as ${CHANNEL_NAME[imp.channel] === "Other" ? "online sales" : `${CHANNEL_NAME[imp.channel]} sales`}`,
      summary: missing.length
        ? `A layout I have not seen. I could not find ${missing.map((m) => FIELD_LABEL[m].toLowerCase()).join(", ")}: choose them in the Marketplace Manager's room before approving.`
        : `A layout I have not seen. I read it as ${lines.join("; ")}. Approve to read ${plural(imp.rows, "row")}; the same layout is read on its own after this.`,
      evidence: [{ label: imp.file, ref: { kind: "sales_import", id: imp.id } }],
      payload: { importId: imp.id, channel: imp.channel, mapping, headers, sample, missing },
      status: "pending",
    };
  }

  private finish(imp: SalesImport, r: ReadResult, extra = ""): SalesImport {
    const lines: SalesLine[] = r.lines.map((l) => ({ ...l, importId: imp.id }));
    const added = this.store.addLines(lines);
    const sold = lines.filter((l) => l.status === "sold");
    const orders = new Set(sold.filter((l) => l.order).map((l) => l.order)).size;
    const counted = orders
      ? plural(orders, "order")
      : plural(
          sold.reduce((a, l) => a + l.qty, 0),
          "unit",
        );
    const done: SalesImport = {
      ...imp,
      lines: lines.length,
      repeated: lines.length - added,
      skipped: r.skipped.slice(0, 200),
      period: r.period,
      grossPaise: sold.reduce((a, l) => a + l.grossPaise, 0),
      note: lines.length
        ? `${counted}, ${inrShort(sold.reduce((a, l) => a + l.grossPaise, 0))}${r.period ? `, ${r.period.from === r.period.to ? day(r.period.from) : `${day(r.period.from)} to ${day(r.period.to)}`}` : ""}.${lines.length - added ? ` ${plural(lines.length - added, "line")} had come in before and were not counted twice.` : ""}${r.skipped.length ? ` ${plural(r.skipped.length, "row")} left out.` : ""}${r.inPayout ? ` ${plural(r.inPayout, "row")} of fees and transfers went into the payout.` : ""}${extra}`
        : `Nothing could be read: ${r.skipped[0]?.reason ?? "no rows"}`,
    };
    this.store.saveImport(done);
    return done;
  }

  /** The owner's answer for a new layout: read it now, and every file like it from now on. */
  applyMapping(importId: string, channel: SalesChannel, mapping: ColumnMapping): SalesImport {
    const imp = this.store.importById(importId);
    const sheet = this.store.pending(importId);
    if (!imp || !sheet) throw new Error(`No sales report ${importId} waiting to be read`);
    const missing = missingFields(mapping);
    if (missing.length) throw new SalesError(`Choose the column for ${missing.map((m) => FIELD_LABEL[m].toLowerCase()).join(", ")}.`);
    const bad = Object.entries(mapping).find(([, h]) => !sheet.headers.includes(h));
    if (bad) throw new SalesError(`"${bad[1]}" is not a column in this file.`);
    this.office.intake.store.saveLayout(layoutKey(sheet.headers), { sheetKind: "sales_report", channel, mapping });
    const r = readLines({ rows: sheet.rows, headerAt: sheet.headerAt, channel, file: sheet.file, format: null, mapping, skus: this.office.books.skus });
    this.store.setPending(importId, null);
    const done = this.finish({ ...imp, channel, format: "mapped", formatName: `${CHANNEL_NAME[channel]} report`, status: "read" }, r);
    this.office.log(SALES_AGENT, `Read ${imp.file} as ${CHANNEL_NAME[channel]} sales: ${plural(done.lines - done.repeated, "new line")}.`, {
      kind: "sales_import",
      id: importId,
    });
    return done;
  }

  /** Mapping from the room: the card is settled as approved with the owner's columns. */
  mapFromRoom(importId: string, channel: SalesChannel, mapping: ColumnMapping, by: string): SalesImport {
    const card = this.office.books.staged.find(
      (s) => s.kind === "sales_mapping" && s.status === "pending" && (s.payload as { importId?: string }).importId === importId,
    );
    const done = this.applyMapping(importId, channel, mapping);
    if (card) Object.assign(card, { status: "approved", decidedAt: new Date().toISOString(), decidedBy: by, payload: { ...card.payload, channel, mapping } });
    return done;
  }

  dropPending(importId: string) {
    const imp = this.store.importById(importId);
    this.store.setPending(importId, null);
    if (imp) this.store.saveImport({ ...imp, status: "dropped", note: "You chose not to read it." });
  }

  removeImport(importId: string): boolean {
    const imp = this.store.importById(importId);
    if (!imp) return false;
    this.store.removeImport(importId);
    for (const s of this.office.books.staged)
      if (s.kind === "sales_mapping" && s.status === "pending" && (s.payload as { importId?: string }).importId === importId)
        Object.assign(s, { status: "rejected", decidedAt: new Date().toISOString(), note: "The report was removed." });
    this.office.log(SALES_AGENT, `Removed ${imp.file} and everything read from it.`);
    return true;
  }

  /** The period ends on the latest day the reports cover, so a monthly report is not shown as a quiet week; a period ending on a month's last day is that month. */
  report(opts: { from?: string; to?: string } = {}): OnlineSalesReport {
    const last = this.store.lastDate();
    const to = opts.to ?? (last && last < this.office.asOf ? last : this.office.asOf);
    // Reports that end on a month's last day are shown as that month.
    const from = opts.from ?? (addDays(to, 1).endsWith("-01") ? `${to.slice(0, 7)}-01` : addDays(to, -29));
    const days = daysBetween(from, to) + 1;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(Math.max(days, 28) - 1));
    return onlineSalesReport({
      lines: this.store.lines(from, to),
      previous: this.store.lines(prevFrom, prevTo),
      from,
      to,
      skus: this.office.books.skus,
      payouts: this.store.payouts(10),
      imports: this.store.imports(30),
      address: salesAddress(this.office.settings().ingestEmail),
    });
  }

  /** The digest's line: the last day reported in the past three, and any product whose returns are climbing. */
  morning(): string[] {
    const out: string[] = [];
    let last: string | null = null;
    let day: SalesLine[] = [];
    for (let back = 1; back <= 3 && !day.length; back++) {
      last = addDays(this.office.asOf, -back);
      day = this.store.lines(last, last).filter((l) => l.status === "sold");
    }
    if (day.length && last) {
      const by = new Map<SalesChannel, number>();
      for (const l of day) by.set(l.channel, (by.get(l.channel) ?? 0) + l.grossPaise);
      const total = [...by.values()].reduce((a, b) => a + b, 0);
      const when =
        last === addDays(this.office.asOf, -1)
          ? "Yesterday"
          : `On ${new Date(`${last}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}`;
      out.push(
        `${when} online: ${inrShort(total)} (${[...by]
          .sort((a, b) => b[1] - a[1])
          .map(([c, p]) => `${CHANNEL_NAME[c]} ${inrShort(p)}`)
          .join(", ")}).`,
      );
    }
    const r = this.report();
    const climbing = r.skus.filter((s) => s.units >= 5 && s.returnsPct >= 10).slice(0, 2);
    for (const s of climbing) out.push(`Returns on ${s.name} are ${s.returnsPct}% of units sold online, ${r.period.label}.`);
    return out;
  }
}

export class SalesError extends Error {}
