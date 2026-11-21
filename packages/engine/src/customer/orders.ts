import { type Books, type Order, OrderStatus, type OrdersImportResult, type SheetMapping } from "@office/contracts";
import { dateOf } from "../sales/parse";
import { samePhone } from "./brain";

/**
 * Where the agent looks an order up. The books' own list is built in; a shop's own system
 * (Shopify, WooCommerce, a billing app) becomes another source later without changing the agent.
 */
export interface OrderSource {
  readonly name: string;
  find(number: string): Order | null;
  /** Orders placed with this phone or email, or by this customer in the books, newest first. */
  forContact(who: { phone?: string | null; email?: string | null; partyId?: string | null }): Order[];
}

const norm = (n: string) => n.replace(/^#/, "").trim().toUpperCase();

export class BooksOrderSource implements OrderSource {
  readonly name = "Orders in the office";
  constructor(private books: Books) {}
  find(number: string) {
    const n = norm(number);
    return this.books.orders.find((o) => norm(o.number) === n) ?? null;
  }
  forContact(who: { phone?: string | null; email?: string | null; partyId?: string | null }) {
    const email = who.email?.toLowerCase();
    return this.books.orders
      .filter(
        (o) =>
          (who.partyId && o.partyId === who.partyId) || (who.phone && o.phone && samePhone(o.phone, who.phone)) || (email && o.email.toLowerCase() === email),
      )
      .sort((a, b) => (a.placedOn < b.placedOn ? 1 : -1));
  }
}

/** Whether someone writing from this contact may hear about this order. */
export function orderBelongsTo(o: Order, who: { phone?: string | null; email?: string | null; partyId?: string | null }): boolean {
  if (who.partyId && o.partyId === who.partyId) return true;
  if (who.phone && o.phone && samePhone(o.phone, who.phone)) return true;
  return Boolean(who.email && o.email && o.email.toLowerCase() === who.email.toLowerCase());
}

export const STATUS_WORDS: Record<OrderStatus, string> = {
  received: "received",
  packed: "packed and ready to go",
  dispatched: "on its way",
  delivered: "delivered",
  cancelled: "cancelled",
};

const STATUS_ALIASES: Record<string, OrderStatus> = {
  new: "received",
  received: "received",
  placed: "received",
  confirmed: "received",
  processing: "received",
  pending: "received",
  packed: "packed",
  ready: "packed",
  shipped: "dispatched",
  dispatched: "dispatched",
  "in transit": "dispatched",
  "out for delivery": "dispatched",
  sent: "dispatched",
  delivered: "delivered",
  completed: "delivered",
  done: "delivered",
  fulfilled: "delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
  refunded: "cancelled",
  // Shopify's fulfilment words.
  unfulfilled: "received",
  partial: "dispatched",
  "partially fulfilled": "dispatched",
};
export const statusFrom = (s: string): OrderStatus | null =>
  STATUS_ALIASES[s.trim().toLowerCase()] ?? (OrderStatus.safeParse(s.trim().toLowerCase()).success ? (s.trim().toLowerCase() as OrderStatus) : null);

/**
 * Adds or updates orders from a sheet's rows, with the columns found by their names or confirmed by the owner. A row
 * with the number of an order already here updates it; a value that cannot be read leaves the row out, with why.
 */
export function readOrders(
  books: Books,
  input: { rows: string[][]; headerAt: number; mapping: SheetMapping },
  today: string,
  link: (o: Order) => string | null,
): OrdersImportResult {
  const headers = input.rows[input.headerAt] ?? [];
  const col = (f: string) => (input.mapping[f] ? headers.indexOf(input.mapping[f]!) : -1);
  if (col("number") < 0) throw new Error('No order number column. Name one of the columns "Order number".');
  const out: OrdersImportResult = { added: 0, updated: 0, skipped: [] };
  const now = new Date().toISOString();
  for (let i = input.headerAt + 1; i < input.rows.length; i++) {
    const r = input.rows[i]!;
    if (!r.some((c) => c.trim())) continue;
    const row = i + 1;
    const get = (f: string) => (col(f) >= 0 ? (r[col(f)] ?? "").trim() : "");
    const number = norm(get("number"));
    if (!number || number.length > 40) {
      out.skipped.push(`Row ${row}: no order number`);
      continue;
    }
    const existing = books.orders.find((o) => norm(o.number) === number);
    const status = get("status") ? statusFrom(get("status")) : (existing?.status ?? "received");
    if (!status) {
      out.skipped.push(`Row ${row}: "${get("status").slice(0, 30)}" is not a status we know`);
      continue;
    }
    const placed = get("placed") ? dateOf(get("placed")) : null;
    const expected = get("expected") ? dateOf(get("expected")) : null;
    const unreadable = (get("placed") && !placed && get("placed")) || (get("expected") && !expected && get("expected"));
    if (unreadable) {
      out.skipped.push(`Row ${row}: "${unreadable.slice(0, 30)}" is not a date I can read`);
      continue;
    }
    const o: Order = {
      id: existing?.id ?? `ord-${number.toLowerCase().replace(/[^a-z0-9]/g, "")}-${books.orders.length + 1}`,
      number,
      partyId: existing?.partyId ?? null,
      customer: (get("customer") || existing?.customer || "").slice(0, 120),
      phone: (get("phone") || existing?.phone || "").slice(0, 30),
      email: (get("email") || existing?.email || "").toLowerCase().slice(0, 200),
      items: (get("items") || existing?.items || "").slice(0, 500),
      status,
      placedOn: placed ?? existing?.placedOn ?? today,
      expectedOn: expected ?? existing?.expectedOn ?? null,
      tracking: (get("tracking") || existing?.tracking || null)?.slice(0, 500) ?? null,
      note: (get("note") || existing?.note || "").slice(0, 500),
      updatedAt: now,
    };
    o.partyId = o.partyId ?? link(o);
    if (existing) {
      Object.assign(existing, o);
      out.updated++;
    } else {
      books.orders.push(o);
      out.added++;
    }
  }
  return out;
}

/** "order 1042 dispatched https://track…" from an owner on WhatsApp. */
export function parseOrderCommand(text: string): { number: string; status: OrderStatus; tracking: string | null } | null {
  const m = /^\s*order\s+#?([A-Za-z0-9-]{2,40})\s+(new|received|placed|packed|ready|shipped|dispatched|sent|delivered|done|cancelled|canceled)\b\s*(.*)$/i.exec(
    text,
  );
  if (!m) return null;
  const status = statusFrom(m[2]!);
  return status ? { number: norm(m[1]!), status, tracking: m[3]!.trim().slice(0, 500) || null } : null;
}
