import {
  type Bill,
  type Books,
  type Document,
  Gstin,
  IMPORT_MAX_ROWS,
  type ImportCheck,
  type ImportIssue,
  type ImportKind,
  type ImportPreview,
  type Invoice,
  IsoDate,
  Party,
  Sku,
  StockLevel,
  TdsSection,
} from "@office/contracts";
import { z } from "zod";
import { addDays, dateLabel, daysBetween } from "./dates";
import { parseAmount, parseDate } from "./extract";
import { ImportError } from "./imports";
import { inr, inrShort } from "./money";

/**
 * Bringing a business's existing books into a new office: customers and suppliers,
 * products with their stock, and what is still owed on invoices and bills from
 * before the books start. Each brought-forward item is one line for the amount
 * still outstanding, with no GST, so it counts towards ageing and statements but
 * never towards returns, which were filed before.
 */

/** A staged import is stored in one row of the office's database, which holds about 2 MB. */
export const IMPORT_MAX_PAYLOAD = 1_500_000;
const MAX_ISSUES = 200;

const OpenItem = z.object({
  type: z.enum(["invoice", "bill"]),
  number: z.string(),
  date: IsoDate,
  dueDate: IsoDate,
  partyId: z.string(),
  totalPaise: z.number().int().positive(),
  outstandingPaise: z.number().int().positive(),
  from: z.string(),
  file: z.string(),
});
type OpenItem = z.infer<typeof OpenItem>;

export const OnboardingPayload = z.object({
  booksFrom: IsoDate,
  files: z.array(z.object({ kind: z.enum(["parties", "products", "open-items"]), name: z.string(), rows: z.number().int() })),
  parties: z.array(Party),
  skus: z.array(Sku),
  stock: z.array(StockLevel),
  open: z.array(OpenItem),
  counts: z.record(z.number()),
  sample: z.array(z.string()),
});
export type OnboardingPayload = z.infer<typeof OnboardingPayload>;

type Row = { row: number; get: (column: string) => string };

/** CSV records numbered as a spreadsheet numbers them, so "row 12" is the row the owner sees. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell.trim());
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) out.push(row);
  return out;
}

const header = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const COLUMNS: Record<ImportKind, { required: string[]; optional: string[] }> = {
  parties: { required: ["type", "name"], optional: ["gstin", "pan", "state", "city", "contact_name", "phone", "email", "payment_terms_days", "credit_limit", "tan", "tds_section", "entity"] },
  products: { required: ["sku", "name", "hsn", "gst_rate", "price"], optional: ["unit", "cost", "category", "on_hand", "reorder_point", "lead_time_days", "location"] },
  "open-items": { required: ["type", "number", "date", "party", "total", "outstanding"], optional: ["due_date"] },
};

const GST_RATES = new Set([0, 3, 5, 12, 18, 28, 40]);
const SUPPLY_BY_SECTION = { "194C": "service", "194J": "professional", "194I": "rent", "194H": "commission", "194Q": "goods" } as const;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

const realDate = (iso: string | null) => (iso && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null);

const uid = (prefix: string, taken: Set<string>) => {
  let n = taken.size + 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  const id = `${prefix}-${n}`;
  taken.add(id);
  return id;
};

/** Checks the files and builds what an approval would add. Nothing in the books changes. */
export function checkImport(books: Books, asOf: string, req: ImportCheck): { preview: ImportPreview; payload: OnboardingPayload | null } {
  const issues: ImportIssue[] = [];
  const issue = (file: ImportKind | null, row: number, column: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ file, row, column, message });
  };
  const fixed = books.business.booksFrom;
  const booksFrom = fixed ?? req.booksFrom;
  if (!realDate(booksFrom)) issue(null, 0, "books_from", "The start date is not a real date.");
  else if (booksFrom > asOf) issue(null, 0, "books_from", `The books cannot start after today, ${dateLabel(asOf)}.`);
  if (books.staged.some((s) => s.kind === "onboarding" && s.status === "pending")) issue(null, 0, "", "An import is already waiting on the Desk. Approve or reject it first.");

  const files: OnboardingPayload["files"] = [];
  const rowsOf = (kind: ImportKind): Row[] => {
    const f = req.files.find((x) => x.kind === kind);
    if (!f) return [];
    const recs = records(f.csv);
    const head = (recs[0] ?? []).map(header);
    const missing = COLUMNS[kind].required.filter((c) => !head.includes(c));
    const rows: Row[] = [];
    recs.slice(1).forEach((cells, i) => {
      if (cells.some((c) => c)) rows.push({ row: i + 2, get: (c) => cells[head.indexOf(c)] ?? "" });
    });
    files.push({ kind, name: f.name, rows: rows.length });
    if (!recs.length) issue(kind, 1, "", "The file is empty.");
    else if (missing.length) issue(kind, 1, missing.join(", "), `The first row needs the column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Start from the template.`);
    else if (rows.length > IMPORT_MAX_ROWS) issue(kind, IMPORT_MAX_ROWS + 2, "", `Up to ${IMPORT_MAX_ROWS.toLocaleString("en-IN")} rows in one file, please. Split it and bring in the rest after.`);
    else return rows;
    return [];
  };

  /* Customers and suppliers */
  const partyIds = new Set(books.parties.map((p) => p.id));
  const parties: Party[] = [];
  const states = books.states;
  const stateCode = (v: string) => (/^\d{2}$/.test(v) && states[v] ? v : (Object.entries(states).find(([, name]) => name.toLowerCase() === v.toLowerCase())?.[0] ?? null));
  for (const r of rowsOf("parties")) {
    const before = issues.length;
    const bad = (column: string, message: string) => issue("parties", r.row, column, message);
    const type = r.get("type").toLowerCase();
    const kind = type === "customer" ? "customer" : type === "supplier" || type === "vendor" ? "vendor" : null;
    if (!kind) bad("type", 'Write "customer" or "supplier".');
    const name = r.get("name").replace(/\s+/g, " ");
    if (!name) bad("name", "The name is missing.");
    const gstinRaw = r.get("gstin").toUpperCase().replace(/\s/g, "");
    const gstin = gstinRaw ? (Gstin.safeParse(gstinRaw).success ? gstinRaw : null) : null;
    if (gstinRaw && !gstin) bad("gstin", `"${gstinRaw}" is not a GSTIN. It has 15 characters, like 29ABCDE1234F1Z5.`);
    const pan = gstin ? gstin.slice(2, 12) : r.get("pan").toUpperCase();
    if (pan && !PAN.test(pan)) bad("pan", `"${pan}" is not a PAN. It has 10 characters, like ABCDE1234F.`);
    const state = gstin ? gstin.slice(0, 2) : stateCode(r.get("state"));
    if (!gstin && !state) bad("state", r.get("state") ? `"${r.get("state")}" is not a state. Use its name or two-digit code.` : "Give the state, or the GSTIN.");
    const terms = r.get("payment_terms_days");
    if (terms && !/^\d{1,3}$/.test(terms)) bad("payment_terms_days", "Write the number of days, like 30.");
    const limit = r.get("credit_limit") ? parseAmount(r.get("credit_limit")) : null;
    if (r.get("credit_limit") && (limit === null || limit < 0)) bad("credit_limit", "Write the amount in rupees, like 2,00,000.");
    const section = r.get("tds_section").toUpperCase();
    if (section && !TdsSection.safeParse(section).success) bad("tds_section", `Use one of ${TdsSection.options.join(", ")}, or leave it blank.`);
    if (section && kind === "customer") bad("tds_section", "TDS sections are for suppliers. For a customer who deducts TDS, give their TAN.");
    const entity = r.get("entity").toLowerCase();
    if (entity && !["company", "firm", "individual"].includes(entity)) bad("entity", 'Write "company", "firm" or "individual", or leave it blank.');
    const dup = (p: Party) => p.kind === kind && ((gstin && p.gstin === gstin) || p.name.toLowerCase() === name.toLowerCase());
    if (kind && name && books.parties.some(dup)) bad("name", `${name} is already in the books.`);
    else if (kind && name && parties.some(dup)) bad("name", `${name} appears twice in this file.`);
    if (issues.length > before || !kind) continue;
    const tdsSection = section ? (section as TdsSection) : null;
    parties.push({
      id: uid(kind === "customer" ? "cus-ob" : "ven-ob", partyIds),
      kind,
      name,
      entity: (entity || (pan[3] === "C" ? "company" : pan[3] === "P" || pan[3] === "H" ? "individual" : "firm")) as Party["entity"],
      gstin,
      pan,
      stateCode: state!,
      city: r.get("city"),
      contact: { name: r.get("contact_name"), phone: r.get("phone"), email: r.get("email") },
      ...(terms ? { paymentTermsDays: Number(terms) } : {}),
      ...(limit ? { creditLimitPaise: limit } : {}),
      ...(kind === "customer" ? { tan: r.get("tan").toUpperCase() || null } : { tdsSection, supplyKind: tdsSection ? SUPPLY_BY_SECTION[tdsSection] : "goods" }),
    });
  }

  /* Products and stock */
  const skus: Sku[] = [];
  const stock: OnboardingPayload["stock"] = [];
  for (const r of rowsOf("products")) {
    const before = issues.length;
    const bad = (column: string, message: string) => issue("products", r.row, column, message);
    const id = r.get("sku");
    if (!/^[\w.\-/]{1,40}$/.test(id)) bad("sku", id ? "Use letters, numbers, dashes or slashes, up to 40, with no spaces." : "The product code is missing.");
    else if (books.skus.some((s) => s.id.toLowerCase() === id.toLowerCase())) bad("sku", `${id} is already in the books.`);
    else if (skus.some((s) => s.id.toLowerCase() === id.toLowerCase())) bad("sku", `${id} appears twice in this file.`);
    const name = r.get("name").replace(/\s+/g, " ");
    if (!name) bad("name", "The name is missing.");
    const hsn = r.get("hsn").replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(hsn)) bad("hsn", "The HSN or SAC code has 4 to 8 digits.");
    const rate = Number(r.get("gst_rate").replace(/%$/, ""));
    if (!r.get("gst_rate") || !GST_RATES.has(rate)) bad("gst_rate", `Use one of ${[...GST_RATES].join(", ")}.`);
    const price = parseAmount(r.get("price"));
    if (price === null || price < 0) bad("price", "Write the selling price in rupees, like 1,250.");
    const cost = r.get("cost") ? parseAmount(r.get("cost")) : 0;
    if (cost === null || cost < 0) bad("cost", "Write the cost in rupees, like 900, or leave it blank.");
    const count = (column: string) => {
      const v = r.get(column);
      if (!v) return null;
      if (!/^\d{1,7}$/.test(v)) {
        bad(column, "Write a whole number, like 12.");
        return null;
      }
      return Number(v);
    };
    const onHand = count("on_hand");
    const reorder = count("reorder_point");
    const lead = count("lead_time_days");
    if (issues.length > before) continue;
    skus.push({ id, name, hsn, unit: r.get("unit").toUpperCase() || "NOS", gstRate: rate, pricePaise: price!, costPaise: cost!, category: r.get("category") || "General" });
    if (onHand !== null) stock.push({ skuId: id, onHand, reorderPoint: reorder ?? 0, leadTimeDays: lead ?? 7, location: r.get("location") || "Main", lastReceivedOn: booksFrom });
  }

  /* What is still owed, from before the books start */
  const open: OpenItem[] = [];
  const openFile = req.files.find((f) => f.kind === "open-items");
  const everyone = [...books.parties, ...parties];
  for (const r of rowsOf("open-items")) {
    const before = issues.length;
    const bad = (column: string, message: string) => issue("open-items", r.row, column, message);
    const type = r.get("type").toLowerCase();
    if (type !== "invoice" && type !== "bill") bad("type", 'Write "invoice" for what a customer owes you, or "bill" for what you owe a supplier.');
    const kind = type === "bill" ? "vendor" : "customer";
    const number = r.get("number");
    if (!number || number.length > 40) bad("number", "The invoice or bill number is missing.");
    const date = realDate(parseDate(r.get("date")));
    if (!date) bad("date", "Write the date like 15/09/2026.");
    else if (realDate(booksFrom) && date >= booksFrom) bad("date", `It is dated on or after ${dateLabel(booksFrom)}, when the books start. Send it as a document instead.`);
    const due = r.get("due_date") ? realDate(parseDate(r.get("due_date"))) : null;
    if (r.get("due_date") && !due) bad("due_date", "Write the date like 15/10/2026, or leave it blank.");
    else if (due && date && due < date) bad("due_date", "The due date is before the invoice date.");
    const who = r.get("party");
    const matches = everyone.filter((p) => p.kind === kind && (p.name.toLowerCase() === who.toLowerCase() || (p.gstin && p.gstin === who.toUpperCase())));
    const word = kind === "customer" ? "customer" : "supplier";
    if (!who) bad("party", `Give the ${word}'s name or GSTIN.`);
    else if (!matches.length) bad("party", `No ${word} called ${who} in the books or in the customers and suppliers file.`);
    else if (matches.length > 1) bad("party", `More than one ${word} is called ${who}. Use their GSTIN.`);
    const total = parseAmount(r.get("total"));
    const outstanding = parseAmount(r.get("outstanding"));
    if (total === null || total <= 0) bad("total", "Write the invoice total in rupees, like 59,000.");
    if (outstanding === null || outstanding <= 0) bad("outstanding", "Write what is still owed in rupees. Leave out anything already paid in full.");
    else if (total !== null && outstanding > total) bad("outstanding", "What is still owed is more than the total.");
    const party = matches.length === 1 ? matches[0]! : null;
    if (number && party) {
      const same = (n: string, pid: string) => n.toLowerCase() === number.toLowerCase() && (type === "invoice" || pid === party.id);
      if (type === "invoice" ? books.invoices.some((i) => same(i.number, i.partyId)) : books.bills.some((b) => same(b.number, b.partyId))) bad("number", `${type === "invoice" ? "Invoice" : "Bill"} ${number} is already in the books.`);
      else if (open.some((o) => o.type === type && same(o.number, o.partyId))) bad("number", `${type === "invoice" ? "Invoice" : "Bill"} ${number} appears twice in this file.`);
    }
    if (issues.length > before) continue;
    open.push({
      type: type as OpenItem["type"],
      number,
      date: date!,
      dueDate: due ?? addDays(date!, party!.paymentTermsDays ?? 30),
      partyId: party!.id,
      totalPaise: total!,
      outstandingPaise: outstanding!,
      from: `${openFile!.name}, row ${r.row}`,
      file: openFile!.file && /^(\/api\/|blob:)/.test(openFile!.file) ? openFile!.file : "",
    });
  }

  const invoices = open.filter((o) => o.type === "invoice");
  const bills = open.filter((o) => o.type === "bill");
  const counts = {
    customers: parties.filter((p) => p.kind === "customer").length,
    suppliers: parties.filter((p) => p.kind === "vendor").length,
    products: skus.length,
    stock: stock.length,
    invoices: invoices.length,
    bills: bills.length,
    receivablePaise: invoices.reduce((a, o) => a + o.outstandingPaise, 0),
    payablePaise: bills.reduce((a, o) => a + o.outstandingPaise, 0),
  };
  const something = parties.length + skus.length + open.length > 0;
  if (!issues.length && !something) issue(null, 0, "", "There is nothing to bring in. Fill in at least one row of a template.");
  const name = (id: string) => everyone.find((p) => p.id === id)?.name ?? id;
  const payload: OnboardingPayload = {
    booksFrom,
    files,
    parties,
    skus,
    stock,
    open,
    counts,
    sample: [
      ...parties.slice(0, 3).map((p) => `${p.name}, ${p.kind === "customer" ? "customer" : "supplier"}${p.city ? `, ${p.city}` : ""}`),
      ...skus.slice(0, 3).map((s) => `${s.name}, ₹${inr(s.pricePaise)}`),
      ...open.slice(0, 3).map((o) => `${o.type === "invoice" ? "Invoice" : "Bill"} ${o.number}, ${name(o.partyId)}: ₹${inr(o.outstandingPaise)} still owed`),
    ],
  };
  if (!issues.length && JSON.stringify(payload).length > IMPORT_MAX_PAYLOAD) issue(null, 0, "", "Together these files are too big for one approval. Split them into smaller files and bring them in one after another.");
  const ready = issues.length === 0;
  return { preview: { booksFrom, booksFromFixed: Boolean(fixed), files, counts, issues, ready }, payload: ready ? payload : null };
}

/** Why an approved import can no longer go in as checked, or null if it can. */
export function importConflict(books: Books, raw: unknown): string | null {
  const parsed = OnboardingPayload.safeParse(raw);
  if (!parsed.success) return "This import could not be read. Check the files again.";
  const p = parsed.data;
  const changed = "The books have changed since these files were checked. Check them again.";
  if (books.business.booksFrom && books.business.booksFrom !== p.booksFrom) return changed;
  const partyIds = new Set(books.parties.map((x) => x.id));
  if (p.parties.some((x) => partyIds.has(x.id)) || p.skus.some((s) => books.skus.some((x) => x.id === s.id))) return changed;
  const known = new Set([...partyIds, ...p.parties.map((x) => x.id)]);
  for (const o of p.open) {
    if (!known.has(o.partyId)) return changed;
    const clash = o.type === "invoice" ? books.invoices.some((i) => i.number.toLowerCase() === o.number.toLowerCase()) : books.bills.some((b) => b.partyId === o.partyId && b.number.toLowerCase() === o.number.toLowerCase());
    if (clash) return changed;
  }
  return null;
}

/** Adds everything in an approved import, or nothing. */
export function applyImport(books: Books, raw: unknown, at: string): OnboardingPayload {
  const conflict = importConflict(books, raw);
  if (conflict) throw new ImportError(conflict);
  const p = OnboardingPayload.parse(raw);
  books.parties.push(...p.parties);
  books.skus.push(...p.skus);
  books.stock.push(...p.stock);
  const docIds = new Set(books.documents.map((d) => d.id));
  const invIds = new Set(books.invoices.map((i) => i.id));
  const billIds = new Set(books.bills.map((b) => b.id));
  const parties = new Map(books.parties.map((x) => [x.id, x]));
  for (const o of p.open) {
    const party = parties.get(o.partyId)!;
    const docId = uid("doc-ob", docIds);
    const id = o.type === "invoice" ? uid("inv-ob", invIds) : uid("bill-ob", billIds);
    const line = {
      skuId: null,
      description: `Brought forward: Rs ${inr(o.outstandingPaise)} outstanding of Rs ${inr(o.totalPaise)}, ${o.type} dated ${dateLabel(o.date)}`,
      hsn: "",
      qty: 1,
      unit: "NOS",
      ratePaise: o.outstandingPaise,
      discountPct: 0,
      taxablePaise: o.outstandingPaise,
      gstRate: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
    };
    const totals = { taxablePaise: o.outstandingPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, totalPaise: o.outstandingPaise };
    const doc: Document = { id: docId, kind: o.type === "invoice" ? "sales_invoice" : "purchase_bill", refId: id, file: o.file, pages: 1, receivedAt: at, channel: "import", from: o.from, status: "posted", regions: [] };
    books.documents.push(doc);
    if (o.type === "invoice") {
      const inv: Invoice = { id, number: o.number, date: o.date, partyId: party.id, docId, placeOfSupply: party.stateCode, reverseCharge: false, termsDays: daysBetween(o.date, o.dueDate), dueDate: o.dueDate, lines: [line], totals, status: "posted", opening: true };
      books.invoices.push(inv);
    } else {
      const bill: Bill = { id, number: o.number, date: o.date, partyId: party.id, docId, kind: party.supplyKind ?? "goods", placeOfSupply: party.stateCode, lines: [line], totals, itcEligible: false, tds: null, status: "posted", opening: true };
      books.bills.push(bill);
    }
  }
  books.business.booksFrom ??= p.booksFrom;
  return p;
}

/** "40 customers, 12 suppliers, 120 products and 85 unpaid invoices", for titles and the log. */
export function importSummary(c: Record<string, number>): string {
  const n = (k: string, one: string, many: string) => (c[k] ? `${c[k]} ${c[k] === 1 ? one : many}` : null);
  const parts = [
    n("customers", "customer", "customers"),
    n("suppliers", "supplier", "suppliers"),
    n("products", "product", "products"),
    c.invoices ? `${c.invoices} unpaid invoice${c.invoices === 1 ? "" : "s"} worth ${inrShort(c.receivablePaise ?? 0)}` : null,
    c.bills ? `${c.bills} unpaid bill${c.bills === 1 ? "" : "s"} worth ${inrShort(c.payablePaise ?? 0)}` : null,
  ].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
}
