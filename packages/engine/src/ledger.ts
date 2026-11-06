import type { Bill, Books, Document, Invoice, Party, Payment, Sku } from "@office/contracts";

/** Indexed, read-mostly view over a Books dataset. */
export class Ledger {
  readonly books: Books;
  readonly asOf: string;
  private parties = new Map<string, Party>();
  private skus = new Map<string, Sku>();
  private docs = new Map<string, Document>();
  private invoices = new Map<string, Invoice>();
  private bills = new Map<string, Bill>();
  private settledByInvoice = new Map<string, { cash: number; tds: number; lastOn: string | null }>();
  private paymentsByInvoice = new Map<string, { date: string; amountPaise: number; tdsPaise: number; paymentId: string }[]>();

  constructor(books: Books, asOf?: string) {
    this.books = books;
    this.asOf = asOf ?? books.business.asOf;
    this.reindex();
  }

  reindex(): void {
    this.parties = new Map(this.books.parties.map((p) => [p.id, p]));
    this.skus = new Map(this.books.skus.map((s) => [s.id, s]));
    this.docs = new Map(this.books.documents.map((d) => [d.id, d]));
    this.invoices = new Map(this.books.invoices.map((i) => [i.id, i]));
    this.bills = new Map(this.books.bills.map((b) => [b.id, b]));
    this.settledByInvoice.clear();
    this.paymentsByInvoice.clear();
    for (const pay of this.books.payments) {
      if (pay.direction !== "in" || pay.date > this.asOf) continue;
      for (const a of pay.allocations) {
        if (!a.invoiceId) continue;
        const s = this.settledByInvoice.get(a.invoiceId) ?? { cash: 0, tds: 0, lastOn: null };
        s.cash += a.amountPaise;
        s.tds += a.tdsPaise;
        s.lastOn = !s.lastOn || pay.date > s.lastOn ? pay.date : s.lastOn;
        this.settledByInvoice.set(a.invoiceId, s);
        const list = this.paymentsByInvoice.get(a.invoiceId) ?? [];
        list.push({ date: pay.date, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise, paymentId: pay.id });
        this.paymentsByInvoice.set(a.invoiceId, list);
      }
    }
  }

  party(id: string): Party {
    const p = this.parties.get(id);
    if (!p) throw new Error(`Unknown party ${id}`);
    return p;
  }
  findParty(id: string): Party | undefined {
    return this.parties.get(id);
  }
  sku(id: string): Sku {
    const s = this.skus.get(id);
    if (!s) throw new Error(`Unknown SKU ${id}`);
    return s;
  }
  doc(id: string): Document | undefined {
    return this.docs.get(id);
  }
  invoice(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }
  bill(id: string): Bill | undefined {
    return this.bills.get(id);
  }

  get customers(): Party[] {
    return this.books.parties.filter((p) => p.kind === "customer");
  }

  /** Posted sales invoices dated on or before the as-of date, without those brought forward: what returns and sales count. */
  get salesInvoices(): Invoice[] {
    return this.receivableInvoices.filter((i) => !i.opening);
  }

  get postedBills(): Bill[] {
    return this.payableBills.filter((b) => !b.opening);
  }

  /** Every posted invoice a customer can still owe on, including those brought forward: what ageing and statements count. */
  get receivableInvoices(): Invoice[] {
    return this.books.invoices.filter((i) => i.status === "posted" && i.date <= this.asOf);
  }

  get payableBills(): Bill[] {
    return this.books.bills.filter((b) => b.status === "posted" && b.date <= this.asOf);
  }

  /** Where returns and the year's reports start: the financial year, or later if the books were brought in partway through. */
  get periodStart(): string {
    const from = this.books.business.booksFrom;
    const start = from && from > this.books.business.fyStart ? from : this.books.business.fyStart;
    return start > this.asOf ? this.asOf : start;
  }

  invoicesIn(from: string, to: string): Invoice[] {
    return this.salesInvoices.filter((i) => i.date >= from && i.date <= to);
  }

  settled(invoiceId: string): { cash: number; tds: number; lastOn: string | null } {
    return this.settledByInvoice.get(invoiceId) ?? { cash: 0, tds: 0, lastOn: null };
  }

  receiptsFor(invoiceId: string) {
    return this.paymentsByInvoice.get(invoiceId) ?? [];
  }

  outstanding(invoiceId: string): number {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return 0;
    const s = this.settled(invoiceId);
    return inv.totals.totalPaise - s.cash - s.tds;
  }

  paymentsIn(from: string, to: string, direction: Payment["direction"]): Payment[] {
    return this.books.payments.filter((p) => p.direction === direction && p.date >= from && p.date <= to && p.date <= this.asOf);
  }

  vendorBillPaid(billId: string): boolean {
    return this.books.payments.some((p) => p.direction === "out" && p.date <= this.asOf && p.allocations.some((a) => a.billId === billId));
  }

  /** Region on a document, for drill-down highlights */
  region(docId: string, key: string): string | null {
    return this.doc(docId)?.regions.some((r) => r.key === key) ? key : null;
  }

  stateName(code: string): string {
    return this.books.states[code] ?? code;
  }
}
