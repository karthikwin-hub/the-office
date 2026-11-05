import { DatabaseSync } from "node:sqlite";
import { loadBooks } from "@office/fixtures";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth";
import { parseInbound, plainMessage } from "../src/mail";
import { BooksStore } from "../src/store";
import { digestCron, istDate } from "../src/time";

/** Enough of a Durable Object's SqlStorage over Node's SQLite. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

describe("books store", () => {
  it("round-trips the books and writes only what changed", () => {
    const sql = sqlStorage();
    const books = loadBooks();
    const store = new BooksStore(sql);
    expect(store.load()).toBeNull();
    expect(store.save(books)).toBeGreaterThan(900);
    expect(store.save(books)).toBe(0);

    const again = new BooksStore(sql).load()!;
    expect(again).toEqual(books);

    books.bills[0]!.status = "rejected";
    books.teamLog.push({ id: "log-x", at: "2026-11-04T09:00:00+05:30", agentId: "accountant", text: "x", ref: null });
    expect(store.save(books)).toBe(2);
    books.staged.splice(0, 1);
    expect(store.save(books)).toBe(1);
    expect(new BooksStore(sql).load()).toEqual(books);
  });
});

describe("passwords", () => {
  it("verifies the right password and refuses others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword({ hash, password: "correct horse battery" })).toBe(true);
    expect(await verifyPassword({ hash, password: "correct horse batterz" })).toBe(false);
    expect(await verifyPassword({ hash: "scrypt$abc", password: "x" })).toBe(false);
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });
});

describe("time", () => {
  it("turns a time in India into a UTC cron", () => {
    expect(digestCron("08:45")).toBe("15 3 * * *");
    expect(digestCron("00:00")).toBe("30 18 * * *");
    expect(digestCron("05:30")).toBe("0 0 * * *");
  });
  it("dates the books in India", () => {
    expect(istDate(Date.parse("2026-11-04T19:00:00Z"))).toBe("2026-11-05");
    expect(istDate(Date.parse("2026-11-04T18:00:00Z"))).toBe("2026-11-04");
  });
});

describe("mail", () => {
  it("builds a message that parses back to the same text", async () => {
    const raw = plainMessage({ fromName: "Kaveri Electricals", from: "office@example.in", to: "accounts@sharma.in", replyTo: "a@kaveri.in", subject: "Payment reminder: ₹85,930", body: "Dear Rakesh,\n\nThe invoice of ₹85,930 is due." });
    const back = await PostalMime.parse(raw);
    expect(back.subject).toBe("Payment reminder: ₹85,930");
    expect(back.text?.trim()).toBe("Dear Rakesh,\n\nThe invoice of ₹85,930 is due.");
    expect(back.from?.name).toBe("Kaveri Electricals");
    expect(back.replyTo?.[0]?.address).toBe("a@kaveri.in");
  });

  it("keeps PDFs and photos and lists the rest as skipped", async () => {
    const boundary = "b1";
    const part = (type: string, name: string, data: string) => [`--${boundary}`, `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", btoa(data), ""].join("\r\n");
    const raw = [
      "From: Konkan Logistics <billing@konkan.in>",
      "To: bills@office.in",
      "Subject: Bill",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Attached.",
      part("application/pdf", "bill.pdf", "%PDF-1.4 test"),
      part("image/jpeg", "photo.jpg", "jpeg"),
      part("application/zip", "all.zip", "zip"),
      `--${boundary}--`,
    ].join("\r\n");
    const mail = await parseInbound(new TextEncoder().encode(raw).buffer as ArrayBuffer);
    expect(mail.from).toBe("billing@konkan.in");
    expect(mail.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ["bill.pdf", "application/pdf"],
      ["photo.jpg", "image/jpeg"],
    ]);
    expect(mail.skipped).toEqual(["all.zip"]);
  });
});
